---
title: Create a Team – Agent Teams Docs
description: Define roles, assign providers and models, write a team brief, and configure worktree isolation and autonomy levels.
---

# Create a Team

A team is a named group of agents with roles, a lead, a target project, and a coordination prompt.

## Recommended first team

Start with a small team:

| Role     | Purpose                                             |
| -------- | --------------------------------------------------- |
| Lead     | Splits work, creates tasks, coordinates teammates   |
| Builder  | Implements scoped tasks                             |
| Reviewer | Reviews output, catches regressions, asks for fixes |

This shape gives you enough coordination to see the product value without making the first launch noisy.

::: tip
You can add more members later. Start small, validate the workflow, then scale up.
:::

## Assign providers and models

Each team member runs on a provider backend. In the team editor, pick a provider (Claude, Codex, or OpenCode) and a model for every member. The app shows only providers you have already authenticated.

Mixing providers in one team is supported — for example, a Claude lead with OpenCode builders.


## Write a good team brief

The team brief should include:

- the outcome you want
- the files or feature areas that matter
- risk boundaries, such as "do not refactor unrelated modules"
- review expectations
- verification commands when you know them

Example:

```text
Build a focused improvement to the download flow. Keep changes inside the landing app unless a shared helper is clearly needed. Create tasks before implementation, review each task diff, and run landing lint/build checks.
```

## Worktree isolation

OpenCode members can use **worktree isolation** to work in a separate Git worktree instead of the main working directory. This prevents file conflicts when multiple agents edit the same project.

::: warning
Worktree isolation requires a Git-tracked project and is currently limited to OpenCode members.
:::

To enable it, toggle the **Worktree isolation** option when adding or editing an OpenCode team member.

## Choose autonomy

Agent Teams supports different levels of control. Use more autonomy for routine changes and tighter review for risky areas like provider auth, IPC, persistence, Git workflows, and release tooling.

### Effort level

Each team member has an **effort** setting that controls how much reasoning the provider invests before responding. Higher effort produces more thorough output at the cost of time and tokens.

| Level  | When to use                                                |
| ------ | ---------------------------------------------------------- |
| Low    | Quick lookups, small formatting changes, routine edits     |
| Medium | Default for most implementation tasks                      |
| High   | Complex refactors, cross-cutting changes, risky code paths |

The app offers additional levels (minimal, xhigh, max) for providers that support them. If a model does not support configurable effort, the selector is disabled and the provider default is used.

### Fast mode

Toggle **Fast mode** per member to prioritize speed over depth. This maps to the provider's native fast/speed mode when available. Set it to **On** for routine tasks, **Off** for careful work, or **Inherit** to follow the team-level default.

### Limit context

Enable **Limit context** to reduce the context window for a member. This is useful for Claude models that support extended context (e.g. 1M tokens) — limiting context avoids unnecessary token usage and can improve latency for tasks that do not need large context.

## Add context

Attach files, screenshots, or specific notes when they materially change the task. Agents can use task descriptions, comments, and attachments as durable context.

## Watch for task quality

Good teams create tasks that are:

- specific enough to review
- small enough to finish
- linked to visible output
- backed by a verification path

If the lead creates vague tasks, send a direct message asking for smaller, testable tasks.

## Next steps

- [Runtime setup](/guide/runtime-setup) — configure provider auth and models
- [Code review](/guide/code-review) — accept, reject, or comment on agent changes
- [Troubleshooting](/guide/troubleshooting) — common issues and fixes
