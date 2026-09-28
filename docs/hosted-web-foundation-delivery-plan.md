# PR #252: общий Desktop/Hosted foundation и playbook переноса экранов

Дата: 2026-09-28. **Статус: принятый контракт реализации PR #252.** Пользователь поручил довести выбранный ниже объём end-to-end. Три предыдущих независимых Astra xhigh review/fix раунда зафиксированы в [review log](hosted-web-foundation-review-log.md); они относятся к прежней редакции, а не автоматически подтверждают новые уточнения ниже. Реализация и live acceptance проверяются отдельно по exact SHA.

Baseline первоначального исследования: Product PR `777genius/agent-teams-ai#252`, head `e5f7d5890a2de3ed03b0ef43119081fbae1c33fd`. Повторная source-проверка этой редакции: `029cf5e5fb9ddbf1321a09b765e8f27a996aaab0`. Перед каждым writer checkpoint сверять актуальный PR head/main через `gh`; эти SHA остаются provenance исследования. Оценки ниже prospective, не измеренный будущий diff.

Проверка при составлении плана: чтение exact source, contracts, package scripts, CI и canonical docs. Этот документ сам по себе не является runtime proof. На baseline PR был draft, `mergeable: CONFLICTING`; integration с актуальным main и финальные проверки обязательны.

## 1. Результат и рамки решения

**Предлагаемая архитектура:** один владелец каждого перенесённого доменного правила и пользовательского flow; два composition roots, Desktop и Hosted; узкие adapters к существующим effect owners; общий UI после общего поведения там, где действительно совпадает представление.

Первая цель ограничена:

1. **F0:** сделать canonical правила, навигацию документов и проверяемые public surfaces однозначными.
2. **F1:** перенести review/history/task-column/move/approve/dependency semantics в чистый публичный subpath существующего `agent-teams-controller`; реально подключить Product Desktop readers/mutations, Hosted projection и Hosted controller executor.
3. **F2:** один feature-owned create/outcome controller используется двумя существующими формами. Он сохраняет identity, отделяет mutation ACK от refresh и переживает смену capabilities/экрана. Общая JSX-форма в этот checkpoint не входит.
4. **D1/N1:** внедрить этот подход на Dashboard и Team Chooser в двух production compositions. Это конкретные read/navigation slices, без добавления недостающего Hosted backend ради визуальной похожести. Остальная адаптация этих экранов получает отдельный описанный slice после D1/N1, а не пустые D2/N2 checkpoints.

**Одна линия доставки:** итоговый PR #252 остаётся единственным PR в `main`. Малые review PR допустимы только в его head-ветку либо через явно обозначенный stack, который в итоге вливается в неё. Не открывать replacement PR, не терять историю ревью или авторство. Название существующей ветки сохранить. Новые ветки используют правила проекта и conventional prefix без `codex/`.

Ни F1+F2, ни D1+N1 не означают полную унификацию messages, roster, lifecycle, rich task details, всех настроек и всего Desktop App. У каждого остатка ниже указан следующий slice.

### 1.1. Что входит в #252 автоматически, а что требует изменения product scope

| Класс работ | Статус | Правило включения |
|---|---|---|
| Accepted Core v1: поддержанные task/message/lifecycle/workspace/auth/SSE flows и их обязательные acceptance gates | Уже принят | Сохранять и довести доказательства по scope lock |
| F0/F1/F2 | Выбранный architecture increment | Реализовать в #252, не создавая новые Hosted product capabilities |
| D1/N1 | Выбранные Dashboard и Team Chooser slices | Реализовать в #252 в обоих production compositions |
| Остальные screen migrations | Roadmap с оценками, не обязательный prerequisite F1/F2 | Можно выбрать в той же линии #252; уточнить bounded scope каждого slice |
| Deferred Hosted capabilities: full change review, attachments, member mutation, terminal и прочее из scope lock | Не приняты в Core v1 | До реализации обновить scope lock конкретным product решением, минимальным surface, security/recovery последствиями и browser acceptance |
| Релиз/публикация | Отдельное действие | Готовность проверяет агент; публикация требует отдельного разрешения owner |

`docs/hosted-web-core-v1-scope-lock.md` явно не требует реализации каждого исторического Electron экрана или всего `TeamsAPI`. Просьба о едином PR определяет delivery line, но не превращает deferred capabilities в принятый scope. Не переносить выбранные работы в независимые PR в main вопреки этой линии и не расширять её до 40-71k LOC молча.

### 1.2. Порядок без обязательного большого refactor перед MVP

Практическое решение зависит от ближайшей цели:

- **Targeted MVP fixes, затем foundation в той же линии #252:** исправить доказанные outcome/lifetime/semantic дефекты короткими правками, сохранить debt inventory и завершать accepted gates. Подходит, если упаковка shared semantics временно блокирует delivery. 🎯 9/10 🛡️ 8/10 🧠 3/10; архитектурная добавка примерно 0.8-2k changed LOC. Не объявлять foundation готовым.
- **F0/F1/F2, затем D1/N1 в #252:** рекомендуемый план для запрошенного общего фундамента. Фиксы входят в extraction, отдельный пакет тех же fixes не прибавляется. 🎯 9/10 🛡️ 9/10 🧠 6/10; текущая оценка foundation 5.45-9.79k, foundation + два первых slices + integration 8.75-15.5k changed LOC до main-conflict reserve и all-facets F0b ratchet.
- **Все перечисленные экраны до merge #252:** возможен только с явным bounded backlog и promotion deferred capabilities по необходимости. 🎯 5/10 🛡️ 8/10 🧠 9/10; прежний ориентир 39.5-70.5k учитывал меньший foundation. С учётом move/recovery/reset seam ориентир порядка **42-75k changed LOC**, точность 3/10; optional remote capabilities отдельно. Не рекомендуется как скрытое условие готовности foundation.

**Scope этой работы зафиксирован:** F0/F1/F2, D1/N1, main integration I0, final I1 и ранее принятый Core v1 acceptance. F0b all-facets ratchet, оставшиеся экраны и deferred Hosted capabilities не являются скрытым условием сдачи; выполнять их только если конкретный gate докажет необходимость для выбранного vertical slice. Не требуется задавать owner вопросы о названиях файлов, reducers, React hooks или механике adapters. Решения ниже являются рабочими defaults. Вопросы нужны только о новой product capability либо о семантике, для которой конфликтующие существующие контракты не дают ответа.

## 2. Проверенная карта текущего кода

Пути в таблицах проверены в рабочем дереве `029cf5e5fb9ddbf1321a09b765e8f27a996aaab0`. Новые кандидаты явно обозначены как предлагаемые. Для реализации повторно проверить их после merge main.

| Участок | Реальные source seams | Что важно сохранить/исправить |
|---|---|---|
| Desktop review semantics | `src/shared/utils/reviewState.ts`, `taskHistory.ts`, `teamTaskState.ts`; `team-task-board/core/domain/policies/taskMutationReviewPolicy.ts` | Есть самостоятельные вычисления history, review fallback, workflow columns |
| Controller semantics | `agent-teams-controller/src/internal/reviewState.js`, `taskLifecycle.js`, `hostedBoardProjection.js`, `hostedTaskCommand.js` | Hosted executor снова вычисляет move/approve/blockers; projection зависит от identity/crypto |
| Desktop mutation owner | `team-task-board/core/application/TeamTaskMutationCoordinator.ts`; `main/application/TeamTaskStartCoordinator.ts`; `task-board-commands` | Не переносить записи/уведомления в браузер; start и update-status имеют разные эффекты |
| Desktop create interaction | `CreateTaskDialog.tsx`, `createTaskCommandIdentity.ts`, `createTeamTaskBoardActions.ts`, `TeamDetailView.tsx`, `useGraphCreateTaskDialog.tsx` | Identity уже есть, но lifetime формы, outcome/refresh и callbacks распределены |
| Hosted board | `HostedTaskBoardPage.tsx`, `createHostedTaskBoardTransport.ts`, `HostedTeamWorkspace.tsx` | Partial pages, revision/generation, capability advertisement, uncertainty, SSE invalidation |
| Desktop Dashboard | `DashboardView.tsx`, `running-teams`, `recent-projects`, `CliStatusBanner.tsx` | Маленький shell импортирует большие Desktop/store/API зависимости через hooks/banners |
| Desktop Team Chooser | `TeamListView.tsx`, `teamProjectSelection.ts`, `teamListPresentation.ts`, `teamListStatus.ts`, `createTeamNavigationSlice.ts` | Search/order/filter/project placement, provisioning overlays, tabs и commands связаны в legacy view |
| Hosted Chooser/shell | `HostedApplicationShell.tsx`, `HostedTeamWorkspace.tsx`, `HostedTeamLifecycleList.tsx`, `useTeamLifecycleList.ts`, `loadTeamLifecycleList.ts` | Workspace/session admission, canonical opaque IDs, revision-pinned pagination, SSE bootstrap |
| Browser build | `docker/vite.hosted-renderer.config.ts` | Task-board barrel подменяется двумя exports; отдельная SSE chunk isolation имеет свою причину |
| Guards | `scripts/ci/feature-architecture-policy.mjs`, `feature-source-files.mjs`, `feature-architecture-baseline.json` | Direct facets разрешены, но не все распознаются как public entrypoints для transitive анализа |

### 2.1. Доказанные различия, которые план не скрывает

1. `{status: 'completed', reviewState: 'needsFix'}` без history даёт `needsFix` в Product и `none` в controller. Product expectation уже зафиксирован в `test/shared/utils/reviewState.test.ts`. Default решения: сохранить Product correction state; независимо проверить его влияние на `finishedForDependency`, columns, approval и completed notifications. Нельзя заменять fixtures сравнением двух текущих реализаций.
2. `teamTaskState.ts` трактует отсутствующего blocker в переданной map как блокирующего. Hosted executor после authoritative `TASK_NOT_FOUND` считает его отсутствующим. Это разные знания, не повод заменить оба на `map.get(id) ?? null`.
3. `createTeamTaskBoardActions.createTeamTask` ждёт refresh после записи. Его rejection не сообщает, была ли запись подтверждена. F2 разделяет эти факты.
4. `HostedTeamWorkspace` меняет `taskBoardMutationsEnabled`, пересоздаёт transport; cleanup board обнуляет `pendingMutation`. Потерянный ответ и capability withdrawal могут удалить unresolved intent. Нужен тест всей workspace composition.
5. Desktop create уже имеет `ApplicationCommandRequestIdentity`: форма создаёт UUID/idempotencyKey, IPC их валидирует, `TeamTaskStartCoordinator` вызывает durable `task-board-commands` с `findById`, `findByIdempotencyKey`, optional `reconcileTaskCreation`. Нельзя считать Desktop create принципиально недедуплицируемым. При этом renderer API возвращает `TeamTask`, а не универсальный command receipt/CAS token.
6. Desktop `TeamDetailView` и graph create hook дополнительно вызывают best-effort notify lead после create. Это ещё один effect path; повтор по lost ACK не должен незаметно удваивать его. Owner/controller task write и Owner message relay остаются единственными соответствующими Hosted effect owners.
7. Hosted lifecycle list содержит `workspaceId`, `teamId`, `displayName`, `lifecycle`, `revision`. В нём нет Desktop description, member roster, branch, task counts, activity timestamp или filesystem project path. Не фабриковать `TeamSummary` для общей карточки.
8. `createTeamLifecycleCommandFeature` сам по себе не доказывает reuse: реальные launch compositions должны быть проверены по consumers. Уже используемый `planTeamRuntimeLanes` сохраняется.

### 2.2. Измеренный размер швов и источник оценки

Это физические строки существующих файлов на проверенном SHA, включая комментарии и пустые строки. Они показывают размер затрагиваемой поверхности, **не** число новых строк, не остаток реализации и не процент готовности.

| Source seam | Измерено строк | Следствие для реализации |
|---|---:|---|
| `src/renderer/components/team/TeamDetailView.tsx` | 3,612 | F1/F2 извлекают callbacks; не добавлять registry/controller внутрь legacy view |
| `src/renderer/components/team/TeamListView.tsx` | 1,511 | N1 переносит read path, сохраняя внешние dialogs/actions; файл должен уменьшиться |
| `src/features/team-task-board/renderer/components/HostedTaskBoardPage.tsx` | 800 | Любая новая ответственность сначала извлекается; размер уже на лимите |
| `src/renderer/components/team/HostedTeamWorkspace.tsx` | 676 | Интегратор владеет changes F2/D1/N1; shared state вынести из JSX composition |
| `src/renderer/components/team/dialogs/CreateTaskDialog.tsx` | 530 | Сохранить rich inputs; вынести submit ownership без общей JSX-формы |
| `src/features/team-task-board/main/adapters/output/HostedTaskBoardMutationAuthorityAdapter.ts` | 514 | Rebase cleanup локален; остальной admission protocol не переписывается |
| `src/main/composition/hosted/hostedTaskBoardReadFileSource.ts` | 390 | Recovery lookup расширяет существующую descriptor-bound read boundary |
| `src/renderer/hosted/HostedApplicationShell.tsx` | 239 | Composition location для F2 registry выше keyed workspace |
| `running-teams`: policy / Desktop hook / UI | 99 / 185 / 73 | Малый JSX не означает малый dependency graph; извлекаются hook dependencies |

Fresh merge preview, полученный интегратором без изменения checkout: PR head `029cf5e5`, main `2203eb7066be606a6f29caeeb30ed29e7cc33d2f`, merge base `53ae92e6f4285db163f6d87eca128fe03a34efb1`, **29 конфликтующих файлов** по `git merge-tree --write-tree`; отдельный трёхсторонний preview содержит **109 conflict-marker hunks**. Это mechanical preview count, не число самостоятельных дефектов и не changed LOC. Среди них `src/main/ipc/teams.ts`, `src/renderer/store/slices/teamSlice.ts`, `src/shared/types/api.ts`, message composer, CreateTeamDialog/model-selector/provisioning, tests/config. Это измеренное количество файлов, а не оценка сложности каждого конфликта. I0 пересчитан в разделе 12; early integration нужен до changes в этих общих API.

### 2.3. Краткая карта исполнения выбранных flows

```text
Desktop read -> Product shared compatibility facade ─┐
Desktop command -> feature coordinator -> controller ├-> controller/task-semantics (pure)
Hosted read -> descriptor-bound source -> projection ┤
Hosted command -> Product admission -> Owner -> controller ┘

Desktop CreateTaskDialog (Detail + Graph) ─┐
HostedTaskBoardPage create form ────────────┴-> one CreateTaskInteractionController per scope/team
                                             -> Desktop IPC adapter | Hosted HTTP adapter
                                             -> existing write owner -> typed outcome
                                             -> independent refresh projection

Desktop store/alive/provisioning -> normalized facts ─┐
Hosted lifecycle snapshot -> normalized facts ────────┴-> running-teams / team-directory
                                                        -> shared view -> shell openTeam intent
```

`task-semantics` не знает об interaction controller; read features не зависят от create/mutation feature; ни один общий UI не импортирует Desktop store или Hosted application shell. Это набор конкретных связей, не новый общий framework.

## 3. Инварианты и границы

### 3.1. Владельцы

| Ответственность | Владелец | Внешний код делает только |
|---|---|---|
| Review/history/task state/move decision | Public pure task-semantics существующего controller package | Нормализацию raw inputs, сбор честных facts, выполнение решения |
| Create submitted intent/outcome | `team-task-board/core/application` | Показ/подписку, платформенные преобразования и HTTP/IPC |
| Task write/CAS/lock/deduplication | Существующий Desktop coordinator/command facade; Hosted Owner/controller | Product Hosted proxy/admission остаётся read-only относительно task storage |
| Provider/message delivery | Существующие runtime/message owners | UI показывает отдельное delivery state, не добавляет второй relay |
| Dashboard running selection/sort | Existing `running-teams/core/domain` после нормализации | Desktop/Hosted источники предоставляют факты разной полноты |
| Chooser search/filter/order/select intent | Новый bounded `team-directory` feature | Shell адаптирует navigation в tab или admitted Hosted selection |
| Auth/grants/lease/mount/restore generations | Existing Hosted access/composition/adapters | Shared controller получает opaque scope и availability, не cookies/credentials |

