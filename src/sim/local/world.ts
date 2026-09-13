/**
 * A local stand-in for one NHS-SIM team world, entirely in memory, behind the
 * same HTTP API subset Homeward uses. `handle()` takes a request description
 * and returns a status and body, so the world runs without sockets in tests;
 * src/sim/local/server.ts puts it behind node:http.
 *
 * It reproduces the mechanics the orchestrator was verified against on the
 * shared simulator, and nothing more: the action envelope (resourceId +
 * expectedVersion, Idempotency-Key, `Versioned <kind> required`), the
 * attendance stage machine (assign -> assess -> refer -> admit -> discharge),
 * the two-step discharge summary (draft is hospital-only, `send` reaches the
 * GP feed), share_record refusing the summary, the pharmacy chain drawing
 * down catalogue stock, the appointment book, and the verified timings: the
 * first watch reading 10 sim-minutes after connecting then hourly, a home
 * visit completed 90 minutes after scheduling, blood results 120 minutes
 * after the order, about six new A&E arrivals per sim-hour. Nothing here
 * progresses unless the clock is advanced, exactly like the real thing.
 *
 * Time-dependent outcomes are applied when the clock moves, in time order,
 * so a resource read after an advance shows what the world did meanwhile.
 * Every outcome is a plain function in this file; a reader can check that
 * the stand-in never marks anything done that was not asked for.
 */
import { seededRandom } from '../../story/baseline.ts'

export type LocalSite = 'gp' | 'hospital' | 'community' | 'pharmacy' | 'diagnostics' | 'referrals' | 'wearables' | 'patient'

export const LOCAL_SITES: readonly LocalSite[] = ['gp', 'hospital', 'community', 'pharmacy', 'diagnostics', 'referrals', 'wearables', 'patient']

/** The action enum of the shared simulator's OpenAPI document (test/fixtures/openapi-enums.json). */
export const ACTION_TYPES: readonly string[] = [
  'hospital_note', 'save_discharge_summary', 'process_document', 'messaging_action', 'place_pharmacy_order',
  'update_pharmacy_basket', 'remove_pharmacy_basket_line', 'checkout_pharmacy_basket', 'cancel_pharmacy_order',
  'receive_pharmacy_order', 'receive_pharmacy_referral', 'update_pharmacy_referral', 'receive_stock', 'update_stock_price',
  'link_prescription_stock', 'register_attendance', 'update_attendance', 'connect_device', 'create_task', 'create_referral',
  'order_test', 'draft_prescription', 'book_appointment', 'create_appointment_session', 'set_appointment_slot',
  'arrive_appointment', 'cancel_appointment', 'save_consultation', 'save_problem', 'save_allergy', 'send_message',
  'schedule_visit', 'dispatch_robot', 'review', 'accept', 'complete', 'reject', 'dispense', 'collect', 'share_record',
  'report_absence', 'restore_staff', 'allocate_shift',
]

export const HOSPITAL_COMMANDS = ['assign', 'assess', 'refer', 'admit', 'discharge'] as const
export const DOCUMENT_COMMANDS = ['send', 'assign', 'review', 'file', 'annotate'] as const
export const PANEL_IDS = ['fbc', 'ue', 'hba1c', 'lft', 'crp', 'lipids'] as const

/** Field limits from the same OpenAPI document. */
export const LIMITS = { clinicalDetails: 2000, dischargeSection: 10000, title: 500, location: 100 } as const

/** The verified timings, in sim minutes. */
export const TIMINGS = { firstReadingMinutes: 10, readingEveryMinutes: 60, visitCompletesMinutes: 90, resultsMinutes: 120 } as const

export const MIN = 60_000
export const HOUR = 60 * MIN
export const DAY = 24 * HOUR

export const DISCHARGE_SECTIONS = ['reason', 'course', 'diagnoses', 'medicationChanges', 'results', 'followUp', 'gpActions'] as const

export interface LocalResource {
  id: string
  kind: string
  status: string
  version: number
  patientId?: string
  title?: string
  priority?: string
  /** Sim time, epoch ms. */
  createdAt: number
  updatedAt: number
  data: Record<string, any>
  visibleTo: LocalSite[]
}

export interface DirectoryPatient {
  id: string
  name: string
  birthDate?: string
  conditions: string[]
  needs: string[]
  goals: string[]
  synthetic: true
}

export interface LocalEvent {
  id: string
  type: string
  /** ISO timestamp in sim time. */
  at: string
  simAt: number
  site?: LocalSite
  patientId?: string
  detail: string
}

export interface LocalRequest {
  method: string
  path: string
  query?: Record<string, string | undefined>
  /** Lower-case header names. */
  headers?: Record<string, string | undefined>
  body?: unknown
}

export interface LocalResponse {
  status: number
  body: unknown
}

export interface LocalWorldOptions {
  /** Sim clock at creation, epoch ms. */
  startAt?: number
  /** New A&E arrivals per sim-hour of advance (the shared simulator runs at about 6). */
  arrivalsPerHour?: number
}

/** Blood panels the stand-in can result, with reference ranges; the seed reuses them so history and new results agree. */
export interface AnalyteSpec { id: string; name: string; unit: string; low: number; high: number; decimals: number }
export const PANELS: Record<string, { name: string; analytes: AnalyteSpec[] }> = {
  ue: {
    name: 'Urea & electrolytes',
    analytes: [
      { id: 'sodium', name: 'Sodium', unit: 'mmol/L', low: 133, high: 146, decimals: 0 },
      { id: 'potassium', name: 'Potassium', unit: 'mmol/L', low: 3.5, high: 5.3, decimals: 1 },
      { id: 'urea', name: 'Urea', unit: 'mmol/L', low: 2.5, high: 7.8, decimals: 1 },
      { id: 'creatinine', name: 'Creatinine', unit: 'umol/L', low: 45, high: 110, decimals: 0 },
      { id: 'egfr', name: 'eGFR', unit: 'mL/min/1.73m2', low: 60, high: 120, decimals: 0 },
    ],
  },
  fbc: {
    name: 'Full blood count',
    analytes: [
      { id: 'haemoglobin', name: 'Haemoglobin', unit: 'g/L', low: 115, high: 165, decimals: 0 },
      { id: 'white-cell-count', name: 'White cell count', unit: '10^9/L', low: 4.0, high: 11.0, decimals: 1 },
      { id: 'neutrophils', name: 'Neutrophils', unit: '10^9/L', low: 2.0, high: 7.5, decimals: 1 },
      { id: 'platelets', name: 'Platelets', unit: '10^9/L', low: 150, high: 400, decimals: 0 },
    ],
  },
  hba1c: { name: 'HbA1c', analytes: [{ id: 'hba1c', name: 'HbA1c', unit: 'mmol/mol', low: 20, high: 41, decimals: 0 }] },
  lft: {
    name: 'Liver function tests',
    analytes: [
      { id: 'alt', name: 'ALT', unit: 'U/L', low: 0, high: 40, decimals: 0 },
      { id: 'alp', name: 'ALP', unit: 'U/L', low: 30, high: 130, decimals: 0 },
      { id: 'bilirubin', name: 'Bilirubin', unit: 'umol/L', low: 0, high: 21, decimals: 0 },
      { id: 'albumin', name: 'Albumin', unit: 'g/L', low: 35, high: 50, decimals: 0 },
    ],
  },
  crp: { name: 'C-reactive protein', analytes: [{ id: 'crp', name: 'CRP', unit: 'mg/L', low: 0, high: 5, decimals: 0 }] },
  lipids: {
    name: 'Lipid profile',
    analytes: [
      { id: 'total-cholesterol', name: 'Total cholesterol', unit: 'mmol/L', low: 0, high: 5.0, decimals: 1 },
      { id: 'hdl', name: 'HDL cholesterol', unit: 'mmol/L', low: 1.0, high: 3.0, decimals: 1 },
      { id: 'ldl', name: 'LDL cholesterol', unit: 'mmol/L', low: 0, high: 3.0, decimals: 1 },
      { id: 'triglycerides', name: 'Triglycerides', unit: 'mmol/L', low: 0, high: 1.7, decimals: 1 },
    ],
  },
}

