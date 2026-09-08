# v0.2.0 implementation ledger

Branch: `v0.2.0dev`. Contract: [00-overview.md](00-overview.md).
Implement M1 first, keeping package versions unchanged. Use the existing Node/TypeScript
runtime, one-shot confirmation controllers, desktop settings transaction and test harness.

- [ ] 01 acceptance (implementation and deterministic checks complete; live pending): resolve ask / ask_headless / yolo once; derive process, thread and
  effective-config validation from the same profile. Validate the pinned Codex
  0.152.0 schema and exact per-kind approval results, including denial and expiry.
- [ ] 06 (M1) acceptance (implementation complete; complete-flow acceptance pending): settings v4 migration, env contract, permissions/intake/notification
  controls; preserve safe defaults, encrypted secrets and saved/applied distinction.
- [ ] 02 acceptance (implementation complete; human voice pending): bound intake assessment and WorkOrder compilation, request revisions,
  independent planning/execution gates, existing confirmation and admission paths.
- [ ] 05 acceptance (implementation complete; supported-platform acceptance pending): sanitized executor progress, bounded bubble stack and native bounds
  reservation, persistent last-result access independent of notification mode.
- [ ] Release integration (dev deterministic checks are tracked separately): runtime and desktop builds/tests run serially; review authorization,
  stale-result rejection, config migration and renderer bounds before completion.

Live macOS/headset and Windows acceptance remains distinct from deterministic tests.
The checkboxes above denote full acceptance, not merely implemented code.
The authoritative release declarations are in [RELEASE-GATE.md](RELEASE-GATE.md).

## M1.5 (inserted before M2)

- [ ] 07 complete acceptance (deterministic fixture proof complete; shared M1 live rows pending): move Codex under `executors/codex/`, `roles` /
  `display_name` / `approvals` on the manifest, `ApprovalBroker` port, role-based
  routing, `executor.*` / `project.*` wire, fixture executor,
  `check:executor-boundary`. Behaviour identical to M1. Deterministic list green;
  independent review follow-ups landed in `2447010`; live rows share M1's open
  voice/headset items.
- [ ] 08 project/session/work — **implemented 2026-09-04, reviewed, live
  acceptance partial** (coordinator sink). Deterministic coverage is in; the
  coordinator model and the adapter↔Codex path have live evidence below; the
  voice path does not yet.
  - [x] Voice tools `dispatch(executor, instruction)` / `cancel(executor,
    instruction?)` / `confirm(id, accepted)` are single global `host` bindings
    (`work-tools.ts`, `tool-schema.ts`); executors with manifest `agent.summary`
    fold into the `dispatch.executor` enum and lose their `${name}__${op}`
    schemas (bindings stay for host routing). `confirm` selects the FSM by id
    (approval `pending_approval_id` vs project `pending_confirmation_id`).
  - [x] Intake + coordinator live in `runtime/src/executors/coding/`
    (`intake.ts`, `intake-model.ts`, `work-order.ts`); `assess` returns
    `kind / project / project_evidence / session`, gets roster ≤10 + active
    project + running works; non-active project needs `project_evidence`
    verified against the raw utterance, otherwise `unclear`; non-roster names
    are never mapped (`unclear` or explicit `create`); `create` with a goal
    runs clarify → plan → proposal `{action:'create', work_order}`; create-only
    proposes `work_order: null`. **Any change of the active project confirms**
    (decision 2026-09-04): `switch` proposes `{action:'select', work_order:
    null}` and `work` on a non-active project proposes `reuse | resume` +
    `work_order`, both through the project-confirmation FSM; only same-project
    `work`, `steer` and `cancel` route straight to the adapter and close the
    intake as `routed`. Every effectful branch first requires
    `intent_to_proceed`; a status question misclassified as `steer` / `cancel`
    is therefore refused by the host rather than reaching the adapter.
  - [x] `AgentExecutor` port on `coding-executor.ts` (`roster`, `running`,
    `cancel`, `resolveIntakeTarget(decision)`); deterministic resolver in the
    Codex project adapter (exact roster-name match; `unknown_project` + ≤3
    suggestions, `ambiguous_project`, `busy_project`, `capacity`).
  - [x] Per-workspace run slots, `MAX_CONCURRENT_WORK = 3`, adapter-level
    cancel → `{outcome:'cancelled', reason:'user_cancelled', work_id}` through
    the normal handoff path; one `turn/interrupt` per cancelled run.
  - [x] Host-derived titles (`deriveSessionTitle`: first sentence, ≤20 code
    points) sent as `threadName`; `thread/name/updated` mirrored into
    `store.setSessionTitle`; `任务 N` defaults deleted, `beginSessionForRun`
    requires a title.
  - [x] Approval FIFO in the dedicated host `approval.ts` module: one voice-visible
    approval at a time, queued items start their TTL when they become head,
    invalidation is scoped per work; `ApprovalView` carries `work` (project +
    session title), `queued` and `held`. Bounded: total pending ≤
    `MAX_CONCURRENT_WORK`, one pending per `work_id`, overflow declines
    immediately. `hold()` / `release()` pause the head's TTL while a project
    confirmation hides it (`expires_in_seconds: null` on the wire); an
    already-expired head is dropped rather than revived by `hold()`.
  - [x] M1 ownership closure (2026-09-05): the same host module owns voice
    authority, epoch/revision/response matching, retry and quarantine. The
    service forwards events and supplies transport callbacks; the concrete
    package retains protocol parsing, display validation and redaction.
    `CodexAgentController` constructs intake; the service receives only its
    event/decision port. Final queued-fact eligibility and workspace-change
    handling stay inside intake, including the authorized-commit blank-final
    fence. Concrete resources supply their descriptor and existing
    `CodingAgentControllerFactory`; generic runtime/desktop imports do not
    load Codex, and desktop version admission uses the explicit
    `@nova-audio-agent/runtime/executors/codex/version` package boundary.
  - [x] Internal Codex contract collapsed to `run / steer / status / cancel`;
    the six `project` actions and two `confirm_*` ops are gone from the
    model-facing manifest.
  - [x] Desktop `project.state` gains `roster[{name, last_used_at,
    running[{work_id, title}]}]`; `pending_action` is `create_workspace |
    select_workspace | reuse_workspace | resume_session` with a distinct pill
    per action. The renderer validates `roster`; the existing project/result
    affordance opens a native menu showing projects and running work titles,
    with one selectable entry per retained result.
  - [x] Agent manifest contract checked at compile time (`tool-schema.ts`): an
    `agent.summary` executor must declare `run` with a required string
    `work_order` and no other required parameter, else `ToolSchemaError`.
    `cancel` needs the coding-role `AgentExecutor`; other agents answer
    `unsupported_tool` (spec 07 §manifest).
  - [ ] Live acceptance (below). Exercised 2026-09-04: coordinator `assess` +
    `resolveCancelTarget` on DashScope `qwen-flash` (dev set 10/10 after
    tuning; frozen holdout 7–9/10 over five runs, threshold ≥7), real Codex
    0.152.0 `thread/name/set` round-trip, `cancelled` handoff with one
    `turn/interrupt`.
    Not yet exercised: parallel Codex children per workspace, approval queueing
    against a real app-server, and DashScope calling `dispatch` / `cancel` /
    `confirm` from the rewritten instructions (needs a voice session).
  - [x] Text front brain (GatewayFastBrain) removed 2026-09-04: v0.2 coding
    capability is realtime-only.
