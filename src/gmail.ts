/**
 * Gmail: OAuth (desktop client + cached refresh token), poll by label, fetch
 * raw messages, move labels, send the digest reply. Hand-rolled REST over
 * `fetch` — `google-auth-library` only does the token refresh.
 *
 * The label set is the worker's entire state machine:
 *   <prefix>inbox -> <prefix>processing -> <prefix>processed | <prefix>error
 */
import { readFile } from 'node:fs/promises'
import { simpleParser } from 'mailparser'
import { OAuth2Client } from 'google-auth-library'

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'

/** Thrown when the refresh token is dead — main turns this into a FATAL. */
export class GmailAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GmailAuthError'
  }
}

// --- auth --------------------------------------------------------------
interface ClientSecrets {
  client_id: string
  client_secret: string
  redirect_uris?: string[]
}

function readSecrets(raw: string): ClientSecrets {
  const j = JSON.parse(raw) as Record<string, ClientSecrets>
  const inner = j.installed ?? j.web
  if (!inner?.client_id || !inner?.client_secret) {
    throw new Error('client secrets JSON has no "installed"/"web" section with client_id + client_secret')
  }
  return inner
}

export interface GmailAuthPaths {
  credentialsPath: string
  tokenPath: string
}

/** Build an OAuth2 client that auto-refreshes from the cached refresh token. */
export async function loadAuth(paths: GmailAuthPaths): Promise<OAuth2Client> {
  const secrets = readSecrets(await readFile(paths.credentialsPath, 'utf8'))
  let token: { refresh_token?: string }
  try {
    token = JSON.parse(await readFile(paths.tokenPath, 'utf8'))
  } catch {
    throw new GmailAuthError(
      `no Gmail token at ${paths.tokenPath} — run \`npm run gmail:auth\` once on a machine with a browser`,
    )
  }
  if (!token.refresh_token) {
    throw new GmailAuthError(`${paths.tokenPath} has no refresh_token — re-run \`npm run gmail:auth\``)
  }
  const client = new OAuth2Client({
    clientId: secrets.client_id,
    clientSecret: secrets.client_secret,
    redirectUri: secrets.redirect_uris?.[0],
  })
  client.setCredentials({ refresh_token: token.refresh_token })
  return client
}

async function accessToken(auth: OAuth2Client): Promise<string> {
  try {
    const { token } = await auth.getAccessToken()
    if (!token) throw new GmailAuthError('Gmail returned no access token')
    return token
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/invalid_grant|invalid_rapt|unauthorized_client|no refresh token/i.test(msg)) {
      throw new GmailAuthError(`Gmail refresh failed (${msg}) — re-run \`npm run gmail:auth\``)
    }
    throw err
  }
}

async function api<T>(
  auth: OAuth2Client,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await accessToken(auth)
  const res = await fetch(`${GMAIL}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  if (res.status === 401) {
    throw new GmailAuthError(`Gmail 401 on ${path} — token rejected`)
  }
  if (!res.ok) {
    throw new Error(`Gmail ${res.status} ${res.statusText} on ${path}: ${await res.text().catch(() => '')}`)
  }
  return (res.status === 204 ? undefined : await res.json()) as T
}

// --- labels ----------------------------------------------------------
export interface Labels {
  inbox: string
  processing: string
  processed: string
  error: string
}

/** Resolve (creating if needed) the four state labels; returns their ids. */
export async function ensureLabels(auth: OAuth2Client, prefix: string): Promise<Labels> {
  const { labels = [] } = await api<{ labels?: { id: string; name: string }[] }>(auth, '/labels')
  const byName = new Map(labels.map((l) => [l.name, l.id]))

  async function idFor(name: string): Promise<string> {
    const hit = byName.get(name)
    if (hit) return hit
    const created = await api<{ id: string }>(auth, '/labels', {
      method: 'POST',
      body: JSON.stringify({
        name,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      }),
    })
    return created.id
  }

  return {
    inbox: await idFor(`${prefix}inbox`),
    processing: await idFor(`${prefix}processing`),
    processed: await idFor(`${prefix}processed`),
    error: await idFor(`${prefix}error`),
  }
}

// --- messages ------------------------------------------------------
export async function listMessageIds(auth: OAuth2Client, query: string): Promise<string[]> {
  const q = encodeURIComponent(query)
  const out: string[] = []
  let pageToken = ''
  do {
    const page = await api<{ messages?: { id: string }[]; nextPageToken?: string }>(
      auth,
      `/messages?q=${q}&maxResults=100${pageToken ? `&pageToken=${pageToken}` : ''}`,
    )
    for (const m of page.messages ?? []) out.push(m.id)
    pageToken = page.nextPageToken ?? ''
  } while (pageToken && out.length < 500)
  return out
}

export interface FetchedMessage {
  id: string
  threadId: string
  raw: Buffer
  /** envelope headers of the *forward* — used to thread the digest reply */
  envelope: { messageId: string | null; fromAddress: string | null; subject: string | null }
}

export async function getMessage(auth: OAuth2Client, id: string): Promise<FetchedMessage> {
  const m = await api<{ id: string; threadId: string; raw: string }>(
    auth,
    `/messages/${id}?format=raw`,
  )
  const raw = Buffer.from(m.raw, 'base64url')
  const parsed = await simpleParser(raw)
  const from = Array.isArray(parsed.from) ? parsed.from[0] : parsed.from
  return {
    id: m.id,
    threadId: m.threadId,
    raw,
    envelope: {
      messageId: parsed.messageId ?? null,
      fromAddress: from?.value?.[0]?.address ?? null,
      subject: parsed.subject ?? null,
    },
  }
}

/** Move a message between state labels in one call. */
export async function relabel(
  auth: OAuth2Client,
  id: string,
  change: { add?: string[]; remove?: string[] },
): Promise<void> {
  await api(auth, `/messages/${id}/modify`, {
    method: 'POST',
    body: JSON.stringify({ addLabelIds: change.add ?? [], removeLabelIds: change.remove ?? [] }),
  })
}

// --- send ----------------------------------------------------------
export interface ReplyInput {
  threadId: string
  to: string
  subject: string
  inReplyTo: string | null
  body: string
}

function buildMime(r: ReplyInput): string {
  const subject = /^re:/i.test(r.subject) ? r.subject : `Re: ${r.subject}`
  const headers = [
    `To: ${r.to}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ]
  if (r.inReplyTo) {
    headers.push(`In-Reply-To: ${r.inReplyTo}`, `References: ${r.inReplyTo}`)
  }
  return `${headers.join('\r\n')}\r\n\r\n${r.body}`
}

/** RFC 2047 encode a header value if it has non-ASCII (emoji subjects, etc.). */
function encodeHeader(v: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`
}

export async function sendReply(auth: OAuth2Client, r: ReplyInput): Promise<void> {
  const raw = Buffer.from(buildMime(r), 'utf8').toString('base64url')
  await api(auth, '/messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw, threadId: r.threadId }),
  })
}
