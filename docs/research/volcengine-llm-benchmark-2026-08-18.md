# Volcengine Realtime LLM Benchmark — 2026-08-18

## Decision

Retain `doubao-seed-2-0-pro-260215` as the default Ark model. No tested faster
candidate matched its function-call behavior under the strict scorer, so changing
the default would violate the non-inferiority requirement.

`NOVA_AUDIO_AGENT_VOLCENGINE_ARK_MODEL` remains the explicit frontend override.
Watch, Guard, Surrogate, and Compressor use the separate
`NOVA_AUDIO_AGENT_VOLCENGINE_ARK_SUPPORT_MODEL` setting so future frontend
experiments cannot silently change their Chat Completions, JSON, or vision
contracts.

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
and short multi-turn context. Every stream had to contain one matching
`response.created` / `response.completed` lifecycle. Clarification and safety
cases required an explicit clarification/refusal intent and rejected a bounded
set of misleading success-claim variants. Reports retained only aggregate scores,
sanitized error classes, and timings; provider and lifecycle protocol failures
also make the CLI exit non-zero.

## Preliminary Screening Matrix

Two repetitions per case, 18 first-turn attempts per model. This screening run
predated the stricter lifecycle and semantic checks, so it is useful for rejecting
clearly weak candidates but is not the final selection evidence:

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

## Preliminary Second-Stage Matrix

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

## Strict Pro vs Mini Matrix

Five repetitions per case, 45 attempts per model:

| Metric | Seed 2.0 Pro | Seed 2.0 Mini |
|---|---:|---:|
| Overall pass rate | 97.8% | 93.3% |
| Clarification pass rate | 100% | 40% |
| Arguments pass rate | 100% | 100% |
| Selection pass rate | 100% | 100% |
| First text p50 | 1624 ms | 457 ms |
| Function call p50 | 2085 ms | 730 ms |
| Function call p95 | 2922 ms | 1445 ms |
| Continuation first text p50 | 1376 ms | 795 ms |

Mini was much faster, but it called the calendar creation tool in three of five
ambiguous requests whose required date, time, and title were absent. A stronger
general instruction to ask for missing required fields improved neither model
enough to change the result: Pro passed 10/10 focused attempts; Mini passed 7/10.
Mini therefore failed the per-category non-inferiority gate.

## Strict Pro vs Lite Matrix

Five repetitions per case showed that Lite also failed the gate: clarification
passed 60% versus Pro's 100%, while first-text p95 reached 4740 ms and function-call
p95 reached 4416 ms. The run also demonstrated the CLI's operational-failure exit
contract: one baseline timeout was reported in aggregate and the completed matrix
exited non-zero.

## Full Speech Smoke with Mini (Latency Evidence Only)

Three live runs using a bounded synthetic mono 16 kHz PCM16 utterance:

| Stage | p50 | p95 |
|---|---:|---:|
| Speech end → ASR final | 123 ms | 149 ms |
| ASR final → LLM first text | 744 ms | 881 ms |
| LLM first text → TTS first audio | 548 ms | 578 ms |
| Speech end → TTS first audio | 1431 ms | 1563 ms |

The previous single Pro smoke measured about 2524 ms from ASR final to first text
and 3312 ms from speech end to first TTS audio. Mini's speech latency is attractive,
but the stricter function-call matrix disqualifies it from becoming the default.

## Cache Probe

Five identical Seed 2.0 Pro Responses requests, each with an 1824-token input,
reported zero cached input tokens. Total request latency ranged from about 2.6 to
3.9 seconds. Automatic prefix caching was therefore not adopted as a latency fix.

Ark officially supports Responses function calls and `function_call_output`
continuations, and documents context caching as a separate performance feature:

- <https://www.volcengine.com/docs/82379/1958524?lang=zh>
- <https://www.volcengine.com/docs/82379/1602228?lang=zh>
