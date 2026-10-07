/**
 * The note the operator types above a forwarded email ("here's the link, pays
 * a lot, remote") sorted into the application fields callback has: job posting
 * link, pay range, remote/hybrid/onsite. Anything else in the note is kept as
 * the application's notes, as written.
 *
 *   note -> one small model call (only when there IS a note) -> three fields
 *   -> each checked against the note -> notes = the note minus what was taken
 *
 * A separate call, not part of extraction: the extraction prompt and its
 * evals never see the note. The model only ever picks values out of the note;
 * the leftover notes are built by code, so the operator's words are never
 * rewritten, and on any failure the whole note becomes the notes.
 */
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { NUMBER, appearsIn } from './companySummary.js'
import type { OperatorDetails, OutgoingExtraction } from './companyNotes.js'
import { chatJson } from './model.js'
import type { ModelConfig } from './model.js'

const SYSTEM_PROMPT_URL = new URL('../prompts/operator-note.system.md', import.meta.url)

const fields = z
  .object({
    jd_url: z.string(),
    salary_range: z.string(),
    remote: z.enum(['', 'remote', 'hybrid', 'onsite']),
  })
  .strict()
const fieldsJsonSchema = zodToJsonSchema(fields, { $refStrategy: 'none', target: 'jsonSchema7' })

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi
const TRAILING_PUNCT = /[.,;:!?]+$/

/** Every link in the note, as written (minus punctuation that ended the sentence). */
export function urlsIn(note: string): string[] {
  return (note.match(URL_RE) ?? []).map((u) => u.replace(TRAILING_PUNCT, ''))
}

/** The model's link, only if the note really contains it (compared without a trailing slash). */
export function groundedUrl(url: string, note: string): string {
  const want = url.trim().replace(TRAILING_PUNCT, '').replace(/\/$/, '').toLowerCase()
  if (!want) return ''
  return urlsIn(note).find((u) => u.replace(/\/$/, '').toLowerCase() === want) ?? ''
}

/** The model's pay figure, only if it has a number and every number is in the note. */
export function groundedSalary(value: string, note: string): string {
  const v = value.trim()
  if (!v || v.length > 80 || !/\d/.test(v)) return ''
  return (v.match(NUMBER) ?? []).every((n) => appearsIn(note, n)) ? v : ''
}

const REMOTE_WORDS: Record<NonNullable<OperatorDetails['remote']>, RegExp> = {
  remote: /\b(?:remote|wfh|work from home|work-from-home)\b/i,
  hybrid: /\bhybrid\b/i,
  onsite: /\bon-?site\b|\bin[- ]office\b|\bin[- ]person\b/i,
}

/** The model's work mode, only if the note uses a word for it. */
export function groundedRemote(value: string, note: string): OperatorDetails['remote'] | undefined {
  if (value !== 'remote' && value !== 'hybrid' && value !== 'onsite') return undefined
  return REMOTE_WORDS[value].test(note) ? value : undefined
}

// The words people put in front of a link or a pay figure ("JD: <link>",
// "pays 130-150k", "comp is 160-190k"). They go out with the value they introduce.
const LEAD_IN =
  '(?:\\b(?:jd|job (?:description|posting|link)|posting|link|apply(?: here)?|application(?: link)?|pays?|paying|comp(?:ensation)?|salary(?: range)?|base|tc|range|pay)\\b[\\s:~=-]*(?:(?:is|of|at|around|about)\\b[\\s:~=-]*)?)?'

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const wordCount = (s: string) => (s.match(/[\p{L}\p{N}]+/gu) ?? []).length

/**
 * The note with the taken-out values removed, plus the words that introduced
 * them. A line left with nothing disappears, as does a short line that only
 * restates the work mode already captured ("Remote", "remote ok"); a line with
 * anything else on it keeps the rest, as written.
 */
export function leftoverNotes(note: string, taken: string[], remote?: OperatorDetails['remote']): string {
  const out: string[] = []
  for (const line of note.split('\n')) {
    let rest = line.trimEnd()
    let touched = false
    for (const t of taken) {
      if (!t) continue
      const re = new RegExp(LEAD_IN + escapeRegExp(t), 'i')
      if (re.test(rest)) {
        rest = rest.replace(re, '')
        touched = true
      }
    }
    if (touched) rest = rest.replace(/^[\s:,;.|-]+/, '').replace(/[\s:,;|-]+$/, '').replace(/ {2,}/g, ' ')
    if (touched && wordCount(rest) === 0) continue
    if (remote && wordCount(rest) <= 3 && REMOTE_WORDS[remote].test(rest)) continue
    out.push(rest)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** What the model picked, checked against the note, plus the leftover notes. */
export function guardPicks(note: string, picked: { jd_url: string; salary_range: string; remote: string }): OperatorDetails {
  const jd_url = groundedUrl(picked.jd_url, note)
  const salary_range = groundedSalary(picked.salary_range, note)
  const remote = groundedRemote(picked.remote, note)
  const notes = leftoverNotes(note, [jd_url, salary_range], remote)
  return {
    ...(jd_url ? { jd_url } : {}),
    ...(salary_range ? { salary_range } : {}),
    ...(remote ? { remote } : {}),
    ...(notes ? { notes } : {}),
  }
}

/** Note in, application details out. Empty note: nothing, and no model call. */
export async function parseOperatorNote(note: string, cfg: ModelConfig): Promise<OperatorDetails> {
  const text = note.trim()
  if (!text) return {}
  const system = await readFile(SYSTEM_PROMPT_URL, 'utf8')
  const { json } = await chatJson(cfg, system, `Note:\n${text}`, fieldsJsonSchema)
  if (process.env.DEBUG_OPERATOR_NOTE) console.error(`[operatorNote] model said ${JSON.stringify(json)}`)
  const parsed = fields.safeParse(json)
  if (!parsed.success) return { notes: text }
  console.log(
    `[operatorNote] model said jd_url=${JSON.stringify(parsed.data.jd_url)} salary_range=${JSON.stringify(parsed.data.salary_range)} ` +
      `remote=${JSON.stringify(parsed.data.remote)}`,
  )
  return guardPicks(text, parsed.data)
}

/**
 * Attach the parsed note to the outgoing extraction. Best-effort like the
 * company step: if the model call fails the whole note still travels, as the
 * application's notes, and nothing here can stop a submission.
 */
export async function addOperatorNote(
  ex: OutgoingExtraction,
  note: string,
  cfg: ModelConfig,
  parse: (note: string, cfg: ModelConfig) => Promise<OperatorDetails> = parseOperatorNote,
): Promise<OutgoingExtraction> {
  const text = note.trim()
  if (!text) return ex
  let found: OperatorDetails
  try {
    found = await parse(text, cfg)
  } catch (err) {
    console.warn(`[operatorNote] model failed, keeping the note as written: ${(err as Error).message}`)
    found = { notes: text }
  }
  return Object.keys(found).length > 0 ? { ...ex, operator_note: found } : ex
}
