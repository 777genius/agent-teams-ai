# Этап 1: протоколы реализации и восстановления

Это детали [основного плана](stage-1-legacy-host.md), а не новый этап или public
runtime framework. P1 закрепляет точные TypeScript shapes и profile limits;
ниже фиксируется необходимая семантика. Имена полей рабочие. Готовые DTO, locks,
atomic-write helpers и stores переиспользуются, если выполняют этот контракт.

## 1. Identity, привязка и полномочия

| Значение                 | Кто задаёт                                      | Где сохраняется и зачем                                                                             |
| ------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Backend binding          | Desktop composition при выборе target           | Backend ID/revision, protocol, profile/storage root; повтор и lookup всегда идут исходному owner    |
| Team/run/member          | Team owner                                      | Stable IDs, workspace, role/membership revision; display name не используется для authority         |
| Session generation       | Runtime owner до allocation                     | Одна incarnation технической session; старая generation не оживает после crash                      |
| Host incarnation         | Host startup                                    | Отличает новый процесс от прежнего; не даёт автоматически присвоить прежние children                |
| Command ID + fingerprint | App caller до первого dispatch; host валидирует | Повтор intent, immutable operation/payload/resource binding; новый payload с прежним ID конфликтует |
| Input/operation ID       | Runtime до handoff                              | Связь с message/task intent, exact session/turn и consumption/terminal; не случайный ID при retry   |
| Interaction/control ID   | Runtime из provider observation                 | Exact generation/operation/request и expiry; reply не может превратиться в grant другому turn       |
| Checkpoint reference     | Runtime после durable publication               | Private opaque bytes и native store binding; renderer получает handle/status без native paths       |

Trusted actor берётся из captured IPC/MCP connection, а не из tool arguments.
Scope команды проверяется при admission и внутри relevant mutation fence;
replay/lookup результата тоже проверяет **текущие** grants. Потеря права не меняет
сохранённый outcome, но запрещает его раскрытие или новый effect. Raw credentials,
native session IDs и private checkpoint не попадают в app DTO/logs.

Не создаётся единый глобальный generation counter. Team revision, runtime
generation и host incarnation различаются; mapping хранится вместе с handle.
Новые default settings влияют на новые intents, не переназначают уже accepted.

## 2. Соединение и ошибки

Один Desktop profile управляет одним captured child host. Startup последовательно:
проверка Node/executable → isolated paths → host handshake → чтение persisted
obligations → готовность к новым commands. `ready` host означает готовность API,
но не готовность всех members. Unresolved session блокирует свой resource, а не
объявляет пустой весь roster. Второй writer того же profile/store не допускается.

Handshake возвращает protocol/build identity, capabilities и согласованные limits.
Mismatch отказывает до mutations. Stdout содержит только framed RPC, stderr имеет
отдельный bounded diagnostic tail. Decoder ограничивает frame **до** JSON parse;
также ограничены pending requests, queued inputs и retained notifications/bytes.
Числа задаются trusted TEST/production profile на P1 и проверяются limit/limit+1;
большие observations разбиваются штатным stream API, а не отключением bounds.

Нельзя терять terminal/interaction event при переполнении: reader либо применяет
backpressure, либо отдаёт durable cursor/gap и snapshot recovery. Notification
не является единственной квитанцией mutation. Diagnostic без operation attribution
остаётся session-level. Credentials/raw provider payload не выводятся в ошибку.

| Ответ/ситуация                                                     | Действие клиента                                                                 |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Rejected до admission: invalid/conflict/forbidden/unsupported/busy | Показать точный safe reason; прежняя функция с unsupported ещё не принята        |
| Accepted/in-progress                                               | Сохранить receipt/binding; ждать/читать progress исходного owner                 |
| Completed с receipt                                                | Использовать результат при совпадении owner/generation и current authority       |
| UNKNOWN/partial effect                                             | Lookup/reconcile по исходному ID; не генерировать заменяющий intent              |
| Timeout/EOF/aborted RPC                                            | Outcome неизвестен, пока original owner не дал proof; timeout не cancel          |
| Wrong protocol/oversized frame                                     | Закрыть broken connection; удержать obligations, не переключаться в fork         |
| Cursor expired/gap                                                 | Перечитать snapshot того же owner; поздний snapshot прежнего target игнорируется |

