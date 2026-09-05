# Workspace trust: Claude Code + Codex, общий UI без ложного статуса

Статус: реализовано и проверено локально на frontend base
`81fda38cf8525f71081e39363244d4bf83f850f9`; изменения еще не закоммичены и не
отправлены в PR.
Дата проверки исходников: 2026-09-04.

## 1. Цель и границы

Добавить Codex рядом с Claude Code в уже существующую компактную подсказку перед
Create/Launch. Один контракт, один hook, одна политика отображения, один компонент.
Различаться должны только источники фактов о доверии, а не две копии всего flow.

Показывать желтую карточку `First launch` только для доказанного Claude
`untrusted`. Для `trusted`, `checking`, `unknown`, Codex `launch_scoped` и
неподдерживаемых провайдеров не показывать нейтральный текст, подтверждение или
спиннер. Карточка не заменяет readiness, sandbox, permissions или provider preflight.

В scope: Claude/Anthropic, Codex, Create и Launch, IPC и тонкая HTTP-проекция той же
операции, обратная совместимость, регрессионные и визуальные проверки.

Вне scope: OpenCode/Gemini, авторизация, каталог моделей, смена approval policy,
изменение trust-настроек пользователя, новая база согласий, новый provider preflight,
переписывание provisioning, release/merge и исправление всего старого trust-плана.

### Продуктовое ограничение, которое нельзя спрятать

Для Claude можно скрыть подсказку по реально сохраненному доверию. Для Codex в
текущем командном runtime доверие обычно задается только на отдельный запуск.
Поэтому `launch_scoped` нельзя выдавать за первый запуск или persisted trust.
Минимальная реализация скрывает этот статус и не показывает повторяющуюся
информационную строку.

Если обязательное условие - скрывать ее после первого Codex-запуска даже после
перезапуска приложения, нужен отдельный согласованный продуктовый шаг: хранение
приложением факта ознакомления. Это не равно доверию Codex и не должно разрешать
операции. Не подменять этот шаг флагом `trusted` или неявным localStorage.

## 2. Проверенное текущее устройство

План составлен по рабочему дереву frontend
`/Users/belief/dev/projects/claude/_worktrees/agent-teams-provider-recovery`,
base `11c12ae87d038560a58cff4768e5b8d3f0ec61cb`, с незакоммиченными исправлениями.
Runtime: `/Users/belief/dev/projects/claude/agent_teams_orchestrator`,
base `12d840a0f5a924d640faaa7f1843e611409cb7e9`, также с локальными исправлениями.
Эти SHA обозначают базу исследования, а не exact-head доказательство будущего PR.

- `useWorkspaceTrustStatus` сейчас принимает только `enabled` и `projectPath`.
  Оба диалога включают его только при выбранном Anthropic runtime.
- `WorkspaceTrustStatusReader` канонизирует рабочую папку и вызывает
  `FileClaudeStateProbe`. Последний читает сохраненное `hasTrustDialogAccepted`.
- Только `untrusted` показывает first-launch warning; `trusted`, `checking`,
  `unknown`, `launch_scoped`, `disabled` и `not_applicable` ничего не показывают.
- `WorkspaceTrustCoordinator` уже формирует Codex trust-overrides для запуска.
  Они передаются через settings оркестратора, не через запуск UI-проверки.
- В runtime `appServerRunner.ts` намеренно исключает `config.toml` из временного
  CODEX_HOME. Это закреплено тестом `appServerRunner.test.ts`.
- `turnExecutor.ts` включает `ignoreUserConfig` для exec по умолчанию; strict MCP
  включает его принудительно. Специальная env-настройка может изменить exec-режим,
  но не превращает глобальный TOML в общий источник истины для обоих транспортов.
- И manual app-server, и auto exec получают одинаковый набор launch trust-overrides
  из `workspaceTrustConfigOverrides.ts` через `turnExecutor.ts`.
- Текущий `codexBackendResolver` нормализует backend в `codex-native`. Важная
  развилка для этой задачи - transport/config policy, а не OAuth против native.
- HTTP-реализации текущего workspace-trust status API нет. Добавляя контракт,
  необходимо явно обеспечить parity, как требует feature architecture standard.

