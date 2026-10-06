import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import test from 'node:test'
import {shutdownBackend, waitForBackendReadiness} from '../src/main/backend.mjs'
import {configWarnings, startupErrors, createBackendDiagnosticCollector, createBackendSupervisor, createBackendControl, classifyBackendFailure} from '../src/main/backend-supervisor.mjs'
function deferred() {
  let resolve
  const promise = new Promise(next => { resolve = next })
  return {promise, resolve}
}

test('disconnect survives repeated readiness failures and retires each child before retry', async () => {
  const timers = []
  const stopped = []
  let attempts = 0
  let exit
  const supervisor = createBackendSupervisor({
    start: async onExit => {
      const child = {id: ++attempts}
      exit = onExit
      if (attempts === 2 || attempts === 3) {
        await waitForBackendReadiness(child, Promise.reject(new Error('readiness timeout')),
          createBackendDiagnosticCollector(), async candidate => { stopped.push(candidate.id) })
      }
      return {backend: child, connection: {endpoint: 'ws://127.0.0.1:7/'}}
    },
    stopBackend: async () => {},
    schedule: callback => { timers.push(callback); return callback },
    cancel: () => {},
    onStatus: () => {},
  })
  await supervisor.start()
  exit({kind: 'recoverable', code: 'backend_disconnected'})
  for (let attempt = 2; attempt <= 4; attempt += 1) {
    assert.equal(timers.length, 1)
    timers.shift()()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(attempts, attempt)
    assert.equal(supervisor.status().state, attempt === 4 ? 'connected' : 'reconnecting')
  }
  assert.deepEqual(stopped, [2, 3])
  await supervisor.stop()
})

test('readiness cleanup preserves explicit permanent failures and refuses unconfirmed termination', async () => {
  const diagnostic = createBackendDiagnosticCollector()
  diagnostic.push('[runtime-diagnostic] authentication_failed')
  let stopped = false
  await assert.rejects(waitForBackendReadiness({}, Promise.reject(new Error('exit')), diagnostic,
    async () => { stopped = true }), {kind: 'authentication_failed', code: 'authentication_failed'})
  assert.equal(stopped, true)
  await assert.rejects(waitForBackendReadiness({}, Promise.reject(new Error('timeout')),
    createBackendDiagnosticCollector(), async () => { throw new Error('still alive') }),
  {kind: 'unavailable', code: 'backend_stop_failed'})
})

test('structured startup failures stay permanent when utility exit precedes stderr', async () => {
  for (const status of [
    {state: 'startup_failed', toolCount: 2, toolBudget: 1},
    {state: 'startup_failed', toolCount: null, toolBudget: 24, reason: 'configuration_required', pipeline: 'integrated', missing: ['DASHSCOPE_API_KEY']},
  ]) {
    const diagnostic = createBackendDiagnosticCollector()
    const child = new EventEmitter()
    const control = createBackendControl(child, {onStatus: value => diagnostic.pushCapabilityStatus(value)})
    const retries = []
    const supervisor = createBackendSupervisor({
      start: async onExit => {
        child.once('exit', () => onExit(diagnostic.failure()))
        child.emit('message', {type: 'nova.capabilities', status})
        child.emit('exit', 2)
        throw diagnostic.failure('backend_start_timeout')
      },
      stopBackend: async () => {},
      onStatus: () => {},
      schedule: callback => { retries.push(callback); return callback },
    })
    await supervisor.start()
    assert.equal(supervisor.status().state, 'configuration_required')
    assert.equal(retries.length, 0)
    control.close()
    await supervisor.stop()
  }
})

test('non-configuration capability status does not suppress backend reconnects', () => {
  for (const status of [null, {state: 'running', toolCount: 2, toolBudget: 1},
    {state: 'startup_failed', toolCount: 1, toolBudget: 24},
    {state: 'startup_failed', toolCount: null, toolBudget: 0, reason: 'configuration_required'}]) {
    const diagnostic = createBackendDiagnosticCollector()
    diagnostic.pushCapabilityStatus(status)
    assert.equal(diagnostic.failure().kind, 'recoverable')
  }
})

