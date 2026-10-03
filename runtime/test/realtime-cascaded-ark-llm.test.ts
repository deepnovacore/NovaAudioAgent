import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ArkCascadedLlmFailure,
  createArkCascadedLlmFactory,
  createArkCascadedLlmSession,
  responsesToolSchema,
} from '../src/realtime/cascaded/ark-llm.js'
import type { CascadedLlmEvent } from '../src/realtime/cascaded/llm.js'
import type { JsonObject } from '../src/realtime/protocol.js'

async function collect(stream: AsyncIterable<CascadedLlmEvent>): Promise<CascadedLlmEvent[]> {
  const events: CascadedLlmEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

function sse(...events: readonly Record<string, unknown>[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: {'content-type': 'text/event-stream'},
  })
}

test('Ark narration isolates the fact from prior user requests and preserves conversation on return', async () => {
  const requests: Record<string, unknown>[] = []
  const session = createArkCascadedLlmSession({
    async *stream(input) {
      await Promise.resolve()
      requests.push(input as unknown as Record<string, unknown>)
      const response_id = `r${requests.length}`
      yield {kind: 'response_started', response_id}
      yield {kind: 'text_delta', response_id, text: '回答'}
      yield {kind: 'response_completed', response_id}
    },
    close: () => Promise.resolve(),
  })
  const signal = new AbortController().signal
  await collect(session.stream({inputs: [{kind: 'user_text', text: '之前的用户请求'}], tools: [], signal}))
  await collect(session.stream({inputs: [{kind: 'host_activation', content: '授权尚未确认，请问你同意还是拒绝？'}], tools: [], signal}))
  assert.equal(requests[1]?.previousResponseId, null)
  assert.deepEqual(JSON.parse((requests[1]?.inputItems as {content: string}[])[0]!.content),
    {text_to_say: '授权尚未确认，请问你同意还是拒绝？'})
  assert.match(String(requests[1]?.responseAdaptation), /不代用户同意/u)
  await collect(session.stream({inputs: [{kind: 'user_text', text: '继续'}], tools: [], signal}))
  assert.match(JSON.stringify(requests[2]?.inputItems), /之前的用户请求/u)
  await session.close()
})

test('Ark semantic tool translation validates identifiers and copies public fields', () => {
  const parameters = {type: 'object', properties: {city: {type: 'string'}}}
  const translated = responsesToolSchema({
    type: 'function',
    function: {name: 'weather__get', description: 'weather lookup', parameters, strict: true},
    private_field: 'must-not-cross',
  })
  assert.deepEqual(translated, {
    type: 'function', name: 'weather__get', description: 'weather lookup', parameters,
  })
  parameters.properties.city.type = 'number'
  assert.equal((((translated.parameters as JsonObject).properties as JsonObject).city as JsonObject).type,
    'string')
  assert.throws(() => responsesToolSchema({
    type: 'function', function: {name: '\u001c\u0085', parameters: {}},
  }), (error: unknown) => error instanceof ArkCascadedLlmFailure && error.code === 'protocol')
  assert.throws(() => responsesToolSchema({
    type: 'function', function: {name: 'x', parameters: []},
  }), (error: unknown) => error instanceof ArkCascadedLlmFailure && error.code === 'protocol')
})

