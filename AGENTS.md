# Public and internal development

- `v0.2.0dev` and release branches are public. Company pilots belong only on `internal`; never merge or cherry-pick pilot integrations into a public branch.
- Never push `internal` or private recovery refs/bundles to the public remote. Public fixes may flow into `internal`, not the reverse.
- Public clients may expose a generic, deployment-configured Feishu login module. Do not embed organization domains, employee data, tenant identifiers, internal endpoints, deployment files, work-record/weekly-report pages, or pilot service integrations.
- Before removing or rewriting history, preserve complete private recovery data and verify it. Audit both the final tree and all history reachable from the public refs before publishing.

## Cursor Cloud specific instructions

- Node.js comes from `~/.nvm` (22.22 or newer). `package.json` pins npm 11.6.0. Root `npm ci` installs the runtime, desktop client, and CLI. The docs site is separate: `npm ci --prefix website`.
- Linux desktop native builds need `CXXFLAGS=-UV8_DEPRECATION_WARNINGS` before `npm run test:desktop` or a desktop `npm run build`. CI sets the same flag in `.github/workflows/ci.yml`. Login shells on this environment export it from `/etc/profile.d/nova-audio-agent.sh`.
- Copy `.env.example` to `.env` before `npm run start:client`. `node runtime/dist/src/cli.js demo all` exercises the deterministic control-plane demos. `node runtime/dist/src/cli.js diagnose --json` stays unsuccessful for `provider.qwen` until `DASHSCOPE_API_KEY` is set.
- On Cloud Agent kernel 6.12, creating a file while its parent directory is open often leaves that directory mtime unchanged. `npm run test:runtime` can fail only `streamed directory scan reports exact cap as complete and excess as partial` for that reason. The rest of the runtime suite passes.
