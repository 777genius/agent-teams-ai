# Minimal CLI Agent Adapter Design

**Дата**: 2026-03-25
**Статус**: Research / Design proposal

## Цель

Определить МИНИМАЛЬНО достаточный адаптер для запуска нескольких CLI-агентов (Claude, Codex, Gemini, Goose, OpenCode) из нашего Electron-приложения. Без over-engineering, без "велосипедов".

---

## 1. Что мы уже имеем

### childProcess.ts (221 LOC)
Уже содержит два ключевых примитива:
- **`spawnCli(binaryPath, args, options)`** — spawn с Windows EINVAL fallback
- **`execCli(binaryPath, args, options)`** — exec для одноразовых команд
- **`killProcessTree(child, signal)`** — kill с Windows taskkill fallback
- **`CLI_ENV_DEFAULTS`** — env-переменные для Claude (CLAUDE_HOOK_JUDGE_MODE)

### TeamProvisioningService.ts (~8000+ LOC)
Монстр, который делает ВСЁ:
- Spawn через `spawnCli()`
- Конструирование args (`--input-format stream-json`, `--output-format stream-json`, `--mcp-config`, `--verbose`, etc.)
- Парсинг stream-json stdout (newline-delimited JSON)
- Stdin messaging (SDKUserMessage format)
- MCP config merge (через TeamMcpConfigBuilder)
- Filesystem monitoring, stall detection, auth retry, etc.

### ScheduledTaskExecutor.ts (~200 LOC)
Отдельный, более чистый spawn-path для scheduled tasks:
- Тоже `spawnCli()` + `--output-format stream-json`
- Парсинг stdout для summary extraction
- Простой lifecycle: spawn -> wait -> collect result

### TeamMcpConfigBuilder.ts (229 LOC)
Генерирует MCP config JSON-файл, мержит с user-серверами из `~/.claude.json`.

### Общий паттерн spawn (из TeamProvisioningService):
```typescript
const spawnArgs = [
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--setting-sources', 'user,project,local',
  '--mcp-config', mcpConfigPath,
  '--disallowedTools', 'TeamDelete,TodoWrite',
  ...(skipPermissions ? ['--dangerously-skip-permissions'] : []),
  ...(model ? ['--model', model] : []),
];
child = spawnCli(claudePath, spawnArgs, {
  cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
});
// stdin: send JSON messages
child.stdin.write(JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: prompt }] }
}) + '\n');
```

---

## 2. Что РЕАЛЬНО отличается между CLI-агентами

### Сводная таблица (исследование март 2026)

| Аспект | Claude Code | Codex (OpenAI) | Gemini CLI | Goose (Block) | OpenCode |
|--------|-------------|-----------------|------------|---------------|----------|
| **Binary** | `claude` | `codex` | `gemini` | `goose` | `opencode` |
| **Programmatic mode** | `--input-format stream-json --output-format stream-json` | `codex exec --json` (NDJSON events) | `--output-format json` (headless) | `goose run --output-format stream-json` | `opencode run --format json` |
| **Stdin messaging** | stream-json protocol (SDKUserMessage) | Нет stdin — одноразовый exec | Нет stdin — одноразовый | Нет stdin — одноразовый `run` | Нет stdin — pipe prompt или `--attach` |
| **Output protocol** | NDJSON (type: user/assistant/result/control_request/system) | NDJSON events | JSON (структура неизвестна) | NDJSON (text/json/stream-json) | JSON events |
| **MCP config** | `--mcp-config /path/to/file.json` | `config.toml` (`codex mcp add`) | `settings.json` (`gemini mcp add`) | `--with-extension "cmd"` (runtime) | Config file (opencode.json) |
| **MCP config format** | `{ mcpServers: { name: { command, args } } }` | TOML (встроенная команда `codex mcp`) | JSON settings.json `{ mcpServers: {...} }` | CLI flags per extension | JSON config |
| **Kill semantics** | SIGKILL (team) / SIGTERM (scheduled) | SIGTERM | SIGTERM | SIGTERM | SIGTERM |
| **Keep-alive** | Да (stream-json stdin/stdout loop) | Нет (exec = one-shot) | Нет (headless = one-shot) | Нет (run = one-shot) | Возможно (`--attach` к serve) |
| **Team/multi-agent** | Нативные Agent Teams (TeamCreate, SendMessage) | Нет встроенного | Нет встроенного | Нет встроенного | Subagents через Task tool |
| **Prompt flag** | Stdin (stream-json) или `-p` (one-shot) | `codex exec "prompt"` (positional) | `-p "prompt"` или pipe | `goose run -t "prompt"` или `-i file` | `opencode run "prompt"` (positional) |

