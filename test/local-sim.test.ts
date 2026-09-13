/**
 * The local simulator stand-in (src/sim/local): the API mechanics the
 * orchestrator was verified against, checked on the pure handler with no
 * sockets, then the whole demo driven end to end over real HTTP with the
 * unchanged SimClient and orchestrator, in a few seconds and with no network.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
delete process.env.OPENAI_API_KEY // canned drafts: no model calls
process.env.SIM_KEY = ''
import { LocalSim, keyForTeam, normaliseTeamName } from '../src/sim/local/api.ts'
import { DEMO_START, seedDemoWorld } from '../src/sim/local/seed.ts'
import { LocalWorld, PANELS, TIMINGS, type LocalResource, type LocalResponse } from '../src/sim/local/world.ts'
import { startLocalSim, type LocalSimServer } from '../src/sim/local/server.ts'
import { SimApiError, SimClient } from '../src/sim/index.ts'
import type { TraceEntry } from '../src/sim/http.ts'
import { admitToWard, dischargeAttendance, joinWorld } from '../src/orchestrator/world.ts'
import { approveAll, buildBoard, clearHold, detectAll, readyForDischarge, runUntilSettled } from '../src/orchestrator/run.ts'
import { refreshStage } from '../src/orchestrator/detect.ts'
import { annotate } from '../src/orchestrator/trace.ts'
import type { ChecklistItem, OrchestratorContext } from '../src/orchestrator/model.ts'

const MIN = 60_000
const AMIRA = 'SIM-000001'
const ELEANOR = 'SIM-000006'

/** A seeded world plus a handle that speaks the API with the team key already attached. */
function world(name = 'Unit Test World') {
  const api = new LocalSim()
  const { world: w, apiKey } = api.world(name)
  const headers = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${apiKey}`, ...extra })
  const get = (path: string, query: Record<string, string> = {}) => api.handle({ method: 'GET', path, query, headers: headers() })
  const post = (path: string, body: unknown, key?: string) => api.handle({ method: 'POST', path, body, headers: headers(key ? { 'idempotency-key': key } : {}) })
  const act = (site: string, body: Record<string, unknown>, key?: string) => post(`/api/sites/${site}/actions`, body, key)
  const advance = (minutes: number) => post('/api/clock', { paused: true, advanceMinutes: minutes })
  const view = (site: string, patient?: string) => (get(`/api/sites/${site}/view`, patient ? { patient, limit: '500' } : { limit: '500' }).body as { resources: LocalResource[] }).resources
  const res = (r: LocalResponse) => r.body as LocalResource
  return { api, w, apiKey, get, post, act, advance, view, res }
}

test('no key needed for healthz, the catalogue and openapi; every other /api path answers with the observed 401 body; unknown paths get the observed 404 body', () => {
  const api = new LocalSim()
  assert.equal(api.handle({ method: 'GET', path: '/healthz' }).status, 200)
  const cat = api.handle({ method: 'GET', path: '/api/catalogue' }).body as { sites: Array<{ id: string }> }
  assert.deepEqual(cat.sites.map((s) => s.id), ['gp', 'hospital', 'community', 'pharmacy', 'diagnostics', 'referrals', 'wearables', 'patient'])
  assert.equal(api.handle({ method: 'GET', path: '/api/openapi.json' }).status, 200)
  assert.deepEqual(api.handle({ method: 'GET', path: '/api/clock' }), { status: 401, body: { error: 'Get a team API key at POST /api/keys' } })
  assert.deepEqual(api.handle({ method: 'GET', path: '/api/sites/gp/view', headers: { authorization: 'Bearer nope' } }), { status: 401, body: { error: 'Get a team API key at POST /api/keys' } })
  assert.deepEqual(api.handle({ method: 'GET', path: '/nope' }), { status: 404, body: { error: 'Unknown API endpoint' } })
  const { apiKey } = api.world('t')
  assert.deepEqual(api.handle({ method: 'GET', path: '/api/sites/gp/nope', headers: { authorization: `Bearer ${apiKey}` } }), { status: 404, body: { error: 'Unknown API endpoint' } })
  assert.equal(api.handle({ method: 'GET', path: '/api/sites/bank/view', headers: { authorization: `Bearer ${apiKey}` } }).status, 404)
})

test('POST /api/keys: names are lowercased with whitespace removed, the same name is a join code, and a fresh world is seeded at the demo clock', () => {
  const api = new LocalSim()
  const first = api.handle({ method: 'POST', path: '/api/keys', body: { teamName: 'Team One Demo' } })
  assert.equal(first.status, 201)
  const a = first.body as { apiKey: string; world: string; created: boolean }
  assert.equal(a.world, 'teamonedemo')
  assert.equal(a.created, true)
  const second = api.handle({ method: 'POST', path: '/api/keys', body: { teamName: 'TEAM one demo' } })
  assert.equal(second.status, 200)
  const b = second.body as { apiKey: string; world: string; created: boolean }
  assert.equal(b.apiKey, a.apiKey, 'the same name always returns the same key')
  assert.equal(b.created, false)
  assert.equal(api.worlds.size, 1)
  assert.equal(a.apiKey, keyForTeam('teamonedemo'))
  assert.equal(normaliseTeamName(' Discharge Demo 1 '), 'dischargedemo1')
  assert.equal(api.handle({ method: 'POST', path: '/api/keys', body: {} }).status, 400)
  const clock = api.handle({ method: 'GET', path: '/api/clock', headers: { authorization: `Bearer ${a.apiKey}` } }).body as { now: number; paused: boolean; speed: number }
  assert.equal(clock.now, DEMO_START)
  assert.equal(clock.paused, true)
  assert.equal(clock.speed, 60)
  assert.notEqual(api.handle({ method: 'POST', path: '/api/keys', body: { teamName: 'other' } }).body, undefined)
  assert.equal(api.worlds.size, 2, 'a different name is a different world')
})

test('the seed matches the brief: eight attendances at their stages, Amira and Eleanor as described, the traps in place', () => {
  const { w, view, get } = world()
  const atts = (get('/api/sites/hospital/attendances').body as { resources: LocalResource[]; patients: unknown[] })
  assert.equal(atts.resources.length, 8)
  assert.equal(atts.patients.length, 8, 'every referenced directory patient rides along')
  const stages = atts.resources.map((a) => `${a.patientId}:${a.data.stage}:${a.data.location}`)
  assert.deepEqual(stages, [
    'SIM-000001:waiting:Waiting room', 'SIM-000002:waiting:Waiting room', 'SIM-000003:waiting:Waiting room', 'SIM-000004:assessing:Majors 1',
    'SIM-000005:take:Majors 2', 'SIM-000006:take:AMU bed 1', 'SIM-000007:inpatient:AMU bed 2', 'SIM-000008:inpatient:AMU bed 3',
  ])
  const amira = atts.resources[0]
  assert.equal(amira.id, 'hospital-attendance-seed-0')
  assert.equal(amira.title, 'Breathlessness')
  assert.equal(amira.data.acuity, '2')
  assert.equal(amira.data.arrivalAt, DEMO_START - 35 * MIN)
  assert.equal(amira.data.clinician, 'Unassigned')
  const hosp = view('hospital', AMIRA)
  const r1 = hosp.find((r) => r.id === 'r-1')!
  assert.equal(r1.kind, 'document')
  assert.equal(r1.data.text, 'Blood monitoring requested; home equipment and medication handover not confirmed.')
  assert.deepEqual(r1.visibleTo, ['hospital'])
  const r3 = hosp.find((r) => r.id === 'r-3')!
  assert.equal(r3.kind, 'prescription'); assert.equal(r3.status, 'approved'); assert.equal(r3.data.drug, 'Furosemide tablets')
  assert.ok(view('pharmacy', AMIRA).some((r) => r.id === 'r-3'), 'the prescription is in the pharmacy view too')
  const product = view('pharmacy', AMIRA).find((r) => r.kind === 'pharmacy-product')!
  assert.deepEqual({ drug: product.data.drug, packSize: product.data.packSize, stock: product.data.stock }, { drug: 'Furosemide tablets', packSize: 28, stock: 84 })
  assert.equal(product.patientId, undefined, 'the catalogue is patient-less yet returned for a patient query')
  const r6 = hosp.find((r) => r.id === 'r-6')!
  assert.equal(r6.kind, 'message'); assert.equal(r6.status, 'open'); assert.equal(r6.priority, 'urgent')
  assert.equal(r6.title, 'Respiratory: review worsening oxygen requirement')
  assert.equal(hosp.find((r) => r.id === 'r-7')!.title, 'Discharge & flow: confirm medication handover')
  const gpDocs = (get('/api/sites/gp/documents').body as { resources: LocalResource[] }).resources
  const old = gpDocs.find((r) => r.patientId === AMIRA && r.kind === 'discharge-summary')!
  assert.equal(old.status, 'sent', 'the verifier trap: an old sent summary already in the GP feed')
  assert.ok(!view('wearables', AMIRA).some((r) => r.kind === 'device'), 'no wearable for Amira')
  assert.ok(view('community', AMIRA).some((r) => r.kind === 'visit' && r.status === 'completed'), 'an old completed visit')
  assert.ok(view('gp', AMIRA).some((r) => r.kind === 'task' && r.status === 'open'), 'an old open GP task')
  const gp = view('gp', AMIRA)
  const ehr = gp.find((r) => r.kind === 'ehr-record')!
  assert.ok((ehr.data.problems as Array<{ term: string }>).filter((x) => x.term === 'Heart failure').length > 1, 'problems repeat across encounters')
  assert.ok(gp.some((r) => r.kind === 'observation' && typeof r.data.context === 'string' && r.data.goal))
  assert.ok(gp.some((r) => r.kind === 'encounter' && r.data.author === 'Dr Maya Shah'))
  // Bloods: potassium peaked at 5.7 and fell; yesterday K 5.1, creatinine 107, eGFR 49 flagged low.
  const dx = view('diagnostics', AMIRA).filter((r) => r.kind === 'report' && r.data.kind === 'blood-result')
  const ue = dx.filter((r) => r.data.panel.id === 'ue').sort((a, b) => a.createdAt - b.createdAt)
  const k = (r: LocalResource) => (r.data.analytes as Array<{ id: string; value: number }>).find((a) => a.id === 'potassium')!.value
  assert.equal(Math.max(...ue.map(k)), 5.7)
  assert.equal(k(ue.at(-1)!), 5.1)
  const latest = ue.at(-1)!.data.analytes as Array<{ id: string; value: number; referenceLow: number; referenceHigh: number }>
  assert.equal(latest.find((a) => a.id === 'creatinine')!.value, 107)
  const egfr = latest.find((a) => a.id === 'egfr')!
  assert.equal(egfr.value, 49); assert.equal(egfr.referenceLow, 60)
  const fbc = dx.filter((r) => r.data.panel.id === 'fbc').sort((a, b) => a.createdAt - b.createdAt)
  const n = (r: LocalResource) => (r.data.analytes as Array<{ id: string; value: number }>).find((a) => a.id === 'neutrophils')!.value
  assert.deepEqual(fbc.map(n), [2.0, 1.0, 0.5, 0.8, 1.7, 2.6])
  const wcc = (fbc.at(-1)!.data.analytes as Array<{ id: string; value: number; referenceLow: number }>).find((a) => a.id === 'white-cell-count')!
  assert.equal(wcc.value, 3.5); assert.equal(wcc.referenceLow, 4.0)
  // Today's 08:15 in-person appointment and tomorrow's telephone session.
  const today = get('/api/sites/gp/appointments', { date: '2026-09-12' }).body as { appointments: LocalResource[]; sessions: LocalResource[] }
  const appt = today.appointments.find((a) => a.patientId === AMIRA)!
  assert.equal(appt.status, 'booked'); assert.equal(appt.data.mode, 'in-person'); assert.equal(new Date(appt.data.startsAt).toISOString(), '2026-09-12T08:15:00.000Z')
  const tomorrow = get('/api/sites/gp/appointments', { date: '2026-09-13' }).body as { sessions: LocalResource[] }
  assert.equal(tomorrow.sessions.filter((s) => s.data.mode === 'telephone').length, 1)
  // Eleanor: the blocker is in the community view, not the hospital.
  const comm = view('community', ELEANOR)
  const pkg = comm.find((r) => r.kind === 'care-package')!
  assert.equal(pkg.status, 'waiting'); assert.equal(pkg.data.fundingDecision, 'pending')
  assert.deepEqual(comm.find((r) => r.kind === 'care-plan')!.data.homeAccessConfirmed, false)
  assert.equal(comm.find((r) => r.kind === 'observation')!.data.baseline, 4200)
  assert.ok(view('wearables', ELEANOR).some((r) => r.kind === 'device'))
  assert.ok(view('wearables', ELEANOR).some((r) => r.kind === 'observation' && r.data.baseline === 4200))
  assert.ok(!view('hospital', ELEANOR).some((r) => r.kind === 'message'), 'no clinical hold for Eleanor')
  assert.equal(w.allPatients().length, 12)
  const found = get('/api/sites/hospital/patients', { q: 'Khan' }).body as { items: Array<{ id: string }>; total: number }
  assert.deepEqual(found.items.map((p) => p.id), ['SIM-000001', 'SIM-000010'], 'name search')
  assert.equal((get('/api/sites/gp/patients', { q: 'sim-000006' }).body as { items: Array<{ name: string }> }).items[0].name, 'Eleanor Chen')
})

test('idempotency: the same key with the same body replays the original result; the same key with a different body is a 409', () => {
  const { act } = world()
  const a = act('gp', { type: 'create_task', patientId: AMIRA, title: 'Ring the patient' }, 'k-1')
  assert.equal(a.status, 201)
  const again = act('gp', { type: 'create_task', patientId: AMIRA, title: 'Ring the patient' }, 'k-1')
  assert.deepEqual(again, a, 'replayed, not duplicated')
  const changed = act('gp', { type: 'create_task', patientId: AMIRA, title: 'Ring the patient tomorrow' }, 'k-1')
  assert.equal(changed.status, 409)
  assert.match((changed.body as { error: string }).error, /Idempotency-Key 'k-1' was already used with a different payload/)
  const fresh = act('gp', { type: 'create_task', patientId: AMIRA, title: 'Ring the patient tomorrow' }, 'k-2')
  assert.equal(fresh.status, 201)
  assert.notEqual((fresh.body as LocalResource).id, (a.body as LocalResource).id)
  const bad = act('gp', { type: 'create_task', patientId: 'SIM-999999', title: 'x' }, 'k-3')
  assert.equal(bad.status, 404)
  assert.equal(act('gp', { type: 'create_task', patientId: AMIRA, title: 'x' }, 'k-3').status, 201, 'a rejected request is not remembered against its key')
})

test('updates need resourceId + expectedVersion: id alone is 400 "Versioned <kind> required", a stale version is 409, every update bumps the version', () => {
  const { act, view, res } = world()
  const rx = view('pharmacy', AMIRA).find((r) => r.kind === 'prescription')!
  const product = view('pharmacy', AMIRA).find((r) => r.kind === 'pharmacy-product')!
  const byId = act('pharmacy', { type: 'link_prescription_stock', patientId: AMIRA, id: rx.id, version: rx.version, productId: product.id, quantity: 28 })
  assert.equal(byId.status, 400)
  assert.equal((byId.body as { error: string }).error, 'Versioned prescription required')
  const stale = act('pharmacy', { type: 'link_prescription_stock', patientId: AMIRA, resourceId: rx.id, expectedVersion: rx.version + 1, productId: product.id, quantity: 28 })
  assert.equal(stale.status, 409)
  assert.match((stale.body as { error: string }).error, /Version conflict/)
  const linked = res(act('pharmacy', { type: 'link_prescription_stock', patientId: AMIRA, resourceId: rx.id, expectedVersion: rx.version, productId: product.id, quantity: 28 }))
  assert.equal(linked.version, rx.version + 1)
  assert.equal(linked.status, 'linked')
  assert.equal(act('pharmacy', { type: 'dispense', patientId: AMIRA, resourceId: rx.id, expectedVersion: rx.version }).status, 409, 'the old version is now stale')
  const dispensed = res(act('pharmacy', { type: 'dispense', patientId: AMIRA, resourceId: rx.id, expectedVersion: linked.version }))
  assert.equal(dispensed.status, 'dispensed'); assert.equal(dispensed.version, linked.version + 1)
  assert.equal(act('pharmacy', { type: 'collect', patientId: AMIRA, resourceId: 'r-404', expectedVersion: 1 }).status, 404)
  assert.equal(act('hospital', { type: 'update_attendance', hospitalCommand: 'assign', clinician: 'Dr X' }).status, 400)
  assert.equal((act('hospital', { type: 'update_attendance', hospitalCommand: 'assign', clinician: 'Dr X' }).body as { error: string }).error, 'Versioned hospital-attendance required')
})

test('pharmacy chain: link draws the product stock down, dispense and collect follow in order, insufficient stock is refused', () => {
  const { act, view, res } = world()
  const rx = view('pharmacy', AMIRA).find((r) => r.kind === 'prescription')!
  const product = view('pharmacy', AMIRA).find((r) => r.kind === 'pharmacy-product')!
  const tooMany = act('pharmacy', { type: 'link_prescription_stock', patientId: AMIRA, resourceId: rx.id, expectedVersion: rx.version, productId: product.id, quantity: 100 })
  assert.equal(tooMany.status, 409)
  assert.match((tooMany.body as { error: string }).error, /Insufficient stock: 84 units/)
  assert.equal(act('pharmacy', { type: 'collect', patientId: AMIRA, resourceId: rx.id, expectedVersion: rx.version }).status, 409, 'collect before dispense is refused')
  let cur = res(act('pharmacy', { type: 'link_prescription_stock', patientId: AMIRA, resourceId: rx.id, expectedVersion: rx.version, productId: product.id, quantity: 28 }))
  assert.equal(view('pharmacy').find((r) => r.id === product.id)!.data.stock, 56)
  cur = res(act('pharmacy', { type: 'dispense', patientId: AMIRA, resourceId: cur.id, expectedVersion: cur.version }))
  cur = res(act('pharmacy', { type: 'collect', patientId: AMIRA, resourceId: cur.id, expectedVersion: cur.version }))
  assert.equal(cur.status, 'collected')
  assert.equal(view('pharmacy', AMIRA).find((r) => r.id === rx.id)!.status, 'collected')
  assert.equal(view('hospital', AMIRA).find((r) => r.id === rx.id)!.status, 'collected', 'the hospital sees the same prescription')
})

test('attendance stage machine: assign (clinician) keeps waiting, then assess, refer, admit (location), discharge; out-of-order commands are refused with the reason', () => {
  const { act, view, res } = world()
  const att = () => view('hospital', AMIRA).find((r) => r.kind === 'hospital-attendance')!
  const cmd = (hospitalCommand: string, extra: Record<string, unknown> = {}) =>
    act('hospital', { type: 'update_attendance', patientId: AMIRA, resourceId: att().id, expectedVersion: att().version, hospitalCommand, ...extra })
  const admitEarly = cmd('admit', { location: 'AMU bed 12' })
  assert.equal(admitEarly.status, 409)
  assert.match((admitEarly.body as { error: string }).error, /Cannot admit an attendance at stage 'waiting'/)
  const assessEarly = cmd('assess')
  assert.equal(assessEarly.status, 409)
  assert.match((assessEarly.body as { error: string }).error, /Assign a clinician before assessing/)
  assert.equal(cmd('assign').status, 400, 'assign needs a clinician')
  let a = res(cmd('assign', { clinician: 'Dr Ada Sim 0' }))
  assert.equal(a.data.stage, 'waiting'); assert.equal(a.data.clinician, 'Dr Ada Sim 0'); assert.equal(a.version, 2)
  a = res(cmd('assess')); assert.equal(a.data.stage, 'assessing'); assert.equal(a.version, 3)
  assert.equal(cmd('admit', { location: 'AMU bed 12' }).status, 409, 'refer is required before admit')
  a = res(cmd('refer')); assert.equal(a.data.stage, 'take'); assert.equal(a.version, 4)
  assert.equal(cmd('admit').status, 400, 'admit needs a location')
  assert.equal(cmd('admit', { location: 'x'.repeat(101) }).status, 400, 'location is capped at 100 characters')
  a = res(cmd('admit', { location: 'AMU bed 12' })); assert.equal(a.data.stage, 'inpatient'); assert.equal(a.data.location, 'AMU bed 12'); assert.equal(a.version, 5)
  assert.equal(cmd('discharge').status, 400, 'discharge needs a disposition')
  a = res(cmd('discharge', { disposition: 'Home with support' })); assert.equal(a.data.stage, 'discharged'); assert.equal(a.status, 'discharged')
  assert.equal(cmd('discharge', { disposition: 'again' }).status, 409)
  assert.equal(act('hospital', { type: 'update_attendance', patientId: AMIRA, resourceId: 'r-1', expectedVersion: 1, hospitalCommand: 'assign', clinician: 'x' }).status, 400, 'a document is not an attendance')
  assert.equal(act('hospital', { type: 'update_attendance', patientId: AMIRA, resourceId: att().id, expectedVersion: att().version, hospitalCommand: 'teleport' }).status, 400)
})

test('register_attendance names the missing fields and creates a waiting attendance for a directory patient', () => {
  const { act, get, res } = world()
  const missing = act('hospital', { type: 'register_attendance', patientId: 'SIM-000010' })
  assert.equal(missing.status, 400)
  assert.deepEqual((missing.body as { missing: string[] }).missing, ['presentingComplaint', 'acuity', 'location'])
  assert.match((missing.body as { error: string }).error, /Missing required fields: presentingComplaint, acuity, location/)
  const att = res(act('hospital', { type: 'register_attendance', patientId: 'SIM-000010', presentingComplaint: 'Wheeze', acuity: '3', location: 'Waiting room' }))
  assert.equal(att.kind, 'hospital-attendance'); assert.equal(att.data.stage, 'waiting'); assert.equal(att.data.clinician, 'Unassigned')
  assert.equal((get('/api/sites/hospital/attendances').body as { total: number }).total, 9)
  assert.equal(act('hospital', { type: 'register_attendance', patientId: 'SIM-424242', presentingComplaint: 'x', acuity: '3', location: 'y' }).status, 404)
})

test('discharge summary: all seven sections required, the draft is hospital-only, send puts it in the GP feed at once, share_record refuses the summary but shares a document', () => {
  const { act, get, view, res } = world()
  const sections = { reason: 'r', course: 'c', diagnoses: 'd', medicationChanges: 'm', results: 'x', followUp: 'f', gpActions: 'g' }
  const partial = act('hospital', { type: 'save_discharge_summary', patientId: AMIRA, title: 'Summary', dischargeSections: { reason: 'r', course: 'c' } })
  assert.equal(partial.status, 400)
  assert.deepEqual((partial.body as { missing: string[] }).missing, ['diagnoses', 'medicationChanges', 'results', 'followUp', 'gpActions'])
  assert.equal(act('hospital', { type: 'save_discharge_summary', patientId: AMIRA, title: 'Summary', dischargeSections: { ...sections, course: 'c'.repeat(10001) } }).status, 400)
  const draft = res(act('hospital', { type: 'save_discharge_summary', patientId: AMIRA, title: 'Discharge summary - Amira Khan', dischargeSections: sections }))
  assert.equal(draft.kind, 'discharge-summary'); assert.equal(draft.status, 'draft'); assert.deepEqual(draft.visibleTo, ['hospital'])
  const gpDocs = () => (get('/api/sites/gp/documents').body as { resources: LocalResource[] }).resources
  assert.ok(!gpDocs().some((d) => d.id === draft.id), 'a draft is not in the GP feed')
  assert.ok(!view('gp', AMIRA).some((d) => d.id === draft.id))
  const refused = act('hospital', { type: 'share_record', patientId: AMIRA, resourceId: draft.id, expectedVersion: draft.version, target: 'community' })
  assert.deepEqual(refused, { status: 409, body: { error: 'Use the document workflow to process this letter' } })
  const sent = res(act('hospital', { type: 'process_document', patientId: AMIRA, resourceId: draft.id, expectedVersion: draft.version, documentCommand: 'send' }))
  assert.equal(sent.status, 'sent'); assert.equal(sent.version, 2); assert.ok(sent.visibleTo.includes('gp'))
  assert.equal(gpDocs().find((d) => d.id === draft.id)!.status, 'sent', 'in the GP feed immediately')
  assert.ok(view('hospital', AMIRA).some((d) => d.id === draft.id && d.status === 'sent'))
  assert.equal(act('hospital', { type: 'process_document', patientId: AMIRA, resourceId: draft.id, expectedVersion: sent.version, documentCommand: 'shred' }).status, 400)
  const filed = res(act('hospital', { type: 'process_document', patientId: AMIRA, resourceId: draft.id, expectedVersion: sent.version, documentCommand: 'file' }))
  assert.equal(filed.status, 'filed'); assert.equal(filed.version, 3)
  const doc = view('hospital', AMIRA).find((r) => r.id === 'r-1')!
  const shared = res(act('hospital', { type: 'share_record', patientId: AMIRA, resourceId: doc.id, expectedVersion: doc.version, target: 'community' }))
  assert.deepEqual(shared.visibleTo, ['hospital', 'community']); assert.equal(shared.version, doc.version + 1)
  assert.ok(view('community', AMIRA).some((r) => r.id === 'r-1'))
  assert.equal(act('hospital', { type: 'share_record', patientId: AMIRA, resourceId: doc.id, expectedVersion: shared.version, target: 'moon' }).status, 400)
})

test('time-dependent outcomes: bloods available at +120 with panel analytes, visit completed at +90, watch readings at +10 then hourly; nothing moves before', () => {
  const { act, advance, view, res } = world()
  const order = res(act('hospital', { type: 'order_test', patientId: AMIRA, title: 'Post-discharge U&E', bloodTestOrder: { panelId: 'ue', panel: 'Urea & electrolytes', specimen: 'blood', priority: 'routine', collection: 'now', clinicalDetails: 'CKD, on furosemide' } }))
  assert.equal(order.kind, 'report'); assert.equal(order.status, 'open'); assert.equal(order.data.kind, 'blood-order')
  assert.deepEqual(order.data.panel, { id: 'ue', name: 'Urea & electrolytes' })
  assert.ok(order.visibleTo.includes('diagnostics') && order.visibleTo.includes('hospital'))
  const fbc = res(act('hospital', { type: 'order_test', patientId: AMIRA, title: 'FBC', bloodTestOrder: { panelId: 'fbc', panel: 'Full blood count', specimen: 'blood', priority: 'routine', collection: 'now', clinicalDetails: 'Neutropenia history' } }))
  assert.equal(act('hospital', { type: 'order_test', patientId: AMIRA, title: 'x', bloodTestOrder: { panel: 'x', specimen: 'blood', priority: 'routine', collection: 'now', clinicalDetails: 'c'.repeat(2001) } }).status, 400)
  assert.equal(act('hospital', { type: 'order_test', patientId: AMIRA, title: 'x', bloodTestOrder: { panelId: 'ue' } }).status, 400, 'the order fields are required')
  const visit = res(act('hospital', { type: 'schedule_visit', patientId: AMIRA, title: 'Post-discharge home support visit' }))
  assert.equal(visit.kind, 'visit'); assert.equal(visit.status, 'scheduled'); assert.deepEqual(visit.visibleTo, ['community', 'hospital'])
  const device = res(act('wearables', { type: 'connect_device', patientId: AMIRA, title: 'Home activity watch' }))
  assert.equal(device.kind, 'device'); assert.equal(device.status, 'active'); assert.equal(device.data.metric, 'steps'); assert.equal(device.data.battery, 100)
  const dx = (id: string) => view('diagnostics', AMIRA).find((r) => r.id === id)!
  const wear = () => view('wearables', AMIRA).filter((r) => r.kind === 'observation')
  assert.equal(wear().length, 0)
  advance(9)
  assert.equal(wear().length, 0, 'no reading before +10')
  assert.equal(dx(order.id).status, 'open')
  advance(1)
  assert.equal(wear().length, 1, 'first reading at +10')
  assert.equal(wear()[0].data.observedAt, DEMO_START + 10 * MIN)
  assert.equal(typeof wear()[0].data.value, 'number'); assert.equal(wear()[0].data.unit, 'steps')
  advance(79) // +89
  assert.equal(view('community', AMIRA).find((r) => r.id === visit.id)!.status, 'scheduled')
  advance(1) // +90
  const done = view('community', AMIRA).find((r) => r.id === visit.id)!
  assert.equal(done.status, 'completed'); assert.equal(done.data.completedAt, DEMO_START + 90 * MIN); assert.equal(done.version, 2)
  advance(29) // +119
  assert.equal(dx(order.id).status, 'open'); assert.equal(dx(order.id).data.kind, 'blood-order')
  advance(2) // +121
  const resulted = dx(order.id)
  assert.equal(resulted.status, 'available'); assert.equal(resulted.data.kind, 'blood-result'); assert.equal(resulted.version, 2)
  assert.deepEqual((resulted.data.analytes as Array<{ id: string }>).map((a) => a.id), PANELS.ue.analytes.map((a) => a.id))
  const egfr = (resulted.data.analytes as Array<{ id: string; value: number; unit: string; referenceLow: number; referenceHigh: number }>).find((a) => a.id === 'egfr')!
  assert.ok(egfr.value > 40 && egfr.value < 60, `a repeat eGFR follows the patient's own history (${egfr.value})`)
  assert.equal(egfr.referenceLow, 60); assert.equal(egfr.unit, 'mL/min/1.73m2')
  assert.deepEqual((dx(fbc.id).data.analytes as Array<{ id: string }>).map((a) => a.id), ['haemoglobin', 'white-cell-count', 'neutrophils', 'platelets'])
  assert.equal(wear().length, 2, 'readings at +10 and +70 by +121')
  assert.deepEqual(wear().map((o) => o.data.observedAt), [DEMO_START + 10 * MIN, DEMO_START + 70 * MIN])
  assert.equal(view('wearables', AMIRA).find((r) => r.id === device.id)!.data.battery, 98)
  assert.equal(TIMINGS.resultsMinutes, 120)
})

