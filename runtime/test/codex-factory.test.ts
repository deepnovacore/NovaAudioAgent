import assert from 'node:assert/strict'
import {
  chmodSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test, type TestContext} from 'node:test'

import type {
  CodexAppServerTransport,
  SafePreflightReport,
  SteerTransportResult,
  TransportOutcome,
} from '../src/codex-app-server-transport.js'
import {
  createCodexAssemblyResource,
  OwnedCodexBackendTransportFactory,
  type CodexBackendTransportFactory,
  type CodexTransportBinding,
} from '../src/codex-factory.js'
import {CredentialSnapshotter} from '../src/codex-credential-snapshot.js'
import {hostCodexHomeForTest} from '../src/codex-process-owner.js'
import {resolveCodexHostConfig, type CodexHostCatalog} from '../src/codex-host-config.js'
import {CodexHostConfigurationError} from '../src/codex-host-config.js'
import {VirtualClock} from '../src/clock.js'
import {loadSettings} from '../src/config.js'
import type {ProjectCodexAdapter} from '../src/executors/codex-project-live.js'
import type {NativeFileLockAuthority, NativeFileLockResult} from '../src/native-file-lock.js'
import type {PublicProjectView} from '../src/codex-project-store.js'
import type {
  ProjectFileIdentity,
  ProjectRootFileAuthority,
  ProjectRootFileCreateResult,
  ProjectRootFileLookupResult,
  ProjectRootFileResult,
} from '../src/project-root-file.js'
import {compileToolSchema} from '../src/tool-schema.js'

const PREFLIGHT: SafePreflightReport = Object.freeze({
  version: '0.145.0',
  root_matches: true,
  mount: 'workspace_only',
  subprocess: 'contained',
  network: 'blocked',
})

class RecordingTransport implements CodexAppServerTransport {
  preflights = 0
  prewarms = 0
  closes = 0

  preflight(): Promise<SafePreflightReport> {
    this.preflights += 1
    return Promise.resolve(PREFLIGHT)
  }

  prewarm(): Promise<SafePreflightReport> {
    this.prewarms += 1
    return Promise.resolve(PREFLIGHT)
  }

  run(): Promise<TransportOutcome> {
    return Promise.resolve({
      classification: 'completed',
      code: 'completed',
      turnStartWritten: true,
      completion: {status: 'completed', final_text: 'done', internal_activity: 1},
    })
  }

  steer(): Promise<SteerTransportResult> {
    return Promise.resolve({code: 'no_active_turn', written: false})
  }

  close(): Promise<void> {
    this.closes += 1
    return Promise.resolve()
  }
}

class RecordingTransportFactory implements CodexBackendTransportFactory {
  readonly available = true
  readonly calls: CodexTransportBinding[] = []
  readonly transports: RecordingTransport[] = []

  create(binding: CodexTransportBinding): CodexAppServerTransport {
    this.calls.push(binding)
    const transport = new RecordingTransport()
    this.transports.push(transport)
    return transport
  }
}

class DescriptorLockAuthority implements NativeFileLockAuthority {
  readonly #held = new Set<string>()

