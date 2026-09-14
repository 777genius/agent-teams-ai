# D1: безопасное продолжение сразу после завершения хода

Дата ревизии: 2026-09-14. Статус: **план проверен и уточнён; реализация не начата**.

Проверенные базы через GitHub CLI и исходники:

- Desktop: `777genius/agent-teams-ai@66183239067284a47326c414dd5ef8b89d3995de`, `main` после #650.
- Orchestrator: `777genius/agent_teams_orchestrator@4d7ba9dc0a329822437dc3cf7376c2e0033d9234`, `origin/main`.
- Исходный план: docs-коммит `bbe5520e89b2a8696196f87806dfd5581f6862e1`. Локальные dirty изменения orchestrator не использованы как база.

Родительский контракт: [agent-work-recovery-implementation-plan.md](./agent-work-recovery-implementation-plan.md), §10.6–10.7, §19.15, §20.17. Этот документ определяет реализацию D1; A–C/D0 целиком не переоткрываются.

## 1. Решение и граница поставки

**Направление верное:** desktop решает, нужно ли продолжение; native runtime через один QueryGuard решает, можно ли начать ход. OpenCode сохраняет своего владельца старта в delivery service/bridge. Новый watchdog, HTTP sidecar и второй guard не нужны.

**Первая поставка, D1-Codex: ровно два PR, только managed native Codex teammate через app-server.** Оба PR начинаются от актуального `origin/main` своего репозитория. Shared native primitive можно использовать позже для Claude, но Claude, lead/primary lane, Codex exec fallback, OpenCode, Gemini и external runtimes в этих PR не получают protocol 2. Это явные последующие срезы, а не скрытые пункты приёмки первого.

Первый срез включает весь безопасный путь: correlated settled → reserve → durable intent/inbox → локальный ticket-aware start → outcome, а также Stop, отмену, restart/unknown и наблюдаемость. Нельзя вырезать эти гарантии ради числа строк.

Поведение: если ход завершён, остаётся исполнимая работа и пройдены существующие policy guards, продолжение планируется на ближайшем проходе event queue, **без ожидания report lease**. Бюджет, unresolved slot, approval, пользовательский ввод, dependencies, manual-only задачи и Stop сохраняют силу. Каждый settled не обязан создавать ход. Continue остаётся ручным fallback; при unresolved/unknown он не обходит защиту.

Из исходного плана убрана оценка «+10–25% антизасыпания»: измерений нет. Проверяемые результаты - latency от settled до admission и число фактических запусков одного intent.

## 2. Что исправлено по исходникам

| Предпосылка исходного плана                      | Факт и обязательное изменение                                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| QueryGuard нужно создать                         | `src/utils/QueryGuard.ts` уже есть в orchestrator main: reserve/tryStart/end(generation)/forceEnd. Расширить этот объект, сохранив обычные callers.                                  |
| Достаточно заменить unsupported adapter          | Порт и dispatcher тоже требуют правки: сейчас `start(ticket)` вызывается **до inbox insert**, а `start` не представляет `unknown`. Удалить этот удалённый start из контракта (§4).   |
| Native poller уже проверяет controlRevision      | Поиск `workSyncControlRevision`/`controlRevision` в `origin/main:src` orchestrator не нашёл проверки. Реальная доставка Stop/revision - обязательная работа первого среза (§6).      |
| Ticket можно восстановить по трём полям          | Сейчас ticket содержит только ticketId/generation/intentId. Нужны durable scope и instance, иначе restart desktop теряет адрес и fencing (§5).                                       |
| В admit и inbox один payloadHash                 | `attachRuntimeTicket` пересчитывает hash после admit. Нужна явная граница admission hash и полного envelope hash (§5).                                                               |
| Один early intent key на agenda достаточен       | Сейчас key содержит только agenda fingerprint. Разные завершённые ходы при неизменной agenda должны различаться, а replay одного хода - нет (§7).                                    |
| Optional fields в Event решают F9                | Normalizer сейчас подставляет `threadId` вместо отсутствующего `turnId`; queue переносит только sourceId/time/turnId/threadId. Исправить весь путь и корреляцию, не только тип (§7). |
| Native active snapshot можно добавить в busy     | Planner повторно проверяет busy **после admit**. Без exact-ticket exemption собственный `dispatching` заблокирует сохранение.                                                        |
| OpenCode уже исключает все non-terminal outcomes | В `getIgnoredReason` наличие threadId сразу возвращает null. Для будущего OpenCode-среза отдельно проверять terminal outcome и identity.                                             |

