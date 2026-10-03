import {requireSelectedCascadedRealtimeConfig} from '../src/config/cascaded-realtime-config.js'
import {readFile} from 'node:fs/promises'
import {parseEnv} from 'node:util'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DASHSCOPE_COMPATIBLE_BASE_URL,
  ConfigurationError,
  loadSettings,
  requireCascadedCredentials,
  requireIntegratedRealtime,
  requirePersonalMemory,
  requireQwenRealtime,
  requireVolcengineRealtime,
  resolveCascadedSelection,
  resolveModelApiKey,
  resolveWatchModelConnection,
  resolveProactivity,
  settingsSchema,
} from '../src/config/config.js'

test('local memory retains DashScope credentials with a non-Qwen conversation model', () => {
  const settings=loadSettings({PIPELINE_MODE:'cascaded',CASCADE_LLM_PROVIDER:'deepseek',MEMORY_CONNECTION:'local',DASHSCOPE_API_KEY:'memory-key',DEEPSEEK_API_KEY:'conversation-key'})
  const memory=requirePersonalMemory(settings)
  assert.equal(memory?.connection,'local')
  if(memory?.connection==='local')assert.equal(memory.embedding.apiKey,'memory-key')
})

test('DashScope key also configures support models only on the DashScope endpoint', () => {
  const env = {DASHSCOPE_API_KEY: 'dashscope-test-key'}
  assert.equal(resolveModelApiKey(loadSettings(env)), env.DASHSCOPE_API_KEY)
  assert.equal(resolveModelApiKey(loadSettings({...env, MODEL_BASE_URL: DASHSCOPE_COMPATIBLE_BASE_URL})), env.DASHSCOPE_API_KEY)
  assert.equal(resolveModelApiKey(loadSettings({...env, MODEL_BASE_URL: 'https://example.com/v1'})), null)
  assert.equal(resolveModelApiKey(loadSettings({...env, MODEL_API_KEY: 'custom-test-key'})), 'custom-test-key')
})

test('a monitor preset loads its own provider credential independently of the conversation provider', () => {
  const integrated = loadSettings({WATCH_MODEL: 'doubao-seed-2-0-pro-260215', ARK_API_KEY: 'ark-test'})
  assert.equal(integrated.ark_api_key, 'ark-test')
  assert.deepEqual(resolveWatchModelConnection(integrated), {baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'ark-test'})
  const cascaded = loadSettings({PIPELINE_MODE: 'cascaded', CASCADE_LLM_PROVIDER: 'ark',
    WATCH_MODEL: 'qwen3-vl-plus', DASHSCOPE_API_KEY: 'qwen-test'})
  assert.equal(cascaded.dashscope_api_key, 'qwen-test')
  assert.deepEqual(resolveWatchModelConnection(cascaded), {baseUrl: DASHSCOPE_COMPATIBLE_BASE_URL, apiKey: 'qwen-test'})
  assert.throws(() => resolveWatchModelConnection(loadSettings({WATCH_MODEL: 'doubao-seed-2-0-pro-260215', DASHSCOPE_API_KEY: 'qwen-test'})), /ARK_API_KEY/)
  assert.equal(resolveWatchModelConnection(loadSettings({WATCH_MODEL: 'custom-model'})), null)
})

test('pipeline defaults are product-shaped and cascaded defaults use DeepSeek Flash', () => {
  const settings = loadSettings({})
  assert.equal(settings.pipeline_mode, 'integrated')
  assert.equal(settings.camera_module_enabled, true)
  assert.equal('realtime_provider' in settings, false)
  assert.deepEqual(resolveCascadedSelection(settings), {
    endpointingProvider: 'auto',
    asrProvider: 'volcengine',
    llmProvider: 'deepseek',
    llmModel: 'deepseek-flash',
    ttsProvider: 'volcengine',
  })
  assert.deepEqual({
    codexApprovalMode: settings.codex_approval_mode,
    clarificationDepth: settings.clarification_depth,
    planReadback: settings.plan_readback,
    plannerModel: settings.planner_model,
    progressBubbles: settings.progress_bubbles,
    embeddingProvider: settings.embedding_provider,
    embeddingModel: settings.embedding_model,
    knowledgePath: settings.knowledge_path,
    memoryConnection: settings.memory_connection,
    memoryPath: settings.memory_path,
    memoryUserId: settings.memory_user_id,
  }, {
    codexApprovalMode: 'ask',
    clarificationDepth: 'balanced',
    planReadback: 'summary',
    plannerModel: '',
    progressBubbles: 'milestones',
    embeddingProvider: 'dashscope',
    embeddingModel: 'text-embedding-v4',
    knowledgePath: '~/.nova-audio-agent/knowledge.sqlite',
    memoryConnection: 'local',
    memoryPath: '~/.nova-audio-agent/memory.sqlite',
    memoryUserId: 'local',
  })
})

test('camera module env mapping is strict and supports disabling the production module', () => {
  assert.equal(loadSettings({
    CAMERA_MODULE_ENABLED: 'false',
  }).camera_module_enabled, false)
  assert.throws(
    () => loadSettings({CAMERA_MODULE_ENABLED: 'maybe'}),
    error => error instanceof ConfigurationError
      && error.code === 'invalid_configuration'
      && error.message === 'invalid configuration: CAMERA_MODULE_ENABLED',
  )
})

