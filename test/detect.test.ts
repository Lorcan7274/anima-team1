/**
 * Detection reads the record and produces the checklist. These tests feed it
 * the seeded shapes the brief documents and check that every item, state,
 * owner and evidence quote comes from the record — never from a template.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
delete process.env.OPENAI_API_KEY // canned model path: no network in tests
import type { ChecklistItem, PatientRow } from '../src/orchestrator/model.ts'
import { bloodSummary, detectForPatient } from '../src/orchestrator/detect.ts'
import { amiraHospitalView, eleanorCommunityView, fakeSim, FIT } from './helpers/fake-sim.ts'

const amira = (): PatientRow => ({
  patientId: 'SIM-000001', name: 'Amira Khan', conditions: ['Heart failure', 'CKD'],
  needs: ['Home visit', 'Carer involvement'], goals: ['Stay at home with a clear contact for help', 'Avoid unnecessary travel'],
  stage: 'inpatient', location: 'AMU bed 12', items: [],
})
const eleanor = (): PatientRow => ({
  patientId: 'SIM-000006', name: 'Eleanor Chen', conditions: ['Frailty'], needs: ['Step-free access'], goals: [],
  stage: 'inpatient', location: 'AMU bed 1', items: [],
})
const byId = (items: ChecklistItem[]): Record<string, ChecklistItem> => Object.fromEntries(items.map((i) => [i.id.replace(/^sim-\d+-/, ''), i]))

test('Amira: all seven barriers detected with the right owner and state', async () => {
  const f = fakeSim({ views: { hospital: amiraHospitalView(), community: [], wearables: [] } })
  const items = await detectForPatient(f.sim, amira())
  const m = byId(items)
  assert.deepEqual(Object.keys(m).sort(), ['bloods', 'clinical-hold', 'device', 'follow-up', 'medicines', 'summary', 'visit'])
  assert.equal(m['clinical-hold'].state, 'clinical_hold')
  assert.equal(m['clinical-hold'].owner, 'clinician')
  for (const k of ['bloods', 'device', 'follow-up', 'medicines', 'summary', 'visit']) assert.equal(m[k].state, 'proposed', k)
  assert.equal(m.medicines.owner, 'pharmacy')
  assert.equal(m.bloods.owner, 'diagnostics')
  assert.equal(m.device.owner, 'wearables')
  assert.equal(m.visit.owner, 'community')
  assert.equal(m.summary.owner, 'hospital')
  assert.equal(m['follow-up'].owner, 'gp')
  assert.equal(m.summary.draftOnly, undefined, 'Amira is not blocked, so the letter is sent for real')
  assert.match(m['follow-up'].title, /telephone/, 'the avoid-travel goal shapes the follow-up')
})

test('every evidence quote is text that exists in the record it cites', async () => {
  const hospital = amiraHospitalView()
  const f = fakeSim({ views: { hospital, community: [], wearables: [] } })
  const items = await detectForPatient(f.sim, amira())
  const textOf = (id: string) => {
    const r = hospital.find((x) => x.id === id)
    return `${r?.title ?? ''} ${r?.data?.text ?? ''} ${r?.status ?? ''}`.toLowerCase()
  }
  for (const item of items) {
    for (const e of item.evidence) {
      if (e.site !== 'hospital') continue
      const src = hospital.find((x) => x.id === e.resourceId)
      assert.ok(src, `${item.id} cites ${e.resourceId}, which is not in the record`)
      if (src.kind === 'document' || src.kind === 'message') {
        // Free text: the quote must be the record's own words.
        assert.ok(textOf(e.resourceId).includes(e.quote.toLowerCase()), `${item.id}: quote "${e.quote}" not found in ${e.resourceId}`)
      } else {
        // Structured record: the description must name its title and its actual status.
        assert.ok(e.quote.includes(src.title), `${item.id}: quote does not name ${src.title}`)
        assert.ok(e.quote.includes(src.status), `${item.id}: quote does not carry the real status ${src.status}`)
      }
    }
  }
  const m = byId(items)
  assert.equal(m.device.evidence[0].quote, 'home equipment and medication handover not confirmed')
  assert.equal(m.device.evidence[0].resourceId, 'r-1')
  assert.equal(m['clinical-hold'].evidence[0].resourceId, 'r-6')
  assert.equal(m['clinical-hold'].evidence[0].raisedAt, FIT - 3_600_000, 'hold carries when the thread was raised')
})

test('no urgent thread means no clinical hold; a collected prescription means no medicines item', async () => {
  const hospital = amiraHospitalView().filter((r) => r.id !== 'r-6')
  hospital.find((r) => r.id === 'r-3')!.status = 'collected'
  const f = fakeSim({ views: { hospital, community: [], wearables: [] } })
  const m = byId(await detectForPatient(f.sim, amira()))
  assert.equal(m['clinical-hold'], undefined)
  assert.equal(m.medicines, undefined)
  assert.ok(m.bloods && m.summary && m['follow-up'], 'the rest are still detected')
})

test('a connected device and a scheduled visit suppress their items', async () => {
  const f = fakeSim({
    views: {
      hospital: amiraHospitalView(),
      community: [{ id: 'v-1', kind: 'visit', status: 'scheduled', patientId: 'SIM-000001' }],
      wearables: [{ id: 'd-1', kind: 'device', status: 'active', patientId: 'SIM-000001', data: {} }],
    },
  })
  const m = byId(await detectForPatient(f.sim, amira()))
  assert.equal(m.device, undefined)
  assert.equal(m.visit, undefined)
})

test('a completed visit does not count as arranged for this discharge', async () => {
  const f = fakeSim({
    views: { hospital: amiraHospitalView(), community: [{ id: 'v-old', kind: 'visit', status: 'completed' }], wearables: [] },
  })
  const m = byId(await detectForPatient(f.sim, amira()))
  assert.ok(m.visit, 'an old completed visit is history, not a plan')
})

test('without a home-visit need there is no visit item, and without the travel goal the follow-up is plain', async () => {
  const f = fakeSim({ views: { hospital: amiraHospitalView(), community: [], wearables: [] } })
  const row = amira()
  row.needs = []
  row.goals = []
  const m = byId(await detectForPatient(f.sim, row))
  assert.equal(m.visit, undefined)
  assert.doesNotMatch(m['follow-up'].title, /telephone/)
  assert.equal(m['follow-up'].evidence.length, 0)
})

test('Eleanor: funding-blocked care package becomes a human decision and holds the letter as a draft', async () => {
  const f = fakeSim({
    views: {
      hospital: [{ id: 'r-att6', kind: 'hospital-attendance', patientId: 'SIM-000006', data: { stage: 'inpatient', location: 'AMU bed 1' } }],
      community: eleanorCommunityView(),
      wearables: [],
    },
  })
  const items = await detectForPatient(f.sim, eleanor())
  const m = byId(items)
  assert.equal(m['care-package'].state, 'blocked_human')
  assert.equal(m['care-package'].owner, 'community')
  assert.equal(m['care-package'].evidence.length, 3, 'care package, care plan and activity trend are all cited')
  assert.match(m['care-package'].evidence[2].quote, /1800 vs baseline 4200/)
  assert.equal(m.summary.draftOnly, true)
  assert.match(m.summary.title, /held while the case is blocked/)
  assert.equal(m['clinical-hold'], undefined)
  assert.equal(m.medicines, undefined)
  assert.equal(m.bloods, undefined, 'no monitoring document, no bloods item')
})

test('a discharged patient gets no items at all', async () => {
  const f = fakeSim({ views: { hospital: amiraHospitalView(), community: [], wearables: [] } })
  const row = amira()
  row.stage = 'discharged'
  assert.deepEqual(await detectForPatient(f.sim, row), [])
})

test('bloodSummary reports the latest panel and flags out-of-range analytes', async () => {
  const report = (id: string, panelId: string, createdAt: number, analytes: any[]) => ({
    id, kind: 'report', createdAt, data: { kind: 'blood-result', panel: { id: panelId, name: panelId }, analytes },
  })
  const f = fakeSim({
    views: {
      diagnostics: [
        report('old', 'ue', FIT - 2 * 86_400_000, [{ id: 'potassium', name: 'Potassium', value: 5.7, referenceLow: 3.5, referenceHigh: 5.3 }]),
        report('new', 'ue', FIT - 86_400_000, [
          { id: 'potassium', name: 'Potassium', value: 5.1, referenceLow: 3.5, referenceHigh: 5.3 },
          { id: 'egfr', name: 'eGFR', value: 49, referenceLow: 60, referenceHigh: 200 },
        ]),
        report('fbc', 'fbc', FIT - 86_400_000, [{ id: 'neutrophils', name: 'Neutrophils', value: 2.6, referenceLow: 2.0, referenceHigh: 7.5 }]),
      ],
    },
  })
  const text = await bloodSummary(f.sim, 'SIM-000001')
  assert.match(text, /Potassium 5\.1(?! \(flagged\))/, 'latest potassium is in range and not flagged')
  assert.doesNotMatch(text, /5\.7/, 'the older panel is not reported as current')
  assert.match(text, /eGFR 49 \(flagged\)/)
  assert.match(text, /Neutrophils 2\.6/)
})

test('neutrophil history is computed from the patient\'s own FBC series', async () => {
  const fbc = (id: string, monthsAgo: number, neutrophils: number) => ({
    id, kind: 'report', createdAt: FIT - monthsAgo * 30 * 86_400_000,
    data: { kind: 'blood-result', panel: { id: 'fbc', name: 'FBC' }, analytes: [{ id: 'neutrophils', name: 'Neutrophils', value: neutrophils, referenceLow: 2.0, referenceHigh: 7.5 }] },
  })
  const dip = fakeSim({ views: { diagnostics: [fbc('a', 12, 2.0), fbc('b', 8, 1.0), fbc('c', 4, 0.5), fbc('d', 2, 1.7), fbc('e', 0, 2.6)] } })
  assert.match(await bloodSummary(dip.sim, 'SIM-000001'), /History: neutrophil nadir 0\.5 4 months ago, since recovered to 2\.6\./)
  const flat = fakeSim({ views: { diagnostics: [fbc('a', 6, 3.1), fbc('b', 0, 3.4)] } })
  assert.doesNotMatch(await bloodSummary(flat.sim, 'SIM-000001'), /History/, 'no dip below range, no history sentence')
  const none = fakeSim({ views: { diagnostics: [] } })
  assert.doesNotMatch(await bloodSummary(none.sim, 'SIM-000001'), /History|nadir/, 'no results, nothing invented')
})