// Name and record pools for generated arrivals, the same ones the flow
// screen's in-process stand-in uses (src/flow/offline.ts), copied so the two
// stand-ins draw the same kind of population.
const FIRST = ['Amira', 'Grace', 'Thomas', 'Eleanor', 'Mohammed', 'Sofia', 'George', 'Aisha', 'Oliver', 'Priya', 'Daniel', 'Fatima', 'Harry', 'Zara', 'Leo', 'Maya',
  'Isaac', 'Nadia', 'Samuel', 'Chloe', 'Yusuf', 'Hannah', 'Arjun', 'Ella', 'Kwame', 'Lily', 'Tariq', 'Ruby', 'Jacob', 'Anika', 'Ravi', 'Freya', 'Adam', 'Daisy', 'Oscar', 'Clara']
const LAST = ['Khan', 'Okafor', 'Reed', 'Chen', 'Ali', 'Williams', 'Evans', 'Patel', 'Watson', 'Sharma', 'Hughes', 'Begum', 'Taylor', 'Ahmed', 'Murphy', 'Nowak',
  'Holmes', 'Fox', 'Marshall', 'Collins', 'James', 'Thompson', 'Osei', 'Kaur', 'Baker', 'Singh', 'Roberts', 'Hussain', 'Wright', 'Mensah', 'Green', 'Ibrahim']
const CONDITIONS = ['Hypertension', 'Type 2 diabetes', 'Heart failure', 'COPD', 'Asthma', 'CKD', 'Frailty', 'Atrial fibrillation', 'Osteoarthritis', 'Depression']
const NEEDS = ['Home visit', 'Carer involvement', 'Step-free access', 'telephone preferred', 'Early appointment', 'Offline contact', 'Interpreter', 'letter preferred']
const GOALS = ['Avoid unnecessary travel', 'Stay at home with a clear contact for help', 'Know which team is visiting and when',
  'Arrange follow-up without losing a full day of work', 'Keep follow-up connected between home and study', 'Get back to the garden']
const COMPLAINTS = ['Breathlessness', 'Chest pain', 'Fall at home', 'Abdominal pain', 'Dizziness', 'Wheeze', 'Confusion', 'Head injury', 'Reduced mobility', 'Fever']

/** Resource kind and initial status for action types that create something and have no special handling. */
const GENERIC_KIND: Record<string, [kind: string, status: string]> = {
  hospital_note: ['note', 'open'],
  messaging_action: ['message', 'open'],
  send_message: ['message', 'open'],
  create_referral: ['referral', 'open'],
  draft_prescription: ['prescription', 'draft'],
  save_consultation: ['encounter', 'filed'],
  save_problem: ['problem', 'active'],
  save_allergy: ['allergy', 'active'],
  place_pharmacy_order: ['pharmacy-order', 'placed'],
  dispatch_robot: ['robot-dispatch', 'dispatched'],
}

/** Update actions whose target must be sent as resourceId + expectedVersion, and what the 400 calls the target. */
const VERSIONED_TARGET: Record<string, string> = {
  update_attendance: 'hospital-attendance', process_document: 'document', share_record: 'record',
  link_prescription_stock: 'prescription', dispense: 'prescription', collect: 'prescription',
  review: 'resource', accept: 'resource', reject: 'resource', complete: 'resource',
  cancel_appointment: 'appointment', arrive_appointment: 'appointment', set_appointment_slot: 'appointment-session',
}

/** Plain status transitions for the generic workflow verbs. */
const VERB_STATUS: Record<string, string> = { review: 'reviewed', accept: 'approved', reject: 'rejected', complete: 'completed' }

const reply = (status: number, body: unknown): LocalResponse => ({ status, body })
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): LocalResponse => ({ status, body: { error, ...extra } })
const isSite = (s: string): s is LocalSite => (LOCAL_SITES as readonly string[]).includes(s)
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

export class LocalWorld {
  readonly name: string
  readonly arrivalsPerHour: number
  /** Deterministic per world name, so the same name always produces the same arrivals and results. */
  readonly rand: () => number
  private simNow: number
  private paused = true
  private speed = 60
  /** Real time the clock was last unpaused or caught up; undefined while paused. */
  private resumedAtReal?: number
  private nextArrivalAt: number
  private readonly patients = new Map<string, DirectoryPatient>()
  private readonly resources = new Map<string, LocalResource>()
  private readonly events: LocalEvent[] = []
  private readonly idempotency = new Map<string, { payload: string; response: LocalResponse }>()
  /** Outcomes the world will apply as time passes, kept in time order. */
  private readonly due: Array<{ at: number; run: (at: number) => void }> = []
  private seq = 1
  private attendanceSeq = 1
  private patientSeq = 1
  private eventSeq = 1

  constructor(name: string, opts: LocalWorldOptions = {}) {
    this.name = name
    this.simNow = opts.startAt ?? Date.now()
    this.arrivalsPerHour = opts.arrivalsPerHour ?? 6
    this.rand = seededRandom(`local-sim:${name}`)
    this.nextArrivalAt = this.simNow + this.interArrival()
  }

  // --- State the seed and tests use directly ---------------------------------

  get now(): number { return this.simNow }

