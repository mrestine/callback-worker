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

/** searchCompany interleaves two queries, so this keeps the best ~4 of each.
 *  Past that the extra results are mostly noise (forums, review sites) and
 *  just give the model more unrelated companies to be confused by. */
export const MAX_RESULTS = 8

// `results` comes first on purpose: the model must say what business each result
// is about, and mark the ones that are not the company, before it fills in any
// field. (A bare list of "relevant" numbers let it keep a same-name company's
// results and copy its founding year.)
const summary = z
  .object({
    results: z.array(z.object({ n: z.number().int(), is: z.string(), same_business: z.boolean() }).strict()),
    founded: z.string(),
    headcount: z.string(),
    latest_funding: z.string(),
    hq_location: z.string(),
    description: z.string(),
  })
  .strict()

/** What the step produces for one company; both parts are '' when unknown. */
export interface CompanyProfile {
  description: string
  hq_location: string
  /** What the model said before the guards ran, kept for the worker log so a
   *  missing line can be traced to the model or to a guard. */
  raw?: { founded: string; headcount: string; latest_funding: string; hq_location: string; sameBusiness: string }
}
const NOTHING: CompanyProfile = { description: '', hq_location: '' }
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

/** Common short forms; a source saying one lets the other through. */
const CITY_ALIASES: [short: string, full: string][] = [
  ['nyc', 'new york'],
  ['sf', 'san francisco'],
  ['la', 'los angeles'],
]

/**
 * Keep the model's headquarters only if its city appears in the sources. Like
 * the number check, this stops a 7B model answering from memory ("San
 * Francisco" for a company no result places anywhere), and a wrong prefill in
 * the location field is worse than an empty one. Only the city (the part
 * before the first comma) is checked: adding or spelling out the state or
 * country ("Boston" -> "Boston, MA") is ordinary tidying, not contamination.
 */
export function groundedLocation(location: string, sources: SearchResult[]): string {
  const loc = location.trim()
  if (!loc || loc.length > 80 || /[\r\n]/.test(loc)) return ''
  const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const city = squash(loc.split(',')[0])
  if (!city) return ''
  const haystack = ` ${squash(sources.map((r) => `${r.title} ${r.snippet}`).join(' '))} `
  const mentions = (place: string) => haystack.includes(` ${place} `)
  if (mentions(city)) return loc
  return CITY_ALIASES.some(([short, full]) => (city === short && mentions(full)) || (city === full && mentions(short)))
    ? loc
    : ''
}

/** The model writes "not specified" and the like for a field it has nothing for. */
const EMPTY_VALUE = /^(?:not (?:specified|stated|available|provided|disclosed|mentioned)|unspecified|unknown|n\/a|none)\b/i
const present = (v: string): string => (EMPTY_VALUE.test(v.trim()) ? '' : v.trim())

/** A source stating the company is listed. Narrow on purpose: a bare "public" turns up in plenty of other contexts. */
const PUBLIC_COMPANY = /\b(?:is|as) an? (?:\w+ )?public company\b|\bpublicly[- ](?:traded|listed)\b|\b(?:NASDAQ|NYSE)\s*:/i

/**
 * The notes text: one sentence on what the company does, then one labeled line
 * per fact the model filled in, so each fact stands alone and is checked on its
 * own (a bad figure drops its line, not a sentence with other facts in it):
 *
 *   Acme makes anvils for roadrunners.
 *   Founded: 2019
 *   Employees: 412-500
 *   Funding: Series B, $120M, 2025
 *
 * The lines are the model's field values passed through, not rewritten, so the
 * prose can't drift from them (it did: it totalled rounds the field didn't).
 * Every number on a line must appear in the sources.
 */