test('the clock: advancing generates about six A&E arrivals per sim-hour with directory patients, time never goes backwards, the cap is 10080 minutes, worlds are reproducible', () => {
  const { get, advance } = world('rate-check')
  const before = get('/api/clock').body as { now: number }
  assert.equal(advance(-5).status, 400)
  assert.equal(advance(10081).status, 400)
  const after = advance(24 * 60).body as { now: number; paused: boolean; events: Array<{ type: string; detail: string }> }
  assert.equal(after.now, before.now + 24 * 60 * MIN)
  assert.equal(after.paused, true)
  const atts = get('/api/sites/hospital/attendances').body as { resources: LocalResource[]; patients: Array<{ id: string; name: string; conditions: string[]; needs: string[]; goals: string[] }>; total: number }
  const arrived = atts.resources.filter((a) => a.createdAt > before.now)
  assert.ok(arrived.length >= 100 && arrived.length <= 190, `about 144 arrivals in a day, got ${arrived.length}`)
  assert.ok(arrived.every((a) => a.data.stage === 'waiting' && a.data.clinician === 'Unassigned' && a.createdAt <= after.now))
  assert.ok(arrived.every((a) => atts.patients.some((p) => p.id === a.patientId && p.name && p.conditions.length && Array.isArray(p.needs) && p.goals.length)), 'every arrival has a directory record')
  assert.equal(new Set(arrived.map((a) => a.patientId)).size, arrived.length, 'each arrival is a new person')
  assert.ok(after.events.some((e) => e.type === 'emergency.arrived'))
  const cappedView = (get('/api/sites/hospital/view', { limit: '50' }).body as { resources: LocalResource[]; total: number })
  assert.equal(cappedView.resources.length, 50, 'the site view caps')
  assert.equal(atts.total, 8 + arrived.length, 'the attendances endpoint does not')
  const twin = world('rate-check')
  twin.advance(24 * 60)
  const twinAtts = twin.get('/api/sites/hospital/attendances').body as { total: number; patients: Array<{ name: string }> }
  assert.equal(twinAtts.total, atts.total, 'the same world name produces the same arrivals')
  assert.deepEqual(twinAtts.patients.map((p) => p.name), atts.patients.map((p) => p.name))
  assert.notEqual((world('another').advance(24 * 60), world('another').get('/api/sites/hospital/attendances').body as { total: number }).total, undefined)
})