  addPatient(p: DirectoryPatient): DirectoryPatient {
    this.patients.set(p.id, p)
    const n = Number(/^SIM-(\d+)$/.exec(p.id)?.[1])
    if (Number.isFinite(n) && n >= this.patientSeq) this.patientSeq = n + 1
    return p
  }

  patient(id: string): DirectoryPatient | undefined { return this.patients.get(id) }
  allPatients(): DirectoryPatient[] { return [...this.patients.values()] }
  get(id: string): LocalResource | undefined { return this.resources.get(id) }
  all(): LocalResource[] { return [...this.resources.values()] }

  /** Insert a resource; ids and timestamps are filled in when absent. */
  put(r: Partial<LocalResource> & { kind: string; visibleTo: LocalSite[] }): LocalResource {
    const full: LocalResource = {
      id: r.id ?? this.nextId(),
      kind: r.kind,
      status: r.status ?? 'open',
      version: r.version ?? 1,
      patientId: r.patientId,
      title: r.title,
      priority: r.priority,
      createdAt: r.createdAt ?? this.simNow,
      updatedAt: r.updatedAt ?? r.createdAt ?? this.simNow,
      data: r.data ?? {},
      visibleTo: [...r.visibleTo],
    }
    this.resources.set(full.id, full)
    return full
  }

  nextId(prefix = 'r'): string {
    while (this.resources.has(`${prefix}-${this.seq}`)) this.seq++
    return `${prefix}-${this.seq++}`
  }

  /** Register an outcome for a moment in sim time; it runs when the clock reaches it. */
  schedule(at: number, run: (at: number) => void): void {
    let i = this.due.length
    while (i > 0 && this.due[i - 1].at > at) i--
    this.due.splice(i, 0, { at, run })
  }

  event(type: string, detail: string, extra: { site?: LocalSite; patientId?: string; at?: number } = {}): LocalEvent {
    const simAt = extra.at ?? this.simNow
    const e: LocalEvent = { id: `ev-${this.eventSeq++}`, type, at: new Date(simAt).toISOString(), simAt, site: extra.site, patientId: extra.patientId, detail }
    this.events.push(e)
    if (this.events.length > 500) this.events.shift()
    return e
  }

  stats(): { now: number; patients: number; resources: number; attendances: number; waiting: number } {
    const atts = this.all().filter((r) => r.kind === 'hospital-attendance')
    return { now: this.simNow, patients: this.patients.size, resources: this.resources.size, attendances: atts.length, waiting: atts.filter((a) => a.data.stage === 'waiting').length }
  }

  // --- Time -----------------------------------------------------------------

  /** Move the clock forward by whole minutes, applying every due outcome and generating arrivals. */
  advance(minutes: number): void { this.advanceMs(minutes * MIN) }

  private advanceMs(ms: number): void {
    if (ms <= 0) return
    const from = this.simNow
    const to = from + ms
    // Outcomes first, each at its own moment (a job may schedule the next one, e.g. hourly readings).
    while (this.due.length && this.due[0].at <= to) {
      const job = this.due.shift()!
      this.simNow = job.at
      job.run(job.at)
    }
    this.simNow = to
    // Arrivals are a Poisson process, so any window size gets the right rate.
    while (this.nextArrivalAt <= to) {
      this.arrive(this.nextArrivalAt)
      this.nextArrivalAt += this.interArrival()
    }
  }

  private interArrival(): number {
    return (-Math.log(1 - this.rand()) / this.arrivalsPerHour) * HOUR
  }

  /** While unpaused, sim time runs at `speed` sim-seconds per real second; applied lazily on each request. */
  private catchUp(): void {
    if (this.paused || this.resumedAtReal === undefined) return
    const realNow = Date.now()
    const elapsed = (realNow - this.resumedAtReal) * this.speed
    this.resumedAtReal = realNow
    this.advanceMs(elapsed)
  }

  private clockState() {
    return { now: this.simNow, paused: this.paused, speed: this.speed, events: this.events.slice(-100) }
  }

  private changeClock(body: unknown): LocalResponse {
    const b = (body ?? {}) as Record<string, unknown>
    if (b.advanceMinutes !== undefined) {
      const m = Number(b.advanceMinutes)
      if (!Number.isFinite(m) || m < 0 || m > 10080) return fail(400, 'advanceMinutes must be between 0 and 10080 (time never goes backwards)')
    }
    if (b.speed !== undefined) {
      const s = Number(b.speed)
      if (!Number.isFinite(s) || s < 0 || s > 3600) return fail(400, 'speed must be between 0 and 3600 simulated seconds per real second')
    }
    if (b.paused !== undefined && typeof b.paused !== 'boolean') return fail(400, 'paused must be a boolean')
    if (b.speed !== undefined) this.speed = Number(b.speed)
    if (b.advanceMinutes !== undefined && Number(b.advanceMinutes) > 0) {
      const before = this.simNow
      this.advance(Number(b.advanceMinutes))
      const arrived = this.all().filter((r) => r.kind === 'hospital-attendance' && r.createdAt > before && r.createdAt <= this.simNow).length
      this.event('clock.advanced', `${b.advanceMinutes} minutes; ${arrived} new A&E arrival${arrived === 1 ? '' : 's'}`)
    }
    if (b.paused !== undefined) {
      if (b.paused && !this.paused) { this.paused = true; this.resumedAtReal = undefined }
      if (!b.paused && this.paused) { this.paused = false; this.resumedAtReal = Date.now() }
    }
    return reply(200, this.clockState())
  }

  // --- Arrivals -------------------------------------------------------------

  private pick<T>(xs: readonly T[]): T { return xs[Math.floor(this.rand() * xs.length)] }
  private some<T>(xs: readonly T[], n: number): T[] {
    const out: T[] = []
    for (let i = 0; i < n; i++) { const x = this.pick(xs); if (!out.includes(x)) out.push(x) }
    return out
  }

  /** A new person in the directory and a waiting attendance for them. */
  private arrive(at: number): LocalResource {
    let id = `SIM-${String(this.patientSeq++).padStart(6, '0')}`
    while (this.patients.has(id)) id = `SIM-${String(this.patientSeq++).padStart(6, '0')}`
    const year = 1935 + Math.floor(this.rand() * 70)
    const patient = this.addPatient({
      id, name: `${this.pick(FIRST)} ${this.pick(LAST)}`, birthDate: `${year}-${String(1 + Math.floor(this.rand() * 12)).padStart(2, '0')}-${String(1 + Math.floor(this.rand() * 28)).padStart(2, '0')}`,
      conditions: this.some(CONDITIONS, 1 + Math.floor(this.rand() * 2)), needs: this.some(NEEDS, Math.floor(this.rand() * 3)), goals: this.some(GOALS, 1 + Math.floor(this.rand() * 2)), synthetic: true,
    })
    const complaint = this.pick(COMPLAINTS)
    const acuity = this.rand() < 0.15 ? '2' : '3'
    const att = this.newAttendance({ patientId: patient.id, presentingComplaint: complaint, acuity, location: 'Waiting room', at })
    this.event('emergency.arrived', `${patient.name} (${patient.id}): ${complaint}, acuity ${acuity}`, { site: 'hospital', patientId: patient.id, at })
    return att
  }

