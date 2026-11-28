# Model probe admission custody after an uncertain claim write

Status: plan published in `fa856b8f88c060a180561f20fa39f35f373049d7` before implementation; the finite correction and execution are recorded below. This is a separate, narrow correction to the existing model-probe owner, not part of G2 secret-witness architecture.

Source review used `d4f4d989f126317642843381e573926ed9c8a30a`. The four relevant owner/store/fence/test files remain identical in the current checkout at `b26f085a65b982be213750795926614b154cb9b0`. The finding below is source-confirmed; the finite RED fixtures have not yet been run.

## Problem and concrete failure boundary

`packages/legacy-agent-host/src/management/ModelProbeOwner.ts` reserves the shared native-auth resource at admission, constructs an allocation-free probe, and writes its initial `running`, `resourceHeld: true` receipt before installing an active entry, timer or native run. Its current catch unconditionally calls `fence.release(resourceId, commandId, true)`.

The write port can throw after publishing that receipt. In `adapters/providers/FileManagementCommandStore.ts`, `renameSync(temporary, path)` is followed by directory open/stat/fsync on POSIX and by a final original-directory check on every platform. An exception after rename does not establish that the receipt is absent. The store deliberately does not rewrite or erase a possibly published claim in its cleanup.

`ManagementResourceFence.release(..., true)` deletes the live reservation without recording a hold. Consequently, the original probe has zero native runs, yet a new same-resource intent in the same live owner can pass admission. A newly constructed fence over the real stored receipt sees `resourceHeld: true` and refuses that new intent. This is a live/cold custody disagreement, and it affects the shared boundary with credential operations as well as a second model probe.

## Existing preparation and cleanup contract

The current production preparations do not allocate a native process or listener before `run`:

- `adapters/providers/OpenCodeV2ModelProbe.ts` explicitly documents that construction allocates nothing and only a durably admitted run may create a child. Namespace creation, server start and native execution occur on its run path.
- `composition/ProviderModelProbePreparation.ts` retains the same rule for the V1 limit-overlay host; ordinary V1 work enters `withHost` from `run`.
- `composition/ClaudeManagementCoordinator.ts` constructs and registers the probe host inside `run`.
- `composition/CodexManagementCoordinator.ts` enters its native queue only from `run`.
- Constructing the private coordination endpoint creates an inert server object; listening occurs only in its explicit `start`.

Therefore, an exception in this initial admission block needs no speculative native close. It must preserve the original exception and the journal's actual bytes. No generic finish/cancel publication is appropriate before an active probe exists.

## Minimal implementation

Change only the initial claim boundary in `ModelProbeOwner.admit`:

1. After the successful resource reservation, initialize a local `claimWriteAttempted = false`.
2. Set it to true immediately before the existing first `this.options.store.write(saved)` call. Preparation, timeout validation and receipt construction remain before that assignment.
3. In the existing catch, release with `settled = !claimWriteAttempted`, then rethrow the original error unchanged.

A failure definitely before the first write attempt releases the live reservation normally. Any exception once the write was attempted retains the original resource hold, even if a subsequent observation would show no receipt. The owner cannot infer a definite no-publication result from the generic write exception.

The change does not call native `run` or `close`, install an active entry or timer on failure, write a compensating receipt, alter receipt fingerprints, or change replay/normal completion logic. The shared fence already makes a late unrelated release powerless; it requires no modification.

Cold behavior follows actual durable evidence. A real published `resourceHeld: true` receipt must retain its hold after a new store and new fence are constructed. An attempted write that in fact left no receipt creates a conservative live hold only; this plan does not invent a durable receipt, assert that an empty cold store has a hold, or introduce another persistence mechanism.

## Scope and ownership