export function composeNotes(
  f: { description: string; founded: string; headcount: string; latest_funding: string },
  sources: SearchResult[],
): string {
  const haystack = sources.map((r) => `${r.title} ${r.snippet}`).join(' ')
  const sentence = dropMissingInfoCommentary(dropUngroundedSentences(f.description.trim(), sources))
  const numbersOk = (v: string) => (v.match(NUMBER) ?? []).every((n) => appearsIn(haystack, n))
  const line = (label: string, raw: string, ok: (v: string) => boolean): string => {
    const v = present(raw)
    return v && ok(v) && numbersOk(v) ? `${label}: ${v}` : ''
  }
  // Funding is "Series B, $20M, 2023": a made-up year must not take the round
  // and amount down with it, so check each part and keep the grounded ones.
  // Without an amount, a bare year says nothing, so only the wordy parts stay
  // ("public, 2026" -> "public").
  const funding = (raw: string): string => {
    // a source saying so beats the model's pick of a (possibly very old) round
    if (PUBLIC_COMPANY.test(haystack)) return 'Funding: public'
    const kept = present(raw).split(',').map((p) => p.trim()).filter((p) => p && numbersOk(p))
    const shown = kept.some((p) => /[$€£]/.test(p)) ? kept : kept.filter((p) => !/\d/.test(p))
    return shown.length > 0 ? `Funding: ${shown.join(', ')}` : ''
  }
  return [
    sentence,
    line('Founded', f.founded, (v) => /^\d{4}$/.test(v)),
    line('Employees', f.headcount, (v) => /\d/.test(v)),
    funding(f.latest_funding),
  ]
    .filter(Boolean)
    .join('\n')
}

async function callSummary(
  name: string,
  results: SearchResult[],
  cfg: ModelConfig,
  context?: string,
): Promise<z.infer<typeof summary> | null> {
  const system = await readFile(SYSTEM_PROMPT_URL, 'utf8')
  // one entry per result plus the fields: more than the 512-token default
  const { json } = await chatJson({ ...cfg, numPredict: Math.max(cfg.numPredict, 1200) }, system, renderSearchResults(name, results, context), summaryJsonSchema)
  const parsed = summary.safeParse(json)
  if (process.env.DEBUG_COMPANY_SUMMARY) {
    console.error(`[companySummary] ${results.length} results in -> ${JSON.stringify(json)}`)
  }
  return parsed.success ? parsed.data : null
}

/** Raw search results in, a short description and the HQ out ('' for what the model has nothing on). */
export async function summarizeCompany(
  name: string,
  results: SearchResult[],
  cfg: ModelConfig,
  context?: string,
): Promise<CompanyProfile> {
  const top = results.slice(0, MAX_RESULTS)
  if (top.length === 0) return NOTHING
  const first = await callSummary(name, top, cfg, context)
  if (!first) return NOTHING

  // Selecting the right results is not enough on its own: with the full list
  // in view the model can still pull a fact from a result it excluded
  // (observed: a founding year belonging to an unrelated same-name company).
  // But its selection can also be wrong (it has dropped a company's own
  // website, or most of its own pages), so don't act on the selection alone.
  // Only when a founded / headcount / funding value carries a number found
  // solely in excluded results, fill the fields in again from the kept
  // results only.
  const keptIdx = new Set(
    first.results.filter((r) => r.same_business && r.n >= 1 && r.n <= top.length).map((r) => r.n),
  )
  const kept = top.filter((_, i) => keptIdx.has(i + 1))
  const excluded = top.filter((_, i) => !keptIdx.has(i + 1))
  let basis = top
  let facts = first
  if (excluded.length > 0) {
    const text = (rs: SearchResult[]) => rs.map((r) => `${r.title} ${r.snippet}`).join(' ')
    const [keptText, excludedText] = [text(kept), text(excluded)]
    const claimed = `${first.founded} ${first.headcount} ${first.latest_funding}`
    const contaminated = (claimed.match(NUMBER) ?? []).some(
      (num) => excludedText.includes(num) && !keptText.includes(num),
    )
    if (contaminated && kept.length > 0) {
      const second = await callSummary(name, kept, cfg, context)
      if (second) {
        facts = second
        basis = kept
      }
    }
  }
  return {
    description: composeNotes(facts, basis),
    hq_location: groundedLocation(present(facts.hq_location), basis),
    raw: {
      founded: facts.founded,
      headcount: facts.headcount,
      latest_funding: facts.latest_funding,
      hq_location: facts.hq_location,
      sameBusiness: `${basis === kept ? kept.length : keptIdx.size}/${top.length}`,
    },
  }
}

/** The whole step: search + summarize, never throws. */
export async function describeCompany(
  name: string,
  apiKey: string,
  cfg: ModelConfig,
  context?: string,
): Promise<CompanyProfile> {
  try {
    const results = await searchCompany(name, apiKey)
    return await summarizeCompany(name, results, cfg, context)
  } catch (err) {
    console.warn(`[companySummary] no description for "${name}": ${(err as Error).message}`)
    return NOTHING
  }
}
