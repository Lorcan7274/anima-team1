/**
 * Flow simulation, offline: arrivals become people with a deterministic plan,
 * the manual-model lane queues on the same beds, and a person can be walked
 * A&E -> assessment -> take -> ward -> checklist -> home against a fake sim
 * with one action per station per tick and beds never double-booked. Then
 * the script's flags, the stand-in's fidelity, the manual model's pressure
 * response and counters, the visible join, the page copy, and a 200-tick run
 * of the stand-in checking every invariant with and without archiving.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
delete process.env.OPENAI_API_KEY
import type { SimClient } from '../src/sim/index.ts'
import { DEFAULT_FLOW, checklistFor, ingest, modelLane, newFlowState, stepPerson, tick, type FlowCtx } from '../src/flow/engine.ts'
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
  assert.ok(p1.stayMinutes >= 60 && p1.stayMinutes <= 180)
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
  const state = newFlowState('w', { stepMinutes: 30, wardSize: 2, admitShareAcuity3: 1, stayMinutes: [60, 60], modelMaxWaitMinutes: 100000 })
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
  const state = newFlowState('w', { stepMinutes: 60, wardSize: 1, admitShareAcuity3: 0, stayMinutes: [60, 60], modelMaxWaitMinutes: 240 })
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
  const state = newFlowState('w', { stepMinutes: 30, wardSize: 1, admitShareAcuity3: 0, stayMinutes: [60, 60], modelMaxWaitMinutes: 240 })
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

test('offline stand-in: the two lanes diverge after people become fit, with no failed actions', async () => {
  const { offlineSim } = await import('../src/flow/offline.ts')
  const { counters } = await import('../src/flow/engine.ts')
  const sim = offlineSim('test-seed')
  const state = newFlowState('offline-test')
  state.mode = 'offline'
  state.simNow = sim.nowMs
  state.startedAt = sim.nowMs
  const ctx: FlowCtx = { sim, state, log: () => {} }
  for (let i = 0; i < 40; i++) await tick(ctx) // 20 simulated hours
  const c = counters(state, modelLane(state, state.simNow))
  assert.equal(state.errors, 0, 'no action ever fails against the stand-in')
  assert.ok(state.arrivals > 60, `arrivals ${state.arrivals}`)
  assert.ok(c.homeFromWard >= 3, `ward discharges ${c.homeFromWard}`)
  // The manual ward holds beds for a day or more, so it saturates and queues people on the take;
  // Homeward's ward turns beds over and sends more people home.
  assert.ok(c.modelOccupied >= c.occupied, `model beds ${c.modelOccupied} vs agent ${c.occupied}`)
  assert.ok(c.modelWaitingForBed > c.waitingForBed, `model queue ${c.modelWaitingForBed} vs agent ${c.waitingForBed}`)
  // ...but the queue is bounded, because the manual ward resets under pressure by sending fit people home early.
  assert.ok(c.modelWaitingForBed <= 16, `model queue bounded: ${c.modelWaitingForBed}`)
  assert.ok(c.modelForcedHome > 0, 'some people were sent home early with items outstanding')
  assert.ok(c.home >= c.modelHome - c.modelForcedHome, `safe discharges ${c.home} vs model ${c.modelHome - c.modelForcedHome}`)
  assert.ok(c.bedHoursSaved > 0)
  // Every verified item was verified by the real verifier against the stand-in's timed resources.
  const verified = state.patients.flatMap((p) => p.items).filter((i) => i.state === 'verified')
  assert.ok(verified.every((i) => i.verification?.passed && i.resolution?.resourceId))
})

// --- Regressions and the long run ------------------------------------------

test('args: no flags is the local stand-in; --live selects the simulator; --offline is a no-op alias; --replay wins', async () => {
  const { parseFlowArgs } = await import('../src/flow/engine.ts')
  assert.equal(parseFlowArgs([]).mode, 'offline')
  assert.equal(parseFlowArgs(['--offline']).mode, 'offline')
  assert.equal(parseFlowArgs(['--live']).mode, 'live')
  assert.equal(parseFlowArgs(['--replay', '--live']).mode, 'replay')
  assert.equal(parseFlowArgs(['--replay', '--replay-file', 'x.json']).replayFile, 'x.json')
  assert.equal(parseFlowArgs([]).replayFile, 'flow-state.json')
  const a = parseFlowArgs(['--step', '60', '--beds', '8', '--stay', '60-240', '--port', '4711', '--pause-ms', '50', '--world', 'w1'])
  assert.deepEqual([a.params.stepMinutes, a.params.wardSize, a.params.stayMinutes, a.port, a.pauseMs, a.world], [60, 8, [60, 240], 4711, 50, 'w1'])
  assert.deepEqual(a.warnings, [])
  assert.equal(parseFlowArgs([]).pauseMs, undefined, 'the script picks the pause for the mode')
  assert.equal(parseFlowArgs(['--llm']).warnings.length, 1, '--llm without --live is said to be ignored')
})

test('args: a reversed --stay is normalised; junk or out-of-range numbers fall back to the defaults with a warning, never NaN', async () => {
  const { parseFlowArgs, DEFAULT_FLOW } = await import('../src/flow/engine.ts')
  assert.deepEqual(parseFlowArgs(['--stay', '240-60']).params.stayMinutes, [60, 240])
  for (const bad of [['--stay', '60'], ['--stay', 'abc-def'], ['--stay', '0-100']]) {
    const a = parseFlowArgs(bad)
    assert.deepEqual(a.params.stayMinutes, DEFAULT_FLOW.stayMinutes, bad.join(' '))
    assert.equal(a.warnings.length, 1)
  }
  const a = parseFlowArgs(['--step', 'abc', '--beds', '0', '--port', 'abc', '--pause-ms', '-1'])
  assert.equal(a.params.stepMinutes, DEFAULT_FLOW.stepMinutes)
  assert.equal(a.params.wardSize, DEFAULT_FLOW.wardSize)
  assert.equal(a.port, 4700)
  assert.equal(a.pauseMs, 0)
  assert.equal(a.warnings.length, 4)
  for (const v of [a.params.stepMinutes, a.params.wardSize, a.port, a.pauseMs]) assert.ok(Number.isFinite(v))
})

test('the model key is emptied, not deleted: reloading .env (joinWorld does) puts a deleted key back but leaves an empty one alone', async () => {
  const { loadDotEnv } = await import('../src/sim/config.ts')
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'flow-env-'))
  const file = join(dir, '.env')
  writeFileSync(file, 'FLOW_TEST_KEY=from-dot-env\n')
  delete process.env.FLOW_TEST_KEY
  assert.ok(loadDotEnv(file))
  assert.equal(process.env.FLOW_TEST_KEY, 'from-dot-env')
  delete process.env.FLOW_TEST_KEY
  loadDotEnv(file)
  assert.equal(process.env.FLOW_TEST_KEY, 'from-dot-env', 'a deleted key comes back on the next load')
  process.env.FLOW_TEST_KEY = ''
  loadDotEnv(file)
  assert.equal(process.env.FLOW_TEST_KEY, '', 'an emptied key stays empty, so the canned-draft promise holds')
  delete process.env.FLOW_TEST_KEY
})

test('offline stand-in: a patient-id collision among the seeded arrivals is redrawn, so the department always starts with six people', async () => {
  const { offlineSim } = await import('../src/flow/offline.ts')
  // Found by search: the sixth draw of this seed repeats an earlier id; the old code silently dropped the arrival (five attendances).
  const sim = offlineSim('offline-2a42')
  const att = await sim.hospitalAttendances() as { resources: any[]; patients: any[] }
  assert.equal(att.resources.length, 6)
  assert.equal(new Set(att.resources.map((a) => a.patientId)).size, 6)
  assert.equal(att.patients.length, 6, 'the records returned are those of the listed attendances')
  assert.deepEqual(att.resources.slice(0, 4).map((a) => a.data.stage), ['inpatient', 'inpatient', 'take', 'assessing'])
})

test('offline stand-in: process_document checks the version it is given, like the real simulator, so a summary is not sent twice', async () => {
  const { offlineSim } = await import('../src/flow/offline.ts')
  const sim = offlineSim('test-seed')
  const saved = await sim.siteAction('hospital', { type: 'save_discharge_summary', patientId: 'SIM-1', title: 't', dischargeSections: {} } as any) as any
  assert.equal(saved.version, 1)
  const sent = await sim.siteAction('hospital', { type: 'process_document', patientId: 'SIM-1', resourceId: saved.id, expectedVersion: 1, documentCommand: 'send' } as any) as any
  assert.equal(sent.status, 'sent')
  assert.equal(sent.version, 2)
  await assert.rejects(
    sim.siteAction('hospital', { type: 'process_document', patientId: 'SIM-1', resourceId: saved.id, expectedVersion: 1, documentCommand: 'send' } as any),
    (err: any) => err.status === 409,
  )
  const gp = await sim.gpDocuments() as { resources: any[] }
  assert.equal(gp.resources.filter((d) => d.id === saved.id).length, 1)
})

const takeArrival = (i: number) => arrival(`a${String(i).padStart(2, '0')}`, `P${i}`, 'take', '2')

test('model lane pressure response: a queue that has waited longer than every occupant has been in still gets beds at the next round', async () => {
  const { counters } = await import('../src/flow/engine.ts')
  const H = 60 * MIN
  // Two beds, forty people reaching the take over two hours, manual-model stays of five days after fit.
  const state = newFlowState('w', { stepMinutes: 30, wardSize: 2, admitShareAcuity3: 1, stayMinutes: [60, 60], modelMaxWaitMinutes: 240, retainHomeMinutes: Infinity })
  state.simNow = T0; state.startedAt = T0
  const people = ingest(state, Array.from({ length: 40 }, (_, i) => takeArrival(i)), [])
  people.forEach((p, i) => { p.takeAt = T0 + i * 3 * MIN; p.modelAfterFit = 5 * 24 * H })
  const late = modelLane(state, T0 + 30 * 24 * H)
  // Old rule: the eviction round was tied to the queued person's own arrival, so once the queue ran
  // behind the occupants nobody was eligible and 34 of the 40 were never admitted.
  for (const p of people) {
    const m = late.people[p.attendanceId]
    assert.ok(m.admittedAt! < T0 + 30 * 24 * H, `${p.attendanceId} admitted`)
    assert.equal(m.stage, 'home')
  }
  const waits = people.map((p) => (late.people[p.attendanceId].admittedAt! - p.takeAt!) / H)
  assert.ok(Math.max(...waits) <= 40 * 2, `longest wait ${Math.max(...waits)} h: one eviction per ward round per bed at most`)
  // Evictions happen on the two-hourly ward-round grid, and only after the wait limit.
  for (const p of people) {
    const m = late.people[p.attendanceId]
    assert.equal((m.admittedAt! - T0) % (120 * MIN) === 0 || m.admittedAt === p.takeAt, true)
    assert.ok(m.admittedAt === p.takeAt || m.admittedAt! - p.takeAt! >= 240 * MIN)
  }
  assert.ok(late.forcedHome >= 36, `forced discharges ${late.forcedHome}`)
  // Along the way the queue is bounded and nobody is in two places.
  for (let h = 0; h < 96; h += 2) {
    const lane = modelLane(state, T0 + h * H)
    assert.ok(lane.occupied <= 2)
    assert.equal(lane.occupied + lane.waitingForBed + lane.home, 40)
  }
  const c = counters(state, late)
  assert.ok(Number.isFinite(c.bedHoursSaved))
})

test('bed-hours saved is the model ward\'s bed-hours minus Homeward\'s, never more than the beds could hold', async () => {
  const { counters } = await import('../src/flow/engine.ts')
  const H = 60 * MIN
  const state = newFlowState('w', { stepMinutes: 30, wardSize: 1, admitShareAcuity3: 1, stayMinutes: [60, 60], modelMaxWaitMinutes: 100000, retainHomeMinutes: Infinity })
  state.simNow = T0; state.startedAt = T0
  const [p1, p2] = ingest(state, [arrival('b1', 'Q1', 'inpatient', '2'), arrival('b2', 'Q2', 'take', '2')], [])
  // Homeward: p1 in the one bed for 2 h, then p2 for 2 h. The model keeps p1 a day; p2 is still queued.
  p1.takeAt = T0; p1.admittedAt = T0; p1.modelAfterFit = 24 * H; p1.flow = 'home'; p1.homeFrom = 'ward'; p1.dischargedAt = T0 + 2 * H
  p2.takeAt = T0; p2.modelAfterFit = 24 * H; p2.flow = 'home'; p2.homeFrom = 'ward'; p2.admittedAt = T0 + 2 * H; p2.dischargedAt = T0 + 4 * H; p2.bed = 1
  state.simNow = T0 + 6 * H
  const model = modelLane(state, state.simNow)
  assert.equal(model.people.b2.stage, 'take', 'the model has not admitted p2 yet')
  const c = counters(state, model)
  // The old per-person sum counted 4 h for p1 plus 2 h for p2, who was not in a model bed at all: 6 h from one bed in 6 h with Homeward using 4 of them.
  assert.equal(c.bedHoursSaved, 2)
  assert.ok(c.bedHoursSaved <= state.params.wardSize * 6)
  assert.equal(c.medianDoorToHomeHours, 4, 'upper median of 2 h and 4 h')
  assert.equal(c.homeFromWard, 2)
})

test('a --live run is reported as local when SIM_ORIGIN is a loopback address, so a stand-in is never mistaken for the shared world', async () => {
  const { modeForOrigin } = await import('../src/flow/engine.ts')
  assert.equal(modeForOrigin('https://sim.animahacks.com'), 'live')
  assert.equal(modeForOrigin('http://127.0.0.1:4799'), 'local')
  assert.equal(modeForOrigin('http://localhost:8080/'), 'local')
  assert.equal(modeForOrigin('http://[::1]:4799'), 'local')
  assert.equal(modeForOrigin('http://127.0.0.1.example.com'), 'live', 'a lookalike host is not local')
})

test('joinVisibly: a failed join is said plainly in the phase and tried again; each attempt is narrated', async () => {
  const { joinVisibly } = await import('../src/flow/engine.ts')
  const state = newFlowState('discharge-flow-abc')
  const phases: string[] = []
  const slept: number[] = []
  let calls = 0
  const sim = await joinVisibly(state, async (onRetry) => {
    calls++
    phases.push(state.phase!)
    if (calls === 1) { onRetry(1, new Error('HTTP 0: no response within 12000ms')); phases.push(state.phase!); throw new Error('HTTP 0: no response within 12000ms') }
    return { ok: true }
  }, { origin: 'https://sim.example', retryMs: 30_000, sleep: async (ms) => { slept.push(ms) }, log: (m) => phases.push('log: ' + m) })
  assert.deepEqual(sim, { ok: true })
  assert.equal(calls, 2)
  assert.deepEqual(slept, [30_000])
  assert.match(phases[0], /^Joining the shared simulator at https:\/\/sim\.example \(world discharge-flow-abc\)/)
  assert.match(phases[1], /attempt 1 got no answer \(HTTP 0: no response within 12000ms\)/)
  assert.match(phases[2], /^log: Could not join the shared simulator at https:\/\/sim\.example: HTTP 0.*Trying again in 30 s; run without --live for the local stand-in/)
  // With a cap on rounds the failure propagates instead of retrying forever.
  const s2 = newFlowState('w2')
  await assert.rejects(joinVisibly(s2, async () => { throw new Error('fetch failed') }, { origin: 'http://127.0.0.1:9', maxRounds: 2, sleep: async () => {} }), /fetch failed/)
  assert.match(s2.phase!, /^Could not join the shared simulator at http:\/\/127\.0\.0\.1:9: fetch failed/)
})

test('the page states the mode in the exact words, shows the phase, and reads its assumptions from the engine parameters', () => {
  assert.ok(FLOW_PAGE.includes('Local stand-in: no simulator connected, outcomes follow the timings verified in the real simulator'))
  assert.ok(FLOW_PAGE.includes('Replay of a recorded run'))
  assert.ok(FLOW_PAGE.includes('Live: shared simulator world'))
  assert.ok(FLOW_PAGE.includes("id=\"phase\""))
  assert.ok(FLOW_PAGE.includes('Screen not reachable'))
  for (const param of ['stay[0]', 'stay[1]', 'P.admitShareAcuity3', 'P.modelMaxWaitMinutes', 's.arrivalsPerHour']) assert.ok(FLOW_PAGE.includes(param), param)
  // A title is a property, so the complaint must not be entity-escaped there.
  assert.ok(!/el\.title = [^\n]*esc\(/.test(FLOW_PAGE))
})

/** Two hundred ticks of the stand-in with a fixed seed: the invariants the screen relies on, and the archive changes nothing visible. */
test('long run: 200 ticks offline keep every invariant, stay bounded, and archiving is invisible to the counters and the model lane', { timeout: 10_000 }, async () => {
  const { offlineSim } = await import('../src/flow/offline.ts')
  const { counters, archiveSettled } = await import('../src/flow/engine.ts')
  const run = async (retainHomeMinutes: number) => {
    const sim = offlineSim('long-run-seed')
    const state = newFlowState('offline-long', { ...DEFAULT_FLOW, retainHomeMinutes })
    state.mode = 'offline'
    state.simNow = sim.nowMs
    state.startedAt = sim.nowMs
    const log: string[] = []
    const ctx: FlowCtx = { sim, state, log: (m) => { log.push(m); if (log.length > 400) log.shift() } }
    // Every discharge from the ward must happen with every item verified: check at the moment of the action.
    const realAction = (sim as any).siteAction
    let wardDischarges = 0
    ;(sim as any).siteAction = async (site: string, body: any, key?: string) => {
      if (body.type === 'update_attendance' && body.hospitalCommand === 'discharge') {
        const p = state.patients.find((x) => x.attendanceId === body.resourceId)!
        if (p.flow === 'ward') { wardDischarges++; assert.ok(p.items.length > 0 && p.items.every((i) => i.state === 'verified'), `${p.patientId} discharged with ${p.items.map((i) => i.state)}`) }
      }
      return realAction(site, body, key)
    }
    let maxPeople = 0
    const bedsSeen: number[] = []
    for (let i = 0; i < 200; i++) {
      await tick(ctx)
      const ward = state.patients.filter((p) => p.flow === 'ward')
      assert.ok(ward.length <= state.params.wardSize, `tick ${i}: ${ward.length} in ${state.params.wardSize} beds`)
      const beds = ward.map((p) => p.bed!)
      assert.equal(new Set(beds).size, beds.length, `tick ${i}: two people in one bed`)
      for (const b of beds) assert.ok(b >= 1 && b <= state.params.wardSize)
      for (const p of state.patients) {
        // One stage per person, and the timestamps that stage implies.
        if (p.flow === 'ward') assert.ok(p.admittedAt !== undefined && p.fitAt !== undefined && p.dischargedAt === undefined && p.bed !== undefined)
        if (p.flow === 'home') assert.ok(p.dischargedAt !== undefined && p.homeFrom !== undefined)
        if (p.flow === 'take') assert.ok(p.takeAt !== undefined && p.admittedAt === undefined && p.bed === undefined)
        for (const v of [p.arrivedAt, p.assessedAt, p.takeAt, p.admittedAt, p.fitAt, p.dischargedAt]) if (v !== undefined) assert.ok(Number.isFinite(v) && v >= p.arrivedAt)
        assert.ok(p.stayMinutes >= 60 && p.stayMinutes <= 180)
        for (const it of p.items) assert.ok(!/TypeError|ReferenceError|is not a function|Cannot read|undefined/.test(it.error ?? ''), `${it.id}: ${it.error}`)
      }
      assert.ok(state.events.length <= 40 && (state.ticks?.length ?? 0) <= 10 && log.length <= 400)
      const c = counters(state, modelLane(state, state.simNow))
      for (const [k, v] of Object.entries(c)) if (v !== null) assert.ok(Number.isFinite(v as number), `${k}=${v}`)
      assert.ok(c.modelWaitingForBed <= 40, `tick ${i}: model queue ${c.modelWaitingForBed}`)
      maxPeople = Math.max(maxPeople, state.patients.length)
      bedsSeen.push(c.occupied)
    }
    assert.equal(archiveSettled(state), 0, 'a tick leaves nothing left to archive')
    return { state, wardDischarges, maxPeople, counters: counters(state, modelLane(state, state.simNow)), model: modelLane(state, state.simNow), bedsSeen }
  }
  const kept = await run(Infinity)
  const archived = await run(DEFAULT_FLOW.retainHomeMinutes!)
  assert.equal(kept.state.errors, 0)
  assert.ok(kept.wardDischarges >= 100, `ward discharges ${kept.wardDischarges}`)
  assert.ok(kept.counters.home > 500)
  assert.ok(Math.max(...kept.bedsSeen) === DEFAULT_FLOW.wardSize, 'the ward fills at some point')
  assert.ok(kept.state.patients.length > 600 && kept.maxPeople > 600, 'without archiving everyone stays')
  assert.ok(archived.maxPeople < 320, `with archiving the state stays bounded: ${archived.maxPeople} at most`)
  assert.ok(archived.state.archive!.people > 300)
  // What the screen shows is identical either way.
  assert.deepEqual(archived.counters, kept.counters)
  assert.equal(archived.state.arrivals, kept.state.arrivals)
  assert.equal(archived.wardDischarges, kept.wardDischarges)
  for (const p of archived.state.patients) {
    const a = archived.model.people[p.attendanceId], k = kept.model.people[p.attendanceId]
    assert.deepEqual({ stage: a.stage, admittedAt: a.admittedAt, homeAt: a.homeAt, forced: a.forced }, { stage: k.stage, admittedAt: k.admittedAt, homeAt: k.homeAt, forced: k.forced }, p.attendanceId)
    const q = kept.state.patients.find((x) => x.attendanceId === p.attendanceId)!
    assert.deepEqual({ flow: p.flow, bed: p.bed, dischargedAt: p.dischargedAt }, { flow: q.flow, bed: q.bed, dischargedAt: q.dischargedAt })
  }
  // A discharged attendance the stand-in still lists is not re-ingested after its person was archived.
  const before = archived.state.patients.length
  const att = await offlineSim('long-run-seed').hospitalAttendances() as { resources: any[]; patients: any[] }
  ingest(archived.state, att.resources.map((a) => ({ ...a, data: { ...a.data, stage: 'discharged' } })), att.patients)
  assert.equal(archived.state.patients.length, before)
})

