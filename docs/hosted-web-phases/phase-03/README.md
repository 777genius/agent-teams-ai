# Phase 03 navigation: P3.C0A source-lane admission

- Revision: `phase-03-p3-c0a-source-lane-admission-r6`
- Current node: `P3.C0A.SOURCE_LANE_ADMISSION`
- Product repository/PR: `777genius/agent-teams-ai` #503
- Source base: `cf3694f42f91795db4be0e564ed6eea11040768a`
- Source tree: `ca0ad7002439212788da12989c9abb150036b847`
- Result/phase-start commit: `UNSET`, controller-injected only after independent review/CAS adoption
- Terminal state: `HOLD`

Historical `pr252` job prefixes are not a PR identity. No r6 document contains or predicts its own
result commit. `ProjectScopedControl` atomically injects the adopted `phaseStartSha` and diff binding
for `{revision, baseSha, phaseStartSha, diffSha256}` after exact independent review.

## Outcome and authority

After adoption, the packet admits only isolated source implementation in the six registered lanes and
independent review of the resulting exact patches. Source authority is separate from candidate-build,
exact-input-freeze, one-run, production and release authority. No build, `P3.C1` freeze, `P3.C2` run,
release, deployment or production action is authorized. `authorizedRunsNow=0`,
`maximumAuthorizedRuns=0`, every completion/build/freeze/run/production/release gate is false, and the
packet ends `HOLD`.

The active node set, 25-edge set, six-lane registry and ownership closures are canonical in
[EXECUTION_INDEX.json](../EXECUTION_INDEX.json) and rendered without additions in
[execution-dag.md](execution-dag.md) and [the lane packet](lanes/p3-c-no-fake-e2e.md). The sole source
path overlap requiring coordination is `scripts/build.test.ts`: `P3.S2` owns epoch 1; only after
`P3.R2` closes may `P3.S3` own epoch 2. `P3.S5` and other cross-repository lanes run only in their
own repository workspaces, so their same-named paths do not overlap Product or Owner workspace paths.

## Input disposition

| Input | State | Exact binding or rule |
| --- | --- | --- |
| Source topology | READY | commit `cf3694f42f91795db4be0e564ed6eea11040768a`; tree `ca0ad7002439212788da12989c9abb150036b847` |
| r409 contract decision | READY | normative roles `opencode`, `owner`, `product-producer`, `browser`; unchanged Product handoff excluded |
| Provenance schema | READY | 54,393 bytes; `acde43e62b8ab42cc5fd2bbecc22f1b96d68f456bfa188b8c63730751222f498` |
| r423 Owner salvage | READY for salvage/review, not accepted source | 297,769 bytes; `157d30b91f26a9bd2f65f49ecbaf882d6a72948b703f5ccbf8589bd1148ae5b7` |
| r425 OpenCode salvage | READY for salvage/review, not accepted source | 420,353 bytes; `84b07730e02f800b115df0b3dff256b57b1d69a496538cb34126395213df38e6` |
| r431 schedule decision | READY normative decision | one OpenCode process, seven launches; earlier eight-launch approval superseded |
| r421 golden/test | REJECTED audit evidence | never apply its complete patch wholesale |
| r429 Product result | `UNSET/PENDING` | independently reviewed exact result commit/tree required |
| r433 release isolation | `UNSET/PENDING` | independently reviewed exact result commit/tree required after Owner runtime review |
| r435 replacement golden/test | `UNSET/PENDING` | independently reviewed exact identities required |

Also rejected/currently inadmissible, while retained as historical facts, are schema `3f5ad0…`, old
Product packet base `720fc62768341e1c2960cfaf4ad2496dd008291e` / tree
`d055bb5c362082a3b721d04ff1c44d8711d8d208`, PR44 source
`06e5dd89aee920c6e3ecd8ff0efbfcf5135021b7` as a runnable artifact, the complete old OpenCode
artifact tuple recorded in the index, and split `opencode-handler`/`opencode-effect` roles.

Pre-r6 drafts receive no retroactive acceptance. After adoption they must be relaunched or salvaged
by exact immutable patch identity into r6-anchored workspaces and independently reviewed. Candidate
builds, exact locks, stack manifest, P3.C1 manifest, authorization, nonce, sandbox/evidence root, run
evidence, publication, deployment, production and release identities all remain `UNSET/PENDING`.

No code or E2E runs in this packet. Real-project runtime and terminal use remain forbidden. End
`HOLD`.
