# Plan73 — Original finite Host loss and stale service capture

Status: prospective R1, source not written or executed. Root rebound this exact six-path selection to reviewed delivery `c94e63d68f43393bec42cbaa94826b12b2a9b6cd`, tree `7708e69be7b0242c851616e1f06a88b82868ffd0`, after actual Plans71/72 source gates closed. The original Plan70 feasibility packet remains historical input. All current preimages, 137 fast operands, the published Cold helper/exclusion and all prior gates are retained. Root owns the exact current rebind and every Git mutation; this snapshot is not a future publication lease.

Intended document: `docs/plans/provider-migration/frontend-parity-2026-11-12/73-original-finite-owner-loss-2026-11-16.md`. Intended evidence directory: `evidence/plan73-finite-owner-loss-2026-11-16` under the same frontend-parity directory. Both, and the new scenario source, are absent in the complete, untruncated current delivery tree. Reconfirm absence if the publication parent advances.

## 1. Selected problem and finite scope

P08 W05 requires Host/control loss before resume, around owner installation, and after a tool effect, with cold reconnect, no orphan/input replay, retained UNKNOWN and rejection of old identities by a new generation. The existing finite provider gate exercises original service registration, scoped Stops and cleanup, but does not retain these three additional observations:

1. A real original Host exits after its owner-install callback has completed and before Main forwards physical resume.
2. A real original Host exits after two completed original process-register effects, while the original Runtime input completion remains undelivered.
3. An independently clean, ordinary Codex restart produces a real successor and rejects an unchanged old service capture when submitted under that successor's actual new capability.

These are TEST protocol-peer cases over the existing Main, Host, Runtime, adapters, native broker and original HANDLE witnesses. They do not qualify a genuine vendor CLI, W01, packaged/Desktop recovery, POSIX executable admission, P09, Stage2 or release. Keep `realProviderExecuted`, `desktopQualified` and `releaseQualified` false. The current genuine Claude/Codex discovery, version and execution prohibition remains in force.

The two loss cases use separate, finite TEST roots under the original controller-owned sandbox for case isolation. Within each case A→B retains the exact original storage root, binding and runId; no new Runtime namespace is used after UNKNOWN. They do not run an input again to escape UNKNOWN. The clean restart is a distinct continuation of the already-successful ordinary Codex provider scenario. No restart is attempted from either UNKNOWN case.

## 2. Exact six writable source paths

| Path | Current reviewed preimage | Selected change |
| --- | --- | --- |
| `tools/owned-process-broker/nativeEmulatedOwnerLossScenario.ts` | absent | One TEST-only helper with two closed loss modes; preserve the zero-input case and add after-effect/lost-completion observations. |
| `tools/owned-process-broker/nativeEmulatedProfile.ts` | `67180ac5c567cbeb089d4ef3248391c792e1ba4d`, 105 lines | A closed optional loss mode for Codex-only, unpackaged TEST Host marker/birth journal. Existing callers, recipes and budgets retain their defaults. |
| `tools/owned-process-broker/nativeEmulatedProviderGate.ts` | `31a6c30bd3962500e20e99786353cb9ec418adaf`, 231 lines | Invoke both loss modes only in the original provider branch; add the separate clean Codex successor/capture refusal proof and partial receipts. |
| `tools/owned-process-broker/tsconfig.json` | `8c5651265cf20f4cae1604f9fa32d85a2339cf46`, 6 lines | Append only the new OwnerLoss filename to existing integration exclusions, retaining the published Plan72 Cold exclusion. |
| `.github/workflows/host-process-acceptance.yml` | `93606e49aedfe84b6452aee487efdf2055f45524`, 419 lines | Extend only the existing final receipt verifier with the two loss cases and actual clean-restart predicates. |
| `.github/workflows/host-emulated-acceptance.yml` | `6b97edf766fda54e133de7c2688aa7024a53585e`, 1772 lines | Append exactly the three selected Profile, ProviderGate and OwnerLoss paths to the existing fast-lint command. |

