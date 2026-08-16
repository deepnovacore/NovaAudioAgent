# 7. Public Decision Record

| Decision | Chosen boundary | Rejected alternative |
|---|---|---|
| Continuous runtime | Events plus asynchronous slots | A nested turn loop that waits for tools |
| Canonical state | Memory receives events before projection | Provider history as the source of truth |
| Proactive attention | Surrogate evaluates ambient suggestions only | A second general-purpose conversational agent |
| Speaking ownership | One Floor-controlled FastBrain path | Direct executor or transport speech |
| Capability extension | Manifest and adapter ports | Capability branches inside Runtime |
| Context | Bounded ContextView | Passing unrestricted memory to models |
| Trust | External text and images remain evidence | Treating retrieved content as instructions |
| Realtime recovery | Bounded host facts with identity fencing | Replaying arbitrary provider state |
| Desktop security | Sandboxed renderer and narrow preload API | Renderer access to Node.js or raw process control |

These decisions are architectural constraints, not implementation preferences. A future change may
replace one only when it documents the invariant being traded away and provides verification for the
new boundary.
