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

默认集成 Qwen 链路需要在 `.env` 中设置 `TAVILY_API_KEY`，并在 `DASHSCOPE_API_KEY` 与受支持的
通用回退凭据中二选一。通用回退凭据是 `NOVA_AUDIO_AGENT_MODEL_API_KEY`，且只有配合下文所列的
精确 base URL 时才能作为 Qwen realtime 凭据。Search 始终装配，因此 Tavily 是必需配置。启动器只把
`.env` 当数据解析，不做 shell 求值；启动 shell 里已存在的变量优先于 `.env`。

启动桌面客户端：

```bash
npm run start:client
```

对于集成 Qwen 的源码启动，通常使用 `DASHSCOPE_API_KEY` 作为 realtime 凭据。只有当
`NOVA_AUDIO_AGENT_MODEL_BASE_URL` **完全等于**
`https://dashscope.aliyuncs.com/compatible-mode/v1` 时，才可以改用
`NOVA_AUDIO_AGENT_MODEL_API_KEY`；不同地址不会让通用密钥成为 Qwen realtime 凭据。两种凭据同时设置时，
`DASHSCOPE_API_KEY` 优先。

## 始终开启的 Codex project mode

实时 Codex project surface 没有启用/禁用 toggle。普通非实时 Codex 保留 `codex__run` 及原有语义；
realtime provider 不暴露 `codex__run`。Workspace 是文件系统/Git 项目；Session 是该 Workspace 内
可恢复的 Codex thread。托管 Workspace 默认位于 `~/.nova-audio-agent/workspaces`，注册表默认是
`~/.nova-audio-agent/codex-projects-v1.json`，各 Workspace 的 Codex home 默认位于
`~/.nova-audio-agent/codex-homes`。`NOVA_AUDIO_AGENT_CODEX_WORKSPACE` 可在启动时导入已有仓库。

每个 realtime turn 只注入 active Workspace 及其 active Session（如果存在）。Nova 只在请求时列出
Workspace 或 Session 候选项，历史候选项不会进入每轮常驻上下文。create、switch、resume 采用
分阶段提案：用户下一轮会成为专用 structured confirmation，携带完全匹配的 proposal ID 和 JSON
boolean。false、错误 ID 或重放均不改变状态。切换 Workspace 后，再请求列出或恢复其中的 Session。
持久化与恢复细节见[多项目 Workspace 交接](multi-project-workspace-handoff.md)。

## 未签名 Windows 与 Ubuntu 开发候选包

GitHub Actions 工作流 **Unsigned Windows and Ubuntu packages** 产出的是未签名开发候选包，而非
已签名发布版。请下载其 `unsigned-win32-x64` 或 `unsigned-linux-x64-gnu` 工作流 artifact，并使用其中
稳定的文件名：`nova-win32-x64.exe`、`nova-linux-x64.AppImage` 与 `nova-linux-x64.deb`。使用前先确认
下载来自预期的工作流运行。

未签名的 `nova-win32-x64.exe` 在 Windows 上可能触发 SmartScreen 警告。请保持 SmartScreen 和其他
Windows 安全防护开启；先核验工作流运行和文件，再决定是否使用该候选包。Linux 上，请先为 AppImage
添加可执行权限并直接运行：

```bash
chmod u+x nova-linux-x64.AppImage
./nova-linux-x64.AppImage
```

请通过系统包管理器安装 `nova-linux-x64.deb`（例如 Ubuntu 可运行
`sudo apt install ./nova-linux-x64.deb`）。每个候选包的构建和验证状态以对应工作流为准；本指南不声称
原生 CI 已通过。

仓库内 Node 检查均可离线、确定性运行：

```bash
npm run build --workspace @nova-audio-agent/runtime
node runtime/dist/src/cli.js diagnose --json
node runtime/dist/src/cli.js demo all
node runtime/dist/src/cli.js scorecard fixture check
```

`diagnose` 只验证配置，不连接 provider、不启动 Codex、不请求摄像头或麦克风、不启动 Chromium，
也不输出凭据和路径。普通检查只读已提交的产品 fixture。

## 实时管线、凭据与设置

`integrated` 和 `cascaded` 是顶层管线形态。默认是集成 Qwen：使用
`qwen-audio-3.0-realtime-plus`、`longanqian` 音色和 `DASHSCOPE_API_KEY`，没有 ASR、LLM 或 TTS
子节点控件。级联模式显示端点检测、ASR、LLM 和 TTS；默认链路是
火山 ASR -> Qwen `qwen-flash` -> 火山 TTS。Ark 是显式的级联 LLM 选择，不是另一种集成 provider：

