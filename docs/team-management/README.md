# Team Management Feature

Интерфейс для управления командами AI-тиммейтов внутри Agent Teams (Electron), включая Claude, Codex и OpenCode runtime paths.

## Что делает

- Видеть состав команды и роли участников
- Kanban-доска с 5 колонками: TODO, IN PROGRESS, REVIEW, DONE, APPROVED
- Отправка сообщений тиммейтам через inbox-файлы и runtime-aware delivery для OpenCode
- Review flow: запрос ревью, ручное ревью и прямое manual approval из DONE
- Live updates через file watcher

## Документация

| Файл                                                                         | Содержание                                                                                           |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [research-inbox.md](./research-inbox.md)                                     | Формат inbox-файлов, race conditions, atomic write, доставка сообщений                               |
| [research-tasks.md](./research-tasks.md)                                     | Формат task-файлов, .lock, .highwatermark, конкурентный доступ                                       |
| [research-messaging.md](./research-messaging.md)                             | Сравнение подходов (inbox vs SDK vs CLI), почему выбрали inbox                                       |
| [kanban-design.md](./kanban-design.md)                                       | Kanban flow, колонки, review mechanism, kanban-state.json                                            |
| [implementation.md](./implementation.md)                                     | Техплан: файлы, шаги, verification                                                                   |
| [openclaw-agent-teams-integration.md](./openclaw-agent-teams-integration.md) | How to connect OpenClaw or another outside AI through Agent Teams MCP and REST control API           |
| [research-worktrees.md](./research-worktrees.md)                             | Git worktrees + teams, запуск Claude процессов из UI (Phase 2)                                       |
| [task-queue-derived-agenda-plan.md](./task-queue-derived-agenda-plan.md)     | Подробный rollout-plan по разделению queue/inventory, derived actionOwner и phased agenda/delta sync |
| [debugging-agent-teams.md](./debugging-agent-teams.md)                       | Runtime debugging runbook, включая `CLAUDE_TEAM_TEAMMATE_MODE=tmux` для pane-backed teammate debug   |

## Ключевые решения

⚠️ `docs/iterations/*` - это исторические planning notes. Они полезны для контекста, но не являются source-of-truth для текущего поведения продукта. Актуальный контракт review flow описан в этом файле и в [kanban-design.md](./kanban-design.md).

⚠️ `agent-attachments-*.md` (architecture plan + phase 1-5 plans) - это исторические дизайн-документы для feature attachments. Фактическая реализация в `src/features/agent-attachments/` может отличаться от описанной архитектуры. Для актуального состояния см. код в `src/features/agent-attachments/core/domain/` и тесты.

### 1. Messaging: inbox + runtime delivery

Для native Claude/Codex-style тиммейтов основной путь - durable inbox-файлы. Lead inbox доставляется через `relayLeadInboxMessages()`, потому что lead читает stdin. OpenCode secondary lanes не читают `inboxes/{member}.json` напрямую, поэтому UI сначала сохраняет сообщение в inbox, затем доставляет его через runtime bridge с delivery proof. Подробности: [research-messaging.md](./research-messaging.md) и [debugging-agent-teams.md](./debugging-agent-teams.md)

### 1.1 Roster source: members.meta.json + inboxes

- `config.json` не используется как полный реестр участников (он может содержать только team-lead и служебные поля CLI).
- Источник метаданных участников (role/color/agentType): `members.meta.json`.
- Источник runtime-состава и адресации сообщений: `inboxes/{member}.json`.

### 2. Kanban Storage: Собственный файл

Kanban-позиция (REVIEW, APPROVED) хранится в `kanban-state.json`, а не в task metadata. Причина: metadata может быть перезаписан агентом при TaskUpdate. Подробности: [kanban-design.md](./kanban-design.md)

### 3. Review Flow: Approve / Request Changes

