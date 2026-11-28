# PR #982 — G1d: protect OAuth start-field fingerprints and retain one original operation

Status: R1/frontend design, independently approved by coordination for Main/caller flows, provider for Host custody, and root for the combined contract. Published before G1d production changes. The reviewed G1c owner is frozen at 606 lines (SHA-256 e11c1629381d4713b8aafef68f7a39fc8b3056ed514c9985fed15c9c444dbd0f).

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

Host owner (root, after G1c freeze; provider_team_parity reviews read-only):
5. packages/legacy-agent-host/src/management/OAuthOperationOwner.ts
6. packages/legacy-agent-host/src/management/commandRecords.ts

Shared narrow export (frontend_parity, coordinated with root):
7. packages/legacy-agent-host/src/management/secretFingerprint.ts — serializer re-export only; algorithm unchanged.
8. packages/legacy-agent-host/package.json — Node-only secret-fingerprint subpath, no dependency/lock/runtime changes.

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

