# Extensible Audio Pipelines Design

**Date:** 2026-08-22

**Status:** Approved in chat; awaiting review of this written specification

## Goal

Replace the current vendor-shaped realtime selection with two product-level pipeline modes:

- an integrated realtime model, configured as one provider; and
- a cascaded pipeline whose endpointing, ASR, LLM, and TTS nodes are configured independently.

The first cascaded default is Volcengine ASR, Qwen `qwen-flash`, and Volcengine TTS. Ark remains an explicit cascaded LLM choice. The design must make another provider for any node an additive adapter and registry change rather than a new copy of the whole realtime assembly.

## Scope

This change covers the Node and TypeScript production runtime in `runtime/` and the Electron Settings Panel in `desktop/ambient-orb/`. It includes configuration, provider selection, provider-neutral cascaded contracts, Qwen and Ark cascaded LLM adapters, secure key storage and backend environment injection, documentation, and automated tests.

The Python reference runtime is not extended. Compatibility with `NOVA_AUDIO_AGENT_REALTIME_PROVIDER` is not retained. The retired variable must produce a focused configuration error instead of being silently ignored.

The first release supports these concrete providers:

| Capability | Provider values |
| --- | --- |
| Integrated realtime | `qwen` |
| Cascaded endpointing | `auto` |
| Cascaded ASR | `volcengine` |
| Cascaded LLM | `qwen`, `ark` |
| Cascaded TTS | `volcengine` |

The registries and interfaces are extensible, but arbitrary graph editing, third-party runtime plugin loading, and a JSON pipeline DSL are outside this scope.

## Product Model

`pipeline_mode` is the only top-level shape decision:

```text
pipeline_mode
├── integrated
│   └── integrated_provider
└── cascaded
    ├── endpointing_provider
    ├── asr_provider
    ├── llm_provider + llm_model
    └── tts_provider
```

Integrated mode configures one end-to-end realtime provider. It does not expose ASR, LLM, or TTS subnodes. Cascaded mode exposes each node. Provider credentials are stored once per platform and reused by every selected node on that platform; there are no per-node duplicate key fields.

## Runtime Architecture

### Production selection

`buildProductionRealtimeAssembly` selects a builder from `pipeline_mode`:

- `integrated` calls the integrated assembly and resolves an `IntegratedProviderFactory` from the integrated provider registry.
- `cascaded` calls the cascaded assembly and resolves endpointing, ASR, LLM, and TTS factories from capability-specific registries.

The registries are closed, typed `Readonly<Record<ProviderName, Factory>>` values owned by the host. Renderer input and model output cannot register factories. A registry lookup constructs exactly the selected provider and never probes, constructs, or fails over to an unselected provider.

### Provider-neutral cascaded owner

The current `VolcengineCascadedAdapter` becomes a provider-neutral `CascadedRealtimeAdapter`. The current lazy `VolcengineRealtimeProvider` becomes a provider-neutral owner that constructs one complete cascaded epoch. Provider-specific endpointing, ASR, LLM, and TTS resources are supplied through factories.

The cascaded owner continues to implement the existing `RealtimeProvider` contract, so `RealtimeProviderSession`, `RealtimeSession`, playback arbitration, tool authorization, project confirmation, and Codex ownership do not change.

The provider-neutral owner is responsible for:

- session epochs and connection lifecycle;
- endpointing and ASR input flow;
- user transcript events;
- LLM response lifecycle and cancellation;
- the text-or-tool-call response invariant;
- TTS prewarming, chunking, retry, cancellation, and audio events;
- tool-call/result continuation;
- bounded event queues and cleanup ordering; and
- provider-neutral telemetry and stable failures.

It must not construct provider wire payloads, retain provider credentials, or know Ark or Qwen endpoint details.

### Node contracts

Endpointing, ASR, and TTS use the behavioral contracts already proven by the current cascaded implementation, moved out of the Volcengine namespace where necessary. Provider implementations remain free to use vendor-specific clients internally.

The cascaded LLM boundary is a new semantic contract. A `CascadedLlmSession` accepts typed inputs rather than Ark Responses JSON:

- user text;
- trusted host context such as progress, final results, recovery summaries, and packed history;
- tool results identified by `call_id`; and
- the current host-owned tool declarations.

