/**
 * Scored eval harness for the extraction prompt (+ guards) - the model-driven
 * part of the pipeline, which is why it needs a harness at all: everything
 * else (clean.ts, the guards themselves, callback's matching/proposal logic)
 * is deterministic code and testable the normal way. This isn't.
 *
 * For every fixtures/sample/<name>.expected.json with a matching <name>.eml,
 * runs the SAME clean() -> runExtraction() path production uses (model call
 * + guards), and diffs the result against the hand-authored expected output.
 * Read-only against the real pipeline - never touches Gmail or callback.
 *
 * Comparison policy (see `compare` below):
 *   - most fields: exact match after trimming strings
 *   - event.occurred_at: compared as parsed instants, not strings
 *   - additional_opportunities: recursed into as an array (length + each entry)
 *   - confidence (anywhere), event.summary, notes: SKIPPED - free-text/
 *     subjective fields a "correct" fixture shouldn't have to pin exactly
 *   - _note: skipped (fixture documentation, not part of the schema)
 *
 * A fixture fails if ANY non-skipped field mismatches. Exit code is non-zero
 * if any fixture failed - wire this into your own habit of running it before
 * committing a prompt or guard change, same idea as any other regression gate.
 *
 *   npm run eval                       # fixtures/sample, default model
 *   npm run eval -- fixtures/sample --model llama3.2:3b
 */
import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { clean } from '../clean.js'
import { modelConfigFromEnv } from '../model.js'
import { runExtraction } from '../extractor.js'
import { flag, positionalArg, toEml } from './io.js'

const dir = positionalArg() ?? 'fixtures/sample'
const cfg = modelConfigFromEnv({ model: flag('--model') })

const SKIP_KEYS = new Set(['confidence', '_note'])
const SOFT_KEYS = new Set(['summary', 'notes'])

interface CheckResult {
  path: string
  ok: boolean
  soft: boolean
  expected: unknown
  actual: unknown
}

function compare(expected: unknown, actual: unknown, path: string, out: CheckResult[]): void {
  if (expected === null || typeof expected !== 'object') {
    const key = path.split(/[.[]/).pop() ?? ''
    if (SKIP_KEYS.has(key)) return
    if (SOFT_KEYS.has(key)) {
      out.push({ path, ok: true, soft: true, expected, actual })
      return
    }
    if (path === 'event.occurred_at') {
      const ok =
        (expected == null && actual == null) ||
        (expected != null &&
          actual != null &&
          !Number.isNaN(Date.parse(String(expected))) &&
          Date.parse(String(expected)) === Date.parse(String(actual)))
      out.push({ path, ok, soft: false, expected, actual })
      return
    }
    const norm = (v: unknown) => (typeof v === 'string' ? v.trim() : v)
    out.push({ path, ok: norm(expected) === norm(actual), soft: false, expected, actual })
    return
  }
  if (Array.isArray(expected)) {
    const actualArr = Array.isArray(actual) ? actual : []
    out.push({
      path: `${path}.length`,
      ok: actualArr.length === expected.length,
      soft: false,
      expected: expected.length,
      actual: actualArr.length,
    })
    expected.forEach((item, i) => compare(item, actualArr[i], `${path}[${i}]`, out))
    return
  }
  for (const [k, v] of Object.entries(expected as Record<string, unknown>)) {
    if (SKIP_KEYS.has(k)) continue
    compare(v, (actual as Record<string, unknown> | undefined)?.[k], path ? `${path}.${k}` : k, out)
  }
}

const files = (await readdir(dir)).filter((f) => f.endsWith('.expected.json')).sort()
if (files.length === 0) {
  process.stderr.write(`no .expected.json files in ${dir}\n`)
  process.exit(1)
}

let totalChecks = 0
let passedChecks = 0
let fixturesFailed = 0

for (const f of files) {
  const stem = basename(f, '.expected.json')
  const emlPath = join(dir, `${stem}.eml`)
  const expected = JSON.parse(await readFile(join(dir, f), 'utf8')) as Record<string, unknown>
  delete expected._note

  process.stdout.write(`\n# ${stem}\n`)

  let n
  try {
    n = await clean(toEml(await readFile(emlPath)))
  } catch (err) {
    process.stdout.write(`  FAIL  no matching ${stem}.eml (${(err as Error).message})\n`)
    fixturesFailed++
    continue
  }

  const out = await runExtraction(n, cfg)
  if (!out.ok) {
    process.stdout.write(`  FAIL  model output did not validate against the schema:\n  ${out.issues}\n`)
    fixturesFailed++
    continue
  }

  const results: CheckResult[] = []
  compare(expected, out.extraction, '', results)

  let fixtureOk = true
  let hardCount = 0
  for (const r of results) {
    if (r.soft) continue
    hardCount++
    totalChecks++
    if (r.ok) {
      passedChecks++
    } else {
      fixtureOk = false
      process.stdout.write(`  FAIL  ${r.path}: expected ${JSON.stringify(r.expected)}, got ${JSON.stringify(r.actual)}\n`)
    }
  }
  if (fixtureOk) process.stdout.write(`  ok    all ${hardCount} checks passed  (${out.meta.total_ms}ms)\n`)
  else fixturesFailed++
}

process.stdout.write(
  `\n${passedChecks}/${totalChecks} field checks passed - ${files.length - fixturesFailed}/${files.length} fixtures fully passed\n`,
)
process.exit(fixturesFailed > 0 ? 1 : 0)
