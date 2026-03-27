# Competitor Agent Spawn Patterns Research

**Date**: 2026-03-25

## Executive Summary

Все 4 конкурента построили собственные adapter-слои для spawning CLI-агентов. Ни один не использует готовую библиотеку. Паттерн единый: **интерфейс/trait + per-agent реализация + config-driven overrides**.

Самый зрелый и переиспользуемый паттерн у **vibe-kanban** (Rust trait `StandardCodingAgentExecutor` + `enum_dispatch` + ACP harness). У **Emdash** паттерн проще (per-service TypeScript классы + auto-discovery). **Dorothy** самый примитивный (node-pty напрямую). **Superset** закрыт ELv2 лицензией.

---

## 1. Vibe Kanban (BloopAI)

**Repo**: [github.com/BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban)
**Язык**: Rust (backend) + TypeScript (frontend)
**Лицензия**: Apache-2.0
**Stars**: ~23K
**Поддерживаемые агенты**: Claude Code, Codex, Gemini CLI, Copilot, Amp, Cursor, OpenCode, Droid, QwenCode, Qoder

### Архитектура

Самый архитектурно зрелый подход среди конкурентов.

**Ядро** — Rust trait + enum_dispatch:

```rust
#[async_trait]
#[enum_dispatch(CodingAgent)]
pub trait StandardCodingAgentExecutor {
    async fn spawn(&self, current_dir: &Path, prompt: &str,
                   env: &ExecutionEnv) -> Result<SpawnedChild, ExecutorError>;

    async fn spawn_follow_up(&self, current_dir: &Path, prompt: &str,
                             session_id: &str, reset_to_message_id: Option<&str>,
                             env: &ExecutionEnv) -> Result<SpawnedChild, ExecutorError>;

    async fn spawn_review(&self, current_dir: &Path, prompt: &str,
                          session_id: Option<&str>, env: &ExecutionEnv)
                          -> Result<SpawnedChild, ExecutorError>;
}
```

**Dispatch через enum** (compile-time, zero-cost):

```rust
#[enum_dispatch]
#[derive(Clone, Serialize, Deserialize, PartialEq, TS, Display)]
pub enum CodingAgent {
    ClaudeCode, Amp, Gemini, Codex, Opencode,
    CursorAgent, QwenCode, Copilot, Droid, QaMock
}
```

### Структура файлов

```
crates/executors/src/
  executors/
    mod.rs              — trait + enum_dispatch + CodingAgent enum
    claude.rs           — ClaudeCode executor
    gemini.rs           — Gemini executor (через ACP harness)
    codex.rs            — Codex executor
    amp.rs              — Amp executor
    copilot.rs          — GitHub Copilot
    cursor.rs           — Cursor Agent
    opencode.rs         — OpenCode
    droid.rs            — Droid (factory.ai)
    qwen.rs             — QwenCode
    qa_mock.rs          — Mock для тестов
    utils.rs            — Общие утилиты
    acp/                — ACP (Agent Communication Protocol) harness
      mod.rs
      client.rs         — ACP client
      harness.rs        — Spawn + session lifecycle
      session.rs        — Session management
      normalize_logs.rs — Log normalization
    claude/             — Claude-specific subdirectory
    codex/              — Codex-specific subdirectory
    cursor/             — Cursor-specific subdirectory
    droid/              — Droid-specific subdirectory
    opencode/           — OpenCode-specific subdirectory
  command.rs            — CommandBuilder (base cmd + params + overrides)
  env.rs                — ExecutionEnv (env vars, repo context)
  executor_discovery.rs — Auto-discovery + caching
  mcp_config.rs         — MCP server config per agent
  model_selector.rs     — Model selection logic
  profile.rs            — Agent profiles (DEFAULT, APPROVALS variants)
  approvals.rs          — Permission/approval system
  stdout_dup.rs         — Stdout duplication utilities
  lib.rs                — Crate root
```

### Как добавить нового агента (на примере Qoder PR #1759)

1. `crates/executors/src/executors/qoder.rs` — реализация trait
2. `mod.rs` — добавить в `CodingAgent` enum
3. `mcp_config.rs` — MCP Passthrough adapter
4. `default_profiles.json` — профили (DEFAULT/APPROVALS)
5. `generate_types.rs` — ts-rs type generation
6. `shared/types.ts` — TypeScript enum (автогенерация)
7. `shared/schemas/qoder.json` — JSON schema
8. `docs/agents/qoder.mdx` — документация

### Пример: Gemini executor

