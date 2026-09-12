import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { PAGE } from '../src/ui/server.ts'

test('embedded journey UI browser script parses', () => {
  const script = PAGE.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script, 'page should contain an inline browser script')
  assert.doesNotThrow(() => new vm.Script(script))
})

test('journey UI has the five gates, review-before-approve, confirmations and the trace drop-down', () => {
  for (const gate of ['Clinical', 'Medicines', 'Monitoring', 'Support', 'Handover']) assert.match(PAGE, new RegExp(`label: '${gate}'`))
  assert.match(PAGE, /Review plan \(/)
  assert.match(PAGE, /Approve ' \+ proposed\.length/)
  assert.match(PAGE, /Record confirmation/)
  assert.match(PAGE, /Prepare escalation/)
  assert.match(PAGE, /Show request/)
  assert.match(PAGE, /details class="reqdd"/)
  assert.match(PAGE, /Simulator did not respond/)
  assert.doesNotMatch(PAGE, /Penicillin|Dr S Sohrabi|Potassium 5\.5/, 'no hard-coded patient facts')
})

test('the page boots blank behind a loading screen that names the setup step', () => {
  assert.match(PAGE, /<div class="boot" id="boot"/)
  assert.match(PAGE, /<div class="app" hidden>/, 'nothing but the loading screen until the ward is ready')
  assert.match(PAGE, /id="bootPhase"/)
  for (const step of ['Joining the simulator world', 'Admitting patients', 'Loading patient records', 'Reading the records']) assert.match(PAGE, new RegExp(step))
})

test('the route panel always carries a why/next status line', () => {
  assert.match(PAGE, /<div class="why" id="why"/)
  assert.match(PAGE, /Agent idle: waiting for your approval/)
  assert.match(PAGE, /Agent idle: needs the clinician/)
  assert.match(PAGE, /Agent idle: waiting on an outside decision/)
  assert.match(PAGE, /Agent working: /)
  assert.match(PAGE, /Agent stopped: /)
})

test('gate circles are buttons that open what the gate needs', () => {
  assert.match(PAGE, /data-act="gate" data-n="' \+ n \+ '"/)
  assert.match(PAGE, /overlayKey\.startsWith\('gate:'\)/)
  assert.doesNotMatch(PAGE, /Each gate must be evidenced/)
  assert.match(PAGE, /\.trackfill\{[^}]*var\(--nhs-blue\)/)
})
