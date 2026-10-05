# v0.4 coding project live acceptance

This is a live acceptance ledger, not a claim that the backends have passed.
Baseline: `v0.4.0dev@d425dcb5`. Each run uses an empty managed project and separate
Nova state. Codex is an app-server regression case; the four other backends use ACP.

## Shared project request

Create a new workspace named `Tetris-<backend>-<run>`. Implement a playable browser
Tetris game in `index.html`, with no external dependencies. Include a 10×20 board,
seven tetrominoes, left/right movement, rotation, soft and hard drop, collision and
locking, line clearing, score, game over, and restart. Include visible controls and
instructions. Only work in the newly confirmed workspace. Read the finished files
and run meaningful checks before reporting the result. Do not modify other projects,
install dependencies, publish, or access external accounts. This request does not
pre-authorize unrelated actions or global configuration changes.

After the initial delivery, resume the same session to add pause/resume. Switch the
new-session default to another backend first, then verify the old session still
uses its original backend and profile.

## Evidence and gates

- Production conversation → project confirmation → Task → bound backend execution
  → result → Nova verification. Preserve Task/session/workspace IDs and event times.
- Independent browser observations: move, rotate, fall, lock, clear a line/score,
  game over, restart. A source scan or model statement is not a browser pass.
- Preserve original project output and hashes. Do not repair generated game code
  manually and then attribute it to the backend; send corrections through Nova.
- Exercise reject and cancel separately. Check files/processes after cancellation.
  Unsupported capabilities must return an explicit failure, not fall back silently.
- Pi is tested in explicitly selected full mode; Ask must refuse. This is a
  capability limitation, not a successful per-tool approval test.
- Record startup/authentication/process failures, session recovery, installed
  versions, selected model, permission mode, and every failed attempt.
- Distinguish the runtime text path from desktop UI, physical voice, and packaged
  application acceptance. Each requires separate observations.

## Driver

`runtime/scripts/live/coding-project.mjs` constructs the production composition and
accepts JSON-line user actions. It never auto-approves and never computes a passed
verdict. Run only with `NOVA_LIVE_PROJECT_EXECUTE=1`, explicit backend and an isolated
output directory, using the desktop's Electron Node runtime and native resources.
Load credentials through the existing local environment; never commit them or raw
private reports. The report records the real personal-agent snapshot and actions.

Initial local evidence directory: `/private/tmp/nova-v040-acceptance/`.

## 2026-10-04 result: NOT ACCEPTED

All four ACP backends, plus the Codex app-server regression case, created a real
Tetris `index.html` through the production composition's conversation → project
confirmation → Task → managed workspace path. The operator did not write or repair
the game sources. Independent browser checks passed for movement, rotation, soft
drop, hard-drop locking, line clearing/score, game over, and restart.

This does **not** establish a clean end-to-end project pass: no recorded Task reached
`completed`. Some initial dispatches required an explicit developer-assisted
`host.dispatch` instruction after natural-language turns merely promised action.

| Backend / run | Mode | Generated game/browser | Nova Task result | Resume after default switch | Final gate |
|---|---|---|---|---|---|
| OpenCode / `opencode-full-06` | Full | passed | `server_rejected`, then `task_effect_unknown` | not exercised after unknown effect | NOT ACCEPTED |
| CodeBuddy / `codebuddy-full-02` | Full | passed | verifier lacks recognized bound check | promise, then plan generation failure; no new work | NOT ACCEPTED |
| Pi / `pi-02` | Full | passed | correction ended `invalid_worker_result`, then `task_effect_unknown` | stale proposal / unresolved session; no new work | NOT ACCEPTED |
| DeepSeek Harness / `deepseek-02` | Ask | passed | verifier lacks recognized bound check | asks for project/session despite supplied name and ID | NOT ACCEPTED |
| Codex / `codex-01` | Ask | passed | verifier lacks recognized bound check | not exercised | NOT ACCEPTED |

Versions observed: OpenCode 1.18.31, CodeBuddy 2.154.0, Pi 0.84.2 with pi-acp
0.0.33, DSH 0.1.5-rc.2, Codex 0.155.1. The production front/support model used
`qwen-plus`. Native backend model settings were retained, not silently replaced.
These are observations from this environment, not compatibility promises.

### Defects and remediation

1. The baseline ACP transport did not emit completed tool observations. Task
   verification therefore saw final prose and activity counts but no execution
   evidence. The local patch now forwards bounded, redacted, current-turn tool
   results with session/turn/item identity; ignores reasoning/history; de-duplicates
   completed notifications; and separates interim narration from final replies.
