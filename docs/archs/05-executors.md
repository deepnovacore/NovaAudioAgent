# 5. Executors

Executors are the asynchronous work layer. A configured manifest may use any unique executor name;
assembly routes it by declared roles and does not expose a fixed executor enum.
The manifest describes operations, schemas, policy, and trust. The separate `AgentController`
registry describes model-facing controllers and their owned hidden channels.

The `coding` role is optional. If no manifest declares it, intake and `dispatch`/`cancel` are not
compiled, while direct read-only tools remain available. Disabling that role is a valid assembly,
not an `AssemblyError`.

## Codex

The Codex executor uses the same role-routed dispatch/cancel boundary for deterministic and live
app-server backends. The live backend may expose `codex.steer` for same-turn constraints and uses
the host approval protocol for effectful actions. Workspace and Session identity are host-owned and
are never inferred from executor prose. Codex's projection is not subject to the realtime FrontBrain
tool budget.

## Direct MCP and Vision

Search remains a stable `SearchAdapter` contract; MCP is only one transport behind it. The built-in
Camera MCP is the explicit exception to the old “built-ins are never MCP” non-goal and exposes the
direct `mcp__nova_camera__snapshot` operation. External MCP tools are user-selected context cost and
never become agent or intake tools. The Vision controller owns hidden `watch` and `guard` channels;
the model may dispatch/cancel only the `vision` controller and cannot dispatch those hidden channels.

All direct operations are projected by consumer-specific allowlists. They do not authorize a task
or change the speaking floor by themselves.

## Adapter responsibilities

Adapter-local responsibilities include:

- credential and endpoint validation;
- transport timeouts and cancellation;
- request normalization;
- output sanitization and trust classification;
- effect verification where the integration supports it.

Runtime owns the generic delegate lifecycle. Capability-specific recovery belongs in the adapter,
not in runtime branches.
