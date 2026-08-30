import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'

import {
  BACKEND_DRAIN_GRACE_MS,
  READINESS_SOCKET_AUTH_TIMEOUT_MS,
  backendLaunchSpec,
  createReadinessListener,
  nodeRuntimeEntry,
  parseReadiness,
  selectedBackend,
  shutdownBackend,
  watchBackendExit,
} from '../src/main/backend.mjs'

const TOKEN = 'b'.repeat(32)
const SETTINGS_V2 = Object.freeze({
  version: 2,
  palette: 'ember',
  proactivity: 'balanced',
  codexHeartbeatSeconds: 30,
  pipelineMode: 'integrated',
  integratedProvider: 'qwen',
  integratedModel: 'qwen-audio-3.0-realtime-plus',
  integratedVoice: 'longanqian',
  cascadedEndpointingProvider: 'auto',
  cascadedAsrProvider: 'volcengine',
  cascadedLlmProvider: 'qwen',
  cascadedLlmModels: Object.freeze({
    qwen: 'qwen-flash',
    ark: 'doubao-seed-2-0-pro-260215',
  }),
  cascadedTtsProvider: 'volcengine',
  cascadedTtsVoice: 'zh_female_vv_uranus_bigtts',
})

function nodeLaunchSpec(options) {
  return backendLaunchSpec({
    backend: 'node',
    nodeEntry: '/repo/runtime/dist/src/desktop-entry.js',
    nodeResourcesPath: '/repo/desktop/ambient-orb/build',
    ...options,
  })
}

function readinessLine(overrides = {}) {
  return `${JSON.stringify({ token: TOKEN, host: '127.0.0.1', port: 49152, ...overrides })}\n`
}

// Dials the listener the way the backend does: one line, then close. Resolves
// with the socket outcome so a rejected handshake is observable in the test.
function dial(endpoint, payload) {
  const [host, rawPort] = endpoint.split(':')
  return new Promise(done => {
    const socket = net.connect({ host, port: Number(rawPort) }, () => {
      if (payload === undefined) socket.end()
      else socket.end(payload)
    })
    socket.once('error', error => done({ code: error.code }))
    socket.once('close', () => done({ closed: true }))
  })
}

// Same dial, but the client never closes: only the listener destroying the
// socket can settle this, so a missing socket.destroy() is observable.
function dialOpen(endpoint, payload) {
  const [host, rawPort] = endpoint.split(':')
  return new Promise(done => {
    const socket = net.connect({ host, port: Number(rawPort) }, () => socket.write(payload))
    const give = setTimeout(() => {
      socket.destroy()
      done({ open: true })
    }, 1000)
    const finish = outcome => {
      clearTimeout(give)
      done(outcome)
    }
    socket.once('error', error => finish({ code: error.code }))
    socket.once('close', () => finish({ closed: true }))
  })
}

function pending(promise, ms = 60) {
  return Promise.race([
    promise.then(() => 'settled', () => 'settled'),
    new Promise(done => setTimeout(() => done('pending'), ms)),
  ])
}

// A child process double: every stdin/signal effect lands in `calls` in order,
// and 'exit' is emitted on demand so the grace race is driven by the test.
function fakeChild() {
  const calls = []
  const listeners = new Map()
  return {
    calls,
    exitCode: null,
    signalCode: null,
    stdin: { writable: true, destroyed: false, end: () => calls.push('stdin.end') },
    kill: signal => {
      calls.push(`kill:${signal}`)
      return true
    },
    once(event, listener) {
      const bucket = listeners.get(event) || []
      bucket.push(listener)
      listeners.set(event, bucket)
      return this
    },
    // Fires the one-shot listeners the helper registered, the way a real exit does.
    emit(event, ...args) {
      const bucket = listeners.get(event) || []
      listeners.set(event, [])
      for (const listener of bucket) listener(...args)
    },
  }
}

test('passes token only through environment and dials back over loopback', () => {
  const spec = nodeLaunchSpec({
    workspace: '/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv: { PATH: '/usr/bin' },
  })

  assert.deepEqual(spec.argv, [])
  assert.equal(spec.env.NOVA_AUDIO_AGENT_DESKTOP_TOKEN, TOKEN)
  assert.equal(spec.env.NOVA_AUDIO_AGENT_DESKTOP_READY_ENDPOINT, '127.0.0.1:49152')
  assert.equal('NOVA_AUDIO_AGENT_DESKTOP_READY_FD' in spec.env, false)
  assert.equal(spec.env.NOVA_AUDIO_AGENT_CODEX_WORKSPACE, '/workspace')
  assert.deepEqual(spec.stdio, ['ignore', 'pipe', 'pipe'])
  assert.equal(spec.stdio.length, 3)
  assert.equal(JSON.stringify(spec.argv).includes(TOKEN), false)
  assert.equal(spec.kind, 'node')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_BACKEND, 'node')
})

test('backend selection is Node-only and refuses the retired Python rollback', () => {
  assert.equal(selectedBackend({}), 'node')
  assert.equal(selectedBackend({ NOVA_AUDIO_AGENT_BACKEND: 'node' }), 'node')
  assert.throws(
    () => selectedBackend({ NOVA_AUDIO_AGENT_BACKEND: 'python' }),
    error => error?.code === 'source_rollback_unavailable'
      && error.message === 'source_rollback_unavailable',
  )
  assert.throws(
    () => selectedBackend({ NOVA_AUDIO_AGENT_BACKEND: 'private-invalid-value' }),
    error => !error.message.includes('private-invalid-value'),
  )
})

test('packaged backend selection refuses explicit Python before resolving an interpreter', () => {
  assert.equal(selectedBackend({}, { isPackaged: true }), 'node')
  assert.equal(
    selectedBackend({ NOVA_AUDIO_AGENT_BACKEND: 'node' }, { isPackaged: true }),
    'node',
  )
  assert.throws(
    () => selectedBackend(
      {
        NOVA_AUDIO_AGENT_BACKEND: 'python',
        NOVA_AUDIO_AGENT_PYTHON: '/private/poison/python',
        PATH: '/private/poison',
      },
      { isPackaged: true },
    ),
    error => error?.code === 'source_rollback_unavailable'
      && error.message === 'source_rollback_unavailable',
  )
})

