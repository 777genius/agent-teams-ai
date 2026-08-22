# P3.A: product actual-owner binding closure

- Packet revision: `phase-03-actual-owner-closure-r1`.
- Role: one bounded product producer.
- Depends on: exact green PR #252 phase head.
- Result: `verified | blocked | failed`; terminal state always `HOLD`.
- A verified zero-code result is allowed.

## Mission

Determine whether the current product already has the complete production binding needed by the
orchestrator's two-phase actual-owner startup. Implement only a demonstrated missing product seam.
Do not create a parallel lifecycle authority merely because an existing compatibility coordinator is
uncomposed.

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

1. `src/main/composition/team/createProductTeamProvisioning.ts`
2. `src/main/services/team/provisioning/HostedApprovalRuntimeProductionLifecycleBoundary.ts`
3. `src/main/services/team/provisioning/HostedApprovalRuntimeProductionComposition.ts`
4. `src/main/services/team/provisioning/__tests__/HostedApprovalRuntimeProductionComposition.test.ts`
5. `test/main/composition/team/createProductTeamProvisioning.test.ts`
6. `test/architecture/hosted-web/approval-production-unmounted.test.ts`

All other paths are read-only. Missing test path 5 may be created only if production composition
behavior genuinely changes; do not create it for a zero-code result.

## Decision order

1. Trace signed-v4 owner admission from validated bootstrap input to per-team approval authority.
2. Trace owner loss, replacement, restart, shutdown and confirmed-absence behavior.
3. Compare the product contract to the orchestrator two-phase handoff.
4. State the concrete missing invariant, if any, before editing.
5. If every invariant is already present, run the checks and return a zero-code verification.
6. Otherwise implement the smallest change inside exact ownership and add a focused regression test.

## Acceptance and negative controls

- Active approval routes originate only from exact launcher-signed v4 admission.
- Provisioning, restart-required, v2/v3, empty, malformed and stale inputs remain unmounted.
- The scalar lifecycle coordinator is neither trusted admission nor a route catalog producer.
- Evidence-bearing owner leases are single-use and lifecycle-exact; missing or mismatched evidence
  confirms absence.
- Owner loss/shutdown cannot race a later transition back into active state.
- No current-team, workspace file, ambient process, mutable tag, raw socket, or unsigned fallback is
  added.
- No production gate, artifact lock, route catalog, standalone startup, dependency or other repository
  is modified.

## Focused checks

```text
pnpm exec vitest run src/main/services/team/provisioning/__tests__/HostedApprovalRuntimeProductionComposition.test.ts test/main/composition/team/createProductTeamProvisioning.test.ts test/architecture/hosted-web/approval-production-unmounted.test.ts
pnpm typecheck
pnpm lint:fast:files -- <changed TypeScript paths>
pnpm exec prettier --check <changed text paths>
git diff --check
```

When the optional composition test does not exist and no code change needs it, omit only that file
from the Vitest command and record why. Run exact ownership and classified secret/private-path scans.

## Stop and handoff

Stop on stale phase authority, path overlap, need for an undeclared path, unclear orchestrator
contract, missing exact artifact evidence, real-project pressure, or a request to enable production.
Do not commit, push, integrate, launch, or activate from the worker.

The handoff reports the traced authority chain, zero-code or changed-path decision, exact checks,
negative controls, complete self-review, blockers, and the smallest reviewer action. End `HOLD`.
