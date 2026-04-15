# План: TeamDetail Snapshot / Messages / Member Activity Split

**Дата**: 2026-04-15  
**Статус**: Detailed execution-ready architecture plan  
**Цель**: убрать structural render churn из `TeamDetailView` и отделить message-heavy данные от structural snapshot команды

## Executive Summary

Выбранный вариант:

`Split TeamDetail data flow into structural snapshot + paginated messages + member activity meta`
`🎯 9   🛡️ 9   🧠 8`
Примерно `1600-2600` строк изменений

Это не "ещё один локальный guard", а нормализация границ данных:

- `getData(teamName)` перестаёт быть transport для message-heavy UI
- `getMessagesPage(teamName, { limit, cursor })` остаётся единственным сообщенческим feed API
- добавляется новый IPC endpoint `getMemberActivityMeta(teamName)`
- renderer хранит structural snapshot отдельно от message cache
- `refreshTeamData()` получает structural sharing + no-op suppression даже после split

Самое важное:

- текущий semantic-equality guard перед `set()` - правильная мысль, но это только часть решения
- если сделать только guard, можно снять текущий crash, но архитектурная сцепка `TeamData <-> messages <-> TeamDetailView` останется
- если сделать split + guard вместе, это уже похоже на правильный долгоживущий вариант

## Quick Execution Path

Если исполнитель не хочет читать весь документ линейно, безопасный порядок такой:

1. Сначала новые shared contracts и worker ops.
2. Потом `TeamMessageFeedService` с stable effective identity и `feedRevision`.
3. Потом structural `getData()` и отдельный `MemberActivityMetaService`.
4. Потом store ownership for messages/meta, single-flight и stale-response guards.
5. Потом migration consumers: `MessagesPanel`, `ActivityTimeline`, `MemberDetailDialog`, `MemberMessagesTab`, `MemberHoverCard`, `StatusBlock`, `TeamDetailView`, graph.
6. Потом event routing split.
7. Потом structural sharing + no-op suppression.
8. Только после этого выпиливать legacy fields и compatibility plumbing.

Неправильный порядок, которого надо избегать:

1. Сначала менять UI consumers, пока feed/meta/store contracts ещё не зафиксированы.
2. Сначала удалять `TeamData.messages`, пока graph/dialog/messages consumers ещё на нём сидят.
3. Сначала добавлять polling в store без single-flight/coalescing.

## Locked Decisions

Ниже решения, которые в этом плане считаются **закрытыми**, а не оставленными "на потом".

### 1. Naming and transport

- IPC route name **не меняем**: остаётся `team:getData`
- public method name **не меняем**: остаётся `getData(teamName)`
- но тип ответа **меняем** на новый structural contract `TeamViewSnapshot`
- repo-wide alias вида `type TeamData = TeamViewSnapshot` **не оставляем** после merge

Причина:

- transport rename сейчас только раздует diff
- а вот новый тип нужен, чтобы код и тесты перестали мыслить `getData()` как message transport

Допустимо локально во время промежуточной сборки держать временный compatibility alias, но в merged коде его быть не должно.

Дополнительное правило:

- если temporary compatibility alias или adapter переживает тот commit slice, в котором переводится его последний consumer, это уже smell и план выполняется неверно

### 2. Snapshot is structural only

- merged код **не должен** читать `messages` из snapshot
- `messages` больше не часть `TeamViewSnapshot`
- `members` в snapshot больше не считаются от full message history

### 3. Message ownership

- единственный message feed API в этом PR - `getMessagesPage()`
- новый отдельный `getMessagesHead()` в этом PR **не добавляем**
- если понадобится оптимизация, делаем её **внутри** `getMessagesPage()` или store caching, без второго transport contract
- existing `MessagesPage` contract расширяем полем `feedRevision`
- store action `refreshTeamMessagesHead()` должен возвращать semantic result c минимум двумя флагами:
  - `feedChanged` - изменился ли revision всего normalized feed
  - `headChanged` - изменился ли реально текущий canonical head slice в store
- но hot path `getMessagesPage()` при этом **обязательно** должен перестать быть full rescan/full normalize на каждый вызов
- для этого в main добавляется shared normalized message feed cache/index, которым пользуются и `getMessagesPage()`, и `getMemberActivityMeta()`

Причина:

- исторический backfill может менять exact member activity semantics без видимого изменения top page
- store не должен гадать про full-feed change только по diff первой страницы

### 4. Message activity ownership

- exact full-history message-derived facts идут в `getMemberActivityMeta()`
- renderer **не должен** вычислять exact `messageCount` или `lastActiveAt` только по head page messages
- итоговый member `status` как display field **не храним** как final truth в meta
- meta хранит raw facts, а display status собирается в renderer overlay из:
  - `lastAuthoredMessageAt`
  - `latestAuthoredMessageSignalsTermination`
  - `currentTaskId`
  - spawn/runtime state

### 5. `messageCount` semantics

- в этом PR semantics **сохраняем**
- `messageCount` остаётся **exact historical count**
- для этого закладываем shared normalized feed cache + meta cache по `feedRevision`
- вариант с `recentMessageCount` в этом PR **не принимаем**

### 6. Pending replies semantics

- `pendingRepliesByMember` остаётся renderer-local UI state
- `crossTeamPendingReplies` остаётся renderer-derived состоянием от message cache + local TTL
- `TeamMemberActivityMeta` **не становится** ticking transport для этих таймерных состояний

Причина:

- эти состояния частично зависят от local wall clock и текущего UX контекста таба
- перенос их в main/meta создаст лишнюю связанность и сломает текущую интерактивную модель

### 6.1 Frozen semantics in this PR

Чтобы performance refactor не превратился в скрытый product-change PR, в этом PR **не меняем**:

- значение и смысл existing pending-reply waiting windows
- значение и смысл cross-team pending TTL badges
- значение coarse fallback polling intervals, кроме случаев where implementation forces tiny mechanical adjustment
- смысл `active` / `idle` member status thresholds
- exact-vs-recent meaning of `messageCount`
- default head page size / default first-screen message density без отдельного явного решения
- текущий default head request limit остаётся `50`, пока не принято отдельное явное решение его менять

Если какой-то из этих пунктов всё-таки приходится менять ради correctness:

- это должно быть отдельно отмечено в PR description
- change должен иметь отдельный тест
- и это уже считается product-semantic change, а не "просто часть split"

### 7. Fetch ownership after migration

- после split компоненты UI не вызывают `api.teams.getMessagesPage(...)` напрямую
- message fetching ownership переезжает в store actions
- `MessagesPanel`, `MemberMessagesTab`, graph-consumers становятся passive consumers store state

### 8. Worker boundary

- raw feed rebuild и meta build не должны неожиданно вернуться на main event loop
- в этом PR используем существующий `team-data-worker` boundary, а не заводим второй отдельный worker
- `getData()`, expensive `getMessagesPage()` rebuild path и `getMemberActivityMeta()` должны идти через одну и ту же worker strategy

Важная практическая оговорка:

- текущий `TeamDataWorkerClient` умеет fallback на main-thread execution, если worker artifact недоступен
- для новых hot paths это допустимо только как test/unpacked-dev escape hatch
- packaged runtime не должен молча остаться без worker и продолжить heavy feed rebuild на main loop

Значит в плане реализации надо предусмотреть:

- явную проверку availability для packaged runtime
- диагностический log/metric, если worker path не найден
- тест или smoke check, что message/meta ops реально доходят до worker path в нормальном runtime

Причина:

- иначе можно исправить renderer stall, но занести новую main-thread stall точку
- в кодовой базе уже есть готовый паттерн для heavy team I/O

### 9. Polling ownership

- fallback polling после миграции остаётся, но переезжает в store
- компоненты не владеют polling lifecycle
- polling нужен только как safety net на случай missed file/runtime events

### 10. Temporary old-shape guard policy

Если semantic-equality guard на старом mixed `TeamData` shape уже существует или приземлится раньше полного split, его статус в этом плане фиксированный:

- это **temporary mitigation**, а не final architecture endpoint
- он не является причиной откладывать snapshot/messages/activity split
- новые consumers не должны начинать зависеть от старой mixed compare semantics
- после перехода на `TeamViewSnapshot` final no-op suppression должен работать уже на новом structural shape
- в merged target не должно остаться comparator logic, которое продолжает сравнивать `messages` внутри legacy snapshot только потому, что "так уже было"

Иначе легко зацементировать старую неверную data boundary под видом performance fix.

### 11. Store shape ownership

- canonical owner structural snapshot state после split - `teamDataCacheByName`
- `selectedTeamData` в этом PR можно оставить как convenience field для текущей команды
- но `selectedTeamData` не должен жить отдельной второй жизнью
- если `selectedTeamData` присутствует, он всегда должен ссылаться на тот же object ref, что и `teamDataCacheByName[selectedTeamName]`

Дополнительная жёсткая оговорка:

- предпочтительный merged target - удалить `selectedTeamData` целиком, как только это станет механически просто
- сохранять его допустимо только как literal alias/pointer convenience field без собственной логики пересборки и без второго write path
- если для поддержки `selectedTeamData` нужен отдельный код синхронизации, значит поле уже не оправдано и должно быть удалено

Причина:

- иначе можно вроде бы "починить snapshot cache", но оставить hidden churn через second selected-only copy
- для no-op suppression важен именно ref reuse одного canonical объекта, а не две почти одинаковые структуры

### 12. Out of scope for this PR

- не делаем новый REST API
- не делаем `PaneContent` unmount refactor
- не делаем virtualization как primary fix
- не делаем graph redesign beyond data-source migration
- не делаем вторую параллельную message model "на время"

## Source Of Truth Map

Это обязательная карта владения данными. Если при реализации какая-то часть начнёт читаться не отсюда, это почти наверняка путь к регрессии.

| Concern | Source of truth | Who derives view state | Must not come from |
| --- | --- | --- | --- |
| Structural team detail | `getData()` -> `TeamViewSnapshot` | store selectors / view-model adapters | message cache, `MessagesPanel` props |
| Normalized message feed | main-side shared feed cache/index | `getMessagesPage()`, `getMemberActivityMeta()` | repeated raw full rescans in each consumer |
| Message feed | `getMessagesPage()` -> `teamMessagesByName` + `selectTeamMessages(teamName)` | `MessagesPanel`, `MemberMessagesTab`, graph | `selectedTeamData`, `TeamViewSnapshot` |
| Full-feed freshness | `MessagesPage.feedRevision` + store cache entry revision | refresh routing / meta invalidation | head-slice diff heuristics only |
| Message identity | main-side effective message identity emitted in feed/page responses | store merge, cursor stability, read state, optimistic confirmation | ad-hoc renderer-only fallback identity |
| Exact member activity facts | `getMemberActivityMeta()` -> `memberActivityMetaByTeam` | member list / headers / hover / status presentation | loaded head messages only |
| Member awaiting-reply state | renderer-local `pendingRepliesByMember` | `TeamDetailView`, `MemberList`, `PendingRepliesBlock` | main/meta snapshot |
| Cross-team pending reply TTL state | renderer-derived from message cache + `Date.now()` | `StatusBlock` | main/meta snapshot |
| Spawn liveness | `memberSpawnStatusesByTeam` | member badges / merged display status | message meta |
| Message dedup semantics | main-side message services | renderer only consumes normalized output | renderer re-dedup logic |

## Hard Invariants

Если любой из пунктов ниже нарушается, значит реализация ушла в неправильную сторону.

1. В merged коде не должно остаться чтения `selectedTeamData.messages`.
2. Exact `messageCount` и `lastActiveAt` не считаются в renderer по `selectTeamMessages(teamName)`.
3. `MessagesPanel` и `MemberMessagesTab` не имеют собственного IPC fetching logic после миграции.
4. Main остаётся единственным местом, где выполняется dedup `lead_session` / `lead_process`.
5. Pending-reply timer logic не переезжает в main process.
6. `lead-message` event не вызывает full `refreshTeamData()` по умолчанию.
7. В merged коде не живут две долгоживущие message models одновременно.
8. Message/meta refresh не крутятся бесконтрольно для hidden inactive teams.
9. `getMessagesPage()` и `getMemberActivityMeta()` не делают независимый полный raw rescan истории на каждый hot refresh.
10. Expensive feed rebuild path не выполняется на Electron main event loop.
11. Store не выводит "full feed changed" только по diff первого page slice; для этого используется `feedRevision`.
12. `TeamListView` и любые multi-team overview screens не гидратят messages/meta для каждой команды по умолчанию.
13. `getMessagesPage()` отдаёт stable effective message identity для каждого message row; store merge/cursor logic не живут на двух разных key semantics.
14. `selectedTeamData`, если сохраняется, reuse'ит ref из `teamDataCacheByName`, а не создаёт вторую independent snapshot copy.
15. `feedRevision` отражает состояние full normalized feed, а не время rebuild или raw invalidation fingerprint.
16. Если older history после revision change нельзя склеить без сомнений, canonical older tail сбрасывается, а не показывается mixed inconsistent state.

## Forbidden Shortcuts

Ниже shortcuts, которые выглядят как "быстро и почти правильно", но в контексте этого плана считаются ошибкой реализации.

1. Оставить `messages` в snapshot "пока временно", а потом забыть убрать.
2. Считать `messageCount` / `lastActiveAt` по head page или по уже загруженным сообщениям в renderer.
3. Перенести fetching в store, но оставить прямые `api.teams.getMessagesPage(...)` в `MessagesPanel` или `MemberMessagesTab`.
4. Сделать `refreshMemberActivityMeta()` зависимым только от head-slice diff без `feedRevision`.
5. Держать два merge paths для messages: один в store, второй в компоненте.
6. Позволить packaged runtime тихо выполнять expensive message rebuild path на main thread при пропавшем worker.
7. Сохранить и `teamDataCacheByName`, и отдельно пересобираемый `selectedTeamData`.
8. Начать греть `getMessagesPage()` / `getMemberActivityMeta()` для multi-team overview "ради удобства".

## 1. Top 3 Variants

### 1. Full split: structural snapshot + messages cache + member activity meta

`🎯 9   🛡️ 9   🧠 8`
Примерно `1600-2600` строк

Идея:

- `TeamData` больше не является message transport
- сообщения живут в отдельном cache/store path
- member list/status/meta перестают зависеть от нового `messages` array ref на каждый refresh
- `lead-message` и `inbox` events больше не триггерят full detail refresh

Плюсы:

