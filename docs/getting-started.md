# Getting Started

## Current release boundary

Node.js and TypeScript are the primary runtime. Codex is app-server-only; JSONL is
fixture-parser-only and has no production process execution path. Search, Camera, Watch, and Guard
are always assembled and are not executor selector values. Legacy HA and AutoGLM settings produce
a stable, credential-safe migration error before provider, process, device, or desktop
construction.

## Install for source development

Install Node.js 22+, npm, Git, and a logged-in `codex` executable. Native builds additionally
require one platform toolchain:

- macOS: Xcode Command Line Tools (`xcode-select --install`);
- Linux: a C compiler available at `/usr/bin/cc`;
- Windows: Visual Studio Build Tools with the **Desktop development with C++** workload.

```bash
git clone \
  https://github.com/deepnovacore/NovaAudioAgent.git nova-audio-agent
cd nova-audio-agent
npm ci
cp .env.example .env
```

For the default integrated Qwen path, set `TAVILY_API_KEY` and either `DASHSCOPE_API_KEY` or the
supported generic fallback in `.env`. The fallback is `NOVA_AUDIO_AGENT_MODEL_API_KEY`, and it is
accepted for Qwen realtime only with the exact base URL documented below. Search is always
assembled, so Tavily is required. The launcher parses `.env` as data without shell evaluation;
variables already set in the invoking shell take precedence.

Start the desktop client:

```bash
npm run start:client
```

For integrated-Qwen source startup, `DASHSCOPE_API_KEY` is the normal realtime credential.
`NOVA_AUDIO_AGENT_MODEL_API_KEY` can be used instead only when
`NOVA_AUDIO_AGENT_MODEL_BASE_URL` is exactly
`https://dashscope.aliyuncs.com/compatible-mode/v1`; a different base URL does not make the
generic key a Qwen realtime credential. When both credentials are set, `DASHSCOPE_API_KEY` takes
precedence.

## Unsigned Windows and Ubuntu development candidates

The GitHub Actions workflow **Unsigned Windows and Ubuntu packages** produces unsigned development
candidates, not signed releases. Download its `unsigned-win32-x64` or
`unsigned-linux-x64-gnu` workflow artifact and use the stable file names inside it:
`nova-win32-x64.exe`, `nova-linux-x64.AppImage`, and `nova-linux-x64.deb`. Verify that a download
came from the intended workflow run before using it.

Windows may show a SmartScreen warning for the unsigned `nova-win32-x64.exe`. Keep SmartScreen and
other Windows security protections enabled; verify the workflow run and file before deciding
whether to use the candidate. On Linux, make the AppImage executable and run it directly:

```bash
chmod u+x nova-linux-x64.AppImage
./nova-linux-x64.AppImage
```

Install `nova-linux-x64.deb` through the system package manager (on Ubuntu, for example,
`sudo apt install ./nova-linux-x64.deb`). The workflow records an individual candidate's build and
validation state; this guide does not claim native CI has passed.

The repository-owned Node checks are offline and deterministic:

```bash
npm run build --workspace @nova-audio-agent/runtime
node runtime/dist/src/cli.js diagnose --json
node runtime/dist/src/cli.js demo all
node runtime/dist/src/cli.js scorecard fixture check
```

`diagnose` validates configuration only. It does not connect to a provider, spawn Codex, open a
camera or microphone, launch Chromium, or disclose credentials and paths. Committed product
fixtures are read-only during ordinary checks.

## Realtime pipelines, credentials, and settings

`integrated` and `cascaded` are the top-level pipeline shapes. Integrated Qwen is the default: it
uses `qwen-audio-3.0-realtime-plus`, the `longanqian` voice, and `DASHSCOPE_API_KEY`, with no ASR,
LLM, or TTS subnode controls. Cascaded mode exposes endpointing, ASR, LLM, and TTS; its default is
Volcengine ASR -> Qwen `qwen-flash` -> Volcengine TTS. Ark is an explicit cascaded LLM selection,
not an alternate integrated provider:

```bash
NOVA_AUDIO_AGENT_PIPELINE_MODE=cascaded
NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER=ark
ARK_API_KEY=replace-with-your-ark-key
```

One key per platform is reused for every selected node on that platform. Qwen uses
`DASHSCOPE_API_KEY`; the explicit Ark LLM uses `ARK_API_KEY`; Volcengine TTS uses
`DOUBAO_BIGMODEL_API_KEY`. `DOUBAO_ASR_API_KEY` is an optional ASR override, and its fallback is
`DOUBAO_BIGMODEL_API_KEY` when it is absent. Only selected providers are validated or constructed;
there is no automatic provider failover.

