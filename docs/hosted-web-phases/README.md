# Hosted Web Refactor: Execution Router

## Purpose

This file is the entrypoint for autonomous execution. It does not redefine product or architecture.
It tells a controller and its workers which document is authoritative, which phase is executable, what
must be read, and when work must stop.

The 6,000+ line parent plan is an architecture and release reference. It is not a worker prompt.

## Authority order

Apply documents in this order:

1. Repository guardrails: `AGENTS.md`, `CLAUDE.md`, `AGENT_CRITICAL_GUARDRAILS.md`.
2. `docs/hosted-web-e2e-completion-plan.md` for scope, ADRs, invariants and release gates.
3. This router for active-phase selection and packet lifecycle.
4. The active phase controller packet for DAG, admission, integration and exit conditions.
5. The assigned lane packet for one worker's reads, writable paths, deliverables and checks.
6. A controller directive only when it narrows the active packet without changing its semantics.

A lower-level document may narrow work but may not broaden scope, weaken a guardrail, change an ADR or
skip an exit gate. On conflict, stop and return `packet_conflict`; do not choose the more convenient
interpretation.

## Phase registry

| Phase | Outcome                                                                    | Execution packet                            | Status                                   |
| ----- | -------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------- |
| 0     | Pin the base and replace architecture assumptions with executable evidence | `../hosted-web-phase-0-execution-packet.md` | ready after explicit start authorization |
| 1     | Establish capability-owned contracts and conformance                       | materialize after Phase 0 freeze            | blocked by Phase 0                       |
| 2     | Establish identity and safe read-only truth                                | materialize after Phase 1 evidence          | blocked                                  |
| 3     | Make mutations durable and external-writer aware                           | materialize after Phase 2 evidence          | blocked                                  |
| 4     | Centralize runtime execution and lifecycle ownership                       | materialize after Phase 3 evidence          | blocked                                  |
| 5     | Produce the real hosted composition and artifact                           | materialize after Phase 4 evidence          | blocked                                  |
| 6     | Close authentication, authorization and workspace isolation                | materialize after Phase 5 evidence          | blocked                                  |
| 7     | Deliver the first complete browser lifecycle                               | materialize after Phase 6 evidence          | blocked                                  |
| 8     | Add tasks, Kanban and messaging with reconciliation                        | materialize after Phase 7 evidence          | blocked                                  |
| 9     | Close required review, approval, logs and member parity                    | materialize after Phase 8 evidence          | blocked                                  |
| 10    | Harden, prove and roll out the release                                     | materialize after Phase 9 evidence          | blocked                                  |
| T1    | Hosted terminal parity                                                     | intentionally post-v1                       | deferred                                 |

Only one phase may be `active`. A later phase packet is not written in executable detail until the
previous phase produces its decision register, evidence index, estimate reconciliation and exit-gate
result. This prevents stale packets from encoding assumptions as instructions.

## Active packet set

Phase 0 uses:

- controller packet: `../hosted-web-phase-0-execution-packet.md`;
- W1: `phase-00/lanes/w1-parity-renderer.md`;
- W2: `phase-00/lanes/w2-provider-runtime.md`;
- W3: `phase-00/lanes/w3-state-writers-backup.md`;
- W4: `phase-00/lanes/w4-lease-guard-process.md`;
- W5: `phase-00/lanes/w5-events-commands-recovery.md`;
- W6: `phase-00/lanes/w6-auth-proxy-artifacts.md`.

Packet format and handoff rules are defined by `PACKET_STANDARD.md`.
New packets start from `_templates/phase-controller-packet.md` and
`_templates/worker-lane-packet.md`; the template is filled from predecessor evidence, never copied with
unresolved placeholders into an active job.

## Packet materialization gate

Before a controller marks a phase packet `ready`, it records:

- parent plan commit and packet revision;
- pinned predecessor commit and evidence-index hash;
- required ADR IDs and any decisions reopened by predecessor evidence;
- exact work packages and unique estimate buckets covered;
- owned paths with no overlapping writer;
- integration order and review pairing;
- required checks and the classification of inherited failures;
- rollback or feature-gate boundary for behavior-changing work;
- unresolved questions, each with one owner and a blocking/non-blocking classification.

If any required input is missing, the packet stays `draft` or `blocked`. A worker count target is never
a reason to start a speculative later-phase lane.

## Controller start algorithm

1. Verify explicit authorization for the active phase.
2. Re-fetch and pin the base or predecessor integration SHA.
3. Verify packet revision, plan revision, evidence hashes and active-phase status.
4. Run host admission and project debt checks.
5. Create the integration branch/worktree and adopt the reviewed plan bundle first.
6. Run the serial baseline/evidence gate and record `phaseStartSha`.
7. Create only the child worktrees declared by the active packet, all from `phaseStartSha`.
8. Render each worker prompt from one in-worktree lane packet plus immutable runtime facts.
9. Reject a prompt whose writable paths overlap another live lane.
10. Reconcile fresh workers against unique lane slots; never refill completed slots as duplicate work.
11. Monitor evidence progress, not token output or a stale `running` state.
12. Review and adopt through the declared integration order.
13. Freeze the phase, then materialize the next packet from the resulting evidence.

## Worker read algorithm

A child worker reads, in order:

1. repository guardrails;
2. its lane packet in full;
3. only the parent-plan headings and source paths listed by that lane packet;
4. the active controller packet sections named by the lane packet;
5. source and tests needed to prove the deliverables.

The worker does not need to read the parent plan front to back. If a referenced heading no longer
exists or its semantics differ from the lane packet, it returns `packet_stale` before editing.

## Resume and retry

Every lane is resumable from its worktree and handoff record. A replacement worker must verify base
SHA, packet revision, existing diff, completed checks and unverified claims before continuing. It may
not restart the lane from scratch over dirty output or discard another worker's evidence.

Retries preserve command/idempotency fixtures and evidence IDs. A retry caused by infrastructure is
not a reason to weaken the acceptance criteria.

## Completion language

Allowed result states are:

- `verified`: every required proof ran in the required topology;
- `characterized`: source and deterministic fixtures are complete, but a named target-host proof is pending;
- `blocked`: a named dependency or unsafe ambiguity prevents completion;
- `failed`: the proposed contract or primitive failed its acceptance criteria;
- `superseded`: the controller adopted another reviewed output for the same evidence IDs.

`Done`, `looks good` and `implemented` are not valid standalone states.
