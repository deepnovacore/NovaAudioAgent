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

export function inspectCodexVersion(binary, { environment = {}, run }) {
  const env = {}
  for (const key of PROBE_ENV_KEYS) {
    if (typeof environment[key] === 'string') env[key] = environment[key]
  }
  const result = run(binary, ['--version'], {
    encoding: 'utf8',
    env,
    timeout: 5_000,
    maxBuffer: 1_024,
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
    if (platform !== 'win32') access(canonical)
    return canonical
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
    canonicalize: canonicalizeExecutable,
    inspect: inspectCodex,
  })
  return Object.freeze({ config: resolved, codexStatus: status })
}
