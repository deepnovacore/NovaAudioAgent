# Getting Started

## Current release boundary

Python is still the default and executable source oracle during this rollback release. The Node
runtime is an opt-in development backend; the source-development backend switch is not an
installed-app fallback. HA/AutoGLM are retired in Node and remain only in the temporary Python
source rollback. A nonempty legacy HA or AutoGLM setting produces a stable, credential-safe
migration error before provider, process, device, or desktop construction.

Node Codex is app-server-only. JSONL is fixture-parser-only and has no Node process execution path.
Search, Camera, Watch, and Guard are always assembled and are not executor selector values.

## Install for source development

```bash
git clone --recurse-submodules \
  https://github.com/deepnovacore/NovaAudioAgent.git nova-audio-agent
cd nova-audio-agent
uv sync --dev
npm ci
cp .env.example .env
```

Python remains the default path:

```bash
uv run nova-audio-agent --help
uv run nova-audio-agent demo all
```

The repository-owned Node checks are offline and deterministic:

```bash
npm run build --workspace @nova-audio-agent/runtime
node runtime/dist/src/cli.js diagnose --json
node runtime/dist/src/cli.js demo all
node runtime/dist/src/cli.js scorecard fixture check
uv run python scripts/config_fixture_oracle.py check
uv run python scripts/product_fixture_oracle.py check
```

`diagnose` validates configuration only. It does not connect to a provider, spawn Codex, open a
camera or microphone, launch Chromium, or disclose credentials and paths. Product fixture updates
must be produced with the Python exporters' explicit `export` command; ordinary tests are read-only.

## Realtime providers and executors

Qwen is the default realtime provider. Volcengine is the alternative provider-neutral assembly;
both require their selected credentials for live use. The configured Node executor names are
`fast_sim`, `slow_sim`, and `codex`. Codex ordinary/live/project modes share the bounded app-server
transport. Camera file input accepts only an absolute host-validated path.

Live provider, microphone/speaker, camera, Codex login, WindowServer, Windows descendant cleanup,
clean-machine installer, signing, and publication checks are pending external evidence.
Unpublished packaged candidates select Node automatically and cannot select the source-only Python
rollback. Source development still defaults to Python until the Node-default release is published.

## Public environment reference

The following block is generated from `runtime/src/environment-contract.ts`. Host-private handshake
inputs and retired integration variables are intentionally excluded. The retired compatibility
families are `HA_*` and `AUTOGLM_*`; do not add credentials or endpoints for them to a Node setup.

