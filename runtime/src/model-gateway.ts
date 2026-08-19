/**
 * Provider-neutral model gateway plus the OpenAI-compatible implementation.
 *
 * Ported from `src/nova_audio_agent/model_gateway.py`. The request body is
 * model-visible, so its exact shape is pinned by a Python-exported golden.
 *
 * Python builds this through the `openai` SDK; Node uses `fetch` and parses the SSE
 * stream directly, which keeps the runtime free of a provider SDK. The wire payload is
 * what must match, not the client library.
 */

import { z } from 'zod'
import type { Clock } from './clock.js'
import type { JsonValue } from './events.js'

export interface GatewayTextDelta {
  readonly kind: 'text'
  readonly text: string
}

export interface GatewayToolCallDelta {
  readonly kind: 'tool_call'
  readonly index: number
  readonly name: string
  readonly arguments: string
}

export type GatewayDelta = GatewayTextDelta | GatewayToolCallDelta

export interface GatewayCompletion {
  readonly text: string
}

export interface GatewayImage {
  readonly ref: string
  readonly media_type: string
  readonly payload: Uint8Array
}

export interface ModelMetrics {
  readonly model: string
  readonly image_count: number
  readonly request_id: string | null
  readonly latency: number
  readonly input_tokens: number | null
  readonly output_tokens: number | null
  readonly finish_reason: string | null
  readonly error_type: string | null
}

export interface MetricsSink {
  record(metrics: ModelMetrics): void
}

export interface StreamRequest {
  readonly model: string
  readonly system: string
  readonly prompt: string
  readonly tools?: readonly Readonly<Record<string, JsonValue>>[]
  readonly images?: readonly GatewayImage[]
  readonly signal?: AbortSignal
}

export interface CompleteRequest {
  readonly model: string
  readonly system: string
  readonly prompt: string
  readonly jsonSchema?: Readonly<Record<string, JsonValue>> | null
  readonly images?: readonly GatewayImage[]
  readonly signal?: AbortSignal
}

export interface ModelGateway {
  stream(request: StreamRequest): AsyncIterable<GatewayDelta>
  complete(request: CompleteRequest): Promise<GatewayCompletion>
}

/** A provider failure whose message carries only a stable classification. */
export class GatewayError extends Error {
  constructor(classification: string) {
    // Python interpolates the CPython exception type name here. That name cannot
    // exist in Node, so this uses a stable classification instead, the same choice
    // made for ExecutorContractError. The text is diagnostic only and never becomes
    // durable evidence: a model port failure reaches the reducer as `port_failure`.
    super(`模型请求失败（${classification}）`)
    this.name = 'GatewayError'
  }
}

class LoggingMetrics implements MetricsSink {
  record(metrics: ModelMetrics): void {
    // Prompts and outputs are deliberately absent: only shape and identity.
    process.stderr.write(
      `[model-diagnostic] model_call model=${metrics.model} images=${metrics.image_count} `
      + `request_id=${metrics.request_id ?? 'None'} latency=${metrics.latency.toFixed(3)} `
      + `input_tokens=${metrics.input_tokens ?? 'None'} `
      + `output_tokens=${metrics.output_tokens ?? 'None'} `
      + `finish_reason=${metrics.finish_reason ?? 'None'} `
      + `error_type=${metrics.error_type ?? 'None'}\n`,
    )
  }
}

/**
 * Bind each image to its ref with a label part immediately before it.
 *
 * Position alone cannot carry the binding. Images are emitted in candidate order
 * (camera first, then attachments newest-first, because that is the order the byte
 * budget demotes in) while the prompt lists refs in view order, and with several
 * attachments the two are reversed relative to each other. A model handed N unlabeled
 * images then cannot say which ref it is describing, which breaks the "compare these
 * three photos" case the design exists to support.
 */
export function imageParts(
  images: readonly GatewayImage[],
): Readonly<Record<string, JsonValue>>[] {
  const parts: Readonly<Record<string, JsonValue>>[] = []
  for (const image of images) {
    const encoded = Buffer.from(image.payload).toString('base64')
    parts.push({type: 'text', text: `[${image.ref}]`})
    parts.push({
      type: 'image_url',
      image_url: {url: `data:${image.media_type};base64,${encoded}`},
    })
  }
  return parts
}

function userContent(
  prompt: string,
  images: readonly GatewayImage[],
): JsonValue {
  if (images.length === 0) return prompt
  return [{type: 'text', text: prompt}, ...imageParts(images)]
}

