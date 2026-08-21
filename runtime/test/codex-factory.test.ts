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
  type CodexBackendTransportFactory,
  type CodexTransportBinding,
} from '../src/codex-factory.js'
import {resolveCodexHostConfig, type CodexHostCatalog} from '../src/codex-host-config.js'
import {CodexHostConfigurationError} from '../src/codex-host-config.js'
import {VirtualClock} from '../src/clock.js'
import {loadSettings} from '../src/config.js'
import type {NativeFileLockAuthority, NativeFileLockResult} from '../src/native-file-lock.js'
import type {PublicProjectView} from '../src/codex-project-store.js'
import type {
  ProjectFileIdentity,
  ProjectRootFileAuthority,
  ProjectRootFileCreateResult,
  ProjectRootFileLookupResult,
  ProjectRootFileResult,
} from '../src/project-root-file.js'

const PREFLIGHT: SafePreflightReport = Object.freeze({
  version: '0.145.0',
  root_matches: true,
  mount: 'workspace_only',
  subprocess: 'contained',
  network: 'blocked',
})

class RecordingTransport implements CodexAppServerTransport {
  prewarms = 0
  closes = 0

  preflight(): Promise<SafePreflightReport> {
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

class RetryableCloseTransport extends RecordingTransport {
  override close(): Promise<void> {
    this.closes += 1
    return this.closes === 1
      ? Promise.reject(new Error('transient retained transport cleanup'))
      : Promise.resolve()
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

  renameAt(rootDescriptor: number, from: string, to: string): ProjectRootFileResult {
    try {
      const root = this.#rootPath(rootDescriptor)
      renameSync(join(root, from), join(root, to))
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

test('one app-server factory selects exact ordinary and realtime live adapters', async t => {
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
  assert.equal(ordinaryFactory.transports[0]?.prewarms, 0)
  await ordinary.close()
  await ordinary.close()
  assert.equal(ordinaryFactory.transports[0]?.closes, 1)

  const liveFactory = new RecordingTransportFactory()
  const live = await createCodexAssemblyResource({
    config,
    composition: 'realtime' as const,
    transportFactory: liveFactory,
    clock: new VirtualClock(),
    idFactory: () => 'live-id',
  })
  assert.equal(live.mode, 'live')
  assert.deepEqual(live.adapter.manifest.ops.map(operation => operation.name), [
    'run', 'steer', 'status',
  ])
  assert.equal(liveFactory.calls.length, 1)
  assert.equal(liveFactory.calls[0]?.mode, 'live')
  const firstStart = live.start()
  assert.equal(live.start(), firstStart)
  await firstStart
  assert.equal(liveFactory.transports[0]?.prewarms, 1)
  await live.close()
  await live.close()
  assert.equal(liveFactory.transports[0]?.closes, 1)
})

test('live resource retries retained raw transport cleanup before releasing shutdown ownership', async t => {
  const config = hostConfig(t)
  assert.ok(config !== null)
  const transport = new RetryableCloseTransport()
  const resource = await createCodexAssemblyResource({
    config,
    composition: 'realtime' as const,
    transportFactory: {available: true, create: () => transport},
    clock: new VirtualClock(),
    idFactory: () => 'cleanup-id',
  })

  await resource.close()
  await resource.close()
  assert.equal(transport.closes, 2)
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
      composition: 'realtime',
      transportFactory,
      clock: new VirtualClock(),
      idFactory: () => 'unavailable-id',
    }), error => error instanceof CodexHostConfigurationError
      && error.code === 'codex_host_unavailable')
  }
  assert.equal(unavailableCreates, 0)
})

test('project mode opens one live store, imports the host workspace, and exposes only public view', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nova-codex-project-factory-')))
  const binary = join(root, 'codex-host')
  const workspace = join(root, 'workspace')
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
    NOVA_AUDIO_AGENT_CODEX_PROJECTS_ENABLED: 'true',
    NOVA_AUDIO_AGENT_CODEX_MANAGED_ROOT: managedRoot,
    NOVA_AUDIO_AGENT_CODEX_PROJECT_STATE_ROOT: stateRoot,
  }), {
    canonicalBinaries: [binary],
    canonicalWorkspaces: [workspace],
    defaultBinary: binary,
    homeDirectory: root,
  })
  assert.ok(config !== null)
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
    'run', 'project', 'steer', 'status',
  ])
  assert.deepEqual(resource.projectView, {
    workspace_display_name: 'workspace',
    session_title: null,
    pending_confirmation: false,
  })
  assert.deepEqual(views.at(-1), resource.projectView)
  const state = JSON.parse(readFileSync(join(stateRoot, 'codex-projects-v1.json'), 'utf8')) as {
    readonly workspaces: Readonly<Record<string, {readonly created_at: number}>>
  }
  assert.equal(Object.values(state.workspaces)[0]?.created_at, 123)
  assert.equal(transportFactory.calls.length, 0, 'transport is bound only when a stored session runs')
  const projectStart = resource.start()
  assert.equal(resource.start(), projectStart)
  await projectStart
  assert.equal(transportFactory.calls.length, 0, 'project start never prewarms stale session authority')
  await resource.close()
  await resource.close()
})
