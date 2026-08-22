import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {realpathSync} from 'node:fs'
import {isAbsolute, resolve} from 'node:path'

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
  ) throw new Error('packaged production Codex composition rejected')
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
