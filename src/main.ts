/**
 * Container entrypoint.
 *
 * Stage 2: a connectivity heartbeat — proves the container can reach Ollama and
 * reports which models are pulled. Stage 4 replaces the heartbeat body with the
 * real poll → clean → extract → submit loop.
 */
import { modelConfigFromEnv } from './model.js'

const cfg = modelConfigFromEnv()
const intervalMs = (Number(process.env.POLL_INTERVAL_SECONDS) || 60) * 1000

async function checkOllama(): Promise<void> {
  try {
    const res = await fetch(`${cfg.url}/api/tags`)
    if (!res.ok) {
      console.error(`[ollama] ${cfg.url} -> HTTP ${res.status}`)
      return
    }
    const data = (await res.json()) as { models?: { name: string }[] }
    const names = (data.models ?? []).map((m) => m.name)
    console.log(
      `[ollama] ${cfg.url} ok · ${names.length} model(s)${names.length ? ': ' + names.join(', ') : ''}`,
    )
    if (cfg.model && !names.includes(cfg.model)) {
      console.warn(`[ollama] configured model "${cfg.model}" is not pulled`)
    }
  } catch (err) {
    console.error(`[ollama] ${cfg.url} unreachable: ${(err as Error).message}`)
  }
}

console.log(
  `callback-worker up · OLLAMA_URL=${cfg.url} · model=${cfg.model} · heartbeat ${intervalMs / 1000}s`,
)
console.log('Stage 2: connectivity heartbeat only. Poll loop lands in Stage 4.')

await checkOllama()
setInterval(() => {
  void checkOllama()
}, intervalMs)
