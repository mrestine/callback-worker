/**
 * Isolated test of the new-company description flow - no pipeline wiring.
 *
 *   npm run lookup-company -- "Ridgeline"                # raw search results only
 *   npm run lookup-company -- "Ridgeline" --summarize    # + the model's description
 *   npm run lookup-company -- "Ridgeline" --summarize --model llama3.2:3b
 */
import { config } from 'dotenv'
import { MAX_RESULTS, summarizeCompany, renderSearchResults } from '../companySummary.js'
import { modelConfigFromEnv } from '../model.js'
import { searchCompany } from '../serper.js'
import { flag, has, positionalArg } from './io.js'

config({ path: ['.env', '.env.local'], quiet: true })

const name = positionalArg()
if (!name) {
  console.error('usage: npm run lookup-company -- "Company Name" [--summarize] [--model <tag>]')
  process.exit(1)
}

const apiKey = process.env.SERPER_API_KEY ?? ''
const results = await searchCompany(name, apiKey)

if (results.length === 0) {
  console.log('(no results)')
  process.exit(0)
}

if (has('--summarize')) {
  console.log(`--- model input ---\n${renderSearchResults(name, results.slice(0, MAX_RESULTS), flag('--context'))}\n`)
  const cfg = modelConfigFromEnv({ model: flag('--model') })
  const started = Date.now()
  const { description, hq_location } = await summarizeCompany(name, results, cfg, flag('--context'))
  console.log(`--- description (${cfg.model}, ${Date.now() - started}ms) ---\n${description || '(empty)'}`)
  console.log(`--- headquarters ---\n${hq_location || '(none)'}`)
} else {
  for (const [i, r] of results.entries()) {
    console.log(`${i + 1}. ${r.title}`)
    console.log(`   ${r.link}`)
    console.log(`   ${r.snippet}`)
    console.log()
  }
}
