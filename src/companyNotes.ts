/**
 * Attach a short description to each company in an extraction that callback
 * doesn't know yet, as `hiring_company.notes` (callback stores it as the new
 * company's notes when the proposal is accepted).
 *
 *   extraction -> ask callback which companies exist -> for each NEW one:
 *   search + summarize (companySummary.ts) -> notes on that company
 *
 * "New" is callback's call, not ours: its lookup returns the same verdict its
 * inbound matching acts on, so a company gets a description exactly when
 * callback will propose creating it. This file holds no threshold.
 *
 * The notes go on a COPY made after extraction. They must never become part
 * of the `Extraction` schema: that schema is handed to Ollama as the output
 * format, and the model would start generating them.
 *
 * Best-effort end to end. Any failure leaves the extraction exactly as it was;
 * a missing description must never cost a submission.
 */
import type { CompanyProfile } from './companySummary.js'
import type { Extraction } from './schemas.js'

type Company = Extraction['hiring_company']
type Opportunity = Extraction['additional_opportunities'][number]

export type OutgoingCompany = Company & { notes?: string; hq_location?: string }

/** What is POSTed to callback: an Extraction whose companies may carry notes. */
export type OutgoingExtraction = Omit<Extraction, 'hiring_company' | 'additional_opportunities'> & {
  hiring_company: OutgoingCompany
  additional_opportunities: (Omit<Opportunity, 'hiring_company'> & { hiring_company: OutgoingCompany })[]
}

export interface CompanyNotesDeps {
  /** which of these names does callback already have */
  lookup(names: string[]): Promise<{ name: string; exists: boolean }[]>
  /** a few plain sentences about a company and where it is headquartered ('' for whatever could not be found) */
  describe(name: string, context?: string): Promise<CompanyProfile>
}

const key = (name: string) => name.trim().toLowerCase()

export async function addCompanyNotes(ex: Extraction, deps: CompanyNotesDeps): Promise<OutgoingExtraction> {
  try {
    return await attach(ex, deps)
  } catch (err) {
    console.warn(`[companyNotes] skipped: ${(err as Error).message}`)
    return ex
  }
}

async function attach(ex: Extraction, deps: CompanyNotesDeps): Promise<OutgoingExtraction> {
  // every company in the email: the primary one, then any additional
  // opportunities, each with the role it is being considered for
  const slots = [
    { company: ex.hiring_company, role: ex.role },
    ...ex.additional_opportunities.map((o) => ({ company: o.hiring_company, role: o.role })),
  ]

  // one entry per distinct company; nameless and withheld ones aren't looked up
  const names = new Map<string, string>()
  for (const { company } of slots) {
    const name = company.name?.trim()
    if (name && !company.withheld && !names.has(key(name))) names.set(key(name), name)
  }
  if (names.size === 0) return ex

  // a name callback gave no verdict for is skipped, not assumed new
  const isNew = new Set<string>()
  for (const r of await deps.lookup([...names.values()])) {
    if (r.exists === false) isNew.add(key(r.name))
    else console.log(`[companyNotes] "${r.name}": already in the tracker`)
  }

  // describe each new company once, using the first role it appears with
  const profiles = new Map<string, CompanyProfile>()
  for (const { company, role } of slots) {
    const name = company.name?.trim()
    if (!name || company.withheld || !isNew.has(key(name)) || profiles.has(key(name))) continue
    const context = role.title ? `applying for a ${role.title} role` : undefined
    const found = await deps.describe(name, context)
    if (found.raw) {
      const r = found.raw
      console.log(
        `[companyNotes] "${name}": model said founded=${JSON.stringify(r.founded)} headcount=${JSON.stringify(r.headcount)} ` +
          `funding=${JSON.stringify(r.latest_funding)} hq=${JSON.stringify(r.hq_location)} (same business: ${r.sameBusiness})`,
      )
    }
    const profile = { description: found.description.trim(), hq_location: found.hq_location.trim() }
    profiles.set(key(name), profile)
    console.log(
      `[companyNotes] "${name}": new, ${profile.description ? `described (${profile.description.length} chars)` : 'no description found'}, ` +
        `hq ${profile.hq_location || 'not found'}`,
    )
  }

  const withNotes = (c: Company): OutgoingCompany => {
    const p = c.name && !c.withheld ? profiles.get(key(c.name)) : undefined
    if (!p) return c
    return {
      ...c,
      ...(p.description ? { notes: p.description } : {}),
      ...(p.hq_location ? { hq_location: p.hq_location } : {}),
    }
  }
  return {
    ...ex,
    hiring_company: withNotes(ex.hiring_company),
    additional_opportunities: ex.additional_opportunities.map((o) => ({
      ...o,
      hiring_company: withNotes(o.hiring_company),
    })),
  }
}
