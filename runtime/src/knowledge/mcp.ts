/** A narrow local MCP boundary for read-only knowledge recall. */
import {randomBytes, timingSafeEqual} from 'node:crypto'
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http'
import type {Socket} from 'node:net'
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js'
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js'
import {z} from 'zod'
import type {ExecutorAdapter, ExecutorDispatchContext, ExecutorHandoff} from '../core/causal-runtime.js'
import type {JsonValue} from '../core/events.js'
import {executorManifestSchema, opSpecSchema, type ExecutorManifest} from '../core/ports.js'

export const MCP_KNOWLEDGE_EXECUTOR = 'mcp__nova_knowledge'
export const MCP_KNOWLEDGE_RECALL = 'recall'
export const MCP_KNOWLEDGE_GET_CHUNK = 'get_chunk'
const MAX_QUERY_POINTS = 512
const MAX_LOCATOR_POINTS = 256
const MAX_TEXT_POINTS = 600
const MAX_CHUNK_POINTS = 3200
const MAX_METADATA_POINTS = 256
const MAX_QUERY_UNITS = MAX_QUERY_POINTS * 4
const MAX_LOCATOR_UNITS = MAX_LOCATOR_POINTS * 4
const MAX_BODY_BYTES = 64 * 1024
const MAX_REQUESTS = 8
const REQUEST_TIMEOUT_MS = 5000
const credentialLike = /(?:\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|credential)\b\s*(?:=|:)|-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----)/iu
const opaqueLocator = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u
const knowledgeLocator = /^knowledge:\/\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\?d=[a-f0-9]{12}$/u
const rawSourcePath = /(?:^|[\s"'])(?:\/|[A-Za-z]:[\\/])/u

export interface KnowledgeRecallHit {
  readonly locator: string
  readonly source_id: string
  readonly title: string
  readonly heading_path: string
  readonly text: string
  readonly score: number
}

export interface KnowledgeRecallBackend {
  recall(query: string, k: number, signal?: AbortSignal): Promise<readonly KnowledgeRecallHit[]>
  /** A `stale` result must carry current bounded text, title, and heading_path; callers receive a fixed reindex note. */
  getChunk(locator: string): Promise<{readonly status: 'ok' | 'stale' | 'gone'; readonly text?: string; readonly title?: string; readonly heading_path?: string; readonly source_id?: string}>
}

export const KNOWLEDGE_MCP_MANIFEST: ExecutorManifest = executorManifestSchema.parse({
  name: MCP_KNOWLEDGE_EXECUTOR,
  display_name: 'Knowledge', roles: [], approvals: false, model_visibility: 'direct', probe_policy: 'none',
  ops: [opSpecSchema.parse({
    name: MCP_KNOWLEDGE_RECALL, description: '检索本地知识库。',
    params: {type: 'object', properties: {
      query: {type: 'string', minLength: 1, maxLength: MAX_QUERY_POINTS},
      k: {type: 'integer', minimum: 1, maximum: 5, default: 3},
    }, required: ['query'], additionalProperties: false},
    readonly: true, sync_result: true, deadline_budget: 7,
  })],
  policy: {channel: MCP_KNOWLEDGE_EXECUTOR, priority: 40, wake: 'surrogate', typical_latency: 0.1, compress_watermark: 400},
})

function points(value: string): number { return Array.from(value).length }

function safeOutputText(value: unknown, limit: number): string | null {
  return typeof value === 'string' && value.length > 0 && points(value) <= limit
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    && !credentialLike.test(value) && !rawSourcePath.test(value) ? value : null
}

function safeLocator(value: unknown): string | null {
  return typeof value === 'string' && value.length <= MAX_LOCATOR_UNITS && points(value) <= MAX_LOCATOR_POINTS
    && (opaqueLocator.test(value) || knowledgeLocator.test(value)) && !credentialLike.test(value) ? value : null
}

function recallArgs(value: unknown): {readonly query: string; readonly k: number} | null {
  if (!plain(value) || Object.keys(value).some(key => key !== 'query' && key !== 'k')) return null
  // Query sensitivity belongs to the embedding provider's pre-embedding gate. This MCP boundary
  // only preserves its schema contract, so users can ask about paths or paste multiline text.
  const query = typeof value.query === 'string' && value.query.length > 0 && value.query.length <= MAX_QUERY_UNITS && points(value.query) <= MAX_QUERY_POINTS ? value.query : null
  const k = value.k === undefined ? 3 : value.k
  return query !== null && typeof k === 'number' && Number.isInteger(k) && k >= 1 && k <= 5 ? {query, k} : null
}

function chunkArgs(value: unknown): {readonly locator: string} | null {
  if (!plain(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'locator')) return null
  const locator = safeLocator(value.locator)
  return locator === null ? null : {locator}
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
}

function safeHit(value: unknown, textLimit = MAX_TEXT_POINTS): KnowledgeRecallHit | null {
  if (!plain(value) || (Object.keys(value).length !== 6 && !(Object.keys(value).length === 7 && typeof value.evidence_id === 'string'))) return null
  const locator = safeLocator(value.locator)
  const source_id = safeLocator(value.source_id)
  const title = safeOutputText(value.title, MAX_METADATA_POINTS)
  const heading_path = safeOutputText(value.heading_path, MAX_METADATA_POINTS)
  const text = safeOutputText(value.text, textLimit)
  return locator !== null && source_id !== null && title !== null && heading_path !== null && text !== null
    && typeof value.score === 'number' && Number.isFinite(value.score)
    ? {locator, source_id, title, heading_path, text, score: value.score} : null
}

function safeHits(value: unknown): readonly KnowledgeRecallHit[] | null {
  if (!Array.isArray(value) || value.length > 5) return null
  const hits = value.map(hit => safeHit(hit))
  return hits.some(hit => hit === null) ? null : hits as KnowledgeRecallHit[]
}

function jsonHits(hits: readonly KnowledgeRecallHit[]): JsonValue[] {
  return hits.map(hit => ({locator: hit.locator, source_id: hit.source_id, title: hit.title,
    heading_path: hit.heading_path, text: hit.text, score: hit.score}))
}

function toolResult(payload: Record<string, JsonValue>): CallToolResult {
  return {content: [{type: 'text', text: JSON.stringify(payload)}], structuredContent: payload}
}

function toolError(code: 'invalid_params' | 'unavailable' | 'cancelled'): CallToolResult {
  return {isError: true, content: [{type: 'text', text: code}]}
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key))
}

