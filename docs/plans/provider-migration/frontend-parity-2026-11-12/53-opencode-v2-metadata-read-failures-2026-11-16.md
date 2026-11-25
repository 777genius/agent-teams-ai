# 53 — Preserve existing OpenCode V2 metadata read failure diagnostics

Status: concrete R1 / exact inert source R2 candidate on `1ef2c16ae547129e6b6ab5c47e03caa6b3f169df`, tree `e46e640469645cdd58cf5d0f7e0064d709940b9e`. The first Plan53 documentary commit `6075b12398a1e8005e80a0f422a745f2605e35d0` was published and fully read back before the incoming Plan50 source child. Amend and independently read back this document before publishing the metadata source child. All five diagnostic source/test preimages and postimages remain exactly as prepared at `24df232166b6ac51817deaccc4a37008ebd971d3`; only the shared workflow composition changes to preserve incoming Plan50. Preserve amended Plan50 `fea4c731b0befea2c3fe5d082a8b138cb03c5cac` and all five of its actual source changes, published Plan51, incoming Plan52 `1a47ede0b6b1430486a160ce107ade5a906120e2` and Windows refusal type correction `80fb692b7e05afec6ddc30a2bc13a0185b071daf`, and all earlier source. This metadata source implementation remains prospective; no metadata source commit or resulting-head execution is claimed by this amendment.

The historical six-source manifest, patch and readback below retain their original 24df preparation identities. The final rebound packet is `final-manifest-on1ef2.json` (3941 bytes, SHA256 `afe29688d5d502c8b040e7aef86badcf3373b70a2de60fe57d874a7707f40c72`) and `final-six-source-on1ef2.patch` (18125 bytes, SHA256 `8752f1c45cadab1e0c011b61f04d559a49b51435c63a17343487913a18f92d3e`). The five production/test bodies are unchanged. The workflow adds only the same three selected operands after all 127 incoming entries. Incoming Plan50's Main stage observer, four tests, single runner flag and three source-roster additions remain exact. This cut adds no further source-roster row or change to the Main observer. The plan was formerly prepared as52 and is now53 to preserve the incoming Windows Plan52.

## R1: measured problem and evidence boundary

The original a07 Host Emulated V2 management job `133387315229`, run `43892535269`, failed the unchanged `original default inheritance` Models DOM wait after 30000ms. The existing renderer observer recorded one current request with a spinner and no public error at the failed wait. The original raw log is 125581 bytes, SHA256 `6f8975052018a688c2e28668961475526f4db89fba7e7ddbfaf26d641b41761b`; its complete receipt is 750382 bytes, SHA256 `1e7691bc70b570b8884d919e687d42273414da08e9d272f18fa102cc38c9e572`.

The exact chronology remains: failed wait at `17:10:06.5189937Z`; original shutdown drain starts at `17:10:06.785Z`; renderer `response-error` follows at `17:10:06.9239460Z`; the last observed directory child is released at `17:10:06.948Z`. The response error is not established as the cause of the earlier wait. The original Host request budget was 60000ms and native management profile budget 120000ms; neither is changed.

The complete owner trace records original Main capture/configuration preparation, captured Host RPC, per-profile Host catalog FIFO, native metadata read and captured preferences. Existing Main diagnostics retain 22 metadata lifecycle observations for 11 original children, all ready/released pairs, on one published source revision. Those observations carry no native read-stage or request correlation. Their profile hash binds `[profileId, configRevision]` of the retained runtime-source revision; it is not a digest of every configuration value.

`OpenCodeV2ManagementHost.read` already computes a first-failure record with 13 closed stages, 19 known reasons plus `unknown`, bounded elapsed time, deadline-expired and aborted facts. Its diagnostics-channel publication is subscriber-dependent. The existing metadata stderr emitter, decoder and Main log retain only ready/released/cleanup-unknown, so this read failure record is absent from the original artifact. This plan preserves that already-computed failure-time record in the same bounded log.

