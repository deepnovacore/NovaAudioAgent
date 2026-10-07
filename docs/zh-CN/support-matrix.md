# 支持矩阵

按当前代码中的适配器和能力白名单整理。这里的“支持”表示已接入，不代表所有模型、设备和平台组合都通过了实机验收。

## 语音管线

| 能力 | 集成管线 Integrated | 级联管线 Cascaded |
|---|---|---|
| 处理方式 | 一个实时模型直接处理语音 | 语音识别 → 语言模型 → 语音合成 |
| 默认组合 | Qwen `qwen-audio-3.0-realtime-plus` | 火山 ASR → DeepSeek `deepseek-flash` → 火山 TTS |
| 语音打断 | 已接入 | 已接入 |
| 编码任务、搜索和记忆工具 | 根据已启用能力提供 | 根据已启用能力提供 |
| 对话中的摄像头画面 | 不支持 | 仅支持下表列出的视觉模型，默认关闭 |
| Loop Camera 独立监控 | 支持，另用监控视觉模型 | 支持，另用监控视觉模型 |
| iPhone 文字输入 | 不提供可编辑输入 | 主机支持可编辑输入时可用 |

选择集成管线时配置较少；需要更换语言模型或开启对话视觉时，使用级联管线。两者都需要相应模型服务的凭据。

集成模式也可选择 OpenAI（`INTEGRATED_PROVIDER=openai`，默认 `gpt-realtime-2.1-mini`，需 `OPENAI_API_KEY`）或 Gemini Live（`INTEGRATED_PROVIDER=gemini`，默认 `gemini-3.8-live`，需 `GEMINI_API_KEY`），详见 [OpenAI 与 Gemini 服务商](global-providers.md)。StepFun（`INTEGRATED_PROVIDER=stepfun`，预览特性）需配置 `STEPFUN_API_KEY`；Qwen 模型可切换为 `qwen-audio-3.1-realtime-plus`（通过 `QWEN_REALTIME_MODEL`）。

## 级联语言模型

| 服务商 | 默认模型 | 对话视觉 | 凭据 |
|---|---|---|---|
| DeepSeek | `deepseek-flash` | 当前 Nova 适配器不开放 | `DEEPSEEK_API_KEY` |
| Qwen / 百炼 | `qwen-plus` | 默认模型不支持；可换用下列 Qwen 视觉模型 | `DASHSCOPE_API_KEY` |
| 火山方舟 Ark | `doubao-seed-2-0-pro-260215` | 支持 | `ARK_API_KEY` |
| OpenAI | `gpt-6-luna` | 当前 Nova 适配器不开放 | `OPENAI_API_KEY` |
| Gemini | `gemini-3.5-flash-lite` | 当前 Nova 适配器不开放 | `GEMINI_API_KEY` |
| 自托管（OpenAI 兼容端点） | 无默认值；需设置 `CASCADE_LLM_MODEL` | 当前 Nova 适配器不开放 | 可选 `SELF_HOSTED_LLM_API_KEY` |

可覆盖模型名称，但填写一个自定义名称不会自动获得图像能力。模型本身能否看图，与 Nova 是否已为它接通图像输入，是两件事。工具调用也需所选模型兼容当前适配器的结构化工具协议。

## 视觉模型

| 服务商 | Nova 当前识别的模型 |
|---|---|
| Qwen / 百炼 | `qwen3-vl-plus`、`qwen3-vl-flash`、`qwen-vl-max`、`qwen-vl-plus` |
| 火山方舟 Ark | `doubao-seed-2-0-pro-260215` |

对话视觉使用当前级联语言模型；Loop Camera 使用独立的监控模型连接。因此前台用纯音频模型或 DeepSeek 对话时，仍可由单独的视觉模型执行监控。未知模型不会自动降级到其他模型。

## 语音识别与合成

| 阶段 | 当前适配器 | 默认资源 / 音色 |
|---|---|---|
| 识别 ASR | 火山语音（默认）；Gemini（`CASCADE_ASR_PROVIDER=gemini`）；自托管流式 ASR（`self-hosted`） | `volc.seedasr.sauc.duration`；Gemini `gemini-3.5-flash` |
| 合成 TTS | 火山语音（默认）；Gemini（`CASCADE_TTS_PROVIDER=gemini`）；自托管 TTS（`self-hosted`） | `seed-tts-2.0` / `zh_female_vv_uranus_bigtts`；Gemini `gemini-3.8-flash-tts` / `Kore` |
| 集成语音音色 | Qwen 实时语音 | `longanqian` |

自托管阶段连接你自己运行的端点（`SELF_HOSTED_ASR_URL`、`SELF_HOSTED_LLM_BASE_URL`、`SELF_HOSTED_TTS_URL`），只使用各自专用的可选凭据；仓库提供了流式 Whisper ASR、vLLM LLM 和 Breeze TTS 的参考启动器。云端与自托管阶段可在同一条管线中混用。详见[自托管语音与预设](deployment/self-hosted-voice.md)。

使用火山语音时，ASR 优先使用 `DOUBAO_ASR_API_KEY`，未配置时使用 `DOUBAO_BIGMODEL_API_KEY`；TTS 使用后者。辅助模型与个人记忆可能仍需要百炼凭据，详见[核心配置](configuration.md)。

## 声纹校验

| 设置 | 行为 |
|---|---|
| 默认关闭 | 通过 `DOUBAO_ASR_VOICEPRINT_ENABLED` 开启 |
| 注册说话人 | `DOUBAO_ASR_VOICEPRINT_ID` 与 `DOUBAO_ASR_VOICEPRINT_NAME` 标识已注册的声纹 |
| 健康检查兜底 | 当 `DOUBAO_ASR_VOICEPRINT_HEALTH_URL` 不可达时，校验会自动关闭（失败即放行） |

实现依据：[voiceprint](../../clients/desktop/src/main/voiceprint.mjs)。

## 连接器

| 连接器 | 权限 | 平台 |
|---|---|---|
| Google（Gmail、Calendar） | 只读，经 Composio | 跨平台 |
| macOS 日历 | 只读 | 仅 macOS |
| Apple Mail | 只读 | 仅 macOS |
| 飞书 Feishu | 只读 | 跨平台 |

配置与授权范围详见[信息来源与连接器](sources-and-connectors.md)。

实现依据：[默认配置](../../runtime/src/config/config.ts)、[级联适配器选择](../../runtime/src/config/cascaded-realtime-config.ts)、[视觉模型白名单](../../runtime/src/model/vision-capability.ts)。