test('appointments: a telephone slot is booked skipping blocked and taken slots, a stale session version is refused, the in-person slot is cancelled', () => {
  const { act, get, res } = world()
  const day = 1789200000000 - 8 * 60 * MIN + 24 * 60 * MIN // 2026-09-13T00:00Z
  const book = () => get('/api/sites/gp/appointments', { date: '2026-09-13' }).body as { sessions: LocalResource[]; appointments: LocalResource[] }
  const session = book().sessions.find((s) => s.data.mode === 'telephone')!
  const at = (h: number, m: number) => day + (h * 60 + m) * MIN
  assert.equal(act('gp', { type: 'book_appointment', patientId: AMIRA, sessionId: session.id, sessionVersion: session.version, startsAt: at(14, 0), title: 'x' }).status, 409, 'blocked slot')
  assert.equal(act('gp', { type: 'book_appointment', patientId: AMIRA, sessionId: session.id, sessionVersion: session.version, startsAt: at(14, 15), title: 'x' }).status, 409, 'taken slot')
  assert.equal(act('gp', { type: 'book_appointment', patientId: AMIRA, sessionId: session.id, sessionVersion: session.version, startsAt: at(14, 20), title: 'x' }).status, 400, 'off the slot grid')
  assert.equal(act('gp', { type: 'book_appointment', patientId: AMIRA, sessionId: session.id, sessionVersion: session.version + 1, startsAt: at(14, 30), title: 'x' }).status, 409, 'stale session version')
  const appt = res(act('gp', { type: 'book_appointment', patientId: AMIRA, sessionId: session.id, sessionVersion: session.version, startsAt: at(14, 30), title: 'Telephone review' }))
  assert.equal(appt.kind, 'appointment'); assert.equal(appt.status, 'booked'); assert.equal(appt.data.mode, 'telephone'); assert.equal(appt.data.clinician, 'Dr Maya Shah')
  assert.ok(book().appointments.some((a) => a.id === appt.id))
  const cancelled = res(act('gp', { type: 'cancel_appointment', patientId: AMIRA, resourceId: appt.id, expectedVersion: appt.version }))
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.version, 2)
  const created = res(act('gp', { type: 'create_appointment_session', title: 'Late telephone reviews', clinician: 'Dr Maya Shah', location: 'Telephone', startsAt: at(17, 0), endsAt: at(18, 0), slotMinutes: 15, mode: 'telephone' }))
  assert.equal(created.kind, 'appointment-session'); assert.equal(created.status, 'open'); assert.equal(created.data.mode, 'telephone'); assert.equal(created.data.slotMinutes, 15)
  assert.equal(book().sessions.length, 2)
  assert.equal(act('gp', { type: 'create_appointment_session', clinician: 'x' }).status, 400)
})