test('recoverable starts reconnect with deterministic jitter and then connect', async () => {
  const scheduled = []
  const statuses = []
  let attempts = 0
  const supervisor = createBackendSupervisor({
    start: async () => {
      attempts += 1
      if (attempts === 1) throw {kind: 'recoverable', code: 'transport_lost'}
      return {backend: {id: attempts}, connection: {endpoint: 'ws://127.0.0.1:7/'}}
    },
    stopBackend: async () => {},
    schedule: (callback, delay) => {
      const handle = {callback, delay, canceled: false}
      scheduled.push(handle)
      return handle
    },
    cancel: handle => { handle.canceled = true },
    random: () => 1,
    retryPolicy: {baseMs: 1000, capMs: 30_000, jitterRatio: 0.2},
    onStatus: status => statuses.push(status),
  })
  await supervisor.start()
  assert.equal(supervisor.status().state, 'reconnecting')
  assert.equal(scheduled[0].delay, 1200)
  await scheduled[0].callback()
  assert.equal(supervisor.status().state, 'connected')
  assert.equal(statuses.at(-1).connection.endpoint, 'ws://127.0.0.1:7/')
})

test('configuration, authentication, and unavailable failures never arm a timer', async () => {
  for (const kind of ['configuration_required', 'authentication_failed', 'unavailable']) {
    const scheduled = []
    const supervisor = createBackendSupervisor({
      start: async () => { throw {kind, code: `${kind}_test`} },
      stopBackend: async () => {},
      schedule: (callback, delay) => { scheduled.push({callback, delay}); return callback },
      onStatus: () => {},
    })
    await supervisor.start()
    assert.equal(supervisor.status().state, kind)
    assert.equal(supervisor.status().diagnostic, `${kind}_test`)
    assert.equal(scheduled.length, 0)
  }
})

test('exit reconnects, explicit retry cancels delay, and stop fences a stale start', async () => {
  const scheduled = []
  const stopped = []
  const pending = deferred()
  let startCount = 0
  let exit
  const supervisor = createBackendSupervisor({
    start: async onExit => {
      startCount += 1
      exit = onExit
      if (startCount === 3) return await pending.promise
      return {backend: {id: startCount}, connection: {endpoint: 'ws://127.0.0.1:8/'}}
    },
    stopBackend: async backend => { stopped.push(backend.id) },
    schedule: (callback, delay) => {
      const handle = {callback, delay, canceled: false}
      scheduled.push(handle)
      return handle
    },
    cancel: handle => { handle.canceled = true },
    random: () => 0.5,
    retryPolicy: {baseMs: 1000, capMs: 30_000, jitterRatio: 0.2},
    onStatus: () => {},
  })
  await supervisor.start()
  exit({kind: 'recoverable', code: 'backend_exit'})
  assert.equal(supervisor.status().state, 'reconnecting')
  assert.equal(scheduled.at(-1).delay, 1000)
  await supervisor.retry()
  assert.equal(scheduled[0].canceled, true)
  assert.equal(startCount, 2)
  const third = supervisor.restart()
  while (startCount < 3) await Promise.resolve()
  const stopping = supervisor.stop()
  pending.resolve({backend: {id: 3}, connection: {endpoint: 'ws://127.0.0.1:9/'}})
  await stopping
  await third
  assert.deepEqual(stopped, [2, 3])
  assert.equal(supervisor.status().state, 'stopped')
})

test('an unconfirmed stop is explicit and restart never starts a replacement backend', async () => {
  const starts = []
  const statuses = []
  const supervisor = createBackendSupervisor({
    start: async () => {
      const backend = {id: starts.length + 1}
      starts.push(backend)
      return {backend, connection: {endpoint: 'ws://127.0.0.1:10/'}}
    },
    stopBackend: async () => { throw new Error('backend termination unconfirmed') },
    onStatus: status => statuses.push(status),
  })
  await supervisor.start()

  await assert.rejects(supervisor.restart(), /termination unconfirmed/u)

  assert.equal(starts.length, 1)
  assert.notEqual(supervisor.status().state, 'stopped')
  assert.equal(statuses.some(status => status.state === 'stopped'), false)
})

