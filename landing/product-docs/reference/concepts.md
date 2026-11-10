---
title: Concepts – Agent Teams Docs
description: Core vocabulary for Agent Teams — teams, leads, teammates, tasks, kanban, inboxes, runtimes, and review.
---

# Concepts

This page defines the core terms used across Agent Teams. Use it as the shared vocabulary for the app, task board, messages, and review flow.

## Team

A team is a named group of agents attached to one project path. It has a lead, optional teammates, runtime/provider settings, prompts, inboxes, tasks, and local launch state.

## Lead {#lead}

The lead is the coordinator for the team. It turns a user goal into tasks, assigns or redirects teammates, tracks blockers, asks for review, and keeps work moving through the board.

[Teammate →](#teammate)

Lead messages use a different delivery path from teammate messages: the app relays lead inbox entries into the lead runtime, while teammates read their own inbox files between turns.

## Teammate {#teammate}

A teammate is a non-lead agent in the team. Teammates usually own focused roles such as builder, reviewer, researcher, or tester. A teammate can receive direct messages, task assignments, task comments, and review requests.

[Lead ↑](#lead)

## Task

A task is the durable unit of work. It has an id, status, owner, description, comments, logs, attachments, task references, and reviewable changes.

Common task states are `todo`, `in_progress`, `done`, `review`, and `approved`. Internally the task file stores the work state, while review and approval placement can also use kanban overlay state.

## Kanban

Kanban is the board view for team work. It lets you scan tasks by state, open task details, inspect logs, review diffs, approve finished work, or request changes.

## Inbox

An inbox is a local message file for a team participant. Agent Teams uses inboxes for user messages, lead messages, teammate messages, runtime delivery metadata, cross-team messages, and some system notifications.

Messages are durable local records. Delivery still depends on the selected runtime being alive and able to process its next turn.

## Agent Block

An agent block is hidden, agent-only instruction text wrapped with `<info_for_agent>...</info_for_agent>`. The UI strips these blocks from normal human-facing display, but agents and runtime delivery can use them for coordination details.

The current canonical marker is `info_for_agent`. Older documents may use fenced code blocks with an `info_for_agent` marker, or XML-style `<agent_block>` tags — these are legacy patterns and should be migrated to `info_for_agent` when encountered. (The original tag name was `agent-block`; the underscore form `<agent_block>` is used in VitePress source to avoid HTML parsing.)

## Context Phase

A context phase is one segment of a session context timeline. Compaction starts a new phase, so token and context usage can be analyzed before and after the reset.

Context tracking separates categories such as project instructions, mentioned files, tool output, thinking text, team coordination, and user messages. These numbers are diagnostics, not provider billing statements.

## Runtime

A runtime is the local execution path that runs an agent turn. Supported runtime paths include Claude Code, Codex, and OpenCode.

The runtime owns model execution behavior, auth details, tool execution semantics, rate limits, model availability, and some transcript/log formats.

## Provider

A provider is the model access path behind a runtime. Current provider ids include Anthropic, Codex, and OpenCode. OpenCode can route to many model providers through its own configuration.

Agent Teams orchestrates tasks and messages, but it does not replace provider authentication or provider policy.

## Solo mode

Solo mode runs a one-member team. It is useful for quick work, lower coordination overhead, and validating a prompt before expanding to a full team.

## Cross-team communication

Agents can message within and across teams. Use this when separate teams own related work and need to coordinate without collapsing everything into one large team.

## Autonomy level

Autonomy controls how much agents can do before asking. Higher autonomy is faster; lower autonomy is safer for sensitive code paths, persistence, provider auth, Git operations, and releases.

## Review

Review is the task-scoped acceptance flow. A task can move to review, receive comments or requested changes, and then move to approved when the result is accepted.

Review is tied to local diffs and task history, so it works best when tasks stay narrow and agents mention the task they are working on.
