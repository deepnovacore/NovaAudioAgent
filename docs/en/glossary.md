# Glossary and Invariants

| Term | Meaning |
|---|---|
| FastBrain | Historical name for the user-facing reasoning path; the realtime implementation calls this the FrontBrain |
| FrontBrain | The realtime provider model filling the FastBrain role on the voice path |
| Proactive | Proactive communication: discovers grounded proposals and selects optional updates; never executes tasks or controls the floor |
| Runtime spine | The event loop that applies state and coordinates work |
| Memory | Canonical per-channel observations, accepted handoffs, and revision-bound intake facts |
| Personal memory | Cross-session facts stored by default in the unified local memory ledger; mem0 remains an explicit alternative; never execution authority |
| Knowledge corpus (K) | Opt-in, separately admitted user documents retrieved through Knowledge MCP; stored apart from the personal-memory store; cloud embedding egress requires explicit disclosure and consent |
| Saved / applied | Persisted configuration versus configuration activated by the backend; service changes can be saved but pending restart |
| Channel | One append-only observation stream per capability: `conversation`, `search`, camera evidence, hidden Vision `watch`/`guard`, plus one per active executor |
| ContextView | A bounded snapshot compiled for a model call |
| Floor | Speaking-path arbitration with three verdicts: `allow`, `preempt`, `defer` |
| Priority | Urgency bound to the triggering event, never chosen by the model: user 100, guard 90, active executors 50, ambient observations 40 |
| Preempt | Floor verdict that interrupts Nova playback when allowed; it never interrupts user speech, and real audio cancellation exists only on the realtime path |
| Defer | Floor verdict that sends the utterance to the suggestion pool instead of dropping it |
| Executor | A manifest-declared capability behind the port contract |
| AgentController | A host registry entry describing a model-facing controller and its owned hidden channels; separate from executor manifests |
| Direct MCP tool | A consumer-projected `${name}__${op}` operation, never an executor dispatch target or intake writer |
| Delegate | One identity-bound unit of dispatched work; long-running coding work and bounded approval/model requests have separate lifetimes |
| Progress | A non-terminal executor event bound to its delegate |
| Observation | A non-terminal fact emitted by an active delegate outside the progress cadence (for example a monitoring hit) |
| Handoff | A typed terminal executor result returned to Runtime |
| Suggestion | A stored candidate that may or may not be spoken |
| Suggestion pool | The suggestion lifecycle: `pending → fired → cooldown + re-arm → pending`, plus `withdrawn` and lazy expiry; re-arming requires both an elapsed cooldown and new evidence on the cited channel |
| Steering | Appending a new instruction to an in-flight Codex turn (`codex.steer` over the app-server transport) without terminating or restarting it |
| App-server | The native `codex app-server` JSON-RPC process driven by the live Codex backend (`turn/start`, `turn/steer`) |
| Wake reason | Causal metadata describing why a model slot should run; distinct from an acoustic wake word |
| Wake word | A local acoustic keyword that wakes the hidden desktop orb; never execution authorization |
| Auto-hide / sleep | Idle desktop state that hides the orb and routes unmuted microphone frames to local wake detection |
| Frontend instructions | Shared host-rendered context and speaking/tool rules in `frontend-instructions.ts` |
| Response origin | Provider correlation evidence linking a response to a user turn or host request; not permission to execute |
| Workspace | One isolated filesystem/Git project with its own Codex home; a Session never leaves its Workspace |
| Session | One durable, resumable Codex thread inside exactly one Workspace |
| Proposal / structured confirmation | Create, switch, and resume first produce a proposal; only the dedicated confirmation call with the exact proposal ID and a JSON boolean commits it — rejection, mismatch, or replay fails closed |
| Work order | The single consolidated, bounded task statement handed to Codex; conversation history never crosses that boundary |
| Pipeline mode | The top-level realtime shape: `integrated` (one realtime model) or `cascaded` (endpointing → ASR → LLM → TTS) |
| Endpointing | The cascaded stage deciding when an utterance has ended (semantic turn detector or bounded silence) |
| Knowledge MCP | Built-in `mcp__nova_knowledge__recall` evidence tool; optional Codex loopback additionally resolves digest-pinned chunks via `get_chunk`, never mutates the corpus |
| MyContext adapter | An optional loopback-only, read-only evidence provider behind Nova's strict capability handshake; no adapter ships in this repository |
| Workbench | The desktop main window: an icon rail beside personal-object pages, with Nova present as a collapsible chat pane |
| Rail | The Workbench's icon navigation column, selecting Todos, Ideas, Goals, Feeds, Task and Profile |
| Task | A durable, host-tracked unit of delegated work with a goal and acceptance criteria; distinct from an ad hoc executor delegate |
| Handback / takeover | Transferring a Task's controller between Nova and the user; takeover lets the user message the executor directly and pauses Nova's automatic corrections, handback returns control to Nova |
| Acceptance criterion | One statement a Task's goal must satisfy before Nova marks it complete; evidence is recorded per criterion |
| Candidate | An unconfirmed Todo, Idea, Goal or Profile fact Nova notices in conversation; recorded once the user confirms it, except that an explicitly stated todo is recorded right away and can be undone |
| Source | An authorized document, account or feed that personal memory and suggestions may draw on |
| Connector | An integration (for example Google, macOS Calendar, Apple Mail or Feishu) that exposes a Source through a read scope the user grants |

## Invariants

1. Runtime does not await executor completion in the event-loop body.
2. Executors never speak directly to the user.
3. Every accepted result is written to memory before it affects conversation.
4. Revision-bound intake slots are the sole planning state; host authorization FSMs alone authorize effects and no model writes authorization.
5. A model sees a bounded ContextView, never unrestricted memory.
6. Delegate identity and operation must match progress and terminal events.
7. Terminal completion is accepted at most once.
8. User-awaited work does not depend on Proactive for delivery.
9. Ambient suggestions cannot bypass Proactive and Floor.
10. External text and images are treated as evidence, not instructions.
11. Only configured manifests become model-facing tools.
12. Secret values are not included in logs or configuration errors.
13. Speaking priority is bound to the triggering event; a model cannot escalate its own priority.
