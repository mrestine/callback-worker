/**
 * The one outbound coupling to callback: POST /api/inbound (+ /resolve for
 * worker-side disambiguation). One bearer token is the whole trust relationship.
 *
 * Transport failures are retried with backoff; a 4xx is not (it won't get
 * better). On give-up we throw `SubmitTransportError` so the loop leaves the
 * message in `callback/processing` for the next poll — callback dedups on
 * (source, external_ref), so a re-send is a no-op.
 */
import type { Extraction } from './schemas.js'

export class SubmitTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SubmitTransportError'
  }
}

export interface ApiConfig {
  baseUrl: string
  token: string
}

export function apiConfigFromEnv(): ApiConfig {
  const baseUrl = (process.env.CALLBACK_API_URL ?? '').replace(/\/$/, '')
  const token = process.env.CALLBACK_TOKEN ?? ''
  if (!baseUrl) throw new Error('CALLBACK_API_URL is not set')
  if (!token) throw new Error('CALLBACK_TOKEN is not set')
  return { baseUrl, token }
}

export interface InboundBody {
  external_ref: string
  source: string
  occurred_at: string | null
  summary: string | null
  thread_key: string | null
  extracted: Extraction
}

export interface ProposalOp {
  id: string
  op: string
  args?: Record<string, unknown>
  refs?: Record<string, string>
  match?: { candidates: { id: number; label: string; score: number }[]; chosen: number | null }
  decision: 'accept' | 'skip'
  reason?: string
}

export interface InboundResponse {
  status: 'needs_review' | 'needs_disambiguation' | 'dismissed' | 'duplicate'
  proposal?: ProposalOp[]
  review_url: string
  deduped?: boolean
}

const RETRIES = 4
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function post<T>(cfg: ApiConfig, path: string, body: unknown): Promise<T> {
  let lastErr = ''
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1)) // 0.5s, 1s, 2s, 4s
    let res: Response
    try {
      res = await fetch(`${cfg.baseUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (err) {
      lastErr = `network: ${(err as Error).message}`
      continue
    }
    if (res.ok) return (await res.json()) as T
    const text = await res.text().catch(() => '')
    if (res.status >= 400 && res.status < 500) {
      throw new Error(`callback ${res.status} on ${path}: ${text}`) // won't retry-fix
    }
    lastErr = `${res.status} ${res.statusText}: ${text}`
  }
  throw new SubmitTransportError(`callback unreachable after ${RETRIES + 1} tries (${lastErr})`)
}

export function submitInbound(cfg: ApiConfig, body: InboundBody): Promise<InboundResponse> {
  return post<InboundResponse>(cfg, '/api/inbound', body)
}

/** Fill op `chosen`s the worker's disambiguation picked; row stays needs_review. */
export function chooseInbound(
  cfg: ApiConfig,
  id: number,
  choice: Record<string, number>,
): Promise<{ status: string; proposal: ProposalOp[] }> {
  return post(cfg, `/api/inbound/resolve?id=${id}`, { action: 'choose', choice })
}

/** callback's review_url ends with the numeric inbound_actions id. */
export function idFromReviewUrl(url: string): number | null {
  const n = Number(url.split('/').pop())
  return Number.isInteger(n) && n > 0 ? n : null
}
