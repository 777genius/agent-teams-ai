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
3. Перенос ограничен четырьмя существующими TEST files. Проверить scripts types,
   lint/diff и existing UI controls tests. Для смены selector/argv не создавать
   отдельные unit suites, зеркалящие строковые литералы.
4. Следующий обычный actual macOS job должен пройти current Create→native turn→Stop→Task→Quit
   и отдельно old donor Save→Quit→immutable corpus→current Import. Пока одна из этих
   цепочек или native absence не завершена, acceptance остаётся INCOMPLETE.

Круг1: artifacts сопоставлены с точными current/donor источниками, два симптома не объединены
с ошибкой native Claude `/review` из другого job. Круг2: существующие controls/producer
и исходные бюджеты сохраняются, production UI не меняется. Круг3: independent source
review и exact-head CI обязательны; green локальный helper не заменяет настоящий Desktop.
