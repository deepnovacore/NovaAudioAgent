import assert from 'node:assert/strict'
import {test} from 'node:test'

import {canonicalJson} from '../src/canonical-json.js'
import {buildCascadedRealtimeAssembly} from '../src/cascaded-realtime-assembly.js'
import {ConfigurationError, loadSettings} from '../src/config.js'
import {buildDiagnosticReport, diagnosticReportSchema} from '../src/diagnostics.js'
import {main} from '../src/cli.js'

test('diagnostics require the credential for the unconditionally assembled Search adapter', async () => {
  const environment = {
    NOVA_AUDIO_AGENT_BACKEND: 'node',
    DASHSCOPE_API_KEY: 'dashscope-secret',
    NOVA_AUDIO_AGENT_MODEL_API_KEY: 'sentinel-model-secret',
  }
  const report = await buildDiagnosticReport({environment, nodeVersion: 'v22.12.0'})
  assert.equal(diagnosticReportSchema.safeParse(report).success, true)
  assert.deepEqual(report, {
    schema_version: 1,
    runtime: 'node',
    ok: false,
    checks: [
      {id: 'node.version', status: 'pass', code: 'node_version_supported'},
      {id: 'configuration.retirement', status: 'pass', code: 'active_configuration'},
      {id: 'configuration.parse', status: 'pass', code: 'configuration_valid'},
      {id: 'provider.qwen', status: 'pass', code: 'qwen_configuration_valid'},
      {id: 'executors.contract', status: 'pass', code: 'executor_configuration_valid'},
      {id: 'search.credential', status: 'fail', code: 'search_credential_missing'},
      {id: 'camera.source', status: 'pass', code: 'camera_local_selected'},
    ],
  })
  assert.equal(canonicalJson(report).includes('sentinel'), false)
})

test('diagnostics pass the required Search check without probing Tavily', async () => {
  const report = await buildDiagnosticReport({
    environment: {
      DASHSCOPE_API_KEY: 'dashscope-secret',
      NOVA_AUDIO_AGENT_MODEL_API_KEY: 'model-secret',
      TAVILY_API_KEY: 'search-secret',
    },
    nodeVersion: 'v22.12.0',
  })
  assert.equal(report.ok, true)
  assert.deepEqual(report.checks[5], {
    id: 'search.credential', status: 'pass', code: 'search_credential_present',
  })
  assert.equal(canonicalJson(report).includes('secret'), false)
})

test('diagnostics fail only selected required provider configuration', async () => {
  const qwen = await buildDiagnosticReport({environment: {}, nodeVersion: '22.12.0'})
  assert.equal(qwen.ok, false)
  assert.deepEqual(qwen.checks[3], {
    id: 'provider.qwen', status: 'fail', code: 'qwen_configuration_invalid',
  })

  const retired = await buildDiagnosticReport({
    environment: {NOVA_AUDIO_AGENT_REALTIME_PROVIDER: 'secret-old-value'},
    nodeVersion: 'v22.12.0',
  })
  assert.equal(retired.ok, false)
  assert.deepEqual(retired.checks.slice(1), [
    {id: 'configuration.retirement', status: 'fail', code: 'retired_configuration'},
    {id: 'configuration.parse', status: 'fail', code: 'configuration_invalid'},
  ])
  assert.equal(canonicalJson(retired).includes('secret-old-value'), false)
})

test('diagnostics retain the integrated Qwen check for the default product shape', async () => {
  const integrated = await buildDiagnosticReport({
    environment: {DASHSCOPE_API_KEY: 'dashscope-secret'},
    nodeVersion: 'v22.12.0',
  })
  assert.deepEqual(integrated.checks[3], {
    id: 'provider.qwen', status: 'pass', code: 'qwen_configuration_valid',
  })
})

test('cascaded diagnostics reject every representative configuration production rejects', async () => {
  const cases = [
    {
      name: 'secure ASR endpoint',
      override: {NOVA_AUDIO_AGENT_DOUBAO_ASR_ENDPOINT: 'https://sentinel.invalid/asr'},
    },
    {
      name: 'VAD lower bound',
      override: {NOVA_AUDIO_AGENT_VOLCENGINE_VAD_THRESHOLD: '0'},
    },
    {
      name: 'ASR chunk lower bound',
      override: {NOVA_AUDIO_AGENT_DOUBAO_ASR_CHUNK_MS: '0'},
    },
    {
      name: 'TTS sample rate',
      override: {NOVA_AUDIO_AGENT_DOUBAO_TTS_OUTPUT_SAMPLE_RATE: '16000'},
    },
  ] as const
  for (const case_ of cases) {
    const environment = {
      NOVA_AUDIO_AGENT_PIPELINE_MODE: 'cascaded',
      DASHSCOPE_API_KEY: 'sentinel-selected-secret',
      DOUBAO_BIGMODEL_API_KEY: 'sentinel-doubao-secret',
      TAVILY_API_KEY: 'sentinel-search-secret',
      ...case_.override,
    }
    const diagnostic = await buildDiagnosticReport({environment, nodeVersion: 'v22.12.0'})
    assert.deepEqual(diagnostic.checks[3], {
      id: 'provider.volcengine',
      status: 'fail',
      code: 'volcengine_configuration_invalid',
    }, case_.name)
    assert.equal(canonicalJson(diagnostic).includes('sentinel'), false, case_.name)
    assert.throws(
      () => buildCascadedRealtimeAssembly({settings: loadSettings(environment)}),
      error => error instanceof ConfigurationError,
      case_.name,
    )
  }
})

