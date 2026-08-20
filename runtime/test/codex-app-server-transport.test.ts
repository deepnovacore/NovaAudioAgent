/* eslint-disable @typescript-eslint/require-await -- deterministic fakes implement async host contracts */
/* eslint-disable @typescript-eslint/no-empty-function -- inert fake callbacks model blocked/no-op resources */
import assert from 'node:assert/strict'
import {PassThrough, Writable} from 'node:stream'
import {test} from 'node:test'

import * as runtime from '../src/index.js'
import type {OwnedCodexAppServerTransport} from '../src/codex-app-server-transport.js'
import type {CodexProcessOwnerFactory} from '../src/codex-process-owner.js'
import {FakeAppServerOwnerFactory} from './fixtures/codex/fake-app-server-owner.js'
import {supportedSchemaBundle} from './fixtures/codex/supported-schema-bundle.js'

const encoder = new TextEncoder()

test('a cold run follows the app-server handshake and returns bounded internal completion', async () => {
  const methods: string[] = []
  const owner = new MemoryAppServerOwner(methods)
  const module = runtime as unknown as Record<string, unknown>
  const Transport = typeof module.OwnedCodexAppServerTransport === 'function'
    ? module.OwnedCodexAppServerTransport as new (options: Record<string, unknown>) => {
      run(
        input: Readonly<Record<string, unknown>>,
        observer: Readonly<Record<string, unknown>>,
        deadline: Readonly<Record<string, unknown>>,
      ): Promise<Record<string, unknown>>
    }
    : class UnsafeTransport {
      constructor(options: Record<string, unknown>) { void options }
      async run(): Promise<Record<string, unknown>> {
        return {classification: 'refused', code: 'transport_lost', turnStartWritten: false}
      }
    }
  const workspace = process.cwd()
  const transport = new Transport({
    config: {
      binary: (module.hostBinaryForTest as (path: string) => unknown)(process.execPath),
      workspace: (module.hostWorkspaceForTest as (path: string) => unknown)(workspace),
      codexHome: (module.hostCodexHomeForTest as (
        path: string,
        options: {ephemeral: boolean},
      ) => unknown)(workspace, {ephemeral: true}),
      apiKey: 'api-key-sentinel',
      developerInstructions: null,
      resumeThreadId: null,
      persistent: false,
    },
    processFactory: {spawn: async () => owner},
    credentialSnapshotter: {
      prepare: async () => ({}),
      environment: () => ({
        PATH: '/safe-path', HOME: '/safe-home', CODEX_HOME: workspace,
        CODEX_API_KEY: 'api-key-sentinel',
        CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1',
      }),
      removeEphemeralHome: async () => {},
    },
    preflightRunner: {run: async () => safePreflightReport()},
    schemaProbe: {generate: async () => supportedSchemaBundle()},
  })

  const outcome = await transport.run(
    {workOrder: 'perform one bounded task'},
    {},
    {expiresAtMs: Date.now() + 5000},
  )

  assert.deepEqual(methods, [
    'initialize', 'initialized', 'config/read', 'thread/start', 'turn/start',
  ])
  assert.equal(outcome.classification, 'completed')
  assert.equal(outcome.code, 'completed')
  assert.equal(outcome.turnStartWritten, true)
  assert.deepEqual(outcome.completion, {
    status: 'completed',
    final_text: 'bounded result',
    internal_activity: 1,
  })
})

test('steer writes while turn/start response is delayed and reverse response order stays correlated', async () => {
  const methods: string[] = []
  const owner = new MemoryAppServerOwner(methods, {delayTurnStart: true})
  const transport = createTransport({spawn: async () => owner})
  const running = transport.run(
    {workOrder: 'perform the delayed task'},
    {},
    {expiresAtMs: Date.now() + 5000},
  )
  await owner.turnStartReceived.promise
  const steered = await transport.steer(
    {instruction: 'apply the bounded correction'},
    {expiresAtMs: Date.now() + 5000},
  )
  assert.deepEqual(steered, {code: 'accepted', written: true})
  assert.equal(methods.at(-1), 'turn/steer')
  owner.completeDelayedTurn()
  const outcome = await running
  assert.equal(outcome.classification, 'completed')
  assert.equal(outcome.turnStartWritten, true)
})

