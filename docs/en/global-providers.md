# OpenAI and Gemini providers

The desktop Settings → Voice pipeline panel supports OpenAI and Google Gemini for integrated voice and for the LLM stage of a cascaded pipeline. Existing pipeline defaults are unchanged. Gemini can also supply the ASR and TTS stages; the embedding provider remains separate.

## Models and configuration

| Path | Provider | Default | Other desktop preset | Credential |
| --- | --- | --- | --- | --- |
| Integrated voice | OpenAI | `gpt-realtime-2.1-mini` | `gpt-realtime-2.1` | `OPENAI_API_KEY` |
| Integrated voice | Gemini | `gemini-3.8-live` | — | `GEMINI_API_KEY` |
| Cascaded LLM | OpenAI | `gpt-6-luna` | — | `OPENAI_API_KEY` |
| Cascaded LLM | Gemini | `gemini-3.5-flash-lite` | `gemini-3.8-flash` | `GEMINI_API_KEY` |

Set `PIPELINE_MODE=integrated` and `INTEGRATED_PROVIDER=openai` or `gemini`. Optional overrides are `OPENAI_REALTIME_MODEL`, `OPENAI_REALTIME_VOICE` (default `marin`), `GEMINI_REALTIME_MODEL`, and `GEMINI_REALTIME_VOICE` (default `Kore`). Endpoint overrides must use WSS. For cascaded mode, set `CASCADE_LLM_PROVIDER=openai` or `gemini`; `CASCADE_LLM_MODEL` overrides its default. Speech needs the credentials for each selected ASR/TTS stage. Set `CASCADE_ASR_PROVIDER=gemini` and `CASCADE_TTS_PROVIDER=gemini` to use `GEMINI_API_KEY` for both; mixed-provider pipelines remain supported.

Keys are vendor-specific. Selecting either provider never falls back to a DashScope or generic model key for the conversation. Separate support models follow the selected provider unless an explicit generic model connection is configured. Memory embeddings, external search and executors retain their own credentials; a global voice key does not grant those capabilities.

Desktop settings store keys through the existing secret store. Usage totals accept both providers; costs remain unknown until a verified pricing profile exists. They are not estimated with Chinese-provider prices.

## Protocol design

The host `RealtimeProvider` contract remains the boundary for epochs, tool authority, context delivery and canonical PCM16 mono audio (16 kHz input, 24 kHz output).

* OpenAI uses a GA wire profile over the existing acknowledged-item adapter. It translates nested audio settings, output event names, classifies structured cancellation codes at the vendor boundary, resamples input to 24 kHz, and uses the actual audio item/content index for playback truncation. Unknown playback duration is conservatively truncated to zero; it is not treated as a measured playback position.
* Gemini uses its native Live adapter and binary-JSON-capable WebSocket transport. Setup must be acknowledged. Host facts carry an explicit `delivery=staged` receipt; their synthetic IDs mean local ownership, not server item acknowledgment. Native tool responses retain call ID, function name and owning socket. `response_yielded` ends a generation segment while reserving the provider for that tool batch, without claiming turn completion. All results, including delegation acknowledgements, are sent together through `toolResponse`. Stale results are rejected before sending; they never become user messages. A partial batch cancellation requests a host reconnect, which invalidates the entire old batch. Cancellation or replacement fences pending events from the old socket.
* Gemini system guidance and workspace changes require fresh setup. `responseAdaptationMode=session_setup` excludes rolling source-reference catalogs and delivery-recovery guidance from continuous microphone updates, preventing those updates from cancelling live replies. Earlier-turn source references are less expressive than with a provider supporting mutable guidance.
* Gemini does not claim seamless session resumption, server-side deletion of individual items, or partial-audio truncation. Context rebuilds retain only bounded pairs with proven input ownership and full playback; unheard partial answers are not replayed. A real workspace/preference change may interrupt the current answer. If a sent response has not yet reached the host when setup is replaced, an explicit recoverable error requests a host epoch reset; no response-start event is fabricated. Locally staged non-tool facts survive setup replacement. Transport expiry/disconnection is surfaced to the host.
* Input transcription is finalized only by `inputTranscription.finished`; neither model output nor `turnComplete` implies input completion. No speech boundaries are synthesized. Independent late transcripts do not create a pending response debt. Audio responses have explicit `unknown` input ownership, so their tools receive a native refusal rather than host execution. Use the Gemini **cascaded pipeline** for voice-triggered tools. This adapter admits native tools only on text-only connections; after sending microphone audio, establish a fresh text-only connection to restore that capability. Missing transcription completion stays unfinished, without timeout-based fabricated finals.
* Cascaded adapters share the streaming Chat Completions transport with explicit request profiles. GPT-6 Luna uses `reasoning_effort=none` for tool calling on this endpoint. Gemini retains opaque tool thought signatures through result replay and omits vendor-specific Qwen/DeepSeek options.

