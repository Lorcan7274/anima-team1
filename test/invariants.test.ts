/**
 * Engine invariants, run offline against a fake simulator (never a world):
 *  - a verifier only trusts the resource its resolver created (the seeded
 *    'sent' summary must not green-light anything),
 *  - re-running the loop never re-resolves a settled item and never acts on
 *    unapproved items,
 *  - a draft-only summary is saved but never sent,
 *  - clinical holds and external decisions have no resolver at all,
 *  - a patient is never ready for discharge with a hold or blocker open.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
process.env.OPENAI_API_KEY = '' // force the canned drafts: no model calls in tests (set, not deleted: a later loadDotEnv() cannot restore it from .env)
import type { BoardState, ChecklistItem, OrchestratorContext, PatientRow } from '../src/orchestrator/model.ts'
import type { SimClient } from '../src/sim/index.ts'
import { runUntilSettled, readyForDischarge } from '../src/orchestrator/run.ts'
import { resolverFor } from '../src/orchestrator/resolve.ts'
import { verifierFor } from '../src/orchestrator/verify.ts'

const FIT = 1789200000000

interface Write { site: string; body: Record<string, unknown>; key?: string }

/** Minimal simulator double: records writes, serves canned views, ticks its clock. */
function fakeSim(views: Record<string, unknown[]> = {}, gpDocs: unknown[] = []) {
  const writes: Write[] = []
  let now = FIT
  let seq = 100
  const sim = {
    clock: async () => ({ now }),
    advanceClock: async (min: number) => { now += min * 60_000; return { now } },
    siteView: async (site: string) => ({ resources: views[site] ?? [] }),
    gpDocuments: async () => ({ resources: gpDocs }),
    wearables: async () => ({ view: {}, devices: [], observations: [] }),
    siteAppointments: async () => ({ appointments: [] }),
    siteAction: async (site: string, body: Record<string, unknown>, key?: string) => {
      writes.push({ site, body, key })
      const id = (body.resourceId as string) ?? `r-${seq++}`
      const res = { id, status: body.type === 'process_document' ? 'sent' : 'open', version: 1 }
      if (body.type === 'create_task') views.gp = [...(views.gp ?? []), { id, kind: 'task', status: 'open' }]
      return res
    },
    createTask: async (site: string, patientId: string, title: string, key?: string) =>
      sim.siteAction(site, { type: 'create_task', patientId, title }, key),
  }
  return { sim: sim as unknown as SimClient, writes, get now() { return now } }
}

const item = (id: string, owner: ChecklistItem['owner'], state: ChecklistItem['state'], extra: Partial<ChecklistItem> = {}): ChecklistItem => ({
  id, patientId: 'SIM-000001', title: id, owner, state, evidence: [], ...extra,
})
const row = (items: ChecklistItem[]): PatientRow => ({ patientId: 'SIM-000001', name: 'Test Patient', conditions: [], needs: [], goals: [], items })
const ctxFor = (sim: SimClient, items: ChecklistItem[]): OrchestratorContext => {
  const board: BoardState = { world: 'test-world', simNow: FIT, fitAt: FIT, patients: [row(items)], log: [] }
  return { sim, world: 'test-world', board, log: (m) => board.log.push(m) }
}

test('verifier trusts only the resource its resolver created: the seeded sent summary is not ours', async () => {
  const seeded = { id: 'discharge-summary-example', status: 'sent', patientId: 'SIM-000001' }
  const { sim } = fakeSim({}, [seeded])
  const ours = item('sim-000001-summary', 'hospital', 'awaiting_verification', {
    resolution: { action: 'save_discharge_summary+send', resourceId: 'r-ours', idempotencyKey: 'k', atSimTime: FIT },
  })
  const ctx = ctxFor(sim, [ours])
  const notYet = await verifierFor(ours)!(ctx, ours)
  assert.equal(notYet.passed, false, 'a matching seeded letter must not verify our item')
  const { sim: sim2 } = fakeSim({}, [seeded, { id: 'r-ours', status: 'sent' }])
  const ok = await verifierFor(ours)!(ctxFor(sim2, [ours]), ours)
  assert.equal(ok.passed, true)
})

test('follow-up verifier checks the task by id, not "any task for the patient"', async () => {
  const { sim } = fakeSim({ gp: [{ id: 'r-2', kind: 'task', status: 'open' }] }) // seeded task
  const it = item('sim-000001-follow-up', 'gp', 'awaiting_verification', {
    resolution: { action: 'create_task', resourceId: 'r-mine', idempotencyKey: 'k', atSimTime: FIT },
  })
  assert.equal((await verifierFor(it)!(ctxFor(sim, [it]), it)).passed, false)
})

test('clinical holds and external decisions have no resolver and no verifier', () => {
  assert.equal(resolverFor(item('sim-000001-clinical-hold', 'clinician', 'clinical_hold')), undefined)
  assert.equal(resolverFor(item('sim-000006-care-package', 'community', 'blocked_human')), undefined)
  assert.equal(verifierFor(item('sim-000001-clinical-hold', 'clinician', 'clinical_hold')), undefined)
})