// --- Driving the page's own script under node: a stub DOM just big enough to lay out both lanes -------------------
class El {
  innerHTML = ''; textContent = ''; className = ''; title = ''; clientWidth = 1000
  offsetLeft = 10; offsetTop = 10; offsetWidth = 60; offsetHeight = 44
  style: Record<string, string> = {}; dataset: Record<string, string> = {}
  children: El[] = []; parentElement: El | null = null; removed = false
  classes = new Set<string>()
  classList = {
    add: (c: string) => { this.classes.add(c) }, remove: (c: string) => { this.classes.delete(c) },
    toggle: (c: string, on?: boolean) => { const want = on === undefined ? !this.classes.has(c) : on; if (want) this.classes.add(c); else this.classes.delete(c); return want },
  }
  tag: string
  constructor(tag = 'div') { this.tag = tag }
  appendChild(c: El) { c.parentElement = this; this.children.push(c); return c }
  remove() { this.removed = true }
  insertAdjacentHTML(_where: string, html: string) { this.innerHTML += html }
  querySelector(sel: string): El | null {
    const station = sel.match(/\.station\[data-key="(\w+)"\] \.n/)
    if (station) { const st = this.children.find((c) => c.dataset.key === station[1]); if (!st) return null; return (st.children.find((c) => c.tag === 'n') ?? st.appendChild(new El('n'))) }
    if (/\.bed\[data-bed="\d+"\]/.test(sel)) { const bed = new El('bed'); bed.parentElement = new El('beds'); return bed }
    if (sel === '.dots') return this.children.find((c) => c.tag === 'dots') ?? this.appendChild(new El('dots'))
    return null
  }
  querySelectorAll() { return [] as El[] }
}
function loadFlowPage(fetchImpl: (url: string) => Promise<unknown>) {
  const script = FLOW_PAGE.match(/<script>([\s\S]*?)<\/script>/)![1]
  const els = new Map<string, El>()
  const byId = (id: string) => { let e = els.get(id); if (!e) { e = new El(); els.set(id, e) } return e }
  const document = { getElementById: byId, createElement: (tag: string) => new El(tag), querySelectorAll: () => [] as El[] }
  const ctx = vm.createContext({ document, fetch: fetchImpl, setInterval: () => 0, requestAnimationFrame: (f: () => void) => f(), window: { addEventListener: () => {} }, console })
  vm.runInContext(script, ctx)
  return { byId, render: (s: unknown) => { ctx.__s = s; vm.runInContext('render(__s)', ctx) }, tick: () => vm.runInContext('tick()', ctx) as Promise<void> }
}

