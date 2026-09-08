import type {CapabilityStatus} from './capability-registry.js'
import type {DesktopStopParentSource} from './desktop-service.js'
import {reportUsage, type UsageReport} from './realtime/usage.js'

type ParentPort = DesktopStopParentSource & {postMessage(message: unknown): void}
export interface DesktopCapabilityState extends Partial<CapabilityStatus> {
  readonly toolCount: number | null
  readonly toolBudget: number
  readonly state: 'running' | 'startup_failed'
}
/** Utility IPC only: the renderer WebSocket never admits these host operations. */
export function installDesktopControl(options: {
  readonly parentPort?: ParentPort
  readonly signal: AbortSignal
  readonly status: () => DesktopCapabilityState | undefined
  readonly handle?: (method: string, params: unknown) => Promise<unknown>
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
        const result = method === 'capabilities.status' ? options.status() : await options.handle?.(method, value.params)
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
export function desktopBudgetFailure(error: unknown): DesktopCapabilityState | undefined {
  const value = error as {readonly code?: unknown; readonly toolCount?: unknown; readonly toolBudget?: unknown}
  if (value?.code !== 'frontbrain_tool_budget_exceeded' || typeof value.toolCount !== 'number' || typeof value.toolBudget !== 'number'
    || !Number.isSafeInteger(value.toolCount) || value.toolCount < 0 || value.toolCount > 100000
    || !Number.isSafeInteger(value.toolBudget) || value.toolBudget < 1 || value.toolBudget > 256) return undefined
  return {state: 'startup_failed', toolCount: value.toolCount, toolBudget: value.toolBudget}
}
