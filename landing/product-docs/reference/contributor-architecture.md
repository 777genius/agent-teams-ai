---
title: Contributor Architecture – Agent Teams Docs
description: Contributor guide to feature layout, runtime/provider boundaries, hard guardrails, and canonical architecture documents.
---

# Contributor Architecture

This page is a map for contributors. It points to the canonical repo guidance instead of restating every implementation rule.

## Canonical sources

Use these files as the source of truth when changing the app:

| Need | Canonical source |
| --- | --- |
| Repo overview and commands | [README.md](https://github.com/777genius/agent-teams-ai/blob/main/README.md) |
| Local working conventions | [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) |
| Hard guardrails | [AGENT_CRITICAL_GUARDRAILS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENT_CRITICAL_GUARDRAILS.md) |
| Medium and large feature layout | [docs/FEATURE_ARCHITECTURE_STANDARD.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/FEATURE_ARCHITECTURE_STANDARD.md) |
| Agent team launch debugging | [docs/team-management/debugging-agent-teams.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md) |

## Feature layout

Medium and large features should live under `src/features/<feature-name>/` and follow the feature architecture standard. Keep feature internals behind public entrypoints, and avoid deep imports across feature boundaries.

For new work, start with the existing `src/features/recent-projects` slice as the local reference implementation. Small fixes can stay close to the existing code path when creating a feature slice would add more structure than value.

## Runtime and provider boundaries

Agent Teams owns orchestration: teams, tasks, messages, launch state, review UI, diagnostics, and local persistence.

The selected runtime/provider path owns model execution, auth, model availability, rate limits, tool semantics, and runtime-specific transcript evidence. Do not make prompts or UI state compensate for missing auth, missing binaries, rejected model ids, or provider outages. For user-facing setup details, see [Providers and Runtimes](/reference/providers-runtimes).

## Agent team debugging

For launch hangs, OpenCode `registered` / bootstrap-unconfirmed states, missing teammate replies, or suspicious task logs, start from the dedicated debugging runbook. Inspect the newest launch failure artifact under `~/.claude/teams/<team>/launch-failure-artifacts/latest.json`, then correlate UI state with persisted files and runtime-specific evidence.

Avoid broad cleanup while debugging. Stop only the process, lane, team, or smoke run you can identify as belonging to the issue.

## Contributor conventions

- Use `pnpm dev` for the desktop Electron app during normal development.
- Do not use browser dev mode as a substitute for desktop runtime, IPC, terminal, provider auth, or team lifecycle behavior.
- Keep Electron main, preload, renderer, shared, and feature responsibilities separate.
- Use `wrapAgentBlock(text)` for agent-only blocks instead of manually concatenating markers.
- Prefer focused verification. Avoid broad `lint:fix` or formatting churn unless the task is explicitly about formatting.
- Treat parsing, task lifecycle, provider/runtime detection, persistence, IPC, Git, and review flows as high-risk areas that need targeted tests or a clear verification path.

## Related pages

- [Runtime setup](/guide/runtime-setup)
- [Troubleshooting](/guide/troubleshooting)
- [Code review](/guide/code-review)
- [Privacy and local data](/reference/privacy-local-data)