test('launch spec cannot construct the retired Python process', () => {
  assert.throws(() => nodeLaunchSpec({
    backend: 'python',
    python: '/private/poison/python',
    workspace: '/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv: {},
  }), /backend kind is invalid/)
})

test('Node launch uses the compiled utility-process entry and no writable stdin', () => {
  const nodeEntry = '/repo/runtime/dist/src/desktop-entry.js'
  const nodeResourcesPath = '/repo/desktop/ambient-orb/build'
  const spec = nodeLaunchSpec({
    backend: 'node',
    nodeEntry,
    nodeResourcesPath,
    workspace: '/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv: { PATH: '/usr/bin' },
  })

  assert.equal(spec.kind, 'node')
  assert.equal(spec.entry, nodeEntry)
  assert.deepEqual(spec.argv, [])
  assert.deepEqual(spec.stdio, ['ignore', 'pipe', 'pipe'])
  assert.equal(spec.env.NOVA_AUDIO_AGENT_BACKEND, 'node')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_CODEX_RESOURCES_PATH, nodeResourcesPath)
  assert.equal(JSON.stringify(spec).includes(TOKEN), true)
  assert.equal(JSON.stringify(spec.argv).includes(TOKEN), false)
  assert.throws(() => nodeLaunchSpec({
    backend: 'node',
    nodeEntry: 'relative-entry.js',
    nodeResourcesPath,
    workspace: '/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv: {},
  }), /absolute Node runtime entry/)
  assert.throws(() => nodeLaunchSpec({
    backend: 'node',
    nodeEntry,
    nodeResourcesPath: 'relative-resources',
    workspace: '/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv: {},
  }), /absolute Node resource root/)
})

test('resolved desktop settings override inherited Codex and model configuration', () => {
  const spec = nodeLaunchSpec({
    backend: 'node',
    nodeEntry: '/repo/runtime/dist/src/desktop-entry.js',
    nodeResourcesPath: '/repo/desktop/ambient-orb/build',
    workspace: '/environment/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv: {
      NOVA_AUDIO_AGENT_CODEX_BIN: '/environment/codex',
      NOVA_AUDIO_AGENT_CODEX_PREFIX_ARGS: '["/environment/shim.js"]',
      NOVA_AUDIO_AGENT_CODEX_MANAGED_ROOT: '/environment/managed',
      NOVA_AUDIO_AGENT_CODEX_PROJECT_STATE_ROOT: '/environment/state',
      NOVA_AUDIO_AGENT_MODEL_BASE_URL: 'https://environment.example/v1',
    },
    resolvedConfig: {
      workspace: '/settings/workspace',
      codexBinaryPath: '/settings/codex',
      codexBinaryPrefixArgs: ['/settings/node_modules/@openai/codex/bin/codex.js'],
      managedRoot: '/settings/managed',
      modelBaseUrl: 'https://settings.example/v1',
      paths: {stateRoot: '/settings/state'},
    },
  })

  assert.equal(spec.env.NOVA_AUDIO_AGENT_CODEX_WORKSPACE, '/settings/workspace')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_CODEX_BIN, '/settings/codex')
  assert.equal(
    spec.env.NOVA_AUDIO_AGENT_CODEX_PREFIX_ARGS,
    '["/settings/node_modules/@openai/codex/bin/codex.js"]',
  )
  assert.equal(spec.env.NOVA_AUDIO_AGENT_CODEX_MANAGED_ROOT, '/settings/managed')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_CODEX_PROJECT_STATE_ROOT, '/settings/state')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_MODEL_BASE_URL, 'https://settings.example/v1')
})

test('resolved desktop configuration removes an invalid inherited Codex binary', () => {
  const spec = nodeLaunchSpec({
    backend: 'node',
    nodeEntry: '/repo/runtime/dist/src/desktop-entry.js',
    nodeResourcesPath: '/repo/desktop/ambient-orb/build',
    workspace: '/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv: {
      NOVA_AUDIO_AGENT_CODEX_BIN: '/private/invalid-codex',
      NOVA_AUDIO_AGENT_CODEX_PREFIX_ARGS: '["/private/invalid.js"]',
    },
    resolvedConfig: {
      workspace: '/workspace',
      codexBinaryPath: '',
      managedRoot: '/managed',
      modelBaseUrl: '',
      paths: {stateRoot: '/state'},
    },
  })

  assert.equal('NOVA_AUDIO_AGENT_CODEX_BIN' in spec.env, false)
  assert.equal('NOVA_AUDIO_AGENT_CODEX_PREFIX_ARGS' in spec.env, false)
})

test('runtime entry resolves inside the workspace for dev and the asar for packages', () => {
  const developmentPackage = resolve('/repo/desktop/ambient-orb')
  assert.equal(nodeRuntimeEntry({
    isPackaged: false,
    appPath: developmentPackage,
    packageRoot: developmentPackage,
  }), resolve(developmentPackage, '../../runtime/dist/src/desktop-entry.js'))
  const packagedApp = resolve('/Applications/Nova.app/Contents/Resources/app.asar')
  assert.equal(nodeRuntimeEntry({
    isPackaged: true,
    appPath: packagedApp,
    packageRoot: '/unused/desktop',
  }), resolve(packagedApp, 'node_modules/@nova-audio-agent/runtime/dist/src/desktop-entry.js'))
})

test('launch spec strips a stale inherited readiness pipe', () => {
  const spec = nodeLaunchSpec({
    workspace: '/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv: { NOVA_AUDIO_AGENT_DESKTOP_READY_FD: '3' },
  })

  assert.equal('NOVA_AUDIO_AGENT_DESKTOP_READY_FD' in spec.env, false)
})