- бьёт в корень renderer saturation
- уменьшает payload, churn и layout/paint rework
- делает поведение предсказуемым для долгих soaks
- готовит нормальную основу для graph/activity/members

Минусы:

- широкий blast radius
- надо аккуратно мигрировать graph и dialog consumers

### 2. Только semantic-equality guard перед `set()` в `refreshTeamData`

`🎯 7   🛡️ 6   🧠 4`
Примерно `250-450` строк

Идея:

- оставить `getData()` как есть
- сравнивать новый snapshot с предыдущим
- не вызывать `set()` если semantic state не изменился

Плюсы:

- быстро
- скорее всего снимет именно observed "new ref without visible change"

Минусы:

- `TeamData` остаётся перегруженным transport'ом
- любой реальный message change всё ещё трогает большой subtree
- архитектурная связка не исправляется
- остаётся риск новых форм churn вокруг graph/member dialogs/status blocks

### 3. UI-side memoization / virtualization / more throttling без data split

`🎯 5   🛡️ 5   🧠 6`
Примерно `500-900` строк

Идея:

- сильнее мемоизировать `MessagesPanel`, `ActivityTimeline`, `TeamDetailView`
- агрессивнее throttle / debounce refreshes
- возможно добавить virtualization

Плюсы:

- может уменьшить симптомы
- полезно как secondary optimization

Минусы:

- не чинит wrong data boundary
- будет лечить последствия вместо причины
- легко получить сложную, хрупкую UI-логику

### Final Choice

Берём **вариант 1**.  
Но важная поправка: semantic guard из варианта 2 всё равно нужен внутри варианта 1.

## 2. Краткая суть проблемы

Проблема уже не в `persistLaunchStateSnapshot` storm. Он был причиной A и, судя по логам, уже прижат.

Текущая причина B выглядит так:

- `refreshTeamData()` регулярно создаёт новый `selectedTeamData` ref
- `TeamDetailView` подписан на весь `selectedTeamData`
- даже когда по смыслу ничего не изменилось, вниз уходит новый `messages` ref
- `MessagesPanel`, `ActivityTimeline`, member activity derivations и часть graph-related logic заново гонят filter/group/layout/paint
- React Profiler молчит, потому что commit time сам по себе не гигантский, а дорогой кусок сидит в browser layout+paint на 50+ message DOM nodes
- из-за mounted tabs через CSS toggle скрытые team tabs тоже могут держать живые тяжелые subtree

Итог:

- sustained long tasks по 150-500ms
- почти нет idle gaps
- heap распухает как следствие sustained work
- дальше уже возможен Chromium/V8 native fault `132/133`

Это очень похоже на "renderer saturates itself useful-looking no-op work", а не на обычную JS memory leak.

## 3. Факты из текущего кода

### 3.1 Что уже хорошо

`messages` уже частично вынесены:

- `src/main/services/team/TeamDataService.ts` уже имеет `getMessagesPage()`
- `src/preload/index.ts` уже прокидывает `team:getMessagesPage`
- `src/shared/types/api.ts` уже описывает `TeamsAPI.getMessagesPage(...)`
- `src/renderer/components/team/messages/MessagesPanel.tsx` уже грузит страницы через `getMessagesPage()`
- `src/renderer/components/team/members/MemberMessagesTab.tsx` тоже умеет грузить страницы через `getMessagesPage()`

То есть messages feed как отдельная boundary уже существует. Это важный факт.

### 3.2 Что всё ещё дорого даже после split, если это не исправить

Текущий `getMessagesPage()` в `TeamDataService` на каждый вызов:

- заново читает inbox / lead texts / sent messages
- заново делает dedup `lead_session` / `lead_process`
- заново делает enrichment `leadSessionId`
- заново сортирует весь массив
- и только потом режет страницу

Это значит:

- если после split мы просто чаще зовём `getMessagesPage()` на `lead-message` / `inbox`, можно перенести часть нагрузки из renderer обратно в main
- transport boundary сама по себе не гарантирует дешёвый hot path

Поэтому shared main-side normalized message feed cache - не nice-to-have, а часть правильного решения.

### 3.3 Что всё ещё не разделено

`getData()` всё ещё остаётся смешанным transport'ом:

- собирает messages
- режет их до `MAX_RETURN_MESSAGES = 50`
- возвращает `messages` внутри `TeamData`
- передаёт `messages` в `TeamMemberResolver.resolveMembers(...)`

Это означает:

- даже "structural" refresh тянет message-derived часть модели
- members в snapshot зависят от message history
- новый `TeamData` ref почти гарантирован даже при пустом visible diff

### 3.4 Где сейчас сцепка особенно сильная

- `src/renderer/store/slices/teamSlice.ts` - `refreshTeamData()` всегда пишет новый `selectedTeamData`
- `src/renderer/components/team/TeamDetailView.tsx` - подписка на весь `selectedTeamData`
- `src/renderer/components/team/messages/MessagesPanel.tsx` - `effectiveMessages = merge(fetchedMessages, propMessages)`
- `src/renderer/components/team/activity/ActivityTimeline.tsx` - filter/group/visible timeline расчёты идут от whole messages array
- `src/renderer/components/team/members/MemberDetailDialog.tsx` - диалог получает `messages` из team snapshot
- `src/features/agent-graph/renderer/adapters/TeamGraphAdapter.ts` - graph всё ещё читает `TeamData.messages`
- `src/renderer/components/layout/PaneContent.tsx` - табы не размонтируются, а скрываются через `display: none`

### 3.5 Вывод из этих фактов

Messages уже выделены как feed API, но snapshot модели и renderer subscriptions ещё живут так, как будто messages по-прежнему часть основной detail модели.

Значит реально надо разделять не "messages вообще", а вот это:

- structural team snapshot
- message feed
- message-derived lightweight member/team activity meta

Именно `getMemberActivityMeta` здесь ключевой новый слой.

## 4. Почему текущий semantic guard - хороший, но недостаточный

Фраза "semantic-equality guard перед `set()` звучит как самый правильный следующий шаг" по сути верная.

Но глубже:

- как immediate mitigation - да, это правильный следующий шаг
- как final architecture - нет, этого мало

Почему он всё равно нужен:

- он гасит no-op churn
- он дешёв относительно эффекта
- в кодовой базе уже есть хороший precedent в `fetchMemberSpawnStatuses()` с semantic equality suppression

Почему его мало:

- `TeamData` всё ещё останется слишком широким контрактом
- message churn всё ещё будет инвалидировать большой subtree
- graph/member dialogs/status block всё ещё будут сидеть на том же data blob
- сама форма данных останется неправильно сцепленной

Правильная формулировка:

> semantic guard нужен обязательно, но как часть split architecture, а не вместо неё

## 5. Что именно надо разделить

Здесь важно не запутаться.

### 5.1 Нет, messages не надо "разделять с нуля"

Они уже разделены:

- есть `getMessagesPage()`
- есть pagination
- renderer уже умеет этим пользоваться

### 5.2 Да, в основном надо разделить `member activity meta`

Потому что именно она сейчас скрыто живёт внутри `TeamData` через:

- `ResolvedTeamMember.status`
- `ResolvedTeamMember.messageCount`
- `ResolvedTeamMember.lastActiveAt`
- status blocks и pending replies, которые сейчас фактически упираются в `messages`

### 5.3 И да, `getData()` надо сделать более structural

Не в смысле "разрезать на 20 endpoints", а в смысле:

- убрать из него message-heavy responsibility
- перестать использовать full message array как часть canonical detail snapshot

То есть ответ на вопрос "мы что в основном разделяем `getMemberActivityMeta`?" такой:

**Да.**  
Но это работает только вместе с тем, что `getData()` перестаёт быть message-derived snapshot'ом.

## 6. Endpoint ли это REST

Нет.

В этом проекте это должен быть **IPC endpoint**, а не REST API endpoint.

То есть по форме это будет что-то в таком духе:

- `TEAM_GET_MEMBER_ACTIVITY_META = 'team:getMemberActivityMeta'`
- wiring в `src/main/ipc/teams.ts`
- preload bridge в `src/preload/index.ts`
- тип в `src/shared/types/api.ts`

Так что слово "endpoint" здесь надо понимать как app-internal IPC surface.

## 7. Целевая архитектура

## 7.1 Data boundaries

Нормальная финальная схема должна выглядеть так:

1. `getData(teamName)` возвращает **structural snapshot**
2. `getMessagesPage(teamName, { limit, cursor })` возвращает **сообщения**
3. `getMemberActivityMeta(teamName)` возвращает **лёгкие message-derived aggregate данные**

В renderer это хранится раздельно:

- `teamDataCacheByName[teamName]`
- `teamMessagesByName[teamName]`
- `memberActivityMetaByTeam[teamName]`

### Concrete naming note

Чтобы не плодить в документе две конкурирующие сущности, structural snapshot cache в renderer дальше следует понимать так:

- концептуально - snapshot cache per team
- конкретно в текущем плане и store shape - `teamDataCacheByName`

Отдельный bucket `teamSnapshotByName` в этом плане не вводится.

А UI собирает view-model как overlay:

- base structural team snapshot
- overlay member activity meta
- overlay latest loaded messages
- overlay member spawn statuses

## 7.2 Что остаётся в structural snapshot

Должно остаться:

- `teamName`
- `config`
- `tasks`
- `kanbanState`
- `processes`
- `warnings`
- `isAlive`
- structural member description из config/meta

### Важная корректировка по `members`

Сейчас `ResolvedTeamMember` смешивает structural и message-derived поля.

Это надо разрулить.

Есть два пути:

1. Либо ввести новый тип `TeamMemberSnapshot`
2. Либо оставить `ResolvedTeamMember`, но вытащить из него message-derived смысл в отдельный overlay

Для надёжности и понятности лучше путь 1.

### Предлагаемый structural member type

```ts
export interface TeamMemberSnapshot {
  name: string;
  currentTaskId: string | null;
  taskCount: number;
  color?: string;
  agentType?: string;
  role?: string;
  workflow?: string;
  providerId?: TeamProviderId;
  model?: string;
  effort?: EffortLevel;
  cwd?: string;
  gitBranch?: string;
  runtimeAdvisory?: MemberRuntimeAdvisory;
  removedAt?: number;
}
```

Обратите внимание:

- тут нет `messageCount`
- тут нет `lastActiveAt`
- тут нет `status`, если он message-derived

Если нужен unified UI member status, он должен собираться поверх:

- spawn status
- member activity meta
- active task presence

## 7.3 Что уходит в member activity meta

Туда должны уйти поля, которые меняются от message/inbox/head activity:

```ts
export interface MemberActivityMetaEntry {
  memberName: string;
  /**
   * Последнее сообщение, написанное самим участником.
   * Важно: это не "последнее сообщение, где участник упомянут",
   * а именно authored activity, чтобы сохранить текущую семантику `lastActiveAt`.
   */
  lastAuthoredMessageAt: string | null;
  /** Exact historical count of authored messages for this member. */
  messageCountExact: number;
  /**
   * True, если последнее authored message было terminal signal
   * вроде shutdown approval. Это raw fact, а не итоговый display status.
   */
  latestAuthoredMessageSignalsTermination: boolean;
}

export interface TeamMemberActivityMeta {
  teamName: string;
  computedAt: string;
  members: Record<string, MemberActivityMetaEntry>;
  /**
   * Revision shared normalized message feed, на котором собрана meta.
   * Если revision не менялся, meta можно переиспользовать без пересчёта.
   */
  feedRevision: string;
}
```

### Что важно не тащить в этот контракт

Не надо класть туда:

- full messages
- rendered timeline groups
- React-specific computed state
- tab-specific UI toggles
- ticking pending-reply booleans, зависящие от local clock
- `crossTeamPendingReplies` с TTL-логикой

### Важная смысловая граница

`TeamMemberActivityMeta` хранит только **стабильные message-derived факты**.

Туда не должны попадать:

- локальные optimistic "ждём ответ"
- таймерные TTL-состояния
- всё, что должно тикать раз в секунду от `Date.now()`

## 7.4 Что остаётся у messages

Messages должны жить только здесь:

- `getMessagesPage()`
- renderer message cache
- специализированные consumers: `MessagesPanel`, `MemberMessagesTab`, graph/activity features

Это снимает главный structural problem:

- message changes больше не обязаны пересоздавать весь team detail snapshot

## 8. Предлагаемые контракты

## 8.1 Shared types

Рекомендуемый набор типов:

```ts
export interface TeamViewSnapshot {
  teamName: string;
  config: TeamConfig;
  tasks: TeamTaskWithKanban[];
  members: TeamMemberSnapshot[];
  kanbanState: KanbanState;
  processes: TeamProcess[];
  warnings?: string[];
  isAlive?: boolean;
}

export interface TeamMemberSnapshot {
  name: string;
  currentTaskId: string | null;
  taskCount: number;
  color?: string;
  agentType?: string;
  role?: string;
  workflow?: string;
  providerId?: TeamProviderId;
  model?: string;
  effort?: EffortLevel;
  cwd?: string;
  gitBranch?: string;
  runtimeAdvisory?: MemberRuntimeAdvisory;
  removedAt?: number;
}

export interface MemberActivityMetaEntry {
  memberName: string;
  lastAuthoredMessageAt: string | null;
  messageCountExact: number;
  latestAuthoredMessageSignalsTermination: boolean;
}

export interface TeamMemberActivityMeta {
  teamName: string;
  computedAt: string;
  members: Record<string, MemberActivityMetaEntry>;
  feedRevision: string;
}

export interface MessagesPage {
  messages: InboxMessage[];
  nextCursor: string | null;
  hasMore: boolean;
  /** Revision всего normalized feed, а не только текущего page slice. */
  feedRevision: string;
}
```

## 8.2 API surface

```ts
export interface TeamsAPI {
  getData: (teamName: string) => Promise<TeamViewSnapshot>;
  getMessagesPage: (
    teamName: string,
    options?: { cursor?: string | null; limit?: number }
  ) => Promise<MessagesPage>;
  getMemberActivityMeta: (teamName: string) => Promise<TeamMemberActivityMeta>;
}
```

### Paging contract for `getMessagesPage()`

Здесь нельзя оставлять двоякость между "timestamp paging" и "cursor paging".

Locked choice:

- request принимает `cursor`, а не `beforeTimestamp`
- `cursor === null` или отсутствие cursor означает "дай head page"
- `cursor` - opaque compound token, построенный main-side из boundary message, минимум `timestamp|effectiveMessageId`
- older-page semantics строго **exclusive**: response не должен повторно включать boundary row, из которой был выдан `nextCursor`
- `nextCursor === null` означает, что более старой canonical history больше нет

