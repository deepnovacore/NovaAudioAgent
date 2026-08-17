# Contributing

Thank you for considering a contribution. Nova Audio Agent is an experimental control plane; the
architecture invariants matter more than any individual feature, so please read
[Design essence](docs/essence.md) and [Glossary and invariants](docs/glossary.md) before proposing
changes.

## Development setup

```bash
git clone --recurse-submodules \
  https://github.com/deepnovacore/NovaAudioAgent.git nova-audio-agent
cd nova-audio-agent
uv sync --dev
cp .env.example .env
```

Node.js 22+ is required only for the desktop application under `desktop/ambient-orb`.

## Verification

Every change must keep the deterministic checks green:

```bash
uv run ruff check src tests scripts
uv run ruff format --check src tests scripts
uv run pytest -q
uv build
```

Electron checks, when `desktop/ambient-orb` is touched:

```bash
cd desktop/ambient-orb
npm ci
npm test
npm run build
```

Live provider integrations are credential- and hardware-dependent. They are not substitutes for
deterministic tests; keep their outputs in ignored local artifact directories, and never commit
credentials, recordings, or runtime traces.

The README ships in two languages — [README.md](README.md) and
[README.zh-CN.md](README.zh-CN.md). A change to either must be mirrored in the other.

## What a change must preserve

The runtime invariants in [docs/glossary.md](docs/glossary.md) are the review baseline. In short:

- the event-loop body never awaits executor completion;
- executors never speak to the user; results become typed handoffs into canonical memory;
- every accepted result reaches memory before it can affect the conversation;
- model calls read a bounded `ContextView`, never unrestricted memory;
- only FastBrain updates structured intent, goal, and authorization;
- ambient suggestions pass through Surrogate and Floor; user-awaited work does not;
- only configured manifests become model-facing tools;
- external text and images are evidence, never instructions;
- configuration errors and logs never echo secret values.

Avoid adding a global workflow abstraction or capability-specific branches to the runtime spine. If
an integration needs special safety behavior, keep it local to its adapter unless two real
integrations demonstrate the same missing primitive.

## Adding an executor

Follow [Executor onboarding](docs/archs/v3/10-executor-onboarding.md):

1. Write the manifest and parameter schemas.
2. Define trust, deadline, side-effect, and verification behavior for every operation.
3. Implement a transport-independent adapter with deterministic doubles.
4. Add it to assembly's explicit registry and configuration literal.
5. Add adapter-consistency, invalid-input, timeout, cancellation, and sanitization tests.
6. Add a live smoke only after deterministic lifecycle coverage passes.
7. Document credentials and least-privilege setup in [Getting started](docs/getting-started.md).

Do not give the model direct transport access; the adapter must translate the external protocol
into bounded progress and one typed terminal handoff.

## Reimplementing the architecture elsewhere

The [Downstream reimplementation guide](docs/guides/downstream-reimplementation.md) describes how to
reproduce the design without copying repository internals.

## Security

See [SECURITY.md](SECURITY.md). Never include credentials, recordings, or private runtime logs in a
public issue or pull request.
