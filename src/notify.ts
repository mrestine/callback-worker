/**
 * §8 digest reply. After each submission the worker replies in the forwarded
 * email's own thread with a plain-text summary, so the operator reviews from
 * their inbox instead of polling the webapp. callback stays email-free — this
 * is entirely the worker rendering the /api/inbound response.
 */
import type { Extraction } from './schemas.js'
import type { InboundResponse, ProposalOp } from './submit.js'

const OP_VERB: Record<string, string> = {
  create_company: 'create company',
  link_company: 'link company',
  create_application: 'create application',
  link_application: 'link application',
  create_contact: 'create contact',
  link_contact: 'link contact',
  add_event: 'log',
  set_status: 'set status',
}

function describeOp(op: ProposalOp): string {
  const a = op.args ?? {}
  switch (op.op) {
    case 'create_company':
      return `create company “${a.name ?? '?'}”`
    case 'create_application':
      return `create application “${a.role_title ?? '?'}” (${a.status ?? 'lead'})`
    case 'create_contact':
      return `create contact “${a.name ?? a.email ?? '?'}”`
    case 'link_company':
    case 'link_application':
    case 'link_contact': {
      const pick = op.match?.candidates.find((c) => c.id === op.match?.chosen)
      return pick ? `${OP_VERB[op.op]} → ${pick.label}` : `${OP_VERB[op.op]} (needs a pick)`
    }
    case 'add_event':
      return `log an event (${String(a.type ?? 'email')})`
    case 'set_status':
      return `set status → ${a.status ?? '?'}`
    default:
      return op.op
  }
}

const STATUS_LINE: Record<InboundResponse['status'], string> = {
  needs_review: 'Queued for your review.',
  needs_disambiguation: 'Queued — a match needs you to choose between candidates.',
  dismissed: 'Ignored as not job-related.',
  duplicate: 'Looks like a duplicate of an earlier message — nothing queued.',
}

export interface Digest {
  subject: string
  body: string
}

export function renderDigest(
  origSubject: string | null,
  resp: InboundResponse,
  ex: Extraction,
  summary: string | null,
): Digest {
  const L: string[] = []
  L.push(summary || ex.event.summary || '(no summary)')
  L.push('')

  L.push('What the model read:')
  L.push(`  • kind:    ${ex.email_kind}`)
  const company = ex.hiring_company.withheld ? '(withheld)' : ex.hiring_company.name
  if (company) L.push(`  • company: ${company}`)
  if (ex.role.title) L.push(`  • role:    ${ex.role.title}`)
  const sender = ex.sender.name || ex.sender.email
  if (sender) L.push(`  • sender:  ${sender}${ex.sender.is_agency_recruiter ? ' (agency recruiter)' : ''}`)
  L.push('')

  const ops = (resp.proposal ?? []).filter((o) => o.decision !== 'skip')
  if (ops.length) {
    L.push('Proposed changes:')
    for (const op of ops) L.push(`  • ${describeOp(op)}`)
    const skipped = (resp.proposal ?? []).filter((o) => o.decision === 'skip')
    for (const op of skipped) L.push(`  • (skipped) ${describeOp(op)}`)
    L.push('')
  }

  L.push(STATUS_LINE[resp.status] ?? resp.status)
  if (resp.status === 'needs_review' || resp.status === 'needs_disambiguation') {
    L.push('')
    L.push(`Review: ${resp.review_url}`)
  }
  L.push('')
  L.push('— callback-worker')

  return { subject: origSubject ?? 'job email', body: L.join('\n') }
}

/** Only send for actionable outcomes unless NOTIFY_ON_DISMISS is set. */
export function shouldNotify(resp: InboundResponse, notifyOnDismiss: boolean): boolean {
  if (resp.status === 'dismissed' || resp.status === 'duplicate') return notifyOnDismiss
  return true
}
