# Core configuration

Environment names now omit the former `NOVA_AUDIO_AGENT_` prefix: for example, `PIPELINE_MODE` and `CODEX_WORKSPACE`. Rename existing `.env`, service and CI configuration keys before upgrading; old names are no longer read. Provider keys such as `DASHSCOPE_API_KEY` are unchanged. Desktop preferences override several non-secret values (including pipeline and language); these environment options also serve direct runtime launches.

Use desktop Settings to select models and enter credentials. When running from source, you can also edit the project `.env`; restart the desktop afterwards.

## Minimal setup

The default Qwen realtime pipeline needs one key:

```dotenv
DASHSCOPE_API_KEY=your-dashscope-key
```

Only the selected voice pipeline's keys are required. Search, camera watch, memory and knowledge turn off when their key is missing, and Settings and `novaaudio doctor` name the key each one needs. Search uses Tavily when `TAVILY_API_KEY` is set and Bailian MCP search otherwise. Desktop cascaded mode defaults to Volcengine recognition, DeepSeek and Volcengine synthesis, requiring `DOUBAO_BIGMODEL_API_KEY` and `DEEPSEEK_API_KEY`. Keep `DASHSCOPE_API_KEY` for supporting models such as personal-memory processing.

Direct runtime launches default to Qwen for the cascaded LLM. Set `CASCADE_LLM_PROVIDER=deepseek` explicitly to match the desktop default.

For Qwen Audio 3.1, select `qwen-audio-3.1-realtime-plus` and its matching `longanqian_v3.1` voice. StepAudio 3 is a preview integration awaiting live acceptance. To use it, select StepFun and provide `STEPFUN_API_KEY`; Step 3.7 Flash uses the same key for auxiliary chat and vision by default. Local memory embeddings still need a configured embedding service. To use a custom auxiliary gateway, set `MODEL_API_KEY` and `MODEL_BASE_URL`.

## Common options

Set only what you need to change. Keep credentials out of Git.

<!-- BEGIN GENERATED ENV CONTRACT -->
| Variable | Default | Purpose |
|---|---|---|
| `PIPELINE_MODE` | integrated | Product pipeline shape: integrated or cascaded. |
| `PROMPT_LANGUAGE` | zh-CN | AI system prompt language: zh-CN or en; desktop supplies its saved preference. |
| `INTEGRATED_PROVIDER` | qwen | Integrated realtime provider. |
| `CASCADE_LLM_PROVIDER` | deepseek | Cascaded LLM provider. |
| `CASCADE_LLM_MODEL` | provider default | Cascaded LLM model override. |
| `CODEX_APPROVAL_MODE` | ask | Coding approval mode for Codex and ACP backends; Pi refuses ask. |
| `CAPABILITIES_CONFIG` | ~/.nova-audio-agent/capabilities.json | Capabilities registry path. |
| `MEMORY_CONNECTION` | local | Memory connection: disabled, local, or remote. |
| `MEMORY_PROVIDER` | None | Local engine: voicemem (default; unified ledger) or explicit mem0. Remote engines are service-owned. |
| `DASHSCOPE_API_KEY` | None | Qwen realtime credential. |
| `QWEN_REALTIME_MODEL` | qwen-audio-3.0-realtime-plus | Qwen realtime model. |
| `QWEN_REALTIME_VOICE` | longanqian | Qwen realtime voice. |
| `OPENAI_API_KEY` | None | OpenAI API credential. |
| `GEMINI_API_KEY` | None | Gemini API credential. |
| `STEPFUN_API_KEY` | None | StepFun realtime credential. |
| `DEEPSEEK_API_KEY` | None | Official DeepSeek cascaded LLM credential. |
| `ARK_API_KEY` | None | Ark cascaded LLM credential. |
| `DOUBAO_ASR_API_KEY` | Doubao big-model key | Volcengine ASR credential override. |
| `DOUBAO_BIGMODEL_API_KEY` | None | Volcengine TTS and ASR fallback credential. |
| `CODEX_WORKSPACE` | None | Host-approved Codex workspace. |
| `CODEX_BIN` | codex | Host-approved Codex app-server binary. |
| `TAVILY_API_KEY` | None | Tavily search credential. |
<!-- END GENERATED ENV CONTRACT -->

`ask` retains permission prompts; `yolo` lets Codex execute without approval. Choose according to your trust requirements.

A few more variables round out less common setups. `COMPOSIO_API_KEY` authorizes the Google connector (Gmail and Calendar) through Composio. `OPENROUTER_API_KEY` feeds the Jev judgment model that scores personal-memory candidates (Todo, Idea, Goal, Profile) and ranks news relevance; both stay off without it. `DOUBAO_ASR_VOICEPRINT_ENABLED`, together with `DOUBAO_ASR_VOICEPRINT_ID`, `DOUBAO_ASR_VOICEPRINT_NAME` and `DOUBAO_ASR_VOICEPRINT_HEALTH_URL`, turns on opt-in speaker verification for ASR. `NEWS_LANGUAGE` sets the news feed's language independently of the UI language. `MEMORY_LEDGER_PATH` overrides where the unified memory ledger's SQLite file lives (default `~/.nova-audio-agent/workspace-graph.sqlite`).

Remove the local provider setting when disabling memory or selecting a remote service. See [personal memory](personal-memory.md) for remote settings and the [iPhone guide](iphone.md) for phone connections.

### Support model naming

`SUPPORT_MODEL` selects the shared auxiliary LLM used by Proactive communication, coding intake/cancel selection, task verification, personal-record extraction and personal content generation. It is model selection, not a catch-all runtime role. `GatewayProactivity`, `GatewayTaskVerifier` and `GatewayPersonalWriter` own separate responsibilities; understanding and news reuse their existing factories. Jev judgments, planning, compression and vision retain their existing routing.

Rename `SURROGATE_MODEL` to `SUPPORT_MODEL` in your environment. The old variable is no longer read and has no compatibility alias; if it is still set, startup prints `[config-warning] SURROGATE_MODEL is no longer read; rename it to SUPPORT_MODEL`. Only the new variable selects the model; existing provider-specific defaults and cascaded model/endpoint pairing remain unchanged.

TypeScript API change: `Settings.surrogate_model` becomes `support_model`; the broad `GatewaySurrogate` export is replaced by the three adapters above. Use `GatewayProactivity.select()` for the former `watch()` call; other operations belong to their new owners. This is not a wire/event migration or a switch to Jev. Existing serialized `surrogate` identifiers and model-visible prompts retain their historical spelling.

### Target resolution

`GatewayTargetResolver` separates workspace/session interpretation (`resolveIntake`) and running-work selection (`resolveWork`) from requirement extraction. `intakeModels` accepts an optional resolver as its fourth argument and exposes it as `models.targets`; cancellation composition calls that same resolver. Requirement extraction and target resolution use `SUPPORT_MODEL` with the same gateway. Planning keeps its existing model.

A normal assessment now makes two sequential calls under the existing shared assessment deadline: requirements, then targets. Abandonment skips target resolution. The host still validates user evidence, explicit session continuation, confirmations and stale results before any action. New workspace names and target clarification text are still generated by the LLM, so this boundary is not a drop-in Jev adapter. No additional model setting is introduced.

A target-validation retry currently reruns both stages; at most four model calls share the same two-attempt, 30-second assessment budget.

[Back to getting started](getting-started.md)

See [OpenAI and Gemini providers](../en/global-providers.md) for model presets, credential routing and protocol limitations.
