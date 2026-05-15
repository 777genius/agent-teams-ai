# Command Palette Feature

This slice is the foundation for extending `Cmd/Ctrl+K` from project/session search into a real command palette.

## Intent

The palette should stay a thin host:

1. collect the query and UI context
2. ask ordered providers for matching `CommandItem`s
3. rank/dedupe the items in pure core code
4. render the list
5. execute the selected item's typed `CommandIntent` through one centralized executor

Providers must not perform side effects. They only describe possible commands.

## Architecture Rules

Use this direction for all follow-up work:

- Providers return declarative `CommandItem` objects.
- Providers may read already-loaded renderer state passed into their factory.
- Providers should not call Zustand actions, IPC, dialogs, or navigation directly.
- Side effects live in `renderer/adapters/executeCommandIntent.ts`.
- Ranking, scoring, dedupe, and cancellation stay in `core/` and must remain framework-free.
- New commands should use typed `CommandIntent` variants instead of ad hoc `run()` callbacks.
- Dangerous actions need confirmation before execution.

This is deliberate. A `run()` callback on every item is faster short term, but it spreads store/IPC/navigation behavior across many files and makes command safety hard to review.

## Current Foundation

Implemented providers:

- `staticActionsProvider` - dashboard, teams, settings, provider settings, notifications, schedules, extensions
- `projectsProvider` - repository/project switching
- `sessionsProvider` - current/global conversation search through existing search APIs
- `teamsProvider` - open team tab
- `tasksProvider` - open global task detail

Implemented core behavior:

- fuzzy scoring
- deterministic ranking
- provider-order tie break
- dedupe by `dedupeKey`
- provider isolation when one provider fails
- async cancellation so stale session search results do not overwrite newer queries

## Follow-Up Scope

Recommended next PRs:

1. Add provider/executor tests for renderer intents.
2. Run real Electron smoke checks for `Cmd/Ctrl+K`, project selection, session search, global search, team/task/static actions.
3. Add `MembersProvider` for safe member navigation: profile, messages, logs.
4. Add dialog-opening intents, not direct side effects, for flows that need user input:
   - create team
   - create task
   - send DM
5. Add confirmation-capable intents for dangerous actions:
   - restart member
   - stop team
   - move task status
6. Only after confirmations and error states are clear, add mutating task/team/member operations.

## Product Safety Notes

Do not implement `Create team` as a direct `createTeam(...)` call from the palette. Creating a team needs project path, members, provider/model/effort, permissions, and conflict handling. The command should open the existing create-team flow.

Do not implement `Restart member`, `Stop team`, or task status changes without confirmation UX. Those are side-effecting operations and must be reviewable from one executor path.

Do not add plugin-contributed commands in this slice yet. Keep this feature internal until the command model is stable.

## Test Commands

Focused tests:

```bash
pnpm exec vitest run src/features/command-palette/core/domain/__tests__/rankCommandItems.test.ts src/features/command-palette/core/application/__tests__/resolveCommandPaletteItems.test.ts
```

Typecheck:

```bash
pnpm typecheck
```

Focused lint:

```bash
pnpm exec eslint src/features/command-palette src/renderer/components/search/CommandPalette.tsx
```

## Acceptance Direction

A follow-up is on track if adding a new command usually means:

1. add or extend one provider to return a `CommandItem`
2. add a typed `CommandIntent` if needed
3. add one executor branch for the intent
4. add focused tests for ranking or execution behavior

If a change requires putting domain logic back into `CommandPalette.tsx`, it is moving in the wrong direction.