```bash
NOVA_AUDIO_AGENT_PIPELINE_MODE=cascaded
NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER=ark
ARK_API_KEY=replace-with-your-ark-key
```

每个平台只存一把密钥，并为该平台的每个选中节点复用。Qwen 使用 `DASHSCOPE_API_KEY`；显式 Ark
LLM 使用 `ARK_API_KEY`；火山 TTS 使用 `DOUBAO_BIGMODEL_API_KEY`。`DOUBAO_ASR_API_KEY` 是可选 ASR
覆盖，未填写时 ASR 回退到 `DOUBAO_BIGMODEL_API_KEY`。只验证和构造被选中的 provider；没有自动
provider 故障转移。

条件式设置面板把管线模式放在 provider 配置之前。集成模式显示 provider、模型和音色；级联模式显示
端点检测、ASR、LLM 和 TTS 卡片。API 密钥仍是每个平台一个字段、只写，且只返回存在状态。管线、
provider、模型、音色和密钥编辑均在下次启动生效；只有配色是实时设置。

Node 可配置执行器为 `fast_sim`、`slow_sim`、`codex`。Codex 的
ordinary/live/project 模式共用有界 app-server transport。Camera 文件输入只接受主机验证过的
绝对路径。

真实 provider、麦克风/扬声器、Camera、Codex 登录、WindowServer、Windows 后代进程清理、
clean-machine installer、签名和发布仍是 pending external evidence。

### 可选在线 smoke

仓库中的 Qwen smoke 会连接真实 provider，且需要凭据；它是可选在线 smoke，本文不声称它已经运行或
通过。刻意提供 DashScope 密钥后，可运行：

```bash
DASHSCOPE_API_KEY=replace-with-your-qwen-key npm run runtime:smoke:qwen
```

## 公共环境变量参考

下表由 `runtime/src/environment-contract.ts` 生成。主机私有握手变量和已退役集成变量不会进入
表格。兼容提示：`HA_*` 与 `AUTOGLM_*` 已退役，不要在 Node 配置中继续填写其凭据或地址。

<!-- BEGIN GENERATED ENV CONTRACT -->
| 变量 | 所属 | 必需条件 | 默认 | 说明 |
|---|---|---|---|---|
| `NOVA_AUDIO_AGENT_MODEL_BASE_URL` | `core` | 否 | DashScope compatible endpoint | FastBrain 兼容 API 地址。 |
| `NOVA_AUDIO_AGENT_MODEL_API_KEY` | `core` | 否 | 无 | 可选的通用辅助模型 API 凭据覆盖。 |
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
| `NOVA_AUDIO_AGENT_CODEX_MANAGED_ROOT` | `codex` | 否 | ~/.nova-audio-agent/workspaces | 托管项目根目录。 |
| `NOVA_AUDIO_AGENT_CODEX_PROJECT_STATE_ROOT` | `codex` | 否 | ~/.nova-audio-agent | 项目状态根目录。 |
| `NOVA_AUDIO_AGENT_CODEX_WORKING_INTERVAL` | `codex` | 否 | 30 | Codex 进度间隔秒数。 |
| `NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_ENABLED` | `core` | 否 | false | 启用本地只读工作区记忆图谱。 |
| `NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_PATH` | `core` | 否 | ~/.nova-audio-agent/workspace-graph.sqlite | 工作区记忆图谱数据库路径。 |
| `NOVA_AUDIO_AGENT_MYCONTEXT_PROVIDER_URL` | `core` | 否 | 无 | 可选的仅限本机回环、Nova 兼容的只读 MyContext adapter base URL。 |
| `TAVILY_API_KEY` | `search` | 选择该能力时 | 无 | Tavily 搜索凭据。 |
| `NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE` | `camera` | 否 | 无 | 桌面确定性视频输入的绝对路径。 |
| `NOVA_AUDIO_AGENT_REALTIME_TELEMETRY` | `telemetry` | 否 | 无 | 源码运行时遥测输出路径。 |
| `NOVA_AUDIO_AGENT_REALTIME_TRACE` | `telemetry` | 否 | 0 | 启用源码运行时跟踪记录。 |
| `NOVA_ORB_OPAQUE` | `core` | 否 | 0 | 使用不透明桌面悬浮球窗口。 |
<!-- END GENERATED ENV CONTRACT -->
