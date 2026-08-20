# Codex Windows Job guardian (required native helper; not yet shipping)

This directory defines the audited contract for the future signed Windows helper. There is no
working launcher in this slice. Production construction therefore fails closed with
`spawn_failed`; Node must never fall back to `taskkill`, a shell wrapper, or leader-only cleanup.

The helper must resolve the already allowlisted native Codex executable and create it suspended
with an explicit inheritable-handle list. Before `ResumeThread`, it creates a Job Object, applies
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, and assigns the suspended target to that Job. Only then may it
write the bounded control frame `{"type":"ready","version":1,"targetPid":N}`. It retains the Job
until `ACTIVE_PROCESS_ZERO`, then emits
`{"type":"exit","version":1,"leaderExitCode":N,"treeEmpty":true}`.

The Node owner supplies a dedicated liveness pipe. EOF on that pipe is owner death and must close or
terminate the Job. The fixed `{"type":"force","version":1}` command force-terminates the Job. All
control messages are UTF-8 JSONL, strict objects, and at most 4 KiB per frame. They never contain
argv, cwd, environment, work order, credentials, protocol data, stderr, or exception text.

Task 8 must add the architecture-specific native source/binary, signature and PE validation,
Electron `extraResources` packaging, and clean-NSIS tests proving assignment-before-resume,
leader-first exit, grandchild cleanup, abrupt Node owner death, no inheritable-handle leaks, output
EOF, and forced close. This README and the TypeScript parser are contract tests only; they are not
evidence that Windows Job Object ownership is implemented.