## 3. Варианты решения

Оценки LOC относятся только к этому приращению, вместе с тестами и wiring,
без уже существующего большого dirty diff. Это ориентиры, не обязательные квоты.

| Вариант         | Суть                                                                                | Оценка                    | Примерный changed LOC |
| --------------- | ----------------------------------------------------------------------------------- | ------------------------- | --------------------- |
| A, рекомендован | Общий read-model, Claude persisted + Codex launch-scoped; без записи согласий       | 🎯 9/10, 🛡️ 9/10, 🧠 3/10 | 500-850               |
| B               | Тот же read-model + app-owned ознакомление, чтобы не повторять строку Codex         | 🎯 7/10, 🛡️ 8/10, 🧠 6/10 | 900-1500              |
| C               | Менять runtime config layering и вводить реально потребляемое persisted Codex trust | 🎯 5/10, 🛡️ 6/10, 🧠 8/10 | 1200-2200+            |

Выбор для bounded реализации: A. B требует правил сброса/отзыва/области согласия;
C затрагивает изоляцию конфигурации, MCP, permissions и оба runtime-транспорта.
Просто читать `~/.codex/config.toml` - не четвертый вариант, а неверная модель.

## 4. Контракт и владение

### 4.1. Один provider-aware read-model

Владелец остается `src/features/workspace-trust`. Не создавать вторую feature или
универсальную plugin/registry-платформу. Достаточно двух явных provider handlers и
общего resolver рабочей папки.

Предлагаемый контракт, окончательные имена сверить при реализации:

```ts
type LaunchTrustProviderId = 'anthropic' | 'codex';
type ProviderLaunchTrustStatus =
  | { providerId: 'anthropic'; status: WorkspaceTrustProjectStatus }
  | { providerId: 'codex'; status: 'launch_scoped' | 'unknown' | 'disabled' | 'not_applicable' };

interface LaunchTrustRequest {
  projectPath: string;
  providerIds: LaunchTrustProviderId[];
}
interface LaunchTrustResult {
  providers: ProviderLaunchTrustStatus[];
}
```

DTO не содержит содержимого конфигов, auth identity, config-home, stderr, полного
плана запуска или текста технической ошибки. Провайдер обязан присутствовать в
ответе явно; Claude `trusted` никогда не распространяется на Codex.

`launch_scoped` означает только известную стратегию подготовки trust-настроек
на запуск. Не означает "overrides уже применены", "все worktrees покрыты",
"runtime готов", "команда успешно стартует" или "проект навсегда доверенный".

### 4.2. Общая логика, отдельные источники

- Общие: validation, canonical-path resolution, результат на provider,
  cancellation/freshness, aggregation, transport errors и UI.
- Claude: существующий `FileClaudeStateProbe`, его текущая семантика и источник
  конфигурации. Не менять заодно правила parent trust или запись `.claude.json`.
- Codex: локальная launch policy и `enabled && codexArgs`. Для выбранной папки
  использовать тот же чистый planner overrides, что используется в coordinator.
  Если он дает применимые настройки, вернуть `launch_scoped`, а не запускать CLI
  и не читать TOML. Не выводить статус только из наличия включенного флага.
- Claude gate: `enabled && claudePty`. Выключение Claude-флага не выключает Codex.
- Не вызывать `planFull`, PTY, model catalog, auth refresh, PONG или provider tools
  из status reader. Операция read-only и без process spawn.
- Извлечь небольшой чистый policy/planner helper между coordinator и reader
  внутрь существующей feature. Не дублировать gate/сбор config keys/проверки
  применимости. Отсутствие ожидаемых настроек при включенной стратегии -> unknown.
- Ошибка provider handler локальна для него. Ошибка общего path resolution влияет
  на весь запрос. Не позволять Claude parse failure стереть известную Codex policy.

### 4.3. Совместимость и транспорт

Добавить `getLaunchStatus` рядом с текущим `getProjectStatus`, не менять смысл
старого API. Старую Claude-only операцию реализовать через тот же use case с
единственным Anthropic provider, сохранив прежнюю форму ответа.

