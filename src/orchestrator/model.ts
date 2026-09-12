/**
 * Shared types for the discharge-readiness orchestrator.
 *
 * This is the meeting point for all workstreams (detectors, resolvers/verifiers,
 * UI, demo scripting) — change it by agreement, everything depends on it.
 *
 * Core rules (see discharge-orchestrator-brief.md):
 * - Orchestration state lives HERE, app-side, keyed by sim resourceId.
 *   The sim is the system of record for clinical facts only.
 * - A verifier only ever checks the resource its resolver created.
 * - clinical_hold and blocked_human are terminal for automation; only a
 *   human can move them.
 */
import type { SimClient } from '../sim/index.ts'
import type { TraceEntry } from '../sim/http.ts'

export type ItemState =
  | 'proposed' // barrier identified, action proposed — awaiting staff approval
  | 'approved' // staff approved the operational plan; agent may act
  | 'resolving'
  | 'awaiting_verification'
  | 'verified'
  | 'clinical_hold' // clinician must clear in the UI; no resolver exists
  | 'blocked_human' // external decision (e.g. funding); agent hands over
  | 'failed' // resolver or verifier errored; shown red with the error

export type OwnerSite =
  | 'gp'
  | 'hospital'
  | 'community'
  | 'pharmacy'
  | 'diagnostics'
  | 'wearables'
  | 'clinician' // clinical_hold items — owned by a person, not a service

/** A quoted piece of record evidence justifying a checklist item. */
export interface Evidence {
  /** Sim resource the quote comes from (id in the owning site's view). */
  resourceId: string
  site: OwnerSite | 'patient-directory'
  /** Verbatim or lightly trimmed text shown to the user. */
  quote: string
  /** Sim-time ms the underlying record was created — lets the UI say "3 days waiting". */
  raisedAt?: number
}

/** What a resolver did, kept for the audit trail and for the verifier. */
export interface Resolution {
  action: string
  /** Resource the resolver created or mutated — the ONLY thing verify checks. */
  resourceId: string
  /** Secondary resources (e.g. the FBC order beside the U&E); verified too. */
  alsoResourceIds?: string[]
  idempotencyKey: string
  atSimTime: number
}

export interface Verification {
  passed: boolean
  /** What we observed on the resolver-created resource. */
  observed: string
  atSimTime: number
}

export interface ChecklistItem {
  /** Stable slug, e.g. 'amira-medicines'. Used in idempotency keys. */
  id: string
  patientId: string
  title: string
  owner: OwnerSite
  state: ItemState
  evidence: Evidence[]
  /** What the agent will do if approved — shown at the approval step. */
  proposedAction?: string
  /**
   * The concrete steps the resolver will take, then the check the verifier
   * will make, in order — what staff review before approving. Written by
   * resolve.ts so the plan is the code's own description of itself.
   */
  plan?: string[]
  approval?: { by: string; at: number }
  /** Resolver attempts so far; feeds the idempotency key so retries get fresh keys. */
  attempts?: number
  resolution?: Resolution
  verification?: Verification
  /** For clinical_hold / blocked_human: why automation must stop. */
  humanReason?: string
  /** Summary items on blocked patients: save the draft but never send it. */
  draftOnly?: boolean
  /** Whether model output on this item came from the live model or the canned fallback. */
  generated?: 'model' | 'fallback'
  /** Prepared handover for a blocked_human item; the case STAYS blocked. */
  escalation?: { responsibleTeam: string; nextAction: string; note: string; source?: 'model' | 'fallback' }
  error?: string
}

/** A short fact for the patient banner: "eGFR 49 mL/min", "Home access not confirmed". */
export interface PatientFact {
  label: string
  value: string
  /** Out of range or a risk — shown in the alert colour. */
  bad?: boolean
  /** Where it was read from, e.g. "diagnostics · U&E report r-12". */
  source: string
}

/** Record facts read once at load time for the banner and the "own words" card. */
export interface PatientProfile {
  birthDate?: string
  /** Named clinician on the hospital attendance, if assigned. */
  clinician?: string
  /** Author of the most recent GP encounter note, if any. */
  gp?: string
  allergies: string[]
  /** Active problems on the GP record. */
  problems: string[]
  /** The patient's own words from the GP "personal context" observation. */
  ownWords?: { text: string; goal?: string; resourceId: string }
  facts: PatientFact[]
  /** Prescriptions visible to pharmacy for this patient. */
  prescriptions: Array<{ id: string; drug: string; status: string }>
}

export interface PatientRow {
  patientId: string
  name: string
  conditions: string[]
  needs: string[]
  goals: string[]
  profile?: PatientProfile
  /** Non-blocking observations from the model's reading of the record. */
  insights?: Array<{ title: string; quote: string }>
  /** hospital attendance stage: waiting | assessing | take | inpatient | discharged */
  stage?: string
  location?: string
  items: ChecklistItem[]
}

/** Whole-run state the UI polls and the demo script drives. */
export interface BoardState {
  world: string
  simNow: number
  patients: PatientRow[]
  /** Human-readable audit log, newest last. */
  log: string[]
  /** What the runner is doing right now, shown by the UI. */
  phase?: string
  /** True while the runner is actively calling the simulator or the model. */
  busy?: boolean
  /** Every simulator request this run made — the compliance record. */
  trace?: TraceEntry[]
}

export interface OrchestratorContext {
  sim: SimClient
  world: string
  board: BoardState
  log(message: string): void
}

/** Item is done for automation purposes (green or handed to a human). */
export function isSettled(item: ChecklistItem): boolean {
  return item.state === 'verified' || item.state === 'clinical_hold' || item.state === 'blocked_human'
}
