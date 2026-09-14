# План D1: ticket-aware admission для Claude / Codex / OpenCode

Дата: 2026-09-14.
Статус: **план реализации, код не начат**.
База desktop: `777genius/agent-teams-ai@661832390` (`main`, смерженный #650).
База runtime: `777genius/agent_teams_orchestrator@origin/main` (не локальный dirty tree).

Родительский документ: [agent-work-recovery-implementation-plan.md](./agent-work-recovery-implementation-plan.md) §10, §17.2.5, §20.1 D1, §20.17.
Этот файл — исполняемый срез D1. Он не заменяет A–C+D0 и не открывает Gemini / external runtime.

## 1. Зачем

D0 уже сам пишет recovery в inbox, режет бюджет и показывает Continue, когда автомат остановился. Юзер не обязан жать Continue в нормальном пути.

D1 закрывает другое:

1. Ход **реально закончился** → сразу одно безопасное продолжение, не ждать lease / 20 минут / ручной Continue.
2. Inbox «delivered» больше не считается стартом модели. Старт — только correlated `startReservedContinuation` / OpenCode prompt accept.
3. Ошибка наблюдения не равна idle (`busy: false` при сбое источника).
4. `turn_settled` без identity не разрешает новый ход (F8/F9 родительского плана).
5. Пользовательский ввод, approval, Stop, bootstrap выигрывают у автоматики. Поздний `finally` не освобождает чужой query.

Без D1 агенты не должны часами молчать «как до #650». D1 уменьшает остаток: пинк лёг в inbox, а ход не начался; ход закончился, а следующий ждёт; два хода сразу.

Инженерная оценка улучшения антизасыпания поверх D0: **+10–25%** при квалификации всех трёх runtime. Это не измеренная метрика. Один только Codex — нижняя граница.

## 2. Сколько строк

Оценки **production + focused tests**. Не новый watchdog и не перепись poller/bridge.

| Срез | Production | Tests | Зачем |
| --- | ---: | ---: | --- |
| QueryGuard ticket API (`reserveContinuation` / `start` / `cancel`) | 120–180 | 120–180 | Единственный native guard. Не второй mutex. |
| Native admission mailbox + processor (новый модуль, poller только вызывает) | 180–280 | 200–320 | Desktop `admit/start/cancel` доходят до QueryGuard в процессе товарища |
| `incomingPromptAdmission` + `handlePromptSubmit` / REPL: user path не съедает continuation ticket | 80–150 | 120–200 | User input wins; stale finally не трогает U2 |
| Codex turn identity: `normalizedEvents` → mapper → executor → emitter | 80–160 | 120–200 | F9: `turnId` + `runtimeInstanceId` + generation |
| Claude Stop / settled: instance+generation в spool event | 40–80 | 80–140 | Stop hook без identity остаётся advisory |
| Desktop: native control-mailbox adapter | 150–250 | 200–320 | Живая реализация уже существующего порта |
| Desktop: OpenCode adapter над delivery ledger/bridge | 150–250 | 180–280 | QueryGuard OpenCode не использует |
| Desktop: router adapter + composition (вместо вечного `not_early`) | 50–90 | 80–140 | OCP: новый provider без правки planner |
| Busy/unknown: native QueryGuard snapshot как extra busy, ошибка ≠ idle | 40–80 | 60–100 | F8 |
| `RuntimeTurnSettledEvent` optional identity fields + ignore без correlation | 20–50 | 40–80 | Settled без identity = refresh, не permit |
| **Итого Claude+Codex+OpenCode** | **910–1570** | **1220–1960** | **~2100–3500 с тестами** |

Первый vertical slice (только managed native Codex, Claude/OpenCode остаются `not_early`): **~550–900 production + 450–800 tests**.

Не входит в оценку: Gemini, lead-only особый протокол сверх общего native path, live canary как строки продукта, рост `useInboxPoller.ts` / `src/main/index.ts`.

Локальный dirty `QueryGuard.ts` в `~/dev/projects/claude/agent_teams_orchestrator` (~+124 строки ticket API) — **черновик на смешанной OpenCode-ветке**. Копировать его оттуда нельзя. Реализовать заново от `origin/main`.

## 3. Что уже есть и чего не строить

Desktop после #650 уже содержит policy D1, но live runtime отвечает `not_early`:

- Порт `MemberWorkSyncRuntimeTicketAdmissionPort` (`admit` / `start` / `cancel`) — `src/features/member-work-sync/core/application/ports.ts`.
- Planner `MemberWorkSyncEarlyContinuationPlanner` резервирует intent, кладёт `workSyncRuntimeTicketId` / `workSyncRuntimeGeneration` в payload.
- Dispatcher вызывает `insertMemberWorkSyncInboxAfterRuntimeTicket` → `start()` **до** inbox insert.
- Production composition: `recoveryProtocol.version: 2` + `createUnsupportedMemberWorkSyncRuntimeTicketAdmission()` → всегда `not_early` → ordinary D0.
- Turn-settled ingest: `RuntimeTurnSettledIngestor` / spool. У Codex emitter нет `turnId`.
- Busy: approval + OpenCode delivery. Native QueryGuard туда не входит.
- Native poller уже отличает `messageKind === 'member_work_sync_nudge'` и finalize по report. Ticket-aware start туда не вплетён.
- OpenCode delivery: `OpenCodeMemberMessageDeliveryService` + ledger. Это authority OpenCode-хода, не QueryGuard.

**Не делать:** второй QueryGuard в desktop; новый LLM-watchdog; DI-контейнер; общий npm-пакет ради двух типов; HTTP-сервер в каждом товарище; правки `JsonMemberWorkSyncStore.ts`; рост frozen `src/main/index.ts`; раздувание `useInboxPoller.ts` (~4200 строк) — вынести admission в новый файл.

## 4. Архитектура (Clean / SOLID / DRY)

### 4.1. Защищаемая политика

Инварианты живут в desktop `member-work-sync` core, не в Electron и не в React REPL:

- Один unresolved recovery intent на member.
- Early continuation только при protocol ≥ 2 **и** живом ticket, который runtime действительно держал.
- User / approval / Stop / bootstrap важнее автоматики.
- Settled без `runtimeInstanceId` + started generation/turn id — advisory refresh, не разрешение нового хода.
- `not_early` — честный отказ capability, не silent admit.

Workflow (CAS, outbox, inbox) уже в application. I/O: control mailbox, OpenCode bridge, spool files — adapters.

```text
core/application (EarlyContinuationPlanner, Dispatcher)
    ↑ depends on
MemberWorkSyncRuntimeTicketAdmissionPort
    ↑ implemented by
main/adapters (NativeControlMailbox | OpenCodeDelivery | Unsupported)
    ↓ runtime calls
QueryGuard (Claude/Codex/lead native)    OpenCode session/ledger (OpenCode)
```

Desktop core **не** импортирует `QueryGuard`, OpenCode SDK, inbox JSON shape.

### 4.2. SOLID

| Принцип | Как здесь |
| --- | --- |
| **S** | Planner решает *нужно ли* early continuation. Runtime решает *можно ли стартовать ход*. Adapter только переводит. Не складывать QueryGuard в `BusySignalPort`. |
| **O** | Новый runtime = новый adapter за router-ом. Не добавлять `if (provider === 'x')` в `EarlyContinuationPlanner`. |
| **L** | `Unsupported` всегда `not_early`. Live adapter при недоступном runtime возвращает `unknown`, не `not_early` (иначе D0 тихо пойдёт в обход сломанного protocol 2). При `busy`/`stopped` не делать no-op start. |
| **I** | Порт уже из трёх методов. Не тащить туда wake, report, spool. Capability probe — отдельное чтение файла/launch-state, не метод planner. |
| **D** | Деталь (QueryGuard, OpenCode bridge) соответствует порту приложения. Не оборачивать vendor API «как есть» с чужими именами полей внутри core. |

### 4.3. DRY

Один смысл — одно место:

- Форма ticket: orchestrator `ContinuationTicket` (`runtimeInstanceId`, `expectedGeneration`, `reservationNonce`, `intentId`). Desktop `MemberWorkSyncRuntimeTicket` (`ticketId` = `reservationNonce`, `generation`, `intentId`). Маппинг **только** в native adapter.
- Stop latch, budget, CAS — уже desktop. Runtime только читает `workSyncControlRevision` и отказывает stale command. Не дублировать latch в QueryGuard.
- OpenCode busy уже в `getOpenCodeMemberDeliveryBusyStatus`. OpenCode ticket adapter переиспользует ledger/bridge, не копирует busy-логику в planner.

Не объединять Claude и OpenCode в один класс с mode-flag: разные owners старта хода, разный смысл `generation`.

### 4.4. Два процесса: почему mailbox, а не HTTP

`admit()` вызывается из Electron main **до** persist. `QueryGuard` живёт в процессе товарища. In-process вызов невозможен.

Варианты:

| Вариант | Вердикт |
| --- | --- |
| HTTP sidecar в каждом native teammate | Не брать: новая сеть, auth, порт, пересечение с controlUrl агента→desktop |
| Поздний reserve только когда poller читает inbox | Нарушает уже написанный dispatcher (`start` до insert) и тест «reserve до durable receipt» |
| **Control mailbox рядом с inbox** | Выбран: тот же filesystem contract, что native inbox; poller применяет команду синхронно к QueryGuard; desktop ждёт ack |

OpenCode: mailbox не нужен. Desktop уже владеет prompt send. Adapter зовёт существующий bridge/ledger.

## 5. Контракты

### 5.1. Capability (protocol 2)

Runtime **заявляет** capability на текущий instance, не по номеру бинарника.

Файл (native):

```text
~/.claude/teams/<teamName>/runtime-recovery/<memberName>.json
```

Минимальный JSON:

```ts
type MemberRuntimeRecoveryCapability = {
  schemaVersion: 1;
  recoveryProtocolVersion: 2;
  runtimeInstanceId: string; // UUID процесса QueryGuard
  generation: number;        // QueryGuard.generation на момент записи
  providerId: 'anthropic' | 'codex' | 'opencode';
  writtenAt: string;
};
```

- Нет файла / version ≠ 2 / чужой instance после restart → desktop `not_early`, ordinary D0.
- Файл пишется при старте REPL/QueryGuard и обновляется при `forceEnd` / смене generation (throttled).
- OpenCode: тот же schema в lane-scoped evidence **или** запись desktop-а после успешного handshake моста. Не считать `opencode-sessions.json` proof protocol 2 без явного поля.

### 5.2. Native control mailbox

```text
~/.claude/teams/<teamName>/runtime-admission/<memberName>/
  command.json     # один текущий command (CAS rename)
  ack.json         # последний ack
```

Command:

```ts
type AdmissionCommand =
  | {
      op: 'reserve';
      intentId: string;
      payloadHash: string;
      controlRevision: number;
      expectedRuntimeInstanceId: string;
      expectedGeneration: number;
      reservationNonce: string;
      issuedAt: string;
    }
  | {
      op: 'start' | 'cancel';
      intentId: string;
      reservationNonce: string;
      issuedAt: string;
    };
```

Ack: `{ op, intentId, ok, code?, generation?, runtimeInstanceId, ackedAt }`.

Processor в orchestrator (новый модуль, **не** раздувать poller):

1. Прочитать command.
2. Сверить `controlRevision` с последним известным latch из mailbox/control (desktop уже записал Stop в status; runtime читает то же поле, что ordinary recovery poller — не invent second latch).
3. `reserve` → `QueryGuard.reserveContinuation`.
4. `start` → `QueryGuard.startReservedContinuation` **без await между проверкой ticket и tryStart-эквивалентом**.
5. `cancel` / user `tryStart` / `forceEnd` инвалидируют ticket.
6. Записать ack atomic rename.

Desktop native adapter: write command → poll ack с timeout (ориентир 2s, cooperative abort) → map codes на порт.

Timeout / IO error → `unknown`. Не `not_early`.

### 5.3. Последовательность native (обязательная)

Совпадает с уже существующим planner/dispatcher:

```text
1. Reconcile / turn_settled drain → status snapshot
2. EarlyContinuationPlanner:
     capability file version>=2?
       no  → not_early → ordinary D0
       yes → admit(reserve command) → QueryGuard dispatching
     CAS reservation + outbox ensurePending (ticket fields in payload)
     если persist fail → cancel
3. Dispatcher insertMemberWorkSyncInboxAfterRuntimeTicket:
     start command → QueryGuard running + generation++
     insert inbox (тот же intent/message id)
     если insert abort/conflict → cancel (если ещё dispatching) / не forceEnd пользовательский query
4. Poller видит member_work_sync_nudge:
     если этот intent уже start'нут этим ticket — onQuery как сейчас
     если ticket stale/user занял guard — не второй tryStart; ordinary processing supersede/cooldown
5. Terminal proof (settled с identity ИЛИ rejected-before-start) → desktop retire slot
```

Timeline-тест из §10.6: reserve C1 → пауза до ack persist → user Stop → start(C1) `stopped`/`stale` → user query U2 стартует → stale finally(C1) не `end()` U2.

### 5.4. User path vs continuation

`QueryGuard.tryStart()` для обычного user submit **сбрасывает** continuation ticket (user wins). Continuation start **только** `startReservedContinuation`. Нельзя после потери ticket вызвать голый `tryStart()` «чтобы всё равно отправить nudge».

`incomingPromptAdmission`: новый `submissionKind: 'work_sync_continuation'`. Пока ticket в `dispatching`, user mailbox/bootstrap/task по-прежнему могут выиграть через `tryStart` (сброс ticket). Не блокировать user DM на всё время persist.

### 5.5. Codex / Claude identity

Сейчас `CodexNativeNormalizedEvent` `turn_started` / `turn_completed` **без** turn id. Emitter пишет spool без `turnId`.

Протащить, не восстанавливая по mtime:

- `runtimeInstanceId` = QueryGuard instance
- `queryGeneration` = generation после start
- `turnId` / `threadId` если provider дал; иначе local generation **только** вместе с instance

Desktop `RuntimeTurnSettledEvent` уже имеет optional `turnId` / `sessionId`. Добавить optional `runtimeInstanceId` / `completedGeneration`. Ingestor: native event без instance+generation → `ignored: native_missing_turn_identity`, enqueue только как refresh (не early permit).

Claude Stop hook без этих полей остаётся advisory. Managed native Claude пишет те же поля из QueryGuard owner.

### 5.6. OpenCode

Не QueryGuard. Owner старта: `OpenCodeMemberMessageDeliveryService` + ledger + session bridge.

`admit`:

- lane/session живы и это текущий run (не старый manifest);
- delivery не busy (существующий busy port);
- нет pending user/foreground prompt;
- stop latch / controlRevision как у native;
- идемпотентность `intentId` в ledger: повтор exact envelope не стартует второй prompt.

`start`: существующий send с тем же intent/message id, записать admission receipt в ledger.

`cancel`: не слать; если уже accepted provider — ordinary cancellation transport, slot `uncertain` до proof.

Settled: уже игнорирует OpenCode без `threadId` и non-terminal outcomes. Сохранить. Early permit только при terminal outcome + thread/run correlation.

Lead OpenCode / primary lane: тот же adapter, не inbox poller.

## 6. Карта файлов

### 6.1. Orchestrator PR (`feat/work-sync-d1-query-guard`)

Новые:

- `src/utils/QueryGuard.ts` — ticket API (сейчас на `origin/main` его нет).
- `src/utils/QueryGuard.test.ts`
- `src/utils/workSyncContinuationAdmission.ts` — apply command → QueryGuard (чистая функция + file ports).
- `src/utils/workSyncContinuationAdmission.test.ts`
- `src/utils/workSyncRecoveryCapability.ts` — write capability file.

Правки точечно:

- `src/hooks/useInboxPoller.ts` — вызвать processor раз за tick; **не** встраивать state machine.
- `src/utils/handlePromptSubmit.ts`, `src/screens/REPL.tsx` — user `tryStart` сбрасывает ticket; continuation не использует голый tryStart.
- `src/utils/incomingPromptAdmission.ts` — kind `work_sync_continuation`.
- `src/services/codexNative/normalizedEvents.ts`, `appServerRunner.ts`, `turnExecutor.ts`, `runtimeTurnSettledEmitter.ts` — identity.
- Claude stop/settled writer (тот же spool root `AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT`).

### 6.2. Desktop PR (`feat/work-sync-d1-runtime-admission`)

Новые (feature slice, ≤800 строк каждый):

- `src/features/member-work-sync/main/adapters/output/NativeMemberWorkSyncRuntimeTicketAdmission.ts`
- `src/features/member-work-sync/main/adapters/output/OpenCodeMemberWorkSyncRuntimeTicketAdmission.ts`
- `src/features/member-work-sync/main/adapters/output/createMemberWorkSyncRuntimeTicketAdmissionRouter.ts`
- `src/features/member-work-sync/main/infrastructure/NativeQueryGuardBusySignal.ts` (ошибка источника → busy/unknown, **не** idle)

Правки:

- `createMemberWorkSyncFeature.ts` / `startMemberWorkSyncFeature.ts` / provisioning bind — подставить router вместо unsupported, когда deps переданы. **Не** раздувать `src/main/index.ts`: только прокинуть уже существующий bind, как D0.
- `RuntimeTurnSettledEvent.ts` — optional identity.
- `RuntimeTurnSettledIngestor.ts` — ignore native without identity.
- `TeamProvisioningMemberWorkSyncBusySignals.ts` — extra native busy.
- Tests рядом с существующими EarlyContinuation / UseCases / sink.

Не менять: `JsonMemberWorkSyncStore.ts`, frozen caps `index.ts` / `TeamInboxWriter.ts` без нужды (writer уже пробрасывает ticket fields).

### 6.3. Два PR, одна семантика

Сначала orchestrator (capability + QueryGuard + mailbox + Codex identity), desktop ещё `not_early` — поведение продукта = D0.

Затем desktop adapters. Early path включается **только** когда capability file protocol 2 виден для этого member instance.

Не включать early globally по `MEMBER_WORK_SYNC_PRODUCTION_RECOVERY.recoveryProtocol.version` без live adapter: version 2 уже объявлен, stub глотает его в D0. Менять stub на router, не поднимать третий flag.

## 7. Порядок работ

Каждый checkpoint: focused tests → `pnpm typecheck` / orchestrator bun test → `pnpm lint:fast:files` на тронутых файлах → `pnpm guard:source-file-size`. Live canary не в том же коммите, что primitive.

| # | Checkpoint | Готово когда | Не готово если |
| --- | --- | --- | --- |
| D1.0 | Этот план | Другой агент может исполнять без догадок | Смешан dirty orchestrator tree |
| D1.1 | QueryGuard tickets + negative tests, capability **выключена** | Reserve/start/cancel/user-wins unit | Poller ещё шлёт continuation через tryStart |
| D1.2 | Control mailbox processor + desktop native adapter против fake filesystem | Planner test: admit→persist→start; user stop между admit и start | Реальный HTTP; рост poller на сотни строк |
| D1.3 | Codex identity end-to-end в spool → ingestor ignore без полей, enqueue с полями | Fixture: turn_completed без turn/instance не даёт early plan | Восстановление identity по времени файла |
| D1.4 | Claude native тот же mailbox (тот же QueryGuard) | Один adapter, два providerId | Отдельный Claude guard |
| D1.5 | OpenCode adapter на ledger/bridge | Concurrent user send wins; duplicate intentId не второй prompt | Копия QueryGuard в OpenCode |
| D1.6 | Router в production composition | Member без capability file = D0; с file = early path | Всех сразу включить без canary |
| D1.7 | Live canaries sandbox only | Codex + OpenCode + Claude (Claude не раньше 17 Sep 14:00 Europe) | Реальные пользовательские проекты |

Lead (native Claude process): тот же mailbox, memberName лида. Не отдельный протокол в первом патче. Gemini: `not_early`.

## 8. Тесты (минимум)

Без live:

- QueryGuard: idle reserve; busy; instance_mismatch; user tryStart drops ticket; startReserved stale after cancel; forceEnd на idle с ticket; stale end не гасит новое generation.
- Mailbox: reserve ack; timeout → unknown; Stop controlRevision mismatch → stopped; duplicate reserve same intent → ok existing; other intent → busy.
- Planner (уже есть suite): `not_early` → D0; admitted → ticket на payload; persist fail → cancel; dispatcher start fail busy → retryable outbox.
- User-wins timeline §10.6 на fake guard + fake mailbox.
- Codex normalizer: turn_completed несёт instance+generation+turnId; без них ingestor ignored.
- OpenCode: ledger already-accepted same intent → start no-op; parallel user delivery → admit busy.
- Busy signal: throw → не `{busy:false}`.

Live (sandbox, `MEMBER_WORK_SYNC_RECOVERY_LIVE=1`, `cli-source`):

- Codex: turn settles → ровно один early continuation start, intent/turn ids в evidence.
- Stop между admit и start → 0 model starts этого intent.
- OpenCode: то же через ledger proof, `requireAccepted`.
- Claude: после разморозки аккаунта.

Не убивать OpenCode hosts на 55326/55392. Не тестировать на реальных репозиториях пользователя.

## 9. Ограничения и риски

- `useInboxPoller.ts` большой: только call-site. Если нужен work-sync branch — вынести.
- Cross-process reserve держит QueryGuard в `dispatching` на время CAS+inbox (обычно <1s). User `tryStart` обязан сбрасывать ticket, иначе UI «завис на секунду». Это требование, не опция.
- Crash после admit до start → `start_unknown`, attention, без слепого retry (родительский §10.6.7).
- Capability cache после restart runtime недействителен. Читать файл каждый admit.
- Не обещать exactly-once внешний model start. Обещать: нет второго старта при unknown, ценой attention.
- Локальный orchestrator `fix/opencode-session-relaunch-followup` + dirty QueryGuard **не** база. `origin/main` + новая ветка.

## 10. Definition of done

- Claude native, Codex native, OpenCode lane: protocol 2 advertised → early continuation проходит ticket path; иначе D0 как сейчас.
- Continue в UI по-прежнему только attention fallback, не основной wake.
- F8/F9 имеют regression.
- Source-size / typecheck / focused tests зелёные.
- Live canary хотя бы Codex+OpenCode на disposable team; Claude когда аккаунт доступен.
- Два PR: orchestrator и desktop, ссылки друг на друга. Этот документ не менять молча при смене контракта — править здесь и в родительском §10 одновременно.

## 11. Как начать другому агенту

Desktop workspace:

```text
Repo:    /Users/belief/dev/projects/agent-teams-ai/agent-work-recovery-pr
Branch:  docs/work-sync-d1-runtime-admission
File:    /Users/belief/dev/projects/agent-teams-ai/agent-work-recovery-pr/docs/team-management/agent-work-recovery-d1-runtime-admission-plan.md
Remote:  777genius/agent-teams-ai
```

Реализацию **не** вести на этой docs-ветке. От `origin/main`:

```text
Desktop:      feat/work-sync-d1-runtime-admission
Orchestrator: /Users/belief/dev/projects/claude/agent_teams_orchestrator
              новая ветка от origin/main: feat/work-sync-d1-query-guard
```

Читать сначала этот файл, затем родительский §10.6–10.7 и §20.1 D1. Не включать early path, пока mailbox/bridge не держат настоящий ticket.
