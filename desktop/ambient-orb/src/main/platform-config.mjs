function nonempty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function envBoolean(value, fallback) {
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

export function productPaths({ home, pathApi }) {
  const root = pathApi.join(home, '.nova-audio-agent')
  const managedRoot = pathApi.join(root, 'workspaces')
  return Object.freeze({
    root,
    stateRoot: pathApi.join(root, 'state'),
    managedRoot,
    defaultWorkspace: pathApi.join(managedRoot, 'default'),
  })
}

export function resolveDesktopConfig({
  settings = {},
  environment = {},
  home,
  platform,
  pathApi,
  canonicalize = value => pathApi.resolve(value),
}) {
  const defaults = productPaths({ home, pathApi })
  const settingsBinary = nonempty(settings.codexBinaryPath)
  const environmentBinary = nonempty(environment.NOVA_AUDIO_AGENT_CODEX_BIN)
  const binaryPath = settingsBinary || environmentBinary || ''
  const settingsMode = settings.codexBinaryMode === 'manual' ? 'manual' : 'auto'
  const codexBinaryMode = settingsBinary || environmentBinary ? 'manual' : settingsMode
  const managedRoot = nonempty(settings.codexManagedRoot)
    || nonempty(environment.NOVA_AUDIO_AGENT_CODEX_MANAGED_ROOT)
    || defaults.managedRoot
  const workspace = nonempty(settings.codexWorkspace)
    || nonempty(environment.NOVA_AUDIO_AGENT_CODEX_WORKSPACE)
    || defaults.defaultWorkspace
  const codexProjectsEnabled = typeof settings.codexProjectsEnabled === 'boolean'
    ? settings.codexProjectsEnabled
    : envBoolean(environment.NOVA_AUDIO_AGENT_CODEX_PROJECTS_ENABLED, false)
  const modelBaseUrl = nonempty(settings.modelBaseUrl)
    || nonempty(environment.NOVA_AUDIO_AGENT_MODEL_BASE_URL)
    || ''

  void platform
  return Object.freeze({
    root: canonicalize(defaults.root),
    stateRoot: canonicalize(defaults.stateRoot),
    managedRoot: canonicalize(managedRoot),
    workspace: canonicalize(workspace),
    codexBinaryMode,
    codexBinaryPath: binaryPath === '' ? '' : canonicalize(binaryPath),
    codexProjectsEnabled,
    modelBaseUrl,
    startListeningOnLaunch: settings.startListeningOnLaunch === true,
  })
}