The conditional Settings Panel places pipeline mode before provider configuration. Integrated mode
shows its provider, model, and voice; cascaded mode shows endpointing, ASR, LLM, and TTS cards. API
keys remain one field per platform, are write-only, and return presence booleans only. Pipeline,
provider, model, voice, and key edits apply on the next launch; the palette is the sole live setting.

The configured Node executor names are
`fast_sim`, `slow_sim`, and `codex`. Codex ordinary/live/project modes share the bounded app-server
transport. Camera file input accepts only an absolute host-validated path.

Live provider, microphone/speaker, camera, Codex login, WindowServer, Windows descendant cleanup,
clean-machine installer, signing, and publication checks are pending external evidence.

### Opt-in live smoke

The repository's Qwen smoke contacts a real provider and needs a credential; it is opt-in and is not
recorded here as having run or passed. With an intentionally supplied DashScope key, run:

```bash
DASHSCOPE_API_KEY=replace-with-your-qwen-key npm run runtime:smoke:qwen
```

## Public environment reference

The following block is generated from `runtime/src/environment-contract.ts`. Host-private handshake
inputs and retired integration variables are intentionally excluded. The retired compatibility
families are `HA_*` and `AUTOGLM_*`; do not add credentials or endpoints for them to a Node setup.

<!-- BEGIN GENERATED ENV CONTRACT -->
| Variable | Owner | Required | Default | Description |
|---|---|---|---|---|
| `NOVA_AUDIO_AGENT_MODEL_BASE_URL` | `core` | No | DashScope compatible endpoint | FastBrain compatible API endpoint. |
| `NOVA_AUDIO_AGENT_MODEL_API_KEY` | `core` | No | None | Optional generic support-model API credential override. |
| `NOVA_AUDIO_AGENT_FAST_MODEL` | `core` | No | qwen3-vl-plus | FastBrain model. |
| `NOVA_AUDIO_AGENT_WATCH_MODEL` | `core` | No | fast model | Watch model override. |
| `NOVA_AUDIO_AGENT_SURROGATE_MODEL` | `core` | No | qwen-flash | Surrogate model. |
| `NOVA_AUDIO_AGENT_COMPRESSOR_MODEL` | `core` | No | qwen-flash | Memory compressor model. |
| `NOVA_AUDIO_AGENT_PIPELINE_MODE` | `core` | No | integrated | Product pipeline shape: integrated or cascaded. |
| `NOVA_AUDIO_AGENT_INTEGRATED_PROVIDER` | `core` | No | qwen | Integrated realtime provider. |
| `NOVA_AUDIO_AGENT_CASCADE_ENDPOINTING_PROVIDER` | `core` | No | auto | Cascaded endpointing provider. |
| `NOVA_AUDIO_AGENT_CASCADE_ASR_PROVIDER` | `core` | No | volcengine | Cascaded ASR provider. |
| `NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER` | `core` | No | qwen | Cascaded LLM provider. |
| `NOVA_AUDIO_AGENT_CASCADE_LLM_MODEL` | `core` | No | provider default | Cascaded LLM model override. |
| `NOVA_AUDIO_AGENT_CASCADE_TTS_PROVIDER` | `core` | No | volcengine | Cascaded TTS provider. |
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
| `ARK_API_KEY` | `ark` | When selected | None | Ark cascaded LLM credential. |
| `DOUBAO_ASR_API_KEY` | `volcengine` | No | Doubao big-model key | Volcengine ASR credential override. |
| `DOUBAO_BIGMODEL_API_KEY` | `volcengine` | When selected | None | Volcengine TTS and ASR fallback credential. |
| `NOVA_AUDIO_AGENT_VOLCENGINE_ARK_BASE_URL` | `ark` | No | Volcengine Ark endpoint | Ark secure endpoint. |
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
| `NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_ENABLED` | `core` | No | false | Enable the local read-only workspace memory graph. |
| `NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_PATH` | `core` | No | ~/.nova-audio-agent/workspace-graph.sqlite | Workspace memory graph database path. |
| `NOVA_AUDIO_AGENT_MYCONTEXT_PROVIDER_URL` | `core` | No | None | Optional loopback-only Nova-compatible read-only MyContext adapter base URL. |
| `TAVILY_API_KEY` | `search` | When selected | None | Tavily search credential. |
| `NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE` | `camera` | No | None | Absolute deterministic desktop video input. |
| `NOVA_AUDIO_AGENT_REALTIME_TELEMETRY` | `telemetry` | No | None | Source-runtime telemetry output path. |
| `NOVA_AUDIO_AGENT_REALTIME_TRACE` | `telemetry` | No | 0 | Enable source-runtime trace records. |
| `NOVA_ORB_OPAQUE` | `core` | No | 0 | Use an opaque desktop orb window. |
<!-- END GENERATED ENV CONTRACT -->
