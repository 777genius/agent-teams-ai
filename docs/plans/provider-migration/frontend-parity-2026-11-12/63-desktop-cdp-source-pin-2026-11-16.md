# Plan63 — pin the existing Desktop CDP client in source evidence

Status: prospective bounded correction; publish this plan before creating the source afterimage. This closes an observed evidence omission only. It does not select a native-readiness repair or change any user action, timer, retry or cleanup requirement.

## Evidence and current binding

Original head `75cf2dcbfe2b540325ea50a022cb5195306a8c59`, Host Emulated Acceptance run `43959134362`, Darwin ARM64 PNG job `133621515593`, artifact `14275365531` (260261 bytes, SHA256 `65109b948abb7362306c0aef719828d0c2b6345db1aac6ac1326abf61fc7b8e9`) stopped at the single setup `team.launch.start` with `CDP command timed out: Runtime.evaluate`. Both original source arrays contain the same 1777 entries, but neither includes the CDP implementation that the harness loads. PNG/business/cold readback remain unqualified; the pending ordinary result versus original close/release is not distinguished by this packet.

The actual `desktop-backend-smoke.ts` loads `../e2e/comment-notification/cdp.mjs`, captures `desktopProofSources` before the journey, verifies the same list in its failure/final paths and passes it to the original failure projection. The CDP client supplies the original 30000 ms default and awaited renderer promise. Its immutable source is blob `9397505b7889db88ef103dca62287e3d02a88cc9`, SHA256 `8e70fecbb1f2107abffa91d78644ee74f8e34546c8117587661f8376c27998aa`; this file is not edited.

Official readback at side parent `946488197cf45a9012e84c7a45b402c4eef17a90` confirms `scripts/legacy-agent-host/desktop-proof-supplementary-sources.ts` blob `a41bff15e351d829d9cbb0197a7026ad09d6dc18`, SHA256 `e649994d2311bc5fdc308c24167593d0c387ce4fef3a170f04b8e20c9402ffe1`, 22320 bytes / 343 lines. Its exported supplementary list is consumed by the unchanged ordered Set in `desktop-proof-sources.ts`, blob `a8be2617b2c765091cecce789f028ef2bf67af60`.

## Closed implementation

Change exactly one existing TEST source file: append the literal `scripts/e2e/comment-notification/cdp.mjs` once to `desktopProofSupplementarySources`, immediately before that list's closing bracket. Preserve every old entry and its relative order, and preserve `desktopProofProcessSources` and the separate `desktopProofWindowsRetrySources` byte for byte. The resulting natural file size is 344 lines. No filesystem discovery, additional helper, production change, dependency, API, workflow, entry point or provider pin is selected.

The original source-freeze machinery must therefore hash these existing CDP bytes before and after each applicable Desktop journey. It must retain the complete pre-existing roster; no source exception, ignored mismatch or substituted receipt is permitted. The existing failure projector has a separate path allowlist that excludes `scripts/e2e/`; it remains unchanged and may still omit this CDP stack frame. This plan does not expand failure-frame attribution. The implementation adds no native/UI/Host operation and no diagnostic field.

## Review and qualification

Before source publication: independently verify the original artifact/source omission and current bindings; review the exact one-line append and inverse; check complete prior-list equality, exactly one new literal, unchanged process/Windows lists, natural line count and all unrelated tree leaves. Check the existing readers and validators use the shared roster rather than a fixed 1777-entry contract. Do not create a redundant unit test for this data-only append. Existing required canonical compiler/lint and original Desktop CI remain the execution gates; do not run project code locally or rerun/dispatch/cancel workflows.

Publish the selected plan and prospective review first, then the frozen one-file source cut and its actual source review with immediate expected-parent CAS and full-tree readback. Preserve useful current-head CI before moving the primary branch. #1192 remains Draft with its current base. Actual Claude/Codex execution, Ready/main merge, release/default activation and Stage2 remain outside this authorization. This correction supplies no new runtime PASS and does not repair or waive the PNG readiness failure.
