# PR #982 — G1d: protect OAuth start-field fingerprints and retain one original operation

Status: focused execution qualification completed with the original-cleanup presentation correction and the subsequent reconciliation below; full current-source PR qualification remains pending. The plan was published before G1d production changes. Its reviewed G1c baseline was 606 lines (SHA-256 e11c1629381d4713b8aafef68f7a39fc8b3056ed514c9985fed15c9c444dbd0f).

## Confirmed source problem and public flow

OpenCode V1 auth metadata may contain generic text prompts. The existing Main catalog mapper explicitly marks keys matching key/token/password/secret as secret, and the renderer displays those prompts as password inputs. The submitted metadata flows unchanged to CapturedProviderOAuth.fields and Host native authorizeProviderOAuth.inputs. Therefore every opaque field value is secret-capable; UI naming and a currently empty provider form are not evidence of a nonsecret field.

Two private persisted receipts contain cheap guess checks today:

- Main CapturedProviderOAuth hashes its existing JSON array, including sorted fields, and FileProviderOAuthIntentStore persists the fingerprint.
- Host OAuthOperationOwner.start hashes the canonical complete parsed start command, including fields, before persisting StoredOAuthCommand.

The supported V1 metadata path is source-confirmed. This does not assert that any named stock provider currently requests a password. OpenCode V2 currently exposes API-key options, and its credential witnesses remain the separate G2 investigation.

There is also a confirmed earlier cancellation gap: OpenCode connectProvider awaits capture and catalog before calling oauth.connect; the Claude wrapper awaits target and account read before that call. The renderer already owns the operation ID and sends cancel during those awaits, but Main has no original pending token yet. The plan closes that existing gap using the same Main operation owner rather than documenting it as acceptable.

## Fixed private fingerprint contract

Every freshly admitted OAuth start, including an empty-field start, uses the existing asynchronous bounded G1 scrypt helper. Add optional private fingerprintKdf to both original Main intent and original Host OAuth command, using the existing strict { version: 1, salt: 32 lowercase hex } schema. New records always contain it; only an already validated original record without it uses the old SHA recipe for comparison.

Preserve the two distinct canonical payloads exactly:

- Main: JSON.stringify([...(runtimeId === 'claude' ? ['claude'] : []), originalTargetId, providerId, methodIndex, authOptionId, Object.entries(fields ?? {}).sort(([a], [b]) => a.localeCompare(b))]).
- Host: existing canonicalManagementValue(parsedStart), including original operation/profile/config/provider/method/fields.

Passing the existing Main array to deriveSecretFingerprint preserves its preimage bytes: all members are scalar values or ordered arrays, so the helper's object canonicalization does not alter them. Do not pass an already serialized string and accidentally quote it again.

Main and Host retain their independently scoped original descriptors. No marker or new selector is transmitted in oauth.start. Main still sends exactly its captured operation ID, provider, method and cloned fields to the original captured target; that target adds its fixed profile/config. The fingerprints have never been an interprocess equality join.

Expose the existing helper through one narrow Node-only package subpath. Re-export the existing canonical serializer for direct transient comparisons; do not change its bytes, the KDF implementation, its one-active/eight-waiting/8MiB accounting, fixed parameters, buffer cleanup or constant-time digest comparison. No new crypto implementation, fast secret cache, polling derivation or global salt file.

The Main strict journal allowlist accepts only the optional validated descriptor, copies/freezes that descriptor, keeps the same file mode/size/path and immutable create semantics, and refuses malformed/unknown descriptors. Host storedOAuthCommandSchema validates the new start descriptor independently of completionFingerprintKdf. Public progress, Renderer DTOs and native opaque payloads never expose these markers.

## Main: one pending operation from public request through native handoff

Keep one active operation map. Register a captured token and its single result promise synchronously before the first original-intent read. Exact duplicate inputs join that promise; changed fields, operation identity or captured source context conflict without a second KDF or any fast hash of the secret. Compare canonical private values directly. Capture mutable field/metadata objects before any await.

