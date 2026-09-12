/**
 * Answers: what is actually in this world, and is there a surgical pathway?
 *
 *   node scripts/discover.ts
 *
 * Prints a compact report and writes the raw JSON to fixtures/ for digging.
 * Read-only: nothing in the world changes.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SimApiError, SimClient } from '../src/sim/index.ts'
import type { Json } from '../src/sim/index.ts'

const client = SimClient.fromEnv()
if (!client.apiKey) {
  console.error('No team key. Export SIM_KEY, put it in .env, or pass it inline.')
  process.exit(1)
}
const outDir = join(import.meta.dirname, '..', 'fixtures')
await mkdir(outDir, { recursive: true })

const SURGICAL = /surg|elective|waiting|wait.?list|theatre|operation|procedure|rtt|referral|ortho|anaesth|pre.?op|day.?case|admission/i

async function grab(name: string, run: () => Promise<unknown>): Promise<unknown> {
  try {
    const data = await run()
    await writeFile(join(outDir, `${name}.json`), JSON.stringify(data, null, 2) + '\n')
    return data
  } catch (error) {
    if (error instanceof SimApiError) {
      console.log(`  ! ${name}: HTTP ${error.status}`)
      return undefined
    }
    console.log(`  ! ${name}: ${(error as Error).message}`)
    return undefined
  }
}

// ---------------------------------------------------------------- 1. catalogue
console.log('\n=== CATALOGUE: what is live ===')
const catalogue = (await grab('catalogue', () => client.catalogue())) as Json | undefined
if (catalogue) console.log(JSON.stringify(catalogue).slice(0, 1500))

// ------------------------------------------------- 2. every action type there is
console.log('\n=== ACTION TYPES available (mined from OpenAPI) ===')
const spec = (await grab('openapi', () => client.openapi())) as Json | undefined
if (spec) {
  const enums = new Map<string, string[]>()
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`))
    for (const [key, value] of Object.entries(node as Json)) {
      if (key === 'enum' && Array.isArray(value) && value.every((v) => typeof v === 'string')) {
        enums.set(path, value as string[])
      }
      walk(value, path ? `${path}.${key}` : key)
    }
  }
  walk(spec, '')

  const actionEnums = [...enums].filter(([p]) => /type|action|status|kind/i.test(p))
  for (const [path, values] of actionEnums) {
    const label = path.split('.').filter((s) => !/^(properties|schemas|components|oneOf|anyOf|allOf)/.test(s)).slice(-4).join('.')
    console.log(`  ${label}\n    ${values.join(', ')}`)
  }
  if (actionEnums.length === 0) console.log('  (no enums found; check fixtures/openapi.json by hand)')

  const paths = Object.keys((spec.paths ?? {}) as Json)
  console.log(`\n  ${paths.length} endpoints. Surgical-looking ones:`)
  for (const p of paths.filter((p) => SURGICAL.test(p))) console.log(`    ${p}`)
}

// ------------------------------------------ 3. what resources exist at each site
console.log('\n=== RESOURCES by site ===')
for (const site of ['gp', 'hospital', 'pharmacy', 'patient'] as const) {
  const view = (await grab(`${site}-view`, () => client.siteView(site))) as Json | undefined
  const resources = (view?.resources ?? []) as Json[]
  const byType = new Map<string, number>()
  for (const r of resources) byType.set(String(r.type ?? 'untyped'), (byType.get(String(r.type ?? 'untyped')) ?? 0) + 1)
  console.log(`\n  ${site}: ${resources.length} resources`)
  for (const [type, count] of [...byType].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(4)}  ${type}${SURGICAL.test(type) ? '   <-- surgical' : ''}`)
  }
  const hits = resources.filter((r) => SURGICAL.test(JSON.stringify(r))).slice(0, 3)
  for (const hit of hits) console.log(`    example: ${JSON.stringify(hit).slice(0, 400)}`)
}

// ------------------------------------------------ 4. the elective front door
console.log('\n=== e-REFERRAL SERVICE (the elective waiting list) ===')
const ers = (await grab('nhs-ers', () => client.adapter('ers'))) as Json | undefined
if (ers) console.log(JSON.stringify(ers).slice(0, 2500))

console.log('\n=== HOSPITAL ATTENDANCES ===')
const att = (await grab('hospital-attendances', () => client.hospitalAttendances())) as Json | undefined
if (att) console.log(JSON.stringify(att).slice(0, 2000))

console.log('\n=== APPOINTMENTS ADAPTER ===')
const appts = (await grab('nhs-appointments', () => client.adapter('appointments'))) as Json | undefined
if (appts) console.log(JSON.stringify(appts).slice(0, 1500))

console.log(`\nRaw JSON in ${outDir}. Grep it: grep -ril "surg\\|elective\\|referral" fixtures/`)