Новый bridge метод должен быть feature-detectable. Старый main / отсутствующий
метод / старый HTTP server не должны ломать renderer или выдавать Codex `trusted`.
Для поддерживаемых провайдеров безопасный fallback - скрытый `unknown`. Для
Anthropic-only допустим legacy API; его результат нельзя
использовать в качестве Codex evidence.

IPC и HTTP используют общий validator и facade. Добавить HTTP route/client и
composition wiring, включая standalone. Соблюдать существующий auth boundary
HTTP-сервера; не принимать от renderer пути к auth/config или env overrides.
Read-only filesystem operation должна выполняться на host проекта. Если текущий
SSH mode не поддерживает эту операцию, вернуть `unknown`, не читать локальный
одноименный путь как факт о remote-проекте.

## 5. Поведение UI

Оба диалога передают уже вычисленный набор провайдеров lead + активных teammates.
Внутри feature отфильтровать только Anthropic/Codex, дедуплицировать и стабильно
отсортировать. Removed member не участвует; порядок roster не создает новый запрос.

| Состояние выбранных поддерживаемых провайдеров     | Отображение                                     |
| -------------------------------------------------- | ----------------------------------------------- |
| Только Claude, trusted                             | Нет подсказки                                   |
| Claude untrusted                                   | Одна first-launch warning-карточка              |
| Claude unknown                                     | Нет подсказки                                   |
| Codex launch_scoped                                | Нет подсказки                                   |
| Claude trusted + Codex launch_scoped               | Нет подсказки                                   |
| Claude untrusted + любой сосед                     | Одна first-launch warning-карточка              |
| Все disabled/not_applicable                        | Нет подсказки                                   |
| Запрос checking, нет актуального результата        | Нет отдельного текста/спиннера, CTA не меняется |
| Только неподдерживаемые провайдеры                 | Нет trust-запроса и подсказки этой feature      |

Не добавлять новый лейбл `launch_scoped` в пользовательский текст. Переиспользовать
существующий translation key `launch.workspaceTrust.description`, поэтому новый
набор переводов и перетасовка 29 локалей не требуются.

### Freshness и ограничение задержек

- Сохранить request-instance identity, а не только сравнение строки пути.
- Key включает lifecycle открытия, normalized path, canonical provider set и
  существующий revision выбранной конфигурации/host, если он меняет источник.
- A -> B -> A, закрыть/открыть, убрать/вернуть Codex, сменить lead/member provider:
  старый ответ не применяется даже при совпадении pathname.
- Сохранить debounce 120 ms. Не добавлять polling, FS watchers или глобальный cache.
- Зависший read не должен навсегда оставаться checking: общий UI deadline 2 s,
  затем unknown. Поздний ответ после deadline не применяется к завершенному
  запросу; новая попытка только по новому актуальному контексту/открытию.
- Request и timer отменяются при cleanup. Никакой ошибки после unmount и повторного
  launch/preflight из-за обновления статуса.

## 6. Шаги реализации

1. Зафиксировать исходный diff/ownership. Не менять основной checkout пользователя;
   работать в указанном feature worktree, не трогая чужие/предыдущие исправления.
2. Добавить failing tests для provider-aware reader, legacy compatibility и
   Codex `launch_scoped`; отдельно зафиксировать независимость флагов.
3. Выделить минимальный общий path resolver из существующего reader, использовать
   его для обоих providers. Проверять directory, не только realpath. Применимость
   persisted Claude trust и launch-scoped Codex settings определяется раздельно.
4. Добавить общий use case и две стратегии чтения; reuse Claude adapter и Codex
   launch policy. Не переносить persisted state probe в renderer.
5. Добавить DTO/IPC/preload/HTTP/client/composition. Валидатор общий, контракты
   feature-owned, старый API делегирует внутрь, никакой facade inheritance.
6. Расширить существующий hook и чистый view-model. В Create/Launch заменить
   Anthropic-only condition передачей provider set, без копирования policy.
7. Прогнать focused tests/typecheck/lint/guards. Старые pending-preflight/Skip,
   duplicate-submit и CTA retry тесты должны остаться зелеными.
