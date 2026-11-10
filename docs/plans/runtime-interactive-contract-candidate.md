# C: кандидат интерактивного runtime-контракта

> **Исторический frontend candidate C.** Не изменяет принятые contracts/ADRs
> runtime и не является текущим implementation prerequisite. Актуальная
> [двухэтапная программа](provider-migration/README.md) использует provider SPI
> через независимый legacy-host, а будущий runtime подключается на этапе 2.
> Датированные статусы и baseline ниже сохранены как source/evidence context.

Дата: 21 октября 2026. Статус: **proposed; не admission, не accepted ADR и не qualification**.
Владелец технической семантики: Agent Execution в `agent-teams-ai/agent-runtime`.
Основание: [план A–F](runtime-provider-extraction-and-claude-sdk-plan.md), этапы B/C; полный migration goal A–F сохраняется.

## 1. Исходные факты и authority

Canonical baseline: `agent-runtime@efd3348f361fa6af84953325af5c0d2d8677d14a`.
Незакоммиченный checkpoint B находится в worktree `runtime-provider-extraction-B`, package `experiments/interactive-provider-contract`.
Его `./draft-contracts` принадлежит runtime-потребителю, `./claude` содержит конкретный SDK adapter.
Исследованный B pin: SDK **0.3.305**, CLI **2.1.305**, experimental Zod **4.6.7**; это не обновление production pins.
По отчёту исполнителя выполнены synthetic tests, packed consumer и actual SDK/CLI E2E с localhost Anthropic fixture.
Этот документ не повторяет проверки и не выдаёт fixture-provider E2E за реальные Anthropic/auth или production evidence.
Перед delivery B необходимо привязать результаты к exact reviewed source и проверить CI admission.

Применимые принятые нормы сохраняются:

- [ADR-0008](https://github.com/agent-teams-ai/agent-runtime/blob/efd3348f361fa6af84953325af5c0d2d8677d14a/docs/decisions/0008-private-embedded-runtime-access-entrypoint.md): trusted scope-bound access; concrete wiring у composition owner.
- [ADR-0009](https://github.com/agent-teams-ai/agent-runtime/blob/efd3348f361fa6af84953325af5c0d2d8677d14a/docs/decisions/0009-contained-turn-private-access-and-host-shutdown-boundary.md): caller abort, durable cancellation и Host disposal имеют разные значения; exit не заменяет receipt.
- [ADR-0010](https://github.com/agent-teams-ai/agent-runtime/blob/efd3348f361fa6af84953325af5c0d2d8677d14a/docs/decisions/0010-contained-agent-turn-v1-operation-authority.md): существующий contained-turn имеет один fresh attempt, без reuse/resume/fallback. Его контракт не расширяется данным кандидатом.
- [ADR-0090](https://github.com/agent-teams-ai/agent-runtime/blob/efd3348f361fa6af84953325af5c0d2d8677d14a/docs/decisions/0090-ordinary-user-session-codex-execution-profile.md): существующий ordinary Codex profile не становится универсальным persistent profile.
- [Программа, решения 1/32 и исключения §8.1](https://github.com/agent-teams-ai/agent-runtime/blob/efd3348f361fa6af84953325af5c0d2d8677d14a/docs/architecture/agent-runtime-architecture-program-plan.md): Claude rewrite, streaming, resume и approvals пока вне активной программы; contained frozen.
- [FMS adoption](https://github.com/agent-teams-ai/agent-runtime/blob/efd3348f361fa6af84953325af5c0d2d8677d14a/docs/architecture/feature-module-standard-v1-candidate.md#new-production-features): новая production capability требует scoped ownership/adoption, enforcing checks и rejecting fixtures; green старого scope недостаточен.

Это основания для successor request ниже, а не утверждение, что старые ADR уже разрешают interactive production.

## 2. Минимальный предлагаемый C scope

Отдельная Agent Execution feature `interactive-agent-session`, без правок поведения frozen `contained-agent-turn`.
Один declared platform/credential/SDK tuple, один runtime Host, один writer, один активный turn на session.
Provider driver реализует consumer-owned SPI; runtime владеет техническими identity, admission, durable input/output и recovery decisions.
Orchestrator остаётся владельцем teams/tasks/messages/product approvals; C подключается через fixture consumer/tools host.
Нет scheduler, нового agent loop, universal manager, второй storage platform, supervisor, DI framework или автоматического backend fallback.
Existing Codex path сохраняется; новый Claude path не объявляет Codex interactive parity.

## 3. Минимальные данные и публичные команды

Trusted access связывает tenant/project/scope/authority revision до dispatch; payload не выбирает чужую identity, credentials или executable.
Ни SDK DTO, ни native session ID, ни raw filesystem paths не входят в ordinary caller API.

| Контракт        | Минимальная семантика                                                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session         | Runtime `sessionId`, generation, immutable config/binding revision, required/confirmed capabilities; состояние `opening/ready/unavailable/closing/closed/reconcile_required` |
| Operation/Input | Stable command/input ID, runtime operation ID, session generation, canonical content fingerprint, delivery intent и отдельные handoff/outcome факты                          |
| Interaction     | Runtime request ID, session generation, operation binding если доказан, kind `permission/question`, expiry/cancellation; provider reference private                          |
| Checkpoint      | Private opaque provider payload + codec/engine/config/workspace/account binding compatibility; runtime хранит, caller получает opaque ref                                    |
| Event           | Runtime-owned sequence/cursor, session/generation; operation/input optional при недоказанной attribution; typed text/tool/usage/outcome/interaction/dependency facts         |

Предлагаемые commands: `openSession`, `submitInput`, `replyInteraction`, `interruptOperation`, `closeSession`, `restoreSession`; read: `observeSession`.
Это один cohesive capability, а не сервис/интерфейс на каждую команду. Имена окончательно принимает runtime.
Мутации получают stable command identity; identical replay возвращает прежний receipt, conflicting fingerprint отказывает без нового эффекта.
`submitInput` возвращает durable admission receipt до окончания turn; caller abort снимает ожидание, не отменяет принятую работу.
`observeSession` различает snapshot/replay и явный gap; driver iteration не является долговременным feed/cursor.
Технический `result` закрывает turn, не завершает Work/задачу продукта.
Restore проверяет exact compatibility и создаёт новое generation binding; missing/incompatible checkpoint отказывает, старые callbacks/grants не восстанавливаются.

## 4. Один durable owner и граница handoff

Agent Execution owns session/input/control records и их один узкий store port; адаптер сообщает commit certainty, use case решает readback.
В первом C нет второго backend и универсального repository. In-memory реализации разрешены для focused contract tests, не для durability claim.
До handoff атомарно сохраняются scope/generation, input fingerprint, admission и delivery intent; один claimant получает dispatch authority.
Очередь runtime ограничена; SDK driver имеет только bounded volatile handoff queue и один read loop.
States delivery различаются: `admitted`, `known_not_sent`, `handoff_unknown`, `sdk_consumed`; provider acceptance остаётся отдельным наблюдением.
Crash между delivery intent и подтверждением handoff не разрешает повторный `submit` с новым ID.
После restart owner читает свой state и доступное provider evidence: доказанный not-sent разрешает policy-controlled dispatch; иначе `reconcile_required`.
Нет автоматического replay unknown input, смены account/model/backend или скрытого fresh session.
Отменённая operation не переоткрывается; повтор работы имеет новую successor identity с явной связью.
Пока recovery не доказал безопасное продолжение generation, следующие inputs не передаются SDK.

## 5. Независимый control и truthful shutdown

`replyInteraction` обходит prompt queue: заполненная очередь/ожидающий turn не блокируют ответ на его callback.
Permission decision и structured question answers имеют разные validated payloads; authority проверяется runtime/Orchestrator до driver.
Ответ связывается с request ID + session generation + operation/expiry. Late, duplicate-conflict и post-abort response не дают grant новому callback.
SDK `canUseTool` не является проверкой каждого auto-approved tool; authoritative MCP handler/hook сохраняет enforcement.
`interruptOperation` проверяет exact active binding и сериализуется с result и следующим handoff.
Запоздалый interrupt A после result A не затрагивает queued B; unresolved control не открывает B.
Receipt `requested` не означает `cancelled`; provider terminal и runtime closure/reconciliation учитываются отдельно.
`closeSession` синхронно запечатывает admission, освобождает waiters, присоединяет повторные close к одному bounded shutdown.
Runtime-owned launcher/custody, а не driver SDK close, подтверждает завершение принадлежащих session ресурсов.
Missing drain/process proof означает cleanup debt/unknown и `reconcile_required`, без чистого stop receipt.
Для shared backing host допускается только session-scoped stop; чужой member/host не завершается.
Output/input/event/interaction bounds и timeouts задаются immutable config; overflow сохраняет typed terminal/uncertainty даже при slow observer.
Host disposal не стирает durable obligations; raw credentials/checkpoints/provider errors не становятся событиями/логами.

## 6. Draft B → принятый SPI и обычная provider-библиотека

B `Session.submit/observe/respondToInteraction/interrupt/checkReadiness/checkpoint/close` — доказуемый draft, не public runtime API.
В C runtime adapter связывает эти методы с canonical IDs/generation и durable owner; `sdk-consumed` остаётся handoff фактом.
Добавить явно типизированные runtime-owned open/restore/config/capability contracts; concrete `ClaudeConfig` и SDK spawn type не экспортировать core.
B generic failures уточнить лишь там, где consumer должен различать stale target, acceptance uncertainty, dependency failure и cleanup debt.
Не преобразовывать `CloseReceipt.cleanup` в физическое containment обещание сильнее подтверждённого Host profile.
SPI публикуется через curated contracts entrypoint runtime, без deep import; отдельный contracts package только если реальный dependency graph требует его.
Driver subtree один раз переносится из experiment в обычную provider library с отдельными concrete factories; имя/location ещё требуют фиксации.
Библиотека зависит только от contract entrypoint; runtime composition подключает factories. Не возникает cycle через runtime root или цепочки full runtimes.
Fixture host, package helpers и SDK session state не превращаются в второе runtime/core. Algorithm copies после move не поддерживаются.
ar не включается как запасной SDK-free backend: его default также SDK; новый backend требует своего capability evidence.

## 7. Что уже есть и что действительно предстоит сделать

| Основание                                         | Reuse / ограничение                                                                                 | Новая C работа                                                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| B driver и localhost SDK/CLI harness              | Serial handoff, normalization, MCP, replies, targeted interrupt, explicit checkpoint, bounded close | Runtime ID/generation adapter; тот же suite на реальном runtime boundary                                        |
| `ordinary-ports.ts` / operation store             | Consumer-owned persistence, explicit commit uncertainty, claim и cancellation patterns              | Persistent session/input/control/checkpoint schema и owner-specific transactions; не расширять Codex tuple cast |
| Embedded trusted access / ordinary Host resources | Scoped capability, ownership/cleanup ordering, retained cleanup debt                                | Новый отдельно admitted access capability и Host assembly/lifecycle adoption                                    |
| Provider Access / Runtime Security                | Существующие authority boundaries и private credential projection                                   | Scoped Claude credential/config/tool authority и exact selected route; fake tokens не qualification             |
| Existing custody/process adapters                 | Разделение process owner и protocol                                                                 | Подтвердить launcher/stop для выбранного interactive tuple; не копировать generic supervisor                    |
| Foundation/FMS/Get Modular                        | Existing owned profiles/checks                                                                      | Review текущего CMS pin delta; scoped graph/exports/roots + rejecting checks, без blanket exclusions            |

`process-runtime` применим к конечным probes, не заменяет persistent stdin, session custody или tree cleanup.
Полное Orchestrator core/desktop, extraction OpenCode/Codex и removal fork остаются следующими A–F deliverables.

## 8. Конкретный successor request и открытые решения

**R1 — canonical scoped admission:** владелец явно поручил выполнить весь согласованный A–F автономно, включая bounded interactive Claude C slice. Это основание подготовить и проверить successor к ограничениям программы §§1/8.1; canonical статус документа меняется только штатным protocol после review, frozen ADR bytes сохраняются.
Запрос охватывает persistent session, streaming, scoped resume, interaction replies и новый consumer-owned driver SPI только данного scope.
Frozen contained-turn/ADR-0010 и existing ordinary records/guarantees сохраняются; accepted bytes не переписываются.
Для принятия подготовить canonical successor ADR, FMS/CMS scope и rejecting evidence; данный frontend candidate ничего не принимает.

**R2 — real-provider/deployment claim пока недоступен:** владелец сообщил, что тестового Claude-доступа пока нет, и поручил максимально использовать fixtures/mocks. Секреты не запрашиваются повторно. Для будущей real qualification потребуется зафиксировать platform/Host assurance/credential route tuple.
Предлагаемый ближайший qualification scope — один disposable same-host tuple и explicit разрешённая test credential projection, без subscription onboarding claim.
Cooperative same-user cleanup не выдаётся за hostile-user containment. Выбор SDK не разрешает автоматически third-party claude.ai login/limits.
Имена provider library/contract export и сроки retention — implementation proposals для successor review, не повод вводить вторую storage platform.
Многопользовательский/remote deployment и public subscription onboarding не входят в ранний C claim; отдельные принятые требования не ослабляются.

В рамках уже порученного A–F продолжаются scoped successor/adoption, реализация нового отдельно owned feature и synthetic integration. Непредусмотренные consequential forks остаются вне этой авторизации.
До R1 нельзя включать experiment в production Host или расширять frozen provider path. До R2 можно доказывать synthetic integration, не real route qualification.

## 9. Ближайший C checkpoint и приёмка

После R1: один coherent slice `durable submit → claim → B driver → normalized observation → independent reply/targeted interrupt → truthful close`.
Он использует production owner/storage boundary и fixture provider/tools; затем тот же harness проверяет выбранный real-provider tuple после R2.
Минимальные rejecting cases: identical/conflicting command; crash до/после handoff; lost receipt; restart; wrong scope/generation; late interrupt A/queued B;
full prompt queue с pending interaction; late/duplicate reply; missing MCP; expired authority; slow output/overflow; missing checkpoint; failed custody close.
Наблюдаемое PASS: один accepted input не исполняется повторно из-за lost response; next handoff не обгоняет control; unknown остаётся явным;
closed session не принимает input; output привязан только доказанным identities; чужая session продолжает работу после target stop.
Fake contract PASS, SDK/CLI localhost PASS и реальный provider PASS фиксируются раздельно, с exact source/SDK/CLI/platform и cleanup evidence.

Имеющиеся B команды: `pnpm --filter @agent-teams/interactive-provider-contract-experiment check`, `test:sdk-process`, `test:packed` через `pnpm --filter … <script>`.
Canonical C commands выбираются по фактическому scaffold: focused owner/store/driver suite, `pnpm check:changed`, `pnpm check:fast`, обязательный `pnpm check` и docs/adoption gates.
Новый package/entrypoint требует реального compiler project, source boundary, package consumer и CI census admission; commands не считаются выполненными этим документом.
Live harness запускается только отдельно и opt-in в новом TEST root после scope/auth проверки; credentials не входят в документ/evidence.
Production Host integration, real provider qualification, Orchestrator tools, desktop E2E и окончательный fork removal отмечаются отдельными результатами C–F.