test('the page renders a real snapshot of the stand-in: exact mode copy, phase, counters, assumptions, and both lanes laid out', async () => {
  const { offlineSim } = await import('../src/flow/offline.ts')
  const { snapshot } = await import('../src/flow/engine.ts')
  const sim = offlineSim('page-seed')
  const state = newFlowState('offline-page')
  state.mode = 'offline'; state.arrivalsPerHour = 7; state.drafts = 'canned'
  state.simNow = sim.nowMs; state.startedAt = sim.nowMs
  const ctx: FlowCtx = { sim, state, log: () => {} }
  for (let i = 0; i < 30; i++) await tick(ctx)
  const page = loadFlowPage(async () => { throw new TypeError('fetch failed') })
  const s = snapshot(state)
  page.render(s)
  assert.equal(page.byId('modeLine').textContent, 'Local stand-in: no simulator connected, outcomes follow the timings verified in the real simulator')
  assert.match(page.byId('phase').textContent, /^Tick 30 done · \d+\/12 beds · \d+ home · measured \d+ sim-min per real second$/)
  assert.equal(page.byId('modeTag').textContent, 'local stand-in · verified simulator timings')
  const facts = page.byId('facts').innerHTML
  assert.match(facts, new RegExp(`<b>${state.arrivals}</b> arrivals`))
  assert.match(facts, new RegExp(`Homeward: <b>${s.counters.home}</b> home \\(${s.counters.homeFromWard} from the ward\\), median door-to-home <b>${s.counters.medianDoorToHomeHours!.toFixed(1)} h</b>`))
  assert.match(facts, new RegExp(`bed-hours saved vs today&#39;s ward: <b>${s.counters.bedHoursSaved.toFixed(1)}</b>`))
  const assumed = page.byId('assumed').textContent
  assert.match(assumed, /seeded 60-180 min stay; acuity 1-2 are admitted and 25% of acuity 3; 12 beds in both wards; arrivals generated locally at about 7 per sim-hour/)
  assert.match(assumed, /waited 240 min; letters are the canned draft\./)
  assert.equal(page.byId('warn').style.display, 'none')
  // Both lanes laid out: a figure per person on screen up to each station's capacity (columns x 4 rows at 1000 px), the ward figures carrying their checklist dots.
  const figures = (lane: El) => lane.children.filter((c) => c.className.startsWith('fig'))
  const capacity: Record<string, number> = { waiting: 12, assessing: 12, take: 12, ward: 40, home: 12 }
  const expectedFigures = Object.entries(capacity).reduce((n, [stage, cap]) => n + Math.min(cap, s.patients.filter((p) => p.flow === stage).length), 0)
  assert.equal(figures(page.byId('laneAgent')).length, expectedFigures)
  const inBed = figures(page.byId('laneAgent')).filter((f) => /fig (ward|fit)/.test(f.className))
  assert.equal(inBed.length, s.counters.occupied)
  assert.ok(inBed.every((f) => f.title.includes('items verified') && !f.title.includes('&amp;')))
  assert.ok(figures(page.byId('laneModel')).length > 0)
  // The home station counts everyone, including the archived.
  assert.equal(page.byId('laneAgent').querySelector('.station[data-key="home"] .n')!.textContent, String(s.counters.home))
  // A join in trouble is shown in red with the warning badge; a replay says so.
  page.render({ ...s, mode: 'live', simOrigin: 'https://sim.example', world: 'discharge-flow-1', phase: 'Could not join the shared simulator at https://sim.example: fetch failed. Trying again in 30 s; run without --live for the local stand-in' })
  assert.equal(page.byId('modeLine').textContent, 'Live: shared simulator world discharge-flow-1 at https://sim.example, every move is a real action in the simulator')
  assert.equal(page.byId('phase').className, 'phase bad')
  assert.equal(page.byId('warn').style.display, '')
  page.render({ ...s, mode: 'snapshot', recordedMode: 'offline', phase: 'Replay of a recorded run, 30 ticks, simulator not connected' })
  assert.equal(page.byId('modeLine').textContent, 'Replay of a recorded run (local stand-in), no simulator connected')
  assert.equal(page.byId('modeTag').textContent, 'replay · simulator not connected')
  // The flow process going away is said on the page after three failed polls, not left as a frozen screen.
  for (let i = 0; i < 3; i++) await page.tick()
  assert.match(page.byId('phase').textContent, /^Screen not reachable: the flow process is not answering \(\d+ polls, fetch failed\)\. Has it stopped\?$/)
})
