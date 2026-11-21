# Review flow of a per-project team

A team with separate history per project has **one** review flow, like an ordinary team. Before this change the setting lived with the task board of each project copy, so a choice made in project A did not apply in project B (the same class of defect that [per-project-launch-settings.md](./per-project-launch-settings.md) fixed for launch settings).

## Where it lives

| What               | Where                                                                                                                                                                                         | Who reads it                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| The team's setting | `reviewFlowSettings` in `team.meta.json` of the logical team: missing = the team never saved one, `null` = it follows the default for all teams, `{ reviewFlow, reviewFlowPrompt }` = its own | the app (settings page, board popover)                  |
| What agents use    | the override in `kanban-state.json` of each project copy, as for any board                                                                                                                    | the controller, when a task of that project is reviewed |

The field is `board-definition` in `TEAM_META_FIELD_OWNER`: it belongs to the team, is copied into the board of every copy, and never into the metadata of a copy. `TeamMetaStore` keeps it through every write that does not state it (as it does for `projectContextMode`), so writers that rebuild the record from a request (launch settings, display metadata, member settings) cannot drop it.

## Writes

One path: `TeamKanbanReviewFlowGateway.writeOverride` asks what the name is (`kindOf`: `classifyTeamKind` with one scan for the owner of a copy) and then

- **an ordinary team** (or a copy that an ordinary team kept from an earlier period): its board, exactly as before;
- **a per-project team**: `saveProjectTeamReviewFlow` under the logical-team lock (the one launch admission and definition edits take): list the project boards first (a damaged or deleting contexts index refuses before anything is written), save the team's setting, then write the board of every copy. Running copies are written too: an ordinary team's board is written while it runs, and there is no "all contexts stopped" gate here. A copy whose first launch is still in progress is written when its owned draft exists; a bare reservation is not (the launch copies the setting when it creates the copy);
- **a project copy of a per-project team**: refused ("set it for the team").

It fails closed: when the metadata of the team cannot be read, nothing is written, with a message that says why (it is unknown whether the team keeps a separate history per project). This also applies to an ordinary team, whose board was written without that check before. A copy is proven by one scan of the contexts indexes; when that scan fails (a damaged index of some team), a save for a copy that an ordinary team kept is refused too.

Lock order is logical-team lock, then the board lock of each copy inside the controller call. The board lock is a synchronous file lock (`withTeamBoardLock`); nothing that holds it can wait for the logical-team lock, and the controller processes of agents never take the logical-team lock, so the order cannot invert.

**Partial failure.** When some boards cannot be written (a board lock timeout, a broken `kanban-state.json`), the team's setting and the other boards stay written and the save answers with `ProjectBoardsNotUpdatedError`, which names each project. The settings page and the board popover then list those projects as not carrying the setting, with Save available; saving again writes them. A launch of that project also copies it (below).

## Launches

`TeamProjectContextDraftMaterializer` calls `projectReviewFlow(logical, copy)` for the copy it prepares, new or existing. It reads only the setting of the team (`readTeamSetting`), not its projects. When the team saved a setting and the board of the copy does not carry it, the board is written; otherwise nothing happens. It never fails a launch (an ordinary team's launch never depends on its board either): a failure is logged as an error and the settings page shows the project as not carrying the setting.

## Teams that existed before

A per-project team that never saved a setting has no field. Nothing writes the boards of its projects until the user saves: each project keeps what it had, and a launch leaves the board alone. The app shows the team as one entry:

- when its projects agree on the default, it follows the default and nothing needs saving;
- when they agree on settings of their own, it shows them, says they are not saved for the team yet (a project launched for the first time would start on the default) and offers Save;
- when they differ, the editor says so ("Differs by project") and lists each project with everything it has, its instructions included. "Use these settings" puts what one project has into the editor; Save applies the settings in the editor to every project. That is the explicit choice: nothing a project had is replaced without being shown, and no value is picked silently.

## The app

The overview (`ReviewFlowOverview.projectTeams`) reports every per-project team with what it saved and its project copies, as the main process proves them from the contexts index (the same list a save writes, so a copy whose first launch never finished is included; the team list of the app folds only ready copies). `foldProjectTeamBoards` (renderer view model) turns the per-board overview into one entry per team: the boards of those copies stop being entries of their own, and the team shows its saved setting, or the one its projects share. A copy that an ordinary team retained keeps its own entry. The board popover of a project copy edits its team's setting (`reviewFlowTeamOf`) and reads the overview again when it opens. After any team save the store reads the overview again, because a save of a per-project team changes several boards (and a partial failure changes some).

## Verification

- Unit: `TeamKanbanReviewFlowGateway.test.ts` (routing, order under the lock, partial failure, nothing written when listing fails, copy refused, fail closed), `projectBoardReviewFlowSync.test.ts` (launch copy: migration no-op, write only when different, repair), `TeamMetaStore.reviewFlow.test.ts` (missing vs `null`, kept by writers that do not state it), `reviewFlowViewModel.test.ts` (fold, differ, not applied), `ReviewFlowPolicyEditor.test.tsx`, `createReviewFlowStore.test.ts`, `TeamProjectContextDraftMaterializer.test.ts`.
- Disk integration: `teamProjectContextCreate.integration.test.ts` with the real metadata store, contexts registry and controller board writes: a running copy and a pending copy are written, a copy and unreadable metadata are refused with nothing written, older boards are kept until the first save, a new copy takes the team's setting at launch.
- Real Electron: `scripts/e2e/project-scoped-team-history-desktop.ts`, section `verifyTeamReviewFlow` (projects that differ shown in the board popover of project A with the instructions of A, the settings of A taken over and saved for the team and both boards, a team setting written to both boards, a copy refused, the settings page lists the team once) and the HTTP section (a setting saved before the first launch reaches the board of the new copy, which the overview reports as a project of the team while its first run is not ready).

## Not covered

- A board of a running copy is written while its agents work, as for an ordinary team; a review that is being decided at that moment uses whichever value the controller read.
- The fixture runtime of the E2E denies agents, so no review was decided by a real agent after a change.
- Each board write waits for the board lock of its copy synchronously, up to 5 s (as a save of an ordinary team does for its one board), so a save of a team whose agents hold several boards can block the app for that long per board.
- A `kanban-state.json` that is not JSON at all reads as following the default (as before this change); a save to it fails and names the project.
