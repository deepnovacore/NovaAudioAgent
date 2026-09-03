# Codex protocol pin

`app-server-schema/0.152.0/` is the unmodified JSON schema emitted by the locally
installed `codex-cli 0.152.0`:

```sh
codex app-server generate-json-schema --experimental --out fixtures/codex/app-server-schema/0.152.0
```

`approval-examples-0.152.0.json` covers launch profiles and approval responses.
`runtime/test/codex-protocol-pin.test.ts` validates these examples against the
snapshot. Transport and broker tests separately exercise binding, advertised
decisions, expiry and cancellation. A schema pass does not replace live
macOS/Windows sandbox and permission tests.
