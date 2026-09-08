function nonempty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

export function productPaths({ home, pathApi }) {
  const root = pathApi.join(home, '.nova-audio-agent')
  const managedRoot = pathApi.join(root, 'workspaces')
  return Object.freeze({
    root,
    stateRoot: root,
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
  const codexBinaryMode = environmentBinary !== null
    ? 'manual'
    : (settingsHasMode ? settingsMode : 'auto')
  const binaryPath = codexBinaryMode === 'manual'
    ? environmentBinary ?? settingsBinary ?? ''
    : ''
  const codexConfigurationError = codexBinaryMode === 'manual' && binaryPath === ''
    ? 'manual_path_required'
    : null
  const managedRoot = nonempty(settings.codexManagedRoot)
    || nonempty(environment.NOVA_AUDIO_AGENT_CODEX_MANAGED_ROOT)
    || defaults.managedRoot
  const stateRoot = nonempty(environment.NOVA_AUDIO_AGENT_CODEX_PROJECT_STATE_ROOT)
    || defaults.stateRoot
  const workspace = nonempty(settings.codexWorkspace)
    || nonempty(environment.NOVA_AUDIO_AGENT_CODEX_WORKSPACE)
    || defaults.defaultWorkspace
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
    stateRoot: canonicalize(stateRoot),
    managedRoot: canonicalize(managedRoot),
    workspace: canonicalize(workspace),
    codexBinaryMode,
    codexBinaryPath: binaryPath === '' ? '' : canonicalize(binaryPath),
    codexConfigurationError,
    modelBaseUrl: modelBaseUrl ?? '',
    modelConfigurationError,
    startListeningOnLaunch: settings.startListeningOnLaunch === true,
  })
}

export async function ensureProductDirectories(config, { mkdir, pathApi }) {
  const directories = new Set([config.root, config.stateRoot, config.managedRoot])
  const relativeWorkspace = pathApi.relative(config.managedRoot, config.workspace)
  if (
    relativeWorkspace !== ''
    && relativeWorkspace !== '..'
    && !relativeWorkspace.startsWith(`..${pathApi.sep}`)
    && !pathApi.isAbsolute(relativeWorkspace)
  ) {
    directories.add(config.workspace)
  }
  for (const directory of directories) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
  }
  return config
}
import { validModelBaseUrl } from './settings-store.mjs'
