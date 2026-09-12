/**
 * Flow simulation: a whole ward running unattended, for the second screen.
 *
 * The simulator supplies the inflow (advancing the clock makes ~6-8 new A&E
 * arrivals per sim-hour, each with a directory record) and nobody in it ever
 * progresses without an action. This engine is the outflow: every tick it
 * advances the clock, ingests new arrivals, and moves each person one station
 * along the journey with real actions — assign/assess in A&E, discharge from
 * A&E or refer to the take, admit when a ward bed is free, run the discharge
 * checklist through the same resolvers and verifiers the ward-round demo uses,
 * and discharge when every item is verified.
 *
 * Three things the simulator does not model are stated assumptions here and
 * on screen: (1) how long treatment takes before someone is medically fit
 * (a seeded 2-8 h stay), (2) who gets admitted (acuity <= 2 always, a seeded
 * share of acuity 3), (3) "today's ward", the comparison lane, which is the
 * illustrative manual-working model in ../story/baseline.ts fed the same
 * arrivals and admissions, with the same bed count.
 */
import type { SimClient } from '../sim/index.ts'
import type { BoardState, ChecklistItem, OrchestratorContext, PatientRow } from '../orchestrator/model.ts'
import { resolveItem, verifyItem } from '../orchestrator/run.ts'
import { baselineFor, seededRandom } from '../story/baseline.ts'

export type FlowStage = 'waiting' | 'assessing' | 'take' | 'ward' | 'home'

export interface FlowPerson extends PatientRow {
  attendanceId: string
  version: number
  complaint: string
  acuity: string
  flow: FlowStage
  /** Decided at arrival from acuity + a seeded draw: admit, or treat and send home from A&E. */
  plan: 'admit' | 'home-from-ae'
  arrivedAt: number
  assessedAt?: number
  takeAt?: number
  admittedAt?: number
  /** Assumed treatment time before the person is medically fit (sim minutes). */
  stayMinutes: number
  fitAt?: number
  bed?: number
  homeFrom?: 'ae' | 'ward'
  /** Manual-model duration after fit until the bed is freed; null = never (external decision). */
  modelAfterFit: number | null
  /** Last action error, cleared on success; the person is retried next tick. */
  error?: string
}

export interface FlowParams {
  /** Sim minutes advanced per tick. */
  stepMinutes: number
  wardSize: number
  /** Share of acuity-3 arrivals admitted (acuity 1-2 always are). */
  admitShareAcuity3: number
  /** Treatment stay before fit, sim minutes, seeded per patient in this range. */
  stayMinutes: [number, number]
}

export const DEFAULT_FLOW: FlowParams = { stepMinutes: 30, wardSize: 12, admitShareAcuity3: 0.35, stayMinutes: [120, 480] }

export interface FlowState extends BoardState {
  patients: FlowPerson[]
  startedAt: number
  tick: number
  params: FlowParams
  paused: boolean
  /** Whether letters are drafted by the model or the canned fallback (shown on screen). */
  drafts?: 'model' | 'canned'
  arrivals: number
  writes: number
  errors: number
  /** Simulator clock events worth narrating (flow.pressure etc.). */
  events: Array<{ at: number; type: string; detail: string }>
  /** Real and sim time at the end of recent ticks, for the measured speed. */
  ticks?: Array<{ realAt: number; simNow: number }>
}

export interface FlowCtx {
  sim: SimClient
  state: FlowState
  log(message: string): void
}

const MIN = 60_000

export function newFlowState(world: string, params: FlowParams = DEFAULT_FLOW): FlowState {
  return {
    world, simNow: 0, patients: [], log: [], trace: [], phase: 'Joining the simulator world', busy: true,
    startedAt: 0, tick: 0, params, paused: false, arrivals: 0, writes: 0, errors: 0, events: [],
  }
}

const initialsOf = (name: string) => name.split(' ').filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase()

