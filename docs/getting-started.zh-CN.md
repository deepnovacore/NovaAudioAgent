# 上手指南

## 当前发布边界

Node.js 与 TypeScript 是当前主运行时。Codex 只使用 app-server；JSONL 仅为
fixture-parser-only，不再拥有生产进程执行路径。Search、Camera、Watch 和 Guard 始终装配，
不属于执行器选择项。遗留 HA 或 AutoGLM 配置会在 provider、进程、设备和桌面构造前返回稳定且
不泄露凭据的迁移错误。

## 源码开发安装

先安装 Node.js 22+、npm、Git 和已登录的 `codex` 可执行文件。原生构建还需要对应平台工具链：

- macOS：Xcode Command Line Tools（`xcode-select --install`）；
- Linux：`/usr/bin/cc` 位置可用的 C 编译器；
- Windows：Visual Studio Build Tools，并勾选 **Desktop development with C++** 工作负载。

```bash
git clone \
  https://github.com/deepnovacore/NovaAudioAgent.git nova-audio-agent
cd nova-audio-agent
npm ci
cp .env.example .env
```

默认 Qwen 链路必须在 `.env` 中同时设置 `DASHSCOPE_API_KEY` 和 `TAVILY_API_KEY`。Search
始终装配，因此 Tavily 是必需配置。启动器只把 `.env` 当数据解析，不做 shell 求值；启动 shell
里已存在的变量优先于 `.env`。

启动桌面客户端：

```bash
npm run start:client
```

仓库内 Node 检查均可离线、确定性运行：

```bash
npm run build --workspace @nova-audio-agent/runtime
node runtime/dist/src/cli.js diagnose --json
node runtime/dist/src/cli.js demo all
node runtime/dist/src/cli.js scorecard fixture check
```

`diagnose` 只验证配置，不连接 provider、不启动 Codex、不请求摄像头或麦克风、不启动 Chromium，
也不输出凭据和路径。普通检查只读已提交的产品 fixture。

## 实时提供方与执行器

Qwen 是默认实时提供方，Volcengine 是另一套共用 provider-neutral assembly 的实现；真实使用时
都需要所选 provider 的凭据。Node 可配置执行器为 `fast_sim`、`slow_sim`、`codex`。Codex 的
ordinary/live/project 模式共用有界 app-server transport。Camera 文件输入只接受主机验证过的
绝对路径。

真实 provider、麦克风/扬声器、Camera、Codex 登录、WindowServer、Windows 后代进程清理、
clean-machine installer、签名和发布仍是 pending external evidence。

## 公共环境变量参考

下表由 `runtime/src/environment-contract.ts` 生成。主机私有握手变量和已退役集成变量不会进入
表格。兼容提示：`HA_*` 与 `AUTOGLM_*` 已退役，不要在 Node 配置中继续填写其凭据或地址。

