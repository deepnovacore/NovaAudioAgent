# Design Essence

Nova Audio Agent separates three questions that conventional tool loops often collapse:

1. What work should start?
2. What happened while that work ran?
3. Is the result worth saying now?

The runtime answers the first two structurally. FastBrain can dispatch without waiting, and every
executor result becomes a memory event. Surrogate answers only the third question for ambient
suggestions. Floor remains the single authority that grants a speaking turn.

This produces four practical properties:

- Long work does not freeze the conversation.
- Progress can be stored without interrupting the user.
- Later answers and proactive speech derive from the same memory state — proactivity is
  push-and-pull, not notify-only.
- Executors remain replaceable because domain behavior stays behind manifests and handoffs.

Nova (小诺) is the assistant personality presented to the user. `nova-audio-agent` is the software
and package identity; executor names describe capabilities, not additional personas.

The project deliberately avoids a universal workflow language, a second conversational authority,
or a direct executor-to-speech path. New capability should first prove that it fits the existing
port contract. Add a new core abstraction only when a concrete capability cannot be expressed
without violating an invariant.

See [Architecture](architecture.md), [Glossary](glossary.md), and the
[v3 overview](archs/v3/00-overview.md).
