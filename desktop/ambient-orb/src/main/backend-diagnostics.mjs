const RUNTIME_CODES = new Set([
  'configuration_required', 'authentication_failed', 'backend_unavailable', 'assembly_failed',
])
const LINE = /\[runtime-diagnostic\]\s+([a-z0-9_]{1,64})/g

export function classifyBackendFailure(code) {
  if (code === 'configuration_required' || code === 'manual_path_required'
    || code === 'model_base_url_invalid') {
    return Object.freeze({kind: 'configuration_required', code})
  }
  if (code === 'authentication_failed') {
    return Object.freeze({kind: 'authentication_failed', code})
  }
  if (code === 'backend_unavailable' || code === 'codex_unavailable') {
    return Object.freeze({kind: 'unavailable', code})
  }
  return Object.freeze({kind: 'recoverable', code: 'backend_disconnected'})
}

export function createBackendDiagnosticCollector() {
  let buffer = ''
  let code = null
  return Object.freeze({
    push(chunk) {
      buffer = `${buffer}${String(chunk)}`.slice(-1024)
      for (const match of buffer.matchAll(LINE)) {
        if (RUNTIME_CODES.has(match[1])) code = match[1]
      }
      return code
    },
    failure(fallback = 'backend_disconnected') {
      return classifyBackendFailure(code ?? fallback)
    },
    code: () => code,
  })
}
