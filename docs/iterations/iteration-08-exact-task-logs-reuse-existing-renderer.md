# Iteration 08 - Exact Task Logs Reusing Existing Execution Renderer

> Historical note
> This document captures the planned scope and architecture at iteration time.
> It is not the source of truth for the final runtime contract.

This iteration adds a new **Exact Task Logs** subsection under task logs and intentionally reuses the existing execution-log renderer that already works well in the app.

The goal is **not** to invent a new log UI.

The real problem was never the renderer. The real problem was that the old task log discovery path was:
- session-centric
- heuristic-heavy
- not strict enough about what truly belongs to a task

The new explicit board-task linkage from iteration 07 already solved the **selection** problem.
This iteration uses that explicit linkage to feed a **task-scoped transcript slice** into the existing execution renderer.

That means:
- keep `Task Activity` as the compact, explicit summary feed
- add `Exact Task Logs` that visually looks like the current rich logs/execution cards
- keep `Execution Sessions` as a separate legacy/session-centric block

---

## Decision Record

### Top 3 options

1. **Reuse the existing execution renderer, but feed it a new explicit task-scoped filtered message slice** - `🎯 10   🛡️ 9   🧠 6` - примерно `550-950` строк  
   This is the chosen direction.

2. **Keep `Task Activity` only as summary, and add inline tool-details drawers per row** - `🎯 8   🛡️ 9   🧠 5` - примерно `350-650` строк  
   Simpler, but still not the same browsing experience the user already likes.

3. **Build a new custom task log renderer from scratch** - `🎯 3   🛡️ 5   🧠 9` - примерно `900-1600` строк  
   Rejected. This is a bicycle. It is slower, riskier, and likely worse than the existing renderer.

### Chosen direction

- Keep `Task Activity` as the compact explicit summary
- Add `Exact Task Logs`
- Render `Exact Task Logs` using the same existing execution-log rendering pipeline
- Build a new explicit task-scoped message-selection layer
- Reuse renderer primitives only, not legacy session-browsing containers
- Do **not** reuse the old heuristic session-finding logic as the source of truth

### Why this is the right direction

- The renderer already solves:
  - tool call cards
  - tool-result pairing
  - text output display
  - expandable items
  - ordering and visual hierarchy
- The existing UX is already liked by the user
- Reusing the renderer lowers design risk
- The new explicit metadata gives us a reliable source for task scoping

The correct architecture is:
- **reuse the renderer**
- **replace the selection logic**

Not:
- reuse the old selection logic
- or rewrite the renderer

---

## Core UX Goal

Inside the task popup:

1. `Task Activity`
   - short explicit summary rows
   - compact semantic view

2. `Exact Task Logs`
   - rich task-scoped transcript rendering
   - same visual style as the current logs/execution UI
   - exact tools, outputs, and grouped items

3. `Execution Sessions`
   - current legacy/session-centric browser
   - still useful for exploration
   - no longer treated as the primary truth for task scoping

This gives users:
- a fast summary
- exact readable logs
- a fallback exploration view

---

## Important Clarification: Which Renderer We Actually Reuse

The correct renderer to reuse is **not** `CliLogsRichView`.

`CliLogsRichView` is for:
- stream-json CLI tails
- provisioning / live runtime logs

It expects a different source model.

The renderer path that matches the desired UX in task/session views is:

- `MemberExecutionLog`
- `transformChunksToConversation(...)`
- `enhanceAIGroup(...)`
- `DisplayItemList`
- `LastOutputDisplay`

That is the execution/session renderer family the user is referring to.

So the plan is:
- **reuse the execution renderer path**
- **not** the CLI stream-json renderer path

---

## Main Architectural Insight

The new exact log view must reuse the old renderer **without reintroducing old selection bugs**.

That means we cannot simply:
- ask `TeamMemberLogsFinder` for sessions
- reuse `MemberLogsTab`
- or render whole sessions again

We also should **not** blindly render entire AI response groups from the transcript.

Why:
- the same AI response can contain both relevant and unrelated tools
- if we render the entire unfiltered group, we leak unrelated actions back into the task view
- that would partially recreate the same problem we just solved

So the right architecture is:

1. Find exact task-linked source refs using explicit metadata
2. Resolve those refs into message-level anchors
3. Build a **filtered transcript slice** that contains only task-relevant messages/blocks
4. Convert that filtered slice into `EnhancedChunk[]`
5. Render with the existing execution renderer

The renderer stays the same.
The message-selection layer becomes explicit and strict.

---

## Scope

### Goals

- Add `Exact Task Logs` under `Task Logs`
- Reuse the current execution renderer style
- Build exact logs only from explicit task-linked transcript metadata
- Support:
  - board-task tools
  - lifecycle rows
  - explicit board actions
  - ambient execution text/output already linked to the task
- Avoid showing unrelated tools from the same session/AI response

### Non-Goals

- Replacing `Task Activity`
- Deleting `Execution Sessions`
- Retroactively fixing all historical logs without explicit metadata
- Reusing heuristic session overlap as primary selection
- Building a brand-new renderer

---

## Key Product Rules

### Rule 1 - `Task Activity` stays

`Task Activity` remains the compact summary feed.

It is still valuable because:
- it is fast to scan
- it shows actor/task relation cleanly
- it keeps the event-level summary readable

### Rule 2 - `Exact Task Logs` is the readable drill-down

`Exact Task Logs` is where users read the actual tool/output flow.

It should look and feel like the existing execution/log UI.

### Rule 3 - `Execution Sessions` remains legacy

`Execution Sessions` still exists because:
- it is useful for broad exploration
- it has previews and session browsing
- it can still show context the exact feed intentionally omits

But it is no longer the primary source for task scoping.

---

## Naming Decisions

### UI names

Use:

- outer section: `Task Logs`
- subsection 1: `Task Activity`
- subsection 2: `Exact Task Logs`
- subsection 3: `Execution Sessions`

This naming is explicit and easy to understand:
- summary
- exact logs
- session browser

### Service names

Use:

- `BoardTaskActivityRecordSource`
- `BoardTaskExactLogsService`
- `BoardTaskExactLogSummarySelector`
- `BoardTaskExactLogDetailSelector`
- `BoardTaskExactLogChunkBuilder`