```
Base command: "npx -y @google/gemini-cli@0.29.3"
Flags: --experimental-acp, --model <name>, --yolo (if auto mode)
Harness: AcpAgentHarness — manages spawn, follow-up, session lifecycle
Output: ACP protocol (structured agent communication)
```

### Ключевые паттерны

- **CommandBuilder** (builder pattern): base cmd → params → overrides → platform-specific split → CommandParts
- **ExecutionEnv**: HashMap<String, String> env vars + repo context, inject into tokio::Command
- **CmdOverrides**: replace base cmd / append params / set env vars (per-profile)
- **ACP Harness**: shared session/spawn logic for ACP-compatible agents (Gemini, Qoder, etc.)
- **executor_discovery**: async discovery + caching по (path, command_key, agent_type)
- **ts-rs**: Rust types → TypeScript types автогенерация

### Оценка

| Метрика | Значение |
|---------|----------|
| LOC adapter layer | ~2000-3000 (весь crate executors) |
| Паттерн | trait + enum_dispatch + CommandBuilder |
| Сложность добавления агента | ~150-200 LOC per agent |
| Можно переиспользовать? | Нет (Rust, другой стек) |
| Можно скопировать паттерн? | ДА — отличный reference |
| Надёжность подхода | 9/10 |

---

## 2. Emdash (General Action)

