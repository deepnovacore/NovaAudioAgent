import {stripLikePython} from './python-text.js'
import {casefoldLikePython} from './unicode-casefold.js'

export type EnvironmentOwner =
  | 'core' | 'qwen' | 'volcengine' | 'codex' | 'search' | 'camera'
  | 'telemetry' | 'source_rollback' | 'host_private' | 'retired_ha' | 'retired_autoglm'

export interface EnvironmentVariableContract {
  readonly name: string
  readonly owner: EnvironmentOwner
  readonly secret: boolean
  readonly public: boolean
  readonly required: 'never' | 'when_selected'
  readonly defaultLabel: string | null
  readonly descriptionEn: string
  readonly descriptionZh: string
}

type Row = readonly [
  name: string,
  owner: EnvironmentOwner,
  secret: boolean,
  publicValue: boolean,
  required: 'never' | 'when_selected',
  defaultLabel: string | null,
  descriptionEn: string,
  descriptionZh: string,
]

const rows: readonly Row[] = [
  ['NOVA_AUDIO_AGENT_BACKEND', 'source_rollback', false, true, 'never', 'python', 'Source-development backend switch during the rollback release.', '回滚发布期的源码开发后端开关。'],
  ['NOVA_AUDIO_AGENT_MODEL_BASE_URL', 'core', false, true, 'never', 'DashScope compatible endpoint', 'FastBrain compatible API endpoint.', 'FastBrain 兼容 API 地址。'],
  ['NOVA_AUDIO_AGENT_MODEL_API_KEY', 'core', true, true, 'when_selected', null, 'FastBrain API credential; also a Qwen fallback.', 'FastBrain API 凭据，也可作为 Qwen 回退凭据。'],
  ['NOVA_AUDIO_AGENT_FAST_MODEL', 'core', false, true, 'never', 'qwen3-vl-plus', 'FastBrain model.', 'FastBrain 模型。'],
  ['NOVA_AUDIO_AGENT_WATCH_MODEL', 'core', false, true, 'never', 'fast model', 'Watch model override.', 'Watch 模型覆盖。'],
  ['NOVA_AUDIO_AGENT_SURROGATE_MODEL', 'core', false, true, 'never', 'qwen-flash', 'Surrogate model.', 'Surrogate 模型。'],
  ['NOVA_AUDIO_AGENT_COMPRESSOR_MODEL', 'core', false, true, 'never', 'qwen-flash', 'Memory compressor model.', '记忆压缩模型。'],
  ['NOVA_AUDIO_AGENT_REALTIME_PROVIDER', 'core', false, true, 'never', 'qwen', 'Realtime provider: qwen or volcengine.', '实时提供方：qwen 或 volcengine。'],
  ['NOVA_AUDIO_AGENT_EXECUTOR', 'core', false, true, 'never', 'fast_sim', 'Single executor selector for compatibility.', '兼容用单执行器选择器。'],
  ['NOVA_AUDIO_AGENT_EXECUTORS', 'core', false, true, 'never', 'selected executor', 'Ordered executor list.', '有序执行器列表。'],
  ['NOVA_AUDIO_AGENT_PROACTIVITY_PRESET', 'core', false, true, 'never', 'balanced', 'Proactivity preset.', '主动性预设。'],
  ['NOVA_AUDIO_AGENT_SUGGESTION_COOLDOWN', 'core', false, true, 'never', 'preset', 'Suggestion cooldown override in seconds.', '建议冷却秒数覆盖。'],
  ['NOVA_AUDIO_AGENT_FRESH_WINDOW', 'core', false, true, 'never', 'preset', 'Fresh-context window override in seconds.', '新鲜上下文窗口秒数覆盖。'],
  ['DASHSCOPE_API_KEY', 'qwen', true, true, 'when_selected', null, 'Qwen realtime credential.', 'Qwen 实时凭据。'],
  ['NOVA_AUDIO_AGENT_QWEN_REALTIME_URL', 'qwen', false, true, 'never', 'DashScope realtime endpoint', 'Qwen secure realtime endpoint.', 'Qwen 安全实时地址。'],
  ['NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL', 'qwen', false, true, 'never', 'qwen-audio-3.0-realtime-plus', 'Qwen realtime model.', 'Qwen 实时模型。'],
  ['NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE', 'qwen', false, true, 'never', 'longanqian', 'Qwen realtime voice.', 'Qwen 实时音色。'],
  ['NOVA_AUDIO_AGENT_QWEN_CONTROLLED_GUARD_RECONNECT', 'qwen', false, true, 'never', 'false', 'Allow controlled Guard reconnect.', '允许受控 Guard 重连。'],
  ['NOVA_AUDIO_AGENT_QWEN_GUARD_HISTORY_RECOVERY', 'qwen', false, true, 'never', 'none', 'Guard history recovery mode.', 'Guard 历史恢复模式。'],
  ['NOVA_AUDIO_AGENT_QWEN_GUARD_HISTORY_PAIRS', 'qwen', false, true, 'never', '4', 'Guard history pair count.', 'Guard 历史对话对数。'],
  ['ARK_API_KEY', 'volcengine', true, true, 'when_selected', null, 'Volcengine Ark credential.', '火山方舟凭据。'],
  ['DOUBAO_ASR_API_KEY', 'volcengine', true, true, 'never', 'Doubao big-model key', 'Volcengine ASR credential override.', '火山 ASR 凭据覆盖。'],
  ['DOUBAO_BIGMODEL_API_KEY', 'volcengine', true, true, 'when_selected', null, 'Volcengine TTS and ASR fallback credential.', '火山 TTS 及 ASR 回退凭据。'],
  ['NOVA_AUDIO_AGENT_VOLCENGINE_ARK_BASE_URL', 'volcengine', false, true, 'never', 'Volcengine Ark endpoint', 'Volcengine Ark secure endpoint.', '火山方舟安全地址。'],
  ['NOVA_AUDIO_AGENT_VOLCENGINE_ARK_MODEL', 'volcengine', false, true, 'never', 'doubao-seed-2-0-pro-260215', 'Volcengine primary model.', '火山主模型。'],
  ['NOVA_AUDIO_AGENT_VOLCENGINE_ARK_SUPPORT_MODEL', 'volcengine', false, true, 'never', 'primary model', 'Volcengine support model.', '火山辅助模型。'],
  ['NOVA_AUDIO_AGENT_DOUBAO_ASR_ENDPOINT', 'volcengine', false, true, 'never', 'Doubao ASR endpoint', 'Doubao ASR secure endpoint.', '豆包 ASR 安全地址。'],
  ['NOVA_AUDIO_AGENT_DOUBAO_ASR_RESOURCE_ID', 'volcengine', false, true, 'never', 'volc.seedasr.sauc.duration', 'Doubao ASR resource ID.', '豆包 ASR 资源 ID。'],
  ['NOVA_AUDIO_AGENT_DOUBAO_ASR_CHUNK_MS', 'volcengine', false, true, 'never', '200', 'ASR input chunk duration.', 'ASR 输入分块时长。'],
  ['NOVA_AUDIO_AGENT_DOUBAO_TTS_ENDPOINT', 'volcengine', false, true, 'never', 'Doubao TTS endpoint', 'Doubao TTS secure endpoint.', '豆包 TTS 安全地址。'],
  ['NOVA_AUDIO_AGENT_DOUBAO_TTS_RESOURCE_ID', 'volcengine', false, true, 'never', 'seed-tts-2.0', 'Doubao TTS resource ID.', '豆包 TTS 资源 ID。'],
  ['NOVA_AUDIO_AGENT_DOUBAO_TTS_VOICE', 'volcengine', false, true, 'never', 'zh_female_vv_uranus_bigtts', 'Doubao TTS voice.', '豆包 TTS 音色。'],
  ['NOVA_AUDIO_AGENT_DOUBAO_TTS_OUTPUT_SAMPLE_RATE', 'volcengine', false, true, 'never', '24000', 'Doubao TTS output sample rate.', '豆包 TTS 输出采样率。'],
  ['NOVA_AUDIO_AGENT_VOLCENGINE_VAD_THRESHOLD', 'volcengine', false, true, 'never', '0.5', 'VAD speech threshold.', 'VAD 语音阈值。'],
  ['NOVA_AUDIO_AGENT_VOLCENGINE_VAD_PRE_ROLL_MS', 'volcengine', false, true, 'never', '260', 'VAD pre-roll duration.', 'VAD 预滚时长。'],
  ['NOVA_AUDIO_AGENT_VOLCENGINE_VAD_MIN_SPEECH_MS', 'volcengine', false, true, 'never', '250', 'VAD minimum speech duration.', 'VAD 最短语音时长。'],
  ['NOVA_AUDIO_AGENT_VOLCENGINE_VAD_SILENCE_END_MS', 'volcengine', false, true, 'never', '560', 'VAD silence endpoint duration.', 'VAD 静音断句时长。'],
  ['NOVA_AUDIO_AGENT_VOLCENGINE_VAD_SPEECH_PAD_MS', 'volcengine', false, true, 'never', '30', 'VAD speech padding.', 'VAD 语音补边。'],
  ['NOVA_AUDIO_AGENT_VOLCENGINE_VAD_MAX_UTTERANCE_MS', 'volcengine', false, true, 'never', '15000', 'VAD maximum utterance duration.', 'VAD 最长话语时长。'],
  ['NOVA_AUDIO_AGENT_CODEX_WORKSPACE', 'codex', false, true, 'when_selected', null, 'Host-approved Codex workspace.', '主机批准的 Codex 工作区。'],
  ['NOVA_AUDIO_AGENT_CODEX_BIN', 'codex', false, true, 'never', 'codex', 'Host-approved Codex app-server binary.', '主机批准的 Codex app-server 可执行文件。'],
  ['NOVA_AUDIO_AGENT_CODEX_API_KEY', 'codex', true, true, 'never', 'Codex login', 'Optional Codex credential override.', '可选 Codex 凭据覆盖。'],
  ['NOVA_AUDIO_AGENT_CODEX_PREWARM', 'codex', false, true, 'never', 'true', 'Prewarm Codex app-server.', '预热 Codex app-server。'],
  ['NOVA_AUDIO_AGENT_CODEX_PROJECTS_ENABLED', 'codex', false, true, 'never', 'false', 'Enable Codex projects.', '启用 Codex Projects。'],
  ['NOVA_AUDIO_AGENT_CODEX_MANAGED_ROOT', 'codex', false, true, 'never', '~/NovaWorkspaces', 'Managed project root.', '托管项目根目录。'],
  ['NOVA_AUDIO_AGENT_CODEX_PROJECT_STATE_ROOT', 'codex', false, true, 'never', '~/.nova-audio-agent', 'Project state root.', '项目状态根目录。'],
  ['NOVA_AUDIO_AGENT_CODEX_WORKING_INTERVAL', 'codex', false, true, 'never', '30', 'Codex progress interval in seconds.', 'Codex 进度间隔秒数。'],
  ['TAVILY_API_KEY', 'search', true, true, 'when_selected', null, 'Tavily search credential.', 'Tavily 搜索凭据。'],
  ['NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE', 'camera', false, true, 'never', null, 'Absolute deterministic desktop video input.', '桌面确定性视频输入的绝对路径。'],
  ['NOVA_AUDIO_AGENT_REALTIME_TELEMETRY', 'telemetry', false, true, 'never', null, 'Source-runtime telemetry output path.', '源码运行时遥测输出路径。'],
  ['NOVA_AUDIO_AGENT_REALTIME_TRACE', 'telemetry', false, true, 'never', '0', 'Enable source-runtime trace records.', '启用源码运行时跟踪记录。'],
  ['NOVA_ORB_OPAQUE', 'core', false, true, 'never', '0', 'Use an opaque desktop orb window.', '使用不透明桌面悬浮球窗口。'],
  ['NOVA_AUDIO_AGENT_PYTHON', 'source_rollback', false, false, 'never', null, 'Host-selected Python for source rollback only.', '仅供源码回滚的主机 Python。'],
  ['VIRTUAL_ENV', 'source_rollback', false, false, 'never', null, 'Source-development Python environment.', '源码开发 Python 环境。'],
  ['NOVA_AUDIO_AGENT_DESKTOP_TOKEN', 'host_private', true, false, 'when_selected', null, 'Desktop transport handshake token.', '桌面传输握手令牌。'],
  ['NOVA_AUDIO_AGENT_DESKTOP_READY_ENDPOINT', 'host_private', false, false, 'when_selected', null, 'Desktop readiness endpoint.', '桌面就绪端点。'],
  ['NOVA_AUDIO_AGENT_DESKTOP_READY_FD', 'host_private', false, false, 'never', null, 'Legacy desktop readiness descriptor.', '旧桌面就绪描述符。'],
  ['NOVA_AUDIO_AGENT_RELEASE_CAMERA_SMOKE', 'host_private', false, false, 'never', null, 'Packaged release camera capability sentinel.', '安装包发布相机能力哨兵。'],
  ['NOVA_AUDIO_AGENT_RELEASE_SMOKE', 'host_private', false, false, 'never', null, 'Authenticated packaged lifecycle smoke mode.', '安装包认证生命周期冒烟模式。'],
  ['CODEX_HOME', 'host_private', false, false, 'never', null, 'Host Codex credential home.', '主机 Codex 凭据目录。'],
  ['HOME', 'host_private', false, false, 'never', null, 'Host home directory.', '主机用户目录。'],
  ['NOVA_AUDIO_AGENT_HA_URL', 'retired_ha', false, false, 'never', null, 'Retired Home Assistant endpoint.', '已退役 Home Assistant 地址。'],
  ['NOVA_AUDIO_AGENT_HA_TOKEN', 'retired_ha', true, false, 'never', null, 'Retired Home Assistant credential.', '已退役 Home Assistant 凭据。'],
  ['NOVA_AUDIO_AGENT_HA_ENTITY_ID', 'retired_ha', false, false, 'never', null, 'Retired Home Assistant entity.', '已退役 Home Assistant 实体。'],
  ['NOVA_AUDIO_AGENT_AUTOGLM_REPO', 'retired_autoglm', false, false, 'never', null, 'Retired AutoGLM repository.', '已退役 AutoGLM 仓库。'],
  ['NOVA_AUDIO_AGENT_AUTOGLM_PYTHON', 'retired_autoglm', false, false, 'never', null, 'Retired AutoGLM Python.', '已退役 AutoGLM Python。'],
  ['NOVA_AUDIO_AGENT_AUTOGLM_BASE_URL', 'retired_autoglm', false, false, 'never', null, 'Retired AutoGLM endpoint.', '已退役 AutoGLM 地址。'],
  ['NOVA_AUDIO_AGENT_AUTOGLM_MODEL', 'retired_autoglm', false, false, 'never', null, 'Retired AutoGLM model.', '已退役 AutoGLM 模型。'],
  ['NOVA_AUDIO_AGENT_AUTOGLM_API_KEY', 'retired_autoglm', true, false, 'never', null, 'Retired AutoGLM credential.', '已退役 AutoGLM 凭据。'],
  ['NOVA_AUDIO_AGENT_AUTOGLM_WDA_URL', 'retired_autoglm', false, false, 'never', null, 'Retired AutoGLM WDA endpoint.', '已退役 AutoGLM WDA 地址。'],
  ['NOVA_AUDIO_AGENT_AUTOGLM_DEVICE_ID', 'retired_autoglm', false, false, 'never', null, 'Retired AutoGLM device selector.', '已退役 AutoGLM 设备选择器。'],
] as const