test('the loop never acts before staff approval', async () => {
  const f = fakeSim()
  const ctx = ctxFor(f.sim, [item('sim-000001-follow-up', 'gp', 'proposed'), item('sim-000001-clinical-hold', 'clinician', 'clinical_hold')])
  await runUntilSettled(ctx)
  assert.equal(f.writes.length, 0)
  assert.equal(f.now, FIT, 'clock not advanced')
  assert.equal(ctx.board.patients[0].items[0].state, 'proposed')
})

test('re-running the loop is a no-op: settled items are never re-resolved', async () => {
  const f = fakeSim()
  const ctx = ctxFor(f.sim, [
    item('sim-000001-follow-up', 'gp', 'approved', { approval: { by: 't', at: FIT } }),
    item('sim-000001-visit', 'community', 'verified', {
      resolution: { action: 'schedule_visit', resourceId: 'r-old', idempotencyKey: 'k', atSimTime: FIT },
      verification: { passed: true, observed: 'completed', atSimTime: FIT },
    }),
    item('sim-000001-care-package', 'community', 'blocked_human'),
  ])
  await runUntilSettled(ctx, { advanceMinutes: 121, maxRounds: 3 })
  const followUp = ctx.board.patients[0].items[0]
  assert.equal(followUp.state, 'verified')
  assert.equal(f.writes.length, 1, 'exactly one write: the task')
  assert.equal(f.writes[0].body.type, 'create_task')
  assert.equal(f.writes[0].key, 'test-world-sim-000001-follow-up-task-1')
  assert.equal(f.now, FIT + 121 * 60_000)
  // Second run: everything is settled, nothing happens.
  await runUntilSettled(ctx)
  assert.equal(f.writes.length, 1)
  assert.equal(f.now, FIT + 121 * 60_000)
  assert.equal(ctx.board.patients[0].items[2].state, 'blocked_human', 'blocked items stay blocked')
})

test('a draft-only summary is saved but never sent', async () => {
  const f = fakeSim({ hospital: [], diagnostics: [] })
  const it = item('sim-000006-summary', 'hospital', 'approved', { draftOnly: true, patientId: 'SIM-000006' })
  const ctx = ctxFor(f.sim, [it])
  ctx.board.patients[0].patientId = 'SIM-000006'
  const res = await resolverFor(it)!(ctx, it)
  assert.match(res.action, /draft held/)
  assert.deepEqual(f.writes.map((w) => w.body.type), ['save_discharge_summary'])
  assert.ok(!f.writes.some((w) => w.body.documentCommand === 'send'))
})

test('a normal summary is saved, sent, and cited hospital documents are shared with community', async () => {
  const f = fakeSim({ hospital: [{ id: 'r-1', kind: 'document', version: 1, visibleTo: ['hospital'] }], diagnostics: [] })
  const it = item('sim-000001-summary', 'hospital', 'approved', {
    evidence: [{ resourceId: 'r-1', site: 'hospital', quote: 'home equipment and medication handover not confirmed' }],
  })
  const res = await resolverFor(it)!(ctxFor(f.sim, [it]), it)
  assert.deepEqual(f.writes.map((w) => w.body.type), ['save_discharge_summary', 'process_document', 'share_record'])
  assert.equal(f.writes[1].body.documentCommand, 'send')
  assert.equal(f.writes[2].body.target, 'community')
  assert.equal(f.writes[2].body.resourceId, 'r-1')
  assert.notEqual(res.resourceId, 'r-1', 'the verified resource is our summary, not the shared document')
})

test('follow-up only rebooks as telephone when the patient asked to avoid travel', async () => {
  const f = fakeSim()
  const it = item('sim-000001-follow-up', 'gp', 'approved')
  await resolverFor(it)!(ctxFor(f.sim, [it]), it)
  assert.deepEqual(f.writes.map((w) => w.body.type), ['create_task'])
  const g = fakeSim()
  const ctx = ctxFor(g.sim, [item('sim-000001-follow-up', 'gp', 'approved')])
  ctx.board.patients[0].goals = ['Avoid unnecessary travel']
  const res = await resolverFor(ctx.board.patients[0].items[0])!(ctx, ctx.board.patients[0].items[0])
  assert.deepEqual(g.writes.map((w) => w.body.type), ['create_task', 'create_appointment_session', 'book_appointment'])
  assert.equal(g.writes[1].body.mode, 'telephone')
  assert.equal(res.alsoResourceIds?.length, 1)
})

test('never ready for discharge with a hold, a blocker, or a failed item open', () => {
  const ok = row([item('a', 'gp', 'verified')])
  assert.equal(readyForDischarge(ok), true)
  for (const state of ['clinical_hold', 'blocked_human', 'failed', 'awaiting_verification', 'proposed'] as const) {
    assert.equal(readyForDischarge(row([item('a', 'gp', 'verified'), item('b', 'gp', state)])), false, state)
  }
})
