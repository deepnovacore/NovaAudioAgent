# Flutter v0.3.0 workbench

Updated 2026-10-04. Public branch `feature/flutter-ios-v020`; Mac and Tailscale,
one connected phone. Windows pairing remains M6. No mobile push or connector
management. Physical M5 acceptance was explicitly deferred.

## Implementation

| Stage | Result |
| --- | --- |
| M0 | Backup `backup/flutter-ios-v020-before-v030-20261003` at `a8d6f442`; merged public `v0.3.0dev` (`aacec636`) without conflicts in merge `96c9cfa8`. Updated Flutter/Gradle fixture paths after merge. |
| M1 | Built-in Mac phone server shares the desktop PersonalAgentHost. Personal negotiation, projected snapshots/results, 1 MiB personal output, reload markers, 250 ms coalescing, command allowlist and remote non-takeover identity. Legacy clients retain their wire behavior and receive no personal snapshots on the shared endpoint. |
| M2 | PersonalStore, versioned commands, monotonic revisions, 32 pending requests, 30-second deadlines, bounded automatic reload plus manual refresh, credential-scoped secure cache. Text/dictation bind to a conversation; text waits for semantic receipts. No write replay after reconnect. |
| M3 | Nova/Today/Plan/Me shell, conversation switching, reminder actions, visible-read/presented receipts, global approvals with reopen entry and submission deduplication. |
| M4 | Today reminders/todos/tasks/goals; Plan todos/goals/ideas with edit, swipe, conversion and version-fenced undo; Me profile, memory and connection. Four synthetic phone-size golden scenes. |
| M5 | Pending on Xiaomi and iPhone; no physical synchronization, model execution or acoustic acceptance claimed. |

## Verification

- Full `npm test`: runtime 3298 passed / 8 skipped; desktop 1217 passed / 3
  skipped; CLI 30 passed; server CLI 4 passed. A merged desktop source assertion
  was updated to recognize the existing acceptance settings projection.
- Final protocol/ownership/reconnect regression pass after review: 70 passed,
  1 existing skip. Covers authenticated protocol fault vs credential rejection,
  legacy PCM routing, concurrent orb release, failed drain and reconnect retry.
- Flutter analyzer: no issues. Full Flutter tests: 80 passed, 1 opt-in socket
  test skipped. That socket test passed separately with
  `--dart-define=NOVA_SOCKET_ACCEPTANCE=true` against `tool/mobile_mock.mjs`.
- Socket evidence covers todo create/complete, stale-version rejection, idea to
  goal linkage, conversation creation, scoped text and semantic completion.
  It is synthetic, without model or external-service execution.
- Android debug APK and native unit/instrumentation-package builds passed.
- iOS simulator debug build passed with `NOVA_AOQ_SIMULATOR=1`; this excludes
  the vendor's device-only AOQ framework and is not voice acceptance.
- Full `tool/validate_mobile.sh` final rerun passed: package resolution, analyzer,
  80 Flutter tests (1 opt-in skip), Android APK/native checks and unsigned iOS
  device-target debug build. Compilation does not install or sign a device app.

## Independent reviews

Local Claude CLI `claude-sonnet-5-5` reviewed M1, M4, and the final state before
this report, with explicit user authorization to transmit code/docs. Follow-up
reviews checked fixes; the final bounded independent reviewer found no remaining
concrete P1/P2 in those fixes. Reviews were static, not device acceptance.

Resolved findings include capability-omission authorization, legacy snapshot
suppression, shared-host audio lifecycle and ownership, approval reopening and
presentation timing, pending text across conversation switches, native capture
cancellation, oversized-state recovery, cache deletion on forgetting/expiry,
background credential replacement, and authenticated protocol errors preserving
pairing credentials. Audio cleanup failures retain ownership until that endpoint
reconnects/retries stopping; hiding an explicit paused voice session does not
transfer ownership to another device.

## Public boundary and publication

The full reachable-history audit covered 1266 commits, 12174 blobs and 3916
historical paths at merge HEAD, plus changed files. No company pilot modules,
employee/tenant data or new internal integration was identified. The public
boundary regression passed. The four new images contain synthetic data and were
visually inspected.

One pre-existing public-history privacy issue remains: five historical blobs of
the now-deleted `docs/specs/v0.2.0/IOS-IMPLEMENTATION.md` retain a real tailnet
address. These objects already belong to public `fork/main` and `origin/main`;
they were not introduced here. Actual addresses are deliberately not repeated.
This audit does not claim public history is entirely free of private endpoints.
Any history cleanup needs a separate coordinated plan and verified recovery.

Push this public feature branch to `fork` first. `origin` requires the user's
confirmation. Do not publish private refs or touch the internal branches.