It emits a common event sequence:

- `response_started` with a stable response identity;
- zero or more `text_delta` events, or one assembled `tool_call` event;
- `response_completed`; or
- `response_failed` with a stable classification.

`text_delta` and `tool_call` are mutually exclusive within one response. The session owns provider-specific continuation state. The cascaded owner never receives `previous_response_id`, Chat Completions messages, or provider SSE frames.

### Ark LLM adapter

The existing Ark Responses transport implements `CascadedLlmSession` through an Ark adapter. It maps semantic inputs and common tool declarations to the Responses API, keeps `previous_response_id` private, and maps Ark events back to the common LLM event contract.

The current request, event, size, timeout, cancellation, and response-body redaction limits remain in force. Ark-specific tool-schema conversion moves behind this adapter.

### Qwen LLM adapter

The Qwen adapter uses DashScope's OpenAI-compatible Chat Completions endpoint and defaults to `qwen-flash`. It owns the conversion between semantic cascaded inputs and Chat Completions messages, including assistant tool calls and matching tool-result messages.

The adapter assembles fragmented streaming tool names and arguments before emitting one common `tool_call`. It rejects invalid JSON arguments, unknown or mismatched call identities, mixed text/tool output, missing response identity, and streams without a terminal event using stable credential-safe classifications.

Qwen continuation is client-owned. History is retained in completed interaction units so an assistant tool call is never separated from its result. Before each request, the adapter removes the oldest completed units until both limits hold:

- no more than 64 retained message items; and
- no more than 131,072 Unicode code points of retained text and tool arguments.

The current input and an unresolved tool-call chain are never removed to meet a limit. If those alone exceed an existing per-item safety limit, the request fails instead of sending an unbounded payload.

### Support model ports

The realtime frontbrain is provided by the integrated provider or the cascaded LLM node. Existing Surrogate, Compressor, Watch, and Guard model ports continue to use `OpenAIModelGateway`.

`NOVA_AUDIO_AGENT_MODEL_API_KEY` and `NOVA_AUDIO_AGENT_MODEL_BASE_URL` remain advanced overrides for those support ports only. When the generic model key is absent, support ports reuse the active LLM platform credential and compatible endpoint:

- DashScope for integrated Qwen or cascaded Qwen; and
- Ark for cascaded Ark.

Support model defaults remain provider-compatible. In a cascaded configuration without a generic model override, the selected cascaded LLM model is also the default Surrogate and Compressor model. Watch retains its explicit override when configured; otherwise it defaults to `qwen3-vl-plus` on DashScope and to the selected cascaded model on Ark.

## Configuration Contract

### Pipeline selection

The new public environment variables are:

| Variable | Default | Allowed values | Purpose |
| --- | --- | --- | --- |
| `NOVA_AUDIO_AGENT_PIPELINE_MODE` | `integrated` | `integrated`, `cascaded` | Select the product-level pipeline shape. |
| `NOVA_AUDIO_AGENT_INTEGRATED_PROVIDER` | `qwen` | `qwen` | Select the end-to-end realtime provider. |
| `NOVA_AUDIO_AGENT_CASCADE_ENDPOINTING_PROVIDER` | `auto` | `auto` | Select cascaded endpointing. |
| `NOVA_AUDIO_AGENT_CASCADE_ASR_PROVIDER` | `volcengine` | `volcengine` | Select cascaded ASR. |
| `NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER` | `qwen` | `qwen`, `ark` | Select the cascaded LLM. |
| `NOVA_AUDIO_AGENT_CASCADE_LLM_MODEL` | provider default | non-empty string | Select the cascaded LLM model. |
| `NOVA_AUDIO_AGENT_CASCADE_TTS_PROVIDER` | `volcengine` | `volcengine` | Select cascaded TTS. |

The default cascaded model is provider-sensitive: `qwen-flash` for Qwen and `doubao-seed-2-0-pro-260215` for Ark. The resolver chooses that default only when `NOVA_AUDIO_AGENT_CASCADE_LLM_MODEL` is absent; any explicit non-empty model wins.

