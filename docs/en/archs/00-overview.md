# Architecture reference

This series describes the architecture of Nova Audio Agent. Each volume owns one design
boundary and links to the implementation concepts that enforce it.

1. [Runtime spine](01-spine.md)
2. [Memory](02-memory.md)
3. [Context view](03-context-view.md)
4. [Ports](04-ports.md)
5. [Executors](05-executors.md)
6. [Local development](06-verification.md)
7. [Design constraints](07-decision-record.md)
8. [Roadmap](09-roadmap.md)
9. [Executor onboarding](10-executor-onboarding.md)
10. [Vision](11-vision.md)

The through-line is simple: background capability is useful only when lifecycle, memory, attention,
and speech ownership remain explicit.
