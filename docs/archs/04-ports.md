# 4. Ports

Ports separate the runtime from domain integrations. An executor manifest declares a name, channel
policy, and operations. Each operation specifies JSON parameters, `readonly`, `confirm`, a
`deadline_budget`, optional `verifies` targets, `sensitive_params`, and whether the host waits for a
`sync_result`. Trust is classified on the returned handoff, not on the op spec.

Runtime binds a validated request into a delegate and passes a dispatch context to the adapter. The
adapter returns a typed `ExecutorHandoff`; it cannot mutate structured memory or emit speech.
Progress uses the same delegate identity and is rejected when identity, operation, or lifecycle
state does not match.

This contract keeps provider and device code replaceable without weakening the spine.