### Shared DTO names

Use:

- `BoardTaskExactLogSummary`
- `BoardTaskExactLogDetail`
- `BoardTaskExactLogActor`
- `BoardTaskExactLogSource`

### Why this naming

- `Exact Task Logs` is user-facing and immediately understandable
- `BoardTaskActivityRecordSource` is more honest than `...Service` because this layer only supplies internal records
- `BoardTaskExactLogsService` is specific enough to avoid mixing with legacy task logs
- `Summary` + `Detail` is better than a single eager `Bundle` DTO because the renderer should load heavy exact details lazily

---

## Layered Design

This slice must preserve separation of concerns.

### 1. Explicit activity source layer

Responsibility:
- read explicit task-linked transcript metadata
- produce internal task activity records

Suggested main-only type:

```ts
type BoardTaskActivityRecord = {
  timestamp: string
  task: {
    locator: BoardTaskLocator
    resolution: 'resolved' | 'deleted' | 'unresolved' | 'ambiguous'
    taskId?: string
    displayId?: string
  }
  linkKind: 'execution' | 'lifecycle' | 'board_action'
  targetRole: 'subject' | 'related'
  actor: {
    memberName?: string
    role: 'member' | 'lead' | 'unknown'
    sessionId: string
    agentId?: string
    isSidechain: boolean
  }
  actorContext: {
    relation: 'same_task' | 'other_active_task' | 'idle' | 'ambiguous'
    activeTask?: BoardTaskLocator
    activePhase?: 'work' | 'review'
    activeExecutionSeq?: number
  }
  action?: ParsedBoardTaskToolAction
  source: {
    filePath: string
    messageUuid: string
    toolUseId?: string
    sourceOrder: number
  }
}
```

This is **main-only** and not an IPC DTO.

Why this shape is better than `taskId: string`:

- it preserves unresolved and deleted states
- it avoids forcing early loss of locator semantics
- it lets both summary and exact-log readers consume the same lower-level record source

### 2. Exact-log summary selection layer

Responsibility:
- start from explicit activity records
- build lightweight exact-log summaries
- never parse transcript messages

This is the most important new layer in iteration 08 because it keeps initial popup load cheap and removes transcript parsing from the summary path entirely.

### 3. Exact-log detail selection layer

Responsibility:
- start from one summary + explicit activity records
- parse only the referenced transcript messages
- build one filtered task-scoped message slice for one requested exact detail

### 4. Chunk-building layer

Responsibility:
- turn the filtered message slice into `EnhancedChunk[]`
- keep the existing execution renderer happy

### 5. UI rendering layer

Responsibility:
- render exact bundle details with the current execution renderer
- not decide task membership

---

## Why We Need an Internal Record Layer First

It is tempting to let `BoardTaskExactLogsService` depend directly on `BoardTaskActivityEntry`.

That would be simpler in the short term, but it is the wrong dependency direction.

`BoardTaskActivityEntry` is a shared UI-facing DTO.
`Exact Task Logs` needs a lower-level source model.

So the better architecture is:

- `BoardTaskActivityRecordSource`
  - main-only
  - internal source of explicit task-linked facts

- `BoardTaskActivityService`
  - maps records -> `BoardTaskActivityEntry`

- `BoardTaskExactLogsService`
  - maps records -> lightweight exact-log summaries

- `BoardTaskExactLogDetailService`
  - maps one exact summary + parsed transcript -> one renderable exact detail

This avoids coupling a new main-side service to a renderer DTO.

This is a strong SRP / DIP move and worth doing now.

### Critical reuse boundary

The new exact path must **not** introduce a second competing low-level reader for board-task transcript metadata.

That means:

- `BoardTaskActivityTranscriptReader` remains the single owner of:
  - `boardTaskLinks[]` parsing
  - `boardTaskToolActions[]` parsing
  - file-level metadata parse caching for explicit board-task transcript metadata
- `BoardTaskActivityRecordSource` is extracted from the current summary path and becomes the single owner of:
  - transcript metadata discovery
  - task lookup and target-task filtering
  - resolved internal activity records
- all of:
  - `BoardTaskActivityService`
  - `BoardTaskExactLogsService`
  - `BoardTaskExactLogDetailService`
  depend on the same `BoardTaskActivityRecordSource`

This is the desired dependency graph:

```ts
BoardTaskActivityTranscriptReader
  -> BoardTaskActivityRecordSource
    -> BoardTaskActivityService
    -> BoardTaskExactLogsService
    -> BoardTaskExactLogDetailService
```

This is explicitly **not** the desired graph:

```ts
BoardTaskActivityTranscriptReader -> BoardTaskActivityService
parseBoardTaskLinks again elsewhere  -> BoardTaskExactLogsService
```

Why this matters:

- summary and exact views must agree on what explicit task-linked records exist
- task-resolution behavior must not drift between two separate low-level readers
- metadata parsing bugs must be fixed once
- caches should stay shared where possible

So iteration 08 should extract and reuse the existing explicit-record path.
It should not create another parallel JSONL-metadata reader just for exact logs.

---

## Data Flow

### End-to-end flow

1. Renderer asks for exact task logs:

```ts
api.teams.getTaskExactLogSummaries(teamName, taskId)
```

2. IPC calls:

```ts
BoardTaskExactLogsService.getTaskExactLogSummaries(teamName, taskId)
```

3. Service gets:
- active + deleted tasks from `TeamTaskReader`
- activity records from `BoardTaskActivityRecordSource`

4. Service derives exact-log summaries **from activity records only**

5. Renderer shows exact-log summary cards first

6. On expand, renderer asks for one exact detail:

```ts
api.teams.getTaskExactLogDetail(teamName, taskId, exactLogId, sourceGeneration)
```

7. Detail service:
- reloads the matching explicit summary anchor
- derives the minimal referenced file set for that one summary
- parses only those transcript files into strict `ParsedMessage[]`
- builds one filtered bundle slice
- converts it into `EnhancedChunk[]`

8. Renderer reuses `MemberExecutionLog`

---

## New Shared DTOs

### IPC DTOs

