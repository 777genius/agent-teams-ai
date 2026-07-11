# P0.W4.WORKSPACE_GUARD_SPIKE

Status: `characterized`.

Under `phase-00-r3`, this current-host fixture does not admit workspace effects or provider launch.

`workspace_guard_spike.c` opens the registered root as `O_PATH|O_DIRECTORY|O_NOFOLLOW`, checks
dev/inode plus `statx` mount ID and a generation marker, resolves mutation parents/cwd with
`openat2(RESOLVE_BENEATH|RESOLVE_NO_MAGICLINKS|RESOLVE_NO_SYMLINKS|RESOLVE_NO_XDEV)`, binds create to
the opened parent, fsyncs file and directory, and enters exec cwd with `fchdir` before closing all
non-stdio descriptors and calling `execve` with a clean environment.

The marker-owned suite produced zero outside effects for parent and final symlinks, canonical-root
rename/replacement, stale generation and a bind-mounted subdirectory. A fake provider wrote only from
the descriptor-entered cwd. Raw Node `realpathSync` followed by delayed pathname write was the required
failing control: after root replacement it wrote one marker-owned byte effect outside the original
workspace. Raw Git `worktree add` ran a fixture `post-checkout` hook; guarded Git with the fixed
no-hook/no-helper policy did not. Explicit inherited lease/control canaries were absent from fake
provider, Git-helper and generic-helper `/proc/<pid>/fd` evidence.

The spike's exec argv is test-only and intentionally not an application protocol. Production must use
typed bounded envelopes and fixed artifact/argv/environment policy IDs. Relative read-only symlink
policy, atomic replace/rename/remove verbs, output framing, PTY inherited-FD handoff, final-image
seccomp and real provider/Git integration remain unverified.