Точки проверки desktop: `core/application/MemberWorkSyncEarlyContinuationPlanner.ts`, `ports.ts`, `MemberWorkSyncNudgeDispatcher.ts`, `RuntimeTurnSettledIngestor.ts`; `main/infrastructure/CodexNativeTurnSettledPayloadNormalizer.ts`, `MemberWorkSyncEventQueue.ts`. Все пути здесь относительно `src/features/member-work-sync/`, если не указан другой корень.

## 3. Владельцы и что не строить

| Ответственность                                                                            | Владелец                                                              |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Agenda, budget, stop/resume policy, один unresolved intent, CAS/outbox/terminal retirement | Desktop `member-work-sync` core/application                           |
| Локальное право начать native query, приоритет foreground, generation                      | Единственный существующий QueryGuard в процессе REPL                  |
| Чтение/запись control mailbox, capability, перевод DTO                                     | Native processor + desktop output adapter                             |
| Provider accept, stream, terminal outcome                                                  | Существующий Codex executor; позже OpenCode delivery service          |
| Persisted report/proof, ack, запрет replay после retirement                                | Существующие recovery receipt/outbox механизмы с точечным расширением |

Зависимости: `main adapters -> application ports -> domain`. Core не импортирует QueryGuard, filesystem schema, Electron или SDK. Runtime не рассчитывает budget и не создаёт policy intents.

Не добавлять DI-контейнер, общий npm-пакет, отдельную БД/универсальную command queue, второй OpenCode ledger, глобальный mutex через provider await или rewrite больших REPL/poller. Router первого среза - небольшой selector Codex/unsupported; OpenCode-класс заранее не создавать. Новый протокол определяется таблицами и одинаковыми fixture JSON в двух repo, без runtime package зависимости между ними.

## 4. Главная последовательность: reserve удалённо, start локально

Исходный remote `start -> QueryGuard.running -> inbox insert -> poller.onQuery` неверен: guard объявляет running до появления payload, обычный onQuery снова вызывает tryStart, а ошибка inbox оставляет несуществующий ход занятым.

**Целевой desktop admission port имеет `admit` и `cancel`. `startReservedContinuation` существует только у native владельца query.** Обновить unsupported stub, callers и тесты в том же desktop PR. Не сохранять пустой `start()` ради формы старого порта и не заменять его новым round-trip `arm`.

```text
1. Settled ingest/queue -> reconcile с исходной turn identity.
2. Policy: есть runnable work, нет unresolved intent, budget/Stop/priority позволяют.
3. Native adapter.admit -> reserve command -> QueryGuard: idle -> dispatching(ticket).
4. Desktop CAS сохраняет reservation и immutable ticket binding; ensurePending(outbox).
5. Dispatcher выполняет revalidation и insertIfAbsent(inbox); remote model start отсутствует.
6. Poller принимает только matching ticketed envelope и выполняет async preprocessing.
7. В существующей REPL onQuery boundary:
   exact ticket + control gate + priority + payload checked;
   startReservedContinuation(ticket) -> running, generation++ синхронно.
8. Существующий query/executor path; provider acceptance и terminal proof наблюдаются отдельно.
```

Между финальной локальной проверкой и переходом guard в running нет await. Все async preparation/admission-receipt записи завершаются раньше и не дают разрешения на query. Await внутри существующего provider path после локального admission допустим, но его неопределённый исход не означает безопасный retry.

Ticketed envelope может пройти через `dispatching` **только при полном совпадении владельца**. Это отдельный `submissionKind: 'work_sync_continuation'` в `incomingPromptAdmission` и owner token, передаваемый до onQuery. Потеряв ticket, запрещено попасть в обычный `tryStart`, пользовательскую очередь, live-context attachments или другой generic delivery path как обычный текст. Проверить также `attachments.ts`.

User submit/foreground DM/bootstrap при pending continuation сначала синхронно инвалидирует его ticket и использует существующий обычный admission. Обычный task/tick сам по себе не объявляется пользовательским вводом; приоритет берётся из существующей классификации. Если query уже running, сохранить текущие steer/queue/cancel правила, без параллельного старта.

