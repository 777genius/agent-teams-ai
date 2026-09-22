# Agent Spawn Packages — Deep Dive Research

**Дата:** 2026-03-25
**Цель:** Найти лучший способ программно запускать CLI-агентов (Claude Code, Codex, Gemini CLI) из Electron-приложения.

---

## TL;DR — Итоговая Рекомендация

У всех трёх главных CLI-агентов **теперь есть ОФИЦИАЛЬНЫЕ SDK** для программного запуска:

| Агент | SDK Пакет | Лицензия | Зрелость |
|-------|-----------|----------|----------|
| Claude Code | `@anthropic-ai/claude-agent-sdk` | **Proprietary** (Commercial ToS) | Stable (v0.2.83) |
| Codex | `@openai/codex-sdk` | **Apache-2.0** | Stable (v0.116.0) |
| Gemini CLI | `@google/gemini-cli-sdk` + `@google/gemini-cli-core` | **Apache-2.0** | Early (v0.30.0+) |

**Вывод:** Вместо форка `@swarmify/agents-mcp` или написания своих spawn-обёрток, лучше использовать **официальные SDK** от каждого провайдера. Они более надёжны, поддерживаются, и дают нативный доступ без хрупкого парсинга stdout.

---

## 1. @swarmify/agents-mcp

**npm:** https://www.npmjs.com/package/@swarmify/agents-mcp
**Сайт:** https://swarmify.co/
**GitHub:** НЕ НАЙДЕН (closed-source или приватный репозиторий)

### Что это
MCP-сервер, который позволяет любому MCP-клиенту (Claude, Codex, Gemini, Cursor) спавнить параллельных агентов. Часть экосистемы Swarmify.

### Предоставляет
- **4 MCP-тула:** Spawn, Status, Stop, Tasks
- **3 режима:** plan (read-only), edit (can write), ralph (autonomous)
- Фоновые процессы — агенты переживают перезапуск IDE
- Авто-детект Claude, Codex, Gemini CLI при установке

### Как спавнит агентов
Агенты коммуницируют через файловую систему — каждый агент пишет в свой лог-файл (stdout.log). Тул Status читает эти логи, нормализует события между разными форматами агентов, и возвращает сводку.

### IAgent / BaseAgent — НЕ НАЙДЕНЫ
Несмотря на множество поисков, интерфейсы `IAgent` и `BaseAgent` **не обнаружены** в публичной документации пакета. Возможно, они существуют внутри скомпилированного npm-пакета (можно проверить через `node_modules`), но исходный код закрыт.

### Оценка для нас
- **Надёжность: 3/10** — Closed-source, нет GitHub, невозможно форкнуть
- **Уверенность: 2/10** — Без исходного кода невозможно оценить качество
- **Вердикт:** НЕ подходит для нашего проекта

---

## 2. @anthropic-ai/claude-agent-sdk (OFFICIAL)

**npm:** https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk
**GitHub:** https://github.com/anthropics/claude-agent-sdk-typescript
**Docs:** https://platform.claude.com/docs/en/agent-sdk/typescript
**Версия:** 0.2.83 (25 марта 2026)
**Лицензия:** Proprietary (Anthropic Commercial Terms of Service)
**Звёзды:** ~1000 | **Форки:** ~117 | **Релизы:** 67
**691 проект** в npm registry используют этот пакет

### Что это
Официальный SDK от Anthropic для программного запуска Claude Code. Переименован из "Claude Code SDK" в "Claude Agent SDK". Даёт те же инструменты, agent loop и context management, что и Claude Code.

### Ключевой API

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

