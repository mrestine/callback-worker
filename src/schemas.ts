import { z } from 'zod'

/**
 * The two contracts of the ingestion pipeline.
 *
 *   raw email ──[clean]──▶ Normalized ──[extract, via model]──▶ Extraction
 *
 * `Normalized` is also what a live worker would POST to callback's /api/ingest.
 * `Extraction` is what the model must produce; it's fed to Ollama as a
 * JSON-schema `format` so decoding is constrained.
 *
 * Enums below MIRROR callback/src/schemas/index.ts. Keep them in sync (or extract
 * a shared package later).
 */

// --- enums shared with callback --------------------------------------
export const CONTACT_KINDS = ['friend', 'recruiter', 'hiring_mgr', 'referral', 'other'] as const
export const APPLICATION_STATUSES = [
  'lead',
  'applied',
  'screen',
  'onsite',
  'offer',
  'rejected',
  'withdrawn',
  'ghosted',
] as const
export const MANUAL_EVENT_TYPES = ['note', 'email', 'call', 'interview', 'applied', 'follow_up'] as const

// --- worker-only enum ----------------------------------------------
export const EMAIL_KINDS = [
  'rejection',
  'interview_invite',
  'interview_scheduled',
  'recruiter_outreach',
  'offer',
  'assessment_invite',
  'application_confirmation',
  'info_request',
  'status_update',
  'referral',
  'networking',
  'noise',
] as const

// --- Normalized: preprocess output --------------------------------
export const normalized = z.object({
  /** Gmail message id of the FORWARD, when known; '' in the harness. */
  source_message_id: z.string(),
  /** synthesised conversation key: lowercased orig sender + normalised subject */
  thread_key: z.string(),
  orig_subject: z.string(),
  orig_from: z.object({ name: z.string(), email: z.string() }),
  orig_to: z.object({ name: z.string(), email: z.string() }),
  /** the envelope From — always the operator, since every message the worker
   *  sees is a forward the operator sent (see PHASE-2-PLAN.md, "Intake model") */
  envelope_from: z.object({ name: z.string(), email: z.string() }),
  /** ISO 8601, or null if unparseable */
  orig_date: z.string().nullable(),
  cleaned_body: z.string(),
  /** true when no "Forwarded message" block was found and envelope headers were used */
  unwrap_fallback: z.boolean(),
  /** true when the forward's From: is the operator's own address (they forwarded
   *  their own sent reply, not an inbound email) — see clean.ts */
  self_authored: z.boolean(),
})
export type Normalized = z.infer<typeof normalized>

// --- Extraction: model output ------------------------------------
const confidence = z.number().min(0).max(1)

export const extraction = z
  .object({
    job_related: z.boolean(),
    email_kind: z.enum(EMAIL_KINDS),
    sender: z.object({
      name: z.string(),
      email: z.string(),
      /** the sender's own employer (agency or in-house); null if unclear */
      org: z.string().nullable(),
      is_agency_recruiter: z.boolean(),
      kind: z.enum(CONTACT_KINDS),
      confidence,
    }),
    hiring_company: z.object({
      /** the ACTUAL employer, or null */
      name: z.string().nullable(),
      /** true = a blind/confidential submission — employer deliberately not named */
      withheld: z.boolean(),
      confidence,
    }),
    role: z.object({
      title: z.string().nullable(),
      confidence,
    }),
    event: z.object({
      type: z.enum(MANUAL_EVENT_TYPES),
      /** free-text round detail, e.g. "Technical", "Hiring manager"; null if n/a */
      subtype: z.string().nullable(),
      /** ISO 8601 if a date/time is stated, else null */
      occurred_at: z.string().nullable(),
      summary: z.string(),
    }),
    /** an application status the email implies, or null */
    status_signal: z.enum(APPLICATION_STATUSES).nullable(),
    notes: z.string(),
  })
  .strict()
export type Extraction = z.infer<typeof extraction>