  private newAttendance(a: { patientId: string; presentingComplaint: string; acuity: string; location: string; at: number; title?: string; id?: string }): LocalResource {
    let id = a.id
    if (!id) {
      while (this.resources.has(`hospital-attendance-${this.attendanceSeq}`)) this.attendanceSeq++
      id = `hospital-attendance-${this.attendanceSeq++}`
    }
    return this.put({
      id, kind: 'hospital-attendance', status: 'waiting', patientId: a.patientId, title: a.title ?? a.presentingComplaint, createdAt: a.at, visibleTo: ['hospital'],
      data: { stage: 'waiting', acuity: a.acuity, location: a.location, arrivalAt: a.at, presentingComplaint: a.presentingComplaint, clinician: 'Unassigned' },
    })
  }

  // --- Reads ----------------------------------------------------------------

  private visible(site: LocalSite, patientId?: string): LocalResource[] {
    // A patient query keeps the site's patient-less records (the pharmacy
    // catalogue, appointment sessions): the shared simulator does the same,
    // which is how the medicines resolver finds the product to link.
    return this.all().filter((r) => r.visibleTo.includes(site) && (!patientId || r.patientId === patientId || r.patientId === undefined))
  }

  private clone(r: LocalResource): LocalResource {
    return { ...r, data: structuredClone(r.data), visibleTo: [...r.visibleTo] }
  }

  private patientsOf(rs: LocalResource[]): DirectoryPatient[] {
    const ids = new Set(rs.map((r) => r.patientId).filter((x): x is string => !!x))
    return [...ids].map((id) => this.patients.get(id)).filter((p): p is DirectoryPatient => !!p)
  }

  private siteView(site: LocalSite, query: Record<string, string | undefined>): LocalResponse {
    const patientId = str(query.patient)
    const limit = Math.min(Math.max(Number(query.limit ?? 200) || 200, 1), 500)
    const rs = this.visible(site, patientId)
    return reply(200, {
      site, world: this.name, now: this.simNow, total: rs.length,
      resources: rs.slice(0, limit).map((r) => this.clone(r)),
      events: this.events.filter((e) => !e.site || e.site === site).slice(-50),
    })
  }

  private searchPatients(query: Record<string, string | undefined>): LocalResponse {
    const q = (query.q ?? '').trim().toLowerCase()
    const all = this.allPatients()
    const items = q
      ? all.filter((p) => p.id.toLowerCase() === q || p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
          .sort((a, b) => Number(b.id.toLowerCase() === q) - Number(a.id.toLowerCase() === q))
      : all
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 500)
    return reply(200, { items: items.slice(0, limit), total: items.length, now: this.simNow })
  }

  private appointments(site: LocalSite, query: Record<string, string | undefined>): LocalResponse {
    const date = str(query.date) ?? dayOf(this.simNow)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(400, 'date must be YYYY-MM-DD')
    const onDay = (r: LocalResource) => typeof r.data.startsAt === 'number' && dayOf(r.data.startsAt) === date
    const rs = this.visible(site)
    return reply(200, {
      date, now: this.simNow,
      sessions: rs.filter((r) => r.kind === 'appointment-session' && onDay(r)).map((r) => this.clone(r)),
      appointments: rs.filter((r) => r.kind === 'appointment' && onDay(r)).map((r) => this.clone(r)),
    })
  }

  private documents(site: LocalSite): LocalResponse {
    const rs = this.visible(site).filter((r) => ['document', 'discharge-summary', 'letter', 'note'].includes(r.kind))
    return reply(200, { site, now: this.simNow, total: rs.length, resources: rs.map((r) => this.clone(r)), patients: this.patientsOf(rs) })
  }

  private attendances(): LocalResponse {
    // Uncapped on purpose: the flow screen counts the whole department here.
    const rs = this.all().filter((r) => r.kind === 'hospital-attendance')
    return reply(200, { now: this.simNow, total: rs.length, resources: rs.map((r) => this.clone(r)), patients: this.patientsOf(rs) })
  }

  private pharmacyWorkspace(): LocalResponse {
    const rs = this.visible('pharmacy')
    const of = (kind: string) => rs.filter((r) => r.kind === kind).map((r) => this.clone(r))
    return reply(200, { now: this.simNow, prescriptions: of('prescription'), products: of('pharmacy-product'), orders: of('pharmacy-order'), referrals: of('referral') })
  }

  private messagingWorkspace(site: LocalSite): LocalResponse {
    const rs = this.visible(site).filter((r) => r.kind === 'message')
    return reply(200, { site, now: this.simNow, conversations: rs.map((r) => this.clone(r)), templates: [] })
  }

  // --- The request handler ----------------------------------------------------

  handle(req: LocalRequest): LocalResponse {
    this.catchUp()
    const { method, path } = req
    const query = req.query ?? {}
    if (path === '/api/team') {
      if (method !== 'GET') return fail(405, 'Method not allowed')
      return reply(200, { teamName: this.name, world: this.name, scopes: LOCAL_SITES.map((s) => `site:${s}`), standIn: 'homeward-local', now: this.simNow })
    }
    if (path === '/api/clock') {
      if (method === 'GET') return reply(200, this.clockState())
      if (method === 'POST') return this.changeClock(req.body)
      return fail(405, 'Method not allowed')
    }
    const m = /^\/api\/sites\/([a-z]+)\/([a-z-]+)$/.exec(path)
    if (!m) return fail(404, 'Unknown API endpoint')
    const [, siteName, rest] = m
    if (!isSite(siteName)) return fail(404, `Unknown site '${siteName}'`)
    const site: LocalSite = siteName
    if (rest === 'actions') {
      if (method !== 'POST') return fail(405, 'Method not allowed')
      return this.action(site, req.body, req.headers?.['idempotency-key'])
    }
    if (method !== 'GET') return fail(405, 'Method not allowed')
    switch (rest) {
      case 'view': return this.siteView(site, query)
      case 'patients': return this.searchPatients(query)
      case 'appointments': return this.appointments(site, query)
      case 'documents': return this.documents(site)
      case 'attendances': return this.attendances()
      case 'pharmacy-workspace': return this.pharmacyWorkspace()
      case 'messaging-workspace': return this.messagingWorkspace(site)
      default: return fail(404, 'Unknown API endpoint')
    }
  }