Control/reply отдельны от prompt admission queue. Abort ожидания RPC не вызывает
provider interrupt; interrupt/close требуют явного scoped запроса. После EOF
Desktop не запускает replacement с предположением, что child providers умерли:
recovery сначала проверяет прежнюю custody. Нужен конечный startup/control timeout,
но истечение времени меняет здоровье/наблюдение, а не доказанный исход effects.

## 3. Команда и частичная запись

Существующий app command ledger сохраняется как client intent/outcome mechanism.
Authoritative host receipt хранится рядом с owner state; это не второй dispatcher.
Минимум receipt: schema version, owner/resource binding, command ID, operation,
canonical payload fingerprint, подготовленные effect IDs, phase/result/evidence.
Private payload/results не раскрываются другим actors через duplicate lookup.
Fingerprint включает смысл операции; не зависит от порядка JSON keys или UI label.

Пример `sendMessage` с двумя файловыми эффектами, без фиктивной общей транзакции:

1. Под resource/authority fence проверить grants, duplicate/conflict и current
   versions. Сохранить intent с message/delivery IDs **до** записи inbox/outbox.
2. Записать business message по original ID и delivery intent по original ID.
   Existing format guards/atomic write сохраняются. Не генерировать новые IDs
   при exception между файлами. Native dispatch сюда не добавляется вторым путём.
3. Сохранить completed receipt после доказанных effects. UI получает projection;
   отдельно runtime принимает delivery input по тому же intent.
4. После response loss повтор возвращает тот же receipt при current authority.
   Нет receipt, но intent есть: census exact IDs/versions различает applied,
   частично applied, доказанно not-applied и неопределённое состояние.
5. Recovery дописывает только доказанно отсутствующую часть. Несовпадающие bytes/
   versions или ещё живой прежний writer удерживают UNKNOWN/HOLD. Удаление ресурса
   требует tombstone/version proof, отсутствие файла само по себе недостаточно.

Execute, census, reconcile/retry и revoke сериализуются тем же authority/resource
fence. Прежний handler не должен дописать effect после решения `not_applied`:
нужно дождаться его terminal либо доказанно закрыть его право записи. Один stale
timeout этого не делает. На filesystem-пути используется существующий lock/
revision protocol; generic distributed lease engine не добавляется.

Долгий native turn не держит общий Team lock. Его отдельный runtime obligation
не позволяет повтор handoff; per-session fence защищает короткие admission,
control/claim и publication переходы. Team business receipt и native input receipt
связаны IDs, но не обязаны одновременно стать completed.

Практический reuse: `taskCreationIdempotency.ts` даёт deterministic Task-create IDs
и creation metadata, но его no-key branch создаёт новый task. На новом mutating
host path command ID обязателен; create-only helper не заменяет outcomes для
update/delete/messages/control. В existing `ApplicationCommandRunner` защита
authority оборачивает также completed replay и stale reconciliation, поскольку
они могут обойти обычный execute handler.

## 4. Native allocation, input и control

Runtime private composition для каждого provider создаёт ровно нужные ports:

| Provider | Что готовит runtime adapter до factory/open                                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude   | Captured SDK/CLI/config, isolated HOME/native session store, MCP transport, trusted tool/permission settings, launch/custody и session-exists proof |
| Codex    | Captured app-server process/transport и version, initialize/thread/turn config, MCP, private checkpoint/custody binding                             |
| OpenCode | Captured HTTP/ACP profile/version, native backing process/session/endpoint, workspace/config/MCP, ownership references для shared host              |

SDK/protocol алгоритм остаётся в D. Host не обходит SPI ради второго raw client.
Probe/version пригоден только до allocation; фактическая native identity и tools
подтверждаются после handshake. Factories сами по себе не обеспечивают поиск
executable, user login или durable ownership всех созданных native resources.

Состояния не требуют отдельных классов/таблиц на каждое слово:

