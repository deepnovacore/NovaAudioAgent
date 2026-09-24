# Local cascaded serving experiment

> 2026-09-25: Cocktail has been retired at the user's request. The setup below is
> a historical experiment; see [ASR replacement research](ASR-RESEARCH.md) for the
> active Whisper investigation. No replacement has passed full Nova acceptance yet.

Based on `v0.3.0dev` at `d2b1bd8bd4ac70f48fe31ba364809241d08150a5`.
Nova remains the Node/TypeScript conversation owner. ASR, LLM, TTS and embeddings
are separate HTTP services; they may run on one host or behind separate TLS
endpoints/SSH tunnels. No model-specific SDK enters the conversation protocol.

## Hardware budget

| Device | Services | Configuration |
| --- | --- | --- |
| First 24 GiB GPU | Qwen3.5-4B conversation + extraction; Breeze TTS 2 | vLLM 50% GPU memory, 8192 context, one sequence; Breeze partial graph decode |
| Second 24 GiB GPU | Xiaomi CocktailASR-1 | BF16, one utterance at a time |
| CPU | Qwen3-Embedding-0.6B, Nova, SQLite | 1024 dimensions, 4 Torch threads |

These are two separate 24 GiB budgets, not a pooled 48 GiB allocation. Extraction
initially shares the 4B service; it has a separate connection field so a smaller
model can replace it after quality testing. This version does not implement
foreground-priority scheduling. Memory extraction can delay conversation on the
shared single-sequence LLM. CPU embedding avoids a fourth GPU model.

32 GiB Mac deployment is a later milestone: CUDA serving and these BF16 weights
are not a demonstrated fit for 32 GiB unified memory. It needs compatible Metal
backends, quantization and a new full-process memory/quality acceptance run.

## Model sources and tested runtimes

