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
import { startUi } from '../src/ui/server.ts'

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
const origin = new Promise<string>((resolve) => {
  const server = startUi(board, 0)
  servers.push(server)
  server.once('listening', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
})
after(() => servers.forEach((s) => s.close()))
const post = async (path: string) => fetch(`${await origin}${path}`, { method: 'POST' })

test('GET / serves the ward page and GET /state serves the board as JSON', async () => {
  const page = await fetch(`${await origin}/`)
  assert.equal(page.headers.get('content-type'), 'text/html')
  assert.match(await page.text(), /<title>Homeward<\/title>/)
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

test('mutating routes reject GET', async () => {
  for (const path of ['/approve', '/clear-hold?item=sim-000001-clinical-hold', '/escalate?item=sim-000001-care-package']) {
    const r = await fetch(`${await origin}${path}`)
    assert.equal(r.headers.get('content-type'), 'text/html', `${path} over GET falls through to the page`)
  }
})
