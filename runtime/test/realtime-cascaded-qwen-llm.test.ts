import type {UsageReport} from '../src/realtime/usage.js'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
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

test('tool SSE preserves incomplete lines across network chunks, including UTF-8 splits', async () => {
  const call = {index: 0, id: 'call-1', function: {name: 'dispatch', arguments: JSON.stringify({instruction: '创建网页'})}}
  const wire = new TextEncoder().encode([
    `data: ${JSON.stringify({id: 'response-1', choices: [{delta: {tool_calls: [call]}}]})}\n\n`,
    'data: {"id":"response-1","choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ].join(''))
  for (const width of [1, 7, 31, wire.length]) {
    const session = createQwenCascadedLlmFactory({
      baseUrl: 'https://example.test', apiKey: 'synthetic', model: 'test', instructions: 'test',
      fetchImpl: () => Promise.resolve(new Response(new ReadableStream<Uint8Array>({start(controller) {
        for (let offset = 0; offset < wire.length; offset += width) controller.enqueue(wire.slice(offset, offset + width))
        controller.close()
      }}), {headers: {'content-type': 'text/event-stream'}})),
    }).open()
    const events = await collect(session.stream({inputs: [{kind: 'user_text', text: 'test'}],
      tools: [{name: 'dispatch', parameters: {type: 'object'}}], signal: new AbortController().signal}))
    assert.deepEqual(events, [
      {kind: 'response_started', response_id: 'response-1'},
      {kind: 'tool_call', item_id: 'call-1', call_id: 'call-1', name: 'dispatch', arguments: {instruction: '创建网页'}},
      {kind: 'response_completed', response_id: 'response-1'},
    ], `chunk width ${width}`)
    await session.close()
  }
})

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
    enable_thinking: false,
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
      {id: 'provider-tool-1', choices: [{delta: {content: '', tool_calls: [
        {index: 0, id: 'call-1', type: 'function', function: {name: 'search__', arguments: '{"q":"'}},
      ]}}]},
      {choices: [{delta: {content: null, tool_calls: [
        {index: 0, id: '', function: {name: 'query', arguments: 'weather"}'}},
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
    inputs: [{kind: 'tool_result', call_id: 'call-1', output: {temperature: 20}},
      {kind: 'host_activation', content: 'Nova Audio Agent 宿主激活事实：最新问题'}, {kind: 'packed_history', content: '只读历史'}],
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
  assert.equal(messages.some(message => message.content === '只读历史'), false)
  assert.equal(messages.at(-1)?.role, 'user')
  assert.deepEqual(JSON.parse(messages.at(-1)?.content as string), {text_to_say: 'Nova Audio Agent 宿主激活事实：最新问题'})
})

for (const factOnly of [false, true]) test(`Qwen completes two sequential tool hops (factOnly=${factOnly})`, async () => {
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
    inputs: [{kind: 'tool_result', call_id: 'call-b', output: {value: 'b'}},
      ...(factOnly ? [{kind: 'host_activation' as const, content: '最新事实'}] : [])], tools,
    signal: new AbortController().signal,
  }))

  assert.deepEqual(final, [
    {kind: 'response_started', response_id: 'response-final'},
    {kind: 'text_delta', text: '完成'},
    {kind: 'response_completed', response_id: 'response-final'},
  ])
  const finalMessages = requests[2]?.messages as Record<string, unknown>[]
  assert.deepEqual(finalMessages.filter(message => message.role === 'tool').map(message =>
    message.tool_call_id), factOnly ? ['call-b'] : ['call-a', 'call-b'])
  assert.deepEqual(finalMessages.filter(message => Array.isArray(message.tool_calls)).map(message =>
    ((message.tool_calls as readonly {id: string}[])[0]?.id)), factOnly ? ['call-b'] : ['call-a', 'call-b'])
})

test('interrupting a consumed tool result keeps the resolved pair and admits the next user turn', async () => {
  const requests: Record<string, unknown>[] = []
  const responses = [
    sse([{id: 'tool-turn', choices: [{delta: {tool_calls: [{index: 0, id: 'call-accepted',
      function: {name: 'dispatch', arguments: '{}'}}]}, finish_reason: 'tool_calls'}]}]),
    sse([{id: 'ack-turn', choices: [{delta: {content: '正在安排'}, finish_reason: 'stop'}]}]),
    sse([{id: 'next-turn', choices: [{delta: {content: '已收到补充'}, finish_reason: 'stop'}]}]),
  ]
  const session = createQwenCascadedLlmFactory({
    baseUrl: 'https://dashscope.example/v1', apiKey: 'test-key', model: 'qwen-plus',
    instructions: 'instructions', fetchImpl: (_url, init) => {
      requests.push(JSON.parse(init?.body as string) as Record<string, unknown>)
      return Promise.resolve(responses.shift()!)
    },
  }).open()
  const signal = new AbortController().signal
  await collect(session.stream({inputs: [{kind: 'user_text', text: '原始需求'}], tools: [], signal}))
  const continuation = session.stream({
    inputs: [{kind: 'tool_result', call_id: 'call-accepted', output: {accepted: true}}], tools: [], signal,
  })[Symbol.asyncIterator]()
  const started = await continuation.next()
  assert.equal(started.done, false)
  if (!started.done) assert.equal(started.value.kind, 'response_started')
  await continuation.return?.()
  const next = await collect(session.stream({inputs: [{kind: 'user_text', text: '补充要求'}], tools: [], signal}))
  assert.equal(next.at(-1)?.kind, 'response_completed')
  const messages = requests.at(-1)?.messages as Record<string, unknown>[]
  assert.equal(messages.filter(item => item.tool_call_id === 'call-accepted').length, 1)
  assert.ok(messages.some(item => item.content === '原始需求'))
  assert.equal(messages.some(item => item.content === '正在安排'), false)
  await session.close()
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

test('Qwen tool preamble stays internal while structured call is delivered', async () => {
  const session = createQwenCascadedLlmFactory({
    baseUrl: 'https://dashscope.example/v1', apiKey: 'dash-secret', model: 'qwen-flash',
    instructions: 'instructions', fetchImpl: () => Promise.resolve(sse([
      {id: 'resp', choices: [{delta: {content: '正在安排任务。'}, finish_reason: null}]},
      {id: 'resp', choices: [{delta: {tool_calls: [{index: 0, id: 'call', function: {name: 'dispatch', arguments: '{}'}}]}, finish_reason: 'tool_calls'}]},
    ])),
  }).open()
  const events = await collect(session.stream({inputs: [{kind: 'user_text', text: '创建文件'}],
    tools: [{name: 'dispatch', parameters: {type: 'object', properties: {}}}], signal: new AbortController().signal}))
  assert.deepEqual(events.map(event => event.kind), ['response_started', 'tool_call', 'response_completed'])
  assert.equal(events[1]?.kind === 'tool_call' && events[1].name, 'dispatch')
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


test('Qwen captures trailing usage even when consumer stops at terminal; missing usage stays explicit', async () => {
  const reports: UsageReport[] = []
  const session = createQwenCascadedLlmFactory({
    baseUrl: 'https://example.invalid/v1', apiKey: 'key', model: 'qwen-flash', instructions: 'system',
    onUsage: report => reports.push(report),
    fetchImpl: () => Promise.resolve(sse([
      {id: 'reused-id', choices: [{delta: {content: 'ok'}, finish_reason: 'stop'}]},
      {choices: [], usage: {prompt_tokens: 20, completion_tokens: 5,
        prompt_tokens_details: {cached_tokens: 4}, completion_tokens_details: {reasoning_tokens: 2}}},
    ])),
  }).open()
  const input = {inputs: [{kind: 'user_text' as const, text: 'hi'}], tools: [], signal: new AbortController().signal}
  for await (const event of session.stream(input)) if (event.kind === 'response_completed') break
  await collect(session.stream(input))
  await settlesWithin('usage reports', (async () => { while (reports.length < 2) await new Promise(resolve => setTimeout(resolve, 1)) })())
  assert.equal(reports.length, 2)
  assert.equal(reports[0]?.status, 'complete')
  assert.equal(reports[0]?.inputTokens, 20)
  assert.equal(reports[0]?.cachedTokens, 4)
  assert.equal(reports[0]?.reasoningTokens, 2)
  assert.notEqual(reports[0]?.id, reports[1]?.id)
  await session.close()
  for (const source of [sse([{id: 'r', choices: [{delta: {}, finish_reason: 'stop'}]}]), new Response('', {status: 500})]) {
    const missing = createQwenCascadedLlmFactory({baseUrl: 'https://example.invalid/v1', apiKey: 'key', model: 'qwen-flash', instructions: 'system',
      onUsage: report => reports.push(report), fetchImpl: () => Promise.resolve(source)}).open()
    await collect(missing.stream(input)).catch(() => undefined)
    await missing.close()
    assert.equal(reports.at(-1)?.status, 'missing')
  }
})


test('Qwen bounds missing metering tail after terminal without changing completed semantics', async () => {
  for (const stopAtTerminal of [false, true]) {
    const reports: UsageReport[] = []
    let cancelled = false
    const session = createQwenCascadedLlmFactory({
      baseUrl: 'https://example.invalid/v1', apiKey: 'key', model: 'qwen-flash', instructions: 'system',
      onUsage: report => reports.push(report), idleTimeoutMs: 30_000, closeTimeoutMs: 20,
      fetchImpl: () => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('data: {"id":"r","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')) },
        cancel() { cancelled = true },
      }), {headers: {'content-type': 'text/event-stream'}})),
    }).open()
    const events: CascadedLlmEvent[] = []
    await settlesWithin('usage tail', (async () => {
      for await (const event of session.stream({inputs: [{kind: 'user_text', text: 'hi'}], tools: [], signal: new AbortController().signal})) {
        events.push(event)
        if (stopAtTerminal && event.kind === 'response_completed') break
      }
    })())
    assert.equal(events.at(-1)?.kind, 'response_completed')
    assert.equal(cancelled, false)
    await settlesWithin('background usage', (async () => { while (reports.length === 0) await new Promise(resolve => setTimeout(resolve, 1)) })())
    assert.equal(cancelled, true)
    assert.equal(reports.length, 1)
    assert.equal(reports[0]?.status, 'missing')
    await session.close()
  }
})