### 3.2. Scope, identity, lifetime

Feature scope задаётся composition, не именем открытого компонента. Минимальный внутренний reference: opaque `scopeKey`, `teamKey`, `authorityEpoch`. Desktop adapter привязывает их к текущему local runtime context и teamName; Hosted adapter привязывает к deployment/workspace/team/authority generations. Не выводить raw path в browser и не мигрировать все persisted Desktop team identities ради F2.

- Один create session на scope/team в рамках authenticated shell. Hosted registry живёт в `HostedApplicationShell` **выше** keyed `HostedTeamWorkspace` (`key={selectedWorkspaceId}`); workspace получает handle. Desktop registry живёт в team renderer composition выше lifetime `TeamDetailView` и graph dialog, с ключом `activeContextId + teamName + authorityEpoch`; оба Desktop consumers получают один handle. Переход A -> B снимает view subscription A, но не уничтожает её unresolved command; при возврате B -> A прежний session доступен до решения.
- Authority epoch меняется при реальной смене host/workspace authority, logout/reset/restore. Это запрещает новые effects и очищает sensitive projections. Смена `available -> unavailable` на том же scope не создаёт новый session и не стирает intent.
- Read cancellation отменяет наблюдение. Она не доказывает отмену отправленной mutation. Process cancel/stop являются отдельными доменными commands.
- Late result A может обновить только session A с совпадающим epoch. Он не закрывает форму B и не меняет draft/error/selection B.
- Registry не является глобальной платформой: маленький map feature sessions в composition, явное dispose на смене authority/logout; settled неиспользуемые sessions удаляются. Unresolved sessions не выселяются таймером молча. Если нужен лимит, он ограничивает новые submits и показывает unresolved список, а не выбрасывает identity.
- Hard reload не автоматически replay-ит mutations. Серверная recovery существующих Hosted commands сохраняется для тех conversations, где она реально composed; наличие generic ledger не доказывает lookup конкретного task create. Не хранить body, prompt, command locator/idempotency key или replayable receipt в `localStorage`. Persistent browser recovery не строится в foundation.
- Desktop draft persistence можно оставить, но shared controller её не импортирует; pending identity/body не сохраняются этим механизмом без отдельного принятого контракта.

### 3.2.1. Что именно меняет epoch

Не сводить все версии в одно число. Разделить lifetime identity, captured execution fence и read revision, без нового persisted generation protocol:

| Изменение | Что остаётся | Что инвалидируется |
|---|---|---|
| A -> B -> A внутри того же authenticated deployment/context | Session A и frozen intent | View subscriptions/requests A при уходе |
| React StrictMode, transport replacement, capability false/true | Session и identity | Только availability/read observation |
| Новый board revision или SSE resync без смены source/authority | Original frozen intent и разрешённый exact replay | Только freshness projection; старый expectedRevision не переписывается |
| Новый `expectedSourceGeneration` при сохранённой identity workspace/team | Original uncertain envelope как historical intent | Разрешение mutation replay старого envelope; observation использует current read authority |
| Logout/forget-device, deployment change, restore authority reset, утрата workspace grant | Серверное recovery и audit authority | Sensitive client drafts/receipts/subscriptions и разрешение новых effects |
| Desktop context switch local/SSH | Изолированная session исходного context до возврата | Её доступность; запрещён вызов mutable global API, уже переключённого на другой context |

Session key описывает стабильную logical identity внутри живого authentication/context lifetime. Captured execution fence описывает authority **конкретного** submit; его нельзя обновить внутри frozen envelope. Если общий объект `authorityEpoch` остаётся в реализации, adapter документирует, какие source changes являются security reset, а какие лишь делают replay недоступным. Иначе требование «observe после generation change» противоречит уничтожению registry при каждом change.

**Проверенный security reset имеет реальный producer.** Текущий `HostedAuthGate` читает auth status только при mount, а `runtimeIdentity` в `main.tsx` не является наблюдением текущего grant. После 401/403 защищённого task/read запроса Hosted adapter блокирует новые effects и просит AuthGate повторить существующий auth-status read; при неизменной authentication shell делает bounded revalidation выбранного workspace через existing registry/grant read. Только подтверждённый logout/смена principal, deployment/boot authority или успешный grant read, доказавший потерю scope, dispose-ит sensitive registry. 403 от отдельной capability, network/503 и неуспешная revalidation сохраняют frozen uncertain intent и показывают unavailable; автоматического replay нет. Нужен небольшой callback AuthGate -> shell, не global event bus/polling service. При подтверждённом auth reset AuthGate размонтирует shell или меняет переданный auth-scope epoch; keyed registry уничтожается. Проверить это через production composition, а не ручное изменение mock epoch.

Desktop integration использует `activeContextId` и существующее fencing из `contextSlice`/`TeamStateLifecycleCoordinator`. Перед dispatch adapter повторно проверяет captured context, после dispatch поздний результат пишет только в captured session. При недоступном source context recovery ждёт возврата в него; нельзя выполнить старый teamName через API нового context. Это не поручение поддерживать одновременные remote sessions или менять Desktop identity storage.

### 3.3. Capability не boolean HTTP success

Capability имеет две оси: **поддерживается ли операция** и **доступна ли она сейчас**. Recovery policy привязана к конкретному operation+authority, не к наличию произвольного `retry()`.

Пример словаря, не новый generic framework:

```ts
// Конкретные типы живут в team-task-board, без общего application-engine package.
type CreateAvailability =
  | { kind: 'unsupported'; reason: string }
  | { kind: 'unavailable'; reason: string; retryReadAllowed: boolean }
  | { kind: 'available' };

type CreateOutcome =
  | { kind: 'confirmed'; task: CreatedTaskReference; replayed: boolean | 'unknown' }
  | { kind: 'not_applied'; reason: string }
  | { kind: 'conflict'; reason: string }
  | { kind: 'uncertain'; recovery: 'exact_replay' | 'observe' | 'operator_required' };

type ReadFreshness = 'idle' | 'refreshing' | 'fresh' | 'stale' | 'failed';
```

`accepted` добавлять только для реально асинхронного create contract; текущие успешные create receipts являются confirmed. Нельзя объявлять HTTP 202 подтверждением task write.

`conflict` и `not_applied` относятся к **исходному submitted intent** только если authority доказала отсутствие его эффекта. Отказ отдельной recovery-попытки (`stale_generation`, `idempotency_mismatch`, 401/403/503) не доказывает этого: если исходный ACK потерян, session остаётся `uncertain` и переходит к наблюдению/ручному разрешению, а не к новой identity.

Auth/CSRF/Origin/lease/source-generation проверки остаются на границах, в прежнем порядке. Общий controller не предоставляет authority; client availability только помогает UI и не заменяет server admission.

## 4. F0: canonical документы и проверяемые surfaces

**Ownership F0:** architecture docs, dependency/entrypoint guard и его fixtures. Shared shell wiring остаётся у integrator. Guard work не переписывает unrelated legacy edges.

### Шаги

1. Обновить `AGENTS.md` Hosted navigation: current MVP маршрут ведёт к owner decisions scope lock и актуальному delivery plan; r6 `START_HERE.md` указан как parked actual-owner approval packet. Не переписывать исторический body/evidence; не объявлять его `HOLD` blanket запретом на принятый MVP.
2. В `docs/FEATURE_ARCHITECTURE_STANDARD.md` добавить строгие правила из разделов 3-6 этого плана: один semantic/interaction owner для мигрированного flow, два production consumers, no fake DTO/revision, frozen identity, ACK/read separation, honest completeness, public browser graph, removal old active algorithm. Root и feature CLAUDE только ссылаются на стандарт.
3. Уточнить `src/features/team-configuration/README.md`: legacy browser compatibility path и dedicated production Hosted path различаются. Не трактовать все `httpClient` unsupported stubs как отсутствие Hosted backend.
4. Сначала сделать read-only inventory **всех** direct facets (`main/hosted`, `main/composition`, `renderer/hosted`) и их exports. Нынешний classifier видит только `index`; глобальное включение direct facets сразу обнаружит старые reexports HTTP/storage adapters примерно в двадцати facets. Не объявлять весь backend cleanup частью F0 с прежним бюджетом, не переименовывать файлы для обхода и не расширять baseline. Отдельный F0b ratchet описать по фактическому inventory: какие public contracts требуется мигрировать в facade, какие старые exact edges остаются как debt, и сколько это стоит. F0b остаётся отдельным backlog после этой оценки; включается только если выбранный consumer не проходит обязательный guard без устранения конкретного legacy edge. Inventory сам по себе не делает all-facets cleanup обязательным.
5. Для первого browser slice очистить существующий распознаваемый `team-task-board/renderer/index.ts`: Desktop-only analytics wiring вынести в Desktop composition/public surface, не экспортировать его из browser-consumed barrel. Если это требует нового direct `renderer/hosted.ts`, сначала включить **именно этот** новый facet в общий classifier/resolver и доказать оба правила на resolved graph; не добавлять отдельный regex allowlist. Не разрешать `renderer/desktop` автоматически новым exception.
6. Удалить **только** `createHostedTaskBoardRendererBoundaryPlugin` после перехода production import на чистый facet. Не удалять соседний `createHostedCoordinationEventStreamBrowserBoundaryPlugin` и chunk/provenance isolation: они решают другую задачу.
7. Для public `agent-teams-controller/task-semantics` добавить узкое правило допустимой pure dependency. Оно проверяет resolved subpath и transitive graph; весь controller root/main graph запрещён из feature core. Не расширять baseline.
8. Baseline entries удалять лишь для реально устранённых edges; отсутствие нового нарушения не доказывает общую семантику.

### Проверки и acceptance

- Guard fixture: browser facet реэкспортирует adapter через промежуточный модуль - красный результат.
- Guard fixture: pure package subpath чист - проходит; тот же subpath через alias указывает на controller root/Node - падает.
- Guard fixture: выбранный F0 browser public surface распознаётся для cross-feature и transitive правил; при direct facet оба правила видят его одинаково. Полный all-facets ratchet проверяется отдельно после F0b inventory.
- Actual Hosted Vite graph использует реальный public path без виртуальной подмены task-board barrel; forbidden Node/Desktop graph отсутствует. Не удовлетворяться source grep.
- `pnpm guard:feature-architecture`, `pnpm guard:source-file-size`, focused existing `test/architecture/feature-architecture-guard.test.mjs` и baseline regressions; actual Vite build boundary tests по разделу 10.
- Все новые production source files <=800 строк; legacy большие файлы только уменьшаются.

**Важная проверка F0:** чистый browser import и архитектурно допустимый export - разные требования. Экспорт конкретного HTTP/storage adapter через новый файл с названием `hosted.ts` остаётся adapter export. Public renderer facade принимает узкие dependencies и создаёт поддержанный feature surface; concrete adapter остаётся internal composition detail. Type-only exports сохраняют types и не скрывают runtime dependency через value re-export. Guard writer проверяет actual barrel symbols и resolved transitive origins до подключения consumer.

**Отмена F0:** revert одного checkpoint с возвращением прежнего import path и plugin вместе; не оставить unguarded browser facet. Документы не утверждают F1/F2 выполненными раньше реальных consumers.

## 5. F1: одна task semantic authority

### 5.1. Контракт facts, не транспортный DTO

Pure API не принимает Electron `TeamTask`, Hosted envelope или storage context. Нужен минимальный `TaskSemanticSnapshot` и независимые facts:

```ts
type BlockerFact =
  | { kind: 'known_task'; key: string; task: TaskSemanticSnapshot }
  | { kind: 'known_absent'; key: string }
  | { kind: 'unknown'; key: string };

interface TaskSemanticSnapshot {
  key: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  reviewState: 'none' | 'review' | 'needsFix' | 'approved';
  history: readonly NormalizedTaskHistoryEvent[];
  placement: NormalizedTaskPlacement | null;
}
```

Точный тип history должен покрывать существующие meaningful review/status/reset события; unrelated history events можно сохранять как игнорируемый kind, не менять persisted schema. Parse/validation raw values принадлежит adapter. История не сортируется по timestamp ради удобства: существующий append order и reset precedence фиксируются expected fixtures.

Не универсальный knowledge framework: `BlockerFact` нужен для одного конкретного риска. Для board reorder дополнительно передаётся `canonicalColumnComplete`, binding к одному source generation/revision и полный набор IDs. Полная колонка не выводится из `visibleRows.length`, search filter или одного page.

Policy возвращает решение с reason, например `allowed`, `blocked_open_dependency`, `insufficient_knowledge`, `state_conflict`; executor maps это в existing transport error envelope. Модуль не пишет, не читает, не хэширует и не вызывает telemetry.

### 5.2. Public package seam и viability gate

Кандидат: `agent-teams-controller/task-semantics`, единственная исходная реализация в `agent-teams-controller/src/task-semantics.js` и небольших pure modules рядом. Сохранить CJS package; не переводить весь controller на ESM. Root `src/index.js` сейчас eagerly импортирует controller/MCP, поэтому браузер туда не идёт. `hostedBoardProjection.js` остаётся инфраструктурной оболочкой: opaque IDs/hash/crypto выносятся за pure policy.

F1 начинается с малого **исполняемого package viability proof**, до массового удаления consumers:

1. Инвентаризировать существующие root/deep imports, controller `scripts/build.mjs` (сейчас копирует src в dist), Electron/MCP packaging, Docker COPY. Выбрать один экспортный путь, одинаковый для TS/test/browser; root compatibility сохранить.
2. Default для workspace: package export `./task-semantics` указывает на source pure entry с `types` declaration; `.` сохраняет нынешний root. Build копирует ту же реализацию в dist. Если production packaging использует dist, package metadata для этого артефакта должно указывать на соответствующий dist entry. Не держать две вручную написанные JS/TS реализации.
3. Проверить package files/copies: root package сейчас имеет `main: src/index.js` и `files: [dist]`; нельзя просто добавить export на `src` и утверждать, что packed dependency работает. Либо существующий production packaging гарантированно включает этот source subtree и типы, либо build создаёт корректный packed manifest/entry. Решение принимается по фактическому артефакту, не по Vite alias.
4. Добавить JSDoc/checked declaration для public API и TS usage fixture. Ручной `.d.ts` допустим как контракт, если compile fixture проверяет runtime exports и типы; ручная копия алгоритма в TS недопустима.
5. Собрать tiny browser consumer через existing Vite toolchain, Node CJS require consumer и реальный Hosted production graph. Если CJS трансформация требует изменения include, оно ограничено этим subpath и проверяется production build. Не включать Node polyfill/crypto stub.
6. Если CJS невозможно корректно использовать в действующих bundles, единственный fallback: generated ESM output из той же pure source implementation, с export conditions и тестом обеих ветвей. Новый bundling framework/package не добавлять.

Этот proof является gate продолжения F1, а не основанием оставить неиспользуемый third implementation. До переключения всех consumers новый код может жить в рабочей ветке; в завершённом checkpoint остаётся одна authority.

### 5.3. Последовательность extraction

