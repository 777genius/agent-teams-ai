---
title: Quickstart – Agent Teams Docs
description: Get from a fresh install to a running AI agent team in a few minutes. Covers installation, runtime selection, team creation, and first code review.
---

# Quickstart

This guide gets you from a fresh install to a running team in a few minutes.

## 1. Install Agent Teams

Download the latest release for your platform from the <a href="/download/" target="_self">download page</a> or [GitHub releases](https://github.com/777genius/agent-teams-ai/releases).

::: tip
The app is free and open source. The agent runtime you choose may still require provider access — see [Installation](/guide/installation) for details.
:::

::: info
The desktop app is the primary product. Agent Teams also runs in a browser for development, but the browser path lacks the full desktop IPC, terminal, provider auth, and team lifecycle behavior. Use `pnpm dev` (Electron) for normal development, not the browser/web dev mode.
:::

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
| OpenCode | Multi-model teams and many provider backends    |

::: info
Gemini is available as a supported provider path. See [Providers and runtimes](/reference/providers-runtimes) for auth options and current provider status.
:::

See [Runtime setup](/guide/runtime-setup) for detailed configuration per provider.

To verify the selected runtime outside the app, run its version command:

```bash
claude --version
codex --version
opencode --version
```

If the command fails in your terminal, fix the runtime installation or `PATH` first. Team prompts cannot work around a missing binary or missing provider auth.

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

The lead creates tasks, assigns work, and coordinates teammates. You can watch progress on the kanban board and intervene with comments or direct messages at any time.

## 6. Review results

Open completed or review-ready tasks, inspect the diff, and accept, reject, or comment on individual changes. Use task logs when you need to understand why an agent made a choice.

See [Code review](/guide/code-review) for the full review workflow.

Before approving the first task, check three things:

1. The task comment explains what changed
2. The changed files match the task scope
3. The verification result is visible in the task comment or logs

## Next steps

- [Create a team](/guide/create-team) — recommended team shapes and brief writing
- [Runtime setup](/guide/runtime-setup) — provider auth and model selection
- [Code review](/guide/code-review) — review, approve, or request changes
