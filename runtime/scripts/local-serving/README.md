# Local cascaded serving experiment

> Cocktail is retired. ASR now uses a prewarmed CUDA faster-whisper service with
> revisable WebSocket transcripts. See [measurements and limitations](ASR-RESEARCH.md).

Based on `v0.3.0dev` at `d2b1bd8bd4ac70f48fe31ba364809241d08150a5`.
Nova remains the Node/TypeScript conversation owner. ASR, LLM, TTS and embeddings
are separate HTTP/WebSocket services; they may run on one host or behind separate TLS
endpoints/SSH tunnels. No model-specific SDK enters the conversation protocol.

## Hardware budget

| Device | Services | Configuration |
| --- | --- | --- |
| First 24 GiB GPU | Qwen3.5-4B conversation; Breeze TTS 2 | vLLM 50% GPU memory, 8192 context, one sequence; Breeze partial graph decode |
| Second 24 GiB GPU | Whisper large-v3-turbo + independent Qwen3.5-4B extraction | FP16 ASR; extraction port 18106, 4096 context, one sequence, vLLM 50% |
| CPU | Qwen3-Embedding-0.6B, Nova, SQLite | 1024 dimensions, 4 Torch threads |

These are two separate 24 GiB budgets, not pooled memory. Extraction now uses
an independent 4B instance on the second card, configured by `extraction` in the
example profile. Start it with `serve.sh extraction <root> <first-gpu> <second-gpu>`
and forward loopback port 18106 alongside 18101–18104. It no longer queues on the
conversation LLM, but shares GPU compute with ASR. CPU embedding stays unchanged.
No smaller extraction model has been quality-tested; 4096-token extraction context
is an experiment limit, not acceptance of long memory consolidation requests.
Local extraction sends JSON Schema constraints to vLLM, including enum values.

Endpointing already uses LiveKit native Silero and its semantic turn detector.
The measured local defaults are minimum speech 100 ms, silence candidate 250 ms,
and semantic extension cap 1200 ms. Threshold remains 0.5. Run
`BALANCED_ONLY=1 node runtime/scripts/local-serving/live-endpointing.mjs <wav> <output.json>`
to measure speech, an inserted 800 ms pause, and silence with the real detector.

32 GiB Mac deployment is a later milestone: CUDA serving and these BF16 weights
are not a demonstrated fit for 32 GiB unified memory. It needs compatible Metal
backends, quantization and a new full-process memory/quality acceptance run.

## Model sources and tested runtimes

- [faster-whisper](https://github.com/SYSTRAN/faster-whisper): 1.2.1, CTranslate2 4.7.2;
  multilingual large-v3-turbo, CUDA FP16, Silero VAD, startup warmup.
- [Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B): vLLM 0.17.1,
  Torch 2.10.0+cu128. Text-only serving; thinking disabled for voice and extraction.
- [Breeze TTS 2](https://github.com/breezeblue-ai/breeze-tts): source commit
  `008f769016b0a24711becd7a4925030bc93f608c`, Qwen-TTS 0.1.1,
  Transformers 4.57.3, Torch 2.10.0+cu128, accelerate 1.15.0; backbone decode and depth decoder graph acceleration.
  Apply `breeze-cancel.patch` before serving. It closes the synchronous iterator
  and releases admission on HTTP disconnect, including before the first byte.
  The model/output license is research/non-commercial; review it before product use.
- [Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B): CPU,
  same environment as ASR.

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
CUDA_VISIBLE_DEVICES=1 WHISPER_MODEL_PATH=/models/whisper HF_HUB_OFFLINE=1 \
  python -m uvicorn whisper_server:app --host 127.0.0.1 --port 18102
EMBEDDING_MODEL_PATH=/models/embedding HF_HUB_OFFLINE=1 \
  python -m uvicorn embedding_server:app --host 127.0.0.1 --port 18104

# From the pinned Breeze source checkout, with the TTS environment active.
git apply /path/to/nova/runtime/scripts/local-serving/breeze-cancel.patch
CUDA_VISIBLE_DEVICES=0 HF_HUB_OFFLINE=1 python -m breeze_infer.api \
  /models/breeze --host 127.0.0.1 --port 18103 \
  --fast-backbone-decode --fast-depth-decoder
```

ASR uses `/v1/audio/stream`: wait for a JSON `ready` message, send binary mono
16kHz PCM16 frames, then the text control `finish`. Responses are full hypotheses
with `replace:true`; exactly one final ends a successful utterance. Input is
bounded to 65s (including pre-roll around a 60s speech cap) and each frame to 64KB. Nova owns turn endpointing; internal VAD
spans only separate decoding and language detection. Cancellation closes the socket;
in-flight CUDA work completes before admission is released. The client retries
explicit busy admission for up to about 1s. No target-speaker reference is needed.
`ASR_MIN_SPEECH_SECONDS` (default .8) and `ASR_PARTIAL_INTERVAL_SECONDS` (default .2)
control the latency/quality tradeoff. Partials remain provisional and can be wrong;
only final text enters the LLM. Silence returns an empty final. Language-uncertain
final spans fail explicitly instead of silently forcing a transcript.
Breeze uses multipart text/instruction and returns streaming mono PCM16 at 24 kHz.

## Connect Nova

Set `NOVA_AUDIO_AGENT_LOCAL_SERVING` to the JSON contents of `profile.example.json`
The profile takes precedence
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
# Directory contains the public clean-zh.wav and jfk.flac probes described in ASR-RESEARCH.md:
python runtime/scripts/local-serving/live-whisper.py /path/to/asr-probes
node runtime/scripts/local-serving/live-memory.mjs
node runtime/scripts/local-serving/live-components.mjs /tmp/components-result.json
node runtime/scripts/local-serving/live-voice.mjs /path/to/fixtures
# With patched Breeze checkout on PYTHONPATH and its environment active:
python runtime/scripts/local-serving/test_breeze_cancel.py
```

The voice fixture directory must contain `target.wav`
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
`env-llm/`, `env-asr/`, `env-tts/`, and `models/{llm,whisper,breeze,embedding}/`.
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

Local `endpointing.maxSilenceMs` defaults to 1200ms for the LiveKit semantic
extension branch (legacy non-local default remains 2500ms). Raise it for speakers
with long within-sentence pauses. It is not a hard wall-clock response deadline;
VAD and turn-detector processing add time. Runtime preserves low-VAD frames inside
an active utterance so decoding does not lose quiet words or pause boundaries.
