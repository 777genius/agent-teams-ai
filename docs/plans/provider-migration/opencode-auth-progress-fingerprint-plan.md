# OpenCode credential progress fingerprints

## Purpose and boundary

This repairs the existing OpenCode V2 credential command journal in PR #982. On source tree `0693a1d02107b7b68f07671d5bb44bc0adb31393`, `OpenCodeV2CredentialScope.selected()` creates a fast identity containing the selected auth key; `OpenCodeV2CredentialOperation` persists it as `beforeAuthDigest` and `authDigest`. Those extra durable witnesses permit cheap guesses of low-entropy keys. The live captured identity also serves other consumers and must remain byte-for-byte unchanged.

Protect only the new credential-progress witnesses with the existing bounded asynchronous secret-fingerprint helper. Preserve original command identities, native ownership, corrected Connect after a confirmed rejection, read-only legacy replay and the existing public projection. This is not a new Connect action or a new credential store. Do not change `managementDigest`, `Scope.selected/capture/prepare/write`, native SPI, runtime/dependency pins, default Host activation, or CI rules. Do not migrate old receipts.

This family-A repair does not close the separate selected-file/session witness family or prove a mapping to the historical eight CodeQL flows. The open CodeQL finding requires its own source-coordinate review; no suppression or dismissal is part of this work.

## Private representation

Extend the existing nested `OpenCodeV2CredentialProgress` with optional `authWitnessKdf`, using the existing strict `{ version: 1, salt: 32 lowercase hex characters }` schema. One descriptor belongs to the entire original progress chain. The canonical preimage is:

```ts
{ kind: 'opencode-v2-auth-witness-v1', digest: captured.digest }
```

Fresh `key-intent` creates a new descriptor. The after-publication witness uses the same descriptor with the actually published capture. New progress contains only these KDF outputs; it must not retain a parallel fast digest. Descriptor, before witness and an already published after witness are immutable across phase advancement.

Do not bind this preimage to a new profile revision or command ID. The current captured digest already binds account, provider, roots, directory identities and key. Existing receipt/target checks provide command authority. Adding a new revision to the preimage would break the supported same-account corrected Connect through a newly captured source profile.

Strictly validated markerless originals retain their old comparison semantics, read-only. Unknown versions, malformed salts or added KDF options are rejected; they are never interpreted as legacy. New progress publication requires the descriptor. A legacy progress record may be read but cannot acquire, remove or change a descriptor during an advance.

## Source ownership and ports

The production manifest is limited to six files:

1. New `packages/legacy-agent-host/src/management/openCodeV2AuthWitness.ts`: pure domain-separated derive/compare helper, no cache, queue or custody state.
2. `management/openCodeV2CredentialRecord.ts`: strict descriptor and phase invariants.
3. `adapters/providers/OpenCodeV2CredentialOperation.ts`: before/after derivation and existing-operation fences.
4. `management/CredentialCommandOwner.ts`: awaited validation and original durable write fences.
5. `composition/ProviderManagementCoordinator.ts`: original rejected/successful receipt verification.
6. `adapters/providers/OpenCodeV2ManagementHost.ts`: awaited catalog proofs and original native deadline guard.

The existing owner's `perform` port gains a fourth synchronous `assertOriginal()` argument. Coordinator includes it in the existing captured-operation `current()` closure; no new state owner or callable-progress protocol is needed. The private `OpenCodeV2KeyOperation` supplies `assertCurrent()` for its same signal and deadline. The private catalog `connected(providerId, source)` callback receives the already captured `CapturedOpenCodeV2Key` and returns an awaited `{ connected, assertCurrent }` proof. It does not recapture another auth observation. Public DTO/RPC shapes remain unchanged.

Coordinator is currently 734 physical lines with an unchanged 800-line cap. Keep reusable pure verification in the new helper. Do not raise a cap or create a second admission owner to make the change fit.

## Required sequencing

### Validation and claim