// Основная функция — async generator
const q = query({
  prompt: "Fix the bug in auth.py",
  options: {
    model: "opus",
    cwd: "/path/to/project",
    allowedTools: ["Read", "Edit", "Bash"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: 50,
    maxBudgetUsd: 5.0,
    env: { ANTHROPIC_API_KEY: "..." },
    mcpServers: { /* MCP config */ },
    agents: {
      // Программно определяемые субагенты
      reviewer: {
        description: "Code reviewer agent",
        prompt: "Review code for bugs",
        model: "sonnet",
        tools: ["Read", "Grep", "Glob"],
      }
    },
    settingSources: ["project"], // Загрузка CLAUDE.md
    thinking: { type: "adaptive" },
  }
});

// Стриминг событий
for await (const message of q) {
  // SDKMessage types: assistant, user, result, system, etc.
  console.log(message);
}

// Query object methods:
// q.interrupt(), q.close(), q.setModel(), q.mcpServerStatus()
// q.initializationResult(), q.supportedModels(), q.supportedAgents()
```

### Как спавнит Claude Code
SDK **запускает Claude Code CLI как subprocess** — НЕ чисто API-библиотека. Каждый вызов `query()` спавнит новый процесс (~12 сек overhead).

Ключевые опции:
- `spawnClaudeCodeProcess` — кастомная функция для запуска процесса (VMs, Docker, remote)
- `pathToClaudeCodeExecutable` — путь к бинарнику Claude Code
- `env` — переменные окружения для subprocess (полезно для Electron)
- `executable` — runtime: `'node'`, `'bun'`, `'deno'`

### Session Management
```typescript
import { listSessions, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";

const sessions = await listSessions({ dir: "/path/to/project", limit: 10 });
const messages = await getSessionMessages(sessionId, { limit: 20 });

// Resume session
const q = query({
  prompt: "Continue working",
  options: { resume: sessionId }
});
```

### V2 Preview API (упрощённый интерфейс)
Новый API с `send()` и `stream()` паттернами для multi-turn conversations.

### Субагенты
Определяются программно через `agents` option в `AgentDefinition`:
```typescript
type AgentDefinition = {
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: "sonnet" | "opus" | "haiku" | "inherit";
  mcpServers?: AgentMcpServerSpec[];
  skills?: string[];
  maxTurns?: number;
};
```

### MCP-серверы
Поддерживает in-process MCP серверы:
```typescript
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const server = createSdkMcpServer({
  name: "my-server",
  tools: [
    tool("search", "Search the web", { query: z.string() }, async ({ query }) => {
      return { content: [{ type: "text", text: `Results for: ${query}` }] };
    })
  ]
});
```

### Ограничения лицензии
- **Proprietary** — НЕ open-source
- Запрещено использовать OAuth токены Claude Free/Pro/Max — нужен **API key**
- Продукт должен иметь **собственный брендинг** (не Claude Code)
- Anthropic собирает telemetry (usage, feedback, conversations)

### Оценка для нас
- **Надёжность: 9/10** — Официальный SDK от Anthropic, активно развивается
- **Уверенность: 9/10** — Отлично документирован, 691+ пользователь
- **Риск:** Proprietary лицензия, ~12 сек overhead на query(), зависимость от CLI binary

---

## 3. @openai/codex-sdk (OFFICIAL)

**npm:** https://www.npmjs.com/package/@openai/codex-sdk
**GitHub:** https://github.com/openai/codex/tree/main/sdk/typescript
**Docs:** https://developers.openai.com/codex/sdk
**Версия:** 0.116.0
**Лицензия:** Apache-2.0
**107 проектов** в npm registry используют этот пакет

### Что это
Официальный TypeScript SDK от OpenAI для программного управления Codex CLI. Оборачивает CLI, обменивается JSONL-событиями через stdin/stdout.

### Ключевой API

```typescript
import { Codex } from "@openai/codex-sdk";

// Инициализация
const codex = new Codex({
  env: { PATH: "/usr/local/bin" },  // Полезно для Electron
  config: {
    show_raw_agent_reasoning: true,
    sandbox_workspace_write: { network_access: true }
  },
  baseUrl: "https://api.example.com"  // Optional
});

// Thread management
const thread = codex.startThread({
  workingDirectory: "/path/to/project",
  skipGitRepoCheck: true  // Для non-git environments
});

// Buffered response
const turn = await thread.run("Fix the test failure");
console.log(turn.finalResponse);
console.log(turn.items);

// Streaming response
const { events } = await thread.runStreamed("Diagnose failures");
for await (const event of events) {
  switch (event.type) {
    case "item.completed": console.log("Item:", event.item); break;
    case "turn.completed": console.log("Usage:", event.usage); break;
  }
}

// Multi-turn conversations
const turn1 = await thread.run("Diagnose issue");
const turn2 = await thread.run("Implement the fix");

// Resume persisted thread
const thread2 = codex.resumeThread(process.env.CODEX_THREAD_ID!);
```

### Как спавнит Codex CLI
SDK спавнит **Codex CLI** (Rust-based `@openai/codex`) как subprocess и обменивается JSONL-событиями через stdin/stdout.

- Работает **ТОЛЬКО** с Native (Rust) версией Codex
- SDK инжектит `CODEX_API_KEY` поверх переданных env variables
- `env` параметр — полный контроль над переменными (полезно для Electron)
- `config` — JSON → dotted paths → TOML literals → `--config key=value` flags

### Session Persistence
- Threads сохраняются в `~/.codex/sessions`
- `resumeThread(id)` — восстановление потерянного Thread

### Structured Output
```typescript
const schema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    status: { type: "string", enum: ["ok", "action_required"] }
  },
  required: ["summary", "status"],
  additionalProperties: false
} as const;

