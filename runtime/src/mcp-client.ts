/** Shared bounded MCP I/O. No server error text or resolved configuration leaves this boundary. */
import {AsyncLocalStorage} from 'node:async_hooks'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {getDefaultEnvironment, StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js'
import {ListToolsResultSchema, type CallToolResult, type Tool} from '@modelcontextprotocol/sdk/types.js'
import {validateMcpEndpoint, type McpServerConfig} from './capability-registry.js'

const DISCOVERY_BYTES = 1024 * 1024
const STARTUP_MS = 15_000
export class McpFailure extends Error {
  constructor(readonly code: string) { super(code); this.name = 'McpFailure' }
}

export async function boundedMcpFetch(
  url: string | URL | Request,
  init: RequestInit | undefined,
  options: {readonly signal: AbortSignal; readonly maxBytes: number; readonly failure: (code: string) => Error; readonly stillWanted?: () => boolean; readonly authorizationStatus?: boolean},
): Promise<Response> {
  // No unsolicited notification stream, reconnect, auth discovery or redirect to another origin.
  if (init?.method === 'GET') return new Response(null, {status: 405})
  const signal = AbortSignal.any([options.signal, ...(init?.signal ? [init.signal] : [])])
  signal.throwIfAborted()
  if (options.stillWanted !== undefined && !options.stillWanted()) throw options.failure('stale_user_origin')
  const response = await fetch(url, {...init, redirect: 'manual', signal})
  if (!response.ok) {
    await response.body?.cancel()
    throw options.failure(options.authorizationStatus && response.status === 401 ? 'unauthorized' : options.authorizationStatus && response.status === 403 ? 'forbidden' : response.status === 401 || response.status === 403 ? 'authentication'
      : response.status === 429 ? 'rate_limited'
      : response.status >= 300 && response.status < 400 ? 'redirect' : 'upstream')
  }
  if (Number(response.headers.get('content-length')) > options.maxBytes) {
    await response.body?.cancel()
    throw options.failure('response_too_large')
  }
  let bytes = 0
  const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform: (chunk, stream) => {
      bytes += chunk.byteLength
      if (bytes > options.maxBytes) throw options.failure('response_too_large')
      stream.enqueue(chunk)
    },
  }))
  return new Response(body ?? null, {status: response.status, headers: response.headers})
}

interface RequestScope {
  readonly signal: AbortSignal
  readonly maxBytes: number
  readonly stillWanted?: () => boolean
}

