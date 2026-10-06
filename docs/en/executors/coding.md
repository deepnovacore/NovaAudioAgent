# Coding

Coding delegates project work to Codex. Install Codex and sign in on the host computer first.

## From request to result

1. Describe the goal, such as “Add a search page to this project.”
2. Nova asks for missing information. You confirm creating or switching a project.
3. Codex works in the approved directory. Nova shows progress and requests additional permissions separately.
4. Results return to the conversation. While work is running, you can add constraints, ask for progress or cancel.

## Boundaries

- The host owns project and session identity; it does not infer them from executor prose.
- Cancellation does not delete project files or session records.
- Executors do not speak directly or approve operations for you.
- The current integration uses `codex app-server`. Planned coding backends are not claims of present compatibility.
- Delegated coding work is tracked as a durable Task on the [Tasks](../tasks.md) page, with acceptance criteria, verified completion, and the ability to take over or hand control back to Nova.

See [getting started](../getting-started.md) for setup and the [executor contract](../archs/05-executors.md) for developer details.

## Progress and approvals

The eager proactivity setting asks for concise updates at meaningful phase changes; it does not guarantee a fixed reporting interval. You can continue talking or add constraints while work runs.

An approval normally applies once. If the executor supports session approval, you can request that scope for the current permission request. It is limited to what that executor supports and is not permanent authorization. Unsupported scope requests remain pending; Nova does not silently turn them into a one-time approval. Project confirmations do not accept session scope.
