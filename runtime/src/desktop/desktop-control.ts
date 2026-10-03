import {randomUUID} from 'node:crypto'
import {personalCommandSchema} from '../personal-agent/contracts.js'
import {BlockingConfigurationError} from '../config/config.js'
import {DEFAULT_FRONTBRAIN_TOOL_BUDGET} from '../config/capability-registry.js'
import type {CapabilityStatus} from '../config/capability-registry.js'
import type {DesktopStopParentSource} from './desktop-session.js'
import {reportUsage, type UsageReport} from '../realtime/usage.js'
import {CODING_BACKEND_IDS, type CodingBackendId} from '../config/coding-backends.js'

type ParentPort = DesktopStopParentSource & {postMessage(message: unknown): void}
export interface DesktopCapabilityState extends Partial<CapabilityStatus> {
  readonly toolCount: number | null
  readonly toolBudget: number
  readonly state: 'running' | 'startup_failed'
  readonly reason?: 'configuration_required'
  readonly pipeline?: 'integrated' | 'cascaded'
  readonly missing?: readonly string[]
}
/** Utility IPC only: the renderer WebSocket never admits these host operations. */
export function installDesktopControl(options: {
  readonly parentPort?: ParentPort
  readonly signal: AbortSignal
  readonly status: () => DesktopCapabilityState | undefined
  readonly handle?: (method: string, params: unknown) => Promise<unknown>
  /** Changes the default for new coding sessions only; it never touches running work. */
  readonly updateCodingBackend?: (backend: CodingBackendId) => void
}): {publish(): void; publishUsage: (report: UsageReport) => void; dispose(): void} {
  const port = options.parentPort
  let disposed = false
  let last = ''
  let pending = 0
  const publish = (): void => {
    if (disposed || port === undefined) return
    const status = options.status()
    if (status === undefined) return
    const serialized = JSON.stringify(status)
    if (last === serialized) return
    last = serialized
    port.postMessage({type: 'nova.capabilities', status})
  }
  const receive = (event: unknown): void => {
    const wrapper = event as {readonly data?: unknown}
    const value = (wrapper?.data ?? event) as {readonly type?: unknown; readonly id?: unknown; readonly method?: unknown; readonly params?: unknown}
    if (disposed || value?.type !== 'nova.control.request' || typeof value.id !== 'string' || value.id.length > 80
      || typeof value.method !== 'string' || value.method.length > 80 || pending >= 8) return
    const id = value.id
    const method = value.method
    pending += 1
    void (async () => {
      try {
        let result: unknown
        if (method === 'coding.default.set') {
          const params = value.params as {backend?: unknown} | null
          if (params === null || typeof params !== 'object' || Array.isArray(params)
            || Object.keys(params).length !== 1 || !Object.hasOwn(params, 'backend')
            || !CODING_BACKEND_IDS.includes(params.backend as CodingBackendId) || options.updateCodingBackend === undefined) {
            throw new Error('invalid_coding_backend')
          }
          options.updateCodingBackend(params.backend as CodingBackendId)
          result = {backend: params.backend}
        } else result = method === 'capabilities.status' ? options.status() : await options.handle?.(method, value.params)
        if (!disposed) port?.postMessage({type: 'nova.control.reply', id, ...(result === undefined ? {error: 'unavailable'} : {result})})
      } catch {
        if (!disposed) port?.postMessage({type: 'nova.control.reply', id, error: 'unavailable'})
      } finally { pending -= 1 }
    })()
  }
  const timer = port === undefined ? undefined : setInterval(publish, 1000)
  timer?.unref()
  function dispose(): void {
    if (disposed) return
    disposed = true
    clearInterval(timer)
    port?.off?.('message', receive)
    options.signal.removeEventListener('abort', dispose)
  }
  port?.on('message', receive)
  options.signal.addEventListener('abort', dispose, {once: true})
  if (options.signal.aborted) dispose()
  return {publish, dispose, publishUsage: report => {
    // Final metering may arrive while semantic shutdown is draining.
    reportUsage(port === undefined ? undefined : value => port.postMessage({type: 'nova.usage', report: value}), report)
  }}
}
/** Names the missing pipeline keys so the host can ask for exactly those instead of a bare configuration error. */
export function desktopConfigurationFailure(error: unknown): DesktopCapabilityState | undefined {
  if (!(error instanceof BlockingConfigurationError)) return undefined
  const missing = error.missing.filter(name => /^[A-Z][A-Z0-9_]{0,63}$/u.test(name)).slice(0, 4)
  return {state: 'startup_failed', toolCount: null, toolBudget: DEFAULT_FRONTBRAIN_TOOL_BUDGET,
    reason: 'configuration_required', pipeline: error.pipeline, missing}
}

