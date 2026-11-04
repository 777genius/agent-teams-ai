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
- Agent Runtime main `4e12b68b751d0b6fbb1e629235f789d01aa910b2`:
  [readiness register](https://github.com/agent-teams-ai/agent-runtime/blob/4e12b68b751d0b6fbb1e629235f789d01aa910b2/docs/architecture/readiness.md)
  accepts an interactive contract but **not** a production Host or the required end-to-end interactive adapter.
- Provider implementation Draft PR #1 `7573a50842c3eeacb473f9d97d40f3ddf6ac0cf9`
  is a separate provider Session SPI source, **not** proof that OpenCode V2 works in the Host.
  [V2's separate qualification plan](opencode-v2-host-integration.md) governs V01–V08.

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
| M11 | Activity, gaps and subagents        | —                       | requires new capability | Exact source IDs, ordered observations and parent/child custody             |
| M12 | Structured TaskRef / navigation     | requires new capability | —                       | Desktop projection retained; imported external ref keeps old owner          |
| M13 | Git change capture and review       | requires new capability | requires new capability | Real before/final/failed attribution; no synthetic changes ledger           |
| M14 | Usage, context and quick actions    | requires new capability | requires new capability | Unknown usage stays unknown; action keeps original owner                    |
| M15 | Provider management and auth        | —                       | requires new capability | Private credentials, selected native profile and supported versions         |
| M16 | Archive, import and relaunch        | requires new capability | requires new capability | Old obligations retained; archive read-only and new run only on relaunch    |
| M17 | Packed native delivery and OS       | requires new capability | requires new capability | Exact candidate tuple, owned process exit and scoped cleanup                |
| M18 | IPC/HTTP, feeds and Quit            | requires new capability | requires new capability | Keep existing public Desktop API; immutable routing and no rollback replay  |
| M19 | Background registry/process stop    | requires new capability | requires new capability | Captured TEST child only; stale binding cannot cause OS kill                |

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
