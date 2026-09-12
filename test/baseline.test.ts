import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChecklistItem, PatientRow } from '../src/orchestrator/model.ts'
import { DEFAULT_BASELINE, baselineFor, kindOf, seededRandom } from '../src/story/baseline.ts'

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
})
