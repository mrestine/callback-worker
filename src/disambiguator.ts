/**
 * The optional second model call. When callback returns `needs_disambiguation`
 * (a link op has candidates but no confident match), ask the model to pick.
 * Multiple-choice — a 7B does this reliably. If it says "none", the op is left
 * for the human in the review UI. callback never calls a model; this does.
 */
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { chatJson } from './model.js'
import type { ModelConfig } from './model.js'
import type { Normalized } from './schemas.js'
import { renderEmail } from './extractor.js'
import type { ProposalOp } from './submit.js'

const SYSTEM_PROMPT_URL = new URL('../prompts/disambiguate.system.md', import.meta.url)

const picks = z
  .object({
    picks: z.array(
      z.object({
        op_id: z.string(),
        choice: z.number().int().nullable(),
      }),
    ),
  })
  .strict()
const picksJsonSchema = zodToJsonSchema(picks, { $refStrategy: 'none', target: 'jsonSchema7' })

const ENTITY: Record<string, string> = {
  link_company: 'company',
  link_application: 'application',
  link_contact: 'contact',
}

/** ops that still need a pick: a link op with candidates and no chosen id */
export function ambiguousOps(proposal: ProposalOp[] | undefined): ProposalOp[] {
  return (proposal ?? []).filter(
    (o) =>
      o.decision !== 'skip' &&
      o.op.startsWith('link_') &&
      o.match != null &&
      o.match.chosen == null &&
      o.match.candidates.length > 0,
  )
}

/**
 * Returns `{ opId: candidateId }` for the ops the model matched confidently.
 * Ops it can't place are omitted (the human resolves them).
 */
export async function disambiguate(
  n: Normalized,
  proposal: ProposalOp[] | undefined,
  cfg: ModelConfig,
): Promise<Record<string, number>> {
  const ops = ambiguousOps(proposal)
  if (ops.length === 0) return {}

  const questions = ops
    .map((op, qi) => {
      const lines = op.match!.candidates.map((c, i) => `    ${i + 1}. ${c.label}`)
      return `Q${qi + 1} (op_id "${op.id}"): which ${ENTITY[op.op] ?? 'record'} is this email about?\n${lines.join('\n')}`
    })
    .join('\n\n')

  const system = await readFile(SYSTEM_PROMPT_URL, 'utf8')
  const user = `${renderEmail(n)}\n\n---\n${questions}`

  const { json } = await chatJson(cfg, system, user, picksJsonSchema)
  const parsed = picks.safeParse(json)
  if (!parsed.success) return {}

  const out: Record<string, number> = {}
  for (const pick of parsed.data.picks) {
    const op = ops.find((o) => o.id === pick.op_id)
    if (!op || pick.choice == null) continue
    const cand = op.match!.candidates[pick.choice - 1] // 1-based in the prompt
    if (cand) out[op.id] = cand.id
  }
  return out
}
