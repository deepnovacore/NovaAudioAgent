import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { canonicalJson } from '../src/canonical-json.js'
import { VirtualClock } from '../src/clock.js'
import type { JsonValue } from '../src/events.js'
import {
  GatewayError,
  OpenAIModelGateway,
  completeRequestBody,
  readServerSentEvents,
  streamRequestBody,
  type GatewayDelta,
  type GatewayImage,
  type ModelMetrics,
} from '../src/model-gateway.js'

const fixtureRoot = resolve(import.meta.dirname, '../../../fixtures/gateway/v1')

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(fixtureRoot, name), 'utf8')) as T
}

interface Scenario {
  readonly id: string
  readonly mode: 'stream' | 'complete'
  readonly model: string
  readonly system: string
  readonly prompt: string
  readonly covers: string
  readonly tools?: readonly Readonly<Record<string, JsonValue>>[]
  readonly images?: readonly {
    readonly ref: string
    readonly media_type: string
    readonly payload_base64: string
  }[]
  readonly json_schema?: Readonly<Record<string, JsonValue>>
}

function imagesOf(scenario: Scenario): readonly GatewayImage[] {
  return (scenario.images ?? []).map(image => ({
    ref: image.ref,
    media_type: image.media_type,
    payload: new Uint8Array(Buffer.from(image.payload_base64, 'base64')),
  }))
}

test('gateway request bodies match the Python oracle byte for byte', () => {
  const fixture = loadJson<{
    readonly schema_version: number
    readonly scenarios: readonly Scenario[]
  }>('requests.json')
  const golden = loadJson<{
    readonly schema_version: number
    readonly requests: Readonly<Record<string, JsonValue>>
  }>('requests-expected.json')
  assert.equal(fixture.schema_version, golden.schema_version)
  assert.deepEqual(
    fixture.scenarios.map(scenario => scenario.id).sort(),
    Object.keys(golden.requests).sort(),
  )

  for (const scenario of fixture.scenarios) {
    const body = scenario.mode === 'stream'
      ? streamRequestBody({
        model: scenario.model,
        system: scenario.system,
        prompt: scenario.prompt,
        ...(scenario.tools === undefined ? {} : {tools: scenario.tools}),
        images: imagesOf(scenario),
      })
      : completeRequestBody({
        model: scenario.model,
        system: scenario.system,
        prompt: scenario.prompt,
        ...(scenario.json_schema === undefined ? {} : {jsonSchema: scenario.json_schema}),
        images: imagesOf(scenario),
      })
    assert.equal(
      canonicalJson(body),
      canonicalJson(golden.requests[scenario.id]),
      `${scenario.id}: ${scenario.covers}`,
    )
  }
})

test('the golden binds every image to its own ref label', () => {
  const golden = loadJson<{readonly requests: Record<string, {
    messages: {content: {type: string, text?: string}[]}[]
  }>}>('requests-expected.json')
  const content = golden.requests['stream-with-images']!.messages[1]!.content
  // prompt text, then [ref] label + image for each of two images.
  assert.deepEqual(content.map(part => part.type),
    ['text', 'text', 'image_url', 'text', 'image_url'])
  assert.equal(content[1]!.text, '[media:1]')
  assert.equal(content[3]!.text, '[media:2]')
})

function sseResponse(events: readonly string[]): Response {
  const body = events.map(event => `data: ${event}\n\n`).join('')
  return new Response(body, {status: 200, headers: {'content-type': 'text/event-stream'}})
}

test('streaming deltas are decoded from the SSE body in order', async () => {
  const chunks = [
    JSON.stringify({id: 'req-1', choices: [{delta: {content: '你好'}}]}),
    JSON.stringify({choices: [{delta: {tool_calls: [
      {index: 0, function: {name: 'slow_sim__set_light', arguments: '{"bri'}},
    ]}}]}),
    JSON.stringify({choices: [{delta: {tool_calls: [
      {index: 0, function: {arguments: 'ghtness":30}'}},
    ]}, finish_reason: 'tool_calls'}]}),
    JSON.stringify({usage: {prompt_tokens: 11, completion_tokens: 7}, choices: []}),
    '[DONE]',
  ]
  const recorded: ModelMetrics[] = []
  const gateway = new OpenAIModelGateway({
    baseUrl: 'https://example.invalid/v1/',
    apiKey: 'gateway-test-key',
    clock: new VirtualClock(),
    metrics: {record: metrics => { recorded.push(metrics) }},
    fetch: () => Promise.resolve(sseResponse(chunks)),
  })

  const seen: GatewayDelta[] = []
  for await (const delta of gateway.stream({
    model: 'qwen3-vl-plus', system: 's', prompt: 'p',
  })) seen.push(delta)

  assert.deepEqual(seen, [
    {kind: 'text', text: '你好'},
    {kind: 'tool_call', index: 0, name: 'slow_sim__set_light', arguments: '{"bri'},
    {kind: 'tool_call', index: 0, name: '', arguments: 'ghtness":30}'},
  ])
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0]?.request_id, 'req-1')
  assert.equal(recorded[0]?.input_tokens, 11)
  assert.equal(recorded[0]?.output_tokens, 7)
  assert.equal(recorded[0]?.finish_reason, 'tool_calls')
  assert.equal(recorded[0]?.error_type, null)
})

