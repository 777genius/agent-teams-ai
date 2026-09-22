---
title: Code Review – Agent Teams Docs
description: Inspect task-scoped diffs, accept or reject hunks, leave inline comments, and manage review states from none to approved.
---

# Code Review

Code review in Agent Teams is task-centered. You inspect what changed for a specific task instead of hunting through a large unstructured diff.

## Review surface

For each completed task that touched files, the review UI lets you:

- Inspect changed files with before/after context
- Accept or reject individual hunks
- Leave inline comments
- Connect the diff back to the task description and agent logs

## Hunk-level decisions

Accept small correct changes and reject isolated mistakes without throwing away the whole task. This is useful when an agent mostly solved the task but overreached in one file.

::: tip Accept incrementally
If a diff is mostly correct, accept the good hunks first and request changes only for the parts that need fixing. This keeps the board moving.
:::

Use hunk-level decisions for:

| Situation | Action |
| --- | --- |
| Correct scoped change | Accept the hunk |
| Correct idea, wrong file or broad refactor | Reject the hunk and request a narrower fix |
| Unclear behavior change | Comment and ask for verification |
| Generated formatting noise | Reject unless formatting was part of the task |

## Initiating review

1. Open a completed task
2. Look at the **Changes** tab
3. If the diff looks reasonable, click **Request Review** to move the task into the review column

During review the task is not yet considered done, so other teammates or the lead can still comment on it.

## Review loop

A healthy review loop looks like this:

1. The owner posts a result comment with changed scope and verification
2. The reviewer opens the task diff and checks hunks against the task description
3. The reviewer accepts good hunks, rejects bad hunks, or requests changes
4. The owner fixes only the requested scope and posts a follow-up comment
5. The reviewer approves when the task result and diff match

Example request-changes comment:

```text
Please keep the copy improvements, but revert the unrelated runtime wording in the provider table. Add the `pnpm --dir landing docs:build` result before resubmitting.
```

## Review states

| State | Meaning |
| --- | --- |
| `none` | Task is new, in progress, or completed but not yet in review |
| `review` | The task is actively under review |
| `needsFix` | Changes were requested; the owner must update before re-approval |
| `approved` | The review was accepted and the task is finalized |

## Agent review workflow

Teams can review each other's work before you make the final call. This catches obvious regressions and keeps the board honest, but you should still review risky areas yourself.

Agent review is most useful when the reviewer has a clear rubric. For example, tell a reviewer to check only docs clarity, only IPC safety, or only test coverage. Broad "review everything" requests tend to produce weaker feedback.

### MCP-driven review state

Review state changes (request review, request changes, approve) are tool-driven. Leaving a "request changes" comment on a task does **not** move the kanban column to `needsFix` — a lead or agent must call the appropriate MCP tool:

- `review_request_changes` — moves the task to `needsFix` and notifies the owner
- `review_approve` — moves the task to `approved` and finalizes the review

Comments alone are insufficient for state transitions. For the full list of review MCP tools and their parameters, see [MCP Integration](/guide/mcp-integration).

## Review participants

The team lead is the default reviewer. You can configure additional reviewers in the Kanban settings if you want peers to review each other's work.

## What to check manually

Prioritize these areas when reviewing:

- **Provider auth and runtime detection** — did the agent change runtime setup in a way that would break other paths?
- **IPC, preload, and filesystem boundaries** — keep Electron responsibilities separated
- **Git and worktree behavior** - verify branch naming, commits, and pushes; see [Git and worktree strategy](/guide/git-worktree-strategy) for isolation patterns.
- **Parsing and task lifecycle logic** — changes to task references, chunking, or filtering can break message delivery
- **Persistence and code review flows** — changes to task storage or review state must stay consistent across IPC layers

For the canonical feature layout and hard guardrail links, use [Contributor Architecture](/reference/contributor-architecture).

## Verification

Prefer focused verification commands. Broad formatting or lint-fix commands should not be used unless the task explicitly intends broad formatting churn.

Good verification comments include the command and result:

```text
Verified with `pnpm --dir landing docs:build`. Build passed.
```

When verification is skipped, the task comment should say why:

```text
Docs-only wording change. Build not run because the existing dev server was busy; checked Markdown links manually.
```

::: warning Do not auto-format across the whole project
Unless the task is specifically about formatting, avoid running `pnpm lint:fix` on unrelated files. It creates noise in the review surface.
:::
