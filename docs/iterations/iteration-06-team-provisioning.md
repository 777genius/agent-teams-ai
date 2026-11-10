# Итерация 06 — Team Provisioning (Create Team из UI через CLI + File Monitoring)

Эта итерация добавляет **создание команды из UI**: пользователь задаёт параметры команды, приложение запускает CLI-процесс, затем **верифицирует результат через файлы** в `~/.claude/teams/**` и сообщает прогресс в UI.

Основание:
- `docs/team-management/research-cli-orchestration.md` (v2) — итоговая схема spawn + monitoring, PATH на macOS
- `docs/team-management/README.md` — важные ограничения формата (`config.json` members неполный)
- Текущая реализация Team Management (итерации 01–04): `team:list`, `team:getData`, `team:change`, `team:sendMessage`, `team:requestReview`, `team:updateKanban`

---

## Цель итерации

- В `Teams` появляется кнопка **Create Team**.
- Открывается диалог создания команды:
  - `teamName` (канонический ID = имя директории)
  - `displayName` (пишется в `config.json.name`, по умолчанию = `teamName`)
  - `description` (опционально)
  - `members` (минимум 1 имя; роли опциональны — только для prompt)
  - `cwd` (рабочая директория проекта; выбирается через нативный folder picker)
- По нажатию Create:
  - main process валидирует входные данные и **находит путь к CLI бинарнику** (macOS PATH fix).
  - запускает CLI в **одноходовом** режиме (`-p`) с env `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.
  - UI получает **стрим прогресса**: `validating → spawning → monitoring → verifying → ready/failed/cancelled`.
- Команда считается созданной (готовой к просмотру в UI), когда:
  - `~/.claude/teams/{teamName}/config.json` существует и является валидным JSON, содержащим `name: string`.
  - `team:list` начинает возвращать эту команду.

---

## Не-цели (строго вне scope)

- Создание/управление задачами через provisioning (TaskCreate, seed tasks) — только в prompt как best-effort, без жёсткой верификации.
- Гарантия, что teammates “точно запущены” и отвечают — MVP provisioning считает успехом создание команды (config), остальное — последующие итерации/полировка.
- Поддержка provisioning в SSH-context (remote) — **только local context**.
- Парсинг stdout CLI (`stream-json`, NDJSON) — **не делаем**, чтобы исключить backpressure/encoding/64KB буферы.
- Авто-удаление существующих директорий команды.
- Интеграция `leadSessionId` с session viewer (это отдельная задача).

---

## Допущения и ограничения (явно)

- Provisioning работает **только в local context**.
- CLI provisioning не гарантирует, что все участники сразу “живые” и отвечают. MVP-критерий успеха — **созданная команда** (валидный `config.json`).
- `config.json.members` **не является** источником полного списка участников. Полный roster будет восстанавливаться как и сейчас: `union(config members + inbox filenames + task owners)`.
- Любые частичные артефакты на диске после `cancelled/failed` **не удаляются автоматически**.

---

## Контракт итерации (Main → Preload → Renderer)

### IPC каналы (flat `export const` в `src/preload/constants/ipcChannels.ts`)

- `TEAM_CREATE = 'team:create'`
- `TEAM_PROVISIONING_STATUS = 'team:provisioningStatus'`
- `TEAM_PROVISIONING_PROGRESS = 'team:provisioningProgress'` (event main → renderer)

### Shared types (`src/shared/types/team.ts`)

Добавляем:

```ts
export type TeamProvisioningState =
  | 'idle'
  | 'validating'
  | 'spawning'
  | 'monitoring'
  | 'verifying'
  | 'ready'
  | 'failed'
  | 'cancelled';

export interface TeamProvisioningMemberInput {
  name: string;
  role?: string;
}

export interface TeamCreateRequest {
  teamName: string;          // canonical ID (directory name)
  displayName?: string;      // config.json.name (default = teamName)
  description?: string;
  members: TeamProvisioningMemberInput[];
  cwd: string;               // project working directory
}

export interface TeamCreateResponse {
  runId: string;
}

