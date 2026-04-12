# Iteration 07 - Task Logs + Explicit Board Task Links

> Historical note
> This document captures the planned scope and architecture at iteration time.
> It is not the source of truth for the final runtime contract.

This iteration introduces a **new explicit task activity model** for team board tasks and keeps the current session-based execution logs as a **separate legacy block**.

The goal is to stop reconstructing `task -> logs` mostly from heuristics and instead persist a small, explicit, board-task-specific linkage in runtime transcripts, then build a clean read model for the task popup UI.

This iteration spans **two repos**:
- `agent_teams_orchestrator` - write-side runtime and transcript contract
- `claude_team` - read-side task activity feed and UI integration

---

## Decision Record

### Chosen direction

- **New `Task Activity` feed**
- **Keep old `Execution Sessions` block**, but explicitly treat it as legacy/session-centric
- **Persist explicit board-task links in transcript JSONL**
- **Build a read model on top of those links**

### Why this was chosen

- The current `Execution Logs` view is fundamentally **session-centric**
- The new requirement is **event-centric**:
  - "show all logs/actions related to task A"
  - including actions performed by another actor while they were actively working on task B
- Mixing both into one model makes both of them worse

### Rejected alternatives

- **Replace `Execution Logs` entirely with one new event timeline**
  - Too risky for first rollout
  - Would throw away useful current session features
- **Keep only the old session logic and improve heuristics**
  - Not reliable enough
  - Does not solve cross-task board actions correctly
- **Use one single `taskContext` object per message**
  - Breaks on multi-target tools such as `task_link`
  - Becomes ambiguous too quickly

---

## Goals

- Add a **new explicit activity feed** for board tasks
- Keep the current **execution session logs** available as a separate legacy block
- Make task-log linkage **structural**, not mainly heuristic
- Make the new feed **explicit-link only in v1**
- Support:
  - task lifecycle events
  - ordinary execution logs during active task work
  - board actions performed on a task by another actor
  - review flow actions
  - multi-target task tools where relevant

---

## Non-Goals

- Replacing the existing `Workflow History` timeline
- Deleting the current `Execution Sessions` logic
- Rebuilding all historical logs retroactively
- Stamping ambiguous lead free-text execution in v1
- Reworking built-in `TaskCreate` / `TaskUpdate` into this domain

This iteration is for **board-task activity only**, not generic task tooling.

---

## What We Fixed Before This Iteration

Before implementing this iteration, we fixed a real false-negative in the current modern MCP task boundary detection:

- fully-qualified tool names such as `mcp__agent-teams__task_start`
- alternate normalized names such as `mcp__agent_teams__task_complete`

The fix was intentionally narrow:
- one canonicalization helper for agent-teams MCP tool names
- structural boundary detection now sees modern MCP task markers

This is a prerequisite hardening step, not the main solution for the new feed.

---

## Core Architectural Decision

Use **two levels of model**, not one:

### 1. Persisted wire contract

The runtime writes small, explicit, additive transcript fields:

- `boardTaskLinks?: BoardTaskLinkV1[]`
- `boardTaskToolActions?: BoardTaskToolActionV1[]`

Together these fields capture the **minimum durable truth**:
- which board task(s) this message is linked to
- what kind of link each task has to the message
- how the actor's active task state relates to each task at that moment
- what board-task tool action(s) the message represents, when the message contains successful tool results

They are **not** UI objects.

### 2. Read model

`claude_team` reads transcript entries and builds:

- `BoardTaskActivityEntry`

This is the UI-facing model for the new task activity feed.

This separation keeps the runtime contract stable while allowing the UI to evolve.

---

## Layering and Isolation Rules

These rules are part of the design, not optional cleanup.

### 1. Persisted contract is not a UI DTO

`boardTaskLinks[]` must remain a small runtime fact model.

It should not grow UI-only fields such as:
- display labels
- actor names
- timestamps duplicated from transcript entries
- section-level rendering hints

### 2. The new feed must not depend on legacy heuristics in v1

The new `Task Activity` feed should read **explicit links only**.

That means:
- no mention-based guessing
- no owner/session overlap inference
- no work-interval heuristics inside the new feed

Legacy heuristics remain available only inside the legacy execution-sessions block.

### 3. Keep the old session code, but isolate it

Do **not** delete the current execution-session code.

Do **not** comment it out either.

Instead:
- keep it behind a separate service boundary
- keep it rendered in a separate UI section
- treat it as compatibility/session-exploration logic, not as the new source of truth

### 4. The popup composes two read models, not one mixed model

The task popup should compose:
- explicit event-level task activity
- legacy session-level execution browsing

It should **not** merge both into one array or one card list.

---

## Naming Decisions

### Persisted fields

Use:

- `boardTaskLinks`
- `boardTaskToolActions`

Do **not** use:

- `taskContext`
- `boardTaskContext`

Why:
- one message can legitimately link to **multiple board tasks**
- `task_link` and `task_unlink` are the clearest example
- plural naming makes the model honest

### Persisted types

Use:

- `BoardTaskLinkV1`
- `BoardTaskLocator`
- `BoardTaskToolActionV1`

### Read model

Use:

- shared DTO: `BoardTaskActivityEntry`
- main service: `BoardTaskActivityService`
- transcript discovery service: `TeamTranscriptSourceLocator`

### Renderer names

Use:

- outer section label: `Task Logs`
- user-facing subsection label: `Task Activity`
- renderer component: `TaskActivitySection`
- composed container: `TaskLogsPanel`

### Legacy/session block

Use:

- `Execution Sessions`

This keeps the old block clearly separate from the new activity feed.

### Why not `TaskActivityTimeline` as the main internal name

The repo already has:
- `ActivityTimeline` for team inbox/message activity
- `Workflow History` / `StatusHistoryTimeline` for board-state history

Using `TaskActivityTimeline` as the main internal component name would make the codebase harder to scan.

So:
- `Task Logs` is the better outer section label
- `Task Activity` stays the user-facing subsection label
- `TaskActivitySection` is the better internal renderer name

---

## Domain Boundaries

### Included

Board task domain only:
- `task_*` MCP tools that operate on board tasks
- `review_*` MCP tools tied to a board task

### Excluded

Do not include in the new core:
- built-in `TaskCreate`
- built-in `TaskUpdate`
- generic inbox/message/process tools without task target

Those can remain as legacy/fallback logic where needed, but they are not part of the new activity core.

---

## Persisted Wire Contract

### Transcript field

Add an optional field to transcript messages in `agent_teams_orchestrator`:

```ts
type BoardTaskLocator = {
  ref: string
  refKind: 'canonical' | 'display' | 'unknown'
  canonicalId?: string
}

type BoardTaskLinkV1 = {
  schemaVersion: 1

  task: BoardTaskLocator

  taskArgumentSlot?: 'taskId' | 'targetId'

  toolUseId?: string

  linkKind: 'execution' | 'lifecycle' | 'board_action'

  actorContext: {
    relation: 'same_task' | 'other_active_task' | 'idle' | 'ambiguous'
    activeTask?: BoardTaskLocator
    activePhase?: 'work' | 'review'
    activeExecutionSeq?: number
  }
}

type BoardTaskToolActionV1 = {
  schemaVersion: 1
  toolUseId: string
  canonicalToolName: string
  input?: {
    status?: 'pending' | 'in_progress' | 'completed' | 'deleted'
    owner?: string | null
    relationship?: 'blocked-by' | 'blocks' | 'related'
    clarification?: 'lead' | 'user' | null
    reviewer?: string
    commentId?: string
  }
  resultRefs?: {
    commentId?: string
    attachmentId?: string
    filename?: string
  }
}

type TranscriptMessage = ExistingTranscriptMessage & {
  boardTaskLinks?: BoardTaskLinkV1[]
  boardTaskToolActions?: BoardTaskToolActionV1[]
}
```

### Why this shape

- `task.ref` instead of unconditional `taskId`
  - runtime input may contain display IDs
  - do not lie about canonical identity
  - store the normalized task reference without a leading `#`
- `schemaVersion`
  - clearer than a generic nested `version`
  - safer when transcript messages already contain their own top-level version fields
- `taskArgumentSlot`
  - needed for multi-target tools
  - aligns the persisted contract with the actual MCP input slots (`taskId` / `targetId`)
  - clearer than `inputRole`, which is too easy to confuse with user/assistant message roles
  - clearer than `toolArgumentRole`, because this is specifically the task-related argument slot
  - should be omitted for ambient execution links that do not originate from a tool argument
- `toolUseId`
  - needed to join task links to the exact `tool_result` block that produced them
  - protects the contract when one transcript message contains multiple `tool_result` blocks
- `linkKind`
  - distinguishes execution, lifecycle, and board actions
- `actorContext`
  - captures the subtle "actor is currently active on another task" case
- `boardTaskToolActions`
  - keeps message-level tool semantics out of the per-target link object
  - avoids repeating the same tool metadata across multiple target links
  - must be plural because a single user message can legitimately contain multiple `tool_result` blocks
  - gives the read-side enough stable structure for rows such as owner/status/relationship/clarification changes without parsing free text
  - can carry stable result references such as `commentId` / `attachmentId` when the tool returns them
  - `canonicalToolName` should store the canonical bare board tool name after `agent-teams` MCP normalization
  - `input` / `resultRefs` should stay minimal and semantic, not a dump of raw MCP input or raw tool result
  - do not copy long free-text payloads such as comment text, review notes, or request-change prose into transcript metadata
  - omit orchestration-only inputs already represented elsewhere, such as `from`, `actor`, `leadSessionId`, and `notifyOwner`

### Important rule

Do **not** duplicate in `boardTaskLinks` or `boardTaskToolActions`:
- timestamp
- sessionId
- agentId
- memberName
- teamName

Those already exist on the transcript entry itself and should remain single-source.

For read-side task popup queries, the team scope comes from the surrounding team-scoped query/file
discovery path, so `boardTaskLinks[]` does not need to repeat it.

This is especially important because not every transcript path is guaranteed to stamp `teamName`
uniformly on every entry, particularly sidechain-oriented paths.

### Metadata size budget

The explicit contract must stay small enough to remain transcript-friendly.

Recommended budget rules:
- at most one `BoardTaskToolActionV1` per `toolUseId` in one message
- keep `boardTaskLinks` to the minimal task-target set for that message
- never persist arbitrary free-text comment bodies, review prose, or task descriptions
- trim all persisted string identifiers
- suggested soft caps:
  - `task.ref` / `canonicalId` / `toolUseId` / `canonicalToolName` - at most 128 chars
  - `filename` - at most 256 chars
  - enum-like fields only from explicit allow-lists