test('a queued server request taints before turn/start and remains a private refusal', async () => {
  const methods: string[] = []
  const owner = new MemoryAppServerOwner(methods, {serverRequestAfterThread: true})
  const transport = createTransport({spawn: async () => owner})
  const result = await transport.run(
    {workOrder: 'private-work-order-sentinel'},
    {},
    {expiresAtMs: Date.now() + 5000},
  )
  assert.equal(result.classification, 'refused')
  assert.equal(result.turnStartWritten, false)
  assert.equal(result.code, 'unexpected_server_request')
  assert.equal(methods.includes('turn/start'), false)
  assert.equal(JSON.stringify(result).includes('private-work-order-sentinel'), false)
  assert.equal(JSON.stringify(result).includes('remote-private-message'), false)
})

test('preflight and live schema failures happen before app-server spawn', async () => {
  for (const scenario of ['preflight', 'schema'] as const) {
    let spawnCount = 0
    const schema = supportedSchemaBundle()
    if (scenario === 'schema') delete schema['v2/TurnStartParams.json']
    const transport = createTransport({
      spawn: async () => {
        spawnCount += 1
        return new MemoryAppServerOwner([])
      },
    }, {
      ...(scenario === 'preflight' ? {preflightRunner: {
        // The unsafe placeholder is deliberately data-shaped to prove stable-code sanitization.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        run: async () => { throw Object.freeze({code: 'sandbox_failed', detail: 'private'}) },
      }} : {}),
      schemaProbe: {generate: async () => schema},
    })
    const result = await transport.run(
      {workOrder: 'never-reaches-child'},
      {},
      {expiresAtMs: Date.now() + 5000},
    )
    assert.equal(spawnCount, 0)
    assert.equal(result.classification, 'refused')
    assert.equal(result.code, scenario === 'preflight' ? 'sandbox_failed' : 'unsupported_protocol')
    assert.equal(JSON.stringify(result).includes('private'), false)
  }
})

test('preflight is hard-capped and caller cancellation settles before spawn', async () => {
  let timeoutMs = 0
  const report = safePreflightReport()
  const capped = createTransport({spawn: async () => new MemoryAppServerOwner([])}, {
    preflightRunner: {run: async (_config, boundedMs) => {
      void _config
      timeoutMs = boundedMs
      return report
    }},
  })
  assert.deepEqual(await capped.preflight({expiresAtMs: Date.now() + 60_000}), report)
  assert.equal(timeoutMs > 0 && timeoutMs <= runtime.CODEX_PREFLIGHT_LIMIT_MS, true)

  const entered = testDeferred<void>()
  const controller = new AbortController()
  let spawnCount = 0
  const cancelled = createTransport({spawn: async () => {
    spawnCount += 1
    return new MemoryAppServerOwner([])
  }}, {
    preflightRunner: {run: async () => {
      entered.resolve()
      return await new Promise<never>(() => {})
    }},
  })
  const running = cancelled.run(
    {workOrder: 'cancel before spawn'},
    {},
    {expiresAtMs: Date.now() + 60_000, signal: controller.signal},
  )
  await entered.promise
  controller.abort()
  assert.deepEqual(await running, {
    classification: 'refused',
    code: 'preflight_timeout',
    turnStartWritten: false,
    completion: null,
  })
  assert.equal(spawnCount, 0)
})

test('a spawned process missing a required pipe is refused and disposed before protocol work', async () => {
  let disposed = false
  const invalidOwner = {
    stdin: new PassThrough(),
    stdout: undefined,
    stderr: new PassThrough(),
    exit: Promise.resolve(0),
    pid: 778,
    closeStdin: async () => {},
    waitTreeGone: async () => true,
    terminateTree: async () => {},
    killTree: async () => {},
    dispose: async () => { disposed = true },
  }
  const transport = createTransport({
    spawn: async () => invalidOwner as unknown as runtime.OwnedCodexProcess,
  })
  const result = await transport.run(
    {workOrder: 'must-not-reach-protocol'},
    {},
    {expiresAtMs: Date.now() + 5000},
  )
  assert.deepEqual(result, {
    classification: 'refused',
    code: 'spawn_failed',
    turnStartWritten: false,
    completion: null,
  })
  assert.equal(disposed, true)
})

