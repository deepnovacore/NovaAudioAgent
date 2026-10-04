# 核心配置

环境变量已移除原来的 `NOVA_AUDIO_AGENT_` 前缀，例如 `PIPELINE_MODE`、`CODEX_WORKSPACE`。升级前请同步修改已有 `.env`、服务和 CI 配置中的键名；旧名称不再读取。`DASHSCOPE_API_KEY` 等供应商密钥名称不变。桌面偏好设置会覆盖管线、语言等部分非密钥变量；这些环境变量也供直接启动运行时使用。

通常在桌面设置中选择模型和填写密钥即可。源码运行也可以在项目 `.env` 中配置；修改后重启桌面应用。

## 最小配置

默认的 Qwen 实时语音只需要一把密钥：

```dotenv
DASHSCOPE_API_KEY=你的百炼密钥
```

只有所选语音管线的密钥是必填的。搜索、摄像头监控、记忆和知识库缺少密钥时自动关闭，设置页和 `novaaudio doctor` 会写明各自需要的密钥。配置了 `TAVILY_API_KEY` 时用 Tavily 搜索，否则用百炼 MCP 搜索。桌面切换级联模式时，默认使用火山识别、DeepSeek 和火山合成，需要 `DOUBAO_BIGMODEL_API_KEY`、`DEEPSEEK_API_KEY`。个人记忆等辅助模型仍使用百炼，保留 `DASHSCOPE_API_KEY`。

选择 Qwen Audio 3.1 时使用 `qwen-audio-3.1-realtime-plus` 和配套音色 `longanqian_v3.1`。StepAudio 3 为预览接入，尚待真实环境验收。选择 StepAudio 3 时，`STEPFUN_API_KEY` 同时用于实时语音和默认辅助对话、视觉模型 Step 3.7 Flash。本地记忆嵌入仍需单独配置嵌入服务；不使用本地记忆时可关闭它。如需自定义辅助模型网关，设置 `MODEL_API_KEY` 和 `MODEL_BASE_URL`。

## 常用选项

只填写需要更改的项，其他保持默认。密钥不要提交到 Git。

直接启动运行时时，级联 LLM 默认选择 Qwen；显式设置 `CASCADE_LLM_PROVIDER=deepseek` 可与桌面默认选择一致。

<!-- BEGIN GENERATED ENV CONTRACT -->
| 变量 | 默认 | 用途 |
|---|---|---|
| `PIPELINE_MODE` | integrated | 产品管线形态：集成或级联。 |
| `PROMPT_LANGUAGE` | zh-CN | AI system prompt 语言：zh-CN 或 en；桌面端会提供其保存的偏好。 |
| `INTEGRATED_PROVIDER` | qwen | 集成实时提供方。 |
| `CASCADE_LLM_PROVIDER` | deepseek | 级联 LLM 提供方。 |
| `CASCADE_LLM_MODEL` | provider default | 级联 LLM 模型覆盖。 |
| `CODEX_APPROVAL_MODE` | ask | Codex 审批模式。 |
| `CAPABILITIES_CONFIG` | ~/.nova-audio-agent/capabilities.json | 能力注册表路径。 |
| `MEMORY_CONNECTION` | local | 记忆连接：disabled、local 或 remote。 |
| `MEMORY_PROVIDER` | 无 | 本地引擎：voicemem（默认，统一账本）或显式选择 mem0。远程引擎由服务端选择。 |
| `DASHSCOPE_API_KEY` | 无 | Qwen 实时凭据。 |
| `QWEN_REALTIME_MODEL` | qwen-audio-3.0-realtime-plus | Qwen 实时模型。 |
| `QWEN_REALTIME_VOICE` | longanqian | Qwen 实时音色。 |
| `OPENAI_API_KEY` | 无 | OpenAI API 凭据。 |
| `GEMINI_API_KEY` | 无 | Gemini API 凭据。 |
| `STEPFUN_API_KEY` | 无 | StepFun 实时凭据。 |
| `DEEPSEEK_API_KEY` | 无 | DeepSeek 官方级联 LLM 凭据。 |
| `ARK_API_KEY` | 无 | 方舟级联 LLM 凭据。 |
| `DOUBAO_ASR_API_KEY` | Doubao big-model key | 火山 ASR 凭据覆盖。 |
| `DOUBAO_BIGMODEL_API_KEY` | 无 | 火山 TTS 及 ASR 回退凭据。 |
| `CODEX_WORKSPACE` | 无 | 主机批准的 Codex 工作区。 |
| `CODEX_BIN` | codex | 主机批准的 Codex app-server 可执行文件。 |
| `TAVILY_API_KEY` | 无 | Tavily 搜索凭据。 |
<!-- END GENERATED ENV CONTRACT -->