The existing retained-host compiler includes `nativeEmulatedProviderGate.ts` and follows its imports. Its unchanged config is `905f1a1489f3b37d651a9984169b0321c9915a15`. Thus exclusion from the standalone broker config is not removal from all TypeScript qualification. Do not add or alter a compiler configuration, workflow, matrix, job, route, CLI selector, dependency, provider peer, product owner or public API beyond the six paths.

The Profile option is the closed union `owner-loss-before-resume | owner-loss-after-effect`, accepted only for Codex with no packaged argument. The new helper reports the closed scenarios `completed-install-before-physical-resume` and `completed-effects-before-runtime-completion`; it exposes no arbitrary fault callback/phase or configuration framework.

All touched/new TypeScript stays at most 800 lines. The current 797-line SourceScenario is untouched, including the selected Plan64 `(job.resumed || failure !== undefined)` cleanup predicate. If a complete implementation cannot fit the selected six paths/caps without unrelated compression or a generic fault framework, stop the source cut for a reviewed plan amendment.

### Composition and external-proposal boundaries

The external six-body proposal is source input, not a patch to apply. Its OwnerLoss body is `bfeb7748103d61fdcd82199ba637061ecad824a8` (298 lines). It contains only the completed-install-before-resume case. Its ProviderGate, Profile and workflow additions do not prove after-effect loss or a genuine new generation.

The external fast-lint workflow removes four already-selected operands and adds W01/native fixture operands. None of those removals or W01 additions is admitted. Preserve the original 136 operands in order, including native-stop-fixture, useConservativeNow, useEffectiveCliProviderStatus and teamProviderRuntimeStatusLoading. Published Plan72 already adds Cold once, producing 137; Plan73 appends only:

- `tools/owned-process-broker/nativeEmulatedProfile.ts`
- `tools/owned-process-broker/nativeEmulatedProviderGate.ts`
- `tools/owned-process-broker/nativeEmulatedOwnerLossScenario.ts`

The final expected count is 140, with every preceding operand preserved exactly once and in order. Recompute this from the actual intervening source, rather than overwriting the published Plan72 command from the older 136-operand body. The external tsconfig's extra `nativeRetainedProviderFixture.ts` exclusion is likewise not selected; retain only independently published Cold plus this new OwnerLoss exclusion. No W01 helper import, selector, invocation or artifact claim.

## 3. Existing source seams and authority

The independently re-read source bindings are enumerated with full Git SHA, SHA256, bytes and line counts in the accompanying manifest.

- `HostWindowsLaunch.ts` `3b5a244c27d004af6e82fffa092fa83e1894de73`: resume awaits `installOwner()` before sending its original custody resume request (391–409). Therefore interception at that request proves completed callback installation, not an instrumented internal installation instruction.
- `WindowsCapturedProcess.ts` `b63b0c2b97bc196d0c1c87c0f106c2e2346e3de9` (90–122) and `processFacade.ts` `76ad8e4e7ed91619be875cbff4b65b8811495e05` (104–141): retain the pending allocation, capture the original root/observers and install the original owner before resume. No numeric PID adoption is needed or selected.
- `RetainedWindowsCustody.ts` `10e1a457bb65a136128eb1db5176a4701d2fe4e2` (100–167, 280–335, 352–385, 491–520): Host abort seals input without physically stopping Main's retained allocations. A successor attachment needs both original abort and original Host exit. Main's existing close owns original Stop/drain/release.
- `CapturedHostClient.ts` `c4389ac113de03138fd6a9b4b0c6070fb2f06d86` (197–203, 418–444, 735–799): use the actual retained child-close promise, native abort, same Main owner and distinct hello Host incarnation. A PID/birth-journal row alone is not Host-exit evidence.
- `RuntimeOwner.ts` `a566efc5987b6859d004a8531cb8e6bac80bec30`: opening intent precedes allocation; the durable submit claim precedes native submit (262–385); reconcile never adopts a driver or replays a claimed effect (612–637).
- `FileRuntimeStore.ts` `60873a7a750aacfd4affbff90b21e1a739f127d4`, `prepareSessionOpen.ts` `f02e7aaa2b12d337c43c25aec58a1c113b96728b`, and `sessionState.ts` `13136f8f34d8172370cf59da5a2e6b4972933714`: retained member siblings prevent using a different run/generation to bypass unreleased history. Fixture access to FileRuntimeStore is read-only through the existing fence/get; no tx.put or journal rewriting.
- `providerPeer.mjs` `00c0bbf1b31fea46a19920f38ff347f5ede025da` (53–101): one original turn/start calls process_register twice, validates each completed receipt, writes one registered row, then emits the fixed TEST item/completed and turn/completed. Keep this peer byte-identical.
- `HostWindowsLaunch.RemoteOutput` (162–205) and `hostCustody.ts` `af69d8430ffd473d471a5e663606fcaea640d2e5` (355–364): one pending stdout read prevents later stdout completion from overtaking the held original read result. Codex's byte transport `ec76625a5aa141fc1deea021a62e18488fb4a3f7` does not manufacture or reinterpret native frames.
- `transitionRuntimeMember.ts` `3c8c94f3e448d4cf4562d7ff7690a1f7752ade26` and `executeMemberAction.ts` `3fd7a6b5e85ced037fa52c08fc7f676ddd359a57`: ordinary restart verifies the original binding, closes/retires original custody and endpoint, then publishes and starts the actual incremented successor. No fake selected generation is necessary.
- `RetainedWindowsServices.ts` `840e021b3dae5d4ad7a637b495c4e7f6c6cd5a4a` (59–78): a new capability with an unchanged old capture fails the original service-source equality before query/run/allocation. This is the selected stale-capture negative. An old capability querying its own old terminal history would test a different boundary.

