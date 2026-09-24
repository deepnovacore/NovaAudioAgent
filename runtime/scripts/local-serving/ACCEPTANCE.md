# Live acceptance — 2026-09-24

Result: model serving and Nova's production voice assembly work on two RTX 4090s.
The test used public prerecorded Cocktail demo audio and synthetic memory. This
is not real-microphone/device acceptance and does not establish app-wide no-egress.

## Final allocation and observed memory

| Physical GPU | Processes | Highest sampled total |
| --- | --- | ---: |
| GPU2 | Qwen3.5-4B vLLM + Breeze TTS 2 | 22,100 MiB (21.58 GiB) |
| GPU3 | CocktailASR-1 BF16 | 17,802 MiB (17.38 GiB) |

Qwen3-Embedding-0.6B and Nova's memory ledger run on CPU. The other two installed
GPUs were not used by this experiment. The live-run trace sampled GPU memory once
per second; a post-restart spot check raised the observed GPU2 maximum to 22,100
MiB. Subsecond peaks may be missed. The observed per-device maxima sum to 38.97
GiB; they are not necessarily simultaneous.

## Breeze TTS 2 performance

Same texts, instruction, server seed and concurrent resident models. No concurrent
TTS request. Total wall time includes HTTP preparation and complete PCM delivery.
RTF = wall time / produced audio duration; lower is better. All samples below were
after server warmup, not cold startup. The first eager inference was tested earlier.

| Mode | Text | First audio | Wall time | Audio duration | RTF |
| --- | --- | ---: | ---: | ---: | ---: |
| Eager | 14 Chinese characters | 0.516 s | 6.261 s | 2.48 s | 2.525 |
| Eager | same text repeated | 0.403 s | 5.894 s | 2.48 s | 2.377 |
| Eager | 53 Chinese characters | 0.454 s | 24.234 s | 10.88 s | 2.227 |
| Partial graph | 14 Chinese characters | 0.245 s | 1.281 s | 2.32 s | 0.552 |
| Partial graph | same text repeated | 0.174 s | 1.166 s | 2.32 s | 0.503 |
| Partial graph | 53 Chinese characters | 0.198 s | 4.956 s | 11.44 s | 0.433 |

Selected flags: `--fast-backbone-decode --fast-depth-decoder`. Text encoding,
backbone prefill and codec remain eager. Explicit warmup reported 72.54 s; total
cold-start time was not separately measured. This leaves more memory headroom than
full acceleration. Generated waveforms/durations differ between modes; these are
not bit-identical outputs. Cocktail retranscribed both 53-character WAVs exactly
after punctuation removal. That is an intelligibility proxy, not a listening/MOS test.

Cancellation initially exposed an upstream lock leak. `breeze-cancel.patch` fixes
response-owned generator cleanup. Under the selected accelerated configuration,
local cancellation stopped delivery after one chunk in 1.69 ms. The immediately
following request returned 119,040 PCM bytes. The client retries a transient 409
for at most three seconds while the current GPU chunk finishes; local cancellation
time does not mean instantaneous GPU preemption.

## Other live checks

- Cocktail positive fixture: correct target transcript in 4.56 s on the first
  direct test. Negative fixture: empty result in 0.15 s. One positive/negative pair
  is not a speaker-rejection accuracy benchmark or an identity/authentication proof.
- Qwen4B: real SSE output, parsed tool call and tool-result continuation through
  Nova's client. Initial direct text/tool requests took 6.34/27.34 s; later extraction
  completed in 2.62 s. Cold/shape compilation and warm traffic must not be conflated.
- Memory: real 4B extraction, 1024-dimensional CPU embeddings, SQLite persistence
  across reopen, non-degraded recall, correction and forget verified on both hosts.
  Similar paraphrase cosine was 0.890 versus unrelated 0.268 in the local fixture.
- Mac Nova with tunneled services: production voice assembly and actual LiveKit
  VAD/EOT; end-of-speech to transcript 0.765 s, to first audio 1.572 s; explicit
  completed terminal at 23.523 s from script start. A synthetic short-reply preference
  was supplied; it is a functional fixture, not a strict response-length test.
- Linux Nova co-hosted with serving: unconstrained long answer, production assembly,
  bounded-silence fallback because native VAD/EOT assets were unavailable. End-of-speech
  to transcript 0.704 s, to first audio 1.679 s; completed terminal at 57.933 s from
  start, with 89.60 s of generated audio. PCM collection does not wait for speaker playback.
- The first eager long-answer replay exceeded its 120 s deadline with partial audio.
  Acceptance now requires a completed terminal and explicitly rejects timeout; it
  was rerun successfully with partial acceleration.

## Verification and limits

Local: TypeScript build, 167 speech/config/adapter regressions, 50 memory/gateway
regressions, environment-contract check and diff whitespace check passed. Remote:
TypeScript build and all seven new adapter/config tests passed. Python disconnect
checks covered cancellation before the first body chunk and after streaming starts.
An independent source review found no remaining important/critical issue after fixes.

Still unverified: real user microphone, speaker enrollment, noisy/multi-speaker
accuracy, multi-session concurrency, human TTS listening quality, offline firewall
acceptance and 32 GiB Mac inference. Extraction currently shares the 4B service and
can contend with foreground requests. No smaller extraction model was quality-tested.
ASR cancellation can leave its bounded GPU inference running. A minor upstream-patch
cleanup edge remains for optional reference-file deletion errors; Nova's TTS adapter
only sends text/instruction and does not use reference uploads.

See [setup and re-run instructions](README.md). No merge, push or public deployment
was performed; this is an isolated experiment.

## Headless service and restart acceptance

The experiment now also starts **the real Nova server entrypoint**, not just its
voice provider. `run-nova.mjs` uses explicit reusable experiment state and excludes
inherited cloud credentials/capabilities. `live-server.mjs` authenticates over
`/client/v1`, sends prerecorded raw PCM at microphone cadence, checks user/assistant
captions and framed output, and requires the exact playback-start/done command
receipts to be applied. Renderer acknowledgements are synthetic; no claim of
physical speaker playback is made.

- Mac Nova behind its loopback-only OS sandbox: passed after service restart;
  first audio 16.550 s and terminal 25.759 s from harness start; 1,025,280 PCM bytes
  (21.36 s). These include auth/start/input time and are not end-of-speech latencies.
- Linux Nova on the 4090 host: passed after restart; first audio 16.039 s and terminal
  30.051 s from harness start; 1,512,960 PCM bytes (31.52 s). A synthetic memory
  extraction/recall/correction/deletion test ran alongside the voice workflow and
  also passed. This is a coexistence smoke test, not a throughput/concurrency benchmark.
- Mac outbound guard: loopback service returned HTTP 200; an external TCP attempt
  was denied with `EPERM`; authenticated voice completed under the same sandbox.
  The guard covers Nova and its children, **not** the SSH tunnel or Linux model servers.
- All four model services were actually stopped and restarted using `serve.sh`.
  CUDA GPU UUID checks passed before weights loaded; workers stayed on GPU2/GPU3.
  The cached TTS explicit warmup was 25.20 s on restart. All health checks returned200.
- Final local build and combined focused suite: **231/231 passed**. Remote build
  and the eight new local-serving tests passed. Independent review found no remaining
  important production issue after the GPU-identity fix. The harness also bounds
  waiting for its initial audio-mode command by its overall deadline.

Launch scripts, patched upstream source, example profile and repeatable test commands
are included. Both headless servers and the four model services remain running in
the isolated experiment. No original user memory or audio was used in these tests.
