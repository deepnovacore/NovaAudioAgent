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

## Security review fix round 1

### RED

Command:

```sh
npm run build --workspace @nova-audio-agent/runtime && node --test runtime/dist/test/workspace-graph-sensitivity.test.js
```

Output: 18 tests ran; 5 failed as intended and safely reproduced the review findings: a `..vault` denied-root descendant was allowed, `accessToken.json` was allowed, Basic/Digest/Proxy authorization values remained visible, `client_secret` URLs were not treated as credential-bearing, and quoted JSON credential keys were clean. Failure messages used only fixed descriptions or result kinds; they did not emit a denied basename or raw secret.

### GREEN

Commands:

```sh
npm run build --workspace @nova-audio-agent/runtime && node --test --test-name-pattern='descendants whose names begin' runtime/dist/test/workspace-graph-sensitivity.test.js
npm run build --workspace @nova-audio-agent/runtime && node --test --test-name-pattern='concatenated credential filenames' runtime/dist/test/workspace-graph-sensitivity.test.js
npm run build --workspace @nova-audio-agent/runtime && node --test --test-name-pattern='complete authorization header values' runtime/dist/test/workspace-graph-sensitivity.test.js
npm run build --workspace @nova-audio-agent/runtime && node --test --test-name-pattern='client secret query credentials' runtime/dist/test/workspace-graph-sensitivity.test.js
npm run build --workspace @nova-audio-agent/runtime && node --test --test-name-pattern='quoted credential keys' runtime/dist/test/workspace-graph-sensitivity.test.js
```

Each isolated regression test passed after its minimal fix. Final verification:

```sh
npm run build --workspace @nova-audio-agent/runtime && node --test runtime/dist/test/workspace-graph-sensitivity.test.js && npm run lint --workspace @nova-audio-agent/runtime && git diff --check
```

Output: build succeeded; all 20 sensitivity tests passed (`pass 20`, `fail 0`); ESLint and `git diff --check` completed without findings.

### Fix review

- Denied-root containment now treats only exact parent traversal segments (`..`, `../`, `..\\`) as outside; ordinary descendants such as `..vault` remain inside the denied root.
- Authorization and Proxy-Authorization are redacted through line end for every scheme. Cookie/Set-Cookie continue to redact through line end, their test now proves that only preceding and next-line safe context is retained, and bare forms of both headers reject after redaction.
- Credential query-name detection normalizes underscore/hyphen variants and includes `client_secret`; filename detection recognizes exact concatenated credential tokens while the `tokenizer.ts` false-positive guard remains allowed.
- Quoted JSON-like assignment keys are handled by the same field-local redaction path. Tests use safe boolean/custom assertions around sensitive spans, preventing future failing output from echoing a secret.

## Security review fix round 2

### RED

Command:

```sh
npm run build --workspace @nova-audio-agent/runtime && node --test runtime/dist/test/workspace-graph-sensitivity.test.js
```

Output: 24 tests ran; 4 failed as intended. A quoted Chinese `"密码"` JSON key remained clean, and empty Cookie, Set-Cookie, Authorization, and Proxy-Authorization headers incorrectly consumed the following safe line. The failures reported only a fixed test description or the safe `clean`/`rejected` result kind.

### GREEN

Commands:

```sh
npm run build --workspace @nova-audio-agent/runtime && node --test --test-name-pattern='quoted Chinese credential keys' runtime/dist/test/workspace-graph-sensitivity.test.js
npm run build --workspace @nova-audio-agent/runtime && node --test --test-name-pattern='safe line after' runtime/dist/test/workspace-graph-sensitivity.test.js
npm run build --workspace @nova-audio-agent/runtime && node --test runtime/dist/test/workspace-graph-sensitivity.test.js && npm run lint --workspace @nova-audio-agent/runtime && git diff --check
```

Output: both isolated regressions passed. Final verification built successfully; all 24 sensitivity tests passed (`pass 24`, `fail 0`); ESLint and `git diff --check` completed without findings.

### Fix review

- The Chinese assignment detector now accepts either bare `密码` or a consistently quoted `"密码"` key and redacts its value without returning the span.
- Authorization, Proxy-Authorization, Cookie, and Set-Cookie now use horizontal whitespace (`[ \t]*`) around their colons. They still redact all same-line header material, while a newline ends the header and leaves the following safe line clean.