export interface TeamProvisioningProgress {
  runId: string;
  teamName: string;
  state: Exclude<TeamProvisioningState, 'idle'>;
  message: string;
  startedAt: string;         // ISO
  updatedAt: string;         // ISO
  pid?: number;
  error?: string;
  warnings?: string[];
}
```

### Семантика IPC (без двусмысленностей)

- `team:create(request)`:
  - валидирует `teamName`, `cwd`, `members` (см. правила валидации ниже)
  - если команда уже существует (`~/.claude/teams/{teamName}/config.json` существует) → `IpcResult` error (“Team already exists”)
  - если provisioning уже запущен для этого `teamName` → `IpcResult` error (“Provisioning already running”)
  - иначе стартует provisioning и возвращает `{ runId }`
- `team:provisioningStatus(runId)`:
  - возвращает текущий snapshot прогресса (или ошибку “Unknown runId”)
- `team:provisioningProgress` (event):
  - отправляется при каждом переходе state machine (и при важных milestones внутри шага)
  - payload всегда включает `runId`, чтобы UI мог безопасно фильтровать

### Правила валидации (без двусмысленностей)

- `teamName`:
  - строка, trim не пустой
  - только `[a-z0-9-]`, длина 1..64
  - не может начинаться/заканчиваться на `-`
  - не может содержать `..`, `/`, `\`, пробелы
- `cwd`:
  - абсолютный путь
  - должен существовать и быть директорией
- `members[].name`:
  - строка, trim не пустой
  - валидируем тем же правилом, что и для inbox member name (чтобы любые best-effort проверки файлов не открывали путь traversal)
  - дубликаты по имени запрещены

---

## Архитектура provisioning (main)

### State machine

```
idle
  → validating
  → spawning
  → monitoring
  → verifying
  → ready
        ↘ failed
        ↘ cancelled
```

### Binary resolution (macOS PATH проблема)

Добавляем `ClaudeBinaryResolver` (main):

- сперва пробуем `claude` в текущем PATH (на случай запуска из терминала)
- затем common paths (`/usr/local/bin/claude`, `/opt/homebrew/bin/claude`, `~/.npm-global/bin/claude`, nvm paths, Windows `.cmd`)
- если не найдено → понятная ошибка для UI (“Claude CLI не найден; установите или укажите путь”)
- **запрещено** использовать `shell: true` для любых вызовов

### Spawn contract (одноходовый, без stdout)

Запуск:

- args: `['-p', prompt, '--output-format', 'text']`
- env: `...process.env` + `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
- `cwd = request.cwd`
- `stdio = ['ignore', 'ignore', 'pipe']`
  - stdin ignored (неинтерактивно)
  - stdout ignored (не читаем и не рискуем deadlock’ом)
  - stderr piped (только для диагностики)

**Важно (без двусмысленностей): stderr pipe обязателен к drain’у.**

- мы **всегда** читаем `child.stderr.on('data')` и:
  - складываем в ring-buffer (например, последние 64KB), чтобы не держать бесконечный лог в памяти
  - используем для `failed.error` (обрезанный, безопасный текст)

### Таймауты и зависания (без двусмысленностей)

- Если процесс не завершился за `T_TOTAL` (например 2 минуты) → переводим в `failed` с ошибкой “Timed out waiting for CLI”.
- В тексте ошибки обязателен хинт:
  - CLI может требовать интерактивную авторизацию/онбординг
  - нужно запустить `claude` один раз из терминала и завершить онбординг, затем повторить provisioning

### Cancel semantics (без двусмысленностей)

- Cancel доступен только в состояниях: `spawning | monitoring | verifying`.
- При cancel:
  - если child process ещё существует → посылаем завершение (best-effort)
  - state становится `cancelled`
  - любые созданные файлы/директории **не удаляем**

### Monitoring + verifying (через файлы)

Monitoring триггерится после `exit code === 0` (или сразу, если config появляется раньше).

Проверки:
- `config.json` существует по пути `~/.claude/teams/{teamName}/config.json`
- JSON валиден
- `config.name` — непустая строка

Оговорка: `config.json.members` **не является** источником полного состава команды (см. `docs/team-management/README.md`). Поэтому эта итерация **не требует** полного roster в config как критерий успеха.

Дополнительная best-effort верификация (не блокирует ready):
- если prompt включает “bootstrap DM” каждому участнику, то ожидаем появление `inboxes/{member}.json`
- при таймауте: `ready` + `warnings: ['Some inboxes not created yet']`

### Разрешение конфликтов сигналов (без двусмысленностей)

- Если `config.json` стал валидным и прошёл verify, но процесс CLI завершился с non-zero:
  - итоговое состояние: `ready`
  - `warnings`: добавить строку вида “CLI exited with code X after config was created”
- Если процесс CLI завершился `0`, но `config.json` не появился/невалиден до таймаута verify:
  - итоговое состояние: `failed`
  - error: “TeamCreate did not produce a valid config.json”

---

## Изменения в UI (renderer)

### Точка входа

- В `TeamListView` добавляем кнопку **Create Team**.
- В browser-mode и SSH-context:
  - кнопка disabled + подпись “Доступно только в local Electron-режиме”.

### CreateTeamDialog (минимальный UX)

- Валидация на клиенте:
  - `teamName`: kebab-case `[a-z0-9-]` (сообщение об ошибке рядом с полем)
  - `members`: минимум 1; имена не пустые
  - `cwd`: обязателен
