// Pure (no node:fs / node:crypto) so backend.mjs can import it without loading
// settings-store.mjs, and a missing/corrupt settings file never produces the
// literal string "undefined" in a child's environment. settings-store.mjs
// spreads RUNTIME_DEFAULTS into DEFAULT_SETTINGS, so the two cannot diverge.
export const RUNTIME_DEFAULTS = Object.freeze({
  proactivity: 'balanced',
  codexHeartbeatSeconds: 30,
  pipelineMode: 'cascaded',
  integratedProvider: 'qwen',
  integratedModel: 'qwen-audio-3.0-realtime-plus',
  integratedVoice: 'longanqian',
  cascadedEndpointingProvider: 'auto',
  cascadedAsrProvider: 'volcengine',
  cascadedLlmProvider: 'deepseek',
  cascadedLlmModels: Object.freeze({
    qwen: 'qwen-plus',
    ark: 'doubao-seed-2-0-pro-260215',
    deepseek: 'deepseek-flash',
    openai: 'gpt-6-luna',
    gemini: 'gemini-3.5-flash-lite',
  }),
  cascadedTtsProvider: 'volcengine',
  cascadedTtsVoice: 'zh_female_vv_uranus_bigtts',
  codexApprovalMode: 'ask',
  clarificationDepth: 'balanced',
  planReadback: 'summary',
  generatePlan: true,
  plannerModel: '',
  progressBubbles: 'milestones',
  embeddingProvider: 'dashscope',
  embeddingModel: 'text-embedding-v4',
  capabilitiesConfigPath: '',
  knowledgePath: '',
})

// Node refuses a C0 control character in a child's environment value and throws
// out of `spawn`, so a stored secret that somehow carries one must be dropped
// rather than take the launch — and with it the app — down before the panel can
// clear it.
export const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
