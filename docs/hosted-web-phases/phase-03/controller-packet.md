# Phase 03 controller packet: source-lane admission r6

## Controller identity

| Field | Value |
| --- | --- |
| Revision | `phase-03-p3-c0a-source-lane-admission-r6` |
| Current node | `P3.C0A.SOURCE_LANE_ADMISSION` |
| Product repository/PR | `777genius/agent-teams-ai` #503 |
| Source base | `cf3694f42f91795db4be0e564ed6eea11040768a` |
| Source tree | `ca0ad7002439212788da12989c9abb150036b847` |
| Result/phase-start | `UNSET` pending independent review/CAS adoption |
| Terminal state | `HOLD` |
| Runs | `authorizedRunsNow=0`; `maximumAuthorizedRuns=0` |

The historical prefix `pr252` names jobs only and is never the Product PR identity. The packet must
not contain or predict its own result commit. Following exact review, `ProjectScopedControl` alone
atomically injects the adopted `phaseStartSha` and raw-diff binding by CAS over
`{revision, baseSha, phaseStartSha, diffSha256}`.

## Five separate authority classes

| Authority class | r6 disposition |
| --- | --- |
| Isolated source implementation and independent source review | admitted only after exact r6 adoption and only inside registered closures |
| Candidate build | not authorized; separate future packets for Owner, OpenCode and Product |
| `P3.C1` exact-input freeze | not materialized and not authorized |
| `P3.C2` exactly-one run | not materialized; zero runs authorized or possible under r6 |
| Production/release/deployment | unmaterialized and forbidden |

Every completion/build/freeze/run/production/release/successor gate is false. Source admission is an
authority class, not a completion or eligibility gate. `P3.F.COORDINATED_ACTIVATION` remains
controller-only and has no active edge.

## Adoption and source order

1. Independently review the raw r6 diff against exact base/tree and prove exactly the seven authority
   files changed, JSON/prose node-edge-lane agreement, all-false gates and clean diff checks.
2. Atomically CAS-adopt the exact r6 commit and diff binding through `ProjectScopedControl`.
3. Only then relaunch each source lane or salvage a pre-r6 draft by its exact patch byte length and
   SHA-256 into a new r6-anchored workspace. No draft is retroactively accepted.
4. Review and accept `P3.S0`/`P3.R0` first. Product, Owner and OpenCode source reviews require that
   accepted provenance contract review.
5. Apply the r431 normative decision: one OpenCode process owns both streams, with seven launches;
   the earlier eight-launch approval is superseded. Owner and OpenCode final review require this node.
6. Product may integrate the still-pending r429 semantics/harness, then separately review `P3.S5`.
   Keep Product on PR #503; do not confuse it with historical job prefixes.
7. Owner may salvage exact r423 and combine r409 semantics. Review `P3.S2`; only then start `P3.S3`
   because both epochs own `scripts/build.test.ts`. The r433 result remains pending.
8. OpenCode preserves the base/r359/r385/r411/r425 overlays byte-for-byte, adds only the registered
   semantic/schedule overlay and reviews the combined source. Its final source/pin remain pending.
9. Join accepted R0 through R5 at `P3.SR.SOURCE_ADOPTION`, then stop `HOLD`.

The precise active 16-node and 25-edge set is canonical in the index and duplicated in
[execution-dag.md](execution-dag.md). The exact six writable closures and immutable overlay inputs are
canonical in the index and duplicated in [the lane registry](lanes/p3-c-no-fake-e2e.md). A concrete
worker launch receives exactly one source lane ID, the exact adopted `phaseStartSha`, and that lane's
closure; review nodes are read-only.

## Immutable input rules

READY inputs are admitted only in these exact roles:

- source topology commit `cf3694f42f91795db4be0e564ed6eea11040768a`, tree
  `ca0ad7002439212788da12989c9abb150036b847`;
- r409 normative roles `opencode`, `owner`, `product-producer` and `browser`, but not its unchanged
  Product handoff;
- schema 54,393 bytes / `acde43e62b8ab42cc5fd2bbecc22f1b96d68f456bfa188b8c63730751222f498`;
- r423 Owner salvage 297,769 bytes /
  `157d30b91f26a9bd2f65f49ecbaf882d6a72948b703f5ccbf8589bd1148ae5b7`;
- r425 OpenCode salvage 420,353 bytes /
  `84b07730e02f800b115df0b3dff256b57b1d69a496538cb34126395213df38e6`;
  and
- r431 normative one-process/seven-launch decision, superseding eight launches.

The salvage handoffs are exact draft inputs, not accepted source. r421 golden/test remains REJECTED
audit evidence. r429 Product, r433 release isolation and r435 replacement golden/test are
`UNSET/PENDING` until completed identities are independently reviewed.

The old `3f5ad0…` schema, old Product packet base, PR44 source-as-runnable, old OpenCode source/build/
workflow/artifact tuple, and split OpenCode roles are rejected/currently inadmissible. Their historical
facts are preserved in the index; none can satisfy a current join.

## Stop conditions

Return `HOLD` on a non-exact base/tree, unreviewed or ambient result SHA, out-of-closure write,
unserialized `scripts/build.test.ts` access, pre-r6 draft treated as accepted, missing independent
review, collapsed authority class, any true completion/build/freeze/run/production/release gate,
positive run count, executable edge beyond source adoption, successor launch, code/build/runtime/
browser/provider/terminal/E2E execution, release/deployment action, or real-project contact.

Future packets—not r6—may materialize candidate builds, exact-lock materialization, `P3.C1`, `P3.C2`
and independent acceptance. No commit, push, build, run or release action is part of this packet. End
`HOLD`.
