import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {isAbsolute, resolve} from 'node:path'
import {test} from 'node:test'

import {
  loadSettings,
  requireQwenRealtime,
  requireVolcengineRealtime,
  resolveProactivity,
  type Settings,
} from '../src/config.js'
import {canonicalJson} from '../src/canonical-json.js'
import {stripLikePython} from '../src/python-text.js'

interface ConfigCase {
  readonly id: string
  readonly action: 'load' | 'provider' | 'desktop_video'
  readonly environment: NodeJS.ProcessEnv
}

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const fixtureRoot = resolve(repositoryRoot, 'fixtures/config/v1')

test('Node consumes every Python-owned configuration fixture exactly', async () => {
  const casesDocument = JSON.parse(await readFile(resolve(fixtureRoot, 'cases.json'), 'utf8')) as {
    readonly schema_version: number
    readonly cases: readonly ConfigCase[]
  }
  const expectedDocument = JSON.parse(await readFile(resolve(fixtureRoot, 'expected.json'), 'utf8')) as {
    readonly schema_version: number
    readonly results: Readonly<Record<string, unknown>>
  }
  assert.equal(casesDocument.schema_version, 1)
  assert.equal(expectedDocument.schema_version, 1)

  for (const fixture of casesDocument.cases) {
    const actual = evaluateConfigFixture(fixture)
    assert.equal(
      canonicalJson(actual),
      canonicalJson(expectedDocument.results[fixture.id]),
      fixture.id,
    )
  }
})

function evaluateConfigFixture(fixture: ConfigCase): unknown {
  if (fixture.action === 'desktop_video') {
    const value = stripLikePython(fixture.environment.NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE ?? '')
    return {ok: value === '' || isAbsolute(value), source: value === '' ? 'local' : 'file'}
  }
  try {
    const settings = loadSettings(fixture.environment)
    const result: Record<string, unknown> = {ok: true, settings: projectSettings(settings)}
    if (fixture.action === 'provider') result.provider = projectProvider(settings)
    return result
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('invalid configuration: ')) {
      return {
        ok: false,
        fields: error.message.slice('invalid configuration: '.length).split(', ')
          .map(field => field.startsWith('NOVA_AUDIO_AGENT_')
            ? field.slice('NOVA_AUDIO_AGENT_'.length)
            : field),
      }
    }
    return {ok: false, fields: []}
  }
}

function projectSettings(settings: Settings): Readonly<Record<string, unknown>> {
  return {
    ark_api_key_present: secretPresent(settings.ark_api_key),
    codex_api_key_present: secretPresent(settings.codex_api_key),
    codex_bin: settings.codex_bin,
    codex_managed_root: settings.codex_managed_root,
    codex_prewarm: settings.codex_prewarm,
    codex_project_state_root: settings.codex_project_state_root,
    codex_projects_enabled: settings.codex_projects_enabled,
    codex_working_interval: settings.codex_working_interval,
    codex_workspace: settings.codex_workspace,
    compressor_model: settings.compressor_model,
    dashscope_api_key_present: secretPresent(settings.dashscope_api_key),
    doubao_asr_api_key_present: secretPresent(settings.doubao_asr_api_key),
    doubao_asr_chunk_ms: settings.doubao_asr_chunk_ms,
    doubao_asr_endpoint: settings.doubao_asr_endpoint,
    doubao_asr_resource_id: settings.doubao_asr_resource_id,
    doubao_bigmodel_api_key_present: secretPresent(settings.doubao_bigmodel_api_key),
    doubao_tts_endpoint: settings.doubao_tts_endpoint,
    doubao_tts_output_sample_rate: settings.doubao_tts_output_sample_rate,
    doubao_tts_resource_id: settings.doubao_tts_resource_id,
    doubao_tts_voice: settings.doubao_tts_voice,
    executor: settings.executor,
    executors: settings.executors,
    fast_model: settings.fast_model,
    fresh_window: settings.fresh_window,
    model_api_key_present: secretPresent(settings.model_api_key),
    model_base_url: settings.model_base_url,
    proactivity: resolveProactivity(settings),
    proactivity_preset: settings.proactivity_preset,
    qwen_controlled_guard_reconnect: settings.qwen_controlled_guard_reconnect,
    qwen_guard_history_pairs: settings.qwen_guard_history_pairs,
    qwen_guard_history_recovery: settings.qwen_guard_history_recovery,
    qwen_realtime_model: settings.qwen_realtime_model,
    qwen_realtime_url: settings.qwen_realtime_url,
    qwen_realtime_voice: settings.qwen_realtime_voice,
    realtime_provider: settings.realtime_provider,
    suggestion_cooldown: settings.suggestion_cooldown,
    surrogate_model: settings.surrogate_model,
    tavily_api_key_present: secretPresent(settings.tavily_api_key),
    volcengine_ark_base_url: settings.volcengine_ark_base_url,
    volcengine_ark_model: settings.volcengine_ark_model,
    volcengine_ark_support_model: settings.volcengine_ark_support_model,
    volcengine_vad_max_utterance_ms: settings.volcengine_vad_max_utterance_ms,
    volcengine_vad_min_speech_ms: settings.volcengine_vad_min_speech_ms,
    volcengine_vad_pre_roll_ms: settings.volcengine_vad_pre_roll_ms,
    volcengine_vad_silence_end_ms: settings.volcengine_vad_silence_end_ms,
    volcengine_vad_speech_pad_ms: settings.volcengine_vad_speech_pad_ms,
    volcengine_vad_threshold: settings.volcengine_vad_threshold,
    watch_model: settings.watch_model,
  }
}

function projectProvider(settings: Settings): Readonly<Record<string, unknown>> {
  if (settings.realtime_provider === 'qwen') {
    const resolved = requireQwenRealtime(settings)
    return {
      provider: 'qwen',
      url: resolved.url,
      model: resolved.model,
      voice: resolved.voice,
      key_present: resolved.apiKey !== '',
    }
  }
  const resolved = requireVolcengineRealtime(settings)
  return {
    provider: 'volcengine',
    ark_base_url: resolved.arkBaseUrl,
    ark_model: resolved.arkModel,
    ark_support_model: resolved.arkSupportModel,
    ark_api_key_present: resolved.arkApiKey !== '',
    asr_endpoint: resolved.asrEndpoint,
    asr_resource_id: resolved.asrResourceId,
    asr_api_key_present: resolved.asrApiKey !== '',
    asr_chunk_ms: resolved.asrChunkMs,
    tts_endpoint: resolved.ttsEndpoint,
    tts_resource_id: resolved.ttsResourceId,
    tts_voice: resolved.ttsVoice,
    tts_api_key_present: resolved.ttsApiKey !== '',
    tts_output_sample_rate: resolved.ttsOutputSampleRate,
    vad_threshold: resolved.vadThreshold,
    vad_pre_roll_ms: resolved.vadPreRollMs,
    vad_min_speech_ms: resolved.vadMinSpeechMs,
    vad_silence_end_ms: resolved.vadSilenceEndMs,
    vad_speech_pad_ms: resolved.vadSpeechPadMs,
    vad_max_utterance_ms: resolved.vadMaxUtteranceMs,
  }
}

function secretPresent(value: string | null): boolean {
  return value !== null && stripLikePython(value) !== ''
}