test('config widening and thread bind mismatch are safe pre-turn protocol refusals', async () => {
  for (const scenario of ['config', 'bind'] as const) {
    const owner = new MemoryAppServerOwner([], {
      configWidening: scenario === 'config',
      bindWorkspace: scenario === 'bind' ? '/private/renderer-selected-root' : null,
    })
    const transport = createTransport({spawn: async () => owner})
    const result = await transport.run(
      {workOrder: 'must remain pre-effect'},
      {},
      {expiresAtMs: Date.now() + 5000},
    )
    assert.equal(result.classification, 'refused')
    assert.equal(result.code, 'unsupported_protocol')
    assert.equal(result.turnStartWritten, false)
    assert.equal(owner.received.some(message => message.method === 'turn/start'), false)
    assert.equal(JSON.stringify(result).includes('renderer-selected-root'), false)
  }
})

test('concurrent prewarms share one child, first run consumes it once, and later run is cold', async () => {
  const owners: MemoryAppServerOwner[] = []
  const transport = createTransport({spawn: async () => {
    const owner = new MemoryAppServerOwner([], {threadId: `thread-${owners.length + 1}`})
    owners.push(owner)
    return owner
  }})
  const deadline = {expiresAtMs: Date.now() + 5000}
  const first = transport.prewarm(deadline)
  const second = transport.prewarm(deadline)
  const reports = await Promise.all([first, second])
  assert.equal(owners.length, 1)
  assert.deepEqual(reports[0], reports[1])

  assert.equal((await transport.run({workOrder: 'first'}, {}, deadline)).classification, 'completed')
  assert.equal(owners.length, 1)
  assert.equal((await transport.run({workOrder: 'second'}, {}, {
    expiresAtMs: Date.now() + 5000,
  })).classification, 'completed')
  assert.equal(owners.length, 2)
  await Promise.all([transport.close(), transport.close()])
})

test('close during initialize waits for the establishing child and disposes it once', async () => {
  const owner = new MemoryAppServerOwner([], {holdInitialize: true})
  const transport = createTransport({spawn: async () => owner})
  const running = transport.run(
    {workOrder: 'will be closed during initialize'},
    {},
    {expiresAtMs: Date.now() + 5000},
  )
  await owner.initializeReceived.promise
  try {
    await Promise.all([transport.close(), transport.close()])
    assert.equal(owner.disposed, true)
    assert.equal(owner.disposeCalls, 1)
  } finally {
    owner.releaseInitialize()
    await running
  }
})

test('concurrent run is busy and repeated close during a written turn shares cleanup', async () => {
  const owner = new MemoryAppServerOwner([], {delayTurnStart: true})
  const transport = createTransport({spawn: async () => owner})
  const running = transport.run(
    {workOrder: 'first run owns the child'},
    {},
    {expiresAtMs: Date.now() + 5000},
  )
  await owner.turnStartReceived.promise
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.deepEqual(await transport.run(
    {workOrder: 'second run must not start'},
    {},
    {expiresAtMs: Date.now() + 5000},
  ), {
    classification: 'refused',
    code: 'busy',
    turnStartWritten: false,
    completion: null,
  })
  await Promise.all([transport.close('cancel'), transport.close('shutdown')])
  const result = await running
  assert.equal(result.classification, 'uncertain')
  assert.equal(result.turnStartWritten, true)
  assert.equal(owner.disposeCalls, 1)
})

test('close during prewarm joins the one establishing child and leaves no reusable session', async () => {
  const owner = new MemoryAppServerOwner([], {holdInitialize: true})
  let spawnCount = 0
  const transport = createTransport({spawn: async () => {
    spawnCount += 1
    return owner
  }})
  const warming = transport.prewarm({expiresAtMs: Date.now() + 5000})
  await owner.initializeReceived.promise
  await Promise.all([transport.close(), transport.close()])
  await assert.rejects(warming, runtime.CodexTransportError)
  assert.equal(spawnCount, 1)
  assert.equal(owner.disposeCalls, 1)
  assert.equal(await transport.prewarm({expiresAtMs: Date.now() + 5000}), null)
})

test('prewarm observes a server request queued behind thread response and cleans the tainted child', async () => {
  const owner = new MemoryAppServerOwner([], {serverRequestAfterThread: true})
  const transport = createTransport({spawn: async () => owner})
  await assert.rejects(
    transport.prewarm({expiresAtMs: Date.now() + 5000}),
    (error: unknown) => String(error) === 'CodexTransportError: unexpected_server_request',
  )
  assert.equal(owner.disposed, true)
})

