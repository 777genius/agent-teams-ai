# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog and this project follows Semantic Versioning.

## [Unreleased]

### Added

- GPT-5.6 Sol, Terra, and Luna model selection for Codex teams.

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
