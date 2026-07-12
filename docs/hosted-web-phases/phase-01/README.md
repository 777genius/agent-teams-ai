# Phase 1 proposal assembly

Status: `blocked proposal`; not executable or authoritative.

This directory records a possible Phase 1 shape supported by the parent plan and the current Phase 0
freeze candidate. It does not freeze contract IDs, writable paths, lane ownership, shared writers,
worker prompts, or authorization.

- [`controller-packet.md`](./controller-packet.md) applies the packet standard while keeping every
  unmet Definition-of-Ready item explicit.
- [`packet-inputs.md`](./packet-inputs.md) separates current supported predecessor facts, historical
  superseded conclusions, and still-current blockers.

The execution router must continue to list Phase 1 as blocked. A controller must not render worker
prompts, create Phase 1 worktrees, enable refill, or treat the proposed 1A-1D topology as ownership
until the Phase 0 candidate is integrated, every readiness item passes, serial bootstrap evidence
exists, and explicit implementation authorization is received. Producer target is zero.
