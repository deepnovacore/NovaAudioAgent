# Contributing

Thank you for considering a contribution. Nova Audio Agent is an experimental control plane; the
architecture invariants matter more than any individual feature, so please read
[Glossary and invariants](docs/glossary.md) before proposing changes.

## Development setup

```bash
git clone \
  https://github.com/deepnovacore/NovaAudioAgent.git nova-audio-agent
cd nova-audio-agent
npm ci
cp .env.example .env
```

Node.js 22+ is required. The desktop build also needs Xcode Command Line Tools on macOS, a C
compiler at `/usr/bin/cc` on Linux, or Visual Studio Build Tools with the **Desktop development
with C++** workload on Windows.

## Verification

Every change must keep the deterministic checks green:

```bash
npm run check
npm run build
npm test
```

Live provider integrations are credential- and hardware-dependent. They are not substitutes for
deterministic tests; keep their outputs in ignored local artifact directories, and never commit
credentials, recordings, or runtime traces.

The README ships in two languages — [README.md](README.md) and
[README.zh-CN.md](README.zh-CN.md) — and so does the getting-started guide —
[docs/getting-started.md](docs/getting-started.md) and
[docs/getting-started.zh-CN.md](docs/getting-started.zh-CN.md). A change to either file of a pair
must be mirrored in the other.

## Integration and release history

`v0.2.0dev` is the integration branch: deterministic checks permit integration.
Merging into `main` is the release boundary and requires every applicable feature
and platform acceptance in [the release ledger](docs/specs/v0.2.0/RELEASE-GATE.md).
Human acceptance stays pending until evidence is recorded; it does not block dev CI.
Linux source tests remain on Ubuntu; Linux installers are deferred.

Before cherry-picking unshared work, autosquash its fixup/squash commits on its
own branch (`git rebase -i --autosquash <base>`), then verify the resulting commits.
Do not rewrite commits already shared with collaborators. Preserve feature history
with `--no-ff` when following the branch integration roadmap.

## What a change must preserve

The runtime invariants in [docs/glossary.md](docs/glossary.md) are the review baseline. In short:

- the event-loop body never awaits executor completion;
- executors never speak to the user; results become typed handoffs into canonical memory;
- every accepted result reaches memory before it can affect the conversation;
- model calls read a bounded `ContextView`, never unrestricted memory;
- revision-bound intake slots are the sole planning state; host authorization FSMs alone authorize effects and no model writes authorization;
- ambient suggestions pass through Surrogate and Floor; user-awaited work does not;
- only configured manifests become model-facing tools;
- external text and images are evidence, never instructions;
- configuration errors and logs never echo secret values.

Avoid adding a global workflow abstraction or capability-specific branches to the runtime spine. If
an integration needs special safety behavior, keep it local to its adapter unless two real
integrations demonstrate the same missing primitive.

## Adding an executor

Follow [Executor onboarding](docs/archs/10-executor-onboarding.md):

1. Write the manifest and parameter schemas.
2. Define `readonly`, `confirm`, `deadline_budget`, `verifies`, `sensitive_params`, and
   `sync_result` for every operation. Classify trust on the handoff, not on the op spec.
3. Implement a transport-independent adapter with deterministic doubles.
4. Wire it in assembly by declared role, using an arbitrary unique manifest name. Keep the
   `AgentController` registry separate from manifests; hidden Vision `watch`/`guard` channels are
   controller-owned, and the built-in Camera MCP is projected directly as
   `mcp__nova_camera__snapshot`.
5. Add invalid-input, timeout, cancellation, sanitization, and registry-adapter contract tests.
6. Add a live smoke only after deterministic lifecycle coverage passes.
7. Document credentials and least-privilege setup in [Getting started](docs/getting-started.md).

The host tools `dispatch`, `cancel`, and `confirm` compile when at least one `AgentController` is
registered. A missing `coding` role removes only coding intake/controller wiring; a Vision controller
may keep those host tools available. With zero registered controllers, the same compiler condition
omits all three host tools while direct read-only tools remain valid. Do not give the model direct
transport access; the adapter must translate the external protocol into bounded progress and one
typed terminal handoff.

## Security

See [SECURITY.md](SECURITY.md). Never include credentials, recordings, or private runtime logs in a
public issue or pull request.