**Cleanup привязан к owner:** не только `end(generation)`, но и reservation cleanup. Сейчас `handlePromptSubmit.finally` вызывает безадресный `cancelReservation()`; поздний C1 cleanup не должен снять новую dispatching reservation C2. Все затронутые generic cleanup callers проверить, не переписывая остальной query pipeline.

## 5. Минимальный native wire contract

### 5.1. Capability и identity

Использовать configured teams root и существующее кодирование member key (`TeamMemberStoragePaths`), не захардкоженный `~/.claude` или произвольное имя в пути. Пример логического расположения:

```text
<team-root>/members/<member-key>/.member-work-sync/runtime-admission/
  capability.json
  <runtime-instance>/commands/<request-id>.json
  <runtime-instance>/acks/<request-id>.json
```

Capability: `schemaVersion:1`, `recoveryProtocolVersion:2`, team incarnation, member identity, `providerId:'codex'`, `runtimeMode:'app-server'`, `runtimeInstanceId`, generation, processor readiness. Runtime instance - UUID конкретного QueryGuard lifecycle, не session/thread ID. На restart меняется; capability публикуется только после подключения всех runtime call sites. Поле generation - hint; свежий reserve ACK подтверждает actual matching generation.

Новый instance начинает с закрытым **D1** control gate. До первого успешного protocol-2 control handshake legacy D0 сохраняет прежний путь, поэтому новый orchestrator совместим со старым desktop. После handshake qualified instance применяет общий control gate ко всем work-sync automatic producers; возврат к legacy admission без revision checks в этом instance запрещён. Desktop читает текущий authority status через store port, синхронизирует control (§6), затем делает admit. Не считать файл, PID, mtime, номер бинарника или протокол в production config доказательством живого permit.

| Ситуация до нового intent                                                                                                              | Результат                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Заведомо неподдерживаемый provider/mode или отсутствующая capability у legacy member, ещё не qualified в текущем scope                 | `not_early`, существующий D0                                                                                            |
| Поддерживаемая capability, processor отвечает и scope совпадает                                                                        | Можно пробовать reserve                                                                                                 |
| Timeout, malformed descriptor/ACK, IO failure, пропажа capability известного qualified instance, неизвестная свежесть instance/control | `unknown`, early fail-closed, без перехода в D0 в этом решении                                                          |
| Обнаружен старый instance/incarnation или несовместимая версия                                                                         | `instance_mismatch`/unsupported diagnostic; старые tickets отклонить, unresolved не освобождать по одному факту restart |

Для уже durable ticket отсутствие capability никогда не разрешает превратить этот envelope в D0. После desktop restart сначала reconciliation pending work/control; запускать новые intents до этого нельзя.

### 5.2. Ticket, hash и команды

Доменный binding (имена полей уточняются в коде, смысл фиксирован):

```ts
type NativeContinuationTicket = {
  teamName: string;
  teamIncarnation: string;
  memberName: string;
  runtimeInstanceId: string;
  expectedGeneration: number;
  ticketId: string; // nonce, не повторяется для другой reservation
  intentId: string;
  controlRevision: number;
  admissionPayloadHash: string;
};
```

Scope/identity брать из существующего lifecycle authority, не генерировать независимую «incarnation D1». Полный binding сохраняется в existing recovery reservation/outbox до доставки, переносится через sink/inbox parser и восстанавливается после restart **без обязательной in-memory Map ticket -> member**. Дополнительный sidecar registry не нужен. DTO и serializers обеих сторон входят в scope.

Два hash имеют разный смысл:

- `admissionPayloadHash`: текущий canonical recovery execution payload **до** добавления ticket fields. Включает текст, task refs, control revision и остальные execution-поля. Runtime получает/восстанавливает эту DTO и проверяет её тем же canonical алгоритмом; не хеширует произвольный raw inbox JSON.
- Существующий `payloadHash` outbox / `workSyncPayloadHash` inbox: полный immutable envelope **с** ticket. Его нынешнюю idempotency-семантику не менять.

