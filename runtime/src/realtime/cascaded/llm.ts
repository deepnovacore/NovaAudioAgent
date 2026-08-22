import type { JsonValue } from '../../events.js'
import type { JsonObject } from '../protocol.js'

export type CascadedLlmInput =
  | {readonly kind: 'user_text'; readonly text: string}
  | {readonly kind: 'host_context'; readonly content: string}
  | {readonly kind: 'packed_history'; readonly content: string}
  | {readonly kind: 'tool_result'; readonly call_id: string; readonly output: JsonValue}

export interface CascadedLlmTool {
  readonly name: string
  readonly description?: string
  readonly parameters: JsonObject
}

export type CascadedLlmEvent =
  | {readonly kind: 'response_started'; readonly response_id: string}
  | {readonly kind: 'text_delta'; readonly text: string}
  | {readonly kind: 'tool_call'; readonly item_id: string; readonly call_id: string; readonly name: string; readonly arguments: JsonObject}
  | {readonly kind: 'response_completed'; readonly response_id: string}
  | {readonly kind: 'response_failed'; readonly response_id: string; readonly code: string}

export interface CascadedLlmSession {
  stream(input: {
    readonly inputs: readonly CascadedLlmInput[]
    readonly tools: readonly CascadedLlmTool[]
    readonly signal: AbortSignal
  }): AsyncIterable<CascadedLlmEvent>
  close(): Promise<void>
}

export interface CascadedLlmFactory {
  open(): CascadedLlmSession
}