- Есть ревьюверы в команде → автоматическое назначение через inbox
- Юзер также может вручную одобрить задачу напрямую из `DONE` без отдельного захода в `REVIEW`
- Нет ревьюверов → ручное ревью юзером (Approve / Request Changes в UI)
- При Request Changes → юзер описывает проблему (опционально) → задача возвращается owner'у в `pending` с `needsFix`

### 4. Atomic Write

Все записи через tmp + rename для предотвращения corrupted JSON.

### 5. Sender Identity

Отправляем `from: "user"`. Fallback на `from: "team-lead"` если не работает.

## Финальные решения после ревью

По итогам 3 раундов ревью (13 экспертов) приняты следующие решения:

### Inbox: Atomic write + messageId verify

- Atomic write (tmp + rename) предотвращает corrupted JSON
- После записи читаем файл обратно и проверяем наличие нашего `messageId`
- Полный CAS/retry-цикл — не нужен на MVP: проверка при следующем read достаточна
- Риск race condition с агентом реален, но вероятность низкая

### Kanban: kanban-state.json с безопасным GC

- GC устаревших записей kanban-state выполняется ТОЛЬКО ПОСЛЕ полной загрузки tasks
- Иначе при startup возможна race condition: GC удаляет запись до того как task-файл прочитан

### Review Flow: Approve / Request Changes

- Кнопки переименованы: **Approve** (вместо OK) и **Request Changes** (вместо Error)
- Комментарий при Request Changes — опционален
- Manual UI допускает два valid path:
  - `DONE -> REVIEW -> APPROVED`
  - `DONE -> APPROVED` как быстрый manual approval
- `Request Changes` снимает kanban-state запись и возвращает задачу в `pending` с `needsFix`
- `reviewHistory` и round-robin балансировка → Phase 2, не MVP

### Members: полный список через union

- `union(members.meta.json + config members + inbox filenames + task owners)` - единственный способ получить полный список
- `owner` в task-файлах — опционален (агент может не иметь owner до назначения)

### Graceful Degradation

- `try/catch` везде в TeamDataService — при ошибке чтения возвращаем безопасные дефолты
- 3 состояния участника: `ACTIVE` / `IDLE` / `TERMINATED`
  - `ACTIVE`: idle < 5 минут
  - `IDLE`: idle > 5 минут
  - `TERMINATED`: получен `shutdown_response` с `approve: true`

### @dnd-kit and review transitions

- Переходы между review-колонками делаются через card actions в UI
- `@dnd-kit` сейчас используется в первую очередь для перестановки задач внутри колонки
- Phase 2: полноценный D&D через `@dnd-kit`

---

## Открытые вопросы

- **FileWatcher расширение**: FileWatcher.ts уже 1243 строк — добавление teams/tasks watchers нетривиально, требует отдельного спайка
- **Windows atomic rename**: `fs.renameSync` на Windows бросает `EXDEV`/`EBUSY` при кросс-устройственном rename — нужна обёртка
- **leadSessionId интеграция**: config.json содержит `leadSessionId`, но интеграция с session viewer (переход к сессии лида) — открытый вопрос
- **Hard Interrupt**: сообщения доставляются между turns (1-30с задержка). В будущем нужен способ прервать mid-turn
- **Архивация**: inbox не чистится автоматически, нужна кнопка "Архивировать"

## Файловая структура Claude Code

```
~/.claude/
├── teams/{teamName}/
│   ├── config.json              # Конфиг команды (lead + служебные поля)
│   ├── members.meta.json        # Роли/цвета/типы участников (teammates)
│   └── inboxes/{memberName}.json  # Inbox каждого участника
└── tasks/{teamName}/
    ├── {id}.json                # Файл задачи
    ├── .lock                    # Lock-файл (0 байт)
    └── .highwatermark           # Последний ID задачи
```

**ВАЖНО**:

- `config.json` не является source-of-truth для полного roster.
- Полный roster для UI формируется как `members.meta.json + inbox filenames (+ lead из config)`.
