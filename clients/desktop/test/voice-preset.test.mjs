import assert from 'node:assert/strict'
import test from 'node:test'
import {SELF_HOSTED_STAGES, parseVoicePreset, exportVoicePreset, validSelfHostedUrl, MAX_PRESET_BYTES} from '../src/renderer/voice-preset.mjs'
import {DEFAULT_SETTINGS, applySettingsUpdate, normalizeSettings, publicSettings, readSecret} from '../src/main/settings-store.mjs'
import {resolveSecretConfiguration, capabilityEnvironment, backendLaunchSpec} from '../src/main/backend.mjs'
const preset = {schema: 'nova.voice-preset', version: 1, name: 'Local', asr: {provider: 'self-hosted', url: 'ws://127.0.0.1:8001/asr'}, llm: {provider: 'self-hosted', baseUrl: 'http://[::1]:8002/v1', model: 'local-model'}, tts: {provider: 'self-hosted', url: 'https://speech.example/tts'}}
const codec = {available: () => false}

test('preset round-trips only explicit self-hosted stages and never exports credentials', () => {
  const {patch} = parseVoicePreset(JSON.stringify(preset))
  const settings = applySettingsUpdate(DEFAULT_SETTINGS, patch, codec)
  settings.secrets.selfHostedLlmApiKey = {enc: 'none', data: Buffer.from('private-token').toString('base64')}
  settings.selfHostedLlmApiKey = 'private-token'
  assert.deepEqual(JSON.parse(exportVoicePreset(settings, 'Local')), preset)
  assert.doesNotMatch(exportVoicePreset(settings), /private-token|ApiKey|secrets|enc/)
  assert.equal(publicSettings(settings).selfHostedLlmBaseUrl, preset.llm.baseUrl)
  assert.equal(readSecret(normalizeSettings(settings), 'selfHostedLlmApiKey', codec), 'private-token')
  const partial = parseVoicePreset(JSON.stringify({...preset, asr: undefined, tts: undefined})).patch
  assert.deepEqual(Object.keys(partial).sort(), ['pipelineMode', 'cascadedLlmProvider', 'selfHostedLlmBaseUrl', 'cascadedLlmModels'].sort())
  assert.equal(applySettingsUpdate(DEFAULT_SETTINGS, partial, codec).cascadedAsrProvider, DEFAULT_SETTINGS.cascadedAsrProvider)
  assert.throws(() => exportVoicePreset(DEFAULT_SETTINGS), /invalid_voice_preset/)
})

test('preset validation is strict, bounded and atomic across every stage', () => {
  for (const invalid of [
    {...preset, version: 2}, {...preset, schema: 'other'}, {...preset, name: ''}, {...preset, secrets: {}},
    {...preset, llm: {...preset.llm, apiKey: 'token'}}, {...preset, llm: {...preset.llm, model: ''}},
    {...preset, tts: {provider: 'volcengine', url: 'https://speech.example'}},
    {...preset, asr: {...preset.asr, url: 'ws://example.com/asr'}}, {...preset, asr: null},
    {schema: 'nova.voice-preset', version: 1, name: 'Empty'},
  ]) assert.throws(() => parseVoicePreset(JSON.stringify(invalid)), /invalid_voice_preset/)
  assert.throws(() => parseVoicePreset(' '.repeat(MAX_PRESET_BYTES + 1)), /invalid_voice_preset/)
  assert.throws(() => parseVoicePreset('{'), /invalid_voice_preset/)
  for (const url of ['http://localhost/v1', 'http://127.1/v1', 'http://2130706433/v1', 'http://0177.0.0.1/v1', 'https://user:pass@host/v1', 'https://@host/v1', 'https://host/v1?key=token', 'https://host/#', 'https://host/\n', 'https://host/\\evil']) assert.equal(validSelfHostedUrl(url, 'llm'), null, url)
  assert.equal(validSelfHostedUrl('http://127.0.0.1:9000/v1', 'llm'), 'http://127.0.0.1:9000/v1')
  assert.equal(validSelfHostedUrl('ws://[::1]:9000/asr', 'asr'), 'ws://[::1]:9000/asr')
  assert.equal(validSelfHostedUrl('https://host/tts', 'tts'), 'https://host/tts')
})

