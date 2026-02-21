# Research: CLI Orchestration for Team Provisioning

## Status: RESEARCH COMPLETE (v2)

Результаты исследования 10 агентов (3 + 4 + 3) по запуску Claude CLI для создания команд.
Раунд 3 — верификация и финальная архитектура.

---

## 1. Варианты запуска Claude CLI

### 1.1 Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)

**Пакет**: `@anthropic-ai/claude-agent-sdk` v0.2.44 (npm)
**Repo**: `github.com/anthropics/claude-agent-sdk-typescript`
**Статус**: Official, maintained by Anthropic, pre-1.0

#### API

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const msg of query({
  prompt: "Create a team to work on X",
  options: {
    allowedTools: ["TeamCreate", "TaskCreate", "SendMessage", "Read", "Edit", "Bash"],
    model: "opus",
    maxTurns: 250,
    cwd: "/path/to/project",
    permissionMode: "acceptEdits", // или "bypassPermissions"
  }
})) {
  console.log(msg); // SDKMessage — structured
}
```

#### Характеристики

| Параметр | Значение |
|----------|----------|
| Startup overhead | ~12 сек per query() call |
| Hot process reuse | НЕТ (issue #34 в SDK repo) |
| Internal mechanism | Спавнит Claude Code CLI как subprocess |
| Team tools | Доступны с `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` |
| Streaming | AsyncGenerator<SDKMessage> |
| Multi-turn | Stateless — каждый query() = новая сессия |
| Node.js | 18+ |
| Electron compatible | Да (main process only) |

#### V2 Preview (simpler API)

```typescript
import { unstable_v2_prompt } from "@anthropic-ai/claude-agent-sdk";
const result = await unstable_v2_prompt("What is 2 + 2?");
```

#### Проблемы

- **12 сек startup** — непригоден для real-time UX
- **No hot reuse** — каждый вызов = new process (issue #34)
- **Pre-1.0** — API может измениться
- **Team features experimental** — документированные issues:
  - Session resumption breaks team state
  - Task status can lag
  - Shutdown slow
  - One team per session

### 1.2 CLI с `--output-format stream-json`

**Флаги**:

| Флаг | Опции | Описание |
|------|-------|----------|
| `--output-format` | `text`, `json`, `stream-json` | Формат stdout |
| `--input-format` | `text`, `stream-json` | Формат stdin |
| `-p "prompt"` | string | Non-interactive (print mode) |
| `--verbose` | flag | Подробный вывод |

#### Stream-JSON Protocol (NDJSON)

Каждая строка — полный JSON object:

```json
{"type":"init","session_id":"abc123","timestamp":"2024-01-01T00:00:00Z"}
{"type":"message","role":"assistant","content":[{"type":"text","text":"Analyzing..."}]}
{"type":"tool_use","name":"TeamCreate","input":{"team_name":"my-team","description":"..."}}
{"type":"tool_result","output":"Team created successfully"}
{"type":"result","status":"success","duration_ms":1234}
```

#### Можно детектить tool_use events

```bash
claude -p "Create a team" --output-format stream-json | \
  jq 'select(.type == "tool_use" and .name == "TeamCreate")'
