import {Server} from '@modelcontextprotocol/sdk/server/index.js'
import {CallToolRequestSchema, ListToolsRequestSchema, type Tool} from '@modelcontextprotocol/sdk/types.js'
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv'
import type {McpServer} from '@agentclientprotocol/sdk'
import {mcpBackendAuthorized, type CapabilityRegistry, type McpServerConfig} from '../../config/capability-registry.js'
import type {AcpBackendId} from '../../config/coding-backends.js'
import {startLoopbackMcpServer} from '../../mcp/http-server.js'
import {McpConnection} from '../mcp-client.js'
import {CodexTransportError} from '../codex/app-server-transport.js'
import {acpBackend} from './backends.js'

export interface PreparedAcpMcp {
  readonly servers: readonly McpServer[]
  close(): Promise<void>
}

/** Tool-call ceiling for one proxied request; the upstream policy timeout still applies. */
const PROXY_REQUEST_TIMEOUT_MS = 65_000

/**
 * ACP has no per-tool allowlist field, so each granted server is exposed through a per-task,
 * token-authenticated loopback proxy that lists and executes only the enabled tools.
 * Grants are per backend and default off; the legacy Codex grant never applies here.
 */
export async function prepareAcpMcp(
  backend: AcpBackendId,
  registry: CapabilityRegistry,
  trustedEntries: Readonly<Record<string, McpServerConfig>> = {},
  signal?: AbortSignal,
): Promise<PreparedAcpMcp> {
  const selected = Object.entries({...registry.mcpServers, ...trustedEntries}).filter(([, config]) =>
    registry.modules.coding.enabled && mcpBackendAuthorized(config, backend)
      && Object.values(config.tools).some(tool => tool.enabled))
  // Refuse rather than silently drop a granted tool the backend cannot receive.
  if (!acpBackend(backend).mcpInjection && selected.length > 0) throw new CodexTransportError('mcp_tools_not_isolated')
  const servers: McpServer[] = []
  const cleanups: (() => Promise<void>)[] = []
  const lifetime = new AbortController()
  const bound = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])])
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= (async () => {
    lifetime.abort()
    await Promise.allSettled(cleanups.map(cleanup => cleanup()))
  })()
  try {
    for (const [name, config] of selected) {
      bound.throwIfAborted()
      const connection = new McpConnection(config, undefined, {trustedLoopback: Object.hasOwn(trustedEntries, name)})
      cleanups.push(() => connection.close())
      const discovered = await connection.discover(bound)
      const tools: Tool[] = []
      const validators = new Map<string, (value: unknown) => {valid: boolean}>()
      const validator = new AjvJsonSchemaValidator()
      for (const [toolName, policy] of Object.entries(config.tools)) {
        if (!policy.enabled) continue
        const tool = discovered.find(candidate => candidate.name === toolName)
        if (tool === undefined) throw new CodexTransportError('mcp_tools_not_isolated')
        tools.push(tool)
        validators.set(toolName, validator.getValidator(tool.inputSchema as Parameters<AjvJsonSchemaValidator['getValidator']>[0]))
      }
      const http = await startLoopbackMcpServer(() => {
        const server = new Server({name: `nova-${name}`, version: '1'}, {capabilities: {tools: {}}})
        server.setRequestHandler(ListToolsRequestSchema, () => ({tools}))
        server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
          const policy = config.tools[request.params.name]
          const check = validators.get(request.params.name)
          const args = request.params.arguments ?? {}
          if (!policy?.enabled || !check?.(args).valid || bound.aborted) {
            return {isError: true, content: [{type: 'text', text: 'tool_not_authorized'}]}
          }
          try {
            return await connection.call(request.params.name, args, {
              signal: AbortSignal.any([bound, extra.signal]), timeoutMs: policy.timeoutMs,
              maxBytes: policy.maxResultBytes, returnToolErrors: true,
            })
          } catch {
            return {isError: true, content: [{type: 'text', text: 'tool_call_failed'}]}
          }
        })
        return server
      }, PROXY_REQUEST_TIMEOUT_MS)
      cleanups.push(() => http.close())
      servers.push({name, type: 'http', url: http.url, headers: [{name: 'Authorization', value: `Bearer ${http.token}`}]})
    }
    return {servers, close}
  } catch {
    await close()
    throw new CodexTransportError('mcp_tools_not_isolated')
  }
}