Фиксированная serializer fixture перечисляет исключаемые ticket fields; запрещено общее правило «убрать всё с префиксом workSync». Нельзя сравнивать pre-ticket hash из reserve с full hash inbox. Повтор того же unresolved intent использует сохранённый binding, nonce и полный hash; повторный plan не выдаёт новый ticket поверх старого payload. Если dispatch уже был возможен, переиздание ticket запрещено до terminal proof/retirement.

Wire operations:

| Op             | Поля сверх schemaVersion/requestId/scope                                                               | ACK                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `reserve`      | intentId, admissionPayloadHash, expected instance/generation, controlRevision, nonce, command deadline | `reserved` + exact ticket либо typed refusal                                |
| `cancel`       | полный ticket                                                                                          | `cancelled`, `already_cancelled`, `already_admitted` либо `unknown`         |
| `sync_control` | runtimeInstanceId, монотонная controlRevision, stopped                                                 | applied revision + local admission closed/open; это не model terminal proof |

Каждый ACK повторяет `requestId`, op, scope, instance, intent/nonce там, где применимо. `reserve` exact replay возвращает исходный результат; другой payload под тем же request/intent - conflict, другой live intent - busy. `cancel` до задержанного reserve оставляет tombstone, поздний reserve не воскрешает ticket.

**Atomic rename не является CAS.** Использовать отдельные immutable command/ACK файлы по request ID: запись temp + атомарная **no-replace** публикация; при existing ID сравнить bytes/hash и не менять файл при конфликте. `exists -> rename` не подходит: конкурентный writer может перезаписать файл. Native single consumer применяет команды синхронно к одному guard, обрабатывает Stop/cancel перед reserve; desktop не перезаписывает общий `command.json`. Это маленький filesystem transport, без универсального брокера.

Processor вызывается отдельным коротким call site **до busy early-return** inbox poller и обслуживает control при running/dispatching. Он не ждёт provider turn и не вызывает новый polling service. Транспорт ждёт ACK с bounded deadline/AbortSignal; timeout - unknown. Deadline рассчитывается относительно фактического poll interval с запасом; произвольные 2 секунды не являются контрактом. Notification/watch может ускорять доставку, но не заменяет чтение команд.

Pending reservation имеет ограниченный срок жизни; runtime задаёт monotonic expiry и возвращает его в ACK. Command deadline - абсолютное UTC время; runtime ограничивает остаток максимальным TTL и переводит его в свой monotonic expiry. Monotonic значения разных процессов не сравниваются; expiry в ACK служит диагностике. Deadline не продлевается replay. Expiry/cancel освобождает только matching pending guard, не running query и не desktop unresolved slot. Tombstones сохраняются на lifetime instance; delayed command с истёкшим deadline всегда отклоняется. При capacity pressure отказать новому reserve, не удалять replay-защиту. Старый instance после restart недопустим независимо от retention.

Проверять размер JSON, enum, integer/revision bounds, scope и безопасные request/member keys. Команда не задаёт произвольный путь для чтения/записи. Не включать prompt/secrets в diagnostics.

### 5.3. Ошибки и proof

| Окно                                                         | Действие                                                                                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reserve timeout до CAS/inbox                                 | Cancel тем же nonce; даже поздний reserve не может запустить модель без matching durable inbox. Expiry убирает pending guard. Не делать D0 fallback в этой попытке. |
| CAS/outbox definitively failed                               | Cancel; удалить reservation только после доказанного отсутствия доставки и обычного retirement.                                                                     |
| CAS/outbox/inbox write outcome неизвестен                    | Перечитать по тому же ID/hash. Не новый intent, не новый ticket.                                                                                                    |
| Inbox persisted, ещё не consumed                             | Cancel/expiry даёт `rejected_before_start` только после запрета всех путей запуска именно этого envelope.                                                           |
| Локальный admission выполнен, provider acceptance неизвестен | Existing reservation `uncertain`/attention; только observation/reconciliation, никакого generic retry start.                                                        |
| Provider accepted                                            | Awaiting outcome. Ни ACK reserve, ни inbox delivered, ни guard.running не освобождают slot.                                                                         |
| Terminal или definitive rejected-before-start                | Retire retry paths + durable proof/ack по родительскому §20.17, затем освобождение slot.                                                                            |
| Desktop/runtime restart                                      | Старый binding не перепривязать к новому instance. Проверить existing receipt/inbox/provider proof; без доказательства оставить unknown.                            |

