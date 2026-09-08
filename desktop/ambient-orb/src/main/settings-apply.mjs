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

function result(saved, operationStatus, rejectedSecrets, restarted = false) {
  return Object.freeze({saved, operationStatus, rejectedSecrets, restarted})
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
  needsBackendRestart = () => true,
  rollback = async () => {},
  complete = async () => {},
}) {
  const coordinated = await coordinator.run('settings_save', async () => {
    async function failed(status, rejectedSecrets) {
      try {
        await rollback()
      } catch { status = 'recovery_failed' }
      publishCommitted()
      publishStatus(status)
      return result(false, status, rejectedSecrets)
    }
    publishStatus('saving')
    let written
    try {
      written = await write(patch)
    } catch (error) {
      if (error?.code === 'invalid_settings_commit') {
        publishStatus('invalid')
        return {...result(false, 'invalid', Object.freeze([])), problems: error.problems}
      }
      return failed('failed', Object.freeze([]))
    }

    const rejectedSecrets = rejectedSecretNames(written)
    publishCommitted(written)
    if (!needsBackendRestart()) {
      try { await complete() } catch { return failed('failed', rejectedSecrets) }
      publishStatus('applied')
      return result(true, 'applied', rejectedSecrets)
    }
    publishStatus('refreshing')
    let prepared
    let preparedOwned = false
    let committedConfiguration
    try {
      prepared = await prepareConfiguration()
      preparedOwned = true
      committedConfiguration = await commitConfiguration(prepared)
      preparedOwned = false
    } catch {
      if (preparedOwned) await discardConfiguration(prepared).catch(() => undefined)
      return failed('failed', rejectedSecrets)
    }

    publishStatus('restarting')
    try {
      await restartBackend(committedConfiguration)
    } catch {
      return failed('restart_failed', rejectedSecrets)
    }
    try { await complete() } catch { return failed('failed', rejectedSecrets) }
    publishStatus('applied')
    return result(true, 'applied', rejectedSecrets, true)
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
  recoverBackend = restartBackend,
  view,
}) {
  const coordinated = await coordinator.run('codex_rescan', async () => {
    const previous = currentConfiguration()
    let prepared
    let committed = false
    let changed = false
    let committedConfiguration
    try {
      prepared = await prepareConfiguration()
      changed = !sameBackendLaunchConfiguration(previous, prepared)
      committedConfiguration = await commitConfiguration(prepared)
      committed = true
    } finally {
      if (prepared !== undefined && !committed) await discardConfiguration(prepared)
    }
    if (committedConfiguration?.externalWorkspaceReset === true) {
      await recoverBackend()
    } else if (changed) {
      await restartBackend()
    }
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