test('a failed or dead prewarm is discarded and a later prewarm retries with a fresh child', async () => {
  const owners: MemoryAppServerOwner[] = []
  const transport = createTransport({spawn: async () => {
    const owner = new MemoryAppServerOwner([], {
      serverRequestAfterThread: owners.length === 0,
      threadId: `thread-${owners.length + 1}`,
    })
    owners.push(owner)
    return owner
  }})
  await assert.rejects(
    transport.prewarm({expiresAtMs: Date.now() + 5000}),
    runtime.CodexTransportError,
  )
  assert.equal(owners[0]?.disposed, true)
  assert.notEqual(await transport.prewarm({expiresAtMs: Date.now() + 5000}), null)
  assert.equal(owners.length, 2)
  owners[1]?.abruptExit(0)
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.equal((await transport.run(
    {workOrder: 'fresh after dead warm child'},
    {},
    {expiresAtMs: Date.now() + 5000},
  )).classification, 'completed')
  assert.equal(owners.length, 3)
})

test('stderr overflow after turn drain is uncertain and never exposes stream bytes', async () => {
  const owner = new MemoryAppServerOwner([], {delayTurnStart: true})
  const transport = createTransport({spawn: async () => owner})
  const running = transport.run(
    {workOrder: 'stderr-private-work-order'},
    {},
    {expiresAtMs: Date.now() + 5000},
  )
  await owner.turnStartReceived.promise
  await new Promise<void>(resolve => { setImmediate(resolve) })
  let settled = false
  void running.finally(() => { settled = true })
  owner.emitStderr(64 * 1024)
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.equal(settled, false)
  owner.emitStderr(1)
  const result = await running
  assert.equal(result.classification, 'uncertain')
  assert.equal(result.code, 'stderr_too_large')
  assert.equal(result.turnStartWritten, true)
  assert.equal(JSON.stringify(result).includes('stderr-private'), false)
})

test('turn rejection happens after the writer drain and stays server_rejected', async () => {
  const owner = new MemoryAppServerOwner([], {rejectTurn: -32001})
  const transport = createTransport({spawn: async () => owner})
  const result = await transport.run(
    {workOrder: 'rejected work'},
    {},
    {expiresAtMs: Date.now() + 5000},
  )
  assert.equal(result.classification, 'uncertain')
  assert.equal(result.code, 'server_rejected')
  assert.equal(result.turnStartWritten, true)
})

test('work order, API key, workspace, and controls are redacted from progress and completion', async () => {
  const workspace = process.cwd()
  const workOrder = 'private-work-order-token'
  const finalText = `${workOrder} api-key-sentinel ${workspace}\u0000 useful result`
  const owner = new MemoryAppServerOwner([], {finalText})
  const progress: unknown[] = []
  const transport = createTransport({spawn: async () => owner})
  const result = await transport.run(
    {workOrder},
    {onProgress: value => { progress.push(value) }},
    {expiresAtMs: Date.now() + 5000},
  )
  const rendered = JSON.stringify({result, progress})
  assert.equal(rendered.includes(workOrder), false)
  assert.equal(rendered.includes('api-key-sentinel'), false)
  assert.equal(rendered.includes(workspace), false)
  assert.equal(rendered.includes('useful result'), true)
  assert.equal(rendered.includes('\\u0000'), false)
})

test('pre-drain write failure is refused while post-drain EOF is uncertain', async () => {
  const preDrain = new MemoryAppServerOwner([], {failTurnWriteBeforeDrain: true})
  const refused = await createTransport({spawn: async () => preDrain}).run(
    {workOrder: 'pre-drain'},
    {},
    {expiresAtMs: Date.now() + 5000},
  )
  assert.equal(refused.classification, 'refused')
  assert.equal(refused.turnStartWritten, false)
  assert.equal(refused.code, 'transport_lost')

  const postDrain = new MemoryAppServerOwner([], {delayTurnStart: true})
  const running = createTransport({spawn: async () => postDrain}).run(
    {workOrder: 'post-drain'},
    {},
    {expiresAtMs: Date.now() + 5000},
  )
  await postDrain.turnStartReceived.promise
  await new Promise<void>(resolve => { setImmediate(resolve) })
  postDrain.abruptExit(7)
  const uncertain = await running
  assert.equal(uncertain.classification, 'uncertain')
  assert.equal(uncertain.turnStartWritten, true)
  assert.equal(uncertain.code, 'transport_lost')
})

