import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { PAGE } from '../src/ui/server.ts'

test('embedded ward UI browser script parses', () => {
  const script = PAGE.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script, 'page should contain an inline browser script')
  assert.doesNotThrow(() => new vm.Script(script))
})

test('ward UI includes the four-state dependency graph and single expansion state', () => {
  assert.match(PAGE, /Not started/)
  assert.match(PAGE, /In progress/)
  assert.match(PAGE, /Stuck/)
  assert.match(PAGE, /Completed/)
  assert.match(PAGE, /dependency-graph/)
  assert.match(PAGE, /expandedPatientId === id \? null : id/)
})