test('assembly cleanup failure on explicit stop or restart never schedules an extra reconnect', async () => {
  for (const mode of ['stop', 'restart', 'unexpected']) {
    let starts = 0
    let child
    const scheduled = []
    const supervisor = createBackendSupervisor({
      start: async onExit => {
        starts += 1
        const diagnostic = createBackendDiagnosticCollector()
        const spawned = new EventEmitter()
        child = spawned
        // Model the utility process reporting a failed assembly cleanup while
        // draining nova.shutdown, then exiting with the desktop entry's code 2.
        const failCleanup = () => {
          diagnostic.push('[runtime-diagnostic] assembly_failed')
          spawned.emit('exit', 2)
        }
        spawned.postMessage = message => {
          assert.deepEqual(message, {type: 'nova.shutdown'})
          failCleanup()
        }
        spawned.failCleanup = failCleanup
        spawned.once('exit', () => onExit(diagnostic.failure()))
        return {backend: spawned, connection: {endpoint: 'ws://127.0.0.1:10/'}}
      },
      stopBackend: backend => shutdownBackend(backend),
      schedule: (callback, delay) => {
        const timer = {callback, delay}
        scheduled.push(timer)
        return timer
      },
      cancel: () => {},
      onStatus: () => {},
    })
    try {
      await supervisor.start()
      if (mode === 'unexpected') child.failCleanup()
      else await supervisor[mode]()
      assert.equal(scheduled.length, mode === 'unexpected' ? 1 : 0, mode)
      assert.equal(starts, mode === 'restart' ? 2 : 1, mode)
      assert.equal(supervisor.status().state,
        mode === 'unexpected' ? 'reconnecting' : mode === 'stop' ? 'stopped' : 'connected', mode)
    } finally {
      await supervisor.stop()
    }
  }
})

test('private requests correlate, reject on close, and ignore late status', async () => {
  const child = new EventEmitter(), sent = [], statuses = []
  child.postMessage = value => sent.push(value)
  const control = createBackendControl(child, {onStatus: status => statuses.push(status)})
  const request = control.request('capabilities.status', {})
  child.emit('message', {type: 'nova.control.reply', id: sent[0].id, result: {ok: true}})
  assert.deepEqual(await request, {ok: true})
  const pending = control.request('knowledge.reindex', {})
  control.close()
  await assert.rejects(pending, /unavailable/)
  child.emit('message', {type: 'nova.capabilities', status: {toolCount: 8, toolBudget: 24}})
  assert.equal(statuses.length, 0)
  assert.equal(child.listenerCount('message'), 0)
})

test('private status projects only safe public fields and bounded exact counts', async () => {
  const {publicRuntimeCapabilityStatus} = await import('../src/main/backend-supervisor.mjs')
  const projected = publicRuntimeCapabilityStatus({state: 'startup_failed', toolCount: 27, toolBudget: 24,
    modules: {search: {enabled: true, provider: 'mcp', mcp: {headers: {authorization: 'private-secret'}}}}, registry: 'private-secret',
    servers: [{name: 'docs', status: 'failed', reason: 'discovery_failed', config: 'private-secret', codex: {status: 'failed', reason: 'codex_timeout_unrepresentable'}}]})
  assert.equal(projected.toolCount, 27)
  assert.equal(projected.toolBudget, 24)
  assert.equal(projected.state, 'startup_failed')
  assert.ok(!JSON.stringify(projected).includes('private-secret'))
  assert.equal(publicRuntimeCapabilityStatus({toolCount: -1, toolBudget: 24}), null)
})

test('first-run status keeps only known pipeline, blocking key names and missing-environment reasons', async () => {
  const {publicRuntimeCapabilityStatus} = await import('../src/main/backend-supervisor.mjs')
  const failed = publicRuntimeCapabilityStatus({state: 'startup_failed', toolCount: null, toolBudget: 24,
    reason: 'configuration_required', pipeline: 'cascaded', missing: ['DEEPSEEK_API_KEY', 'sk-private-secret', 'DOUBAO_BIGMODEL_API_KEY']})
  assert.equal(failed.reason, 'configuration_required')
  assert.equal(failed.pipeline, 'cascaded')
  assert.deepEqual(failed.missing, ['DEEPSEEK_API_KEY', 'DOUBAO_BIGMODEL_API_KEY'])
  const odd = publicRuntimeCapabilityStatus({state: 'startup_failed', toolCount: null, toolBudget: 24, reason: 'configuration_required', pipeline: 'private-secret', missing: 'DASHSCOPE_API_KEY'})
  assert.equal(odd.pipeline, undefined)
  assert.deepEqual(odd.missing, [])
  // A compiled runtime never carries a blocking reason.
  assert.equal(publicRuntimeCapabilityStatus({toolCount: 3, toolBudget: 24, reason: 'configuration_required', missing: ['DASHSCOPE_API_KEY']}).reason, undefined)
  const degraded = publicRuntimeCapabilityStatus({toolCount: 3, toolBudget: 24, overrides: ['CODING_MODULE_ENABLED', 'PRIVATE'], modules: {
    search: {enabled: true, provider: 'mcp', fallback: 'bailian_mcp', reason: 'missing_environment:TAVILY_API_KEY'},
    camera: {enabled: false, reason: 'missing_environment:DASHSCOPE_API_KEY'},
    coding: {enabled: false, reason: 'private-secret'},
  }})
  assert.deepEqual(degraded.modules.search, {enabled: true, reason: 'missing_environment:TAVILY_API_KEY', fallback: 'bailian_mcp', provider: 'mcp'})
  assert.deepEqual(degraded.modules.camera, {enabled: false, reason: 'missing_environment:DASHSCOPE_API_KEY'})
  assert.deepEqual(degraded.modules.coding, {enabled: false})
  assert.deepEqual(degraded.overrides, ['CODING_MODULE_ENABLED'])
})

