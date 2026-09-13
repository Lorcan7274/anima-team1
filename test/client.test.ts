import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SimApiError, SimClient } from '../src/sim/index.ts'

interface Recorded {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function fakeFetch(respond: (req: Recorded) => { status?: number; body?: unknown }) {
  const calls: Recorded[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req: Recorded = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    calls.push(req)
    const { status = 200, body } = respond(req)
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { impl, calls }
}

test('createTeam posts the team name without a bearer token', async () => {
  const { impl, calls } = fakeFetch(() => ({ body: { apiKey: 'key-123' } }))
  const client = new SimClient({ origin: 'https://sim.example/', fetch: impl })
  const result = await client.createTeam('Example builders')
  assert.equal(result.apiKey, 'key-123')
  assert.equal(calls[0].url, 'https://sim.example/api/keys')
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers.Authorization, undefined)
  assert.deepEqual(JSON.parse(calls[0].body!), { teamName: 'Example builders' })
})

test('searchPatients sends the query and bearer token', async () => {
  const { impl, calls } = fakeFetch(() => ({ body: { items: [{ id: 'SIM-000001' }], total: 1 } }))
  const client = new SimClient({ origin: 'https://sim.example', apiKey: 'key-123', fetch: impl })
  const result = await client.searchPatients('gp', 'SIM-000001')
  assert.equal(result.total, 1)
  assert.equal(calls[0].url, 'https://sim.example/api/sites/gp/patients?q=SIM-000001')
  assert.equal(calls[0].headers.Authorization, 'Bearer key-123')
})

test('createTask posts a create_task action with an idempotency key', async () => {
  const { impl, calls } = fakeFetch(() => ({ body: { id: 'task-1', status: 'open' } }))
  const client = new SimClient({ origin: 'https://sim.example', apiKey: 'key-123', fetch: impl })
  const result = await client.createTask('gp', 'SIM-000001', 'Check discharge follow-up', 'first-gp-task')
  assert.equal(result.id, 'task-1')
  assert.equal(calls[0].url, 'https://sim.example/api/sites/gp/actions')
  assert.equal(calls[0].headers['Idempotency-Key'], 'first-gp-task')
  assert.equal(calls[0].headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].body!), {
    type: 'create_task',
    patientId: 'SIM-000001',
    title: 'Check discharge follow-up',
  })
})

test('methods that need a key throw before making a request', async () => {
  const { impl, calls } = fakeFetch(() => ({ body: {} }))
  const client = new SimClient({ origin: 'https://sim.example', fetch: impl })
  await assert.rejects(() => client.siteView('gp'), /SIM_KEY is not set/)
  assert.equal(calls.length, 0)
})

test('non-2xx responses become SimApiError with the parsed body', async () => {
  const { impl } = fakeFetch(() => ({ status: 401, body: { error: 'invalid key' } }))
  const client = new SimClient({ origin: 'https://sim.example', apiKey: 'bad', fetch: impl })
  await assert.rejects(
    () => client.team(),
    (error: unknown) => {
      assert.ok(error instanceof SimApiError)
      assert.equal(error.status, 401)
      assert.deepEqual(error.body, { error: 'invalid key' })
      return true
    },
  )
})

test('adapter and FHIR paths are built correctly', async () => {
  const { impl, calls } = fakeFetch(() => ({ body: { resourceType: 'Bundle' } }))
  const client = new SimClient({ origin: 'https://sim.example', apiKey: 'key-123', fetch: impl })
  await client.adapter('eps-tracker', { patientId: 'SIM-000001' })
  await client.adapterAction('gp-connect', { type: 'send_task' }, 'gc-1')
  await client.fhir.readPatient('SIM-000001')
  await client.fhir.searchOrganizations({ name: 'Riverside' })
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    [
      'GET https://sim.example/api/nhs/eps-tracker?patientId=SIM-000001',
      'POST https://sim.example/api/nhs/gp-connect/actions',
      'GET https://sim.example/api/nhs/pds/Patient/SIM-000001',
      'GET https://sim.example/api/nhs/ods/Organization?name=Riverside',
    ],
  )
  assert.equal(calls[1].headers['Idempotency-Key'], 'gc-1')
})

test('telephonyLiveUrl switches to a websocket scheme', () => {
  const client = new SimClient({ origin: 'https://sim.example', apiKey: 'k' })
  assert.equal(client.telephonyLiveUrl(), 'wss://sim.example/api/telephony/live')
})

test('createTeam gets a long timeout of its own, because a fresh world is seeded on that call', async () => {
  let seen: RequestInit | undefined
  const impl = (async (_input: string | URL | Request, init?: RequestInit) => {
    seen = init
    return new Response(JSON.stringify({ apiKey: 'k' }), { status: 201, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const client = new SimClient({ origin: 'https://sim.example', fetch: impl })
  await client.createTeam('slow-world', 250)
  assert.ok(seen?.signal, 'a timeout signal is attached')
  const started = Date.now()
  const slow = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch // answers only by aborting
  const hung = new SimClient({ origin: 'https://sim.example', fetch: slow })
  const keepAlive = setTimeout(() => {}, 5000) // AbortSignal.timeout's own timer is unref'd and would let the process exit first
  await assert.rejects(hung.createTeam('slow-world', 200), (e: any) => e.status === 0 && /no response within 200ms/.test(e.message))
  clearTimeout(keepAlive)
  assert.ok(Date.now() - started < 2000, 'the explicit timeout is the one used')
})

test('advanceClock never silently truncates: a jump beyond 10080 minutes is sent as several capped calls, all keeping the world paused', async () => {
  const { impl, calls } = fakeFetch(() => ({ body: { now: 1, paused: true } }))
  const client = new SimClient({ origin: 'https://sim.example', apiKey: 'k', fetch: impl })
  await client.advanceClock(121)
  assert.deepEqual(JSON.parse(calls[0].body!), { paused: true, advanceMinutes: 121 })
  calls.length = 0
  await client.advanceClock(25_000)
  assert.deepEqual(calls.map((c) => JSON.parse(c.body!).advanceMinutes), [10_080, 10_080, 4_840])
  assert.ok(calls.every((c) => JSON.parse(c.body!).paused === true))
  calls.length = 0
  await client.advanceClock(10_080)
  assert.equal(calls.length, 1)
})

test('a non-JSON error page becomes a SimApiError carrying the text, not a parse crash', async () => {
  const impl = (async () => new Response('<html><body>502 Bad Gateway</body></html>', { status: 502, headers: { 'content-type': 'text/html' } })) as typeof fetch
  const client = new SimClient({ origin: 'https://sim.example', apiKey: 'k', fetch: impl })
  await assert.rejects(() => client.clock(), (e: unknown) => e instanceof SimApiError && e.status === 502 && typeof e.body === 'string' && /502 Bad Gateway/.test(e.body))
})

test('withKey keeps the fetch and trace hooks of the client it copies', async () => {
  const seen: string[] = []
  const { impl, calls } = fakeFetch(() => ({ body: { ok: true } }))
  const client = new SimClient({ origin: 'https://sim.example', fetch: impl, trace: (t) => seen.push(t.path) })
  const keyed = client.withKey('k2')
  await keyed.team()
  assert.equal(calls[0].headers.Authorization, 'Bearer k2')
  assert.deepEqual(seen, ['/api/team'])
})
