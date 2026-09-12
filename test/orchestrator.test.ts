import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { BoardState, ChecklistItem } from '../src/orchestrator/model.ts'
import { isSettled } from '../src/orchestrator/model.ts'
import { approveAll, clearHold, readyForDischarge } from '../src/orchestrator/run.ts'

const item = (id: string, state: ChecklistItem['state']): ChecklistItem => ({
  id, patientId: 'SIM-000001', title: id, owner: 'gp', state, evidence: [],
})

const board = (items: ChecklistItem[]): BoardState => ({
  world: 'test-world', simNow: 0,
  patients: [{ patientId: 'SIM-000001', name: 'Test', conditions: [], needs: [], goals: [], items }],
  log: [],
})

test('approveAll approves proposed items only, never holds or blockers', () => {
  const b = board([item('a-proposed', 'proposed'), item('a-hold', 'clinical_hold'), item('a-blocked', 'blocked_human'), item('a-done', 'verified')])
  const n = approveAll(b, 'tester')
  assert.equal(n, 1)
  const states = Object.fromEntries(b.patients[0].items.map((i) => [i.id, i.state]))
  assert.equal(states['a-proposed'], 'approved')
  assert.equal(states['a-hold'], 'clinical_hold')
  assert.equal(states['a-blocked'], 'blocked_human')
  assert.equal(states['a-done'], 'verified')
})

test('approveAll scoped to a patient leaves other patients untouched', () => {
  const b = board([item('a-proposed', 'proposed')])
  b.patients.push({ patientId: 'SIM-000002', name: 'Other', conditions: [], needs: [], goals: [], items: [item('b-proposed', 'proposed')] })
  b.patients[1].items[0].patientId = 'SIM-000002'
  assert.equal(approveAll(b, 'tester', 'SIM-000002'), 1)
  assert.equal(b.patients[0].items[0].state, 'proposed')
  assert.equal(b.patients[1].items[0].state, 'approved')
})

test('clearHold clears clinical_hold and records who signed off', () => {
  const b = board([item('a-hold', 'clinical_hold'), item('a-blocked', 'blocked_human')])
  assert.equal(clearHold(b, 'a-hold', 'Dr Test'), true)
  assert.equal(b.patients[0].items[0].state, 'verified')
  assert.match(b.patients[0].items[0].verification!.observed, /Dr Test/)
  // blocked_human is NOT clearable this way
  assert.equal(clearHold(b, 'a-blocked', 'Dr Test'), false)
  assert.equal(b.patients[0].items[1].state, 'blocked_human')
})

test('readyForDischarge requires every item verified', () => {
  const ready = board([item('a', 'verified'), item('b', 'verified')])
  assert.equal(readyForDischarge(ready.patients[0]), true)
  const blocked = board([item('a', 'verified'), item('b', 'blocked_human')])
  assert.equal(readyForDischarge(blocked.patients[0]), false)
  const failed = board([item('a', 'verified'), item('b', 'failed')])
  assert.equal(readyForDischarge(failed.patients[0]), false)
  const empty = board([])
  assert.equal(readyForDischarge(empty.patients[0]), false)
})

test('isSettled: verified and human states are settled; working states are not', () => {
  assert.equal(isSettled(item('x', 'verified')), true)
  assert.equal(isSettled(item('x', 'clinical_hold')), true)
  assert.equal(isSettled(item('x', 'blocked_human')), true)
  assert.equal(isSettled(item('x', 'proposed')), false)
  assert.equal(isSettled(item('x', 'approved')), false)
  assert.equal(isSettled(item('x', 'awaiting_verification')), false)
})

test('.env.example contains no real-looking secrets', () => {
  const text = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
  assert.doesNotMatch(text, /sim_[0-9a-f]{20,}/, 'sim team key must be a placeholder')
  assert.doesNotMatch(text, /sk-[A-Za-z0-9_-]{20,}/, 'OpenAI key must never appear')
})

test('joinWorld retries /api/keys when the simulator does not answer, and never on a client error', { timeout: 30_000 }, async () => {
  const { joinWorld } = await import('../src/orchestrator/world.ts')
  const { SimClient } = await import('../src/sim/index.ts')
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    if (calls === 1) throw Object.assign(new Error('boom'), { name: 'TimeoutError' })
    return new Response(JSON.stringify({ apiKey: 'key-after-retry' }), { status: 201, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    const retries: number[] = []
    const { sim } = await joinWorld('probe-world', undefined, 3, (attempt) => retries.push(attempt))
    assert.equal(calls, 2)
    assert.deepEqual(retries, [1])
    assert.ok(sim instanceof SimClient)
    calls = 0
    globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ error: 'bad name' }), { status: 400, headers: { 'content-type': 'application/json' } }) }) as typeof fetch
    await assert.rejects(joinWorld('bad', undefined, 3), (e: any) => e.status === 400)
    assert.equal(calls, 1, 'a 400 is not retried')
  } finally {
    globalThis.fetch = realFetch
  }
})
