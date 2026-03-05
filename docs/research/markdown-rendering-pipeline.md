# Message Text Pipeline & Markdown Rendering — Research

## Context

Investigating why markdown formatting may appear as plain text in certain UI surfaces.

---

## 1. Full Text Pipeline: MessageComposer -> Inbox -> ActivityItem

### Step-by-step flow

```
MessageComposer.tsx (renderer)
  |-- User types into MentionableTextarea (plain text + chip tokens)
  |-- On send: serializeChipsWithText(text, chips) converts chip tokens to markdown fences
  |-- Calls onSend(recipient, serialized, serialized, attachments?)
  |
teamSlice.ts (renderer store)
  |-- sendTeamMessage() -> api.teams.sendMessage(teamName, request)
  |
TeamInboxWriter.ts (main process)
  |-- Writes InboxMessage to JSON file at teams/{teamName}/inboxes/{member}.json
  |-- `text` field stored verbatim — NO sanitization, NO escaping
  |-- JSON.stringify with null,2 (pretty-print) — safe for any string content
  |
FileWatcher detects change -> store loads inbox data
  |
ActivityItem.tsx (renderer)
  |-- stripAgentBlocks(message.text) removes ```info_for_agent``` blocks
  |-- linkifyTaskIdsInMarkdown() converts #123 to [#123](task://123)
  |-- Passes result to <MarkdownViewer content={displayText} bare />
```

### Conclusion: Markdown IS preserved end-to-end

The text field is stored as-is in JSON. No sanitization or escaping strips markdown formatting. `serializeChipsWithText()` even enriches plain text with markdown code fences for code chips.

---

## 2. TaskDetailDialog Description Rendering

### Current implementation (TaskDetailDialog.tsx, lines 539-566)

**Read mode (not editing):**
```tsx
<MarkdownViewer content={currentTask.description} maxHeight="max-h-[180px]" bare />
```

**Edit preview mode (lines 494-501):**
```tsx
<MarkdownViewer content={descriptionDraft} maxHeight="max-h-[180px]" />
```

### Conclusion: TaskDetailDialog DOES use MarkdownViewer

The description is rendered with `<MarkdownViewer bare />` in read mode. Markdown should render correctly here. If it appears as plain text, the issue is upstream — the description content itself may not contain markdown formatting (e.g., the task was created with plain text by CLI tooling, not from the UI).

---

## 3. Sanitization/Escaping Analysis

| Layer | Sanitization | Impact on Markdown |
|-------|-------------|-------------------|
| `serializeChipsWithText()` | Replaces chip tokens with markdown — additive | **None** (enriches) |
| `TeamInboxWriter.sendMessage()` | None — stores `request.text` verbatim | **None** |
| `JSON.stringify/parse` | Standard JSON encoding | **None** (reversible) |
| `stripAgentBlocks()` | Removes ````info_for_agent``` blocks only | **None** (targeted) |
| `linkifyTaskIdsInMarkdown()` | Converts `#123` to `[#123](task://123)` | **None** (additive) |
| `ReactMarkdown` | Parses markdown to HTML | **This IS the rendering** |

**No layer strips or escapes markdown formatting.** The pipeline is clean.

---

## 4. Effect of MarkdownViewer `bare` Prop

From `MarkdownViewer.tsx` (lines 561-571):

```tsx
<div
  className={`min-w-0 overflow-hidden ${bare ? '' : 'rounded-lg shadow-sm'} ...`}
  style={bare ? undefined : { backgroundColor: CODE_BG, border: `1px solid ${CODE_BORDER}` }}
>
```

**`bare` only affects the wrapper div styling:**
- `bare={true}`: No background, no border, no shadow — for embedding inside cards.
- `bare={false}` (default): Adds `CODE_BG` background, `CODE_BORDER` border, `rounded-lg shadow-sm`.

**`bare` does NOT affect markdown parsing or rendering.** The same `ReactMarkdown` component with `remarkGfm` and `rehype-highlight` is used regardless.

---

## 5. Where Markdown Might Appear as Plain Text

### Identified scenarios

1. **Task descriptions from CLI tooling (teamctl.js / Claude agents)**
   Task descriptions are set via `node teamctl.js task create` or `TaskCreate` tool calls. Agents typically write plain text descriptions, not markdown. The description content itself lacks formatting — MarkdownViewer renders it correctly, but there's nothing to format.

2. **Task comments from agents**
   Same issue — `task comment --text "..."` passes plain text. However, TaskCommentsSection.tsx (line 246) correctly uses `<MarkdownViewer content={displayText} bare />`.

3. **Structured JSON messages in ActivityItem**
   When `parseStructuredAgentMessage()` returns a match, the structured path renders `autoSummary` as a `<p>` tag and shows raw JSON in a `<details>` block — no MarkdownViewer. This is intentional for JSON protocol messages.

4. **Summary text in ActivityItem header**
   Line 375-377: `summaryText` is rendered as plain `<span>` in the header row. This is by design — summaries are short single-line previews.

5. **ReplyQuoteBlock path in ActivityItem**
   When `parsedReply` is detected, it renders `<ReplyQuoteBlock>` instead of MarkdownViewer. The quote block may not support full markdown — worth checking.

### NOT an issue

- Description in TaskDetailDialog: correctly uses MarkdownViewer.
- Activity feed messages: correctly uses MarkdownViewer for displayText.
- Task comments: correctly uses MarkdownViewer.

---

## 6. Proposed Fixes

### Fix 1: No code change needed for the rendering pipeline
The pipeline is correct. All text display surfaces that show long-form content already use MarkdownViewer.

### Fix 2: If specific content appears unformatted, the fix is upstream
Ensure that agents/tooling that create tasks or comments use markdown formatting in their text. For example, the `teamctl.js` task create command could document that `--description` supports markdown.

### Fix 3 (Optional): ReplyQuoteBlock markdown support
`ReplyQuoteBlock` renders the reply body. If it currently shows plain text, wrap body content in `<MarkdownViewer bare />` for consistency. (Needs verification — separate from this research scope.)

---

## Summary

| Question | Answer |
|----------|--------|
| Is markdown preserved in the pipeline? | Yes — no sanitization strips it |
| Does TaskDetailDialog use MarkdownViewer? | Yes — both read mode and edit preview |
| Does any escaping strip formatting? | No — all transformations are additive or targeted |
| Does `bare` affect rendering? | No — only wrapper styling (bg/border/shadow) |
| Why might text appear unformatted? | Source content (from agents/CLI) is plain text, not markdown |