test('caller cancellation after turn drain is bounded and remains uncertain', async () => {
  const owner = new MemoryAppServerOwner([], {delayTurnStart: true})
  const transport = createTransport({spawn: async () => owner})
  const controller = new AbortController()
  const running = transport.run(
    {workOrder: 'cancel after side effect'},
    {},
    {expiresAtMs: Date.now() + 60_000, signal: controller.signal},
  )
  await owner.turnStartReceived.promise
  await new Promise<void>(resolve => { setImmediate(resolve) })
  controller.abort()
  const result = await running
  assert.equal(result.classification, 'uncertain')
  assert.equal(result.code, 'adapter_timeout')
  assert.equal(result.turnStartWritten, true)
  assert.equal(owner.disposed, true)
})

test('credential cancellation joins snapshot work and removes the ephemeral home before returning', async () => {
  const entered = testDeferred<void>()
  const release = testDeferred<void>()
  const controller = new AbortController()
  let spawnCount = 0
  let cleanupCount = 0
  let settled = false
  const workspace = process.cwd()
  const transport = new runtime.OwnedCodexAppServerTransport({
    config: {
      binary: runtime.hostBinaryForTest(process.execPath),
      workspace: runtime.hostWorkspaceForTest(workspace),
      codexHome: runtime.hostCodexHomeForTest(workspace, {ephemeral: true}),
      apiKey: 'api-key-sentinel',
      developerInstructions: null,
      resumeThreadId: null,
      persistent: false,
    },
    processFactory: {spawn: async () => {
      spawnCount += 1
      return new MemoryAppServerOwner([])
    }},
    credentialSnapshotter: {
      prepare: async () => {
        entered.resolve()
        await release.promise
        return {} as never
      },
      environment: () => ({
        PATH: '/safe', HOME: '/home', CODEX_HOME: workspace,
        CODEX_API_KEY: 'api-key-sentinel',
        CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1',
      }),
      removeEphemeralHome: async () => { cleanupCount += 1 },
    },
    preflightRunner: {run: async () => safePreflightReport()},
    schemaProbe: {generate: async () => supportedSchemaBundle()},
  })
  const running = transport.run(
    {workOrder: 'cancel during credential snapshot'},
    {},
    {expiresAtMs: Date.now() + 60_000, signal: controller.signal},
  )
  void running.finally(() => { settled = true })
  await entered.promise
  controller.abort()
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.equal(settled, false)
  assert.equal(cleanupCount, 0)
  release.resolve()
  const result = await running
  assert.equal(result.classification, 'refused')
  assert.equal(result.code, 'adapter_timeout')
  assert.equal(spawnCount, 0)
  assert.equal(cleanupCount, 1)
})

test('persistent resume uses exact host identity and rejection is pre-effect resume_unavailable', async () => {
  for (const rejected of [false, true]) {
    const workspace = process.cwd()
    const owner = new MemoryAppServerOwner([], {
      persistent: true,
      threadId: 'durable-thread-1',
      rejectResume: rejected,
    })
    const transport = new runtime.OwnedCodexAppServerTransport({
      config: {
        binary: runtime.hostBinaryForTest(process.execPath),
        workspace: runtime.hostWorkspaceForTest(workspace),
        codexHome: runtime.hostCodexHomeForTest(workspace, {ephemeral: false}),
        apiKey: 'api-key-sentinel',
        developerInstructions: 'bounded instructions',
        resumeThreadId: 'durable-thread-1',
        persistent: true,
      },
      processFactory: {spawn: async () => owner},
      credentialSnapshotter: {
        prepare: async () => ({} as never),
        environment: () => ({
          PATH: '/safe', HOME: '/home', CODEX_HOME: workspace,
          CODEX_API_KEY: 'api-key-sentinel',
          CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1',
        }),
        removeEphemeralHome: async () => {},
      },
      preflightRunner: {run: async () => safePreflightReport()},
      schemaProbe: {generate: async () => supportedSchemaBundle()},
    })
    const result = await transport.run(
      {workOrder: 'resume safely'},
      {},
      {expiresAtMs: Date.now() + 5000},
    )
    const resume = owner.received.find(message => message.method === 'thread/resume')
    assert.deepEqual(resume?.params, {
      approvalPolicy: 'never',
      developerInstructions: 'bounded instructions',
      cwd: workspace,
      runtimeWorkspaceRoots: [workspace],
      permissions: 'nova_audio_agent',
      threadId: 'durable-thread-1',
      excludeTurns: true,
    })
    if (rejected) {
      assert.equal(result.classification, 'refused')
      assert.equal(result.code, 'resume_unavailable')
      assert.equal(result.turnStartWritten, false)
      assert.equal(owner.received.some(message => message.method === 'turn/start'), false)
    } else {
      assert.equal(result.classification, 'completed')
    }
  }
})

