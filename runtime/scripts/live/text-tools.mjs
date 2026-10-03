import {dispatchSourceContext} from '../../dist/src/realtime/history.js'
import {cascadedResponseGuidance} from '../../dist/src/realtime/cascaded/llm.js'
import {createHash} from 'node:crypto'
import {z} from 'zod'
import {compileToolSchema} from '../../dist/src/core/tool-schema.js'
import {frontendInstructions} from '../../dist/src/realtime/frontend-instructions.js'
import {SEARCH_MANIFEST} from '../../dist/src/executors/search.js'
import {KNOWLEDGE_MCP_MANIFEST} from '../../dist/src/knowledge/mcp.js'
import {CODEX_PROJECT_MANIFEST, CODEX_AGENT_SUMMARY} from '../../dist/src/executors/codex/contract.js'
import {WATCH_MANIFEST, GUARD_MANIFEST} from '../../dist/src/executors/watcher.js'
import {VISION_AGENT_DESCRIPTOR} from '../../dist/src/executors/vision/controller-core.js'
import {createQwenCascadedLlmFactory} from '../../dist/src/realtime/cascaded/qwen-llm.js'
import {createArkCascadedLlmFactory} from '../../dist/src/realtime/cascaded/ark-llm.js'
import {loadSettings, resolveCascadedSelection, DASHSCOPE_COMPATIBLE_BASE_URL} from '../../dist/src/config/config.js'

export function surface(disabled = []) {
  const modules = Object.fromEntries(['coding', 'camera', 'search', 'knowledge'].map(name => [name, !disabled.includes(name)]))
  const manifests = [
    ...(modules.search ? [SEARCH_MANIFEST] : []),
    ...(modules.camera ? [WATCH_MANIFEST, GUARD_MANIFEST] : []),
    ...(modules.knowledge ? [KNOWLEDGE_MCP_MANIFEST] : []),
    ...(modules.coding ? [CODEX_PROJECT_MANIFEST] : []),
  ]
  const agentDescriptors = [
    ...(modules.coding ? [{name: 'codex', summary: CODEX_AGENT_SUMMARY, ownedChannels: ['codex']}] : []),
    ...(modules.camera ? [VISION_AGENT_DESCRIPTOR] : []),
  ]
  const tools = compileToolSchema(manifests, {includeMemoryRecall: true, agentDescriptors}).schemas.map(schema => schema.function)
  const instructions = frontendInstructions(modules, modules.coding)
  return {tools, instructions, hash: createHash('sha256').update(JSON.stringify({tools, instructions})).digest('hex')}
}

export function score(expect, observed, tools) {
  const failures = []
  const expected = expect.calls ?? []
  if (observed.calls.length !== expected.length) failures.push('call_count')
  for (const [index, call] of observed.calls.entries()) {
    const tool = tools.find(tool => tool.name === call.name)
    let args = call.arguments
    if (!tool) failures.push('unavailable_tool')
    else {
      const parsed = z.fromJSONSchema(tool.parameters).safeParse(call.arguments)
      if (!parsed.success) failures.push('invalid_arguments')
      else args = parsed.data
    }
    const wanted = expected[index]
    if (!wanted) continue
    if (wanted.name !== call.name) failures.push('wrong_tool')
    for (const [key, value] of Object.entries(wanted.args ?? {})) {
      if (JSON.stringify(args[key]) !== JSON.stringify(value)) failures.push(`argument:${key}`)
    }
    for (const [key, terms] of Object.entries(wanted.contains ?? {})) {
      const content = Array.isArray(args[key]) && args[key].every(value => typeof value === 'string') ? args[key].join('\n') : args[key]
      if (typeof content !== 'string' || terms.some(term => !content.includes(term))) failures.push(`missing_terms:${key}`)
    }
    for (const [key, groups] of Object.entries(wanted.containsAny ?? {})) {
      if (typeof args[key] !== 'string' || groups.some(terms => !terms.some(term => args[key].includes(term)))) failures.push(`missing_meaning:${key}`)
    }
    for (const [key, pattern] of Object.entries(wanted.notMatch ?? {})) {
      if (typeof args[key] === 'string' && new RegExp(pattern, 'u').test(args[key])) failures.push(`unsupported_argument:${key}`)
    }
  }
  if (expect.text === 'required' && !observed.text.trim()) failures.push('missing_text')
  if (expect.text === 'forbidden' && observed.text.trim()) failures.push('unexpected_text')
  if (expect.textAll?.some(terms => !terms.some(term => observed.text.includes(term)))) failures.push('missing_answer_evidence')
  if (expect.textAny && !expect.textAny.some(term => observed.text.includes(term))) failures.push('missing_answer_evidence')
  for (const term of expect.textNot ?? []) if (observed.text.includes(term)) failures.push('forbidden_answer')
  return [...new Set(failures)]
}

