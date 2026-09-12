/**
 * In-memory stand-in for the simulator, shared by the orchestrator tests.
 *
 * It behaves like the real thing in the ways the orchestrator relies on:
 * site views are plain resource arrays, every action returns the created or
 * updated resource with a bumped version, created resources land in the
 * owning site's view, `process_document send` copies the summary into the GP
 * documents feed, and the clock only moves when advanceClock is called.
 *
 * Tests hold the `views` reference and may mutate it to simulate the world
 * moving on (a visit completing, a lab resulting) — usually from `onAdvance`.
 */
import type { SimClient } from '../../src/sim/index.ts'

/** Sim time the demo cohort is deemed medically fit; matches the invariant tests. */
export const FIT = 1789200000000

export interface Write {
  site: string
  body: Record<string, any>
  key?: string
}

export interface FakeSimOptions {
  views?: Record<string, any[]>
  gpDocs?: any[]
  patients?: any[]
  appointments?: any[]
  /** Appointment sessions returned with the day's book (siteAppointments). */
  sessions?: any[]
  /** Called after every action with the recorded write and the resource returned. */
  onAction?: (write: Write, resource: any, views: Record<string, any[]>) => void
  /** Called after every clock advance with the new sim time. */
  onAdvance?: (now: number, views: Record<string, any[]>, advances: number) => void
}

const SITE_FOR_CREATE: Record<string, string> = {
  create_task: 'gp',
  order_test: 'diagnostics',
  connect_device: 'wearables',
  schedule_visit: 'community',
  save_discharge_summary: 'hospital',
  create_appointment_session: 'gp',
  book_appointment: 'gp',
  register_attendance: 'hospital',
}
const KIND_FOR_CREATE: Record<string, string> = {
  create_task: 'task',
  order_test: 'order',
  connect_device: 'device',
  schedule_visit: 'visit',
  save_discharge_summary: 'document',
  create_appointment_session: 'appointment-session',
  book_appointment: 'appointment',
  register_attendance: 'hospital-attendance',
}
const INITIAL_STATUS: Record<string, string> = {
  create_task: 'open',
  order_test: 'open',
  connect_device: 'active',
  schedule_visit: 'scheduled',
  save_discharge_summary: 'draft',
  create_appointment_session: 'open',
  book_appointment: 'booked',
  register_attendance: 'waiting',
}
const STATUS_AFTER_UPDATE: Record<string, string> = {
  link_prescription_stock: 'linked',
  dispense: 'dispensed',
  collect: 'collected',
  cancel_appointment: 'cancelled',
}

