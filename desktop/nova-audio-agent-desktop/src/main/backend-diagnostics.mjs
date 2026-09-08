const RUNTIME_CODES = new Set([
  'configuration_required', 'authentication_failed', 'backend_unavailable', 'assembly_failed',
])
const CODEX_DIAGNOSTIC_CODES = new Set([
  'codex_login_status_nonzero',
  'codex_login_status_no_output',
  'codex_login_status_multiple_streams',
  'codex_login_status_unrecognized',
  'codex_credential_snapshot_private_home_failed',
  'codex_credential_snapshot_api_key_failed',
  'codex_credential_snapshot_saved_login_failed',
  'codex_credential_snapshot_environment_failed',
  'codex_project_view_refresh_project_state_error',
  'codex_project_view_refresh_type_error',
  'codex_project_view_refresh_unexpected_error',
  ...[
    'workspace_name_invalid', 'session_title_invalid', 'state_lock_failed', 'state_busy',
    'state_permissions', 'state_corrupt', 'state_too_large', 'state_version_unsupported',
    'state_write_failed', 'context_delivery_failed', 'managed_root_unsafe', 'workspace_invalid',
    'workspace_not_found', 'workspace_name_conflict', 'workspace_path_conflict', 'workspace_limit',
    'workspace_create_failed', 'workspace_boundary_changed', 'session_not_found',
    'session_unavailable', 'session_workspace_mismatch', 'session_state_conflict', 'session_limit',
    'thread_id_invalid', 'id_factory_invalid', 'clock_invalid',
  ].map(code => `codex_project_view_refresh_${code}`),
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
        if (RUNTIME_CODES.has(match[1]) || CODEX_DIAGNOSTIC_CODES.has(match[1])) code = match[1]
      }
      return code
    },
    failure(fallback = 'backend_disconnected') {
      return classifyBackendFailure(code !== null && RUNTIME_CODES.has(code) ? code : fallback)
    },
    code: () => code,
  })
}