test('captured Qwen null argument delta preserves a complete call but cannot supply missing JSON', async () => {
  const captured = JSON.parse(readFileSync(new URL('../../../tests/fixtures/realtime/qwen/v1/tool-null-delta.json', import.meta.url), 'utf8')) as Record<string, unknown>[]
  for (const nullOnly of [false, true]) {
    const chunks = nullOnly ? [{id: 'empty', choices: [{delta: {tool_calls: [{index: 0, id: 'empty',
      function: {name: 'search', arguments: null}}]}, finish_reason: 'tool_calls'}]}] : captured
    const live = createQwenCascadedLlmFactory({baseUrl: 'https://dashscope.example/v1', apiKey: 'synthetic',
      model: 'qwen-flash', instructions: 'synthetic', fetchImpl: () => Promise.resolve(sse(chunks))}).open()
    try {
      const events = await collect(live.stream({inputs: [{kind: 'user_text', text: '搜索航天新闻'}], tools: [], signal: AbortSignal.timeout(1000)}))
      if (nullOnly) {
        assert.equal(events.at(-1)?.kind, 'response_failed')
        assert.equal(events.some(event => event.kind === 'tool_call'), false)
      } else {
        assert.equal(events.at(-1)?.kind, 'response_completed')
        assert.deepEqual(events.find(event => event.kind === 'tool_call'), {kind: 'tool_call', item_id: 'call-live-null',
          call_id: 'call-live-null', name: 'search__search', arguments: {k: 3, query: '今天 航天 新闻', origin_ref: 'conversation:1'}})
      }
    } finally { await live.close() }
  }
})

