/**
 * The local stand-in's API surface above the worlds: the endpoints that need
 * no key (/healthz, /api/catalogue, /api/openapi.json, POST /api/keys), bearer
 * authentication for everything else, and one seeded world per team key.
 *
 * Team names are join codes, as on the shared simulator: lowercased with
 * whitespace removed, and the same name always returns the same world and
 * key. Keys are derived from the name, so a re-run against a standalone
 * server keeps working with the key it saved. Minting a key is instant here;
 * the shared simulator takes tens of seconds because it seeds a world on that
 * call.
 *
 * Pure like the world: `handle()` takes a request description and returns a
 * status and body. src/sim/local/server.ts puts it behind node:http.
 */
import { createHash } from 'node:crypto'
import { ACTION_TYPES, DOCUMENT_COMMANDS, HOSPITAL_COMMANDS, LIMITS, LOCAL_SITES, PANEL_IDS, LocalWorld, type LocalRequest, type LocalResponse, type LocalWorldOptions } from './world.ts'
import { DEMO_START, seedDemoWorld } from './seed.ts'

export interface LocalSimOptions extends LocalWorldOptions {
  /** How a fresh world is populated; the demo seed by default. */
  seed?: (world: LocalWorld) => void
}

const SITE_NAMES: Record<string, string> = {
  gp: 'GP practice', hospital: 'Hospital', community: 'Community services', pharmacy: 'Community pharmacy',
  diagnostics: 'Diagnostics', referrals: 'Referrals', wearables: 'Home monitoring', patient: 'Patient app',
}

const OPEN_PATHS = ['/healthz', '/api/catalogue', '/api/openapi.json', '/api/keys']

export function normaliseTeamName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '')
}

export function keyForTeam(name: string): string {
  return `local_${createHash('sha256').update(`homeward-local-sim:${normaliseTeamName(name)}`).digest('hex').slice(0, 40)}`
}

export class LocalSim {
  readonly worlds = new Map<string, LocalWorld>()
  private readonly byKey = new Map<string, LocalWorld>()
  private readonly opts: LocalSimOptions
  readonly startedAt = Date.now()

  constructor(opts: LocalSimOptions = {}) {
    this.opts = { startAt: DEMO_START, ...opts }
  }

  /** Create the world for a team name, or return the existing one. */
  world(teamName: string): { world: LocalWorld; apiKey: string; created: boolean } {
    const name = normaliseTeamName(teamName)
    const apiKey = keyForTeam(name)
    const existing = this.worlds.get(name)
    if (existing) return { world: existing, apiKey, created: false }
    const world = new LocalWorld(name, { startAt: this.opts.startAt, arrivalsPerHour: this.opts.arrivalsPerHour })
    ;(this.opts.seed ?? seedDemoWorld)(world)
    this.worlds.set(name, world)
    this.byKey.set(apiKey, world)
    return { world, apiKey, created: true }
  }

  worldForKey(apiKey: string): LocalWorld | undefined {
    return this.byKey.get(apiKey)
  }

  handle(req: LocalRequest): LocalResponse {
    const { method, path } = req
    if (path === '/healthz') {
      return { status: 200, body: { ok: true, status: 'ok', database: 'in-memory', standIn: 'homeward-local', worlds: this.worlds.size, uptimeMs: Date.now() - this.startedAt } }
    }
    if (path === '/api/catalogue') {
      return { status: 200, body: { standIn: 'homeward-local', sites: LOCAL_SITES.map((id) => ({ id, name: SITE_NAMES[id], path: `/api/sites/${id}` })), adapters: [], incidents: [] } }
    }
    if (path === '/api/openapi.json') return { status: 200, body: openapi() }
    if (path === '/api/keys') {
      if (method !== 'POST') return { status: 405, body: { error: 'Method not allowed' } }
      const teamName = (req.body as { teamName?: unknown } | undefined)?.teamName
      if (typeof teamName !== 'string' || normaliseTeamName(teamName) === '') return { status: 400, body: { error: 'teamName is required' } }
      const { world, apiKey, created } = this.world(teamName)
      return {
        status: created ? 201 : 200,
        body: {
          apiKey, teamName: world.name, world: world.name, created, standIn: 'homeward-local',
          scopes: LOCAL_SITES.map((s) => `site:${s}`), now: world.now,
          message: created ? 'Fresh local world seeded (the shared NHS-SIM is not involved)' : 'Joined the existing local world with the same key',
        },
      }
    }
    if (!path.startsWith('/api/')) return { status: 404, body: { error: 'Unknown API endpoint' } }
    const auth = req.headers?.authorization ?? ''
    const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1]
    const world = token ? this.byKey.get(token) : undefined
    if (!world) return { status: 401, body: { error: 'Get a team API key at POST /api/keys' } }
    return world.handle(req)
  }
}

export { OPEN_PATHS }

/** A small OpenAPI document naming the subset served, so /api/openapi.json is not a dead link. */
function openapi() {
  const site = { name: 'site', in: 'path', required: true, schema: { type: 'string', enum: [...LOCAL_SITES] } }
  return {
    openapi: '3.1.0',
    info: { title: 'Homeward local simulator stand-in', version: '0.1.0', description: 'The subset of the NHS-SIM API that Homeward uses, served from memory.' },
    paths: {
      '/healthz': { get: { summary: 'Health' } },
      '/api/catalogue': { get: { summary: 'Sites' } },
      '/api/keys': { post: { summary: 'Create or join a team world', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['teamName'], properties: { teamName: { type: 'string' } } } } } } } },
      '/api/team': { get: { summary: 'The authenticated team' } },
      '/api/clock': { get: { summary: 'Sim clock' }, post: { summary: 'Pause, change speed or advance', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { paused: { type: 'boolean' }, speed: { type: 'number', minimum: 0, maximum: 3600 }, advanceMinutes: { type: 'number', minimum: 0, maximum: 10080 } } } } } } } },
      '/api/sites/{site}/view': { get: { summary: 'Scoped resources and events', parameters: [site, { name: 'patient', in: 'query' }, { name: 'limit', in: 'query' }] } },
      '/api/sites/{site}/patients': { get: { summary: 'Directory search', parameters: [site, { name: 'q', in: 'query' }] } },
      '/api/sites/{site}/appointments': { get: { summary: 'A day of sessions and appointments', parameters: [site, { name: 'date', in: 'query' }] } },
      '/api/sites/{site}/documents': { get: { summary: 'Documents visible to the site', parameters: [site] } },
      '/api/sites/hospital/attendances': { get: { summary: 'Every hospital attendance, uncapped' } },
      '/api/sites/pharmacy/pharmacy-workspace': { get: { summary: 'Prescriptions, products, orders, referrals' } },
      '/api/sites/{site}/messaging-workspace': { get: { summary: 'Conversations visible to the site', parameters: [site] } },
      '/api/sites/{site}/actions': { post: { summary: 'Execute a scoped action', parameters: [site, { name: 'Idempotency-Key', in: 'header' }] } },
    },
    components: {
      schemas: {
        ActionType: { type: 'string', enum: [...ACTION_TYPES] },
        HospitalCommand: { type: 'string', enum: [...HOSPITAL_COMMANDS] },
        DocumentCommand: { type: 'string', enum: [...DOCUMENT_COMMANDS] },
        PanelId: { type: 'string', enum: [...PANEL_IDS] },
        Limits: { type: 'object', properties: Object.fromEntries(Object.entries(LIMITS).map(([k, v]) => [k, { type: 'integer', const: v }])) },
      },
      securitySchemes: { teamKey: { type: 'http', scheme: 'bearer' } },
    },
  }
}
