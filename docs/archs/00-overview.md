# Nova Audio Agent v3 Design Series

This series describes the public architecture of Nova Audio Agent v3. Each volume owns one design
boundary and links to the implementation concepts that enforce it.

1. [Runtime spine](01-spine.md)
2. [Memory](02-memory.md)
3. [Context view](03-context-view.md)
4. [Ports](04-ports.md)
5. [Executors](05-executors.md)
6. [Verification](06-verification.md)
7. [Decision record](07-decision-record.md)
8. [Deferred work](08-deferred.md)
9. [Roadmap](09-roadmap.md)
10. [Executor onboarding](10-executor-onboarding.md)
11. [Vision](11-vision.md)

The through-line is simple: background capability is useful only when lifecycle, memory, attention,
and speech ownership remain explicit.

## Reading the citations in code comments

These volumes are the condensed public edition of a longer internal design series ("v3"; v1 and v2
were internal predecessors and were never published). Module docstrings and comments still cite
internal identifiers where they record why a boundary exists:

- `R…` and `D…` are internal decision identifiers (accepted rules and deliberate decisions);
  comments still cite identifiers such as `R105`.
- `Stage A/C/E`, `Phase A`, and `B1…B4` were internal development-stage names and are not current
  code labels.
- Section numbers, quoted wording, and tables attributed to a volume refer to the internal edition,
  which is more detailed than the public file of the same name.

Where those identifiers remain, they are preserved for traceability; the reasoning they point to
survives in the docstrings themselves.
