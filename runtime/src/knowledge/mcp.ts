/** A narrow local MCP boundary for read-only knowledge recall. */
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {startLoopbackMcpServer} from '../mcp/http-server.js'
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

/** The same authenticated, bounded loopback boundary serves knowledge and per-task coding grants. */
export function startKnowledgeMcpHttpServer(backend: KnowledgeRecallBackend): ReturnType<typeof startLoopbackMcpServer> {
  return startLoopbackMcpServer(() => createKnowledgeMcpServer(backend))
}
