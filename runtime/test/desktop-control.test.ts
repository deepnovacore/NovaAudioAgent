import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {test} from 'node:test'
import {installDesktopControl, handleFeishuSettings, handlePersonalSettings, connectionsProjection, PERSONAL_SETTINGS_METHODS, desktopBudgetFailure, type DesktopCapabilityState} from '../src/desktop/desktop-control.js'
import {runDesktopEntry} from '../src/desktop/desktop-session.js'
import {buildProductionRealtimeAssembly} from '../src/composition/cascaded-realtime-assembly.js'
import {loadSettings} from '../src/config/config.js'
import {parseCapabilityRegistry} from '../src/config/capability-registry.js'

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
        buildProductionRealtimeAssembly({settings: {...loadSettings({MEMORY_CONNECTION: 'disabled', MODEL_API_KEY: 'fixture', DASHSCOPE_API_KEY: 'fixture', TAVILY_API_KEY: 'fixture'}), executors: []},
          capabilities: parseCapabilityRegistry({version: 1, frontbrainToolBudget: 1, modules: {camera: {enabled: false}, coding: {enabled: false}, search: {enabled: true}}}, {TAVILY_API_KEY: 'fixture'})})
        throw new Error('expected final compilation budget failure')
      },
    })
    assert.equal(result, 2)
    assert.deepEqual(parentPort.sent, [{type: 'nova.capabilities', status: {state: 'startup_failed', toolCount: 3, toolBudget: 1}}])
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

test('private usage frames validate meters and preserve metering tails during shutdown', () => {
  const parentPort = new Parent(), stop = new AbortController()
  const control = installDesktopControl({parentPort, signal: stop.signal, status: () => undefined})
  const report = {id: 'usage-1', provider: 'qwen' as const, service: 'llm' as const, model: 'custom 模型', status: 'complete' as const, inputTokens: 1, outputTokens: 2}
  control.publishUsage(report)
  assert.deepEqual(parentPort.sent, [{type: 'nova.usage', report}])
  control.publishUsage({...report, inputTokens: NaN})
  assert.equal((parentPort.sent[1] as {report: {status: string}}).report.status, 'missing')
  stop.abort()
  control.publishUsage(report)
  assert.equal(parentPort.sent.length, 3)
})


test('settings IM port admits only bounded Feishu methods and unwraps no memory snapshot', async () => {
  const calls: unknown[] = []
  const command = (input: unknown) => {calls.push(input); return Promise.resolve({ok:true,data:{state:'unauthorized'}})}
  assert.deepEqual(await handleFeishuSettings(command,'memory.list',{}),{error:'unsupported'})
  assert.deepEqual(await handleFeishuSettings(command,'feishu.arbitrary',{}),{error:'invalid_request'})
  assert.equal(calls.length,0)
  assert.deepEqual(await handleFeishuSettings(command,'feishu.status',{}),{state:'unauthorized'})
  assert.equal(calls.length,1)
  assert.deepEqual(await handleFeishuSettings(()=>Promise.resolve({ok:false,error:'unavailable'}),'feishu.login',{}),{error:'unavailable'})
})

test('settings connections port admits only sources, connectors and discovery scheduling', async () => {
  const calls: unknown[] = []
  const command = (input: unknown) => {calls.push(input); return Promise.resolve({ok:true,data:{sources:[]}})}
  for (const method of ['memory.list','feed.action','conversations.select','life.mutate','news.refresh','understanding.action','feishu.status'])
    assert.deepEqual(await handlePersonalSettings(command,method,{}),{error:'unsupported'},method)
  assert.deepEqual(await handlePersonalSettings(command,'discovery.configure','enabled'),{error:'invalid_request'})
  assert.equal(calls.length,0)
  assert.deepEqual(await handlePersonalSettings(command,'state',{}),{revision:undefined,sources:[],connectors:null,settings:{},capabilities:{sources:false,discovery:false}})
  assert.equal(calls.length,1)
  const full={revision:7,conversations:{messages:[{text:'SECRET-CONVERSATION'}]},memory:{entries:[{content:'SECRET-MEMORY'}]},feed:[{title:'SECRET-FEED'}],life:{todos:[{title:'SECRET-TODO'}]},news:{items:[]},understanding:{items:[]},feishu:{token:'SECRET'},sources:[{id:'s',path:'/p'}],connectors:{available:true},settings:{discovery_enabled:true,timezone:'Asia/Shanghai'},capabilities:{sources:true,discovery:true,memory:{list:true}}}
  const projected=await handlePersonalSettings(()=>Promise.resolve({ok:true,data:full}),'state',{}) as Record<string,unknown>
  assert.deepEqual(projected,{revision:7,sources:[{id:'s',path:'/p'}],connectors:{available:true},settings:{discovery_enabled:true,timezone:'Asia/Shanghai'},capabilities:{sources:true,discovery:true}})
  assert.ok(!JSON.stringify(projected).includes('SECRET'))
  assert.deepEqual(connectionsProjection(null).sources,[])
  assert.deepEqual(await handlePersonalSettings(()=>Promise.resolve({ok:true}),'discovery.configure',{enabled:false}),{ok:true},'payload-less success is not an error')
  assert.deepEqual(await handlePersonalSettings(()=>Promise.resolve({ok:true}),'sources.authorize_computer',{consent:true}),{ok:true})
  assert.deepEqual(await handlePersonalSettings(()=>Promise.resolve({ok:true}),'sources.consent',{id:'x',consent:false}),{ok:true})
  assert.ok(PERSONAL_SETTINGS_METHODS.every(method => !method.startsWith('feishu.')))
  assert.deepEqual(await handlePersonalSettings(()=>Promise.resolve({ok:false,error:'unavailable'}),'sources.sync',{id:'s'}),{error:'unavailable'})
})
