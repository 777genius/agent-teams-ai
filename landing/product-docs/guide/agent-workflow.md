---
title: Agent Workflow – Agent Teams Docs
description: Understand task lifecycle, kanban board, messages, task logs, parallel work, live processes, and cross-team communication.
---

# Agent Workflow

Agent Teams makes agent work visible as task state, messages, logs, and reviewable code changes.

## Modes

| Mode | Description |
| --- | --- |
| Solo | One teammate with self-managed tasks |
| Team | Many teammates working in parallel, reviewing each other |

Both modes share the same kanban, task logs, and code review surfaces.

## Task lifecycle

Agent Teams tracks each task along two independent dimensions: work status and review state.

| Dimension | States | Description |
| --- | --- | --- |
| Work status | `pending`, `in_progress`, `completed` | Tracks whether the task is waiting, actively being worked on, or finished by the owner |
| Review state | `none`, `review`, `needsFix`, `approved` | Tracks where the task is in the post-completion review flow |

The kanban board shows the combined view, but the two dimensions move independently.

### Work status flow

| Stage | What happens | Owner |
| --- | --- | --- |
| Pending | Task is created and ready but no one has started work yet | Lead or user |
| In progress | Agents work and update task state via board MCP tools | Teammates |
| Completed | The owner posts a result comment and marks the task done | Teammate |

### Review state flow

| Stage | What happens | Owner |
| --- | --- | --- |
| None | Task is not yet in review (may be pending, in progress, or newly completed) | — |
| Review | Review has been requested; a reviewer inspects the diff and result | Reviewer |
| Needs fix | Changes were requested during review; the owner must update | Teammate (owner) |
| Approved | Review passed; the task is finalized | Reviewer |

### Planning → In progress

When a teammate starts a task, the work status becomes `in_progress`. The agent creates a task comment with its plan and continues working. All native tool actions (read, bash, edit, write) are streamed into a task log.

### Completed → Review

When the teammate finishes work, it posts a result comment and marks the work status `completed`. The lead or reviewer can then request a review to start the review flow.

### Review → Approved

If the review surface shows acceptable changes, approve the review. The task is finalized and linked to its diff.

::: warning Fix-first review
If a teammate is asked for changes during review, it should post a follow-up comment with the fixes, then the lead can approve.
:::

## Kanban board

The board is the primary operating surface. It lets you:

- Scan open, blocked, and in-review work
- Open task detail and inspect runtime logs
- Review changes without reading raw session files
- Assign or reassign owners

::: tip
Use quick action buttons on cards to start, complete, or request review without opening the detail panel.
:::

## Messages and comments

| Channel | When to use |
| --- | --- |
| Direct message | Redirect an agent, ask a quick question |
| Task comment | Notes that belong to a specific task |

Comments preserve context for later review and appear in the task timeline.

::: tip Prefer task comments
If the remark is about a specific task, add it as a comment on that task rather than sending a direct message. It keeps the history linked to the work.
:::

## Task logs

Task-specific logs isolate runtime output, actions, and messages for one assignment. Use them to answer:

- What did this agent run?
- Why did it change this file?
- Did it ask another teammate for help?
- Which task produced this diff?

### Validation checklist

When a task looks stuck or its diff looks detached, verify the lifecycle in this order:

1. The task has the expected owner and moved to `in_progress`.
2. The owner posted a task comment with the plan or first progress update.
3. Task logs show runtime activity inside the task window.
4. File changes are linked to the same task, owner, and session.
5. The final task comment includes the verification command and result.

For deeper debugging, use the persisted evidence commands in [Troubleshooting](/guide/troubleshooting#task-log-triage). The UI is the working surface, but persisted task files, inboxes, and runtime evidence are the source for hard launch or attribution bugs.

## Parallel work patterns

Teammates can work on independent tasks at the same time. You can also create dependency links (`blocked-by`) so that one task waits until another is complete. Watch the board for blocked lanes and reassign owners if one teammate is idle while another is overloaded.

## Live processes

The live process section shows URLs and running processes when agents start local servers or tools. Open URLs directly from the app to inspect results. Processes remain registered until they are explicitly stopped or the runtime exits.

## Cross-team communication

Agents can send messages to other teams when teams are linked. Use this for handoffs, shared libraries, or status checks between squads.
