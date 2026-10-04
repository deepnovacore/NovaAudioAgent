import assert from 'node:assert/strict'
import {test} from 'node:test'
import {loadSettings, requireIntegratedRealtime, describeMissingBlockingCredentials} from '../src/config/config.js'
import {requireSelectedCascadedLlmConfig} from '../src/config/cascaded-realtime-config.js'
import {createQwenCascadedLlmFactory} from '../src/realtime/cascaded/qwen-llm.js'
import {reportUsage} from '../src/realtime/usage.js'

for (const provider of ['openai', 'gemini'] as const) {
  const keyName = `${provider.toUpperCase()}_API_KEY`
  test(`${provider} selected credentials never fall back to DashScope or generic keys`, () => {
    const environment = {INTEGRATED_PROVIDER: provider, DASHSCOPE_API_KEY: 'wrong', MODEL_API_KEY: 'wrong'}
    const missing = loadSettings(environment)
    assert.deepEqual(describeMissingBlockingCredentials(missing).missing, [keyName])
    assert.throws(() => requireIntegratedRealtime(missing), new RegExp(keyName))
    const selected = requireIntegratedRealtime(loadSettings({...environment, [keyName]: 'selected'}))
    assert.equal(selected.apiKey, 'selected')
    assert.equal(selected.model, provider === 'openai' ? 'gpt-realtime-2.1-mini' : 'gemini-3.8-live')
  })
  test(`${provider} cascaded text requires no speech credentials and selects its own endpoint`, () => {
    const selected = requireSelectedCascadedLlmConfig(loadSettings({PIPELINE_MODE: 'cascaded', CASCADE_LLM_PROVIDER: provider, [keyName]: 'selected'}))
    assert.equal(selected.provider, provider)
    assert.equal(selected.config.apiKey, 'selected')
    assert.match(selected.config.baseUrl, provider === 'openai' ? /api.openai.com/ : /generativelanguage.googleapis.com/)
  })
  test(`${provider} streamed chat request omits domestic vendor parameters`, async () => {
    let body: Record<string, unknown> = {}
    const session = createQwenCascadedLlmFactory({provider, baseUrl: 'https://example.test/v1', apiKey: 'synthetic', model: 'test', instructions: 'test', fetchImpl: (_url, init) => {
      assert.equal(typeof init?.body,'string')
      body = JSON.parse(init?.body as string) as Record<string,unknown>
      return Promise.resolve(new Response('data: {"id":"r","choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {headers: {'content-type':'text/event-stream'}}))
    }}).open()
    for await (const _event of session.stream({inputs:[{kind:'user_text',text:'hello'}], tools:[], signal:new AbortController().signal})) { void _event }
    assert.equal(body.enable_thinking, undefined)
    assert.equal(body.thinking, undefined)
    assert.equal(body.reasoning_effort, provider === 'openai' ? 'none' : undefined)
    await session.close()
  })
  test(`${provider} usage is delivered without pretending to know its price region`, () => {
    const reports: unknown[] = []
    reportUsage(report => reports.push(report), {id:'r', provider, service:'llm', model:'test', status:'complete',inputTokens:1,outputTokens:1})
    assert.equal(reports.length, 1)
  })
}

test('Gemini tool thought signatures survive the complete tool-result round trip', async()=>{
 const requests:{parallel_tool_calls?:boolean;messages:{tool_calls?:{extra_content?:unknown}[]}[]}[]=[]
 const session=createQwenCascadedLlmFactory({provider:'gemini',baseUrl:'https://example.test',apiKey:'synthetic',model:'gemini-3.5-flash-lite',instructions:'test',fetchImpl:(_url,init)=>{
  assert.equal(typeof init?.body,'string')
  requests.push(JSON.parse(init?.body as string) as typeof requests[number])
  const chunk=requests.length===1?{id:'r1',choices:[{delta:{tool_calls:[{index:0,id:'call',type:'function',extra_content:{google:{thought_signature:'opaque-signature'}},function:{name:'dispatch',arguments:'{}'}}]},finish_reason:'tool_calls'}]}:{id:'r2',choices:[{delta:{content:'Done'},finish_reason:'stop'}]}
  return Promise.resolve(new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}}))
 }}).open()
 const signal=new AbortController().signal
 for await(const _ of session.stream({inputs:[{kind:'user_text',text:'do it'}],tools:[{name:'dispatch',parameters:{type:'object'}}],signal})){void _}
 for await(const _ of session.stream({inputs:[{kind:'tool_result',call_id:'call',output:{ok:true}}],tools:[],signal})){void _}
 assert.deepEqual(requests[1]!.messages.find(m=>m.tool_calls)?.tool_calls?.[0]?.extra_content,{google:{thought_signature:'opaque-signature'}})
 assert.equal(requests[0]!.parallel_tool_calls,undefined)
 await session.close()
})