export class McpConnection {
  readonly #client = new Client({name: 'nova-external-mcp', version: '1'})
  readonly #scope = new AsyncLocalStorage<RequestScope>()
  readonly #lifetime = new AbortController()
  readonly #transport: StdioClientTransport | StreamableHTTPClientTransport
  #closing: Promise<void> | undefined
  #closed = false
  constructor(config: McpServerConfig, onFailure?: (code: string) => void, options?: {readonly trustedLoopback?: boolean}) {
    if (config.transport === 'stdio') {
      // SDK 1.30 always adds its platform allowlist, even with env: {}. Keep that exact safe
      // HOME/PATH (Windows system paths) policy; no ambient credentials, NODE_OPTIONS or proxies.
      const transport = new StdioClientTransport({command: config.command!, args: [...config.args ?? []],
        env: {...getDefaultEnvironment(), ...config.env}, stderr: 'pipe', maxBufferSize: DISCOVERY_BYTES + 65536})
      transport.stderr?.on('data', () => undefined) // A server may print secrets. Drain without logging or retaining them.
      this.#transport = transport
    } else {
      const target = new URL(config.url!)
      if (!(options?.trustedLoopback && target.protocol === 'http:' && target.hostname === '127.0.0.1'
        && !target.username && !target.password && !target.hash)) validateMcpEndpoint(config.url!, config.headers)
      this.#transport = new StreamableHTTPClientTransport(new URL(config.url!), {
        requestInit: {headers: config.headers ?? {}},
        reconnectionOptions: {maxRetries: 0, maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1},
        fetch: (url, init) => {
          const scope = this.#scope.getStore()
          if (scope === undefined) return Promise.reject(new McpFailure('request_scope_missing'))
          return boundedMcpFetch(url, init, {...scope, failure: code => new McpFailure(code), ...(options?.trustedLoopback ? {authorizationStatus: true} : {})})
        },
      })
    }
    // This is adjacent to the SDK's actual stdio write. HTTP also checks at fetch after its
    // asynchronous header preparation. AsyncLocalStorage keeps concurrent calls independent.
    const transport = this.#transport as Transport
    // SDK stdio clears its child handle before async teardown finishes. Concurrent close calls
    // (connect's failure cleanup and our owner) must await the same teardown, not return early.
    const close = transport.close.bind(transport)
    let closing: Promise<void> | undefined
    transport.close = () => closing ??= close()
    const send = transport.send.bind(transport)
    transport.send = (message, options) => {
      const scope = this.#scope.getStore()
      if ('method' in message && message.method === 'tools/call') {
        scope?.signal.throwIfAborted()
        if (scope?.stillWanted !== undefined && !scope.stillWanted()) return Promise.reject(new McpFailure('stale_user_origin'))
      }
      return send(message, options)
    }
    this.#client.onerror = () => undefined
    this.#client.onclose = () => {
      const unexpected = !this.#closed
      this.#closed = true; this.#lifetime.abort()
      if (unexpected) onFailure?.('connection_closed')
    }
  }

  async discover(signal?: AbortSignal): Promise<readonly Tool[]> {
    const deadline = AbortSignal.timeout(STARTUP_MS)
    const bound = AbortSignal.any([deadline, this.#lifetime.signal, ...(signal ? [signal] : [])])
    try {
      return await this.#scope.run({signal: bound, maxBytes: DISCOVERY_BYTES}, async () => {
        const options = {signal: bound, timeout: STARTUP_MS}
        await this.#client.connect(this.#transport as Transport, options)
        const tools: Tool[] = []
        const names = new Set<string>()
        let cursor: string | undefined
        for (let page = 0; page < 8; page += 1) {
          // listTools() eagerly compiles output schemas for every remote tool. Discovery must
          // only read metadata, including for tools that are not allowlisted.
          const result = await this.#client.request({method: 'tools/list', params: cursor === undefined ? {} : {cursor}}, ListToolsResultSchema, options)
          for (const tool of result.tools) {
            if (names.has(tool.name)) throw new McpFailure('duplicate_tool_name')
            names.add(tool.name)
            tools.push(tool)
          }
          if (Buffer.byteLength(JSON.stringify(tools)) > DISCOVERY_BYTES || tools.length > 1024) throw new McpFailure('discovery_too_large')
          if (result.nextCursor === undefined) return tools
          cursor = result.nextCursor
        }
        throw new McpFailure('discovery_page_limit')
      })
    } catch (error) {
      const code = signal?.aborted === true ? 'discovery_cancelled' : deadline.aborted ? 'discovery_timeout'
        : error instanceof McpFailure ? error.code : 'discovery_failed'
      await this.close()
      throw new McpFailure(code)
    }
  }

  async call(name: string, args: Record<string, unknown>, options: RequestScope & {readonly timeoutMs: number; readonly returnToolErrors?: boolean}): Promise<CallToolResult> {
    if (this.#closed) throw new McpFailure('transport_closed')
    const signal = AbortSignal.any([options.signal, this.#lifetime.signal, AbortSignal.timeout(Math.ceil(options.timeoutMs))])
    try {
      return await this.#scope.run({...options, signal, maxBytes: options.maxBytes + 65536}, async () => {
        signal.throwIfAborted()
        const result = await this.#client.callTool({name, arguments: args}, undefined, {signal, timeout: options.timeoutMs}) as CallToolResult
        if (Buffer.byteLength(JSON.stringify(result)) > options.maxBytes) throw new McpFailure('response_too_large')
        if (result.isError && !options.returnToolErrors) throw new McpFailure('tool_failed')
        return result
      })
    } catch (error) {
      throw new McpFailure(signal.aborted ? 'timeout' : error instanceof McpFailure ? error.code : 'call_failed')
    }
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing
    this.#closed = true
    this.#lifetime.abort()
    this.#closing = (async () => {
      const transport = this.#transport
      if (transport instanceof StreamableHTTPClientTransport && transport.sessionId !== undefined) {
        try {
          await this.#scope.run({signal: AbortSignal.timeout(250), maxBytes: DISCOVERY_BYTES}, () => transport.terminateSession())
        } catch { /* cleanup never echoes server data or masks the primary failure */ }
      }
      await this.#client.close().catch(() => undefined)
      // Connect may fail before the client takes transport ownership.
      await transport.close().catch(() => undefined)
    })()
    return this.#closing
  }
}

/** Metadata-only probe for the main process. Never calls a discovered tool; no connection fields returned. */
export async function probeMcpServer(config: McpServerConfig, signal?: AbortSignal) {
  const connection = new McpConnection(config)
  try {
    const tools = (await connection.discover(signal)).map(tool => ({
      name: tool.name, description: tool.description ?? '', readOnlyHint: tool.annotations?.readOnlyHint === true,
    }))
    return {status: 'ok' as const, tools}
  }
  catch (error) { return {status: 'failed' as const, tools: [], reason: error instanceof McpFailure ? error.code : 'discovery_failed'} }
  finally { await connection.close() }
}
