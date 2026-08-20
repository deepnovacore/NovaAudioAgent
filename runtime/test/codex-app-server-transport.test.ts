/* eslint-disable @typescript-eslint/require-await -- deterministic fakes implement async host contracts */
/* eslint-disable @typescript-eslint/no-empty-function -- inert fake callbacks model blocked/no-op resources */
import assert from 'node:assert/strict'
import {PassThrough, Writable} from 'node:stream'
import {test} from 'node:test'

import * as runtime from '../src/index.js'
import {OwnedCodexAppServerTransport} from '../src/codex-app-server-transport.js'
import {MAX_STDOUT} from '../src/codex-protocol.js'
import {
  hostBinaryForTest,
  hostCodexHomeForTest,
  hostWorkspaceForTest,
  unconfirmedCodexProcessOwnerError,
  type CodexProcessOwnerFactory,
  type OwnedCodexProcess,
} from '../src/codex-process-owner.js'
import {FakeAppServerOwnerFactory} from './fixtures/codex/fake-app-server-owner.js'
import {supportedSchemaBundle} from './fixtures/codex/supported-schema-bundle.js'

const encoder = new TextEncoder()

test('a cold run follows the app-server handshake and returns bounded internal completion', async () => {
  const methods: string[] = []
  const owner = new MemoryAppServerOwner(methods)
  const workspace = process.cwd()
  const transport = new OwnedCodexAppServerTransport({
    config: {
      binary: hostBinaryForTest(process.execPath),
      workspace: hostWorkspaceForTest(workspace),
      codexHome: hostCodexHomeForTest(workspace, {ephemeral: true}),
      apiKey: 'api-key-sentinel',
      developerInstructions: null,
      resumeThreadId: null,
      persistent: false,
    },
    processFactory: {spawn: async () => owner},
    credentialSnapshotter: {
      prepare: async () => ({} as never),
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

test('preflight rejects Codex versions older than the pinned app-server minimum', async () => {
  const transport = createTransport({spawn: async () => new MemoryAppServerOwner([])}, {
    preflightRunner: {run: async () => ({...safePreflightReport(), version: '0.144.9'})},
  })
  await assert.rejects(
    transport.preflight({expiresAtMs: Date.now() + 5000}),
    (error: unknown) => String(error) === 'CodexTransportError: unsupported_version',
  )
})

test('preflight rejects a prerelease at the pinned app-server minimum', async () => {
  for (const version of [
    '0.145.0-alpha', '0.145.0+build.1', 'v0.145.0', 'codex-cli 0.145.0', 'codex 0.145.0',
  ]) {
    const transport = createTransport({spawn: async () => new MemoryAppServerOwner([])}, {
      preflightRunner: {run: async () => ({...safePreflightReport(), version})},
    })
    await assert.rejects(
      transport.preflight({expiresAtMs: Date.now() + 5000}),
      (error: unknown) => String(error) === 'CodexTransportError: unsupported_version',
    )
  }
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
    spawn: async () => invalidOwner as unknown as OwnedCodexProcess,
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

test('prewarm and run joiners apply their own deadlines to a shared establishment', async () => {
  for (const joinKind of ['prewarm', 'run'] as const) {
    const owner = new MemoryAppServerOwner([], {holdInitialize: true})
    let spawnCount = 0
    const transport = createTransport({spawn: async () => {
      spawnCount += 1
      return owner
    }})
    const warming = transport.prewarm({expiresAtMs: Date.now() + 60_000})
    await owner.initializeReceived.promise
    try {
      if (joinKind === 'prewarm') {
        await assert.rejects(
          within(
            transport.prewarm({expiresAtMs: Date.now() + 25}),
            500,
            'bounded prewarm joiner',
          ),
          (error: unknown) => String(error) === 'CodexTransportError: preflight_timeout',
        )
      } else {
        assert.deepEqual(await transport.run(
          {workOrder: 'bounded joiner'},
          {},
          {expiresAtMs: Date.now() + 25},
        ), {
          classification: 'refused',
          code: 'adapter_timeout',
          turnStartWritten: false,
          completion: null,
        })
      }
      assert.equal(spawnCount, 1)
    } finally {
      owner.releaseInitialize()
      await warming
      await transport.close().catch(() => undefined)
    }
  }
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

test('an establishing-session cleanup timeout remains directly reachable by later close', async () => {
  const owner = new MemoryAppServerOwner([], {holdInitialize: true})
  const disposeEntered = testDeferred<void>()
  const releaseDispose = testDeferred<void>()
  let cleanupCount = 0
  owner.dispose = async () => {
    owner.disposeCalls += 1
    disposeEntered.resolve()
    await releaseDispose.promise
    owner.disposed = true
  }
  const transport = createTransport({spawn: async () => owner}, {
    removeEphemeralHome: async () => { cleanupCount += 1 },
  })
  const running = transport.run(
    {workOrder: 'establishment fails before a turn'},
    {},
    {expiresAtMs: Date.now() + 60_000},
  )
  await owner.initializeReceived.promise
  owner.abruptExit(7)
  await disposeEntered.promise
  const result = await within(
    running,
    runtime.CODEX_TREE_GRACE_MS + 1000,
    'bounded establishing cleanup',
  )
  assert.equal(result.code, 'transport_lost')
  assert.equal(cleanupCount, 0)
  releaseDispose.resolve()
  await transport.close()
  assert.equal(owner.disposeCalls, 1)
  assert.equal(cleanupCount, 1)
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

test('a successful close promise is permanently shared and idempotent', async () => {
  const owner = new MemoryAppServerOwner([])
  const transport = createTransport({spawn: async () => owner})
  await transport.prewarm({expiresAtMs: Date.now() + 5000})
  const first = transport.close()
  assert.equal(transport.close(), first)
  await first
  assert.equal(transport.close(), first)
  assert.equal(owner.disposeCalls, 1)
})

test('close bounds a non-cooperative credential prewarm and a later attempt joins cleanup', async () => {
  const entered = testDeferred<void>()
  const release = testDeferred<void>()
  let cleanupCount = 0
  const transport = createTransport({spawn: async () => new MemoryAppServerOwner([])}, {
    prepare: async () => {
      entered.resolve()
      await release.promise
      return {} as never
    },
    removeEphemeralHome: async () => { cleanupCount += 1 },
  })
  const warming = transport.prewarm({expiresAtMs: Date.now() + 60_000})
  await entered.promise
  const firstClose = transport.close()
  try {
    await assert.rejects(
      within(firstClose, runtime.CODEX_TREE_GRACE_MS + 1000, 'bounded credential close'),
      (error: unknown) => String(error) === 'CodexTransportError: transport_lost',
    )
    assert.equal(cleanupCount, 0)
  } finally {
    release.resolve()
  }
  await assert.rejects(warming, runtime.CodexTransportError)
  await settleUntil(() => cleanupCount === 1, 'late credential cleanup')
  await assert.rejects(
    transport.close(),
    (error: unknown) => String(error) === 'CodexTransportError: transport_lost',
  )
})

test('a caller-timed-out credential snapshot fail-stops admission until close joins its cleanup', async () => {
  const entered = testDeferred<void>()
  const release = testDeferred<void>()
  const controller = new AbortController()
  let prepareCount = 0
  let spawnCount = 0
  let cleanupCount = 0
  const transport = createTransport({spawn: async () => {
    spawnCount += 1
    return new MemoryAppServerOwner([])
  }}, {
    prepare: async () => {
      prepareCount += 1
      entered.resolve()
      await release.promise
      return {} as never
    },
    removeEphemeralHome: async () => { cleanupCount += 1 },
  })
  const running = transport.run(
    {workOrder: 'caller timeout retains credential ownership'},
    {},
    {expiresAtMs: Date.now() + 60_000, signal: controller.signal},
  )
  await entered.promise
  controller.abort()
  assert.deepEqual(await within(
    running,
    runtime.CODEX_TREE_GRACE_MS + 1000,
    'bounded caller credential timeout',
  ), {
    classification: 'refused',
    code: 'adapter_timeout',
    turnStartWritten: false,
    completion: null,
  })
  assert.equal(await within(
    transport.prewarm({expiresAtMs: Date.now() + 5000}),
    500,
    'fail-stopped credential prewarm',
  ), null)
  assert.deepEqual(await transport.run(
    {workOrder: 'second admission is forbidden'},
    {},
    {expiresAtMs: Date.now() + 5000},
  ), {
    classification: 'refused',
    code: 'busy',
    turnStartWritten: false,
    completion: null,
  })
  assert.equal(prepareCount, 1)
  assert.equal(spawnCount, 0)
  release.resolve()
  await settleUntil(() => cleanupCount === 1, 'caller credential cleanup')
  await transport.close()
})

test('spawn failure removal is owned and bounded even when the filesystem never settles', async () => {
  const removalEntered = testDeferred<void>()
  const releaseRemoval = testDeferred<void>()
  let removalCalls = 0
  const transport = createTransport({spawn: async () => {
    throw new Error('private spawn failure')
  }}, {
    removeEphemeralHome: async () => {
      removalCalls += 1
      removalEntered.resolve()
      await releaseRemoval.promise
    },
  })
  const running = transport.run(
    {workOrder: 'bounded direct removal'},
    {},
    {expiresAtMs: Date.now() + 60_000},
  )
  await removalEntered.promise
  const closing = transport.close()
  assert.equal((await within(
    running,
    runtime.CODEX_TREE_GRACE_MS + 1000,
    'bounded spawn failure removal',
  )).code, 'spawn_failed')
  await assert.rejects(
    within(closing, runtime.CODEX_TREE_GRACE_MS + 1000, 'bounded direct-removal close'),
    (error: unknown) => String(error) === 'CodexTransportError: transport_lost',
  )
  assert.equal(removalCalls, 1)
  releaseRemoval.resolve()
  await new Promise<void>(resolve => { setImmediate(resolve) })
  await assert.rejects(
    transport.close(),
    (error: unknown) => String(error) === 'CodexTransportError: transport_lost',
  )
  assert.equal(removalCalls, 1)
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

test('stderr-tainted prewarm is cleaned and cannot be reused', async () => {
  const owners: MemoryAppServerOwner[] = []
  const transport = createTransport({spawn: async () => {
    const owner = new MemoryAppServerOwner([], {threadId: `thread-${owners.length + 1}`})
    owners.push(owner)
    return owner
  }}, {
    scheduler: {
      clock: {now: () => Date.now(), sleep: async () => {}},
      yieldIo: async () => {
        owners.at(-1)?.emitStderr(64 * 1024 + 1)
        await new Promise<void>(resolve => { setImmediate(resolve) })
      },
    },
  })
  await assert.rejects(
    transport.prewarm({expiresAtMs: Date.now() + 5000}),
    (error: unknown) => String(error) === 'CodexTransportError: stderr_too_large',
  )
  assert.equal(owners[0]?.disposed, true)
})

test('stderr-tainted cold run is refused before turn/start can be written', async () => {
  const methods: string[] = []
  const owner = new MemoryAppServerOwner(methods)
  const transport = createTransport({spawn: async () => owner}, {
    scheduler: {
      clock: {now: () => Date.now(), sleep: async () => {}},
      yieldIo: async () => {
        owner.emitStderr(64 * 1024 + 1)
        await new Promise<void>(resolve => { setImmediate(resolve) })
      },
    },
  })
  const result = await transport.run(
    {workOrder: 'must not reach tainted child'},
    {},
    {expiresAtMs: Date.now() + 5000},
  )
  assert.deepEqual(result, {
    classification: 'refused',
    code: 'stderr_too_large',
    turnStartWritten: false,
    completion: null,
  })
  assert.equal(methods.includes('turn/start'), false)
  assert.equal(owner.disposed, true)
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

test('stdout applies pause/resume backpressure and rejects an oversized chunk before copying it', async () => {
  const owner = new MemoryAppServerOwner([], {delayTurnStart: true})
  const transport = createTransport({spawn: async () => owner})
  const running = transport.run(
    {workOrder: 'bounded stdout copy'},
    {},
    {expiresAtMs: Date.now() + 5000},
  )
  await owner.turnStartReceived.promise
  await new Promise<void>(resolve => { setImmediate(resolve) })
  owner.emitHostileOversizedStdout()
  const result = await running
  assert.equal(result.code, 'transport_lost')
  assert.equal(owner.stdoutPauseCalls > 0, true)
  assert.equal(owner.hostileIteratorRead, false)
})

test('stdout close without end settles the feed pump instead of waiting for caller deadline', async () => {
  const owner = new MemoryAppServerOwner([], {delayTurnStart: true})
  const transport = createTransport({spawn: async () => owner})
  const running = transport.run(
    {workOrder: 'close stdout during turn'},
    {},
    {expiresAtMs: Date.now() + 5000},
  )
  await owner.turnStartReceived.promise
  await new Promise<void>(resolve => { setImmediate(resolve) })
  owner.stdout.destroy()
  assert.equal((await running).code, 'transport_lost')
  assert.equal(owner.disposed, true)
})

test('stdout close joins a server-request feed blocked on the response writer', async () => {
  const owner = new MemoryAppServerOwner([], {delayTurnStart: true, holdServerReplyWrite: true})
  const transport = createTransport({spawn: async () => owner})
  const running = transport.run(
    {workOrder: 'blocked feed cleanup'},
    {},
    {expiresAtMs: Date.now() + 10_000},
  )
  await owner.turnStartReceived.promise
  await new Promise<void>(resolve => { setImmediate(resolve) })
  owner.emitServerRequest()
  await owner.serverReplyWriteReceived.promise
  owner.stdout.destroy()
  const result = await within(running, 7000, 'blocked feed cleanup')
  assert.equal(result.code, 'unexpected_server_request')
  assert.equal(owner.disposed, true)
  await transport.close().catch(() => undefined)
})

test('tree-gone pipe shutdown unblocks the existing feed before final dispose', async () => {
  const owner = new MemoryAppServerOwner([], {delayTurnStart: true, holdServerReplyWrite: true})
  owner.closeStdin = async () => {}
  owner.waitTreeGone = async () => true
  owner.dispose = async () => {
    owner.disposeCalls += 1
    owner.disposed = true
  }
  const transport = createTransport({spawn: async () => owner})
  const running = transport.run(
    {workOrder: 'bounded retained pump cleanup'},
    {},
    {expiresAtMs: Date.now() + 60_000},
  )
  await owner.turnStartReceived.promise
  await new Promise<void>(resolve => { setImmediate(resolve) })
  owner.emitServerRequest()
  await owner.serverReplyWriteReceived.promise
  owner.stdout.destroy()
  const result = await within(
    running,
    runtime.CODEX_TREE_GRACE_MS + 1000,
    'bounded pipe-shutdown feed result',
  )
  assert.equal(result.code, 'unexpected_server_request')
  assert.equal(owner.disposeCalls, 1)
  await transport.close()
  assert.equal(owner.disposeCalls, 1)
})

test('a non-cooperative feed pump is bounded and a later close joins the same pump', async () => {
  const owner = new MemoryAppServerOwner([], {delayTurnStart: true, holdServerReplyWrite: true})
  owner.closeStdin = async () => {}
  owner.waitTreeGone = async () => true
  owner.stdin.destroy = () => owner.stdin
  owner.dispose = async () => {
    owner.disposeCalls += 1
    owner.disposed = true
  }
  const transport = createTransport({spawn: async () => owner})
  const running = transport.run(
    {workOrder: 'bounded non-cooperative pump'},
    {},
    {expiresAtMs: Date.now() + 60_000},
  )
  await owner.turnStartReceived.promise
  await new Promise<void>(resolve => { setImmediate(resolve) })
  owner.emitServerRequest()
  await owner.serverReplyWriteReceived.promise
  owner.stdout.destroy()
  try {
    const result = await within(
      running,
      runtime.CODEX_TREE_GRACE_MS + 1000,
      'bounded non-cooperative pump result',
    )
    assert.equal(result.code, 'unexpected_server_request')
    assert.equal(owner.disposeCalls, 0)
  } finally {
    owner.releaseServerReplyWrite()
  }
  await transport.close()
  assert.equal(owner.disposeCalls, 1)
})

test('a non-cooperative final dispose is bounded and a later close joins the same attempt', async () => {
  const owner = new MemoryAppServerOwner([])
  const disposeEntered = testDeferred<void>()
  const releaseDispose = testDeferred<void>()
  let cleanupCount = 0
  owner.dispose = async () => {
    owner.disposeCalls += 1
    disposeEntered.resolve()
    await releaseDispose.promise
    owner.disposed = true
    owner.stdin.destroy()
    owner.stdout.destroy()
    owner.stderr.destroy()
  }
  const transport = createTransport({spawn: async () => owner}, {
    removeEphemeralHome: async () => { cleanupCount += 1 },
  })
  const running = transport.run(
    {workOrder: 'bounded final dispose'},
    {},
    {expiresAtMs: Date.now() + 60_000},
  )
  await disposeEntered.promise
  try {
    const result = await within(
      running,
      runtime.CODEX_TREE_GRACE_MS + 1000,
      'bounded dispose result',
    )
    assert.equal(result.code, 'transport_lost')
    assert.equal(owner.disposeCalls, 1)
    assert.equal(cleanupCount, 0)
  } finally {
    releaseDispose.resolve()
  }
  await transport.close()
  assert.equal(owner.disposeCalls, 1)
  assert.equal(cleanupCount, 1)
})

test('non-cooperative closeStdin and terminate cannot starve KILL or repeat one-shot controls', async () => {
  const owner = new MemoryAppServerOwner([])
  let closeStdinCalls = 0
  let terminateCalls = 0
  let killCalls = 0
  let treeGone = false
  owner.closeStdin = async () => {
    closeStdinCalls += 1
    await new Promise<void>(() => undefined)
  }
  owner.waitTreeGone = async () => treeGone
  owner.terminateTree = async () => {
    terminateCalls += 1
    await new Promise<void>(() => undefined)
  }
  owner.killTree = async () => { killCalls += 1 }
  const transport = createTransport({spawn: async () => owner})
  const result = await within(transport.run(
    {workOrder: 'escalation cannot be starved'},
    {},
    {expiresAtMs: Date.now() + 60_000},
  ), runtime.CODEX_TREE_GRACE_MS + 1000, 'bounded escalation')
  assert.equal(result.code, 'transport_lost')
  assert.deepEqual({closeStdinCalls, terminateCalls, killCalls}, {
    closeStdinCalls: 1, terminateCalls: 1, killCalls: 1,
  })
  assert.equal(owner.disposeCalls, 0)

  treeGone = true
  await transport.close()
  assert.deepEqual({closeStdinCalls, terminateCalls, killCalls}, {
    closeStdinCalls: 1, terminateCalls: 1, killCalls: 1,
  })
  assert.equal(owner.disposeCalls, 1)
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

test('plain sentinels and NFC-equivalent developer instructions remain redacted through final projection', async () => {
  const sentinel = 'ultraviolet mango sentinel'
  const developerInstructions = 'de\u0301veloper instruction sentinel'
  const owner = new MemoryAppServerOwner([], {
    finalText: `${sentinel} déveloper instruction sentinel useful`,
  })
  const transport = createTransport({spawn: async () => owner}, {developerInstructions})
  const result = await transport.run(
    {workOrder: sentinel},
    {},
    {expiresAtMs: Date.now() + 5000},
  )
  const rendered = JSON.stringify(result)
  assert.equal(rendered.includes(sentinel), false)
  assert.equal(rendered.includes('déveloper instruction sentinel'), false)
  assert.equal(rendered.includes('useful'), true)
})

test('a written steer is registered as sensitive before concurrent final notifications', async () => {
  const steerSentinel = 'violet kiwi steer sentinel'
  const owner = new MemoryAppServerOwner([], {delayTurnStart: true, echoSteerInFinal: true})
  const transport = createTransport({spawn: async () => owner})
  const running = transport.run(
    {workOrder: 'ordinary work order'},
    {},
    {expiresAtMs: Date.now() + 5000},
  )
  await owner.turnStartReceived.promise
  assert.deepEqual(await transport.steer(
    {instruction: steerSentinel},
    {expiresAtMs: Date.now() + 5000},
  ), {code: 'accepted', written: true})
  owner.completeDelayedTurn()
  assert.equal(JSON.stringify(await running).includes(steerSentinel), false)
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

test('a post-start transport failure latches turn history for later stale steer', async () => {
  const owner = new MemoryAppServerOwner([], {delayTurnStart: true})
  const transport = createTransport({spawn: async () => owner})
  const running = transport.run(
    {workOrder: 'start then fail'},
    {},
    {expiresAtMs: Date.now() + 5000},
  )
  await owner.turnStartReceived.promise
  await new Promise<void>(resolve => { setImmediate(resolve) })
  owner.abruptExit(7)
  assert.equal((await running).classification, 'uncertain')
  assert.deepEqual(await transport.steer(
    {instruction: 'too late'},
    {expiresAtMs: Date.now() + 5000},
  ), {code: 'stale_turn', written: false})
})

test('interrupt acknowledgement does not close stdin before terminal grace completes', async () => {
  const owner = new MemoryAppServerOwner([], {delayTurnStart: true})
  const transport = createTransport({spawn: async () => owner})
  const running = transport.run(
    {workOrder: 'interrupt with terminal grace'},
    {},
    {expiresAtMs: Date.now() + 5000},
  )
  await owner.turnStartReceived.promise
  await new Promise<void>(resolve => { setImmediate(resolve) })
  const closing = transport.close('cancel')
  await owner.interruptReceived.promise
  let closeSettled = false
  void closing.finally(() => { closeSettled = true })
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.equal(closeSettled, false)
  assert.equal(owner.stdin.writableEnded, false)
  owner.completeDelayedTurn()
  await closing
  await running
})

test('late spawn completion is still owned, disposed, and joined by close', async () => {
  const entered = testDeferred<void>()
  const release = testDeferred<void>()
  const owner = new MemoryAppServerOwner([])
  const controller = new AbortController()
  const transport = createTransport({spawn: async () => {
    entered.resolve()
    await release.promise
    return owner
  }})
  const running = transport.run(
    {workOrder: 'cancel while host spawn is pending'},
    {},
    {expiresAtMs: Date.now() + 60_000, signal: controller.signal},
  )
  await entered.promise
  controller.abort()
  assert.equal((await running).code, 'adapter_timeout')
  const closing = transport.close()
  release.resolve()
  await closing
  assert.equal(owner.disposed, true)
  assert.equal(owner.disposeCalls, 1)
})

test('spawn ownership contract receives cancellation and close joins its settlement', async () => {
  const entered = testDeferred<void>()
  let spawnWasAborted = false
  const controller = new AbortController()
  const transport = createTransport({spawn: async (_spec, control) => {
    entered.resolve()
    await new Promise<void>((_resolve, reject) => {
      control.signal.addEventListener('abort', () => {
        spawnWasAborted = true
        reject(new Error('private abort'))
      }, {once: true})
    })
    throw new Error('unreachable')
  }})
  const running = transport.run(
    {workOrder: 'cancel cooperative spawn'},
    {},
    {expiresAtMs: Date.now() + 60_000, signal: controller.signal},
  )
  await entered.promise
  controller.abort()
  assert.equal((await running).code, 'adapter_timeout')
  try {
    assert.equal(spawnWasAborted, true)
  } finally {
    await transport.close().catch(() => undefined)
  }
})

test('close-driven cooperative spawn cancellation remains transport_lost', async () => {
  const entered = testDeferred<void>()
  const transport = createTransport({spawn: async (_spec, control) => {
    entered.resolve()
    await new Promise<void>((_resolve, reject) => {
      control.signal.addEventListener('abort', () => { reject(new Error('private abort')) }, {once: true})
    })
    throw new Error('unreachable')
  }})
  const running = transport.run(
    {workOrder: 'close cooperative spawn'},
    {},
    {expiresAtMs: Date.now() + 60_000},
  )
  await entered.promise
  const closing = transport.close()
  assert.deepEqual(await running, {
    classification: 'refused',
    code: 'transport_lost',
    turnStartWritten: false,
    completion: null,
  })
  await closing
})

test('a non-cooperative spawn is diagnosed as transport loss and its late owner is immediately disposed', async () => {
  const entered = testDeferred<void>()
  const release = testDeferred<void>()
  const owner = new MemoryAppServerOwner([])
  const controller = new AbortController()
  const transport = createTransport({spawn: async () => {
    entered.resolve()
    await release.promise
    return owner
  }})
  const running = transport.run(
    {workOrder: 'non-cooperative spawn'},
    {},
    {expiresAtMs: Date.now() + 60_000, signal: controller.signal},
  )
  await entered.promise
  controller.abort()
  assert.equal((await running).code, 'adapter_timeout')
  try {
    await assert.rejects(
      within(transport.close(), runtime.CODEX_TREE_GRACE_MS + 1000, 'bounded close'),
      (error: unknown) => String(error) === 'CodexTransportError: transport_lost',
    )
  } finally {
    release.resolve()
    await settleUntil(() => owner.disposed, 'post-close late owner cleanup')
  }
  assert.equal(owner.disposeCalls, 1)
})

test('a caller-timed-out spawn fail-stops admission until its late owner is cleaned', async () => {
  const entered = testDeferred<void>()
  const release = testDeferred<void>()
  const owner = new MemoryAppServerOwner([])
  const controller = new AbortController()
  let spawnCount = 0
  const transport = createTransport({spawn: async () => {
    spawnCount += 1
    if (spawnCount === 1) {
      entered.resolve()
      await release.promise
      return owner
    }
    return new MemoryAppServerOwner([])
  }})
  const running = transport.run(
    {workOrder: 'late spawn retains exclusive ownership'},
    {},
    {expiresAtMs: Date.now() + 60_000, signal: controller.signal},
  )
  await entered.promise
  controller.abort()
  assert.equal((await running).code, 'adapter_timeout')
  try {
    assert.equal(await within(
      transport.prewarm({expiresAtMs: Date.now() + 5000}),
      500,
      'fail-stopped late-spawn prewarm',
    ), null)
    assert.deepEqual(await transport.run(
      {workOrder: 'a second spawn is forbidden'},
      {},
      {expiresAtMs: Date.now() + 5000},
    ), {
      classification: 'refused',
      code: 'busy',
      turnStartWritten: false,
      completion: null,
    })
    assert.equal(spawnCount, 1)
  } finally {
    release.resolve()
    await settleUntil(() => owner.disposed, 'late exclusive owner cleanup')
    await transport.close().catch(() => undefined)
  }
})

test('a completed late-owner cleanup latches its first stable failure for later close', async () => {
  const entered = testDeferred<void>()
  const release = testDeferred<void>()
  const owner = new MemoryAppServerOwner([])
  const controller = new AbortController()
  const transport = createTransport({spawn: async () => {
    entered.resolve()
    await release.promise
    return owner
  }}, {removeEphemeralHome: async () => { throw new Error('private cleanup path') }})
  const running = transport.run(
    {workOrder: 'late cleanup failure'},
    {},
    {expiresAtMs: Date.now() + 60_000, signal: controller.signal},
  )
  await entered.promise
  controller.abort()
  assert.equal((await running).code, 'adapter_timeout')
  release.resolve()
  await settleUntil(() => owner.disposed, 'late owner cleanup')
  await assert.rejects(
    transport.close(),
    (error: unknown) => String(error) === 'CodexTransportError: credential_missing',
  )
})

test('an unconfirmed late owner fail-stops admission and close retries that raw owner', async () => {
  const entered = testDeferred<void>()
  const release = testDeferred<void>()
  const owner = new MemoryAppServerOwner([])
  let treeChecks = 0
  let killCalls = 0
  owner.waitTreeGone = async () => {
    treeChecks += 1
    return treeChecks > 3
  }
  owner.terminateTree = async () => {}
  owner.killTree = async () => { killCalls += 1 }
  const controller = new AbortController()
  let spawnCount = 0
  let cleanupCount = 0
  const transport = createTransport({spawn: async () => {
    spawnCount += 1
    entered.resolve()
    await release.promise
    return owner
  }}, {removeEphemeralHome: async () => { cleanupCount += 1 }})
  const running = transport.run(
    {workOrder: 'late raw owner must remain recoverable'},
    {},
    {expiresAtMs: Date.now() + 60_000, signal: controller.signal},
  )
  await entered.promise
  controller.abort()
  assert.equal((await running).code, 'adapter_timeout')
  release.resolve()
  await settleUntil(() => killCalls === 1, 'first late-owner cleanup attempt')
  assert.equal(cleanupCount, 0)
  assert.equal(owner.disposeCalls, 0)

  assert.equal(await transport.prewarm({expiresAtMs: Date.now() + 5000}), null)
  assert.deepEqual(await transport.run(
    {workOrder: 'second child is forbidden after raw cleanup failure'},
    {},
    {expiresAtMs: Date.now() + 5000},
  ), {
    classification: 'refused',
    code: 'busy',
    turnStartWritten: false,
    completion: null,
  })
  assert.equal(spawnCount, 1)

  await assert.rejects(
    transport.close(),
    (error: unknown) => String(error) === 'CodexTransportError: transport_lost',
  )
  assert.equal(treeChecks, 4)
  assert.equal(cleanupCount, 1)
  assert.equal(owner.disposeCalls, 1)
})

test('a supervision-rejected owner keeps credentials until transport close confirms its tree gone', async () => {
  const owner = new MemoryAppServerOwner([])
  let treeChecks = 0
  owner.waitTreeGone = async () => { treeChecks += 1; return true }
  let cleanupCount = 0
  const transport = createTransport({
    spawn: async () => { throw unconfirmedCodexProcessOwnerError(owner) },
  }, {removeEphemeralHome: async () => { cleanupCount += 1 }})

  const result = await transport.run(
    {workOrder: 'supervision rejection still owns a live tree'},
    {},
    {expiresAtMs: Date.now() + 5000},
  )
  assert.deepEqual(result, {
    classification: 'refused',
    code: 'transport_lost',
    turnStartWritten: false,
    completion: null,
  })
  assert.equal(cleanupCount, 0)
  assert.equal(await transport.prewarm({expiresAtMs: Date.now() + 5000}), null)

  await transport.close()
  assert.equal(treeChecks, 1)
  assert.equal(cleanupCount, 1)
})

test('a late supervision rejection retains its opaque owner and never removes live credentials', async () => {
  const entered = testDeferred<void>()
  const release = testDeferred<void>()
  const owner = new MemoryAppServerOwner([])
  let treeChecks = 0
  owner.waitTreeGone = async () => { treeChecks += 1; return true }
  const controller = new AbortController()
  let spawnCount = 0
  let cleanupCount = 0
  const transport = createTransport({spawn: async () => {
    spawnCount += 1
    entered.resolve()
    await release.promise
    throw unconfirmedCodexProcessOwnerError(owner)
  }}, {removeEphemeralHome: async () => { cleanupCount += 1 }})
  const running = transport.run(
    {workOrder: 'late supervision capability must cross the timeout boundary'},
    {},
    {expiresAtMs: Date.now() + 60_000, signal: controller.signal},
  )
  await entered.promise
  controller.abort()
  assert.equal((await running).code, 'adapter_timeout')
  release.resolve()
  await new Promise<void>(resolve => { setImmediate(resolve) })
  await new Promise<void>(resolve => { setImmediate(resolve) })

  assert.equal(cleanupCount, 0)
  assert.equal(await transport.prewarm({expiresAtMs: Date.now() + 5000}), null)
  assert.equal(spawnCount, 1)
  await assert.rejects(
    transport.close(),
    (error: unknown) => String(error) === 'CodexTransportError: transport_lost',
  )
  assert.equal(treeChecks, 1)
  assert.equal(cleanupCount, 1)
})

test('close already waiting on a late credential failure reports credential_missing', async () => {
  const entered = testDeferred<void>()
  const release = testDeferred<void>()
  const owner = new MemoryAppServerOwner([])
  const controller = new AbortController()
  const transport = createTransport({spawn: async () => {
    entered.resolve()
    await release.promise
    return owner
  }}, {removeEphemeralHome: async () => { throw new Error('private cleanup path') }})
  const running = transport.run(
    {workOrder: 'late failure while close waits'},
    {},
    {expiresAtMs: Date.now() + 60_000, signal: controller.signal},
  )
  await entered.promise
  controller.abort()
  assert.equal((await running).code, 'adapter_timeout')
  const closing = transport.close()
  release.resolve()
  await assert.rejects(
    closing,
    (error: unknown) => String(error) === 'CodexTransportError: credential_missing',
  )
  assert.equal(owner.disposed, true)
})

test('credential cleanup failure changes success into a stable failure and close rejects', async () => {
  const owner = new MemoryAppServerOwner([])
  const transport = createTransport({spawn: async () => owner}, {
    removeEphemeralHome: async () => { throw new Error('private cleanup path') },
  })
  const result = await transport.run(
    {workOrder: 'cleanup must be part of success'},
    {},
    {expiresAtMs: Date.now() + 5000},
  )
  assert.equal(result.classification, 'uncertain')
  assert.equal(result.code, 'credential_missing')

  const warmOwner = new MemoryAppServerOwner([])
  const warm = createTransport({spawn: async () => warmOwner}, {
    removeEphemeralHome: async () => { throw new Error('private cleanup path') },
  })
  await warm.prewarm({expiresAtMs: Date.now() + 5000})
  await assert.rejects(
    warm.close(),
    (error: unknown) => String(error) === 'CodexTransportError: credential_missing',
  )
})

test('a failed credential removal is retried physically while close preserves its first diagnostic', async () => {
  const owner = new MemoryAppServerOwner([])
  let removalCalls = 0
  let physicallyRemoved = false
  const transport = createTransport({spawn: async () => owner}, {
    removeEphemeralHome: async () => {
      removalCalls += 1
      if (removalCalls === 1) throw new Error('private first removal failure')
      physicallyRemoved = true
    },
  })
  await transport.prewarm({expiresAtMs: Date.now() + 5000})
  const first = transport.close()
  let firstError: unknown
  try { await first } catch (error) { firstError = error }
  assert.equal(String(firstError), 'CodexTransportError: credential_missing')
  assert.equal(removalCalls, 1)
  assert.equal(physicallyRemoved, false)

  const retry = transport.close()
  assert.notEqual(retry, first)
  await assert.rejects(
    retry,
    (error: unknown) => String(error) === 'CodexTransportError: credential_missing',
  )
  assert.equal(removalCalls, 2)
  assert.equal(physicallyRemoved, true)
  assert.equal(transport.close(), retry)
})

test('credential cleanup failure after a failed run remains observable by close', async () => {
  const owner = new MemoryAppServerOwner([], {delayTurnStart: true})
  const transport = createTransport({spawn: async () => owner}, {
    removeEphemeralHome: async () => { throw new Error('private cleanup path') },
  })
  const running = transport.run(
    {workOrder: 'fail before cleanup'},
    {},
    {expiresAtMs: Date.now() + 5000},
  )
  await owner.turnStartReceived.promise
  owner.abruptExit(7)
  const result = await running
  assert.equal(result.code, 'transport_lost')
  await assert.rejects(
    transport.close(),
    (error: unknown) => String(error) === 'CodexTransportError: credential_missing',
  )
})

test('credential quarantine is not removed until the owned process tree is confirmed gone', async () => {
  const owner = new MemoryAppServerOwner([])
  owner.waitTreeGone = async () => false
  let cleanupCount = 0
  const transport = createTransport({spawn: async () => owner}, {
    removeEphemeralHome: async () => { cleanupCount += 1 },
  })
  const result = await transport.run(
    {workOrder: 'tree must be gone before credential removal'},
    {},
    {expiresAtMs: Date.now() + 5000},
  )
  assert.equal(result.code, 'transport_lost')
  assert.equal(cleanupCount, 0)
  await assert.rejects(
    transport.close(),
    (error: unknown) => String(error) === 'CodexTransportError: transport_lost',
  )
})

test('a failed close attempt is shared and retries cleanup without losing its first diagnostic', async () => {
  const owner = new MemoryAppServerOwner([])
  let treeGone = false
  owner.waitTreeGone = async () => treeGone
  owner.terminateTree = async () => {}
  owner.killTree = async () => {}
  const transport = createTransport({spawn: async () => owner})
  assert.equal((await transport.run(
    {workOrder: 'retain cleanup across close attempts'},
    {},
    {expiresAtMs: Date.now() + 5000},
  )).code, 'transport_lost')

  const first = transport.close()
  const concurrent = transport.close()
  assert.equal(concurrent, first)
  let firstError: unknown
  try { await first } catch (error) { firstError = error }
  assert.equal(String(firstError), 'CodexTransportError: transport_lost')
  treeGone = true
  const retry = transport.close()
  assert.notEqual(retry, first)
  await assert.rejects(
    retry,
    (error: unknown) => String(error) === 'CodexTransportError: transport_lost',
  )
  assert.equal(owner.disposeCalls, 1)
  assert.equal(transport.close(), retry)
})

test('session final dispose never runs before the complete process tree is gone', async () => {
  const owner = new MemoryAppServerOwner([])
  let treeGone = false
  owner.waitTreeGone = async () => treeGone
  owner.terminateTree = async () => {}
  owner.killTree = async () => {}
  const transport = createTransport({spawn: async () => owner})
  try {
    assert.equal((await transport.run(
      {workOrder: 'retain tree control before dispose'},
      {},
      {expiresAtMs: Date.now() + 5000},
    )).code, 'transport_lost')
    assert.equal(owner.disposeCalls, 0)
  } finally {
    treeGone = true
    await transport.close().catch(() => undefined)
  }
})

test('an unconfirmed owned tree fail-stops admission and close retries the same owner', async () => {
  const firstOwner = new MemoryAppServerOwner([])
  let treeChecks = 0
  let killCalls = 0
  firstOwner.waitTreeGone = async () => {
    treeChecks += 1
    return treeChecks > 3
  }
  firstOwner.terminateTree = async () => {}
  firstOwner.killTree = async () => { killCalls += 1 }
  let spawnCount = 0
  let cleanupCount = 0
  const transport = createTransport({spawn: async () => {
    spawnCount += 1
    return spawnCount === 1 ? firstOwner : new MemoryAppServerOwner([])
  }}, {
    removeEphemeralHome: async () => { cleanupCount += 1 },
  })

  const first = await transport.run(
    {workOrder: 'retain the only owner until its tree is gone'},
    {},
    {expiresAtMs: Date.now() + 5000},
  )
  assert.equal(first.code, 'transport_lost')
  assert.equal(spawnCount, 1)
  assert.equal(cleanupCount, 0)
  assert.equal(killCalls, 1)

  assert.equal(await transport.prewarm({expiresAtMs: Date.now() + 5000}), null)
  assert.deepEqual(await transport.run(
    {workOrder: 'a second child must never start'},
    {},
    {expiresAtMs: Date.now() + 5000},
  ), {
    classification: 'refused',
    code: 'busy',
    turnStartWritten: false,
    completion: null,
  })
  assert.equal(spawnCount, 1)

  await transport.close()
  assert.equal(spawnCount, 1)
  assert.equal(treeChecks, 4)
  assert.equal(cleanupCount, 1)
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
      binary: hostBinaryForTest(process.execPath),
      workspace: hostWorkspaceForTest(workspace),
      codexHome: hostCodexHomeForTest(workspace, {ephemeral: true}),
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
        binary: hostBinaryForTest(process.execPath),
        workspace: hostWorkspaceForTest(workspace),
        codexHome: hostCodexHomeForTest(workspace, {ephemeral: false}),
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
  const happyTransport = createTransport(happyFactory)
  try {
    const happy = await happyTransport.run(
      {workOrder: 'real fixture work'},
      {},
      {expiresAtMs: Date.now() + 10_000},
    )
    assert.equal(happy.classification, 'completed')
    assert.equal(happy.completion?.final_text, 'fixture result')
  } finally {
    await happyTransport.close().catch(() => undefined)
    await happyFactory.owner?.killTree().catch(() => undefined)
    await happyFactory.owner?.dispose().catch(() => undefined)
  }

  const delayedFactory = new FakeAppServerOwnerFactory('delayed-turn')
  const delayedTransport = createTransport(delayedFactory)
  try {
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
  } finally {
    await delayedTransport.close().catch(() => undefined)
    await delayedFactory.owner?.killTree().catch(() => undefined)
    await delayedFactory.owner?.dispose().catch(() => undefined)
  }
})

test('real child malformed and bounded stream failures settle with stable private codes', async () => {
  for (const [scenario, code] of [
    ['malformed-after-turn', 'unsupported_protocol'],
    ['stdout-overflow', 'transport_lost'],
    ['stderr-overflow', 'stderr_too_large'],
  ] as const) {
    const factory = new FakeAppServerOwnerFactory(scenario)
    const transport = createTransport(factory)
    try {
      const result = await transport.run(
        {workOrder: 'real-stream-private-sentinel'},
        {},
        {expiresAtMs: Date.now() + 10_000},
      )
      assert.equal(result.classification, 'uncertain')
      assert.equal(result.turnStartWritten, true)
      assert.equal(result.code, code)
      assert.equal(JSON.stringify(result).includes('real-stream-private-sentinel'), false)
    } finally {
      await transport.close().catch(() => undefined)
      await factory.owner?.killTree().catch(() => undefined)
      await factory.owner?.dispose().catch(() => undefined)
    }
  }
})

for (const evidence of [
  {scenario: 'duplicate-response', classification: 'refused', code: 'unsupported_protocol', written: false},
  {scenario: 'unknown-response', classification: 'refused', code: 'unsupported_protocol', written: false},
  {scenario: 'server-request', classification: 'refused', code: 'unexpected_server_request', written: false},
  {scenario: 'clean-eof', classification: 'uncertain', code: 'transport_lost', written: true},
  {scenario: 'pending-eof', classification: 'uncertain', code: 'transport_lost', written: true},
  {scenario: 'turn-rejection-order', classification: 'uncertain', code: 'server_rejected', written: true},
] as const) {
  test(`real child ${evidence.scenario} settles with the first stable boundary result`, async () => {
    const factory = new FakeAppServerOwnerFactory(evidence.scenario)
    const transport = createTransport(factory)
    try {
      const running = transport.run(
        {workOrder: 'real-protocol-private-sentinel'},
        {},
        {expiresAtMs: Date.now() + 10_000},
      )
      if (evidence.scenario === 'clean-eof') {
        await settleUntil(() => factory.owner !== null, 'clean EOF fake owner spawn')
        await within(factory.owner!.waitForBarrier('turn_start'), 5000, 'clean EOF post-drain barrier')
        factory.owner!.release('clean_eof')
      }
      const result = await running
      assert.equal(result.classification, evidence.classification)
      assert.equal(result.code, evidence.code)
      assert.equal(result.turnStartWritten, evidence.written)
      assert.equal(JSON.stringify(result).includes('real-protocol-private-sentinel'), false)
    } finally {
      await transport.close().catch(() => undefined)
      await factory.owner?.killTree().catch(() => undefined)
      await factory.owner?.dispose().catch(() => undefined)
    }
  })
}

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
  readonly interruptReceived = testDeferred<void>()
  readonly serverReplyWriteReceived = testDeferred<void>()
  readonly received: {readonly method: string; readonly params: Readonly<Record<string, unknown>>}[] = []
  disposed = false
  disposeCalls = 0
  stdoutPauseCalls = 0
  stdoutResumeCalls = 0
  hostileIteratorRead = false
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
    readonly echoSteerInFinal: boolean
    readonly holdServerReplyWrite: boolean
  }
  #delayedTurnRequestId: number | undefined
  #heldInitializeRequestId: number | undefined
  #lastSteer: string | null = null
  #heldServerReplyWrite: ((error?: Error | null) => void) | null = null

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
    readonly echoSteerInFinal?: boolean
    readonly holdServerReplyWrite?: boolean
  } = {}) {
    const pause = this.stdout.pause.bind(this.stdout)
    const resume = this.stdout.resume.bind(this.stdout)
    this.stdout.pause = () => { this.stdoutPauseCalls += 1; return pause() }
    this.stdout.resume = () => { this.stdoutResumeCalls += 1; return resume() }
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
      echoSteerInFinal: options.echoSteerInFinal ?? false,
      holdServerReplyWrite: options.holdServerReplyWrite ?? false,
    }
    this.exit = new Promise(resolve => { this.#resolveExit = resolve })
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.#accept(chunk)
        if (
          this.#options.holdServerReplyWrite
          && new TextDecoder().decode(chunk).includes('"code":-32601')
        ) {
          this.#heldServerReplyWrite = callback
          this.serverReplyWriteReceived.resolve()
          return
        }
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
    if (this.#heldServerReplyWrite !== null) this.stdin.emit('close')
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

  emitHostileOversizedStdout(): void {
    const hostile = {
      byteLength: MAX_STDOUT + 1,
      [Symbol.iterator]: (): Iterator<number> => {
        this.hostileIteratorRead = true
        throw new Error('oversized stdout was copied')
      },
    }
    this.stdout.emit('data', hostile)
  }

  emitServerRequest(): void {
    this.#send({id: 901, method: 'private/server-request', params: {secret: 'never public'}})
  }

  releaseServerReplyWrite(): void {
    const callback = this.#heldServerReplyWrite
    this.#heldServerReplyWrite = null
    callback?.()
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
      const input = message.params?.input
      if (Array.isArray(input) && typeof Reflect.get(input[0] ?? {}, 'text') === 'string') {
        this.#lastSteer = Reflect.get(input[0] ?? {}, 'text') as string
      }
      this.#send({id: message.id, result: {turnId: 'turn-1'}})
      return
    }
    if (message.method === 'turn/interrupt') {
      this.interruptReceived.resolve()
      this.#send({id: message.id, result: {}})
    }
  }

  #sendTurnCompletion(requestId: number | undefined): void {
    this.#send({id: requestId, result: {turn: {id: 'turn-1', items: [], status: 'inProgress'}}})
    this.#send({method: 'item/completed', params: {
      threadId: this.#options.threadId, turnId: 'turn-1',
      item: {type: 'agentMessage', text: this.#options.echoSteerInFinal && this.#lastSteer !== null
        ? `${this.#options.finalText} ${this.#lastSteer}`
        : this.#options.finalText},
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
    readonly scheduler?: {
      readonly clock: {now(): number; sleep(milliseconds: number): Promise<void>}
      yieldIo(): Promise<void>
    }
    readonly developerInstructions?: string | null
    readonly prepare?: () => Promise<never>
    readonly removeEphemeralHome?: () => Promise<void>
  } = {},
): OwnedCodexAppServerTransport {
  const workspace = process.cwd()
  return new (runtime.OwnedCodexAppServerTransport)({
    config: {
      binary: hostBinaryForTest(process.execPath),
      workspace: hostWorkspaceForTest(workspace),
      codexHome: hostCodexHomeForTest(workspace, {ephemeral: true}),
      apiKey: 'api-key-sentinel',
      developerInstructions: overrides.developerInstructions ?? null,
      resumeThreadId: null,
      persistent: false,
    },
    processFactory,
    credentialSnapshotter: {
      prepare: overrides.prepare ?? (async () => ({} as never)),
      environment: () => ({
        PATH: '/safe-path', HOME: '/safe-home', CODEX_HOME: workspace,
        CODEX_API_KEY: 'api-key-sentinel',
        CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1',
      }),
      removeEphemeralHome: overrides.removeEphemeralHome ?? (async () => {}),
    },
    preflightRunner: overrides.preflightRunner ?? {run: async () => safePreflightReport()},
    schemaProbe: overrides.schemaProbe ?? {generate: async () => supportedSchemaBundle()},
    ...(overrides.scheduler === undefined ? {} : {scheduler: overrides.scheduler}),
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
