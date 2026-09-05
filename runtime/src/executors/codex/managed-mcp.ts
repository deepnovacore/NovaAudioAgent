import {SensitiveContentPolicy} from '../../workspace-graph/sensitivity.js'
import type {CapabilityRegistry, McpServerConfig, McpServerStatus} from '../../capability-registry.js'
import {snapshotJsonRecord} from './safe-json.js'

export interface ManagedMcpEntry {
  readonly enabled: true
  readonly enabled_tools: readonly string[]
  readonly disabled_tools: readonly string[]
  readonly startup_timeout_sec: 15
  readonly tool_timeout_sec: number
  readonly default_tools_approval_mode: 'auto'
  readonly url?: string
  readonly bearer_token_env_var?: string
  readonly env_http_headers?: Readonly<Record<string, string>>
  readonly command?: string
  readonly args?: readonly string[]
  readonly env_vars?: readonly string[]
}
const sensitivity = new SensitiveContentPolicy()
const managedBrand: unique symbol = Symbol('ManagedCodexMcp')
export interface ManagedCodexMcp {
  readonly [managedBrand]: true
  readonly servers: Readonly<Record<string, ManagedMcpEntry>>
}
const values = new WeakMap<ManagedCodexMcp, {
  environment: Readonly<Record<string, string>>
  capabilities: CapabilityRegistry
}>()

/** Host-only seam. Trusted entries (e.g. nova_knowledge) never pass through the external URL parser. */
export function prepareManagedCodexMcp(
  capabilities: CapabilityRegistry,
  trustedEntries: Readonly<Record<string, McpServerConfig>> = {},
  platform: NodeJS.Platform = process.platform,
): ManagedCodexMcp {
  const servers: Record<string, ManagedMcpEntry> = Object.create(null) as Record<string, ManagedMcpEntry>
  const environment: Record<string, string> = Object.create(null) as Record<string, string>
  const candidates = new Map<string, {entry: ManagedMcpEntry; env: Record<string, string>}>()
  const all = {...capabilities.mcpServers, ...trustedEntries}
  for (const [name, input] of Object.entries(all)) {
    try {
      const config = snapshotJsonRecord(input) as unknown as McpServerConfig
      if (!capabilities.modules.coding.enabled || !config.enabled || !config.exposeTo.codex) {
        updateStatus(capabilities, name, {status: 'disabled'})
        continue
      }
      if (!/^[a-z][a-z0-9_]{0,31}$/u.test(name)
        || Object.hasOwn(trustedEntries, name) && Object.hasOwn(capabilities.mcpServers, name)) fail('codex_entry_conflict')
      const enabled = Object.entries(config.tools).filter(([, tool]) => tool.enabled)
      const timeouts = new Set(enabled.map(([, tool]) => Math.ceil(tool.timeoutMs / 1000)))
      if (timeouts.size > 1) fail('codex_timeout_unrepresentable')
      const base = {enabled: true as const, enabled_tools: enabled.map(([name]) => name), disabled_tools: [],
        startup_timeout_sec: 15 as const, tool_timeout_sec: [...timeouts][0] ?? 8, default_tools_approval_mode: 'auto' as const}
      const env: Record<string, string> = Object.create(null) as Record<string, string>
      let entry: ManagedMcpEntry
      if (config.transport === 'streamable-http') {
        // Codex has no environment-reference form for URL. Never persist interpolated URL credentials.
        if (config.url === undefined || config.urlInterpolated === true) fail('codex_secret_url_unrepresentable')
        const url = new URL(config.url)
        if (url.username || url.password || url.hash || sensitivity.scrub('url', config.url).kind !== 'clean') fail('codex_secret_url_unrepresentable')
        const configuredHeaders = Object.entries(config.headers ?? {})
        const soleHeader = configuredHeaders.length === 1 ? configuredHeaders[0] : undefined
        if (soleHeader?.[0].toLowerCase() === 'authorization' && /^Bearer [^\r\n]+$/u.test(soleHeader[1])) {
          const key = `NOVA_MANAGED_MCP_${name.toUpperCase()}_TOKEN`
          env[key] = soleHeader[1].slice('Bearer '.length)
          entry = {...base, url: config.url, bearer_token_env_var: key}
        } else {
          const headers = Object.fromEntries(configuredHeaders.map(([header, value], index) => {
            const key = `NOVA_MANAGED_MCP_${name.toUpperCase()}_HEADER_${index}`
            env[key] = value
            return [header, key]
          }))
          entry = {...base, url: config.url, env_http_headers: headers}
        }
      } else {
        for (const [key, value] of Object.entries(config.env ?? {})) {
          // ponytail: credential-only parent env; use a scoped launcher adapter if noncredential settings are needed.
          if (!safeStdioKey(key)) fail('codex_env_unrepresentable')
          const canonical = platform === 'win32' ? key.toUpperCase() : key
          if (Object.hasOwn(env, canonical) && env[canonical] !== value) fail('codex_env_conflict')
          env[canonical] = value
        }
        if (config.command === undefined) fail('codex_transport_unrepresentable')
        if (sensitivity.scrubCommand(config.command, config.args).kind !== 'clean') fail('codex_secret_command_unrepresentable')
        entry = {...base, command: config.command, args: config.args ?? [], ...(Object.keys(env).length === 0 ? {} : {env_vars: Object.keys(env)})}
      }
      candidates.set(name, {entry, env})
    } catch (error) {
      updateStatus(capabilities, name, {status: 'failed', reason: error instanceof ProjectionError ? error.message : 'codex_projection_invalid'})
    }
  }
  // All conflicting servers fail, independent of registry iteration order. Never pick a credential winner.
  const conflicts = new Set<string>()
  const owners = new Map<string, {values: Set<string>; names: string[]}>()
  for (const [name, candidate] of candidates) for (const [key, value] of Object.entries(candidate.env)) {
    const previous = owners.get(key)
    if (previous === undefined) owners.set(key, {values: new Set([value]), names: [name]})
    else { previous.names.push(name); previous.values.add(value) }
  }
  for (const owner of owners.values()) if (owner.values.size > 1) for (const name of owner.names) conflicts.add(name)
  for (const [name, candidate] of candidates) {
    if (conflicts.has(name)) { updateStatus(capabilities, name, {status: 'failed', reason: 'codex_env_conflict'}); continue }
    servers[name] = freezeEntry(candidate.entry)
    Object.assign(environment, candidate.env)
    updateStatus(capabilities, name, {status: 'configured'})
  }
  const managed = Object.freeze({[managedBrand]: true as const, servers: Object.freeze(servers)})
  values.set(managed, {environment: Object.freeze(environment), capabilities})
  return managed
}