Runtime до final local start сохраняет в существующем admission/delivery evidence запись intent/hash/instance/generation с состоянием **pending**, затем повторно проверяет guard/control. Pending receipt не доказывает start. После admission фиксируется `locally_admitted`, после ответа провайдера `provider_accepted`, затем terminal. Это различимые outcomes, не новая очередь. Если evidence не удалось сохранить до старта - отказ; если запись результата потеряна после старта - unknown. Evidence создаётся insertIfAbsent по exact binding; переходы монотонны и owner-scoped. Duplicate/late pending запись не понижает locally_admitted/terminal и не заменяет proof. Все ambiguous окна проверяются crash fixtures.

## 6. Stop, control и busy: обязательный safety срез

Desktop status/store остаётся единственной durable stop/resume policy authority. Native не читает `status.json` как истину: активным backend может быть SQLite. Native держит только monotonic control projection для собственного admission, полученную через `sync_control`.

Desktop Stop:

1. Существующий CAS сохраняет stopped + новую control revision, блокирует новые policy intents и инвалидирует доступные stale inbox/outbox пути.
2. Adapter отправляет `sync_control(stopped=true, revision)` текущему instance. Runtime синхронно закрывает automatic admission и инвалидирует pending tickets, затем пишет ACK. Если automatic query уже admitted, используется существующий cancellation transport; чужой пользовательский query через continuation cancel не прерывать. Cancellation закрепляется за admitted owner даже до появления provider handle: она остаётся pending, проверяется после каждого await перед external start и применяется при появлении handle. ACK Stop не должен терять отмену ещё готовящегося provider call.
3. Результат различает **stop сохранён** и **runtime admission закрыт**. Успешный runtime ACK - барьер: после него новые automatic queries не допускаются. Он не доказывает, что provider уже завершил принятый ранее ход.
4. Timeout/падение runtime оставляет durable Stop и видимый pending/unknown runtime outcome. Не сообщать полное применение Stop и не освобождать unresolved slot. После reconnect/restart повторить exact control sync из authority. Поздний ACK применяется к текущему результату только при совпадении authority revision/stopped и runtime instance; иначе command superseded. ACK Stop 11 после Resume 12 не означает, что gate сейчас закрыт.

Между desktop CAS и runtime ACK возможен local admission старого pending ticket. Нельзя обещать нулевую гонку между двумя процессами. Приоритет Stop означает победу в runtime admission boundary; ранее admitted turn отменяется обычным механизмом. Runtime-local user Stop закрывает gate синхронно до await, затем добивается durable desktop latch; ошибка persistence не открывает gate. Pending local user Stop не снимается поздним sync ранее разрешённой revision: до его durable подтверждения запрещено применять resume; затем требуется explicit resume с более новой revision. Технический forceEnd сам по себе не означает user Stop.

Native-local Stop должен иметь реальный путь к durable authority: в текущем desktop есть HTTP status/report и IPC stop, но нет HTTP runtime-stop. В первом PR desktop добавить узкий input handler `POST /api/teams/:teamName/member-work-sync/:memberName/runtime-stop` на **существующем** control server, вызывающий тот же stop use case. Native отправляет incarnation, runtimeInstanceId, стабильный localStopId и причину пользовательской отмены. Проверять caller/scope через существующую control access boundary; replay localStopId идемпотентен, старый instance не меняет новый. Новый native HTTP server не создаётся. Ошибка/неизвестный ответ сохраняет local closed gate; retry использует тот же localStopId. Processor продолжает применять sync_control, пока этот HTTP запрос ожидает ответа, без взаимного ожидания под одним lock.

Runtime-control outcome нельзя потерять при текущем преобразовании command result в status: провести applied/pending/superseded через feature API, IPC/preload и существующий status hook/attention UI. Durable latch остаётся видимым даже при runtime pending. Это небольшая коррекция существующего Stop результата, не новый экран; focused UI/IPC test проверяет, что unknown не показан как полное применение Stop.

Resume/manual continue отправляет только committed более новую revision. Поздний resume revision 12 не отменяет Stop revision 13; одинаковая revision с иным stopped - conflict. D1 нового instance до начального control sync закрыт; legacy compatibility до handshake определена в §5.1. При desktop reconnect старое cached resume не отправляется; сначала актуальное чтение store. Ни report, ни timer, ни capability recreation latch не снимают.