/** The discharge checklist for a person, from the directory record alone (cheap, deterministic). */
export function checklistFor(p: Pick<PatientRow, 'patientId' | 'conditions' | 'needs' | 'goals'>): ChecklistItem[] {
  const P = p.patientId
  const slug = (k: string) => `${P.toLowerCase()}-${k}`
  const conds = p.conditions.join(' ').toLowerCase()
  const needs = p.needs.join(' ').toLowerCase()
  const goals = p.goals.join(' ').toLowerCase()
  const ev = (quote: string) => [{ resourceId: 'directory', site: 'patient-directory' as const, quote }]
  const items: ChecklistItem[] = []
  const base = { patientId: P, state: 'proposed' as const }
  if (/heart failure|ckd|kidney|diabetes/.test(conds)) {
    items.push({ ...base, id: slug('bloods'), owner: 'diagnostics', title: 'Post-discharge blood monitoring (routine U&E + FBC)',
      proposedAction: 'Order routine U&E + FBC', evidence: ev(`Condition: "${p.conditions.find((c) => /heart failure|ckd|kidney|diabetes/i.test(c))}"`) })
  }
  if (/heart failure|copd|hypertension|diabetes|asthma/.test(conds)) {
    items.push({ ...base, id: slug('device'), owner: 'wearables', title: 'Home monitoring device',
      proposedAction: 'Issue a home activity watch and await the first reading', evidence: ev(`Condition: "${p.conditions.find((c) => /heart failure|copd|hypertension|diabetes|asthma/i.test(c))}"`) })
  }
  if (/home visit|carer|step-free|home support|mobility|frailty|falls|fall at home/.test(`${needs} ${conds}`)) {
    items.push({ ...base, id: slug('visit'), owner: 'community', title: 'Home support visit',
      proposedAction: 'Schedule a community home-support visit', evidence: ev(`Recorded need: "${p.needs.find((n) => /home|carer|step|support|mobility/i.test(n)) ?? p.conditions[0]}"`) })
  }
  items.push({ ...base, id: slug('summary'), owner: 'hospital', title: 'Discharge summary sent to the GP',
    proposedAction: 'Draft all seven sections and send', evidence: [] })
  items.push({ ...base, id: slug('follow-up'), owner: 'gp', title: `GP follow-up${/avoid unnecessary travel|telephone/.test(goals + needs) ? ' (telephone)' : ''}`,
    proposedAction: 'Create a 48h review task for the GP', evidence: /telephone|travel/.test(goals + needs) ? ev(`Goal: "${p.goals.find((g) => /travel/i.test(g)) ?? p.needs.find((n) => /telephone/i.test(n))}"`) : [] })
  return items
}

const stageOrder: Record<string, number> = { waiting: 0, assessing: 1, take: 2, inpatient: 3, discharged: 4 }
const flowOfSim = (stage: string): FlowStage => (stage === 'inpatient' ? 'ward' : stage === 'discharged' ? 'home' : (stage as FlowStage))

/** Ingest attendances: new arrivals become people; tracked people sync forward if the sim is ahead. */
export function ingest(state: FlowState, resources: any[], patients: any[]): FlowPerson[] {
  const fresh: FlowPerson[] = []
  for (const a of resources) {
    const stage = String(a.data?.stage ?? 'waiting')
    const known = state.patients.find((p) => p.attendanceId === a.id)
    if (known) {
      known.version = a.version
      const simFlow = flowOfSim(stage)
      if (stageOrder[stage] > stageOrder[known.flow === 'ward' ? 'inpatient' : known.flow === 'home' ? 'discharged' : known.flow]) {
        known.flow = simFlow
        if (simFlow === 'assessing') known.assessedAt ??= state.simNow
        if (simFlow === 'take' || simFlow === 'ward') known.takeAt ??= state.simNow
        if (simFlow === 'ward' && !known.admittedAt) admit(state, known, state.simNow, bedNumber(a.data?.location))
        if (simFlow === 'home' && !known.dischargedAt) { known.dischargedAt = state.simNow; known.homeFrom = known.admittedAt ? 'ward' : 'ae' }
      }
      continue
    }
    if (stage === 'discharged') continue
    const rec = patients.find((p) => p.id === a.patientId) ?? {}
    const rand = seededRandom(`${state.world}:${a.patientId}`)
    const acuity = String(a.data?.acuity ?? '3')
    const plan: FlowPerson['plan'] = Number(acuity) <= 2 || rand() < state.params.admitShareAcuity3 ? 'admit' : 'home-from-ae'
    const [lo, hi] = state.params.stayMinutes
    const stayMinutes = Math.round(lo + rand() * (hi - lo))
    const p: FlowPerson = {
      patientId: a.patientId,
      name: rec.name ?? a.patientId,
      conditions: rec.conditions ?? [],
      needs: rec.needs ?? [],
      goals: rec.goals ?? [],
      stage,
      location: a.data?.location,
      items: [],
      attendanceId: a.id,
      version: a.version,
      complaint: a.data?.presentingComplaint ?? a.title ?? '',
      acuity,
      flow: flowOfSim(stage),
      plan: stage === 'take' || stage === 'inpatient' ? 'admit' : plan,
      arrivedAt: Number(a.data?.arrivalAt ?? a.createdAt ?? state.simNow),
      stayMinutes,
      modelAfterFit: null,
    }
    p.items = checklistFor(p)
    const model = baselineFor({ ...p, items: p.items }, 0)
    p.modelAfterFit = model.homeAt
    if (p.flow === 'take' || p.flow === 'ward') p.takeAt = state.simNow
    if (p.flow === 'assessing') p.assessedAt = state.simNow
    if (p.flow === 'ward') admit(state, p, state.simNow, bedNumber(a.data?.location))
    state.patients.push(p)
    fresh.push(p)
  }
  return fresh
}