The existing Qwen realtime URL, model, voice, and controlled Guard settings remain under their Qwen names. Existing Volcengine ASR, TTS, VAD, resource, endpoint, chunk, sample-rate, and voice settings remain provider-specific advanced settings. `NOVA_AUDIO_AGENT_VOLCENGINE_ARK_MODEL` and `NOVA_AUDIO_AGENT_VOLCENGINE_ARK_SUPPORT_MODEL` are replaced by the common cascaded model setting and the existing generic support-model overrides.

`NOVA_AUDIO_AGENT_REALTIME_PROVIDER` is retired. A nonblank value raises `ConfigurationError` with code `retired_configuration` and names only the retired field.

### Credential resolution

Credentials are resolved only after the complete pipeline selection is validated and only for selected providers:

| Selected use | Credential resolution |
| --- | --- |
| Integrated Qwen | `DASHSCOPE_API_KEY` |
| Cascaded Qwen LLM | `DASHSCOPE_API_KEY` |
| Cascaded Ark LLM | `ARK_API_KEY` |
| Volcengine TTS | `DOUBAO_BIGMODEL_API_KEY` |
| Volcengine ASR | `DOUBAO_ASR_API_KEY`, then `DOUBAO_BIGMODEL_API_KEY` |
| Support model ports | `NOVA_AUDIO_AGENT_MODEL_API_KEY`; otherwise active LLM platform key |

The configuration layer returns separate immutable integrated, endpointing, ASR, LLM, and TTS config values. The generic cascaded owner is never passed unused credentials. Validation errors name fields, not submitted values.

## Settings Panel

### Stored schema

The settings file advances to version 2 and gains non-secret fields for:

- `pipelineMode`;
- `integratedProvider`;
- `integratedModel`;
- `integratedVoice`;
- `cascadedEndpointingProvider`;
- `cascadedAsrProvider`;
- `cascadedLlmProvider`;
- `cascadedLlmModels`, a strict map with one remembered model value for `qwen` and one for `ark`;
- `cascadedTtsProvider`; and
- `cascadedTtsVoice`.

Integrated and cascaded TTS voices are stored separately because their provider identifiers are not interchangeable. Model values are also remembered per cascaded LLM provider, so switching from a customized Qwen model to Ark and back does not overwrite either choice. Main injects only the active provider's remembered model into `NOVA_AUDIO_AGENT_CASCADE_LLM_MODEL`. Every model and voice string is independently bounded and rejects control characters.

The secret allowlist adds:

- `arkApiKey`;
- `doubaoBigmodelApiKey`; and
- `doubaoAsrApiKey`.

Existing `dashscopeApiKey`, `tavilyApiKey`, `modelApiKey`, and `codexApiKey` remain. `modelApiKey` is labelled as an advanced support-model override, not as a required LLM key.

Unknown fields are dropped. Invalid fields fall back independently. Secret values remain forward-only: Renderer sends plaintext to Main, Main seals it immediately through `safeStorage`, and Renderer receives presence booleans only.

### Conditional interface

The panel places a pipeline-mode control above provider configuration.

Integrated mode shows:

- integrated Provider;
- integrated realtime model; and
- integrated voice.

It does not render endpointing, ASR, LLM, or TTS subnode controls.

Cascaded mode shows one card each for:

- endpointing;
- ASR;
- LLM, including Provider and model; and
- TTS, including Provider and its cascaded voice.

The API key section keeps platform keys as single stored fields. Based on the current pipeline selection, each key is labelled `必需`, `可选覆盖`, or `当前未使用`. Switching providers never copies, clears, or overwrites a stored key. A previously stored key remains clearable when its provider is selected again.

All pipeline, provider, model, voice, and key changes display `下次启动生效`. Palette remains the only live-applied setting. Existing per-field rejection, queued writes, plaintext-keyring warning, and accepted-field clearing behavior remain unchanged.

### Backend launch mapping

The Electron Main process maps validated public settings to the new environment variables and decrypts allowlisted keys directly into their established platform environment variables. Empty, unreadable, oversized, or control-character-bearing secrets are omitted without overriding a valid parent environment value.

No key value enters bootstrap data, settings replies, renderer logs, diagnostics, or failure text.

## Validation and Failure Semantics

Configuration proceeds in this order:

1. reject retired configuration;
2. validate the top-level pipeline mode;
3. validate only the provider selectors and settings reachable in that mode;
4. resolve only the credentials required by those providers;
5. construct the support gateway and selected provider factories; and
6. defer network and native-resource acquisition to assembly start.

