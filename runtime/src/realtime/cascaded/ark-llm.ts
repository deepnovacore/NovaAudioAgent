import { jsonValueSchema, type JsonValue } from '../../events.js'
import { codePointLengthLikePython, stripLikePython } from '../../python-text.js'
import { MAX_REALTIME_TEXT, type JsonObject } from '../protocol.js'
import {
  ArkResponsesFailure,
  createFetchArkResponsesGateway,
  type ArkResponsesFailureCode,
  type ArkResponsesGateway,
  type FetchArkResponsesGatewayOptions,
} from '../volcengine/ark.js'
import type {
  CascadedLlmEvent,
  CascadedLlmFactory,
  CascadedLlmInput,
  CascadedLlmSession,
  CascadedLlmTool,
} from './llm.js'

export type ArkCascadedLlmFailureCode = ArkResponsesFailureCode

export class ArkCascadedLlmFailure extends Error {
  constructor(readonly code: ArkCascadedLlmFailureCode, readonly statusCode: number | null = null) {
    super(`Ark cascaded LLM ${code} failure`)
    this.name = 'ArkCascadedLlmFailure'
  }
}

export type ArkCascadedLlmFactoryOptions = FetchArkResponsesGatewayOptions

function fail(code: ArkCascadedLlmFailureCode, statusCode: number | null = null): ArkCascadedLlmFailure {
  return new ArkCascadedLlmFailure(code, statusCode)
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && stripLikePython(value) !== ''
    && codePointLengthLikePython(value) <= MAX_REALTIME_TEXT
}

function jsonObject(value: unknown): value is JsonObject {
  return value !== null && !Array.isArray(value) && typeof value === 'object'
    && jsonValueSchema.safeParse(value).success
}

/** Translates the legacy OpenAI function shape at the semantic adapter boundary. */
export function responsesToolSchema(schema: JsonObject): JsonObject {
  const functionObject = schema.function
  if (schema.type !== 'function' || functionObject === null || Array.isArray(functionObject)
    || typeof functionObject !== 'object') {
    throw fail('protocol')
  }
  const candidate = functionObject as Readonly<Record<string, JsonValue>>
  const name = candidate.name
  const parameters = candidate.parameters
  if (!validIdentifier(name) || !jsonObject(parameters)) throw fail('protocol')
  const description = candidate.description
  if (description !== undefined && typeof description !== 'string') throw fail('protocol')
  return {
    type: 'function', name,
    ...(description !== undefined && stripLikePython(description) !== '' ? {description} : {}),
    parameters: structuredClone(parameters),
  }
}

function inputItem(input: CascadedLlmInput): JsonObject {
  if (input.kind === 'tool_result') {
    return {type: 'function_call_output', call_id: input.call_id, output: JSON.stringify(input.output)}
  }
  return {role: 'user', content: input.kind === 'user_text' ? input.text : input.content}
}

function toolSchema(tool: CascadedLlmTool): JsonObject {
  return responsesToolSchema({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description === undefined ? {} : {description: tool.description}),
      parameters: structuredClone(tool.parameters),
    },
  })
}

class Session implements CascadedLlmSession {
  readonly #gateway: ArkResponsesGateway
  #previousResponseId: string | null = null
  #closed = false

  constructor(gateway: ArkResponsesGateway) {
    this.#gateway = gateway
  }

  async *stream(input: {
    readonly inputs: readonly CascadedLlmInput[]
    readonly tools: readonly CascadedLlmTool[]
    readonly signal: AbortSignal
  }): AsyncIterable<CascadedLlmEvent> {
    if (this.#closed) throw fail('closed')
    if (input.signal.aborted) throw fail('aborted')
    let responseId: string | null = null
    let terminal = false
    try {
      for await (const event of this.#gateway.stream({
        inputItems: input.inputs.map(inputItem),
        tools: input.tools.map(toolSchema),
        previousResponseId: this.#previousResponseId,
        signal: input.signal,
      })) {
        if (event.kind === 'response_started') {
          if (responseId !== null) throw fail('protocol')
          responseId = event.response_id
          yield event
        } else if (event.kind === 'text_delta' || event.kind === 'tool_call') {
          if (responseId === null) throw fail('protocol')
          yield event
        } else if (event.kind === 'response_completed') {
          if (responseId === null || event.response_id !== responseId) throw fail('protocol')
          this.#previousResponseId = event.response_id
          terminal = true
          yield event
          return
        } else {
          if (responseId !== null && event.response_id !== responseId) throw fail('protocol')
          this.#previousResponseId = null
          terminal = true
          yield event
          return
        }
      }
      throw fail('protocol')
    } catch (error) {
      const stable = error instanceof ArkCascadedLlmFailure
        ? error
        : error instanceof ArkResponsesFailure
          ? fail(error.code, error.statusCode)
          : fail(this.#closed ? 'closed' : input.signal.aborted ? 'aborted' : 'network')
      this.#previousResponseId = null
      if (responseId !== null && !terminal) {
        yield {kind: 'response_failed', response_id: responseId, code: stable.code}
        return
      }
      throw stable
    }
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#previousResponseId = null
    await this.#gateway.close()
  }
}

export function createArkCascadedLlmFactory(
  options: ArkCascadedLlmFactoryOptions,
): CascadedLlmFactory {
  return {open: () => new Session(createFetchArkResponsesGateway(options))}
}
