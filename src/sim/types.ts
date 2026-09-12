/**
 * Types for the NHS-SIM API, derived from the handbook quickstart and the
 * API explorer listing. Fields the docs do not spell out are typed loosely
 * (index signatures) so responses can be inspected without casting. Tighten
 * these against /api/openapi.json once the schema has been checked.
 */

/** Service workspaces exposed under /api/sites/{site}. */
export type Site =
  | 'control'
  | 'gp'
  | 'hospital'
  | 'community'
  | 'pharmacy'
  | 'diagnostics'
  | 'referrals'
  | 'wearables'
  | 'patient'

/** NHS-shaped adapters exposed under /api/nhs/{adapter}. */
export type NhsAdapter =
  | 'pds'
  | 'ods'
  | 'dos'
  | 'ers'
  | 'eps'
  | 'eps-tracker'
  | 'gp-connect'
  | 'mesh'
  | 'scr'
  | 'pathology'
  | 'radiology'
  | 'appointments'

export const SITES: readonly Site[] = [
  'gp',
  'hospital',
  'community',
  'pharmacy',
  'diagnostics',
  'referrals',
  'wearables',
  'patient',
]

export const NHS_ADAPTERS: readonly NhsAdapter[] = [
  'pds',
  'ods',
  'dos',
  'ers',
  'eps',
  'eps-tracker',
  'gp-connect',
  'mesh',
  'scr',
  'pathology',
  'radiology',
  'appointments',
]

export type Json = Record<string, unknown>

// --- Team -----------------------------------------------------------------

export interface CreateTeamRequest {
  /** Names are lowercased with whitespace removed; the same name returns the same world and key. */
  teamName: string
}

export interface CreateTeamResponse extends Json {
  apiKey: string
}

export interface TeamInfo extends Json {
  scopes?: string[]
}

// --- Patients -------------------------------------------------------------

export interface Patient extends Json {
  /** Synthetic identifier of the form SIM-000001. */
  id?: string
  patientId?: string
}

export interface PatientSearchResponse extends Json {
  items: Patient[]
  total: number
}

// --- Site view and actions ------------------------------------------------

export interface SiteResource extends Json {
  id?: string
  type?: string
  title?: string
  status?: string
  patientId?: string
  /** Optimistic version; send it back when updating a resource. */
  version?: number
}

export interface SiteEvent extends Json {
  id?: string
  type?: string
  at?: string
}

export interface SiteView extends Json {
  resources: SiteResource[]
  events?: SiteEvent[]
}

/**
 * A scoped clinical or operational action. `create_task` is documented in the
 * quickstart; other action types are listed per site in the API guide.
 */
export interface SiteAction extends Json {
  type: string
  patientId?: string
  title?: string
  /** Optimistic version of the resource being changed, where applicable. */
  version?: number
}

export interface CreateTaskAction extends SiteAction {
  type: 'create_task'
  patientId: string
  title: string
}

export interface SiteActionResult extends SiteResource {
  id: string
  status: string
}

// --- Simulation clock -----------------------------------------------------

export interface ClockState extends Json {
  events?: SiteEvent[]
}

/**
 * Body for POST /api/clock (confirmed against /api/openapi.json).
 * advanceMinutes is 0..10080 (7 days) per call; time cannot go backwards.
 */
export interface ClockChange extends Json {
  paused?: boolean
  /** 0..3600 simulated seconds per real second. */
  speed?: number
  /** 0..10080 minutes to jump forward. */
  advanceMinutes?: number
}

// --- Wearables (confirmed against live /api/sites/wearables/view) ---------

/** Metrics observed so far; the API may add more. */
export type WearableMetric = 'steps' | 'heart-rate' | 'sleep' | (string & {})

export interface WearableObservationData extends Json {
  metric: WearableMetric
  value: number
  unit: string
  quality?: string
  /** Epoch milliseconds in simulation time. */
  observedAt: number
  /** Personal baseline; only set on derived trend/alert observations. */
  baseline?: number | null
}

export interface WearableObservation extends SiteResource {
  kind: 'observation'
  patientId: string
  data: WearableObservationData
}

export interface WearableDeviceData extends Json {
  battery?: number
  quality?: string
  metric?: WearableMetric
}

export interface WearableDevice extends SiteResource {
  kind: 'device'
  patientId: string
  data: WearableDeviceData
}

// --- Discovery ------------------------------------------------------------

export interface Catalogue extends Json {
  sites?: unknown
  adapters?: unknown
  incidents?: unknown
}

// --- FHIR read-only subsets ----------------------------------------------

export interface FhirBundle<T = Json> extends Json {
  resourceType: 'Bundle'
  total?: number
  entry?: Array<{ resource: T } & Json>
}

export interface FhirResource extends Json {
  resourceType: string
  id?: string
}
