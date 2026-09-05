/** MCP is a bounded search transport; SearchAdapter remains the owner of evidence and trust. */
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js'
import type {CallToolResult, Tool} from '@modelcontextprotocol/sdk/types.js'
import {validateMcpEndpoint, type SearchMcpConfig} from '../capability-registry.js'
import {TavilyTransportFailure, type SearchTransport} from './search.js'

export class McpSearchTransport implements SearchTransport {
  readonly provider = 'mcp'
  readonly #active = new Set<{controller: AbortController; done: Promise<void>}>()
  #closed = false
  constructor(readonly config: SearchMcpConfig) { validateMcpEndpoint(config.url, config.headers) }

  async search(query: string, options: {readonly maxResults: number}): Promise<Record<string, unknown>> {
    if (this.#closed) throw new TavilyTransportFailure('transport_closed')
    const controller = new AbortController()
    let settled!: () => void
    const active = {controller, done: new Promise<void>(resolve => { settled = resolve })}
    this.#active.add(active)
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)
    let cleanupSignal: AbortSignal | undefined
    const client = new Client({name: 'nova-search', version: '1'})
    const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
      requestInit: {headers: this.config.headers},
      reconnectionOptions: {maxRetries: 0, maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1},
      fetch: async (url, init) => {
        // Search is request/response only: do not open the SDK's optional background notification stream.
        if (init?.method === 'GET') return new Response(null, {status: 405})
        const signal = AbortSignal.any([cleanupSignal ?? controller.signal, ...(init?.signal ? [init.signal] : [])])
        const response = await fetch(url, {...init, redirect: 'manual', signal})
        if (!response.ok) {
          await response.body?.cancel()
          const code = response.status === 401 || response.status === 403 ? 'authentication'
            : response.status === 429 ? 'rate_limited'
            : response.status >= 300 && response.status < 400 ? 'redirect' : 'upstream'
          throw new TavilyTransportFailure(code)
        }
        if (Number(response.headers.get('content-length')) > this.config.maxResultBytes) {
          await response.body?.cancel()
          throw new TavilyTransportFailure('response_too_large')
        }
        let bytes = 0
        const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform: (chunk, stream) => {
            bytes += chunk.byteLength
            if (bytes > this.config.maxResultBytes) throw new TavilyTransportFailure('response_too_large')
            stream.enqueue(chunk)
          },
        }))
        return new Response(body ?? null, {status: response.status, headers: response.headers})
      },
    })
    try {
      const request = {signal: controller.signal, timeout: this.config.timeoutMs}
      // SDK 1.30 Transport predates exactOptionalPropertyTypes; its concrete transport is structurally compatible at runtime.
      await client.connect(transport as Transport, request)
      let cursor: string | undefined
      let tool: Tool | undefined
      // Discovery pagination is bounded as well as each HTTP response.
      for (let page = 0; page < 8; page += 1) {
        const listed = await client.listTools(cursor === undefined ? {} : {cursor}, request)
        tool = listed.tools.find(item => item.name === this.config.tool)
        if (tool !== undefined || listed.nextCursor === undefined) break
        cursor = listed.nextCursor
      }
      if (tool === undefined) throw new TavilyTransportFailure('search_tool_missing')
      const properties = tool.inputSchema.properties ?? {}
      const queryField = ['query', 'q', 'search_query'].find(field => field in properties) ?? 'query'
      const limitField = ['limit', 'count', 'top_k', 'max_results'].find(field => field in properties)
      const result = await client.callTool({name: this.config.tool, arguments: {
        [queryField]: query, ...(limitField === undefined ? {} : {[limitField]: options.maxResults}),
      }}, undefined, request)
      if (Buffer.byteLength(JSON.stringify(result)) > this.config.maxResultBytes) throw new TavilyTransportFailure('response_too_large')
      return normalizeMcpSearchResult(result as CallToolResult)
    } catch (error) {
      if (controller.signal.aborted) throw new TavilyTransportFailure('timeout')
      if (error instanceof TavilyTransportFailure) throw error
      throw new TavilyTransportFailure('mcp_search_failed')
    } finally {
      // A timed-out call still owns its remote session. Give DELETE a separate bounded cleanup deadline.
      cleanupSignal = AbortSignal.timeout(250)
      try { if (transport.sessionId !== undefined) await transport.terminateSession() } catch { /* redacted */ }
      controller.abort()
      clearTimeout(timer)
      await client.close().catch(() => undefined)
      this.#active.delete(active)
      settled()
    }
  }
  close(): Promise<void> {
    this.#closed = true
    for (const {controller} of this.#active) controller.abort()
    return Promise.all([...this.#active].map(active => active.done)).then(() => undefined)
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function results(value: unknown, depth = 0): unknown[] {
  if (Array.isArray(value)) return value
  const object = record(value)
  if (object === undefined || depth > 8) return []
  for (const key of ['results', 'search_results', 'searchResults', 'items', 'pages']) {
    if (Array.isArray(object[key])) return object[key] as unknown[]
  }
  for (const key of ['result', 'data', 'web']) {
    const nested = results(object[key], depth + 1)
    if (nested.length > 0) return nested
  }
  return []
}
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
export function normalizeMcpSearchResult(result: CallToolResult): Record<string, unknown> {
  if (result.isError) throw new TavilyTransportFailure('search_tool_failed')
  const content = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  let structured: unknown = result.structuredContent
  if (structured === undefined) {
    try { structured = JSON.parse(content) as unknown } catch { /* plain text links below */ }
  }
  const projected = results(structured).flatMap(value => {
    const item = record(value)
    if (item === undefined) return []
    const url = text(item.url) || text(item.link) || text(item.href)
    return url ? [{url, title: text(item.title) || text(item.name) || url,
      content: text(item.snippet) || text(item.description) || text(item.content) || text(item.text) || url}] : []
  })
  if (projected.length > 0) return {results: projected}
  const links = new Map<string, {url: string; title: string; content: string}>()
  const add = (url: string, title: string): void => {
    const cleaned = url.replace(/[.,;:!?]+$/u, '')
    if (!links.has(cleaned)) links.set(cleaned, {url: cleaned, title: title || cleaned, content: content.slice(0, 2000) || cleaned})
  }
  for (const match of content.matchAll(/\[([^\]]{1,300})\]\((https?:\/\/[^)\s]+)\)/giu)) add(match[2]!, match[1]!)
  for (const match of content.matchAll(/https?:\/\/[^\s<>()\]]+/giu)) add(match[0], '')
  return {results: [...links.values()]}
}