Unknown providers, missing credentials, empty model names, insecure endpoints, and invalid numeric relationships fail before a connection is opened. An unselected provider's missing key or malformed advanced setting does not block startup.

Provider failures never trigger automatic provider failover. Stable common failure classifications are emitted without provider response bodies, credentials, URLs containing queries, prompts, transcripts, or tool arguments. Diagnostics may include the pipeline mode, node capability, provider name, status integer, and bounded request identity.

Cancellation aborts the active LLM request and active TTS session. Session close revokes the epoch, terminates pending audio work, closes ASR, cancels and closes TTS, closes the LLM session, closes endpointing, and closes the event queue. Every close remains idempotent and bounded. Partial construction rolls back only resources created for that epoch, in reverse ownership order.

## Testing Strategy

Implementation follows test-driven development. Each behavior is first introduced by a failing Node test.

### Runtime tests

- Configuration tests cover both modes, all defaults and overrides, selected-only validation, credential fallback, immutable resolved configs, credential-safe errors, and retirement of `NOVA_AUDIO_AGENT_REALTIME_PROVIDER`.
- Registry and production assembly tests prove that exactly the selected factories are resolved and unselected providers are not constructed.
- A provider-neutral cascaded adapter suite covers transcript flow, streaming text, tool calls and results, TTS chunking, cancellation, event bounds, reconnect, close, and rollback using fake node ports.
- Qwen LLM tests pin Chat Completions request bodies, streaming text, fragmented tool calls, tool-result continuation, history-unit trimming, aborts, timeouts, limits, and redaction.
- Ark LLM tests run through the common contract while retaining the existing Responses API protocol and safety tests.
- Production composition tests cover the default Volcengine ASR, Qwen LLM, Volcengine TTS combination and the explicit Ark alternative.
- Documentation and environment-contract tests pin every public variable and prevent undocumented or stale configuration.

### Desktop tests

- Settings-store tests cover schema version 2, each new field, provider-specific remembered models and voices, independent invalid-field fallback, new secret fields, sealing, presence booleans, keyring migration, and concurrent writes.
- Panel contract tests cover the top-level mode control, conditional integrated and cascaded sections, provider/model persistence, key requirement labels, secret forward-only handling, and next-launch messaging.
- Backend launch tests cover every public setting and secret-to-environment mapping, parent-environment fallback, and exclusion of secrets from renderer-visible values.
- Existing Electron CSP, navigation, IPC ownership, and secret-rejection tests remain mandatory.

### Verification

The completion gate runs:

- focused red/green tests during each task;
- the complete runtime test suite;
- the complete desktop test suite;
- TypeScript type checking;
- ESLint;
- the runtime and desktop builds;
- the environment-contract check; and
- the Node parity audit, updated where the intentionally changed configuration surface requires it.

Live provider smoke tests remain opt-in because they require credentials and external services. They are documented for Qwen and Ark but are not required for the deterministic completion gate.

## Documentation Changes

Update `.env.example`, `README.md`, `README.zh-CN.md`, `docs/getting-started.md`, and `docs/getting-started.zh-CN.md` to describe the two pipeline modes, the first supported providers, default cascaded combination, provider-sensitive credentials, and Settings Panel behavior. Remove `NOVA_AUDIO_AGENT_REALTIME_PROVIDER` and the replaced Ark-model variables from current configuration tables.

## Acceptance Criteria

The feature is accepted when:

1. A default installation starts in integrated Qwen realtime mode.
2. Selecting cascaded mode without further provider edits resolves Volcengine ASR, Qwen `qwen-flash`, and Volcengine TTS.
3. Selecting Ark changes only the cascaded LLM node and its required credential.
4. Settings Panel exposes the product-level mode first and shows node configuration only for cascaded mode.
5. A platform key is stored once and reused by every selected node for that platform.
6. Unselected providers are neither validated nor constructed.
7. Qwen and Ark satisfy the same provider-neutral cascaded LLM contract, including tools and cancellation.
8. Existing realtime session, authorization, playback, Codex, CSP, IPC, and secret-redaction boundaries remain intact.
9. Deterministic tests, type checking, lint, builds, environment-contract checks, and the Node parity audit pass.