export function desktopBudgetFailure(error: unknown): DesktopCapabilityState | undefined {
  const value = error as {readonly code?: unknown; readonly toolCount?: unknown; readonly toolBudget?: unknown}
  if (value?.code !== 'frontbrain_tool_budget_exceeded' || typeof value.toolCount !== 'number' || typeof value.toolBudget !== 'number'
    || !Number.isSafeInteger(value.toolCount) || value.toolCount < 0 || value.toolCount > 100000
    || !Number.isSafeInteger(value.toolBudget) || value.toolBudget < 1 || value.toolBudget > 256) return undefined
  return {state: 'startup_failed', toolCount: value.toolCount, toolBudget: value.toolBudget}
}


/** The settings window may manage sources, connectors and discovery scheduling; nothing that reads memory, feeds or conversations. */
export const PERSONAL_SETTINGS_METHODS: readonly string[] = Object.freeze([
  'state', 'sources.add', 'sources.authorize_computer', 'sources.consent', 'sources.pause', 'sources.resume', 'sources.sync', 'sources.disconnect', 'sources.delete',
  'connector.status', 'connector.link', 'connector.complete', 'connector.scopes', 'connector.configure', 'connector.consent',
  'connector.sync', 'connector.pause', 'connector.resume', 'connector.disconnect', 'connector.delete',
  'connector.local_status', 'connector.local_connect', 'connector.local_access',
  'connector.mail_status', 'connector.mail_connect', 'connector.mail_access', 'discovery.configure',
])
/** The only snapshot fields the settings window may see: no conversations, memory, feed, life, news or understanding. */
export function connectionsProjection(snapshot: unknown): Record<string, unknown> {
  const s = (snapshot ?? {}) as Record<string, unknown>
  const capabilities = (s.capabilities ?? {}) as Record<string, unknown>
  return {
    revision: s.revision,
    sources: Array.isArray(s.sources) ? s.sources : [],
    connectors: s.connectors ?? null,
    settings: s.settings ?? {},
    capabilities: {sources: capabilities.sources === true, discovery: capabilities.discovery === true},
  }
}
export async function handlePersonalSettings(command: (input: unknown) => Promise<unknown>, method: string, params: unknown): Promise<unknown> {
  if (!PERSONAL_SETTINGS_METHODS.includes(method)) return {error: 'unsupported'}
  const parsed = personalCommandSchema.safeParse({type: 'personal.command', request_id: randomUUID(), method, params})
  if (!parsed.success) return {error: 'invalid_request'}
  const result = await command(parsed.data) as {ok?: boolean; data?: unknown; error?: string}
  if (result.ok !== true) return {error: result.error ?? 'unavailable'}
  if (method === 'state') return connectionsProjection(result.data)
  // Commands that persist without a payload (discovery.configure) must still read as success across the port.
  return result.data === undefined ? {ok: true} : result.data
}

/** Settings may configure IM; they cannot read memory or authorize tasks through this port. */
export async function handleFeishuSettings(command: (input: unknown) => Promise<unknown>, method: string, params: unknown): Promise<unknown> {
  if (!method.startsWith('feishu.')) return {error: 'unsupported'}
  const parsed = personalCommandSchema.safeParse({type: 'personal.command', request_id: randomUUID(), method, params})
  if (!parsed.success) return {error: 'invalid_request'}
  const result = await command(parsed.data) as {ok?: boolean; data?: unknown; error?: string}
  return result.ok === true ? result.data : {error: result.error ?? 'unavailable'}
}
