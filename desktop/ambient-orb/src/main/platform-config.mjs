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
  const settingsHasMode = Object.hasOwn(settings, 'codexBinaryMode')
  const settingsBinary = nonempty(settings.codexBinaryPath)
  const environmentBinary = nonempty(environment.NOVA_AUDIO_AGENT_CODEX_BIN)
  const settingsMode = settings.codexBinaryMode === 'manual' ? 'manual' : 'auto'
  const codexBinaryMode = settingsHasMode
    ? settingsMode
    : (environmentBinary === null ? 'auto' : 'manual')
  const binaryPath = codexBinaryMode === 'manual'
    ? (settingsHasMode ? settingsBinary : environmentBinary) ?? ''
    : ''
  const codexConfigurationError = codexBinaryMode === 'manual' && binaryPath === ''
    ? 'manual_path_required'
    : null
  const managedRoot = nonempty(settings.codexManagedRoot)
    || nonempty(environment.NOVA_AUDIO_AGENT_CODEX_MANAGED_ROOT)
    || defaults.managedRoot
  const workspace = nonempty(settings.codexWorkspace)
    || nonempty(environment.NOVA_AUDIO_AGENT_CODEX_WORKSPACE)
    || defaults.defaultWorkspace
  const codexProjectsEnabled = typeof settings.codexProjectsEnabled === 'boolean'
    ? settings.codexProjectsEnabled
    : envBoolean(environment.NOVA_AUDIO_AGENT_CODEX_PROJECTS_ENABLED, false)
  const rawModelBaseUrl = nonempty(settings.modelBaseUrl)
    || nonempty(environment.NOVA_AUDIO_AGENT_MODEL_BASE_URL)
    || ''
  const modelBaseUrl = validModelBaseUrl(rawModelBaseUrl)
  const modelConfigurationError = modelBaseUrl === null
    ? 'model_base_url_invalid'
    : null

  void platform
  return Object.freeze({
    root: canonicalize(defaults.root),
    stateRoot: canonicalize(defaults.stateRoot),
    managedRoot: canonicalize(managedRoot),
    workspace: canonicalize(workspace),
    codexBinaryMode,
    codexBinaryPath: binaryPath === '' ? '' : canonicalize(binaryPath),
    codexConfigurationError,
    codexProjectsEnabled,
    modelBaseUrl: modelBaseUrl ?? '',
    modelConfigurationError,
    startListeningOnLaunch: settings.startListeningOnLaunch === true,
  })
}

export async function ensureProductDirectories(config, { mkdir, pathApi }) {
  const directories = [config.root, config.stateRoot, config.managedRoot]
  const relativeWorkspace = pathApi.relative(config.managedRoot, config.workspace)
  if (
    relativeWorkspace !== ''
    && relativeWorkspace !== '..'
    && !relativeWorkspace.startsWith(`..${pathApi.sep}`)
    && !pathApi.isAbsolute(relativeWorkspace)
  ) {
    directories.push(config.workspace)
  }
  for (const directory of directories) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
  }
  return config
}
import { validModelBaseUrl } from './settings-store.mjs'
