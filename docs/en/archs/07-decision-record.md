# Design constraints

These boundaries keep real-time conversation responsive while background capabilities remain replaceable.

| Area | Constraint |
|---|---|
| Scheduling | Apply events in order; run model calls and executor tasks asynchronously. |
| State | Update runtime memory before generating a response. Provider history is not the source of truth. |
| Speech | Only FrontBrain speaks through Floor. Nova may interrupt its own playback, never the user. |
| Attention | Proactive evaluates background suggestions; it is not another conversational agent. |
| Execution | Extend capabilities through manifests, adapters and controllers, not capability-specific branches in Runtime. |
| Authorization | The host owns approvals and project identity. Model output cannot grant permissions. |
| Context and evidence | Give models bounded context. Retrieved text and images remain untrusted evidence. |
| Isolation | Keep document knowledge, personal memory and live task state separate. The desktop renderer uses a sandbox and a narrow preload API. |

New capabilities must respect these boundaries. General workflow languages, unrestricted memory retrieval, cross-executor transactions and simultaneous speaking roles are outside the current scope. Devices and executors never expand their own permissions.
