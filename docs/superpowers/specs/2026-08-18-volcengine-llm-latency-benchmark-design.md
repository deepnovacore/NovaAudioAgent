# Volcengine Realtime LLM Latency Benchmark Design

## Goal

Reduce the `ASR final -> LLM output` portion of the Volcengine cascaded realtime
pipeline without weakening function-call reliability. The current live baseline is
`doubao-seed-2-0-pro-260215`; one measured speech turn spent about 2.52 seconds
between ASR final and the first LLM text event, while ASR finalization itself took
about 145 milliseconds.

This work evaluates model and request-shape changes. It does not change VAD, ASR,
TTS, playback fencing, or add runtime automatic failover.

## Candidates

The live benchmark compares models that the configured Ark account exposes:

- `doubao-seed-2-0-pro-260215` (quality and latency baseline)
- `doubao-seed-2-1-pro-260628`
- `doubao-seed-2-1-turbo-260628`
- `deepseek-v4-pro-ga-260813`
- `deepseek-v4-flash-ga-260731`
- `doubao-seed-2-0-lite-260428` (speed lower-bound candidate)

If none of those candidates is both non-inferior and repeatably faster, run a
second-stage matrix against these additional account-visible models:

- `doubao-seed-1-6-flash-250828`
- `doubao-seed-1-8-251228`
- `glm-5-2-260617`
- `kimi-k2-250905`

The same gates apply; older or third-party model families receive no relaxed
scoring or protocol exceptions.

DeepSeek candidates are not assumed to support the current Ark Responses contract.
Protocol incompatibility is recorded as a benchmark result, not worked around in
the evaluator. A separate Chat Completions adapter will be considered only if a
DeepSeek model passes the quality and latency gates materially better than the
Responses-compatible candidates.

## Evaluation Corpus

The evaluator uses deterministic, synthetic Chinese requests and local fake tool
results. It never sends microphone audio, credentials, repository contents, or full
production conversations. Cases cover:

1. selecting the single correct tool;
2. refusing to call a tool for an ordinary conversational request;
3. asking for clarification when a required value is genuinely ambiguous;
4. choosing between similarly named tools;
5. producing enums, arrays, booleans, numbers, and nested objects that satisfy JSON
   Schema;
6. resisting instructions to invent a tool or inject unsupported arguments;
7. returning no prose alongside a function call;
8. accepting `function_call_output` with the original `call_id` and producing the
   expected continuation;
9. maintaining the same behavior in a short multi-turn context.

Cases are repeated to expose nondeterministic misses. Expected outcomes are checked
structurally: tool name, required arguments, argument values or predicates, JSON
Schema validity, no-call behavior, mixed text/tool output, and successful
continuation. Natural-language continuation text is checked using bounded semantic
facts rather than exact wording.

## Metrics and Gates

For each request, the evaluator records only content-free metadata:

- request accepted to `response.created`;
- request accepted to first text delta;
- request accepted to completed `function_call`;
- continuation request to first text delta;
- terminal status and sanitized error class;
- correctness flags for tool selection, arguments, no-call behavior, mixed output,
  and continuation.

Reports show counts and p50/p95 latency per model and case class. Raw prompts,
arguments, tool output, response text, API keys, and response bodies are not logged.

A candidate may replace the baseline only when:

- its overall and per-category function-call pass rates are not below the measured
  Seed 2.0 Pro baseline;
- it introduces no severe failure such as an invented tool, unexpected side-effect
  call, invalid argument object, mixed prose/tool response, or broken continuation;
- its latency improvement is repeatable rather than a single-run result;
- it works through the production Ark request contract with thinking disabled,
  `parallel_tool_calls=false`, `store=true`, and `previous_response_id`.

If no candidate passes, the production model remains unchanged.

## Request-Shape Experiment

The baseline model also runs with a compact equivalent instruction/tool contract.
The compact form may remove repetition and descriptions that do not affect tool
selection, but it must preserve all safety, argument, and side-effect constraints.
Where Ark supports it, stable prefix/context caching is measured separately.
Prompt or schema compaction is adopted only under the same quality gate as a model
change.

## Implementation Shape

Add a reusable benchmark module plus an explicitly opt-in CLI. The module owns the
case definitions, structural scoring, sanitized timing records, aggregation, and
machine-readable report model. Provider I/O is injected so default tests use fake
Responses streams and run without credentials or network access.

The live CLI requires `--live`, reads `ARK_API_KEY` from the environment, validates
an explicit model allowlist, limits repetitions, and emits only aggregate metadata.
It exits non-zero on malformed provider output but represents a model-level protocol
failure in the report so one incompatible candidate does not abort the matrix.

After a candidate passes the evaluator, run the existing speech smoke probe with
that model to confirm the complete `speech end -> ASR final -> LLM -> TTS first
audio` path. The configured default changes only after both stages pass.

## Tests

Default CI covers scoring for correct calls, wrong tools, invalid/missing arguments,
no-call cases, mixed output, continuation, sanitized failures, percentile
aggregation, model allowlisting, and the mandatory `--live` guard. Fake streams also
verify that every candidate receives an equivalent request contract.

Live tests are opt-in and never run in default CI.