Add Main-only connectPrepared(originalConnectInput, prepare) around the same internal admission path. The callback receives an assertion for this exact pending token and resolves to { target, input } or null. A null result preserves the existing unsupported outcome. A successful result returns the original captured target for the caller's existing post-auth verification.

- OpenCode caller: register before capture; run the existing capture/catalog/option validation in that callback, asserting the original token after each await.
- Claude caller: register before target/read; keep the existing form token and scope checks, asserting the original token after each await.
- Existing direct connect(target, input) remains a wrapper over the same internal path. It must not create a second owner or execute the preparation callback twice.
- The original request is captured and compared before resolving target identity. Once resolved, the target and canonical start input are fixed; no callback selects a replacement after cancellation or a context switch.

Read the original Main intent before fresh derivation. If present, validate its original operation/routing and derive only with its stored descriptor (or exact markerless legacy SHA). After the async derivation reread and compare the complete immutable original, including descriptor and fingerprint. Restore saved.targetId only, verify the returned targetId, and issue oauth.read only. Terminal original replay does not require the supplied foreground target to remain current and never creates/migrates an intent, calls oauth.start, or opens a browser.

Prepared-call qualification: the early original read exists for cancellation discovery; it does not authorize substituting saved.targetId into a caller's fingerprint. A retained connectPrepared still runs the SAME existing caller capture/catalog or Claude target/account-read validation, then requires its resolved target.targetId to equal saved.targetId before deriving or replaying. Those existing read-only eligibility calls do not authorize OAuth or open its browser. This preserves today's caller-level context semantics; it does not promise UI re-entry from a different project can bypass them. Direct connect(target, input) uses its supplied constant capture and preserves original terminal replay after foreground drift without isCurrent or a fresh selection. The stored Main evidence binds targetId, not a newly invented durable raw project/form-context identity. Live pending duplicates compare the full captured original request, but that comparison is not a claim of additional cold authority.

For a genuinely absent intent, finish captured preparation, assert this exact uncancelled token and fresh target currentness, derive once, and check them again. Atomic create remains before oauth.start. If create returns false, reread the first durable winner; compare its fixed routing and derive against THAT winner's descriptor, not the losing candidate's random salt. Reread the complete winner after derivation, then take the existing read-only original route. A changed payload or original record conflicts. A create that commits then throws never starts the Host; later re-entry reads the retained original only.

Cancellation marks the exact pending token synchronously before its first asynchronous read or restore. It must not wait for KDF settlement:

- If original discovery is pending, wait only that original read, so cancellation cannot accidentally report success while an existing original operation is still active.
- With a confirmed absent original and no create/Host-start attempt, return cancellation success locally. The captured continuation checks the token after read, capture, catalog, KDF and any subsequent I/O, and cannot publish or start later.
- If atomic create is already in flight, cancellation may wait for that publication I/O, never for crypto. A confirmed own intent created after cancellation is left immutable and undispatched; its later replay remains read-only/unconfirmed. If another writer won, or publication is uncertain, reconcile only that exact original route and do not invent a settled outcome.
- After Host start was requested, cancellation uses the original captured target. A control that reaches Host before any start admission is not falsely reported as confirmed cancellation; the original connect continuation still fences browser/auto effects and attempts only original cleanup.
- Check this token immediately before oauth.start, browser opening, progress presentation and automatic completion, and after their awaits. Existing target currentness and original expiresAt checks remain. A late result cannot delete/replace another active token or select another target.

Do not add a lifetime cancellation tombstone map, a second durable receipt, or a secret-input cache. The existing receipt boundary is explicit: a known no-write/no-native preparation failure leaves an ID unclaimed; a later explicit call after that attempt settles is a new admission. During the pending attempt, a changed same-ID request always conflicts. A known original Main journal prevents reauthorization on re-entry.

No new cancellation protocol or Renderer operation is needed. Existing Renderer best-effort cancellation already supplies the correct operation ID before the caller's capture/catalog awaits. Its cancelled-attempt telemetry remains unchanged.

## Host: asynchronous original admission, deadline and custody

