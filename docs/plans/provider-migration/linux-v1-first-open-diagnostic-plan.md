# Linux V1 first-open refusal: bounded diagnostic recipe

Status: source-only diagnostic design with historical failing CI/source evidence at d4b1e1c7752cefdf9123f39eb91ecd63fba07be4. The current execution baseline is a37ae337bb2a8939e5970dbb79a9a81730d7835f after the external two-commit/four-path update; recheck actual reviewed ancestry before a later local diagnostic checkpoint. No diagnostic execution, native cause identification, production change or CI rerun is claimed.

## Observed boundary and three distinguishable outcomes

Run 46120686613, Linux job 140904312084, failed the first normal runner case: selector 1.19.4 with OPENCODE_V1_TEST_ACTIVE_UPDATE=1. The runtime.open RPC had ok:true, but the public value had nativeReady:false (opencode-v1-version-host.native.ts269–271). The cleanup assertion later reported Host exit 1. The managed update and later message/checkpoint/version cases were not reached. The small published receipt does not contain the original Runtime projection or stderr diagnostics, so neither failure establishes the underlying readiness predicate.

RuntimeOwner.allocate (254–275) can publish readiness-unavailable after a negative driver readiness/capability check, or catch an exception and publish held/open-unknown/custody:unknown. Public projectRuntimeMember (22–26) adds bindingMatches, provider.isReady() and current-owner gates to record.nativeReady. Thus even a ready durable record can yield public nativeReady:false.

Keep these as separate evidence cases:
1. held + open-unknown: original exception path; correlate existing runtime-open source/phase/category and existing OpenCode opening-stage event.
2. allocated + readiness-unavailable: original checkReadiness/capability refusal; no exception event is promised.
3. durable recordReady:true but public nativeReady:false: original binding/provider/currentness projection; its existing channel identifies the first false or unevaluated gate.
None identifies a specific native HTTP/configuration mismatch without further evidence.

## Existing observation seams and their limits

startHost already accepts onDiagnostic and testImports (native-host.ts210–243). It sends test imports only to the original Host Node process. It does not propagate them into native children. stderr chunks reach onDiagnostic at278–280.

createPassiveNativeDiagnosticCapture already strips all native text, IDs, headers, URLs and profile/configuration hashes, accepts the fixed legacy-agent-host: runtime-open line, and retains only a finite projection under the existing 64 KiB, 512-byte-line and 257-row ceilings. Its child watcher specifically matches OpenCodeV2EmbeddedChild and its request watcher matches V2 /api routes; neither is a V1 native trace. Its first-refusal projector accepts only kind:consumer, and it does not subscribe to runtime-projection.

Two already existing production channels provide the missing fixed observations without changing a predicate:
- agent-teams.legacy-host.first-refusal, kind:opencode-open: phase is exactly configuration, server-launch, native-ready, startup-authority, startup-configuration, startup-delay, session-authority, session-create or driver-readiness; reason is threw. Drop bindingDigest.
- agent-teams.legacy-host.runtime-projection: retain only bindingMatches:boolean, recordReady/providerReady/ownerCurrent:boolean|null, nativeReady:boolean. Drop viewDigest. Null means short-circuit not evaluated, not false.

OpenCodeMemberProvider emits its opening failure before its existing seal/abort/confirmStopped (466–482). The pinned V1 factory also checks readiness inside native.open and may throw before RuntimeOwner reaches its second readiness check (pinned v1-driver-factory.ts48–49). Therefore a Runtime driver-open category:unknown may still be a native first-readiness refusal; do not relabel that as successful native open.

## Smallest useful instrumented candidate

Exactly two existing TEST paths, no production files:
1. packages/legacy-agent-host/tests/opencode-v1-version-host.native.ts
2. packages/legacy-agent-host/tests/fixtures/native-opencode-team/passive-diagnostics.ts

In the passive fixture, add strict own-data projections for the two fixed channels above, each retained at most once for this first-case diagnostic. Keep all existing byte/line/row ceilings; reserve their rows at BOTH emitter and parent reprojector by reducing ordinary-event capacity, not by growing the cap. Re-project in the parent receipt capture. Subscriber/capture errors are caught locally and cannot replace a production refusal or cleanup. No error message, stack, body, path, credential or arbitrary property is emitted.

In the native fixture, import the existing capture, pass the same fixture URL through startHost.testImports, and feed onDiagnostic into the capture with an explicit original Host epoch. Save the first runtime.open public fields BEFORE the existing assertions: ok plus validated phase, sealed, custody, nativeReady, attached and optional fixed diagnostic. Retain the same assertions and do not add RPC retries, sleeps, follow-up native calls or a forced stop to make the test pass.

Capture original host.facts() in a finally around that SAME host.close() so an exit-code assertion cannot skip the observation. Preserve the original cleanup exception and aggregate failure. This is observation after the original close, not a second close or an invented cleanup acknowledgement.

Write a separate bounded TEST diagnostic sidecar at the existing receipt location, with the diagnostic checkpoint SHA, base production SHA, exact build/provider/node/native digests already measured by this harness, first-open projection, bounded channel entries and sanitized host exit/stdout/diagnostic-byte facts. Do not modify the canonical version-receipt schema or count this sidecar as a compatibility PASS. Do not serialize the full runtime.open response or any caught Error object. Sidecar failure must not turn an original test failure into success.

