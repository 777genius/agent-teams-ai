# P0.W4.NATIVE_ARTIFACT_PROPOSAL

Status: `characterized`; proposal only, not production behavior.

Keep three separately versioned binaries and protocol manifests:

1. `agent-teams-instance-lock`: tiny pre-Node launcher, stable-anchor validation, one held flock open
   description, controller lifecycle pipe and signal forwarding.
2. `agent-teams-workspace-guard`: one-shot bounded file/exec verbs over shared audited Linux
   descriptor-resolution helpers; no daemon, shell, network or authorization logic.
3. `agent-teams-process-anchor`: per-run nonce/control/status protocol, descriptor-bound cwd entry,
   pidfd/subreaper ownership, bounded output and generation-bound `process_drain_outcome_v1` evidence
   using the exact W6 purpose/reset/deployment/anchor/classification/residual field names.

Build C sources in a pinned dedicated Debian-slim stage with warnings-as-errors, hardening flags,
ASan/UBSan and fuzz/size tests. Copy only stripped binaries and deterministic manifests into the final
image. Each manifest records protocol version, source hash, compiler/base digest, target ABI and binary
hash. Workspace and anchor may share audited syscall/framing source at build time, never one broad
runtime protocol. Readiness probes run only after final UID, seccomp, mounts, init/PID namespace and
stop grace are applied.

Phase 1 must not adopt these spike CLIs. First close the target-container gate and design bounded
versioned envelopes/status frames, exact FD maps, error taxonomy, packaging ownership and the Node
ports that cannot downcast grants/process refs to raw paths/PIDs. Failure keeps dependent hosted
mutation, Git and provider launch capabilities absent; no Node pathname/PID fallback is acceptable.
The paired artifact layout is `/app/bin/*`, matching W6's proposed hosted image manifest; W6 still
must import the W4 contract and supply every required hash/build/ABI/ownership field before admission.