1. Собрать independent expected fixture table по существующим Product/controller tests. Начать с `completed+needsFix`, history-vs-fallback, pending reset, in-progress/deleted reset, workflow placement, reviewed completion и blockers.
2. Перенести review derivation и status/column semantics в pure module. Сохранить diagnostics source если consumers его используют; source label не должен быть authority сам по себе.
3. `src/shared/utils/reviewState.ts` сделать compatibility delegate. В `taskHistory.ts` заменить только migrated derivation; formatting/history append logic не переносить целиком. `teamTaskState.ts` сохраняет rich public facade/caching, но semantic decisions делегирует. Для ручного выхода из review в Done добавить один persisted `review_reset` event (`from`, `to: 'none'`, reason `move_back_to_done`) в `TaskHistoryEvent`; pure history resolver и все active readers должны трактовать его как reset. До writer switch инвентаризировать остальные history consumers (timeline, task-read worker, member-work-sync, stall monitor) и обновить только места, где новый event влияет на вывод.
4. `taskMutationReviewPolicy.ts` больше не реализует history scan/fallback. Его public signature может остаться thin mapper к shared policy.
5. `agent-teams-controller/src/internal/reviewState.js` делегирует pure API. `taskLifecycle.js` terminal/actionable definitions использовать оттуда там, где это та же политика.
6. `hostedBoardProjection.js` делает raw read/identity transform, затем вызывает pure column/order projection. Если historical column order включает orphan entries, resolver удаляет их по authoritative existence до policy; browser projection не имитирует такое знание.
7. В `hostedTaskCommand.js` заменить move/approve/blockers decisions на pure result. `moveToColumn` остаётся executor явного plan: clear-placement, set-status, request-review, approve-review или manual-approve. Lock, CAS, authority, idempotency и write ordering остаются прежними. Не превращать решение в универсальный command interpreter.
8. Desktop `TeamTaskMutationCoordinator` использует тот же move/approve decision через feature domain seam. Для `moveBackToDone` нужен **один additive Desktop command facade/IPC/API/store seam**: под существующим board lock загрузить authoritative task/blockers/placement, применить pure decision до первой записи, затем выполнить явный write plan. `TeamDetailView` перестаёт делать отдельные `updateKanban(remove)` и `updateTaskStatus(completed)` с refresh между ними. Это prevalidated locked sequence, **не** filesystem crash-atomic transaction; после crash/read failure recovery сверяет фактическое состояние. UI policy только рисует affordance, executor пересчитывает её на authoritative state.
9. Reader/adapter для Desktop partial map возвращает `unknown` отсутствующим blocker, пока не доказано authoritative отсутствие. Hosted storage reader возвращает `known_absent` только после корректного `TASK_NOT_FOUND` под нужным scope/снимком. Permission/read/parse failure возвращает ошибку либо `unknown`, никогда absence.
10. Удалить migrated duplicate helpers/imports. Старые файлы допустимы как тонкие delegating entrypoints; никакого второго active `resolveReviewState` под другим именем. В notes перечислить реальные consumers и остатки: start notification, update-details notification, rich attachments/review не объявлять перенесёнными.

### 5.3.1. Минимальная pure API и запрет на скрытый executor

Предлагаемые имена фиксируют смысл, но могут сохранять существующие public signatures через delegates:

| Разговор | Input facts | Output | Production consumers |
|---|---|---|---|
| Effective review | Normalized status, append-ordered relevant history, persisted review fallback, placement | `state` + existing diagnostic source | Product review/task-history readers; controller review/lifecycle helpers |
| Dependency completion | Effective review + status | Finished/open/unknown decision | Product `teamTaskState`; controller `taskLifecycle`; move validation |
| Visible/workflow column | Status, effective review, explicit placement | Named column/none | Product board reader/coordinator; Hosted projection/executor |
| One column transition | Current task facts, target column, blocker facts, current canonical placement | Denial reason или explicit finite transition | Desktop bounded move command; Hosted `move_task` |
| Column ordering | Canonical task keys + explicit order + completeness facts | Deterministic ordered keys | Product board selector и Hosted projection, только где правила совпадают |

История raw task, `blockedBy` и order хранятся у текущих владельцев. Policy не реконструирует missing `blockedBy` из visible symmetric edges Hosted page: projection может законно убрать невидимую/одностороннюю связь, а authoritative mutation обязана читать исходный task и blockers. Unknown history/value не нормализуется «на глаз»: adapter повторяет действующий boundary contract, независимые fixtures закрепляют invalid/missing fallback.

Не строить JSON language инструкций. Transition - небольшой закрытый union для текущих операций, например `set_status`, `request_review`, `approve_review`, `manual_approve`; параметры `clearPlacement`, target status и notification intent явные. Executors вызывают существующие функции и сохраняют их error/notification behavior. В Domain не появляются callbacks, locks, timers, task write или новый workflow engine.

### 5.3.2. Desktop `moveBackToDone`: полный узкий путь

**Lock owner - controller.** `withTeamBoardLock` в `agent-teams-controller/src/internal/boardLock.js` синхронный и reentrant. Внешний `async` callback освободит lock раньше завершения Promise; он запрещён. Два отдельных метода, каждый со своим lock, не являются одной защищённой последовательностью.

1. Добавить узкую операцию в existing `agent-teams-controller/src/internal/taskBoard.js` либо отдельный internal module, экспортированный этим facade. Предлагаемое имя `moveTaskToStatusColumn`; начальный Desktop caller использует target `completed`. Не добавлять generic `withLock(callback)` в Product API.
2. Под одним outer `withTeamBoardLock` заново прочитать task, placement и blockers; вычислить pure decision; при отказе не писать ни один файл. Helpers внутри остаются reentrant. Все I/O здесь синхронны, как действующий controller.
3. Для разрешённого перехода под тем же lock очистить placement и persisted `reviewState`, затем append **один `review_reset` event** при реальном выходе из review/approved; `status_reset` у `kanban.clearKanban` лишь разрешает clear и сам не пишет history. Изменить status только если требуется, без фиктивных `completed -> in_progress -> completed` переходов. History-first resolver после нового event обязан вернуть `none`, иначе Done снова превратится в Review/Approved. Не посылать start/prompt notification. Повтор уже достигнутого target не добавляет history.
4. Feature `TaskMutationBoardPort`/`TeamTaskMutationCoordinator` вызывает одну controller operation и один раз инвалидирует projection. Нельзя fallback-нуть на прежние два writes, если новый method отсутствует: version mismatch возвращает явную unavailable ошибку.
5. Провести additive conversation через `core/application/ports/TeamTaskBoardMutationPorts.ts`, `main/composition/createTeamTaskBoardFeature.ts`, `createTeamTaskBoardMutationHandlers.ts`, `registerTeamTaskBoardIpc.ts`, feature channel exports, `src/preload/index.ts`, `src/shared/types/api.ts`, actual Desktop transport и renderer action. Из существующих preload constants удалить расхождение/дублирование только для затронутого channel, не мигрировать весь preload. Все параметры валидируются теми же team/task validators.
6. `TeamDetailView.handleMoveBackToDone` делает один вызов; compatibility API для отдельных updateKanban/updateStatus остаётся для других intents. Legacy HTTP `HttpAPIClient` получает явный unsupported result для нового Desktop-only method, если этот путь его не поддерживает; production Hosted использует свой existing `move_task`, а не новый fake endpoint.
7. После lock сравнить `isTaskOpen` до/после; если переход review -> finished действительно произошёл, вызвать существующие completion follow-ups (dependency wake и board-complete). Их stable comment/message IDs дают idempotence при повторном вызове; не изобретать второй notification owner. Даже при `task.status === completed` нельзя пропустить эти effects только потому, что `setTaskStatus` не вызван. IPC registration/remove symmetry и raw IPC validation покрыть существующим integration test. Сильный controller fixture: open blocker оставляет task+kanban bytes прежними; successful move из `review_requested` и `review_approved` history даёт Done у Product и controller readers, нужные follow-ups и повтор без новых effects. Lock proof проверяет competing write или существующий lock harness, а не только два spy call.

Crash между двумя file writes не становится transaction rollback. При исключении после первой записи возвращается uncertain/partial mutation outcome, выполняется read refresh, success не показывается. Проверка читает фактические task/kanban после injected failure; последующий explicit повтор снова валидирует current facts. WAL/backup/compensation framework ради этого переноса не вводится. Если current API не может честно передать partial outcome, добавить smallest typed error/result для этого command; не называть generic thrown error доказанным «не применено».

### 5.4. Поведенческие acceptance cases

| Case | Независимое ожидание | Где проверять |
|---|---|---|
| completed + needsFix, history отсутствует | correction state сохраняется, task не становится approved | Pure suite + existing Product fixture |
| History говорит needsFix, status completed | history precedence сохраняется | Pure suite |
| Новый in_progress/deleted reset после review | старое review состояние не воскресает | Pure suite |
| pending с needsFix vs pending с review | различие actionable correction и reset сохраняется | Pure suite |
| Known open blocker | start/completion запрещены | Pure move/dependency suite |
| Unknown blocker из partial map | действие не разрешается как для отсутствующего | Pure suite + один adapter mapping test |
| Authoritative absent/deleted blocker | действующая policy не создаёт ложную блокировку | Pure suite + controller reader boundary |
| Move approved/review/status | правильное намерение, clear/write order и notification contract сохранены | Executor focused tests |
| Desktop move отвергнут blocker/policy | Placement и status оба остаются прежними; первая запись не выполняется | Desktop facade/IPC focused regression |
| completed + review_requested/approved history -> Done | Persisted reset даёт `none` в обоих readers; review -> finished будит dependents/lead, повтор не дублирует effects | Controller persisted fixture + Product reader/IPC |
| Incomplete/filtered column reorder | port не вызывается; нужна canonical complete projection | Application/adapter guard |
| Consumers фактически подключены | Desktop reader/coordinator и Hosted projection/executor используют public authority | Небольшие composition tests + review/import inventory |

Не сравнивать новый алгоритм с выбранным старым как единственный oracle. Для found regression желательно показать красный fixture на прежнем controller и зелёный после замены. Это будущая проверка, в этом плане не запускалась.

**Rollback F1:** Desktop IPC контракт получает additive command; Hosted wire не меняется. `review_reset` является новым additive persisted history event, поэтому простого code revert после первой такой записи недостаточно: старый history-first reader проигнорирует reset и может снова показать Review/Approved. Перед включением записи проверить чтение event в Product, controller, worker и UI; определить compatibility reader или обратимую миграцию для rollback. Пока compatibility не доказана, rollback означает revert UI dispatch с сохранением нового reader/event support, а не удаление всей semantic реализации. Не писать event до подключения обеих production read compositions.

## 6. F2: один create/outcome controller, две реальные формы

### 6.1. Что именно объединяем

Общий owner отвечает за draft submit snapshot, synchronous double-submit gate, pending identity, outcome/recovery, scope fencing и refresh state. Он не владеет React, Zustand, transport JSON, task storage или provider delivery.

Кандидаты новых файлов в `team-task-board`:

- `core/application/CreateTaskInteractionController.ts`;
- `core/application/models/CreateTaskInteraction.ts`;
- `core/application/ports/CreateTaskInteractionPorts.ts`;
- `renderer/hooks/useCreateTaskInteraction.ts`;
- Desktop mapping в `src/renderer/composition/team/`;
- Hosted mapping рядом с `renderer/composition/createHostedTaskBoardTransport.ts`.

Экспорт controller factory через existing `src/features/team-task-board/index.ts`: exact root уже экспортирует contracts, pure domain и application coordinator, а не main composition. Браузерный UI/HTTP mapping идёт через `renderer/hosted`. Проверить transitive purity нового root export; не deep-import application из app shell.

**Payload не lowest-common-denominator DTO.** Common create fields: subject, description и опциональное assignment, если capability его поддерживает. Desktop rich fields refs/relationships/prompt/startImmediately сохраняются в typed extension для Desktop create intent и проходят existing validation. Hosted current `create_task` не притворяется поддерживающим эти fields. Для общей state machine допустим конкретный discriminated create intent с Desktop rich и Hosted basic вариантами; не нужен generic command engine или `Record<string, unknown>` payload.

Basic create without prompt/start находится в реальной общей semantics. Desktop create-and-start имеет дополнительные declared effects, остаётся поддержанным через свой adapter. Это не `update_status(in_progress)` под другим названием.

### 6.2. Узкие ports

Нужны только следующие разговоры:

1. `readAvailability(scope)`/subscription - support и текущая доступность, без пересоздания session.
2. `prepareCreate(scope, draft)` - чистая adapter mapping/validation в immutable submitted envelope: identity, payload, preconditions и declared effect profile. Identity генерируется один раз для принятого submit; не на render/refresh.
3. `executeCreate(envelope)` - возвращает typed outcome. Mapping может быть async, но controller фиксирует submit gate до первого await.
4. `refreshCreatedTask(scope, reference)` - отдельно обновляет read projection. Failure не меняет confirmed outcome.
5. `recoverCreate(envelope)` только при доказанной recovery capability; по умолчанию отсутствует. Exact replay означает **те же** identity, body, recipient и preconditions, не новый command с latest revision.
6. `observeCreate(envelope)` - узкий read-only lookup через уже существующий **Product descriptor-bound task read source**, возвращает только `confirmed_task_write` с task reference и текущим `active/deleted` либо `unresolved`. Он не даёт `not_applied` по отсутствию строки. Доступны scope/commandId/idempotency/fingerprint исходного frozen envelope; нет общего search по subject и новой Owner socket операции.
7. `onConfirmed(intentId, receipt)` либо небольшой output callback для once-only analytics/local UI effects **на каждый intent**, а не один раз за жизнь session, с origin/coverage из 6.3.2. Не скрывать в нём обязательный provider effect; callback failure не отменяет task write.

Controller получает frozen envelope, а не хранит transport object как identity. Не передавать ему весь `TeamsAPI`, global store, TeamDataService или HTTP client.

### 6.3. Outcome и recovery table

| Событие | Состояние | Разрешённое действие |
|---|---|---|
| Client validation/auth prerequisite отказ до dispatch | not_applied | Исправить draft или восстановить availability; новый submit допустим |
| Committed/idempotent replay receipt | confirmed | Закрыть/очистить только исходный draft, запустить read refresh |
| Confirmed + refresh failed | confirmed + failed freshness | Кнопка «Обновить данные», без повторного create |
| Проверенный authority conflict/stale revision **до первой отправки/записи исходного intent** | conflict | Read refresh и явное повторное подтверждение нового intent с новой basis |
| Timeout/disconnect/malformed response после dispatch | uncertain | Exact replay только при доказанной дедупликации всего заявленного effect profile; иначе observe/operator |
| После uncertain replay отвергнут stale generation/idempotency mismatch | uncertain сохраняется | Наблюдать original command/effect по authority; не разрешать новую identity по одному отказу retry |
| Read-only observation находит exact creation metadata | confirmed task write | Если запись теперь deleted, показать «была создана, затем удалена»; не считать доставку дополнительных сообщений подтверждённой |
| Observation не находит exact match/authority недоступна | uncertain -> operator_required | Показать original commandId, scope, submitted subject и шаги ручной проверки; не выводить отсутствие эффекта из пустой page |
| Capability withdrawn при unresolved create | intent сохранён, new submits disabled | Восстановить auth/read; reconciliation по прежнему envelope |
| Draft изменён при uncertain старом submit | Старый frozen intent и новый draft различаются | Не позволять маскировать retry новым payload/identity; показать unresolved original |
| View A unmounted, открыт B | Session A сохраняется | Late result меняет только A; B не закрывается |
| Logout/authority reset | Effects disabled, sensitive UI cleared | Reload/relogin recovery server-owned; никакого silent replay |

Pre-dispatch local cancellation можно считать not-applied только если adapter доказал, что boundary не пересечён. Текущий Hosted transport сводит разные unavailable причины; для F2 добавить минимальную distinction dispatch knowledge в internal adapter result, не менять wire protocol без необходимости. Голый `503` либо `401` после отправки не является доказательством not-applied, если response не принадлежит проверенному rejecting boundary.

### 6.3.1. State machine и владение draft без двусмысленности

UI-owned editable draft и controller-owned submitted snapshot - разные объекты. Controller не импортирует Tiptap, chip serializers или persisted draft hook. Desktop form делает существующую serialization до submit; adapter проверяет/нормализует результат и сохраняет весь rich payload. Нормализация один раз, до fingerprint и identity: retry не повторяет её по изменившимся defaults.

Минимальные состояния controller: `idle`, `preparing`, `submitting`, `uncertain`, `confirmed`, `not_applied`, `conflict`, `disposed`. `ReadFreshness` и availability независимы. `preparing` закрывает double-submit gate **синхронно**; rejection preparation не пересекла effect boundary и позволяет вернуться к редактированию. `uncertain` не переходит в `idle` от closing/reopening формы или нового props object.

