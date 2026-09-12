/**
 * Types for the NHS-SIM API, derived from the handbook quickstart and the
 * API explorer listing. Fields the docs do not spell out are typed loosely
 * (index signatures) so responses can be inspected without casting. Tighten
 * these against /api/openapi.json once the schema has been checked.
 */

/** Service workspaces exposed under /api/sites/{site}. */
export type Site = 'gp' | 'hospital' | 'pharmacy' | 'patient'

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

export const SITES: readonly Site[] = ['gp', 'hospital', 'pharmacy', 'patient']

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
 * Body for POST /api/clock. The explorer describes it as "pause, change speed
 * or advance the team world"; the exact field names come from the OpenAPI
 * document, so this stays open-ended.
 */
export type ClockChange = Json

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
