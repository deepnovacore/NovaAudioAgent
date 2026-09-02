# Windows audio and Codex approval handoff

Date: 2026-09-02

Worktree: `C:\Users\fishwowater\Projects\NovaAudioAgent\.worktrees\fix-windows-audio-permissions`

Branch: `codex/fix-windows-audio-permissions`

Current HEAD: `183c879` (the local-main merge is retained; final realtime, prompt, desktop,
and test follow-ups are still uncommitted in this worktree)

## Current status

The function-authoritative approval correction is now implemented locally. Qwen Audio Realtime emits
the ASR transcript, assistant audio, and function call as unordered sibling outputs. The host therefore
uses `codex__confirm_codex_approval` as the only voice authorization carrier; ASR text is retained only
for Memory/audit and contributes item/revision provenance, but its meaning cannot spend permission
authority. A renderer click competes with that function for the same one-shot Codex controller.

Project confirmation and Codex approval still expose two typed public functions and keep separate
business controllers, TTLs, and occupancy. They now use separate instances of one policy-free
confirmation-turn isolation primitive for response/item/function correlation, silent carriers, and
foreground release. This is shared mechanism, not a merged authorization domain or a generic public
confirmation function.

The renderer PCM/FIFO fix remains valid. The latest Windows trace isolated a separate multi-minute
terminal delay before provider injection: a standalone `background:delegate-1` response emitted its
first audio but never emitted `response.done`, then held `final:delegate-1` until Qwen's 180-second
`response_idle_timeout` forced reconnect. A terminal handoff now precisely supersedes only its own
standalone fallback acknowledgement; continuation responses remain outside the new cancel path.
Approval context is confirmed with a context-only provider injection before any audible question or voice attempt begins.
At most two fresh attempts are allowed, each with one same-turn structured-function retry; only one
host-owned clarification may be audible. Old attempt responses/functions are quarantined and refused.

Automated tests and a real credentialed Codex 0.151 preflight have passed within the limits documented
below. The branch is **not yet PR-ready**: Windows headset/manual normal-write and terminal-speech
checks remain. The final complete-suite rerun and post-telemetry security/platform reviews are now
captured below. No macOS hardware run has been performed. Static platform review confirms Darwin remains
`approvalPolicy: never` with a null Codex approval controller and unchanged native audio code.

### Merge attribution

The latest-main merge is not the source of the third manual-test regression. The branch parent before
merge is `b3aea41`; the merge result is `fd6e9b4`. The exact `b3aea41..fd6e9b4` diff changes only
Codex HOME/credential derivation, Orb reduced-motion visuals, and installed-candidate smoke coverage.
It does not change `RealtimeService`, the Codex approval controller, renderer PCM/FIFO code, or their
tests. The fragile combination—speech onset retires the provider approval item while successful voice
authority still depends on a later provider tool call—already exists at `b3aea41`. Earlier successful
manual behavior therefore does not establish the old voice path as deterministic: renderer clicks
settle directly, while spoken confirmation could succeed only when the model emitted its tool before
the dynamic context was lost. The newer `background:delegate-1` timing made that latent path reliable
enough to reproduce; main did not introduce it.

## Confirmed root causes and fixes

### 1. Suspended browser audio blocked renderer control traffic

Windows browser playback could wait indefinitely in `AudioContext.resume()` while PCM shared the generic renderer FIFO with captions, `codex.*`, clear, terminal, and clock messages. PCM now uses an independent playback tail with a bounded resume watchdog. Generic control traffic and `playback.clear` continue while playback is suspended, and generation checks discard stale PCM after a clear. The Darwin native playback path is unchanged.

### 2. File approval was silently declined before the banner

Nova incorrectly required `item/fileChange/requestApproval.params.startedAtMs` to equal the preceding `item/started.startedAtMs`. Codex 0.151 defines these as two independent timestamps: approval-request start and item-lifecycle start. A normal mismatch returned `{decision:"decline"}` before `CodexApprovalController.offer()`, so neither the renderer banner nor the Qwen approval host item could exist.

The projection now validates the request timestamp independently and correlates the approval through the active thread ID, active turn ID, exact item ID, and the still-in-progress file-change item. Completed items, completed turns, malformed timestamps, path escapes, junction escapes, and malformed payloads remain fail-closed.

Regression fixture: lifecycle `startedAtMs=1000`, approval request `startedAtMs=1001`. The old code reproduced a controller-pending timeout; the fixed code reaches the approval controller.

### 3. Codex-created children could become unreadable to the desktop user

An existing managed project root had this effective shape:

```text
fishwowater:(F)
CodexSandboxUsers:(OI)(CI)(M)
sandbox SID:(OI)(CI)(M)
```

The owner ACE did not inherit. A child created by the Codex sandbox inherited only sandbox principals, after which the desktop user received `Access denied`.

The managed container's `icacls` output includes `(OI)(CI)(F)`. Workspace `protectAt` uses the same object/container inheritance flags when it reapplies the protected project-root ACL. The managed-container DACL remains unprotected so its inheritable policy can apply to new children. Before a managed workspace is admitted for a new or resumed run, the store descriptor-relatively reapplies the protected project-root ACL, migrating existing roots without trusting a renderer/model path.

### 4. Codex 0.151 preflight compatibility

Version admission accepts normal SemVer plus product prerelease/build forms such as `0.151.0-alpha.7.2`, while rejecting malformed/ambiguous labels. The live schema accepts the reviewed 0.151 command `kind` shape and the older command shape. Local `main` also contributed case-insensitive Windows environment lookup and `USERPROFILE -> HOME` fallback.