  // --- Actions ----------------------------------------------------------------

  /** The action envelope: idempotency, then the type-specific handler. */
  action(site: LocalSite, body: unknown, idempotencyKey?: string): LocalResponse {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Action body must be a JSON object')
    const b = body as Record<string, any>
    const type = str(b.type)
    if (!type) return fail(400, 'Action type is required')
    if (!ACTION_TYPES.includes(type)) return fail(400, `Unknown action type '${type}'`)
    // Idempotency keys protect retries of the identical request only. Only a
    // result that changed the world is remembered; a rejected request can be
    // corrected and re-sent under the same key.
    const payload = JSON.stringify(b)
    if (idempotencyKey) {
      const prev = this.idempotency.get(idempotencyKey)
      if (prev && prev.payload === payload) return prev.response
      if (prev) return fail(409, `Idempotency-Key '${idempotencyKey}' was already used with a different payload`)
    }
    const res = this.runAction(site, type, b)
    if (idempotencyKey && res.status < 300) this.idempotency.set(idempotencyKey, { payload, response: res })
    return res
  }

  private runAction(site: LocalSite, type: string, b: Record<string, any>): LocalResponse {
    if (str(b.title) && b.title.length > LIMITS.title) return fail(400, `title exceeds ${LIMITS.title} characters`)
    switch (type) {
      case 'register_attendance': return this.registerAttendance(b)
      case 'update_attendance': return this.updateAttendance(b)
      case 'create_task': return this.createTask(site, b)
      case 'order_test': return this.orderTest(site, b)
      case 'connect_device': return this.connectDevice(b)
      case 'schedule_visit': return this.scheduleVisit(site, b)
      case 'save_discharge_summary': return this.saveDischargeSummary(b)
      case 'process_document': return this.processDocument(b)
      case 'share_record': return this.shareRecord(b)
      case 'link_prescription_stock': return this.linkPrescriptionStock(b)
      case 'dispense': return this.prescriptionStep(b, 'linked', 'dispensed')
      case 'collect': return this.prescriptionStep(b, 'dispensed', 'collected')
      case 'review': case 'accept': case 'reject': case 'complete': return this.verb(type, b)
      case 'create_appointment_session': return this.createSession(site, b)
      case 'book_appointment': return this.bookAppointment(site, b)
      case 'cancel_appointment': return this.appointmentStatus(b, 'cancelled')
      case 'arrive_appointment': return this.appointmentStatus(b, 'arrived')
      case 'set_appointment_slot': return this.setSlot(b)
      default: return this.generic(site, type, b)
    }
  }

  /** The update target, or the error the shared simulator would give. */
  private target(type: string, b: Record<string, any>, kinds?: string[]): { r: LocalResource } | { res: LocalResponse } {
    const label = VERSIONED_TARGET[type] ?? 'resource'
    if (!str(b.resourceId) || typeof b.expectedVersion !== 'number') {
      return { res: fail(400, `Versioned ${label} required`, { hint: 'send resourceId and expectedVersion (the current version), not id' }) }
    }
    const r = this.resources.get(b.resourceId)
    if (!r) return { res: fail(404, `No ${label} with id '${b.resourceId}'`) }
    if (kinds && !kinds.includes(r.kind)) return { res: fail(400, `${type} targets a ${kinds.join(' or ')}, not a ${r.kind}`) }
    if (r.version !== b.expectedVersion) return { res: fail(409, `Version conflict: ${r.id} is at version ${r.version}, expectedVersion was ${b.expectedVersion}`, { currentVersion: r.version }) }
    return { r }
  }

  private bump(r: LocalResource, changes: { status?: string; data?: Record<string, unknown>; visibleTo?: LocalSite[] } = {}): LocalResponse {
    if (changes.status) r.status = changes.status
    if (changes.data) Object.assign(r.data, changes.data)
    if (changes.visibleTo) for (const s of changes.visibleTo) if (!r.visibleTo.includes(s)) r.visibleTo.push(s)
    r.version++
    r.updatedAt = this.simNow
    return reply(200, this.clone(r))
  }

  private created(r: LocalResource): LocalResponse { return reply(201, this.clone(r)) }

  private requirePatient(b: Record<string, any>): LocalResponse | undefined {
    if (!str(b.patientId)) return fail(400, 'patientId is required')
    if (!this.patients.has(b.patientId)) return fail(404, `No patient '${b.patientId}' in the directory`)
    return undefined
  }

  private registerAttendance(b: Record<string, any>): LocalResponse {
    const missing = ['patientId', 'presentingComplaint', 'acuity', 'location'].filter((k) => b[k] === undefined || b[k] === null || b[k] === '')
    if (missing.length) return fail(400, `Missing required fields: ${missing.join(', ')}`, { missing })
    const bad = this.requirePatient(b)
    if (bad) return bad
    if (String(b.location).length > LIMITS.location) return fail(400, `location exceeds ${LIMITS.location} characters`)
    const acuity = String(b.acuity)
    if (!/^[1-5]$/.test(acuity)) return fail(400, 'acuity must be 1 to 5')
    const att = this.newAttendance({ patientId: b.patientId, presentingComplaint: String(b.presentingComplaint), acuity, location: String(b.location), at: this.simNow, title: str(b.title) })
    this.event('hospital.attendance.registered', `${b.patientId}: ${b.presentingComplaint}`, { site: 'hospital', patientId: b.patientId })
    return this.created(att)
  }

  /**
   * The verified stage machine. `assign` names a clinician and leaves the
   * stage at waiting; every later command needs the one before it, so an
   * admit straight from waiting is refused with the reason.
   */
  private updateAttendance(b: Record<string, any>): LocalResponse {
    const cmd = str(b.hospitalCommand)
    if (!cmd || !(HOSPITAL_COMMANDS as readonly string[]).includes(cmd)) return fail(400, `hospitalCommand must be one of ${HOSPITAL_COMMANDS.join(', ')}`)
    const t = this.target('update_attendance', b, ['hospital-attendance'])
    if ('res' in t) return t.res
    const att = t.r
    const stage = String(att.data.stage)
    const wrong = (expected: string) => fail(409, `Cannot ${cmd} an attendance at stage '${stage}': it must be '${expected}' first`, { stage })
    const done = (status: string, data: Record<string, unknown>) => {
      const res = this.bump(att, { status, data: { ...data, stage: status } })
      this.event(`hospital.attendance.${cmd}`, `${att.patientId}: ${cmd} -> ${status}`, { site: 'hospital', patientId: att.patientId })
      return res
    }
    switch (cmd) {
      case 'assign': {
        if (stage !== 'waiting') return wrong('waiting')
        if (!str(b.clinician)) return fail(400, 'assign needs a clinician')
        return done('waiting', { clinician: b.clinician, assignedAt: this.simNow })
      }
      case 'assess': {
        if (stage !== 'waiting') return wrong('waiting')
        if (!att.data.clinician || att.data.clinician === 'Unassigned') return fail(409, 'Assign a clinician before assessing', { stage })
        return done('assessing', { assessedAt: this.simNow })
      }
      case 'refer': {
        if (stage !== 'assessing') return wrong('assessing')
        return done('take', { referredAt: this.simNow })
      }
      case 'admit': {
        if (stage !== 'take') return wrong('take')
        if (!str(b.location)) return fail(400, 'admit needs a location (ward and bed, free text)')
        if (b.location.length > LIMITS.location) return fail(400, `location exceeds ${LIMITS.location} characters`)
        return done('inpatient', { location: b.location, admittedAt: this.simNow })
      }
      case 'discharge': {
        if (stage === 'discharged') return fail(409, 'Already discharged', { stage })
        if (stage === 'waiting') return fail(409, 'Assess the patient before discharging', { stage })
        if (!str(b.disposition)) return fail(400, 'discharge needs a disposition')
        return done('discharged', { disposition: b.disposition, dischargedAt: this.simNow })
      }
    }
    return fail(400, 'Unhandled hospitalCommand')
  }

