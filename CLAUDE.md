# Claude Agent Teams UI

A new approach to task management with AI agent teams. Assemble agent teams with different roles that work autonomously in parallel, communicate with each other, create and manage their own tasks, review code, and collaborate across teams. You manage everything through a kanban board — like a CTO with an AI engineering team.

Key capabilities:
- **Agent Teams** — create teams with roles, agents work autonomously in parallel
- **Cross-team communication** — agents message each other within and across teams
- **Kanban board** — tasks change status in real-time as agents work
- **Code review** — diff view per task (accept/reject/comment), similar to Cursor
- **Solo mode** — single agent with self-managed tasks, expandable to full team
- **Live process section** — see running agents, open URLs in browser
- **Direct messaging** — send messages to any agent, comment on tasks, add quick actions on kanban cards
- **Deep session analysis** — bash commands, reasoning, subprocesses breakdown
- **Context monitoring** — token usage by category (CLAUDE.md, tool outputs, thinking, team coordination)
- **Built-in code editor** — edit files with Git support without leaving the app
- **MCP integration** — built-in mcp-server for external tools and agent plugins
- **Post-compact context recovery** — restores team-management instructions after context compaction
- **Notification system** — alerts on task completion, agent attention needed, errors
- **Zero-setup onboarding** — built-in Claude Code installation and authentication

100% free, open source. No API keys. No configuration. Runs entirely locally.

## Tech Stack
Electron 28.x, React 18.x, TypeScript 5.x, Tailwind CSS 3.x, Zustand 4.x

## Commands
Always use pnpm (not npm/yarn) for this project.
Do NOT run `pnpm lint:fix` unless the user explicitly asks for it — it interferes with agents running in parallel.
When running build/typecheck/test commands, pipe through `tail -20` to avoid flooding the context window (e.g. `pnpm typecheck 2>&1 | tail -20`).

- `pnpm install` - Install dependencies
- `pnpm dev` - Dev server with hot reload
- `pnpm build` - Production build
- `pnpm typecheck` - Type checking
- `pnpm lint:fix` - Lint and auto-fix
- `pnpm format` - Format code
- `pnpm test` - Run all vitest tests
- `pnpm test:watch` - Watch mode
- `pnpm test:coverage` - Coverage report
- `pnpm test:coverage:critical` - Critical path coverage
- `pnpm test:chunks` - Chunk building tests
- `pnpm test:semantic` - Semantic step extraction tests
- `pnpm test:noise` - Noise filtering tests
- `pnpm test:task-filtering` - Task tool filtering tests
- `pnpm check` - Full quality gate (types + lint + test + build)
- `pnpm fix` - Lint fix + format
- `pnpm quality` - Full check + format check + knip

## Path Aliases
Use path aliases for imports:
- `@main/*` → `src/main/*`
- `@renderer/*` → `src/renderer/*`
- `@shared/*` → `src/shared/*`
- `@preload/*` → `src/preload/*`