test('the real fake app-server handles arbitrary stdout chunks and barriered steer', async () => {
  const happyFactory = new FakeAppServerOwnerFactory('happy-chunks')
  const happy = await createTransport(happyFactory).run(
    {workOrder: 'real fixture work'},
    {},
    {expiresAtMs: Date.now() + 10_000},
  )
  assert.equal(happy.classification, 'completed')
  assert.equal(happy.completion?.final_text, 'fixture result')

  const delayedFactory = new FakeAppServerOwnerFactory('delayed-turn')
  const delayedTransport = createTransport(delayedFactory)
  const running = delayedTransport.run(
    {workOrder: 'barriered fixture work'},
    {},
    {expiresAtMs: Date.now() + 10_000},
  )
  await settleUntil(() => delayedFactory.owner !== null, 'fake owner spawn')
  const owner = delayedFactory.owner!
  await within(owner.waitForBarrier('turn_start'), 5000, 'turn start barrier')
  assert.deepEqual(await delayedTransport.steer(
    {instruction: 'barriered steer'},
    {expiresAtMs: Date.now() + 5000},
  ), {code: 'accepted', written: true})
  owner.release('turn_start')
  assert.equal((await running).classification, 'completed')
})

test('real child malformed and bounded stream failures settle with stable private codes', async () => {
  for (const [scenario, code] of [
    ['malformed-after-turn', 'unsupported_protocol'],
    ['stdout-overflow', 'transport_lost'],
    ['stderr-overflow', 'stderr_too_large'],
  ] as const) {
    const transport = createTransport(new FakeAppServerOwnerFactory(scenario))
    const result = await transport.run(
      {workOrder: 'real-stream-private-sentinel'},
      {},
      {expiresAtMs: Date.now() + 10_000},
    )
    assert.equal(result.classification, 'uncertain')
    assert.equal(result.turnStartWritten, true)
    assert.equal(result.code, code)
    assert.equal(JSON.stringify(result).includes('real-stream-private-sentinel'), false)
  }
})

function safePreflightReport(): Record<string, unknown> {
  return {
    version: '0.145.0',
    root_matches: true,
    mount: 'workspace_only',
    subprocess: 'contained',
    network: 'blocked',
    credential: {present: true, identity: 'api_key', policy: 'process_only'},
    limits: {cpu: 'finite', as: 'finite', nofile: 'finite'},
  }
}

