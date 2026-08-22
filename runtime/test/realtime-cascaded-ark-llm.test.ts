import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ArkCascadedLlmFailure,
  createArkCascadedLlmFactory,
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
    {role: 'user', content: '用户在上海'},
    {role: 'user', content: '上一轮问天气'},
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
