# Agent Client Protocol (ACP) — Deep Technical Analysis

> Дата исследования: 2026-03-24
> Контекст: интеграция ACP в Claude Agent Teams UI (Electron 40.x)

---

## 1. Что такое ACP?

**Agent Client Protocol (ACP)** — это открытый стандарт коммуникации между редакторами кода (IDE) и AI-агентами. Создан Zed Industries, поддерживается JetBrains с октября 2025.

**Аналогия:** LSP (Language Server Protocol) стандартизировал интеграцию языковых серверов с редакторами. ACP делает то же самое для AI coding agents.

**Проблема, которую решает:**
- Каждый редактор делал кастомную интеграцию для каждого агента (M x N)
- Агенты были привязаны к конкретным IDE
- ACP сводит M x N → M + N (агент реализует ACP один раз, работает во всех IDE)

**Лицензия:** Apache 2.0
**Governance:** Lead Maintainers — Ben Brandt (Zed Industries), Sergey Ignatov (JetBrains)

**Источники:**
- Спецификация: https://agentclientprotocol.com/
- GitHub: https://github.com/agentclientprotocol/agent-client-protocol
- Zed ACP: https://zed.dev/acp

> **ВАЖНО:** Существует ТРИ разных протокола с аббревиатурой ACP:
> 1. **Agent Client Protocol** (Zed/JetBrains) — редактор ↔ агент. **Это наш фокус.**
> 2. **Agent Communication Protocol** (IBM BeeAI) — агент ↔ агент. Сливается с A2A (Linux Foundation). Не релевантно.
> 3. **Agent Connect Protocol** (Agntcy Collective) — REST API для remote agents. Не релевантно.

---

## 2. Архитектура протокола

### 2.1 Транспорт

| Режим | Транспорт | Формат | Статус |
|-------|-----------|--------|--------|
| **Локальный** | stdio (stdin/stdout) | NDJSON (newline-delimited JSON) | Стабильный |
| **TCP** | TCP socket (порт) | NDJSON | Стабильный (Copilot CLI: `--acp --port 8080`) |
| **Remote** | HTTP / WebSocket | JSON-RPC | **Work in progress** |

Основной режим: **JSON-RPC 2.0 поверх NDJSON через stdio**. Клиент (IDE) spawn'ит агента как subprocess, stdin/stdout становятся транспортом.

### 2.2 Типы сообщений

Два типа (JSON-RPC 2.0):
- **Methods** — request-response пары, ожидают result или error
- **Notifications** — односторонние сообщения, без ответа

### 2.3 Lifecycle

```
Client                              Agent
  |                                   |
  |------- initialize --------------->|  (версия протокола + capabilities)
  |<------ InitializeResponse --------|  (agent capabilities)
  |                                   |
  |------- authenticate ------------->|  (если требуется)
  |<------ AuthenticateResponse ------|
  |                                   |
  |------- session/new --------------->|  (cwd, mcpServers[])
  |<------ NewSessionResponse ---------|  (sessionId)
  |                                   |
  |------- session/prompt ------------->|  (prompt content)
  |<~~~~~~ session/update (notification)| (streaming chunks, tool calls, plans)
  |<~~~~~~ session/update              |
  |<--request_permission --------------|  (tool approval)
  |------- permission response ------->|
  |<~~~~~~ session/update              |
  |<------ PromptResponse -------------|  (stopReason)
  |                                   |
  |------- session/prompt (next) ----->|
  |  ...                              |
```

### 2.4 Session Update Events (стриминг)

Во время `prompt` агент шлёт `session/update` notifications:

| Event | Описание |
|-------|----------|
| `agent_message_chunk` | Текстовый чанк от агента (streaming) |
| `agent_thought_chunk` | Мысли агента (thinking) |
| `user_message_chunk` | Эхо пользовательского ввода |
| `tool_call` | Новый вызов инструмента (pending/completed) |
| `tool_call_update` | Обновление статуса вызова инструмента |
| `plan` | План действий с приоритетами и статусами |
| `available_commands_update` | Обновление доступных команд |
| `config_option_update` | Изменение конфигурации |
| `current_mode_update` | Смена режима сессии |
| `session_info_update` | Метаданные сессии (title, activity) |
| `usage_update` | Потребление токенов (draft) |

### 2.5 Client-Provided Methods

Клиент (IDE) предоставляет агенту доступ к:

