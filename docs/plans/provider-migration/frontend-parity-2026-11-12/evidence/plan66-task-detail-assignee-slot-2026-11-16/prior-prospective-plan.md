# 66 — Task detail assignee slot stability

Status: prospective, awaiting root selection and publication. This document authorizes no source afterimage or execution by itself. It addresses the concrete original Task Board failure at clean `75cf2dcbfe2b540325ea50a022cb5195306a8c59`, within the existing Stage1 frontend parity journey.

## 1. Evidence and reason for the change

Run `43959134362`, job `133621515452`, artifact `14276860896` failed the original Close action after completed Create, Assign and Mark resolved receipts. The strict helper observed two stable target positions at `(1121, 167.125)` and then a final position `(1121, 171.125)`; the centered dialog contracted from 619.75px to 611.75px. It refused before mouse press. Fonts were loaded and final/stable animation counts were zero. The failure snapshot contains the read-only assignee presentation at the final rectangle; the later screenshot contains the picker again. The snapshot is not atomic with the guarded read, so the exact historical owner predicate is unproven.

The existing Header switches between a 32px small MemberSelect and a 24px medium MemberBadge. Its assignee slot has no minimum height. At the recorded single-row width, that 8px difference exactly explains the centered dialog's 4px position shift. The source independently establishes a normal presentation transition that can move an otherwise unchanged target. Full evidence bindings and limits are in the accompanying `r1.md` and `review.json`.

## 2. Exact selected source inventory, if approved

| Path | Before Git blob | Before SHA256 | Bytes / lines | Sole intended edit |
| --- | --- | --- | --- | --- |
| `src/features/team-task-detail/renderer/ui/TaskDetailHeader.tsx` | `68499fd50746417a48883f73ca1d25592c644089` | `9aa3aabc0d50852af7010fc9dfd1834905c6c078ac4bfe691e789f002ac05bd1` | 17067 / 465 | Add `min-h-8` to the existing assignee slot's class list. |
| `scripts/legacy-agent-host/desktop-proof-supplementary-sources.ts` | `fc47d6a0a2c38b33e8a5a6439dbddc9ee240ce10` | `aa3f5a3d846570be1066db23b657fda483216dcef15c1581903d007b6540e34f` | 22366 / 344 | Append only the changed Header path to the common supplementary array. |

The Header is bound to the original immutable source; root must confirm the same leaf in the publication parent. The roster is explicitly rebound to landed Plan63, preserving `scripts/e2e/comment-notification/cdp.mjs`. Preserve all incoming tree changes at publication; stop and rebind if either source preimage differs. No source afterimage exists at this prospective stage.

## 3. Presentation contract

Change only the existing inner assignee container from `flex min-w-0 items-center gap-2` to `flex min-h-8 min-w-0 items-center gap-2`. This is the container around the existing editable/read-only/unassigned alternatives, not the entire dialog, unrelated metadata, or a new wrapper.

Keep the exact `canReassign && onOwnerChange` condition, select and badge props, owner mutation callback, and all disabled/read-only/call-time `canEditNow()` guards. Do not retain stale authority or suppress the read refresh. The new minimum matches the existing small select height; larger or wrapped content can continue growing. Read-only/unassigned headers may retain up to 8px more vertical space than the prior assigned-badge branch. This small layout reservation is the entire intended UX change.

## 4. Source closure

Append `src/features/team-task-detail/renderer/ui/TaskDetailHeader.tsx` once at the end of `desktopProofSupplementarySources`, before its closing bracket. Its 256 existing paths remain an exact ordered prefix; the common count becomes 257. Preserve the separate 27-path process array and 46-path Windows Retry array byte-for-byte, as well as all other file text. The existing common-roster consumers provide original before/after source hashes; no fixed row-count oracle is introduced.

No workflow edit is needed: the current full typed lint covers `src/features`, workspace typechecking already runs, and the supplementary list is an existing explicit fast-lint operand. No unrelated UI dependency is added to the source roster merely because it was read during this investigation.

## 5. Acceptance contract stays unchanged

Preserve the entire original `desktop-ui-controls.ts`, Task Board and cross-team smoke sources, selectors, UI actions and order. In particular preserve one original Mark resolved action, one original Close action, the two stable observations, final owned-renderer read and exact coordinate equality before mouse press. Do not add delay, click tolerance, a new reacquisition loop, retry, input replay, relaxed visibility/authority check, or widened existing timeout.

No new test scaffold or class-mirroring unit case is selected. The existing original Task Board journey must exercise and pass the strict physical-input invariant on the exact resulting source. Existing frontend tests, workspace types and full typed lint remain required. Run none locally for this inert preparation; original CI is the execution authority. Later unreached Task Board assertions still count as missing acceptance until they actually run and pass.

## 6. Review and delivery

After published selection, prepare exactly two before/after images, a complete hash manifest and reversible patch. Verify that removing the single class token and the single new common-list string restores the two full beforeimages exactly. Bind source R1/R2 to the final bytes and fresh publication-parent leaves; preserve all incoming changes, Draft status, base branch and existing CI restrictions. Every selected source file remains below the existing 800-line limit without extraction or minification.

The original ZIP/receipt/log and its `INCOMPLETE` status remain immutable evidence. The original empty app-group cleanup is scoped to that receipt; `capturedHostObserved: false` / `capturedHostAbsent: null` is not a separate Host-absence PASS. The patch would repair a demonstrated reachable geometry change, not prove the unobserved timing of historical owner-state transitions. This selection does not qualify other OS/provider tuples, full frontend parity, or any genuine Claude/Codex behavior.
