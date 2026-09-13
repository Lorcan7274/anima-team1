/**
 * Resolvers act in the owning service. These tests check the exact action
 * bodies, the version threading between steps, the idempotency keys, and
 * that a resolver refuses to act when the record does not support it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
process.env.OPENAI_API_KEY = '' // canned drafts only; set rather than deleted so a later loadDotEnv() cannot restore a developer's key
import type { BoardState, ChecklistItem, OrchestratorContext } from '../src/orchestrator/model.ts'
import { findFreeTelephoneSlot, planFor, resolverFor } from '../src/orchestrator/resolve.ts'
import { fakeSim, FIT } from './helpers/fake-sim.ts'
import type { SimClient } from '../src/sim/index.ts'

const item = (suffix: string, extra: Partial<ChecklistItem> = {}): ChecklistItem => ({
  id: `sim-000001-${suffix}`, patientId: 'SIM-000001', title: suffix, owner: 'gp', state: 'approved', evidence: [], ...extra,
})
const ctxFor = (sim: SimClient, items: ChecklistItem[], goals: string[] = []): OrchestratorContext => {
  const board: BoardState = {
    world: 'w', simNow: FIT, patients: [{ patientId: 'SIM-000001', name: 'Amira Khan', conditions: ['Heart failure'], needs: [], goals, items }], log: [],
  }
  return { sim, world: 'w', board, log: (m) => board.log.push(m) }
}

const pharmacy = (rxStatus = 'approved', stock = 3, packSize = 1) => [
  { id: 'r-3', kind: 'prescription', patientId: 'SIM-000001', status: rxStatus, version: 4, data: { drug: 'Furosemide tablets' } },
  { id: 'p-1', kind: 'pharmacy-product', status: 'active', version: 1, data: { drug: 'Furosemide tablets', stock, packSize } },
  { id: 'p-2', kind: 'pharmacy-product', status: 'active', version: 1, data: { drug: 'Paracetamol', stock: 100, packSize: 16 } },
]

test('medicines: link, dispense, collect against the matching product, threading the version each step', async () => {
  const f = fakeSim({ views: { pharmacy: pharmacy() } })
  const it = item('medicines')
  const res = await resolverFor(it)!(ctxFor(f.sim, [it]), it)
  assert.deepEqual(f.writes.map((w) => w.body.type), ['link_prescription_stock', 'dispense', 'collect'])
  assert.ok(f.writes.every((w) => w.site === 'pharmacy'))
  assert.equal(f.writes[0].body.productId, 'p-1', 'the product with the same drug, not the first product')
  assert.equal(f.writes[0].body.quantity, 1)
  assert.deepEqual(f.writes.map((w) => w.body.expectedVersion), [4, 5, 6], 'each step uses the version the previous step returned')
  assert.deepEqual(f.writes.map((w) => w.key), ['w-sim-000001-medicines-link-1', 'w-sim-000001-medicines-dispense-1', 'w-sim-000001-medicines-collect-1'])
  assert.equal(res.resourceId, 'r-3')
  assert.equal(f.views.pharmacy[0].status, 'collected')
})

test('medicines: idempotency keys carry the attempt number so a retry never reuses a key', async () => {
  const f = fakeSim({ views: { pharmacy: pharmacy() } })
  const it = item('medicines', { attempts: 2 })
  await resolverFor(it)!(ctxFor(f.sim, [it]), it)
  assert.ok(f.writes.every((w) => w.key!.endsWith('-2')), f.writes.map((w) => w.key).join(','))
})

test('medicines: refuses when stock is short, and writes nothing', async () => {
  const f = fakeSim({ views: { pharmacy: pharmacy('approved', 0, 28) } })
  const it = item('medicines')
  await assert.rejects(resolverFor(it)!(ctxFor(f.sim, [it]), it), /insufficient stock/)
  assert.equal(f.writes.length, 0)
})

test('medicines: refuses when there is no approved prescription', async () => {
  const f = fakeSim({ views: { pharmacy: pharmacy('draft') } })
  const it = item('medicines')
  await assert.rejects(resolverFor(it)!(ctxFor(f.sim, [it]), it), /no approved prescription/)
})

test('medicines: resumes a chain that already reached dispensed, with only the collect step', async () => {
  const f = fakeSim({ views: { pharmacy: pharmacy('dispensed') } })
  const it = item('medicines')
  const res = await resolverFor(it)!(ctxFor(f.sim, [it]), it)
  assert.deepEqual(f.writes.map((w) => w.body.type), ['collect'])
  assert.match(res.action, /resumed/)
  assert.equal(res.resourceId, 'r-3')
})

test('bloods: orders both U&E and FBC as routine, and records the FBC as a second resource to verify', async () => {
  const f = fakeSim({ views: { diagnostics: [] } })
  const it = item('bloods')
  const res = await resolverFor(it)!(ctxFor(f.sim, [it]), it)
  assert.deepEqual(f.writes.map((w) => w.body.bloodTestOrder.panelId), ['ue', 'fbc'])
  for (const w of f.writes) {
    assert.equal(w.site, 'hospital')
    assert.equal(w.body.type, 'order_test')
    assert.equal(w.body.bloodTestOrder.priority, 'routine', 'yesterday\'s U&E was near-normal: never urgent')
    assert.ok(w.body.bloodTestOrder.clinicalDetails.length > 0)
    assert.ok(w.body.bloodTestOrder.clinicalDetails.length <= 2000, 'simulator caps clinicalDetails at 2000 chars')
  }
  assert.equal(res.alsoResourceIds?.length, 1)
  assert.notEqual(res.resourceId, res.alsoResourceIds![0])
  assert.equal(it.generated, 'fallback', 'no model key in tests: provenance must say so')
})

test('device: connects a watch on the wearables site', async () => {
  const f = fakeSim({ views: { wearables: [] } })
  const it = item('device')
  const res = await resolverFor(it)!(ctxFor(f.sim, [it]), it)
  assert.equal(f.writes.length, 1)
  assert.equal(f.writes[0].site, 'wearables')
  assert.equal(f.writes[0].body.type, 'connect_device')
  assert.equal(f.writes[0].body.patientId, 'SIM-000001')
  assert.equal(res.atSimTime, FIT, 'resolution is stamped with sim time, which the device verifier compares readings against')
})

test('visit: scheduled from the hospital and lands on the community board', async () => {
  const f = fakeSim({ views: { community: [] } })
  const it = item('visit')
  const res = await resolverFor(it)!(ctxFor(f.sim, [it]), it)
  assert.equal(f.writes[0].site, 'hospital')
  assert.equal(f.writes[0].body.type, 'schedule_visit')
  assert.equal(f.views.community[0].id, res.resourceId)
})

test('every resolvable item type has a plan, and the plan ends with what verification requires', () => {
  for (const suffix of ['medicines', 'bloods', 'device', 'visit', 'summary', 'follow-up']) {
    const plan = planFor(item(suffix))
    assert.ok(plan && plan.length >= 2, suffix)
    assert.match(plan.at(-1)!, /after the clock moves|require|verif/i, `${suffix}: last step should describe the check`)
  }
  assert.equal(planFor(item('clinical-hold')), undefined)
  assert.equal(planFor(item('care-package')), undefined)
})

// --- Telephone rebook: book first, cancel second ------------------------------

const DAY = 86_400_000
const tomorrow = Math.floor(FIT / DAY) * DAY + DAY
const telephoneSession = (extra: Record<string, unknown> = {}) => ({
  id: 'sess-tel', kind: 'appointment-session', status: 'open', version: 3, title: 'Telephone AM',
  data: { mode: 'telephone', clinician: 'Dr Daniel Brooks', startsAt: tomorrow + 8 * 3_600_000, endsAt: tomorrow + 12 * 3_600_000, slotMinutes: 15,
    blockedSlots: [{ startsAt: tomorrow + 8 * 3_600_000, reason: 'Protected break' }], ...extra },
})
const inPersonToday = { id: 'appt-old', kind: 'appointment', patientId: 'SIM-000001', status: 'booked', version: 2, data: { mode: 'in-person', clinician: 'Dr Maya Shah', startsAt: FIT + 15 * 60_000 } }

test('follow-up: books into an existing telephone session, skipping blocked and taken slots, and only then cancels the in-person slot', async () => {
  const taken = { id: 'appt-x', kind: 'appointment', patientId: 'SIM-000009', status: 'booked', data: { mode: 'telephone', clinician: 'Dr Daniel Brooks', startsAt: tomorrow + 8 * 3_600_000 + 15 * 60_000 } }
  const f = fakeSim({ views: { gp: [] }, sessions: [telephoneSession()], appointments: [inPersonToday, taken] })
  const it = item('follow-up')
  const res = await resolverFor(it)!(ctxFor(f.sim, [it], ['Avoid unnecessary travel']), it)
  assert.deepEqual(f.writes.map((w) => w.body.type), ['create_task', 'book_appointment', 'cancel_appointment'], 'no session is created when one exists; cancel comes after booking')
  const booking = f.writes[1].body
  assert.equal(booking.sessionId, 'sess-tel')
  assert.equal(booking.sessionVersion, 3)
  assert.equal(booking.startsAt, tomorrow + 8 * 3_600_000 + 30 * 60_000, '08:00 is blocked and 08:15 is taken, so 08:30')
  assert.equal(f.writes[2].body.resourceId, 'appt-old')
  assert.equal(res.alsoResourceIds?.length, 1)
})

test('follow-up: when the telephone booking fails the in-person appointment is left alone', async () => {
  const f = fakeSim({
    views: { gp: [] }, sessions: [telephoneSession()], appointments: [inPersonToday],
    onAction: (w) => { if (w.body.type === 'book_appointment') throw new Error('HTTP 409: slot just taken') },
  })
  const it = item('follow-up')
  const res = await resolverFor(it)!(ctxFor(f.sim, [it], ['Avoid unnecessary travel']), it)
  assert.deepEqual(f.writes.map((w) => w.body.type), ['create_task', 'book_appointment'])
  assert.ok(!f.writes.some((w) => w.body.type === 'cancel_appointment'), 'never cancel without a replacement')
  assert.equal(res.alsoResourceIds, undefined)
  assert.equal(res.resourceId, f.views.gp[0].id, 'the task still stands')
})

test('follow-up: with no telephone session on the day, one is created after the surgery day ends', async () => {
  const f = fakeSim({ views: { gp: [] }, appointments: [inPersonToday] })
  const it = item('follow-up')
  await resolverFor(it)!(ctxFor(f.sim, [it], ['Avoid unnecessary travel']), it)
  assert.deepEqual(f.writes.map((w) => w.body.type), ['create_task', 'create_appointment_session', 'book_appointment', 'cancel_appointment'])
  const session = f.writes[1].body
  assert.equal(session.mode, 'telephone')
  assert.equal(session.startsAt, tomorrow + 17 * 3_600_000, 'after the seeded 08:00-12:00 and 13:00-17:00 surgeries')
})

test('idempotency keys include the run id when the board has one', async () => {
  const f = fakeSim({ views: { wearables: [] } })
  const it = item('device')
  const ctx = ctxFor(f.sim, [it])
  ctx.board.runId = 'ab12cd'
  const res = await resolverFor(it)!(ctx, it)
  assert.equal(res.idempotencyKey, 'w-ab12cd-sim-000001-device-connect-1')
  const g = fakeSim({ views: { wearables: [] } })
  const ctx2 = ctxFor(g.sim, [item('device')])
  ctx2.board.runId = 'ef34ab'
  const res2 = await resolverFor(ctx2.board.patients[0].items[0])!(ctx2, ctx2.board.patients[0].items[0])
  assert.notEqual(res.idempotencyKey, res2.idempotencyKey, 'a fresh process never reuses a key')
})

test('bloods: the clinical details cite the patient\'s own conditions, not a template diagnosis', async () => {
  const f = fakeSim({ views: { diagnostics: [] } })
  const it = item('bloods')
  const ctx = ctxFor(f.sim, [it])
  ctx.board.patients[0].conditions = ['Frailty']
  await resolverFor(it)!(ctx, it)
  const details: string = f.writes[0].body.bloodTestOrder.clinicalDetails
  assert.match(details, /Frailty/)
  assert.doesNotMatch(details, /CKD|diuretic|heart failure/i)
})

// --- Medicines: the chain acts on the cited prescription, never on history ----

test('medicines: an old collected prescription in the pharmacy view does not short-circuit the chain for the cited approved one', async () => {
  const old = { id: 'r-old', kind: 'prescription', patientId: 'SIM-000001', status: 'collected', version: 9, createdAt: FIT - 40 * 86_400_000, data: { drug: 'Furosemide tablets' } }
  const f = fakeSim({ views: { pharmacy: [old, ...pharmacy()] } })
  const it = item('medicines', { evidence: [{ resourceId: 'r-3', site: 'hospital', quote: 'Discharge medication supply: status approved, not dispensed or collected' }] })
  const res = await resolverFor(it)!(ctxFor(f.sim, [it]), it)
  assert.deepEqual(f.writes.map((w) => w.body.type), ['link_prescription_stock', 'dispense', 'collect'], 'the full chain runs on r-3')
  assert.ok(f.writes.every((w) => w.body.resourceId === 'r-3'))
  assert.equal(res.resourceId, 'r-3', 'the verifier will read r-3, not the historical r-old')
  assert.doesNotMatch(res.action, /already collected/)
})

test('medicines: resume still works on the cited prescription when an earlier attempt got it to dispensed', async () => {
  const other = { id: 'r-other', kind: 'prescription', patientId: 'SIM-000001', status: 'approved', version: 1, data: { drug: 'Paracetamol' } }
  const f = fakeSim({ views: { pharmacy: [other, ...pharmacy('dispensed')] } })
  const it = item('medicines', { evidence: [{ resourceId: 'r-3', site: 'hospital', quote: 'Discharge medication supply: status approved' }] })
  const res = await resolverFor(it)!(ctxFor(f.sim, [it]), it)
  assert.deepEqual(f.writes.map((w) => `${w.body.type}:${w.body.resourceId}`), ['collect:r-3'])
  assert.equal(res.resourceId, 'r-3')
  assert.match(res.action, /resumed/)
})

test('medicines: a cited prescription that is not approved is refused with its real status, and nothing else is touched', async () => {
  const f = fakeSim({ views: { pharmacy: pharmacy('draft') } })
  const it = item('medicines', { evidence: [{ resourceId: 'r-3', site: 'hospital', quote: 'Discharge medication supply: status draft' }] })
  await assert.rejects(resolverFor(it)!(ctxFor(f.sim, [it]), it), /r-3.*draft/)
  assert.equal(f.writes.length, 0)
})

test('findFreeTelephoneSlot never loops forever on a session with a zero or missing slot length', () => {
  const session = telephoneSession({ slotMinutes: 0 })
  const slot = findFreeTelephoneSlot({ appointments: [], sessions: [session] }, tomorrow)
  assert.ok(slot, 'a slot is still found')
  assert.equal(slot!.startsAt, tomorrow + 8 * 3_600_000 + 15 * 60_000, '08:00 is blocked; a sane default step of 15 minutes applies')
  const open = telephoneSession({ startsAt: undefined, endsAt: undefined })
  assert.equal(findFreeTelephoneSlot({ appointments: [], sessions: [open] }, tomorrow), undefined, 'a session with no times cannot be booked into')
})

// --- Summary: only the cited hospital document is shared; the letter states real arrangements ---

test('summary: shares only the hospital documents the item cites, never the summary it just saved nor uncited letters', async () => {
  const f = fakeSim({
    views: {
      hospital: [
        { id: 'r-1', kind: 'document', patientId: 'SIM-000001', title: 'Admission note', version: 1, visibleTo: ['hospital'], data: { text: 'Blood monitoring requested; home equipment and medication handover not confirmed.' } },
        { id: 'r-9', kind: 'document', patientId: 'SIM-000001', title: 'Psychiatry liaison letter', version: 1, visibleTo: ['hospital'], data: { text: 'Confidential.' } },
      ],
      diagnostics: [],
    },
  })
  const it = item('summary', { evidence: [{ resourceId: 'r-1', site: 'hospital', quote: 'home equipment and medication handover not confirmed' }] })
  const res = await resolverFor(it)!(ctxFor(f.sim, [it]), it)
  const shares = f.writes.filter((w) => w.body.type === 'share_record')
  assert.deepEqual(shares.map((w) => w.body.resourceId), ['r-1'], 'the cited admission note only')
  assert.deepEqual(res.alsoResourceIds, ['r-1'])
  assert.ok(!shares.some((w) => w.body.resourceId === res.resourceId), 'the summary reaches the GP through send, never share_record (the sim answers 409)')
  assert.ok(!f.writes.some((w) => w.body.resourceId === 'r-9'))
})

test('summary: with no cited document nothing is shared and the resolution says so', async () => {
  const f = fakeSim({ views: { hospital: [{ id: 'r-9', kind: 'document', patientId: 'SIM-000001', version: 1, visibleTo: ['hospital'] }], diagnostics: [] } })
  const it = item('summary')
  const res = await resolverFor(it)!(ctxFor(f.sim, [it]), it)
  assert.deepEqual(f.writes.map((w) => w.body.type), ['save_discharge_summary', 'process_document'])
  assert.equal(res.alsoResourceIds, undefined)
  assert.equal(res.action, 'save_discharge_summary+send')
})

test('summary: the letter lists only arrangements the agent is actually making for this patient', async () => {
  const f = fakeSim({ views: { hospital: [], diagnostics: [] } })
  // Only a follow-up task is in the plan: no visit, no watch.
  const summary = item('summary')
  const followUp = item('follow-up')
  await resolverFor(summary)!(ctxFor(f.sim, [summary, followUp]), summary)
  const sections = f.writes[0].body.dischargeSections as Record<string, string>
  assert.doesNotMatch(sections.followUp, /visit|watch/i, 'nothing claimed that is not on this patient\'s checklist')
  assert.match(sections.followUp, /GP .*48/i)
  for (const k of ['reason', 'course', 'diagnoses', 'medicationChanges', 'results', 'followUp', 'gpActions']) assert.ok(sections[k]?.trim(), `${k} is never empty`)
  // Nothing else in the plan at all: the section still says something true.
  const g = fakeSim({ views: { hospital: [], diagnostics: [] } })
  const alone = item('summary')
  await resolverFor(alone)!(ctxFor(g.sim, [alone]), alone)
  const only = g.writes[0].body.dischargeSections as Record<string, string>
  assert.ok(only.followUp.trim())
  assert.doesNotMatch(only.followUp, /visit|watch|telephone review/i)
  // A failed or unapproved item is not an arrangement.
  const h = fakeSim({ views: { hospital: [], diagnostics: [] } })
  const s3 = item('summary')
  await resolverFor(s3)!(ctxFor(h.sim, [s3, item('visit', { state: 'failed' }), item('device', { state: 'proposed' }), item('follow-up', { state: 'verified' })]), s3)
  const sec3 = h.writes[0].body.dischargeSections as Record<string, string>
  assert.doesNotMatch(sec3.followUp, /visit|watch/i)
  assert.match(sec3.followUp, /GP/)
})
