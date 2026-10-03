import assert from 'node:assert/strict'
import {test} from 'node:test'
import {parseCapabilityRegistry} from '../src/config/capability-registry.js'
import {
  BlockingConfigurationError,
  capabilitiesFromSettings,
  ConfigurationError,
  describeMissingBlockingCredentials,
  describeMissingBlockingEnvironment,
  loadSettings,
  missingKnowledgeCredential,
  missingWatchModelCredential,
  requireBlockingCredentials,
  withoutUncredentialedModules,
} from '../src/config/config.js'
import {desktopConfigurationFailure} from '../src/desktop/desktop-control.js'

test('system LANGUAGE does not override or invalidate the prompt language', () => {
  assert.equal(loadSettings({LANGUAGE: 'en_US:en'}).language, 'zh-CN')
  assert.equal(loadSettings({LANGUAGE: 'en_US:en', PROMPT_LANGUAGE: 'en'}).language, 'en')
  assert.throws(() => loadSettings({PROMPT_LANGUAGE: 'invalid'}), /PROMPT_LANGUAGE/u)
})

test('settings-based assemblies retain the DashScope search fallback', () => {
  const search = capabilitiesFromSettings(loadSettings({DASHSCOPE_API_KEY: 'test-key'})).modules.search
  assert.equal(search.enabled, true)
  assert.equal(search.provider, 'mcp')
  assert.equal(search.fallback, 'bailian_mcp')
})

test('blocking credentials name only the selected pipeline minimum', () => {
  assert.deepEqual(describeMissingBlockingCredentials(loadSettings({})), {pipeline: 'integrated', missing: ['DASHSCOPE_API_KEY']})
  assert.deepEqual(describeMissingBlockingCredentials(loadSettings({DASHSCOPE_API_KEY: 'k'})), {pipeline: 'integrated', missing: []})
  // Search, camera and memory keys are never blocking.
  assert.deepEqual(describeMissingBlockingCredentials(loadSettings({DASHSCOPE_API_KEY: 'k', TAVILY_API_KEY: ''})).missing, [])
  const cascaded = (environment: NodeJS.ProcessEnv) => describeMissingBlockingCredentials(loadSettings({PIPELINE_MODE: 'cascaded', ...environment}))
  assert.deepEqual(cascaded({CASCADE_LLM_PROVIDER: 'deepseek'}), {pipeline: 'cascaded', missing: ['DEEPSEEK_API_KEY', 'DOUBAO_BIGMODEL_API_KEY']})
  assert.deepEqual(cascaded({CASCADE_LLM_PROVIDER: 'qwen', DOUBAO_BIGMODEL_API_KEY: 'v'}).missing, ['DASHSCOPE_API_KEY'])
  assert.deepEqual(cascaded({CASCADE_LLM_PROVIDER: 'ark', DOUBAO_BIGMODEL_API_KEY: 'v'}).missing, ['ARK_API_KEY'])
  assert.deepEqual(cascaded({CASCADE_LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'd', DOUBAO_BIGMODEL_API_KEY: 'v'}).missing, [])
})

test('the blocking check throws a named configuration error without echoing values', () => {
  assert.doesNotThrow(() => requireBlockingCredentials(loadSettings({DASHSCOPE_API_KEY: 'k'})))
  assert.throws(() => requireBlockingCredentials(loadSettings({PIPELINE_MODE: 'cascaded', CASCADE_LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'secret-value'})), error => {
    assert.ok(error instanceof BlockingConfigurationError)
    assert.ok(error instanceof ConfigurationError)
    assert.equal(error.pipeline, 'cascaded')
    assert.deepEqual(error.missing, ['DOUBAO_BIGMODEL_API_KEY'])
    assert.doesNotMatch(error.message, /secret-value/u)
    return true
  })
})