## 4. Closed before-resume case — preserve the original oracle

Retain the external helper's completed-install-before-physical-resume scenario as a separately reported case, with its original no-input expectations:

1. Create one original Main custody owner and Host A from the unchanged finite Codex profile/peer. Observe the first actual prepare reply, retain the actual capability/root and acquire its original query/wait HANDLE witness before the prepare ACK is forwarded.
2. At the first resume request on attachment A, after the real install callback has returned, hold that exact callback before calling the original port. Record the closed attachment/capability/root facts. Native resume, native write, business input and peer effects remain zero.
3. Capture the original opening record, assert UNKNOWN custody, unchanged profile/binding/open fingerprint and zero inputs/interactions, and observe the root HANDLE alive. Create exactly one exclusive TEST crash marker; the existing Host wrapper exits itself.
4. Await original Host A close and native abort. Preserve the original transport-closed/unknown failure. Release the held callback only into its fixed TEST rejection, await settlement and remove the original marker. Do not forward delayed resume.
5. Start Host B under the same Main/profile, with a different actual hello Host incarnation. Read the retained record, explicitly reconcile, then make the original identical open lookup. No second allocation or native input.
6. Retain all four direct stale/successor resume/write refusals against the original saved capability, plus the existing numeric-PID schema refusal. These are denied calls, not native forwarded operations.
7. Keep the original HANDLE observations before loss, after loss and after refusals; the independent sentinel survives. Original client shutdowns and Main close remain mandatory; original HANDLE wait must return zero. Physical absence does not turn the retained Runtime record into released or successful history.

Exact counts remain one allocation, one prepare, one intercepted resume request, zero forwarded/completed resume, zero forwarded/completed writes, zero business inputs, zero peer rows, one crash marker, two actual Host epochs, one original runtime-open plus one identical lookup, one explicit reconcile and one numeric-PID probe. Do not relax this zero-input case to accommodate the after-effect case.

## 5. Closed after-effect/lost Runtime completion case

### Original operation and precise interception

Use a second isolated TEST root and the same immutable Codex peer, owner stack and profile limits. Open once to actual readiness and submit exactly one original `team.execute / message.send` with the existing TEST-register-services business input. Capture its original completed Team command receipt/deliveryId and the durable Runtime input's intent, fingerprint and operationRef.

Intercept only the actual first-Host stdout `read` result that completes the first matching fixed `item/completed` or `turn/completed` frame for the peer's TEST-thread/TEST-turn. The original port has already returned the actual read result; the fixture holds that same result before it reaches the original Host byte stream. Do not fabricate a result, split/rewrite it, change `more`, inject terminal data or alter the peer.

