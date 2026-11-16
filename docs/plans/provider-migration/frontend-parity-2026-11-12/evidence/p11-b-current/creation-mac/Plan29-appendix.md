## E3 original macOS Creation failure: saved-prompt review boundary

The original Creation job **133178909700** in run **43831885626** failed at step 12 on exact source **72e6ec04444969d343d73834c70bc4e261100fc9**, tree **de80fbfbffb3fe4daabf6cc9be258cc8df534524**. The terminal snapshot completed at **2026-11-16 08:43:42 UTC**; the original raw log, official artifact head and two checkout rows agree. This is a Creation UI failure. It is not an actual P11 regression result or a Host Team/static qualification.

The one-time retained full log is **66,388 bytes**, blob **be8e37438f24a2e6288a6a24be27fd181a671ff7**, SHA-256 **49070d538c8377d29c7d16a30071c5fda6be17413f6bd4de3679fea22f004122**. Its bytes equal the content of the retained original MCP response (**67,680 bytes**, blob **a21d2b98b8d029f4112983830089431e69619882**). Official ZIP **14209557495** is **1,446,976 bytes**, blob **6f5c74644f617090031d218c385236835c2dec85**, SHA-256 **4e991a16c17dec8b2bffe6632c1236f1badb90105c97feb3ca94535e09fdcb8e**. All **24 unique safe members are PNGs**; CRCs, extracted bytes and image dimensions were checked. There is **no final result JSON** in the archive or success result printed in the log.

### First retained refusal

At **08:41:54.8473610Z**, the original error is:

> Timed out waiting for saved prompt acknowledgement visible before Save

Its stack is `CdpClient.waitFor` at Creation driver line 462, `exerciseScheduleUx` line 875 and `main` line 2029. The last action marker, at **08:41:07.7383330Z**, is selecting the fixture team and reviewing its saved one-time startup prompt. All **23 retained markers** equal the first 23 of the **32-marker** successful original E2 macOS run. This establishes completed earlier flow only to the original source boundaries; the absent final JSON does not provide all 25 success flags.

The original schedule sequence first rejects invalid cron/timezone at native IPC, opens the Schedule editor, attempts pristine Save and waits for “Team is required.” It then opens the team Combobox, clicks a cmdk item whose text includes `fixture.teamName`, and waits for `#schedule-saved-prompt-reviewed`. The original wait remains **45 seconds** with **80 ms** polling and the existing **30-second CDP command timeout**. It checks its loop deadline before a read; it has no strict post-read cutoff. No timer, action, retry or acceptance rule was changed.

The failure dump is the existing four-field renderer projection with an **800-character body-text prefix**. It reports a dialog, no Creation-page name, and **org-team-e2e-8e8d57e5** as the selected Schedule team. This agrees with the actual failure PNG. An earlier actual Launch frame names the intended fixture **teams-create-page-e2e-961f3812-d46d-4321-a219-8e7161c753d4**.

### Three actual image views and the source limit

Exactly three original PNGs were opened singly: `teams-create-launch-controls-loaded.png`, `teams-create-schedules-pristine-submit-validation.png` and `teams-create-failure.png`. The other 21 were integrity checked only. The earlier Launch image shows the intended fixture, OpenCode/test-model and unavailable/fresh-catalog warnings. The pristine Schedule image shows “Team is required” in the lower form. The failure image shows the organization team in the description and selector, an empty label and the default cron. The failure image's lower form is outside the viewport; the failed DOM wait, rather than this image alone, establishes that the acknowledgement was never accepted.

Eight immutable source bodies were freshly read and are byte-identical to E2: the four canonical Creation workflow/driver/helper files and the four interpretation leaves `LaunchTeamDialog.tsx`, `HistoricalPromptReview.tsx`, `useSavedPromptReview.ts` and `combobox.tsx`. In the actual source, the non-disabled Combobox callback forwards its captured `option.value` to the selection state. The saved-prompt hook changes only the review object, not that selected-team state. The Creation click helper measures the queried element and then sends press/release; it retains neither the dispatched option identity nor hit/geometry/selection-transition history. The saved-request completion/result is also absent. **The last selected-team mismatch is retained; the reason for that mismatch and for the missing review remains unproved.** No production or harness repair is selected by this packet.

### Unexecuted work and cleanup

The original owned-process helper file passed **3/3**, with no failures, skips or cancellations, using Node **26.12.1** and pnpm **11.22.0**. The Creation prerequisite install/build/staging steps succeeded. This job does not run the P11 whole-eight-file command or the Host Team contracts.

The later Schedule acknowledgement, label/prompt entry, field-level cron checks, valid Schedule create/update/delete, zh-TW branch and final result publication were not reached. The original primary error is thrown after `finally`; source order and the absence of the combined-error branch imply that the original cleanup call returned without an exception. That is a **source-implied return only**: no final group census, cleanup result, process-group ID or app/Host exit code is archived. It is not an independent physical-custody or natural-exit certificate. The finite deny-all/degraded-runtime and SQLite-fallback tail messages do not replace the retained primary error or establish its cause.

Canonical author files are `audit.json` (**1a3c1c2053b4d730f63ab5b5bbf05a8954d55d28**) and `source-proof.json` (**2d6d91f0d57bb0720e30651e3ded621376e65a3c**). This packet preserves the current original failure and the older same-source comparison separately. No project execution, CI replay, source/ref change, timeout increase or future qualification is claimed.
