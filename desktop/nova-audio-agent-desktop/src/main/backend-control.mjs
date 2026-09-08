import {publicUsageReport} from './frontend-usage.mjs'
import {randomUUID} from 'node:crypto'

export function publicRuntimeCapabilityStatus(value) {
  if (!value || (value.toolCount !== null && (!Number.isSafeInteger(value.toolCount) || value.toolCount < 0 || value.toolCount > 100000))
    || !Number.isSafeInteger(value.toolBudget) || value.toolBudget < 1 || value.toolBudget > 256) return null
  const result = {toolCount: value.toolCount, toolBudget: value.toolBudget,
    state: value.state === 'startup_failed' ? 'startup_failed' : 'compiled'}
  if (value.modules) {
    result.modules = {}
    for (const name of ['search', 'camera', 'coding', 'knowledge']) {
      const module = value.modules[name]
      if (typeof module?.enabled === 'boolean') result.modules[name] = {enabled: module.enabled}
    }
    if (result.modules.search && ['mcp', 'tavily'].includes(value.modules.search.provider)) result.modules.search.provider = value.modules.search.provider
    if (result.modules.knowledge) result.modules.knowledge.exposeToCodex = value.modules.knowledge.exposeToCodex === true
  }
  const states = ['configured', 'ok', 'failed', 'disabled']
  const status = server => ({status: states.includes(server?.status) ? server.status : 'failed',
    ...(typeof server?.reason === 'string' && /^[a-zA-Z0-9_.: -]{1,160}$/u.test(server.reason) ? {reason: server.reason} : {})})
  result.servers = (Array.isArray(value.servers) ? value.servers : []).slice(0, 8).filter(server => /^[a-z][a-z0-9_]{0,31}$/u.test(server?.name ?? '')).map(server => ({name: server.name, ...status(server), ...(server.codex ? {codex: status(server.codex)} : {})}))
  result.overrides = (Array.isArray(value.overrides) ? value.overrides : []).filter(name => ['NOVA_AUDIO_AGENT_SEARCH_PROVIDER', 'NOVA_AUDIO_AGENT_SEARCH_MCP_URL', 'NOVA_AUDIO_AGENT_SEARCH_MCP_TOOL', 'NOVA_AUDIO_AGENT_CAMERA_MODULE_ENABLED'].includes(name))
  return result
}

/** One private utility child owns every pending request; replacement closes this handle. */
export function createBackendControl(child, {onStatus = () => {}, onUsage = () => {}} = {}) {
  const pending = new Map()
  let closed = false
  const unavailable = () => new Error('backend control unavailable')
  const receive = message => {
    if (closed || !message || typeof message !== 'object') return
    if (message.type === 'nova.usage') {
      const report = publicUsageReport(message.report)
      if (report) onUsage(report)
      return
    }
    if (message.type === 'nova.capabilities') {
      const value = publicRuntimeCapabilityStatus(message.status)
      if (value) onStatus(value)
      return
    }
    if (message.type !== 'nova.control.reply' || typeof message.id !== 'string') return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) request.reject(unavailable())
    else request.resolve(message.result)
  }
  function close() {
    if (closed) return
    closed = true
    child.off('message', receive)
    child.off('exit', close)
    child.off('error', close)
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(unavailable()) }
    pending.clear()
  }
  child.on('message', receive)
  child.once('exit', close)
  child.once('error', close)
  return {
    close,
    request(method, params = {}, {timeoutMs = 30000} = {}) {
      if (closed || pending.size >= 8 || typeof method !== 'string' || method.length > 80
        || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) return Promise.reject(unavailable())
      return new Promise((resolve, reject) => {
        const id = randomUUID()
        const timer = setTimeout(() => {pending.delete(id); reject(unavailable())}, timeoutMs)
        pending.set(id, {resolve, reject, timer})
        try { child.postMessage({type: 'nova.control.request', id, method, params}) }
        catch { pending.delete(id); clearTimeout(timer); reject(unavailable()) }
      })
    },
  }
}
