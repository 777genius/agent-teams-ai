# Native selected-file witness protection — Family B

## Status, boundary, and ownership

**Reviewed plan awaiting publication.** R1 design and source trace are complete; root R2 and independent provider R3 approved the complete A1–A5 lifecycle, codec and native pre-effect design, including the final Host-provenance and catalog qualifications below. Production implementation remains blocked until this reviewed plan is published and the finite baseline evidence is recorded. No Family B production change or new test has been executed for this document.

Source trace: local a01484ee4787698f7e3ce1d5b98a585edad54876 and the ModelProbe-only successor, with the readiness, launch and factory joins reread after the 533d955 plan publication. The relevant Family B provider/readiness files remain unchanged; external Family A and process changes are separate. Existing checked builds, OAuth tests and the TEST Desktop management E2E are separate evidence, not verification of this proposal.

This is a separate closure for **new durable native selected-file witnesses and the native credential scope**. It does not claim all CodeQL628 paths closed. Initial-admission account hashes, effective/configuration/profile/recipe/source identities and their containing records remain Family C. The external Family A owner retains its six management/auth progress paths. This plan does not replace that work or introduce a new management digest policy.

No changes are proposed to vendor pins, Effect pins, native API contracts, the Runtime journal/CheckpointStorage schema, public readiness DTOs, TeamLaunchOwner, teamRoster, savedTeamModelProbe production, the G1 KDF implementation, or Family A's six files. Existing CLI/Main physical profile and Windows custody remain unchanged.

## Source-derived problem and required joins

The current selected-file witness contains fast descriptor/source/auth commitments, SHA(file bytes), SHA(materialized key), and an issuer reference that itself hashes a secret-dependent descriptor plus a public nonce. Hiding one field leaves another offline verifier. The durable v2 representation below omits all those independently accessible values.

The pinned provider client requires synchronous acceptance: acceptProof(proof) must return undefined. A parent-side await inside that callback is incompatible. Native proof preparation therefore runs before the original app/Connect effect; the parent synchronously compares current dependency bytes with an authenticated transient MAC made with the existing same-child password.

The original policy must survive these real transitions:

| Original authority | Next consumer | Source requirement |
| --- | --- | --- |
| Fresh native ordinary model probe | Released StoredModelProbe | Only the successful, cleanly released probe publishes its durable witness. |
| Released original ModelProbe | Fresh member child | The existing assertReadinessCredential comparison requires the member to reproduce that original scope; a new salt per child fails. |
| Current original selected-file session | Runtime checkpoint | A Host envelope retains the durable v2 witness beside the unchanged pinned checkpoint. |
| Authorized original Runtime checkpoint | Cold replacement child | Verify the original file proof and reread the same checkpoint after the await before child allocation; use the original policy. |
| Exact legacy ModelProbe/checkpoint | Original legacy continuation | Preserve its original algorithm and bytes; a missing protected marker never grants a new legacy issuance. |

OpenCodeLocalModelReadiness sets applicable = localCandidate && !selectedFile and returns before coordination for a selected-file source. Thus this source does not create an ordinary-then-coordination pair. Its real policy transfer is ordinary probe to released receipt to later member child. Keep a regression proving that distinction.

## A. Private readiness handoff

### A1. Preparation is asynchronous; validation stays synchronous

Introduce a private prepared result beside the existing public reference:

    PreparedModelReadinessReference = {
      reference: ModelReadinessReference;
      fileKey?: PreparedModelFileKey;
    }

    PreparedModelFileKey = {
      commandId: string;
      context: string;
      proof: AcceptedOpenCodeV2FileKey;
    }

These are private composition values. Neither the wrapper nor a nominal object is serialized into the launch record, Runtime profile, public snapshot, transfer DTO or model probe. The existing public ModelReadinessReference continues to commit the original durable encoded witness through preparationDigest exactly as the owner does today.

The file-key wrapper is not a grant. Every consumer verifies its command/context, nominal Accepted identity, exact encoded witness equality and selected source, then applies the existing ModelProbe and launch-consumer validation. A structurally copied object or supplied scope string cannot substitute for the nominal proof.

Extract the existing OpenCode account observation from the 773-line prepareTeamModelReadiness.ts into one narrowly named composition/openCodeProbeAccount.ts module. Preserve its V1/native auth/configuration/policy behavior and existing source fence. Add the asynchronous selected-file preparation and the synchronous prepared-proof path there; do not duplicate a new configuration reader or change the Family C account/configuration digest formula.

The asynchronous preparation does the following under the already captured action/currentness/cutoff:

1. Read the exact original through ModelProbeOwner.readRetainedProbe(commandId, context), or the existing readReadinessProvenance qualification for a historical Restart source. Capture the full immutable returned row and exact candidate profile/selection.
2. Capture the same Deferred selected-file source through the existing account/configuration reader. Check the original successful/released, selection, purpose, readiness, scope and source predicates. Do not obtain a descriptor from a newer result or a history scan.
3. Call asynchronous Accepted.retained with the original encoded witness and its original descriptor pair. It verifies the files proof only; the parent never evaluates the materialized key.
4. After crypto, **reread the actual same ModelProbe owner record**, compare the complete row with the captured original using direct structural equality, and repeat original writer/action/cutoff/source checks. A closure over the first row alone is insufficient. Deletion, replacement, changed released/held/completed state, witness change or policy change refuses.
5. Run the unchanged owning captureReadinessReference/readReadinessProvenance qualification again with the prepared proof. Return the private pair only after that complete final qualification.

The current readRetainedProbe is private inspection; it is not by itself a readiness grant. Preparation cannot bypass captureReadinessReference's target, scope, retired, completed/released, expiry, origin and account checks.

For a non-file source the existing account logic remains synchronous and no KDF is added. Exact retained v1 follows its explicitly selected legacy verification; fresh probes only issue v2. A v2 original without its prepared nominal proof cannot silently call a legacy digest or launch asynchronous work from a guard.

### A2. Synchronous checks after preparation

inspectMemberModelReadiness captures the current invocation's nominal proof and supplies it to readPreparedModelReference/account inspection. Each current() invocation still rereads the actual launch consumer and ModelProbe through the existing owners. It checks exact original reference, command/context, encoded witness, current selected descriptor and files, as well as all existing authority and cutoff predicates.

No KDF is executed by current(), filesCurrent(), read/lookup polling, diagnostics, launch projection, or a provider readiness poll. The Accepted object retains bounded private file observations, not an active owner callback from the earlier action. Its acyclic file-currentness method checks bytes and OS identities only. Fresh authority is recaptured for the selected generation; an old pre-Stop binding/admissionOnly callback must not be carried into the new generation.

The factory adds an optional private MemberProviderContext file-key proof alongside assertReadinessCredential. The member adapter validates the nominal proof against its own newly captured Deferred source before deriving a child policy from it. A protected continuation passes the exact original descriptor pair and expected scope to the child, which recomputes and compares the scope before its original app/Connect call. Parent live acceptance checks that original pair and scope as well as the transient MAC. After native credential preparation, the existing assertReadinessCredential(scopeDigest) check remains mandatory. A late parent comparison alone is insufficient to prevent a wrong-policy native effect.

### A3. Exact action placements

