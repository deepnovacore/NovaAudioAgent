import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createQwenCascadedLlmFactory,
  QwenCascadedLlmFailure,
} from '../src/realtime/cascaded/qwen-llm.js'
import {
  MAX_CASCADED_LLM_HISTORY_CODEPOINTS,
  MAX_CASCADED_LLM_HISTORY_ITEMS,
  type CascadedLlmEvent,
  type CascadedLlmSession,
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

async function settlesWithin<T>(label: string, value: Promise<T>, milliseconds = 150): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      value,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle`)), milliseconds)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
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

test('Qwen completes two sequential tool hops as one bounded semantic interaction', async () => {
  const requests: Record<string, unknown>[] = []
  const responses = [
    sse([{id: 'response-a', choices: [{delta: {tool_calls: [{index: 0, id: 'call-a',
      function: {name: 'lookup_a', arguments: '{}'}}]}, finish_reason: 'tool_calls'}]}]),
    sse([{id: 'response-b', choices: [{delta: {tool_calls: [{index: 0, id: 'call-b',
      function: {name: 'lookup_b', arguments: '{"from":"a"}'}}]}, finish_reason: 'tool_calls'}]}]),
    sse([{id: 'response-final', choices: [{delta: {content: '完成'}, finish_reason: 'stop'}]}]),
  ]
  const session = createQwenCascadedLlmFactory({
    baseUrl: 'https://dashscope.example/v1', apiKey: 'dash-secret', model: 'qwen-flash',
    instructions: 'instructions', fetchImpl: (_url, init) => {
      requests.push(JSON.parse(init?.body as string) as Record<string, unknown>)
      return Promise.resolve(responses.shift()!)
    },
  }).open()
  const tools = [
    {name: 'lookup_a', parameters: {type: 'object'}},
    {name: 'lookup_b', parameters: {type: 'object'}},
  ] as const

  const first = await collect(session.stream({
    inputs: [{kind: 'user_text', text: 'multi-hop'}], tools,
    signal: new AbortController().signal,
  }))
  assert.deepEqual(first.at(-2), {
    kind: 'tool_call', item_id: 'call-a', call_id: 'call-a', name: 'lookup_a', arguments: {},
  })
  const second = await collect(session.stream({
    inputs: [{kind: 'tool_result', call_id: 'call-a', output: {value: 'a'}}], tools,
    signal: new AbortController().signal,
  }))
  assert.deepEqual(second.at(-2), {
    kind: 'tool_call', item_id: 'call-b', call_id: 'call-b', name: 'lookup_b',
    arguments: {from: 'a'},
  })
  const final = await collect(session.stream({
    inputs: [{kind: 'tool_result', call_id: 'call-b', output: {value: 'b'}}], tools,
    signal: new AbortController().signal,
  }))

  assert.deepEqual(final, [
    {kind: 'response_started', response_id: 'response-final'},
    {kind: 'text_delta', text: '完成'},
    {kind: 'response_completed', response_id: 'response-final'},
  ])
  const finalMessages = requests[2]?.messages as Record<string, unknown>[]
  assert.deepEqual(finalMessages.filter(message => message.role === 'tool').map(message =>
    message.tool_call_id), ['call-a', 'call-b'])
  assert.deepEqual(finalMessages.filter(message => Array.isArray(message.tool_calls)).map(message =>
    ((message.tool_calls as readonly {id: string}[])[0]?.id)), ['call-a', 'call-b'])
})

test('Qwen abandons unresolved tool state without discarding completed bounded history', async () => {
  const requests: Record<string, unknown>[] = []
  const responses = [
    sse([{id: 'response-text', choices: [{delta: {content: 'remembered'}, finish_reason: 'stop'}]}]),
    sse([{id: 'response-tool', choices: [{delta: {tool_calls: [{index: 0, id: 'call-abandoned',
      function: {name: 'weather', arguments: '{}'}}]}, finish_reason: 'tool_calls'}]}]),
    sse([{id: 'response-unrelated', choices: [{delta: {content: 'fresh'}, finish_reason: 'stop'}]}]),
  ]
  const session = createQwenCascadedLlmFactory({
    baseUrl: 'https://dashscope.example/v1', apiKey: 'dash-secret', model: 'qwen-flash',
    instructions: 'instructions', fetchImpl: (_url, init) => {
      requests.push(JSON.parse(init?.body as string) as Record<string, unknown>)
      return Promise.resolve(responses.shift()!)
    },
  }).open()
  const run = (text: string) => collect(session.stream({
    inputs: [{kind: 'user_text' as const, text}], tools: [], signal: new AbortController().signal,
  }))

  await run('completed user turn')
  await run('abandoned tool turn')
  await session.abandonPendingResponse()
  await run('unrelated user turn')

  const messages = requests[2]?.messages as Record<string, unknown>[]
  assert.ok(messages.some(item => item.role === 'user' && item.content === 'completed user turn'))
  assert.ok(messages.some(item => item.role === 'assistant' && item.content === 'remembered'))
  assert.ok(messages.some(item => item.role === 'user' && item.content === 'unrelated user turn'))
  assert.equal(messages.some(item => item.content === 'abandoned tool turn'), false)
  assert.equal(messages.some(item => Array.isArray(item.tool_calls)), false)
  await session.close()
})

test('Qwen rejects mixed text/tool output, malformed arguments, and mismatched tool results', async () => {
  const invalidResponse = (event: Record<string, unknown>): CascadedLlmSession => createQwenCascadedLlmFactory({
    baseUrl: 'https://dashscope.example/v1', apiKey: 'dash-secret', model: 'qwen-flash',
    instructions: 'instructions', fetchImpl: () => Promise.resolve(sse([event])),
  }).open()
  const request = {inputs: [{kind: 'user_text', text: 'hello'}] as const, tools: [],
    signal: new AbortController().signal}
  const mixed = await collect(invalidResponse({id: 'resp', choices: [{
    delta: {content: 'text', tool_calls: [{index: 0, id: 'call', function: {name: 't', arguments: '{}'}}]},
    finish_reason: 'tool_calls',
  }]}).stream(request))
  assert.deepEqual(mixed.at(-1), {kind: 'response_failed', response_id: 'resp', code: 'protocol'})
  const malformed = await collect(invalidResponse({id: 'resp', choices: [{
    delta: {tool_calls: [{index: 0, id: 'call', function: {name: 't', arguments: '{'}}]},
    finish_reason: 'tool_calls',
  }]}).stream(request))
  assert.deepEqual(malformed.at(-1), {kind: 'response_failed', response_id: 'resp', code: 'protocol'})

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

test('Qwen rejects nonzero or multiple tool indexes and pins its first response id', async () => {
  const invalid = (calls: readonly Record<string, unknown>[], ids: readonly string[]): CascadedLlmSession => {
    return createQwenCascadedLlmFactory({
      baseUrl: 'https://dashscope.example/v1', apiKey: 'dash-secret', model: 'qwen-flash',
      instructions: 'instructions', fetchImpl: () => Promise.resolve(sse(calls.map((call, index) => ({
        id: ids[index], choices: [call],
      })))),
    }).open()
  }
  const tool = (index: number): Record<string, unknown> => ({
    delta: {tool_calls: [{index, id: `call-${index}`, function: {name: 't', arguments: '{}'}}]},
    finish_reason: 'tool_calls',
  })
  for (const [calls, ids] of [
    [[tool(1)], ['resp']] as const,
    [[{delta: {tool_calls: [
      {index: 0, id: 'call-0', function: {name: 'a', arguments: '{}'}},
      {index: 1, id: 'call-1', function: {name: 'b', arguments: '{}'}},
    ]}, finish_reason: 'tool_calls'}], ['resp']] as const,
    [[{delta: {content: 'x'}}, {delta: {}, finish_reason: 'stop'}], ['resp-1', 'resp-2']] as const,
  ]) {
    const events = await collect(invalid(calls, ids).stream({
      inputs: [{kind: 'user_text', text: 'private prompt'}], tools: [], signal: new AbortController().signal,
    }))
    assert.equal(events[0]?.kind, 'response_started')
    assert.deepEqual(events.at(-1), {kind: 'response_failed', response_id: ids[0], code: 'protocol'})
  }
})

test('Qwen commits tool state before terminal delivery, rejects orphan results, and never splits a pending tool chain', async () => {
  const requests: Record<string, unknown>[] = []
  const responses = [
    sse([{id: 'resp-tool', choices: [{delta: {tool_calls: [{index: 0, id: 'call-1',
      function: {name: 'search', arguments: '{}'}}]}, finish_reason: 'tool_calls'}]}]),
    sse([{id: 'resp-answer', choices: [{delta: {content: 'ok'}, finish_reason: 'stop'}]}]),
  ]
  const session = createQwenCascadedLlmFactory({
    baseUrl: 'https://dashscope.example/v1', apiKey: 'dash-secret', model: 'qwen-flash',
    instructions: 'instructions', fetchImpl: (_url, init) => {
      requests.push(JSON.parse(init?.body as string) as Record<string, unknown>)
      return Promise.resolve(responses.shift()!)
    },
  }).open()
  for await (const event of session.stream({inputs: [{kind: 'user_text', text: 'weather'}], tools: [],
    signal: new AbortController().signal})) {
    if (event.kind === 'response_completed') break
  }
  await collect(session.stream({inputs: [{kind: 'tool_result', call_id: 'call-1', output: {ok: true}}],
    tools: [], signal: new AbortController().signal}))
  const continued = requests[1]?.messages as Record<string, unknown>[]
  assert.ok(continued.some(item => item.role === 'assistant' && Array.isArray(item.tool_calls)))
  assert.ok(continued.some(item => item.role === 'tool' && item.tool_call_id === 'call-1'))

  let calls = 0
  const orphan = createQwenCascadedLlmFactory({
    baseUrl: 'https://dashscope.example/v1', apiKey: 'dash-secret', model: 'qwen-flash',
    instructions: 'instructions', fetchImpl: () => { calls += 1; return Promise.resolve(sse([])) },
  }).open()
  await assert.rejects(collect(orphan.stream({inputs: [{kind: 'tool_result', call_id: 'orphan', output: {}}],
    tools: [], signal: new AbortController().signal})), QwenCascadedLlmFailure)
  assert.equal(calls, 0)
})

test('Qwen emits safe response_failed events and bounds a noncooperative cancel', async () => {
  const failure = createQwenCascadedLlmFactory({
    baseUrl: 'https://dashscope.example/private?query=secret', apiKey: 'api-secret', model: 'qwen-flash',
    instructions: 'transcript-secret', fetchImpl: () => Promise.resolve(sse([
      {id: 'resp-safe', choices: []},
      {error: {message: 'provider-body-secret', arguments: 'tool-argument-secret'}},
    ])),
  }).open()
  const failed = await collect(failure.stream({inputs: [{kind: 'user_text', text: 'prompt-secret'}],
    tools: [], signal: new AbortController().signal}))
  assert.deepEqual(failed, [{kind: 'response_failed', response_id: 'resp-safe', code: 'protocol'}])
  assert.doesNotMatch(JSON.stringify(failed), /api-secret|prompt-secret|transcript-secret|provider-body-secret|tool-argument-secret|private/u)

  const hanging = createQwenCascadedLlmFactory({
    baseUrl: 'https://dashscope.example/v1', apiKey: 'api-secret', model: 'qwen-flash',
    instructions: 'instructions', closeTimeoutMs: 5,
    fetchImpl: () => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => undefined) },
      cancel() { return new Promise<void>(() => undefined) },
    }), {headers: {'content-type': 'text/event-stream'}})),
  }).open()
  const pending = collect(hanging.stream({inputs: [], tools: [], signal: new AbortController().signal}))
  const rejected = assert.rejects(pending,
    (error: unknown) => error instanceof QwenCascadedLlmFailure && error.code === 'closed')
  await new Promise<void>(resolve => setImmediate(resolve))
  await settlesWithin('close', hanging.close())
  await settlesWithin('cancelled stream', rejected)
})

test('Qwen refuses an over-limit unresolved tool chain rather than evicting part of it', async () => {
  let calls = 0
  const oversizedArguments = JSON.stringify({q: 'x'.repeat(MAX_CASCADED_LLM_HISTORY_CODEPOINTS)})
  const session = createQwenCascadedLlmFactory({
    baseUrl: 'https://dashscope.example/v1', apiKey: 'dash-secret', model: 'qwen-flash',
    instructions: 'instructions', fetchImpl: () => {
      calls += 1
      return Promise.resolve(sse([{id: 'resp-tool', choices: [{delta: {tool_calls: [{index: 0,
        id: 'call-large', function: {name: 'search', arguments: oversizedArguments}}]},
      finish_reason: 'tool_calls'}]}]))
    },
  }).open()
  const first = await collect(session.stream({inputs: [{kind: 'user_text', text: 'weather'}],
    tools: [], signal: new AbortController().signal}))
  assert.equal(first.at(-1)?.kind, 'response_completed')
  await assert.rejects(collect(session.stream({
    inputs: [{kind: 'tool_result', call_id: 'call-large', output: {ok: true}}], tools: [],
    signal: new AbortController().signal,
  })), (error: unknown) => error instanceof QwenCascadedLlmFailure && error.code === 'overflow')
  assert.equal(calls, 1)
})

test('Qwen maps midstream abort and idle timeout to safe response_failed events', async () => {
  const hanging = (first: string): Response => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(first)) },
    pull() { return new Promise<void>(() => undefined) },
  }), {headers: {'content-type': 'text/event-stream'}})
  const controller = new AbortController()
  const aborting = createQwenCascadedLlmFactory({
    baseUrl: 'https://dashscope.example/v1', apiKey: 'dash-secret', model: 'qwen-flash',
    instructions: 'instructions', fetchImpl: () => Promise.resolve(hanging(
      'data: {"id":"resp-abort","choices":[{"delta":{"content":"x"}}]}\n\n',
    )),
  }).open()
  const iterator = aborting.stream({inputs: [], tools: [], signal: controller.signal})[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (first.done) assert.fail('expected response_started before abort')
  assert.equal(first.value.kind, 'response_started')
  controller.abort()
  const afterAbort: CascadedLlmEvent[] = []
  for await (const event of { [Symbol.asyncIterator]: () => iterator }) afterAbort.push(event)
  assert.deepEqual(afterAbort.at(-1), {kind: 'response_failed', response_id: 'resp-abort', code: 'aborted'})

  const timed = createQwenCascadedLlmFactory({
    baseUrl: 'https://dashscope.example/v1', apiKey: 'dash-secret', model: 'qwen-flash', idleTimeoutMs: 5,
    instructions: 'instructions', fetchImpl: () => Promise.resolve(hanging(
      'data: {"id":"resp-timeout","choices":[]}\n\n',
    )),
  }).open()
  const afterTimeout = await collect(timed.stream({inputs: [], tools: [], signal: new AbortController().signal}))
  assert.deepEqual(afterTimeout, [{kind: 'response_failed', response_id: 'resp-timeout', code: 'timeout'}])
})
