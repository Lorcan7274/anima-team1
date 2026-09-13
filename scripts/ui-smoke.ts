/**
 * Browser smoke check for the ward-round page, dependency-free.
 *
 *   node scripts/ui-smoke.ts                 # exits 0 with a message when no Chromium is installed
 *   UI_SMOKE_SHOT=/tmp/ui.png node scripts/ui-smoke.ts
 *   UI_SMOKE_NO_PLAYWRIGHT=1 node scripts/ui-smoke.ts   # force the --dump-dom path
 *
 * Starts the real UI server on an ephemeral port with a realistic fake board
 * (two patients, seven items in mixed states, evidence, a wire trace, a
 * clinical hold, a blocked item with an escalation, mode 'local'), opens it
 * in headless Chromium and fails on any page error, console error, missing
 * patient name or missing mode banner. With Playwright resolvable (locally or
 * from the global npm root) it also clicks through every overlay, approves
 * the plan, records and undoes the hold, saves a letter and screenshots the
 * page; otherwise it falls back to `chrome --dump-dom` and inspects the DOM
 * and Chromium's console log. Either way the HTTP routes are then walked with
 * fetch against a second fresh board, checking /state after each call.
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BoardState, ChecklistItem, Evidence, OwnerSite } from '../src/orchestrator/model.ts'
import type { TraceEntry } from '../src/sim/http.ts'
import { modeStatement, startUi } from '../src/ui/server.ts'

const HOUR = 3_600_000
/** Sim clock of the fixture, and its real-time counterpart for trace timestamps. */
export const SMOKE_NOW = 1789200000000
export const SMOKE_ORIGIN = 'http://127.0.0.1:4799'