/** The request body for a streaming call, exactly as the provider receives it. */
export function streamRequestBody(request: StreamRequest): Readonly<Record<string, JsonValue>> {
  const images = request.images ?? []
  const tools = request.tools ?? []
  const body: Record<string, JsonValue> = {
    model: request.model,
    messages: [
      {role: 'system', content: request.system},
      {role: 'user', content: userContent(request.prompt, images)},
    ],
    stream: true,
    stream_options: {include_usage: true},
  }
  if (tools.length > 0) {
    body.tools = tools as JsonValue
    body.parallel_tool_calls = false
  }
  return body
}

/** The request body for a non-streaming call, exactly as the provider receives it. */
export function completeRequestBody(
  request: CompleteRequest,
): Readonly<Record<string, JsonValue>> {
  const images = request.images ?? []
  const body: Record<string, JsonValue> = {
    model: request.model,
    messages: [
      {role: 'system', content: request.system},
      {role: 'user', content: userContent(request.prompt, images)},
    ],
  }
  // Python passes only `{"type": "json_object"}`; the schema itself gates the call
  // rather than travelling to the provider.
  if (request.jsonSchema !== undefined && request.jsonSchema !== null) {
    body.response_format = {type: 'json_object'}
  }
  return body
}

const usageSchema = z.object({
  prompt_tokens: z.number().int().nullish(),
  completion_tokens: z.number().int().nullish(),
}).loose()

const toolCallSchema = z.object({
  index: z.number().int().nonnegative(),
  function: z.object({
    name: z.string().nullish(),
    arguments: z.string().nullish(),
  }).loose().nullish(),
}).loose()

const chunkSchema = z.object({
  id: z.string().nullish(),
  usage: usageSchema.nullish(),
  choices: z.array(z.object({
    finish_reason: z.string().nullish(),
    delta: z.object({
      content: z.string().nullish(),
      tool_calls: z.array(toolCallSchema).nullish(),
    }).loose().nullish(),
  }).loose()).nullish(),
}).loose()

const completionSchema = z.object({
  id: z.string().nullish(),
  usage: usageSchema.nullish(),
  choices: z.array(z.object({
    finish_reason: z.string().nullish(),
    message: z.object({content: z.string().nullish()}).loose(),
  }).loose()).min(1),
}).loose()

export interface OpenAIGatewayOptions {
  readonly baseUrl: string
  readonly apiKey: string
  readonly clock: Clock
  readonly metrics?: MetricsSink
  readonly fetch?: typeof globalThis.fetch
  readonly requestTimeout?: number
}

/** OpenAI-compatible transport. Prompts and outputs never enter metrics or logs. */
export class OpenAIModelGateway implements ModelGateway {
  readonly #endpoint: string
  readonly #apiKey: string
  readonly #clock: Clock
  readonly #metrics: MetricsSink
  readonly #fetch: typeof globalThis.fetch
  readonly #requestTimeout: number

  constructor(options: OpenAIGatewayOptions) {
    if (!options.baseUrl || !options.apiKey) {
      throw new TypeError('baseUrl and apiKey are required')
    }
    this.#endpoint = `${options.baseUrl.replace(/\/+$/u, '')}/chat/completions`
    this.#apiKey = options.apiKey
    this.#clock = options.clock
    this.#metrics = options.metrics ?? new LoggingMetrics()
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#requestTimeout = options.requestTimeout ?? 120
  }