2. Generic ACP tool notifications alone do not satisfy the verifier's command
   contract. The patch normalizes OpenCode's explicit process metadata and Pi's
   terminal output/exit extensions to `commandExecution`. Real OpenCode and Pi
   smoke runs both returned `NOVA_LIVE_CHECK_PASS` with exit code 0. The subsequent
   patch also recognizes CodeBuddy's explicit command/exit footer and DSH's native
   foreground bash result contract (nonzero status is an explicit suffix; timeout,
   signal, background and truncation are not accepted as successful checks).
3. Natural-language initial dispatch and existing-session resolution were
   unreliable. CodeBuddy/Codex needed explicit dispatch guidance; follow-up
   requests for DeepSeek, CodeBuddy and Pi did not launch resumed work even after
   supplying the recorded session ID. Backend binding across a default change
   therefore remains **unverified**, not passed.
4. OpenCode's unknown execution result and Pi's invalid worker result need separate
   diagnosis. The browser artifacts prove existing effects; they do not authorize
   replay or prove Task completion. Codex reported checks against an in-memory
   source/DOM simulation; Nova did not receive an acceptable bound readback.

The full project runs in the table used the intermediate observation-forwarding
patch (built transport SHA-256 recorded in the manifest). The final OpenCode/Pi
normalization patch has automated and real-transport smoke coverage, **not a fresh
full Tetris project pass**. Do not attribute the live table to the unmodified branch
or retroactively upgrade the earlier outcomes.

### Follow-up debugging and reruns

- A native Pi transcript records `ENOSPC: no space left on device, write`.
  Its ACP bridge returned `end_turn` despite the model error. Empty final replies
  now fail explicitly instead of becoming a misleading invalid worker result.
- The Codex work order contained a model-invented prohibition on shell/browser
  execution. Stated constraints now require source spans from actual user text;
  assistant text cannot authorize or strengthen restrictions.
- Continuation recognition now admits named projects and does not interpret
  unrelated restrictions such as “不要新建工作区” as negation of the requested session.
- Round 3 CodeBuddy generated a new game, with genuine normalized command events,
  then the host closed its connection before game checks. A regression reproduces
  `transport_lost` after 8 MB of legal streamed messages. The limit now applies to
  each NDJSON frame, not cumulative session traffic; oversized frames still fail.
- Current focused verification: 162 ACP/intake tests and 45 model-adapter/Task-loop
  tests pass; lint of the changed TypeScript files passes. These do not establish
  a completed live project.
- Round 3/4 reruns are retained under `/private/tmp/nova-v040-round3/` and
  `/private/tmp/nova-v040-round4/`, with copies in the gitignored evidence bundle.
  Final result: still zero completed Tasks. Round 4 did not reach backend execution:
  natural prompts produced promises without calls, and assisted follow-ups hit
  requirement validation, deadlines or network failures. The local fetch diagnostic
  captured `ECONNRESET`; changing only the isolated front/support model to
  `qwen3-max` also encountered resets and did not establish a successful alternative.
  All live drivers were stopped. Recovered uncertain tasks have not been attested successful
  or manually marked complete. A Qwen3 Max front/support configuration is a
  separately labelled experiment, not a change to the default model.
- `followup-results.json` retains the eight round 3/4 reports and build hashes.
  `nova-stream-tests.log` and `nova-verifier-tests.log` retain the 207 passing tests.
  A generic consultation with local `claude --model claude-sonnet-5-5` suggested
  bounded dispatch repair; no forced-dispatch policy was installed without a
  demonstrated intent/authorization gate.

### 2026-10-05 network retry

The retry progressed through the real production conversation, explicit workspace
confirmation and native execution for all four ACP backends. Natural first turns
still only promised action; explicit dispatch guidance and, for some intakes,
verbatim constraint clarification were needed. This is assisted acceptance, not a
clean first-turn experience.

Scoped fetch diagnostics now distinguish model requests from other background
requests. In the scoped October 5 runs, observed `ECONNRESET` entries had
`model: null`; model calls succeeded. Intake `AbortError` coincided with the host's
30-second assessment deadline. Earlier unscoped fetch errors cannot all be
attributed to model service calls.

All four ACP backends completed native execution but their initial Tasks
entered `task_check_unavailable`. Rechecking Pi and DeepSeek did not clear it.
After a Pi driver restart, its original Task instead reported
`task_origin_unavailable`; continuing the named original session failed with
`unknown_session`. These remain distinct unresolved product defects.

A separately confirmed **new Pi session in the existing workspace** read the
artifact and ran the real tests; Task `8d61f5c2-df6d-437c-b607-bc2c55d75740`
reached `completed`. This proves a follow-up check can close through Nova, but does
not retroactively complete the initial project Task or prove original-session
continuity across a backend-default change.

