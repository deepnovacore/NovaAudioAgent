import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ArkResponsesFailure,
  MAX_ARK_EVENTS,
  MAX_ARK_REQUEST_BYTES,
  MAX_ARK_RESPONSE_BYTES,
  MAX_ARK_SSE_EVENT_BYTES,
  MAX_ARK_SSE_LINE_BYTES,
  createFetchArkResponsesGateway,
  responsesToolSchema,
  type ArkEvent,
  type ArkResponsesGateway,
} from '../src/realtime/volcengine/ark.js'
import type { JsonObject } from '../src/realtime/protocol.js'

interface Capture {
  url?: string
  init?: RequestInit
  calls: number
}

function gateway(
  response: Response | (() => Promise<Response>),
  options: {readonly idleTimeoutMs?: number; readonly capture?: Capture} = {},
): ArkResponsesGateway {
  const capture = options.capture
  const fetchImpl: typeof fetch = (input, init) => {
    if (capture !== undefined) {
      capture.calls += 1
      capture.url = typeof input === 'string'
        ? input
        : input instanceof URL ? input.toString() : input.url
      if (init !== undefined) capture.init = init
    }
    return typeof response === 'function' ? response() : Promise.resolve(response)
  }
  return createFetchArkResponsesGateway({
    baseUrl: 'https://ark.example/api/v3/?region=cn',
    apiKey: 'ark-api-secret',
    model: 'ark-model-secret',
    instructions: 'ark-instructions-secret',
    fetchImpl,
    idleTimeoutMs: options.idleTimeoutMs ?? 50,
    closeTimeoutMs: 50,
  })
}

function eventStream(source: string | readonly Uint8Array[], onCancel?: () => void): Response {
  const chunks = typeof source === 'string'
    ? [new TextEncoder().encode(source)]
    : source.map(chunk => new Uint8Array(chunk))
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
    cancel() {
      onCancel?.()
    },
  })
  return new Response(body, {status: 200, headers: {'content-type': 'text/event-stream'}})
}

function hangingEventStream(onCancel?: () => void): Response {
  return new Response(new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => undefined)
    },
    cancel() {
      onCancel?.()
    },
  }), {status: 200, headers: {'content-type': 'text/event-stream'}})
}

function sse(...events: readonly JsonObject[]): string {
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
}

async function collect(gateway_: ArkResponsesGateway, input: {
  readonly inputItems?: readonly JsonObject[]
  readonly tools?: readonly JsonObject[]
  readonly previousResponseId?: string | null
  readonly signal?: AbortSignal
} = {}): Promise<ArkEvent[]> {
  const seen: ArkEvent[] = []
  for await (const event of gateway_.stream({
    inputItems: input.inputItems ?? [],
    tools: input.tools ?? [],
    previousResponseId: input.previousResponseId ?? null,
    ...(input.signal === undefined ? {} : {signal: input.signal}),
  })) seen.push(event)
  return seen
}

