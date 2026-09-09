/**
 * .eml -> normalized -> extraction, in one shot. The everyday tuning command.
 *
 *   npm run pipe -- fixtures/private/foo.eml
 *   npm run pipe -- fixtures/private/foo.eml --norm        # also dump the normalized JSON to stderr
 *   npm run pipe -- fixtures/private/foo.eml --model phi3.5
 */
import { clean } from '../clean.js'
import { modelConfigFromEnv } from '../model.js'
import { runExtraction } from '../extractor.js'
import { flag, has, positionalArg, readInput, toEml } from './io.js'

const n = await clean(toEml(await readInput(positionalArg())))

if (has('--norm')) {
  process.stderr.write(`--- NORMALIZED ---\n${JSON.stringify(n, null, 2)}\n\n`)
}
if (n.unwrap_fallback) {
  process.stderr.write('warn: no "Forwarded message" block found — used envelope headers\n')
}

const cfg = modelConfigFromEnv({ model: flag('--model') })
const out = await runExtraction(n, cfg)
process.stderr.write(`[${cfg.model}] ${out.meta.total_ms}ms\n`)

if (!out.ok) {
  process.stderr.write(`\nVALIDATION FAILED:\n${out.issues}\n\nRAW MODEL OUTPUT:\n${out.raw}\n`)
  process.exit(1)
}

process.stdout.write(JSON.stringify(out.extraction, null, 2) + '\n')
