---
title: Team Brief Examples – Agent Teams Docs
description: Practical team brief templates for small fixes, docs work, implementation tasks, reviews, and high-risk areas.
---

# Team Brief Examples

A good team brief gives the lead enough structure to create small tasks without forcing every implementation detail upfront.

Use this shape:

```text
Outcome:
Scope:
Boundaries:
Coordination:
Verification:
Review:
```

## Minimal brief

Use for small, low-risk work.

```text
Outcome: Improve the quickstart so a new user can launch one team successfully.
Scope: Keep edits inside landing/product-docs.
Boundaries: Do not rewrite the whole docs structure.
Coordination: Create one or two tasks, keep comments on the task.
Verification: Run `pnpm --dir landing docs:build`.
Review: Summarize changed pages and any remaining gaps.
```

## Implementation brief

Use when code changes touch one feature area.

```text
Outcome: Add a focused improvement to task comment filtering.
Scope: Work inside the task/comment feature files unless a shared helper is clearly needed.
Boundaries: Do not change task storage format or review state semantics.
Coordination: Split parser, UI, and tests into separate tasks if they can be reviewed independently.
Verification: Run the focused unit tests first, then the feature typecheck if touched.
Review: Call out parsing edge cases and any behavior that affects existing task comments.
```

## Docs brief

Use for documentation and guide work.

```text
Outcome: Draft practical workflow guides from the docs audit.
Scope: Add concise VitePress pages under landing/product-docs/guide.
Boundaries: Avoid moving existing navigation hubs owned by other tasks.
Coordination: Check related docs tasks before editing nav.
Verification: Run `pnpm --dir landing docs:build`.
Review: Include links added to sidebar and any pages intentionally left as drafts.
```

## Review-heavy brief

Use for risky areas such as IPC, provider auth, persistence, Git, or task lifecycle logic.

```text
Outcome: Fix the launch failure without changing successful launch behavior.
Scope: Start from the newest launch-failure artifact and the affected runtime adapter.
Boundaries: Do not change provider prompts until setup and runtime evidence are inspected.
Coordination: Make one diagnostic task and one fix task if the cause is confirmed.
Verification: Run focused tests and one desktop smoke check when practical.
Review: Lead must inspect the diff before approval.
```

## Mixed provider brief

Use when teammates run different provider/model lanes.

```text
Outcome: Implement and review a small feature using separate builder and reviewer lanes.
Scope: Builder edits the feature. Reviewer inspects only the task diff and tests.
Boundaries: Do not switch model ids mid-task unless launch fails before work begins.
Coordination: Builder posts result comment first. Reviewer posts findings as task comments.
Verification: Builder runs focused tests. Reviewer checks failure output and changed scope.
Review: Lead approves only after reviewer comments are resolved.
```

## Agent blocks in briefs

Agent blocks are hidden agent-only text wrapped in markers such as `<info_for_agent>...</info_for_agent>`. The app strips them from normal display but keeps them available for agent coordination. Use them when the brief needs to say something to agents that would be noise for a human reader.

Example - a brief that tells the lead how to split work without exposing coordination instructions to the user:

```text
Outcome: Add a dark mode toggle to the application settings.
Scope: Settings UI, theme context, and CSS variables.
Boundaries: Do not change existing light theme values or provider auth screens.

<info_for_agent>
Split this into three tasks: (1) theme context and CSS vars, (2) toggle component and settings wiring, (3) dark mode preview in existing docs screenshots if practical.
</info_for_agent>
```

The block keeps the human-facing brief clean while giving the lead structured task-splitting guidance.

## What to avoid

| Weak brief | Better replacement |
| --- | --- |
| "Improve the app" | Name the workflow, files, and success check |
| "Fix all docs" | Pick one guide group and one build command |
| "Use the best model" | Name provider/model choices or let the app defaults stand |
| "Refactor as needed" | State which modules are allowed to change |
| "Make it production ready" | Define review, tests, and rollout checks |

## Before launch

Check these points before starting the team:

1. The brief names a concrete outcome.
2. Risk boundaries are explicit.
3. The lead can split the work into reviewable tasks.
4. Verification commands are included when known.
5. Sensitive areas require review before approval.

If the brief is still broad, launch a solo or small team first and ask it to produce a task plan rather than implementation.

## Related guides

- [Create a team](/guide/create-team)
- [MCP integration](/guide/mcp-integration)
- [Git and worktree strategy](/guide/git-worktree-strategy)
