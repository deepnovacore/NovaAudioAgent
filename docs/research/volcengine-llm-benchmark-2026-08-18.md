# Volcengine Realtime LLM Benchmark — 2026-08-18

## Decision

Use `doubao-seed-2-0-mini-260428` as the default Ark model for the Volcengine
realtime cascade. Keep `NOVA_AUDIO_AGENT_VOLCENGINE_ARK_MODEL` as the explicit
override.

The selected model matched the Seed 2.0 Pro baseline on every synthetic function
call category across 45 live attempts, produced zero severe failures, and reduced
both normal text and function-call latency. It then completed three full
ASR → LLM → TTS smoke runs.

No runtime model router or automatic fallback was added.

## Method

The live evaluator used the production Ark Responses request contract:

- thinking disabled;
- `parallel_tool_calls=false`;
- `store=true` and original `call_id` continuation;
- production frontend instructions;
- synthetic Chinese inputs and fake local tool results only.

Scoring covered tool selection, expected no-call behavior, clarification, similar
tools, nested and unsupported arguments, mixed prose/tool output, continuation,
and short multi-turn context. Reports retained only aggregate scores, sanitized
error classes, and timings.

## Initial Matrix

Two repetitions per case, 18 first-turn attempts per model:

| Model | Pass rate | Severe failures | First text p50 | Function call p50 | Function call p95 |
|---|---:|---:|---:|---:|---:|
| Seed 2.0 Pro | 100% | 0 | 1243 ms | 2346 ms | 3679 ms |
| Seed 2.1 Pro | 94.4% | 1 | 654 ms | 1444 ms | 2435 ms |
| Seed 2.1 Turbo | 94.4% | 1 | 1994 ms | 2993 ms | 4181 ms |
| DeepSeek V4 Pro GA | 55.6% | 8 | 959 ms | 1577 ms | 1789 ms |
| DeepSeek V4 Flash GA | 66.7% | 6 | 1117 ms | 1752 ms | 3894 ms |
| Seed 2.0 Lite | 100% | 0 | 1612 ms | 1903 ms | 7080 ms |

Seed 2.1 Pro's failure was reproduced in a focused five-run parameter test: it
occasionally emitted prose before an otherwise correct, schema-valid function
call. Adding an explicit tool-only instruction still produced one mixed response
in ten attempts, so it did not pass the production contract gate.

## Second-Stage Matrix

Two repetitions per case, 18 attempts per model:

| Model | Pass rate | Severe failures | First text p50 | Function call p50 | Function call p95 |
|---|---:|---:|---:|---:|---:|
| Seed 2.0 Pro | 100% | 0 | 1329 ms | 1979 ms | 3121 ms |
| Seed 1.6 Flash | 77.8% | 4 | 390 ms | 632 ms | 1151 ms |
| Seed 1.8 | 0% | 18 | — | — | — |
| GLM 5.2 | 77.8% | 4 | 1313 ms | 1786 ms | 2895 ms |
| Kimi K2 | 0% | 18 | — | — | — |

Seed 1.8 and Kimi K2 returned sanitized `ArkResponsesError` for every request under
the production Responses contract. Faster Seed 1.6 Flash did not meet the quality
gate.

## Final Pro vs Mini Matrix

Five repetitions per case, 45 attempts per model:

| Metric | Seed 2.0 Pro | Seed 2.0 Mini | Change |
|---|---:|---:|---:|
| Overall pass rate | 100% | 100% | equal |
| Severe failures | 0 | 0 | equal |
| First text p50 | 1511 ms | 686 ms | -55% |
| First text p95 | 2416 ms | 1282 ms | -47% |
| Function call p50 | 2208 ms | 710 ms | -68% |
| Function call p95 | 3502 ms | 1149 ms | -67% |
| Continuation first text p50 | 1491 ms | 699 ms | -53% |
| Continuation first text p95 | 2153 ms | 999 ms | -54% |

Both models passed every category at 100%. Mini was therefore the fastest model
that satisfied the non-inferiority gate.

## Full Speech Smoke with Mini

Three live runs using a bounded synthetic mono 16 kHz PCM16 utterance:

| Stage | p50 | p95 |
|---|---:|---:|
| Speech end → ASR final | 123 ms | 149 ms |
| ASR final → LLM first text | 744 ms | 881 ms |
| LLM first text → TTS first audio | 548 ms | 578 ms |
| Speech end → TTS first audio | 1431 ms | 1563 ms |

The previous single Pro smoke measured about 2524 ms from ASR final to first text
and 3312 ms from speech end to first TTS audio. Because that older baseline had one
run, the model matrix—not this cross-run comparison—is the primary selection
evidence.

## Cache Probe

Five identical Seed 2.0 Pro Responses requests, each with an 1824-token input,
reported zero cached input tokens. Total request latency ranged from about 2.6 to
3.9 seconds. Automatic prefix caching was therefore not adopted as a latency fix.

Ark officially supports Responses function calls and `function_call_output`
continuations, and documents context caching as a separate performance feature:

- <https://www.volcengine.com/docs/82379/1958524?lang=zh>
- <https://www.volcengine.com/docs/82379/1602228?lang=zh>
