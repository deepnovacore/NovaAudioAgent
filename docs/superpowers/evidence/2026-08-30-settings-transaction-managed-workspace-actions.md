# Settings Transaction and Managed Workspace Actions Evidence

Date: 2026-08-30

Branch: `feature/settings-transaction-managed-workspace-actions`

Base: `b4b265e docs(design): stage settings and managed workspace actions`

## Automated verification

- `npm run build --workspace @nova-audio-agent/runtime`: PASS
- Runtime maintenance/store/native focused suite: PASS, 71 tests, 0 failed.
- `npm run typecheck --workspace @nova-audio-agent/runtime`: PASS
- `npm run lint --workspace @nova-audio-agent/runtime`: PASS
- `npm run build --workspace @nova-audio-agent/ambient-orb`: PASS
- Desktop lifecycle/settings/workspace/security focused suite: PASS, 107 tests, 0 failed.
- `npm test --workspace @nova-audio-agent/ambient-orb`: PASS, 712 passed, 3 platform-specific skips, 0 failed. The optional source startup smoke reported `skipped`; a real Electron GUI smoke was run separately below.
- `npm run check`: PASS. Environment contract matched and Node parity passed with 169 files and 223 occurrences.
- `git diff --check`: PASS.

## Real Electron GUI smoke

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
- The maintenance journal records explicit `prepared` and `committed` phases. Recovery rolls back pre-commit tombstones, preserves any populated replacement, and only deletes journal-bound tombstones after commit.
- Batch clear detaches the complete validated target set before it creates any replacement directory.
- Destructive removal stays inside the native descriptor/handle-relative authority layer; imported and registered directories are never eligible.
- Current-workspace opening retains the store transaction and revalidates the exact managed identity around the host callback.
- A partial clear combined with backend recovery failure remains a distinct bounded status instead of being reported as a successful workspace operation.
- Existing telemetry, agent-search work, and unrelated changes in the main checkout were not staged, overwritten, or committed.

## Independent review follow-up

A read-only review of `b4b265e..0172478` found that the first implementation interleaved target rename/replacement and could not distinguish a pre-commit crash journal from post-commit cleanup. The follow-up correction added the explicit journal phases, all-target phase ordering, recovery tests, retained-path validation, compound failure reporting, and an awaited configuration commit. The final verification results above were collected after these corrections.

## Implementation commits

- `6b1a129 feat(desktop): serialize lifecycle operations`
- `1012368 feat(settings): stage edits until explicit save`
- `2147ba4 feat(runtime): revision project maintenance snapshots`
- `61704b3 feat(runtime): remove managed tombstones by native authority`
- `ffba0cf feat(runtime): add managed workspace maintenance service`
- `f04652d feat(desktop): apply settings in one restart transaction`
- `9e4caa0 feat(desktop): add managed workspace actions`