```ts
type BoardTaskExactLogActor = {
  memberName?: string
  role: 'member' | 'lead' | 'unknown'
  sessionId: string
  agentId?: string
  isSidechain: boolean
}

type BoardTaskExactLogSource = {
  filePath: string
  messageUuid: string
  toolUseId?: string
  sourceOrder: number
}

type BoardTaskExactLogSummary =
  {
    id: string
    timestamp: string
    actor: BoardTaskExactLogActor
    source: BoardTaskExactLogSource
    linkKinds: ('execution' | 'lifecycle' | 'board_action')[]
  } & (
    | { canLoadDetail: true; sourceGeneration: string }
    | { canLoadDetail: false }
  )

type BoardTaskExactLogDetail = {
  id: string
  chunks: EnhancedChunk[]
}
```

### Why summaries + lazy detail is the safer v1 design

Repo-local finding:

- `Execution Sessions` already uses a lazy expand-to-load-details interaction model
- `EnhancedChunk[]` is an accepted IPC shape in this app
- but returning `EnhancedChunk[]` eagerly for every exact bundle would be materially heavier than the current execution-session path

So the safer v1 direction is:

- initial load -> lightweight `BoardTaskExactLogSummary[]`
- expand one row -> fetch one `BoardTaskExactLogDetail`

This keeps:

- initial popup payload smaller
- refresh cost lower
- parity with the existing interaction model the user already likes

### Why `canLoadDetail` is better than `hasRenderableDetail`

Summary stage no longer parses transcript content.

That is a feature, not a limitation:

- it keeps summary load cheap
- it prevents summary-stage parser drift
- it avoids lying with overconfident renderability claims

So the summary flag should be capability-oriented:

- `canLoadDetail = true` means the app has enough explicit anchor/source information to attempt detail loading
- it does **not** guarantee that strict detail reconstruction will succeed
- if `canLoadDetail = false`, the summary must not carry a meaningless `sourceGeneration`

If detail later fails because the transcript row is malformed or missing, returning `missing` is still correct.

### Source-generation coherence contract

Lazy summaries + detail introduce one real risk:

- summaries are loaded at time `T1`
- transcript files change
- detail is requested at time `T2`
- the same `exactLogId` may now refer to a different filtered slice or to nothing at all

So exact logs need an explicit coherence token.

Preferred response shape:

```ts
type BoardTaskExactLogSummariesResponse = {
  items: BoardTaskExactLogSummary[]
}
```

Preferred detail result shape:

```ts
type BoardTaskExactLogDetailResult =
  | { status: 'ok'; detail: BoardTaskExactLogDetail }
  | { status: 'stale' }
  | { status: 'missing' }
```

Why this is better than `null`:

- renderer can distinguish stale summary data from a genuinely missing bundle
- UI can refresh summaries automatically on `stale`
- debugging is easier than with a single ambiguous nullish path

### Why `sourceGeneration` belongs on each summary, not on the whole response

Earlier drafts used one response-level generation token for the whole task.
That is weaker.

Why:

- exact detail is loaded one bundle at a time
- one task can reference many transcript files
- one unrelated file mutation should not stale every open summary card

So the safer contract is:

- each `BoardTaskExactLogSummary` carries its own `sourceGeneration`
- detail validates against that per-summary generation
- the summaries response does not need a single coarse global generation token in v1

This narrows stale invalidation to the actual files that back one summary.

### Why not reuse global `TeamLogSourceTracker.logSourceGeneration` directly

Repo-local finding:

- `TeamLogSourceTracker` already computes a broad project-level `logSourceGeneration`
- that generation changes for any tracked transcript source movement

That pattern is useful, but it is too broad as the primary exact-log coherence token.

If exact logs reuse the global generation directly, then:

- an unrelated transcript file change can invalidate all open exact-log details
- exact detail requests become noisier and more frequently stale than necessary

So exact logs should use a **narrower source generation**:

- derive `sourceGeneration` from the exact summary source set used for one requested summary
- typically hash normalized `(filePath, size, mtimeMs)` for the referenced transcript files

### Why `linkKinds` is an array

One exact-log summary/detail can legitimately originate from multiple explicit links that collapse into the same rendered bundle.

Example:
- same tool call produced both `subject` and `related` links
- same transcript message had both an execution link and a board-action link relevant to the target task

The bundle should render once, not duplicate.

### File-local exact-detail boundary

Repo-local finding:

- existing tool/result linking in `SessionParser`, `ToolExecutionBuilder`, and the execution renderer pipeline works over one provided message slice
- bundle identity already includes `filePath`
- `MemberExecutionLog` itself only consumes `EnhancedChunk[]` and a display `memberName`

So v1 should keep a strict boundary:

- one exact summary belongs to one transcript file
- one exact detail request parses at most that summary's referenced file set
- no cross-file hunt for a missing paired `tool_use` or `tool_result`

This is the safer rule because cross-file pairing would immediately reintroduce guesswork and drift.

If a future transcript shape ever truly requires cross-file pairing, that should be a separate iteration with its own invariants and tests.

---

## Exact Selection Rules

This is the most critical part of the design.

### Principle

Select only what is explicitly attributable to the target task.

Never reintroduce broad session heuristics as the exact-log source.

### Critical anti-bug rule

The selector must work on **explicit source refs first**, and only then read transcript content.

It must never scan a transcript file first and try to rediscover task relevance from nearby content.

### Step 1 - Start from explicit activity records

Only records whose resolved target task matches the requested task are eligible.

### Step 2 - Derive exact message anchors

Each eligible record becomes one anchor candidate.

Suggested internal shape:

```ts
type BoardTaskExactLogAnchor =
  | {
      kind: 'tool'
      filePath: string
      sessionId: string
      toolUseId: string
      sourceMessageUuid: string
    }
  | {
      kind: 'message'
      filePath: string
      sessionId: string
      messageUuid: string
    }
```

### Step 3 - Collapse multiple records into stable bundles

Deduplicate anchors aggressively:

- same `filePath + toolUseId` -> one tool bundle
- same `filePath + messageUuid` -> one message bundle

### Anchor precedence rule

If both anchors exist for the same source:

- tool anchor: `filePath + toolUseId`
- message anchor: `filePath + messageUuid`

