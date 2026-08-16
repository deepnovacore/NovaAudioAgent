# 3. Context View

Models do not receive unrestricted memory. `ContextView` compiles the smallest useful snapshot for
one call: recent conversation, relevant channel evidence, structured state, and active delegates.

Bounding happens before serialization. Each channel has a policy, untrusted evidence remains marked,
and active-work summaries are tied to delegate identity. A read-only recall operation can retrieve
older bounded evidence when the user explicitly asks for it.

This boundary controls cost and prompt size while keeping the memory source of truth independent of
any provider session.
