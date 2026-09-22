# Research: Inbox-файлы Claude Code

## Формат

**Путь**: `~/.claude/teams/{teamName}/inboxes/{memberName}.json`

**Структура**: JSON-массив объектов (весь файл = массив)

```json
[
  {
    "from": "contracts-cleaner",
    "text": "Готово. Вот что было удалено из packages/core/...",
    "timestamp": "2026-02-09T17:12:32.316Z",
    "color": "blue",
    "read": true,
    "summary": "Cleanup complete"
  },
  {
    "from": "team-lead",
    "text": "{\"type\":\"shutdown_request\",\"from\":\"team-lead\",\"timestamp\":\"...\"}",
    "timestamp": "2026-02-09T17:25:43.886Z",
    "read": true
  }
]
```

### Поля

| Поле | Обязательно | Тип | Описание |
|------|:-----------:|-----|----------|
| `from` | YES | string | Имя отправителя (зарегистрированный agent) |
| `text` | YES | string | Текст сообщения или JSON-строка |
| `timestamp` | YES | string | ISO 8601 |
| `read` | YES | boolean | Прочитано ли Claude Code |
| `summary` | NO | string | Краткое описание для UI |
| `color` | NO | string | Цвет агента (blue, green, red, yellow, purple, cyan, orange, pink) |

### text: plain vs structured

`text` может быть:
- **Plain text**: обычное сообщение
- **JSON-строка**: структурированное сообщение (парсится из text)

Типы структурированных:
```
idle_notification  — агент ушёл в idle (idleReason: "available")
shutdown_request   — запрос на завершение работы
shutdown_approved  — подтверждение завершения
message           — обычное DM (content, summary)
task_completed    — задача завершена (taskId)
```

### read поведение

- Claude Code ставит `read: true` после обработки
- Сообщения НЕ УДАЛЯЮТСЯ — остаются навечно
- Нет автоматической чистки inbox
- 106 сообщений = ~256 KB

---

## Race Condition (КРИТИЧНЫЙ РИСК)

### Сценарий

```
T=0ms: App читает inbox [msg1, msg2]
T=1ms: Claude Code читает inbox [msg1, msg2]
T=5ms: App пишет [msg1, msg2, msg3_app]
T=6ms: Claude Code пишет [msg1, msg2, msg3_agent]
→ msg3_app ПОТЕРЯНО
```

### Почему происходит

Inbox — JSON-массив. Append = read whole array → add element → write whole file. Два процесса читают одну версию, каждый добавляет своё, последний перезаписывает первого.

### Вероятность

**НИЗКАЯ** — записи в inbox происходят нечасто:
- Юзер шлёт 1-2 сообщения в минуту
- Агенты шлют idle_notification раз в 5-30 секунд
- Коллизия = оба пишут в ОДИН файл в пределах ~10ms

### Митигация

1. **Atomic write** (предотвращает partial writes):
```typescript
const tmpPath = targetPath + '.tmp.' + process.pid;
fs.writeFileSync(tmpPath, JSON.stringify(messages, null, 2));
fs.renameSync(tmpPath, targetPath); // atomic на macOS/Linux
```

2. **Retry с проверкой** (обнаруживает потерю):
```typescript
// После записи — перечитать и проверить
const written = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
const found = written.some(m => m.messageId === ourMessageId);
if (!found) {
  // Наше сообщение потеряно — retry
  await appendToInbox(inboxPath, message);
}
```

3. **Уникальный messageId**: добавлять `messageId: uuid()` в наши сообщения

4. **Debounce**: не писать чаще раз в 500ms

### Что НЕ решает

Atomic write предотвращает corrupted JSON, но НЕ предотвращает overwrite race. Retry с проверкой — best effort, но не 100%.

---

## Доставка сообщений

### Между turns, НЕ real-time

```
Цикл тиммейта:
1. Читает inbox (видит новые сообщения с read: false)
2. Обрабатывает
3. Вызывает инструменты (Bash, Edit, Read...)
4. Turn заканчивается → шлёт idle_notification → IDLE
5. Ждёт...
6. Новый turn → читает inbox
```

**Задержка**: 1-30 секунд (зависит от длительности turn)

### Нельзя прервать mid-turn

Если агент уже вызвал Edit/Bash — инструмент будет выполнен. Сообщение "стоп, не трогай файл X" придёт ПОСЛЕ.

### Idle → Active

Сообщение idle-агенту пробуждает его при следующем цикле проверки inbox.

### Hard Interrupt (будущее)

Возможные подходы:
- `kill -SIGINT` процесса (жёсткое)
- Файловый flag `.interrupt-{member}`
- Ждать API от Anthropic

---

## from: "user" — подтверждено работает (2026-03-23)

Эмпирически подтверждено: `from: "user"` корректно доставляется тиммейтам. Тиммейт получает сообщение, определяет что оно от юзера, и отвечает в `inboxes/user.json`. Fallback на `from: "team-lead"` не нужен.

Ранее были опасения что Claude Code валидирует `from` по `config.json` members — это не так.

---

## Размер и масштабирование

| Метрика | Значение |
|---------|----------|
| Размер сообщения | ~2.4 KB |
| 100 сообщений | ~240 KB |
| 1000 сообщений | ~2.4 MB |
| Парсинг 1000 сообщений | <10ms |
| Реальный inbox (106 msgs) | 256 KB |

Проблема начнётся при 10000+ сообщений — JSON.parse будет заметно медленнее. Для долгоживущих команд нужна архивация.

---

## Финальное решение (после 3 раундов ревью)

### Подход: Atomic write + messageId verify

Выбрана комбинация atomic write с постфактум-верификацией через `messageId`:

```typescript
// 1. Генерируем уникальный ID для нашего сообщения
const messageId = crypto.randomUUID();
const message: InboxMessage = {
  from: 'user',
  text,
  timestamp: new Date().toISOString(),
  read: false,
  summary,
  messageId,
};

// 2. Читаем текущий inbox
const existing = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));

// 3. Добавляем сообщение
const updated = [...existing, message];

// 4. Atomic write (tmp + rename)
const tmpPath = inboxPath + '.tmp.' + process.pid;
fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2));
fs.renameSync(tmpPath, inboxPath);

// 5. Verify: перечитываем и проверяем messageId
const written = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
const found = written.some((m: InboxMessage) => m.messageId === messageId);
if (!found) {
  // Потеря обнаружена — показать warning в UI, не silent fail
  throw new Error(`Message ${messageId} lost during write`);
}
```

### Решения по итогам ревью

- **Полный CAS не нужен на MVP**: verify при следующем read достаточен для обнаружения потерь
- **messageId проверяется сразу после записи** (а не только при следующем read)
- **Не silent fail**: если сообщение потеряно — UI показывает предупреждение пользователю
- **Retry не автоматический**: потеря крайне редка, ручная отправка достаточна на MVP

### Риски

| Риск | Вероятность | Митигация |
|------|-------------|-----------|
| Race condition: агент пишет одновременно | Низкая | Atomic write + verify |
| Потеря при race | Очень низкая | messageId verify → warning в UI |
| Corrupted JSON | Практически 0 | Atomic write (tmp + rename) |

### Что не входит в MVP

- Автоматический retry при потере (добавить в Phase 2 при необходимости)
- Debounce записи (не нужен при редкой записи)
- Полный CAS с блокировкой (избыточно для данной частоты записей)
