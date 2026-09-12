/**
 * Plain-language layer over the wire trace. Every simulator request the
 * agent makes becomes one line a clinician can read in passing
 * ("Reserved 28 × Furosemide from pharmacy stock") plus what the service
 * replied ("Prescription r-3 · now dispensed · v3"). The raw request and
 * reply stay on the entry for the drop-down; the words never depend on the
 * reader knowing the API.
 */
import type { TraceEntry } from '../sim/http.ts'

type Body = Record<string, unknown>
type Reply = { id?: string; status?: string; version?: number; kind?: string; data?: Body } & Body

const SITE_NAME: Record<string, string> = {
  gp: 'GP practice', hospital: 'hospital', pharmacy: 'pharmacy', community: 'community team',
  diagnostics: 'diagnostics service', wearables: 'home monitoring service', referrals: 'referrals service',
  patient: 'patient app', control: 'simulator',
}

const KIND_LABEL: Record<string, string> = {
  prescription: 'Prescription', order: 'Order', 'blood-order': 'Blood order', device: 'Device', visit: 'Visit',
  document: 'Document', task: 'Task', 'hospital-attendance': 'Attendance', message: 'Message',
}

/** 'pharmacy-product-furosemide' -> 'furosemide'; 'link_prescription_stock' -> 'link prescription stock'. */
const words = (s: unknown) => String(s ?? '').replace(/^pharmacy-product-/, '').replace(/[_-]+/g, ' ').trim()
const capital = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const service = (site: string) => SITE_NAME[site] ?? site

/** What the agent set out to do with a site action, in words a clinician would use. */
export function headlineFor(site: string, body: Body, reply?: Reply): string {
  const t = str(body.type) ?? ''
  const title = str(body.title)
  switch (t) {
    case 'link_prescription_stock': {
      const drug = str(reply?.data?.drug) ?? (words(body.productId) || 'the prescribed medicine')
      const qty = body.quantity != null ? `${body.quantity} × ` : ''
      return `Reserved ${qty}${drug} from pharmacy stock`
    }
    case 'dispense': return 'Dispensed the prescription'
    case 'collect': return 'Recorded the medicines as collected'
    case 'review': return 'Sent the prescription for pharmacist review'
    case 'accept': return 'Accepted the prescription'
    case 'order_test': {
      const o = (body.bloodTestOrder ?? {}) as Body
      const panel = str(o.panel) ?? title ?? 'a test'
      const pr = str(o.priority)
      return `Ordered ${panel}${pr ? ` (${pr})` : ''}`
    }
    case 'connect_device': return `Issued a ${(title ?? 'home monitoring device').toLowerCase()}`
    case 'schedule_visit': return `Booked ${title ? `"${title}"` : 'a community visit'}`
    case 'save_discharge_summary': {
      const n = Object.keys((body.dischargeSections ?? {}) as Body).length
      return `Drafted the discharge summary${n ? ` (${n} sections)` : ''}`
    }
    case 'process_document': {
      const cmd = str(body.documentCommand) ?? 'processed'
      if (cmd === 'send') return 'Sent the discharge summary to the GP'
      return `${capital(cmd)} the document`
    }
    case 'create_task': return `Asked the ${service(site)} to: ${title ?? 'follow up'}`
    case 'share_record': return `Shared the record with ${words(body.target ?? body.site) || 'another service'}`
    case 'register_attendance': return `Registered a hospital attendance${title ? `: ${title}` : ''}`
    case 'update_attendance': {
      const cmd = str(body.hospitalCommand) ?? 'updated'
      const where = str(body.location)
      const HOSP: Record<string, string> = {
        assign: 'Assigned a clinician', assess: 'Marked as being assessed', refer: 'Referred to the take',
        admit: `Admitted${where ? ` to ${where}` : ''}`, discharge: 'Discharged from hospital',
      }
      return HOSP[cmd] ?? `${capital(cmd)} the attendance`
    }
    case 'messaging_action': return 'Sent a message'
    default: return capital(words(t)) || `Acted in the ${service(site)}`
  }
}

