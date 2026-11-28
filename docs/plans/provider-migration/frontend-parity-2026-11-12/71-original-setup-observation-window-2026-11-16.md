# 71. One original OpenCode setup observation window

## Selected boundary and evidence

Select only `scripts/legacy-agent-host/desktop-native-stop-fixture.ts` and the existing `scripts/legacy-agent-host/desktop-team-ui-smoke.test.ts` on actual `12d01df13271def88d7a1dd86da6ec70ca243902`, tree `8d778f4f6f4b0aa4043ae3348b91208e701be452`. The native fixture is blob `a1a2b6d5a55b1e6ae777220034d92e178e734150` (30369 bytes, 563 physical lines); the test is `fb5a5cff107473b047a67f7b69f5d59a3b102bee` (167406 bytes, 2777 lines). Preserve Plans63/64/65/68/69/70, including both scroll guards and the complete new above/below regression.

Original75 Quit-active job133621515713 failed with a 30-second CDP Runtime.evaluate timeout before recorded nativeSetup/launch/input. Its retained global-only source and source order support an early metadata boundary, but no original expression/caller frame is retained: do not claim a uniquely identified pending catalog request, native latency cause or successful repair. Original receipt SHA256 `3e84f6d80be56ea4ae3ed42f65ae1ba621a222519cb391415bff89b77de58484`; raw log SHA256 `1d0f42d99db006a88d0508b54e50b940b00d53c40221a997238bdd4674277338`; source-budget review `048100e17d54b656728519d1b299ea2d9a653d304d142577b7deae866105a8ec`.

The source mismatch is independently concrete: original global and project catalog observations omit a CDP timeout override, so their observer can end at30s while the product owns a120s Host catalog admission and180s Main RPC allowance. Neither product value is exposed as an end-to-end remaining loadModels deadline. The existing Plan63 OpenCode180s setup observation cutoff currently begins only before launch.start. This selection moves that one cutoff earlier; it does not add a fresh metadata allowance or forward a fabricated Host remaining value.

## One cutoff, unchanged product and ordinary read limits

Start the already-selected OpenCode180000-ms absolute setup observation cutoff before the original global metadata capture. Reuse the existing local remainingSetupMs function. Never reset or replenish this cutoff before project catalog, launch.start, polling or native observation. Move the existing readinessMs declaration as needed; the non-OpenCode45000-ms post-start readiness window must retain its existing start point and behavior.

The one original global catalog evaluate and one original project catalog evaluate receive the live remaining setup observation time. The original launch.start retains that same remaining-time override. Ordinary team.launch.read/progress observations retain their existing30s maximum: when the OpenCode cutoff is active, pass min(30000, remaining); otherwise keep the original undefined override. Preserve the invokeSetup flag that distinguishes the original long start call if useful; no generic timing wrapper/module or product API is needed.

Calculate remaining after the existing ownership guard and before dispatch, so a guard which consumes the remainder cannot be followed by a new CDP request. Reject a successful awaited result at or beyond the cutoff before moving to the next request or publishing accepted setup evidence. A rejected awaited operation must propagate the original Error without replacing it with a later timeout. No retry, additional catalog/status read, warmup, bootstrap input or second launch is selected.

The existing captureDesktopOpenCodeGlobalMetadata helper may take one optional remaining-time callback and use the already-existing DesktopCdpPort evaluate timeout type. Remove its now-unused UiCdpPort type import only if required by that local signature. Preserve all existing global catalog, source, lineage and runtime-digest assertions and the same observation order. Its other callers omit the callback and retain the same undefined CDP override/default30s behavior. This is a TEST helper signature only; no preload, IPC, Runtime, Host, provider or native contract changes.

After the original global/project metadata work, and before arming preparation, require the same cutoff still live. Keep preparation.arm at its original point after metadata/lineage. Any throwing guard, evaluate or post-await check after successful arm must stay inside the existing launch.start try/finally; disarm runs exactly once before readiness polling on both success and failure. A pre-arm failure must not arm or disarm the preparation.