const turn = await thread.run("Summarize status", { outputSchema: schema });
```

### Multi-Agent Collaboration
Поддержка spawn_agent, send_input, wait для координации между threads.

### Оценка для нас
- **Надёжность: 9/10** — Официальный SDK от OpenAI, Apache-2.0
- **Уверенность: 8/10** — Хорошо документирован, активно развивается
- **Риск:** Только Rust-based Codex, зависимость от Git repo (опционально отключается)

---

## 4. @google/gemini-cli-sdk + @google/gemini-cli-core (OFFICIAL)

**npm (CLI):** https://www.npmjs.com/package/@google/gemini-cli
**npm (Core):** https://www.npmjs.com/package/@google/gemini-cli-core
**GitHub:** https://github.com/google-gemini/gemini-cli
**Docs:** https://deepwiki.com/google-gemini/gemini-cli/5.9-sdk-and-programmatic-api
**Версия:** SDK появился в v0.30.0 (2026-02-25)
**Лицензия:** Apache-2.0
**Звёзды:** ~99K

### Что это
Официальный SDK от Google для программного запуска Gemini CLI. Монорепо-архитектура.

### Архитектура пакетов
| Пакет | Роль |
|-------|------|
| `@google/gemini-cli-sdk` | Consumer-facing API |
| `@google/gemini-cli-core` | Core orchestration, tools, API |
| `@google/gemini-cli` | Terminal reference implementation |

### Ключевой API

```typescript
import { LocalAgentExecutor, LocalAgentDefinition } from '@google/gemini-cli-core';

const agentDef: LocalAgentDefinition = {
  modelId: 'gemini-2.0-flash',
  systemPrompt: 'You are a helpful assistant',
  tools: ['read_file', 'write_file', 'run_shell_command'],
  maxTurns: 30,
  timeoutMs: 600000  // 10 min
};

const executor = new LocalAgentExecutor(config, agentDef);

// Activity monitoring
executor.onActivity((event) => {
  console.log('Agent activity:', event);
});

const result = await executor.run({
  task: 'Analyze the codebase and suggest improvements'
});