**Repo**: [github.com/generalaction/emdash](https://github.com/generalaction/emdash)
**Язык**: TypeScript (Electron)
**Лицензия**: MIT
**Stars**: ~6K
**YC W26**
**Поддерживаемые агенты**: 22+ (Claude Code, Codex, Gemini, Amp, Cursor, Copilot, Goose, Droid, Kiro, Qwen, OpenCode, Cline, Continue, Codebuff, Charm, Kilocode, Kimi, Autohand, Auggie, Rovo Dev, Mistral Vibe, Pi)

### Архитектура

Per-service TypeScript классы + auto-discovery. Самый близкий к нашему стеку.

**Ключевые файлы**:

```
src/main/services/
  CodexService.ts         — Manages Codex CLI child processes + log streaming
  CodexSessionService.ts  — Session management for Codex
  ClaudeConfigService.ts  — Claude-specific configuration
  ClaudeHookService.ts    — Claude hooks integration
  AgentEventService.ts    — Agent lifecycle events
  TaskLifecycleService.ts — Task state machine
  WorkspaceProviderService.ts — Provider workspace management
  TerminalConfigParser.ts — CLI terminal config detection
  ptyManager.ts           — PTY session management (node-pty)
  ptyIpc.ts               — PTY IPC communication
  ConnectionsService.ts   — Connection management
  RepositoryManager.ts    — Git repository management
  ProjectSettingsService.ts
  DatabaseService.ts      — SQLite (drizzle)
  AutoUpdateService.ts
  __tests__/              — Tests
  fs/                     — File system services
  git-core/               — Git operations
  mcp/                    — MCP protocol
  skills/                 — Skills system
  ssh/                    — SSH remote development
```

### Как добавить провайдера (из документации)

1. Include: provider name, CLI invocation command, auth notes, setup steps
2. Team wires up provider selection in UI and adds to Integrations matrix
3. Providers auto-detected when CLI is in PATH

### Spawn-паттерн

- `node:child_process.spawn()` для CLI агентов
- `node-pty` для terminal sessions
- Per-service классы (CodexService, ClaudeConfigService)
- `TerminalConfigParser` для auto-detection CLI в PATH
- `AgentEventService` для lifecycle events (running/waiting/completed/error)
- SQLite (drizzle ORM) для персистенции

### Ключевые особенности

- **Auto-discovery**: провайдеры детектятся автоматически по наличию CLI в PATH
- **Native deps**: sqlite3, node-pty, keytar (rebuilt per Electron version)
- **Worktree isolation**: каждый агент в своём git worktree
- **SSH remote**: агенты могут работать на удалённых машинах через SSH/SFTP
- **Best-of-N**: запуск нескольких агентов на одну задачу, выбор лучшего

### Оценка

| Метрика | Значение |
|---------|----------|
| LOC adapter layer | ~1500-2000 (services + pty) |
| Паттерн | Per-service classes + auto-discovery |
| Сложность добавления агента | Средняя (новый service file) |
| Можно переиспользовать код? | Потенциально ДА (MIT, TypeScript, Electron) |
| Можно скопировать паттерн? | ДА — очень близко к нашему стеку |
| Надёжность подхода | 7/10 (less structured than vibe-kanban) |

---

## 3. Dorothy (Charlie85270)

**Repo**: [github.com/Charlie85270/Dorothy](https://github.com/Charlie85270/Dorothy)
**Язык**: TypeScript (Electron + Next.js)
**Лицензия**: MIT
**Stars**: ~3K
**Поддерживаемые агенты**: Claude Code (primarily), расширяется

### Архитектура

Самый простой подход — node-pty напрямую, без абстракции adapter layer.

```
electron/
  agent-manager.ts    — Agent lifecycle & parallel execution (node-pty)
  pty-manager.ts      — Terminal session multiplexing
  window-manager.ts   — Window management
  services/
    telegram-bot
    slack-bot
    kanban-automation
    mcp-server-launcher
    api-server
mcp-orchestrator/     — Super Agent MCP server
mcp-kanban/           — Kanban automation MCP
```

### Spawn-паттерн

- `node-pty` — каждый агент в изолированной PTY-сессии
- Статус определяется парсингом stdout patterns (running/waiting/completed/error)
- N параллельных агентов с отдельными проектами
- Super Agent (мета-агент) контролирует другие через MCP tools
- Cron-based scheduling для повторяющихся задач
- Skills system для extensibility

### Ключевые особенности

- **Нет абстракции агентов**: привязан к Claude Code, нет interface для разных CLI
- **Kanban**: задачи → колонки → automatic agent assignment по skills
- **Automations**: GitHub PR/issue polling → agent spawning
- **Remote control**: Telegram/Slack bot для управления

### Оценка

| Метрика | Значение |
|---------|----------|
| LOC adapter layer | ~500-800 (agent-manager + pty-manager) |
| Паттерн | Direct node-pty, no abstraction |
| Сложность добавления агента | Высокая (нет interface) |
| Можно переиспользовать код? | Да (MIT), но мало что полезного |
| Можно скопировать паттерн? | НЕТ — слишком примитивный |
| Надёжность подхода | 5/10 |

---

## 4. Superset (superset-sh)

**Repo**: [github.com/superset-sh/superset](https://github.com/superset-sh/superset)
**Язык**: TypeScript (Electron, monorepo Turborepo + Bun)
**Лицензия**: Elastic License 2.0 (ELv2) — НЕ open-source!
**Stars**: ~7.8K
**Поддерживаемые агенты**: Claude Code, Codex, Aider, Copilot, Cursor Agent, Gemini CLI, OpenCode + custom

### Архитектура

Monorepo с 6 apps. Multi-process Electron с 5 entry points:

```
apps/desktop/src/
  main/
    index.ts              — Main app entry
    terminal-host/
      index.ts            — Persistent daemon for terminal sessions
    pty-subprocess.ts     — PTY handler (node-pty)
    git-task-worker.ts    — Worker thread for Git ops
    host-service/
      index.ts            — Local HTTP server

packages/
  @superset/trpc          — tRPC routers
  @superset/ui            — Shared React components
  @superset/local-db      — SQLite (Drizzle)
  @superset/db            — PostgreSQL (Neon, cloud sync)
```

### Spawn-паттерн

- **Terminal Host daemon**: persistent subprocess managing terminal sessions
- **PTY subprocess**: node-pty forked on-demand
- **Git Worker**: heavy git ops offloaded to worker_threads
- **tRPC over Electron IPC**: renderer ↔ main communication
- **Worktree isolation**: каждая задача в своём git worktree с уникальным branch
- **Port allocation**: SUPERSET_PORT_BASE + 20 портов на workspace

### Ключевые особенности

- **Multi-process**: 5 entry points, daemon-based terminal management
- **Dual DB**: local SQLite + cloud PostgreSQL (ElectricSQL sync)
- **Better Auth**: OAuth deep links для десктопа
- **.superset/config.json**: workspace setup/teardown scripts

### Оценка

| Метрика | Значение |
|---------|----------|
| LOC adapter layer | Неизвестно (code not browsable) |
| Паттерн | Multi-process + terminal-host daemon |
| Сложность добавления агента | Неизвестно |
| Можно переиспользовать код? | НЕТ (Elastic License 2.0) |
| Можно скопировать паттерн? | Частично (terminal-host daemon idea) |
| Надёжность подхода | 8/10 (production, enterprise users) |

---

## CLI Agent Programmatic Spawn Reference

### Claude Code

```bash
claude --input-format stream-json --output-format stream-json --verbose
```

- **Bidirectional NDJSON protocol** over stdin/stdout
- Message types: `initialize`, `user`, `control_response`
- `--verbose` REQUIRED with stream-json
- `--print` mode for one-shot (no multi-turn)
- Session hooks do NOT run in `--print` mode
- Official docs: [incomplete](https://github.com/anthropics/claude-code/issues/24594) — community reverse-engineered
- VS Code extension spawns: `claude --output-format stream-json --verbose --input-format stream-json --max-thinking-tokens 0 --model default --permission-prompt-tool stdio`

### Codex (OpenAI)

```bash
codex exec --json "prompt"
```

- **JSONL output** (one event per line)
- Event types: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`
- Item types: agent_message, reasoning, command_exec, file_change, mcp_tool_call
- `--output-schema` for structured final output
- `codex exec resume --json` for session resumption
- **App-server mode**: `codex app-server` — stateful JSON-RPC over stdio
- Auth: `CODEX_API_KEY` env var for non-interactive
- Schema BREAKING CHANGES between versions (item_type → type, assistant_message → agent_message)

### Gemini CLI (Google)

```bash
gemini -p "prompt" --output-format json
# or streaming:
gemini -p "prompt" --output-format stream-json
```

- `-p` flag for non-interactive headless mode
- `--output-format json` — full response + stats
- `--output-format stream-json` — real-time JSONL events
- `--yolo` — auto-approve all tool calls
- `--experimental-acp` — Agent Communication Protocol (used by vibe-kanban)
- **Known issues**: response field may contain markdown-wrapped JSON instead of clean JSON
- Stdin piping supported for additional context

### Amp (Sourcegraph)

```bash
amp --execute "prompt" --stream-json
```

- `--stream-json` — JSONL output (REQUIRES `--execute`)
- `--stream-json-input` — JSONL input via stdin (REQUIRES `--stream-json`)
- `--stream-json-thinking` — includes thinking blocks (extends schema)
- **Claude Code compatible format** (mostly)
- Multi-turn: `amp threads continue [thread-id]` + `--stream-json-input`
- Auth: `AMP_API_KEY` env var for CI/CD
- Elixir SDK exists as reference: spawns CLI + parses stream-json

### Goose (Block)

```bash
goose run -t "prompt"
# or from file:
goose run -i instructions.md
```

- `goose run` — non-interactive one-shot mode
- `--output-format json` — [feature request #4419, marked Done](https://github.com/block/goose/issues/4419)
- `--format json` — for session/recipe listing
- Max 10 concurrent subagents (hard-coded)
- 5 min default timeout, 25 max turns
- `GOOSE_SUBAGENT_MAX_TURNS` env override

---

## Сравнительная таблица

| | Vibe Kanban | Emdash | Dorothy | Superset |
|---|---|---|---|---|
| **Язык** | Rust | TypeScript | TypeScript | TypeScript |
| **Лицензия** | Apache-2.0 | MIT | MIT | ELv2 |
| **Используют готовую библиотеку?** | Нет | Нет | Нет | Нет |
| **Паттерн** | trait + enum_dispatch | Per-service classes | Direct node-pty | Multi-process daemon |
| **Абстракция агентов** | `StandardCodingAgentExecutor` trait | Per-service (CodexService, etc.) | Нет | Terminal-host daemon |
| **Количество агентов** | 10+ | 22+ | 1 (Claude) | 8+ |
| **Сложность добавления** | ~150-200 LOC | ~300-500 LOC | Hard (no interface) | Unknown |
| **LOC adapter layer** | ~2000-3000 | ~1500-2000 | ~500-800 | Unknown |
| **Auto-discovery** | Да (executor_discovery) | Да (PATH detection) | Нет | Unknown |
| **MCP support** | Passthrough per agent | Да | MCP servers | Да |
| **ACP protocol** | Да (shared harness) | Нет | Нет | Нет |
| **Type generation** | ts-rs (Rust → TS) | N/A | N/A | N/A |
| **Isolation** | Git worktrees | Git worktrees | Separate projects | Git worktrees |
| **Можно reuse код?** | Нет (Rust) | Да (MIT, TS) | Да (MIT) | Нет (ELv2) |

---

## Выводы и рекомендации для Claude Agent Teams UI

### 1. Какой паттерн взять за основу?

**Рекомендация: гибрид vibe-kanban + emdash подходов**

От vibe-kanban взять:
- **Interface (trait) + per-agent implementation** — TypeScript interface вместо Rust trait
- **CommandBuilder pattern** — построение команды через builder с overrides
- **ExecutionEnv** — управление env vars + repo context
- **Profile system** — DEFAULT/APPROVALS варианты per agent
- **enum-dispatch idea** — в TS реализуется через discriminated union + factory

От Emdash взять:
- **Auto-discovery** — детекция CLI в PATH
- **Per-service approach** — но с общим interface
- **node-pty integration** — для terminal sessions

### 2. Предлагаемый TypeScript interface

```typescript
interface AgentExecutor {
  readonly agentType: AgentType; // discriminated union tag

  spawn(params: SpawnParams): Promise<SpawnedAgent>;
  spawnFollowUp(params: FollowUpParams): Promise<SpawnedAgent>;
  spawnReview?(params: ReviewParams): Promise<SpawnedAgent>;

  discover(): Promise<DiscoveredOptions>;
  isAvailable(): Promise<boolean>;

  normalizeOutput(raw: string): string;
  parseEvent(line: string): AgentEvent | null;
}

interface SpawnParams {
  workDir: string;
  prompt: string;
  env: ExecutionEnv;
  model?: string;
  approvalMode: 'auto' | 'supervised';
  mcpConfig?: string;
}

interface SpawnedAgent {
  process: ChildProcess;
  sessionId: string;
  stdout: ReadableStream<AgentEvent>;
  stderr: ReadableStream<string>;
  kill(): Promise<void>;
  sendMessage(msg: string): Promise<void>;
}
```

### 3. Что НЕ стоит делать

- **Не использовать node-pty напрямую** (как Dorothy) — нет абстракции, сложно масштабировать
- **Не строить на Rust** (как vibe-kanban) — у нас TypeScript стек, overhead не оправдан
- **Не копировать multi-process daemon** (как Superset) — over-engineering для нашего случая
- **Не привязываться к одному протоколу** — у каждого CLI свой формат (stream-json, --json, --stream-json)

### 4. Приоритет агентов для поддержки

| Приоритет | Агент | Протокол | Сложность |
|-----------|-------|----------|-----------|
| P0 | Claude Code | stream-json bidirectional | Уже есть |
| P1 | Codex | `exec --json` JSONL | Средняя |
| P1 | Gemini CLI | `--output-format stream-json` | Средняя |
| P2 | Amp | `--execute --stream-json` | Средняя (CC-compatible) |
| P2 | Goose | `run -t` + `--output-format json` | Средняя |
| P3 | OpenCode | TBD | Исследовать |
| P3 | Cursor Agent | TBD | Исследовать |

---

## Источники

- [Vibe Kanban (BloopAI)](https://github.com/BloopAI/vibe-kanban) — Apache-2.0, 23K stars
- [Vibe Kanban AGENTS.md](https://github.com/BloopAI/vibe-kanban/blob/main/AGENTS.md)
- [Vibe Kanban executors crate](https://github.com/BloopAI/vibe-kanban/tree/main/crates/executors/src/executors)
- [Vibe Kanban PR #1759 — Qoder executor pattern](https://github.com/BloopAI/vibe-kanban/pull/1759)
- [Emdash (General Action)](https://github.com/generalaction/emdash) — MIT, 6K stars
- [Emdash Providers Documentation](https://docs.emdash.sh/providers)
- [Emdash AGENTS.md](https://github.com/generalaction/emdash/blob/main/AGENTS.md)
- [Dorothy (Charlie85270)](https://github.com/Charlie85270/Dorothy) — MIT, 3K stars
- [Superset (superset-sh)](https://github.com/superset-sh/superset) — ELv2, 7.8K stars
- [Superset DeepWiki Architecture](https://deepwiki.com/superset-sh/superset/1.1-architecture-overview)
- [Codex CLI Reference](https://developers.openai.com/codex/cli/reference)
- [Codex Non-Interactive Mode](https://developers.openai.com/codex/noninteractive)
- [Codex JSON output issues](https://github.com/openai/codex/issues/2288)
- [Gemini CLI Headless Mode](https://google-gemini.github.io/gemini-cli/docs/cli/headless.html)
- [Gemini CLI JSON issues](https://github.com/google-gemini/gemini-cli/issues/9009)
- [Amp Streaming JSON](https://ampcode.com/news/streaming-json)
- [Amp CLI Manual](https://ampcode.com/manual)
- [Goose CLI Commands](https://block.github.io/goose/docs/guides/goose-cli-commands/)
- [Goose JSON output request #4419](https://github.com/block/goose/issues/4419)
- [Claude Code stream-json docs gap #24594](https://github.com/anthropics/claude-code/issues/24594)
- [Claude Code Automation Skill (LobeHub)](https://lobehub.com/it/skills/coreyja-dotfiles-claude-code-automation)