| Переход | Guard/действие |
|---|---|
| `idle/not_applied/conflict -> preparing` | Нет unresolved intent; support/availability разрешают действие; local draft валиден |
| `preparing -> submitting` | Скопировать mutable arrays/refs, зафиксировать immutable payload/identity/effect profile/fence; ещё раз проверить captured authority |
| `submitting -> confirmed` | Receipt принадлежит тому же scope+intent; пометить confirmation до callback/refresh |
| `submitting -> uncertain` | Boundary пересечена, а надёжного receipt или доказанного refusal нет; сохранить envelope |
| `uncertain -> submitting` | Только explicit exact replay, один активный recovery request, scope доступен и весь effect profile replay-safe |
| `uncertain -> confirmed` | Exact matching receipt или positive observation; observation подтверждает только доказанные эффекты |
| `confirmed -> idle` для следующего intent | Confirmation потреблена UI/registry; отдельный новый explicit submit получает новую identity |
| Любое -> `disposed` | Security/context lifetime закончился; отключить callbacks и новые effects, отменить reads, очистить sensitive references |

Не нужен persisted state-machine protocol или event journal. Snapshot/subscription API достаточно; React hook может использовать `useSyncExternalStore`. `getSnapshot` возвращает тот же immutable object, пока состояние не изменилось. `subscribe`/cleanup idempotent; constructor/render/subscribe не отправляют mutation. StrictMode mount-cleanup-mount не создаёт второй command и не dispose-ит scope registry из cleanup одного view.

**Два Desktop views одной команды:** общий gate и outcome, drafts остаются в своих формах. Для каждого submit UI сохраняет маленький `viewDraftToken`/revision; confirmed очищает/закрывает только submitting draft, если token всё ещё совпадает. Если пользователь уже открыл новый draft в той же команде, completion старого intent его не стирает. Detail и Graph видят busy/unresolved status одной session; второй view не создаёт новую identity, пока первая unresolved.

Registry удаляет settled session без subscribers после потребления результата; once-only callback marker живёт до этой точки. Session с pending/uncertain без subscribers сохраняется до восстановления/явного dismiss/security reset. Не заводить таймерные retries или periodic scans. Notifications и analytics не запускаются из React effect, который повторяется при remount; controller отмечает `intentId` как обработанный **до** best-effort callback. Неуспешный callback не откатывает confirmation.

### 6.3.2. Что означает «положительное наблюдение»

`confirmed_task_write` является доказательством созданной записи, а не эквивалентом полного rich create receipt. Outcome дополнительно сохраняет origin `mutation_receipt | observed_task_record` и coverage `task_write | declared_effects`; это небольшой discriminant, не универсальный ledger. Basic Hosted create получает достаточное подтверждение task write. При Desktop rich create-and-start/prompt UI показывает task reference и отдельное unresolved delivery состояние; observation не вызывает `notifyTaskLead` и не выполняет create/start заново.

Нельзя генерировать `onConfirmed` повторно на каждый successful read. Automatic post-confirm side effects допустимы только для первого `mutation_receipt` с доказанным effect contract. При observation callbacks ограничены local presentation/analytics; потерянное сообщение разбирается существующим notification owner. Этот tradeoff сохраняет право пользователя проверить доставку без скрытого повторного provider effect.

Desktop API сейчас отдаёт `TeamTask`, хотя main coordinator внутри знает `createdInAttempt`. Для F2 не требуется растянуть internal result на весь API; adapter честно отдаёт `replayed: 'unknown'`, а tests определяют разрешённый recovery для каждого effect profile. Если writer выбирает additive receipt для надёжной дедупликации rich outputs, это отдельная bounded часть F2 с обновлением transport tests и оценки, не cast из task в receipt.

### 6.4. Desktop adapter и существующая durable identity

1. Проследить production path: `CreateTaskDialog -> store.createTeamTask -> createTeamTaskBoardActions -> IPC -> TeamTaskStartCoordinator -> task-board-commands -> controller`. Написать короткий contract test для exact replay/changed-body conflict и сохранить existing durable tests.
2. Перенести identity/gate из `createTaskCommandIdentity.ts` в interaction owner или сделать утилиту thin delegate. Identity больше не очищается только потому, что форма closed/reopened. Raw draft edit не подменяет uncertain original.
3. `createTeamTaskBoardActions.createTeamTask` перестаёт бросать общий failure из post-commit refresh. Compatibility caller получает task при подтверждённом write; refresh warning хранится отдельно. Не менять все остальные board mutations «заодно»: записать их ACK debt как следующий slice.
4. Сохранить `TeamTaskStartCoordinator` owner notification и durable `runCreateTaskCommand`; не заводить новый ledger. Нет обещания CAS у Desktop endpoint, если он его не предоставляет.
5. Для renderer best-effort `notifyTaskLead` в `TeamDetailView` и graph hook: вывести в один Desktop post-confirm output, запускаемый один раз при подтверждённом mutation receipt для конкретного intent, а не при каждой функции retry/refresh/observation. Его failure показывать/логировать отдельно по существующему контракту. Это не browser-to-provider новый relay.
6. Гарантия exact replay task write не автоматически гарантирует exactly-once всех сообщений. Если existing authority не отдаёт `createdInAttempt`/effect receipt, не фабриковать его. Минимальный default F2: basic create имеет доказанный replay; rich create-and-start/prompt после ambiguous result использует observation/operator recovery, пока targeted authority tests не докажут дедупликацию всех обязательных эффектов. Успешный rich Desktop flow сохраняется.
7. Подключить и TeamDetail, и graph consumers, использующие одну Desktop form, иначе старый callback/state path останется обходом общего controller. Остальные direct API callers сохраняют прежний API contract и отдельно listed; они не называются общим пользовательским create flow.
8. Desktop registry разместить в `src/renderer/composition/team` над tab/graph view lifetime; оба consumers получают session по `activeContextId + teamName + authorityEpoch`. Не класть identity в local React ref формы. Проверить переход Detail -> Graph при pending create и два последовательных intents: post-confirm notification выполняется один раз **для каждого** intent, подтверждённого mutation receipt; observation его не запускает.

### 6.5. Hosted adapter и composition lifetime

1. `HostedTaskBoardPage` сохраняет свои read paging/invalidation semantics. Только create submit/outcome переходит в controller. Остальные mutations не делать внезапно «унифицированными».
2. В `HostedApplicationShell` выше keyed workspace создать маленький registry task sessions по scope/authority; `HostedTeamWorkspace` получает handle. Transport reference может поменяться технически; pending intent не принадлежит ни ему, ни lifetime workspace component. `taskBoardMutationsEnabled` становится observation availability внутри stable session.
3. При advertisement false UI отключает новый create. Recovery исходной команды сохраняет owner и frozen wire body. После auth availability возвращается, replay не пересобирает `expectedRevision`/`expectedSourceGeneration`. Защищённый 401/403 запускает bounded auth/workspace revalidation из раздела 3.2.1; только её положительное доказательство смены authority удаляет sensitive session. Не превращать единичный 403 в утверждение, что исходный effect не применился.
4. Адаптер использует существующий Owner/controller путь и interprets committed/idempotent replay receipt. `HostedTaskBoardMutationAuthorityAdapter` сейчас прозрачно меняет `expectedRevision` у stale create, а original -> rebased держит только в памяти: commit rebased create с потерянным ACK после restart может дать `idempotency_mismatch` на replay original. Default F2: удалить transparent create rebase. Stale до effect возвращает conflict; UI обновляет read и просит подтвердить **новый** intent. Для уже неопределённого исходного intent stale/mismatch последующего retry остаётся uncertain. Durable rebase protocol не вводить без отдельного доказанного требования. Grant/lease/generation/source checks сохраняются; Product не получает task write access.
5. Добавить read-only lookup в **существующем Product descriptor-bound source** (`hostedTaskBoardReadFileSource.ts` и его mount/identity/snapshot helpers), без новой Owner wire operation и без ledger: derive deterministic raw task ID из teamId+commandId тем же controller identity rule, открыть только этот task file через no-follow descriptor, сравнить сохранённые `creationCommand` idempotency/fingerprint с frozen envelope, повторно проверить directory/mount binding/snapshot и текущий `LiveGrantTaskBoardReadAuthority` read grant до ответа. Product HTTP route проверяет current authenticated workspace/team admission, bounded request и CSRF/Origin как другие hosted routes; не даёт browse arbitrary task IDs. Исторический submitted `expectedSourceGeneration` используется лишь для сравнения исходного intent, current read авторизуется отдельно. Mutation generation check не обходится: observation не выполняет mutation и не объявляет отсутствие эффекта. Exact active **или deleted** metadata подтверждает прежний task write, при deleted UI прямо показывает последующее удаление. Absence, mismatch, parse/read failure или смена storage authority остаются `unresolved`, никогда не разрешают automatic fresh submit. Browser board row DTO/subject match для этого недостаточны.
6. HTTP safe page retry остаётся в transport с действующим bounded backoff. Controller делает reconciliation decision; не добавлять второй nested read retry loop.
7. Cleanup board effect больше не уничтожает create intent из-за смены transport/selection. Он отменяет только чтение/subscription. Для non-create выполнить ограниченный lifetime/fencing fix из 6.5.2; нельзя оставить known production defect под словами «F2 только create».
8. Не добавлять browser command persistence и не ослаблять existing server-owned recent/non-terminal recovery других composed commands. F2 observation original envelope работает внутри живой session; after-reload task-create recovery нельзя объявлять реализованной без отдельного реального server discovery contract. Не переиспользовать page revision из другой команды/команды B.
9. В `HostedTeamWorkspace` изменение availability после mutation response/error применять только к захваченному team/scope/authority session. Поздний 403 или network failure команды A не отключает advertised capability уже выбранной команды B в том же workspace. Page advertisement также остаётся fenced своим request generation.
10. Если read-only lookup не дал положительного совпадения, показать `operator_required` как действие, а не вечный spinner: copyable original commandId/scope и ссылка на текущий board/read refresh; явное закрытие unresolved intent после ручной проверки помечает его **неподтверждённым**, не `not_applied`. Новая команда получает новую identity только после отдельного явного submit с предупреждением о риске дубля. Никакого silent replay после logout/reload.

### 6.5.1. Hosted observation: минимальная контрактная цепочка

Новый route является read recovery для существующего create, не новым product action. Предлагаемый public contract в `team-task-board/contracts/hosted`: original строго parsed `create_task` command + current workspace/team query context. Передавать hash отдельно от body не требуется: Product заново считает existing `mutationPayloadFingerprint` над **исходным** command. Browser не получает Node crypto и не вычисляет raw filesystem ID.

Порядок implementation:

1. Узкий `observeTaskCreation` port/result добавить рядом с existing read contract; новый handler подключить через `registerHostedTeamTaskBoardHttp` и `hostedTaskBoardReadComposition`. Название route выбирается в existing route constants, а не строкой в UI. Route зарегистрирован только если read recovery реально composed; availability observation независима от availability **новых** task mutations.
2. `LiveGrantTaskBoardReadAuthority` в `hostedTaskBoardReadComposition.ts` применяет current session/workspace/team grant до и после чтения. Не пробрасывать facade к raw source мимо этой проверки. Max request body/deadline/response redaction сохраняют existing HTTP conventions; original subject/prompt не попадают в logs.
3. Descriptor source получает trusted current identity. Raw ID вычисляется existing `hostedBoardIdentity.hostedTaskIdForCommand(teamId, original.commandId)`; public task reference вычисляется existing `hostedTaskBoardTaskId`. Не копировать SHA/UUID формулу и не переносить её в pure semantic subpath.
4. Проверить все fields persisted `creationCommand`: `namespace: 'agent-teams.hosted'`, `scopeKey` из **текущей trusted legacy identity**, `operation: 'create_task'`, stored `commandId` равен deterministic **raw task ID**, `payloadHash` равен original fingerprint, `idempotencyKey` равен original key. Stored `commandId` здесь не совпадает с browser commandId - сравнение напрямую дало бы вечный unresolved.
5. Открыть ровно bounded target file, проверить schema/status и binding descriptors; revalidate file snapshot/directory/mount/live grant до ответа. Использовать existing max-file-size и no-follow helpers. Не сканировать весь board и не требовать, чтобы task был на текущей page или оставался active.
6. Вернуть только `confirmed_task_write` с opaque task reference и `active | deleted`, либо `unresolved`; transport failure различается для UI retry, но не становится `not_applied`. Storage authority replacement/identity mismatch не разрешает search в прежнем raw path. Никаких task contents, host path или manual receipt mutation в ответе.
7. На browser side отдельный bounded read не запускает create retry. При 401/auth loss новое наблюдение ждёт повторного admission; при source-generation change old body неизменен и mutation route по-прежнему отвергает stale generation.

Observation response/result проходит через existing `createHostedTeamTaskBoardOutputAdapters` -> `createHostedTeamTaskBoardFeature` -> route contribution facade; не экспортировать raw descriptor source в HTTP handler. Existing board source comment/contract и mutation authority interface уточняются в той же работе: новый метод не добавляет Product запись, lock ownership или Owner operation. Проверка no-follow/grant/snapshot boundary расширяет текущие tests, а не запускает полный снятый scope lock multi-writer race matrix.

### 6.5.2. Remaining board mutations: ограничение конкретного дефекта

На текущем baseline `pendingMutation` общая для всех Hosted mutations и очищается cleanup, зависящим от transport. F2 не может исправить это только для create и оставить lost intent для move/update в том же production rerender. Bounded fix: отделить stable non-create pending envelope от read effect cleanup и сохранить его в workspace/scope-owned handle на время того же authenticated session. New create owner остаётся единственным create state machine; generic command framework не появляется.

Для non-create сохраняются прежний wire, server executor, error semantics и UI. Исправляются только lifetime/fencing: capability withdrawal/transport replacement/A -> B -> A не стирают frozen unresolved envelope, late A error не выключает B, read abort не означает mutation cancelled. Проверка одного representative move/update race достаточна для shared lifetime boundary. Не переносить все non-create ACK/refresh policies в F2 и не обещать им новый exactly-once protocol. Если существующий command не доказал replay-safe behavior, кнопка автоматического retry не получает это свойство от нового storage location.

### 6.6. Проверки F2 по сильным границам

- Core interaction test: два синхронных submit вызывают effect один раз; pending payload deep-frozen относительно дальнейших draft edits.
- Core test: confirmed write + rejected refresh возвращает confirmed и не активирует replay button.
- Core test: A/B late completion, scope/epoch mismatch, read abort vs effect outcome.
- Adapter test Desktop: existing identity проходит без изменения; validation и rich fields сохраняются; отсутствие guarantee не превращается в `exact_replay`.
- Adapter test Hosted: committed/replay/conflict/unavailable mapped honestly; replay exact body/identity; stale revision не обновляется автоматически. Старый сценарий rebased create -> commit -> lost ACK -> restart моделируется как regression: новый путь не dispatch-ит rebase, а уже существующий uncertain результат не объявляется safe conflict после stale/mismatch.
- Product descriptor-bound lookup: commit -> lost ACK -> generation change -> exact active/deleted metadata подтверждает прежний task write; absent/mismatched/unreadable result остаётся unresolved и не разрешает retry. Проверить no-follow, workspace grant и snapshot revalidation; positive lookup не выдаёт receipt о provider delivery.
- Desktop composition: Detail -> Graph во время pending create использует тот же session; два последовательных intents вызывают post-confirm output по разу каждый.
- **Workspace integration:** после начала mutation transport получает network failure/401/403/503 и capability меняется; unresolved intent остаётся после реальной production rerender. A -> B -> A через keyed workspace сохраняет A session; повтор не создаёт новый commandId. Commit -> lost ACK -> generation change -> rejected replay остаётся uncertain.
- Same-workspace team race: A mutation ждёт, user выбирает B и получает enabled advertisement, поздний A 403/network не выключает B.
- Auth reset composition: защищённый 403 при сохранённом principal/workspace оставляет uncertain intent; подтверждённый logout либо успешный grant read с потерянным scope очищает sensitive registry; network/503 не объявляется revoke.
- Form integration: close/reopen, error/refresh labels, keyboard submit; late A result не очищает B. Сохранить refs/chips/IME/owner defaults existing Desktop form.
- Browser/Electron flow: basic task create, двойной submit, подтверждённый create с искусственно сорванным следующим read, потерянный ACK с безопасным recovery, team switch. Только sandbox, через actual compositions.

