import { readFile } from 'node:fs/promises'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { extraction } from './schemas.js'
import type { Extraction, Normalized } from './schemas.js'
import { chatJson } from './model.js'
import type { ChatResult, ModelConfig } from './model.js'

const SYSTEM_PROMPT_URL = new URL('../prompts/extract.system.md', import.meta.url)

/** JSON Schema handed to Ollama's `format` — refs inlined for llama.cpp's grammar. */
export const extractionJsonSchema = zodToJsonSchema(extraction, {
  $refStrategy: 'none',
  target: 'jsonSchema7',
})

export function renderEmail(n: Normalized): string {
  const lines = [
    `Subject: ${n.orig_subject || '(none)'}`,
    `From: ${n.orig_from.name} <${n.orig_from.email}>`,
    `To: ${n.orig_to.name} <${n.orig_to.email}>`,
    `Date: ${n.orig_date ?? '(unknown)'}`,
  ]
  if (n.self_authored) {
    lines.push(
      'Note: From: above is the operator\'s own address — this is the operator\'s own ' +
        'reply, forwarded instead of the email it replies to. The real sender/company/role ' +
        'is in the quoted original beneath the operator\'s note (a "On ... wrote:" block).',
    )
  }
  lines.push('', n.cleaned_body || '(empty body)')
  return lines.join('\n')
}

export async function buildPrompt(n: Normalized): Promise<{ system: string; user: string }> {
  return { system: await readFile(SYSTEM_PROMPT_URL, 'utf8'), user: renderEmail(n) }
}

/**
 * Deterministic backstop: every message the worker sees is a forward the
 * operator sent (envelope_from), so the operator can never legitimately be
 * the email's `sender` — a small model reading a self-authored forward
 * (§clean.ts `self_authored`) sometimes attributes the quoted third party's
 * role to the operator anyway. Rather than lean further on prompt wording,
 * catch it here: if the model names the operator as sender, wipe just the
 * name/email/kind — the fields that actually assert "this specific person is
 * the sender" — so callback has nothing to key a contact on (it only proposes
 * create_contact when sender.email || sender.name is non-empty). `org` and
 * `is_agency_recruiter` are a classification the model can still have read
 * correctly from context even while botching whose address is whose (an
 * earlier version of this guard zeroed those too, which silently defeated the
 * "an agency is never the hiring_company" rule downstream — see
 * guardAgencyAsHiringCompany). hiring_company/role/event/notes/status_signal
 * don't carry this mistake at all and are left as extracted.
 */
function guardOperatorIdentity(ex: Extraction, n: Normalized): Extraction {
  const operatorEmail = n.envelope_from.email.toLowerCase()
  if (!operatorEmail || ex.sender.email.toLowerCase() !== operatorEmail) return ex
  console.warn(
    `[extractor] model named the operator (${operatorEmail}) as sender — stripping identity fields`,
  )
  return { ...ex, sender: { ...ex.sender, name: '', email: '', kind: 'other' } }
}

/**
 * Deterministic backstop: "an agency is never the hiring_company" (per the
 * prompt) doesn't always hold on a 7b model, especially once an email
 * discusses several opportunities at once — one slot ends up holding the
 * agency's own name instead of a real employer. Drop any opportunity whose
 * hiring_company.name matches the sender's own org.
 *
 * Gated on `is_agency_recruiter` — UNLESS guardOperatorIdentity just wiped
 * sender identity (name and email both blanked), in which case
 * is_agency_recruiter isn't trustworthy either and the gate is skipped. Without
 * that exception this guard would also fire whenever a non-agency sender's
 * org and hiring_company are legitimately the same company (an ATS
 * confirmation email, say) — a real case, not a bug, that guardMissingHiringCompany
 * below only accidentally un-breaks by re-copying org back into hiring_company.
 */
function guardAgencyAsHiringCompany(ex: Extraction): Extraction {
  const org = ex.sender.org?.trim().toLowerCase()
  const identityWiped = !ex.sender.name && !ex.sender.email
  if (!org || (!identityWiped && !ex.sender.is_agency_recruiter)) return ex

  const scrub = (hc: Extraction['hiring_company']): Extraction['hiring_company'] =>
    hc.name?.trim().toLowerCase() === org ? { name: null, withheld: true, confidence: hc.confidence } : hc

  const hiring_company = scrub(ex.hiring_company)
  const additional_opportunities = ex.additional_opportunities.map((o) => ({
    ...o,
    hiring_company: scrub(o.hiring_company),
  }))
  if (hiring_company === ex.hiring_company && additional_opportunities.every((o, i) => o === ex.additional_opportunities[i])) {
    return ex
  }
  console.warn(`[extractor] model named the agency itself (${ex.sender.org}) as a hiring_company — dropped`)
  return { ...ex, hiring_company, additional_opportunities }
}

/**
 * Deterministic backstop: for a non-agency sender, `sender.org` (the sender's
 * own employer) and `hiring_company` (the actual employer) are, by definition,
 * the same entity — an ATS/in-house confirmation email is never legitimately
 * "withheld." qwen reliably extracts the company into `sender.org` on these
 * (application_confirmation from Greenhouse/Ashby/etc. no-reply addresses)
 * but then separately, incorrectly, leaves `hiring_company` null/withheld —
 * observed on 4 of 5 real submissions in one batch, every one of which had
 * `sender.org` populated (the 2 that got hiring_company right both had
 * `sender.org: null`, so the model isn't just guessing — it seems to read a
 * filled `sender.org` as "already covered, leave hiring_company alone").
 * Never fires for an agency: there, sender.org is the agency, not the
 * employer, and guardAgencyAsHiringCompany already keeps them apart.
 */
function guardMissingHiringCompany(ex: Extraction): Extraction {
  const org = ex.sender.org?.trim()
  if (ex.sender.is_agency_recruiter || !org || ex.hiring_company.name) return ex
  console.warn(`[extractor] hiring_company left null/withheld despite sender.org (${org}) — backfilled`)
  return { ...ex, hiring_company: { name: org, withheld: false, confidence: ex.sender.confidence } }
}

export interface ExtractOutcome {
  ok: boolean
  extraction: Extraction | null
  raw: string
  issues?: string
  meta: ChatResult['meta']
  /** the exact system/user text sent to the model — for debuglog.ts */
  prompt: { system: string; user: string }
}

export async function runExtraction(n: Normalized, cfg: ModelConfig): Promise<ExtractOutcome> {
  const prompt = await buildPrompt(n)
  const { raw, json, meta } = await chatJson(cfg, prompt.system, prompt.user, extractionJsonSchema)
  const parsed = extraction.safeParse(json)
  if (!parsed.success) {
    return {
      ok: false,
      extraction: null,
      raw,
      issues: parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n'),
      meta,
      prompt,
    }
  }
  const guarded = guardMissingHiringCompany(guardAgencyAsHiringCompany(guardOperatorIdentity(parsed.data, n)))
  return { ok: true, extraction: guarded, raw, meta, prompt }
}
