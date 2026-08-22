import assert from 'node:assert/strict'
import {test} from 'node:test'

import {canonicalJson} from '../src/canonical-json.js'
import {buildDiagnosticReport, diagnosticReportSchema} from '../src/diagnostics.js'
import {main} from '../src/cli.js'

test('diagnostics require the credential for the unconditionally assembled Search adapter', async () => {
  const environment = {
    NOVA_AUDIO_AGENT_BACKEND: 'node',
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
    environment: {NOVA_AUDIO_AGENT_MODEL_API_KEY: 'key'},
    nodeVersion: 'v21.99.0',
  })
  assert.equal(unsupported.checks[0]?.status, 'fail')
  assert.equal(unsupported.ok, false)

  const file = await buildDiagnosticReport({
    environment: {
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
