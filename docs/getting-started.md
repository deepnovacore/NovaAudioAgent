# Getting Started

## Requirements

- Python 3.11 or newer
- [uv](https://docs.astral.sh/uv/)
- Git with submodule support
- Node.js 22 or newer for the optional desktop app
- macOS for native Ambient Orb audio capture

Clone the public submodule together with the project:

```bash
git clone --recurse-submodules https://github.com/deepnovacore/NovaAudioAgent.git
cd NovaAudioAgent
uv sync --dev
cp .env.example .env
```

At minimum, set `NOVA_AUDIO_AGENT_MODEL_API_KEY`. Search also needs `TAVILY_API_KEY`; realtime
voice needs `DASHSCOPE_API_KEY`.

## CLI

```bash
uv run nova-audio-agent --help
uv run nova-audio-agent demo dual-axis
uv run nova-audio-agent chat --executor fast_sim
```

Supported active executors are `fast_sim`, `slow_sim`, `ha`, `codex`, and `autoglm`. Multiple
executors can be selected with `NOVA_AUDIO_AGENT_EXECUTORS`, for example `codex,ha`.

Camera sources are `auto`, `local`, `disabled`, and `file`. A local camera requires the vision extra:

```bash
uv sync --extra vision --dev
uv run nova-audio-agent chat --camera-source local
```

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
