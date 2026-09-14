# P3.C0A source-lane registry and retained no-fake contract

- Packet revision: `phase-03-p3-c0a-source-lane-admission-r6`
- Current node: `P3.C0A.SOURCE_LANE_ADMISSION`
- Product repository/PR: `777genius/agent-teams-ai` #503 (`pr252` is only a historical job prefix)
- Source base/tree: `cf3694f42f91795db4be0e564ed6eea11040768a` /
  `ca0ad7002439212788da12989c9abb150036b847`
- Result/phase-start: `UNSET`, injected with the diff binding only after independent review and
  atomic `ProjectScopedControl` CAS adoption
- Terminal state: `HOLD`
- Runs: `authorizedRunsNow=0`; `maximumAuthorizedRuns=0`

After adoption, r6 authorizes only isolated source implementation and independent source review.
Candidate build, exact-input freeze, run, release, deployment and production authority are separate
and absent. Every completion/build/freeze/run/production/release gate remains false. Each rendered
worker packet receives exactly one lane ID, exact adopted `phaseStartSha`, repository identity and the
exact writable closure below. Review packets are read-only. No worker receives run authority.

## Exact lane registry

### `P3.S0.PROVENANCE_GOLDEN` — `777genius/agent-teams-ai`, Product epoch 1

Review: `P3.R0.PROVENANCE_CONTRACT_REVIEW`. Writable closure:

1. `src/features/hosted-producer-provenance/contracts/hosted-producer-provenance-v2.golden.json`
2. `test/features/hosted-producer-provenance/HostedProducerProvenanceContractArtifact.test.ts`

The schema input is immutable: exactly 54,393 bytes and SHA-256
`acde43e62b8ab42cc5fd2bbecc22f1b96d68f456bfa188b8c63730751222f498`. r421 golden/test is
REJECTED audit evidence; the r435 replacement golden/test remains `UNSET/PENDING`.

### `P3.S1.PRODUCT_SEMANTICS_AND_HARNESS` — `777genius/agent-teams-ai`, Product epoch 1

Review: `P3.R1.PRODUCT_SOURCE_REVIEW`, which also depends on `P3.R0`. Writable closure:

1. `scripts/e2e/hosted-actual-owner/README.md`
2. `scripts/e2e/hosted-actual-owner/actual-owner-contract.v2.json`
3. `scripts/e2e/hosted-actual-owner/contracts.ts`
4. `scripts/e2e/hosted-actual-owner/driver.ts`
5. `scripts/e2e/hosted-actual-owner/evidence.ts`
6. `scripts/e2e/hosted-actual-owner/preflight.ts`
7. `scripts/e2e/hosted-actual-owner/processes.ts`
8. `scripts/e2e/hosted-actual-owner/run.ts`
9. `scripts/e2e/hosted-actual-owner/sandbox.ts`
10. `src/features/coordination-events/main/adapters/input/http/HostedCoordinationEventStreamController.ts`
11. `src/features/hosted-producer-provenance/contracts/index.ts`
12. `src/features/hosted-producer-provenance/main/HostedProducerProvenance.ts`
13. `src/features/hosted-producer-provenance/main/ProductHostedProducerOperation.ts`
14. `src/features/hosted-producer-provenance/main/ProductHostedProducerProvenanceEmission.ts`
15. `src/features/hosted-producer-provenance/main/index.ts`
16. `src/features/team-approvals/main/adapters/input/http/registerHostedTeamApprovalsHttp.ts`
17. `src/features/team-approvals/main/adapters/output/InternalStorageHostedTeamApprovalAuthority.ts`
18. `src/main/composition/hosted/createHostedApprovalProductionComposition.ts`
19. `src/main/composition/hosted/createHostedApprovalProductionCompositionFromEnvironment.ts`
20. `src/main/composition/hosted/hostedOperatorProductionComposition.ts`
21. `src/main/composition/hosted/hostedOperatorSurfacesComposition.ts`
22. `src/main/services/team/provisioning/HostedApprovalRuntimeActivationEnvelope.ts`
23. `src/main/services/team/provisioning/HostedApprovalRuntimeActivationTypes.ts`
24. `src/main/services/team/provisioning/HostedApprovalRuntimeActivationValidation.ts`
25. `test/architecture/hosted-web/approval-production-unmounted.test.ts`
26. `test/e2e/fixtures/hosted-actual-owner/harness.test.ts`
27. `test/e2e/hosted-web/actual-owner-approval.spec.ts`
28. `test/features/coordination-events/hosted/HostedCoordinationEventStreamController.test.ts`
29. `test/features/hosted-producer-provenance/HostedProducerProvenance.test.ts`
30. `test/features/team-approvals/hosted/HostedApprovalRuntimeActivation.test.ts`
31. `test/features/team-approvals/hosted/HostedTeamApprovalHttp.test.ts`
32. `test/features/team-approvals/hosted/HostedTeamApprovalTransport.test.ts`
33. `test/features/team-approvals/hosted/InternalStorageHostedTeamApprovalAuthority.test.ts`
34. `test/main/composition/hosted/hostedApprovalProductionActivation.test.ts`
35. `test/main/composition/hosted/hostedLifecycleProductionOwnerAdmission.test.ts`
36. `test/main/composition/hosted/hostedOperatorProductionComposition.test.ts`