export function fakeSim(opts: FakeSimOptions = {}) {
  const views: Record<string, any[]> = opts.views ?? {}
  const gpDocs: any[] = opts.gpDocs ?? []
  const writes: Write[] = []
  let now = FIT
  let seq = 100
  let advances = 0

  const findAny = (id: string) => {
    for (const site of Object.keys(views)) {
      const hit = views[site].find((r) => r.id === id)
      if (hit) return { site, hit }
    }
    return undefined
  }

  const sim = {
    clock: async () => ({ now, paused: true, speed: 0, events: [] }),
    advanceClock: async (minutes: number) => {
      now += minutes * 60_000
      advances++
      opts.onAdvance?.(now, views, advances)
      return { now, paused: true, speed: 0, events: [] }
    },
    siteView: async (site: string) => ({ resources: views[site] ?? [], now }),
    gpDocuments: async () => ({ resources: gpDocs, patients: [], now }),
    searchPatients: async (_site: string, q: string) => {
      const items = (opts.patients ?? []).filter((p) => p.id === q)
      return { total: items.length, items }
    },
    wearables: async () => {
      const resources = views.wearables ?? []
      return {
        view: { resources },
        devices: resources.filter((r) => r.kind === 'device'),
        observations: resources.filter((r) => r.kind === 'observation'),
      }
    },
    siteAppointments: async () => ({ appointments: opts.appointments ?? [], sessions: [...(opts.sessions ?? []), ...(views.gp ?? []).filter((r) => r.kind === 'appointment-session')] }),
    siteAction: async (site: string, body: Record<string, any>, key?: string) => {
      const write: Write = { site, body, key }
      writes.push(write)
      let resource: any
      if (body.resourceId) {
        const found = findAny(body.resourceId)
        if (!found) throw new Error(`fake sim: unknown resource ${body.resourceId}`)
        if (body.expectedVersion !== undefined && body.expectedVersion !== found.hit.version) {
          throw new Error(`fake sim: stale version for ${body.resourceId} (expected ${found.hit.version}, got ${body.expectedVersion})`)
        }
        resource = found.hit
        resource.version = (resource.version ?? 1) + 1
        if (body.type === 'process_document' && body.documentCommand === 'send') {
          resource.status = 'sent'
          gpDocs.push({ ...resource })
        } else if (STATUS_AFTER_UPDATE[body.type]) {
          resource.status = STATUS_AFTER_UPDATE[body.type]
        }
      } else {
        const targetSite = SITE_FOR_CREATE[body.type] ?? site
        resource = {
          id: `r-${seq++}`,
          patientId: body.patientId,
          kind: KIND_FOR_CREATE[body.type] ?? body.type,
          title: body.title,
          status: INITIAL_STATUS[body.type] ?? 'open',
          version: 1,
          createdAt: now,
          data: {},
        }
        if (body.type === 'order_test') resource.data = { ...body.bloodTestOrder }
        if (body.type === 'create_appointment_session') resource.data = { mode: body.mode }
        if (body.type === 'book_appointment') {
          const session = [...(opts.sessions ?? []), ...(views.gp ?? [])].find((r) => r.id === body.sessionId)
          resource.data = { mode: session?.data?.mode, startsAt: body.startsAt }
        }
        if (body.type === 'save_discharge_summary') resource.data = { sections: body.dischargeSections }
        ;(views[targetSite] ??= []).push(resource)
      }
      opts.onAction?.(write, resource, views)
      return { ...resource }
    },
    createTask: (site: string, patientId: string, title: string, key?: string) =>
      sim.siteAction(site, { type: 'create_task', patientId, title }, key),
    connectDevice: (patientId: string, title = 'Home activity watch', key?: string) =>
      sim.siteAction('wearables', { type: 'connect_device', patientId, title }, key),
    orderBloodTest: (site: string, patientId: string, title: string, order: Record<string, unknown>, key?: string) =>
      sim.siteAction(site, { type: 'order_test', patientId, title, bloodTestOrder: order }, key),
  }

  return {
    sim: sim as unknown as SimClient,
    views,
    gpDocs,
    writes,
    get now() {
      return now
    },
    get advances() {
      return advances
    },
  }
}

/** The seeded hospital record the brief describes for Amira, in the shape detect.ts reads. */
export function amiraHospitalView(): any[] {
  return [
    { id: 'r-att', kind: 'hospital-attendance', patientId: 'SIM-000001', version: 5, data: { stage: 'inpatient', location: 'AMU bed 12', clinician: 'Dr Ada Sim 0' } },
    { id: 'r-1', kind: 'document', patientId: 'SIM-000001', title: 'Admission note', status: 'filed', version: 1, createdAt: FIT - 3 * 86_400_000, visibleTo: ['hospital'],
      data: { text: 'Fictional case. Blood monitoring requested; home equipment and medication handover not confirmed.' } },
    { id: 'r-3', kind: 'prescription', patientId: 'SIM-000001', title: 'Discharge medication supply', status: 'approved', version: 2, createdAt: FIT - 86_400_000,
      data: { drug: 'Furosemide tablets' } },
    { id: 'r-6', kind: 'message', patientId: 'SIM-000001', title: 'Respiratory: review worsening oxygen requirement', status: 'open', priority: 'urgent', version: 1, createdAt: FIT - 3_600_000,
      data: { text: 'Please review — oxygen requirement rising overnight.' } },
    { id: 'r-7', kind: 'message', patientId: 'SIM-000001', title: 'Discharge & flow: confirm medication handover', status: 'open', priority: 'urgent', version: 1,
      data: { text: 'Confirm medication handover before discharge.' } },
  ]
}

/** Eleanor's community record: a care package stuck on funding. */
export function eleanorCommunityView(): any[] {
  return [
    { id: 'r-44', kind: 'care-package', patientId: 'SIM-000006', title: 'Home care assessment awaiting allocation', status: 'waiting', version: 1, createdAt: FIT - 2 * 86_400_000,
      data: { fundingDecision: 'pending' } },
    { id: 'r-36', kind: 'care-plan', patientId: 'SIM-000006', title: 'Home support not yet arranged', status: 'open', version: 1,
      data: { homeAccessConfirmed: false, carerAvailable: false } },
    { id: 'r-13', kind: 'observation', patientId: 'SIM-000006', title: 'Activity trend below personal baseline', status: 'active', version: 1,
      data: { metric: 'steps', value: 1800, baseline: 4200, unit: 'steps/day' } },
  ]
}
