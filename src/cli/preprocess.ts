/**
 * .eml (or Gmail `{raw}` JSON) -> normalized JSON on stdout.
 *
 *   npm run preprocess -- fixtures/private/foo.eml
 *   npm run preprocess -- fixtures/private/foo.eml > foo.norm.json
 *   cat foo.eml | npm run preprocess
 */
import { clean } from '../clean.js'
import { positionalArg, readInput, toEml } from './io.js'

const norm = await clean(toEml(await readInput(positionalArg())))
process.stdout.write(JSON.stringify(norm, null, 2) + '\n')