This is an observation correction. It does not select a native catalog, queue, authentication, timing, inherited environment or private-engine defect. A future record can identify the stage of the first caught original native read failure, including its existing aborted/deadline flags. It cannot prove the pending await at the earlier UI timeout, identify renderer request1 among concurrent catalog work, or turn a teardown-triggered error into the preceding cause.

## Finite source scope

Exactly four existing production files, one existing focused diagnostic test, and only the missing operands in the existing Team fast-lint command:

| Path | Prepared preimage Git blob | Prepared postimage Git blob | Physical lines |
| --- | --- | --- | --- |
| `packages/legacy-agent-host/src/adapters/providers/OpenCodeV2ManagementHost.ts` | `384b4c00a05d5886cce267ae76166c93d5892262` | `f050499bc5ef2191460e1d22fa6cda4825a0b000` | 402 → 399 |
| `packages/legacy-agent-host/src/adapters/providers/createClaudeCloseDiagnostic.ts` | `6c8bfdfcf34298a7b513f7a9600301d0256bed32` | `40c4c789266a37daf646ed83bdddf0af8d9b6e16` | 102 → 127 |
| `src/features/agent-backend/main/infrastructure/decodeClaudeCloseDiagnostics.ts` | `b2abe9c933e76f64c5046d3566fa3dd5d2174848` | `f6ae5712311d9d6bbb455d1fb5892db8d41e0ffe` | 198 → 241 |
| `src/features/agent-backend/main/infrastructure/CapturedHostClient.ts` | `6a1c96ed27c412c822e25df22eda858d20bbc6b8` | `c4389ac113de03138fd6a9b4b0c6070fb2f06d86` | 800 → 800 |
| `test/features/agent-backend/claudeCloseDiagnostics.test.ts` | `dfc44a77dc1193ed16ef4a751cfe7c6bac7dfee4` | `3fd06d0f117805e54a0d0ce3d88c5efdfaa516f5` | 135 → 200 |

The candidate bodies are retained in `candidate-v2.json`, SHA256 `70c55dfb367c0d49597b370aec4ecd8bcd07a505f32e1bc52956b7a46070cdcc`, with complete per-file SHA256/Git identities in `manifest-v2.json`. The historical scratch directory name `plan51-metadata-failure` predates the external Plan50 / banner Plan51 numbering reconciliation; the intended plan number is 53.

No new production file, diagnostic owner, counter, request identity, IPC/API payload, cross-layer trace, public contract or provider request is introduced. No broad tracing design is selected.

## Source decisions

1. The original `observeFailure` latch still permits only the first caught failure for an original read. Create its existing finite immutable record once after the existing elapsed-time bound. Copy it to the already-captured metadata emitter independently of whether the optional diagnostics channel has subscribers. Contain the persistent sink separately, then preserve the existing optional channel publication and its existing outer catch.
2. Keep the own-data-property reason reader byte-for-byte. Move only its closed stage type and known reason set into the existing diagnostic helper so producer and emitter share them. Type the exported private reason set as `ReadonlySet<string>`; the runtime set members do not change. The decoder independently validates the private wire boundary.
3. Add one exact tagged metadata shape: captured `profileHash`, `mode`, `providerHash`; literal `stage: read-failed`; existing `readStage`, `reason`, `elapsedMs`, `deadlineExpired`, `aborted`. Preserve the existing 13 stages, 20 total reason values, safe integer range 0..3600000, boolean deadline flag and boolean-or-null aborted flag. No raw error message, stack, path, account value, environment, credential, prompt, response body or native stderr is copied.
4. The failure shape contains no child PID or birth identity. It must remain observable before native readiness. It is not a synthetic ready event and conveys no cleanup or custody authority. Original ready/released/cleanup-unknown behavior remains byte-for-byte.
5. The decoder accepts the new exact nine-key shape separately from the original exact six-key lifecycle shape. Preserve fatal UTF-8 decoding, the original 8192-byte framing bound, malformed/extra-key/oversized discard behavior and contained synchronous/asynchronous sinks.
6. Replace only the existing Main metadata logger callback with a natural closed-union projection. Destructure raw birth before logging, forward the remaining strictly decoded fields, hash actual birth only when present, and retain the existing captured Host PID rule. All previous lifecycle log values remain equivalent. `CapturedHostClient.ts` stays exactly 800 physical lines; there is no blank-line deletion, unrelated compression, extraction, cap exception or baseline change.
7. The existing focused test adds pre-ready and provider-mode failure roundtrips, original captured hash retention after caller mutation, both modes and all aborted flag forms, lower/upper elapsed boundaries, extra/missing/invalid-field rejection, invalid UTF-8/oversized-line continuation and failing sink containment. Every pre-existing lifecycle assertion remains.