start becomes a non-async public wrapper returning Promise<ProviderOAuthSnapshot>, so exact pending duplicates can return the same original promise; the existing transport already awaits returned actions. Read/authorization/cancel/progress remain free of KDF. Update direct test call sites to await start; do not alter external wire phases.

Read an existing original before fresh selection/allocation. Replay pins the immutable START identity: kind/schema, commandId, profile/config/provider/method, selectionDigest/resourceId, start fingerprint/descriptor and expiresAt. Completion method/command/phase/sequence may legitimately advance while a start-replay KDF is pending. After derivation assert the current writer/seal state, reread the exact original, compare the start identity and fingerprint, and return the latest original snapshot without a current-profile reselection or any write/native effect. Missing/replaced/corrupt original remains held/conflicted, never fresh fallback.

Before derivation, compare any live entry's original START identity with that durable original; a changed receipt follows the existing original-receipt fence with close=false and no native side effect from read-only start replay. After reread return the durable latest projection (snapshot(latest, false)), never stale active.saved. A wrong supplied field value alone conflicts without cancelling an otherwise intact original operation.

For a fresh start:

1. Parse/capture the full input, select the exact original target, reserve the existing namespace, and install a same-ID pending token before an await. Duplicate exact starts join; changed same-ID input conflicts, another command on the namespace stays busy.
2. Call prepare once while it is still construction-only; the three current adapters allocate only from authorize. Validate native.timeoutMs and capture expiresAt once at the original admission/construction time. The V1 adapter's own deadline is consequently unchanged. Start the pending expiry fence before KDF. KDF delay never extends or resets either deadline.
3. Derive the new fingerprint. Before publication assert the original token is active/unretired, writer/current owner, exact captured target and Date.now() < original expiresAt even if the timer has not fired. Reread the operation ID; an intervening different claim cannot be overwritten. No await between this final read and initial claim write.
4. The complete durable authorizing claim, including descriptor, still precedes authorize. Transfer the exact pending token's native capture/abort/deadline into the existing active entry. Timer delay is remaining original time, not a fresh timeout. Every subsequent native handoff/publication follows the reviewed G1c fences.
5. Failures strictly before any claim write close/dispose only this operation's constructed capture. After confirmed clean no-claim cleanup release its reservation without manufacturing a durable held record; KDF saturation/failure alone must not poison the namespace. A false/thrown cleanup result retains the actual unresolved custody, consistent with the existing native coordinators. Once an initial write is attempted, uncertain publication keeps custody and G1c must not overwrite that unknown receipt or allocate native work.

Cancel/expiry/seal/close fence a pending preclaim token immediately, abort and close the original constructed capture, and never await crypto. A preclaim cancel may return an original transient cancelled snapshot using the existing public shape; it writes no cancelled receipt without a start fingerprint. Keep the fenced token until its actual KDF settlement to reject duplicates/late callbacks and preserve helper permit accounting. Once a known no-write attempt settles, a later explicit admission may reuse the previously unclaimed ID, matching the existing construction-failure boundary. No lifetime tombstone authority is added. A later crypto callback can neither claim the cancelled operation nor touch a new operation on the released namespace.

Build a transient preclaim cancellation snapshot directly as the existing public shape. Do not manufacture a StoredOAuthCommand, dummy fingerprint or durable cancellation record to obtain that projection.

Any actual attempted claim invokes existing G1c uncertainty custody. Completion KDF behavior and all cleanup write comparisons remain intact. Namespace release must be for the same original command/token; cancellation cannot release a replacement.

An initial write-then-throw has no admitted ActiveOAuth. Its pending-start cleanup must close/fence only that original construction, retain uncertain custody, and never call generic G1c journal publication to invent or overwrite a receipt. Preclaim settlement is idempotent per captured pending token: synchronously reserve the one cleanup action, call close once, and release the original reservation exactly once ONLY after clean no-claim cleanup and an exact token check. A false/thrown close retains held custody. The existing resource fence compares resource+commandId, so a late close/KDF continuation must not release or poison a later same-ID admission. Retain the token until both actual KDF settlement and cleanup ownership have settled, or prove every remaining callback powerless before removal. Cancelling/closing never waits for crypto. A pending expiry callback cannot release an entry already transferred to active custody; the active timer retains the same original expiresAt.

