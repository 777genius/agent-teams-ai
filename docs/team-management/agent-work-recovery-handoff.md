# Handoff: завершить надёжное продолжение работы агентов

Дата передачи: 2026-09-11. Реализация остановлена по просьбе пользователя. Этот документ передаёт незавершённую работу следующему исполнителю; выбор модели и инструментов свободный, специальный агентский runtime для реализации не требуется.

## Цель следующего исполнителя

Автономно довести до конца [полный план](./agent-work-recovery-implementation-plan.md), реализовать все A–E и доказать результат настоящими E2E в изолированных тестовых проектах. Не считать helpers, unit tests или уведомления достаточным завершением. Исходная проблема: runtime выглядит запущенным, задачи существуют, но работа часами не движется. Нужны безопасное ограниченное продолжение, изоляция зависших команд и видимая причина, если продолжение невозможно.

План остаётся источником требований. Этот handoff описывает фактический промежуточный результат, незавершённые места и рабочее окружение. Последние важные дополнения плана: §20.15 receipt/journal, §20.16 J1–J3, §20.17 C/D rollout, retirement retry и retention proof. Ранние заключения критика относятся только к своему узкому scope.

## Где находится код и что действительно делалось

- Основной workspace: `/Users/belief/dev/projects/agent-teams-ai/old-agent-teams-frontend`.
- Проверенная текущая ветка: `fix/dashboard-card-interactions`.
- HEAD: `56e5f886e57c39be59e922f0462ac9ded6e89819`.
- Правки этой задачи находятся в dirty working tree, включая множество untracked файлов. Отдельную локальную worktree под recovery не создавали. Локальные помощники редактировали ту же папку. Не искать готовый recovery commit в HEAD.
- Основная реализация и интеграция делались локально; тяжёлые проверки запускались через SSH на сервере. Были попытки hosted implementation jobs, но последние изменения не являются результатом законченного hosted writer. Не представлять работу как полностью выполненную на хостинге.
- Сервер: SSH alias `codex-workers-eu-01-old`; для команд использовались `-o ControlMaster=no -o ControlPath=none`.
- Проверенный machine-id: `93732118417e46618cefafc022c8b1db`.
- Remote root: `/mnt/my_first_volume_ams3_1783285769353/work-recovery-live-20260910`.
- Remote checkout: `<remote root>/storage-a`; проверенная ветка `fix/agent-work-recovery-live-a`, тот же HEAD. Это проверочная копия с накопленными dirty overlays, не отдельная готовая линия разработки для merge.
- Remote Node 24.18, pnpm 11.22, native better-sqlite3 собран. Среду перепроверить перед продолжением. Последняя проверка ресурсов: около 7.9 GiB available RAM, swap заполнен, 22 GiB свободного диска; это исторический снимок, не разрешение на любой объём параллельных процессов.
- Runtime для будущего E2E: `/Users/belief/dev/projects/claude/agent_teams_orchestrator`, исследованный SHA `3bf24764f25dfd7588b9c8b23748fa0891fd85df`. Source launcher `cli-source`. Не подменять новым architecture-only repo `/Users/belief/dev/projects/agent-teams-ai/agent-teams-orchestrator`. Текущее состояние runtime перед изменением перепроверить, подтверждённых новых runtime implementation patches здесь нет.
- В этой работе не делались commit/stage/push/release. Не переименовывать/сбрасывать общую ветку и не переносить целиком грязное дерево поверх другого workspace.

## Сохранность чужой работы и inventory

Рабочая папка сильно смешана с другими задачами: announcements, локализации, UI/runtime provider diagnostics, landing, package scripts и прочее. `git diff --stat` не показывает untracked код и не равен объёму этой задачи. Нельзя делать `git add .`, reset/clean/stash всего дерева или whole-file replacement общего `src/main/index.ts`.

Артефакты передачи находятся в [папке handoff evidence](../../.codex-reports/agent-work-recovery-handoff/):

- `worktree-inventory.json`: актуальные dirty file paths, SHA256 и строки. Это снимок состояния, НЕ доказательство ownership всех файлов.
- `untracked-paths.txt`: полный список untracked путей, включая unrelated. Нужен, чтобы не потерять новые recovery helpers при переносе.
- `journal-j1-final-tests.log`, `journal-j1-typecheck.log`: последние полученные серверные результаты.

