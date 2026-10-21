# Этап 1: матрица сохраняемого поведения

Навигация: [программа](README.md) · [фазы реализации](stage-1-legacy-host.md).

Все строки обязательны для полного этапа 1. Это новый acceptance denominator,
а не перенос старых отметок «PASS». Здесь пока нет доказанного legacy-host.
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

В ходе реализации к строке добавляются source ref/artifact, actual assertion,
provider/platform tuple, проверка и ограничения. Compatibility proof и environment
qualification — разные поля: native CLI с localhost API доказывает первое для
этого сценария, но не реальную авторизацию/модель или другой OS tuple.
`planned`, `implemented`,
`scoped-tested`, `integrated-E2E`, `reviewed` различаются. Одно `unsupported` —
безопасный промежуточный отказ, не закрытие прежнего функционала.

Для M02/M04/M06–M11/M15/M17 нужна provider submatrix:

| Provider   | Текущий новый host path   | Что необходимо квалифицировать                                                                                                      |
| ---------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Claude SDK | Не реализован этим планом | Native SDK/CLI + local API + authoritative MCP; serial turns/control/restore/context/config; real auth отдельно                     |
| Codex      | Не реализован этим планом | Actual app-server + выбранная configuration + MCP/control/history/usage/evidence; mock transport не заменяет native path            |
| OpenCode   | Не реализован этим планом | Actual поддерживаемый HTTP/ACP profile, config/MCP, shared-host stop, checkpoint/recovery; dialect/profile pin проверяется отдельно |

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
