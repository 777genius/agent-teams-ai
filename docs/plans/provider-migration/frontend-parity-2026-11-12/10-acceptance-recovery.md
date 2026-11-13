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

## 9. R4 — настоящий donor corpus и границы импорта

### Уточнение после source audit

Сценарии B–C выполняются раздельно по фактическому владельцу данных. Зафиксированный
donor frontend — [`4a0e06277fe216d9f82dbbede362668fe46622ee`](https://github.com/777genius/agent-teams-ai/tree/4a0e06277fe216d9f82dbbede362668fe46622ee).
Его [CreateTeamDialog](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/renderer/components/team/dialogs/CreateTeamDialog.tsx)
поддерживает обычный `#launch-team` unchecked → Create. Реальные записи такого
сохранения — `team.meta.json` и `members.meta.json`, без CLI `config.json`;
[current source reader](https://github.com/777genius/agent-teams-ai/blob/1628b70e50533a80d2f9d5bc8ea6edcb08a19dda/src/features/agent-backend/main/infrastructure/stopped-import/createLegacyStoppedTeamSource.ts)
явно поддерживает этот `saved-draft` формат.

Другая граница — уже запускавшаяся команда. Donor
[TeamLaunchStateStore.markStopped](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/main/services/team/TeamLaunchStateStore.ts)
сохраняет `stopId/stoppedAt`, но не `nativeRelease`. Нынешний reader правильно
оставляет prior-native/launch данные в HOLD без original release. Отсутствие PID,
обычный stopped label, копирование backup или изменение JSON не заменяют release.
[LegacyNativeStopRelease](https://github.com/777genius/agent-teams-ai/blob/1628b70e50533a80d2f9d5bc8ea6edcb08a19dda/src/main/services/team/provisioning/LegacyNativeStopRelease.ts)
сейчас квалифицирует original Unix solo Claude; расширение на OpenCode/multi-member
не возникает автоматически из сохранённого старого файла.

| Данные / producer | Что доказываем | Existing lane |
| --- | --- | --- |
| Actual donor4a UI, Create без запуска | Settings/roster → штатный import → тот же Launch dialog; source bytes неизменны | `stage1-desktop / stopped-import-ui`, saved legacy import only |
| Actual donor4a UI, native V1 история и original Stop/Quit | Новый frontend читает прежние задачи/сообщения/native history через retained owner; cold startup не повторяет input | `retained-opencode-coexistence` |
| Current frontend, legacy owner, actual solo Claude turn и original Stop | Настоящий release → штатный import → новый Host Launch/Stop; это current-owner proof | `stopped-import-native-launch` |
| Retained Stage1 Darwin captures | Планируемый gate: raw historical bytes/hash/processRef и exact producer ещё не получены; constructed decoder cases не являются donor proof | Существующий отдельный P09/P10 capture gate |

### Первый минимальный срез: genuine saved draft в существующем UI job

1. В saved-import matrix entry подготовить отдельный чистый checkout exact donor4a
   с его frozen lockfile/toolchain. Не патчить donor source и не менять integration
   checkout. Зафиксировать commit/tree, lockfile и Electron executable digest.
   Новый runner, workflow или production API для этого не нужен.
2. Перед запуском нового frontend запустить donor в том же disposable TEST
   HOME/project/userData, который затем прочитает consumer. Descriptor нового Host
   в donor environment отсутствует. Использовать существующие captured app/CDP
   startup и cleanup primitives из `desktop-captured-app.ts`; небольшой отдельный
   producer helper владеет только этим первым app epoch. Старый и новый Main
   одновременно не работают, corpus не требует переписывать абсолютные cwd.
3. Через физические UI controls открыть Create Team, ввести уникальное имя,
   описание, cwd и участника; снять `#launch-team`, нажать Create. Читать результат
   через обычный read-only API и фактические product files. Не вызывать mutation API
   из CDP и не писать team/session/config records вручную. Донорский
   [teams-create-page-desktop.mjs](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/scripts/e2e/teams-create-page-desktop.mjs)
   даёт проверенные селекторы этого пути; его seeded team, deny-all executable,
   dev-store mutations и весь длинный suite не переносить.
4. Обычный Quit donor → подтверждённая original app absence → checksum census
   только созданных TEST team/task/attachment roots. Сохранить producer receipt,
   UI screenshots и неизменный минимальный corpus. Допустима настройка пустого TEST
   HOME, model endpoint и project files; это не основание создавать product records.
   Saved-only case требует ноль native business inputs и отсутствие native identity.
   Уточнение review: donor [`providerModelProbe.ts`](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/main/services/runtime/providerModelProbe.ts)
   использует exact `Output only the single word PONG.`, `--max-turns 1` и
   `--no-session-persistence`. Выбор cwd может успеть начать эту проверку до снятия
   Launch. В existing finite model actor разрешить этот exact single-user prompt
   только в отдельном opt-in donor epoch, максимум 8 checks; native advertised
   tool catalog допустим, ответ только text PONG, tool effects/business inputs — 0.
   После ordinary Quit и original absence закрыть приём этого epoch одноразово,
   дождаться уже принятых HTTP reads в прежнем 15s request budget и сохранить
   immutable отдельный counter. Поздний PONG отвергается. Нынешний Host OK/no-tools
   path и его отдельный максимум 8 не меняются; donor checks не выдаются за Host
   management receipts или native history.
   Donor `execCli` на POSIX создаёт detached process group: отсутствие app PGID
   не подтверждает завершение model probe. Existing read-only OS oracle фиксирует
   original selected TEST runtime executable, ancestry к original app и birth до
   Quit. Перед consumer обязательны отсутствие всех captured original identities
   и отсутствие unmatched children этого unique executable. PID/path не дают
   полномочий на cleanup; новые сигналы, повторные probe и process adoption запрещены.
5. Включить уже подготовленный Host descriptor и продолжить existing import UI:
   original Team Detail → Launch → Main import → captured Host dialog → close,
   renderer reload и lookup original import. Проверять actual saved settings/roster,
   единственную import publication и неизменные source hashes. Assertions читать
   фактические donor IDs, а не переименовывать их под synthetic fixture.
6. Существующий synthetic attachment/reference corpus оставить честно обозначенным
   отдельным доказательством этих границ. Не приписывать его сообщения, Review,
   session IDs или release настоящему donor saved draft. Первый actual corpus
   закрывает только соответствующую строку таблицы, остальные продолжаются ниже.

### Native history и current original-stop positive

Donor [runtime.lock.json](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/runtime.lock.json)
закрепляет runtime **0.0.160**. Existing
[retained inputs](https://github.com/777genius/agent-teams-ai/blob/1628b70e50533a80d2f9d5bc8ea6edcb08a19dda/scripts/legacy-agent-host/prepare-retained-opencode-coexistence.ts)
и [coexistence runner](https://github.com/777genius/agent-teams-ai/blob/1628b70e50533a80d2f9d5bc8ea6edcb08a19dda/scripts/legacy-agent-host/desktop-retained-opencode-coexistence.native.ts)
используют **0.0.158** и current frontend с legacy owner; их существующий результат
сохраняется. Он не является actual donor4a/runtime0.0.160 proof.

Следующий срез расширяет тот же retained job: отдельный actual donor epoch с
runtime0.0.160 из его lock, штатным V1 binary/config и finite model oracle; через UI
получить task/message и native history, выполнить original Stop/Quit, сохранить
exact producer/asset/bytes. После обновления проверить прежние IDs и видимую историю,
затем cold read без дополнительного inference. `startRetainedOpenCodeApp({repo})`
уже позволяет выбрать donor checkout; прежний0.0.158 corpus не заменяется. Если
payload требует source-built helper, его квалификация фиксируется отдельно и
`publishedRuntimeComplete=false` не переименовывается в release PASS.

Actual donor Review change и attachment corpus из B2 этим task/message/history
срезом ещё не закрыты. Они остаются отдельным pending пунктом до настоящего
old-frontend tool file-change/Review и сохранённых исходных attachment bytes;
synthetic fixtures не заменяют эту приёмку. Raw historical Stage1 Darwin v1/v2
captures с checksum и exact producer пока также не найдены. Первый saved-only
срез от их получения не зависит, но не объявляет их доказанными.

Для current solo-stop строки заменить именно synthetic prior-run setup новым
actual legacy Claude UI turn в current frontend до выбора Host. Original owner
выполняет Stop и сам публикует branded release. Existing import/Launch assertions
затем продолжаются без ручного `nativeRelease`, прямого native DB редактирования
или усыновления старого процесса. До этого нынешний
[prior-run fixture](https://github.com/777genius/agent-teams-ai/blob/1628b70e50533a80d2f9d5bc8ea6edcb08a19dda/scripts/legacy-agent-host/desktop-stopped-import-prior-run.ts)
с `sourceNativeInputs: 0` остаётся synthetic-record/actual-TEST-child-Stop proof.

### Recovery reuse и приёмка

Source audit P01/P04 выявил одну оставшуюся boundary. P01
`codex-login.test.ts` и `capturedCodexLogin.safe-e2e.test.ts` используют actual
Host/D, но TEST metadata peer вместо native Codex. P04
`scheduled-run-host.native.ts` доказывает actual completion → duplicate intent →
cold read/repeat, однако сначала получает original start ACK. Эти результаты
сохраняются, но не закрывают native effect-before-lost-ACK.

Добавить ровно один такой случай в existing Codex scheduled native journey:
в TEST application response adapter удержать original `schedule.run.start` reply
до независимо наблюдённого native effect, затем потерять ответ для исходного caller.
Это application-level ACK boundary: wire/server ACK уже может существовать,
но исходный application caller ещё не получил success. Не считать простое игнорирование уже полученного success потерей ACK. После
unknown выполнить original lookup, обычное закрытие Host, cold lookup и явный
same-intent retry; требовать original run/operation/input receipt, неизменный native
effect и число model/native attempts, а также ноль скрыто созданных Tasks. Finite
scheduled journey Task не создаёт; linkedTask относится к другому existing smart
journey и сюда не переносится. Нового runner, provider process, journal или общего
fault framework нет. Claude completion/replay case не дублировать. Source/CI
qualification этой границы остаётся pending до actual receipt.

Никаких новых unit suites для corpus generation. Достаточно existing source/type
gates и exact-head UI/native receipts с original cleanup, hashes, producer SHA,
runtime tuple и числом business inputs. Plan/source review не означает runtime PASS;
launched donor import без release остаётся неподдержанным данным reader, а доступ
к его сохранённой истории проверяется через прежний owner.


## 10. Current frontend: actual solo Claude Stop → import → Host Launch

Этот срез уточняет current-owner строку §9. Источник — тот же exact integration
frontend с его штатным legacy Claude owner и runtime **0.0.158**; actual donor4a
с runtime0.0.160 остаётся отдельной строкой. Ниже зафиксированы два source-review
круга; native/Desktop результат пока не получен.

### Исходный путь и минимальные изменения

- [Current Create bootstrap][C10-create] сам сохраняет team/member metadata,
  готовит deterministic bootstrap и запускает original CLI. Его
  [первый prompt][C10-prompt] содержит точный team scope; solo roster пуст.
  TEST не пишет config, launch state, session ID или native history.
- [Original Stop][C10-stop] захватывает текущий tracked run до await.
  [Publication][C10-publication] удерживает именно его child/session/owner,
  а [release capture][C10-release] требует actual original CLI release и полный
  solo census. [TeamLaunchStateStore][C10-store] публикует marker/freshness через
  этот proof. Эти production owners для acceptance не менять.
- Переиспользовать существующие `desktop-backend-smoke.ts`,
  `desktop-stopped-import-prior-run.ts`, `desktop-stopped-import-fixture.ts`,
  `desktop-stopped-import-ui-smoke.ts` и
  [`desktop-stopped-import-launch-ui.ts`][C10-tail].
  Producer — отдельная функция существующего prior-run helper, lifecycle — уже
  имеющиеся `connectCapturedDesktopApp`/`cleanupCapturedDesktopApp` и UI controls.
  Новые runner, registry, release writer, public API или общий migration framework
  не нужны. В oversized smoke оставить вызов helper без роста orchestration.
- Existing controlled TEST-child case и богатый synthetic attachment/reference
  corpus сохранить как отдельные проверки. Нынешний native-launch matrix entry
  заменить настоящим источником; `sourceNativeInputs: 0` больше не считается
  успешной проверкой этой строки.

### Порядок реализации и проверки

1. **Подготовить обычный current runtime.** В existing
   `stopped-import-native-launch` job использовать штатный
   `scripts/dev-with-runtime.mjs --print-runtime-path` и
   `scripts/lib/runtime-payload-cache.mjs`. Прочитать exact current
   `runtime.lock.json`, проверить darwin-arm64 archive SHA, полный payload,
   executable digest, Node/Electron и frontend commit/tree. Legacy orchestrator
   не подменяется Host SDK binary или donor0.0.160. Новый workflow не нужен.

2. **Один original app epoch до Host.** В том же disposable TEST
   HOME/project/userData запустить current `dev:mcp` с explicit selected legacy
   runtime и localhost inference. В этом environment нет Host descriptor.
   Producer не использует consumer deny-all executable как Claude. Допустимы
   пустые TEST каталоги, endpoint и config; product team/task/native records
   создаёт только приложение. Consumer ещё не запущен.

3. **Создать solo Team через UI и выполнить один turn.** Через existing Create
   page выбрать Claude/Sonnet4.6, low effort, cwd внутри TEST root, пустой список
   teammates, оставить Launch включённым и ввести exact finite TEST prompt.
   Нажать Create один раз. Дождаться штатного deterministic bootstrap, actual
   native request и видимого original reply. Прочитать actual team/run/session
   binding, live original process и persisted launch freshness. Пустой response,
   model-preflight PONG или один появившийся PID не квалифицируют business turn.

4. **Минимальный finite oracle в прежнем actor.** Добавить opt-in current-legacy
   phase к `startNativeTeamModel`, разрешённый только перед consumer epoch.
   Он принимает exact submitted marker внутри штатной bootstrap оболочки,
   проверяет правильный Team/solo context и отвечает одним text reply без tools.
   Число business turns — ровно 1; model-preflight checks считаются отдельно и
   используют фактический current `providerModelProbe.ts` prompt/limit.
   Advertised tool catalog не означает tool execution. Не переносить Host-only
   context/MCP receipt assertions на legacy native request и не ослаблять их.
   После source Stop/Quit/absence закрыть phase один раз, дождаться уже принятых
   reads в прежнем bounded budget; поздние requests отвергать. Host target
   сохраняет прежние 8 ordinary requests и отдельные management probes.

5. **Нажать original Stop и проверить публикацию.** Использовать existing
   Team Detail Stop control, без private mutation API из CDP. До Stop
   зафиксировать actual launch/session/root identity; после него требовать
   original child absence и штатный `readLegacyNativeStopRelease` readback.
   Target, stoppedRunId, native digest и owner incarnation должны соответствовать
   прочитанному original run. TEST не вызывает capture/complete/markStopped,
   не подставляет proof и не переписывает census. Если release отсутствует,
   сохранить exact failing facts и разбирать original owner; не переводить
   source в never-launched и не добавлять автоматический Stop retry.

6. **Сохранить небольшой настоящий corpus.** После успешного Stop создать одну
   saved Task через existing Create Task UI с запуском задачи выключенным;
   это не создаёт второго native input. Прочитать actual ID/body из продукта.
   Не добавлять придуманные comments, refs, attachments или history.
   Выполнить ordinary Quit, подтвердить captured app group и original detached
   native identities absent, затем снять bounded source hashes существующих
   team/task/attachment roots. Отсутствующие roots записывать как absent, не
   достраивать ради прежней fixture shape. Receipt содержит
   `sourceKind: actual-current-native-solo`, actual settings/task/run/release
   identities, model counters и source manifest. Source Task — доказательство
   genuine UI saved data; native-history migration этим не объявляется.

7. **Продолжить прежний consumer journey.** После полной source absence запустить
   тот же current frontend с уже подготовленным Host descriptor в том же TEST
   namespace. Original Team Detail → Launch → Main import → Host dialog.
   Адаптировать existing seed/readback только на discriminated actual-source case:
   exact saved settings, solo lead, настоящая Task, одна import publication,
   canonical Host selection и неизменные source bytes. Synthetic TaskRef/
   attachments assertions остаются в прежнем synthetic case; actual Task
   сравнивается с собственным captured body без fixture-ID подстановки.
   Закрыть dialog без Submit, reload, lookup той же import publication,
   ноль target runtime input до явного Launch.

8. **Сохранить existing native continuation.** Использовать
   `runStoppedImportLaunchUi`: original Host Launch один раз, новый run/session,
   отличный от source, прежний actual native task/tool-effect/reply oracle,
   original Stop, released custody/absence и reload saved settings. Source Task
   и manifest неизменны. Поменять только source preparation assertions и actual
   importedTask input; не добавлять ещё один agent turn или Stop retry.

9. **Проверить на прежнем gate.** Type/lint/source-closure и один existing
   fixture/oracle critical case для новой phase boundary, без новой unit suite.
   Exact-head existing macOS native-launch job требует producer PASS, 1 source
   business turn, native original release, import/readback PASS, target native
   Launch/Stop PASS и обе cleanup границы. Source/compiled inputs freeze —
   до producer, между app epochs и после consumer. Failure receipt сохраняет
   этап/finite counters/hashes без auth fields или ручного repair.
   PASS этой строки не закрывает donor4a history/Review, Windows release
   или historical Darwin capture gates.

### Два review круга и принятые сокращения

**Круг 1 — authority/source.** Проверен фактический путь Create → tracked run →
original Stop → branded release. Отвергнут перенос existing Node-child setup:
source records синтетические и `sourceNativeInputs=0`. Выбран один original app
epoch без Host descriptor; runtime определяется current lock. Нового proof
producer в production нет.

**Круг 2 — объём и oracle.** Не воспроизводить весь synthetic task/reference/
attachment corpus в native producer. Достаточно одной настоящей UI Task после
Stop и неизменной source фиксации; богатый прежний fixture остаётся отдельным.
Не создавать legacy MCP tool scenario ради release: один finite text turn
подтверждает native путь, existing Host continuation уже проверяет tools/effects.
Не дублировать app lifecycle, процессы, queues, Stop или retries. Parent/peer
review плана, implementation и actual exact-head результат ещё обязательны.

[C10-create]: https://github.com/777genius/agent-teams-ai/blob/1628b70e50533a80d2f9d5bc8ea6edcb08a19dda/src/main/services/team/provisioning/TeamProvisioningCreateDeterministicSpawnFlow.ts
[C10-prompt]: https://github.com/777genius/agent-teams-ai/blob/1628b70e50533a80d2f9d5bc8ea6edcb08a19dda/src/main/services/team/provisioning/TeamProvisioningRosterPrompt.ts
[C10-stop]: https://github.com/777genius/agent-teams-ai/blob/1628b70e50533a80d2f9d5bc8ea6edcb08a19dda/src/main/services/team/provisioning/TeamProvisioningStopCleanupCompatibilityFacade.ts
[C10-publication]: https://github.com/777genius/agent-teams-ai/blob/1628b70e50533a80d2f9d5bc8ea6edcb08a19dda/src/main/services/team/provisioning/LegacyNativeStopPublication.ts
[C10-release]: https://github.com/777genius/agent-teams-ai/blob/1628b70e50533a80d2f9d5bc8ea6edcb08a19dda/src/main/services/team/provisioning/LegacyNativeStopRelease.ts
[C10-store]: https://github.com/777genius/agent-teams-ai/blob/1628b70e50533a80d2f9d5bc8ea6edcb08a19dda/src/main/services/team/TeamLaunchStateStore.ts
[C10-tail]: https://github.com/777genius/agent-teams-ai/blob/1628b70e50533a80d2f9d5bc8ea6edcb08a19dda/scripts/legacy-agent-host/desktop-stopped-import-launch-ui.ts

## 11. Original Task hover после Complete: bounded UI prerequisite

Actual `f2050de7e2bf52feb695393cb4dc07d1c0ee8d9a`,
[job131695834133](https://github.com/777genius/agent-teams-ai/actions/runs/43367646201/job/131695834133):
Create/assignee, один drag, original blocked Start rejection, Complete исходного
blocker и ровно один dependency-resolved comment прошли. Следующее открытие
toolbar dependent Task остановилось на original read deadline. Official artifact
`14010798529`, ZIP SHA256
`46655a8e764e353915ea807fca36049355297726bb20b309bd1b0aab1fe2446e`
содержит original receipts, trusted input events и screenshot; это failure,
не проход всей Task board.

[Нынешний hoverCard](https://github.com/777genius/agent-teams-ai/blob/f2050de7e2bf52feb695393cb4dc07d1c0ee8d9a/scripts/legacy-agent-host/desktop-task-board-ui-smoke.ts)
после canonical Complete сразу измеряет один DOM point и отправляет один move.
Canonical receipt ещё не означает завершение renderer layout.
[Existing click helper](https://github.com/777genius/agent-teams-ai/blob/f2050de7e2bf52feb695393cb4dc07d1c0ee8d9a/scripts/legacy-agent-host/desktop-ui-controls.ts)
уже проверяет current target при изменении geometry. В данном failure исходные
hover coordinates не сохранены, поэтому точная причина отсутствия toolbar
пока не доказана; production Kanban/Radix менять по предположению нельзя.

### Минимальный следующий срез

1. В existing `desktop-ui-controls.ts` добавить узкий `hoverExpression`:
   readonly original expression, прежний один 30s deadline, три последовательных
   одинаковых eligible points. Между reads используется существующий 100ms
   cadence; unavailable point сбрасывает стабильность. Это не новый sleep или
   продление ожидания.
2. После стабилизации проверить captured renderer и отправить ровно один
   physical `mouseMoved`, сохранив его actual point в прежнем step receipt.
   Не нажимать control, не вызывать app handler/DOM dispatch, не повторять
   неизвестный effect и не менять выбранную Task.
3. В `hoverCard` заменить только прежний lookup+move. Existing outside move,
   один Escape, exact original Task ID/title, единственный open toolbar,
   canonical dependency assertions и оригинальные Start/Complete clicks сохранить.
   Source cap800 соблюдается без минификации или сжатия существующего кода.
4. Один critical case в existing `desktop-team-ui-smoke.test.ts` проверяет
   shifted/unavailable target, возврат стабильности и единственный move в
   окончательную исходную geometry. Новая unit suite не нужна.
5. Types/lint/source cap и existing UI-helper tests; затем тот же actual macOS
   Task board job. Пока original toolbar, второй Start, attachments/reload и
   cleanup не PASS, строка остаётся INCOMPLETE. При новом failure original
   target в receipt позволит сопоставить move с фактическим layout; не делать
   timer bump, click retry или скрытый app-state repair.

### Review круги

**Круг 1 — evidence.** Artifact подтверждает работу canonical graph/Complete,
но не причину hover failure. Изменение ограничено отсутствующим UI prerequisite
и сохранением исходной точки; regression production-кода не объявлена.

**Круг 2 — минимальность и полномочия.** Existing shared TEST helper и существующий
test file; один original input, прежние budgets и все semantic assertions.
Не добавляются новая gesture abstraction, retry queue, generic framework,
renderer state writes или отдельный CI job. Независимый source review и
actual exact-head результат обязательны перед закрытием этой строки.


## 12. Обязательный результат выбранного CI сценария и ограниченный native log

Qualification PR1187: `PRRT_kwDORVTEtM622BTZ`, `PRRT_kwDORVTEtM624t0Y`.

1. В `.github/workflows/ci.yml` включить `codex-login-desktop` в dependencies
   `full-qualification`. Проверка требует именно success, когда исходный job
   выбран своим существующим predicate (ready same-repository PR, parity head/base,
   не metadata-only). Для остальных PR skipped остаётся допустимым.
   Повторить ровно этот predicate в aggregate gate; не менять required branch
   protections, job selection, timeouts или трактовку cancelled/failure.
2. Existing finite native schedule step должен ограничивать output во время
   выполнения, а не только проверять размер уже записанного файла.
   Использовать встроенный bounded child-process capture с прежним timeout и
   exact executable/arguments; ограниченный partial log сохранить даже при overflow.
   Overflow/error/timeout проваливают step. Не вводить общий runner, не сигналить
   чужие PID и не перенаправлять unlimited stdout/stderr в файл.
3. Сверить существующие workflow validation/tests для selected/skipped/failure gate;
   native schedule proof обязан остаться тем же. Exact-head native/Desktop CI
   завершает приёмку, локальный YAML parse её не заменяет.
4. Thread `PRRT_kwDORVTEtM622BTf`: Linux fixture выбирает actual `process.execPath`,
   но descriptor вне V2 ещё записывает fixed24.21.0. Использовать `process.version`
   ровно при выборе current executable (Linux или source V2); candidate оставляет
   свою attested version, Darwin fixed-path — свой pin. CI остаётся на Node24.21.0;
   это согласование identity, а не смена native qualification runtime.

Круг source: job predicate и aggregate needs сверены отдельно; действующий provider
archive verifier уже читает actual package pin, старый archive не возвращается.
Круг architecture: два изменения существующего workflow, без нового job/framework.
Следующий круг — независимое review diff и существующие CI policy checks.

## 13. Невалидный Launch prompt до durable intent

PR1186 `PRRT_kwDORVTEtM622S1B`: NUL отвергается поздним Team text validator,
но incoming Launch может сначала сохранить intent, который затем невозможно восстановить.

1. Отвергать NUL в трёх существующих incoming boundaries:
   Main `teamOperationValues.ts`, Host `executeTeamLaunch.ts` schema и
   `TeamLaunchOwner.ts` до записи intent. Сохранить текущие trim/length правила.
2. Не переписывать исторические launch records и не менять durable format.
   Валидный повтор того же intent ID после отказа должен работать, потому что
   invalid input не создал ни record, ни native allocation.
3. Расширить existing Launch owner/RPC case одной NUL попыткой и valid retry;
   проверить отсутствие native work и сохранённых данных при первом отказе.
   Не создавать отдельный validator framework или набор tests на каждый символ.

Круг source: поздняя ошибка сопоставлена с точкой publication.
Круг architecture: локальные проверки на существующих границах; новые DTO/ledger не нужны.
После независимого review — targeted existing Launch integration и exact-head CI.

## 14. Actual import producers: однозначный Create и единственный CDP аргумент

Evidence на head `522c80d168d698fc6842ee649cc4822406cd2632`, run `43373956602`:

- Job `131717484585`, artifact `14014741097` (ZIP SHA256
  `a9a7c9cbda946b9a4a155139bc4ec3a19a32cd9729e36fb41b0503e742bb3046`):
  current native source не дошёл до Create: lookup нашёл две видимые `Create Team`.
  Actual current `TeamListView` одновременно рисует header action и `TeamEmptyState`.
  Existing TEST helper верно отказал неоднозначному target.
- Job `131717484767`, artifact `14014198411` (ZIP SHA256
  `d99bdf92f73a68d2c4811d6d84227bbb8066e4eda82b897765e7a1e9a9d01348`):
  synthetic stopped-import фаза PASS, отдельный genuine donor producer INCOMPLETE.
  Его invocation передал `--remoteDebuggingPort 9222` дважды; immutable donor package
  уже включает этот аргумент в `dev:mcp`. Log сообщает listener49626, harness ожидает9222.
  Это подтверждённое несоответствие запуска; новый actual run нужен для полного причинного proof.

### Source cut

1. В existing `desktop-create-config-ui-smoke.ts` выбрать original header Create по
   `div.mb-4 > div > div > button.gap-2` и точному тексту. Эта структура сверена с
   [current header](https://github.com/777genius/agent-teams-ai/blob/f0c769140bc7f6e4154ddad11a03e84b67bd1e94/src/renderer/components/team/TeamListView.tsx)
   и [donor header](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/renderer/components/team/TeamListHeader.tsx).
   Экспортировать только одну константу selector и переиспользовать её в
   `desktop-donor-saved-producer.ts`. Не выбирать first-match и не ослаблять
   exact-one/visible/hit-target проверки existing controls; пользовательский click остаётся один.
2. `captureDonorSavedInputs` сверяет exact `package.json::scripts.dev:mcp` с
   выбранным TEST CDP port. Producer вызывает этот оригинальный script без повторного
   добавления того же аргумента. Source/lock старого приложения не меняются.
   Сохраняются occupied-port refusal, exact original listener/process-group/birth,
   renderer ownership и cleanup guard. Не искать произвольный доступный listener
   и не прикрепляться к чужому экземпляру.
3. Перенос ограничен тремя существующими TEST files. Проверить scripts types,
   lint/diff и existing UI controls tests. Для смены selector/argv не создавать
   отдельные unit suites, зеркалящие строковые литералы.
4. Следующий обычный actual macOS job должен пройти current Create→native turn→Stop→Task→Quit
   и отдельно old donor Save→Quit→immutable corpus→current Import. Пока одна из этих
   цепочек или native absence не завершена, acceptance остаётся INCOMPLETE.

Круг1: artifacts сопоставлены с точными current/donor источниками, два симптома не объединены
с ошибкой native Claude `/review` из другого job. Круг2: существующие controls/producer
и исходные бюджеты сохраняются, production UI не меняется. Круг3: independent source
review и exact-head CI обязательны; green локальный helper не заменяет настоящий Desktop.

**R3 source cut:** Account независимо сверил оба реальных header и immutable donor script: PASS.
Root scripts types, fast lint и24 existing UI/lifecycle tests — PASS (11 cold V2 +13 shared UI).
Source сохраняет original controls, однократные inputs и listener/cleanup gates.
Actual current-source Stop/Task/import и donor Save/import ещё ждут следующего штатного CI.

## 15. Actual 3db Desktop failures: сохранить первую причину и счётчик cold preflight

На head `3db75ad8b323bede28d92c99c6d8eb1defb50f1b`,
[run43386943005](https://github.com/777genius/agent-teams-ai/actions/runs/43386943005):

- mixed V2 job131757637314 дошёл через native inputs, Restart и Stop/reload до
  `desktop-mixed-create-launch-ui-smoke.ts:572`; failed assertion требует ровно
  один свежий Claude model probe. Log не показывает actual count. Artifact14020282276,
  ZIP SHA256 `a6383077eee7f6e16a3c8f6c89b13ecca44e5142072532f3f3465dfb29d53c3f`.
- current stopped-source job131757637350 завершился assertion на
  `produceDesktopCurrentStoppedTeam` status=INCOMPLETE. Его finally записывает
  original failure в receipt, но следующий status assert заменяет исходную ошибку
  в CI log. Artifact14019894208, ZIP SHA256
  `887a2c5822ada55345a344154627e9e980f8d72da7e37feac711db167dc6e3ab`.
  Содержимое этих ZIP пока не прочитано; причина каждого product/test отказа
  неизвестна, одно падение не объясняет другое.

### Круг1 — минимальная диагностическая поправка существующих TEST owners

1. В mixed smoke оставить прежний один click, original 90s poll и exact count+1.
   Только если этот poll бросил ошибку, вывести один закрытый JSON record:
   исходный baseline, observed count, capped список новых probe phase/model/effort
   и число пропущенных записей. Эти факты уже есть у original TEST model owner;
   никаких новых model requests, UI clicks, Host RPC, source reads или retry.
   Одновременно сохранить тот же record в существующем proof. Исходную ошибку
   бросить дальше без изменения. При PASS output и приёмка остаются прежними.
2. В current stopped producer сохранить статусный finally assert и все original
   Stop, absence, Quit, source-frozen и cleanup проверки. Сообщение assert должно
   включать ограниченные original failure/freezeFailure (не больше1000 символов
   каждая) и count-only cleanup facts из уже полученных результатов:
   remaining process count/null, cleanupFailure boolean, remaining native count,
   unmatched selected executable count. Не читать log/receipt повторно, не делать
   новый process census ради диагностики, не сигналить процесс и не менять статус.
   Использовать уже сохранённый nativeChildrenAfterCleanup snapshot.
3. Оба изменения только в двух existing TEST files. Нового диагностического
   framework, workflow row, таймера и unit suite для строковых сообщений нет.
   Проверить точные source preimages, независимый diff review, scripts types и
   существующие CI jobs. Immutable readback не заменяет исполнение.

### Круг2 — строгие границы следующего actual run

Ни одного failure не переводить в PASS по новой диагностике. Mixed по-прежнему
требует ровно один cold probe с исходными model/effort, неизменное количество
business inputs и все физические cleanup witnesses. Stopped import допускается
только после PASS настоящего source producer. Артефакты остаются первичными,
bounded log projection лишь сохраняет причину в штатном failure output.
После следующего необходимого source cut разобрать факты и исправить установленную
причину; не перезапускать тот же head вслепую и не увеличивать бюджеты.

Круг3: root сверил оба места с exact3db; production changes0, weakened gates0.
Следующий шаг — independent review малого diff и exact-head CI. Новые bytes пока
не исполнялись.

## 16. Actual235 stopped import: finite current-frontend model catalog route

[Run43394002053/job131780548904](https://github.com/777genius/agent-teams-ai/actions/runs/43394002053/job/131780548904)
сохранил первую причину: local model oracle получил GET при требовании POST.
Original source frozen=true, cleanupFailed=false, remaining/nativeRemaining/unmatched=0.
Это не PASS импорта: source producer по-прежнему INCOMPLETE, consumer не квалифицирован.

Круг1 — source contract. `src/main/utils/anthropicApiKeyVerification.ts`
(`2a4c10b94594c51b42ad1bbd6140b6248de7473d`) использует GET /v1/models;
existing `scripts/e2e/anthropic-compatible-status/default-model-gateway.ts`
также обслуживает этот read-only route. Current producer задаёт отдельный
`TEST-current-legacy-only-key` и local origin. Actual log пока не содержит URL:
маршрут /v1/models — source-backed объяснение, проверяемое следующим exact run.

Круг2 — узкий TEST oracle. В existing native-claude-team/model.ts только при
исходном открытом `currentLegacySource` обслужить exact GET /v1/models с исходным
synthetic x-api-key. JSON содержит фиксированные TEST-supported Claude model IDs;
никаких prompt/tool/native effect, редиректов или vendor authentication.
Отдельный конечный счётчик не более8 catalog reads сохраняется в frozen source
receipt рядом с существующими probe/token counts. Это не расходует и не расширяет
один business turn, native model-probe8/9 или существующие request deadlines.
После закрытия original source epoch, при другом path/key/method и превышении
счётчика остаётся failure; закрытый oracle после protocol failure не открывается.
Не обслуживать произвольный GET и не снимать прежний exact POST/messages contract.

Круг3 — existing `native-claude-team/model.test.ts` case дополнить одним catalog
read, проверкой frozen count и отказом позднего catalog read. Existing одна
source turn, PONG/Host probe, closed source rejection и cleanup сохраняются.
Independent source review + focused tests/types и следующий original Desktop
source Stop → Task → Quit → import → native Launch обязательны. Source review
не заменяет исполнение; никаких повторов старого head или расширения таймеров.

## 17. Actual235 mixed Stop/reload: closed observation of original Launch refusal

[Job131780548934](https://github.com/777genius/agent-teams-ai/actions/runs/43394002053/job/131780548934)
дал baseline8/observed8/probes[]: новая model request не поступила.
Причина находится до inference. Не заменять исходное требование count+1 нулём
и не объявлять выбранную модель проверенной по прежнему запуску.

Круг1: source `useHostTeamResume.ts` допускает fresh preflight после чтения
original Resume/launch/checkpoint status; `LaunchTeamDialog.tsx` также ждёт saved
hydration. Из одного model count нельзя отличить checkpoint-generation refusal,
unresolved Resume, saved-source error и незавершённую hydration.

Круг2: только в существующем failure catch mixed smoke добавить один read-only
CDP snapshot исходного dialog. Закрытая проекция: dialog count, видимость known
controls, disabled состояния, выбранный fresh/resume и список фиксированных
reason IDs по exact known UI messages. Не выводить DOM/text, пользовательские
данные, paths, arbitrary errors или новые API/RPC reads; не нажимать контролы.
Использовать existing bounded CDP request; если чтение недоступно, записать только
unavailable и бросить первоначальный poll error. Original90s poll, один Launch
click, model count+1, model/effort, input counts и physical cleanup неизменны.

Круг3: source/peer review закрытой проекции, existing scripts types и тот же
native mixed Desktop job. Не писать отдельную unit suite для diagnostic strings.
Следующий production/oracle fix выбирать по этому original evidence; не вводить
retry, fallback на global model/новую Team или silent Fresh Launch.

## 18. Actual235 draft Launch: preserve unconfirmed Create result

[Validate job131783882257](https://github.com/777genius/agent-teams-ai/actions/runs/43394002053/job/131783882257)
обнаружил TypeScript refusal в `src/main/ipc/teams.ts:2320`: draft Launch штатно
вызывает `createTeam` и возвращает его результат без преобразования, но
`TeamCreateResponse.launchStatus` после P06§17 включает `unconfirmed`, а
`TeamLaunchResponse` в `src/shared/types/team.ts:945` ещё нет.

### Круг1 — граница результата и потребители

Сохранить точный additive status. Он сообщает, что Team сохранена, а исходный
Launch не подтверждён; он не является ни `started`, ни доказательством отсутствия
native allocation. Draft IPC уже возвращает полный response; HTTP draft route
`src/main/http/teams.ts:383–418` делает то же. Не вводить cast, удаление status,
переписывание runId или повторный create/launch.

Текущий Host Create UI уже обрабатывает этот результат:
`createHostTeamFromDialog.ts:35` не начинает polling, а
`TeamListView.tsx:1040` открывает сохранённую canonical Team после пояснения.
Обычный Host Launch в `createHostTeamLaunchSubmission.ts:43–51` возвращает
started только после исходного capture/start, иначе отказывает; его native
semantics не меняются. Legacy draft producer сейчас сам unconfirmed не создаёт,
но общий публичный Launch contract должен честно принимать результат той Create
операции, которую его handler вызывает.

### Круг2 — минимальная связанная правка

В shared `TeamLaunchResponse.launchStatus` добавить уже существующее значение
unconfirmed. Сохранить все прежние значения, поля и canonical TeamCreate result.
Не создавать отдельный status framework или новую transport DTO.

В существующем `teamSlice.launchTeam` после API response и **до** регистрации
response.runId, optimistic progress promotion и первого getProvisioningStatus
обработать unconfirmed через существующий error/attempt cleanup: сохранить
понятное сообщение «Team saved; launch not confirmed; check this team before
launching again». Не утверждать завершение/отсутствие запуска, не регистрировать
подтверждённый runtime, не запускать polling или автоматический retry. Текущая
Team уже является адресатом Launch, поэтому новое Create/navigation действие
не требуется. Существующие attempt/epoch guards в catch сохраняют более новый
запуск; весь Host Create путь с canonical navigation остаётся прежним.

### Круг3 — существующие critical cases

В имеющемся draft IPC case в `test/main/ipc/teams.test.ts` проверить точную
передачу исходного Create response с unconfirmed через TEAM_LAUNCH, сохранив все
assertions saved metadata и однократного create вместо launch. В существующем
`test/renderer/store/teamSlice.test.ts` дополнить ближайший failure/attempt case:
response unconfirmed показывает честный refusal, снимает только свой optimistic
pending, не публикует response run как running, не делает getStatus/poll/retry.
Прежний started response и newer-attempt fence остаются покрыты существующими
сценариями. Новых suites, harness, native inputs или CI jobs нет.

Focused Main/renderer types и эти существующие cases, затем required validate
того же source cut. Независимый source review обязателен. Этот compile/consumer
fix не объясняет отдельный native /review marker loss и не закрывает его E2E.

## 19. Saved donor Create: select the original field before inserting once

Actual235 job `131780548921`, artifact `14023589292` (ZIP SHA256
`b8d8dafd3926d56f21cebbb3e0b9c0969e1fb489e18c43c31e42867382ab07e7`),
failed at `donor unique name retained`. Original donor source remained frozen;
the generated TEST name is 29 valid characters. This failure happened before
Create, ordinary Quit/corpus qualification or the consumer. The receipt does not
retain the failed input value, so do not label a particular resulting value as observed.

### R1 — existing editing protocol reference

`desktop-donor-saved-producer.ts:186–206` sends the Meta+A key event without
the explicit CDP `commands: ['selectAll']` used by the existing passed
`desktop-create-config-ui-smoke.ts:222–229`,
`desktop-stopped-import-launch-ui.ts:99–106` and mixed Create fill helper.
The donor frontend supplies a suggested initial name in its controlled input;
typing into that existing value requires selecting it first.

### R2 — minimal TEST correction

Add the same explicit editing command to the original single keyDown. Before
the original single `Input.insertText`, read once that the exact original field
is focused and its full value is selected (selectionStart zero and selectionEnd
equal to its actual value length). Refuse before text mutation if that proof is
absent. Retain the keyUp, the one text insertion and the existing exact retained
value assertion. Do not set the DOM value, invoke React/store/IPC setters, retype,
repeat clicks, replace the donor frontend or extend its existing deadline.
The normal user-input route and original saved-team capture remain the acceptance proof.

### R3 — verification

Independent source review should compare the same CDP command in the existing
working fill helpers, and ensure the extra evaluation is read-only and precedes
the one insertion. Run existing Host-script types, then the original saved-only
donor/consumer E2E on the new exact head. Keep the prior run INCOMPLETE; require
ordinary original Quit/absence, frozen corpus and consumer cold readback before
counting this route as passed. No new unit suite or synthetic donor is needed.

### §18 source-cap refinement: существующий loader параметров Launch

Локальный integrated Main/renderer прогон завершился 530/530 PASS, но обычный
source-size guard обнаружил `teamSlice.ts`5024 при сохранённом baseline5020:
четыре новые строки unconfirmed guard превысили лимит. Этот gate остаётся
обязательным; предыдущий PASS тестов не заменяет source-size проверку.

Круг1 — существующая граница: `teamSlice.ts:1723–1753` содержит цельный
`loadAllLaunchParams`, использующий только localStorage, private
`LAUNCH_PARAMS_PREFIX` и `TeamLaunchParams`. Уже существующий
`store/team/teamLaunchParams.ts` владеет теми же параметрами и их сохранением.
Перенести туда loader и его prefix, экспортировать функцию и импортировать
её в прежний блок teamSlice. Новый helper-файл/owner или общий abstraction
не нужен; тело loader переносится без изменения ветвей и порядка чтений.

Круг2 — поведения: вызов остаётся в прежней инициализации
`launchParamsByTeam: loadAllLaunchParams()`; import не читает localStorage.
Сохраняются best-effort отдельные corrupt-entry/storage catches, original keys
и прежние данные. Unconfirmed guard остаётся непосредственно после Launch IPC
до responseRunId/analytics/promotion/poll; attempt-fenced catch и вся
launch/create логика не перемещаются. Не сжимать код, не удалять пустые строки
ради счётчика и не менять baseline.

Круг3 — без новых тестов: existing teamSlice case уже проверяет восстановление
valid saved params рядом с corrupt entry, а §18 cases проверяют unconfirmed,
обычный Launch и newer-attempt cleanup. Повторить затронутый existing renderer
file, types и прежний source-size guard после переноса. Исходный 530 PASS
относится к pre-extraction bytes; отдельного native input или CI job не добавлять.


## 20. Actual donor catalogue request keeps its original source epoch

### Round1 — exact evidence and source

On d35, saved-only job131818772468/artifact14027459003 now passed the single
name insertion and failed waiting for Sonnet4.6. The unchanged donor source
remained frozen. Its model receipt records GET rejected by the POST assertion,
with zero inference requests; the original URL was not retained, so its exact
bytes are not claimed as observed.

Pinned donor runtime source
[anthropicCatalog.ts](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/services/runtimeBackends/anthropicCatalog.ts)
blob `adec3f0b3655f691c0efa87ae0910e7e7625a707` defines limit1000 and calls
Axios GET `/v1/models` with that sole query parameter. Its configured localhost
compatible branch returns an empty degraded catalogue on refusal. The shared
frontend key verifier (same blob `2a4c10b94594c51b42ad1bbd6140b6248de7473d`
in donor/current frontend) separately requests the exact no-query path.
This source chain explains the missing catalogue without changing the donor UI.

### Round2 — two finite request forms, original authority

In existing native Claude TEST model, permit only GET `/v1/models` and
GET `/v1/models?limit=1000` while exactly one original producer epoch is open.
For donorSavedProbes require its existing `TEST-donor-saved-only-key`; for
currentLegacySource require its existing `TEST-current-legacy-only-key`.
Keep at most8 catalogue requests for that producer, the exact finite two-model
response, no pagination, and the existing first-failure seal. Other methods,
paths, queries and keys remain rejected. This adds the original donor catalogue
read, never a model input, a native tool, or a successful account claim.

The mutually exclusive epochs already have pending-read counters and close
barriers. Keep them and all original POST/PONG/business-input limits unchanged;
after ordinary producer Quit/absence and epoch close, neither catalogue route
may reopen. Do not alter application provider selection, catalogues, permissions,
UI selectors, time bounds or donor bytes.

### Round3 — essential checks and real acceptance

Extend the existing current-legacy oracle case with the query form, and add one
small actual-HTTP donor-epoch case in the same existing test file: finite list,
original PONG, close, then catalogue refusal with no native business turn.
Run that existing file and Host-script types. Independent source review checks
the two exact URLs and producer-specific keys before publishing the source cut.
The existing saved-only Desktop donor/import/cold-readback gate remains required;
the prior INCOMPLETE run is never relabelled as a success.

## 21. Mixed cold Launch: finite evidence at the original failed boundary

### Round1 — separate the observed failure from a proposed cause

On d35 both original mixed Desktop jobs131818772113 (V1) and131818772401
(V2) completed the native three-provider journey and Stop, then failed the
same cold Launch assertion: Claude probe baseline8, observed8, no new probe.
The V1 retained artifact shows one newly running OpenCode probe journal entry
with held resources and no model-oracle rejection. This is not evidence that
no work was admitted. It does not prove a queue deadlock or identify the native
operation that stopped progressing. The V2 synchronous guard correction in
P07 cannot by itself explain the same V1 result.

Source review confirms Host work handlers run concurrently, model-probe start
returns after journal admission, and Main routing has no per-Team serial queue.
The existing cold check still requires one fresh Claude probe and all original
UI/readback assertions. Neither its90s deadline nor the fixture input allowance
is changed; a prior successful probe cannot be relabelled as cold acceptance.

### Round2 — one failure-only TEST projection

Extend only `desktop-mixed-create-launch-ui-smoke.ts` at its existing cold
preflight catch. Keep the original error and cleanup. Read the original TEST
`hoststore/management-commands` namespace once; this is a diagnostic snapshot,
not an atomic observation, authorization, recovery, or an alternate journal.

- Bound directory entries to256 and retained model-probe rows to64. Open
  regular JSON files with no-follow and read at most64KiB plus one byte;
  oversize, malformed, replaced or unreadable data yields a closed
  `unavailable` diagnostic, never proof of absence.
- Keep only existing Team-probe records and the three fixed TEST provider IDs.
  Project the file's SHA-shaped opaque name, provider, finite phase, boolean
  resourceHeld/ok and integer expiry relative to the original failure time.
  Never serialize raw records, paths, environments, credentials, error text,
  model content or arbitrary provider values.
- Add the existing three model-oracle probe counts to the same original
  failure log/receipt. No new RPC, process census, CDP input, signal, native
  request, retry, selected profile change or attempt is introduced.
- No reads occur on the success path or before the original failed assertion.
  A diagnostic failure remains distinguishable from an empty original journal.

### Round3 — review and delivery

Review the bounded read and strict output projection independently, then run
the existing script type gate and both original mixed Desktop jobs on the
next required exact source cut. No extra unit suite or CI job is added for
this read-only failure metadata. Keep d35 INCOMPLETE and use the next actual
journal/native evidence to choose the production correction; do not adjust
guards, accept cached checks, or increase deadlines on a timing hypothesis.


## 22. Packaged V2: self-contained TEST harness и официальный ESM jsonc-parser

**Круг 1 — actual failure.** На parity d35 packaged workflow43405509695
все пять platform jobs отказали при загрузке TEST harness, до native scenario.
Root прочитал exact logs Linux131825045057, Darwin arm64131825044798 и
Windows x64131825044892: одинаковый dynamic require("./impl/format") из
jsonc-parser3.3.1/lib/umd/main.js. Исходный process exit1 без native receipt
сохраняет cleanup unconfirmed, а disposable checkout остаётся relocated;
последующий artifact upload поэтому тоже отказывает. Это не доказательство
native Host failure или cleanup success. Исходные receipts/stack сохраняются.

[Official jsonc-parser3.3.1 manifest](https://github.com/microsoft/node-jsonc-parser/blob/v3.3.1/package.json)
задаёт main=lib/umd/main.js и module=lib/esm/main.js; оба принадлежат одному
установленному pinned package. Source src/main.ts содержит обычные static
imports impl/format, edit, scanner, parser. Existing staging esbuild настроен
на platform=node/format=esm, поэтому package main выбрал UMD wrapper с
dynamic require, который не является self-contained runtime import в этом
ESM artifact.

**Круг 2 — один существующий TEST staging file.** В
scripts/legacy-agent-host/stage-opencode-v2-packaged.ts (base
a155a3a9e1d8466b4f91ec83c0fd6bbe4916604c) добавить esbuild alias только для
jsonc-parser на require.resolve('jsonc-parser/lib/esm/main.js') из того же
installed package. Reuse existing createRequire; без замены package/version,
global mainFields preference, CJS runtime shim, внешнего require или доступа
к hidden source checkout. Обычные static imports входят в тот же bundle;
its actual harness hash автоматически фиксируется прежним candidate manifest.
Production modules, actual app.asar/Host/native capture и dependency lock
не меняются. Не ослаблять source relocation либо unconfirmed cleanup rule.

**Круг 3 — проверка.** Root commit/push этого append до one-file source edit.
Independent source peer сверяет official package exports/paths и ограниченный
alias scope. Existing staging types и все пять actual packaged gates должны
загрузить именно собранный harness и затем пройти прежние11 model requests,
manual approval, MCP/tools, Stop/cold Resume и original cleanup. Один import
fix или source review не объявляются packaged PASS. Новой unit suite, runner,
workflow, native invocation или увеличенного budget нет; source пока unexecuted.

## 23. P7 controlled Processes: честная fixture без teammate Runtime (план, 2026-11-13)

### Круг 1 — исходное падение и причина

На exact parity [9ea802cc](https://github.com/777genius/agent-teams-ai/tree/9ea802cc0f8c873c8349512cb010fe54e34fdd70) job131868952619 сначала завершил исходный P7 и его три проверки, затем controlled cold UI остановился **до Electron UI**. Original small artifact14033996423, ZIP SHA256 `78ace845f45d0774a6f3e84c97b926dee8c2c80877ac96a418b26a7714e9728f`, извлечён и проверен. В original root `TEST-desktop-backend-UuN7E0` Host A handshake/process.list и EOF exit0 прошли; failure — `no Runtime session store was allocated`. Original process cleanup PASS, все три original captures absent; это не PASS для cold UI.

[desktop-controlled-process-fixture.ts](https://github.com/777genius/agent-teams-ai/blob/9ea802cc0f8c873c8349512cb010fe54e34fdd70/scripts/legacy-agent-host/desktop-controlled-process-fixture.ts) удалял только `profile.runtime` **после** [prepareProcessFixture](https://github.com/777genius/agent-teams-ai/blob/9ea802cc0f8c873c8349512cb010fe54e34fdd70/scripts/legacy-agent-host/desktop-native-process-fixture.ts) и первого canonical Team seed. При этом persisted Alice по-прежнему имела complete `delivery`. Исправленная P06 presence в `TeamRuntimeRegistration.hasRetained` обязана считать такую binding native history и сохранять Runtime owner. Удалять этот product guard или принимать выделенный Runtime за отсутствие нельзя.

### Круг 2 — минимальная коррекция двух TEST файлов

1. В existing `prepareProcessFixture` добавить один explicit TEST-only option `controlledServicesOnly: true`. Default native SDK mode не менять. Для этого режима, **до первого createFilesystemTeamOwner/Task seed**, проверить отсутствие owner namespace новой TEST team, убрать `profile.runtime` и delivery bindings у её начальных saved members. Это подготовка нового controlled service sandbox; retained product records и чужие scopes не редактируются.
2. Existing controlled caller выбирает этот option при исходном prepare. Удалить его позднее повторное переписывание profile/descriptor/pins; вместо него подтвердить уже подготовленный profile без runtime/delivery. Общая fixture один раз публикует окончательные profile/descriptor hashes до первого Host.
3. Оставить исходный `noRuntime` assertion именно на отсутствии runtime-sessions, все source/artifact hashes, original root/registrar captures, Host A→B restart, processRef Stop, neighbor alive, original911 freeze и cleanup. Никакого SDK/model input, нового native target, timeout, retry, fake Stop или ослабленного oracle.
4. Изменения только `scripts/legacy-agent-host/desktop-native-process-fixture.ts` и `desktop-controlled-process-fixture.ts`. Native child §52 changes в последнем файле сохранить при parent sync; не заменить child blob целиком старой родительской версией.

### Круг 3 — проверка

Независимо проверить порядок: base fixture с `seedUiTask:false` ещё не создаёт Team owner; controlled narrowing precedes seed/persistence; обычный native mode сохраняет delivery и runtime. Выполнить pinned Host build, existing relevant presence tests и scripts typecheck; исходный Darwin ARM controlled cold UI должен пройти на новом normal CI. Linux checks не подменяют native Darwin proof. Новая unit suite для fixture не нужна; ключевой behavioral oracle уже находится в исходном e2e.


## 24. Genuine saved donor: preserve the compatible catalogue's omitted effort

### Round 1 — actual failure and original feature contract

The verified 9ea donor artifact 14032984581 (original TEST scope 2Y4MTI)
remains INCOMPLETE: after selecting the Sonnet 4.6 option the existing
producer timed out waiting for `donor Low effort`. Original cleanup and
source-freeze observations are retained. This is not evidence that a Low
choice was supported or that any saved Team was produced.

The pinned producer deliberately uses its captured localhost
`ANTHROPIC_BASE_URL`. In runtime0.0.160 source
[`anthropicCatalog.ts`](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/services/runtimeBackends/anthropicCatalog.ts),
`buildAnthropicCompatibleRuntimeModelCatalogFromApiModels` unconditionally
returns `supportedReasoningEfforts:[]`, `defaultReasoningEffort:null`
and `supportsFastMode:false` for those API models. Adding invented
capabilities to the existing GET response would not enable Low.

Exact donor4a
[`teamEffortOptions.ts`](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/renderer/utils/teamEffortOptions.ts)
honours that selected catalogue entry; `LeadModelRow` gives the original
control id `lead-effort`, and `EffortLevelSelector` renders one disabled
`Not supported` button. `CreateTeamDialog` maps the empty supported
selection to undefined. `TeamMetaStore.serializeMeta` and the existing
JSON serializer omit undefined effort. No production default or native
model capability is inferred from the TEST server's model name.

### Round 2 — the existing genuine journey follows that contract

1. In `desktop-donor-saved-producer.ts`, replace only the two impossible
   Low UI operations with the existing bounded read-only `waitRead`:
   the exact original Create page's `#lead-effort` must be an actual
   disabled button with text `Not supported`. Keep the same Sonnet
   selection and subsequent ordinary Add member/Save actions. Do not
   click another effort, synthesize state, alter the donor checkout,
   catalogue, settings, CLI or saved source. No new request/input, retry
   or timer is introduced.
2. In `desktop-donor-saved-fixture.ts`, require
   `Object.hasOwn(meta,'effort') === false` instead of Low. All other
   expected original settings/roster, saved-only classification, exact
   file hashes, no-native-history and original cleanup checks remain.
   The corpus is captured from genuine saved bytes without rewriting.
3. In `desktop-donor-saved-import-ui.ts`, explicitly require the same
   omitted effort in imported `owner.savedSettings`, in addition to
   existing exact saved-field/member comparisons. The current captured
   Claude recipe has no explicit effort; existing saved-model compilation
   and `assertStoppedImportModelChecks` therefore continue to require the
   original undefined effort in both durable probe receipts and actual
   request observations. Do not accept Low/default aliases or silently
   normalize a later unexpected request.
4. Extend only the existing stopped-import model-check case to exercise
   this undefined selection and reject an unexpected explicit effort.
   Preserve its current Low coverage and the separate synthetic rich
   saved-settings corpus. This genuine compatible-catalogue case does
   not qualify a nondefault effort on an old native catalogue that
   advertises it; those are distinct acceptance claims.

### Round 3 — review, essential verification and actual acceptance

Review the exact original catalogue/UI/serialization chain and the narrow
three TEST-source changes independently. Run the existing script type
gate and stopped-import fixture case, then use the next already required
saved-donor Desktop gate with its original source pins, finite probe
counts, no-tools model checks and cleanup budgets. A source-derived
correction or controlled case is not genuine donor PASS. Successful
acceptance still requires ordinary old Save, immutable actual files,
ordinary current import/preflight, close/reload and original lookup.
No production change, new suite, runner, dependency, capability or
timeout is planned.

## 25. Packaged cancellation: defer unused canonical source schemas

### Круг 1 — exact failure

На parity9ea packaged Linux job131881379726, Windows x64 job131881379799
и Darwin ARM job131881380047 падают в трёх existing cancellation cases
до TEST-injected-harness-failure. Tiny tracked TEST checkout импортирует
native-host.ts только ради runner helpers. R20 добавил его eager import
compiled composition/runtimeSourceContracts.js; этот намеренно маленький
checkout не содержит Host dist и не запускает Host. Это import closure
ошибка тестовой инфраструктуры, не результат packaged native journey.

### Круг 2 — один TEST helper, прежняя строгая проверка

В packages/legacy-agent-host/tests/fixtures/native-host.ts переместить
тот же canonical schema import в существующую async rpc ветку успешного
runtime.source ответа. Использовать awaited dynamic import с прежним
literal path; те же summary/publication schemas и switch по всем method
остаются обязательными до возврата ответа. Ошибка import/parse должна
отклонить исходный rpc. Не копировать schemas, не подменять модуль,
не ослаблять DTO или allowlist, не добавлять dependencies в tiny checkout.
Существующий esbuild bundle включает literal dynamic import; отсутствие
Host dist у runner-only клиента перестаёт мешать неиспользуемому пути.

### Круг 3 — минимальная проверка

Независимый peer проверяет async границу и все canonical parses. Затем
original packaged-opencode-v2-inputs.test.ts под pinned Node24.21 должен
дойти до своих исходных clean-error/timeout-clean/unknown assertions:
source hidden, exact original cleanup and restoration/retention. Scripts
types и существующий runtime source RPC case проверяют оставшийся путь.
Никакого нового запуска provider, retry, timeout, source-isolation exception
или дополнительной suite. Полный packaged matrix всё ещё обязателен.

## 26. Skills composition: unresolved Trash must retain shutdown debt

### Круг 1 — воспроизведённое несоответствие ожидания

Actual parity9ea test shard1 job131875733988 имеет единственное падение
в test/capturedSkills.test.ts:1054. Тот же existing composition case
локально воспроизведён на Node26.12.1. Case намеренно только stage-ит
оригинальный Trash, подтверждает held receipt, busy credentials и lookup
без nativeTrash dispatch; OS callback и finishTrash никогда не выполняются.
ProviderManagementCoordinator.close теперь правильно отказывает held,
пока durable original row.resourceHeld=true. Успешный close здесь означал
бы потерю неразрешённого долга. Не менять этот production guard.

### Круг 2 — тот же existing case, явная исходная неопределённость

Перед seal/close сохранить точные original journal row/bytes и проверить
его skill.mutation/trash identity, original commandId, held public receipt
и resourceHeld=true. В finally ожидать именно OpenCodeManagementError
с code=held, затем сравнить исходный durable row/bytes без изменений.
Не вызывать shell Trash/finishTrash, не выдавать fake nativeCompleted,
не освобождать резерв и не поглощать произвольную ошибку. Остальные
существующие assertions и finally cleanup тестового sandbox сохраняются.

### Круг 3 — essential verification

Peer сверяет отсутствие product изменений и маскировки прежних отказов.
Прогнать весь существующий capturedSkills.test.ts, чтобы ordinary success,
unknown callback, retained identity и no-repeat поведения остались.
Targeted types/fast lint плюс штатный shard1 нужны отдельно; локальный
контролируемый case не объявляет actual OS Trash или полный E2E PASS.