| Existing path | Required change and effect ordering |
| --- | --- |
| captureLaunchModelReadiness -> RuntimeTeamCaptures.capture | Await original file-proof preparation before prepareReadinessCapture writes its launch capture. The original roster publication may already exist; this is not a claim of zero prior product effects. Do not serialize the private proof in the capture. |
| prepareCapturedLaunchReadiness | Await only already admitted original probes, then prepare their exact file proofs before attaching/starting eligible members. Preserve the original cutoff. |
| prepareTeamModelReadiness / captureActionModelReadiness | After the original probe settles, prepare the exact retained proof and return the private pair through the existing action result. Public launch records receive only reference. |
| executeRuntimeLaunch start | Keep original intent/admittedAt and source/actor capture. Prepare before preclaim/native work and check all action guards after the await. Configuration/worktree preparation keeps its original ordering. |
| executeRuntimeLaunch retry / executeNativeMemberAction retry | Existing retained command replay wins before any fresh preparation. For a genuinely new retry, prepare the original consumer's file proof before the new retry claim; do not manufacture another model probe. |
| executeCapturedRuntimeControl open | Preserve completed/original replay behavior. Explicit fresh open hydrates its original consumer before synchronous admission, using the same captured authority. |
| captureNativeRestartReadiness -> executeMemberAction | Make the original source proof preparation asynchronous **before Stop/transitionRuntimeMember**. Capture the original action admittedAt/cutoff before that added await and pass it through; do not reset it when captureActionModelReadiness is entered afterward. Preserve existing completed action replay and recapture post-rekey authority. The separately required new target probe keeps its existing later phase. |
| preflightNativeMemberModel -> createRuntimeNativeMemberCreation.install | Carry the private pair from the existing async native preflight to attach/start; do not add a second probe or field to the durable native addition. |
| executeLiveRosterMembership | Retain the private pair only in the existing flight/target invocation through attach/open. Preserve selected source and publication joins; no newest-capture substitution. |
| attachInitialRuntimeModelAdmission | The native-local-readiness branch awaits its exact original probe proof before attaching consumers. Capture the initial action/profile before awaiting and revalidate the entire initial admission afterward. The native-bootstrap branch has no original ModelProbe and obtains its first fresh v2 policy only at its original child issuance. |
| Checkpoint continuation | The existing continuation consumer does not reconstruct a model-probe group. Use the authorized checkpoint route in section B. |

The initial inline profile/source/account hashing and initial admission schema remain unchanged in Family B. This is a deliberate remaining Family C boundary, not a missing-marker fallback.

Retained retry detection uses the existing owners before fresh proof work. The human path may inspect the already validated memberActions().read(memberId).retries view for the original commandId or attemptId, then delegate the unchanged launch.retry call so the owner alone decides exact fingerprint replay or conflict. A valid old retry remains a replay after a later retry becomes current; checking only currentAttemptId would incorrectly hydrate it. The native path uses its existing readNativeRetry with the captured original native authority. Neither path adds a retry-history owner, alters the 64-record retry budget, or treats a matching ID as permission to skip the owner's full comparison.

Historical Restart source qualification remains provenance under the new action's original cutoff. Do not impose the fresh allocation expiry of the old probe as a new historical-source condition; use the existing readReadinessProvenance rules and perform the actual post-crypto original reread.

### A4. Exact scheduled-opening handoff and publication guards

The source has a concrete lifetime trap. TeamLaunchOwner.startMember claims and queues runtime.open in Promise.resolve().then(), while start/retry may return a summary immediately. A finally attached to the public response is not proof that the material handoff has been consumed.

Use one invocation-owned private file-key handoff slot on the existing MemberEntry. It contains the exact prepared pair, captured binding, configRevision, configurationDigest, expected selected attemptId, original Host incarnation and a unique object identity for cleanup. There is no map of old commands, new durable marker, timer, authority owner or reusable secret cache. Initial/bootstrap and checkpoint-only continuations without a prepared ModelProbe file proof do not acquire this slot.

The expected attempt is captured from the existing selected launch attempt, except that a new technical retry uses the original validated retry input's attemptId. A retry is allowed to replace its public consumer through reuseReadinessForRetry; the slot therefore commits the original group reference, command/context and proof identity, not an obsolete pre-retry consumerId. The synchronous inspector still checks the actual selected consumer and its own captured consumerId after that legitimate transition.

Host provenance uses existing private inputs, without another forwarding layer: human start/retry and runtime.open already receive the current Host incarnation; native retry uses the frozen captureNativeInputAuthority.runtime.hostIncarnation, whose original allocated/owned Runtime was checked when captured. For a new Restart or native addition, install the slot only after the existing selected/configured publication and read the exact new unclaimed attempt: memberActions selects it through journal.initial and nativeLaunchAddition through options.initial, both bound to TeamLaunchOwner's current Host. Do not read the prior failed attempt's Host for a new retry. Live membership uses its existing captured options.hostIncarnation. The launch keeper and provider factory additionally compare against their own original composition Host constant.

#### Early guard before existing admission publication

The common preparation path performs an all-target pending-slot preflight after original authority/selection checks and **before the first attachModelReadiness(admissionOnly) write**. This placement matters: captureActionModelReadiness currently attaches admissionOnly before asynchronous prepare; attachLaunchReadiness deliberately permits admissionOnly on a claimed attempt and retires other live member consumers. A final post-KDF slot check cannot undo such an earlier retirement.

Preserve existing caller filters. In particular, executeRuntimeLaunch's start selection and prepareCapturedLaunchReadiness exclude claimed attempts, and initialRuntimeModelAdmission requires its exact unclaimed initial attempt. Do not widen them just to use the new helper. A separately reachable path still needs the common guard: executeCapturedRuntimeControl can see no Runtime row while an initial launch is already claimed and its open microtask has not run. With explicit readiness it can reach admissionOnly through the existing initialBeforeOpen branch. It must refuse before that publication if the original pending handoff is still owned.

Preflight never overwrites a live slot, even when its material is equal. A same-original duplicate reaches existing owner replay, without taking ownership of the slot or clearing it. A different operation cannot retire the first operation's public consumer while the first handoff is pending. Check every selected target before any target's admission attachment; this is a finite prepublication check, not a new atomic multi-member journal transaction.

#### Final synchronous handoff

Keep the prepared pair local to the existing action/flight while worktree verification, old-member closure or other existing awaits are outstanding. Existing early public admission/initial-reference attachment may retain its original ordering, but no MemberEntry handoff slot is installed across those awaits. At the final boundary reread the actual consumer/reference and original proof, repeat the action/selection/cutoff guards, and check every target slot again **before any final attachment or slot installation**. Where the original initial reference was already attached, compare that exact current reference; do not silently reattach a retired one.

The final check/reservation, required public attachment, slot installation and existing start/retry call form one synchronous sequence with no new await between them. Keep the original owner claim and validation calls. Each caller clears only its own unclaimed slot on a synchronous refusal; partial multi-member starts preserve a slot for a member already claimed and pending while clearing only the refusing invocation's unused slots. A still-live slot blocks a new installation; stale cleanup must first prove it no longer belongs to that selected pending opening. No unconditional assignment can replace another invocation's slot.

Use the actual last synchronous hooks. executeTeamLaunch invokes beforeStart().then(start), so beforeStart retains prepared pairs locally and must not install entry slots. The existing synchronous beforeOpen wrapper performs the final all-target guard, required attachment and slot installation, then forwards the original prompt callback before TeamLaunchOwner's unchanged startMember loop. The original aggregate start receipt keeps its existing position before beforeOpen; this proposal does not move that publication or claim that all product writes occur after proof transfer. Similarly, transitionRuntimeMember awaits verifyNewWorkAllowed after installSelected: keep the pair local through that await and install the slot only in startSelected immediately before launch.startMember, rereading any already attached exact original consumer. No change to executeTeamLaunch, transitionRuntimeMember or the reserved TeamLaunchOwner is required for these two hooks.

