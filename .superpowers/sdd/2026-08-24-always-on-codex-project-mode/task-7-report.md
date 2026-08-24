# Task 7 report: always-on Codex project mode

## Outcome

- Added provider-connected integration assertions for the exact four public Codex tools, no
  `codex__run`, all six project actions, and the strict host-only confirmation schema.
- Added an assembly-level managed-create E2E: proposal has no mutation; a bound structured
  confirmation creates the managed Workspace, persists the optional Session title/thread, starts
  the exact work order, and rejects false/wrong-ID/non-boolean/replay attempts without side effects.
- Migrated the confirmation oracle and golden fixtures from phrase classification to nine structured
  controller scenarios. Removed the retired TS/Python transcript compatibility methods.
- Updated English/Chinese README and getting-started guidance and added the Workspace handoff guide.
  The docs define Workspace versus Session, always-on behavior, on-demand listing, staged switching
  and resume, strict confirmation, recovery, and all default storage paths.
- Calibrated Node parity to the exact current source: 148 files and 212 occurrences. The zero-match
  `voice-choice.mjs` is inventory-only; three deleted project-confirmation `string_length` entries
  were removed, and the remaining entry points to its real behavior test.

## TDD evidence

- RED: parity reported 147/215 versus source 148/212; stale docs still required the deleted toggle;
  the new connected-schema integration exposed unwanted `origin_ref` on host confirmation; the E2E
  initially exposed an overly aggressive zero-delay poll around descriptor-locked store reads.
- GREEN: focused TypeScript tests pass 41/41; focused Python tests pass 46/46; structured confirmation
  parity passes 9/9; Node parity passes at 148 files/212 occurrences.

## Broad verification

- `npm run typecheck --workspace @nova-audio-agent/runtime`: pass.
- `npm run lint --workspace @nova-audio-agent/runtime`: pass.
- `npm run test:runtime` (outside sandbox for loopback/native tests): 1604 passed.
- `npm run check:env-contract`: pass; `npm run check:node-parity`: pass.
- `uv run ruff check src tests`: pass.
- `uv run pytest -q`: initially 2892 passed with the two pre-declared README Ambient Orb install
  command baseline failures. A targeted RED reproduced both; the authorized minimal bilingual
  section edit added `uv sync --extra vision --dev` before `./scripts/start_ambient_orb.sh`.
  Targeted verification then passed 2/2 and the fresh full suite passed 2894/2894.
- Retired-symbol audit has no matches outside historical design documents. Ordinary non-realtime
  `codex__run` tests and ordinary session transcript processing remain intentionally intact.

The Nova desktop client was not restarted; the integration owner will do that after branch review.

## Review follow-up

- Finding 1: replaced the three direct-controller fail-closed cases with fresh assembly/service
  scenarios. RED was 3/3 because the direct path emitted no realtime tool output. GREEN routes false,
  wrong-ID, and non-boolean arguments through the same provider epoch, response, and reserved user
  item as success; it asserts registry/active state, tool output, commit count, worker construction,
  and work orders. Wrong-ID/non-boolean keep the proposal usable for a valid confirmation; replay is
  single-use. Focused E2E passes 7/7.
- Finding 2: English and Chinese README/getting-started guidance plus the handoff guide now say each
  realtime turn receives only the active Workspace/Session, historical candidates are on demand,
  and always-on applies only to the realtime project surface. Ordinary non-realtime `codex__run`
  retains its existing semantics and is absent from the realtime provider surface.
- Finding 3 disposition: retained the scoped Ambient Orb wrapper change because the committed
  baseline test requires `./scripts/start_ambient_orb.sh`; no other Orb changes were added.
- Finding 4 disposition: no client restart was performed. The integration owner will restart only
  Nova after full-branch review and integration into the actual checkout.
