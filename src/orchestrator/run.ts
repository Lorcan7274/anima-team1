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
import { resolverFor } from './resolve.ts'
import { verifierFor } from './verify.ts'
import type { SimClient } from '../sim/index.ts'

export async function buildBoard(sim: SimClient, world: string, patientIds: string[]): Promise<BoardState> {
  const board: BoardState = { world, simNow: 0, patients: [], log: [] }
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
    const fresh = await detectForPatient(ctx.sim, row)
    for (const item of fresh) {
      const existing = row.items.find((i) => i.id === item.id)
      if (!existing) {
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
    ctx.log(`--- round ${round}: ${open.length} open item(s) ---`)
    for (const item of open.filter((i) => i.state === 'detected')) await resolveItem(ctx, item)
    ctx.log(`advancing clock ${advance} sim-minutes`)
    await ctx.sim.advanceClock(advance)
    ctx.board.simNow = Number((await ctx.sim.clock()).now)
    for (const item of open.filter((i) => i.state === 'awaiting_verification')) await verifyItem(ctx, item)
  }
}

/** A clinician clicked "confirm" on a hold — the only way a hold clears. */
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

/** True when every item for the patient is verified (holds cleared, no blockers). */
export function readyForDischarge(row: PatientRow): boolean {
  return row.items.length > 0 && row.items.every((i) => i.state === 'verified')
}
