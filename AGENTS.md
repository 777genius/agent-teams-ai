# Agent Navigation

This file is a navigation layer for architecture and implementation guidance.

Start here:

- Repo overview and commands: [README.md](README.md)
- Working instructions and project conventions: [CLAUDE.md](CLAUDE.md)
- Hard guardrails: [AGENT_CRITICAL_GUARDRAILS.md](AGENT_CRITICAL_GUARDRAILS.md)
- Release process and runtime packaging: [docs/RELEASE.md](docs/RELEASE.md)
- Canonical feature architecture standard: [docs/FEATURE_ARCHITECTURE_STANDARD.md](docs/FEATURE_ARCHITECTURE_STANDARD.md)
- Agent team launch/runtime debugging runbook: [docs/team-management/debugging-agent-teams.md](docs/team-management/debugging-agent-teams.md)

## Hosted Web

For hosted-web work, begin at [START_HERE.md](docs/hosted-web-phases/START_HERE.md) and follow the
phase that [EXECUTION_INDEX.json](docs/hosted-web-phases/EXECUTION_INDEX.json) marks as current.
The monolithic plans ([hosted-web-e2e-completion-plan.md](docs/hosted-web-e2e-completion-plan.md),
[hosted-web-phase-0-execution-packet.md](docs/hosted-web-phase-0-execution-packet.md)) are reference
material; the execution index is the single source of truth for phase status.

GitHub repository disambiguation:

- For this workspace, the canonical GitHub repository is `777genius/agent-teams-ai`.
- When reviewing or discussing PR `#126`, inspect `777genius/agent-teams-ai#126` unless the user explicitly names another repository.
- Do not confuse this workspace with upstream or similarly named forks such as `matt1398/claude-devtools`.

Default local run target:

- Use the desktop Electron app: `pnpm dev`
- Do not start the browser/web dev mode for normal development or smoke checks. The browser path is limited and lacks the full desktop runtime, IPC, terminal, provider auth, and team lifecycle behavior.
- When documenting or recommending startup commands, point contributors to the desktop app unless a task explicitly asks for browser-mode internals.

Critical real-project safety:

- Do not test agent teams, launch/provisioning, terminal runtime, task assignment, smoke-flow, or agent actions on real user projects.
- Use only new sandbox/test projects or explicitly test-only existing projects for verification.
- Real projects such as `~/dev/projects/ai/claude-runtime` must not be used even for opening a runtime/terminal without fresh direct user permission.

Live team smoke runtime:

- Use the orchestrator source launcher by default for live/dev smoke loops: `/Users/belief/dev/projects/claude/agent_teams_orchestrator/cli-source`
- The source launcher runs `src/entrypoints/cli.tsx` through Bun, so it reflects local orchestrator source edits immediately and cannot accidentally test stale `dist` output.
- The source launcher normalizes inherited `NODE_ENV=production` to `NODE_ENV=development`. Release or production-like smoke must use the built wrapper instead of preserving production mode on source.
- Local live/prove scripts should use `scripts/lib/live-smoke-runtime.mjs`, which defaults to `cli-source` unless `CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH` is explicitly set.
- Source-mode teammate startup can be slower than bundled startup. Live smoke harnesses may raise `CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS` and `CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS` when the test is validating source behavior instead of watchdog latency.
- Use the built wrapper only for release or production-like smoke checks. Build first in `/Users/belief/dev/projects/claude/agent_teams_orchestrator` with `bun run build`, then set `CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH=/Users/belief/dev/projects/claude/agent_teams_orchestrator/cli`.
- Do not use `cli-dev` or `bun run build:dev` as proof for the production wrapper. `cli` reads `dist/local-cli/cli.js`; `cli-dev` reads `dist/local-cli-dev/cli.js`.
Fast local lint:

- Use `pnpm lint:fast:files -- <changed files>` for quick preflight on files you touched.
- Use `pnpm lint:fast` for a faster source-tree lint pass when full type-aware lint is too slow.
- `lint:fast` intentionally uses `eslint.fast.config.js` without TypeScript project-service rules. It is not a replacement for `pnpm typecheck` or the full `pnpm lint` gate.
- Keep using `pnpm typecheck` after TypeScript changes, and use full `pnpm lint` when validating a broad PR or changing lint-sensitive architecture boundaries.

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
- Check that interactive UI controls use reusable Radix UI headless primitives from `src/renderer/components/ui` instead of one-off native or hand-rolled controls when a shared primitive exists.
- Flag changes that manually concatenate agent block markers instead of using `wrapAgentBlock(text)`.
- Flag changes that can break `isMeta` semantics, chunk generation, teammate message parsing, task/subagent filtering, or structured task references.
- Ensure IPC and main-process handlers validate inputs, fail gracefully, and do not expose unsafe filesystem or process access.
- Confirm user-visible workflows have focused tests or a clear verification path when they touch parsing, persistence, IPC, Git, provider auth, or review flows.
- Prefer `pnpm` commands for verification and avoid recommending `pnpm lint:fix` unless the PR explicitly intends broad formatting changes.

Do not treat this file as a second source of truth.
Keep architecture rules centralized in [docs/FEATURE_ARCHITECTURE_STANDARD.md](docs/FEATURE_ARCHITECTURE_STANDARD.md).
