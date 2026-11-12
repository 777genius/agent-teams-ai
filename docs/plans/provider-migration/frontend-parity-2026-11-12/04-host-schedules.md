# 04. Расписания для команд, обслуживаемых Host

Статус: план; существующие schedules, cron jobs и production-код не менялись.
Frontend baseline: `4a0e06277fe216d9f82dbbede362668fe46622ee`.
Stage 1 baseline: `1d0f97f55de566036c970eab4f36b84620afdb3f`.
Цель: сохранить нынешние schedule controls и режимы выполнения при выбранном Host.
Новый scheduler, отдельная очередь заданий и фоновый daemon не требуются.

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

## 2. User stories и критерии результата

1. Пользователь создаёт и редактирует расписание Host-команды в прежнем UI; next run соответствует cron/timezone.
2. Run now и плановый tick используют одинаковый dispatch path и исходную identity запуска.
3. Живой выбранный agent получает одну задачу; занятому agent не отправляется новая конкурирующая работа.
4. Whole-team schedule запускает остановленную настроенную команду с прежней семантикой instructions.
5. Task-first сначала создаёт видимую board task, затем bootstrap-only launch и start выбранного владельца.
6. Повторный tick при незавершённой task-first задаче сохраняет ссылку на неё и не создаёт новую.
7. Pause/delete/quit запрещает новые эффекты; начатый run доводится до наблюдаемого исхода по существующей stop policy.
8. После restart история остаётся связанной с исходной задачей/командой; неизвестный ACK не означает повтор launch/task write.
9. Удалённая команда, сменённый backend и недействительная profile revision дают объяснимый skip/failure, без запуска другого target.
10. Существующие legacy schedules продолжают читаться и исполняться по старому пути.

## 3. Минимальная архитектура

- Переиспользовать `SchedulerService`, `SmartScheduleDispatcher`, `JsonScheduleRepository`, cron timing и UI целиком.
- Добавить Host реализацию `SmartScheduleRuntimePort` в main composition; legacy adapter оставить рабочим.
- Выбор adapter выполняется по устойчивой backend/team identity, не по случайному текущему открытому UI tab.
- Сохраняемый schedule ссылается на стабильный logical target, а не на истёкший renderer selection handle.
- При каждом occurrence захватывается actual run/member generation и profile revision через общий порт плана 06.
- Опубликованный run сохраняет captured target/operation identity до любого native effect.
- Future occurrence может получить актуальную разрешённую configuration; уже начатый run на неё не переносится.
- Сохранить различие baseline: one-shot использует schedule launchConfig, team launch — разрешённый saved team request.
- Для Host readiness использовать authoritative runtime projection; отсутствие legacy PID не означает «агент не готов».
- Существующие Host task/launch/start/lookup commands обеспечивают mutation identity; нового schedule command engine нет.
- Run history хранит связь с task/command receipt и краткое состояние, не копию полного Host event store.
- Статусы `dispatched`, `skipped`, `failed` не превращаются в доказательство завершения моделью работы.
- Budget/turn limits проверяются по реальной capability выбранного execution path; не пропускать их молча.

## 4. Реализация по шагам

### Шаг A — contract и durable target

- В `src/shared/types/schedule.ts` добавить optional backend-target reference и минимальные run correlation fields.
- Формат reference и capture/restore предоставляет план 06; здесь не проектировать второй owner registry.
- `JsonScheduleRepository` читает old records без нового обязательного поля; read не переписывает их автоматически.
- Для сохранённого Host record без recoverable target разрешить просмотр/pause/delete, а выполнение требует явного корректного rebind.
- `createSchedule`/`updateSchedule` валидируют выбранный target и разрешённый executionMode до сохранения.
- Смена настроек расписания влияет на будущие occurrences; текущий run продолжает original binding.

### Шаг B — адаптер к готовому dispatcher

- В `createSchedulerService.ts` подключить новый `HostSmartScheduleRuntimeAdapter` через небольшую dependency injection.
- Предлагаемое место adapter: `src/features/agent-backend/main/adapters/output/HostSmartScheduleRuntimeAdapter.ts`.
- Реализовать existing reads: alive/launching/busy, saved request, member statuses, lead, task lookup и previous runs.
- Реализовать writes через существующие Host task.create/start/launch/attach; commandId берётся из occurrence/runId.
- При потерянном create ACK восстановить linkedTaskId из original command receipt, а не считать taskId равным runId без доказательства.
- `readyMember` в dispatcher заменить/дополнить узким capability/readiness port, сохранив legacy PID правила своего adapter.
- Warm-up для Host использует captured profile readiness; не вызывает ambient legacy provisioning для другого executable.
- Offline lead one-shot получает captured provider execution adapter и прежние limits; legacy executor не принимает Host handle.
- Offline non-lead обычного режима сохраняет прежний skip; task-first идёт через выбранную team/member identity.
- Не растить `SchedulerService.ts` сверх frozen source-size limit: новый Host код живёт в adapter/helper, не в cron engine.