The local TEST observer:

- retains only a bounded incomplete NDJSON byte tail across chunks;
- validates the existing 16 KiB custody chunk bound and caps one incomplete line at the selected profile's existing 1,000,000-byte output budget;
- parses only complete newline-terminated frames and selects the first matching completion in stream order; the normal item/completed plus turn/completed pair may share the same held chunk and is not a duplicate barrier. Malformed/oversized output, a second barrier selection or identity mismatch is failure;
- observes exactly one acknowledged original native turn/start write, retaining its actual request identity and the fixed peer thread/turn identity without inventing an operation ID;
- does not persist raw frames, environment, credentials or arbitrary provider output;
- holds one original stdout callback only; stderr and original control/cleanup keep their original behavior.

The acknowledged native write observer uses the same bounded byte framing for existing write chunks and counts only completed original write operations. Do not claim a fixed number of startup writes or read chunks: retain actual counts and require exactly one business turn/start and no post-loss native business replay.

### Two real effects and three original HANDLEs

Before forwarding each of the two original service-capture ACKs, retain its complete unmodified capture and acquire the matching original target HANDLE witness. This preserves the existing ACK bytes and action count. Capture the provider-root witness on its original prepare reply. At the held-completion boundary require:

- exactly two completed original process_register effects and two original capture ACKs;
- one peer `registered` row containing the original primary/neighbor service references, no failure row;
- one existing read-only team.process.list under the same remaining input cutoff joins the peer's two processRef/PID pairs to the original public rows and Main captures' target/root/source; do not equate a product processRef with a native capture field or claim these queries did not occur;
- the provider root and both captured service HANDLEs alive;
- the unchanged independent sentinel alive;
- exactly one Runtime input with the original intent/fingerprint/operationRef/deliveryId, not terminal and not already unknown.

The pre-loss input may be `claimed` or `consumed`: the native turn/start ACK can be in an earlier chunk or the held chunk. Requiring one particular chunk grouping would invent an oracle. Both states must refer to the same single durable input and both effects must already be established.

This loses the original Runtime/native terminal completion. It does **not** lose an MCP process_register acknowledgement: the unchanged peer has already validated both completed MCP receipts before writing its registered row and terminal notifications.

### Real loss, cold read, reconcile and no replay

Write exactly one original crash marker. Await Host A's retained close promise and attachment abort; the native root and both service HANDLEs must still be alive under the original Main. Release the held stdout callback only so it rejects after that original Host has exited. Never forward the held terminal result to Host A or Host B.

Start Host B under the same physical Main and captured profile, with a different hello Host incarnation. The first public cold read is read-only: record its actual saved phase/custody/input phase, require `attached:false`, `nativeReady:false`, the same member/generation/input identity, and no new allocation/input. In this after-effect case it may still expose saved `allocated/owned` state. Do not falsely require cold read itself to mutate the durable record.

Use the original explicit `runtime.reconcile` once. It must persist `held/unknown`, nativeReady false and the same original input in phase unknown. Read the same FileRuntimeStore record under its existing fence, and join unchanged binding, profile, openFingerprint, old Host incarnation, full input intent/fingerprint/operationRef and absence of a successful terminal result.

Perform one identical original Team command/payload lookup through the existing command route, retaining the same command receipt and deliveryId. The original completed-command deduplication (TeamHost plus executeTeamCommand) must prevent another native input. Retain one identical original open lookup if used by the before-case helper; it must return retained history without allocation. Four stale/successor resume/write refusals may be reused only as the same closed denied-call oracle, never as replay attempts that reach native IO.

Re-read the peer/effect journal and durable record after cold reconciliation/lookups and after original cleanup. Require original business input1, native turn/start1, completed effects2, registered row1, no extra service capture, no native write after Host loss, no allocation after Host loss and no successful terminal publication. Same-Main physical cleanup must not rewrite UNKNOWN to released, erase the input or admit another generation.

