# P0.W4.PROCESS_ANCHOR_SPIKE

Status: `characterized`.

`process_anchor_spike.c` binds a caller nonce into `ready`, enables `PR_SET_CHILD_SUBREAPER` and
`PR_SET_NO_NEW_PRIVS`, opens a pidfd for the main child before readiness, keeps typed stdin/stdout
control/status separate from provider output, and reports TERM, KILL, `drained`, `protocol_error` or
`unclassified_residual`. It discovers only descendants of its own marker-owned anchor. Every TERM or
KILL target is opened as a pidfd, checked against the same pre/post `/proc` start-time identity, and
signaled with `pidfd_send_signal`; the process group is classification evidence only. The spike issues
no numeric PID or PGID signal, so an empty/reused process group cannot receive a late escalation.

Current-host cases proved normal typed stop, control EOF, a double-forked descendant, TERM-ignore to
KILL escalation, and an escaped process-group fixture. Normal/ignore/double cases ended `drained` with
zero descendants. The intentional group escape returned `unclassified_residual` even though the
fixture performed exact owned cleanup. A simultaneously running unrelated marker process remained
alive in every case. `/proc/<provider>/fd` evidence contained no control/status pipe.

Each outcome carries the exact generation-bound `process_drain_outcome_v1` fields consumed by W6:
purpose, reset/deployment/process-anchor generations, classification identity and residuals. A
drained result requires an empty residual list; escape or identity ambiguity is unclassified and
requires container replacement. The pressure schedule still cannot force kernel PID reuse
deterministically, so it proves stable pidfd targeting and unrelated-process survival rather than a
numeric recycle event. Final container init behavior,
anchor crash/whole-container replacement, real stdout flood/backpressure, real relay bootstrap FDs,
artifact protocol hashes and non-root final seccomp remain unverified.
