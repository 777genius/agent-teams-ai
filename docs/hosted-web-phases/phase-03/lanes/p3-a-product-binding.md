# P3.A: product actual-owner binding closure

- Packet revision: `phase-03-actual-owner-closure-r2`.
- Role: one bounded product producer.
- Depends on: exact green PR #252 phase head.
- Result: `verified | blocked | failed`; terminal state always `HOLD`.
- The r1 zero-code finding is superseded by independent cross-repository adjudication.

## Mission

Implement the demonstrated missing product activation-v1 seam needed by the orchestrator's
two-phase actual-owner startup. Product validates authenticated `owner_ready`, serializes and signs
the canonical envelope, sends it over lifecycle-control IPC, and mounts routes only after exact
authenticated `ready`. Do not create a parallel lifecycle authority.

## Required reads

After the common order in [START_HERE.md](../../START_HERE.md), read completely:

1. approval actual-owner and activation sections in
   `docs/hosted-web-core-v1-scope-lock.md`;
2. `docs/hosted-opencode-downstream-policy.md`;
3. `src/main/composition/hosted/hostedLifecycleProductionOwnerAdmission.ts`;
4. `src/main/composition/hosted/createHostedApprovalProductionComposition.ts`;
5. every file in the exact writable set;
6. focused tests named below; and
7. the current orchestrator PR #44 actual-owner handoff supplied by the controller.

## Exact writable paths

1. `src/main/standalone.ts`
2. `src/main/composition/hosted/hostedLifecycleOrchestratorReadiness.ts`
3. `src/main/composition/hosted/createHostedApprovalProductionComposition.ts`
4. `src/main/services/team/provisioning/HostedApprovalRuntimeAdmissionPublisher.ts`
5. `src/main/services/team/provisioning/HostedApprovalRuntimeLifecycleCoordinator.ts`
6. `src/main/services/team/provisioning/HostedApprovalRuntimeProductionComposition.ts`
7. `src/main/services/team/provisioning/HostedApprovalRuntimeActivationEnvelope.ts` (new)
8. `src/main/services/team/provisioning/__tests__/HostedApprovalRuntimeAdmissionPublisher.test.ts`
9. `src/main/services/team/provisioning/__tests__/HostedApprovalRuntimeLifecycleCoordinator.test.ts`
10. `test/features/team-approvals/hosted/HostedApprovalRuntimeActivation.test.ts` (new)
11. `test/main/composition/hosted/hostedApprovalProductionActivation.test.ts` (new)
12. `test/main/composition/hosted/hostedLifecycleProductionOwnerAdmission.test.ts`
13. `test/architecture/hosted-web/approval-production-unmounted.test.ts`
14. `docs/hosted-approval-activation-v1-golden.json` (new shared fixture)

All other paths are read-only.

## Decision order

1. Trace signed-v4 owner admission from validated bootstrap input to per-team approval authority.
2. Trace owner loss, replacement, restart, shutdown and confirmed-absence behavior.
3. Compare the product contract to the orchestrator two-phase handoff.
4. Reuse the established missing invariant: no authenticated activation-v1 producer exists.
5. Implement the smallest change inside exact ownership and add focused regression tests.

## Acceptance and negative controls

- Active approval routes originate only from exact launcher-signed v4 admission.
- Provisioning, restart-required, v2/v3, empty, malformed and stale inputs remain unmounted.
- The scalar lifecycle coordinator is neither trusted admission nor a route catalog producer.
- Evidence-bearing owner leases are single-use and lifecycle-exact; missing or mismatched evidence
  confirms absence.
- Owner loss/shutdown cannot race a later transition back into active state.
- No current-team, workspace file, ambient process, mutable tag, raw socket, or unsigned fallback is
  added.
- Canonical proof-last JSON and HMAC use production activation-v1 domains and bind team, workspace,
  boot/restore, owner/socket, generation, artifact, capability and signed-v4 manifest identities.
- The shared HMAC is documented as cross-process integrity, not exclusive product authorship.
- No production gate, artifact lock, route catalog, dependency or other repository is modified.

## Focused checks

```text
pnpm exec vitest run test/features/team-approvals/hosted/HostedApprovalRuntimeActivation.test.ts test/main/composition/hosted/hostedApprovalProductionActivation.test.ts test/main/composition/hosted/hostedLifecycleProductionOwnerAdmission.test.ts src/main/services/team/provisioning/__tests__/HostedApprovalRuntimeAdmissionPublisher.test.ts src/main/services/team/provisioning/__tests__/HostedApprovalRuntimeLifecycleCoordinator.test.ts test/architecture/hosted-web/approval-production-unmounted.test.ts
pnpm typecheck
pnpm lint:fast:files -- <changed TypeScript paths>
pnpm exec prettier --check <changed text paths>
git diff --check
```

Run exact ownership and classified secret/private-path scans.

## Stop and handoff

Stop on stale phase authority, path overlap, need for an undeclared path, unclear orchestrator
contract, missing exact artifact evidence, real-project pressure, or a request to enable production.
Do not commit, push, integrate, launch, or activate from the worker.

The handoff reports the traced authority chain, changed-path decision, exact checks,
negative controls, complete self-review, blockers, and the smallest reviewer action. End `HOLD`.