Следствие:

- renderer/store не реконструируют cursor самостоятельно
- timestamp-only paging в merged target отсутствует
- equality/merge semantics не зависят от неустойчивого порядка сообщений с одинаковым timestamp

### Почему можно оставить имя `getData`

С практической точки зрения это снизит churn:

- старый IPC name можно не переименовывать сразу
- меняется shape, но не transport route

Мой вывод:

- **каноническое понятие** в плане должно называться `TeamViewSnapshot`
- **IPC method name** в этом PR остаётся `getData`

## 8.3 Old to new field mapping

Это важная таблица миграции. По ней проще всего проверять, не оставили ли мы hidden legacy coupling.

| Old place | Old field / responsibility | New owner after split |
| --- | --- | --- |
| `TeamData.messages` | recent message batch | `selectTeamMessages(teamName)` over `canonicalMessages + optimisticMessages` |
| `ResolvedTeamMember.messageCount` | exact historical authored count | `memberActivityMetaByTeam[teamName].members[name].messageCountExact` |
| `ResolvedTeamMember.lastActiveAt` | last authored message timestamp | `memberActivityMetaByTeam[teamName].members[name].lastAuthoredMessageAt` |
| `ResolvedTeamMember.status` | display-ready member status | renderer overlay helper from snapshot + meta + spawn state |
| `MessagesPanel` local fetch state | page loading / cursors / merge | store-owned `teamMessagesByName[teamName]` |
| `MemberMessagesTab` direct IPC fetch | member message loading | store-owned message feed + selector filtering |
| `StatusBlock` snapshot messages prop | cross-team pending TTL derivation | store-backed messages + local timer |

## 8.4 Member type migration strategy

Это место нельзя оставлять неявным, потому что сейчас слишком много renderer кода ожидает `ResolvedTeamMember`.

Правильная миграция такая:

1. IPC transport перестаёт возвращать `ResolvedTeamMember[]`
2. IPC transport начинает возвращать `TeamMemberSnapshot[]`
3. renderer собирает поверх этого `ResolvedTeamMemberView[]`
4. UI-компоненты постепенно переводятся на `ResolvedTeamMemberView`

### Важное правило

`ResolvedTeamMember` больше не должен означать одновременно:

- и IPC transport type
- и renderer display model

Это две разные ответственности.

### Рекомендуемый тип

```ts
interface ResolvedTeamMemberView extends TeamMemberSnapshot {
  status: MemberStatus;
  lastActiveAt: string | null;
  messageCount: number;
  hasPendingReply?: boolean;
}
```

### Locked choice

Для этого PR лучше:

- оставить `ResolvedTeamMemberView` renderer-only type
- не возвращать его из main
- не держать старый `ResolvedTeamMember` как transport alias "для удобства"

## 9. Main-process design

## 9.1 `TeamDataService.getData()` должен стать structural

Сейчас внутри `getTeamData()` messages делают две большие вещи:

- сами попадают в response
- участвуют в `resolveMembers(...)`

Значит надо:

1. перестать возвращать `messages` в snapshot
2. перестать рассчитывать members от full message array

### Новый shape flow

Примерно так:

```ts
const members = this.memberResolver.resolveStructuralMembers(
  config,
  metaMembers,
  inboxNames,
  tasksWithKanban
);

return {
  teamName,
  config,
  tasks: tasksWithKanban,
  members,
  kanbanState,
  processes,
  warnings,
};
```

## 9.2 `TeamMemberResolver` надо разделить

Сейчас `TeamMemberResolver` делает слишком много:

- собирает member roster
- считает task ownership
- выводит status/messageCount/lastActiveAt из full messages

Это надо разрезать.

### Правильнее так

`TeamMemberResolver.resolveStructuralMembers(...)`

Отвечает только за:

- список имён
- merge config/meta/inbox-derived members
- task ownership
- structural member props

`MemberActivityMetaService.getMeta(teamName)`

Отвечает за:

- last authored activity
- exact historical counts
- terminal message facts

Это даст нормальный SRP и снимет скрытую message coupling из snapshot.

## 9.3 Как реализовать `getMemberActivityMeta()` надёжно

Здесь тонкое место не только в meta, а в общем hot path сообщений.

Если после split:

- `getMessagesPage()` сам продолжит на каждый вызов делать raw full rescan + normalize
- и `getMemberActivityMeta()` отдельно тоже будет делать raw full rescan

то мы просто перенесём часть нагрузки из renderer обратно в main.

Поэтому правильный вариант такой:

### Strategy A - shared normalized message feed cache + meta cache by feed revision

Нужны два слоя.

### Layer 1 - `TeamMessageFeedService`

Отвечает за:

- чтение raw sources
- присвоение каждому message row stable effective identity
- dedup `lead_session` / `lead_process`
- enrichment `leadSessionId`
- annotate slash responses
- stable newest-first sort
- shared cache normalized message feed по `teamName`
- вычисление `feedRevision`

Важно:

- этот слой становится единым backend для `getMessagesPage()`
- и единым backend для `getMemberActivityMeta()`
- нельзя оставлять старый inline normalize flow внутри `getMessagesPage()` параллельно с новым сервисом

Примерно такой contract:

```ts
interface TeamNormalizedMessageFeed {
  teamName: string;
  revision: string;
  messages: InboxMessage[];
  newestTimestamp: string | null;
  builtAt: number;
}
```

### `feedRevision` contract

Это один из самых критичных контрактов всего плана.

Правило:

- `feedRevision` - это opaque, но **content-stable** revision full normalized feed
- если normalized feed семантически тот же, `feedRevision` обязан остаться тем же
- если normalized feed реально изменился, `feedRevision` обязан измениться

Что запрещено:

- генерировать `feedRevision` от `builtAt`
- генерировать `feedRevision` от `Date.now()`
- протаскивать наружу raw source fingerprint вида "mtime изменился, значит revision новый", если normalized output по факту не изменился

Разрешённый компромисс:

- internal source fingerprint может быть более консервативным и использоваться только для решения "rebuild or reuse cache"
- но наружу в `MessagesPage.feedRevision` и `TeamMemberActivityMeta.feedRevision` должен попадать именно revision нормализованного feed result, а не internal invalidation token

Иначе:

- `feedChanged` станет почти всегда `true`
- `refreshMemberActivityMeta()` начнёт зря крутиться
- store снова получит churn без реального изменения данных

### Message identity contract

Это место нужно зафиксировать жёстко, иначе pagination и merge легко станут источником скрытых дублей.

Правило:

- `TeamMessageFeedService` должен выдавать feed, где у каждого message row уже есть stable effective identity
- для этого reuse existing main-side identity semantics вроде `getEffectiveInboxMessageId(...)`, а не вводить ещё один независимый renderer fallback algorithm
- cursor `timestamp|messageId` должен строиться по **effective** message id, а не по "сырым optional ids"

Следствие:

- store merge older pages / head refresh / optimistic confirmation работают по одной и той же identity semantics
- read-state keys и message expansion keys не расходятся с transport identity
- исчезает класс багов "дубль после head refresh", когда у одной и той же canonical message в разных местах разные fallback keys

Locked implementation choice:

- целевой merged state этого PR - canonical feed rows всегда приходят с non-empty `messageId`, уже нормализованным main-side effective identity
- renderer helpers вроде `toMessageKey()` после этого должны фактически опираться на `messageId` как на normal path
- fallback key branch остаётся только как defensive guard для старых/optimistic/local edge cases, а не как вторая равноправная identity model

### Cache invalidation strategy for feed service

Первая реализация должна быть **консервативной**, а не "слишком умной".

Разрешённый подход:

- feed service хранит source fingerprint per team
- если fingerprint совпал, возвращаем cached feed
- если fingerprint изменился или есть любая неуверенность, rebuild whole normalized feed

Что может входить в fingerprint:

- inbox source revision / mtime / count
- lead session id / session history related revision
- sent messages store revision

Что не надо делать в первой реализации:

- partial in-place patching normalized feed несколькими независимыми эвристиками
- сложный delta merge между raw sources до появления профилирования

Правило:

- на первом шаге correctness важнее микрооптимизации
- optimisation boundary здесь - reuse cached feed when unchanged, а не умный partial patch when changed
- exposed `feedRevision` после rebuild должен вычисляться по normalized feed result, а не копировать internal fingerprint один в один

### Layer 2 - `MemberActivityMetaService`

Отвечает за:

- построение `TeamMemberActivityMeta` **из normalized feed**
- кэширование результата по `feedRevision`

Примерно такой cache entry:

```ts
interface TeamMemberActivityMetaCacheEntry {
  teamName: string;
  feedRevision: string;
  meta: TeamMemberActivityMeta;
  builtAt: number;
}
```

### Важная деталь про no-op meta churn

Даже если `feedRevision` изменился, это **не всегда** значит, что поменялись member-facing activity facts.

Пример:

- пользователь отправил новое сообщение участнику
- head feed изменился
- exact authored counters самих участников не изменились
- `lastAuthoredMessageAt` участников тоже не изменился

Следствие:

- `MemberActivityMetaService` может вернуть новый wrapper с новым `feedRevision`
- но `members` record внутри должен использовать structural sharing для неизменившихся entry
- UI selectors не должны подписываться на `computedAt` как на render-driving поле

Иначе можно случайно вернуть churn в member list уже после правильного split.

### Как должна выглядеть зависимость

```ts
const feed = await teamMessageFeedService.getFeed(teamName);
const meta = await memberActivityMetaService.getMeta(teamName, feed);
```

### Почему это лучший баланс для этого PR

- дорогой raw normalization живёт в одном месте
- `getMessagesPage()` просто режет page из cached normalized feed
- `getMemberActivityMeta()` не трогает raw storage напрямую
- если revision не изменился, meta возвращается без пересчёта
- O(n) meta rebuild по cached normalized feed при текущих observed объёмах сообщений выглядит безопаснее и проще, чем отдельный delta engine

### Как сохраняем старую authored semantics

Meta строится по authored activity:

- `lastAuthoredMessageAt` считается по сообщениям `from === member.name`
- `messageCountExact` - это exact historical count authored messages
- `latestAuthoredMessageSignalsTermination` смотрит на последнее authored message и повторяет старую termination semantics

То есть member-specific facts не считаются по любому сообщению, где member просто фигурирует в `to`.

## 9.4 Почему не нужен отдельный delta engine в этом PR

Отдельный delta engine можно добавить потом, если появятся реальные цифры, что даже meta rebuild по cached normalized feed стал горячей точкой.

Но в этом PR он не обязателен, потому что:

- shared feed cache уже убирает главную проблему repeated raw rescans
- solution с `feedRevision` проще тестировать
- меньше риск сломать edge cases и дедуп-семантику

## 10. Renderer-side design

## 10.1 Новые store slices

Нужны отдельные state buckets:

```ts
interface TeamMessagesCacheEntry {
  canonicalMessages: InboxMessage[];
  optimisticMessages: InboxMessage[];
  feedRevision: string | null;
  nextCursor: string | null;
  hasMore: boolean;
  lastFetchedAt: number | null;
  loadingHead: boolean;
  loadingOlder: boolean;
  headHydrated: boolean;
}

interface TeamSlice {
  selectedTeamData: TeamViewSnapshot | null;
  teamDataCacheByName: Record<string, TeamViewSnapshot>;

  teamMessagesByName: Record<string, TeamMessagesCacheEntry>;
  memberActivityMetaByTeam: Record<string, TeamMemberActivityMeta>;

  refreshTeamData: (teamName: string, opts?: RefreshTeamDataOptions) => Promise<void>;
  refreshTeamMessagesHead: (teamName: string) => Promise<RefreshTeamMessagesHeadResult>;
  loadOlderTeamMessages: (teamName: string) => Promise<void>;
  refreshMemberActivityMeta: (teamName: string) => Promise<void>;
  applyOptimisticTeamMessage: (teamName: string, message: InboxMessage) => void;
}
```

### Snapshot/meta bootstrap semantics

До первой successful hydration отсутствие cache entry - это нормальное состояние.

Правила:

- отсутствие `teamDataCacheByName[teamName]` означает "structural snapshot ещё не загружен", а не ошибку
- отсутствие `memberActivityMetaByTeam[teamName]` означает "activity meta ещё не загружена или ещё ни разу успешно не доезжала"
- store не должен создавать фиктивные placeholder-объекты только ради того, чтобы избежать `null` / `undefined`
- UI selectors и view-model layer должны уметь работать с отсутствием этих записей через стабильные fallback selectors, а не через ad-hoc object fabrication в компонентах

Причина:

- placeholder wrappers легко создают лишние ref changes и запутывают разницу между "нет данных пока" и "есть пустые данные"
- canonical source of truth должен оставаться простым: entry либо реально есть, либо его ещё нет

### Non-reactive orchestration internals

Не весь orchestration state должен жить в observable store.

Допустимо и желательно держать вне reactive state:

- in-flight promise maps per team/action
- dirty flags / follow-up flags
- explicit visibility registry
- internal cooldown / debounce bookkeeping

Нельзя без необходимости тащить эти вещи в публичный reactive store shape, если UI не должен на них рендериться.

Причина:

- иначе сам orchestration layer начинает становиться источником re-render churn
- reactive store должен хранить в первую очередь данные и только те control flags, которые реально нужны UI

### `TeamMessagesCacheEntry` field semantics

Чтобы не было двух трактовок, значения полей должны пониматься так:

- `canonicalMessages` - весь **уже загруженный** canonical message window для команды, newest-first, включая head page и все успешно догруженные older pages
- `optimisticMessages` - только локальные ещё не подтверждённые rows
- `feedRevision` - revision full normalized feed, на котором построен текущий canonical head state
- `nextCursor` - cursor для **следующей** older page после самого старого canonical message, уже находящегося в `canonicalMessages`
- `hasMore` - есть ли ещё canonical history старше текущего `nextCursor`; до первой successful head hydration это bootstrap flag и не интерпретируется как terminal exhaustion
- `lastFetchedAt` - timestamp последнего **успешного** canonical message fetch/merge для этой команды; до первого success равен `null` и не обновляется на failed attempt
- `loadingHead` - в полёте primary head refresh для canonical window
- `loadingOlder` - в полёте older-page extension текущего canonical window
- `headHydrated` - был ли хотя бы один успешный canonical head fetch

