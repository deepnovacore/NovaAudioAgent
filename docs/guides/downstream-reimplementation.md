# Downstream Reimplementation Guide

Use this guide when reusing the architecture without copying project-specific integrations.

1. Start with the event types, queue, slots, delegates, and append-only memory.
2. Implement one deterministic executor behind `ExecutorManifest` and `ExecutorAdapter`.
3. Bind every dispatch to a deadline and identity before starting external work.
4. Compile a bounded ContextView rather than passing raw state to the model.
5. Give exactly one component authority to speak; route ambient suggestions through a separate
   attention policy.
6. Add provider transports only after the deterministic lifecycle is covered by tests.

For each new executor, define the operation schema, trust level, deadline, verification behavior,
and cancellation semantics. Keep credentials and transport errors inside the adapter. Return a
typed handoff and let Runtime own memory and delivery.

Avoid adding a global workflow abstraction or capability-specific branches to the spine. If a new
integration needs special safety behavior, keep that behavior local to its adapter unless two real
integrations demonstrate the same missing primitive.

The module map in [Architecture](../architecture.md) and the
[executor volume](../archs/v3/05-executors.md) describe the corresponding implementation seams.