## 6. Separate clean Codex restart and unchanged stale capture

Extend only the ordinary successful Codex provider scenario after its existing two scoped Stops/settles and neighbor/provider-survival proofs. OpenCode's original scenario remains byte-for-byte equivalent in behavior and all prior oracles remain.

Read the original launch/member action view using the actual retained launchId and memberId. Construct one strict restart payload using that returned rosterRevision and the original runtime generation, then call existing `team.member.action.prepare` and `team.member.action.execute` with the same commandId/payload. No native readiness substitute, manual store mutation, fresh namespace, new business input or public API is selected.

Record the original custody operation order and per-allocation counters. Require old Runtime closed/released, original provider cleanup and endpoint retirement before the second root allocation. Do not call Main.close before restart: it is a final shutdown fence.

Verify the successor from actual results:

- selected Runtime binding generation changes and numeric config/profile generation increments;
- physical provider generation/capability changes and the new root PID/birth pair differs;
- these three identity domains remain distinct; do not equate their string representations;
- the actual new Runtime is attached/nativeReady with zero inputs;
- exactly two provider-root allocate/prepare/resume/release lifecycles are accounted for, with original Stop bounds checked per root, not weakened to one broad aggregate range.

Retain an original service capture without editing any nested field. While the new root is alive, submit one existing private `service-query` on the saved current custody port with **the actual new capability and the unchanged old capture**. Require the original `Original service custody unavailable` rejection. Joined with the exact source guard at RetainedWindowsServices59–68, this proves refusal before native query/run; do not invent an uninstrumented native-query count. It must not increment service capture/Stop/settle, allocate a provider or send input.

The old root's original HANDLE must already be absent and the new root's original HANDLE still alive after the refusal. The two old service rows retain their absent/nonterminable observations. Then use normal original Host shutdown and Main close to prove the new root absent. All four retained HANDLE waits (old root, two original leaves and successor root), original child exit and independent sentinel cleanup remain mandatory.

The original aggregate verifier must join the two Codex allocations and per-root receipts. Do not replace the earlier original-root oracle with a check that accepts any two allocations, or relax the unchanged OpenCode counts. A total stop range alone is insufficient.

## 7. Fixed budgets, partial receipts and cleanup

| Boundary | Existing value / rule retained |
| --- | --- |
| Host profile startup/request/write/shutdown | 10000 / 15000 / 5000 / 1000 ms |
| Existing native gate wait helper | 10000 ms default |
| Original Host crash marker polling | 25 ms |
| Main original close | Stop deadline now+10000, drain now+3000, original release |
| Per-input after-effect observation | One 15000 ms absolute cutoff captured before the sole business RPC; all barrier/effect/record reads before loss consume its remainder; no deadline reset or second input |
| Ordinary scoped Stops and restart RPC | Original 10000 ms Stop budget / existing 15000 ms request budget; no extension |
| Workflow / controller | Original job30min, existing controller arguments/deadline, runner matrix and source selectors unchanged |

Public request timeout and existing native launch budgets remain independent original owners; this plan adds no new timeout policy. Expiry before or after an awaited original operation is failure. No success inference from a late result, no larger polling period/budget and no retry of the business input.

Initialize both loss receipts as incomplete/not-started before invocation so an early failure does not omit an obligation. Record closed stages, original operation/capture identities and count deltas, pinned sources/binaries, profile limits, actual Host epochs, original error and every cleanup result. Missing/ambiguous facts remain false/unknown; they cannot be inferred from the final controller's drained label.

Every path, including pre-barrier or witness failure, must release/settle the fixture-held callback, observe outstanding promise rejection, shut down the actual clients, close the original Main owner, wait the original HANDLE witnesses and preserve the first failure. Use existing NativeGateEvents first-failure latching. Only the TEST witness processes created by this gate may use their existing final local fallback kill, after mandatory original cleanup attempts. Never reopen a process by PID or signal an unretained process.

Read the FileRuntimeStore only; ordinary product reconciliation/cleanup may update phase/sealed/unknown facts, but the fixture never writes durable state. Preserve input fingerprints and original authority, and never reinterpret physical absence as released Runtime history.