createRuntimeTeamLaunch.runtime.assertModelReadiness reads the matching slot without consuming it for the existing preclaim check. For a technical retry this check still sees the old selected consumer; only the existing retry owner advances the attempt/consumer. createRuntimeMemberProviderFactory takes and deletes the exact matching slot immediately after selecting and validating the original entry/request, **before its first assertRuntimeWorktree await**. The factory holds the pair in its own invocation closure and supplies it explicitly to subsequent inspectors and MemberProviderContext. Later entry-slot replacement or cleanup cannot remove that already transferred proof. Original binding/profile/configuration and provider-authority checks remain mandatory before and after the worktree await.

#### Keeper predicate and scheduled-but-never-open cleanup

After the synchronous owner call, retain an unconsumed slot only if the existing launch read proves all of the following: the entry still has the captured binding/configuration; the selected attempt equals the slot's expected attemptId; it is claimed by the same Host incarnation, pending-bootstrap with reason opening, noAllocation false and a live original deadline; and the non-retired selected readiness consumer/reference still names the exact original reference, command/context, cutoff and proof commitment. No KDF or fresh source selection occurs in this predicate. A read or authority failure is not proof that a fresh operation may replace the original.

The existing createRuntimeTeamLaunch onProgress callback is the cleanup join for a queued opening whose authority fails before runtime.open. Snapshot each entry's exact unconsumed slot, check the keeper, and remove only that same object when it is no longer a live pending opening. If the cleanup read throws, discard only that unconsumed captured slot; do not mutate the launch, invent a phase or grant a replacement. Catch cleanup's own failure and **always forward the original options.onProgress exactly once**, using finally; the original callback's behavior and invocation count stay unchanged. Never delete a later replacement slot by member ID alone.

The source supports this join: the TeamLaunchOwner constructor does not call onProgress; its queued opening's final callback calls onProgress even when sealed, whereas its deadline callback calls it only while not sealed. Thus the wrapper can close over the installed launch without a constructor-time read. The queued finalizer handles sealed or refused openings before factory entry; factory transfer handles the entered path. An unused slot is never cleared merely because a public start/retry summary returned.

Required deterministic controls are (a) A prepares and queues its opening, B's already queued preparation continuation resumes before A's factory, and B cannot overwrite or clear A even with equal material; (b) initial A is claimed with no Runtime row yet and explicit runtime.open B cannot retire A through admissionOnly; (c) all-target conflict refuses before the first admission attachment; (d) authority refusal before runtime.open, deadline, seal and cleanup-read failure clear only the original unused slot while forwarding the original callback once; and (e) once A's factory has taken its proof, a later valid slot does not affect A, including a worktree-await failure. Keep actual caller claimed/eligibility filters in these fixtures.

TeamLaunchOwner and launchReadiness stay unchanged. Shared pure preflight/keeper helpers belong in the existing readiness composition module after its account extraction; the existing launch and factory composition files own their respective callback and transfer joins.

### A5. Explicit original policy selection before native effects

The private init policy is a strict discriminated choice, selected by the existing original owner before child creation. It is not inferred from whichever witness fields happen to be absent.

| Original mode | Policy passed to the child | Earliest required scope comparison |
| --- | --- | --- |
| Fresh original ModelProbe or native-bootstrap session | The server mints one random v2 descriptor pair for this original child preparation. No expected old scope exists. | Both proofs and final live encoding are prepared before the original app; repeated materialize/GET never mint another pair. |
| Protected released readiness or protected checkpoint continuation | Exact verified original v2 pair and mandatory expectedScope from its durable witness. | Native prepareIssue derives the full scope and refuses a mismatch before app/Connect. Parent synchronous acceptance also checks pair, scope and MAC. |
| Exact legacy readiness used for a fresh member | Explicit legacy mode and mandatory known original scope; the parent retains the independently validated original v1 encoding. | The transient v1 observation must match that scope before POST app, and again at the parent acceptance boundary. |
| Plain authorized legacy checkpoint restore | Explicit legacy restore-only mode; POST remains refused. This is the only continuation for which the old native session's scope is unavailable at child initialization. | The original native readSession supplies its scope before readSelectedSource; the synchronous parent callback requires that exact scope. The observed GET witness is transient and cannot become a new durable encoding. |

Missing expectedScope is legal only for the fresh-original mode or the explicitly authorized plain-legacy restore-only mode. A protected continuation, a legacy readiness POST or a malformed policy cannot fall through to either. Child init, native transform and parent acceptance validate the same choice. The v2 pair is selected once at original child preparation, never by materialize, polling or a later GET.

The existing catalog mode remains explicit pass-through with no selected-file witness issuance and no KDF; selectedFileKey continues to refuse that mode. It requires no new Family A caller or policy preparation. In EmbeddedMemberProvider, a selected-file source with assertReadinessCredential but no nominal readinessFileKey refuses before server creation instead of selecting a fresh pair. Fresh default issuance is confined to the actual original ModelProbe or native-bootstrap path.

These are private policy modes, not additional wire schemas. The two wire representations remain strict v2 live/durable and the existing strict v1 observation on its explicit legacy route. The legacy Accepted getter and original-only persistence rule in section C remain mandatory.

## B. Host-owned checkpoint envelope

The pinned codec snapshots exactly four own enumerable data properties and rejects a fifth: version, engine, nativeSessionId, compatibility. It also rejects getters, proxies and malformed native identity. The Runtime opaque payload remains its existing authenticated storage object. Host metadata must therefore be outside the pinned object and removed before the pinned decoder runs.

The new Host-only shape is strict:

    {
      kind: 'opencode-v2-file-checkpoint',
      version: 1,
      checkpoint: {
        version: 1,
        engine: 'opencode-v2',
        nativeSessionId: <unchanged pinned valid session id>,
        compatibility: <unchanged pinned 64hex>
      },
      nativeFileKeyWitness: <canonical durable v2 encoded witness>
    }

Only a selected-file session with its original accepted v2 proof emits that envelope. Existing other-provider and non-file V2 payloads stay unchanged. A legacy continuation retains its plain checkpoint format. Unknown/malformed Host envelope kinds, unknown fields, v1 evidence placed inside a protected envelope, live MAC/issuer material, and missing v2 proof are refused without legacy fallback.

### B1. Fresh and closing capture

OpenCodeV2EmbeddedMemberProvider wraps the successful driver's checkpoint() result and its checkpointBeforeClose result; the 798-line generic OpenCodeV2MemberProvider remains unchanged. The wrapper preserves the result's existing failure branch. On success it copies the original pinned checkpoint and original durable witness, after checking they belong to the same already accepted native session/selection.

The wrapper never runs KDF or reads a new selected account during checkpoint capture. Closing capture may use only the already retained original evidence permitted by the delegate's one-shot closing/owned/idle contract; it must not require a new live-child or fresh allocation grant after seal. A missing original proof returns the existing unavailable/held result rather than a plain fallback for a protected session.

Runtime continues to persist and fingerprint the whole opaque envelope through its existing checkpoint payload. The added metadata contains protected outputs and structural values only. There is no new lookup file, marker store or public checkpoint field.

### B2. Cold restore and exact readback

At factory.open:

1. Call the original authorized context.readCheckpoint(reference, request). This already checks the released original source, published payload/digest/history/configuration, original host, and exactly one matching opening target.
2. Parse the Host envelope, validate the inner pinned object, capture the entire original envelope and native session ID, and capture the same Deferred selected-file source. Select only the envelope's original KDF policy.
3. Await retained files-proof verification with the original owner/currentness checks. Do not allocate a child, invoke ConfigVariable, call Connect, or obtain a new salt.
4. **Call the actual authorized context.readCheckpoint again after the await.** Require exact structural equality of the original envelope/native payload plus the same request/config/source/current authority. A captured object comparison without storage reread is insufficient.
5. Pass a private readCheckpoint wrapper into the delegate. Every subsequent SPI read calls the original authorized reader again, requires the same full envelope, and returns only its exact four-field checkpoint. Do not replace it with a cached payload that bypasses Runtime's check.
6. Supply the verified original policy to the new child. Its credential scope must match the existing native session scope through the pinned restore path. No new proof policy is selected from current foreground/profile state.

Runtime's authorized read requires an already recorded opening/unknown target. Therefore the cold KDF happens after that existing opening intent but before native allocation. Refusal must preserve original hold/custody; do not claim no journal writes or undo the original opening intent.

The same wrapper also checks plain legacy payloads for exact authorized-original continuity. Removal of a v2 envelope from an existing Runtime payload without updating its owning original digest fails at the Runtime read. There is no inference of legacy from an arbitrary missing child marker.

### B3. Envelope bound

The pinned native session ID is at most260 ASCII characters (ses_ plus256); compatibility is64hex. The witness remains at most65536 canonical ASCII base64url characters. The exact compact Host envelope above is at most66026 bytes; with two-space pretty JSON at top level it is66070 bytes. Embedded under the existing opaque property it adds only finite indentation on the same fixed fields (at most66100 bytes is a conservative accounting bound).

The existing FileCheckpointStorage8MiB limit applies to the **entire** record including operation history, unchanged. This is not a new independent66100-byte acceptance cap and does not promise a near-full historical record plus new metadata fits; the existing prepublication checkpoint limit must still refuse honestly. Test the exact maximum wrapper and full-storage boundary, including no accidental UTF-8 expansion. Never raise the8MiB limit to accommodate this change.

## C. Exact native format and pre-effect issuance

The following section is supplied by the independent provider source review. Its strict schemas, preimages, HMAC and bounds are part of this candidate, not optional alternatives. Root accepted the explicit additional verification-pass accounting; native/Bun execution is still a required gate.

### Independent crypto and native issuance section

Read-only design section for the separate `native-file-witness-protection-plan.md`; no production code, test fixture, cryptographic operation, native process, or vendor/pin modification was performed for this section. Source was reread at local `5d4b5b1c640c32e7a52bdd9f8c2d23a140002942`; the relevant files were unchanged by the later ModelProbe-only publication.

#### 1. Exact scope

This slice protects the newly durable native selected-file witness and the native credential `scopeDigest`. It does not claim removal of the other initial-admission, account, configuration, profile, or source-selection fast hashes; those remain a separately declared family C.

The current descriptor may retain `digest`, `sourceDigest`, `namespaceDigest`, `authDigest` and origin digest as private transient equality inputs. The current dependency reader may also use a private in-memory SHA for repeated exact-byte currentness. None of those values, `materializedKeyDigest`, or **`issuer.reference`** may be copied into the new durable v2 witness. `issuer.reference` is itself a fast commitment of the secret-dependent descriptor plus public nonce/integration/mode, so removing only the obvious file/key hash fields is incomplete.

The native provider credential remains the pinned `{scopeDigest, credentialId}`. The outer HTTP proof remains the pinned `{schemaVersion:1, sourceReference, witness}`. Only the opaque base64url `witness` interior changes. The pinned client synchronously requires `acceptProof(proof) === undefined` before continuing its readback; no Promise or vendor change is allowed there.

#### 2. Strict durable and live schemas

`Proof` is the already supported G1 descriptor and 32-byte output:

```ts
type Proof = {
  fingerprintKdf: { version: 1; salt: Hex32 };
  fingerprint: Hex64;
};
type FileMetadata = {
  path: AbsolutePath;
  canonical: AbsolutePath;
  identity: DecimalString[8];
  chain: Array<{
    path: AbsolutePath;
    canonical: AbsolutePath;
    kind: 'directory' | 'link' | 'file';
    identity: DecimalString[]; // existing 4–8 components
    link: string | null;
  }>;
};
type DurableV2 = {
  schemaVersion: 2;
  key: Proof;
  files: Proof;
  scopeDigest: Hex64;
  dependencies: FileMetadata[];
};
type LiveV2 = DurableV2 & {
  issuer: { nonce: Hex64; pid: PositiveSafeInteger; integrationId: IntegrationId; reference: Hex64 };
  request: { method: 'GET' | 'POST'; deadline: PositiveSafeInteger };
  mac: Hex64;
};
```

All objects are strict. Hex is lowercase with exact lengths. KDF version/parameters are fixed by the existing G1 helper; the wire cannot supply N/r/p/maxmem. Preserve the current path, chain, dependency-count and metadata validation. Dependencies remain 1–32 distinct original paths sorted with the current `a.path < b.path` ordering, and the actual native-read paths must belong to the descriptor's existing allowed-path set. The actual source reader, not a caller's metadata object, establishes each dependency and its OS identity.

The live encoder emits `LiveV2`. Synchronous parent acceptance builds a separate `DurableV2` object by an explicit allowlist and serializes only that object into `AcceptedOpenCodeV2FileKey.encoded`. Do not retain the original live string as `.encoded`, and do not use a permissive schema that strips fields silently. The stored witness decoder accepts exact legacy v1 originals or exact `DurableV2`; it rejects live-only fields in v2 durable input.

Provider/model/cwd are no longer duplicated as durable scalar fields. They are committed by the file proof's exact descriptor material and retained on the nominal Accepted instance from its verified source. `Accepted.selected` can use that private source selection rather than treating caller-supplied durable fields as authority.

Use fatal UTF-8 decoding, canonical unpadded base64url round trip, strict JSON shape, and a canonical JSON round trip for v2 to reject duplicate/noncanonical fields. Keep the existing `witness.length <= 65536` boundary. Legacy decoding remains exact and does not rewrite its bytes.

#### 3. Exact domain-separated preimages

Let `C(x)` be the existing `canonicalManagementValue(x)` UTF-8 encoding. Let `D` be the exact parsed descriptor body **without its outer `digest` property**. D still contains its private source/namespace/auth/origin commitments, raw file spelling and captured environment values. Those inputs are inside the slow proof and are not emitted as v2 durable fields. No normalization, trimming, or JSON/string pre-hash is introduced.

Let each `F[i]` be `{...FileMetadata, bytes: base64url(exactObservedFileBytes)}`, sorted by the original path. The base64url value is canonical and unpadded. No `sha256` field is included. Let `K` be the exact string returned by the native ConfigVariable substitution and accepted by the current `materializedKey()` validator, without an additional trim or re-interpretation by the parent.

The two existing fixed-cost scrypt invocations are:

```text
key.fingerprint = G1(
  {domain: 'agent-teams/opencode-selected-file-key/v2', key: K},
  originalKeyKdf
)

files.fingerprint = G1(
  {domain: 'agent-teams/opencode-selected-file-files/v2', descriptor: D, files: F},
  originalFilesKdf
)
```

`G1` is the existing async `deriveSecretFingerprint`: scrypt N=32768, r=8, p=3, maxmem=64MiB, output 32 bytes; the only stored algorithm choice is its strict version-1 descriptor with 16 random salt bytes. Use separate independently generated descriptors for key and files at the one original fresh protected capture. Run the two derivations sequentially within the existing request deadline and bounded process queue. Retained/restore uses those exact descriptors. Public constant domains are domain separation, not a replacement for random salts.

