import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BoardState, ChecklistItem, PatientRow } from '../src/orchestrator/model.ts'
import { DEFAULT_BASELINE, baselineFor, kindOf, seededRandom } from '../src/story/baseline.ts'
import { computeStory, countersAt } from '../src/story/story.ts'

const FIT = 1789200000000
const MIN = 60_000
const HOUR = 60 * MIN

const item = (id: string, owner: ChecklistItem['owner'], state: ChecklistItem['state'] = 'proposed'): ChecklistItem => ({
  id, patientId: 'SIM-000001', title: id, owner, state, evidence: [],
})
const amira = (): PatientRow => ({
  patientId: 'SIM-000001', name: 'Amira Khan', conditions: [], needs: [], goals: [],
  items: [
    item('sim-000001-clinical-hold', 'clinician', 'clinical_hold'),
    item('sim-000001-medicines', 'pharmacy'),
    item('sim-000001-bloods', 'diagnostics'),
    item('sim-000001-device', 'wearables'),
    item('sim-000001-visit', 'community'),
    item('sim-000001-summary', 'hospital'),
    item('sim-000001-follow-up', 'gp'),
  ],
})

test('kindOf reads the stable id suffix', () => {
  assert.equal(kindOf({ id: 'sim-000001-follow-up' }), 'follow-up')
  assert.equal(kindOf({ id: 'sim-000006-care-package' }), 'care-package')
  assert.equal(kindOf({ id: 'sim-000001-clinical-hold' }), 'clinical-hold')
  assert.equal(kindOf({ id: 'x-something-else' }), 'other')
})

test('seeded RNG is deterministic and in [0,1)', () => {
  const a = seededRandom('SIM-000001:x'), b = seededRandom('SIM-000001:x'), c = seededRandom('SIM-000001:y')
  const va = [a(), a(), a()], vb = [b(), b(), b()], vc = [c(), c(), c()]
  assert.deepEqual(va, vb)
  assert.notDeepEqual(va, vc)
  for (const v of va) assert.ok(v >= 0 && v < 1)
})

test('baseline model is deterministic and respects the stated sequencing', () => {
  const t1 = baselineFor(amira(), FIT)
  const t2 = baselineFor(amira(), FIT)
  assert.deepEqual(t1, t2)
  const by = Object.fromEntries(t1.items.map((i) => [i.kind, i]))
  // Every job is picked up on its team's poll grid, after it became startable.
  for (const i of t1.items) {
    assert.ok(i.doneAt !== null && i.doneAt > i.startAt, `${i.kind} completes after it starts`)
    const poll = DEFAULT_BASELINE.pollMinutes[i.owner] * MIN
    assert.equal((i.pickedUpAt! - FIT) % poll, 0, `${i.kind} picked up on the ${i.owner} poll grid`)
  }
  // Letter waits for bloods and the clinical review; everything downstream waits for the letter.
  assert.ok(by.summary.startAt >= by.bloods.doneAt!)
  assert.ok(by.summary.startAt >= by['clinical-hold'].doneAt!)
  for (const k of ['medicines', 'follow-up', 'visit', 'device']) assert.ok(by[k].startAt >= by.summary.doneAt!, `${k} starts after the letter`)
  // Home at a ward round after the last job, and the GP's next-day inbox makes it a long stay.
  const last = Math.max(...t1.items.map((i) => i.doneAt!))
  assert.ok(t1.homeAt! >= last)
  assert.equal((t1.homeAt! - FIT) % (DEFAULT_BASELINE.wardRoundMinutes * MIN), 0)
  assert.ok(t1.homeAt! - FIT >= 24 * HOUR, 'manual model keeps the bed past 24h')
})

test('baseline never discharges a patient whose barrier needs an external human decision', () => {
  const row = amira()
  row.items.push(item('sim-000001-care-package', 'community', 'blocked_human'))
  const t = baselineFor(row, FIT)
  assert.equal(t.homeAt, null)
  assert.equal(t.blockedBy, 'sim-000001-care-package')
  assert.equal(t.items.find((i) => i.kind === 'care-package')!.doneAt, null)
  // ...and such a patient never counts towards bed-hours saved, even if the agent freed the bed.
  row.dischargedAt = FIT + HOUR
  const story = computeStory({ world: 'w', simNow: FIT + 2 * HOUR, fitAt: FIT, patients: [row], log: [] })
  assert.equal(story.counters.bedsFreed, 1)
  assert.equal(story.counters.bedHoursSaved, 0)
})