test('Ark maps common inputs and tools, returns common events, and keeps chaining private', async () => {
  const requests: Record<string, unknown>[] = []
  const responses = [
    sse(
      {type: 'response.created', response: {id: 'ark-response-1'}},
      {type: 'response.output_text.delta', delta: '晴'},
      {type: 'response.completed', response: {id: 'ark-response-1'}},
    ),
    sse(
      {type: 'response.created', response: {id: 'ark-response-2'}},
      {type: 'response.completed', response: {id: 'ark-response-2'}},
    ),
  ]
  const fetchImpl: typeof fetch = (_url, init) => {
    requests.push(JSON.parse(init?.body as string) as Record<string, unknown>)
    return Promise.resolve(responses.shift()!)
  }
  const session = createArkCascadedLlmFactory({
    baseUrl: 'https://ark.example/api/v3', apiKey: 'ark-secret', model: 'ark-model',
    instructions: 'instructions', fetchImpl,
  }).open()

  const first = await collect(session.stream({
    inputs: [
      {kind: 'user_text', text: '天气'},
      {kind: 'host_context', content: '用户在上海'},
      {kind: 'packed_history', content: '上一轮问天气'},
      {kind: 'tool_result', call_id: 'weather-call', output: {temperature: 20}},
    ],
    tools: [{name: 'weather__get', description: 'weather lookup', parameters: {type: 'object'}}],
    signal: new AbortController().signal,
  }))
  assert.deepEqual(first, [
    {kind: 'response_started', response_id: 'ark-response-1'},
    {kind: 'text_delta', text: '晴'},
    {kind: 'response_completed', response_id: 'ark-response-1'},
  ])
  assert.deepEqual(requests[0]?.input, [
    {role: 'user', content: '天气'},
    {role: 'system', content: '用户在上海'},
    {role: 'system', content: '上一轮问天气'},
    {type: 'function_call_output', call_id: 'weather-call', output: '{"temperature":20}'},
  ])
  assert.deepEqual(requests[0]?.tools, [{
    type: 'function', name: 'weather__get', description: 'weather lookup', parameters: {type: 'object'},
  }])
  assert.equal('previous_response_id' in requests[0], false)

  await collect(session.stream({
    inputs: [{kind: 'user_text', text: '继续'}], tools: [], signal: new AbortController().signal,
  }))
  assert.equal(requests[1]?.previous_response_id, 'ark-response-1')
  await session.close()
})

test('Ark abandons only an unfinished tool continuation before an unrelated response', async () => {
  const requests: Record<string, unknown>[] = []
  const responses = [
    sse(
      {type: 'response.created', response: {id: 'ark-text-1'}},
      {type: 'response.output_text.delta', delta: '先前答案'},
      {type: 'response.completed', response: {id: 'ark-text-1'}},
    ),
    sse(
      {type: 'response.created', response: {id: 'ark-tool-2'}},
      {type: 'response.output_item.done', item: {
        type: 'function_call', id: 'item-2', call_id: 'call-2', name: 'weather', arguments: '{}',
      }},
      {type: 'response.completed', response: {id: 'ark-tool-2'}},
    ),
    sse(
      {type: 'response.created', response: {id: 'ark-unrelated-3'}},
      {type: 'response.completed', response: {id: 'ark-unrelated-3'}},
    ),
  ]
  const session = createArkCascadedLlmFactory({
    baseUrl: 'https://ark.example/api/v3', apiKey: 'ark-secret', model: 'ark-model',
    instructions: 'instructions',
    fetchImpl: (_url, init) => {
      requests.push(JSON.parse(init?.body as string) as Record<string, unknown>)
      return Promise.resolve(responses.shift()!)
    },
  }).open()

  await collect(session.stream({inputs: [{kind: 'user_text', text: 'first'}], tools: [],
    signal: new AbortController().signal}))
  await session.abandonPendingResponse()
  await collect(session.stream({inputs: [{kind: 'user_text', text: 'needs tool'}], tools: [],
    signal: new AbortController().signal}))
  await session.abandonPendingResponse()
  await collect(session.stream({inputs: [{kind: 'user_text', text: 'unrelated'}], tools: [],
    signal: new AbortController().signal}))

  assert.equal(requests[1]?.previous_response_id, 'ark-text-1')
  assert.equal('previous_response_id' in requests[2]!, false)
  await session.close()
})

