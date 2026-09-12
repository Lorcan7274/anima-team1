/**
 * "Today's ward", an ILLUSTRATIVE model of the same discharge checklist run
 * by hand, used for the story panel's baseline lane. It is not a measurement
 * of any real ward and the UI must say so.
 *
 * The model: every team only looks at its inbox on its own cadence
 * (pollMinutes), jobs start one after another rather than in parallel
 * (letter after bloods and the clinical review; medicines, GP follow-up,
 * home visit and home monitoring only after the letter exists), and each
 * poll misses the job with a fixed probability (seeded RNG, so the same
 * patient always gets the same story). The bed is freed at the first ward
 * round after the last item is done. A barrier that needs an external human
 * decision never completes in either lane, the model is honest about that.
 *
 * All parameters are here in one place so a judge can read them.
 */
import type { ChecklistItem, OwnerSite, PatientRow } from '../orchestrator/model.ts'

export type ItemKind =
  | 'clinical-hold'
  | 'medicines'
  | 'bloods'
  | 'device'
  | 'visit'
  | 'summary'
  | 'follow-up'
  | 'care-package'
  | 'other'

/** Item kind from the stable id suffix (the same convention resolve.ts uses). */
export function kindOf(item: Pick<ChecklistItem, 'id'>): ItemKind {
  const id = item.id.toLowerCase()
  for (const k of ['clinical-hold', 'medicines', 'bloods', 'device', 'visit', 'summary', 'follow-up', 'care-package'] as const) {
    if (id.endsWith(`-${k}`)) return k
  }
  return 'other'
}

export interface BaselineParams {
  /** How often each team looks at its inbox, in sim minutes. */
  pollMinutes: Record<OwnerSite, number>
  /** Service lead time once a job is picked up (lab result, visit, first reading). */
  leadMinutes: Partial<Record<ItemKind, number>>
  /** Probability that a poll misses the job; it is noticed at the next poll. */
  dropProbability: number
  /** The discharge decision only happens at a ward round. */
  wardRoundMinutes: number
  /** Jobs that wait for other jobs to finish before anyone starts them. */
  after: Partial<Record<ItemKind, ItemKind[]>>
}

export const DEFAULT_BASELINE: BaselineParams = {
  pollMinutes: {
    clinician: 120, // ward round twice a shift
    diagnostics: 240, // someone checks for results twice a day-shift
    hospital: 480, // the letter gets written at the end of the shift
    pharmacy: 180, // TTO inbox
    community: 480, // referral inbox
    wearables: 720, // equipment / monitoring issue
    gp: 1440, // the practice actions the letter next day
  },
  leadMinutes: { bloods: 120, visit: 90, device: 10 },
  dropProbability: 0.25,
  wardRoundMinutes: 120,
  after: {
    summary: ['bloods', 'clinical-hold'],
    medicines: ['summary'],
    'follow-up': ['summary'],
    visit: ['summary'],
    device: ['summary'],
  },
}

export interface BaselineItem {
  id: string
  kind: ItemKind
  owner: OwnerSite
  /** Sim time the job became startable (its prerequisites were done). */
  startAt: number
  /** Sim time the job was picked up by its team. */
  pickedUpAt: number | null
  /** Sim time the job was observably complete; null = never (external decision). */
  doneAt: number | null
  /** Polls that missed the job before it was picked up. */
  missedPolls: number
  note: string
}

export interface BaselineTimeline {
  patientId: string
  fitAt: number
  items: BaselineItem[]
  /** First ward round after the last item; null when something never completes. */
  homeAt: number | null
  /** Item id that keeps the patient in the bed forever, if any. */
  blockedBy?: string
  missedPolls: number
}

/** Small deterministic PRNG (mulberry32) seeded from a string. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  let a = h >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const MIN = 60_000

/** Build the manual-ward timeline for one patient's checklist. */
export function baselineFor(row: PatientRow, fitAt: number, params: BaselineParams = DEFAULT_BASELINE): BaselineTimeline {
  const done = new Map<ItemKind, number | null>()
  const out: BaselineItem[] = []
  // Resolve in dependency order: repeat until every item is placed.
  const pending = [...row.items]
  let guard = 0
  while (pending.length && guard++ < 50) {
    for (let i = 0; i < pending.length; i++) {
      const item = pending[i]
      const kind = kindOf(item)
      const deps = (params.after[kind] ?? []).filter((d) => row.items.some((x) => kindOf(x) === d))
      if (!deps.every((d) => done.has(d))) continue
      pending.splice(i, 1)
      i--
      const depTimes = deps.map((d) => done.get(d) ?? null)
      if (item.state === 'blocked_human' || depTimes.some((t) => t === null)) {
        // An external decision nobody on the ward can make: never completes.
        const startAt = depTimes.every((t) => t !== null) ? Math.max(fitAt, ...(depTimes as number[])) : fitAt
        out.push({ id: item.id, kind, owner: item.owner, startAt, pickedUpAt: null, doneAt: null, missedPolls: 0,
          note: item.state === 'blocked_human' ? 'external decision, never completes on its own' : 'waits on a job that never completes' })
        done.set(kind, null)
        continue
      }
      const startAt = Math.max(fitAt, ...(depTimes as number[]))
      const poll = (params.pollMinutes[item.owner] ?? 480) * MIN
      const rand = seededRandom(`${row.patientId}:${item.id}`)
      // Polls happen on the team's own grid, anchored at fitAt.
      let k = Math.floor((startAt - fitAt) / poll) + 1
      let missed = 0
      while (rand() < params.dropProbability && missed < 8) { missed++; k++ }
      const pickedUpAt = fitAt + k * poll
      const lead = (params.leadMinutes[kind] ?? 0) * MIN
      // Lead time runs in the service; the ward notices the result at the next poll of the owning team.
      const doneAt = lead ? fitAt + Math.ceil((pickedUpAt + lead - fitAt) / poll) * poll : pickedUpAt
      out.push({ id: item.id, kind, owner: item.owner, startAt, pickedUpAt, doneAt, missedPolls: missed,
        note: `${item.owner} inbox every ${params.pollMinutes[item.owner] ?? 480} min` +
          (missed ? `, missed ${missed} poll${missed > 1 ? 's' : ''}` : '') + (lead ? `, ${params.leadMinutes[kind]} min lead` : '') })
      done.set(kind, doneAt)
    }
  }
  const never = out.find((x) => x.doneAt === null)
  let homeAt: number | null = null
  if (!never && out.length) {
    const last = Math.max(...out.map((x) => x.doneAt as number))
    const round = params.wardRoundMinutes * MIN
    homeAt = fitAt + Math.ceil((last - fitAt) / round) * round
    if (homeAt <= last) homeAt += round
  }
  return {
    patientId: row.patientId,
    fitAt,
    items: out.sort((a, b) => a.startAt - b.startAt || a.id.localeCompare(b.id)),
    homeAt,
    blockedBy: never?.id,
    missedPolls: out.reduce((n, x) => n + x.missedPolls, 0),
  }
}
