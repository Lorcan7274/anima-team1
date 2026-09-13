import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import type { BoardState } from '../src/orchestrator/model.ts'
import { PAGE, buildReceipt, modeStatement } from '../src/ui/server.ts'
import { SMOKE_ORIGIN, smokeBoard } from '../scripts/ui-smoke.ts'

test('embedded journey UI browser script parses', () => {
  const script = PAGE.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script, 'page should contain an inline browser script')
  assert.doesNotThrow(() => new vm.Script(script))
})

test('journey UI has the five gates, review-before-approve, confirmations and the trace drop-down', () => {
  for (const gate of ['Clinical', 'Medicines', 'Monitoring', 'Support', 'Handover']) assert.match(PAGE, new RegExp(`label: '${gate}'`))
  assert.match(PAGE, /Review plan \(/)
  assert.match(PAGE, /Approve ' \+ proposed\.length/)
  assert.match(PAGE, /Record confirmation/)
  assert.match(PAGE, /Prepare escalation/)
  assert.match(PAGE, /Show request/)
  assert.match(PAGE, /details class="reqdd"/)
  assert.match(PAGE, /Simulator did not respond/)
  assert.doesNotMatch(PAGE, /Penicillin|Dr S Sohrabi|Potassium 5\.5/, 'no hard-coded patient facts')
})

test('the page boots blank behind a loading screen that names the setup step', () => {
  assert.match(PAGE, /<div class="boot" id="boot"/)
  assert.match(PAGE, /<div class="app" hidden>/, 'nothing but the loading screen until the ward is ready')
  assert.match(PAGE, /id="bootPhase"/)
  for (const step of ['Joining the simulator world', 'Admitting patients', 'Loading patient records', 'Reading the records']) assert.match(PAGE, new RegExp(step))
})

test('the route panel always carries a why/next status line', () => {
  assert.match(PAGE, /<div class="why" id="why"/)
  assert.match(PAGE, /Agent idle: waiting for your approval/)
  assert.match(PAGE, /Agent idle: needs the clinician/)
  assert.match(PAGE, /Agent idle: waiting on an outside decision/)
  assert.match(PAGE, /Agent working: /)
  assert.match(PAGE, /Agent stopped: /)
})

test('gate circles are buttons that open what the gate needs', () => {
  assert.match(PAGE, /data-act="gate" data-n="' \+ n \+ '"/)
  assert.match(PAGE, /overlayKey\.startsWith\('gate:'\)/)
  assert.doesNotMatch(PAGE, /Each gate must be evidenced/)
  assert.match(PAGE, /\.trackfill\{[^}]*var\(--nhs-blue\)/)
})

test('no em dashes anywhere in the page, the receipt, or the UI and story sources', () => {
  const dash = new RegExp(String.fromCharCode(0x2014))
  assert.doesNotMatch(PAGE, dash)
  assert.doesNotMatch(buildReceipt(smokeBoard(), 'SIM-000001') ?? '', dash)
  for (const f of ['src/ui/server.ts', 'src/story/story.ts', 'src/story/baseline.ts', 'scripts/ui-smoke.ts', 'test/ui.test.ts', 'test/ui-server.test.ts', 'test/story.test.ts']) {
    assert.doesNotMatch(readFileSync(new URL('../' + f, import.meta.url), 'utf8'), dash, f)
  }
})

test('the mode banner exists in the markup and the copy table covers every mode honestly', () => {
  assert.match(PAGE, /id="modebar"/)
  assert.match(PAGE, /id="bootMode"/)
  for (const mode of ['live', 'local', 'offline', 'snapshot'] as const) {
    const m = modeStatement({ mode, simOrigin: 'http://127.0.0.1:4799' })
    assert.equal(m.mode, mode)
    assert.ok(m.label && m.text)
  }
  const local = modeStatement({ mode: 'local', simOrigin: 'http://127.0.0.1:4799' })
  assert.match(local.text, /local re-implementation of its API \(http:\/\/127\.0\.0\.1:4799\)/)
  assert.match(modeStatement({ mode: 'local' }).text, /origin not recorded/)
  assert.match(modeStatement({ mode: 'snapshot' }).text, /local copy only/)
  assert.doesNotMatch(modeStatement({ mode: 'snapshot' }).text, /executed against/, 'a snapshot never claims execution')
  assert.match(modeStatement({}).text, /executed against the simulator and independently re-read/)
  assert.equal(modeStatement({ mode: 'weird' as never }).mode, 'unset', 'an unknown mode is treated as unset, not trusted')
  assert.match(modeStatement({ mode: 'live', simOrigin: 'https://sim.animahacks.com' }).text, /at https:\/\/sim\.animahacks\.com/)
})

// --- Driving the page's own script under node: a stub DOM just big enough to render into ---------------------------
class El {
  innerHTML = ''; textContent = ''; className = ''; hidden = false; disabled = false; href = ''; title = ''; value = ''; open = false
  dataset: Record<string, string> = {}; style: Record<string, string> = {}; attrs: Record<string, string> = {}
  classes = new Set<string>()
  classList = {
    add: (c: string) => { this.classes.add(c) },
    remove: (c: string) => { this.classes.delete(c) },
    toggle: (c: string, on?: boolean) => { const want = on === undefined ? !this.classes.has(c) : on; if (want) this.classes.add(c); else this.classes.delete(c); return want },
    contains: (c: string) => this.classes.has(c),
  }
  id: string
  constructor(id: string) { this.id = id }
  setAttribute(k: string, v: string) { this.attrs[k] = v }
  removeAttribute(k: string) { delete this.attrs[k] }
  getAttribute(k: string) { return this.attrs[k] ?? null }
  addEventListener() {}
  querySelectorAll() { return [] }
  closest() { return null }
}
type Reply = { ok: boolean; status: number; body: string }
type Routes = Record<string, (url: string, init?: RequestInit) => Reply | Promise<Reply>>
function loadPage(routes: Routes) {
  const script = PAGE.match(/<script>([\s\S]*?)<\/script>/)![1]
  const els = new Map<string, El>()
  const el = (id: string) => { let e = els.get(id); if (!e) { e = new El(id); els.set(id, e) } return e }
  const steps = [1, 2, 3, 4].map((n) => { const li = new El('step' + n); li.dataset.step = String(n); return li })
  const errors: string[] = []
  const listeners: Record<string, (e: unknown) => unknown> = {}
  const calls: string[] = []
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push(url)
    const path = String(url).split('?')[0]
    const route = routes[path]
    if (!route) throw new TypeError('fetch failed: no route ' + path)
    const r = await route(url, init)
    return { ok: r.ok, status: r.status, text: async () => r.body, json: async () => JSON.parse(r.body) }
  }
  const document = {
    getElementById: el,
    querySelector: (sel: string) => el(sel),
    querySelectorAll: (sel: string) => (sel === '#bootSteps li' ? steps : []),
    addEventListener: (type: string, fn: (e: unknown) => unknown) => { listeners[type] = fn },
  }
  const ctx = vm.createContext({ document, fetch: fetchImpl, setInterval: () => 0, console: { ...console, error: (...a: unknown[]) => { errors.push(a.map(String).join(' ')) } } })
  vm.runInContext(script, ctx)
  const call = (code: string) => vm.runInContext(code, ctx)
  const render = (board: BoardState) => { ctx.__board = board; call('render(__board)') }
  const html = () => [...els.values()].map((e) => e.innerHTML).join('\n')
  return { el, els, errors, steps, listeners, calls, call, render, html, flush: () => new Promise((r) => setImmediate(() => setImmediate(r))) }
}
const okJson = (v: unknown): Reply => ({ ok: true, status: 200, body: JSON.stringify(v) })
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length

test('the page renders a realistic board: names, mode banner, counts, gates, tasks and confirmations', () => {
  const board = smokeBoard()
  const page = loadPage({ '/state': () => okJson(board) })
  page.render(board)
  assert.deepEqual(page.errors, [])
  assert.equal(page.el('.app').hidden, false, 'boot screen dismissed')
  const list = page.el('plist').innerHTML
  assert.match(list, /Amira Khan/); assert.match(list, /Eleanor Chen/)
  assert.match(list, /Patients/.test(page.el('plistLabel').textContent) ? /prow/ : /never/)
  assert.equal(page.el('plistLabel').textContent, 'Patients · 2')
  assert.match(page.el('placeHospital').innerHTML, /CKD stage 3 &amp; anaemia/, 'ampersand escaped')
  // Mode: banner under the header, and the foot line, both from modeStatement.
  const m = modeStatement(board)
  assert.match(page.el('modebar').className, /\blocal\b/)
  assert.match(page.el('modebar').innerHTML, /Local simulator stand-in/)
  assert.ok(page.el('modebar').innerHTML.includes(SMOKE_ORIGIN))
  assert.ok(page.el('foot').textContent.includes(m.label + ': ' + m.text), 'foot carries the same statement')
  assert.doesNotMatch(page.el('foot').textContent, /every action was executed against the simulator/, 'the old blanket claim is gone')
  // Counts for Amira (5 items: hold, verified, awaiting_verification, proposed, failed).
  assert.equal(page.el('status').textContent, 'Not ready: plan awaiting review')
  assert.match(page.el('intro').innerHTML, /Not ready: 4 outstanding/)
  assert.equal(page.el('mainAction').textContent, 'Review plan (1 action)')
  assert.equal(page.el('mainAction').disabled, false)
  assert.equal(page.el('why').dataset.act, 'trace', 'the working band is click-to-view')
  assert.match(page.el('why').className, /clickable/)
  assert.match(page.el('why').innerHTML, /Agent working: 1 action/)
  const gates = page.el('gates').innerHTML
  assert.equal(count(gates, /class="gate cleared"/g), 1)
  assert.equal(count(gates, /class="gate blocked"/g), 2)
  assert.equal(count(gates, /class="gate scanning"/g), 1)
  assert.equal(count(gates, /class="gate none"/g), 1)
  for (const label of ['Clinician confirmation needed', 'Verified', 'Verifying', 'No barrier found', 'Simulator did not respond']) assert.ok(gates.includes(label), label)
  assert.match(gates, /width:20%/, '1 of 5 verified')
  assert.equal(count(page.el('tasks').innerHTML, /data-act="item"/g), 4, 'four operational tasks, the hold is a confirmation')
  assert.match(page.el('workSub').textContent, /coordinate these 4 actions/)
  assert.match(page.el('confirmations').innerHTML, /1 named confirmation still protects/)
  assert.match(page.el('confirmations').innerHTML, /Record confirmation/)
  assert.equal(page.el('receiptLink').href, '/receipt?patient=SIM-000001')
  assert.match(page.el('meds').innerHTML, /Furosemide 40 mg/)
  assert.match(page.el('meds').innerHTML, /Collected, verified in the pharmacy record/)
  assert.equal(page.el('draftState').textContent, 'Not drafted yet')
  assert.match(page.el('letterFields').innerHTML, /Drafted by the agent once the plan is approved/)
  assert.equal(page.el('allergy').textContent, 'Latex allergy')
  // Eleanor: blocked with an escalation, a held draft from the trace.
  page.call("selectedPatient = 'SIM-000006'")
  page.render(board)
  assert.match(page.el('patientHead').innerHTML, /Eleanor Chen/)
  assert.equal(page.el('status').textContent, 'Not ready: 1 confirmation remains')
  assert.match(page.el('why').innerHTML, /waiting on an outside decision/)
  assert.match(page.el('why').innerHTML, /Handed to Integrated discharge team/)
  assert.match(page.el('confirmations').innerHTML, /Escalated to Integrated discharge team/)
  assert.match(page.el('confirmations').innerHTML, /canned note; model unavailable/)
  assert.equal(page.el('draftState').textContent, 'Draft held (case blocked)')
  assert.match(page.el('letterFields').innerHTML, /Admitted with an exacerbation of COPD\./)
  assert.match(page.el('letterProv').innerHTML, /canned fallback/)
  assert.equal(page.el('allergy').textContent, 'No allergy recorded')
  assert.deepEqual(page.errors, [])
})

test('readiness copy for a hand-built ward: ready, discharged, failed, checking', () => {
  const board = smokeBoard()
  const page = loadPage({ '/state': () => okJson(board) })
  const [amira] = board.patients
  const state = (items: BoardState['patients'][0]['items'], extra: Partial<BoardState['patients'][0]> = {}, s: Partial<BoardState> = {}) => {
    page.call('selectedPatient = null')
    page.render({ ...board, ...s, patients: [{ ...amira, ...extra, items }] })
    return { status: page.el('status').textContent, action: page.el('mainAction').textContent, why: page.el('why').innerHTML, word: page.el('plist').innerHTML.match(/<em>([^<]*)<\/em>/)?.[1] }
  }
  const verified = amira.items.map((i) => ({ ...i, state: 'verified' as const, verification: { passed: true, observed: 'ok', atSimTime: board.simNow } }))
  assert.deepEqual([state(verified).status, state(verified).action, state(verified).word], ['Ready for clinical decision', 'Review complete', 'Ready'])
  assert.deepEqual([state(verified, { stage: 'discharged' }).status, state(verified, { stage: 'discharged' }).word], ['Discharged in the hospital record', 'Discharged'])
  const failedOnly = [{ ...amira.items[4] }]
  assert.equal(state(failedOnly).status, 'Not ready: action failed')
  assert.match(state(failedOnly).why, /Agent stopped: 1 action failed/)
  assert.match(state(failedOnly).why, /simulator did not respond/i)
  assert.deepEqual([state([], {}, { busy: true, phase: 'Reading the records' }).status, state([], {}, { busy: true, phase: 'Reading the records' }).word], ['Reading the records', 'Checking'])
  assert.match(state([], {}, { busy: false }).why, /No barriers found/)
  assert.deepEqual(page.errors, [])
})

test('every overlay renders for the plan, the trace, each gate, each task and a record thread', async () => {
  const board = smokeBoard()
  const page = loadPage({
    '/state': () => okJson(board),
    '/resource': () => okJson({ id: 'r-6', kind: 'message', status: 'open', priority: 'urgent', createdAt: board.simNow, data: { text: 'Please review before discharge.', messages: [{ from: 'Dr Ada Sim 0', text: 'Sats 88% overnight.' }], ward: 'AMU' } }),
  })
  page.render(board)
  const body = () => page.el('ovBody').innerHTML
  page.call("openOverlay('plan')")
  assert.match(body(), /Not in this plan/)
  assert.match(body(), /Clinical hold: urgent respiratory review requested/)
  assert.match(body(), /Approve 1 action</)
  assert.match(page.el('ovTitle').textContent, /Plan for Amira Khan/)
  page.call("openOverlay('trace')")
  assert.match(body(), /Dispensed the prescription/)
  assert.match(body(), /Run &amp; world/)
  assert.match(body(), /1 record reads not shown/)
  assert.match(body(), /idempotency key · run-abc:sim-000001-medicines:1/)
  const expectGate = ['Record confirmation', 'collected', 'Arrange repeat blood monitoring', 'Nothing to do here', 'Review plan']
  for (let n = 0; n < 5; n++) { page.call(`openOverlay('gate:${n}')`); assert.ok(body().includes(expectGate[n]), `gate ${n}: ${expectGate[n]}`) }
  for (let n = 0; n < 5; n++) { page.call(`openGate(${n})`); assert.ok(page.call('overlayKey'), `gate ${n} opens something`) }
  page.call('openGate(1)'); assert.equal(page.call('overlayKey'), 'item:sim-000001-medicines', 'a single verified item opens its story')
  page.call('openGate(4)'); assert.equal(page.call('overlayKey'), 'gate:4')
  for (const i of board.patients[0].items) {
    page.call(`openOverlay('item:${i.id}')`)
    assert.match(body(), /Detected from the record/, i.id)
    assert.ok(page.el('ovTitle').textContent.length > 0)
  }
  page.call("openOverlay('item:sim-000001-follow-up')")
  assert.match(body(), /simulator outage, not a record problem/)
  page.call("openOverlay('item:sim-000001-medicines')")
  assert.match(body(), /passed/); assert.match(body(), /Collection is recorded/)
  page.call("openOverlay('thread:hospital:SIM-000001:r-6', true)")
  assert.match(body(), /Reading the record/)
  await page.flush()
  assert.match(body(), /Please review before discharge\./)
  assert.match(body(), /Sats 88% overnight\./)
  assert.match(body(), /<dt>ward<\/dt><dd>AMU<\/dd>/)
  page.call('backOverlay()')
  assert.equal(page.call('overlayKey'), 'item:sim-000001-medicines', 'back returns to the item')
  page.call('closeOverlay()')
  assert.equal(page.call('overlayKey'), null)
  assert.deepEqual(page.errors, [])
})

test('hostile record text is escaped everywhere it is interpolated', async () => {
  const z = (t: string) => `<zz-${t} x="y">boom</zz-${t}>`
  const board = smokeBoard()
  board.world = z('world'); board.phase = z('phase'); board.simOrigin = z('origin')
  const p = board.patients[0]
  p.name = 'Eve ' + z('name'); p.location = z('loc'); p.stage = z('stage'); p.conditions = [z('cond')]; p.needs = [z('need')]; p.goals = [z('goal')]
  p.profile!.clinician = 'Dr ' + z('clin'); p.profile!.allergies = [z('all')]; p.profile!.problems = [z('prob')]
  p.profile!.ownWords = { text: z('own'), resourceId: z('ownid') }
  p.profile!.facts = [{ label: z('fl'), value: z('fv'), bad: true, source: 'diagnostics x" onmouseover="zz' }, { label: z('fl2'), value: z('fv2'), bad: true, source: 'x" onmouseover="zz' }]
  p.profile!.prescriptions = [{ id: 'rx', drug: z('drug'), status: z('rxs') }]
  p.letter = { sections: { reason: z('letter') }, editedBy: z('editor'), at: 1 }
  for (const i of p.items) {
    i.title = z('title'); i.humanReason = z('reason'); i.proposedAction = z('action'); i.plan = [z('plan')]
    i.evidence = [{ site: 'hospital', resourceId: z('rid'), quote: z('quote') }]
    if (i.error) i.error = z('err')
    if (i.verification) i.verification.observed = z('obs')
    if (i.approval) i.approval = { by: z('by'), at: board.simNow }
  }
  const e = board.patients[1].items[0]
  e.escalation = { responsibleTeam: z('team'), nextAction: z('next'), note: z('note'), source: 'fallback' }
  for (const t of board.trace!) {
    t.headline = z('head'); t.outcome = z('out'); t.got = z('got'); t.path = '/api/' + z('path'); t.method = z('method')
    if (t.idempotencyKey) t.idempotencyKey = z('key') + ':' + t.idempotencyKey
    if (t.request) t.request = { ...(t.request as object), poison: z('req') }
    if (t.reply) t.reply = { poison: z('rep') }
    if (t.error) t.error = z('terr')
  }
  const page = loadPage({
    '/state': () => okJson(board),
    '/resource': () => okJson({ id: z('rid'), kind: z('kind'), status: z('rst'), title: z('rtitle'), owner: z('owner'), data: { text: z('rtext'), messages: [{ from: z('from'), text: z('mtext') }], [z('key')]: z('val') } }),
  })
  // Every overlay replaces the same panel, so snapshot the whole stub DOM after each one.
  let all = ''
  const snap = () => { all += page.html() + '\n' }
  page.render(board); snap()
  for (const key of ['plan', 'trace', 'gate:0', 'gate:1', 'gate:2', 'gate:3', 'gate:4', ...p.items.map((i) => 'item:' + i.id)]) { page.call(`openOverlay(${JSON.stringify(key)})`); snap() }
  page.call(`openOverlay('thread:hospital:SIM-000001:${encodeURIComponent('x')}', true)`)
  await page.flush(); snap()
  page.call("selectedPatient = 'SIM-000006'"); page.render(board); snap()
  page.call("openOverlay('gate:3')"); snap()
  assert.doesNotMatch(all, /<zz-/, 'no hostile string became markup')
  assert.doesNotMatch(all, /" onmouseover=/, 'no attribute break-out')
  for (const t of ['name', 'loc', 'cond', 'clin', 'own', 'fl', 'drug', 'title', 'reason', 'quote', 'err', 'obs', 'team', 'head', 'out', 'req', 'rep', 'rtext', 'mtext', 'from', 'letter', 'origin', 'plan', 'key']) {
    assert.ok(all.includes('&lt;zz-' + t), `escaped ${t} is shown`)
  }
  assert.ok(page.el('foot').textContent.includes(z('world')), 'text-only slots keep the raw text')
  assert.deepEqual(page.errors, [])
})

test('mid-setup boards and sparse rows render without throwing, and the stepper names the world it joins', () => {
  const page = loadPage({ '/state': () => okJson({}) })
  const booting: BoardState = { world: 'w', simNow: 0, patients: [], log: [], phase: 'Joining the simulator world: reconnecting, attempt 2 of 20', busy: true }
  page.render(booting)
  assert.equal(page.el('.app').hidden, false, 'stub default; the boot overlay is what hides the app')
  assert.equal(page.el('bootPhase').textContent, booting.phase)
  assert.deepEqual(page.steps.map((s) => s.className), ['now', '', '', ''])
  assert.equal(page.el('bootStep1').textContent, 'Joining the simulator world', 'mode unknown yet: the generic line')
  page.render({ ...booting, mode: 'live' })
  assert.equal(page.el('bootStep1').textContent, 'Joining the shared NHS-SIM world')
  page.render({ ...booting, mode: 'local', simOrigin: SMOKE_ORIGIN, phase: 'Starting the local simulator stand-in' })
  assert.match(page.el('bootStep1').textContent, /local simulator stand-in/)
  assert.ok(page.el('bootMode').textContent.includes(SMOKE_ORIGIN), 'boot card names the stand-in origin')
  assert.equal(page.el('bootMode').hidden, false)
  assert.deepEqual(page.steps.map((s) => s.className), ['now', '', '', ''], 'a local start still lights step 1')
  for (const [phase, step] of [['Admitting Amira to AMU bed 12, walking the attendance stage machine', 2], ['Confirming SIM-000001 is on the ward', 2], ['Loading patient records from the simulator', 3], ['Reading the records, the model is detecting barriers', 4], ['Detection complete', 4], ['Run complete', 0], ['Starting the local simulator stand-in', 1]] as const) {
    assert.equal(page.call(`bootStep(${JSON.stringify(phase)})`), step, phase)
  }
  // Sparse rows: no profile, no items, no trace, no simNow.
  const sparse: BoardState = { world: 'w', simNow: 0, patients: [{ patientId: 'SIM-000009', name: 'Solo Row', conditions: [], needs: [], goals: [], items: [] }], log: [] }
  page.render(sparse)
  assert.match(page.el('why').innerHTML, /No barriers found/)
  assert.match(page.el('foot').textContent, /sim clock n\/a/)
  assert.match(page.el('tasks').innerHTML, /No operational work found/)
  assert.equal(page.el('routeLegend').hidden, true)
  // A verification without a sim time must not break the item overlay (and so every later render).
  const noTime: BoardState = { ...sparse, patients: [{ ...sparse.patients[0], items: [{ id: 'sim-000009-medicines', patientId: 'SIM-000009', title: 'Meds', owner: 'pharmacy', state: 'verified', evidence: [], verification: { passed: true, observed: 'collected' } as never }] }] }
  page.render(noTime)
  page.call("openOverlay('item:sim-000009-medicines')")
  assert.match(page.el('ovBody').innerHTML, /collected/)
  page.render(noTime)
  // A letter with no summary item, and a trace entry with a missing path.
  const odd: BoardState = { ...sparse, trace: [{ at: 1, method: 'POST', path: undefined as never, status: 200, ok: true, idempotencyKey: 'k:sim-000009-medicines' }], patients: [{ ...noTime.patients[0], letter: { sections: { reason: 'r' }, editedBy: 'Dr Q', at: 1 } }] }
  page.render(odd)
  assert.match(page.el('draftState').textContent, /Clinician draft saved/)
  page.call("openOverlay('trace')")
  assert.match(page.el('ovBody').innerHTML, /class="call/)
  assert.deepEqual(page.errors, [])
})

test('a render error is reported on the console and polling keeps going; a lost server is stated in the foot', async () => {
  let board: unknown = smokeBoard()
  let down = false
  const page = loadPage({ '/state': () => { if (down) throw new TypeError('fetch failed'); return okJson(board) } })
  // The script's own first tick() already ran: it must have rendered the board.
  await page.flush()
  assert.match(page.el('plist').innerHTML, /Amira Khan/)
  const broken = smokeBoard() as unknown as { patients: unknown[] }
  broken.patients = [{ patientId: 'SIM-000001', name: 'Broken Row' }]
  board = broken
  page.call('tick()'); await page.flush()
  assert.equal(page.errors.length, 1, 'the render error is reported, not swallowed')
  assert.match(page.errors[0], /render failed/)
  page.call('tick()'); await page.flush()
  assert.equal(page.errors.length, 1, 'the same failure is not repeated every poll')
  board = smokeBoard()
  page.call('tick()'); await page.flush()
  assert.match(page.el('plist').innerHTML, /Eleanor Chen/, 'a good board renders again after a bad one')
  down = true
  page.call('tick()'); await page.flush()
  assert.match(page.el('foot').textContent, /did not answer/, 'a failed poll is stated')
  down = false
  page.call('tick()'); await page.flush()
  assert.doesNotMatch(page.el('foot').textContent, /did not answer/, 'and cleared once the server answers')
  assert.match(page.el('foot').textContent, /Local simulator stand-in/)
})

test('a failed letter save keeps the unsaved edits; a successful one clears the dirty flag', async () => {
  const board = smokeBoard()
  let saveReply: Reply = { ok: false, status: 413, body: 'body too large' }
  const page = loadPage({ '/state': () => okJson(board), '/letter': () => { if (saveReply.ok) board.patients[0].letter = { sections: { reason: 'Typed by the clinician' }, editedBy: 'Demo clinician', at: 1 }; return saveReply } })
  page.render(board)
  page.el('lf-reason').value = 'Typed by the clinician'
  page.call('letterDirty = true')
  const click = (act: string, data: Record<string, string> = {}) => page.listeners.click({ target: { closest: () => ({ dataset: { act, ...data }, disabled: false, textContent: '' }) } })
  await click('save'); await page.flush()
  assert.equal(page.call('letterDirty'), true, 'edits are still dirty after a failed save')
  assert.match(page.el('saveState').textContent, /Save failed/)
  assert.match(page.el('saveState').textContent, /413/)
  saveReply = { ok: true, status: 200, body: 'saved' }
  await click('save'); await page.flush()
  assert.equal(page.call('letterDirty'), false)
  assert.match(page.el('saveState').textContent, /Saved by Demo clinician/, 'the re-render after a good save shows who saved it')
  assert.ok(page.calls.some((u) => u.startsWith('/letter?patient=SIM-000001')))
})

test('when the runner ran out of verification rounds, unconfirmed items say so instead of "verifying"', () => {
  const board = smokeBoard()
  board.phase = 'Out of rounds: 3 rounds used, 1 item still awaiting verification'
  board.busy = false
  board.patients[0].items = board.patients[0].items.filter((i) => i.state !== 'proposed' && i.state !== 'failed')
  const page = loadPage({ '/state': () => okJson(board) })
  page.render(board)
  assert.equal(page.el('status').textContent, 'Not confirmed after 3 rounds')
  assert.match(page.el('why').innerHTML, /Agent stopped: 1 action not confirmed after 3 rounds/)
  assert.match(page.el('tasks').innerHTML, /Not confirmed after 3 rounds; a re-run/)
  assert.doesNotMatch(page.el('tasks').innerHTML, /verifying after time moves/)
  assert.match(page.el('gates').innerHTML, /Not confirmed/)
  board.busy = true
  page.render(board)
  assert.match(page.el('why').innerHTML, /Agent working/, 'while the runner is busy the cap text does not apply')
  assert.deepEqual(page.errors, [])
})
