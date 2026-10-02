/**
 * Minimal Serper.dev client - plain web search, no summarization. Mirrors
 * model.ts's shape (one fetch, typed response, no retry/caching) since this
 * is exactly as narrow a tool: given a company name, return raw search
 * result snippets. What to do with them (summarize, decide relevance) is
 * someone else's job - this file doesn't know about Ollama or the
 * extraction pipeline at all.
 */

export interface SearchResult {
  title: string
  link: string
  snippet: string
}

export class SerperError extends Error {}

/** `${name} company` biases toward the company's own site / news coverage
 *  over an unrelated common-word match. */
export async function searchCompany(name: string, apiKey: string): Promise<SearchResult[]> {
  if (!apiKey) throw new SerperError('SERPER_API_KEY is not set')

  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ q: `${name} company` }),
  })

  if (!res.ok) {
    throw new SerperError(`Serper ${res.status} ${res.statusText}: ${await res.text().catch(() => '')}`)
  }

  const data = (await res.json()) as {
    organic?: { title?: string; link?: string; snippet?: string }[]
  }
  return (data.organic ?? [])
    .filter((r) => r.title && r.link && r.snippet)
    .map((r) => ({ title: r.title!, link: r.link!, snippet: r.snippet! }))
}
