# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog and this project follows Semantic Versioning.

## [Unreleased]

### Changed

- **Breaking for HTTP and MCP clients:** `POST /api/teams` and MCP `team_create` now require `projectContextMode` (`shared` or `per_project`) and answer 400 with code `PROJECT_CONTEXT_MODE_REQUIRED` without it. Before, they always created a `shared` team. Migration: send `projectContextMode: "shared"` to keep the old behavior; `per_project` creates a team with separate history per project folder, which `team_launch` can launch and the MCP board tools can use with `projectPath`.
- HTTP create and launch accept an empty `effort` or `fastMode` as "not set", like the app (they were refused with 400).

### Added

- HTTP `POST /api/teams/:team/launch` and MCP `team_launch` launch a team with separate history per project in the project given by `cwd`, with the project-context launch of the app (reservation, launch gate, copy, launch settings). Like every HTTP launch, it does not mark the team as watched for the open app and does not take the backup identity fence the app takes for a draft.
- MCP board tools (`task_*`, `message_send`, `review_*`, `kanban_*`, process, group chat, cross-team and work-sync tools; not the `runtime_*` bridge) work with a team that keeps a separate history per project: they take an optional `projectPath` and work on that project's history only. A refusal writes nothing and reaches the MCP client as a `UserError` whose text starts with the code, because MCP clients only see the text: `[PROJECT_REQUIRED]`, `[NO_PROJECT_HISTORY]`, `[PROJECT_LAUNCH_PENDING]` (a launch runs there), `[PROJECT_LAUNCH_INCOMPLETE]` (a launch there failed: launch again), `[PROJECT_MISMATCH]` (a project copy named with another project), `[UNRESOLVED]`, `[TEAM_METADATA_UNREADABLE]`; refusals of `cross_team_send` get their code the same way. A call without `projectPath` on any other team is unchanged. A call with `projectPath` always asks the app, also for an ordinary team: without a running app it is refused, a relative path answers 400, and a project copy named with a folder that is not its project answers `PROJECT_MISMATCH`. The app answers which project copy holds the board at `GET /api/teams/:team/board-target?projectPath=`.
- GPT-5.6 Sol, Terra, and Luna fallback selection for Codex teams, dynamic future-model efforts, and in-app Codex CLI updates.
- Traditional Chinese (Taiwan, `zh-TW`) app language with Taiwan terminology. Traditional Chinese system locales (zh-TW, zh-HK, zh-MO, zh-Hant) select it automatically, missing keys fall back to English instead of Simplified Chinese, and cron schedule descriptions use cronstrue's `zh_TW`.

### Fixed

- A cross-team message to a project whose first launch failed is refused with `PROJECT_LAUNCH_INCOMPLETE` (launch the team again there) instead of `PROJECT_LAUNCH_PENDING`, which asked to wait for a launch that no longer runs. A copy whose launch is still in flight (from its reservation until it was confirmed) or whose team runs is still reported as pending. OpenCode runtime delivery can only observe the launch tracker, not a separately running team.
- Windows: direct-process teammates now spawn non-detached with the app's hidden console, reducing terminal-window flashes during Bash, git, and PowerShell tool calls. Native GUI validation and process-tree cleanup of tool subprocesses after app termination remain to be verified.
- Windows: ccusage/tokscale token-usage importer child processes now request `windowsHide: true`; physical GUI verification of zero flashes remains pending.

## [1.2.0] - 2026-03-31

### Added

- Agent Graph with real-time force-directed visualization, kanban task layout, animated message particles, member hexagons with avatars, and cross-team ghost nodes.
- Per-team tool approval controls with readable permission prompts and interactive AskUserQuestion buttons.
- Task comment notifications.

### Changed

- Team page performance with many tasks.
- Team provisioning visibility on the team screen.
- Default action mode switched to `delegate` so the lead coordinates instead of executing.
- Skip pre-flight CLI check button in launch/create dialogs.
- MCP config moved from `/tmp` to `userData` with cleanup on spawn failures.
- Task change presence tracking overhaul.
- Session label formatting and session item display improvements.
- Update dialog layout cleanup.
- Auto-approve banner softened from warning to info styling.
- macOS title bar drag area improvements.

### Fixed

- Tool approval sheet hooks ordering crash.
- Auto-approve reset when launching with manual approval.
- `Allow all` and Settings panel targeting the wrong team.
- AskUserQuestion Enter key bypass and edge cases.
- Updater installing non-newer versions and showing updates for unavailable platforms.
- Permission request deduplication across all entry paths.
- Renderer IPC sends during crash recovery.
- Standalone mode without Electron.
- Sanitized inline HTML in markdown rendering.

## [1.1.0] - 2026-03-25

### Added

- React 19 + Electron 40 migration.
- User-initiated task starts from the kanban board.
- Auth troubleshooting guide in the CLI status banner.
- Syntax highlighting for R, Ruby, PHP, and SQL code blocks.
- Collapsible output sections in tool results with markdown preview toggle.
- Styled `@`-mentions in task comments with colored member badges.
- Worktree-based projects detected on the dashboard.

### Changed

- 3x faster transcript search with optimized plain text matching.
- Single-pass message processing replaces multiple filter passes.
- Protocol noise filtering hides raw idle and teammate messages from lead thoughts.
- Improved kanban column styling with colored headers and subtle body tints.
- Teams sorted by last activity with alphabetical fallback.
- Dynamic member colors in the Add Members dialog.

### Fixed

- Cost overcounting from duplicate request ID tracking.
- WSL mount path translation and Windows drive letter normalization.
- Sidebar repo and branch state not syncing when switching tabs.
- CLI auth detection with non-default config paths.
- XSS vulnerability via unsanitized inline HTML in markdown.
- Standalone mode crash without Electron environment.
- Stale sessions incorrectly shown as ongoing after 5 minutes of inactivity.
- Incorrect error message when attaching files to offline team lead.

## [1.0.0] - 2026-03-23

Initial public release.

### Added

- `general.autoExpandAIGroups` setting: automatically expands all AI response groups when opening a transcript or when new AI responses arrive in a live session. Defaults to off. Stored in the on-disk config so it persists across restarts.
- Strict IPC input validation guards for project/session/subagent/search limits.
- `get-waterfall-data` IPC endpoint implementation.
- Cross-platform path normalization in renderer path resolvers.
- `onTodoChange` preload API event bridge.
- CI workflow for macOS/Windows (typecheck, lint, test, build).
- Release workflow for signed package builds.
- Open-source governance docs (`LICENSE`, `CONTRIBUTING`, `CODE_OF_CONDUCT`, `SECURITY`).
- Capped NDJSON diagnostic log for Claude CLI auth/status in packaged builds (Electron logs directory).

### Changed

- `readMentionedFile` preload API signature now requires `projectRoot`.
- Notification update event contract standardized to `{ total, unreadCount }`.
- Session pagination uses cached displayable-content detection for performance.
- File watcher error detection optimized for append-only updates.
- CLI status gathering uses interactive shell environment, merged PATH, and config directory hints aligned with terminal sessions.
- Claude binary resolution deduplicates concurrent resolve calls and uses consistent HOME when probing install locations.

### Fixed

- Lint violations in navigation and markdown/subagent UI components.
- Test mock drift causing runtime errors in test output.
- Multiple Windows path handling edge cases.
- Packaged builds could show "not logged in" despite a working CLI in the shell.
- IPC CLI installer cache clears when `getStatus` fails so the UI does not stay on stale auth state.
