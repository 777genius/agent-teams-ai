# Team project context

The feature separates a team **definition** from its project-specific **work history**.

- `contracts/` owns the browser-safe history-mode type.
- `core/` owns the two distinct defaults: existing persisted teams without a field remain shared; newly created teams default to `per_project`.
- The intended application boundary maps a verified logical team and selected project to a native-compatible physical execution team. Do not use a UI filter as isolation.
- Do not create physical contexts merely to read, or infer ownership from an alias prefix.
- Runtime/storage/renderer integration must not expose `per_project` as working until real inbox/task/session isolation is proven.

See [the reviewed implementation plan in Draft PR #1215](https://github.com/777genius/agent-teams-ai/pull/1215/files) in the plan PR #1215.

## What a team name is (one place for each question)

Every caller that has to treat a logical team, a project copy and an ordinary team differently asks these three questions through the same code. Do not re-implement them with a raw `meta.projectContextMode` check or a `list`/`listRetained` ternary.

| Question | Where | Policy on unreadable state |
| --- | --- | --- |
| What mode is the team in? | `main/projectContextMode.ts` `readTeamProjectContextMode` (`TeamProjectContextRuntimeResolver.getMode` delegates) | throws `TeamMetadataUnreadableError`; a caller may name what it refuses, the decision is the same |
| Which project contexts does it own, and does it carry history at all? | `main/ownedHistory.ts` `listOwnedContexts`, `ownsProjectHistory` | the registry throws for a damaged or deleting index |
| Logical team, project copy or ordinary team? | `core/classifyTeamKind.ts` `classifyTeamKind` (edit router, editor, schedules, launch) | fails closed |

`main/resolveTeamTarget.ts` is the one deliberately more tolerant policy on top of the first two: it serves callers that take a name literally (HTTP, MCP) and may stop a team by its exact name when its metadata is unreadable and it has no contexts index. A new consumer adds a capability on top of these primitives; it does not add a branch to them.

`test/features/team-project-context/teamKindMatrix.test.ts` pins what every consumer answers for each kind of name on the same on-disk state.