### Шаг C — запуск, отмена и восстановление

- Перед task/create/launch сохранить run identity и minimal captured target в existing repository.
- При каждом эффекте повторно проверить cancellation/lifecycle epoch и действительность исходного target.
- Использовать original commandId для lookup; `unknown` не обрабатывается общей execution retry веткой legacy one-shot.
- Для task-first сохранить existing outstanding-task algorithm и linkedTaskId в skipped runs при history retention.
- В `recoverInterruptedScheduleRuns.ts` отличать исходный Host pending receipt от заведомо not-sent run.
- Подтверждённый original effect восстанавливать в history; незавершённость не преобразовывать в новый task/launch.
- `SchedulerStopBarrier` остаётся единственной shutdown coordination; новый глобальный latch/таймер не добавляется.
- Pause/delete прекращают будущий dispatch; stop уже работающей команды не добавляется как новый скрытый side effect.
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
| Live recipient | Run now для живого idle agent, затем для busy agent | Одна owned task; busy skip; task link ведёт к правильной board task |
| Stopped team | Schedule whole team для остановленной команды | Один launch с верными settings/prompt; accepted launch не назван completed task |
| Task-first | Сохранить task-first schedule, выполнить при stopped team | Task создана первой; bootstrap без replay saved prompt; нужный owner стартует один раз |
| Cron + повтор | Дождаться настоящего tick и следующего occurrence при незавершённой задаче | Нет duplicate task/launch; linkedTaskId переносится через skipped run |
| Lost ACK + restart | Прервать reply после task/create или launch, перезапустить приложение | Original lookup/readback; нет повторного native effect; history сохраняет correlation |
| Смена/удаление target | Между capture и dispatch изменить profile/run либо удалить команду | Старый run не попадает в новый backend/member; понятный skip/held и сохранённая история |
| Shutdown + legacy | Pause/delete/quit при pending run; затем загрузить old JSON schedule | Новые эффекты остановлены; cleanup известен; legacy semantics и limits сохранены |

В основном E2E использовать Run now для скорости; один реальный короткий Croner tick подтверждает подключение timer→dispatcher.
Fake clock разрешён в targeted scheduler tests, но не заменяет единственный реальный schedule tick Desktop/Host.
Тесты запускаются только в новых TEST проектах с isolated storage; пользовательские команды не используются.
Receipts фиксируют scheduleId/runId/commandId, captured target, task link, effect count, terminal/unknown и cleanup.

## 6. Только критичные unit-инварианты

- Один тест runId→commandId/receipt binding и отказа при generation mismatch.
- Один race test cancellation/stop против admission: запрещён новый native effect после закрытия epoch.
- Один тест original-effect lookup после lost ACK и сохранения linkedTaskId при task-first history retention.
- Cron parsing, basic CRUD и существующая retry policy уже тестируются; копировать эти tests для Host не нужно.
- Capability readiness port проверяется existing dispatcher integration, без unit на каждый forwarded method.

## 7. Зависимости, оценка и риски

- План 06 предоставляет stable target/capture/restore и lifecycle publication; Host scheduler adapter потребляет этот API.
- План 05 предоставляет выбранные prelaunch settings/probe readiness; здесь не создаётся собственный model resolver.
- Host task/launch/start mutations остаются владельцами effects; schedule лишь решает когда вызвать их.
- Production: **700–1 300** новых/существенно изменённых строк, без переноса существующего scheduler и generated code.
- E2E/fixture: **650–1 050** строк; unit: **120–220** строк; reuse existing harness снижает объём.
- Сложность **6/10**; ожидаемая надёжность после приёмки **8/10**; уверенность оценки **7/10**.
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

### R2 — независимое cross-review, pending

- Проверить stable-target contract с автором 06, one-shot границы, limits и stop/recovery policy.
- Reviewer фиксирует точный docs commit, находки и фактические изменения; статус не закрывается по наличию таблицы.

### R3 — повторное review после R2, pending

- Перепроверить lost-ACK/task-first cases и отсутствие второго scheduler/очереди.
- Убедиться, что принятие плана не зависит от отключения current UI modes или обхода profile/custody правил.
