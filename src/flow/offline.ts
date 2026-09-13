/**
 * A local stand-in for the simulator, for the flow screen when the shared
 * NHS-SIM instance is slow or down. The same engine, the same resolvers and
 * verifiers run against it unchanged; what differs is that every action
 * lands instantly and the outcomes follow the timings verified live in the
 * real simulator: blood results 120 sim-minutes after the order, a home visit
 * completed 90 minutes after scheduling, the first watch reading 10 minutes
 * after connecting, a sent letter in the GP inbox at once, a task on the GP
 * worklist at once. Arrivals are generated locally at about the real rate
 * (~7 an hour) from the same kind of record the simulator's directory carries.
 *
 * It is a simulation of the simulator, and the screen says so.
 */
import type { SimClient } from '../sim/index.ts'
import { seededRandom } from '../story/baseline.ts'

const MIN = 60_000
const DAY = 24 * 60 * MIN

/** Remove the entries a predicate selects, in place. */
const prune = <T>(xs: T[], gone: (x: T) => boolean) => { let w = 0; for (const x of xs) if (!gone(x)) xs[w++] = x; xs.length = w }

const FIRST = ['Amira', 'Grace', 'Thomas', 'Eleanor', 'Mohammed', 'Sofia', 'George', 'Aisha', 'Oliver', 'Priya', 'Daniel', 'Fatima', 'Harry', 'Zara', 'Leo', 'Maya',
  'Isaac', 'Nadia', 'Samuel', 'Chloe', 'Yusuf', 'Hannah', 'Arjun', 'Ella', 'Kwame', 'Lily', 'Tariq', 'Ruby', 'Jacob', 'Anika', 'Ravi', 'Freya', 'Adam', 'Daisy', 'Oscar', 'Clara']
const LAST = ['Khan', 'Okafor', 'Reed', 'Chen', 'Ali', 'Williams', 'Evans', 'Patel', 'Watson', 'Sharma', 'Hughes', 'Begum', 'Taylor', 'Ahmed', 'Murphy', 'Nowak',
  'Holmes', 'Fox', 'Marshall', 'Collins', 'James', 'Thompson', 'Osei', 'Kaur', 'Baker', 'Singh', 'Roberts', 'Hussain', 'Wright', 'Mensah', 'Green', 'Ibrahim']
const CONDITIONS = ['Hypertension', 'Type 2 diabetes', 'Heart failure', 'COPD', 'Asthma', 'CKD', 'Frailty', 'Atrial fibrillation', 'Osteoarthritis', 'Depression']
const NEEDS = ['Home visit', 'Carer involvement', 'Step-free access', 'telephone preferred', 'Early appointment', 'Offline contact', 'Interpreter', 'letter preferred']
const GOALS = ['Avoid unnecessary travel', 'Stay at home with a clear contact for help', 'Know which team is visiting and when',
  'Arrange follow-up without losing a full day of work', 'Keep follow-up connected between home and study', 'Get back to the garden']
const COMPLAINTS = ['Breathlessness', 'Chest pain', 'Fall at home', 'Abdominal pain', 'Dizziness', 'Wheeze', 'Confusion', 'Head injury', 'Reduced mobility', 'Fever']

interface Rec { id: string; kind: string; status: string; patientId?: string; version: number; createdAt: number; data: Record<string, any>; visibleTo?: string[]; title?: string }

export interface OfflineSim extends SimClient {
  /** Local simulated clock (unix ms). */
  readonly nowMs: number
}

