# Restore CI prerequisites for OpenCode PRs #1294 and #1295

## Problem and scope

Base `2a4e1c2938923826cb1555e8fb894a3fdbb4447e` fails the source-size guard in six legacy files and the expanded TypeScript 7.0.2 graph reports two TS2554 errors in `SafeWebhookSender.ts`. These failures are inherited by both OpenCode PRs.

This prerequisite restores existing checks without weakening their limits. It preserves the fixed v2.19.0 release source, the two OpenCode branches, Attention work in #1293, and the active Host parity stack.

## Small, cohesive changes

| Area | Change | Preserved boundary |
| --- | --- | --- |
| Controller task store | Extract comment construction, reference normalization, and clarification retry policy | Atomic update, current-task read, board lock, and retry semantics |
| Controller task operations | Extract the existing task-reference builder and merge helper together | Permissive merge stays distinct from persisted-reference normalization |
| Team data service | Extract pure member-shape and live-roster policy | Notification transactions and persistence remain in the service |
| Team IPC | Extract strict task-reference validation unchanged | Handler validation order and all call sites |
| Scheduler | Use constructor parameter properties for existing dependencies | Mutability, admission checks, and runtime behavior |
| Documentation config | Move English/Russian sidebar declarations together | Exact content, ordering, notification links, and locale mapping |
| Webhook adapter | Supply the required empty address argument on DNS callback errors | Hostname/family rejection, pinned DNS answers, and secret redaction |

The controller retains its current CommonJS runtime contract. No new transpilation requirement is introduced.

## Review and verification

1. Separate owners edit controller, main/IPC, and scheduler/docs/webhook paths.
2. Independently review extraction semantics, especially clarification idempotency and roster admission.
3. Run existing targeted controller, roster, IPC, scheduler, and webhook tests; add only missing contract checks for extracted input validation and the real HTTPS lookup callback.
4. Verify sidebar values are identical and the docs configuration builds.
5. Require zero source-size violations without raising caps. Remove the retired docs baseline entry after that file falls below 800 lines and lower the five changed legacy caps to their new physical line counts.
6. Run TypeScript 7.0.2, applicable lint and architecture guards, then ordinary current-source CI.
7. After this prerequisite merges, update and qualify #1294/#1295, then merge them through the normal gate.

Native/free-model OpenCode E2E remains a separate proof. This cleanup does not establish the cause of the original `ready → offline` incident.

## Estimate before implementation

Approximately 350–500 existing production lines moved, 30–80 new production lines, and 60–120 focused test lines. Complexity: 3/10; change risk: 3/10; confidence in the bounded approach: 8/10. These estimates exclude existing repository-wide failures discovered by full CI.

## Implementation verification

- Independent reviews found no blocking issue in controller/IPC extraction, scheduler/docs changes, or the webhook callback fix.
- 724 targeted tests passed: controller 167, team data/IPC 484, scheduler 45, and webhook 28. The three new default-network webhook cases first failed on the original callback arity, then passed with the fix.
- The changed TypeScript source/test graph and its transitive imports passed the pinned native TypeScript 7.0.2 compiler. The complete root typecheck initially exited 137; this is not a successful workspace qualification.
- The VitePress build passed, and both sidebar arrays were verified against the base commit for exact values and ordering.
- Source-size and Team Provisioning architecture guards passed. No size exception or architectural allowance was added; five existing caps were reduced and the retired docs exception was removed.

Ordinary current-source Full qualification and the separate native OpenCode proof remain required before claiming delivery is complete.