test('computeStory: agent lane from verification times, counters honest about what is known', () => {
  const row = amira()
  for (const i of row.items) {
    i.state = 'verified'
    i.verification = { passed: true, observed: 'ok', atSimTime: FIT + 121 * MIN }
  }
  row.dischargedAt = FIT + 4 * HOUR
  const board: BoardState = { world: 'w', simNow: FIT + 4 * HOUR, fitAt: FIT, patients: [row], log: [] }
  const story = computeStory(board)
  assert.equal(story.fitAt, FIT)
  assert.equal(story.patients[0].agent.homeAt, FIT + 4 * HOUR)
  assert.equal(story.patients[0].agent.items.filter((i) => i.doneAt !== null).length, 7)
  const modelHome = story.patients[0].baseline.homeAt!
  // At now (+4h): one bed freed; headline = model discharge minus actual discharge.
  assert.equal(story.counters.bedsFreed, 1)
  assert.equal(story.counters.bedHoursSaved, Math.round(((modelHome - (FIT + 4 * HOUR)) / HOUR) * 10) / 10)
  assert.equal(story.counters.patientsHomeBaseline, 0)
  const atModelHome = countersAt(story.patients, modelHome, story.now)
  assert.equal(atModelHome.patientsHomeBaseline, 1)
  assert.equal(atModelHome.bedHoursSaved, story.counters.bedHoursSaved)
  // Before the agent discharged nobody is home in either lane.
  const early = countersAt(story.patients, FIT + HOUR, story.now)
  assert.deepEqual([early.bedsFreed, early.patientsHomeBaseline, early.bedHoursSaved], [0, 0, 0])
  assert.ok(story.horizon >= modelHome)
})

test('computeStory infers fitAt from the earliest action when the board predates the field', () => {
  const row = amira()
  row.items[1].state = 'awaiting_verification'
  row.items[1].resolution = { action: 'x', resourceId: 'r', idempotencyKey: 'k', atSimTime: FIT + 5 * MIN }
  const board: BoardState = { world: 'w', simNow: FIT + 2 * HOUR, patients: [row], log: [] }
  assert.equal(computeStory(board).fitAt, FIT + 5 * MIN)
})

test('seeded RNG matches a pinned vector, so a refactor cannot silently change the story', () => {
  const r = seededRandom('homeward')
  assert.deepEqual([r(), r(), r()], [0.5357386840041727, 0.7869005070533603, 0.5163526360411197])
  const f = seededRandom('SIM-000001:sim-000001-follow-up')
  assert.deepEqual([f(), f()], [0.20775632187724113, 0.9898728874977678])
})

test('the numbers shown agree with the stated parameters on a hand-built board', () => {
  const P = DEFAULT_BASELINE
  const missedFor = (seed: string) => { const r = seededRandom(seed); let m = 0; while (r() < P.dropProbability && m < 8) m++; return m }
  const row: PatientRow = { patientId: 'SIM-000001', name: 'Amira Khan', conditions: [], needs: [], goals: [], dischargedAt: FIT + 2 * HOUR,
    items: [{ ...item('sim-000001-follow-up', 'gp', 'verified'), verification: { passed: true, observed: 'task exists', atSimTime: FIT + 121 * MIN } }] }
  const t = baselineFor(row, FIT)
  const fu = t.items[0]
  const poll = P.pollMinutes.gp * MIN
  const missed = missedFor('SIM-000001:sim-000001-follow-up')
  assert.equal(fu.missedPolls, missed)
  assert.equal(fu.pickedUpAt, FIT + (1 + missed) * poll, 'picked up at the first GP poll after fit, plus one poll per miss')
  assert.equal(fu.doneAt, fu.pickedUpAt, 'no lead time for a GP task')
  const round = P.wardRoundMinutes * MIN
  let home = FIT + Math.ceil((fu.doneAt! - FIT) / round) * round
  if (home <= fu.doneAt!) home += round
  assert.equal(t.homeAt, home, 'home at the first ward round strictly after the last job')
  // Pinned: one missed 24h poll, so the task is picked up at +2880 min and the bed goes at +3000 min.
  assert.equal(missed, 1)
  assert.equal((t.homeAt! - FIT) / MIN, 3000)
  assert.match(fu.note, /gp inbox every 1440 min, missed 1 poll/)
  const story = computeStory({ world: 'w', simNow: FIT + 3 * HOUR, fitAt: FIT, patients: [row], log: [] })
  assert.deepEqual(story.params, P, 'the parameters shown are the parameters used')
  assert.equal(story.counters.bedHoursSaved, (home - (FIT + 2 * HOUR)) / HOUR)
  assert.equal(story.counters.bedHoursSaved, 48)
  // A job with a lead time is noticed at the owning team's next poll after the lead.
  const bl = baselineFor({ ...row, items: [item('sim-000001-bloods', 'diagnostics')] }, FIT).items[0]
  const dPoll = P.pollMinutes.diagnostics * MIN
  assert.equal(bl.pickedUpAt, FIT + (1 + missedFor('SIM-000001:sim-000001-bloods')) * dPoll)
  assert.equal(bl.doneAt, FIT + Math.ceil((bl.pickedUpAt! + P.leadMinutes.bloods! * MIN - FIT) / dPoll) * dPoll)
  assert.equal((bl.doneAt! - FIT) / MIN, 480)
})