**Rollback F2:** revert controller + оба integration paths вместе; данные и wire schemas совместимы. Если targeted bug fix уже доказан независимо, его лучше сохранить отдельным небольшим коммитом, чтобы architecture revert не возвращал duplicate-submit defect. Не оставлять fallback switch, который удерживает две активные create state machines постоянно.

## 7. Пример Dashboard: D1 running teams -> open team

### 7.1. Текущая композиция

Desktop `DashboardView` содержит command search, recent projects, running teams и Desktop banners. `useRunningTeamsSection` читает global store `teams`, `globalTasks`, provisioning snapshots, lead activity; отдельно читает alive teams. Pure `buildRunningTeamsDashboard` сортирует active/provisioning/idle, in-progress counts, activity и display name. `RunningTeamsSection` снова вызывает этот Desktop hook из UI.

Hosted отдельного эквивалентного Dashboard пока нет: `HostedApplicationShell` выбирает зарегистрированный workspace, `HostedTeamWorkspace` показывает lifecycle list и selected team board/messages. Lifecycle DTO даёт грубый `running/degraded/...`, не Desktop idle/activity. Existing workspace registry и lifecycle HTTP - реальный backend для минимального read Dashboard. Не строить новый overview endpoint в D1.

### 7.2. Выбранный vertical slice

**Показать команды выбранного scope, которые по доступным фактам работают (и Desktop команды в известном provisioning), и открыть выбранную команду.** Desktop сохраняет существующий смысл running section; Hosted получает небольшой equivalent section над chooser/board в своём shell. Полная копия recent projects/provider installer/CLI auth не входит.

Общий UI: `RunningTeamsSectionView` с rows, loading/stale/error, onOpen. Desktop-derived visuals; semantic read owner existing `running-teams` feature. Shell предоставляет свой banners/toolbar slot. Не универсальный slot registry, а несколько явных props в двух composition roots.

### 7.3. Честные модели и ports

```ts
interface RunningTeamFacts {
  targetKey: string; // opaque в рамках scope; path существует только внутри Desktop adapter
  displayName: string;
  activity: 'active' | 'idle' | 'provisioning' | 'running_unknown' | 'not_running';
  taskCounts: { kind: 'known'; inProgress: number; pending: number; completed: number }
    | { kind: 'unknown' };
  lastActivity: { kind: 'known'; iso: string } | { kind: 'unknown' };
  projectLabel?: string; // только безопасная display label
}
```

Shape уточнить внутри existing `running-teams` models. Navigation target в feature - opaque key внутри scope, а shell adapter хранит соответствие ключа Desktop teamName/project либо Hosted canonical IDs. Отдельный общий navigation package и зависимость running-teams от team-directory не нужны. Не добавлять branded persistence ID миграцию; target resolution принадлежит shell. Unknown task counts не отрисовываются нулями; `running` не объявляется `active`, `idle` или `provisioning` без evidence.

Нужны source read/subscription и `openTeam(target)` port. Source adapter имеет read freshness/completeness, scope epoch и cancellation. Query field остаётся обычным local view state; форма search не должна открывать command palette Hosted, которого там нет.

Ranking:

- Для Desktop с теми же facts сохранить existing сортировку.
- Hosted `running_unknown` включить в running group, label «Running», без idle pulse, фиктивного task count и activity.
- Unknown counts/activity не равны нулю как отображаемое знание. Для сортировки применить явно documented neutral ordering: known values внутри доступной группы; deterministic name + opaque key tie-break для одинаковой информации. Не менять Desktop tie-break случайно.
- `degraded` показывается как warning только если факты доказывают surviving running lane; если lifecycle DTO не доказывает этого, показывать в chooser, а running Dashboard не объявляет его active. Это не удаляет degraded team из приложения.

### 7.3.1. Exact mapping D1 без нового Hosted endpoint

| Source fact | Dashboard row | Label/дополнительные facts |
|---|---|---|
| Desktop `active`, `provisioning`, `idle` по existing resolver при достоверных inputs | Включена | Сохранить прежние labels, counts и ordering |
| Desktop `offline`, `partial_failure`, `partial_skipped`, `partial_pending` | Прежнее D1 поведение: не включена | Не переносить chooser running predicate в Dashboard |
| Hosted lifecycle `running` | `running_unknown`, включена | «Running», counts/activity unknown |
| Hosted `draft`, `ready`, `stopped`, `deleted` | Не включена | Остаётся доступна в chooser по его visibility contract |
| Hosted `degraded` без lane evidence | Не включена | Chooser сохраняет warning «Degraded», состояние runtime неизвестно |
| Нет нового достоверного snapshot | Предыдущие rows помечены stale либо initial loading/error | Не показывать success-empty после read failure |

Проверенный Hosted enum - `draft | ready | running | degraded | stopped | deleted`; `starting/provisioning` в lifecycle **list** отсутствует. D1 показывает «запускается» в Desktop по existing progress; Hosted D1 не выводит такой статус из `ready` и не опрашивает per-team launch progress. Если последующий slice примет progress source, он отдельно расширит adapter facts.

Для текущего Hosted-only набора все running rows имеют одинаковую степень знания: порядок по displayName, затем opaque key. Desktop сохраняет `active -> provisioning -> idle`, затем in-progress count descending, valid activity descending, displayName. Invalid date даёт existing neutral rank, а не `NaN` comparator. New unknown fact не должен сдвигать существующий Desktop порядок.

### 7.3.2. Один read snapshot для D1 и N1 в Hosted

Small read owner живёт в workspace composition над running section и chooser. Он вызывает `loadTeamLifecycleList`, держит один complete snapshot/revision, одну in-flight read и request epoch; два UI consumer получают один immutable result. Existing `useTeamLifecycleList` адаптировать для этого использования или дать public source hook того же feature. Нельзя импортировать его deep path из shell или создать второй loader с теми же pagination rules.

Initial read, explicit refresh и existing workspace lifecycle SSE invalidation сходятся в один `reload` callback. Invalidation во время read ставит один dirty bit; после завершения выполняется максимум один следующий read. Это coalescing запросов, не новый durable subscription/polling/cache framework. Unmount workspace abort-ит reads и снимает subscriptions; F2 pending command registry выше этого lifetime остаётся отдельно.

Read owner фиксирует `readStartedAtWatermark` и `selection/invalidationWatermark`. После подтверждённого create/promotion/deletion инкрементирует watermark **до** выбора team и запрашивает fresh list. Result запроса, начатого до mutation receipt, нельзя публиковать как fresh и нельзя использовать для reconcile отсутствующей выбранной team, даже если Promise завершился позже. Dirty-bit follow-up не оправдывает кратковременное снятие selection. Новая team остаётся pending, пока её хотя бы раз не увидел complete post-receipt list или selected-team bootstrap не подтвердил её; без causal revision одно лишь отсутствие в первом post-receipt list не доказывает удаление. После подтверждения наличия обычный later complete snapshot может reconcile disappearance; explicit deleted/current-grant denial делает это сразу. Failed bootstrap/read оставляет pending selection с видимой ошибкой и ручным refresh. Не добавлять polling до появления строки.

При новом snapshot сначала проверить scope/request epoch, затем atomically публиковать rows+revision+freshness. Ни D1, ни N1 не модифицируют массив источника сортировкой in-place. Current auth/selected workspace binding проверяется composition; opaque key resolves через map этого же snapshot. Из stale snapshot запрещена capability-sensitive action; read-only open может повторно пройти existing shell admission/bootstrap и показать unavailable, не меняя серверное состояние.

### 7.4. Реализация по шагам

1. Вынести presentational rendering из `running-teams/renderer/ui/RunningTeamsSection.tsx` в props-only view; existing `RunningTeamsSection` временно остаётся Desktop composition wrapper.
2. Pure policy получает normalized facts, включая honest `running_unknown`. Сохранить existing Desktop fixtures и добавить independent unknown facts case. Theme/localization остаются UI context, store/API не попадают в view.
3. `useRunningTeamsSection` разделить: Desktop source adapter собирает store/alive/provisioning facts; общий hook подписывается на read state и вызывает pure policy. Существующий `createTeamDirectoryRendererSlice` после noninitial fetch failure очищает `teamsError`, после task failure - `globalTasksError`, а `globalTasksInitialized` означает попытку, не успешный read. Поэтому source owner добавляет небольшой scope-bound last-success/last-attempt outcome для teams и tasks; adapter не угадывает freshness по непустому массиву, `initialized` или отсутствию error. Retained rows после failed refresh помечаются stale, task counts после повторных failed initial reads остаются unknown. Не строить второй loader/cache. Если механический wrapper проще полноценного read controller, использовать его: Dashboard не требует mutation state machine.
4. Hosted source adapter переиспользует `loadTeamLifecycleList` с revision-pinned full snapshot и существующий workspace invalidation. Не гонять отдельный запрос на task counts для каждой карточки. Lifecycle snapshot можно передавать обоим read consumers из shell-owned read session; не строить новый global query cache.
5. Navigation adapter Desktop вызывает существующий `openTeamTab(teamName, projectPath)`; Hosted меняет selectedTeamId только внутри admitted selected workspace и ждёт existing bootstrap. Dashboard сам не вызывает launch/prepare.
6. В `DashboardView` оставить Desktop banners/recent projects/search adapters. В Hosted shell смонтировать common running section как часть workspace overview, используя тот же read session, что Chooser, если N1 уже подключён.
7. Заменить migrated native `title` в common row на shared Radix Tooltip; keyboard button/aria labels сохранить. `TeamTaskStatusSummary` импортировать только если его graph чист; иначе маленькую presentational часть вынести без store dependency.
8. Удалить migrated inline mapping/ranking из Desktop hook и Hosted overview wrapper. Не переносить весь `CliStatusBanner` ради D1.

### 7.5. Admission и ошибки

- Desktop отсутствие alive response не является доказанным offline для ранее известных running данных: показывать stale/unknown, не пустое «команд нет». Freshness берётся из source-owned outcome, включая failed refresh, а не выводится из `teamsError === null`.
- Hosted shell не показывает чужой workspace по клиентскому path. Existing authenticated workspace selection/server grants остаются обязательными.
- Snapshot pagination failure/revision change не превращается в partial success. Old rows можно показать stale с refresh warning, но новая selection проверяет scope.
- Workspace A load, затем B, поздний A результат не меняет B rows. SSE resync не порождает второй polling loop.
- Row click не создаёт команду, task, process или provider access.

### 7.6. Tests, old path removal, acceptance

Pure tests проверяют existing Desktop order и unknown facts. Один adapter test на каждую source shape. Existing `createTeamDirectoryRendererSlice` test доказывает successful populated load -> failed refresh: rows retained/stale, counts unknown при initial task failures. Один composition test доказывает Desktop Dashboard и Hosted shell используют common row/policy. UI test проверяет keyboard, error/stale/empty различие и отсутствие fake zero badges.

Sandbox UI acceptance: Desktop running team row открывает прежний tab/project; Hosted row открывает нужные board/messages после bootstrap; workspace switch удерживает scope. Этим не доказывается live launch/provider readiness: она покрывается существующими Core gates.

**D1 estimate:** 1.12-2.05k changed LOC, 14-28 human engineering hours; confidence LOC 6/10, effort 5/10. Включает 120-250 changed LOC source-owned Desktop freshness metadata после review round 2. Backend capability increment: 0 при использовании текущего list. Desktop search должен сохранить нынешнее переключение sections/command palette в Desktop composition; Hosted search не изображает command palette. Дальнейшая общая Dashboard composition/recent-projects требует отдельного конкретного flow и acceptance; прежний грубый резерв 0.5-1.2k не входит в выбранный пакет. Hosted provider install/auth, remote recent-project scanner или глобальный search являются отдельными capabilities.

**Rollback:** вернуть два composition imports; pure views не меняют storage. Если N1 использует extracted view/model, revert сначала зависимый N1 или сохранить обратно совместимый public surface.

## 8. Пример Team Chooser/navigation: N1 browse -> filter -> select -> open

### 8.1. Текущие compositions и разница admission

Desktop `TeamListView` держит search, status filter, 24-item section visibility, project/worktree priority, global task counts, alive/provisioning overlays, create/import/copy/launch/stop/trash/restore. `createTeamNavigationSlice.openTeamTab` связывает selected project, display name и tab. Эта навигация не равна Hosted `setSelectedTeamId`.

Hosted `HostedTeamLifecycleList` получает revision-pinned list через `useTeamLifecycleList/loadTeamLifecycleList`. `HostedTeamWorkspace` фильтрует workspace, управляет bootstrap/invalidation; `HostedApplicationShell` владеет workspace admission. Lifecycle/configuration controls имеют отдельные contracts, including promotion admission. Выбор строки не является разрешением launch.

### 8.2. Выбранный vertical slice

**Список уже доступных teams, поиск по реально доступным полям, running/offline фильтр по доказанному состоянию, deterministic ordering, выбор команды и открытие её в правильном scope.** Read-only selection не должна случайно вызывать create, promotion, launch или provider discovery.

Home нового bounded feature: `src/features/team-directory/` с `contracts` (если response model нужен через public boundary), `core/domain`, небольшим `core/application`, `renderer`. Не добавлять пустые main/preload папки: источники уже существуют в team-lifecycle/Desktop composition.

`team-directory` владеет browse/selection behavior. `team-lifecycle` продолжает владеть lifecycle state/read contract и commands. `organizations` владеет placement; chooser не копирует его policy.

### 8.3. Operations и узкий контракт

| Операция | Common contract | Desktop adapter | Hosted adapter |
|---|---|---|---|
| Read rows | `loadDirectory(scope, signal)` + snapshot/freshness | Teams store + authoritative existing sources, честные overlays | `loadTeamLifecycleList`, canonical IDs, server scope, bounded pagination |
| Search/filter/order | Pure `buildTeamDirectoryRows(facts, filter)` | Имеет teamName/description/project facts | Только displayName и другие реально полученные safe fields |
| Select/open | `openTeam(target)` | Existing tab/project resolver | Selected admitted workspace/team + existing bootstrap |
| Refresh | Refresh current read scope | Existing fetchTeams/alive mechanisms | Existing list + coordination invalidation |
| Create/import/copy/launch/stop/delete | Не N1 common conversation | Сохраняются Desktop extensions | Existing Hosted lifecycle/configuration controls, только advertised actions |
| Project/worktree placement | Optional documented filter/navigation facts | Existing organizations/repository/worktree source | Не делается из path; отсутствующая capability скрыта |

Canonical row имеет opaque key/target, display name, lifecycle facts, optional search tokens из adapter, optional project match, optional activity/counts, warning. Это не `TeamSummary` с пустыми полями и не `Partial<TeamsAPI>`.

Row support и command admission разделены. Running row может быть read-only, stopped row может быть selectable, lifecycle `ready` не гарантирует актуальное разрешение launch. Deleted historical team отображается согласно existing contract, но actions не активируются из одного label.

### 8.4. Ownership состояния

- `TeamDirectoryController` владеет query/filter, read request epoch, snapshot state и selected navigation intent; если чистого reducer+hook достаточно, не добавлять class hierarchy.
- Canonical team data остаётся source-owned; feature не держит вторую persistence database и не пишет host files.
- Shell владеет фактической route/tab selection. Common feature получает текущий selected target; не создавать второй selectedTeam source of truth.
- Desktop tabs могут быть открыты одновременно; Hosted selected panel один. Common `openTeam` intent не обещает identical tab UX.
- Local pagination видимости 24 rows отличается от canonical completeness. Hosted snapshot loader удерживает 32 pages/1000 items и revision pinning; не считать N1 списком «всех teams», если лимит превышен.
- Search выполняется по complete snapshot: current или явно помеченному last-known stale. Если позднее понадобится server search, это отдельный source capability; current list limit failure не превращать в тихо обрезанный search result.