function safeStdioKey(key: string): boolean {
  const upper = key.toUpperCase()
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(key)
    && /^(?:[A-Z][A-Z0-9_]*_)?(?:KEY|TOKEN|SECRET|PASSWORD)$/u.test(upper)
    && !/^(?:CODEX|OPENAI|NOVA|NODE|LD|DYLD|NPM|PYTHON|RUBY|PERL|BASH|ZSH|GIT|SSH|SSL|CURL|REQUESTS|AWS|AZURE|GOOGLE|GCLOUD)_/u.test(upper)
}
class ProjectionError extends Error {}
function fail(reason: string): never { throw new ProjectionError(reason) }
function freezeEntry(entry: ManagedMcpEntry): ManagedMcpEntry {
  Object.freeze(entry.enabled_tools); Object.freeze(entry.disabled_tools)
  if (entry.args !== undefined) Object.freeze(entry.args)
  if (entry.env_vars !== undefined) Object.freeze(entry.env_vars)
  if (entry.env_http_headers !== undefined) Object.freeze(entry.env_http_headers)
  return Object.freeze(entry)
}
export function managedMcpEnvironment(managed: ManagedCodexMcp | undefined): Readonly<Record<string, string>> {
  if (managed === undefined) return {}
  const value = values.get(managed)
  if (value === undefined) throw new TypeError('invalid managed MCP authority')
  return value.environment
}

export function managedMcpConfigToml(managed: ManagedCodexMcp | undefined): string {
  managedMcpEnvironment(managed)
  return `mcp_servers = ${toml(managed?.servers ?? {})}\n`
}
function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`
  if (typeof value === 'object' && value !== null) return `{ ${Object.entries(value).map(([key, field]) => `${toml(key)} = ${toml(field)}`).join(', ')} }`
  return JSON.stringify(value).replaceAll('\u007f', '\\u007f')
}

export function validateManagedMcpConfig(actual: unknown, managed?: ManagedCodexMcp): void {
  managedMcpEnvironment(managed)
  const record = snapshotJsonRecord(actual)
  const expected = managed?.servers ?? {}
  if (!same(Object.keys(record).sort(), Object.keys(expected).sort())) throw new TypeError('mcp servers')
  for (const [name, entry] of Object.entries(expected)) {
    const config = snapshotJsonRecord(record[name])
    // Real pinned 0.152.0 adds this local-only normalization; no other transport extras are admitted.
    if (config.environment_id === 'local') delete config.environment_id
    if (!same(config, entry)) throw new TypeError('mcp entry')
  }
}
function same(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => same(value, right[index]))
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) || Array.isArray(right)) return false
  const a = left as Record<string, unknown>; const b = right as Record<string, unknown>
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && same(a[key], b[key]))
}

export function recordManagedMcpVisibility(managed: ManagedCodexMcp | undefined, name: string, ok: boolean): void {
  if (managed === undefined) return
  const value = values.get(managed)
  if (value === undefined) throw new TypeError('invalid managed MCP authority')
  updateStatus(value.capabilities, name, ok ? {status: 'ok'} : {status: 'failed', reason: 'codex_visibility'})
}
function updateStatus(capabilities: CapabilityRegistry, name: string, codex: NonNullable<McpServerStatus['codex']>): void {
  const statuses = capabilities.serverStatuses as McpServerStatus[]
  const index = statuses.findIndex(status => status.name === name)
  const previous = statuses[index]
  // A failure observed in any concurrent project remains visible until a registry restart.
  if (previous?.codex?.status === 'failed' && codex.status === 'ok') return
  const next = {...previous ?? {name, status: 'configured' as const}, codex}
  if (index < 0) statuses.push(next)
  else statuses[index] = next
}
