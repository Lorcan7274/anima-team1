/**
 * Flow simulation, offline: arrivals become people with a deterministic plan,
 * the manual-model lane queues on the same beds, and a person can be walked
 * A&E -> assessment -> take -> ward -> checklist -> home against a fake sim
 * with one action per station per tick and beds never double-booked.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
delete process.env.OPENAI_API_KEY
import type { SimClient } from '../src/sim/index.ts'
import { checklistFor, ingest, modelLane, newFlowState, stepPerson, tick, type FlowCtx } from '../src/flow/engine.ts'
import { FLOW_PAGE } from '../src/flow/ui.ts'

const T0 = 1789200000000
const MIN = 60_000

const arrival = (id: string, patientId: string, stage = 'waiting', acuity = '3', location = 'Waiting room') => ({
  id, patientId, version: 1, createdAt: T0, title: 'New A&E arrival',
  data: { stage, acuity, location, arrivalAt: T0, presentingComplaint: 'New A&E arrival', clinician: 'Unassigned' },
})
const record = (id: string, name: string, conditions: string[] = [], needs: string[] = [], goals: string[] = []) => ({ id, name, conditions, needs, goals })

test('checklist rules: everyone gets a letter and follow-up; conditions and needs add the rest', () => {
  const plain = checklistFor({ patientId: 'SIM-1', conditions: ['Hypertension'], needs: [], goals: [] })
  assert.deepEqual(plain.map((i) => i.id), ['sim-1-device', 'sim-1-summary', 'sim-1-follow-up'])
  const rich = checklistFor({ patientId: 'SIM-2', conditions: ['Heart failure', 'CKD'], needs: ['Home visit'], goals: ['Avoid unnecessary travel'] })
  assert.deepEqual(rich.map((i) => i.id), ['sim-2-bloods', 'sim-2-device', 'sim-2-visit', 'sim-2-summary', 'sim-2-follow-up'])
  assert.match(rich.at(-1)!.title, /telephone/)
  for (const i of rich) assert.equal(i.state, 'proposed')
})

test('ingest: new arrivals become people with a seeded plan and stay; seeded inpatients land in their bed', () => {
  const state = newFlowState('w')
  state.simNow = T0
  const fresh = ingest(state,
    [arrival('a1', 'SIM-1'), arrival('a2', 'SIM-2', 'inpatient', '2', 'AMU bed 3'), arrival('a3', 'SIM-3', 'discharged')],
    [record('SIM-1', 'Ann Ash', ['Asthma']), record('SIM-2', 'Bob Bay', ['Heart failure'], ['Home visit'])])
  assert.equal(fresh.length, 2, 'discharged attendances are not tracked')
  const [p1, p2] = fresh
  assert.equal(p1.flow, 'waiting')
  assert.ok(['admit', 'home-from-ae'].includes(p1.plan))
  assert.ok(p1.stayMinutes >= 120 && p1.stayMinutes <= 480)
  assert.equal(p2.flow, 'ward')
  assert.equal(p2.bed, 3)
  assert.equal(p2.plan, 'admit')
  assert.equal(p2.fitAt, T0 + p2.stayMinutes * MIN)
  assert.ok(p2.items.every((i) => i.state === 'approved'), 'admission auto-approves the checklist for the simulation')
  assert.ok(p2.modelAfterFit! > 0)
  // Same arrival again: known, not duplicated; sim ahead of us syncs forward.
  const again = ingest(state, [{ ...arrival('a1', 'SIM-1', 'take'), version: 4 }], [])
  assert.equal(again.length, 0)
  assert.equal(p1.flow, 'take')
  assert.equal(p1.version, 4)
  // Determinism: a second state with the same world seeds the same plan.
  const state2 = newFlowState('w'); state2.simNow = T0
  const [q1] = ingest(state2, [arrival('a1', 'SIM-1')], [record('SIM-1', 'Ann Ash', ['Asthma'])])
  assert.equal(q1.plan, p1.plan); assert.equal(q1.stayMinutes, p1.stayMinutes)
})

test('model lane: same arrivals queue on the same beds; a full ward makes people wait', () => {
  const state = newFlowState('w', { stepMinutes: 30, wardSize: 2, admitShareAcuity3: 1, stayMinutes: [60, 60] })
  state.simNow = T0
  const people = ingest(state, [arrival('a1', 'SIM-1', 'take'), arrival('a2', 'SIM-2', 'take'), arrival('a3', 'SIM-3', 'take')],
    [record('SIM-1', 'A A'), record('SIM-2', 'B B'), record('SIM-3', 'C C')])
  for (const p of people) p.takeAt = T0
  const early = modelLane(state, T0 + 10 * MIN)
  assert.equal(early.occupied, 2)
  assert.equal(early.waitingForBed, 1, 'third person waits for a model bed')
  const third = people.find((p) => early.people[p.attendanceId].stage === 'take')!
  const firstHome = Math.min(...people.filter((p) => p !== third).map((p) => early.people[p.attendanceId].homeAt!))
  assert.equal(early.people[third.attendanceId].admittedAt, firstHome, 'admitted when the first model bed frees')
  // Identical stays: the first two go home together and the third takes a freed bed.
  const late = modelLane(state, firstHome + 10 * MIN)
  assert.equal(late.home, 2)
  assert.equal(late.occupied, 1)
  assert.equal(late.waitingForBed, 0)
  assert.equal(late.people[third.attendanceId].stage, 'ward')
})

/** Fake sim: attendance stage machine + generic action results; records writes. */
function fakeSim() {
  const writes: Array<{ site: string; body: any; key?: string }> = []
  let now = T0
  const att: Record<string, any> = {}
  const views: Record<string, any[]> = { gp: [], hospital: [], diagnostics: [], community: [], wearables: [] }
  let seq = 500
  const sim = {
    clock: async () => ({ now }),
    advanceClock: async (min: number) => { now += min * MIN; return { now, events: [] } },
    hospitalAttendances: async () => ({ resources: Object.values(att), patients: [] }),
    siteView: async (site: string) => ({ resources: views[site] ?? [] }),
    gpDocuments: async () => ({ resources: views.gp }),
    wearables: async () => ({ view: {}, devices: [], observations: [{ kind: 'observation', data: { observedAt: now + 1, value: 1, metric: 'steps' } }] }),
    siteAppointments: async () => ({ appointments: [] }),
    siteAction: async (site: string, body: any, key?: string) => {
      writes.push({ site, body, key })
      if (body.type === 'update_attendance') {
        const a = att[body.resourceId]
        assert.equal(body.expectedVersion, a.version, 'stale version')
        const next: Record<string, string> = { assign: a.data.stage, assess: 'assessing', refer: 'take', admit: 'inpatient', discharge: 'discharged' }
        a.data.stage = next[body.hospitalCommand]
        if (body.location) a.data.location = body.location
        a.version++
        return structuredClone(a)
      }
      const id = body.resourceId ?? `r-${seq++}`
      const res = { id, status: body.type === 'process_document' ? 'sent' : 'open', version: 1 }
      if (body.type === 'create_task') views.gp.push({ id, kind: 'task', status: 'open' })
      if (body.type === 'process_document') views.gp.push({ id, status: 'sent' })
      return res
    },
    createTask: async (site: string, patientId: string, title: string, key?: string) => sim.siteAction(site, { type: 'create_task', patientId, title }, key),
    connectDevice: async (patientId: string, title: string, key?: string) => sim.siteAction('wearables', { type: 'connect_device', patientId, title }, key),
  }
  return { sim: sim as unknown as SimClient, writes, att, get now() { return now } }
}