Read the original command ID before fresh validation, as today. Await validation, then check writer, exact captured target and absence of an intervening original command immediately before reserve. After the existing command-fingerprint KDF, retain the current target/ID checks before claim. A changed original never falls back to a fresh claim. Repeat replacement authority verification in `performCredential` after the command-fingerprint await and original catalog cleanup. Preclaim validation cannot simply move after claim.

### Registered operation and native effects

Derive the before witness as the first await inside the already registered `operation.run()`, before `host.keyOperation()` or native allocation. Seal/close must still fence that operation while crypto runs. After derivation, check the original owner, auth capture and durable receipt. Crypto completion cannot allocate after cancellation or replacement.

After the existing native read, publish the protected `key-intent` before `connectKey`. Preserve `key-connected` and the current atomic auth publication. Capture the actual published auth, derive its witness using the original descriptor, then recheck the same native signal/deadline, owner, auth and receipt before publishing `key-published`. Continue the original verification flow only after those checks.

A derivation failure after publication does not undo a confirmed native connection or imply verification rejection. Report held/unknown honestly, retain actual cleanup custody, and never repeat connect/probe or roll back someone else's replacement.

### Durable publication fence

Keep the last confirmed durable record separate from a candidate next record. Before every progress, terminal or catch write, fully reread and compare the original command against that expected record. Advance the expected record only after a confirmed write.

Read failure, disappearance, replacement, or a lost write acknowledgement makes publication uncertainty sticky. Catch must not overwrite the changed original with a local held record. An uncertain original cannot release its reservation based only on an otherwise clean native result. This is a narrow fence in the existing owner, not a new recovery protocol.

### Corrected Connect and catalog

`replaceableV2Auth` retains the current resource/account joins, retained-profile revision checks, unknown-intent rejection, strict `finishedAtMs` ordering and exact terminal rejected probe requirement. Capture the original state before deriving, then reread the full original receipt and repeat namespace selection after the await. Verify captured auth currentness. A successful comparison returns only the transient old `capture.digest` to unchanged `Scope.prepare()`.

Catalog derives only for a qualifying completed/probe-ok original. Process proofs sequentially within the original catalog deadline and bounded crypto queue. Recheck receipt, writer, source and target after each await. After the final await, including native dispose, recheck every earlier proof and auth capture before returning any `connected:true`. Proofs live only for that one request; there is no cross-request cache or background verification.

## Finite regression and delivery gates

All fixtures use TEST roots, the real FileManagementCommandStore and controlled native boundaries. No vendor CLI or genuine native acceptance is claimed.

- Short-key and absent-before fresh progress: independently reproduce the KDF vector; inspect durable bytes for raw keys and parallel legacy fingerprints.
- Descriptor/phase immutability, malformed versions/salts/extra fields and strict new-progress admission.
- Exact markerless cold lookup/replay and corrected Connect without rewriting the original; keep command-fingerprint and auth-witness descriptors distinct.
- Same-account revision correction and rejection for different account/HOME/directory/key, later success, ambiguous timestamp or unknown intent.
- Validation/claim and registered-before-proof barriers: revoked writer, target drift, intervening command, busy/failed derivation and seal/close have no late native effect.
- Original receipt replacement/deletion/corruption and write-before/after-commit failures cannot be overwritten by progress, terminal or catch paths.
- After-publication failure preserves actual auth bytes and never invents terminal rejection, extra connect or probe.
- Catalog earlier-provider drift during another proof or dispose is rejected; timeout remains the original deadline.
- Public receipts, catalog and safe errors contain no private witness, salt or secret.

Run the meaningful new regressions against the unchanged baseline first. Then use the pinned Node 24.21.0 and native TypeScript 7.0.2 for the Host build, finite focused runtime cohort and exact-options scoped strict checks. Run the unchanged source-size guard. No full compiler retries, dependency changes, vendor runs or manual CI controls are part of this repair. Normal local hooks, independent review, fresh remote collision checks and an expected-SHA non-forced update deliver only to the existing PR branch. Required current-head CI must actually finish successfully.

Design estimate: complexity **7/10**, **220–340 changed production lines** across the six files and **400–650 focused test lines**. These are estimates, not measured changes or execution evidence. The plan was independently traced through the owner, adapter and both journal consumers before implementation.
