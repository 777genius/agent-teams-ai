# P0.W4.TARGET_HOST_ENVELOPE

Status: `characterized` (not `verified`). Phase start SHA was
`a32f509e6d9bd31ba2135940e336729bf90c3d93` and matched HEAD before edits.

`phase-00-r3` narrows W4 to current-host characterization and read-only projections. This historical
target envelope is not a hosted readiness claim: mutation/runtime admission, workspace effects,
provider launch and production composition all remain absent.

## Required admitted envelope

- Node 24 on the release Debian-slim image, x86_64 initially, non-root fixed UID/GID, read-only image,
  `no-new-privileges`, explicit capability drop and the final seccomp profile.
- Linux kernel 5.6+ with working `openat2`, `statx` mount identity, pidfds,
  `PR_SET_CHILD_SUBREAPER`, `flock`, `renameat2`, directory/file `fsync`, `/proc` FD evidence and a
  minimal init in the final PID namespace.
- One pre-provisioned local filesystem deployment root: root-owned non-runtime-writable parent and
  stable `instance.lock`, with a separately runtime-writable `state/` child. NFS, CIFS and unknown
  network filesystems remain unsupported.
- Registered local workspace mounts with explicit generation and root dev/inode/mount-ID evidence.
  Nested mounts are separate registrations; default resolution uses `RESOLVE_NO_XDEV`.
- Two final-image containers plus a manual start must be able to share the same admitted local volume
  for the competing-writer proof. The runtime must not have the Docker socket, host PID namespace,
  privileged mode or a broad home mount.

## Observed worker envelope

The runnable probe observed Ubuntu 24.04.4, kernel `6.8.0-124-generic`, x86_64, Node `v24.16.0`, ext4,
UID 0, `NoNewPrivs=1`, and seccomp mode 2. `openat2`, `statx` mount ID, bind-mount rejection,
`flock`, pidfd and subreaper probes passed. Docker client `29.6.1` exists, but daemon access failed:
`permission denied while trying to connect to the docker API at unix:///var/run/docker.sock`.

This is not the admitted topology: it is root Ubuntu, not the final Debian-slim non-root image; the
checked-in Dockerfile has no ADR-16 launcher, pre-provisioned volume layout, workspace guard, process
anchor, init, non-root user or final seccomp declaration. Therefore every W4 result is bounded to the
current host and cannot close the target-container gate.

## Unverified assumptions

Final image digest/build manifest; non-root volume ownership; two-container/manual-start sharing;
launcher-before-Node ordering; duplicate lease FD integration with Node; final init/PID namespace;
final seccomp allowlist; read-only root/tmpfs/capability settings; child FD policy through real Node,
Git and provider adapters; output backpressure; container stop grace; image ABI/strip reproducibility;
and clean whole-container replacement after an ambiguous anchor outcome.
