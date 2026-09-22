# Claude Coupling Analysis

Comprehensive analysis of how tightly the Claude Agent Teams UI codebase is coupled to Claude/Claude Code/Claude Agent Teams. The goal is to understand the effort required to abstract the AI provider layer to support other agents (OpenAI Codex, Gemini CLI, etc.).

**Date**: 2026-03-24
**Branch**: `dev`
**Commit**: `08be859`

---

## Summary Table

| Area | Coupling (1-10) | Effort | Key Blockers |
|---|---|---|---|
| 1. Process Management | **9** | High | Binary name, CLI flags, kill semantics |
| 2. Protocol / Communication | **10** | High | stream-json is Claude-proprietary |
| 3. Message Parsing (JSONL) | **9** | High | Schema is Claude Code's internal format |
| 4. Team Management | **10** | Very High | Agent Teams is a Claude Code feature |
| 5. Session Data / Paths | **9** | Medium | `~/.claude/` hardcoded everywhere |
| 6. Authentication | **8** | Medium | `claude auth status`, GCS binary dist |
| 7. MCP Integration | **5** | Low | MCP is a cross-vendor standard |
| 8. UI Components | **6** | Medium | Branding strings, CLAUDE.md references |
| 9. Types / Interfaces | **8** | High | Types mirror Claude Code JSONL schema |
| 10. Configuration | **7** | Medium | Path constants, env vars, config files |
| **Pricing / Cost** | **7** | Medium | pricing.json is Claude-model-centric |
| **Model Parsing** | **9** | Low | `parseModelString()` only handles `claude-*` |

**Overall Coupling Score: 8.3 / 10** — Deeply coupled to Claude Code at nearly every layer.

---

## 1. Process Management

**Coupling: 9/10 | Effort: High**

### Specific Files
- `src/main/services/team/ClaudeBinaryResolver.ts` — resolves the `claude` binary across platforms
- `src/main/utils/childProcess.ts` — `spawnCli()` / `execCli()` wrappers inject `CLAUDE_HOOK_JUDGE_MODE` env var
- `src/main/services/team/TeamProvisioningService.ts` — spawns `claude` with Claude-specific flags
- `src/main/services/infrastructure/CliInstallerService.ts` — downloads `claude` binary from GCS
- `src/main/services/schedule/ScheduledTaskExecutor.ts` — spawns `claude -p` for scheduled tasks

### What's Claude-specific
1. **Binary name**: `ClaudeBinaryResolver` searches for `claude` binary across PATH, NVM, platform-specific dirs
2. **CLI flags**: `--input-format stream-json`, `--output-format stream-json`, `--verbose`, `--setting-sources`, `--mcp-config`, `--disallowedTools`, `--dangerously-skip-permissions`, `--permission-prompt-tool`, `--model`, `--effort`, `--worktree`, `--resume`, `--no-session-persistence`, `--max-turns`, `--permission-mode`
3. **Env var**: `CLAUDE_HOOK_JUDGE_MODE: 'true'` injected into every CLI process
4. **Env var**: `CLAUDE_CONFIG_DIR` set in `buildEnrichedEnv()`
5. **Env var override**: `CLAUDE_CLI_PATH` for custom binary location
6. **Kill semantics**: `killTeamProcess()` uses SIGKILL specifically because Claude CLI cleanup on SIGTERM deletes team files
7. **GCS distribution**: `CliInstallerService` downloads from `https://storage.googleapis.com/claude-code-dist-.../claude-code-releases`
8. **Version command**: `claude --version` expected to output `"X.Y.Z (Claude Code)"`
9. **Install command**: `claude install` for shell integration

### Abstraction Approach
Create a `CliProvider` interface:
```typescript
interface CliProvider {
  name: string;
  resolveBinaryPath(): Promise<string | null>;
  buildSpawnArgs(options: SpawnOptions): string[];
  buildEnv(binaryPath: string): NodeJS.ProcessEnv;
  parseVersionOutput(stdout: string): string;
  getKillSignal(): NodeJS.Signals;
  install(): Promise<void>;
  checkAuth(): Promise<AuthStatus>;
}
```
Each provider (ClaudeCliProvider, CodexCliProvider, GeminiCliProvider) implements this. `ClaudeBinaryResolver` becomes `ClaudeCliProvider.resolveBinaryPath()`.

