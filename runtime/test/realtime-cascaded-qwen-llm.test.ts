import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createQwenCascadedLlmFactory,
  MAX_CASCADED_LLM_HISTORY_CODEPOINTS,
  MAX_CASCADED_LLM_HISTORY_ITEMS,
  QwenCascadedLlmFailure,
} from '../src/realtime/cascaded/qwen-llm.js'
import type {
  CascadedLlmEvent,
  CascadedLlmSession,
} from '../src/realtime/cascaded/llm.js'

interface Capture {
  url?: string
  init?: RequestInit
}

async function collect(stream: AsyncIterable<CascadedLlmEvent>): Promise<CascadedLlmEvent[]> {
  const events: CascadedLlmEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

function session(capture: Capture): CascadedLlmSession {
  const fetchImpl: typeof fetch = (url, init) => {
    capture.url = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    if (init !== undefined) capture.init = init
    return Promise.resolve(new Response([
      'data: {"id":"provider-response-1","choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\n',
      'data: [DONE]\n\n',
    ].join(''), {headers: {'content-type': 'text/event-stream'}}))
  }
  return createQwenCascadedLlmFactory({
    baseUrl: 'https://dashscope.example/compatible-mode/v1',
    apiKey: 'dash-secret',
    model: 'qwen-flash',
    instructions: 'system instructions',
    fetchImpl,
    idFactory: () => 'host-response-1',
  }).open()
}

test('Qwen Chat Completions request and text SSE stream use the semantic contract', async () => {
  const capture: Capture = {}
  const events = await collect(session(capture).stream({
    inputs: [{kind: 'user_text', text: '你好'}],
    tools: [],
    signal: new AbortController().signal,
  }))

  assert.deepEqual(events, [
    {kind: 'response_started', response_id: 'provider-response-1'},
    {kind: 'text_delta', text: '你'},
    {kind: 'text_delta', text: '好'},
    {kind: 'response_completed', response_id: 'provider-response-1'},
  ])
  assert.equal(capture.url, 'https://dashscope.example/compatible-mode/v1/chat/completions')
  assert.deepEqual(capture.init?.headers, {
    authorization: 'Bearer dash-secret',
    'content-type': 'application/json',
    accept: 'text/event-stream',
  })
  const body = capture.init?.body as string
  assert.deepEqual(JSON.parse(body), {
    model: 'qwen-flash',
    messages: [
      {role: 'system', content: 'system instructions'},
      {role: 'user', content: '你好'},
    ],
    stream: true,
    stream_options: {include_usage: true},
  })
  assert.doesNotMatch(body, /dash-secret/u)
})

function sse(events: readonly Record<string, unknown>[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
    + 'data: [DONE]\n\n', {headers: {'content-type': 'text/event-stream'}})
}

test('Qwen joins fragmented tool calls and retains a matched tool result with its assistant call', async () => {
  const requests: Record<string, unknown>[] = []
  const responses = [
    sse([
      {id: 'provider-tool-1', choices: [{delta: {tool_calls: [
        {index: 0, id: 'call-1', type: 'function', function: {name: 'search__', arguments: '{"q":"'}},
      ]}}]},
      {choices: [{delta: {tool_calls: [
        {index: 0, function: {name: 'query', arguments: 'weather"}'}},
      ]}, finish_reason: 'tool_calls'}]},
    ]),
    sse([
      {id: 'provider-text-2', choices: [{delta: {content: '晴'}, finish_reason: 'stop'}]},
    ]),
  ]
  const session = createQwenCascadedLlmFactory({
    baseUrl: 'https://dashscope.example/v1', apiKey: 'dash-secret', model: 'qwen-flash',
    instructions: 'instructions',
    fetchImpl: (_url, init) => {
      requests.push(JSON.parse(init?.body as string) as Record<string, unknown>)
      return Promise.resolve(responses.shift()!)
    },
  }).open()
  const tools = [{name: 'search__query', description: 'search', parameters: {type: 'object'}}] as const
  const toolEvents = await collect(session.stream({
    inputs: [{kind: 'user_text', text: '天气'}], tools, signal: new AbortController().signal,
  }))
  assert.deepEqual(toolEvents.at(-2), {
    kind: 'tool_call', item_id: 'call-1', call_id: 'call-1',
    name: 'search__query', arguments: {q: 'weather'},
  })
  const answer = await collect(session.stream({
    inputs: [{kind: 'tool_result', call_id: 'call-1', output: {temperature: 20}}],
    tools, signal: new AbortController().signal,
  }))
  assert.equal(answer.at(-1)?.kind, 'response_completed')
  const messages = requests[1]?.messages as Record<string, unknown>[]
  assert.ok(messages.some(message => {
    const calls = message.tool_calls
    return message.role === 'assistant' && Array.isArray(calls)
      && calls[0] !== undefined && typeof calls[0] === 'object' && calls[0] !== null
      && (calls[0] as Record<string, unknown>).id === 'call-1'
  }))
  assert.ok(messages.some(message => message.role === 'tool' && message.tool_call_id === 'call-1'))
})

test('Qwen rejects mixed text/tool output, malformed arguments, and mismatched tool results', async () => {
  const invalidResponse = (event: Record<string, unknown>): CascadedLlmSession => createQwenCascadedLlmFactory({
    baseUrl: 'https://dashscope.example/v1', apiKey: 'dash-secret', model: 'qwen-flash',
    instructions: 'instructions', fetchImpl: () => Promise.resolve(sse([event])),
  }).open()
  const request = {inputs: [{kind: 'user_text', text: 'hello'}] as const, tools: [],
    signal: new AbortController().signal}
  await assert.rejects(collect(invalidResponse({id: 'resp', choices: [{
    delta: {content: 'text', tool_calls: [{index: 0, id: 'call', function: {name: 't', arguments: '{}'}}]},
    finish_reason: 'tool_calls',
  }]}).stream(request)))
  await assert.rejects(collect(invalidResponse({id: 'resp', choices: [{
    delta: {tool_calls: [{index: 0, id: 'call', function: {name: 't', arguments: '{'}}]},
    finish_reason: 'tool_calls',
  }]}).stream(request)))

  const session = createQwenCascadedLlmFactory({
    baseUrl: 'https://dashscope.example/v1', apiKey: 'dash-secret', model: 'qwen-flash',
    instructions: 'instructions', fetchImpl: () => Promise.resolve(sse([{id: 'resp', choices: [{
      delta: {tool_calls: [{index: 0, id: 'call-1', function: {name: 't', arguments: '{}'}}]},
      finish_reason: 'tool_calls',
    }]}])),
  }).open()
  await collect(session.stream(request))
  await assert.rejects(collect(session.stream({
    inputs: [{kind: 'tool_result', call_id: 'wrong-call', output: {ok: true}}], tools: [],
    signal: new AbortController().signal,
  })))
})

test('Qwen bounds retained completed interaction units without splitting tool chains', async () => {
  const requests: Record<string, unknown>[] = []
  let sequence = 0
  const session = createQwenCascadedLlmFactory({
    baseUrl: 'https://dashscope.example/v1', apiKey: 'dash-secret', model: 'qwen-flash',
    instructions: 'instructions', fetchImpl: (_url, init) => {
      requests.push(JSON.parse(init?.body as string) as Record<string, unknown>)
      sequence += 1
      return Promise.resolve(sse([{id: `resp-${sequence}`, choices: [{delta: {content: 'ok'},
        finish_reason: 'stop'}]}]))
    },
  }).open()
  for (let index = 0; index < 34; index += 1) {
    await collect(session.stream({inputs: [{kind: 'user_text', text: `turn-${index}`}], tools: [],
      signal: new AbortController().signal}))
  }
  const itemBound = requests.at(-1)?.messages as Record<string, unknown>[]
  assert.ok(itemBound.length - 2 <= MAX_CASCADED_LLM_HISTORY_ITEMS)
  assert.ok(!itemBound.some(message => message.content === 'turn-0'))
  assert.ok(itemBound.some(message => message.content === 'turn-32'))

  const oversized = 'x'.repeat(Math.floor(MAX_CASCADED_LLM_HISTORY_CODEPOINTS / 2) + 100)
  await collect(session.stream({inputs: [{kind: 'user_text', text: oversized}], tools: [],
    signal: new AbortController().signal}))
  await collect(session.stream({inputs: [{kind: 'user_text', text: oversized}], tools: [],
    signal: new AbortController().signal}))
  await collect(session.stream({inputs: [{kind: 'user_text', text: 'limit-trigger'}], tools: [],
    signal: new AbortController().signal}))
  const codePointBound = requests.at(-1)?.messages as Record<string, unknown>[]
  const retained = codePointBound.slice(1, -1).map(message => JSON.stringify(message)).join('')
  assert.ok([...retained].length <= MAX_CASCADED_LLM_HISTORY_CODEPOINTS)
  assert.equal(codePointBound.filter(message => message.content === oversized).length, 1)
})

test('Qwen skips pre-aborted work and close cancels a live SSE reader', async () => {
  let calls = 0
  const preAborted = new AbortController()
  preAborted.abort()
  const stopped = createQwenCascadedLlmFactory({
    baseUrl: 'https://dashscope.example/v1', apiKey: 'dash-secret', model: 'qwen-flash',
    instructions: 'instructions', fetchImpl: () => { calls += 1; return Promise.resolve(sse([])) },
  }).open()
  await assert.rejects(collect(stopped.stream({inputs: [], tools: [], signal: preAborted.signal})),
    (error: unknown) => error instanceof QwenCascadedLlmFailure && error.code === 'aborted')
  assert.equal(calls, 0)

  let cancelled = false
  const active = createQwenCascadedLlmFactory({
    baseUrl: 'https://dashscope.example/v1', apiKey: 'dash-secret', model: 'qwen-flash',
    instructions: 'instructions', closeTimeoutMs: 5,
    fetchImpl: () => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => undefined) },
      cancel() { cancelled = true },
    }), {headers: {'content-type': 'text/event-stream'}})),
  }).open()
  const pending = collect(active.stream({inputs: [], tools: [], signal: new AbortController().signal}))
  const rejection = assert.rejects(pending,
    (error: unknown) => error instanceof QwenCascadedLlmFailure && error.code === 'closed')
  await new Promise<void>(resolve => setImmediate(resolve))
  await active.close()
  await rejection
  assert.equal(cancelled, true)
})