## Existing qualification coverage only

All five source/test paths already belonged to the original selected-source freeze. No freeze operands are needed. Existing typed feature lint covers the two Main files, and the complete original safe frontend shards already execute `test/features/agent-backend/claudeCloseDiagnostics.test.ts`.

At aa01 the Team fast-lint command had 123 unique operands. Published Plan51 added two and produced the original 125-operand preparation preimage `2c57fc6733ddc0e0b7f61f8ef56550b1f4ad553a`. Incoming Plan50 source `1ef2c16ae547129e6b6ab5c47e03caa6b3f169df` then added its existing management-client test and V2 smoke, yielding the actual 127-operand workflow `53e17d0c4115fa029e9a12dc55859c52d7f448a3` (106313 bytes, 1370 lines), SHA256 `f8ebc45fe39ae9d94309555316ee4950d7997f2870500645aa6a76b367df251e`. Preserve all 127 operands in their original order. Append only `OpenCodeV2ManagementHost.ts`, `createClaudeCloseDiagnostic.ts`, and `claudeCloseDiagnostics.test.ts` to the same existing command, yielding 130 unique operands. The rebound workflow postimage is `ff94e1d92c82a644a302ef61e64246f919f04d83`, SHA256 `09bfb26561b8d795b511b3e808fe7bcdedeb4cd405587394356b2bf0db828867`, 106573 bytes / 1373 lines. All other workflow bytes remain exact; no current branch authority is inferred from this immutable source binding.

No selector, matrix, test command, runtime, deadline, typed-lint scope or acceptance gate is changed. Complete original Desktop and native results still belong to their exact source; historical a07 failures and current aa01 jobs do not qualify this unexecuted candidate.

## Preservation and review requirements

Literal inert source comparison verified: original own-property reason reader unchanged; all original native awaits, stage assignments after the observer, signal/deadline checks, cleanup/dispose and rethrows unchanged; existing Claude diagnostic helpers unchanged; metadata ready/closed methods unchanged; original lifecycle decoder and framing unchanged; all `CapturedHostClient.ts` text outside its one metadata callback unchanged. This is text verification, not execution proof. The preservation record is SHA256 `666f0282051b56e5f66fd59adbf334eedf3857b4317685f01ba09f3190b52613`.

Independent source R2 must inspect all five complete pre/postimages, the complete workflow amendment on the actual preserved base, type closure, no raw-birth leak, separate sink containment, all old exact-key guards, and the strict 800-line cap. Root must publish the concrete reviewed plan before its source child. Keep current useful original CI jobs running; do not dispatch, cancel or rerun work merely to obtain this observation.

Qualification remains the existing source-size guard, exact build/types/lint, existing controlled diagnostic and owner suites, all original safe frontend shards and the unchanged original V2 management Desktop scenario at the resulting exact source. No local project/provider execution, compiler, test or native PASS is claimed by this packet. A new failure remains a failure; even a useful new diagnostic does not by itself complete the Settings inheritance flow.

## Immutable integration-base readback