const bedNumber = (location: unknown): number | undefined => {
  const m = String(location ?? '').match(/bed\s*(\d+)/i)
  return m ? Number(m[1]) : undefined
}

export const wardOccupied = (state: FlowState) => state.patients.filter((p) => p.flow === 'ward')

/** Beds held by anyone on the ward or with an admission in flight (bed reserved, write pending). */
function freeBed(state: FlowState): number | undefined {
  const used = new Set(state.patients.filter((p) => p.flow !== 'home' && p.bed !== undefined).map((p) => p.bed))
  for (let n = 1; n <= state.params.wardSize; n++) if (!used.has(n)) return n
  return undefined
}

function admit(state: FlowState, p: FlowPerson, at: number, bed?: number) {
  p.flow = 'ward'
  p.admittedAt = at
  const taken = (n: number) => state.patients.some((q) => q !== p && q.flow !== 'home' && q.bed === n)
  p.bed = bed && bed <= state.params.wardSize && !taken(bed) ? bed : p.bed && !taken(p.bed) ? p.bed : freeBed(state) ?? state.params.wardSize + 1
  p.fitAt = at + p.stayMinutes * MIN
  for (const i of p.items) {
    if (i.state === 'proposed') { i.state = 'approved'; i.approval = { by: 'Flow simulation (auto-approved)', at } }
  }
}

async function attendanceAction(ctx: FlowCtx, p: FlowPerson, cmd: string, extra: Record<string, unknown>) {
  const res = (await ctx.sim.siteAction(
    'hospital',
    { type: 'update_attendance', patientId: p.patientId, resourceId: p.attendanceId, expectedVersion: p.version, hospitalCommand: cmd, ...extra },
    `${ctx.state.world}-${p.attendanceId}-${cmd}-v${p.version}`,
  )) as { version?: number; data?: { stage?: string; location?: string } }
  ctx.state.writes++
  if (res.version) p.version = res.version
  if (res.data?.stage) p.stage = res.data.stage
  return res
}

/** Move one person one station along, with real actions. Errors are recorded and retried next tick. */
export async function stepPerson(ctx: FlowCtx, p: FlowPerson): Promise<void> {
  const { state } = ctx
  const now = state.simNow
  try {
    if (p.flow === 'waiting') {
      try {
        await attendanceAction(ctx, p, 'assess', { clinician: 'Dr Ada Sim' })
      } catch (err) {
        const status = (err as { status?: number }).status ?? 0
        if (status < 400 || status >= 500) throw err
        await attendanceAction(ctx, p, 'assign', { clinician: 'Dr Ada Sim' })
        await attendanceAction(ctx, p, 'assess', { clinician: 'Dr Ada Sim' })
      }
      p.flow = 'assessing'
      p.assessedAt = now
    } else if (p.flow === 'assessing') {
      if (p.plan === 'home-from-ae') {
        await attendanceAction(ctx, p, 'discharge', { disposition: 'Treated and discharged from A&E' })
        p.flow = 'home'; p.homeFrom = 'ae'; p.dischargedAt = now
        ctx.log(`${p.name}: home from A&E`)
      } else {
        await attendanceAction(ctx, p, 'refer', {})
        p.flow = 'take'; p.takeAt = now
        await admitIfBed(ctx, p, now)
      }
    } else if (p.flow === 'take') {
      await admitIfBed(ctx, p, now)
    } else if (p.flow === 'ward') {
      if (p.fitAt === undefined || now < p.fitAt) return // being treated
      const octx: OrchestratorContext = { sim: ctx.sim, world: state.world, board: state, log: ctx.log }
      // Verify what was resolved in an earlier tick (time has moved since), then act on the rest.
      for (const i of p.items) if (i.state === 'awaiting_verification') await verifyItem(octx, i)
      for (const i of p.items) if (i.state === 'failed') { i.state = 'approved'; i.error = undefined } // retry with a fresh attempt
      for (const i of p.items) if (i.state === 'approved') { await resolveItem(octx, i); state.writes++ }
      const failed = p.items.filter((i) => i.state === 'failed')
      if (failed.length) { p.error = `${failed[0].id.split('-').pop()}: ${(failed[0].error ?? '').slice(0, 80)}`; state.errors++ }
      else p.error = undefined
      if (p.items.length && p.items.every((i) => i.state === 'verified')) {
        await attendanceAction(ctx, p, 'discharge', { disposition: 'Home with community support and follow-up' })
        p.flow = 'home'; p.homeFrom = 'ward'; p.dischargedAt = now
        ctx.log(`${p.name}: discharged home from AMU bed ${p.bed} after ${Math.round((now - (p.admittedAt ?? now)) / MIN / 60)}h`)
      }
    }
    if (p.flow !== 'ward') p.error = undefined
  } catch (err) {
    p.error = String((err as Error).message ?? err).slice(0, 120)
    state.errors++
    ctx.log(`${p.name}: ${p.flow} step failed, will retry — ${p.error}`)
  }
}