## Exact expected source ownership

Main owner (frontend_parity):

1. src/features/runtime-provider-management/main/adapters/output/CapturedProviderOAuth.ts
2. src/features/runtime-provider-management/main/infrastructure/FileProviderOAuthIntentStore.ts
3. src/features/runtime-provider-management/main/adapters/output/CapturedRuntimeProviderManagementClient.ts
4. src/features/runtime-provider-management/main/adapters/output/withCapturedClaudeAuthentication.ts

Host owner (root, after G1c freeze; provider_team_parity reviews read-only): 5. packages/legacy-agent-host/src/management/OAuthOperationOwner.ts 6. packages/legacy-agent-host/src/management/commandRecords.ts

Shared narrow export (frontend_parity, coordinated with root): 7. packages/legacy-agent-host/src/management/secretFingerprint.ts — serializer re-export only; algorithm unchanged. 8. packages/legacy-agent-host/package.json — Node-only secret-fingerprint subpath, no dependency/lock/runtime changes.

No G2 capture/profile/checkpoint schema or native SPI changes. No changes in reserved Mac sources. The reviewed G1c owner is 606 lines, so G1d has 194 additional physical lines in that file and must remain <=800 without a cap exception. If exact G1c final LOC makes that impossible, stop before G1d publication and review a narrow pure start-identity helper explicitly; do not silently split state ownership or expand this manifest.

## Required finite regressions

First add failing functional regressions against unmodified G1d production. All credentials and roots are TEST-only; no native vendor launch.

Main:

- Real one-character secret field and empty-field start persist a descriptor; journal contains neither raw value nor old fast hash. Independently reproduce the original canonical legacy vector and new KDF bytes.
- Exact duplicate before first read and during KDF invokes preparation/KDF/Host start once; changed fields/context conflicts. Mutating caller metadata after call has no effect.
- Actual OpenCode caller cancel while capture and while catalog are blocked; actual Claude caller cancel while target/account read is blocked. Release those awaits and assert no Main intent/native start/browser/auto effect; callback never selects another target.
- Cancel while original read is pending, during KDF, before/after atomic publication, and during original Host start response. Only known no-effect cancellation reports settled; an existing original uses retained cancellation. No late presentation/browser/auto after cancellation.
- Two instances race one absent Main intent with different salts: first durable winner owns descriptor, same input loser reads original without restart; changed secret loses with conflict.
- Create-then-throw retains exact original bytes and causes zero native start; cold retained re-entry never authorizes. Replaced/deleted original during KDF fails closed.
- New/legacy cold completed replay after foreground switch and expiry uses original route, keeps bytes/descriptor unchanged, and makes no authorize/browser effect. Unknown/malformed marker rejected.
- Queue busy/failed derivation leaves no new intent/effect and permits an explicit later fresh operation.
- Existing Claude/OpenCode presentation, original code/cancel controls, native-owned browser and auto completion tests remain green.

Host:

- Real one-character fields and empty fields get private start descriptors, no fast parallel digest; original field order/canonical bytes and exact native inputs unchanged.
- Controlled KDF barriers cover same-ID duplicate/different input, different resource same-ID claim, same namespace different ID, input mutation and original record replacement/missing.
- Cancel/expiry/seal/close before KDF settlement: no initial receipt/native authorize; cancellation/cleanup do not wait for crypto; late callback cannot revive or release a successor. Original deadline verified with mocked Date before timer callback and checked remaining timeout.
- KDF busy/failure/construction failure safely release only known preclaim reservation. Initial write-before-throw and write-after-commit-throw preserve hold, bytes and native authorize=0.
- Retained start replay while progress/completion advances returns latest original; terminal new/legacy cold replay ignores changed current selection and never rewrites. Malformed/replaced descriptor refuses.
- Re-run G1c durable cleanup regressions and G1b completion races on the combined implementation.

Use existing Main OAuth + management-client + Claude-auth test files, Host management-oauth/opencode-management/command-store files, and existing safe E2E only as an exact combined controlled-process gate. No vendor/native acceptance claim.