---

## 2. Protocol / Communication

**Coupling: 10/10 | Effort: High**

### Specific Files
- `src/main/services/team/TeamProvisioningService.ts` (lines 126-132, 2742-2980, 4849-5290) — stream-json parser
- `src/renderer/utils/streamJsonParser.ts` — renderer-side stream-json log parsing
- `src/renderer/components/team/CliLogsRichView.tsx` — renders stream-json output
- `src/shared/utils/teammateMessageParser.ts` — parses `<teammate-message>` XML format

### What's Claude-specific
1. **stream-json protocol**: Claude Code's proprietary newline-delimited JSON over stdin/stdout
   - Input: `{"type":"user","message":{"role":"user","content":[...]}}\n`
   - Output types: `user`, `assistant`, `control_request`, `result`, `system`
   - `result.success` = turn complete, `result.error` = failure
   - `control_request` for tool approval prompts
2. **Message envelope**: `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}`
3. **Teammate message format**: XML tags `<teammate-message teammate_id="..." color="..." summary="...">content</teammate-message>`
4. **Preflight ping**: `claude -p "Output only the single word PONG." --output-format text --model haiku --max-turns 1 --no-session-persistence`
5. **Tool approval**: `control_request` type with `tool_input`, `tool_name`, approval via stdin

### Abstraction Approach
This is the hardest area. Create a `CliProtocol` interface:
```typescript
interface CliProtocol {
  formatInputMessage(text: string): string;
  parseOutputLine(line: string): ParsedOutputMessage;
  isResultSuccess(msg: ParsedOutputMessage): boolean;
  isResultError(msg: ParsedOutputMessage): boolean;
  isToolApprovalRequest(msg: ParsedOutputMessage): ToolApprovalRequest | null;
  formatToolApprovalResponse(approved: boolean): string;
  getProtocolFlags(): string[];  // e.g. ['--input-format', 'stream-json', ...]
}
```
Each agent's protocol would need a distinct implementation. OpenAI Codex uses a different protocol (REST-based sandbox execution, not stdin/stdout). This would require major architectural changes.

---

## 3. Message Parsing (JSONL)

**Coupling: 9/10 | Effort: High**

### Specific Files
- `src/main/types/jsonl.ts` — raw JSONL entry types (Claude Code session file format)
- `src/main/types/messages.ts` — parsed message types and type guards
- `src/main/types/domain.ts` — domain types referencing `~/.claude/projects/` structure
- `src/main/types/chunks.ts` — chunk building from parsed messages
- `src/main/utils/jsonl.ts` — JSONL file parser
- `src/main/constants/messageTags.ts` — `<local-command-stdout>`, `<local-command-caveat>`, `<system-reminder>` tags

### What's Claude-specific
1. **JSONL schema**: Entry types (`user`, `assistant`, `system`, `summary`, `file-history-snapshot`, `queue-operation`) are Claude Code's internal format
2. **Content blocks**: `text`, `thinking`, `tool_use`, `tool_result`, `image` — follows Anthropic Messages API schema
3. **`thinking` + `signature`**: Extended thinking is an Anthropic-specific feature
4. **`isMeta` flag**: Claude Code's internal convention for distinguishing real user messages from tool results
5. **`isSidechain`**: Claude Code's flag for subagent messages
6. **`stop_reason`**: `end_turn`, `tool_use`, `max_tokens`, `stop_sequence` — Anthropic API values
7. **XML tags in content**: `<local-command-stdout>`, `<local-command-caveat>`, `<system-reminder>`, `<command-name>` are Claude Code's internal message wrapping
8. **`<synthetic>` model**: Claude Code's marker for system-generated placeholders
9. **`isCompactSummary`**: Claude Code's context compaction mechanism
10. **Usage metadata**: `cache_read_input_tokens`, `cache_creation_input_tokens` — Anthropic cache API

### Abstraction Approach
Create a `SessionParser` interface that converts provider-specific session data to a normalized `ParsedMessage`:
```typescript
interface SessionDataProvider {
  parseSessionFile(path: string): AsyncIterable<ParsedMessage>;
  isRealUserMessage(msg: ParsedMessage): boolean;
  isToolCall(block: ContentBlock): boolean;
  extractToolResult(msg: ParsedMessage): ToolResult | null;
}
```
The existing `ParsedMessage` type is actually reasonably generic (it has `toolCalls`, `toolResults`, `content`). The provider-specific part is the parsing FROM the raw format TO `ParsedMessage`. New providers would implement different parsers.

