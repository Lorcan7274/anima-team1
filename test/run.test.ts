/**
 * The run loop: resolve approved items, advance the clock, verify, repeat.
 * These cover failure handling, the verify-again loop, the round cap,
 * detection merging on re-run, and the escalation handover.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
delete process.env.OPENAI_API_KEY
import type { BoardState, ChecklistItem, OrchestratorContext } from '../src/orchestrator/model.ts'
import { detectAll, prepareEscalation, runUntilSettled } from '../src/orchestrator/run.ts'
import { amiraHospitalView, fakeSim, FIT } from './helpers/fake-sim.ts'
import type { SimClient } from '../src/sim/index.ts'

const item = (suffix: string, state: ChecklistItem['state'], extra: Partial<ChecklistItem> = {}): ChecklistItem => ({
  id: `sim-000001-${suffix}`, patientId: 'SIM-000001', title: suffix, owner: 'gp', state, evidence: [], ...extra,
})
const ctxFor = (sim: SimClient, items: ChecklistItem[]): OrchestratorContext => {
  const board: BoardState = {
    world: 'w', simNow: FIT,
    patients: [{ patientId: 'SIM-000001', name: 'Amira Khan', conditions: [], needs: ['Home visit'], goals: [], stage: 'inpatient', items }],
    log: [],
  }
  return { sim, world: 'w', board, log: (m) => board.log.push(m) }
}

test('a resolver error marks the item failed with the reason, and the loop does not retry it', async () => {
  const f = fakeSim({ views: { pharmacy: [] } }) // no prescription: medicines resolver throws
  const ctx = ctxFor(f.sim, [item('medicines', 'approved')])
  await runUntilSettled(ctx)
  const it = ctx.board.patients[0].items[0]
  assert.equal(it.state, 'failed')
  assert.match(it.error ?? '', /no approved prescription/)
  assert.equal(it.attempts, 1)
  assert.ok(ctx.board.log.some((l) => l.startsWith('FAILED sim-000001-medicines')))
  assert.equal(f.advances, 1, 'the round still advances the clock for anything else in flight')
  await runUntilSettled(ctx)
  assert.equal(it.attempts, 1, 'a failed item is left for a human; the loop never re-runs it on its own')
  assert.equal(f.writes.length, 0)
})

test('an item that is not ready on the first check is re-verified after the next advance', async () => {
  const f = fakeSim({
    views: { community: [] },
    onAdvance: (_now, views, advances) => {
      if (advances === 2) for (const v of views.community) v.status = 'completed'
    },
  })
  const ctx = ctxFor(f.sim, [item('visit', 'approved')])
  await runUntilSettled(ctx, { advanceMinutes: 60, maxRounds: 3 })
  const it = ctx.board.patients[0].items[0]
  assert.equal(it.state, 'verified')
  assert.equal(f.advances, 2)
  assert.equal(f.now, FIT + 120 * 60_000)
  assert.equal(f.writes.length, 1, 'resolved once, verified twice')
  assert.equal(ctx.board.log.filter((l) => l.startsWith('not yet sim-000001-visit')).length, 1)
  assert.equal(ctx.board.log.filter((l) => l.startsWith('VERIFIED sim-000001-visit')).length, 1)
  assert.equal(it.verification?.atSimTime, FIT + 120 * 60_000)
})

test('the round cap stops the loop with the item still awaiting verification, never falsely verified', async () => {
  const f = fakeSim({ views: { community: [] } }) // the visit never completes
  const ctx = ctxFor(f.sim, [item('visit', 'approved')])
  await runUntilSettled(ctx, { maxRounds: 3 })
  const it = ctx.board.patients[0].items[0]
  assert.equal(it.state, 'awaiting_verification')
  assert.equal(it.verification?.passed, false)
  assert.equal(f.advances, 3)
  assert.equal(ctx.board.busy, false)
})

test('a mixed board acts on approved items and leaves proposed ones untouched', async () => {
  const f = fakeSim({
    views: { community: [], gp: [] },
    onAdvance: (_now, views) => { for (const v of views.community ?? []) v.status = 'completed' },
  })
  const ctx = ctxFor(f.sim, [item('visit', 'approved'), item('follow-up', 'proposed')])
  await runUntilSettled(ctx)
  const [visit, followUp] = ctx.board.patients[0].items
  assert.equal(visit.state, 'verified')
  assert.equal(followUp.state, 'proposed')
  assert.deepEqual(f.writes.map((w) => w.body.type), ['schedule_visit'])
})

test('detectAll merges: existing item state survives a re-run and only new items get a plan', async () => {
  const f = fakeSim({ views: { hospital: amiraHospitalView(), community: [], wearables: [] } })
  const done = item('summary', 'verified', {
    resolution: { action: 'save_discharge_summary+send', resourceId: 's-1', idempotencyKey: 'k', atSimTime: FIT },
    verification: { passed: true, observed: 'sent', atSimTime: FIT },
  })
  const ctx = ctxFor(f.sim, [done])
  await detectAll(ctx)
  const items = ctx.board.patients[0].items
  const summary = items.find((i) => i.id === 'sim-000001-summary')!
  assert.equal(summary, done, 'the tracked item object is kept, not replaced')
  assert.equal(summary.state, 'verified')
  assert.equal(summary.plan, undefined, 'plans are written at detection; a restored item keeps what it had')
  assert.equal(items.length, 7)
  for (const it of items) if (it !== summary && it.state === 'proposed') assert.ok(it.plan && it.plan.length > 0, `${it.id} has a plan`)
  assert.equal(ctx.board.log.filter((l) => l.startsWith('detected ')).length, 6, 'six new items logged, the restored one is not')
  await detectAll(ctx)
  assert.equal(ctx.board.patients[0].items.length, 7, 'a second pass adds nothing')
})

test('prepareEscalation drafts a handover only for a blocked item, and the item stays blocked', async () => {
  const f = fakeSim()
  const blocked = item('care-package', 'blocked_human', { humanReason: 'Funding approval is an external decision.', evidence: [{ resourceId: 'r-44', site: 'community', quote: 'fundingDecision pending' }] })
  const ctx = ctxFor(f.sim, [blocked, item('visit', 'proposed')])
  assert.equal(await prepareEscalation(ctx.board, 'sim-000001-visit'), false)
  assert.equal(await prepareEscalation(ctx.board, 'sim-000001-care-package'), true)
  assert.equal(blocked.state, 'blocked_human')
  assert.ok(blocked.escalation?.responsibleTeam)
  assert.ok(blocked.escalation?.nextAction)
  assert.equal(blocked.escalation?.source, 'fallback', 'without a model key the handover is marked as canned')
  assert.ok(ctx.board.log.some((l) => /ESCALATION prepared .*case remains blocked/.test(l)))
  assert.equal(f.writes.length, 0, 'escalation never touches the simulator')
})

test('pendingWork counts what the demo loop waits on', async () => {
  const { pendingWork } = await import('../src/orchestrator/run.ts')
  const f = fakeSim()
  const ctx = ctxFor(f.sim, [
    item('visit', 'approved'), item('bloods', 'proposed'), item('device', 'proposed'),
    item('clinical-hold', 'clinical_hold'), item('care-package', 'blocked_human'), item('summary', 'verified'),
  ])
  assert.deepEqual(pendingWork(ctx.board), { approved: 1, proposed: 2, holds: 1, blocked: 1 })
})

test('approving one patient runs that plan without waiting for the other patient', async () => {
  const f = fakeSim({
    views: { community: [], gp: [] },
    onAdvance: (_now, views) => { for (const v of views.community ?? []) v.status = 'completed' },
  })
  const ctx = ctxFor(f.sim, [item('visit', 'approved')])
  ctx.board.patients.push({ patientId: 'SIM-000006', name: 'Eleanor Chen', conditions: [], needs: [], goals: [], stage: 'inpatient',
    items: [{ ...item('follow-up', 'proposed'), id: 'sim-000006-follow-up', patientId: 'SIM-000006' }] })
  await runUntilSettled(ctx)
  assert.equal(ctx.board.patients[0].items[0].state, 'verified', 'Amira\'s approved plan ran')
  assert.equal(ctx.board.patients[1].items[0].state, 'proposed', 'Eleanor\'s unapproved plan was not touched')
  assert.deepEqual(f.writes.map((w) => w.body.type), ['schedule_visit'])
})

test('undoHold reinstates a clinician-cleared hold, and only that', async () => {
  const { clearHold, undoHold } = await import('../src/orchestrator/run.ts')
  const f = fakeSim()
  const ctx = ctxFor(f.sim, [
    { ...item('clinical-hold', 'clinical_hold'), owner: 'clinician' },
    item('visit', 'verified', { verification: { passed: true, observed: 'completed', atSimTime: FIT } }),
  ])
  const [hold, visit] = ctx.board.patients[0].items
  assert.equal(undoHold(ctx.board, hold.id, 'Dr Test'), false, 'nothing to undo yet')
  assert.equal(clearHold(ctx.board, hold.id, 'Dr Test'), true)
  assert.equal(hold.state, 'verified')
  assert.equal(undoHold(ctx.board, visit.id, 'Dr Test'), false, 'agent-verified work is not a confirmation')
  assert.equal(visit.state, 'verified')
  assert.equal(undoHold(ctx.board, hold.id, 'Dr Test'), true)
  assert.equal(hold.state, 'clinical_hold')
  assert.equal(hold.verification, undefined)
  assert.ok(ctx.board.log.some((l) => /HOLD REINSTATED/.test(l)))
  clearHold(ctx.board, hold.id, 'Dr Test')
  ctx.board.patients[0].stage = 'discharged'
  assert.equal(undoHold(ctx.board, hold.id, 'Dr Test'), false, 'a recorded discharge is not reversed from here')
})