### 5. Approval banner appeared before its spoken question

The Windows Codex approval banner was published immediately, but its spoken host item was queued as non-preemptive. If another response still owned the realtime speech floor, the question waited until the user spoke and interrupted that response, then played late. This was a realtime scheduling problem, not a remaining browser `AudioContext.resume()` wait.

Codex approval questions are now preemptive host items. They cancel an actively speaking response and take the next audible turn; settling the approval while preemption is in flight retires the unsaid question so it cannot play after the decision. Existing safeguards still prevent a preemptive item from interrupting an idle agent, and an actual user utterance remains higher priority.

## Memory Board changes

- Section auto-scroll is disabled; refresh preserves page and keyed section scroll positions.
- A `复制 JSON` button requests the same validated, bounded full snapshot used by export and sends it through a sender-validated preload/main IPC route. Electron main writes with `clipboard.writeText`; the sandboxed renderer is not granted arbitrary web clipboard permission or an arbitrary-text write API.
- Both the copy and export actions are hidden on the Graph tab.

## Network approvals

Network permission requests are not forwarded to the user in this branch and do not produce an
approval banner. The foreground broker intentionally supports bounded file-change and command-
execution approvals only. Network approval context, policy amendments, session-wide acceptance, and
Codex 0.151 `item/permissions/requestApproval` remain fail-closed. Do not state that arbitrary Codex
permission requests are supported.

This also limits the product value of the bridge. With the Windows ACL fixed, ordinary operations
inside a canonical `workspaceWrite` root should proceed without any approval request. The broker is a
narrow compatibility/UX path for the two reviewed app-server request shapes, not a prerequisite for
normal workspace writes and not a solution for package downloads or other network access. The signed-
in local E2E already confirmed this distinction: a legal workspace write completed without invoking
the broker. Before release, capture whether a representative ACL-correct run produces either supported
request in practice; if it does not, treat the bridge as dormant compatibility behavior rather than a
headline capability. Do not widen it merely to make the manual test fire.

## Latest terminal-announcement stall and narrow repair

The 18:46 Windows headset run proved both Codex approval functions were healthy. The first carrier
settled from `source:function` at `t=84.960`; the second settled at `t=102.088`, before its sibling ASR
final arrived at `t=102.532`. Both passed the current approval ID, epoch, item, response, revision, TTL,
and one-shot checks, and Codex subsequently created and verified the empty `test.py`.

The missing completion was a different response owner. After the second approval, the reopened
standalone `background:delegate-1` acknowledgement was injected at `t=102.531`; Qwen started its
response at `t=103.269`, emitted first audio at `t=104.154`, and the Windows renderer acknowledged
playback start about 21 ms later. Codex completed and queued `final:delegate-1` at `t=106.748`, but the
background response never emitted a provider terminal. At `t=287.730`, Qwen emitted its recoverable
`response_idle_timeout`; reconnect cleared the old generation, and the final was injected at
`t=291.235`. The roughly 184.5-second queue delay was therefore before final provider injection, not
an `AudioContext.resume()` delay.

The narrow repair retains the existing pre-audio `suppressResponse` path. If the same delegate's
terminal handoff finds its standalone fallback acknowledgement already audible, it uses the existing
exact-ID `quarantineResponse(responseId)` path. The response must be in the current provider epoch and
have `binding === 'fallback'`; a continuation or unrelated/newer response cannot enter the new cancel
path. Renderer clear and the exact provider terminal release the queued final, which remains deduped.
The cancellation task is tracked during service shutdown.

The regression reproduced the real shape: an empty continuation reopens `background:d-1` as a
standalone host fact, that fallback begins audio without terminating, and the matching handoff arrives.
It was RED without a `cancel:standalone-ack`; it is GREEN with exact cancellation and one
`final:d-1` injection. The prior playing-continuation fixture now explicitly asserts no provider cancel.
Realtime service is 245/245; independent diff-only review reports no Critical, Important, or Minor
finding and identifies no new macOS/native-audio path.

## Verification evidence

### Final local evidence

- Final context-first/two-attempt/prompt/telemetry confirmation chain: 381/381. This includes context
  failure and exact-TTL renderer/function telemetry, function/transcript orderings, no-VAD provisional
  carriers, old-attempt quarantine, one audible host clarification, silent decision carriers, Guard
  priority, project confirmation, and macOS/no-controller factory/assembly coverage.
- Independent security re-review after both telemetry follow-ups: no Critical, Important, or Minor
  finding. Independent platform review: no Critical or Important macOS/no-controller/native-audio
  finding; its only noted debt is the pre-existing unconditional POSIX `0600` assertion on Windows.
- `npm run check`: pass, including Node parity 173/232.
- Desktop suite rerun with the required host-user elevation: 767 pass, 0 fail, 19 platform skips.
- CLI suite: 18/18 pass.
- Fresh serial full runtime suite after terminal-supersession: 2,014 total; 1,984 pass, 27 skip, 3 fail. All three failures reproduce on main
  and are Windows/POSIX-mode assumptions: two telemetry fixtures expect `stat.mode` to report `0600`,
  and one legacy-home migration fixture assumes POSIX mode behavior. This run is **not all green**;
  these failures are recorded as unchanged-main platform debt rather than approval regressions.
- Windows NSIS packaging completed successfully. `inspect:package` passed for `win32-x64`; latest installer
  SHA-256 is `ba606d9e43100e9120125cd84de77e5adee5d8414421751f4d6abc8ab2f4f83b`.
  This local artifact is not Authenticode-signed and must not be represented as a signed release.