test('personal memory selects the v0.3 ledger by default and maps its host-owned settings', () => {
  const configured = loadSettings({
    MEMORY_CONNECTION: 'local',
    MEMORY_PATH: '/state/personal.sqlite',
    MEMORY_USER_ID: 'owner-1',
  })
  assert.deepEqual({
    connection: configured.memory_connection,
    path: configured.memory_path,
    userId: configured.memory_user_id,
  }, {
    connection: 'local',
    path: '/state/personal.sqlite',
    userId: 'owner-1',
  })
  assert.throws(
    () => loadSettings({MEMORY_PROVIDER: 'unknown'}),
    error => error instanceof ConfigurationError
      && error.message === 'invalid configuration: MEMORY_PROVIDER',
  )
  assert.equal(requirePersonalMemory(loadSettings({MEMORY_CONNECTION: 'disabled'})), null)
  assert.deepEqual(requirePersonalMemory(loadSettings({
    MODEL_BASE_URL: 'https://embedding.example/v1/',
    MODEL_API_KEY: 'embedding-key',
    EMBEDDING_MODEL: 'embedding-model',
    MEMORY_CONNECTION: 'local',
    MEMORY_PATH: '/state/personal.sqlite',
    MEMORY_USER_ID: 'owner-1',
  })), {
    connection: 'local',
    provider: 'voicemem',
    path: '/state/personal.sqlite',
    userId: 'owner-1',
    extractionModel: 'qwen3-vl-plus',
    embedding: {
      baseUrl: 'https://embedding.example/v1',
      apiKey: 'embedding-key',
      model: 'embedding-model',
    },
  })
  // Local memory is optional: no embedding credential turns it off rather than blocking startup.
  assert.equal(requirePersonalMemory(loadSettings({MEMORY_CONNECTION: 'local'})), null)
  // Remote memory is an explicit opt-in, so its missing credential still fails loudly.
  assert.throws(
    () => requirePersonalMemory(loadSettings({MEMORY_CONNECTION: 'remote', MEMORY_URL: 'https://memory.example/'})),
    /MEMORY_TOKEN/u,
  )
})

test('v4 settings env selectors and paths load with the documented names', () => {
  const settings = loadSettings({
    EXECUTORS: 'codex',
    CODEX_APPROVAL_MODE: 'yolo',
    CLARIFICATION_DEPTH: 'thorough',
    PLAN_READBACK: 'confirm',
    PLANNER_MODEL: 'planner-model',
    PROGRESS_BUBBLES: 'all',
    CAPABILITIES_CONFIG: '/state/capabilities.json',
    KNOWLEDGE_PATH: '/state/knowledge.sqlite',
    EMBEDDING_PROVIDER: 'dashscope',
    EMBEDDING_MODEL: 'custom-embedding',
  })
  assert.equal(settings.codex_approval_mode, 'yolo')
  assert.equal(settings.clarification_depth, 'thorough')
  assert.equal(settings.plan_readback, 'confirm')
  assert.equal(settings.planner_model, 'planner-model')
  assert.equal(settings.progress_bubbles, 'all')
  assert.equal(settings.knowledge_path, '/state/knowledge.sqlite')
  assert.equal(settings.embedding_provider, 'dashscope')
  assert.equal(settings.embedding_model, 'custom-embedding')
})

test('invalid v4 enum env values fall back safely', () => {
  const settings = loadSettings({
    EXECUTORS: 'codex',
    CODEX_APPROVAL_MODE: 'unsafe',
    CLARIFICATION_DEPTH: 'deep',
    PLAN_READBACK: 'always',
    PROGRESS_BUBBLES: 'verbose',
    SEARCH_PROVIDER: 'unknown',
  })
  assert.equal(settings.codex_approval_mode, 'ask')
  assert.equal(settings.clarification_depth, 'balanced')
  assert.equal(settings.plan_readback, 'summary')
  assert.equal(settings.progress_bubbles, 'milestones')
  assert.equal(settings.embedding_provider, 'dashscope')
  assert.equal(settings.search_provider, 'tavily')
})

test('Ark receives its provider default only when no model override exists', () => {
  const implicit = loadSettings({
    PIPELINE_MODE: 'cascaded',
    CASCADE_LLM_PROVIDER: 'ark',
  })
  const explicit = loadSettings({
    PIPELINE_MODE: 'cascaded',
    CASCADE_LLM_PROVIDER: 'ark',
    CASCADE_LLM_MODEL: 'ark-custom',
  })
  assert.equal(resolveCascadedSelection(implicit).llmModel, 'doubao-seed-2-0-pro-260215')
  assert.equal(resolveCascadedSelection(explicit).llmModel, 'ark-custom')
  assert.throws(
    () => resolveCascadedSelection(loadSettings({
      PIPELINE_MODE: 'cascaded',
      CASCADE_LLM_PROVIDER: 'ark',
      CASCADE_LLM_MODEL: '',
    })),
    /CASCADE_LLM_MODEL 不能为空/u,
  )
})

test('integrated loading never reads Ark or Doubao credential slots', () => {
  const forbidden = new Set(['ARK_API_KEY', 'DOUBAO_ASR_API_KEY', 'DOUBAO_BIGMODEL_API_KEY'])
  const environment = new Proxy<NodeJS.ProcessEnv>({
    PIPELINE_MODE: 'integrated',
    DASHSCOPE_API_KEY: 'dashscope-key',
  }, {
    get(target, key, receiver) {
      if (typeof key === 'string' && forbidden.has(key)) {
        throw new Error(`${key} must stay lazy`)
      }
      return Reflect.get(target, key, receiver) as string | undefined
    },
  })
  assert.equal(requireIntegratedRealtime(loadSettings(environment)).apiKey, 'dashscope-key')
})

