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
  return { ok: true, extraction: parsed.data, raw, meta }
}
