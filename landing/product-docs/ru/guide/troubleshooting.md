---
title: Диагностика – Документация Agent Teams
description: Решение проблем с запуском команд, отсутствующими ответами агентов, rate limits, CLI auth и lane bootstrap stalls через локальные диагностики.
lang: ru-RU
---

# Диагностика

Большинство проблем команды попадает в четыре группы: runtime setup, launch confirmation, task parsing и provider limits.

## Команда не запускается

Проверьте последовательно:

1. **Runtime установлен** — выбранный CLI (`claude`, `codex`, `opencode`) установлен
2. **Доступен в PATH** — бинарник доступен в переменной окружения `PATH`
3. **Доступ к модели** — у провайдера есть доступ к запрошенной модели (особенно для OpenCode, важны точные имена провайдера и модели)
4. **Путь к проекту** — директория проекта существует и доступна для чтения
5. **Сеть / VPN** — некоторые провайдеры блокируют трафик при активном VPN

::: tip
Запустите бинарник рантайма в терминале, чтобы проверить PATH и авторизацию. Например: `claude --version` или `opencode --version`.
:::

### OpenCode: registered, но bootstrap не подтверждён

Если OpenCode показывает `registered`, но bootstrap не подтверждён, сначала inspect artifacts, прежде чем менять team prompts.

Contributor/debugging details находятся в [Архитектуре для контрибьюторов](/ru/reference/contributor-architecture), где есть ссылка на canonical debugging runbook для agent teams.

Посмотрите на последний artifact неудачного запуска:

```bash
~/.claude/teams/<team>/launch-failure-artifacts/latest.json
```

Манифест внутри включает:

- `classification` — почему запуск считался неудачным
- `bootstrapTransportBreadcrumb` — использованный путь доставки
- Статусы старта участников
- Редактированные логи и трейсы

Также проверьте lane manifest:

```bash
jq '.lanes' ~/.claude/teams/<team>/.opencode-runtime/lanes.json
jq '.activeRunId, .entries' ~/.claude/teams/<team>/.opencode-runtime/lanes/<lane>/manifest.json
```

::: tip Не гадайте по UI
Всегда сопоставляйте UI-диагностику с сохранёнными файлами (`launch-state.json`, `bootstrap-journal.jsonl`) и runtime-специфичными доказательствами.
:::

## Общая диагностика

Начинайте с сохранённых файлов на диске, а не только с UI.

### Корневая директория команды

```bash
~/.claude/teams/<team>/
```

Ключевые файлы и что они показывают:

- `launch-state.json` — состояние запуска/активности участников (`.teamLaunchState`, `.summary`, `.members`)
- `bootstrap-journal.jsonl` — упорядоченные события bootstrap от CLI/runtime (`tail -80`)
- `bootstrap-state.json` — сводка фазы bootstrap
- `config.json` — конфигурация провайдера, модели и проекта
- `inboxes/*.json` и `sentMessages.json` — состояние доставки сообщений

```bash
jq '.teamLaunchState, .summary, .members' ~/.claude/teams/<team>/launch-state.json
tail -80 ~/.claude/teams/<team>/bootstrap-journal.jsonl 2>/dev/null
```

### OpenCode runtime evidence

Для OpenCode участников доказательство сессии находится в lane runtime store:

- `.opencode-runtime/lanes.json` — индекс lane с состоянием
- `.opencode-runtime/lanes/<lane>/manifest.json` — `activeRunId` и записи evidence
- `.opencode-runtime/lanes/<lane>/opencode-sessions.json` — зафиксированные записи сессий

Ожидаемое здоровое состояние: состояние lane `active`, manifest содержит `activeRunId` хотя бы с одной записью evidence, участник имеет `bootstrapConfirmed: true`.

```bash
jq '.lanes' ~/.claude/teams/<team>/.opencode-runtime/lanes.json 2>/dev/null
find ~/.claude/teams/<team>/.opencode-runtime -maxdepth 3 -type f | sort
```

### Артефакты неудачного запуска

Когда запуск помечен как неудачный, проверьте `latest.json`:

```bash
~/.claude/teams/<team>/launch-failure-artifacts/latest.json
```

Манифест включает:
- `classification` — почему запуск считался неудачным
- `bootstrapTransportBreadcrumb` — использованный путь доставки
- Статусы старта участников и редактированные логи/трейсы

## Не видны ответы агента

Откройте task logs и teammate messages. Пропавшие replies часто связаны с:

- **Runtime delivery retry** — агент мог ответить, но сообщение не доставлено в приложение. Проверьте delivery ledger.
- **Parsing или filtering** — вывод агента не содержал ожидаемых маркеров или task references.
- **Task attribution** — работа выполнялась в рамках сессии, но не была привязана к задаче, потому что в выводе отсутствовал корректный task id.