then the **tool anchor wins** and the message anchor must not create a second bundle for the same tool execution.

This is required because one task-linked tool result can also carry an explicitly linked message UUID.
Without precedence, the same action can render twice:
- once as a tool bundle
- once as a message bundle

That would be a real regression.

This avoids duplicate rendering when:
- multiple links point to the same tool
- link/unlink emits both subject + related rows
- one activity message contains multiple links for the same target task

### Step 4 - Build summaries from anchors only

Summary stage must stop here.

For each surviving anchor:
- compute stable summary identity
- aggregate `linkKinds`
- derive actor label and source metadata
- compute per-summary `sourceGeneration`
- set `canLoadDetail` conservatively

⚠️ Summary stage must **not** parse transcript content.

That keeps:
- popup open cheaper
- correctness easier to reason about
- stale invalidation scoped to one summary

### Step 5 - Build filtered message slice only on detail request

This is where the old bugs must not come back.

#### For tool bundles

Include only:
- the assistant `tool_use` block with the matching `toolUseId`
- the internal user `tool_result` block with the same `toolUseId`
- explicit assistant text output only when the same assistant message is itself explicitly linked to the task

Do **not** automatically include every other tool in the same AI response.

#### For ambient execution/message bundles

Include only:
- the explicitly linked message itself
- optionally, paired assistant output blocks from the same message if the linked message is assistant content

Do **not** expand to unrelated neighboring transcript messages by default.

### Why this stricter filtering is necessary

If we simply render the whole AI response group, we can leak:
- unrelated board tools
- unrelated read/search tools
- unrelated support actions from the same response

That would make the task logs look rich, but wrong.

Exact logs must be:
- rich
- but still task-scoped

---

## Exact Filtering Strategy

The filtered slice should use **synthetic filtered `ParsedMessage` copies**, not raw original messages unchanged.

That means:
- copy the original message metadata
- keep only the relevant content blocks
- preserve `uuid`, `timestamp`, `requestId`, sidechain flags, session metadata
- drop unrelated blocks

### Critical consistency rule for synthetic messages

After block filtering, derived message fields must be **recomputed**, not blindly copied.

That includes:
- `toolCalls`
- `toolResults`
- `sourceToolUseID`
- `sourceToolAssistantUUID`
- `toolUseResult`

If we keep the original derived fields after dropping unrelated blocks, the renderer can silently reintroduce unrelated tool cards even though the filtered content looked correct.

That is one of the highest-risk implementation mistakes in this iteration.

### Research-backed note: what the renderer actually reads

From the current code:

- assistant-side tool cards are derived primarily from assistant content blocks (`tool_use`)
- internal user tool results are derived primarily from `msg.toolResults`
- `ChunkBuilder` and `SemanticStepExtractor` do **not** rely on exactly the same fields on both sides

Implication:

- assistant filtered messages must preserve correct assistant content blocks
- internal user filtered messages must rebuild `toolResults[]` correctly
- copying stale derived fields is especially dangerous on the internal user side
- `toolUseResult` needs explicit handling because renderer/tool-content helpers use it for richer cards

Suggested helper:

```ts
function filterParsedMessageForTaskAnchor(args: {
  message: ParsedMessage
  anchor: BoardTaskExactLogAnchor
  explicitlyLinkedMessageIds: Set<string>
}): ParsedMessage | null
```

Rules:

- assistant message:
  - keep `tool_use` blocks only when `block.id === anchor.toolUseId`
  - keep `text` blocks only when the message UUID is explicitly linked for the same target task
  - drop unrelated `tool_use` blocks
  - drop unrelated thinking blocks in v1

- internal user message:
  - keep `tool_result` blocks only when `block.tool_use_id === anchor.toolUseId`
  - rebuild `toolResults[]` only for that tool
  - keep `sourceToolUseID` only when it matches
  - keep `sourceToolAssistantUUID` only when the paired assistant message is present in the same bundle
  - keep `toolUseResult` only when it can be proven to belong to the same surviving `toolUseId`
  - if that proof is missing, drop `toolUseResult` instead of risking leaked payload from another tool

- ordinary user/system message:
  - keep only if explicitly linked by `messageUuid`

This preserves correctness and still allows the renderer to work.

### `toolUseResult` preservation policy

Repo-local finding:

- `displayItemBuilder` uses `toolUseResult` while building linked tool items
- `toolContentChecks` uses `toolUseResult` to decide whether richer content exists for read/write/edit-style tools
- `ToolResultExtractor` also treats `toolUseResult` as an alternate result carrier

So `toolUseResult` is not optional sugar.
It can materially affect what the renderer shows.

Safe v1 rule:

- keep `toolUseResult` only when:
  - the filtered internal-user message still points to exactly one surviving `toolUseId`
  - that `toolUseId` matches `sourceToolUseID` or an equivalent explicit enriched field
- otherwise:
  - drop `toolUseResult`

Why this is safer:

- false negatives only degrade richness for one tool card
- false positives can leak payload from a different tool execution into the current exact bundle

For exact task logs, false negative is preferable to false positive.

### Streaming assistant dedupe rule

Another repo-local finding:

- `parseJsonlFile(...)` parses streaming assistant entries as separate `ParsedMessage`s
- `deduplicateByRequestId(...)` exists, but it is not automatically applied by the general renderer pipeline
- if exact logs do nothing, the same assistant response can survive more than once inside one bundle

That can cause:

- duplicated output rows
- duplicated tool-use blocks from intermediate streaming entries
- unstable exact bundles for the same task over time

So the exact-log path must add an explicit dedupe step:

- after synthetic filtering
- before chunk building
- per bundle candidate
- keep only the last surviving assistant message for a given `requestId`

Important:

- do not dedupe across different bundles
- do not dedupe by `requestId` before filtering, because different streaming snapshots may survive differently after block filtering

The safe sequence is:

1. parse strict file-local `ParsedMessage[]`
2. build one filtered synthetic bundle slice
3. dedupe assistant streaming entries by `requestId` inside that slice
4. build chunks from that deduped bundle slice

This should be pinned with tests.

### Strict timestamp and source-fidelity rule

The exact-log path must not become looser than the summary path about malformed transcript rows.

Important repo-local finding:

- the current explicit activity reader already skips rows without a real transcript `timestamp`
- the generic `parseJsonlFile(...)` path currently falls back to `new Date()` when raw transcript `timestamp` is missing

That fallback is acceptable for broad session utilities, but it is **not** acceptable for exact task logs.

If exact logs silently synthesize “now” for malformed transcript rows, we get:

- unstable ordering across reads
- bundles that appear newer than they really are
- drift between `Task Activity` and `Exact Task Logs`

So the exact-log path must use a **strict timestamp policy**:

- missing or malformed raw transcript timestamp -> drop the exact-log row or exact-log message
- never synthesize current time

Preferred implementation direction:

- add a small exact-log-specific strict parser wrapper
- optionally, only if it stays clearly isolated, extend low-level JSONL parsing with an opt-in strict mode used exclusively by exact logs

Rejected shortcut:

- parse with the permissive default path and try to detect synthetic timestamps later

That shortcut is not reliable because the fallback timestamp becomes indistinguishable from a valid parsed timestamp after parsing.

Important repo-local constraint:

- `parseJsonlFile(...)` is used broadly across the app
- changing its default permissive behavior would create unrelated blast radius

So the safer v1 direction is:

- keep the global permissive parser unchanged
- add an exact-log-specific strict wrapper or opt-in exact mode
- contain the stricter behavior inside the exact-log path only

### Classification rule for synthetic filtered messages

The plan relies on the current `MessageClassifier` behavior:

- filtered internal user tool-result messages are still classified into the AI path
- they are not rendered as user bubbles as long as they remain internal/meta user messages

This is good for the chosen design, but it is a dependency that must be pinned with tests.

If this classifier behavior changes later, exact logs can silently degrade.

---

## Chunk Building Strategy

### Chosen direction

Reuse:

- `ChunkBuilder.buildChunks(...)`
- `transformChunksToConversation(...)`
- `enhanceAIGroup(...)`
- `MemberExecutionLog`

### Pre-flight checkpoint

Before coding the bundle builder, confirm with tests that:

- filtered internal user messages still classify into the expected AI path in `MessageClassifier`
- filtered assistant + internal user slices still produce the expected tool cards in `MemberExecutionLog`
- filtered tool-result-only bundles still render meaningfully even when no paired assistant tool-use survives
- filtered bundles with multiple assistant streaming snapshots collapse to one stable assistant row per `requestId`
- `toolUseResult`-backed richer tool cards still work when the surviving bundle truly owns that tool result
- `toolUseResult` is dropped when ownership is ambiguous

This must be verified, not assumed.

### Important rule

Build chunks from the **filtered slice**, not from the entire session.

### Bundle isolation rule

Build chunks **per requested exact bundle detail**, not from a concatenated multi-bundle slice.

Why:

- `ChunkBuilder` buffers adjacent AI-category messages together
- if two anchors are concatenated before chunk building, separate exact bundles can accidentally merge into one AI chunk
- that would produce unstable visual grouping and leak unrelated context between bundles

So the correct sequence is:

1. derive one exact detail candidate
2. build one filtered message slice for that candidate
3. build chunks for that candidate only
4. map to one `BoardTaskExactLogDetail`

Suggested builder:

```ts
class BoardTaskExactLogChunkBuilder {
  constructor(private readonly chunkBuilder: ChunkBuilder = new ChunkBuilder()) {}

  buildBundleChunks(messages: ParsedMessage[]): EnhancedChunk[] {
    return this.chunkBuilder.buildChunks(messages, [], { includeSidechain: true })
  }
}
```

### Why not pass subagents/processes in v1

The exact log slice is already strict and synthetic.

Passing full process linkage into this slice creates extra coupling and raises contamination risk.

In v1:
- pass no additional processes
- render only what is explicitly in the filtered message slice

That is safer and easier to reason about.

### Why no `SessionParser` as the main entrypoint

`SessionParser` is useful for whole-session views, but it is not the ideal entrypoint here.

For exact logs we want:
- file-local parsed messages
- no whole-session grouping assumptions
- no extra session-level work unless needed

So the preferred path in v1 is:

- parse raw transcript files into `ParsedMessage[]`
- then run exact-bundle selection on top

Do not start from a full `SessionDetail` pipeline unless implementation proves it is actually simpler without correctness cost.

---

## Why We Should Not Reuse `MemberLogsTab`

`MemberLogsTab` is valuable, but it is the wrong source layer for exact logs.

It still depends on:
- session summaries
- session overlap
- task work intervals
- preview logic
- owner-session assumptions

That logic remains useful for `Execution Sessions`, but should not be reused as the source for exact task logs.

Correct reuse target:
- renderer primitives

Wrong reuse target:
- legacy session discovery

### Renderer reuse boundary

Reusing the existing renderer means reusing its current visual behavior too.

That is intentional in v1:

- exact details render through `MemberExecutionLog`
- item ordering follows that component's existing behavior
- no ongoing/session-status affordances are added
- no extra subagent/process enrichment is injected beyond what exists in the filtered chunk slice

This keeps iteration 08 focused on the hard problem - correct task-scoped selection - instead of accidentally starting a parallel renderer redesign.

---

## New Main-Side Services

### 1. `BoardTaskActivityRecordSource`

Responsibility:
- read transcript metadata
- resolve task-linked records
- expose internal activity records

Potential implementation:
- extract common lower-level logic from current `BoardTaskActivityService`
- keep `BoardTaskActivityService` as record -> DTO mapper

### 2. `BoardTaskExactLogSummarySelector`

Responsibility:
- take activity records only
- group them by exact-log anchor
- produce lightweight exact-log summaries

Important:
- this selector owns anchor precedence
- this selector must not parse transcript files
- this selector computes per-summary `sourceGeneration`
- computing `sourceGeneration` may stat referenced files, but it must not parse transcript content
- this selector decides `canLoadDetail` conservatively from anchor shape and record fidelity

### 3. `BoardTaskExactLogDetailSelector`

Responsibility:
- take one exact-log summary + strict parsed transcript messages
- produce one filtered message slice for one requested exact detail

Important:
- this selector owns derived-field recomputation requirements for filtered messages
- this selector must not return raw original `ParsedMessage` arrays when block filtering happened

