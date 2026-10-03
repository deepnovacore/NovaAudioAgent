// First-run setup accepts only the chosen pipeline and the keys that pipeline needs.
export const SETUP_LLM_KEYS = Object.freeze({qwen: 'dashscopeApiKey', deepseek: 'deepseekApiKey', ark: 'arkApiKey'})
export const SETUP_KEYS = Object.freeze(['dashscopeApiKey', 'deepseekApiKey', 'arkApiKey', 'doubaoBigmodelApiKey'])

export function setupCommit(choice) {
  if (!choice || typeof choice !== 'object') throw new Error('invalid setup choice')
  const pipelineMode = choice.pipelineMode
  if (pipelineMode !== 'integrated' && pipelineMode !== 'cascaded') throw new Error('invalid setup choice')
  const llmProvider = pipelineMode === 'cascaded' ? choice.cascadedLlmProvider : null
  if (pipelineMode === 'cascaded' && !Object.hasOwn(SETUP_LLM_KEYS, llmProvider)) throw new Error('invalid setup choice')
  const allowed = pipelineMode === 'integrated' ? ['dashscopeApiKey'] : [SETUP_LLM_KEYS[llmProvider], 'doubaoBigmodelApiKey']
  const source = choice.secrets && typeof choice.secrets === 'object' ? choice.secrets : {}
  if (Object.keys(source).some(key => !allowed.includes(key))) throw new Error('invalid setup choice')
  const secrets = {}
  for (const key of allowed) if (typeof source[key] === 'string' && source[key].trim() !== '') secrets[key] = source[key].trim()
  return {settingsPatch: {pipelineMode, ...(llmProvider ? {cascadedLlmProvider: llmProvider} : {}), ...(Object.keys(secrets).length > 0 ? {secrets} : {})}}
}
