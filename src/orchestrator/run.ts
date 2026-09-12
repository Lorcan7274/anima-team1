/**
 * The orchestrator loop: detect -> resolve unsettled items -> advance the
 * clock -> verify against resolver-created resources -> repeat.
 *
 * Re-run safety comes from state, not idempotency keys: settled items are
 * never re-resolved, and detection merges into existing board state.
 */
import type { BoardState, ChecklistItem, OrchestratorContext, PatientRow } from './model.ts'
import { isSettled } from './model.ts'
import { detectForPatient, loadPatientRow } from './detect.ts'
import { planFor, resolverFor } from './resolve.ts'
import { verifierFor } from './verify.ts'
import type { SimClient } from '../sim/index.ts'
import { randomBytes } from 'node:crypto'

/** Short random id for this process; see the idempotency key in resolve.ts. */
export function newRunId(): string {
  return randomBytes(3).toString('hex')
}

export async function buildBoard(sim: SimClient, world: string, patientIds: string[]): Promise<BoardState> {
  const board: BoardState = { world, runId: newRunId(), simNow: 0, patients: [], log: [] }
  for (const id of patientIds) {
    const row = await loadPatientRow(sim, id)
    board.patients.push(row)
  }
  board.simNow = Number((await sim.clock()).now)
  return board
}

/** Detect for every patient, merging so existing item state survives re-runs. */
export async function detectAll(ctx: OrchestratorContext): Promise<void> {
  for (const row of ctx.board.patients) {
    const fresh = await detectForPatient(ctx.sim, row, ctx.log)
    for (const item of fresh) {
      const existing = row.items.find((i) => i.id === item.id)
      if (!existing) {
        item.plan = planFor(item)
        row.items.push(item)
        ctx.log(`detected [${item.owner}] ${item.title} (${item.patientId})`)
      }
    }
  }
}

async function resolveItem(ctx: OrchestratorContext, item: ChecklistItem): Promise<void> {
  const resolver = resolverFor(item)
  if (!resolver) return // clinical_hold / blocked_human / unknown: nothing to do
  item.state = 'resolving'
  item.attempts = (item.attempts ?? 0) + 1
  try {
    item.resolution = await resolver(ctx, item)
    item.state = 'awaiting_verification'
    ctx.log(`resolved ${item.id} via ${item.resolution.action} -> ${item.resolution.resourceId}`)
  } catch (err) {
    item.state = 'failed'
    item.error = String((err as Error).message ?? err)
    ctx.log(`FAILED ${item.id}: ${item.error}`)
  }
}

async function verifyItem(ctx: OrchestratorContext, item: ChecklistItem): Promise<void> {
  const verifier = verifierFor(item)
  if (!verifier || !item.resolution) return
  const v = await verifier(ctx, item)
  item.verification = v
  if (v.passed) {
    item.state = 'verified'
    ctx.log(`VERIFIED ${item.id}: ${v.observed}`)
  } else {
    ctx.log(`not yet ${item.id}: ${v.observed}`)
  }
}

export interface RunOptions {
  /** Sim minutes to advance per round. 121 covers watch (+10), visit (~90), bloods (~120). */
  advanceMinutes?: number
  maxRounds?: number
}

/** Run rounds until everything is settled (or failed) or maxRounds is hit. */
export async function runUntilSettled(ctx: OrchestratorContext, opts: RunOptions = {}): Promise<void> {
  const advance = opts.advanceMinutes ?? 121
  const maxRounds = opts.maxRounds ?? 3
  for (let round = 1; round <= maxRounds; round++) {
    const open = ctx.board.patients.flatMap((p) => p.items).filter((i) => !isSettled(i) && i.state !== 'failed')
    if (open.length === 0) return
    if (open.every((i) => i.state === 'proposed')) {
      ctx.log('all open items await staff approval, not acting')
      return
    }
    ctx.log(`--- round ${round}: ${open.length} open item(s) ---`)
    ctx.board.phase = 'Executing approved actions in the simulator'
    ctx.board.busy = true
    for (const item of open.filter((i) => i.state === 'approved')) await resolveItem(ctx, item)
    ctx.log(`advancing clock ${advance} sim-minutes`)
    ctx.board.phase = `Advancing the sim clock ${advance} minutes`
    await ctx.sim.advanceClock(advance)
    ctx.board.simNow = Number((await ctx.sim.clock()).now)
    ctx.board.phase = 'Re-reading every service to verify outcomes'
    for (const item of open.filter((i) => i.state === 'awaiting_verification')) await verifyItem(ctx, item)
  }
  ctx.board.busy = false
}