  private createTask(site: LocalSite, b: Record<string, any>): LocalResponse {
    const bad = this.requirePatient(b)
    if (bad) return bad
    if (!str(b.title)) return fail(400, 'title is required')
    const task = this.put({ kind: 'task', status: 'open', patientId: b.patientId, title: b.title, visibleTo: [site], data: { site, dueAt: b.dueAt, note: b.note } })
    this.event('task.created', `${site}: ${b.title}`, { site, patientId: b.patientId })
    return this.created(task)
  }

  /** A blood order reads as an open 'report'; 120 sim-minutes later the same id carries the analytes. */
  private orderTest(site: LocalSite, b: Record<string, any>): LocalResponse {
    const bad = this.requirePatient(b)
    if (bad) return bad
    const o = b.bloodTestOrder
    if (!o || typeof o !== 'object') return fail(400, 'bloodTestOrder is required')
    const missing = ['panel', 'specimen', 'priority', 'collection', 'clinicalDetails'].filter((k) => !str(o[k]))
    if (missing.length) return fail(400, `bloodTestOrder is missing: ${missing.join(', ')}`, { missing })
    const panelId = str(o.panelId) ?? Object.keys(PANELS).find((id) => PANELS[id].name.toLowerCase() === String(o.panel).toLowerCase()) ?? 'ue'
    if (!(PANEL_IDS as readonly string[]).includes(panelId)) return fail(400, `panelId must be one of ${PANEL_IDS.join(', ')}`)
    if (!['routine', 'urgent'].includes(o.priority)) return fail(400, 'priority must be routine or urgent')
    if (!['now', 'next-round'].includes(o.collection)) return fail(400, 'collection must be now or next-round')
    if (o.clinicalDetails.length > LIMITS.clinicalDetails) return fail(400, `clinicalDetails exceeds ${LIMITS.clinicalDetails} characters`)
    const order = this.put({
      kind: 'report', status: 'open', patientId: b.patientId, title: str(b.title) ?? `${PANELS[panelId].name} (${o.priority})`, priority: o.priority,
      visibleTo: [...new Set<LocalSite>(['diagnostics', 'hospital', site])],
      data: {
        kind: 'blood-order', panel: { id: panelId, name: PANELS[panelId].name }, specimen: o.specimen, priority: o.priority, collection: o.collection,
        clinicalDetails: o.clinicalDetails, orderedAt: this.simNow, orderedFrom: site, expectedAt: this.simNow + TIMINGS.resultsMinutes * MIN,
      },
    })
    this.event('diagnostics.order.placed', `${b.patientId}: ${PANELS[panelId].name}, ${o.priority}`, { site: 'diagnostics', patientId: b.patientId })
    this.schedule(order.data.expectedAt, (at) => {
      if (order.status !== 'open') return
      order.status = 'available'
      order.data.kind = 'blood-result'
      order.data.analytes = this.resultAnalytes(panelId, order.patientId)
      order.data.resultedAt = at
      order.version++
      order.updatedAt = at
      this.event('diagnostics.result.available', `${order.patientId}: ${PANELS[panelId].name}`, { site: 'diagnostics', patientId: order.patientId, at })
    })
    return this.created(order)
  }

  /**
   * Plausible analytes for a panel: each value starts from the patient's own
   * most recent result for that analyte when there is one (so a CKD patient's
   * repeat eGFR stays low), otherwise from the middle of the range, with a
   * small seeded variation.
   */
  private resultAnalytes(panelId: string, patientId?: string): Array<{ id: string; name: string; value: number; unit: string; referenceLow: number; referenceHigh: number }> {
    const previous = this.all()
      .filter((r) => r.kind === 'report' && r.patientId === patientId && r.data.kind === 'blood-result' && r.data.panel?.id === panelId && Array.isArray(r.data.analytes))
      .sort((a, b) => a.createdAt - b.createdAt)
      .at(-1)
    return PANELS[panelId].analytes.map((spec) => {
      const last = (previous?.data.analytes as Array<{ id: string; value: number }> | undefined)?.find((a) => a.id === spec.id)
      const base = last && Number.isFinite(Number(last.value)) ? Number(last.value) : (spec.low + spec.high) / 2
      const value = Number((base * (1 + (this.rand() - 0.5) * 0.08)).toFixed(spec.decimals))
      return { id: spec.id, name: spec.name, value, unit: spec.unit, referenceLow: spec.low, referenceHigh: spec.high }
    })
  }

  /** A device reads at +10 minutes and then hourly, draining one percent of battery per reading. */
  private connectDevice(b: Record<string, any>): LocalResponse {
    const bad = this.requirePatient(b)
    if (bad) return bad
    const device = this.put({
      kind: 'device', status: 'active', patientId: b.patientId, title: str(b.title) ?? 'Home activity watch', visibleTo: ['wearables'],
      data: { metric: 'steps', battery: 100, quality: 'good', connectedAt: this.simNow, readings: 0 },
    })
    this.event('wearables.device.connected', `${b.patientId}: ${device.title}`, { site: 'wearables', patientId: b.patientId })
    const read = (at: number) => {
      if (device.status !== 'active' || device.data.battery <= 0) return
      const hour = new Date(at).getUTCHours()
      const awake = hour >= 7 && hour <= 22 ? 1 : 0.1
      const value = Math.round((150 + this.rand() * 450) * awake)
      this.put({
        kind: 'observation', status: 'final', patientId: device.patientId, title: 'Step count', visibleTo: ['wearables'], createdAt: at,
        data: { metric: 'steps', value, unit: 'steps', observedAt: at, quality: 'good', deviceId: device.id },
      })
      device.data.battery = Math.max(0, device.data.battery - 1)
      device.data.readings++
      device.data.lastReadingAt = at
      this.schedule(at + TIMINGS.readingEveryMinutes * MIN, read)
    }
    this.schedule(this.simNow + TIMINGS.firstReadingMinutes * MIN, read)
    return this.created(device)
  }