If a value exceeds the budget:
- prefer omitting that optional field over truncating it into a misleading value
- for required identifiers, skip that object and emit debug diagnostics instead of persisting junk

### Omit vs null policy

Use omission by default for unknown or unavailable optional fields.

Rules:
- use `undefined` / omitted for:
  - `taskArgumentSlot`
  - `toolUseId` on ambient execution links
  - `canonicalId` when unresolved
  - `actorContext.activeTask`
  - `actorContext.activePhase`
  - `actorContext.activeExecutionSeq`
  - optional `input` / `resultRefs` fields that are not whitelisted for the current tool
- use explicit `null` only when the domain itself uses null as meaningful data:
  - `input.owner = null`
  - `input.clarification = null`

Why:
- omission means "not available / not applicable"
- `null` means "explicitly cleared"
- mixing them loosely would make parser behavior and UI labels inconsistent

### Invariants

- every `boardTaskToolActions[*].toolUseId` should match at least one `boardTaskLinks[*].toolUseId`
- `boardTaskToolActions` must not appear without at least one `boardTaskLink`
- within one message, `boardTaskToolActions` should be unique by `toolUseId`
- `linkKind = 'execution'` is reserved for ambient execution rows in v1
- `execution` links may carry `toolUseId` when they intentionally anchor a worker `tool_result`
  row for exact task-log reconstruction
- therefore `execution` links should omit `taskArgumentSlot`
- `boardTaskToolActions` should only pair with sibling links whose `linkKind` is `lifecycle` or `board_action`
- `actorContext.activeTask` should only be set when `relation = 'other_active_task'`
- `actorContext.activePhase` / `actorContext.activeExecutionSeq` describe the actor's active scope,
  not the target task's own identity
- for `linkKind = 'lifecycle'`, `actorContext` should reflect the actor state **before** the
  lifecycle transition is applied
- within one message, emitted links should be unique by `(toolUseId ?? 'ambient', task.ref, taskArgumentSlot ?? 'none', linkKind)`
- ambient execution links should omit `taskArgumentSlot`
- tool-derived links should set `taskArgumentSlot = 'taskId'` for the primary task-argument slot
- `toolUseId` should still be omitted for ordinary conversational execution messages

### Additive-safety note

This is safe as additive transcript metadata because:
- `agent_teams_orchestrator` transcript messages already tolerate optional extra fields
- `claude_team` JSONL parsing is loose and ignores unknown fields until explicitly consumed

### Version evolution policy

- bump `schemaVersion` only for breaking meaning changes, not for additive optional fields
- additive optional fields within `BoardTaskLinkV1` / `BoardTaskToolActionV1` should remain on
  version `1`
- a single message should not mix multiple schema versions for the same object family
- readers should accept the current version and ignore newer unknown versions object-by-object
- writers should emit exactly one stable version family at a time

This keeps rollout and future migrations simple:
- old readers keep working by ignoring what they do not understand
- new readers can still salvage older transcript rows without rewriting history

---

## Write-Side Emission Policy

The runtime should emit explicit links only when it has reliable information.

### Carrier-field rule

On the write side, the cleanest implementation is to carry:

- `boardTaskLinks?: BoardTaskLinkV1[]`
- `boardTaskToolActions?: BoardTaskToolActionV1[]`

as internal transcript-only fields on runtime `Message` objects before persistence.

Those carriers must be threaded through the message creation/normalization path for any message
types that can legitimately receive task metadata.

That implies adding optional transcript-only fields to the orchestrator's internal message types,
not just to `TranscriptMessage`.

This keeps the contract close to the message that will actually be persisted and avoids having a
separate side registry that can drift from message ordering.

### Carrier propagation checkpoints

The implementation should explicitly audit the runtime paths that rebuild messages rather than
assuming a new field on `TranscriptMessage` will survive automatically.

At minimum, verify the carrier survives:
- message factory helpers such as `createUserMessage(...)`
- any assistant-message creation path that rebuilds plain objects
- message normalization paths that split multi-block messages into new message objects
- transcript logging cleanup paths before `insertMessageChain(...)`

And the implementation should explicitly **not** leak transcript-only task metadata into:
- model payload normalization
- SDK/web message mappers
- any API-facing serialization path not intended for transcript persistence

### V1 rules

- stamp explicit task links on successful board-task `tool_result` messages
- stamp `boardTaskToolActions` only on successful board-task `tool_result` messages
- stamp ambient `execution` links only on ordinary conversational messages when the actor has exactly one active task
- do not rely on raw `tool_use` alone to claim lifecycle success
- do not attach ambient execution links to progress, attachment, system, or transcript-only meta scaffolding
- do not attach ambient execution links to assistant `tool_use` blocks or thinking-only assistant children after normalization
- do not ambient-stamp lead free-text execution in v1
- dedupe lifecycle/action application by `(sessionId, agentId ?? 'main', toolUseId)` before mutating actor execution state or stamping transcript fields

### Carrier placement matrix

Allowed carrier placement by runtime message shape:

- user `tool_result` message
  - may carry `boardTaskLinks`
  - may carry `boardTaskToolActions`
- ordinary user conversational message
  - may carry ambient `boardTaskLinks`
  - must not carry `boardTaskToolActions`
- ordinary assistant conversational message
  - may carry ambient `boardTaskLinks`
  - must not carry `boardTaskToolActions`
- assistant `tool_use` message
  - must not carry either carrier family in v1
- thinking-only assistant child
  - must not carry either carrier family
- `progress`, `attachment`, `system`, `tombstone`, compact-boundary, and other non-conversational items
  - must not carry either carrier family

Read-side simplifying assumption enabled by this rule:
- `boardTaskToolActions` always means "this message contains a concrete successful board-tool result"
- ambient execution links only appear on human-readable conversational rows

### Tool-result success matrix

For v1 explicit stamping, treat a board-tool result as successful only when all of the following hold:

- the message is a real user `tool_result` message, not a synthetic placeholder
- the `tool_result` block pairs to a real assistant `tool_use`
- the result is not an interrupt/reject/denial synthetic recovery block
- the execution outcome is semantically successful for that tool family

Conservative success rules:
- paired MCP board-task tool result with no synthetic/error recovery markers
  - emit `board_action` or `lifecycle` metadata
- paired board-task tool result that is denied, rejected, interrupted, synthetic, or otherwise unsuccessful
  - emit no explicit board-task metadata in v1
- unpaired `tool_result`
  - emit no explicit board-task metadata in v1
- ambient conversational message while one active task exists
  - emit `execution` links only

Important design choice:
- v1 does **not** model failed board actions as task-activity rows
- this is intentional to keep the first explicit feed highly reliable
- if failed-action visibility becomes important later, add a separate `failed_board_action` concept
  instead of overloading the success-only v1 contract

### Why this matters

Tool success semantics differ across tool families, so the observer must decide after execution
outcome is known, not just from the attempted tool call.

Also, some runtime paths - especially subagent-oriented ones - do not preserve rich structured
`toolUseResult` / `mcpMeta` all the way to transcript persistence. The explicit transcript fields
must therefore carry enough stable board-task semantics for the read-side to avoid reparsing
natural-language tool output.

Just as importantly, repeated tool-result handling by the same `toolUseId` would create duplicated
lifecycle transitions and duplicated task-activity rows, so the observer has to dedupe before
state mutation.

The `toolUseId` join key is also what keeps the contract correct when a single transcript message
contains more than one successful `tool_result` block.

---

## Read Model

`claude_team` should build a richer UI model:

```ts
type BoardTaskActivityEntry = {
  id: string
  timestamp: string

  actor: {
    memberName?: string
    role: 'member' | 'lead' | 'unknown'
    sessionId: string
    agentId?: string
  }

  task: {
    locator: BoardTaskLocator
    taskRef?: TaskRef
    resolution: 'resolved' | 'deleted' | 'unresolved' | 'ambiguous'
  }

  linkKind: 'execution' | 'lifecycle' | 'board_action'
  actorContext: {
    relation: 'same_task' | 'other_active_task' | 'idle' | 'ambiguous'
    activeTask?: {
      locator: BoardTaskLocator
      taskRef?: TaskRef
      resolution: 'resolved' | 'deleted' | 'unresolved' | 'ambiguous'
    }
    activePhase?: 'work' | 'review'
    activeExecutionSeq?: number
  }

  action: {
    canonicalToolName?: string
    toolUseId?: string
    category:
      | 'status'
      | 'review'
      | 'comment'
      | 'assignment'
      | 'read'
      | 'attachment'
      | 'relationship'
      | 'clarification'
      | 'other'
    peerTask?: {
      locator: BoardTaskLocator
      taskRef?: TaskRef
      resolution: 'resolved' | 'deleted' | 'unresolved' | 'ambiguous'
    }
    relationshipPerspective?: 'outgoing' | 'incoming' | 'symmetric'
    details?: {
      status?: 'pending' | 'in_progress' | 'completed' | 'deleted'
      owner?: string | null
      relationship?: 'blocked-by' | 'blocks' | 'related'
      clarification?: 'lead' | 'user' | null
      reviewer?: string
      commentId?: string
      attachmentId?: string
      filename?: string
    }
  }

  source: {
    messageUuid: string
    filePath: string
  }
}
```

The read model should be derived, not persisted.

`id` should be stable and deterministic, for example:
- `${messageUuid}:${action.toolUseId ?? 'ambient'}:${task.locator.ref}:${link.taskArgumentSlot ?? 'none'}:${linkKind}`

This avoids duplicate-row key problems when one transcript message yields multiple task activity rows.

This read model should stay **semantic**, not presentation-coupled.

It is the right place to add:
- resolved actor identity
- resolved task references where possible
- action category
- actor/task relationship state
- relationship peer-task context derived from sibling links within the same message

It is **not** the right place to hardcode:
- final display labels
- UI tone names
- renderer-specific row text

The read model should **not** leak raw transport details such as `taskArgumentSlot` into renderer code.
For relationship tools, the builder should consume `taskArgumentSlot` from the persisted link and expose
semantic information instead:
- `peerTask`
- `relationshipPerspective`

For non-relationship rows, `taskArgumentSlot` is internal transport detail only:
- ambient execution rows will usually have it omitted
- ordinary single-target tool rows may have `'task'`
- renderer code should not branch on it directly

Mapping rules for relationship rows:
- `related` -> `relationshipPerspective = 'symmetric'` on both task popups
- `blocked-by` on the `task` side -> `incoming`
- `blocked-by` on the `target` side -> `outgoing`
- `blocks` on the `task` side -> `outgoing`
- `blocks` on the `target` side -> `incoming`