| Метод | Описание | Required? |
|-------|----------|-----------|
| `session/request_permission` | Запрос разрешения на выполнение инструмента | **Required** |
| `fs/read_text_file` | Чтение файла | Optional |
| `fs/write_text_file` | Запись файла | Optional |
| `terminal/create` | Создание терминала | Optional |
| `terminal/output` | Получение вывода терминала | Optional |
| `terminal/wait_for_exit` | Ожидание завершения | Optional |
| `terminal/kill` | Завершение процесса | Optional |
| `terminal/release` | Освобождение ресурсов | Optional |

### 2.6 MCP Integration

ACP переиспользует JSON-представления из MCP где возможно. Агент может принимать MCP сервера при создании сессии:

```typescript
connection.newSession({
  cwd: '/path/to/project',
  mcpServers: [
    { type: 'stdio', command: 'node', args: ['mcp-server.js'] },
    { type: 'http', url: 'https://mcp.example.com', headers: {} },
    { type: 'sse', url: 'https://mcp.example.com/sse', headers: {} },
  ],
});
```

---

## 3. TypeScript SDK — API Surface

### 3.1 Package Info

| Характеристика | Значение |
|----------------|----------|
| **npm** | `@agentclientprotocol/sdk` |
| **Версия** | 0.16.1 (март 2026) |
| **Размер** | 863 kB |
| **Dependencies** | **0** (zero dependencies!) |
| **Лицензия** | Apache-2.0 |
| **Dependents** | 245+ пакетов |
| **GitHub stars** | 122 |
| **Contributors** | 31 |
| **Commits** | 544 |
| **Used by** | 823+ проектов |

**Факт:** ранее публиковался как `@zed-industries/agent-client-protocol`, переименован.

### 3.2 Exported Classes (4)

```typescript
import {
  ClientSideConnection, // Для клиентов (IDE) — наш интерес
  AgentSideConnection,  // Для агентов (сервер)
  TerminalHandle,       // Управление терминалом
  RequestError,         // Типизированная ошибка
} from '@agentclientprotocol/sdk';
```

### 3.3 Exported Interfaces (2)

```typescript
interface Client {
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  sessionUpdate(params: SessionNotification): Promise<void>;
  writeTextFile?(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
  readTextFile?(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  // terminal methods...
}

interface Agent {
  initialize(params: InitializeRequest): Promise<InitializeResponse>;
  newSession(params: NewSessionRequest): Promise<NewSessionResponse>;
  authenticate?(params: AuthenticateRequest): Promise<AuthenticateResponse>;
  prompt(params: PromptRequest): Promise<PromptResponse>;
  cancel?(params: CancelNotification): Promise<void>;
  setSessionMode?(params: SetSessionModeRequest): Promise<SetSessionModeResponse>;
  // ...
}
```

### 3.4 Exported Functions (1) + Variables (3)

```typescript
// Единственная утилитарная функция — создаёт NDJSON stream
function ndJsonStream(input: WritableStream, output: ReadableStream): Stream;

// Константы
const PROTOCOL_VERSION: string;    // Текущая версия протокола
const AGENT_METHODS: string[];     // Список методов агента
const CLIENT_METHODS: string[];    // Список методов клиента
```

### 3.5 Type Aliases (~180+)

Полный список категорий типов:

- **Content:** `TextContent`, `ImageContent`, `AudioContent`, `Content`, `ContentBlock`, `ContentChunk`
- **Authentication:** `AuthMethod`, `AuthCapabilities`, `AuthenticateRequest/Response`
- **Sessions:** `SessionId`, `SessionInfo`, `SessionCapabilities`, `SessionUpdate`, `SessionMode`
- **Tools:** `ToolCall`, `ToolCallUpdate`, `ToolCallId`, `ToolCallStatus`, `ToolKind`
- **Permissions:** `RequestPermissionRequest/Response`, `PermissionOption`, `PermissionOptionKind`
- **Plans:** `Plan`, `PlanEntry`, `PlanEntryStatus`, `PlanEntryPriority`
- **Diffs:** `Diff` (`path`, `oldText`, `newText`)
- **File System:** `ReadTextFileRequest/Response`, `WriteTextFileRequest/Response`
- **Terminals:** `Terminal`, `CreateTerminalRequest/Response`, `TerminalExitStatus`
- **MCP:** `McpCapabilities`, `McpServer`, `McpServerStdio`, `McpServerHttp`, `McpServerSse`
- **Protocol:** `InitializeRequest/Response`, `PromptRequest/Response`, `StopReason`, `Cost`, `Usage`
- **Elicitation (draft):** `ElicitationRequest/Response`, `ElicitationSchema` — формы ввода от агента
- **Config:** `SessionConfigOption`, `SessionConfigBoolean`, `SessionConfigSelect`
- **Models:** `ModelId`, `ModelInfo`

