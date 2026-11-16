# Plan68 actual source R1 — captured Team readiness render purity

Status: **FROZEN_SOURCE_ONLY**, ready for independent actual-source R2. This packet implements only the two paths selected by published commit `b60f2d58cffd30129b0a96bccff643c3d30b3149`, plan blob `bc75c16dc6db634df125bfb5faf8665975febdac` / SHA256 `c859c7342a74681636c3d10ee39778a483d5272632c93c5b73d2f4120bd31422`. Both complete preimages were independently fetched again at that immutable selection commit and matched byte-for-byte; the retained official responses are in `official-preimages.json`.

## Exact cut

| Path | Before blob | After blob | Lines | Delta |
| --- | --- | --- | --- | --- |
| `src/renderer/components/common/ProviderActivityStatusStrip.tsx` | `c1d31ee945c28cfe1f1339d914d0d1be7fc5e928` | `5ceced2c642f104116899d000e9b20e87b7a8c1c` | 396 → 415 | +21 / −2 |
| `test/renderer/components/common/ProviderActivityStatusStrip.test.ts` | `c1ab11f043ea5bcfb5325cb8fb6f147541076f38` | `6316cdc53a951d99983266bdaa84493fdeb7dbbf` | 844 → 984 | +141 / −1 |

The production component remains naturally below 800 lines. The test was already 844 lines; this selection preserves its existing exclusion/baseline and does not compress or extract old cases. There are no other source, closure, workflow, timer, Host or authority changes. Both edited files and the real readiness hook/predicate/fence/guard already belong to the original proof and fast-lint closure.

## Production behavior

The single local state pair retains the captured-readiness predicate identity and its commit-time observation timestamp. The layout effect reads `Date.now()` only when that predicate exists, then clears the snapshot when it does not. The error expression accepts only a snapshot belonging to the exact current predicate and still requires the predicate result to be strictly `true`. The original loading and scoped-OpenCode short circuits precede that call. All other provider selection, bootstrap masking, fallback authority and display behavior is byte-preserved.

The current sole Launch dialog caller passes a fresh `capturedReadiness.permits` on each parent render. Its unchanged readiness owner invalidates that parent at its existing strict expiry-plus-one callback. The component therefore records a new observation without adding an independent clock. A child-only rerender preserves the parent predicate and reuses its timestamp. A changed predicate cannot borrow the previous scope's timestamp or ready result; the layout effect settles before paint. The child state update does not recreate its parent prop. This remains a presentation observation, with no change to actual-time `createLaunchGuard` or `captureForSubmit` authority.

## New behavioral regression, source review only

One appended case uses the actual `useCapturedTeamLaunchReadiness`, its real pure predicate, the existing submission-fence constructor and original launch guard. It reads the existing store's source selector without writing to the store or adding a mock. The store module was already imported through the original guard's effective-status dependency; the existing API/logo mocks are unchanged. It never invokes preflight, provider preparation or a native API.

The proof is bound to the actual hook draft signature, actual fence preparation and original selected-model signature. A delegating `vi.fn(readiness.permits)` records presentation observations without replacing the real predicate. At +250 ms, only the child renders; its fresh equivalent loading object invalidates the provider-state memo while the parent predicate identity stays fixed. The case requires a real predicate invocation and the original timestamp, so the former render-time clock implementation would not satisfy that observation. At exact expiry, the action guard receives the actual owner and refuses using its own current time, before the existing expiry-plus-one timer has fired. Advancing the last millisecond runs that real owner callback: the parent supplies a new predicate and the chip leaves Ready without an artificial parent refresh. The case unmounts and restores real timers in `finally`.

Every original mock/helper/test body remains one contiguous byte-identical prefix, including all nine captured-scope changes, sibling isolation and original guard/global-object assertions. Only selected imports and this one case are added.

## Verification and limits

`preservation.json` records 37 inert checks: official before-image binding, full component inverse, exact old test bodies, short-circuit and strict-boolean preservation, and strict unified-patch forward/reverse application for both complete files. `candidate.patch` SHA256 is `859bc7ebb0312a187d0498d36d0c2b38ebd29bfee899f82426f4a5f9d51c0e49`; `manifest.json` SHA256 is `d271cca416c2276e0797c5dc3189ab96430bfbbb2d3bbf3cb1df82a414be99fd`.

No project, compiler, behavioral test, provider, GUI or CI command was executed. No test/lint/typecheck PASS is claimed. The existing React set-state-in-effect setting is a warning; this review does not claim warning-free lint. Full original types, typed renderer lint, renderer suite and Installer/Team E2E remain required on resulting source. Original 75cf failure stays failed. Root must obtain independent exact-source R2, rebind current parent and publish without overwriting any incoming source.
