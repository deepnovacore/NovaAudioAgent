/** External MCP tools are direct, untrusted executors; discovery never grants approval or probe authority. */
import {createHash} from 'node:crypto'
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv'
import type {Tool} from '@modelcontextprotocol/sdk/types.js'
import type {ExecutorAdapter, ExecutorDispatchContext, ExecutorHandoff} from '../causal-runtime.js'
import {jsonValueSchema, type JsonValue} from '../events.js'
import {executorManifestSchema, type ExecutorManifest} from '../ports.js'
import {compileToolSchema} from '../tool-schema.js'
import {McpConnection, McpFailure} from '../mcp-client.js'
import type {CapabilityRegistry, McpServerConfig, McpServerStatus} from '../capability-registry.js'

export function mcpToolAlias(server: string, original: string): string {
  const prefix = `mcp__${server}__`
  const budget = 64 - prefix.length
  if (!/^[a-z][a-z0-9_]{0,31}$/u.test(server)) throw new McpFailure('invalid_server_name')
  const normalized = original.toLowerCase().replace(/[^a-z0-9_]/gu, '_').replace(/_+/gu, '_').replace(/^_|_$/gu, '')
  const alias = normalized === original && original.length <= budget && original.length > 0 ? original
    : `${normalized.slice(0, budget - 7)}_${createHash('sha256').update(original).digest('hex').slice(0, 6)}`
  if (prefix.length + alias.length > 64) throw new McpFailure('alias_too_long')
  return alias
}

/** A narrow, bounded provider-compatible subset; SDK AJV owns actual argument validation. */
function compatibleSchema(value: unknown, depth = 0): Record<string, JsonValue> {
  if (depth > 8 || typeof value !== 'object' || value === null || Array.isArray(value)) throw new McpFailure('incompatible_schema')
  const schema = value as Record<string, JsonValue>
  const allowed = ['type', 'title', 'description', 'default', 'enum', 'properties', 'required', 'additionalProperties',
    'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']
  if (Object.keys(schema).some(key => !allowed.includes(key))
    || (typeof schema.type !== 'string' || !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type))) throw new McpFailure('incompatible_schema')
  for (const key of ['title', 'description']) if (schema[key] !== undefined && typeof schema[key] !== 'string') throw new McpFailure('incompatible_schema')
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) throw new McpFailure('incompatible_schema')
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
    if (schema[key] !== undefined && ((schema.type !== 'number' && schema.type !== 'integer') || typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) throw new McpFailure('incompatible_schema')
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (schema[key] !== undefined && (schema.type !== (key.endsWith('Items') ? 'array' : 'string') || !Number.isInteger(schema[key]) || (schema[key] as number) < 0)) throw new McpFailure('incompatible_schema')
  }
  if (schema.type === 'object') {
    const properties = schema.properties ?? {}
    if (typeof properties !== 'object' || properties === null || Array.isArray(properties) || Object.keys(properties).length > 128 || 'origin_ref' in properties) throw new McpFailure('incompatible_schema')
    if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every(key => typeof key === 'string' && Object.hasOwn(properties, key)) || new Set(schema.required).size !== schema.required.length)) throw new McpFailure('incompatible_schema')
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') throw new McpFailure('incompatible_schema')
    schema.properties = Object.fromEntries(Object.entries(properties).map(([key, child]) => [key, compatibleSchema(child, depth + 1)]))
    schema.additionalProperties ??= false
  } else if (['properties', 'required', 'additionalProperties'].some(key => key in schema)) throw new McpFailure('incompatible_schema')
  if (schema.type === 'array') schema.items = compatibleSchema(schema.items, depth + 1)
  else if ('items' in schema) throw new McpFailure('incompatible_schema')
  return schema
}

