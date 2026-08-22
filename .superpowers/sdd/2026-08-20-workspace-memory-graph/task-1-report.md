# Task 1 report — sensitive-discovery and sensitive-content gates

## Delivered

- Added `SensitivePathPolicy`: absolute-path-only, deny-first handling for `.env*`, credential/key/token names, private-key files, SSH/GPG directories, and caller-configured denied roots. Denied inputs return only `false` / `null`; no label is formed.
- Added `SensitiveContentPolicy`: field-local redaction for provider keys, authorization/cookie headers, password/secret/token assignments (including `密码`), bearer/JWT values, and credential-bearing URLs. It emits `[redacted]` per span and rejects fields containing no meaningful content after redaction.
- Added 13 node:test cases covering sensitive discovery, non-sensitive paths, multiple field spans, URL query/userinfo credentials, cookies, clean SHA/text, and rejection-only content.

## TDD evidence

### RED

Command:

```sh
npm run build --workspace @nova-audio-agent/runtime && node --test runtime/dist/test/workspace-graph-sensitivity.test.js
```

Output before production code: TypeScript failed with `TS2307: Cannot find module '../src/workspace-graph/sensitivity.js'`.

Subsequent boundary RED runs used the same command. They failed as intended when:

- Cookie header handling returned `[redacted]` without retaining the safe `Cookie:` header label.
- A bare `Cookie:` label was incorrectly considered meaningful after its value was redacted.
- A URL query parameter named `accessToken` was only partially redacted rather than treating the complete private URL as one sensitive span.

### GREEN

Command:

```sh
npm run build --workspace @nova-audio-agent/runtime && node --test runtime/dist/test/workspace-graph-sensitivity.test.js && npm run lint --workspace @nova-audio-agent/runtime
```

Output: build succeeded; all 13 sensitivity tests passed (`pass 13`, `fail 0`); ESLint completed with no findings.

## Files

- `runtime/src/workspace-graph/sensitivity.ts`
- `runtime/test/workspace-graph-sensitivity.test.ts`

## Self-review

- The path gate checks raw components before it normalizes a display label, so a denied component cannot be surfaced through `redactLabel`.
- Denied-path tests use safe custom assertion messages rather than printing a returned label; production policy methods neither throw nor log path values.
- Content matching proceeds in a deliberate order: private URLs first, then structured headers/assignments, then standalone token shapes. Each match count is field-local and a rejected field has no value property.
- The clean-field case includes an ordinary Git SHA and a long English sentence to guard against broad high-entropy matching.
- No persistence, graph integration, or untyped persisted-state path was added.

## Concerns

- The full runtime suite was started after linting but this execution environment stops a single command after about 30 seconds while unrelated long-running integration tests are still active. The required focused test/build command and runtime lint both completed successfully. No task-local failures were observed.