/** Build the stand-in. `seed` makes the run reproducible. */
export function offlineSim(seed = 'offline', startAt = 1789200000000, arrivalsPerHour = 7): OfflineSim {
  const rand = seededRandom(seed)
  let now = startAt
  let seq = 1
  const nextId = (prefix: string) => `${prefix}-${seq++}`
  const attendances: Rec[] = []
  const patients: Record<string, any> = {}
  const resources: Rec[] = [] // everything else, keyed by kind/patient
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]
  const some = <T>(xs: T[], n: number) => { const out: T[] = []; for (let i = 0; i < n; i++) { const x = pick(xs); if (!out.includes(x)) out.push(x) }; return out }

  const arrive = () => {
    // A fresh directory id; a draw that collides with someone already known is redrawn, never dropped.
    let pid = ''
    for (let i = 0; i < 20 && (!pid || patients[pid]); i++) pid = `SIM-${String(100000 + Math.floor(rand() * 899999)).padStart(6, '0')}`
    if (patients[pid]) return
    const acuity = rand() < 0.15 ? '2' : '3'
    const conds = some(CONDITIONS, 1 + Math.floor(rand() * 2))
    patients[pid] = { id: pid, name: `${pick(FIRST)} ${pick(LAST)}`, conditions: conds, needs: some(NEEDS, Math.floor(rand() * 3)), goals: some(GOALS, 1 + Math.floor(rand() * 2)), synthetic: true }
    attendances.push({
      id: nextId('att'), kind: 'hospital-attendance', status: 'open', patientId: pid, version: 1, createdAt: now, title: pick(COMPLAINTS),
      data: { stage: 'waiting', acuity, location: 'Waiting room', arrivalAt: now, presentingComplaint: pick(COMPLAINTS), clinician: 'Unassigned' },
    })
  }
  // A few people already in the department, like the real seed.
  while (attendances.length < 6) arrive()
  attendances[0].data.stage = 'inpatient'; attendances[0].data.location = 'AMU bed 2'; attendances[0].data.acuity = '2'
  attendances[1].data.stage = 'inpatient'; attendances[1].data.location = 'AMU bed 3'
  attendances[2].data.stage = 'take'; attendances[3].data.stage = 'assessing'

  const view = (site: string, patientId?: string) => ({
    resources: resources.filter((r) => (!patientId || r.patientId === patientId) && (r.visibleTo ?? [site]).includes(site)).map(materialise),
  })
  /** Time-dependent status, computed on read. */
  const materialise = (r: Rec): Rec => {
    const d = r.data
    if (r.kind === 'test') return { ...r, status: now >= d.availableAt ? 'available' : 'open', data: { ...d, kind: now >= d.availableAt ? 'blood-result' : 'blood-order' } }
    if (r.kind === 'visit') return { ...r, status: now >= d.completedAt ? 'completed' : 'scheduled' }
    return r
  }

  const sim: any = {
    get nowMs() { return now },
    clock: async () => ({ now, paused: true, speed: 60, events: [] }),
    advanceClock: async (minutes: number) => {
      const expected = (minutes / 60) * arrivalsPerHour
      const n = Math.max(0, Math.round(expected + (rand() - 0.5) * Math.sqrt(expected) * 2))
      now += minutes * MIN
      for (let i = 0; i < n; i++) arrive()
      // Keep the stand-in bounded on a run that lasts all day: the A&E list
      // drops attendances discharged more than a day ago, and service records
      // older than a week (every verifier re-reads within hours).
      prune(attendances, (a) => a.data.stage === 'discharged' && a.data.dischargedAt !== undefined && now - a.data.dischargedAt > DAY)
      prune(resources, (r) => now - r.createdAt > 7 * DAY)
      return { now, paused: true, speed: 60, events: [] }
    },
    hospitalAttendances: async () => ({ resources: attendances.map((a) => ({ ...a, data: { ...a.data } })), patients: [...new Set(attendances.map((a) => a.patientId))].map((id) => patients[id!]), now }),
    siteView: async (site: string, q: { patient?: string } = {}) => view(site, q.patient),
    gpDocuments: async () => ({ resources: resources.filter((r) => r.kind === 'discharge-summary' && r.status === 'sent') }),
    wearables: async (patientId?: string) => {
      const devices = resources.filter((r) => r.kind === 'device' && (!patientId || r.patientId === patientId))
      const observations = devices
        .filter((d) => now >= d.data.connectedAt + 10 * MIN)
        .map((d) => ({ id: `${d.id}-obs`, kind: 'observation', patientId: d.patientId, data: { metric: 'steps', value: 800 + Math.floor(rand() * 3000), unit: 'steps', observedAt: d.data.connectedAt + 10 * MIN } }))
      return { view: {}, devices, observations }
    },
    siteAppointments: async () => ({ appointments: [], sessions: [] }),
    searchPatients: async (_site: string, q: string) => ({ items: patients[q] ? [patients[q]] : [], total: patients[q] ? 1 : 0 }),
    siteAction: async (_site: string, body: any) => {
      if (body.type === 'update_attendance') {
        const a = attendances.find((x) => x.id === body.resourceId)
        if (!a) throw Object.assign(new Error('attendance not found'), { status: 404 })
        if (a.version !== body.expectedVersion) throw Object.assign(new Error('version conflict'), { status: 409 })
        const next: Record<string, string> = { assign: a.data.stage, assess: 'assessing', refer: 'take', admit: 'inpatient', discharge: 'discharged' }
        a.data.stage = next[body.hospitalCommand] ?? a.data.stage
        if (a.data.stage === 'discharged') a.data.dischargedAt = now
        if (body.location) a.data.location = body.location
        if (body.clinician) a.data.clinician = body.clinician
        a.version++
        return { ...a, data: { ...a.data } }
      }
      const base = { patientId: body.patientId, version: 1, createdAt: now, title: body.title }
      let r: Rec | undefined
      if (body.type === 'order_test') r = { ...base, id: nextId('test'), kind: 'test', status: 'open', visibleTo: ['diagnostics', 'hospital'], data: { availableAt: now + 120 * MIN, panel: body.bloodTestOrder?.panel } }
      else if (body.type === 'schedule_visit') r = { ...base, id: nextId('visit'), kind: 'visit', status: 'scheduled', visibleTo: ['community', 'hospital'], data: { completedAt: now + 90 * MIN } }
      else if (body.type === 'connect_device') r = { ...base, id: nextId('device'), kind: 'device', status: 'active', visibleTo: ['wearables'], data: { connectedAt: now, metric: 'steps' } }
      else if (body.type === 'save_discharge_summary') r = { ...base, id: nextId('summary'), kind: 'discharge-summary', status: 'draft', visibleTo: ['hospital'], data: { sections: body.dischargeSections } }
      else if (body.type === 'process_document') {
        const doc = resources.find((x) => x.id === body.resourceId)
        if (!doc) throw Object.assign(new Error('document not found'), { status: 404 })
        // Like the real simulator, an update names the version it expects; a stale one (a summary already sent) is refused.
        if (body.expectedVersion !== undefined && doc.version !== body.expectedVersion) throw Object.assign(new Error('version conflict'), { status: 409 })
        doc.status = body.documentCommand === 'send' ? 'sent' : doc.status
        doc.visibleTo = ['hospital', 'gp']; doc.version++
        return { ...doc }
      }
      else if (body.type === 'create_task') r = { ...base, id: nextId('task'), kind: 'task', status: 'open', visibleTo: ['gp'], data: {} }
      else if (body.type === 'create_appointment_session') r = { ...base, id: nextId('session'), kind: 'appointment-session', status: 'open', visibleTo: ['gp'], data: { mode: body.mode } }
      else if (body.type === 'book_appointment') r = { ...base, id: nextId('appt'), kind: 'appointment', status: 'booked', visibleTo: ['gp'], data: { mode: 'telephone', startsAt: body.startsAt } }
      else r = { ...base, id: nextId('r'), kind: body.type, status: 'ok', visibleTo: [_site], data: {} }
      resources.push(r)
      return { ...r }
    },
  }
  sim.createTask = (site: string, patientId: string, title: string, key?: string, extra = {}) => sim.siteAction(site, { type: 'create_task', patientId, title, ...extra }, key)
  sim.connectDevice = (patientId: string, title = 'Home activity watch', key?: string) => sim.siteAction('wearables', { type: 'connect_device', patientId, title }, key)
  sim.orderBloodTest = (site: string, patientId: string, title: string, order: any, key?: string) => sim.siteAction(site, { type: 'order_test', patientId, title, bloodTestOrder: order }, key)
  return sim as OfflineSim
}