| File                                                              | Change                                                                                                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/legacy-agent-host/src/management/ModelProbeOwner.ts`    | Local attempted-write flag and the existing catch's settled argument; approximately 3–6 production lines including a concise explanation. |
| `packages/legacy-agent-host/tests/management-model-probe.test.ts` | Focused regressions using the existing real FileManagementCommandStore fixture and shared fence; approximately 80–130 test lines.         |

No store, fence, provider adapter, schema, public DTO, vendor package or native process contract changes are planned. No reserved Mac-owned file is touched. The source-file line limit stays unchanged. Root owns integration/publication; implementation starts only after the reviewed plan is published and separately authorized.

## Required finite RED before the owner change

Use isolated existing TEST fixtures, controlled in-memory probe methods and the actual file store. No credential values, external service, native executable, process launch or model request is required.

### A. Real publication followed by an exception

The existing fixture's store wrapper delegates the first model-probe write to the real `FileManagementCommandStore.write(record)`, then throws one captured TEST error. Later writes delegate normally. This creates a real validated durable receipt and deterministically models the interface's already source-confirmed post-rename failure window.

Before attempting a competing intent, assert that the original start throws the same error object, the real original receipt is `running` with `resourceHeld: true`, and native run/close counters remain zero. Save the exact original receipt bytes.

With the same live shared fence, a new `credential.forget` command must reject with `held` before its perform callback or any new receipt. A new model-probe ID must also reject before preparation/run. Use separate instances of the fixture if a baseline competing probe would otherwise leave a deferred run alive. The credential control avoids such an outstanding run.

Construct a new `FileManagementCommandStore` and a new `ManagementResourceFence` from its real records; do not use the fixture's helper that shares the old fence as the cold proof. Cold same-resource new IDs must reject. Exact original-ID replay remains a read-only held snapshot and performs no new preparation, run or close. Original read/cancel/owner-close controls must not rewrite the saved receipt. Assert exact original bytes and absence of competing receipts.

Expected RED on unchanged source: the live competing intent is accepted (the credential perform callback is reached), while the cold fence already refuses it. The corrected source must make both refuse, preserving the original bytes and zero native effects.

### B. Write attempt throws before calling the real store

A one-shot wrapper throws on the initial probe write without delegating; later writes delegate normally. The original error is preserved, the real store stays empty, and native run/close remain zero. A new same-live-resource intent must still reject with `held`, because the owner observed a write exception with an uncertain publication outcome.

Expected RED: the current owner releases its live reservation and admits the competing intent. No cold durable hold is asserted for this empty store.

### C. Definite failure before any write

Pass a preparation override that throws the original TEST error before returning a probe. Verify no receipt, no native run/close, and no write attempt. A subsequent explicit admission in the same live namespace must remain possible. Include the existing invalid-timeout boundary as a small control if needed to establish that the flag was not set before preparation/validation. Settle any admitted controlled probe through the existing finite fixture gates.

Expected result on both old and corrected source: the pre-write failure is retryable. This control prevents converting every construction failure into a permanent namespace hold.

## Independent review

Root reviewed the actual admission, shared fence, persisted receipt and cleanup paths and approved the minimal attempted-write distinction. A second reviewer independently read the owner, real store and this complete plan, including the original cancel path. Both reviews require a conservative live hold for every attempted-write exception, a cold hold only when actual durable custody exists, and normal reuse after a definite pre-write preparation failure. No native allocation occurs in the initial preparation block.

These are source and plan reviews. The RED and corrected runtime results remain pending at plan publication.

## Verification and reporting

After plan publication and separate authorization, add the focused tests first and record their actual finite RED. Then apply the one-owner change, run the focused management-model-probe suite and relevant existing shared-fence regressions, and run the established Host build/test-types gate in the root-assigned slot. No blanket test expansion or native qualification is needed for this boundary.

Report actual test outcomes, original-byte preservation, same live/cold refusal where a durable claim exists, and zero native run/close on the failed admission. Source review alone is not an executed reproduction, and the portable write-then-throw wrapper is not a claim that an operating-system fsync error was forced during the test.

## Implementation and finite execution — 2026-11-28

After the reviewed plan was published, the tests were added against the unchanged compiled owner. All three expected broken leaf assertions reproduced: a live competing credential reached its effect after a real publication-then-throw; a competing probe reached preparation; and an attempted write without an actual receipt also allowed a new credential. The focused RED output counts seven tests including parent cases: three passed and four failed. Cold refusal from the real persisted receipt, original replay/read/cancel byte preservation and definite pre-write retry controls already passed. Fixture wrappers model the real store interface boundary; no operating-system fsync fault was forced.

The production change adds the local flag and changes only the existing catch's settled argument. The owner is 604 physical lines. Root and the independent reviewer inspected the exact two-file diff; the store, fence, record formats, provider adapters and native operation contracts are unchanged.

| Executed check                               | Result                                                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Canonical Host build                         | PASS with pinned Node 24.21.0 and TypeScript 7.0.2.                                                        |
| Complete model-probe test file               | 18/18 PASS, zero skipped.                                                                                  |
| Existing credentials and command-store tests | 36/36 PASS, zero skipped.                                                                                  |
| Strict changed-fixture compilation           | PASS using the existing Host test configuration and the installed type declarations; no strictness change. |
| Production source-size and whitespace guards | PASS; 5548 production files and the unchanged 139 frozen exceptions.                                       |
| Complete Host test typecheck                 | Terminated with exit 137 without compiler diagnostics; no PASS claimed.                                    |

The corrected fault cases preserve the exact original receipt bytes, perform no native run/close or competing credential effect, and agree across live and newly constructed cold fences when a durable claim exists. A definite pre-write failure still permits an ordinary subsequent probe, which completes and releases normally. The empty-store write-exception case remains a conservative live hold without an invented cold receipt.

These are local controlled execution results. Required current-head CI and the independently tracked Desktop/native qualification remain open. The correction does not claim the unresolved broader G2 or CodeQL finding is closed.

The published correction on `a01484ee4787698f7e3ce1d5b98a585edad54876` subsequently passed the unchanged actual Main IPC/standalone Host/TEST process E2E, including ordinary model testing, cancellation and configured limits. The [execution manifest](evidence/e2e-a014-local-2026-11-28/manifest.json) binds the complete Host source/dist trees and confirms all 18 fixture process IDs were absent after shutdown. See [the execution note](oauth-start-fingerprint-plan.md#current-source-controlled-process-e2e-qualification) for the resource change, exact run and scope limits. This is not genuine vendor or platform qualification.