test('origin changes clear each stage token and prevent environment fallback, same origin preserves it', () => {
  let settings = applySettingsUpdate(DEFAULT_SETTINGS, parseVoicePreset(JSON.stringify(preset)).patch, codec)
  const keys = Object.fromEntries(SELF_HOSTED_STAGES.map(({secret}) => [secret, `test-${secret}`]))
  settings = applySettingsUpdate(settings, {secrets: keys}, codec)
  for (const {stage, endpoint, secret} of SELF_HOSTED_STAGES) {
    const same = applySettingsUpdate(settings, {[endpoint]: settings[endpoint] + '/new'}, codec)
    assert.equal(readSecret(same, secret, codec), keys[secret])
    const next = applySettingsUpdate(settings, {[endpoint]: `${stage === 'asr' ? 'wss' : 'https'}://new.example/service`}, codec)
    assert.equal(readSecret(next, secret, codec), '')
    const explicit = applySettingsUpdate(settings, {[endpoint]: `${stage === 'asr' ? 'wss' : 'https'}://new.example/service`, secrets: {[secret]: 'new-origin-key'}}, codec)
    assert.equal(readSecret(explicit, secret, codec), 'new-origin-key')
    const invalid = applySettingsUpdate(settings, {[endpoint]: `${stage === 'asr' ? 'wss' : 'https'}://new.example/service`, secrets: {[secret]: 'invalid\nkey'}}, codec)
    assert.equal(readSecret(invalid, secret, codec), '')
    assert.ok(invalid.rejectedSecrets.includes(secret))
    const envName = `SELF_HOSTED_${stage.toUpperCase()}_API_KEY`
    const resolved = resolveSecretConfiguration({[secret]: ''}, {[envName]: 'old-alias', [`NOVA_${envName}`]: 'old-canonical'}, {[envName]: 'old-dotenv'})
    const env = capabilityEnvironment(next, resolved.secrets, {[envName]: 'old-alias', [`NOVA_${envName}`]: 'old-canonical'})
    assert.equal(resolveSecretConfiguration({[secret]: 'new-key'}, {}, {[envName]: 'old-dotenv'}).secrets[secret], 'new-key')
    assert.equal(resolved.secretsPresent[secret], false)
    assert.equal(env[envName], '')
    assert.equal(env[`NOVA_${envName}`], '')
    assert.throws(() => applySettingsUpdate(settings, {[endpoint]: 'http://public.example'}, codec), /invalid_self_hosted_url/)
    assert.equal(readSecret(settings, secret, codec), keys[secret])
  }
})

test('launch uses dedicated endpoints, models and optional stage keys with canonical precedence', () => {
  const settings = applySettingsUpdate(DEFAULT_SETTINGS, parseVoicePreset(JSON.stringify(preset)).patch, codec)
  const env = backendLaunchSpec({nodeEntry: '/repo/runtime/dist/src/desktop-entry.js', nodeResourcesPath: '/repo/clients/desktop/build', workspace: '/workspace', token: 'a'.repeat(32), readyEndpoint: '127.0.0.1:49152', parentEnv: {NOVA_SELF_HOSTED_LLM_BASE_URL: 'https://old.example', NOVA_SELF_HOSTED_LLM_API_KEY: 'old-token'}, settings, decryptedSecrets: {selfHostedLlmApiKey: 'new-token', selfHostedAsrApiKey: '', selfHostedTtsApiKey: '', deepseekApiKey: 'cloud-token', doubaoBigmodelApiKey: 'cloud-token'}}).env
  assert.equal(env.CASCADE_LLM_MODEL, 'local-model')
  assert.equal(env.SELF_HOSTED_LLM_BASE_URL, preset.llm.baseUrl)
  assert.equal(env.NOVA_SELF_HOSTED_LLM_BASE_URL, preset.llm.baseUrl)
  assert.equal(env.NOVA_SELF_HOSTED_LLM_API_KEY, 'new-token')
  assert.equal(env.SELF_HOSTED_ASR_API_KEY, '')
  assert.equal(env.DOUBAO_BIGMODEL_API_KEY, undefined)
  assert.equal(env.DEEPSEEK_API_KEY, undefined)
})