test('usage stays private, validates numbers and ignores closed children', () => {
  const child = new EventEmitter(), received = []
  const control = createBackendControl(child, {onUsage: report => received.push(report)})
  const report = {id:'request-1',provider:'qwen',service:'llm',model:'qwen-flash',status:'complete',inputTokens:10,secret:'private'}
  child.emit('message',{type:'nova.usage',report:{...report,inputTokens:Infinity}})
  child.emit('message',{type:'nova.usage',report})
  assert.equal(received.length,1)
  assert.equal(received[0].secret,undefined)
  control.close()
  child.emit('message',{type:'nova.usage',report})
  assert.equal(received.length,1)
})

test('backend classifier maps only stable public failure classes', () => {
  assert.deepEqual(classifyBackendFailure('manual_path_required'), {
    kind: 'configuration_required', code: 'manual_path_required',
  })
  assert.deepEqual(classifyBackendFailure('authentication_failed'), {
    kind: 'authentication_failed', code: 'authentication_failed',
  })
  assert.deepEqual(classifyBackendFailure('codex_unavailable'), {
    kind: 'unavailable', code: 'codex_unavailable',
  })
  assert.deepEqual(classifyBackendFailure('private exception text'), {
    kind: 'recoverable', code: 'backend_disconnected',
  })
})

test('collector accepts split stable diagnostics and never returns raw stderr', () => {
  const collector = createBackendDiagnosticCollector()
  collector.push('secret=https://user:pass@example.invalid\n[runtime-dia')
  collector.push('gnostic] authentication_failed\nprivate stack')
  assert.equal(collector.code(), 'authentication_failed')
  assert.deepEqual(collector.failure(), {
    kind: 'authentication_failed', code: 'authentication_failed',
  })
  assert.equal(JSON.stringify(collector.failure()).includes('secret'), false)
})

test('collector surfaces safe Codex detail but does not promote it to a startup failure class', () => {
  const collector = createBackendDiagnosticCollector()
  assert.equal(
    collector.push('[runtime-diagnostic] codex_login_status_nonzero\nprivate command output'),
    'codex_login_status_nonzero',
  )
  assert.equal(collector.code(), 'codex_login_status_nonzero')
  assert.deepEqual(collector.failure(), {
    kind: 'recoverable', code: 'backend_disconnected',
  })
  assert.equal(JSON.stringify(collector.failure()).includes('private'), false)
})

test('runtime startup errors are echoed for the terminal but never become a failure code', () => {
  const chunk = 'noise\n[runtime-startup-error] Error: EBUSY: resource busy\n[runtime-diagnostic] assembly_failed\n'
  assert.deepEqual(startupErrors(chunk), ['[runtime-startup-error] Error: EBUSY: resource busy'])
  assert.deepEqual(startupErrors('[runtime-diagnostic] assembly_failed\n'), [])
  assert.deepEqual(startupErrors(`[runtime-startup-error] ${'x'.repeat(400)}\n`).map(line => line.length), [320])
  const diagnostic = createBackendDiagnosticCollector()
  assert.equal(diagnostic.push('[runtime-startup-error] Error: EBUSY\n'), null)
  assert.equal(diagnostic.push(chunk), 'assembly_failed')
})

test('runtime config warnings are echoed line by line and never become a failure code', () => {
  const chunk = 'noise\n[config-warning] SURROGATE_MODEL is no longer read; rename it to SUPPORT_MODEL\nmore\n'
  assert.deepEqual(configWarnings(chunk), ['[config-warning] SURROGATE_MODEL is no longer read; rename it to SUPPORT_MODEL'])
  assert.deepEqual(configWarnings('[runtime-diagnostic] assembly_failed\n'), [])
  const diagnostic = createBackendDiagnosticCollector()
  assert.equal(diagnostic.push(chunk), null)
})
