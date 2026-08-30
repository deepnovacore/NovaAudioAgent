# Settings Transaction and Managed Workspace Actions Evidence

Date: 2026-08-31

Branch: `feature/settings-transaction-managed-workspace-actions`

Base: `b4b265e docs(design): stage settings and managed workspace actions`

Verified implementation tip: `222fa7b fix: close managed recovery edge cases`

## Final serial verification

The commands below ran serially from this worktree. This ordering is required because both runtime and desktop builds write `runtime/dist`.

| Command | Outcome |
| --- | --- |
| `npm run build --workspace @nova-audio-agent/runtime` | PASS, exit 0 |
| `node --test runtime/dist/test/codex-project-store.test.js runtime/dist/test/project-native-resource.test.js runtime/dist/test/managed-workspace-maintenance.test.js` | PASS, exit 0: 96 passed, 0 failed, 0 skipped |
| `npm run typecheck --workspace @nova-audio-agent/runtime` | PASS, exit 0 |
| `npm run lint --workspace @nova-audio-agent/runtime` | PASS, exit 0 |
| `npm test --workspace @nova-audio-agent/runtime` | PASS in a loopback-permitted environment, exit 0: 1,832 passed, 0 failed, 1 skipped |
| `node --test desktop/ambient-orb/test/backend-supervisor.test.mjs desktop/ambient-orb/test/workspace-actions.test.mjs desktop/ambient-orb/test/main-security.test.mjs` | PASS, exit 0: 71 passed, 0 failed, 0 skipped |
| `node --test --test-name-pattern='drain|shutdown|termination timeout|utility process|still spawning|already exited|destroyed stdin' desktop/ambient-orb/test/backend.test.mjs` | PASS, exit 0: 13 passed, 0 failed, 0 skipped |
| `npm test --workspace @nova-audio-agent/ambient-orb` | PASS in a loopback- and Electron-permitted environment, exit 0: 735 passed, 0 failed, 3 skipped; source-startup smoke reported `skipped` |
| `npm run check` | PASS, exit 0; generated environment contract matched; Node parity audit: 169 files, 223 occurrences |
| `git diff --check` | PASS, exit 0 |

The restricted sandbox refused the runtime and desktop loopback listeners with `listen EPERM: operation not permitted 127.0.0.1`. Re-running the unchanged full commands in a loopback- and Electron-permitted environment passed, so these are environment limitations rather than branch regressions.

## GUI and platform limits

- No destructive GUI operation was performed. In particular, this verification did not create a rollback journal in user data and did not execute current/all permanent clear without a disposable managed workspace.
- The degraded `rollback_pending` GUI was not manually visual-smoked in this pass: safely reaching it would require a disposable managed workspace and an interrupted maintenance transaction. Its startup gate, disabled actions, explicit retry, latching, and stale-retry invalidation are covered by the focused suite above; this is automated coverage, not visual acceptance evidence.
- The local full suite ran on macOS. Its three skips are Windows-only behavior tests (two Job-object ownership/EOF tests and the Unicode MSVC-batch test). Static Windows-contract tests ran, but this result is not native Windows CI or an installed Windows package smoke; obtain a Windows runner result before making either claim.

## Corrected scope narrative

Settings are staged in the renderer and commit only through explicit Save. A committed update performs one durable write, configuration refresh, and lifecycle-owned restart; rejected or newer drafts remain retryable. Workspace actions are zero-argument and sender-bound, use a prepared opaque authorization with identity/state binding, and keep imported or registered directories ineligible for managed deletion.

Managed cleanup is transactionally journaled. A prepared transaction restores originals after restart and removes only journal-bound replacements; committed cleanup removes only journal-bound tombstones. Foreign or unresolved rollback state remains fail-closed. Partial recovery preserves the original v1/v2 journal encoding, so a remaining legacy entry stays decodable after restart. Electron exposes bounded maintenance health, opens its surfaces but gates backend start/restart/rescan and workspace actions while recovery is pending, and permits an explicit safe retry. A supported-platform native authority that fails validation remains present-but-unavailable instead of being treated as absent. Backend termination requires an observed exit, while a late exit after a bounded failure permits a later retry.

This evidence establishes automated behavior at `222fa7b`; it does not establish visual acceptance of the degraded recovery surface, destruction against real user data, native Windows execution, or a production-provider/hardware run.

## Implementation commits (predecessors of this evidence commit)

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
- `cdce027 docs: record desktop rollback recovery`
- `66bc5bf fix(desktop): latch rollback recovery`
- `c98761b fix(desktop): invalidate stale recovery attempts`
- `506b198 docs: refresh settings transaction evidence`
- `0b6f0de fix(desktop): serialize managed workspace lifecycle`
- `e0c4a01 fix(runtime): harden managed replacement durability`
- `222fa7b fix: close managed recovery edge cases`
