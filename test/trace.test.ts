import { test } from 'node:test'
import assert from 'node:assert/strict'
import { annotate, headlineFor, outcomeFor } from '../src/orchestrator/trace.ts'
import type { TraceEntry } from '../src/sim/http.ts'
import { SimClient } from '../src/sim/index.ts'

const entry = (over: Partial<TraceEntry>): TraceEntry => ({
  at: 1_000, method: 'POST', path: '/api/sites/pharmacy/actions', status: 200, ok: true, ...over,
})

test('pharmacy chain reads as sentences a clinician would use', () => {
  const link = { type: 'link_prescription_stock', patientId: 'SIM-000001', resourceId: 'r-3', expectedVersion: 1, productId: 'pharmacy-product-furosemide', quantity: 28 }
  assert.equal(headlineFor('pharmacy', link), 'Reserved 28 × furosemide from pharmacy stock')
  assert.equal(headlineFor('pharmacy', link, { data: { drug: 'Furosemide' } }), 'Reserved 28 × Furosemide from pharmacy stock')
  assert.equal(headlineFor('pharmacy', { type: 'dispense' }), 'Dispensed the prescription')
  assert.equal(headlineFor('pharmacy', { type: 'collect' }), 'Recorded the medicines as collected')
  assert.equal(outcomeFor(link, { id: 'r-3', status: 'approved', version: 2, kind: 'prescription' }, true, 200), 'Prescription r-3 · now approved · v2')
  assert.equal(outcomeFor({ type: 'dispense' }, { id: 'r-3', status: 'dispensed', version: 3 }, true, 200), 'Prescription r-3 · now dispensed · v3')
})

test('other action types get plain headlines and never leak the API name', () => {
  assert.equal(headlineFor('hospital', { type: 'order_test', title: 'Post-discharge U&E', bloodTestOrder: { panel: 'Urea & electrolytes', priority: 'routine' } }), 'Ordered Urea & electrolytes (routine)')
  assert.equal(headlineFor('wearables', { type: 'connect_device', title: 'Home activity watch' }), 'Issued a home activity watch')
  assert.equal(headlineFor('hospital', { type: 'schedule_visit', title: 'Post-discharge home support visit' }), 'Booked "Post-discharge home support visit"')
  assert.equal(headlineFor('hospital', { type: 'save_discharge_summary', dischargeSections: { reason: 1, course: 1, diagnoses: 1, medicationChanges: 1, results: 1, followUp: 1, gpActions: 1 } }), 'Drafted the discharge summary (7 sections)')
  assert.equal(headlineFor('hospital', { type: 'process_document', documentCommand: 'send' }), 'Sent the discharge summary to the GP')
  assert.equal(headlineFor('gp', { type: 'create_task', title: 'Post-discharge telephone review within 48h' }), 'Asked the GP practice to: Post-discharge telephone review within 48h')
  assert.equal(headlineFor('hospital', { type: 'update_attendance', hospitalCommand: 'admit', location: 'AMU bed 12' }), 'Admitted to AMU bed 12')
  assert.equal(headlineFor('community', { type: 'some_new_action' }), 'Some new action')
})

test('annotate fills headline and outcome for writes, reads and clock calls', () => {
  const w = annotate(entry({ request: { type: 'dispense' }, reply: { id: 'r-3', status: 'dispensed', version: 3 }, idempotencyKey: 'w-item-dispense-1' }))
  assert.equal(w.headline, 'Dispensed the prescription')
  assert.equal(w.outcome, 'Prescription r-3 · now dispensed · v3')
  const failed = annotate(entry({ ok: false, status: 409, request: { type: 'dispense' }, reply: { error: 'version conflict' }, error: 'version conflict' }))
  assert.equal(failed.outcome, 'Failed (HTTP 409): version conflict')
  const read = annotate(entry({ method: 'GET', path: '/api/sites/pharmacy/view?patient=SIM-000001&limit=60' }))
  assert.equal(read.headline, "Read the pharmacy's records for SIM-000001")
  assert.equal(read.outcome, undefined)
  const clock = annotate(entry({ path: '/api/clock', request: { advanceMinutes: 121, paused: true } }))
  assert.equal(clock.headline, 'Moved the sim clock forward 121 minutes')
  const join = annotate(entry({ path: '/api/keys', request: { teamName: 'x' } }))
  assert.equal(join.headline, 'Joined the simulator world')
  const other = annotate(entry({ method: 'GET', path: '/api/catalogue' }))
  assert.equal(other.headline, 'GET /api/catalogue')
  const down = annotate(entry({ method: 'GET', path: '/api/sites/gp/view', ok: false, status: 0, error: 'fetch failed' }))
  assert.equal(down.outcome, 'Failed: fetch failed')
})