Both existing return paths must reject late acceptance: ready progress, pending-opening session reads, native observation and the final executable digest. Keep all current exact member/run/status/nativeReady/sealed/empty-input/actor-count predicates. Obtain the existing digest once, check the common cutoff, then assign the unchanged nativeSetup evidence fields. The existing native census/lineage/file readers, their internal budgets, physical ownership and cleanup implementations remain unchanged.

This is an observation/acceptance cutoff, not physical cancellation of an already-issued CDP operation or a hard wall-clock bound on native/file cleanup. An existing read-only observation can finish late and then be refused. No product120s/180s budget, metadata owner count,5s lineage observation, native admission, Stop/Quit oracle or cleanup deadline is increased or removed.

## Existing test seam, meaningful boundary cases

Append coverage in the existing safe test suite; preserve every existing test byte, including Plan70's parameterized scroll case. Use its existing unique-source-slice, stripTypeScriptTypes and injected finite clock/CDP/deferred seam to exercise the actual prepareDesktopNativeStop and actual captureDesktopOpenCodeGlobalMetadata bodies, with their original local object/tick helpers as needed. Do not stub the global helper where the omitted timeout lives, copy its budget implementation, import/launch native fixtures, add a framework or create a new test file.

Cover the following distinct behaviors using a small finite fixture and table-driven cases where appropriate:

- A timely global observation lasting beyond30s but within the single180s allowance, followed by the original initial read, project catalog, one start and ready polling; capture shrinking overrides and verify ordinary reads never exceed30s. The clock must demonstrate no new180s allowance at later stages.
- Successful results exactly at and after cutoff at the global/project/start/read/progress boundaries refuse before a following request or accepted nativeSetup. Cover late global metadata completion, selected project-lineage completion, ready native observation and executable digest.
- Pending-opening uses the same initial cutoff and existing original session predicates; late session/native/digest results are refused, not accepted as pending-open Quit.
- If an ownership guard consumes the remaining time, no following evaluate occurs. If the original100ms polling tick crosses cutoff, no new progress/session read occurs.
- Rejected original awaits retain the identical Error even when the injected clock is already expired. No input/read/start replay appears.
- Pre-arm failure has arm0/disarm0. Start/guard/post-await failure after arm has exactly one disarm; timely start also disarms before polling. Preserve the actual original preparation boundary and selected model/probe evidence assertions.
- Non-OpenCode preparation retains undefined CDP overrides and the original45s post-start readiness behavior; standalone global-helper callers without the optional callback retain their original default observation contract.

Finite IO/CDP replies only model the existing interfaces and timing observations. They do not prove native metadata latency, physical lineage, real CDP scheduling, actual launch, Quit or cleanup. The old source must fail the new common-cutoff/long-global checks for a concrete reason, not because a test expects an invented implementation shape.

## Closure and delivery

Both selected paths already belong to the existing1783 Desktop source vector and136 fast-lint operands, and the original8-file safe desktop test command. No workflow, package, roster, route or matrix edit is selected. Keep the production fixture naturally below800 physical lines; do not pack lines, split unrelated code or introduce a new abstraction to satisfy the cap.

Require prospective R1/R2, ordinary immediate-CAS documentary publication and full actual-document R2 before source afterimages. Then require complete before/after source R1/R2, strict numbered forward/inverse patch and full-tree preservation; ordinary source publication and independent actual-source R2. Preserve any other independently selected source/docs when rebinding the final publication parent.

Primary75 remains held while the known remaining source cuts are prepared. Before eventual primary FF, the sole CI observer must confirm no useful original execution would be lost. Resulting-head original tests/types/lint and affected Quit/Stop/metadata journeys, including original physical cleanup and other original gates, remain mandatory. No historical failure becomes PASS through this source change.

No local project/VM/compiler/test/lint/native/provider/GUI execution, manual Actions, CI-only commit, W01/genuineM16/native qualification transfer, P09 owner choice, producer archive adoption, Ready/merge/release/default activation or external whole-chain adoption is selected.
