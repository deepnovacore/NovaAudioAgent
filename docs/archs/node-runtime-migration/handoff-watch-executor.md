# Handoff: the executor stage

Written 2026-08-20 at `c39a524` on `rewrite/node-typescript-runtime`, 67 commits past the
differential baseline `f452077`. Read this before touching anything under `runtime/src/executors/`.

The realtime stage is finished: all fourteen `service.py` families are ported with zero
`NotYetPortedError`, plus the desktop wire format and socket bridge. What remains is the executor
stage, and this document is about where it stands and what to do next.

## Where to work

```
cd /Users/fishwowater/sqxh/nova-audio-agent/.worktrees/node-typescript-runtime
```

Branch `rewrite/node-typescript-runtime`. The pre-rewrite Python oracle is a clean checkout at
`../codex-multi-workspace`. Talk to the user in Chinese; keep everything inside the repo -- commit
messages, these docs, code comments -- in English.

## State

| Executor | Python | Node | Differential | Wired into assembly |
|---|---|---|---|---|
| `search` | 395 | 534 | sweep + two review rounds, closed | **no** |
| `watch` / `guard` | 501 | 661 | 84 golden cases + 16 Node tests, 18/18 mutations | **no** |
| `cam` | 528 | — | — | — |
| Codex family | 5,574 across 8 files | — | — | — |
| `autoglm` | 761 across 2 | — | — | — |
| `home_assistant` | 346 | — | — | — |

Full gate at `c39a524`, all green: ruff (266 files), `npm run check`, `npm run build`,
`scripts/watcher_oracle.py check` (84 cases), 563 runtime tests, 299 desktop tests, 2,848 pytest.

## Read this before you wire anything

**Neither ported executor satisfies the registry interface.** I found this by attempting the
assembly wiring, getting four type errors, and reverting it -- the revert is why `assembly.ts` is
untouched at `c39a524`. The wiring is maybe an hour of work, but only after a decision that is not
mine to make alone.

Both `search.ts` and `watcher.ts` declare their **own structural context and handoff types**
(`SearchDispatchContext`, `WatchDispatchContext`, `SearchHandoff`, `WatchHandoff`,
`ModelGatewayLike`) rather than importing `ExecutorAdapter` and `ExecutorDispatchContext` from
`causal-runtime.ts`. They were written against invented interfaces that happen to resemble the real
ones. Specifically:

1. **`dispatch`'s request type.** Adapters take `Record<string, unknown>`; the registry passes
   `Readonly<Record<string, JsonValue>>`.

2. **`observe` is optional in the oracle and required in Node.** `ports.py:301` declares
   `observe: Callable[[ObservationPayload], None] | None = None`, and `watcher.py:213` returns
   `unknown('observation_unavailable')` when it is absent -- a real, tested branch. Node's
   `ExecutorDispatchContext.observe` (`causal-runtime.ts:36`) is required, so that branch is
   unreachable once the adapter takes the real type. **Decide deliberately:** either widen Node's
   context to match the oracle, or record it as an intentional divergence and drop the guard. Do not
   let it resolve itself by leaving the adapter on its private type.

3. **`ModelGatewayLike` does not match `ModelGateway`.** The adapter passes
   `images: [{name, mediaType, payload}]`; `GatewayImage` (`model-gateway.ts:34`) is
   `{ref, media_type, payload}`. The oracle constructs `GatewayImage("watch-frame", ...)`
   positionally, so field one is `ref`, not `name`. Also `jsonSchema` is
   `Record<string, unknown>` on the adapter and `Readonly<Record<string, JsonValue>> | null` on the
   gateway.

4. **`watch` and `guard` are not configuration-selectable.** I assumed they were and gated them on
   `settings.executors`, which was wrong. `executorNameSchema` (`config.ts:6`) lists exactly the
   five names `config.py:166` does, and `watch`/`guard` are in neither. The oracle registers them
   unconditionally: `adapters = (search, camera, watch, guard, *active_adapters)`
   (`assembly.py:841`). Do the same -- do **not** add them to the enum.

Because of (2) and (3), fixing this properly means touching the committed, green `search.ts` too.
That is the right call, but it is a change to reviewed code and should be its own commit.

### What the wiring looks like once that is settled

The gateway must be constructed **before** `resolveExecutors`, because Watch classifies frames
through it -- the oracle's order too (`assembly.py:803` before `:822`). In `buildAssembly` the
gateway is currently built after (`assembly.ts:124` then `:130`); moving it up is behaviour-neutral.

`runtime/src/executors/frame-source.ts` already exists and is committed: it holds
`DisabledFrameSource`, whose `snapshot()` returns `null`, matching `camera.py:75`. A host with no
camera gets `capture_unavailable` from every window, which is the oracle's own answer for an
unconfigured camera -- truthful, not a placeholder. The capturing sources (`OpenCVFrameSource`,
`VideoFileFrameSource`, and the `resolve_camera_source` policy that picks between them) land with
the Camera executor.

