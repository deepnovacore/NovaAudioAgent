import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
  DashScopeEmbeddingProvider,
  EmbeddingProviderFailure,
} from '../src/knowledge/embeddings.js'

function embeddingResponse(data: unknown, model: string | null = 'text-embedding-v4'): Response {
  return new Response(JSON.stringify({object: 'list', ...(model === null ? {} : {model}), data}), {
    headers: {'content-type': 'application/json'},
  })
}

test('batches ten inputs and restores vectors to exact provider index order', async () => {
  const requests: unknown[] = []
  const provider = new DashScopeEmbeddingProvider({
    baseUrl: 'https://dashscope.example/compatible-mode/v1',
    apiKey: 'private-key-value',
    dims: 3,
    fetch: (input, init) => {
      assert.equal(typeof input, 'string')
      assert.equal(input, 'https://dashscope.example/compatible-mode/v1/embeddings')
      assert.equal(init?.redirect, 'manual')
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer private-key-value')
      const rawBody = init?.body
      if (typeof rawBody !== 'string') assert.fail('embedding body must be serialized')
      const body: unknown = JSON.parse(rawBody)
      requests.push(body)
      const count = Array.isArray((body as {input?: unknown}).input)
        ? (body as {input: unknown[]}).input.length
        : 0
      return Promise.resolve(embeddingResponse(Array.from({length: count}, (_unused, index) => ({
        object: 'embedding', index: count - index - 1, embedding: [count - index, 0.5, -0.5],
      }))))
    },
  })

  const vectors = await provider.embed(Array.from({length: 11}, (_unused, index) => `text-${index}`))

  assert.equal(provider.id, 'dashscope:text-embedding-v4:3')
  assert.equal(provider.dims, 3)
  assert.equal(requests.length, 2)
  assert.deepEqual(
    requests.map(request => (request as {input: unknown[]}).input.length),
    [10, 1],
  )
  assert.deepEqual([...vectors[0] ?? []], [1, 0.5, -0.5])
  assert.deepEqual([...vectors[9] ?? []], [10, 0.5, -0.5])
  assert.deepEqual([...vectors[10] ?? []], [1, 0.5, -0.5])
})

test('binds model identity while preserving a host-configured local compatible gateway', async () => {
  const mismatched = new DashScopeEmbeddingProvider({
    baseUrl: 'http://127.0.0.1:9000/v1', apiKey: 'key', model: 'configured-model', dims: 2,
    fetch: () => Promise.resolve(embeddingResponse([
      {object: 'embedding', index: 0, embedding: [1, 2]},
    ], 'different-model')),
  })
  await assert.rejects(mismatched.embed(['safe']),
    error => error instanceof EmbeddingProviderFailure && error.code === 'model_mismatch')

  const absent = new DashScopeEmbeddingProvider({
    baseUrl: 'http://127.0.0.1:9000/v1', apiKey: 'key', model: 'configured-model', dims: 2,
    fetch: input => {
      assert.equal(input, 'http://127.0.0.1:9000/v1/embeddings')
      return Promise.resolve(embeddingResponse([
        {object: 'embedding', index: 0, embedding: [1, 2]},
      ], null))
    },
  })
  assert.deepEqual([...await absent.embed(['safe']).then(vectors => vectors[0] ?? [])], [1, 2])
})

test('rejects duplicate, missing, malformed, non-finite, and wrong-sized vectors', async () => {
  const cases: readonly unknown[] = [
    [
      {object: 'embedding', index: 0, embedding: [1, 2]},
      {object: 'embedding', index: 0, embedding: [3, 4]},
    ],
    [{object: 'embedding', index: 1, embedding: [1, 2]}],
    [{object: 'embedding', index: 0, embedding: [1]}],
    [{object: 'embedding', index: 0, embedding: [1, '2']}],
    [{object: 'embedding', index: 0, embedding: [1, Number.POSITIVE_INFINITY]}],
    [{object: 'embedding', index: 0, embedding: [1, Number.MAX_VALUE]}],
  ]

  for (const data of cases) {
    const provider = new DashScopeEmbeddingProvider({
      baseUrl: 'https://dashscope.example/v1', apiKey: 'key', dims: 2,
      fetch: () => Promise.resolve(embeddingResponse(data)),
    })
    await assert.rejects(provider.embed(['a', 'b'].slice(0, Array.isArray(data) && data.length === 1 ? 1 : 2)),
      error => error instanceof EmbeddingProviderFailure && error.code === 'malformed_response')
  }
})