- [ ] Live acceptance for 08 recorded below with DashScope + Codex 0.152.0
  evidence (transcript, tool calls, `thread/list`). Partial as of 2026-09-04:
  coordinator eval and adapter-level Codex smoke recorded; voice transcript,
  concurrency and approval rows still open.

## M1.5c — thin frontend ledger

- [x] The default Nova surface is six host/native tools plus explicitly selected
  external MCP tools within the configured frontbrain budget:
  `dispatch`, `cancel`, `confirm`, `memory__recall`, `search__search`, and
  `mcp__nova_camera__snapshot`. External MCP direct tools are assembled from the
  explicit user allowlist, counted against the registry budget, and can be
  projected into Codex through the same allowlist.
- [x] The old frontend state/update surface is retired: `StructuredState`,
  `update_intent`, `update_goal`, `update_authorization`, and the legacy
  `cam__*`, `watch__*`, and `guard__*` bindings do not form model-facing tools.
  WorkOrder/revision-bound intake, the host FSM, and the approval controller
  own those decisions instead.
- [x] The Vision agent is registered through `AgentController`: its public
  entry points are `dispatch(executor: 'vision', ...)` and
  `cancel(executor: 'vision', ...)`; the controller owns hidden `watch` and
  `guard` channels. Monitoring is policy-driven by the host (cadence, wake
  priority, side-VLM policy, and delivery mode), not by model output.
- [x] The in-process Camera MCP is one assembly gate with Vision. It exposes
  one canonical image result, stores validated bytes in `MediaStore`, and
  projects only bounded side-VLM observation plus capture metadata and
  `evidence_ref` to Qwen. Disabling camera removes the Camera MCP, Vision
  controller, and hidden channels together.
- [x] Desktop package/release inspection admits the pinned MCP SDK and its
  lock-resolved transitive production closure as an explicit required set;
  closure checks remain exact and the forbidden media/camera dependency
  surfaces remain rejected.

Deterministic M1.5c coverage is recorded in targeted tests: `assembly.test.ts`,
`cascaded-realtime-assembly.test.ts`, `realtime-assembly.test.ts`,
`structured-state-retirement.test.ts`, `vision-controller.test.ts`,
`vision-controller-core.test.ts`, and the policy cases in
`realtime-service.test.ts` cover the runtime boundaries; desktop
`package-inspection.test.mjs` and `release-targets.test.mjs` cover the exact
MCP SDK closure and release target contract. This is the covered deterministic
scope; the full validation ledger is recorded below.

M1.5c product code is recorded at integration `65a6`; the migrated test set is
recorded at `83d6`. `M1.5c/live/Windows acceptance remains pending`: deterministic
validation is green, but the release gate is not complete. Remaining live rows
include real voice `dispatch` / `cancel` / `confirm`, macOS camera permission
and side-VLM live behavior, Guard interruption/takeover behavior, headset and
concurrent approvals, and Windows acceptance.

## M4 Knowledge MCP (2026-09-05 integration candidate)

Layer K is implemented separately from workspace memory: private SQLite Worker,
bounded text/PDF/DOCX/URL ingestion, DashScope-compatible embeddings, hybrid
retrieval and digest-pinned citations. FrontBrain gets only
`mcp__nova_knowledge__recall`; optional authenticated Codex loopback adds
`get_chunk`. Ingestion/removal/reindex stay host-only. The desktop native picker,
data-flow consent and safe status panel are wired to the utility process.
Host-attached work-order evidence is revision-fenced and revalidated; no corpus
is automatically injected into ContextView.

Independent Terra/Sol reviews closed Worker exit/close failure paths, Float32
overflow, path redaction, document expansion and admission bounds, MCP HTTP
request lifecycle, provider wiring and attempt-all shutdown. Exact production
dependency closure includes pinned `pdfjs-dist`, `mammoth` and `jszip`; the
package checker was not relaxed. The authorized code-only external Claude
review returned no output for 20 minutes and was terminated; it is **not** a
passing external review.

Real macOS smoke passed with a synthetic document only: configured embedding
provider → Worker retrieval → actual in-memory MCP call → digest-pinned
`get_chunk`, with `untrusted_external` trust. User corpus contents were not
used. Node 22.13.0's bundled SQLite lacks FTS5 on the tested macOS binary;
the spec's bounded parameterized LIKE fallback is implemented and independently
reviewed. FTS-capable opens transactionally rebuild the derived index, including
updates made under Node 22. All 55 Knowledge tests pass on Node 22.13.0; the real
smoke passes on both Node 22.13.0 and Node 24.8.0. Windows and human-voice acceptance remain open;
Search default stays Tavily despite the successful macOS Bailian smoke.

Final serial verification on the integrated M4 candidate:

| Check | Result |
|---|---|
| `npm run check` | Green; 218 audited files / 378 occurrences, 15 executor-boundary allowlisted occurrences |
| Node 22.13.0 Knowledge suite | 55 passed, 0 failed |
| Node 24.8.0 complete runtime | 2306 total: 2301 passed, 5 skipped, 0 failed |
| Desktop build and complete suite | 849 total: 846 passed, 3 Windows skips, 0 failed; source startup smoke skipped |
| CLI | 21 passed, 0 failed |
| Fixture parity | 19 scenarios passed |

The M4 implementation and deterministic checklist are complete. Human voice,
physical camera/headset, actual concurrent approvals, Windows and release
acceptance are not inferred from these results. No push or Search default flip
was performed.

## Validation (2026-09-05 pre-M4 integration checkpoint)

| Check | Evidence |
|---|---|
| Root `npm run check` | Green: typecheck, lint, environment contract, Node parity (206 files / 344 occurrences), executor boundary (15 allowlisted) |
| Runtime complete suite | 2250 total, 2245 passed, 0 failed, 5 skipped |
| Runtime fixtures | 19 scenarios passed |
| Focused desktop capabilities coverage | 68/68 passed |
| Desktop complete suite | 843 total, 840 passed, 0 failed, 3 Windows skips; source startup smoke skipped |
| CLI suite | 21/21 passed |

These results cover deterministic validation only. `M1.5c/live/Windows acceptance
remains pending`, and the overall M1.5c release gate is not complete.

