import {prepareManagedCodexMcp} from '../src/executors/codex/managed-mcp.js'
import {parseCapabilityRegistry} from '../src/config/capability-registry.js'
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
} from '../src/executors/codex/app-server-transport.js'
import {CodexTransportError} from '../src/executors/codex/app-server-transport.js'
import {context, runRequest, ProjectTransport, settleWithin} from './fixtures/codex/project-adapter-fixture.js'
import {
  createCodexAssemblyResource,
  OwnedCodexBackendTransportFactory,
  type CodexBackendTransportFactory,
  type CodexTransportBinding,
} from '../src/executors/codex/factory.js'
import {CredentialSnapshotter} from '../src/executors/codex/credential-snapshot.js'
import {hostCodexHomeForTest} from '../src/executors/codex/process-owner.js'
import {resolveCodexHostConfig, type CodexHostCatalog} from '../src/executors/codex/host-config.js'
import {CodexHostConfigurationError} from '../src/executors/codex/host-config.js'
import {HostApprovalController} from '../src/core/approval.js'
import {VirtualClock} from '../src/core/clock.js'
import {loadSettings} from '../src/config/config.js'
import type {ProjectCodexAdapter} from '../src/executors/codex/adapter-project.js'
import type {NativeFileLockAuthority, NativeFileLockResult} from '../src/storage/native-file-lock.js'
import {ProjectStore, ProjectStateError, type PublicProjectView} from '../src/projects/project-store.js'
import type {
  ProjectFileIdentity,
  ProjectRootFileAuthority,
  ProjectRootFileCreateResult,
  ProjectRootFileLookupResult,
  ProjectRootFileResult,
} from '../src/projects/project-root-file.js'
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
    EXECUTOR: 'codex',
    CODEX_WORKSPACE: workspace,
    CODEX_API_KEY: 'opaque-secret',
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
    EXECUTOR: 'codex',
    CODEX_WORKSPACE: workspace,
    CODEX_MANAGED_ROOT: managedRoot,
    CODEX_PROJECT_STATE_ROOT: stateRoot,
    CODEX_PREWARM: 'false',
  }), {
    canonicalBinaries: [binary],
    canonicalWorkspaces: [workspace],
    defaultBinary: binary,
    homeDirectory: root,
  })
  assert.ok(config !== null)
  return {config, stateRoot, managedRoot}
}

test('owned factory removes a preflight-only ephemeral home after transport close', async t => {
  const {config, stateRoot, managedRoot} = projectHostConfig(t)
  const projectHost = {nativeLocks: new DescriptorLockAuthority(), rootFiles: new DescriptorRootFileAuthority([stateRoot, managedRoot])}
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
    composition: 'realtime',
    projectHost,
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
  const {config, stateRoot, managedRoot} = projectHostConfig(t)
  const projectHost = {nativeLocks: new DescriptorLockAuthority(), rootFiles: new DescriptorRootFileAuthority([stateRoot, managedRoot])}
  assert.ok(config !== null)
  let unavailableCreates = 0
  for (const transportFactory of [
    {available: false, create: () => { unavailableCreates += 1; return new RecordingTransport() }},
    {available: true, create: () => ({}) as CodexAppServerTransport},
  ]) {
    await assert.rejects(createCodexAssemblyResource({
      config,
      composition: 'realtime',
      projectHost,
      transportFactory,
      clock: new VirtualClock(),
      idFactory: () => 'unavailable-id',
    }), error => error instanceof CodexHostConfigurationError
      && error.code === 'codex_host_unavailable')
  }
  assert.equal(unavailableCreates, 0)
})


