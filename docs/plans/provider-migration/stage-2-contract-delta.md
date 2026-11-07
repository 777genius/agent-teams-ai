# Stage 2 — S2.0 consumer contract delta (4 November 2026)

Status: **source/readiness audit, not integration or E2E acceptance**. This records only
the existing app operations which new Orchestrator and Agent Runtime implementations
must satisfy; it does not prescribe their internal storage or transport design.

Exact reviewed sources:

- Stage 1 Desktop contract: [`operations.ts`](https://github.com/777genius/agent-teams-ai/blob/999c468e3f4f09a5e5eb1655f6b97a64e046c55e/src/features/agent-backend/contracts/operations.ts);
  [`BackendOwnerRouter`](https://github.com/777genius/agent-teams-ai/blob/999c468e3f4f09a5e5eb1655f6b97a64e046c55e/src/features/agent-backend/main/application/BackendOwnerRouter.ts).
- Orchestrator main `981dd836ca3d35b764561bdc11dc2e0544d83416`:
  [README/status](https://github.com/agent-teams-ai/agent-teams-orchestrator/blob/981dd836ca3d35b764561bdc11dc2e0544d83416/README.md)
  explicitly identifies architecture definition, not a qualified Team/Task/Message production service.
  **Upstream correction (5 Nov 2026):** Orchestrator `main` advanced to
  [`b33005a53792`](https://github.com/agent-teams-ai/agent-teams-orchestrator/commit/b33005a537928eb28a8d2c66944f1ff2aacc4161)
  through merged [PR #95](https://github.com/agent-teams-ai/agent-teams-orchestrator/pull/95).
  This corrects only existing sandbox-manifest PostgreSQL checked-out client
  release custody; six typed deterministic regression cases and the actual
  PostgreSQL restart/disconnect fixture passed on PR HEAD `9c5bb87a4295` in
  [Architecture CI](https://github.com/agent-teams-ai/agent-teams-orchestrator/actions/runs/41940145482)
  with Node 24, macOS and Windows checks. Separate `main` push
  [Architecture](https://github.com/agent-teams-ai/agent-teams-orchestrator/actions/runs/41941309167)
  and [Docs](https://github.com/agent-teams-ai/agent-teams-orchestrator/actions/runs/41941309660)
  must be judged on their own results. Later ReviewRouter attempts on the final
  PR revision were incomplete, not an independent final-head approval.
  Neither this sandbox fix nor its CI qualifies a production Team/Task/Message
  writer, OD-035/OD-040, or any M01–M19 target-core replacement.
  **Authoritative gate refresh (6 Nov 2026):** Orchestrator
  [`main=a34587b313e6`](https://github.com/agent-teams-ai/agent-teams-orchestrator/commit/a34587b313e656eeb43d755b4a4f08c40dff2116)
  now has owner-accepted [ADR-0116](https://github.com/agent-teams-ai/agent-teams-orchestrator/blob/a34587b313e656eeb43d755b4a4f08c40dff2116/docs/decisions/0116-native-temporal-for-fully-local-durable-workflows.md):
  **OD-035 is resolved** (full native Temporal with PostgreSQL), not an open
  engine-selection fork. [OD-021](https://github.com/agent-teams-ai/agent-teams-orchestrator/blob/a34587b313e656eeb43d755b4a4f08c40dff2116/docs/open-decisions/OD-021-local-supervisor-lifecycle-and-distribution.md)
  and [OD-040](https://github.com/agent-teams-ai/agent-teams-orchestrator/blob/a34587b313e656eeb43d755b4a4f08c40dff2116/docs/open-decisions/OD-040-fully-local-package-materialization.md)
  remain open, and all five broad production implementation gates remain
  `In review`. Accepted engine choice is **not** implemented/qualified Host,
  native packaging, owner-approved materialization or Desktop M01–M19 parity;
  see the factual [Issue #96 gate correction](https://github.com/agent-teams-ai/agent-teams-orchestrator/issues/96#issuecomment-6684998577).

  **Follow-up (5 Nov 2026):** [Orchestrator PR #97](https://github.com/agent-teams-ai/agent-teams-orchestrator/pull/97)
  was squash-merged to `main` as [`5a8496ce7119`](https://github.com/agent-teams-ai/agent-teams-orchestrator/commit/5a8496ce711909e381c5bc817fff5500be9a1761).
  Its one-file ADR-0103 *synthetic* conformance fixture checks Project-isolated
  same-request receipts, foreign Task access, and strict CreateTask payload shape.
  Exact PR HEAD `d575e16158d7` passed
  [Architecture](https://github.com/agent-teams-ai/agent-teams-orchestrator/actions/runs/42043160740),
  [Docs](https://github.com/agent-teams-ai/agent-teams-orchestrator/actions/runs/42043161267),
  and [Dependency Review](https://github.com/agent-teams-ai/agent-teams-orchestrator/actions/runs/42043160684).
  This fixture does **not** create or qualify a production Team/Task/Message API.
- Agent Runtime main `4e12b68b751d0b6fbb1e629235f789d01aa910b2`:
  [readiness register](https://github.com/agent-teams-ai/agent-runtime/blob/4e12b68b751d0b6fbb1e629235f789d01aa910b2/docs/architecture/readiness.md)
  accepts an interactive contract but **not** a production Host or the required end-to-end interactive adapter.
  **Update (5 Nov 2026):** upstream `main` advanced to
  [`92934d718a15`](https://github.com/agent-teams-ai/agent-runtime/commit/92934d718a159dacfa2ef9ca6efbd6d70ce60f9a)
  through [PR #253](https://github.com/agent-teams-ai/agent-runtime/pull/253), qualifying
  fail-closed PostgreSQL interactive-session `CHECK` validation (exact-head CI and
  independent review). The prior public Host readiness classification does
  **not** change; this is not a new-core runtime adapter or V2 E2E pass.
  **Further durability follow-up (5 Nov 2026):** [Runtime PR #254](https://github.com/agent-teams-ai/agent-runtime/pull/254)
  was squash-merged to `main` as [`ab0387c02fe7`](https://github.com/agent-teams-ai/agent-runtime/commit/ab0387c02fe75ed0c9bb456caaad9a6d2723795b).
  It holds PostgreSQL checked-out client custody through release and preserves
  operation `UNKNOWN` without replay after a lost COMMIT acknowledgment;
  a disposable PostgreSQL 18 fixture read back the original committed record.
  Exact PR HEAD `413f601b4692` passed
  [full CI](https://github.com/agent-teams-ai/agent-runtime/actions/runs/41972656175),
  [Node 24/26](https://github.com/agent-teams-ai/agent-runtime/actions/runs/41972656038),
  and [Docs](https://github.com/agent-teams-ai/agent-runtime/actions/runs/41972656582).
  This **does not** qualify an interactive production Host or any M01–M19 new-core parity.
  **Admitted-boundary follow-up (7 Nov 2026):** [Runtime Draft #258](https://github.com/agent-teams-ai/agent-runtime/pull/258)
  at exact HEAD [`c70f90bd04fc`](https://github.com/agent-teams-ai/agent-runtime/commit/c70f90bd04fc2e14219ecb80463604812fa8e315)
  rejects missing, accessor/proxy and replaced HTTP broker-session methods
  before native ingress; it captures tested callables but **does not**
  authenticate the owners or attach a production route, resolver, evidence
  store or credentialed interactive Host. [Full CI #42372257164](https://github.com/agent-teams-ai/agent-runtime/actions/runs/42372257164)
  completed SUCCESS after **one targeted AE3 retry** (1,566 PASS / 0 FAIL /
  13 SKIP on the retried job); [Node 24/26](https://github.com/agent-teams-ai/agent-runtime/actions/runs/42372257106)
  and [trusted Docs](https://github.com/agent-teams-ai/agent-runtime/actions/runs/42372257410)
  completed SUCCESS on that HEAD. The original AE3 25-ms deadline failure
  remains unrooted; independent review is INCOMPLETE 0/2 and CodeQL has no
  confirmed receipt. #258 stays Draft; the selected Docker/Linux Codex route
  registry tuple is **not** production broker-session composition or Desktop
  S2.1/M01–M19 parity.
- Provider implementation Draft PR #1 `7573a50842c3eeacb473f9d97d40f3ddf6ac0cf9`
  is a separate provider Session SPI source, **not** proof that OpenCode V2 works in the Host.
  [V2's separate qualification plan](opencode-v2-host-integration.md) governs V01–V08.

**Implementation-route precision (6 Nov 2026, current Runtime main):**
[Runtime `f990acc26e1b`](https://github.com/agent-teams-ai/agent-runtime/commit/f990acc26e1b8071ae22d0b87a2ddd3672be8e2e)
[readiness](https://github.com/agent-teams-ai/agent-runtime/blob/f990acc26e1b8071ae22d0b87a2ddd3672be8e2e/docs/architecture/readiness.md)
registers one narrowly **implementation-qualified** Docker/Linux Codex enforced-network-route
tuple (`@openai/codex@0.153.4`, Linux x64) for *Contained Agent Turn V1*.
That registration is not a runnable or deployment-qualified interactive Host:
no kernel route is installed by the registry row, no live credentialed turn is
proved, and the `ids`, `resolver` and `evidence` broker-session ports still
lack production owners, so the composition root cannot mint the required
route-enforcement capability. Every unqualified tuple fails closed; Claude
explicitly refuses while its broker seam is absent. The one registered tuple
must **not** change S2.1/M02/M04/M06–M09/M15/M17–M19 from
`requires new capability` or authorize an adapter or owner cutover.

Classification vocabulary: **exact-compatible** means actual unchanged behavior at the
specified Stage 1 boundary, **translated** means a proven semantic adapter could
preserve it without new product rules, **requires new capability** means no currently
qualified owning API, and **incompatible** means the proposed mapping must refuse
until an explicit protocol/semantic migration is qualified. The two target columns
refer to target **production** capability, not to accepted ADRs, schemas, synthetic
fixtures or implementation intent. An em dash means that particular target does not
own the behavior.

## Operation-level delta against M01–M19

| ID  | Consumer operation (Stage 1 oracle) | Orchestrator main       | Agent Runtime main      | Required boundary-level negative or positive proof                          |
| --- | ----------------------------------- | ----------------------- | ----------------------- | --------------------------------------------------------------------------- |
| M01 | Team roster, lifecycle, purge       | requires new capability | —                       | Preserve original handle, identity-fenced purge and unresolved cleanup debt |
| M02 | Launch and individual readiness     | requires new capability | requires new capability | Partial bootstrap must not create duplicate sessions after lost handoff     |
| M03 | Task CRUD, review, dependencies     | requires new capability | —                       | Single Team writer; CAS/grant and idempotency at mutation commit            |
| M04 | Inbox, DM and native delivery       | requires new capability | requires new capability | Commit and admission distinct; lost ACK does not deliver twice              |
| M05 | Group and cross-Team messages       | requires new capability | —                       | Same-owner recipients only; no implicit cross-owner bridge                  |
| M06 | Approvals, questions, replies       | requires new capability | requires new capability | Team review authority distinct from runtime permission; stale reply denies  |
| M07 | Interrupt, stop and close           | requires new capability | requires new capability | Targeted generation/control; never kill shared or foreign child             |
| M08 | Inputs, UNKNOWN and reconcile       | requires new capability | requires new capability | Durable intent before handoff; no replay or false rejection                 |
| M09 | Selected-session cold resume        | —                       | requires new capability | Exact checkpoint/engine/account/custody; V1→V2 is incompatible              |
| M10 | Instructions, compaction, skills    | requires new capability | requires new capability | One reminder owner; settings and MCP policy must not disappear              |
| M11 | Activity, gaps and subagents        | requires new capability | requires new capability | Authorized Activity/gap projection and provider subagent provenance         |
| M12 | Structured TaskRef / navigation     | requires new capability | —                       | Desktop projection retained; imported external ref keeps old owner          |
| M13 | Git change capture and review       | requires new capability | requires new capability | Real before/final/failed attribution; no synthetic changes ledger           |
| M14 | Usage, context and quick actions    | requires new capability | requires new capability | Unknown usage stays unknown; action keeps original owner                    |
| M15 | Provider management and auth        | —                       | requires new capability | Private credentials, selected native profile and supported versions         |
| M16 | Archive, import and relaunch        | requires new capability | requires new capability | Old obligations retained; archive read-only and new run only on relaunch    |
| M17 | Packed native delivery and OS       | requires new capability | requires new capability | Exact candidate tuple, owned process exit and scoped cleanup                |
| M18 | IPC/HTTP, feeds and Quit            | requires new capability | requires new capability | Keep existing public Desktop API; immutable routing and no rollback replay  |
| M19 | Background registry/process stop    | requires new capability | requires new capability | Captured TEST child only; stale binding cannot cause OS kill                |

M11 owner split: accepted ADR-0103 assigns normalized, authorized Activity,
cursor/gap projection and protected diagnostics to Orchestrator **Execution
Observation**. Agent Runtime separately owns provider output, technical event
origin and parent/child subagent provenance. Neither owner's partial feed
satisfies both contracts or qualifies the Stage 2 Desktop Activity E2E.

**Upstream sandbox implementation (not production target qualification):**
[Orchestrator PR #85](https://github.com/agent-teams-ai/agent-teams-orchestrator/pull/85)
HEAD [`07c13f00`](https://github.com/agent-teams-ai/agent-teams-orchestrator/commit/07c13f00cc9f9a9ba554fb2d30ccf50a525ecd0e)
contains a real Execution Observation PostgreSQL Activity writer, scoped runtime
binding, read cursors, and native PostgreSQL restart/RLS/disconnect tests.
Its stacked [Draft PR #98](https://github.com/agent-teams-ai/agent-teams-orchestrator/pull/98)
HEAD [`7e82c79d`](https://github.com/agent-teams-ai/agent-teams-orchestrator/commit/7e82c79dbc0584367b963389d7bfcd6c3cba9459)
preserves release-time UNKNOWN and same-source reconciliation.
Its [later dual-source native PostgreSQL 16 run #42270503091](https://github.com/agent-teams-ai/agent-teams-orchestrator/actions/runs/42270503091)
completed **56/56 PASS**: Node 24 and 26 each checked the direct PR HEAD
(`7e82c79d`) and the separately verified two-parent synthetic merge
(`605b4bd2`), 14 tests per matrix job with zero failures/skips.
[Architecture #42270503012](https://github.com/agent-teams-ai/agent-teams-orchestrator/actions/runs/42270503012)
completed 4/4 SUCCESS on the same branch revision.
These are **sandbox-only**, not real Team/Runtime/Desktop production qualifications;
trusted Docs failed on the incompatible physical package closure, and the
required independent exact-head reviews remain incomplete. The earlier
[PostgreSQL 16 run](https://github.com/agent-teams-ai/agent-teams-orchestrator/actions/runs/42209266274)
(14/14 on Node 24 and 26) tested a **synthetic merge tree** `19ab5e20`,
not direct HEAD `fde0a320`; do not relabel it exact-head evidence.
The later [native PostgreSQL 16 run](https://github.com/agent-teams-ai/agent-teams-orchestrator/actions/runs/42235338210)
checked out the **actual PR head** `c2099ff572cb29af07fc0993751aea9dcafb63d8`
and independently passed 14/14 on each of Node 24/26 with zero failures/skips.
All four [Architecture jobs](https://github.com/agent-teams-ai/agent-teams-orchestrator/actions/runs/42235338328)
also passed on that revision. These prove **bounded sandbox regression**
only, not an integrated #85/main merge, production Team/Runtime owner API
or Desktop M01–M19 parity. The [mandatory trusted Docs Protocol](https://github.com/agent-teams-ai/agent-teams-orchestrator/actions/runs/42235338999)
still **failed** because the lock includes two physical
`@agent-teams/repository-mutation` resolutions (`0.2.2` / `0.4.0`).
The central [Docs Cohort qualification issue #415](https://github.com/agent-teams-ai/.github/issues/415)
tracks a compatible five-package closure; published package-version candidates
are not themselves a qualified Cohort. Reverting the EF `2.1.0` pin alone
is not proven compatible with the PR's schema-v3 protobuf source-coverage gate.
The stacked-base commit-identity check also fails until integration against
the live default branch. The parent #85 is nonmergeable against current
Orchestrator `main=a34587b3`; 19 files were touched by both branches since
the parent's recorded base (not a claim of 19 textual conflict hunks). A
fresh `main...#85` ancestry comparison on 7 Nov 2026 was **40 commits ahead /
7 behind**, while GitHub still reported `mergeable=false`; neither a
previous 0-behind comparison against the stale PR base nor a green stacked
native PostgreSQL receipt qualifies the parent for merge.
Independent final-head review and CodeQL are not confirmed.
Preserve the single intended M11 Activity writer, reconcile the **whole**
qualified Docs cohort and current-main source first, then prove complete
Runtime provider/subagent provenance, authority and Desktop native/packed
E2E before changing M11 from `requires new capability`.

**Consumer classification:** the existing Desktop `AgentBackendApi`, selected
`BackendHandle`, and retained-handle routing are **exact-compatible at the
Stage 1 source boundary**, not yet proven with the new cores. A future Orchestrator
Team adapter and Agent Runtime session adapter are **translated** candidates only
after their owners publish implementations and pass semantic conformance. No row
above is qualified as an end-to-end target-core replacement. In M09, silently
treating a V1 checkpoint as a V2 native resume is **incompatible**.

## Critical S2.0 boundary: bound Host transport is not a generic owner port

**Confirmed in Stage 1 source** (`999c468`):

- [`backendBinding.ts`](https://github.com/777genius/agent-teams-ai/blob/999c468e3f4f09a5e5eb1655f6b97a64e046c55e/src/features/agent-backend/main/application/backendBinding.ts)
  permits only `StoredBackendBinding.schemaVersion = 1`, which requires
  `profileId`, `buildId`, `protocolVersion = 1`, `nodeSha256`,
  `hostEntrySha256` and absolute `storageRoot`.
- [`BackendOwnerRouter.ts`](https://github.com/777genius/agent-teams-ai/blob/999c468e3f4f09a5e5eb1655f6b97a64e046c55e/src/features/agent-backend/main/application/BackendOwnerRouter.ts)
  registers `CapturedBackendOwner` with a concrete `CapturedHostClient`; its
  `request`, `requestPair`, `lookup`, `startOwner` and `shutdownOwner`
  speak Host JSON-RPC and use Host-specific lifecycle/error taxonomy.
- [`loadDesktopBackendDescriptor.ts`](https://github.com/777genius/agent-teams-ai/blob/999c468e3f4f09a5e5eb1655f6b97a64e046c55e/src/features/agent-backend/main/infrastructure/loadDesktopBackendDescriptor.ts)
  accepts only `schemaVersion = 1` and the local Node executable/profile,
  while [`DesktopBackendFeature.ts`](https://github.com/777genius/agent-teams-ai/blob/999c468e3f4f09a5e5eb1655f6b97a64e046c55e/src/features/agent-backend/main/composition/DesktopBackendFeature.ts)
  directly composes legacy Team registry, stopped import and management.

**Classification:** public `BackendHandle` and finite `AgentBackendApi` stay
exact-compatible as consumer surfaces. **Transport ownership and private persisted
owner binding are incompatible with direct use by a remote/new-core client.**
An adapter cannot simply satisfy TypeScript structurally or manufacture Host
`nodeSha256`, `hostEntrySha256` or `storageRoot` to pass validation.

**Required minimal handoff after an actual new-core API exists:**

1. Introduce only the target-owned transport and narrowly versioned persisted
   owner record needed by that API; distinguish local legacy Host from the
   explicitly selected new target, without weakening the existing v1 decoder.
   Reuse an existing standardized identity/custody contract if the core publishes
   one. Do **not** add a generic transport registry or new network protocol.
2. Old v1 records remain immutable and readable by their original Host adapter;
   new records use durable no-clobber publication and an exact target revision.
   Unknown/new schema, altered target identity or revoked authority results
   in HOLD, never a rebind to the current default.
3. Prove a mixed-target test with retained v1 A and newly created target B,
   then default switch, rollback, two new intents, lookup, restart, corrupt/foreign
   binding, lost ACK and concurrent creation. Verify effects only at their own
   owner, not merely successful return values. Keep old Host lifecycle closed
   around its own captured process without killing target B.
4. Only then translate specific Team and Runtime operations at their owning
   adapter; preserve existing public UI contracts and separately qualify
   `DesktopBackendFeature` registry/creation/management paths. Core adoption
   must not rely on a fabricated Host JSON-RPC server.

This is a **newly identified interface gap**, not a new implementation or
proof that the above tests passed.

## Current regression oracle versus missing new-core proof

| Gate | Existing Stage 1 source evidence | Additional target proof still needed |
| --- | --- | --- |
| Stable owner after new default/rollback | `test/features/agent-backend/backendOwnerRouter.test.ts` | Run unchanged tests against actual two-owner adapters with retained A and fresh B, then rollback |
| Concurrent bind / missing or corrupt record | Same owner-router tests | Native recovery with real new owner store; never select default for missing or UNKNOWN |
| Lost response and stale authorization | Owner-router tests plus `hostProductLifecycle.test.ts` | Real accepted/UNKNOWN receipts; zero additional side effects after the original admitted attempt, no stale grants or replay |
| Cross-owner recipient / TaskRef | `hostTeamRouting.test.ts` and existing TaskRef tests | Explicit incompatible cross-owner DM/TaskRef refusals, no legacy relay or second writer |
| Cold resume / history continuity | `checkpointAvailability.test.ts`, `restoreIntents.test.ts` and prior Stage 1 native receipts | Exact new-runtime native session, history prefix, storage/custody and failed-version negatives |
| Background process / physical stop | Existing Stage 1 M19 native and UI receipts | Captured target-core process identity, real stop/readback and foreign/shared-child survival |
| Desktop/packaged product journey | Stage 1 M01–M19 candidate-synthetic acceptance | Re-run normal Create/Launch/Resume/Tasks/DM/review/Quit/packed UI against **new** composition on selected tuples |

The listed tests are **existing oracles**, not new executions or evidence that the
new cores pass. No new test names are invented, and no duplicate test harness is
required before an implementation exists.

## Minimum adapter qualification order

1. **Owning upstream code:** Orchestrator must expose a real versioned Team/Task/
   Message/Review mutation and read contract; Agent Runtime must expose its real
   interactive session/input/control/checkpoint/custody contract. Qualify each in
   its owning repository with disposable TEST fixtures, negative authority/
   concurrency/restart cases and exact artifact revisions.
2. **Consumer adapter:** implement only an actual available public operation
   behind the existing ports. Bind owner, generation, command/input identity and
   required capabilities before the first effect. A missing capability causes
   explicit HOLD, not an adapter stub, V1 fallback or a second writer.
3. **New composition proof:** first prove one selected TEST session's
   open/submit/observe/stop/readback and one single-owner Team mutation. Then
   expand to all M01–M19, V01–V08 for V2, native processes, multiple OS tuples
   and packaged Electron. Record genuine refs, logs and artifact receipts.
4. **Retained data:** a retained handle, including a handle with an operation
   whose outcome is UNKNOWN, remains bound to its recorded owner for lookup,
   reconciliation, stop and subsequent authorized intents. UNKNOWN is the
   *operation outcome*, not a distinct kind of handle. If that owner is
   unavailable, return unavailable/HOLD; never switch to the current default,
   replay the uncertain intent or move work to another owner. Archive import
   is a separate read-only/dry-run exercise; active session adoption,
   model-based cross-version resume and destructive migration are prohibited.

**Stop-ship:** any UNKNOWN input replay; cross-owner mutation or fallback;
unverified V1/V2 plugin/API reuse; credential leakage; stale permission grant;
shared process kill; missing TaskRef/review/backup ownership; unproven native
restore; or misleading E2E PASS. Keep Stage 1 Draft and default activation off
until real target-core qualification, independent review and release decision.
