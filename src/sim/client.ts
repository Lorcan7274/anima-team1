import { HttpClient, type HttpClientOptions, type Query } from './http.ts'
import { loadConfig, requireApiKey, type SimConfig } from './config.ts'
import type {
  Catalogue,
  ClockChange,
  ClockState,
  CreateTeamResponse,
  FhirBundle,
  FhirResource,
  Json,
  NhsAdapter,
  PatientSearchResponse,
  Site,
  SiteAction,
  SiteActionResult,
  SiteView,
  TeamInfo,
  WearableDevice,
  WearableObservation,
} from './types.ts'

export interface SimClientOptions extends Omit<HttpClientOptions, 'token'> {
  /** Team API key. Omit to create one with createTeam(). */
  apiKey?: string
}

/**
 * Client for the NHS-SIM synthetic healthcare simulator.
 *
 * Every method maps to one endpoint from the API explorer. Methods that
 * change the world go through POST endpoints and accept an idempotency key.
 */
export class SimClient {
  readonly http: HttpClient
  readonly apiKey?: string
  private readonly options: SimClientOptions

  constructor(options: SimClientOptions) {
    this.options = options
    this.apiKey = options.apiKey
    this.http = new HttpClient({ ...options, token: options.apiKey })
  }

  /** Builds a client from SIM_ORIGIN and SIM_KEY. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env, extra: Partial<SimClientOptions> = {}): SimClient {
    const config: SimConfig = loadConfig(env)
    return new SimClient({ origin: config.origin, apiKey: config.apiKey, ...extra })
  }

  /** Returns a copy of this client authenticated with a different key. */
  withKey(apiKey: string): SimClient {
    return new SimClient({ ...this.options, apiKey })
  }

  private requireKey(): string {
    return requireApiKey({ origin: this.http.origin, apiKey: this.apiKey })
  }

  // --- Discovery ---------------------------------------------------------

  /** GET /healthz: application and PostgreSQL health. No key needed. */
  health() {
    return this.http.get<Json>('/healthz', undefined, { token: null })
  }

  /** GET /api/catalogue: live sites, active adapters and simulation incidents. */
  catalogue() {
    return this.http.get<Catalogue>('/api/catalogue')
  }

  /** GET /api/openapi.json: the OpenAPI 3.1 document. No key needed. */
  openapi() {
    return this.http.get<Json>('/api/openapi.json', undefined, { token: null })
  }

  // --- Team --------------------------------------------------------------

  /**
   * POST /api/keys: create or join a team world by name. Repeating the same
   * name returns the same world and key. Does not need an existing key.
   */
  /**
   * POST /api/keys. Creating a fresh world seeds eight attendances and their
   * records, which takes the simulator tens of seconds. The server keeps
   * seeding after the client gives up, and re-posting the same team name
   * returns the same key once it is ready, so the fast path is a SHORT
   * per-attempt timeout (SIM_KEYS_TIMEOUT_MS, default 12000) and many quick
   * retries, not one long wait.
   */
  async createTeam(teamName: string, timeoutMs = Number(process.env.SIM_KEYS_TIMEOUT_MS || 12_000)): Promise<CreateTeamResponse> {
    return this.http.post<CreateTeamResponse>('/api/keys', { teamName }, { token: null, timeoutMs })
  }

  /** GET /api/team: the authenticated team and its scopes. */
  async team() {
    this.requireKey()
    return this.http.get<TeamInfo>('/api/team')
  }

  /** POST /api/session: a one-hour browser integration session. */
  async createBrowserSession(body: Json = {}) {
    this.requireKey()
    return this.http.post<Json>('/api/session', body)
  }

  // --- Service workspaces ------------------------------------------------

  /** GET /api/sites/{site}/view: scoped resources, events and simulation context. */
  async siteView(site: Site, query?: Query) {
    this.requireKey()
    return this.http.get<SiteView>(`/api/sites/${site}/view`, query)
  }

  /** GET /api/sites/{site}/patients?q=: search the synthetic patient directory. */
  async searchPatients(site: Site, q: string, query: Query = {}) {
    this.requireKey()
    return this.http.get<PatientSearchResponse>(`/api/sites/${site}/patients`, { q, ...query })
  }