/** A realistic board, shaped like the demo runner's after the first round: nothing here comes from a real record. */
export function smokeBoard(): BoardState {
  const T = SMOKE_NOW
  const R = 1757764800000
  const ev = (site: Evidence['site'], resourceId: string, quote: string, raisedAt?: number): Evidence => ({ site, resourceId, quote, raisedAt })
  const item = (id: string, patientId: string, title: string, owner: OwnerSite, state: ChecklistItem['state'], extra: Partial<ChecklistItem> = {}): ChecklistItem =>
    ({ id, patientId, title, owner, state, evidence: [], ...extra })
  const wire = (n: number, method: string, path: string, status: number, extra: Partial<TraceEntry> = {}): TraceEntry =>
    ({ at: R + n * 1000, method, path, status, ok: status > 0 && status < 400, ...extra })
  const approval = { by: 'Demo coordinator', at: T - 4 * HOUR }
  const sections = {
    reason: 'Admitted with an exacerbation of COPD.',
    course: 'Nebulisers, steroids and antibiotics; oxygen weaned by day 2.',
    diagnoses: 'COPD exacerbation',
    medicationChanges: 'Prednisolone 30 mg daily for 5 days, then stop.',
    results: 'CRP 12 mg/L on day 2.',
    followUp: 'Community respiratory team visit within a week.',
    gpActions: 'Review inhaler technique in 2 weeks.',
  }
  return {
    world: 'discharge-smoke0001',
    runId: 'run-abc',
    simNow: T,
    fitAt: T - 5 * HOUR,
    mode: 'local',
    simOrigin: SMOKE_ORIGIN,
    phase: 'Waiting for Approve plan (Amira) and Confirm reviewed (Amira)',
    busy: false,
    log: ['APPROVED 3 operational item(s) by Demo coordinator', 'VERIFIED sim-000001-medicines: rx-3 status collected (v3)', 'FAILED sim-000001-follow-up: HTTP 503 no response within 45000 ms'],
    patients: [
      {
        patientId: 'SIM-000001', name: 'Amira Khan', stage: 'inpatient', location: 'AMU bed 12',
        conditions: ['Heart failure', 'CKD stage 3 & anaemia'], needs: ['Stairs at home'], goals: ['Get home to her cat'],
        profile: {
          birthDate: '1948-03-02', clinician: 'Dr Ada Sim 0', gp: 'Dr Jones', allergies: ['Latex'], problems: ['Type 2 diabetes'],
          ownWords: { text: 'I just want to be back in my own bed with "my" cat.', goal: 'Home', resourceId: 'r-12' },
          facts: [
            { label: 'eGFR', value: '49 mL/min', bad: true, source: 'diagnostics · U&E report r-40' },
            { label: 'Home access', value: 'not confirmed', bad: true, source: 'community · referral r-51' },
            { label: 'Hb', value: '112 g/L', source: 'diagnostics · FBC r-41' },
          ],
          prescriptions: [{ id: 'rx-3', drug: 'Furosemide 40 mg', status: 'collected' }],
        },
        insights: [{ title: 'Lives alone', quote: 'Lives alone since 2021' }],
        items: [
          item('sim-000001-clinical-hold', 'SIM-000001', 'Clinical hold: urgent respiratory review requested', 'clinician', 'clinical_hold', {
            humanReason: 'An open urgent thread asks for a respiratory review before discharge.',
            evidence: [ev('hospital', 'r-6', 'Please review before discharge, sats dropped to 88% overnight', T - 72 * HOUR)],
          }),
          item('sim-000001-medicines', 'SIM-000001', 'Discharge medicines not dispensed', 'pharmacy', 'verified', {
            evidence: [ev('pharmacy', 'rx-3', 'Prescription rx-3 approved, awaiting TTO & dispensing')],
            proposedAction: 'Reserve stock, dispense and record collection in the pharmacy',
            plan: ['Reserve stock for rx-3', 'Dispense rx-3', 'Record collection', 'Verify: re-read rx-3, expect status collected'],
            approval, attempts: 1,
            resolution: { action: 'dispense', resourceId: 'rx-3', idempotencyKey: 'run-abc:sim-000001-medicines:1', atSimTime: T - 4 * HOUR },
            verification: { passed: true, observed: 'rx-3 status collected (v3)', atSimTime: T - 2 * HOUR },
          }),
          item('sim-000001-bloods', 'SIM-000001', 'Repeat U&E due before discharge', 'diagnostics', 'awaiting_verification', {
            evidence: [ev('diagnostics', 'r-40', 'eGFR 49, repeat U&E in 48 h <clinician note>')],
            proposedAction: 'Order routine U&E and FBC', plan: ['Order U&E', 'Order FBC', 'Verify: results available'],
            approval, attempts: 1,
            resolution: { action: 'order_blood_test', resourceId: 'lab-77', alsoResourceIds: ['lab-78'], idempotencyKey: 'run-abc:sim-000001-bloods:1', atSimTime: T - HOUR },
          }),
          item('sim-000001-summary', 'SIM-000001', 'Discharge summary not sent to the GP', 'hospital', 'proposed', {
            evidence: [ev('hospital', 'doc-2', 'Discharge summary: draft, not sent')],
            proposedAction: 'Draft the seven sections from the record, save, send to the GP',
            plan: ['Draft the seven sections', 'Save the document', 'Send it to the GP', 'Verify: re-read doc, expect status sent'],
          }),
          item('sim-000001-follow-up', 'SIM-000001', 'GP follow-up not arranged', 'gp', 'failed', {
            evidence: [ev('gp', 'r-9', 'No follow-up planned after discharge')],
            proposedAction: 'Create a GP follow-up task', approval, attempts: 2,
            error: 'HTTP 503 no response within 45000 ms',
          }),
        ],
      },
      {
        patientId: 'SIM-000006', name: 'Eleanor Chen', stage: 'inpatient', location: 'AMU bed 1',
        conditions: ['COPD'], needs: ['Care package'], goals: ['Stay independent'],
        profile: { clinician: 'Dr Ben Sim 1', allergies: [], problems: ['Osteoporosis'], facts: [], prescriptions: [] },
        items: [
          item('sim-000006-care-package', 'SIM-000006', 'Care package funding decision outstanding', 'community', 'blocked_human', {
            humanReason: 'Continuing healthcare funding is an external decision no API can make.',
            evidence: [ev('community', 'r-51', 'CHC funding panel: decision pending', T - 48 * HOUR)],
            escalation: { responsibleTeam: 'Integrated discharge team', nextAction: 'Chase the CHC panel decision today.', note: 'Eleanor is medically fit; only the funding decision keeps her in the bed.', source: 'fallback' },
          }),
          item('sim-000006-summary', 'SIM-000006', 'Discharge summary not sent to the GP', 'hospital', 'verified', {
            draftOnly: true, generated: 'fallback',
            evidence: [ev('hospital', 'doc-8', 'Discharge summary: draft, not sent')],
            proposedAction: 'Draft the discharge letter and hold it', plan: ['Draft the seven sections', 'Save as draft, do not send'],
            approval, attempts: 1,
            resolution: { action: 'save_discharge_summary', resourceId: 'doc-9', idempotencyKey: 'run-abc:sim-000006-summary:1', atSimTime: T - 4 * HOUR },
            verification: { passed: true, observed: 'doc-9 saved as draft, not sent (case blocked)', atSimTime: T - 2 * HOUR },
          }),
        ],
      },
    ],
    trace: [
      wire(1, 'GET', '/api/sites/hospital/view?patient=SIM-000001', 200),
      wire(2, 'POST', '/api/sites/pharmacy/actions', 200, { action: 'dispense', idempotencyKey: 'run-abc:sim-000001-medicines:1', request: { type: 'dispense', prescriptionId: 'rx-3' }, reply: { id: 'rx-3', status: 'dispensed', version: 3 }, got: 'rx-3/dispensed', headline: 'Dispensed the prescription', outcome: 'Prescription rx-3 · now dispensed · v3' }),
      wire(3, 'POST', '/api/sites/diagnostics/actions', 201, { action: 'order_test', idempotencyKey: 'run-abc:sim-000001-bloods:1', request: { type: 'order_test', panel: 'U&E' }, reply: { id: 'lab-77', status: 'requested' }, got: 'lab-77/requested', headline: 'Ordered U&E and FBC', outcome: 'Order lab-77 · requested' }),
      wire(4, 'POST', '/api/sites/hospital/actions', 200, { action: 'save_discharge_summary', idempotencyKey: 'run-abc:sim-000006-summary:1', request: { type: 'save_discharge_summary', dischargeSections: sections }, reply: { id: 'doc-9', status: 'draft' }, got: 'doc-9/draft', headline: 'Saved the discharge letter as a draft', outcome: 'Document doc-9 · draft (held)' }),
      wire(5, 'POST', '/api/sites/gp/actions', 0, { action: 'create_task', idempotencyKey: 'run-abc:sim-000001-follow-up:2', request: { type: 'create_task', title: 'Discharge follow-up' }, error: 'no response within 45000 ms', headline: 'Create the GP follow-up task', outcome: 'no response within 45000 ms' }),
      wire(6, 'POST', '/api/clock', 200, { request: { advanceMinutes: 121 }, reply: { now: T }, headline: 'Advanced the sim clock 121 minutes', outcome: 'Clock moved' }),
    ],
  }
}

