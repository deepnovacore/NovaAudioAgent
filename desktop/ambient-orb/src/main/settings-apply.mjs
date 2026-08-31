const CONFIG_KEYS = Object.freeze([
  'root',
  'stateRoot',
  'managedRoot',
  'workspace',
  'codexBinaryMode',
  'codexBinaryPath',
  'codexConfigurationError',
  'modelBaseUrl',
  'modelConfigurationError',
  'startListeningOnLaunch',
])

const CODEX_STATUS_KEYS = Object.freeze([
  'status',
  'path',
  'source',
  'version',
])

function rejectedSecretNames(written) {
  if (!Array.isArray(written?.rejectedSecrets)) return Object.freeze([])
  return Object.freeze(written.rejectedSecrets.filter(name => typeof name === 'string'))
}

function result(saved, operationStatus, rejectedSecrets) {
  return Object.freeze({saved, operationStatus, rejectedSecrets})
}

export async function applySettingsTransaction({
  coordinator,
  patch,
  write,
  publishCommitted,
  prepareConfiguration,
  commitConfiguration,
  discardConfiguration = async () => {},
  restartBackend,
  publishStatus,
}) {
  const coordinated = await coordinator.run('settings_save', async () => {
    publishStatus('saving')
    let written
    try {
      written = await write(patch)
    } catch {
      publishStatus('failed')
      return result(false, 'failed', Object.freeze([]))
    }

    const rejectedSecrets = rejectedSecretNames(written)
    publishCommitted(written)
    publishStatus('refreshing')
    let prepared
    let preparedOwned = false
    try {
      prepared = await prepareConfiguration()
      preparedOwned = true
      await commitConfiguration(prepared)
      preparedOwned = false
    } catch {
      if (preparedOwned) await discardConfiguration(prepared).catch(() => undefined)
      publishStatus('failed')
      return result(true, 'failed', rejectedSecrets)
    }

    publishStatus('restarting')
    try {
      await restartBackend()
    } catch {
      publishStatus('restart_failed')
      return result(true, 'restart_failed', rejectedSecrets)
    }
    publishStatus('applied')
    return result(true, 'applied', rejectedSecrets)
  })
  return coordinated.status === 'busy'
    ? result(false, 'busy', Object.freeze([]))
    : coordinated.value
}

export async function coordinateCodexRescan({
  coordinator,
  currentConfiguration,
  prepareConfiguration,
  commitConfiguration,
  discardConfiguration = async () => {},
  restartBackend,
  view,
}) {
  const coordinated = await coordinator.run('codex_rescan', async () => {
    const previous = currentConfiguration()
    let prepared
    let committed = false
    let changed = false
    try {
      prepared = await prepareConfiguration()
      changed = !sameBackendLaunchConfiguration(previous, prepared)
      await commitConfiguration(prepared)
      committed = true
    } finally {
      if (prepared !== undefined && !committed) await discardConfiguration(prepared)
    }
    if (changed) await restartBackend()
  })

  // `coordinator.run()` releases lifecycle ownership in its finally block.
  // Capture the reply only after that release, otherwise an older busy view can
  // arrive after the coordinator's idle push and leave the panel disabled.
  const settled = view()
  return coordinated.status === 'busy'
    ? {...settled, operationStatus: 'busy'}
    : settled
}

function selected(source, keys) {
  const output = {}
  for (const key of keys) output[key] = source?.[key] ?? null
  return output
}

function launchConfigurationFingerprint(prepared) {
  const status = selected(prepared?.codexStatus, CODEX_STATUS_KEYS)
  status.prefixArgs = Array.isArray(prepared?.codexStatus?.prefixArgs)
    ? [...prepared.codexStatus.prefixArgs]
    : null
  status.invocation = prepared?.codexStatus?.invocation === null
    || prepared?.codexStatus?.invocation === undefined
    ? null
    : {
        command: prepared.codexStatus.invocation.command ?? null,
        prefixArgs: Array.isArray(prepared.codexStatus.invocation.prefixArgs)
          ? [...prepared.codexStatus.invocation.prefixArgs]
          : null,
      }
  return JSON.stringify({config: selected(prepared?.config, CONFIG_KEYS), codexStatus: status})
}

export function sameBackendLaunchConfiguration(left, right) {
  return launchConfigurationFingerprint(left) === launchConfigurationFingerprint(right)
}