test('everything else in the action enum is stored as a plain resource; an unknown type is a 400', () => {
  const { act, view, res } = world()
  const note = res(act('hospital', { type: 'hospital_note', patientId: AMIRA, title: 'Ward round', text: 'Seen on the round.' }))
  assert.equal(note.kind, 'note'); assert.equal(note.status, 'open'); assert.equal(note.data.text, 'Seen on the round.')
  const msg = res(act('gp', { type: 'messaging_action', patientId: AMIRA, messagingCommand: { kind: 'create', subject: 'Hello', body: 'Hi', channel: 'sms' } }))
  assert.equal(msg.kind, 'message'); assert.ok(view('gp', AMIRA).some((r) => r.id === msg.id))
  assert.equal(res(act('gp', { type: 'send_message', patientId: AMIRA, messagingCommand: { kind: 'create', subject: 'Hello', body: 'Hi', channel: 'sms' } })).kind, 'message')
  assert.equal(res(act('gp', { type: 'create_referral', patientId: AMIRA, title: 'Physio' })).kind, 'referral')
  assert.equal(res(act('pharmacy', { type: 'receive_stock', productId: 'r-4', quantity: 10 })).kind, 'receive-stock')
  const unknown = act('gp', { type: 'teleport_patient', patientId: AMIRA })
  assert.equal(unknown.status, 400); assert.match((unknown.body as { error: string }).error, /Unknown action type 'teleport_patient'/)
  assert.equal(act('gp', { patientId: AMIRA }).status, 400)
  assert.equal(act('gp', 'nonsense' as unknown as Record<string, unknown>).status, 400)
})