Watch and Guard must **share one `MediaStore` and one `FrameSource`**: they share a camera, and a
frame stored by Watch has to stay citable when Guard is the one that announced it. Model resolution
is `(settings.watch_model ?? '').trim() || settings.fast_model` (`assembly.py:812`).

## Roadmap

**1. Close the executor interface gap** (small, but blocks everything below). The four items above.
Ends with `watch`, `guard`, and `search` constructed in `buildAssembly` and reaching the model.

**2. Camera** (528 lines). Wanted next because Watch is degraded without it -- `DisabledFrameSource`
is honest but it is not a camera. Contains `resolve_camera_source`, the two capturing sources, and
`CamAdapter`. `VideoFileFrameSource` needs the `prepare_observation`/`restart` hook Guard passes
(`assembly.py:838`): file replay has one mutable playhead, so Guard rewinds before each observation
to keep file-backed evaluations deterministic. `WatchAdapter` already accepts `prepareObservation`.
The capturing sources need real hardware to verify, so expect a human-only acceptance step.

**3. The Codex family** (5,574 lines across eight files) -- by far the largest remaining unit, bigger
than `service.py` was. Suggested order, each its own review: `codex_jsonl` (134) and
`codex_app_server_protocol` (836) first since they are pure format; then `codex_transport` (1,026);
then `codex_app_server` (1,579); then `codex.py` (920), `codex_preflight` (883),
`codex_projects` (1,201), and the two live modules (1,021). Do not start this without a fixture plan
-- it is where the oracle-differential method pays for itself most, and where skipping it will hurt
worst.

**4. `autoglm` (761) and `home_assistant` (346)** -- smallest, independent, good for recovering
momentum between the Codex batches.

## Method notes that cost me time this session

**A sweep that cannot distinguish "tool missing" from "mutation detected" is worse than no sweep.**
`timeout` does not exist on this machine -- no coreutils, no `gtimeout` -- so every `timeout 90 node
--test` exited 127 with no output, and the sweep script read "no result" as "detected". That voided
commit `03d9843`'s claim of 21/21; the real number was 6/14, retracted in `36b6266`. Use a bounded
runner that reports timeout as its own outcome. `/tmp/run_bounded.mjs` in this session's transcript
is twenty lines and does the job; it is not committed, so write it again.

**A sweep must restore the source even when it dies.** This session opened with a genuine off-by-one
in shipped code -- `captureFailures > MAX_CONSECUTIVE_FAILURES` -- which turned out to be the
previous run's own mutant, left applied when the command timed out mid-sweep. It cost an hour of
diagnosis. Restore in a `finally`, and diff against a known-good copy before trusting the tree.

**Bound every await in a test that drives a loop.** The off-by-one made tests *hang* rather than
fail. A hang starves the suite and is indistinguishable from a crashed runner. `settle()` in
`executors-watcher.test.ts` is the pattern: pump a bounded number of rounds, then `assert.fail` with
a name. It turned a 90-second timeout into a one-second named failure.

**A guard nothing distinguishes is either dead code or a hole in the scenario set -- and you must
say which.** The `capture-failures-cumulative` mutant survived because `frameSource({failures: n})`
could only produce *n consecutive* failures, making consecutive and cumulative counting identical.
The test named "and a recovery resets the count" was not testing that half at all. An explicit
failure pattern fixed it. Separately, `reset-count-not-cleared` survives and always will: it is
overwritten two lines later and is dead in the oracle too (`watcher.py:305`). That one is annotated
in place rather than counted as a detection.

**A correction that is not extracted gets rediscovered.** `.trim()` for Python `.strip()` has now
been fixed three times -- `recall.ts`, then `search.ts`, then three sites in `watcher.ts` -- despite
`stripLikePython` existing in `python-text.ts` since the second time. Same for `.length` versus
`len()`. When porting any new file, grep it for `.trim()`, `.length`, `localeCompare`, and bare
number rendering *before* writing tests, not after.

**Verify every regression test by reverting the fix.** Every defect claimed in `c39a524` was
confirmed this way. It is also how the harness bug above surfaced.

**Never put a gate and a commit in the same shell command.** A build-failing commit once landed
because `&&` after the gate ignored its exit code.

## Still open elsewhere

- Backlog items needing new fixture capability: 8 continuation mutations (need two concurrent
  batches), family L 5 survivors, K 2, I 5.
- Human-only blocker, unchanged since Stage 1:
  `npm run smoke:node-backend --workspace @nova-audio-agent/ambient-orb` needs a real WindowServer.
  Not passing until someone runs it.
- `parity-matrix.md` has no row for the executor family yet. Add one when the wiring lands, not
  before -- a row claiming `watch` is ported while nothing constructs it would be read as working.
