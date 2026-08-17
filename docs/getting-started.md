# Getting Started

## Requirements

The requirements are listed in the [README Quickstart](../README.md#4-quickstart): Python 3.11+,
[uv](https://docs.astral.sh/uv/), Git with submodule support, Node.js 22+ for the optional desktop
app, and macOS for native Ambient Orb audio capture.

Clone the public submodule together with the project:

```bash
git clone --recurse-submodules \
  https://github.com/deepnovacore/NovaAudioAgent.git nova-audio-agent
cd nova-audio-agent
uv sync --dev
cp .env.example .env
```

At minimum, set `NOVA_AUDIO_AGENT_MODEL_API_KEY`. Search also needs `TAVILY_API_KEY`. Realtime
voice defaults to Qwen and uses `DASHSCOPE_API_KEY`, falling back to the model key. See
[Realtime voice providers](#realtime-voice-providers) for the opt-in Volcengine pipeline.

## Chinese-first defaults

Nova is a Chinese-first assistant. The persona (小诺), all four production system prompts, the
model-facing tool descriptions, CLI error messages, the default realtime voice (`longanqian`), and
the visual-evaluator prompts are Chinese. The documentation is English, but the running product
will speak and error in Chinese out of the box. Using it in another language currently means
replacing the Chinese strings at their sources — the prompt constants in
`src/nova_audio_agent/prompting.py`, the frontend instructions in
`src/nova_audio_agent/realtime/qwen.py`, the operation descriptions declared in each executor
module, the evaluator prompts in `src/nova_audio_agent/executors/watcher.py`, and the CLI messages
in `src/nova_audio_agent/cli.py` — there is no language switch.

## CLI

```bash
uv run nova-audio-agent --help
uv run nova-audio-agent demo dual-axis
uv run nova-audio-agent demo proactive
uv run nova-audio-agent chat --executor fast_sim
uv run nova-audio-agent scorecard
```

Supported active executors are `fast_sim`, `slow_sim`, `ha`, `codex`, and `autoglm`. Multiple
executors can be selected with `NOVA_AUDIO_AGENT_EXECUTORS`, for example `codex,ha`. Around the
selected executors, four always-on tools are assembled automatically: read-only search, camera
snapshots, and the Watch and Guard visual monitors.

Camera sources are `auto`, `local`, `disabled`, and `file`. A local camera requires the vision extra:

```bash
uv sync --extra vision --dev
uv run nova-audio-agent chat --camera-source local
```

File-backed Watch and Guard are useful without a live camera; the public
[cat-sofa Guard fixture](../assets/demos/cat-sofa-guard/README.md) includes a reproducible command.

## Integrations

A common control plane around replaceable adapters: each adapter owns its credential checks,
transport timeouts, request normalization, and output sanitization, while Runtime owns the generic
delegate lifecycle.

| Integration | What is included |
|---|---|
| Deterministic simulation | `fast_sim` and `slow_sim` executors for demos and offline scenarios |
| Search | Read-only Tavily-backed search exposed as a bounded tool |
| Home Assistant | Bounded light operations with explicit endpoint, token, and entity configuration |
| Codex | Long-running workspace tasks with progress, status, and recovery. Two backends: default JSONL (`run`, `status`) on the text CLI; live app-server (`run`, `steer`, `status`) on the realtime path — steering only on the latter |
| AutoGLM | Experimental iOS browsing through a pinned public upstream submodule and worker protocol |
| Vision | Local camera or file-backed snapshots, Watch observations, and Guard conditions |
| Realtime voice | Startup-selectable Qwen Audio Realtime or native Volcengine VAD/ASR/Ark/TTS cascade, with shared response correlation, playback fencing, recovery, and telemetry |
| Ambient Orb | Sandboxed Electron UI plus a native macOS VoiceProcessingIO helper |

## Configuration reference

All variables use the `NOVA_AUDIO_AGENT_` prefix unless noted. `.env.example` lists the common
ones; the full set (from `src/nova_audio_agent/config.py`):

| Variable | Default | Purpose |
|---|---|---|
| `MODEL_API_KEY` | — | Text-model key (required for chat and demos) |
| `MODEL_BASE_URL` | DashScope compatible endpoint | OpenAI-compatible base URL for text models |
| `FAST_MODEL` | `qwen3-vl-plus` | FastBrain model |
| `SURROGATE_MODEL` | `qwen-flash` | Surrogate attention-policy model |
| `COMPRESSOR_MODEL` | `qwen-flash` | Channel-summary compression model |
| `WATCH_MODEL` | falls back to `FAST_MODEL` | Vision model for the Watch/Guard monitors |
| `TAVILY_API_KEY` (no prefix) | — | Web search |
| `DASHSCOPE_API_KEY` (no prefix) | — | Realtime voice |
| `REALTIME_PROVIDER` | `qwen` | `qwen` or `volcengine`; selected once at startup, with no automatic failover |
| `QWEN_REALTIME_URL` | DashScope realtime endpoint | Realtime websocket URL |
| `QWEN_REALTIME_MODEL` | `qwen-audio-3.0-realtime-plus` | Realtime model |
| `QWEN_REALTIME_VOICE` | `longanqian` | Realtime TTS voice |
| `QWEN_CONTROLLED_GUARD_RECONNECT` | `false` | Opt-in controlled reconnect around Guard sessions |
| `QWEN_GUARD_HISTORY_RECOVERY` | `none` | `none` or `packed` history recovery after Guard reconnect |
| `QWEN_GUARD_HISTORY_PAIRS` | `4` | Recovered history pairs (`1`, `2`, or `4`) |
| `ARK_API_KEY` (no prefix) | — | Ark Responses API key for the Volcengine LLM |
| `DOUBAO_ASR_API_KEY` (no prefix) | falls back to `DOUBAO_BIGMODEL_API_KEY` | Seed ASR API key |
| `DOUBAO_BIGMODEL_API_KEY` (no prefix) | — | Seed TTS 2.0 API key |
| `VOLCENGINE_ARK_BASE_URL` | Ark API v3 endpoint | HTTPS Ark endpoint |
| `VOLCENGINE_ARK_MODEL` | `doubao-seed-2-0-mini-260428` | Tool-capable Ark model; thinking is disabled on the voice path |
| `DOUBAO_ASR_ENDPOINT` | Seed ASR v3 endpoint | Secure ASR websocket endpoint |
| `DOUBAO_ASR_RESOURCE_ID` | `volc.seedasr.sauc.duration` | ASR 2.0 resource; may be overridden with the legacy resource when required |
| `DOUBAO_ASR_CHUNK_MS` | `200` | ASR packet duration |
| `DOUBAO_TTS_ENDPOINT` | bidirectional TTS endpoint | Secure TTS websocket endpoint |
| `DOUBAO_TTS_RESOURCE_ID` | `seed-tts-2.0` | TTS resource |
| `DOUBAO_TTS_VOICE` | `zh_female_vv_uranus_bigtts` | TTS voice |
| `DOUBAO_TTS_OUTPUT_SAMPLE_RATE` | `24000` | PCM16 playback rate; currently fixed at 24 kHz |
| `VOLCENGINE_VAD_THRESHOLD` | `0.5` | Silero speech threshold |
| `VOLCENGINE_VAD_PRE_ROLL_MS` | `260` | Audio retained before speech start |
| `VOLCENGINE_VAD_MIN_SPEECH_MS` | `250` | Short-utterance rejection threshold |
| `VOLCENGINE_VAD_SILENCE_END_MS` | `560` | End-of-speech silence |
| `VOLCENGINE_VAD_SPEECH_PAD_MS` | `30` | Silero speech padding |
| `VOLCENGINE_VAD_MAX_UTTERANCE_MS` | `15000` | Forced utterance boundary |
| `EXECUTOR` | `fast_sim` | Legacy single active executor |
| `EXECUTORS` | empty | Comma-separated active executors (overrides `EXECUTOR`) |
| `HA_URL`, `HA_TOKEN`, `HA_ENTITY_ID` | — | Home Assistant light control |
| `CODEX_WORKSPACE` | — | Codex workspace directory (validated before use) |
| `CODEX_BIN` | `codex` | Codex executable |
| `CODEX_API_KEY` | — | Optional key passed to the Codex environment |
| `CODEX_PREWARM` | `true` | Warm the app-server session before the first task (realtime path) |
| `AUTOGLM_REPO` | `thirdparty/Open-AutoGLM` | Pinned upstream checkout |
| `AUTOGLM_PYTHON` | `.autoglm-venv/bin/python` | Upstream worker interpreter |
| `AUTOGLM_BASE_URL` | `https://open.bigmodel.cn/api/paas/v4` | AutoGLM API endpoint |
| `AUTOGLM_MODEL` | `autoglm-phone` | AutoGLM model |
| `AUTOGLM_API_KEY` | — | AutoGLM API key |
| `AUTOGLM_WDA_URL` | `http://127.0.0.1:8100` | WebDriverAgent endpoint |
| `AUTOGLM_DEVICE_ID` | — | Optional device identifier |
| `DESKTOP_VIDEO_FILE` | — | Ambient Orb development aid: absolute path to a video file used as the camera source when no live camera is available |

## Realtime voice providers

Qwen remains the default and needs no extra audio-model dependencies:

```dotenv
NOVA_AUDIO_AGENT_REALTIME_PROVIDER=qwen
DASHSCOPE_API_KEY=...
```

The alternative Volcengine backend is a native cascade rather than runtime failover:

```text
16 kHz PCM16 → Silero VAD v5.1.2 → Seed ASR → Doubao Seed 2.0 Mini → Seed TTS 2.0 → 24 kHz PCM16
```

Enable the Volcengine speech dependencies and configure all three services:

```bash
uv sync --extra vision --extra volcengine --dev
```

Although runtime inference selects the ONNX Silero model, upstream `silero-vad==5.1.2` currently
pulls in PyTorch and torchaudio transitively, so this optional extra is a large installation.

```dotenv
NOVA_AUDIO_AGENT_REALTIME_PROVIDER=volcengine
ARK_API_KEY=...
DOUBAO_ASR_API_KEY=...
DOUBAO_BIGMODEL_API_KEY=...
TAVILY_API_KEY=...
```

`DOUBAO_ASR_API_KEY` may be omitted when the account uses the same API key as
`DOUBAO_BIGMODEL_API_KEY`. The Ark client uses the Responses API with stored response chaining,
serial native function calls, and thinking disabled. Tool results return through the original
`call_id`. A response that mixes already-streamed answer text with a later tool call is rejected
without executing that call. TTS flushes the first natural punctuation, then uses 18-character
soft and 48-character hard chunks; a disconnected TTS chunk is retried once only when no audio
from it has been emitted.

The Volcengine console must have Seed ASR 2.0, Ark access to the configured Seed model, and Seed
TTS 2.0 enabled. Missing Silero/ONNX dependencies or credentials fail startup. This backend does
not include speaker verification, face recognition, wake-word detection, diarization, TSE, A2F,
or automatic provider failover.

For an opt-in latency capture, set an absolute telemetry path while running Ambient Orb, speak
several turns, then render p50/p95 stage timings:

```bash
NOVA_AUDIO_AGENT_REALTIME_TELEMETRY=/tmp/nova-volcengine.jsonl \
  ./scripts/start_ambient_orb_macos.sh
uv run python -m scripts.realtime_probe telemetry-report /tmp/nova-volcengine.jsonl
```

The report includes `speech end → ASR final → LLM first text → TTS first audio`. Telemetry records
only event kinds, timestamps, bounded identifiers, counters, and statuses—never credentials, raw
audio, or full conversation text. Live provider traffic is always explicit opt-in and is not part
of default CI.

For a bounded end-to-end smoke run from a known utterance, use an uncompressed mono 16 kHz PCM16
WAV. The command refuses network calls unless `--live` is present and prints no transcript:

```bash
uv run python scripts/smoke_volcengine_realtime.py \
  --live --wav /absolute/path/to/utterance.wav --runs 3
```

To compare Ark models without sending audio, run the bounded synthetic function-call matrix. It
requires `--live`, accepts only the repository's reviewed model allowlist, and prints aggregate
quality/error-class and p50/p95 timing metadata. It does not print prompts, tool arguments, tool
outputs, response text, request IDs, or credentials. The Seed 2.0 Pro baseline is included even
when it is omitted from `--models`:

```bash
uv run --extra volcengine python scripts/benchmark_volcengine_llm.py \
  --live --runs 2 \
  --models doubao-seed-2-0-pro-260215 doubao-seed-2-1-turbo-260628 \
  deepseek-v4-pro-ga-260813 deepseek-v4-flash-ga-260731
```

A candidate is eligible only when its overall and every-category function-call pass rates match
or exceed the measured baseline and it has zero severe failures. The benchmark never changes the
configured production model automatically.

## Home Assistant

Set `NOVA_AUDIO_AGENT_HA_URL`, `NOVA_AUDIO_AGENT_HA_TOKEN`, and
`NOVA_AUDIO_AGENT_HA_ENTITY_ID=light.<name>`, then run:

```bash
uv run nova-audio-agent chat --executor ha
```

Use a dedicated Home Assistant token with the smallest practical permission scope.

## Codex

Set `NOVA_AUDIO_AGENT_CODEX_WORKSPACE` to an existing workspace and ensure the `codex` executable
is available. The workspace is resolved and validated before a task starts.

```bash
uv run nova-audio-agent chat --executor codex
```

There are two Codex backends. The text CLI above uses the default JSONL transport, whose operations
are `run` and `status`. The realtime path (Ambient Orb and `build_realtime_assembly`) uses the
live app-server transport instead: it spawns `codex app-server` over stdio JSON-RPC, keeps the
session warm (`NOVA_AUDIO_AGENT_CODEX_PREWARM`), and adds the `steer` operation, which appends a
new user constraint to the in-flight turn (`turn/steer`) without terminating or restarting it.
Same-turn steering is therefore not exposed by the text CLI; it is available on the realtime path
and through the explicit `build_codex_live_assembly` entry point used by live evaluations.

## AutoGLM

The upstream source is pinned at `thirdparty/Open-AutoGLM`. Follow its public setup instructions,
create the configured Python environment, and set `NOVA_AUDIO_AGENT_AUTOGLM_API_KEY` plus an
optional device ID. Nova Audio Agent invokes the submodule through a bounded worker protocol.

## Ambient Orb

```bash
./scripts/start_ambient_orb_macos.sh
```

The launcher builds the native VoiceProcessingIO helper and Electron application, then starts the
local Python backend. The desktop UI uses a sandboxed preload bridge and does not expose Node.js to
renderer pages.

## Verification

The canonical check sequence is in the
[README](../README.md#8-development-and-verification):

```bash
uv run ruff check src tests scripts
uv run ruff format --check src tests scripts
uv run pytest -q
uv build

cd desktop/ambient-orb
npm ci
npm test
npm run build
```
