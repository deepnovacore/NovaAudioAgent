import {
  codexCandidates,
  resolveDesktopCodex,
} from './codex-discovery.mjs'
import {
  ensureProductDirectories,
  resolveDesktopConfig,
} from './platform-config.mjs'

const PROBE_ENV_KEYS = Object.freeze([
  'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'TMP', 'TEMP',
])

export function inspectCodexVersion(invocation, { environment = {}, run }) {
  const env = {}
  for (const key of PROBE_ENV_KEYS) {
    if (typeof environment[key] === 'string') env[key] = environment[key]
  }
  const result = run(invocation.command, [...invocation.prefixArgs, '--version'], {
    encoding: 'utf8',
    env,
    timeout: 5_000,
    maxBuffer: 64 * 1_024,
    windowsHide: true,
  })
  if (result?.status !== 0 || typeof result.stdout !== 'string') return null
  return Object.freeze({ version: result.stdout.trim() })
}

export function canonicalInstalledExecutable(candidate, {
  platform,
  realpath,
  stat,
  access,
}) {
  try {
    const canonical = realpath(candidate)
    if (!stat(canonical).isFile()) return null
    const lower = canonical.toLowerCase()
    if (lower.endsWith('.cmd') || lower.endsWith('.bat') || lower.endsWith('.ps1')) return null
    if (platform === 'win32' && !lower.endsWith('.exe')) return null
    if (platform !== 'win32') access(canonical)
    return canonical
  } catch {
    return null
  }
}

export function canonicalInstalledInvocation(candidate, dependencies) {
  if (!candidate || typeof candidate !== 'object' || !Array.isArray(candidate.prefixArgs)) return null
  if (candidate.kind === 'native') {
    const command = canonicalInstalledExecutable(candidate.command, dependencies)
    return command === null ? null : Object.freeze({command, prefixArgs: Object.freeze([])})
  }
  if (candidate.kind !== 'npm-launcher' || dependencies.platform !== 'win32'
    || candidate.prefixArgs.length !== 1) return null
  try {
    const {pathApi, realpath, stat, readFile} = dependencies
    const command = canonicalInstalledExecutable(candidate.command, dependencies)
    if (command === null) return null
    const launcher = realpath(candidate.launcherPath)
    if (!launcher.toLowerCase().endsWith('codex.cmd') || !stat(launcher).isFile()) return null
    const packageRoot = realpath(candidate.packageRoot)
    if (!stat(packageRoot).isDirectory()) return null
    const manifest = realpath(candidate.manifestPath)
    if (manifest !== pathApi.join(packageRoot, 'package.json') || !stat(manifest).isFile()) return null
    const parsed = JSON.parse(readFile(manifest, 'utf8'))
    const bin = typeof parsed?.bin === 'string' ? parsed.bin : parsed?.bin?.codex
    if (parsed?.name !== '@openai/codex' || bin !== 'bin/codex.js') return null
    const entry = realpath(candidate.prefixArgs[0])
    if (entry !== pathApi.join(packageRoot, 'bin', 'codex.js') || !stat(entry).isFile()) return null
    const relative = pathApi.relative(packageRoot, entry)
    if (relative === '' || relative === '..' || relative.startsWith(`..${pathApi.sep}`)
      || pathApi.isAbsolute(relative)) return null
    return Object.freeze({command, prefixArgs: Object.freeze([entry])})
  } catch {
    return null
  }
}

export async function prepareDesktopStartup({
  settings,
  environment,
  home,
  platform,
  arch,
  pathApi,
  canonicalizePath,
  canonicalizeExecutable,
  canonicalizeInvocation,
  mkdir,
  inspectCodex,
  ensureDirectories = config => ensureProductDirectories(config, { mkdir, pathApi }),
}) {
  const config = resolveDesktopConfig({
    settings,
    environment,
    home,
    platform,
    pathApi,
    canonicalize: canonicalizePath,
  })
  await ensureDirectories(config)
  const { config: resolved, status } = await resolveDesktopCodex({
    config,
    automaticCandidates: codexCandidates({
      platform,
      arch,
      env: environment,
      home,
      pathApi,
    }),
    canonicalize: canonicalizeInvocation ?? (candidate => {
      const command = canonicalizeExecutable(candidate.command)
      return command === null ? null : {command, prefixArgs: candidate.prefixArgs}
    }),
    inspect: inspectCodex,
  })
  return Object.freeze({ config: resolved, codexStatus: status })
}
