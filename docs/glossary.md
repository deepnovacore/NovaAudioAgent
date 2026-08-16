# Glossary and Invariants

| Term | Meaning |
|---|---|
| FastBrain | The user-facing reasoning path that can speak and dispatch work |
| FrontBrain | The realtime provider model filling the FastBrain role on the voice path |
| Surrogate | A bounded attention policy for unsolicited suggestions; it selects pooled entries and never generates words |
| Runtime spine | The event loop that applies state and coordinates work |
| Memory | Canonical per-channel observations and structured user state |
| Channel | One append-only observation stream per capability: `conversation`, `search`, `cam`, `watch`, `guard`, plus one per active executor |
| ContextView | A bounded snapshot compiled for a model call |
| Floor | Speaking-path arbitration with three verdicts: `allow`, `preempt`, `defer` |
| Priority | Urgency bound to the triggering event, never chosen by the model: user 100, guard 90, active executors 50, ambient observations 40 |
| Preempt | Floor verdict that outranks the current utterance; real audio cancellation exists only on the realtime path |
| Defer | Floor verdict that sends the utterance to the suggestion pool instead of dropping it |
| Executor | A manifest-declared capability behind the port contract |
| Delegate | One identity-bound, deadline-bounded unit of dispatched work |
| Progress | A non-terminal executor event bound to its delegate |
| Observation | A non-terminal fact emitted by an active delegate outside the progress cadence (for example a monitoring hit) |
| Handoff | A typed terminal executor result returned to Runtime |
| Suggestion | A stored candidate that may or may not be spoken |
| Suggestion pool | The suggestion lifecycle: `pending → fired → cooldown + re-arm → pending`, plus `withdrawn` and lazy expiry; re-arming requires both an elapsed cooldown and new evidence on the cited channel |
| Steering | Appending a new instruction to an in-flight Codex turn (`codex.steer` over the app-server transport) without terminating or restarting it |
| App-server | The native `codex app-server` JSON-RPC process driven by the live Codex backend (`turn/start`, `turn/steer`) |
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
13. Speaking priority is bound to the triggering event; a model cannot escalate its own priority.