test('a world can be built directly and seeded: LocalWorld is usable without the API layer', () => {
  const w = new LocalWorld('direct', { startAt: DEMO_START })
  seedDemoWorld(w)
  assert.equal(w.now, DEMO_START)
  assert.equal(w.stats().attendances, 8)
  w.advance(60)
  assert.equal(w.now, DEMO_START + 60 * MIN)
  assert.ok(w.stats().attendances >= 8)
  const r = w.handle({ method: 'GET', path: '/api/team' })
  assert.equal(r.status, 200)
})

// --- End to end over HTTP: the demo, unchanged, against the stand-in ---------------

const servers: LocalSimServer[] = []
after(async () => { for (const s of servers) await s.close() })

test('end to end over HTTP: the orchestrator admits, detects, resolves, advances, verifies, discharges Amira and stops for Eleanor', { timeout: 20_000 }, async () => {
  const started = Date.now()
  const local = await startLocalSim({ port: 0 })
  servers.push(local)
  assert.match(local.origin, /^http:\/\/127\.0\.0\.1:\d+$/)
  const trace: TraceEntry[] = []
  const { sim, world: name } = await joinWorld('E2E Demo World', (e) => trace.push(annotate(e)), 1, undefined, { origin: local.origin })
  assert.ok(sim instanceof SimClient)
  assert.equal(name, 'E2E Demo World')
  assert.equal(sim.http.origin, local.origin)
  assert.equal(trace[0].path, '/api/keys'); assert.equal(trace[0].headline, 'Joined the simulator world')

  // Setup, as the demo runner does it: walk the stage machine re-reading each step.
  await admitToWard(sim, AMIRA, 'AMU bed 12')
  await admitToWard(sim, ELEANOR, 'AMU bed 1')
  const steps = trace.filter((t) => t.action === 'update_attendance').map((t) => `${(t.request as { patientId: string }).patientId}:${(t.request as { hospitalCommand: string }).hospitalCommand}:${t.status}`)
  assert.deepEqual(steps, ['SIM-000001:assign:200', 'SIM-000001:assess:200', 'SIM-000001:refer:200', 'SIM-000001:admit:200', 'SIM-000006:admit:200'])
  assert.ok(trace.filter((t) => t.action === 'update_attendance').every((t) => t.idempotencyKey), 'every action carried an Idempotency-Key over the wire')
  await admitToWard(sim, AMIRA, 'AMU bed 12')
  assert.equal(trace.filter((t) => t.action === 'update_attendance').length, 5, 'admitting again is a no-op: already inpatient')

  const board = await buildBoard(sim, name, [AMIRA, ELEANOR])
  board.mode = 'local'
  board.simOrigin = local.origin
  const [amira, eleanor] = board.patients
  assert.equal(amira.name, 'Amira Khan'); assert.equal(amira.stage, 'inpatient'); assert.equal(amira.location, 'AMU bed 12')
  assert.deepEqual(amira.needs, ['Home visit', 'Carer involvement'])
  assert.equal(eleanor.name, 'Eleanor Chen'); assert.equal(eleanor.stage, 'inpatient'); assert.equal(eleanor.location, 'AMU bed 1')
  assert.deepEqual(amira.profile?.allergies, ['Penicillin'])
  assert.deepEqual(amira.profile?.problems, ['Heart failure', 'CKD stage 3', 'Hypertension'], 'active problems, each once')
  assert.equal(amira.profile?.gp, 'Dr Maya Shah')
  assert.ok(amira.profile?.ownWords?.text.includes('at home'))
  assert.ok(amira.profile?.facts.some((f) => f.label === 'eGFR' && f.value.startsWith('49') && f.bad))
  assert.ok(amira.profile?.facts.some((f) => f.label === 'Potassium' && f.value.startsWith('5.1') && !f.bad))
  assert.deepEqual(amira.profile?.prescriptions, [{ id: 'r-3', drug: 'Furosemide tablets', status: 'approved' }])
  assert.ok(eleanor.profile?.facts.some((f) => f.label === 'Home access' && f.bad))
  assert.ok(eleanor.profile?.facts.some((f) => f.label === 'Activity' && f.value.startsWith('1800 vs 4200')))

  const ctx: OrchestratorContext = { sim, world: name, board, log: (m) => board.log.push(m) }
  await detectAll(ctx)
  const kinds = (row: { items: ChecklistItem[] }) => row.items.map((i) => i.id.replace(/^sim-\d+-/, '')).sort()
  assert.deepEqual(kinds(amira), ['bloods', 'clinical-hold', 'device', 'follow-up', 'medicines', 'summary', 'visit'])
  const by = (row: { items: ChecklistItem[] }, k: string) => row.items.find((i) => i.id.endsWith(`-${k}`))!
  assert.equal(by(amira, 'clinical-hold').state, 'clinical_hold')
  assert.equal(by(amira, 'clinical-hold').evidence[0].resourceId, 'r-6')
  assert.equal(by(amira, 'bloods').evidence[0].resourceId, 'r-1')
  assert.equal(by(amira, 'device').evidence[0].quote, 'home equipment and medication handover not confirmed')
  assert.match(by(amira, 'follow-up').title, /telephone/)
  assert.deepEqual(kinds(eleanor), ['care-package', 'follow-up', 'summary', 'visit'])
  assert.equal(by(eleanor, 'care-package').state, 'blocked_human')
  assert.equal(by(eleanor, 'care-package').evidence.length, 3)
  assert.equal(by(eleanor, 'summary').draftOnly, true)

  assert.equal(approveAll(board, 'test'), 9, 'six operational items for Amira, three for Eleanor')
  await runUntilSettled(ctx, { advanceMinutes: 121, maxRounds: 3 })
  const clockAdvances = trace.filter((t) => t.path === '/api/clock' && t.method === 'POST')
  assert.equal(clockAdvances.length, 1, 'everything verified after one 121-minute advance')
  assert.equal(board.simNow, DEMO_START + 121 * MIN)
  for (const row of [amira, eleanor]) {
    for (const item of row.items) {
      if (item.state === 'clinical_hold' || item.state === 'blocked_human') continue
      assert.equal(item.state, 'verified', `${item.id}: ${item.error ?? item.verification?.observed}`)
    }
  }
  // Each verifier read the resolver's own resource, in its finished state.
  assert.equal(by(amira, 'medicines').resolution?.resourceId, 'r-3')
  assert.match(by(amira, 'medicines').verification!.observed, /prescription r-3 status=collected/)
  assert.match(by(amira, 'bloods').verification!.observed, /=available, .*=available/)
  assert.match(by(amira, 'device').verification!.observed, /reading steps=\d+ at \d+/)
  assert.match(by(amira, 'visit').verification!.observed, /status=completed/)
  assert.match(by(amira, 'summary').verification!.observed, /status=sent in GP inbox/)
  assert.notEqual(by(amira, 'summary').resolution?.resourceId, 'discharge-summary-example', 'the seeded sent summary is not what got verified')
  assert.match(by(amira, 'summary').resolution!.action, /share_record\(r-1\)/, 'the cited hospital document was shared with community')
  assert.match(by(amira, 'follow-up').verification!.observed, /task .* on GP worklist; appointment .* status=booked mode=telephone/)
  assert.match(by(eleanor, 'summary').verification!.observed, /held as draft \(deliberately unsent\)/)
  assert.ok(board.log.some((l) => /cancelled in-person appointment .*08:15.*replaced by telephone review/.test(l)), board.log.filter((l) => /appointment/.test(l)).join('\n'))
  const gpBook = (await sim.siteAppointments('gp', { date: '2026-09-13' })) as { appointments: Array<{ patientId: string; status: string; data: { mode: string; startsAt: number } }> }
  const tel = gpBook.appointments.find((a) => a.patientId === AMIRA)!
  assert.equal(tel.status, 'booked'); assert.equal(tel.data.mode, 'telephone')
  assert.equal(new Date(tel.data.startsAt).toISOString(), '2026-09-13T14:30:00.000Z', 'the first slot after the blocked 14:00 and the taken 14:15')
  const todayBook = (await sim.siteAppointments('gp', { date: '2026-09-12' })) as { appointments: Array<{ patientId: string; status: string }> }
  assert.equal(todayBook.appointments.find((a) => a.patientId === AMIRA)!.status, 'cancelled')
  const pharmacy = await sim.siteView('pharmacy', { patient: AMIRA })
  assert.equal((pharmacy.resources.find((r) => r.kind === 'pharmacy-product') as { data: { stock: number } }).data.stock, 56, 'one pack drawn down')

  // The human beats: the hold clears only by hand; Eleanor stays blocked.
  assert.equal(readyForDischarge(amira), false, 'the clinical hold gates discharge')
  assert.equal(clearHold(board, by(amira, 'clinical-hold').id, 'Dr Test'), true)
  assert.equal(readyForDischarge(amira), true)
  assert.equal(readyForDischarge(eleanor), false)
  await dischargeAttendance(sim, AMIRA, 'Home with community support and monitoring')
  await refreshStage(sim, amira)
  assert.equal(amira.stage, 'discharged')
  await refreshStage(sim, eleanor)
  assert.equal(eleanor.stage, 'inpatient')
  const attendances = (await sim.hospitalAttendances()) as { resources: Array<{ patientId: string; data: { stage: string } }>; total: number }
  assert.equal(attendances.resources.find((a) => a.patientId === AMIRA)!.data.stage, 'discharged')
  assert.ok(attendances.total > 8, `the 121-minute advance brought new A&E arrivals (${attendances.total - 8})`)

  // The wire trace is the compliance record, and it is real HTTP.
  assert.ok(trace.length > 60, `every call went over the wire (${trace.length})`)
  assert.ok(trace.every((t) => t.status > 0 && t.headline), 'every entry has a status and a plain-language headline')
  const actions = trace.filter((t) => t.method === 'POST' && t.path.endsWith('/actions'))
  assert.ok(actions.every((t) => t.ok && t.idempotencyKey && t.reply), 'every action succeeded with a key and a reply')
  assert.ok(actions.some((t) => t.headline === 'Dispensed the prescription' && /now dispensed/.test(t.outcome ?? '')))
  assert.ok(actions.some((t) => t.headline === 'Sent the discharge summary to the GP'))
  assert.equal(new Set(actions.map((t) => t.idempotencyKey)).size, actions.length, 'no key reused')
  // A key reused with a changed body is refused by the stand-in, as live.
  const replay = actions.find((t) => t.action === 'create_task')!
  await assert.rejects(
    sim.createTask('gp', AMIRA, 'A different title', replay.idempotencyKey),
    (e: unknown) => e instanceof SimApiError && e.status === 409 && /different payload/.test(String((e.body as { error: string }).error)),
  )
  assert.ok(Date.now() - started < 10_000, `the whole run took ${Date.now() - started} ms`)
})

test('a second process joining the same world name over HTTP gets the same key and sees the same state', async () => {
  const local = await startLocalSim({ port: 0 })
  servers.push(local)
  const a = await joinWorld('Shared World', undefined, 1, undefined, { origin: local.origin })
  await a.sim.createTask('gp', AMIRA, 'Left by the first client', 'shared-1')
  const b = await joinWorld('shared world', undefined, 1, undefined, { origin: local.origin })
  assert.equal(b.sim.apiKey, a.sim.apiKey)
  const view = await b.sim.siteView('gp', { patient: AMIRA })
  assert.ok(view.resources.some((r) => r.title === 'Left by the first client'))
  const health = await a.sim.health() as { worlds: number; standIn: string }
  assert.equal(health.standIn, 'homeward-local'); assert.equal(health.worlds, 1)
  const res = await fetch(`${local.origin}/api/sites/gp/actions`, { method: 'POST', headers: { authorization: `Bearer ${a.sim.apiKey}`, 'content-type': 'application/json' }, body: '{not json' })
  assert.equal(res.status, 400)
  assert.equal(res.headers.get('x-simulator'), 'homeward-local-stand-in')
})
