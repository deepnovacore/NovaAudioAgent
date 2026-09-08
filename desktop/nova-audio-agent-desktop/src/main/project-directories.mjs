function statusOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const descriptor = Object.getOwnPropertyDescriptor(value, 'status')
  return descriptor?.value === 'ok' || descriptor?.value === 'exists'
    ? descriptor.value
    : null
}

async function openChild(openDirectory, path, stage = null) {
  let handle
  try {
    handle = await openDirectory(path)
  } catch {
    throw new Error(stage === null
      ? 'project_directory_open_failed'
      : `project_directory_open_failed_${stage}`)
  }
  if (!handle || !Number.isInteger(handle.fd) || handle.fd < 0 || typeof handle.close !== 'function') {
    throw new Error(stage === null
      ? 'project_directory_open_failed'
      : `project_directory_open_failed_${stage}`)
  }
  return handle
}

function directoryOpener(nativeHost, injected) {
  if (typeof injected === 'function') return injected
  if (typeof nativeHost?.directoryHandles?.open !== 'function') {
    throw new Error('project_directory_authority_unavailable')
  }
  return target => nativeHost.directoryHandles.open(target)
}

async function closeChild(handle) {
  if (!handle) return
  try { await handle.close() } catch { /* close failure is handled by the owning operation */ }
}

async function ensureChild({parent, name, path, stage, bootstrap, managed, nativeHost, openDirectory}) {
  const created = bootstrap
    ? nativeHost.mkdirPrivateAt(parent.fd, name)
    : nativeHost.rootFiles.mkdirAt(parent.fd, name)
  if (statusOf(created) === null) throw new Error('project_directory_create_failed')
  const child = await openChild(openDirectory, path, stage)
  const protectedDirectory = managed
    ? nativeHost.prepareManagedDirectoryAt(parent.fd, name, child.fd)
    : nativeHost.protectDirectoryAt(parent.fd, name, child.fd)
  if (!protectedDirectory) {
    await closeChild(child)
    throw new Error('project_directory_protection_failed')
  }
  return child
}

export async function ensurePrivateProjectDirectories({
  config,
  home,
  platform,
  nativeHost,
  pathApi,
  openDirectory,
  mkdir,
}) {
  const productRoot = pathApi.resolve(pathApi.join(home, '.nova-audio-agent'))
  if (platform !== 'win32') {
    for (const directory of new Set([
      config.root,
      config.stateRoot,
      config.managedRoot,
      config.workspace,
    ])) {
      await mkdir(directory, {recursive: true, mode: 0o700})
    }
    return config
  }
  if (!nativeHost || config.root !== productRoot) {
    throw new Error('project_directory_authority_unavailable')
  }

  const openNativeDirectory = directoryOpener(nativeHost, openDirectory)
  const homeHandle = await openChild(openNativeDirectory, pathApi.resolve(home), 'home')
  let rootHandle = null
  let workspacesHandle = null
  try {
    rootHandle = await ensureChild({
      parent: homeHandle,
      name: '.nova-audio-agent',
      path: config.root,
      stage: 'root',
      bootstrap: true,
      nativeHost,
      openDirectory: openNativeDirectory,
    })
    const defaultState = pathApi.join(config.root, 'state')
    const defaultManaged = pathApi.join(config.root, 'workspaces')
    const defaultWorkspace = pathApi.join(defaultManaged, 'default')
    if (config.stateRoot === defaultState) {
      const stateHandle = await ensureChild({
        parent: rootHandle,
        name: 'state',
        path: defaultState,
        stage: 'state',
        bootstrap: false,
        nativeHost,
        openDirectory: openNativeDirectory,
      })
      await closeChild(stateHandle)
    }
    workspacesHandle = await ensureChild({
      parent: rootHandle,
      name: 'workspaces',
      path: defaultManaged,
      stage: 'managed',
      bootstrap: false,
      managed: true,
      nativeHost,
      openDirectory: openNativeDirectory,
    })
    const workspaceHandle = await ensureChild({
      parent: workspacesHandle,
      name: 'default',
      path: defaultWorkspace,
      stage: 'workspace',
      bootstrap: false,
      nativeHost,
      openDirectory: openNativeDirectory,
    })
    await closeChild(workspaceHandle)

    const defaults = new Set([config.root, defaultState, defaultManaged, defaultWorkspace])
    for (const directory of [config.stateRoot, config.managedRoot, config.workspace]) {
      if (!defaults.has(directory)) await mkdir(directory, {recursive: true, mode: 0o700})
    }
    return config
  } finally {
    await closeChild(workspacesHandle)
    await closeChild(rootHandle)
    await closeChild(homeHandle)
  }
}

export async function repairProjectDirectory({
  root,
  config,
  nativeHost,
  pathApi,
  openDirectory,
}) {
  const targets = Object.freeze({
    state: config?.stateRoot,
    managed: config?.managedRoot,
    workspace: config?.workspace,
  })
  if (!Object.hasOwn(targets, root) || typeof targets[root] !== 'string' || !nativeHost) {
    return Object.freeze({status: 'failed', code: 'invalid_target'})
  }
  const target = targets[root]
  if (target !== pathApi.resolve(target)) {
    return Object.freeze({status: 'failed', code: 'invalid_target'})
  }
  const parentPath = pathApi.dirname(target)
  const name = pathApi.basename(target)
  let parent = null
  let child = null
  try {
    const openNativeDirectory = directoryOpener(nativeHost, openDirectory)
    parent = await openChild(openNativeDirectory, parentPath)
    child = await openChild(openNativeDirectory, target)
    const repaired = root === 'managed'
      ? nativeHost.prepareManagedDirectoryAt(parent.fd, name, child.fd)
      : nativeHost.protectDirectoryAt(parent.fd, name, child.fd)
    return Object.freeze(repaired
      ? {status: 'ok', code: null}
      : {status: 'failed', code: 'protection_failed'})
  } catch {
    return Object.freeze({status: 'failed', code: 'open_failed'})
  } finally {
    await closeChild(child)
    await closeChild(parent)
  }
}