Independent browser checks on all four generated games passed movement, rotation,
soft/hard drop, gravity, line clearing/score, game over and restart. CodeBuddy,
Pi and OpenCode additionally passed pause/resume. Tests used real keyboard/button
events, with in-memory fixtures for deterministic rotation/line clearing and
read-only access to the UI's actual game state. The operator did not edit game
sources. Browser artifacts and hashes are in the gitignored
`output/playwright/v040-oct5/`; live records are in
`/private/tmp/nova-v040-20261005/`. Final Task status must still govern the verdict.
OpenCode finished with 30 passing tests and zero failures; its final HTML was
independently rechecked after execution stopped. All driver processes and the
temporary browser/server were closed after evidence collection. Private reports
are retained under `output/v040-coding-live-20261005/private-runs/`.

### Evidence and limitations

Local retained bundle: `output/v040-coding-live-20261004/` (gitignored).
`manifest.json` records baseline, built transport hash, Task IDs, permission mode,
artifact sizes and SHA-256. `games/` contains untouched HTML and screenshots;
`browser-results.json` and `browser-acceptance.js` preserve independent checks.
`private-runs/` retains every startup/failed attempt, snapshots and protocol evidence;
these reports can contain local catalog metadata and must not be committed/published.

Browser checks use actual key presses. Deterministic in-memory board/piece fixtures
exercise rotation and one-line clearing; game over uses repeated real hard-drop
keys, and restart uses the visible UI button. The generated source is not modified.
This covers the listed mechanics, not prolonged human play, all scoring combinations,
all browser engines, physical voice, desktop UI interaction, or packaged builds.

Earlier runs are retained: OpenCode Ask included an explicit refusal of an unrelated
root-directory listing, but later approval timeouts affected completion; CodeBuddy
Ask ended `turn_failed`; first DeepSeek/Pi artifacts were playable but lacked Task
observations. Harness startup failures before the first valid run are not backend
failures. Some agents wrote temporary self-test files outside their managed workspace;
thus the requested workspace-only constraint is not a proven isolation guarantee.

Reject/cancel/crash/authentication recovery are **not comprehensively live accepted**.
Driver shutdown is cleanup, not a passing user-cancel test. Pi Ask rejection has
contract-test coverage; it was not established through a successful live project.
DeepSeek wrote files without showing a Nova approval in this run: Ask configuration
alone is not evidence of per-tool approval enforcement.

Validation of the local patch: runtime TypeScript build; 64 tests across ACP
transport/backends, coding profiles and model adapters; changed TypeScript files
passed ESLint. The tests include actual nonzero exits, truncated results, wrong
terminal binding, duplicate notification, redaction and evidence identity checks.
Desktop build passed for the live driver setup. No release, merge or push occurred.

### 2026-10-05 blocker diagnosis and local fixes (pre-rerun)

Offline replay of the four saved verifier requests against the live gateway showed
the real failure stage was not network, JSON parse, or unknown evidence refs.
Each model returned a schema-valid `complete` with refs that exist in the evidence
set, but `criteria` used indexes `0..N` while the Task had a single acceptance
criterion (`acceptance.length === 1`). `applyDecision` threw `invalid_evidence`;
`task-loop` swallowed every check error as bare `task_check_unavailable` with no
stage. Separately confirmed offline: if the decision had been a correct
`complete`, `hasBoundCheck` would have passed for all four backends.

Root causes and local fixes on `feature/v040-live-project-acceptance` (uncommitted;
no merge/push):

1. **Verifier swallow / criteria index** — `TaskCheckError` carries
   `stage` (`model_call|json_parse|schema|evidence_ref|apply`) and a short `code`;
   waiting reason stays `task_check_unavailable` for the desktop. The verifier
   prechecks the same rules as `applyDecision` (including criterion index bounds),
   retries once with `validation_feedback` and `valid_evidence_refs`, then fails
   closed without inventing refs or auto-completing. Gateway transport errors are
   not retried.
2. **Evidence 64 KB kept oldest** — observation budget now accumulates from newest
   to oldest so final tests survive truncation (`observations_truncated` still set).
3. **Task origin eviction** — blackboard capacity uses fair per-channel eviction
   (drop oldest from the currently largest channel) so ACP progress floods cannot
   erase the conversation origin required for recovery. ACP progress throttling is
   still deferred.
4. **Restart loses coding_target** — same-generation task recovery restores the
   live runtime’s persisted `coding_target` and messages; retired generations stay
   unbound. The `continuation_target_required` guard is unchanged.
