/**
 * Demo runner for Homeward, the discharge coordination agent.
 *
 *   node scripts/demo-discharge.ts                     # new random world, full run
 *   node scripts/demo-discharge.ts --world <name>      # specific world (join code!)
 *   node scripts/demo-discharge.ts --detect-only       # read-only checklist
 *   node scripts/demo-discharge.ts --no-ui             # skip the ward-list server
 *   node scripts/demo-discharge.ts --approve           # auto-approve the plan (headless)
 *
 * With the UI up and no --approve, the runner WAITS for the "Approve plan"
 * click — that is the staff-approval demo beat. Board snapshots are written to
 * fallback-board.json after each phase (serve offline via scripts/serve-fallback.ts).
 * Stage demo: run with a brand-new unguessable world minutes before demoing.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { joinWorld, randomWorldName, admitToWard, dischargeAttendance } from '../src/orchestrator/world.ts'
import { approveAll, buildBoard, clearHold, detectAll, runUntilSettled, readyForDischarge } from '../src/orchestrator/run.ts'
import { refreshStage } from '../src/orchestrator/detect.ts'
import type { OrchestratorContext } from '../src/orchestrator/model.ts'
import { startUi } from '../src/ui/server.ts'
import { annotate } from '../src/orchestrator/trace.ts'

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

const AMIRA = 'SIM-000001'
const ELEANOR = 'SIM-000006'

const worldName = arg('world') ?? randomWorldName()
console.log(`world: ${worldName}`)

// Serve the UI immediately with an empty board — it fills in live as setup
// and detection progress, so the browser never sees a connection refused.
const board: import('../src/orchestrator/model.ts').BoardState = { world: worldName, simNow: 0, patients: [], log: [], trace: [], phase: 'Joining the simulator world', busy: true }
if (!flag('no-ui')) startUi(board)

// Every simulator request lands in the board's trace — the compliance record —
// annotated with the plain-language headline and outcome the UI shows.
const { sim, world } = await joinWorld(worldName, (entry) => {
  board.trace!.push(annotate(entry))
  if (board.trace!.length > 1000) board.trace!.shift()
})
const phase = (text: string, busy = true) => { board.phase = text; board.busy = busy }
// Surface fatal errors on the page instead of leaving a dead tab.
const fatal = (err: unknown) => {
  board.phase = `Run failed: ${String((err as Error)?.message ?? err).slice(0, 160)} — Ctrl-C and re-run with --world ${board.world}`
  board.busy = false
  console.error(err)
}
process.on('uncaughtException', fatal)
process.on('unhandledRejection', fatal)
board.log.push('setting up the demo world…')

// --- Setup: stage the narrative (day 3 of Amira's admission) ---------------
/** The sim flaps under load: retry transient failures with backoff, visibly. */
async function withRetry<T>(what: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i >= attempts) throw err
      const wait = i * 5000
      phase(`${what} — simulator not responding, retrying (attempt ${i + 1}/${attempts})`)
      board.log.push(`retrying after: ${String((err as Error).message).slice(0, 120)}`)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}

console.log('setup: admitting Amira to AMU bed 12 (assign -> assess -> refer -> admit)')
phase('Admitting Amira to AMU bed 12 — walking the attendance stage machine')
await withRetry('Admitting Amira', () => admitToWard(sim, AMIRA, 'AMU bed 12'))
board.log.push('Amira admitted to AMU bed 12')
// Eleanor is seeded on the take list in AMU bed 1; bring her fully in.
phase('Admitting Eleanor to AMU bed 1')
await withRetry('Admitting Eleanor', () => admitToWard(sim, ELEANOR, 'AMU bed 1'))
board.log.push('Eleanor admitted to AMU bed 1')
// TODO(team): optionally registerAndAdmit() 2-4 directory patients for ward size.

// --- Board + detection ------------------------------------------------------
phase('Loading patient records from the simulator')
const built = await withRetry('Loading records', () => buildBoard(sim, world, [AMIRA, ELEANOR]))
board.patients.push(...built.patients)
board.simNow = built.simNow

