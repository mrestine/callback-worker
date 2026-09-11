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
 * identity fields so callback has nothing to key a contact on (it only
 * proposes create_contact when sender.email || sender.name is non-empty) —
 * hiring_company/role/event/notes/status_signal, which don't carry this
 * mistake, are left as extracted.
 */
function guardOperatorIdentity(ex: Extraction, n: Normalized): Extraction {
  const operatorEmail = n.envelope_from.email.toLowerCase()
  if (!operatorEmail || ex.sender.email.toLowerCase() !== operatorEmail) return ex
  console.warn(
    `[extractor] model named the operator (${operatorEmail}) as sender — stripping identity fields`,
  )
  return {
    ...ex,
    sender: { name: '', email: '', org: null, is_agency_recruiter: false, kind: 'other', confidence: 0 },
  }
}

export interface ExtractOutcome {
  ok: boolean
  extraction: Extraction | null
  raw: string
  issues?: string
  meta: ChatResult['meta']
}

export async function runExtraction(n: Normalized, cfg: ModelConfig): Promise<ExtractOutcome> {
  const { system, user } = await buildPrompt(n)
  const { raw, json, meta } = await chatJson(cfg, system, user, extractionJsonSchema)
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
    }
  }
  return { ok: true, extraction: guardOperatorIdentity(parsed.data, n), raw, meta }
}
