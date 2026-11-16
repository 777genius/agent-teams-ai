# Task Board 75cf: source-bound layout finding

Status: R1, prospective repair only. No production or acceptance afterimages, execution, CI action, or publication was performed for this report.

## Observed original failure

Original run `43959134362`, job `133621515452`, artifact `14276860896` belongs to clean head `75cf2dcbfe2b540325ea50a022cb5195306a8c59`. The retained ZIP is 868196 bytes, SHA256 `f15cfa972cd2b4fd0852f9a2de62751bbcd84353249bf1daf2960c1c53bd1b76`; root verified all 19 members, safe paths and CRC. Exact decoded job log is 194804 bytes, SHA256 `8e3749c2a70f2e82723d60cdf8862e91e83584bddc6428f4ae55f2b6c6f30931`. Receipt SHA256 is `39a8125ebd1db403bad8c5ff640748d46159df0a5c33ed851b1e613ce9711ef9`.

The original `task-board-ui` receipt is `INCOMPLETE`. Task creation, assignment to alice, and Mark resolved each have a completed command receipt. The next original action is `ui.click('[role="dialog"] button', 'close original Task detail', 'Close')` at `desktop-task-board-ui-smoke.ts:473`. The shared control throws at `desktop-ui-controls.ts:372`, before the Close mouse press. The planned QA inventory is not evidence that subsequent Columns, blocked Start/Complete, reload, attachment/comment or cross-team actions ran.

The close target was stable twice at `(1121, 167.125)` in a dialog `[252, 140.125, 896, 619.75]`. Its final guarded observation moved to `(1121, 171.125)` in `[252, 144.125, 896, 611.75]`. Both stable observations and the final observation report zero target/dialog animations and loaded fonts. The helper's exact equality correctly refused the uncertain physical input. The actual trace contains one Close hover and no Close click attempt.

The later failure snapshot has the same selected task, one dialog, no assignee-picker button, disabled subject/Delete controls, and a read-only connected comment textarea. Its Close rectangle matches the final failed rectangle. A still-later failure screenshot shows the editable picker again. These are separate observations: they support a transient presentation change, but do not atomically establish the specific owner predicate or read phase at the instant of the position change.

## Exact renderer mechanism

`TaskDetailHeader.tsx` blob `68499fd50746417a48883f73ca1d25592c644089` has one existing assignee slot at line 278. Its original `canReassign && onOwnerChange` branch renders `MemberSelect size="sm"`; the other branch renders `MemberBadge size="md"` for this assigned task. The select's existing small height is `h-8`; the read-only badge's avatar is `size-6`, with no wrapper height retaining the select's space. Those are 32px and 24px in the recorded layout. Other metadata controls are no taller than 24px in this observed single row.

The shared Dialog centers its intrinsic content. Consequently the observed 8px content contraction moves its top and absolute Close control down 4px: `(900 - 619.75) / 2 = 140.125`; `(900 - 611.75) / 2 = 144.125`. This exactly matches the recorded geometry. The source establishes a reachable layout defect in the normal editable/read-only branch, independent of which individual ownership condition changed historically.

`useTaskDetailPresentation.ts` sets `canReassign` from pending-task status and `sessionController.isOwner`. `useTaskDetailSession.ts` intentionally requires the same current context/task/surface, ready read phase, absence of deletion/unavailability, and ownership. The comment textarea uses the same controller's `!isOwner` for read-only. The accepted clarification mutation invalidates the task-detail read source and then refreshes Team data; this demonstrates a legitimate later refresh boundary, not the exact historical sequence of every render. Those authority and read-currentness checks must remain intact.

## Smallest proposed repair

Add `min-h-8` to that existing assignee slot, leaving its branch, handlers, children and all authority checks byte-identical. The editable control already needs that space; the read-only representation then retains it. This has one explicit layout effect: a read-only or unassigned slot may reserve up to 8px more vertical space than the prior 24px assigned badge. Content can still wrap or grow beyond the minimum. No new permission affordance, cached authority, modal height cap or timing rule is introduced.

Add exactly the changed Header path to `desktopProofSupplementarySources`, after the existing last common operand. Rebind this file to landed Plan63 blob `fc47d6a0a2c38b33e8a5a6439dbddc9ee240ce10`; preserve its CDP pin, all old order, the separate process array and the separate Windows Retry array. The Header was absent from the original 1777 receipt rows and the current common list. This closes the directly changed source dependency without a broad snapshot expansion.

Two source paths suffice. Existing Host Team typed lint already covers `src/features`; the supplementary file is already in its explicit fast-lint list. Existing workspace types, frontend checks and the unchanged original Task Board E2E provide the validation route. A new test that only mirrors a Tailwind class would not establish geometry behavior and is not proposed.

## Preserved acceptance and limits

The shared UI helper, Task Board action source, all original selectors/action counts/order, two stable observations plus the final exact point guard, deadline bounds, ownership checks, and cleanup remain untouched. There is no sleep, point tolerance, click bypass, new retry or replay of an uncertain input. No workflow change or new framework is proposed.

All 1777 original source rows match before/after. The exact five root-provided source snapshots were corrected from retained API strings to remove a serialization-added LF before this report was sealed; their SHA256 values match the original receipt pins. The new Header snapshot was independently fetched at the original immutable head and Git-blob verified. The roster beforeimage is the later, already landed Plan63 version, not an inferred original-75cf file.

Cleanup reports app exit 0, no signal, and an empty remaining process group. It records `capturedHostObserved: false` and `capturedHostAbsent: null`; this report does not convert that into an independently observed Host-absence result. The proposed geometry repair is source-based; it does not turn the failed original run into PASS or establish completion of any unreached action. A future exact-source original run must still pass unchanged.
