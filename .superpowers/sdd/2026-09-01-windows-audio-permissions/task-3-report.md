# Task 3 report: Windows Codex approval transport and controller

## Result

Implemented the Windows foreground approval broker boundary for Codex app-server. Only a realtime project transport on `win32` with an explicit foreground broker selects `on-request`; ordinary, live, brokerless Windows, macOS, and Linux remain exactly `never`. No credential was added, and no Task 4 Qwen/Realtime/desktop/renderer surface was implemented.

## API and ownership

- `CodexApprovalController` owns one pending approval, creates an opaque Nova ID, applies a 60-second host TTL, publishes immutable bounded display details, exposes `observe`, `acceptDecision`, `consume`, `pending`, `view`, and `invalidate`, and spends a decision exactly once.
- `routeCodexApprovalServerRequest` handles only `item/fileChange/requestApproval` and `item/commandExecution/requestApproval`. Unknown methods return `undefined`, preserving the existing `unexpected_server_request` transport path.
- `CodexTransportBinding` and `CodexAssemblyResource` expose the selected `approvalPolicy` and nullable controller for Task 4. `CreateCodexAssemblyResourceOptions.codexApprovalBroker.publish` is the explicit foreground-broker capability.
- The transport sends the selected thread approval policy, validates the exact echoed policy, invalidates approval state on turn completion, protocol/transport failure, and close, and relies on the Task 2 request signal for end/poison aborts.

## Codex 0.149.1 wire verification

Generated and inspected the installed `codex-cli 0.149.1` app-server JSON schema locally before implementation. The actual file request contains `threadId`, `turnId`, `itemId`, `startedAtMs`, optional `reason`, and optional `grantRoot`; file changes arrive first in `item/started` as a `fileChange` item. Update move targets use `kind.move_path`. The command request fields include the complete `command`, `cwd`, approval/item identity, network context, environment identity, and proposed policy amendments. The response wire is `{decision}`.

Production schema preflight now pins `v2/ItemStartedNotification.json`. Projection retains only an unambiguous preceding current-turn `fileChange` item and removes it on item or turn completion.

## Fail-closed rules

- File requests require the active thread/turn/item, an official preceding in-progress `fileChange` item, bounded changes/diffs, and every path/move target normalized beneath the canonical workspace through its nearest existing canonical ancestor. Missing, duplicate, malformed, escaped, or oversized context declines.
- `grantRoot` accepts only null/absent or the exact canonical workspace. It never creates durable authority; a returned accept is one-shot.
- Command requests require one complete non-empty command of at most 4,096 code points and the exact canonical workspace cwd. Network context, environment/additional permissions, and exec/network amendments decline. The broker neither parses shell text nor auto-approves.
- Concurrent requests, stale decisions, expiry, terminal turns, transport loss, and invalidation all decline.

## TDD evidence

RED was observed before each production slice:

- controller tests: missing `realtime/codex-approval` module (`TS2307`);
- platform/projection tests: missing policy selector/bind option;
- routing and fake-server tests: missing request route and file-item projection;
- factory tests: missing brokered resource/binding fields;
- schema preflight tests: 2 expected failures while `ItemStartedNotification` was not production-pinned;
- self-review terminal-item test: expected null but received the stale started item.

GREEN after the minimal corresponding implementation:

- controller/routing/projection/platform/factory/schema focused set: 44 pass, 1 platform-expected skip;
- projection terminal-item tightening: 16/16 pass;
- complete app-server transport suite: 83/83 pass, including the real fake child file and command approval round trip.

## Verification commands and results

- `npm run typecheck --workspace @nova-audio-agent/runtime` — pass.
- `npm run lint --workspace @nova-audio-agent/runtime` — pass.
- `npm run build --workspace @nova-audio-agent/runtime` — pass.
- `node --test runtime/dist/test/realtime-codex-approval.test.js runtime/dist/test/codex-approval-transport.test.js runtime/dist/test/codex-turn-projection.test.js runtime/dist/test/codex-project-platform-policy.test.js runtime/dist/test/codex-factory.test.js runtime/dist/test/codex-app-server-schema.test.js` — pass (44 pass, 1 skip before the terminal-item tightening; tightened projection separately 16/16).
- `node --test runtime/dist/test/codex-app-server-transport.test.js` — pass (83/83).
- `git diff --check` — pass.

## Self-review and concerns

Checked the implementation against every brief step and the authoritative spec: only the two approved methods are recognized; all non-Windows/non-broker paths remain `never`; thread projection verifies the response policy; no shell parsing, automatic approval, credential, generic confirmation framework, or Task 4 integration was introduced. The generated schema scratch directory was verified beneath the worktree and removed.

Concerns: none.