**Общий обход D0:** на qualified Codex instance те же revision/Stop checks обязательны для ordinary work-sync nudges и иных work-sync automatic producers, не только ticketed D1. Missing revision не означает allow. User messages, diagnostics и acknowledgments сохраняют обычный путь. На неквалифицированных providers D0 остаётся как сейчас; этот план не объявляет его safety заново доказанной.

Busy error не превращается в idle. Missing legacy capability не делает всех legacy members вечно busy. На qualified instance busy snapshot - вспомогательный сигнал: running всегда busy; чужой dispatching busy; свой exact pending ticket можно исключить из **повторной** проверки после admit. Approval/foreground сигналы исключением не перекрываются. Добавить optional intent/ticket context в busy port/callers или вынести эту matching проверку в admission adapter; не отключать busy целиком. Финальная authority всё равно QueryGuard, не snapshot с диска.

## 7. Settled identity и немедленный trigger

Early intent key сохраняет существующий prefix и включает scope/incarnation, agenda fingerprint и completed runtimeInstanceId/generation. Одинаковое событие даёт тот же intent; следующий завершённый ход может дать новый intent при той же agenda, только после terminal retirement предыдущего и проверки budget. Нельзя добавлять текущий timestamp или новый nonce на retry как способ обойти dedupe.

Полная цепочка изменения: Codex provider event mapper → normalized event → executor с captured query identity → emitter → desktop normalizer → Event → queue/coalescing → reconcile context → early planner → native reserve. Менять только emitter и ingestor недостаточно.

- `runtimeInstanceId` и `completedGeneration` захватываются у query owner при старте, не читаются как «текущие» в позднем finally.
- Provider `turnId` переносится, если существует. `threadId`/sessionId не заменяет turnId: один thread содержит много ходов. Local instance+generation допустима как уникальная identity локального хода, без выдуманного provider ID.
- Native reserve принимает expected completed instance/generation из **того события**, которое вызвало решение. Новая capability generation не должна «освежить» старое событие.
- Terminal outcome и соответствие текущему scope/started generation проверяются независимо. Error/unsupported/no_assistant не объявляются успешной возможностью продолжать; проходят существующую failure/attention policy. Повторные и старые события не дают ещё один permit.
- Событие без identity допустимо для обычного status refresh, но не для early activation и не для retirement unresolved intent. Отделить ignored-as-permit от потери legacy refresh.
- Queue переносит полную identity. Coalescing не выбирает «новейшее» событие разных instances по recordedAt и не смешивает его поля; retained stale event безопасно отвергается владельцем runtime.

Reconcile передаёт correlated terminal evidence в отдельный early eligibility путь **до ordinary lease-wait gate**. Early path проверяет runnable agenda, budget, Stop, foreground/approval, unresolved slot и policy readiness. Не требовать `status_not_nudgeable`/lease expiry, рассчитанные для обычного зависания, после доказанного settlement. Обычные timer/tool events не превращать в такой permit.

Emission executor может произойти до `QueryGuard.end(generation)` в REPL. Desktop не должен потерять единственный trigger, получив временный busy. Runtime публикует usable settled после owner release либо existing queue сохраняет то же evidence до owner release без новой budget attempt. Для первого среза предпочесть owner completion call site: terminal details из executor сохраняются, событие публикуется после successful `end(thisGeneration)`; stale finally не публикует permit для новой query.

«Сразу» означает следующий штатный drain/reconcile, а не нулевая задержка. Сейчас queue имеет debounce для turn_settled; тест измеряет configured drain/queue latency и доказывает отсутствие ожидания lease. Не вводить новый таймер или менять все debounce policies ради D1.

## 8. Два PR и критерии завершения

| PR                                            | Ownership                                                                                                                                                          | Merge/activation                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orchestrator `feat/work-sync-d1-query-guard`  | Existing guard tickets; control mailbox/Stop projection; exact-ticket admission и cleanup; DTO/inbox filtering; Codex app-server turn identity/proof               | Отдельно совместим с desktop D0. Capability только у полностью поддержанного mode; automatic D1 gate закрыт до control sync, legacy D0 до handshake совместим. |
| Desktop `feat/work-sync-d1-runtime-admission` | Порт admit/cancel; native adapter; removal pre-inbox start; durable binding/hash; control result/HTTP runtime-stop; busy; identity до planner; composition и tests | Можно разрабатывать против shared fixtures параллельно. Включать Codex после qualified runtime и combined sandbox canary на exact SHA пары.                    |

