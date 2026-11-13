# P10. Приёмка существующего frontend, обновление и восстановление

Статус: план; R1/R2 и независимый R3 review интеграции выполнены. Реализация и новая приёмка не объявлены.

## 1. Что сохраняем и на что опираемся

Проверяем привычный путь Settings → Create/Launch → Tasks/messages/tools →
Review/Processes → Stop/Quit → повторный запуск приложения/Resume. Сохраняем
существующие команды, данные, attachments, выбор модели и историю. Отдельный
тестовый экран или прямой API-вызов вместо original control не доказывает UI parity.

База старого frontend: [`4a0e062`](https://github.com/777genius/agent-teams-ai/tree/4a0e06277fe216d9f82dbbede362668fe46622ee).
Новая исходная база: [`1d0f97f`](https://github.com/777genius/agent-teams-ai/tree/1d0f97f55de566036c970eab4f36b84620afdb3f).

Переиспользуем готовые сценарии и реальные границы их доказательств:

- [desktop-retained-opencode-coexistence.native.ts](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/scripts/legacy-agent-host/desktop-retained-opencode-coexistence.native.ts): прежний владелец и новая команда рядом;
- [desktop-native-review-ui-smoke.ts](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/scripts/legacy-agent-host/desktop-native-review-ui-smoke.ts) и соседние continuation/readback helpers: реальные Read/Edit, Keep/Reject/Undo/Redo и cold history;
- [desktop-native-quit-ui-smoke.ts](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/scripts/legacy-agent-host/desktop-native-quit-ui-smoke.ts): обычный Quit и восстановление;
- [desktop-native-process-ui.ts](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/scripts/legacy-agent-host/desktop-native-process-ui.ts): исходный Processes UI;
- [зафиксированная предыдущая приёмка](https://github.com/777genius/agent-teams-ai/pull/1110#issuecomment-6810678279): полезна как regression baseline, не заменяет новые проверки P01–P09.

Есть существенная готовая база; переписывать Teams, Tasks, сообщения или Review
ради новой серии тестов не нужно. Дополнительный production-код здесь — резерв
на найденные регрессии, а не заранее запланированная новая подсистема.

## 2. Подтверждённые границы предыдущих доказательств

1. Пять native/packaged OpenCode V2 tuples не равны пяти полным Desktop journeys:
   прежние receipts явно отделяют native Host от `desktopJourneyQualified`.
2. [`desktop-backend-smoke.ts:main`](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/scripts/legacy-agent-host/desktop-backend-smoke.ts) безусловно требует Darwin; `native-mixed-host.native.ts`,
   `management-oauth-host.e2e.ts` и `native-opencode-management-host.native.ts` фиксируют
   Darwin ARM64 Node/CLI, а `registered-process-*.native.ts` — Darwin assertions.
   Эти donors существуют, но Windows/Linux proof P08/P09 требует переноса platform boundaries.
3. Stopped legacy import проверен на синтетических прежних записях. Нужна небольшая
   репрезентативная коллекция данных, созданных действующим старым frontend.
4. Retained coexistence не доказывает весь опубликованный старый runtime:
   `publishedRuntimeComplete=false` должен сохраниться в старом отчёте.
5. Review уже имеет реальный proof поддерживаемых Read/Edit путей. Универсальный
   Undo любого Bash/background side effect не добавляем, если старый frontend
   тоже не предоставлял проверяемого такого поведения.
6. [`desktop-codex-account-proof.ts`](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/scripts/legacy-agent-host/desktop-codex-account-proof.ts) вызывает Electron API через CDP и проверяет TEST
   API-key refresh/logout; это не нажатие Login и не ChatGPT login. P01 добавляет
   actual browser/device controls. Localhost/native protocol fixture не доказывает vendor auth.
7. Новый decoder может сохранить значения и при этом изменить bytes/hash прежнего
   capture. Upgrade proof включает неизменность original Darwin identities/receipts.
8. Непроверенные V2 effort/MCP/config возможности разрешаются gates P07 по actual
   runtime source и native запуску. Offered-but-broken control остаётся открытым
   несоответствием; убрать control и объявить parity нельзя. Ранее отсутствовавший
   V2 forget не добавляется как якобы подтверждённая функция; V1 forget сохраняется.
9. `SmartSchedules.safe-e2e.test.ts` проверяет repository/dispatcher с mocked effects.
   P04 требует отдельного original UI → Host → task/launch proof; достаточно одного real cron tick.

## 3. Минимальный состав изменений

- Расширить существующие scripts/legacy-agent-host fixtures и UI journeys только
  сценариями, которые появились в P01–P09 или закрывают конкретную границу выше.
- Выделить ограниченный portable launch/observe/cleanup helper для P08/P09, переиспользуя
  `scripts/e2e/teams-create-page-desktop.mjs` и `teams-create-page-owned-processes.mjs`.
  Сохранить CDP UI helpers; убрать Darwin assumptions только вместе с real OS ownership proof.
- Сохранять нынешний формат receipts, source pins, attachments и screenshots.
  Не создавать новый E2E framework, dashboard, runner service или общую DSL.
- В существующем CI связать необходимые scenario jobs с одним интеграционным SHA.
  Сохранить отдельные результаты provider/OS; зелёный агрегатор не должен скрывать
  пропущенную обязательную строку.
- Исправлять обнаруженный дефект в владельце соответствующей функции, а не
  обходить его через harness, искусственные waits, повторный prompt или новый UI.
- Если изменён общий use case с существующим HTTP API, выполнить один smoke через
  его adapter (`src/main/http/agentBackend.ts`); не добавлять API или вторую RPC/UI матрицу ради теста.

## 4. Пошаговое выполнение

### A. Установить конечный список сценариев

1. Собрать E2E IDs из P01–P09; убрать дубли одинаковых setup/recovery цепочек.
2. Для каждого ID записать существующий UI control, ожидаемый внешний эффект,
   provider/OS и место сохранения доказательства. Отдельно отметить native и UI.
   Обязательные колонки: provider/launcher/OS/arch, source/runtime/artifact SHA,
   evidence kind (`native`, `Desktop UI`, `packaged UI`), scenario ID и job/result.
   Это обычная таблица, без новой schema, сервиса или генератора.
3. Сохранить список в обычной Markdown таблице в этом плане или существующем
   evidence README; не вводить schema/генератор ради маленького статичного списка.
4. Выбрать по одному репрезентативному позитивному и критичному failure/recovery
   сценарию каждого изменяемого контракта. Расширять только по найденному риску.
5. Зафиксировать supported tuple census из P08/P09: Darwin x64/ARM64, Windows
   x64/ARM64 и Linux x64 в пределах существующей provider delivery. Linux ARM64
   не возникает автоматически; отсутствующий baseline tuple не объявляется новым
   обещанием, заявленный tuple нельзя исключить из обязательной строки из-за FAIL.
   Existing `opencode-native-windows-e2e.yml` заявляет ARM64 только для V2;
   runner `windows-11-arm` сам по себе не доказывает V1/Claude/Codex compatibility.

### B. Подготовить данные старого приложения

1. В disposable TEST HOME/project запустить зафиксированный старый frontend/runtime.
2. Через существующий UI создать saved team, выполнить короткую задачу/сообщение,
   получить Review change, остановить команду и закрыть приложение.
3. Сохранить минимальный очищенный corpus: необходимые team/session/config/Review
   файлы, версия producer и checksum; исключить secrets и данные реальных проектов.
4. Отдельно получить interrupted/UNKNOWN case в управляемом sandbox, если он
   затрагивается новой реализацией. Не редактировать JSON так, чтобы выдать
   синтетическую запись за фактически созданное старым приложением состояние.
5. Сохранить отдельный Stage 1 Darwin v1/v2 capture corpus: raw bytes/checksums,
   processRef и producer SHA. Cold read новым decoder не перезаписывает его;
   новые platform fields применяются только к новым captures.

### C. Выполнить upgrade/recovery journeys

1. На копии corpus открыть новый frontend; проверить saved teams/history/models.
2. Импортировать остановленную команду штатным путём и запустить новый Host run.
3. Проверить task/message/attachment identity, Review history и настройки.
4. Сделать обычный Quit; после старта прочитать историю без нового model request.
5. Выполнить Resume там, где он поддерживался; убедиться в отсутствии дубликатов
   задач, сообщений, login operations и scheduled side effects.
6. В отдельном запуске оборвать подтверждение одной принятой операции, перезапустить
   процесс и проверить readback/reconcile. Не отправлять её повторно автоматически.
7. Для M19-04 разорвать границу после durable requested, но до native signal.
   Lookup оставляет живой original и ноль новых attempts; явный Stop retry создаёт
   связанный intent P09 и один attempt. Повтор этого commandId не сигналит снова.
   Проверить same-live, absent/stale replacement и unregister без подмены этой
   истории Windows crash, который уже уничтожил весь kill-on-close provider Job.

### D. Проверить собранное приложение на затронутых OS

1. Использовать существующие native jobs и сборку приложения с точными dependencies.
2. Для каждой обязательной provider/platform строки выполнить короткую сквозную цепочку:
   обнаружение runtime → Launch → native tool → Stop → холодное чтение истории.
3. На Windows отдельно выполнить Claude/Codex/V1 из P08, а не только V2.
4. На Windows/Linux выполнить Process registry/health/Stop из P09, включая
   выживание чужого процесса и доказанное завершение принадлежащих потомков.
   Windows service Stop сохраняет provider session и соседний service; остановка
   всего provider Job не принимается вместо результата одной строки Processes.
5. В полном macOS UI journey проверить новые controls P01–P07; на других OS
   повторить платформенно зависимые controls, OAuth callback/device flow,
   installer и сохранение путей. Не умножать все pure UI cases на все tuples.
6. Визуально просмотреть screenshots новых состояний: прогресс, cancel, ошибка,
   повторная попытка, отключённое действительно неподдержанное действие.
7. Для каждого исходного UI control нужна соответствующая Desktop evidence строка.
   Headless native/package PASS может закрыть kernel/adapter gate, но не UI gate;
   скриншот без native effect/readback не подтверждает сохранённую функциональность.

### E. Подключить сценарии к реальным CI jobs

Новые modes ниже — предлагаемая реализация, а не уже работающие проверки.
`desktop-proof-mode.ts` и `ci.yml:stage1-desktop` расширяются одним владельцем;
наличие helper-файла без mode/job и receipt не закрывает строку приёмки.

| Existing workflow/job | Минимальное расширение и runners |
| --- | --- |
| `ci.yml / stage1-desktop` | Добавить `native-account-login-ui`, `native-provider-settings-ui`, `native-schedule-ui`; расширить `native-conversation-ui`, включить existing `skills-ui`/`native-extensions-ui` по затронутым controls. macOS ARM runner: `CI_MACOS_ARM_RUNNER` либо `macos-15` |
| `opencode-v2-stage1-preflight.yml / embedded-v2-native-host` | Добавить P08 actual launcher/custody и P09 service cases к existing native fixture; Windows `windows-2022`/`windows-11-arm`, Linux `ubuntu-24.04`; focused Darwin regression `macos-15`/`macos-15-intel`. Нынешний V2 PASS не распространяется на другие providers |
| `sentry-owned-process-native.yml / native` | Переиспользовать genuine Node/Electron broker gates на `windows-2022`/`windows-11-arm`; Host session/service proof проверять отдельно, без второй копии broker suite |
| `electron-packaged-ci.yml / packaged-smoke` | На одном candidate build на tuple выполнить bounded P08/P09 UI/native steps; сохранить пять existing tuples и `packaged-full-gate`. Darwin ARM: `CI_MACOS_ARM_RUNNER` либо `namespace-profile-macos-15`; x64: `macos-15-intel`; Windows как выше; Linux: `CI_LINUX_RUNNER` либо `ubicloud-standard-4` |
| `ci.yml / retained-opencode-coexistence` | Existing Ubuntu `ubuntu-24.04` Electron/Xvfb proof закрывает A10-08 после нужного расширения; второй coexistence runner не нужен |
| `ci.yml / stage1-process-qualification` | Existing macOS process/packed lane — Darwin regression; `stage1-process-diagnostic` остаётся unqualified, Windows/Linux им не закрываются |

Для промежуточных PR использовать штатный draft feedback и targeted native lanes.
Manual `ci.yml` dispatch с `stage1_desktop`/`stage1_process_qualification` запускает full scope:
`ci-change-scope.mts:collectChangeScope` не классифицирует dispatch как focused.
Если нужен отдельный запуск, добавить bounded dispatch/selection в existing native workflow;
у preflight/packaged workflows сейчас такого dispatch нет. Required final gates не ослаблять.
`Full qualification` не зависит от `stage1-desktop`/`stage1-process-qualification`:
в финальной таблице требовать их exact-SHA results отдельно от общего gate.
Автовключение source Desktop привязано к ready PR/base Stage 1; проверить условие для parity PR.

## 5. Минимальные группы E2E и собственные acceptance IDs

| Группа / IDs | Общий запуск и reuse | Обязательный наблюдаемый результат |
| --- | --- | --- |
| Accounts: P01/P02 | Общие UI startup/storage/reconnect helpers; browser/device/key остаются отдельными protocol cases | Actual controls → исходная операция → native/account readback; effect count, cancel/fence и отсутствие secrets |
| Selection/config: P05/P06/P07; A10-02 | Settings → selection/config → probe → save/default → Launch → restart; параллельно старый active run | Новый launch получает выбранную revision; активный run сохраняет binding; auth cases ссылаются на P01/P02 |
| Conversation/extensions: P03/P07; A10-03 | Existing composer/skills/extensions helpers, task/DM/attachment → native tool → Quit/readback/Resume | Исходные IDs/bytes и эффект доступны без повторного inference; compact/live control доказан следующим native turn |
| Schedules: P04 | Existing task-board/create-launch helpers, Run now live/stopped/task-first, один реальный cron tick | Одна owned task/launch, корректный linked history; busy/cancel/lost ACK не создают повторный effect |
| Upgrade/recovery: A10-01/04/05/08 | Old corpus/import и existing Review, Quit, retained coexistence jobs; общий cold-readback helper | Original bytes/hash/ref; Read/Edit/Keep/Reject/Undo/Redo сохранены; старый owner/сосед жив; ACK recovery не повторяет effect |
| Platform happy path: P08 W01/02/04/07/08, P09 M19-01/08; A10-06 | Один packaged artifact на tuple: Launch/tool → register → UI Stop service → Stop provider → cold readback | После service Stop provider/сосед живы; после provider Stop owned дерево отсутствует; exact ABI без checkout; Resume сохраняет history |
| Native failure boundaries: P08 W03/05/06, P09 M19-02–07 | Existing native/controlled fixtures, targeted OS cases без всех сочетаний моделей/controls | Admission до execution, service scope, stale identity и explicit linked retry; original attempts и foreign neighbors наблюдаются OS средствами |

A10-07 — один existing HTTP adapter smoke, только если соответствующий общий use case изменён.
Группировка объединяет setup/build/readback, но не удаляет failure assertions P01–P09.
Cancel-before-allocation и cleanup active child, effect-before-ACK и requested-before-native,
service Stop и provider Job kill остаются разными границами. M19-04 требует explicit linked retry.
Provider-specific receipts принадлежат своим планам; P10 ссылается на них без второй копии сценария.

## 6. Точечные тесты и бюджет

Новые unit-тесты по умолчанию не нужны. Если E2E выявит ошибку чистого decoder,
identity/dedupe или правила восстановления, добавить минимальный regression case
рядом с исправляемым кодом. Не тестировать mock call order, каждый receipt mapper
или наличие строк в исходнике. Для link/checksum проверки документов достаточно
разового проверочного скрипта, не нового обязательного suite.
Расширять existing input-ledger/receipt/fencing и config/path/native-Job suites;
новый domain-binding case нужен только для отличающегося владельца/опасной границы.
Не повторять одинаковый contract test в IPC, RPC, receipt и UI наборах.

Оценка новых/существенно изменённых строк:

- production: **500–1 500 резерв исправлений**, без переписывания работающего ядра;
- интеграционные/E2E helpers, CI wiring и scenarios: **900–1 600**, включая portable
  Desktop glue; native provider/service fixtures уже учитываются в P08/P09 и не суммируются здесь;
- units: **0–100** только при выявленном конкретном опасном инварианте;
- сложность: **7/10**, ожидаемая надёжность решения после приёмки: **8/10**,
  уверенность оценки объёма: **6/10**.

Эти числа — ориентир планирования, не цель по строкам и не вероятность отсутствия
багов. Повторные матрицы оправданы изменённым native контрактом или конкретной
оставшейся регрессией; ожидание runner само по себе не повод для перезапуска.
Исправления linked retry и Windows admission уже учтены в P08/P09; этот резерв
не начисляется повторно за их реализацию, а покрывает ещё не найденные regressions.

## 7. Зависимости, review и критерии завершения

P10 исполняется частями после готовности вертикальных срезов P01–P09. Общую
CI-композицию и acceptance manifest изменяет координатор, чтобы параллельные
авторы не размножали jobs или разные версии одного fixture. Сценарии, доступные
до завершения зависимостей, выполняются сразу в sandbox.

Финальная запись содержит exact SHA, package/runtime versions, OS, scenario IDs,
результат каждого обязательного job, original receipt/screenshots и cleanup.
Матрица фиксирует фактические native/desktop qualification отдельно и границы
vendor inference/auth. Early vertical receipts сохраняются как диагностика;
финальная обязательная строка относится к проверяемому integration SHA/artifact.
Для identity/recovery нужны original captures, before/after OS observations и число
native attempts; зелёный UI/агрегатор или отсутствие строки не заменяют эти данные.
Не считать queued/running/skipped успехом. Vendor login без test account остаётся
отдельным непроверенным свойством; сначала проверить доступные штатные test routes
и выполнить остальную работу, а не останавливать весь план заранее.
Открытые gates после review: actual Codex browser/device vendor login; native inventory
спорных P03/P07 controls; baseline provider/arch census; новые Windows/Linux UI/ownership
journeys; реальный old frontend corpus и финальные exact-SHA native/packaged results.
Review плана не закрывает ни один из этих runtime gates и не запускает дорогую матрицу до реализации.

Готовность: все обязательные истории проходят, обнаруженные дефекты исправлены,
existing controls сохранены, независимое ревью текущего diff закрыто. PR остаётся
в пределах Stage 1; merge в `main`, релиз и переключение default не выполняются.

| Круг | Реальное замечание | Исправление / статус |
| --- | --- | --- |
| R1 | Предыдущая оценка смешивала новые features и резерв дефектов, а также native package proof и полный UI | Резерв выделен; сценарии разделены; existing harness переиспользуется; unit-бюджет сокращён до конкретных регрессий |
| R1 | Полная матрица каждого control на каждой OS избыточна | Полный representative UI + native platform-sensitive subset; матрица расширяется по конкретному риску |
| R2 | Native/package receipt мог быть использован вместо Desktop UI evidence | В обязательной таблице разделены evidence kind и provider/launcher tuple; обе стороны UI → native → persistence доказаны |
| R2 | Same-live requested-before-native оставался за общей фразой recovery | P09 M19-04 включён как обязательный linked-intent gate; lookup/duplicate retry не дают дополнительных attempts |
| R2 | Upgrade проверял значения, но не старые serialized identities | Добавлен отдельный Stage 1 Darwin corpus с неизменными bytes/hash/processRef, без переписывания старых records |
| R2 | Непроверенная V2 capability или отсутствующая платформа могли незаметно выйти из scope | Gates P07 и baseline tuple census обязательны; offered UI gap не закрывается удалением control |
| R3 | Darwin-only harness и API/mock tests могли быть приняты за portable original UI proof | Зафиксированы hardcodes, portable lifecycle donor, actual login controls и native schedule journey |
| R3 | Named helpers не означали подключённые проверки; manual dispatch ошибочно считался focused | Указаны modes/jobs/runners, draft/targeted путь; dispatch full и отдельные Desktop/process results включены в final gate |
| R3 | Общие setup/recovery/unit и packaged builds могли повторяться во всех планах | Семь групп с reuse, один artifact на tuple, critical boundaries сохранены; unsupported ARM64/V2 возможности не выданы за baseline |

R2 reviewer: `/root/estimate_profiles_models`; исходная опубликованная ревизия
[`92d88845657e845f9b5080c1617245342c7061ab`](https://github.com/777genius/agent-teams-ai/blob/92d88845657e845f9b5080c1617245342c7061ab/docs/plans/provider-migration/frontend-parity-2026-11-12/10-acceptance-recovery.md).
Сопоставлены P06–P09 и Stage 1 `TeamProcessCommands.view/terminate/lookup`,
Windows custody и original Processes UI. Это review плана, не новая runtime-приёмка.

R3 reviewer интеграции: `/root/estimate_account_commands`; reviewed plan
[`cda065d869ccffb5930ed2a817b3e0654b00bb31`](https://github.com/777genius/agent-teams-ai/blob/cda065d869ccffb5930ed2a817b3e0654b00bb31/docs/plans/provider-migration/frontend-parity-2026-11-12/10-acceptance-recovery.md).
Проверены P01–P10, actual `desktop-proof-mode.ts`, перечисленные harness и workflow jobs,
`ci-feedback.mts`/`ci-change-scope.mts`. R3 относится к интеграции тестов, не заменяет ревью auth implementation.
Основания CI: [actual jobs/needs](https://github.com/777genius/agent-teams-ai/blob/cda065d869ccffb5930ed2a817b3e0654b00bb31/.github/workflows/ci.yml),
[dispatch scope](https://github.com/777genius/agent-teams-ai/blob/cda065d869ccffb5930ed2a817b3e0654b00bb31/scripts/ci/ci-change-scope.mts),
[portable lifecycle donor](https://github.com/777genius/agent-teams-ai/blob/cda065d869ccffb5930ed2a817b3e0654b00bb31/scripts/e2e/teams-create-page-desktop.mjs).

## 8. Точечные исправления qualification, 2026-11-13

Full-root typecheck на `61bcc71785bc23aeabb3a9a288fdb6a001c6ac16`
([job131636340469](https://github.com/777genius/agent-teams-ai/actions/runs/43349349197/job/131636340469))
нашёл два type-boundary дефекта: inferred optional undefined в schedule Host reply и cast неполного
Electron IPC test port. Исправление задаёт прежний JsonValue return явно и сужает registration port
до уже используемого `Pick<IpcMain, 'handle'>`; runtime behavior и existing tests не меняются.
Независимое source review выполнено; свежий compiler result пока не получен из-за недоступного executor.

Для V2 native failures существующий bounded passive trace дополняется завершением finite log body,
безопасным enum content encoding и изменением количества TEST model requests. Он не пишет native
bytes/headers/credentials, не отправляет дополнительные запросы и не увеличивает deadlines.
Прежний diagnostic receipt не является доказательством причины задержки или прохождения E2E.

Windows static V1 cases используют прежнюю actual-OS policy nativeProcessProfile: TEST paths теперь
соответствуют текущему Host, а foreign-OS cwd по-прежнему отвергается. Production policy не изменена.

[Lint job131606204662](https://github.com/777genius/agent-teams-ai/actions/runs/43335609196/job/131606204662)
на qualification head `b54390e9844a4f868c6f460905c4d9664e1340e8` обнаружил два локальных
дефекта: лишний non-null assertion в schedule lead и вложенное присваивание promise
при подготовке OpenCode sources. Исправления сохраняют прежний выбор и один shared promise.
[Test shard4](https://github.com/777genius/agent-teams-ai/actions/runs/43335609196/job/131606204703)
нашёл3 устаревших V2 test fixtures (обязательный HOME/catalog/ready contract) и4 Codex login
failures: fixture выбирал Node26 через process.execPath, хотя CI уже подготовил Node24.21
в AGENT_BACKEND_TEST_NODE. Используется этот существующий captured runtime; Host version guard
сохранён. Исправление3 V2 сценариев идёт вместе с P02 R5, новые unit cases ради этих repairs
не добавлены. Это source-reviewed cut; новые exact-head lint/tests/native результаты ещё ожидаются.