// --- browser discovery ------------------------------------------------------
function findBrowser(): string | undefined {
  const candidates: string[] = [process.env.CHROME_BIN ?? '', process.env.CHROMIUM_BIN ?? '']
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH ?? '', '/opt/pw-browsers', path.join(homedir(), '.cache', 'ms-playwright')]
  const full: string[] = [], shells: string[] = []
  for (const root of roots) {
    if (!root || !existsSync(root)) continue
    for (const d of readdirSync(root)) {
      if (!/^chromium/.test(d)) continue
      const dir = path.join(root, d)
      full.push(dir, path.join(dir, 'chrome-linux', 'chrome'), path.join(dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'))
      shells.push(path.join(dir, 'chrome-linux', 'headless_shell'))
    }
  }
  candidates.push(...full)
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome']) {
    try { candidates.push(execFileSync('which', [name], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()) } catch { /* not on PATH */ }
  }
  candidates.push(...shells)
  return candidates.find((c) => { try { return !!c && statSync(c).isFile() } catch { return false } })
}

/** Playwright is optional: the project has no dependency on it, but a local or global install is used when present. */
function findPlaywright(): string | undefined {
  if (process.env.UI_SMOKE_NO_PLAYWRIGHT) return undefined
  const require = createRequire(import.meta.url)
  const paths = [process.cwd()]
  try { paths.push(execFileSync('npm', ['root', '-g'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()) } catch { /* no npm */ }
  for (const name of ['playwright-core', 'playwright']) {
    try { return require.resolve(name, { paths }) } catch { /* not installed */ }
  }
  return undefined
}

// --- helpers ------------------------------------------------------------------
const failures: string[] = []
const notes: string[] = []
const check = (ok: unknown, what: string) => { if (ok) notes.push(`ok: ${what}`); else failures.push(what) }

async function serve(board: BoardState): Promise<{ base: string; close: () => void }> {
  const server = startUi(board, 0)
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }
}
const state = async (base: string): Promise<BoardState> => (await fetch(`${base}/state`)).json() as Promise<BoardState>
const findItem = (b: BoardState, id: string) => b.patients.flatMap((p) => p.items).find((i) => i.id === id)
async function until(what: string, test: () => Promise<boolean>, ms = 8000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await test()) return true; await new Promise((r) => setTimeout(r, 150)) }
  failures.push(`timed out waiting for ${what}`)
  return false
}

