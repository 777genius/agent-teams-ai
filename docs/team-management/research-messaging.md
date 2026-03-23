# Research: Подходы к отправке сообщений тиммейтам

## Сравнение 3 подходов

| Критерий | Inbox-файлы | Agent SDK | CLI subprocess |
|----------|:-----------:|:---------:|:--------------:|
| Скорость | ~5ms | ~12с | 10-15с |
| Стоимость | $0 | $0.01-0.08/msg | токены |
| Работает с запущенными | **YES** | NO | NO |
| Прерывает mid-turn | NO | NO | NO |
| Требует API ключ | NO | YES | NO |
| Расход памяти | 0 | 0 | 100-320MB |

---

## 1. Inbox-файлы (ВЫБРАНО)

### Как работает

Прямая запись JSON в файл `~/.claude/teams/{team}/inboxes/{member}.json`. Claude Code мониторит эти файлы через fs.watch и доставляет сообщения агентам между turns.

### Плюсы

- **Мгновенная запись** (~5ms)
- **$0** — никаких API вызовов
- **Единственный** способ общаться с запущенными тиммейтами
- Работает с idle и active агентами (но доставка между turns)

### Минусы

- Race condition при одновременной записи (см. [research-inbox.md](./research-inbox.md))
- Формат недокументирован (internal API)
- Доставка между turns, не real-time

### Формат сообщения

```json
{
  "from": "user",
  "text": "Не трогай файл auth.ts, я его сам изменю",
  "timestamp": "2026-02-17T15:30:00.000Z",
  "read": false,
  "summary": "Do not modify auth.ts",
  "messageId": "uuid-for-retry-check"
}
```

---

## 2. Agent SDK (ОТВЕРГНУТ)

### Как работает

```typescript
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic();
const response = await client.messages.create({
  model: 'claude-opus-4-6',
  messages: [{ role: 'user', content: 'Send message to teammate...' }],
  tools: [/* SendMessage, TaskUpdate, etc. */]
});
```

### Почему отвергнут

1. **Создаёт НОВУЮ сессию** — не подключается к работающему тиммейту. SendMessage и TaskCreate — это инструменты модели, не программные вызовы
2. **~12 секунд** на каждый вызов (полный API round-trip)
3. **Стоит токены** — $0.01-0.08 за сообщение
4. **Нужен API ключ** — отдельная оплата, а не подписка Claude

### Когда может пригодиться

- Создание новых команд программно
- Автоматизация workflow (вне real-time UI)

---

## 3. CLI subprocess (ОТВЕРГНУТ)

### Как работает

```bash
claude --message "Send message to teammate-1: stop working on X"
```

### Почему отвергнут

1. **Новый процесс** — не инжектится в работающего тиммейта
2. **10-15 секунд** холодный старт
3. **100-320MB памяти** на процесс
4. Каждый вызов стоит токены

---

## Архитектура доставки (обновлено 2026-03-23)

### Два разных механизма: лид vs тиммейты

**Лид** читает ТОЛЬКО stdin (stream-json). Для доставки сообщений лиду используется `relayLeadInboxMessages()` — конвертирует inbox-записи в stream-json на stdin. Без relay лид не видит inbox.

**Тиммейты** — полноценные независимые Claude Code процессы. Каждый мониторит свой inbox файл через fs.watch и читает сообщения напрямую. Relay через лида НЕ нужен.

### Поток сообщений: Юзер → Тиммейт

```
User → [UI] → TeamInboxWriter → inboxes/{member}.json (read: false)
                                        ↓
                              Teammate CLI (fs.watch) → читает → обрабатывает
                                        ↓
                              Teammate → inboxes/user.json (ответ)
                                        ↓
                              [UI] ← TeamInboxReader ← читает user.json
```

Лид в этой цепочке НЕ участвует. Сообщение доставляется напрямую.

### Поток сообщений: Юзер → Лид

```
User → [UI] → stdin (stream-json) → Lead CLI
                                        ↓
Lead → sentMessages.json / liveLeadProcessMessages
                                        ↓
                              [UI] ← читает и отображает
```

Для лида дополнительно работает `relayLeadInboxMessages()` при изменении `inboxes/{lead}.json`.

### Ответы тиммейтов