### 3.6 ClientSideConnection — Full API

```typescript
class ClientSideConnection {
  constructor(toClient: (agent: Agent) => Client, stream: Stream);

  // Properties
  signal: AbortSignal;        // Aborts when connection closes
  closed: Promise<void>;      // Resolves when connection ends

  // Core methods
  initialize(params: InitializeRequest): Promise<InitializeResponse>;
  newSession(params: NewSessionRequest): Promise<NewSessionResponse>;
  prompt(params: PromptRequest): Promise<PromptResponse>;
  authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse>;

  // Session management
  loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse>;        // Resume previous
  listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse>;    // List available
  setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse>;
  setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse>;

  // Unstable/experimental
  unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse>;
  unstable_resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse>;
  unstable_closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse>;
  unstable_setSessionModel(params: SetSessionModelRequest): Promise<SetSessionModelResponse>;
  unstable_logout(params: LogoutRequest): Promise<LogoutResponse>;

  // Notifications
  cancel(params: CancelNotification): Promise<void>;   // Cancel ongoing prompt

  // Extensibility
  extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  extNotification(method: string, params: Record<string, unknown>): Promise<void>;
}
```

---

## 4. Какие агенты поддерживают ACP?

### Подтверждённые (с доказательствами)

| Агент | Поддержка ACP | Как реализовано | Источник |
|-------|--------------|-----------------|----------|
| **Gemini CLI** | Нативная (reference implementation) | Встроенный ACP-сервер | [zed.dev/acp](https://zed.dev/acp) |
| **Claude Code** | Через адаптер | `@zed-industries/claude-code-acp` (npm, Apache 2.0) | [GitHub](https://github.com/zed-industries/claude-agent-acp) |
| **Codex CLI** | Через community adapter | Zed adapter | [zed.dev/docs/ai/external-agents](https://zed.dev/docs/ai/external-agents) |
| **GitHub Copilot CLI** | Нативная (public preview) | `copilot --acp` / `copilot --acp --port 8080` | [GitHub Blog](https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/) |
| **Goose** (Block) | Нативная | Встроенный ACP-сервер | [goose blog](https://block.github.io/goose/blog/2025/10/24/intro-to-agent-client-protocol-acp/) |
| **Junie** (JetBrains) | Нативная | Встроена в JetBrains AI Assistant | [JetBrains](https://www.jetbrains.com/help/ai-assistant/acp.html) |
| **Cline** | Нативная | Встроенный ACP-сервер | [DeepWiki](https://deepwiki.com/cline/cline/12.5-agent-client-protocol-(acp)) |
| **Kiro CLI** | Нативная | Встроенный ACP-сервер | [Kiro docs](https://kiro.dev/docs/cli/acp/) |
| **OpenCode** | Нативная | Встроенный ACP-сервер | [opencode.ai](https://opencode.ai/docs/acp/) |
| **Augment Code** | Нативная | ACP Registry | [Registry](https://agentclientprotocol.com/registry) |
| **Qwen Code** | Нативная | ACP Registry | VS Code ACP Client |

**Claude Code НЕ имеет нативного `--acp` флага** (есть [Feature Request #6686](https://github.com/anthropics/claude-code/issues/6686)). Работает через `@zed-industries/claude-code-acp` адаптер, который использует Claude Agent SDK.

### IDE/Клиенты с ACP поддержкой

| Клиент | Статус |
|--------|--------|
| **Zed** | Нативная (создатели протокола) |
| **JetBrains** (IntelliJ, PyCharm и др.) | Нативная (co-maintainer) |
| **Neovim** | Через плагины (CodeCompanion, avante.nvim) |
| **Emacs** | Community extensions |
| **Marimo** (Python notebooks) | Встроенная |
| **VS Code** | **НЕТ** (ключевой вопрос для экосистемы) |
| **Cursor** | **НЕТ** (может появиться если будет спрос) |

---

## 5. Конкретный пример кода (из SDK)

### Client (IDE side)

```typescript
import { spawn } from 'node:child_process';
import { Writable, Readable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

class MyClient implements acp.Client {
  async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    // UI показывает dialog с params.options
    return {
      outcome: { outcome: 'selected', optionId: params.options[0].optionId },
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text') {
          console.log(update.content.text); // Streaming text
        }
        break;
      case 'tool_call':
        console.log(`Tool: ${update.title} (${update.status})`);
        break;
      case 'tool_call_update':
        console.log(`Tool ${update.toolCallId}: ${update.status}`);
        break;
      case 'plan':
        // Plan entries with status/priority
        break;
    }
  }

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const content = fs.readFileSync(params.path, 'utf-8');
    return { content };
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    fs.writeFileSync(params.path, params.content);
    return {};
  }
}

async function main() {
  // Spawn agent process
  const agentProcess = spawn('claude', ['--acp'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  // Create NDJSON stream over stdio
  const input = Writable.toWeb(agentProcess.stdin!);
  const output = Readable.toWeb(agentProcess.stdout!) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(input, output);

  // Create connection
  const client = new MyClient();
  const connection = new acp.ClientSideConnection((_agent) => client, stream);

  // Initialize
  const initResult = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: { create: true, output: true, kill: true },
    },
  });

  // Create session
  const session = await connection.newSession({
    cwd: '/path/to/project',
    mcpServers: [],
  });

  // Send prompt (blocks until agent completes turn)
  const result = await connection.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: 'Fix the bug in main.ts' }],
  });

  console.log(`Stop reason: ${result.stopReason}`); // 'end_turn' | 'cancelled' | ...
}
```

### Process spawning

**ACP SDK НЕ управляет spawn'ом процесса.** Это ответственность клиента. SDK берёт на себя только протокол поверх уже готового stream (stdin/stdout).

```typescript
// ACP SDK expects web streams:
const input = Writable.toWeb(childProcess.stdin!);   // WritableStream
const output = Readable.toWeb(childProcess.stdout!);  // ReadableStream<Uint8Array>
const stream = acp.ndJsonStream(input, output);       // ACP Stream
```

---

## 6. ACP vs MCP — Различия

| Аспект | MCP (Model Context Protocol) | ACP (Agent Client Protocol) |
|--------|-----|-----|
| **Создатель** | Anthropic | Zed Industries + JetBrains |
| **Фокус** | Инструменты/данные для модели | Коммуникация IDE ↔ агент |
| **Аналогия** | "Дать человеку лучшие инструменты" | "Собрать команду из людей" |
| **Отношение** | **Что** (доступ к данным/tools) | **Где** (где агент живёт в workflow) |
| **Протокол** | JSON-RPC 2.0 поверх stdio/SSE/HTTP | JSON-RPC 2.0 поверх NDJSON stdio |
| **Типы контента** | Tools, Resources, Prompts | Messages, Tool Calls, Plans, Diffs, Permissions |
| **Стейт** | Stateless на уровне протокола | Stateful (sessions, message history) |
| **Sessions** | Нет (транспортные сессии) | Да (conversation sessions с ID) |
| **Streaming** | Через SSE или notifications | session/update notifications |

**Ключевое:** ACP и MCP комплементарны. ACP-сессия может принимать MCP-серверы (`mcpServers` в `newSession`). Агент использует MCP для доступа к инструментам, а ACP для общения с IDE.

---

## 7. Зрелость и стабильность

### Версионирование

SDK на v0.16.1 (март 2026) — ещё **pre-1.0**. Много `unstable_` методов.

### Timeline ключевых событий

| Дата | Событие |
|------|---------|
| Сентябрь 2025 | Zed анонсирует ACP |
| Октябрь 2025 | JetBrains присоединяется |
| Октябрь 2025 | Gemini CLI — первая интеграция |
| Январь 2026 | Copilot CLI ACP public preview |
| Январь 2026 | ACP Registry запущен |
| Февраль 2026 | Session Config Options стабилизированы |
| Март 2026 | session/list + session_info_update стабилизированы |
| Март 2026 | SDK v0.16.1 |

### Что в Draft (ещё не стабилизировано)

- `session/close` — закрытие сессий
- `session/fork` — форк сессий
- `session/resume` — возобновление сессий
- Elicitation — формы ввода от агента
- Usage updates — статистика токенов
- Message IDs — идентификаторы сообщений
- Delete in Diff — удаление файлов через diff
- Next Edit Suggestions — предложения следующих правок

### Breaking Changes

Протокол на стадии 0.x — breaking changes возможны между минорными версиями. Rename пакета `@zed-industries/agent-client-protocol` → `@agentclientprotocol/sdk` уже произошёл.

---

## 8. Анализ интеграции в наш Electron app

### 8.1 Текущая архитектура (как мы работаем сейчас)

Наш стек коммуникации с Claude Code:

```
Electron Main Process
  └── TeamProvisioningService
        ├── spawnCli() → ChildProcess (stream-json)
        ├── stdin.write(NDJSON) → Claude CLI
        ├── stdout → parse NDJSON lines
        │    ├── type: "user" / "assistant" / "result" / "system"
        │    ├── type: "control_request" (tool approval)
        │    └── result.success → turn complete
        └── stderr → logs, error detection
```

**Ключевые аргументы CLI:**
```
--input-format stream-json --output-format stream-json
```

**Наша обработка:**
- `HANDLED_STREAM_JSON_TYPES = ['user', 'assistant', 'control_request', 'result', 'system']`
- `stdin.write(message + '\n')` — отправка
- Ручной парсинг NDJSON с carry buffer для неполных строк
- `control_request` → UI dialog для tool approval
- `result.success` → turn complete, process alive
- SIGKILL для остановки (SIGTERM вызывает cleanup)

### 8.2 Что ACP заменил бы

| Компонент | Сейчас (stream-json) | С ACP |
|-----------|---------------------|-------|
| **Spawn** | `spawnCli()` | Остаётся наш `spawnCli()` |
| **Transport** | Ручной NDJSON парсинг с carry buffer | `acp.ndJsonStream()` + `ClientSideConnection` |
| **Initialize** | Нет (просто шлём prompt) | `connection.initialize()` — capabilities negotiation |
| **Session** | Нет (implicit) | `connection.newSession()` — explicit session ID |
| **Prompt** | `stdin.write(JSON.stringify({type:'user',...}) + '\n')` | `connection.prompt({sessionId, prompt})` |
| **Streaming** | Ручной парсинг stdout строк | `sessionUpdate()` callback с typed events |
| **Tool approval** | `control_request` парсинг | `requestPermission()` callback |
| **File ops** | Нет (агент делает сам) | `readTextFile()` / `writeTextFile()` callbacks |
| **Terminal** | Нет | `terminal/*` callbacks |
| **Cancel** | SIGKILL | `connection.cancel()` (graceful) |

### 8.3 Что ACP НЕ решает (нам всё ещё нужно)

1. **Agent Teams orchestration** — ACP это one-agent ↔ one-client. Оркестрация команд, TaskCreate, SendMessage, TeamCreate — всё это наш domain logic поверх CLI-specific протокола.

2. **stream-json специфика Claude Code** — Claude Code НЕ поддерживает `--acp` нативно. Он использует `--input-format stream-json --output-format stream-json`. ACP требует адаптер (`@zed-industries/claude-code-acp`), который внутри использует Claude Agent SDK.

3. **Team file monitoring** — Наш `TeamConfigReader`, `TeamTaskReader`, `TeamInboxReader` мониторят файлы на диске. ACP не имеет concept of teams/tasks.

4. **Cross-team communication** — Наш `cross_team_send`, inbox relay, sentinel messages — всё это специфика нашей архитектуры.

5. **Post-compact context recovery** — Наши `pendingPostCompactReminder` и context reinjection — domain-specific.

6. **Member spawn management** — Трекинг `MemberSpawnStatus`, reconnect, stall detection — наш код.

7. **MCP config building** — `TeamMcpConfigBuilder` — наш код для сборки MCP конфигов.

8. **Tool approval auto-resolve** — `shouldAutoAllow()` и custom rules — наша логика.

### 8.4 Гипотетическая интеграция (Pseudocode)

```typescript
// === ВАРИАНТ A: ACP для нового multi-agent клиента ===
// Если бы Claude Code поддерживал --acp нативно

import * as acp from '@agentclientprotocol/sdk';
import { spawnCli } from '@main/utils/childProcess';

class TeamAgentClient implements acp.Client {
  constructor(
    private teamName: string,
    private memberName: string,
    private onUpdate: (event: SessionUpdate) => void,
    private onPermission: (request: ToolApprovalRequest) => Promise<ToolApprovalResponse>,
  ) {}

  async requestPermission(params: acp.RequestPermissionRequest) {
    // Проксируем в наш UI через существующий tool approval flow
    const approval = await this.onPermission(mapToOurFormat(params));
    return mapToAcpResponse(approval);
  }

  async sessionUpdate(params: acp.SessionNotification) {
    // Маппим ACP events в наши TeamChangeEvent'ы
    const update = params.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.onUpdate({ type: 'agent-text', text: update.content.text });
        break;
      case 'tool_call':
        this.onUpdate({ type: 'tool-call', ...mapToolCall(update) });
        break;
      case 'plan':
        this.onUpdate({ type: 'plan-update', entries: update.entries });
        break;
    }
  }
}

async function spawnAgentWithAcp(claudePath: string, args: string[], cwd: string) {
  // 1. Spawn process (наш существующий код)
  const child = spawnCli(claudePath, ['--acp', ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

  // 2. Create ACP connection (заменяет весь ручной NDJSON парсинг)
  const input = Writable.toWeb(child.stdin!);
  const output = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(input, output);

  const client = new TeamAgentClient(teamName, memberName, onUpdate, onPermission);
  const connection = new acp.ClientSideConnection((_agent) => client, stream);

  // 3. Initialize
  const initResult = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: { create: true, output: true, kill: true },
    },
  });

  // 4. Create session with MCP servers
  const mcpConfigPath = await mcpBuilder.writeConfigFile();
  const session = await connection.newSession({
    cwd,
    mcpServers: [
      { type: 'stdio', command: 'node', args: [mcpServerPath] },
    ],
  });

  // 5. Send prompt
  const result = await connection.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: provisioningPrompt }],
  });

  // 6. Graceful cancel instead of SIGKILL
  await connection.cancel({ sessionId: session.sessionId });

  return { connection, session, child };
}
```

```typescript
// === ВАРИАНТ B: ACP как дополнительный протокол (реалистичный) ===
// Claude Code -> stream-json (как сейчас)
// Другие агенты (Gemini, Codex, Copilot) -> ACP
// Наше приложение поддерживает ОБА протокола

interface AgentConnection {
  sendPrompt(text: string): Promise<void>;
  onMessage(callback: (msg: AgentMessage) => void): void;
  cancel(): Promise<void>;
  close(): void;
}

class StreamJsonConnection implements AgentConnection {
  // Существующий код из TeamProvisioningService
  // stream-json протокол Claude Code
}

class AcpConnection implements AgentConnection {
  private connection: acp.ClientSideConnection;
  private sessionId: string;

  constructor(connection: acp.ClientSideConnection, sessionId: string) {
    this.connection = connection;
    this.sessionId = sessionId;
  }

  async sendPrompt(text: string) {
    await this.connection.prompt({
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
    });
  }

  async cancel() {
    await this.connection.cancel({ sessionId: this.sessionId });
  }
}

function createAgentConnection(agent: AgentType, child: ChildProcess): AgentConnection {
  if (agent === 'claude-code') {
    return new StreamJsonConnection(child); // Как сейчас
  }
  // Gemini CLI, Codex CLI, Copilot CLI и др.
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin!),
    Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
  );
  const conn = new acp.ClientSideConnection((_agent) => new AcpClient(), stream);
  return new AcpConnection(conn, sessionId);
}
```

### 8.5 Ключевые технические проблемы интеграции

#### Проблема 1: Web Streams vs Node Streams
ACP SDK использует Web Streams API (`ReadableStream`, `WritableStream`). Node.js child_process возвращает Node Streams. Нужна конвертация:
```typescript
const input = Writable.toWeb(child.stdin!);   // node:stream → web stream
const output = Readable.toWeb(child.stdout!);  // node:stream → web stream
```
В Electron 40.x (Node 22+) эти конвертации доступны нативно.

#### Проблема 2: Claude Code не поддерживает ACP
Claude Code использует `stream-json`, не ACP. Для ACP нужен `@zed-industries/claude-code-acp` адаптер (который в свою очередь использует Claude Agent SDK — отдельный npm пакет с Anthropic API key).

**Наш текущий подход (прямой CLI)** не требует API key — используется auth token пользователя. Адаптер `claude-code-acp` требует `ANTHROPIC_API_KEY`, что делает его непрактичным для нашего zero-config подхода.

#### Проблема 3: Blocking prompt()
`connection.prompt()` блокирует до завершения turn'а. Streaming идёт через callback'и (`sessionUpdate`). Это отличается от нашего подхода где мы парсим stdout строку за строкой.

#### Проблема 4: Team orchestration
ACP — это 1:1 (один клиент, один агент). У нас N агентов в команде. Каждый агент = отдельный ACP connection. Координация между ними — полностью наш код.

---

## 9. Что код мы СОХРАНЯЕМ vs что ACP заменяет

### Сохраняем (наш domain logic):

| Файл/Модуль | Причина |
|-------------|---------|
| `TeamProvisioningService.ts` (80%) | Team orchestration, member management, task tracking |
| `TeamConfigReader.ts` | File-based team config monitoring |
| `TeamTaskReader.ts` | File-based task monitoring |
| `TeamInboxReader.ts` | File-based inbox monitoring |
| `TeamMcpConfigBuilder.ts` | MCP config generation |
| `TeamMembersMetaStore.ts` | Member metadata |
| `TeamSentMessagesStore.ts` | Sent messages tracking |
| `ClaudeBinaryResolver.ts` | CLI binary resolution |
| `childProcess.ts` | Process spawning (spawnCli, killProcessTree) |
| `toolApprovalRules.ts` | Auto-approval logic |
| `actionModeInstructions.ts` | Agent instructions |
| Cross-team communication | Inbox relay, sentinel messages |
| Post-compact recovery | Context reinjection |
| Stall detection | Watchdog timers |
| Auth retry | Re-spawn on auth failure |

### ACP заменяет (если бы Claude Code поддерживал):

| Компонент | Строки кода | Чем заменяет |
|-----------|-------------|--------------|
| NDJSON парсинг stdout | ~200 LOC | `ndJsonStream()` + `ClientSideConnection` |
| Carry buffer логика | ~50 LOC | Автоматически в SDK |
| Message type dispatching | ~150 LOC | Typed `sessionUpdate()` callback |
| Tool approval protocol | ~100 LOC | `requestPermission()` callback |
| Session init handshake | ~30 LOC | `initialize()` + `newSession()` |
| **Итого** | **~530 LOC** | Типизированный SDK |

**Из ~6000 LOC TeamProvisioningService**, ACP заменяет ~530 LOC (менее 9%). Остальные 91% — domain-specific orchestration.

---

## 10. Честные оценки

### Сложность интеграции: 6/10 (Уверенность: 8/10)

- SDK сам по себе простой (0 dependencies, чистый API)
- Проблема: Claude Code не поддерживает ACP нативно
- Нужен маппинг между ACP events и нашими internal types
- Web Streams конвертация в Electron — тривиальна
- Основная сложность: поддержка двух протоколов (stream-json + ACP)

### Полезность для нашего кейса: 4/10 (Уверенность: 9/10)

- Наш primary agent (Claude Code) НЕ поддерживает ACP
- 91% нашего кода — domain-specific, ACP не касается
- Выгода: если хотим поддержать ДРУГИЕ агенты (Gemini, Codex, Copilot) — тогда ACP становится очень полезным (8/10)
- Для Claude Code only — бессмысленно, мы уже общаемся напрямую через stream-json

### Зрелость/стабильность: 5/10 (Уверенность: 7/10)

- Pre-1.0 (v0.16.1)
- Много `unstable_` методов
- Breaking changes между минорами возможны
- НО: 31 контрибьютор, 544 коммита, JetBrains + Zed backing
- Активная разработка, быстрый темп (18 npm versions)
- Usage updates и session management — ещё в draft

### Риск adoption: 5/10 (Уверенность: 7/10)

- Zero dependencies — безопасно для bundle size
- Pre-1.0 → API может измениться
- Claude Code может получить нативную ACP поддержку в будущем (Feature Request существует)
- VS Code не поддерживает ACP — это риск для всей экосистемы
- JetBrains backing — сильный сигнал стабильности

---

## 11. Рекомендация

### WAIT — Не интегрировать сейчас. Наблюдать.

**Надёжность решения: 8/10. Уверенность в рекомендации: 9/10.**

**Почему WAIT, а не ADOPT:**

1. **Claude Code — наш primary agent и он НЕ говорит по ACP.** Пока Anthropic не добавит `--acp` флаг (или не поменяет `stream-json` на ACP), интеграция ACP не даёт value для Claude Code.

2. **Мы заменим менее 9% кода.** ROI не оправдывает migration effort + поддержку двух протоколов.

3. **Pre-1.0 API.** Breaking changes реальны. Лучше подождать стабилизации.

**Когда стоит ADOPT:**

1. **Claude Code получит нативную ACP поддержку** — тогда можно мигрировать stream-json → ACP, упростив парсинг.

2. **Мы решим поддержать multi-agent (Gemini + Codex + Claude)** — тогда ACP станет единым протоколом для не-Claude агентов. Архитектура: stream-json для Claude, ACP для остальных, общий `AgentConnection` интерфейс.

3. **ACP достигнет 1.0** — стабильный API, можно инвестировать в интеграцию.

**Что делать прямо сейчас:**

1. Следить за [Feature Request #6686](https://github.com/anthropics/claude-code/issues/6686) (Claude Code ACP support)
2. Следить за [ACP Updates](https://agentclientprotocol.com/updates) (protocol evolution)
3. Проектировать `AgentConnection` abstraction в нашем коде, чтобы stream-json и ACP могли быть взаимозаменяемы в будущем
4. Если решим поддержать Gemini/Codex — начать с ACP как протокола для них

---

## Приложение A: Полная архитектура ACP Protocol Schema

### Error Codes (JSON-RPC)

| Code | Meaning |
|------|---------|
| -32700 | Parse error |
| -32600 | Invalid request |
| -32601 | Method not found |
| -32602 | Invalid params |
| -32603 | Internal error |
| -32000 | Authentication required |
| -32002 | Resource not found |

### Permission Option Kinds

| Kind | Описание |
|------|----------|
| `allow_once` | Разрешить один раз |
| `allow_always` | Разрешить всегда |
| `reject_once` | Отклонить один раз |
| `reject_always` | Отклонить всегда |

### Stop Reasons

| Reason | Описание |
|--------|----------|
| `end_turn` | Агент завершил turn нормально |
| `cancelled` | Пользователь отменил |
| `max_tokens` | Достигнут лимит токенов |
| `tool_use` | Агент ожидает результат tool (редко в ACP) |

### Tool Call Kinds

| Kind | Описание |
|------|----------|
| `read` | Чтение (файл, поиск) |
| `edit` | Редактирование файла |
| `command` | Выполнение команды |
| `tool` | Вызов MCP tool |

### Diff Format

```json
{
  "path": "/absolute/path/to/file.ts",
  "oldText": "original content (null for new files)",
  "newText": "modified content"
}
```

---

## Приложение B: Ссылки

### Спецификация и документация
- [ACP Introduction](https://agentclientprotocol.com/get-started/introduction)
- [ACP Protocol Overview](https://agentclientprotocol.com/protocol/overview)
- [ACP Schema](https://agentclientprotocol.com/protocol/schema)
- [ACP Updates](https://agentclientprotocol.com/updates)
- [ACP Registry](https://agentclientprotocol.com/registry)

### SDK
- [npm: @agentclientprotocol/sdk](https://www.npmjs.com/package/@agentclientprotocol/sdk)
- [GitHub: typescript-sdk](https://github.com/agentclientprotocol/typescript-sdk)
- [API Reference](https://agentclientprotocol.github.io/typescript-sdk/)
- [SDK Examples](https://github.com/agentclientprotocol/typescript-sdk/tree/main/src/examples)

### Claude Code ACP
- [Feature Request #6686](https://github.com/anthropics/claude-code/issues/6686)
- [Zed Claude Code ACP Adapter](https://github.com/zed-industries/claude-agent-acp)
- [Zed Blog: Claude Code via ACP](https://zed.dev/blog/claude-code-via-acp)

### Ecosystem
- [Zed ACP](https://zed.dev/acp)
- [JetBrains ACP](https://www.jetbrains.com/acp/)
- [JetBrains ACP Docs](https://www.jetbrains.com/help/ai-assistant/acp.html)
- [GitHub Copilot ACP](https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/)
- [Goose ACP](https://block.github.io/goose/blog/2025/10/24/intro-to-agent-client-protocol-acp/)
- [Kiro CLI ACP](https://kiro.dev/docs/cli/acp/)
- [OpenCode ACP](https://opencode.ai/docs/acp/)