8. Проверить реальные компоненты через DevMCP в sandbox, сделать screenshots и
   затем отдельный ограниченный live canary, если выполняется полная реализация.
9. Провести независимый review exact diff, только потом оформлять delivery.
   Release/публикация/merge не входят в этот план автоматически.

## 7. Edge cases и запреты на неверные выводы

### Пути и входные данные

- Пустой/относительный/NUL/слишком длинный путь, не-object request, неверный provider
  или превышенный размер providerIds: reject в validator, без filesystem probing.
- Нет папки -> not_applicable; permission/I/O/parse error -> unknown; обычный файл
  вместо cwd -> not_applicable. Не считать отсутствие записи ошибкой авторизации.
- Root/home остаются non-persistable по действующей политике Claude reader, но
  нельзя переносить этот фильтр на Codex автоматически: `buildCodexPatches` сам
  не фильтрует `persistable`. Для Codex следовать чистому launch planner, не менять
  запуск и не скрывать строку только из-за отсутствия persisted trust. Это тесты
  с fake ports, не разрешение выполнять живые команды в home/root.
- Проверить trailing slash, Unicode, пробелы/кавычки, Windows drive/UNC/case
  normalization; не копировать Claude parent-trust алгоритм в Codex.
- Symlink cwd, `/tmp` vs `/private/tmp`, linked worktree, удаленная папка между
  realpath и чтением, некорректный `.git`/gitdir: существующие canonical helpers,
  безопасный unknown, никаких write/repair операций.
- Preview касается выбранной корневой папки, не всех будущих member worktrees.
  Создание новой изоляции не доказывает ее trust этим результатом.

### Смешанные команды и настройки

- Claude lead + Codex teammate, Codex lead + Claude teammate, Codex-only,
  removed teammate, solo team, multimodel выключен, change provider во время read.
- Create без Launch / редактирование команды / закрытый dialog не запускают reader.
- Один provider disabled и другой enabled: состояния независимы; массив дубликатов
  не умножает чтение Claude config.
- Ошибка Claude не превращает Codex policy в ошибку и наоборот. UI сворачивает
  несколько результатов в одну строку без false `all trusted`.
- Codex account/backend change не требует чтения секретов. Будущий persisted
  reader обязан брать CODEX_HOME из выбранного runtime context, не из UI/env guess.
- Config/env смена не должна получать stale результат предыдущего host/profile.
  Если revision не доступен, инвалидировать при открытии/settings-return, не
  добавлять скрытый глобальный observer для этой маленькой задачи.

### Известный соседний риск, не часть обещания

Frontend нормализует до 64 overrides / 16384 bytes; runtime потребляет максимум
32 / 8192. Поэтому в этом PR нельзя вводить статус "все папки доверены" на основании
producer patches. Синхронизация лимитов - отдельный contract fix, если потребуется
гарантия полного покрытия. Для информационного `launch_scoped` runtime менять не
нужно. При обнаружении реального провала обычной маленькой команды зафиксировать
отдельный дефект и не маскировать его словом trusted.

## 8. Проверки и доказательства

### Автоматические проверки

- Domain/view-model: таблица всех комбинаций; Codex никогда не становится
  persisted trusted; mixed trusted+launch_scoped не теряет строку.
- Main: Claude behavior unchanged; Codex не читает TOML/не spawn; флаги независимы;
  filesystem edge cases; повтор provider не повторяет reader; bounded error DTO.
- IPC/HTTP/preload/client: одинаковый результат, input validation, missing route,
  old bridge, malformed/partial/unknown-provider response, безопасный fallback.
- Hook: fake timers, provider reorder, provider A-B-A, path A-B-A, reopen, timeout,
  reject/unmount, settings/host invalidation, no stale flash, не затирать новое
  состояние поздним trusted ответом.
- Mounted Create/Launch: правильный набор lead/member providers; одна строка;
  launchTeam=false не читает статус; checking trust не блокирует кнопку; уже
  исправленные optional Skip/failure/duplicate click сценарии не регрессируют.
- Существующие trust path/coordinator/settings/arg-patch тесты остаются зелеными.

