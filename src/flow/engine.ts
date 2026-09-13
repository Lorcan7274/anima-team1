/**
 * Flow simulation: a whole ward running unattended, for the second screen.
 *
 * The simulator supplies the inflow (advancing the clock makes ~6-8 new A&E
 * arrivals per sim-hour, each with a directory record) and nobody in it ever
 * progresses without an action. This engine is the outflow: every tick it
 * advances the clock, ingests new arrivals, and moves each person one station
 * along the journey with real actions, assign/assess in A&E, discharge from
 * A&E or refer to the take, admit when a ward bed is free, run the discharge
 * checklist through the same resolvers and verifiers the ward-round demo uses,
 * and discharge when every item is verified.
 *
 * Three things the simulator does not model are stated assumptions here and
 * on screen: (1) how long treatment takes before someone is medically fit
 * (a seeded 1-3 h stay), (2) who gets admitted (acuity <= 2 always, a seeded
 * share of acuity 3), (3) "today's ward", the comparison lane, which is the
 * illustrative manual-working model in ../story/baseline.ts fed the same
 * arrivals and admissions, with the same bed count.
 *
 * A run can last all day, so people both lanes are finished with are folded
 * into archive counters after a while (archiveSettled) and the state stays
 * bounded; every counter on screen includes the archived people.
 */
import type { SimClient } from '../sim/index.ts'
import type { BoardState, ChecklistItem, OrchestratorContext, PatientRow } from '../orchestrator/model.ts'
import { resolveItem, verifyItem } from '../orchestrator/run.ts'
import { baselineFor, seededRandom } from '../story/baseline.ts'

export type FlowStage = 'waiting' | 'assessing' | 'take' | 'ward' | 'home'

/**
 * Which simulator the flow ran against: the shared NHS-SIM world ('live'), a
 * local HTTP stand-in reached through SIM_ORIGIN ('local'), the in-process
 * stand-in in ./offline.ts ('offline'), or a recorded run served with no
 * simulator at all ('snapshot', the --replay screen).
 */
export type FlowMode = 'live' | 'local' | 'offline' | 'snapshot'

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
  /**
   * Manual-ward pressure response: once someone has waited this long for a
   * bed, the ward frees one at the next ward round by discharging whoever has
   * been medically fit the longest, checklist items outstanding. Real wards
   * reset this way; without it the model's queue grows without bound.
   */
  modelMaxWaitMinutes: number
  /**
   * How long (sim minutes) a person stays on screen at Home after both lanes
   * are done with them before being folded into the archive counters, which
   * keeps the state bounded on a run that lasts all day. Infinity keeps everyone.
   */
  retainHomeMinutes?: number
}

export const DEFAULT_FLOW: FlowParams = {
  stepMinutes: 30, wardSize: 12, admitShareAcuity3: 0.25, stayMinutes: [60, 180], modelMaxWaitMinutes: 240, retainHomeMinutes: 360,
}

/** A manual-ward bed as the queue model sees it: when it frees, and who holds it. */
export interface ModelBed { freeAt: number; occ?: { id: string; fitAt: number; afterFit: number | null } }

/** Totals for people removed from `patients` once both lanes were finished with them. */
export interface FlowArchive {
  people: number
  home: number
  homeFromWard: number
  /** Door-to-home of ward discharges, a histogram keyed by tenths of an hour. */
  doorToHome: Record<string, number>
  /** Bed-milliseconds the archived people used in each lane. */
  agentBedMs: number
  modelBedMs: number
  modelHome: number
  modelForcedHome: number
  /** The manual ward's beds as the archived people left them; the queue model starts from here. */
  modelBeds: ModelBed[]
}