  async *stream(request: StreamRequest): AsyncIterable<GatewayDelta> {
    const started = this.#clock.now()
    const images = request.images ?? []
    let requestId: string | null = null
    let inputTokens: number | null = null
    let outputTokens: number | null = null
    let finishReason: string | null = null
    let errorType: string | null = null
    try {
      const response = await this.#post(streamRequestBody(request), request.signal)
      for await (const event of readServerSentEvents(response)) {
        const parsed = chunkSchema.safeParse(event)
        if (!parsed.success) continue
        const chunk = parsed.data
        requestId = chunk.id ?? requestId
        if (chunk.usage != null) {
          inputTokens = chunk.usage.prompt_tokens ?? inputTokens
          outputTokens = chunk.usage.completion_tokens ?? outputTokens
        }
        for (const choice of chunk.choices ?? []) {
          finishReason = choice.finish_reason ?? finishReason
          const delta = choice.delta
          if (delta == null) continue
          if (delta.content != null && delta.content !== '') {
            yield {kind: 'text', text: delta.content}
          }
          for (const tool of delta.tool_calls ?? []) {
            yield {
              kind: 'tool_call',
              index: tool.index,
              name: tool.function?.name ?? '',
              arguments: tool.function?.arguments ?? '',
            }
          }
        }
      }
    } catch (error) {
      errorType = classify(error)
      throw new GatewayError(errorType)
    } finally {
      this.#record(request.model, images.length, started, {
        requestId, inputTokens, outputTokens, finishReason, errorType,
      })
    }
  }

  async complete(request: CompleteRequest): Promise<GatewayCompletion> {
    const started = this.#clock.now()
    const images = request.images ?? []
    let requestId: string | null = null
    let inputTokens: number | null = null
    let outputTokens: number | null = null
    let finishReason: string | null = null
    let errorType: string | null = null
    try {
      const response = await this.#post(completeRequestBody(request), request.signal)
      const payload = completionSchema.parse(await response.json())
      requestId = payload.id ?? null
      if (payload.usage != null) {
        inputTokens = payload.usage.prompt_tokens ?? null
        outputTokens = payload.usage.completion_tokens ?? null
      }
      const choice = payload.choices[0]!
      finishReason = choice.finish_reason ?? null
      return {text: choice.message.content ?? ''}
    } catch (error) {
      errorType = classify(error)
      throw new GatewayError(errorType)
    } finally {
      this.#record(request.model, images.length, started, {
        requestId, inputTokens, outputTokens, finishReason, errorType,
      })
    }
  }

  async #post(
    body: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(this.#requestTimeout * 1000)
    const response = await this.#fetch(this.#endpoint, {
      method: 'POST',
      headers: {
        // The credential rides in the header and never in a log line or metric.
        authorization: `Bearer ${this.#apiKey}`,
        'content-type': 'application/json',
        accept: body.stream === true ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(body),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    })
    if (!response.ok) {
      // The provider's body can echo the prompt, so only the status is kept.
      throw new GatewayError(`HTTPStatus${response.status}`)
    }
    return response
  }

  #record(
    model: string,
    imageCount: number,
    started: number,
    outcome: {
      readonly requestId: string | null
      readonly inputTokens: number | null
      readonly outputTokens: number | null
      readonly finishReason: string | null
      readonly errorType: string | null
    },
  ): void {
    this.#metrics.record({
      model,
      image_count: imageCount,
      request_id: outcome.requestId,
      latency: this.#clock.now() - started,
      input_tokens: outcome.inputTokens,
      output_tokens: outcome.outputTokens,
      finish_reason: outcome.finishReason,
      error_type: outcome.errorType,
    })
  }
}

function classify(error: unknown): string {
  if (error instanceof GatewayError) {
    const match = /（(.+)）/u.exec(error.message)
    return match?.[1] ?? 'GatewayError'
  }
  if (error instanceof Error) {
    return error.name === 'TimeoutError' || error.name === 'AbortError'
      ? error.name
      : 'TransportError'
  }
  return 'UnknownError'
}

/**
 * Parse a `text/event-stream` body into decoded `data:` payloads.
 *
 * Events are separated by a blank line and a single event may carry several `data:`
 * lines that concatenate. `[DONE]` terminates the stream without being delivered.
 */
export async function *readServerSentEvents(response: Response): AsyncIterable<unknown> {
  const body = response.body
  if (body === null) throw new GatewayError('EmptyBody')
  const decoder = new TextDecoder()
  let buffered = ''
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffered += decoder.decode(chunk, {stream: true})
    let boundary = nextBoundary(buffered)
    while (boundary !== null) {
      const block = buffered.slice(0, boundary.index)
      buffered = buffered.slice(boundary.index + boundary.length)
      const payload = dataOf(block)
      if (payload === '[DONE]') return
      if (payload !== null) yield JSON.parse(payload)
      boundary = nextBoundary(buffered)
    }
  }
  const trailing = dataOf(buffered)
  if (trailing !== null && trailing !== '[DONE]') yield JSON.parse(trailing)
}

function nextBoundary(buffered: string): {readonly index: number, readonly length: number} | null {
  const doubleNewline = buffered.indexOf('\n\n')
  const crlf = buffered.indexOf('\r\n\r\n')
  if (crlf !== -1 && (doubleNewline === -1 || crlf < doubleNewline)) {
    return {index: crlf, length: 4}
  }
  return doubleNewline === -1 ? null : {index: doubleNewline, length: 2}
}

function dataOf(block: string): string | null {
  const payloads = block
    .split(/\r?\n/u)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).replace(/^ /u, ''))
  return payloads.length === 0 ? null : payloads.join('')
}
