# PR #252 five-file base-conflict resolution lane

## Authority and provenance

- Phase/node: `phase-01` / `PR252-base-conflict-resolution`
- Lane ID: `pr252-base-conflict-resolution`
- Packet revision: `phase-01-pr252-target-binding-correction-r1`
- Durable controller: `controller-v17`; it must remain the same identity and exactly `live=true`
- Stable target binding: `canonicalAtProducerAdmission`, resolved exactly once immediately before
  producer admission
- PR source: `origin/refactor/team-provisioning-round2-reapply`, pinned to
  `7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0`
- Capacity: exactly one producer followed by exactly one independent integration reviewer
- Producer and reviewer configuration: reasoning effort `xhigh`, service tier `default`, Fast disabled
- Terminal state for this docs router: `HOLD`

The earlier r1 worker is terminal `failed_no_output`: it authored no output and supplies no bytes,
state, or authority. The prior packet hardcoded a future target before its own policy integration and
is superseded. This target-binding-correction revision is the worker's only authorized replacement.
Never inspect, resume, or reuse the worker or the superseded packet.

P1.1D is already independently accepted and policy-integrated. The binding formal review was
`FORMAL ACCEPT` with P0/P1/P2 findings `0/0/0` by
`agent-teams-hosted-web-refactor-p1-1d-shadowed-map-review-v17-r4`. Its strict result SHA-256 is
`be0c9abd679f817c386d1d06d1b738c2a1505bb3c4718279129ab74842c98fa6`, reviewed output ID is
`f3394026185348c84673d44a9b30a82667c3ff9435b5d4d7609c04785c274f41`, accepted integration is
`p1-1d-shadowed-map-r4-accepted-integration-v3`, and its accepted/pushed P1.1D commit was
`e7e7e734c82c49105682e7a19bbedafa1f5ddbad`. Those facts are immutable historical provenance, not a
target binding or work to rerun or reinterpret.

## JIT canonical binding and mission

`canonicalAtProducerAdmission` means the exact current canonical commit after this correction router
has been accepted, policy-integrated, and pushed. No product worker may start before those steps
finish. Immediately before producer admission, `controller-v17` resolves the binding exactly once to
a full commit SHA and binds that same value into `canonicalSha`, `phaseStartSha`, `baseSha`, producer
materialization `HEAD`, `planBundleCommit`, `expectedTargetCommit`, reviewer materialization,
`mark_reviewed` merge metadata, and the integration target. The value is not guessed in this packet
and is never independently re-resolved downstream.

Against that resolved target, create one immutable resolution patch. The patch changes exactly the
five conflict paths below and resolves every one byte-for-byte to the blob from the pinned PR source
commit. It adds no authored product behavior and performs no merge, commit, push, integration, or
staging operation.

The producer may not choose a conflict side, combine hunks, reformat, regenerate, or make a semantic
edit. A missing source object, blob mismatch, unexpected conflict, required-check failure, extra path,
unequal resolved target field, or canonical drift fails closed and returns to `controller-v17`.

## Exact mandatory reads

Read only these documents, in order, before the five target/source blob reads. Directory reads,
globs, implicit siblings, recursive documentation/research reads, and r1 reads are not authorized:

1. `AGENTS.md`
2. `docs/hosted-web-phases/START_HERE.md`
3. `docs/hosted-web-phases/EVIDENCE_LIFECYCLE.md`
4. `docs/hosted-web-phases/README.md`
5. `docs/hosted-web-phases/EXECUTION_INDEX.json`
6. `docs/hosted-web-phases/phase-01/controller-packet.md`
7. `docs/hosted-web-phases/phase-01/lanes/pr252-base-conflict-resolution.md`
8. `CLAUDE.md`
9. `AGENT_CRITICAL_GUARDRAILS.md`
10. `docs/hosted-web-phases/PACKET_STANDARD.md`

All mandatory documents, the resolved target commit, and the pinned source commit are read-only. The
runtime/controller must materialize the resolved target and pinned source commit. The producer must
not fetch, advance the source branch, or substitute the current remote-tracking ref when the pinned
object is unavailable.

