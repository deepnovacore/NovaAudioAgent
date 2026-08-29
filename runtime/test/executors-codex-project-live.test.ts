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
import {CodexTransportError} from '../src/codex-app-server-transport.js'
import {CODEX_PROJECT_MANIFEST} from '../src/codex-contract.js'
import {
  CodexProjectStore,
  hostManagedProjectRootForTest,
  hostProjectRootForTest,
  ProjectStateError,
  type PublicProjectView,
} from '../src/codex-project-store.js'
import {hostWorkspaceForTest} from '../src/codex-process-owner.js'
import {
  CausalRuntime,
  type ExecutorDispatchContext,
  type ExecutorHandoff,
} from '../src/causal-runtime.js'
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
import {
  ProjectConfirmationController,
  type ConfirmedProjectOperation,
} from '../src/realtime/project-confirmation.js'
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

function proposalId(content: {readonly proposal_id?: unknown}): string {
  const value = content.proposal_id
  if (typeof value !== 'string') assert.fail('proposal_id must be a string')
  return value
}

function observeCriticalProjectContext(
  adapter: ProjectCodexAdapter,
  observer: (context: {
    readonly workspace_id: string | null
    readonly view: PublicProjectView
  }) => void | Promise<void>,
): () => void {
  const method = (adapter as unknown as {
    observeProjectContext?: (candidate: typeof observer) => () => void
  }).observeProjectContext
  if (typeof method !== 'function') assert.fail('critical project-context observer is required')
  return method.call(adapter, observer)
}

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
    readonly preflightError?: Error,
  ) {
    this.#remainingCloseFailures = closeFailures
  }

  preflight(): Promise<SafePreflightReport> {
    return this.preflightError === undefined
      ? Promise.resolve(PREFLIGHT)
      : Promise.reject(this.preflightError)
  }
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
  createFailure: Error | null = null
  preflightError: Error | undefined

  create(binding: ProjectTransportBinding): CodexAppServerTransport {
    if (this.createFailure !== null) throw this.createFailure
    const resume = binding.resumeThreadId !== null
    this.calls.push({resume})
    const transport = new ProjectTransport(
      this.overrideThreadId ?? binding.resumeThreadId ?? `thread-${this.calls.length}`,
      this.nextOutcome,
      this.reportThread,
      this.onRun,
      this.closeFailures,
      this.runGate,
      this.preflightError,
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
    {length: 100},
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

function storeWithBusyPublicContext(
  store: CodexProjectStore,
  busy: () => boolean,
): CodexProjectStore {
  return new Proxy(store, {
    get(target, property) {
      if (property === 'publicContext') {
        return async (pendingConfirmation: boolean) => {
          if (busy()) throw new ProjectStateError('state_busy')
          return await target.publicContext(pendingConfirmation)
        }
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) as unknown : value
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
  assert.deepEqual(adapter.manifest.ops.map(op => op.name), [
    'project', 'confirm_project_action', 'steer', 'status',
  ])
  assert.deepEqual([...compileToolSchema([adapter.manifest]).bindings.keys()].slice(-4), [
    'codex__project', 'codex__confirm_project_action', 'codex__steer', 'codex__status',
  ])
  assert.deepEqual(adapter.manifest.ops[0]?.sensitive_params, ['work_order'])
  assert.deepEqual(adapter.manifest.ops[1]?.sensitive_params, [])
})

test('project create proposal validates without mutating state or constructing transport', async () => {
  const value = await fixture()
  try {
    const before = await value.store.snapshot()
    const result = await value.adapter.dispatch(
      'project',
      {
        action: 'create_workspace', workspace: 'beta', session: 'Initial build',
        work_order: 'build it',
      },
      context('project', {}, value.clock),
    )
    assert.deepEqual(result.content, {
      op: 'project',
      code: 'confirmation_required',
      proposal_id: 'nonce-1',
      expires_at: 370,
      action: 'create_workspace',
      workspace: 'beta',
      session: 'Initial build',
      confirmation_prompt: '是否创建工作区“beta”并开始任务？请确认或取消。',
    })
    assert.deepEqual(await value.store.snapshot(), before)
    assert.equal(value.factory.calls.length, 0)

    const invalid = await value.adapter.dispatch(
      'project',
      {action: 'create_workspace', workspace: '../escape'},
      context('project', {}, value.clock),
    )
    assert.equal(invalid.outcome, 'refused')
    assert.deepEqual(invalid.content, {
      op: 'project', code: 'workspace_name_invalid', recoverable: true,
    })
    assert.equal(value.factory.calls.length, 0)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('create_workspace reuses the active workspace without confirmation', async () => {
  const value = await fixture()
  try {
    const result = await value.adapter.dispatch(
      'project',
      {
        action: 'create_workspace', workspace: 'ALPHA', session: 'Initial',
        work_order: 'build it',
      },
      context('project', {}, value.clock),
    )

    assert.equal(result.outcome, 'ok')
    assert.deepEqual(result.content, {
      op: 'project',
      code: 'workspace_reused',
      workspace: 'alpha',
      next_action: 'start_session',
      message: '将复用现有工作区“alpha”，不会创建新工作区。',
    })
    assert.equal(value.confirmation.pending, false)
    assert.deepEqual(await value.store.listSessions(await value.store.resolveWorkspace('alpha')), [])
    assert.equal(value.factory.calls.length, 0)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('confirmed create reuses an inactive workspace and starts exactly one Session', async () => {
  const value = await fixture()
  try {
    const alpha = await value.store.resolveWorkspace('alpha')
    const beta = await value.store.createManaged('beta')
    const proposal = await value.adapter.dispatch(
      'project',
      {
        action: 'create_workspace', workspace: 'ALPHA', session: 'Initial',
        work_order: 'build it',
      },
      context('project', {}, value.clock),
    )
    assert.deepEqual(proposal.content, {
      op: 'project', code: 'confirmation_required', proposal_id: 'nonce-1', expires_at: 370,
      action: 'reuse_workspace', workspace: 'alpha', session: 'Initial',
      confirmation_prompt: '是否使用现有工作区“alpha”并开始任务？请确认或取消。',
    })
    assert.equal(value.adapter.publicProjectView(true).pending_action, 'reuse_workspace')
    assert.equal(value.confirmation.reserveUserItem({epoch: 1, itemId: 'confirm'}), true)
    const decision = value.confirmation.acceptDecision({
      epoch: 1,
      itemId: 'confirm',
      proposalId: proposalId(proposal.content),
      confirmed: true,
    })
    assert.ok(decision.operation)
    const committed = await value.adapter.commitConfirmed(
      decision.operation,
      () => ({accepted: true, delegate_id: 'delegate-reuse'}),
    )
    assert.equal(committed.accepted, true)
    const executed = await value.adapter.dispatch(
      'project',
      {action: 'execute_confirmed'},
      context('project', {action: 'execute_confirmed'}, value.clock, {
        private: decision.operation,
        delegateId: 'delegate-reuse',
      }),
    )
    const replayed = await value.adapter.dispatch(
      'project',
      {action: 'execute_confirmed'},
      context('project', {action: 'execute_confirmed'}, value.clock, {
        private: decision.operation,
        delegateId: 'delegate-reuse',
      }),
    )

    assert.equal(executed.outcome, 'ok')
    assert.deepEqual(replayed.content, {error: 'confirmation_binding_mismatch', op: 'project'})
    assert.equal((await value.store.resolveWorkspace(null)).workspace_id, alpha.workspace_id)
    assert.deepEqual(
      (await value.store.listSessions(alpha)).map(item => [item.display_title, item.codex_thread_id]),
      [['Initial', 'thread-1']],
    )
    assert.deepEqual(await value.store.listSessions(beta), [])
    assert.equal((await value.store.listWorkspaces()).length, 2)
    assert.equal(value.factory.calls.length, 1)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('Session start rollback restores the previous active workspace', async () => {
  const value = await fixture()
  try {
    const alpha = await value.store.resolveWorkspace('alpha')
    const beta = await value.store.createManaged('beta')

    const begun = await value.store.beginSessionForRun(alpha.workspace_id, 'Initial')

    assert.equal((await value.store.resolveWorkspace(null)).workspace_id, alpha.workspace_id)
    assert.equal(await value.store.rollbackSessionStartForRun(begun.rollback, {wait: true}), true)
    assert.equal((await value.store.resolveWorkspace(null)).workspace_id, beta.workspace_id)
    assert.deepEqual(await value.store.listSessions(alpha), [])
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('Session start rollback preserves a newer workspace selection', async () => {
  const value = await fixture()
  try {
    const alpha = await value.store.resolveWorkspace('alpha')
    await value.store.createManaged('beta')
    const gamma = await value.store.createManaged('gamma')

    const begun = await value.store.beginSessionForRun(alpha.workspace_id, 'Initial')
    await value.store.selectWorkspaceExact(gamma.display_name, gamma.workspace_id)

    assert.equal(await value.store.rollbackSessionStartForRun(begun.rollback, {wait: true}), true)
    assert.equal((await value.store.resolveWorkspace(null)).workspace_id, gamma.workspace_id)
    assert.deepEqual(await value.store.listSessions(alpha), [])
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('failed confirmed reuse restores the previous active workspace', async () => {
  const value = await fixture()
  try {
    const alpha = await value.store.resolveWorkspace('alpha')
    const beta = await value.store.createManaged('beta')
    value.factory.preflightError = new CodexTransportError('preflight_failed')
    const proposal = await value.adapter.dispatch(
      'project',
      {
        action: 'create_workspace', workspace: 'alpha', session: 'Initial',
        work_order: 'build it',
      },
      context('project', {}, value.clock),
    )
    value.confirmation.reserveUserItem({epoch: 1, itemId: 'confirm-reuse-failure'})
    const decision = value.confirmation.acceptDecision({
      epoch: 1,
      itemId: 'confirm-reuse-failure',
      proposalId: proposalId(proposal.content),
      confirmed: true,
    })
    assert.ok(decision.operation)
    const committed = await value.adapter.commitConfirmed(
      decision.operation,
      () => ({accepted: true, delegate_id: 'delegate-reuse-failure'}),
    )
    assert.equal(committed.accepted, true)

    const result = await value.adapter.dispatch(
      'project',
      {action: 'execute_confirmed'},
      context('project', {action: 'execute_confirmed'}, value.clock, {
        private: decision.operation,
        delegateId: 'delegate-reuse-failure',
      }),
    )

    assert.equal(result.outcome, 'failed')
    assert.equal((await value.store.resolveWorkspace(null)).workspace_id, beta.workspace_id)
    assert.deepEqual(await value.store.listSessions(alpha), [])
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('a residual create race is recoverably refused before effects', async () => {
  const value = await fixture()
  try {
    const proposal = await value.adapter.dispatch(
      'project',
      {action: 'create_workspace', workspace: 'beta', work_order: 'build it'},
      context('project', {}, value.clock),
    )
    value.confirmation.reserveUserItem({epoch: 1, itemId: 'confirm'})
    const decision = value.confirmation.acceptDecision({
      epoch: 1,
      itemId: 'confirm',
      proposalId: proposalId(proposal.content),
      confirmed: true,
    })
    assert.ok(decision.operation)
    assert.equal((await value.adapter.commitConfirmed(
      decision.operation,
      () => ({accepted: true, delegate_id: 'delegate-race'}),
    )).accepted, true)
    await value.store.createManaged('beta')

    const result = await value.adapter.dispatch(
      'project',
      {action: 'execute_confirmed'},
      context('project', {action: 'execute_confirmed'}, value.clock, {
        private: decision.operation,
        delegateId: 'delegate-race',
      }),
    )

    assert.equal(result.outcome, 'refused')
    assert.deepEqual(result.content, {
      op: 'project', code: 'workspace_name_conflict', recoverable: true,
    })
    assert.equal(value.factory.calls.length, 0)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('workspace storage creation failure remains failed', async () => {
  let failCreate = false
  const value = await fixture({
    decorateStore: store => new Proxy(store, {
      get(target, property) {
        if (property === 'createManaged') {
          return async (displayName: string) => {
            if (failCreate) throw new ProjectStateError('workspace_create_failed')
            return await target.createManaged(displayName)
          }
        }
        const member: unknown = Reflect.get(target, property, target)
        return typeof member === 'function' ? member.bind(target) as unknown : member
      },
    }),
  })
  try {
    const proposal = await value.adapter.dispatch(
      'project',
      {action: 'create_workspace', workspace: 'beta', work_order: 'build it'},
      context('project', {}, value.clock),
    )
    value.confirmation.reserveUserItem({epoch: 1, itemId: 'confirm'})
    const decision = value.confirmation.acceptDecision({
      epoch: 1,
      itemId: 'confirm',
      proposalId: proposalId(proposal.content),
      confirmed: true,
    })
    assert.ok(decision.operation)
    assert.equal((await value.adapter.commitConfirmed(
      decision.operation,
      () => ({accepted: true, delegate_id: 'delegate-storage'}),
    )).accepted, true)
    failCreate = true

    const result = await value.adapter.dispatch(
      'project',
      {action: 'execute_confirmed'},
      context('project', {action: 'execute_confirmed'}, value.clock, {
        private: decision.operation,
        delegateId: 'delegate-storage',
      }),
    )

    assert.equal(result.outcome, 'failed')
    assert.deepEqual(result.content, {op: 'run', error: 'workspace_create_failed'})
    assert.equal(value.factory.calls.length, 0)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('list and start_session use the active workspace while public run and execute_confirmed stay closed', async () => {
  const value = await fixture()
  try {
    const listed = await value.adapter.dispatch(
      'project', {action: 'list_workspaces'}, context('project', {}, value.clock),
    )
    assert.equal(listed.content.code, 'listed')
    const started = await value.adapter.dispatch(
      'project',
      {action: 'start_session', session: 'Login fix', work_order: 'Fix login and run tests'},
      context('project', {}, value.clock),
    )
    assert.equal(started.outcome, 'ok')
    const active = await value.store.resolveWorkspace(null)
    assert.equal((await value.store.listSessions(active))[0]?.display_title, 'Login fix')
    assert.equal((await value.adapter.dispatch(
      'run', {work_order: 'forbidden'}, context('run', {work_order: 'forbidden'}, value.clock),
    )).outcome, 'failed')
    assert.equal((await value.adapter.dispatch(
      'project', {action: 'execute_confirmed'}, context('project', {}, value.clock),
    )).outcome, 'failed')
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('workspace and Session listings are capped at twenty most-recent records', async () => {
  const value = await fixture()
  try {
    for (let index = 0; index < 21; index += 1) {
      await value.store.createManaged(`workspace-${String(index).padStart(2, '0')}`)
    }
    const listed = await value.adapter.dispatch(
      'project', {action: 'list_workspaces'}, context('project', {}, value.clock),
    )
    assert.equal((listed.content.workspaces as readonly unknown[]).length, 20)
    const active = await value.store.resolveWorkspace(null)
    for (let index = 0; index < 21; index += 1) {
      const session = await value.store.beginSession(active.workspace_id, `task-${index}`)
      await value.store.markSessionReady(session.session_id, `thread-${index}`)
    }
    const sessions = await value.adapter.dispatch(
      'project', {action: 'list_sessions'}, context('project', {}, value.clock),
    )
    assert.equal((sessions.content.sessions as readonly unknown[]).length, 20)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('select and resume proposals expose public action IDs, expiry, and resolved display names', async () => {
  const value = await fixture({preexistingSession: true})
  try {
    const views: PublicProjectView[] = []
    value.adapter.observeProjectView(view => { views.push(view) })
    const selected = await value.adapter.dispatch(
      'project',
      {action: 'select_workspace', workspace: 'alpha'},
      context('project', {}, value.clock),
    )
    assert.deepEqual(selected.content, {
      op: 'project', code: 'confirmation_required', proposal_id: 'nonce-1', expires_at: 370,
      action: 'select_workspace', workspace: 'alpha', session: null,
      confirmation_prompt: '准备切换到工作区alpha，请确认或取消。',
    })
    assert.equal(views.at(-1)?.pending_action, 'select_workspace')
    assert.equal(views.at(-1)?.pending_workspace_display_name, 'alpha')
    const resumed = await value.adapter.dispatch(
      'project',
      {
        action: 'resume_session', workspace: 'alpha', session: 'existing',
        work_order: 'Continue the exact Session',
      },
      context('project', {}, value.clock),
    )
    assert.deepEqual(resumed.content, {
      op: 'project', code: 'confirmation_required', proposal_id: 'nonce-2', expires_at: 370,
      action: 'resume_session', workspace: 'alpha', session: 'Existing',
      confirmation_prompt: '准备切换到alpha，并继续 Session“Existing”，请确认或取消。',
    })
    assert.deepEqual(value.adapter.publicProjectView(true), {
      workspace_display_name: 'alpha',
      session_title: 'Existing',
      pending_confirmation: true,
      pending_confirmation_busy: false,
      pending_confirmation_id: 'nonce-2',
      pending_action: 'resume_session',
      pending_workspace_display_name: 'alpha',
      pending_session_title: 'Existing',
      pending_expires_in_seconds: 360,
    })
    assert.equal(views.at(-1)?.pending_action, 'resume_session')
    assert.equal(views.at(-1)?.pending_session_title, 'Existing')
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('a prepared proposal publishes cached target metadata when the registry refresh is busy',
  async () => {
    let busy = false
    const value = await fixture({
      decorateStore: store => storeWithBusyPublicContext(store, () => busy),
    })
    try {
      await value.adapter.initialize()
      const views: PublicProjectView[] = []
      value.adapter.observeProjectView(view => { views.push(view) })
      busy = true

      const proposal = await value.adapter.dispatch(
        'project',
        {action: 'create_workspace', workspace: 'beta', work_order: 'build it'},
        context('project', {}, value.clock),
      )

      assert.equal(proposal.content.code, 'confirmation_required')
      assert.deepEqual(views.at(-1), {
        workspace_display_name: 'alpha',
        session_title: null,
        pending_confirmation: true,
        pending_confirmation_busy: false,
        pending_confirmation_id: 'nonce-1',
        pending_action: 'create_workspace',
        pending_workspace_display_name: 'beta',
        pending_session_title: null,
        pending_expires_in_seconds: 360,
      })
    } finally {
      await value.adapter.close()
      await rm(value.root, {recursive: true, force: true})
    }
  })

test('initialize publishes the pre-existing active project using only its committed public view', async () => {
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
      pending_confirmation_busy: false,
    })
    assert.deepEqual(views.at(-1), value.adapter.publicProjectView(false))
    await value.adapter.dispatch(
      'project',
      {action: 'start_session', work_order: 'fresh session', session: 'Fresh'},
      context('project', {}, value.clock),
    )
    assert.equal(views.at(-1)?.session_title, 'Fresh')
    const beforeUnsubscribe = views.length
    unsubscribe()
    await value.adapter.dispatch(
      'project',
      {action: 'start_session', work_order: 'silent observer', session: 'Silent'},
      context('project', {}, value.clock),
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
      'project',
      {action: 'start_session', work_order: 'first', session: 'Task'},
      context('project', {}, value.clock),
    )
    const second = await value.adapter.dispatch(
      'project',
      {action: 'start_session', work_order: 'second', session: 'task'},
      context('project', {}, value.clock),
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

test('committed workspace and typed terminal observers run after authoritative boundaries', async () => {
  const value = await fixture()
  try {
    const workspaces: string[] = []
    const completions: string[] = []
    const unsubscribeWorkspace = value.adapter.observeCommittedWorkspace(event => {
      workspaces.push(`${event.workspace.workspace_id}:${event.workspace.canonical_path}`)
    })
    const unsubscribeCompletion = value.adapter.observeTerminalWorkOrder(event => {
      completions.push(`${event.workspace.workspace_id}:${event.work_order}:${event.handoff.outcome}`)
    })
    const result = await value.adapter.dispatch(
      'project',
      {action: 'start_session', work_order: 'typed completion', session: 'Observed'},
      context('project', {}, value.clock),
    )
    assert.equal(result.outcome, 'ok')
    assert.equal(workspaces.length, 1)
    assert.match(workspaces[0] ?? '', /^workspace-/u)
    assert.deepEqual(completions.map(item => item.split(':').slice(1)), [['typed completion', 'ok']])
    unsubscribeWorkspace()
    unsubscribeCompletion()
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('confirmed resume binds one exact capability, delegate, origin, work order, and stored thread', async () => {
  const value = await fixture()
  try {
    await value.adapter.dispatch(
      'project',
      {action: 'start_session', work_order: 'first', session: 'Task'},
      context('project', {}, value.clock),
    )
    const proposed = await value.adapter.dispatch(
      'project',
      {action: 'resume_session', workspace: 'alpha', session: 'Task', work_order: 'continue'},
      context('project', {}, value.clock),
    )
    assert.equal(proposed.content.code, 'confirmation_required')
    assert.equal(value.confirmation.reserveUserItem({epoch: 1, itemId: 'user-confirm'}), true)
    const confirmed = value.confirmation.acceptDecision({
      epoch: 1, itemId: 'user-confirm', proposalId: proposalId(proposed.content), confirmed: true,
    })
    assert.ok(confirmed.operation)
    let delegated: DelegateRequest | null = null
    let delegatedReason: WakeReason | null = null
    let delegatedCapability: object | null = null
    const committed = await value.adapter.commitConfirmed(
      confirmed.operation,
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
      'project',
      {action: 'execute_confirmed'},
      context('project', {action: 'execute_confirmed'}, value.clock, {
        private: confirmed.operation,
        delegateId: 'delegate-resume',
        originRef: confirmed.operation.origin_ref,
      }),
    )
    assert.equal(resumed.outcome, 'ok')
    assert.deepEqual(value.factory.calls, [{resume: false}, {resume: true}])

    const replay = await value.adapter.dispatch(
      'project',
      {action: 'execute_confirmed'},
      context('project', {action: 'execute_confirmed'}, value.clock, {
        private: confirmed.operation,
        delegateId: 'delegate-resume',
        originRef: confirmed.operation.origin_ref,
      }),
    )
    assert.deepEqual(replay.content, {error: 'confirmation_binding_mismatch', op: 'project'})
    assert.equal(value.factory.calls.length, 2)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('confirmed reuse revalidates workspace identity before dispatch', async () => {
  const value = await fixture()
  try {
    const alpha = await value.store.resolveWorkspace('alpha')
    const original = await value.store.createManaged('beta')
    await value.store.selectWorkspaceExact(alpha.display_name, alpha.workspace_id)
    const proposal = await value.adapter.dispatch(
      'project',
      {action: 'create_workspace', workspace: 'beta', work_order: 'build it'},
      context('project', {}, value.clock),
    )
    value.confirmation.reserveUserItem({epoch: 1, itemId: 'confirm-reuse-identity'})
    const confirmed = value.confirmation.acceptDecision({
      epoch: 1,
      itemId: 'confirm-reuse-identity',
      proposalId: proposalId(proposal.content),
      confirmed: true,
    })
    assert.ok(confirmed.operation)
    assert.equal(await value.store.rollbackManagedCreate(original.workspace_id), true)
    const replacement = await value.store.createManaged('beta')
    const dispatched: DelegateRequest[] = []

    const committed = await value.adapter.commitConfirmed(
      confirmed.operation,
      request => {
        dispatched.push(request)
        return {accepted: true, delegate_id: 'delegate-reuse-identity'}
      },
    )

    assert.deepEqual(committed, {accepted: false, code: 'workspace_boundary_changed'})
    assert.deepEqual(dispatched, [])
    assert.equal((await value.store.resolveWorkspace('beta')).workspace_id, replacement.workspace_id)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('confirmed resume revalidates ready state before runtime dispatch', async () => {
  const value = await fixture({preexistingSession: true})
  try {
    const workspace = await value.store.resolveWorkspace('alpha')
    const session = await value.store.resolveSession(workspace.workspace_id, 'Existing')
    const proposal = await value.adapter.dispatch(
      'project',
      {
        action: 'resume_session', workspace: 'alpha', session: 'Existing',
        work_order: 'continue it',
      },
      context('project', {}, value.clock),
    )
    value.confirmation.reserveUserItem({epoch: 1, itemId: 'confirm-resume-state'})
    const confirmed = value.confirmation.acceptDecision({
      epoch: 1,
      itemId: 'confirm-resume-state',
      proposalId: proposalId(proposal.content),
      confirmed: true,
    })
    assert.ok(confirmed.operation)
    await value.store.markSessionUnavailable(session.session_id)
    const dispatched: DelegateRequest[] = []

    const committed = await value.adapter.commitConfirmed(
      confirmed.operation,
      request => {
        dispatched.push(request)
        return {accepted: true, delegate_id: 'delegate-resume-state'}
      },
    )

    assert.deepEqual(committed, {accepted: false, code: 'session_unavailable'})
    assert.deepEqual(dispatched, [])
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
    const proposal = await value.adapter.dispatch(
      'project',
      {action: 'create_workspace', workspace: 'beta', work_order: 'exact work'},
      context('project', {}, value.clock, {originRef}),
    )
    value.confirmation.reserveUserItem({epoch: 1, itemId: 'confirm-real'})
    const confirmed = value.confirmation.acceptDecision({
      epoch: 1,
      itemId: 'confirm-real',
      proposalId: proposalId(proposal.content),
      confirmed: true,
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
      (request, reason, capability) => runtime.dispatchConfirmedExternal(
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
    assert.equal(JSON.stringify(delegate).includes(confirmed.operation.proposal_id), false)
    await settleWithin('real confirmed adapter handoff', handoff)
    assert.deepEqual(
      (await value.store.listWorkspaces()).map(workspace => workspace.display_name).sort(),
      ['alpha', 'beta'],
    )
    const beta = await value.store.resolveWorkspace('beta')
    assert.equal((await value.store.listSessions(beta))[0]?.display_title, '任务 1')
  } finally {
    stop.abort()
    await serving
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('wrong delegate, origin, copied capability, rejection, and replay have zero side effects', async () => {
  const value = await fixture()
  try {
    const proposal = await value.adapter.dispatch(
      'project',
      {action: 'create_workspace', workspace: 'beta', session: 'Initial', work_order: 'exact work'},
      context('project', {}, value.clock),
    )
    assert.equal(proposal.content.code, 'confirmation_required')
    value.confirmation.reserveUserItem({epoch: 1, itemId: 'confirm'})
    const outcome = value.confirmation.acceptDecision({
      epoch: 1, itemId: 'confirm', proposalId: proposalId(proposal.content), confirmed: true,
    })
    assert.ok(outcome.operation)
    const rejected = await value.adapter.commitConfirmed(
      outcome.operation,
      () => ({accepted: false, delegate_id: null}),
    )
    assert.deepEqual(rejected, {accepted: false, code: 'runtime_rejected'})
    assert.deepEqual((await value.store.listWorkspaces()).map(item => item.display_name), ['alpha'])
    assert.equal(value.factory.calls.length, 0)

    const replayAfterRejection = await value.adapter.dispatch(
      'project',
      {action: 'execute_confirmed'},
      context('project', {action: 'execute_confirmed'}, value.clock, {
        private: outcome.operation,
        delegateId: 'delegate-rejected',
        originRef: outcome.operation.origin_ref,
      }),
    )
    assert.deepEqual(replayAfterRejection.content, {
      error: 'confirmation_binding_mismatch', op: 'project',
    })

    const secondProposal = await value.adapter.dispatch(
      'project',
      {action: 'create_workspace', workspace: 'beta', session: 'Initial', work_order: 'exact work'},
      context('project', {}, value.clock),
    )
    assert.equal(secondProposal.content.code, 'confirmation_required')
    value.confirmation.reserveUserItem({epoch: 2, itemId: 'confirm-2'})
    const second = value.confirmation.acceptDecision({
      epoch: 2, itemId: 'confirm-2', proposalId: proposalId(secondProposal.content), confirmed: true,
    })
    assert.ok(second.operation)
    await value.adapter.commitConfirmed(
      second.operation,
      () => ({accepted: true, delegate_id: 'delegate-exact'}),
    )
    const copied = {...second.operation}
    for (const attempt of [
      {private: copied, delegateId: 'delegate-exact', originRef: 'conversation:3', workOrder: 'exact work'},
      {private: second.operation, delegateId: 'delegate-wrong', originRef: 'conversation:3', workOrder: 'exact work'},
      {private: second.operation, delegateId: 'delegate-exact', originRef: 'conversation:4', workOrder: 'exact work'},
    ]) {
      const result = await value.adapter.dispatch(
        'project',
        {action: 'execute_confirmed'},
        context('project', {action: 'execute_confirmed'}, value.clock, attempt),
      )
      assert.deepEqual(result.content, {error: 'confirmation_binding_mismatch', op: 'project'})
      assert.equal(value.factory.calls.length, 0)
      assert.deepEqual((await value.store.listWorkspaces()).map(item => item.display_name), ['alpha'])
    }

    const accepted = await value.adapter.dispatch(
      'project',
      {action: 'execute_confirmed'},
      context('project', {action: 'execute_confirmed'}, value.clock, {
        private: second.operation,
        delegateId: 'delegate-exact',
        originRef: second.operation.origin_ref,
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
    const committedWorkspaces: string[] = []
    value.adapter.observeCommittedWorkspace(event => {
      committedWorkspaces.push(event.workspace.display_name)
    })
    value.factory.reportThread = false
    const failed = await value.adapter.dispatch(
      'project',
      {action: 'start_session', work_order: 'cannot bind'},
      context('project', {}, value.clock),
    )
    assert.deepEqual(failed.content, {error: 'thread_id_invalid', op: 'run', stage: 'thread_start'})
    const alpha = await value.store.resolveWorkspace('alpha')
    assert.deepEqual(await value.store.listSessions(alpha), [])

    const proposal = await value.adapter.dispatch(
      'project',
      {action: 'create_workspace', workspace: 'beta', session: 'Initial', work_order: 'cannot bind'},
      context('project', {}, value.clock),
    )
    value.confirmation.reserveUserItem({epoch: 1, itemId: 'confirm'})
    const outcome = value.confirmation.acceptDecision({
      epoch: 1, itemId: 'confirm', proposalId: proposalId(proposal.content), confirmed: true,
    })
    assert.ok(outcome.operation)
    await value.adapter.commitConfirmed(
      outcome.operation,
      () => ({accepted: true, delegate_id: 'delegate-create'}),
    )
    const result = await value.adapter.dispatch(
      'project',
      {action: 'execute_confirmed'},
      context('project', {action: 'execute_confirmed'}, value.clock, {
        private: outcome.operation,
        delegateId: 'delegate-create',
        originRef: outcome.operation.origin_ref,
      }),
    )
    assert.equal(result.outcome, 'failed')
    assert.deepEqual(committedWorkspaces, ['alpha'],
      'a confirmed create that rolls back must never become graph evidence')
    assert.deepEqual((await value.store.listWorkspaces()).map(item => item.display_name), ['alpha'])
    const publicView = value.adapter.publicProjectView(false)
    assert.deepEqual(publicView, {
      workspace_display_name: 'alpha',
      session_title: null,
      pending_confirmation: false,
      pending_confirmation_busy: false,
    })
    assert.deepEqual(Object.keys(publicView).sort(), [
      'pending_confirmation', 'pending_confirmation_busy', 'session_title',
      'workspace_display_name',
    ])
    assert.equal(JSON.stringify(publicView).includes('thread'), false)
    assert.equal(JSON.stringify(publicView).includes('nonce'), false)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('threadless preflight failures preserve their safe category, stage, rollback, and terminal observation', async () => {
  for (const [code, stage] of [
    ['preflight_failed', 'preflight'],
    ['credential_missing', 'credential'],
  ] as const) {
    const value = await fixture()
    try {
      const terminals: ExecutorHandoff[] = []
      value.adapter.observeTerminalWorkOrder(event => { terminals.push(event.handoff) })
      value.factory.preflightError = new CodexTransportError(code)

      const failed = await value.adapter.dispatch(
        'project',
        {action: 'start_session', work_order: `fail at ${stage}`},
        context('project', {}, value.clock),
      )

      assert.equal(failed.outcome, 'failed')
      assert.equal(failed.content.code, code)
      assert.equal(failed.content.stage, stage)
      assert.equal(failed.content.error, undefined)
      const alpha = await value.store.resolveWorkspace('alpha')
      assert.deepEqual(await value.store.listSessions(alpha), [])
      assert.deepEqual(terminals, [failed])
    } finally {
      await value.adapter.close()
      await rm(value.root, {recursive: true, force: true})
    }
  }
})

test('threadless transport refusal stays the real failure instead of becoming thread_id_invalid', async () => {
  const value = await fixture()
  try {
    const terminals: ExecutorHandoff[] = []
    value.adapter.observeTerminalWorkOrder(event => { terminals.push(event.handoff) })
    value.factory.reportThread = false
    value.factory.nextOutcome = {
      classification: 'refused', code: 'server_rejected', turnStartWritten: false, completion: null,
    }

    const failed = await value.adapter.dispatch(
      'project',
      {action: 'start_session', work_order: 'fail during thread start'},
      context('project', {}, value.clock),
    )

    assert.equal(failed.outcome, 'failed')
    assert.equal(failed.content.code, 'worker_refused')
    assert.equal(failed.content.stage, 'thread_start')
    const alpha = await value.store.resolveWorkspace('alpha')
    assert.deepEqual(await value.store.listSessions(alpha), [])
    assert.deepEqual(terminals, [failed])
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('spawn failure returns a safe staged terminal and rolls back the provisional Session', async () => {
  const value = await fixture()
  try {
    const terminals: ExecutorHandoff[] = []
    value.adapter.observeTerminalWorkOrder(event => { terminals.push(event.handoff) })
    value.factory.createFailure = new CodexTransportError('spawn_failed')

    const failed = await value.adapter.dispatch(
      'project',
      {action: 'start_session', work_order: 'fail while spawning'},
      context('project', {}, value.clock),
    )

    assert.deepEqual(failed.content, {error: 'spawn_failed', op: 'run', stage: 'spawn'})
    const alpha = await value.store.resolveWorkspace('alpha')
    assert.deepEqual(await value.store.listSessions(alpha), [])
    assert.deepEqual(terminals, [failed])
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
        'project',
        {action: 'start_session', work_order: 'cancel after begin'},
        context('project', {}, value.clock, {
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

test('active Session view publishes before transport run and republishes rollback restoration', async () => {
  const value = await fixture()
  const views: PublicProjectView[] = []
  let releasePublication!: () => void
  const publicationGate = new Promise<void>(resolve => { releasePublication = resolve })
  let publicationStarted!: () => void
  const publicationObserved = new Promise<void>(resolve => { publicationStarted = resolve })
  value.adapter.observeProjectView(async view => {
    views.push(view)
    if (view.session_title === '任务 1') {
      publicationStarted()
      await publicationGate
    }
  })
  await value.adapter.initialize()
  let release!: (outcome: TransportOutcome) => void
  const gate = new Promise<TransportOutcome>(resolve => { release = resolve })
  value.factory.runGate = gate
  let running!: () => void
  const started = new Promise<void>(resolve => { running = resolve })
  let transportStarted = false
  value.factory.onRun = () => {
    transportStarted = true
    running()
  }
  try {
    const run = value.adapter.dispatch(
      'project',
      {action: 'start_session', work_order: 'publish before transport'},
      context('project', {}, value.clock),
    )
    await settleWithin('provider observes active Session', publicationObserved)
    await new Promise<void>(resolve => { setImmediate(resolve) })
    const transportStartedEarly = transportStarted
    releasePublication()
    if (transportStartedEarly) {
      release(COMPLETE)
      await run
    }
    assert.equal(transportStartedEarly, false, 'transport must wait for active-context publication')
    await settleWithin('transport starts', started)
    const runningView = value.adapter.publicProjectView(false)
    const publishedRunningView = views.at(-1)
    release(COMPLETE)
    assert.equal((await run).outcome, 'ok')
    assert.equal(runningView.session_title, '任务 1')
    assert.equal(publishedRunningView?.session_title, '任务 1')

    value.factory.runGate = undefined
    value.factory.onRun = undefined
    value.factory.createFailure = new Error('construction failed')
    await assert.rejects(value.adapter.dispatch(
      'project',
      {action: 'start_session', work_order: 'rollback construction'},
      context('project', {}, value.clock),
    ), /construction failed/u)
    assert.equal(value.adapter.publicProjectView(false).session_title, '任务 1')
    assert.deepEqual(views.slice(-2).map(view => view.session_title), ['任务 2', '任务 1'])
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('critical active Session publication fails closed and rolls back on persistent state_busy',
  async () => {
    const value = await fixture({
      decorateStore: store => new Proxy(store, {
        get(target, property) {
          if (property === 'publicContext') {
            return (): never => { throw new ProjectStateError('state_busy') }
          }
          const member: unknown = Reflect.get(target, property, target)
          if (typeof member !== 'function') return member
          const bound: unknown = member.bind(target)
          return bound
        },
      }),
    })
    try {
      const result = await value.adapter.dispatch(
        'project',
        {action: 'start_session', work_order: 'must not run without provider context'},
        context('project', {}, value.clock),
      )

      assert.deepEqual(result.content, {error: 'state_busy', op: 'run'})
      assert.equal(value.factory.calls.length, 0)
      const active = await value.store.resolveWorkspace(null)
      assert.equal(active.display_name, 'alpha')
      assert.deepEqual(await value.store.listSessions(active), [])
    } finally {
      await value.adapter.close()
      await rm(value.root, {recursive: true, force: true})
    }
  })

test('a successful new run stays successful when only ready-state finalization is busy', async () => {
  const value = await fixture({
    decorateStore: store => new Proxy(store, {
      get(target, property) {
        if (property === 'markSessionReady') {
          return (): never => { throw new ProjectStateError('state_busy') }
        }
        const member: unknown = Reflect.get(target, property, target)
        if (typeof member !== 'function') return member
        const bound: unknown = member.bind(target)
        return bound
      },
    }),
  })
  try {
    const result = await value.adapter.dispatch(
      'project',
      {action: 'start_session', work_order: 'completed despite bookkeeping contention'},
      context('project', {}, value.clock),
    )

    assert.equal(result.outcome, 'ok')
    assert.equal(result.content.code, 'completed')
    const active = await value.store.resolveWorkspace(null)
    assert.deepEqual(await value.store.listSessions(active), [])
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('critical provider publication failure rolls back before transport while UI remains advisory',
  async () => {
    const value = await fixture()
    const critical: {readonly workspace_id: string | null; readonly title: string | null}[] = []
    value.adapter.observeProjectView(() => { throw new Error('UI renderer failed') })
    const unsubscribe = observeCriticalProjectContext(value.adapter, contextValue => {
      critical.push({
        workspace_id: contextValue.workspace_id,
        title: contextValue.view.session_title,
      })
      if (contextValue.view.session_title === '任务 1') {
        throw new Error('provider delivery proof mismatch')
      }
    })
    try {
      const result = await value.adapter.dispatch(
        'project',
        {action: 'start_session', work_order: 'must not reach transport'},
        context('project', {}, value.clock),
      )

      assert.deepEqual(result.content, {error: 'context_delivery_failed', op: 'run'})
      assert.equal(value.factory.calls.length, 0)
      const active = await value.store.resolveWorkspace(null)
      assert.equal(active.display_name, 'alpha')
      assert.deepEqual(await value.store.listSessions(active), [])
      assert.deepEqual(critical, [
        {workspace_id: active.workspace_id, title: '任务 1'},
        {workspace_id: active.workspace_id, title: null},
      ])
    } finally {
      unsubscribe()
      await value.adapter.close()
      await rm(value.root, {recursive: true, force: true})
    }
  })

test('failed restored publication overrides transport setup failure and keeps the run fenced',
  async () => {
    const value = await fixture()
    value.factory.createFailure = new Error('transport setup failed')
    const critical: (string | null)[] = []
    const unsubscribe = observeCriticalProjectContext(value.adapter, contextValue => {
      critical.push(contextValue.view.session_title)
      if (contextValue.view.session_title === null) {
        throw new Error('provider rejected restored context')
      }
    })
    try {
      const result = await value.adapter.dispatch(
        'project',
        {action: 'start_session', work_order: 'must remain fenced'},
        context('project', {}, value.clock),
      )

      assert.deepEqual(result.content, {error: 'context_delivery_failed', op: 'run'})
      assert.equal(value.factory.calls.length, 0)
      assert.deepEqual(critical, ['任务 1', null])
      const active = await value.store.resolveWorkspace(null)
      assert.deepEqual(await value.store.listSessions(active), [])
    } finally {
      unsubscribe()
      await value.adapter.close()
      await rm(value.root, {recursive: true, force: true})
    }
  })

test('critical resume publication failure restores the previously active workspace before transport',
  async () => {
    const value = await fixture({preexistingSession: true})
    const alpha = await value.store.resolveWorkspace('alpha')
    const other = await value.store.beginSession(alpha.workspace_id, 'Other')
    await value.store.markSessionReady(other.session_id, 'thread-other')
    const beta = await value.store.createManaged('beta')
    const critical: {readonly workspace: string | null; readonly session: string | null}[] = []
    let rejectResume = true
    const unsubscribe = observeCriticalProjectContext(value.adapter, contextValue => {
      critical.push({
        workspace: contextValue.view.workspace_display_name,
        session: contextValue.view.session_title,
      })
      if (rejectResume && contextValue.view.session_title === 'Existing') {
        rejectResume = false
        throw new Error('provider rejected resumed context')
      }
    })
    try {
      const proposed = await value.adapter.dispatch(
        'project',
        {
          action: 'resume_session', workspace: 'alpha', session: 'Existing',
          work_order: 'must not reach transport',
        },
        context('project', {}, value.clock),
      )
      value.confirmation.reserveUserItem({epoch: 1, itemId: 'confirm-resume-barrier'})
      const confirmed = value.confirmation.acceptDecision({
        epoch: 1,
        itemId: 'confirm-resume-barrier',
        proposalId: proposalId(proposed.content),
        confirmed: true,
      })
      assert.ok(confirmed.operation)
      assert.equal((await value.adapter.commitConfirmed(
        confirmed.operation,
        () => ({accepted: true, delegate_id: 'delegate-resume-barrier'}),
      )).accepted, true)

      const result = await value.adapter.dispatch(
        'project',
        {action: 'execute_confirmed'},
        context('project', {action: 'execute_confirmed'}, value.clock, {
          private: confirmed.operation,
          delegateId: 'delegate-resume-barrier',
          originRef: confirmed.operation.origin_ref,
        }),
      )

      assert.deepEqual(result.content, {error: 'context_delivery_failed', op: 'run'})
      assert.equal(value.factory.calls.length, 0)
      assert.equal((await value.store.resolveWorkspace(null)).workspace_id, beta.workspace_id)
      assert.equal(
        (await value.store.resolveWorkspace('alpha')).active_session_id,
        other.session_id,
      )
      assert.deepEqual(critical, [
        {workspace: 'alpha', session: 'Existing'},
        {workspace: 'beta', session: null},
      ])
    } finally {
      unsubscribe()
      await value.adapter.close()
      await rm(value.root, {recursive: true, force: true})
    }
  })

test('same-id concurrent resume revision prevents an older failed publication from ABA rollback',
  async () => {
    const value = await fixture({preexistingSession: true})
    const alpha = await value.store.resolveWorkspace('alpha')
    const existing = await value.store.resolveSession(alpha.workspace_id, 'Existing')
    const other = await value.store.beginSession(alpha.workspace_id, 'Other')
    await value.store.markSessionReady(other.session_id, 'thread-other')
    await value.store.createManaged('beta')
    const critical: {readonly workspace: string | null; readonly session: string | null}[] = []
    let raceInjected = false
    const unsubscribe = observeCriticalProjectContext(value.adapter, async contextValue => {
      critical.push({
        workspace: contextValue.view.workspace_display_name,
        session: contextValue.view.session_title,
      })
      if (!raceInjected && contextValue.view.session_title === 'Existing') {
        raceInjected = true
        await value.store.prepareSessionResumeForRun(
          alpha.workspace_id,
          existing.session_id,
          existing.codex_thread_id ?? '',
        )
        throw new Error('older provider proof failed after same-id resume')
      }
    })
    try {
      const proposed = await value.adapter.dispatch(
        'project',
        {
          action: 'resume_session', workspace: 'alpha', session: 'Existing',
          work_order: 'must not reach transport',
        },
        context('project', {}, value.clock),
      )
      value.confirmation.reserveUserItem({epoch: 1, itemId: 'confirm-resume-aba'})
      const confirmed = value.confirmation.acceptDecision({
        epoch: 1,
        itemId: 'confirm-resume-aba',
        proposalId: proposalId(proposed.content),
        confirmed: true,
      })
      assert.ok(confirmed.operation)
      assert.equal((await value.adapter.commitConfirmed(
        confirmed.operation,
        () => ({accepted: true, delegate_id: 'delegate-resume-aba'}),
      )).accepted, true)

      const result = await value.adapter.dispatch(
        'project',
        {action: 'execute_confirmed'},
        context('project', {action: 'execute_confirmed'}, value.clock, {
          private: confirmed.operation,
          delegateId: 'delegate-resume-aba',
          originRef: confirmed.operation.origin_ref,
        }),
      )

      assert.deepEqual(result.content, {error: 'context_delivery_failed', op: 'run'})
      assert.equal(value.factory.calls.length, 0)
      assert.equal((await value.store.resolveWorkspace(null)).workspace_id, alpha.workspace_id)
      assert.equal(
        (await value.store.resolveWorkspace('alpha')).active_session_id,
        existing.session_id,
      )
      assert.deepEqual(critical, [
        {workspace: 'alpha', session: 'Existing'},
        {workspace: 'alpha', session: 'Existing'},
      ])
    } finally {
      unsubscribe()
      await value.adapter.close()
      await rm(value.root, {recursive: true, force: true})
    }
  })

test('critical confirmed-create publication failure removes the workspace and republishes prior state',
  async () => {
    const value = await fixture()
    const critical: {readonly workspace: string | null; readonly session: string | null}[] = []
    let rejectCreate = true
    const unsubscribe = observeCriticalProjectContext(value.adapter, contextValue => {
      critical.push({
        workspace: contextValue.view.workspace_display_name,
        session: contextValue.view.session_title,
      })
      if (rejectCreate && contextValue.view.workspace_display_name === 'beta') {
        rejectCreate = false
        throw new Error('provider rejected created workspace context')
      }
    })
    try {
      const proposed = await value.adapter.dispatch(
        'project',
        {action: 'create_workspace', workspace: 'beta', work_order: 'must not reach transport'},
        context('project', {}, value.clock),
      )
      value.confirmation.reserveUserItem({epoch: 1, itemId: 'confirm-create-barrier'})
      const confirmed = value.confirmation.acceptDecision({
        epoch: 1,
        itemId: 'confirm-create-barrier',
        proposalId: proposalId(proposed.content),
        confirmed: true,
      })
      assert.ok(confirmed.operation)
      assert.equal((await value.adapter.commitConfirmed(
        confirmed.operation,
        () => ({accepted: true, delegate_id: 'delegate-create-barrier'}),
      )).accepted, true)

      const result = await value.adapter.dispatch(
        'project',
        {action: 'execute_confirmed'},
        context('project', {action: 'execute_confirmed'}, value.clock, {
          private: confirmed.operation,
          delegateId: 'delegate-create-barrier',
          originRef: confirmed.operation.origin_ref,
        }),
      )

      assert.deepEqual(result.content, {error: 'context_delivery_failed', op: 'run'})
      assert.equal(value.factory.calls.length, 0)
      assert.deepEqual((await value.store.listWorkspaces()).map(item => item.display_name), ['alpha'])
      assert.deepEqual(critical.at(-1), {workspace: 'alpha', session: null})
    } finally {
      unsubscribe()
      await value.adapter.close()
      await rm(value.root, {recursive: true, force: true})
    }
  })

test('confirmed select publishes one atomic context before committed graph notification', async () => {
  const value = await fixture()
  await value.store.createManaged('beta')
  const order: string[] = []
  const unsubscribeContext = observeCriticalProjectContext(value.adapter, contextValue => {
    order.push(`context:${contextValue.workspace_id}:${contextValue.view.workspace_display_name}`)
  })
  const unsubscribeCommitted = value.adapter.observeCommittedWorkspace(event => {
    order.push(`committed:${event.workspace.workspace_id}:${event.workspace.display_name}`)
  })
  try {
    const proposed = await value.adapter.dispatch(
      'project',
      {action: 'select_workspace', workspace: 'alpha'},
      context('project', {}, value.clock),
    )
    value.confirmation.reserveUserItem({epoch: 1, itemId: 'confirm-select-order'})
    const confirmed = value.confirmation.acceptDecision({
      epoch: 1,
      itemId: 'confirm-select-order',
      proposalId: proposalId(proposed.content),
      confirmed: true,
    })
    assert.ok(confirmed.operation)
    const committed = await value.adapter.commitConfirmed(
      confirmed.operation,
      () => ({accepted: false, delegate_id: null}),
    )
    assert.deepEqual(committed, {accepted: true, code: 'committed'})
    const alpha = await value.store.resolveWorkspace('alpha')
    assert.deepEqual(order, [
      `context:${alpha.workspace_id}:alpha`,
      `committed:${alpha.workspace_id}:alpha`,
    ])
  } finally {
    unsubscribeContext()
    unsubscribeCommitted()
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('confirmed resume publishes atomic Session before graph notification and transport', async () => {
  const value = await fixture({preexistingSession: true})
  await value.store.createManaged('beta')
  const order: string[] = []
  const unsubscribeContext = observeCriticalProjectContext(value.adapter, contextValue => {
    order.push(`context:${contextValue.view.workspace_display_name}:${contextValue.view.session_title}`)
  })
  const unsubscribeCommitted = value.adapter.observeCommittedWorkspace(event => {
    order.push(`committed:${event.workspace.display_name}`)
  })
  value.factory.onRun = () => { order.push('transport') }
  try {
    const proposed = await value.adapter.dispatch(
      'project',
      {
        action: 'resume_session', workspace: 'alpha', session: 'Existing',
        work_order: 'continue after atomic publication',
      },
      context('project', {}, value.clock),
    )
    value.confirmation.reserveUserItem({epoch: 1, itemId: 'confirm-resume-order'})
    const confirmed = value.confirmation.acceptDecision({
      epoch: 1,
      itemId: 'confirm-resume-order',
      proposalId: proposalId(proposed.content),
      confirmed: true,
    })
    assert.ok(confirmed.operation)
    assert.equal((await value.adapter.commitConfirmed(
      confirmed.operation,
      () => ({accepted: true, delegate_id: 'delegate-resume-order'}),
    )).accepted, true)
    const result = await value.adapter.dispatch(
      'project',
      {action: 'execute_confirmed'},
      context('project', {action: 'execute_confirmed'}, value.clock, {
        private: confirmed.operation,
        delegateId: 'delegate-resume-order',
        originRef: confirmed.operation.origin_ref,
      }),
    )
    assert.equal(result.outcome, 'ok')
    assert.deepEqual(order.slice(0, 3), [
      'context:alpha:Existing',
      'committed:alpha',
      'transport',
    ])
  } finally {
    unsubscribeContext()
    unsubscribeCommitted()
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})

test('transport close rejection cannot downgrade a completed side effect into a retryable failure', async () => {
  const value = await fixture()
  try {
    value.factory.closeFailures = 1
    const result = await value.adapter.dispatch(
      'project',
      {action: 'start_session', work_order: 'completed before cleanup'},
      context('project', {}, value.clock),
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
      'project',
      {action: 'start_session', work_order: 'new process only after retained cleanup'},
      context('project', {}, value.clock),
    )
    assert.equal(second.outcome, 'ok')
    assert.equal(value.factory.transports[0]?.closeCalls, 2)
    assert.equal(value.factory.transports.length, 2)
  } finally {
    await value.adapter.close().catch(() => undefined)
    await rm(value.root, {recursive: true, force: true})
  }
})

test('busy project work reports the unified project op for public and confirmed execution', async () => {
  const value = await fixture()
  let startedResolve!: () => void
  let finishResolve!: (outcome: TransportOutcome) => void
  const started = new Promise<void>(resolve => { startedResolve = resolve })
  value.factory.onRun = startedResolve
  value.factory.runGate = new Promise<TransportOutcome>(resolve => { finishResolve = resolve })
  try {
    const proposal = await value.adapter.dispatch(
      'project',
      {action: 'create_workspace', workspace: 'beta', session: 'Initial', work_order: 'build'},
      context('project', {}, value.clock, {originRef: 'conversation:2'}),
    )
    value.confirmation.reserveUserItem({epoch: 1, itemId: 'confirm-busy'})
    const confirmed = value.confirmation.acceptDecision({
      epoch: 1, itemId: 'confirm-busy', proposalId: proposalId(proposal.content), confirmed: true,
    })
    assert.ok(confirmed.operation)
    await value.adapter.commitConfirmed(
      confirmed.operation,
      () => ({accepted: true, delegate_id: 'delegate-confirmed'}),
    )
    const running = value.adapter.dispatch(
      'project',
      {action: 'start_session', work_order: 'blocking'},
      context('project', {}, value.clock),
    )
    await settleWithin('busy project run start', started)

    const publicBusy = await value.adapter.dispatch(
      'project',
      {action: 'start_session', work_order: 'overtake'},
      context('project', {}, value.clock),
    )
    const confirmedBusy = await value.adapter.dispatch(
      'project',
      {action: 'execute_confirmed'},
      context('project', {action: 'execute_confirmed'}, value.clock, {
        private: confirmed.operation,
        delegateId: 'delegate-confirmed',
        originRef: confirmed.operation.origin_ref,
      }),
    )

    finishResolve(COMPLETE)
    assert.equal((await settleWithin('busy project run completion', running)).outcome, 'ok')
    assert.deepEqual(publicBusy.content, {error: 'busy', op: 'project'})
    assert.deepEqual(confirmedBusy.content, {error: 'busy', op: 'project'})
  } finally {
    finishResolve?.(COMPLETE)
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
    'project',
    {action: 'start_session', work_order: 'close while running'},
    context('project', {}, value.clock),
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
    await symlink(replacement, workspacePath, process.platform === 'win32' ? 'junction' : 'dir')

    const result = await value.adapter.dispatch(
      'project',
      {action: 'start_session', work_order: 'must not start'},
      context('project', {}, value.clock),
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
      await symlink(replacement, workspacePath, process.platform === 'win32' ? 'junction' : 'dir')
    }),
  })
  rootPath = value.root
  try {
    replace = true
    const result = await value.adapter.dispatch(
      'project',
      {action: 'start_session', work_order: 'must not bind replacement'},
      context('project', {}, value.clock),
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
      'project',
      {action: 'start_session', work_order: 'first', session: 'Task'},
      context('project', {}, value.clock),
    )
    const workspace = await value.store.resolveWorkspace('alpha')
    const session = await value.store.resolveSession(workspace.workspace_id, 'Task')

    const proposeAndCommit = async (delegateId: string): Promise<ConfirmedProjectOperation> => {
      const proposal = await value.adapter.dispatch(
        'project',
        {action: 'resume_session', workspace: 'alpha', session: 'Task', work_order: 'continue'},
        context('project', {}, value.clock),
      )
      const epoch = delegateId === 'delegate-transient' ? 1 : 2
      value.confirmation.reserveUserItem({epoch, itemId: delegateId})
      const confirmed = value.confirmation.acceptDecision({
        epoch, itemId: delegateId, proposalId: proposalId(proposal.content), confirmed: true,
      })
      assert.ok(confirmed.operation)
      await value.adapter.commitConfirmed(
        confirmed.operation,
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
      'project',
      {action: 'execute_confirmed'},
      context('project', {action: 'execute_confirmed'}, value.clock, {
        private: transientOperation,
        delegateId: 'delegate-transient',
        originRef: transientOperation.origin_ref,
      }),
    )
    assert.equal(transient.outcome, 'failed')
    assert.equal((await value.store.resolveSession(workspace.workspace_id, 'Task')).state, 'ready')

    value.factory.reportThread = true
    value.factory.nextOutcome = COMPLETE
    value.factory.overrideThreadId = 'wrong-thread'
    const mismatchOperation = await proposeAndCommit('delegate-mismatch')
    const mismatch = await value.adapter.dispatch(
      'project',
      {action: 'execute_confirmed'},
      context('project', {action: 'execute_confirmed'}, value.clock, {
        private: mismatchOperation,
        delegateId: 'delegate-mismatch',
        originRef: mismatchOperation.origin_ref,
      }),
    )
    assert.deepEqual(mismatch.content, {
      error: 'session_thread_mismatch', op: 'run', stage: 'thread_start',
    })
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
      'project',
      {action: 'start_session', work_order: 'first', session: 'Task'},
      context('project', {}, value.clock),
    )
    const workspace = await value.store.resolveWorkspace('alpha')
    const proposal = await value.adapter.dispatch(
      'project',
      {action: 'resume_session', workspace: 'alpha', session: 'Task', work_order: 'continue'},
      context('project', {}, value.clock),
    )
    value.confirmation.reserveUserItem({epoch: 1, itemId: 'confirm-unavailable'})
    const confirmed = value.confirmation.acceptDecision({
      epoch: 1, itemId: 'confirm-unavailable',
      proposalId: proposalId(proposal.content), confirmed: true,
    })
    assert.ok(confirmed.operation)
    await value.adapter.commitConfirmed(
      confirmed.operation,
      () => ({accepted: true, delegate_id: 'delegate-unavailable'}),
    )
    value.factory.reportThread = false
    value.factory.nextOutcome = {
      classification: 'refused', code: 'resume_unavailable', turnStartWritten: false, completion: null,
    }
    const unavailable = await value.adapter.dispatch(
      'project',
      {action: 'execute_confirmed'},
      context('project', {action: 'execute_confirmed'}, value.clock, {
        private: confirmed.operation,
        delegateId: 'delegate-unavailable',
        originRef: confirmed.operation.origin_ref,
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
      'project',
      {action: 'start_session', work_order: 'first', session: 'Task'},
      context('project', {}, value.clock),
    )
    const workspace = await value.store.resolveWorkspace('alpha')
    const session = await value.store.resolveSession(workspace.workspace_id, 'Task')
    const proposal = await value.adapter.dispatch(
      'project',
      {action: 'resume_session', workspace: 'alpha', session: 'Task', work_order: 'continue'},
      context('project', {}, value.clock),
    )
    value.confirmation.reserveUserItem({epoch: 1, itemId: 'confirm-late-state'})
    const confirmed = value.confirmation.acceptDecision({
      epoch: 1, itemId: 'confirm-late-state',
      proposalId: proposalId(proposal.content), confirmed: true,
    })
    assert.ok(confirmed.operation)
    await value.adapter.commitConfirmed(
      confirmed.operation,
      () => ({accepted: true, delegate_id: 'delegate-late-state'}),
    )
    invalidate = async () => {
      invalidate = null
      await value.store.markSessionUnavailable(session.session_id, {wait: true})
    }
    const result = await value.adapter.dispatch(
      'project',
      {action: 'execute_confirmed'},
      context('project', {action: 'execute_confirmed'}, value.clock, {
        private: confirmed.operation,
        delegateId: 'delegate-late-state',
        originRef: confirmed.operation.origin_ref,
      }),
    )
    assert.equal(result.outcome, 'refused')
    assert.deepEqual(result.content, {
      op: 'project', code: 'session_unavailable', recoverable: true,
    })
    assert.equal(value.factory.calls.length, 1)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
  }
})