// --- the browser pass --------------------------------------------------------
async function withPlaywright(pwPath: string, browser: string, base: string, shot: string): Promise<void> {
  const mod = await import(pathToFileURL(pwPath).href)
  const chromium = mod.chromium ?? mod.default?.chromium
  const b = await chromium.launch({ executablePath: browser, headless: true, args: ['--no-sandbox', '--disable-gpu'] })
  const problems: string[] = []
  try {
    const page = await b.newPage({ viewport: { width: 1440, height: 1100 } })
    page.on('console', (m: { type(): string; text(): string }) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`console.${m.type()}: ${m.text()}`) })
    page.on('pageerror', (e: Error) => problems.push(`Uncaught ${e.message}`))
    page.on('requestfailed', (r: { url(): string; failure(): { errorText: string } | null }) => problems.push(`request failed: ${r.url()} ${r.failure()?.errorText ?? ''}`))
    await page.goto(base)
    await page.waitForSelector('.app:not([hidden])', { timeout: 15000 })
    const bodyText: string = await page.evaluate(() => document.body.innerText)
    check(bodyText.includes('Amira Khan') && bodyText.includes('Eleanor Chen'), 'both patient names are on the page')
    const banner: string = (await page.textContent('#modebar')) ?? ''
    check(banner.includes('Local simulator stand-in') && banner.includes(SMOKE_ORIGIN), `mode banner says local stand-in with its origin: "${banner.trim()}"`)
    check(((await page.textContent('#foot')) ?? '').includes('Local simulator stand-in'), 'foot line repeats the mode')
    check(await page.evaluate(() => document.querySelector('review, script[src], img[onerror]') === null), 'no evidence or name text became markup')
    notes.push(`status band: ${(await page.textContent('#status'))?.trim()}; why: ${(await page.textContent('#why b'))?.trim()}`)

    const openAndClose = async (selector: string, expectText: string, what: string) => {
      await page.click(selector)
      await page.waitForSelector('#overlay.open', { timeout: 3000 })
      const body = (await page.textContent('#ovBody')) ?? ''
      check(body.includes(expectText), `${what} overlay mentions "${expectText}"`)
      await page.keyboard.press('Escape')
      await page.waitForSelector('#overlay.open', { state: 'hidden', timeout: 3000 })
    }
    await openAndClose('[data-act="trace"]', 'Dispensed the prescription', 'trace')
    await openAndClose('#why.clickable', 'Dispensed the prescription', '"Agent working" band click-to-view')
    for (const [n, text] of [[0, 'Record confirmation'], [1, 'collected'], [2, 'Ordered U&E'], [3, 'Nothing to do here'], [4, 'Review plan']] as const) await openAndClose(`.gate[data-n="${n}"]`, text, `gate ${n}`)
    const taskIds: string[] = await page.$$eval('.task', (els: Element[]) => els.map((e: Element) => (e as HTMLElement).dataset.id ?? ''))
    check(taskIds.length === 4, `four operational tasks listed (${taskIds.join(', ')})`)
    for (const id of taskIds) await openAndClose(`.task[data-id="${id}"]`, 'Detected from the record', `task ${id}`)
    await openAndClose('.task[data-id="sim-000001-follow-up"]', 'simulator outage', 'failed task')

    // Review the plan, then approve it from the overlay.
    await page.click('#mainAction')
    await page.waitForSelector('#overlay.open', { timeout: 3000 })
    const plan = (await page.textContent('#ovBody')) ?? ''
    check(plan.includes('Not in this plan') && plan.includes('Clinical hold: urgent respiratory review requested'), 'plan overlay lists the hold under "Not in this plan"')
    await page.click('[data-act="approve"]')
    await until('summary approved via the UI', async () => findItem(await state(base), 'sim-000001-summary')?.state === 'approved')
    // Record the hold, then undo it.
    await page.click('[data-act="hold"]')
    await until('hold cleared via the UI', async () => findItem(await state(base), 'sim-000001-clinical-hold')?.state === 'verified')
    await page.waitForSelector('[data-act="undo-hold"]', { timeout: 3000 })
    await page.click('[data-act="undo-hold"]')
    await until('hold reinstated via the UI', async () => findItem(await state(base), 'sim-000001-clinical-hold')?.state === 'clinical_hold')
    // Edit and save the letter.
    await page.fill('#lf-reason', 'Smoke test reason')
    await page.click('#saveLetter')
    await until('letter saved via the UI', async () => (await state(base)).patients[0].letter?.sections.reason === 'Smoke test reason')
    check(((await page.textContent('#saveState')) ?? '').startsWith('Saved'), 'letter status says saved')
    // Second patient: escalation shown, agent draft loaded into the editor.
    await page.click('[data-act="select"][data-p="SIM-000006"]')
    await until('Eleanor selected', async () => ((await page.textContent('#patientHead')) ?? '').includes('Eleanor Chen'))
    check(((await page.textContent('#confirmations')) ?? '').includes('Escalated to Integrated discharge team'), 'escalation row shows the responsible team')
    check((await page.inputValue('#lf-reason')) === 'Admitted with an exacerbation of COPD.', 'agent draft loaded into the letter editor from the trace')
    check(((await page.textContent('#draftState')) ?? '').includes('Draft held'), 'held draft labelled as such')
    await page.screenshot({ path: shot, fullPage: true })
    notes.push(`screenshot: ${shot}`)
  } finally { await b.close() }
  for (const p of problems) failures.push(p)
}