test('an SSE event split across several data lines is reassembled', async () => {
  const gateway = new OpenAIModelGateway({
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'k',
    clock: new VirtualClock(),
    metrics: {record: () => undefined},
    fetch: () => Promise.resolve(new Response(
      'data: {"choices":[{"delta":\ndata: {"content":"拼接"}}]}\n\ndata: [DONE]\n\n',
      {status: 200},
    )),
  })
  const seen: GatewayDelta[] = []
  for await (const delta of gateway.stream({model: 'm', system: 's', prompt: 'p'})) {
    seen.push(delta)
  }
  assert.deepEqual(seen, [{kind: 'text', text: '拼接'}])
})

test('SSE data lines retain their specification-mandated newline', async () => {
  const response = new Response('data: "joined\ndata: without-newline"\n\n', {status: 200})
  await assert.rejects(async () => {
    for await (const event of readServerSentEvents(response)) void event
  }, SyntaxError)
})

test('stream timeout ends after response headers and does not abort a healthy long body', async () => {
  const gateway = new OpenAIModelGateway({
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'k',
    clock: new VirtualClock(),
    metrics: {record: () => undefined},
    requestTimeout: 0.01,
    fetch: (_url, init) => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const timer = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"仍在流式传输"}}]}\n\n'
            + 'data: [DONE]\n\n',
          ))
          controller.close()
        }, 30)
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          controller.error(init.signal?.reason)
        }, {once: true})
      },
    }), {status: 200})),
  })

  const seen: GatewayDelta[] = []
  for await (const delta of gateway.stream({model: 'm', system: 's', prompt: 'p'})) {
    seen.push(delta)
  }
  assert.deepEqual(seen, [{kind: 'text', text: '仍在流式传输'}])
})

test('stream idle timeout cancels a body that stalls after response headers', async () => {
  let cancelled = false
  const gateway = new OpenAIModelGateway({
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'k',
    clock: new VirtualClock(),
    metrics: {record: () => undefined},
    streamIdleTimeout: 0.01,
    fetch: () => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel: () => { cancelled = true },
    }), {status: 200})),
  })

  await assert.rejects(async () => {
    for await (const delta of gateway.stream({model: 'm', system: 's', prompt: 'p'})) {
      void delta
    }
  }, (error: unknown) => {
    assert.ok(error instanceof GatewayError)
    assert.equal(error.message, '模型请求失败（TimeoutError）')
    return true
  })
  assert.equal(cancelled, true)
})

test('a provider failure never echoes its body, credential, or prompt', async () => {
  const recorded: ModelMetrics[] = []
  const gateway = new OpenAIModelGateway({
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'super-secret-key',
    clock: new VirtualClock(),
    metrics: {record: metrics => { recorded.push(metrics) }},
    fetch: () => Promise.resolve(new Response(
      'the prompt was: leak me, key super-secret-key',
      {status: 429},
    )),
  })
  await assert.rejects(
    (async () => {
      for await (const delta of gateway.stream({
        model: 'm', system: 'sys', prompt: 'secret prompt',
      })) void delta
    })(),
    (error: unknown) => {
      assert.ok(error instanceof GatewayError)
      assert.equal(error.message, '模型请求失败（HTTPStatus429）')
      assert.doesNotMatch(error.message, /super-secret-key|secret prompt|leak me/u)
      return true
    },
  )
  // Metrics record shape and identity, never content.
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0]?.error_type, 'HTTPStatus429')
  assert.doesNotMatch(JSON.stringify(recorded[0]), /super-secret-key|secret prompt/u)
})

test('complete parses one choice and reports usage', async () => {
  let captured: {url: string, init: RequestInit} | undefined
  const gateway = new OpenAIModelGateway({
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'k',
    clock: new VirtualClock(),
    metrics: {record: () => undefined},
    fetch: (url, init) => {
      // `fetch` accepts string | URL | Request; the gateway only ever passes a string.
      assert.equal(typeof url, 'string')
      captured = {url: url as string, init: init!}
      return Promise.resolve(Response.json({
        id: 'req-2',
        usage: {prompt_tokens: 3, completion_tokens: 4},
        choices: [{finish_reason: 'stop', message: {content: '{"speak":false}'}}],
      }))
    },
  })
  const completion = await gateway.complete({
    model: 'qwen-flash', system: 's', prompt: 'p',
    jsonSchema: {type: 'object'},
  })
  assert.equal(completion.text, '{"speak":false}')
  assert.equal(captured?.url, 'https://example.invalid/v1/chat/completions')
  const headers = captured?.init.headers as Record<string, string>
  assert.equal(headers.authorization, 'Bearer k')
  const body = JSON.parse(captured?.init.body as string) as Record<string, unknown>
  assert.deepEqual(body.response_format, {type: 'json_object'})
})
