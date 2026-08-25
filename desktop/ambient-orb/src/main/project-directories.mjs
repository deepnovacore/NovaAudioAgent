function statusOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const descriptor = Object.getOwnPropertyDescriptor(value, 'status')
  return descriptor?.value === 'ok' || descriptor?.value === 'exists'
    ? descriptor.value
    : null
}

async function openChild(openDirectory, path) {
  const handle = await openDirectory(path)
  if (!handle || !Number.isInteger(handle.fd) || handle.fd < 0 || typeof handle.close !== 'function') {
    throw new Error('project_directory_open_failed')
  }
  return handle
}

async function ensureChild({parent, name, path, bootstrap, nativeHost, openDirectory}) {
  const created = bootstrap
    ? nativeHost.mkdirPrivateAt(parent.fd, name)
    : nativeHost.rootFiles.mkdirAt(parent.fd, name)
  if (statusOf(created) === null) throw new Error('project_directory_create_failed')
  const child = await openChild(openDirectory, path)
  if (!nativeHost.protectDirectoryAt(parent.fd, name, child.fd)) {
    await child.close().catch(() => undefined)
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
    for (const directory of [config.root, config.stateRoot, config.managedRoot, config.workspace]) {
      await mkdir(directory, {recursive: true, mode: 0o700})
    }
    return config
  }
  if (!nativeHost || config.root !== productRoot) {
    throw new Error('project_directory_authority_unavailable')
  }

  const homeHandle = await openChild(openDirectory, pathApi.resolve(home))
  let rootHandle = null
  let workspacesHandle = null
  try {
    rootHandle = await ensureChild({
      parent: homeHandle,
      name: '.nova-audio-agent',
      path: config.root,
      bootstrap: true,
      nativeHost,
      openDirectory,
    })
    const defaultState = pathApi.join(config.root, 'state')
    const defaultManaged = pathApi.join(config.root, 'workspaces')
    const defaultWorkspace = pathApi.join(defaultManaged, 'default')
    const stateHandle = await ensureChild({
      parent: rootHandle,
      name: 'state',
      path: defaultState,
      bootstrap: false,
      nativeHost,
      openDirectory,
    })
    await stateHandle.close()
    workspacesHandle = await ensureChild({
      parent: rootHandle,
      name: 'workspaces',
      path: defaultManaged,
      bootstrap: false,
      nativeHost,
      openDirectory,
    })
    const workspaceHandle = await ensureChild({
      parent: workspacesHandle,
      name: 'default',
      path: defaultWorkspace,
      bootstrap: false,
      nativeHost,
      openDirectory,
    })
    await workspaceHandle.close()

    const defaults = new Set([config.root, defaultState, defaultManaged, defaultWorkspace])
    for (const directory of [config.stateRoot, config.managedRoot, config.workspace]) {
      if (!defaults.has(directory)) await mkdir(directory, {recursive: true, mode: 0o700})
    }
    return config
  } finally {
    await workspacesHandle?.close().catch(() => undefined)
    await rootHandle?.close().catch(() => undefined)
    await homeHandle.close().catch(() => undefined)
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
    parent = await openChild(openDirectory, parentPath)
    child = await openChild(openDirectory, target)
    const repaired = nativeHost.protectDirectoryAt(parent.fd, name, child.fd)
    return Object.freeze(repaired
      ? {status: 'ok', code: null}
      : {status: 'failed', code: 'protection_failed'})
  } catch {
    return Object.freeze({status: 'failed', code: 'open_failed'})
  } finally {
    await child?.close().catch(() => undefined)
    await parent?.close().catch(() => undefined)
  }
}