- The installer silently upgraded the current-user formal installation with exit code 0. Installed
  `resources/app.asar` exactly matches the generated `win-unpacked` artifact at
  `a79e480c283df042b204fa18f07bf2d4e30ed3e924e86c1ae325801a6797d343`.
- The formal installed EXE starts from `AppData\\Local\\Programs`, loads the persisted TetrisGame /
  Session 任务 7 state, remains `待命 · Codex 空闲`, and opens the in-app settings panel. A packaged
  production Codex smoke using the host's signed-in Codex executable passed real credential/preflight
  startup and clean shutdown.
- Real signed-in Codex 0.151 credentials, thread startup, and preflight succeeded. The simple workspace
  write used for that check was legitimately allowed by the sandbox's `workspaceWrite` policy, so it
  did not trigger an approval request. The older diagnostic trace therefore is not proof of a real
  foreground-broker `accept` E2E. The temporary diagnostic probe was removed.

### Earlier evidence (historical, retained for audit)

- The lifecycle/request timestamp fixture (`1000` / `1001`) was RED before projection correction and
  reaches the controller after it.
- Managed-workspace run/resume admission re-applies the root ACL; the focused resume test confirms an
  additional `protectAt` call. Managed-container native coverage asserts `(OI)(CI)(F)`; it must not be
  described as an `icacls` round-trip on the protected workspace root.
- Earlier browser/native audio, renderer routing, Memory Board, preload, sender-validation, and build
  runs are preserved in the manual-test sections below. Their counts predate the final isolation and
  must not replace the final evidence above.

## Second manual-test findings (historical; later authority design superseded this fix)

Evidence: `C:\Users\fishwowater\Projects\NovaAudioAgent\memory-board-2026-09-02T03-50-03-572Z.json`.

### Approval speech repeated, while clicking worked

This is not repeated controller admission. For approval `f9f2...`, the Board contains one
`hostitem.queued` and one `hostitem.injected`, followed by two different provider responses that
spoke the same neutral approval sentence. Later `eabb...` and `379d...` are distinct Codex approval
IDs. The controller and renderer banner therefore remain one-shot; the repetition is in provider
response ownership after an interrupted spoken approval.

The local renderer reported speech onset and cleared each approval generation, but the provider did
not produce a matching registered user item before the final transcript. The final transcript `确。`
was accepted into conversation Memory, while `user_origin.transcript_resolution` recorded
`user_input_revision: -1` and `status: rejected`: the session advances a final-only user turn, but the
service currently registers user-origin evidence only from provider speech-start/end events carrying
an item ID. The real final-only path is absent from the current approval voice tests.

There is a second fail-closed check after that missing registration: `确。` normalizes to `确`, which is
not one of the explicit complete yes/no phrases. A full `确认。` must remain required; the fix must not
weaken the exact approval ID, current epoch/revision, origin binding, response ownership, or explicit
yes/no checks.

Renderer clicks work because they are direct local-user authority on the same one-shot controller and
intentionally do not depend on provider transcript/origin evidence.

### Completion was queued, then spoken minutes late

Codex completed normally. The Board records `codex.handoff outcome=ok` at diagnostic sequence 134 and
`final:delegate-1` queued at sequence 135. The completion fact was not suppressed by proactive policy.
It was a normal priority-50, non-preemptive final waiting for `foregroundIdle`, while approval response
`realtime-44` still owned provider/playback state.

Settling an approval removes its host event, but once that approval response has already opened audio,
`suppressResponse()` refuses the transfer and the current removal path does not fence/cancel that
response. The stale approval turn can therefore continue holding the foreground and delay the final.
The later audible completion confirms delayed delivery rather than a lost handoff.

### Implemented fix

- A trusted, accepted final transcript that arrives without a preceding provider VAD item ID is
  registered against the exact user item and the session's newly advanced current revision before its
  Memory origin is resolved. The existing exact approval ID, epoch, current revision, response owner,
  origin ref, and explicit yes/no checks remain unchanged.
- Local renderer onset retires the exact pending approval host event before cancelling its audible
  response, so the same injected fact cannot seed another repeated provider answer.
- A banner decision captures the exact approval response owner before consuming the one-shot
  controller, then fences and cancels only that response. It cannot target a newer user response.

### Platform scope

Both browser capture and macOS native VoiceProcessingIO feed the same renderer `detectLocalOnset`
boundary. Windows always uses browser AEC, while macOS normally uses VoiceProcessingIO and falls back
to browser AEC only when native startup fails. The missing-VAD/final-only ledger gap is therefore a
shared runtime bug that is more readily exposed by the Windows browser capture/event timing; it is not
implemented as a Windows-only exception. No Darwin native-audio code was changed.

### Regression coverage

1. A final-only, post-request `确认。` item is registered at the session's new current revision and can
   authorize only an exact-ID decision tool call from its own user response.
2. `确。`, stale revisions, wrong IDs, host-owned approval/background responses, and mismatched tool
   booleans remain refused.
3. Local speech onset does not allow one injected approval fact to generate repeated spoken approval
   responses while the user's answer is pending.
4. A renderer click or valid voice decision retires and cancels an already-audible approval response;
   a Codex final queued immediately afterwards becomes deliverable without waiting for an unrelated
   multi-minute provider/playback release.
5. Existing user-priority, project-confirmation, acknowledgement replay, renderer FIFO, and one-shot
   approval tests remain green.

Post-fix evidence:

- Realtime service/session/state, floor, desktop bridge/composition, Codex approval transport, and
  approval E2E: 353/353 pass.
- Runtime lint: pass.
- Browser/native audio, onset, playback generation, and renderer FIFO: 54/54 pass.
- Ambient Orb production build validation: pass; the first launch hit one backend-readiness timeout,
  while a clean second launch remained connected and showed `待命 · Codex 空闲`.