The complete six-file current-base readback is `base24df-bindings.json`, 189057 bytes, SHA256 `7f26ee9a2b1c1198d15fe20d74af2e06ef1e5a09203e0d5b52a43e0a1031bfc5`. All five source/test blobs equal the table above; the existing workflow blob is `2c57fc6733ddc0e0b7f61f8ef56550b1f4ad553a`. This verifies the prospective composition on 24df without claiming current primary CI qualification or altering any running original aa01 job.

## Publication and execution limits

The focused diagnostic suite will have six cases: the five original cases plus one emitter/decoder/privacy roundtrip. It does not execute `OpenCodeV2ManagementHost.read` or its native `observeFailure` integration. Original recovery/error-identity/FIFO/cleanup checks and resulting-head native/Desktop CI remain required; none has been executed by this inert packet.

The repository destination is `docs/plans/provider-migration/frontend-parity-2026-11-12/53-opencode-v2-metadata-read-failures-2026-11-16.md`. Publish this document as a doc-only commit first. Read back its complete actual bytes and ancestry and obtain independent actual document R2 before publishing the six-source child. Preserve every incoming change and current useful original job; a stale-base or changed-preimage guard requires rebind and review, not a force update.

## Prospective R1 addendum — closed metadata failures in the existing lifecycle consumer

Status: **INERT SOURCE PROPOSAL; no source application or project execution**. This appendix belongs to the existing Plan53 and preserves its complete `9976d507d19007fe1e98f60f9c7e304ebefe32f8` prefix. The canonical parent, full resulting Plan, documentation tree/publication/readback, and independent R2 are bound by root immediately before any application. Current root-reported `5f300` is documentation-only after `0d24`; all three selected preimages below are unchanged.

### Concrete source defect and selected boundary

Published Plan53 emits a closed `read-failed` metadata diagnostic without PID or native start identity. The existing Main projection adds captured Host PID under the same `Host:OpenCodeMetadata` namespace. Exact helper `31160` reads that line for the selected Host, then asserts seven lifecycle keys before inspecting stage. The new ten-key failure record therefore makes a later lineage read fail, including after an otherwise successful recovery. Independent report `3986719c9a26aa79ae3c6d515a57ab9b855034a9` preserves the full source trace. This is a source-proven observation/consumer incompatibility; no new resulting-source CI result or historical Settings cause is claimed.

The selected change is one branch before the unchanged lifecycle assertion. Only a matching captured-Host record whose stage is `read-failed` and whose exact ten keys/values match the current closed producer/Main protocol is validated separately and excluded from lifecycle events. Validate 64-character lowercase hexadecimal profile/provider hashes, directory iff providerHash is null, all 13 allowed read stages, the 19 existing reason codes plus `unknown`, safe integral elapsed 0..3,600,000, boolean deadline and boolean-or-null aborted. Missing/extra/unknown/invalid matching-Host records still throw. Other-Host filtering stays byte-exact. No raw error, path, key, stack, PID or start identity is introduced.

A valid failure neither creates a profile partition/PID/birth nor retires an already-ready child. The original ready/released/cleanup-unknown protocol, exact seven-key check, original Host/profile/owner/physical birth comparisons, immutable lifecycle prefixes, 128-lifecycle-event cap, 4 MiB combined log bound and physical absence/cleanup oracles remain byte-exact. A failure alone cannot satisfy the existing nonempty lifecycle requirement. It is never release or custody evidence.

### Exact three existing source paths

| Path | Before Git blob | Proposed Git blob | Bytes | Lines |
| --- | --- | --- | ---: | ---: |
| scripts/legacy-agent-host/desktop-opencode-metadata-lineage.ts | 31160baa614a4ecd5cc17fb2078561cad371c06c | 79c288d8cd5f6dc432177a2047ce517f174d11b4 | 17725 | 320 |
| scripts/legacy-agent-host/desktop-opencode-v2-management-records.test.ts | 13229f20c93226ee5b3f4d07516d16f94b0d48d5 | cb02a91e7876b4a9367f3d6b763f56fbe566dd7f | 25809 | 381 |
| .github/workflows/host-emulated-acceptance.yml | ff94e1d92c82a644a302ef61e64246f919f04d83 | a1513210012356a5178620b1f370bd1daf0de9d9 | 106650 | 1374 |