/** Admit when a bed is free; otherwise the person waits on the take (the pressure signal). */
async function admitIfBed(ctx: FlowCtx, p: FlowPerson, now: number): Promise<void> {
  const { state } = ctx
  const bed = freeBed(state)
  if (bed === undefined) return
  p.bed = bed // reserve synchronously; concurrent workers see it before the write lands
  try {
    await attendanceAction(ctx, p, 'admit', { location: `AMU bed ${bed}` })
  } catch (err) {
    p.bed = undefined
    throw err
  }
  admit(state, p, now, bed)
  ctx.log(`${p.name}: admitted to AMU bed ${bed} (${p.items.length} discharge items)`)
}

async function pool<T>(items: T[], limit: number, fn: (x: T) => Promise<void>) {
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const x = items[i++]; await fn(x) }
  })
  await Promise.all(workers)
}

/** One tick: advance the clock, ingest arrivals, move everyone one station along. */
export async function tick(ctx: FlowCtx): Promise<void> {
  const { sim, state } = ctx
  state.tick++
  state.busy = true
  state.phase = `Tick ${state.tick}: advancing the clock ${state.params.stepMinutes} sim-minutes`
  const clock = (await sim.advanceClock(state.params.stepMinutes)) as { now?: number; events?: any[] }
  state.simNow = Number(clock.now ?? (await sim.clock()).now)
  for (const e of clock.events ?? []) {
    if (/flow\.pressure|emergency\.arrived/.test(String(e.type))) state.events.push({ at: state.simNow, type: e.type, detail: String(e.detail ?? '') })
  }
  if (state.events.length > 40) state.events.splice(0, state.events.length - 40)
  state.phase = 'Reading the A&E list'
  const att = (await sim.hospitalAttendances()) as { resources: any[]; patients: any[] }
  const fresh = ingest(state, att.resources ?? [], att.patients ?? [])
  state.arrivals += fresh.length
  if (fresh.length) ctx.log(`${fresh.length} new arrival${fresh.length > 1 ? 's' : ''} in A&E`)
  const active = state.patients.filter((p) => p.flow !== 'home')
  state.phase = `Moving ${active.length} people along — A&E, take, ward, checklist, discharge`
  // Ward first so beds free up before the take is admitted.
  const order: FlowStage[] = ['ward', 'take', 'assessing', 'waiting']
  for (const stage of order) await pool(active.filter((p) => p.flow === stage), 4, (p) => stepPerson(ctx, p))
  state.ticks = [...(state.ticks ?? []).slice(-9), { realAt: Date.now(), simNow: state.simNow }]
  state.busy = false
  state.phase = `Tick ${state.tick} done · ${wardOccupied(state).length}/${state.params.wardSize} beds · ${state.patients.filter((p) => p.flow === 'home').length} home`
}

// --- Today's ward: the same arrivals through the manual-working model --------