The stable launch collections are explicit: `mandatoryScripts: []` and `mandatoryFixtures: []`.
`ownedPaths` is the five-path table below, `requiredChecks` is the non-empty command/gate set below,
and `executionPolicy` is sandbox-only with network/fetch, app/runtime/team launch, real-project
access, staging, merge, commit, and push disabled. No empty collection is permission to discover a
sibling.

## Exact exclusive producer scope and source blobs

The following ordered list is the complete producer `ownedPaths` collection and the complete allowed
merge-conflict set. Each final file must have the listed full Git blob OID from source commit
`7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0`:

| Path                                                                          | Required source blob OID                   |
| ----------------------------------------------------------------------------- | ------------------------------------------ |
| `src/features/task-board-commands/core/application/TaskBoardCommandFacade.ts` | `f5515ddac4cd7bee957a75bc06aad78309ad3a74` |
| `src/main/services/team/TeamDataService.ts`                                   | `a8fea50ddbd71563f2ab7853978d6420eed6c441` |
| `src/renderer/components/team/TeamDetailView.tsx`                             | `5cbaef7f23046dab598a1c2878811adbfd62ea4c` |
| `test/features/task-board-commands/TaskBoardCommands.e2e.test.ts`             | `0c0a717fea61031c3c24a4ef787c0acd9bd80ad5` |
| `test/main/services/team/TeamDataService.test.ts`                             | `c281cac6493e07abf1ddd201255539e902122af2` |

For this packet, “source/base content” means the complete bytes stored by these five blobs at the
pinned PR source commit. It does not mean the corresponding blob at the resolved
`canonicalAtProducerAdmission` target.

Every other tracked or untracked path is read-only. There is no repository handoff, review note,
research result, generated file, lockfile, configuration file, runtime file, or orchestration output
in the writer set. The runtime captures the exact five-path diff as the immutable producer output.

## Producer procedure and immutable output

The producer must:

1. receive a rendered admission contract in which `canonicalSha`, `phaseStartSha`, `baseSha`,
   materialization `HEAD`, `planBundleCommit`, and `expectedTargetCommit` are the same full SHA
   resolved once from `canonicalAtProducerAdmission`;
2. prove its `HEAD` and all those target fields equal both that resolved SHA and current canonical
   before the first edit;
3. prove the pinned source commit and all five required source blob OIDs are available without a
   fetch or moving-ref substitution;
4. replace each owned path with the complete bytes of its corresponding pinned source blob;
5. prove the worktree diff contains exactly all five owned paths, with no sixth path and nothing
   staged;
6. rerun every required check and full-blob verification below; and
7. return a runtime-owned immutable output for independent review, with explicit P0/P1/P2 counts and
   `nextAction: "integration-review"`.

The immutable output must bind the resolved full target SHA, source remote/branch/commit, ordered
five-path scope, five expected and observed blob OIDs, exact diff, check results, typecheck-baseline
classification, safety classifications, and proof that producer merge/commit/push/stage operations
were not performed. Missing, ambiguous, mutable, partial, or symbolically unresolved output is not
reviewable.

## Focused and quality checks

Run each check independently from the producer worktree and again from the independent review
worktree where the runtime materializes the immutable output:

```bash
pnpm exec vitest run test/features/task-board-commands/TaskBoardCommands.e2e.test.ts
pnpm exec vitest run test/main/services/team/TeamDataService.test.ts
pnpm typecheck
pnpm lint:fast:files -- src/features/task-board-commands/core/application/TaskBoardCommandFacade.ts src/main/services/team/TeamDataService.ts src/renderer/components/team/TeamDetailView.tsx test/features/task-board-commands/TaskBoardCommands.e2e.test.ts test/main/services/team/TeamDataService.test.ts
pnpm exec prettier --check src/features/task-board-commands/core/application/TaskBoardCommandFacade.ts src/main/services/team/TeamDataService.ts src/renderer/components/team/TeamDetailView.tsx test/features/task-board-commands/TaskBoardCommands.e2e.test.ts test/main/services/team/TeamDataService.test.ts
git diff --check
git status --short
```

The two focused test files, lint, Prettier, and diff checks must pass. `pnpm typecheck` inherits only
the accepted baseline of exactly seven unchanged Phase 0 diagnostics in these three files:

- `test/architecture/hosted-web/phase-0/auth-artifacts/auth-artifacts-spike.test.ts`: TS7016 at
  25:8; TS7031 at 66:31; TS18046 at 117:68; TS7031 at 413:48; TS7031 at 733:10;
