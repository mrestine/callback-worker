/**
 * Deterministic tests for the new-company description step: the orchestration
 * (addCompanyNotes) with fake lookup/describe, the lookup client and the search
 * with a stubbed fetch, and the digest reply that shows the result. No network,
 * database or model.
 *
 *   npm run test:company-notes
 */
import { addCompanyNotes } from '../companyNotes.js'
import type { CompanyNotesDeps, OutgoingExtraction } from '../companyNotes.js'
import type { Extraction } from '../schemas.js'
import { renderDigest } from '../notify.js'
import { mergeResults, searchCompany } from '../serper.js'
import { lookupCompanies } from '../submit.js'

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`)
  if (!cond) {
    failures++
    if (detail !== undefined) console.log('       ', JSON.stringify(detail))
  }
}

/** Run fn with the step's own progress logging muted. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const [log, warn] = [console.log, console.warn]
  console.log = () => {}
  console.warn = () => {}
  try {
    return await fn()
  } finally {
    console.log = log
    console.warn = warn
  }
}

function company(name: string | null, withheld = false) {
  return { name, withheld, confidence: 0.9 }
}

function extraction(over: Partial<Extraction> = {}): Extraction {
  return {
    job_related: true,
    email_kind: 'recruiter_outreach',
    sender: { name: 'Pat', email: 'pat@mail.example', org: null, is_agency_recruiter: false, kind: 'recruiter', confidence: 0.9 },
    hiring_company: company('Acme'),
    role: { title: 'Staff Engineer', confidence: 0.9 },
    additional_opportunities: [],
    event: { type: 'email', subtype: null, occurred_at: null, summary: 'Intro.' },
    status_signal: null,
    notes: 'Recruiter reached out.',
    ...over,
  }
}

/** Fake deps that record every call. `existing` = names callback already has. */
function fakeDeps(existing: string[], descriptions: Record<string, string> = {}) {
  const calls = { lookup: [] as string[][], describe: [] as [string, string | undefined][] }
  const deps: CompanyNotesDeps = {
    async lookup(names) {
      calls.lookup.push(names)
      return names.map((name) => ({ name, exists: existing.map((e) => e.toLowerCase()).includes(name.toLowerCase()) }))
    },
    async describe(name, context) {
      calls.describe.push([name, context])
      return descriptions[name] ?? ''
    },
  }
  return { deps, calls }
}

async function scenarioOrchestration() {
  console.log('\n# addCompanyNotes: who gets described')

  // a company callback already has is left alone
  {
    const { deps, calls } = fakeDeps(['Acme'], { Acme: 'should not be used' })
    const out = await quiet(() => addCompanyNotes(extraction(), deps))
    check('existing company -> never described', calls.describe.length === 0, calls)
    check('existing company -> no notes attached', !('notes' in out.hiring_company), out.hiring_company)
  }

  // a new company is described, with the role as context, and gets the notes
  {
    const { deps, calls } = fakeDeps([], { Acme: 'Acme builds anvils.' })
    const out = await quiet(() => addCompanyNotes(extraction(), deps))
    check('new company -> described once', calls.describe.length === 1 && calls.describe[0][0] === 'Acme', calls)
    check('...with the role it is being considered for as context', calls.describe[0][1] === 'applying for a Staff Engineer role', calls)
    check('...and the description lands on hiring_company.notes', out.hiring_company.notes === 'Acme builds anvils.', out.hiring_company)
  }

  // several companies: only the new one is described, each keeps its own notes
  {
    const ex = extraction({
      hiring_company: company('Acme'),
      additional_opportunities: [
        { hiring_company: company('Globex'), role: { title: 'Backend Engineer', confidence: 0.9 } },
        { hiring_company: company('Initech'), role: { title: null, confidence: 0.2 } },
      ],
    })
    const { deps, calls } = fakeDeps(['Globex'], { Acme: 'Acme text.', Initech: 'Initech text.' })
    const out = await quiet(() => addCompanyNotes(ex, deps))
    check('one lookup call carries every distinct name', calls.lookup.length === 1 && calls.lookup[0].join('|') === 'Acme|Globex|Initech', calls.lookup)
    check('only the new companies are described', calls.describe.map((d) => d[0]).join('|') === 'Acme|Initech', calls.describe)
    check('a role with no title -> no context', calls.describe[1][1] === undefined, calls.describe)
    check('each new company gets its own notes', out.hiring_company.notes === 'Acme text.' && out.additional_opportunities[1].hiring_company.notes === 'Initech text.', out)
    check('the existing one in between is untouched', !('notes' in out.additional_opportunities[0].hiring_company), out.additional_opportunities[0])
  }

  // the same company twice (two roles) is looked up and described once
  {
    const ex = extraction({
      hiring_company: company('Acme'),
      additional_opportunities: [{ hiring_company: company(' ACME '), role: { title: 'SRE', confidence: 0.9 } }],
    })
    const { deps, calls } = fakeDeps([], { Acme: 'Acme text.' })
    const out = await quiet(() => addCompanyNotes(ex, deps))
    check('same company by another spelling -> one lookup name', calls.lookup[0].length === 1, calls.lookup)
    check('...described once', calls.describe.length === 1, calls.describe)
    check('...and both slots carry the notes', out.hiring_company.notes === 'Acme text.' && out.additional_opportunities[0].hiring_company.notes === 'Acme text.', out)
  }

  // nothing to look up
  {
    const ex = extraction({ hiring_company: company(null, true), additional_opportunities: [{ hiring_company: company('Hidden', true), role: { title: null, confidence: 0.1 } }] })
    const { deps, calls } = fakeDeps([])
    const out = await quiet(() => addCompanyNotes(ex, deps))
    check('nameless and withheld companies -> no lookup at all', calls.lookup.length === 0 && calls.describe.length === 0, calls)
    check('...and the extraction comes back as it was', out === ex)
  }
}

async function scenarioFailures() {
  console.log('\n# addCompanyNotes: failures never cost the submission')

  {
    const ex = extraction()
    const calls: string[] = []
    const out = await quiet(() =>
      addCompanyNotes(ex, {
        lookup: async () => {
          throw new Error('callback unreachable')
        },
        describe: async (n) => (calls.push(n), 'x'),
      }),
    )
    check('lookup fails -> returned unchanged', out === ex)
    check('lookup fails -> no search is spent on a guess', calls.length === 0, calls)
  }

  {
    const { deps, calls } = fakeDeps([], { Acme: 'Acme text.' })
    const partial: CompanyNotesDeps = { ...deps, lookup: async () => [] } // callback gave no verdict
    const out = await quiet(() => addCompanyNotes(extraction(), partial))
    check('no verdict for a name -> skipped, not assumed new', calls.describe.length === 0 && !('notes' in out.hiring_company), { calls, out: out.hiring_company })
  }

  {
    const { deps } = fakeDeps([], {}) // describe returns ''
    const out = await quiet(() => addCompanyNotes(extraction(), deps))
    check('empty description -> no notes key at all (not an empty string)', !('notes' in out.hiring_company), out.hiring_company)
  }

  {
    const ex = extraction()
    const before = JSON.stringify(ex)
    const { deps } = fakeDeps([], { Acme: 'Acme text.' })
    await quiet(() => addCompanyNotes(ex, deps))
    check('the input extraction is never mutated', JSON.stringify(ex) === before)
  }

  {
    const out = await quiet(() =>
      addCompanyNotes(extraction(), {
        lookup: async (names) => names.map((name) => ({ name, exists: false })),
        describe: async () => {
          throw new Error('model down')
        },
      }),
    )
    check('describe throws -> returned unchanged', !('notes' in out.hiring_company), out.hiring_company)
  }
}

async function scenarioLookupClient() {
  console.log('\n# lookupCompanies: request and response handling (stubbed fetch)')
  const realFetch = globalThis.fetch
  let seen: { url: string; auth: string | undefined } = { url: '', auth: undefined }
  const stub = (status: number, body: unknown) => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.authorization }
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
    }) as typeof fetch
  }
  const cfg = { baseUrl: 'https://callback.example', token: 'cbk_test' }
  try {
    stub(200, {
      results: [
        { name: 'AT&T Inc', exists: true, match: { id: 1, label: 'AT&T', score: 0.7 } },
        { name: 'Acme', exists: false, match: null },
        { nonsense: true },
        { name: 'No verdict' },
      ],
    })
    const got = await lookupCompanies(cfg, ['AT&T Inc', 'Acme'])
    const params = new URL(seen.url).searchParams
    check('calls GET /api/companies on the configured base URL', seen.url.startsWith('https://callback.example/api/companies?'), seen.url)
    check('repeats ?match= once per name, encoded', params.getAll('match').join('|') === 'AT&T Inc|Acme' && seen.url.includes('AT%26T'), seen.url)
    check('sends the bearer token', seen.auth === 'Bearer cbk_test', seen.auth)
    check('returns name + exists per result and drops malformed entries', JSON.stringify(got) === JSON.stringify([{ name: 'AT&T Inc', exists: true }, { name: 'Acme', exists: false }]), got)

    stub(401, { error: 'invalid or missing bearer token' })
    let threw = ''
    try {
      await lookupCompanies(cfg, ['Acme'])
    } catch (err) {
      threw = (err as Error).message
    }
    check('a non-2xx response throws (with the status)', threw.includes('401'), threw)
  } finally {
    globalThis.fetch = realFetch
  }
}

async function scenarioSearch() {
  console.log('\n# searchCompany: two searches, merged (stubbed fetch)')
  const r = (id: string, link = `https://${id}.example/`) => ({ title: `T ${id}`, link, snippet: `S ${id}` })

  const merged = mergeResults([
    [r('a1'), r('a2'), r('a3')],
    [r('b1'), r('dup', 'https://a2.example'), r('b3')], // same page as a2, trailing slash aside
  ])
  check('interleaves best-first and drops a page seen twice', merged.map((x) => x.snippet).join(',') === 'S a1,S b1,S a2,S a3,S b3', merged.map((x) => x.snippet))

  const realFetch = globalThis.fetch
  const queries: string[] = []
  let keySent: string | undefined
  const stub = (respond: (q: string) => Response) => {
    queries.length = 0
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const q = (JSON.parse(String(init?.body)) as { q: string }).q
      queries.push(q)
      keySent = (init?.headers as Record<string, string>)['X-API-KEY']
      return respond(q)
    }) as typeof fetch
  }
  const organic = (id: string) => new Response(JSON.stringify({ organic: [{ title: `T ${id}`, link: `https://${id}.example/`, snippet: `S ${id}` }] }))
  try {
    stub((q) => organic(q.endsWith('company') ? 'about' : 'facts'))
    const got = await searchCompany('Acme', 'key123')
    check('asks for what the company does AND for its facts', queries.includes('Acme company') && queries.includes('Acme funding employees founded'), queries)
    check('sends the API key', keySent === 'key123', keySent)
    check('returns the merged results of both', got.map((x) => x.snippet).sort().join(',') === 'S about,S facts', got)

    stub((q) => (q.endsWith('company') ? new Response('boom', { status: 500 }) : organic('facts')))
    const partial = await searchCompany('Acme', 'k')
    check('one search failing -> the other one still answers', partial.length === 1 && partial[0].snippet === 'S facts', partial)

    stub(() => new Response('boom', { status: 500 }))
    let threw = ''
    try {
      await searchCompany('Acme', 'k')
    } catch (err) {
      threw = (err as Error).message
    }
    check('both failing -> throws', threw.includes('500'), threw)

    stub(() => organic('x')) // resets the request recorder
    let noKey = ''
    try {
      await searchCompany('Acme', '')
    } catch (err) {
      noKey = (err as Error).message
    }
    check('no API key -> throws before any request is made', noKey.includes('SERPER_API_KEY') && queries.length === 0, { noKey, queries })
  } finally {
    globalThis.fetch = realFetch
  }
}