test('host preflight leaves unrelated configuration errors to the runtime', () => {
  assert.deepEqual(describeMissingBlockingEnvironment({}), {pipeline: 'integrated', missing: ['DASHSCOPE_API_KEY']})
  assert.equal(describeMissingBlockingEnvironment({PIPELINE_MODE: 'unknown'}), null)
})

test('search falls back to the DashScope preset, else turns off, and never blocks', () => {
  const tavily = parseCapabilityRegistry({version: 1}, {TAVILY_API_KEY: 't', DASHSCOPE_API_KEY: 'k'}).modules.search
  assert.equal(tavily.enabled, true)
  assert.equal(tavily.provider, 'tavily')
  assert.equal(tavily.fallback, undefined)
  const bailian = parseCapabilityRegistry({version: 1}, {DASHSCOPE_API_KEY: 'k'}).modules.search
  assert.equal(bailian.enabled, true)
  assert.equal(bailian.provider, 'mcp')
  assert.equal(bailian.fallback, 'bailian_mcp')
  assert.equal(bailian.reason, 'missing_environment:TAVILY_API_KEY')
  const off = parseCapabilityRegistry({version: 1}, {}).modules.search
  assert.equal(off.enabled, false)
  assert.equal(off.reason, 'missing_environment:TAVILY_API_KEY')
  // A custom MCP endpoint is the user's choice; it is not silently replaced by the preset.
  const custom = parseCapabilityRegistry({version: 1}, {DASHSCOPE_API_KEY: 'k', SEARCH_MCP_URL: 'https://search.example/mcp'}).modules.search
  assert.equal(custom.enabled, false)
  // An MCP search whose endpoint key is not set turns off with that key named, instead of failing startup.
  for (const [document, environment] of [[{version: 1, modules: {search: {provider: 'mcp'}}}, {}], [{version: 1}, {SEARCH_PROVIDER: 'mcp'}],
    [{version: 1, modules: {search: {provider: 'mcp', mcp: {url: 'https://search.example/mcp', headers: {authorization: 'Bearer ${SEARCH_TOKEN}'}}}}}, {}]] as const) {
    const search = parseCapabilityRegistry(document, environment).modules.search
    assert.equal(search.enabled, false)
    assert.match(search.reason ?? '', /^missing_environment:(DASHSCOPE_API_KEY|SEARCH_TOKEN)$/u)
  }
  assert.equal(parseCapabilityRegistry({version: 1, modules: {search: {provider: 'mcp'}}}, {DASHSCOPE_API_KEY: 'k'}).modules.search.enabled, true)
  // An explicitly disabled module stays off without a reason.
  const disabled = parseCapabilityRegistry({version: 1, modules: {search: {enabled: false}}}, {}).modules.search
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.reason, undefined)
})

test('the coding module follows its environment override', () => {
  assert.equal(parseCapabilityRegistry({version: 1}, {}).modules.coding.enabled, true)
  const off = parseCapabilityRegistry({version: 1}, {CODING_MODULE_ENABLED: 'false'})
  assert.equal(off.modules.coding.enabled, false)
  assert.ok(off.overrides.includes('CODING_MODULE_ENABLED'))
  assert.throws(() => parseCapabilityRegistry({version: 1}, {CODING_MODULE_ENABLED: 'maybe'}), /CODING_MODULE_ENABLED/u)
})

test('camera watch without its model credential is reported off instead of failing', () => {
  const registry = parseCapabilityRegistry({version: 1}, {})
  const vision = {WATCH_MODEL: 'qwen3-vl-plus'}
  // Without a vision preset the watch reuses the main model gateway and needs no extra key.
  assert.equal(missingWatchModelCredential(loadSettings({})), null)
  assert.equal(missingWatchModelCredential(loadSettings({...vision, DASHSCOPE_API_KEY: 'k'})), null)
  assert.equal(missingWatchModelCredential(loadSettings(vision)), 'DASHSCOPE_API_KEY')
  assert.deepEqual(withoutUncredentialedModules(registry, loadSettings(vision)).modules.camera, {enabled: false, reason: 'missing_environment:DASHSCOPE_API_KEY'})
  assert.equal(withoutUncredentialedModules(registry, loadSettings({...vision, DASHSCOPE_API_KEY: 'k'})), registry)
  const disabled = parseCapabilityRegistry({version: 1, modules: {camera: {enabled: false}}}, {})
  assert.equal(withoutUncredentialedModules(disabled, loadSettings(vision)), disabled)
})