/** What the service replied, in words: "Prescription r-3 · now dispensed · v3". */
export function outcomeFor(body: Body, reply: Reply | undefined, ok: boolean, httpStatus?: number, error?: string): string {
  if (!ok) {
    const reason = error ?? summarise(reply)
    return `Failed${httpStatus ? ` (HTTP ${httpStatus})` : ''}${reason ? `: ${reason}` : ''}`
  }
  if (!reply || typeof reply !== 'object') return 'Accepted by the service'
  const kind = KIND_LABEL[str(reply.kind) ?? ''] ?? KIND_LABEL[kindFromType(str(body.type))] ?? 'Record'
  const parts = [reply.id ? `${kind} ${reply.id}` : kind]
  if (reply.status) parts.push(`now ${reply.status}`)
  if (reply.version != null) parts.push(`v${reply.version}`)
  return parts.join(' · ')
}

function kindFromType(t?: string): string {
  if (!t) return ''
  if (/prescription|dispense|collect|accept|review/.test(t)) return 'prescription'
  if (t === 'order_test') return 'order'
  if (t === 'connect_device') return 'device'
  if (t === 'schedule_visit') return 'visit'
  if (/document|summary|share_record/.test(t)) return 'document'
  if (t === 'create_task') return 'task'
  if (/attendance/.test(t)) return 'hospital-attendance'
  return ''
}

function summarise(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v.slice(0, 200)
  const o = v as Body
  const msg = str(o.error) ?? str(o.message) ?? str(o.detail)
  if (msg) return msg.slice(0, 200)
  try { return JSON.stringify(v).slice(0, 200) } catch { return String(v) }
}

const ACTIONS = /^\/api\/sites\/([^/]+)\/actions$/

/** A read or a clock call, in words. Returns undefined for anything unrecognised. */
function readHeadline(method: string, path: string, query: URLSearchParams, body: Body): string | undefined {
  const m = /^\/api\/sites\/([^/]+)\/(.+)$/.exec(path)
  if (m) {
    const [, site, rest] = m
    const who = query.get('patient') ?? query.get('q')
    if (rest === 'view') return `Read the ${service(site)}'s records${who ? ` for ${who}` : ''}`
    if (rest === 'patients') return `Looked up ${who ?? 'a patient'} in the directory`
    if (rest === 'documents') return `Read the ${service(site)}'s documents`
    if (rest === 'attendances') return `Read the ${service(site)}'s attendances`
    if (rest === 'appointments') return `Read the ${service(site)}'s appointments`
    if (rest.endsWith('-workspace')) return `Read the ${service(site)}'s workspace`
    return `Read the ${service(site)} (${rest})`
  }
  if (path === '/api/clock') {
    if (method === 'GET') return 'Read the sim clock'
    const mins = body.advanceMinutes
    return mins != null && Number(mins) > 0 ? `Moved the sim clock forward ${mins} minutes` : 'Changed the sim clock'
  }
  if (path === '/api/keys') return 'Joined the simulator world'
  if (path === '/api/team') return 'Checked the team key'
  return undefined
}

/**
 * Fill `headline` and `outcome` on a wire-trace entry. Site actions get the
 * clinical wording; reads and clock calls get a short description; anything
 * else falls back to method + path so nothing is ever blank.
 */
export function annotate(t: TraceEntry): TraceEntry {
  const [pathname, qs = ''] = t.path.split('?')
  const query = new URLSearchParams(qs)
  const body = (t.request ?? {}) as Body
  const reply = t.reply as Reply | undefined
  const action = ACTIONS.exec(pathname)
  if (action && t.method === 'POST') {
    t.headline = headlineFor(action[1], body, t.ok ? reply : undefined)
    t.outcome = outcomeFor(body, reply, t.ok, t.status, t.error)
    return t
  }
  t.headline = readHeadline(t.method, pathname, query, body) ?? `${t.method} ${pathname}`
  t.outcome = t.ok ? undefined : `Failed${t.status ? ` (HTTP ${t.status})` : ''}${t.error ? `: ${t.error}` : ''}`
  return t
}
