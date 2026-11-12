# 04. Расписания для команд, обслуживаемых Host

Статус: план после R2; production не менялся, one-shot/native-limits gate ещё не закрыт.
Frontend baseline: `4a0e06277fe216d9f82dbbede362668fe46622ee`.
Stage 1 baseline: `1d0f97f55de566036c970eab4f36b84620afdb3f`.
Цель: сохранить нынешние schedule controls и режимы выполнения при выбранном Host.
Новый scheduler, отдельная очередь заданий и фоновый daemon не требуются.
R2 source refs: old runtime `e13edcd3d4ffbecc0272ae30195cc6b15b710ee7`; provider D `d58500bc983e897506e23d7b0bc8da1209864edd`.

## 1. Baseline и подтверждённая потеря функции

- В разделе команды есть создание/редактирование расписания, timezone/cron, pause/resume, Run now и история запусков.
- [Main: `ScheduleSection`](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/renderer/components/team/schedule/ScheduleSection.tsx).
- `SchedulerService` владеет Croner jobs, warm-up, concurrency, retry policy, run history и stop barrier.
- [Main: `SchedulerService`](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/main/services/schedule/SchedulerService.ts).
- `SmartScheduleDispatcher` уже реализует live-team dispatch, stopped-team launch и opt-in task-first.
- [Main: `SmartScheduleDispatcher`](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/main/services/schedule/SmartScheduleDispatcher.ts).
- `createSchedulerService` собирает dispatcher из узких runtime/task/provisioning API; новый runtime owner не нужен.
- [Main: `createSchedulerService`](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/main/services/schedule/createSchedulerService.ts).
- Legacy JSON без executionMode сохраняет one-shot поведение; smart agent/team режимы имеют другую retry policy.
- Offline non-lead agent без task-first сейчас явно не запускается как случайный standalone lead; это ограничение сохраняется.
- Task-first сохраняет task до launch, использует runId как command identity и не повторяет исторический launch prompt.
- [Main: smart schedule integration tests](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/test/main/services/schedule/SmartSchedules.safe-e2e.test.ts).
- В Stage 1 guard `assertSupportedScheduledTeam` отвергает Host create/update/resume/trigger; cron execution также закрыт.
- `SmartScheduleDispatcher.dispatch` дополнительно возвращает skip для Host selection key, UI Add disabled.
- [Stage 1: `SchedulerService` guard](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/src/main/services/schedule/SchedulerService.ts).
- [Stage 1: `ScheduleSection` Host restriction](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/src/renderer/components/team/schedule/ScheduleSection.tsx).
- Current tests подтверждают корректный отказ Host, а не успешное выполнение Host schedule.

### Уточнённая граница current UI