История ownership/evidence: [progress.md](../../.codex-reports/agent-work-recovery-implementation/progress.md), соседние `*-files.json`, `*-review.md`, `*-scope.md`, `*-tests*.log`. `current-owned-manifest.json` и `execution-state.json` УСТАРЕЛИ относительно последних A6/A5/J1: не использовать как полный allowlist или актуальный статус процессов. Сравнить их с текущими files и этим handoff. Они полезны для происхождения ранних изменений.

Для нового checkout сначала сохранить точную базу и проверенный patch только нужных hunks плюс явно перечисленные untracked файлы. Если нельзя надёжно отделить mixed hunk, сохранить его как спорный и разобраться, не терять чужие изменения. Не считать один commit SHA доказательством состояния dirty overlay. При переносе между серверами использовать проверенную базу и Git bundle/контролируемый patch, не объявлять старую проверочную копию authoritative.

## Что уже реализовано: карта изменений

Все пути ниже относительно основного workspace. Для деталей читать текущий код и соответствующие tests, не воссоздавать по описанию.

### A: status authority, CAS и физическое завершение

В `src/features/member-work-sync/core/application/` появились conditional status contract и поддержка условных mutations use cases. В `main/infrastructure/` реализованы `MemberWorkSyncStatusAuthority`, status revision/version/decoder, admitted ports, preparation и JSON/SQLite CAS helpers. Revision содержит incarnation, lineage, sequence, nonce. Conflict не должен перезаписывать свежую запись; неизвестный commit не является обычным retry.

В `src/features/internal-storage/` реализованы worker interruption/retirement tracking, SQLite CAS bridge и replica continuity. Logical RPC failure отделён от физического завершения writer; deletion/restore не освобождают fence, пока writer ещё способен писать. Строгие safety reads не превращают corruption/I/O в пустое состояние.

Reconciler/Reporter/dispatcher частично переведены на conditional use-case контракт. Это НЕ означает, что normal production composition полностью активирует authority: именно сквозное wiring ещё надо закончить и доказать. Проверять полный путь consumer -> composition -> admitted port -> prepared backend -> authority -> response.

Основные доказательства: `MemberWorkSyncStatusAuthority.test.ts`, `MemberWorkSyncConditionalUseCases.test.ts`, `createAdmittedMemberWorkSyncStatusPort.test.ts`, `memberWorkSyncJsonStatusCas.test.ts`, `memberWorkSyncStatusVersion.test.ts`, `decodeMemberWorkSyncStoredStatus.test.ts`, internal-storage CAS/worker tests.

### A: import/replica/agenda

Подготовка backend, raw status revision decoding, snapshot merge и dirty continuity реализованы в `memberWorkSyncAuthorityPreparation`, `memberWorkSyncDomainSnapshotMerge`, `memberWorkSyncSnapshotMerge`, `MemberWorkSyncSqliteImporter`, `BackendSelectingMemberWorkSyncStore` и internal-storage replica helpers. Equal revision divergence отклоняется, неизвестная история не выдаётся за отсутствующую. Dirty source не может создать неподтверждённый canonical baseline.

Есть правки `TeamTaskAgendaSource`, `TeamKanbanManager` и strict task reads: неполный/error snapshot не должен разрешать новое продолжение. Сверить ранние `agenda-recovery-*`/`strict-kanban-*` evidence. Не считать legacy tolerant UI readers допустимыми safety readers.

### A6: реальный backup/restore owner

Изменены `TeamBackupService`, `TeamBackupRestoreService`, permanent-deletion coordination и добавлены helpers `TeamBackupManifest`, `TeamBackupStartupRegistry`, `TeamBackupWorkSyncRestoreCoordinator`, `TeamWorkSyncBackupRestore`, `TeamWorkSyncRestoreAttemptOwner`, `TeamWorkSyncRestorePending`, `TeamWorkSyncIdentityAccess`, `TeamWorkSyncPriorIdentity`, `TeamWorkSyncRestoreReadiness`.

Реализовано:

- strict complete startup discovery и durable publication roster под registry lock;
- durable restore pending, owned admission closure, coalesced retry;
- attempt owner удерживает identity fence/team mutex до physical settlement даже после logical interruption;
- startup продолжает здоровую B, когда A unresolved; periodic backup пропускает A до ожидания её fence и объединяет повторные ticks;
- generic restore исключает feature-owned work-sync state, import выполняется через typed participant;
- read-only backend/continuity preflight до generic config writes;
- backup A1 при живой A2 без pending даёт typed not_applicable, не ломает A2; существующий pending не стирается;
- root `.member-work-sync` входит в backup inventory; protected backup не удаляется;
- JSON restore сохраняет полный merged metrics snapshot для точного readback; обычный append сохраняет прежний cap 200;
- privileged retry инвалидирует stale preparation failure cache;
- failed/uninitialized shutdown не публикует пустой registry, поздний startup не запускает timers.