### 8.4.1. Сохранение конкретного Desktop UX и новые unknown facts

| Правило | Desktop после N1 | Hosted после N1 |
|---|---|---|
| Search normalization | `trim().toLowerCase()`, substring по teamName/displayName/description как сейчас | Только displayName и явно предоставленные safe tokens; не угадывать legacy name/path |
| Running filter | Existing `isTeamListStatusRunning`; `partial_skipped` продолжает входить в running set | Только доказанный `running`; degraded = unknown, не offline |
| Offline filter | Existing predicate при известных inputs; unknown read freshness отдельно | `draft/ready/stopped` - известное не-running состояние; deleted остаётся отдельной исторической категорией |
| Unknown | Last-known facts можно показывать stale; initial failed alive read не становится fresh offline | Видна в «All» с own label, не маскируется под running/offline |
| Sort | Running first, project match, activity descending, **teamName** fallback | Running first, displayName, opaque key; нет фиктивного project/activity rank |
| Section visibility | Active/trash и project/worktree groups; первые 24/ещё 24; search/filter отключает local paging как сейчас | Bounded complete snapshot; не строить Desktop trash/restore controls без capability |
| Existing tab | Reuse таба, обновление display label, правильный selected project | Existing selected panel reuses bootstrap/session, без нового launch |
| Query persistence | Сохранить нынешний view lifetime | Query/filter сбрасываются при смене workspace; внутри scope refresh их сохраняет |

Обе status-checkbox selection означают union подтверждённых sets. Чтобы увидеть unknown, пользователь снимает фильтр («All»); показывать объяснение unknown status вместо тихого исключения без причины. Это правило не меняет Desktop legacy статусы при известных facts. Вычислять `nowMs` один раз на snapshot для filter и sort: 45-second ready grace в `resolveTeamStatus` не должна истечь между двумя comparisons.

D1 и N1 намеренно имеют разные selection policies: Dashboard сейчас исключает `partial_skipped`, а chooser running filter его включает. Общими становятся факты и stable status derivation, но не одна произвольная «isRunning» функция на все UX.

### 8.4.2. Selection, disappearance, errors и accessibility

1. Row emits `(scopeKey, targetKey, readEpoch)`. Composition проверяет текущий scope и lookup key; неизвестный/устаревший target не превращается в navigation по displayName. Если scope ещё тот же, read-only admission может обновить target; произвольный route string из view не исполняется.
2. Selected team исчезла из **успешного complete и причинно актуального** snapshot: Hosted снимает selection, прекращает новые board/message reads и показывает «команда больше недоступна». Snapshot, начатый до create/promotion receipt или selection watermark, не доказывает исчезновение. Для только что созданной team отсутствие в первом post-receipt list без causal revision тоже не достаточно: сохранить pending selection до первого подтверждённого presence в list/bootstrap; потом latest complete absence снова допускает reconcile. Verified denied/deleted result снимает её сразу. Failed/partial/stale read selection не очищает. F2 unresolved session не объявляется cancelled/not-applied и остаётся до явного recovery/security reset.
3. Desktop tab lifecycle остаётся у existing navigation/store: N1 не закрывает открытые tabs только из-за временного отсутствия list row. При click существующего team tab сохраняются `openTeamTab` project selection и label update.
4. Workspace switch начинает empty/loading view B сразу, чтобы rows A не вспыхивали под заголовком B. Abort+epoch fence действует и на resolved Promise в очереди microtasks, не только на network request. Invalidation A после switch не reload-ит B через stale callback.
5. Search по last **complete** snapshot допустим при freshness `stale`, но результат явно обозначен устаревшим. «No teams» означает successful complete empty source; «No matches» означает complete source с активным query/filter. Partial/page-limit/revision failure не является одним из этих успешных состояний.
6. Row navigation и actions - разные интерактивные controls. Не вкладывать buttons/menu triggers внутрь общего row button. Использовать shared Button для selection, sibling menu/extension slot, stop propagation там, где legacy card требует его. Keyboard Enter/Space открывает ровно team; menu/checkbox не открывает tab побочно.
7. Сохранить visible focus, `aria-pressed`/selected state, section heading relation и translated status/error labels. Refresh/loading announcement не читает каждый SSE event; `aria-live` достаточно на итоговом bounded status. Theme/locale берутся из existing providers, не через новый singleton.

### 8.5. Порядок extraction

1. Выписать Desktop current behavior fixtures: running first, project relevance second, activity third, name fallback; matching by teamName/displayName/description; provisioning overlay dedup; deleted/trash разделение. Проверить существующие `teamProjectSelection` и navigation tests до переноса.
2. Создать normalized model и pure filter/order в `team-directory`. Сохранить Desktop sort exact при одинаковых facts. Добавить deterministic key tie-break только там, где раньше порядок был неопределён, с явным test.
3. Desktop adapter вынести из `TeamListView`: `useStore`, `resolveTeamStatus`, `buildTaskCountsByTeam`, project matching, alive reads. Existing status policy не переписывать. `unknown` при stale/read failure не объявлять offline автоматически.
4. Hosted adapter оборачивает existing lifecycle loader. Keep canonical workspace/team IDs, expected snapshot revision, cursor-cycle/duplicate/page-limit checks. Фильтрация selected workspace выполняется по server-authorized results; не вставлять raw path/desktop teamName в Hosted DTO.
5. Desktop-derived row body выделить в common props-only component. Не переносить вместе с карточкой import/launch/delete callbacks. Дать один explicit optional `actions` ReactNode slot, собранный platform composition; отсутствие slot не подменять no-op кнопками. Для состояния, влияющего на разрешение, использовать typed capability props, а не анализ children.
6. Общий directory view даёт query/status controls через existing Radix Input/Popover/Tooltip primitives, loading/error/empty/stale и список. Rich Desktop card extensions members/task counts/branch идут только при доступных facts; Hosted basic card не изображает, что данные пустые и успешно загружены.
7. Заменить search/filter/order/render/select read path в `TeamListView` на common feature. Сохранить external Desktop dialogs/actions и project/organization placement через adapter. Большой file должен уменьшиться; не увеличивать legacy cap.
8. Заменить `HostedTeamLifecycleList` внутренний row/filter/select implementation на common feature; совместимый wrapper можно сохранить. `useTeamLifecycleList/loadTeamLifecycleList` остаются lifecycle read primitives, если реально нужны обоим consumers, либо new source owner делегирует им. Не оставлять вторую активную list controller state machine.
9. `HostedTeamWorkspace` продолжает применять admission/bootstrap до board/messages. `HostedApplicationShell` остаётся owner workspace/session scope. Common directory не импортирует ни shell напрямую, ни Desktop store.
10. Desktop `createTeamNavigationSlice` остаётся tab adapter. Перенести только shared target validation/fencing, не всю App navigation. No native folder picker в Hosted или в automated Electron checks.
11. Удалить migrated local filter/order/selection copies в обеих views и obsolete tests, проверявшие только удалённую implementation shape. Ценные behavioral fixtures перевести на новую границу.

### 8.6. Tests и acceptance

| Риск | Содержательное утверждение |
|---|---|
| Похожие имена в разных scopes | Выбор использует opaque identity; A/B не сливаются по displayName |
| Search получает неполную list | Нет ложного «ничего не найдено»; limit/revision failure остаётся error/stale |
| Late load/selection A после B | B selection/draft/panel не меняются |
| Пропала команда из refreshed snapshot | Нет auto-launch/auto-create; selected target reconciled явно |
| Create receipt раньше старого list read | Старый complete result не снимает selection; failed follow-up тоже её не снимает; causally valid read/bootstrap завершает pending state |
| Hosted нет description/counts/activity | Нет fake zero/empty metadata и ложного Desktop status |
| Desktop project navigation | После row click правильный project/worktree/tab остаётся выбран |
| Unknown runtime status | Не включается destructive/offline-only action из отсутствия данных |
| UI capabilities | Unsupported controls не смонтированы; unavailable controls имеют reason и не выполняют effect |
| Pagination | Existing expected revision/cursor cycle/duplicate safety остаётся |
| Two production consumers | Dashboard/Chooser Desktop и Hosted import common public feature, legacy algorithms удалены |

Browser scenario: paired test session выбирает workspace A, ищет/selects team, получает real lifecycle snapshot и board bootstrap; переключается в B во время delayed A read; stale A не меняет B. Отдельный Electron dev:mcp scenario подтверждает tab/project behavior и сохранение Desktop actions. Не дублировать весь сценарий на каждом provider: navigation не зависит от provider family.

**N1 estimate:** 1.58-2.66k changed LOC, 21-39 human engineering hours, confidence LOC 6/10, effort 5/10. Включает 80-160 changed LOC selection watermark/reconciliation после review round 2. N1 уже сохраняет Desktop rich row/action composition и навигацию через adapter; прежний N2 1-2k/12-24h не имеет независимого acceptance и исключён из выбранного пакета. Если после N1 останется конкретный observable flow, оценить его отдельно. Предыдущий грубый ориентир полной адаптации chooser 2.5-4.5k/32-60h не суммируется с N1.

**Rollback:** shared feature и два consumer switches одним обратимым checkpoint; adapters не меняют storage или wire. Existing commands не переносятся, поэтому откат списка не затрагивает launch/task ownership.

## 9. Универсальный playbook без универсального framework

Этот порядок применим к следующему экрану. Для каждого шага нужны конкретные файлы и consumers, а не только новая папка `core`.

1. **Определить один observable flow.** Например send message, edit roster draft, approve task. Выписать start/end, effects, scope и unsupported capabilities.
2. **Найти оба production call graphs.** От JSX до HTTP/IPC/authority. Export-only class не считается consumer. Dedicated Hosted APIs проверить до заключения «backend отсутствует».
3. **Определить policy owner и fact model.** Unknown/absent/complete обязательны там, где влияют на решение. Разделить projection и авторизацию.
4. **Сначала согласовать смысл intent.** Create-and-start, update status, deliver runtime message, persist inbox и observe reply не синонимы.
5. **Извлечь небольшой controller/reducer только при реальном behavior.** Если только props view, не добавлять application service/ports ради симметрии структуры.
6. **Подключить два adapters и два consumers.** Существующие rich fields остаются extensions с заявленной support, без fake DTO/no-op methods.
7. **Проверить один реальный risk на ближайшей сильной границе.** Core semantics один раз, transport mapping отдельно, composition lifetime там, где его не видно из unit.
8. **Перенести presentational UI.** Desktop-derived reusable controls, explicit platform slots. Не App-wide `isElectron` switch и не полный store import.
9. **Удалить старую active branch.** Compatibility facade может делегировать; не держать third implementation.
10. **Зафиксировать checkpoint evidence и остатки.** Head SHA, affected consumers, passed tests, unproven runtime cases, rollback. Обновить feature notes, не создавать новый governance packet.

### 9.1. Что должно быть в следующем implementation packet

Не создавать новый обязательный governance файл. Достаточно bounded секции существующего feature plan/PR description с восемью проверяемыми пунктами:

1. **User flow:** точное действие, видимый результат, failure/recovery, platform differences.
2. **Current callers:** два production entrypoints и путь до source/effect owner с проверенными файлами. Список exports без callers не подходит.
3. **Semantic owner:** одно существующее feature home, minimal normalized facts, unknown/completeness и identity.
4. **State ownership:** кто держит draft, canonical data, pending intent, selection, freshness; кто dispose-ит каждый объект.
5. **Contracts/adapters:** proposed public functions/types, validation boundary, supported vs unavailable operations, replay guarantees только по доказанным effects.
6. **Connected patch:** extraction + оба consumer switches + удаление старого algorithm. Временная compatibility facade делегирует одному owner.
7. **Evidence:** existing tests + минимальные новые assertions, один relevant Desktop и Hosted UI flow, budget и rollback path.
8. **Remaining scope:** что screen ещё не умеет в Hosted и является ли это accepted Core gap либо deferred capability. Пустая кнопка/no-op не закрывает gap.

D1 - образец read-only extraction: source snapshot -> pure ranking -> shared rows -> shell navigation. N1 добавляет local interaction state/filter/navigation semantics, но не mutation recovery. F2 - образец mutation flow с frozen intent/outcome. Следующий экран выбирает минимальный из этих паттернов; не наследует все порты F2 только потому, что находится в React.

### 9.2. Практический путь больших экранов после выбранного milestone

Ниже **не acceptance PR #252**. Это порядок следующих bounded slices, который не требует переносить весь shell или invent-ить заранее universal settings engine.

- **Team screen:** сначала прочитать существующие board/message/member-log feature public surfaces и реальные Hosted routes. Извлечь composition только для already-advertised child views. Затем отдельный send-message intent/outcome slice; потом member summary/activity read. Rich task details, attachments, review и post-creation roster editing входят только после соответствующего scope promotion. Sidebar/tab layout не должен решать runtime admission.
- **Create team:** initial configuration draft/validation из существующего `team-configuration`, runtime lanes через existing public planner; общая форма только после equivalence fields/effects. Save draft и promote/prepare - разные intents с разными receipt/recovery. `CreateTeamDialog` не копируется целиком в Hosted, а native project chooser остаётся Desktop adapter.
- **Launch:** reuse lifecycle command owner и существующий progress/recovery; отдельно split prepare/launch/stop UI. Не переносить `TeamProvisioningService` через host cast и не создавать shared service, который владеет одновременно Product HTTP и Owner process. Acceptance launch остаётся provider-composed sandbox proof.
- **Settings:** начать с local presentation preferences по 9.3, потом по одной accepted server setting conversation. Local-only launch-at-login/window settings остаются Desktop. Team runtime/member settings имеют своего domain owner и не становятся частью app appearance feature.

### 9.3. Settings как конкретный пример следующего slice

Проверенный Desktop seam: `src/renderer/components/settings/SettingsView.tsx`, `hooks/useSettingsConfig.ts`, `hooks/useSettingsHandlers.ts`, `sections/GeneralSection.tsx`, `SettingsTabs.tsx`. Сейчас config hook обращается к full `api.config`, global store и repository groups. Поэтому перенос готового hook в Hosted раскроет лишние зависимости даже для переключателя темы.

Предлагаемый **первый будущий** flow: «изменить тему или язык UI, увидеть результат, восстановить preference после reload». Перед реализацией проверить existing appearance/localization persistence, чтобы не завести второй store. Desktop adapter использует существующий app-config owner; browser adapter хранит только разрешённые UI preferences, если серверного preference API нет. Предпочтение темы не является server authority и не требует Tier B recovery.

| Setting/fact | Следующее решение | Что сохраняет acceptance |
|---|---|---|
| Theme dark/light/system | Общий presentational control + узкий read/write preference conversation | System media change, явный override, restart/reload, failed persistence остаётся видимым |
| `appLocale` | Existing `localization` owner + тонкий preference adapter | Translation fallback, supported locale validation, существующий UI без reload where supported |
| `agentLanguage` | Provider/team behavior, отдельный owner/flow | Не объединять с appLocale; не менять agent config от UI-language toggle |
| Launch at login, dock/native title bar, local paths, WSL/SSH | Desktop sections | В Hosted не смонтированы и не вызывают desktop API |
| Notifications/provider auth/server connection/reset | Capability-specific отдельные slices | Не сохранять fake success через browser stub; exact effect/security scope до promotion |

Common settings section model - небольшой список известных sections с availability, а не plugin registry. Shared view принимает контролируемые values/status/callbacks; shell монтирует только поддержанные sections. Default values используются для первого отображения, но missing server config не превращается в доказанное successful read. Быстрые consecutive writes сохраняют latest selected value: serial/coalesced adapter writes либо explicit revision contract, выбранный по существующему owner. При failed persistence UI отделяет применённую визуальную настройку от durable save status.

