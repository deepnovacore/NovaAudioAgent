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
  resolveProactivity,
} from '../src/config.js'

test('pipeline defaults are product-shaped and cascaded defaults use Qwen Flash', () => {
  const settings = loadSettings({})
  assert.equal(settings.pipeline_mode, 'integrated')
  assert.equal(settings.camera_module_enabled, true)
  assert.equal('realtime_provider' in settings, false)
  assert.deepEqual(resolveCascadedSelection(settings), {
    endpointingProvider: 'auto',
    asrProvider: 'volcengine',
    llmProvider: 'qwen',
    llmModel: 'qwen-flash',
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
    capabilitiesConfigPath: settings.capabilities_config_path,
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
    capabilitiesConfigPath: '~/.nova-audio-agent/capabilities.json',
    knowledgePath: '~/.nova-audio-agent/knowledge.sqlite',
    memoryConnection: 'disabled',
    memoryPath: '~/.nova-audio-agent/memory.sqlite',
    memoryUserId: 'local',
  })
})

test('camera module env mapping is strict and supports disabling the production module', () => {
  assert.equal(loadSettings({
    NOVA_AUDIO_AGENT_CAMERA_MODULE_ENABLED: 'false',
  }).camera_module_enabled, false)
  assert.throws(
    () => loadSettings({NOVA_AUDIO_AGENT_CAMERA_MODULE_ENABLED: 'maybe'}),
    error => error instanceof ConfigurationError
      && error.code === 'invalid_configuration'
      && error.message === 'invalid configuration: NOVA_AUDIO_AGENT_CAMERA_MODULE_ENABLED',
  )
})