`ask` 保留权限确认；`yolo` 允许 Codex 无审批执行，请按信任范围选择。

还有几个变量用于较少见的配置。`COMPOSIO_API_KEY` 用于通过 Composio 授权 Google 连接器（Gmail 与 Calendar）。`OPENROUTER_API_KEY` 提供 Jev 判定模型，用于给个人记忆候选内容（Todo、Idea、Goal、Profile）打分，以及给资讯排序相关性；缺少此密钥时，这两项功能都会保持关闭。`DOUBAO_ASR_VOICEPRINT_ENABLED` 与 `DOUBAO_ASR_VOICEPRINT_ID`、`DOUBAO_ASR_VOICEPRINT_NAME`、`DOUBAO_ASR_VOICEPRINT_HEALTH_URL` 搭配使用，开启可选的 ASR 声纹校验。`NEWS_LANGUAGE` 独立于界面语言设置资讯流的语言。`MEMORY_LEDGER_PATH` 可覆盖统一记忆账本 SQLite 文件的存放位置（默认 `~/.nova-audio-agent/workspace-graph.sqlite`）。

选择远程记忆或关闭记忆时，移除本地 provider 配置。远程记忆设置见[个人记忆](personal-memory.md)；手机连接见[iPhone 指南](iphone.md)。

### 辅助模型命名

`SUPPORT_MODEL` 选择主动沟通、编码接入/取消目标判断、任务验收、个人记录提取和个人内容生成共用的辅助 LLM。这是模型选型，不是包揽所有功能的业务角色。`GatewayProactivity`、`GatewayTaskVerifier` 和 `GatewayPersonalWriter` 各自承担独立职责；理解和新闻复用已有工厂。Jev 判断、规划、压缩和视觉维持原有路由。

请在环境配置中将 `SURROGATE_MODEL` 改为 `SUPPORT_MODEL`。旧变量不再读取，不提供兼容别名；如果环境中仍设置了它，启动时会输出 `[config-warning] SURROGATE_MODEL is no longer read; rename it to SUPPORT_MODEL`。只有新变量参与选型。原有 provider 默认值、级联模型与端点配对规则保持不变。

TypeScript API 变化：`Settings.surrogate_model` 改为 `support_model`；原来的宽接口 `GatewaySurrogate` 由上述三个适配器替代。原 `watch()` 调用改为 `GatewayProactivity.select()`，其他功能迁移到各自模块。本次不切换 Jev，也不迁移事件协议；既有序列化 `surrogate` 标识和模型可见提示词保留历史拼写。

### 目标解析

`GatewayTargetResolver` 将工作区/session 识别（`resolveIntake`）和运行任务选择（`resolveWork`）从需求提取中独立出来。`intakeModels` 的第四个参数可注入目标解析器，通过 `models.targets` 暴露；取消路径调用同一个解析器。需求提取与目标解析共用 `SUPPORT_MODEL` 及其 gateway，规划保持原有模型选型。

一次正常评估现在依次调用需求模型和目标模型，两步共用原来的评估截止时间；放弃需求时跳过目标解析。宿主仍在执行动作前校验原话证据、明确的 session 延续意图、确认与过期结果。新工作区名称和目标澄清句仍由 LLM 生成，因此该边界尚不能直接替换成 Jev。本次不新增模型配置。

目标校验失败后，当前重试会重跑两个阶段；最多四次模型调用共用原来的两次尝试、30 秒评估预算。

[返回上手指南](getting-started.md)

OpenAI 与 Gemini 的模型选项、独立密钥、级联配置和协议限制见 [海外模型接入说明](global-providers.md)。
