# Agent Navigation

This file is a navigation layer for architecture and implementation guidance.

Start here:

- Repo overview and commands: [README.md](README.md)
- Working instructions and project conventions: [CLAUDE.md](CLAUDE.md)
- Hard guardrails: [AGENT_CRITICAL_GUARDRAILS.md](AGENT_CRITICAL_GUARDRAILS.md)
- Canonical feature architecture standard: [docs/FEATURE_ARCHITECTURE_STANDARD.md](docs/FEATURE_ARCHITECTURE_STANDARD.md)
- Agent team launch/runtime debugging runbook: [docs/team-management/debugging-agent-teams.md](docs/team-management/debugging-agent-teams.md)

GitHub repository disambiguation:

- For this workspace, the canonical GitHub repository is `777genius/agent-teams-ai`.
- When reviewing or discussing PR `#126`, inspect `777genius/agent-teams-ai#126` unless the user explicitly names another repository.
- Do not confuse this workspace with upstream or similarly named forks such as `matt1398/claude-devtools`.

Default local run target:

- Use the desktop Electron app: `pnpm dev`
- Do not start the browser/web dev mode for normal development or smoke checks. The browser path is limited and lacks the full desktop runtime, IPC, terminal, provider auth, and team lifecycle behavior.
- When documenting or recommending startup commands, point contributors to the desktop app unless a task explicitly asks for browser-mode internals.

For new features:

- Default home for medium and large features: `src/features/<feature-name>/`
- Reference implementation: `src/features/recent-projects`
- Feature-local guidance for work inside `src/features`: [src/features/CLAUDE.md](src/features/CLAUDE.md)

## Review guidelines

- Treat regressions in agent team messaging, task lifecycle, session parsing, code review UI, and provider/runtime detection as high priority.
- For team launch hangs, OpenCode `registered`/`bootstrap unconfirmed`, missing teammate replies, or suspicious task logs, follow [docs/team-management/debugging-agent-teams.md](docs/team-management/debugging-agent-teams.md) before changing code.
- For launch failures, first inspect the newest artifact pack under `~/.claude/teams/<team>/launch-failure-artifacts/latest.json`, then open its `manifest.json`. The manifest includes `classification`, `bootstrapTransportBreadcrumb`, launch diagnostics, member spawn statuses, and redacted copies/tails of launch-state, bootstrap-state, bootstrap-journal, CLI logs, progress trace, and runtime adapter trace.
- When running live smoke tests, keep cleanup narrow: stop only the smoke-owned team/run and launch-owned process teammates. Do not kill shared OpenCode hosts, unrelated tmux panes, or user teams while trying to clean stale smoke artifacts.
- Verify new medium and large features follow `docs/FEATURE_ARCHITECTURE_STANDARD.md`, especially cross-process boundaries and public feature entrypoints.
- Check that Electron main, preload, renderer, and shared code keep their responsibilities separate and use the documented path aliases.
- Flag changes that manually concatenate agent block markers instead of using `wrapAgentBlock(text)`.
- Flag changes that can break `isMeta` semantics, chunk generation, teammate message parsing, task/subagent filtering, or structured task references.
- Ensure IPC and main-process handlers validate inputs, fail gracefully, and do not expose unsafe filesystem or process access.
- Confirm user-visible workflows have focused tests or a clear verification path when they touch parsing, persistence, IPC, Git, provider auth, or review flows.
- Prefer `pnpm` commands for verification and avoid recommending `pnpm lint:fix` unless the PR explicitly intends broad formatting changes.

Do not treat this file as a second source of truth.
Keep architecture rules centralized in [docs/FEATURE_ARCHITECTURE_STANDARD.md](docs/FEATURE_ARCHITECTURE_STANDARD.md).