Shared socket types live in `realtime/transport.ts`; the shared LLM implementation lives in `cascaded/chat-completions-llm.ts`. Existing Qwen exports remain compatibility entry points.

Adding another compatible provider requires configuration/credential routing, a request or wire profile, factory registration, desktop choices and contract tests. A native protocol with different turn/context semantics should implement `RealtimeProvider` rather than pretend to be OpenAI-compatible. No dynamic plugin framework is needed for these providers.

## Why this first tier

OpenAI provides a close fit to the existing acknowledged-item realtime transport and a low-latency cascaded option. Gemini adds an independent native voice implementation and Flash-family cost/latency options. Model names and documented API capabilities are selection criteria, not measured quality claims. xAI adapters are deferred to keep the first integration bounded. Compare real conversational latency, barge-in, Chinese/English speech and tool accuracy before changing defaults.

## Validation

Deterministic tests exercise configuration and credential isolation, GA event normalization, PCM resampling, playback truncation, binary JSON transport, Gemini setup/refresh/event fencing, tool thought-signature replay, settings persistence and usage projection. Live acceptance is separate: account access, billing, region, microphone echo cancellation and perceived audio quality cannot be established by these tests.

Official references checked during implementation (2026-10-04): [OpenAI Realtime](https://developers.openai.com/api/docs/guides/realtime), [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations), [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [Gemini Live API](https://ai.google.dev/api/live), [input transcription completion](https://googleapis.github.io/js-genai/release_docs/interfaces/types.Transcription.html), [Gemini Live capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities), [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai), [thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures).

## Gemini cascaded speech

Gemini ASR buffers one locally endpointed utterance (PCM16 mono, 16 kHz, up to 60 seconds plus bounded endpointing padding), then requests final transcription with `GEMINI_ASR_MODEL` (default `gemini-3.5-flash`). It does not emit partial transcripts or support Volcengine voiceprints. Dictation uses the same selected ASR stage.

Gemini TTS synthesizes the speech segments supplied by the host in order with `GEMINI_TTS_MODEL` (default `gemini-3.8-flash-tts`) and `GEMINI_TTS_VOICE` (default `Kore`). WAV/PCM output is validated and converted to the host's PCM16 mono 24 kHz contract. The first synthesized segment is emitted before the whole response finishes; each segment still waits for one complete generateContent response, so this is not token-streaming TTS. Synthesis is sequential and applies backpressure to LLM text consumption, so longer replies may have gaps between segments. Cancellation aborts pending requests and fences late results. Provider errors are redacted; metering uses Gemini ASR/TTS service categories without inventing prices.

The desktop ASR/TTS selectors expose Gemini independently, with separate model and voice settings. Existing defaults and Volcengine voice settings are preserved. An all-Gemini pipeline requires only `GEMINI_API_KEY` for conversation stages, though separately enabled tools or memory may need other credentials.