5. **Review hardening** — Pi non-empty `signal` is not a successful
   `commandExecution`; tool observation text is path-scrubbed before truncation;
   late tool updates no longer wipe accumulated final `#text`; DeepSeek exit-0
   recognition rejects forged footers and CRLF spoofs; intake constraint quotes
   require a minimum length; Chinese `别` negation uses `别(?!的)`; the live driver
   hashes the transport source file and records dirty `git status`, with model
   request capture redacted.

Local verification after these fixes: `npm run typecheck`; ESLint on changed
files; focused suites (task-loop, model-adapters, task-recovery,
coding-target-recovery, coding-targets, blackboard-*, acp-transport, coding-intake,
project-backend-*) all green; full `runtime` `npm test` **3451 pass / 0 fail /
9 skipped**. Baseline note: earlier “207” referred to a focused ACP/verifier subset
log, not the whole package.

Acceptance criteria that still honestly block a pass if they fire (not bugs):
intake-generated criteria that add user-unrequested conditions (for example
score/level display or in-browser play) may correctly yield `wait`/`correct`.
Foreground “promise without dispatch” remains out of this round; the natural first
turn still needed a neutral dispatch nudge in most runs (assisted acceptance).

### 2026-10-05 first post-fix rerun (superseded)

Evidence: gitignored `output/v040-coding-live-20261005-rerun/private-runs/`. Front
model `qwen-flash`; the intended `qwen-plus` support setting had no effect (see the
routing note below), so every layer ran `qwen-flash`. Assisted dispatch nudge retained when
the natural turn only promised. Driver now resolves absolute `CODEX_BIN` and
`chmod 0700` project roots (required for `codex_host_unavailable` /
`codex_project_state_invalid` under umask). Disk stayed ~4.4–4.6 GiB free.

| Backend | Initial Task | Resume after default switch | Restart recovery | Notes |
|---|---|---|---|---|
| DeepSeek | `completed` (`dfad1e9a…`) | `completed` new Task (`71ffe9f5…`); session stayed `backend_id=deepseek` after default→opencode | `origin_unavailable=false`, `unknown_session=false` | Full path pass for this backend |
| CodeBuddy | `completed` (`2248223a…`) | not completed (pause/resume hit plan-generation failure; continuer aborted) | not exercised | Initial verifier close works; resume gap is front/intake, not `task_check_unavailable` |
| OpenCode | superseded | superseded | superseded | Stopped after flash `intake_assess_invalid_output`; see the `qwen3-max` rerun |
| Pi | superseded | superseded | superseded | See the `qwen3-max` rerun |

The restart step of that DeepSeek row only checked that recovery raised no
`task_origin_unavailable`/`unknown_session`; no continuation Task ran after the
restart. The later runs below supersede this table.

### 2026-10-05 failure tracing and model selection

Model routing note: under the cascaded Qwen connection,
`cascaded-realtime-assembly.ts` overrides `support_model`, `planner_model` and
`compressor_model` with the front `CASCADE_LLM_MODEL`. `SUPPORT_MODEL` in the
environment had no effect in these runs; every layer used the front model.

Failure reasons were made traceable before choosing a model:

- Intake failures record `detail` (schema path and issue code, or a fixed class
  such as `json_parse`) on `intake.failure` and as an
  `intake_failure_detail stage=… attempt=… detail=…` diagnostic. Model values,
  messages and provider bodies are never recorded.
- Constraint validation names the non-verbatim lines in the model-facing
  `validation_feedback`; verbatim sentences may share a line in any order (each
  sentence must still occur in user text, ≥3 characters).
- Verifier retries send the zod issue path/expected type and a repair hint for
  reference problems; events still keep only stage and code.
- ACP transport failures carry `diagnostic {method, server_code, message}` into the
  work outcome. `message` is a fixed class (`class=quota_exhausted`, `rate_limited`,
  `context_overflow`, `auth`, `timeout`, `unclassified`), `stop_reason=…` or
  `empty_final_text`; agent prose never leaves the transport.

Locked model causes (live request/response captures plus offline replays against
the real verifier and intake code, 3 runs each):

| Model (all layers) | Intake constraints | Verifier JSON | Locked cause |
|---|---|---|---|
| `qwen-flash` | fails live | 3/3 | The front model paraphrases constraints in its dispatch `instruction` (“不新建工作区或会话，不修改其他项目…”); the support model copies that paraphrase instead of user text, even after named-line feedback. Replay with a verbatim instruction passes. |
| `qwen-max` | passes on retry | 0/3 | Always writes `criteria[].evidence_refs` as a string or number, unchanged after path feedback and an explicit example. Also gets HTTP 400 on ~87k-token compressor calls (context window). |
| `qwen3-max` | 3/3 | 3/3 | None observed; used for the reruns below. |