This excludes schema, golden, artifact test and Hosted exact-lock creation. The r429 Product result
commit/tree remains `UNSET/PENDING` until completed and independently reviewed.

### `P3.S2.OWNER_RUNTIME_AND_SEMANTICS` — `777genius/agent_teams_orchestrator`, Owner epoch 1

Review: `P3.R2.OWNER_RUNTIME_REVIEW`, which depends on `P3.R0` and `P3.D1`. Writable closure:

1. `scripts/build.test.ts`
2. `scripts/e2e/hosted-actual-owner/owner.ts`
3. `scripts/e2e/hosted-actual-owner/secure-files.test.ts`
4. `scripts/e2e/hosted-actual-owner/secure-files.ts`
5. `src/entrypoints/cli.tsx`
6. `src/entrypoints/hostedActualOwnerAcceptance.test.ts`
7. `src/entrypoints/hostedActualOwnerAcceptance.ts`
8. `src/services/hostedControl/HostedActualOwnerNativeWriter.test.ts`
9. `src/services/hostedControl/HostedActualOwnerNativeWriter.ts`
10. `src/services/hostedControl/HostedActualOwnerProcessSupervisor.test.ts`
11. `src/services/hostedControl/HostedActualOwnerProcessSupervisor.ts`
12. `src/services/hostedControl/HostedActualOwnerProvenanceContract.ts`
13. `src/services/hostedControl/HostedApprovalOwnerWal.test.ts`
14. `src/services/hostedControl/HostedApprovalOwnerWal.ts`
15. `src/services/hostedControl/HostedApprovalOwnerStore.ts`
16. `src/services/hostedControl/HostedApprovalOwnerService.ts`
17. `src/services/hostedControl/HostedApprovalOwnerService.test.ts`
18. `src/services/hostedControl/HostedControlBootstrap.test.ts`
19. `src/services/hostedControl/HostedControlBootstrap.ts`
20. `src/services/hostedControl/HostedControlMain.test.ts`
21. `src/services/hostedControl/HostedControlMain.ts`
22. `src/services/hostedControl/HostedControlMonotonicDeadline.test.ts`
23. `src/services/hostedControl/HostedControlMonotonicDeadline.ts`
24. `src/services/hostedControl/HostedControlProductionComposition.test.ts`
25. `src/services/hostedControl/HostedControlProductionComposition.ts`
26. `src/services/hostedControl/HostedControlRuntime.ts`
27. `src/services/hostedControl/HostedControlServer.test.ts`
28. `src/services/hostedControl/HostedControlServer.ts`
29. `src/services/hostedControl/HostedControlSocketBroker.ts`
30. `src/services/hostedControl/HostedSocketBrokerSupervisor.test.ts`
31. `src/services/hostedControl/HostedSocketBrokerSupervisor.ts`
32. `src/services/hostedControl/fixtures/hosted-producer-provenance-v2.golden.json`
33. `src/services/hostedControl/fixtures/hosted-producer-provenance-v2.schema.json`
34. `src/services/hostedControl/fixtures/hostedControlBootstrapChild.ts`