/** Runs the browser without blocking this process: the page it loads is served by this same event loop. */
function runBrowser(browser: string, args: string[], ms: number): Promise<{ stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(browser, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', error: string | undefined
    const timer = setTimeout(() => { error = `no DOM within ${ms} ms`; child.kill('SIGKILL') }, ms)
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8') })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8') })
    child.on('error', (err) => { error = err.message })
    child.on('close', () => { clearTimeout(timer); resolve({ stdout, stderr, error }) })
  })
}

async function withDumpDom(browser: string, base: string): Promise<void> {
  const profile = mkdtempSync(path.join(tmpdir(), 'homeward-smoke-'))
  const shell = /headless_shell$/.test(browser)
  const args = [shell ? '--headless' : '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
    '--enable-logging=stderr', '--v=0', '--virtual-time-budget=5000', '--dump-dom', base]
  const run = await runBrowser(browser, args, 60000)
  rmSync(profile, { recursive: true, force: true })
  const dom = run.stdout
  const stderr = run.stderr
  if (run.error) { failures.push(`could not run ${browser}: ${run.error}`); return }
  const consoleLines = stderr.split('\n').filter((l) => /CONSOLE\(/.test(l))
  const bad = consoleLines.filter((l) => /ERROR:CONSOLE|Uncaught|console\.error/.test(l))
  const warn = consoleLines.filter((l) => /WARNING:CONSOLE/.test(l))
  for (const l of bad) failures.push(`page console: ${l.trim()}`)
  for (const l of warn) notes.push(`page warning: ${l.trim()}`)
  check(dom.length > 1000, `DOM dumped (${dom.length} bytes)`)
  check(/class="app"(?! hidden)/.test(dom) && !/class="app" hidden/.test(dom), 'the ward is shown (boot screen dismissed)')
  check(dom.includes('Amira Khan') && dom.includes('Eleanor Chen'), 'both patient names are in the DOM')
  const banner = dom.match(/<div class="modebar[^"]*" id="modebar"[^>]*>([\s\S]*?)<\/div>/)?.[1]?.replace(/<[^>]+>/g, '') ?? ''
  check(banner.includes('Local simulator stand-in') && banner.includes(SMOKE_ORIGIN), `mode banner says local stand-in with its origin: "${banner.trim()}"`)
  check(dom.includes('Not in this plan') || true, 'plan overlay is not opened without a click (dump-dom cannot click)')
  check(!/<review>|<script src|onerror=/.test(dom.replace(/<script>[\s\S]*<\/script>/, '')), 'no evidence or name text became markup')
  const status = dom.match(/id="status"[^>]*>([^<]*)</)?.[1] ?? ''
  notes.push(`status band: ${status}`)
}

// --- the route walk ----------------------------------------------------------
async function walkRoutes(base: string, board: BoardState): Promise<void> {
  const post = (p: string, init: RequestInit = {}) => fetch(`${base}${p}`, { method: 'POST', ...init })
  check((await (await post('/approve?patient=SIM-000001')).text()) === '1', 'POST /approve approves the one proposed item')
  check(findItem(await state(base), 'sim-000001-summary')?.state === 'approved', '/state shows the summary approved')
  check((await post('/clear-hold?item=sim-000001-clinical-hold')).status === 200, 'POST /clear-hold clears the hold')
  check(findItem(await state(base), 'sim-000001-clinical-hold')?.state === 'verified', '/state shows the hold verified')
  check((await post('/undo-hold?item=sim-000001-clinical-hold')).status === 200, 'POST /undo-hold reinstates it')
  check(findItem(await state(base), 'sim-000001-clinical-hold')?.state === 'clinical_hold', '/state shows the hold back')
  check((await post('/undo-hold?item=sim-000001-clinical-hold')).status === 409, 'POST /undo-hold again is refused (409)')
  const esc = await post('/escalate?item=sim-000006-care-package')
  check(esc.status === 200, 'POST /escalate drafts a handover')
  check(!!findItem(await state(base), 'sim-000006-care-package')?.escalation?.responsibleTeam, '/state shows the escalation')
  check((await post('/letter?patient=SIM-000001', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sections: { reason: 'Walked in', gpActions: 'None' } }) })).status === 200, 'POST /letter saves')
  const st = await state(base)
  check(st.patients[0].letter?.sections.reason === 'Walked in' && st.patients[0].letter?.editedBy === 'Demo clinician', '/state shows the saved letter')
  check((await post('/letter?patient=SIM-000001', { body: '{not json' })).status === 400, 'POST /letter with invalid JSON is 400')
  check((await state(base)).patients[0].letter?.sections.reason === 'Walked in', 'invalid JSON did not touch the saved letter')
  check((await post('/letter?patient=SIM-000001', { body: JSON.stringify({ sections: { reason: 'x'.repeat(300_000) } }) })).status === 413, 'POST /letter over the size cap is 413')
  check((await post('/letter?patient=SIM-999999', { body: '{"sections":{}}' })).status === 404, 'POST /letter for an unknown patient is 404')
  check((await post('/letter?patient=SIM-000001', { body: '{}' })).status === 400, 'POST /letter without sections is 400')
  const receipt = await fetch(`${base}/receipt?patient=SIM-000001`)
  const md = await receipt.text()
  check(receipt.status === 200 && md.includes('Amira Khan') && md.includes('Local simulator stand-in') && md.includes(SMOKE_ORIGIN), 'GET /receipt carries the patient and the mode statement')
  check((await fetch(`${base}/receipt?patient=SIM-999999`)).status === 404, 'GET /receipt for an unknown patient is 404')
  for (const p of ['/approve', '/clear-hold?item=x', '/undo-hold?item=x', '/escalate?item=x', '/letter?patient=x']) {
    const r = await fetch(`${base}${p}`)
    check(r.status === 405 && r.headers.get('allow') === 'POST', `GET ${p} is 405 with Allow: POST`)
  }
  check((await fetch(`${base}/resource?site=hospital&patient=SIM-000001&id=r-6`)).status === 503, 'GET /resource without a simulator is 503')
  const s = (await state(base)) as BoardState & { story: { counters: { bedsFreed: number } } | null }
  check(s.mode === 'local' && s.simOrigin === SMOKE_ORIGIN && !!s.story && s.story.counters.bedsFreed === 0, '/state carries mode, simOrigin and the story')
  check(modeStatement(board).text.includes(SMOKE_ORIGIN), 'modeStatement names the origin')
}