### 2026-10-05 `qwen3-max` live rerun

Production composition, all layers `qwen3-max`, `CODEX_APPROVAL_MODE=yolo`,
independent output roots, neutral dispatch nudges where the first turn only promised.

| Backend | Initial Task | Resume after default switch | Restart, continue original session |
|---|---|---|---|
| DeepSeek Harness | `completed` | `completed`, pinned `backend_id=deepseek` | `completed` on the original Task (see below) |
| CodeBuddy | `completed` | `completed`, pinned `codebuddy` | `completed` (new Task, same session) |
| OpenCode | `completed` | `completed`, pinned `opencode` | `completed` (new Task, same session) |
| Pi (full mode) | `completed` | `completed`, pinned `pi` | `completed` (new Task, same session) |

With `qwen3-max` every natural first turn dispatched without a nudge. Each backend
has exactly one ACP session in the project store across all three steps; no
restarted Task reported `task_origin_unavailable` or `unknown_session`. Verifier
`complete` decisions cite the current work evidence with bound command executions
(exit 0).

DeepSeek restart path: the first restart continuation resumed the original session
(`session/resume` ok) but its prompt failed with DeepSeek `402 Insufficient Balance`
(the account shared by DSH and Pi; Pi's first run failed the same way after writing
files). After the top-up, new continuation Tasks failed before execution with
`cause_code: session_active`: the unfinished 402 Task still owns the session by design.
The operator reconciled that Task as `not_run` (its DSH turn shows the 402 rejection
and no tool calls), cancelled the never-started Tasks and continued the original
Task. The verifier first asked for a rerun of the checks (`correct`), the correction
ran the tests (exit 0), and the original Task reached `completed`. Pi was rerun from
scratch after the top-up.

Pi wrote its self-check scripts to `/tmp` outside the managed workspace; the
workspace-only constraint is still not enforced for full-mode agents.

Live-found defects fixed during the rerun (with regression tests):

- The target resolver capped `session.title` at 80 characters while stored titles
  allow 120 and the prompt asks for the exact roster title (`target.session.title:too_big`).
  The schema now reuses `MAX_PROJECT_SESSION_TITLE`.
- After a restart the resolver answered “继续原 X 项目的原会话” with
  `{mode:'named'}` and the project's latest title, so the host asked again. An
  explicit continuation whose named title equals the project's `last_session_title`
  and does not appear in the user's words is now treated as `latest`; literal title
  text still needs named-session evidence.
- Adapter dispatch exceptions were reported only as `dispatch_failed`. The handoff
  now adds the error class (`cause`) and a snake_case code (`cause_code`) when the
  error carries one; messages are never copied.
- The live driver needs an absolute `CODEX_BIN` and owner-only (`0700`) project roots.

Independent browser checks (real key events on untouched artifacts; hashes in the
gitignored bundle): DeepSeek, CodeBuddy, OpenCode and Pi passed movement, rotation,
soft/hard drop, gravity, pause/resume, game over and restart. The checks compare
frames and each game's visible overlay; line clearing is not verified generically.
OpenCode auto-starts and uses Enter to toggle pause; Pi's footer always mentions
游戏结束, so its game over was checked through the overlay.

Evidence: gitignored `output/v040-coding-live-20261005-models/` (per-backend
reports, summaries, model responses, task state, untouched HTML, browser results,
locked-cause captures). Private run directories stay outside the repository.

Validation after these changes: typecheck, ESLint on changed files, full runtime
`npm test` **3459 pass / 0 fail / 9 skipped**.

### Known issues and remaining gates

- The memory compressor runs back to back (~87k input tokens every ~22 s) while an
  ACP executor streams progress into the `codex` channel, and under the cascaded
  Qwen connection it bills the front model. In these runs it accounted for about
  91% of `qwen3-max` input tokens (~26M of 28.5M). Small-context models fail these
  calls with HTTP 400. Deferred: fix ACP progress throttling and the compressor model
  override in a separate worktree from `v0.3.0dev`.
- The pass above relies on `qwen3-max`; `qwen-flash` and `qwen-max` each fail one
  stage for the locked reasons above. With weaker models, natural first turns still
  often promise without dispatching.
- Reject/cancel/crash recovery, desktop UI/voice and packaged acceptance remain
  separate.
- Decide whether intake acceptance criteria must quote user text (criteria drift
  observed; deferred).
