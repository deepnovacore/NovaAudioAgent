import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {realpathSync} from 'node:fs'
import {isAbsolute, resolve} from 'node:path'

const PREFLIGHT_FAILURES = [
  'binary_missing', 'credential_missing', 'preflight_failed', 'preflight_timeout',
  'sandbox_failed', 'spawn_failed', 'stderr_too_large', 'unsupported_protocol',
  'unsupported_version', 'workspace_invalid', 'workspace_root_mismatch',
]
const FAILURE_STAGES = new Set([
  'load_runtime', 'settings_project', 'host_project', 'host_project_transport',
  'host_project_native', 'host_project_config', 'resource_project',
  'start_project', 'close_project', 'resource_without_project_host',
  ...PREFLIGHT_FAILURES.map(code => `start_project_${code}`),
])

export function parsePackagedCodexFailure(stderr) {
  if (typeof stderr !== 'string' || Buffer.byteLength(stderr, 'utf8') > 4096) return 'unknown'
  const matches = stderr.split('\n').map(line => (
    /^packaged production Codex composition rejected stage=([a-z_]+)$/u.exec(line)
  )).filter(value => value !== null)
  return matches.length === 1 && FAILURE_STAGES.has(matches[0][1]) ? matches[0][1] : 'unknown'
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null
}

export function runPackagedCodexCompositionSmoke({
  distRoot,
  binary,
  workspace,
  platform = process.platform,
  arch = process.arch,
}) {
  for (const path of [distRoot, binary, workspace]) {
    assert.ok(typeof path === 'string' && isAbsolute(path), 'packaged_codex_smoke_invalid')
    assert.equal(realpathSync(path), path, 'packaged_codex_smoke_invalid')
  }
  const {executable, resourcesRoot} = packagedLayout({distRoot, platform, arch})
  const harness = resolve(import.meta.dirname, 'packaged-production-codex-smoke.cjs')
  const result = spawnSync(executable, [harness, resourcesRoot, binary, workspace], {
    cwd: workspace,
    encoding: 'utf8',
    env: {...process.env, ELECTRON_RUN_AS_NODE: '1'},
    timeout: 60_000,
    maxBuffer: 64 * 1024,
  })
  if (
    result.error !== undefined
    || result.status !== 0
    || result.stdout !== 'packaged production Codex composition passed\n'
  ) {
    const stage = parsePackagedCodexFailure(result.stderr)
    const error = new Error(`packaged production Codex composition rejected stage=${stage}`)
    error.code = stage
    throw error
  }
}

export function packagedLayout({distRoot, platform, arch}) {
  let executable
  let resourcesRoot
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
    const output = resolve(distRoot, arch === 'arm64' ? 'mac-arm64' : 'mac')
    const app = resolve(output, 'Nova Audio Agent Ambient Orb.app')
    executable = resolve(app, 'Contents/MacOS/Nova Audio Agent Ambient Orb')
    resourcesRoot = resolve(app, 'Contents/Resources')
  } else if (platform === 'win32' && arch === 'x64') {
    const output = resolve(distRoot, 'win-unpacked')
    executable = resolve(output, 'Nova Audio Agent Ambient Orb.exe')
    resourcesRoot = resolve(output, 'resources')
  } else if (platform === 'linux' && arch === 'x64') {
    const output = resolve(distRoot, 'linux-unpacked')
    executable = resolve(output, 'nova-ambient-orb')
    resourcesRoot = resolve(output, 'resources')
  } else {
    throw new Error('packaged_codex_smoke_invalid')
  }
  assert.equal(realpathSync(executable), executable, 'packaged_codex_smoke_invalid')
  assert.equal(realpathSync(resourcesRoot), resourcesRoot, 'packaged_codex_smoke_invalid')
  return Object.freeze({executable, resourcesRoot})
}

if (resolve(process.argv[1] ?? '') === resolve(import.meta.filename)) {
  const distRoot = option('--dist-root')
  const binary = option('--binary') ?? process.env.NOVA_AUDIO_AGENT_RELEASE_CODEX_BIN ?? null
  const workspace = option('--workspace') ?? process.env.GITHUB_WORKSPACE ?? null
  if ([distRoot, binary, workspace].some(value => value === null)) {
    process.stderr.write('packaged production Codex composition rejected\n')
    process.exitCode = 1
  } else {
    try {
      runPackagedCodexCompositionSmoke({
        distRoot: realpathSync(distRoot),
        binary: realpathSync(binary),
        workspace: realpathSync(workspace),
      })
      process.stdout.write('packaged production Codex composition passed\n')
    } catch {
      process.stderr.write('packaged production Codex composition rejected\n')
      process.exitCode = 1
    }
  }
}