---

## 4. Team Management

**Coupling: 10/10 | Effort: Very High**

### Specific Files
- `src/main/services/team/TeamProvisioningService.ts` (~7800 lines) — the monolith
- `agent-teams-controller/` — workspace package for file-level team operations
- `src/main/services/team/*.ts` (~35 files) — team data, inbox, tasks, kanban, review, cross-team
- `src/shared/types/team.ts` — TeamConfig, TeamTask, SendMessageRequest, etc.
- `src/main/ipc/teams.ts` — ~65 IPC handlers for team operations
- `src/shared/utils/leadDetection.ts` — detects team lead by `agentType` values

### What's Claude-specific
1. **Agent Teams is a Claude Code feature**: `TeamCreate`, `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`, `SendMessage`, `TeamDelete` are Claude Code CLI tools
2. **Team file structure**: `~/.claude/teams/{teamName}/config.json`, `inboxes/{member}.json`, `kanban-state.json`, `processes.json`, `members.meta.json`
3. **Task file structure**: `~/.claude/tasks/{teamName}/{taskId}.json`
4. **Inbox protocol**: File-based message passing — lead reads stdin, teammates read inbox files
5. **Lead/teammate distinction**: Lead uses stream-json, teammates are independent CLI processes
6. **Tool blocking**: `--disallowedTools TeamDelete,TodoWrite`
7. **`agentType` values**: `team-lead`, `lead`, `orchestrator`, `general-purpose` — Claude Code internal values
8. **`teammate_spawned` tool results**: How team member processes are detected
9. **Cross-team communication**: `cross_team_send`, `cross_team_list_targets`, `cross_team_get_outbox`
10. **Action mode instructions**: Custom protocol text injected into team prompts
11. **`agent-teams-controller` package**: Pure JS module that reads Claude Code's team filesystem directly

### Abstraction Approach
This is by far the hardest area. Agent Teams is a unique Claude Code feature with no equivalent in other CLI agents. Options:
- **Option A**: Keep team management as Claude-only feature, abstract only session viewing
- **Option B**: Build a generic team orchestration layer that wraps different agent CLIs. Would need to implement inbox/task/kanban semantics independently of Claude Code.
- **Option C**: Make team management pluggable — each provider declares `supportsTeams: boolean` and provides a `TeamOrchestrator` implementation if supported

Option A is the most realistic short-term approach.

---

## 5. Session Data / Paths

**Coupling: 9/10 | Effort: Medium**

### Specific Files
- `src/main/utils/pathDecoder.ts` — all path construction (`~/.claude/projects/`, `~/.claude/todos/`, `~/.claude/teams/`, `~/.claude/tasks/`)
- `src/main/services/discovery/ProjectScanner.ts` — scans `~/.claude/projects/`
- `src/main/services/infrastructure/FileWatcher.ts` — watches `~/.claude/projects/`, `~/.claude/todos/`, `~/.claude/teams/`, `~/.claude/tasks/`
- `src/main/services/infrastructure/SshConnectionManager.ts` — hardcodes `~/.claude/projects` for remote
- `src/main/services/infrastructure/ConfigManager.ts` — config at `~/.claude/claude-devtools-config.json`
- `src/main/constants/worktreePatterns.ts` — detects `.claude/worktrees/` pattern