| Resource    | Допустимая последовательность                                   | Crash/неопределённость                                                                          |
| ----------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Session     | opening intent → allocated → ready → closing → closed           | Unknown allocation/stop сохраняет debt; новая generation удерживается                           |
| Input       | admitted → dispatch claimed → consumed/handoff → terminal       | После uncertain claim не повторять submit; известный not-sent допускает тот же intent по policy |
| Interaction | pending → ответ принят → provider outcome/expired               | Не восстанавливать volatile callback после restart и не отвечать другому request                |
| Close       | admission sealed → outstanding reconciled → drain/custody proof | Logical closed отдельно от physical stopped; unresolved записывается явно                       |

Один активный input на session, порядок queued inputs устойчив к reconnect.
Следующий handoff не пересекает unresolved input/control. Result A и interrupt A
проверяются под session fence; после terminal A control не переадресуется на B.
Delivery/Task policy может создать новое намерение только при доказанном исходе
старого; автоматический новый UUID после transport error запрещён.

Shared OpenCode host хранит exact session references: close A закрывает A, не
host B. Physical stop backing разрешён только владельцу captured process и после
закрытия его references. Ошибка одного cleanup не пропускает cleanup остальных.
Stop обычного subagent принадлежит родительскому provider scope, а не Team roster.

## 5. Checkpoint и положительный restore

Checkpoint token не является сохранённой history. Runtime сохраняет и ссылку на
native backing store/config/engine/account/workspace, и proof завершения прежней
custody. Эти данные private; owner storage root не берётся из модели или renderer.

Публикация выполняется так:

1. Дождаться idle вне session fence, чтобы terminal/control transitions могли
   завершиться. Затем взять admission/control fence, атомарно перепроверить idle
   и доказанный исход предыдущих inputs; при изменении состояния отпустить fence
   и ждать заново. До конца capture/publication следующий submit не допускается.
   Текущий SPI `Session.checkpoint()` захватывает idle state до `close`;
   `readCheckpoint(reference, request)` — другой, host-owned port загрузки уже
   сохранённых bytes при restore, не операция capture.
2. Получить opaque value через SPI и сохранить versioned payload в private store
   с source generation/config/native binding. Не переписывать internal hash/token.
3. Закончить durable write payload по гарантиям existing store, затем атомарно
   опубликовать reference в session record. До этого UI не видит resumable handle.
   Atomic rename не объявляется power-loss durability: если профиль обещает её,
   helper должен обеспечить соответствующий flush/commit.
4. После publication разрешить следующий input или close. Сохранённый checkpoint
   отражает конкретный completed operation; дальнейший uncertain input блокирует
   replay этой history, даже если прежний checkpoint корректен.
5. Для stop сначала seal admission; если session уже idle, capture до provider
   close. Для busy/unknown сначала normal control/reconciliation. Не обещать
   resumable stop, если provider не даёт доказанного checkpoint/history.

Crash до payload write не создаёт reference. Crash после payload, но до publication
оставляет orphan, который recovery не подставляет автоматически вместо selected
checkpoint; cleanup возможен позже при доказанном отсутствии references/obligations.
Crash после publication не требует заново отправлять последний input. Неизвестная
custody или subsequent input держит restore blocked, а не выбирает last-good token.

Restore проверяет explicit selected reference, readable payload/native history,
engine/profile/config/account/workspace compatibility и закрытие предыдущего owner.
Новая runtime generation допускается только после этого; source generation остаётся
в checkpoint binding. Если SPI не поддерживает такой переход, он требует scoped
provider доработки, а не подделки generation/hash. OpenCode endpoint/backing change
не маскируется исправлением opaque compatibility hash.

Для каждого заявленного provider profile acceptance содержит: input A с уникальным
history marker → completed/capture → close/proven custody → host restart → restore
выбранной session → input B, использующий marker A. Assert берётся из реального
SDK/CLI transcript/protocol request к localhost fixture и exact native identity;
совпадение UI текста само по себе недостаточно. Дополнительно проверяются missing
payload/history, incompatible config и uncertain later input. Одни отказы не PASS.

Native store сохраняется, пока есть resumable references/обязательства. Cleanup
TEST run удаляет только его собственный store после завершения проверок; нельзя
получить положительный restore за счёт случайной history из user HOME.

