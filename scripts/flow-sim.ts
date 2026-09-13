/**
 * The second screen: a whole ward running unattended, forever. By default it
 * runs against the local stand-in (src/flow/offline.ts): no simulator, every
 * outcome on the timings verified in the real one, never stalls. --live joins
 * a throwaway world in the shared simulator instead; arrivals then come from
 * the simulator as time advances and every move is a real action. "Today's
 * ward" shows the same arrivals through the manual-working model beside it.
 *
 *   node scripts/flow-sim.ts                      # local stand-in (default), screen on http://localhost:4700
 *   node scripts/flow-sim.ts --live               # the shared simulator via SIM_ORIGIN, a new random world
 *   node scripts/flow-sim.ts --live --world <n>   # join a specific world (join code!)
 *   node scripts/flow-sim.ts --offline            # accepted: the same as no flag
 *   node scripts/flow-sim.ts --step 30 --beds 12  # sim-minutes per tick, ward size
 *   node scripts/flow-sim.ts --stay 60-240        # assumed treatment stay before fit, sim-minutes (default 60-180)
 *   node scripts/flow-sim.ts --live --llm         # let the model draft letters (slower; default: canned drafts)
 *   node scripts/flow-sim.ts --replay             # no simulator: show the last flow-state.json
 *   node scripts/flow-sim.ts --replay --replay-file path/to.json
 *   node scripts/flow-sim.ts --port 4701          # serve the screen elsewhere (default 4700)
 *   node scripts/flow-sim.ts --pause-ms 500       # real time between ticks (default 2500 offline, 1500 live)
 *
 * Every tick is written to flow-state.json so --replay can run the screen
 * with nothing else at all.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { joinWorld, simOrigin } from '../src/orchestrator/world.ts'
import { offlineSim } from '../src/flow/offline.ts'
import type { SimClient } from '../src/sim/index.ts'
import { joinVisibly, modeForOrigin, newFlowState, parseFlowArgs, tick, type FlowState } from '../src/flow/engine.ts'
import { startFlowUi } from '../src/flow/ui.ts'

const SNAPSHOT = 'flow-state.json'
const args = parseFlowArgs(process.argv.slice(2))
for (const w of args.warnings) console.error(`flow: ${w}`)

// Canned drafts unless asked: the letters are the same seven sections either
// way, and the screen is about flow, not prose. The page says which it is.
// The key is emptied, not deleted: joining a world re-reads .env, which would
// put a deleted key back but leaves an empty one alone.
if (!(args.llm && args.mode === 'live')) process.env.OPENAI_API_KEY = ''

if (args.mode === 'replay') {
  let state: FlowState
  try {
    state = JSON.parse(readFileSync(args.replayFile, 'utf8')) as FlowState
    if (!Array.isArray(state.patients) || typeof state.tick !== 'number' || !state.params) throw new Error('not a flow-state.json written by this script')
  } catch (err) {
    console.error(`flow: cannot replay ${args.replayFile}: ${String((err as Error).message)}. Run the flow first (it writes ${SNAPSHOT} every tick) or pass --replay-file <path>.`)
    process.exit(1)
  }
  state.recordedMode = state.recordedMode ?? state.mode ?? 'live'
  state.mode = 'snapshot'
  state.paused = true
  state.busy = false
  state.phase = `Replay of a recorded run, ${state.tick} ticks, simulator not connected`
  startFlowUi(state, { replay: true, port: args.port })
  console.log(`replaying ${args.replayFile}: world ${state.world}, ${state.tick} ticks, recorded against the ${state.recordedMode === 'offline' ? 'local stand-in' : 'simulator'}`)
} else {
  const offline = args.mode === 'offline'
  const worldName = args.world ?? (offline ? `offline-${Math.random().toString(16).slice(2, 10)}` : `discharge-flow-${Math.random().toString(16).slice(2, 14)}`)
  const state = newFlowState(worldName, args.params)
  state.drafts = args.llm && !offline ? 'model' : 'canned'
  if (offline) state.arrivalsPerHour = 7
  else state.simOrigin = simOrigin()
  // A --live run against a loopback SIM_ORIGIN (the local HTTP stand-in) is reported as 'local', never as the shared world.
  state.mode = offline ? 'offline' : modeForOrigin(state.simOrigin!)
  startFlowUi(state, { port: args.port })
  console.log(offline ? `local stand-in, no simulator (seed ${worldName})` : `${state.mode === 'local' ? 'local simulator' : 'shared simulator'} at ${state.simOrigin}, world ${worldName}`)
  const log = (m: string) => { state.log.push(m); if (state.log.length > 400) state.log.shift(); console.log(`  ${m}`) }
  const sim: SimClient = offline
    ? offlineSim(worldName)
    : (await joinVisibly(
        state,
        (onRetry) => joinWorld(worldName, (entry) => {
          state.trace!.push(entry)
          if (state.trace!.length > 400) state.trace!.shift()
        }, 5, onRetry),
        { origin: state.simOrigin!, retryMs: 30_000, log },
      )).sim
  state.simNow = Number((await sim.clock()).now)
  state.startedAt = state.simNow
  // A world in the shared simulator persists, so a run against the same
  // world name carries on from its snapshot. The stand-in starts fresh every
  // time, so restoring would put people in the state whose records no longer exist.
  if (!offline && existsSync(SNAPSHOT)) {
    try {
      const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as FlowState
      if (snap.world === worldName) {
        Object.assign(state, snap, { params: state.params, mode: state.mode, drafts: state.drafts, simOrigin: state.simOrigin, paused: false, busy: false })
        log(`restored state for this world from ${SNAPSHOT}`)
      }
    } catch { /* start fresh */ }
  }
  const ctx = { sim, state, log }
  const pauseMs = args.pauseMs ?? (offline ? 2500 : 1500)
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
      state.phase = `Simulator not responding (${String((err as Error).message).slice(0, 80)}), retrying in ${Math.min(failures * 5, 30)}s`
      log(state.phase)
      await new Promise((r) => setTimeout(r, Math.min(failures * 5, 30) * 1000))
    }
    await new Promise((r) => setTimeout(r, pauseMs)) // let the page breathe between ticks
  }
}
