import assert from 'node:assert/strict'
import {
  chmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import {mkdir, mkdtemp, readFile, realpath, rename, rm, symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import type {
  CodexAppServerTransport,
  SafePreflightReport,
  SteerTransportResult,
  TransportDeadline,
  TransportObserver,
  TransportOutcome,
} from '../src/codex-app-server-transport.js'
import {CODEX_PROJECT_MANIFEST} from '../src/codex-contract.js'
import {
  CodexProjectStore,
  hostManagedProjectRootForTest,
  hostProjectRootForTest,
  type PublicProjectView,
} from '../src/codex-project-store.js'
import {hostWorkspaceForTest} from '../src/codex-process-owner.js'
import {CausalRuntime, type ExecutorDispatchContext} from '../src/causal-runtime.js'
import {VirtualClock} from '../src/clock.js'
import {
  ProjectCodexAdapter,
  type ProjectTransportBinding,
  type ProjectTransportFactory,
} from '../src/executors/codex-project-live.js'
import type {JsonValue} from '../src/events.js'
import {MonotonicIdFactory} from '../src/ids.js'
import {bindHostExecutorCapability} from '../src/host-executor-capability.js'
import type {NativeFileLockAuthority, NativeFileLockResult} from '../src/native-file-lock.js'
import type {
  ProjectFileIdentity,
  ProjectRootFileAuthority,
  ProjectRootFileCreateResult,
  ProjectRootFileLookupResult,
  ProjectRootFileResult,
} from '../src/project-root-file.js'
import {delegateSchema, type DelegateRequest} from '../src/ports.js'
import {ProjectConfirmationController} from '../src/realtime/project-confirmation.js'
import type {WakeReason} from '../src/slots.js'
import {compileToolSchema} from '../src/tool-schema.js'

const PREFLIGHT: SafePreflightReport = Object.freeze({
  version: '0.145.0',
  root_matches: true,
  mount: 'workspace_only',
  subprocess: 'contained',
  network: 'blocked',
})

const COMPLETE: TransportOutcome = Object.freeze({
  classification: 'completed',
  code: 'completed',
  turnStartWritten: true,
  completion: {status: 'completed' as const, final_text: 'done', internal_activity: 1},
})

async function settleWithin<T>(name: string, work: Promise<T>, milliseconds = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`${name} did not settle`)) }, milliseconds)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
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

/** Test-only descriptor resolver; Task 8 still owns the production native implementation. */
class DescriptorRootFileAuthority implements ProjectRootFileAuthority {
  readonly #roots = new Map<string, {path: string; readonly parent: string}>()

  constructor(paths: readonly string[]) {
    for (const path of paths) {
      const info = lstatSync(path, {bigint: true})
      this.#roots.set(`${info.dev}:${info.ino}`, {path, parent: join(path, '..')})
    }
  }

  probe(rootDescriptor: number): ProjectRootFileResult {
    try {
      this.#rootPath(rootDescriptor)
      return {status: 'ok'}
    } catch {
      return {status: 'failed'}
    }
  }