Тиммейт отвечает юзеру через `SendMessage(to="user")`, что записывается в `inboxes/user.json`. UI читает этот файл через `TeamInboxReader.getMessages()` (читает ВСЕ inbox файлы в директории).

Сообщения в `user.json` могут не содержать `messageId` — `TeamInboxReader` генерирует детерминированный ID из sha256(from + timestamp + text).

### from: "user" — подтверждено работает

`from: "user"` работает корректно (подтверждено эмпирически 2026-03-23):
- Тиммейт получает сообщение
- Тиммейт корректно определяет что это от юзера
- Тиммейт отвечает в `inboxes/user.json`
- Fallback на `from: "team-lead"` не нужен

### Почему relay через лида был ОТКЛЮЧЁН (2026-03-23)

Ранее при отправке DM тиммейту, помимо записи в inbox, вызывался `relayMemberInboxMessages()` — инструкция лиду переслать сообщение через `SendMessage(to=member)`. Это вызывало 3 бага:

1. **Лид отвечал вместо тиммейта** — LLM интерпретировал relay-инструкцию как обращение к себе и отвечал юзеру напрямую
2. **Дубликаты сообщений** — `markInboxMessagesRead()` записывал в файл → FileWatcher срабатывал → relay запускался повторно → цикл
3. **Тиммейт не отвечал юзеру** — relay-промпт содержал "Do NOT send to user", что тиммейт тоже видел через лида

Relay отключён в `teams.ts` (handleSendMessage) и `index.ts` (FileWatcher). Код закомментирован, не удалён. Relay для лида (`relayLeadInboxMessages`) не затронут.

---

## Доставка: Timing и ограничения

### Цикл тиммейта

```
Turn N:
  1. Читает inbox → видит новые (read: false)
  2. Обрабатывает сообщения/задачи
  3. Вызывает инструменты
  4. Reasoning
  5. Output
  → idle_notification → IDLE

... ожидание ...

Turn N+1:
  1. Пробуждение (новое сообщение в inbox / назначение задачи)
  2. Читает inbox → видит новые
  ...
```

### Задержка

- **Idle agent**: получит при следующем пробуждении (доли секунды если inbox-change triggers)
- **Active agent (mid-turn)**: получит только после завершения текущего turn (1-30 секунд)

### Нельзя прервать

Если агент уже вызвал Edit/Bash — инструмент выполнится. Наше сообщение придёт ПОСЛЕ.

**Пример**:
```
17:12:30 — Agent начинает Edit на auth.ts
17:12:31 — Мы шлём "Не трогай auth.ts"
17:12:32 — Agent завершает Edit (auth.ts изменён)
17:12:33 — Agent читает inbox, видит наше сообщение
→ Поздно, файл уже изменён
```

### Hard Interrupt (будущее)

Возможные подходы:
1. **kill -SIGINT** процесса тиммейта (жёсткое прерывание, потеря контекста)
2. **Файловый flag** `.interrupt-{member}` (нужна поддержка в Claude Code)
3. **API от Anthropic** (если появится)

Текущее решение: задержка приемлема, hard interrupt — в будущем.

---

## Финальное решение

### messageId — обязателен в каждом исходящем сообщении

Каждое исходящее сообщение включает `messageId: crypto.randomUUID()`:

```json
{
  "from": "user",
  "text": "Please review task #12",
  "timestamp": "2026-02-17T15:30:00.000Z",
  "read": false,
  "summary": "Review request for task #12",
  "messageId": "550e8400-e29b-41d4-a716-446655440000"
}
```

### Verify: проверка сразу после записи

- После atomic write читаем inbox и ищем наш `messageId`
- Если не найден — потеря обнаружена → warning в UI (не silent fail)
- Не автоматический retry на MVP

### 3 состояния offline-участника

| Состояние | Условие | Отображение |
|-----------|---------|-------------|
| `ACTIVE` | idle < 5 минут | Зелёный dot |
| `IDLE` | idle > 5 минут | Жёлтый dot |
| `TERMINATED` | Получен `shutdown_response` с `approve: true` | Серый dot, "Завершён" |

Определение состояния по timestamp последнего события в inbox (idle_notification, любое сообщение). TERMINATED — исключительно по явному `shutdown_response`.
