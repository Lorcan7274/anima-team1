/**
 * Static fallback for the demo: serve the Homeward UI from the last saved
 * board snapshot, no simulator needed. The demo runner writes
 * fallback-board.json after every phase.
 *
 *   node scripts/serve-fallback.ts [path/to/board.json]
 *
 * Approve / clear-hold / escalate still work, they mutate the local copy,
 * so the presenter can walk the whole flow offline.
 */
import { readFileSync } from 'node:fs'
import type { BoardState } from '../src/orchestrator/model.ts'
import { startUi } from '../src/ui/server.ts'

const path = process.argv[2] ?? 'fallback-board.json'
const board = JSON.parse(readFileSync(path, 'utf8')) as BoardState
board.mode = 'snapshot'
board.busy = false
board.log.push(`(fallback mode, serving snapshot from ${path}, simulator not connected)`)
startUi(board)
