# 10. Executor Onboarding

Add an executor in this order:

1. Write a manifest with a unique arbitrary name and declared role(s) plus parameter schemas. Do not
   add a fixed executor enum.
2. Define `readonly`, `confirm`, `deadline_budget`, `verifies`, `sensitive_params`, and
   `sync_result` for every operation. Classify trust on the handoff, not on the op spec.
3. Implement a transport-independent adapter with deterministic doubles.
4. Wire it in assembly by role. Keep the `AgentController` registry separate from manifests:
   controller descriptors declare model-visible tools and `ownedChannels`; hidden Vision `watch` and
   `guard` are never dispatch targets. Search remains a stable adapter contract, while the built-in
   Camera MCP is projected directly as `mcp__nova_camera__snapshot`.
5. Add invalid-input, timeout, cancellation, sanitization, and registry-adapter contract tests.
6. Add a live smoke only after deterministic lifecycle coverage passes.
7. Document credentials and least-privilege setup in Getting Started.

If no manifest declares the `coding` role, intake and `dispatch`/`cancel` are not compiled; direct
read-only tools remain valid and assembly does not fail. Do not add an executor by giving the model
direct transport access. The adapter must translate the external protocol into bounded progress and
one typed terminal handoff.