test('integrated launch injects all active public settings and only its platform credential', () => {
  const spec = nodeLaunchSpec({
    workspace: '/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv: {},
    settings: {
      ...SETTINGS_V2,
      proactivity: 'eager',
      codexHeartbeatSeconds: 45,
      integratedModel: 'qwen-integrated-custom',
      integratedVoice: 'longxiaochun',
      cascadedLlmProvider: 'ark',
    },
    decryptedSecrets: {
      dashscopeApiKey: 'dash-key',
      arkApiKey: 'ark-key',
      doubaoBigmodelApiKey: 'doubao-key',
      doubaoAsrApiKey: 'asr-key',
    },
  })

  assert.equal(spec.env.NOVA_AUDIO_AGENT_PROACTIVITY_PRESET, 'eager')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_CODEX_WORKING_INTERVAL, '45')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_PIPELINE_MODE, 'integrated')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_INTEGRATED_PROVIDER, 'qwen')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL, 'qwen-integrated-custom')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE, 'longxiaochun')
  assert.equal(spec.env.DASHSCOPE_API_KEY, 'dash-key')
  for (const name of [
    'NOVA_AUDIO_AGENT_CASCADE_ENDPOINTING_PROVIDER',
    'NOVA_AUDIO_AGENT_CASCADE_ASR_PROVIDER',
    'NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER',
    'NOVA_AUDIO_AGENT_CASCADE_LLM_MODEL',
    'NOVA_AUDIO_AGENT_CASCADE_TTS_PROVIDER',
    'NOVA_AUDIO_AGENT_DOUBAO_TTS_VOICE',
    'ARK_API_KEY',
    'DOUBAO_BIGMODEL_API_KEY',
    'DOUBAO_ASR_API_KEY',
  ]) {
    assert.equal(name in spec.env, false, `${name} is inactive for integrated mode`)
  }
})

test('cascaded Qwen launch injects active selectors, remembered model, and Doubao credentials', () => {
  const settings = {
    ...SETTINGS_V2,
    pipelineMode: 'cascaded',
    cascadedLlmProvider: 'qwen',
    cascadedLlmModels: { qwen: 'qwen-flash', ark: 'ark-remembered' },
    cascadedTtsVoice: 'zh_female_custom',
  }
  const spec = nodeLaunchSpec({
    workspace: '/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv: {},
    settings,
    decryptedSecrets: {
      dashscopeApiKey: 'dash-key',
      arkApiKey: 'ark-key',
      doubaoBigmodelApiKey: 'doubao-key',
      doubaoAsrApiKey: 'asr-key',
    },
  })

  assert.equal(spec.env.NOVA_AUDIO_AGENT_PIPELINE_MODE, 'cascaded')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_CASCADE_ENDPOINTING_PROVIDER, 'auto')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_CASCADE_ASR_PROVIDER, 'volcengine')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER, 'qwen')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_CASCADE_LLM_MODEL, 'qwen-flash')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_CASCADE_TTS_PROVIDER, 'volcengine')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_DOUBAO_TTS_VOICE, 'zh_female_custom')
  assert.equal(spec.env.DASHSCOPE_API_KEY, 'dash-key')
  assert.equal(spec.env.DOUBAO_BIGMODEL_API_KEY, 'doubao-key')
  assert.equal(spec.env.DOUBAO_ASR_API_KEY, 'asr-key')
  assert.equal('ARK_API_KEY' in spec.env, false)
  assert.equal('NOVA_AUDIO_AGENT_INTEGRATED_PROVIDER' in spec.env, false)
  assert.equal('NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL' in spec.env, false)
  assert.equal('NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE' in spec.env, false)
  assert.deepEqual(settings.cascadedLlmModels, {
    qwen: 'qwen-flash',
    ark: 'ark-remembered',
  })
})

test('cascaded Ark launch selects the remembered Ark model without injecting DashScope', () => {
  const settings = {
    ...SETTINGS_V2,
    pipelineMode: 'cascaded',
    cascadedLlmProvider: 'ark',
    cascadedLlmModels: { qwen: 'qwen-remembered', ark: 'ark-selected' },
  }
  const spec = nodeLaunchSpec({
    workspace: '/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv: {},
    settings,
    decryptedSecrets: {
      dashscopeApiKey: 'dash-key',
      arkApiKey: 'ark-key',
      doubaoBigmodelApiKey: 'doubao-key',
    },
  })

  assert.equal(spec.env.NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER, 'ark')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_CASCADE_LLM_MODEL, 'ark-selected')
  assert.equal(spec.env.ARK_API_KEY, 'ark-key')
  assert.equal(spec.env.DOUBAO_BIGMODEL_API_KEY, 'doubao-key')
  assert.equal('DASHSCOPE_API_KEY' in spec.env, false)
  assert.equal('DOUBAO_ASR_API_KEY' in spec.env, false)
  assert.deepEqual(settings.cascadedLlmModels, {
    qwen: 'qwen-remembered',
    ark: 'ark-selected',
  })
})

test('absent cascaded ASR override does not duplicate the big-model secret', () => {
  const spec = nodeLaunchSpec({
    workspace: '/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv: { DOUBAO_ASR_API_KEY: 'parent-asr-key' },
    settings: { ...SETTINGS_V2, pipelineMode: 'cascaded' },
    decryptedSecrets: { doubaoBigmodelApiKey: 'doubao-key' },
  })

  assert.equal(spec.env.DOUBAO_BIGMODEL_API_KEY, 'doubao-key')
  assert.equal(spec.env.DOUBAO_ASR_API_KEY, 'parent-asr-key')
  assert.notEqual(spec.env.DOUBAO_ASR_API_KEY, spec.env.DOUBAO_BIGMODEL_API_KEY)
})

test('launch spec falls back to the settings-store defaults when settings is missing', () => {
  const spec = nodeLaunchSpec({
    workspace: '/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv: {},
  })

  assert.equal(spec.env.NOVA_AUDIO_AGENT_PROACTIVITY_PRESET, 'balanced')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_CODEX_WORKING_INTERVAL, '30')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_PIPELINE_MODE, 'integrated')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_INTEGRATED_PROVIDER, 'qwen')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL, 'qwen-audio-3.0-realtime-plus')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE, 'longanqian')
})