Production main wiring частично изменён: shared gate/backup создаются до initialize, feature deferred, restore participant регистрируется, после backup initialization feature стартует. `src/main/index.ts` содержит и чужую работу: редактировать только необходимые hunks, не форматировать целиком.

Actual service tests с disposable state доказывали restore, retry/new owner, pending preservation, team isolation, shutdown. Это не настоящий runtime/model E2E.

### A5: token incarnation

`HmacMemberWorkSyncReportTokenAdapter` получает mandatory trusted lifecycle identity. Secret schema2 связан с normalized team + incarnation; cache учитывает incarnation, legacy key ротируется, unknown/corrupt не подменяется свежим ключом. Отдельные policies для external backup и live old-incarnation secret при restore: последний допускается только для guarded rotation, не подписи.

`MemberWorkSyncPendingReportIntentReplayer` больше не подменяет expired fallback token свежим. Verifier выдаёт finite authenticated expiry claims после signature/binding проверки, включая expired outcome. Старый replay не получает новый lease лишь из-за восстановления API.

`test/features/member-work-sync/helpers/createTestWorkSyncIdentity.ts` используется legacy fixtures, включая существующие live suites. Это fake lifecycle identity, такие suites не доказывают настоящий recreate/restart owner protocol.

### A5: receipt foundation

`MemberWorkSyncReportReceipt` decoder и status version helper разделяют application draft и persisted receipt. Persisted `appliedStatusRevision` обязательна; authority назначает её в том же CAS, что accepted report. Draft требует совпадающий accepted report/time/team/member. Existing checkpoint переносится через обычные status mutations, omission его не удаляет.

Replacement чужого checkpoint пока закрыт до explicit journal transfer proof. Legacy blind mutation не принимает receipt draft. Exact-current persisted receipt сверяется с accepted report; historical receipt с меньшей sequence сохраняется при допустимом carry-forward. JSON/SQLite same-write stamping тестировался.

### A5: journal foundation и последний J1 patch

Новые/изменённые файлы:

- `core/application/MemberWorkSyncReportJournalPort.ts`: ensure/read/transfer, present/absent/conflict/corrupt/unavailable/write_failed/commit_unknown.
- `core/domain/MemberWorkSyncReportJournalMetadata.ts`: immutable binding и receipt decoder.
- `core/domain/MemberWorkSyncReportJournalRow.ts`: ПОСЛЕДНИЙ J1 patch, общая full-row validation до normalization.
- `main/infrastructure/JsonMemberWorkSyncReportJournal.ts`: strict canonical reports.json, existing team queue/index/member locks, durable write, retry fsync без rewrite, projectionDegraded после canonical success.
- `memberWorkSyncReportJournalMerge.ts`: immutable conflict, receipt dominance; domain/record snapshot merges проверяют одиночные bound rows, не только duplicates.
- `memberWorkSyncAuthorityPreparation.ts` и `memberWorkSyncSqliteMappers.ts`: raw ownership/incarnation/outcome validation до routing normalization. snapshotToRecords проверяет trusted team до mapper; recordsToSnapshot тоже.
- `contracts/types.ts`: optional journal metadata на report intent.
- internal-storage contracts/schema/migration/worker: nullable `journal_json`, migration v5, roundtrip, legacy append/markProcessed не меняют bound rows. Strict SQLite ensure/read/transfer commands ЕЩЁ НЕ РЕАЛИЗОВАНЫ.

J1 проверяет request team/member против envelope/trusted routing, receipt требует accepted/resultCode/processedAt соответствия, accepted без receipt отклоняется. Pending без receipt разрешён. Bound rejected/superseded пока отклоняются: перед Reporter integration нужен явный terminal-outcome contract, не фиктивный accepted receipt. Legacy unbound rows сохраняют свой отдельный путь.

Последний критик нашёл snapshotToRecords normalization bypass и JSON reader missing expected scope; обе правки внесены до последнего прогона. Финальное отдельное подтверждение критика после этих двух правок не получено/не зафиксировано здесь, перепроверить самостоятельно.

## Последняя проверка и отличие local/remote

После остановки пользователя новые тесты не запускались. При handoff прочитаны уже существующие завершённые remote logs:

- `journal-j1-final-tests.log`: 84/84, 4 suites: PreparedBackend38, WorkerCore15, JsonJournal12, JournalMerge19. Vitest 3.2.6, duration 12.29s. Это focused storage integration, не E2E продукта.
- `journal-j1-typecheck.log`: четыре ошибки только в announcements: `AnnouncementsService.ts:496` отсутствует assets; `HttpAnnouncementSource.ts:205` result before declaration/assignment/possibly null. Общий gate красный, нельзя писать typecheck passed. Не исправлять unrelated модуль молча.
- Последний remote command применил scoped Prettier к 21 journal-related файлу перед тестами. Отформатированные файлы ПОКА НЕ СКОПИРОВАНЫ обратно локально. Сначала сравнить exact owned файлы и убедиться, что после передачи не появились чужие изменения. Не извлекать весь remote checkout поверх local.
- Allowlist этого upload: `/tmp/journal-j1-paths.txt` локально и `<remote root>/journal-j1-paths.txt` на сервере. Payload `/tmp/recovery-journal-j1.tar`, remote аналогичный. `/tmp` может исчезнуть; актуальный local source первичен, список содержится также в inventory/evidence.
- Scoped lint и source-size guard для ПОСЛЕДНЕГО J1 ещё не закончены. Ранее они проходили на предыдущих slices; это не покрывает новую версию.
- Старые terminal tool handles 75041/54682 исчезли, logs прочитаны через SSH. Не перезапускать jobs лишь по отсутствию старого UI handle. Сейчас новых implementation jobs не запущено этим handoff.

Исторические подтверждённые результаты в progress: A6 97 + shutdown13 tests; token integrated179, live rotation49; receipt foundation79 и consistency54. Не суммировать их в уникальное число тестов и не выдавать за покрытие всей текущей dirty версии.

## Следующая конкретная работа, в безопасном порядке

1. Зафиксировать inventory своей передачи и прочитать plan §17–20. Не заново аудитить весь проект без причины. Сравнить последний remote formatted journal slice с local, закрыть scoped lint/source-size/type errors своего scope. Сохранить актуальные test logs и hashes.
2. Закончить J1 review и добавить недостающие regressions, если найдутся обходы. Не объявлять проблему решённой только по существованию validator: проверить каждый import/normalizer/canonical reader.
3. Реализовать J2 из §20.16: team-wide intent ID ownership. Сейчас ensure(A,I) и ensure(B,I) обе могут succeed и перезаписать index route. Проверять canonical owner под существующей writer serialization; index лишь projection. При missing index полный scoped scan, EIO/malformed fail closed. Audit всех writer/import/legacy paths, не только нового journal. `JsonMemberWorkSyncStore` имеет tolerant scans с `.catch(() => [])`, они непригодны как доказательство полноты. Cross-store concurrency требует file lock, не только in-memory queue.
4. Переписать старый test `active JSON import exposes same intent ID collisions across member files`: сейчас он создаёт collision двумя успешными ensure. После J2 второй должен conflict. Проверку повреждённого import fixture строить напрямую. Проверить missing/stale index, same ID different member/digest, два store instances, corrupted neighbour, unrelated teams.
5. Закрыть J3: настоящий post-rename failure с видимым canonical file, затем same-ID durability proof после physical settlement без повторного domain write. Нынешний beforeCommit mock недостаточен. Ошибка proof attempt не отменяет предыдущий unknown outcome.
6. Реализовать strict SQLite journal commands и gateway/worker/adapter, одинаковую outward semantics JSON/SQLite, без тихого backend switch после unknown. Nullable metadata plumbing уже есть, не делать вторую таблицу/миграцию-дубликат.
7. Довести Reporter journal/checkpoint protocol целиком: stable online UUID до retries; replay исходного ID/expiry; ensure до accepted CAS; checkpoint receipt в том же CAS; transfer I1 до replacement I2; после await reread current status; explicit replacement proof authority; accepted+projectionDegraded после postcommit journal failure; historical outcome с текущим status без TTL renewal; legacy unbound pending не получает задним числом trusted incarnation/time.
8. Активировать normal CAS through production composition и проверить ВСЕ status writers. Старые optional adapters/legacy fallbacks не должны обходить authority в новом production path. Reconcile/rejection не убивают живой accepted lease.
9. B: scheduler isolation helpers уже есть, но закончить production handoff physical tails/discovery/observation. Logical timeout освобождает логический slot, не per-team physical exclusion. Независимая B не блокируется A; повторные ticks не копят writers.
10. C: independent observation/attention, durable per-work episode/budget/reservation, no-start для providers/лида, immutable outbox. До qualified D0 не создавать automatic reservation/outbox и не тратить budget. Reports/heartbeats не считаются прогрессом.
11. D0: protocol1 ordinary admission, durable stop/control revision, correlated terminal proof/ack/retention; retryable rejection сохраняет unresolved slot. Terminal rejection освобождает лишь после durable retirement старых retries. D1: protocol2 ticket/generation early continuation, atomic runtime admission, foreground input/approval/busy/stop приоритетны. Пользовательская команда не должна запускаться параллельно автоматической.
12. E: закончить durable attention UI/manual idempotent continue и реальный sandbox E2E заявленных providers, включая restart/process crash/unknown delivery/recreate. Qualification только по фактическим scenarios из §12–13 и критериям §16. Не останавливать работу после очередного узкого green suite.

