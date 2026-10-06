# ACP progress/compressor acceptance — 2026-10-06

## Change

- Generic fix preserved separately on `feature/bound-progress-compression` (`f49f4757`), based on `v0.3.0dev`.
- ACP integration is on `feature/acp-progress-compression`, including the current `v0.4.0dev` public changes. No internal branch was merged and nothing was pushed.
- Cascaded Qwen keeps `qwen-flash` for compression. Other providers replace that default with their selected model; custom compressor models and generic gateway configuration are preserved.
- Blackboard progress rows and model wakes occur only when phase or summary changes. Latest counters remain in process memory. Delegate termination and conversation reset clear this state.
- Every channel waits at least 60 seconds after compression completion before another compression. Both append-triggered and completion-triggered scheduling respect the limit. Pending work resumes even without another input event. Full retained-window compression is unchanged.
- ACP receives every update but reports the first activity, the latest activity at `CODEX_WORKING_INTERVAL` boundaries (default 30 seconds, valid 5–600), and the unreported tail when a prompt response arrives. History replay and updates after cancellation do not emit progress. Cancellation/failure reports its terminal outcome rather than a late progress flush. Tool observations and naming callbacks are not throttled.

## Live method and scope

Real OpenCode 1.18.31 ACP processes, `CodexLiveAdapter`, `CausalRuntime`, and `GatewayCompressor` were exercised. Both sides used `qwen-flash`, intentionally excluding the additional price difference of the former `qwen3-max` override. Baseline `d425dcb5` was independently extracted with `git archive` and compiled, with its entire runtime module graph loaded from that build. Reports record the loaded core/driver/transport SHA256 hashes. This is an instrumented runtime acceptance, not a GUI, microphone, installed-app, or all-backend test.

The task writes and reads an exactly verified 80-row squares CSV, then streams 80 explanatory bullets. Both sides start with the same 120 synthetic, already-compressed retained records and the actual Codex watermark of 5. Retained text is deliberately substantial to expose repeated full-window compression; there is no personal blackboard data. New work receives a fresh temporary cwd and XDG configuration/data directories. OpenCode uses a loopback proxy; the real provider key stays in the parent process and is not written into the child configuration. Native external-directory access and shell execution are denied. The final harness limits write approvals to disclosed paths in the test workspace and caps approval offers at 8. OpenCode 1.18.31 sends pathless read approvals; read scope therefore relies on its native external-directory denial, not independent ACP path verification. This is not an OS sandbox claim.

Budget: at most 8 OpenCode backend calls (4096 output tokens each), 6 host compressor calls, one bounded foreground-verification call (128 output tokens), and a 180-second run deadline. These are separate host/backend limits. Hitting the compressor cap fails acceptance rather than being treated as a valid comparison.

## Successful paired runs

| Metric | Before 1 | After 1 | Before 2 | After 2 |
|---|---:|---:|---:|---:|
| ACP updates counted in completion | 504 | 545 | 408 | 504 |
| Progress callbacks | 504 | 8 | 408 | 7 |
| Compressor requests | 4 | 0 | 4 | 0 |
| Compressor input tokens | 179,232 | 0 | 164,732 | 0 |
| Compressor share of measured input | 80.4% | 0% | 84.8% | 0% |

The measured denominator includes Nova host gateway calls plus recorded OpenCode session input/cache-read tokens. OpenCode auxiliary calls without session token records are excluded. Host-only compressor shares were 99.66% and 99.63% before, 0% after. These percentages describe this synthetic workload, **not** the user's original 91% session, prices, or every future coding workload. The model generated different streams in each run; preservation means each run's last reported count matches its own completion count, not that separate runs must generate identical update counts.

Both pairs passed the offline comparison gate: successful artifact validation, no budget truncation, distinct old/new reducer and transport hashes, >90% callback and compressor-input reduction, bounded callback frequency, complete final activity counters, and successful resume/cancel checks. Real phase/summary changes may still legitimately trigger compression; the deterministic 1000-event tests verify that case's cooldown.

All observed backend responses were HTTP 200 and all recorded host model calls had `error_type=null`. No HTTP 400 occurred in either valid baseline or fixed runs. The original HTTP 400 was not reproduced, so this does not establish its independent root cause or guarantee that every provider-side 400 is resolved.

## Integration and lifecycle

After integrating the newer ACP tool-observation/diagnostic changes from `931a059c`, a further real run passed: 404 updates, 6 progress callbacks, 0 compressor calls. The task artifact was correct; loading the same session wrote the exact resume marker without altering the original CSV; cancelling a subsequent prompt returned an uncertain/non-completed outcome and observed process teardown. Cancellation code `adapter_timeout` is the existing cancellation mapping, not an acceptance timeout.

A further merge of the public `v0.3.0dev` updates (`ecb7d1e7`) retained these changes. The final build on `fd09adad` passed the same live task with 5 callbacks and 0 compressor calls; artifact validation, session resume and cancellation also passed with the stricter final approval handler. See `after-final-tip.json`.

## Automated checks and review

- Regression first demonstrated 1000 progress updates causing 1000 callbacks on the old transport.
- 122 ACP/core/oracle/blackboard regression checks passed before integration.
- 126 integrated ACP/core checks passed, including tool observation contracts, history replay suppression, actual late updates sent after cancellation, first + timed + terminal emissions, and 1000-row compression limits.
- Final-tip TypeScript build, 116 ACP/core tests, the provider/compressor override integration test, and changed-file ESLint passed. These counts describe separate runs, not a sum of unique tests.
- The previous mem0 failures were traced to a missing native SQLite binding in temporary dependencies. Reusing the already installed matching binding made all 9 mem0-store tests pass, without changing manifests or lockfiles.
- A broader runtime run observed `real Midscene: timeout` failing its approval-count assertion. It passed in the untouched baseline and the final-tip isolated reruns; this appears timing-sensitive, not a proven ACP regression. The broad run was stopped when upstream branch integration changed its source/fixture tree, so **no complete all-repository green suite is claimed**. Desktop/CLI suites were not part of the final focused pass.
- Local Claude CLI with `claude-sonnet-5-5` reviewed the implementation and integration. It found no transport correctness blocker. Its concrete test gaps and experiment-isolation issues were addressed. Two paired runs remain empirical checks rather than a statistical performance claim.

## Reproduce

Build an isolated checkout of baseline `d425dcb5` and this branch with their declared dependencies (`npm run build --workspace @nova-audio-agent/runtime`). Keep credentials in a private env file, outside this repository.

```sh
NOVA_LIVE_ACP_COST=1 NOVA_ACP_BASELINE_DIST=/absolute/baseline/runtime/dist \
  node --env-file=/absolute/private.env runtime/scripts/live/acp-compression.mjs before
NOVA_LIVE_ACP_COST=1 \
  node --env-file=/absolute/private.env runtime/scripts/live/acp-compression.mjs after
node runtime/scripts/live/acp-compression-compare.mjs /absolute/before/report.json /absolute/after/report.json
```

`NOVA_ACP_AFTER_DIST` selects a separately built integration output. Logs emit safe `model_call` metrics; reports include module hashes, actual counts, token records and lifecycle outcomes. Do not interpret stale `dist` output as the current source: rebuild before running. The baseline ref annotation is not a build attestation; the independent build commands and recorded module hashes are the evidence in this run.

The compact per-run JSON reports are kept locally in the ignored `docs/internal/` directory, not in the repository; regenerate them with the live scripts named in this document. Initial exploratory runs with an ambiguous row count or relative output path failed artifact validation and were excluded from the successful comparison.