The native scope identity is a fast structural digest **only of already protected proofs and structural metadata**:

```text
scopeDigest = managementDigest({
  domain: 'agent-teams/opencode-selected-file-scope/v2',
  key,
  files,
  dependencies
})
```

There is no secret-derived fast inner hash in this scope preimage. It excludes issuer, nonce, PID, HTTP reference, method, deadline, current child password and current Host incarnation. Therefore a later child with the same original KDF policy, same descriptor and unchanged exact dependency material reproduces the original scope. Changed key, source, provider selection, dependency bytes or required OS identity cannot produce the original verified pair.

This slice preserves existing source isolation rather than widening it: F contains only the selected native dependency set, never all auth entries or another provider's files. Existing descriptor source/auth coupling is not claimed eliminated here; it remains explicit family-C scope.

#### 4. Transient live MAC

Use HMAC-SHA-256 keyed by the **existing original child password**, decoded from its canonical 43-character base64url encoding to the original 32 random bytes. The password is already privately shared by the exact parent and child; do not create or persist another key. The MAC preimage is:

```text
C({
  domain: 'agent-teams/opencode-selected-file-live/v2',
  wire: LiveV2 without mac,
  descriptor: D,
  files: F
})
```

Thus the tag authenticates the exact durable proofs, exact observed file bytes, captured descriptor, issuer, selected integration/reference and original HTTP method/deadline. It does not pre-hash raw key/file material with a public fast hash. Compare tags using a constant-time byte comparison after exact format validation. Dispose temporary MAC-key/preimage buffers when complete; never include the password, tag, live wire string, or live issuer/reference in logs, Runtime checkpoints, ModelProbe evidence, or `.encoded`.

The parent reconstructs D from the original Deferred source and F by the existing bounded OS reader. It does **not** interpolate environment/file expressions into a key or attempt to verify the native key proof from guessed key material. It checks the exact original ready object/nonce/PID/integration/reference, expected method and original owner deadline, recomputes the live MAC, and rechecks currentness/deadline after the bounded synchronous reads before admitting the nominal Accepted instance.

The pinned client calls acceptance once for POST in `connectSelectedSource`, then performs an ordinary integration readback. `readSelectedSource` calls acceptance once for GET. Therefore `OpenCodeV2SessionCredential` can pass its known `restored ? 'GET' : 'POST'` and existing `config.deadline` through the **private** binding without changing the pinned callback signature. The actual per-request deadline remains the pinned `min(config.deadline, requestStart + 30000)` and is copied from the child's already validated request. Parent requires it still live and no later than the original config deadline; it must not invent a fresh 30-second window during acceptance.

An authenticated same-child response alone proves origin but does not prove that the parent's current file bytes still equal the child's KDF inputs. The transient MAC supplies that exact comparison without an asynchronous parent KDF inside the pinned callback and without a new durable fast verifier.

#### 5. Original policy and legacy route

An original policy is the exact key/files KDF descriptor pair plus its expected scope when continuing a protected original. It is unrelated to nonce/PID/HTTP reference. The verified nominal Accepted instance exposes only the required private original policy/scope to the existing readiness/member/checkpoint handoff. No generic global lookup, per-history KDF cache, or salt file is introduced.

Fresh protected issuance chooses the descriptors once. The actual selected-file readiness path skips the coordination child (`OpenCodeLocalModelReadiness` requires `!selectedFile` for that phase). The required cross-child join is ordinary probe → original completed/released StoredModelProbe → fresh member child, which must receive the exact verified original descriptor pair. No new ordinary-to-coordination handoff is needed for this slice. Repeated reads in the same original transform retain the same private prepared proof and direct-currentness evidence; changed original files invalidate the capture, rather than prompting new KDF work in polling. A later GET may compute a fresh transient MAC for its own method/deadline after exact native material/currentness comparison, but must not derive a new durable proof or reuse a POST's MAC. Failed or cancelled original preparation cannot be retried by a later request in that same capture.

Markerless retained v1 chooses the existing legacy comparison only after the original owning receipt/checkpoint has been validated. Legacy live observations are not new v1 durable writes. When exact original encoded evidence exists, retain those exact bytes. A plain legacy checkpoint stays plain; any legacy material comparison needed to verify its old scope remains transient and must not be presented as a newly persistable v2 proof. A separate private legacy-continuation mode is required; absence of a protected descriptor alone must never select legacy for a fresh operation.

The concrete legacy transport choice is to reuse the existing strict v1 wire schema as a transient observation, with no third witness schema. A private explicit `acceptLegacyContinuation(source, observedV1, issuer/current, originalScopeDigest, originalEncoded?)` path applies the existing descriptor/dependency/issuer checks and requires the exact original scope. Any optional `originalEncoded` must already be independently validated original evidence for that same scope. The nominal instance retains only that original encoding, never the just-observed v1 wire. Preserve the existing `encoded: string` caller contract using a getter that refuses when there is no original durable encoding; `scopeDigest`, nominal selection and synchronous file currentness remain available. Thus a plain original checkpoint can satisfy the pinned synchronous acceptance callback, but cannot accidentally provide a new durable v1 encoding. Fresh ModelProbe construction explicitly selects v2 before child creation, while the checkpoint wrapper's already selected plain-original branch keeps plain native checkpoints and never reads that getter. No ModelProbeOwner or pinned SDK API change is required for this distinction. Missing or corrupt protected evidence cannot enter this legacy path.

Cold protected acceptance is asynchronous only at the already owned preparation/restore boundary. It derives the files proof with the original descriptor, verifies metadata and scope, and trusts the key proof only through the original authenticated issuance retained by the validated owning receipt/checkpoint. It does not know or derive K. It rereads and compares the exact original owner record after the await; checking only a captured object is insufficient. After this verification, the nominal Accepted instance retains bounded private currentness observations and uses synchronous direct-byte/private-hash comparisons without more KDFs.

#### 6. Native Effect order and cancellation

`OpenCodeV2NativeFileKey.materialize` currently goes from native ConfigVariable substitution directly to `Effect.provideService(app, ..., captured.request)` and only then issues the v1 witness. The v2 order is:

1. Preserve the current authorized request, canonical shape, exact deadline and one-shot POST `attempt.spent` admission. No change to native routing or request-fiber ownership.
2. Run the real pinned native ConfigVariable substitution through the captured FS service. Validate the materialized key and exact captured dependency set; retain bounded private input bytes only for proof preparation.
3. Await sequential key/files proofs through `Effect.tryPromise({try: (signal) => PromiseLike, catch: (error) => maskedError})`, in the same original request fiber, before invoking app/Connect. Do not put a Promise inside `Effect.sync`. Root verified the official Effect4.0.1 tag at commit `460272d30457f4697d8b8c52cad41caccbcace08`, Effect.ts blob `a4da72c9b1a28946ef9a5af068f502810b75e76e`: this overload exists and aborts its supplied signal when the fiber is interrupted. The async work must itself observe that signal. Add a runtime function check in the native transform's existing verified-module guard. This is exact API/source verification, not qualification of Bun's crypto callbacks or the delivered request lifecycle.
4. After derivation, check original lifecycle/request abort, exact deadline, descriptor/source currentness, all captured file/chain identities and bytes. Prepare the transient MAC and the final size-checked live encoding before app/Connect. Check again immediately before the original app effect, without another await or owner reselection.
5. Invoke the original app exactly once with the already materialized key request. On the existing success shape only, perform the final original-current checks and synchronously seal/return the prepared wire witness. No KDF may newly fail after a successful Connect. The original native response/error mapping and cleanup ownership remain intact.

