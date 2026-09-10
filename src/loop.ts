/**
 * One poll cycle: for every outstanding Gmail message —
 *   claim (label processing) -> clean -> extract -> submit -> (disambiguate)
 *   -> digest reply -> label processed
 *
 * Failure handling:
 *  - model can't produce valid JSON  -> label `error` (operator strips it to retry)
 *  - callback unreachable            -> leave in `processing`, next poll retries
 *  - Gmail auth dead                 -> bubble GmailAuthError to main (FATAL)
 */
import type { OAuth2Client } from 'google-auth-library'
import { clean } from './clean.js'
import { runExtraction } from './extractor.js'
import type { ModelConfig } from './model.js'
import type { Normalized, Extraction } from './schemas.js'
import {
  GmailAuthError,
  getMessage,
  listMessageIds,
  relabel,
  sendReply,
  type Labels,
} from './gmail.js'
import {
  SubmitTransportError,
  chooseInbound,
  idFromReviewUrl,
  submitInbound,
  type ApiConfig,
  type InboundBody,
  type InboundResponse,
} from './submit.js'
import { disambiguate } from './disambiguator.js'
import { renderDigest, shouldNotify } from './notify.js'

export interface LoopConfig {
  auth: OAuth2Client
  labels: Labels
  labelPrefix: string
  model: ModelConfig
  api: ApiConfig
  query: string
  notifyReply: boolean
  notifyOnDismiss: boolean
  dryRun: boolean
}

function buildBody(gmailId: string, n: Normalized, ex: Extraction): InboundBody {
  const summary = (ex.notes || ex.event.summary || '').trim().slice(0, 4000)
  return {
    external_ref: gmailId,
    source: 'gmail-worker',
    occurred_at: n.orig_date,
    summary: summary || null,
    thread_key: n.thread_key || null,
    extracted: ex,
  }
}

export async function runCycle(c: LoopConfig): Promise<{ processed: number; errored: number }> {
  // outstanding + anything stranded mid-flight (crash / lost response)
  const recovery = `label:${c.labelPrefix}processing -label:${c.labelPrefix}processed -label:${c.labelPrefix}error`
  const ids = [
    ...new Set([
      ...(await listMessageIds(c.auth, c.query)),
      ...(await listMessageIds(c.auth, recovery)),
    ]),
  ]
  if (ids.length === 0) return { processed: 0, errored: 0 }
  console.log(`[loop] ${ids.length} message(s) to process`)

  let processed = 0
  let errored = 0

  for (const id of ids) {
    try {
      await relabel(c.auth, id, { add: [c.labels.processing], remove: [c.labels.inbox] })

      const msg = await getMessage(c.auth, id)
      const n = await clean(msg.raw)
      const outcome = await runExtraction(n, c.model)

      if (!outcome.ok || !outcome.extraction) {
        console.error(`[loop] ${id} extraction FAILED: ${outcome.issues ?? 'no JSON'}`)
        if (!c.dryRun) {
          await relabel(c.auth, id, { add: [c.labels.error], remove: [c.labels.processing] })
        }
        errored++
        continue
      }
      const ex = outcome.extraction
      const body = buildBody(id, n, ex)

      if (c.dryRun) {
        console.log(`[loop] DRY ${id} ${ex.email_kind} · ${body.summary ?? ''}`)
        processed++
        continue
      }

      let resp: InboundResponse = await submitInbound(c.api, body)
      console.log(
        `[loop] ${id} ${ex.email_kind} -> ${resp.status}${resp.deduped ? ' (dedup)' : ''} ${resp.review_url}`,
      )

      if (resp.status === 'needs_disambiguation') {
        const rid = idFromReviewUrl(resp.review_url)
        const picks = await disambiguate(n, resp.proposal, c.model)
        if (rid && Object.keys(picks).length > 0) {
          const after = await chooseInbound(c.api, rid, picks)
          resp = { ...resp, status: after.status as InboundResponse['status'], proposal: after.proposal }
          console.log(`[loop] ${id} disambiguated -> ${resp.status}`)
        }
      }

      if (
        c.notifyReply &&
        shouldNotify(resp, c.notifyOnDismiss) &&
        msg.envelope.fromAddress
      ) {
        const d = renderDigest(msg.envelope.subject, resp, ex, body.summary)
        await sendReply(c.auth, {
          threadId: msg.threadId,
          to: msg.envelope.fromAddress,
          subject: d.subject,
          inReplyTo: msg.envelope.messageId,
          body: d.body,
        })
      }

      await relabel(c.auth, id, { add: [c.labels.processed], remove: [c.labels.processing] })
      processed++
    } catch (err) {
      if (err instanceof GmailAuthError) throw err // -> main, FATAL
      if (err instanceof SubmitTransportError) {
        console.error(`[loop] ${id} callback unreachable — left in processing for retry: ${err.message}`)
        errored++
        continue
      }
      console.error(`[loop] ${id} unexpected error: ${(err as Error).message}`)
      if (!c.dryRun) {
        await relabel(c.auth, id, { add: [c.labels.error], remove: [c.labels.processing] }).catch(
          () => {},
        )
      }
      errored++
    }
  }

  return { processed, errored }
}