test('launch spec falls back per-field for a partially-populated settings object', () => {
  const spec = nodeLaunchSpec({
    workspace: '/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv: {},
    settings: { proactivity: 'conservative' },
  })

  assert.equal(spec.env.NOVA_AUDIO_AGENT_PROACTIVITY_PRESET, 'conservative')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_CODEX_WORKING_INTERVAL, '30')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_PIPELINE_MODE, 'integrated')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_INTEGRATED_PROVIDER, 'qwen')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL, 'qwen-audio-3.0-realtime-plus')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE, 'longanqian')
})

test('launch spec injects decrypted secrets as env overrides when present', () => {
  const spec = nodeLaunchSpec({
    workspace: '/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv: {},
    decryptedSecrets: {
      dashscopeApiKey: 'dash-key',
      tavilyApiKey: 'tavily-key',
      modelApiKey: 'model-key',
      codexApiKey: 'codex-key',
      arkApiKey: 'ark-key',
      doubaoBigmodelApiKey: 'doubao-key',
      doubaoAsrApiKey: 'asr-key',
    },
  })

  assert.equal(spec.env.DASHSCOPE_API_KEY, 'dash-key')
  assert.equal(spec.env.TAVILY_API_KEY, 'tavily-key')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_MODEL_API_KEY, 'model-key')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_CODEX_API_KEY, 'codex-key')
  assert.equal('ARK_API_KEY' in spec.env, false)
  assert.equal('DOUBAO_BIGMODEL_API_KEY' in spec.env, false)
  assert.equal('DOUBAO_ASR_API_KEY' in spec.env, false)
})

test('launch spec supplies the resolved desktop search proxy without overriding explicit env', () => {
  const detected = nodeLaunchSpec({
    workspace: '/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv: {},
    searchProxyUrl: 'http://127.0.0.1:7890',
  })
  assert.equal(detected.env.HTTPS_PROXY, 'http://127.0.0.1:7890')

  const explicit = nodeLaunchSpec({
    workspace: '/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv: { HTTPS_PROXY: 'http://explicit.example:8080' },
    searchProxyUrl: 'http://127.0.0.1:7890',
  })
  assert.equal(explicit.env.HTTPS_PROXY, 'http://explicit.example:8080')
})

test('Electron proxy rules expose only the first supported proxy endpoint', async () => {
  const backend = await import('../src/main/backend.mjs')
  assert.equal(typeof backend.searchProxyUrlFromRules, 'function')
  assert.equal(
    backend.searchProxyUrlFromRules('PROXY 127.0.0.1:7890; DIRECT'),
    'http://127.0.0.1:7890',
  )
  assert.equal(backend.searchProxyUrlFromRules('HTTPS proxy.example:443'), 'https://proxy.example:443')
  assert.equal(backend.searchProxyUrlFromRules('SOCKS5 127.0.0.1:7891; DIRECT'), '')
  assert.equal(backend.searchProxyUrlFromRules('DIRECT'), '')
})

test('launch spec omits a secret env var entirely when absent, empty, or undefined', () => {
  const spec = nodeLaunchSpec({
    workspace: '/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv: {},
    decryptedSecrets: { dashscopeApiKey: '', tavilyApiKey: null },
  })

  assert.equal('DASHSCOPE_API_KEY' in spec.env, false)
  assert.equal('TAVILY_API_KEY' in spec.env, false)
  assert.equal('NOVA_AUDIO_AGENT_MODEL_API_KEY' in spec.env, false)
  assert.equal('NOVA_AUDIO_AGENT_CODEX_API_KEY' in spec.env, false)
  assert.equal('ARK_API_KEY' in spec.env, false)
  assert.equal('DOUBAO_BIGMODEL_API_KEY' in spec.env, false)
  assert.equal('DOUBAO_ASR_API_KEY' in spec.env, false)

  const noSecretsAtAll = nodeLaunchSpec({
    workspace: '/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv: {},
  })
  assert.equal('DASHSCOPE_API_KEY' in noSecretsAtAll.env, false)
})

test('launch spec omits a whitespace-only decrypted secret, letting the parent value survive', () => {
  const spec = nodeLaunchSpec({
    workspace: '/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv: { DASHSCOPE_API_KEY: 'from-dotenv' },
    decryptedSecrets: { dashscopeApiKey: '   ' },
  })

  // A whitespace-only decrypted value is truthy in JS but unusable as a key,
  // so it must be treated exactly like "absent": omitted from `env` entirely
  // rather than overriding the parent's working value with garbage.
  assert.equal(spec.env.DASHSCOPE_API_KEY, 'from-dotenv')
})

test('launch spec omits a decrypted secret carrying a control character', () => {
  const spec = nodeLaunchSpec({
    workspace: '/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv: { DASHSCOPE_API_KEY: 'from-dotenv' },
    decryptedSecrets: {
      dashscopeApiKey: 'sk-\u0000poison',
      modelApiKey: 'mk-\u001bpoison',
      tavilyApiKey: 'tvly-clean',
    },
  })

  // Node refuses a NUL in an env value and the spawn throws, which would take
  // the app down at launch — before the panel could clear the bad key. The
  // injection loop is the last line of defence: drop the value, keep the rest,
  // and let the parent environment's own value stand.
  assert.equal(spec.env.DASHSCOPE_API_KEY, 'from-dotenv')
  assert.equal('NOVA_AUDIO_AGENT_MODEL_API_KEY' in spec.env, false)
  assert.equal(spec.env.TAVILY_API_KEY, 'tvly-clean')
  for (const value of Object.values(spec.env)) {
    assert.doesNotMatch(String(value), /poison/, 'no poisoned value survives into env')
  }
})