class MemoryAppServerOwner {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin: Writable
  readonly pid = 777
  readonly exit: Promise<number | null>
  readonly turnStartReceived = testDeferred<void>()
  readonly initializeReceived = testDeferred<void>()
  readonly received: {readonly method: string; readonly params: Readonly<Record<string, unknown>>}[] = []
  disposed = false
  disposeCalls = 0
  #resolveExit!: (code: number | null) => void
  #exited = false
  #buffer = ''
  readonly #methods: string[]
  readonly #options: {
    readonly delayTurnStart: boolean
    readonly serverRequestAfterThread: boolean
    readonly threadId: string
    readonly holdInitialize: boolean
    readonly rejectTurn: number | null
    readonly finalText: string
    readonly failTurnWriteBeforeDrain: boolean
    readonly persistent: boolean
    readonly rejectResume: boolean
    readonly configWidening: boolean
    readonly bindWorkspace: string | null
  }
  #delayedTurnRequestId: number | undefined
  #heldInitializeRequestId: number | undefined

  constructor(methods: string[], options: {
    readonly delayTurnStart?: boolean
    readonly serverRequestAfterThread?: boolean
    readonly threadId?: string
    readonly holdInitialize?: boolean
    readonly rejectTurn?: number
    readonly finalText?: string
    readonly failTurnWriteBeforeDrain?: boolean
    readonly persistent?: boolean
    readonly rejectResume?: boolean
    readonly configWidening?: boolean
    readonly bindWorkspace?: string | null
  } = {}) {
    this.#methods = methods
    this.#options = {
      delayTurnStart: options.delayTurnStart ?? false,
      serverRequestAfterThread: options.serverRequestAfterThread ?? false,
      threadId: options.threadId ?? 'thread-1',
      holdInitialize: options.holdInitialize ?? false,
      rejectTurn: options.rejectTurn ?? null,
      finalText: options.finalText ?? 'bounded result',
      failTurnWriteBeforeDrain: options.failTurnWriteBeforeDrain ?? false,
      persistent: options.persistent ?? false,
      rejectResume: options.rejectResume ?? false,
      configWidening: options.configWidening ?? false,
      bindWorkspace: options.bindWorkspace ?? null,
    }
    this.exit = new Promise(resolve => { this.#resolveExit = resolve })
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.#accept(chunk)
        if (
          this.#options.failTurnWriteBeforeDrain
          && new TextDecoder().decode(chunk).includes('"method":"turn/start"')
        ) callback(new Error('private write failure'))
        else callback()
      },
      final: callback => {
        this.#finish(0)
        callback()
      },
    })
  }

  async closeStdin(): Promise<void> {
    if (this.stdin.writableEnded) return
    await new Promise<void>(resolve => { this.stdin.end(resolve) })
  }

  async waitTreeGone(graceMs: number): Promise<boolean> { void graceMs; return this.#exited }
  async terminateTree(): Promise<void> { this.#finish(null) }
  async killTree(): Promise<void> { this.#finish(null) }
  async dispose(): Promise<void> {
    this.disposeCalls += 1
    this.disposed = true
    this.stdin.destroy()
    this.stdout.destroy()
    this.stderr.destroy()
  }

  releaseInitialize(): void {
    const requestId = this.#heldInitializeRequestId
    if (requestId === undefined) return
    this.#heldInitializeRequestId = undefined
    this.#send({id: requestId, result: {serverInfo: {name: 'fake', version: '1'}}})
  }

  completeDelayedTurn(): void {
    const requestId = this.#delayedTurnRequestId
    assert.notEqual(requestId, undefined)
    this.#delayedTurnRequestId = undefined
    this.#sendTurnCompletion(requestId)
  }

  emitStderr(bytes: number): void {
    this.stderr.write(new Uint8Array(bytes))
  }

  abruptExit(code: number | null): void {
    this.#finish(code)
  }

  #accept(chunk: Uint8Array): void {
    this.#buffer += new TextDecoder().decode(chunk)
    while (true) {
      const newline = this.#buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.#buffer.slice(0, newline)
      this.#buffer = this.#buffer.slice(newline + 1)
      const message = JSON.parse(line) as {id?: number; method: string; params?: Record<string, unknown>}
      this.#methods.push(message.method)
      this.received.push({method: message.method, params: message.params ?? {}})
      this.#handle(message)
    }
  }

  #handle(message: {id?: number; method: string; params?: Record<string, unknown>}): void {
    if (message.method === 'initialized') return
    if (message.method === 'initialize') {
      this.initializeReceived.resolve()
      if (this.#options.holdInitialize) {
        this.#heldInitializeRequestId = message.id
        return
      }
      this.#send({id: message.id, result: {serverInfo: {name: 'fake', version: '1'}}})
      return
    }
    if (message.method === 'config/read') {
      this.#send({
        id: message.id,
        result: effectiveConfig(process.cwd(), this.#options.configWidening),
      })
      return
    }
    if (message.method === 'thread/start' || message.method === 'thread/resume') {
      if (message.method === 'thread/resume' && this.#options.rejectResume) {
        this.#send({id: message.id, error: {code: -32001, message: 'resume-private'}})
        return
      }
      this.#send({
        id: message.id,
        result: threadResponse(
          this.#options.bindWorkspace ?? process.cwd(),
          this.#options.threadId,
          this.#options.persistent,
        ),
      })
      if (this.#options.serverRequestAfterThread) {
        this.#send({id: 900, method: 'account/private', params: {message: 'remote-private-message'}})
      }
      return
    }
    if (message.method === 'turn/start') {
      this.#send({method: 'turn/started', params: {
        threadId: this.#options.threadId, turn: {id: 'turn-1', items: [], status: 'inProgress'},
      }})
      this.turnStartReceived.resolve()
      if (this.#options.rejectTurn !== null) {
        this.#send({id: message.id, error: {code: this.#options.rejectTurn, message: 'remote-private'}})
        return
      }
      if (this.#options.delayTurnStart) this.#delayedTurnRequestId = message.id
      else this.#sendTurnCompletion(message.id)
      return
    }
    if (message.method === 'turn/steer') {
      this.#send({id: message.id, result: {turnId: 'turn-1'}})
      return
    }
    if (message.method === 'turn/interrupt') {
      this.#send({id: message.id, result: {}})
    }
  }

  #sendTurnCompletion(requestId: number | undefined): void {
    this.#send({id: requestId, result: {turn: {id: 'turn-1', items: [], status: 'inProgress'}}})
    this.#send({method: 'item/completed', params: {
      threadId: this.#options.threadId, turnId: 'turn-1',
      item: {type: 'agentMessage', text: this.#options.finalText},
    }})
    this.#send({method: 'turn/completed', params: {
      threadId: this.#options.threadId,
      turn: {
        id: 'turn-1', status: 'completed', itemsView: 'notLoaded', items: [],
      },
    }})
  }

  #send(message: unknown): void {
    this.stdout.write(encoder.encode(`${JSON.stringify(message)}\n`))
  }

  #finish(code: number | null): void {
    if (this.#exited) return
    this.#exited = true
    this.stderr.end()
    this.stdout.end()
    this.#resolveExit(code)
  }
}