test('integrated Qwen credential resolution binds generic keys to the DashScope endpoint', () => {
  const compatible = loadSettings({
    PIPELINE_MODE: 'integrated',
    INTEGRATED_PROVIDER: 'qwen',
    MODEL_BASE_URL: DASHSCOPE_COMPATIBLE_BASE_URL,
    MODEL_API_KEY: 'generic-dashscope-key',
  })
  assert.equal(requireIntegratedRealtime(compatible).apiKey, 'generic-dashscope-key')

  const explicit = loadSettings({
    PIPELINE_MODE: 'integrated',
    INTEGRATED_PROVIDER: 'qwen',
    MODEL_BASE_URL: DASHSCOPE_COMPATIBLE_BASE_URL,
    MODEL_API_KEY: 'generic-dashscope-key',
    DASHSCOPE_API_KEY: 'explicit-dashscope-key',
  })
  assert.equal(requireIntegratedRealtime(explicit).apiKey, 'explicit-dashscope-key')

  const foreign = loadSettings({
    PIPELINE_MODE: 'integrated',
    INTEGRATED_PROVIDER: 'qwen',
    MODEL_BASE_URL: 'https://example.invalid/v1',
    MODEL_API_KEY: 'foreign-key',
  })
  assert.throws(() => requireIntegratedRealtime(foreign), /DASHSCOPE_API_KEY/u)
})

test('StepFun realtime config resolves its own key and Qwen 3.1 gets its matching default voice', () => {
  const step = loadSettings({INTEGRATED_PROVIDER: 'stepfun',
    STEPFUN_API_KEY: 'step-secret', DASHSCOPE_API_KEY: 'support-secret'})
  assert.deepEqual(requireIntegratedRealtime(step), {
    url: 'wss://api.stepfun.com/v1/realtime', model: 'stepaudio-3-realtime-preview',
    voice: '', apiKey: 'step-secret',
  })
  assert.throws(() => requireIntegratedRealtime(loadSettings({
    INTEGRATED_PROVIDER: 'stepfun',
  })), /STEPFUN_API_KEY/u)
  const qwen31 = loadSettings({QWEN_REALTIME_MODEL: 'qwen-audio-3.1-realtime-plus',
    DASHSCOPE_API_KEY: 'qwen-secret'})
  assert.equal(requireIntegratedRealtime(qwen31).voice, 'longanqian_v3.1')
  assert.deepEqual(resolveWatchModelConnection({...step, watch_model: 'step-3.7-flash'}), {
    baseUrl: 'https://api.stepfun.com/v1', apiKey: 'step-secret',
  })
})

