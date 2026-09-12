/**
 * Verifiers re-read the owning service and accept only the resolver's own
 * resource in its finished state. These cover each verifier's pass and fail
 * conditions, including the seeded traps (old visits, old tasks, a device
 * reading from before the watch was issued).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BoardState, ChecklistItem, OrchestratorContext, Resolution } from '../src/orchestrator/model.ts'
import { verifierFor } from '../src/orchestrator/verify.ts'
import { fakeSim, FIT } from './helpers/fake-sim.ts'
import type { SimClient } from '../src/sim/index.ts'

const resolved = (suffix: string, resourceId: string, extra: Partial<Resolution> = {}, itemExtra: Partial<ChecklistItem> = {}): ChecklistItem => ({
  id: `sim-000001-${suffix}`, patientId: 'SIM-000001', title: suffix, owner: 'gp', state: 'awaiting_verification', evidence: [],
  resolution: { action: suffix, resourceId, idempotencyKey: 'k', atSimTime: FIT, ...extra },
  ...itemExtra,
})
const ctxFor = (sim: SimClient, it: ChecklistItem): OrchestratorContext => {
  const board: BoardState = { world: 'w', simNow: FIT, patients: [{ patientId: 'SIM-000001', name: 'A', conditions: [], needs: [], goals: [], items: [it] }], log: [] }
  return { sim, world: 'w', board, log: () => {} }
}
const run = (views: Record<string, any[]>, it: ChecklistItem, gpDocs: any[] = []) =>
  verifierFor(it)!(ctxFor(fakeSim({ views, gpDocs }).sim, it), it)

test('bloods: both orders must be available with results; a pending FBC blocks the item', async () => {
  const it = resolved('bloods', 'o-ue', { alsoResourceIds: ['o-fbc'] })
  const ue = { id: 'o-ue', kind: 'order', status: 'available', data: { kind: 'blood-result' } }
  const pending = await run({ diagnostics: [ue, { id: 'o-fbc', kind: 'order', status: 'open', data: {} }] }, it)
  assert.equal(pending.passed, false)
  assert.match(pending.observed, /o-fbc=open/)
  const done = await run({ diagnostics: [ue, { id: 'o-fbc', kind: 'order', status: 'available', data: { kind: 'blood-result' } }] }, it)
  assert.equal(done.passed, true)
  const missing = await run({ diagnostics: [ue] }, it)
  assert.equal(missing.passed, false)
  assert.match(missing.observed, /missing/)
})

test('device: only a real reading taken after the watch was issued counts', async () => {
  const it = resolved('device', 'd-1')
  const obs = (observedAt: number, value: number | null) => ({ id: `o-${observedAt}`, kind: 'observation', data: { metric: 'steps', value, unit: 'steps', observedAt } })
  assert.equal((await run({ wearables: [obs(FIT - 60_000, 900)] }, it)).passed, false, 'a reading from before connect is seeded history')
  assert.equal((await run({ wearables: [obs(FIT + 600_000, null)] }, it)).passed, false, 'a null reading is a disconnected device')
  const ok = await run({ wearables: [obs(FIT - 60_000, 900), obs(FIT + 600_000, 1700)] }, it)
  assert.equal(ok.passed, true)
  assert.match(ok.observed, /steps=1700/)
})

test('visit: scheduled is not completed, and someone else\'s completed visit does not count', async () => {
  const it = resolved('visit', 'v-mine')
  assert.equal((await run({ community: [{ id: 'v-mine', kind: 'visit', status: 'scheduled' }] }, it)).passed, false)
  assert.equal((await run({ community: [{ id: 'v-old', kind: 'visit', status: 'completed' }] }, it)).passed, false)
  assert.equal((await run({ community: [{ id: 'v-mine', kind: 'visit', status: 'completed' }] }, it)).passed, true)
})

test('medicines: only status collected on our prescription passes', async () => {
  const it = resolved('medicines', 'r-3')
  assert.equal((await run({ pharmacy: [{ id: 'r-3', kind: 'prescription', status: 'dispensed' }] }, it)).passed, false)
  assert.equal((await run({ pharmacy: [{ id: 'r-3', kind: 'prescription', status: 'collected' }] }, it)).passed, true)
  assert.equal((await run({ pharmacy: [] }, it)).passed, false)
})

test('follow-up: the task must exist, and a rebooked appointment must be a booked telephone slot', async () => {
  const task = { id: 't-1', kind: 'task', status: 'open' }
  const plain = resolved('follow-up', 't-1')
  assert.equal((await run({ gp: [task] }, plain)).passed, true)
  const rebooked = resolved('follow-up', 't-1', { alsoResourceIds: ['a-1'] })
  assert.equal((await run({ gp: [task, { id: 'a-1', kind: 'appointment', status: 'booked', data: { mode: 'in-person' } }] }, rebooked)).passed, false)
  assert.equal((await run({ gp: [task, { id: 'a-1', kind: 'appointment', status: 'cancelled', data: { mode: 'telephone' } }] }, rebooked)).passed, false)
  assert.equal((await run({ gp: [task, { id: 'a-1', kind: 'appointment', status: 'booked', data: { mode: 'telephone' } }] }, rebooked)).passed, true)
})

test('summary: sent means our id in the GP feed; a held draft passes only while it stays unsent', async () => {
  const sent = resolved('summary', 's-1')
  assert.equal((await run({}, sent, [{ id: 's-1', status: 'draft' }])).passed, false)
  assert.equal((await run({}, sent, [{ id: 's-1', status: 'sent' }])).passed, true)
  const held = resolved('summary', 's-2', {}, { draftOnly: true })
  assert.equal((await run({ hospital: [{ id: 's-2', kind: 'document', status: 'draft' }] }, held)).passed, true)
  assert.equal((await run({ hospital: [{ id: 's-2', kind: 'document', status: 'sent' }] }, held)).passed, false, 'a letter that went out for a blocked patient is a failure')
  assert.equal((await run({ hospital: [] }, held)).passed, false)
})

test('verification is stamped with the sim clock, not wall time', async () => {
  const f = fakeSim({ views: { pharmacy: [{ id: 'r-3', kind: 'prescription', status: 'collected' }] } })
  await f.sim.advanceClock(121)
  const it = resolved('medicines', 'r-3')
  const v = await verifierFor(it)!(ctxFor(f.sim, it), it)
  assert.equal(v.atSimTime, FIT + 121 * 60_000)
})
