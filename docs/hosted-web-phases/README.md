# Hosted-web execution packets

Current authority is [Phase 03 actual-owner closure](phase-03/README.md), revision
`phase-03-actual-owner-closure-r1`. Start with [START_HERE.md](START_HERE.md) and use
[EXECUTION_INDEX.json](EXECUTION_INDEX.json) as the machine-readable source of truth.

## Current route

Phase 03 closes one remaining Hosted Core v1 boundary without broadening scope:

1. prove whether PR #252 already has the complete signed-v4 product binding seam and add only the
   smallest missing seam when evidence shows a real gap;
2. independently review and integrate the two-phase actual-owner startup change from orchestrator
   PR #44;
3. run one new sandbox-only no-fake approval flow across the exact product, orchestrator, and pinned
   OpenCode artifact revisions; and
4. change production eligibility only as one coordinated activation after that evidence passes.

The current authorized node is only `P3.A.PRODUCT_BINDING`. It must not add another lifecycle
authority, treat the scalar compatibility coordinator as signed-v4 truth, launch a real project, or
enable a production gate. A verified zero-code result is valid when the existing composition already
provides the required boundary.

## Authority and evidence

Every worker starts from the exact immutable phase SHA injected by `ProjectScopedControl`, edits only
the lane packet's explicit paths, runs the declared checks, self-reviews, and returns `HOLD`.
Successor nodes require a new controller decision; worker output alone never authorizes integration,
E2E, or gate activation.

The runtime owns execution primitives only. The controller owns DAG admission, dependencies, review,
drift invalidation, integration, and promotion. Historical Phase 01/02 packets remain preserved but
are not current launch authority.
