# PR 252 main extraction checkpoints

Integration branch: `refactor/pr252-main-extractions`, initially based on main
`163d0e57befe39e0d719d87a18aac0c7e38cb0e4`.
Source architecture reference: PR #252 at
`a2e5f0c8ab61a98ac2517e7c1387bc6865a23962`.

## Delivery boundaries

Each child PR targets the integration branch and preserves current main behavior.
Copying entire Hosted Web callers or introducing its behavioral changes is outside
these extraction checkpoints. Each checkpoint remains independently revertible.

1. Terminal command models, history/autocomplete, storage and event normalization.
2. Terminal appearance/preferences/settings, rebased after checkpoint 1.
3. Existing TeamDataService task queries and snapshot assembly.
4. Agent graph layout state, domain transitions and application actions.

Independent query/graph lanes may run in parallel. Changes sharing the terminal
Panel or its source-size cap are integrated sequentially. Additional larger
candidates require measured existing-body LOC and behavior preservation evidence;
new module size alone does not measure code relocated from a monolith.

## Validation

- Preserve existing observable expectations and public caller contracts.
- Run focused tests, project typecheck, full lint and source-size ratchet.
- Obtain independent technical review of the exact final code before merging.
- Run integration CI after each merge and validate interacting checkpoints together.
- Use only synthetic fixtures/sandbox projects for runtime or agent checks.
- Keep unrelated main changes and Hosted Web source history intact.

The final main PR retains this stack ancestry. Do not squash its base while
active child PRs depend on it. Main integration is a separate readiness decision.