Все pnpm-команды запускать с отключенным auto dependency verification: в этом
worktree обычный pnpm способен неожиданно запустить install/rebuild.

```sh
env pnpm_config_verify_deps_before_run=false pnpm test test/features/workspace-trust
env pnpm_config_verify_deps_before_run=false pnpm test test/renderer/components/team/dialogs/LaunchTeamDialog.test.ts test/renderer/components/team/dialogs/optionalProviderPreflight.test.ts
env pnpm_config_verify_deps_before_run=false pnpm typecheck
env pnpm_config_verify_deps_before_run=false pnpm guard:source-file-size
env pnpm_config_verify_deps_before_run=false pnpm guard:team-provisioning-architecture
git diff --check
```

Дополнительно targeted transport tests, formatter check и `lint:fast:files --`
с точным списком файлов этого приращения. Финальный PR gate - проектный full lint,
если изменение transport wiring затронуло архитектурные границы. Не устанавливать
зависимости, не перезапускать весь release pipeline ради маленького UI изменения.

### DevMCP и live canary

1. Использовать desktop `dev:mcp` на CDP 9222 и source orchestrator `cli-source`.
   Не заменять это web dev mode или Computer Use/native picker.
2. Только новый disposable sandbox/test project; реальные проекты пользователя
   не использовать даже для preflight, terminal или PONG.
3. Fixture-проверки: Claude trusted/untrusted/unknown, Codex-only, mixed,
   timeout/error, смена provider, два размера окна. Снять footer screenshots;
   пометить их как UI fixtures, не как доказательство живого provider runtime.
4. Отдельно один live mixed canary: Claude Haiku + простой Codex, без OpenCode в
   этой задаче. По одной короткой sandbox-задаче каждому; доказать выполнение по
   artifact + task state, а не только roster/connected badge.
5. Проверить повторное открытие Launch после остановки только canary-команды:
   Claude suppress основан на persisted trust; Codex показывает компактную строку
   без false first-launch. Skip/readiness authority остаются независимыми.
6. Не повторять автоматически live spawn после неоднозначного результата.
   Сначала проверить конкретный runId/process/task evidence. На timeout собрать
   owned artifacts, не ждать 75 минут и не менять аккаунт вслепую.
7. По завершении оставить dev app открытым. Останавливать только созданную этим
   canary команду; не трогать существующие команды и shared runtime hosts.

## 9. Rollback и критерии готовности

Rollback - отдельный revert этого bounded frontend приращения. Не откатывать
предыдущие provider/preflight fixes. Новых config writes, миграций и runtime binary
изменений нет. Для UI rollback не выключать общий trust flag: он меняет также
launch behavior и не является безобидным переключателем отображения.

Готово, когда:

- [x] Claude и Codex представлены в одном read-model/hook/UI без копий flow.
- [x] Claude trusted скрывает строку; Codex launch-scoped не выдается за persisted.
- [x] `First launch` показывается только для доказанного Claude `untrusted`;
      `Project status unknown` не показывается.
- [x] Mixed команда показывает максимум одну строку; removed provider не влияет.
- [x] Нет paid/CLI preflight, config writes, auth reads или новой кнопки подтверждения.
- [x] IPC/HTTP/legacy fallback и все freshness edge cases покрыты тестами.
- [x] Trust checking не меняет Launch/Skip и не скрывает реальные readiness blockers.
- [x] Focused gates и DevMCP screenshots пройдены на exact candidate diff.
- [x] Live evidence отделено от fixtures; сбои внешнего provider не названы успехом.
- [x] Codex `launch_scoped` скрыт и не создает повторяющуюся подсказку.

В DevMCP на disposable sandbox проверено: trusted Claude не показывает карточку,
untrusted Claude показывает ровно одну warning-карточку, Codex launch-scoped и
неизвестные состояния не создают нейтральный шум. Provider preflight проверяется
отдельно и не использует trust-статус как launch authority.

Ожидаемый бюджет: 200-350 production/wiring LOC и 300-500 test LOC. Если для
варианта A понадобится существенно больше, сначала проверить, не попали ли в
него persistence, launch policy или общая платформа, которые исключены из scope.
