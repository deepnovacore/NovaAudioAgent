const MESSAGE_CODES = new Set([
  'project_directory_authority_unavailable',
  'project_directory_open_failed',
  'project_directory_open_failed_home',
  'project_directory_open_failed_root',
  'project_directory_open_failed_state',
  'project_directory_open_failed_managed',
  'project_directory_open_failed_workspace',
  'project_directory_create_failed',
  'project_directory_protection_failed',
])

export function startupFailureCode(error) {
  if (MESSAGE_CODES.has(error?.message)) return error.message
  if (error?.name === 'MainCameraConfigurationError') return 'camera_configuration_invalid'
  if (error?.message === 'NOVA_AUDIO_AGENT_BACKEND must be python or node') {
    return 'backend_selection_invalid'
  }
  return 'startup_failed'
}

export function reportStartupFailure(error, {
  write = chunk => process.stderr.write(chunk),
} = {}) {
  const code = startupFailureCode(error)
  write(`[desktop-diagnostic] startup_failure code=${code}\n`)
  return code
}
