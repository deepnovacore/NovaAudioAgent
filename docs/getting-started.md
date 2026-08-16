# Getting Started

## Requirements

The requirements are listed in the [README Quickstart](../README.md#quickstart): Python 3.11+,
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

At minimum, set `NOVA_AUDIO_AGENT_MODEL_API_KEY`. Search also needs `TAVILY_API_KEY`; realtime
voice uses `DASHSCOPE_API_KEY` and falls back to `NOVA_AUDIO_AGENT_MODEL_API_KEY` when it is
unset.

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
| `QWEN_REALTIME_URL` | DashScope realtime endpoint | Realtime websocket URL |
| `QWEN_REALTIME_MODEL` | `qwen-audio-3.0-realtime-plus` | Realtime model |
| `QWEN_REALTIME_VOICE` | `longanqian` | Realtime TTS voice |
| `QWEN_CONTROLLED_GUARD_RECONNECT` | `false` | Opt-in controlled reconnect around Guard sessions |
| `QWEN_GUARD_HISTORY_RECOVERY` | `none` | `none` or `packed` history recovery after Guard reconnect |
| `QWEN_GUARD_HISTORY_PAIRS` | `4` | Recovered history pairs (`1`, `2`, or `4`) |
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
are `run` and `status`. The realtime path (Ambient Orb and `build_qwen_realtime_assembly`) uses the
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
[README](../README.md#development-and-verification):

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
