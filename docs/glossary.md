# Glossary and Invariants

| Term | Meaning |
|---|---|
| FastBrain | The user-facing reasoning path that can speak and dispatch work |
| Surrogate | A bounded attention policy for unsolicited suggestions |
| Runtime spine | The event loop that applies state and coordinates work |
| Memory | Canonical per-channel observations and structured user state |
| ContextView | A bounded snapshot compiled for a model call |
| Floor | Exclusive ownership of the speaking path |
| Executor | A manifest-declared capability behind the port contract |
| Delegate | One identity-bound, deadline-bounded unit of dispatched work |
| Handoff | A typed executor result returned to Runtime |
| Suggestion | A stored candidate that may or may not be spoken |
| Wake reason | Causal metadata describing why a model slot should run |

## Invariants

1. Runtime does not await executor completion in the event-loop body.
2. Executors never speak directly to the user.
3. Every accepted result is written to memory before it affects conversation.
4. Only FastBrain may update structured intent, goal, or authorization.
5. A model sees a bounded ContextView, never unrestricted memory.
6. Delegate identity and operation must match progress and terminal events.
7. Terminal completion is accepted at most once.
8. User-awaited work does not depend on Surrogate for delivery.
9. Ambient suggestions cannot bypass Surrogate and Floor.
10. External text and images are treated as evidence, not instructions.
11. Only configured manifests become model-facing tools.
12. Secret values are not included in logs or configuration errors.