- `test/architecture/hosted-web/phase-0/host-primitives/evidence-scanner.test.ts`: TS7016 at 12:8;
  and
- `test/architecture/hosted-web/phase-0/provider-runtime/scan-runtime-surfaces.test.ts`: TS2352 at
  162:44.

Any new, removed, moved, or changed diagnostic, or any diagnostic in an owned path, fails the lane.

The producer and reviewer must additionally verify the exact five-path diff, all five complete Git
blob OIDs, an empty staged diff, textual content, and no credentials, secrets, auth/provider payloads,
private/user/real-project locations, or raw command/runtime bodies. Scan only the exact five paths;
classify every match and fail on any unsafe value. Do not run the app, Electron, browser mode, a
server, a provider/runtime, a team, or a real project.

## Independent xhigh integration review

After producer completion, `controller-v17` may admit exactly one fresh reviewer at reasoning effort
`xhigh`, service tier `default`, with Fast disabled and `reviewKind: integration`. The reviewer must
be independent of this router author, the producer, every P1.1D producer/reviewer, and any prior PR
#252 conflict worker. The reviewer has no repository writer, merge, commit, push, stage, repair, or
producer-refill authority.

The reviewer independently materializes the immutable producer output against the same resolved full
`canonicalAtProducerAdmission` SHA; no second canonical resolution is permitted. It proves all
concrete target fields still equal current canonical, reruns every check, verifies the exact five-path
conflict set and full-blob mapping, and returns one explicit `ACCEPT` or `REJECT` with complete
P0/P1/P2 findings. `ACCEPT` is legal only with P0/P1/P2 `0/0/0` and complete green evidence.
Blocked, incomplete, ambiguous, or missing output is not acceptance.

## Reviewed merge binding and runtime integration

Only after independent `ACCEPT`, `mark_reviewed` must bind the immutable reviewed output ID to this
exact merge identity, with the controller rendering the already-resolved full SHA rather than the
explanatory placeholder:

```json
{
  "sourceRemote": "origin",
  "sourceBranch": "refactor/team-provisioning-round2-reapply",
  "sourceCommit": "7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0",
  "expectedTargetCommit": "<resolved canonicalAtProducerAdmission full SHA>"
}
```

`open_integration_attempt` then consumes only `reviewedOutputId`. It must not accept duplicated or
overridden source/target fields. Runtime chooses no DAG or branch and performs no target resolution.
It resolves the reviewed binding, verifies every concrete canonical/base/start/materialization/
review/merge/integration target field equals both the single stored
`canonicalAtProducerAdmission` value and current canonical, and fails closed on any drift. It then
recreates the merge from the two pinned commits, proves that the complete conflict set is exactly the
five owned paths, applies only the reviewed resolution bytes, reruns the required checks, and creates
the true two-parent merge.

The final merge must have parents, in order, `[resolved canonicalAtProducerAdmission,
7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0]`. Its tree must resolve the five paths to the five required
blob OIDs above, and no non-conflict path may differ from the true merge result. A synthetic
one-parent commit, patch-only commit, squashed commit, reversed parent order, moving source head,
missing/extra conflict, target drift, or blob mismatch fails integration.

The runtime-created merge must pass review/integration validation and be pushed before authority can
advance. The producer and reviewer never perform that merge, commit, or push.

## Stop conditions and HOLD

Stop and return to `controller-v17` on a stale/mixed or multiply resolved target, unavailable pinned
source, source blob mismatch, non-live/replaced controller, r1 or superseded-packet access, second
producer/reviewer, Fast mode, non-default service tier, non-xhigh reasoning, extra/missing conflict or
changed path, staged file, unsafe value, binary, required-check drift/failure, producer/reviewer merge
or Git write, canonical drift, unresolved/non-full SHA field, unequal target fields, runtime DAG/branch
choice, or an integration attempt that accepts anything other than the reviewed output ID.

P1.R2, P1.I, P1.F, and Phase 2+ remain blocked until the validated two-parent merge is pushed. This
docs router launches no producer, reviewer, controller, or integration attempt and performs no fetch,
stage, commit, merge, or push. End `HOLD`.