  /** On the community board at once; completed 90 sim-minutes after scheduling. */
  private scheduleVisit(site: LocalSite, b: Record<string, any>): LocalResponse {
    const bad = this.requirePatient(b)
    if (bad) return bad
    const visit = this.put({
      kind: 'visit', status: 'scheduled', patientId: b.patientId, title: str(b.title) ?? 'Community visit',
      visibleTo: [...new Set<LocalSite>(['community', 'hospital', site])],
      data: { scheduledAt: this.simNow, scheduledFrom: site, dueAt: this.simNow + TIMINGS.visitCompletesMinutes * MIN, team: 'Community nursing' },
    })
    this.event('community.visit.scheduled', `${b.patientId}: ${visit.title}`, { site: 'community', patientId: b.patientId })
    this.schedule(visit.data.dueAt, (at) => {
      if (visit.status !== 'scheduled') return
      visit.status = 'completed'
      visit.data.completedAt = at
      visit.version++
      visit.updatedAt = at
      this.event('community.visit.completed', `${visit.patientId}: ${visit.title}`, { site: 'community', patientId: visit.patientId, at })
    })
    return this.created(visit)
  }

  /** A draft the hospital alone can see until process_document sends it. */
  private saveDischargeSummary(b: Record<string, any>): LocalResponse {
    const bad = this.requirePatient(b)
    if (bad) return bad
    const s = b.dischargeSections
    if (!s || typeof s !== 'object') return fail(400, `dischargeSections is required with ${DISCHARGE_SECTIONS.join(', ')}`)
    const missing = DISCHARGE_SECTIONS.filter((k) => typeof s[k] !== 'string' || s[k].trim() === '')
    if (missing.length) return fail(400, `dischargeSections is missing: ${missing.join(', ')}`, { missing })
    const long = DISCHARGE_SECTIONS.filter((k) => s[k].length > LIMITS.dischargeSection)
    if (long.length) return fail(400, `dischargeSections over ${LIMITS.dischargeSection} characters: ${long.join(', ')}`)
    const sections = Object.fromEntries(DISCHARGE_SECTIONS.map((k) => [k, s[k]]))
    const summary = this.put({
      kind: 'discharge-summary', status: 'draft', patientId: b.patientId, title: str(b.title) ?? 'Discharge summary', visibleTo: ['hospital'],
      data: { sections, text: DISCHARGE_SECTIONS.map((k) => `${k}: ${s[k]}`).join('\n'), author: str(b.author) ?? 'Homeward discharge agent', documentType: 'discharge-summary' },
    })
    this.event('hospital.document.drafted', `${b.patientId}: ${summary.title}`, { site: 'hospital', patientId: b.patientId })
    return this.created(summary)
  }

  private processDocument(b: Record<string, any>): LocalResponse {
    const cmd = str(b.documentCommand)
    if (!cmd || !(DOCUMENT_COMMANDS as readonly string[]).includes(cmd)) return fail(400, `documentCommand must be one of ${DOCUMENT_COMMANDS.join(', ')}`)
    const t = this.target('process_document', b, ['document', 'discharge-summary', 'letter', 'note'])
    if ('res' in t) return t.res
    const doc = t.r
    switch (cmd) {
      case 'send': {
        if (doc.status === 'sent') return fail(409, 'Already sent')
        const res = this.bump(doc, { status: 'sent', data: { sentAt: this.simNow, sentTo: 'gp' }, visibleTo: ['gp'] })
        this.event('hospital.document.sent', `${doc.patientId}: ${doc.title} -> GP`, { site: 'gp', patientId: doc.patientId })
        return res
      }
      case 'assign': return this.bump(doc, { status: 'assigned', data: { assignee: str(b.assignee) ?? str(b.clinician) ?? 'Unassigned' } })
      case 'review': return this.bump(doc, { status: 'reviewed', data: { reviewedAt: this.simNow } })
      case 'file': return this.bump(doc, { status: 'filed', data: { filedAt: this.simNow } })
      case 'annotate': {
        const notes = Array.isArray(doc.data.annotations) ? doc.data.annotations : []
        return this.bump(doc, { data: { annotations: [...notes, { at: this.simNow, text: str(b.text) ?? str(b.note) ?? '' }] } })
      }
    }
    return fail(400, 'Unhandled documentCommand')
  }

  /** visibleTo gains the target site; the discharge summary is refused, as observed live. */
  private shareRecord(b: Record<string, any>): LocalResponse {
    const target = str(b.target)
    if (!target || !isSite(target)) return fail(400, `target must be one of ${LOCAL_SITES.join(', ')}`)
    const t = this.target('share_record', b)
    if ('res' in t) return t.res
    if (t.r.kind === 'discharge-summary') return fail(409, 'Use the document workflow to process this letter')
    const res = this.bump(t.r, { visibleTo: [target], data: { sharedWith: [...new Set([...(t.r.data.sharedWith ?? []), target])] } })
    this.event('record.shared', `${t.r.patientId ?? ''} ${t.r.kind} ${t.r.id} -> ${target}`, { site: target, patientId: t.r.patientId })
    return res
  }

  private linkPrescriptionStock(b: Record<string, any>): LocalResponse {
    const t = this.target('link_prescription_stock', b, ['prescription'])
    if ('res' in t) return t.res
    const rx = t.r
    if (rx.status !== 'approved') return fail(409, `link_prescription_stock needs an approved prescription (${rx.id} is ${rx.status})`)
    const product = str(b.productId) ? this.resources.get(b.productId) : undefined
    if (!product || product.kind !== 'pharmacy-product') return fail(404, `No pharmacy-product with id '${b.productId}'`)
    const quantity = Number(b.quantity)
    if (!Number.isInteger(quantity) || quantity <= 0) return fail(400, 'quantity must be a positive whole number of units')
    if (Number(product.data.stock) < quantity) return fail(409, `Insufficient stock: ${product.data.stock} units of ${product.data.drug}, ${quantity} requested`)
    product.data.stock = Number(product.data.stock) - quantity
    product.version++
    product.updatedAt = this.simNow
    const res = this.bump(rx, { status: 'linked', data: { productId: product.id, quantity, linkedAt: this.simNow } })
    this.event('pharmacy.stock.linked', `${rx.patientId}: ${quantity} x ${product.data.drug} reserved`, { site: 'pharmacy', patientId: rx.patientId })
    return res
  }

