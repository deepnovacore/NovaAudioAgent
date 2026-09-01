# 10. Executor Onboarding

Add an executor in this order:

1. Write the manifest and parameter schemas.
2. Define trust, deadline, side-effect, and verification behavior for every operation.
3. Implement a transport-independent adapter with deterministic doubles.
4. Add it to assembly's explicit registry and configuration literal.
5. Add adapter-consistency, invalid-input, timeout, cancellation, and sanitization tests.
6. Add a live smoke only after deterministic lifecycle coverage passes.
7. Document credentials and least-privilege setup in Getting Started.

Do not add an executor by giving the model direct transport access. The adapter must translate the
external protocol into bounded progress and one typed terminal handoff.
