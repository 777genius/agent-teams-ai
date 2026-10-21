# Этап 1: матрица сохраняемого поведения

Навигация: [программа](README.md) · [фазы реализации](stage-1-legacy-host.md).

Все строки обязательны для полного этапа 1. Это новый acceptance denominator,
а не перенос старых отметок «PASS». Здесь пока нет доказанного legacy-host.
Существующие тесты ниже — oracle поведения; наличие файла не означает его запуска.
На P0 пути и actual baseline сверяются, gaps фиксируются до удаления старого пути.

| ID  | Сохраняемое поведение                                          | Owner / фаза                         | Oracle или seam                                                                          | Критерий приёмки                                                                                                             |
| --- | -------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| M01 | Team create/config/delete, solo/team, роли и состав            | Team; P2/P4/P6                       | `TeamProvisioningServiceRoster`, `TeamProvisioningMemberIdentity`, TeamCreate/TeamDelete | Стабильные identities; duplicate не создаёт второго ресурса; add/remove/restart сохраняют guards                             |
| M02 | Launch/bootstrap, provider/model selection, readiness          | Team + Runtime; P3/P4                | `TeamProvisioningRuntimeLaunchSelection`, `TeamProvisioningMemberMcpConfig.safe-e2e`     | Каждый member связан с actual session/config/tools; registered/briefing/PID не означают ready                                |
| M03 | Task CRUD/comments, assign/claim/dependencies/reopen           | Team; P2/P6                          | `TeamTaskWriter`, legacy Task tools, MCP handlers                                        | Сохраняется действующая модель; current authority/assignment; duplicate/conflict/partial outcome не повторяет эффект         |
| M04 | Human DM/agent reply и peer messages                           | Team + Runtime; P4                   | `TeamInboxReader`, `TeamInboxWriter`, `TeamMessageFeedService`                           | Human→B→human и A→B→A доходят exact recipient; explicit reply, нет lead echo/двух dispatchers                                |
| M05 | Group и cross-team messages                                    | Team; P2/P4                          | `CrossTeamService`, `CrossTeamOutbox`, `groupMailbox`                                    | Сохраняются адресаты/права/group semantics; duplicate recipient не получает второй эффект; нет cross-owner adoption          |
| M06 | Technical permissions/questions + product approvals            | Runtime / Team соответственно; P3/P4 | Codex approval fixtures, existing approval transports/UI                                 | Pending request не заблокирован prompt queue; late/revoked/post-abort decision не выдаёт grant; product decision отдельно    |
| M07 | Targeted interrupt, cancel, team/member stop                   | Runtime + Team policy; P3/P4         | `TeamProvisioningProcessExit`, provider control tests                                    | Late interrupt A не отменяет B; close seal/drain/custody, shared backing не убивается целиком                                |
| M08 | Input ordering, unknown effects и restart reconciliation       | Runtime; P3/P8                       | Existing command ledger/recovery, native handoff fixtures                                | Durable identity до handoff; lost ACK/crash не вызывает второй submit/create; UNKNOWN остаётся held                          |
| M09 | Explicit resume выбранной session                              | Runtime + Driver; P3/P4              | Existing checkpoint/session fixtures                                                     | Сохраняется exact выбранная history либо honest incompatible/missing; no continue-latest/fresh-as-resume                     |
| M10 | Context/compaction, project instructions, skills/hooks/tools   | Team config + Driver; P4/P6          | `TeamProvisioningServicePostCompact`, selected config/briefing builders                  | Role/team instructions и разрешённые settings сохраняются после compaction; конфликты не маскируются                         |
| M11 | Live logs, deltas/complete, internal messages/chunks/subagents | Host projections + Desktop; P5/P6    | `TeamMemberLogsFinder`, member-log-stream, chunk/filter tests                            | Нет дублей blocks/ложной attribution; сохранены isMeta/internal semantics; source gap виден                                  |
| M12 | Structured TaskRef и переходы по ссылкам                       | Team + Desktop; P2/P5/P6             | `taskReferenceUtils`, request/ref fields из CLAUDE.md                                    | Exact task/team identity переживает messages/comments/descriptions/restart; display number не identity                       |
| M13 | Task changes, Git evidence/review/apply/reject/comments        | Team evidence/review; P6             | `taskChangeLedger`, `review.test`, `ReviewMutationCrash.safe-e2e`                        | Actual TEST bytes относятся к exact task/window/workspace; conflict/crash не теряет решение; не SDK checkpoint вместо ledger |
| M14 | Tokens/cost/context usage и уведомления/quick actions          | Projections + Desktop; P5/P6         | Existing usage/context/notification features                                             | Реальные units/fields и фильтры; unknown не 0; action идёт original owner/task, нет выдуманных usage/results                 |
| M15 | Provider detection/config/auth UI, profiles/extensions         | Host adapters + Desktop; P5/P6       | Existing runtime-provider-management, extension/runtime paths                            | Предыдущий user workflow имеет работающего преемника; required settings не теряются; secrets остаются private                |
| M16 | Saved teams/archive/import и active legacy obligations         | Desktop + exact old owner; P5/P7     | launch/bootstrap/lane/stop/recovery records                                              | Archive read-only без execution; corrupt/unreadable HOLD; unresolved request IDs сохранены; import не запускает работу       |
| M17 | Packed install/bootstrap и supported OS tuples                 | Composition/package; P7              | Existing dist/ASAR/native executable checks                                              | Host-owned flows работают без fork/sibling checkout; SDK/CLI и Node разрешаются; stdout чистый, cleanup scoped               |
| M18 | Desktop routing/reconnect/feeds, IPC/HTTP, target change       | Desktop; P1/P5/P8                    | Existing app API/provisioning/ledger tests                                               | Original owner/generation до mutation; snapshot/gap и late-result guards; transport failure не включает legacy fallback      |

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

Mixed-provider team проверяет ровно используемые композиции. Не нужен бесконечный
Cartesian product моделей/OS; необходимы все реально заявляемые provider paths и
различающиеся transport/custody/config guarantees. Один TEST team из двух members
проверяет независимые turns/DM/stop; отдельный TEST team нужен для cross-team.

Фикстура inferencing не выполняет настоящую модель, но native CLI/SDK/MCP, host,
persistence и Desktop должны быть реальными. Реальный provider auth/inference,
subscription login и release availability отмечаются только при отдельном proof.

Если текущий baseline содержит ещё важный сценарий, он добавляется сюда с owner
и acceptance. Нельзя сужать матрицу до списка функций нынешнего provider package.
Также не нужно переносить все hidden CLI flags/upstream internals без app consumer.
