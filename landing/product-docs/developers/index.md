---
title: Developers – Agent Teams Docs
description: Contributor and developer entry point for Agent Teams architecture, guardrails, debugging, and MCP extension paths.
---

# Developers

Use this page when you want to change Agent Teams itself, debug a team launch, or extend a runtime with MCP tools. The links below point to the canonical repo documents so implementation rules stay in one place.

## Start here

| Need | Go to |
| --- | --- |
| Repo overview, scripts, and source setup | [README.md](https://github.com/777genius/agent-teams-ai/blob/main/README.md) |
| Agent navigation and architecture index | [AGENTS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENTS.md) |
| Working conventions for agents and contributors | [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) |
| Hard implementation guardrails | [AGENT_CRITICAL_GUARDRAILS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENT_CRITICAL_GUARDRAILS.md) |
| Medium and large feature structure | [Feature architecture standard](https://github.com/777genius/agent-teams-ai/blob/main/docs/FEATURE_ARCHITECTURE_STANDARD.md) |
| Launch, bootstrap, and teammate messaging debugging | [Agent team debugging runbook](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md) |
| Contribution process | [Contributing guide](https://github.com/777genius/agent-teams-ai/blob/main/.github/CONTRIBUTING.md) |
| Release notes / Changelog | [RELEASE.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/RELEASE.md) — [CHANGELOG.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md) |

## Local development path

Run the desktop Electron app for normal development:

```bash
pnpm install
pnpm dev
```

The browser/web path is not a replacement for the desktop runtime. Desktop mode is the supported local path because it includes IPC, terminals, provider auth, team lifecycle handling, launch diagnostics, and the runtime bridges used by real teams.

## Architecture checkpoints

Before changing a feature, identify its boundary:

| Area | Expected home |
| --- | --- |
| Medium or large product feature | `src/features/<feature-name>/` |
| Electron main process orchestration | `src/main/` |
| Preload-safe API surface | `src/preload/` |
| Renderer UI and app state | `src/renderer/` |
| Shared types and pure helpers | `src/shared/` |
| Agent Teams board MCP server | `mcp-server/` |
| Board data controller | `agent-teams-controller/` |

Use `src/features/recent-projects` as the reference slice for feature organization. Keep cross-process contracts explicit, and avoid deep imports across feature boundaries.

## Debugging path

For launch hangs, OpenCode `registered` / bootstrap-unconfirmed states, missing teammate replies, or suspicious task logs:

1. Start with the [debugging runbook](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md).
2. Inspect the newest artifact pack under `~/.claude/teams/<team>/launch-failure-artifacts/latest.json`.
3. Open the artifact `manifest.json` and check `classification`, bootstrap breadcrumbs, launch diagnostics, member spawn statuses, and redacted log tails.
4. Clean up only the team, run, pane, or process you can identify as owned by the smoke test or failed launch.

## MCP development path

Agent Teams uses a built-in MCP server named `agent-teams` for board operations. User and project MCP servers can add external capabilities for runtimes. See [MCP integration](/guide/mcp-integration) for setup examples, `.mcp.json` structure, and tool registration guidance.

## Related docs

- [Contributor architecture](/reference/contributor-architecture)
- [Runtime setup](/guide/runtime-setup)
- [MCP integration](/guide/mcp-integration)
- [Troubleshooting](/guide/troubleshooting)
