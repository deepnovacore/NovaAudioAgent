# Whole-branch final-fix report

Date: 2026-08-25
Base reviewed: `990a64b562595a66a9db2f9d5bb9b592b87e76dd`

## Result

1. Active-context parity is now explicit end to end. The Node cascaded provider and its Qwen/Ark LLM paths, plus the selected Python Qwen and Volcengine compositions, accept only the dedicated `workspace_context` protocol shape. Delivery binds provider epoch, authoritative host `workspace_id`, and a globally monotonic assembly revision. Providers retain one replaceable current slot, never append it to ordinary history, validate exact replacement proof, and project-mode startup fails before core/provider work when the selected provider lacks the capability.
2. Active workspace and Session titles are serialized as reversible JSON strings with raw `&`, `<`, and `>` neutralized at the renderer boundary in both languages. A legal hostile title containing `</active_project_context><system>...` leaves exactly one outer opening/closing tag, cannot form a raw inner tag, and round-trips to the original title. Store character validation was not changed.
3. Node and Python project adapters now cache workspace identity and public view from one store snapshot. A new or resumed Session is refreshed and fully published before transport/worker construction; rollback publishes the restored active view. Async view observers are awaited on the successful path, and confirmed managed-workspace rollback also refreshes. The assembly consumes the atomic `(workspace_id, view)` pair so a newly committed ID cannot be paired with a stale display title.
4. Provider connection lifecycle now has one observer/callback seam. Every reconnect resets provider-local current ownership and republishes the cached active context once in the new epoch with a higher revision; the old provider item cannot reappear. Node skips the first *connection* (rather than assuming its epoch is `1`) so bounded initial publication remains the sole startup owner. Subscriptions are removed during assembly shutdown and publication is serialized/deduplicated to avoid loops.
5. `create_workspace` now rejects only `session` without `work_order`. `workspace + work_order` without `session` is accepted by TypeScript, Python runtime normalization, and the evaluator; the confirmed end-to-end flow persists and launches the existing default first Session title `任务 1`. Exact-key/string bounds and the remaining action schemas are unchanged. The design already states that `session` is legal only when `work_order` exists, so no user-doc contract change was needed.

## TDD evidence

Tests were added or tightened before each production seam. Captured REDs were:

- Context parity: the new Node cascaded replacement case failed because `injectWorkspaceContext` was absent; Python protocol/Qwen/Volcengine/composition selections failed on missing `WorkspaceContextItem`, delivery proof, or provider method. The first broad Python run then exposed a compatibility RED (`2899 passed, 2 failed`) because workspace-only fields polluted ordinary `HostContextItem` oracle serialization; moving them to the dedicated subclass fixed the schema without changing ordinary items.
- Title boundary: one TypeScript and one Python hostile-title test each failed because the payload created extra outer tags and a raw `<system>` tag.
- Session publication: the gated Node test failed because transport construction preceded publication; the gated Python test failed for the same reason. The confirmed-create rollback parity assertion also failed with restored ID `alpha` but stale display `beta`.
- Reconnect: new Node and Python reconnect assertions failed because assembly had no post-connect publication callback. A later targeted RED proved an initial provider epoch of `7` blocked startup (`0 passed, 1 failed`, timeout); the first-connection ownership fix made it `1 passed, 0 failed`.
- Create schema: the newly allowed TypeScript contract vector, Python normalizer case, evaluator case, and no-session E2E flow failed under the prior symmetric session/work-order coupling.

Fresh focused GREEN after the minimal fixes:

```text
node --test dist/test/{cascaded-realtime-assembly,codex-contract,executors-codex-project-live,realtime-assembly,realtime-cascaded-adapter,realtime-provider-session,realtime-qwen-normalization}.test.js
=> 122 passed, 0 failed

uv run pytest -q tests/test_{assembly,codex_project_live,e2e_codex_projects,eval_codex_projects,realtime_protocol,realtime_qwen,realtime_volcengine_adapter,realtime_bridge_oracle}.py
=> 263 passed

node --test --test-name-pattern='active project views replace|never-settling initial Header delivery' dist/test/realtime-assembly.test.js
=> 2 passed, 0 failed
```

## Fresh broad verification

