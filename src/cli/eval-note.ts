/**
 * Eval for the operator-note step: real-looking notes in, the fields the model
 * picks (after the guards, exactly what would be sent) checked against what
 * each fixture says they should be. Needs the local model.
 *
 * A fixture is { note, jd_url, salary_includes, remote, [notes_includes],
 * [notes_empty] }:
 *   jd_url           exact link expected, or null for none
 *   salary_includes  substrings the pay figure must contain, or null for none
 *   remote           "remote" | "hybrid" | "onsite", or null for none
 *   notes_includes   substrings the leftover notes must keep (case-insensitive)
 *   notes_empty      the note was nothing but fields, so no notes are left
 *
 *   npm run eval:note                          # fixtures/note
 *   npm run eval:note -- fixtures/note --model llama3.2:3b
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { modelConfigFromEnv } from '../model.js'
import { parseOperatorNote } from '../operatorNote.js'
import type { OperatorDetails } from '../companyNotes.js'
import { flag, positionalArg } from './io.js'

const dir = positionalArg() ?? 'fixtures/note'
const cfg = modelConfigFromEnv({ model: flag('--model') })

interface Fixture {
  note: string
  jd_url: string | null
  salary_includes: string[] | null
  remote: 'remote' | 'hybrid' | 'onsite' | null
  notes_includes?: string[]
  notes_empty?: boolean
}

function failures(fx: Fixture, got: OperatorDetails): string[] {
  const out: string[] = []
  if ((got.jd_url ?? null) !== fx.jd_url) out.push(`jd_url ${JSON.stringify(got.jd_url ?? null)}, expected ${JSON.stringify(fx.jd_url)}`)

  if (fx.salary_includes === null) {
    if (got.salary_range) out.push(`salary_range ${JSON.stringify(got.salary_range)}, expected none`)
  } else if (!got.salary_range) {
    out.push(`no salary_range, expected one with ${fx.salary_includes.join(' and ')}`)
  } else {
    for (const s of fx.salary_includes) if (!got.salary_range.includes(s)) out.push(`salary_range ${JSON.stringify(got.salary_range)} is missing "${s}"`)
  }

  if ((got.remote ?? null) !== fx.remote) out.push(`remote ${JSON.stringify(got.remote ?? null)}, expected ${JSON.stringify(fx.remote)}`)

  const notes = (got.notes ?? '').toLowerCase()
  for (const s of fx.notes_includes ?? []) if (!notes.includes(s.toLowerCase())) out.push(`notes lost "${s}"`)
  if (fx.notes_empty && got.notes) out.push(`notes ${JSON.stringify(got.notes)}, expected none`)
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
  const got = await parseOperatorNote(fx.note, cfg)
  const bad = failures(fx, got)
  process.stdout.write(`\n# ${f.replace(/\.json$/, '')}  (${Date.now() - started}ms)\n`)
  process.stdout.write(`  > ${JSON.stringify(got)}\n`)
  if (bad.length === 0) {
    process.stdout.write('  ok\n')
  } else {
    failed++
    for (const b of bad) process.stdout.write(`  FAIL  ${b}\n`)
  }
}

process.stdout.write(`\n${files.length - failed}/${files.length} fixtures passed\n`)
process.exit(failed > 0 ? 1 : 0)
