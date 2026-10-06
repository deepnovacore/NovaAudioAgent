# Self-hosted voice and portable presets

Nova keeps microphone capture, endpointing, conversation state, tool authorization, playback and interruption on the client host. ASR, LLM and TTS run behind replaceable network endpoints. Model packages and GPU processes live in `serving/`; they are not dependencies of the Nova runtime.

## Start the reference implementation

The reference launcher currently targets Linux with NVIDIA CUDA: faster-whisper, vLLM and Breeze TTS. It uses two GPUs by default. A future Mac implementation can expose the same protocols without changing Nova's conversation pipeline; this launcher does not install Mac inference engines.

On the GPU machine, copy `serving/profile.4090.example.json` to a private `serving/machine.local.json`, edit GPU indices, ports and storage paths, then run from the repository root:

```sh
python3 serving/serve.py --profile serving/machine.local.json up
python3 serving/serve.py --profile serving/machine.local.json status
python3 serving/serve.py --profile serving/machine.local.json export > voice-preset.json
python3 serving/serve.py --profile serving/machine.local.json stop
```

`up` installs isolated environments, downloads absent model weights and starts the three services. Existing environments and model directories are reused. Downloads require network access and substantial disk space. `start` skips installation; repeating it succeeds when the same configuration is already healthy. Logs and owned-process records are stored under the profile's state directory. `stop` only stops workers whose process identity matches those records. Change the profile only after stopping its workers.

You can reuse an installation through `envs: {llm, asr, tts}`, `models: {llm, asr, tts}` and `breeze_source` paths. `gpus`, `ports`, `llm` memory/context settings and optional model repository/revision mappings belong to the machine profile, never to a shared voice preset. This is a reference implementation for the named models, not a launcher for arbitrary model architectures. Review model licenses before using or redistributing their outputs; deployment does not alter those licenses.

The services bind to loopback. Forward the chosen ports from your Mac, keeping this SSH connection open:

```sh
ssh -N -L 18101:127.0.0.1:18101 -L 18102:127.0.0.1:18102 -L 18103:127.0.0.1:18103 gpu-host
```

Substitute your SSH host alias and profile ports. Use an authenticated TLS reverse proxy when exposing services beyond SSH; the reference loopback services do not provide shared-host user isolation.

## Import and export

Open Settings → Voice pipeline, import the exported JSON, review the displayed endpoints/model, then Save. Import stages the changes and leaves omitted stages unchanged. Export includes selected self-hosted stages only. Cloud presets, memory embeddings and executor configuration are outside this preset format.

```json
{
  "schema": "nova.voice-preset",
  "version": 1,
  "name": "Self-hosted voice",
  "asr": {"provider": "self-hosted", "url": "ws://127.0.0.1:18102/v1/audio/stream"},
  "llm": {"provider": "self-hosted", "baseUrl": "http://127.0.0.1:18101/v1", "model": "Qwen/Qwen3.5-4B"},
  "tts": {"provider": "self-hosted", "url": "http://127.0.0.1:18103/v1/audio/speech"}
}
```

Unknown fields/versions and files over 64 KiB are rejected as a whole. URLs support remote HTTPS/WSS or plaintext literal loopback addresses. URL credentials, query strings and fragments are rejected. Tokens use separate optional ASR/LLM/TTS secret fields and are never exported. Changing an endpoint's origin clears its old token; an explicitly entered new token can be saved together with the new endpoint. Existing cloud keys are never reused for self-hosted stages.

Support model requests follow the selected conversation provider unless separately overridden. Memory embeddings, search and other enabled services keep their own configuration; selecting self-hosted voice alone does not make the entire application offline.

For headless use select `PIPELINE_MODE=cascaded`, set each `CASCADE_*_PROVIDER=self-hosted`, `CASCADE_LLM_MODEL`, and `SELF_HOSTED_ASR_URL`, `SELF_HOSTED_LLM_BASE_URL`, `SELF_HOSTED_TTS_URL`. Optional `SELF_HOSTED_{ASR,LLM,TTS}_API_KEY` fields supply dedicated bearer tokens. Canonical `NOVA_`-prefixed names are documented in [configuration](../configuration.md).

## Wire contracts and checks

- ASR: WebSocket, mono 16 kHz little-endian PCM16 binary input; server ready event `{type:"ready",sampleRate:16000,format:"s16le"}`. Send text `finish` after the utterance. Transcripts are complete replacement hypotheses `{text,final,replace:true}`; exactly one final ends the utterance. Closing cancels it.
- LLM: OpenAI-compatible streaming `/chat/completions`, including structured tool calls and results. Model selection remains configuration.
- TTS: HTTP POST multipart `text` and `instruction`; streaming mono 24 kHz little-endian PCM16 with `Content-Type: audio/pcm`, `X-Sample-Rate: 24000`, `X-Sample-Format: s16le`. A disconnected request must release synthesis capacity. Nova supplies ordered speech segments and cancels active work on interruption.

Run `python3 -m unittest discover -s serving` for model-free launcher checks (process lifecycle checks require Linux). For live adapter checks, build the runtime, forward the ports, then run:

```sh
node serving/smoke.mjs voice-preset.json prerecorded-16khz-mono.s16le
```

This checks final ASR, an LLM tool round-trip, TTS cancellation and the next synthesis request, then feeds the prerecorded audio through the production conversation voice pipeline to obtain a completed audio response. It does not record a microphone or establish acoustic echo cancellation, speaker playback or conversational latency quality.

## Mac simulation and local ASR

The CUDA launcher remains Linux-only. To rehearse Mac input without opening a physical microphone, generate a fixed audio file using an installed macOS voice and convert it to mono 16 kHz PCM:

```sh
mkdir -p output
say -v Tingting -o output/mock-mic.aiff '你好，这是本地语音测试。请用一句话回答。'
ffmpeg -nostdin -y -i output/mock-mic.aiff -ar 16000 -ac 1 -f s16le output/mock-mic.s16le
node serving/mock-smoke.mjs output/mock-mic.s16le
```

This starts temporary loopback ASR/LLM/TTS doubles and feeds the file in microphone-sized frames through the production pipeline. It checks tool round-trips, replacement transcripts, odd PCM network boundaries, cancellation and subsequent synthesis. Its ASR text, LLM replies and TTS tone are mocks, not model quality measurements. It never records or plays physical audio.

To additionally run **real local CPU transcription**, use an existing Python environment with `openai-whisper` and existing `.pt` weights:

```sh
python serving/mac-asr-smoke.py --model /path/to/base.pt --audio output/mock-mic.aiff --expect 本地
```

This command does not download models. A pass proves local ASR for this synthetic fixture; it does not prove Mac LLM/TTS serving, microphone permissions, echo cancellation or speaker playback. The earlier 4090 smoke uses real remote models, independently of these mock services.

The reference setup pins Breeze source and Whisper weights. LLM/TTS model revisions default to `main`; specify exact commits in the machine profile's `model_revisions` (`llm` and `tts`) when a reproducible fresh deployment is required.
