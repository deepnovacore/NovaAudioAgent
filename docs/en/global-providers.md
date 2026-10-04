# OpenAI and Gemini providers

The desktop Settings → Voice pipeline panel supports OpenAI and Google Gemini for integrated voice and for the LLM stage of a cascaded pipeline. Existing pipeline defaults are unchanged. These additions do not replace the cascaded ASR/TTS stages or the separate embedding provider.

## Models and configuration

| Path | Provider | Default | Other desktop preset | Credential |
| --- | --- | --- | --- | --- |
| Integrated voice | OpenAI | `gpt-realtime-2.1-mini` | `gpt-realtime-2.1` | `OPENAI_API_KEY` |
| Integrated voice | Gemini | `gemini-3.8-live` | — | `GEMINI_API_KEY` |
| Cascaded LLM | OpenAI | `gpt-6-luna` | — | `OPENAI_API_KEY` |
| Cascaded LLM | Gemini | `gemini-3.5-flash-lite` | `gemini-3.8-flash` | `GEMINI_API_KEY` |

Set `PIPELINE_MODE=integrated` and `INTEGRATED_PROVIDER=openai` or `gemini`. Optional overrides are `OPENAI_REALTIME_MODEL`, `OPENAI_REALTIME_VOICE` (default `marin`), `GEMINI_REALTIME_MODEL`, and `GEMINI_REALTIME_VOICE` (default `Kore`). Endpoint overrides must use WSS. For cascaded mode, set `CASCADE_LLM_PROVIDER=openai` or `gemini`; `CASCADE_LLM_MODEL` overrides its default. Speech still needs the selected ASR/TTS credentials.

Keys are vendor-specific. Selecting either provider never falls back to a DashScope or generic model key for the conversation. Separate support models follow the selected provider unless an explicit generic model connection is configured. Memory embeddings, external search and executors retain their own credentials; a global voice key does not grant those capabilities.

Desktop settings store keys through the existing secret store. Usage totals accept both providers; costs remain unknown until a verified pricing profile exists. They are not estimated with Chinese-provider prices.

## Protocol design

The host `RealtimeProvider` contract remains the boundary for epochs, tool authority, context delivery and canonical PCM16 mono audio (16 kHz input, 24 kHz output).

* OpenAI uses a GA wire profile over the existing acknowledged-item adapter. It translates nested audio settings, output event names and cancellation codes, resamples input to 24 kHz, and uses the actual audio item/content index for playback truncation. Unknown playback duration is conservatively truncated to zero; it is not treated as a measured playback position.
* Gemini uses its native Live adapter and binary-JSON-capable WebSocket transport. Setup must be acknowledged. Host facts are staged locally; their synthetic IDs mean local ownership, not server item acknowledgment. Native tool responses retain call ID, function name and owning socket. Cancellation or replacement fences pending events from the old socket.
* Gemini system guidance and workspace changes require fresh setup. `responseAdaptationMode=session_setup` excludes rolling source-reference catalogs and delivery-recovery guidance from continuous microphone updates, preventing those updates from cancelling live replies. Current user requests and tool arguments remain host-validated. Earlier-turn source references are less expressive than with a provider supporting mutable guidance.
* Gemini does not claim seamless session resumption, server-side deletion of individual items, or partial-audio truncation. Context rebuilds retain bounded conversation pairs confirmed as fully spoken; unheard partial answers are not replayed. A real workspace/preference change may interrupt the current answer. Transport expiry/disconnection is surfaced to the host.
* Cascaded adapters share the streaming Chat Completions transport with explicit request profiles. GPT-6 Luna uses `reasoning_effort=none` for tool calling on this endpoint. Gemini retains opaque tool thought signatures through result replay and omits vendor-specific Qwen/DeepSeek options.

Adding another compatible provider requires configuration/credential routing, a request or wire profile, factory registration, desktop choices and contract tests. A native protocol with different turn/context semantics should implement `RealtimeProvider` rather than pretend to be OpenAI-compatible. No dynamic plugin framework is needed for these providers.

## Why this first tier

OpenAI provides a close fit to the existing acknowledged-item realtime transport and a low-latency cascaded option. Gemini adds an independent native voice implementation and Flash-family cost/latency options. Model names and documented API capabilities are selection criteria, not measured quality claims. xAI and new standalone ASR/TTS adapters are deferred to keep the first integration bounded. Compare real conversational latency, barge-in, Chinese/English speech and tool accuracy before changing defaults.

## Validation

Deterministic tests exercise configuration and credential isolation, GA event normalization, PCM resampling, playback truncation, binary JSON transport, Gemini setup/refresh/event fencing, tool thought-signature replay, settings persistence and usage projection. Live acceptance is separate: account access, billing, region, microphone echo cancellation and perceived audio quality cannot be established by these tests.

Official references checked during implementation (2026-10-04): [OpenAI Realtime](https://developers.openai.com/api/docs/guides/realtime), [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations), [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [Gemini Live API](https://ai.google.dev/api/live), [Gemini Live capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities), [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai), [thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures).