test('integrated launch rejects raw boundary controls in every active secret override', () => {
  const parentEnv = {
    DASHSCOPE_API_KEY: 'parent-dash',
    TAVILY_API_KEY: 'parent-tavily',
    NOVA_AUDIO_AGENT_MODEL_API_KEY: 'parent-model',
    NOVA_AUDIO_AGENT_CODEX_API_KEY: 'parent-codex',
  }
  const spec = nodeLaunchSpec({
    workspace: '/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv,
    settings: SETTINGS_V2,
    decryptedSecrets: {
      dashscopeApiKey: '\ndash-override',
      tavilyApiKey: 'tavily-override\r',
      modelApiKey: '\tmodel-override',
      codexApiKey: 'codex-override\u007f',
    },
  })

  assert.equal(spec.env.DASHSCOPE_API_KEY, 'parent-dash')
  assert.equal(spec.env.TAVILY_API_KEY, 'parent-tavily')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_MODEL_API_KEY, 'parent-model')
  assert.equal(spec.env.NOVA_AUDIO_AGENT_CODEX_API_KEY, 'parent-codex')
})

test('cascaded Ark launch rejects raw boundary controls in every new secret override', () => {
  const parentEnv = {
    ARK_API_KEY: 'parent-ark',
    DOUBAO_BIGMODEL_API_KEY: 'parent-doubao',
    DOUBAO_ASR_API_KEY: 'parent-asr',
  }
  const spec = nodeLaunchSpec({
    workspace: '/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv,
    settings: {
      ...SETTINGS_V2,
      pipelineMode: 'cascaded',
      cascadedLlmProvider: 'ark',
    },
    decryptedSecrets: {
      arkApiKey: '\nark-override',
      doubaoBigmodelApiKey: 'doubao-override\r',
      doubaoAsrApiKey: '\tasr-override',
    },
  })

  assert.equal(spec.env.ARK_API_KEY, 'parent-ark')
  assert.equal(spec.env.DOUBAO_BIGMODEL_API_KEY, 'parent-doubao')
  assert.equal(spec.env.DOUBAO_ASR_API_KEY, 'parent-asr')
})

test('launch spec injects a decrypted secret with its surrounding whitespace trimmed', () => {
  const spec = nodeLaunchSpec({
    workspace: '/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv: {},
    decryptedSecrets: { dashscopeApiKey: '  sk-x  ' },
  })

  // Accidental surrounding whitespace from a pasted key is cleaned up, not
  // injected verbatim.
  assert.equal(spec.env.DASHSCOPE_API_KEY, 'sk-x')
})

test('a parent-env api key survives when the panel key is absent, and is overridden when present', () => {
  const withoutPanelKey = nodeLaunchSpec({
    workspace: '/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv: { DASHSCOPE_API_KEY: 'from-dotenv' },
  })
  assert.equal(withoutPanelKey.env.DASHSCOPE_API_KEY, 'from-dotenv')

  const withEmptyPanelKey = nodeLaunchSpec({
    workspace: '/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv: { DASHSCOPE_API_KEY: 'from-dotenv' },
    decryptedSecrets: { dashscopeApiKey: '' },
  })
  assert.equal(withEmptyPanelKey.env.DASHSCOPE_API_KEY, 'from-dotenv')

  const withPanelKey = nodeLaunchSpec({
    workspace: '/workspace',
    token: TOKEN,
    readyEndpoint: '127.0.0.1:49152',
    parentEnv: { DASHSCOPE_API_KEY: 'from-dotenv' },
    decryptedSecrets: { dashscopeApiKey: 'from-panel' },
  })
  assert.equal(withPanelKey.env.DASHSCOPE_API_KEY, 'from-panel')
})

test('launch spec refuses any readiness endpoint that is not a loopback port', () => {
  const base = {
    workspace: '/workspace',
    token: TOKEN,
    parentEnv: {},
  }
  for (const readyEndpoint of [
    'localhost:49152',
    '0.0.0.0:49152',
    '127.0.0.1',
    '127.0.0.1:0',
    '127.0.0.1:70000',
    '127.0.0.1:49152 ',
    '',
  ]) {
    assert.throws(
      () => nodeLaunchSpec({ ...base, readyEndpoint }),
      /readiness endpoint/,
      `expected ${JSON.stringify(readyEndpoint)} to be rejected`,
    )
  }
})

test('readiness accepts one bounded loopback port and matching token', () => {
  assert.deepEqual(parseReadiness(readinessLine(), TOKEN), {
    host: '127.0.0.1',
    port: 49152,
    endpoint: 'ws://127.0.0.1:49152/',
  })
  assert.throws(() => parseReadiness(readinessLine({ host: '0.0.0.0' }), TOKEN), /loopback/)
  assert.throws(() => parseReadiness(readinessLine({ host: 'localhost' }), TOKEN), /loopback/)
  assert.throws(() => parseReadiness(readinessLine({ port: 0 }), TOKEN), /port/)
  assert.throws(() => parseReadiness(readinessLine({ port: 70000 }), TOKEN), /port/)
  assert.throws(() => parseReadiness(readinessLine({ port: 1.5 }), TOKEN), /port/)
  assert.throws(() => parseReadiness('{"host":"127.0.0.1","port":49152}\n', TOKEN), /fields/)
  assert.throws(() => parseReadiness(readinessLine({ extra: 1 }), TOKEN), /fields/)
  assert.throws(() => parseReadiness(readinessLine({ token: 'a'.repeat(32) }), TOKEN), /token/)
  assert.throws(() => parseReadiness(readinessLine({ token: 'b'.repeat(31) }), TOKEN), /token/)
  assert.throws(() => parseReadiness(readinessLine({ token: 49152 }), TOKEN), /token/)
  assert.throws(() => parseReadiness(`${' '.repeat(5000)}\n`, TOKEN), /too large/)
  assert.throws(() => parseReadiness('not json\n', TOKEN), /invalid/)
})

test('readiness listener resolves the first authenticated loopback payload', async () => {
  const listener = createReadinessListener({ token: TOKEN })
  const endpoint = await listener.endpoint

  assert.match(endpoint, /^127\.0\.0\.1:\d+$/)
  await dial(endpoint, readinessLine({ port: 51515 }))

  assert.deepEqual(await listener.readiness, {
    host: '127.0.0.1',
    port: 51515,
    endpoint: 'ws://127.0.0.1:51515/',
  })
  listener.close()
})

