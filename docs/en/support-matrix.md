# Support matrix

This matrix follows the adapters and capability allowlists in the current code. “Supported” means integrated; it does not certify every model, device and platform combination through real-device acceptance.

## Voice pipelines

| Capability | Integrated | Cascaded |
|---|---|---|
| Processing | One realtime model handles speech directly | Speech recognition → language model → speech synthesis |
| Default combination | Qwen `qwen-audio-3.0-realtime-plus` | Volcengine ASR → DeepSeek `deepseek-flash` → Volcengine TTS |
| Speech interruption | Integrated | Integrated |
| Coding, search and memory tools | Available according to enabled capabilities | Available according to enabled capabilities |
| Camera frames in conversation | Not supported | Listed vision models only; off by default |
| Independent Loop Camera monitoring | Supported with a separate vision model | Supported with a separate vision model |
| iPhone text input | No editable input | Available when the host supports editable input |

Integrated mode needs fewer settings. Use cascaded mode to change the language model or enable conversation vision. Both require credentials for the selected services.

Integrated mode can also use OpenAI (`INTEGRATED_PROVIDER=openai`, default `gpt-realtime-2.1-mini`, `OPENAI_API_KEY`) or Gemini Live (`INTEGRATED_PROVIDER=gemini`, default `gemini-3.8-live`, `GEMINI_API_KEY`); see [OpenAI and Gemini providers](global-providers.md). StepFun (`INTEGRATED_PROVIDER=stepfun`, preview) uses `STEPFUN_API_KEY`, and the Qwen model can be switched to `qwen-audio-3.1-realtime-plus` (`QWEN_REALTIME_MODEL`).

## Cascaded language models

| Provider | Default model | Conversation vision | Credential |
|---|---|---|---|
| DeepSeek | `deepseek-flash` | Not exposed by the current Nova adapter | `DEEPSEEK_API_KEY` |
| Qwen / DashScope | `qwen-plus` | Not on the default model; select a listed Qwen vision model | `DASHSCOPE_API_KEY` |
| Volcengine Ark | `doubao-seed-2-0-pro-260215` | Supported | `ARK_API_KEY` |
| OpenAI | `gpt-6-luna` | Not exposed by the current Nova adapter | `OPENAI_API_KEY` |
| Gemini | `gemini-3.5-flash-lite` | Not exposed by the current Nova adapter | `GEMINI_API_KEY` |
| Self-hosted (OpenAI-compatible endpoint) | None; set `CASCADE_LLM_MODEL` | Not exposed by the current Nova adapter | Optional `SELF_HOSTED_LLM_API_KEY` |

A model-name override does not grant image capability. A model supporting images is separate from Nova having a verified image-input adapter for it. Tool use also requires compatibility with the adapter's structured tool protocol.

## Vision models

| Provider | Models recognized by Nova |
|---|---|
| Qwen / DashScope | `qwen3-vl-plus`, `qwen3-vl-flash`, `qwen-vl-max`, `qwen-vl-plus` |
| Volcengine Ark | `doubao-seed-2-0-pro-260215` |

Conversation vision uses the selected cascaded language model. Loop Camera uses a separate monitor-model connection, so an audio-only or DeepSeek foreground conversation can still delegate monitoring to a vision model. Unknown models do not silently fall back to another model.

## Speech recognition and synthesis

| Stage | Current adapter | Default resource / voice |
|---|---|---|
| ASR | Volcengine Speech (default); Gemini (`CASCADE_ASR_PROVIDER=gemini`); self-hosted streaming ASR (`self-hosted`) | `volc.seedasr.sauc.duration`; Gemini `gemini-3.5-flash` |
| TTS | Volcengine Speech (default); Gemini (`CASCADE_TTS_PROVIDER=gemini`); self-hosted TTS (`self-hosted`) | `seed-tts-2.0` / `zh_female_vv_uranus_bigtts`; Gemini `gemini-3.8-flash-tts` / `Kore` |
| Integrated voice | Qwen realtime | `longanqian` |

Self-hosted stages talk to endpoints you run (`SELF_HOSTED_ASR_URL`, `SELF_HOSTED_LLM_BASE_URL`, `SELF_HOSTED_TTS_URL`) and use only their own optional credentials; the repository ships a reference launcher for a streaming Whisper ASR, a vLLM LLM and a Breeze TTS. Cloud and self-hosted stages can be mixed in one pipeline. See [self-hosted voice and presets](deployment/self-hosted-voice.md).

For Volcengine, ASR uses `DOUBAO_ASR_API_KEY` when present, otherwise `DOUBAO_BIGMODEL_API_KEY`. TTS uses the latter. Supporting models and personal memory may still require DashScope credentials; see [configuration](configuration.md).

## Voiceprint verification

| Setting | Behavior |
|---|---|
| Opt-in | Off by default; enable with `DOUBAO_ASR_VOICEPRINT_ENABLED` |
| Registered speaker | `DOUBAO_ASR_VOICEPRINT_ID` and `DOUBAO_ASR_VOICEPRINT_NAME` identify the enrolled voiceprint |
| Health fallback | Verification disables itself (fails open) when `DOUBAO_ASR_VOICEPRINT_HEALTH_URL` is unreachable |

Implementation: [voiceprint](../../clients/desktop/src/main/voiceprint.mjs).

## Connectors

| Connector | Access | Platform |
|---|---|---|
| Google (Gmail, Calendar) | Read, via Composio | Cross-platform |
| macOS Calendar | Read | macOS only |
| Apple Mail | Read | macOS only |
| Feishu | Read-only | Cross-platform |

See [sources and connectors](sources-and-connectors.md) for setup and scopes.

Implementation: [defaults](../../runtime/src/config/config.ts), [cascaded adapter selection](../../runtime/src/config/cascaded-realtime-config.ts), [vision allowlist](../../runtime/src/model/vision-capability.ts).