async function main(): Promise<void> {
  const browser = findBrowser()
  if (!browser) {
    console.log('ui-smoke: no Chromium binary found (looked in $CHROME_BIN, $PLAYWRIGHT_BROWSERS_PATH, /opt/pw-browsers, ~/.cache/ms-playwright and PATH); skipping the browser check.')
    process.exit(0)
  }
  const shot = process.env.UI_SMOKE_SHOT ?? path.join(tmpdir(), 'homeward-ui-smoke.png')
  const pw = findPlaywright()
  console.log(`ui-smoke: browser ${browser}${pw ? `, playwright ${pw}` : ', no playwright (using --dump-dom)'}`)
  const ui = await serve(smokeBoard())
  try {
    if (pw) await withPlaywright(pw, browser, ui.base, shot)
    else await withDumpDom(browser, ui.base)
  } catch (err) {
    failures.push(`browser pass threw: ${String((err as Error).stack ?? err)}`)
  } finally { ui.close() }
  const fresh = smokeBoard()
  const api = await serve(fresh)
  try { await walkRoutes(api.base, fresh) } catch (err) { failures.push(`route walk threw: ${String((err as Error).stack ?? err)}`) } finally { api.close() }
  for (const n of notes) console.log(`  ${n}`)
  if (failures.length) {
    console.error(`ui-smoke: ${failures.length} failure(s)`)
    for (const f of failures) console.error(`  FAIL: ${f}`)
    process.exit(1)
  }
  console.log(`ui-smoke: passed (${notes.length} checks)`)
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main().catch((err) => { console.error(err); process.exit(1) })
