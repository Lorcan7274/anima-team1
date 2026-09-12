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
}

/** What a resolver did, kept for the audit trail and for the verifier. */
export interface Resolution {
  action: string
  /** Resource the resolver created or mutated — the ONLY thing verify checks. */
  resourceId: string
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
  approval?: { by: string; at: number }
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

export interface PatientRow {
  patientId: string
  name: string
  conditions: string[]
  needs: string[]
  goals: string[]
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