## Data Sources
~/.claude/projects/{encoded-path}/*.jsonl - Session files
~/.claude/todos/{sessionId}.json - Todo data

Path encoding: `/Users/name/project` → `-Users-name-project`

## Critical Concepts

### isMeta Flag
- `isMeta: false` = Real user message (creates new chunks)
- `isMeta: true` = Internal message (tool results, system-generated)

### Chunk Structure
Independent chunk types for timeline visualization:
- **UserChunk**: Single user message with metrics
- **AIChunk**: All assistant responses with tool executions and spawned subagents
- **SystemChunk**: Command output/system messages
- **CompactChunk**: System metadata/structural messages

Each chunk has: timestamp, duration, metrics (tokens, cost, tools)

### Task/Subagent Filtering
Task tool_use blocks are filtered when subagent exists
Keep orphaned Task calls (no matching subagent) for visibility.

### Agent Teams
Claude Code's "Orchestrate Teams" feature: multiple sessions coordinate as a team.
- **Process.team?** `{ teamName, memberName, memberColor }` — enriched by SubagentResolver from Task call inputs and `teammate_spawned` tool results
- **Teammate messages** arrive as `<teammate-message teammate_id="..." color="..." summary="...">content</teammate-message>` in user messages (isMeta: false). Detected by `isParsedTeammateMessage()` — excluded from UserChunks, rendered as `TeammateMessageItem` cards
- **Session ongoing detection** treats `SendMessage` shutdown_response (approve: true) and its tool_result as ending events, not ongoing activity
- **Display summary** counts distinct teammates (by name) separately from regular subagents
- **Team tools**: TeamCreate, TaskCreate, TaskUpdate, TaskList, TaskGet, SendMessage, TeamDelete — have readable summaries in `toolSummaryHelpers.ts`

### Structured Task References
- **TaskRef**: `{ taskId, displayId, teamName }` — shared typed reference used to persist task mentions across UI and storage
- **Persisted optional fields**: `InboxMessage.taskRefs`, `TaskComment.taskRefs`, `TeamTask.descriptionTaskRefs`, `TeamTask.promptTaskRefs`
- **Request surfaces**: `SendMessageRequest.taskRefs`, `AddTaskCommentRequest.taskRefs`, `CreateTaskRequest.descriptionTaskRefs`, `CreateTaskRequest.promptTaskRefs`, `UpdateKanbanPatch` `request_changes.taskRefs`
- **Renderer flow**: task-aware inputs use `useTaskSuggestions()` with `taskReferenceUtils.ts` to extract refs from text; encoded zero-width metadata preserves exact task identity while keeping visible text readable
- **Main/IPC flow**: `src/main/ipc/teams.ts` and `src/main/ipc/crossTeam.ts` validate structured refs before `TeamDataService`, inbox stores, task stores, and readers persist/rehydrate them
- **Rendering/navigation**: `linkifyTaskIdsInMarkdown()` and `parseTaskLinkHref()` turn persisted refs into stable `task://` links across messages, comments, task descriptions, and activity items

### Visible Context Tracking
Tracks what consumes tokens in Claude's context window across 6 categories (discriminated union on `category` field):

| Category | Type | Source |
|----------|------|--------|
| `claude-md` | `ClaudeMdContextInjection` | CLAUDE.md files (global, project, directory) |
| `mentioned-file` | `MentionedFileInjection` | User @-mentioned files |
| `tool-output` | `ToolOutputInjection` | Tool execution results (Read, Bash, etc.) |
| `thinking-text` | `ThinkingTextInjection` | Extended thinking + text output tokens |
| `team-coordination` | `TeamCoordinationInjection` | Team tools (SendMessage, TaskCreate, etc.) |
| `user-message` | `UserMessageInjection` | User prompt text per turn |

- **Types**: `src/renderer/types/contextInjection.ts` — `ContextInjection` union, `ContextStats`, `TokensByCategory`
- **Tracker**: `src/renderer/utils/contextTracker.ts` — `computeContextStats()`, `processSessionContextWithPhases()`
- **Context Phases**: Compaction events reset accumulated injections, tracked via `ContextPhaseInfo`
- **Display surfaces**: `ContextBadge` (per-turn popover), `TokenUsageDisplay` (hover breakdown), `SessionContextPanel` (full panel)

## Error Handling
- Main: try/catch, console.error, return safe defaults
- Renderer: error state in Zustand store
- IPC: parameter validation, graceful degradation

## Performance
- LRU Cache: Avoid re-parsing large JSONL files
- Streaming JSONL: Line-by-line processing
- Virtual Scrolling: For large session/message lists
- Debounced File Watching: 100ms debounce

## Troubleshooting

### Build Issues
```bash
rm -rf dist dist-electron node_modules
pnpm install
pnpm build
```

### Type Errors
```bash
pnpm typecheck
```

### Test Failures
Check for changes in message parsing or chunk building logic.

## TypeScript Conventions

### Naming
| Category | Convention | Example |
|----------|------------|---------|
| Services/Components | PascalCase | `ProjectScanner.ts` |
| Utilities | camelCase | `pathDecoder.ts` |
| Constants | UPPER_SNAKE_CASE | `PARALLEL_WINDOW_MS` |
| Type Guards | isXxx | `isParsedRealUserMessage()` |
| Builders | buildXxx | `buildChunks()` |
| Getters | getXxx | `getResponses()` |

### Type Guards
```typescript
// Message type guards (src/main/types/messages.ts)
isParsedRealUserMessage(msg)      // isMeta: false, string content
isParsedInternalUserMessage(msg)  // isMeta: true, array content
isAssistantMessage(msg)           // type: "assistant"

// Chunk type guards
isUserChunk(chunk)          // type: "user"
isAIChunk(chunk)            // type: "ai"
isSystemChunk(chunk)        // type: "system"
isCompactChunk(chunk)       // type: "compact"

// Context injection type guards (component-scoped in ContextBadge.tsx, not exported)
isClaudeMdInjection(inj)          // category: "claude-md"
isMentionedFileInjection(inj)     // category: "mentioned-file"
isToolOutputInjection(inj)        // category: "tool-output"
isThinkingTextInjection(inj)      // category: "thinking-text"
isTeamCoordinationInjection(inj)  // category: "team-coordination"
isUserMessageInjection(inj)       // category: "user-message"
```

### Barrel Exports
`src/main/services/` and its domain subdirectories have barrel exports via index.ts:
```typescript
// Preferred
import { ChunkBuilder, ProjectScanner } from './services';
// Also valid
import { ChunkBuilder } from './services/analysis';
```
Note: renderer utils/hooks/types do NOT have barrel exports — import directly from files.

### Import Order
1. External packages
2. Path aliases (@main, @renderer, @shared)
3. Relative imports

### Storage And Persistence
- New persistence flows should depend on small repository/storage abstractions, not directly on `localStorage`, `IndexedDB`, Electron APIs, or JSON files from UI components/hooks.
- Keep persistence concerns split by responsibility: schema/normalization, repository interface, concrete storage implementation, and UI adapter logic should live in separate modules.
- Prefer designs where the high-level feature code can swap local browser/Electron storage for a server-backed implementation without rewriting the rendering layer.
- Reuse generic persistence/layout infrastructure when adding new draggable/resizable surfaces instead of copying feature-specific storage code.
