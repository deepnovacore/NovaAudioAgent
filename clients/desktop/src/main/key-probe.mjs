// Live check for the one or two keys a first run needs. Each probe is a cheap
// authenticated model listing; the key never appears in the result.
const PROBES = Object.freeze({
  dashscopeApiKey: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models',
  deepseekApiKey: 'https://api.deepseek.com/models',
  arkApiKey: 'https://ark.cn-beijing.volces.com/api/v3/models',
})
// The Volcengine speech key has no cheap authenticated read; it is checked by the first connection.
const DEFERRED = new Set(['doubaoBigmodelApiKey'])
const PROBE_TIMEOUT_MS = 8_000

export async function probeApiKey(key, value, {fetch = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS} = {}) {
  if (typeof value !== 'string' || value.trim() === '' || /[\u0000-\u001f\u007f]/u.test(value)) return Object.freeze({status: 'missing'})
  if (DEFERRED.has(key)) return Object.freeze({status: 'deferred'})
  if (!Object.hasOwn(PROBES, key)) return Object.freeze({status: 'unsupported'})
  try {
    const response = await fetch(PROBES[key], {
      headers: {authorization: `Bearer ${value.trim()}`},
      signal: AbortSignal.timeout(timeoutMs),
    })
    await response.body?.cancel().catch(() => {})
    if (response.ok) return Object.freeze({status: 'ok'})
    if (response.status === 401 || response.status === 403) return Object.freeze({status: 'rejected', httpStatus: response.status})
    return Object.freeze({status: 'network', httpStatus: response.status})
  } catch {
    return Object.freeze({status: 'network'})
  }
}
