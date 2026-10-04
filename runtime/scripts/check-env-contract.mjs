import {readFile, writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {publicEnvironmentContract} from '../dist/src/config/environment-contract.js'

// Common user settings only; .env.example retains the complete public contract.
const coreNames = new Set([
  'OPENAI_API_KEY', 'GEMINI_API_KEY', 'DASHSCOPE_API_KEY', 'STEPFUN_API_KEY', 'TAVILY_API_KEY', 'DEEPSEEK_API_KEY', 'ARK_API_KEY',
  'DOUBAO_BIGMODEL_API_KEY', 'DOUBAO_ASR_API_KEY',
  'PROMPT_LANGUAGE',
  'PIPELINE_MODE', 'INTEGRATED_PROVIDER',
  'CASCADE_LLM_PROVIDER',
  'CASCADE_LLM_MODEL', 'QWEN_REALTIME_MODEL',
  'QWEN_REALTIME_VOICE', 'CODEX_BIN',
  'CODEX_WORKSPACE', 'CODEX_APPROVAL_MODE',
  'MEMORY_CONNECTION', 'MEMORY_PROVIDER',
  'CAPABILITIES_CONFIG',
])

// Keep executable examples separate from human-readable fallback descriptions.
const exampleValues = {
  MODEL_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  WATCH_MODEL: 'qwen3-vl-plus', CASCADE_LLM_MODEL: 'qwen-plus', MEMORY_PROVIDER: 'voicemem',
  SUGGESTION_COOLDOWN: '60', FRESH_WINDOW: '30',
  QWEN_REALTIME_URL: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
  VOLCENGINE_ARK_BASE_URL: 'https://ark.cn-beijing.volces.com/api/v3',
  DOUBAO_ASR_ENDPOINT: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
  DOUBAO_TTS_ENDPOINT: 'wss://openspeech.bytedance.com/api/v3/tts/bidirection',
}
const envSections = [
  ['Credentials — fill only for the services you use',
    'DASHSCOPE_API_KEY STEPFUN_API_KEY OPENAI_API_KEY GEMINI_API_KEY DEEPSEEK_API_KEY ARK_API_KEY DOUBAO_BIGMODEL_API_KEY DOUBAO_ASR_API_KEY TAVILY_API_KEY OPENROUTER_API_KEY COMPOSIO_API_KEY MODEL_API_KEY CODEX_API_KEY'],
  ['Conversation — integrated voice or cascaded ASR / LLM / TTS',
    'PROMPT_LANGUAGE NEWS_LANGUAGE PIPELINE_MODE INTEGRATED_PROVIDER OPENAI_REALTIME_MODEL OPENAI_REALTIME_VOICE GEMINI_REALTIME_MODEL GEMINI_REALTIME_VOICE STEPFUN_REALTIME_MODEL STEPFUN_REALTIME_VOICE QWEN_REALTIME_MODEL QWEN_REALTIME_VOICE CASCADE_ENDPOINTING_PROVIDER CASCADE_ASR_PROVIDER CASCADE_LLM_PROVIDER CASCADE_LLM_MODEL CASCADE_TTS_PROVIDER DOUBAO_TTS_VOICE'],
  ['Camera and vision',
    'CAMERA_MODULE_ENABLED CONVERSATION_VISION_ENABLED MONITOR_CAMERA_DEVICE_ID WATCH_MODEL'],
  ['Coding and approvals — EXECUTORS takes precedence over the legacy EXECUTOR alias',
    'CODING_MODULE_ENABLED EXECUTORS EXECUTOR CODEX_WORKSPACE CODEX_BIN CODEX_APPROVAL_MODE CODEX_PREWARM CODEX_MANAGED_ROOT CODEX_PROJECT_STATE_ROOT'],
  ['Planning, proactive suggestions and progress',
    'CLARIFICATION_DEPTH GENERATE_PLAN PLAN_READBACK PLANNER_MODEL PROACTIVITY_PRESET SUGGESTION_COOLDOWN FRESH_WINDOW CODING_PROGRESS_NARRATION CODEX_WORKING_INTERVAL PROGRESS_BUBBLES'],
  ['Search and capabilities',
    'CAPABILITIES_CONFIG SEARCH_PROVIDER SEARCH_MCP_URL SEARCH_MCP_TOOL'],
  ['Personal memory — PROVIDER is local-only; URL and TOKEN are remote-only',
    'MEMORY_PRERECALL_ENABLED MEMORY_CONSOLIDATION_ENABLED MEMORY_CONSOLIDATION_HOUR MEMORY_CONSOLIDATION_TIMEZONE MEMORY_LEDGER_PATH MEMORY_CONNECTION MEMORY_PROVIDER MEMORY_PATH MEMORY_USER_ID MEMORY_URL MEMORY_TOKEN'],
  ['Knowledge, embeddings and conversation recovery',
    'KNOWLEDGE_PATH EMBEDDING_PROVIDER EMBEDDING_MODEL BLACKBOARD_PATH BLACKBOARD_OWNER_ID'],
  ['Advanced: support models and provider endpoints',
    'MODEL_BASE_URL FAST_MODEL SUPPORT_MODEL COMPRESSOR_MODEL QWEN_REALTIME_URL STEPFUN_REALTIME_URL OPENAI_REALTIME_URL GEMINI_REALTIME_URL VOLCENGINE_ARK_BASE_URL DOUBAO_ASR_ENDPOINT DOUBAO_ASR_RESOURCE_ID DOUBAO_TTS_ENDPOINT DOUBAO_TTS_RESOURCE_ID'],
  ['Advanced: audio timing and endpoint detection',
    'DOUBAO_ASR_VOICEPRINT_ENABLED DOUBAO_ASR_VOICEPRINT_ID DOUBAO_ASR_VOICEPRINT_HEALTH_URL DOUBAO_ASR_VOICEPRINT_NAME DOUBAO_ASR_CHUNK_MS DOUBAO_TTS_OUTPUT_SAMPLE_RATE VOLCENGINE_VAD_THRESHOLD VOLCENGINE_VAD_PRE_ROLL_MS VOLCENGINE_VAD_MIN_SPEECH_MS VOLCENGINE_VAD_SILENCE_END_MS VOLCENGINE_VAD_SPEECH_PAD_MS VOLCENGINE_VAD_MAX_UTTERANCE_MS'],
  ['Advanced: Qwen reconnect and history recovery',
    'QWEN_CONTROLLED_GUARD_RECONNECT QWEN_GUARD_HISTORY_RECOVERY QWEN_GUARD_HISTORY_PAIRS'],
  ['Diagnostics and desktop development',
    'REALTIME_TELEMETRY DESKTOP_VIDEO_FILE NOVA_ORB_OPAQUE'],
]

const mode = process.argv[2]
if (mode !== '--check' && mode !== '--write') {
  process.stderr.write('Usage: node runtime/scripts/check-env-contract.mjs --check|--write\n')
  process.exitCode = 2
} else {
  const runtimeRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const repositoryRoot = resolve(runtimeRoot, '..')
  const targets = [
    {
      path: resolve(repositoryRoot, '.env.example'),
      start: '# BEGIN GENERATED ENV CONTRACT',
      end: '# END GENERATED ENV CONTRACT',
      render: renderEnv,
    },
    {
      path: resolve(repositoryRoot, 'docs/en/configuration.md'),
      start: '<!-- BEGIN GENERATED ENV CONTRACT -->',
      end: '<!-- END GENERATED ENV CONTRACT -->',
      render: () => renderMarkdown('en'),
    },
    {
      path: resolve(repositoryRoot, 'docs/zh-CN/configuration.md'),
      start: '<!-- BEGIN GENERATED ENV CONTRACT -->',
      end: '<!-- END GENERATED ENV CONTRACT -->',
      render: () => renderMarkdown('zh'),
    },
  ]
  let drift = false
  for (const target of targets) {
    const current = await readFile(target.path, 'utf8')
    const generated = `${target.start}\n${target.render()}\n${target.end}`
    const next = replaceBlock(current, target.start, target.end, generated)
    if (next === current) continue
    drift = true
    if (mode === '--write') await writeFile(target.path, next)
    else process.stderr.write(`environment contract drift: ${target.path}\n`)
  }
  if (mode === '--write') process.stdout.write('wrote generated environment contract blocks\n')
  else if (drift) process.exitCode = 1
  else process.stdout.write('generated environment contract blocks match\n')
}

function replaceBlock(current, start, end, generated) {
  const startIndex = current.indexOf(start)
  const endIndex = current.indexOf(end)
  if (startIndex < 0 || endIndex < startIndex) {
    const separator = current.endsWith('\n') ? '\n' : '\n\n'
    return `${current}${separator}${generated}\n`
  }
  const tail = endIndex + end.length
  return `${current.slice(0, startIndex)}${generated}${current.slice(tail)}`
}

function renderEnv() {
  const remaining = new Map(publicEnvironmentContract().map(entry => [entry.name, entry]))
  const sections = envSections.map(([title, names]) => {
    const lines = names.split(' ').map(name => {
      const entry = remaining.get(name)
      if (!entry) throw new Error(`Unknown or duplicate environment example: ${name}`)
      remaining.delete(name)
      const value = entry.secret ? '' : (exampleValues[name] ?? entry.defaultLabel ?? '')
      return `# ${name}=${value}`
    })
    return [`# --- ${title} ---`, ...lines].join('\n')
  })
  if (remaining.size) throw new Error(`Uncategorized environment examples: ${[...remaining.keys()].join(', ')}`)
  return sections.join('\n\n')
}

function renderMarkdown(language) {
  const heading = language === 'en'
    ? '| Variable | Default | Purpose |\n|---|---|---|'
    : '| 变量 | 默认 | 用途 |\n|---|---|---|'
  const rows = publicEnvironmentContract().filter(entry => coreNames.has(entry.name)).map(entry => {
    const fallback = language === 'en' ? 'None' : '无'
    const description = language === 'en' ? entry.descriptionEn : entry.descriptionZh
    return `| \`${entry.name}\` | ${escapeCell(entry.defaultLabel ?? fallback)} | ${escapeCell(description)} |`
  })
  return [heading, ...rows].join('\n')
}

function escapeCell(value) {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}