- The final-only test was mutation-checked: removing the new ledger registration produces
  `approval_not_authorized`; restoring it passes.

## Third manual-test findings and direct-ASR experiment (historical; superseded)

Evidence:
`C:\Users\fishwowater\.codex\attachments\5f6adc64-0b69-4d17-ac23-2f3d64ce21dc\pasted-text.txt`.

This newer Board supersedes the claim that the second manual-test fix fully repaired voice approval.
It shows one Codex delegate and one real approval request, not repeated file creation:

- Codex starts once, advances from `internal_activity=2` to `internal_activity=3`, modifies one file,
  and produces one terminal handoff.
- The approval lifecycle has one public ID,
  `1a5fea53d96a4d349a7a6ed7c69845ec`, with one `hostitem.queued` and one
  `hostitem.injected` approval event.
- The renderer reports the only accepted decision at diagnostic sequence 71, at 190.887 seconds,
  from a banner click. There is no approval `tool_call_ready` before it.

### Why `确认。` did not dismiss the banner

The attempted anti-replay change calls `#removeQueuedCodexApprovalPrompt()` from both local renderer
speech onset and accepted provider `user_speech_started`. That helper currently combines three
different operations:

1. removing an unsent prompt from Nova's local host queue;
2. stopping/releasing an already-audible prompt response; and
3. retiring the injected approval host item from the provider session.

Operation 3 is too early during user onset. The retired host item is the model's only source of the
dynamic `approval_id`. The first transcript, `确。`, is correctly rejected by the strict deterministic
parser because it is not a complete yes/no decision. Before the second transcript, `确认。`, is
resolved, `background:delegate-1` has become the newest host fact and the approval fact has already
been deleted. The model therefore has neither the required ID nor the prompt condition needed to call
`codex__confirm_codex_approval`.

`explicitCodexApprovalDecision()` does parse the complete `确认。` as `true`, but the current service
only records that boolean in `#codexApprovalUserDecisions`. The map is consumed exclusively if the
model subsequently emits the dedicated tool call. With no tool call, the one-shot
`CodexApprovalController` remains pending, so the banner is correct to remain visible. Clicking works
because renderer authority goes directly to the same controller and does not depend on a model call.

### Why Nova sounded as if it was creating the file repeatedly

The repeated sentence is one `background:delegate-1` semantic acknowledgement, not another Codex
dispatch, another delegate, or another approval. The approval prompt and then the background
acknowledgement were interrupted with `played_ms=0`; a later replay was interrupted after only
241 ms. The acknowledgement ledger treats each as unheard, reopens the same semantic event, and asks
the provider to speak it again. In this trace that lower-priority host fact is delivered immediately
after local speech releases the old approval response, so it can steal the response turn that should
handle the user's answer.

The attachment's diagnostic stream ends around 191 seconds. It proves that the full `确认。` resolved,
no approval tool ran, and only the banner click settled the controller. A separate, later user-pasted
extended conversation excerpt contains the 389.5-second stale “Codex 正在启动” speech. That later
observation is consistent with retained response/floor ownership, but it is not evidence contained in
the attachment and must not be presented as part of the same timestamped trace.

### Historical direct-ASR experiment — rejected as the target design

The implementation keeps the existing one-shot controller and fail-closed approval scope, while
separating provider speech cleanup from host decision authority:

1. A trusted, accepted, post-request final user item whose Memory origin is resolved, whose epoch and
   revision are current, and whose entire normalized transcript is one of the existing explicit yes/no
   phrases should settle the exact pending approval through `codexApprovalDecision()`. This uses the
   same controller race as a renderer click; it does not authorize substring matches, `确。`, questions,
   mixed decisions, stale turns, wrong epochs, or a different approval ID.
2. Keep `codex__confirm_codex_approval` as a compatibility path, but do not make successful voice
   approval depend on a stochastic provider function call or on the provider retaining a public ID
   after the user has already supplied an exact decision.
3. When the exact user-bound response already exists, quarantine only that response after the host
   settles the voice decision. This prevents a late “确认收到/正在启动” response from holding the floor
   ahead of the Codex terminal fact. A newer user or host response must never be targeted.
4. Keep the existing local-speech anti-replay cleanup: it may stop the old approval audio and retire
   the provider copy of that prompt, because the trusted host now owns the exact yes/no decision. Do
   not retain the provider fact and build a second prompt-replay lifecycle merely so the model can
   recover the public ID.
5. While this exact approval authority is pending, an already queued `background:*` semantic
   acknowledgement remains in the existing heap instead of opening a competing provider response.
   Controller settlement wakes normal delivery, so the acknowledgement is delayed rather than
   dropped. This was added only after a RED test reproduced the observed turn steal; it does not add
   a second acknowledgement cache, expiry path, or replay state machine.

This experiment is confined to `runtime/src/realtime/service.ts`, but confinement does not make its
authority model correct. The later dual-output review below supersedes points 1–4: ASR must not spend
the controller, and user onset must not retire the provider approval context needed by the dedicated
decision function. The semantic-acknowledgement floor gate in point 5 remains a valid requirement.

### Historical direct-ASR regression coverage and evidence

1. Deliver and start an approval prompt, interrupt it, then provide a bound final `确认。` without any
   `tool_call_ready`; the exact approval promise must resolve to `accept`, the banner view must publish
   pending=false, and the exact bound response must be cancelled.
2. Repeat with `确。`, `确认？`, mixed yes/no, a stale revision, an unresolved Memory origin, and a
   pre-request item; all must leave the controller pending.