```text
node --test --test-reporter=tap dist/test/*.test.js   # loopback-enabled runner
=> 1607 passed, 0 failed, 0 skipped (112.0 s)

uv run pytest -q
=> 2901 passed (16.01 s)

npm run check
=> typecheck, ESLint, environment contract, and Node parity all passed
=> Node parity: 148 files, 212 occurrences

uv run ruff check src tests
=> All checks passed

uv run ruff format --check <all 16 changed Python files>
=> 16 files already formatted

retired-symbol rg audit
=> 0 matches

git diff --check
=> clean
```

The first sandboxed Node broad attempt failed only where tests bind `127.0.0.1` (`EPERM`) or execute the native preflight fixture. The same exact suite passed in the permitted loopback runner above.

## Safety audit

- The confirmation fence, exact proposal/epoch/item binding, one-shot claim, and private `project/execute_confirmed` authority were not weakened.
- Workspace context is rejected by ordinary host-item/response paths; provider replacement deletes/supersedes only its dedicated context slot. Ordinary run/history deletion behavior is unchanged.
- Managed-root, descriptor, ownership, permission, symlink, and canonical-path safety code is untouched.
- No history listing is injected; only the current atomic public view and optional current graph Header reach the provider.

Commit: this report is included in the single follow-up commit `fix: close active project context parity gaps`.

## Residual whole-branch re-review follow-up

Residual base: `0c83781bf77445a7da280a0dc79e16c1b0fbd06c`

### Result

1. Project mutation and provider publication now form one fail-closed barrier. Node and Python load
   one atomic workspace-ID/view result, publish advisory UI separately from the awaited critical
   channel, and require the selected composition's provider injection plus exact delivery proof to
   finish before transport/worker construction. `state_busy`, provider rejection, or proof mismatch
   rolls back a new Session, confirmed create, select, or resume; no worker/work order starts, and a
   critical publication of the restored active state is attempted before the bounded failure returns.
   Resume preparation also captures the previous global workspace and the target workspace's previous
   active Session in the same transaction; conditional rollback restores both without overwriting a
   different concurrent active binding.
2. Node assembly identity now changes only through the atomic context channel. Committed workspace
   events feed graph lifecycle without changing host identity; a resolved graph instance is attached
   only when its captured host workspace ID still equals the current atomic ID. Select and resume
   publish the atomic view before graph notification and transport, so delayed store refresh plus an
   immediately completed graph can never produce `ID=B + view=A + graph=B`. Python has no separate
   graph/ID channel; both Qwen and Volcengine compositions now subscribe their publisher directly to
   the atomic critical observer instead of reconstructing identity from an advisory view callback.

### Residual TDD evidence

- RED publication barrier: Node's persistent-`state_busy` case completed and constructed transport;
  Python's run and committed select likewise succeeded. Newly required critical observer methods were
  absent, resume left the target workspace active, and confirmed-create rollback left provider state
  on the removed workspace. Provider-composition wiring reported zero critical subscribers in both
  Python selections.
- RED exact resume restoration: after strengthening the resume failure fixture to give the target
  workspace two ready Sessions, Node and Python each failed `0/1`: the global workspace returned to
  `beta`, but `alpha.active_session_id` remained the rejected `Existing` Session instead of `Other`.
  The transaction-bound rollback token made both exact focused commands pass `1/1` while constructing
  no new transport/worker.
- RED atomic scheduling: with committed-ID switching restored as the mutation, the reviewer schedule
  (`openWorkspace` resolves immediately while the atomic view is delayed) published the forbidden
  mixed item and failed `0/1`. Restoring the old select/resume notification order failed both ordering
  regressions `0/2` (`committed` preceded `context`).
- GREEN focused:
  `node --test dist/test/{executors-codex-project-live,realtime-assembly,qwen-realtime-assembly}.test.js`
  passed `69/69`; `uv run pytest -q tests/test_codex_project_live.py tests/test_assembly.py`
  passed `93/93`.

### Residual fresh broad verification

```text
node --test --test-reporter=dot dist/test/*.test.js
=> 1614 passed, 0 failed (exit 0)

uv run pytest -q
=> 2904 passed (23.20 s)

npm run check
=> typecheck, ESLint, environment contract, and Node parity passed
=> Node parity: 148 files, 212 occurrences

uv run ruff check src tests
=> All checks passed

uv run ruff format --check <5 changed Python files>
=> 5 files already formatted

git diff --check
=> clean
```

