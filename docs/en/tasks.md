# Tasks

Tasks is where delegated work lives: each Task carries a goal and acceptance criteria, and Nova checks the evidence before it calls one done — never just because a step ran.

## Lifecycle

A Task moves through queued, running, verifying and waiting on its way to completed, or cancelled at any point. Nova drives this loop on its own while it holds control: it dispatches work, evaluates what came back against the acceptance criteria, and either reconciles the goal, corrects the instruction, waits, or completes the Task with the evidence attached. A Task sits in a waiting state when Nova cannot yet confirm what happened — not simply because nothing is happening.

A Task can contain more than one round of execution; each is shown as "Run #1", "Run #2" and so on. Executor work that was never delegated through a Task — nothing owns it — is listed on its own, separately.

Each item on the Tasks page also carries a short next-step summary: needing you, you being in control, nothing to do, or Nova working on it.

## Taking over

| Action | What happens |
|---|---|
| Take over task | You now message the executor directly; Nova pauses automatic correction |
| Take over and reply | Same, and sends your message immediately |
| Return to Nova | Hands control back so Nova resumes deciding and correcting |
| Stop task | Cancels the task. Cancellation is final: the task cannot be continued afterwards, so redoing the work means creating a new task |
| Continue task | Hands a waiting task back to Nova to drive, resetting its correction count; it has no effect on a completed or cancelled task |
| Checked: it ran / Checked: it did not run | Appears only when Nova cannot confirm whether a previous step actually ran, and needs you to say so |
| Mark Todo done | Appears only when the Task is complete but its linked Todo has since changed elsewhere, to resolve the conflict by hand |

Task details shows who is in control right now — you, Nova, or another connected client — along with the acceptance criteria, any pending approvals ("Task approvals", with Allow once / Decline), and a public activity log of updates about the Task shared outside the Workbench.

## Where Nova proposes to run it

Before starting new work, Nova can propose an execution place: a new Workspace, or an existing Workspace with a new or continuing Session (see [Glossary](glossary.md) for what a Workspace and a Session are). Confirm it inline with "Run here", or point it somewhere else with "Run here instead".

## Delegating and following up

From a Todo, "Send to executor" turns it into a Task. "View task and results" opens the Task's detail view; asking about progress drops a prompt into the conversation draft referencing the Task by name, so you can just send it.

## Limits

Nova keeps roughly the last 200 finished Tasks in the Workbench; older ones are pruned automatically as new ones complete. Pruning only removes the Workbench record — it does not touch anything an executor already produced in your Workspace.

[Workbench](workbench.md) · [Sources and connectors](sources-and-connectors.md) · [Glossary](glossary.md) · [Executors](executors/overview.md)