3. Keep the existing approval-prompt anti-replay test green, and add an evidence test showing that a
   complete transcript settles without depending on a later `background:delegate-1` provider turn.
4. Race click and voice decisions; exactly one wins and exactly one JSON-RPC response is written.
5. Queue a Codex terminal fact immediately after voice settlement; it must become deliverable without
   waiting for the stale user response.
6. Run the full realtime service/session/floor/bridge and approval E2E suites, renderer browser/native
   audio suites, Ambient Orb production build, runtime lint, and `git diff --check`.

Current local evidence for this third correction:

- The direct-transcript test was RED before the service change (`still-pending` instead of `accept`)
  and is now green.
- The acknowledgement-floor test was mutation-checked: removing the pending-approval gate injects
  `background:d-1`; restoring it keeps the acknowledgement queued until settlement and then delivers
  it once.
- Full `realtime-service.test.ts`: 195/195 pass.
- Focused fake-app-server approval E2E: 11/11 pass, including one JSON-RPC response when a compatibility
  tool arrives after direct voice settlement.
- Final post-review approval/service run: 206/206 pass. Final desktop browser-audio/router/Memory
  Board/main/preload run: 120/120 pass.
- Runtime lint and `git diff --check`: pass.
- Full runtime: 1,940 total; 1,910 pass, 27 Windows platform skips, and 3 deterministic failures.
  The failures are unchanged-main POSIX-mode fixtures: one expects `chmod(0755)` to become observable
  on Windows, and two expect Windows `stat.mode` to report POSIX `0600` instead of `0666`. The failing
  source and assertions are identical at local `main`; the approval E2E in the same run is green.
- Focused desktop audio/approval/Memory Board/ACL set: 174 total; 161 pass, 13 macOS-only skips,
  0 fail. This includes suspended browser playback, renderer control routing, one-shot approval UI,
  sender-validated JSON copy, Windows root authority, and the Darwin native-audio source contract.
- Full desktop: 786 total; 763 pass, 19 skips, and 4 failures when run as the restricted
  `CodexSandboxOffline` account. All four are Windows owner/ACL/process-tree fixtures; their native
  probe reports `Access denied`. Rerunning those exact files as the signed-in host user is 28/28
  green. Ambient Orb production build validation and the host-user source-startup smoke both pass.

Historical note for the earlier direct-ASR implementation: after its two reviews, that earlier client
build was restarted as the signed-in host user from this worktree. This does **not** establish that the
current fifth-implementation code has been rebuilt or remains running. It was process/readiness
evidence for the superseded implementation only; the current spoken-confirmation behavior still
requires the manual sequence below.

### Platform and macOS regression boundary

Foreground Codex permission brokering is enabled only for Windows project runs, so the new approval
authority is dormant on the normal macOS Codex path. The shared realtime event loop still runs on both
platforms, therefore review and tests must prove that ordinary user turns, project confirmation,
semantic acknowledgements without a pending Codex approval, Guard preemption, and Darwin native
VoiceProcessingIO remain unchanged. No Darwin native-audio file should be modified for this fix.

The earlier Terra/Luna reviews predate the corrected Qwen dual-output model and therefore are not
architectural sign-off for direct-ASR settlement. Their platform and regression observations remain
useful, but the conclusion that the transcript may spend authority is superseded. The background
acknowledgement still must not take the approval turn; provider prompt audio may be stopped on onset,
but the approval context itself must remain until settlement, expiry, invalidation, or a renderer
click consumes it.

An independent Luna design review confirms that production foreground Codex brokering is constructed only
for `win32 + project + foregroundBroker`; normal Darwin runs do not get this approval controller, and
no Darwin native-audio file changed. Because `RealtimeService` is shared, this is a platform boundary,
not a substitute for the generic regression suite. The fresh Terra final-diff review reports no
actionable findings after checking click/voice one-shot races, late tools, expiry/reconnect/close,
acknowledgement wakeups, and approval scope; its independent runtime typecheck passes. The fresh Luna
final-diff review also reports no actionable findings after checking Darwin native-audio/resource
boundaries, no-controller realtime, project confirmation, approval-floor routing, suspended browser
PCM, Memory Board scroll retention, and sender-validated copy IPC. Luna independently confirms that
`b3aea41..fd6e9b4` does not touch the target realtime/audio/Board paths, so latest main does not
plausibly cause this Windows bug.

## Fourth manual-test findings (historical; root repair is in the fifth implementation)

Evidence:

- Board export:
  `C:\Users\fishwowater\.codex\attachments\6255adab-e44d-405f-b33b-d2ab25aebb0c\pasted-text.txt`
- The same run's later safe timing fields from
  `C:\Users\fishwowater\.nova-audio-agent\realtime-telemetry.jsonl`.

The functional result is positive: Codex creates the empty `abc.txt` and returns a completed result.
Voice approval also eventually succeeds. The remaining defect is delivery latency after completion.

### Exact timing and where the delay is not

The Board export ends shortly after Codex completion, so by itself it cannot prove a permanent stall.
The later telemetry provides the missing boundary:

| Boundary | Time (s) | Delta |
| --- | ---: | ---: |
| Codex handoff `ok`; `final:delegate-1` queued | 105.900 | — |
| `final:delegate-1` injected into provider | 286.679 | **180.778 s** |
| provider response started, session epoch 2 | 287.016 | 0.336 s |
| first provider audio delta / first PCM frame queued | 287.708 | 0.693 s |
| renderer `playback_started` | 287.731 | **0.022 s** |