- После старта provisioning:
  - показываем шаги прогресса
  - показываем кнопку Cancel (если процесс ещё в `spawning/monitoring/verifying`)
  - при `ready`: кнопка “Open Team” (открывает team tab)
  - при `failed`: показываем error + “Retry” (повторно вызывает create; если команда уже создана — предлагаем открыть)

### Store contract (Zustand)

Добавляем в `teamSlice`:
- `provisioningRuns: Record<runId, TeamProvisioningProgress>`
- `activeProvisioningRunId: string | null`
- actions:
  - `createTeam(req): Promise<string /* runId */>`
  - `cancelProvisioning(runId): Promise<void>` (если делаем cancel в этой итерации)
  - subscribe/unsubscribe на `team:provisioningProgress`

---

## Выходные изменения (файлы)

### Новые файлы (ожидаемо)

- `src/main/services/team/ClaudeBinaryResolver.ts`
- `src/main/services/team/TeamProvisioningService.ts`
- `src/shared/types` (расширение `team.ts` provisioning-типами)
- `src/renderer/components/team/dialogs/CreateTeamDialog.tsx`

### Изменяемые файлы (ожидаемо)

- `src/preload/constants/ipcChannels.ts` (новые каналы)
- `src/shared/types/api.ts` (TeamsAPI: `createTeam`, `getProvisioningStatus`, `onProvisioningProgress`)
- `src/preload/index.ts` (bridge)
- `src/main/ipc/teams.ts` (+ handlers)
- `src/main/ipc/guards.ts` (валидация `cwd` и members, если нужно)
- `src/renderer/components/team/TeamListView.tsx` (кнопка + диалог)
- `src/renderer/store/slices/teamSlice.ts` (state + actions)

---

## Порядок работ (runbook) с контрольными точками

### CP0 — типы и IPC компилируются

1) Расширить shared types (provisioning contract).
2) Добавить IPC channels constants.
3) `pnpm typecheck`

### CP1 — main provisioning skeleton (без UI)

4) `ClaudeBinaryResolver` (без `shell: true`).
5) `TeamProvisioningService`:
   - lock по `teamName`
   - state machine
   - spawn contract (`stdio` + stderr drain + timeout)
   - monitoring/verifying по `config.json`
6) IPC handlers `team:create`, `team:provisioningStatus`, progress event.
7) `pnpm test` + `pnpm typecheck`

### CP2 — preload bridge + renderer store

8) `TeamsAPI` расширение + preload bridge.
9) `teamSlice` actions + подписка на progress event.
10) `pnpm typecheck`

### CP3 — UI dialog

11) `CreateTeamDialog` + интеграция в `TeamListView`.
12) Ручная проверка (см. ниже).
13) `pnpm test` + `pnpm typecheck`

---

## Manual regression checklist (обязательно)

1) Local mode: Create Team → прогресс до `ready`, команда появляется в списке.
2) Ошибка “CLI не найден” на macOS Finder-запуске воспроизводится → UI показывает понятное сообщение.
3) Cancel во время `spawning/monitoring`:
   - UI показывает `cancelled`
   - процесс не остаётся “висячим”
4) Повторный create с тем же `teamName`, когда команда уже существует → понятная ошибка без перезаписи.
5) После `ready` можно открыть Team tab и увидеть данные (пусть даже roster заполнится постепенно).

---

## Appendix A — One-shot prompt template (одноходовый bootstrap)

Ниже шаблон prompt, который должен отработать в одном turn в режиме `-p`.

**Переменные (подставляет приложение):**
- `{teamName}` — directory name
- `{displayName}` — UI name
- `{description}` — описание (может быть пустым)
- `{members}` — список участников (строки), где каждый элемент:
  - `name` (валидирован)
  - `role` (опционально)

**Шаблон:**

```
You are running in a non-interactive CLI session. Do not ask questions. Do everything in a single turn.

Goal: Provision a Claude Code agent team.

Constraints:
- Use ONLY these tools: TeamCreate, SendMessage, TaskCreate.
- Do not use Read/Edit/Bash.
- Do not output large logs. Keep assistant text minimal.

Steps (must be executed in this order):
1) Call TeamCreate to create team "{teamName}" with:
   - display name: "{displayName}"
   - description: "{description}"
   - members: the list below (include roles if present)

2) For each member in the list, call SendMessage to send a short bootstrap DM:
   - summary: "Bootstrap"
   - text: "Team \"{displayName}\" is ready. Reply with 'OK' when you are available."

3) (Best-effort) Create 1 initial task via TaskCreate:
   - subject: "Bootstrap check"
   - description: "Confirm team provisioning succeeded. Each member replied OK."
   - owner: leave empty (unassigned)

Members:
{members}
```

Примечания:
- Bootstrap DM нужен, чтобы с высокой вероятностью создались `inboxes/{member}.json`.
- TaskCreate — best-effort; отсутствие задач НЕ блокирует `ready`.

