/**
 * Checks for the operator-note step that need no model and no network:
 * capturing the note in clean(), the guards on what the model picked, the
 * leftover-notes logic, and the failure behaviour. (What the model picks from
 * real-looking notes is `npm run eval:note`.)
 *
 *   npm run test:operator-note
 */
import { clean } from '../clean.js'
import type { OutgoingExtraction } from '../companyNotes.js'
import { addOperatorNote, groundedRemote, groundedSalary, groundedUrl, guardPicks, leftoverNotes, urlsIn } from '../operatorNote.js'

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`)
  if (!cond) {
    failures++
    if (detail !== undefined) console.log('       ', JSON.stringify(detail))
  }
}

const eml = (body: string) =>
  [
    'From: Matt <matt@mail.example>',
    'To: fred+callback@mail.example',
    'Subject: Fwd: Thanks for applying',
    'Message-ID: <abc@mail.example>',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n')

const FORWARD = [
  '---------- Forwarded message ---------',
  'From: Jo Park <jo@acme.example>',
  'Date: Wed, Sep 9, 2026 at 1:47 PM',
  'Subject: Thanks for applying',
  'To: Matt <matt@mail.example>',
  '',
  'Hello Matthew, we received your application.',
].join('\n')

async function scenarioClean() {
  console.log('\n# clean(): the note above the forward')
  const withNote = await clean(eml('https://jobs.example/acme/123 $180-200k remote\nasked Sam for a referral\n\n' + FORWARD))
  check('the note is captured', withNote.operator_note === 'https://jobs.example/acme/123 $180-200k remote\nasked Sam for a referral', withNote.operator_note)
  check('...and is not part of the cleaned body', !withNote.cleaned_body.includes('180') && withNote.cleaned_body.startsWith('Hello Matthew'), withNote.cleaned_body)
  check('the original sender still comes from the forward block', withNote.orig_from.email === 'jo@acme.example', withNote.orig_from)

  const without = await clean(eml(FORWARD))
  check('no note -> empty', without.operator_note === '', without.operator_note)
  check('...and the body is the same with or without a note', without.cleaned_body === withNote.cleaned_body)

  const signed = await clean(eml('the link is https://jobs.example/1\n\n-- \nMatt Restine\n\n' + FORWARD))
  check('a mail signature is not part of the note', signed.operator_note === 'the link is https://jobs.example/1', signed.operator_note)

  const noForward = await clean(eml('just a message, no forward block'))
  check('no forward block -> no note', noForward.operator_note === '')
}

function scenarioGuards() {
  console.log('\n# guards on what the model picked')
  const note = 'JD: https://jobs.example/acme/123.\ncomp 180-200k base, fully remote'
  check('urlsIn drops sentence punctuation', urlsIn(note).join() === 'https://jobs.example/acme/123', urlsIn(note))
  check('a link that is in the note is kept', groundedUrl('https://jobs.example/acme/123', note) === 'https://jobs.example/acme/123')
  check('...even with a trailing slash or different case', groundedUrl('HTTPS://jobs.example/acme/123/', note) === 'https://jobs.example/acme/123')
  check('a link that is not in the note is dropped', groundedUrl('https://jobs.example/acme/999', note) === '')
  check('an empty link stays empty', groundedUrl('', note) === '')

  check('a pay figure whose numbers are in the note is kept', groundedSalary('180-200k', note) === '180-200k')
  check('...reformatted, if the numbers are the same', groundedSalary('$180k - $200k', note) === '$180k - $200k')
  check('an invented number is dropped', groundedSalary('180-250k', note) === '')
  check('text with no number is dropped', groundedSalary('competitive', note) === '')

  check('remote is kept when the note says so', groundedRemote('remote', note) === 'remote')
  check('hybrid needs the word hybrid', groundedRemote('hybrid', note) === undefined && groundedRemote('hybrid', 'two days in office, hybrid') === 'hybrid')
  check('onsite accepts on-site / in office', groundedRemote('onsite', 'on-site in Austin') === 'onsite' && groundedRemote('onsite', 'in office three days') === 'onsite')
  check('an unknown mode is ignored', groundedRemote('anywhere', note) === undefined && groundedRemote('', note) === undefined)
}

function scenarioLeftover() {
  console.log('\n# leftover notes: the note minus what was taken out')
  const url = 'https://a.example/j'
  check('lines that were only a value (and a label) vanish', leftoverNotes(`JD: ${url}\nsalary 180-200k\nreferral from Sam`, [url, '180-200k']) === 'referral from Sam')
  check('a value in the middle of a line leaves the rest', leftoverNotes('Looks good, 180-200k base', ['180-200k']) === 'Looks good, base')
  check('the word that introduced a value goes with it', leftoverNotes('pays 130-150k. ask about equity', ['130-150k']) === 'ask about equity', leftoverNotes('pays 130-150k. ask about equity', ['130-150k']))
  check('a label before a link goes with it, even on another line', leftoverNotes(`https://b.example/x\nposting: ${url}`, [url]) === 'https://b.example/x', leftoverNotes(`https://b.example/x\nposting: ${url}`, [url]))
  check('"comp is <figure>" leaves nothing behind', leftoverNotes('comp is 160 to 190 base plus equity', ['160 to 190 base plus equity']) === '')
  check('a line that only restates the work mode is dropped', leftoverNotes('Remote\nask about equity', [], 'remote') === 'ask about equity' && leftoverNotes('150k, remote ok', ['150k'], 'remote') === '')
  check('...but a line with more to say keeps it', leftoverNotes('hybrid, 3 days in Chicago', [], 'hybrid') === 'hybrid, 3 days in Chicago')
  check('without a work mode captured, the word stays', leftoverNotes('Remote', []) === 'Remote')
  check('everything taken -> empty', leftoverNotes(url, [url]) === '')
  check('nothing taken -> the note, untouched', leftoverNotes('ask about equity\nsecond line', []) === 'ask about equity\nsecond line')
  check('blank-line runs are collapsed', leftoverNotes(`one\n\n\n\n${url}\n\ntwo`, [url]) === 'one\n\ntwo')

  const all = guardPicks('JD: https://a.example/j\n180-200k, hybrid\nfriend of Sam', { jd_url: 'https://a.example/j', salary_range: '180-200k', remote: 'hybrid' })
  check('guardPicks puts it together', all.jd_url === 'https://a.example/j' && all.salary_range === '180-200k' && all.remote === 'hybrid' && all.notes === 'friend of Sam', all)
  const bad = guardPicks('call Sam about it', { jd_url: 'https://made.up/x', salary_range: '999k', remote: 'remote' })
  check('invented values are all dropped and the whole note is kept', !bad.jd_url && !bad.salary_range && !bad.remote && bad.notes === 'call Sam about it', bad)
}

