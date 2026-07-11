# Phase 1 packet assembly

Status: `blocked draft`; not executable.

This directory records the Phase 1 packet shape supported by the parent plan and the inspected Phase 0
state. It deliberately does not contain worker lane packets: Phase 0 is not frozen, all three
reciprocal review pairs reject producer evidence, the cross-lane audit holds all adoption, the
requirements audit rejects Phase 0 acceptance/freeze, and
there is no predecessor integration SHA or frozen evidence-index hash.

- [`controller-packet.md`](./controller-packet.md) applies the packet standard while keeping every
  unmet Definition of Ready item explicit.
- [`packet-inputs.md`](./packet-inputs.md) separates supported predecessor facts from unresolved or
  contradicted inputs.

The execution router must continue to list Phase 1 as blocked. A controller must not render worker
prompts, create Phase 1 worktrees, enable refill, or treat the proposed 1A-1D topology as ownership
until a Phase 0 freeze replaces this draft.