  acquire(descriptor: number): NativeFileLockResult {
    const info = fstatSync(descriptor, {bigint: true})
    const key = `${info.dev}:${info.ino}`
    if (this.#held.has(key)) return {status: 'busy'}
    this.#held.add(key)
    return {status: 'acquired', release: () => { this.#held.delete(key) }}
  }
}

/** Test-only descriptor authority. Task 8 still owns the production native helper. */
class DescriptorRootFileAuthority implements ProjectRootFileAuthority {
  readonly #roots = new Map<string, {path: string; readonly parent: string}>()

  constructor(paths: readonly string[]) {
    for (const path of paths) {
      const info = lstatSync(path, {bigint: true})
      this.#roots.set(`${info.dev}:${info.ino}`, {path, parent: join(path, '..')})
    }
  }

  probe(rootDescriptor: number): ProjectRootFileResult {
    try { this.#rootPath(rootDescriptor); return {status: 'ok'} } catch { return {status: 'failed'} }
  }

  matchesAt(rootDescriptor: number, name: string, childDescriptor: number): ProjectRootFileResult {
    try {
      const child = fstatSync(childDescriptor, {bigint: true})
      const root = this.#rootPath(rootDescriptor)
      const path = join(root, name)
      const current = lstatSync(path, {bigint: true})
      if (current.dev !== child.dev || current.ino !== child.ino) return {status: 'mismatch'}
      if (child.isDirectory()) this.#roots.set(`${child.dev}:${child.ino}`, {path, parent: root})
      return {status: 'ok'}
    } catch (error) {
      return isErrno(error, 'ENOENT') ? {status: 'missing'} : {status: 'failed'}
    }
  }

  lookupAt(rootDescriptor: number, name: string): ProjectRootFileLookupResult {
    try {
      const info = lstatSync(join(this.#rootPath(rootDescriptor), name), {bigint: true})
      return {status: 'ok', identity: {device: info.dev, inode: info.ino}}
    } catch (error) {
      return isErrno(error, 'ENOENT') ? {status: 'missing'} : {status: 'failed'}
    }
  }

  createFileAt(rootDescriptor: number, name: string): ProjectRootFileCreateResult {
    try {
      const path = join(this.#rootPath(rootDescriptor), name)
      writeFileSync(path, '', {flag: 'wx', mode: 0o600})
      chmodSync(path, 0o600)
      const info = lstatSync(path, {bigint: true})
      return {status: 'ok', identity: {device: info.dev, inode: info.ino}}
    } catch (error) {
      return isErrno(error, 'EEXIST') ? {status: 'exists'} : {status: 'failed'}
    }
  }

  mkdirAt(rootDescriptor: number, name: string): ProjectRootFileCreateResult {
    try {
      const path = join(this.#rootPath(rootDescriptor), name)
      mkdirSync(path, {mode: 0o700})
      chmodSync(path, 0o700)
      const info = lstatSync(path, {bigint: true})
      return {status: 'ok', identity: {device: info.dev, inode: info.ino}}
    } catch (error) {
      return isErrno(error, 'EEXIST') ? {status: 'exists'} : {status: 'failed'}
    }
  }

  mkdirPrivateAt(rootDescriptor: number, name: string): ProjectRootFileCreateResult {
    return this.mkdirAt(rootDescriptor, name)
  }

  protectAt(
    rootDescriptor: number,
    name: string,
    childDescriptor: number,
  ): ProjectRootFileResult {
    const matched = this.matchesAt(rootDescriptor, name, childDescriptor)
    if (matched.status !== 'ok') return matched
    try {
      chmodSync(join(this.#rootPath(rootDescriptor), name), 0o700)
      return {status: 'ok'}
    } catch {
      return {status: 'failed'}
    }
  }

  renameAt(rootDescriptor: number, from: string, to: string): ProjectRootFileResult {
    try {
      const root = this.#rootPath(rootDescriptor)
      const destination = join(root, to)
      if (process.platform === 'win32') {
        try { unlinkSync(destination) } catch (error) {
          if (!isErrno(error, 'ENOENT')) throw error
        }
      }
      renameSync(join(root, from), destination)
      return {status: 'ok'}
    } catch (error) {
      return isErrno(error, 'ENOENT') ? {status: 'missing'} : {status: 'failed'}
    }
  }

  unlinkAt(
    rootDescriptor: number,
    name: string,
    expected: ProjectFileIdentity,
    kind: 'file' | 'directory',
  ): ProjectRootFileResult {
    try {
      const path = join(this.#rootPath(rootDescriptor), name)
      const current = lstatSync(path, {bigint: true})
      if (current.dev !== expected.device || current.ino !== expected.inode) return {status: 'mismatch'}
      if (kind === 'directory') rmdirSync(path)
      else unlinkSync(path)
      return {status: 'ok'}
    } catch (error) {
      return isErrno(error, 'ENOENT') ? {status: 'missing'} : {status: 'failed'}
    }
  }

  removeTreeAt(
    rootDescriptor: number,
    name: string,
    expected: ProjectFileIdentity,
  ): ProjectRootFileResult {
    try {
      const path = join(this.#rootPath(rootDescriptor), name)
      const current = lstatSync(path, {bigint: true})
      if (current.dev !== expected.device || current.ino !== expected.inode) return {status: 'mismatch'}
      rmSync(path, {recursive: true})
      return {status: 'ok'}
    } catch (error) {
      return isErrno(error, 'ENOENT') ? {status: 'missing'} : {status: 'failed'}
    }
  }

  #rootPath(descriptor: number): string {
    const info = fstatSync(descriptor, {bigint: true})
    const key = `${info.dev}:${info.ino}`
    const root = this.#roots.get(key)
    if (root === undefined) throw new Error('unknown test root descriptor')
    if (samePathIdentity(root.path, info.dev, info.ino)) return root.path
    for (const entry of readdirSync(root.parent)) {
      const candidate = join(root.parent, entry)
      if (samePathIdentity(candidate, info.dev, info.ino)) {
        root.path = candidate
        return candidate
      }
    }
    throw new Error('test root descriptor has no path')
  }
}

function samePathIdentity(path: string, device: bigint, inode: bigint): boolean {
  try {
    const info = lstatSync(path, {bigint: true})
    return !info.isSymbolicLink() && info.dev === device && info.ino === inode
  } catch {
    return false
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}

function hostConfig(t: TestContext): ReturnType<typeof resolveCodexHostConfig> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nova-codex-factory-')))
  const binary = join(root, 'codex-host')
  const workspace = join(root, 'workspace')
  writeFileSync(binary, '#!/fixture\n', {mode: 0o700})
  chmodSync(binary, 0o700)
  mkdirSync(workspace, {mode: 0o700})
  if (process.platform === 'win32') {
    mkdirSync(join(root, '.nova-audio-agent', 'workspaces'), {recursive: true})
  }
  t.after(() => { rmSync(root, {recursive: true, force: true}) })
  const catalog: CodexHostCatalog = {
    canonicalBinaries: [binary],
    canonicalWorkspaces: [workspace],
    defaultBinary: binary,
    homeDirectory: root,
  }
  return resolveCodexHostConfig(loadSettings({
    NOVA_AUDIO_AGENT_EXECUTOR: 'codex',
    NOVA_AUDIO_AGENT_CODEX_WORKSPACE: workspace,
    NOVA_AUDIO_AGENT_CODEX_API_KEY: 'opaque-secret',
  }), catalog)
}

function projectHostConfig(t: TestContext, workspaceName = 'workspace'): {
  readonly config: NonNullable<ReturnType<typeof resolveCodexHostConfig>>
  readonly stateRoot: string
  readonly managedRoot: string
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nova-codex-project-factory-')))
  const binary = join(root, 'codex-host')
  const workspace = join(root, workspaceName)
  const managedRoot = join(root, 'managed')
  const stateRoot = join(root, 'state')
  writeFileSync(binary, '#!/fixture\n', {mode: 0o700})
  chmodSync(binary, 0o700)
  for (const path of [workspace, managedRoot, stateRoot]) {
    mkdirSync(path, {mode: 0o700})
    chmodSync(path, 0o700)
  }
  t.after(() => { rmSync(root, {recursive: true, force: true}) })
  const config = resolveCodexHostConfig(loadSettings({
    NOVA_AUDIO_AGENT_EXECUTOR: 'codex',
    NOVA_AUDIO_AGENT_CODEX_WORKSPACE: workspace,
    NOVA_AUDIO_AGENT_CODEX_MANAGED_ROOT: managedRoot,
    NOVA_AUDIO_AGENT_CODEX_PROJECT_STATE_ROOT: stateRoot,
  }), {
    canonicalBinaries: [binary],
    canonicalWorkspaces: [workspace],
    defaultBinary: binary,
    homeDirectory: root,
  })
  assert.ok(config !== null)
  return {config, stateRoot, managedRoot}
}

test('ordinary composition keeps the non-realtime Codex adapter', async t => {
  const config = hostConfig(t)
  assert.ok(config !== null)

  const ordinaryFactory = new RecordingTransportFactory()
  const ordinary = await createCodexAssemblyResource({
    config,
    composition: 'ordinary',
    transportFactory: ordinaryFactory,
    clock: new VirtualClock(),
    idFactory: () => 'ordinary-id',
  })
  assert.equal(ordinary.mode, 'ordinary')
  assert.deepEqual(ordinary.adapter.manifest.ops.map(operation => operation.name), [
    'run', 'status',
  ])
  assert.equal(ordinaryFactory.calls.length, 1)
  assert.equal(ordinaryFactory.calls[0]?.mode, 'ordinary')
  await ordinary.start()
  assert.equal(ordinaryFactory.transports[0]?.preflights, 1)
  assert.equal(ordinaryFactory.transports[0]?.prewarms, 0)
  await ordinary.close()
  await ordinary.close()
  assert.equal(ordinaryFactory.transports[0]?.closes, 1)

})

test('owned factory removes a preflight-only ephemeral home after transport close', async t => {
  const config = hostConfig(t)
  assert.ok(config !== null)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nova-codex-factory-home-')))
  const home = join(root, 'ephemeral')
  mkdirSync(home, {mode: 0o700})
  t.after(() => { rmSync(root, {recursive: true, force: true}) })
  const credentials = new CredentialSnapshotter({
    environment: {PATH: '/usr/bin:/bin', HOME: root},
  })
  const factory = new OwnedCodexBackendTransportFactory({
    processFactory: {spawn: () => Promise.reject(new Error('must not spawn'))},
    credentialSnapshotter: credentials,
    preflightRunner: {run: () => Promise.resolve(PREFLIGHT)},
    schemaProbe: {generate: () => Promise.resolve({})},
    ephemeralHomeFactory: () => hostCodexHomeForTest(home, {ephemeral: true}),
  })
  const resource = await createCodexAssemblyResource({
    config,
    composition: 'ordinary',
    transportFactory: factory,
    clock: new VirtualClock(),
    idFactory: () => 'ephemeral-cleanup-id',
  })
  await assert.rejects(resource.start())
  await resource.close()
  assert.equal(lstatSync(root).isDirectory(), true)
  assert.throws(() => lstatSync(home), error => isErrno(error, 'ENOENT'))
})

test('realtime composition fails closed when the packaged project host is unavailable', async t => {
  const config = hostConfig(t)
  assert.ok(config !== null)
  await assert.rejects(createCodexAssemblyResource({
    config,
    composition: 'realtime' as const,
    transportFactory: new RecordingTransportFactory(),
    clock: new VirtualClock(),
    idFactory: () => 'unsupported-project-id',
  }), error => error instanceof CodexHostConfigurationError
    && error.code === 'codex_project_host_unsupported')
})

test('configured Codex rejects an unavailable or malformed host transport before adapter registration', async t => {
  const config = hostConfig(t)
  assert.ok(config !== null)
  let unavailableCreates = 0
  for (const transportFactory of [
    {available: false, create: () => { unavailableCreates += 1; return new RecordingTransport() }},
    {available: true, create: () => ({}) as CodexAppServerTransport},
  ]) {
    await assert.rejects(createCodexAssemblyResource({
      config,
      composition: 'ordinary',
      transportFactory,
      clock: new VirtualClock(),
      idFactory: () => 'unavailable-id',
    }), error => error instanceof CodexHostConfigurationError
      && error.code === 'codex_host_unavailable')
  }
  assert.equal(unavailableCreates, 0)
})

test('ordinary composition never upgrades to project mode', async t => {
  const {config} = projectHostConfig(t)
  const transportFactory = new RecordingTransportFactory()
  const resource = await createCodexAssemblyResource({
    config,
    composition: 'ordinary',
    transportFactory,
    clock: new VirtualClock(),
    idFactory: () => 'ordinary-project-setting-id',
  })

  assert.equal(resource.mode, 'ordinary')
  assert.deepEqual(resource.adapter.manifest.ops.map(operation => operation.name), ['run', 'status'])
  assert.equal(transportFactory.calls[0]?.mode, 'ordinary')
  await resource.close()
})

test('realtime mode always opens one project store and exposes only project tools and public view', async t => {
  const {config, stateRoot, managedRoot} = projectHostConfig(t)
  const transportFactory = new RecordingTransportFactory()
  const views: unknown[] = []
  const factoryOptions = {
    config,
    composition: 'realtime' as const,
    transportFactory,
    clock: new VirtualClock(100),
    idFactory: () => 'project-id',
    now: () => 123,
    projectHost: {
      nativeLocks: new DescriptorLockAuthority(),
      rootFiles: new DescriptorRootFileAuthority([stateRoot, managedRoot]),
    },
    onProjectView: (view: PublicProjectView) => { views.push(view) },
  }
  const resource = await createCodexAssemblyResource(factoryOptions)

  assert.equal(resource.mode, 'project')
  assert.deepEqual(resource.adapter.manifest.ops.map(operation => operation.name), [
    'project', 'confirm_project_action', 'steer', 'status',
  ])
  assert.equal(compileToolSchema([resource.adapter.manifest]).bindings.has('codex__run'), false)
  assert.deepEqual(resource.projectView, {
    workspace_display_name: 'workspace',
    session_title: null,
    pending_confirmation: false,
    pending_confirmation_busy: false,
  })
  assert.deepEqual(views.at(-1), resource.projectView)
  const state = JSON.parse(readFileSync(join(stateRoot, 'codex-projects-v1.json'), 'utf8')) as {
    readonly workspaces: Readonly<Record<string, {readonly created_at: number}>>
  }
  assert.equal(Object.values(state.workspaces)[0]?.created_at, 123)
  assert.equal(transportFactory.calls.length, 1, 'startup owns one fixed preflight transport')
  assert.equal(transportFactory.calls[0]?.mode, 'live')
  const projectStart = resource.start()
  assert.equal(resource.start(), projectStart)
  await projectStart
  assert.equal(transportFactory.calls.length, 1, 'project start never prewarms stale session authority')
  assert.equal(transportFactory.transports[0]?.preflights, 1)
  assert.equal(transportFactory.transports[0]?.closes, 1)
  const adapter = resource.adapter as ProjectCodexAdapter
  const closeAdapter = adapter.close.bind(adapter)
  let closeCalls = 0
  Object.defineProperty(adapter, 'close', {value: (): Promise<void> => {
    closeCalls += 1
    return closeCalls === 1
      ? Promise.reject(new Error('retained project cleanup'))
      : closeAdapter()
  }})
  await assert.rejects(resource.close(), /retained project cleanup/u)
  await resource.close()
  assert.equal(closeCalls, 2)
})

test('realtime project startup truncates an imported directory basename to the store limit', async t => {
  const longName = '界'.repeat(81)
  const {config, stateRoot, managedRoot} = projectHostConfig(t, longName)
  const resource = await createCodexAssemblyResource({
    config,
    composition: 'realtime',
    transportFactory: new RecordingTransportFactory(),
    clock: new VirtualClock(100),
    idFactory: () => 'long-name-id',
    projectHost: {
      nativeLocks: new DescriptorLockAuthority(),
      rootFiles: new DescriptorRootFileAuthority([stateRoot, managedRoot]),
    },
  })
  try {
    assert.equal(resource.projectView?.workspace_display_name, '界'.repeat(80))
  } finally {
    await resource.close()
  }
})
