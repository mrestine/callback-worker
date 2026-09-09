/**
 * normalized JSON -> extraction JSON on stdout. Diagnostics go to stderr, so
 * `preprocess | extract > out.json` stays clean.
 *
 *   npm run extract -- foo.norm.json
 *   npm run preprocess -- foo.eml | npm run extract
 *   npm run extract -- foo.norm.json --model llama3.1:8b-instruct --show-prompt
 */
import { normalized } from '../schemas.js'
import { modelConfigFromEnv } from '../model.js'
import { buildPrompt, runExtraction } from '../extractor.js'
import { flag, has, positionalArg, readInput } from './io.js'

const n = normalized.parse(JSON.parse((await readInput(positionalArg())).toString('utf8')))

const cfg = modelConfigFromEnv({
  model: flag('--model'),
  numPredict: flag('--num-predict') ? Number(flag('--num-predict')) : undefined,
})

if (has('--show-prompt')) {
  const { system, user } = await buildPrompt(n)
  process.stderr.write(`--- SYSTEM ---\n${system}\n\n--- USER ---\n${user}\n--- END PROMPT ---\n\n`)
}

const out = await runExtraction(n, cfg)
process.stderr.write(
  `[${cfg.model}] ${out.meta.total_ms}ms${out.meta.eval_count ? ` · ${out.meta.eval_count} tok` : ''}\n`,
)

if (!out.ok) {
  process.stderr.write(`\nVALIDATION FAILED:\n${out.issues}\n\nRAW MODEL OUTPUT:\n${out.raw}\n`)
  process.exit(1)
}

process.stdout.write(JSON.stringify(out.extraction, null, 2) + '\n')