test('StepFun support models default to Step 3.7 Flash while memory extraction stays on DashScope', () => {
  const base = {INTEGRATED_PROVIDER: 'stepfun', STEPFUN_API_KEY: 'step-secret',
    DASHSCOPE_API_KEY: 'support-secret', MEMORY_CONNECTION: 'local'}
  const step = loadSettings(base)
  assert.deepEqual([step.support_model, step.compressor_model, step.watch_model, step.planner_model],
    ['step-3.7-flash', 'step-3.7-flash', 'step-3.7-flash', 'step-3.7-flash'])
  // Extraction is sent through the DashScope embedding connection, so its model must stay there.
  assert.equal(step.fast_model, 'qwen3-vl-plus')
  const memory = requirePersonalMemory(step)
  assert.equal(memory?.connection === 'local' && memory.extractionModel, 'qwen3-vl-plus')
  assert.equal(memory?.connection === 'local' && memory.embedding.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1')
  const explicit = loadSettings({...base, SUPPORT_MODEL: 'qwen-plus',
    WATCH_MODEL: '', PLANNER_MODEL: ''})
  assert.equal(explicit.support_model, 'qwen-plus', 'an explicit model is never rewritten')
  assert.equal(explicit.watch_model, 'step-3.7-flash', 'empty watch would fall back to a DashScope model')
  assert.equal(explicit.planner_model, 'step-3.7-flash')
  const gateway = loadSettings({...base, MODEL_API_KEY: 'gateway-secret'})
  assert.equal(gateway.support_model, 'qwen-plus', 'a custom gateway keeps the generic defaults')
  assert.equal(loadSettings({DASHSCOPE_API_KEY: 'qwen-secret'}).support_model, 'qwen-plus')
})

test('Codex direct argv prefix is parsed only as a bounded JSON string array', () => {
  const configured = loadSettings({
    EXECUTOR: 'codex',
    CODEX_PREFIX_ARGS: '["C:\\\\official\\\\codex.js"]',
  })
  assert.deepEqual(configured.codex_prefix_args, ['C:\\official\\codex.js'])
  for (const value of ['not-json', '{}', '["one.js","two.js"]', '[7]']) {
    assert.throws(() => loadSettings({
      EXECUTOR: 'codex',
      CODEX_PREFIX_ARGS: value,
    }), /invalid configuration/u)
  }
})

test('integrated loading never reads inactive cascaded selector or model slots', () => {
  const forbidden = new Set([
    'CASCADE_ENDPOINTING_PROVIDER',
    'CASCADE_ASR_PROVIDER',
    'CASCADE_LLM_PROVIDER',
    'CASCADE_LLM_MODEL',
    'CASCADE_TTS_PROVIDER',
  ])
  const environment = new Proxy<NodeJS.ProcessEnv>({
    PIPELINE_MODE: 'integrated',
  }, {
    get(target, key, receiver) {
      if (typeof key === 'string' && forbidden.has(key)) {
        throw new Error(`${key} must stay inert`)
      }
      return Reflect.get(target, key, receiver) as string | undefined
    },
  })
  assert.deepEqual(resolveCascadedSelection(loadSettings(environment)), {
    endpointingProvider: 'auto',
    asrProvider: 'volcengine',
    llmProvider: 'deepseek',
    llmModel: 'deepseek-flash',
    ttsProvider: 'volcengine',
  })
})

test('integrated loading ignores invalid inactive cascaded selector and model values', () => {
  const settings = loadSettings({
    PIPELINE_MODE: 'integrated',
    CASCADE_ENDPOINTING_PROVIDER: 'invalid-endpointing',
    CASCADE_ASR_PROVIDER: 'invalid-asr',
    CASCADE_LLM_PROVIDER: 'invalid-llm',
    CASCADE_LLM_MODEL: '',
    CASCADE_TTS_PROVIDER: 'invalid-tts',
  })
  assert.equal(settings.pipeline_mode, 'integrated')
  assert.deepEqual(resolveCascadedSelection(settings), {
    endpointingProvider: 'auto',
    asrProvider: 'volcengine',
    llmProvider: 'deepseek',
    llmModel: 'deepseek-flash',
    ttsProvider: 'volcengine',
  })
})

test('cascaded Qwen resolution never reads ARK_API_KEY', () => {
  const environment = new Proxy<NodeJS.ProcessEnv>({
    PIPELINE_MODE: 'cascaded',
    DASHSCOPE_API_KEY: 'dashscope-key',
    DOUBAO_BIGMODEL_API_KEY: 'doubao-key',
  }, {
    get(target, key, receiver) {
      if (key === 'ARK_API_KEY') throw new Error('Ark key must stay lazy')
      return Reflect.get(target, key, receiver) as string | undefined
    },
  })
  const settings = loadSettings(environment)
  const selection = resolveCascadedSelection(settings)
  assert.equal(requireCascadedCredentials(settings, selection).llmApiKey, 'dashscope-key')
})

test('runtime settings do not expose the retired backend selector', () => {
  assert.equal('backend' in loadSettings({}), false)
  assert.equal('backend' in loadSettings({BACKEND: 'python'}), false)
})


test('proactivity presets and individual overrides preserve the Python table', () => {
  assert.deepEqual(
    resolveProactivity(loadSettings({PROACTIVITY_PRESET: 'conservative'})),
    {cooldown: 120, fresh_window: 20},
  )
  assert.deepEqual(resolveProactivity(loadSettings({
    PROACTIVITY_PRESET: 'eager',
    SUGGESTION_COOLDOWN: '5',
  })), {cooldown: 5, fresh_window: 45})
})

test('numeric overrides reject negative, non-finite, and out-of-range values', () => {
  assert.throws(
    () => loadSettings({SUGGESTION_COOLDOWN: '-1'}),
    ConfigurationError,
  )
  assert.throws(
    () => loadSettings({FRESH_WINDOW: 'NaN'}),
    /FRESH_WINDOW/u,
  )
  assert.throws(
    () => loadSettings({EXECUTOR: 'codex', CODEX_WORKING_INTERVAL: '601'}),
    ConfigurationError,
  )
})

test('selected Codex settings preserve the established host environment defaults and overrides', () => {
  const defaults = loadSettings({EXECUTOR: 'codex'}) as unknown as Record<
    string,
    unknown
  >
  assert.deepEqual({
    workspace: defaults.codex_workspace,
    binary: defaults.codex_bin,
    apiKey: defaults.codex_api_key,
    prewarm: defaults.codex_prewarm,
    managedRoot: defaults.codex_managed_root,
    stateRoot: defaults.codex_project_state_root,
  }, {
    workspace: null,
    binary: 'codex',
    apiKey: null,
    prewarm: true,
    managedRoot: '~/.nova-audio-agent/workspaces',
    stateRoot: '~/.nova-audio-agent',
  })
  assert.equal(Object.hasOwn(defaults, 'codex_projects_enabled'), false)

  const explicit = loadSettings({
    EXECUTOR: 'codex',
    CODEX_WORKSPACE: '\u001c/private/workspace\u0085',
    CODEX_BIN: '\u001c/private/bin/codex\u0085',
    CODEX_API_KEY: '\u001csecret\u0085',
    CODEX_PREWARM: 'false',
    CODEX_MANAGED_ROOT: '\u001c/private/managed\u0085',
    CODEX_PROJECT_STATE_ROOT: '\u001c/private/state\u0085',
  }) as unknown as Record<string, unknown>
  assert.deepEqual({
    workspace: explicit.codex_workspace,
    binary: explicit.codex_bin,
    apiKey: explicit.codex_api_key,
    prewarm: explicit.codex_prewarm,
    managedRoot: explicit.codex_managed_root,
    stateRoot: explicit.codex_project_state_root,
  }, {
    workspace: '/private/workspace',
    binary: '/private/bin/codex',
    apiKey: 'secret',
    prewarm: false,
    managedRoot: '/private/managed',
    stateRoot: '/private/state',
  })
  assert.equal(Object.hasOwn(explicit, 'codex_projects_enabled'), false)
})

test('Codex working interval follows Pydantic numeric whitespace and keeps both bounds', () => {
  assert.throws(() => loadSettings({
    EXECUTOR: 'codex',
    CODEX_WORKING_INTERVAL: '\u001c5\u0085',
  }), /CODEX_WORKING_INTERVAL/u)
  assert.equal(loadSettings({
    EXECUTOR: 'codex',
    CODEX_WORKING_INTERVAL: '600',
  }).codex_working_interval, 600)
  assert.throws(
    () => loadSettings({
      EXECUTOR: 'codex',
      CODEX_WORKING_INTERVAL: '\ufeff5\ufeff',
    }),
    /CODEX_WORKING_INTERVAL/u,
  )
})

test('executor list is trimmed, ordered, unique, and non-empty', () => {
  assert.deepEqual(loadSettings({EXECUTORS: ' slow_sim , codex '}).executors, [
    'slow_sim',
    'codex',
  ])
  assert.throws(
    () => loadSettings({EXECUTORS: 'codex,,slow_sim'}),
    /empty name/u,
  )
  assert.throws(
    () => loadSettings({EXECUTORS: 'codex,codex'}),
    /duplicate/u,
  )
})

test('configuration failures never echo secret values', () => {
  const secret = 'never-echo-this-secret'
  let message = ''
  try {
    loadSettings({
      MODEL_API_KEY: secret,
      PIPELINE_MODE: 'invalid',
    })
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  assert.equal(message.includes(secret), false)
  assert.match(message, /PIPELINE_MODE/u)
})

test('a non-Codex configuration never reads the Codex credential environment slot', () => {
  let reads = 0
  const environment = new Proxy<NodeJS.ProcessEnv>({
    EXECUTOR: 'fast_sim',
  }, {
    get(target, key, receiver) {
      if (key === 'CODEX_API_KEY') {
        reads += 1
        throw new Error('Codex secret must stay lazy')
      }
      return Reflect.get(target, key, receiver) as string | undefined
    },
  })
  assert.equal(loadSettings(environment).executors[0], 'fast_sim')
  assert.equal(reads, 0)
})

test('the production default config does not install a simulator executor', () => {
  assert.deepEqual(loadSettings({}).executors, [])
  assert.equal(loadSettings({}).executor, null)
})

test('the unprefixed Tavily credential is preserved for production assembly', () => {
  const configured = loadSettings({TAVILY_API_KEY: '  tavily-test-key  '})
  assert.equal(configured.tavily_api_key, 'tavily-test-key')
})

test('configuration normalization uses Python whitespace rather than JavaScript trim', () => {
  assert.equal(loadSettings({TAVILY_API_KEY: '\u001ctavily-test-key\u0085'}).tavily_api_key,
    'tavily-test-key')
  assert.equal(loadSettings({TAVILY_API_KEY: '\ufefftavily-test-key\ufeff'}).tavily_api_key,
    '\ufefftavily-test-key\ufeff')
  assert.deepEqual(
    loadSettings({EXECUTORS: '\u001cslow_sim\u0085,fast_sim'}).executors,
    ['slow_sim', 'fast_sim'],
  )
})

test('Qwen realtime settings preserve Python defaults and every host override', () => {
  const defaults = loadSettings({MODEL_API_KEY: 'model-key'})
  assert.deepEqual(requireQwenRealtime(defaults), {
    url: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
    model: 'qwen-audio-3.0-realtime-plus',
    voice: 'longanqian',
    apiKey: 'model-key',
  })
  assert.deepEqual({
    controlled: defaults.qwen_controlled_guard_reconnect,
    recovery: defaults.qwen_guard_history_recovery,
    pairs: defaults.qwen_guard_history_pairs,
  }, {controlled: false, recovery: 'none', pairs: 4})

  const explicit = loadSettings({
    MODEL_API_KEY: 'model-key',
    DASHSCOPE_API_KEY: 'dash-key',
    QWEN_REALTIME_URL: ' wss://qwen.example/realtime ',
    QWEN_REALTIME_MODEL: ' qwen-test ',
    QWEN_REALTIME_VOICE: ' voice-test ',
    QWEN_CONTROLLED_GUARD_RECONNECT: 'true',
    QWEN_GUARD_HISTORY_RECOVERY: 'packed',
    QWEN_GUARD_HISTORY_PAIRS: '2',
  })
  assert.deepEqual(requireQwenRealtime(explicit), {
    url: 'wss://qwen.example/realtime',
    model: 'qwen-test',
    voice: 'voice-test',
    apiKey: 'dash-key',
  })
  assert.deepEqual({
    controlled: explicit.qwen_controlled_guard_reconnect,
    recovery: explicit.qwen_guard_history_recovery,
    pairs: explicit.qwen_guard_history_pairs,
  }, {controlled: true, recovery: 'packed', pairs: 2})
})

test('Qwen require uses Python strip for URL, model, voice, and credentials', () => {
  const pythonWhitespace = loadSettings({
    QWEN_REALTIME_URL: '\u001cwss://qwen.example/realtime\u0085',
    QWEN_REALTIME_MODEL: '\u001cqwen-test\u0085',
    QWEN_REALTIME_VOICE: '\u001cvoice-test\u0085',
    DASHSCOPE_API_KEY: '\u001cdash-key\u0085',
    MODEL_API_KEY: '\u001cmodel-key\u0085',
  })
  assert.deepEqual(requireQwenRealtime(pythonWhitespace), {
    url: 'wss://qwen.example/realtime',
    model: 'qwen-test',
    voice: 'voice-test',
    apiKey: 'dash-key',
  })

  assert.throws(
    () => requireQwenRealtime(loadSettings({
      QWEN_REALTIME_URL: '\ufeffwss://qwen.example/realtime',
      DASHSCOPE_API_KEY: 'dash-key',
    })),
    error => error instanceof ConfigurationError
      && error.message === 'QWEN_REALTIME_URL 必须使用 wss://',
  )
  assert.throws(
    () => requireQwenRealtime(loadSettings({
      QWEN_REALTIME_MODEL: '\u001c\u0085',
      DASHSCOPE_API_KEY: 'dash-key',
    })),
    /QWEN_REALTIME_MODEL 不能为空/u,
  )
  assert.throws(
    () => requireQwenRealtime(loadSettings({
      QWEN_REALTIME_VOICE: '\u001c\u0085',
      DASHSCOPE_API_KEY: 'dash-key',
    })),
    /QWEN_REALTIME_VOICE 不能为空/u,
  )
  assert.equal(requireQwenRealtime(loadSettings({
    DASHSCOPE_API_KEY: '\ufeff',
    MODEL_API_KEY: 'model-key',
  })).apiKey, '\ufeff')
  assert.deepEqual(requireQwenRealtime(loadSettings({
    QWEN_REALTIME_MODEL: '\ufeffqwen-test\ufeff',
    QWEN_REALTIME_VOICE: '\ufeffvoice-test\ufeff',
    MODEL_API_KEY: '\ufeffmodel-key\ufeff',
  })), {
    url: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
    model: '\ufeffqwen-test\ufeff',
    voice: '\ufeffvoice-test\ufeff',
    apiKey: '\ufeffmodel-key\ufeff',
  })
})

test('Qwen require returns focused credential-safe validation errors', () => {
  const sentinel = 'sentinel-secret-never-echo'
  const cases: readonly [NodeJS.ProcessEnv, string][] = [
    [{
      QWEN_REALTIME_URL: `https://qwen.invalid/?token=${sentinel}`,
      MODEL_API_KEY: sentinel,
    }, 'QWEN_REALTIME_URL 必须使用 wss://'],
    [{
      QWEN_REALTIME_MODEL: '\u001c',
      MODEL_API_KEY: sentinel,
    }, 'QWEN_REALTIME_MODEL 不能为空'],
    [{
      QWEN_REALTIME_VOICE: '\u0085',
      DASHSCOPE_API_KEY: sentinel,
    }, 'QWEN_REALTIME_VOICE 不能为空'],
    [{
      QWEN_REALTIME_URL: `wss://qwen.invalid/?token=${sentinel}`,
      DASHSCOPE_API_KEY: '\u001c',
      MODEL_API_KEY: '\u0085',
    }, '缺少 DASHSCOPE_API_KEY 或 MODEL_API_KEY'],
  ]
  for (const [environment, expected] of cases) {
    assert.throws(
      () => requireQwenRealtime(loadSettings(environment)),
      error => error instanceof ConfigurationError
        && error.message === expected
        && !error.message.includes(sentinel),
    )
  }
})

test('Qwen boolean settings accept every exact Pydantic arm case-insensitively', () => {
  const truthy = ['true', 'TRUE', 't', 'T', '1', 'on', 'YES', 'y']
  const falsy = ['false', 'FALSE', 'f', 'F', '0', 'off', 'NO', 'n']
  for (const value of truthy) {
    assert.equal(loadSettings({
      QWEN_CONTROLLED_GUARD_RECONNECT: value,
    }).qwen_controlled_guard_reconnect, true)
  }
  for (const value of falsy) {
    assert.equal(loadSettings({
      QWEN_CONTROLLED_GUARD_RECONNECT: value,
    }).qwen_controlled_guard_reconnect, false)
  }
  for (const value of ['1', '2', '4']) {
    assert.equal(loadSettings({
      QWEN_GUARD_HISTORY_PAIRS: value,
    }).qwen_guard_history_pairs, Number(value))
  }
})

test('Qwen boolean and Guard enum settings do not strip their raw environment values', () => {
  for (const [variable, value] of [
    ['QWEN_CONTROLLED_GUARD_RECONNECT', 'maybe'],
    ['QWEN_CONTROLLED_GUARD_RECONNECT', ' true '],
    ['QWEN_CONTROLLED_GUARD_RECONNECT', '\u001ctrue\u001c'],
    ['QWEN_GUARD_HISTORY_RECOVERY', 'native'],
    ['QWEN_GUARD_HISTORY_RECOVERY', ' packed '],
    ['QWEN_GUARD_HISTORY_PAIRS', '3'],
    ['QWEN_GUARD_HISTORY_PAIRS', ' 2 '],
    ['QWEN_GUARD_HISTORY_PAIRS', ''],
  ] as const) {
    assert.throws(
      () => loadSettings({[variable]: value}),
      error => error instanceof ConfigurationError && error.message.includes(variable.slice(17)),
    )
  }
})

test('Volcengine resolver returns a new immutable value and never aliases settings', () => {
  const settings = loadSettings({
    PIPELINE_MODE: 'cascaded',
    CASCADE_LLM_PROVIDER: 'ark',
    ARK_API_KEY: 'ark-key',
    DOUBAO_BIGMODEL_API_KEY: 'tts-key',
  })
  const first = requireVolcengineRealtime(settings)
  const second = requireVolcengineRealtime(settings)
  assert.notEqual(first, second)
  assert.equal(Object.isFrozen(first), true)
  assert.deepEqual(first, second)
})

test('Volcengine resolver errors never echo credentials or submitted endpoints', () => {
  const sentinel = 'sentinel-volc-secret-or-endpoint'
  let message = ''
  try {
    requireVolcengineRealtime(loadSettings({
      PIPELINE_MODE: 'cascaded',
      CASCADE_LLM_PROVIDER: 'ark',
      ARK_API_KEY: sentinel,
      DOUBAO_BIGMODEL_API_KEY: sentinel,
      DOUBAO_ASR_ENDPOINT: `https://${sentinel}.example/asr`,
    }))
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  assert.equal(message.includes(sentinel), false)
  assert.equal(message, 'DOUBAO_ASR_ENDPOINT 必须是安全的 wss:// 地址')
})

test('Volcengine numeric relationships retain the Python resolver errors', () => {
  const credentials = {
    PIPELINE_MODE: 'cascaded',
    CASCADE_LLM_PROVIDER: 'ark',
    ARK_API_KEY: 'ark-key',
    DOUBAO_BIGMODEL_API_KEY: 'tts-key',
  }
  const cases: readonly [NodeJS.ProcessEnv, string][] = [
    [{DOUBAO_ASR_CHUNK_MS: '0'},
      'DOUBAO_ASR_CHUNK_MS 必须为正整数'],
    [{DOUBAO_TTS_OUTPUT_SAMPLE_RATE: '16000'},
      'DOUBAO_TTS_OUTPUT_SAMPLE_RATE 必须为 24000'],
    [{VOLCENGINE_VAD_THRESHOLD: 'NaN'},
      'VOLCENGINE_VAD_THRESHOLD 必须在 (0, 1] 内'],
    [{VOLCENGINE_VAD_PRE_ROLL_MS: '-1'},
      '火山 VAD pre-roll 与 speech pad 不能为负数'],
    [{VOLCENGINE_VAD_MIN_SPEECH_MS: '0'},
      '火山 VAD min speech 与 silence end 必须为正整数'],
    [{
      VOLCENGINE_VAD_MIN_SPEECH_MS: '251',
      VOLCENGINE_VAD_MAX_UTTERANCE_MS: '250',
    }, '火山 VAD max utterance 不能短于 min speech'],
  ]
  for (const [environment, expected] of cases) {
    assert.throws(
      () => requireVolcengineRealtime(loadSettings({...credentials, ...environment})),
      error => error instanceof ConfigurationError && error.message === expected,
    )
  }
})

test('memory connection separates local provider selection from remote engine ownership', () => {
  const remote = {
    MEMORY_CONNECTION: 'remote',
    MEMORY_URL: 'http://127.0.0.1:8787',
    MEMORY_TOKEN: 'owner-token',
  }
  assert.deepEqual(requirePersonalMemory(loadSettings(remote)), {
    connection: 'remote', url: remote.MEMORY_URL, token: 'owner-token',
  })
  const local = {MEMORY_CONNECTION:'local',
    MODEL_API_KEY:'test', MODEL_BASE_URL:'https://example.com/v1'}
  assert.deepEqual(requirePersonalMemory(loadSettings(local)),
    requirePersonalMemory(loadSettings({...local, MEMORY_PROVIDER:'voicemem'})))
  assert.equal(requirePersonalMemory(loadSettings({MEMORY_CONNECTION:'disabled'})), null)
  assert.throws(() => loadSettings({...remote, MEMORY_PROVIDER:'voicemem'}), ConfigurationError)
  assert.throws(() => loadSettings({...local, MEMORY_PROVIDER:'unknown'}), ConfigurationError)
  assert.equal(requirePersonalMemory(loadSettings({...local, MEMORY_PROVIDER:'voicemem'}))?.connection, 'local')
  assert.throws(() => requirePersonalMemory(loadSettings({...remote,MEMORY_TOKEN:''})), ConfigurationError)
})

test('removed memory backend configuration fails explicitly instead of silently disabling memory', () => {
  for (const backend of ['voicemem', 'http', 'disabled']) {
    assert.throws(() => loadSettings({MEMORY_BACKEND:backend}), /MEMORY_CONNECTION/u)
  }
})

test('default memory config resolves the v0.3 ledger without opt-in and allows explicit disable', () => {
  const config = requirePersonalMemory(loadSettings({MODEL_API_KEY: 'test'}))
  assert.ok(config?.connection === 'local')
  assert.equal(config.provider, 'voicemem')
  assert.equal(requirePersonalMemory(loadSettings({MEMORY_CONNECTION: 'disabled'})), null)
  const independent = requirePersonalMemory(loadSettings({PIPELINE_MODE: 'cascaded',
    CASCADE_LLM_PROVIDER: 'ark', ARK_API_KEY: 'ark-only', DASHSCOPE_API_KEY: 'memory-only'}))
  assert.ok(independent?.connection === 'local')
  assert.equal(independent.embedding.apiKey, 'memory-only')
})

test('unsupported embedding providers are rejected without a cloud fallback', () => {
  for (const provider of ['local', 'remote']) {
    assert.throws(() => loadSettings({EMBEDDING_PROVIDER: provider}),
      {name: 'ConfigurationError', code: 'invalid_configuration',
        message: 'invalid configuration: EMBEDDING_PROVIDER (allowed: dashscope)'})
    assert.throws(() => settingsSchema.parse({embedding_provider: provider}),
      /dashscope/u)
  }
})

test('DeepSeek cascade uses its official credential and Flash model', () => {
  const settings = loadSettings({PIPELINE_MODE: 'cascaded', CASCADE_LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'deepseek-test', DOUBAO_BIGMODEL_API_KEY: 'speech-test'})
  const selection = resolveCascadedSelection(settings)
  assert.equal(selection.llmModel, 'deepseek-flash')
  assert.equal(requireCascadedCredentials(settings, selection).llmApiKey, 'deepseek-test')
  assert.throws(() => requireCascadedCredentials(loadSettings({PIPELINE_MODE: 'cascaded', CASCADE_LLM_PROVIDER: 'deepseek', DASHSCOPE_API_KEY: 'wrong-key'}), selection), /DEEPSEEK_API_KEY/)
})

test('short environment names reach runtime settings and selected credentials', () => {
  const settings = loadSettings({PIPELINE_MODE: 'cascaded', CASCADE_LLM_PROVIDER: 'deepseek',
    CASCADE_LLM_MODEL: 'custom-model', DEEPSEEK_API_KEY: 'test-key', DOUBAO_BIGMODEL_API_KEY: 'voice-key',
    PROMPT_LANGUAGE: 'en', MEMORY_CONNECTION: 'disabled', EXECUTORS: 'codex', CODEX_WORKSPACE: '/tmp/project'})
  assert.equal(settings.pipeline_mode, 'cascaded')
  assert.equal(settings.language, 'en')
  assert.equal(settings.codex_workspace, '/tmp/project')
  const selection = resolveCascadedSelection(settings)
  assert.equal(selection.llmProvider, 'deepseek')
  assert.equal(selection.llmModel, 'custom-model')
  assert.equal(requireCascadedCredentials(settings, selection).llmApiKey, 'test-key')
  assert.equal(requirePersonalMemory(settings), null)
})

// Catch explanatory fallback labels accidentally emitted as executable .env values.
test('nonempty env examples are accepted by the selected provider configuration', async () => {
  const text = await readFile(new URL('../../../.env.example', import.meta.url), 'utf8')
  const examples = parseEnv(text.split('\n').filter(line => /^# [A-Z][A-Z0-9_]*=/.test(line))
    .map(line => line.slice(2)).join('\n'))
  for (const [name, value] of Object.entries(examples)) {
    if (!value) continue
    const credentials = {DASHSCOPE_API_KEY: 'example-key', ARK_API_KEY: 'example-key',
      DEEPSEEK_API_KEY: 'example-key', DOUBAO_BIGMODEL_API_KEY: 'example-key'}
    for (const pipelineMode of ['integrated', 'cascaded']) {
      const settings = loadSettings({...credentials, PIPELINE_MODE: pipelineMode, EXECUTORS: 'codex', [name]: value})
      assert.doesNotThrow(() => settings.pipeline_mode === 'cascaded'
        ? requireSelectedCascadedRealtimeConfig(settings) : requireIntegratedRealtime(settings), name)
    }
  }
})

test('memory prerecall is opt-in and preserves explicit enabled configuration',()=>{
 assert.equal(loadSettings({}).memory_prerecall_enabled,false)
 assert.equal(loadSettings({MEMORY_PRERECALL_ENABLED:'true'}).memory_prerecall_enabled,true)
 assert.equal(loadSettings({MEMORY_PRERECALL_ENABLED:'false'}).memory_prerecall_enabled,false)
})

test('daily memory consolidation uses a validated configurable hour and timezone',()=>{
 const defaults=loadSettings({})
 assert.equal(defaults.memory_consolidation_enabled,true);assert.equal(defaults.memory_consolidation_hour,0);assert.equal(defaults.memory_consolidation_timezone,'UTC')
 const configured=loadSettings({MEMORY_CONSOLIDATION_ENABLED:'false',MEMORY_CONSOLIDATION_HOUR:'9',MEMORY_CONSOLIDATION_TIMEZONE:'Asia/Shanghai'})
 assert.equal(configured.memory_consolidation_enabled,false);assert.equal(configured.memory_consolidation_hour,9);assert.equal(configured.memory_consolidation_timezone,'Asia/Shanghai')
 assert.throws(()=>loadSettings({MEMORY_CONSOLIDATION_HOUR:'24'}));assert.throws(()=>loadSettings({MEMORY_CONSOLIDATION_TIMEZONE:'not-a-timezone'}))
})

 test('native RSS language is independent of conversational language',()=>{
  assert.equal(loadSettings({PROMPT_LANGUAGE:'en',NEWS_LANGUAGE:'zh-CN'}).news_language,'zh-CN')
  assert.equal(loadSettings({PROMPT_LANGUAGE:'zh-CN',NEWS_LANGUAGE:'en'}).news_language,'en')
  assert.equal(loadSettings({}).news_language,'en')
 })