## Sequence, scope and estimates

R1 traces UI inputs and both journal preimages, original ownership and the earlier caller cancellation gap. Coordinator independently reviews Main/caller interleavings; provider reviews Host start/custody against final G1c; root reviews shared contract, cold replay and exact manifest. Publish before edits. Implement independent Main/Host slices with frozen interfaces; then canonical Host build + strict tests, focused serial Main suites, scoped/full canonical types as resource slot permits, lint and size guard. Root performs normal hooks and publication.

Estimate: 330–470 changed production lines across8 files, including roughly40–65 caller integration lines; 500–750 focused test lines plus direct-await adjustments. Complexity8/10 (two existing custody owners and cancellation across async derivation); source diagnosis confidence10/10, plan confidence8/10 until R2/R3 barriers; reliability target9/10 after combined tests. No claim that G1d closes unrelated CodeQL/G2 secret witnesses.

## Candidate scope and execution qualification

The reviewed candidate changes the eight planned production files (+491/-156 lines) and seven existing test files (+1060/-61 lines). It adds 20 Main cases, 29 Host OAuth cases and two stored-schema cases, and adjusts existing direct callers to await start without weakening their behavior assertions. The extra volume over the estimate covers original-publication barriers, real caller cancellation and separate clean/uncertain preclaim custody. Main OAuth is 582 lines and Host OAuth is 733 lines; the existing 800-line production cap is unchanged. Complexity remains 8/10.

Independent source reviews covered both owners, actual callers, original receipt replay, helper export and test barriers. They caught and corrected two draft issues before publication: preparation must capture the caller's original context before the first journal await; a receipt appearing during derivation or cleanup must permanently prevent a clean preclaim reservation release. These were draft findings, not claimed executions against the published baseline. A final source check also corrected the new import ordering.

At that delivery the local executor was unavailable. The planned local RED step, new runtime tests, compiler checks and hooks had not run for that candidate; no local PASS was claimed. Delivery used the existing PR branch and the ordinary source-triggered CI. The ready-PR selectors include all affected files: the Host test job builds the package, strictly checks its tests and executes tests/\*.test.ts; the Main shards include the three changed Vitest files; validate includes workspace types/build and the unchanged source-size guard. Those jobs must actually succeed on the resulting source, including the existing G1b/G1c and related integration tests. Source review or the presence of a queued job is not execution evidence.

The exact candidate preserves the independently published Desktop process catalog changes. No manual workflow control, CI rule change, merge into main, default Host activation, dependency/runtime pin change or native acceptance claim accompanies this delivery. CodeQL/G2 investigation and separately owned genuine native/macOS qualification remain distinct outstanding checks.

## Recovered execution and original-cleanup presentation correction

After publication of d4f4d989, the executor recovered. The complete source was restored and its Git tree matched c6da51a18c8471cbd36a54d19ce2d841c0d6f93d. Checks used pinned Node 24.21.0 and native TypeScript 7.0.2, unchanged compiler options, and the existing Vitest 3.2.6 installation (within the declared ^3.2.5 range); no dependencies were installed or changed.

Selected regressions were then executed against the original eight production files: all four actual OpenCode/Claude caller-cancellation cases failed, as did the Host fingerprint case and both Main secret/empty-field cases. The latter two used only a temporary test resolver alias to the existing helper, because the original package had no new subpath export; the earlier collection error is not counted as a behavioral failure. All original production logic remained unchanged for these RED checks.

On the published G1d production, Host build passed, the source-size guard checked 5548 production files with the unchanged 139 frozen exceptions, and scoped strict checks passed for eleven related Host test files and eight Main files with six existing ambient declarations. The combined eleven-file Host runtime cohort passed 172/172, zero skipped, including the G1b/G1c cases, new G1d races, real canonical Desktop process frames and authenticated HTTP/MCP paging.

