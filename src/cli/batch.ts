/**
 * Run the whole pipe over every .eml in a directory. Writes
 * `<name>.norm.out.json` and `<name>.extract.out.json` next to each (both
 * gitignored) so you can eyeball / diff results across prompt iterations.
 *
 *   npm run batch                       # defaults to fixtures/private
 *   npm run batch -- fixtures/sample
 *   npm run batch -- fixtures/private --model llama3.1:8b-instruct
 */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { clean } from '../clean.js'
import { modelConfigFromEnv } from '../model.js'
import { runExtraction } from '../extractor.js'
import { flag, positionalArg, toEml } from './io.js'

const dir = positionalArg() ?? 'fixtures/private'
const cfg = modelConfigFromEnv({ model: flag('--model') })

const files = (await readdir(dir))
  .filter((f) => ['.eml', '.json'].includes(extname(f).toLowerCase()))
  .filter((f) => !f.endsWith('.out.json') && !f.endsWith('.expected.json'))
  .sort()

if (files.length === 0) {
  process.stderr.write(`no .eml files in ${dir}\n`)
  process.exit(1)
}

let ok = 0
for (const f of files) {
  const stem = basename(f, extname(f))
  try {
    const n = await clean(toEml(await readFile(join(dir, f))))
    const out = await runExtraction(n, cfg)
    await writeFile(join(dir, `${stem}.norm.out.json`), JSON.stringify(n, null, 2) + '\n')
    await writeFile(
      join(dir, `${stem}.extract.out.json`),
      JSON.stringify(out.ok ? out.extraction : { _error: out.issues, _raw: out.raw }, null, 2) + '\n',
    )
    process.stdout.write(
      `${(out.ok ? 'ok' : 'FAIL').padEnd(4)} ${f.padEnd(40)} ${String(out.meta.total_ms).padStart(6)}ms  ` +
        `${n.orig_from.email} · ${out.extraction?.email_kind ?? '—'}\n`,
    )
    if (out.ok) ok++
  } catch (err) {
    process.stdout.write(`ERR  ${f}  ${(err as Error).message}\n`)
  }
}
process.stdout.write(`\n${ok}/${files.length} valid\n`)