Новые native модули размещать рядом с existing runtime recovery/inbox utilities по conventions repo. Крупные call sites получают только вызовы небольших модулей. В desktop использовать existing feature slice и public entrypoints; provisioning получает narrow dependency, не whole-service cast.

В scope desktop явно входят runtime-stop input handler и Stop result через IPC/preload/UI, `MemberWorkSyncRecoveryCommands`, dispatcher error/retry handling, contracts/payload serializers, `TeamInboxMemberWorkSyncNudgeSink`, shared inbox DTO, EventQueue/reconcile/planner. `TeamInboxWriter` трогать только если иначе теряются новые поля; его frozen cap не увеличивать. `JsonMemberWorkSyncStore` не переписывать; если новый persisted field теряется при roundtrip выбранного backend, минимальная serializer правка и тест обязательны, запрет на файл не важнее корректности.

Ориентир объёма, не обязательство и не формула готовности:

| Срез                                               |   Production | Focused tests |
| -------------------------------------------------- | -----------: | ------------: |
| Первый orchestrator PR                             |      400–700 |       450–750 |
| Первый desktop PR                                  |      350–550 |       350–600 |
| **D1-Codex, оба PR**                               | **750–1250** |  **800–1350** |
| Позже: Claude native + отдельная lead квалификация |      100–220 |       180–300 |
| Позже: OpenCode delivery admission                 |      300–550 |       350–600 |

Первый срез: примерно **1550–2600 строк вместе с tests**, каждый PR ориентировочно в review budget 2000 changed LOC. Полный roadmap: примерно 2500–4300, низкая точность до contract fixtures. Исходные 550–900 production для Codex не учитывали control/Stop bridge и изменение dispatcher/queue. Новых библиотек не требуется.

Рабочий порядок: contract fixtures и safety timelines → runtime primitive/admission → desktop integration → focused verification → combined canary. Не откладывать Stop/unknown на «следующий hardening PR». Если срез неожиданно превышает бюджет, сначала пересмотреть разрастание, не разрезать admission-инвариант.

## 9. Проверки первого среза

| Проверка                   | Наблюдаемое доказательство                                                                                                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Happy path до lease expiry | Correlated settled + runnable task запускает ровно один continuation в пределах configured drain/queue latency                                                                                                         |
| Owner lifecycle            | Reserve не начинает query; inbox ещё отсутствует - provider calls = 0; consume/start только один раз                                                                                                                   |
| User wins                  | Пауза на CAS/preprocessing, user submit/DM/Stop выигрывает pending ticket; C1 не попадает в generic fallback                                                                                                           |
| Stale cleanup              | Late `end(C1)` и `cancelReservation(C1)` не меняют running U2 и dispatching C2                                                                                                                                         |
| Stop/resume                | CAS Stop → delayed runtime ACK различимы; после ACK = 0 новых admissions; revision 10 envelope отвергнут после Stop 11/Resume 12                                                                                       |
| Mailbox races              | Concurrent no-replace publish, duplicate reserve, conflicting hash, cancel-before-reserve, stale ACK чужой op/nonce/instance/revision, clock/expiry, control при running                                               |
| Busy                       | Matching pending reservation не блокирует свой persist; running/approval/чужой ticket блокируют; IO throw не idle                                                                                                      |
| Identity                   | Один thread с двумя turns и неизменной agenda: разные intents; replay одного turn: тот же intent; delayed old-instance event; generation mismatch; missing identity; mixed queue coalescing; event после owner release |
| Hash/DTO                   | Одинаковые fixtures обеих сторон; admission/full hash различены; modified execution payload отвергнут; ticket сохраняется inbox parser и обоими поддержанными store backends                                           |
| Crash/restart              | Каждое окно §5.3; desktop restart без Map; runtime restart со старым inbox; uncertain не создаёт новый ID/start                                                                                                        |
| Replay/retirement          | Rejected-before-start действительно запрещает delayed delivery; provider acceptance не освобождает slot; late pending не затирает terminal; terminal ack сохраняет replay witness                                      |
| Compatibility              | Старый runtime без capability = D0; unsupported modes/providers = D0; ticketed unknown не понижается в ordinary delivery                                                                                               |