KDF failure, busy, expiry, or cancellation before step5 leaves app invocation count zero. The spent POST is not automatically retried. Cancellation must fence the continuation immediately; queued/active crypto may settle later, but it cannot call app, emit a witness, rewrite an original record, or create a new capture. The G1 helper retains its queue/byte permit and clears its buffers only on the actual crypto callback; do not release its accounting merely because the Effect request stopped waiting. Native physical cleanup remains the original owner path.

#### 7. Exact serialization and work bounds

The same strict 65536-character base64url cap permits at most49152 decoded bytes. The v2 live object above removes four old 64-hex descriptor/source/namespace/auth fields, the old materialized-key digest, provider/model/cwd duplication, and one 64-hex `sha256` per dependency, while adding two fixed proofs, method/deadline and a MAC. With identical metadata/issuer, the maximum 16-digit safe deadline, POST, and the shortest legal provider/model/cwd values, v2 live JSON is **86 bytes smaller** than v1 for one dependency. Each additional dependency saves another76 bytes. Longer removed provider/model/cwd values increase the saving. Thus this exact field layout fits every formerly accepted v1 metadata shape without increasing the wire cap. This is an ASCII field-overhead calculation, not a cryptographic or native execution result.

The strict descriptor JSON remains <=65536 bytes. Let dependency metadata JSON be bounded by49152 bytes before adding file bytes, total observed file content U<=262144, and n<=32. A conservative base64 bound is `4*ceil(U/3) + 4*(n-1)`; adding `bytes` costs11 bytes per file. The files-KDF canonical input is at most:

```text
79 + 65536 + 49152 + 11*32 + 4*ceil(262144/3) + 4*31
= 464771 bytes
```

The key-KDF preimage is at most131135 bytes, allowing the worst JSON escaping for a key whose UTF-8 bytes are <=65536. The MAC preimage is at most513930 bytes when also conservatively counting the complete live wire and repeated metadata. These bounds are below the existing G1 aggregate8MiB retained canonical-input limit; they do not alter its one-active/eight-queued limit. They are upper bounds derived from the chosen schema, not unexplained new input caps. Field changes require recalculation.

Preserve the existing <=64 native dependency reads, <=32 distinct files, <=64KiB per file and original256KiB substitution-plus-final-verification accounting. A new pre-effect reread after async KDF cannot be silently charged a third time to that original accumulator: that would reject previously valid sources. A narrow explicit option is to reserve the original final reread budget before deriving (`R + U <=256KiB`), where R is native substitution bytes and U is unique captured bytes, then bound the **additional pre-effect verification pass** separately by U. Since R>=U, U<=128KiB and total child file-read work becomes at most384KiB while the original accepted input budget remains unchanged. Cold parent can verify and then reread the same U within a bounded256KiB two-pass check. This additional verification-work accounting must be explicit in the implementation plan; do not claim that an extra pass is free or that the original total-I/O count is unchanged.

A parent Accepted instance need not retain raw key-file bytes for its lifetime. It can capture private in-memory exact-byte observations/SHA values during the authenticated live read or verified cold read, then wipe transient buffers. Those observations are never serialized, never used as another durable proof, and never create a global raw-secret cache.

#### 8. Required negative and boundary tests (design only)

- Reject every v2 durable object containing descriptor/source/namespace/auth digest, dependency sha256, materializedKeyDigest, issuer/reference/request/mac, unknown field, malformed descriptor, wrong KDF version, noncanonical base64url/JSON, duplicate dependency or over-budget metadata. Inspect actual durable ModelProbe evidence and checkpoint payloads, not only the codec return value.
- Same original policy/material in different child nonce/PID/password yields the same durable scope, while its live MAC cannot cross child/ready/nonce/reference/integration/request method/deadline. Foreign/mismatched proof is refused before parent evidence publication. A changed model/provider/source or dependency never borrows the old original policy by display name.
- With controlled KDF settlement: cancellation, request abortion, deadline expiry, source drift, changed file bytes, symlink/chain/inode change, or read failure before app means zero Connect/app invocations and zero witness publication. Busy/failure cannot reset `attempt.spent` or trigger retry.
- A source change while the original app is awaiting, or between child seal and parent acceptance, refuses the proof and preserves original cleanup; it does not infer that native Connect had no effect. The parent callback remains synchronous and returns undefined only after success.
- Retained cold validation reads original descriptors and bytes only, never invokes ConfigVariable, reads native materialized K, Connect, or another native session. Replacement/deletion/phase/resourceHeld change of the owning record during the await holds and preserves original bytes.
- Corrupt or absent protected wrapper cannot downgrade to legacy. Original v1 bytes remain unchanged and plain legacy checkpoint continuation remains plain. A fresh operation cannot choose the legacy branch from a missing policy.
- Repeated currentness and repeated original-read checks perform no KDF. Ordinary selected-file readiness → member handoff and native cold restore preserve the original descriptor pair and scope without carrying a stale operation-authority callback. Keep the actual selected-file no-coordination-child control unchanged.
- Exercise the current legal64KiB single-file boundary, repeated reads near256KiB original accounting,32 dependencies, deep metadata near the exact65536 encoded limit, worst escaped descriptor strings, and independent proof queue accounting. Prove no input regression from the extra pre-effect verification pass.
- Qualify the real delivered Bun runtime's fixed scrypt parameters/callback lifetime and the exact Effect4.0.1 async interruption behavior. Node-only helper timing or mocked Effect success is not native qualification.

#### 9. Direct serialization/issuance file boundary

The smallest directly required source set for this section is:

- `adapters/providers/OpenCodeV2SelectedFileKey.ts`: strict legacy/durable-v2/live-v2 codecs, original descriptor pair, pre-effect preparation, private currentness observations, transient MAC acceptance, exact durable allowlist, asynchronous original cold verification. Existing functions are `createOpenCodeV2FileMaterialization(source, check)`, `AcceptedOpenCodeV2FileKey.accept(source,encoded,issuer,current)`, and `retained(source,encoded,assertOriginalReleasedRecord)`.
- `adapters/providers/OpenCodeV2NativeFileKey.ts`: extend the local Effect type/guard with the exact tryPromise API; add original policy input and the pre-app asynchronous stage to `createOpenCodeV2NativeFileTransform(input)`; retain one original selected proof/policy across that transform's reads; synchronous final sealing.
- `adapters/providers/OpenCodeV2EmbeddedChild.ts`: the existing `input.selectedFile` decoder currently permits exactly `{descriptor,mode}`; explicitly add and validate the original private policy field before passing it to the transform. Merely changing the parent type is insufficient.
- `adapters/providers/OpenCodeV2EmbeddedServer.ts`: private `selectedFile` option/child init carries the original policy; `selectedFileKey(ready,integrationId).acceptProof` binds the existing password and original expected request without exposing them to durability.
- `adapters/providers/OpenCodeV2SessionCredential.ts`: supply known expected GET/POST and original config deadline to private acceptance; keep pinned callback synchronous and preserve its literal undefined return; carry the nominal original proof through the existing one-shot preparation promise.

