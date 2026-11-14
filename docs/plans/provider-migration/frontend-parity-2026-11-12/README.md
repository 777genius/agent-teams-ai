# Stage 1: полное соответствие существующему frontend

Дата: 12 ноября 2026. Статус: планы прошли три круга ревью; начата параллельная реализация. Native gates и приёмка ещё открыты.

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
   Входные gates: P08 admission до provider/plugin execution; P09 отдельный service scope
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
- Job admission P08 предшествует исполнению provider/plugins; успешный spawn-then-assign smoke
  не исключает раннего child. P09 service Stop сохраняет provider Job и соседа,
  позднее assignment root или PID snapshot не доказывает service-tree closure.
- Для P08 сначала переиспользовать существующий atomic-launch broker и его target stdio,
  если узкий structural spawn adapter сохраняет pinned SDK contract. Доверенный Node bootstrap
  с gate — альтернативный вариант, не вторая обязательная реализация. Новый native protocol не нужен.
- Requested-before-native recovery P09 использует явный linked retry в прежнем
  journal. Lookup не посылает signal; UNKNOWN не превращается в known-not-sent;
  same-live original не остаётся навсегда без доступного действия Stop.
- Старые Darwin v1/v2 captures читаются прежним decoder без изменения bytes,
  digests и processRef; новая schema не является поводом мигрировать active records.
- TypeScript 7 — по [AGENTS](../../../../AGENTS.md); соблюдать
  [архитектурный стандарт](../../../FEATURE_ARCHITECTURE_STANDARD.md)
  и [guardrails](../../../../AGENT_CRITICAL_GUARDRAILS.md):
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

P10 объединяет acceptance в семь групп: accounts; selection/config; conversation;
schedules; upgrade/recovery; packaged runtime + Processes; опасные native границы.
Один build используется для всех подходящих сценариев своего OS tuple. Existing
unit suites расширяются только новым инвариантом; helper/mapping coverage не является целью.

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
| R3 | Выполнен root с focused reviews трёх исполнителей | Уточнены auth cancellation/source binding, reuse compact, finite schedules, existing Windows broker, service pre-birth gate и реальные CI/harness границы; implementation acceptance не объявлена |