test('readiness listener assembles a line split across multiple data events', async () => {
  // A short timeout so a regression here fails fast instead of stalling on
  // the default 15s readiness timeout.
  const listener = createReadinessListener({ token: TOKEN, timeoutMs: 1000 })
  const endpoint = await listener.endpoint
  const [host, rawPort] = endpoint.split(':')

  const line = readinessLine({ port: 51525 })
  const mid = Math.floor(line.length / 2)
  const first = line.slice(0, mid)
  const second = line.slice(mid)

  const socket = net.connect({ host, port: Number(rawPort) })
  await once(socket, 'connect')
  socket.write(first)
  // A real delay (not just a microtask/setImmediate tick) so the kernel
  // actually flushes the first write as its own TCP segment instead of
  // coalescing it with the second write into a single 'data' event.
  await new Promise(resolve => setTimeout(resolve, 20))
  socket.end(second)

  assert.deepEqual(await listener.readiness, {
    host: '127.0.0.1',
    port: 51525,
    endpoint: 'ws://127.0.0.1:51525/',
  })
  listener.close()
})

test('readiness listener keeps waiting after a forged token', async () => {
  const listener = createReadinessListener({ token: TOKEN })
  const endpoint = await listener.endpoint

  const forged = await dialOpen(endpoint, readinessLine({ token: 'a'.repeat(32) }))
  assert.notEqual(forged.open, true, 'a forged token must be destroyed by the listener')
  assert.equal(await pending(listener.readiness), 'pending')

  await dial(endpoint, readinessLine({ port: 51516 }))
  assert.equal((await listener.readiness).port, 51516)
  listener.close()
})

test('readiness listener drops an oversized line and keeps waiting', async () => {
  const listener = createReadinessListener({ token: TOKEN })
  const endpoint = await listener.endpoint

  const flood = await dialOpen(endpoint, 'x'.repeat(8192))
  assert.notEqual(flood.open, true, 'an oversized line must be destroyed by the listener')
  assert.equal(await pending(listener.readiness), 'pending')

  await dial(endpoint, readinessLine({ port: 51517 }))
  assert.equal((await listener.readiness).port, 51517)
  listener.close()
})

test('readiness listener drops a malformed line and keeps waiting', async () => {
  const listener = createReadinessListener({ token: TOKEN })
  const endpoint = await listener.endpoint

  const malformed = await dialOpen(endpoint, '{"token":\n')
  assert.notEqual(malformed.open, true, 'a malformed line must be destroyed by the listener')
  assert.equal(await pending(listener.readiness), 'pending')

  await dial(endpoint, readinessLine({ port: 51518 }))
  assert.equal((await listener.readiness).port, 51518)
  listener.close()
})

test('readiness listener refuses later clients once a payload has landed', async () => {
  const listener = createReadinessListener({ token: TOKEN })
  const endpoint = await listener.endpoint

  await dial(endpoint, readinessLine({ port: 51519 }))
  await listener.readiness

  assert.equal((await dial(endpoint, readinessLine({ port: 51520 }))).code, 'ECONNREFUSED')
  listener.close()
})

test('readiness timeout rejects and invokes backend cleanup', async () => {
  let cleanups = 0
  const listener = createReadinessListener({
    token: TOKEN,
    timeoutMs: 5,
    onTimeout: () => { cleanups += 1 },
  })
  const endpoint = await listener.endpoint

  await assert.rejects(listener.readiness, /timed out/)
  assert.equal(cleanups, 1)
  assert.equal((await dial(endpoint, readinessLine())).code, 'ECONNREFUSED')
  listener.close()
})

test('closing the listener fails a handshake that can no longer arrive', async () => {
  const listener = createReadinessListener({ token: TOKEN })
  const endpoint = await listener.endpoint

  listener.close(new Error('desktop backend exited before readiness'))

  await assert.rejects(listener.readiness, /exited before readiness/)
  assert.equal((await dial(endpoint, readinessLine())).code, 'ECONNREFUSED')
})

test('closing the listener after success leaves the result untouched', async () => {
  const listener = createReadinessListener({ token: TOKEN })
  const endpoint = await listener.endpoint

  await dial(endpoint, readinessLine({ port: 51521 }))
  await listener.readiness
  listener.close()
  listener.close()

  assert.equal((await listener.readiness).port, 51521)
})

test('readiness listener rejects an invalid token or timeout up front', () => {
  assert.throws(() => createReadinessListener({ token: 'nope' }), /token/)
  assert.throws(() => createReadinessListener({ token: TOKEN, timeoutMs: 0 }), /timeout/)
  assert.throws(() => createReadinessListener({ token: TOKEN, timeoutMs: Number.NaN }), /timeout/)
  assert.throws(
    () => createReadinessListener({ token: TOKEN, socketAuthTimeoutMs: 0 }),
    /socket/,
  )
})

test('an unauthenticated socket is dropped on its own deadline, not the global timeout', async () => {
  // The two deadlines are deliberately far apart: only the per-socket one can
  // close a silent client here, and the listener must outlive it and keep waiting.
  const listener = createReadinessListener({
    token: TOKEN,
    timeoutMs: 5000,
    socketAuthTimeoutMs: 40,
  })
  const endpoint = await listener.endpoint

  const silent = await dialOpen(endpoint, '')
  assert.notEqual(silent.open, true, 'a silent client must be destroyed on its own deadline')
  assert.equal(await pending(listener.readiness), 'pending')

  await dial(endpoint, readinessLine({ port: 51522 }))
  assert.equal((await listener.readiness).port, 51522)
  listener.close()
})

test('the per-socket authentication deadline is three seconds by default', () => {
  assert.equal(READINESS_SOCKET_AUTH_TIMEOUT_MS, 3000)
})

