# Security Policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Instead, use
[GitHub private vulnerability reporting](https://github.com/deepnovacore/NovaAudioAgent/security/advisories/new)
for this repository. If that channel is unavailable, open an issue that only asks a maintainer to
get in touch — without any technical detail — and we will move the exchange to a private channel.

When reporting, never include:

- credentials, API keys, or tokens (rotate anything you suspect leaked);
- personal recordings, camera frames, or other local media;
- private runtime traces, telemetry, or workspace contents.

A minimal description of the affected component and the conditions to reproduce is enough. We will
acknowledge reports as quickly as we can; this is an experimental project maintained on a
best-effort basis.

## Scope notes

- The runtime treats external search results and visual content as evidence, never instructions;
  reports about prompt-injection boundaries are in scope and welcome.
- Configuration errors must not echo secret values; any counterexample is a bug.
- Codex workspaces, Home Assistant endpoints, and AutoGLM endpoints are validated before use;
  reports about bypasses of those validations are in scope.
- Live provider integrations (Qwen realtime, Tavily, Codex, AutoGLM) run with the credentials you
  configure locally; secure those credentials as you would for any other tool.
