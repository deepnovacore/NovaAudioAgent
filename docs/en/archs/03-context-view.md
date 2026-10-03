# 3. Context View

Models never receive unrestricted memory. `ContextView` is the bounded call-level projection of
recent conversation, relevant channel evidence, active delegates, suggestions and typed results.
Host authorization and project-confirmation state remain separate host-owned state.
Knowledge results remain untrusted evidence; they do not authorize actions.

## Realtime delivery truth

`RealtimeAssembly.#injectCurrentProjectContext` publishes the current project display name and
session title in `<active_project_context>`, plus current work in `<active_executor_context>`.
The host's atomic project context supplies the workspace identity and display view together.
No project roster or other workspace contents are injected. Content changes advance the revision;
provider reconnection republishes current state.

`workspace_context` is an inject-only host item. It cannot become a host action or user activation,
and a provider may deliver it only through a proven replacement/refresh capability.
Qwen replacement uses an ordered delete-confirm then distinct create-confirm protocol, so the
current item replaces prior context rather than accumulating stale items. The project delivery
barrier prevents executor dispatch from overtaking required context publication; session ownership
and revision checks reject stale deliveries.

See [executors](05-executors.md) for the host confirmation boundary.
