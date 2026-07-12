# Phase 0 acceptance and completion record

Phase 0 started at `a32f509e6d9bd31ba2135940e336729bf90c3d93` and is accepted/frozen at
`f4fa24aac9615a4ce10632965a2244a2e11a273e`. No evidence byte is attributed to a commit unless
`git show` at the stated integration commit produces that exact byte.

Current lane dispositions are:

- W1: original v9 adopted; the `0d1a82fe…` renderer census narrowly adopted as characterization;
  pack-relative raw-evidence serialization remains source-observed and is integrated at `a6bd7a39…`.
- W2: original A1 approved; the `6d54e7c6…` omission-sensitive census narrowly adopted, with final
  target-image provider behavior and credential canaries unproved.
- W3/W5: compatible only within the evidence boundary; the `5d723407…` command-ownership correction
  is narrowly adopted and does not implement hosted recovery.
- W4/W6: characterization only. The `c958c872…` artifact authority and `3bc0dfa7…` fail-closed
  target-image narrowing are adopted without admitting hosted mutation or final-image readiness.

Historical rejected-pair, held-adoption, failed-audit, h7, and h8 conclusions remain immutable
historical evidence. They are not adopted and are not current blockers. The accepted target-image
decision, final-gate reconciliation, orchestration authority, bounded navigation contract, and
estimate reconciliation resolve the former Phase 0 transition blockers.

Phase 1 is current only for `P1.S0` serial bootstrap. Its one authorized worker may freeze exact
packet identity, ownership, paths, fixtures, baselines, commands, and start SHA; it may not implement
product source. `P1.S1` and every later subphase remain blocked until S0 is integrated and the router
is explicitly advanced.

## Remaining implementation risks

- Exact target-image/profile construction, provider canaries, production composition, and
  terminal-negative admission remain fail closed for their owning later phases.
- The accepted non-terminal v1 estimate is 38,300-62,100 gross changed lines. Its upper endpoint,
  W4 controller allocations, W3/W5 overlap bound, and unallocated migration split require planning
  discipline during implementation.
- These limitations may narrow or stop a dependent later-phase capability. They do not authorize
  repeating Phase 0 research.

## Typecheck normalization rule

The accepted final gate compares diagnostics against the inherited seven-diagnostic set: five in
`auth-artifacts-spike.test.ts`, one in `host-primitives/evidence-scanner.test.ts`, and one in
`provider-runtime/scan-runtime-surfaces.test.ts`. The normalized comparison does not waive the
repo-wide typecheck or convert an inherited failure into a pass.