Whenever possible, the read-side builder should resolve persisted locators into the app's existing
shared `TaskRef` semantics for rendering and navigation.

If resolution fails, it should keep the raw locator for fallback display instead of dropping the row.

### Task resolution policy

This is one of the highest-risk read-side areas.

The builder must never silently guess a task from a weak locator.

Rules:
- canonical identity always wins:
  - `locator.canonicalId`
  - then `refKind = 'canonical'`
- display-form resolution is allowed only when it resolves to **exactly one** candidate in team scope
- if multiple candidates share the same display-like ref, mark the row `resolution = 'ambiguous'`
  and keep only the raw locator
- if no candidate matches, mark the row `resolution = 'unresolved'`
- if the best unique candidate exists only in deleted tasks, keep `taskRef` but mark
  `resolution = 'deleted'`
- never drop a row only because the task cannot be resolved to a live `TaskRef`
- renderer navigation should rely on both `taskRef` and `resolution`
- in v1, rows with `resolution = 'deleted' | 'unresolved' | 'ambiguous'` should render as
  non-primary navigation targets even if a fallback `taskRef` exists for label purposes

Lookup scope:
- build the lookup from both active tasks and deleted tasks
- deleted tasks are needed mainly for:
  - historical relationship rows
  - lifecycle/action rows targeting tasks that were later deleted
  - peer-task rendering for old `task_link` / `task_unlink` history

Anti-guessing rule:
- do not use `Map<string, TaskRef>` for display-id resolution
- display-like refs must resolve through a candidate set, not `last wins`
- if an `unknown` ref could be both a canonical-looking id and a display-like id, prefer exact
  canonical-id lookup first, then unique display resolution, otherwise stay unresolved

This policy should explicitly reuse existing shared task-identity rules where possible:
- `looksLikeCanonicalTaskId(...)`
- `getTaskDisplayId(...)`

---

## UI Structure

In the task popup, the current `Execution Logs` section should become a composed panel:

- `Task Activity`
- `Execution Sessions`

Target end state:
- outer collapsible title = `Task Logs`
- inner subsections = `Task Activity` and `Execution Sessions`

For rollout stability, the outer collapsible title may temporarily remain `Execution Logs`,
but the plan target should still be `Task Logs`.

Inside that block, the composed content should clearly separate:
- `Task Activity`
- `Execution Sessions`

This preserves user familiarity while still introducing the new model cleanly.

### Task Activity

New feed based only on explicit `boardTaskLinks` plus message-level `boardTaskToolActions`

Shows:
- lifecycle events
- execution-linked activity
- related board actions on this task

This section complements `Workflow History`, not replaces it:
- `Workflow History` remains the authoritative board-state timeline
- `Task Activity` becomes the runtime provenance feed

Empty-state guidance:
- if no explicit activity exists for a task, render an explicit empty state instead of silently collapsing the section
- the copy should explain that older sessions may still be available below in `Execution Sessions`

Resolution display guidance:
- `resolution = 'active'`
  - render normal task label/navigation behavior
- `resolution = 'deleted'`
  - render deleted-state badge or muted label
  - do not present it as a normal clickable live-task target in v1
- `resolution = 'unresolved' | 'ambiguous'`
  - render raw locator fallback
  - avoid deep-link navigation because the target identity is not reliable

### Execution Sessions

Keep the current session-based block, powered by the existing `MemberLogsTab`

Purpose:
- full transcript viewing
- current previews
- chunk filtering
- session-level exploration

This block should be clearly treated as **legacy/session-centric**, not the new source of truth for task activity.

Important UI rule:
- execution-specific polling affordances such as `Updating...` / `Online` belong to the `Execution Sessions` subsection only
- they should not be used as the loading or freshness indicator for the whole `Task Logs` panel

---

## Why We Are Not Replacing the Old Block

The current execution-log UI is useful, but it is solving a different problem:

- it groups by session
- it sorts by work-interval overlap
- it filters chunks by persisted work intervals

That is good for execution sessions, but not enough for task activity provenance.

Trying to make one model serve both purposes creates:
- misleading activity feeds
- hidden related actions from other actors
- more heuristics
- harder maintenance

So the correct design is **parallel, not replacement**.

---

## Tool Classification

All tool names in this section refer to the **canonical bare board-tool name** after `agent-teams` MCP name normalization.

### Lifecycle

These create `linkKind = 'lifecycle'`:

- `task_start`
- `task_complete`
- `task_set_status`
- `review_start`
- `review_approve`
- `review_request_changes`

### Board actions

These create `linkKind = 'board_action'`:

- `task_add_comment`
- `task_get_comment`
- `task_set_owner`
- `task_attach_file`
- `task_attach_comment_file`
- `task_link`
- `task_unlink`
- `task_set_clarification`
- `review_request`

### Low-signal reads

These are still explicit links, but may be visually muted or collapsible:

- `task_get`

### Ignored in v1

- `task_create`
- `task_create_from_message`
- `task_list`
- `task_briefing`
- `member_briefing`
- broad process/message tools without explicit `taskId`

---

## Execution State Rules

The runtime must not keep a naive single `currentTask`.

Instead it should keep an execution scope per actor:

- key = `(sessionId, agentId ?? 'main')`

State should track:
- open active task set
- active phase (`work` or `review`)
- execution sequence number

### Safe stamping rules

- `0` active tasks
  - no ambient execution link
- `1` active task
  - ambient execution link allowed
- `2+` active tasks
  - relation becomes `ambiguous`
  - do not guess

### Important rule

For lifecycle messages:
- stamp the link from the explicit tool target first
- then update the actor execution state

This ensures the lifecycle message itself is always linked to the correct task.

---

## Review Flow Rules

Review is part of the board-task activity domain and must be modeled explicitly.

### Rules

- `review_request`
  - `board_action`
  - does **not** open review execution
- `review_start`
  - `lifecycle`
  - may open review execution for the reviewer
- `review_approve`
  - `lifecycle`
  - closes review execution
- `review_request_changes`
  - `lifecycle`
  - closes review execution

This keeps reviewer activity structurally visible instead of forcing it through status heuristics.

---

## Multi-Target Tools

### `task_link` / `task_unlink`

These should emit **two links** when both task references are resolved:

- one with `taskArgumentSlot = 'taskId'`
- one with `taskArgumentSlot = 'targetId'`

This is the strongest reason to use `boardTaskLinks[]` instead of a single object.

On the read side, the builder should combine sibling links from the same transcript message so each
rendered row can expose:
- the current task
- the peer task
- the relationship perspective for the current task

That avoids forcing renderer code to understand raw MCP input roles.

The `BoardTaskToolActionV1.input.relationship` value plus the persisted `taskArgumentSlot` should be
enough for the builder to derive relationship direction without re-reading task files.

---

## Edge Cases

### Another actor updates a task

Example:
- Bob is actively working on task B
- Bob calls `task_add_comment` on task A

Expected result:
- task A activity feed shows the event
- task B can continue to show Bob's own execution session separately in the legacy block
- event is marked as a related board action from another active task
- it is **not** shown as execution of task A

### Lead mixed stream

In v1:
- do not ambient-stamp lead free-text execution
- do allow explicit lifecycle and board-action links from lead tool calls

### Ambiguous execution state

If the actor has multiple active tasks:
- do not guess
- stamp explicit target links only
- use `relation = 'ambiguous'`

### Idle actor

If the actor is not actively executing any task but performs a task tool call:
- use `relation = 'idle'`

### Historical logs

Old logs without `boardTaskLinks` remain supported through:
- legacy execution sessions
- existing fallback logic where still needed

The new activity feed in v1 should use explicit links only.

### Multi-target relationship actions

For `task_link` / `task_unlink`:
- the task popup for the `taskId` side should render the relationship from that task's perspective
- the related task popup for the `targetId` side should render the mirrored relationship from the peer-task perspective
- the UI label should make the relationship direction clear instead of rendering both rows identically

---

## Implementation Structure

### `agent_teams_orchestrator`

Create a dedicated feature area:

- `src/services/boardTaskActivity/contract.ts`
- `src/services/boardTaskActivity/BoardTaskToolInterpreter.ts`
- `src/services/boardTaskActivity/BoardTaskExecutionReducer.ts`
- `src/services/boardTaskActivity/BoardTaskTranscriptProjector.ts`
- `src/services/boardTaskActivity/RuntimeBoardTaskExecutionStore.ts`
- `src/services/boardTaskActivity/QueryBoardTaskObserver.ts`

Responsibilities:
- inspect board MCP tool semantics
- maintain actor execution state
- produce `boardTaskLinks[]`
- produce `boardTaskToolActions[]` where applicable
- attach transcript-only task metadata before persistence

Implementation note:
- thread the internal carrier field through the runtime message helpers before `insertMessageChain(...)`
- avoid computing task links late inside persistence from mutable global state

### `claude_team`

Create a separate task-log feature area:

- `src/main/services/team/taskLogs/contract/BoardTaskTranscriptContract.ts`
- `src/main/services/team/taskLogs/discovery/TeamTranscriptSourceLocator.ts`
- `src/main/services/team/taskLogs/activity/BoardTaskActivityTranscriptReader.ts`
- `src/main/services/team/taskLogs/activity/BoardTaskActivityEntryBuilder.ts`
- `src/main/services/team/taskLogs/activity/BoardTaskActivityService.ts`
- `src/main/services/team/taskLogs/legacy/LegacyExecutionSessionsService.ts`
- `src/main/ipc/teams.ts` - add a dedicated `getTaskActivity` handler
- `src/main/ipc/handlers.ts` - register / remove the new handler with existing team IPC initialization

Shared types:

- `src/shared/types/team.ts` - add `BoardTaskActivityEntry` and related IPC-visible types
- `src/shared/types/api.ts` - add `teams.getTaskActivity(...)`
- `src/preload/constants/ipcChannels.ts` - add `TEAM_GET_TASK_ACTIVITY`
- `src/preload/index.ts` - expose the new preload method
- `src/renderer/api/httpClient.ts` - add browser-mode fallback for `getTaskActivity`

Renderer:

- `src/renderer/components/team/taskLogs/TaskLogsPanel.tsx`
- `src/renderer/components/team/taskLogs/TaskActivitySection.tsx`
- `src/renderer/components/team/taskLogs/ExecutionSessionsSection.tsx`
- `src/renderer/components/team/taskLogs/taskActivityPresentation.ts`

### API separation

Do **not** overload the existing legacy API method.

Keep:
- `teams.getLogsForTask(...)` for legacy execution sessions