<!-- BEGIN GENERATED ENV CONTRACT -->
| Variable | Owner | Required | Default | Description |
|---|---|---|---|---|
| `NOVA_AUDIO_AGENT_BACKEND` | `source_rollback` | No | python | Source-development backend switch during the rollback release. |
| `NOVA_AUDIO_AGENT_MODEL_BASE_URL` | `core` | No | DashScope compatible endpoint | FastBrain compatible API endpoint. |
| `NOVA_AUDIO_AGENT_MODEL_API_KEY` | `core` | When selected | None | FastBrain API credential; also a Qwen fallback. |
| `NOVA_AUDIO_AGENT_FAST_MODEL` | `core` | No | qwen3-vl-plus | FastBrain model. |
| `NOVA_AUDIO_AGENT_WATCH_MODEL` | `core` | No | fast model | Watch model override. |
| `NOVA_AUDIO_AGENT_SURROGATE_MODEL` | `core` | No | qwen-flash | Surrogate model. |
| `NOVA_AUDIO_AGENT_COMPRESSOR_MODEL` | `core` | No | qwen-flash | Memory compressor model. |
| `NOVA_AUDIO_AGENT_REALTIME_PROVIDER` | `core` | No | qwen | Realtime provider: qwen or volcengine. |
| `NOVA_AUDIO_AGENT_EXECUTOR` | `core` | No | fast_sim | Single executor selector for compatibility. |
| `NOVA_AUDIO_AGENT_EXECUTORS` | `core` | No | selected executor | Ordered executor list. |
| `NOVA_AUDIO_AGENT_PROACTIVITY_PRESET` | `core` | No | balanced | Proactivity preset. |
| `NOVA_AUDIO_AGENT_SUGGESTION_COOLDOWN` | `core` | No | preset | Suggestion cooldown override in seconds. |
| `NOVA_AUDIO_AGENT_FRESH_WINDOW` | `core` | No | preset | Fresh-context window override in seconds. |
| `DASHSCOPE_API_KEY` | `qwen` | When selected | None | Qwen realtime credential. |
| `NOVA_AUDIO_AGENT_QWEN_REALTIME_URL` | `qwen` | No | DashScope realtime endpoint | Qwen secure realtime endpoint. |
| `NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL` | `qwen` | No | qwen-audio-3.0-realtime-plus | Qwen realtime model. |
| `NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE` | `qwen` | No | longanqian | Qwen realtime voice. |
| `NOVA_AUDIO_AGENT_QWEN_CONTROLLED_GUARD_RECONNECT` | `qwen` | No | false | Allow controlled Guard reconnect. |
| `NOVA_AUDIO_AGENT_QWEN_GUARD_HISTORY_RECOVERY` | `qwen` | No | none | Guard history recovery mode. |
| `NOVA_AUDIO_AGENT_QWEN_GUARD_HISTORY_PAIRS` | `qwen` | No | 4 | Guard history pair count. |
| `ARK_API_KEY` | `volcengine` | When selected | None | Volcengine Ark credential. |
| `DOUBAO_ASR_API_KEY` | `volcengine` | No | Doubao big-model key | Volcengine ASR credential override. |
| `DOUBAO_BIGMODEL_API_KEY` | `volcengine` | When selected | None | Volcengine TTS and ASR fallback credential. |
| `NOVA_AUDIO_AGENT_VOLCENGINE_ARK_BASE_URL` | `volcengine` | No | Volcengine Ark endpoint | Volcengine Ark secure endpoint. |
| `NOVA_AUDIO_AGENT_VOLCENGINE_ARK_MODEL` | `volcengine` | No | doubao-seed-2-0-pro-260215 | Volcengine primary model. |
| `NOVA_AUDIO_AGENT_VOLCENGINE_ARK_SUPPORT_MODEL` | `volcengine` | No | primary model | Volcengine support model. |
| `NOVA_AUDIO_AGENT_DOUBAO_ASR_ENDPOINT` | `volcengine` | No | Doubao ASR endpoint | Doubao ASR secure endpoint. |
| `NOVA_AUDIO_AGENT_DOUBAO_ASR_RESOURCE_ID` | `volcengine` | No | volc.seedasr.sauc.duration | Doubao ASR resource ID. |
| `NOVA_AUDIO_AGENT_DOUBAO_ASR_CHUNK_MS` | `volcengine` | No | 200 | ASR input chunk duration. |
| `NOVA_AUDIO_AGENT_DOUBAO_TTS_ENDPOINT` | `volcengine` | No | Doubao TTS endpoint | Doubao TTS secure endpoint. |
| `NOVA_AUDIO_AGENT_DOUBAO_TTS_RESOURCE_ID` | `volcengine` | No | seed-tts-2.0 | Doubao TTS resource ID. |
| `NOVA_AUDIO_AGENT_DOUBAO_TTS_VOICE` | `volcengine` | No | zh_female_vv_uranus_bigtts | Doubao TTS voice. |
| `NOVA_AUDIO_AGENT_DOUBAO_TTS_OUTPUT_SAMPLE_RATE` | `volcengine` | No | 24000 | Doubao TTS output sample rate. |
| `NOVA_AUDIO_AGENT_VOLCENGINE_VAD_THRESHOLD` | `volcengine` | No | 0.5 | VAD speech threshold. |
| `NOVA_AUDIO_AGENT_VOLCENGINE_VAD_PRE_ROLL_MS` | `volcengine` | No | 260 | VAD pre-roll duration. |
| `NOVA_AUDIO_AGENT_VOLCENGINE_VAD_MIN_SPEECH_MS` | `volcengine` | No | 250 | VAD minimum speech duration. |
| `NOVA_AUDIO_AGENT_VOLCENGINE_VAD_SILENCE_END_MS` | `volcengine` | No | 560 | VAD silence endpoint duration. |
| `NOVA_AUDIO_AGENT_VOLCENGINE_VAD_SPEECH_PAD_MS` | `volcengine` | No | 30 | VAD speech padding. |
| `NOVA_AUDIO_AGENT_VOLCENGINE_VAD_MAX_UTTERANCE_MS` | `volcengine` | No | 15000 | VAD maximum utterance duration. |
| `NOVA_AUDIO_AGENT_CODEX_WORKSPACE` | `codex` | When selected | None | Host-approved Codex workspace. |
| `NOVA_AUDIO_AGENT_CODEX_BIN` | `codex` | No | codex | Host-approved Codex app-server binary. |
| `NOVA_AUDIO_AGENT_CODEX_API_KEY` | `codex` | No | Codex login | Optional Codex credential override. |
| `NOVA_AUDIO_AGENT_CODEX_PREWARM` | `codex` | No | true | Prewarm Codex app-server. |
| `NOVA_AUDIO_AGENT_CODEX_PROJECTS_ENABLED` | `codex` | No | false | Enable Codex projects. |
| `NOVA_AUDIO_AGENT_CODEX_MANAGED_ROOT` | `codex` | No | ~/NovaWorkspaces | Managed project root. |
| `NOVA_AUDIO_AGENT_CODEX_PROJECT_STATE_ROOT` | `codex` | No | ~/.nova-audio-agent | Project state root. |
| `NOVA_AUDIO_AGENT_CODEX_WORKING_INTERVAL` | `codex` | No | 30 | Codex progress interval in seconds. |
| `TAVILY_API_KEY` | `search` | When selected | None | Tavily search credential. |
| `NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE` | `camera` | No | None | Absolute deterministic desktop video input. |
| `NOVA_AUDIO_AGENT_REALTIME_TELEMETRY` | `telemetry` | No | None | Source-runtime telemetry output path. |
| `NOVA_AUDIO_AGENT_REALTIME_TRACE` | `telemetry` | No | 0 | Enable source-runtime trace records. |
| `NOVA_ORB_OPAQUE` | `core` | No | 0 | Use an opaque desktop orb window. |
<!-- END GENERATED ENV CONTRACT -->