### Источники
- [Codex CLI Reference](https://developers.openai.com/codex/cli/reference) — `codex exec --json`, NDJSON events
- [Codex MCP Docs](https://developers.openai.com/codex/mcp) — config.toml based MCP
- [Gemini CLI MCP Docs](https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html) — settings.json, `gemini mcp add`
- [Goose CLI Commands](https://block.github.io/goose/docs/guides/goose-cli-commands/) — `--output-format stream-json`, `--with-extension`
- [Goose --output-format issue #4419](https://github.com/block/goose/issues/4419) — json/stream-json Done
- [OpenCode CLI Docs](https://opencode.ai/docs/cli/) — `run --format json`
- [OpenCode Agents Docs](https://opencode.ai/docs/agents/) — subagents, Task tool

---

## 3. Ключевой вывод: ГДЕ реальная сложность

### Что тривиально (просто конфиг):
- **Binary name** — строка
- **Prompt flag** — `-p`, `-t`, позиционный arg, или stdin
- **Output format flag** — `--output-format stream-json`, `--json`, `--format json`
- **Model flag** — `--model`, `-m`, `--provider/--model`
- **Permission flags** — `--dangerously-skip-permissions`, `--full-auto`, `--yolo`
- **Kill signal** — SIGKILL vs SIGTERM

### Что НЕ тривиально (требует адаптера):
1. **Stdin protocol** — ТОЛЬКО Claude имеет persistent stdin loop (stream-json). Все остальные — one-shot (запустил, получил результат, процесс завершился). Это ФУНДАМЕНТАЛЬНОЕ отличие.
2. **Output parsing** — NDJSON формат похож, но структура объектов разная. Claude: `{type: "assistant", message: {...}}`. Codex: свой формат events. Goose: свой. Gemini: свой.
3. **MCP config injection** — Claude: `--mcp-config file.json`. Codex: нужно `codex mcp add` заранее или config.toml. Gemini: нужно `gemini mcp add` или settings.json. Goose: `--with-extension` per runtime.

### Честная оценка: что из 8000 LOC TeamProvisioningService нужно для других CLI?

**НЕ нужно** (Claude-specific, 80% кода):
- stream-json stdin messaging loop
- `control_request` protocol (tool approval)
- Teammate spawn tracking (`memberSpawnStatuses`)
- Agent Teams protocol (TeamCreate, SendMessage, TaskCreate)
- Post-compact context recovery
- Cross-team messaging relay
- Lead activity state machine
- Filesystem monitoring для team files (config.json, inboxes/, tasks/)
- Auth retry через respawn

**Нужно** (общий ~20% skeleton):
- Binary resolution (`ClaudeBinaryResolver` -> обобщённый)
- Shell env resolution (`resolveInteractiveShellEnv`)
- MCP config generation и injection
- Process spawn + stdio pipes
- stdout/stderr collection
- Kill + cleanup
- Timeout/stall detection
- Progress reporting

---

## 4. Три варианта дизайна

### Option A: Config-driven (одна функция + конфиг)

**~120 LOC total** (config object + spawnAgent function + output normalizer)

```typescript
// src/main/utils/agentConfig.ts (~60 LOC)

export type AgentType = 'claude' | 'codex' | 'gemini' | 'goose' | 'opencode';

export type OutputProtocol = 'stream-json' | 'ndjson-events' | 'json-batch';

/** How to inject the user prompt into the CLI */
export type PromptMode =
  | { type: 'stdin-stream-json' }           // Claude: persistent stdin loop
  | { type: 'flag'; flag: string }          // -p "prompt", -t "prompt"
  | { type: 'positional' }                  // codex exec "prompt"
  | { type: 'stdin-pipe' };                 // echo "prompt" | opencode run

export interface AgentConfig {
  /** Binary name (resolved via PATH or explicit path) */
  bin: string;
  /** How to pass the prompt */
  promptMode: PromptMode;
  /** CLI flags for programmatic output */
  outputArgs: string[];
  /** How stdout should be parsed */
  outputProtocol: OutputProtocol;
  /** How to inject MCP servers */
  mcpInjection:
    | { type: 'flag'; flag: string; format: 'claude-json' }    // --mcp-config file.json
    | { type: 'runtime-flag'; flag: string }                    // --with-extension "cmd"
    | { type: 'config-file'; path: string; format: 'toml' | 'json' }  // write to config
    | { type: 'cli-command'; command: string[] };               // codex mcp add ...
  /** Signal to use for killing */
  killSignal: NodeJS.Signals;
  /** Extra env vars */
  env?: Record<string, string>;
  /** Whether the process stays alive for multi-turn (only Claude) */
  persistent: boolean;
}

export const AGENT_CONFIGS: Record<AgentType, AgentConfig> = {
  claude: {
    bin: 'claude',
    promptMode: { type: 'stdin-stream-json' },
    outputArgs: ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
    outputProtocol: 'stream-json',
    mcpInjection: { type: 'flag', flag: '--mcp-config', format: 'claude-json' },
    killSignal: 'SIGKILL',
    env: { CLAUDE_HOOK_JUDGE_MODE: 'true' },
    persistent: true,
  },
  codex: {
    bin: 'codex',
    promptMode: { type: 'positional' },
    outputArgs: ['exec', '--json'],
    outputProtocol: 'ndjson-events',
    mcpInjection: { type: 'config-file', path: '~/.codex/config.toml', format: 'toml' },
    killSignal: 'SIGTERM',
    persistent: false,
  },
  gemini: {
    bin: 'gemini',
    promptMode: { type: 'flag', flag: '-p' },
    outputArgs: ['--output-format', 'json'],
    outputProtocol: 'json-batch',
    mcpInjection: { type: 'cli-command', command: ['gemini', 'mcp', 'add'] },
    killSignal: 'SIGTERM',
    persistent: false,
  },
  goose: {
    bin: 'goose',
    promptMode: { type: 'flag', flag: '-t' },
    outputArgs: ['run', '--output-format', 'stream-json'],
    outputProtocol: 'stream-json',
    mcpInjection: { type: 'runtime-flag', flag: '--with-extension' },
    killSignal: 'SIGTERM',
    persistent: false,
  },
  opencode: {
    bin: 'opencode',
    promptMode: { type: 'positional' },
    outputArgs: ['run', '--format', 'json'],
    outputProtocol: 'json-batch',
    mcpInjection: { type: 'config-file', path: '.opencode.json', format: 'json' },
    killSignal: 'SIGTERM',
    persistent: false,
  },
};
```

```typescript
// src/main/utils/agentSpawn.ts (~60 LOC)

import { spawnCli, killProcessTree } from './childProcess';
import { AGENT_CONFIGS, type AgentType, type AgentConfig } from './agentConfig';

export interface AgentSpawnOptions {
  type: AgentType;
  prompt: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  model?: string;
  mcpConfigPath?: string;  // pre-built MCP config file (for Claude-style --mcp-config)
  extraArgs?: string[];
}

export interface SpawnedAgent {
  child: import('child_process').ChildProcess;
  config: AgentConfig;
  kill: () => void;
  /** Send message (only works for persistent agents like Claude) */
  send?: (text: string) => void;
}

export function spawnAgent(options: AgentSpawnOptions): SpawnedAgent {
  const config = AGENT_CONFIGS[options.type];
  const args: string[] = [...config.outputArgs];

  // Inject MCP config
  if (options.mcpConfigPath && config.mcpInjection.type === 'flag') {
    args.push(config.mcpInjection.flag, options.mcpConfigPath);
  }

  // Extra args
  if (options.extraArgs) {
    args.push(...options.extraArgs);
  }

  // Inject prompt based on mode
  switch (config.promptMode.type) {
    case 'flag':
      args.push(config.promptMode.flag, options.prompt);
      break;
    case 'positional':
      args.push(options.prompt);
      break;
    case 'stdin-stream-json':
    case 'stdin-pipe':
      // Handled after spawn
      break;
  }

  const child = spawnCli(config.bin, args, {
    cwd: options.cwd,
    env: { ...(options.env ?? process.env), ...(config.env ?? {}) },
    stdio: config.persistent ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  });

  // Send prompt via stdin if needed
  if (config.promptMode.type === 'stdin-stream-json' && child.stdin?.writable) {
    const msg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: options.prompt }] },
    });
    child.stdin.write(msg + '\n');
  } else if (config.promptMode.type === 'stdin-pipe' && child.stdin) {
    child.stdin.write(options.prompt);
    child.stdin.end();
  }

  return {
    child,
    config,
    kill: () => killProcessTree(child, config.killSignal),
    send: config.persistent
      ? (text: string) => {
          if (!child.stdin?.writable) return;
          const msg = JSON.stringify({
            type: 'user',
            message: { role: 'user', content: [{ type: 'text', text }] },
          });
          child.stdin.write(msg + '\n');
        }
      : undefined,
  };
}
```

**Плюсы:**
- Минимум кода (~120 LOC в двух файлах)
- Нет классов, нет наследования, нет интерфейсов
- Новый CLI = добавить запись в AGENT_CONFIGS
- Легко тестировать (pure config + one function)
- Не ломает существующий код — TeamProvisioningService может использовать или не использовать

**Минусы:**
- Output parsing НЕ покрыт (каждый CLI имеет свою структуру NDJSON)
- MCP config injection для Codex/Gemini требует отдельной логики (write to config.toml, run `gemini mcp add`)
- `persistent: true` (Claude) vs one-shot (все остальные) — фундаментально разный lifecycle

**Надёжность: 7/10** — Покрывает spawn, но не parsing.
**Уверенность: 8/10** — Config-based подход проверен в ScheduledTaskExecutor.

---

### Option B: Thin interface + implementations

**~200 LOC total** (interface + claude adapter + generic one-shot adapter)

```typescript
// src/main/adapters/AgentAdapter.ts (~30 LOC)

import type { ChildProcess } from 'child_process';

export interface AgentOutput {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'result' | 'error' | 'raw';
  content: string;
  raw?: unknown;
}

export interface AgentAdapter {
  readonly agentType: string;
  readonly persistent: boolean;

  /** Build CLI args for spawning */
  buildArgs(prompt: string, options: { model?: string; mcpConfigPath?: string; extraArgs?: string[] }): string[];

  /** Parse a single line/chunk of stdout into normalized output */
  parseOutput(line: string): AgentOutput | null;

  /** Send a follow-up message (only for persistent agents) */
  sendMessage?(child: ChildProcess, text: string): void;

  /** Which signal to use for kill */
  killSignal: NodeJS.Signals;
}
```

```typescript
// src/main/adapters/ClaudeAdapter.ts (~60 LOC)
export class ClaudeAdapter implements AgentAdapter {
  readonly agentType = 'claude';
  readonly persistent = true;
  readonly killSignal = 'SIGKILL' as const;

  buildArgs(prompt: string, options) {
    const args = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
    ];
    if (options.mcpConfigPath) args.push('--mcp-config', options.mcpConfigPath);
    if (options.model) args.push('--model', options.model);
    args.push(...(options.extraArgs ?? []));
    return args;
    // prompt sent via sendMessage(), not in args
  }

  parseOutput(line: string): AgentOutput | null {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'assistant') return { type: 'text', content: /* extract */, raw: obj };
      if (obj.type === 'result') return { type: 'result', content: obj.result?.text ?? '', raw: obj };
      return { type: 'raw', content: line, raw: obj };
    } catch { return null; }
  }

  sendMessage(child: ChildProcess, text: string) {
    if (!child.stdin?.writable) return;
    child.stdin.write(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    }) + '\n');
  }
}
```

```typescript
// src/main/adapters/OneShotAdapter.ts (~80 LOC)
// Generic one-shot adapter configurable for Codex, Goose, Gemini, OpenCode

export interface OneShotConfig {
  agentType: string;
  subcommand?: string;          // 'exec', 'run', etc.
  outputFlag: string[];         // ['--json'], ['--output-format', 'stream-json'], etc.
  promptFlag?: string;          // '-p', '-t', or undefined for positional
  mcpFlag?: string;             // '--with-extension' for goose
  killSignal?: NodeJS.Signals;
}

export class OneShotAdapter implements AgentAdapter {
  readonly persistent = false;
  readonly agentType: string;
  readonly killSignal: NodeJS.Signals;
  private config: OneShotConfig;

  constructor(config: OneShotConfig) {
    this.config = config;
    this.agentType = config.agentType;
    this.killSignal = config.killSignal ?? 'SIGTERM';
  }

  buildArgs(prompt: string, options) {
    const args: string[] = [];
    if (this.config.subcommand) args.push(this.config.subcommand);
    args.push(...this.config.outputFlag);
    if (options.mcpConfigPath && this.config.mcpFlag) {
      args.push(this.config.mcpFlag, options.mcpConfigPath);
    }
    args.push(...(options.extraArgs ?? []));
    if (this.config.promptFlag) {
      args.push(this.config.promptFlag, prompt);
    } else {
      args.push(prompt); // positional
    }
    return args;
  }

  parseOutput(line: string): AgentOutput | null {
    try {
      const obj = JSON.parse(line);
      return { type: 'raw', content: line, raw: obj };
    } catch { return null; }
  }
}

// Pre-built instances:
export const codexAdapter = new OneShotAdapter({
  agentType: 'codex', subcommand: 'exec', outputFlag: ['--json'], killSignal: 'SIGTERM',
});
export const gooseAdapter = new OneShotAdapter({
  agentType: 'goose', subcommand: 'run', outputFlag: ['--output-format', 'stream-json'],
  promptFlag: '-t', mcpFlag: '--with-extension',
});
export const geminiAdapter = new OneShotAdapter({
  agentType: 'gemini', outputFlag: ['--output-format', 'json'], promptFlag: '-p',
});
export const opencodeAdapter = new OneShotAdapter({
  agentType: 'opencode', subcommand: 'run', outputFlag: ['--format', 'json'],
});
```

**Плюсы:**
- `parseOutput()` даёт место для нормализации вывода каждого CLI
- Чёткое разделение: Claude (persistent) vs all others (one-shot)
- `OneShotAdapter` — generic, покрывает 4 из 5 CLI одним классом
- Новый CLI = `new OneShotAdapter({ ... })` (одна строка)

**Минусы:**
- Интерфейс + 2 класса — чуть больше "архитектуры" чем нужно прямо сейчас
- `parseOutput()` для не-Claude CLI будет пустышкой (return raw) пока не изучим их NDJSON формат
- Всё ещё не решает MCP injection для Codex (config.toml) и Gemini (settings.json)

**Надёжность: 8/10** — Хороший баланс между простотой и расширяемостью.
**Уверенность: 7/10** — Interface-based подход стандартен, но `parseOutput` рискует стать "мёртвым кодом" на начальном этапе.

---

### Option C: Расширить childProcess.ts (минимальные изменения) **(Recommended)**

**~50 LOC additions** к существующему файлу + **~30 LOC** отдельный config

```typescript
// Добавить в src/main/utils/childProcess.ts (~25 LOC)

export type AgentType = 'claude' | 'codex' | 'gemini' | 'goose' | 'opencode';

export interface AgentSpawnResult {
  child: ChildProcess;
  send?: (text: string) => void;
  kill: () => void;
}

/**
 * Spawn any supported CLI agent. Thin wrapper over spawnCli that
 * handles binary name, output-format flags, and prompt injection.
 */
export function spawnAgent(
  type: AgentType,
  binaryPath: string,
  prompt: string,
  options: SpawnOptions & { mcpConfigPath?: string; extraArgs?: string[] } = {}
): AgentSpawnResult {
  const cfg = AGENT_SPAWN_CONFIGS[type];
  const args = [...cfg.baseArgs];
  if (options.mcpConfigPath && cfg.mcpFlag) {
    args.push(cfg.mcpFlag, options.mcpConfigPath);
  }
  if (options.extraArgs) args.push(...options.extraArgs);
  if (cfg.promptFlag) args.push(cfg.promptFlag, prompt);
  else if (!cfg.stdinPrompt) args.push(prompt);

  const child = spawnCli(binaryPath, args, {
    ...options,
    env: { ...(options.env ?? process.env), ...(cfg.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Inject prompt via stdin if needed
  if (cfg.stdinPrompt && child.stdin?.writable) {
    const msg = cfg.stdinPrompt === 'stream-json'
      ? JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n'
      : prompt;
    child.stdin.write(msg);
    if (cfg.stdinPrompt === 'pipe') child.stdin.end();
  }

  return {
    child,
    send: cfg.stdinPrompt === 'stream-json'
      ? (text: string) => {
          if (!child.stdin?.writable) return;
          child.stdin.write(JSON.stringify({
            type: 'user',
            message: { role: 'user', content: [{ type: 'text', text }] },
          }) + '\n');
        }
      : undefined,
    kill: () => killProcessTree(child, cfg.killSignal),
  };
}
```

```typescript
// src/main/utils/agentConfigs.ts (~30 LOC)

interface AgentSpawnConfig {
  baseArgs: string[];
  promptFlag?: string;           // undefined = positional arg
  stdinPrompt?: 'stream-json' | 'pipe';
  mcpFlag?: string;
  killSignal: NodeJS.Signals;
  env?: Record<string, string>;
}

export const AGENT_SPAWN_CONFIGS: Record<string, AgentSpawnConfig> = {
  claude: {
    baseArgs: ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
    stdinPrompt: 'stream-json',
    mcpFlag: '--mcp-config',
    killSignal: 'SIGKILL',
    env: { CLAUDE_HOOK_JUDGE_MODE: 'true' },
  },
  codex: {
    baseArgs: ['exec', '--json'],
    killSignal: 'SIGTERM',
  },
  gemini: {
    baseArgs: ['--output-format', 'json'],
    promptFlag: '-p',
    killSignal: 'SIGTERM',
  },
  goose: {
    baseArgs: ['run', '--output-format', 'stream-json'],
    promptFlag: '-t',
    mcpFlag: '--with-extension',
    killSignal: 'SIGTERM',
  },
  opencode: {
    baseArgs: ['run', '--format', 'json'],
    killSignal: 'SIGTERM',
  },
};
```

**Плюсы:**
- Абсолютный минимум нового кода (~55 LOC)
- Не создаёт новую абстракцию — расширяет существующую
- TeamProvisioningService может постепенно мигрировать (или нет)
- Новый CLI = 5 строк в конфиге
- Binary resolution остаётся на вызывающей стороне (как сейчас с ClaudeBinaryResolver)
- Output parsing — ответственность вызывающего кода (не навязываем)

**Минусы:**
- Не покрывает output parsing (сознательно)
- Не покрывает MCP config injection для Codex/Gemini
- childProcess.ts станет чуть толще (~275 LOC вместо 221)
- Нет типизации вывода (каждый consumer парсит сам)

**Надёжность: 7/10** — Минимально, но достаточно для spawn.
**Уверенность: 9/10** — Расширение существующего утилитного файла — самый безопасный путь.

---

## 5. Сравнительная таблица

| Критерий | Option A (config+fn) | Option B (interface) | Option C (extend existing) |
|----------|---------------------|---------------------|---------------------------|
| **LOC** | ~120 | ~200 | ~55 |
| **Новых файлов** | 2 | 3 | 1 |
| **Output parsing** | Нет | Да (заглушка) | Нет |
| **MCP injection** | Описано, не реализовано | Описано, не реализовано | Описано, не реализовано |
| **Расширяемость** | Хорошая (конфиг) | Отличная (интерфейс) | Хорошая (конфиг) |
| **Breaks existing?** | Нет | Нет | Нет |
| **Time to implement** | 1 час | 2 часа | 30 мин |
| **"Велосипед"?** | Нет, это конфиг | Нет, но чуть преждевременно | Нет, это 55 строк клея |

---

## 6. Рекомендация

### Начать с Option C (extend childProcess.ts), при необходимости вырастить в Option A

**Почему:**

1. **55 LOC — это не велосипед.** Это минимальный config-driven dispatcher. Любой проект, интегрирующий несколько CLI, пишет ровно это. Нет смысла тянуть зависимость ради 55 строк.

2. **Output parsing — отдельная задача.** Парсинг NDJSON от Codex/Gemini/Goose — это ~50-100 LOC на каждый CLI, и его не нужно решать сейчас. Когда понадобится — это будет Option B (interface с `parseOutput()`), но не раньше.

3. **MCP injection — тоже отдельная задача.** Для Claude у нас уже есть TeamMcpConfigBuilder. Для Goose — это просто `--with-extension`. Для Codex/Gemini — нужно писать в их config files. Это 3 отдельных утилиты, не общий адаптер.

4. **Persistent vs one-shot — фундаментально разный lifecycle.** Claude (stream-json loop) живёт долго и получает новые сообщения. Все остальные — fire-and-forget. Эту разницу нельзя "спрятать" за единым интерфейсом без того чтобы интерфейс не стал дырявой абстракцией.

### Эволюционный путь:

```
Этап 1 (сейчас): Option C — spawnAgent() в childProcess.ts + agentConfigs.ts
                  55 LOC, покрывает spawn для всех 5 CLI

Этап 2 (когда добавим 2-й CLI): Вынести в отдельный файл если childProcess.ts станет перегруженным
                                 Может стать Option A (~120 LOC)

Этап 3 (когда нужен output parsing): Добавить parseOutput() per agent
                                      Может стать Option B (~200 LOC)
```

---

## 7. Честный ответ: "велосипед" или нет?

**Нет, это НЕ велосипед.** Вот почему:

1. **Нет готовой библиотеки.** Не существует npm-пакета "universal-cli-agent-spawner". Каждый из этих CLI — молодой продукт (2025-2026), с собственным протоколом. Никто ещё не написал унификатор.

2. **55-200 LOC клея — это норма.** Для сравнения:
   - Docker SDK для Node.js: ~300 LOC для spawn docker CLI
   - Terraform CDK: ~200 LOC для spawn terraform binary
   - VS Code extensions: ~150 LOC для spawn language server

3. **Наш существующий spawnCli() — уже 65 LOC** клея для одного Claude CLI. Расширить его до 5 CLI за +55 LOC — это линейное масштабирование, не экспоненциальное.

4. **Реальный "велосипед" начался бы** если бы мы писали:
   - Свой MCP client (~500+ LOC)
   - Свой NDJSON parser с backpressure (~200 LOC)
   - Свой process supervisor с restart policies (~400 LOC)
   - Свой auth token manager per CLI (~300 LOC)

   Мы этого НЕ делаем. Мы пишем config map + одну функцию.

5. **Большую часть сложности (8000 LOC TeamProvisioningService) мы уже написали** для Claude — и она Claude-specific. Адаптер для других CLI будет использовать ~5% от этого кода.

---

## 8. Что НЕ включать в адаптер

Явно НЕ входит в scope минимального адаптера:
- Output parsing/normalization (отдельный слой)
- Team protocol (Agent Teams — Claude-only)
- MCP config generation (отдельный builder per CLI)
- Binary auto-discovery/installation (отдельный resolver per CLI)
- Auth management (каждый CLI сам)
- Session persistence (каждый CLI сам)
- Stall/timeout detection (caller responsibility)
- Progress reporting (caller responsibility)

Это всё валидная функциональность, но она живёт ВЫШЕ адаптера, в orchestration layer (TeamProvisioningService или его аналог).