## Инварианты самых опасных стыков

- Read visibility не доказывает durability после известного sync failure. Unknown не равно conflict и не разрешает новый random ID или start.
- Не удерживать global/member locks через provider/network await. Но lifecycle/physical ownership не терять до retirement writer.
- Receipt сохранённого accepted report, provider acceptance и terminal runtime proof являются тремя разными фактами.
- Один unresolved intent на member; budget хранится в authority reservation, не восстанавливается из очищенного outbox.
- Retryable pre-start отказ не освобождает slot: backoff ещё может стартовать. После terminal slot CAS старый callback не очищает новый pointer.
- Retention ack не удаляет последнюю dedupe память, пока envelope admissible. Проверить replay в ТОМ ЖЕ instance/controlRevision, затем отдельный restart; иначе смена instance скрывает баг.
- User stop/pause/approval/foreground и смена instance выше автоматики. Unknown runtime не равен idle.
- Restart runtime не обнуляет no-progress budget той же работы. Blocker требует task evidence; status-only цикл не выдаётся за прогресс.
- Generic restore, backup, migration и worker retirement тоже writers и обязаны соблюдать те же boundaries.

## Ограничения размеров и проверки

Новые source файлы максимум 800 строк. Существующие frozen files не наращивать выше baseline. Последние ориентиры до J1-format: BackendSelecting store800, createFeature800, JsonStore2349 при cap2355, worker ops около756, TeamBackupService около1200 при cap1236. Перепроверить actual guard, не менять baseline ради прохождения.

Рабочие команды в disposable verification checkout:

```sh
pnpm exec vitest run test/features/member-work-sync/main/JsonMemberWorkSyncReportJournal.test.ts test/features/member-work-sync/main/memberWorkSyncReportJournalMerge.test.ts test/features/member-work-sync/main/MemberWorkSyncPreparedBackend.test.ts test/features/internal-storage/InternalStorageWorkerCore.test.ts --maxWorkers=1
pnpm typecheck
pnpm guard:source-file-size
pnpm lint:fast:files -- <точный список изменённых source файлов>
```

Полный lint/architecture gate перед broad qualification по правилам repo. Не запускать глобальный compiler дополнительно к pinned typecheck. Не делать broad lint autofix. Проверять exit code самой команды: некоторые старые SSH wrappers завершаются успешным tail даже после неуспешного test/typecheck; читать log целиком.

## Безопасность E2E и завершение передачи

Только новые sandbox/test projects и явно тестовые identities. Не тестировать launch/provisioning/terminal/task assignment на реальных проектах, даже для одного открытия terminal. Cleanup только процессов/teams конкретного test run. Не трогать чужие tmux/runtime hosts.

Для desktop dev использовать Electron `pnpm dev:mcp` и CDP9222, test APIs/fixtures, без native folder picker. Для runtime source smoke использовать указанный cli-source; production-like wrapper сначала собрать и сверить фактический output. Не выдавать live suites с fake identity за настоящий lifecycle E2E.

В конце следующему исполнителю нужно предоставить requirement-by-requirement evidence A–E, exact source state, выполненные проверки, остаточные ограничения и конечное поведение. Процент 30–40% был грубой оценкой с уверенностью5/10, не измерением. Он не должен ограничивать scope или служить acceptance.

Этот handoff не требует запускать исполнителя через конкретную модель/приложение. Продолжить своими доступными средствами, соблюдая фактические проектные ограничения. Сейчас передана незавершённая dirty реализация, не готовый релиз и не доказанный E2E результат.