test('captured Max null id delta preserves the established id without accepting missing or changed ids', async () => {
  const captured = JSON.parse(readFileSync(new URL('../../../tests/fixtures/realtime/qwen/v1/tool-null-id-delta.json', import.meta.url), 'utf8')) as {choices?: {delta: {tool_calls?: {id?: string | null}[]}}[]}[]
  for (const mode of ['captured', 'missing', 'changed'] as const) {
    const chunks = structuredClone(captured)
    for (const chunk of chunks) for (const choice of chunk.choices ?? []) for (const call of choice.delta.tool_calls ?? []) {
      if (mode === 'missing' && typeof call.id === 'string') call.id = null
      if (mode === 'changed' && call.id === null) call.id = 'different-call'
    }
    const live = createQwenCascadedLlmFactory({baseUrl: 'https://dashscope.example/v1', apiKey: 'synthetic',
      model: 'qwen3.8-max', instructions: 'synthetic', fetchImpl: () => Promise.resolve(sse(chunks))}).open()
    try {
      const events = await collect(live.stream({inputs: [{kind: 'user_text', text: '追加要求'}], tools: [], signal: AbortSignal.timeout(1000)}))
      if (mode === 'captured') {
        assert.equal(events.at(-1)?.kind, 'response_completed')
        const call = events.find(event => event.kind === 'tool_call')
        assert.equal(call?.kind, 'tool_call')
        if (call?.kind === 'tool_call') {
          assert.equal(call.name, 'dispatch')
          assert.equal(call.arguments.executor, 'codex')
          assert.equal(call.arguments.origin_ref, 'conversation:1')
        }
      } else {
        assert.equal(events.at(-1)?.kind, 'response_failed')
        assert.equal(events.some(event => event.kind === 'tool_call'), false)
      }
    } finally { await live.close() }
  }
})

