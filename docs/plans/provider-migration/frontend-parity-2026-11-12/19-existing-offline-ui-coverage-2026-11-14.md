# Existing offline Skills and cross-Team UI acceptance

Baseline: `b1485a9e96a937875f54d06a21e09ff70d3ff8bd`, Draft PR #1192.
The current thirteen finite Desktop lanes do not invoke two existing offline
journeys. Add those original journeys to the same source-bound matrix.

## Scope and acceptance

1. `skills-ui` uses `prepareDesktopSkillsFixture` and the existing Skills UI
   driver. It exercises actual import/edit/trash controls and durable
   receipts, including the original explicitly held intent and physical trash
   proof, known rejection, unknown held work and stale context refusal. Its
   two selected management profiles contain only metadata refusal sentinels;
   verify those exact paths, digests and descriptor bindings before app startup.
   They configure management without configuring Runtime sessions. Admit only the
   existing closed `isSkillsMetadataRefusal` observations; all other lanes keep
   their empty-refusal requirement. Require the original eight screenshots and
   five journal rows; never count the staged held row as a UI operation.
2. `task-board-cross-team-ui` uses its existing Taskboard/cross-Team fixture and
   driver, including review, notification, transfer, oversized comment,
   trash/restore, timing and the post-cleanup owner-routing continuation.
   Require each original proof and the continuation's completed receipt.

Extend only explicit finite-mode admission and workflow wiring/receipt checks.
Keep the existing drivers, controls, provider exclusions, source freeze,
deadlines, screenshot hashes and physical cleanup checks. No new product route,
provider executable, user data, inferred success or native qualification is
introduced. The separately planned collaboration/extensions/import journeys
own their additional fixtures and remain distinct lanes.

Estimated delta: 50–90 workflow/admission lines, no production change.
Complexity: 3/10; confidence in existing fixture reuse: 8/10. Review the exact
mode admission and final receipt shape independently, run the existing admission
tests and script types, then require actual published-source Electron receipts.
Queued, skipped, cancelled or fixture-only results do not qualify the UI.
