/**
 * Eval for the company-summary prompt. Same idea as eval.ts but for the other
 * model call: canned search results in (no Serper calls, no cost), the
 * summarizeCompany() output checked against assertions.
 *
 * Every fixture gets these generic checks, which need no hand-written answer:
 *   - non-empty
 *   - at most 3 sentences
 *   - no marketing buzzwords (the prompt forbids them even when sources use them)
 *   - no ungrounded numbers: every number in the description must also appear
 *     in the search results. This is the check that catches facts supplied
 *     from the model's memory rather than the sources (e.g. a founding year
 *     that isn't in any snippet).
 * plus per-fixture `must_include`, `must_include_any`, and `must_not_include`
 * (case-insensitive substrings).
 *
 *   npm run eval:company                       # fixtures/company
 *   npm run eval:company -- fixtures/company --model llama3.2:3b
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { summarizeCompany } from '../companySummary.js'
import { modelConfigFromEnv } from '../model.js'
import type { SearchResult } from '../serper.js'
import { flag, positionalArg } from './io.js'

const dir = positionalArg() ?? 'fixtures/company'
const cfg = modelConfigFromEnv({ model: flag('--model') })

interface Fixture {
  name: string
  results: SearchResult[]
  must_include?: string[]
  must_include_any?: string[]
  must_not_include?: string[]
  context?: string
}

const BUZZWORDS =
  /industry-leading|innovative|disruptive|passionate|cutting-edge|world-class|best-in-class|revolution|game-chang|seamless|empower/i

/** Broader than the production scrub on purpose, so a too-narrow scrub shows up here. */
const MISSING_INFO =
  /not (?:provided|specified|available|stated|disclosed|mentioned)|no (?:specific )?(?:details|information)|unknown|unspecified|undisclosed/i

function failures(fx: Fixture, description: string): string[] {
  const out: string[] = []
  const lower = description.toLowerCase()
  const has = (s: string) => lower.includes(s.toLowerCase())

  if (!description) {
    return ['empty description']
  }

  const sentences = description.split(/(?<=[.!?])\s+/).filter(Boolean)
  if (sentences.length > 3) out.push(`${sentences.length} sentences (max 3)`)

  if (sentences.length > 1 && sentences.some((s) => MISSING_INFO.test(s))) {
    out.push('comments on missing information')
  }

  const buzz = description.match(BUZZWORDS)
  if (buzz) out.push(`buzzword "${buzz[0]}"`)

  const sources = fx.results.map((r) => `${r.title} ${r.snippet}`).join(' ').toLowerCase()
  for (const num of new Set(description.match(/\d+(?:[.,]\d+)*/g) ?? [])) {
    if (!sources.includes(num.toLowerCase())) out.push(`ungrounded number "${num}" (not in any search result)`)
  }

  for (const s of fx.must_include ?? []) if (!has(s)) out.push(`missing "${s}"`)
  if (fx.must_include_any?.length && !fx.must_include_any.some(has)) {
    out.push(`none of [${fx.must_include_any.join(', ')}] present`)
  }
  for (const s of fx.must_not_include ?? []) if (has(s)) out.push(`contains forbidden "${s}"`)
  return out
}

const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
if (files.length === 0) {
  process.stderr.write(`no .json fixtures in ${dir}\n`)
  process.exit(1)
}

let failed = 0
for (const f of files) {
  const fx = JSON.parse(await readFile(join(dir, f), 'utf8')) as Fixture
  const started = Date.now()
  const description = await summarizeCompany(fx.name, fx.results, cfg, fx.context)
  const bad = failures(fx, description)
  process.stdout.write(`\n# ${f.replace(/\.json$/, '')}  (${Date.now() - started}ms)\n`)
  process.stdout.write(`  > ${description || '(empty)'}\n`)
  if (bad.length === 0) {
    process.stdout.write('  ok\n')
  } else {
    failed++
    for (const b of bad) process.stdout.write(`  FAIL  ${b}\n`)
  }
}

process.stdout.write(`\n${files.length - failed}/${files.length} fixtures passed\n`)
process.exit(failed > 0 ? 1 : 0)