## 8. Exact accounting and original CI qualification

| Case | Main owners / Host epochs / provider roots | Business input / actual register effects | Required original witnesses |
| --- | --- | --- | --- |
| Existing OpenCode finite provider | 1 / 1 / 1 | 1 / 2, unchanged | Root + 2 leaves, unchanged |
| Existing Codex plus clean restart | 1 / 1 / 2 | Original1, successor0 / original2 | Old root + 2 leaves + successor root |
| Completed-install before resume | 1 / 2 / 1 | 0 / 0 | Original suspended root |
| After-effect, completion lost | 1 / 2 / 1 | 1 / 2 | Original root + 2 leaves |

These totals cover the provider scenarios, not the separate existing launcher fixtures or A/B source invocations. Compared with the external before-resume-only proposal, this selected cut adds one business input, two registered leaves, two Host starts, one physical Main owner and two provider roots (after-effect plus clean successor). No extra source-provider branch invocation.

Keep the original Node24.21.0/Corepack0.36.0/pnpm11.22.0 and Electron44.10.1 checks. The new W05 cases run in the existing Windows x64/ARM64 **Node** provider-wrapper invocation; the original separate Node/Electron broker gates remain required and do not establish W05 under Electron. Do not promote a controlled peer into vendor qualification.

Required resulting-source evidence is the unchanged original workflow sequence: source/tuple binding; all six existing build commands; existing contract tests; native Node/Electron receipts; original wrappers/provider invocation with both new loss receipts and clean restart; unchanged Codex/Claude/OpenCode A/B routes including reviewed Plan72 Cold; final unchanged-source/complete-receipt verifier; original controller zero exit/zero active count and always-uploaded full artifacts. Preserve all original negative predicates, Linux/Darwin paths, source-freeze checks and qualification flags.

The existing Team lane's full workspace types and original typed lint remain required, with only the three selected fast operands appended. A TSX invocation alone is not a typecheck, and metadata success is not full receipt evidence. No historical 75 or earlier PASS transfers to the new source. No manual workflow dispatch, rerun or cancellation is authorized here.

## 9. Publication and review gates

1. Finish this provisional source feasibility/R1 and independently review the exact intended six-path change and meaningful receipt oracles. This document records no compiler/test/native execution.
2. After Plans71/72 actual source gates close, obtain the actual full delivery tree and rebind every selected preimage. Preserve all intervening source/docs, Cold's exact helper/exclusion/operand and the 136 prior operands. Reconfirm new path absence and line caps.
3. Root publishes the exact reviewed document/evidence additions first through the normal branch lease. Full official doc/commit/tree readback and independent actual documentary R2 must close before a source child is authored/published.
4. Author exactly the six admitted source bodies; root/full independent prospective R2 review all bodies, changes, action counts, error/cleanup paths and original-oracle preservation. No automatic adoption of external helper, W01 or SourceScenario edits.
5. Publish the source child only after that review; verify its full actual tree and unchanged leaves, close independent actual-source R2, then integrate through ordinary guarded fast-forward after the useful-job guard. Resulting original CI and full retained source/receipt/cleanup evidence remain necessary before qualification.

The source seams are feasible without a new public owner or API. Runtime timing, Windows behavior, actual action counts and complete cleanup are still unexecuted requirements, not conclusions of this plan. The native-first W01 route and any broader W05/provider-matrix claim remain separately gated.

## Current prerequisite receipts

Root fully read both independent actual-source receipts before this rebind. Their exact identities are:

- Plan71: SHA256 `67e0946ae75da8aa45e8729e51ccc20346098e55d660f2fb8c1c5df6280ea6a3`, 17401 bytes.
- Plan72: SHA256 `707c128ac9436a34250608ead7f72c29d5bda0276d7577a6045d1a32a94244b4`, 16921 bytes.

All 33 earlier read-only reference bodies still match the current complete tree. Published SourceScenario (797 lines) and Cold (125 lines) are additionally bound read-only; neither is writable in Plan73. No source or runtime qualification is inferred from this documentary rebind.
