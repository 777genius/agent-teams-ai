# Hosted-web execution packets

Current authority is [Phase 03 P3.C0A source-lane admission](phase-03/README.md), revision
`phase-03-p3-c0a-source-lane-admission-r6`, at `P3.C0A.SOURCE_LANE_ADMISSION`. Start with
[START_HERE.md](START_HERE.md) and use [EXECUTION_INDEX.json](EXECUTION_INDEX.json) as the
machine-readable source of truth.

## Exact authority

The source packet base is `cf3694f42f91795db4be0e564ed6eea11040768a`, tree
`ca0ad7002439212788da12989c9abb150036b847`, for Product repository
`777genius/agent-teams-ai` PR #503. Historical `pr252` job prefixes do not identify the PR. The r6
result/phase-start commit is `UNSET`; no packet document predicts it. `ProjectScopedControl` injects
the exact `phaseStartSha` and diff SHA-256 atomically only after independent review and CAS adoption.

Once adopted, r6 authorizes only isolated source implementation and independent source review in the
registered writable closures. It does not authorize a candidate build, `P3.C1` freeze, `P3.C2` run,
publication, release, deployment or production activation. All corresponding gates are false,
`authorizedRunsNow=0`, `maximumAuthorizedRuns=0`, and terminal state is `HOLD`.

## Active route

```text
P3.C0A.SOURCE_LANE_ADMISSION
  +-> P3.D1.OPENCODE_SCHEDULE_ADJUDICATION --------------------------+
  +-> P3.S0.PROVENANCE_GOLDEN -> P3.R0.PROVENANCE_CONTRACT_REVIEW --+
  +-> P3.S1.PRODUCT_SEMANTICS_AND_HARNESS -> P3.R1.PRODUCT_SOURCE_REVIEW
  +-> P3.S2.OWNER_RUNTIME_AND_SEMANTICS -> P3.R2.OWNER_RUNTIME_REVIEW
  |                                            -> P3.S3.OWNER_RELEASE_ISOLATION
  |                                            -> P3.R3.OWNER_RELEASE_REVIEW
  +-> P3.S4.OPENCODE_LIFECYCLE_AND_SEMANTICS -> P3.R4.OPENCODE_SOURCE_REVIEW
  +-> P3.S5.PRODUCT_LOCK_PARSER -> P3.R5.PRODUCT_LOCK_PARSER_REVIEW
                     accepted R0, R1, R2, R3, R4 and R5
                                         |
                                         v
                              P3.SR.SOURCE_ADOPTION
                                         |
                                       HOLD
```

The exact machine edge set is in the index and repeated in the DAG. Product, Owner and OpenCode
reviews depend on accepted provenance contract review. Owner and OpenCode final review also depend on
the r431 schedule adjudication. `P3.S3` begins only after `P3.R2` because `P3.S2` and `P3.S3` have
serialized epochs over `scripts/build.test.ts`.

Future controller packets may separately materialize Owner, OpenCode and Product candidate builds,
then exact-lock materialization, `P3.C1`, `P3.C2`, and independent acceptance. Those future nodes are
not in the active edge set. `P3.F.COORDINATED_ACTIVATION` remains controller-only and unmaterialized.

## Evidence disposition

- READY: exact source topology/base `cf3694f42f91795db4be0e564ed6eea11040768a` and tree
  `ca0ad7002439212788da12989c9abb150036b847`; r409 normative roles `opencode`, `owner`,
  `product-producer` and `browser` only; exact accepted
  schema bytes 54,393 / `acde43e62b8ab42cc5fd2bbecc22f1b96d68f456bfa188b8c63730751222f498`;
  r423 salvage handoff 297,769 / `157d30b91f26a9bd2f65f49ecbaf882d6a72948b703f5ccbf8589bd1148ae5b7`;
  r425 salvage handoff 420,353 / `84b07730e02f800b115df0b3dff256b57b1d69a496538cb34126395213df38e6`;
  and the r431 one-OpenCode-process, seven-launch normative decision.
- REJECTED/currently inadmissible: r421 golden/test as audit evidence; schema digest `3f5ad0…`; old
  Product packet base; old PR44 source-as-runnable claim; the old OpenCode artifact tuple; and split
  `opencode-handler`/`opencode-effect` roles. Historical facts remain recorded, never current inputs.
- `UNSET/PENDING`: r429 Product result, r433 release-isolation result, r435 replacement golden/test,
  all reviewed source result commits/trees, candidate builds, exact locks, P3.C1 manifest,
  authorization/nonce/sandbox/evidence root, run evidence, release and production identities.

Pre-r6 drafts require exact-identity relaunch or salvage into r6-anchored workspaces after adoption;
none is retroactively accepted. No real-project runtime/terminal use, code execution or E2E is
authorized. End `HOLD`.
