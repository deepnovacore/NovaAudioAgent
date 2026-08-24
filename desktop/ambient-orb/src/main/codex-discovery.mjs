const SOURCES = new Set(['path', 'npm-user', 'common', 'manual'])
const VERSION = /^[^\u0000-\u001f\u007f]{1,128}$/u

function append(target, seen, path, source) {
  if (typeof path !== 'string' || path === '' || seen.has(path)) return
  seen.add(path)
  target.push(Object.freeze({ path, source }))
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
  for (const entry of String(env.PATH ?? '').split(delimiter).filter(Boolean)) {
    if (platform === 'win32') {
      append(candidates, seen, pathApi.join(entry, 'codex.exe'), 'path')
      append(candidates, seen, pathApi.join(entry, 'codex'), 'path')
    } else {
      append(candidates, seen, pathApi.join(entry, 'codex'), 'path')
    }
  }
  if (platform === 'win32') {
    const appData = typeof env.APPDATA === 'string' && env.APPDATA !== ''
      ? env.APPDATA
      : pathApi.join(home, 'AppData', 'Roaming')
    const npmRoot = pathApi.join(appData, 'npm')
    for (const path of windowsNpmCandidates({ root: npmRoot, arch, pathApi })) {
      append(candidates, seen, path, 'npm-user')
    }
  } else {
    append(candidates, seen, pathApi.join(home, '.local', 'bin', 'codex'), 'common')
    if (platform === 'darwin') append(candidates, seen, '/opt/homebrew/bin/codex', 'common')
    append(candidates, seen, '/usr/local/bin/codex', 'common')
  }
  return Object.freeze(candidates)
}

function missing() {
  return Object.freeze({ status: 'missing', path: null, source: null, version: null })
}

export async function discoverCodex({ candidates, canonicalize, inspect }) {
  if (!Array.isArray(candidates)) return missing()
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || !SOURCES.has(candidate.source)) continue
    let canonical
    try {
      canonical = canonicalize(candidate.path)
    } catch {
      continue
    }
    if (typeof canonical !== 'string' || canonical === '') continue
    try {
      const result = await inspect(canonical)
      if (!result || typeof result !== 'object' || !VERSION.test(result.version)) continue
      return Object.freeze({
        status: 'ready',
        path: canonical,
        source: candidate.source,
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
    ? [Object.freeze({ path: config.codexBinaryPath, source: 'manual' })]
    : automaticCandidates
  const status = await discoverCodex({ candidates, canonicalize, inspect })
  return Object.freeze({
    config: Object.freeze({
      ...config,
      codexBinaryPath: status.status === 'ready' ? status.path : '',
    }),
    status,
  })
}