  matchesAt(rootDescriptor: number, name: string, childDescriptor: number): ProjectRootFileResult {
    try {
      const child = fstatSync(childDescriptor, {bigint: true})
      const root = this.#rootPath(rootDescriptor)
      const path = join(root, name)
      const current = lstatSync(path, {bigint: true})
      if (current.dev !== child.dev || current.ino !== child.ino) return {status: 'mismatch'}
      if (child.isDirectory()) {
        this.#roots.set(`${child.dev}:${child.ino}`, {path, parent: root})
      }
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

  createFileAt(
    rootDescriptor: number,
    name: string,
    exclusive: boolean,
  ): ProjectRootFileCreateResult {
    try {
      void exclusive
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
      if (current.dev !== expected.device || current.ino !== expected.inode) {
        return {status: 'mismatch'}
      }
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

class ProjectTransport implements CodexAppServerTransport {
  closeCalls = 0
  #remainingCloseFailures: number

  constructor(
    readonly threadId: string,
    readonly outcome: TransportOutcome = COMPLETE,
    readonly reportThread = true,
    readonly onRun?: () => void,
    closeFailures = 0,
    readonly runGate?: Promise<TransportOutcome>,
  ) {
    this.#remainingCloseFailures = closeFailures
  }

  preflight(): Promise<SafePreflightReport> { return Promise.resolve(PREFLIGHT) }
  prewarm(): Promise<SafePreflightReport | null> { return Promise.resolve(PREFLIGHT) }

  run(
    _input: {readonly workOrder: string},
    observer: TransportObserver,
    _deadline: TransportDeadline,
  ): Promise<TransportOutcome> {
    void _deadline
    this.onRun?.()
    if (this.reportThread) {
      observer.onThreadReady?.(this.threadId)
      observer.onTurnStartWritten?.()
      observer.onTurnBound?.()
    }
    return this.runGate ?? Promise.resolve(this.outcome)
  }

  steer(): Promise<SteerTransportResult> {
    return Promise.resolve({code: 'no_active_turn', written: false})
  }

  close(): Promise<void> {
    this.closeCalls += 1
    if (this.#remainingCloseFailures > 0) {
      this.#remainingCloseFailures -= 1
      return Promise.reject(new Error('test transport close rejected'))
    }
    return Promise.resolve()
  }
}

class RecordingProjectTransportFactory implements ProjectTransportFactory {
  readonly calls: {readonly resume: boolean}[] = []
  readonly transports: ProjectTransport[] = []
  nextOutcome: TransportOutcome = COMPLETE
  overrideThreadId: string | null = null
  reportThread = true
  onRun: (() => void) | undefined
  closeFailures = 0
  runGate: Promise<TransportOutcome> | undefined

  create(binding: ProjectTransportBinding): CodexAppServerTransport {
    const resume = binding.resumeThreadId !== null
    this.calls.push({resume})
    const transport = new ProjectTransport(
      this.overrideThreadId ?? binding.resumeThreadId ?? `thread-${this.calls.length}`,
      this.nextOutcome,
      this.reportThread,
      this.onRun,
      this.closeFailures,
      this.runGate,
    )
    this.transports.push(transport)
    return transport
  }
}

interface Fixture {
  readonly root: string
  readonly store: CodexProjectStore
  readonly adapter: ProjectCodexAdapter
  readonly confirmation: ProjectConfirmationController
  readonly factory: RecordingProjectTransportFactory
  readonly clock: VirtualClock
}

async function fixture(options: {
  readonly preexistingSession?: boolean
  readonly decorateStore?: (store: CodexProjectStore) => CodexProjectStore
} = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'nova-codex-project-adapter-'))
  const stateRoot = join(root, 'state')
  const managedRoot = join(root, 'managed')
  const workspace = join(root, 'workspace')
  await mkdir(stateRoot, {mode: 0o700})
  await mkdir(managedRoot, {mode: 0o700})
  await mkdir(workspace, {mode: 0o700})
  const identifiers = Array.from(
    {length: 40},
    (_unused, index) => `${index % 2 === 0 ? 'workspace' : 'session'}-${String(index).padStart(4, '0')}`,
  )[Symbol.iterator]()
  const store = await CodexProjectStore.open({
    stateRoot: hostProjectRootForTest(await realpath(stateRoot)),
    managedRoot: hostManagedProjectRootForTest(await realpath(managedRoot)),
    nativeLocks: new DescriptorLockAuthority(),
    rootFiles: new DescriptorRootFileAuthority([stateRoot, managedRoot]),
    idFactory: () => identifiers.next().value ?? 'unused-id',
    now: () => 100,
    live: true,
  })
  await store.ensureImported('alpha', hostWorkspaceForTest(await realpath(workspace)))
  if (options.preexistingSession === true) {
    const existingWorkspace = await store.resolveWorkspace('alpha')
    const starting = await store.beginSession(existingWorkspace.workspace_id, 'Existing')
    await store.markSessionReady(starting.session_id, 'thread-existing')
  }
  const clock = new VirtualClock(10)
  let nonce = 0
  const confirmation = new ProjectConfirmationController({
    clock,
    idFactory: () => `nonce-${++nonce}`,
  })
  const factory = new RecordingProjectTransportFactory()
  const adapter = new ProjectCodexAdapter({
    store: options.decorateStore?.(store) ?? store,
    confirmation,
    transportFactory: factory,
  })
  return {root, store, adapter, confirmation, factory, clock}
}

function storeWithPersistentHomeHook(
  store: CodexProjectStore,
  afterPersistentHome: () => Promise<void>,
): CodexProjectStore {
  return new Proxy(store, {
    get(target, property) {
      if (property === 'persistentHome') {
        return async (workspaceId: string) => {
          const home = await target.persistentHome(workspaceId)
          await afterPersistentHome()
          return home
        }
      }
      const value: unknown = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      const bound: unknown = value.bind(target)
      return bound
    },
  })
}

function context(
  op: string,
  request: Readonly<Record<string, JsonValue>>,
  clock: VirtualClock,
  options: {
    readonly private?: unknown
    readonly delegateId?: string
    readonly originRef?: string
    readonly signal?: AbortSignal
  } = {},
): ExecutorDispatchContext {
  const delegate = delegateSchema.parse({
    delegate_id: options.delegateId ?? `delegate-${op}`,
    executor: 'codex',
    op,
    request,
    origin_ref: options.originRef ?? 'conversation:1',
    deadline: clock.now() + (op === 'project' ? 10 : 600),
    routing_class: 'user_awaited',
    dispatched_at: clock.now(),
  })
  const dispatchContext: ExecutorDispatchContext = {
    clock,
    delegate,
    signal: options.signal ?? new AbortController().signal,
    progress: () => undefined,
  }
  if (typeof options.private === 'object' && options.private !== null) {
    bindHostExecutorCapability(dispatchContext, options.private)
  }
  return dispatchContext
}

test('project manifest and tool schema preserve exact flat operation order and sensitivity', () => {
  const adapter = new ProjectCodexAdapter({} as never)
  assert.equal(adapter.manifest, CODEX_PROJECT_MANIFEST)
  assert.deepEqual(adapter.manifest.ops.map(op => op.name), ['run', 'project', 'steer', 'status'])
  assert.deepEqual([...compileToolSchema([adapter.manifest]).bindings.keys()].slice(-4), [
    'codex__run', 'codex__project', 'codex__steer', 'codex__status',
  ])
  assert.deepEqual(adapter.manifest.ops[0]?.sensitive_params, ['work_order'])
  assert.deepEqual(adapter.manifest.ops[1]?.sensitive_params, ['work_order'])
})

test('project create proposal validates without mutating state or constructing transport', async () => {
  const value = await fixture()
  try {
    const before = await value.store.snapshot()
    const result = await value.adapter.dispatch(
      'project',
      {action: 'create', workspace: 'beta', work_order: 'build it'},
      context('project', {}, value.clock),
    )
    assert.deepEqual(result.content, {
      op: 'project',
      code: 'confirmation_required',
      action: 'create',
      workspace: 'beta',
      session: null,
      confirmation_prompt: '准备创建工作区beta，并在其中开始任务，请确认或取消。',
    })
    assert.deepEqual(await value.store.snapshot(), before)
    assert.equal(value.factory.calls.length, 0)

    const invalid = await value.adapter.dispatch(
      'project',
      {action: 'create', workspace: '../escape'},
      context('project', {}, value.clock),
    )
    assert.deepEqual(invalid.content, {op: 'project', code: 'workspace_name_invalid'})
    assert.equal(value.factory.calls.length, 0)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('initialize publishes the pre-existing active project using only the public three-field view', async () => {
  const value = await fixture({preexistingSession: true})
  try {
    const views: PublicProjectView[] = []
    const unsubscribe = value.adapter.observeProjectView(view => { views.push(view) })
    const first = value.adapter.initialize()
    assert.equal(value.adapter.initialize(), first)
    await first
    assert.deepEqual(value.adapter.publicProjectView(false), {
      workspace_display_name: 'alpha',
      session_title: 'Existing',
      pending_confirmation: false,
    })
    assert.deepEqual(views.at(-1), value.adapter.publicProjectView(false))
    await value.adapter.dispatch(
      'run',
      {work_order: 'fresh session', session: 'Fresh'},
      context('run', {work_order: 'fresh session'}, value.clock),
    )
    assert.equal(views.at(-1)?.session_title, 'Fresh')
    const beforeUnsubscribe = views.length
    unsubscribe()
    await value.adapter.dispatch(
      'run',
      {work_order: 'silent observer', session: 'Silent'},
      context('run', {work_order: 'silent observer'}, value.clock),
    )
    assert.equal(views.length, beforeUnsubscribe)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('exact select rejects a confirmed name paired with a different workspace id atomically', async () => {
  const value = await fixture()
  try {
    const alpha = await value.store.resolveWorkspace('alpha')
    const beta = await value.store.createManaged('beta')
    await assert.rejects(
      value.store.selectWorkspaceExact('alpha', beta.workspace_id),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'workspace_boundary_changed',
    )
    assert.equal((await value.store.resolveWorkspace(null)).workspace_id, beta.workspace_id)
    const selected = await value.store.selectWorkspaceExact('alpha', alpha.workspace_id)
    assert.equal(selected.workspace_id, alpha.workspace_id)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('plain runs create distinct ready sessions with one fresh closed transport each', async () => {
  const value = await fixture()
  try {
    const first = await value.adapter.dispatch(
      'run',
      {work_order: 'first', session: 'Task'},
      context('run', {work_order: 'first'}, value.clock),
    )
    const second = await value.adapter.dispatch(
      'run',
      {work_order: 'second', session: 'task'},
      context('run', {work_order: 'second'}, value.clock),
    )
    assert.equal(first.outcome, 'ok')
    assert.equal(second.outcome, 'ok')
    const workspace = await value.store.resolveWorkspace('alpha')
    const sessions = await value.store.listSessions(workspace)
    assert.deepEqual(sessions.map(session => [
      session.display_title, session.state, session.codex_thread_id,
    ]), [
      ['Task', 'ready', 'thread-1'],
      ['task (2)', 'ready', 'thread-2'],
    ])
    assert.deepEqual(value.factory.calls, [{resume: false}, {resume: false}])
    assert.deepEqual(value.factory.transports.map(transport => transport.closeCalls), [1, 1])
    const status = await value.adapter.dispatch('status', {}, context('status', {}, value.clock))
    assert.equal(status.content.run_sequence, 2)
    const steer = await value.adapter.dispatch(
      'steer',
      {instruction: 'after completion'},
      context('steer', {instruction: 'after completion'}, value.clock),
    )
    assert.equal(steer.content.code, 'no_active_turn')
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('confirmed resume binds one exact capability, delegate, origin, work order, and stored thread', async () => {
  const value = await fixture()
  try {
    await value.adapter.dispatch(
      'run',
      {work_order: 'first', session: 'Task'},
      context('run', {work_order: 'first'}, value.clock),
    )
    const proposed = await value.adapter.dispatch(
      'project',
      {action: 'resume', workspace: 'alpha', session: 'Task', work_order: 'continue'},
      context('project', {}, value.clock),
    )
    assert.equal(proposed.content.code, 'confirmation_required')
    assert.equal(value.confirmation.reserveUserItem({epoch: 1, itemId: 'user-confirm'}), true)
    const confirmed = value.confirmation.acceptTranscript({
      epoch: 1, itemId: 'user-confirm', text: '确认',
    })
    assert.ok(confirmed.operation)
    let delegated: DelegateRequest | null = null
    let delegatedReason: WakeReason | null = null
    let delegatedCapability: object | null = null
    const committed = await value.adapter.commitConfirmed(
      confirmed.operation,
      'conversation:2',
      (request, reason, capability) => {
        delegated = request
        delegatedReason = reason
        delegatedCapability = capability
        return {accepted: true, delegate_id: 'delegate-resume'}
      },
    )
    assert.deepEqual(committed, {
      accepted: true, code: 'accepted', delegate_id: 'delegate-resume',
    })
    const capturedReason = delegatedReason as unknown as WakeReason
    const capturedDelegate = delegated as unknown as DelegateRequest
    assert.equal(capturedReason.priority, 100)
    assert.equal(capturedReason.routing_class, 'user_awaited')
    assert.equal(Object.hasOwn(capturedDelegate, 'private'), false)
    assert.equal(delegatedCapability, confirmed.operation)

    const resumed = await value.adapter.dispatch(
      'run',
      {work_order: 'continue'},
      context('run', {work_order: 'continue'}, value.clock, {
        private: confirmed.operation,
        delegateId: 'delegate-resume',
        originRef: 'conversation:2',
      }),
    )
    assert.equal(resumed.outcome, 'ok')
    assert.deepEqual(value.factory.calls, [{resume: false}, {resume: true}])

    const replay = await value.adapter.dispatch(
      'run',
      {work_order: 'continue'},
      context('run', {work_order: 'continue'}, value.clock, {
        private: confirmed.operation,
        delegateId: 'delegate-resume',
        originRef: 'conversation:2',
      }),
    )
    assert.deepEqual(replay.content, {error: 'confirmation_binding_mismatch', op: 'run'})
    assert.equal(value.factory.calls.length, 2)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('real external dispatch carries one opaque confirmation identity outside every public delegate', async () => {
  const value = await fixture()
  const runtime = new CausalRuntime({
    clock: value.clock,
    ids: new MonotonicIdFactory(),
    executors: [value.adapter],
  })
  const origin = runtime.memory.append('conversation', {
    ts: value.clock.now(),
    trust: 'trusted_user',
    priority: 100,
    content: {text: 'continue exactly'},
  })
  const originRef = `${origin.channel}:${origin.seq}`
  const stop = new AbortController()
  const serving = runtime.serve(stop.signal)
  try {
    await value.adapter.dispatch(
      'project',
      {action: 'create', workspace: 'beta', work_order: 'exact work'},
      context('project', {}, value.clock, {originRef}),
    )
    value.confirmation.reserveUserItem({epoch: 1, itemId: 'confirm-real'})
    const confirmed = value.confirmation.acceptTranscript({
      epoch: 1,
      itemId: 'confirm-real',
      text: '确认',
    })
    assert.ok(confirmed.operation)
    const handoff = new Promise<void>(resolve => {
      const dispose = runtime.observe(event => {
        if (event.kind !== 'handoff') return
        dispose()
        resolve()
      })
    })
    const committed = await value.adapter.commitConfirmed(
      confirmed.operation,
      originRef,
      (request, reason, capability) => runtime.dispatchExternal(
        request,
        reason,
        capability,
      ),
    )
    assert.equal(committed.accepted, true)
    const delegate = runtime.core.activeDelegates()[0]
    assert.ok(delegate)
    assert.equal(Object.hasOwn(delegate, 'private'), false)
    assert.equal(Object.hasOwn(delegate, 'hostCapability'), false)
    assert.equal(JSON.stringify(delegate).includes(confirmed.operation.nonce), false)
    await settleWithin('real confirmed adapter handoff', handoff)
    assert.deepEqual(
      (await value.store.listWorkspaces()).map(workspace => workspace.display_name).sort(),
      ['alpha', 'beta'],
    )
  } finally {
    stop.abort()
    await serving
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('wrong delegate, origin, altered work order, copied capability, rejection, and replay have zero side effects', async () => {
  const value = await fixture()
  try {
    const proposal = await value.adapter.dispatch(
      'project',
      {action: 'create', workspace: 'beta', work_order: 'exact work'},
      context('project', {}, value.clock),
    )
    assert.equal(proposal.content.code, 'confirmation_required')
    value.confirmation.reserveUserItem({epoch: 1, itemId: 'confirm'})
    const outcome = value.confirmation.acceptTranscript({epoch: 1, itemId: 'confirm', text: '确认'})
    assert.ok(outcome.operation)
    const rejected = await value.adapter.commitConfirmed(
      outcome.operation,
      'conversation:2',
      () => ({accepted: false, delegate_id: null}),
    )
    assert.deepEqual(rejected, {accepted: false, code: 'runtime_rejected'})
    assert.deepEqual((await value.store.listWorkspaces()).map(item => item.display_name), ['alpha'])
    assert.equal(value.factory.calls.length, 0)

    const replayAfterRejection = await value.adapter.dispatch(
      'run',
      {work_order: 'exact work'},
      context('run', {work_order: 'exact work'}, value.clock, {
        private: outcome.operation,
        delegateId: 'delegate-rejected',
        originRef: 'conversation:2',
      }),
    )
    assert.deepEqual(replayAfterRejection.content, {
      error: 'confirmation_binding_mismatch', op: 'run',
    })

    const secondProposal = await value.adapter.dispatch(
      'project',
      {action: 'create', workspace: 'beta', work_order: 'exact work'},
      context('project', {}, value.clock),
    )
    assert.equal(secondProposal.content.code, 'confirmation_required')
    value.confirmation.reserveUserItem({epoch: 2, itemId: 'confirm-2'})
    const second = value.confirmation.acceptTranscript({epoch: 2, itemId: 'confirm-2', text: '确认'})
    assert.ok(second.operation)
    await value.adapter.commitConfirmed(
      second.operation,
      'conversation:3',
      () => ({accepted: true, delegate_id: 'delegate-exact'}),
    )
    const copied = {...second.operation}
    for (const attempt of [
      {private: copied, delegateId: 'delegate-exact', originRef: 'conversation:3', workOrder: 'exact work'},
      {private: second.operation, delegateId: 'delegate-wrong', originRef: 'conversation:3', workOrder: 'exact work'},
      {private: second.operation, delegateId: 'delegate-exact', originRef: 'conversation:4', workOrder: 'exact work'},
      {private: second.operation, delegateId: 'delegate-exact', originRef: 'conversation:3', workOrder: 'altered'},
    ]) {
      const result = await value.adapter.dispatch(
        'run',
        {work_order: attempt.workOrder},
        context('run', {work_order: attempt.workOrder}, value.clock, attempt),
      )
      assert.deepEqual(result.content, {error: 'confirmation_binding_mismatch', op: 'run'})
      assert.equal(value.factory.calls.length, 0)
      assert.deepEqual((await value.store.listWorkspaces()).map(item => item.display_name), ['alpha'])
    }

    const accepted = await value.adapter.dispatch(
      'run',
      {work_order: 'exact work'},
      context('run', {work_order: 'exact work'}, value.clock, {
        private: second.operation,
        delegateId: 'delegate-exact',
        originRef: 'conversation:3',
      }),
    )
    assert.equal(accepted.outcome, 'ok')
    assert.deepEqual(
      (await value.store.listWorkspaces()).map(item => item.display_name).sort(),
      ['alpha', 'beta'],
    )
    assert.equal(value.factory.calls.length, 1)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('new-run missing thread rolls back provisional session and failed confirmed create rolls back empty workspace', async () => {
  const value = await fixture()
  try {
    value.factory.reportThread = false
    const failed = await value.adapter.dispatch(
      'run',
      {work_order: 'cannot bind'},
      context('run', {work_order: 'cannot bind'}, value.clock),
    )
    assert.deepEqual(failed.content, {error: 'thread_id_invalid', op: 'run'})
    const alpha = await value.store.resolveWorkspace('alpha')
    assert.deepEqual(await value.store.listSessions(alpha), [])

    await value.adapter.dispatch(
      'project',
      {action: 'create', workspace: 'beta', work_order: 'cannot bind'},
      context('project', {}, value.clock),
    )
    value.confirmation.reserveUserItem({epoch: 1, itemId: 'confirm'})
    const outcome = value.confirmation.acceptTranscript({epoch: 1, itemId: 'confirm', text: '确认'})
    assert.ok(outcome.operation)
    await value.adapter.commitConfirmed(
      outcome.operation,
      'conversation:2',
      () => ({accepted: true, delegate_id: 'delegate-create'}),
    )
    const result = await value.adapter.dispatch(
      'run',
      {work_order: 'cannot bind'},
      context('run', {work_order: 'cannot bind'}, value.clock, {
        private: outcome.operation,
        delegateId: 'delegate-create',
        originRef: 'conversation:2',
      }),
    )
    assert.equal(result.outcome, 'failed')
    assert.deepEqual((await value.store.listWorkspaces()).map(item => item.display_name), ['alpha'])
    const publicView = value.adapter.publicProjectView(false)
    assert.deepEqual(publicView, {
      workspace_display_name: 'alpha',
      session_title: null,
      pending_confirmation: false,
    })
    assert.deepEqual(Object.keys(publicView).sort(), [
      'pending_confirmation', 'session_title', 'workspace_display_name',
    ])
    assert.equal(JSON.stringify(publicView).includes('thread'), false)
    assert.equal(JSON.stringify(publicView).includes('nonce'), false)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('caller cancellation is propagated only after provisional-session rollback is joined', async () => {
  const value = await fixture()
  try {
    const cancellation = new AbortController()
    value.factory.onRun = () => { cancellation.abort() }
    await assert.rejects(
      value.adapter.dispatch(
        'run',
        {work_order: 'cancel after begin'},
        context('run', {work_order: 'cancel after begin'}, value.clock, {
          signal: cancellation.signal,
        }),
      ),
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    )
    const workspace = await value.store.resolveWorkspace('alpha')
    assert.deepEqual(
      (await value.store.listSessions(workspace)).map(session => [session.state, session.codex_thread_id]),
      [['ready', 'thread-1']],
    )
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('transport close rejection cannot downgrade a completed side effect into a retryable failure', async () => {
  const value = await fixture()
  try {
    value.factory.closeFailures = 1
    const result = await value.adapter.dispatch(
      'run',
      {work_order: 'completed before cleanup'},
      context('run', {work_order: 'completed before cleanup'}, value.clock),
    )
    assert.equal(result.outcome, 'ok')
    const workspace = await value.store.resolveWorkspace('alpha')
    assert.deepEqual(
      (await value.store.listSessions(workspace)).map(session => session.state),
      ['ready'],
    )
    assert.equal(value.factory.transports[0]?.closeCalls, 1)
    value.factory.closeFailures = 0
    const second = await value.adapter.dispatch(
      'run',
      {work_order: 'new process only after retained cleanup'},
      context('run', {work_order: 'new process only after retained cleanup'}, value.clock),
    )
    assert.equal(second.outcome, 'ok')
    assert.equal(value.factory.transports[0]?.closeCalls, 2)
    assert.equal(value.factory.transports.length, 2)
  } finally {
    await value.adapter.close().catch(() => undefined)
    await rm(value.root, {recursive: true, force: true})
  }
})

test('close joins an active project run and its durable session finalizer before closing the store', async () => {
  const value = await fixture()
  let startedResolve!: () => void
  const started = new Promise<void>(resolve => { startedResolve = resolve })
  value.factory.onRun = startedResolve
  value.factory.runGate = new Promise<TransportOutcome>(() => undefined)
  const running = value.adapter.dispatch(
    'run',
    {work_order: 'close while running'},
    context('run', {work_order: 'close while running'}, value.clock),
  )
  const runningOutcome = running.then<Error | null, Error | null>(() => null, error => (
    error instanceof Error ? error : new Error('non-error project rejection')
  ))
  try {
    await settleWithin('project transport run start', started)
    const closing = value.adapter.close()
    assert.equal(value.adapter.close(), closing)
    await new Promise<void>(resolve => { setImmediate(resolve) })
    value.clock.advanceTo(value.clock.now() + 10)
    await settleWithin('project adapter close', closing)
    const runError = await settleWithin('cancelled project dispatch', runningOutcome)
    assert.equal(runError?.name, 'AbortError')
    assert.equal(value.factory.transports[0]?.closeCalls, 1)
    const state = JSON.parse(
      await readFile(join(value.root, 'state', 'codex-projects-v1.json'), 'utf8'),
    ) as {readonly sessions: Readonly<Record<string, {readonly state: string}>>}
    assert.equal(Object.values(state.sessions).some(session => session.state === 'starting'), false)
  } finally {
    await value.adapter.close().catch(() => undefined)
    await running.catch(() => undefined)
    await rm(value.root, {recursive: true, force: true})
  }
})

test('workspace replacement is rejected before a provisional session or transport exists', async () => {
  const value = await fixture()
  try {
    const workspacePath = join(value.root, 'workspace')
    const replacement = join(value.root, 'replacement')
    await mkdir(replacement, {mode: 0o700})
    await rename(workspacePath, join(value.root, 'workspace-original'))
    await symlink(replacement, workspacePath, 'dir')

    const result = await value.adapter.dispatch(
      'run',
      {work_order: 'must not start'},
      context('run', {work_order: 'must not start'}, value.clock),
    )
    assert.deepEqual(result.content, {error: 'workspace_boundary_changed', op: 'run'})
    const workspace = await value.store.resolveWorkspace('alpha')
    assert.deepEqual(await value.store.listSessions(workspace), [])
    assert.equal(value.factory.calls.length, 0)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('workspace replacement after persistent-home setup is rejected by the factory-bound revalidation', async () => {
  let replace = false
  let rootPath = ''
  const value = await fixture({
    decorateStore: store => storeWithPersistentHomeHook(store, async () => {
      if (!replace) return
      replace = false
      const workspacePath = join(rootPath, 'workspace')
      const replacement = join(rootPath, 'replacement-after-home')
      await mkdir(replacement, {mode: 0o700})
      await rename(workspacePath, join(rootPath, 'workspace-before-home-swap'))
      await symlink(replacement, workspacePath, 'dir')
    }),
  })
  rootPath = value.root
  try {
    replace = true
    const result = await value.adapter.dispatch(
      'run',
      {work_order: 'must not bind replacement'},
      context('run', {work_order: 'must not bind replacement'}, value.clock),
    )
    assert.deepEqual(result.content, {error: 'workspace_boundary_changed', op: 'run'})
    assert.equal(value.factory.calls.length, 0)
    const workspace = await value.store.resolveWorkspace('alpha')
    assert.deepEqual(await value.store.listSessions(workspace), [])
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('resume exact-thread mismatch marks unavailable while transient transport refusal preserves ready', async () => {
  const value = await fixture()
  try {
    await value.adapter.dispatch(
      'run',
      {work_order: 'first', session: 'Task'},
      context('run', {work_order: 'first'}, value.clock),
    )
    const workspace = await value.store.resolveWorkspace('alpha')
    const session = await value.store.resolveSession(workspace.workspace_id, 'Task')

    const proposeAndCommit = async (delegateId: string): Promise<object> => {
      await value.adapter.dispatch(
        'project',
        {action: 'resume', workspace: 'alpha', session: 'Task', work_order: 'continue'},
        context('project', {}, value.clock),
      )
      const epoch = delegateId === 'delegate-transient' ? 1 : 2
      value.confirmation.reserveUserItem({epoch, itemId: delegateId})
      const confirmed = value.confirmation.acceptTranscript({epoch, itemId: delegateId, text: '确认'})
      assert.ok(confirmed.operation)
      await value.adapter.commitConfirmed(
        confirmed.operation,
        'conversation:2',
        () => ({accepted: true, delegate_id: delegateId}),
      )
      return confirmed.operation
    }

    value.factory.reportThread = false
    value.factory.nextOutcome = {
      classification: 'refused', code: 'transport_lost', turnStartWritten: false, completion: null,
    }
    const transientOperation = await proposeAndCommit('delegate-transient')
    const transient = await value.adapter.dispatch(
      'run',
      {work_order: 'continue'},
      context('run', {work_order: 'continue'}, value.clock, {
        private: transientOperation,
        delegateId: 'delegate-transient',
        originRef: 'conversation:2',
      }),
    )
    assert.equal(transient.outcome, 'failed')
    assert.equal((await value.store.resolveSession(workspace.workspace_id, 'Task')).state, 'ready')

    value.factory.reportThread = true
    value.factory.nextOutcome = COMPLETE
    value.factory.overrideThreadId = 'wrong-thread'
    const mismatchOperation = await proposeAndCommit('delegate-mismatch')
    const mismatch = await value.adapter.dispatch(
      'run',
      {work_order: 'continue'},
      context('run', {work_order: 'continue'}, value.clock, {
        private: mismatchOperation,
        delegateId: 'delegate-mismatch',
        originRef: 'conversation:2',
      }),
    )
    assert.deepEqual(mismatch.content, {error: 'session_thread_mismatch', op: 'run'})
    assert.equal((await value.store.resolveSession(workspace.workspace_id, session.display_title)).state, 'unavailable')
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('private resume-unavailable disposition marks the exact stored session unavailable', async () => {
  const value = await fixture()
  try {
    await value.adapter.dispatch(
      'run',
      {work_order: 'first', session: 'Task'},
      context('run', {work_order: 'first'}, value.clock),
    )
    const workspace = await value.store.resolveWorkspace('alpha')
    await value.adapter.dispatch(
      'project',
      {action: 'resume', workspace: 'alpha', session: 'Task', work_order: 'continue'},
      context('project', {}, value.clock),
    )
    value.confirmation.reserveUserItem({epoch: 1, itemId: 'confirm-unavailable'})
    const confirmed = value.confirmation.acceptTranscript({
      epoch: 1, itemId: 'confirm-unavailable', text: '确认',
    })
    assert.ok(confirmed.operation)
    await value.adapter.commitConfirmed(
      confirmed.operation,
      'conversation:2',
      () => ({accepted: true, delegate_id: 'delegate-unavailable'}),
    )
    value.factory.reportThread = false
    value.factory.nextOutcome = {
      classification: 'refused', code: 'resume_unavailable', turnStartWritten: false, completion: null,
    }
    const unavailable = await value.adapter.dispatch(
      'run',
      {work_order: 'continue'},
      context('run', {work_order: 'continue'}, value.clock, {
        private: confirmed.operation,
        delegateId: 'delegate-unavailable',
        originRef: 'conversation:2',
      }),
    )
    assert.equal(unavailable.content.code, 'worker_refused')
    assert.equal((await value.store.resolveSession(workspace.workspace_id, 'Task')).state, 'unavailable')
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('resume state changed after persistent-home setup is rejected before transport construction', async () => {
  let invalidate: (() => Promise<void>) | null = null
  const value = await fixture({
    decorateStore: store => storeWithPersistentHomeHook(store, async () => {
      await invalidate?.()
    }),
  })
  try {
    await value.adapter.dispatch(
      'run',
      {work_order: 'first', session: 'Task'},
      context('run', {work_order: 'first'}, value.clock),
    )
    const workspace = await value.store.resolveWorkspace('alpha')
    const session = await value.store.resolveSession(workspace.workspace_id, 'Task')
    await value.adapter.dispatch(
      'project',
      {action: 'resume', workspace: 'alpha', session: 'Task', work_order: 'continue'},
      context('project', {}, value.clock),
    )
    value.confirmation.reserveUserItem({epoch: 1, itemId: 'confirm-late-state'})
    const confirmed = value.confirmation.acceptTranscript({
      epoch: 1, itemId: 'confirm-late-state', text: '确认',
    })
    assert.ok(confirmed.operation)
    await value.adapter.commitConfirmed(
      confirmed.operation,
      'conversation:2',
      () => ({accepted: true, delegate_id: 'delegate-late-state'}),
    )
    invalidate = async () => {
      invalidate = null
      await value.store.markSessionUnavailable(session.session_id, {wait: true})
    }
    const result = await value.adapter.dispatch(
      'run',
      {work_order: 'continue'},
      context('run', {work_order: 'continue'}, value.clock, {
        private: confirmed.operation,
        delegateId: 'delegate-late-state',
        originRef: 'conversation:2',
      }),
    )
    assert.deepEqual(result.content, {error: 'session_unavailable', op: 'run'})
    assert.equal(value.factory.calls.length, 1)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})
