---
title: Quickstart – Agent Teams Docs
description: Get from a fresh install to a running AI agent team in a few minutes. Covers installation, runtime selection, team creation, and first code review.
---

# Quickstart

This guide gets you from a fresh install to a running team in a few minutes.

## Shortest path

```bash
# 1. Install prerequisites
node --version    # need 20+
pnpm --version    # need 10+

# 2. Clone and install
git clone https://github.com/777genius/agent-teams-ai.git
cd agent-teams-ai
pnpm install

# 3. Start the desktop app (default workflow)
pnpm dev

# 4. Verify a docs-only change
pnpm --dir landing docs:build
```

The desktop Electron app (`pnpm dev`) is the primary target — do not use the browser/web dev server for normal development. The browser path lacks desktop IPC, terminal, provider auth, and team lifecycle behavior.

## Before you begin

You need:

- **A computer** running macOS, Windows, or Linux
- **(Recommended) A Git-tracked project** — worktree isolation and diff review rely on Git
- **(Optional) Provider access** — runtime setup detects available providers from the UI, but some paths need existing auth (Anthropic, OpenAI, etc.)

If a step below does not work, check the [troubleshooting guide](/guide/troubleshooting#team-does-not-launch) for common fixes.

For project conventions and architecture guidance, refer to these canonical files before making changes:

- [AGENTS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENTS.md) — repo navigation and architecture pointers
- [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) — working conventions and project rules
- [Feature architecture standard](https://github.com/777genius/agent-teams-ai/blob/main/docs/FEATURE_ARCHITECTURE_STANDARD.md) — structure for new features
- [Debugging runbook](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md) — launch and teammate diagnostics

## 1. Run from source or download

**Download the packaged app** for macOS, Windows, or Linux from the <a href="/download/" target="_self">download page</a> - no prerequisites needed. Start with the free model with no auth, or connect provider auth from the UI when you want more models.

**Or run from source** for development:

Requires Node.js 24.16.0 LTS and pnpm 10+. On macOS, official Node.js 24 prebuilt binaries require macOS 13.5+.

```bash
git clone https://github.com/777genius/agent-teams-ai.git
cd agent-teams-ai
pnpm install
pnpm dev
```

`pnpm dev` starts the desktop Electron app with hot reload. This is the default development target. Do not start a browser web dev server for normal development — the browser path lacks the full desktop IPC, terminal, provider auth, and team lifecycle behavior.

## 2. Open or create a project

Launch the app and select the project directory you want agents to work in. Agent Teams reads local project files and runtime/session state so the UI can show tasks, logs, diffs, and teammate activity.

::: tip
Pick a Git-tracked project for the best experience. Worktree isolation and diff-based review both rely on Git.
:::

Before launching a team, check that the project has a clean enough baseline:

```bash
git status --short
```

You do not need a perfectly clean tree, but you should know which changes are yours before agents start editing. This makes task diffs and hunk-level review much easier to trust.

## 3. Choose a runtime path

The setup flow auto-detects installed runtimes on your machine. A common first setup is:

| Runtime  | Good for                                        |
| -------- | ----------------------------------------------- |
| Claude   | Claude Code users and existing Anthropic access |
| Codex    | Codex-native workflows and OpenAI access        |
| OpenCode | Free model with no auth, multi-model teams, and many provider backends |


See [Runtime setup](/guide/runtime-setup) for detailed configuration per provider.

To verify a paid or account-backed runtime outside the app, check the binary and test auth:

```bash
# Check that the runtime is installed and on PATH
command -v claude && claude --version
command -v codex && codex --version
command -v opencode && opencode --version
```

If the command fails, fix the runtime installation or `PATH` first. Team prompts cannot work around a missing binary or missing provider auth for models that require it.

::: tip
If the binary is found but the app reports "not logged in", the environment may differ between your terminal and the app. See the [auth diagnostic log](/guide/troubleshooting#auth-diagnostic-log) to compare them.
:::

## 4. Create your first team

Create a team with a lead and one or more specialists. Keep the first team small: one lead, one implementation agent, and one review-oriented agent is enough to validate the workflow.

See [Create a team](/guide/create-team) for the recommended structure and tips.

For the first launch, prefer a team shape like this:

| Member | Responsibility | Notes |
| --- | --- | --- |
| Lead | Split the goal into tasks and coordinate status | Keep on the most reliable provider you have |
| Builder | Implement scoped tasks | Give clear file or feature boundaries |
| Reviewer | Review completed work | Ask it to focus on regressions and missing tests |

Avoid starting with five or more teammates. More agents increase concurrency, logs, provider usage, and conflict risk before you know the setup is healthy.

## 5. Give the lead a concrete goal

Write the goal like you would brief an engineering lead:

```text
Improve the onboarding flow. Split the work into tasks, keep changes small, and ask for review before broad refactors.
```

Good first prompts include concrete scope, safety boundaries, and verification:

```text
Improve the docs quickstart. Keep edits inside landing/product-docs. Add practical examples, preserve existing VitePress syntax, and run `pnpm --dir landing docs:build` before marking tasks done.
```

Avoid vague prompts such as "make the app better" for the first run. The lead can break down large goals, but better input produces smaller tasks and cleaner review.

::: tip
If the team launches but no tasks appear, check whether the lead received your prompt. See [agent replies are missing](/guide/troubleshooting#agent-replies-are-missing) for diagnostics.
:::

The lead creates tasks, assigns work, and coordinates teammates. You can watch progress on the kanban board and intervene with comments or direct messages at any time.

## 6. Review results

Open completed or review-ready tasks, inspect the diff, and accept, reject, or comment on individual changes. Use task logs when you need to understand why an agent made a choice.

See [Code review](/guide/code-review) for the full review workflow.

Before approving the first task, check three things:

1. The task comment explains what changed
2. The changed files match the task scope
3. The verification result is visible in the task comment or logs

## Common pitfalls

| Symptom | Likely cause | Check |
| --- | --- | --- |
| App does not detect a runtime | Binary not on `PATH`, or app and terminal see different environments | Run `command -v <runtime>` in a terminal, then use the same terminal env to launch the app |
| Team launch hangs | Missing provider auth for a paid/account model, wrong model string, or runtime binary not found | See [Troubleshooting](/guide/troubleshooting#team-does-not-launch) |
| OpenCode lane stuck on `registered` | Lane evidence not committed yet, or model string mismatch | Inspect `~/.claude/teams/<team>/.opencode-runtime/lanes/` |
| Agent replies missing | Runtime delivery retry, parsing, or task attribution issue | Open task logs and check the delivery ledger |
| Provider returns 429s | Rate limit reached | Wait for reset or switch model/provider |

## Next steps

- [Create a team](/guide/create-team) — recommended team shapes and brief writing
- [Runtime setup](/guide/runtime-setup) — provider auth and model selection
- [Code review](/guide/code-review) — review, approve, or request changes

### For contributors

If you are modifying Agent Teams or these docs, start with the canonical project files at the repo root:

- [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) — working conventions and project rules
- [AGENTS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENTS.md) — navigation layer for architecture and implementation guidance
- [AGENT_CRITICAL_GUARDRAILS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENT_CRITICAL_GUARDRAILS.md) — hard implementation guardrails
- [Feature architecture standard](https://github.com/777genius/agent-teams-ai/blob/main/docs/FEATURE_ARCHITECTURE_STANDARD.md) — structure for new features
- [Agent team debugging runbook](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md) — launch, bootstrap, and teammate diagnostics

To verify this documentation site builds correctly:

```bash
pnpm --dir landing docs:build
```