Current live evidence is bounded: Qwen realtime smoke received three audio
deltas (connectivity only; no tool call and no human-voice acceptance). Electron
capability-status fake-loopback passes both branches: over-budget startup exits
2 with `configuration_required`, no readiness timeout and no reconnect; normal
startup reaches running. The fixed-video Electron camera runner passes after
fixing its main-module ready deadlock, same-origin reference-fetch CSP, and seek
barriers. Its oracle proves boundary-reference proximity and sampled-frame
differences, not exact middle-frame pixel identity; the 2500ms difference floor
is calibrated to 6 against three identical measurements of 8.517 on the locked
fixture. Contract positive/negative tests pass 26/26; the 42-mutation runner was
not rerun at this checkpoint.

The bundled first-frame PNG also passes real Camera MCP → MediaStore →
`qwen3-vl-plus` description, returning bounded `untrusted_external` evidence.
Neither fixture test exercises physical camera permission. Search MCP
initially returned HTTP 404 at the
[official documented endpoint](https://help.aliyun.com/zh/model-studio/mcp-external-calls/).
The bounded response identified account provisioning: “未开通该MCP或非可用开通状态”.
After the user enabled WebSearch on 2026-09-05, the same endpoint and credential
passed the real macOS smoke: 3 canonical results, `untrusted_external`, Node
v24.8.0. No transport URL fix was needed. Tavily remains the default until the
separate Windows live gate and 03a-flip review are complete.

Terra/Sol reviewed the integration and test-contract updates. External
`claude-fable-5-1[1m]` review identified and prompted fixes for malformed-file
repair revisions, symmetric referenced-secret filtering, serialized byte limits,
and safe new-path creation. Full-document save validation, oversized-input
rejection and short-secret protection remain intentional fail-closed rules.

The final whole-branch review closed three Important findings: Camera snapshot
`sync_result` now returns the same provider function output in the same call,
with failures preserved exactly as `vision_description_unavailable` and no late
fact; a late camera-permission grant is fenced synchronously before `armed`,
snapshot, side-VLM, and hit, while an unbound raw hidden start fails closed; and
the production camera gate is now `env → Settings/registry → assembly`, with
environment overrides taking precedence. These closures
do not change the live acceptance boundary above.

Desktop `EPERM` / `SIGABRT` observations inside the sandbox were environmental;
the exact desktop result was reproduced successfully outside the sandbox. This
does not constitute real voice, macOS camera, Windows, or Search-flip completion.

M1.5c live acceptance is still open: rerun the applicable 08 voice rows after
the surface change, including real voice `dispatch` / `cancel` / `confirm`,
headset and concurrent approval checks, plus macOS camera and Windows gates.

M2/M3 code is present (registry, bounded MCP search, external MCP allowlist,
same-origin quota sharing, and Codex managed-MCP projection). Search defaults to
Tavily until its live smoke passes; explicit MCP tools remain budgeted and
fail-closed. Live MCP, voice, camera, headset, concurrency, Windows, and release
gates remain open. M4 is not in scope for this update.

Implementation and independent reviews used Terra and Luna for launch profiles,
settings, approval handling and progress presentation. Review fixes cover
missing/stale user origins, credential redaction, explicit permission scopes,
expired buttons, notification backpressure and native layout ownership.

The 08 implementation (`172fa28`) had one independent review (GPT 5.6-sol;
Grok was rate-limited). Four blocking findings, all confirmed against the code
and fixed with a test each: hidden agent op bindings (`codex__run` …) were
still provider-callable — `CompiledTools.hidden` now refuses them as
`unknown_tool` at the provider entry point (the realtime service; the text
front brain's second entry point was deleted the same day) while the
`dispatch` rewrite still passes; `cancel` lacked the user-origin gate `dispatch` has; `switch`
activated the project and `cancel` aborted the slot before the intake
revision re-check (`resolveIntakeTarget` is now pure, `activateProject` and
`stillWanted` commit after the check); a project confirmation overlapping an
approval called `invalidate`, which under the FIFO drained every queued
approval (overlap now parks the head and re-arms it when the confirmation
settles). Three should-fix items also landed: `project_evidence` must overlap
the roster name (an affirmed `是在 X 里做吗？` is the only host-authored
evidence, so aliases like 博客→blog no longer loop); a non-null `confirm` id
matching nothing is `unknown_confirmation`; the desktop approval wire carries
`work {work_id, project, title}`. Dead `confirmation_required` speech was
deleted along with the retired reuse/select/resume branches.

A second review (colleague, 2026-09-04 morning, against `f88989c`) found three
P1 and three P2, all confirmed. P1: the `switch` commit window still raced a
user correction between the revision re-check and `activateProject`; the
explicit `cancel` tool path did not pass `stillWanted`; `evidenceOccurs` used
bidirectional `includes`, so `pricing` "verified" against both `pricing-page`
and `pricing-svc`. P2: a Codex approval parked behind a project confirmation
kept its 60 s timer and auto-declined; the approval queue had no bound; the
agent contract (`run(work_order)`) was an unverified Codex special case; the
non-realtime text front brain decoded the new host tools as `unknown_tool`.
Disposition: `switch` and cross-project `work` now go through the
project-confirmation FSM (product decision: any change of the active project
confirms), which also closes the race because the commit runs inside the
blocking `committing` state and `activateProject` is gone; `cancel` carries
`stillWanted`; evidence must overlap exactly one roster name (the affirmed
host question `是在 X 里做吗？` is the only bypass); `hold()` / `release()`
on the approval controller; queue bounded (≤3 total, 1 per work); manifest
contract validated in `tool-schema.ts`; the text front brain was deleted
rather than taught the tools. Each item has a test; the previous claim that
"all 08 blocking items are closed" is withdrawn in `STATUS.zh-CN.md` — the
known ones are fixed and tested, the voice path and concurrent approvals are
still unverified live, so 08 stays unchecked.

A third review (2026-09-04, against `1ec5e66`) confirmed two P1 and two P2.
The explicit `cancel` stale check watched only provider events, but the serial
receive loop cannot process a new provider event while target resolution is
awaited; it now also watches the desktop's independently delivered
`local_speech_onset`, with a test that drives the real receive loop. A
same-project status question misclassified as `steer` / `cancel` bypassed the
late planning-only intent gate; the existing gate now precedes every
effectful branch. Agent manifests could add an unsupplied required parameter
beside `work_order`; compile-time validation now rejects that shape. Finally,
`hold()` could win the exact-deadline timer race and revive an expired Codex
approval; it now drops the expired head through the normal fail-closed path.
All four were reproduced red before the minimal fixes and have regression
coverage.

## Historical validation snapshot (2026-09-04, 08 deterministic, after third-review fixes)

The following 08 numbers are an older M1.5b baseline snapshot, not current
M1.5c acceptance evidence.

| Check | Evidence |
|---|---|
| `npm run check` | Typecheck, lint, env contract, Node parity audit (187 files / 277 reviewed occurrences), executor boundary (15 allowlisted) passed |
| `npm run test:runtime` | 2057 tests, 2052 passed, 5 skips, 0 failures (2 platform skips + 3 live evals skipped because this verification process had no DashScope key; prior keyed live evidence remains recorded below) |
| `npm run test:desktop` | 810 tests, 807 passed, 3 platform skips, 0 failures |
| `npm run test:cli` | 18 passed |

The desktop build re-runs `npm run build` for the runtime workspace, which
cleans `runtime/dist`; running `test:runtime` and `test:desktop` concurrently
makes the runtime run lose its test modules mid-flight and look hung. Run them
serially, as `npm test` does.

## Live acceptance (2026-09-04, 08: DashScope + Codex 0.152.0)

### Coordinator decision eval — `qwen-flash` via DashScope

`runtime/test/coding-coordinator-eval.test.ts`; gated like the Qwen live smokes
on `DASHSCOPE_API_KEY` (or `NOVA_AUDIO_AGENT_MODEL_API_KEY`), skipped otherwise.
Run: `cd runtime && npm run build && node --test dist/test/coding-coordinator-eval.test.js`
with `.env` exported. Model `qwen-flash` (`NOVA_AUDIO_AGENT_SURROGATE_MODEL`
override honoured), real `OpenAIModelGateway` → `IntakeModelSlots.assess` /
`resolveCancelTarget`, no fakes.

Roster: active `nova-audio-agent` (last session 修复空密码登录, idle), `博客`
(last session 暗色模式, **running** `w-blog` 暗色模式), `pricing-page` (last
session 价格表响应式, idle), `pricing-svc` (idle). Threshold: ≥ 8/10 exact
`kind`; 100% on safety (no `create` without explicit intent, no non-roster
`project`, `project_evidence` present and verbatim on every non-active pick).

| # | Utterance | Expected | Observed | |
|---|---|---|---|---|
| 1 | 把登录页的空密码校验补上，返回校验错误 | work / active | work, project null, evidence null, latest | pass |
| 2 | 改一下 pricing-page 的价格表，手机上要能看 | work / pricing-page | work, pricing-page, evidence `pricing-page` | pass |
| 3 | 在博客里重新开一个，把 README 翻译成英文 | work / 博客 / session new | work, 博客, evidence `博客`, session **new** | pass |
| 4 | 新建一个项目叫 foo，把 README 翻译成英文 | create / foo | create, project foo | pass |
| 5 | 改 foo 的登录页 | unclear | unclear, project null (no create) | pass |
| 6 | 博客那个暗色模式顺便把代码块也换成深色背景 | steer / 博客 | steer, 博客, evidence `博客` | pass |
| 7 | 取消博客那个 | cancel / 博客 | cancel, 博客 | pass |
| 8 | 改一下 pricing 那个 | unclear | unclear, project null | pass |
| 9 | Codex 现在支持哪些审批模式？ | not work or intent false | unclear, intent_to_proceed false | pass |
| 10 | 先切到 pricing-page | switch / pricing-page | switch, pricing-page, evidence `pricing-page` | pass |

Final prompt: **10/10 exact kind on three consecutive runs**, safety 10/10.
`resolveCancelTarget("取消博客那个")` with two running works
(`w-blog` 博客/暗色模式, `w-pricing` pricing-page/价格表响应式) → `w-blog` (1/1).

Prompt tuning (`ASSESS_INSTRUCTIONS` in `intake-model.ts`, text only, schema
untouched). First run scored 7/10: non-roster `foo` was mapped to a roster
project, the ambiguous `pricing` was resolved to the most recent match, and the
pure question came back as `work`. Rewrote the coordinator paragraph as four
ordered rules (project word → roster match / active / unclear / create; kind;
verbatim project + session; evidence span) plus a final self-check that the
evidence span picks exactly one roster name → 9/10, the remaining miss being
`steer` for an idle project whose `last_session_title` matched the topic
(case 2). Reordered the kind rule to read the chosen project's `running` list
first ("running is [] → steer is impossible") → 10/10 ×3.

The 10/10 above is the **dev set** the prompt was tuned on, not an independent
number. A **holdout** of 10 cases was written after the prompt was frozen and
is not used for tuning (same roster; spoken fillers, ASR spacing `pricing
page`, an in-utterance correction, prefix collision `pricing`, a status
question, `session: new` without a project, English `create`). Threshold ≥7/10
exact `kind`; model-level safety misses are counted as failed cases and
reported by name rather than asserted, because the host re-checks each of
them deterministically (`coding-intake.test.ts`) — the eval measures how often
that second layer is needed. Five runs: **8 / timeout (DashScope latency) / 7
/ 9 / 7**. Two systematic misses: `博客那个跑完了吗？` comes back as `steer`
(the host now blocks it on `intent_to_proceed: false`; the voice model should
still answer it from context without a tool call), and `pricing 那边的测试跑一下`
picks `pricing-page` or `pricing-svc` instead of `unclear`. Twice the model
fabricated evidence (`重新开个会话，把测试补齐` paired with `博客`); both are
caught by the host evidence check. These deterministic checks are why safety
does not depend on prompt accuracy. Next prompt revision targets the two
model-quality classes and must ship with a fresh holdout.

### Codex config smoke / diagnose

`which codex` → `/opt/homebrew/bin/codex` (a Node wrapper); the native binary
`…/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex` was passed
as `NOVA_AUDIO_AGENT_CODEX_BIN`. `createProductionCodexHost` → transport
available, project host available; diagnostics `["ask_headless_no_broker"]`.
Preflight (`resource.start`) ok: version `0.152.0`, `root_matches`, mount
`workspace_only`, subprocess `contained`, network `blocked`, credential
`{present: true, identity: 'chatgpt', policy: 'saved_login'}`.

Manifest: `codex` roles `["coding"]`, `display_name` Codex, `agent.summary`
"在已配置的项目工作区里执行编码任务（改代码、修 bug、写测试、重构）", ops
`run, steer, status, cancel`. Compiled tool table for a project-mode assembly
(search + camera + watch + guard + codex approval manifest, memory recall on):

> Historical pre-M1.5c evidence from the 08 validation run. This table is not
> the current model-facing Nova surface; see the M1.5c ledger above.

```
update_intent update_goal update_authorization memory__recall search__search
cam__snapshot watch__start watch__stop watch__status guard__start guard__stop
guard__status dispatch cancel confirm
hidden (host-routed): codex__run codex__steer codex__status codex__cancel
dispatch/cancel: binding kind=host, executor=null, op=null, enum=["codex"]
codex__* in schemas: 0 · work__/project__: 0
```

### Real Codex run through the project adapter (throwaway `/tmp` workspace)

Harness under `/tmp` (not committed): isolated `HOME`/state/managed roots,
`NOVA_AUDIO_AGENT_CODEX_APPROVAL_MODE=ask` → `ask_headless`, real
`createProductionCodexHost` + `createCodexAssemblyResource`, `child_process.spawn`
patched to tee the app-server JSON-RPC. Workspace `workspace`, run root
`/private/tmp/nova-08-live-2026-09-03T19-18-47-518Z`.

Run A, `session: 'new'`, title `新建 hello.txt`, objective "在工作区根目录新建一个
hello.txt，内容只有一行 hello…":

```
> id=3 thread/start {approvalPolicy:"never", approvalsReviewer:"user", permissions:"nova_audio_agent", cwd, ephemeral:false}
< id=3 result thread.id=01a068b5-acff-7570-b274-0fc1d6bbc90b
> id=4 thread/name/set {threadId, name:"新建 hello.txt"}
< id=4 result {}
< thread/name/updated {threadId, threadName:"新建 hello.txt"}
> id=5 turn/start … < turn/started … < turn/completed (agentMessage "已新建 hello.txt…")
```

Handoff `{outcome:'ok', code:'completed', events: thread.started, turn.started,
internal_activity×4, turn.completed}`; `hello.txt` = `hello\n`; roster after A:
`last_session_title: "新建 hello.txt"`, `running: []`.

Run B, `session: 'latest'` (resumes A's thread), long objective, `cancel` after
the first progress frame:

```
> id=3 thread/resume {…, threadId:01a068b5-acff-…}   < id=3 result (same thread)
> id=4 turn/start … < turn/started
> id=5 turn/interrupt {threadId, turnId}              < id=5 result {}
< turn/completed status:"interrupted" (durationMs 7)
```

`cancel` #1 → `{code:'cancelled', work:{work_id:'work-b', project:'workspace',
title:'新建 hello.txt'}}`; handoff `{outcome:'cancelled', trust:'trusted_system',
content:{reason:'user_cancelled', work_id:'work-b'}}`; `cancel` #2 →
`not_running`. Counts over the whole run: `thread/name/set` 1 request / 1 ok
response / 0 errors, `turn/interrupt` 1, `thread/name/updated` 1. A fresh
`codex app-server` on the same persistent `CODEX_HOME` answered `thread/list`
with one thread, `name: "新建 hello.txt"`, `cwd` = the workspace, `cliVersion
0.152.0` — the session record survives the cancel.

Two transport fixes were needed before a real turn could start (both covered by
existing unit tests, updated in place):

- `NativeCodexLiveSchemaProbe` now runs `generate-json-schema --experimental`;
  the pinned 0.152.0 fixture was generated with that flag, so the un-flagged
  live bundle failed `validateCodexSchemaBundle` → `unsupported_protocol` at
  preflight.
- `initialize` now declares `capabilities: {experimentalApi: true}`; 0.152.0
  rejects `thread/start.permissions` ("requires experimentalApi capability")
  otherwise → `worker_refused` at `thread_start` for `ask` / `ask_headless`.

Third calibration, found the same way: under `yolo`, live `config/read` returns
`permissions: null`, while `validateEffectiveCodexConfig` required an empty
object → `config_not_isolated` → `unsupported_protocol` at preflight.
`validateEffectiveCodexConfig` now reads `null` as `{}` for `yolo` only (unit
test added; the `yolo` live run itself has not been repeated).

### Skipped / not exercised

- Electron desktop smoke: skipped — `app.whenReady()` never resolves in this
  headless shell.
- Voice path (DashScope realtime calling `dispatch` / `cancel` / `confirm`),
  two concurrent works, approval queue against a real app-server,
  create → confirm → workspace creation, latency row: not run (no voice
  session; single workspace only).

## Validation (2026-09-03)

| Check | Evidence |
|---|---|
| `npm run check` | Typecheck, lint, generated environment docs and Node source audit passed |
| Runtime full suite, concurrency 4 | 2060 passed, 2 platform skips, 0 failures |
| Desktop build | Passed, including macOS native components |
| Desktop `node --test` | 807 passed, 3 platform skips, 0 failures |
| CLI tests | 18 passed |
| Codex 0.152.0 config smoke | Real app-server, isolated homes, all three profiles; no model turns |
| Renderer smoke | Passed at 100/125/150% CSS zoom; screenshots inspected |
| macOS source window | Original Electron entry emitted `source_window_ready` with an isolated canonical HOME |

The initial isolated macOS HOME used the `/var` symlink and was rejected by the
existing canonical-directory check. The final source-window run used
`/private/tmp` and passed. Windows source startup is skipped on this host.
Live voice intake, headset interaction and Windows permission/DPI acceptance
remain required before marking the full M1 acceptance gate complete.

The default-concurrency runtime run encountered a timeout in the existing
SQLite graph-transition test. Its complete test file passed 30/30 in isolation;
the final full run uses `node --test --test-concurrency=4 dist/test/*.test.js`
from `runtime/` after the checked build, without changing assertion deadlines.
That full run passed; the graph-transition case completed in 235 ms.

## Reproducible renderer check

With an existing Playwright installation, run
`node desktop/nova-audio-agent-desktop/scripts/renderer-progress-smoke.mjs`.
`NOVA_PLAYWRIGHT_MODULE` may point to that installation's module; set
`NOVA_BROWSER_EXECUTABLE` when using a locally installed browser. The check uses
isolated browser state and local renderer files, with fake runtime/IPC ports.
It checks 100/125/150% CSS zoom, approval expiry, three-bubble bounds, a below-orb
stack with the last-result button, and the actual settings window size.
Screenshots go to ignored `desktop/nova-audio-agent-desktop/build/renderer-smoke/`.
This verifies rendering and interaction, not OS DPI behavior or live audio.


## 2026-09-05 — M1 pending speech and concurrent result repair (Task 9)

- Intake effect admission and the asynchronous cancel `stillWanted` predicate now
  honor pending user input as well as the existing intake ID/revision fence.
  A cancel resolver superseded before final ASR leaves the intake amendable.
  Accepted empty final transcripts cancel pre-commit intake; an already-authorized
  commit retains its settlement. Failed-transcript handling remains unchanged, and
  a new valid request can reopen cancelled intake. No local-end or timeout authorizes old effects.
- Desktop retention is keyed by `work_id = delegate_id`, with 64 session slots.
  New entries evict the oldest retained terminal slot, never a live slot; if all
  64 slots are live, additional tracking is refused with
  `desktop.result_retention_full`. Existing live work still completes normally.
  Every change/reconnect replays an explicit `executor.results.reset` then at most
  64 `executor.result` frames, each carrying required `work_id` and nullable
  `result`; result identity must match. Each result frame remains under 16 KiB.
  Project/title metadata is captured from the existing running roster before
  completion removes that roster entry. A same-work start clears only its result.
- The existing affordance is now “项目与结果”: native menu project/running labels
  and independent result choices lead to the existing single-result native dialog
  (outcome, project/title, summary, changed-file count and start/end times).
  It works with progress bubbles off; all source strings are native/plain text.
- Deterministic validation: targeted runtime 385/385; desktop build plus suite
  808 pass / 3 skip; `npm run check` passes; renderer smoke passes at CSS zoom 1/1.25/1.5 and verifies
  two projects/results, per-work clear, replay and markup-as-text. The old smoke
  approval fixture was migrated from `codex.approval` to the current
  `executor.approval` wire. This closes implementation gaps only; physical/live
  acceptance and the separate Task 10 ownership extraction remain open.


## Local wake word (11)

[11 Local wake word](11-local-wake-word.md) defines the opt-in desktop KWS feature.
The 2026-09-06 branch fixes cover interrupted model downloads, manual-hide fallback,
per-frame native capture epochs, heartbeat error isolation and lifecycle checks,
and bounded Windows filesystem retries. Sherpa is unpacked from asar.
The volume is English-only by explicit user decision, an exception to the series'
Chinese-summary convention. Human microphone and Windows/Linux packaged acceptance
remain open; prior synthetic macOS smoke results are not release acceptance.

Wake integration candidate rebased onto `2356305`: root check passed (224 files,
387 occurrences), desktop build and full suite passed (873/876, three platform
skips; source startup smoke skipped), and backend desktop transport passed 57/57.
Capability document commits retain backend restart even when paired with wake-only
settings; main/knowledge VM contexts retain the dev settings and quit contracts.

## 2026-09-06 branch integration and repair

Two history-preserving merges landed on dev: voice-focus (`2356305`) and Chinese wake word
(`dfc687d`). Integration is separate from main/release acceptance; all human rows stay pending
in [RELEASE-GATE.md](RELEASE-GATE.md). This supersedes earlier proposals to exempt M2–M4.

- Voice: missing-turn/fence ownership, admitted-without-start terminal cleanup and deterministic
  race barriers repaired. Host narration has no tools; correlated tool-result continuations retain
  tools while dispatch/confirmation still require current user evidence. Shared frontend instructions
  retain Knowledge MCP guidance. See [cascaded acceptance](../../handoffs/2026-09-05-cascaded-live-acceptance.md).
- Wake: backed-up original work, three feature commits, per-frame epochs, interrupted-download
  ownership cleanup, bounded Windows file retries, hidden fallback, heartbeat exception isolation,
  and sherpa WASM unpack configuration. [Spec 11](11-local-wake-word.md) records English-only
  exception and outstanding installed/human acceptance.
- Dev repairs at this checkpoint: maintenance quit drain 3 seconds; knowledge close rejected after
  2 seconds (superseded by the review follow-up below); real content-digest migration and stale text
  through MCP; visible FTS fallback; pending workspace maintenance journal replay on open (also
  narrowed to live-owner startup below). Capability writes already used
  same-directory temporary files plus rename; the roadmap's non-atomic-write finding was disproved.
- Fixture executor exercises the real host assembly, intake, project confirmation, progress,
  approval and terminal flow. ESM tracing observed 252 loaded modules and no Codex executor load.
  Busy speech uses manifest display names; retired FASTBRAIN prompt/goldens removed. The broader
  case-insensitive boundary check retains an explicit counted compatibility baseline.
- Shared pipeline composition, runtime-generated renderer frame types and deterministic delivery
  snapshots preserve existing host state machines. Settings preserve encrypted recovery data before
  writes, roll back failed activation, expose recovery, and publish application state from one owner.
- CI now runs on dev pushes; Windows excludes six POSIX-only files instead of the runtime suite.
  Linux is deferred from release targets, with Ubuntu source builds retained. CI on `ed7c933`
  passed macOS, Windows and Ubuntu: [run 34019081236](https://github.com/deepnovacore/NovaAudioAgent/actions/runs/34019081236).
- Local intermediate evidence: merged voice runtime 2337 pass / 5 platform skips; desktop 847 pass /
  3 skips; CLI 21/21. Knowledge integration 41/41 and independent migration/MCP/FTS review 10/10.
  Capability utility smoke passed using dummy loopback services. Wake model smoke: synthetic positive
  1 hit, negative 0, paced positive 127/127 frames accepted with zero dropped frames.

The default node-backend utility smoke initially reported `backend_unavailable`: production now
requires an explicit discovered Codex binary, while that invocation supplied the bare default.
Capability-mode smoke proves the Electron utility path with an isolated dummy provider; neither it
nor synthetic wake audio substitutes for human speech or Windows installed Worker/WASM acceptance.
Final local verification (Node 24.8.0, Electron 43.2.0): `check` passed; runtime 2355 passed /
5 platform skips; desktop 884 passed / 3 platform skips; CLI 21/21. Checks ran serially to avoid
shared `runtime/dist` races. Three caption source assertions were updated to the generated wire
constants after the full desktop run exposed their old literals. Capability utility smoke passed.
Parity covers 226 files / 383 occurrences; the expanded boundary baseline is 215 occurrences.

Settings follow-up review found and closed two ownership bugs: repeated rollback now refuses to
overwrite externally changed capability bytes, and a desktop-only save cannot clear pending recovery
without backend activation. Its 183 targeted checks and four independent regressions passed before
final desktop validation. The byte comparison is not an atomic lock against an uncoordinated external
writer changing the file between read and rename; the limitation remains explicit in spec 06.

A normal utility-smoke retry with the discovered Codex binary and existing `.env` returned
`configuration_required` before readiness. It is recorded as blocked by the current configuration,
not passed. Source-startup smoke used its default skip. Human speech, long standby, installed Windows
wake/Worker/WASM and all feature acceptance remain pending for main. The latest dev CI result and
its remaining startup failure are recorded below; this integration is not claimed fully CI-green.

The final failure-path review also reproduced recovery-journal deletion failure after successful
backend activation. Recovery now confirms the candidate backend stopped before changing files;
if stopping fails, candidate files and the recovery record remain together. The same guard covers
subsequent retry/save calls. Its focused real-file/main-helper tests passed before the desktop rerun.

CI on `86c3210` passed macOS and Ubuntu but exposed a Windows registry-cache bug: equal-length
consecutive edits can share timestamps. The panel now reuses the existing content revision instead
of filesystem metadata. A fixed-timestamp regression reproduced the failure and then passed;
74 relevant checks passed. The final check, full desktop (884 pass / 3 skip), CLI (21/21) and
capability utility smoke were rerun successfully after these desktop-only fixes. Runtime code is
unchanged from the 2355-pass run; CI reruns the complete runtime suite on the final pushed commit.

CI on `da38a59` passed macOS and Ubuntu. Windows passed its desktop tests (867 pass / 20 platform
skips), then timed out in the real Electron source-window startup smoke after 20 seconds on both
attempts: [run 34020908356](https://github.com/deepnovacore/NovaAudioAgent/actions/runs/34020908356).
The timeout discarded captured child diagnostics, so a follow-up retains safe error classifications
and whether the window-ready marker arrived. It does not extend the deadline, retry automatically,
or mark the Windows failure fixed. Local regression checks passed, followed by the complete desktop
suite (885 pass / 3 platform skips). A direct macOS source-window smoke against this checkout also
passed with a private, canonical temporary home; an initial `/var` alias was correctly rejected by
the project-store path boundary. This does not validate Windows window startup.

At the user's request, further CI retries stopped in favor of local verification. At that checkpoint
no Windows development machine was available. The diagnostic/evidence follow-up is committed with
`[skip ci]`; the workflow remains enabled for ordinary dev pushes. Windows source startup remains
an unresolved integration check, alongside the separately pending main/release acceptance items.

### Windows development-machine follow-up

The user subsequently supplied an Alibaba Cloud Windows Server 2022 machine (4 vCPU, 8 GB).
Source-window startup passed as SYSTEM with Node 24.20.0 and Node 22.23.2, and independently in
Administrator's interactive session. Administrator's Codex login status was also verified; this
does not prove provider task execution or microphone acceptance. The initial full Windows desktop
suite passed 868 tests with 20 platform skips, followed by its source startup smoke. These results
make an environment-specific CI failure plausible, but do not identify the original runner's cause.

Actual package inspection found a separate defect: the after-pack hook rebuilt `app.asar` with only
native-library unpack rules, erasing the configured sherpa-onnx JS/WASM unpacking. The shared ASAR
builder now preserves the sherpa directory; a real archive replacement regression failed before
the fix and passed on both macOS and Windows afterward.

Windows runtime execution also exposed three test timing assumptions. The startup-exit check now
starts its two-second exit deadline after module loading, with an outer cold-start watchdog. MCP
shutdown waits for an active tool call, and confirmation expiry waits for the expected state instead
of assuming several timer steps complete within 30 ms. Production deadlines remain unchanged.
An additional full-run failure exposed a test polling loop that survived its timeout and kept the
process alive. The helper now stops polling; its regression verifies no further observations after
timeout. The metadata-transition test opens its real graph fixture before assembly startup, so
Windows Worker cold-start I/O does not accidentally exercise the separate one-second abandonment
contract. Dedicated bounded-start tests retain that coverage.

The actual Windows ASAR Worker/WASM smoke passed: synthetic positive audio produced one hit and
negative audio produced zero. A paced positive run during runtime rebuilding produced one hit with
126 frames offered, 124 accepted and 9 frames reported dropped. An idle-machine repeat produced
one hit with 131/131 frames accepted and 2 reported dropped; neither is zero-drop or human audio
acceptance. The unpacked application was built using the installed Electron 43.2.0 distribution
after the initial Electron download stalled. NSIS creation then failed on a GitHub connection timeout
(`ETIMEDOUT`), so the installer is not claimed built or validated.

The [runner assessment](../../handoffs/2026-09-06-windows-runner-assessment.md) records capacity,
account isolation and a proposed workflow; no runner was registered. This repository is public:
standard GitHub-hosted runner minutes are currently free, correcting the earlier cost assumption.

For the product/test tree committed as `afc82dd`, the final local serial
`check → test:runtime → test:desktop → test:cli` passed:
runtime 2356 pass / 5 skips, desktop 886 pass / 3 skips, CLI 21/21. Windows Node 22.23.2 `check`
passed, and the final full Windows runtime suite passed 2208 tests / 8 platform skips in 241 seconds.
The final Windows desktop suite reused the already built application and passed 869 tests / 20
platform skips in 51 seconds; its real source-window startup smoke passed, followed by CLI 21/21.
These Alibaba Windows results apply to the same `afc82dd` product/test tree: testing started from
`860f108` with the final follow-up patches, then the six changed files were compared with the pushed
dev tree before fast-forwarding the checkout. They are not evidence for later review fixes.
At that checkpoint no further GitHub Actions runs were requested. The historical hosted-Windows source startup timeout
remains unclassified; local Windows success does not retroactively make that run green. No main
merge, release, runner registration, or human acceptance completion was performed.

### Second integration review repairs (2026-09-06)

The [review resolution map](../../handoffs/2026-09-06-integration-review-followup.md)
records every finding, including proposals not adopted after checking the actual
call chain and the user's approved decisions. Published history remains intact.

- Journal replay now belongs to live-owner startup; non-live maintenance opens
  survive corrupt or contended journals and report their unavailable state.
- Requested responses carry per-attempt identities through the actual cascaded
  provider. Tests reproduce both bounded-ledger eviction and same-revision retries;
  comparing only the current revision would not fix them. Pre-start audio and
  quarantined terminals cannot release or disarm another request.
- Knowledge close resolves best-effort after a 500 ms graceful-exit budget, inside
  assembly's 1-second cleanup budget. Real SQLite contention, forced close/reopen
  and full assembly cleanup are covered; immediate lock release is not promised.
  Partial HTTP rejection responses now have explicit completion assertions.
- Corrupt settings recovery records preserve bytes and open the recovery UI while
  blocking automatic backend startup, Codex rescan and workspace-clear restart
  bypasses. Manual repair followed by the existing recovery action is covered.
- All 15 desktop wire types have actual producer coverage; byte drift is part of
  `npm run check`. Wake hide/helper/extraction gaps, exact dependency membership and
  equality of both ASAR unpack declarations have regression coverage.
- Windows candidate runs the narrowed runtime suite. Pending human acceptance no
  longer blocks candidate artifact construction; main and publication still require
  the acceptance ledger. No bypass of mandatory release acceptance was added.
- I5 keeps the [approved tool-result continuation permissions](../../decisions/2026-09-06-i5-tool-result-continuation.md); ordinal/legacy digest
  compatibility remains documented. Spec 04 maps its checklist to concrete evidence.
  Inline delivery scenarios and necessary test hooks remain; no cosmetic JSON or
  broad test-API refactor was added.

On the repaired code tree through `154ae6c`, the local serial
`check → test:runtime → test:desktop → test:cli` passed (Node 24.8.0):

| Gate | Result |
| --- | --- |
| `check` | Passed; parity 226 files / 385 reviewed occurrences, boundary 215, generated wire drift check |
| runtime | 2367 passed / 5 skips: 2 Windows-only, 3 opt-in live model evaluations without credentials |
| desktop | 893 passed / 3 platform skips |
| CLI | 21/21 |
| documentation contract | 8/8 |

The final native Electron capability smoke exposed an obsolete source-extraction
endpoint in the smoke script after the settings startup guard changed. Extraction
now ends at the supervisor block itself. Scoped lint and the real smoke passed:
budget 1 yields `configuration_required`, budget 24 connects and shuts down cleanly,
both have zero readiness timeouts; only dummy loopback services were used.

The desktop command's Windows-only source-startup smoke is skipped on this Mac.
Earlier Alibaba Windows results remain anchored to `afc82dd` above. No main merge
or publication is part of this repair.

Hosted CI on **`883113daf8b459f41efb62b99e4f77fa15e44727`** passed all three platform
jobs: [run 34036272128](https://github.com/deepnovacore/NovaAudioAgent/actions/runs/34036272128).
This ordinary dev push had no `[skip ci]` marker.

| Hosted platform | Runtime pass / skip | Desktop pass / skip | Additional evidence |
| --- | --- | --- | --- |
| macOS | 2367 / 5 | 893 / 3 | CLI 21/21; real Electron capability smoke; final build |
| Ubuntu | 2367 / 5 | 873 / 23 | CLI 21/21; source build, not a Linux release package |
| Windows | 2217 / 8 | 875 / 21 | CLI 21/21; real source-window startup smoke; final build |

All platform `check` gates passed. On macOS/Ubuntu, runtime skips comprise two
Windows-specific cases and three opt-in live coordinator evaluations without keys;
on Windows, the narrowed suite also skips five POSIX/symlink cases. Desktop skips
cover platform-specific native helpers, visual cases and platform-specific release
script fixtures. These counts do not certify skipped features or human acceptance.
The main-only readiness job and tag-only package job were correctly skipped on dev.

The earlier `da38a59` hosted-Windows startup timeout remains historically failed
and unclassified. This new source-startup success is evidence for `883113d`, not a
retrospective diagnosis.

The receipt-only `4c9516c` run subsequently passed macOS/Ubuntu but exposed an
intermittent Windows test teardown race:
[run 34036782632](https://github.com/deepnovacore/NovaAudioAgent/actions/runs/34036782632).
Windows runtime and CLI passed; desktop's interrupted-download test reached fixture
removal before the second Worker's exit-handler cleanup finished, producing `EPERM`
on that owner's directory. Source startup was not reached in this failed run.

The test now joins the actual asynchronous cleanup promises and, on failure paths,
waits for owned Workers before removing the fixture root. The fake download-progress
probe also checks its own thread's archive instead of another active download's
file. No production lifecycle or retry budget changed. All seven model tests and
20 consecutive repetitions of the interrupted-download case passed locally; the
full desktop rerun passed 893 tests / 3 platform skips. Independent review confirmed
the original removal promises still propagate errors on the assertion path. A
targeted Alibaba Windows retry could not establish a session; the user confirmed
the machine was powered off and asked to leave it alone. No remote test pass is
claimed. The resulting final HEAD receives normal CI; its exact run
is available in branch checks without recursively committing its own hash here.

### Third review: residual repairs and decision evidence (2026-09-06)

Baseline **`7c97983c6e9c16e7df507ce9c65ea5f0a1dcec86`** passed hosted CI:
[run 34037915786](https://github.com/deepnovacore/NovaAudioAgent/actions/runs/34037915786).
All three electron jobs passed; dev correctly skipped release readiness and tag
packaging. macOS/Ubuntu runtime was 2367 passed / 5 skipped; Windows runtime was
2217 / 8. Desktop was macOS 893 / 3, Ubuntu 873 / 23, Windows 875 / 21; CLI was
21/21 on each platform. Windows passed the repaired interrupted-download test and
the real source-window startup smoke. This is the missing receipt for the fix of
`4c9516c`, distinct from the earlier `883113d` receipt above.

This follow-up was reviewed as one related repair batch:

- R-F: `ProjectStore.open` only replays on live startup, but maintenance open and
  refresh also call cleanup. Those calls now acquire a temporary owner lock before
  modifying journal/workspace files, inside the existing tracked transaction.
  Nonblocking owner acquisition avoids an owner/transaction lock-order deadlock.
  Ordinary transaction contention becomes `degraded` with `lifecycleBusy`, so it
  does not stop a live backend. Known pending/unsafe health survives subsequent
  contention; only successful recovery can clear it. Real maintenance-open,
  prepared/committed live-owner and downstream no-stop regressions cover this;
  removing ownership or known-hazard retention makes the respective regression fail.
- Settings: rejected rescan no longer reports success. Pending recovery has an
  explicit controller phase; successful recovery clears its old notice without
  introducing notices on ordinary edits or overwriting an unrelated restart notice.
- Contracts: pin the six existing Windows runtime file exclusions and second-instance
  wake routing. Windows-only candidate scope now runs desktop tests. Remove the
  unused `RUNTIME_PACKAGE` constant. The six exclusions still omit some Windows
  cases inside mixed POSIX suites; they were not silently widened or certified.
- K-3: the proposed extra-reconnect defect does not occur during explicit stop or
  restart: supervisor running/generation fencing rejects the old exit callback.
  An executable regression uses the real supervisor, diagnostic collector and
  shutdown helper with an `assembly_failed`/exit-2 child; stop/restart schedule no
  retry, while unexpected exit still schedules one. Worker failure error semantics
  remain unchanged.
- I4: the actual silent epoch-revocation path rejects through ProviderSession, and
  RealtimeSession already rolls back its exact request slot. A full cascaded-chain
  regression pins no-terminal/no-provider-error rejection, retry, reconnect and
  stale-epoch rejection. Removing the slot rollback makes the test fail; no new
  production cancellation mechanism was necessary.
- Documentation: remove the nonexistent `knowledge.autoRecall` default, add wake
  Panel IA/capture paths, date the 55/65-test Knowledge evidence, mark the proven
  fixture executor item, fix the reported layout issues, and preserve the exact
  approved I5 instructions in a linked [decision record](../../decisions/2026-09-06-i5-tool-result-continuation.md).
  That record explicitly identifies itself as a transcription of this conversation.

Local verification of this repair batch ran serially: `check` passed (parity
226 files / 385 occurrences; executor boundary 215 allowlisted), runtime
2372 passed / 5 skipped, desktop 902 / 3, CLI 21/21. The documentation contract
also passed 8/8. The real Electron capability-status smoke passed with isolated
loopback fixtures: insufficient budget failed as expected, sufficient budget
connected and stopped cleanly, with no readiness timeouts. The Windows-only
source-startup smoke was skipped on this macOS host. `check:release-gate` still
fails as expected on all 12 pending acceptance rows; none was marked complete.

The powered-off Alibaba Windows development machine remains untouched. Human voice,
installed-package acceptance and the release ledger remain separate from dev CI;
no main merge, package publication or acceptance checkbox inflation is authorized.
