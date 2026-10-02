import {randomBytes, timingSafeEqual} from 'node:crypto'
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http'
import type {Socket} from 'node:net'
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js'

const MAX_BODY_BYTES = 64 * 1024
const MAX_REQUESTS = 8

function loopbackHost(value: string | undefined): boolean {
  if (value === undefined) return false
  try {
    const hostname = new URL(`http://${value}`).hostname
    return hostname === '127.0.0.1' || hostname === '[::1]'
  } catch { return false }
}

function localOrigin(value: string | undefined, port: number): boolean {
  if (value === undefined) return true
  try {
    const origin = new URL(value)
    return origin.protocol === 'http:' && (origin.hostname === '127.0.0.1' || origin.hostname === '[::1]') && origin.port === String(port)
  } catch { return false }
}

function authorized(request: IncomingMessage, token: string): boolean {
  const value = request.headers.authorization
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false
  const supplied = Buffer.from(value.slice(7), 'utf8')
  const expected = Buffer.from(token, 'utf8')
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected)
}

async function parseBody(request: IncomingMessage): Promise<unknown> {
  const declared = request.headers['content-length']
  if (typeof declared === 'string' && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new Error('body')
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += data.byteLength
    if (size > MAX_BODY_BYTES) throw new Error('body')
    chunks.push(new Uint8Array(data))
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown } catch { throw new Error('body') }
}

function bodyPresent(request: IncomingMessage): boolean {
  const length = request.headers['content-length']
  return request.headers['transfer-encoding'] !== undefined || typeof length === 'string' && length !== '0'
}

function reject(response: ServerResponse, status: number): void {
  response.writeHead(status, {'content-type': 'application/json'})
  response.end('{"error":"request_rejected"}')
}

/** Flush the rejection before the HTTP server closes its socket; immediate destroy can reset it. */
function rejectAndClose(request: IncomingMessage, response: ServerResponse, status: number): void {
  if (!request.readableEnded) response.setHeader('Connection', 'close')
  reject(response, status)
}

export async function startLoopbackMcpServer(createMcp: () => Pick<McpServer, 'connect' | 'close'>, requestTimeoutMs = 5000): Promise<{readonly url: string; readonly token: string; close(): Promise<void>}> {
  const token = randomBytes(32).toString('hex')
  const sockets = new Set<Socket>()
  const mcpServers = new Set<Pick<McpServer, 'connect' | 'close'>>()
  let active = 0
  let port = 0
  const listener = (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      if (active >= MAX_REQUESTS) { rejectAndClose(request, response, 503); return }
      active += 1
      let released = false
      const release = () => { if (!released) { released = true; active -= 1 } }
      response.once('finish', release)
      response.once('close', release)
      let timeout: ReturnType<typeof setTimeout> | undefined
      let mcp: Pick<McpServer, 'connect' | 'close'> | undefined
      let cleaned: Promise<void> | undefined
      const cleanup = () => cleaned ??= (async () => {
        if (mcp === undefined) return
        mcpServers.delete(mcp)
        await mcp.close().catch(() => undefined)
      })()
      try {
        timeout = setTimeout(() => { if (!response.writableEnded) reject(response, 408); request.destroy() }, requestTimeoutMs)
        if (!authorized(request, token)) { rejectAndClose(request, response, 401); return }
        if (request.url !== '/mcp' || !loopbackHost(request.headers.host) || !localOrigin(request.headers.origin, port)) { rejectAndClose(request, response, 403); return }
        if (request.method !== 'GET' && request.method !== 'POST' && request.method !== 'DELETE') { rejectAndClose(request, response, 405); return }
        if (request.method !== 'POST' && bodyPresent(request)) { rejectAndClose(request, response, 413); return }
        let body: unknown
        if (request.method === 'POST') {
          const declared = request.headers['content-length']
          if (typeof declared === 'string' && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) { rejectAndClose(request, response, 413); return }
          try { body = await parseBody(request) } catch { rejectAndClose(request, response, 413); return }
        }
        // The SDK's stateless transport is explicitly single-request. A fresh server+transport
        // pair keeps callers from sharing session or request-id state.
        mcp = createMcp()
        const transport = new StreamableHTTPServerTransport({enableJsonResponse: true})
        mcpServers.add(mcp)
        response.once('close', () => { void cleanup() })
        await mcp.connect(transport as Transport)
        if (request.method === 'POST') await transport.handleRequest(request, response, body)
        else await transport.handleRequest(request, response)
        if (request.method !== 'GET') await cleanup()
      } catch { await cleanup(); if (!response.writableEnded) reject(response, 400) }
      finally { if (timeout !== undefined) clearTimeout(timeout) }
    })()
  }
  const http: Server = createServer(listener)
  http.on('connection', socket => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket) }) })
  await new Promise<void>((resolve, reject) => {http.once('error', reject); http.listen(0, '127.0.0.1', resolve)})
  const address = http.address()
  if (address === null || typeof address === 'string') { http.closeAllConnections(); await new Promise<void>(resolve => { http.close(() => resolve()) }); throw new Error('loopback_listen_failed') }
  port = address.port
  let closing: Promise<void> | undefined
  return {url: `http://127.0.0.1:${address.port}/mcp`, token, close: () => closing ??= (async () => {
    await Promise.allSettled([...mcpServers].map(mcp => mcp.close()))
    for (const socket of sockets) socket.destroy()
    http.closeAllConnections()
    await new Promise<void>(resolve => { http.close(() => resolve()) })
  })()}
}