test('cascaded diagnostics never read the unselected LLM platform', async () => {
  for (const provider of ['qwen', 'ark'] as const) {
    const inaccessible = provider === 'qwen'
      ? new Set<PropertyKey>(['ARK_API_KEY', 'NOVA_AUDIO_AGENT_VOLCENGINE_ARK_BASE_URL'])
      : new Set<PropertyKey>(['DASHSCOPE_API_KEY'])
    const environment = new Proxy<NodeJS.ProcessEnv>({
      NOVA_AUDIO_AGENT_PIPELINE_MODE: 'cascaded',
      NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER: provider,
      ...(provider === 'qwen'
        ? {DASHSCOPE_API_KEY: 'selected-qwen-secret'}
        : {ARK_API_KEY: 'selected-ark-secret'}),
      DOUBAO_BIGMODEL_API_KEY: 'doubao-secret',
      TAVILY_API_KEY: 'search-secret',
    }, {
      get(target, property, receiver) {
        if (inaccessible.has(property)) throw new Error(`unselected read: ${String(property)}`)
        return Reflect.get(target, property, receiver) as unknown
      },
    })
    const report = await buildDiagnosticReport({environment, nodeVersion: 'v22.12.0'})
    assert.deepEqual(report.checks[3], {
      id: 'provider.volcengine',
      status: 'pass',
      code: 'volcengine_configuration_valid',
    })
  }
})

test('diagnostics classify retirement and unexpected access without retaining private data', async () => {
  const retired = await buildDiagnosticReport({
    environment: {
      NOVA_AUDIO_AGENT_EXECUTOR: 'HA',
      NOVA_AUDIO_AGENT_HA_TOKEN: 'sentinel-retired-secret',
    },
    nodeVersion: 'v22.12.0',
  })
  assert.equal(retired.ok, false)
  assert.deepEqual(retired.checks.slice(1, 3), [
    {id: 'configuration.retirement', status: 'fail', code: 'retired_capability'},
    {id: 'configuration.parse', status: 'fail', code: 'configuration_invalid'},
  ])
  assert.equal(canonicalJson(retired).includes('sentinel'), false)

  const throwing = new Proxy<NodeJS.ProcessEnv>({}, {
    get() { throw new Error('sentinel-private-path-and-secret') },
  })
  const internal = await buildDiagnosticReport({environment: throwing, nodeVersion: 'v22.12.0'})
  assert.equal(internal.ok, false)
  assert.deepEqual(internal.checks, [
    {id: 'node.version', status: 'pass', code: 'node_version_supported'},
    {id: 'configuration.retirement', status: 'fail', code: 'diagnostic_internal_failure'},
  ])
  assert.equal(canonicalJson(internal).includes('sentinel'), false)
})

test('diagnostics reject unsupported Node and classify camera paths without touching them', async () => {
  const unsupported = await buildDiagnosticReport({
    environment: {DASHSCOPE_API_KEY: 'dashscope-key', NOVA_AUDIO_AGENT_MODEL_API_KEY: 'key'},
    nodeVersion: 'v21.99.0',
  })
  assert.equal(unsupported.checks[0]?.status, 'fail')
  assert.equal(unsupported.ok, false)

  const file = await buildDiagnosticReport({
    environment: {
      DASHSCOPE_API_KEY: 'dashscope-key',
      NOVA_AUDIO_AGENT_MODEL_API_KEY: 'key',
      NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE: '/sentinel/private/video.mp4',
    },
    nodeVersion: 'v22.12.0',
  })
  assert.deepEqual(file.checks.at(-1), {
    id: 'camera.source', status: 'pass', code: 'camera_file_selected',
  })
  assert.equal(canonicalJson(file).includes('/sentinel'), false)

  const invalid = await buildDiagnosticReport({
    environment: {
      DASHSCOPE_API_KEY: 'dashscope-key',
      NOVA_AUDIO_AGENT_MODEL_API_KEY: 'key',
      NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE: 'sentinel-relative.mp4',
    },
    nodeVersion: 'v22.12.0',
  })
  assert.deepEqual(invalid.checks.at(-1), {
    id: 'camera.source', status: 'fail', code: 'camera_source_invalid',
  })
  assert.equal(canonicalJson(invalid).includes('sentinel'), false)
})

test('diagnose CLI emits one canonical line with exact exit behavior', async () => {
  let output = ''
  const environment = {
    NOVA_AUDIO_AGENT_BACKEND: 'node',
    DASHSCOPE_API_KEY: 'dashscope-secret',
    NOVA_AUDIO_AGENT_MODEL_API_KEY: 'sentinel-secret',
    TAVILY_API_KEY: 'sentinel-search-secret',
  }
  const expected = await buildDiagnosticReport({environment, nodeVersion: 'v22.12.0'})
  assert.equal(await main(['diagnose', '--json'], {
    environment,
    nodeVersion: 'v22.12.0',
    io: {write: text => { output += text }},
  }), 0)
  assert.equal(output, `${canonicalJson(expected)}\n`)
  assert.equal(output.includes('sentinel'), false)

  output = ''
  assert.equal(await main(['diagnose'], {io: {write: text => { output += text }}}), 2)
  assert.match(output, /^Usage:/u)
})
