---
title: FAQ – Agent Teams Docs
description: Frequently asked questions about Agent Teams — pricing, model access, runtimes, privacy, review, and troubleshooting.
---

# FAQ

## Is Agent Teams free?

Yes. The app is free and open source. Provider or runtime access may still cost money depending on what you use.

## Does Agent Teams include model access?

No. Agent Teams is the local orchestration and UI layer. Model access comes from the selected runtime/provider path, such as Claude Code, Codex, or OpenCode.

## Which runtimes are supported?

The supported runtime paths are Claude Code, Codex, and OpenCode. The app also tracks provider ids such as Anthropic, Codex, Gemini, and OpenCode when the runtime exposes them.

## Do I need to install Claude Code or Codex first?

Not always. The app guides runtime detection and setup from the UI. Some paths still require external runtime auth.

OpenCode setup is separate from Claude Code and Codex setup. If a launch fails, check runtime status and provider auth before changing the team prompt.

## How do I check whether a runtime is ready?

Run the runtime command in a terminal first:

```bash
claude --version
codex --version
opencode --version
```

Then confirm provider auth for the path you selected. If the command or auth check fails outside Agent Teams, fix setup before launching a team.

## Does it upload my code to Agent Teams servers?

No. Agent Teams is not a cloud code-sync service. Provider-backed model calls may receive prompt context depending on your selected runtime.

## Where are team files stored?

Team coordination data is stored locally under `~/.claude/teams/<team>/` (macOS/Linux) or `%APPDATA%\Claude\teams\<team>\` (Windows), task files under `~/.claude/tasks/<team>/` or `%APPDATA%\Claude\tasks\<team>\`, and project session data under `~/.claude/projects/<encoded-project>/` when available.

## What can leave my machine?

Prompt context, selected file contents, tool results, command output, task text, comments, and attachments can leave your machine through the runtime/provider path when an agent uses a provider-backed model. The exact behavior depends on the runtime and provider.

## Can agents talk to each other?

Yes. Agents can message teammates, comment on tasks, coordinate across teams, and use task references to keep conversations attached to work.

## What should I put in the first team prompt?

Give the lead a concrete outcome, file or feature boundaries, risk limits, and verification expectations. For example:

```text
Improve the docs quickstart. Keep edits inside landing/product-docs, add practical examples, and run `pnpm --dir landing docs:build` before marking work done.
```

## Can I review code before accepting it?

Yes. The review flow is built around task-scoped diffs and hunk-level decisions.

## What is an Agent Block?

An Agent Block is hidden agent-only text wrapped in markers such as `<info_for_agent>...</info_for_agent>`. The app strips it from normal user-facing display but keeps it available for agent coordination.

## What is solo mode?

Solo mode is a one-agent team. It is useful for smaller tasks and lower coordination overhead.

## Should I use worktree isolation?

Use it when multiple OpenCode teammates may edit the same Git project in parallel. It reduces file conflicts, but it requires a Git-tracked project and currently applies to OpenCode members.

## Can different teammates use different providers?

Yes, provider/model settings can be carried per team member when the selected runtime path supports them. OpenCode is the main path for broad multi-provider routing.

## Why does a task show review or approved separately from done?

The work state and review state are related but not identical. A task can be done from the agent's perspective, then move through review and approval in the kanban UI.

## What should I do when a launch hangs?

Open troubleshooting, collect launch diagnostics, check `~/.claude/teams/<team>/`, and verify runtime/provider auth before changing prompts.

For OpenCode, check lane/session evidence before assuming a teammate is online but ignoring messages.

## Why are logs different across runtimes?

Claude Code, Codex, and OpenCode expose different transcript formats and runtime evidence. Agent Teams normalizes what it can, but log completeness and attribution can differ by runtime.