### 4. `BoardTaskExactLogChunkBuilder`

Responsibility:
- convert filtered message bundles into `EnhancedChunk[]`

Important:
- one bundle in, one bundle out
- no cross-bundle chunk building

### 5. `BoardTaskExactLogsService`

Responsibility:
- orchestrate the exact-log summary flow
- expose IPC-facing `BoardTaskExactLogSummariesResponse`

Important:
- this service consumes `BoardTaskActivityRecordSource`
- it must not directly parse `boardTaskLinks[]` from JSONL lines itself
- it must not parse transcript messages in the summary path
- it may read file metadata needed for per-summary `sourceGeneration`
- it should not own a second explicit-metadata parser

### 6. `BoardTaskExactLogDetailService`

Responsibility:
- resolve one exact bundle summary into one renderable exact detail
- expose IPC-facing `BoardTaskExactLogDetailResult`

Important:
- this service consumes `BoardTaskActivityRecordSource`
- this service consumes `BoardTaskExactLogDetailSelector`
- this service owns strict per-bundle filtering
- this service owns per-bundle assistant `requestId` dedupe before chunk building
- this service returns `stale` or `missing` instead of guessing when a requested bundle can no longer be rendered safely

---

## Proposed File Touchpoints

### `claude_team` main

Add:

- `src/main/services/team/taskLogs/activity/BoardTaskActivityRecordSource.ts`
- `src/main/services/team/taskLogs/exact/BoardTaskExactLogsService.ts`
- `src/main/services/team/taskLogs/exact/BoardTaskExactLogDetailService.ts`
- `src/main/services/team/taskLogs/exact/BoardTaskExactLogSummarySelector.ts`
- `src/main/services/team/taskLogs/exact/BoardTaskExactLogDetailSelector.ts`
- `src/main/services/team/taskLogs/exact/BoardTaskExactLogChunkBuilder.ts`
- `src/main/services/team/taskLogs/exact/BoardTaskExactLogsParseCache.ts`

Touch:

- `src/main/ipc/teams.ts`
- `src/main/ipc/handlers.ts`
- `src/main/index.ts`
- `src/preload/index.ts`
- `src/preload/constants/ipcChannels.ts`
- `src/shared/types/api.ts`
- `src/shared/types/team.ts`

### `claude_team` renderer

Add:

- `src/renderer/components/team/taskLogs/ExactTaskLogsSection.tsx`
- `src/renderer/components/team/taskLogs/ExactTaskLogCard.tsx`

Touch:

- `src/renderer/components/team/taskLogs/TaskLogsPanel.tsx`

### `agent_teams_orchestrator`

No new write-side contract is required for this iteration if iteration 07 metadata is already present.

Only touch write-side if a concrete missing field is discovered during implementation.

That is an explicit scope guard.

---

## IPC Plan

Add:

```ts
teams.getTaskExactLogSummaries(
  teamName: string,
  taskId: string
): Promise<BoardTaskExactLogSummariesResponse>
teams.getTaskExactLogDetail(
  teamName: string,
  taskId: string,
  exactLogId: string,
  expectedSourceGeneration: string
): Promise<BoardTaskExactLogDetailResult>
```

Suggested IPC channel:

```ts
TEAM_GET_TASK_EXACT_LOG_SUMMARIES = 'team:getTaskExactLogSummaries'
TEAM_GET_TASK_EXACT_LOG_DETAIL = 'team:getTaskExactLogDetail'
```

These methods must be:
- independent from `getLogsForTask(...)`
- independent from the legacy worker fallback path
- explicit-metadata only in v1
- browser-safe in the same way as other team-only methods:
  - summaries -> `{ items: [] }`
  - detail -> `{ status: 'missing' }`

### Return shape rule

The API should:

- return lightweight summaries from the summary endpoint
- return already-built `EnhancedChunk[]` only from the detail endpoint
- never return raw messages plus renderer-side building instructions

Why:

- chunk building belongs to the main-side service layer
- renderer should stay simple
- this keeps exact-log selection and filtering logic out of the renderer
- this keeps the initial popup payload materially smaller

### Ordering rule

Returned summaries must be sorted deterministically by:

1. explicit source timestamp
2. `filePath`
3. `sourceOrder`
4. `toolUseId`
5. `id`

This avoids UI drift when multiple transcript rows share the same minute/second bucket.

---

## Renderer Plan

### `TaskLogsPanel`

Target composition:

```tsx
<TaskActivitySection ... />
<ExactTaskLogsSection ... />
<ExecutionSessionsSection ... />
```

### `ExactTaskLogsSection`

Responsibilities:
- fetch `teams.getTaskExactLogSummaries(...)`
- load independently from `ExecutionSessionsSection`
- show loading / error / empty state
- render one card per exact log summary

### Exact-log loading policy

Exact logs are materially heavier than summary rows.

So the safe v1 loading policy is:

- load when the task popup opens and the section becomes visible
- if the section is collapsed, do not keep a blind frequent poll running
- if the task is active and the section is expanded, a slower revalidation loop is acceptable
- manual refresh is acceptable and should be easy to add

This is better than unconditional frequent polling because exact logs require:

- explicit record lookup
- transcript file parsing for exact detail
- synthetic message filtering
- chunk building

Those costs are much higher than the summary feed.

### `ExactTaskLogCard`

Responsibilities:
- show timestamp + actor label
- show source metadata if helpful
- lazy-load detail on expand
- render the loaded detail via `MemberExecutionLog`
- keep the expand control disabled when `canLoadDetail === false`

Example:

```tsx
if (summary.canLoadDetail) {
  const detail = await api.teams.getTaskExactLogDetail(
    teamName,
    taskId,
    summary.id,
    summary.sourceGeneration
  )
  if (detail.status === 'ok') {
    return <MemberExecutionLog chunks={detail.detail.chunks} memberName={summary.actor.memberName} />
  }
}
```

### Actor label rule

Fix the current weak UX:

- if `memberName` exists -> show it
- else if `isSidechain === false` -> show `lead session`
- else -> show `unknown actor`

This is much safer and more readable than the current fallback.

---

## Empty State Policy

If there are explicit activity rows but no exact renderable summaries:

- do **not** silently disappear
- show a clear empty state such as:

`Exact task-scoped transcript groups are not available for these activity rows yet.`

If no explicit activity exists:

`No explicit task-linked logs found in transcript metadata.`

This matters because:
- summary-only history is still useful
- users should not assume the feature is broken

---

## Performance Plan

This slice can get expensive if implemented naively.

### Required v1 protections

1. Parse cache by `filePath + mtimeMs + size`
2. In-flight dedupe for concurrent reads
3. Deduplicate anchors before building summaries
4. In the summary path, do not parse transcript content at all
5. In the detail path, do not parse the same file repeatedly inside one request
6. In the detail path, derive referenced file paths from explicit activity records first, then parse only that subset
7. Avoid unconditional high-frequency polling for exact logs
8. Share the explicit metadata reader/record source with the summary path instead of re-reading metadata in a second pipeline
9. Keep exact detail lazy, not eager, in v1

### Nice-to-have only if needed later

- per-task result cache
- cross-service parsed transcript cache reuse

Do not over-engineer that before profiling.

---

## Consistency Rules

### Rule 1 - Exact logs are explicit-link only

Do not add:
- work-interval fallback
- mention matching
- owner fallback
- “close enough” neighboring tool inference

### Rule 2 - Exact logs and summary use the same explicit source

`Task Activity` and `Exact Task Logs` should derive from the same underlying explicit activity records, not from separate competing interpretations.

That means:

- same `BoardTaskActivityRecordSource`
- same explicit transcript metadata semantics
- same target-task resolution rules

The two views may diverge in presentation.
They must not diverge in their low-level notion of “this transcript source is explicitly linked to this task”.

### Rule 3 - Summary selector is the single source of truth for summary identity

`exactLogId` and per-summary `sourceGeneration` must come from one place only:

- `BoardTaskExactLogSummarySelector`

That means:

- `BoardTaskExactLogsService` uses it to emit summaries
- `BoardTaskExactLogDetailService` uses the same selector to rebuild summaries before loading detail
- detail service must not recompute ids with its own string concatenation rules
- detail service must not recompute generations with a different file-ordering rule

Why this matters:

- summary/detail drift is otherwise easy to introduce silently
- one tiny id-format change can turn every detail request into `missing`
- one tiny generation-ordering change can turn valid detail requests into false `stale`

If a helper is extracted, it should stay below both services and be reused by both.

### Rule 4 - Exact logs may be stricter than summary

This is acceptable.

Some summary rows may not yield rich exact summaries or rich exact details if:
- the row is too minimal
- the source message is malformed
- the source message is non-renderable in the existing pipeline

That is better than rendering the wrong thing.

### Rule 5 - Exact detail reconstruction is file-local in v1

Exact detail reconstruction must stay file-local.

That means:

- one summary anchor resolves to one `source.filePath`
- detail service only parses that summary's referenced files
- missing pair data in another transcript file is treated as absent, not searched globally

Why this matters:

- it matches the current execution renderer and tool-linking assumptions
- it keeps `sourceGeneration` honest
- it avoids a hidden return of broad transcript heuristics

---

## Edge Cases

### 1. Same tool call linked to two tasks

Example:
- `task_link`
- `task_unlink`

Behavior:
- both tasks may show the same exact tool bundle
- the bundle must render once per task, not duplicate within one task

### 2. One transcript message contains multiple relevant links

Behavior:
- collapse into one exact log bundle
- preserve all relevant `linkKinds` in metadata

### 2b. One tool execution has both a tool anchor and a message anchor

Behavior:
- render exactly one exact bundle
- the tool anchor wins
- the message anchor is absorbed into the same bundle metadata

### 3. Same AI response contains relevant and irrelevant tools

Behavior:
- render only the filtered relevant blocks
- do not include the whole raw AI response

### 3b. Same assistant message contains both relevant text and unrelated tool calls

Behavior:
- keep the explicitly linked text
- drop unrelated tool calls
- rebuild derived assistant-side tool structures from the surviving blocks only

### 4. Lead-session row without actor name

Behavior:
- show `lead session`
- not `unknown actor`

### 5. Missing paired `tool_use`

Behavior:
- if `tool_result` exists but paired assistant `tool_use` cannot be found, render what is available
- do not guess missing tool input
- do not search other transcript files for the missing pair in v1

### 6. Missing timestamp / malformed row

Behavior:
- skip malformed rows
- do not synthesize “current time”

### 7. Execution-only ambient rows

Behavior:
- may render as exact text/output-only bundles
- no fake tool payload should be attached

---

## Suggested Internal Helper Shapes

### Bundle source model

```ts
type BoardTaskExactLogBundleCandidate = {
  id: string
  timestamp: string
  actor: BoardTaskExactLogActor
  source: BoardTaskExactLogSource
  records: BoardTaskActivityRecord[]
} & (
  | { canLoadDetail: true; sourceGeneration: string }
  | { canLoadDetail: false }
)

type BoardTaskExactLogDetailCandidate = {
  id: string
  timestamp: string
  actor: BoardTaskExactLogActor
  source: BoardTaskExactLogSource
  records: BoardTaskActivityRecord[]
  filteredMessages: ParsedMessage[]
}
```

### Bundle identity rule

Use:

- tool bundle id: `tool:${filePath}:${toolUseId}`
- message bundle id: `message:${filePath}:${messageUuid}`

Do not use timestamps as the primary identity.
Timestamps are for ordering, not identity.

### Summary source-of-truth rule for actor label

`MemberExecutionLog` only receives `chunks` plus one optional `memberName`.

So v1 should not try to rediscover actor identity from filtered exact-detail messages.
The authoritative actor label for the exact-log card should come from the summary/record side:

- exact summary owns the visible actor label
- exact detail rendering reuses that summary actor label
- detail reconstruction should not override it based on incidental filtered message content

### Selector skeleton