test('server failures and malformed bodies expose only stable sanitized codes', async () => {
  const sentinel = 'server-secret-value'
  const failures = [
    new Response(sentinel, {status: 401}),
    new Response(sentinel, {status: 302, headers: {location: `https://attacker.example/${sentinel}`}}),
    new Response(`{"error":"${sentinel}"`),
  ]

  for (const response of failures) {
    const provider = new DashScopeEmbeddingProvider({
      baseUrl: 'https://dashscope.example/v1', apiKey: sentinel, dims: 2,
      fetch: () => Promise.resolve(response),
    })
    await assert.rejects(provider.embed(['safe']), error => {
      assert.ok(error instanceof EmbeddingProviderFailure)
      assert.equal(error.message.includes(sentinel), false)
      return true
    })
  }
})

test('preserves caller cancellation and sends no request for pre-aborted input', async () => {
  let calls = 0
  const provider = new DashScopeEmbeddingProvider({
    baseUrl: 'https://dashscope.example/v1', apiKey: 'key', dims: 2,
    fetch: async (_input, init) => {
      calls += 1
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const reason: unknown = init.signal?.reason
          reject(reason instanceof Error ? reason : new DOMException('This operation was aborted', 'AbortError'))
        }, {once: true})
      })
    },
  })
  const before = new AbortController()
  before.abort()
  await assert.rejects(provider.embed(['safe'], before.signal), {name: 'AbortError'})
  assert.equal(calls, 0)

  const during = new AbortController()
  const pending = provider.embed(['safe'], during.signal)
  during.abort()
  await assert.rejects(pending, {name: 'AbortError'})
  assert.equal(calls, 1)
})

test('rejects credential-bearing configuration and bounded invalid input before fetch', async () => {
  assert.throws(() => new DashScopeEmbeddingProvider({
    baseUrl: 'https://user:password@dashscope.example/v1', apiKey: 'key', dims: 2,
  }), error => error instanceof EmbeddingProviderFailure && error.code === 'configuration')

  let calls = 0
  const provider = new DashScopeEmbeddingProvider({
    baseUrl: 'https://dashscope.example/v1', apiKey: 'key', dims: 2,
    fetch: () => { calls += 1; return Promise.resolve(embeddingResponse([])) },
  })
  await assert.rejects(provider.embed(['token=credential-value-123456789']),
    error => error instanceof EmbeddingProviderFailure && error.code === 'sensitive_input')
  await assert.rejects(provider.embed(Array.from({length: 1_001}, () => 'safe')),
    error => error instanceof EmbeddingProviderFailure && error.code === 'invalid_input')
  assert.equal(calls, 0)
})

test('bounds embedding responses and converts an elapsed request deadline into a safe timeout', async t => {
  for (const response of [
    new Response('{}', {headers: {'content-length': String(4 * 1_024 * 1_024 + 1)}}),
    new Response(new ReadableStream<Uint8Array>({
      start(controller) {controller.enqueue(new Uint8Array(4 * 1_024 * 1_024 + 1))},
    })),
  ]) {
    const provider = new DashScopeEmbeddingProvider({
      baseUrl: 'https://dashscope.example/v1', apiKey: 'key', dims: 2,
      fetch: () => Promise.resolve(response),
    })
    await assert.rejects(provider.embed(['safe']),
      error => error instanceof EmbeddingProviderFailure && error.code === 'response_too_large')
  }

  const savedTimeout = AbortSignal.timeout.bind(AbortSignal)
  const keepAlive = setTimeout(() => undefined, 1000)
  t.after(() => clearTimeout(keepAlive))
  t.mock.method(AbortSignal, 'timeout', () => savedTimeout(5))
  const provider = new DashScopeEmbeddingProvider({
    baseUrl: 'https://dashscope.example/v1', apiKey: 'key', dims: 2,
    fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted test transport')), {once: true})
    }),
  })
  await assert.rejects(provider.embed(['safe']),
    error => error instanceof EmbeddingProviderFailure && error.code === 'timeout')
})
