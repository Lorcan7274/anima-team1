/**
 * The local stand-in over real HTTP (node:http), so the unchanged SimClient,
 * its wire trace, and the sim's request/response shapes all run against it.
 *
 *   const local = await startLocalSim({ port: 0 })       // any free port, loopback only
 *   new SimClient({ origin: local.origin, apiKey })       // exactly as against the shared simulator
 *   await local.close()
 *
 * The demo runner starts one in-process; scripts/local-sim.ts runs one on
 * its own so several runs can share a persistent world.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { LocalSim, type LocalSimOptions } from './api.ts'
import type { LocalRequest } from './world.ts'

export interface StartLocalSimOptions extends LocalSimOptions {
  /** 0 (the default) picks any free port. */
  port?: number
  host?: string
  /** Log one line per request to the console. */
  verbose?: boolean
}

export interface LocalSimServer {
  origin: string
  port: number
  host: string
  api: LocalSim
  server: Server
  close(): Promise<void>
}

export async function startLocalSim(opts: StartLocalSimOptions = {}): Promise<LocalSimServer> {
  const api = new LocalSim(opts)
  const host = opts.host ?? '127.0.0.1'
  const server = createServer((req, res) => {
    readBody(req)
      .then((text) => {
        let body: unknown
        if (text) {
          try { body = JSON.parse(text) } catch { return send(res, 400, { error: 'Request body is not valid JSON' }) }
        }
        const url = new URL(req.url ?? '/', `http://${host}`)
        const query: Record<string, string> = {}
        for (const [k, v] of url.searchParams) query[k] = v
        const headers: Record<string, string | undefined> = {}
        for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v
        const local: LocalRequest = { method: req.method ?? 'GET', path: url.pathname, query, headers, body }
        const out = api.handle(local)
        if (opts.verbose) console.log(`  ${out.status} ${local.method} ${url.pathname}${url.search}${local.method === 'POST' ? ` ${JSON.stringify(body).slice(0, 100)}` : ''}`)
        send(res, out.status, out.body)
      })
      .catch((err) => send(res, 500, { error: String((err as Error).message ?? err) }))
  })
  // Short keep-alive so close() is not held open by idle client sockets.
  server.keepAliveTimeout = 1000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, host, () => { server.off('error', reject); resolve() })
  })
  const port = (server.address() as AddressInfo).port
  return {
    origin: `http://${host}:${port}`,
    port,
    host,
    api,
    server,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { text += chunk })
    req.on('end', () => resolve(text))
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('x-simulator', 'homeward-local-stand-in')
  res.end(JSON.stringify(body ?? null))
}