No production provider/Main/renderer source is changed by this corrective cut. The existing helper gains 21 lines; every other helper byte is preserved. The already-run management-records suite retains all seven old cases and appends two actual-parser cases. Required imports add only filesystem/temp helpers and the existing lineage functions. No new module, abstraction, suite, runner or dependency is introduced. The workflow adds only the missing helper operand to existing scoped fast lint 130→131; the test operand was already present.

### Meaningful existing-suite coverage

The new positive case writes the real private app-log framing and calls actual `captureDesktopSourceMetadataLineage` and `assertDesktopMetadataLineageReleased` with constructed original physical facts. It verifies: valid pre-ready and already-ready failures are excluded; an existing ready child remains live and physically required; a failure-only log supplies no custody; cleanup-unknown still refuses; only the matching original released event plus physical absence establishes release; a remaining original PID still refuses. A failure from a different hashed profile does not create a partition.

The negative case supplies malformed failure keys/values, unknown stages, lifecycle-shaped failures and malformed ordinary lifecycle rows through the same actual parser; these must refuse. This prevents a broad `stage === read-failed` skip from passing. It is not a copy of the parser implementation. The first new case is predicted to fail semantically against `31160` at the old exact-key assertion; the negative case preserves refusal. These are predictions only. No local RED/GREEN/test/type/lint/native execution has occurred, and no test count is promoted to observed CI. The inspected lifecycle suite `1e2653` is retained as a reference only and is not modified or newly scheduled.

### Original finite validation and source closure

Use the existing full eight-file Node command unchanged, after its original checkout/install/toolchain and fresh Host/ledger prerequisites:

```sh
node --test scripts/legacy-agent-host/desktop-backend-observations.test.ts scripts/legacy-agent-host/desktop-team-ui-smoke.test.ts scripts/legacy-agent-host/test-child-process-trace.test.ts scripts/legacy-agent-host/desktop-emulated-settings.test.ts scripts/legacy-agent-host/desktop-emulated-codex-catalog.test.ts scripts/legacy-agent-host/desktop-resume-records.test.ts scripts/legacy-agent-host/desktop-captured-app-exit.test.ts scripts/legacy-agent-host/desktop-opencode-v2-management-records.test.ts
```

The existing `pnpm typecheck:workspace` already invokes `typecheck:legacy-host-scripts`; original strict `538fdfe23d7aa6bac6f18a483d5d364aef644a39` includes `scripts/legacy-agent-host/**/*.ts`. Preserve the original dedicated agent-backend types and typed Main/renderer/features/MCP lint commands, scoped 131-operand fast lint and original UI/verifier/native acceptance. Exact full lint argv and unchanged commands are in validation.json. Do not add a separate CI cycle or manual Actions invocation. Root applies only after prospective documentation publication/full readback and independent source/R1 R2; resulting-source original CI owns runtime qualification.

The actual helper is already captured exactly once by integrated roster `083522612dd93e77dbb0e79c966103b03a71fe87`, imported by primary roster `a8be2617b2c765091cecce789f028ef2bf67af60`. No roster edit is needed. The existing test stays in its original full-eight/lint route; original source/context capture remains unchanged.

### Costs and limits

The branch consumes the row already read and parsed by the existing log reader. It adds fixed-field validation and bounded temporary arrays for a valid or rejected failure record; this has real CPU/allocation cost. It adds no file-read call site, polling loop, clock read, timer, wait, retry, native action, admission authority, timeout extension or cleanup action. Existing 4 MiB log reading and lifecycle limits remain. Tests create temporary log fixtures only; synthetic process facts do not establish real process custody. Plan53's added producer failure-path clocks/serialization without channel subscribers remain separately acknowledged. Historical a07 Models wait preceded shutdown and the late renderer response-error; this correction does not identify or repair that historical cause.
