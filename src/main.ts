/**
 * Container entrypoint — the poll loop.
 *
 *   poll Gmail by label -> clean -> extract (local model) -> POST /api/inbound
 *   -> (disambiguate) -> digest reply -> relabel
 *
 * Gmail labels are the entire state machine; there is no local store. If the
 * Gmail refresh token dies the loop can't do anything useful (and can't even
 * email a warning), so it logs FATAL and idles — an external HEALTHCHECK_URL
 * going quiet is the out-of-band alert.
 */
import { modelConfigFromEnv } from './model.js'
import { apiConfigFromEnv } from './submit.js'
import { GmailAuthError, ensureLabels, loadAuth } from './gmail.js'
import { runCycle, type LoopConfig } from './loop.js'

const intervalMs = (Number(process.env.POLL_INTERVAL_SECONDS) || 90) * 1000
const labelPrefix = process.env.GMAIL_LABEL_PREFIX || 'callback/'
const query =
  process.env.GMAIL_QUERY ||
  `label:${labelPrefix}inbox -label:${labelPrefix}processing -label:${labelPrefix}processed -label:${labelPrefix}error`
const dryRun = /^(1|true|yes)$/i.test(process.env.DRY_RUN ?? '')
const notifyReply = !/^(0|false|no)$/i.test(process.env.NOTIFY_REPLY ?? 'true')
const notifyOnDismiss = /^(1|true|yes)$/i.test(process.env.NOTIFY_ON_DISMISS ?? '')

function requireEnv(name: string): void {
  if (!process.env[name]) {
    console.error(`FATAL: ${name} is not set`)
    process.exit(1)
  }
}
requireEnv('GMAIL_CREDENTIALS_PATH')
requireEnv('GMAIL_TOKEN_PATH')
if (!dryRun) {
  requireEnv('CALLBACK_API_URL')
  requireEnv('CALLBACK_TOKEN')
}

async function pingHealthcheck(): Promise<void> {
  const url = process.env.HEALTHCHECK_URL
  if (!url) return
  try {
    await fetch(url, { method: 'GET' })
  } catch {
    /* the check service noticing the silence is the point */
  }
}

async function main(): Promise<void> {
  const model = modelConfigFromEnv()
  const api = dryRun ? { baseUrl: '', token: '' } : apiConfigFromEnv()

  const auth = await loadAuth({
    credentialsPath: process.env.GMAIL_CREDENTIALS_PATH!,
    tokenPath: process.env.GMAIL_TOKEN_PATH!,
  })
  const labels = await ensureLabels(auth, labelPrefix)

  const cfg: LoopConfig = {
    auth,
    labels,
    labelPrefix,
    model,
    api,
    query,
    notifyReply,
    notifyOnDismiss,
    dryRun,
  }

  console.log(
    `callback-worker up · model=${model.model} · poll ${intervalMs / 1000}s · ` +
      `dryRun=${dryRun} · notifyReply=${notifyReply}`,
  )

  let fatal = false
  async function tick(): Promise<void> {
    if (fatal) return
    try {
      const { processed, errored } = await runCycle(cfg)
      if (processed || errored) console.log(`[loop] cycle done: ${processed} ok, ${errored} errored`)
      await pingHealthcheck()
    } catch (err) {
      if (err instanceof GmailAuthError) {
        fatal = true
        console.error(`\nFATAL: Gmail auth is dead — the poll loop is stopped.\n  ${err.message}\n`)
        console.error(
          'Re-run `npm run gmail:auth` on a machine with a browser, replace ' +
            `${process.env.GMAIL_TOKEN_PATH}, and restart the container.`,
        )
        return
      }
      console.error(`[loop] cycle threw: ${(err as Error).message}`)
    }
  }

  await tick()
  setInterval(() => void tick(), intervalMs)
}

main().catch((err) => {
  console.error(`FATAL: ${(err as Error).message}`)
  process.exit(1)
})
