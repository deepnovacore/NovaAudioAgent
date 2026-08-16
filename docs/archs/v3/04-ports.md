# 4. Ports

Ports separate the runtime from domain integrations. An executor manifest declares a name, channel
policy, and operations. Each operation specifies JSON parameters, trust, deadline, side-effect
classification, and optional verification behavior.

Runtime binds a validated request into a delegate and passes a dispatch context to the adapter. The
adapter returns a typed `Handoff`; it cannot mutate structured memory or emit speech. Progress uses
the same delegate identity and is rejected when identity, operation, or lifecycle state does not
match.

This contract keeps provider and device code replaceable without weakening the spine.