The diagnostic sidecar belongs to this invocation only. Choose a fresh invocation-specific TEST pathname under the existing receipt location and use exclusive creation. Only a successfully written file for this invocation is diagnostic evidence; a pre-existing, partially written or older file is never read back or reused as the current result. Creation/write failure leaves diagnostics unavailable and preserves the original native/cleanup failure and aggregate outcome. This does not create a second native run or change the canonical version receipt.

## Exact-source and reproduction rules

The source guard is decisive: opencode-v1-version-source.ts20–62 includes the entire tests directory among clean exact-HEAD inputs and rejects untracked harness files. An uncommitted instrumentation edit cannot honestly use sourceHead=d4b1. Prepare the reviewed TEST-only change as a normal isolated local checkpoint with its own exact SHA, unchanged production/vendor/lock trees, and the normal hooks. No source-guard bypass, ignored harness override or production predicate change is allowed.

After executor recovery and root's heavy-slot authorization:
- Use pinned Linux x64 Node v24.21.0 and the normal buildNativeV1Host/assertNativeV1Build plus installed-archive census. Record the diagnostic checkpoint and unchanged production tree separately.
- Prepare exactly the first existing runner selection/install case: selector 1.19.4, the AVX2-qualified official package, the existing generation-preserving install selector, exact npm integrity/package-lock verification and original TEST-only environment. Reuse the runner's original phase, not a latest tag or a guessed system binary.
- Execute the existing native test once with OPENCODE_V1_VERSION_HOST_GO=1, OPENCODE_V1_TEST_ACTIVE_UPDATE=1, OPENCODE_V1_TEST_EXPECTED_VERSION=1.19.4, that original TEST package prefix/receipt path and freshly measured source/dist/provider values. Use a direct normal invocation of the existing native fixture after the existing selector/install/build steps, with the exact setup commands preserved in the diagnostic evidence. The two-path manifest authorizes no extra launcher file. If a file-based launcher is actually necessary, first amend/review the manifest to include that TEST-only tracked file in the SAME clean diagnostic checkpoint, and record its exact bytes/SHA; never place an untracked launcher outside the source census to claim exact-checkpoint execution. Preserve the permanent three-case runner and do not silently execute later selectors as part of this diagnostic request.
- Keep the actual runtime.open RPC default 60000 as well as the original test timeout 420000, runner outer 480000 and profile native timeout 180000. No timeout, Node/native version, model/configuration or cleanup-policy change.
- Retain the original first failure and cleanup disposition, then stop. Do not dispatch/rerun a GitHub workflow.
- If the same case unexpectedly passes, record a diagnostic-only positive observation of that exact case. Do not call it an explanation of the original CI failure or a full three-version qualification.

This first run can discriminate the three branches and reveal an existing opening stage. It cannot promise the precise false condition within V1 probe()/verifyConfiguration(), because those boolean returns have no existing per-predicate event. If that is the surviving branch, use the captured stage/currentness evidence to propose one further narrow diagnostic before any fix. The old unpublished diagnostic checkpoint 5c022ac3bbdf93e3dc7d2a042061d5946dbff04b has not been retrieved or executed in this review and is not treated as current evidence.

Current-ancestry qualification: the externally landed update from d4b1 to a37 changes prepareTeamModelReadiness's lazy schema selection and three frontend fixtures. Do not duplicate those fixes. Build the later TEST-only diagnostic checkpoint on the actual then-current reviewed ancestry and pass that checkpoint's exact SHA through all unchanged source/build checks. Record the historical d4b1 failure, current base production tree and diagnostic checkpoint separately. No d4b1 native PASS, dist digest, clean-source assertion or cause conclusion transfers to a37. The source ledger below identifies the files read for this design; revalidate any changed path before execution.

## Exact source ledger

- tests/opencode-v1-version-host.native.ts: 754f3afad53828444de4c7c94bd4b34dd37ca1ae.
- tests/opencode-v1-version-runner.ts: 27d0ce8d8972cee4b23030b4173108c37460f322.
- tests/opencode-v1-version-source.ts: c2195f698772c1723bd7f681797e1f692c35a7f5.
- tests/fixtures/native-host.ts: 025a124b317917cdceb5d6072977bd2d24508cdd.
- tests/fixtures/native-opencode-team/passive-diagnostics.ts: 22a637594a3bdc955c54920cc0415b2da0bbd7d7.
- src/runtime/RuntimeOwner.ts: 6cac6b1afecdefed4aaecb6165ffe9f94cdfb578.
- src/composition/projectRuntimeMember.ts: 1f6f2ce9f10cd7b132978df0bb437c989e1fd98a.
- src/adapters/providers/OpenCodeMemberProvider.ts: 046fa413d99035bf47365efb92c737143f82a332.
- src/diagnostics/runtimeOpenDiagnostic.ts: ce6d3a391af0946c7d41e0dec2d1c40fd3872aad.
- pinned old-provider-implementations@56afd2454368e484b804a21e7784aceabdf2c742 v1-driver-factory.ts: 27db1a74cf2844e1a8853188dd413d6c2a31d034.

All paths above are under packages/legacy-agent-host unless explicitly pinned. Source/design only; no new local or CI result.
