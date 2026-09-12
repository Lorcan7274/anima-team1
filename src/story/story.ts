/**
 * The story panel's data: the same ward twice. One lane is the live agent
 * world (what Homeward actually did, when, read back from the board), the
 * other is the illustrative manual-ward model in baseline.ts. Both lanes are
 * timelines so the UI can scrub or replay them.
 *
 * Nothing here calls the simulator; it is derived from BoardState on every
 * /state request, so the fallback snapshot tells the same story offline.
 */
import type { BoardState, ChecklistItem, ItemState, OwnerSite, PatientRow } from '../orchestrator/model.ts'
import { DEFAULT_BASELINE, baselineFor, kindOf, type BaselineParams, type ItemKind } from './baseline.ts'

export interface LaneItem {
  id: string
  kind: ItemKind
  owner: OwnerSite
  /** Sim time the item was observably done in this lane; null = not yet / never. */
  doneAt: number | null
  state?: ItemState
  note?: string
}

export interface Lane {
  items: LaneItem[]
  /** Sim time the bed was freed in this lane; null = still occupied. */
  homeAt: number | null
  /** Item that keeps the patient in the bed until a human acts. */
  blockedBy?: string
}

export interface StoryPatient {
  patientId: string
  name: string
  agent: Lane
  baseline: Lane & { missedPolls: number }
}

export interface StoryCounters {
  /** Beds the agent world has freed by t. */
  bedsFreed: number
  patientsHomeAgent: number
  patientsHomeBaseline: number
  /**
   * For every bed the agent world has freed by t: when the manual model would
   * free it, minus when the agent did, summed. The plan's headline number.
   * Patients the model never discharges (external decision) contribute nothing.
   */
  bedHoursSaved: number
}

export interface Story {
  fitAt: number
  now: number
  /** How far the scrubber may look ahead of now (the model keeps projecting). */
  horizon: number
  params: BaselineParams
  patients: StoryPatient[]
  counters: StoryCounters
}

const HOUR = 3_600_000

function agentLane(row: PatientRow): Lane {
  const items: LaneItem[] = row.items.map((i: ChecklistItem) => ({
    id: i.id,
    kind: kindOf(i),
    owner: i.owner,
    doneAt: i.verification?.passed ? i.verification.atSimTime : null,
    state: i.state,
    note: i.verification?.observed ?? i.humanReason ?? i.proposedAction,
  }))
  const blocked = row.items.find((i) => i.state === 'blocked_human')
  return { items, homeAt: row.dischargedAt ?? null, blockedBy: blocked?.id }
}

/** Counters at an arbitrary sim time t (the UI mirrors this for scrubbing). */
export function countersAt(patients: StoryPatient[], t: number, now: number): StoryCounters {
  const tAgent = Math.min(t, now) // the live lane is only known up to now
  let bedsFreed = 0
  let patientsHomeBaseline = 0
  let saved = 0
  for (const p of patients) {
    const a = p.agent.homeAt
    const b = p.baseline.homeAt
    if (a !== null && a <= tAgent) {
      bedsFreed++
      if (b !== null) saved += Math.max(0, b - a)
    }
    if (b !== null && b <= t) patientsHomeBaseline++
  }
  return { bedsFreed, patientsHomeAgent: bedsFreed, patientsHomeBaseline, bedHoursSaved: Math.round((saved / HOUR) * 10) / 10 }
}

/** Sim time the cohort was deemed fit: the board records it; else infer it. */
export function fitAtOf(board: BoardState): number {
  if (board.fitAt) return board.fitAt
  const times = board.patients.flatMap((p) => p.items.map((i) => i.resolution?.atSimTime ?? i.approval?.at ?? 0)).filter(Boolean)
  return times.length ? Math.min(...times) : board.simNow
}

export function computeStory(board: BoardState, params: BaselineParams = DEFAULT_BASELINE): Story {
  const fitAt = fitAtOf(board)
  const now = Math.max(board.simNow, fitAt)
  const patients: StoryPatient[] = board.patients.map((row) => {
    const b = baselineFor(row, fitAt, params)
    return {
      patientId: row.patientId,
      name: row.name,
      agent: agentLane(row),
      baseline: {
        items: b.items.map((x) => ({ id: x.id, kind: x.kind, owner: x.owner, doneAt: x.doneAt, note: x.note })),
        homeAt: b.homeAt,
        blockedBy: b.blockedBy,
        missedPolls: b.missedPolls,
      },
    }
  })
  const latestModel = Math.max(fitAt + 24 * HOUR, ...patients.map((p) => p.baseline.homeAt ?? 0))
  return {
    fitAt,
    now,
    horizon: Math.max(now, latestModel),
    params,
    patients,
    counters: countersAt(patients, now, now),
  }
}