  private prescriptionStep(b: Record<string, any>, from: string, to: string): LocalResponse {
    const type = to === 'dispensed' ? 'dispense' : 'collect'
    const t = this.target(type, b, ['prescription'])
    if ('res' in t) return t.res
    if (t.r.status !== from) return fail(409, `${type} needs a ${from} prescription (${t.r.id} is ${t.r.status})`)
    const res = this.bump(t.r, { status: to, data: { [`${to}At`]: this.simNow } })
    this.event(`pharmacy.prescription.${to}`, `${t.r.patientId}: ${t.r.data.drug ?? t.r.title}`, { site: 'pharmacy', patientId: t.r.patientId })
    return res
  }

  private verb(type: string, b: Record<string, any>): LocalResponse {
    const t = this.target(type, b)
    if ('res' in t) return t.res
    return this.bump(t.r, { status: VERB_STATUS[type], data: { [`${VERB_STATUS[type]}At`]: this.simNow } })
  }

  private createSession(site: LocalSite, b: Record<string, any>): LocalResponse {
    const missing = ['clinician', 'location', 'startsAt', 'endsAt', 'slotMinutes', 'mode'].filter((k) => b[k] === undefined || b[k] === null || b[k] === '')
    if (missing.length) return fail(400, `Missing required fields: ${missing.join(', ')}`, { missing })
    const startsAt = Number(b.startsAt), endsAt = Number(b.endsAt), slotMinutes = Number(b.slotMinutes)
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) return fail(400, 'startsAt and endsAt must be epoch milliseconds with endsAt after startsAt')
    if (!Number.isInteger(slotMinutes) || slotMinutes < 5) return fail(400, 'slotMinutes must be a whole number of at least 5')
    if (!['in-person', 'telephone', 'video'].includes(b.mode)) return fail(400, 'mode must be in-person, telephone or video')
    const session = this.put({
      kind: 'appointment-session', status: 'open', title: str(b.title) ?? `${b.clinician} (${b.mode})`, visibleTo: [site],
      data: { clinician: b.clinician, location: b.location, startsAt, endsAt, slotMinutes, mode: b.mode, blockedSlots: [] },
    })
    return this.created(session)
  }

  private bookAppointment(site: LocalSite, b: Record<string, any>): LocalResponse {
    const bad = this.requirePatient(b)
    if (bad) return bad
    if (!str(b.sessionId)) return fail(400, 'sessionId is required')
    const session = this.resources.get(b.sessionId)
    if (!session || session.kind !== 'appointment-session') return fail(404, `No appointment-session with id '${b.sessionId}'`)
    if (typeof b.sessionVersion !== 'number') return fail(400, 'sessionVersion is required')
    if (session.version !== b.sessionVersion) return fail(409, `Version conflict: ${session.id} is at version ${session.version}, sessionVersion was ${b.sessionVersion}`, { currentVersion: session.version })
    if (session.status !== 'open') return fail(409, `Session ${session.id} is ${session.status}`)
    const startsAt = Number(b.startsAt)
    const d = session.data
    const step = d.slotMinutes * MIN
    if (!Number.isFinite(startsAt) || startsAt < d.startsAt || startsAt + step > d.endsAt || (startsAt - d.startsAt) % step !== 0) {
      return fail(400, `startsAt must be a ${d.slotMinutes}-minute slot inside the session (${new Date(d.startsAt).toISOString()} to ${new Date(d.endsAt).toISOString()})`)
    }
    if ((d.blockedSlots as Array<{ startsAt: number }>).some((s) => s.startsAt === startsAt)) return fail(409, 'That slot is blocked')
    const taken = this.all().some((r) => r.kind === 'appointment' && r.status === 'booked' && r.data.sessionId === session.id && r.data.startsAt === startsAt)
    if (taken) return fail(409, 'That slot is already booked')
    const appt = this.put({
      kind: 'appointment', status: 'booked', patientId: b.patientId, title: str(b.title) ?? `Appointment with ${d.clinician}`, visibleTo: [...new Set<LocalSite>([site, 'patient'])],
      data: { mode: d.mode, startsAt, endsAt: startsAt + step, clinician: d.clinician, location: d.location, sessionId: session.id, bookedAt: this.simNow },
    })
    this.event('appointment.booked', `${b.patientId}: ${d.mode} with ${d.clinician} at ${new Date(startsAt).toISOString().slice(0, 16)}`, { site, patientId: b.patientId })
    return this.created(appt)
  }

  private appointmentStatus(b: Record<string, any>, status: 'cancelled' | 'arrived'): LocalResponse {
    const t = this.target(status === 'cancelled' ? 'cancel_appointment' : 'arrive_appointment', b, ['appointment'])
    if ('res' in t) return t.res
    if (t.r.status !== 'booked') return fail(409, `Appointment ${t.r.id} is ${t.r.status}, not booked`)
    const res = this.bump(t.r, { status, data: { [`${status}At`]: this.simNow } })
    this.event(`appointment.${status}`, `${t.r.patientId}: ${t.r.title}`, { patientId: t.r.patientId })
    return res
  }

  private setSlot(b: Record<string, any>): LocalResponse {
    const t = this.target('set_appointment_slot', b, ['appointment-session'])
    if ('res' in t) return t.res
    const startsAt = Number(b.startsAt)
    if (!Number.isFinite(startsAt)) return fail(400, 'startsAt is required')
    const blocked = (t.r.data.blockedSlots as Array<{ startsAt: number; reason?: string }>).filter((s) => s.startsAt !== startsAt)
    if (b.blocked !== false) blocked.push({ startsAt, reason: str(b.reason) ?? 'blocked' })
    return this.bump(t.r, { data: { blockedSlots: blocked } })
  }

  /** Anything else in the enum: stored as a plain resource so nothing the code might send crashes a demo. */
  private generic(site: LocalSite, type: string, b: Record<string, any>): LocalResponse {
    if (str(b.resourceId)) {
      const t = this.target(type, b)
      if ('res' in t) return t.res
      const { type: _type, resourceId: _id, expectedVersion: _v, ...rest } = b
      return this.bump(t.r, { data: { lastAction: type, ...rest } })
    }
    if (b.patientId !== undefined) {
      const bad = this.requirePatient(b)
      if (bad) return bad
    }
    const [kind, status] = GENERIC_KIND[type] ?? [type.replace(/_/g, '-'), 'open']
    const { type: _type, patientId, title, ...rest } = b
    const r = this.put({ kind, status, patientId, title: str(title) ?? type.replace(/_/g, ' '), visibleTo: [site], data: { ...rest, action: type, site } })
    return this.created(r)
  }
}