test('SimClient trace carries the parsed request and reply for writes only', async () => {
  const seen: TraceEntry[] = []
  const impl = (async (input: string | URL | Request) => new Response(
    JSON.stringify(String(input).includes('/view') ? { resources: [{ id: 'r-3' }] } : { id: 'r-3', status: 'dispensed', version: 3 }),
    { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
  const client = new SimClient({ origin: 'https://sim.example', apiKey: 'k', fetch: impl, trace: (t) => seen.push(t) })
  await client.siteView('pharmacy', { patient: 'SIM-000001' })
  await client.siteAction('pharmacy', { type: 'dispense', patientId: 'SIM-000001', resourceId: 'r-3', expectedVersion: 2 }, 'w-item-dispense-1')
  assert.equal(seen.length, 2)
  assert.equal(seen[0].request, undefined)
  assert.equal(seen[0].reply, undefined)
  assert.deepEqual(seen[1].request, { type: 'dispense', patientId: 'SIM-000001', resourceId: 'r-3', expectedVersion: 2 })
  assert.deepEqual(seen[1].reply, { id: 'r-3', status: 'dispensed', version: 3 })
  assert.equal(seen[1].idempotencyKey, 'w-item-dispense-1')
  assert.equal(seen[1].error, undefined)
})

test('SimClient trace names the reason on a failed write', async () => {
  const seen: TraceEntry[] = []
  const bad = (async () => new Response(JSON.stringify({ error: 'Versioned prescription required' }), { status: 400, headers: { 'content-type': 'application/json' } })) as typeof fetch
  const client = new SimClient({ origin: 'https://sim.example', apiKey: 'k', fetch: bad, trace: (t) => seen.push(t) })
  await assert.rejects(() => client.siteAction('pharmacy', { type: 'dispense' }, 'k1'), /HTTP 400/)
  assert.equal(seen[0].ok, false)
  assert.equal(seen[0].error, 'Versioned prescription required')
  assert.equal(annotate(seen[0]).outcome, 'Failed (HTTP 400): Versioned prescription required')
})

test('every action the resolvers and world setup send reads as a past-tense sentence with a labelled outcome', () => {
  assert.equal(headlineFor('gp', { type: 'cancel_appointment', resourceId: 'appt-old', expectedVersion: 2 }), 'Cancelled the appointment')
  assert.equal(headlineFor('gp', { type: 'create_appointment_session', title: 'Post-discharge telephone reviews', mode: 'telephone' }), 'Opened a telephone appointment session')
  assert.equal(headlineFor('gp', { type: 'book_appointment', title: 'Post-discharge telephone review', startsAt: 1 }), 'Booked an appointment: Post-discharge telephone review')
  assert.equal(headlineFor('hospital', { type: 'share_record', target: 'community' }), 'Shared the record with community')
  assert.equal(headlineFor('hospital', { type: 'register_attendance', title: 'Chest pain' }), 'Registered a hospital attendance: Chest pain')
  for (const [cmd, expect] of [['assign', 'Assigned a clinician'], ['assess', 'Marked as being assessed'], ['refer', 'Referred to the take'], ['discharge', 'Discharged from hospital']] as const) {
    assert.equal(headlineFor('hospital', { type: 'update_attendance', hospitalCommand: cmd }), expect)
  }
  assert.equal(headlineFor('hospital', { type: 'process_document', documentCommand: 'file' }), 'Filed the document')
  assert.equal(outcomeFor({ type: 'book_appointment' }, { id: 'a-1', status: 'booked', version: 1, kind: 'appointment' }, true, 200), 'Appointment a-1 · now booked · v1')
  assert.equal(outcomeFor({ type: 'create_appointment_session' }, { id: 's-1', status: 'open', version: 1, kind: 'appointment-session' }, true, 200), 'Appointment session s-1 · now open · v1')
  assert.equal(outcomeFor({ type: 'cancel_appointment' }, { id: 'a-0', status: 'cancelled', version: 3 }, true, 200), 'Appointment a-0 · now cancelled · v3')
  assert.equal(outcomeFor({ type: 'update_attendance' }, { id: 'att', status: 'inpatient', version: 5, kind: 'hospital-attendance' }, true, 200), 'Attendance att · now inpatient · v5')
})

test('failed requests: a timeout (status 0) and a 4xx with a non-JSON error page both get a readable outcome', () => {
  const timeout = annotate(entry({ ok: false, status: 0, request: { type: 'collect' }, error: 'no response within 45000ms (simulator hung or unreachable)' }))
  assert.equal(timeout.headline, 'Recorded the medicines as collected')
  assert.equal(timeout.outcome, 'Failed: no response within 45000ms (simulator hung or unreachable)')
  const html = annotate(entry({ ok: false, status: 502, request: { type: 'dispense' }, reply: '<html><body><h1>502 Bad Gateway</h1></body></html>', error: '<html><body><h1>502 Bad Gateway</h1></body></html>' }))
  assert.equal(html.outcome, 'Failed (HTTP 502): 502 Bad Gateway')
  const clock = annotate(entry({ path: '/api/clock', ok: false, status: 400, request: { advanceMinutes: 20000 }, reply: { error: 'advanceMinutes must be <= 10080' }, error: 'advanceMinutes must be <= 10080' }))
  assert.equal(clock.headline, 'Moved the sim clock forward 20000 minutes')
  assert.equal(clock.outcome, 'Failed (HTTP 400): advanceMinutes must be <= 10080')
})