test('personal memory selects VoiceMem explicitly and maps its host-owned settings', () => {
  const configured = loadSettings({
    NOVA_AUDIO_AGENT_MEMORY_CONNECTION: 'local',
    NOVA_AUDIO_AGENT_MEMORY_PATH: '/state/personal.sqlite',
    NOVA_AUDIO_AGENT_MEMORY_USER_ID: 'owner-1',
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
    () => loadSettings({NOVA_AUDIO_AGENT_MEMORY_PROVIDER: 'unknown'}),
    error => error instanceof ConfigurationError
      && error.message === 'invalid configuration: NOVA_AUDIO_AGENT_MEMORY_PROVIDER',
  )
  assert.equal(requirePersonalMemory(loadSettings({})), null)
  assert.deepEqual(requirePersonalMemory(loadSettings({
    NOVA_AUDIO_AGENT_MODEL_BASE_URL: 'https://embedding.example/v1/',
    NOVA_AUDIO_AGENT_MODEL_API_KEY: 'embedding-key',
    NOVA_AUDIO_AGENT_EMBEDDING_MODEL: 'embedding-model',
    NOVA_AUDIO_AGENT_MEMORY_CONNECTION: 'local',
    NOVA_AUDIO_AGENT_MEMORY_PATH: '/state/personal.sqlite',
    NOVA_AUDIO_AGENT_MEMORY_USER_ID: 'owner-1',
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
  assert.throws(
    () => requirePersonalMemory(loadSettings({NOVA_AUDIO_AGENT_MEMORY_CONNECTION: 'local'})),
    /NOVA_AUDIO_AGENT_MODEL_API_KEY/u,
  )
})

test('v4 settings env selectors and paths load with the documented names', () => {
  const settings = loadSettings({
    NOVA_AUDIO_AGENT_EXECUTORS: 'codex',
    NOVA_AUDIO_AGENT_CODEX_APPROVAL_MODE: 'yolo',
    NOVA_AUDIO_AGENT_CLARIFICATION_DEPTH: 'thorough',
    NOVA_AUDIO_AGENT_PLAN_READBACK: 'confirm',
    NOVA_AUDIO_AGENT_PLANNER_MODEL: 'planner-model',
    NOVA_AUDIO_AGENT_PROGRESS_BUBBLES: 'all',
    NOVA_AUDIO_AGENT_CAPABILITIES_CONFIG: '/state/capabilities.json',
    NOVA_AUDIO_AGENT_KNOWLEDGE_PATH: '/state/knowledge.sqlite',
    NOVA_AUDIO_AGENT_EMBEDDING_PROVIDER: 'local',
    NOVA_AUDIO_AGENT_EMBEDDING_MODEL: 'custom-embedding',
  })
  assert.equal(settings.codex_approval_mode, 'yolo')
  assert.equal(settings.clarification_depth, 'thorough')
  assert.equal(settings.plan_readback, 'confirm')
  assert.equal(settings.planner_model, 'planner-model')
  assert.equal(settings.progress_bubbles, 'all')
  assert.equal(settings.capabilities_config_path, '/state/capabilities.json')
  assert.equal(settings.knowledge_path, '/state/knowledge.sqlite')
  assert.equal(settings.embedding_provider, 'local')
  assert.equal(settings.embedding_model, 'custom-embedding')
})

test('invalid v4 enum env values fall back safely', () => {
  const settings = loadSettings({
    NOVA_AUDIO_AGENT_EXECUTORS: 'codex',
    NOVA_AUDIO_AGENT_CODEX_APPROVAL_MODE: 'unsafe',
    NOVA_AUDIO_AGENT_CLARIFICATION_DEPTH: 'deep',
    NOVA_AUDIO_AGENT_PLAN_READBACK: 'always',
    NOVA_AUDIO_AGENT_PROGRESS_BUBBLES: 'verbose',
    NOVA_AUDIO_AGENT_EMBEDDING_PROVIDER: 'remote',
    NOVA_AUDIO_AGENT_SEARCH_PROVIDER: 'unknown',
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
    NOVA_AUDIO_AGENT_PIPELINE_MODE: 'cascaded',
    NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER: 'ark',
  })
  const explicit = loadSettings({
    NOVA_AUDIO_AGENT_PIPELINE_MODE: 'cascaded',
    NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER: 'ark',
    NOVA_AUDIO_AGENT_CASCADE_LLM_MODEL: 'ark-custom',
  })
  assert.equal(resolveCascadedSelection(implicit).llmModel, 'doubao-seed-2-0-pro-260215')
  assert.equal(resolveCascadedSelection(explicit).llmModel, 'ark-custom')
  assert.throws(
    () => resolveCascadedSelection(loadSettings({
      NOVA_AUDIO_AGENT_PIPELINE_MODE: 'cascaded',
      NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER: 'ark',
      NOVA_AUDIO_AGENT_CASCADE_LLM_MODEL: '',
    })),
    /NOVA_AUDIO_AGENT_CASCADE_LLM_MODEL 不能为空/u,
  )
})

test('retired realtime provider configuration fails by field name only', () => {
  assert.throws(
    () => loadSettings({NOVA_AUDIO_AGENT_REALTIME_PROVIDER: 'secret-old-value'}),
    error => error instanceof ConfigurationError
      && error.code === 'retired_configuration'
      && error.fields?.join(',') === 'NOVA_AUDIO_AGENT_REALTIME_PROVIDER'
      && !error.message.includes('secret-old-value'),
  )
})

test('retired Ark selector configuration fails by field name only', () => {
  const sentinel = 'secret-old-ark-value'
  for (const field of [
    'NOVA_AUDIO_AGENT_VOLCENGINE_ARK_MODEL',
    'NOVA_AUDIO_AGENT_VOLCENGINE_ARK_SUPPORT_MODEL',
  ] as const) {
    assert.throws(
      () => loadSettings({[field]: sentinel}),
      error => error instanceof ConfigurationError
        && error.code === 'retired_configuration'
        && error.fields?.join(',') === field
        && !error.message.includes(sentinel),
    )
  }
})

test('integrated loading never reads Ark or Doubao credential slots', () => {
  const forbidden = new Set(['ARK_API_KEY', 'DOUBAO_ASR_API_KEY', 'DOUBAO_BIGMODEL_API_KEY'])
  const environment = new Proxy<NodeJS.ProcessEnv>({
    NOVA_AUDIO_AGENT_PIPELINE_MODE: 'integrated',
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
    NOVA_AUDIO_AGENT_PIPELINE_MODE: 'integrated',
    NOVA_AUDIO_AGENT_INTEGRATED_PROVIDER: 'qwen',
    NOVA_AUDIO_AGENT_MODEL_BASE_URL: DASHSCOPE_COMPATIBLE_BASE_URL,
    NOVA_AUDIO_AGENT_MODEL_API_KEY: 'generic-dashscope-key',
  })
  assert.equal(requireIntegratedRealtime(compatible).apiKey, 'generic-dashscope-key')

  const explicit = loadSettings({
    NOVA_AUDIO_AGENT_PIPELINE_MODE: 'integrated',
    NOVA_AUDIO_AGENT_INTEGRATED_PROVIDER: 'qwen',
    NOVA_AUDIO_AGENT_MODEL_BASE_URL: DASHSCOPE_COMPATIBLE_BASE_URL,
    NOVA_AUDIO_AGENT_MODEL_API_KEY: 'generic-dashscope-key',
    DASHSCOPE_API_KEY: 'explicit-dashscope-key',
  })
  assert.equal(requireIntegratedRealtime(explicit).apiKey, 'explicit-dashscope-key')

  const foreign = loadSettings({
    NOVA_AUDIO_AGENT_PIPELINE_MODE: 'integrated',
    NOVA_AUDIO_AGENT_INTEGRATED_PROVIDER: 'qwen',
    NOVA_AUDIO_AGENT_MODEL_BASE_URL: 'https://example.invalid/v1',
    NOVA_AUDIO_AGENT_MODEL_API_KEY: 'foreign-key',
  })
  assert.throws(() => requireIntegratedRealtime(foreign), /DASHSCOPE_API_KEY/u)
})

test('Codex direct argv prefix is parsed only as a bounded JSON string array', () => {
  const configured = loadSettings({
    NOVA_AUDIO_AGENT_EXECUTOR: 'codex',
    NOVA_AUDIO_AGENT_CODEX_PREFIX_ARGS: '["C:\\\\official\\\\codex.js"]',
  })
  assert.deepEqual(configured.codex_prefix_args, ['C:\\official\\codex.js'])
  for (const value of ['not-json', '{}', '["one.js","two.js"]', '[7]']) {
    assert.throws(() => loadSettings({
      NOVA_AUDIO_AGENT_EXECUTOR: 'codex',
      NOVA_AUDIO_AGENT_CODEX_PREFIX_ARGS: value,
    }), /invalid configuration/u)
  }
})

test('integrated loading never reads inactive cascaded selector or model slots', () => {
  const forbidden = new Set([
    'NOVA_AUDIO_AGENT_CASCADE_ENDPOINTING_PROVIDER',
    'NOVA_AUDIO_AGENT_CASCADE_ASR_PROVIDER',
    'NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER',
    'NOVA_AUDIO_AGENT_CASCADE_LLM_MODEL',
    'NOVA_AUDIO_AGENT_CASCADE_TTS_PROVIDER',
  ])
  const environment = new Proxy<NodeJS.ProcessEnv>({
    NOVA_AUDIO_AGENT_PIPELINE_MODE: 'integrated',
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
    llmProvider: 'qwen',
    llmModel: 'qwen-flash',
    ttsProvider: 'volcengine',
  })
})

test('integrated loading ignores invalid inactive cascaded selector and model values', () => {
  const settings = loadSettings({
    NOVA_AUDIO_AGENT_PIPELINE_MODE: 'integrated',
    NOVA_AUDIO_AGENT_CASCADE_ENDPOINTING_PROVIDER: 'invalid-endpointing',
    NOVA_AUDIO_AGENT_CASCADE_ASR_PROVIDER: 'invalid-asr',
    NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER: 'invalid-llm',
    NOVA_AUDIO_AGENT_CASCADE_LLM_MODEL: '',
    NOVA_AUDIO_AGENT_CASCADE_TTS_PROVIDER: 'invalid-tts',
  })
  assert.equal(settings.pipeline_mode, 'integrated')
  assert.deepEqual(resolveCascadedSelection(settings), {
    endpointingProvider: 'auto',
    asrProvider: 'volcengine',
    llmProvider: 'qwen',
    llmModel: 'qwen-flash',
    ttsProvider: 'volcengine',
  })
})

test('cascaded Qwen resolution never reads ARK_API_KEY', () => {
  const environment = new Proxy<NodeJS.ProcessEnv>({
    NOVA_AUDIO_AGENT_PIPELINE_MODE: 'cascaded',
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
  assert.equal('backend' in loadSettings({NOVA_AUDIO_AGENT_BACKEND: 'python'}), false)
})

test('workspace graph settings default off and accept only loopback MyContext endpoints', () => {
  const defaults = loadSettings({})
  assert.equal(defaults.workspace_graph_enabled, false)
  assert.equal(defaults.workspace_graph_path, '~/.nova-audio-agent/workspace-graph.sqlite')
  assert.equal(defaults.mycontext_provider_url, null)
  const enabled = loadSettings({
    NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_ENABLED: 'true',
    NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_PATH: '/private/state/graph.sqlite',
    NOVA_AUDIO_AGENT_MYCONTEXT_PROVIDER_URL: 'http://127.0.0.1:7412/v1',
  })
  assert.equal(enabled.workspace_graph_enabled, true)
  assert.equal(enabled.workspace_graph_path, '/private/state/graph.sqlite')
  assert.equal(enabled.mycontext_provider_url, 'http://127.0.0.1:7412/v1')
  assert.throws(() => loadSettings({
    NOVA_AUDIO_AGENT_MYCONTEXT_PROVIDER_URL: 'https://example.com/context',
  }), /NOVA_AUDIO_AGENT_MYCONTEXT_PROVIDER_URL/u)
  assert.throws(() => loadSettings({
    NOVA_AUDIO_AGENT_MYCONTEXT_PROVIDER_URL: 'http://127.0.0.1:7412/v1?token=secret',
  }), /NOVA_AUDIO_AGENT_MYCONTEXT_PROVIDER_URL/u)
  assert.throws(() => loadSettings({
    NOVA_AUDIO_AGENT_MYCONTEXT_PROVIDER_URL: 'http://127.0.0.1:7412/v1#fragment',
  }), /NOVA_AUDIO_AGENT_MYCONTEXT_PROVIDER_URL/u)
})

test('proactivity presets and individual overrides preserve the Python table', () => {
  assert.deepEqual(
    resolveProactivity(loadSettings({NOVA_AUDIO_AGENT_PROACTIVITY_PRESET: 'conservative'})),
    {cooldown: 120, fresh_window: 20},
  )
  assert.deepEqual(resolveProactivity(loadSettings({
    NOVA_AUDIO_AGENT_PROACTIVITY_PRESET: 'eager',
    NOVA_AUDIO_AGENT_SUGGESTION_COOLDOWN: '5',
  })), {cooldown: 5, fresh_window: 45})
})

test('numeric overrides reject negative, non-finite, and out-of-range values', () => {
  assert.throws(
    () => loadSettings({NOVA_AUDIO_AGENT_SUGGESTION_COOLDOWN: '-1'}),
    ConfigurationError,
  )
  assert.throws(
    () => loadSettings({NOVA_AUDIO_AGENT_FRESH_WINDOW: 'NaN'}),
    /NOVA_AUDIO_AGENT_FRESH_WINDOW/u,
  )
  assert.throws(
    () => loadSettings({NOVA_AUDIO_AGENT_EXECUTOR: 'codex', NOVA_AUDIO_AGENT_CODEX_WORKING_INTERVAL: '601'}),
    ConfigurationError,
  )
})

test('selected Codex settings preserve the established host environment defaults and overrides', () => {
  const defaults = loadSettings({NOVA_AUDIO_AGENT_EXECUTOR: 'codex'}) as unknown as Record<
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
    NOVA_AUDIO_AGENT_EXECUTOR: 'codex',
    NOVA_AUDIO_AGENT_CODEX_WORKSPACE: '\u001c/private/workspace\u0085',
    NOVA_AUDIO_AGENT_CODEX_BIN: '\u001c/private/bin/codex\u0085',
    NOVA_AUDIO_AGENT_CODEX_API_KEY: '\u001csecret\u0085',
    NOVA_AUDIO_AGENT_CODEX_PREWARM: 'false',
    NOVA_AUDIO_AGENT_CODEX_MANAGED_ROOT: '\u001c/private/managed\u0085',
    NOVA_AUDIO_AGENT_CODEX_PROJECT_STATE_ROOT: '\u001c/private/state\u0085',
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
    NOVA_AUDIO_AGENT_EXECUTOR: 'codex',
    NOVA_AUDIO_AGENT_CODEX_WORKING_INTERVAL: '\u001c5\u0085',
  }), /CODEX_WORKING_INTERVAL/u)
  assert.equal(loadSettings({
    NOVA_AUDIO_AGENT_EXECUTOR: 'codex',
    NOVA_AUDIO_AGENT_CODEX_WORKING_INTERVAL: '600',
  }).codex_working_interval, 600)
  assert.throws(
    () => loadSettings({
      NOVA_AUDIO_AGENT_EXECUTOR: 'codex',
      NOVA_AUDIO_AGENT_CODEX_WORKING_INTERVAL: '\ufeff5\ufeff',
    }),
    /NOVA_AUDIO_AGENT_CODEX_WORKING_INTERVAL/u,
  )
})

test('executor list is trimmed, ordered, unique, and non-empty', () => {
  assert.deepEqual(loadSettings({NOVA_AUDIO_AGENT_EXECUTORS: ' slow_sim , codex '}).executors, [
    'slow_sim',
    'codex',
  ])
  assert.throws(
    () => loadSettings({NOVA_AUDIO_AGENT_EXECUTORS: 'codex,,slow_sim'}),
    /empty name/u,
  )
  assert.throws(
    () => loadSettings({NOVA_AUDIO_AGENT_EXECUTORS: 'codex,codex'}),
    /duplicate/u,
  )
})

test('retired executors return explicit removal errors', () => {
  assert.throws(
    () => loadSettings({NOVA_AUDIO_AGENT_EXECUTOR: 'ha'}),
    /was removed/u,
  )
  assert.throws(
    () => loadSettings({NOVA_AUDIO_AGENT_EXECUTORS: 'codex,autoglm'}),
    /was removed/u,
  )
})

test('retired executor selection wins, is case-insensitive, and preserves configured order', () => {
  for (const [environment, capability] of [
    [{NOVA_AUDIO_AGENT_EXECUTOR: ' HA '}, 'ha'],
    [{NOVA_AUDIO_AGENT_EXECUTOR: 'AutoGLM'}, 'autoglm'],
    [{NOVA_AUDIO_AGENT_EXECUTORS: 'codex, AutoGLM , HA'}, 'autoglm'],
    [{NOVA_AUDIO_AGENT_EXECUTORS: 'fast_sim,HA,autoglm'}, 'ha'],
  ] as const) {
    assert.throws(
      () => loadSettings(environment),
      error => {
        const projected = error as ConfigurationError & {
          readonly code?: string
          readonly fields?: readonly string[]
        }
        return projected instanceof ConfigurationError
          && projected.code === 'retired_capability'
          && projected.message === `executor '${capability}' was removed from the Node runtime`
          && projected.fields === undefined
      },
    )
  }
})

test('nonempty retired configuration fails safely while Python whitespace stays inert', () => {
  const retired = [
    ['NOVA_AUDIO_AGENT_HA_URL', 'ha'],
    ['NOVA_AUDIO_AGENT_HA_TOKEN', 'ha'],
    ['NOVA_AUDIO_AGENT_HA_ENTITY_ID', 'ha'],
    ['NOVA_AUDIO_AGENT_AUTOGLM_REPO', 'autoglm'],
    ['NOVA_AUDIO_AGENT_AUTOGLM_PYTHON', 'autoglm'],
    ['NOVA_AUDIO_AGENT_AUTOGLM_BASE_URL', 'autoglm'],
    ['NOVA_AUDIO_AGENT_AUTOGLM_MODEL', 'autoglm'],
    ['NOVA_AUDIO_AGENT_AUTOGLM_API_KEY', 'autoglm'],
    ['NOVA_AUDIO_AGENT_AUTOGLM_WDA_URL', 'autoglm'],
    ['NOVA_AUDIO_AGENT_AUTOGLM_DEVICE_ID', 'autoglm'],
  ] as const
  for (const [field, capability] of retired) {
    assert.doesNotThrow(() => loadSettings({[field]: '\u001c\u0085'}))
    assert.throws(
      () => loadSettings({[field]: '\ufeffsentinel-secret-path-url-device'}),
      error => {
        const projected = error as ConfigurationError & {
          readonly code?: string
          readonly fields?: readonly string[]
        }
        return projected instanceof ConfigurationError
          && projected.code === 'retired_configuration'
          && projected.message
            === `retired capability '${capability}' configuration is not supported: ${field}`
          && Object.isFrozen(projected.fields)
          && projected.fields?.length === 1
          && projected.fields[0] === field
          && !projected.message.includes('sentinel')
      },
    )
  }
})

test('retired configuration fields use canonical code-point order and selector precedence', () => {
  assert.throws(
    () => loadSettings({
      NOVA_AUDIO_AGENT_AUTOGLM_WDA_URL: 'sentinel-url',
      NOVA_AUDIO_AGENT_AUTOGLM_API_KEY: 'sentinel-secret',
    }),
    error => {
      const projected = error as ConfigurationError & {
        readonly code?: string
        readonly fields?: readonly string[]
      }
      return projected instanceof ConfigurationError
        && projected.code === 'retired_configuration'
        && projected.fields?.join(',')
          === 'NOVA_AUDIO_AGENT_AUTOGLM_API_KEY,NOVA_AUDIO_AGENT_AUTOGLM_WDA_URL'
    },
  )
  assert.throws(
    () => loadSettings({
      NOVA_AUDIO_AGENT_EXECUTOR: 'HA',
      NOVA_AUDIO_AGENT_HA_TOKEN: 'sentinel-secret',
    }),
    error => {
      const projected = error as ConfigurationError & {
        readonly code?: string
        readonly fields?: readonly string[]
      }
      return projected instanceof ConfigurationError
        && projected.code === 'retired_capability'
        && projected.fields === undefined
        && !projected.message.includes('sentinel')
    },
  )
})

test('configuration failures never echo secret values', () => {
  const secret = 'never-echo-this-secret'
  let message = ''
  try {
    loadSettings({
      NOVA_AUDIO_AGENT_MODEL_API_KEY: secret,
      NOVA_AUDIO_AGENT_PIPELINE_MODE: 'invalid',
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
    NOVA_AUDIO_AGENT_EXECUTOR: 'fast_sim',
  }, {
    get(target, key, receiver) {
      if (key === 'NOVA_AUDIO_AGENT_CODEX_API_KEY') {
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
    loadSettings({NOVA_AUDIO_AGENT_EXECUTORS: '\u001cslow_sim\u0085,fast_sim'}).executors,
    ['slow_sim', 'fast_sim'],
  )
})

test('Qwen realtime settings preserve Python defaults and every host override', () => {
  const defaults = loadSettings({NOVA_AUDIO_AGENT_MODEL_API_KEY: 'model-key'})
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
    NOVA_AUDIO_AGENT_MODEL_API_KEY: 'model-key',
    DASHSCOPE_API_KEY: 'dash-key',
    NOVA_AUDIO_AGENT_QWEN_REALTIME_URL: ' wss://qwen.example/realtime ',
    NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL: ' qwen-test ',
    NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE: ' voice-test ',
    NOVA_AUDIO_AGENT_QWEN_CONTROLLED_GUARD_RECONNECT: 'true',
    NOVA_AUDIO_AGENT_QWEN_GUARD_HISTORY_RECOVERY: 'packed',
    NOVA_AUDIO_AGENT_QWEN_GUARD_HISTORY_PAIRS: '2',
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
    NOVA_AUDIO_AGENT_QWEN_REALTIME_URL: '\u001cwss://qwen.example/realtime\u0085',
    NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL: '\u001cqwen-test\u0085',
    NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE: '\u001cvoice-test\u0085',
    DASHSCOPE_API_KEY: '\u001cdash-key\u0085',
    NOVA_AUDIO_AGENT_MODEL_API_KEY: '\u001cmodel-key\u0085',
  })
  assert.deepEqual(requireQwenRealtime(pythonWhitespace), {
    url: 'wss://qwen.example/realtime',
    model: 'qwen-test',
    voice: 'voice-test',
    apiKey: 'dash-key',
  })

  assert.throws(
    () => requireQwenRealtime(loadSettings({
      NOVA_AUDIO_AGENT_QWEN_REALTIME_URL: '\ufeffwss://qwen.example/realtime',
      DASHSCOPE_API_KEY: 'dash-key',
    })),
    error => error instanceof ConfigurationError
      && error.message === 'NOVA_AUDIO_AGENT_QWEN_REALTIME_URL 必须使用 wss://',
  )
  assert.throws(
    () => requireQwenRealtime(loadSettings({
      NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL: '\u001c\u0085',
      DASHSCOPE_API_KEY: 'dash-key',
    })),
    /NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL 不能为空/u,
  )
  assert.throws(
    () => requireQwenRealtime(loadSettings({
      NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE: '\u001c\u0085',
      DASHSCOPE_API_KEY: 'dash-key',
    })),
    /NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE 不能为空/u,
  )
  assert.equal(requireQwenRealtime(loadSettings({
    DASHSCOPE_API_KEY: '\ufeff',
    NOVA_AUDIO_AGENT_MODEL_API_KEY: 'model-key',
  })).apiKey, '\ufeff')
  assert.deepEqual(requireQwenRealtime(loadSettings({
    NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL: '\ufeffqwen-test\ufeff',
    NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE: '\ufeffvoice-test\ufeff',
    NOVA_AUDIO_AGENT_MODEL_API_KEY: '\ufeffmodel-key\ufeff',
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
      NOVA_AUDIO_AGENT_QWEN_REALTIME_URL: `https://qwen.invalid/?token=${sentinel}`,
      NOVA_AUDIO_AGENT_MODEL_API_KEY: sentinel,
    }, 'NOVA_AUDIO_AGENT_QWEN_REALTIME_URL 必须使用 wss://'],
    [{
      NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL: '\u001c',
      NOVA_AUDIO_AGENT_MODEL_API_KEY: sentinel,
    }, 'NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL 不能为空'],
    [{
      NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE: '\u0085',
      DASHSCOPE_API_KEY: sentinel,
    }, 'NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE 不能为空'],
    [{
      NOVA_AUDIO_AGENT_QWEN_REALTIME_URL: `wss://qwen.invalid/?token=${sentinel}`,
      DASHSCOPE_API_KEY: '\u001c',
      NOVA_AUDIO_AGENT_MODEL_API_KEY: '\u0085',
    }, '缺少 DASHSCOPE_API_KEY 或 NOVA_AUDIO_AGENT_MODEL_API_KEY'],
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
      NOVA_AUDIO_AGENT_QWEN_CONTROLLED_GUARD_RECONNECT: value,
    }).qwen_controlled_guard_reconnect, true)
  }
  for (const value of falsy) {
    assert.equal(loadSettings({
      NOVA_AUDIO_AGENT_QWEN_CONTROLLED_GUARD_RECONNECT: value,
    }).qwen_controlled_guard_reconnect, false)
  }
  for (const value of ['1', '2', '4']) {
    assert.equal(loadSettings({
      NOVA_AUDIO_AGENT_QWEN_GUARD_HISTORY_PAIRS: value,
    }).qwen_guard_history_pairs, Number(value))
  }
})

test('Qwen boolean and Guard enum settings do not strip their raw environment values', () => {
  for (const [variable, value] of [
    ['NOVA_AUDIO_AGENT_QWEN_CONTROLLED_GUARD_RECONNECT', 'maybe'],
    ['NOVA_AUDIO_AGENT_QWEN_CONTROLLED_GUARD_RECONNECT', ' true '],
    ['NOVA_AUDIO_AGENT_QWEN_CONTROLLED_GUARD_RECONNECT', '\u001ctrue\u001c'],
    ['NOVA_AUDIO_AGENT_QWEN_GUARD_HISTORY_RECOVERY', 'native'],
    ['NOVA_AUDIO_AGENT_QWEN_GUARD_HISTORY_RECOVERY', ' packed '],
    ['NOVA_AUDIO_AGENT_QWEN_GUARD_HISTORY_PAIRS', '3'],
    ['NOVA_AUDIO_AGENT_QWEN_GUARD_HISTORY_PAIRS', ' 2 '],
    ['NOVA_AUDIO_AGENT_QWEN_GUARD_HISTORY_PAIRS', ''],
  ] as const) {
    assert.throws(
      () => loadSettings({[variable]: value}),
      error => error instanceof ConfigurationError && error.message.includes(variable.slice(17)),
    )
  }
})

test('Volcengine resolver returns a new immutable value and never aliases settings', () => {
  const settings = loadSettings({
    NOVA_AUDIO_AGENT_PIPELINE_MODE: 'cascaded',
    NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER: 'ark',
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
      NOVA_AUDIO_AGENT_PIPELINE_MODE: 'cascaded',
      NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER: 'ark',
      ARK_API_KEY: sentinel,
      DOUBAO_BIGMODEL_API_KEY: sentinel,
      NOVA_AUDIO_AGENT_DOUBAO_ASR_ENDPOINT: `https://${sentinel}.example/asr`,
    }))
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  assert.equal(message.includes(sentinel), false)
  assert.equal(message, 'NOVA_AUDIO_AGENT_DOUBAO_ASR_ENDPOINT 必须是安全的 wss:// 地址')
})

test('Volcengine numeric relationships retain the Python resolver errors', () => {
  const credentials = {
    NOVA_AUDIO_AGENT_PIPELINE_MODE: 'cascaded',
    NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER: 'ark',
    ARK_API_KEY: 'ark-key',
    DOUBAO_BIGMODEL_API_KEY: 'tts-key',
  }
  const cases: readonly [NodeJS.ProcessEnv, string][] = [
    [{NOVA_AUDIO_AGENT_DOUBAO_ASR_CHUNK_MS: '0'},
      'NOVA_AUDIO_AGENT_DOUBAO_ASR_CHUNK_MS 必须为正整数'],
    [{NOVA_AUDIO_AGENT_DOUBAO_TTS_OUTPUT_SAMPLE_RATE: '16000'},
      'NOVA_AUDIO_AGENT_DOUBAO_TTS_OUTPUT_SAMPLE_RATE 必须为 24000'],
    [{NOVA_AUDIO_AGENT_VOLCENGINE_VAD_THRESHOLD: 'NaN'},
      'NOVA_AUDIO_AGENT_VOLCENGINE_VAD_THRESHOLD 必须在 (0, 1] 内'],
    [{NOVA_AUDIO_AGENT_VOLCENGINE_VAD_PRE_ROLL_MS: '-1'},
      '火山 VAD pre-roll 与 speech pad 不能为负数'],
    [{NOVA_AUDIO_AGENT_VOLCENGINE_VAD_MIN_SPEECH_MS: '0'},
      '火山 VAD min speech 与 silence end 必须为正整数'],
    [{
      NOVA_AUDIO_AGENT_VOLCENGINE_VAD_MIN_SPEECH_MS: '251',
      NOVA_AUDIO_AGENT_VOLCENGINE_VAD_MAX_UTTERANCE_MS: '250',
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
    NOVA_AUDIO_AGENT_MEMORY_CONNECTION: 'remote',
    NOVA_AUDIO_AGENT_MEMORY_URL: 'http://127.0.0.1:8787',
    NOVA_AUDIO_AGENT_MEMORY_TOKEN: 'owner-token',
  }
  assert.deepEqual(requirePersonalMemory(loadSettings(remote)), {
    connection: 'remote', url: remote.NOVA_AUDIO_AGENT_MEMORY_URL, token: 'owner-token',
  })
  const local = {NOVA_AUDIO_AGENT_MEMORY_CONNECTION:'local',
    NOVA_AUDIO_AGENT_MODEL_API_KEY:'test', NOVA_AUDIO_AGENT_MODEL_BASE_URL:'https://example.com/v1'}
  assert.deepEqual(requirePersonalMemory(loadSettings(local)),
    requirePersonalMemory(loadSettings({...local, NOVA_AUDIO_AGENT_MEMORY_PROVIDER:'voicemem'})))
  assert.equal(requirePersonalMemory(loadSettings({NOVA_AUDIO_AGENT_MEMORY_CONNECTION:'disabled'})), null)
  assert.throws(() => loadSettings({...remote, NOVA_AUDIO_AGENT_MEMORY_PROVIDER:'voicemem'}), ConfigurationError)
  assert.throws(() => loadSettings({...local, NOVA_AUDIO_AGENT_MEMORY_PROVIDER:'unknown'}), ConfigurationError)
  assert.throws(() => loadSettings({NOVA_AUDIO_AGENT_MEMORY_PROVIDER:'voicemem'}), ConfigurationError)
  assert.throws(() => requirePersonalMemory(loadSettings({...remote,NOVA_AUDIO_AGENT_MEMORY_TOKEN:''})), ConfigurationError)
})

test('removed memory backend configuration fails explicitly instead of silently disabling memory', () => {
  for (const backend of ['voicemem', 'http', 'disabled']) {
    assert.throws(() => loadSettings({NOVA_AUDIO_AGENT_MEMORY_BACKEND:backend}), /MEMORY_CONNECTION/u)
  }
})

test('mem0 is available only as a runtime-local provider', () => {
  const env = {NOVA_AUDIO_AGENT_MEMORY_CONNECTION:'local',NOVA_AUDIO_AGENT_MEMORY_PROVIDER:'mem0',
    NOVA_AUDIO_AGENT_MODEL_API_KEY:'test',NOVA_AUDIO_AGENT_MODEL_BASE_URL:'https://example.com/v1'}
  const config = requirePersonalMemory(loadSettings(env))
  assert.ok(config?.connection === 'local')
  assert.equal(config.provider, 'mem0')
  assert.throws(() => loadSettings({...env,NOVA_AUDIO_AGENT_MEMORY_CONNECTION:'remote'}), /only valid for a local/u)
  assert.throws(() => loadSettings({...env,NOVA_AUDIO_AGENT_MEMORY_CONNECTION:'disabled'}), /only valid for a local/u)
})