Эта работа ориентировочно занимает **1.5-3k changed LOC** из уже указанного settings roadmap, confidence 5/10; точная оценка после persistence inventory. Никакой settings реализации, endpoint или acceptance в F0/F1/F2/D1/N1 из этого примера не следует.

### Roadmap остальных экранов в той же линии #252, если выбран этот scope

| Область | Следующий bounded flow | Главные seams/owners | Не добавлять автоматически |
|---|---|---|---|
| Create team | Roster/config draft -> save/promote | `team-configuration`, Desktop CreateTeamDialog, Hosted configuration panel, runtime lane planning | Unsupported provider/model/admission не подделывать; manual approval remains deferred |
| Launch team | prepare -> accepted -> progress -> stop/cancel | Existing Desktop provisioning + Hosted Owner gateway, `team-lifecycle`, `team-runtime-control` | Не переписывать provisioning сервис и не создавать второй supervisor |
| Team core screen | board read/actions, messages submit/outcome, member summary | `team-task-board`, `team-message-delivery`, team detail composition | Полный rich review/attachments не включать без promotion |
| Members/activity/logs | Select member -> bounded log/activity read | Existing member-log routes и dedicated features | Legacy HttpAPIClient stub не доказывает отсутствие Hosted route |
| Changes/review/Git | Read changes -> review decision/apply | `change-review`, Git authority ports | Write/apply и filesystem containment требуют отдельного admitted scope |
| Graph/crosslinks | Pure graph layout/selection -> existing navigation | `agent-graph`, TaskRef public models | Не терять stable task refs и не парсить identity из label |
| Settings | Appearance/locale + available sections | `localization`, appearance preferences, shell adapters | Remote OAuth, HTTP server config, WSL, filesystem paths, provider reset, native notifications - другие capabilities |

Estimate из предыдущего bottom-up inventory: create 4-7k, launch 3-5k, full team screen 22-38k, settings 1.5-3k, общая integration 2-4k. Они **не добавляются** к прежнему total 39.5-70.5k: уже включены в него. Новые F1 move/reset и F2 recovery/scope fixes поднимают rough весь набор до порядка 42-75k, точность 3/10; это не сумма новых независимых строк сверх selected milestone. Team core-only в старом inventory уменьшал scope примерно до total 27-48k, но этот диапазон тоже требует обновления после первых checkpoint. Remote terminal/editor не включены. Это план adaptation, не доказательство missing backend объёма.

## 10. Проверки: доступные команды и правильная гранулярность

### 10.1. Existing commands exact head

| Назначение | Реально существующая команда | Примечание |
|---|---|---|
| Быстрый touched-file lint | `pnpm lint:fast:files -- <changed files>` | Не type-aware final gate |
| TypeScript | `pnpm typecheck` | Уже pinned native TS7; не дублировать global tsc7 |
| Workspace types | `pnpm typecheck:workspace` | Root + MCP typechecks |
| Architecture | `pnpm guard:feature-architecture` | Без baseline expansion |
| File size | `pnpm guard:source-file-size` | <=800 new files, legacy shrink |
| Provisioning guard | `pnpm guard:team-provisioning-architecture` | При final check сохраняется |
| Focused Vitest | `pnpm exec vitest run <test paths>` | Брать existing config; targeted mocks не runtime proof |
| Controller tests | `pnpm --filter agent-teams-controller test` | Отдельный package suite |
| Workspace tests | `pnpm test:workspace` / `pnpm test:workspace:ci` | Включают root, arch Node, controller, MCP |
| Full reproducible check | `pnpm check` / `pnpm check:ci` | Guards, workspace check/build/MCP E2E, lint |
| Hosted production browser | `pnpm test:hosted:e2e` | `scripts/e2e/hosted-v1/run.ts`; suite selector `HOSTED_E2E_SUITE` |
| Hosted Vite build | `pnpm exec vite build --config docker/vite.hosted-renderer.config.ts` | В изолированном workspace, пишет out/renderer; не параллельно Desktop build в тот же output |
| Desktop interactive | `pnpm dev:mcp` | CDP renderer only; sandbox fixtures, без native folder picker/Computer Use |

`test:hosted:security` и `test:hosted:chaos` не существуют в exact `package.json`; старый master plan не превращает их в команды. Нужные cases привязать к действующим suites или добавить smallest missing case, а не объявить несуществующий скрипт выполненным.

Existing CI `.github/workflows/ci.yml`: workspace truth gate `pnpm validate:ci`, workspace packages/root shards, hosted E2E matrix `[core, phase-6, phase-8]`, Hosted lifecycle UI focused tests, process ownership test, lint scopes, Windows checks. Final actual required checks и variables перепроверить через `gh`; scope lock и executable workflow могут иметь исторические отличия (например legacy OIDC harness). Не включать Keycloak как обязательную новую product dependency из одного CI имени.

При выводе через `tail -20` сохранять exit code (`set -o pipefail`) либо писать полный лог в artifact и показывать tail. Нельзя принять зелёный tail за успешную команду.

### 10.2. Набор focused regression starting points

Использовать и расширять существующие сильные tests:

- `test/shared/utils/reviewState.test.ts`;
- `src/features/team-task-board/core/domain/policies/taskMutationReviewPolicy.test.ts`;
- `src/features/team-task-board/core/application/TeamTaskMutationCoordinator.test.ts`;
- `agent-teams-controller/test/hostedTaskCommand.test.js`;
- `test/features/team-task-board/core/application/createTeamTaskBoardActions.test.ts`;
- `test/features/team-task-board/HostedTaskBoardPageRetry.test.ts`;
- `test/renderer/components/team/HostedTeamWorkspace.test.tsx`;
- `test/renderer/utils/createTaskCommandIdentity.test.ts`;
- `src/features/agent-graph/renderer/hooks/useGraphCreateTaskDialog.test.tsx`;
- `src/features/running-teams/core/domain/__tests__/buildRunningTeamsDashboard.test.ts`;
- feature architecture tests и `test/architecture/hosted-web/phase-10/hosted-no-terminal-actual-vite-build.test.ts`.

**Новые unit-тесты минимальны по дублированию, а не по искусственному лимиту количества:** расширить existing fixtures для отдельных рисков из acceptance ledger; один test может покрывать несколько связанных assertions. Не объединять разные failure boundaries только ради обещания «один тест F2». Дополнительные cases нужны, когда существующая проверка не ловит конкретный риск. Предпочитать расширить существующие ценные fixtures, не размножать тот же сценарий по каждому слою. Обязательные existing regression, architecture/build и final exact-head E2E gates сохраняются - сокращение новых unit tests их не заменяет. Перед новым test автор кратко пишет, какая наблюдаемая поломка сделает его красным. Не добавлять тесты на source text, shape mocked function либо generated expected values из проверяемого кода. Structural guard fixture допустим, потому что его продукт и есть dependency enforcement; он не заменяет behavioral test.

### 10.2.1. Acceptance ledger для выбранного milestone

Это требуемые **поведения**, а не требование добавить отдельный новый test file на каждую строку. Существующий test counts as proof, если выполняется на final source и действительно проверяет утверждение. Перед новым test указать конкретную регрессию, которая сделает его красным.

| ID | Наблюдаемая поломка | Ближайшая сильная граница/evidence |
|---|---|---|
| F0-A | Browser entry тянет Desktop/API/Node через public facade | Actual Hosted Vite graph + existing artifact verification, forbidden edge fixture |
| F0-B | Новый direct facet обходит cross-feature/transitive guard | Guard fixture с alias и промежуточным reexport; baseline не расширен |
| F1-A | completed+needsFix становится approved/finished после extraction | Independent expected fixture + existing Product/controller callers |
| F1-B | Partial blocker map разрешает forbidden transition | Pure unknown/absent fixture + authoritative reader boundary |
| F1-C | Blocked «вернуть в Done» успел удалить placement | Real controller fixture с task+kanban bytes; Desktop IPC reaches one operation |
| F1-D | Package работает в workspace, но отсутствует в runtime artifact | Node consumer из собранного/packed layout + actual Hosted bundle + MCP/Electron packaging gate |
| F2-A | Double submit/remount даёт новый command | Core gate + одна actual form composition с StrictMode/lifetime |
| F2-B | Confirmed write + refresh failure разрешает duplicate create | Existing action test + typed interaction assertion; UI предлагает только refresh |
| F2-C | Lost ACK/capability withdrawal уничтожает intent | Full `HostedTeamWorkspace` composition, including non-create representative |
| F2-D | Generation change/rejected replay считается отсутствием effect | Exact frozen body + mismatch stays uncertain + positive descriptor observation |
| F2-E | Observation подтверждает чужую запись/обходит grant | Exact creation metadata, active/deleted, no-follow and current grant tests |
| F2-F | Late A result/403 меняет B или новый draft A | Workspace A/B and per-draft token assertions |
| F2-G | Prompt relay повторяется после observation/remount | Desktop Detail/Graph share gate; per-intent callback coverage, no callback on observation |
| F2-H | Единичный 403 удаляет uncertain intent либо revoked grant оставляет sensitive body | Actual AuthGate/shell 401/403 revalidation with same vs changed auth/grant; network/503 preserved |
| D1-A | Shared section меняет Desktop order или выдумывает Hosted counts | Existing ranking fixtures + unknown/degraded view assertions |
| D1-B | D1/N1 удваивают lifecycle requests/subscriptions | Workspace composition: одна in-flight read, one coalesced invalidation, cleanup |
| D1-C | Failed Desktop refresh выглядит fresh/empty из-за очищенного error | Existing source slice success -> failure and repeated initial task failure; retained rows stale, counts unknown |
| N1-A | TeamName/displayName или scope confusion открывает чужой tab/team | Navigation adapter tests с одноимёнными teams/scopes и current target lookup |
| N1-B | Partial failed list показывает No matches или очищает selection | Pagination + view state assertions; only complete success reconciles missing target |
| N1-C | Common row ломает rich Desktop action/menu/keyboard | Existing Desktop UI coverage + focused sibling-control interaction |
| N1-D | Старый complete list после create снимает новую selection | Delayed pre-create read -> receipt -> stale completion -> post-create bootstrap/list, including failed follow-up |
| I1-A | Все unit зелёные, но production imports остались старыми | Source consumer inventory + actual Desktop/Hosted sandbox UI flows |

**Минимальные UI сценарии без agents:** sandbox fixture с уже подготовленными fake deterministic source records для Desktop renderer и production Hosted transport/test deployment; open running row, search/filter chooser, A/B switch и keyboard/menu. Они не запускают provider runtime и не объявляются live team proof. Mutation UI flow с injected response loss использует existing deterministic harness и marker-owned task storage. Реальные launch/provider flows выполняются отдельно по accepted Core gates.

Evidence на checkpoint: exact source SHA, tested base SHA, команда/exit code, artifact/log path, checked behaviors из таблицы, известные failures и excluded cases. Git diff/grep подтверждает wiring, но не заменяет behavior. На final candidate guard/typecheck/required CI зелёные; production E2E использует соответствующий built artifact. Если после proof меняется source, повторяется только затронутая недоказанная часть, а final required CI остаётся на final exact head.

### 10.3. Final Core v1 proof остаётся обязательным

Foundation focused tests не заменяют accepted Core groups: auth/session/CSRF/Origin/Host; lifecycle/process cleanup; lost-response Tier B recovery; SSE handoff/restart/resync; task/message/external writer; workspace containment; capability degradation; runtime ingress security; manual-approval unavailability; runtime initial roster/status/logs; backup/restore drill.

Live acceptance: один production-composed mixed run Claude+Codex+официальный upstream OpenCode и по одному короткому independent provider smoke `create -> launch -> ready -> task -> message -> stop`. Gemini Hosted out of scope. Не возрождать fork. Не умножать provider-neutral navigation cases на все providers и не запускать полный matrix после каждого малейшего edit.

Все live tests только на **новых marker-owned sandbox/test projects**, отдельные каталоги/ports/volumes/compose project names. Никакого открытия реального проекта даже ради terminal/runtime. Cleanup затрагивает только smoke-owned процессы; shared hosts/tmux/user teams не трогать.

Тяжёлые builds/E2E выполнять на хостинге с изоляцией. Недоступность publisher из предыдущего исследования - историческое наблюдение, не свежий статус всего пула. Эта редакция плана runtime не запускала и не проверяла readiness worker pool. Перед будущим запуском повторно проверить supported runtime/pools через штатные status tools, не credentials. Quota/401 означает автоматический fallback по подходящим pool identities, не общий блокер после одного слота. Проверять machine identity, RAM/swap/disk; 5 GiB достаточно для допуска, реальный объём build считать отдельно. Не применять отменённый single-heavy-job lock.

## 11. Последовательность, lanes и единый итоговый PR

### 11.1. Checkpoints

| Checkpoint | Вход | Выход | Допустимая параллельная работа |
|---|---|---|---|
| P0 | Свежие gh head/base/checks + clean checkout | Exact main integration strategy, inventory accepted vs missing gates | Read-only source/test map; без competing writer |
| I0a | P0 preview: 29 conflicting files | Main/API seams integrated в сохранённую PR branch | Read-only fixtures; isolated pure/view work вне конфликтных файлов |
| F0 | Accepted architecture scope + I0a для shared seams | Canonical navigation/guards/public surface | F1 fixture design; D/N existing behavior inventory |
| F1 | F0 package/public rule + viability proof | Одна semantic authority, все названные consumers | F2 controller core по согласованному semantic contract |
| F2 | Stable public semantic contract | Один create/outcome owner в Desktop/Hosted, old copies removed | D1/N1 extraction после freeze их общих target contracts |
| D1 | Read/navigation seam | Общий running section и два consumers | N1 pure rules в непересекающемся scope |
| N1 | Opaque target/read model | Общий chooser browse/select flow | Остальные accepted MVP fixes и independent review |
| I0b | Все выбранные changes integrated | Повторная проверка main delta; final exact head pinned | Independent tests/builds на изолированных hosts |
| I1 | Exact final candidate | CI + relevant production E2E + Core acceptance evidence | Документация/PR description без изменения tested source |

Если main conflict касается semantic consumers, интегрировать main **до** широкого F1 extraction, чтобы не дублировать работу; если конфликт независим, можно подготовить semantic patch на pinned PR head и интегрировать до окончательной проверки. В любом случае final evidence привязан к интегрированному SHA. «Был зелёный CI до merge main» не закрывает новые риски.

### 11.1.1. Исполнимый порядок небольших patches

Сначала I0a интегрирует conflicting main/API seams. I0b перед I1 проверяет, не появились ли новые изменения main. Это две части одной строки I0 бюджета, не две полные integration работы. Приоритет не означает блокировать read-only fixtures, view inventory или isolated pure work, не затрагивающие конфликтные файлы.

| Patch | Scope/ownership | Depends on | Mergeable checkpoint и минимальное evidence | Оценка changed LOC |
|---|---|---|---|---:|
| F0 | Docs/guard + очищенный выбранный browser public surface | P0/I0a | Public export valid, actual graph без task-board substitution, guard fixtures | 650-1,100 |
| F1a | Package path/types/pure implementation | F0 pure subpath rule | Package viability; preparation внутри F1 review, ещё не claim «одна authority» | 350-600 |
| F1b | Product/controller readers и Hosted projection/executor | F1a contract | Independent semantics + connected consumers, duplicate policies удалены | 700-1,200 |
| F1c | Controller locked Desktop move + persisted review reset/reader compatibility + IPC/transport/UI switch | F1b и integrated Desktop API | Blocker-before-write; Review/Approved -> Done и completion follow-ups; F1 готов | 1,050-2,100 |
| F2a | Interaction model/controller/hook + unit contracts | F0; F1 types frozen | Preparation внутри F2 review; old UI ещё не называется migrated | 600-1,000 |
| F2b | Desktop registry, ACK/refresh split, Detail+Graph | F2a, I0a | Оба consumers, context/draft fence, output once per intent | 650-1,200 |
| F2c | Hosted registry/availability, rebase removal, observation + all-board lifetime fix | F2a и Product read/security contract | Full workspace race + descriptor observer; F2 готов | 1,290-2,240 |
| D1 | Running policy/props view, Desktop freshness source, Hosted shared read binding | F0; read target/snapshot contract frozen | Два production consumers и correct status/freshness mapping | 1,120-2,050 |
| N1 | Directory facts/controller/view + selection watermark + two navigation adapters | F0; общий read/target contract с D1 | Complete browse/select flow; old algorithms удалены | 1,580-2,660 |
| I1 | Cross-slice final wiring/review fixes/docs | F1/F2/D1/N1 и I0b | Final candidate CI + sandbox proof + retained Core evidence | 600-1,000 |