/**
 * Staff approval of the operational coordination plan. Approves 'proposed'
 * items only, clinical holds and blocked_human items are untouchable here.
 */
export function approveAll(board: BoardState, approver: string, patientId?: string): number {
  let count = 0
  for (const p of board.patients) {
    if (patientId && p.patientId !== patientId) continue
    for (const item of p.items) {
      if (item.state === 'proposed') {
        item.state = 'approved'
        item.approval = { by: approver, at: board.simNow }
        count++
      }
    }
  }
  if (count) board.log.push(`APPROVED ${count} operational item(s) by ${approver}`)
  return count
}

/**
 * Prepare an escalation handover for a blocked_human item: responsible team,
 * next action, drafted note. The item STAYS blocked, escalation makes
 * ownership visible, it never resolves the barrier.
 */
export async function prepareEscalation(board: BoardState, itemId: string): Promise<boolean> {
  const { draftEscalation } = await import('./llm.ts')
  for (const p of board.patients) {
    const item = p.items.find((i) => i.id === itemId && i.state === 'blocked_human')
    if (!item) continue
    const { escalation, source } = await draftEscalation({
      patientName: p.name,
      title: item.title,
      humanReason: item.humanReason ?? '',
      quotes: item.evidence.map((e) => e.quote),
    })
    item.escalation = { ...escalation, source }
    board.log.push(`ESCALATION prepared for ${itemId} -> ${item.escalation.responsibleTeam} (case remains blocked)`)
    return true
  }
  return false
}

/** The seven discharge-summary sections the simulator accepts. */
export const LETTER_SECTIONS = ['reason', 'course', 'diagnoses', 'medicationChanges', 'results', 'followUp', 'gpActions'] as const

/**
 * A clinician saved an edited discharge letter in the UI. Stored on the
 * patient row; the summary resolver sends these sections instead of drafting
 * its own. Nothing is sent to the simulator here.
 */
export function saveLetter(board: BoardState, patientId: string, sections: Record<string, unknown>, editedBy: string): boolean {
  const row = board.patients.find((p) => p.patientId === patientId)
  if (!row) return false
  const clean: Record<string, string> = {}
  for (const k of LETTER_SECTIONS) clean[k] = String(sections[k] ?? '').slice(0, 4000)
  row.letter = { sections: clean, editedBy, at: Date.now() }
  board.log.push(`LETTER draft saved for ${patientId} by ${editedBy}`)
  return true
}

/** A clinician clicked "confirm" on a hold, the only way a hold clears. */
export function clearHold(board: BoardState, itemId: string, clinician: string): boolean {
  for (const p of board.patients) {
    const item = p.items.find((i) => i.id === itemId && i.state === 'clinical_hold')
    if (item) {
      item.state = 'verified'
      item.verification = { passed: true, observed: `cleared by ${clinician} (human sign-off)`, atSimTime: board.simNow }
      board.log.push(`HOLD CLEARED ${itemId} by ${clinician}`)
      return true
    }
  }
  return false
}

/** What still needs the agent or a person: drives the demo loop's waiting. */
export function pendingWork(board: BoardState): { approved: number; proposed: number; holds: number; blocked: number } {
  const items = board.patients.flatMap((p) => p.items)
  return {
    approved: items.filter((i) => i.state === 'approved').length,
    proposed: items.filter((i) => i.state === 'proposed').length,
    holds: items.filter((i) => i.state === 'clinical_hold').length,
    blocked: items.filter((i) => i.state === 'blocked_human').length,
  }
}

/** True when every item for the patient is verified (holds cleared, no blockers). */
export function readyForDischarge(row: PatientRow): boolean {
  return row.items.length > 0 && row.items.every((i) => i.state === 'verified')
}