Desktop: focused Vitest suites, `pnpm typecheck`, `pnpm lint:fast:files -- <touched files>`, `pnpm guard:source-file-size`, provisioning guard при изменении bind. Финальный exact-head CI использует repository gates. Orchestrator: focused `bun test` по guard/admission/Codex/inbox; type/build gates из актуального package/workflow. Не гонять повторно полный набор без новых изменений.

Live canary первого среза: **только новый disposable test project/team**, qualified Codex app-server. Сохранить exact desktop/orchestrator SHA, identity пары, settled time, reservation/inbox/admission/provider-accept/terminal timestamps и счётчик provider starts. Проверить happy path, Stop до consume, desktop restart с pending intent. Test-owned barriers/fixtures создают гонку детерминированно; не пытаться ловить её случайными sleeps.

Для UI использовать Electron `pnpm dev:mcp`, для source runtime `cli-source` **из проверяемого чистого checkout**. Путь по умолчанию на dirty orchestrator workspace явно переопределить. Production-like canary - built `cli` из того же SHA после build. Не использовать пользовательские проекты; cleanup только test-owned team/processes, не shared OpenCode hosts. Тяжёлые проверки предпочтительно на hosted sandbox.

D1-Codex завершён, когда все перечисленные safety/compatibility checks и Codex canary доказаны. Rollback: вернуть desktop adapter в unsupported для **новых** intents; pending ticketed envelopes сначала cancel/reconcile, не переотправлять через D0. Откат не удаляет Stop, budget или unresolved proof. Merge не означает разрешение публиковать релиз.

## 10. Последующие срезы, без скрытого scope

**Claude native:** переиспользует guard/mailbox, но сначала доказать owner identity и timing managed Claude completion. Shell Stop hook остаётся advisory. Отдельно проверить export environment/launch composition: сегодня spool env ориентирован на Codex, Claude получает hook settings. Lead допускается только после доказательства своего control polling и того же owner contract; имя `team-lead` само по себе этого не доказывает. Собственный sandbox canary обязателен. Недоступность аккаунта оставляет этот срез незавершённым; календарную дату разблокировки не фиксировать как архитектурный gate.

**OpenCode:** reserve/consume внутри существующего `OpenCodeMemberMessageDeliveryService`/ledger и serial lane admission, без QueryGuard и native mailbox. Desktop adapter резервирует lane, но не посылает prompt второй раз. Единственный prompt send остаётся существующим wake/delivery path после durable intent. `getBusy` + отдельный последующий send не являются атомарной reservation. Foreground send должен участвовать в том же admission boundary. Это обязательная часть будущего среза, а не готовая возможность ledger.

OpenCode acceptance: exact intent/full envelope hash, lane/session/run и per-prompt identity; accepted receipt, bounded retries только при definitive not-accepted, unknown без повторного send. `threadId` один не уникализирует prompt. Terminal whitelist проверяется даже при наличии threadId. Cancel уже принятого prompt использует existing transport и сохраняет unresolved до terminal proof. Reconnect/session recreation не оживляет permit. Lead/primary lane включаются только отдельным проверенным coverage, без предположения о teammate inbox.

Для каждого расширения свои bounded PR и sandbox canary. Общий D1 для всех трёх providers нельзя объявлять Done по одному Codex. Новые provider abstractions выделять по фактическому второму consumer.

## 11. Передача работы

Документы правятся в `docs/work-sync-d1-runtime-admission`, workspace `/Users/belief/dev/projects/agent-teams-ai/agent-work-recovery-pr`. Реализацию здесь не начинать.

Перед implementation: обновить `origin/main` обоих repo, проверить изменение перечисленных seams, создать отдельные чистые branches/worktrees из актуальных main, записать SHA. Orchestrator repo: `/Users/belief/dev/projects/claude/agent_teams_orchestrator`; смешанная dirty ветка не источник ticket implementation. Два PR ссылаются друг на друга и на этот контракт.

Если найден новый разрыв в Stop/receipt/start semantics, исправить этот документ и соответствующий родительский §10 вместе до activation. Не маскировать изменение контракта одним adapter stub или заявлением «тесты зелёные».
