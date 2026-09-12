/**
 * Minimal HTTP layer for the simulator: bearer auth, JSON bodies, typed errors.
 * Uses the global fetch shipped with Node 22, so there are no dependencies.
 */
import { setDefaultResultOrder } from 'node:dns'

// Some networks resolve the simulator to IPv6 first, and that route stalls on
// POST bodies (small GETs pass, so the sim looks 'up' while every write hangs).
// Preferring IPv4 matches what browsers end up doing and fixes it outright.
setDefaultResultOrder('ipv4first')

export class SimApiError extends Error {
  readonly status: number
  readonly method: string
  readonly url: string
  readonly body: unknown

  constructor(status: number, method: string, url: string, body: unknown) {
    super(`${method} ${url} failed with HTTP ${status}: ${summarise(body)}`)
    this.name = 'SimApiError'
    this.status = status
    this.method = method
    this.url = url
    this.body = body
  }
}

/** The human-readable reason in an error body, falling back to a trimmed dump. */
function messageOf(body: unknown): string {
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>
    for (const k of ['error', 'message', 'detail']) if (typeof o[k] === 'string') return o[k] as string
  }
  return summarise(body)
}

function summarise(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, 300)
  try {
    return JSON.stringify(body).slice(0, 300)
  } catch {
    return String(body)
  }
}

export type Query = Record<string, string | number | boolean | undefined>

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  query?: Query
  body?: unknown
  /** Sent as the Idempotency-Key header. Repeating a request with the same key and payload returns the same result. */
  idempotencyKey?: string
  /** Overrides the client-level bearer token for this call, or pass null for an unauthenticated call. */
  token?: string | null
  headers?: Record<string, string>
  signal?: AbortSignal
  /** Milliseconds before the request aborts. Defaults to SIM_TIMEOUT_MS or 45000. */
  timeoutMs?: number
}

/** One request as seen at the wire: what was sent, where, and what came back. */
export interface TraceEntry {
  at: number
  method: string
  path: string
  /** Site-action type when the body carries one (create_task, dispense, …). */
  action?: string
  idempotencyKey?: string
  status: number
  ok: boolean
  /** Request body, JSON-stringified and truncated — the compliance record. */
  sent?: string
  /** id/status of the resource the sim returned, when present. */
  got?: string
  /** Parsed request body — writes only, so the trace stays small. */
  request?: unknown
  /** Parsed response body — writes only. */
  reply?: unknown
  /** Human-readable reason when the request failed. */
  error?: string
  /** Plain-language intent, filled by orchestrator/trace.ts (e.g. "Dispensed the prescription"). */
  headline?: string
  /** Plain-language result, e.g. "Prescription r-3 · now dispensed · v3". */
  outcome?: string
}

export interface HttpClientOptions {
  origin: string
  token?: string
  fetch?: typeof fetch
  /** Extra headers sent on every request. */
  headers?: Record<string, string>
  /** Called once per request with the full wire record. Never throws. */
  trace?: (entry: TraceEntry) => void
}

export class HttpClient {
  readonly origin: string
  private readonly token?: string
  private readonly fetchImpl: typeof fetch
  private readonly baseHeaders: Record<string, string>

  private readonly trace?: (entry: TraceEntry) => void

  constructor(options: HttpClientOptions) {
    this.origin = options.origin.replace(/\/+$/, '')
    this.token = options.token
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.baseHeaders = options.headers ?? {}
    this.trace = options.trace
  }

  private record(entry: TraceEntry): void {
    try { this.trace?.(entry) } catch { /* tracing must never break a request */ }
  }

  buildUrl(path: string, query?: Query): string {
    const url = new URL(path, this.origin + '/')
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value))
      }
    }
    return url.toString()
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET'
    const url = this.buildUrl(path, options.query)
    const headers: Record<string, string> = { Accept: 'application/json', ...this.baseHeaders, ...options.headers }

    const token = options.token === undefined ? this.token : options.token
    if (token) headers.Authorization = `Bearer ${token}`
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey

    let body: string | undefined
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(options.body)
    }

    const timeoutMs = options.timeoutMs ?? Number(process.env.SIM_TIMEOUT_MS || 45_000)
    const signal = options.signal ?? (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined)
    const tracePath = url.replace(this.origin, '')
    const base = {
      at: Date.now(), method, path: tracePath,
      action: (options.body as { type?: string } | undefined)?.type,
      idempotencyKey: options.idempotencyKey,
      sent: body ? body.slice(0, 500) : undefined,
    }
    let response: Response
    try {
      response = await this.fetchImpl(url, { method, headers, body, signal })
    } catch (err) {
      const reason = String((err as Error).message).slice(0, 160)
      this.record({ ...base, status: 0, ok: false, got: reason, error: reason, request: method === 'GET' ? undefined : options.body })
      if ((err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError') {
        throw new SimApiError(0, method, url, `no response within ${timeoutMs}ms (simulator hung or unreachable)`)
      }
      throw err
    }
    const payload = await parseBody(response)
    const res = payload as { id?: string; status?: string; version?: number } | undefined
    this.record({
      ...base, status: response.status, ok: response.ok,
      // Only a resource reply (id + status/version) is worth summarising; a
      // site view also carries an `id` (the world) and would read as noise.
      got: res && typeof res === 'object' && res.id && (res.status != null || res.version != null)
        ? `${res.id}${res.status != null ? ' ' + res.status : ''}${res.version != null ? ' v' + res.version : ''}`
        : undefined,
      request: method === 'GET' ? undefined : options.body,
      reply: method === 'GET' ? undefined : payload,
      error: response.ok ? undefined : messageOf(payload),
    })
    if (!response.ok) throw new SimApiError(response.status, method, url, payload)
    return payload as T
  }

  get<T = unknown>(path: string, query?: Query, options: Omit<RequestOptions, 'method' | 'query' | 'body'> = {}) {
    return this.request<T>(path, { ...options, method: 'GET', query })
  }

  post<T = unknown>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}) {
    return this.request<T>(path, { ...options, method: 'POST', body })
  }

  put<T = unknown>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}) {
    return this.request<T>(path, { ...options, method: 'PUT', body })
  }

  delete<T = unknown>(path: string, options: Omit<RequestOptions, 'method'> = {}) {
    return this.request<T>(path, { ...options, method: 'DELETE' })
  }
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  const type = response.headers.get('content-type') ?? ''
  if (type.includes('json')) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text
}
