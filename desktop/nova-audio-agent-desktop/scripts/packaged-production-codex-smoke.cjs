'use strict'

const assert = require('node:assert/strict')
const {randomUUID} = require('node:crypto')
const {chmodSync, mkdtempSync, realpathSync, rmSync} = require('node:fs')
const {mkdir} = require('node:fs/promises')
const path = require('node:path')
const {isAbsolute, join, resolve, sep} = path
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
let stage = 'load_runtime'
let scratch = null

function directoryLabel(target, directories) {
  if (target === directories.scratch) return 'home'
  if (target === directories.projectRoot) return 'root'
  if (target === directories.stateRoot) return 'state'
  if (target === directories.managedRoot) return 'managed'
  if (target === join(directories.managedRoot, 'default')) return 'workspace'
  return 'external'
}

function childLabel(name) {
  if (name === '.nova-audio-agent') return 'root'
  if (name === 'state') return 'state'
  if (name === 'workspaces') return 'managed'
  if (name === 'default') return 'workspace'
  return 'external'
}

function diagnosticDirectoryHost(host, directories) {
  return Object.freeze({
    ...host,
    directoryHandles: Object.freeze({
      open(target) {
        stage = `host_project_directories_open_${directoryLabel(target, directories)}`
        return host.directoryHandles.open(target)
      },
    }),
    rootFiles: Object.freeze({
      ...host.rootFiles,
      mkdirAt(root, name) {
        stage = `host_project_directories_create_${childLabel(name)}`
        return host.rootFiles.mkdirAt(root, name)
      },
    }),
    mkdirPrivateAt(root, name) {
      stage = `host_project_directories_create_${childLabel(name)}`
      return host.mkdirPrivateAt(root, name)
    },
    protectDirectoryAt(root, name, child) {
      stage = `host_project_directories_protect_${childLabel(name)}`
      return host.protectDirectoryAt(root, name, child)
    },
  })
}

void (async () => {
  const [
    configModule,
    hostConfigModule,
    factoryModule,
    productionHostModule,
    clockModule,
    projectDirectoriesModule,
    smokeHomeModule,
  ] = await Promise.all([
    ...[
      'config.js',
      'codex-host-config.js',
      'codex-factory.js',
      'codex-production-host.js',
      'clock.js',
    ].map(name => pathToFileURL(resolve(runtimeRoot, name)).href),
    pathToFileURL(resolve(resourcesRoot, 'app.asar', 'src/main/project-directories.mjs')).href,
    pathToFileURL(resolve(__dirname, 'windows-smoke-home.mjs')).href,
  ].map(specifier => import(specifier)))
  stage = 'host_project_home'
  scratch = realpathSync(mkdtempSync(join(
    smokeHomeModule.candidateScratchParent(),
    'nova-packaged-codex-composition-',
  )))
  chmodSync(scratch, 0o700)
  smokeHomeModule.prepareWindowsSmokeHomeOwnership({
    home: scratch,
    environment: process.env,
  })
  const projectRoot = join(scratch, '.nova-audio-agent')
  const stateRoot = join(projectRoot, 'state')
  const managedRoot = join(projectRoot, 'workspaces')
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
  if (process.platform === 'win32') {
    stage = 'host_project_directories'
    const directoryHost = diagnosticDirectoryHost(projectHost.projectHost, {
      scratch, projectRoot, stateRoot, managedRoot,
    })
    await projectDirectoriesModule.ensurePrivateProjectDirectories({
      config: {root: projectRoot, stateRoot, managedRoot, workspace},
      home: scratch,
      platform: process.platform,
      nativeHost: directoryHost,
      pathApi: path,
      mkdir,
    })
  }
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

  stage = 'resource_without_project_host'
  let unsupportedCode = null
  try {
    await factoryModule.createCodexAssemblyResource({
      config: projectConfig,
      composition: 'realtime',
      transportFactory: projectHost.transportFactory,
      clock: new clockModule.RealClock(),
      idFactory: () => randomUUID().replaceAll('-', ''),
    })
  } catch (error) {
    unsupportedCode = error?.code ?? null
  }
  assert.equal(
    unsupportedCode,
    'codex_project_host_unsupported',
    'packaged_project_missing_host_did_not_fail_closed',
  )
  process.stdout.write('packaged production Codex composition passed\n')
})().catch(error => {
  if (
    stage === 'resource_project'
    && typeof error?.code === 'string'
    && [
      'codex_host_unavailable',
      'codex_project_host_unsupported',
      'codex_project_state_invalid',
    ].includes(error.code)
  ) stage = `${stage}_${error.code}`
  process.stderr.write(`packaged production Codex composition rejected stage=${stage}\n`)
  process.exitCode = 1
}).finally(() => {
  if (scratch !== null) rmSync(scratch, {recursive: true, force: true})
})
