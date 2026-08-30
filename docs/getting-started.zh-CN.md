<!-- Keep in sync with docs/getting-started.md -->

# 上手指南

## 当前发布边界

Node.js 与 TypeScript 是唯一的产品运行时。Codex 只使用 app-server；JSONL 仅为
fixture-parser-only，不再拥有生产进程执行路径。Search、Camera、Watch 和 Guard 始终装配，
不属于执行器选择项。遗留 HA 或 AutoGLM 配置会在 provider、进程、设备和桌面构造前返回稳定且
不泄露凭据的迁移错误。

## 源码开发安装

先安装 Node.js 22+、npm、Git 和已登录的 `codex` 可执行文件。原生构建还需要对应平台工具链：

- macOS：Xcode Command Line Tools（`xcode-select --install`）；
- Linux：`/usr/bin/cc` 位置可用的 C 编译器；
- Windows：Visual Studio Build Tools，并勾选 **Desktop development with C++** 工作负载。

Linux 桌面会话运行在 X11 上；Wayland 会话经由 XWayland。

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
桌面设置面板目前只暴露单个启动 workspace 路径字段；注册任意已有目录须使用
`NOVA_AUDIO_AGENT_CODEX_WORKSPACE`，语音只能创建新的托管目录。

每个 realtime turn 只注入 active Workspace 及其 active Session（如果存在）。Nova 只在请求时列出
Workspace 或 Session 候选项，历史候选项不会进入每轮常驻上下文。create、switch、resume 采用
分阶段提案：用户下一轮会成为专用 structured confirmation，携带完全匹配的 proposal ID 和 JSON
boolean。false、错误 ID 或重放均不改变状态。切换 Workspace 后，再请求列出或恢复其中的 Session。
持久化与恢复细节见[多项目 Workspace 交接](multi-project-workspace-handoff.md)。

注册表每个 Workspace 最多保留 200 个 Session、全局最多 1000 个：先清理最旧的 unavailable
Session，再清理非 active 的 ready Session；starting 和 active Session 始终受保护。若受保护记录
已经占满配额，创建返回 `session_limit`；锁竞争则立即返回 `state_busy`。之后修改
`NOVA_AUDIO_AGENT_CODEX_WORKSPACE` 会用确定性后缀登记另一个工作区，不会覆盖当前 active
Workspace；未命名 Session 使用便于朗读的“任务 N”。每个工作单都会启动新的 app-server 进程，
因此 project mode 有意禁用 Codex prewarm。持久 workspace home 会在宿主登录凭据变化时用
owner-only 的原子文件刷新；如果只更新了 workspace home 内的凭据而宿主源没有变化，这次
destination-only 更新会被保留。

## 未签名 Windows 开发候选包

GitHub Actions 工作流 **Unsigned Windows packages** 产出的是未签名开发候选包，而非已签名
发布版，且目前只构建 Windows artifact：请下载 `unsigned-win32-x64` 工作流 artifact，并使用其中
稳定的 `nova-win32-x64.exe`。其 Linux 分支在跨平台 CI 恢复之前暂时停用。Linux AppImage 与 deb
仍以本地打包脚本（`npm run package:linux`）和仅手动触发的 release-candidate 工作流（macOS、
Windows、Ubuntu 三平台；macOS 与 Windows 腿要求签名，Linux artifact 仅做格式校验、不签名）
形式存在；unsigned 工作流目前不发布 Linux artifact。使用前先确认下载来自预期的工作流运行。

未签名的 `nova-win32-x64.exe` 在 Windows 上可能触发 SmartScreen 警告。请保持 SmartScreen 和其他
Windows 安全防护开启；先核验工作流运行和文件，再决定是否使用该候选包。每个候选包的构建和验证
状态以对应工作流为准；本指南不声称原生 CI 已通过。

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
绝对路径；默认本地摄像头和 `NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE` 回放均使用 Chromium
摄像头链路。

真实 provider、麦克风/扬声器、Camera、Codex 登录、WindowServer、Windows 后代进程清理、
clean-machine installer、签名和发布仍是 pending external evidence。

### 可选在线 smoke

仓库中的 Qwen smoke 会连接真实 provider，且需要凭据；它是可选在线 smoke，本文不声称它已经运行或
通过。刻意提供 DashScope 密钥后，可运行：

```bash
DASHSCOPE_API_KEY=replace-with-your-qwen-key npm run runtime:smoke:qwen
```

## Workspace 记忆图谱与 MyContext provider

Node runtime 的 opt-in workspace 记忆图谱通过以下变量配置：

```bash
NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_ENABLED=true
NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_PATH=~/.nova-audio-agent/workspace-graph.sqlite

# 可选；必须指向另行提供的 Nova 兼容的只读 adapter base URL。
NOVA_AUDIO_AGENT_MYCONTEXT_PROVIDER_URL=http://127.0.0.1:PORT/base
```

图谱根据 Nova 已确认的生命周期维护 workspace 身份，并把相邻、已提交的 A→B 转换记录成弱
`discussed_with` 元数据——这只是有界的地图线索，不是从模型或 work-order 自由文本推导的结论。
Nova 不读取任一 workspace，关系低于主动建议阈值，90 天未刷新后转为 stale。已提交的切换会立即
撤销旧图谱 scope，并保留已接收的 A→B→C 顺序；无法提交的事件会打断相邻关系，不能跨缺口连边。
所有持久图谱时间统一使用 Unix 秒。Nova 不会复制仓库内的工程指令，也不会自动检查另一个
workspace。

可选的 MyContext provider 只能在同一个权威当前 workspace 中、为显式证据召回而被请求，例如用户
追问“为什么”或要求查看来源。它不参与启动、workspace 打开/切换、默认召回、Context Header、
Recall Pack、主动建议置信度、工具路由或任何 action。返回文本留在本地，只读且带来源标签，同时
被视为不受信任、不持久化且不主动；它不能修改 Nova 图谱、workspace 身份、任务状态或另一个
workspace。provider 故障只返回可见的降级空结果，不阻塞普通语音或项目工作。

该 URL 必须提供 Nova `nova_workspace_evidence` schema version 1 的严格能力握手和查询契约；
上游 MyContext 原始 `/capabilities` v2 不被接受，因为它不能证明 Nova 所要求的精确 workspace
scope。Nova 不提供 adapter 可执行文件，也不会根据 `/ask` 结果猜测兼容——只安装 MyContext 不会
启用 enrichment。这项集成只是 HTTP client 边界，不复制或捆绑 MyContext 代码及运行时；上游
MyContext 采用 Elastic License 2.0，复用、捆绑或随产品交付任何上游 MyContext 代码或运行时之前，
必须另行完成法律与分发审查。

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
| `NOVA_AUDIO_AGENT_REALTIME_TELEMETRY` | `telemetry` | 否 | ~/.nova-audio-agent/realtime-telemetry.jsonl | 源码运行时遥测输出路径；设置为空值可禁用。 |
| `NOVA_AUDIO_AGENT_REALTIME_TRACE` | `telemetry` | 否 | 0 | 启用源码运行时跟踪记录。 |
| `NOVA_ORB_OPAQUE` | `core` | 否 | 0 | 使用不透明桌面悬浮球窗口。 |
<!-- END GENERATED ENV CONTRACT -->
