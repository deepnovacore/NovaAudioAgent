# Streaming ASR replacement — 2026-09-25

Cocktail is retired at the user's request; its service has been stopped. Target
speaker filtering is explicitly out of scope for this replacement. Prior acceptance
results are historical, not evidence that the current Nova voice service is ready.
The Whisper replacement now passes prerecorded Nova production-assembly and
authenticated-server acceptance below; physical microphone/speaker acceptance remains.

## Candidate choice

Evaluate multilingual Whisper `large-v3-turbo` through **faster-whisper** first,
with `large-v3` as the accuracy comparison. Avoid English-only `.en` checkpoints
and English-focused distilled models for a Chinese/English requirement.

Faster-whisper is a CTranslate2 inference engine, not an online endpointer or a
stable-text policy. Reuse an established streaming implementation instead of
calling offline recognition independently on arbitrarily short chunks:

- [WhisperLive](https://github.com/collabora/WhisperLive): straightforward WS serving;
  tested below, but its last-segment confirmation and automatic language handling
  do not yet meet this experiment's acceptance criteria.
- [WhisperLiveKit](https://github.com/QuentinFuxa/WhisperLiveKit): next candidate for
  its SimulStreaming/AlignAtt policy; its fast encoder can introduce a second
  model representation, so memory must be measured separately. Source inspected,
  not live validated in this report.
- [WhisperStreaming](https://github.com/ufal/whisper_streaming): LocalAgreement
  alternative; upstream recommends the newer SimulStreaming project.

## Measured Turbo cost on one RTX 4090

`faster-whisper 1.2.1`, `ctranslate2 4.7.2`, beam=1, temperature=0,
condition_on_previous_text=False, VAD enabled; completed iterators measured.
The built-in turbo alias resolved to
`mobiuslabsgmbh/faster-whisper-large-v3-turbo@0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf`.

| Compute type | GPU3 sampled maximum | Warm 6.89s Chinese | Warm 11s English |
|---|---:|---:|---:|
| float16 | 2,448 MiB / 2.39 GiB | 149–151 ms | 147–162 ms |
| int8_float16 | 1,552 MiB / 1.52 GiB | 136–137 ms | 144–172 ms |

These are **offline** times for two public clips, not streaming TTFT or a corpus
accuracy benchmark. First-inference costs were recorded separately in raw JSON.
GPU memory was sampled about every 100ms; sub-interval peaks may be missed.
The Chinese clip was the previous public multi-speaker demo, so its target-speaker
reference is not an all-speakers ground truth for Whisper. Separate clean Chinese
validation uses the [FunASR public example](https://github.com/modelscope/FunASR),
and English uses [Whisper's JFK test](https://github.com/openai/whisper/tree/main/tests).

## Real-time input through WhisperLive

Pinned source: `99cbc1c33b35c372b4790975f819dfde62f3e74a`. FP16, one resident model,
100ms audio delivery cadence, VAD enabled. Timings begin at **first input audio**,
include leading silence, and exclude connection/model load (recorded separately).

With default stability threshold=10, warm clean-Chinese first nonempty partial was
**1,133ms**, but it was an unrelated hallucinated phrase. The first correct prefix
("欢迎大家") arrived at **1,553ms** from first input audio. English first partial
was **1,012ms** and matched the reference prefix. Full text eventually matched
these two clips, but no completed
segment was observed before end-of-stream cleanup. This fails finalization acceptance.
Reducing threshold to 3 gave earlier stable segments but introduced repeated words
on the English test. A short first partial is not sufficient proof of usability.

Chinese-then-English concatenation exposed severe language errors, including missing
English or output in another language. The complete-buffer Turbo probe also omitted
English with beam=5, with/without VAD, with/without `multilingual=True`, and with
explicit language. This is a synthetic language-switch test, not natural code-switch
accuracy; it is nonetheless a failure that must not be hidden by a good RTF.
Disabling timestamps did not fix it. A 5s decode window with multilingual=True
preserved both languages, but repeated a word at the boundary; a 10s window still
lost words. Thus language-aware segmentation/context is part of the required fix,
not merely a model-precision choice.

## Budget and acceptance before integration

Keep the two-GPU limit. Current LLM+TTS allocation remains about 22,100 MiB on GPU2;
Turbo adds about 1.5–2.4 GiB on GPU3 in these isolated probes. This is an enormous
reduction from the retired ASR's roughly 17.3 GiB, but does not establish that all
three services fit safely on one 24GiB card. Rebalance TTS onto the ASR card only
after measuring concurrent latency and peaks.

Require first partial and first stable text separately, sentence-final delay,
Chinese CER / English WER, language-switch preservation, partial revisions,
silence hallucinations, long-input backlog, cancellation/recovery, and per-GPU peaks.
Then repeat Nova's ASR-final → LLM-first-text → TTS-first-audio → playback timeline.
Do not treat a prerecorded replay as physical microphone/speaker acceptance.

For the future Mac target, CTranslate2's documented GPU backend is NVIDIA;
[MLX or whisper.cpp](https://github.com/QuentinFuxa/WhisperLiveKit) needs its own
Apple Silicon validation. The 4090 results do not establish 32GiB Mac feasibility.

Raw records and runnable research scripts are in the ignored
`output/local-serving-20260925/whisper/` directory; no private audio was used.

## Issue-driven follow-up and successful segmentation probe

The preceding failures are configuration/streaming-wrapper observations, not a
verdict that Whisper cannot handle Chinese and English.

- [faster-whisper #1476](https://github.com/SYSTRAN/faster-whisper/issues/1476)
  and [PR #1477](https://github.com/SYSTRAN/faster-whisper/pull/1477) identify stale
  previous-language prompt carryover. The PR is open as inspected on 2026-09-25.
  Our probes already disable previous-text conditioning, so this alone cannot
  explain or fix the observed mixed-window omission.
- [PR #1468](https://github.com/SYSTRAN/faster-whisper/pull/1468), also open,
  directly addresses missing speech at language switches using language-aware
  VAD segmentation. It is a candidate to test, not a merged/released fix.
- [WhisperLive PR #535](https://github.com/collabora/WhisperLive/pull/535)
  is merged and adds an optional transcript finalizer. The inspected version
  already includes it, but with no callback it does nothing; it does not by
  itself decode pending audio or confirm the pending final hypothesis.

A minimal independent probe kept Silero VAD speech spans separate and decoded
each span with automatic language detection, rather than concatenating all
speech into a shared decode window. Turbo int8_float16, beam=5, temperature=0,
previous-text conditioning disabled, 200ms speech padding, and either 300ms or
500ms minimum silence both recovered the entire Chinese + English reference.
A normalized exact-match assertion (punctuation/case removed) passed for both.
The 17.05s synthetic clip took 1,253ms on the first run and 795ms on the second,
including VAD and per-span language detection; this is offline processing cost,
not streaming latency, and the two runs differ in configuration/warmup.
Raw results: `output/local-serving-20260925/whisper/issue-vad-retest.json`.

This demonstrates a remedy for this sample without a larger model or precision
change. It does not establish natural within-sentence code-switch accuracy.
Next integration needs streaming provisional text within each speech span,
explicit pending-audio flush at endpoint/EOS, and fresh language detection at
utterance boundaries. Do not wait for the entire utterance before showing text.

### Same-clean-input model comparison

Additional completed measurements use the same clean 5.55s Chinese and 11s
English clips (two warm repetitions, beam=1). All four settings matched both
references after punctuation/case normalization; only two clips were evaluated.

| Model | Compute | Sampled GPU peak MiB | Chinese warm ms | English warm ms |
|---|---|---:|---:|---:|
| Turbo | float16 | 2448 | 111–116 | 153–158 |
| Turbo | int8_float16 | 1552 | 100–104 | 153–162 |
| large-v3 | float16 | 3824 | 249–348 | 304–327 |
| large-v3 | int8_float16 | 2256 | 322–324 | 364–399 |

Large-v3 also omitted English on the unsplit mixed clip. Increasing model size
alone did not resolve that probe. The segmentation remedy above was tested on
Turbo only. No new full Nova/physical microphone acceptance is claimed.

## Claude CLI independent review

Reviewed with explicitly requested `claude-opus-5-5`; CLI result metadata confirms
that model identifier. Review identified the misleading first-nonempty Chinese
latency above; raw events independently verified and the report corrected.
Proposed next path is a small utterance-scoped faster-whisper serving adapter,
reusing Nova endpointing and revisable transcript semantics. This is a proposal,
not an implemented/accepted replacement. Distinguish useful-prefix latency from
nonempty-output latency in replay evaluation.

Do not blindly apply all review suggestions: the adapter currently does emit
`volcengine.tts.first_text` for local TTS too, so the suggested telemetry mismatch
is not reproduced. Phrase blacklists can erase legitimate speech; restricting
language candidates must not turn low absolute confidence into false certainty.
Long uninterrupted speech needs an explicit bounded-buffer policy. These points
were sent back for a second review.

## Implemented streaming replacement and final acceptance

The active path is `whisper_server.py` + `StreamingAsrClient`, using the existing
ASR port. Cocktail code and reference-audio configuration were removed. CUDA FP16
Turbo is prewarmed before readiness. VAD speech spans are decoded separately,
Chinese/English language detection is refreshed, pending partial jobs coalesce,
and explicit finish decodes the pending tail before emitting one final. The
single-utterance service retains admission until cancelled CUDA work ends; client
busy retries are bounded and cancellable. Input budget is 65s including pre-roll
around the 60s speech cap, with 64KB maximum frames.

Two Claude CLI review rounds used `claude-opus-5-5` (verified result metadata).
Independent implementation review found cancellation/busy and long-frame boundary
issues; those were fixed. A failing regression also confirmed a separate Nova
endpointing bug: active low-VAD frames were permanently skipped on speech resume.
The fix preserves the owned PCM interval and emits bounded chunks. Tests cover
both 32ms and 3.2s low-VAD gaps. This is a real upstream data-loss fix; the short
public clip did not show a measurable latency gain from that fix alone.

VAD A/B on identical Chinese prefixes confirms VAD alone does not guarantee
correct early text. Both enabled and disabled settings were wrong at 1.0–1.2s
of input, and both recovered the reference prefix by 1.4s. The previously cited
0.56s VAD segment start includes padding; it must not be called a labelled speech
onset. The RMS proxy in this clip starts near 0.94s, also not a human label.

Multilingual small was measured on the same GPU in FP16: short-prefix beam-1
calls about 38–45ms versus Turbo 65–70ms, but full Chinese warm 120–127ms versus
Turbo 96–111ms. Small misspelled 达摩院 as 打摩院 on this clip. It did not establish
a useful end-to-end advantage, so Turbo remains selected. Initial full decode
was ~396ms on Turbo vs 96–111ms warm, supporting real startup inference warmup.

20ms paced standalone replay: Chinese, English, synthetic Chinese→English and
silence completed; normalized final references matched, exactly one final each.
A separate 44s accelerated input probe retained all four repeated English passages;
it verifies no truncation, not real-time backlog performance. Odd-byte rejection
and cancellation followed by a new session passed. Real microphone/noise/natural
within-sentence code-switch corpus and long real-time backlog still need coverage.
Partials are revisable and still sometimes incorrect; only final drives the LLM.

Latest Nova production-assembly replay (same 5.55s public Chinese audio):

| Metric | Observed |
|---|---:|
| First useful prefix from input start | 2031ms |
| First useful prefix from Nova speech-start event | 837ms |
| First useful prefix from RMS speech-onset proxy | 1091ms |
| Endpoint → ASR final | 407ms |
| LLM request → first text | 388ms |
| LLM request → complete text | 1331ms |
| First LLM text → first TTS text | 215ms |
| First TTS text → first audio | 257ms |
| Endpoint → first reply audio | 1270ms |
| RMS speech-end proxy → endpoint | 1379ms |
| RMS speech-end proxy → first reply audio | 2649ms |
| TTS delivery RTF / output duration | 0.523 / 7.2s |

The local semantic-extension cap changed from 2500 to 1200ms. Observed estimated
speech-end→endpoint dropped from 2725 to 1379ms; reply first audio from 4250 to
2649ms. Reply text differs, so isolate the endpoint-stage gain rather than treating
this as a controlled TTS speed comparison. Lower caps can interrupt long pauses.

The real authenticated Nova server also passed bad-token rejection, live captions,
framed audio, terminal and playback receipt checks. Renderer acknowledgements are
simulated, not physical speaker playback. GPU2 remained 22100MiB and GPU3 about
2160MiB resident during checks; these are snapshots, not simultaneous peak sampling.
No additional GPUs were used. Memory extraction/embedding routing remains local;
no fresh memory quality corpus was run in this ASR-focused change.