test('a person is walked A&E -> ward -> checklist -> home, admitted as soon as a bed is free, beds never double-booked', async () => {
  const f = fakeSim()
  f.att.a1 = arrival('a1', 'SIM-1', 'waiting', '2') // acuity 2: always admitted
  f.att.a2 = arrival('a2', 'SIM-2', 'waiting', '2')
  const state = newFlowState('w', { stepMinutes: 60, wardSize: 1, admitShareAcuity3: 0, stayMinutes: [60, 60] })
  state.simNow = T0
  state.startedAt = T0
  const ctx: FlowCtx = { sim: f.sim, state, log: (m) => state.log.push(m) }
  await tick(ctx) // ingest + assign/assess
  const [p1, p2] = state.patients
  assert.deepEqual([p1.flow, p2.flow], ['assessing', 'assessing'])
  await tick(ctx) // refer, and admit in the same step when a bed is free: one bed, so one waits
  const wards = state.patients.filter((p) => p.flow === 'ward')
  assert.equal(wards.length, 1)
  assert.equal(state.patients.filter((p) => p.flow === 'take').length, 1)
  assert.equal(wards[0].bed, 1)
  const inBed = wards[0]
  assert.ok(inBed.items.length >= 2)
  // Treatment stay of 60 min: fit after the next advance; resolve then verify then discharge.
  let guard = 0
  while (inBed.flow !== 'home' && guard++ < 6) await tick(ctx)
  assert.equal(inBed.flow, 'home')
  assert.equal(inBed.homeFrom, 'ward')
  assert.ok(inBed.items.every((i) => i.state === 'verified'))
  assert.ok(f.writes.some((w) => w.body.hospitalCommand === 'discharge'))
  // The bed freed, so the second person is now admitted to the same bed.
  const other = state.patients.find((p) => p !== inBed)!
  assert.equal(other.flow, 'ward')
  assert.equal(other.bed, 1)
  assert.equal(state.errors, 0)
  const c = (await import('../src/flow/engine.ts')).counters(state, modelLane(state, state.simNow))
  assert.equal(c.homeFromWard, 1)
  assert.equal(c.occupied, 1)
})

test('a failed action is recorded on the person and retried next tick', async () => {
  const f = fakeSim()
  f.att.a1 = arrival('a1', 'SIM-1', 'waiting', '2')
  const state = newFlowState('w', { stepMinutes: 30, wardSize: 1, admitShareAcuity3: 0, stayMinutes: [60, 60] })
  state.simNow = T0
  const ctx: FlowCtx = { sim: f.sim, state, log: () => {} }
  ingest(state, [f.att.a1], [])
  const p = state.patients[0]
  const real = (f.sim as any).siteAction
  ;(f.sim as any).siteAction = async () => { throw new Error('HTTP 0: no response within 45000ms') }
  await stepPerson(ctx, p)
  assert.match(p.error!, /no response/)
  assert.equal(p.flow, 'waiting')
  ;(f.sim as any).siteAction = real
  await stepPerson(ctx, p)
  assert.equal(p.error, undefined)
  assert.equal(p.flow, 'assessing')
})

test('flow page browser script parses', () => {
  const script = FLOW_PAGE.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script)
  assert.doesNotThrow(() => new vm.Script(script!))
})
