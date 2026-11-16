# Original608 first Models loadView: Main/Host source trace

## Disposition

**The saved evidence does not establish the blocking operation or justify a source fix.** The first Models visit after completed connect-key failed the unchanged 30-second inheritance-card wait. Models was active/enabled, the refresh spinner remained visible, and no public error/warning was visible. No model-test or default-writing operation had been reached. This is a source-bound failure on `608efb78823d7c74b35f8a674fcfb6faea8ecfc5`, job `133062441738`, run `43795234483`, attempt 1.

All 18 reviewed product files have identical blobs in608 and current `ae727104656e2feb288fde84c86cffef313546e1` / tree `4ad86790621c72f1f65ee30fa8229abd03df99de`. The accompanying JSON records full per-file identities and retained evidence hashes. The only reviewed V2 scenario difference is the previously approved read8 owner check described below.

## Exact load path

| Boundary | Source and actual behavior |
| --- | --- |
| Renderer / preload / IPC | The existing hook calls `runtimeProviderManagement.loadView`; `createRuntimeProviderManagementBridge.ts` invokes the existing channel. `registerRuntimeProviderManagementIpc.ts:388–405` delegates to `feature.loadView`; its catch returns a public error only after rejection. `createRuntimeProviderManagementFeature.ts:138–141` delegates to the selected port. |
| Captured Main client | `CapturedRuntimeProviderManagementClient.ts:225–231` awaits the selected capture before `view`. Its `view` at120–179 awaits catalog first, then `selectedPreferences`; ordinary first load has no previous catalog fallback. |
| Main backend / source preparation | `DesktopBackendFeature.ts:555–577,719–767` captures the original context/owner, starts that owner, and, when its handshake exposes runtime.sources, awaits `refreshCapturedRuntimeConfiguration` before creating the management target. |
| Main preparation queue | `refreshCapturedRuntimeConfiguration.ts:12–32` serializes preparation in a WeakMap keyed by the original descriptor selection, capped at32 pending callers. Each queued caller keeps its own capture/guard. Lines35–59 read source.current, attempt original recover, read captured preferences, and publish a configuration only if configuration/preferences differ. The queue wraps this preparation; it does not encompass the later credential or catalog call. |
| Source RPC / Host index | `CapturedRuntimeSources.ts:67–115` sends current on the control lane and recover/refreshConfiguration on the work lane, with original owner/currentness checks. `createRuntimeSourceMethods.ts:17–36` dispatches to the index. `RuntimeSourceIndex.ts:102–122,165–186,244–282` reads current state, recovers unfinished original publication if present, and conditionally publishes configuration. |
| Catalog RPC / Host owner | `CapturedProviderManagement.ts:101–161` sends management.catalog with captured profile/config identity. `ProviderManagementCoordinator.ts:599–627` serializes full V2 catalog reads per profile; the original deadline is captured before waiting on the previous catalog. Lines643–686 select/reuse/close that exact metadata owner. `OpenCodeV2ManagementHost.ts:206–304` retains original native-client, identity, plugins, permissions, MCP, credential, directory, projection, dispose and currentness stages. |
| Final preferences | Only after catalog succeeds, `capturedManagementPreferences.ts:22–37` captures and reads `FileManagedProviderPreferences` and rechecks target currentness. No source evidence places this failed request at that final step. |

## What the artifact establishes about queues

The retained runtime-sources index has exactly one configuration publication. Its matching command is already `published`, `resourceHeld:false`; the two retained credential records are the rejected key and completed connect-key, both on the same runtime-source revision. Thus the archive contains **no durable unfinished runtime.source publication**. It does not record Main preparation-queue occupancy, any particular pending read/recovery, Host catalog-queue occupancy, or the loadView request's entry/return/stage. A catalog process is retained in the process census without an operation/timestamp join; it cannot identify this request's pending stage.

The selected Main Host-request cap is60,000 ms and the selected Host management cap120,000 ms, both longer than the unchanged Models30,000-ms UI predicate. Those bounds permit the observed spinner/no-error state while a request or its preceding preparation remains pending. They are timing context, not evidence of a deadlock, slow filesystem, source-write backlog, context churn, or a reason to change any budget. The logged codexAccount unavailable errors are a separate channel and do not establish the OpenCode loadView cause.

## Difference from read8 and next boundary

The exact V2 test-helper delta is `74c3aadd… → 7f224d52…`: one immediate synchronous `options.assertOwnedRenderer()` after awaiting recorded commands and before the default-row DOM evaluation. That later originalStep/default-row path was not reached at this first Models visit. The correction neither changes the product loadView chain nor claims to repair this failure. The current product chain remains identical to608.

No patch, observer, new timeout, extra read, retry or alternative gate is selected. Preserve this original failure and require the original resulting-source CI journey. Further causal claims require additional actual evidence; this bounded trace is complete.

Review used existing files, immutable tree metadata and read-only Git blob/tree reads. No new API/artifact retrieval, project/import/test/native/GUI execution, canonical edit or Git/index write occurred. One attempted read-only diff found the c5 commit unavailable locally; the comparison instead used the available immutable608 blob and fully pinned currentae bytes.