```

#### Проблемы

- **Баг #5034**: `--input-format stream-json` дублирует entries в session .jsonl при multi-turn
- **Stateful parsing**: tool_result не имеет поля `previous_event` → нужна корреляция вручную
- **stdio buffer**: 64KB platform limit → deadlock если не drain'ить
- **Encoding**: UTF-8 multi-byte может порваться на chunk boundary
- **Backpressure**: если не читаем stdout → subprocess зависает

### 1.3 CLI с file-based monitoring (без парсинга stdout)

```bash
spawn(claudePath, [prompt], {
  stdio: ['ignore', 'ignore', 'pipe'], # stdout ИГНОРИРУЕМ, stderr для ошибок
})
```

Мониторинг через FileWatcher:

```
~/.claude/teams/{name}/config.json    → team created/updated
~/.claude/teams/{name}/inboxes/*.json → messages
~/.claude/tasks/{name}/*.json         → tasks
~/.claude/projects/{path}/{id}.jsonl  → session data (already parsed by app)
```

#### Преимущества

- JSONL = stable API contract (не меняется между версиями CLI)
- FileWatcher уже есть в проекте (retry, SSH polling, debounce)
- Crash-safe: файлы на диске сохраняются
- No buffer overflow: читаем файлы, не pipes
- Масштабируется: один FileWatcher для N агентов

---

## 2. Проблема PATH на macOS

### Суть проблемы

Когда Electron запускается из macOS Finder (не из терминала), `process.env.PATH` минимальный:

```
/usr/bin:/bin:/usr/sbin:/sbin
```

**Отсутствуют**: `/usr/local/bin`, `~/.npm/bin`, `~/.nvm/versions/...`, `/opt/homebrew/bin`

`spawn('claude', [...])` → **ENOENT** ("command not found")

### Где Claude CLI устанавливается

| Метод | Путь бинарника |
|-------|----------------|
| npm global | `/usr/local/bin/claude` (symlink) |
| npm global (user) | `~/.npm-global/bin/claude` |
| nvm + npm | `~/.nvm/versions/node/v20/bin/claude` |
| Homebrew (Intel) | `/usr/local/bin/claude` |
| Homebrew (Apple Silicon) | `/opt/homebrew/bin/claude` |
| Windows | `C:\Users\{user}\AppData\Roaming\npm\claude.cmd` |

### Решение: ClaudeBinaryResolver

```typescript
async function resolveClaudeBinary(): Promise<string | null> {
  const candidates = [
    // 1. Try current PATH first (works in terminal)
    'claude',
    // 2. Common npm global paths
    path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
    path.join(os.homedir(), '.npm', 'bin', 'claude'),
    // 3. System paths
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude', // Apple Silicon
    // 4. nvm — find active version
    ...await findNvmClaudePaths(),
    // 5. Windows
    ...(process.platform === 'win32'
      ? [`${process.env.APPDATA}\\npm\\claude.cmd`]
      : []),
  ];

  for (const candidate of candidates) {
    try {
      await fs.promises.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch { continue; }
  }

  // Fallback: `which claude`
  try {
    const { stdout } = await execFileAsync('which', ['claude'], {
      timeout: 2000, shell: true
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
```

### Существующие паттерны в проекте

- `config.ts:570-604` — пробует несколько editor candidates (cursor, code, subl, zed)
- `SshConnectionManager.ts:325` — использует ПОЛНЫЙ путь: `/bin/launchctl`
- `fix-path` / `shell-path` НЕ используются в проекте

---

## 3. stdio vs File Monitoring

### Сравнительная матрица

| Критерий | stdio Pipes | File Monitoring |
|----------|-------------|-----------------|
| **Потеря данных** | ВЫСОКИЙ РИСК (buffer overflow 64KB) | НЕТ РИСКА (файлы на диске) |
| **Latency** | ~0ms (pipe events) | 0-100ms (fs.watch), 3-30s (polling) |
| **Structured data** | Нужен парсинг (NDJSON или raw text) | JSONL уже structured |
| **Crash recovery** | Потеря буфера | Файлы сохранены |
| **Memory** | Накапливает в буферах | Читаем инкрементально |
| **Complexity** | State machine + backpressure + timeouts | Уже реализовано (FileWatcher) |
| **Fragility** | Ломается при смене формата CLI | JSONL = stable contract |
| **Масштаб** | 10 agents × stdio = resource explosion | Один watcher на все файлы |

### Конкретные риски stdio

1. **Buffer overflow**: stdout buffer = 64KB. Claude team session легко генерит > 64KB → subprocess deadlock
2. **Partial JSON reads**: chunk boundary может порвать JSON object → нужен stateful line parser
3. **Backpressure**: если не drain'ить pipe → Claude CLI зависает навсегда
4. **Encoding**: multi-byte UTF-8 рвётся на chunk boundaries
5. **ANSI escapes**: Claude может слать цветные коды (даже в pipe mode)

### Вердикт

**Hybrid**: stdio ТОЛЬКО для lifecycle (started/stopped/crashed), файлы для ВСЕХ данных.

---

## 4. Сравнение подходов

| | **SDK query()** | **CLI + stream-json** | **CLI + file monitoring** |
|---|---|---|---|
| Startup | ~12 сек (!) | ~2-3 сек | ~2-3 сек |
| Structured output | SDKMessage | NDJSON events | JSONL files |
| TeamCreate detection | Да | Да (tool_use event) | Да (config.json appears) |
| Multi-turn | Stateless per query | Баг #5034 | Работает |
| stdio risks | Hidden in SDK | Buffer/encoding/deadlock | Нет (файлы) |
| Crash recovery | Потеря | Потеря | Автоматическое |
| PATH resolution | SDK сам резолвит | Нужен resolver | Нужен resolver |
| API stability | Pre-1.0 | Experimental | JSONL stable |
| Hot reuse | Нет (issue #34) | N/A | N/A |

---

## 5. Env Variable для Team Tools

Team tools **выключены по умолчанию**. Для включения:

```bash
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

Или в `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

Доступные team tools:
- `TeamCreate` — создание команды
- `TaskCreate` — создание задачи
- `TaskUpdate` — обновление статуса задачи
- `TaskList` — список задач
- `TaskGet` — получение задачи по ID
- `SendMessage` — отправка сообщения участнику
- `TeamDelete` — удаление команды

---

## 6. Ограничения Agent Teams (из официальной документации)

1. `/resume` и `/rewind` ломают team state
2. Task status может отставать — teammates иногда не отмечают tasks completed
3. Shutdown медленный — teammates завершают текущий request перед выходом
4. Один team per session — нельзя управлять несколькими командами из одного lead
5. Нет nested teams — teammates не могут создавать свои команды
6. Token cost высокий — каждый teammate = отдельное context window
7. Split-pane mode fragile — требует tmux или iTerm2

---

## 7. Верификация (раунд 3, 3 агента)

### 7.1 Вердикт по SDK: НЕТ

**Финальный вердикт**: SDK query() НЕ использовать.

Причины:
1. SDK **внутри спавнит CLI как subprocess** — нет выигрыша по сравнению с прямым spawn
2. ~12 сек cold start per query() call — неприемлемо для UX
3. Pre-1.0: API может измениться без предупреждения
4. SDK **не решает** проблему PATH resolution — всё равно нужен resolver
5. Team features experimental — задокументированные баги с session resumption, task lag, slow shutdown
6. Никакой добавленной ценности: FileWatcher уже делает всё, что мог бы дать SDK streaming

### 7.2 Верификация file monitoring: ОК с оговорками

**Находка**: CLI flag `-p` (print mode) **выходит после первого ответа**. Для multi-turn team creation:
- Вариант A: `--continue --resume $SESSION_ID` для продолжения сессии
- Вариант B: **Одноходовый промпт** — Claude за один turn вызывает TeamCreate + TaskCreate + спавнит teammates
- **Рекомендация**: Вариант B (одноходовый) — достаточно для bootstrap, проще и надёжнее

**Session JSONL parsing**: В JSONL session файле видны:
- `tool_use` с `name: "TeamCreate"` → команда создана
- `tool_result` с `teammate_spawned` → участник запущен
- SubagentResolver в проекте **уже умеет** детектить `teammate_spawned`

**Edge cases**:
- Mid-creation crash → retry safe (TeamCreate идемпотентен — перезаписывает config.json)
- Concurrent creation attempts → лок на teamName (validateTeamName + state machine)
- Dir exists without config.json → graceful skip (уже исправлено в v7, баг #37)
- Tasks dir ENOENT → return [] (уже исправлено в v7, баг #38)

### 7.3 Финальная архитектура (верифицирована)

#### Новые файлы (7)

| Файл | Описание |
|------|----------|
| `src/main/services/teams/ClaudeBinaryResolver.ts` | Поиск бинарника Claude CLI |
| `src/main/services/teams/TeamProvisioningService.ts` | State machine для создания команды |
| `src/main/services/teams/types.ts` | Типы для provisioning |
| `src/main/ipc/teams.ts` | IPC handlers для provisioning |
| `src/preload/constants/teamChannels.ts` | IPC channel constants |
| `src/renderer/hooks/useTeamProvisioning.ts` | React hook |
| `src/renderer/components/teams/CreateTeamDialog.tsx` | UI диалог создания |

#### Модификации (5)

| Файл | Изменение |
|------|-----------|
| `src/main/ipc/handlers.ts` | + registerTeamProvisioningHandlers |
| `src/preload/index.ts` | + api.teams.create, api.teams.getProvisioningStatus |
| `src/renderer/store/slices/teamSlice.ts` | + provisioning state |
| `src/main/services/infrastructure/FileWatcher.ts` | Уже добавлен в v7 (teamsWatcher) |
| `src/shared/types/ElectronAPI.ts` | + provisioning types |

#### State Machine

```
idle → validating → spawning → monitoring → ready
                                           ↘ failed → idle (retry)
```

- `idle` — начальное состояние
- `validating` — проверка teamName, поиск Claude binary
- `spawning` — spawn CLI process
- `monitoring` — ожидание config.json через FileWatcher
- `ready` — команда создана, participants bootstrapped
- `failed` — ошибка (с retry)

#### IPC Contract

```typescript
// Channels
export const TEAM_CREATE = 'team:create';
export const TEAM_PROVISIONING_STATUS = 'team:provisioning-status';
export const TEAM_PROVISIONING_PROGRESS = 'team:provisioning-progress'; // event

// Request
interface TeamCreateRequest {
  teamName: string;
  description: string;
  members: Array<{ name: string; role: string }>;
  cwd: string; // project working directory
}

// Response (via event stream)
interface ProvisioningProgress {
  teamName: string;
  state: 'validating' | 'spawning' | 'monitoring' | 'ready' | 'failed';
  message: string;
  error?: string;
  sessionId?: string;
}
```

#### Spawn Strategy

```typescript
const claudePath = await ClaudeBinaryResolver.resolve();
if (!claudePath) throw new Error('Claude CLI not found');

const child = spawn(claudePath, [
  '-p', prompt,           // print mode (single turn)
  '--output-format', 'text', // НЕ парсим stdout
], {
  cwd: projectPath,
  env: {
    ...process.env,
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  },
  stdio: ['ignore', 'ignore', 'pipe'], // stdout ИГНОРИРУЕМ
});

// Только stderr для ошибок
child.stderr.on('data', (data) => { stderrBuffer += data; });

// Lifecycle
child.on('exit', (code) => {
  if (code === 0) transitionTo('monitoring');
  else transitionTo('failed', stderrBuffer);
});
child.on('error', (err) => transitionTo('failed', err.message));
```

#### Bootstrap Detection

```typescript
// FileWatcher УЖЕ следит за ~/.claude/teams/
// При появлении config.json → проверяем содержимое

function onTeamConfigCreated(teamName: string) {
  const config = await readTeamConfig(teamName);
  if (config && config.members?.length > 0) {
    transitionTo('ready');
    emitProgress({ state: 'ready', sessionId });
  }
}
```

#### Idempotency

1. `validateTeamName()` проверяет формат (a-z, 0-9, -)
2. Если dir уже существует с config.json → **ошибка** (не перезаписываем чужую команду)
3. Если dir существует БЕЗ config.json → **очищаем и продолжаем** (неудачная предыдущая попытка)
4. PID tracking для active processes → нельзя запустить два provisioning для одного teamName

---

## 8. Итоговая рекомендация

### Подход: CLI spawn + FileWatcher (hybrid)

```
[UI] → [IPC: team:create] → [TeamProvisioningService]
                                   ↓
                            [ClaudeBinaryResolver.resolve()]
                                   ↓
                            [spawn(claudePath, ['-p', prompt], {
                               env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
                               stdio: ['ignore', 'ignore', 'pipe']
                            })]
                                   ↓
                            [FileWatcher: ~/.claude/teams/{name}/config.json]
                                   ↓
                            [IPC event: team:provisioning-progress → 'ready']
```

### Почему НЕ другие варианты

| Вариант | Причина отказа |
|---------|----------------|
| SDK query() | Внутри = тот же spawn, +12с overhead, pre-1.0, не решает PATH |
| CLI + stream-json | stdio fragile (64KB buffer), баг #5034, нужен stateful parser |
| CLI + stdout pipe | Buffer overflow, encoding, backpressure — все те же риски |
| tmux/iTerm2 | Не подходит для Electron (нет терминала) |

---

## 9. Sources

### Official Documentation
- [CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Run Claude Code programmatically](https://code.claude.com/docs/en/headless)
- [Orchestrate teams](https://code.claude.com/docs/en/agent-teams)
- [Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Agent SDK TypeScript](https://platform.claude.com/docs/en/agent-sdk/typescript)

### NPM / GitHub
- [npmjs.com/@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
- [github.com/anthropics/claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript)

### Known Issues
- [#5034 — Duplicate entries in stream-json](https://github.com/anthropics/claude-code/issues/5034)
- [#1920 — Missing Final Result Event in Streaming JSON](https://github.com/anthropics/claude-code/issues/1920)
- [#34 — Hot process reuse for SDK](https://github.com/anthropics/claude-agent-sdk-typescript/issues/34)
- [#15511 — Stream partial JSON tokens](https://github.com/anthropics/claude-code/issues/15511)

### Community
- [Building agents with Claude Agent SDK — Anthropic Engineering](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk)
- [Agent Teams with Claude Code — Medium](https://kargarisaac.medium.com/agent-teams-with-claude-code-and-claude-agent-sdk-e7de4e0cb03e)
- [Claude Code Multi-Agent tmux Setup — Dariusz Parys](https://www.dariuszparys.com/claude-code-multi-agent-tmux-setup/)
