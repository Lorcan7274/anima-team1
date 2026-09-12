/**
 * The second screen: a whole ward running unattended in its own simulator
 * world, forever. Arrivals come from the simulator as time advances; Homeward
 * moves everyone along with real actions; "today's ward" shows the same
 * arrivals through the manual-working model beside it.
 *
 *   node scripts/flow-sim.ts                      # new world, UI on http://localhost:4700
 *   node scripts/flow-sim.ts --world <name>       # join a specific world (join code!)
 *   node scripts/flow-sim.ts --step 30 --beds 12  # sim-minutes per tick, ward size
 *   node scripts/flow-sim.ts --llm                # let the model draft letters (slower; default: canned drafts)
 *   node scripts/flow-sim.ts --replay             # no simulator: animate flow-state.json
 *
 * Every tick is written to flow-state.json so --replay can run the screen
 * offline if the shared simulator is down at the stall.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { joinWorld } from '../src/orchestrator/world.ts'
import { DEFAULT_FLOW, newFlowState, tick, type FlowState } from '../src/flow/engine.ts'
import { startFlowUi } from '../src/flow/ui.ts'

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined }
const flag = (name: string) => process.argv.includes(`--${name}`)
const SNAPSHOT = 'flow-state.json'

// Canned drafts unless asked: the letters are the same seven sections either
// way, and the screen is about flow, not prose. The page says which it is.
if (!flag('llm')) delete process.env.OPENAI_API_KEY

if (flag('replay')) {
  const state = JSON.parse(readFileSync(arg('replay-file') ?? SNAPSHOT, 'utf8')) as FlowState
  state.paused = true
  state.busy = false
  state.phase = 'Replay of a recorded run — simulator not connected'
  startFlowUi(state, { replay: true })
} else {
  const params = { ...DEFAULT_FLOW, stepMinutes: Number(arg('step') ?? DEFAULT_FLOW.stepMinutes), wardSize: Number(arg('beds') ?? DEFAULT_FLOW.wardSize) }
  const worldName = arg('world') ?? `discharge-flow-${Math.random().toString(16).slice(2, 14)}`
  const state = newFlowState(worldName, params)
  state.drafts = flag('llm') ? 'model' : 'canned'
  startFlowUi(state)
  console.log(`flow world: ${worldName}`)
  const { sim } = await joinWorld(worldName, (entry) => {
    state.trace!.push(entry)
    if (state.trace!.length > 400) state.trace!.shift()
  })
  const log = (m: string) => { state.log.push(m); if (state.log.length > 400) state.log.shift(); console.log(`  ${m}`) }
  state.simNow = Number((await sim.clock()).now)
  state.startedAt = state.simNow
  state.fitAt = state.simNow
  if (existsSync(SNAPSHOT)) {
    try {
      const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as FlowState
      if (snap.world === worldName) { Object.assign(state, snap, { paused: false, busy: false }); log('restored state for this world from flow-state.json') }
    } catch { /* start fresh */ }
  }
  const ctx = { sim, state, log }
  let failures = 0
  for (;;) {
    if (state.paused) { state.busy = false; state.phase = 'Paused'; await new Promise((r) => setTimeout(r, 1000)); continue }
    try {
      await tick(ctx)
      failures = 0
      try { writeFileSync(SNAPSHOT, JSON.stringify(state)) } catch { /* best effort */ }
    } catch (err) {
      failures++
      state.busy = false
      state.phase = `Simulator not responding (${String((err as Error).message).slice(0, 80)}) — retrying in ${Math.min(failures * 5, 30)}s`
      log(state.phase)
      await new Promise((r) => setTimeout(r, Math.min(failures * 5, 30) * 1000))
    }
    await new Promise((r) => setTimeout(r, Number(arg('pause-ms') ?? 1500))) // let the page breathe between ticks
  }
}
