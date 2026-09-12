/**
 * Demo runner for the discharge-readiness orchestrator.
 *
 *   node scripts/demo-discharge.ts                     # new random world, full run
 *   node scripts/demo-discharge.ts --world <name>      # specific world (join code!)
 *   node scripts/demo-discharge.ts --detect-only       # M1: read-only checklist
 *   node scripts/demo-discharge.ts --no-ui             # skip the ward-list server
 *
 * Stage demo: run with a brand-new unguessable world minutes before demoing.
 */
import { joinWorld, randomWorldName, admitToWard, dischargeAttendance } from '../src/orchestrator/world.ts'
import { buildBoard, detectAll, runUntilSettled, readyForDischarge } from '../src/orchestrator/run.ts'
import type { OrchestratorContext } from '../src/orchestrator/model.ts'
import { startUi } from '../src/ui/server.ts'

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

const AMIRA = 'SIM-000001'
const ELEANOR = 'SIM-000006'

const worldName = arg('world') ?? randomWorldName()
console.log(`world: ${worldName}`)
const { sim, world } = await joinWorld(worldName)

// --- Setup: stage the narrative (day 3 of Amira's admission) ---------------
console.log('setup: admitting Amira to AMU bed 12 (assign -> assess -> refer -> admit)')
await admitToWard(sim, AMIRA, 'AMU bed 12')
// Eleanor is seeded on the take list in AMU bed 1; bring her fully in.
await admitToWard(sim, ELEANOR, 'AMU bed 1')
// TODO(team): optionally registerAndAdmit() 2-4 directory patients for ward size.

// --- Board + detection ------------------------------------------------------
const board = await buildBoard(sim, world, [AMIRA, ELEANOR])
const ctx: OrchestratorContext = {
  sim,
  world,
  board,
  log(message) {
    board.log.push(message)
    console.log(`  ${message}`)
  },
}
await detectAll(ctx)

console.log('\n=== checklist ===')
for (const p of board.patients) {
  console.log(`${p.name} (${p.patientId}) — ${p.stage} ${p.location ?? ''}`)
  for (const i of p.items) console.log(`  [${i.state}] (${i.owner}) ${i.title}`)
}

if (!flag('no-ui')) startUi(board)

if (flag('detect-only')) {
  console.log('\n--detect-only: stopping after detection (M1). UI stays up if started.')
} else {
  // --- Resolve -> advance -> verify loop ------------------------------------
  await runUntilSettled(ctx)

  // --- Finale: discharge whoever is fully green ------------------------------
  for (const p of board.patients) {
    if (readyForDischarge(p)) {
      await dischargeAttendance(sim, p.patientId, 'Home with community support and monitoring')
      ctx.log(`DISCHARGED ${p.name}`)
    } else {
      const open = p.items.filter((i) => i.state !== 'verified')
      ctx.log(`${p.name} NOT discharged — ${open.length} unresolved: ${open.map((i) => `${i.id}[${i.state}]`).join(', ')}`)
    }
  }
  console.log('\nProof in the sim’s own apps: hospital discharged list, GP inbox, community board, home dashboard.')
  console.log('Note: clinical holds require clicking "Confirm reviewed" in the UI, then re-run against the SAME world.')
}
