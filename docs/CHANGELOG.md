# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog and this project follows Semantic Versioning.

## [Unreleased]

## [1.0.0] - 2026-03-19

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