Add:
- `teams.getTaskActivity(teamName, taskId)` for the new explicit activity model

This separation keeps the new model isolated from the old heuristic/session path.

For the first rollout, this API can follow the same availability profile as the current
task-log endpoints:
- supported in Electron
- browser-mode HTTP client can return `[]` with a warning, matching the current task-log API pattern

### Contract discipline

To keep both repos aligned without over-coupling them:

- define JSON schemas for `BoardTaskLinkV1` and `BoardTaskToolActionV1`
- mirror the TypeScript type locally in each repo
- add golden fixtures for representative cases in both repos
- keep transcript-contract mirror types main-process-only in `claude_team`
- keep `BoardTaskActivityEntry` and other IPC-visible DTOs in shared preload/renderer types

Parsing tolerance rules:
- parse `boardTaskLinks` and `boardTaskToolActions` defensively and independently
- if one link object is malformed, drop only that link, not the whole transcript message
- if one action object is malformed, drop only that action, not the whole transcript message
- if `schemaVersion` is unknown, skip that object family and keep the rest of the message readable
- if a link references a `toolUseId` with no surviving action, the row may still be rendered from the
  link alone
- if an action survives but no links survive for its `toolUseId`, ignore the action for feed-building
  and optionally emit a debug log

This keeps the explicit feed resilient against partial writes, old transcripts, or future schema
extensions that the current reader does not understand yet.

Minimum fixture set:
- same-task execution
- one message with multiple board-task tool results joined by distinct `toolUseId`
- lifecycle by another actor while active on a different task
- board action by another actor while active on a different task
- review start / review completion
- task link dual-target emission
- relationship row with derived peer task and relationship perspective
- task relationship subtype payload
- status / owner / clarification action payload
- unresolved display-only task locator
- display-id collision produces `resolution = 'ambiguous'`
- deleted task locator produces `resolution = 'deleted'` without dropping the row
- unknown refKind that looks canonical resolves by exact id before any display fallback
- ambiguous actor context
- legacy entry without explicit links

---

## Concrete Code Blueprint

This section is intentionally implementation-oriented. The goal is to remove as much ambiguity as
possible before coding starts.

### `agent_teams_orchestrator` - exact touchpoints

#### 1. Transcript contract types

File:
- `src/services/boardTaskActivity/contract.ts`
- `src/types/logs.ts`

Add:

```ts
export type BoardTaskLocator = {
  ref: string
  refKind: 'canonical' | 'display' | 'unknown'
  canonicalId?: string
}

export type BoardTaskLinkV1 = {
  schemaVersion: 1
  task: BoardTaskLocator
  taskArgumentSlot?: 'taskId' | 'targetId'
  toolUseId?: string
  linkKind: 'execution' | 'lifecycle' | 'board_action'
  actorContext: {
    relation: 'same_task' | 'other_active_task' | 'idle' | 'ambiguous'
    activeTask?: BoardTaskLocator
    activePhase?: 'work' | 'review'
    activeExecutionSeq?: number
  }
}

export type BoardTaskToolActionV1 = {
  schemaVersion: 1
  toolUseId: string
  canonicalToolName: string
  input?: {
    status?: 'pending' | 'in_progress' | 'completed' | 'deleted'
    owner?: string | null
    relationship?: 'blocked-by' | 'blocks' | 'related'
    clarification?: 'lead' | 'user' | null
    reviewer?: string
    commentId?: string
  }
  resultRefs?: {
    commentId?: string
    attachmentId?: string
    filename?: string
  }
}
```

Extend `TranscriptMessage` in `src/types/logs.ts` with:

```ts
boardTaskLinks?: BoardTaskLinkV1[]
boardTaskToolActions?: BoardTaskToolActionV1[]
```

Preferred reusable carrier type:

```ts
export type BoardTaskCarrierFields = {
  boardTaskLinks?: BoardTaskLinkV1[]
  boardTaskToolActions?: BoardTaskToolActionV1[]
}
```

Implementation preference:
- prefer one shared `BoardTaskCarrierFields` mixin over repeating the same optional fields across
  every helper and every runtime message type by hand
- if the actual runtime message owner file can be updated cleanly, extend the owner types with this
  mixin once
- if the owner path is awkward or generated, use local intersection types at helper boundaries
  instead of falling back to `any`
- keep these carrier fields runtime-internal and transcript-oriented, not part of API/model payloads

Preferred blast-radius-minimizing strategy:

```ts
type TaskAwareMessage = Message & BoardTaskCarrierFields
type TaskAwareUserMessage = UserMessage & BoardTaskCarrierFields
type TaskAwareAssistantMessage = AssistantMessage &
  Pick<BoardTaskCarrierFields, 'boardTaskLinks'>
```

Use these local aliases first in:
- `createUserMessage(...)`
- `baseCreateAssistantMessage(...)`
- `emitTaskAware(...)`
- `insertMessageChain(...)`

Why this is safer for v1:
- it localizes type churn to the board-task feature path
- it avoids blocking the whole rollout on the unresolved physical owner path for `types/message`
- it reduces the chance of breaking unrelated call sites that only know about plain `Message`
- it still keeps transcript persistence explicit and typed

Only after the feature works end-to-end should we consider merging the mixin into the canonical
runtime message owner types everywhere, and only if that cleanup actually reduces complexity.

#### 2. Internal message carriers

File:
- `src/utils/messages.ts`

Concrete changes:
- introduce or import `BoardTaskCarrierFields`
- extend `createUserMessage(...)` params with that mixin
- extend the runtime `Message` / `UserMessage` / `AssistantMessage` type definitions with the same
  mixin only if the actual owner path makes that straightforward
- follow the actual import target used by `src/utils/messages.ts` for those runtime message types
  instead of assuming the owner file path from memory
- add those fields onto the returned runtime message object
- extend the assistant message creation path with the same carrier mixin for ambient execution
  stamping on assistant conversational messages
- the likely concrete touchpoint is `baseCreateAssistantMessage(...)`, because assistant helpers
  already funnel through it
- ensure `normalizeMessages(...)` assistant split path preserves ambient `boardTaskLinks` on
  conversational assistant text children instead of silently dropping them
- in the user normalization path that rebuilds per-block messages, pass those fields through when
  calling `createUserMessage(...)`

Pseudo-shape:

```ts
export function createUserMessage({
  ...,
  boardTaskLinks,
  boardTaskToolActions,
}: {
  ...
} & BoardTaskCarrierFields): TaskAwareUserMessage {
  return {
    ...,
    boardTaskLinks,
    boardTaskToolActions,
  }
}
```

For assistant helpers, the concrete shape should be parallel:

```ts
function baseCreateAssistantMessage({
  ...,
  boardTaskLinks,
}: {
  ...
  boardTaskLinks?: BoardTaskLinkV1[]
}): TaskAwareAssistantMessage {
  return {
    ...,
    boardTaskLinks,
  }
}
```

And in the normalization split path:

```ts
return {
  ...createUserMessage({
    content: [_],
    ...,
    boardTaskLinks: filteredBoardTaskLinksForBlock(message.boardTaskLinks, _),
    boardTaskToolActions: filteredBoardTaskToolActionsForBlock(message.boardTaskToolActions, _),
  }),
  uuid: ...,
}
```

Suggested helpers:

```ts
function filteredBoardTaskLinksForBlock(
  links: BoardTaskLinkV1[] | undefined,
  block: ContentBlockParam,
): BoardTaskLinkV1[] | undefined {
  if (!links?.length) return undefined
  if (block.type === 'tool_result') {
    const matching = links.filter(link => link.toolUseId === block.tool_use_id)
    return matching.length > 0 ? matching : undefined
  }
  const ambient = links.filter(link => link.toolUseId === undefined)
  return ambient.length > 0 ? ambient : undefined
}

function filteredBoardTaskToolActionsForBlock(
  actions: BoardTaskToolActionV1[] | undefined,
  block: ContentBlockParam,
): BoardTaskToolActionV1[] | undefined {
  if (!actions?.length) return undefined
  if (block.type !== 'tool_result') return undefined
  const matching = actions.filter(action => action.toolUseId === block.tool_use_id)
  return matching.length > 0 ? matching : undefined
}
```

Filtering rule for split messages:
- if `_` is a `tool_result`, carry only links/actions whose `toolUseId` matches that block
- if `_` is ordinary conversational content, carry only ambient execution links where `toolUseId` is absent
- do not blindly copy the full arrays to every split child message

Without this rule, one split `tool_result` child can silently inherit metadata that belongs to a
different `tool_result` block from the same original message.

Why here:
- `normalizeMessagesForAPI(...)` rebuilds user messages
- if the carrier is not passed through here, transcript metadata will silently disappear on
  multi-block user messages
- ordinary conversational task activity can also land on assistant messages, so the assistant
  creation path must be able to carry `boardTaskLinks`
- but the assistant split path should keep ambient execution links only on human-readable
  conversational children, not on `tool_use` or thinking-only children

#### 3. Central tool-name normalization

Files:
- `src/services/mcp/mcpStringUtils.ts`
- `src/Tool.ts`

Concrete rule:
- do not add handwritten regexes for `mcp__agent-teams__...`
- use `mcpInfoFromString(...)` and/or the same canonicalization semantics as `toolMatchesName(...)`

Recommended helper in `BoardTaskToolInterpreter.ts`:

```ts
function canonicalizeBoardToolName(rawName: string): string | null {
  const info = mcpInfoFromString(rawName)
  if (!info?.toolName) {
    return rawName.startsWith('task_') || rawName.startsWith('review_')
      ? rawName
      : null
  }
  const normalizedServer = info.serverName.replace(/[-_]+/g, '_')
  if (normalizedServer !== 'agent_teams') return null
  return info.toolName
}
```

#### 4. Execution state store

Files:
- `src/services/boardTaskActivity/RuntimeBoardTaskExecutionStore.ts`
- `src/services/boardTaskActivity/BoardTaskExecutionReducer.ts`

Suggested state:

```ts
type ActorExecutionState = {
  openTasks: Map<string, { locator: BoardTaskLocator; phase: 'work' | 'review'; activeExecutionSeq: number }>
  appliedToolUseIds: Set<string>
}
```

Key the store by:

```ts
`${sessionId}:${agentId ?? 'main'}`
```

Reducer API:

```ts
applyLifecycle(
  state: ActorExecutionState,
  event: {
    toolUseId: string
    task: BoardTaskLocator
    event:
      | 'task_start'
      | 'task_complete'
      | 'task_set_status'
      | 'review_start'
      | 'review_approve'
      | 'review_request_changes'
    status?: 'pending' | 'in_progress' | 'completed' | 'deleted'
  }
): ActorExecutionState
```

