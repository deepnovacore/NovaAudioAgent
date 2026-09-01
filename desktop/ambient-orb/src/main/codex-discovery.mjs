const SOURCES = new Set(['path', 'npm-user', 'common', 'manual', 'npm-launcher'])
const VERSION = /^[^\u0000-\u001f\u007f]{1,128}$/u

function appendNative(target, seen, command, source) {
  if (typeof command !== 'string' || command === '') return
  const key = `native\0${command}`
  if (seen.has(key)) return
  seen.add(key)
  target.push(Object.freeze({
    kind: 'native', command, prefixArgs: Object.freeze([]), source,
  }))
}

function appendNpmLauncher(target, seen, candidate) {
  const key = `npm-launcher\0${candidate.command}\0${candidate.prefixArgs.join('\0')}`
  if (seen.has(key)) return
  seen.add(key)
  target.push(Object.freeze({
    ...candidate,
    kind: 'npm-launcher',
    prefixArgs: Object.freeze([...candidate.prefixArgs]),
    source: 'npm-launcher',
  }))
}

function windowsNpmCandidates({ root, arch, pathApi }) {
  const packageArch = arch === 'arm64' ? 'arm64' : 'x64'
  const triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  const platformPackage = `codex-win32-${packageArch}`
  const packageRoots = [
    pathApi.join(root, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', platformPackage),
    pathApi.join(root, 'node_modules', '@openai', platformPackage),
  ]
  return packageRoots.flatMap(packageRoot => [
    pathApi.join(packageRoot, 'vendor', triple, 'codex', 'codex.exe'),
    pathApi.join(packageRoot, 'vendor', triple, 'bin', 'codex.exe'),
  ])
}

export function codexCandidates({ platform, arch, env = {}, home, pathApi }) {
  const candidates = []
  const seen = new Set()
  const delimiter = platform === 'win32' ? ';' : ':'
  const pathEntries = String(env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const entry of pathEntries) {
    if (platform === 'win32') {
      appendNative(candidates, seen, pathApi.join(entry, 'codex.exe'), 'path')
      appendNative(candidates, seen, pathApi.join(entry, 'codex'), 'path')
    } else {
      appendNative(candidates, seen, pathApi.join(entry, 'codex'), 'path')
    }
  }
  if (platform === 'win32') {
    const appData = typeof env.APPDATA === 'string' && env.APPDATA !== ''
      ? env.APPDATA
      : pathApi.join(home, 'AppData', 'Roaming')
    const npmRoot = pathApi.join(appData, 'npm')
    for (const command of windowsNpmCandidates({ root: npmRoot, arch, pathApi })) {
      appendNative(candidates, seen, command, 'npm-user')
    }
    const packageRoot = pathApi.join(npmRoot, 'node_modules', '@openai', 'codex')
    for (const entry of pathEntries) {
      appendNpmLauncher(candidates, seen, {
        command: pathApi.join(entry, 'node.exe'),
        prefixArgs: [pathApi.join(packageRoot, 'bin', 'codex.js')],
        packageRoot,
        manifestPath: pathApi.join(packageRoot, 'package.json'),
        launcherPath: pathApi.join(npmRoot, 'codex.cmd'),
      })
    }
  } else {
    appendNative(candidates, seen, pathApi.join(home, '.local', 'bin', 'codex'), 'common')
    if (platform === 'darwin') {
      appendNative(candidates, seen, pathApi.join(home, '.npm-global', 'bin', 'codex'), 'npm-user')
      appendNative(candidates, seen, pathApi.join(home, '.volta', 'bin', 'codex'), 'npm-user')
      appendNative(candidates, seen, '/opt/homebrew/bin/codex', 'common')
    }
    appendNative(candidates, seen, '/usr/local/bin/codex', 'common')
  }
  return Object.freeze(candidates)
}

function missing() {
  return Object.freeze({
    status: 'missing', invocation: null, path: null, prefixArgs: null,
    source: null, version: null,
  })
}

function safeInvocation(value) {
  if (!value || typeof value !== 'object' || typeof value.command !== 'string'
    || value.command === '' || !Array.isArray(value.prefixArgs)
    || value.prefixArgs.some(arg => typeof arg !== 'string' || arg === '')) return null
  return Object.freeze({
    command: value.command,
    prefixArgs: Object.freeze([...value.prefixArgs]),
  })
}

export async function discoverCodex({ candidates, canonicalize, inspect }) {
  if (!Array.isArray(candidates)) return missing()
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || !SOURCES.has(candidate.source)) continue
    let invocation
    try {
      invocation = safeInvocation(canonicalize(candidate))
    } catch {
      continue
    }
    if (invocation === null) continue
    try {
      const result = await inspect(invocation)
      if (!result || typeof result !== 'object' || !VERSION.test(result.version)) continue
      return Object.freeze({
        status: 'ready', invocation, path: invocation.command,
        prefixArgs: invocation.prefixArgs, source: candidate.source,
        version: result.version,
      })
    } catch {
      // A candidate that cannot answer the bounded version probe is not usable.
    }
  }
  return missing()
}

export async function resolveDesktopCodex({
  config,
  automaticCandidates,
  canonicalize,
  inspect,
}) {
  const manual = config?.codexBinaryMode === 'manual'
    && typeof config.codexBinaryPath === 'string'
    && config.codexBinaryPath !== ''
  const candidates = manual
    ? [Object.freeze({
        kind: 'native', command: config.codexBinaryPath,
        prefixArgs: Object.freeze([]), source: 'manual',
      })]
    : automaticCandidates
  const status = await discoverCodex({ candidates, canonicalize, inspect })
  return Object.freeze({
    config: Object.freeze({
      ...config,
      codexBinaryPath: status.status === 'ready' ? status.invocation.command : '',
      codexBinaryPrefixArgs: status.status === 'ready'
        ? status.invocation.prefixArgs
        : Object.freeze([]),
    }),
    status,
  })
}