export const environmentContract: readonly EnvironmentVariableContract[] = Object.freeze(rows.map(
  ([name, owner, secret, publicValue, required, defaultLabel, descriptionEn, descriptionZh]) =>
    Object.freeze({
      name,
      owner,
      secret,
      public: publicValue,
      required,
      defaultLabel,
      descriptionEn,
      descriptionZh,
    }),
))

export function publicEnvironmentContract(): readonly EnvironmentVariableContract[] {
  return Object.freeze(environmentContract.filter(entry => entry.public))
}

export function findRetiredConfiguration(environment: NodeJS.ProcessEnv):
  | {readonly capability: 'ha' | 'autoglm'; readonly fields: readonly string[]}
  | null {
  const configured = environment.NOVA_AUDIO_AGENT_EXECUTORS
  const selectorValues = configured === undefined || configured === ''
    ? [environment.NOVA_AUDIO_AGENT_EXECUTOR ?? '']
    : configured.split(',')
  for (const value of selectorValues) {
    const normalized = casefoldLikePython(stripLikePython(value))
    if (normalized === 'ha' || normalized === 'autoglm') {
      return Object.freeze({capability: normalized, fields: Object.freeze([])})
    }
  }

  const retiredEntries = environmentContract
    .filter(entry => entry.owner === 'retired_ha' || entry.owner === 'retired_autoglm')
    .filter(entry => stripLikePython(environment[entry.name] ?? '') !== '')
    .sort((left, right) => compareStrings(left.name, right.name))
  if (retiredEntries.length === 0) return null
  const capability = retiredEntries[0]!.owner === 'retired_ha' ? 'ha' : 'autoglm'
  const fields = retiredEntries
    .filter(entry => entry.owner === `retired_${capability}`)
    .map(entry => entry.name)
  return Object.freeze({capability, fields: Object.freeze(fields)})
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
