import {stat} from 'node:fs/promises'
import {t} from '../renderer/locale.mjs'
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
    if (command === null) return null
    if (dependencies.platform === 'darwin' && command.endsWith('.js')) {
      const native = canonicalDarwinNpmBinary(command, dependencies)
      if (native !== null) return Object.freeze({command: native, prefixArgs: Object.freeze([])})
    }
    return Object.freeze({command, prefixArgs: Object.freeze([])})
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

function canonicalDarwinNpmBinary(entry, dependencies) {
  const {arch, pathApi, realpath, stat, readFile} = dependencies
  if (arch !== 'arm64' && arch !== 'x64') return null
  try {
    const packageRoot = realpath(pathApi.resolve(pathApi.dirname(entry), '..'))
    if (!stat(packageRoot).isDirectory()) return null
    const manifest = realpath(pathApi.join(packageRoot, 'package.json'))
    const parsed = JSON.parse(readFile(manifest, 'utf8'))
    const bin = typeof parsed?.bin === 'string' ? parsed.bin : parsed?.bin?.codex
    if (parsed?.name !== '@openai/codex' || bin !== 'bin/codex.js'
      || entry !== realpath(pathApi.join(packageRoot, bin))) return null
    const platformPackage = `codex-darwin-${arch}`
    const triple = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
    for (const candidateRoot of [
      pathApi.join(packageRoot, 'node_modules', '@openai', platformPackage),
      pathApi.resolve(packageRoot, '..', platformPackage),
    ]) {
      let platformRoot
      try { platformRoot = realpath(candidateRoot) } catch { continue }
      if (!stat(platformRoot).isDirectory()) continue
      const platformManifest = realpath(pathApi.join(platformRoot, 'package.json'))
      const platformPackageJson = JSON.parse(readFile(platformManifest, 'utf8'))
      if (platformPackageJson?.name !== '@openai/codex'
        || !Array.isArray(platformPackageJson.os) || platformPackageJson.os.length !== 1
        || platformPackageJson.os[0] !== 'darwin'
        || !Array.isArray(platformPackageJson.cpu) || platformPackageJson.cpu.length !== 1
        || platformPackageJson.cpu[0] !== arch) continue
      const native = canonicalInstalledExecutable(
        pathApi.join(platformRoot, 'vendor', triple, 'bin', 'codex'),
        dependencies,
      )
      if (native !== null) return native
    }
  } catch {}
  return null
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
  inspectWorkspace = stat,
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
  if (settings.codexWorkspace?.trim() || environment.CODEX_WORKSPACE?.trim()) {
    let workspace
    try { workspace = await inspectWorkspace(config.workspace) }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error?.code)) throw Object.assign(new Error('workspace_not_found'), {code: 'workspace_not_found'})
      throw error
    }
    if (!workspace.isDirectory()) throw Object.assign(new Error('workspace_invalid'), {code: 'workspace_invalid'})
  }
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

export function createLifecycleCoordinator({ onChange = () => {} } = {}) {
  let owner = null

  return Object.freeze({
    get busy() {
      return owner !== null
    },
    get owner() {
      return owner
    },
    async run(kind, operation) {
      if (owner !== null) return Object.freeze({ status: 'busy' })
      owner = kind
      onChange(Object.freeze({ busy: true, owner }))
      try {
        return Object.freeze({ status: 'completed', value: await operation() })
      } finally {
        owner = null
        onChange(Object.freeze({ busy: false, owner: null }))
      }
    },
  })
}

const MESSAGE_CODES = new Set([
  'project_directory_authority_unavailable',
  'project_directory_open_failed',
  'project_directory_open_failed_home',
  'project_directory_open_failed_root',
  'project_directory_open_failed_state',
  'project_directory_open_failed_managed',
  'project_directory_open_failed_workspace',
  'project_directory_create_failed',
  'project_directory_protection_failed',
])

export function startupFailureCode(error) {
  if (['embedding_provider_invalid', 'credential_access_failed', 'credential_invalid', 'startup_presentation_required', 'filesystem_permissions', 'workspace_not_found', 'workspace_invalid', 'state_permissions', 'state_busy', 'state_lock_failed', 'personal_store_locked'].includes(error?.code)) return error.code
  if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) return 'filesystem_permissions'
  if (MESSAGE_CODES.has(error?.message)) return error.message
  if (error?.name === 'MainCameraConfigurationError') return 'camera_configuration_invalid'
  if (error?.message === 'BACKEND must be node') {
    return 'backend_selection_invalid'
  }
  return 'startup_failed'
}

export function reportStartupFailure(error, {
  write = chunk => process.stderr.write(chunk),
  showError,
} = {}) {
  const code = startupFailureCode(error)
  write(`[desktop-diagnostic] startup_failure code=${code}\n`)
  if (code === 'embedding_provider_invalid') {
    showError?.(t("embeddingProvider 仅支持 dashscope，后端未启动，原配置未修改。请在设置文件中明确选择云端服务后再重启。"))
  } else showError?.(t("启动失败，请打开设置检查配置后重试。"))
  return code
}
