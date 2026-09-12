/**
 * Captures real simulator responses into fixtures/ so the client types can be
 * checked against live data. Read-only: nothing in the world changes.
 *
 * Usage (with SIM_KEY in your environment):
 *   node scripts/capture.ts
 *   git add fixtures && git commit -m "Capture simulator fixtures" && git push
 *
 * Any field named apiKey, token or secret is redacted before writing.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SimApiError, SimClient } from '../src/sim/index.ts'

const client = SimClient.fromEnv()
if (!client.apiKey) {
  console.error('No team key found. Export SIM_KEY, put it in .env, or run with SIM_KEY=<key> node scripts/capture.ts')
  process.exit(1)
}
console.log(`Using ${client.http.origin} with key ending ...${client.apiKey.slice(-4)}`)
const outDir = join(import.meta.dirname, '..', 'fixtures')
await mkdir(outDir, { recursive: true })

const captures: Array<[string, () => Promise<unknown>]> = [
  ['openapi', () => client.openapi()],
  ['health', () => client.health()],
  ['catalogue', () => client.catalogue()],
  ['team', () => client.team()],
  ['clock', () => client.clock()],
  ['gp-view', () => client.siteView('gp')],
  ['gp-patients', () => client.searchPatients('gp', 'SIM-000001')],
  ['gp-appointments', () => client.siteAppointments('gp')],
  ['gp-documents', () => client.gpDocuments()],
  ['gp-messaging-workspace', () => client.gpMessagingWorkspace()],
  ['hospital-view', () => client.siteView('hospital')],
  ['hospital-attendances', () => client.hospitalAttendances()],
  ['hospital-documents', () => client.hospitalDocuments()],
  ['pharmacy-view', () => client.siteView('pharmacy')],
  ['pharmacy-workspace', () => client.pharmacyWorkspace()],
  ['patient-view', () => client.siteView('patient')],
  ['patient-messaging-workspace', () => client.patientMessagingWorkspace()],
  ['fhir-pds-metadata', () => client.fhir.pdsCapability()],
  ['fhir-pds-patient', () => client.fhir.readPatient('SIM-000001')],
  ['fhir-ods-organization-search', () => client.fhir.searchOrganizations()],
  ['nhs-pds', () => client.adapter('pds')],
  ['nhs-eps-tracker', () => client.adapter('eps-tracker')],
  ['nhs-gp-connect', () => client.adapter('gp-connect')],
]

const summary: Record<string, string> = {}

for (const [name, run] of captures) {
  try {
    const data = await run()
    await writeFile(join(outDir, `${name}.json`), JSON.stringify(redact(data), null, 2) + '\n')
    summary[name] = 'ok'
  } catch (error) {
    if (error instanceof SimApiError) {
      await writeFile(
        join(outDir, `${name}.error.json`),
        JSON.stringify({ status: error.status, url: error.url, body: redact(error.body) }, null, 2) + '\n',
      )
      summary[name] = `HTTP ${error.status}`
    } else {
      summary[name] = `failed: ${(error as Error).message}`
    }
  }
  console.log(`${summary[name].padEnd(12)} ${name}`)
}

console.log(`\nWritten to ${outDir}. Commit the fixtures directory and push.`)

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = /apikey|token|secret|password/i.test(key) ? '[redacted]' : redact(inner)
    }
    return out
  }
  return value
}