test('realtime mode always opens one project store and exposes only project tools and public view', async t => {
  const {config, stateRoot, managedRoot} = projectHostConfig(t)
  const transportFactory = new RecordingTransportFactory()
  const views: unknown[] = []
  const managedMcp = prepareManagedCodexMcp(parseCapabilityRegistry({version: 1}))
  const factoryOptions = {
    managedMcp,
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
    'run', 'steer', 'status', 'cancel',
  ])
  assert.deepEqual(resource.projectView, {
    workspace_display_name: 'workspace',
    session_title: null,
    roster: [{name: 'workspace', last_used_at: 123, running: []}],
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
  assert.equal(transportFactory.calls[0]?.managedMcp, managedMcp)
  assert.equal(transportFactory.calls[0]?.eagerProgress, config.eagerProgress)
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

test('factory exposes a brokered controller for every foreground project transport', async t => {
  for (const [index, evidence] of [
    {platform: 'win32' as const, broker: true, policy: 'on-request' as const},
    {platform: 'win32' as const, broker: false, policy: 'never' as const},
    {platform: 'darwin' as const, broker: true, policy: 'on-request' as const},
    {platform: 'darwin' as const, broker: false, policy: 'never' as const},
    {platform: 'linux' as const, broker: true, policy: 'on-request' as const},
    {platform: 'linux' as const, broker: false, policy: 'never' as const},
  ].entries()) {
    const {config, stateRoot, managedRoot} = projectHostConfig(t, `workspace-${index}`)
    const transportFactory = new RecordingTransportFactory()
    const published: unknown[] = []
    const resource = await createCodexAssemblyResource({
      config,
      composition: 'realtime',
      transportFactory,
      clock: new VirtualClock(100),
      idFactory: () => `approval-${index}`,
      platform: evidence.platform,
      projectHost: {
        nativeLocks: new DescriptorLockAuthority(),
        rootFiles: new DescriptorRootFileAuthority([stateRoot, managedRoot]),
      },
      ...(evidence.broker
        ? {codexApprovalBroker: {publish: (view: unknown) => { published.push(view) }}}
        : {}),
    })
    try {
      await resource.start()
      assert.equal(resource.approvalPolicy, evidence.policy)
      assert.equal(resource.approvalController === null, evidence.policy === 'never')
      assert.equal(
        resource.adapter.manifest.approvals,
        resource.approvalController !== null,
        'only a resource with real approval authority advertises approvals to the host confirm tool',
      )
      assert.equal(transportFactory.calls[0]?.launchProfile.id, 'ask_headless', 'startup live is headless ask')
      assert.equal(transportFactory.calls[0]?.approvalController, null)
      assert.deepEqual(published, [])
    } finally {
      await resource.close()
    }
  }
})


test('project startup retains a connection-only prewarm without creating a session', async t => {
  const {config, stateRoot, managedRoot} = projectHostConfig(t)
  const transport = new RecordingTransport()
  let warmed = 0
  const resource = await createCodexAssemblyResource({
    config: {...config, prewarm: true}, composition: 'realtime', clock: new VirtualClock(), idFactory: () => 'warm-id',
    transportFactory: {available: true, create: binding => {
      assert.equal(binding.mode, 'project')
      assert.equal(binding.preserveHome, true)
      assert.equal(binding.resumeThreadId, null)
      return Object.assign(transport, {prewarmConnection: () => { warmed += 1;return Promise.resolve(PREFLIGHT) }})
    }},
    projectHost: {nativeLocks: new DescriptorLockAuthority(), rootFiles: new DescriptorRootFileAuthority([stateRoot, managedRoot])},
  })
  try {
    await resource.start()
    assert.equal(warmed, 1)
    assert.equal(transport.prewarms, 0, 'legacy thread-opening prewarm must not be called')
    assert.equal(transport.closes, 0)
    const state = JSON.parse(readFileSync(join(stateRoot, 'codex-projects-v1.json'), 'utf8')) as {sessions: object}
    assert.deepEqual(state.sessions, {})
  } finally { await resource.close() }
  assert.equal(transport.closes, 1)
})


test('failed optional project prewarm is closed without failing certified startup', async t => {
  const {config, stateRoot, managedRoot} = projectHostConfig(t)
  const transport = new RecordingTransport(),diagnostics: string[] = []
  const resource = await createCodexAssemblyResource({
    config: {...config, prewarm: true}, composition: 'realtime', clock: new VirtualClock(), idFactory: () => 'warm-failure',
    onDiagnostic: code => { diagnostics.push(code) },
    transportFactory: {available: true, create: () => Object.assign(transport, {
      prewarmConnection: () => Promise.reject(new Error('test connection failure')),
    })},
    projectHost: {nativeLocks: new DescriptorLockAuthority(), rootFiles: new DescriptorRootFileAuthority([stateRoot, managedRoot])},
  })
  try {
    await resource.start()
    assert.equal(transport.preflights, 1)
    assert.equal(transport.closes, 1)
    assert.ok(diagnostics.includes('project_prewarm_failed'))
  } finally { await resource.close() }
})


test('project construction preserves actionable state failures after transport cleanup', async t => {
  const {config, stateRoot, managedRoot} = projectHostConfig(t)
  assert.ok(config !== null)
  for (const code of ['state_busy', 'state_lock_failed', 'state_permissions', 'workspace_not_found'] as const) {
    const transport = new RecordingTransport()
    const open = t.mock.method(ProjectStore, 'open', () => Promise.reject(new ProjectStateError(code)))
    try {
      await assert.rejects(createCodexAssemblyResource({config, composition: 'realtime',
        projectHost: {nativeLocks: new DescriptorLockAuthority(), rootFiles: new DescriptorRootFileAuthority([stateRoot, managedRoot])},
        transportFactory: {available: true, create: () => transport}, clock: new VirtualClock(), idFactory: () => 'startup-error',
      }), error => error instanceof ProjectStateError && error.code === code)
      assert.equal(transport.closes, 1)
    } finally {open.mock.restore()}
  }
})

function gate<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return {promise, resolve, reject}
}

class StartupTransport extends ProjectTransport {
  readonly preflightEntered = gate<void>()
  readonly warmEntered = gate<void>()
  readonly closeEntered = gate<void>()
  initialPreflight = Promise.resolve(PREFLIGHT)
  warmResult: Promise<SafePreflightReport | null> = Promise.resolve(PREFLIGHT)
  closeResult = Promise.resolve()
  preflights = 0
  binds = 0
  connectionOnly = false
  closed = false

  constructor(runGate?: Promise<TransportOutcome>, onRun?: () => void) {
    super('warm-thread', undefined, true, onRun, 0, runGate)
  }

  override preflight(): Promise<SafePreflightReport> {
    this.preflightEntered.resolve()
    return ++this.preflights === 1 ? this.initialPreflight : super.preflight()
  }

  prewarmConnection(): Promise<SafePreflightReport | null> {
    this.connectionOnly = true
    this.warmEntered.resolve()
    return this.warmResult
  }

  bindProject(): void {
    this.binds += 1
    if (!this.connectionOnly || this.closed || this.binds > 1) throw new CodexTransportError('busy')
  }

  override async run(...args: Parameters<ProjectTransport['run']>): Promise<TransportOutcome> {
    if (this.closed) return {classification: 'refused', code: 'busy', turnStartWritten: false, completion: null}
    await this.warmResult
    return await super.run(...args)
  }

  override close(): Promise<void> {
    this.closed = true
    this.closeCalls += 1
    this.closeEntered.resolve()
    return this.closeResult
  }
}

async function prewarmFixture(t: TestContext, startup = new StartupTransport()) {
  const {config, stateRoot, managedRoot} = projectHostConfig(t)
  const clock = new VirtualClock()
  const diagnostics: string[] = []
  let creates = 0
  const resource = await createCodexAssemblyResource({
    config: {...config, prewarm: true}, composition: 'realtime', clock, idFactory: () => 'warm-regression',
    onDiagnostic: code => {diagnostics.push(code)},
    transportFactory: {available: true, create: () => ++creates === 1 ? startup
      : new ProjectTransport('cold-thread', undefined, true, undefined, 0, undefined, new CodexTransportError('credential_missing'))},
    projectHost: {nativeLocks: new DescriptorLockAuthority(), rootFiles: new DescriptorRootFileAuthority([stateRoot, managedRoot])},
  })
  t.after(async () => { startup.closeResult = Promise.resolve(); await resource.close() })
  const dispatch = (id: string) => {
    const request = runRequest(id, {session: 'new', title: id})
    return settleWithin(id, resource.adapter.dispatch('run', request, context('run', request, clock, {delegateId: id})))
  }
  return {resource, startup, dispatch, diagnostics}
}

test('prewarm handoff: initial credential failure stays credential on both tasks', async t => {
  const {resource, startup, dispatch, diagnostics} = await prewarmFixture(t)
  const preflight = gate<SafePreflightReport>()
  startup.initialPreflight = preflight.promise
  const starting = resource.start()
  const rejected = assert.rejects(starting, error => error instanceof CodexTransportError && error.code === 'credential_missing')
  preflight.reject(new CodexTransportError('credential_missing'))
  await rejected
  const first = await dispatch('first'), second = await dispatch('second')
  assert.deepEqual([first, second].map(result => [result.content.error ?? result.content.code, result.content.stage]),
    [['credential_missing', 'credential'], ['credential_missing', 'credential']])
  assert.equal(startup.binds, 0)
  assert.equal(startup.workOrders.length, 0)
  assert.equal(startup.closeCalls, 1)
  assert.equal(diagnostics.includes('project_prewarm_failed'), false,
    'mandatory certification failure must not add an optional-prewarm diagnostic')
})

test('prewarm handoff: pending certification uses a fresh task transport', async t => {
  const {resource, startup, dispatch} = await prewarmFixture(t)
  const preflight = gate<SafePreflightReport>()
  startup.initialPreflight = preflight.promise
  const starting = resource.start()
  const rejected = assert.rejects(starting, {code: 'credential_missing'})
  try {
    await startup.preflightEntered.promise
    const task = await dispatch('pending-preflight')
    assert.equal(task.content.code, 'credential_missing')
    assert.equal(task.content.stage, 'credential')
    assert.equal(startup.binds, 0)
  } finally {
    preflight.reject(new CodexTransportError('credential_missing'))
    await rejected
  }
})

test('prewarm handoff: pending warmup and failed cleanup windows use fresh transports', async t => {
  const {resource, startup, dispatch} = await prewarmFixture(t)
  const warm = gate<SafePreflightReport | null>(), close = gate<void>()
  startup.warmResult = warm.promise
  startup.closeResult = close.promise
  const starting = resource.start()
  try {
    await startup.warmEntered.promise
    const pending = await dispatch('pending-warm')
    warm.reject(new CodexTransportError('transport_lost'))
    await startup.closeEntered.promise
    const cleaning = await dispatch('cleaning-warm')
    close.resolve()
    await starting
    const after = await dispatch('failed-warm')
    assert.deepEqual([pending, cleaning, after].map(result => [result.content.code, result.content.stage]),
      [['credential_missing', 'credential'], ['credential_missing', 'credential'], ['credential_missing', 'credential']])
    assert.equal(startup.binds, 0)
    assert.equal(startup.workOrders.length, 0)
    assert.equal(startup.closeCalls, 1)
  } finally {
    warm.resolve(PREFLIGHT)
    close.resolve()
    await starting
  }
})

test('prewarm handoff: ready transport is claimed once and genuine active work stays busy', async t => {
  const runGate = gate<TransportOutcome>(), running = gate<void>()
  const startup = new StartupTransport(runGate.promise, () => running.resolve())
  const {resource, dispatch} = await prewarmFixture(t, startup)
  await resource.start()
  const first = dispatch('active-warm')
  try {
    await settleWithin('ready run entered', running.promise)
    assert.equal(startup.binds, 1)
    assert.equal(startup.closeCalls, 0, 'startup cleanup must not race the claimed task')
    const concurrent = await dispatch('concurrent-warm')
    assert.equal(concurrent.content.code, 'busy_project')
    assert.equal(concurrent.content.work_id, 'active-warm')
  } finally {
    runGate.resolve({classification: 'completed', code: 'completed', turnStartWritten: true,
      completion: {status: 'completed', final_text: 'done', internal_activity: 1}})
  }
  assert.equal((await first).outcome, 'ok')
  const next = await dispatch('after-ready')
  assert.equal(next.content.code, 'credential_missing')
  assert.equal(next.content.stage, 'credential')
  assert.equal(startup.binds, 1)
  assert.equal(startup.closeCalls, 1, 'only task completion closed the claimed transport')
})

test('prewarm handoff: initial credential failure survives a different cleanup error', async t => {
  const {resource, startup, dispatch} = await prewarmFixture(t)
  const preflight = gate<SafePreflightReport>(), close = gate<void>()
  startup.initialPreflight = preflight.promise
  startup.closeResult = close.promise
  const original = new CodexTransportError('credential_missing')
  const rejected = assert.rejects(resource.start(), error => error === original)
  preflight.reject(original)
  try {
    await settleWithin('initial failure cleanup entered', startup.closeEntered.promise)
    close.reject(new CodexTransportError('transport_lost'))
    await rejected
    const result = await dispatch('after-cleanup-error')
    assert.equal(result.content.code, 'credential_missing')
    assert.equal(result.content.stage, 'credential')
    assert.equal(startup.binds, 0)
  } finally {
    close.resolve()
    await rejected
  }
})

test('prewarm handoff: initial credential failure survives synchronous cleanup throw', async t => {
  const {resource, startup, dispatch} = await prewarmFixture(t)
  const preflight = gate<SafePreflightReport>()
  startup.initialPreflight = preflight.promise
  const close = t.mock.method(startup, 'close', () => {throw new CodexTransportError('transport_lost')})
  const original = new CodexTransportError('credential_missing')
  try {
    const rejected = assert.rejects(resource.start(), error => error === original)
    preflight.reject(original)
    await rejected
    const result = await dispatch('after-sync-cleanup-error')
    assert.equal(result.content.code, 'credential_missing')
    assert.equal(result.content.stage, 'credential')
    assert.equal(startup.binds, 0)
  } finally {close.mock.restore()}
})

test('prewarm handoff: shutdown revokes ready transport before cleanup settles', async t => {
  const {resource, startup, dispatch} = await prewarmFixture(t)
  await resource.start()
  const close = gate<void>()
  startup.closeResult = close.promise
  const closing = resource.close()
  const rejected = assert.rejects(closing, {code: 'transport_lost'})
  try {
    await startup.closeEntered.promise
    const result = await dispatch('during-shutdown')
    assert.equal(result.content.code, 'credential_missing')
    assert.equal(result.content.stage, 'credential')
    assert.equal(startup.binds, 0)
  } finally {
    close.reject(new CodexTransportError('transport_lost'))
    await rejected
  }
})

test('prewarm handoff: failed shutdown cannot publish a late warm connection', async t => {
  const {resource, startup, dispatch} = await prewarmFixture(t)
  const warm = gate<SafePreflightReport | null>(), close = gate<void>()
  startup.warmResult = warm.promise
  startup.closeResult = close.promise
  const starting = resource.start()
  await startup.warmEntered.promise
  const rejected = assert.rejects(resource.close(), {code: 'transport_lost'})
  close.reject(new CodexTransportError('transport_lost'))
  await rejected
  warm.resolve(PREFLIGHT)
  await starting
  const result = await dispatch('late-warm')
  assert.equal(result.content.code, 'credential_missing')
  assert.equal(result.content.stage, 'credential')
  assert.equal(startup.binds, 0)
})

test('prewarm handoff: null warm result is not a ready connection', async t => {
  const {resource, startup, dispatch} = await prewarmFixture(t)
  startup.warmResult = Promise.resolve(null)
  await resource.start()
  const result = await dispatch('null-warm')
  assert.equal(result.content.code, 'credential_missing')
  assert.equal(result.content.stage, 'credential')
  assert.equal(startup.binds, 0)
})

test('prewarm handoff: owned initial-failure cleanup retains the persistent home', async t => {
  const {config, stateRoot, managedRoot} = projectHostConfig(t)
  assert.ok(config.localCodexHome)
  const sentinel = join(config.localCodexHome, 'retained.txt')
  writeFileSync(sentinel, 'persistent fixture', {mode: 0o600})
  const credentials = new CredentialSnapshotter({environment: {PATH: '/usr/bin:/bin', HOME: config.localCodexHome}})
  const cleanup = t.mock.method(credentials, 'removeEphemeralHome', credentials.removeEphemeralHome.bind(credentials))
  const resource = await createCodexAssemblyResource({
    config: {...config, prewarm: true}, composition: 'realtime', clock: new VirtualClock(), idFactory: () => 'persistent-cleanup',
    transportFactory: new OwnedCodexBackendTransportFactory({
      processFactory: {spawn: () => Promise.reject(new Error('must not spawn'))}, credentialSnapshotter: credentials,
      preflightRunner: {run: () => Promise.reject(new CodexTransportError('credential_missing'))},
      schemaProbe: {generate: () => Promise.reject(new Error('must not probe schema'))},
      ephemeralHomeFactory: () => {throw new Error('must not allocate ephemeral home')},
    }),
    projectHost: {nativeLocks: new DescriptorLockAuthority(), rootFiles: new DescriptorRootFileAuthority([stateRoot, managedRoot])},
  })
  try {
    await assert.rejects(resource.start(), {code: 'credential_missing'})
    assert.equal(cleanup.mock.callCount(), 1, 'failure cleanup must reach the real home owner')
    assert.equal(readFileSync(sentinel, 'utf8'), 'persistent fixture')
  } finally {await resource.close()}
  assert.equal(readFileSync(sentinel, 'utf8'), 'persistent fixture')
})

test('borrowed Codex approvals preserve another executor on close and failed construction', async t => {
  const {config, stateRoot, managedRoot} = projectHostConfig(t)
  const clock = new VirtualClock(100)
  const shared = new HostApprovalController({clock, idFactory: () => 'phone-approval'})
  const phone = shared.forWork({work_id: 'phone', project: 'device', title: 'Settings'})
  const offered = phone.offer({kind: 'permissions', local_detail: {kind: 'permissions', scope: 'Tap'},
    operation_summary: 'Confirm phone action', executorIdentity: {executor: 'autoglm', display_name: 'AutoGLM'}}, new AbortController().signal)
  const options = {
    config: {...config, prewarm: true}, composition: 'realtime' as const, clock, idFactory: () => 'codex-approval',
    sharedApprovalController: shared,
    projectHost: {nativeLocks: new DescriptorLockAuthority(), rootFiles: new DescriptorRootFileAuthority([stateRoot, managedRoot])},
  }
  const resource = await createCodexAssemblyResource({...options, transportFactory: {
    available: true, create: binding => Object.assign(new RecordingTransport(), {
      close: () => { binding.approvalController?.invalidate('transport_closed'); return Promise.resolve() },
    }),
  }})
  assert.equal(resource.approvalController, shared)
  await resource.close()
  assert.equal(shared.view.pending_approval_id, 'phone-approval')
  await assert.rejects(createCodexAssemblyResource({...options, transportFactory: {
    available: true, create: () => { throw new Error('startup failed') },
  }}))
  assert.equal(shared.view.executorIdentity?.executor, 'autoglm')
  assert.equal(shared.acceptDecision({approvalId: 'phone-approval', decision: 'accept'}), true)
  assert.equal(phone.consume((await offered)!), 'accept')
})


test('reused Codex approval port remains owned after consume and ignores stale consumption', async t => {
  const {config, stateRoot, managedRoot} = projectHostConfig(t)
  const clock = new VirtualClock(100)
  let id = 0
  const shared = new HostApprovalController({clock, idFactory: () => `approval-${++id}`})
  const factory = new RecordingTransportFactory()
  const resource = await createCodexAssemblyResource({
    config: {...config, prewarm: true}, composition: 'realtime', clock, idFactory: () => 'unused',
    sharedApprovalController: shared, transportFactory: factory,
    projectHost: {nativeLocks: new DescriptorLockAuthority(), rootFiles: new DescriptorRootFileAuthority([stateRoot, managedRoot])},
  })
  const port = factory.calls[0]!.approvalController!
  const offer = {kind: 'permissions' as const, local_detail: {kind: 'permissions' as const, scope: 'test'}, operation_summary: 'Approve'}
  const signal = new AbortController().signal
  const first = port.offer(offer, signal)
  shared.acceptDecision({approvalId: shared.view.pending_approval_id!, decision: 'accept'})
  const firstResolution = (await first)!
  assert.equal(port.consume(firstResolution), 'accept')
  const second = port.offer(offer, signal)
  assert.equal(port.consume(firstResolution), 'decline')
  port.invalidate('turn_end')
  assert.equal((await second)?.decision, 'decline')
  const third = port.offer(offer, signal)
  await resource.close()
  assert.equal((await third)?.decision, 'decline')
  assert.equal(shared.pending, false)
})
