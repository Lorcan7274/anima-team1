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
 */
import { parseArgs } from 'node:util'
import { SimApiError, SimClient } from '../src/sim/index.ts'

const { values } = parseArgs({
  options: {
    'create-team': { type: 'string' },
    patient: { type: 'string', default: 'SIM-000001' },
    title: { type: 'string', default: 'Check discharge follow-up' },
    'idempotency-key': { type: 'string', default: 'first-gp-task' },
  },
})

let client = SimClient.fromEnv()

if (!client.apiKey && !values['create-team']) {
  console.error('Set SIM_KEY to your team key, or pass --create-team "Team name" to create one.')
  process.exit(1)
}

if (values['create-team']) {
  const created = await client.createTeam(values['create-team'])
  console.log(`Team key for "${values['create-team']}": ${created.apiKey}`)
  console.log('Export it as SIM_KEY to reuse it.')
  client = client.withKey(created.apiKey)
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
  if (error instanceof SimApiError) {
    console.error(error.message)
    console.error(JSON.stringify(error.body, null, 2))
    process.exit(1)
  }
  throw error
}
