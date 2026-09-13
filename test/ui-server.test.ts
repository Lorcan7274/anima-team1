/**
 * The ward page's HTTP routes, driven over a real socket on a random port.
 * These are the only ways a person changes the board, so each one is checked
 * for what it does and what it refuses.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
delete process.env.OPENAI_API_KEY
import type { BoardState, ChecklistItem } from '../src/orchestrator/model.ts'
import { buildReceipt, startUi } from '../src/ui/server.ts'
import { SMOKE_ORIGIN, smokeBoard } from '../scripts/ui-smoke.ts'

const item = (id: string, state: ChecklistItem['state'], extra: Partial<ChecklistItem> = {}): ChecklistItem => ({
  id, patientId: 'SIM-000001', title: id, owner: 'gp', state, evidence: [], ...extra,
})
const board: BoardState = {
  world: 'test-world', simNow: 1789200000000,
  patients: [{
    patientId: 'SIM-000001', name: 'Amira Khan', conditions: ['Heart failure'], needs: [], goals: [], stage: 'inpatient',
    items: [
      item('sim-000001-clinical-hold', 'clinical_hold', { owner: 'clinician', humanReason: 'Open urgent thread.' }),
      item('sim-000001-visit', 'proposed'),
      item('sim-000001-care-package', 'blocked_human', { owner: 'community', humanReason: 'Funding pending.' }),
    ],
  }],
  log: [],
}

const servers: Server[] = []
const listen = (b: BoardState, getSim?: Parameters<typeof startUi>[2]) => new Promise<string>((resolve) => {
  const server = startUi(b, 0, getSim)
  servers.push(server)
  server.once('listening', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
})
const origin = listen(board)
after(() => servers.forEach((s) => s.close()))
const post = async (path: string, init: RequestInit = {}) => fetch(`${await origin}${path}`, { method: 'POST', ...init })

test('GET / serves the ward page and GET /state serves the board as JSON', async () => {
  const page = await fetch(`${await origin}/`)
  assert.equal(page.headers.get('content-type'), 'text/html')
  assert.match(await page.text(), /<title>Homeward/)
  const state = await (await fetch(`${await origin}/state`)).json()
  assert.equal(state.world, 'test-world')
  assert.equal(state.patients[0].items.length, 3)
  assert.ok('story' in state, 'the story panel data rides along with the board')
})

test('the server binds to loopback only', async () => {
  assert.equal((servers[0].address() as AddressInfo).address, '127.0.0.1')
})

test('POST /approve approves proposed items only and reports how many', async () => {
  const r = await post('/approve')
  assert.equal(await r.text(), '1')
  const [hold, visit, blocked] = board.patients[0].items
  assert.equal(visit.state, 'approved')
  assert.equal(visit.approval?.by, 'Demo coordinator')
  assert.equal(hold.state, 'clinical_hold')
  assert.equal(blocked.state, 'blocked_human')
  assert.equal(await (await post('/approve')).text(), '0', 'nothing left to approve')
})

test('POST /clear-hold clears only a clinical hold', async () => {
  assert.equal((await post('/clear-hold?item=sim-000001-care-package')).status, 404)
  assert.equal((await post('/clear-hold?item=nope')).status, 404)
  const r = await post('/clear-hold?item=sim-000001-clinical-hold')
  assert.equal(r.status, 200)
  const hold = board.patients[0].items[0]
  assert.equal(hold.state, 'verified')
  assert.match(hold.verification?.observed ?? '', /Demo clinician/)
  assert.equal((await post('/clear-hold?item=sim-000001-clinical-hold')).status, 404, 'already cleared')
})

test('POST /escalate drafts a handover for a blocked item and 404s otherwise', async () => {
  assert.equal((await post('/escalate?item=sim-000001-visit')).status, 404)
  const r = await post('/escalate?item=sim-000001-care-package')
  assert.equal(r.status, 200)
  const blocked = board.patients[0].items[2]
  assert.equal(blocked.state, 'blocked_human')
  assert.ok(blocked.escalation?.responsibleTeam)
})

test('GET /receipt returns markdown for a known patient and 404 for an unknown one', async () => {
  assert.equal((await fetch(`${await origin}/receipt?patient=SIM-999999`)).status, 404)
  const r = await fetch(`${await origin}/receipt?patient=SIM-000001`)
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type') ?? '', /markdown/)
  assert.match(await r.text(), /Amira Khan/)
})

test('mutating routes answer GET with 405 and name the allowed method', async () => {
  for (const path of ['/approve', '/clear-hold?item=sim-000001-clinical-hold', '/undo-hold?item=x', '/escalate?item=sim-000001-care-package', '/letter?patient=SIM-000001']) {
    const r = await fetch(`${await origin}${path}`)
    assert.equal(r.status, 405, `${path} over GET`)
    assert.equal(r.headers.get('allow'), 'POST')
    assert.doesNotMatch(r.headers.get('content-type') ?? '', /html/, 'not the page')
  }
  assert.equal(board.patients[0].items[0].state, 'verified', 'a GET changed nothing')
})

test('POST /undo-hold reinstates a confirmed hold, and refuses anything else', async () => {
  const hold = board.patients[0].items[0]
  assert.equal(hold.state, 'verified', 'cleared by the earlier test')
  assert.equal((await post('/undo-hold?item=sim-000001-visit')).status, 409)
  const r = await post('/undo-hold?item=sim-000001-clinical-hold')
  assert.equal(r.status, 200)
  assert.equal(hold.state, 'clinical_hold')
  assert.equal((await post('/undo-hold?item=sim-000001-clinical-hold')).status, 409, 'already reinstated')
})

test('GET /resource reads a record from the simulator, or says the simulator is not connected', async () => {
  assert.equal((await fetch(`${await origin}/resource?site=hospital&patient=SIM-000001&id=r-6`)).status, 503, 'this server has no simulator')
  const fakeSim = { siteView: async () => ({ resources: [{ id: 'r-6', kind: 'message', title: 'Respiratory: review', status: 'open', data: { text: 'Please review.' } }] }) }
  const base = await listen({ world: 'w', simNow: 0, patients: [], log: [] }, () => fakeSim as never)
  const ok = await fetch(`${base}/resource?site=hospital&patient=SIM-000001&id=r-6`)
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).data.text, 'Please review.')
  assert.equal((await fetch(`${base}/resource?site=hospital&patient=SIM-000001&id=r-99`)).status, 404)
})

test('GET /resource survives a simulator that throws, rejects or is misnamed', async () => {
  let mode: 'throw' | 'reject' | 'ok' = 'throw'
  const sim = { siteView: (site: string) => { if (mode === 'throw') throw new Error('sync boom'); if (mode === 'reject') return Promise.reject(new Error('async boom')); return Promise.resolve({ resources: [{ id: 'r-1', site }] }) } }
  const base = await listen({ world: 'w', simNow: 0, patients: [], log: [] }, () => sim as never)
  const get = (q: string) => fetch(`${base}/resource?${q}`)
  const thrown = await get('site=hospital&patient=SIM-000001&id=r-1')
  assert.equal(thrown.status, 502, 'a synchronous throw is a bad-gateway reply, not a crash')
  assert.match(await thrown.text(), /sync boom/)
  mode = 'reject'
  assert.equal((await get('site=hospital&patient=SIM-000001&id=r-1')).status, 502)
  mode = 'ok'
  assert.equal((await get('site=hospital&patient=SIM-000001&id=r-1')).status, 200)
  assert.equal((await get('site=../../admin&patient=SIM-000001&id=r-1')).status, 400, 'only a known site is forwarded')
  assert.equal((await get('site=hospital&patient=&id=r-1')).status, 400, 'a patient and an id are required')
  assert.equal((await fetch(`${base}/state`)).status, 200, 'server still up')
  const crashy = await listen({ world: 'w', simNow: 0, patients: [], log: [] }, () => { throw new Error('no sim yet') })
  assert.equal((await fetch(`${crashy}/resource?site=hospital&patient=SIM-000001&id=r-1`)).status, 503)
})

test('POST /letter validates the body, caps its size and never wipes a letter on bad input', async () => {
  const b = smokeBoard()
  b.patients[0].letter = { sections: { reason: 'KEEP ME' }, editedBy: 'Dr X', at: 1 }
  const base = await listen(b)
  const send = (body: string, patient = 'SIM-000001') => fetch(`${base}/letter?patient=${patient}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  assert.equal((await send('{not json')).status, 400)
  assert.equal(b.patients[0].letter?.sections.reason, 'KEEP ME', 'invalid JSON left the letter alone')
  assert.equal((await send('{"sections":"hello"}')).status, 400, 'sections must be an object')
  assert.equal((await send('[1,2]')).status, 400)
  assert.equal((await send('')).status, 400, 'an empty body is not an empty draft')
  assert.equal(b.patients[0].letter?.sections.reason, 'KEEP ME')
  const big = await send(JSON.stringify({ sections: { reason: 'x'.repeat(300_000) } }))
  assert.equal(big.status, 413)
  assert.equal(b.patients[0].letter?.sections.reason, 'KEEP ME', 'an oversized body left the letter alone')
  assert.equal((await send('{"sections":{}}', 'SIM-999999')).status, 404)
  const ok = await send(JSON.stringify({ sections: { reason: 'New reason', gpActions: 'Call', extra: 'ignored' } }))
  assert.equal(ok.status, 200)
  assert.equal(await ok.text(), 'saved')
  const saved = b.patients[0].letter!
  assert.equal(saved.sections.reason, 'New reason')
  assert.equal(saved.sections.gpActions, 'Call')
  assert.equal(saved.sections.course, '', 'missing sections saved empty')
  assert.equal('extra' in saved.sections, false)
  assert.equal(saved.editedBy, 'Demo clinician')
  const state = await (await fetch(`${base}/state`)).json()
  assert.equal(state.patients[0].letter.sections.reason, 'New reason', '/state reflects the save')
  assert.equal((await fetch(`${base}/state`)).status, 200, 'server still up after the oversized body')
})

test('POST /escalate on an item the drafter cannot read answers 500 and the server survives', async () => {
  const b: BoardState = { world: 'w', simNow: 1, log: [], patients: [{ patientId: 'SIM-000002', name: 'No Evidence', conditions: [], needs: [], goals: [],
    items: [{ id: 'sim-000002-care-package', patientId: 'SIM-000002', title: 'Funding', owner: 'community', state: 'blocked_human', humanReason: 'x', evidence: undefined as never }] }] }
  const base = await listen(b)
  const r = await fetch(`${base}/escalate?item=sim-000002-care-package`, { method: 'POST' })
  assert.equal(r.status, 500)
  assert.match(await r.text(), /escalation failed/)
  assert.equal(b.patients[0].items[0].state, 'blocked_human', 'still blocked, nothing invented')
  assert.equal((await fetch(`${base}/state`)).status, 200, 'server still up')
})

test('GET /state carries mode and simOrigin, and plain-text replies say so in their content type', async () => {
  const b = smokeBoard()
  const base = await listen(b)
  const s = await (await fetch(`${base}/state`)).json()
  assert.equal(s.mode, 'local')
  assert.equal(s.simOrigin, SMOKE_ORIGIN)
  assert.ok(s.story && typeof s.story.counters.bedHoursSaved === 'number')
  const r = await fetch(`${base}/clear-hold?item=nope`, { method: 'POST' })
  assert.equal(r.status, 404)
  assert.match(r.headers.get('content-type') ?? '', /text\/plain/)
})

test('the receipt states what the run executed against, per mode, and sanitises its filename', async () => {
  const local = buildReceipt(smokeBoard(), 'SIM-000001')!
  assert.match(local, /Local simulator stand-in/)
  assert.ok(local.includes(SMOKE_ORIGIN))
  assert.doesNotMatch(local, /Every action above was executed against the simulator/)
  const snap = { ...smokeBoard(), mode: 'snapshot' as const }
  const snapMd = buildReceipt(snap, 'SIM-000001')!
  assert.match(snapMd, /Replaying a saved board/)
  assert.doesNotMatch(snapMd, /executed against/, 'a snapshot receipt makes no execution claim')
  const live = buildReceipt({ ...smokeBoard(), mode: 'live', simOrigin: 'https://sim.animahacks.com' }, 'SIM-000001')!
  assert.match(live, /executed against the simulator at https:\/\/sim\.animahacks\.com and independently re-read/)
  const unset = buildReceipt({ ...smokeBoard(), mode: undefined, simOrigin: undefined }, 'SIM-000001')!
  assert.match(unset, /Synthetic simulator data \(NHS-SIM\)/i)
  assert.match(local, /### Wire record|Actions executed \(wire record\)/)
  assert.match(local, /Dispensed the prescription/)
  // Filename: only safe characters reach the header.
  const odd = smokeBoard(); odd.patients[0].patientId = 'SIM 1"x'; odd.patients[0].items.forEach((i) => { i.patientId = 'SIM 1"x' })
  const base = await listen(odd)
  const r = await fetch(`${base}/receipt?patient=${encodeURIComponent('SIM 1"x')}`)
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-disposition') ?? '', /filename="homeward-receipt-SIM_1_x\.md"/)
  // A degenerate clock does not break the receipt.
  const nan = smokeBoard(); nan.simNow = Number.NaN
  assert.match(buildReceipt(nan, 'SIM-000001')!, /sim clock n\/a/)
})
