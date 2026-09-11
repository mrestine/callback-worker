/**
 * One-time Gmail OAuth bootstrap. Run on a machine with a browser (RDP into the
 * box is fine — the URL is printed for you to paste):
 *
 *   GMAIL_CREDENTIALS_PATH=./secrets/gmail-credentials.json \
 *   GMAIL_TOKEN_PATH=./secrets/gmail-token.json \
 *   npm run gmail:auth
 *
 * Writes an `authorized_user` token file the worker reads. Uses
 * access_type=offline + prompt=consent so a refresh token is always issued.
 * See PHASE-2-PLAN.md §1a — publish the consent screen to "In production" so
 * that refresh token never expires.
 */
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { OAuth2Client } from 'google-auth-library'

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
]
const PORT = 4179 // loopback; Desktop-type OAuth clients accept any localhost port

const credPath = process.env.GMAIL_CREDENTIALS_PATH
const tokenPath = process.env.GMAIL_TOKEN_PATH
if (!credPath || !tokenPath) {
  console.error('Set GMAIL_CREDENTIALS_PATH and GMAIL_TOKEN_PATH (see .env.example).')
  process.exit(1)
}

const raw = JSON.parse(await readFile(credPath, 'utf8')) as Record<
  string,
  { client_id: string; client_secret: string }
>
const secrets = raw.installed ?? raw.web
if (!secrets?.client_id || !secrets?.client_secret) {
  console.error(`${credPath} is not an OAuth client secrets file (no "installed"/"web" section).`)
  process.exit(1)
}

const redirectUri = `http://localhost:${PORT}`
const client = new OAuth2Client({
  clientId: secrets.client_id,
  clientSecret: secrets.client_secret,
  redirectUri,
})

const authUrl = client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: SCOPES,
})

const code: string = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '', redirectUri)
      const c = url.searchParams.get('code')
      const err = url.searchParams.get('error')
      res.setHeader('content-type', 'text/plain')
      if (err) {
        res.end(`Authorization failed: ${err}. You can close this tab.`)
        server.close()
        reject(new Error(err))
        return
      }
      if (!c) {
        res.statusCode = 400
        res.end('No code in callback.')
        return
      }
      res.end('Authorized. You can close this tab and return to the terminal.')
      server.close()
      resolve(c)
    } catch (e) {
      reject(e as Error)
    }
  })
  server.listen(PORT, () => {
    console.log('\nOpen this URL in a browser and approve access:\n')
    console.log(`  ${authUrl}\n`)
    console.log(`Waiting for the redirect to ${redirectUri} …`)
  })
})

const { tokens } = await client.getToken(code)
if (!tokens.refresh_token) {
  console.error(
    '\nNo refresh_token returned. Google only sends one on a fresh grant — revoke this app at\n' +
      '  https://myaccount.google.com/permissions\n' +
      'then run `npm run gmail:auth` again.',
  )
  process.exit(1)
}

await mkdir(dirname(tokenPath), { recursive: true })
await writeFile(
  tokenPath,
  JSON.stringify(
    {
      type: 'authorized_user',
      client_id: secrets.client_id,
      client_secret: secrets.client_secret,
      refresh_token: tokens.refresh_token,
    },
    null,
    2,
  ) + '\n',
)
console.log(`\nWrote ${tokenPath}. The worker can now authenticate.`)