The exact r423 salvage input is 297,769 bytes /
`157d30b91f26a9bd2f65f49ecbaf882d6a72948b703f5ccbf8589bd1148ae5b7`; it is salvage/review
material, not accepted source. The r409 Owner writer/WAL/store/service mission remains explicit: add
its normative `opencode`, `owner`, `product-producer` and `browser` roles without accepting the
unchanged Product handoff. Do not edit release workflows or release-metadata tooling.

### `P3.S3.OWNER_RELEASE_ISOLATION` — `777genius/agent_teams_orchestrator`, Owner epoch 2

Review: `P3.R3.OWNER_RELEASE_REVIEW`. This lane cannot start until `P3.R2` closes epoch 1. Writable
closure:

1. `package.json`
2. `scripts/build.ts`
3. `scripts/build.test.ts`
4. `.github/workflows/ci.yml`
5. `scripts/hosted-owner/release-metadata.ts`
6. `scripts/hosted-owner/release-metadata.test.ts`
7. `.github/workflows/hosted-owner-release.yml`

This is the only serialized overlap: `scripts/build.test.ts` belongs to `P3.S2` in epoch 1 and to
`P3.S3` only in epoch 2. r433 remains `UNSET/PENDING` until its exact completed result identity is
independently reviewed. Source review does not authorize a build or release.

### `P3.S4.OPENCODE_LIFECYCLE_AND_SEMANTICS` — `777genius/opencode-anomaly`, OpenCode epoch 1

Review: `P3.R4.OPENCODE_SOURCE_REVIEW`, which depends on `P3.R0` and `P3.D1`. Writable closure:

1. `.github/hardened/README.md`
2. `.github/hardened/opencode-hosted-approval-v2-r5-r431-remediation.patch`
3. `.github/hardened/opencode-hosted-approval-v2-r5.candidate.json`
4. `.github/hardened/release-manifest.schema.json`
5. `.github/scripts/hardened-artifacts.test.ts`
6. `.github/scripts/hardened-artifacts.ts`
7. `.github/workflows/hardened-cli-release.yml`

The base, r359, r385, r411 and r425 overlays are immutable inputs and must remain byte-for-byte:

1. `.github/hardened/opencode-hosted-approval-v2-r5.patch`
2. `.github/hardened/opencode-hosted-approval-v2-r5-r359-remediation.patch`
3. `.github/hardened/opencode-hosted-approval-v2-r5-r385-remediation.patch`
4. `.github/hardened/opencode-hosted-approval-v2-r5-r411-remediation.patch`
5. `.github/hardened/opencode-hosted-approval-v2-r5-r425-remediation.patch`

The exact r425 salvage input is 420,353 bytes /
`84b07730e02f800b115df0b3dff256b57b1d69a496538cb34126395213df38e6`. Apply the r431 decision:
one OpenCode process owns both streams in a seven-launch schedule; split roles and the earlier
eight-launch approval are inadmissible. A new combined source/pin identity remains `UNSET/PENDING`.

### `P3.S5.PRODUCT_LOCK_PARSER` — `777genius/agent-teams-ai`, Product epoch 2

Review: `P3.R5.PRODUCT_LOCK_PARSER_REVIEW`. Writable closure:

1. `scripts/hosted-release/contracts.mjs`
2. `scripts/hosted-release/verify-locks.mjs`
3. `test/scripts/hosted-release/contracts.test.ts`
4. `package.json`
5. `.github/workflows/ci.yml`

This lane may parse/verify future locks but may not create either exact lock. Later
`P3.CM.EXACT_LOCK_MATERIALIZATION` alone may create `hosted-lifecycle-owner.lock.json`,
`hosted-stack.lock.json`, the deployment materializer/test and the five enumerated P3.C contract/
preflight/evidence paths after accepted builds. That node is not materialized by r6.

## Exact DAG and review joins