test('Ark does not commit a tool continuation before its consumer resumes past the tool event',
  async () => {
    const requests: Record<string, unknown>[] = []
    const responses = [
      sse(
        {type: 'response.created', response: {id: 'ark-completed-history'}},
        {type: 'response.completed', response: {id: 'ark-completed-history'}},
      ),
      sse(
        {type: 'response.created', response: {id: 'ark-unaccepted-tool'}},
        {type: 'response.output_item.done', item: {
          type: 'function_call', id: 'item-unaccepted', call_id: 'call-unaccepted',
          name: 'weather', arguments: '{}',
        }},
        {type: 'response.completed', response: {id: 'ark-unaccepted-tool'}},
      ),
      sse(
        {type: 'response.created', response: {id: 'ark-after-cancel'}},
        {type: 'response.completed', response: {id: 'ark-after-cancel'}},
      ),
    ]
    const session = createArkCascadedLlmFactory({
      baseUrl: 'https://ark.example/api/v3', apiKey: 'ark-secret', model: 'ark-model',
      instructions: 'instructions',
      fetchImpl: (_url, init) => {
        requests.push(JSON.parse(init?.body as string) as Record<string, unknown>)
        return Promise.resolve(responses.shift()!)
      },
    }).open()
    const request = (text: string) => session.stream({
      inputs: [{kind: 'user_text', text}], tools: [], signal: new AbortController().signal,
    })

    await collect(request('completed history'))
    const interrupted = request('tool response')[Symbol.asyncIterator]()
    assert.deepEqual(await interrupted.next(), {
      done: false, value: {kind: 'response_started', response_id: 'ark-unaccepted-tool'},
    })
    assert.deepEqual(await interrupted.next(), {
      done: false, value: {
        kind: 'tool_call', item_id: 'item-unaccepted', call_id: 'call-unaccepted',
        name: 'weather', arguments: {},
      },
    })
    await interrupted.return?.()
    await collect(request('after cancellation'))

    assert.equal(requests[1]?.previous_response_id, 'ark-completed-history')
    assert.equal(requests[2]?.previous_response_id, 'ark-completed-history')
    await session.close()
  })

test('Ark clears private chaining after a protocol failure and exposes only a safe common failure', async () => {
  const requests: Record<string, unknown>[] = []
  const responses = [
    sse(
      {type: 'response.created', response: {id: 'ark-response-1'}},
      {type: 'response.completed', response: {id: 'ark-response-1'}},
    ),
    sse(
      {type: 'response.created', response: {id: 'ark-response-2'}},
      {type: 'response.output_item.done', item: {
        type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'tool',
        arguments: '{"provider-argument-secret":',
      }},
    ),
    sse(
      {type: 'response.created', response: {id: 'ark-response-3'}},
      {type: 'response.completed', response: {id: 'ark-response-3'}},
    ),
  ]
  const fetchImpl: typeof fetch = (_url, init) => {
    requests.push(JSON.parse(init?.body as string) as Record<string, unknown>)
    return Promise.resolve(responses.shift()!)
  }
  const session = createArkCascadedLlmFactory({
    baseUrl: 'https://ark.example/api/v3', apiKey: 'ark-secret', model: 'ark-model',
    instructions: 'instructions', fetchImpl,
  }).open()
  const request = (text: string) => session.stream({
    inputs: [{kind: 'user_text', text}], tools: [], signal: new AbortController().signal,
  })

  await collect(request('first'))
  const failed = await collect(request('second'))
  assert.deepEqual(failed, [
    {kind: 'response_started', response_id: 'ark-response-2'},
    {kind: 'response_failed', response_id: 'ark-response-2', code: 'protocol'},
  ])
  assert.doesNotMatch(JSON.stringify(failed), /ark-secret|provider-argument-secret|instructions/u)
  await collect(request('third'))
  assert.equal('previous_response_id' in requests[1]!, true)
  assert.equal('previous_response_id' in requests[2]!, false)

  await session.close()
  await assert.rejects(collect(request('after-close')),
    (error: unknown) => error instanceof ArkCascadedLlmFailure && error.code === 'closed')
  assert.equal(requests.length, 3)
})

test('Ark semantic sessions reject both mixed text and tool orders without forwarding the conflict',
  async () => {
    const scenarios = [
      {
        name: 'text then tool',
        events: [
          {type: 'response.created', response: {id: 'ark-mixed-text-tool'}},
          {type: 'response.output_text.delta', delta: 'private text'},
          {type: 'response.output_item.done', item: {
            type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'private_tool',
            arguments: '{"private":"argument"}',
          }},
          {type: 'response.completed', response: {id: 'ark-mixed-text-tool'}},
        ],
        responseId: 'ark-mixed-text-tool',
        visibleKind: 'text_delta',
        forbiddenKind: 'tool_call',
      },
      {
        name: 'tool then text',
        events: [
          {type: 'response.created', response: {id: 'ark-mixed-tool-text'}},
          {type: 'response.output_item.done', item: {
            type: 'function_call', id: 'item-2', call_id: 'call-2', name: 'private_tool',
            arguments: '{"private":"argument"}',
          }},
          {type: 'response.output_text.delta', delta: 'private text'},
          {type: 'response.completed', response: {id: 'ark-mixed-tool-text'}},
        ],
        responseId: 'ark-mixed-tool-text',
        visibleKind: null,
        forbiddenKind: 'tool_call',
      },
    ] as const

    for (const scenario of scenarios) {
      const session = createArkCascadedLlmFactory({
        baseUrl: 'https://ark.example/api/v3', apiKey: 'ark-secret', model: 'ark-model',
        instructions: 'instructions', fetchImpl: () => Promise.resolve(sse(...scenario.events)),
      }).open()
      const events = await collect(session.stream({
        inputs: [{kind: 'user_text', text: 'prompt secret'}], tools: [],
        signal: new AbortController().signal,
      }))
      assert.deepEqual(events.at(-1), {
        kind: 'response_failed', response_id: scenario.responseId, code: 'protocol',
      }, scenario.name)
      assert.equal(events.some(event => event.kind === scenario.forbiddenKind), false, scenario.name)
      if (scenario.visibleKind !== null) {
        assert.equal(events.some(event => event.kind === scenario.visibleKind), true, scenario.name)
      } else {
        assert.equal(events.some(event => event.kind === 'text_delta'), false, scenario.name)
      }
      assert.doesNotMatch(JSON.stringify(events), /private_tool|argument|ark-secret|prompt secret/u)
      await session.close()
    }
  })

