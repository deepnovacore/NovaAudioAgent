# When should a voice agent speak?

A voice assistant that runs background tasks needs to decide more than what to say. It must also decide whether an update deserves the user's attention, and whether now is a suitable moment.

## Separate work from conversation

Long-running tasks should not hold up the foreground conversation. Executors report progress and results to the runtime; they do not speak directly. The user can ask another question, add a constraint or cancel while work continues.

## An event is not automatically an interruption

A completed step, a camera observation and a request for permission have different value. Routine activity can stay in the background. A meaningful result or a decision that needs the user may deserve a response.

Nova separates background suggestions from user-awaited results. Surrogate evaluates whether a background suggestion is worth surfacing. Work the user is waiting for does not depend on that selection step to deliver its result.

## Keep one speaking path

Floor coordinates speech. If the user is talking, Nova waits. A higher-priority response may interrupt Nova's own playback, but an executor cannot bypass this control and start speaking by itself.

This separation also keeps priorities under host control: an external tool cannot make itself urgent by putting instructions in its output.

## Preserve control as capabilities grow

Documents, personal memory and camera observations can help Nova answer a question or propose a follow-up. They are evidence, not authorization. Actions still pass through the host's permission and project-confirmation rules.

New models and executors can change how work is performed. The useful boundary remains the same: keep conversation responsive, report information selectively, and leave consequential decisions with the user.

See the [runtime overview](../archs/00-overview.md), [context view](../archs/03-context-view.md) and [design constraints](../archs/07-decision-record.md).