Следствие:

- head refresh обновляет canonical head portion, но не "забывает" уже загруженные older pages
- older-page loading расширяет `canonicalMessages` вниз по истории, а не создаёт отдельный side bucket

### Bootstrap empty entry

До первой successful head hydration canonical message entry должен иметь предсказуемый bootstrap state:

```ts
{
  canonicalMessages: [],
  optimisticMessages: [],
  feedRevision: null,
  nextCursor: null,
  hasMore: false,
  lastFetchedAt: null,
  loadingHead: false,
  loadingOlder: false,
  headHydrated: false,
}
```

Важно:

- bootstrap `hasMore: false` до first hydration не означает, что history exhausted
- terminal meaning у `hasMore === false` и `nextCursor === null` появляется только после `headHydrated === true`

### Successful empty head hydration

У команды может быть корректный successful head refresh и при этом ноль canonical messages.

В таком случае canonical state должен стать таким:

```ts
{
  canonicalMessages: [],
  optimisticMessages: /* whatever local optimistic rows currently exist */,
  feedRevision: "<non-null revision>",
  nextCursor: null,
  hasMore: false,
  lastFetchedAt: <success timestamp>,
  loadingHead: false,
  loadingOlder: false,
  headHydrated: true,
}
```

Важно:

- empty successful feed **не** оставляет `headHydrated === false`
- empty successful feed **не** оставляет `feedRevision === null`
- иначе команда без history будет вечно выглядеть как "ещё не гидратирована"

### Pre-hydration optimistic entry

Если пользователь отправил optimistic message до первого successful head hydration, это допустимое состояние.

В таком случае:

- `canonicalMessages` остаётся пустым
- `optimisticMessages` может быть non-empty
- `headHydrated` остаётся `false` до первого successful canonical head fetch
- `feedRevision`, `nextCursor`, `lastFetchedAt` остаются bootstrap/null до первого success

То есть optimistic rows могут существовать поверх bootstrap entry, не превращая его в hydrated canonical state.

### `TeamMessagesCacheEntry` state invariants

Чтобы store не собрал внутренне противоречивое состояние, ниже зафиксированы инварианты:

- `headHydrated === false` => `canonicalMessages.length === 0`
- `headHydrated === false` => `loadingOlder === false`
- `headHydrated === false` => `feedRevision === null`
- `headHydrated === false` => `nextCursor === null`
- `headHydrated === false` => `lastFetchedAt === null`
- `loadingHead === true && loadingOlder === true` для одной команды в корректной реализации не допускается
- `hasMore === false` => `nextCursor === null`
- `canonicalMessages.length === 0` не означает ошибку само по себе, если `headHydrated === false`
- failed request не имеет права менять `lastFetchedAt`
- любой settled request обязан снять соответствующий loading flag, даже если response был stale-ignored

Если implementation хочет хранить дополнительный error/debug state, он хранится отдельно от этого entry.

### Operational definitions

Чтобы разные исполнители не вкладывали разный смысл в одни и те же слова, ниже фиксированные определения.

`visible active team`

- команда, для которой прямо сейчас существует видимый team-detail или graph consumer в UI
- hidden mounted tabs через `display: none` сюда **не** входят только потому, что компонент всё ещё смонтирован
- store должен опираться на явный visibility signal, а не на факт mount'а subtree
- одного факта `selectedTeamName === teamName` недостаточно, чтобы считать команду `visible active team`

`visibility signal`

- renderer держит явный per-team visibility registration, а не выводит visibility косвенно из mount state
- минимум `TeamDetailView` container и graph container обязаны регистрировать и снимать этот сигнал при реальном показе/скрытии
- CSS-hidden subtree не считается visible consumer
- fallback polling и event routing consult именно этот explicit signal
- допустим ref-count или set of visible consumers per team, но merged code не должен зависеть от "компонент всё ещё смонтирован, значит команда активна"

`active local pending-reply wait state`

- у команды есть хотя бы один unresolved `pendingRepliesByMember` entry, который ещё находится в локальном waiting window
- это именно renderer-local UX reason держать лёгкий message polling
- это не означает, что команда становится structural-refresh priority

`headHydrated`

- хотя бы один successful head fetch уже положил canonical head page в store entry
- `headHydrated === false` означает "canonical message source для этой команды ещё не инициализирован"
- optimistic rows могут существовать и до `headHydrated === true`, но не заменяют canonical hydration

`compatibility adapter`

- временный branch-local helper, который помогает перевести consumer на новый shape без изменения transport contract обратно
- допустим только в renderer migration path
- не допускается как новый shared type alias, новый IPC compatibility contract или новый main-side legacy field

### Contract for `refreshTeamMessagesHead()`

Обычный `Promise<boolean>` здесь слишком двусмысленный.

Надёжнее сразу зафиксировать semantic result:

```ts
interface RefreshTeamMessagesHeadResult {
  feedChanged: boolean;
  headChanged: boolean;
  feedRevision: string | null;
}
```

Где:

- `feedChanged` - изменился revision всего normalized feed относительно store cache
- `headChanged` - изменился реально canonical head slice, который подписан в UI
- `feedRevision` - revision после refresh

Инварианты:

- `headChanged === true` подразумевает `feedChanged === true`
- состояние `feedChanged === false && headChanged === true` в корректной реализации невозможно
- состояние `feedChanged === false && headChanged === false` означает, что canonical message inputs для UI не изменились
- состояние `feedChanged === true && headChanged === false` допустимо и означает historical-only/full-feed change без изменения текущего head slice

Почему это важно:

- старые сообщения могут доехать в feed без изменения top page
- `memberActivityMeta` зависит от full feed semantics, а не только от head page
- `MessagesPanel` может не перерисоваться, но member activity overlay всё равно должен знать, что full feed поменялся

### Single-flight request discipline

Даже правильный data split можно испортить, если store начнёт одновременно запускать 5 одинаковых refresh-запросов на burst events.

Правило:

- для каждого `teamName` store держит single-flight orchestration отдельно для:
  - `refreshTeamData()`
  - `refreshTeamMessagesHead()`
  - `loadOlderTeamMessages()`
  - `refreshMemberActivityMeta()`
- если такой же запрос уже в полёте, новые триггеры reuse existing promise или ставят один follow-up dirty flag
- store не запускает unbounded parallel head refreshes на каждое событие watcher burst

Дополнительно:

- responses применяются только через team-scoped request guard
- stale response после team switch / newer refresh не должен откатывать store назад

### Canonical message mutation serialization

Это отдельное правило поверх single-flight:

- для одного `teamName` canonical message window не должен одновременно мутироваться из `refreshTeamMessagesHead()` и `loadOlderTeamMessages()`
- head refresh и older-page load для одной команды сериализуются через общий canonical-message mutation lane
- если во время `loadingOlder === true` приходит новый head trigger, store помечает team как dirty и выполняет head refresh сразу после завершения текущего canonical mutation
- если во время `loadingHead === true` приходит `loadOlderTeamMessages()`, older load либо reuse'ит уже идущую hydration sequence, либо ждёт её завершения

Причина:

- это сильно упрощает merge correctness
- это убирает лишний класс reorder bugs между head refresh и older-page append
- stale-response guards должны остаться как защита, но не быть основной стратегией нормального control flow

### Что значит `meta stale`

Чтобы здесь не было произвольных трактовок, `isMemberActivityMetaStale(teamName)` должен означать одно из:

- meta entry для команды отсутствует
- `memberActivityMeta.feedRevision !== teamMessagesByName[teamName].feedRevision`
- safety TTL для visible active team истёк после длительного watcher silence

И не должен означать:

- "прошло немного времени, давайте на всякий случай ещё раз всё пересчитаем"
- "head refresh выполнился, значит meta точно stale"

### UI selector discipline for activity meta

Это место надо зафиксировать жёстко, иначе churn легко вернётся через selector layer.

Правило:

- UI consumers, которым нужны member facts, не подписываются на whole `TeamMemberActivityMeta`
- UI readers используют selector уровня facts, например `selectMemberActivityFacts(teamName)`
- routing / stale detection logic может отдельно читать `selectMemberActivityFeedRevision(teamName)` и `computedAt`, если это реально нужно

Причина:

- `feedRevision` может измениться без изменения member-facing facts
- `computedAt` почти никогда не должен быть render-driving полем
- подписка на весь wrapper снова создаст лишние re-renders в member list / hover / badges

### Почему это важнее, чем просто больше `useMemo`

Потому что store boundary определяет, что вообще считается "данные изменились".  
Если boundary широкая, никакой `useMemo` потом уже красиво не спасёт.

### Дополнительное правило

Store после миграции становится единственной точкой orchestration для:

- head refresh
- older-page loading
- optimistic message merge
- activity meta refresh
- fallback polling

Компоненты после миграции только:

- подписываются на store
- вызывают store actions
- не знают про IPC детали

### Selector stability rule for merged messages

Это критично. Иначе можно формально вынести messages из snapshot, но всё равно продолжить churn через новые массивы.

Правило:

- `selectTeamMessages(teamName)` обязан возвращать **stable array ref**, если `canonicalMessages` и `optimisticMessages` ref'ы не изменились
- `selectMemberMessages(teamName, memberName)` обязан строиться как memoized derived selector per pair, а не как новый `.filter(...)` на каждый store read
- `mergeTeamMessages()` не должен вызываться "в лоб" внутри обычного selector body без memoization

Разрешённые варианты:

- memoized selector factory per `teamName`
- precomputed merged view inside store entry с корректным structural sharing

Недопустимый вариант:

- каждый store read создаёт новый merged messages array даже при отсутствии изменений входов

Иначе `MessagesPanel`, `ActivityTimeline`, graph и member tabs снова начнут получать churn уже после правильного split.

### Optimistic storage rule

Чтобы не терять optimistic rows во время canonical refresh, store не должен хранить один "голый" `messages[]`.

Правильнее:

- `canonicalMessages` - то, что пришло из main feed
- `optimisticMessages` - локальные optimistic rows, которые ещё не подтверждены canonical feed
- selector `selectTeamMessages(teamName)` возвращает уже merged view

Это снимает типовую race-проблему:

- user отправил сообщение
- optimistic row показался
- canonical head page ещё не успела включить это сообщение
- новый head refresh не должен "откатить" optimistic row

### Cursor and page merge semantics

Эта часть должна быть описана явно, иначе `loadOlderTeamMessages()` почти гарантированно получит race bugs.

Правила:

- `loadOlderTeamMessages()` не должен пытаться грузить older history, пока `headHydrated === false`
- если older load запрошен до first head hydration, store сначала делает `refreshTeamMessagesHead()` и только потом решает, есть ли что догружать
- cursor остаётся compound-format `timestamp|effectiveMessageId`
- older-page request должен помнить `baseFeedRevision`, на котором был выдан его `nextCursor`
- `loadOlderTeamMessages()` всегда использует `nextCursor` из текущего canonical store entry, а не локальное component state
- если `hasMore === false` или `nextCursor === null`, `loadOlderTeamMessages()` делает cheap no-op
- head refresh **не** заменяет весь canonical list целиком, если уже были подгружены older pages
- head refresh обновляет верхнюю часть feed и потом merge'ится с уже загруженной historical частью через единый merge helper
- older-page response тоже merge'ится, а не "append blindly"
- dedup и stable ordering должны reuse existing semantics вроде `mergeTeamMessages()` / shared message key contract
- canonical merge path не должен изобретать второй merge algorithm рядом с existing `mergeTeamMessages()` semantics без отдельной причины и отдельного тестового покрытия

Особый case:

- если older-page response приходит уже после нового head refresh или после другого older-page request
- store должен применить результат только если request guard ещё актуален
- иначе response silently ignored, без отката `nextCursor` и без reorder churn

### Safety fallback for history rewrite / irreconcilable merge

Нельзя молча предполагать, что история всегда append-only.

В первой реализации должен быть безопасный fallback:

- если после `feedRevision` change merge не может надёжно склеить fresh head и уже загруженную older history
- store обязан сбросить только historical tail и оставить свежий canonical head page как новый baseline
- при этом optimistic rows сохраняются отдельно и не теряются

Триггеры для такого fallback:

- нарушился stable newest-first ordering invariant после merge
- seam между fresh head и retained history не удаётся дедупнуть по effective identity без противоречий
- boundary anchor вокруг `nextCursor` стал недостоверным после newer revision
- response относится к старому `baseFeedRevision`, а в store уже живёт более новый head baseline

Что важно:

- лучше временно потерять локально подгруженный older tail, чем показать смешанное неконсистентное history state
- такой reset допустим только для canonical older window, но не для optimistic messages и не для structural snapshot

### `selectedTeamData` / cache consistency rule

Если в store временно живут и `teamDataCacheByName`, и `selectedTeamData`, правило должно быть жёстким:

- сначала обновляется canonical cache entry per team
- потом `selectedTeamData` просто получает тот же ref, если `selectedTeamName === teamName`
- нельзя отдельно пересобирать `selectedTeamData` "для удобства UI"
- при смене `selectedTeamName` поле `selectedTeamData`, если оно ещё существует, synchronously repoint'ится на `teamDataCacheByName[selectedTeamName] ?? null`
- `selectedTeamData` не имеет права продолжать указывать на snapshot предыдущей команды после того, как `selectedTeamName` уже сменился

Иначе:

- no-op suppression может сработать для cache, но не сработать для current selection
- `TeamDetailView` продолжит видеть churn, хотя формально cache уже исправлен

### Team switch response rule

При switch `A -> B` store обязан вести себя так:

- late async response для `A` может обновить только cache entry команды `A`
- late async response для `A` не имеет права переустановить `selectedTeamData`, если `selectedTeamName !== A`
- hydration/open-flow для `B` идёт по обычным правилам `visible active team`
- если cache для `B` уже существует, UI может сразу reuse'ить этот snapshot ref; если cache для `B` ещё нет, допускается `selectedTeamData === null` до первого успешного snapshot refresh

Цель:

- не показывать stale snapshot команды `A` под выбранной командой `B`
- не ломать per-team cache reuse ради selected-team convenience field

### Fallback polling policy

Polling остаётся как safety net, но только в store и только по строгим правилам:

- включается для visible active team
- включается для team с active local pending-reply wait state
- не крутится для hidden inactive teams
- не переписывает structural snapshot
- делает только message-head refresh и при необходимости meta refresh

### Initial visible-team hydration sequence

Это должно быть описано отдельно, чтобы open-flow не собирался по-разному в разных местах.