The first complete eight-file Main run exposed seven failures: six existing presentation cases and the controlled-process E2E retained the old instructions after cancellation. The new synchronous cancellation fence correctly stopped polling, but cancel itself did not project the validated original Host cleanup response. Four additional cases reproduced the same defect for completed, held, failed and cancelling replies. The correction adds three logical production lines after snapshot validation and the final original-token check, emitting only observed cleanup states without presentation. Only an actual cancelled state still returns ok:true; all admission guards, late-effect fences, immutable receipts and Host custody remain unchanged. Tests add 31 lines and replace one fixture default with an optional override whose default preserves the old behavior. Complexity is 2/10 for this follow-up.

With that correction, the complete Main cohort passed 223/223 across eight files, zero skipped. It includes actual Main IPC, captured Desktop ownership, a standalone Host and a separate TEST process, plus new and legacy replay, cancellation barriers, complete process catalog reconstruction and snapshot paging. It launches no vendor CLI, uses only TEST roots and loopback HTTP, and does not qualify genuine native/macOS behavior. The normal pre-commit formatter applies only to the changed Main source; the existing production size limit remains intact.

These results are finite local execution evidence. Required whole-PR CI on the resulting commit, the open CodeQL/G2 investigation and separately owned native/macOS acceptance still require their own successful results. No CI controls, protection changes, default activation, runtime pin changes or merge into main are part of this correction.

## Current-source reconciliation and local execution — 2026-11-28

After the executor recovered, the complete `d4f4d989f126317642843381e573926ed9c8a30a` source tree was restored and verified against its Git object hashes. The independently published candidate was compared with the earlier reviewed work before applying changes. Its immediate caller-context capture before the first journal await, original cancellation token, all incoming regressions, and Host preclaim cleanup/namespace-release behavior were preserved.

The reconciliation stays within the existing owners. Main carries the current Claude sender assertion through fresh admission, checks the immutable original after its own create and around retained Host reads, refuses cancellation through a foreign winning route, returns the same public Promise to exact direct duplicates, and clears confirmed cancellation presentation once under original authority. Progress checks authority before every listener. Host adds an original-admission check immediately after the final receipt read and immediately after the first claim write; a loss at the latter boundary preserves the uncertain original claim and held custody without native authorization or a public success transition.

Root and an independent reviewer checked the exact two Host guards before implementation. Frontend, root and coordination reviews checked the minimal Main reconciliation; its two production paths preserve the incoming preparation order. The changes introduce no owner, persistence format, wire operation, KDF implementation, dependency pin or raised limit.

| Executed check                                                         | Result                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main baseline on unchanged `d4f4d989`                                  | 16 FAIL / 39 PASS across the OAuth and Claude files. Failures include six existing terminal-clear assertions and the focused context/receipt/cancellation controls.                                                                          |
| Host baseline on unchanged `d4f4d989` build                            | All eight new read/write-boundary cases FAIL because admission incorrectly succeeds after writer, target, seal or original-deadline loss.                                                                                                    |
| Host boundary cases after the two guards                               | 8/8 PASS, zero skipped.                                                                                                                                                                                                                      |
| Main OAuth, Claude and public management-client cohort                 | 87/87 PASS, zero skipped, including the incoming context-before-journal control.                                                                                                                                                             |
| Combined Host management and catalog cohort                            | 186/186 PASS, zero skipped, across 13 files: original G1b/G1c, new G1d, durable cleanup, credentials, store, identity, fingerprint, OpenCode/Claude adapters, actual Desktop process frames, native MCP/HTTP process pages and group frames. |
| Canonical Host build and complete Host test typecheck                  | PASS using Node 24.21.0 and the existing TypeScript 7.0.2 compiler.                                                                                                                                                                          |
| Strict scoped Desktop compilation                                      | PASS for 21 source/test roots with inherited canonical compiler options and source declarations. This is not the whole Desktop project.                                                                                                      |
| Scoped standard formatting, fast lint and whole-tree source-size guard | PASS. Formatted Main OAuth is 707 lines; Host OAuth is 735 lines. Caps and frozen exceptions are unchanged.                                                                                                                                  |