function safeChunk(value: unknown, locator: string): Record<string, JsonValue> | null {
  if (!plain(value) || !Object.hasOwn(value, 'status') || typeof value.status !== 'string') return null
  if (value.status === 'gone') {
    if (!exactKeys(value, ['status'], ['title'])) return null
    if (!Object.hasOwn(value, 'title')) return {trust: 'untrusted_external', status: 'gone'}
    const title = safeOutputText(value.title, MAX_METADATA_POINTS)
    return title === null ? null : {trust: 'untrusted_external', status: 'gone', title}
  }
  if (value.status !== 'ok' && value.status !== 'stale' || !exactKeys(value, ['status', 'text', 'title', 'heading_path'], ['source_id'])) return null
  const text = safeOutputText(value.text, MAX_CHUNK_POINTS)
  const title = safeOutputText(value.title, MAX_METADATA_POINTS)
  const heading_path = safeOutputText(value.heading_path, MAX_METADATA_POINTS)
  if (text === null || title === null || heading_path === null) return null
  const source_id = Object.hasOwn(value, 'source_id') ? safeLocator(value.source_id) : undefined
  if (Object.hasOwn(value, 'source_id') && source_id === null) return null
  return {trust: 'untrusted_external', status: value.status, locator, title, heading_path, text,
    ...(source_id === undefined ? {} : {source_id}), ...(value.status === 'stale' ? {note: 'source_reindexed'} : {})}
}

async function recall(backend: KnowledgeRecallBackend, input: unknown, signal: AbortSignal): Promise<CallToolResult> {
  const args = recallArgs(input)
  if (args === null) return toolError('invalid_params')
  if (signal.aborted) return toolError('cancelled')
  try {
    const hits = safeHits(await backend.recall(args.query, args.k, signal))
    return signal.aborted ? toolError('cancelled') : hits === null ? toolError('unavailable')
      : toolResult({trust: 'untrusted_external', hits: jsonHits(hits)})
  } catch { return signal.aborted ? toolError('cancelled') : toolError('unavailable') }
}

