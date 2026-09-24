# Streaming ASR replacement — 2026-09-25

Cocktail is retired at the user's request; its service has been stopped. Target
speaker filtering is explicitly out of scope for this replacement. Prior acceptance
results are historical, not evidence that the current Nova voice service is ready.
No replacement has yet passed complete Nova end-to-end acceptance.

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

With default stability threshold=10, warm clean-Chinese first partial was **1,133ms**;
English was **1,012ms**. Full text was correct on these two clips, but no completed
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