These cohorts are separate evidence, not an assertion that overlapping focused checks add unique tests. The full canonical Desktop typecheck was stopped with exit 137 without compiler diagnostics and is not a PASS. Scoped type-aware ESLint was also terminated with SIGKILL before a verdict; the successful fast lint does not replace it. Current-head CI, type-aware qualification, genuine native scenarios and the independent G2 investigation remain required. Local fixture and HTTP/process-port tests do not qualify real vendor/native behavior.

### Reconciliation with the incoming cleanup correction

The subsequent `b26f085a65b982be213750795926614b154cb9b0` correction and its four regressions were retained. The integrated Main helper handles the same five observed cleanup states. An original-operation high-water mark records sequence, public phase and completion method before listeners run: an older reply cannot regress newer progress, an identical projection is emitted once, and a genuinely later outcome remains visible. Normal progress, explicit cancel and failure cleanup use that same helper.

A cold cancel uses a request-local immutable original intent and the restored original target. Its presentation requires an unchanged original journal, original target/profile/configuration, current foreground and absence of a new active operation. Each listener receives a fresh authority check. Suppressing stale presentation does not turn an actually confirmed native cancellation into a failed control response. No persistent tombstone, new owner or fresh target selection is introduced.

The four incoming outcomes and two ordering controls failed against the preceding local helper. A separate cold-control run, after correcting a fixture observation typo, produced two behavioral failures and three passes; fixture setup errors are not counted as regressions. One unrelated timing failure from the first full RED run passed when its unchanged control was run alone, without a timeout or assertion change.

After the reviewed merge, OAuth passed 57/57, Claude 9/9 and the captured management client 32/32, all with zero skips. Root and the independent reviewer approved the exact formatted 757-line OAuth owner and its controls. The first merged OAuth invocation was killed before a result; the successful run used one fork worker and a smaller 384 MiB heap with the same test code and deadlines. The current 21-root strict Desktop compilation then passed again using inherited canonical compiler options. Scoped fast lint, standard formatting, the whole-tree source-size guard and whitespace checks also passed.

The actual IPC-to-Host controlled-process E2E was attempted with one fork worker at 384 MiB, one fork worker at 256 MiB, and one thread worker at 384 MiB. The first lost its worker IPC channel; the latter attempts were killed with SIGKILL. No invocation produced a test verdict or final receipt. The second TEST root records one fixture process launch; it is not reported as effect-free. The cause of the termination was not established, and no OOM claim is made. Assertions, the original test deadline and the Host/native fixture were unchanged. These attempts do not qualify the current source, and no further unchanged resource retry was performed.

The later `7a66b8eb58d2ab46a98a5a6a8dce082561681d86` commit adds only the separate OpenCode auth-progress plan. Its document was imported without changing any tested source. That six-file implementation belongs to the parallel owner; this reconciliation does not replace it.

### Current-source controlled-process E2E qualification

The unchanged `capturedManagement.safe-e2e.test.ts` passed on `a01484ee4787698f7e3ce1d5b98a585edad54876`, including the published ModelProbe admission correction. It used the original fork pool with one worker and a 384 MiB heap: one test passed, zero skipped, 6.896 seconds in the test and 11.46 seconds total. Before this run, the checkout's temporary-filesystem footprint was reduced from 840 MiB to 242 MiB by removing a verified duplicate Git pack and omitting unchanged historical evidence through ordinary sparse checkout. Product source, compiled Host, assertions and the test deadline were unchanged. This resource change is recorded without asserting a proven cause for the earlier terminations.

The [execution manifest](evidence/e2e-a014-local-2026-11-28/manifest.json) and [verification note](evidence/e2e-a014-local-2026-11-28/README.md) record real Main IPC, captured Desktop ownership, standalone Host and separate TEST HTTP process execution. The receipt binds the tested Main files and complete Host source/dist trees, records credential/OAuth/model-limit scenarios, and confirms that all 18 fixture process IDs were absent after two shutdowns. Receipt SHA-256 is `2e33711a9ea897ab5e42669a43118bac8e60285f2bbc590d278ea191cfa58972`.

This is controlled-process integration qualification. It does not exercise Electron controls, real vendor OAuth/accounts, native platform custody or real model services, and it does not replace current-head full CI or the remaining G2 security work.
