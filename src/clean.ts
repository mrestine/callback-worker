import { simpleParser } from 'mailparser'
import type { AddressObject } from 'mailparser'
import { normalized } from './schemas.js'
import type { Normalized } from './schemas.js'

const MAX_BODY = 4000

const FWD_MARKERS = [
  /-{3,}\s*Forwarded message\s*-{3,}/i,
  /^Begin forwarded message:/im,
]

interface FwdHeaders {
  from?: string
  to?: string
  subject?: string
  date?: string
}

function unquote(s: string): string {
  return s.replace(/^"(.*)"$/, '$1').trim()
}

/**
 * "Name <email>" or bare "email" -> { name, email } (email lowercased).
 * If the field lists several recipients ("<a>, <b>"), returns the first.
 */
export function parseAddress(text: string | undefined | null): { name: string; email: string } {
  if (!text) return { name: '', email: '' }
  const t = text.trim()
  // no end-anchor: match the FIRST "<...>" so multi-recipient fields yield [0]
  const withName = t.match(/^\s*(.*?)\s*<([^>]+)>/)
  if (withName) {
    return {
      name: unquote(withName[1]).replace(/[,;]\s*$/, '').trim(),
      email: withName[2].trim().toLowerCase(),
    }
  }
  const bare = t.match(/[^\s<>@,;]+@[^\s<>@,;]+/)
  if (!bare) return { name: t, email: '' }
  const name = bare[0] === t ? '' : t.replace(bare[0], '').replace(/[<>]/g, '').trim()
  return { name, email: bare[0].toLowerCase() }
}

function addrText(a: AddressObject | AddressObject[] | undefined): string {
  if (!a) return ''
  const one = Array.isArray(a) ? a[0] : a
  return one?.text ?? ''
}

/** Conversation key: lowercased sender email + subject minus Re:/Fwd:, ws-collapsed. */
export function threadKey(email: string, subject: string): string {
  const s = subject
    .replace(/^(\s*(re|fwd|fw)\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  return `${email.toLowerCase()}|${s}`
}

/** First "Forwarded message" block: parse its reproduced headers, return the body after them. */
function unwrapForward(body: string): { headers: FwdHeaders; body: string } | null {
  let at = -1
  let len = 0
  for (const re of FWD_MARKERS) {
    const m = body.match(re)
    if (m && m.index !== undefined && (at === -1 || m.index < at)) {
      at = m.index
      len = m[0].length
    }
  }
  if (at === -1) return null

  // The reproduced-header block runs to the first blank line. A long
  // Subject:/To: often wraps onto an unprefixed continuation line — append
  // those to the previous header rather than treating them as body.
  const after = body.slice(at + len).replace(/^\s*\n/, '')
  const lines = after.split('\n')
  const headers: FwdHeaders = {}
  let lastKey: keyof FwdHeaders | null = null
  let i = 0
  for (; i < lines.length && i < 15; i++) {
    if (lines[i].trim() === '') {
      i++
      break
    }
    const hm = lines[i].match(/^\s*(From|To|Subject|Date|Sent)\s*:\s*(.*)$/i)
    if (hm) {
      const raw = hm[1].toLowerCase()
      const key: keyof FwdHeaders = raw === 'sent' ? 'date' : (raw as keyof FwdHeaders)
      headers[key] = hm[2].trim()
      lastKey = key
    } else if (lastKey) {
      headers[lastKey] = `${headers[lastKey] ?? ''} ${lines[i].trim()}`.trim()
    } else {
      break // junk before any recognised header
    }
  }
  return { headers, body: lines.slice(i).join('\n').trim() }
}

/** Google Calendar renders subjects as "Invitation: <title> @ <time> (TZ) (recipient@x)". */
function trimCalendarCruft(subject: string): string {
  return subject.replace(/\s*\([A-Z]{2,5}\)\s*\([^)]*@[^)]*\)\s*$/, '').trim()
}

const REPLY_BOUNDARIES = [
  /^\s*On .+ wrote:\s*$/m,
  /^-{3,}\s*Original Message\s*-{3,}/im,
  /^_{10,}$/m,
  /^\s*From:\s.+\n\s*Sent:\s/im,
]

/** Cut the message at the first quoted-reply boundary; drop a trailing >-quoted run. */
export function stripReplies(body: string): string {
  let cut = body.length
  for (const re of REPLY_BOUNDARIES) {
    const m = body.match(re)
    if (m && m.index !== undefined && m.index < cut) cut = m.index
  }
  return body
    .slice(0, cut)
    .replace(/(?:^[ \t]*>.*\n?)+$/m, '')
    .trim()
}

/** Cut at a standard "-- " signature delimiter. */
export function stripSignature(body: string): string {
  const m = body.match(/^-- $/m)
  return m && m.index !== undefined ? body.slice(0, m.index).trim() : body
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&(#39|apos);/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Raw RFC822 (.eml bytes) -> Normalized.
 *
 * Every message is assumed to be a forward; the headers reproduced inside the
 * "Forwarded message" block are the originals. If no such block is found, the
 * envelope headers are used and `unwrap_fallback` is set.
 */
export async function clean(raw: Buffer | string): Promise<Normalized> {
  const parsed = await simpleParser(raw)
  const rawBody = (parsed.text ?? '').trim() || htmlToText(parsed.html || '')
  const envelopeFrom = parseAddress(addrText(parsed.from))

  const fwd = unwrapForward(rawBody)
  const origSubject = trimCalendarCruft((fwd?.headers.subject ?? parsed.subject ?? '').trim())
  const origFrom = parseAddress(fwd?.headers.from ?? addrText(parsed.from))
  const origTo = parseAddress(fwd?.headers.to ?? addrText(parsed.to))

  // The operator forwarded their OWN sent reply, not an inbound email (e.g. they
  // replied to a recruiter mid-conversation, then forwarded that reply instead
  // of the recruiter's original). The "Forwarded message" block's From: is then
  // the operator's own address, not a third party's.
  const selfAuthored =
    fwd !== null && origFrom.email !== '' && origFrom.email.toLowerCase() === envelopeFrom.email.toLowerCase()

  let origDate: string | null = null
  const dateSrc = fwd?.headers.date
  if (dateSrc) {
    // Gmail renders forwarded dates as "Wed, Sep 9, 2026 at 1:47 PM" — drop the " at ".
    const d = new Date(dateSrc.replace(/\s+at\s+/i, ' '))
    origDate = Number.isNaN(d.getTime()) ? null : d.toISOString()
  } else if (parsed.date) {
    origDate = parsed.date.toISOString()
  }

  let body = fwd?.body ?? rawBody
  // On a self-authored forward, the real content (the recruiter's original
  // email) is exactly what a normal reply chain would cut as "quoted noise" —
  // it's quoted below the operator's own short note, not disclaimer junk. Keep
  // it; the model is told (via the prompt note) to read past the operator's own
  // reply for the actual sender/company/role.
  if (!selfAuthored) body = stripReplies(body)
  body = stripSignature(body)
  body = body.replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_BODY)

  return normalized.parse({
    source_message_id: parsed.messageId ?? '',
    thread_key: threadKey(origFrom.email, origSubject),
    orig_subject: origSubject,
    orig_from: origFrom,
    orig_to: origTo,
    orig_date: origDate,
    cleaned_body: body,
    unwrap_fallback: fwd === null,
    self_authored: selfAuthored,
  })
}