Important reducer rules:
- no-op if `toolUseId` already applied
- `task_start` and `task_set_status(in_progress)` open work execution
- `task_complete` and `task_set_status(completed|pending|deleted)` close work execution
- `review_start` opens review execution
- `review_approve` and `review_request_changes` close review execution
- never guess when `openTasks.size > 1`

#### 5. Tool interpreter

File:
- `src/services/boardTaskActivity/BoardTaskToolInterpreter.ts`

Recommended public API:

```ts
class BoardTaskToolInterpreter {
  interpretToolResult(params: {
    rawToolName: string
    toolUseId: string
    input: Record<string, unknown>
    result: unknown
  }): {
    canonicalToolName: string | null
    links: BoardTaskLinkV1[]
    actions: BoardTaskToolActionV1[]
    lifecycleEvent?: LifecycleEvent
  }
}
```

Why `Interpreter` is the safer name:
- this module does more than assign a category
- it interprets raw tool name + input + result into domain semantics:
  - canonical tool identity
  - target task locator(s)
  - emitted task links
  - emitted tool actions
  - optional lifecycle transitions
- calling it a `Classifier` would understate responsibility and make semantic leakage into
  neighboring modules more likely

V1 source-of-truth table should follow the currently registered teammate-operational board tools
from `agent-teams-controller/src/mcpToolCatalog.js`.

Recommended v1 classification table:
- `lifecycle`
  - `task_start`
  - `task_complete`
  - `task_set_status`
  - `review_start`
  - `review_approve`
  - `review_request_changes`
- `board_action`
  - `task_add_comment`
  - `task_attach_comment_file`
  - `task_attach_file`
  - `task_get`
  - `task_get_comment`
  - `task_link`
  - `task_set_clarification`
  - `task_set_owner`
  - `task_unlink`
  - `review_request`
- `ignore in v1 explicit feed`
  - `member_briefing`
  - `task_briefing`
  - `task_create`
  - `task_create_from_message`
  - `task_list`
- `out of domain for this feature`
  - `message_send`
  - all `cross_team_*`
  - all `process_*`
  - all `kanban_*`
  - `team_launch`
  - `team_stop`

Guardrail:
- add a unit test that loads the current task/review tool names from the controller source of truth
  and fails if a new teammate-operational board tool appears without explicit interpreter mapping
- this prevents the runtime semantics layer from silently drifting behind controller changes

Concrete extraction rules:
- task locator from `taskId`
- second locator from `targetId` for relationship tools
- `task_link` / `task_unlink` produce two links
- ordinary single-target board tools should emit one link with `taskArgumentSlot = 'taskId'`
- tool-derived links in v1 should have `linkKind = 'lifecycle'` or `linkKind = 'board_action'`, never `execution`
- `review_request` is `board_action`, not lifecycle
- do not copy long text fields from input/result into transcript metadata
- capture stable ids only:
  - `commentId`
  - `attachmentId`
  - `filename`

Per-tool payload whitelist for `BoardTaskToolActionV1`:
- `task_set_status`
  - allow `input.status`
- `task_set_owner`
  - allow `input.owner`
- `task_set_clarification`
  - allow `input.clarification`
- `review_request`
  - allow `input.reviewer` when present
- `task_link` / `task_unlink`
  - allow `input.relationship`
- `task_add_comment`
  - allow `resultRefs.commentId`
- `task_get_comment`
  - allow `input.commentId`
- `task_attach_file` / `task_attach_comment_file`
  - allow `resultRefs.attachmentId`
  - allow `resultRefs.filename`

Everything else:
- omit `input`
- omit `resultRefs`

This whitelist must live next to the interpreter logic, not in the UI builder.
The renderer should never decide which raw tool payload fields were safe to persist.

#### 6. Query integration point

File:
- `src/query.ts`

This is the safest integration point because the loop already has:
- `toolUseBlocks`
- yielded `update.message`
- normalized `tool_result` messages

Implementation shape:

```ts
const boardTaskObserver = new QueryBoardTaskObserver(...)

function emitTaskAware(message: Message): Message {
  return boardTaskObserver.annotateMessage(message, {
    sessionId: getSessionId(),
    agentId: toolUseContext.agentId,
    assistantToolUses: toolUseBlocks,
  })
}

for await (const update of toolUpdates) {
  if (update.message) {
    const annotatedMessage = emitTaskAware(update.message)

    yield annotatedMessage

    toolResults.push(
      ...normalizeMessagesForAPI([annotatedMessage], toolUseContext.options.tools).filter(
        _ => _.type === 'user',
      ),
    )
  }
  ...
}
```

Important integration rule:
- do not annotate only the `getRemainingResults()` loop
- route **all transcript-visible assistant/user yields in `query.ts`** through a small shared
  helper like `emitTaskAware(...)`
- that includes:
  - streaming completed tool results
  - remaining tool results
  - synthetic missing tool-result messages on abort
  - ordinary assistant conversational messages where ambient execution stamping is allowed
- specifically verify these concrete yield sites in the current file:
  - `yield result.message` from `streamingToolExecutor.getCompletedResults()`
  - `yield update.message` from the main `toolUpdates` loop
  - emitted messages from `yieldMissingToolResultBlocks(...)`
- explicitly exclude these non-target paths from task annotation:
  - `yield message` for `postCompactMessages`
  - `yield { type: 'tombstone', ... }`
  - tool-use summary and other non-conversational synthetic items

Otherwise the implementation will correctly stamp board-task tool results but still miss ordinary
assistant-side execution activity.

`annotateMessage(...)` should:
- for user `tool_result` messages:
  - iterate all `tool_result` blocks inside the message
  - pair each block by `tool_use_id` with the matching assistant `tool_use`
  - interpret each result
  - stamp `boardTaskLinks` and `boardTaskToolActions`
  - apply lifecycle transitions after stamping pre-event actor context
- for ordinary conversational messages:
  - if exactly one active task exists for `(sessionId, agentId)`, stamp ambient execution link
  - otherwise leave unstamped

Pairing safety rules:
- never create `boardTaskToolActions` or lifecycle transitions from a `tool_result` block unless its
  `tool_use_id` resolves to a matching assistant `tool_use`
- prefer pairing in this order:
  1. direct current-turn `assistantToolUses`
  2. `sourceToolAssistantUUID` + assistant-message lookup when available
  3. otherwise treat as unpaired and skip explicit board-task annotation for that block
- if a `tool_result` block is synthetic interrupt/error recovery output, do not emit lifecycle
  transitions even if the original tool name was a board-task tool
- if the paired tool result is clearly unsuccessful, emit no lifecycle transition
- missing pairing should be visible through debug diagnostics, not silently turned into guessed links

Recommended observer helper:

```ts
function resolveToolUseForResultBlock(params: {
  toolUseId: string
  assistantToolUses: ToolUseBlock[]
  sourceToolAssistantUUID?: string
  assistantMessages: AssistantMessage[]
}): ToolUseBlock | null {
  return (
    params.assistantToolUses.find(block => block.id === params.toolUseId) ??
    findToolUseInAssistantMessage(params.assistantMessages, params.sourceToolAssistantUUID, params.toolUseId) ??
    null
  )
}
```

#### 7. Persistence

Files:
- `src/utils/sessionStorage.ts`

Concrete rule:
- do **not** recompute task metadata in `insertMessageChain(...)`
- only make sure the new optional fields are allowed by the type and survive the spread:

```ts
const transcriptMessage: TranscriptMessage = {
  ...message,
  ...
}
```

That keeps persistence dumb and avoids late-state bugs.

---

### `claude_team` - exact touchpoints

#### 1. Keep transcript-contract parsing local to the task-activity feature

Recommended new file:
- `src/main/services/team/taskLogs/activity/BoardTaskActivityTranscriptReader.ts`

Rationale:
- do not bloat the generic JSONL parser with feature-specific activity semantics
- keep explicit activity reading isolated from the existing session-centric parsing pipeline
- the current generic parsed-message path does not expose all raw transcript metadata needed here,
  especially `teamName` / `agentName`

Suggested API:

```ts
class BoardTaskActivityTranscriptReader {
  async readFile(filePath: string): Promise<RawTaskActivityMessage[]>
}
```

`RawTaskActivityMessage` should be local to the feature and include only:
- `filePath`
- `uuid`
- `timestamp`
- `sessionId`
- `agentId`
- `isSidechain`
- `teamName`
- `agentName`
- `boardTaskLinks`
- `boardTaskToolActions`
- `sourceOrder`

Implementation detail:
- stream JSONL line-by-line, like the existing parser
- skip entries without `uuid`
- skip entries without `boardTaskLinks`
- increment `sourceOrder` per accepted line so same-timestamp rows remain deterministic
- no need to materialize full `ParsedMessage`

Recommended performance guard for v1:
- add a small per-file parse cache keyed by `(filePath, size, mtimeMs)`
- return cloned cached `RawTaskActivityMessage[]` when the signature matches
- dedupe concurrent reads with an in-flight map so repeated popup opens do not parse the same file twice
- prefer mtime+size invalidation over TTL-only invalidation
- keep the cache feature-local, similar in spirit to existing parse caches such as
  `LeadSessionParseCache`, instead of coupling it to the legacy logs finder
- when the discovered transcript file set changes for a team, clear cache entries for paths that
  disappeared from the source set

Suggested helper file:
- `src/main/services/team/taskLogs/activity/BoardTaskActivityParseCache.ts`

Suggested first-slice cache API:

```ts
type BoardTaskActivityFileSignature = {
  size: number
  mtimeMs: number
}

class BoardTaskActivityParseCache {
  getIfFresh(filePath: string, signature: BoardTaskActivityFileSignature): RawTaskActivityMessage[] | null
  getInFlight(filePath: string, signature: BoardTaskActivityFileSignature): Promise<RawTaskActivityMessage[]> | null
  setInFlight(filePath: string, signature: BoardTaskActivityFileSignature, promise: Promise<RawTaskActivityMessage[]>): void
  clearInFlight(filePath: string, signature: BoardTaskActivityFileSignature): void
  set(filePath: string, signature: BoardTaskActivityFileSignature, rows: readonly RawTaskActivityMessage[]): void
  clearForPath(filePath: string): void
}
```

Why this matters:
- the task popup may reopen repeatedly for the same task while the underlying JSONL files have not changed
- without an mtime-aware cache, the new explicit feed would re-parse the same lead/subagent files on every open
- this is a classic way to make a correct feature feel flaky or slow even when the domain model is sound

#### 2. Main-side contract parsing