test('Qwen sends original pixels through tool continuations and strips them from later history', async () => {
  const requests: string[] = []
  let call = 0
  const llm = createQwenCascadedLlmFactory({baseUrl:'https://example.test/v1',apiKey:'test',model:'qwen3-vl-plus',instructions:'test',
    fetchImpl: (_url, init) => {
      requests.push(init?.body as string)
      call++
      const delta = call === 1 ? {tool_calls:[{index:0,id:'call-1',type:'function',function:{name:'lookup',arguments:'{}'}}]} : {content:'done'}
      return Promise.resolve(new Response(`data: ${JSON.stringify({id:`r-${call}`,choices:[{delta}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:call===1?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`, {headers:{'content-type':'text/event-stream'}}))
    }}).open()
  const signal = new AbortController().signal, tools = [{name:'lookup',parameters:{type:'object'}}]
  const image = {payload:new Uint8Array([255,216,255,217]),media_type:'image/jpeg',width:1280,height:720,captured_at:1}
  await collect(llm.stream({inputs:[{kind:'user_text',text:'look',image}],tools,signal}))
  await collect(llm.stream({inputs:[{kind:'tool_result',call_id:'call-1',output:{ok:true}}],tools,signal}))
  await collect(llm.stream({inputs:[{kind:'user_text',text:'next'}],tools,signal}))
  assert.match(requests[0]!, /image_url.*data:image\/jpeg;base64/u)
  assert.match(requests[1]!, /image_url.*data:image\/jpeg;base64/u)
  assert.doesNotMatch(requests[2]!, /image_url|data:image/u)
  assert.match(requests[2]!, /call-1/u)
  await llm.close()
})