  /**
   * POST /api/sites/{site}/actions: execute a scoped clinical or operational
   * action. Pass an idempotency key so retries return the original result.
   */
  async siteAction<T extends SiteActionResult = SiteActionResult>(site: Site, action: SiteAction, idempotencyKey?: string) {
    this.requireKey()
    return this.http.post<T>(`/api/sites/${site}/actions`, action, { idempotencyKey })
  }

  /** Convenience wrapper for the documented create_task action. */
  createTask(site: Site, patientId: string, title: string, idempotencyKey?: string, extra: Json = {}) {
    return this.siteAction(site, { type: 'create_task', patientId, title, ...extra }, idempotencyKey)
  }

  /** connect_device on the wearables site: issues a monitoring device to a patient. */
  connectDevice(patientId: string, title = 'Home activity watch', idempotencyKey?: string) {
    return this.siteAction('wearables', { type: 'connect_device', patientId, title }, idempotencyKey)
  }

  /** All wearable observations and devices, optionally for one patient. */
  async wearables(patientId?: string) {
    const view = await this.siteView('wearables', {
      limit: 500,
      ...(patientId ? { patient: patientId } : {}),
    })
    const resources = view.resources ?? []
    return {
      view,
      devices: resources.filter((r) => r.kind === 'device') as WearableDevice[],
      observations: resources.filter((r) => r.kind === 'observation') as WearableObservation[],
    }
  }

  /** order_test with a structured blood test order (panels: fbc, ue, hba1c, lft, crp, lipids). */
  orderBloodTest(
    site: Site,
    patientId: string,
    title: string,
    order: {
      panelId?: 'fbc' | 'ue' | 'hba1c' | 'lft' | 'crp' | 'lipids'
      panel: string
      specimen: string
      priority: 'routine' | 'urgent'
      collection: 'now' | 'next-round'
      clinicalDetails: string
    },
    idempotencyKey?: string,
  ) {
    return this.siteAction(site, { type: 'order_test', patientId, title, bloodTestOrder: order }, idempotencyKey)
  }

  /** create_referral from a site (e.g. GP -> community physio/prehab). */
  createReferral(site: Site, patientId: string, title: string, extra: Json = {}, idempotencyKey?: string) {
    return this.siteAction(site, { type: 'create_referral', patientId, title, ...extra }, idempotencyKey)
  }

  /** send_message with a messaging command (create -> sms/email conversation with the patient). */
  sendPatientMessage(
    site: Site,
    patientId: string,
    subject: string,
    body: string,
    channel: 'sms' | 'email' = 'sms',
    idempotencyKey?: string,
  ) {
    return this.siteAction(
      site,
      {
        type: 'send_message',
        patientId,
        messagingCommand: { kind: 'create', subject, body, channel, allowReply: true },
      },
      idempotencyKey,
    )
  }

  /**
   * Jump the world forward. The simulator caps advanceMinutes at 10080 (7 days)
   * per call, so a larger jump is sent as several capped calls, each keeping
   * the world paused, never silently truncated. Time never goes backwards.
   * Returns the clock state after the last call.
   */
  async advanceClock(minutes: number, keep: { paused?: boolean; speed?: number } = { paused: true }) {
    const CAP = 10_080
    let left = Number.isFinite(minutes) && minutes > 0 ? minutes : 0
    let state = await this.changeClock({ ...keep, advanceMinutes: Math.min(left, CAP) })
    left -= Math.min(left, CAP)
    while (left > 0) {
      const step = Math.min(left, CAP)
      state = await this.changeClock({ ...keep, advanceMinutes: step })
      left -= step
    }
    return state
  }

  /** GET /api/sites/{site}/appointments: a day of appointments and sessions. */
  async siteAppointments(site: Site, query?: Query) {
    this.requireKey()
    return this.http.get<Json>(`/api/sites/${site}/appointments`, query)
  }

  /** GET /api/telephony/live is a WebSocket endpoint; this returns its URL. */
  telephonyLiveUrl(): string {
    return this.http.buildUrl('/api/telephony/live').replace(/^http/, 'ws')
  }

  // --- Primary care, hospital, pharmacy, messaging ----------------------

  /** GET /api/sites/gp/documents: discharge correspondence visible to the GP. */
  async gpDocuments(query?: Query) {
    this.requireKey()
    return this.http.get<Json>('/api/sites/gp/documents', query)
  }