// Safe re-run: restore item state from the last snapshot when it is the SAME
// world. Settled items stay settled, so nothing is re-resolved or duplicated.
if (existsSync('fallback-board.json')) {
  try {
    const snap = JSON.parse(readFileSync('fallback-board.json', 'utf8'))
    if (snap.world === world) {
      for (const sp of snap.patients ?? []) {
        const row = board.patients.find((p) => p.patientId === sp.patientId)
        if (row) { row.items = sp.items ?? []; row.insights = sp.insights }
      }
      board.log = [...(snap.log ?? []), '(state restored from snapshot — safe re-run)']
      console.log('restored prior state for this world from fallback-board.json')
    }
  } catch { /* unreadable snapshot: start fresh */ }
}
const ctx: OrchestratorContext = {
  sim,
  world,
  board,
  log(message) {
    board.log.push(message)
    console.log(`  ${message}`)
  },
}
phase('Reading the records — the model is detecting barriers')
await detectAll(ctx)
phase('Detection complete', false)

console.log('\n=== checklist ===')
for (const p of board.patients) {
  console.log(`${p.name} (${p.patientId}) — ${p.stage} ${p.location ?? ''}`)
  for (const i of p.items) console.log(`  [${i.state}] (${i.owner}) ${i.title}`)
}

const snapshot = () => {
  try { writeFileSync('fallback-board.json', JSON.stringify(board, null, 1)) } catch {}
}
snapshot()

if (flag('detect-only')) {
  console.log('\n--detect-only: stopping after detection. UI stays up if started.')
} else {
  // --- Staff approval gate ---------------------------------------------------
  if (flag('approve') || flag('no-ui')) {
    approveAll(board, 'Auto-approval (headless run)')
  } else {
    console.log('\nwaiting for "Approve plan" in the UI (or re-run with --approve)...')
    // The agent starts only once every patient's plan is approved, so name
    // who is still outstanding — an approved patient otherwise looks stuck.
    for (;;) {
      const waiting = board.patients.filter((p) => p.items.some((i) => i.state === 'proposed'))
      if (!waiting.length) break
      phase(`Waiting for staff to approve the plan for ${waiting.map((p) => p.name).join(' and ')}`, false)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  snapshot()

  // --- Resolve -> advance -> verify loop ------------------------------------
  await runUntilSettled(ctx)
  snapshot()

  // --- Clinical holds: a human must clear them ------------------------------
  const holds = () => board.patients.flatMap((p) => p.items).filter((i) => i.state === 'clinical_hold')
  if (holds().length) {
    if (flag('clear-holds')) {
      for (const h of holds()) { clearHold(board, h.id, 'Simulated clinician (--clear-holds)'); ctx.log(`hold ${h.id} cleared by simulated clinician`) }
    } else if (!flag('no-ui')) {
      console.log('\nwaiting for the clinician to press "Confirm reviewed" in the UI (or re-run with --clear-holds)...')
      phase('Waiting for clinician sign-off on the clinical hold', false)
      while (holds().length) await new Promise((r) => setTimeout(r, 2000))
    } else {
      ctx.log(`${holds().length} clinical hold(s) remain — headless run without --clear-holds, not discharging`)
    }
  }
  snapshot()

  // --- Finale: discharge whoever is fully green ------------------------------
  phase('Discharging ready patients in the hospital EPR')
  for (const p of board.patients) {
    if (readyForDischarge(p)) {
      await dischargeAttendance(sim, p.patientId, 'Home with community support and monitoring')
      await refreshStage(sim, p) // the board must say what the hospital record now says
      ctx.log(`DISCHARGED ${p.name}`)
    } else {
      const open = p.items.filter((i) => i.state !== 'verified')
      ctx.log(`${p.name} NOT discharged — ${open.length} unresolved: ${open.map((i) => `${i.id}[${i.state}]`).join(', ')}`)
    }
  }
  phase('Run complete', false)
  snapshot()
  console.log('\nProof in the sim’s own apps: hospital discharged list, GP inbox, community board, home dashboard.')
  console.log('Note: clinical holds require clicking "Confirm reviewed" in the UI, then re-run against the SAME world.')
}
