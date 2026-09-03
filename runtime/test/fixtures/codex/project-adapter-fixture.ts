/**
 * Shared fixture for `ProjectCodexAdapter` tests: a real `ProjectStore` on a temp root, a real
 * `ProjectConfirmationController`, and a recording fake transport factory (one fake per run).
 */
import assert from 'node:assert/strict'
import {
  chmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import {mkdir, mkdtemp, realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import type {
  CodexAppServerTransport,
  RunInput,
  SafePreflightReport,
  SteerTransportResult,
  TransportDeadline,
  TransportObserver,
  TransportOutcome,
} from '../../../src/executors/codex/app-server-transport.js'
import {
  ProjectStore,
  hostManagedProjectRootForTest,
  hostProjectRootForTest,
  ProjectStateError,
  type PublicProjectView,
} from '../../../src/project-store.js'
import {hostWorkspaceForTest} from '../../../src/executors/codex/process-owner.js'
import type {ExecutorDispatchContext} from '../../../src/causal-runtime.js'
import {VirtualClock} from '../../../src/clock.js'
import {
  ProjectCodexAdapter,
  type ProjectTransportBinding,
  type ProjectTransportFactory,
} from '../../../src/executors/codex/adapter-project.js'
import type {JsonValue} from '../../../src/events.js'
import {bindHostExecutorCapability} from '../../../src/host-executor-capability.js'
import type {NativeFileLockAuthority, NativeFileLockResult} from '../../../src/native-file-lock.js'
import type {
  ProjectFileIdentity,
  ProjectRootFileAuthority,
  ProjectRootFileCreateResult,
  ProjectRootFileLookupResult,
  ProjectRootFileResult,
} from '../../../src/project-root-file.js'
import {delegateSchema} from '../../../src/ports.js'
import {ProjectConfirmationController} from '../../../src/project-confirmation.js'

export const PREFLIGHT: SafePreflightReport = Object.freeze({
  version: '0.145.0',
  root_matches: true,
  mount: 'workspace_only',
  subprocess: 'contained',
  network: 'blocked',
})

export const COMPLETE: TransportOutcome = Object.freeze({
  classification: 'completed',
  code: 'completed',
  turnStartWritten: true,
  completion: {status: 'completed' as const, final_text: 'done', internal_activity: 1},
})

export function observeCriticalProjectContext(
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

export async function settleWithin<T>(name: string, work: Promise<T>, milliseconds = 2_000): Promise<T> {
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

export class DescriptorLockAuthority implements NativeFileLockAuthority {
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
export class DescriptorRootFileAuthority implements ProjectRootFileAuthority {
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

export class ProjectTransport implements CodexAppServerTransport {
  closeCalls = 0
  readonly workOrders: string[] = []
  readonly runInputs: RunInput[] = []
  /** Observers handed to `run`, so a test can fire `onThreadNamed` like Codex would. */
  readonly observers: TransportObserver[] = []
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
    input: RunInput,
    observer: TransportObserver,
    deadline: TransportDeadline,
  ): Promise<TransportOutcome> {
    this.workOrders.push(input.workOrder)
    this.runInputs.push(input)
    this.observers.push(observer)
    this.onRun?.()
    if (this.reportThread) {
      observer.onThreadReady?.(this.threadId)
      observer.onTurnStartWritten?.()
      observer.onTurnBound?.()
    }
    const gate = this.runGate ?? Promise.resolve(this.outcome)
    const signal = deadline.signal
    if (signal === undefined) return gate
    // Like the real child: an interrupted turn still settles instead of hanging the caller.
    return Promise.race([gate, new Promise<TransportOutcome>(resolve => {
      if (signal.aborted) resolve(this.outcome)
      else signal.addEventListener('abort', () => { resolve(this.outcome) }, {once: true})
    })])
  }

  steer(): Promise<SteerTransportResult> {
    return Promise.resolve({code: 'accepted', written: true})
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

export class RecordingProjectTransportFactory implements ProjectTransportFactory {
  readonly calls: {readonly resume: boolean}[] = []
  readonly bindings: ProjectTransportBinding[] = []
  readonly transports: ProjectTransport[] = []
  nextOutcome: TransportOutcome = COMPLETE
  overrideThreadId: string | null = null
  reportThread = true
  onRun: (() => void) | undefined
  closeFailures = 0
  runGate: Promise<TransportOutcome> | undefined
  /** Per-project gate (spec 08 concurrency tests); wins over `runGate` when it returns one. */
  gateFor: ((binding: ProjectTransportBinding) => Promise<TransportOutcome> | undefined) | undefined
  createFailure: Error | null = null
  preflightError: Error | undefined

  create(binding: ProjectTransportBinding): CodexAppServerTransport {
    if (this.createFailure !== null) throw this.createFailure
    const resume = binding.resumeThreadId !== null
    this.calls.push({resume})
    this.bindings.push(binding)
    const transport = new ProjectTransport(
      this.overrideThreadId ?? binding.resumeThreadId ?? `thread-${this.calls.length}`,
      this.nextOutcome,
      this.reportThread,
      this.onRun,
      this.closeFailures,
      this.gateFor?.(binding) ?? this.runGate,
      this.preflightError,
    )
    this.transports.push(transport)
    return transport
  }
}

export interface Fixture {
  readonly root: string
  readonly store: ProjectStore
  readonly adapter: ProjectCodexAdapter
  readonly confirmation: ProjectConfirmationController
  readonly factory: RecordingProjectTransportFactory
  readonly clock: VirtualClock
}

export async function fixture(options: {
  readonly preexistingSession?: boolean
  readonly decorateStore?: (store: ProjectStore) => ProjectStore
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
  const store = await ProjectStore.open({
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

export function storeWithPersistentHomeHook(
  store: ProjectStore,
  afterPersistentHome: () => Promise<void>,
): ProjectStore {
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

export function storeWithManagedValidationHook(
  store: ProjectStore,
  beforeValidation: (attempt: number) => Promise<void>,
): ProjectStore {
  let attempts = 0
  return new Proxy(store, {
    get(target, property) {
      if (property === 'validateManagedCreate') {
        return async (displayName: string) => {
          attempts += 1
          await beforeValidation(attempts)
          return await target.validateManagedCreate(displayName)
        }
      }
      const value: unknown = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      const bound: unknown = value.bind(target)
      return bound
    },
  })
}

export function storeWithBusyPublicContext(
  store: ProjectStore,
  busy: () => boolean,
): ProjectStore {
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

export function context(
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
    deadline: clock.now() + 600,
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

/** Public `run` request as the host sends it; `project: null` = active project. */
export function runRequest(
  workOrder: string,
  options: {readonly project?: string | null; readonly session?: 'latest' | 'new'; readonly title?: string} = {},
): Readonly<Record<string, JsonValue>> {
  return {
    work_order: workOrder,
    project: options.project ?? null,
    session: options.session ?? 'latest',
    ...(options.title === undefined ? {} : {title: options.title}),
  }
}

/** Dispatch a public `run` through the adapter with a distinct delegate id per call. */
export function run(
  value: Fixture,
  workOrder: string,
  options: {
    readonly project?: string | null
    readonly session?: 'latest' | 'new'
    readonly title?: string
    readonly delegateId?: string
    readonly signal?: AbortSignal
  } = {},
): ReturnType<ProjectCodexAdapter['dispatch']> {
  const request = runRequest(workOrder, options)
  return value.adapter.dispatch('run', request, context('run', request, value.clock, {
    delegateId: options.delegateId ?? `delegate-${workOrder}`,
    ...(options.signal === undefined ? {} : {signal: options.signal}),
  }))
}
