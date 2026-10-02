/**
 * Isolated test of the fetch mechanics only - no Ollama, no summarization,
 * no pipeline wiring. Just: does a company name in get real search results
 * back out.
 *
 *   npm run lookup-company -- "Ridgeline"
 */
import { config } from 'dotenv'
import { searchCompany } from '../serper.js'
import { positionalArg } from './io.js'

config({ path: ['.env', '.env.local'], quiet: true })

const name = positionalArg()
if (!name) {
  console.error('usage: npm run lookup-company -- "Company Name"')
  process.exit(1)
}

const apiKey = process.env.SERPER_API_KEY ?? ''
const results = await searchCompany(name, apiKey)

if (results.length === 0) {
  console.log('(no results)')
} else {
  for (const [i, r] of results.entries()) {
    console.log(`${i + 1}. ${r.title}`)
    console.log(`   ${r.link}`)
    console.log(`   ${r.snippet}`)
    console.log()
  }
}
