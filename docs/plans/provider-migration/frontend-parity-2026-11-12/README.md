# Stage 1: полное соответствие существующему frontend

Дата: 12 ноября 2026. Статус: планы и независимое ревью; реализация пунктов ещё не принята.

## Цель и исходное состояние

Сохранить все работающие пользовательские возможности текущего frontend при
использовании Host с Claude Code, Codex, OpenCode V1 и OpenCode V2. Внутренняя
реализация может измениться; выключенная существующая возможность не считается
завершённым переносом. Используем нынешние Settings, Create/Launch, composer,
Schedules, Processes и Review, без параллельных форм и отдельного продукта.

Проверяемые исходные точки:

- frontend main: [`4a0e062`](https://github.com/777genius/agent-teams-ai/tree/4a0e06277fe216d9f82dbbede362668fe46622ee);
- Stage 1: [`1d0f97f`](https://github.com/777genius/agent-teams-ai/tree/1d0f97f55de566036c970eab4f36b84620afdb3f), дерево `ec540290c86af9755c94e52ac795aeda8586a98f`;
- ранее проверенный dependent PR: [#1110](https://github.com/777genius/agent-teams-ai/pull/1110),
  [отчёт о его ограниченной приёмке](https://github.com/777genius/agent-teams-ai/pull/1110#issuecomment-6810678279);
- интеграционная ветка этой работы: `feat/provider-host-frontend-parity-20261112`,
  PR направлен в `feat/provider-migration-stage-1`, а не в `main`.

Ранее принятые native/desktop сценарии остаются полезными доказательствами своих
границ. Они не подтверждают автоматически новый вход, slash-команды, расписания,
выбор следующего профиля или все платформенные UI-пути.

Прямое поручение владельца от 12 ноября дополняет прежний ограниченный scope
Stage 1 полной совместимостью существующего UI для четырёх путей. Исторические
пункты «только V1» и «unsupported допускается как завершение» не применяются к
этой работе. Stage 2, новые ядра, выпуск приложения, включение Host по умолчанию
и merge в `main` по-прежнему не входят в цель.

## Планы по пунктам

| ID | Отдельный план | Ответственность | Основные зависимости |
| --- | --- | --- | --- |
| P01 | [Codex login](01-codex-login.md) | Вход/отмена/состояние аккаунта в существующем UI | Нативный Codex client и существующий OAuth owner |
| P02 | [OpenCode V2 credentials](02-opencode-v2-credentials.md) | Подключение по ключу и состояние в существующем UI | P06 для следующей конфигурации |
| P03 | [Session commands](03-session-commands.md) | Slash-команды, skills и настройки действующей сессии | Нативные capabilities; P05 не дублирует live controls |
| P04 | [Host schedules](04-host-schedules.md) | Старые сценарии расписаний с Host owner | Существующие Team/Runtime use cases |
| P05 | [Model selection](05-model-selection.md) | Каталог/default/probe/выбор до запуска | P06 |
| P06 | [Runtime installation and profiles](06-runtime-installation-profiles.md) | Установка/выбор/обновление и профиль следующего запуска | Общая точка изменения profile revision |
| P07 | [Provider settings and extensions](07-provider-settings-extensions.md) | Применимые config/limits/skills/MCP/plugins | P06; проверка неясных V2 возможностей |
| P08 | [Windows provider runtime](08-windows-provider-runtime.md) | Пути, окружение, native launch и cleanup | Общие OS primitives для P09 |
| P09 | [Cross-platform Processes](09-cross-platform-processes.md) | Registry/health/history/Stop на Windows/Linux | P08 для общего Windows custody |
| P10 | [Acceptance and recovery](10-acceptance-recovery.md) | Обновление данных, восстановление, Review, packaged UI | Готовые вертикальные срезы P01–P09 |

Каждый план содержит ссылки на старую реализацию, минимальные изменения,
критерии приёмки, оценку production/test LOC, оценки сложности/надёжности/
уверенности и запись фактически проведённых кругов критики.

## Порядок параллельной работы

1. **Сначала планы.** Авторы параллельно готовят P01–P04, P05–P07 и P08–P09;
   координатор ведёт P10 и проверяет общие границы. Готовый документ публикуется
   отдельным небольшим commit с немедленным push.
2. **R1 — baseline и собственная критика.** Для каждого пункта проверить путь
   от существующего control до side effect. Отличить рабочую возможность,
   неподдержанный старым runtime пункт и ещё не проверенный пункт. Записать
   найденное и исправленное; список вопросов без решения не считается ревью.
3. **R2 — независимое ревью.** Другой автор проверяет каждый документ на потерю
   функций, лишние владельцы/хранилища/абстракции, восстановление и достаточность
   E2E. Исправления и оставшиеся вопросы публикуются следующим commit.
4. **R3 — интеграция и выполнимость.** Координатор проходит каждый пункт:
   зависимости, пересечения файлов, одна ответственность за общий механизм,
   реальные provider APIs, доступность native OS и смысл каждого теста. После
   исправления существенных замечаний план допускается к реализации.
   R2/R3 записывают reviewer, исходный published SHA, конкретный дефект и внесённую
   поправку. Проверка плана не означает PASS реализации или native приёмки.
5. **Реализация вертикальными срезами.** Сначала минимальные общие контракты
   P06/P08 и необходимые native controls. Параллельно независимые P01/P04 и
   provider adapters; после стабилизации контрактов — P02/P05/P07/P09.
   Изменения общего файла интегрирует один назначенный владелец.
   Входные gates: P08 admission до исполнения root; P09 отдельный service scope
   до Stop wiring; P07 bounded source/native probes неизвестных V2 capabilities.
6. **Приёмка по ходу работы.** Проверять затронутый путь сразу. Полные дорогие
   матрицы запускать на объединённом интеграционном SHA и повторять только
   затронутые матрицы после исправлений. Каждый commit немедленно публиковать.

Root координирует Git-операции; параллельные исполнители не меняют один branch
ref одновременно. Если `gh` не авторизован, используются официальные операции
GitHub connector: commit/tree и обычное fast-forward обновление ref с expected
SHA. Отсутствие авторизации CLI не является поводом оставлять изменения локально.

## Минимальная архитектура

- Сохранять текущие Team, Runtime, credential, model-probe и extension owners.
  Не создавать вторую систему авторизации, scheduler, event bus или profile DB.
- Бизнес-правила размещать в существующем владельце/use case; transport и UI
  только вызывают его. IPC и существующий HTTP путь используют одну семантику.
- Менять общую библиотеку Session/provider в её исходном репозитории;
  frontend получает проверенный immutable artifact. Не редактировать vendored
  `dist` и не подменять отсутствующую native capability обычным prompt.
- В P06 одна реализация перехода к следующей конфигурации; остальные пункты
  добавляют только свои входные данные и проверки. Активная или UNKNOWN-сессия
  сохраняет прежние runtime/account/model bindings и владельца восстановления.
- Credential verification P02 выполняется native probe внутри одного credential
  intent. Вложенный public `ModelProbeOwner.start` под тем же resource fence не
  используется; P05 владеет отдельным пользовательским probe/prelaunch сценарием.
- В P08 одна общая Windows primitive для запуска/владения процессами; P09
  добавляет зарегистрированную identity, наблюдение и stop, не второй process manager.
- Job admission P08 предшествует исполнению root; успешный spawn-then-assign smoke
  не исключает раннего child. P09 service Stop сохраняет provider Job и соседа,
  позднее assignment root или PID snapshot не доказывает service-tree closure.
- Requested-before-native recovery P09 использует явный linked retry в прежнем
  journal. Lookup не посылает signal; UNKNOWN не превращается в known-not-sent;
  same-live original не остаётся навсегда без доступного действия Stop.
- Старые Darwin v1/v2 captures читаются прежним decoder без изменения bytes,
  digests и processRef; новая schema не является поводом мигрировать active records.
- Соблюдать [архитектурный стандарт](../../../FEATURE_ARCHITECTURE_STANDARD.md)
  и [guardrails](../../../../AGENT_CRITICAL_GUARDRAILS.md): TypeScript 7,
  новые production-файлы не больше 800 строк, без повышения frozen caps,
  без whole-service casts, пустых feature-папок и новых фасадов наследования.

## Тестовая политика по прямому указанию владельца

Основное доказательство — пользовательский E2E путь: существующий UI → Main →
Host → настоящий SDK/CLI → проверяемый результат → сохранение/повторное чтение.
Для воспроизводимости допустим localhost inference при настоящем native runtime;
это не доказательство авторизации у vendor или качества удалённой модели.

Переиспользуем имеющиеся fixture/harness, native jobs, screenshots и receipts.
Один параметризованный сценарий может закрывать нескольких провайдеров, если
проверяется реальный отдельный adapter и результат каждого запуска.

P10 фиксирует отдельно native, Desktop UI и packaged UI evidence. Headless PASS
не закрывает исходный control; UI screenshot без native effect/readback тоже
недостаточен. Supported tuples ограничены фактическим provider/launcher baseline:
Darwin x64/ARM64, Windows x64/ARM64 и Linux x64, без автоматического Linux ARM64.
Каждая заявленная строка имеет свой обязательный результат; её FAIL не сужает scope.

Unit-тест добавляется только когда он защищает конкретный опасный инвариант,
который трудно надёжно воспроизвести E2E: stale revision, ambiguous command,
дедупликация после lost ACK, PID reuse, граница Windows path. Не писать тест
на каждый helper, getter, mapper, DTO или вызов mock. Не устанавливать цель
по проценту покрытия, количеству тестов либо строкам тестового кода.

В планах оценки тестового LOC пересчитываются под этот подход. Старый диапазон
10,8–19,9 тыс. строк не является ни обязательством, ни критерием завершения.

## Завершение и доказательства

- Все ранее работающие возможности из P01–P09 выполняются через прежний UI;
  новое ограничение не скрыто удалением control или подменой результата.
- V2 effort/config/limits/MCP/extensions проходят gates P07 по pinned production
  source и native effect. Работающий путь сохраняется; offered-but-broken UI
  остаётся явным пунктом исправления в предусмотренном резерве, без тихого удаления
  control. Прежняя действительно отсутствовавшая возможность не объявляется
  существующей: например, V2 forget не доказан baseline, V1 forget сохраняется.
- E2E P10 завершены на затронутых native платформах; queued/running/skipped
  не записаны как PASS. Ошибки исправлены, повторены соответствующие проверки.
- Независимое ревью относится к текущему diff; receipts — к точному source,
  package/runtime и OS. Ограничения vendor auth обозначены явно и не выданы за PASS.
- Upgrade проверяет byte-preserving старые identities; recovery — границы до native
  effect и после lost ACK. Общий Windows runtime cleanup и Stop одного service
  принимаются раздельно; случайно убитый сосед не может дать зелёную приёмку.
- Draft PR и коммиты опубликованы. Основная ветка не смёрджена и default path
  не переключён. Готовность планов и готовность реализации учитываются отдельно.

## История ревью общего плана

| Круг | Состояние | Результат |
| --- | --- | --- |
| R1 | Выполнен при создании | Убрана прежняя цель по объёму unit-тестов; отделены live controls от prelaunch, общий profile lifecycle от provider-specific настроек, Windows launch от Processes |
| R2 | Общая страница проверена `/root/estimate_profiles_models` | Исправлены P02 scope, native/Desktop evidence, platform census, shared custody/retry boundaries и V2 uncertainty gates; R2 каждого P01–P10 указан в его документе |
| R3 | Ожидает интеграционного ревью | Проверить очередь реализации и границы общей ответственности |

Исходная published ревизия этой страницы для R2:
[`92d88845657e845f9b5080c1617245342c7061ab`](https://github.com/777genius/agent-teams-ai/blob/92d88845657e845f9b5080c1617245342c7061ab/docs/plans/provider-migration/frontend-parity-2026-11-12/README.md).
Независимо прочитаны README/P08/P09/P10 и сопоставлены P05–P07, Stage 1
`CapturedProcess`, `WindowsJobCustody`, `TeamProcessCommands`, original Processes UI.
Уточнение V2 forget сверено с R2 владельца P02; этот review не выдаётся за новое
независимое ревью собственных P05–P07 или за завершённый R3 всей серии.