Когда команда становится `visible active team`, store обязан обеспечить такой порядок:

1. `refreshTeamData(teamName)` для structural snapshot
2. `refreshTeamMessagesHead(teamName)` для canonical head hydration
3. `refreshMemberActivityMeta(teamName)` только после первого head result, если meta отсутствует или stale
4. `fetchMemberSpawnStatuses(teamName)` как независимый overlay refresh

Допустимо:

- запускать шаги 1 и 2 параллельно
- reuse shared single-flight/feed-cache между шагами 2 и 3

Недопустимо:

- строить open-flow так, что `MemberDetailDialog`, `ActivityTimeline` или `StatusBlock` начинают сами триггерить свою собственную первичную hydration logic
- считать команду "полностью гидратированной" только потому, что приехал structural snapshot без message head

### Hidden-team cache retention rule

Когда команда перестаёт быть `visible active team`:

- store прекращает background refresh/polling для этой команды, если нет `active local pending-reply wait state`
- уже гидратированные snapshot/message/meta caches **не** очищаются только из-за hide transition
- hide transition сам по себе не должен сбрасывать `headHydrated`, `canonicalMessages`, `memberActivityMetaByTeam[teamName]` или `teamDataCacheByName[teamName]`

В этом PR не вводится отдельная eviction policy.

Причина:

- eager clear-on-hide легко превращает reopen в повторный burst hydration path
- cache retention и background refresh ownership - это разные вещи, их нельзя смешивать

### Reopen rule after hide

Если команда была скрыта, а потом снова стала `visible active team`:

- store reuse'ит уже имеющиеся snapshot/message/meta caches как baseline
- open-flow может поверх этого сделать refresh по обычным visible-team правилам
- reopen не должен вести себя как forced cold-start только из-за предыдущего hide transition

### Failure semantics for store actions

Это тоже должно быть однозначно:

- `refreshTeamData()` failure не очищает предыдущий structural snapshot
- `refreshTeamMessagesHead()` failure не очищает `canonicalMessages`, `nextCursor`, `feedRevision`
- `loadOlderTeamMessages()` failure не откатывает уже загруженную history window
- `refreshMemberActivityMeta()` failure не очищает предыдущий meta facts record
- любой из этих failures обязан снять соответствующий loading flag

Если нужен user-visible signal:

- он должен жить отдельным ephemeral error state / logger path
- но не через destructive reset уже загруженных данных

## 10.2 `refreshTeamData()` после split

После split `refreshTeamData()` должен заниматься только:

- structural snapshot
- task change invalidation
- structural sharing
- no-op suppression

Он **не** должен:

- догружать messages
- дёргать member activity computations
- быть universal answer на любой `lead-message`

## 10.3 Новый routing событий

Правильнее распределить так:

### `lead-message`

Должен триггерить:

- `refreshTeamMessagesHead(teamName)`
- `refreshMemberActivityMeta(teamName)` только если `feedChanged === true` или meta stale

Но не full `refreshTeamData()` по умолчанию.

И только если team реально нужна сейчас:

- видима хотя бы в одном pane
- или у неё есть active local pending-reply wait state

### `inbox`

Тоже:

- `refreshTeamMessagesHead(teamName)`
- `refreshMemberActivityMeta(teamName)` только если `feedChanged === true` или meta stale

С тем же visibility правилом:

- visible team
- или active local pending-reply wait state

### `task`

Должен триггерить:

- `refreshTeamData(teamName)`

### `config`

Должен триггерить:

- `refreshTeamData(teamName)`

Этого достаточно, потому что:

- roster и `currentTaskId` живут в structural snapshot
- `memberActivityMeta` после split зависит от message feed, а не от config

### `process`

Должен триггерить:

- `refreshTeamData(teamName)`

### `member-spawn`

Как и сейчас:

- `fetchMemberSpawnStatuses(teamName)`

Но без косвенного втягивания full team detail refresh, если это не требуется.

### Fallback polling

Отдельно от event routing store держит лёгкий fallback poll:

- только для visible active team
- или для team с active local pending-reply wait state
- интервал остаётся coarse, а не tight
- poll вызывает только `refreshTeamMessagesHead()`
- `refreshMemberActivityMeta()` вызывается только вслед за `feedChanged === true` или stale-meta condition

Это нужно на случай:

- пропущенных file/runtime events
- длинных сессий с нестабильным watcher delivery

## 10.4 Пример роутинга

```ts
if (event.type === 'lead-message' || event.type === 'inbox') {
  const { feedChanged } = await refreshTeamMessagesHead(event.teamName);
  if (feedChanged || isMemberActivityMetaStale(event.teamName)) {
    scheduleMemberActivityMetaRefresh(event.teamName);
  }
  return;
}

if (event.type === 'task' || event.type === 'config' || event.type === 'process') {
  scheduleTeamSnapshotRefresh(event.teamName);
}
```

Это самое большое поведенческое исправление для renderer load pattern.

### Event matrix without ambiguity

| Event | Always do | Conditionally do | Must not do by default |
| --- | --- | --- | --- |
| `lead-message` | `refreshTeamMessagesHead()` | `refreshMemberActivityMeta()` when `feedChanged` or meta stale | `refreshTeamData()` |
| `inbox` | `refreshTeamMessagesHead()` | `refreshMemberActivityMeta()` when `feedChanged` or meta stale | `refreshTeamData()` |
| `task` | `refreshTeamData()` | nothing else unless separate UI needs it | blind message refresh |
| `config` | `refreshTeamData()` | nothing else unless separate UI needs it | blind message refresh |
| `process` | `refreshTeamData()` | nothing else unless separate UI needs it | blind message refresh |
| `member-spawn` | `fetchMemberSpawnStatuses()` | presentation overlay recompute in renderer | implicit full snapshot refresh |

## 10.5 `TeamDetailView` должен перестать читать всё из одного blob

Сейчас view примерно концептуально живёт так:

- `data = selectedTeamData`
- `messages = data.messages`
- `members = data.members`

После split правильнее:

```ts
const snapshot = useStore(selectTeamSnapshot(teamName));
const messages = useStore(selectTeamMessages(teamName));
const memberActivityFacts = useStore(selectMemberActivityFacts(teamName));
const memberSpawnStatuses = useStore(selectMemberSpawnStatuses(teamName));
```

А дальше уже в selector / adapter layer собирается view model:

```ts
const membersWithActivity = useMemo(
  () => mergeMembersWithActivity(snapshot.members, memberActivityFacts, memberSpawnStatuses),
  [snapshot.members, memberActivityFacts, memberSpawnStatuses]
);
```

Это делает invalidation адресным:

- messages change не обязаны ломать tasks/processes/member roster UI
- member meta change не обязана пересоздавать task board

### Как именно должен собираться member status

После split итоговый `member.status` больше не приходит готовым из main snapshot.

Правильная схема:

- meta даёт raw activity facts
- snapshot даёт `currentTaskId`
- spawn layer даёт runtime/provisioning signals
- renderer helper собирает итоговый display status для UI

Это важный момент, потому что иначе легко снова смешать transport facts и UI semantics.

## 10.6 `MessagesPanel` должен работать только от message store

Сейчас он смешивает:

- prop seed messages
- fetched page messages

После split:

- `MessagesPanel` получает `selectTeamMessages(teamName)`
- optimistic send updates идут прямо в message store
- начальная head hydration делается через store action, а не через prop fallback
- `loadOlderMessages` идёт через store action, а не через прямой IPC call из компонента

### Это особенно важно

Пока у `MessagesPanel` есть `prop messages`, snapshot продолжает быть скрытым transport'ом для messages.

Это надо убрать полностью.

### И ещё одно важное правило

`MessagesPanel` не должен стать вторым orchestration layer.

То есть внутри него не должно остаться:

- отдельного `fetchIdRef`
- собственного polling lifecycle
- второй логики merge/dedup поверх store ownership

## 10.7 `ActivityTimeline`

Это тоже message-heavy consumer, и его нельзя оставлять "подразумеваемым".

После split:

- `ActivityTimeline` читает store-backed messages selector или отдельный timeline view-model selector, а не `selectedTeamData.messages`
- timeline grouping/filtering не живёт от старого snapshot prop
- компонент не содержит собственного fetch/polling/orchestration path
- hidden mounted tab не должен получать лишний churn только потому, что timeline подписан слишком широко

Если для timeline нужен специальный derived selector, это нормально.  
Ненормально - снова фильтровать whole snapshot message blob прямо в render path.

## 10.8 `MemberDetailDialog` / `MemberMessagesTab` / `MemberHoverCard`

Сейчас dialog получает `messages` из `TeamDetailView`.

После split:

- dialog не должен принимать full team messages prop
- `MemberMessagesTab` должен брать member-relevant data из message store через team-scoped selector
- activity count в header должен приходить из `memberActivityMeta`, а не через `buildInlineActivityEntries(messages.filter(...))` на каждый reopen
- `MemberMessagesTab` не должен сам дёргать `api.teams.getMessagesPage(...)`
- `MemberHoverCard` должен читать `memberActivityFacts` или готовый view-model selector, а не whole snapshot wrapper и не whole meta wrapper

### Пример

```ts
const memberMeta = memberActivityFacts[member.name];
const memberActivityCount = memberMeta?.messageCountExact ?? 0;
```

Если нужен более богатый recent activity counter, это отдельное future extension, не часть этого PR.

## 10.9 Agent Graph

Это один из самых опасных edge points.

Сейчас graph adapter сидит на `TeamData.messages`.

Если просто выкинуть `messages` из `TeamData`, graph сломается.

### Правильный путь

Graph должен перейти на тот же store-backed source, что и MessagesPanel.

Locked choice:

- store subscription живёт в graph hook / container layer
- pure adapter принимает уже готовые данные `(snapshot, messages, memberActivityFacts, teamName)`
- fetching и polling не уезжают внутрь graph adapter

Примерно так:

```ts
const snapshot = useStore(selectTeamSnapshot(teamName));
const messages = useStore(selectTeamMessages(teamName));
const memberActivityFacts = useStore(selectMemberActivityFacts(teamName));
const graphData = useMemo(
  () => TeamGraphAdapter.adapt(snapshot, messages, memberActivityFacts, teamName),
  [snapshot, messages, memberActivityFacts, teamName]
);
```

### Почему это важно

Если graph останется на legacy `TeamData.messages`, вы получите:

- двойную модель
- race conditions
- скрытую потребность сохранять legacy field дольше, чем нужно

## 11. Structural sharing and no-op suppression

Это надо делать даже после split.

## 11.1 Зачем

Потому что даже structural snapshot без messages всё равно может пересоздаваться:

- новые массивы задач
- новый `config` object
- новый `processes` array
- новые `members` array/object refs при одинаковом содержимом

Если этого не подавить, вы получите меньшую, но всё ещё реальную churn-проблему.

## 11.2 Принцип

Нужно не просто "compare then skip".  
Нужно **reuse old references for equal subtrees**.

То есть не так:

```ts
if (deepEqual(prev, next)) return prev;
return next;
```

А так:

```ts
function structurallyShareTeamSnapshot(
  prev: TeamViewSnapshot | null | undefined,
  next: TeamViewSnapshot
): TeamViewSnapshot {
  if (!prev) return next;

  const sharedConfig = areConfigsEqual(prev.config, next.config) ? prev.config : next.config;
  const sharedTasks = reuseArrayIfEqual(prev.tasks, next.tasks, areTasksSemanticallyEqual);
  const sharedMembers = reuseArrayIfEqual(prev.members, next.members, areMembersSemanticallyEqual);
  const sharedProcesses = reuseArrayIfEqual(
    prev.processes,
    next.processes,
    areProcessesSemanticallyEqual
  );
  const sharedWarnings = reuseOptionalArrayIfEqual(
    prev.warnings,
    next.warnings,
    (left, right) => left === right
  );

  if (
    sharedConfig === prev.config &&
    sharedTasks === prev.tasks &&
    sharedMembers === prev.members &&
    sharedProcesses === prev.processes &&
    prev.isAlive === next.isAlive &&
    sharedWarnings === prev.warnings
  ) {
    return prev;
  }

  return {
    ...next,
    config: sharedConfig,
    tasks: sharedTasks,
    members: sharedMembers,
    processes: sharedProcesses,
    warnings: sharedWarnings,
  };
}
```

Примечание:

- `warnings` тоже надо пускать через optional-array sharing, а не через голый ref compare
- иначе no-op suppression останется частичной и будет зря пересоздавать snapshot wrapper

## 11.3 Где надо быть особенно осторожным

С semantic equality нельзя бездумно игнорировать поля.

Надо разделять:

- поля, меняющие видимый UI
- поля, не меняющие видимый UI

Пример:

- `updatedAt` у meta - часто можно игнорировать
- `lastHeartbeatAt` - можно игнорировать для member spawn badge equality, если UI его не показывает
- `task.reviewState` игнорировать уже нельзя

Нужны **целенаправленные semantic comparators**, а не generic deep-equal.

## 12. Optimistic updates

Это отдельный опасный блок.

Сейчас `sendTeamMessage()` оптимистично пушит message в `selectedTeamData.messages`.

После split надо перенести optimistic update в message store.

### Правильнее так

```ts
sendTeamMessage: async (teamName, request) => {
  const optimistic = buildOptimisticMessage(request, result.messageId);
  get().applyOptimisticTeamMessage(teamName, optimistic);
  await get().refreshTeamMessagesHead(teamName);
}
```

### Почему здесь не нужен `refreshMemberActivityMeta()`

Для обычного user -> member send это лишняя работа, потому что:

- `messageCountExact` считает authored messages самого member
- `lastAuthoredMessageAt` тоже меняется только когда пишет сам member
- pending-reply UX уже покрывается local `pendingRepliesByMember`

Значит после user send надо:

- добавить optimistic message в store
- обновить local pending-reply state
- дождаться canonical head refresh

Но не пересчитывать activity meta сразу же.

### Send failure rollback semantics

Если `sendTeamMessage()` завершается ошибкой до canonical confirmation:

- соответствующая optimistic row удаляется из `optimisticMessages`
- local pending-reply state, поставленный этим send attempt, откатывается
- canonicalMessages не трогаются
- `refreshMemberActivityMeta()` по этому failure не запускается

Если продукт позже захочет отдельный failed-message UX со статусом retry, это уже отдельное расширение.
В текущем плане failed optimistic send не должен навсегда оставлять висящую pseudo-message row в merged feed.