  /** GET /api/sites/hospital/attendances: the take, ED and inpatient list. */
  async hospitalAttendances(query?: Query) {
    this.requireKey()
    return this.http.get<Json>('/api/sites/hospital/attendances', query)
  }

  /** GET /api/sites/hospital/documents: hospital discharge summaries. */
  async hospitalDocuments(query?: Query) {
    this.requireKey()
    return this.http.get<Json>('/api/sites/hospital/documents', query)
  }

  /** GET /api/sites/pharmacy/pharmacy-workspace: prescriptions, referrals, stock, orders. */
  async pharmacyWorkspace(query?: Query) {
    this.requireKey()
    return this.http.get<Json>('/api/sites/pharmacy/pharmacy-workspace', query)
  }

  /** GET /api/sites/gp/messaging-workspace: practice conversations and templates. */
  async gpMessagingWorkspace(query?: Query) {
    this.requireKey()
    return this.http.get<Json>('/api/sites/gp/messaging-workspace', query)
  }

  /** GET /api/sites/patient/messaging-workspace: one patient's visible conversations. */
  async patientMessagingWorkspace(query?: Query) {
    this.requireKey()
    return this.http.get<Json>('/api/sites/patient/messaging-workspace', query)
  }

  // --- Simulation time ---------------------------------------------------

  /** GET /api/clock: current time and up to 100 recent visible events. */
  async clock() {
    this.requireKey()
    return this.http.get<ClockState>('/api/clock')
  }

  /** POST /api/clock: pause, change speed or advance the team world. */
  async changeClock(change: ClockChange) {
    this.requireKey()
    return this.http.post<ClockState>('/api/clock', change)
  }

  // --- NHS-shaped adapters ----------------------------------------------

  /** GET /api/nhs/{adapter}: read an adapter's current state. */
  async adapter(adapter: NhsAdapter, query?: Query) {
    this.requireKey()
    return this.http.get<Json>(`/api/nhs/${adapter}`, query)
  }

  /** POST /api/nhs/{adapter}/actions: submit an action through an adapter. */
  async adapterAction(adapter: NhsAdapter, action: Json, idempotencyKey?: string) {
    this.requireKey()
    return this.http.post<Json>(`/api/nhs/${adapter}/actions`, action, { idempotencyKey })
  }

  // --- FHIR read-only subsets -------------------------------------------

  readonly fhir = {
    pdsCapability: () => this.http.get<FhirResource>('/api/nhs/pds/metadata'),
    searchPatients: (query?: Query) => this.http.get<FhirBundle>('/api/nhs/pds/Patient', query),
    readPatient: (id: string) => this.http.get<FhirResource>(`/api/nhs/pds/Patient/${encodeURIComponent(id)}`),
    odsCapability: () => this.http.get<FhirResource>('/api/nhs/ods/metadata'),
    searchOrganizations: (query?: Query) => this.http.get<FhirBundle>('/api/nhs/ods/Organization', query),
    readOrganization: (id: string) =>
      this.http.get<FhirResource>(`/api/nhs/ods/Organization/${encodeURIComponent(id)}`),
  }
}

/**
 * Operator endpoints under /api/control use a separate operator token, not a
 * team key. Kept apart so a team client can never call them by accident.
 */
export class OperatorClient {
  readonly http: HttpClient

  constructor(options: HttpClientOptions & { token: string }) {
    this.http = new HttpClient(options)
  }

  worlds() {
    return this.http.get<Json>('/api/control/worlds')
  }

  teams() {
    return this.http.get<Json>('/api/control/teams')
  }

  teamActivity(world: string) {
    return this.http.get<Json>(`/api/control/teams/${encodeURIComponent(world)}/activity`)
  }

  exploreTeam(world: string) {
    return this.http.post<Json>(`/api/control/teams/${encodeURIComponent(world)}/session`)
  }

  snapshot() {
    return this.http.get<Json>('/api/control/snapshot')
  }

  setIncident(body: Json) {
    return this.http.post<Json>('/api/control/incidents', body)
  }

  setAgent(body: Json) {
    return this.http.post<Json>('/api/control/agents', body)
  }

  proposeModelActions(body: Json) {
    return this.http.post<Json>('/api/control/model-propose', body)
  }

  generatePopulation(body: Json = {}) {
    return this.http.post<Json>('/api/control/population', body)
  }
}