test('Ark original-image turn chains tools but the next turn uses text-only local history', async () => {
  const requests: Record<string, unknown>[] = []
  let call = 0
  const llm = createArkCascadedLlmFactory({baseUrl:'https://example.test/api/v3',apiKey:'test',model:'doubao-seed-2-0-pro-260215',instructions:'test',
    fetchImpl: (_url, init) => {
      requests.push(JSON.parse(init?.body as string) as Record<string, unknown>)
      call++
      return Promise.resolve(sse(
        {type:'response.created',response:{id:`r-${call}`}},
        ...(call === 1 ? [{type:'response.output_item.done',item:{type:'function_call',id:'item-1',call_id:'call-1',name:'lookup',arguments:'{}'}}] : [{type:'response.output_text.delta',delta:'done'}]),
        {type:'response.completed',response:{id:`r-${call}`}},
      ))
    }}).open()
  const signal = new AbortController().signal, tools = [{name:'lookup',parameters:{type:'object'}}]
  const image = {payload:new Uint8Array([255,216,255,217]),media_type:'image/jpeg',width:1280,height:720,captured_at:1}
  await collect(llm.stream({inputs:[{kind:'user_text',text:'look',image}],tools,signal}))
  await collect(llm.stream({inputs:[{kind:'tool_result',call_id:'call-1',output:{ok:true}}],tools,signal}))
  await collect(llm.stream({inputs:[{kind:'user_text',text:'next'}],tools,signal}))
  assert.match(JSON.stringify(requests[0]), /input_image.*data:image\/jpeg;base64/u)
  assert.equal(requests[1]?.previous_response_id, 'r-1')
  assert.equal(requests[2]?.previous_response_id, undefined)
  assert.doesNotMatch(JSON.stringify(requests[2]), /input_image|data:image/u)
  assert.match(JSON.stringify(requests[2]), /function_call_output/u)
  await llm.close()
})

test('Ark fresh seed uses independent committed history without provider continuation ids', async () => {
  const requests:Record<string,unknown>[]=[]
  const factory=createArkCascadedLlmFactory({baseUrl:'https://example.invalid',apiKey:'test',model:'test',instructions:'system',fetchImpl:(_url,init)=>{
    requests.push(JSON.parse(init?.body as string) as Record<string,unknown>)
    return Promise.resolve(sse({type:'response.created',response:{id:'r'}},{type:'response.output_text.delta',delta:'answer'},{type:'response.completed',response:{id:'r'}}))
  }})
  const session=factory.open({history:[{user:'old user',assistant:'old answer'}]}),signal=new AbortController().signal
  try {
    await collect(session.stream({inputs:[{kind:'user_text',text:'new question'}],tools:[],signal}))
    assert.deepEqual(requests[0]?.input,[{role:'user',content:'old user'},{role:'assistant',content:'old answer'},{role:'user',content:'new question'}])
    assert.equal(requests[0]?.previous_response_id,undefined)
    assert(typeof session.restoreHistory==='function')
    await assert.rejects(session.restoreHistory([{user:'replace',assistant:'bad'}],signal))
  }finally{await session.close()}
})
