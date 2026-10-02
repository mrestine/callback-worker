/**
 * Company description for a company that's new to the tracker: web search
 * (serper.ts), then one separate model call to compress the snippets into
 * 2-3 plain sentences. A second call, not a tool for the extraction model -
 * the extraction call and its prompt are untouched by any of this.
 *
 * Strictly best-effort. Any failure (no key, no results, Serper down, Ollama
 * down, bad output) yields an empty string and a warning, never an error: a
 * missing description must not hold up the submission it would have decorated.
 */
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { chatJson } from './model.js'
import type { ModelConfig } from './model.js'
import { searchCompany } from './serper.js'
import type { SearchResult } from './serper.js'

const SYSTEM_PROMPT_URL = new URL('../prompts/company-summary.system.md', import.meta.url)

/** Past this the extra results are mostly noise (forums, review sites) and
 *  just give the model more unrelated companies to be confused by. */
const MAX_RESULTS = 6

// relevant_results comes first on purpose: the model must commit to which results
// describe the main business before it writes anything, instead of blending
// every result that happens to share the name into one description.
const summary = z
  .object({ relevant_results: z.array(z.number().int()), description: z.string() })
  .strict()
const summaryJsonSchema = zodToJsonSchema(summary, { $refStrategy: 'none', target: 'jsonSchema7' })

function domainOf(link: string): string {
  try {
    return new URL(link).hostname.replace(/^www\./, '')
  } catch {
    return link
  }
}

/** The user message, laid out exactly like the worked example in the prompt. */
export function renderSearchResults(name: string, results: SearchResult[], context?: string): string {
  const lines = results
    .map((r, i) => `${i + 1}. "${r.title}" - ${domainOf(r.link)} - "${r.snippet}"`)
  const ctx = context ? `\nContext: ${context}` : ''
  return `Company: ${name}${ctx}\n\nSearch results:\n${lines.join('\n')}`
}

const NUMBER = /\d+(?:[.,]\d+)*/g

/** `num` as a whole number: "2019" must not match inside "20190" or "12019". */
function appearsIn(haystack: string, num: string): boolean {
  return new RegExp(`(?<!\\d)${num.replace(/\./g, '\\.')}(?!\\d)`).test(haystack)
}

/**
 * Drop every sentence containing a number that appears in none of the source
 * results. A 7B model fills gaps from memory ("operating since at least 2019"
 * when no result gives a year), and a confident wrong year, headcount or
 * funding figure in someone's notes is worse than a shorter description.
 */
export function dropUngroundedSentences(description: string, sources: SearchResult[]): string {
  const haystack = sources.map((r) => `${r.title} ${r.snippet}`).join(' ')
  return description
    .split(/(?<=[.!?])\s+/)
    .filter((s) => (s.match(NUMBER) ?? []).every((n) => appearsIn(haystack, n)))
    .join(' ')
}

const MISSING_INFO =
  /\bnot (?:provided|specified|available|stated|disclosed|mentioned)\b|\b(?:unspecified|undisclosed)\b/i

/**
 * Drop sentences that only comment on what the sources lack ("has received
 * funding but details are not provided"). The prompt forbids them and the
 * model writes them anyway. Only applies to a multi-sentence description: a
 * lone "No clear information about a company named X" is the intended answer
 * when nothing identifies the company, and must survive.
 */
export function dropMissingInfoCommentary(description: string): string {
  const sentences = description.split(/(?<=[.!?])\s+/).filter(Boolean)
  if (sentences.length < 2) return description
  const kept = sentences.filter((s) => !MISSING_INFO.test(s))
  return kept.length > 0 ? kept.join(' ') : description
}

async function callSummary(
  name: string,
  results: SearchResult[],
  cfg: ModelConfig,
  context?: string,
): Promise<z.infer<typeof summary> | null> {
  const system = await readFile(SYSTEM_PROMPT_URL, 'utf8')
  const { json } = await chatJson(cfg, system, renderSearchResults(name, results, context), summaryJsonSchema)
  const parsed = summary.safeParse(json)
  if (process.env.DEBUG_COMPANY_SUMMARY) {
    console.error(`[companySummary] ${results.length} results in -> ${JSON.stringify(json)}`)
  }
  return parsed.success ? parsed.data : null
}

/** Raw search results in, one short paragraph out ('' if the model has nothing). */
export async function summarizeCompany(
  name: string,
  results: SearchResult[],
  cfg: ModelConfig,
  context?: string,
): Promise<string> {
  const top = results.slice(0, MAX_RESULTS)
  if (top.length === 0) return ''
  const first = await callSummary(name, top, cfg, context)
  if (!first) return ''

  // Selecting the right results is not enough on its own: with the full list
  // in view the model can still pull a fact from a result it excluded
  // (observed: a founding year belonging to an unrelated same-name company).
  // But its selection can also be wrong (it has dropped a company's own
  // website, or most of its own pages), so don't act on the selection alone.
  // Only when the description carries a number found solely in excluded
  // results, write it again from the kept results only.
  const keptIdx = new Set(first.relevant_results.filter((n) => n >= 1 && n <= top.length))
  const kept = top.filter((_, i) => keptIdx.has(i + 1))
  const excluded = top.filter((_, i) => !keptIdx.has(i + 1))
  let basis = top
  let description = first.description.trim()
  if (excluded.length > 0) {
    const text = (rs: SearchResult[]) => rs.map((r) => `${r.title} ${r.snippet}`).join(' ')
    const [keptText, excludedText] = [text(kept), text(excluded)]
    const contaminated = (first.description.match(/\d+(?:[.,]\d+)*/g) ?? []).some(
      (num) => excludedText.includes(num) && !keptText.includes(num),
    )
    if (contaminated && kept.length > 0) {
      const second = await callSummary(name, kept, cfg, context)
      if (second) {
        description = second.description.trim()
        basis = kept
      }
    }
  }
  return dropMissingInfoCommentary(dropUngroundedSentences(description, basis))
}

/** The whole step: search + summarize, never throws. */
export async function describeCompany(
  name: string,
  apiKey: string,
  cfg: ModelConfig,
  context?: string,
): Promise<string> {
  try {
    const results = await searchCompany(name, apiKey)
    return await summarizeCompany(name, results, cfg, context)
  } catch (err) {
    console.warn(`[companySummary] no description for "${name}": ${(err as Error).message}`)
    return ''
  }
}
