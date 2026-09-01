# 10. Executor Onboarding

Add an executor in this order:

1. Write the manifest and parameter schemas.
2. Define `readonly`, `confirm`, `deadline_budget`, `verifies`, `sensitive_params`, and
   `sync_result` for every operation. Classify trust on the handoff, not on the op spec.
3. Implement a transport-independent adapter with deterministic doubles.
4. Wire it in `buildAssembly`. Always-on adapters (search, cam, watch, guard) are constructed
   there unconditionally. Configurable adapters also join the `fast_sim` / `slow_sim` / `codex`
   configuration literal.
5. Add invalid-input, timeout, cancellation, sanitization, and registry-adapter contract tests.
6. Add a live smoke only after deterministic lifecycle coverage passes.
7. Document credentials and least-privilege setup in Getting Started.

Do not add an executor by giving the model direct transport access. The adapter must translate the
external protocol into bounded progress and one typed terminal handoff.
