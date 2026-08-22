# Phase 03 controller packet: actual-owner closure

## Status and authority

- Status: `active-product-binding-closure`.
- Packet revision: `phase-03-actual-owner-closure-r1`.
- Product authority: exact `phaseStartSha` injected by `ProjectScopedControl`.
- Product PR: `777genius/agent-teams-ai#252`.
- Orchestrator PR: `777genius/agent_teams_orchestrator#44`.
- OpenCode inputs: `777genius/opencode-anomaly#1` and `#2`.
- Terminal state: `HOLD` for every node.

The controller may admit only `P3.A.PRODUCT_BINDING` now. The worker cannot authorize its reviewer,
orchestrator integration, E2E, or activation.

## Required outcome

Provide the smallest product-side seam needed for a real actual-owner approval flow. Existing facts
must be reused:

- signed-v4 admission already binds deployment, boot, workspace mount, owner generation/session,
  socket identity, exact artifact, wire capability, per-team routes, approval generation and snapshot
  digest;
- active signed-v4 routes are already the only routes mounted by production composition;
- v2/v3 and empty route catalogs remain fail-closed; and
- the scalar compatibility lifecycle coordinator is not signed-v4 authority.

The producer must inspect those seams before editing. If no product code is missing after the
orchestrator two-phase startup fix, it returns a tested zero-code result rather than inventing a new
abstraction.

## Definition of Ready

All conditions are conjunctive:

1. the worktree is clean at the exact `phaseStartSha`;
2. the packet revision, phase, lane, ownership, docs and checks equal the immutable worker-launch
   contract;
3. no other writer owns a declared path;
4. PR #252 exact-head core checks are green or any unrelated failure is classified;
5. product and OpenCode production eligibility remain false; and
6. no runtime, launch, terminal, browser, provider, auth, or real-project action is requested.

## Ownership

The exact writable paths are only those listed for `activeLane.ownedPaths` in
[EXECUTION_INDEX.json](../EXECUTION_INDEX.json). All other paths are read-only. A need to edit
`standalone.ts`, shared contracts, feature approval authority, route registration, artifact locks,
dependencies, CI, or another repository is `packet_conflict` and returns `HOLD`.

## Acceptance

The producer must prove:

1. only a current launcher-signed v4 active route can create a product approval runtime authority;
2. route authority is partitioned by immutable `teamId` with no current-team or owner-writable
   fallback;
3. missing, malformed, stale, replaced, revoked, wrong-socket, wrong-artifact, wrong-wire, or legacy
   authority stays unmounted/absent;
4. owner loss and shutdown establish confirmed absence before the protected effect;
5. a product lifecycle seam, if added, consumes an evidence-bearing single-use owner lease and cannot
   manufacture signed admission; and
6. no gate changes from false and no E2E claim is made.

Focused tests, typecheck, changed-file lint, exact-path Prettier, `git diff --check`, ownership proof,
and a classified secret/private-path scan are required. The producer self-reviews the complete diff
for authority duplication, TOCTOU, fail-open fallback, lifecycle races, scope and test gaps.

## Successor policy

After producer `HOLD`, one fresh independent reviewer reruns the declared checks and reviews the exact
tree. ACCEPT requires P0/P1/P2 `0/0/0`. The controller then integrates only accepted bytes.

The orchestrator node separately reviews the two-phase startup invariant:

1. actual owner/runtime starts with approval delivery fail-closed;
2. exact owner readiness is published;
3. product validates the binding and publishes signed active admission; and
4. orchestrator atomically activates the approval delegate only for that exact admission.

Only after both repositories are accepted at exact commits may the controller materialize the E2E
packet. That packet uses one fresh marker-owned sandbox and exact pinned OpenCode artifact. It proves
the full approval path and the negative/recovery matrix without automatic retries after ambiguous
settlement.

Production activation is a final coordinated product/orchestrator/manifest change. Any head, artifact,
manifest, socket, authority, sandbox, or evidence mismatch returns `HOLD`.

## OpenCode convergence guard

The OpenCode downstream is not a separate product line. It is a temporary 17-file atomic-approval
patch queue over an exact upstream release plus reproducible artifact evidence. Upstream releases are
tracked daily; every stable/security update triggers a port-and-verification lane. The patch is
removed when upstream supplies equivalent atomic conditional reply or a safe plugin boundary. See
[the downstream policy](../../hosted-opencode-downstream-policy.md).