test('baseline timing per item does not depend on the order items are listed in', () => {
  const a = baselineFor(amira(), FIT)
  const shuffled = amira(); shuffled.items.reverse()
  const b = baselineFor(shuffled, FIT)
  const by = (t: ReturnType<typeof baselineFor>) => Object.fromEntries(t.items.map((i) => [i.id, [i.startAt, i.pickedUpAt, i.doneAt]]))
  assert.deepEqual(by(a), by(b))
  assert.equal(a.homeAt, b.homeAt)
})

const finiteEverywhere = (v: unknown, path = 'story'): void => {
  if (typeof v === 'number') assert.ok(Number.isFinite(v), `${path} is ${v}`)
  else if (Array.isArray(v)) v.forEach((x, i) => finiteEverywhere(x, `${path}[${i}]`))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) finiteEverywhere(x, `${path}.${k}`)
}
const sane = (board: BoardState, what: string) => {
  const s = computeStory(board)
  finiteEverywhere(s, what)
  assert.ok(s.now >= s.fitAt, `${what}: now >= fitAt`)
  assert.ok(s.horizon >= s.now, `${what}: horizon >= now`)
  for (const k of ['bedsFreed', 'patientsHomeAgent', 'patientsHomeBaseline', 'bedHoursSaved'] as const) assert.ok(s.counters[k] >= 0, `${what}: ${k} >= 0`)
  for (const p of s.patients) {
    for (const i of p.baseline.items) assert.ok(i.doneAt === null || i.doneAt > s.fitAt, `${what}: ${i.id} baseline done after fit`)
    assert.ok(p.baseline.homeAt === null || p.baseline.homeAt > s.fitAt, `${what}: baseline home after fit`)
    for (const i of p.agent.items) assert.ok(i.doneAt === null || Number.isFinite(i.doneAt), `${what}: ${i.id} agent doneAt is a time or null`)
  }
  return s
}

test('computeStory never yields NaN, Infinity or negative durations on degenerate boards', () => {
  sane({ world: 'w', simNow: 0, patients: [], log: [] }, 'empty board at t=0')
  sane({ world: 'w', simNow: 0, patients: [amira()], log: [] }, 'simNow 0, no fitAt, no actions')
  sane({ world: 'w', simNow: Number.NaN, patients: [amira()], log: [] }, 'simNow NaN')
  sane({ world: 'w', simNow: undefined as never, fitAt: FIT, patients: [amira()], log: [] }, 'simNow missing')
  sane({ world: 'w', simNow: FIT, fitAt: Number.NaN, patients: [amira()], log: [] }, 'fitAt NaN')
  const noTime = amira()
  noTime.items[1].state = 'verified'
  noTime.items[1].verification = { passed: true, observed: 'x' } as never
  const s1 = sane({ world: 'w', simNow: FIT, fitAt: FIT, patients: [noTime], log: [] }, 'verification without a time')
  assert.equal(s1.patients[0].agent.items[1].doneAt, null, 'an undated verification is not a done time')
  const noItems: PatientRow = { ...amira(), items: undefined as never }
  sane({ world: 'w', simNow: FIT, fitAt: FIT, patients: [noItems], log: [] }, 'row without items')
  sane({ world: 'w', simNow: FIT, fitAt: FIT, patients: [amira()], log: [] }, 'fit now')
  // Custom parameters that would divide by zero.
  const zero = { ...DEFAULT_BASELINE, pollMinutes: { ...DEFAULT_BASELINE.pollMinutes, gp: 0 }, wardRoundMinutes: 0 }
  finiteEverywhere(computeStory({ world: 'w', simNow: FIT, fitAt: FIT, patients: [amira()], log: [] }, zero), 'zero-minute polls')
})

test('a discharge recorded before fit never inflates bed-hours saved', () => {
  const row = amira()
  for (const i of row.items) { i.state = 'verified'; i.verification = { passed: true, observed: 'ok', atSimTime: FIT + HOUR } }
  row.dischargedAt = FIT - 3 * HOUR
  const s = sane({ world: 'w', simNow: FIT + 4 * HOUR, fitAt: FIT, patients: [row], log: [] }, 'discharged before fit')
  const modelHome = s.patients[0].baseline.homeAt!
  assert.equal(s.counters.bedsFreed, 1)
  assert.equal(s.counters.bedHoursSaved, Math.round(((modelHome - FIT) / HOUR) * 10) / 10, 'saving counts from fit, not from before the story starts')
  // When fitAt has to be inferred, the discharge time bounds it too.
  const inferred = computeStory({ world: 'w', simNow: FIT + 4 * HOUR, patients: [row], log: [] })
  assert.ok(inferred.fitAt <= row.dischargedAt!, 'inferred fit is never after the discharge')
})