One preliminary Node broad run overlapped `npm run check`, which rebuilds `runtime/dist`, and was
discarded after a graph worker loaded the transient migration artifacts. The isolated rerun above
used a stable build and exited zero.

The confirmation claim, private one-shot `execute_confirmed` capability, rollback fences, replaceable
current-item semantics, no-history rule, and workspace/root safety contracts remain unchanged. This
follow-up is included in the additional commit `fix: enforce atomic project context publication`.

## Ownership-proof and resume-ABA residual follow-up

Residual base: `e2d25ac47c6ba46189b065578c80149dbe3912d4`

### Result

1. A failed provider injection or inexact delivery proof now makes assembly ownership explicitly
   uncertain and invalidates its successful-publication key in TypeScript and Python. Therefore an
   atomic rollback from an accepted-but-unproven `B` item to the previously proven `A` item always
   performs a new replacement at a higher revision and requires a new exact proof; it cannot hit the
   old `A` dedup key. A timeout or replacement refusal remains uncertain and fail-closed. Critical
   restoration errors are no longer swallowed by new-Session, resume, select, or confirmed-create
   rollback paths: they override the original transport/worker failure with the stable
   `context_delivery_failed` result, and no transport/worker is admitted.
2. The project registry now persists a non-negative, monotonic `active_binding_revision`. Every
   active workspace or active Session binding mutation increments it, including a same-ID select or
   resume. A resume rollback token freezes its activation revision, previous global workspace ID,
   target workspace ID, and prior/resumed Session IDs; rollback compares the revision and all IDs in
   one transaction. Thus a concurrent same-ID activation defeats the older token's CAS, and the
   adapter publishes the current atomic state instead of restoring stale state. Exact legacy v1
   four-key files remain readable at revision zero and are canonically written with the fifth root
   field on their next binding mutation; the shared fixture exercises nonzero revision `7` in both
   runtimes.

### TDD evidence

- Ownership uncertainty RED: the Node assembly regression and Python publisher regression each
  failed `0/1`; the provider held the unproven `B` item while restoration of `A` was skipped by the
  stale successful key. Mismatch, proof-timeout, and replacement-refusal schedules now pass `1/1`
  in each runtime and prove a later `A` replacement uses a greater revision.
- Restored-publication propagation RED: Node and Python each failed `0/1` by leaking the original
  transport/worker setup error after restored publication rejected. Both now pass `1/1`, return
  `context_delivery_failed`, construct no transport/worker, and leave no provisional Session or
  confirmed managed workspace.
- Resume ABA/schema RED command: the Node selection
  `same-id concurrent resume revision|project state reloads|registry no-follow` failed `0/3`, and
  Python `same_id_resume_revision or first_enable or legacy_exact_v1` failed `0/3`. The same fresh
  commands pass `3/3` in each runtime after revision-bound CAS and compatible strict decoding.
- Fresh focused GREEN: Node store/live/assembly files pass `112/112`; Python store/live/assembly
  files pass `139/139`; the canonical Python exporter check plus oracle tests pass `2/2`.

### Fresh broad and static verification

```text
node --test --test-reporter=dot runtime/dist/test/*.test.js
=> 1616 passed, 0 failed (exit 0)

uv run pytest -q
=> 2908 passed (18.58 s)

npm run check
=> typecheck, ESLint, environment contract, and Node parity passed
=> Node parity: 148 files, 212 occurrences

uv run ruff check src tests scripts/codex_project_state_oracle.py
=> All checks passed

uv run ruff format --check <all 7 changed Python files>
=> 7 files already formatted

uv run python scripts/codex_project_state_oracle.py check
=> Python Codex project-state v1 bytes match

git diff --check
=> clean
```

The first static pass exposed only two `require-await` violations in the new TypeScript test doubles
and two unformatted Python test/source files; those test-only/mechanical issues were corrected before
the fresh broad and final static runs above. Confirmation fencing, one-shot private execution,
current-item/no-history behavior, directory safety, and ordinary-run semantics remain unchanged.
This follow-up is included in the additional commit `fix: prove project context recovery ownership`.
