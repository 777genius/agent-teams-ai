# PNG Desktop 75cf — bounded failure R1

Source head: `75cf2dcbfe2b540325ea50a022cb5195306a8c59`. Original run `43959134362`, job `133621515593`, artifact `14275365531`; Darwin ARM64, native OpenCode V2 2.1.4 with the original finite localhost model. This is an immutable data/source audit, with no project, provider, GUI, compiler, test or CI execution.

## Established failing boundary

The original warm `native-conversation-ui` failed with `CDP command timed out: Runtime.evaluate`; final validation correctly rejected `INCOMPLETE`. No warm PASS capture or cold readback occurred.

The exact pending expression is the single setup `agentBackend.invoke` for `team.launch.start`, command `TEST-explicit-sandbox-setup-launch`, in `desktop-native-stop-fixture.ts`. Its earlier launch selection and native project `loadModels` occur before `preparation.arm`; its returned response is assigned immediately to `evidence.nativeLaunchResponse`, before other post-response assertions. The receipt contains the armed launch's one ordinary model probe and the matching private readiness command/origin, but contains neither `nativeLaunchResponse` nor `nativeConfiguredPreparation`. Thus the pending stage is not the preceding catalog or subsequent attachment UI.

The unchanged backend order is routing negative probes → native setup → native conversation helper. The six routing probes PASS. `nativeSetup`, `conversationUiProof` and `nativeChatAttachments` are absent; the failure snapshot has no selected Team, Composer, input event or dialog. The retained model has zero business observations, one `TEST-model` probe and zero caught fixture failures.

## What the retained readiness data prove

The exact private model-probe journal is `e852461dc7c0e34c19d770f765c03dc96d6f54e1c40cd493698ae6356e3901c3.json`. It binds the setup command, selected Team/member/roster and ordinary native-local-readiness purpose. Its final retained state is `running`, `ok:false`, `resourceHeld:true`; no final readiness evidence or native-file witness is recorded. The launch ledger still has its initial attempt `not-started` and an admission-only consumer, later retired during shutdown.

The actual source chain is:

1. `captureActionModelReadiness().prepare` calls the existing `prepareTeamModelReadiness`.
2. That starts the private probe once, then awaits `ModelProbeOwner.awaitPrepared`.
3. `OpenCodeLocalModelReadiness.run` awaits the ordinary native probe, then its original close/release, before it can publish a readiness result.
4. `ModelProbeOwner.finish` preserves the original physical cleanup requirement before recording completion and clearing `resourceHeld`.

The current finite response helper recognizes the exact original V2 no-tool prompt and queues its ordinary HTTP 200 SSE `OK`, stop and `[DONE]` response. The one probe/zero failures show this branch was admitted and no synchronous fixture assertion was caught. They do **not** attest peer receipt, native terminal consumption, driver `observe` completion, or physical close completion.

Consequently this packet cannot distinguish a pending ordinary native result from pending original probe cleanup. It establishes no independent await cycle, policy failure, response-shape mismatch or safe behavioral repair. The current readiness cutoffs remain separate from the original CDP command's 30-second budget; no budget increase, asynchronous action replay or post-timeout success is proposed.

## Diagnostics and lineage limits

The three observed metadata children are separate catalog lifecycles. Their ready/released rows have no request join to the setup probe and cannot be assigned to it merely by time proximity. The one static descriptor Runtime record ends closed/released with `nativeReady:false`; it is not a completed native conversation.

The app's requested failure Quit exits 0 with no final process-group remainder. `capturedHostObserved:false` and `capturedHostAbsent:null` remain unchanged. These are not a complete native probe custody receipt.

The existing `agent-teams:opencode-v2:host-probe-close-failed` channel emits only on unconfirmed close. Its currently located subscriber belongs to the native test process's `passive-diagnostics.ts`; the Desktop CLI Host does not inherit that subscriber merely by setting the Main startup diagnostics flag. No such observation exists in this artifact. A future selected passive observation would need to distinguish the **same original** ordinary-result and close boundaries; it must not add a request, timer, retry, authority read or success fallback.

## Source closure

Both original source arrays contain 1,777 identical entries. The principal fixture, model, preparation and probe sources in the companion JSON match their exact captured SHA256 entries. The two newly fetched files are official immutable `75cf` reads.

One concrete validation-only omission is established: `scripts/e2e/comment-notification/cdp.mjs`, actual blob `9397505b7889db88ef103dca62287e3d02a88cc9`, is absent from those arrays. Its default `send` timeout is 30 seconds and `evaluate` awaits the renderer promise. The original stack identifies this library, and the immutable source is retained, but the receipt provides no before/after byte pin for it. A common-roster pin would close that source-evidence omission; it would not repair this pending native readiness.

No source afterimage or proposed plan selection is included. PNG upload, Send, native image consumption, business continuity, Stop and cold readback remain unqualified on this tuple.
