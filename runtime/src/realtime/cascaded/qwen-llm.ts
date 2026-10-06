/** Compatibility entry point; new providers use the explicit Chat Completions factory. */
import {createChatCompletionsLlmFactory, type ChatCompletionsLlmFactoryOptions} from './chat-completions-llm.js'
export {
  ChatCompletionsLlmFailure as QwenCascadedLlmFailure,
  type ChatCompletionsLlmFailureCode as QwenCascadedLlmFailureCode,
  MAX_CASCADED_LLM_HISTORY_CODEPOINTS,
  MAX_CASCADED_LLM_HISTORY_ITEMS,
} from './chat-completions-llm.js'

export type QwenCascadedLlmFactoryOptions = Omit<ChatCompletionsLlmFactoryOptions, 'provider'> & {
  readonly provider?: ChatCompletionsLlmFactoryOptions['provider']
}

export function createQwenCascadedLlmFactory(options: QwenCascadedLlmFactoryOptions) {
  return createChatCompletionsLlmFactory({...options, provider: options.provider ?? 'qwen'})
}
