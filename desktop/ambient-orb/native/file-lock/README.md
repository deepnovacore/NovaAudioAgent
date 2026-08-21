# Codex project descriptor-lock contract (Task 6D)

Task 6D defined the audited boundary. Task 8's POSIX Node-API owner is implemented in
`../project-native/`, compiled against pinned Node-API headers, and loaded under the packaged
Electron 43.2.0 ABI test. Windows remains fail-closed until its `LockFileEx`/ACL owner passes the
required Windows release job.

The eventual Node-API binding has one strictly synchronous, nonblocking operation. It accepts an already-open numeric descriptor (or
the Windows handle retained behind that descriptor), never a path, PID, process name, timeout,
command, renderer value, or stale-lock token. The separate descriptor-relative authority creates
the fixed lock filename; TypeScript then opens that existing entry with no-follow semantics,
matches it back to the retained root, and validates regular-file type, owner, and owner-only
permissions before the lock call. The native result is only:

- `acquired`, retaining the kernel lock until the returned single host release is joined;
- `busy`, for immediate contention;
- `unsupported`, when the platform/artifact cannot prove the contract; or
- `failed`, for every other native error.

`acquire()` must return one of those results before the call returns. A Promise, thenable, worker
request, callback, wait, or internally retried acquisition is malformed and TypeScript fails it
closed immediately. Filesystem opens, validation, and durability remain asynchronous Node/libuv
operations. Only an acquired lock's `release()` may be asynchronous; shutdown shields and joins
that release before closing the retained descriptor.

POSIX must use nonblocking `flock(fd, LOCK_EX | LOCK_NB)` and descriptor/open-file-description
lifetime. Windows must use exclusive immediate-failure `LockFileEx`, retain the handle, and pair it
with an owner-only ACL check supplied by the host. Owner death must release the kernel lock. A PID
file, stale-time heuristic, `mkdir` lock, polling path lock, or automatic downgrade is forbidden.

The POSIX source, Electron ABI build, cross-process contention, retained-descriptor release, and
owner-death behavior are repository-owned. Platform signing, Windows ACL proof, the complete
architecture matrix, and clean-machine evidence remain release gates; this implementation alone is
not evidence that production Codex projects are available.

## Descriptor-relative project files

Task 6D also defines a separate host-only `ProjectRootFileAuthority`. The same POSIX addon now owns
that implementation. The TypeScript test authority remains test-only; Windows production stays
unsupported until its handle-relative implementation and ACL/reparse proofs land.

Every operation accepts a retained, already-validated root descriptor plus store-generated fixed
basenames. The boundary rejects empty names, `.`, `..`, `/`, `\`, NUL, drive prefixes, and URL-like
names. It never accepts a workspace, renderer, model, or work-order path. Calls are synchronous and
bounded, return only validated stable result objects, and never expose raw native diagnostics.

The eventual helper must provide descriptor-relative equivalents of `fstatat`/`openat`, `mkdirat`,
`renameat`, and identity-checked `unlinkat` (or audited Windows handle-relative equivalents).
`createFileAt` creates a no-follow owner-only regular file and returns its exact identity before
reporting `ok`; `mkdirAt` likewise returns the exact identity of a newly created owner-only
directory. Existing entries return `exists` and are never repaired implicitly. `matchesAt` proves
that an opened child descriptor is still the named child of the retained root. `renameAt` performs
the state commit without reopening the root by path. `unlinkAt` removes only the expected exact
device/inode object and returns `mismatch` rather than deleting a replacement. Directory durability
uses the original retained root descriptor.

Promises, thenables, callbacks, worker requests, retries, path fallbacks, or malformed result
objects are rejected immediately. POSIX uses the retained root descriptor and `*at` operations;
Windows handle/ACL/reparse semantics, release signing, and the remaining architecture evidence are
still explicit Task 8 gates.