console.log('Termination mode:', result.terminateMode);  // GOAL | MAX_TURNS | TIMEOUT
console.log('Result:', result.output);
```

### Как спавнит Gemini
В отличие от Claude и Codex, SDK Gemini — **НЕ CLI wrapper**, а **нативная библиотека**. Использует core-логику напрямую:
- `GeminiCliAgent` / `LocalAgentExecutor` — primary entity
- Каждый агент получает свой `ToolRegistry` (изоляция)
- `MessageBus` для async events (tool confirmations)
- `Config` class для model selection и auth

### Tool Management
- Built-in tools (file system, shell, web)
- MCP server tools
- Extension-provided tools
- Tool confirmation через `TOOL_CONFIRMATION_REQUEST` event

### Agent Termination
```typescript
enum AgentTerminateMode {
  GOAL,       // Успешно вызвал complete_task
  MAX_TURNS,  // Достиг лимита (default 30)
  TIMEOUT     // Превысил время (default 10 min)
}
```

### Headless Mode (альтернатива)
```bash
gemini --output-format json -p "Summarize project"
gemini --output-format stream-json -p "Fix bug"
```

### Зрелость
- SDK появился в v0.30.0 (2026-02-25) — **очень свежий**
- Feature request #15539 (Dec 2025) формально запрашивал SDK
- API может меняться

### Оценка для нас
- **Надёжность: 6/10** — Apache-2.0, открытый код, но SDK совсем новый
- **Уверенность: 6/10** — API может меняться, документация неполная
- **Преимущество:** Нативная библиотека (не CLI wrapper), лучшая производительность

---

## 5. Альтернативные Multi-Agent Frameworks

### jayminwest/overstory
**GitHub:** https://github.com/jayminwest/overstory
**Лицензия:** MIT

Pluggable `AgentRuntime` интерфейс с **11 адаптерами** (Claude Code, Codex, Gemini CLI, Aider, Goose, Amp и др). Агенты работают в изолированных git worktrees через tmux.

| Runtime | CLI | Guard Mechanism |
|---------|-----|-----------------|
| Claude Code | `claude` | `settings.local.json` hooks |
| Codex | `codex` | OS-level sandbox |
| Gemini | `gemini` | `--sandbox` flag |
| Aider | `aider` | None (`--yes-always`) |
| Goose | `goose` | Profile-based permissions |
| + 6 others | ... | ... |

**Интересно, но:** Ориентирован на CLI/tmux workflow, не на Electron SDK.

### desplega-ai/agent-swarm
**GitHub:** https://github.com/desplega-ai/agent-swarm
**Docs:** https://docs.agent-swarm.dev/

Lead-worker паттерн с Docker-изоляцией. Поддерживает Claude Code, с планами на Codex/Gemini. SQLite + bun.

---

## 6. Сравнительная Таблица SDK

| | Claude Agent SDK | Codex SDK | Gemini CLI SDK |
|---|---|---|---|
| **Пакет** | `@anthropic-ai/claude-agent-sdk` | `@openai/codex-sdk` | `@google/gemini-cli-sdk` |
| **Версия** | 0.2.83 | 0.116.0 | ~0.30.0+ |
| **Лицензия** | Proprietary | Apache-2.0 | Apache-2.0 |
| **Архитектура** | CLI subprocess | CLI subprocess (Rust) | Нативная библиотека |
| **Стриминг** | AsyncGenerator<SDKMessage> | AsyncGenerator (events) | onActivity callback |
| **Session Resume** | Да (sessionId) | Да (resumeThread) | Да (SessionContext) |
| **Субагенты** | Да (agents option) | Да (spawn_agent) | Да (LocalAgentDefinition) |
| **MCP серверы** | Да (in-process + external) | Нет (native tools only) | Да (ToolRegistry) |
| **Custom Env** | Да (env option) | Да (env option) | Да (Config) |
| **Custom Spawn** | Да (spawnClaudeCodeProcess) | Нет | Нет (нативная) |
| **Structured Output** | Да (JSON Schema) | Да (JSON Schema + Zod) | Да (zod OutputConfig) |
| **Node.js** | 18+ | 18+ | 18+ |
| **Overhead** | ~12s per query() | Не измерен | Минимальный (нативная) |
| **npm Users** | 691 | 107 | N/A (новый) |

---

## 7. Рекомендация для Claude Agent Teams UI

### Основной подход (Recommended)
**Использовать официальные SDK каждого провайдера** вместо единого абстрактного слоя.

```
src/main/services/agents/
├── types.ts              # Общие типы (AgentProcess, AgentEvent, AgentConfig)
├── claude-adapter.ts     # Обёртка над @anthropic-ai/claude-agent-sdk
├── codex-adapter.ts      # Обёртка над @openai/codex-sdk
├── gemini-adapter.ts     # Обёртка над @google/gemini-cli-sdk
└── agent-registry.ts     # Реестр доступных агентов
```

Тонкий адаптерный слой (~100-150 LOC на адаптер) над каждым SDK, нормализующий:
- Стриминг событий → единый `AgentEvent` формат
- Session management → единый `AgentSession` интерфейс
- Process lifecycle → start/stop/status

### Почему НЕ @swarmify/agents-mcp
1. Closed-source — невозможно аудировать или форкнуть
2. MCP-only интерфейс — мы уже имеем прямой доступ к процессам
3. Filesystem-based communication — избыточный overhead для Electron

### Почему НЕ единый CLI spawn
1. Все 3 провайдера выпустили свои SDK
2. SDK дают типизированные события, session management, structured output
3. Raw CLI spawn хрупок (парсинг stdout/ANSI codes)

### Почему НЕ overstory AgentRuntime
1. Ориентирован на tmux/worktree workflow
2. MIT лицензия хорошая, но архитектура не подходит для Electron
3. 11 адаптеров — избыточно, нам нужны 3

### Порядок интеграции
1. **Claude Code** (`@anthropic-ai/claude-agent-sdk`) — у нас уже есть, нужно мигрировать на SDK
2. **Codex** (`@openai/codex-sdk`) — Apache-2.0, простой API, thread-based
3. **Gemini** (`@google/gemini-cli-sdk`) — подождать стабилизации API (SDK очень свежий)

### Риски
- **Claude SDK Proprietary лицензия** — нужно проверить совместимость с нашим MIT
- **~12s overhead** Claude SDK per query — может потребоваться process pooling
- **Gemini SDK API unstable** — может сломаться в любом релизе

---

## Источники

- [@swarmify/agents-mcp (npm)](https://www.npmjs.com/package/@swarmify/agents-mcp)
- [Swarmify](https://swarmify.co/)
- [@anthropic-ai/claude-agent-sdk (npm)](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
- [Claude Agent SDK TypeScript (GitHub)](https://github.com/anthropics/claude-agent-sdk-typescript)
- [Claude Agent SDK Reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Run Claude Code programmatically](https://code.claude.com/docs/en/headless)
- [@openai/codex-sdk (npm)](https://www.npmjs.com/package/@openai/codex-sdk)
- [Codex SDK TypeScript (GitHub)](https://github.com/openai/codex/tree/main/sdk/typescript)
- [Codex SDK Docs](https://developers.openai.com/codex/sdk)
- [@google/gemini-cli (GitHub)](https://github.com/google-gemini/gemini-cli)
- [Gemini CLI SDK (DeepWiki)](https://deepwiki.com/google-gemini/gemini-cli/5.9-sdk-and-programmatic-api)
- [Gemini CLI SDK Feature Request #15539](https://github.com/google-gemini/gemini-cli/issues/15539)
- [overstory (GitHub)](https://github.com/jayminwest/overstory)
- [agent-swarm (GitHub)](https://github.com/desplega-ai/agent-swarm)