Therefore the long delay is before provider injection, while the terminal host fact is waiting for
Realtime response/floor authority. Once injected, provider generation and Windows browser playback are
fast. Calling this another `AudioContext.resume()` regression is contradicted by the trace.

The epoch-2 response proves that a provider-session replacement occurred before the final fact was
delivered. Current telemetry does not record the reconnect cause, so the exact trigger that replaced
epoch 1 must remain labelled unknown rather than inferred from elapsed time.

### Why this can still look Windows-only

The relevant approval controller exists in production only for
`win32 + project + foregroundBroker` (`codexApprovalPolicyForTransport`). Normal macOS runs never
enter this approval-settlement branch. The observed platform split is therefore consistent with a
recent approval-lifecycle regression in shared `RealtimeService`, even though the failing code is not
the Windows renderer or audio backend.

This fourth defect is also not attributable to the latest-main merge. The direct transcript settlement
and exact response-quarantine code are current uncommitted follow-up changes relative to `fd6e9b4`.
The old provider-tool-only path did not settle the controller at transcript-final time in this way.

### Symptom-level regression hypothesis, superseded as the primary repair

The first answer, `允许，确认。`, is deliberately not one complete allow phrase: normalization yields a
mixed phrase, so fail-closed parsing leaves the approval pending. Around that turn the provider accepts
`resp_WI1JCdklsXdlmyjxKYyYh` in epoch 1 at user revision 4, but telemetry shows no user-item binding for
that response. A later complete `允许。` is accepted at revision 5 and lets Codex proceed.

The recent host-direct settlement code then cancels an active provider response only when
`itemForResponse(epoch, responseId)` exactly equals the deciding item. It has no reviewed rule for an
active response that is post-request but belongs to a strictly older user revision or lacks the item
binding because response start won the attribution race. Such a response can retain the provider slot,
leaving `final:delegate-1` queued until a later reconnect clears epoch 1.

This remains a plausible explanation for the observed three-minute floor retention, but it is no
longer the right primary repair target. Expanding the direct-ASR cancellation predicate would treat a
consequence of the wrong authority boundary while keeping that boundary in place. Current telemetry does not expose the
active response's host-event ownership or record a voice-settlement cancellation decision. A temporary
RED experiment reproduced the revision-4-active / revision-5-explicit ordering and failed because no
cancel was sent. Per the request to stop before fixing, both that test and the tentative production
change were reverted; the worktree contains neither.

### Earlier review plan (superseded; retained to explain rejected alternatives)

1. Add telemetry for safe response lifecycle boundaries: provider terminal, approval settlement source,
   active response revision/item-match verdict, exact cancel target, and reconnect reason. Do not log
   transcripts, commands, paths, or approval local detail.
2. Add a RED service test matching the real order: mixed/ambiguous approval answer opens revision 4;
   a later exact revision-5 decision settles without a tool; the exact older response must release;
   then `final:delegate-1` must inject without a reconnect.
3. Review the narrow cancellation predicate rather than adopting it blindly. Candidate rule: same
   session and exact response ID, and either the deciding item owns it or its turn revision is strictly
   after approval creation but strictly before the deciding revision. Pre-request, same-revision,
   missing-revision, current/newer, different-epoch responses remain untouchable.
4. Decide whether an approval-specific terminal watchdog is also required. If an exact cancel is sent
   but no terminal arrives, reuse the bounded recovery posture of project-confirmation carriers instead
   of allowing an indefinite provider slot. Recovery must not reconnect over an active user floor.
5. Add explicit negative tests for pre-request/same/newer responses, click-vs-voice one-shot races,
   ambiguous/questions, reconnect/expiry/close, no-controller realtime, and Darwin factory policy.
6. Only after reviewer agreement: implement one bounded change, run the full shared-runtime and desktop
   matrix, then repeat the same `abc.txt` manual trace before credentialed E2E or PR work.

The telemetry additions remain useful. The proposed revision-range cancellation rule and approval-
specific watchdog must not be implemented first; the shared confirmation-turn design below should
remove the direct-ASR settlement race before any residual carrier leak is evaluated.

## Fifth/final implementation: share confirmation-turn isolation, not authority

### Verified Qwen event model

`runtime/src/realtime/qwen.ts` normalizes three independent provider event families:

- `conversation.item.input_audio_transcription.completed` becomes `user_transcript_final`;
- `response.audio.*` / `response.*text*` become assistant audio/transcript events; and
- `response.function_call_arguments.done` becomes `tool_call_ready`.

There is no adapter or service contract that orders the user transcript before the assistant response
or its function call. The earlier normalization fixture happened to feed transcript first, but that
was fixture order, not a provider guarantee. The removed direct-ASR experiment could spend the one-
shot controller while the sibling response was already speaking or before its dedicated function
arrived. A late function was then refused as not pending, and a normal-audio response could retain the
floor. That was the root architectural flaw behind the double-use conflict; changing only the
response-cancellation predicate would have treated a symptom.

### Authority rule

For voice, `codex__confirm_codex_approval` is the structured authorization carrier. The transcript
never settles the controller by itself. A renderer banner click remains direct local authority on the
same one-shot controller. If Qwen does not emit the dedicated function, the banner stays pending until
the user clicks, the request expires, or it is invalidated; Nova does not use a late transcript as a
fallback grant.

ASR has two separable roles:

1. Its **text meaning** belongs to Memory, captions, diagnostics, and audit. It should not initiate or
   independently decide an approval.
