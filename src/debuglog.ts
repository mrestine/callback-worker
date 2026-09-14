/**
 * Every extraction's exact model input/output, saved to disk so a bad
 * extraction can be diagnosed without guessing what the model actually saw.
 * Bind-mounted (./debug -> /app/debug) so the host can read it directly, same
 * as fixtures/ and prompts/.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Normalized } from './schemas.js'
import type { ExtractOutcome } from './extractor.js'

const DEBUG_DIR = process.env.DEBUG_LOG_DIR || 'debug'

/** the non-operator party's address — envelope_from is always the operator
 *  (see clean.ts), so prefer orig_from when it differs, else orig_to. */
function otherEmail(n: Normalized): string {
  const operator = n.envelope_from.email.toLowerCase()
  const other = n.orig_from.email && n.orig_from.email.toLowerCase() !== operator ? n.orig_from.email : n.orig_to.email
  return (other || 'unknown').replace(/[^a-z0-9.@_-]/gi, '_')
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

export async function writeDebugLog(n: Normalized, outcome: ExtractOutcome): Promise<void> {
  try {
    await mkdir(DEBUG_DIR, { recursive: true })
    const stem = `${timestamp()}-${otherEmail(n)}`
    await writeFile(
      path.join(DEBUG_DIR, `${stem}.cleaned.json`),
      JSON.stringify({ normalized: n, prompt: outcome.prompt }, null, 2),
    )
    await writeFile(
      path.join(DEBUG_DIR, `${stem}.processed.json`),
      JSON.stringify(
        { ok: outcome.ok, extraction: outcome.extraction, raw: outcome.raw, issues: outcome.issues, meta: outcome.meta },
        null,
        2,
      ),
    )
  } catch (err) {
    console.error(`[debuglog] failed to write: ${(err as Error).message}`)
  }
}