function effectiveConfig(workspace: string, widened = false): Record<string, unknown> {
  return {
    config: {
      default_permissions: 'nova_audio_agent',
      web_search: 'disabled',
      cwd: workspace,
      permissions: {nova_audio_agent: {
        filesystem: {
          ':root': 'read',
          ':workspace_roots': {'.': 'write', '.git': 'read', '.agents': 'read', '.codex': 'read'},
        },
        network: {enabled: widened},
      }},
      shell_environment_policy: {inherit: 'core', include_only: ['PATH', 'LANG', 'LC_ALL', 'TERM']},
      features: {
        hooks: false, apps: false, multi_agent: false, plugins: false,
        remote_plugin: false, plugin_sharing: false, tool_suggest: false, remote_control: false,
      },
      mcp_servers: {},
      model_instructions_file: null,
    },
    origins: {},
  }
}

function threadResponse(
  workspace: string,
  threadId = 'thread-1',
  persistent = false,
): Record<string, unknown> {
  return {
    approvalPolicy: 'never',
    cwd: workspace,
    sandbox: {},
    activePermissionProfile: {id: 'nova_audio_agent'},
    ...(persistent ? {runtimeWorkspaceRoots: [workspace]} : {}),
    thread: {
      id: threadId,
      cwd: workspace,
      ephemeral: !persistent,
      path: persistent ? `${workspace}/.codex-thread` : null,
    },
  }
}

function createTransport(
  processFactory: CodexProcessOwnerFactory,
  overrides: {
    readonly preflightRunner?: {run: (config: unknown, timeoutMs: number) => Promise<unknown>}
    readonly schemaProbe?: {
      generate: (config: unknown, timeoutMs: number) => Promise<Readonly<Record<string, unknown>>>
    }
  } = {},
): OwnedCodexAppServerTransport {
  const workspace = process.cwd()
  return new (runtime.OwnedCodexAppServerTransport)({
    config: {
      binary: runtime.hostBinaryForTest(process.execPath),
      workspace: runtime.hostWorkspaceForTest(workspace),
      codexHome: runtime.hostCodexHomeForTest(workspace, {ephemeral: true}),
      apiKey: 'api-key-sentinel',
      developerInstructions: null,
      resumeThreadId: null,
      persistent: false,
    },
    processFactory,
    credentialSnapshotter: {
      prepare: async () => ({} as never),
      environment: () => ({
        PATH: '/safe-path', HOME: '/safe-home', CODEX_HOME: workspace,
        CODEX_API_KEY: 'api-key-sentinel',
        CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1',
      }),
      removeEphemeralHome: async () => {},
    },
    preflightRunner: overrides.preflightRunner ?? {run: async () => safePreflightReport()},
    schemaProbe: overrides.schemaProbe ?? {generate: async () => supportedSchemaBundle()},
  })
}

async function settleUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (predicate()) return
    await new Promise<void>(resolve => { setImmediate(resolve) })
  }
  assert.fail(`${label} did not settle`)
}

async function within<T>(work: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`${label} timed out`)) }, milliseconds)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function testDeferred<T>(): {readonly promise: Promise<T>; readonly resolve: (value: T) => void} {
  let resolve!: (value: T) => void
  return {promise: new Promise<T>(done => { resolve = done }), resolve: value => { resolve(value) }}
}