test('fresh sessions seed only committed pairs and reject reseeding after a pending tool', async () => {
  const bodies:Record<string,unknown>[]=[]
  const factory=createQwenCascadedLlmFactory({baseUrl:'https://example.invalid',apiKey:'test',model:'test',instructions:'system',fetchImpl:(_url,init)=>{
    bodies.push(JSON.parse(init?.body as string) as Record<string,unknown>)
    return Promise.resolve(sse([{id:'r',choices:[{delta:{tool_calls:[{index:0,id:'call',function:{name:'lookup',arguments:'{}'}}]},finish_reason:'tool_calls'}]}]))
  }})
  const first=factory.open(),second=factory.open(),signal=new AbortController().signal
  try {
    assert(typeof first.restoreHistory==='function');assert(typeof second.restoreHistory==='function')
    await first.restoreHistory([{user:'first question',assistant:'first answer'}],signal)
    await second.restoreHistory([{user:'other question',assistant:'other answer'}],signal)
    await collect(first.stream({inputs:[{kind:'user_text',text:'next'}],tools:[],signal}))
    await collect(second.stream({inputs:[{kind:'user_text',text:'other next'}],tools:[],signal}))
    assert.match(JSON.stringify(bodies[0]),/first answer/u);assert.doesNotMatch(JSON.stringify(bodies[0]),/other answer/u)
    assert.match(JSON.stringify(bodies[1]),/other answer/u);assert.doesNotMatch(JSON.stringify(bodies[1]),/first answer/u)
    await assert.rejects(first.restoreHistory([{user:'bad',assistant:'overwrite'}],signal))
  } finally {await first.close();await second.close()}
})

test('DeepSeek official stream keeps tool history, disables thinking and meters KV cache', async () => {
  const requests: Record<string, unknown>[] = [], reports: UsageReport[] = []
  const responses = [
    sse([{id: 'ds-1', choices: [{delta: {tool_calls: [{index: 0, id: 'call-ds', type: 'function', function: {name: 'lookup', arguments: '{}'}}]}, finish_reason: 'tool_calls'}]}]),
    sse([{id: 'ds-2', choices: [{delta: {content: 'done'}, finish_reason: 'stop'}]}, {choices: [], usage: {prompt_tokens: 120, completion_tokens: 2, prompt_cache_hit_tokens: 96}}]),
  ]
  const session = createQwenCascadedLlmFactory({provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'deepseek-test', model: 'deepseek-flash', instructions: 'instructions', onUsage: report => reports.push(report),
    fetchImpl: (url, init) => {
      assert.equal(url, 'https://api.deepseek.com/chat/completions')
      assert.equal((init!.headers as Record<string, string>).authorization, 'Bearer deepseek-test')
      assert.equal(typeof init!.body, 'string')
      requests.push(JSON.parse(init!.body as string) as Record<string, unknown>)
      return Promise.resolve(responses.shift()!)
    },
  }).open()
  const tools = [{name: 'lookup', parameters: {type: 'object', properties: {}}}]
  const first = await collect(session.stream({inputs: [{kind: 'user_text', text: 'lookup'}], tools, signal: new AbortController().signal}))
  assert.ok(first.some(event => event.kind === 'tool_call' && event.call_id === 'call-ds'))
  await collect(session.stream({inputs: [{kind: 'tool_result', call_id: 'call-ds', output: {ok: true}}], tools, signal: new AbortController().signal}))
  await session.close()
  assert.deepEqual(requests[0]!.thinking, {type: 'disabled'})
  assert.equal((requests[1]!.messages as {role: string}[]).filter(message => message.role === 'tool').length, 1)
  assert.equal(reports.at(-1)?.provider, 'deepseek')
  assert.equal(reports.at(-1)?.cachedTokens, 96)
})

test('host facts are system context, never a new user decision', async () => {
  const capture: Capture = {}
  const llm = session(capture)
  await collect(llm.stream({inputs: [{kind: 'host_context', content: '请询问用户是否创建工作区'}], tools: [], signal: new AbortController().signal}))
  const {messages} = JSON.parse(capture.init?.body as string) as {messages: unknown[]}
  assert.deepEqual(messages.at(-1), {role: 'system', content: '请询问用户是否创建工作区'})
  await llm.close()
})