- `LaunchTeamDialog` создаёт новые schedules с task-first; legacy/non-task-first one-shot сохраняется при редактировании old records.
- OpenCode one-shot **явно disabled** в selector с `team only`; normal whole-team/live/task-first OpenCode пути обязательны.
- [Main: actual schedule form](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/renderer/components/team/dialogs/LaunchTeamDialog.tsx).
- [Main: explicit one-shot restriction](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/renderer/components/team/dialogs/TeamModelSelector.tsx).
- `ScheduledTaskExecutor` выбирает Codex/Gemini либо Anthropic; неизвестный OpenCode config сейчас не является working OpenCode execution.
- [Main: actual one-shot executor/limits](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/main/services/schedule/ScheduledTaskExecutor.ts).
- UI limits относятся к one-shot; обычная board-task/team dispatch не получает искусственный budget из скрытого default `maxTurns=50`.
- Для Claude native `--max-turns`/`--max-budget-usd` уже допускаются D `captureClaudeExtraArgs`; сначала reuse, не новый limit framework.
- [D: admitted native limit flags](https://github.com/agent-teams-ai/old-provider-implementations/blob/d58500bc983e897506e23d7b0bc8da1209864edd/packages/provider-implementations/src/features/provider-session-implementation/adapters/provider-session-io/extra-argv.ts).
- Old Codex-native branch выходит до общего limit loop и не передаёт maxTurns/budget в `executeCodexNativeTurn`: CLI flag сам по себе не доказывает enforcement.
- [Old: exact Codex branch / common limits](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/QueryEngine.ts).
- **04-G1:** в exact old/new one-shot fixture вызвать tool loop и low budget для Claude/Codex; записать actual terminal/result и cleanup.
- Для Codex visible-but-ignored limit до реализации выбрать доказанный native enforcement либо явную capability ошибку/недоступность поля; не заявлять лимит применённым молча.
- **04-G2:** подтвердить finite Host one-shot owner, запрет вмешательства в team session и native no-persistence semantics; это отсутствующий seam, не готовый `task.start`.

## 2. User stories и критерии результата

1. Пользователь создаёт и редактирует расписание Host-команды в прежнем UI; next run соответствует cron/timezone.
2. Run now и плановый tick используют одинаковый dispatch path и исходную identity запуска.
3. Живой выбранный agent получает одну задачу; task-first сохраняет busy/outstanding-task skip, обычный режим — прежнюю task admission policy.
4. Whole-team schedule запускает остановленную настроенную команду с прежней семантикой instructions.
5. Task-first сначала создаёт видимую board task, затем bootstrap-only launch и start выбранного владельца.
6. Повторный tick при незавершённой task-first задаче сохраняет ссылку на неё и не создаёт новую.
7. Pause останавливает будущие occurrences; delete/quit отдельно отменяют принадлежащий scheduler one-shot и закрывают следующий dispatch.
8. После restart история остаётся связанной с исходной задачей/командой; неизвестный ACK не означает повтор launch/task write.
9. Удалённая команда, сменённый backend и недействительная profile revision дают объяснимый skip/failure, без запуска другого target.
10. Существующие legacy schedules продолжают читаться и исполняться по старому пути.

## 3. Минимальная архитектура

- Переиспользовать `SchedulerService`, `SmartScheduleDispatcher`, `JsonScheduleRepository`, cron timing и UI целиком.
- Добавить Host реализацию `SmartScheduleRuntimePort` в main composition; legacy adapter оставить рабочим.
- Выбор adapter выполняется по устойчивой backend/team identity, не по случайному текущему открытому UI tab.
- Сохраняемый schedule ссылается на стабильный logical target, а не на истёкший renderer selection handle.
- При occurrence Main берёт team/run/member binding из existing owner router/registry; 06 даёт только выбранную immutable profile revision.
- Опубликованный run сохраняет captured target/operation identity до любого native effect.
- Future occurrence может получить актуальную разрешённую configuration; уже начатый run на неё не переносится.
- Сохранить различие baseline: one-shot использует schedule launchConfig, team launch — разрешённый saved team request.
- Для Host readiness использовать authoritative runtime projection; отсутствие legacy PID не означает «агент не готов».
- Существующие Host task/launch/start/lookup commands обеспечивают mutation identity; нового schedule command engine нет.
- Run history хранит связь с task/command receipt и краткое состояние, не копию полного Host event store.
- Статусы `dispatched`, `skipped`, `failed` не превращаются в доказательство завершения моделью работы.
- Budget/turn limits проверяются только для реально предлагаемых one-shot paths; 04-G1 закрывает native enforcement/видимый mismatch.

## 4. Реализация по шагам

### Шаг A — contract и durable target

- В `src/shared/types/schedule.ts` добавить optional backend-target reference и минимальные run correlation fields.
- Использовать `BackendOwnerRouter.createHandle/readHandle` и `FileHandleBindingStore` для Main-owned background binding; не создавать второй owner registry.
- Schedule хранит logical owner/team target; run — его original captured binding. Чужой active renderer handle не становится scheduler authority.
- 06 предоставляет profile revision/retention; логическую schedule identity и run correlation оформляет этот план.
- `JsonScheduleRepository` читает old records без нового обязательного поля; read не переписывает их автоматически.
- Для сохранённого Host record без recoverable target разрешить просмотр/pause/delete, а выполнение требует явного корректного rebind.
- `createSchedule`/`updateSchedule` валидируют выбранный target и разрешённый executionMode до сохранения.
- Смена настроек расписания влияет на будущие occurrences; текущий run продолжает original binding.

### Шаг B — адаптер к готовому dispatcher

- В `createSchedulerService.ts` подключить новый `HostSmartScheduleRuntimeAdapter` через небольшую dependency injection.
- Предлагаемое место adapter: `src/features/agent-backend/main/adapters/output/HostSmartScheduleRuntimeAdapter.ts`.
- Сделать existing `isTeamAlive/isTeamLaunching/isTeamBusy/hasActiveOwnedTask` awaitable и обновить все dispatcher checks; legacy booleans тоже awaitable.
- Host читает authoritative projection через existing queries; не создавать второй sync cache, polling loop или выдуманный PID.
- Реализовать saved request/member statuses/lead/task/previous runs; повторная проверка original generation остаётся у existing mutation owner.
- Writes идут через existing Host task.create/start/launch/attach; каждый effect получает отдельный стабильный commandId из runId + operation.
- Сохранить task-create ID=runId где это требуется legacy; launch/start IDs отличны, чтобы один ledger ID не столкнулся с другим fingerprint.
- При потерянном create ACK восстановить linkedTaskId из original command receipt, а не считать taskId равным runId без доказательства.
- `readyMember` в dispatcher заменить/дополнить узким capability/readiness port, сохранив legacy PID правила своего adapter.
- Smart modes сохраняют отсутствие отдельного one-shot warm-up; legacy Host one-shot проверяет captured readiness без ambient provisioning.
- Для old/offline-lead one-shot выделить узкий `execute/cancel/cancelAll` port вместо concrete executor type, сохранив legacy implementation.
- Host finite adapter переиспользует RuntimeOwner/DriverHost/custody с отдельным schedule-run binding; не запускает существующего lead и не создаёт скрытую board task.
- После 04-G2 согласовать только необходимый private operation/ephemeral profile seam; original Runtime input ledger владеет effect/lookup/close.
- Claude limits передавать через уже admitted captured args; no-session-persistence/one-shot close проверить на pinned SDK, не передавать заблокированный flag обходным путём.
- Codex one-shot сохраняет prompt/model/effort/fast и actual supported limits из 04-G1; OpenCode one-shot не добавляется.
- Offline non-lead обычного режима сохраняет прежний skip; task-first идёт через выбранную team/member identity.
- Не растить `SchedulerService.ts` сверх frozen source-size limit: новый Host код живёт в adapter/helper, не в cron engine.

### Шаг C — запуск, отмена и восстановление

- Перед task/create/launch сохранить run identity и minimal captured target в existing repository.
- При каждом эффекте повторно проверить cancellation/lifecycle epoch и действительность исходного target.
- Использовать original commandId для lookup; `unknown` не обрабатывается общей execution retry веткой legacy one-shot.
- Для task-first сохранить existing outstanding-task algorithm и linkedTaskId в skipped runs при history retention.
- Если task/create outcome unknown и taskId ещё нет, следующий occurrence переносит original pending command reference и ждёт lookup; отсутствие taskId не разрешает создать новую task.
- В `recoverInterruptedScheduleRuns.ts` отличать исходный Host pending receipt от заведомо not-sent run.
- Подтверждённый original effect восстанавливать в history; незавершённость не преобразовывать в новый task/launch.
- Host one-shot без executionMode тоже исключить из blind retry при неизвестном effect; legacy retry policy не копируется по отсутствию поля.
- `SchedulerStopBarrier` остаётся единственной shutdown coordination; новый глобальный latch/таймер не добавляется.
- **Pause:** остановить будущие ticks/warm-up, текущий admitted occurrence продолжает прежнюю policy; не добавлять cancel.
- **Delete:** после durable удаления отменить scheduler-owned one-shot и закрыть дальнейшие smart effects; уже запущенную team не останавливать.
- **Quit:** закрыть admission, отменить owned one-shot, дождаться существующего stop barrier/Host custody; unknown cleanup не объявлять успешным.
- Для этих трёх действий нет нового общего cancel-поведения; тесты проверяют именно разницу baseline.
- Последующее выполнение явно использует новый occurrence, не перепроигрывает неоднозначный старый.

### Шаг D — включение existing UI и regression

- Убрать blanket Host restriction только после подключения adapter и original-target readback.
- В `ScheduleSection.tsx` показывать доступность по capability/target state; не просто убрать disabled у Add.
- Сохранить create/edit controls, timezone preview, run history, task link и прежние pause/delete подтверждения.
- Не показывать «работа выполнена» по одному launch acceptance; сохранять текущие различия run statuses.
- Проверить legacy one-shot JSON и smart legacy agent/team в том же тестовом прогоне.

## 5. E2E — главный критерий

Основа integration: `test/main/services/schedule/SmartSchedules.safe-e2e.test.ts` и реальные repository/dispatcher.
Desktop: существующие `desktop-task-board-ui-smoke.ts`, `desktop-create-launch-ui-smoke.ts`, `desktop-ui-controls.ts`.
Добавить небольшой schedule journey в существующий Desktop runner, без отдельного browser app и параллельной test platform.

| Сценарий | Пользовательский маршрут | Проверка через Host/readback |
| --- | --- | --- |
| CRUD + calendar | Создать Host schedule, timezone preview, изменить, pause/resume | Правильный persisted target/next run; pause не оставляет новый dispatch |
| Live recipient | Run now для idle agent, затем busy task-first | Одна owned task; task-first busy skip; ordinary admission сохранён, task link точен |
| Stopped team + old one-shot | Whole team; отдельно old lead one-shot Claude/Codex | Один launch; finite one-shot сохраняет selected settings/проверенные limits и cleanup; OpenCode team-only |
| Task-first | Сохранить task-first schedule, выполнить при stopped team | Task создана первой; bootstrap без replay saved prompt; нужный owner стартует один раз |
| Cron + повтор | Дождаться настоящего tick и следующего occurrence при незавершённой задаче | Нет duplicate task/launch; linkedTaskId переносится через skipped run |
| Lost ACK + restart | Потерять task/create reply до linkedTaskId; затем launch/start reply и restart | Разные original command IDs, lookup; следующий tick не создаёт duplicate даже без taskId |
| Смена/удаление target | Между capture и dispatch изменить profile/run либо удалить команду | Старый run не попадает в новый backend/member; понятный skip/held и сохранённая история |
| Pause/delete/quit + legacy | По отдельности actions во время smart/one-shot run; затем old JSON | Pause оставляет admitted run; delete отменяет owned one-shot; Quit закрывает admission/custody; team не убивается delete |

В основном E2E использовать Run now для скорости; один реальный короткий Croner tick подтверждает подключение timer→dispatcher.
Fake clock разрешён в targeted scheduler tests, но не заменяет единственный реальный schedule tick Desktop/Host.
Тесты запускаются только в новых TEST проектах с isolated storage; пользовательские команды не используются.
Receipts фиксируют scheduleId/runId/commandId, captured target, task link, effect count, terminal/unknown и cleanup.

## 6. Только критичные unit-инварианты

- Один тест раздельных runId→create/launch/start IDs, receipt binding и отказа при generation mismatch.
- Один race test cancellation/stop против admission: запрещён новый native effect после закрытия epoch.
- Один тест original-effect lookup после lost ACK и сохранения linkedTaskId при task-first history retention.
- Cron parsing, basic CRUD и существующая retry policy уже тестируются; копировать эти tests для Host не нужно.
- Capability readiness port проверяется existing dispatcher integration, без unit на каждый forwarded method.

## 7. Зависимости, оценка и риски

- Existing router/registry сохраняет team authority; 06 предоставляет profile publication/revision retention, а не второй scheduler target owner.
- План 05 предоставляет выбранные prelaunch settings/probe readiness; здесь не создаётся собственный model resolver.
- Host task/launch/start mutations остаются владельцами effects; schedule лишь решает когда вызвать их.
- Production базового smart adapter: **700–1 300** строк; finite one-shot/recovery seam: ещё **250–500**, без нового scheduler/generated code.
- E2E/fixture: **800–1 300** строк, включая actual finite one-shot; unit **100–180**, reuse existing ledger/harness.
- Неопределённый новый Codex budget enforcement не включён как обещанная capability; 04-G1 требует конкретного решения visible mismatch до implementation.
- Сложность **7/10**; ожидаемая надёжность после приёмки **8/10**; уверенность smart adapter **7/10**, one-shot seam **5/10**.
- Риски: stale renderer handle в persisted JSON, lost ACK перед записью task link, двойной effect после restart.
- Дополнительный риск: legacy PID-only readiness неверно признаёт native Host session неготовой.
- One-shot provider limits и offline routes проверяются по baseline; эта работа не расширяет ограничения провайдера до универсального enforcement.
- Готовность: CRUD и все поддержанные execution modes проходят actual Host journey, required checks успешны на exact HEAD.

## 8. Review

### R1 — авторская критика, выполнена 2026-11-12

- Найдено: снятие guard само по себе отправило бы Host selection key в legacy services.
- Исправлено: отдельный adapter и stable target contract обязательны до включения UI.
- Найдено: сохранение текущего selection handle на месяцы делает schedule зависимым от истёкшего renderer capture.
- Исправлено: schedule хранит logical target, occurrence захватывает actual generation отдельно через план 06.
- Найдено: runId как task command не гарантирует равенства фактическому Host taskId.
- Исправлено: recovery получает linkedTaskId из original receipt; lost-ACK E2E проверяет связь.
- Найдено: blanket retry после failure повторил бы accepted task/create или launch.
- Исправлено: сохранены smart-mode no-blind-retry и original receipt lookup; legacy retry policy не расширена на Host.

### R2 — независимое review, выполнено 2026-11-12

- Reviewer: `estimate_platform_acceptance`; просмотрен initial `783422b9` и actual frontend/source refs выше.
- Найдено: sync runtime predicates несовместимы с Host queries; исправлено на awaitable existing ports без нового cache и PID fiction.
- Найдено: one-shot не имеет готового Host seam; OpenCode явно disabled, Codex limit flags не доходят до native executor.
- Исправлено: actual UI/provider matrix, 04-G1/G2, finite owner reuse, отдельная оценка и отсутствие неподтверждённого four-provider promise.
- Найдено: pause/delete/quit были объединены и меняли baseline; теперь три policy и их actual effects проверяются отдельно.
- Найдено: runId нельзя использовать для всех разных mutations; потерянный create ACK оставляет outstanding task без taskId.
- Исправлено: стабильные разные effect IDs, original lookup и перенос pending reference в следующий occurrence без duplicate task.
- Найдено: 06 ошибочно считался владельцем logical team registry; исправлено на existing router/registry + profile-only dependency.
- Native gate остаётся открытым: review плана не объявляет one-shot/limit proof выполненным.

### R3 — повторное review после R2, pending

- Перепроверить lost-ACK/task-first cases и отсутствие второго scheduler/очереди.
- Убедиться, что принятие плана не зависит от отключения current UI modes или обхода profile/custody правил.