The active node set and 25-edge set are exactly those in `EXECUTION_INDEX.json` and
`execution-dag.md`; this registry adds none. `P3.R0` gates Product, Owner and OpenCode source reviews.
`P3.D1` gates Owner and OpenCode final reviews. Accepted R0 through R5 join at
`P3.SR.SOURCE_ADOPTION`, whose sole outgoing edge is `HOLD`.

Pre-r6 drafts are not retroactively accepted. After adoption, each lane must be relaunched or its
draft salvaged by exact patch identity into a new r6-anchored workspace and independently reviewed.
`ProjectScopedControl` atomically supplies the adopted `phaseStartSha` and diff binding; no document
may contain or predict that result SHA as its own authority.

## Rejected and pending identities

Historical facts remain preserved, but these are rejected/currently inadmissible: r421 golden/test;
schema `3f5ad0…`; old Product packet base `720fc62768341e1c2960cfaf4ad2496dd008291e` / tree
`d055bb5c362082a3b721d04ff1c44d8711d8d208`; PR44 source
`06e5dd89aee920c6e3ecd8ff0efbfcf5135021b7` as runnable; split OpenCode roles; and the old OpenCode
tuple of PR head `fe07feb2f6c1a1d58ffb65d2f269c8fb3de4ca8f`, workflow merge
`2cbaa3f8d7f130ba41f07aab114a76f08cc311f1`, release source/tree/base
`3186244c3103eb02d95a255b593847b14488b070` /
`8fba45aecd63ec61f334a856694cbd3da037df90` /
`47b6b6f5f4f9b42d2bce7af1c4e5bf6efaf22ba7`, run `32784750815/1`, artifact `9541196940`, ZIP
`601e3bf7713ff4180d449cc788e6000a2b706fb01f7cd11647379ab45c004b0c`, manifest
`076dd096b36e34c47ad789c7b492d6b510f9b89cca9e6604f6fd0431c02d99fd`, tar
`fb1a48abaa25c412134c684f2c5b7ffa4fafd16d68c717fe0ede3ee655123308`, and binary
`4947f69d85d491b5f73ef1c9306a5ef69c2991800fbd40f05f2b15a53f57299e`.

r429 Product, r433 release isolation and r435 replacement golden/test stay `UNSET/PENDING`. So do all
reviewed source result commits/trees, candidate build identities, exact locks, stack manifest, P3.C1
manifest, authorization, nonce, sandbox/evidence root, run evidence, publication, deployment,
production and release identities.

## Retained future no-fake contract

r6 creates no executable edge to these topology-only nodes:

```text
P3.B2.OWNER_CANDIDATE_BUILD
OC.B2.OPENCODE_CANDIDATE_BUILD
P3.PB.PRODUCT_CANDIDATE_BUILD
P3.CM.EXACT_LOCK_MATERIALIZATION
P3.C1.EXACT_INPUT_FREEZE
P3.C2.FINAL_NO_FAKE_RUN
P3.RC.INDEPENDENT_ACCEPTANCE
P3.F.COORDINATED_ACTIVATION
```

If future separately reviewed packets ever reach `P3.C2`, they must freeze exact independently
accepted source/build/lock identities before authorizing exactly one fresh private marker-owned
sandbox/test-project run. A real project may never be opened in any runtime or terminal. Child
processes must receive private empty home/config/cache roots without ambient provider auth,
credentials or shared runtime state. Process ownership must bind controller nonce, role, executable
identity, cwd anchor, parent and start observation; cleanup may target only verified nonce-owned
trees.

Playwright may receive only a controller-created evidence manifest for an exact loopback origin.
Behavioral truth must derive from raw Product HTTP/SSE bytes, Owner WAL/journal bytes, OpenCode effect
records and supervisor lifecycle records joined to the controller nonce and verified process starts.
Reports, fixtures, screenshots and exit codes are indexes only. Ambiguous external effects become
durable `operator_required` and are never automatically retried; only explicit reconciliation proving
`not_delivered` may permit a new fenced attempt.

No build, freeze, runtime, browser, provider, terminal, E2E, release, deployment, production action,
commit or push is authorized here. End `HOLD`.