async function scenarioDigest() {
  console.log('\n# digest reply: shows the company notes')
  const resp = { status: 'needs_review' as const, review_url: 'https://callback.example/review/7', proposal: [] }
  const withNotes = (over: Partial<OutgoingExtraction>): OutgoingExtraction => ({ ...extraction(), ...over }) as OutgoingExtraction

  const one = renderDigest(
    'Thanks for applying',
    resp,
    withNotes({ hiring_company: { ...company('Acme'), notes: 'Acme makes anvils.\n\n  Founded in 2019.' } }),
    's',
  )
  const lines = one.body.split('\n')
  const at = lines.findIndex((l) => l.includes('company: Acme'))
  check('the notes appear as a line right after the company', lines[at + 1] === '  • notes:   Acme makes anvils. Founded in 2019.', lines.slice(at, at + 3))
  check('line breaks in the description are collapsed onto one line', !one.body.includes('anvils.\n'), one.body)
  check('the rest of the digest is intact (review link still there)', one.body.includes('Review: https://callback.example/review/7'))

  const none = renderDigest('Thanks for applying', resp, extraction(), 's')
  check('no notes -> no notes line at all', !none.body.includes('notes:'), none.body)

  const several = renderDigest(
    'Roles',
    resp,
    withNotes({
      hiring_company: company('Acme'),
      additional_opportunities: [
        { hiring_company: { ...company('Globex'), notes: 'Globex does logistics.' }, role: { title: 'SRE', confidence: 0.9 } },
        { hiring_company: company('Initech'), role: { title: 'Dev', confidence: 0.9 } },
      ],
    }),
    's',
  )
  const sl = several.body.split('\n')
  const g = sl.findIndex((l) => l.includes('SRE @ Globex'))
  check("an additional company's notes sit under its own role line", sl[g + 1] === '        Globex does logistics.' && sl[g + 2].includes('Dev @ Initech'), sl.slice(g, g + 3))
  check('...and a company without notes gets none', !sl[g + 3]?.trim().startsWith('Initech'), sl.slice(g, g + 4))
}

await scenarioOrchestration()
await scenarioFailures()
await scenarioLookupClient()
await scenarioSearch()
await scenarioDigest()

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