Readiness, checkpoint wrapping/unwrapping, original ModelProbe evidence rereads and the optional MemberProviderContext proof are the coordinator's complementary handoff manifest. No direct changes are required here to generic digest functions, the G1 helper, OpenCodeV2CredentialScope, the captured configuration parser, vendor/native pins or the798-line OpenCodeV2MemberProvider. The runtime graph verifier already pins Effect4.0.1; checking its async export belongs in the existing transform module check.

Implementation confidence is high for the codec/preimage/size separation and the synchronous-parent MAC route. The original multi-phase policy/checkpoint handoff and delivered Bun/request lifecycle verification remain explicit required gates; this section does not claim them already executed.

## D. Combined production manifest and size review

All paths below are relative to packages/legacy-agent-host/src. The candidate has **21 production paths: 20 existing plus 1 new account helper**. The exact lifecycle work is specified in section A4 and remains subject to complete plan review; no further path is implicitly authorized.

| Path | Purpose | Estimated changed lines |
| --- | --- | ---: |
| adapters/providers/OpenCodeV2SelectedFileKey.ts | Strict v1/v2/live codecs; two slow proofs; transient MAC; nominal cold proof/currentness | 240–340 |
| adapters/providers/OpenCodeV2NativeFileKey.ts | Exact Effect.tryPromise stage before app; original policy; one prepared transform | 55–85 |
| adapters/providers/OpenCodeV2EmbeddedChild.ts | Strict selectedFile policy init forwarding | 10–20 |
| adapters/providers/OpenCodeV2EmbeddedServer.ts | Original policy/password/request binding; fresh/default vs retained mode | 25–45 |
| adapters/providers/OpenCodeV2SessionCredential.ts | Synchronous private acceptance with method/deadline and nominal proof | 10–25 |
| adapters/providers/OpenCodeV2EmbeddedMemberProvider.ts | Readiness proof selection; strict checkpoint wrap/unwrap and actual reread | 90–140 |
| adapters/providers/MemberProvider.ts | Optional private nominal proof only | 3–6 |
| composition/openCodeProbeAccount.ts (new) | Move existing account observation; async original file-proof preparation and sync use | 220–300 total, about160 moved |
| composition/prepareTeamModelReadiness.ts | Prepared pair propagation, exact original sync qualification, early/final slot predicates and action placements | 120–180 plus extraction |
| composition/MemberEntry.ts | One private current invocation handoff slot | 4–8 |
| composition/createRuntimeMemberProviderFactory.ts | Take original slot before await; bind material to new factory authority/context | 15–30 |
| composition/createRuntimeTeamLaunch.ts | Non-consuming preclaim proof read and exact scheduled-opening cleanup/forwarding | 25–50 |
| composition/RuntimeTeamCaptures.ts | Await original capture qualification before capture publication | 3–8 |
| composition/executeRuntimeLaunch.ts | Start/retry preparation and original replay ordering | 20–40 |
| composition/executeCapturedRuntimeControl.ts | Initial/fresh open async proof boundary | 15–30 |
| composition/executeMemberAction.ts | Await original Restart proof before Stop; carry private new target proof | 15–30 |
| composition/executeNativeMemberAction.ts | New retry original preparation, exact replay preserved | 10–20 |
| composition/createRuntimeNativeMemberCreation.ts | Existing async preflight/attach/open private pair | 8–18 |
| composition/preflightNativeMemberModel.ts | Return prepared pair after original probe settles | 5–12 |
| composition/executeLiveRosterMembership.ts | Existing flight's private proof forwarding | 10–22 |
| composition/initialRuntimeModelAdmission.ts | Original local-readiness async attach; bootstrap unchanged | 20–40 |

Planning estimate: approximately 1050–1600 touched production lines including the single extraction; expected net addition is smaller. These are estimates, not a size gate exemption. Keep every production file at or below 800 physical lines. The account extraction is needed because prepareTeamModelReadiness.ts is already 773. Its removed account block must leave room for the A4 pure helpers; do not create a second lifecycle owner to meet the limit. SelectedFileKey is 294, EmbeddedMemberProvider 342 and EmbeddedServer 476 before this plan; the proposed work fits their existing modules without a new serialization owner.

No production change is currently needed in ModelProbeOwner or commandRecords: both import the selected-file witness codec, which validates exact retained v1/v2. Their public snapshots already omit the private witness. No change is intended to OpenCodeV2ModelProbe or OpenCodeLocalModelReadiness if the existing nominal observation API is preserved. Tests must prove that assumption; a discovered caller requiring an additional production path must be reviewed before implementation.

## E. Finite verification manifest

Add one focused native-file-witness unit suite if the existing mixed configuration fixture would make failures ambiguous. Update only the existing callers of the affected private APIs in these suites:

- tests/opencode-configuration-source.test.ts: strict legacy/v2 fixture encodings, exact cold source bytes, schema and boundary vectors.
- tests/opencode-v2-credential-scope.test.ts: same-child synchronous callback, expected GET/POST/deadline, old managed/API-key controls.
- tests/saved-team-model-probe.test.ts: actual StoredModelProbe durable publication and post-KDF replacement/deletion/held-state barriers; coordinate the test path with its existing external owner.
- tests/runtime-team-host.test.ts: actual released probe to fresh member handoff; launch/preclaim/retry/source drift; original generation and duplicate replay.
- tests/native-member-actions.test.ts and tests/native-member-creation-runtime.test.ts: source proof before Stop, selected-generation transfer, native creation private forwarding.
- tests/runtime-checkpoint-read.test.ts plus the existing embedded provider fixture: actual authorized Runtime envelope, post-KDF checkpoint reread, unchanged inner pinned codec and no child on refusal.
- tests/opencode-v2-embedded-server.native.ts: delivered Bun/Effect request lifecycle, two slow proofs before Connect, synchronous parent MAC, repeat original GET, original cleanup.
- A small focused tests/opencode-v2-native-file-witness.test.ts may hold codec/KDF/deadline and scheduled-handoff regressions rather than duplicating large Host fixtures.

Expected new/updated tests are approximately 650–1000 lines across these named fixtures; fixtures may be split only after source review if their own readability or test-file budget requires it. This is not approval to run a native suite against user credentials. Use isolated TEST files, namespaces and the existing captured process cleanup.

Required baseline RED is against unchanged checked source/dist, and must distinguish an asserted product failure from setup/resource failure. At minimum demonstrate the current durable fast fields and original-salt member mismatch with a controlled policy-aware fixture before implementing the new codec. Save exact original v1 witness/checkpoint bytes as compatibility vectors.

After implementation and independent exact-diff reviews: canonical Host build, scoped strict fixture types, changed Node cohorts serially, existing ordinary/model/currentness/checkpoint/native-action controls, source-size guard and diff checks. Then qualify the actual delivered Bun/Effect path with original native cutoff and cleanup. The previous Node helper timing and unrelated TEST Desktop E2E are not a native proof for this feature.

Mandatory cases include:

1. Durable ModelProbe and Runtime checkpoint contain only the v2 allowlist; no live issuer.reference, tag/password, fast key/file/descriptor/source/auth digest or raw material survives. Check containing persisted JSON, not only a returned string.
2. Fresh selected-file probe publishes only after successful ordinary native evidence and confirmed release. Selected-file readiness does not create a coordination child.
3. Same original policy/source in different child processes/passwords gives the same scope; a fresh independent original gets fresh policy. Wrong model/provider/source cannot borrow a valid proof.
4. A retained ModelProbe deleted/replaced/changed during crypto, and a checkpoint deleted/replaced during crypto, refuse after actual reread. Zero child/Connect/Stop where the original action has not yet crossed that effect boundary; preserve unknown custody after an effect actually began.
5. Synchronous readiness and currentness calls perform zero KDFs. An action's prepared proof cannot carry an old generation's authority into the selected generation.
6. Initial native-bootstrap, initial native-local-readiness, full capture/Create, worktree continuation, fresh runtime.open, launch/retry, native Restart/add, live membership, normal checkpoint and closing checkpoint each exercise their exact existing owner path.
7. Scheduled start/retry returns before runtime.open; handoff survives that scheduling gap under the exact A4 keeper. The A-queues/B-resumes/A-factory race, initial claimed/no-Runtime-row admissionOnly race, all-target preflight, failed authority before runtime.open, worktree failure, seal/expiry, cleanup read failure and later-slot replacement each preserve the original proof/consumer and callback invocation count. No valid pending slot may be overwritten, even with equal material.
8. Legacy original bytes remain unchanged, plain legacy checkpoint continuation stays plain, and new operations cannot select legacy from missing v2 fields. Live legacy representation and persistence refusal must be explicit.
9. Exact wire65536, outer66026 compact/66070 pretty, per-file64KiB,32 dependencies and original256KiB admitted-read controls; separately prove the accepted extra pre-effect verification work cannot exceed384KiB and does not silently reduce the old accepted source range.
10. Original KDF queue occupancy/buffers survive cancellation until actual settlement, with no late app invocation. No request deadline, probe cutoff or launch lifetime is restarted.
11. Replaying an already completed launch/retry/action does not hydrate or reissue a proof unnecessarily. A missing original proof holds under that original command; it never starts a replacement model probe.
12. Actual normal small/non-file and legacy V1/V2 provider controls remain unchanged.

## F. Remaining review and execution gates

- **Publication before implementation:** R1 coordination design, root R2 and independent provider R3 have approved the complete design. The reviewed version includes the A4 early/final guards, attempt/reference keeper, original progress forwarding and A5 policy modes; the last Host-provenance/catalog qualifications were separately confirmed by R3. Production still waits for publication and finite baseline evidence. Public-response finally alone remains explicitly rejected.
- **Legacy execution qualification:** the selected design reuses the strict v1 wire only as an explicit original legacy observation. acceptLegacyContinuation requires the original scope; Accepted.encoded retains only independently validated original bytes and throws when a plain checkpoint supplies none. Verify this separation with the actual pinned callback before claiming compatibility; the API design itself is now specified in section C.
- **Budget qualification:** one fresh native issuance uses two KDFs; a cold parent verifies one files proof. Multi-member original capture may require several independently salted original proofs. No new catalog preparation protocol or timeout is part of B. Measure the explicit consumer paths under their original deadlines and retain truthful holds; do not claim all maximum-size rosters fit from the one/eight-proof Node microbenchmark.
- **Delivered runtime:** verify fixed options/callback settlement and Effect interruption on the actual pinned Bun child. Official Effect API source verification alone is insufficient.

Before implementation, record the exact final manifest, independent design verdicts and original source hashes in this same plan and publish it. Baseline RED and postimplementation runtime/strict/native qualification then run in the stated order; none is already claimed by this document. A concrete delivered-runtime incompatibility must hold and return to review, not trigger a pin, deadline or wire-cap change. The Family C artifact-adoption/Main original-reference work remains a separately retained design and is not implicitly authorized by Family B.

## G. Review record and exact source baseline

R1: coordination audit assembled the original-readiness/checkpoint/lifecycle contract, incorporating the provider-reviewed exact crypto section. R2: root approved the complete A1–A5 design. R3: independent provider review approved plan `f911b6bb30df6f02f422df39739d6e87e45679220cb9f006e9dfa25e98197472` and then explicitly approved the Host-provenance, catalog pass-through and missing-handoff qualifications included above. These are design/source verdicts, not execution results.

Baseline is local commit `533d955b28493cf9549a4e6b88684852df835628`. The following are SHA-256 hashes of the exact 20 existing production files reread before publication; the single proposed new helper is absent. Registry/process work in other paths is independent. A changed source or additional path requires reconciliation and review before implementation.

| Path under packages/legacy-agent-host/src | Original SHA-256 |
| --- | --- |
| adapters/providers/OpenCodeV2SelectedFileKey.ts | `1faadc0506916a9dbe9bce53158409ad35a3d86979f4566e41cee41890b0154b` |
| adapters/providers/OpenCodeV2NativeFileKey.ts | `f6dc8b2713e2d31b4e26b29d460df796dcc5c13f86bc82eea728c7c66a34cbb8` |
| adapters/providers/OpenCodeV2EmbeddedChild.ts | `a5a3a72b403f03540075d79c88f0f32ed052c9bcc8d02e18dd68c20601df897f` |
| adapters/providers/OpenCodeV2EmbeddedServer.ts | `44eefe4131b919220cd870054fbe6fea0008e225013ee236a03ce4b5725de4ea` |
| adapters/providers/OpenCodeV2SessionCredential.ts | `a1181f28e9a6ad3b4ca559aeed253713c2da523997a299e11f106b7ebe277abe` |
| adapters/providers/OpenCodeV2EmbeddedMemberProvider.ts | `5fe579d3be06501147fa7833583e70226db36e12f64f8ab4b3a7ecaef5c587b5` |
| adapters/providers/MemberProvider.ts | `69cdcdaf511463525feb8678392d2e9b18d9a1b039e87eb625f6e1b542575267` |
| composition/openCodeProbeAccount.ts | New file; absent in the reviewed baseline |
| composition/prepareTeamModelReadiness.ts | `6a6b90e07eb829fb7150b6eb749ba19f82dde5e1470500c5bdaebf57fea82e70` |
| composition/MemberEntry.ts | `8de4e8843f99af27c15378670f674da301048e3c6f8306eeadb7469b1a209a5c` |
| composition/createRuntimeMemberProviderFactory.ts | `0377832ad830c1b2dc80dbd18f5f6983eeb007f79bac411a07fb712100797ce5` |
| composition/createRuntimeTeamLaunch.ts | `ca08d8b8df706da5cced63fdf51b3088b24889128e7f29b0aab330c616cfa232` |
| composition/RuntimeTeamCaptures.ts | `3d01100e957f1712df571080507553bab67e7f2790c934b97dfed5647103ff85` |
| composition/executeRuntimeLaunch.ts | `6ff91cfd79f5bb5f2194bac43785bd3c0a2fea874cc121e111a9a0daacf0bb32` |
| composition/executeCapturedRuntimeControl.ts | `22b43537721479dd77378bdd548811e5b084186102e7e09beb2d9f61dec131bf` |
| composition/executeMemberAction.ts | `7f8a4ef3c53b9acd0f67d55b2000094e8a7f4ebad14a0defa0351e89181cb0f1` |
| composition/executeNativeMemberAction.ts | `65747ec7dae448043a684c146ddc8ddabb0cf90534fb4e97c506287ed1d346a2` |
| composition/createRuntimeNativeMemberCreation.ts | `a984f636145eefcfd919d3f9823d6ac66b6ba0a9d6d67495518a601ec50d05e2` |
| composition/preflightNativeMemberModel.ts | `038aee06655d18d7cd9c20227aae30c5100c8d0da4fb5d60ba6e0c2acd1a828a` |
| composition/executeLiveRosterMembership.ts | `1e2082ed1b97cc05c47918fa40521b729474d745cdd29db36e9741ab66930e0d` |
| composition/initialRuntimeModelAdmission.ts | `64bbdecdee4113344cda0ab3810e416fde750f80ca45ca563550752137479010` |
