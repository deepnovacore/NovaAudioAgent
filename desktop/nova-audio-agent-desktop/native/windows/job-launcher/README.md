# Codex Windows Job guardian

`windows_job_guardian.c` implements the repository-owned helper. Production construction remains
fail-closed until the runtime resolves the packaged, manifest-verified helper; Node must never fall
back to `taskkill`, a shell wrapper, or leader-only cleanup.

The helper must resolve the already allowlisted native Codex executable and create it suspended
with an explicit inheritable-handle list. Before `ResumeThread`, it creates a Job Object, applies
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, and assigns the suspended target to that Job. Only then may it
write the bounded control frame `{"type":"ready","version":1,"targetPid":N}`. It retains the Job
until `ACTIVE_PROCESS_ZERO`, then emits
`{"type":"exit","version":1,"leaderExitCode":N,"treeEmpty":true}`.

The Node owner supplies one dedicated duplex liveness/control pipe as inherited fd 3. Standard
fds 0/1/2 are forwarded only to the target. EOF on fd 3 is owner death and must close or terminate
the Job. The fixed `{"type":"force","version":1}` command force-terminates the Job. All control
messages are UTF-8 JSONL, strict objects, and at most 4 KiB per frame. They never contain argv, cwd,
environment, work order, credentials, protocol data, stderr, or exception text.

The source and Windows-only tests cover assignment-before-resume, leader-first exit, grandchild
cleanup, abrupt owner EOF, the explicit inheritable-handle list, output EOF, and forced close.
Required Windows CI, signed PE inspection, NSIS staging, and clean-machine evidence remain release
gates; source tests on another host are not substitutes.