2. Existing user-item/origin bookkeeping may use transcript completion as provenance that a function
   belongs to a real current user turn. This is correlation, not semantic authority. Function-first
   waits boundedly for provenance instead of being rejected. The implemented policy does not require
   lexical transcript agreement: the function and transcript are siblings from the same model, so the
   text is not independent evidence and a whitelist would reject natural variants without adding a
   separate trust source.

### Implemented consolidation boundary

The implementation extracts the mature *internal* confirmation-turn machinery from project
confirmation without merging project operations and Codex permissions into one controller or one
broad authorization type.

Each workflow owns its own instance of the shared confirmation-turn coordinator. The primitive owns:

- one pending request identity, epoch, creation revision, expiry, and one reserved user item;
- order-independent response/item/function correlation, including a bounded function-first slot;
- a structured-decision path and a direct-renderer path racing the same one-shot lifecycle;
- suppression/quarantine of the reserved answer response so it is an authorization carrier, not an
  ordinary audible reply;
- release on terminal without a decision, and invalidation on newer turn, expiry, reconnect, or close;
- prompt-audio interruption that is distinct from retiring the provider approval context; and
- blocking generic semantic acknowledgements while confirmation owns the foreground, then waking
  delivery after actual settlement or invalidation.

Workflow policy must remain outside that coordinator:

- project confirmation retains proposal construction, workspace/session commit capability,
  rollback, retry, and deterministic result facts;
- Codex approval retains canonical workspace/path validation, file-vs-command scope, the 60-second
  app-server request, one-time `accept`/`decline`, and fail-closed rejection of network/session-wide
  grants; and
- the renderer continues to display workflow-specific details while Qwen receives only the opaque ID,
  kind, and neutral summary appropriate to that workflow.

For this release, the two public tools—`codex__confirm_project_action` and
`codex__confirm_codex_approval`—remain typed adapters into separate coordinator instances. Collapsing
them into a new generic public tool would change model instructions, schemas, project-confirmation
fixtures, and both workflows at once, while also making cross-domain ID mistakes harder to review.
It provides little value for this bug. The final Qwen prompt tightens use of the existing Codex tool;
the public function count and schemas are unchanged.

### Required response isolation

The project-confirmation path is the reference behavior:

1. user onset reserves the exact provider item;
2. stopping the spoken question does **not** delete the confirmation authority/context;
3. a response created for that reserved item is allowed to carry the dedicated function but its
   normal audio is suppressed;
4. unrelated tools in that response are refused;
5. function-first waits for binding/provenance and transcript-first waits for the function;
6. only the current, unexpired, exactly bound ID/epoch/item/response may settle;
7. settlement injects one tool output, fences the carrier, clears the banner, and releases queued
   semantic/final facts; and
8. no function leaves the request pending rather than inventing authority.

Codex approval now reuses this isolation shape without copying project commit/rollback policy. The
host first confirms a context-only injection containing the opaque approval fact. Only then does it
open attempt one and request the audible question. Each attempt permits one same-turn structured-
decision retry. If attempt one produces no valid function, the host speaks one clarification and
atomically opens a fresh attempt two; old deferred calls and carrier responses cannot inherit it.
After attempt two is exhausted, voice authority closes while the banner remains pending and clickable
until the original 60-second controller TTL. There is no ASR-text fallback.

### Final behavior and review corrections

The product policy is resolved in favor of the project-consistent design: the structured function is
authoritative after the host proves the current opaque ID, epoch, reserved item, bound response,
revision, TTL, and controller state. Transcript meaning is not an allow/deny predicate.

The final implementation also makes the answer response a silent authorization carrier. User onset
may stop or fence the spoken question, but it does not retire the injected provider approval fact.
Function-first delivery waits in a bounded correlation slot for its item/response provenance. A valid
function and a renderer click race one one-shot controller; the loser receives a deterministic tool
result and cannot create a second JSON-RPC decision. While either workflow owns its confirmation turn,
`background:delegate` acknowledgement delivery is blocked; settlement or invalidation wakes the queue
immediately.

Fresh implementation reviews found four material lifecycle gaps, all fixed before the final runs:

1. **Retry re-open:** creating the single Codex decision retry could reopen a carrier that had already
   been settled or invalidated. Retry admission now rechecks the live authority/isolation identity.
2. **Deferred missing output:** a deferred function that lost a click/function race could be released
   without its required tool output. Every deferred call now completes exactly once, including refused
   and race-loser paths.
3. **Inverse overlap:** the opposite project/Codex overlap order exposed an occupancy handoff hole.
   The two independent isolation instances now block and wake foreground work symmetrically without
   sharing a pending slot or business controller.
4. **Async refusal reconnect:** one asynchronous refusal path could reject outward and be interpreted
   as a realtime-session failure. Refusal completion is now contained and cannot cause a reconnect.

The last review then found one more unordered-event gap: Qwen can produce a complete answer response
without either provider VAD boundary, so the response initially has neither a user item nor a usable
user revision. The exact failing sequence was:

1. the approval question finishes;
2. Qwen emits `response_started` for the answer with no preceding `user_speech_started` or
   `user_speech_ended` item;
3. `response_audio_delta` and `tool_call_ready` for `codex__confirm_codex_approval` arrive while the
   sibling transcript is still absent;
4. `response_terminal` may arrive next; and
5. only then does `user_transcript_final` reveal the exact user item.

Rejecting at step 3 loses a valid function; treating the unbound response as ordinary speech leaks
audio and may retain the foreground. The implemented fix tracks one bounded **provisional response**
for the pending Codex approval, silences it immediately, and may retain its deferred function across a
terminal. When the final-only transcript reveals the one exact next user item, the isolation binds
that response to the item and revision, releases the function, and lets the normal host ID/epoch/TTL/
one-shot checks decide it. ASR text still supplies no allow/deny meaning; it contributes only item and
revision provenance. Multiple eligible provisional responses are ambiguous and fail closed instead of
letting one transcript authorize an arbitrary response.