test('a backend that never spawns fails the handshake instead of crashing the process', async () => {
  const child = fakeChild()
  const listener = createReadinessListener({ token: TOKEN, timeoutMs: 5000 })
  await listener.endpoint
  const notified = []

  watchBackendExit(child, {
    closeReadiness: listener.close,
    onExit: reason => notified.push(reason),
  })
  // A missing interpreter is reported as 'error' and never reaches 'exit', so an
  // exit-only hook would leave the handshake waiting out its whole timeout — and
  // an unlistened 'error' is thrown into the main process instead.
  child.emit('error', Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' }))

  await assert.rejects(listener.readiness, /ENOENT/)
  assert.deepEqual(notified.length, 1)
  assert.match(notified[0], /ENOENT/)
})

test('a backend that exits before readiness fails the handshake exactly once', async () => {
  const child = fakeChild()
  const listener = createReadinessListener({ token: TOKEN, timeoutMs: 5000 })
  await listener.endpoint
  const notified = []

  watchBackendExit(child, {
    closeReadiness: listener.close,
    onExit: reason => notified.push(reason),
  })
  child.emit('exit', 1, null)
  // Node may follow an 'exit' with an 'error'; the death is still one death.
  child.emit('error', new Error('too late'))

  await assert.rejects(listener.readiness, /exited before readiness/)
  assert.equal(notified.length, 1)
})

test('a backend that dies after the handshake notifies without disturbing the result', async () => {
  const child = fakeChild()
  const listener = createReadinessListener({ token: TOKEN, timeoutMs: 5000 })
  const endpoint = await listener.endpoint
  const notified = []

  watchBackendExit(child, {
    closeReadiness: listener.close,
    onExit: reason => notified.push(reason),
  })
  await dial(endpoint, readinessLine({ port: 51523 }))
  assert.equal((await listener.readiness).port, 51523)

  child.emit('exit', 0, null)

  assert.equal(notified.length, 1)
  assert.equal((await listener.readiness).port, 51523)
})

test('the default drain grace outlasts the backend cleanup it is waiting on', async () => {
  // The Python side spends up to EXIT_GRACE (5s) plus INTERRUPT_GRACE (2s) tearing
  // its executor down after stdin EOF; a shorter outer grace would SIGKILL it
  // mid-cleanup and orphan the codex tree it was still reaping.
  assert.equal(BACKEND_DRAIN_GRACE_MS, 8000)

  const child = fakeChild()
  const armed = []
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (callback, ms) => {
    armed.push(ms)
    return realSetTimeout(callback, ms)
  }
  let drained
  try {
    drained = shutdownBackend(child, { platform: 'darwin' })
  } finally {
    globalThis.setTimeout = realSetTimeout
  }

  assert.deepEqual(armed, [BACKEND_DRAIN_GRACE_MS])
  // The longer grace is a ceiling, not a wait: an ordinary quit still resolves
  // the moment the child is actually gone.
  child.exitCode = 0
  child.emit('exit', 0, null)
  assert.equal(await pending(drained, 50), 'settled')
  assert.deepEqual(child.calls, ['stdin.end', 'kill:SIGTERM'])
})

test('shutdown ends stdin first, then signals, and escalates only after the grace', async () => {
  const child = fakeChild()

  const drained = shutdownBackend(child, {graceMs: 20, forceExitMs: 100, platform: 'darwin'})

  assert.deepEqual(child.calls, ['stdin.end', 'kill:SIGTERM'])
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(child.calls, ['stdin.end', 'kill:SIGTERM', 'kill:SIGKILL'])
  child.exitCode = 137
  child.emit('exit', 137, 'SIGKILL')
  await drained
})

test('forced shutdown waits for observed child exit before confirming termination', async () => {
  const child = fakeChild()

  const drained = shutdownBackend(child, {
    graceMs: 5,
    forceExitMs: 100,
    platform: 'darwin',
  })

  await new Promise(resolve => setTimeout(resolve, 15))
  assert.deepEqual(child.calls, ['stdin.end', 'kill:SIGTERM', 'kill:SIGKILL'])
  assert.equal(await pending(drained, 10), 'pending')

  child.exitCode = 137
  child.emit('exit', 137, 'SIGKILL')
  assert.equal(await pending(drained, 50), 'settled')
})

test('forced shutdown rejects when child exit cannot be confirmed', async () => {
  const child = fakeChild()

  await assert.rejects(
    shutdownBackend(child, {graceMs: 5, forceExitMs: 5, platform: 'darwin'}),
    /termination unconfirmed/u,
  )
  assert.deepEqual(child.calls, ['stdin.end', 'kill:SIGTERM', 'kill:SIGKILL'])
})

test('a late exit after termination timeout allows a later shutdown to confirm', async () => {
  const child = fakeChild()

  await assert.rejects(
    shutdownBackend(child, {graceMs: 5, forceExitMs: 5, platform: 'darwin'}),
    /termination unconfirmed/u,
  )
  child.exitCode = 137
  child.emit('exit', 137, 'SIGKILL')

  await shutdownBackend(child, {graceMs: 5, forceExitMs: 5, platform: 'darwin'})
  assert.deepEqual(child.calls, ['stdin.end', 'kill:SIGTERM', 'kill:SIGKILL'])
})

test('quit-only best-effort shutdown contains an unconfirmed termination failure', async () => {
  const backend = await import('../src/main/backend.mjs')
  assert.equal(typeof backend.shutdownBackendBestEffort, 'function')
  const child = fakeChild()

  await backend.shutdownBackendBestEffort(child, {
    graceMs: 5,
    forceExitMs: 5,
    platform: 'darwin',
  })

  assert.deepEqual(child.calls, ['stdin.end', 'kill:SIGTERM', 'kill:SIGKILL'])
})

test('shutdown on win32 relies on the stdin sentinel instead of a signal', async () => {
  const child = fakeChild()

  const drained = shutdownBackend(child, {graceMs: 20, forceExitMs: 100, platform: 'win32'})

  assert.deepEqual(child.calls, ['stdin.end'])
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(child.calls, ['stdin.end', 'kill:SIGKILL'])
  child.exitCode = 137
  child.emit('exit', 137, 'SIGKILL')
  await drained
})

test('utility-process shutdown requests a drain over its parent port before killing', async () => {
  const child = fakeChild()
  child.pid = 42
  delete child.stdin
  child.postMessage = message => child.calls.push(`post:${message.type}`)
  child.kill = () => {
    child.calls.push('kill')
    return true
  }

  const drained = shutdownBackend(child, { graceMs: 30_000, platform: 'darwin' })
  assert.deepEqual(child.calls, ['post:nova.shutdown'])

  child.pid = undefined
  child.exitCode = 0
  child.emit('exit', 0)
  await drained
  assert.deepEqual(child.calls, ['post:nova.shutdown'])
})

test('a utility process still spawning is stopped instead of mistaken for an exited child', async () => {
  const child = fakeChild()
  child.pid = undefined
  delete child.stdin
  child.postMessage = message => child.calls.push(`post:${message.type}`)
  child.kill = () => {
    child.calls.push('kill')
    return true
  }

  const drained = shutdownBackend(child, {graceMs: 20, forceExitMs: 100, platform: 'darwin'})
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(child.calls, ['post:nova.shutdown', 'kill'])
  child.exitCode = 137
  child.emit('exit', 137)
  await drained
})

test('a backend that drains inside the grace window is never force killed', async () => {
  const child = fakeChild()

  const drained = shutdownBackend(child, { graceMs: 30_000, platform: 'darwin' })
  child.exitCode = 0
  child.emit('exit', 0, null)

  assert.equal(await pending(drained, 50), 'settled')
  assert.deepEqual(child.calls, ['stdin.end', 'kill:SIGTERM'])
})

test('concurrent and repeated shutdowns share one drain sequence', async () => {
  const child = fakeChild()

  const first = shutdownBackend(child, {graceMs: 20, forceExitMs: 100, platform: 'darwin'})
  const second = shutdownBackend(child, {graceMs: 20, forceExitMs: 100, platform: 'darwin'})

  assert.equal(first, second)
  assert.deepEqual(child.calls, ['stdin.end', 'kill:SIGTERM'])
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(child.calls, ['stdin.end', 'kill:SIGTERM', 'kill:SIGKILL'])
  child.exitCode = 137
  child.emit('exit', 137, 'SIGKILL')
  await Promise.all([first, second])

  const third = shutdownBackend(child, { graceMs: 20, platform: 'darwin' })
  assert.equal(await pending(third, 50), 'settled')
  assert.deepEqual(child.calls, ['stdin.end', 'kill:SIGTERM', 'kill:SIGKILL'])
})

test('an exit that fires synchronously from stdin.end never arms a stray SIGKILL', async () => {
  const child = fakeChild()
  const calls = child.calls
  let emitExit
  // Overrides the base double's stdin: end() here synchronously drives the
  // 'exit' listener the way a test double (not a real ChildProcess) can, so
  // finish() runs before `timer = setTimeout(...)` has been assigned.
  child.stdin = {
    writable: true,
    destroyed: false,
    end: () => {
      calls.push('stdin.end')
      emitExit()
    },
  }
  const originalOnce = child.once.bind(child)
  child.once = (event, listener) => {
    if (event === 'exit') emitExit = () => listener(0, null)
    return originalOnce(event, listener)
  }

  const drained = shutdownBackend(child, { graceMs: 30, platform: 'darwin' })
  child.exitCode = 0

  await drained
  await new Promise(resolve => setTimeout(resolve, 60))

  assert.deepEqual(calls, ['stdin.end', 'kill:SIGTERM'])
  assert.equal(calls.includes('kill:SIGKILL'), false)
})

test('a destroyed stdin is never ended, but the kill path still runs', async () => {
  const child = fakeChild()
  child.stdin = {
    writable: false,
    destroyed: true,
    end: () => { throw new Error('must not be called') },
  }

  const drained = shutdownBackend(child, {graceMs: 20, forceExitMs: 100, platform: 'darwin'})

  assert.deepEqual(child.calls, ['kill:SIGTERM'])
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(child.calls, ['kill:SIGTERM', 'kill:SIGKILL'])
  child.exitCode = 137
  child.emit('exit', 137, 'SIGKILL')
  await drained
})

test('shutting down an already exited backend never waits out the grace', async () => {
  const exited = fakeChild()
  exited.exitCode = 0
  const signalled = fakeChild()
  signalled.signalCode = 'SIGTERM'

  for (const child of [exited, signalled]) {
    const drained = shutdownBackend(child, { graceMs: 30_000, platform: 'darwin' })
    assert.equal(await pending(drained, 50), 'settled')
    assert.deepEqual(child.calls, [])
  }
})

test('a spawned backend reaches readiness through the launch spec environment', async () => {
  const listener = createReadinessListener({ token: TOKEN })
  const endpoint = await listener.endpoint
  const spec = nodeLaunchSpec({
    workspace: process.cwd(),
    token: TOKEN,
    readyEndpoint: endpoint,
    parentEnv: process.env,
  })
  const script = `
    const net = require('node:net')
    const [host, port] = process.env.NOVA_AUDIO_AGENT_DESKTOP_READY_ENDPOINT.split(':')
    if (process.env.NOVA_AUDIO_AGENT_DESKTOP_READY_FD) throw new Error('fd 3 must be gone')
    const payload = JSON.stringify({
      token: process.env.NOVA_AUDIO_AGENT_DESKTOP_TOKEN,
      host: '127.0.0.1',
      port: 52525,
    })
    const socket = net.connect({ host, port: Number(port) }, () => socket.end(payload + '\\n'))
    socket.on('close', () => process.exit(0))
    socket.on('error', () => process.exit(1))
  `
  const child = spawn(process.execPath, ['-e', script], { env: spec.env, stdio: spec.stdio })

  try {
    assert.deepEqual(await listener.readiness, {
      host: '127.0.0.1',
      port: 52525,
      endpoint: 'ws://127.0.0.1:52525/',
    })
    const [code] = await once(child, 'exit')
    assert.equal(code, 0)
  } finally {
    listener.close()
    if (child.exitCode === null) child.kill('SIGKILL')
  }
})
