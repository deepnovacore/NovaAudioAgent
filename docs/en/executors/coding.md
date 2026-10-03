# Coding

Coding delegates project work to a coding agent. Codex is the default; OpenCode, CodeBuddy, Pi and DeepSeek Harness are available for new sessions over ACP. Install the agent you choose and sign in on the host computer first.

## From request to result

1. Describe the goal, such as “Add a search page to this project.”
2. Nova asks for missing information. You confirm creating or switching a project.
3. The agent works in the approved directory. Nova shows progress and requests additional permissions separately.
4. Results return to the conversation. While work is running, you can add constraints, ask for progress or cancel.

## Boundaries

- The host owns project and session identity; it does not infer them from executor prose.
- Cancellation does not delete project files or session records.
- Executors do not speak directly or approve operations for you.
- Codex runs through `codex app-server`. The other agents run through the Agent Client Protocol (ACP); see [Choosing an agent](#choosing-an-agent).
- Delegated coding work is tracked as a durable Task on the [Tasks](../tasks.md) page, with acceptance criteria, verified completion, and the ability to take over or hand control back to Nova.

See [getting started](../getting-started.md) for setup and the [executor contract](../archs/05-executors.md) for developer details.

## Progress and approvals

The eager proactivity setting asks for concise updates at meaningful phase changes; it does not guarantee a fixed reporting interval. You can continue talking or add constraints while work runs.

An approval normally applies once. If the executor supports session approval, you can request that scope for the current permission request. It is limited to what that executor supports and is not permanent authorization. Unsupported scope requests remain pending; Nova does not silently turn them into a one-time approval. Project confirmations do not accept session scope.

## Choosing an agent

Pick the default agent for new sessions under Settings → Capabilities → Coding, or set `CODING_BACKEND` (`codex`, `opencode`, `codebuddy`, `pi` or `deepseek`). The choice takes effect without restarting voice. Each session keeps the agent it was created with: changing the default never moves running work or existing sessions, and a resumed session always returns to its own agent.

Install the agent, then sign in with its own tools. Nova finds `opencode`, `codebuddy`, `pi-acp` or `dsh` on `PATH`, or uses the absolute path you set in Settings or in `OPENCODE_ACP_BIN`, `CODEBUDDY_ACP_BIN`, `PI_ACP_BIN` or `DEEPSEEK_ACP_BIN`. Login and protocol support are checked when a task starts, not at launch, so a missing agent does not stop voice or other agents.

What each agent supports today:

| | Codex | OpenCode | CodeBuddy | Pi | DeepSeek Harness |
| --- | --- | --- | --- | --- | --- |
| Transport | app-server | ACP | ACP | ACP | ACP |
| Resume a session | Yes | When the agent offers it | When the agent offers it | When the agent offers it | When the agent offers it |
| Add requirements while running | Yes | No | No | No | No |
| Cancel | Yes | Yes | Yes | Yes | Yes |
| Per-action approval in Ask mode | Yes | For actions the agent asks about | For actions the agent asks about | No (Ask mode refuses the task) | For actions the agent asks about |
| Ask-mode sandbox (workspace-only files, no network) | Yes | No | No | No | No |
| MCP tools you grant | Yes | Yes | Yes | No (a granted tool refuses the task) | Yes |

Ask mode means something narrower for ACP agents than for Codex. For Codex, Nova itself confines the agent to the workspace without network access and also asks you before each command or file change that needs approval. For an ACP agent, Nova can only answer the permission requests the agent chooses to send. Nova does not sandbox the agent's files or network, and the agent's own permission settings decide which actions it asks about. A rule in the agent's own config that allows an action without asking applies as usual; DeepSeek Harness is launched without a permission option, so it follows its own defaults. When you need Codex's confinement, use Codex, or run the ACP agent in a workspace and account you are willing to let it change.

For an ACP agent, adding requirements mid-task is reported as unsupported. Nova never fakes it by cancelling and starting a new task. If an agent cannot find a session it is asked to resume, the session stays in your list so you can retry after fixing the agent's login or configuration.

MCP tools and the knowledge base are off for ACP agents until you grant them per agent with `exposeTo.backends` on an MCP server, or `modules.knowledge.exposeToBackends`, in the capabilities file. The existing `exposeTo.codex` and `exposeToCodex` grants apply to Codex only. Granted tools reach an ACP agent through a per-task local proxy that lists and runs only the tools you enabled.

