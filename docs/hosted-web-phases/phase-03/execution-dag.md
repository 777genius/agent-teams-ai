# Phase 03 execution DAG

Status: `active at P3.A only`; terminal state: `HOLD`.

```text
PR252.CORE_HEAD.GREEN
          |
          v
P3.A.PRODUCT_BINDING       implement the adjudicated activation-v1 product seam
          |
          v
P3.RA.PRODUCT_REVIEW       fresh exact-tree architecture/security review
          |
          v
P3.B.ORCHESTRATOR_INTEGRATION
          |                review/integrate two-phase actual-owner startup in PR #44
          v
P3.C.NO_FAKE_E2E           fresh sandbox, exact product/orchestrator/OpenCode revisions
          |
          v
P3.F.COORDINATED_ACTIVATION
                           product + orchestrator + manifest gates change together
          |
        HOLD
```

Only the first node is currently materialized as a lane packet. Each successor requires accepted
predecessor evidence and a new controller admission. No node launches its successor.

Parallel support is allowed only for read-only auditing of preserved WIP and CI evidence. It cannot
write a P3 path, count as product completion, or supply release evidence. Cross-repository work uses
isolated worktrees and explicit ownership.

The E2E node must never use an existing user project. It creates and marks its own sandbox, proves
canonical containment before every effect, performs narrow marker-checked cleanup, and reports any
residual instead of broad process/path cleanup.