test('knowledge without its embedding credential is reported off instead of failing', () => {
  const registry = parseCapabilityRegistry({version: 1, modules: {knowledge: {enabled: true, exposeToCodex: true}}}, {})
  const cascaded = loadSettings({PIPELINE_MODE: 'cascaded', CASCADE_LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'd', DOUBAO_BIGMODEL_API_KEY: 'v'})
  assert.equal(missingKnowledgeCredential(cascaded), 'DASHSCOPE_API_KEY')
  assert.equal(missingKnowledgeCredential(loadSettings({DASHSCOPE_API_KEY: 'k'})), null)
  assert.equal(missingKnowledgeCredential(loadSettings({MODEL_BASE_URL: 'https://models.example/v1'})), 'MODEL_API_KEY')
  assert.deepEqual(withoutUncredentialedModules(registry, cascaded).modules.knowledge, {enabled: false, exposeToCodex: false, reason: 'missing_environment:DASHSCOPE_API_KEY'})
  assert.equal(withoutUncredentialedModules(registry, loadSettings({DASHSCOPE_API_KEY: 'k'})), registry)
})

test('desktop configuration failure carries only bounded key names', () => {
  assert.deepEqual(desktopConfigurationFailure(new BlockingConfigurationError('integrated', ['DASHSCOPE_API_KEY'])), {
    state: 'startup_failed', toolCount: null, toolBudget: 24,
    reason: 'configuration_required', pipeline: 'integrated', missing: ['DASHSCOPE_API_KEY'],
  })
  const noisy = desktopConfigurationFailure(new BlockingConfigurationError('cascaded', ['A', 'lower', 'B', 'C', 'D', 'E']))
  assert.deepEqual(noisy?.missing, ['A', 'B', 'C', 'D'])
  assert.equal(desktopConfigurationFailure(new ConfigurationError('缺少 X')), undefined)
  assert.equal(desktopConfigurationFailure(new Error('other')), undefined)
})

test('StepFun startup requires its own credential without demanding a Qwen key', () => {
  const selected = {INTEGRATED_PROVIDER: 'stepfun', MEMORY_CONNECTION: 'disabled'}
  assert.deepEqual(describeMissingBlockingEnvironment(selected), {pipeline: 'integrated', missing: ['STEPFUN_API_KEY']})
  assert.deepEqual(describeMissingBlockingEnvironment({...selected, STEPFUN_API_KEY: 'fixture'}), {pipeline: 'integrated', missing: []})
  assert.deepEqual(describeMissingBlockingEnvironment({...selected, DASHSCOPE_API_KEY: 'fixture'}), {pipeline: 'integrated', missing: ['STEPFUN_API_KEY']})
})


test('desktop text preflight needs only the selected text model, independently of voice', () => {
  for (const pipeline of ['integrated', 'cascaded']) {
    const environment = {PIPELINE_MODE: pipeline, CASCADE_LLM_PROVIDER: 'deepseek', MEMORY_CONNECTION: 'disabled'}
    assert.deepEqual(describeMissingBlockingEnvironment({...environment, DEEPSEEK_API_KEY: 'synthetic'}, true)?.missing, [])
    assert.deepEqual(describeMissingBlockingEnvironment({...environment, DASHSCOPE_API_KEY: 'voice-only'}, true)?.missing, ['DEEPSEEK_API_KEY'])
  }
})