export interface FlowState extends BoardState {
  patients: FlowPerson[]
  startedAt: number
  tick: number
  params: FlowParams
  paused: boolean
  /** Whether letters are drafted by the model or the canned fallback (shown on screen). */
  drafts?: 'model' | 'canned'
  mode?: FlowMode
  /** On a replay ('snapshot'): the mode the recorded run ran in. */
  recordedMode?: FlowMode
  /** Offline stand-in only: the arrival rate it generates, stated on screen. */
  arrivalsPerHour?: number
  arrivals: number
  writes: number
  errors: number
  /** Simulator clock events worth narrating (flow.pressure etc.). */
  events: Array<{ at: number; type: string; detail: string }>
  /** Real and sim time at the end of recent ticks, for the measured speed. */
  ticks?: Array<{ realAt: number; simNow: number }>
  archive?: FlowArchive
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
const simOfFlow = (flow: FlowStage): string => (flow === 'ward' ? 'inpatient' : flow === 'home' ? 'discharged' : flow)

/** Ingest attendances: new arrivals become people; tracked people sync forward if the sim is ahead. */
export function ingest(state: FlowState, resources: any[], patients: any[]): FlowPerson[] {
  const fresh: FlowPerson[] = []
  const byAttendance = new Map(state.patients.map((p) => [p.attendanceId, p]))
  const records = new Map(patients.map((p) => [p.id, p]))
  for (const a of resources) {
    const stage = String(a.data?.stage ?? 'waiting')
    const known = byAttendance.get(a.id)
    if (known) {
      known.version = a.version
      const simFlow = flowOfSim(stage)
      if ((stageOrder[stage] ?? 0) > stageOrder[simOfFlow(known.flow)]) {
        known.flow = simFlow
        if (simFlow === 'assessing') known.assessedAt ??= state.simNow
        if (simFlow === 'take' || simFlow === 'ward') known.takeAt ??= state.simNow
        if (simFlow === 'ward' && !known.admittedAt) admit(state, known, state.simNow, bedNumber(a.data?.location))
        if (simFlow === 'home' && !known.dischargedAt) { known.dischargedAt = state.simNow; known.homeFrom = known.admittedAt ? 'ward' : 'ae' }
      }
      continue
    }
    if (stage === 'discharged') continue
    const rec = records.get(a.patientId) ?? {}
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
    if (!Number.isFinite(p.arrivedAt)) p.arrivedAt = state.simNow
    p.items = checklistFor(p)
    const model = baselineFor({ ...p, items: p.items }, 0)
    p.modelAfterFit = model.homeAt
    if (p.flow === 'take' || p.flow === 'ward') p.takeAt = state.simNow
    if (p.flow === 'assessing') p.assessedAt = state.simNow
    if (p.flow === 'ward') admit(state, p, state.simNow, bedNumber(a.data?.location))
    state.patients.push(p)
    byAttendance.set(p.attendanceId, p)
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
    ctx.log(`${p.name}: ${p.flow} step failed, will retry, ${p.error}`)
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
  state.phase = `Moving ${active.length} people along, A&E, take, ward, checklist, discharge`
  // Ward first so beds free up before the take is admitted.
  const order: FlowStage[] = ['ward', 'take', 'assessing', 'waiting']
  for (const stage of order) await pool(active.filter((p) => p.flow === stage), 4, (p) => stepPerson(ctx, p))
  archiveSettled(state)
  state.ticks = [...(state.ticks ?? []).slice(-9), { realAt: Date.now(), simNow: state.simNow }]
  state.busy = false
  const home = state.patients.filter((p) => p.flow === 'home').length + (state.archive?.home ?? 0)
  state.phase = `Tick ${state.tick} done · ${wardOccupied(state).length}/${state.params.wardSize} beds · ${home} home`
}

// --- Today's ward: the same arrivals through the manual-working model --------

export interface ModelPerson { id: string; stage: FlowStage; bed?: number; admittedAt?: number; homeAt: number | null; /** sent home early under bed pressure, items outstanding */ forced?: boolean }
export interface ModelLane { people: Record<string, ModelPerson>; occupied: number; waitingForBed: number; home: number; forcedHome: number }

/** People who go through the manual ward's queue: everyone referred to the take, in order of reaching it. */
const modelQueue = (state: FlowState) => state.patients
  .filter((p) => p.plan === 'admit' && p.takeAt !== undefined)
  .sort((a, b) => (a.takeAt! - b.takeAt!) || a.attendanceId.localeCompare(b.attendanceId))

const cloneBeds = (beds: ModelBed[]): ModelBed[] => beds.map((b) => ({ freeAt: b.freeAt, occ: b.occ ? { ...b.occ } : undefined }))

/**
 * Replays the agent lane's A&E decisions through a ward of the same size where
 * every stay after fit lasts what the manual model says. A queue with wardSize
 * servers, in order of reaching the take. Deterministic, recomputed per request,
 * starting from the beds the archived people left (state.archive.modelBeds).
 * `captureAfter` returns the beds as they stand once that person is placed,
 * which is what archiving stores.
 */
function runModelQueue(state: FlowState, t: number, captureAfter?: string): { lane: ModelLane; bedsAfter?: ModelBed[] } {
  const people: Record<string, ModelPerson> = {}
  const round = 120 * MIN
  const grid = (x: number) => state.startedAt + Math.ceil((x - state.startedAt) / round) * round
  const maxWait = (state.params.modelMaxWaitMinutes ?? 240) * MIN
  const beds: ModelBed[] = cloneBeds(state.archive?.modelBeds ?? [])
  while (beds.length < state.params.wardSize) beds.push({ freeAt: 0 })
  beds.length = state.params.wardSize
  let bedsAfter: ModelBed[] | undefined
  const queue = modelQueue(state)
  for (const p of state.patients) {
    if (p.plan === 'home-from-ae' || p.takeAt === undefined) {
      people[p.attendanceId] = { id: p.attendanceId, stage: p.flow === 'ward' ? 'take' : p.flow, homeAt: p.flow === 'home' ? p.dischargedAt ?? null : null }
    }
  }
  for (const p of queue) {
    let bed = 0
    for (let n = 1; n < beds.length; n++) if (beds[n].freeAt < beds[bed].freeAt) bed = n
    let admittedAt = Math.max(p.takeAt!, beds[bed].freeAt)
    if (admittedAt - p.takeAt! > maxWait) {
      // Pressure response: once the wait limit has passed, the ward frees a
      // bed at the first ward round at which an occupant is medically fit,
      // sending the longest-fit one home early (never someone whose barrier
      // needs an external decision). The round is set by when the occupants
      // are fit, not by when this person arrived: a queue that has already
      // waited longer than every occupant has been in still gets a bed.
      const limit = grid(p.takeAt! + maxWait)
      let victim = -1
      let at = admittedAt
      for (let n = 0; n < beds.length; n++) {
        const occ = beds[n].occ
        if (!occ || occ.afterFit === null || beds[n].freeAt <= limit) continue
        const roundAt = Math.max(limit, grid(occ.fitAt))
        if (roundAt < at || (roundAt === at && victim >= 0 && occ.fitAt < beds[victim].occ!.fitAt)) { victim = n; at = roundAt }
      }
      if (victim >= 0) {
        const occ = beds[victim].occ!
        const m = people[occ.id]
        if (m) { m.homeAt = at; m.forced = true }
        beds[victim].freeAt = at
        bed = victim
        admittedAt = at
      }
    }
    const fitAt = admittedAt + p.stayMinutes * MIN
    const homeAt = p.modelAfterFit === null ? null : fitAt + p.modelAfterFit
    beds[bed] = { freeAt: homeAt ?? Number.MAX_SAFE_INTEGER, occ: { id: p.attendanceId, fitAt, afterFit: p.modelAfterFit } }
    people[p.attendanceId] = { id: p.attendanceId, stage: 'ward', bed: bed + 1, admittedAt, homeAt }
    if (p.attendanceId === captureAfter) bedsAfter = cloneBeds(beds)
  }
  // Stages at t (forced discharges may have shortened a homeAt after the entry was made).
  for (const p of queue) {
    const m = people[p.attendanceId]
    m.stage = t < m.admittedAt! ? 'take' : m.homeAt !== null && t >= m.homeAt ? 'home' : 'ward'
  }
  // Display only: show each person in the bed the live lane actually gave them
  // when that bed is free in the model at t, so the two wards line up.
  const byId = new Map(state.patients.map((p) => [p.attendanceId, p]))
  const used = new Set<number>()
  const inBed = Object.values(people).filter((m) => m.stage === 'ward')
  for (const m of inBed) { const real = byId.get(m.id)?.bed; if (real && !used.has(real)) { m.bed = real; used.add(real) } else m.bed = undefined }
  for (const m of inBed) { if (m.bed === undefined) { let n = 1; while (used.has(n)) n++; m.bed = n; used.add(n) } }
  const vals = Object.values(people)
  const lane: ModelLane = {
    people,
    occupied: vals.filter((x) => x.stage === 'ward').length,
    waitingForBed: vals.filter((x) => x.stage === 'take' && x.admittedAt !== undefined).length,
    home: vals.filter((x) => x.stage === 'home').length,
    forcedHome: vals.filter((x) => x.stage === 'home' && x.forced).length,
  }
  return { lane, bedsAfter }
}

export function modelLane(state: FlowState, t: number): ModelLane {
  return runModelQueue(state, t).lane
}

const emptyArchive = (): FlowArchive => ({ people: 0, home: 0, homeFromWard: 0, doorToHome: {}, agentBedMs: 0, modelBedMs: 0, modelHome: 0, modelForcedHome: 0, modelBeds: [] })

/**
 * Fold people both lanes are finished with into the archive counters and drop
 * them from `patients`. Exact for what remains on screen: the queue model is
 * sequential in take order, so the archived people are a prefix of the queue
 * and the beds they left are stored for the model to start from. Returns how
 * many were archived.
 */
export function archiveSettled(state: FlowState, t: number = state.simNow): number {
  const keepMs = (state.params.retainHomeMinutes ?? DEFAULT_FLOW.retainHomeMinutes ?? 360) * MIN
  if (!Number.isFinite(keepMs) || !Number.isFinite(t)) return 0
  const cutoff = t - keepMs
  const { lane } = runModelQueue(state, t)
  const settled = (p: FlowPerson) => {
    if (p.flow !== 'home' || (p.dischargedAt ?? t) > cutoff) return false
    const m = lane.people[p.attendanceId]
    return !!m && m.stage === 'home' && m.homeAt !== null && m.homeAt <= cutoff
  }
  const gone = new Set<string>()
  let lastQueued: string | undefined
  for (const p of modelQueue(state)) {
    if (!settled(p)) break
    gone.add(p.attendanceId)
    lastQueued = p.attendanceId
  }
  for (const p of state.patients) if (!(p.plan === 'admit' && p.takeAt !== undefined) && settled(p)) gone.add(p.attendanceId)
  if (gone.size === 0) return 0
  const a = (state.archive ??= emptyArchive())
  for (const p of state.patients) {
    if (!gone.has(p.attendanceId)) continue
    a.people++
    a.home++
    if (p.homeFrom === 'ward') {
      a.homeFromWard++
      const tenths = String(doorToHomeTenths(p))
      a.doorToHome[tenths] = (a.doorToHome[tenths] ?? 0) + 1
    }
    if (p.admittedAt !== undefined) a.agentBedMs += Math.max(0, (p.dischargedAt ?? t) - p.admittedAt)
    const m = lane.people[p.attendanceId]
    a.modelHome++
    if (m.forced) a.modelForcedHome++
    if (m.admittedAt !== undefined && m.homeAt !== null) a.modelBedMs += Math.max(0, m.homeAt - m.admittedAt)
  }
  if (lastQueued) a.modelBeds = runModelQueue(state, t, lastQueued).bedsAfter ?? a.modelBeds
  state.patients = state.patients.filter((p) => !gone.has(p.attendanceId))
  return gone.size
}

const doorToHomeTenths = (p: FlowPerson) => Math.round(((p.dischargedAt ?? p.arrivedAt) - p.arrivedAt) / MIN / 6)

/** The value at the upper-median position of a histogram keyed by tenths of an hour. */
function medianTenths(hist: Record<string, number>): number | null {
  const keys = Object.keys(hist).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
  const n = keys.reduce((s, k) => s + hist[String(k)], 0)
  if (!n) return null
  let seen = 0
  for (const k of keys) { seen += hist[String(k)]; if (seen > Math.floor(n / 2)) return k / 10 }
  return keys.at(-1)! / 10
}

export interface FlowCounters {
  inAe: number; waitingForBed: number; occupied: number; home: number; homeFromWard: number
  modelOccupied: number; modelWaitingForBed: number; modelHome: number
  /** People the manual model sent home early under bed pressure, checklist items outstanding. */
  modelForcedHome: number
  /**
   * Bed-hours the manual ward has used minus bed-hours Homeward's ward has
   * used, both up to now, the same arrivals and the same beds. Never more than
   * the ward could hold over the elapsed time.
   */
  bedHoursSaved: number
  medianDoorToHomeHours: number | null
}

export function counters(state: FlowState, model: ModelLane): FlowCounters {
  const t = state.simNow
  const ps = state.patients
  const a = state.archive
  const homeFromWard = ps.filter((p) => p.flow === 'home' && p.homeFrom === 'ward')
  let modelMs = a?.modelBedMs ?? 0
  let agentMs = a?.agentBedMs ?? 0
  for (const m of Object.values(model.people)) {
    if (m.admittedAt !== undefined && m.admittedAt <= t) modelMs += Math.max(0, Math.min(m.homeAt ?? t, t) - m.admittedAt)
  }
  for (const p of ps) {
    if (p.admittedAt !== undefined && p.admittedAt <= t) agentMs += Math.max(0, Math.min(p.dischargedAt ?? t, t) - p.admittedAt)
  }
  const hist: Record<string, number> = { ...(a?.doorToHome ?? {}) }
  for (const p of homeFromWard) { const k = String(doorToHomeTenths(p)); hist[k] = (hist[k] ?? 0) + 1 }
  return {
    inAe: ps.filter((p) => p.flow === 'waiting' || p.flow === 'assessing').length,
    waitingForBed: ps.filter((p) => p.flow === 'take').length,
    occupied: wardOccupied(state).length,
    home: ps.filter((p) => p.flow === 'home').length + (a?.home ?? 0),
    homeFromWard: homeFromWard.length + (a?.homeFromWard ?? 0),
    modelOccupied: model.occupied,
    modelWaitingForBed: model.waitingForBed,
    modelHome: model.home + (a?.modelHome ?? 0),
    modelForcedHome: model.forcedHome + (a?.modelForcedHome ?? 0),
    bedHoursSaved: Math.round(((modelMs - agentMs) / MIN / 60) * 10) / 10,
    medianDoorToHomeHours: medianTenths(hist),
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

// --- The script's arguments and the visible join --------------------------

export interface FlowArgs {
  /** offline (the default): the in-process stand-in; live: the shared simulator via SIM_ORIGIN; replay: serve a recorded flow-state.json. */
  mode: 'offline' | 'live' | 'replay'
  params: FlowParams
  port: number
  /** Real milliseconds between ticks; undefined = the script's default for the mode. */
  pauseMs?: number
  world?: string
  replayFile: string
  llm: boolean
  /** Values that were rejected and replaced by the default, for the console. */
  warnings: string[]
}

/**
 * Parse the flow script's flags. No flags means the offline stand-in; --live
 * selects the shared simulator; --offline is accepted as a no-op alias so the
 * documented commands keep working. Out-of-range or non-numeric values fall
 * back to the defaults with a warning rather than putting NaN into the clock.
 */
export function parseFlowArgs(argv: string[], defaults: FlowParams = DEFAULT_FLOW): FlowArgs {
  const arg = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
  const flag = (name: string) => argv.includes(`--${name}`)
  const warnings: string[] = []
  const num = (name: string, fallback: number, min: number, max: number): number => {
    const raw = arg(name)
    if (raw === undefined) return fallback
    const n = Number(raw)
    if (Number.isFinite(n) && n >= min && n <= max) return n
    warnings.push(`--${name} ${raw}: expected a number from ${min} to ${max}, using ${fallback}`)
    return fallback
  }
  let stayMinutes = defaults.stayMinutes
  const stayRaw = arg('stay')
  if (stayRaw !== undefined) {
    const parts = stayRaw.split('-').map(Number)
    if (parts.length === 2 && parts.every((n) => Number.isFinite(n) && n > 0 && n <= 10080)) {
      stayMinutes = [Math.min(parts[0], parts[1]), Math.max(parts[0], parts[1])]
    } else warnings.push(`--stay ${stayRaw}: expected lo-hi sim-minutes, using ${defaults.stayMinutes.join('-')}`)
  }
  const mode: FlowArgs['mode'] = flag('replay') ? 'replay' : flag('live') ? 'live' : 'offline'
  if (flag('offline') && flag('live')) warnings.push('--offline and --live given together: running live')
  const llm = flag('llm')
  if (llm && mode === 'offline') warnings.push('--llm is ignored with the local stand-in (its letters are canned so it never waits on the model); add --live for model drafts')
  const pauseRaw = arg('pause-ms')
  return {
    mode,
    params: {
      ...defaults,
      stepMinutes: num('step', defaults.stepMinutes, 5, 720),
      wardSize: num('beds', defaults.wardSize, 1, 60),
      stayMinutes,
    },
    port: num('port', 4700, 1, 65535),
    pauseMs: pauseRaw === undefined ? undefined : num('pause-ms', 0, 0, 600_000),
    world: arg('world'),
    replayFile: arg('replay-file') ?? 'flow-state.json',
    llm,
    warnings,
  }
}

/** What to call a run against `origin`: a loopback address is a local stand-in ('local'), anything else the shared simulator ('live'). */
export function modeForOrigin(origin: string): 'live' | 'local' {
  return /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(origin) ? 'local' : 'live'
}

/**
 * Join the shared simulator with the phase text saying what is happening. A
 * failed join is stated plainly in the phase and on the console, then tried
 * again after `retryMs`: an unattended screen keeps saying why it is empty
 * instead of dying with a stack trace or waiting in silence.
 */
export async function joinVisibly<T>(
  state: FlowState,
  attempt: (onRetry: (n: number, err: unknown) => void) => Promise<T>,
  opts: { origin: string; retryMs?: number; log?: (m: string) => void; sleep?: (ms: number) => Promise<void>; maxRounds?: number },
): Promise<T> {
  const retryMs = opts.retryMs ?? 30_000
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const reason = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 100)
  for (let round = 1; ; round++) {
    state.phase = `Joining the shared simulator at ${opts.origin} (world ${state.world})`
    try {
      return await attempt((n, err) => {
        state.phase = `Joining the shared simulator at ${opts.origin}: attempt ${n} got no answer (${reason(err)}), trying again`
      })
    } catch (err) {
      state.phase = `Could not join the shared simulator at ${opts.origin}: ${reason(err)}. Trying again in ${Math.round(retryMs / 1000)} s; run without --live for the local stand-in`
      opts.log?.(state.phase)
      if (opts.maxRounds && round >= opts.maxRounds) throw err
      await sleep(retryMs)
    }
  }
}
