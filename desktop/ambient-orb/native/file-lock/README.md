# Codex project descriptor-lock contract (Task 6D)

Task 6D defines the audited boundary but intentionally does not claim a packaged native helper.
Until Task 8 builds, signs, loads, and inspects that helper for every Electron architecture,
production passes `unsupportedNativeFileLocks` and project-store construction fails closed with
`state_lock_failed`.

The eventual Node-API binding has one operation. It accepts an already-open numeric descriptor (or
the Windows handle retained behind that descriptor), never a path, PID, process name, timeout,
command, renderer value, or stale-lock token. TypeScript opens the fixed lock filename with
no-follow semantics and validates regular-file type, owner, and owner-only permissions before the
call. The native result is only:

- `acquired`, retaining the kernel lock until the returned single host release is joined;
- `busy`, for immediate contention;
- `unsupported`, when the platform/artifact cannot prove the contract; or
- `failed`, for every other native error.

POSIX must use nonblocking `flock(fd, LOCK_EX | LOCK_NB)` and descriptor/open-file-description
lifetime. Windows must use exclusive immediate-failure `LockFileEx`, retain the handle, and pair it
with an owner-only ACL check supplied by the host. Owner death must release the kernel lock. A PID
file, stale-time heuristic, `mkdir` lock, polling path lock, or automatic downgrade is forbidden.

Task 8 owns the C/C++ source, Node-API ABI build, macOS signing, Windows ACL proof, Electron
architecture matrix, crash-process tests, package inspection, and clean-machine evidence. This
directory containing only this contract is therefore evidence of a deliberate fail-closed gap, not
evidence that native locking or production Codex projects are available.
