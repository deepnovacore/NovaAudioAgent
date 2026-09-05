import {SensitiveContentPolicy, SensitivePathPolicy} from '../workspace-graph/sensitivity.js'

const MAX_BATCH = 10
const MAX_INPUTS = 1_000
const MAX_INPUT_CODE_POINTS = 32_768
const MAX_REQUEST_BYTES = 1 * 1_024 * 1_024
const MAX_RESPONSE_BYTES = 4 * 1_024 * 1_024
const REQUEST_TIMEOUT_MS = 10_000

const contentPolicy = new SensitiveContentPolicy()
const pathPolicy = new SensitivePathPolicy()

export interface EmbeddingProvider {
  readonly id: string
  readonly dims: number
  embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]>
}

export interface DashScopeEmbeddingProviderOptions {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model?: string
  readonly dims?: number
  readonly fetch?: typeof fetch
}

export class EmbeddingProviderFailure extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'EmbeddingProviderFailure'
  }
}

/** Bounded OpenAI-compatible DashScope embeddings client. */
export class DashScopeEmbeddingProvider implements EmbeddingProvider {
  readonly id: string
  readonly dims: number
  readonly #apiKey: string
  readonly #model: string
  readonly #endpoint: string
  readonly #fetch: typeof fetch

  constructor(options: DashScopeEmbeddingProviderOptions) {
    const model = options.model ?? 'text-embedding-v4'
    const dims = options.dims ?? 1_024
    if (typeof options.apiKey !== 'string' || options.apiKey === '' || options.apiKey.length > 4_096
      || !/^[A-Za-z0-9._/-]{1,200}$/u.test(model)
      || !Number.isSafeInteger(dims) || dims < 1 || dims > 4_096) {
      throw new EmbeddingProviderFailure('configuration')
    }
    let base: URL
    try { base = new URL(options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`) } catch {
      throw new EmbeddingProviderFailure('configuration')
    }
    if ((base.protocol !== 'https:' && base.protocol !== 'http:') || base.username !== ''
      || base.password !== '' || base.search !== '' || base.hash !== '') {
      throw new EmbeddingProviderFailure('configuration')
    }
    this.#apiKey = options.apiKey
    this.#model = model
    this.dims = dims
    this.id = `dashscope:${model}:${dims}`
    this.#endpoint = new URL('embeddings', base).href
    this.#fetch = options.fetch ?? fetch
  }

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]> {
    signal?.throwIfAborted()
    validateInputs(texts)
    if (texts.length === 0) return []
    const vectors: Float32Array[] = []
    for (let offset = 0; offset < texts.length; offset += MAX_BATCH) {
      signal?.throwIfAborted()
      vectors.push(...await this.#embedBatch(texts.slice(offset, offset + MAX_BATCH), signal))
    }
    return vectors
  }

  async #embedBatch(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const body = JSON.stringify({
      model: this.#model,
      input: texts,
      dimensions: this.dims,
      encoding_format: 'float',
    })
    if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
      throw new EmbeddingProviderFailure('invalid_input')
    }
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    let response: Response
    try {
      response = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: {Authorization: `Bearer ${this.#apiKey}`, 'Content-Type': 'application/json'},
        body,
        redirect: 'manual',
        signal: combined,
      })
    } catch {
      if (signal?.aborted === true) signal.throwIfAborted()
      throw new EmbeddingProviderFailure(timeout.aborted ? 'timeout' : 'transport')
    }
    try {
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel()
        throw new EmbeddingProviderFailure('redirect')
      }
      if (!response.ok) {
        void response.body?.cancel()
        throw new EmbeddingProviderFailure(response.status === 401 || response.status === 403
          ? 'authentication' : response.status === 429 ? 'rate_limited' : 'provider_error')
      }
      const bytes = await readBounded(response)
      let parsed: unknown
      try { parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) } catch {
        throw new EmbeddingProviderFailure('malformed_response')
      }
      return parseVectors(parsed, texts.length, this.dims)
    } catch (cause) {
      if (signal?.aborted === true) signal.throwIfAborted()
      if (cause instanceof EmbeddingProviderFailure) throw cause
      throw new EmbeddingProviderFailure(timeout.aborted ? 'timeout' : 'transport')
    }
  }
}

function validateInputs(texts: readonly string[]): void {
  if (!Array.isArray(texts) || texts.length > MAX_INPUTS) throw new EmbeddingProviderFailure('invalid_input')
  for (const text of texts) {
    if (typeof text !== 'string' || text.trim() === '' || [...text].length > MAX_INPUT_CODE_POINTS) {
      throw new EmbeddingProviderFailure('invalid_input')
    }
    if (contentPolicy.scrub('embedding', text).kind !== 'clean'
      || pathPolicy.scrubText('embedding', text).kind !== 'clean') {
      throw new EmbeddingProviderFailure('sensitive_input')
    }
  }
}

async function readBounded(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    void response.body?.cancel()
    throw new EmbeddingProviderFailure('response_too_large')
  }
  if (response.body === null) throw new EmbeddingProviderFailure('malformed_response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const chunk: {readonly done?: boolean; readonly value?: Uint8Array} = await reader.read()
      if (chunk.done) break
      if (chunk.value === undefined) continue
      total += chunk.value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new EmbeddingProviderFailure('response_too_large')
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function parseVectors(value: unknown, count: number, dims: number): Float32Array[] {
  if (!plainObject(value) || !Array.isArray(value.data) || value.data.length !== count) {
    throw new EmbeddingProviderFailure('malformed_response')
  }
  const vectors = new Array<Float32Array | undefined>(count)
  for (const item of value.data) {
    if (!plainObject(item) || !Number.isSafeInteger(item.index) || (item.index as number) < 0
      || (item.index as number) >= count || vectors[item.index as number] !== undefined
      || !Array.isArray(item.embedding) || item.embedding.length !== dims
      || !item.embedding.every(number => typeof number === 'number' && Number.isFinite(number))) {
      throw new EmbeddingProviderFailure('malformed_response')
    }
    const vector = Float32Array.from(item.embedding as number[])
    if (!vector.every(number => Number.isFinite(number))) {
      throw new EmbeddingProviderFailure('malformed_response')
    }
    vectors[item.index as number] = vector
  }
  if (vectors.some(vector => vector === undefined)) throw new EmbeddingProviderFailure('malformed_response')
  return vectors as Float32Array[]
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
