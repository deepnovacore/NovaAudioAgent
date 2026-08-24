# Task 1 report — realtime project tool contract

## Delivered

- Project manifests now expose `project`, `confirm_project_action`, `steer`, and `status`; project-mode `run` is rejected while base/live `RUN` is unchanged.
- Added the six named project actions, exact action-specific key validation, a 600-second project budget, and the synchronous confirmation schema (`proposal_id`, `confirmed`).
- Mirrored the contract and request normalizer in Python; project starts and confirmed follow-ups now dispatch through `project` / `start_session`.
- Kept `PROJECT_RUN = PROJECT` only as a Python import compatibility alias; it is not present in the manifest or provider schema.

## TDD evidence

### Initial project-contract RED

Command:

```sh
npm run build --workspace @nova-audio-agent/runtime && node --test runtime/dist/test/codex-contract.test.js
```

Result: build succeeded and 3/15 tests failed as expected: the manifest still exposed `run`, lacked `confirm_project_action`, and did not accept the new action set.

### Ports scope expansion

The mandated `readonly: false, sync_result: true` confirmation operation exposed an existing cross-language ports restriction (`sync_result requires readonly`). The task owner authorized the minimal scope expansion to both ports schemas and their direct tests. Tests were changed first. Restoring the old restriction produced RED evidence:

```sh
npm run build --workspace @nova-audio-agent/runtime && node --test runtime/dist/test/runtime.test.js
uv run pytest tests/test_ports.py::test_op_spec_sync_result_is_explicit_for_readonly_and_write_operations -q
```

Result: TypeScript failed the new writable-sync assertion with `sync_result requires readonly`; Python import failed at the same old invariant while constructing `CONFIRM_PROJECT_ACTION`. The coupling was then removed in both ports implementations, with all other ports validation retained.

### Final GREEN

```sh
npm run build --workspace @nova-audio-agent/runtime && node --test runtime/dist/test/codex-contract.test.js && node --test runtime/dist/test/runtime.test.js && uv run pytest tests/test_codex_project_live.py tests/test_ports.py -q
```

Result: build succeeded; TypeScript contract tests 15/15 passed; runtime tests 46/46 passed; Python tests 48/48 passed.

`git diff --check` passed before commit.
