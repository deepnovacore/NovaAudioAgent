# Integration review follow-up

Base: `afc82dd`. Scope: repair and verify `v0.2.0dev`; no main merge or release.

## Decisions and verification

- I5: retain tool-result continuation tools. The [decision record](../decisions/2026-09-06-i5-tool-result-continuation.md)
  transcribes the user's approved instructions requesting the narrower prohibition. Host factual narration remains tool-free, and response origin
  alone grants no authority. Amend the stale roadmap instead of reversing the approved behavior.
- D-2: retain persistent last-good recovery and distinct saved/applied results, consistent with the
  approved recovery requirements. Repair the corrupt-journal startup dead end; do not erase recovery
  evidence or auto-start a configuration whose rollback could not be established.
- Shared history: preserve published commits. New knowledge behavior/tests receive an explicit
  knowledge commit; do not rebase the earlier `fix(ci)` commit.
- Release: candidate artifact construction is separate from publication. Keep main/publication
  acceptance enforced; do not invent a hotfix bypass of mandatory acceptance.
- R-G: keep executable in-test delivery scenarios and needed test hooks unless a concrete unused
  hook is found. Moving identical data to JSON alone does not improve behavioral coverage.

## Results

| Review item | Finding and resolution | Regression evidence |
| --- | --- | --- |
| R-F | `ProjectStore.open` replays only during live startup. Desktop maintenance can also request replay during open/refresh, but mutations now require a temporary owner lock inside the tracked transaction. Initial transaction contention is degraded/busy, not corrupt; previously observed pending/unsafe health is retained until successful recovery. | Live-owner prepared/committed journals remain byte-identical until owner exit; real contended maintenance open survives; busy observations cannot clear known hazards; malformed open remains unavailable. Removing either ownership or hazard retention fails the corresponding regression. |
| I4 | Confirmed by replay after bounded-ledger eviction and by same-revision retry. Comparing the current revision would not fix either case. Each requested response now carries an echoed per-attempt `request_id`. | Old starts/terminals cannot release new requests; pre-start audio fences settle; quarantined responses cannot dispatch tools or disarm another request. Real cascaded wrapper propagation is covered; removing identity checks makes both replay regressions fail. |
| I5 | Retain the user's approved tool-result continuation behavior; roadmap §3.5 now records the superseding decision. | Existing narration/continuation authorization regressions remain intact; no oracle fixture relaxation in this follow-up. |
| HTTP rejection | Basic status tests already existed. Preserve the published production change and add a separately named knowledge commit for the missing partial-upload contract. | Unfinished requests receive complete 401/403/405/413/503 responses with close semantics and no adapter dispatch; drip timeout must receive 408, not merely a socket error. |
| K-3 | Confirmed timeout propagation issue; additionally, the previous 2-second close budget exceeded assembly's 1-second budget. Close now has a 500 ms best-effort grace period, then requests worker termination without treating the timeout itself as assembly failure. | Never-settling termination, actual forced close/reopen, native SQLite contention and real assembly cleanup. An external lock can still yield stable STORE_WRITE_FAILED until released; close does not promise immediate worker exit. |
| D-2 | Keep durable last-good recovery and separate saved/applied state. Corrupt recovery now opens settings with repair guidance and preserves all bytes; automatic backend startup is blocked. | Malformed JSON/version, repair and retry, no premature rescan restart, and a workspace-clear dialog interleaving that otherwise bypassed recovery. Removed unreachable saved=true failure UI branches. |
| K-2 | Keep additive legacy digest migration and documented ordinal identity; no evidence supports discarding preserved data or rewriting identity in this repair. | Spec 04 maps all 15 checklist rows to static, deterministic or historical live evidence; these checks do not mark human acceptance complete. |
| R-E | Removed unproduced `error` frame and its dead renderer case. All 15 remaining wire frame types now have actual producer coverage; byte drift runs in `npm run check`. | Authenticated loopback fixture asserts the exact emitted type set, not a hand-selected schema subset; generated renderer bytes must match runtime. |
| R-G | Retain executable inline delivery scenarios and necessary test hooks. A JSON move and numerical hook-removal target are not behavioral fixes. | Existing delivery scenario tests remain executable; no broader test API refactor added. |
| Candidate/release workflows | Windows candidate now runs `test:runtime:win`. Tag builds can produce candidate artifacts with pending human rows; main integration and publication still require the ledger. | Workflow contract regressions; no main merge, publication or hotfix bypass. |
| Wake/package | Added missing blocked-hide, tray/hotkey routing and old-helper rejection checks; packaging now checks exact dependency membership and equality of both ASAR declarations. | Compressed archive extraction fixtures, malformed/truncated inputs, exact desktop dependency sets and real archive rebuilding; no new configuration framework. |
| Documentation | Fixed wake settings/non-goals, Linux claims, bilingual list layout, smoke placement, inbound handoff links, STATUS sections, review log, executor regex and stale tracked paths. | Documentation contract and local-link checks; historical and current evidence stay separate. |

Focused verification before the full serial run: requested-response/protocol/provider tests 123/123;
knowledge tests 65/65 on Node 24.8.0 and 22.23.2, assembly cleanup 6/6; settings/workspace/workflow
tests 139/139; wake/package/native checks 106 passed. Both installed Node versions have FTS5;
forced lexical fallback tests cover degradation independently. Identity and cleanup regressions
were also checked against intentionally removed fixes.

Final serial gate counts and the actual pushed CI SHA are recorded in
[IMPLEMENTATION](../specs/v0.2.0/IMPLEMENTATION.md). Earlier Alibaba Windows evidence belongs to
`afc82dd`; it does not certify these later changes. Human voice, long standby and installed Windows
acceptance remain pending for main.
