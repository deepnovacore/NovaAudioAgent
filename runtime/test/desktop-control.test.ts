import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {test} from 'node:test'
import {installDesktopControl, desktopBudgetFailure, type DesktopCapabilityState} from '../src/desktop-control.js'
import {runDesktopEntry} from '../src/desktop-service.js'
import {buildProductionRealtimeAssembly} from '../src/production-realtime-assembly.js'
import {loadSettings} from '../src/config.js'
import {parseCapabilityRegistry} from '../src/capability-registry.js'

class Parent extends EventEmitter {
  readonly sent: unknown[] = []
  postMessage(message: unknown): void {this.sent.push(message)}
}
test('real final compilation failure preserves exact N/B over private startup status without a resource', async () => {
  const parentPort = new Parent(), stop = new AbortController()
  let status: DesktopCapabilityState | undefined
  const control = installDesktopControl({parentPort, signal: stop.signal, status: () => status})
  try {
    const result = await runDesktopEntry({token: 'a'.repeat(32), readyEndpoint: '127.0.0.1:12345', stop,
      announce: () => Promise.reject(new Error('budget failure must precede readiness')), onDiagnostic: () => { /* bounded diagnostics are asserted through the private status instead */ },
      onStartupFailure: error => {status = desktopBudgetFailure(error); control.publish()},
      construct: () => {
        buildProductionRealtimeAssembly({settings: {...loadSettings({NOVA_AUDIO_AGENT_MODEL_API_KEY: 'fixture', DASHSCOPE_API_KEY: 'fixture', TAVILY_API_KEY: 'fixture'}), executors: []},
          capabilities: parseCapabilityRegistry({version: 1, frontbrainToolBudget: 1, modules: {camera: {enabled: false}, coding: {enabled: false}, search: {enabled: true}}}, {TAVILY_API_KEY: 'fixture'})})
        throw new Error('expected final compilation budget failure')
      },
    })
    assert.equal(result, 2)
    assert.deepEqual(parentPort.sent, [{type: 'nova.capabilities', status: {state: 'startup_failed', toolCount: 2, toolBudget: 1}}])
    assert.equal(desktopBudgetFailure({code: 'frontbrain_tool_budget_exceeded', toolCount: Infinity, toolBudget: 24}), undefined)
  } finally {control.dispose(); stop.abort()}
  assert.equal(parentPort.listenerCount('message'), 0)
})
test('private host operations finish before replying and stop removes status and request ownership', async () => {
  const parentPort = new Parent(), stop = new AbortController()
  let finish: ((value: unknown) => void) | undefined
  const control = installDesktopControl({parentPort, signal: stop.signal, status: () => undefined,
    handle: async (method, params) => {
      assert.equal(method, 'knowledge.reindex'); assert.deepEqual(params, {provider: 'local'})
      return new Promise(resolve => {finish = resolve})
    }})
  parentPort.emit('message', {data: {type: 'nova.control.request', id: 'host-1', method: 'knowledge.reindex', params: {provider: 'local'}}})
  assert.deepEqual(parentPort.sent, [])
  finish?.({status: 'complete'})
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(parentPort.sent, [{type: 'nova.control.reply', id: 'host-1', result: {status: 'complete'}}])
  stop.abort()
  parentPort.emit('message', {data: {type: 'nova.control.request', id: 'late', method: 'knowledge.reindex'}})
  assert.equal(parentPort.listenerCount('message'), 0)
  control.dispose()
})
