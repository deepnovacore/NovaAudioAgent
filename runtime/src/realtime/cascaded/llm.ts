import type { JsonValue } from '../../events.js'
import type { JsonObject } from '../protocol.js'

export const MAX_CASCADED_LLM_HISTORY_ITEMS = 64
export const MAX_CASCADED_LLM_HISTORY_CODEPOINTS = 131_072
export const GUARD_ACTIVATION_PREFIX = 'Nova Audio Agent 宿主激活事实：'

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
  /** Discards only an unfinished response continuation, retaining completed history. */
  abandonPendingResponse(): Promise<void>
  close(): Promise<void>
}

export interface CascadedLlmFactory {
  open(): CascadedLlmSession
}