export class McpExecutorAdapter implements ExecutorAdapter {
  readonly manifest: ExecutorManifest
  readonly #validators = new Map<string, (input: unknown) => {valid: boolean}>()
  readonly #counts = new Map<string, Map<string, number>>()
  #currentTurn: string | undefined
  constructor(readonly server: string, readonly config: McpServerConfig, readonly connection: McpConnection, discovered: readonly Tool[]) {
    const aliases: Record<string, string> = Object.create(null) as Record<string, string>
    const validator = new AjvJsonSchemaValidator()
    const ops = Object.entries(config.tools).filter(([, policy]) => policy.enabled).map(([original, policy]) => {
      const tool = discovered.find(tool => tool.name === original)
      if (tool === undefined) throw new McpFailure('enabled_tool_missing')
      const alias = mcpToolAlias(server, original)
      if (Object.hasOwn(aliases, alias)) throw new McpFailure('alias_collision')
      aliases[alias] = original
      try {
        if (tool.inputSchema.type !== 'object') throw new McpFailure('incompatible_schema')
        const params = compatibleSchema(structuredClone(tool.inputSchema))
        this.#validators.set(alias, validator.getValidator(params))
        return {name: alias, description: tool.description?.trim() ? tool.description.trim() : `MCP tool ${original} from ${server}`,
          params, readonly: tool.annotations?.readOnlyHint === true, deadline_budget: policy.timeoutMs / 1000,
          sync_result: policy.timeoutMs <= 10000}
      } catch { throw new McpFailure(`incompatible_tool:${original}`) }
    })
    this.manifest = executorManifestSchema.parse({
      name: `mcp__${server}`, display_name: server, roles: [], approvals: false, model_visibility: 'direct', probe_policy: 'none', tool_aliases: aliases, ops,
      policy: {channel: `mcp__${server}`, priority: 40, wake: 'surrogate', typical_latency: 1, compress_watermark: 8000, progress_via_surrogate: true},
    })
    compileToolSchema([this.manifest]) // Existing reserved params/provider schema rules remain authoritative.
  }
  admitRequest(op: string, request: Readonly<Record<string, JsonValue>>) {
    return this.#validators.get(op)?.(request).valid === true
      ? {ok: true as const, request, sync_result: this.manifest.ops.find(value => value.name === op)!.sync_result}
      : {ok: false as const}
  }
  async dispatch(op: string, request: Readonly<Record<string, JsonValue>>, context: ExecutorDispatchContext): Promise<ExecutorHandoff> {
    const operation = this.manifest.ops.find(value => value.name === op)
    const original = this.manifest.tool_aliases?.[op]
    const policy = original === undefined ? undefined : this.config.tools[original]
    const failure = (code: string, outcome: ExecutorHandoff['outcome'] = 'refused'): ExecutorHandoff => ({outcome, trust: 'untrusted_external', content: {code, verified: false}})
    if (operation === undefined || original === undefined || policy === undefined || !this.admitRequest(op, request).ok) return failure('invalid_params')
    const authority = context.userTurn
    const wanted = (): boolean => authority?.originRef === context.delegate.origin_ref && authority.stillWanted()
    if (!operation.readonly && !wanted()) return failure('stale_user_origin')
    const turn = context.delegate.origin_ref
    let counts = this.#counts.get(turn)
    if (wanted() && this.#currentTurn !== turn) {
      this.#counts.clear(); this.#currentTurn = turn
      if (counts !== undefined) this.#counts.set(turn, counts)
    }
    // Authority retires other turns, preserving any readonly calls already charged to
    // this origin. Unscoped callers cannot evict history to restore their quota.
    if (counts === undefined) {
      if (this.#counts.size >= 1024) return failure('turn_history_full')
      counts = new Map(); this.#counts.set(turn, counts)
    }
    const count = counts.get(op) ?? 0
    if (count >= policy.maxCallsPerTurn) return failure('max_calls_per_turn')
    counts.set(op, count + 1)
    const timeoutMs = Math.min(policy.timeoutMs, Math.max(0, (context.delegate.deadline - context.clock.now()) * 1000))
    if (timeoutMs <= 0 || context.signal.aborted) return failure('timeout', 'unknown')
    try {
      context.progress({phase: 'started', internal_activity: 0, elapsed: 0, summary: null})
      const result = await this.connection.call(original, request, {signal: context.signal, timeoutMs, maxBytes: policy.maxResultBytes,
        ...(operation.readonly ? {} : {stillWanted: wanted})})
      return {outcome: 'ok', trust: 'untrusted_external', content: {result: jsonValueSchema.parse(result), verified: false}}
    } catch (error) {
      const code = error instanceof McpFailure ? error.code : 'call_failed'
      return failure(code, code === 'stale_user_origin' ? 'refused' : operation.readonly ? 'failed' : 'unknown')
    }
  }
}

export interface PreparedExternalMcp {
  readonly capabilities: CapabilityRegistry
  readonly adapters: readonly McpExecutorAdapter[]
  close(): Promise<void>
}

export async function prepareExternalMcp(capabilities: CapabilityRegistry, signal?: AbortSignal): Promise<PreparedExternalMcp> {
  const adapters: McpExecutorAdapter[] = []
  const connections: McpConnection[] = []
  const statuses = [...capabilities.serverStatuses]
  const updateStatus = (status: McpServerStatus): void => {
    const index = statuses.findIndex(value => value.name === status.name)
    if (index < 0) statuses.push(status); else statuses[index] = status
  }
  for (const [name, config] of Object.entries(capabilities.mcpServers)) {
    if (!config.enabled || !config.exposeTo.frontbrain) continue
    let connection: McpConnection | undefined
    try {
      if (signal?.aborted === true) throw new McpFailure('discovery_cancelled')
      connection = new McpConnection(config, reason => updateStatus({name, status: 'failed', reason}))
      const discovered = await connection.discover(signal)
      const adapter = new McpExecutorAdapter(name, config, connection, discovered)
      adapters.push(adapter); connections.push(connection)
      updateStatus({name, status: 'ok'})
    } catch (error) {
      await connection?.close()
      updateStatus({name, status: 'failed', reason: error instanceof McpFailure ? error.code : 'discovery_failed'})
    }
  }
  return {capabilities: {...capabilities, serverStatuses: statuses}, adapters,
    close: async () => { await Promise.all(connections.map(connection => connection.close())) }}
}