### Почему нельзя оставить старую логику

Потому что она снова начнёт:

- мутировать snapshot semantics через messages
- держать legacy coupling

### Отдельно про pending replies

Local `pendingRepliesByMember` остаётся в renderer:

- на send отмечаем `sentAtMs`
- на incoming member reply чистим локальное состояние
- delayed waiting refresh в `TeamDetailView` после split должен вызывать `refreshTeamMessagesHead(teamName)`, а не full `refreshTeamData(teamName)`

### Merge semantics for optimistic rows

Когда canonical feed в итоге содержит сообщение с тем же `messageId`, store должен:

- убрать соответствующую optimistic row
- оставить canonical row
- не дублировать обе версии в merged selector

## 13. Что делать с `messageCount`

Это один из самых важных product semantics вопросов.

Сейчас `ResolvedTeamMember.messageCount` - это exact count по full history.

В этом плане решение уже принято:

- `messageCount` в v1 split-реализации остаётся **exact historical count**
- значение приходит из `TeamMemberActivityMeta`
- значение не вычисляется в renderer по head page

Причина:

- это сохраняет текущую семантику UI и тестов
- это убирает скрытое product-изменение из и так большого performance PR
- это совместимо с shared normalized feed cache + meta-by-revision cache

Если позже product решит, что exact count не нужен, это отдельный follow-up с отдельным обсуждением UX semantics, но не часть текущего плана.

## 14. Edge cases и подводные камни

## 14.1 Hidden tabs still mounted

Пока `PaneContent` сохраняет tabs mounted, любое широкое store invalidation продолжает работать против вас.

Следствие:

- даже после split полезно сделать selectors максимально узкими
- не тянуть `messages` в скрытые team tabs, если они не нужны

## 14.2 Team switch race

Если пользователь быстро переключает команды:

- `refreshTeamMessagesHead(alpha)` может завершиться после перехода на `beta`
- нельзя обновлять `selectedTeamData`-подобный selected-only state без teamName validation

Нужны team-scoped caches и id guards, как уже сделано в ряде мест.

И это же правило относится к:

- older-page responses
- meta refresh responses
- delayed pending-reply refresh timers

## 14.3 Member removed / renamed

Если member удалён:

- structural snapshot убирает его из active списка
- `memberActivityMeta` может ещё содержать старую запись

Правильнее:

- не терять meta сразу, если нужен historical dialog
- но UI current member list должен фильтровать по structural roster

## 14.4 Pending replies semantics

Сейчас pending replies partly derived from messages.

После split нельзя потерять:

- pending reply badges by member
- pending cross-team replies

Здесь важно не перепутать две разные сущности.

### Member pending replies

Это остаётся renderer-local state:

- источник истины - `pendingRepliesByMember`
- состояние ставится optimistically на send
- очищается, когда message feed показывает фактический reply от участника

Это **не** надо класть в `TeamMemberActivityMeta`.

### Cross-team pending replies

Это остаётся renderer-derived состоянием:

- источник истины - normalized message cache
- TTL считается локально от `Date.now()`
- `StatusBlock` может продолжать держать свой 1-second timer, но читать он должен уже из store-backed messages, а не из snapshot prop

Это тоже **не** надо класть в `TeamMemberActivityMeta`.

### Что тогда делает `TeamMemberActivityMeta`

Только стабильные message-derived факты:

- `lastAuthoredMessageAt`
- `messageCountExact`
- `latestAuthoredMessageSignalsTermination`

## 14.5 New message before head hydration finishes

Возможна ситуация:

- открыли team
- `refreshTeamMessagesHead()` ещё в полёте
- пользователь отправил optimistic message
- потом приехала server head page

Нужно merge по `messageId`, не замену массива вслепую.

## 14.6 Message edits / dedup / source merging

У вас уже есть логика dedup lead_session vs lead_process.

Она должна остаться **единственным source of truth** на main side.

Renderer не должен заново изобретать dedup semantics.

## 14.7 `lastHeartbeatAt` и spawn statuses

Это нельзя снова смешивать с message activity meta.

Нужно разделять:

- spawn liveness
- member conversational activity

Их потом можно поверх объединить в `displayStatus`, но хранить в одном transport не надо.

## 14.8 Team provisioning / TEAM_DRAFT / transient errors

`refreshTeamData()` уже аккуратно обрабатывает provisioning-safe сценарии.

После split надо сохранить тот же принцип для:

- `refreshTeamMessagesHead()`
- `refreshMemberActivityMeta()`

То есть:

- transient failures не должны очищать structural snapshot
- отсутствие message meta не должно рушить весь screen

## 14.9 Graph and TeamDetail open одновременно

Если team tab и graph tab открыты одновременно для одной команды:

- нельзя делать два разных polling loops, читающих одну и ту же head page

Нужно shared store action / shared cache entry per team.

## 14.10 Tests that currently assert `data.messages`

Blast radius тестов реальный:

- main service tests
- IPC tests
- renderer store tests
- graph adapter tests

Надо сразу закладывать migration plan:

- заменить ожидания на snapshot + messages/meta assertions
- не держать временный legacy field дольше, чем нужно

## 14.11 Team list fan-out risk

Это место легко пропустить, а потом получить новый performance regression уже не в detail view, а в overview.

Если `TeamListView` или похожий multi-team экран:

- делает `getData()` для многих команд
- и после split начнёт "для полноты" ещё дёргать `getMessagesPage()` / `getMemberActivityMeta()` по каждой строке

то это создаст новый fan-out hot path.

Правило:

- message feed и member activity meta гидратятся только для selected / visible team detail contexts
- list/grid overview остаётся на structural snapshot
- если overview позже понадобится activity badge, для него нужен отдельный lightweight aggregate contract, а не скрытый fan-out тяжёлых вызовов

## 15. Как именно я бы это реализовывал

## 15.1 Принцип

Не "фаза 1 как костыль, потом перепишем".

А один coherent branch/PR, внутри которого есть правильный порядок сборки:

1. новые типы и IPC surfaces
2. новый store shape
3. message/meta consumers переводятся на новые selectors
4. event routing меняется
5. structural sharing включается
6. legacy `TeamData.messages` usage выпиливается

То есть rollout последовательный, но не архитектурно компромиссный.

## 15.2 Пошаговый технический план

Важно:

- шаги ниже задают **implementation ownership order**, а не обещание, что каждая микрофаза сама по себе уже merge-safe
- merge-safe checkpoints для PR определяются секциями `Suggested commit slices`, `Mechanical execution checklist` и `Merge gates`
- если отдельный шаг временно делает ветку архитектурно неконсистентной, следующий связанный шаг должен приземляться в том же commit slice до локального smoke
- нельзя останавливать работу на половине coupled migration, если в таком состоянии код снова зависит от legacy mixed snapshot

### Safe temporary states during migration

Чтобы не собрать ветку в промежуточное состояние, которое уже компилируется, но архитектурно тянет старые баги, ниже разрешённые и запрещённые промежуточные формы.

Разрешено временно:

- держать `ResolvedTeamMemberView` renderer-only adapter, пока consumer-компоненты по очереди переводятся на новый overlay model
- держать branch-local compatibility adapters в renderer containers
- держать `selectedTeamData` как convenience alias, пока canonical owner уже `teamDataCacheByName`

Но:

- каждый compatibility adapter должен иметь одного конкретного remaining consumer owner
- adapter удаляется в том же commit slice, где уходит его последний consumer
- нельзя оставлять "универсальный временный adapter", который начинает жить своей отдельной жизнью

Запрещено даже временно:

- возвращать новый structural snapshot и одновременно ждать, что компоненты всё ещё возьмут из него `messages`
- перевести store на новый message cache, но оставить direct component fetch/polling "до следующего коммита"
- держать `selectedTeamData` как independently-built copy после того, как появился canonical cache
- держать второй message dedup/merge path в renderer после появления store-owned canonical path

Если промежуточная ветка попадает в запрещённое состояние, её нельзя считать готовой даже для локального smoke.

### Step 1 - Ввести новые shared contracts

Сделать:

- `TeamViewSnapshot`
- `TeamMemberSnapshot`
- `TeamMemberActivityMeta`
- расширить existing `MessagesPage` полем `feedRevision`
- перевести request shape `getMessagesPage()` c `beforeTimestamp` на `cursor`
- `getMemberActivityMeta()` в `TeamsAPI`

Проверить:

- типы компилируются без renderer migration
- paging contract в shared types уже cursor-based, а не timestamp-based

### Step 2 - Разделить main-side services

Сделать:

- `TeamMemberResolver.resolveStructuralMembers(...)`
- новый `MemberActivityMetaService`
- `TeamDataService.getData()` перестаёт возвращать `messages`

Проверить:

- `getMessagesPage()` остаётся источником сообщений
- main unit tests покрывают structural snapshot отдельно от messages/meta

### Step 3 - Добавить renderer caches

Сделать:

- `teamMessagesByName`
- `memberActivityMetaByTeam`
- `refreshTeamMessagesHead()`
- `refreshMemberActivityMeta()`
- `applyOptimisticTeamMessage()`
- merged selector over `canonicalMessages + optimisticMessages`

Проверить:

- message cache корректно merge'ит optimistic + fetched messages
- canonical refresh не откатывает optimistic row до подтверждения feed

### Step 4 - Перевести `MessagesPanel`

Сделать:

- убрать `messages` prop как canonical input
- читать message entry из store

Проверить:

- initial load
- polling
- load older
- optimistic send

### Step 5 - Перевести `MemberDetailDialog` / `MemberMessagesTab`

Сделать:

- dialog больше не получает full messages prop
- count/meta идут из `memberActivityMeta`
- detail tab читает relevant messages из message store

Проверить:

- open/close dialog
- team switch
- member switch

### Step 6 - Перевести TeamDetail selectors

Сделать:

- `membersWithActivity` как overlay model
- `StatusBlock` перестаёт читать whole messages blob напрямую из snapshot

Проверить:

- pending replies
- active/idle badges
- no visible regression в member list

### Step 7 - Перевести graph

Сделать:

- graph adapter читает `snapshot + messages + memberActivityMeta`

Проверить:

- graph не сломан
- graph не заставляет держать legacy `TeamData.messages`

### Step 8 - Включить event routing split

Сделать:

- `lead-message` и `inbox` больше не зовут full `refreshTeamData()` по умолчанию
- зовут messages/meta refresh

Проверить:

- burst handling
- dedup
- no stale UI

### Step 9 - Включить structural sharing + no-op suppression

Сделать:

- `structurallyShareTeamSnapshot(prev, next)`
- no-op return если snapshot semantically equal
- если до этого в ветке существует temporary old-shape guard на mixed `TeamData`, на этом шаге он либо удаляется, либо сужается до нового structural snapshot comparator

Проверить:

- `selectedTeamData` ref не меняется на no-op refresh
- hidden tabs не получают лишних commits
- в merged target не остаётся comparator, который всё ещё сравнивает legacy `messages` внутри snapshot

### Step 10 - Удалить legacy coupling

Сделать:

- убрать `TeamData.messages`
- убрать prop plumbing `messages={data.messages}`
- обновить тесты

## 15.3 File-by-file execution map

Ниже не "точный diff inventory", а практическая карта, куда идти по шагам, чтобы реализация не расползлась.

### Shared contracts and bridges

- `src/shared/types/team.ts`
  - добавить `TeamViewSnapshot`
  - добавить `TeamMemberSnapshot`
  - добавить `TeamMemberActivityMeta`
  - удалить `messages` из snapshot contract
- `src/shared/types/api.ts`
  - изменить `getData(): Promise<TeamViewSnapshot>`
  - добавить `getMemberActivityMeta()`
- `src/preload/constants/ipcChannels.ts`
  - добавить `TEAM_GET_MEMBER_ACTIVITY_META`
- `src/preload/index.ts`
  - прокинуть `getMemberActivityMeta()`

### Main process

- `src/main/ipc/teams.ts`
  - handler для `team:getMemberActivityMeta`
  - `team:getData` теперь возвращает structural snapshot
- `src/main/services/team/TeamMessageFeedService.ts`
  - новый shared normalized message feed cache/index
  - используется и `getMessagesPage()`, и `getMemberActivityMeta()`
- `src/main/services/team/TeamDataService.ts`
  - `getTeamData()` перестаёт включать `messages`
  - больше не зовёт old `resolveMembers(..., messages)`
  - `getMessagesPage()` перестаёт делать inline full normalize flow
  - делегирует page slicing в shared feed service
- `src/main/services/team/TeamMemberResolver.ts`
  - split на structural-only resolver
- `src/main/services/team/`
  - новый `MemberActivityMetaService.ts`
  - cache по `feedRevision`
- `src/main/services/team/TeamDataWorkerClient.ts`
  - расширить worker ops для message feed / activity meta path
  - обновить типы ответа
- `src/main/services/team/teamDataWorkerTypes.ts`
  - добавить request/response ops для messages/meta path
- `src/main/workers/team-data-worker.ts`
  - синхронизировать worker result types
  - завести обработку new feed/meta ops

### Renderer store and event routing

- `src/renderer/store/slices/teamSlice.ts`
  - добавить `teamMessagesByName`
  - добавить `memberActivityMetaByTeam`
  - добавить actions для head refresh / older pages / meta refresh / optimistic merge
  - добавить single-flight request guards и stale-response guards
  - добавить store-owned fallback polling control
  - добавить structural sharing + no-op suppression для snapshot
- `src/renderer/store/index.ts`
  - поменять routing team events
  - `lead-message` / `inbox` перестают звать full `refreshTeamData()`

### Renderer consumers

- `src/renderer/components/team/TeamDetailView.tsx`
  - переключить на snapshot + message store + memberActivityMeta + spawn statuses
  - pending reply delayed refresh перевести на message-head refresh
- `src/renderer/components/team/messages/MessagesPanel.tsx`
  - удалить прямой fetching logic
  - читать messages из store
- `src/renderer/components/team/activity/ActivityTimeline.tsx`
  - читать messages из store-backed selector или timeline view-model selector
  - не держать local fetch/polling/orchestration
- `src/renderer/components/team/messages/StatusBlock.tsx`
  - получать messages из store-backed source, не из snapshot prop
- `src/renderer/components/team/members/MemberDetailDialog.tsx`
  - убрать `messages` prop
- `src/renderer/components/team/members/MemberMessagesTab.tsx`
  - убрать прямой IPC fetch
  - использовать store messages + selectors
