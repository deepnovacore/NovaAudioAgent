# OpenAI 与 Gemini 接入

桌面「设置 → 语音管线」支持选择 OpenAI 和 Google Gemini，分别用于集成语音或级联管线的 LLM 环节。现有默认选择保持不变；本轮没有新增 ASR、TTS 或 embedding 提供方。

| 管线 | 提供方 | 默认模型 | 其他预设 | 密钥 |
| --- | --- | --- | --- | --- |
| 集成语音 | OpenAI | `gpt-realtime-2.1-mini` | `gpt-realtime-2.1` | `OPENAI_API_KEY` |
| 集成语音 | Gemini | `gemini-3.8-live` | — | `GEMINI_API_KEY` |
| 级联 LLM | OpenAI | `gpt-6-luna` | — | `OPENAI_API_KEY` |
| 级联 LLM | Gemini | `gemini-3.5-flash-lite` | `gemini-3.8-flash` | `GEMINI_API_KEY` |

集成模式设置 `PIPELINE_MODE=integrated`、`INTEGRATED_PROVIDER=openai` 或 `gemini`。可用 `OPENAI_REALTIME_MODEL`、`OPENAI_REALTIME_VOICE`、`GEMINI_REALTIME_MODEL`、`GEMINI_REALTIME_VOICE` 覆盖模型及音色，默认音色分别为 `marin` 和 `Kore`。自定义实时地址必须使用 WSS。

级联模式设置 `PIPELINE_MODE=cascaded`、`CASCADE_LLM_PROVIDER=openai` 或 `gemini`，`CASCADE_LLM_MODEL` 可覆盖默认模型。ASR/TTS 仍使用原来选择的语音服务及其凭据。

两家对话密钥严格独立，不会回退到 DashScope 或通用模型密钥。辅助模型默认跟随已选提供方，显式配置的通用模型连接优先。记忆 embedding、外部搜索及执行器仍有各自的凭据要求。用量会计入桌面统计，尚无核实的计价规则时显示费用未知，不套用其他厂商价格。

## 协议评估

现有 `RealtimeProvider` 边界可以继续复用，宿主仍负责会话代次、执行授权、上下文交付及播放。音频保持 PCM16 单声道，输入 16 kHz、输出 24 kHz。

OpenAI 通过 GA 协议 profile 复用已有确认式适配器，转换会话配置、事件名及输入采样率。取消错误按厂商边界内的结构化错误码分类，不再改写成 Qwen 文案；仅旧 Qwen/StepFun 边界保留其历史文案兼容。打断时根据真实音频 item 和已播放毫秒数截断服务端内容；播放位置未知时保守地截断到零，这可能丢失已听到的前缀。

Gemini 使用独立的原生 Live 适配器，支持二进制 JSON 帧，等待 setup 确认。主机事实先在本地暂存，交付回执明确标记 `delivery=staged`，本地 ID 不代表服务端逐条确认。工具调用通过 `response_yielded` 交出当前生成段，宿主只允许对应批次续接，不把它计作整轮完成。工具结果按完整批次回传原始 call ID 和函数名，委派确认也走原生 `toolResponse`。旧连接的工具结果明确拒绝，不降级成用户消息。部分工具取消会请求宿主重连，使整个旧批次失效。重连、取消会阻止旧工具事件继续生效。

Gemini 的系统上下文不能按同样方式原地更新，因此用新 setup 替换工作区及偏好。`responseAdaptationMode=session_setup` 显式排除滚动的原话引用目录和交付恢复提示，避免每次麦克风输入都触发重连。多轮旧需求引用不如可动态更新上下文的提供方完整。

本轮不宣称 Gemini 支持无缝恢复、逐条服务端删除或部分音频截断。重建只回放能证明问答归属且确认完整播出的有限历史；真正的工作区或偏好变更可能中断当前回答。若已发送的请求尚未被宿主观察到开始，setup 替换会明确请求宿主重连、更新会话代次，不伪造响应开始事件。尚未发送的普通主机事实仍保留在本地暂存中。这些限制不能通过伪造确认事件来掩盖。

Gemini 输入转录只在 `inputTranscription.finished=true` 时结束，不从模型输出或 `turnComplete` 推断，不合成语音起止事件。独立转录不会制造“尚欠一个响应”的等待状态。原生音频没有可用于绑定响应的输入 ID，响应来源明确为 `unknown`；这类工具调用返回原生拒绝，不执行宿主动作。需要语音派单、搜索等工具能力时请选择 Gemini **级联管线**。当前适配器只为未发送过麦克风音频的文本会话放行原生工具调用；接收音频后须建立新的纯文本会话才能恢复该能力。若服务未发送转录结束标记，保持未完成转录，不使用定时器凑出 final。

级联 LLM 复用流式 Chat Completions 传输，但请求参数按厂商区分。OpenAI 的 GPT-6 Luna 在该端点使用 `reasoning_effort=none` 调用工具；Gemini 工具结果往返保留不透明的 thought signature。

## 扩展与选型

共享传输类型位于 `realtime/transport.ts`；共享级联实现位于 `cascaded/chat-completions-llm.ts`，原 Qwen 导出只保留兼容入口。

扩展一个兼容提供方主要涉及配置和密钥路由、协议 profile、工厂注册、桌面选项及契约测试。原生实时协议的轮次或上下文语义不同，应单独实现适配器。当前规模不需要引入动态插件框架。

本轮优先接入 OpenAI，原因是其确认式实时协议与现有实现接近；Gemini 则提供独立的原生语音协议及 Flash 系列级联选择。xAI 和独立海外 ASR/TTS 留到后续。上述选择依据文档能力和接入成本，不等同于已经测得的音质、延迟或性价比排名。

自动测试覆盖协议、配置、打断、旧事件隔离及设置持久化。账户地区、余额、模型权限、真实麦克风、回声消除和听感需要另行实测。官方文档来源及详细技术说明见[英文版](../en/global-providers.md)。