## 6. Subagents, reads и cutover

Обычный Claude SDK subagent без `team_name` сохраняется в solo DO. Native Team/
Task/SendMessage writers остаются закрыты; создание persistent teammate идёт
через Team owner/MCP. DO/action-mode gate и child grants проверяются до execution.
Subagent не выбирает actor/Team authority аргументами `Agent` tool.

D должен сохранить parent/child/tool/operation provenance в нейтральной observation
capability или provider-owned extension; raw SDK envelope не становится Team DTO.
Дополнение SPI совместимо для consumers без этой capability; consumer, заявляющий
subagent parity, требует её при readiness. Логи/usage/evidence не приписываются
родителю или соседнему teammate догадкой. Parent stop охватывает только его owned
descendants. Nested execution не создаёт вторую durable Team dispatch queue.

Desktop cutover делается на одном host-owned handle целиком: launch/mutations,
query/log feeds, approvals и evidence. Sentinel старого writer/reader должен падать
при его случайном вызове в TEST, а не возвращать совместимые данные. Старые archive
readers разрешены только для явно archive/old-owner handles. Отдельно проверяется
late notification старого target после переключения и reconnect с gap/snapshot.

Active old-owner inventory read-only: launch/bootstrap/lane/session/stop/command
records перечисляются без repair/quarantine. Corrupt/unreadable census = HOLD.
New host не забирает processes/receipts; rollback defaults касается новых intents.
Cross-owner обмен и live import не входят в этот cutover. Этот запрет не уменьшает
обязательный cross-team сценарий между двумя host-owned командами.

## 7. Фокусные проверки отказов

Это scenarios для существующих suites, а не девять новых harness/CI gates.
Один proof закрывает несколько M-строк; Electron не дублирует все injection points.

| ID  | Injection / проверка                                                                                      | Где достаточно доказать                             | Ожидаемый результат                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| F01 | Response loss после business commit; повтор ID, затем payload conflict и revoke перед lookup              | P2 actual owner store/MCP + existing command ledger | Один effect; прежний receipt только при authority; conflict без новых writes                                     |
| F02 | Crash между message и delivery write; зависший original handler одновременно со stale reconcile           | P2 store integration                                | Только доказанно missing effect дописан; живой writer не допускает not-applied/replay                            |
| F03 | Crash до/после native dispatch claim; missing receipt после create                                        | P3 runtime + packed D fixture                       | Proven not-sent отличается от UNKNOWN; нет второго native create/submit                                          |
| F04 | Pending permission при полной queue; revoke/late reply; interrupt A после result A                        | P3/P4 provider control                              | Reply обслуживается отдельно; stale grant/отмена B отсутствуют                                                   |
| F05 | Capture/write/publication crash; native history missing; compatible selected restore после restart        | P3/P4 actual native store + localhost inference     | Reference не раньше bytes; положительный restore каждого profile; uncertain input held                           |
| F06 | Mixed team A=Claude/B=Codex/C=OpenCode; A↔B/B↔C/C↔A, group, task per provider, stop/restart одного member | P4 actual host/MCP/native paths                     | Exact recipients/replies/task effects; остальные members продолжают работу; cross-team со второй host-owned team |
| F07 | Solo DO subagent effect; запрещённый mode; parent/child logs и parent stop при соседней session           | P4 native SDK + P6 projections                      | Реальный child effect и provenance; mode/grants соблюдены; сосед не остановлен                                   |
| F08 | Reconnect/gap и late reply прежнего target; старые readers/writers со sentinel                            | P5/P8 Electron через CDP                            | Правильный owner/cache/status; ни одного active legacy fallback                                                  |
| F09 | Packed Electron startup/input/control/close без fork, source checkout и ambient config                    | P7 installed candidate                              | Работает actual artifact; resolved paths/digest сохранены; cleanup только TEST-owned                             |

Отдельный existing shared-OpenCode сценарий с двумя native sessions подтверждает
reference custody; mixed team с одним OpenCode member его не заменяет. Faults
используют реальные TEST files/processes на relevant boundary; localhost inference
скриптует модель, но не подменяет host, native SDK/CLI, MCP или Desktop.
