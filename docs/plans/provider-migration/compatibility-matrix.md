# Этап 1: матрица сохраняемого поведения

Навигация: [программа](README.md) · [фазы реализации](stage-1-legacy-host.md).

Все строки обязательны для полного этапа 1. Это новый acceptance denominator,
а не перенос старых отметок «PASS». Отдельные Host/Runtime/MCP и Desktop bridge slices проверены; ни одна строка не объявлена полной приёмкой.
Существующие тесты ниже — oracle поведения; наличие файла не означает его запуска.
На P0 пути и actual baseline сверяются, gaps фиксируются до удаления старого пути.
M19 добавлена после проверки существующего process UI; это сохранение текущего
поведения, а не новый supervisor. Детали M03/M04/M10/M13/M15 и cutover находятся
в [§8–§11 протоколов](stage-1-contracts.md#8-mcp-и-полный-cutover-владельцев).

| ID  | Сохраняемое поведение                                        | Owner / фаза                                      | Oracle или seam                                                                          | Критерий приёмки                                                                                                                                                           |
| --- | ------------------------------------------------------------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M01 | Team config/roster, trash/restore/permanent delete           | Team; P2/P4/P6                                    | `TeamProvisioningServiceRoster`, `TeamProvisioningMemberIdentity`, TeamCreate/TeamDelete | Stable identities; solo/team и roster guards; reversible trash при UNKNOWN stop сохраняет debt, restore не dispatch; permanent purge identity-fenced                       |
| M02 | Launch/bootstrap, provider/model selection, readiness        | Team + Runtime; P3/P4                             | `TeamProvisioningRuntimeLaunchSelection`, `TeamProvisioningMemberMcpConfig.safe-e2e`     | Expected roster+context bootstrap и individual partial outcomes; pending permission не grace failure, scoped retry не дублирует members; MCP loss удерживает handoff       |
| M03 | Task CRUD/comments, assign/claim/dependencies/reopen         | Team; P2/P6                                       | `taskBoard/tasks/review/kanban`, Task tools, attachment IPC                              | Status/reviewState/kanban/history/workIntervals и restore policy; authority/idempotency/notifications сохранены; blobs после restart; partial outcome без дубля            |
| M04 | Human DM/agent reply и peer messages                         | Team + Runtime; P4                                | `TeamInboxReader`, `TeamInboxWriter`, `TeamMessageFeedService`                           | Exact recipient/reply/native attachments; startup доводит committed delivery до admission; queued list/discard отменяет exact IDs до inbox removal, без второго dispatcher |
| M05 | Group и cross-team messages                                  | Team; P2/P4                                       | `CrossTeamService`, `CrossTeamOutbox`, `groupMailbox`                                    | Сохраняются адресаты/права/group semantics; duplicate recipient не получает второй эффект; нет cross-owner adoption                                                        |
| M06 | Technical permissions/questions + product approvals          | Runtime / Team соответственно; P3/P4              | Codex approval fixtures, existing approval transports/UI                                 | Pending request не заблокирован prompt queue; late/revoked/post-abort decision не выдаёт grant; product decision отдельно                                                  |
| M07 | Targeted interrupt, cancel, team/member stop                 | Runtime + Team policy; P3/P4                      | `TeamProvisioningProcessExit`, provider control tests                                    | Late interrupt A не отменяет B; close seal/drain/custody, shared backing не убивается целиком                                                                              |
| M08 | Input ordering, unknown effects и restart reconciliation     | Runtime; P3/P8                                    | Existing command ledger/recovery, native handoff fixtures                                | Durable identity до handoff; lost ACK/crash не дублирует submit/create; stop/revoke/discard завершает unclaimed not-sent, UNKNOWN held, restart не оживляет очередь        |
| M09 | Explicit resume выбранной session                            | Runtime + Driver; P3/P4                           | Existing checkpoint/session fixtures                                                     | Успешный compatible selected restore каждого profile после host restart с native history; missing/incompatible negatives; no continue-latest/fresh-as-resume               |
| M10 | Context/compaction, project instructions, skills/hooks/tools | Team config + Driver; P4/P6                       | `TeamProvisioningServicePostCompact`, selected config/briefing builders                  | Role/team instructions и разрешённые settings сохраняются после compaction; конфликты не маскируются                                                                       |
| M11 | Logs/deltas/complete/chunks/internal + subagent execution    | Driver + Host + Desktop; P4/P6                    | `TeamProvisioningPromptBuilders`, SDK Agent, member-log-stream/chunk tests               | Solo DO subagent выполняется; parent/child provenance/control, isMeta/filtering и отсутствие дублей blocks сохранены; Team grants не расширяются; source gap виден         |
| M12 | Structured TaskRef и переходы по ссылкам                     | Team + Desktop; P2/P5/P6                          | `taskReferenceUtils`, request/ref fields из CLAUDE.md                                    | Exact task/team + owner qualification, structured и encoded refs; imported internal refs идут destination, внешние остаются original owner/gap, без lookup по имени        |
| M13 | Task changes, Git evidence/review/apply/reject/comments      | Team evidence/review; P6                          | `taskChangeLedger`, `review.test`, `ReviewMutationCrash.safe-e2e`                        | Доказанные before/final/failed/background; mixed-hunk Apply сохраняет bytes/decisions/history после restart; guards и gap без backfill/fake attribution                    |
| M14 | Tokens/cost/context usage и уведомления/quick actions        | Projections + Desktop; P5/P6                      | Existing usage/context/notification features                                             | Реальные units/fields и фильтры; unknown не 0; action идёт original owner/task, нет выдуманных usage/results                                                               |
| M15 | Provider detection/config/auth UI, profiles/extensions       | Host adapters + Desktop; P5/P6                    | Existing runtime-provider-management, extension/runtime paths                            | Предыдущий user workflow имеет работающего преемника; required settings не теряются; secrets остаются private                                                              |
| M16 | Saved teams/archive/import/relaunch и legacy obligations     | Team + Desktop + exact old owner; P2/P5/P7        | launch/bootstrap/lane/stop/recovery records                                              | Archive/receipts read-only; stopped relaunch сохраняет data/refs в новом run; backup/restore/prune owner-scoped, debt/retained refs не теряются, legacy writer выключен    |
| M17 | Packed install/bootstrap и supported OS tuples               | Composition/package; P7                           | Existing dist/ASAR/native executable checks                                              | Host-owned flows без fork/sibling/system Node; bundled pinned Node/SDK/CLI разрешаются из candidate artifacts; stdout чистый, cleanup scoped                               |
| M18 | Desktop routing/feeds, IPC/HTTP, target и Quit/Relaunch      | Desktop; P1/P5/P8                                 | Existing app API/provisioning/ledger и shutdown-order/MCP transport tests                | Original owner/generation; snapshot/replay без lost update/cache rollback; Quit/Relaunch seals ingress без host restart, сохраняет debt; нет legacy fallback               |
| M19 | Фоновые services: registry, health/history и scoped UI stop  | Team registry + runtime process adapter; P2/P5/P6 | `processTools`, `processStore`, `TeamDataService`, `ProcessesSection`                    | Register/list/restart/UI stop своего captured process; metadata-only stop отдельно; stale/чужой binding не даёт OS kill или teammate ready                                 |

## Как закрывать строки

[M16: stopped-Team fresh relaunch](evidence/m16-existing-fresh-relaunch-ui-handoff.json)
подтвердил два отдельных native input через прежний Launch-диалог, новые технические
identities, сохранение задачи и обоих ответов в чате, второй Stop/release до cleanup.
Это один Host и localhost API; cold Resume, live-Team Relaunch и автоматический
app.relaunch остаются отдельными сценариями.

[M02: pristine Claude Launch UI](evidence/m02-existing-pristine-claude-launch-ui-handoff.json)
подтверждает исходный диалог → ordinary Host → actual SDK/CLI с localhost API →
task/message/Bash → исходный Stop → settings reload. Native custody освобождена
до app cleanup; app exit0, Host отсутствует, группа пуста, writer released.
Это один Claude lead; Resume/relaunch, другие providers, packed artifact и полный
M02 остаются отдельными проверками.

[M13: исходный OpenCode task capture](evidence/m13-opencode-native-task-capture-handoff.json):
1185 retained files исходного native PASS сверены без replay. Явный Task Start →
actual read/edit → qualified ledger → cold Reject восстанавливает dirty bytes,
сохраняя index и unrelated files. Provider protocol bytes совпадают с выбранной
library; более поздние Host wrapper/composition, Desktop и failed/background
сценарии не квалифицированы. Старый ENOENT сохранён как failed; полный M13 открыт.

[M06: исходный Codex Question UI](evidence/m06-existing-codex-question-ui-handoff.json):
actual CLI 0.162.0 + localhost model/MCP → прежние Composer/Question Sheet →
accept выбранного значения и decline → native replies и canonical receipts.
Cleanup подтверждён без harness signals. Исправлена только TEST policy `never`
на `on-request`; production policy и workspace sandbox не менялись. Остальные
question shapes, vendor auth и полная строка M06 остаются открытыми.

[M19: фактическая проверка Claude Bash](evidence/m19-native-lineage-diagnostic-handoff.json)
выявила отдельную OS-сессию сервиса: root capture успешен, регистрация получила
`foreign-session` в исходном baseline. SDK logical IDs не заменяют native custody.
Проверка владения сохранена; новый произвольный Host executor не добавлен.

[M19: ограниченное live-ancestry admission и normal Stop](evidence/m19-native-live-registration-stop-handoff.json)
проверены отдельно: kernel и actual SDK PASS, v2 register/health/Human Stop с absence
исходного target и работающим соседом. Точное completion notification учтено без
нового tool/input, ошибок модели нет. Cold/crash и Desktop Stop не квалифицированы.

[Scoped M18 Quit/cold-start](evidence/m18-existing-quit-ui-handoff.json): четыре
actual Electron job PASS на SDK/CLI + localhost API. Активный input остаётся
UNKNOWN, очередь отменяется без native dispatch; pending open сохраняет debt.
Оба профиля проходят повторный startup и второе закрытие без native allocation,
replay или изменения исходных Runtime/product records. Original Host/native/group
отсутствуют без harness signals, writer released. Автоматический app.relaunch,
vendor auth, другие providers/OS и полная строка M18 остаются открытыми.

Scoped supplement для M01/M15/M16/M18:
[исходный CreateTeamDialog save-only](evidence/p5-existing-create-config-ui-v1/manifest.json)
прошёл Electron E2E: один original Save, Host registry/Team owner, canonical
навигация и readback после renderer reload без изменения сохранённого state.
Немедленный launch/Resume и остальные обязательные сценарии этим proof не закрыты.

Отдельно принят [исходный Create с запуском](evidence/p5-existing-create-launch-ui-v1/manifest.json):
TEST workspace / Opus 4.6 / Medium / prompt → один registry/capture/native input →
actual SDK/CLI localhost MCP task/Bash exit7/видимый reply → исходный Stop/reload.
Host отсутствует, TEST группа пуста, strict sentinel без legacy вызовов.
Это scoped часть M01/M02/M03/M04/M07/M15/M18 для одного Claude lead;
полные составы/settings/providers, Resume/relaunch, M13 и весь этап1 не закрыты.

В ходе реализации к строке добавляются source ref/artifact, actual assertion,
provider/platform tuple, проверка и ограничения. Compatibility proof и environment
qualification — разные поля: native CLI с localhost API доказывает первое для
этого сценария, но не реальную авторизацию/модель или другой OS tuple.
`planned`, `implemented`,
`scoped-tested`, `integrated-E2E`, `reviewed` различаются. Одно `unsupported` —
безопасный промежуточный отказ, не закрытие прежнего функционала.

Для M02/M04/M06–M11/M15/M17 нужна provider submatrix:

| Provider   | Текущий новый host path                           | Что необходимо квалифицировать                                                                                                      |
| ---------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Claude SDK | Standalone Host slice; полная приёмка впереди     | Native SDK/CLI + local API + authoritative MCP; serial turns/control/restore/context/config; real auth отдельно                     |
| Codex      | Standalone Host slice; полная приёмка впереди     | Actual app-server + выбранная configuration + MCP/control/history/usage/evidence; mock transport не заменяет native path            |
| OpenCode   | Standalone Host V1 slice; полная приёмка впереди | Actual поддерживаемый HTTP/ACP profile, config/MCP, shared-host stop, checkpoint/recovery; dialect/profile pin проверяется отдельно |

Минимальная обязательная mixed-provider композиция: один TEST team с A=Claude,
B=Codex, C=OpenCode; Human→B→human, A↔B/B↔C/C↔A, group, task effect каждого
provider, изолированный stop/restart одного member. Вторая host-owned TEST team
с одним member проверяет cross-team roundtrip. Shared OpenCode isolation отдельно
проверяется двумя native sessions одного backing; обычный SDK subagent отдельно
в solo DO. Двух одинаковых members недостаточно для mixed-provider приёмки.

На P0 выбираются exact поддерживаемые profiles/version/config, на P4 для каждого
есть positive restore и relevant permissions/tools/context proof. Нужны заявляемые
provider paths и различающиеся transport/custody guarantees, а не Cartesian product
всех моделей/OS. Точки fault injection заданы в
[протоколах F01–F09](stage-1-contracts.md#7-фокусные-проверки-отказов).

Фикстура inferencing не выполняет настоящую модель, но native CLI/SDK/MCP, host,
persistence и Desktop должны быть реальными. Реальный provider auth/inference,
subscription login и release availability отмечаются только при отдельном proof.

Если текущий baseline содержит ещё важный сценарий, он добавляется сюда с owner
и acceptance. Нельзя сужать матрицу до списка функций нынешнего provider package.
Также не нужно переносить все hidden CLI flags/upstream internals без app consumer.

### Дополнение к scoped native evidence, 22 октября

[Исходный LaunchTeamDialog E2E, повтор на текущем Create-кандидате](evidence/p5-existing-launch-ui-v2/manifest.json)
подтверждает часть M01/M02/M03/M04/M07/M15/M18 для сохранённой Claude-команды:
реальные controls model/effort/prompt → scoped preflight → roster/fresh capture →
SDK/CLI/MCP/task/Bash → видимый ответ → Stop с physical release до Quit → reload
и saved settings в том же диалоге. Legacy sentinel не получил запрещённых команд,
Host завершился, TEST group освобождена. Dev wrapper cleanup потребовал SIGTERM;
native/Host release проверены отдельно. Это localhost inference, один provider и
конечный набор settings. Полные Create/Launch составы, selected Resume/relaunch, другие провайдеры/
составы/advanced settings и все строки целиком остаются незакрытыми.

[mixed native proof](evidence/p4-mixed-host-handoff.json) покрывает часть
M02/M03/M04/M07/M08/M11: общий bootstrap одного static Team из трёх providers,
Tasks/MCP, replies, notification inputs, member-scoped activity и receipt replay.
Он не закрывает эти строки целиком, ordinary Desktop launch, M05 group/cross-Team,
M09 history restore или M13 review. Отдельный [auth proof](evidence/p5-codex-auth-handoff.json)
квалифицирует Codex TEST refresh/reuse/logout; browser/device login остаётся открыт.

[Selected history proof](evidence/p4-mixed-native-restore-handoff.json) добавляет
положительный native путь M09 для всех трёх выбранных profiles: checkpoint A,
released stop, Host restart, явная новая generation, history A в следующем запросе
модели и прежняя native session/thread identity. Одновременные дубли resume не
создают вторую allocation; stale stop отклонён. Это standalone Host и локальная
scripted модель. Обычные Desktop Resume controls и полная приёмка M09 остаются открыты.

[Native peer proof](evidence/p4-mixed-native-peers-handoff.json) покрывает прямые
сообщения во всех шести направлениях между тремя providers и ответы каждому
отправителю после selected restore. Exact actor/recipient/current generation и
по одному canonical inbox/outbox effect проверены. Это часть M04/M05/F06;
группы, cross-Team и второй Team по-прежнему требуют реализации и проверки.

### Scoped Resume UI, 23 октября

[Manifest](evidence/p5-existing-resume-ui-v1/manifest.json) подтверждает исходные
Launch → Stop → reload → явно выбранный checkpoint Resume → Composer → Stop
для одного Claude lead. Native history и product Task/messages сохранены; Resume
сам не отправляет input. Это scoped M09/M18, не полная provider submatrix.
Raw runner exit1/INCOMPLETE связан с задержанным выходом Electron dev helper;
[отдельный read-only cleanup](evidence/p5-existing-resume-ui-v1/post-cleanup-confirmation.json)
подтверждает его последующий выход, отсутствие захваченных Host/native PIDs
и пустую TEST process group без повторных effects. Raw receipt не переписан.

Actual native capture probe дополнительно подтвердил awaited preimage barrier,
failed Bash и Write/Edit, но выявил поздние configured post-hook/background writes
после D after-callback. M13 остаётся GAP; положительная task attribution и
ReviewWriter tests не заменяют доказательство final bytes/execution attribution.

### Scoped Changes UI, 23 октября

[Исходный Changes](evidence/p6-existing-review-ui-v1/manifest.json) и
[отдельный Host/app restart](evidence/p6-existing-review-readback-ui-v1/manifest.json)
прошли Electron E2E: original hunk Accept/Reject → точные mixed bytes → Undo/Redo →
сохранённая история после renderer reload/Host restart. Непричастные dirty/index
bytes сохранены; внешний writer вызывает прежний Changed on disk/disabled Undo
без перезаписи внешних bytes. Host отсутствует, TEST groups пусты, source hashes
сохранены; оба job exit0/PASS. Это scoped M13/M18 UI/filesystem proof на synthetic
canonical Task ledger, **не native attribution и не полная M13/Stage1 приёмка**.

[D batch seam](evidence/p6-claude-capture-batch-v2/final-analysis.json) установлен
точным TEST-архивом после проверки всех 187 installed files. Actual SDK/CLI
подтвердил awaited before/batch barriers и foreground failed Bash/Write/Edit.
Host consumer теперь удерживает provisional window до mapped post-tool-use batch;
события остаются partial/executionSeq0. Independent batch hooks, background,
external/overlapping writers и generic-agent inventory остаются GAP.

[Host/native supplement](evidence/p6-host-native-capture-handoff.json) связывает
настоящий TaskRecovery input с четырьмя partial native ledger rows и delayed hook;
background/grouped intervals остаются gaps. Исходный runner exit1 из-за неверного
terminal-ID lookup сохранён; отдельная read-only reconciliation подтверждает
реальные effects, portable reader и physical release без нового input/Host/native.
Host review-read RPC/явный stop RPC не были выполнены этим прогоном; cleanup
выполнен настоящим Host.close. Полная M13 остаётся открытой.

### Scoped native Changes composite, 23 октября

[Составное evidence](evidence/p6-native-review-composite-v1/manifest.json) связывает
actual SDK/CLI MCP Task → исходный Task Start/outbox/input → два qualified
foreground Edit → прежний Changes Keep/Reject → Host/app restart → Undo/Redo,
History и renderer reload. Exact bytes, исходные inputs/events, Git index и
посторонний dirty-файл проверены без повторного native input. Оба raw run остаются
INCOMPLETE; read-only reconciliation отдельно закрывает пропущенные assertions,
допуская только вычисленные context hashes и явно проверенные два repeated
closed-state events на Runtime record при shutdown. Это scoped Claude M13/M18;
Codex/OpenCode capture и failed/relevant-hook/background denominator остаются
открытыми, полный этап 1 не закрыт.

[Отдельный native History/reload readback](evidence/p6-existing-native-review-history-ui-v1/manifest.json)
завершился PASS/exit0 без повторения native inputs или Keep/Reject/Undo/Redo:
исходный History undo2/redo0, mixed file и review snapshot сохранены после renderer
reload; Host отсутствует, TEST group пуста. Raw native run (`6758429e…`) и run
четырёх review actions (`9b99345c…`) остаются INCOMPLETE, три source epochs
архивированы. Возникший
при прежней keyboard-навигации draft с 59 двухпробельными отступами сохранён
точно, включая inode/SHA, без discard или записи в рабочий файл. Pre-app helper-mode
отказ `fa0d1b4d…` сохранён отдельно, не как успешный app run. Это scoped evidence,
**M13 и полная Stage1 приёмка остаются открытыми**.

[OpenCode payload qualification](evidence/p6-opencode-filechange-payload-probe-v1/qualification.json)
и [проверенный manifest](evidence/p6-opencode-filechange-payload-probe-v1/manifest.json)
относятся только к новому TEST tuple 1.19.4 / SHA `417af539…`: прежний 1.18.35
pin отказал до allocation. Один advertised native edit подтвердил patch-only
`filediff` (`file/patch/additions/deletions`), без полного `before/after`; текущий
установленный V1 projector metadata не сохраняет. Owned group отсутствует,
provider/native bytes не менялись; auth/review parity не заявлена, **M13 открыт**.

[Native Codex Task capture](evidence/p6-host-native-codex-capture-v1/manifest.json)
подтверждает исходный Task Start → exact input/operation → один native patch →
qualified ledger event → чтение после закрытия Host и Reject с восстановлением
исходных dirty bytes. Посторонний dirty-файл и Git index сохранены; captured
native PID/group отсутствуют. Сохранены оба исходных terminal inputs (assignment
и Task Start), шесть запросов локальной модели, source/dist и неудачная первая
попытка. Это один existing UTF8/LF update; create/delete/rename, multifile,
CRLF, failed/background attribution и Codex Desktop Changes UI не заявлены.
**M13 и весь этап 1 остаются открытыми.**

### Scoped group UI, 25 октября

[Фактический групповой сценарий](evidence/m05-existing-group-native-ui-handoff.json)
прошёл через существующие controls: Create с фиксированными Alice/Bob → направленное
сообщение Alice → native MCP Create из исходного сообщения, ACK и reply Bob →
Bob ACK → реакция пользователя → archive/read-only → renderer reload → restore →
удаление только человеческой реакции → обычный Stop обоих участников.
Проверены точные logical/physical IDs, current generation/run keys, inbox/outbox,
исходные receipts и по одному успешному native input на участника; семь запросов
localhost-модели выполнены настоящими закреплёнными Claude SDK/CLI.

Исходный runner PASS/exit0; retained 2574 файла, Host отсутствует, writer lock
освобождён, оба native-сеанса closed/released до Quit. Dev-обёртка завершена scoped
SIGTERM после закрытия Host: естественный Quit этим результатом не заявляется.
Это часть M05/M07/M18 для двух Claude actors; mixed-provider группы, остальные
провайдеры и полный этап 1 остаются отдельными незавершёнными требованиями.
