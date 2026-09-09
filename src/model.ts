/**
 * Minimal Ollama client. Chat with a JSON-schema `format` so decoding is
 * grammar-constrained — the model physically cannot emit prose or malformed
 * JSON. `temperature: 0` for determinism.
 */

export interface ModelConfig {
  url: string
  model: string
  numPredict: number
}

export function modelConfigFromEnv(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    url: overrides.url ?? process.env.OLLAMA_URL ?? 'http://localhost:11434',
    model: overrides.model ?? process.env.OLLAMA_MODEL ?? 'qwen2.5:7b-instruct',
    numPredict: overrides.numPredict ?? (Number(process.env.NUM_PREDICT) || 512),
  }
}

export interface ChatResult {
  raw: string
  json: unknown
  meta: {
    model: string
    total_ms: number
    eval_count?: number
  }
}

export async function chatJson(
  cfg: ModelConfig,
  system: string,
  user: string,
  jsonSchema: object,
): Promise<ChatResult> {
  const started = Date.now()
  const res = await fetch(`${cfg.url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      stream: false,
      format: jsonSchema,
      options: { temperature: 0, num_predict: cfg.numPredict },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  })

  if (!res.ok) {
    throw new Error(`Ollama ${res.status} ${res.statusText}: ${await res.text().catch(() => '')}`)
  }

  const data = (await res.json()) as {
    model: string
    message: { content: string }
    eval_count?: number
  }
  const raw = data.message?.content ?? ''

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new Error(`model did not return JSON: ${(err as Error).message}\n---\n${raw}`)
  }

  return {
    raw,
    json,
    meta: { model: data.model, total_ms: Date.now() - started, eval_count: data.eval_count },
  }
}