- [CocktailASR-1](https://huggingface.co/Ease3/Xiaomi-CocktailASR-1): local weights,
  Torch 2.10.0+cu128, Transformers 4.51.3. Official demo source commit
  `8729d3b8db1f2d9b8ac0266d713c0d06a88bff9a`.
- [Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B): vLLM 0.17.1,
  Torch 2.10.0+cu128. Text-only serving; thinking disabled for voice and extraction.
- [Breeze TTS 2](https://github.com/breezeblue-ai/breeze-tts): source commit
  `008f769016b0a24711becd7a4925030bc93f608c`, Qwen-TTS 0.1.1,
  Transformers 4.57.3, Torch 2.10.0+cu128, accelerate 1.15.0; backbone decode and depth decoder graph acceleration.
  Apply `breeze-cancel.patch` before serving. It closes the synchronous iterator
  and releases admission on HTTP disconnect, including before the first byte.
  The model/output license is research/non-commercial; review it before product use.
- [Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B): CPU,
  same isolated environment as Cocktail.

Download weights and dependencies before offline execution. Use separate Python
environments for ASR/embedding and TTS. Do not upgrade a shared serving environment.
The experiment reused installed Torch/CUDA read-only via venv system-site-packages;
freeze the resulting environment for replication.

## Start the services

Paths and GPU numbers below are examples. Choose two verified physical GPUs and
check their UUIDs before launch. vLLM 0.17.1 in this experiment required a numeric
`CUDA_VISIBLE_DEVICES` value. Bind all services to loopback; tunnel or add authenticated
TLS for remote access. These test servers do not implement network authentication.

```sh
# LLM; run in its own terminal/process supervisor.
CUDA_VISIBLE_DEVICES=0 HF_HUB_OFFLINE=1 python -m vllm.entrypoints.openai.api_server \
  --model /models/Qwen3.5-4B --served-model-name Qwen/Qwen3.5-4B \
  --host 127.0.0.1 --port 18101 --max-model-len 8192 --max-num-seqs 1 \
  --gpu-memory-utilization 0.50 --enforce-eager --language-model-only \
  --enable-auto-tool-choice --tool-call-parser qwen3_coder --reasoning-parser qwen3 \
  --default-chat-template-kwargs '{"enable_thinking":false}'

# From this directory, with the ASR environment active.
CUDA_VISIBLE_DEVICES=1 COCKTAIL_MODEL_PATH=/models/cocktail HF_HUB_OFFLINE=1 \
  python -m uvicorn asr_server:app --host 127.0.0.1 --port 18102
EMBEDDING_MODEL_PATH=/models/embedding HF_HUB_OFFLINE=1 \
  python -m uvicorn embedding_server:app --host 127.0.0.1 --port 18104

# From the pinned Breeze source checkout, with the TTS environment active.
git apply /path/to/nova/runtime/scripts/local-serving/breeze-cancel.patch
CUDA_VISIBLE_DEVICES=0 HF_HUB_OFFLINE=1 python -m breeze_infer.api \
  /models/breeze --host 127.0.0.1 --port 18103 \
  --fast-backbone-decode --fast-depth-decoder
```

Cocktail input is mono PCM16 WAV at 16 kHz, with a **1–4 second reference of the
target speaker**. It is utterance-based, not streaming ASR. Reference bytes are
uploaded by Nova; servers never resolve caller-provided file paths. Empty final
transcripts produce no user turn or LLM request. Cancellation stops local delivery;
Cocktail GPU work may finish the current bounded utterance before it accepts another.
Breeze uses multipart text/instruction and returns streaming mono PCM16 at 24 kHz.

## Connect Nova

Set `NOVA_AUDIO_AGENT_LOCAL_SERVING` to the JSON contents of `profile.example.json`
(edit `referenceAudio` to an absolute local WAV path). The profile takes precedence
over cloud model routing. It forces cascaded mode and disables conversation camera.
An omitted `extraction` connection shares `llm`; `embedding` always has its own
endpoint. For remote services, tunnel ports 18101–18104 to the Nova host or use HTTPS.
Use `NOVA_AUDIO_AGENT_MEMORY_LEDGER_PATH` to choose an isolated experimental ledger.

This profile routes model roles; it is **not an app-wide network firewall**.
Cloud executors, search, connectors, telemetry and configured HTTPS endpoints need
separate disablement/egress controls before claiming all application data stays on-device.
The real-model tests use public prerecorded speech and synthetic memory, not user data.

## Re-run acceptance

Build before testing (`npm run build --workspace @nova-audio-agent/runtime`).

```sh
node --test runtime/scripts/local-serving.test.mjs
node runtime/scripts/local-serving/live-memory.mjs
node runtime/scripts/local-serving/live-components.mjs /tmp/components-result.json
node runtime/scripts/local-serving/live-voice.mjs /path/to/fixtures
# With patched Breeze checkout on PYTHONPATH and its environment active:
python runtime/scripts/local-serving/test_breeze_cancel.py
```

The voice fixture directory must contain `reference.wav` (1–4 s) and `target.wav`
(mono PCM16, 16 kHz). The live voice test calls the production conversation voice
assembly and its real endpointing path, replays input at microphone cadence, and
writes `nova-reply.wav` and event evidence. It is not a real microphone/device test.
Run component and voice tests sequentially: Breeze is deliberately single-request.
Set `LONG_REPLY=1` to test unconstrained answers; the default voice fixture adds an explicit synthetic short-reply preference. A completed response terminal is mandatory; partial audio at timeout fails.
Live memory uses a fresh temporary ledger, validates extraction, vector recall,
reopen persistence, correction and deletion. It never reads the user's real ledger.

### RTF benchmark

With no other TTS request running, execute `python bench-tts.py /tmp/tts-benchmark`.
It writes WAV files and JSON containing wall time, first audio time, PCM duration
and `RTF = wall_seconds / audio_seconds`. HTTP input preparation and full output
delivery are included; model startup/graph warmup are measured separately. RTF
below 1 means synthesis is faster than playback. Compare identical text,
instruction, server seed, hardware allocation and concurrency. A quick first packet
does not imply real-time sustained synthesis.

## Repeatable serving and full Nova server

`serve.sh <service> <experiment-root> <llm-gpu-index> <asr-gpu-index>` runs one
foreground service (`llm`, `asr`, `tts`, `embedding`). It validates both cards are
RTX 4090s, translates physical indices to PCI-ordered CUDA ordinals, and verifies
the selected CUDA UUID before loading weights. ASR owns the second selected card;
LLM/TTS share the first; embedding hides CUDA. Start LLM before TTS so vLLM memory
profiling does not race TTS allocation. Wait for each `/health` to return 200.

The root layout is `repo/` (Nova), `breeze-src/` (patched pinned upstream),
`env-llm/`, `env-asr/`, `env-tts/`, and `models/{llm,cocktail,breeze,embedding}/`.
Existing read-only environments/weights may be symlinked into that layout.
A process supervisor can run the same foreground commands; the script neither
kills unrelated processes nor changes machine services.

Start the actual Node server with an explicit, reusable **experiment** state directory:

```sh
node runtime/scripts/local-serving/run-nova.mjs /path/profile.json /path/experiment-state 18100
node runtime/scripts/local-serving/live-server.mjs /path/experiment-state /path/fixtures 18100
```

The launcher creates a mode-0600 server credential, isolates SQLite/host state,
uses an allowlisted process environment, and disables search, coding, knowledge
scans and external MCP. It never inherits cloud API keys. It reuses that directory
on restart and writes its own `capabilities.local-serving.json`; choose a dedicated
experiment directory, never your production state directory.
The client test checks bad-token rejection, captions, real framed PCM, terminal,
and the exact `playback.started`/`playback.done` command receipts. Renderer consumption
is simulated; it does not prove physical speaker playback.

On macOS, the tested OS sandbox restricts **Nova and its children** to loopback:

```sh
sandbox-exec -f runtime/scripts/local-serving/mac-loopback.sb \
  node runtime/scripts/local-serving/run-nova.mjs /path/profile.json /path/experiment-state 18100
```

SSH tunnels and remote model servers are separate processes, outside this sandbox.
This is a tested macOS experiment policy, not a portable production firewall.
The test confirmed loopback HTTP succeeds, external TCP fails with `EPERM`, and
the real Nova server can still complete an authenticated voice turn under this policy.