export function createKnowledgeMcpServer(backend: KnowledgeRecallBackend): McpServer {
  const server = new McpServer({name: 'nova-knowledge', version: '0.2.0'})
  server.registerTool(MCP_KNOWLEDGE_RECALL, {
    description: '检索本地知识库。',
    inputSchema: z.object({query: z.string().min(1).max(MAX_QUERY_UNITS), k: z.number().int().min(1).max(5).optional()}).strict(), annotations: {readOnlyHint: true},
  }, async (input, extra) => {
    return recall(backend, input, extra.signal)
  })
  server.registerTool(MCP_KNOWLEDGE_GET_CHUNK, {
    description: '读取已检索知识片段。', inputSchema: z.object({locator: z.string().min(1).max(MAX_LOCATOR_UNITS)}).strict(), annotations: {readOnlyHint: true},
  }, async input => {
    const args = chunkArgs(input)
    if (args === null) return toolError('invalid_params')
    try {
      const chunk = safeChunk(await backend.getChunk(args.locator), args.locator)
      return chunk === null ? toolError('unavailable') : toolResult(chunk)
    } catch { return toolError('unavailable') }
  })
  return server
}

function handoffFailure(code: string, outcome: ExecutorHandoff['outcome'] = 'failed'): ExecutorHandoff {
  return {outcome, trust: 'untrusted_external', content: {error: code}}
}

function handoffResult(raw: unknown): ExecutorHandoff | null {
  if (!plain(raw) || raw.isError === true || !plain(raw.structuredContent)) return null
  const payload = raw.structuredContent
  if (payload.trust !== 'untrusted_external' || Object.keys(payload).length !== 2) return null
  const hits = safeHits(payload.hits)
  return hits === null ? null : {outcome: 'ok', trust: 'untrusted_external', content: {trust: 'untrusted_external', hits: jsonHits(hits)}}
}

/** Internal calls share the HTTP tool's validation; backend ownership stays outside the adapter. */
export class KnowledgeMcpAdapter implements ExecutorAdapter {
  readonly manifest = KNOWLEDGE_MCP_MANIFEST
  #lifecycle = new AbortController()

  constructor(readonly backend: KnowledgeRecallBackend) {}

  connect(): Promise<void> {
    if (this.#lifecycle.signal.aborted) this.#lifecycle = new AbortController()
    return Promise.resolve()
  }

  close(): Promise<void> { this.#lifecycle.abort(); return Promise.resolve() }

  async dispatch(op: string, request: Readonly<Record<string, JsonValue>>, context: ExecutorDispatchContext): Promise<ExecutorHandoff> {
    if (op !== MCP_KNOWLEDGE_RECALL) return handoffFailure('unknown_op', 'refused')
    const args = recallArgs(request)
    if (args === null) return handoffFailure('invalid_params', 'refused')
    if (context.signal.aborted) return handoffFailure('cancelled', 'cancelled')
    const connected = this.connect()
    const lifecycle = this.#lifecycle.signal
    await connected
    const signal = AbortSignal.any([context.signal, lifecycle])
    let abort!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(new Error('cancelled')) })
    signal.addEventListener('abort', abort, {once: true})
    try {
      signal.throwIfAborted()
      const result = await Promise.race([recall(this.backend, args, signal), cancelled])
      if (context.signal.aborted) return handoffFailure('cancelled', 'cancelled')
      if (signal.aborted) return handoffFailure('knowledge_mcp_unavailable')
      return handoffResult(result) ?? handoffFailure('knowledge_mcp_invalid_result')
    } catch { return context.signal.aborted ? handoffFailure('cancelled', 'cancelled') : handoffFailure('knowledge_mcp_unavailable') }
    finally { signal.removeEventListener('abort', abort) }
  }
}

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

export async function startKnowledgeMcpHttpServer(backend: KnowledgeRecallBackend): Promise<{readonly url: string; readonly token: string; close(): Promise<void>}> {
  const token = randomBytes(32).toString('hex')
  const sockets = new Set<Socket>()
  const mcpServers = new Set<McpServer>()
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
      let mcp: McpServer | undefined
      let cleaned: Promise<void> | undefined
      const cleanup = () => cleaned ??= (async () => {
        if (mcp === undefined) return
        mcpServers.delete(mcp)
        await mcp.close().catch(() => undefined)
      })()
      try {
        timeout = setTimeout(() => { if (!response.writableEnded) reject(response, 408); request.destroy() }, REQUEST_TIMEOUT_MS)
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
        mcp = createKnowledgeMcpServer(backend)
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
