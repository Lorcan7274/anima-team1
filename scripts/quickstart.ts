/**
 * Reproduces the handbook quickstart against a team world:
 *   1. optionally create or join a team (--create-team "Name")
 *   2. read patient SIM-000001 from GP Records
 *   3. add a "Check discharge follow-up" task
 *   4. read the task back from the GP site view
 *
 * Usage:
 *   SIM_ORIGIN=https://sim.animahacks.com SIM_KEY=... node scripts/quickstart.ts
 *   node scripts/quickstart.ts --create-team "Example builders"
 *   node scripts/quickstart.ts --patient SIM-000002 --title "Review bloods"
 *   node scripts/quickstart.ts --key <team key> --origin http://localhost:8080
 *
 * A .env file in the current directory is loaded automatically.
 */
import { parseArgs } from 'node:util'
import { SimApiError, SimClient } from '../src/sim/index.ts'

const { values } = parseArgs({
  options: {
    'create-team': { type: 'string' },
    key: { type: 'string' },
    origin: { type: 'string' },
    patient: { type: 'string', default: 'SIM-000001' },
    title: { type: 'string', default: 'Check discharge follow-up' },
    'idempotency-key': { type: 'string', default: 'first-gp-task' },
  },
})

let client = SimClient.fromEnv(process.env, {
  ...(values.key ? { apiKey: values.key } : {}),
  ...(values.origin ? { origin: values.origin } : {}),
})

if (!client.apiKey && !values['create-team']) {
  console.error('No team key found. Either:')
  console.error('  export SIM_KEY=<your key>        (export, not just SIM_KEY=...)')
  console.error('  put SIM_KEY=<your key> in .env    (loaded automatically)')
  console.error('  node scripts/quickstart.ts --key <your key>')
  console.error('  node scripts/quickstart.ts --create-team "Team name"')
  process.exit(1)
}
console.log(`Using ${client.http.origin} with key ending ...${client.apiKey?.slice(-4) ?? 'none'}`)

/** A dead or unreachable simulator is reported in one line and ends the run: no silent 45 s hang per call. */
function unreachable(error: unknown): string | undefined {
  if (error instanceof SimApiError) return error.status === 0 ? error.message : undefined
  const message = String((error as Error)?.message ?? error)
  return /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|network|socket|abort/i.test(message) ? `${message} (${client.http.origin} unreachable)` : undefined
}

// Fail fast: one short probe before any real call.
try {
  await client.http.get('/healthz', undefined, { token: null, timeoutMs: 10_000 })
} catch (error) {
  console.error(`The simulator at ${client.http.origin} is not answering: ${unreachable(error) ?? String((error as Error)?.message ?? error)}`)
  console.error('Check SIM_ORIGIN (or --origin) and try again; nothing was sent.')
  process.exit(1)
}

if (values['create-team']) {
  try {
    const created = await client.createTeam(values['create-team'])
    console.log(`Team key for "${values['create-team']}": ${created.apiKey}`)
    console.log('Export it as SIM_KEY to reuse it.')
    client = client.withKey(created.apiKey)
  } catch (error) {
    console.error(`Could not create or join team "${values['create-team']}": ${unreachable(error) ?? (error instanceof SimApiError ? error.message : String((error as Error)?.message ?? error))}`)
    if (error instanceof SimApiError && error.status !== 0) console.error(JSON.stringify(error.body, null, 2))
    process.exit(1)
  }
}

try {
  const patientId = values.patient!
  const patients = await client.searchPatients('gp', patientId)
  console.log(`Patients matching ${patientId}: ${patients.total}`)
  console.log(JSON.stringify(patients.items[0] ?? null, null, 2))

  const task = await client.createTask('gp', patientId, values.title!, values['idempotency-key'])
  console.log(`Created task ${task.id} with status ${task.status}`)

  const view = await client.siteView('gp')
  const matching = view.resources.filter((r) => r.title === values.title)
  console.log(`Tasks titled "${values.title}" in GP view: ${matching.length}`)
  console.log(JSON.stringify(matching, null, 2))
} catch (error) {
  const dead = unreachable(error)
  if (dead) {
    console.error(`The simulator stopped answering: ${dead}`)
    process.exit(1)
  }
  if (error instanceof SimApiError) {
    console.error(error.message)
    console.error(JSON.stringify(error.body, null, 2))
    process.exit(1)
  }
  throw error
}