Подpatches F1a/F2a разрешены как commits/stacked review внутри #252, но не отдельная законченная доставка. Если dependent slice ещё не принят, новый unused implementation не рекламируется как replacement и не попадает в main отдельно. F1c/F2c могут превысить 2k при необходимости держать transport и consumers совместимыми; объяснить конкретный invariant и measured diff в review PR.

F2c включает non-create lifetime fix и observation в своём диапазоне. После первого patch пересчитать range по actual diff: при выходе за верхнюю границу уточнить остаток scope и costs, не удалять security/recovery checks ради цифры. D1 и N1 не обязаны ждать завершения F2: после agreed read model они идут параллельно, а integrator сериализует общий shell/public export switch.

### 11.1.2. Короткий контракт передачи writer/reviewer

Каждый job получает self-contained scope: exact base SHA/bundle digest, target #252 branch, этот план с нужными секциями, owned paths, expected public contract, запрещённые соседние paths, acceptance IDs и return format. Writer подтверждает Git lock доступность один раз; при read-only `.git` делает patch/evidence, не повторяет commit попытки. Общие `HostedTeamWorkspace`, public barrels, API/preload/IPC и root docs имеет одного текущего writer; helpers можно делать параллельно вне этих файлов.

Return format: patch/bundle от agreed base, actual additions/deletions отдельно от generated/lockfiles, tests с exit codes, unresolved risks, нужные integration edits. Никаких credentials/auth.json, real project fixture paths или claim о неисполненных gates. Reviewer получает exact applied SHA и проверяет security/semantic/lifetime boundaries, а не только summary writer. Review defects адресуются в том же ownership slice; source SHA меняется только после интеграции verified patch.

### 11.2. Ownership lanes

- **Integrator/main agent:** exact refs, main merge, public contract decisions, app shells, shared navigation bindings, cumulative evidence, PR #252.
- **Semantics writer:** controller pure module/package, Product review/task state delegates, dedicated semantic tests. Не редактирует React workspace shell.
- **Interaction writer:** F2 controller/ports/tests и согласованные create integrations. Интегратор сериализует изменения `HostedTeamWorkspace`, `TeamDetailView`, public barrels.
- **Read UI writer:** D1/N1 feature core/views/adapters; не переносит provisioning/task writer/backend routes.
- **Architecture guard writer:** F0 docs/guards/tests. Public export changes координирует с semantics writer.
- **Independent reviewer:** exact checkpoint diff, model Astra; не является автором того же slice.

Исполнение идёт через Hetzner subscription-runtime workers с отдельными jobs/workspaces и ownership. Реализация `gpt-6-sol` medium при этом подробном контракте, high для сложных boundary fixes; план/критика/review `gpt-6-astra` по риску. Запрашивать `serviceTier: fast` по последнему указанию owner и сверять фактический receipt; если project broker/policy откажет, не обходить admission вручную и не выдавать `default` за fast. Несколько workers могут использовать одну рабочую account identity при отдельных jobs; capacity решает runtime. Старый single-heavy-job lock не применяется по более позднему прямому указанию owner; тяжёлые проверки изолируют рабочие каталоги, порты и Compose project names.

После первого checkpoint измерить time-to-first-working-patch, focused-pass-first-attempt, review defects и число rework iterations. Этого достаточно; отдельная metrics платформа не нужна. Общий agent elapsed пока неизвестен.

### 11.3. Review PR topology

Default: каждый когерентный checkpoint коммитится и ревьюится в существующей PR252 delivery branch. Если diff удобнее review через stack:

1. `refactor/<bounded-slice>` начинается от точного #252 head или явно указанного предыдущего stack head.
2. Review PR target - #252 branch, не main.
3. Все tests относятся к своему head и base; reviewers знают dependency.
4. После приёма slice вливается в #252; следующий stack rebases/merges по принятой стратегии с сохранением чужой истории. Не force-rewrite contributor commits ради чистого stack.
5. #252 сохраняет единственное user-facing final merge в main, описание переписывается под фактический результат.

~2000 changed LOC - review target, не причина разрезать один invariant. F1/F2 могут потребовать 2-3k coherent diff; лучше объяснённое исключение, чем merged unused third authority. F2 допускает подготовительный commit и atomic consumer-switch commit внутри одного review checkpoint; подготовительный commit не называется готовой foundation delivery.

### 11.4. Git/identity/main procedure

Будущие действия, не выполненные этим планом:

- `gh pr view 252 --repo 777genius/agent-teams-ai` и `gh pr checks` + API для exact head/base/mergeability; `gh` для Actions/logs, не browser.
- Получить актуальный main, зафиксировать SHA, использовать clean isolated checkout. Dirty текущий checkout не трогать и не переносить как authoritative source.
- Default для уже большого общего PR: merge актуального main в его branch отдельным коммитом, чтобы сохранить review/contributor history. Rebase только если owner явно выбирает и это не ломает shared history.
- Перед **каждым** новым commit проверить `git var GIT_AUTHOR_IDENT` и `git var GIT_COMMITTER_IDENT`: оба `iliya <iliyazelenkog@gmail.com>`. Conventional commit, реальные issue refs в теле, без `--no-verify`.
- Hosted writer возвращает verified patch/bundle от общего exact base; механический commit делает orchestration shell с owner identity. Не пытаться многократно commit в read-only `.git` sandbox.
- Существующие external contributor PR сохраняют PR/authorship. Если их branch недоступен, integrate через их PR до owner fixes; не заменить owner-only squash.
- Перед final merge fresh exact head/main status и required checks; после merge проверить итоговый commit message/issue links через gh. Публикация release отдельно.

## 12. Оценка без двойного счёта

**Changed LOC = additions + deletions**, включая перенос файлов. Это не новые production lines, не число дублей и не процент готовности MVP. В таблице каждый кусок учитывается один раз: package/semantic contracts только F1; public guards/facet только F0; outcome state только F2; read row/target facts D/N не дублируются в integration. App navigation mapping и shell callbacks, используемые D1/N1, учитываются один раз в N1; D1 имеет только узкий callback с opaque key. Отдельного общего navigation framework или взаимной зависимости feature core нет. Если D1 поставляется раньше N1, integrator переносит стоимость этого небольшого composition seam между строками, сохраняя общий subtotal.

| Checkpoint | Additions | Deletions | Changed LOC | Human hours |
|---|---:|---:|---:|---:|
| F0 docs/guards/public surface | 400-650 | 250-450 | 650-1,100 | 5-9 |
| F1 package/policy + consumers + bounded Desktop move/reset | 1,300-2,350 | 800-1,550 | 2,100-3,900 | 22-41 |
| F2 create/outcome + both compositions + recovery lookup/auth revalidation | 1,880-3,230 | 820-1,560 | 2,700-4,790 | 28-50 |
| **Foundation subtotal** | **3,580-6,230** | **1,870-3,560** | **5,450-9,790** | **55-100** |
| D1 running section/open team + Desktop freshness | 730-1,310 | 390-740 | 1,120-2,050 | 14-28 |
| N1 directory/filter/select/open + watermark | 1,050-1,700 | 530-960 | 1,580-2,660 | 21-39 |
| I1 cross-slice integration tests/docs cleanup | 400-700 | 200-300 | 600-1,000 | 6-12 |
| **Foundation + D1/N1 + I1** | **5,760-9,940** | **2,990-5,560** | **8,750-15,500** | **96-179** |
| I0 main integration, 29 conflicted files / 109 marker hunks | 700-2,000 | 500-1,500 | 1,200-3,500 | 12-32 |
| **Выбранный примерный пакет с I0** | **6,460-11,940** | **3,490-7,060** | **9,950-19,000** | **108-211** |

Выбранный пример - **F0/F1/F2 + D1/N1 + I1: 8,750-15,500 changed LOC и 96-179 human hours**, до I0. D2/N2 удалены как не имеющие самостоятельного acceptance; прежние грубые оценки полной адаптации Dashboard 1.5-3k и Chooser 2.5-4.5k не являются строками этого бюджета и не прибавляются к нему. F0b all-facets ratchet не включён: после inventory получить отдельную оценку; не маскировать его в F0 reserve.

Это уточняет прежние foundation 3-6k/24-40h: добавлены package viability, реальный Desktop move command, create recovery lookup/rebase fix, graph consumer и composition-level safety. F2 прирост round 2 640-1,240 changed LOC/9-16h складывается из read-only lookup 450-850, availability scope fencing 70-140 и Desktop registry 120-250. Оценка не является измеренным фактом. Confidence: source boundaries 8/10; foundation LOC 5/10; D/N LOC 5-6/10; human time 4/10; main conflict reserve 4/10 после mechanical preview, до ручного разрешения 29 файлов.

**Не включено:** все оставшиеся дефекты PR252, ещё недоказанные Core release gates/live provider failures, инфраструктурное восстановление hosted publisher, новая remote backend capability, publication/release operations, full parity всех экранов. I1 - incremental integration этих slices, не цена завершения всего нынешнего PR. I0 1.2-3.5k/12-32h заменяет прежний оптимистичный 300-1,200/4-16h после измерения 29 конфликтующих файлов и 109 marker hunks. Эти 109 не умножаются на среднюю длину hunk для расчёта LOC. Main conflict reserve может выйти за диапазон после semantic resolution actual conflict paths; это требует переоценки, не сокрытия в «misc».

Human hours включают реализацию, focused verification и один нормальный review/rework cycle. Это не LOC/h формула и не ETA Codex. При независимых lanes часть труда параллельна, но contract/package -> consumers -> integrated exact-head proof остаётся последовательной. Agent wall-clock/token cost **неизвестны** до измеренного первого checkpoint. Не обещать «пара часов» из скорости генерации текста.

Для всего ранее перечисленного набора экранов старый трудовой диапазон был 470-868 human hours. После расширения foundation move/recovery/reset и source freshness грубый ориентир порядка 505-940 human hours, точность 3/10. Он включает выбранный milestone, поэтому не складывается с 96-179 часами из таблицы; сроки/стоимость автономных агентов из него не следуют.

## 13. Критический путь и риски

| Риск | Вероятность/влияние | Действие и stop condition |
|---|---|---|
| CJS package/root transitively тянет Node/MCP | 7/10, 9/10 | F1 viability first. Не массово переключать consumers до actual browser/packaging proof |
| Semantics silently меняют completed/review/actionable meaning | 6/10, 9/10 | Independent fixture table; owner решение только для реально неразрешимого product conflict |
| Unknown blocker превращается в absent | 5/10, 9/10 | Tri-state facts, authoritative adapter test, fail closed для unknown |
| Lost ACK + capability change удаляет intent | 7/10, 9/10 | Stable scope session; full workspace integration, не только mock transport |
| Durable create replay повторяет дополнительные messages | 6/10, 8/10 | Effect profile, one post-confirm callback, guaranteed replay только после authority proof |
| Public facet bypass остаётся через alias | 5/10, 8/10 | Resolved graph + public export tests; no baseline expansion |
| Desktop rich behavior теряется при common DTO | 7/10, 8/10 | Honest extensions; original Desktop fixtures; no fake missing fields |
| Main conflicts делают старое evidence нерелевантным | Подтверждён конфликт, impact 8/10 | Early preview/integration, финальный exact SHA |
| Scope разрастается до full parity | 8/10, 9/10 | Scope table и explicit promotion, selected slices в PR description |
| Hosted runtime/pool может быть недоступен | Исторический failure, свежий статус не измерен | Проверить все configured подходящие pools/hosts по правилам fallback; не заменять молча hosted work локальными workers |

Critical path для foundation: **accepted scope -> exact baseline + I0a -> pure package viability -> semantic consumer switch -> F2 workspace lifetime -> integrated final exact-head CI/E2E**. D1/N1 образуют параллельную read/navigation ветку после F0+contract freeze и сходятся с F2 перед I1; они не последовательный blocker каждого F2 шага. D/N pure/view work можно готовить после contract freeze; app shell edits и final evidence ownership сериализованы интегратором. Нет cooldown или повторного full CI без изменения SHA/доказанного нового риска.

## 14. Решения, которые нужно закрепить перед writer dispatch

Большинство defaults уже конкретны:

- ✅ Один итоговый PR #252; optional stack только внутрь его ветки.
- ✅ Existing controller pure subpath, а не новый shared engine/package.
- ✅ F2 без общей JSX-формы, но с двумя production create consumers и устранением old state owners.
- ✅ Product Hosted tasks read-only; Owner/controller write, Owner relay delivery; официальный upstream OpenCode.
- ✅ Dashboard D1 использует existing lifecycle reads, Chooser N1 read/select; нет automatic promotion deferred backend.
- ✅ Desktop rich create/status effects сохраняются и явно объявляются; безопасный replay не придумывается.

Перед writer dispatch не осталось общего architecture approval gate. Условия изменения принятого scope:

1. **Scope выбран owner:** F0/F1/F2 + D1/N1 + I0/I1 + ранее принятый Core v1 acceptance в одном финальном PR #252. Остальной roadmap не делать без отдельного решения, кроме конкретной работы, которую требует доказанный gate этого scope.
2. **Если independent fixtures обнаружат иной product expectation по needsFix/approval:** привести конкретный counterexample и предлагаемые результаты. Default Product existing contract сохраняется; не спрашивать абстрактно «какую архитектуру предпочитаете».
3. **Если нужен Hosted rich feature из deferred list:** scope-lock amendment до writer, с собственным smallest workflow acceptance. Это отдельное product решение, не техническая «допилка экрана».

Package path/build resolution и exact adapter shapes решает writer по viability proof в рамках этого контракта. Не превращать каждый import в approval gate.

## 15. Definition of Done выбранного milestone

- [ ] В PR description ясно указан выбранный scope и ещё deferred capabilities.
- [ ] Main integration выполнена с сохранением contributor history; final candidate mergeable.
- [ ] One pure task authority обслуживает все заявленные Desktop/Hosted consumers; migrated algorithm copies удалены.
- [ ] Public package path одинаково работает в TS, Node/controller, tests, actual Hosted bundle и production packaging.
- [ ] Review divergence fixture имеет явное expected значение; unknown/absent/completeness не смешаны.
- [ ] One create/outcome controller используется реальными Desktop/Hosted forms; identity/gate не принадлежат component lifetime.
- [ ] Confirmed write + refresh failure, capability withdrawal, exact replay и A/B scope races доказаны на подходящих границах.
- [ ] Owner/controller и relay ownership/security fences сохранены; нет второго writer/relay.
- [ ] D1/N1 реализованы: обе compositions используют common policy/view, honest unknown fields; Desktop rich actions, sorting/navigation и Hosted admission сохранены.
- [ ] Architecture/source-size/typecheck/focused tests прошли; final CI и необходимые production/sandbox E2E привязаны к final exact SHA.
- [ ] Accepted Core v1 live/release evidence не заменено unit tests; unproven cases перечислены явно.
- [ ] Rollback представляет coherent revert без storage migration и permanent parallel implementation.
- [ ] Canonical docs отражают фактически выполненную архитектуру; parked r6/history сохранены без ложной execution authority.

📌 Foundation означает одну semantic authority и один настоящий shared create flow. Dashboard и Chooser показывают повторяемый способ переноса, сохраняя Desktop behavior и Hosted security/admission. Всё выбранное доставляется через #252; full parity и новые remote capabilities включаются только явным scope решением.
