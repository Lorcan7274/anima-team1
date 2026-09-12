/**
 * Contract with the simulator's OpenAPI document, checked offline against a
 * captured copy of its enums (test/fixtures/openapi-enums.json). If the
 * simulator renames an action or panel, this fails before a live run does.
 *
 * Refresh the fixture from a live document with:
 *   curl -s "$SIM_ORIGIN/api/openapi.json" > /tmp/openapi.json  (then re-extract the enums)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const enums = JSON.parse(readFileSync(new URL('./fixtures/openapi-enums.json', import.meta.url), 'utf8')) as {
  sites: string[]
  actionTypes: string[]
  hospitalCommand: string[]
  documentCommand: string[]
  panelId: string[]
  priority: string[]
  collection: string[]
  limits: { clinicalDetails: number }
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : []
  })
}
const root = new URL('..', import.meta.url).pathname
const sources = [...sourceFiles(join(root, 'src')), ...sourceFiles(join(root, 'scripts'))].map((f) => ({ file: f.slice(root.length), text: readFileSync(f, 'utf8') }))
const literals = (pattern: RegExp) => {
  const found = new Map<string, string>()
  for (const { file, text } of sources) for (const m of text.matchAll(pattern)) found.set(m[1], file)
  return found
}

test('every action type the code sends exists in the simulator action enum', () => {
  const sent = literals(/\btype: '([a-z_]+)'/g)
  sent.delete('string') // zod / JSON-schema literal, not an action
  assert.ok(sent.size >= 12, 'expected the resolvers and world setup to send a dozen or more action types')
  for (const [type, file] of sent) assert.ok(enums.actionTypes.includes(type), `${type} (in ${file}) is not an action the simulator accepts`)
})

test('hospital stage commands and document commands are ones the simulator knows', () => {
  for (const cmd of ['assign', 'assess', 'refer', 'admit', 'discharge']) {
    assert.ok(enums.hospitalCommand.includes(cmd), cmd)
    assert.ok(sources.some((s) => s.file.endsWith('world.ts') && s.text.includes(`'${cmd}'`)), `world.ts should drive the ${cmd} step`)
  }
  for (const [cmd] of literals(/documentCommand: '([a-z]+)'/g)) assert.ok(enums.documentCommand.includes(cmd), cmd)
})

test('blood orders use real panel ids and the routine priority', () => {
  const panels = literals(/panelId: '([a-z0-9]+)'/g)
  assert.deepEqual([...panels.keys()].sort(), ['fbc', 'ue'])
  for (const [p] of panels) assert.ok(enums.panelId.includes(p), p)
  assert.ok(enums.priority.includes('routine') && enums.collection.includes('now'))
})

test('the client only names sites the simulator exposes', () => {
  const { SITES } = require_sites()
  for (const site of SITES) assert.ok(enums.sites.includes(site), `${site} is not a simulator site`)
})

test('the fixture records the field limit the bloods resolver must respect', () => {
  assert.equal(typeof enums.limits.clinicalDetails, 'number')
  assert.ok(enums.limits.clinicalDetails >= 500)
})

function require_sites(): { SITES: readonly string[] } {
  const text = sources.find((s) => s.file.endsWith('sim/types.ts'))!.text
  const block = text.match(/export const SITES[^=]*=\s*\[([^\]]*)\]/)![1]
  return { SITES: [...block.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]) }
}

test('every barrier kind the model may return maps to an item id detection can produce', async () => {
  const { BARRIER_KINDS } = await import('../src/orchestrator/llm.ts')
  const detectSource = sources.find((s) => s.file.endsWith('orchestrator/detect.ts'))!.text
  for (const kind of BARRIER_KINDS) {
    if (kind === 'other') continue
    assert.ok(detectSource.includes(`slug('${kind}')`), `${kind}: no detected item uses that slug, so model evidence for it would be lost`)
  }
  assert.ok(BARRIER_KINDS.includes('clinical-hold'), 'clinical concerns must have a home other than a service item')
})