Исходная published ревизия этой страницы для R2:
[`92d88845657e845f9b5080c1617245342c7061ab`](https://github.com/777genius/agent-teams-ai/blob/92d88845657e845f9b5080c1617245342c7061ab/docs/plans/provider-migration/frontend-parity-2026-11-12/README.md).
Независимо прочитаны README/P08/P09/P10 и сопоставлены P05–P07, Stage 1
`CapturedProcess`, `WindowsJobCustody`, `TeamProcessCommands`, original Processes UI.
Уточнение V2 forget сверено с R2 владельца P02; этот review не выдаётся за новое
независимое ревью собственных P05–P07 или за завершённый R3 всей серии.

R3 входные published SHA: `cda065d869ccffb5930ed2a817b3e0654b00bb31` и
`263e913941ed4257094a3b9f30c7c06d0a046a39`; P09/P10 findings опубликованы в
`e746c703eada8e446c71cf9954b449903c59ea77`. Root сопоставил existing capture/restore,
writer lease, OAuth completion, headless command filter, scheduler dispatcher и
broker/SDK spawn contract. Дополнительные findings и ссылки — в R3 каждого плана.

Первая параллельная волна: P01 typed Codex protocol и Host account flow; P06 trusted
source revisions/capture/restore; P08 reusable native broker/spawn seam; root — P04
schedule adapter и интеграция. P02/P03/P05/P07 подключаются следующими срезами после
готовых shared contracts. P09 `09-WG` остаётся отдельной задачей исследования native
service-launch seam; работа остальных пунктов от него не зависит.

## Дополнение: живой состав команды

[11-live-membership.md](11-live-membership.md) сохраняет добавление, удаление и восстановление участников работающей команды. План содержит ссылки на старый frontend, порядок захвата фактической рабочей папки, исходный command/cutoff и проверку освобождения ресурсов. Повторное независимое ревью выполнено; реализация и отдельный native mixed E2E остаются обязательными. Общая подготовка модели подключается по P05 §16B.4; Linux qualification inputs уточнены в P09 §84.

## Состояние перед следующим полным E2E-прогоном — 14 ноября 2026, 17:20 UTC

Это обновление описывает опубликованные исправления и оставшуюся проверку.
Оно не заменяет отдельные критерии P01–P11 и не объявляет миграцию завершённой.

- Все проверки предыдущего набора (Batch 4) завершились. Его packaged smoke
  прошёл на всех 15 запусках трёх PR; остальные ошибки этого набора сохранены
  как исходные evidence и не считаются исправленными только по новым исходникам.
- Исправления закоммичены и сразу отправлены в три рабочие ветки. Следующий
  согласованный набор будет направлен в PR #1186, #1187 и #1188 одним
  обновлением каждого head. После этого выполняющиеся проверки должны
  завершиться; отмена, пустой перезапуск и изменение head ради зелёного
  результата не используются.
- Основная ветка и default path остаются без изменений. После успешной
  приёмки дочерние PR интегрируются в parity-ветку по P08 §16.1, затем
  parity PR — в Stage 1. Результаты должны относиться к итоговому составу кода.

| Исправленный участок | Что подтверждено локально | Что ещё обязательно |
| --- | --- | --- |
| OpenCode V1/V2: исходный выбор runtime, конфигурации и модели | Проверены адресные исправления source/status, model action digest и подготовка actual worktree; условия исходных проверок сохранены | Реальные V1/V2 Desktop journeys, смена установленного/встроенного источника, live membership и cold readback |
| Codex: Settings A→B, Login, Windows capture | Опубликованы исходный Update/cold сценарий, ожидание готовности Login UI и исправление CodeQL 610; 18 исходных resolver-тестов и 14 readiness-тестов прошли | Native Login, A→B при продолжающемся A, новый B без истории A, cold restore, новый CodeQL результат |
| Windows: завершение и явное восстановление Host | 298 адресных Main/renderer-тестов и 49 protocol-тестов прошли; source caps и архитектурная проверка прошли | Настоящие packaged UI проверки x64/ARM64, сохранение соседнего процесса и полное освобождение исходного семейства |
| Claude, команды, расписания и сохранённые команды | Опубликованы исправления исходных command/quit/import fixtures и диагностик Launch | Отдельные UI/native receipts для Commands, Extensions, Schedule, Resume, Quit и genuine upgrade/import |
| Общий Host Create | Build и test-types прошли; 41 исходный адресный тест прошёл | Исходный полный прогон дал 1244 PASS / 1 FAIL / 2 skip: не прошла исходная строгая проверка allocation до собственного дедлайна 1000 мс |
| Общие TypeScript/lint проверки | Быстрые адресные проверки Codex и лимит размеров прошли | Общий typecheck завершался SIGKILL, typed lint — OOM/SIGKILL; успешный текущий CI всё ещё требуется |

Один диагностический полный Host-прогон затем дал **1245 PASS / 0 FAIL / 2 skip**.
Это диагностический результат: профилировался только исходный Create child,
а временный вывод был добавлен только на уже нарушенное исходное условие.
Ошибка в этом запуске не повторилась, поэтому timestamps не были выведены и
причина прежнего превышения дедлайна не установлена. Исходный тест восстановлен
побайтно (`c24c405663019f72cbd09f66705971fcd04c4daa`).
Повторный диагностический запуск для получения желаемого результата не предусмотрен.
Дедлайн, исходная строгая проверка, число бизнес-операций и custody не меняются.

Профиль показывает повторную работу при проверке текущих полномочий и состояния,
но не доказывает причинность конкретного пропущенного дедлайна. Мелкая замена
буфера не обоснована как исправление этого сбоя. Допустимо только узкое исправление
с доказательством сохранения свежих проверок; кэширование положительного
результата или пропуск проверки не является решением.

Приёмка следующего набора читает отдельные результаты: Codex C10 и Login;
OpenCode V1 и V2 live membership; Commands/Extensions/Schedule;
V2 captured MCP; Quit/PNG/genuine upgrade import; Resume/Review/taskboard/
cross-team/cold history. Общий `Full qualification` не включает все Desktop
и process jobs и сам по себе не закрывает эти строки. Downstream `skipped`
остаётся непройденной приёмкой.

POSIX source-identity P09 §75 остаётся отдельным открытым контрактом:
нынешний path+hash launch не связывает позднее чтение изменяемого script
с проверенными байтами. Нового совместимого подтверждённого механизма
в текущем исходнике не найдено; ограничение не скрывается ослаблением oracle
или удалением поддерживаемого типа источника. Остальные исправления и E2E
продолжаются независимо.

Проверяемые записи этого обновления: acceptance inventory
`4330190ba874b627aad1f6d986b42326b1fb9820`;
исходный полный Host FAIL `f27e0b9983ee6e6c6290b17d9b710dc843907462`;
диагностический manifest `1509c58bc565e6c50f33183361f10726e4ad819b`
и raw log `6792a765ec94c88a6088137c11bf69357616d73d`;
исправление CodeQL/resolver `84e69cf1b3955399348fe433192e5dc5d5627298`.

## Фактическая приёмка Batch5 — обновление 14 ноября 2026

Предыдущие разделы сохранены как история. Этот статус разделяет результаты
исходных запусков Batch5 и последующие изменения в repair-ветках.
На срезе CI 20:28:35 UTC parent Full qualification (job132567214491) завершился
FAIL; parent packaged aggregate и native CI aggregate ещё ожидали выполнения.
Общий итог приёмки остаётся открытым.

### Подтверждённые исходные сценарии

- Все 15 original packaged V2 tuple receipts прошли свой исходный Host-сценарий:
  каждый — шесть native steps, 11 model requests, два Host exit0 и cleanup. Это
  отдельная приёмка packaged Host; Windows Retry/Processes UI, model-readiness
  coordination, vendor authentication и release этими receipts не подтверждаются.
- Codex Login на Linux x64 прошёл browser/device-code pending, copy, повторное
  открытие того же authorization, cancel и физический cleanup через исходные
  Settings/preload/Main/Host/native app-server. Аутентифицированный vendor login
  и другие платформы остаются за пределами этого результата.
- Два исходных native scheduled-теста прошли: Claude — пять model requests,
  Codex — три; finite success/limits/cancel/cold/same-intent и Codex lost-application
  reply. Desktop Schedule остаётся отдельным skipped follow-on после Commands UI.
- Retained V1 и Host V2 coexistence прошёл на Linux x64 в dev Electron:
  оба исходных UI Stop сохраняют соседнего владельца, холодный старт читает обе
  истории без replay, cleanup успешен. Записаны 12 model requests и пять business
  markers. В том же job последующий V1 Install/PATH сценарий завершился INCOMPLETE,
  V2 source-selection был skipped; release/vendor qualification не заявлена.
- CodeQL610 review thread теперь resolved/outdated by github-advanced-security[bot].
  Ручного dismiss/resolve не было; отдельное состояние security alert не установлено.

### Опубликованные исправления и открытые причины

В repair-ветках опубликованы R26 (Commands compaction correlation), P05 §33
(V2 product/Runtime revision join), P06 §§31–32 (donor Codex absence и V1
maintenance), P09 §106 (два Settings selectors) и native-only P08 §§19–23
(Stop settlement, TEST profile limit, Windows private files и два TEST mocks).
Их source/controlled проверки не заменяют исходные текущие Desktop/native gates.

Пять семейств пока получили только диагностику: P09 §105 — первый сбой Codex
A→B; §107 — сохранение фактического invalid/rejected Main wire для Claude Resume;
§108 — packaged Windows access violation; §109 — Linux credential close;
P06 §33 — лишний status/catalogue вызов stopped import. Причины этих отказов
остаются открытыми; исходные бюджеты и условия PASS сохранены.

Полный исходный serialized Host runtime suite с §110 завершился
1247 total / 1245 PASS / 0 FAIL / 2 existing skips за 338993.528 ms.
Перед ним focused-прогон дал 43 PASS / 1 FAIL: исходный Create lead был
зафиксирован на 81 ms позже собственного deadline. Оба результата сохранены;
intermittent deadline не объявлен исправленным. §110 опубликован в трёх repair-ветках.
Стандартные build, test-types, fast lint и source-size guard прошли.

Оба parent Windows broker jobs завершились exit75 в старом debug-service пути.
Соответствующая native-child реализация уже прошла исходные ранние service gates;
последующие Windows profile/UI failures учитываются отдельно. Оба child PR1187
и PR1188 ещё должны пройти требуемую приёмку и интегрироваться в parity, затем
parity — в Stage1 с проверкой итогового состава. Repair refs не означают слияние.

P09 §75 остаётся открытым для POSIX custom executable с заранее открытым
некооперативным writable FD: подтверждённого общего решения, сохраняющего
original path/$0/argv/env/cwd/resources и valid #! scripts, не установлено.
Действующие source guards и counterexample oracle сохранены; остальные E2E идут.

### Проверяемые записи

Карта 25 завершившихся failures на 20:17:09 UTC:
`574e0d266060b8fb5ece8405cde205ebf4ce3b62` (поздний parent aggregate указан выше).
Packaged V2: `22be288cf747c28b12f54cb12dd58793eae2463a`,
`4b9d2c6a1025d247f5284e972e4bebc862210bd6`, `b1aded232baadf88e3c9231d7a34df0767c42db1`,
`cccadb9c360b40ee788ecca8eb0589ca8f3af0ed`, `99a79b55ed181faddd8c2ec43ab227786ec8f53d`.
Codex Login: `6acf32e640d267444a577c6eec3de1337d054f78`; native schedules:
`8a0f02e0afcfc5290604fe298e7e8446c8daf12c`; retained coexistence:
`88ea496f988e1f61c8097588d0b726a902fb48c0`.
Host focused FAIL: `a2b06a599ad16e02acd2a8a7c163e5097b0afa16`; полный исходный PASS:
`1588a0fe785a3d9aa97bea0c9cec021d54964138`; validation §110:
`f794e5df742c6dbfe7a4fdd05bb77a3b1e370493`.