<!-- BEGIN GENERATED ENV CONTRACT -->
| 变量 | 所属 | 必需条件 | 默认 | 说明 |
|---|---|---|---|---|
| `NOVA_AUDIO_AGENT_MODEL_BASE_URL` | `core` | 否 | DashScope compatible endpoint | FastBrain 兼容 API 地址。 |
| `NOVA_AUDIO_AGENT_MODEL_API_KEY` | `core` | 选择该能力时 | 无 | FastBrain API 凭据，也可作为 Qwen 回退凭据。 |
| `NOVA_AUDIO_AGENT_FAST_MODEL` | `core` | 否 | qwen3-vl-plus | FastBrain 模型。 |
| `NOVA_AUDIO_AGENT_WATCH_MODEL` | `core` | 否 | fast model | Watch 模型覆盖。 |
| `NOVA_AUDIO_AGENT_SURROGATE_MODEL` | `core` | 否 | qwen-flash | Surrogate 模型。 |
| `NOVA_AUDIO_AGENT_COMPRESSOR_MODEL` | `core` | 否 | qwen-flash | 记忆压缩模型。 |
| `NOVA_AUDIO_AGENT_PIPELINE_MODE` | `core` | 否 | integrated | 产品管线形态：集成或级联。 |
| `NOVA_AUDIO_AGENT_INTEGRATED_PROVIDER` | `core` | 否 | qwen | 集成实时提供方。 |
| `NOVA_AUDIO_AGENT_CASCADE_ENDPOINTING_PROVIDER` | `core` | 否 | auto | 级联端点检测提供方。 |
| `NOVA_AUDIO_AGENT_CASCADE_ASR_PROVIDER` | `core` | 否 | volcengine | 级联 ASR 提供方。 |
| `NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER` | `core` | 否 | qwen | 级联 LLM 提供方。 |
| `NOVA_AUDIO_AGENT_CASCADE_LLM_MODEL` | `core` | 否 | provider default | 级联 LLM 模型覆盖。 |
| `NOVA_AUDIO_AGENT_CASCADE_TTS_PROVIDER` | `core` | 否 | volcengine | 级联 TTS 提供方。 |
| `NOVA_AUDIO_AGENT_EXECUTOR` | `core` | 否 | fast_sim | 兼容用单执行器选择器。 |
| `NOVA_AUDIO_AGENT_EXECUTORS` | `core` | 否 | selected executor | 有序执行器列表。 |
| `NOVA_AUDIO_AGENT_PROACTIVITY_PRESET` | `core` | 否 | balanced | 主动性预设。 |
| `NOVA_AUDIO_AGENT_SUGGESTION_COOLDOWN` | `core` | 否 | preset | 建议冷却秒数覆盖。 |
| `NOVA_AUDIO_AGENT_FRESH_WINDOW` | `core` | 否 | preset | 新鲜上下文窗口秒数覆盖。 |
| `DASHSCOPE_API_KEY` | `qwen` | 选择该能力时 | 无 | Qwen 实时凭据。 |
| `NOVA_AUDIO_AGENT_QWEN_REALTIME_URL` | `qwen` | 否 | DashScope realtime endpoint | Qwen 安全实时地址。 |
| `NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL` | `qwen` | 否 | qwen-audio-3.0-realtime-plus | Qwen 实时模型。 |
| `NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE` | `qwen` | 否 | longanqian | Qwen 实时音色。 |
| `NOVA_AUDIO_AGENT_QWEN_CONTROLLED_GUARD_RECONNECT` | `qwen` | 否 | false | 允许受控 Guard 重连。 |
| `NOVA_AUDIO_AGENT_QWEN_GUARD_HISTORY_RECOVERY` | `qwen` | 否 | none | Guard 历史恢复模式。 |
| `NOVA_AUDIO_AGENT_QWEN_GUARD_HISTORY_PAIRS` | `qwen` | 否 | 4 | Guard 历史对话对数。 |
| `ARK_API_KEY` | `ark` | 选择该能力时 | 无 | 方舟级联 LLM 凭据。 |
| `DOUBAO_ASR_API_KEY` | `volcengine` | 否 | Doubao big-model key | 火山 ASR 凭据覆盖。 |
| `DOUBAO_BIGMODEL_API_KEY` | `volcengine` | 选择该能力时 | 无 | 火山 TTS 及 ASR 回退凭据。 |
| `NOVA_AUDIO_AGENT_VOLCENGINE_ARK_BASE_URL` | `ark` | 否 | Volcengine Ark endpoint | 方舟安全地址。 |
| `NOVA_AUDIO_AGENT_DOUBAO_ASR_ENDPOINT` | `volcengine` | 否 | Doubao ASR endpoint | 豆包 ASR 安全地址。 |
| `NOVA_AUDIO_AGENT_DOUBAO_ASR_RESOURCE_ID` | `volcengine` | 否 | volc.seedasr.sauc.duration | 豆包 ASR 资源 ID。 |
| `NOVA_AUDIO_AGENT_DOUBAO_ASR_CHUNK_MS` | `volcengine` | 否 | 200 | ASR 输入分块时长。 |
| `NOVA_AUDIO_AGENT_DOUBAO_TTS_ENDPOINT` | `volcengine` | 否 | Doubao TTS endpoint | 豆包 TTS 安全地址。 |
| `NOVA_AUDIO_AGENT_DOUBAO_TTS_RESOURCE_ID` | `volcengine` | 否 | seed-tts-2.0 | 豆包 TTS 资源 ID。 |
| `NOVA_AUDIO_AGENT_DOUBAO_TTS_VOICE` | `volcengine` | 否 | zh_female_vv_uranus_bigtts | 豆包 TTS 音色。 |
| `NOVA_AUDIO_AGENT_DOUBAO_TTS_OUTPUT_SAMPLE_RATE` | `volcengine` | 否 | 24000 | 豆包 TTS 输出采样率。 |
| `NOVA_AUDIO_AGENT_VOLCENGINE_VAD_THRESHOLD` | `volcengine` | 否 | 0.5 | VAD 语音阈值。 |
| `NOVA_AUDIO_AGENT_VOLCENGINE_VAD_PRE_ROLL_MS` | `volcengine` | 否 | 260 | VAD 预滚时长。 |
| `NOVA_AUDIO_AGENT_VOLCENGINE_VAD_MIN_SPEECH_MS` | `volcengine` | 否 | 250 | VAD 最短语音时长。 |
| `NOVA_AUDIO_AGENT_VOLCENGINE_VAD_SILENCE_END_MS` | `volcengine` | 否 | 560 | VAD 静音断句时长。 |
| `NOVA_AUDIO_AGENT_VOLCENGINE_VAD_SPEECH_PAD_MS` | `volcengine` | 否 | 30 | VAD 语音补边。 |
| `NOVA_AUDIO_AGENT_VOLCENGINE_VAD_MAX_UTTERANCE_MS` | `volcengine` | 否 | 15000 | VAD 最长话语时长。 |
| `NOVA_AUDIO_AGENT_CODEX_WORKSPACE` | `codex` | 选择该能力时 | 无 | 主机批准的 Codex 工作区。 |
| `NOVA_AUDIO_AGENT_CODEX_BIN` | `codex` | 否 | codex | 主机批准的 Codex app-server 可执行文件。 |
| `NOVA_AUDIO_AGENT_CODEX_API_KEY` | `codex` | 否 | Codex login | 可选 Codex 凭据覆盖。 |
| `NOVA_AUDIO_AGENT_CODEX_PREWARM` | `codex` | 否 | true | 预热 Codex app-server。 |
| `NOVA_AUDIO_AGENT_CODEX_PROJECTS_ENABLED` | `codex` | 否 | false | 启用 Codex Projects。 |
| `NOVA_AUDIO_AGENT_CODEX_MANAGED_ROOT` | `codex` | 否 | ~/NovaWorkspaces | 托管项目根目录。 |
| `NOVA_AUDIO_AGENT_CODEX_PROJECT_STATE_ROOT` | `codex` | 否 | ~/.nova-audio-agent | 项目状态根目录。 |
| `NOVA_AUDIO_AGENT_CODEX_WORKING_INTERVAL` | `codex` | 否 | 30 | Codex 进度间隔秒数。 |
| `TAVILY_API_KEY` | `search` | 选择该能力时 | 无 | Tavily 搜索凭据。 |
| `NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE` | `camera` | 否 | 无 | 桌面确定性视频输入的绝对路径。 |
| `NOVA_AUDIO_AGENT_REALTIME_TELEMETRY` | `telemetry` | 否 | 无 | 源码运行时遥测输出路径。 |
| `NOVA_AUDIO_AGENT_REALTIME_TRACE` | `telemetry` | 否 | 0 | 启用源码运行时跟踪记录。 |
| `NOVA_ORB_OPAQUE` | `core` | 否 | 0 | 使用不透明桌面悬浮球窗口。 |
<!-- END GENERATED ENV CONTRACT -->
