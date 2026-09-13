/**
 * The local simulator stand-in as a standalone server, for runs that need a
 * world to outlive one demo process (safe re-runs, the flow screen, poking
 * the API with curl).
 *
 *   node scripts/local-sim.ts                    # http://127.0.0.1:4680
 *   node scripts/local-sim.ts --port 4680        # choose the port (0 = any free port)
 *   node scripts/local-sim.ts --host 0.0.0.0     # reachable from another machine at the stall
 *   node scripts/local-sim.ts --arrivals 6       # A&E arrivals per sim-hour of advance
 *   node scripts/local-sim.ts --verbose          # one line per request
 *
 * Then point any script at it with SIM_ORIGIN, exactly as for the shared simulator:
 *
 *   SIM_ORIGIN=http://127.0.0.1:4680 node scripts/demo-discharge.ts --live --world <name>
 *   SIM_ORIGIN=http://127.0.0.1:4680 node scripts/flow-sim.ts --port 4711
 *
 * Worlds live in this process's memory: the same team name joins the same
 * world for as long as the server runs, and every world is gone when it stops.
 */
import { startLocalSim } from '../src/sim/local/server.ts'

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

const local = await startLocalSim({
  port: Number(arg('port') ?? 4680),
  host: arg('host') ?? '127.0.0.1',
  arrivalsPerHour: arg('arrivals') ? Number(arg('arrivals')) : undefined,
  verbose: flag('verbose'),
})

console.log(`Homeward local simulator stand-in: ${local.origin}`)
console.log('This is not the shared NHS-SIM world. Worlds are seeded from src/sim/local/seed.ts and live only while this process runs.')
console.log('')
console.log('Point the demo at it (team names are join codes; the same name rejoins the same world):')
console.log(`  SIM_ORIGIN=${local.origin} node scripts/demo-discharge.ts --live --world my-demo-world`)
console.log(`  SIM_ORIGIN=${local.origin} node scripts/flow-sim.ts --port 4711`)
console.log('')
console.log(`  curl ${local.origin}/healthz`)
console.log(`  curl -X POST ${local.origin}/api/keys -H 'content-type: application/json' -d '{"teamName":"my-demo-world"}'`)
console.log('')
console.log('Ctrl-C to stop.')

const stop = () => {
  console.log(`\nstopping; ${local.api.worlds.size} world(s) discarded`)
  local.close().then(() => process.exit(0))
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
