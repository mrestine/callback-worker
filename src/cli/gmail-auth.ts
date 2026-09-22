/**
 * One-time Gmail OAuth bootstrap. Run on a machine with a browser (RDP into the
 * box is fine — the URL is printed for you to paste):
 *
 *   mkdir secrets            # drop gmail-credentials.json in here
 *   npm run gmail:auth
 *
 * No shell-specific env-var syntax needed — reads GMAIL_CREDENTIALS_PATH /
 * GMAIL_TOKEN_PATH from .env if set, else defaults to ./secrets/gmail-*.json
 * (host-relative; this always runs outside the container).
 *
 * Writes an `authorized_user` token file the worker reads. Uses
 * access_type=offline + prompt=consent so a refresh token is always issued.
 * Publish the consent screen to "In production" so hat refresh token never expires.
 */
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { config } from 'dotenv'
import { OAuth2Client } from 'google-auth-library'

config({ path: ['.env', '.env.local'], quiet: true })

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
]
const PORT = 4179 // loopback; Desktop-type OAuth clients accept any localhost port

const credPath = process.env.GMAIL_CREDENTIALS_PATH || './secrets/gmail-credentials.json'
const tokenPath = process.env.GMAIL_TOKEN_PATH || './secrets/gmail-token.json'

let credRaw: string
try {
  credRaw = await readFile(credPath, 'utf8')
} catch {
  console.error(`No client secrets file at ${credPath}.`)
  console.error('Download it from Google Cloud Console (a Desktop-app OAuth client) and put it there,')
  console.error('or set GMAIL_CREDENTIALS_PATH in .env to point at it.')
  process.exit(1)
}
const raw = JSON.parse(credRaw) as Record<string, { client_id: string; client_secret: string }>
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