export interface ModelPerson { id: string; stage: FlowStage; bed?: number; admittedAt?: number; homeAt: number | null }
export interface ModelLane { people: Record<string, ModelPerson>; occupied: number; waitingForBed: number; home: number }

/**
 * Replays the agent lane's A&E decisions through a ward of the same size where
 * every stay after fit lasts what the manual model says. A queue with wardSize
 * servers, in order of reaching the take. Deterministic, recomputed per request.
 */
export function modelLane(state: FlowState, t: number): ModelLane {
  const people: Record<string, ModelPerson> = {}
  const beds: number[] = Array.from({ length: state.params.wardSize }, () => 0)
  const queue = state.patients
    .filter((p) => p.plan === 'admit' && p.takeAt !== undefined)
    .sort((a, b) => (a.takeAt! - b.takeAt!) || a.attendanceId.localeCompare(b.attendanceId))
  for (const p of state.patients) {
    if (p.plan === 'home-from-ae' || p.takeAt === undefined) {
      people[p.attendanceId] = { id: p.attendanceId, stage: p.flow === 'ward' ? 'take' : p.flow, homeAt: p.flow === 'home' ? p.dischargedAt ?? null : null }
    }
  }
  for (const p of queue) {
    let bed = 0
    for (let n = 1; n < beds.length; n++) if (beds[n] < beds[bed]) bed = n
    const admittedAt = Math.max(p.takeAt!, beds[bed])
    const homeAt = p.modelAfterFit === null ? null : admittedAt + p.stayMinutes * MIN + p.modelAfterFit
    beds[bed] = homeAt ?? Number.MAX_SAFE_INTEGER
    const stage: FlowStage = t < admittedAt ? 'take' : homeAt !== null && t >= homeAt ? 'home' : 'ward'
    people[p.attendanceId] = { id: p.attendanceId, stage, bed: bed + 1, admittedAt, homeAt }
  }
  const vals = Object.values(people)
  return {
    people,
    occupied: vals.filter((x) => x.stage === 'ward').length,
    waitingForBed: vals.filter((x) => x.stage === 'take' && x.admittedAt !== undefined).length,
    home: vals.filter((x) => x.stage === 'home').length,
  }
}

export interface FlowCounters {
  inAe: number; waitingForBed: number; occupied: number; home: number; homeFromWard: number
  modelOccupied: number; modelWaitingForBed: number; modelHome: number
  /** Bed-hours the manual model would still be using for people the agent world has sent home from the ward. */
  bedHoursSaved: number
  medianDoorToHomeHours: number | null
}

export function counters(state: FlowState, model: ModelLane): FlowCounters {
  const t = state.simNow
  const ps = state.patients
  const homeFromWard = ps.filter((p) => p.flow === 'home' && p.homeFrom === 'ward')
  let saved = 0
  for (const p of homeFromWard) {
    const m = model.people[p.attendanceId]
    const modelStillInBed = m?.homeAt === null || m?.homeAt === undefined ? t : Math.min(m.homeAt, t)
    saved += Math.max(0, modelStillInBed - (p.dischargedAt ?? t))
  }
  const durations = homeFromWard.map((p) => (p.dischargedAt! - p.arrivedAt) / MIN / 60).sort((a, b) => a - b)
  return {
    inAe: ps.filter((p) => p.flow === 'waiting' || p.flow === 'assessing').length,
    waitingForBed: ps.filter((p) => p.flow === 'take').length,
    occupied: wardOccupied(state).length,
    home: ps.filter((p) => p.flow === 'home').length,
    homeFromWard: homeFromWard.length,
    modelOccupied: model.occupied,
    modelWaitingForBed: model.waitingForBed,
    modelHome: model.home,
    bedHoursSaved: Math.round((saved / MIN / 60) * 10) / 10,
    medianDoorToHomeHours: durations.length ? Math.round(durations[Math.floor(durations.length / 2)] * 10) / 10 : null,
  }
}

/** What the page polls: state + the model lane + counters, with initials precomputed. */
export function snapshot(state: FlowState) {
  const model = modelLane(state, state.simNow)
  return {
    ...state,
    trace: (state.trace ?? []).slice(-30),
    log: state.log.slice(-40),
    patients: state.patients.map((p) => ({ ...p, initials: initialsOf(p.name), items: p.items.map((i) => ({ id: i.id, owner: i.owner, state: i.state, title: i.title, error: i.error })) })),
    model,
    counters: counters(state, model),
  }
}