test('host narration reads only its fact while the next user turn retains conversation history', async () => {
  const requests: {messages: {role: string; content: unknown}[]}[] = []
  const replies = ['旧问题：请选择项目。', '任务未能启动。', '已理解后续请求。']
  const llm = createQwenCascadedLlmFactory({
    baseUrl: 'https://dashscope.example/v1', apiKey: 'test', model: 'qwen-flash', instructions: 'instructions',
    fetchImpl: (_url, init) => {
      requests.push(JSON.parse(init!.body as string) as typeof requests[number])
      return Promise.resolve(sse([{id: `response-${requests.length}`, choices: [{
        delta: {content: replies.shift()}, finish_reason: 'stop',
      }]}]))
    },
  }).open()
  const signal = new AbortController().signal
  await collect(llm.stream({inputs: [{kind: 'user_text', text: '用户原始任务'}], tools: [], signal}))
  await collect(llm.stream({inputs: [{kind: 'packed_history', content: '恢复的旧问题'},
    {kind: 'host_activation', content: '本次执行请求已失效，任务未能启动。'}],
    workspaceContext: '旧工作区上下文', tools: [], signal}))
  const narration = JSON.stringify(requests[1])
  assert.doesNotMatch(String(requests[1]?.messages[0]?.content), /instructions/)
  assert.match(String(requests[1]?.messages[0]?.content), /用第一人称/)
  assert.doesNotMatch(narration, /旧问题|原始任务|旧工作区/)
  assert.match(narration, /请求已失效/)
  await collect(llm.stream({inputs: [{kind: 'user_text', text: '继续讨论'}], tools: [], signal}))
  const conversation = JSON.stringify(requests[2])
  assert.match(conversation, /用户原始任务/)
  assert.match(conversation, /任务未能启动/)
  await llm.close()
})


test('thinking and buffered text do not start an idle TTS session', async () => {
  for (const toolEnabled of [false, true]) {
    let source!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({start(controller) { source = controller }})
    const session = createQwenCascadedLlmFactory({
      baseUrl: 'https://dashscope.example/v1', apiKey: 'test-key', model: 'qwen3.8-max',
      instructions: 'instructions', fetchImpl: () => Promise.resolve(new Response(body, {headers: {'content-type': 'text/event-stream'}})),
    }).open()
    const received: CascadedLlmEvent[] = []
    const collecting = (async () => {
      for await (const event of session.stream({inputs: [],
        tools: toolEnabled ? [{name: 'dispatch', parameters: {type: 'object'}}] : [],
        signal: new AbortController().signal})) received.push(event)
    })()
    const send = (delta: object, finish_reason?: string): void => source.enqueue(new TextEncoder().encode(
      `data: ${JSON.stringify({id: 'response', choices: [{delta, ...(finish_reason ? {finish_reason} : {})}]})}\n\n`))
    send({content: '', reasoning_content: 'thinking'})
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(received.length, 0)
    send({content: '需要新建工作区吗？'})
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(received.length, toolEnabled ? 0 : 2)
    send({}, 'stop')
    source.close()
    await collecting
    assert.deepEqual(received.map(event => event.kind), ['response_started', 'text_delta', 'response_completed'])
    await session.close()
  }
})


test('cascaded English translates conversation and narration prompts but preserves user content and history', async () => {
  const requests: {messages: {role: string; content: string}[]}[] = []
  const {frontendInstructions} = await import('../src/realtime/frontend-instructions.js')
  const llm = createQwenCascadedLlmFactory({baseUrl: 'https://example.test', apiKey: 'test', model: 'test', instructions: frontendInstructions(),
    fetchImpl: (_url, init) => {
      assert.equal(typeof init?.body, 'string')
      requests.push(JSON.parse(init!.body as string) as {messages: {role: string; content: string}[]})
      return Promise.resolve(new Response('data: {"id":"r","choices":[{"delta":{"content":"Hello"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {headers: {'content-type': 'text/event-stream'}}))
    },
  }).open()
  const signal = new AbortController().signal
  await collect(llm.stream({language: 'en', inputs: [{kind: 'user_text', text: '用户原话不翻译'}], tools: [], signal}))
  await collect(llm.stream({language: 'en', inputs: [{kind: 'host_activation', content: '任务已完成'}], tools: [], signal}))
  assert.match(requests[0]!.messages[0]!.content, /^You are Nova/)
  assert.equal(requests[0]!.messages[1]!.content, '用户原话不翻译')
  assert.match(requests[1]!.messages[0]!.content, /text_to_say/)
  assert.doesNotMatch(requests[1]!.messages[0]!.content, /[\u3400-\u9fff]/u)
  assert.match(requests[1]!.messages[1]!.content, /任务已完成/)
  await llm.close()
})