async function scenarioAdd() {
  console.log('\n# addOperatorNote: attach, and never get in the way')
  const base = { email_kind: 'application_confirmation' } as unknown as OutgoingExtraction
  const cfg = { url: 'http://unused', model: 'unused', numPredict: 1 }

  let calls = 0
  const none = await addOperatorNote(base, '   ', cfg, async () => (calls++, {}))
  check('an empty note -> unchanged, and no model call', none === base && calls === 0)

  const found = await addOperatorNote(base, 'x', cfg, async () => ({ jd_url: 'https://a.example/j', notes: 'hi' }))
  check('details are attached as operator_note', found.operator_note?.jd_url === 'https://a.example/j' && found.operator_note.notes === 'hi', found)
  check('...without touching the extraction itself', found.email_kind === 'application_confirmation')

  const empty = await addOperatorNote(base, 'x', cfg, async () => ({}))
  check('a parse that finds nothing -> unchanged', empty === base)

  const orig = console.warn
  console.warn = () => {}
  try {
    const failed = await addOperatorNote(base, 'call Sam first', cfg, async () => {
      throw new Error('model down')
    })
    check('the model failing -> the whole note becomes the notes', failed.operator_note?.notes === 'call Sam first', failed)
  } finally {
    console.warn = orig
  }
}

await scenarioClean()
scenarioGuards()
scenarioLeftover()
await scenarioAdd()

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