Files:
- `src/main/services/team/taskLogs/contract/BoardTaskTranscriptContract.ts`
- `src/main/types/jsonl.ts` only if lightweight type guards help

Recommended functions:

```ts
export function parseBoardTaskLinks(value: unknown): BoardTaskLinkV1[] | null
export function parseBoardTaskToolActions(value: unknown): BoardTaskToolActionV1[] | null
```

Keep this contract parser feature-local and tolerant:
- unknown fields ignored
- invalid entries dropped, not fatal

Suggested parser shape:

```ts
export function parseBoardTaskLocator(value: unknown): BoardTaskLocator | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const ref = typeof row.ref === 'string' ? row.ref.trim() : ''
  const refKind =
    row.refKind === 'canonical' || row.refKind === 'display' || row.refKind === 'unknown'
      ? row.refKind
      : null
  const canonicalId =
    typeof row.canonicalId === 'string' && row.canonicalId.trim().length > 0
      ? row.canonicalId.trim()
      : undefined
  if (!ref || !refKind) return null
  return { ref, refKind, canonicalId }
}

export function parseBoardTaskLinks(value: unknown): BoardTaskLinkV1[] | null {
  if (!Array.isArray(value)) return null
  const parsed = value
    .map(item => {
      if (!item || typeof item !== 'object') return null
      const row = item as Record<string, unknown>
      if (row.schemaVersion !== 1) return null
      const task = parseBoardTaskLocator(row.task)
      if (!task) return null
      const linkKind =
        row.linkKind === 'execution' ||
        row.linkKind === 'lifecycle' ||
        row.linkKind === 'board_action'
          ? row.linkKind
          : null
      const relation =
        row.actorContext &&
        typeof row.actorContext === 'object' &&
        ['same_task', 'other_active_task', 'idle', 'ambiguous'].includes(
          String((row.actorContext as Record<string, unknown>).relation),
        )
          ? ((row.actorContext as Record<string, unknown>).relation as
              | 'same_task'
              | 'other_active_task'
              | 'idle'
              | 'ambiguous')
          : null
      if (!linkKind || !relation) return null
      return {
        schemaVersion: 1,
        task,
        taskArgumentSlot:
          row.taskArgumentSlot === 'taskId' || row.taskArgumentSlot === 'targetId'
            ? row.taskArgumentSlot
            : undefined,
        toolUseId: typeof row.toolUseId === 'string' ? row.toolUseId : undefined,
        linkKind,
        actorContext: {
          relation,
          activeTask: parseBoardTaskLocator(
            (row.actorContext as Record<string, unknown>).activeTask,
          ) ?? undefined,
          activePhase:
            (row.actorContext as Record<string, unknown>).activePhase === 'work' ||
            (row.actorContext as Record<string, unknown>).activePhase === 'review'
              ? ((row.actorContext as Record<string, unknown>).activePhase as 'work' | 'review')
              : undefined,
          activeExecutionSeq:
            typeof (row.actorContext as Record<string, unknown>).activeExecutionSeq === 'number'
              ? ((row.actorContext as Record<string, unknown>).activeExecutionSeq as number)
              : undefined,
        },
      } satisfies BoardTaskLinkV1
    })
    .filter((entry): entry is BoardTaskLinkV1 => entry !== null)
  return parsed.length > 0 ? parsed : null
}

export function parseBoardTaskToolActions(value: unknown): BoardTaskToolActionV1[] | null {
  if (!Array.isArray(value)) return null
  const parsed = value
    .map(item => {
      if (!item || typeof item !== 'object') return null
      const row = item as Record<string, unknown>
      if (row.schemaVersion !== 1) return null
      const toolUseId = typeof row.toolUseId === 'string' ? row.toolUseId.trim() : ''
      const canonicalToolName =
        typeof row.canonicalToolName === 'string' ? row.canonicalToolName.trim() : ''
      if (!toolUseId || !canonicalToolName) return null
      return {
        schemaVersion: 1,
        toolUseId,
        canonicalToolName,
      } satisfies BoardTaskToolActionV1
    })
    .filter((entry): entry is BoardTaskToolActionV1 => entry !== null)
  return parsed.length > 0 ? parsed : null
}
```

Parser behavior rule:
- do not throw for malformed per-object metadata
- salvage valid siblings and continue reading
- reserve throwing for true file-level I/O or invalid JSONL framing only

#### 3. Task-activity builder

Files:
- `src/main/services/team/taskLogs/activity/BoardTaskActivityEntryBuilder.ts`
- `src/shared/types/team.ts`

Add to shared IPC-visible types:

```ts
export interface BoardTaskActivityEntry {
  id: string
  timestamp: string
  actor: { ... }
  task: {
    locator: BoardTaskLocator
    taskRef?: TaskRef
    resolution: 'resolved' | 'deleted' | 'unresolved' | 'ambiguous'
  }
  linkKind: 'execution' | 'lifecycle' | 'board_action'
  actorContext: { ... }
  action: {
    canonicalToolName?: string
    toolUseId?: string
    category: ...
    peerTask?: {
      locator: BoardTaskLocator
      taskRef?: TaskRef
      resolution: 'resolved' | 'deleted' | 'unresolved' | 'ambiguous'
    }
    relationshipPerspective?: 'outgoing' | 'incoming' | 'symmetric'
    details?: { ... }
  }
  source: {
    messageUuid: string
    filePath: string
  }
}
```

Concrete builder algorithm:

```ts
buildEntriesForTask(rawMessage, targetTaskId) {
  const matchingLinks = rawMessage.boardTaskLinks.filter(link => matchesTarget(link.task, targetTaskId))
  const actionsByToolUseId = buildActionMap(rawMessage.boardTaskToolActions ?? [])

  return matchingLinks.map(link => {
    const action = link.toolUseId ? actionsByToolUseId.get(link.toolUseId) : undefined
    const siblingLinks = link.toolUseId
      ? rawMessage.boardTaskLinks.filter(other => other.toolUseId === link.toolUseId)
      : []
    const peerLink = siblingLinks.find(other => !sameLocator(other.task, link.task))

    return buildTaskActivityEntry(link, action, peerLink, rawMessage)
  })
}
```

Recommended action-map helper:

```ts
function buildActionMap(actions: BoardTaskToolActionV1[]): Map<string, BoardTaskToolActionV1> {
  const map = new Map<string, BoardTaskToolActionV1>()
  for (const action of actions) {
    if (map.has(action.toolUseId)) {
      logDebug('[BoardTaskActivityEntryBuilder] duplicate boardTaskToolAction toolUseId', {
        toolUseId: action.toolUseId,
      })
      continue
    }
    map.set(action.toolUseId, action)
  }
  return map
}
```

Dedupe rule:
- do not use silent `last wins`
- keep the first surviving action for a `toolUseId`
- log duplicates in debug mode so broken writer-side invariants are visible during QA

Builder simplification rule:
- if `link.linkKind === 'execution'`, do not attempt to join an action object
- `execution` rows in v1 are ambient-only and should be rendered without `BoardTaskToolActionV1`
- only `lifecycle` and `board_action` links participate in `toolUseId -> action` joins

Suggested locator-resolution helpers:

```ts
type ResolvedTaskHandle =
  | { resolution: 'resolved' | 'deleted'; taskRef: TaskRef }
  | { resolution: 'unresolved' | 'ambiguous' }

function buildTaskLookup(
  activeTasks: TeamTask[],
  deletedTasks: TeamTask[],
  teamName: string,
): {
  byId: Map<string, { resolution: 'resolved' | 'deleted'; taskRef: TaskRef }>
  byDisplayId: Map<string, Array<{ resolution: 'resolved' | 'deleted'; taskRef: TaskRef }>>
} {
  const byId = new Map<string, { resolution: 'resolved' | 'deleted'; taskRef: TaskRef }>()
  const byDisplayId = new Map<
    string,
    Array<{ resolution: 'resolved' | 'deleted'; taskRef: TaskRef }>
  >()

  const addTask = (task: TeamTask, resolution: 'resolved' | 'deleted') => {
    const taskRef: TaskRef = {
      taskId: task.id,
      displayId: getTaskDisplayId(task),
      teamName,
    }

    byId.set(task.id, { resolution, taskRef })

    const key = taskRef.displayId.toLowerCase()
    const bucket = byDisplayId.get(key) ?? []
    bucket.push({ resolution, taskRef })
    byDisplayId.set(key, bucket)
  }

  for (const task of activeTasks) addTask(task, 'active')
  for (const task of deletedTasks) {
    if (!byId.has(task.id)) addTask(task, 'deleted')
  }

  return { byId, byDisplayId }
}

function resolveLocator(
  locator: BoardTaskLocator,
  lookup: {
    byId: Map<string, { resolution: 'resolved' | 'deleted'; taskRef: TaskRef }>
    byDisplayId: Map<string, Array<{ resolution: 'resolved' | 'deleted'; taskRef: TaskRef }>>
  },
): ResolvedTaskHandle {
  if (locator.canonicalId) {
    return lookup.byId.get(locator.canonicalId) ?? { resolution: 'unresolved' }
  }

  if (locator.refKind === 'canonical') {
    return lookup.byId.get(locator.ref) ?? { resolution: 'unresolved' }
  }

  if (locator.refKind === 'display') {
    const candidates = lookup.byDisplayId.get(locator.ref.toLowerCase()) ?? []
    if (candidates.length === 1) return candidates[0]
    if (candidates.length > 1) return { resolution: 'ambiguous' }
    return { resolution: 'unresolved' }
  }

  if (looksLikeCanonicalTaskId(locator.ref)) {
    return lookup.byId.get(locator.ref) ?? { resolution: 'unresolved' }
  }

  const candidates = lookup.byDisplayId.get(locator.ref.toLowerCase()) ?? []
  if (candidates.length === 1) return candidates[0]
  if (candidates.length > 1) return { resolution: 'ambiguous' }
  return { resolution: 'unresolved' }
}
```

Matching rule for `getTaskActivity(teamName, taskId)`:
- target matching should primarily compare against canonical `taskId`
- if a link only has display-form identity, resolve it through the task lookup first
- do not compare raw strings only
- do not guess by display id when the lookup returns more than one candidate
- do not drop a row solely because the target resolves to `deleted` or `unresolved`

Suggested actor-resolution helper:

```ts
function resolveActivityActor(rawMessage: RawTaskActivityMessage): {
  memberName?: string
  role: 'member' | 'lead' | 'unknown'
  sessionId: string
  agentId?: string
} {
  if (rawMessage.agentName && rawMessage.agentName.trim().length > 0) {
    return {
      memberName: rawMessage.agentName.trim(),
      role: rawMessage.isSidechain ? 'member' : 'lead',
      sessionId: rawMessage.sessionId,
      agentId: rawMessage.agentId,
    }
  }
  return {
    memberName: undefined,
    role: rawMessage.isSidechain ? 'member' : 'unknown',
    sessionId: rawMessage.sessionId,
    agentId: rawMessage.agentId,
  }
}
```

Actor-resolution rule:
- prefer explicit `agentName` from the raw transcript entry
- use `isSidechain` only as a fallback hint for `role`
- do not infer actor identity from task ownership or task history

Stable ordering rule:
- sort final `BoardTaskActivityEntry[]` by `timestamp ASC`
- tie-break by `rawMessage.filePath`
- then by `rawMessage.sourceOrder ASC`
- then by `action.toolUseId ?? ''`
- then by `id`

This keeps the feed deterministic when multiple entries share the same timestamp or come from the
same transcript message.

#### 4. Dedicated service, not legacy finder reuse

Files:
- `src/main/services/team/taskLogs/activity/BoardTaskActivityService.ts`
- `src/main/services/team/taskLogs/legacy/LegacyExecutionSessionsService.ts`
- `src/main/services/team/taskLogs/discovery/TeamTranscriptSourceLocator.ts`

Suggested `BoardTaskActivityService` dependencies:
- `TeamTranscriptSourceLocator`
- `TeamTaskReader`
- `BoardTaskActivityTranscriptReader`

Suggested API:

```ts
class BoardTaskActivityService {
  async getTaskActivity(teamName: string, taskId: string): Promise<BoardTaskActivityEntry[]>
}
```

Concrete rule:
- new service reads explicit links only
- it must not call `findLogsForTask(...)` for inference
- legacy block keeps using `TeamMemberLogsFinder`
- task lookup for builder resolution should load both:
  - `TeamTaskReader.getTasks(teamName)`
  - `TeamTaskReader.getDeletedTasks(teamName)`
- deleted tasks are part of history resolution, not an optional nice-to-have

Concrete discovery rule:
- do not make `BoardTaskActivityService` depend on `TeamMemberLogsFinder`
- extract a small shared locator for:
  - resolving `projectDir`
  - current `leadSessionId`
  - `sessionIds`
  - enumerating lead and subagent transcript files
- let the new explicit path depend on that lower-level discovery boundary directly

Why:
- `TeamMemberLogsFinder` is session-centric and attribution-heavy
- the new explicit activity path does not need member-attribution heuristics
- depending on the old finder would reintroduce the mixed-responsibility boundary we are trying to remove

Suggested transcript-source locator shape:

```ts
type TeamTranscriptSourceContext = {
  projectDir: string
  leadSessionId?: string
  sessionIds: string[]
}

class TeamTranscriptSourceLocator {
  async getContext(teamName: string): Promise<TeamTranscriptSourceContext | null> { ... }

  async listTranscriptFiles(teamName: string): Promise<string[]> {
    const context = await this.getContext(teamName)
    if (!context) return []

    const files = new Set<string>()
    if (context.leadSessionId) {
      files.add(path.join(context.projectDir, `${context.leadSessionId}.jsonl`))
    }
    for (const sessionId of context.sessionIds) {
      const dir = path.join(context.projectDir, sessionId, 'subagents')
      for (const file of await safeListAgentJsonlFiles(dir)) {
        files.add(path.join(dir, file))
      }
    }
    return [...files].sort()
  }
}
```

`safeListAgentJsonlFiles(...)` should mirror the existing subagent-file rules:
- include `agent-*.jsonl`
- exclude `agent-acompact*`

Recommended main-process wiring:

```ts
// src/main/index.ts
const teamTranscriptSourceLocator = new TeamTranscriptSourceLocator()
const taskActivityTranscriptReader = new BoardTaskActivityTranscriptReader()
const taskActivityService = new BoardTaskActivityService(
  teamTranscriptSourceLocator,
  new TeamTaskReader(),
  taskActivityTranscriptReader,
)
```

Then thread the service through IPC bootstrap:

```ts
// src/main/ipc/handlers.ts
export function initializeIpcHandlers(
  registry: ServiceContextRegistry,
  updater: UpdaterService,
  sshManager: SshConnectionManager,
  teamDataService: TeamDataService,
  teamProvisioningService: TeamProvisioningService,
  teamMemberLogsFinder: TeamMemberLogsFinder,
  memberStatsComputer: MemberStatsComputer,
  teammateToolTracker: TeammateToolTracker | undefined,
  branchStatusService: BranchStatusService | undefined,
  taskActivityService: BoardTaskActivityService | undefined,
  ...
): void {
  initializeTeamHandlers(
    teamDataService,
    teamProvisioningService,
    teamMemberLogsFinder,
    memberStatsComputer,
    teamBackupService,
    teammateToolTracker,
    branchStatusService,
    taskActivityService,
  )
}
```

```ts
// src/main/index.ts
initializeIpcHandlers(
  registry,
  updater,
  sshManager,
  teamDataService,
  teamProvisioningService,
  teamMemberLogsFinder,
  memberStatsComputer,
  teammateToolTracker,
  branchStatusService,
  taskActivityService,
  ...
)
```

Service export note:
- if `initializeIpcHandlers(...)` in `src/main/ipc/handlers.ts` continues importing service types from
  `../services`, add the new service export to:
  - `src/main/services/team/index.ts`
  - `src/main/services/index.ts`
- if you decide to import the new service type directly in `handlers.ts`, keep that decision local and
  do not mix both import styles in the same patch

```ts
// src/main/ipc/teams.ts
let taskActivityService: BoardTaskActivityService | null = null

export function initializeTeamHandlers(
  service: TeamDataService,
  provisioningService: TeamProvisioningService,
  logsFinder?: TeamMemberLogsFinder,
  statsComputer?: MemberStatsComputer,
  backupService?: TeamBackupService,
  toolTracker?: TeammateToolTracker,
  branchTracker?: BranchStatusService,
  activityService?: BoardTaskActivityService,
): void {
  ...
  taskActivityService = activityService ?? null
}
```

```ts
function getTaskActivityService(): BoardTaskActivityService {
  if (!taskActivityService) {
    throw new Error('Task activity service is not initialized')
  }
  return taskActivityService
}
```

This keeps the new explicit path as a first-class service instead of constructing it ad hoc inside
the IPC handler.

#### 5. Implementation checkpoints before CP1

These checks should happen before writing feature code.

1. Resolve the real runtime owner for `Message` / `UserMessage` / `AssistantMessage`
   - `src/utils/messages.ts` imports from `../types/message.js`
   - the physical source file is not obvious from the current tree walk
   - do not start patching helper signatures until the actual symbol owner is confirmed
   - if necessary, use editor "Go to Definition" or TypeScript resolution tooling instead of guessing

2. Enumerate every transcript-visible yield path in `src/query.ts`
   - tool result updates
   - assistant conversational updates
   - synthetic missing tool-result recovery
   - any other user/assistant message path that lands in transcript storage
   - confirm all of them route through the planned annotation helper before enabling the feature

3. Verify split/normalize paths in `src/utils/messages.ts`
   - assistant split path must not duplicate ambient execution links onto every child
   - thinking-only children must not inherit task metadata
   - user tool-result children must retain only the links/actions that match the child block's `tool_use_id`

4. Verify transcript discovery assumptions in `claude_team`
   - `TeamTranscriptSourceLocator` should reuse the same lead/subagent file discovery rules as the legacy path
   - subagent transcript enumeration must exclude `agent-acompact*`
   - the first slice should not depend on worker-thread plumbing

If any of these checks fail, stop and correct the plan before code changes continue.

#### 6. IPC / preload / browser fallback

Files:
- `src/preload/constants/ipcChannels.ts`
- `src/shared/types/api.ts`
- `src/preload/index.ts`
- `src/main/ipc/teams.ts`
- `src/main/ipc/handlers.ts`
- `src/renderer/api/httpClient.ts`

Add:

```ts
export const TEAM_GET_TASK_ACTIVITY = 'team:getTaskActivity'
```

Shared API:

```ts
getTaskActivity: (teamName: string, taskId: string) => Promise<BoardTaskActivityEntry[]>
```

Main handler shape in `teams.ts`:

```ts
async function handleGetTaskActivity(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown,
): Promise<IpcResult<BoardTaskActivityEntry[]>> { ... }
```

Recommended first-slice handler:

```ts
async function handleGetTaskActivity(
  _event: IpcMainInvokeEvent,
  teamName: unknown,
  taskId: unknown,
): Promise<IpcResult<BoardTaskActivityEntry[]>> {
  const vTeam = validateTeamName(teamName)
  if (!vTeam.valid) {
    return { success: false, error: vTeam.error ?? 'Invalid teamName' }
  }
  const vTask = validateTaskId(taskId)
  if (!vTask.valid) {
    return { success: false, error: vTask.error ?? 'Invalid taskId' }
  }
  return wrapTeamHandler('getTaskActivity', () =>
    getTaskActivityService().getTaskActivity(vTeam.value!, vTask.value!),
  )
}
```

Recommended preload addition:

```ts
getTaskActivity: async (teamName: string, taskId: string) => {
  return invokeIpcWithResult<BoardTaskActivityEntry[]>(
    TEAM_GET_TASK_ACTIVITY,
    teamName,
    taskId,
  )
}
```

Important integration detail:
- `initializeTeamHandlers(...)` should receive the new service or create/store it next to existing
  `teamMemberLogsFinder`
- `registerTeamHandlers(...)` should register `TEAM_GET_TASK_ACTIVITY`
- `removeTeamHandlers(...)` should unregister it

Concrete handler registration:

```ts
// registerTeamHandlers(...)
ipcMain.handle(TEAM_GET_TASK_ACTIVITY, handleGetTaskActivity)
```

```ts
// removeTeamHandlers(...)
ipcMain.removeHandler(TEAM_GET_TASK_ACTIVITY)
```

Browser fallback in `HttpAPIClient` can mirror current task-log behavior:

```ts
getTaskActivity: async () => {
  console.warn('[HttpAPIClient] getTaskActivity is not available in browser mode')
  return []
}
```

#### 7. UI composition

Files:
- `src/renderer/components/team/dialogs/TaskDetailDialog.tsx`
- `src/renderer/components/team/taskLogs/TaskLogsPanel.tsx`
- `src/renderer/components/team/taskLogs/TaskActivitySection.tsx`
- `src/renderer/components/team/taskLogs/ExecutionSessionsSection.tsx`