### What's Claude-specific
1. **Base path**: `~/.claude/` as root for all data
2. **Path encoding**: `/Users/name/project` → `-Users-name-project` (Claude Code's convention)
3. **Session files**: `~/.claude/projects/{encoded-path}/{uuid}.jsonl`
4. **Subagent files**: `~/.claude/projects/{path}/{session_uuid}/agent_{uuid}.jsonl`
5. **Todo files**: `~/.claude/todos/{sessionId}.json`
6. **Team files**: `~/.claude/teams/{teamName}/...`
7. **Task files**: `~/.claude/tasks/{teamName}/{taskId}.json`
8. **Config**: `~/.claude/claude-devtools-config.json` (our config, stored in Claude's directory)
9. **SSH remote**: Hardcoded `/home/{user}/.claude/projects`, `/Users/{user}/.claude/projects`, `/root/.claude/projects`
10. **Worktree patterns**: `.claude/worktrees/` as a known source

### Abstraction Approach
Path resolution is already partially abstracted via `getClaudeBasePath()` with override support (`setClaudeBasePathOverride`). Extend to:
```typescript
interface DataPathProvider {
  getBasePath(): string;                           // ~/.claude/, ~/.codex/, etc.
  getProjectsPath(): string;                       // {base}/projects/
  getSessionPath(projectId: string, sessionId: string): string;
  getSubagentPath(projectId: string, sessionId: string): string;
  encodeProjectPath(absolutePath: string): string;
  decodeProjectPath(encoded: string): string;
}
```
Medium effort because path functions are centralized in `pathDecoder.ts`. The SSH remote paths would need provider-specific resolution.

---

## 6. Authentication

**Coupling: 8/10 | Effort: Medium**

### Specific Files
- `src/main/services/infrastructure/CliInstallerService.ts` — `claude auth status --output-format json`, `claude --version`
- `src/shared/types/cliInstaller.ts` — `CliInstallationStatus.authLoggedIn`, `authMethod`
- `src/main/utils/cliAuthDiagLog.ts` — diagnostic logging for auth issues
- `src/renderer/components/dashboard/CliStatusBanner.tsx` — shows login status

### What's Claude-specific
1. **Auth check**: `claude auth status --output-format json` — returns `{loggedIn: boolean, authMethod: string}`
2. **Auth method types**: `"oauth_token"`, `"api_key"` — Claude-specific
3. **Binary distribution**: GCS bucket `claude-code-dist-*` with platform-specific binaries
4. **Install flow**: Downloads binary → SHA256 verify → `claude install` for shell integration
5. **Version parsing**: `"2.1.59 (Claude Code)"` format
6. **Preflight auth check**: Runs `claude -p "PONG"` to verify auth works

### Abstraction Approach
```typescript
interface CliInstallerProvider {
  getLatestVersion(): Promise<string>;
  downloadBinary(platform: CliPlatform): Promise<string>;  // returns temp path
  installBinary(binaryPath: string): Promise<void>;
  checkVersion(binaryPath: string): Promise<string>;
  checkAuth(binaryPath: string): Promise<AuthStatus>;
}
```

---

## 7. MCP Integration

**Coupling: 5/10 | Effort: Low**

### Specific Files
- `src/main/services/team/TeamMcpConfigBuilder.ts` — builds MCP config JSON for team processes
- `src/main/services/extensions/install/McpInstallService.ts` — installs MCP servers
- `src/shared/types/extensions/mcp.ts` — MCP types
- `mcp-server/` — built-in MCP server for the app

### What's Claude-specific
1. **Config file location**: `.claude.json` in home dir, `.mcp.json` in project
2. **CLI flag**: `--mcp-config` to pass config path to CLI
3. **Config format**: Standard MCP format (`{mcpServers: {name: {command, args}}}`)
4. **Built-in server**: `mcp-server/` is our own — not Claude-specific

### What's NOT Claude-specific
MCP (Model Context Protocol) is becoming a cross-vendor standard. The protocol itself is vendor-neutral. The config format may vary by agent but the server implementation is portable.

### Abstraction Approach
MCP is already the most abstracted area. The only coupling is the config file naming (`.claude.json`) and the `--mcp-config` flag. A provider interface would specify how to pass MCP config to the CLI.

---

## 8. UI Components

**Coupling: 6/10 | Effort: Medium**

### Specific Files
- `src/renderer/index.html` — title "Claude Agent Teams UI"
- `src/renderer/components/common/ErrorBoundary.tsx` — CSS classes `bg-claude-dark-bg`, `text-claude-dark-text`
- `src/renderer/components/team/ClaudeLogsDialog.tsx`, `ClaudeLogsPanel.tsx`, `ClaudeLogsSection.tsx`, `ClaudeLogsFilterPopover.tsx`, `useClaudeLogsController.ts` — "Claude Logs" feature naming
- `src/renderer/types/claudeMd.ts` — CLAUDE.md tracking types
- `src/renderer/utils/claudeMdTracker.ts` (70 occurrences) — CLAUDE.md context tracking
- `src/renderer/utils/contextTracker.ts` (56 occurrences) — references CLAUDE.md sources
- `src/renderer/components/chat/SessionContextPanel/` — CLAUDE.md section
- `src/renderer/components/settings/sections/GeneralSection.tsx` (69 occurrences) — "Claude Root" settings
- `src/renderer/components/dashboard/CliStatusBanner.tsx` — "Claude CLI" status
- `src/renderer/index.css` — comments mentioning "Claude Code"
- `src/shared/constants/cli.ts` — `CLI_NOT_FOUND_MESSAGE = 'Claude CLI not found...'`

### What's Claude-specific
1. **Branding strings**: "Claude Agent Teams UI", "Claude CLI", "Claude Logs", "Claude Root"
2. **CSS theme variables**: `claude-dark-bg`, `claude-dark-text`, `claude-dark-border`, `claude-dark-surface` in ErrorBoundary
3. **CLAUDE.md feature**: The entire CLAUDE.md tracking system (types, tracker, UI) is Claude Code specific
4. **"Claude Logs"**: 5+ components for viewing CLI logs named "ClaudeLogs*"
5. **Settings**: "Local Claude Root" setting for `~/.claude` override

### What's NOT Claude-specific
- Chat rendering (UserChunk, AIChunk, SystemChunk) is generic
- Kanban board UI is generic
- Team member list, task management UI is generic
- Tool call visualization is generic (tool_use/tool_result pattern is shared across LLM providers)

### Abstraction Approach
1. Replace hardcoded strings with a config/branding module
2. Rename `ClaudeLogs*` → `CliLogs*` or `AgentLogs*`
3. Rename `claudeMdTracker` → `instructionFileTracker` (provider specifies filename pattern)
4. CSS variable renaming is mechanical (`claude-dark-*` → `app-dark-*`)
5. "Claude Root" → "Agent Data Directory"

---

## 9. Types / Interfaces

**Coupling: 8/10 | Effort: High**

### Specific Files
- `src/main/types/jsonl.ts` — `ChatHistoryEntry` union follows Claude Code JSONL exactly
- `src/main/types/messages.ts` — `ParsedMessage` with Claude-specific fields (`isMeta`, `isSidechain`, `isCompactSummary`)
- `src/main/types/domain.ts` — `MessageType`, `TokenUsage` with `cache_read_input_tokens`
- `src/shared/types/team.ts` — Team types entirely Claude Agent Teams specific
- `src/shared/types/api.ts` — API surface exposes Claude-specific session/team types
- `src/shared/utils/modelParser.ts` — parses `claude-*` model strings only
- `src/shared/utils/pricing.ts` — pricing data is Claude/Anthropic model centric

### What's Claude-specific
1. **Content block types**: `thinking` with `signature` field — Anthropic extended thinking
2. **Token usage fields**: `cache_read_input_tokens`, `cache_creation_input_tokens` — Anthropic prompt caching
3. **Model string format**: `claude-{family}-{major}-{minor}-{date}` and old `claude-{major}-{family}-{date}`
4. **Model families**: `sonnet`, `opus`, `haiku` — Anthropic model names
5. **`isMeta`/`isSidechain`**: Claude Code's internal conventions
6. **`stop_reason` values**: `end_turn`, `tool_use`, `max_tokens`, `stop_sequence`
7. **Pricing data**: `resources/pricing.json` is Anthropic-model-only (includes Bedrock/Vertex variants)

### Abstraction Approach
The `ParsedMessage` type is actually fairly close to a generic representation. Key changes:
- Make `thinking` content optional/provider-specific
- Generalize token usage (some fields are Anthropic-specific)
- `modelParser.ts` needs a provider-aware implementation
- Pricing needs multi-provider support (or provider-supplied pricing)

---

## 10. Configuration

**Coupling: 7/10 | Effort: Medium**

### Specific Files
- `src/main/services/infrastructure/ConfigManager.ts` — stores config in `~/.claude/claude-devtools-config.json`
- `src/main/utils/cliEnv.ts` — sets `CLAUDE_CONFIG_DIR` env var
- `src/main/utils/pathDecoder.ts` — `getClaudeBasePath()` with override support
- `src/shared/utils/cliArgsParser.ts` — `PROTECTED_CLI_FLAGS` are Claude CLI flags
- `src/main/ipc/config.ts` — configuration IPC handlers
- `src/main/services/team/TeamMcpConfigBuilder.ts` — `.claude.json` user MCP config

### What's Claude-specific
1. **Config dir**: `~/.claude/` as base
2. **Config filename**: `claude-devtools-config.json`
3. **Env vars**: `CLAUDE_CONFIG_DIR`, `CLAUDE_CLI_PATH`, `CLAUDE_HOOK_JUDGE_MODE`
4. **Protected flags**: `--input-format`, `--output-format`, `--setting-sources`, `--mcp-config`, `--disallowedTools`, `--verbose`
5. **Settings sources**: `user,project,local` — Claude CLI setting hierarchy
6. **User config files**: `.claude.json` (MCP), `~/.claude/settings.json`

### Abstraction Approach
Already partially abstracted (`setClaudeBasePathOverride` exists). Extend:
```typescript
interface ProviderConfig {
  basePath: string;
  configFileName: string;
  envVars: Record<string, string>;
  protectedFlags: Set<string>;
  settingSources?: string;
}
```

---

## Additional Coupling: `agent-teams-controller` Package

**Coupling: 10/10 | Effort: High**

The `agent-teams-controller/` workspace package is a pure JS module that directly reads/writes Claude Code's team filesystem:
- `runtimeHelpers.js`: `getPaths()` returns `~/.claude/teams/{name}/`, `~/.claude/tasks/{name}/`
- `context.js`: `createControllerContext({teamName, claudeDir})`
- `tasks.js`, `kanban.js`, `review.js`, `messages.js`, etc. — all operate on Claude's file structures

This package would need to be either:
- Made provider-aware (different file layouts per provider)
- Replaced with a generic team data layer

---

## Estimated Overall Effort for Full Abstraction

| Phase | Scope | Estimated Effort |
|---|---|---|
| **Phase 1**: Session viewing only | Path abstraction + JSONL parser + model parser | 2-3 weeks |
| **Phase 2**: UI de-branding | Rename strings, CSS vars, component names | 1 week |
| **Phase 3**: CLI provider interface | Binary resolution + auth + install | 2 weeks |
| **Phase 4**: Protocol abstraction | stream-json → generic protocol layer | 3-4 weeks |
| **Phase 5**: Team management abstraction | Generic orchestration layer | 4-8 weeks |
| **Total** | Full multi-provider support | 12-18 weeks |

---

## Recommended Abstraction Strategy

### Priority Order (what to do first)

1. **Paths first** (low risk, high reward) — `pathDecoder.ts` already has override support. Make `getBasePath()` provider-aware. This unblocks session viewing for other agents.

2. **Session parser second** — Create `SessionDataProvider` interface. The existing `ParsedMessage` type works as the normalized target. Each provider implements a parser FROM their raw format TO `ParsedMessage`.

3. **Model/pricing third** — Make `parseModelString()` and pricing lookup provider-aware. Use a registry pattern where each provider registers its models.

4. **CLI provider fourth** — Abstract binary resolution, auth, install, spawning. This is where protocol differences become critical.

5. **Team management last** — This is the hardest and most Claude-specific feature. Consider keeping it as a Claude-only feature initially.

### What's Hardest

1. **stream-json protocol** — This is Claude Code's proprietary stdin/stdout protocol. Other agents use completely different paradigms (OpenAI Codex uses sandboxed REST API, Gemini CLI may use different protocol). Abstracting this requires a fundamental architectural decision about how the app communicates with agents.

2. **Agent Teams** — No other CLI agent has an equivalent feature. The entire team management subsystem (~35 service files, ~65 IPC handlers, controller package) is built around Claude Code's Agent Teams. Supporting multi-agent orchestration for other providers would essentially mean building this from scratch.

3. **JSONL session format** — Claude Code's JSONL format is deeply embedded in the codebase (types, parsers, chunk builders, context trackers). While `ParsedMessage` serves as a reasonable intermediary, the raw parsing layer touching 10+ files would need provider-specific implementations.

### What's Easiest

1. **MCP** — Already vendor-neutral. Only config file naming and CLI flag need adjustment.
2. **UI branding** — Mechanical string/CSS replacement.
3. **Path configuration** — Override mechanism already exists.

---

## Architecture Diagram: Provider-Agnostic Layer

```
┌─────────────────────────────────────────────────────────────┐
│                        Renderer (UI)                        │
│  Components (generic)  │  Store (generic)  │  Types (generic)│
└────────────────────────────┬────────────────────────────────┘
                             │ IPC
┌────────────────────────────┴────────────────────────────────┐
│                    Provider Manager                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
│  │ Session   │  │ CLI      │  │ Team     │                  │
│  │ Provider  │  │ Provider │  │ Provider │  ← Interfaces    │
│  └─────┬────┘  └─────┬────┘  └─────┬────┘                  │
│        │              │              │                       │
│  ┌─────┴────┐  ┌─────┴────┐  ┌─────┴────────┐             │
│  │ Claude   │  │ Claude   │  │ Claude Agent  │             │
│  │ JSONL    │  │ CLI      │  │ Teams         │  ← Impls    │
│  │ Parser   │  │ Spawner  │  │ Orchestrator  │             │
│  └──────────┘  └──────────┘  └──────────────┘             │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐             │
│  │ Codex    │  │ Codex    │  │ (not          │             │
│  │ Session  │  │ CLI      │  │  supported)   │  ← Future   │
│  │ Parser   │  │ Spawner  │  │               │             │
│  └──────────┘  └──────────┘  └──────────────┘             │
└─────────────────────────────────────────────────────────────┘
                             │
┌────────────────────────────┴────────────────────────────────┐
│                    Data Path Provider                        │
│  ~/.claude/  │  ~/.codex/  │  ~/.gemini/  │  etc.           │
└─────────────────────────────────────────────────────────────┘
```

### Key Interfaces

```
CliProvider
├── resolveBinaryPath() → string | null
├── buildSpawnArgs(opts) → string[]
├── buildEnv(binary) → ProcessEnv
├── checkAuth(binary) → AuthStatus
├── getKillSignal() → Signals
└── getProtocolFlags() → string[]

CliProtocol
├── formatInputMessage(text) → string
├── parseOutputLine(line) → ParsedOutput
├── isSuccess(msg) → boolean
├── isError(msg) → boolean
└── isToolApproval(msg) → ToolApproval | null

SessionDataProvider
├── parseSessionFile(path) → AsyncIterable<ParsedMessage>
├── getSessionPaths(basePath) → string[]
├── getSubagentPaths(sessionPath) → string[]
└── encodeProjectPath(path) → string

DataPathProvider
├── getBasePath() → string
├── getProjectsPath() → string
├── getTeamsPath() → string | null
├── getSessionFilePath(project, session) → string
└── getConfigFilePath() → string

TeamOrchestrator (optional per provider)
├── supportsTeams: boolean
├── createTeam(request) → TeamCreateResponse
├── launchTeam(request) → TeamLaunchResponse
├── sendMessage(team, request) → SendMessageResult
└── stopTeam(teamName) → void

ModelInfoProvider
├── parseModelString(model) → ModelInfo | null
├── getModelFamilies() → string[]
├── getPricing(model) → Pricing | null
└── getContextWindow(model) → number

InstructionFileProvider
├── getFilename() → string  // "CLAUDE.md", ".codexrc", etc.
├── getGlobalPath() → string
├── getProjectPath(projectDir) → string
└── getSourceTypes() → string[]
```

---

## Conclusion

The codebase is deeply coupled to Claude Code at approximately 8.3/10 overall. The coupling is most severe in:
1. **Team management** (10/10) — Claude Agent Teams is a unique feature with no equivalent
2. **Protocol** (10/10) — stream-json is proprietary
3. **Session data** (9/10) — JSONL format, path encoding, file structure
4. **Process management** (9/10) — Claude binary, flags, kill semantics

The most pragmatic path to multi-provider support would be a phased approach starting with session viewing (paths + JSONL parser abstraction), which delivers value with ~3 weeks effort, before tackling the much harder protocol and team management layers.

Full abstraction to support other agents with team management would require 12-18 weeks of focused effort, with the protocol and team management layers being the primary engineering challenges.