export function configuration(environment, provider, model) {
  const settings = loadSettings({...environment, PIPELINE_MODE: 'cascaded',
    ...(provider ? {CASCADE_LLM_PROVIDER: provider} : {}),
    ...(model ? {CASCADE_LLM_MODEL: model} : {})})
  const selected = resolveCascadedSelection(settings)
  return {provider: selected.llmProvider, model: selected.llmModel,
    apiKey: selected.llmProvider === 'qwen' ? settings.dashscope_api_key : settings.ark_api_key,
    baseUrl: selected.llmProvider === 'qwen' ? DASHSCOPE_COMPATIBLE_BASE_URL : settings.volcengine_ark_base_url}
}

export async function runTextCase(testCase, config, timeoutMs, factoryOverride) {
  const compiled = surface(testCase.disabled)
  const factory = factoryOverride ?? (config.provider === 'qwen' ? createQwenCascadedLlmFactory : createArkCascadedLlmFactory)
  const session = factory({...config, instructions: compiled.instructions}).open()
  const observations = []
  const userSources = []
  const failures = []
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    let inputs = [{kind: 'user_text', text: testCase.text}]
    for (const [index, step] of testCase.steps.entries()) {
      for (const item of inputs) if (item.kind === 'user_text') userSources.push({ref: `conversation:${userSources.length + 1}`, text: item.text})
      const observed = {calls: [], text: '', completed: false}
      observations.push(observed)
      for await (const event of session.stream({inputs, tools: compiled.tools,
        workspaceContext: testCase.context, responseAdaptation: [dispatchSourceContext(userSources.slice(-8)), cascadedResponseGuidance(true)].filter(Boolean).join('\n'), signal})) {
        if (event.kind === 'tool_call') observed.calls.push({name: event.name, arguments: event.arguments, call_id: event.call_id})
        if (event.kind === 'text_delta') observed.text += event.text
        if (event.kind === 'response_completed') observed.completed = true
        if (event.kind === 'response_failed') throw Object.assign(new Error('provider_failure'), {code: event.code})
      }
      if (!observed.completed) failures.push(`${index}:missing_terminal`)
      if (step.otherwise && observed.calls.length === 0) {
        failures.push(...score(step.otherwise, observed, compiled.tools).map(reason => `${index}:${reason}`))
        break
      }
      failures.push(...score(step.expect, observed, compiled.tools).map(reason => `${index}:${reason}`))
      // Never execute a tool: only synthetic fixture outputs may continue a model response.
      if (failures.length) break
      if (step.user !== undefined) { inputs = [{kind: 'user_text', text: step.user}]; continue }
      if (step.result === undefined) break
      if (observed.calls.length !== 1) { failures.push(`${index}:continuation_requires_one_call`); break }
      inputs = [{kind: 'tool_result', call_id: observed.calls[0].call_id, output: step.result}]
    }
    return {status: failures.length ? 'failed' : 'passed', failures, observations, surfaceHash: compiled.hash}
  } catch (error) {
    const code = ['network','http','timeout','aborted','configuration','protocol','overflow','closed'].includes(error.code) ? error.code : 'runner_error'
    return {status: ['protocol','overflow'].includes(code) ? 'failed' : 'error', reason: code, observations, surfaceHash: compiled.hash}
  } finally { await session.close() }
}