The Qwen system instructions were tightened narrowly: for a current Codex approval, emit the existing
typed decision function exactly once and do not also produce an ordinary answer for that carrier. This
is model guidance, not the security boundary; host correlation and one-shot checks remain authoritative.
No new function was added, and the two existing confirmation schemas were not merged or widened.

The final follow-up makes the model/runtime contract explicit for ambiguous speech: Qwen must emit
neither the approval function nor ordinary text/audio and wait for the host-owned clarification. The
clarification is deliberately outside the carrier classifier, so it remains audible while every
decision carrier stays silent. This changes only the existing tool description and gated Qwen
instructions; tool names, count, parameters, schema, and project confirmation remain unchanged.

Privacy-safe diagnostics were also added. `codex_approval.context`, `.attempt`, `.carrier`, and
`.decision` expose only epoch/attempt and closed lifecycle enums. Provider reconnect records only a
closed reason plus `started|completed|skipped_epoch|failed`. Approval/provider/item/response/call IDs,
transcripts, paths, commands, operation bodies, and free-form errors are not emitted by these new
events. Private observed/expired identities are used only to classify a late decision at the exact TTL;
they never enter authorization, never restore or extend a controller, and never enter telemetry.

### Final regression coverage

The final automated evidence is summarized in the top verification section. In particular, the
permutation and race coverage includes function-first, item/response-first, transcript completion as
provenance only, terminal-before-correlation, click/function races, missing function output, retry
exhaustion, expiry/reconnect/close invalidation, both project/Codex overlap orders, acknowledgement
block/wake, no-controller realtime, and existing project-confirmation behavior. Ordinary carrier audio
is suppressed; ASR-only input leaves the banner pending.

The no-VAD follow-up adds four service regressions and two primitive regressions:

1. response/audio/function/terminal before the final-only transcript stays silent and settles once
   after exact item provenance appears;
2. final-only transcript before the structured function binds the same carrier without authorizing by
   transcript text;
3. a final-only terminal with no function requests only the one bounded structured retry;
4. a wrong approval identity is refused while the renderer click remains viable;
5. the isolation promotes one bounded provisional response after its next user item is revealed; and
6. two provisional candidates are ambiguous and neither may inherit that item.

No Darwin native-audio implementation file was changed for this authority correction. Automated
shared-runtime, browser-AEC, source-contract, and platform-gated tests reduce regression risk, but they
are not a substitute for an actual macOS headset run. Do not claim macOS hardware validation.

## Manual hardware test still required

First run an ordinary create/edit/read task in the canonical managed workspace. With the ACL fixed,
it should complete under `workspaceWrite` without an approval request or banner. That is the primary
product path. Separately, if a real reviewed `item/fileChange/requestApproval` or
`item/commandExecution/requestApproval` can be triggered without widening network/session policy,
use the running Windows client with the intended headset and verify all of the following:

1. The banner and its spoken question arrive promptly; the question must not appear minutes later when
   the user begins speaking.
2. Saying an unambiguous approval or decline makes Qwen emit the dedicated function and clears the
   banner once. ASR text alone must not clear it.
3. Race the spoken decision against a banner click. Exactly one decision wins, with no duplicate
   prompt, acknowledgement, or app-server response.
4. After Codex completes, the terminal announcement is injected and played promptly rather than after
   a minute-scale foreground stall.
5. The requested file/command outcome matches the winning decision, and a following read/write does
   not report `patch rejected by user` or `Access denied`.

The real Codex 0.151 credential/thread/preflight check already succeeded, and its legal workspace
write correctly did not request approval. That validates the normal path but not the optional
foreground-broker path. Do not manufacture a network approval or widen policy merely to satisfy this
manual check; if no supported request appears in representative use, record the broker as dormant and
rely on fake app-server E2E plus controller/headset tests for that compatibility path. Do not call the
branch PR-ready until the normal workspace task and terminal-speech timing pass.

## Current verdict and short reviewer note

The root repair, including context-first activation, two fresh attempts, no-VAD/final-only correlation,
closed diagnostics, and host-owned clarification, is implemented and has broad automated coverage.
The final security review reports no Critical, Important, or Minor finding. The platform review reports
no Critical/Important macOS or no-controller regression; its only Minor is the pre-existing Windows
test assumption that `stat.mode` must report POSIX `0600`. Release acceptance is still conditional on
the Windows headset/normal-write test above. Historical direct-ASR and revision-range-cancellation
plans in this document are explicitly superseded; they must not be revived as a fallback. The branch
is not claimed PR-ready.

Short review request:

> Qwen ASR, audio, and tool calls are unordered siblings, so ASR text no longer grants Codex
> permission. The existing typed approval function is the sole voice authority; click and function
> share one one-shot controller. Project and Codex confirmation keep separate controllers/TTLs and
> use separate instances of a shared silent-carrier isolation primitive. Context-only injection must
> complete before attempt one; at most one host clarification opens attempt two. A bounded provisional
> carrier covers response/audio/function/terminal arriving before a no-VAD final-only transcript; ASR
> only supplies item/revision provenance. Please focus on stale-attempt quarantine, context/click/expiry
> races, retry outputs, acknowledgement wakeup, privacy-safe telemetry, and terminal delivery. Ordinary
> ACL-correct workspace writes should not request approval; network/session-wide grants remain
> unsupported. Automated coverage is broad, but Windows headset timing and macOS hardware behavior
> have not been claimed.
