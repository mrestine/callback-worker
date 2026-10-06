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

/**
 * Two searches, because no single query returns both halves of a description.
 * "<name> company" gets the company's own pages (what it does), which say
 * nothing about age, size or funding; those live on other sites (Crunchbase,
 * LinkedIn, Forbes, BuiltIn...) and only surface for a query that asks for them.
 */
const queriesFor = (name: string) => [`${name} company`, `${name} headquarters funding employees founded`]

async function search(q: string, apiKey: string): Promise<SearchResult[]> {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ q }),
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

/**
 * Best result of each list first, then the second best of each, and so on,
 * dropping a page already seen. Taking the top N of this gives the model the
 * best hits of every query instead of all of one query's.
 */
export function mergeResults(lists: SearchResult[][]): SearchResult[] {
  const seen = new Set<string>()
  const out: SearchResult[] = []
  const longest = Math.max(0, ...lists.map((l) => l.length))
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const r = list[i]
      const id = r?.link.replace(/\/$/, '')
      if (r && id && !seen.has(id)) {
        seen.add(id)
        out.push(r)
      }
    }
  }
  return out
}

/**
 * Search for a company by name. If one of the two searches fails the other's
 * results are still returned; it only throws when both do.
 */
export async function searchCompany(name: string, apiKey: string): Promise<SearchResult[]> {
  if (!apiKey) throw new SerperError('SERPER_API_KEY is not set')

  const settled = await Promise.allSettled(queriesFor(name).map((q) => search(q, apiKey)))
  const lists = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []))
  if (lists.length === 0) {
    const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected')
    throw failed?.reason ?? new SerperError('search failed')
  }
  return mergeResults(lists)
}