async function settleWithin<T>(label: string, promise: Promise<T>, milliseconds = 250): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle`)), milliseconds)
  })
  try {
    return await Promise.race([promise, expired])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

test('Responses tool translation validates Python-strip names and deep-copies only public fields', () => {
  const parameters = {type: 'object', properties: {city: {type: 'string'}}}
  const source = {
    type: 'function',
    function: {
      name: 'weather__get',
      description: 'weather lookup',
      parameters,
      strict: true,
    },
    private_field: 'must-not-cross',
  } as JsonObject
  const translated = responsesToolSchema(source)
  assert.deepEqual(translated, {
    type: 'function', name: 'weather__get', description: 'weather lookup', parameters,
  })
  parameters.properties.city.type = 'number'
  assert.equal(((translated.parameters as JsonObject).properties as JsonObject).city
    && (((translated.parameters as JsonObject).properties as JsonObject).city as JsonObject).type,
  'string')
  assert.throws(() => responsesToolSchema({
    type: 'function', function: {name: '\u001c\u0085', parameters: {}},
  }), ArkResponsesFailure)
  assert.throws(() => responsesToolSchema({
    type: 'function', function: {name: 'x', parameters: []},
  }), ArkResponsesFailure)
})

test('Ark request path, headers, exact body, chaining, and ownership are fixed before fetch', async () => {
  const capture: Capture = {calls: 0}
  const response = eventStream(sse(
    {type: 'response.created', response: {id: 'resp-2'}},
    {type: 'response.completed', response: {id: 'resp-2'}},
  ))
  const inputItems = [{role: 'user', content: 'hello'}]
  const tools = [{type: 'function', name: 'weather__get', parameters: {type: 'object'}}]
  const pending = collect(gateway(response, {capture}), {
    inputItems, tools, previousResponseId: 'resp-1',
  })
  inputItems[0]!.content = 'mutated'
  tools[0]!.name = 'mutated'
  assert.deepEqual(await pending, [
    {kind: 'response_started', response_id: 'resp-2'},
    {kind: 'response_completed', response_id: 'resp-2'},
  ])
  assert.equal(capture.url, 'https://ark.example/api/v3/responses?region=cn')
  const headers = capture.init?.headers as Record<string, string>
  assert.deepEqual(headers, {
    authorization: 'Bearer ark-api-secret',
    'content-type': 'application/json',
    accept: 'text/event-stream',
  })
  assert.deepEqual(JSON.parse(capture.init?.body as string), {
    model: 'ark-model-secret',
    instructions: 'ark-instructions-secret',
    input: [{role: 'user', content: 'hello'}],
    tools: [{type: 'function', name: 'weather__get', parameters: {type: 'object'}}],
    parallel_tool_calls: false,
    store: true,
    stream: true,
    thinking: {type: 'disabled'},
    previous_response_id: 'resp-1',
  })
})

test('strict SSE handles chunk splits, CRLF, comments, repeated data, and normalized tool output', async () => {
  const source = [
    ': keepalive\r\nevent: response\r\ndata: {"type":"response.created",\r\n',
    'data: "response":{"id":"resp-1"}}\r\n\r\n',
    'id: ignored\ndata: {"type":"response.output_text.delta","delta":""}\n\n',
    'data: {"type":"response.output_item.done","item":{"type":"message"}}\n\n',
    'data: {"type":"response.output_item.done","item":{"type":"function_call",',
    '"id":"item-1","call_id":"call-1","name":"weather__get",',
    '"arguments":"{\\"city\\":\\"上海\\"}"}}\n\n',
    'data: {"type":"response.completed","response":{"id":"resp-1"}}',
  ].map(part => new TextEncoder().encode(part))
  const seen = await collect(gateway(eventStream(source)))
  assert.deepEqual(seen, [
    {kind: 'response_started', response_id: 'resp-1'},
    {kind: 'text_delta', text: ''},
    {kind: 'tool_call', item_id: 'item-1', call_id: 'call-1', name: 'weather__get',
      arguments: {city: '上海'}},
    {kind: 'response_completed', response_id: 'resp-1'},
  ])
})

test('invalid tool arguments and identities fail safely without retaining provider content', async () => {
  for (const item of [
    {type: 'function_call', id: 'item', call_id: 'call', name: 'tool',
      arguments: '["provider-argument-secret"]'},
    {type: 'function_call', id: '\u001c', call_id: 'call', name: 'tool',
      arguments: '{"secret":"provider-argument-secret"}'},
  ]) {
    const response = eventStream(sse(
      {type: 'response.created', response: {id: 'resp'}},
      {type: 'response.output_item.done', item},
      {type: 'response.completed', response: {id: 'resp'}},
    ))
    let failure: unknown
    try {
      await collect(gateway(response))
    } catch (error) {
      failure = error
    }
    assert.ok(failure instanceof ArkResponsesFailure && failure.code === 'protocol')
    assert.doesNotMatch(JSON.stringify(failure),
      /provider-argument-secret|ark-api-secret|endpoint-nonce/u)
  }
})

test('HTTP failure exposes only its integer status and never reads provider error bodies', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode('provider-http-body-secret'))
    },
    cancel() {
      cancelled = true
    },
  })
  const response = new Response(body, {status: 429, statusText: 'provider-status-secret'})
  let failure: unknown
  try {
    await collect(gateway(response))
  } catch (error) {
    failure = error
  }
  assert.ok(failure instanceof ArkResponsesFailure
    && failure.code === 'http' && failure.statusCode === 429)
  assert.equal(cancelled, true)
  assert.doesNotMatch(JSON.stringify(failure),
    /provider-http-body-secret|provider-status-secret|ark-api-secret|ark.example/u)
})

test('request, line, assembled event, aggregate bytes, and event count are independently bounded', async () => {
  const capture: Capture = {calls: 0}
  const huge = 'x'.repeat(MAX_ARK_REQUEST_BYTES)
  await assert.rejects(collect(gateway(eventStream(''), {capture}), {
    inputItems: [{role: 'user', content: huge}],
  }), (error: unknown) => error instanceof ArkResponsesFailure && error.code === 'overflow')
  assert.equal(capture.calls, 0)

  const oversizedLine = `data: ${'x'.repeat(MAX_ARK_SSE_LINE_BYTES)}\n\n`
  await assert.rejects(collect(gateway(eventStream(oversizedLine))),
    (error: unknown) => error instanceof ArkResponsesFailure && error.code === 'overflow')

  const dataPart = `data: ${' '.repeat(Math.floor(MAX_ARK_SSE_EVENT_BYTES / 3))}\n`
  await assert.rejects(collect(gateway(eventStream(dataPart.repeat(4) + '\n'))),
    (error: unknown) => error instanceof ArkResponsesFailure && error.code === 'overflow')

  const comment = `:${'x'.repeat(200_000)}\n`
  const aggregate = comment.repeat(Math.ceil((MAX_ARK_RESPONSE_BYTES + 1) / 200_001))
  await assert.rejects(collect(gateway(eventStream(aggregate))),
    (error: unknown) => error instanceof ArkResponsesFailure && error.code === 'overflow')

  const unknown = 'data: {"type":"unknown"}\n\n'
  await assert.rejects(collect(gateway(eventStream(unknown.repeat(MAX_ARK_EVENTS + 1)))),
    (error: unknown) => error instanceof ArkResponsesFailure && error.code === 'overflow')
})

test('EOF requires a terminal but parses one bounded unterminated terminal line', async () => {
  await assert.rejects(collect(gateway(eventStream(sse(
    {type: 'response.created', response: {id: 'resp'}},
  )))), (error: unknown) => error instanceof ArkResponsesFailure && error.code === 'protocol')

  const seen = await collect(gateway(eventStream(
    'data: {"type":"response.completed","response":{"id":"resp"}}',
  )))
  assert.deepEqual(seen, [{kind: 'response_completed', response_id: 'resp'}])
})

test('pre-abort skips fetch, idle timeout aborts reads, and caller abort stays classified', async () => {
  const capture: Capture = {calls: 0}
  const stopped = new AbortController()
  stopped.abort()
  await assert.rejects(collect(gateway(eventStream(''), {capture}), {signal: stopped.signal}),
    (error: unknown) => error instanceof ArkResponsesFailure && error.code === 'aborted')
  assert.equal(capture.calls, 0)

  let timedCancelled = false
  await assert.rejects(settleWithin('Ark idle timeout', collect(gateway(
    hangingEventStream(() => { timedCancelled = true }), {idleTimeoutMs: 5},
  ))), (error: unknown) => error instanceof ArkResponsesFailure && error.code === 'timeout')
  assert.equal(timedCancelled, true)

  let abortedCancelled = false
  const controller = new AbortController()
  const pending = collect(gateway(hangingEventStream(() => { abortedCancelled = true })), {
    signal: controller.signal,
  })
  await new Promise<void>(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(settleWithin('Ark caller abort', pending),
    (error: unknown) => error instanceof ArkResponsesFailure && error.code === 'aborted')
  assert.equal(abortedCancelled, true)
})

test('consumer return and gateway close cancel readers; close is shared and terminal', async () => {
  let returnCancelled = false
  const first = gateway(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse(
        {type: 'response.created', response: {id: 'resp'}},
      )))
    },
    cancel() {
      returnCancelled = true
    },
  }), {status: 200, headers: {'content-type': 'text/event-stream'}}))
  for await (const event of first.stream({inputItems: [], tools: [], previousResponseId: null})) {
    assert.equal(event.kind, 'response_started')
    break
  }
  assert.equal(returnCancelled, true)

  let closeCancelled = false
  const active = gateway(hangingEventStream(() => { closeCancelled = true }))
  const pending = active.stream({inputItems: [], tools: [], previousResponseId: null})
    [Symbol.asyncIterator]().next()
  await new Promise<void>(resolve => setImmediate(resolve))
  const closing = active.close()
  assert.equal(closing, active.close())
  await settleWithin('Ark close', closing)
  assert.equal(closeCancelled, true)
  await assert.rejects(settleWithin('Ark closed iterator', pending),
    (error: unknown) => error instanceof ArkResponsesFailure && error.code === 'closed')
  await assert.rejects(collect(active),
    (error: unknown) => error instanceof ArkResponsesFailure && error.code === 'closed')
})

test('failed and incomplete response terminals retain only their stable category', async () => {
  for (const code of ['failed', 'incomplete'] as const) {
    const seen = await collect(gateway(eventStream(sse({
      type: `response.${code}`, response: {id: `resp-${code}`},
    }))))
    assert.deepEqual(seen, [{kind: 'response_failed', response_id: `resp-${code}`, code}])
  }
})
