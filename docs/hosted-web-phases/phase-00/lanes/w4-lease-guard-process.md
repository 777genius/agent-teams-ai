# Phase 0 W4: Lease, Workspace Guard and Process Ownership

- Packet revision: `phase-00-r2`
- Evidence owner: W4
- Depends on: completed 0A and access to an admitted final-shape Linux test topology

## Mission

Run Linux feasibility work that TypeScript mocks cannot prove: one writer, descriptor-bound workspace
effects and owned process-tree drain.

## Read set

Read the Phase 0 W4, ownership and stop sections. From the master plan read `ADR-16`, `ADR-28`,
`Descriptor-bound PTY launch handoff`, `ADR-31`, `Docker and hosting topology` and relevant process,
workspace, Git and provider-spawn source/tests.

## Writable paths

- `docs/research/hosted-web/phase-0/host-primitives/**`
- `scripts/hosted-web/phase-0/host-primitives/**`
- `test/architecture/hosted-web/phase-0/host-primitives/**`
- worktree-local `.codex-handoff/phase-00-w4.json`

## Evidence

- `P0.W4.TARGET_HOST_ENVELOPE`
- `P0.W4.INSTANCE_LEASE_SPIKE`
- `P0.W4.WORKSPACE_GUARD_SPIKE`
- `P0.W4.PROCESS_ANCHOR_SPIKE`
- `P0.W4.NATIVE_ARTIFACT_PROPOSAL`
- `P0.W4.ESTIMATE`

## Acceptance

Prove mutual exclusion across two starts and owner failure; test descriptor close and path replacement;
run openat2/statx/seccomp/filesystem probes in the final-shape container; produce zero outside-marker
effects for symlink, rename, bind-mount and generation races; prove nonce/ready/pidfd/subreaper process
ownership, escalation and typed drain outcomes; prove control descriptors do not leak to children.

If the topology is unavailable, return `characterized`, never `verified`. Never touch unrelated host
processes or productionize spike artifacts.

## Handoff

Include host/kernel/filesystem envelope, negative controls, process cleanup evidence and every unverified
topology assumption.