```ts
class BoardTaskExactLogSummarySelector {
  selectSummaries(args: {
    records: BoardTaskActivityRecord[]
  }): BoardTaskExactLogBundleCandidate[] {
    // 1. derive anchors from explicit records
    // 2. apply tool-anchor-over-message precedence
    // 3. dedupe anchors
    // 4. compute per-summary sourceGeneration
    // 5. return one candidate per summary
  }
}

class BoardTaskExactLogDetailSelector {
  selectDetail(args: {
    summary: BoardTaskExactLogSummary
    records: BoardTaskActivityRecord[]
    parsedMessagesByFile: Map<string, ParsedMessage[]>
  }): BoardTaskExactLogDetailCandidate | null {
    // 1. rebuild the matching anchor from explicit records
    // 2. parse only the files referenced by that summary
    // 3. build filtered synthetic ParsedMessage[] for that one anchor
    // 4. return one detail candidate or null
  }
}
```

### Service skeleton

```ts
class BoardTaskExactLogsService {
  async getTaskExactLogSummaries(
    teamName: string,
    taskId: string
  ): Promise<BoardTaskExactLogSummariesResponse> {
    // 1. get explicit activity records
    // 2. build exact summaries from records only
    // 3. sort deterministically
    // 4. map summary response
  }
}

class BoardTaskExactLogDetailService {
  async getTaskExactLogDetail(
    teamName: string,
    taskId: string,
    exactLogId: string,
    expectedSourceGeneration: string
  ): Promise<BoardTaskExactLogDetailResult> {
    // 1. rebuild the matching summary from explicit records
    // 2. if summary.canLoadDetail !== true -> return { status: 'missing' }
    // 3. compare expectedSourceGeneration with recomputed summary.sourceGeneration
    // 4. if mismatch -> return { status: 'stale' }
    // 5. parse only the summary's referenced files via strict parser
    // 6. build one filtered detail candidate
    // 7. dedupe assistant streaming rows by requestId
    // 8. build chunks
    // 9. return one detail DTO or { status: 'missing' }
  }
}
```

---

## Rollout Plan

### Feature gates

Use separate read/UI gates:

- `CLAUDE_TEAM_BOARD_TASK_EXACT_LOGS_READ_ENABLED`
- `VITE_BOARD_TASK_EXACT_LOGS_UI_ENABLED`

Do not reuse the iteration 07 gates directly.

This lets us:
- validate main-side behavior first
- then enable renderer independently

### Rollout stages

#### Stage 1 - Main-side exact bundle service

- build record source
- build exact summaries
- add tests
- no UI yet

#### Stage 2 - IPC + preload

- expose `getTaskExactLogSummaries(...)`
- expose `getTaskExactLogDetail(...)`
- add integration tests

#### Stage 3 - Renderer section

- add `ExactTaskLogsSection`
- wire into task popup
- keep disabled by UI flag initially

#### Stage 4 - Manual shadow validation

Compare:
- `Task Activity`
- `Exact Task Logs`
- `Execution Sessions`

for several real teams and transcript shapes.

---

## Testing Plan

### Main tests

Add focused tests for:

1. `BoardTaskActivityRecordSource`
   - explicit record extraction matches existing activity semantics

2. Exact-log selectors
  become two focused test units:

  `BoardTaskExactLogSummarySelector`
  - dedupes repeated refs
  - applies tool-anchor-over-message precedence
  - computes stable per-summary `sourceGeneration`
  - does not parse transcript content
  - sets `canLoadDetail` conservatively
  - omits `sourceGeneration` when `canLoadDetail === false`

  `BoardTaskExactLogDetailSelector`
  - filters unrelated tools from same AI response
  - keeps filtered internal-user results in the AI rendering path
  - keeps paired tool_use + tool_result
  - preserves explicit assistant text when linked
  - rebuilds derived fields after block filtering
  - keeps `toolUseResult` only for the surviving matching tool result
  - dedupes assistant streaming entries by `requestId` after filtering
  - never searches outside the summary's file-local source set for missing pairs

3. `BoardTaskExactLogChunkBuilder`
   - builds renderable `EnhancedChunk[]`
   - never merges adjacent candidates into one cross-bundle AI chunk
   - no crash on minimal bundles

4. `BoardTaskExactLogsService`
   - returns sorted summaries
   - empty when feature disabled
   - returns `{ items: [] }` for unknown task
   - does not invoke transcript parsing in the summary path
   - does not touch the exact-log strict parser or transcript parse cache in the summary path
   - emits stable per-summary `sourceGeneration` values
   - never emits `sourceGeneration` for non-expandable summaries

5. `BoardTaskExactLogDetailService`
   - returns `status: 'missing'` immediately for non-expandable summaries
   - returns `status: 'stale'` when requested generation no longer matches
   - returns `status: 'missing'` for unknown bundle
   - returns `status: 'ok'` with renderable detail for valid bundle id
   - does not guess missing tool ownership
   - reuses the summary actor label instead of re-deriving actor identity from filtered detail messages

### IPC tests

- `teams.getTaskExactLogSummaries(...)` happy path
- `teams.getTaskExactLogDetail(...)` happy path
- `teams.getTaskExactLogDetail(...)` stale-generation path
- browser fallback shape
- disabled flag path
- malformed transcript path

### Renderer tests

- `ExactTaskLogsSection`
  - loading
  - error
  - empty
  - renders one or more exact summaries
  - reloads summaries on `stale` detail response

### Manual validation

Use real scenarios:

1. normal owner task with lifecycle + comments + review
2. external actor touches another task
3. `task_link` / `task_unlink`
4. lead-session rows without `agentName`
5. task with explicit summary rows but no exact renderable detail
6. summary/detail drift after transcript update

---

## Definition of Done

This iteration is done when:

- task popup shows:
  - `Task Activity`
  - `Exact Task Logs`
  - `Execution Sessions`
- `Exact Task Logs` visually uses the same execution-log renderer family the user already likes
- exact logs are sourced from explicit task-linked transcript selection
- exact logs do **not** depend on legacy heuristic task/session discovery
- unrelated tools from the same AI response are not leaked into the exact view
- exact-log details are lazy-loaded, not eagerly transferred for every summary row
- main-side and renderer tests pass
- old `Execution Sessions` remains intact and isolated

---

## Final Decision Summary

The best path is:

- **reuse the existing execution renderer**
- **do not reuse the old heuristic log discovery**
- **insert a strict explicit task-scoped transcript selection layer**

This preserves the good UX while finally making task log attribution reliable.
