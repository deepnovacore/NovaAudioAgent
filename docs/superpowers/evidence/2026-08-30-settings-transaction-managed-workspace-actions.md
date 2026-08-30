# Settings Transaction and Managed Workspace Actions Evidence

Date: 2026-08-30

Branch: `feature/settings-transaction-managed-workspace-actions`

Base: `b4b265e docs(design): stage settings and managed workspace actions`

## Review-remediation verification status

Task 3 verification after `7ea0b8d fix(desktop): gate backend on workspace recovery`:

- `npm run build --workspace @nova-audio-agent/runtime`: PASS.
- `npm run build --workspace @nova-audio-agent/ambient-orb`: PASS.
- Desktop rollback/startup/settings/workspace/security focused suite: PASS, 118 tests, 0 failed.
- The final runtime and desktop full suites are intentionally deferred to Task 4; no Task 3 result below is presented as final branch-wide verification.

## Pre-review implementation verification (historical)

The following results were recorded before the review-remediation commits and are retained only as historical evidence, not as current final-suite counts:

- `npm run build --workspace @nova-audio-agent/runtime`: PASS
- Runtime maintenance/store/native focused suite: PASS, 77 tests, 0 failed.
- `npm run typecheck --workspace @nova-audio-agent/runtime`: PASS
- `npm run lint --workspace @nova-audio-agent/runtime`: PASS
- `npm run build --workspace @nova-audio-agent/ambient-orb`: PASS
- Desktop lifecycle/settings/workspace/security focused suite: PASS, 108 tests, 0 failed.
- `npm test --workspace @nova-audio-agent/ambient-orb`: PASS, 713 passed, 3 platform-specific skips, 0 failed. The optional source startup smoke reported `skipped`; a real Electron GUI smoke was run separately below.
- `npm run check`: PASS. Environment contract matched and Node parity passed with 169 files and 223 occurrences.
- `git diff --check`: PASS.

## Real Electron GUI smoke (historical)

The app was launched from the isolated worktree with `npm run start:client` and inspected through the macOS accessibility surface.

| Acceptance item | Result | Evidence |
| --- | --- | --- |
| Editing a public setting does not apply before Save | OBSERVED PASS | Selected Graphite; Save became enabled while the running backend remained unchanged. |
| One Save performs one transaction and reconnects | OBSERVED PASS | UI showed `保存中…`, then `设置已保存` and `已保存，后台已重启并重新连接`. The pre-save utility process was replaced by exactly one post-save utility process. |
| Settings controls remain usable in automatic Codex discovery mode | OBSERVED PASS | Managed-workspace controls remained visible outside the hidden manual-path section. |
| Registered current workspace is not treated as managed | OBSERVED PASS | `打开当前托管 workspace` and `清空当前托管 workspace` were disabled for the active registered repository. |
| Open an exact disposable managed directory | BLOCKED BY ENVIRONMENT | The active repository was registered and no disposable managed target was available. Host-only resolution is covered by the focused test. |
| Execute destructive current/all clear and inspect unknown children | BLOCKED BY ENVIRONMENT | No disposable managed workspace existed. Permanent deletion was intentionally not performed against user data; double-confirmation, opaque authorization, native identity checks, recovery, and failure paths are covered by automated tests. |
| Preserve a newer edit made during an in-flight save | BLOCKED BY ENVIRONMENT | The real restart window was not made deterministic enough for a safe manual race. The controller test verifies the newer revision remains dirty. |
| Restore user-visible preference after smoke | OBSERVED PASS | Ember was restored, saved, and the app again reported a completed restart and reconnect before the test process was stopped. |

## Scope and safety audit

- Settings are staged in the renderer and submitted only by the explicit Save action.
- The committed apply path durably writes once, refreshes configuration, and awaits exactly one lifecycle-owned backend restart.
- Failed apply phases retain submitted drafts for retry; live Main status pushes do not overwrite newer renderer drafts.
- Workspace IPC methods are zero-argument, sender-bound, and return bounded public status without filesystem paths or project IDs.
- Managed clear authorization binds an opaque preparation to the state revision and target identities, is single-use, and fails closed when cleanup is already pending.
- The maintenance journal records explicit `prepared` and `committed` phases plus each operation-created replacement identity. Recovery only removes a journal-bound replacement, preserves populated or substituted directories, and only deletes journal-bound tombstones after commit.
- An unresolved pre-commit recovery reports `rollback_pending`, still opens the maintenance service and Electron Orb/Settings surfaces, instantiates the backend supervisor without starting it, disables workspace actions, and leaves explicit Save plus bounded recovery retry available.
- Backend startup, settings restart, Codex rescan restart, and the existing zero-argument backend retry all pass through the same recovery gate. Explicit retry refreshes maintenance first and starts only after rollback health clears.
- The managed-workspace public view exposes only bounded health plus independent current/all availability and count; capability failure is `unavailable`, not an empty-workspace claim.
- An abandoned prepared desktop configuration is explicitly discarded and closes its uncommitted maintenance owner.
- Renderer draft/rejection ownership uses one unambiguous encoded leaf path internally, so a dotted public leaf cannot collide with a nested leaf.
- Store replacement results distinguish stale validation from a filesystem failure that rolled back successfully, so the UI reports the latter as `clear_failed` rather than `stale`.
- Batch clear detaches the complete validated target set before it creates any replacement directory.
- Destructive removal stays inside the native descriptor/handle-relative authority layer; imported and registered directories are never eligible.
- Current-workspace opening retains the store transaction and revalidates the exact managed identity around the host callback.
- A partial clear combined with backend recovery failure remains a distinct bounded status instead of being reported as a successful workspace operation.
- Existing telemetry, agent-search work, and unrelated changes in the main checkout were not staged, overwritten, or committed.

## Independent review follow-up

A read-only review of `b4b265e..0172478` found that the first implementation interleaved target rename/replacement and could not distinguish a pre-commit crash journal from post-commit cleanup. Follow-up review also required exact replacement identities and a fail-closed backend boundary for unresolved rollback. The corrections added explicit journal phases and identities, all-target phase ordering, failpoint/restart/substitution tests, retained-path validation, compound failure reporting, an awaited configuration commit, bounded maintenance health, and rollback-aware Electron startup/retry. Task 3 focused verification is recorded above; Task 4 owns final full-suite verification.

## Implementation commits

- `6b1a129 feat(desktop): serialize lifecycle operations`
- `1012368 feat(settings): stage edits until explicit save`
- `2147ba4 feat(runtime): revision project maintenance snapshots`
- `61704b3 feat(runtime): remove managed tombstones by native authority`
- `ffba0cf feat(runtime): add managed workspace maintenance service`
- `f04652d feat(desktop): apply settings in one restart transaction`
- `9e4caa0 feat(desktop): add managed workspace actions`
- `0172478 test: verify settings and workspace maintenance flow`
- `ddf7273 fix(runtime): recover managed clear transactions`
- `8ca4ec7 fix(runtime): bind rollback replacements by identity`
- `16e24b5 docs: record managed maintenance verification`
- `daabc50 fix(runtime): distinguish rolled back maintenance`
- `22cf40e fix(desktop): bound native tree deletion`
- `8c38c75 fix(runtime): expose managed maintenance health`
- `17803fa fix(runtime): preserve foreign maintenance journals`
- `7ea0b8d fix(desktop): gate backend on workspace recovery`