- `src/renderer/components/team/members/MemberList.tsx`
  - читать `hasPendingReply` из local overlay, не из meta
- `src/renderer/components/team/members/MemberHoverCard.tsx`
  - читать facts/view-model selector, а не whole meta wrapper или snapshot messages
- `src/renderer/components/layout/PaneContent.tsx`
  - не менять в этом PR, только учитывать mounted-hidden behavior

### Graph

- `src/features/agent-graph/renderer/adapters/TeamGraphAdapter.ts`
  - pure adapter принимает `(snapshot, messages, memberActivityFacts, teamName)`
- graph-related tests
  - заменить legacy `TeamData.messages` assumptions

### Tests

- `test/main/services/team/TeamDataService.test.ts`
  - snapshot tests отдельно
  - meta tests отдельно
- `test/main/ipc/teams.test.ts`
  - новый IPC handler
  - убрать ожидания `result.data.messages`
- `test/renderer/store/`
  - refresh routing, no-op suppression, optimistic merges
- `test/renderer/components/team/`
  - messages panel, member dialog, member list, pending replies
- `test/renderer/features/agent-graph/`
  - graph adapter больше не зависит от snapshot messages

## 15.4 Merge gates

Это checkpoints, которые должны быть выполнены до merge, иначе PR выглядит "почти доделанным", но архитектурно остаётся дырявым.

### Gate 1 - No dual message source

- `MessagesPanel` не читает `messages` из props
- `MemberMessagesTab` не читает `messages` из team snapshot
- graph не читает `TeamData.messages`

### Gate 2 - Event routing actually split

- `lead-message` event тестом подтверждённо не вызывает full `refreshTeamData()`
- `inbox` event тоже не тянет full snapshot refresh по умолчанию
- `refreshMemberActivityMeta()` не дёргается без `feedChanged === true` или stale-meta condition

### Gate 3 - Exact semantics preserved

- `messageCount` остался exact
- `lastActiveAt` считается по authored messages, как раньше
- terminal message semantics не потеряны
- display status в renderer overlay не сломан для "no message yet but has active task"
- existing pending-reply / TTL / activity threshold constants не поменялись скрытно внутри performance refactor

### Gate 4 - UI semantics preserved

- optimistic send не моргает
- pending member replies всё ещё очищаются фактическим reply
- cross-team TTL badges всё ещё работают
- canonical head refresh не откатывает optimistic rows до server confirmation
- member UI не подписан на whole `TeamMemberActivityMeta` wrapper без необходимости

### Gate 5 - Legacy field gone

- в shared snapshot contract нет `messages`
- в merged renderer code нет чтения `selectedTeamData.messages`
- `selectedTeamData`, если поле сохранено, не является второй independently-built snapshot copy
- old mixed `TeamData` semantic comparator не пережил migration и не остался permanent hot path guard

### Gate 6 - Shared feed cache actually used

- `getMessagesPage()` не содержит второго самостоятельного normalize pipeline
- `MessagesPage` реально несёт `feedRevision`, а store использует его в routing/invalidation
- `getMessagesPage()` режет страницы по stable effective message identity, а не по "сырым optional ids"
- `getMemberActivityMeta()` не читает raw storage напрямую
- оба hot paths сходятся в `TeamMessageFeedService`

### Gate 7 - Worker boundary preserved

- expensive feed rebuild path не исполняется на main event loop
- worker ops для messages/meta path реально wired и покрыты тестом / smoke check
- packaged runtime не молча сваливается в main-thread hot path из-за пропавшего worker artifact

### Gate 8 - Polling ownership preserved

- `MessagesPanel` и `MemberMessagesTab` не держат собственный polling lifecycle
- fallback polling живёт только в store

### Gate 8.5 - Single-flight preserved

- burst events не создают пачку параллельных identical refresh requests на одну и ту же команду
- stale async responses не откатывают store после newer refresh

### Gate 9 - No overview fan-out

- `TeamListView` и похожие overview screens не инициируют скрытый fan-out `getMessagesPage()` / `getMemberActivityMeta()` по всем командам
- overview остаётся на structural snapshot semantics

## 15.5 Suggested commit slices

Если делать это не одним бесформенным diff, а нормальными кусками, я бы резал так:

1. `refactor(team): introduce structural team snapshot contracts`
   - новые shared types
   - новый IPC contract для `getMemberActivityMeta()`

2. `refactor(team): add shared team message feed cache`
   - `TeamMessageFeedService`
   - `getMessagesPage()` переводится на shared feed
   - worker boundary расширяется для messages/meta path

3. `refactor(team): split member activity meta from team snapshot`
   - `MemberActivityMetaService`
   - `TeamMemberResolver` становится structural-only
   - `getData()` перестаёт возвращать `messages`

4. `refactor(renderer): move team message orchestration into store`
   - store caches and actions
   - event routing split
   - store-owned fallback polling

5. `refactor(renderer): migrate team detail consumers to snapshot plus message store`
   - `TeamDetailView`
   - `MessagesPanel`
   - `ActivityTimeline`
   - `MemberDetailDialog`
   - `MemberMessagesTab`
   - `MemberHoverCard`
   - `StatusBlock`
   - graph adapter

6. `test(team): cover snapshot split and message feed ownership`
   - main tests
   - store tests
   - component tests
   - graph tests

Не обязательно коммитить ровно так, но как execution model это сильно снижает хаос.

## 15.6 Mechanical execution checklist

Это section для прямого исполнения. Идея простая: не переходить к следующему шагу, пока текущий не прошёл свой exit check.

### Checklist 0 - Safety prep

- убедиться, что worktree чистый
- прогнать baseline tests, которые покрывают team detail / messages / graph
- зафиксировать baseline perf probes, если уже есть локальный soak scenario

Exit criteria:

- baseline известен
- есть с чем сравнивать после миграции

### Checklist 1 - Contracts first

Сделать:

- ввести `TeamViewSnapshot`
- ввести `TeamMemberSnapshot`
- ввести `TeamMemberActivityMeta`
- расширить existing `MessagesPage` полем `feedRevision`
- перевести `getMessagesPage()` request contract на `cursor`
- описать новые worker request/response contracts для messages/meta path

Проверить:

- types compile
- пока можно держать локальные compatibility adapters, но не merged aliases
- если `selectedTeamData` сохраняется на этом шаге, он уже должен reuse'ить ref canonical cache entry
- `beforeTimestamp` больше не фигурирует как canonical paging API в shared contracts

Exit criteria:

- transport contracts готовы
- дальше можно переписывать main/services без изобретения типов на ходу

### Checklist 2 - Shared feed path

Сделать:

- добавить `TeamMessageFeedService`
- перевести `getMessagesPage()` на shared feed
- нормализовать stable effective message identity до выдачи page response
- провести expensive rebuild path через worker boundary

Проверить:

- один canonical normalize pipeline
- cursor строится по effective identity
- `getMessagesPage()` больше не повторяет old inline normalize flow

Exit criteria:

- message feed path централизован
- `getMessagesPage()` уже не является скрытой legacy дырой

### Checklist 3 - Structural snapshot split

Сделать:

- `getData()` перестаёт возвращать `messages`
- `TeamMemberResolver` становится structural-only
- `MemberActivityMetaService` строится от shared feed

Проверить:

- snapshot без messages компилируется
- meta даёт `messageCountExact` / `lastAuthoredMessageAt`

Exit criteria:

- main-side split завершён
- transport границы больше не смешаны

### Checklist 4 - Store ownership

Сделать:

- store держит `teamMessagesByName`
- store держит `memberActivityMetaByTeam`
- store держит fallback polling
- `refreshTeamMessagesHead()` возвращает semantic result с `feedChanged` / `headChanged`
- store делает single-flight/coalesced refresh orchestration per team
- selector возвращает merged canonical + optimistic messages
- selector layer разделяет `memberActivityFacts` и `memberActivityFeedRevision`

Проверить:

- компоненты ещё могут быть не переведены полностью, но orchestration уже в store

Exit criteria:

- fetching/polling/optimistic merge больше не размазаны по компонентам

### Checklist 5 - UI consumers migration

Сделать:

- `MessagesPanel` без direct fetch/polling
- `ActivityTimeline` от store-backed messages или timeline view-model selector
- `MemberMessagesTab` без direct fetch/polling
- `MemberDetailDialog` без `messages` prop
- `MemberHoverCard` от facts/view-model selector, не от whole wrappers
- `StatusBlock` от store-backed messages
- `TeamDetailView` собирает overlay model
- UI consumers переходят на data/view-model selectors, а не на whole wrappers

Проверить:

- `rg` по renderer не находит direct `api.teams.getMessagesPage(` внутри этих компонентов
- `selectedTeamData.messages` больше не читается
- `MemberMessagesTab` больше не фильтрует whole team messages array прямо в render body
- `ActivityTimeline` больше не строится от snapshot message prop
- `MemberHoverCard` не подписан на whole `TeamMemberActivityMeta` wrapper

Exit criteria:

- UI больше не зависит от legacy message transport

### Checklist 6 - Graph migration

Сделать:

- graph adapter читает snapshot + messages + memberActivityFacts

Проверить:

- graph open не ломается
- больше нет зависимости от `TeamData.messages`

Exit criteria:

- последний крупный consumer legacy messages отрезан

### Checklist 7 - Cleanup and hard gates

Сделать:

- убрать compatibility plumbing
- убрать legacy fields / props
- обновить тесты и perf probes

Проверить:

- проходят merge gates
- проходят critical tests
- soak/perf лучше baseline

Exit criteria:

- PR не только компилируется, но и реально дошёл до целевого shape

## 16. Конкретные code patterns

## 16.1 Reusable array sharing helper

```ts
function reuseArrayIfEqual<T>(
  prev: readonly T[],
  next: readonly T[],
  areEqual: (left: T, right: T) => boolean
): readonly T[] {
  if (prev === next) return prev;
  if (prev.length !== next.length) return next;
  for (let index = 0; index < prev.length; index += 1) {
    if (!areEqual(prev[index], next[index])) {
      return next;
    }
  }
  return prev;
}
```

## 16.2 Narrow selector pattern

```ts
const EMPTY_MESSAGES: readonly InboxMessage[] = Object.freeze([]);
const EMPTY_MEMBER_ACTIVITY_FACTS: Readonly<Record<string, MemberActivityMetaEntry>> =
  Object.freeze({});
const teamMessagesSelectors = new Map<string, (state: AppState) => readonly InboxMessage[]>();
const memberMessagesSelectors = new Map<string, (state: AppState) => readonly InboxMessage[]>();

export function selectTeamSnapshot(teamName: string) {
  return (state: AppState) =>
    state.teamDataCacheByName[teamName] ??
    (state.selectedTeamName === teamName ? state.selectedTeamData : null);
}

export function selectTeamMessagesEntry(teamName: string) {
  return (state: AppState) => state.teamMessagesByName[teamName] ?? null;
}

function getOrCreateTeamMessagesSelector(teamName: string) {
  let selector = teamMessagesSelectors.get(teamName);
  if (!selector) {
    selector = createMemoizedSelector(
      (state: AppState) => state.teamMessagesByName[teamName]?.canonicalMessages ?? EMPTY_MESSAGES,
      (state: AppState) => state.teamMessagesByName[teamName]?.optimisticMessages ?? EMPTY_MESSAGES,
      (canonicalMessages, optimisticMessages) =>
        mergeTeamMessages(canonicalMessages, optimisticMessages)
    );
    teamMessagesSelectors.set(teamName, selector);
  }
  return selector;
}

export function selectTeamMessages(teamName: string) {
  return getOrCreateTeamMessagesSelector(teamName);
}

/** Low-level/internal selector. UI should usually prefer facts/revision selectors below. */
export function selectMemberActivityMeta(teamName: string) {
  return (state: AppState) => state.memberActivityMetaByTeam[teamName] ?? null;
}

export function selectMemberActivityFacts(teamName: string) {
  return (state: AppState) =>
    state.memberActivityMetaByTeam[teamName]?.members ?? EMPTY_MEMBER_ACTIVITY_FACTS;
}

export function selectMemberActivityFeedRevision(teamName: string) {
  return (state: AppState) => state.memberActivityMetaByTeam[teamName]?.feedRevision ?? null;
}

function getOrCreateMemberMessagesSelector(teamName: string, memberName: string) {
  const key = `${teamName}::${memberName}`;
  let selector = memberMessagesSelectors.get(key);
  if (!selector) {
    selector = createMemoizedSelector(selectTeamMessages(teamName), (messages) =>
      messages.filter((message) => message.from === memberName || message.to === memberName)
    );
    memberMessagesSelectors.set(key, selector);
  }
  return selector;
}

export function selectMemberMessages(teamName: string, memberName: string) {
  return getOrCreateMemberMessagesSelector(teamName, memberName);
}
```

Важно:

- `createMemoizedSelector` здесь условное имя для любой стабильной selector factory, которую команда уже использует
- важно не конкретное API helper'а, а то, что merged selectors действительно memoized и возвращают stable refs
- fallback на `selectedTeamData` в примере выше нужен только пока поле ещё существует; если `selectedTeamData` удалён, selector упрощается до чтения `teamDataCacheByName`

### Selector usage rule

- `TeamDetailView`, `MemberList`, `MemberHoverCard`, `MemberDetailDialog` должны читать facts selector, а не whole meta wrapper
- routing / polling logic может читать revision selector отдельно
- components, которым нужен только message array, не должны подписываться на whole `TeamMessagesCacheEntry`, если им не нужны loading flags
- `MemberMessagesTab` по умолчанию должен читать `selectMemberMessages(teamName, memberName)` или аналогичный memoized selector, а не фильтровать whole array прямо в render body
- empty selector fallbacks должны возвращать stable frozen references, а не новый `{}` / `[]` на каждый вызов

### Practical selector split

Для ясности полезно сразу мыслить селекторы тремя слоями:

- data selectors
  - `selectTeamSnapshot(teamName)`
  - `selectTeamMessages(teamName)`
  - `selectMemberActivityFacts(teamName)`
  - `selectMemberMessages(teamName, memberName)`
- control selectors
  - `selectTeamMessagesEntry(teamName)` только для loading flags / cursor / hasMore
  - `selectMemberActivityFeedRevision(teamName)` только для routing / stale checks
- view-model selectors
  - `selectResolvedTeamMembersView(teamName)`
  - `selectPendingRepliesView(teamName)`

Правило:

- components по умолчанию читают data/view-model selector
- control selectors не должны становиться случайным render dependency для большого UI subtree

## 16.3 Overlay model builder

```ts
function mergeMembersWithActivity(
  members: TeamMemberSnapshot[],
  activityFacts: Record<string, MemberActivityMetaEntry>,
  spawnStatuses: Record<string, MemberSpawnStatusEntry>
): ResolvedTeamMemberView[] {
  return members.map((member) => {
    const activity = activityFacts[member.name];
    const spawn = spawnStatuses[member.name];
    return {
      ...member,
      lastActiveAt: activity?.lastAuthoredMessageAt ?? null,
      messageCount: activity?.messageCountExact ?? 0,
      status: resolveDisplayMemberStatus(member, activity, spawn),
    };
  });
}
```

### Это важный паттерн

View-model можно смешивать в renderer.  
Transport contract смешивать нельзя.

### Что добавляется поверх этого отдельно

`pendingRepliesByMember` overlay надо мержить отдельным путём:

```ts
const membersWithActivityAndPending = membersWithActivity.map((member) => ({
  ...member,
  hasPendingReply: Boolean(pendingRepliesByMember[member.name]),
}));
```

То есть:

- stable facts идут из `memberActivityMeta`
- ephemeral pending-reply UX идёт из local renderer state

## 16.4 Display status helper

```ts
function resolveDisplayMemberStatus(
  member: TeamMemberSnapshot,
  activity: MemberActivityMetaEntry | undefined,
  spawn: MemberSpawnStatusEntry | undefined,
  nowMs = Date.now()
): MemberStatus {
  if (member.removedAt) return 'terminated';
  if (activity?.latestAuthoredMessageSignalsTermination) return 'terminated';

  const lastAuthoredAt = activity?.lastAuthoredMessageAt;
  if (!lastAuthoredAt) {
    return member.currentTaskId ? 'active' : 'idle';
  }

  const ts = Date.parse(lastAuthoredAt);
  if (!Number.isFinite(ts)) return 'unknown';

  return nowMs - ts < 5 * 60 * 1000 ? 'active' : 'idle';
}
```

Важно:

- helper повторяет старую message-authored semantics
- task presence влияет только на case "сообщений ещё не было"
- spawn/runtime state не переписывает этот base status, а накладывается отдельно в presentation helpers

## 17. Что обязательно не сломать

Вот места, где проще всего внести регрессию.

### 17.1 `sendTeamMessage()` UX

Пользователь не должен видеть:

- пропадающее только что отправленное сообщение
- дубль optimistic + fetched
- откат scroll position

### 17.2 `pendingRepliesByMember`

Если сейчас pending reply badge обновляется от локального state и timers, новый split не должен сделать его laggy.

### 17.3 Scroll and expanded state in `MessagesPanel`

Сообщения больше не придут как prop re-seed.  
Нужно проверить, что:

- scroll memory сохраняется
- expanded item state не сбрасывается на каждый head refresh

### 17.4 `MemberHoverCard`

Он сейчас читает selected team member data из snapshot.  
После split не надо случайно вернуть message-derived churn в hover path.

### 17.5 `ActivityTimeline`

Это один из исходных hot consumers, поэтому его нельзя считать "само как-то переедет".

После split важно проверить:

- timeline derivations не зависят от `selectedTeamData.messages`
- hidden tab не получает wide invalidation только из-за timeline selectors
- timeline grouping не пересчитывается от whole wrapper change, если message slice фактически не менялся

### 17.6 TeamListView / global task dialogs

Они не должны внезапно стать зависимыми от message caches.

Особенно важно:

- не тащить `getMessagesPage()` / `getMemberActivityMeta()` в list-row hydration path
- не вводить скрытый fan-out по всем видимым командам
- если `StatusBlock` или похожий badge показывается в overview context, он использует только уже гидратированный cache или structural fallback и не имеет права сам инициировать hidden team hydration

## 18. Тестовый план

## 18.1 Main unit tests

Нужны тесты на:

- `getData()` не возвращает messages
- structural members строятся без message history
- `getMessagesPage()` возвращает `feedRevision`, описывающий весь normalized feed
- historical-only feed change может обновить `feedRevision` даже если top page slice тот же
- forced rebuild того же normalized feed не меняет `feedRevision`
- successful empty head fetch возвращает non-null `feedRevision` и корректно инициализирует empty canonical state
- каждый message row в page response несёт stable effective identity
- `getMemberActivityMeta()` корректно считает `lastAuthoredMessageAt`
- `getMemberActivityMeta()` сохраняет exact `messageCount`
- `getMemberActivityMeta()` корректно помечает `latestAuthoredMessageSignalsTermination`
- shared message feed cache не пересобирается без изменения feed inputs
- meta cache переиспользуется при том же `feedRevision`
- expensive rebuild path для messages/meta идёт через worker op, а не мимо worker boundary

## 18.2 Renderer store tests

Нужны тесты на:

- `refreshTeamData()` no-op suppression сохраняет ref
- `selectedTeamData` reuse'ит exact same ref as `teamDataCacheByName[selectedTeamName]`
- при `selectedTeamName` switch `selectedTeamData` не продолжает указывать на snapshot предыдущей команды
- отсутствие `teamDataCacheByName[teamName]` и `memberActivityMetaByTeam[teamName]` до first success не заменяется fake placeholder objects
- `refreshTeamMessagesHead()` merge'ит новые head messages
- `refreshTeamMessagesHead()` различает `feedChanged` и `headChanged`
- `refreshTeamMessagesHead()` не возвращает невозможное состояние `feedChanged === false && headChanged === true`
- store single-flight coalescing не допускает burst из параллельных head refresh на одну команду
- head refresh и older-page load для одной команды не мутируют canonical window параллельно
- `loadingHead === true && loadingOlder === true` для одной команды не возникает
- `selectTeamMessages(teamName)` сохраняет stable ref, если canonical/optimistic inputs не менялись
- UI selectors, читающие member activity facts, не re-render'ятся только из-за смены `computedAt` / `feedRevision`
- in-flight/dirty/visibility bookkeeping не становится случайным render-driving reactive state без отдельной причины
- failure в `refreshTeamMessagesHead()` не очищает уже загруженный canonical window
- `lastFetchedAt` остаётся `null` до первого успешного head/message fetch и не меняется на failed request
- failure в `refreshMemberActivityMeta()` не очищает предыдущий facts record
- `loadOlderTeamMessages()` before head hydration не делает некорректный older-page request
- `loadOlderTeamMessages()` при `hasMore === false` делает cheap no-op
- `headHydrated === false` не сочетается с non-empty `canonicalMessages` или с `loadingOlder === true`
- `headHydrated === false` сочетается только с bootstrap `feedRevision/null`, `nextCursor/null` и `lastFetchedAt/null`
- optimistic row может жить поверх `headHydrated === false` bootstrap entry до первого successful head fetch
- optimistic send + fetched confirmation dedup
- failed optimistic send удаляет optimistic row и откатывает local pending-reply state
- optimistic row survives canonical refresh until matching `messageId` appears
- user send сам по себе не триггерит лишний `refreshMemberActivityMeta()`
- `lead-message` event больше не вызывает `refreshTeamData()`
- `task` event по-прежнему вызывает `refreshTeamData()`
- delayed waiting refresh для pending member reply зовёт `refreshTeamMessagesHead()`, а не full snapshot refresh
- hidden inactive team не получает message/meta refresh от чужих событий
- одного `selectedTeamName` без explicit visibility signal недостаточно для запуска visible-team polling/hydration policy
- late response для предыдущей команды после switch не переустанавливает `selectedTeamData` под новую выбранную команду
- hide transition не очищает уже гидратированные snapshot/message/meta caches сам по себе
- reopen после hide reuse'ит существующий cache baseline, а не требует forced cold-start reset
- `refreshMemberActivityMeta()` после lead/inbox идёт только при `feedChanged === true` или stale-meta condition
- historical-only `feedChanged === true` при `headChanged === false` всё равно запускает meta refresh
- older-page response после newer head refresh не откатывает `nextCursor` и не ломает canonical ordering
- irreconcilable merge after `feedRevision` change сбрасывает только canonical older tail и не теряет optimistic rows
- fallback polling запускается только для visible active team или local pending-reply wait state

## 18.3 Component tests

Нужны тесты на:

- `MessagesPanel` initial hydration from store
- `ActivityTimeline` читает store-backed messages/view-model path, а не snapshot prop
- `MemberDetailDialog` without snapshot messages prop
- `MemberHoverCard` читает facts/view-model selector, а не whole meta wrapper
- `StatusBlock` отрабатывает member pending replies из local overlay
- overview `StatusBlock` или аналогичный badge не триггерит hidden team hydration
- graph adapter берёт messages не из snapshot
- `StatusBlock` корректно считает cross-team pending replies из message cache + local TTL
- `MessagesPanel` и `MemberMessagesTab` не содержат собственного polling/fetch orchestration
- older-page loading не ломает scroll/order при одновременном head refresh

## 18.4 Soak / perf validation

Нужны реальные runtime probes:

- count of `refreshTeamData` calls
- count of suppressed no-op snapshot writes
- count of `refreshTeamMessagesHead`
- count of `refreshMemberActivityMeta`
- commit count `TeamDetailView`
- longtask count and max before/after
- IPC payload size before/after for `team:getData`

## 19. Acceptance criteria

Фикс можно считать правильным, если одновременно выполняется всё:

1. `lead-message` storm больше не вызывает repeated `refreshTeamData()` для visible team
2. identical structural snapshot не меняет `selectedTeamData` ref
3. `MessagesPanel` живёт без `data.messages` prop
4. member list/status block не зависят от full messages array inside snapshot
5. graph не зависит от `TeamData.messages`
6. `MessagesPanel` и `MemberMessagesTab` не делают direct IPC fetch из компонента
7. long tasks на 4-member soak заметно падают
8. нет regressions в optimistic send, member dialog, pending replies
9. hot path `getMessagesPage()` больше не делает raw full rescan на каждый visible refresh
10. multi-team overview screens не создают hidden fan-out на `getMessagesPage()` / `getMemberActivityMeta()`
11. burst event storm не порождает параллельную очередь одинаковых head/meta refresh requests

### Практический perf target

Хотя бы такой:

- skip-rate no-op structural refreshes высокий в heartbeat windows
- `team:getData` payload ощутимо меньше
- long tasks больше не накапливаются без видимых изменений UI

## 19.1 Reviewer checklist

Это короткий список для финальной проверки PR человеком, который не писал реализацию.

Reviewer должен уметь ответить "да" на каждый пункт ниже без догадок:

- `rg` по merged code не находит чтения `selectedTeamData.messages`
- `getData()` типизирован как `TeamViewSnapshot`, а не legacy mixed transport
- `getMessagesPage()` в shared API больше не использует `beforeTimestamp` как canonical paging contract
- `MessagesPage.feedRevision` выглядит как content-stable revision, а не timestamp-like token
- `getMessagesPage()` и `getMemberActivityMeta()` сходятся в один shared feed backend
- `MessagesPanel` и `MemberMessagesTab` не содержат прямых IPC fetch/polling путей
- UI member list читает facts selector или view-model selector, а не whole `TeamMemberActivityMeta`
- `selectedTeamData`, если сохранён, reuse'ит тот же ref, что и canonical cache entry
- worker path для heavy messages/meta rebuild реально задействован в нормальном runtime
- older-history merge имеет safety fallback, а не assumes append-only forever
- tests покрывают `feedChanged === true` при `headChanged === false`

Если хотя бы на один пункт ответ "не уверен", PR ещё слишком двусмысленный и план выполнен не полностью.

## 20. Нужен ли future split ещё дальше

Эта секция не открывает scope текущего PR.

Правило:

- ничего из списка ниже не является blocker для merge текущего split
- если реализация текущего PR начинает зависеть от одного из этих future ideas, это уже scope creep и его надо отдельно остановить
- acceptance current PR определяется только секциями выше, а не будущими optional split ideas

Возможно, но не обязательно сразу.

### Что имеет смысл split'ить позже, если понадобится

- task comments/history, если они станут heavy
- graph-specific activity feed
- process diagnostics/log metadata

### Что не надо split'ить сейчас

- `config`
- `tasks`
- `kanbanState`
- `processes`

Они пока выглядят как разумный structural snapshot.

То есть ответ на вопрос "мы в будущем ещё больше разрежем `getData`?" такой:

- возможно да
- но **не надо делать это заранее**
- прямо сейчас правильная граница проходит по messages и message-derived member activity

## 21. Отдельно про Linux task manager и "Electron 12.1 GB"

Это важно понимать правильно.

Если на Linux в системном мониторинге видны отдельные строки:

- `electron`
- `chrome --type=renderer`
- `node`
- `claude-multimodel`

то это обычно **отдельные OS processes**, а не "всё сложено в electron row".

Следствие:

- `electron 12.1 GB` очень похоже на реальный RSS browser/main процесса Electron
- spawned Claude/Codex/node subprocesses обычно не должны магически считаться внутрь этой строки, если они уже видны отдельно

Это не доказывает leak само по себе, но и не выглядит как "да это просто все дети туда суммировались".

### Что добавить для подтверждения

Нужна отдельная main-side telemetry:

```ts
const mem = process.memoryUsage();
const metrics = app.getAppMetrics();
```

И логировать хотя бы каждые 30s:

- `rss`
- `heapUsed`
- `external`
- per-process Electron metrics

Тогда станет видно:

- реально ли main/browser process растёт
- есть ли рост после renderer recovery
- совпадает ли это с observed long stalls

## 22. Мой итоговый вывод

Если хочется сделать **сразу правильно**, а не делать цепочку полуфиксов, то целевой дизайн должен быть именно таким:

- `getData(teamName)` -> structural snapshot
- `getMessagesPage(teamName, { limit, cursor })` -> message feed
- `getMemberActivityMeta(teamName)` -> lightweight message-derived overlay
- renderer store хранит их раздельно
- event routing тоже раздельный
- `refreshTeamData()` имеет structural sharing + no-op suppression

Самый частый неправильный компромисс здесь:

- "давайте просто сравним новый `TeamData` с предыдущим и всё"

Это хороший emergency mitigation, но не лучший final state.

Самый надёжный final state:

- split boundaries
- убрать message-derived смысл из structural snapshot
- сохранить semantic guard как страховку

Именно это я считаю вариантом, который ближе всего к "сделать один раз и правильно", а не возвращаться потом ещё на два круга переделки.