Concrete change in `TaskDetailDialog.tsx`:
- replace direct inline `MemberLogsTab` block with `TaskLogsPanel`

Pseudo-shape:

```tsx
<TaskLogsPanel
  teamName={teamName}
  task={currentTask}
  taskSince={taskSince}
  allowLeadExecutionPreview={allowLeadExecutionPreview}
  isLeadOwnedTask={isLeadOwnedTask}
/>
```

`TaskLogsPanel` should internally render:
- `TaskActivitySection`
- `ExecutionSessionsSection`

`ExecutionSessionsSection` should be a thin wrapper around the current `MemberLogsTab` props so the
legacy block keeps its existing behavior and polling indicators.

UI state rule:
- `TaskActivitySection` should own its own loading and empty states
- `ExecutionSessionsSection` should keep the current refreshing and online indicators
- do not reuse `ExecutionSessionsSection` polling state as the header status for the whole `Task Logs` panel
- fetch `Task Activity` and `Execution Sessions` independently so one slow path does not block the other

Suggested panel skeleton:

```tsx
export function TaskLogsPanel(props: {
  teamName: string
  task: TeamTask
  taskSince?: string
  allowLeadExecutionPreview?: boolean
  isLeadOwnedTask?: boolean
}): React.JSX.Element {
  const { teamName, task, taskSince, allowLeadExecutionPreview, isLeadOwnedTask } = props

  return (
    <div className="min-w-0 space-y-3">
      <TaskActivitySection teamName={teamName} taskId={task.id} />
      <ExecutionSessionsSection
        teamName={teamName}
        taskId={task.id}
        taskOwner={task.owner}
        taskStatus={task.status}
        taskWorkIntervals={task.workIntervals}
        taskSince={taskSince}
        allowLeadExecutionPreview={allowLeadExecutionPreview}
        isLeadOwnedTask={isLeadOwnedTask}
      />
    </div>
  )
}
```

Suggested `TaskActivitySection` fetch shape:

```tsx
const [entries, setEntries] = useState<BoardTaskActivityEntry[] | null>(null)
const [error, setError] = useState<string | null>(null)

useEffect(() => {
  let cancelled = false
  setError(null)
  setEntries(null)
  void api.teams
    .getTaskActivity(teamName, taskId)
    .then(result => {
      if (!cancelled) setEntries(result)
    })
    .catch(err => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err))
    })
  return () => {
    cancelled = true
  }
}, [teamName, taskId])
```

#### 8. Recommended tests

`agent_teams_orchestrator`
- interpreter unit tests for each board tool family
- reducer tests for open/close/ambiguous transitions
- observer tests for:
  - single `tool_result`
  - multiple `tool_result` blocks in one message
  - ambient execution stamp
  - duplicate `toolUseId` no-op

`claude_team`
- transcript reader tests for additive contract parsing
- builder tests for:
  - same-task execution
  - external board action
  - lifecycle with pre-event actor context
  - `task_link` / `task_unlink` with derived `peerTask`
  - display-id collision resolves to `ambiguous`, not first-match
  - deleted peer task still renders a row with `resolution = 'deleted'`
  - unresolved locator still renders fallback row without navigation
- UI tests for:
  - empty explicit activity + legacy sessions still visible
  - `Task Activity` and `Execution Sessions` separated
  - deleted or unresolved peer-task rows are visibly non-primary / non-navigable

#### 9. Runtime diagnostics

Add lightweight counters or debug logs around the new explicit path.

Minimum writer-side diagnostics:
- `board_task_activity.tool_result_paired`
- `board_task_activity.tool_result_unpaired`
- `board_task_activity.synthetic_tool_result_skipped`
- `board_task_activity.lifecycle_emitted`
- `board_task_activity.lifecycle_skipped_unsuccessful`
- `board_task_activity.ambient_execution_emitted`
- `board_task_activity.ambient_execution_skipped_ambiguous`

Minimum read-side diagnostics:
- `board_task_activity.link_parse_dropped`
- `board_task_activity.action_parse_dropped`
- `board_task_activity.duplicate_action_tool_use_id`
- `board_task_activity.unresolved_locator`
- `board_task_activity.ambiguous_locator`

Rules:
- keep diagnostics low-cardinality
- never log full comment text, review prose, or arbitrary tool payloads
- prefer counts and short identifiers over verbose blobs
- debug logging is enough for v1 if metrics plumbing would slow the rollout, but the hook points
  should still be explicit in code

---

## Rollout Plan

### CP0 - contract and names are fixed

- finalize `BoardTaskLinkV1`
- finalize `BoardTaskToolActionV1`
- finalize `toolUseId` join rules for links and actions
- finalize the tool semantics table derived from `agent-teams-controller/src/mcpToolCatalog.js`
- finalize naming across runtime contract, read model, and renderer
- add JSON schema and fixture examples

Pre-flight verification gate before leaving CP0:
- confirm the runtime message type owner path used by `src/utils/messages.ts`
- confirm the final transcript-discovery class name is `TeamTranscriptSourceLocator`
- confirm `query.ts` annotate coverage list is complete

### Rollout safety switches

Keep the feature decomposed behind separate flags or equivalent runtime gates:
- `boardTaskLinksWriteEnabled`
  - enables writer-side transcript stamping only
- `boardTaskActivityReadEnabled`
  - enables the new `getTaskActivity(...)` read path only
- `boardTaskActivityUiEnabled`
  - enables the `Task Activity` subsection in the popup only

Recommended staged activation:
1. writer flag on in local/dev only
2. read flag on after explicit transcripts are verified
3. UI flag on after read-side QA passes

Kill-switch rule:
- any serious mismatch in transcript stamping should be recoverable by disabling only the write flag
  without removing legacy `Execution Sessions`
- any read-side performance or parsing issue should be recoverable by disabling only the read/UI flag
  while keeping persisted transcripts intact
- do not make rollout depend on a single all-or-nothing switch

Shadow validation phase:
- before exposing the new UI section broadly, run the writer + reader path in shadow mode
- in shadow mode:
  - write explicit transcript metadata
  - build activity entries in the background or in targeted debug sessions
  - compare obvious invariants:
    - task activity rows exist for fresh lifecycle events
    - no duplicate action rows per `toolUseId`
    - no lifecycle rows emitted from synthetic interrupt tool results
  - keep the user-facing UI hidden until these checks are stable

### CP1 - writer-side explicit links

- add `boardTaskLinks?: BoardTaskLinkV1[]` to transcript messages
- add `boardTaskToolActions?: BoardTaskToolActionV1[]` to transcript messages where applicable
- implement runtime tool inspection
- implement actor execution state
- stamp only explicit/safe links

### CP2 - read-side activity feed

- parse explicit transcript task metadata in `claude_team`
- build `BoardTaskActivityEntry`
- expose `getTaskActivity(teamName, taskId)`
- keep `getLogsForTask(...)` unchanged for the legacy block

Do not block the first slice on worker-thread support for the new feed.

Do not route the new explicit activity query through the existing `getLogsForTask(...)` worker and
fallback path. Keep it as a separate read path in v1 so the explicit model stays isolated from the
legacy heuristic/session pipeline.

If profiling later shows that explicit-link scanning is still expensive, add worker support as a
follow-up slice instead of mixing that concern into the first correctness rollout.

### CP3 - UI integration

- replace direct `MemberLogsTab` usage in task popup with a composed panel
- outer title: `Task Logs`
- `Task Activity`
- `Execution Sessions`

### CP4 - display policy tuning

- map semantic activity entries to renderer labels/badges
- mute noisy read actions like `task_get`, especially same-task reads
- improve labels for lifecycle and cross-task actions
- add manual QA on real team sessions

---

## Definition of Done

- Task popup shows **two clearly separated sections**:
  - `Task Activity`
  - `Execution Sessions`
- A task can show actions from a different actor working on another task, without mislabeling them as execution of the target task
- Review actions appear correctly in task activity
- Multi-target tools can link to multiple tasks
- Ambiguous actor state never triggers guessing
- Existing execution-session viewing still works
- Old logs remain readable
- New logs gain explicit structural task linkage
- Locator collisions never silently pick an arbitrary task
- Deleted or unresolved peer tasks do not disappear from task activity history
- `pnpm typecheck` passes in affected repos
- targeted tests pass for:
  - lifecycle events
  - direct board actions
  - other-active-task actor actions
  - review flow
  - multi-target tools
  - ambiguous actor state
  - explicit-link-only feed behavior in v1
  - unmatched `tool_result` blocks do not create guessed links
  - synthetic interrupt tool results do not create lifecycle rows

---

## Top 3 Remaining Implementation Risks

- **1. Carrier propagation drift in `agent_teams_orchestrator`** - `🎯 9   🛡️ 8   🧠 8` - roughly `180-320` lines of careful edits.
  Risk:
  one message path in `src/utils/messages.ts` or `src/query.ts` forgets to keep or filter `boardTaskLinks` / `boardTaskToolActions`, which creates silent gaps or duplication.

- **2. Partial annotate coverage in `src/query.ts`** - `🎯 8   🛡️ 8   🧠 7` - roughly `120-220` lines.
  Risk:
  only tool-result updates go through `emitTaskAware(...)`, while other transcript-visible assistant or user yields bypass the helper and lose ambient execution links.

- **3. Read-side overcoupling to legacy discovery** - `🎯 9   🛡️ 9   🧠 5` - roughly `80-160` lines.
  Risk:
  the new explicit feed accidentally reuses `TeamMemberLogsFinder` logic and reintroduces heuristic/session coupling. Keeping `TeamTranscriptSourceLocator` separate avoids this.

---

## Manual QA Checklist

- Start task A, produce normal execution logs - activity shows execution entries for A
- While on task A, comment on task B - task B shows related board action, task A does not lose execution state
- Request review on task A - task A shows board action
- Start review on task A - task A shows lifecycle review event
- Approve or request changes on task A - task A shows lifecycle completion event
- Link task A to task B - both task activity feeds reflect the relationship action appropriately
- Change owner / status / clarification on task A - task activity row renders without parsing free-text result output
- Open a historical task without explicit links - legacy execution sessions still load

---

## Final Architectural Summary

We are explicitly separating:

- **runtime truth** - `boardTaskLinks[]` + `boardTaskToolActions[]`
- **UI activity model** - `BoardTaskActivityEntry`
- **legacy session browsing** - `Execution Sessions`

This avoids:
- overloading one contract with UI concerns
- overloading one UI block with two different meanings
- growing the old heuristic session finder into an even larger mixed-responsibility module

This is the cleanest path that is:
- reliable
- understandable
- scalable
- compatible with the current codebase