::: warning Не считайте молчание игнорированием
Не считайте, что модель проигнорировала сообщение, пока это не подтверждено логами.
:::

## Changes не связаны с tasks

Используйте task-specific logs и code review links. Если diff выглядит detached:

- Проверьте, был ли task id или task reference в output агента.
- Убедитесь, что агент вызвал `task_add_comment` перед правками.
- Убедитесь, что агент вызвал `task_start`, чтобы доска знала о начале работы.

Для OpenCode teammates авторитетным доказательством принадлежности сессии к задаче служат `opencode-sessions.json` и запись в lane manifest, а не только UI message stream.

## Rate limits

Если провайдер сообщает известное время сброса (reset time), Agent Teams может подтолкнуть lead продолжить после cooldown. Если reset time неизвестен, подождите или смените provider/runtime path.

| Поведение провайдера | Рекомендуемое действие |
| --- | --- |
| Отображается известное reset time | Дождитесь cooldown и продолжите |
| Reset time не показан | Смените провайдера или runtime path |
| Повторяющиеся 429 | Снизьте concurrency или используйте другую model lane |

## Проблемы авторизации CLI

### `claude login` не сохраняется

Если CLI авторизован в одном терминале, но приложение говорит, что нет — проверьте, что auth сохранён по ожидаемому пути конфигурации, и что процесс приложения видит тот же `$HOME`.

### OpenCode: ключ провайдера отклонён

- Убедитесь, что имя провайдера в `config.json` совпадает с префиксом провайдера в строке модели
- Проверьте, что ключ не просрочен и не отозван в dashboard провайдера

### Диагностический лог авторизации

Каждый вызов `CliInstallerService.getStatus()` дописывает одну строку в `claude-cli-auth-diag.ndjson` в папке логов Electron (обычно `~/Library/Logs/<product-name>/` на macOS). Если файл превышает **512 KiB**, он обнуляется перед следующей записью.

Проверьте этот файл, если видите «Not logged in» или ошибки авторизации в упакованном приложении.

## Lane bootstrap stuck

Для OpenCode secondary lanes:

- Отсутствие `inboxes/<member>.json` автоматически не является багом. OpenCode lanes не обязаны быть созданы через primary inbox перед стартом.
- Если UI показывает, что команда всё ещё запускается, в то время как primary participants уже работоспособны, ожидание «all teammates joined» связано с secondary lanes.
- Если зависает `Prepared communication channels for X/Y members`, проверьте, не включает ли `Y` некорректно secondary OpenCode members.

### Lane manifest empty entries

Если bridge сообщает, что bootstrap успешен, но `manifest.json` показывает `entries: []`, проблема в **evidence commit**, а не в поведении модели. Участник не должен считаться deliverable, пока `opencode-sessions.json` и запись в manifest не существуют.

## Распространённые состояния member

| Состояние | Значение |
|-----------|---------|
| `confirmed_alive` + `bootstrapConfirmed` | Здоров и готов к работе |
| `registered` / `runtime_pending_bootstrap` | Процесс или lane существует, но bootstrap proof ещё не закоммичен |
| `failed_to_start` + `runtime_process` | Процесс есть, но launch gate не прошёл. Смотрите diagnostics |
| `failed_to_start` + `stale_metadata` | Сохранённый pid/session устарел или мёртв |

::: warning
`member_briefing` сам по себе НЕ является runtime evidence. Для OpenCode авторитетным доказательством служит committed runtime evidence, такая как `opencode-sessions.json` и запись в manifest.
:::

## Режим отладки рантайма

Для локальной отладки можно принудительно запускать teammates в tmux-панелях:

```bash
# Запуск из терминала
CLAUDE_TEAM_TEAMMATE_MODE=tmux pnpm dev

# Или добавьте в custom CLI args
--teammate-mode tmux
```

Используйте это для инспекции интерактивного поведения CLI. Не считайте поведение полностью эквивалентным process backend.

## Безопасная очистка

При очистке stale processes:

1. Определите pid и убедитесь, что он принадлежит текущей команде / lane.
2. Останавливайте только процессы, явно принадлежащие smoke test или отлаживаемому launch.
3. **Не убивайте** все процессы OpenCode или shared hosts в качестве shortcut.

## Какие данные собрать

Соберите:

- task id (short или full)
- team name
- runtime path (`claude`, `codex`, или `opencode`)
- launch log excerpt (из `latest.json` или `bootstrap-journal.jsonl`)
- provider / model
- точный time window

Этого обычно хватает для диагностики launch и task lifecycle issues.

::: tip
Если проблема не устраняется, откройте persisted files команды под `~/.claude/teams/<teamName>/` и сопоставьте UI diagnostics с live process state, прежде чем менять код.
:::
