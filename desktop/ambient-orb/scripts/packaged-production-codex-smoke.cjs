'use strict'

const assert = require('node:assert/strict')
const {randomUUID} = require('node:crypto')
const {chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync} = require('node:fs')
const {tmpdir} = require('node:os')
const {isAbsolute, join, resolve, sep} = require('node:path')
const {pathToFileURL} = require('node:url')

const SAFE_PREFLIGHT_CODES = new Set([
  'binary_missing', 'credential_missing', 'preflight_failed', 'preflight_timeout',
  'sandbox_failed', 'spawn_failed', 'stderr_too_large', 'unsupported_protocol',
  'unsupported_version', 'workspace_invalid', 'workspace_root_mismatch',
])

const resourcesRoot = process.argv[2]
const binary = process.argv[3]
const workspace = process.argv[4]
assert.ok(typeof resourcesRoot === 'string' && isAbsolute(resourcesRoot), 'packaged_codex_host_invalid')
assert.ok(typeof binary === 'string' && isAbsolute(binary), 'packaged_codex_host_invalid')
assert.ok(typeof workspace === 'string' && isAbsolute(workspace), 'packaged_codex_host_invalid')
assert.equal(realpathSync(resourcesRoot), resourcesRoot, 'packaged_codex_host_invalid')
assert.equal(realpathSync(binary), binary, 'packaged_codex_host_invalid')
assert.equal(realpathSync(workspace), workspace, 'packaged_codex_host_invalid')
assert.equal(process.resourcesPath, resourcesRoot, 'packaged_codex_host_invalid')

const runtimeRoot = resolve(
  resourcesRoot,
  'app.asar',
  'node_modules',
  '@nova-audio-agent',
  'runtime',
  'dist',
  'src',
)
assert.ok(runtimeRoot.includes(`${sep}app.asar${sep}`), 'packaged_codex_host_invalid')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'nova-packaged-codex-composition-')))
const stateRoot = join(scratch, 'state')
const managedRoot = join(scratch, 'managed')
mkdirSync(stateRoot, {mode: 0o700})
mkdirSync(managedRoot, {mode: 0o700})
chmodSync(scratch, 0o700)

let stage = 'load_runtime'
void (async () => {
  const [configModule, hostConfigModule, factoryModule, productionHostModule, clockModule] = (
    await Promise.all([
      'config.js',
      'codex-host-config.js',
      'codex-factory.js',
      'codex-production-host.js',
      'clock.js',
    ].map(name => import(pathToFileURL(resolve(runtimeRoot, name)).href)))
  )
  stage = 'settings_project'
  const baseEnvironment = {
    ...process.env,
    NOVA_AUDIO_AGENT_EXECUTOR: 'codex',
    NOVA_AUDIO_AGENT_EXECUTORS: 'codex',
    NOVA_AUDIO_AGENT_CODEX_BIN: binary,
    NOVA_AUDIO_AGENT_CODEX_WORKSPACE: workspace,
    NOVA_AUDIO_AGENT_CODEX_PREWARM: 'false',
  }
  const projectSettings = configModule.loadSettings({
    ...baseEnvironment,
    NOVA_AUDIO_AGENT_CODEX_PROJECT_STATE_ROOT: stateRoot,
    NOVA_AUDIO_AGENT_CODEX_MANAGED_ROOT: managedRoot,
  })
  stage = 'host_project'
  const projectHost = productionHostModule.createProductionCodexHost(projectSettings)
  stage = 'host_project_transport'
  assert.equal(projectHost.transportFactory.available, true, 'packaged_codex_transport_unavailable')
  stage = 'host_project_native'
  assert.notEqual(projectHost.projectHost, null, 'packaged_project_native_unavailable')
  stage = 'host_project_config'
  const projectConfig = hostConfigModule.resolveCodexHostConfig(projectSettings, projectHost.catalog)
  assert.notEqual(projectConfig, null, 'packaged_codex_config_unavailable')
  stage = 'resource_project'
  const projectResource = await factoryModule.createCodexAssemblyResource({
    config: projectConfig,
    composition: 'realtime',
    transportFactory: projectHost.transportFactory,
    projectHost: projectHost.projectHost,
    clock: new clockModule.RealClock(),
    idFactory: () => randomUUID().replaceAll('-', ''),
  })
  assert.equal(projectResource.mode, 'project', 'packaged_project_mode_unavailable')
  let projectStartRejected = false
  try {
    stage = 'start_project'
    await projectResource.start()
  } catch (error) {
    projectStartRejected = SAFE_PREFLIGHT_CODES.has(error?.code) ? error.code : true
  }
  stage = 'close_project'
  try { await projectResource.close() } catch {
    if (!projectStartRejected) throw new Error('packaged_project_close_rejected')
  }
  if (projectStartRejected) {
    stage = typeof projectStartRejected === 'string'
      ? `start_project_${projectStartRejected}`
      : 'start_project'
    throw new Error('packaged_project_start_rejected')
  }

  stage = 'settings_live'
  const liveSettings = configModule.loadSettings({
    ...baseEnvironment,
    NOVA_AUDIO_AGENT_CODEX_PREWARM: 'true',
  })
  stage = 'host_live'
  const liveHost = productionHostModule.createProductionCodexHost(liveSettings)
  const liveConfig = hostConfigModule.resolveCodexHostConfig(liveSettings, liveHost.catalog)
  assert.notEqual(liveConfig, null, 'packaged_codex_config_unavailable')
  stage = 'resource_live'
  const liveResource = await factoryModule.createCodexAssemblyResource({
    config: liveConfig,
    composition: 'realtime',
    transportFactory: liveHost.transportFactory,
    clock: new clockModule.RealClock(),
    idFactory: () => randomUUID().replaceAll('-', ''),
  })
  assert.equal(liveResource.mode, 'live', 'packaged_codex_transport_unavailable')
  let liveStartRejected = false
  try {
    stage = 'start_live'
    await liveResource.start()
  } catch (error) {
    liveStartRejected = SAFE_PREFLIGHT_CODES.has(error?.code) ? error.code : true
  }
  stage = 'close_live'
  try { await liveResource.close() } catch {
    if (!liveStartRejected) throw new Error('packaged_live_close_rejected')
  }
  if (liveStartRejected) {
    stage = typeof liveStartRejected === 'string'
      ? `start_live_${liveStartRejected}`
      : 'start_live'
    throw new Error('packaged_live_start_rejected')
  }
  process.stdout.write('packaged production Codex composition passed\n')
})().catch(() => {
  process.stderr.write(`packaged production Codex composition rejected stage=${stage}\n`)
  process.exitCode = 1
}).finally(() => {
  rmSync(scratch, {recursive: true, force: true})
})
