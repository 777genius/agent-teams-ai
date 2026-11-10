# Task Queue / Agenda Rollout Plan

**Date:** 2026-04-21  
**Status:** Proposed  
**Scope:** Team Management, MCP task surfaces, agent operational queue

---

## TL;DR

✅ Базовое решение:

- перед полноценным agenda rollout сначала делаем **Phase 0 hardening** для слабых сигналов
- source of truth остаётся в сырых task/review/kanban файлах
- в Phase 1 не заводим второй persisted projection-файл
- вместо этого строим **derived queue projection on read** через **controller-owned board snapshot** под **team-level lock**
- вводим явные derived-поля: `actionOwner`, `nextAction`, `queueCategory`, `watchers`
- разделяем 4 разных surface:
  - `member_briefing` = только bootstrap + правила + роль
  - `task_briefing` = каноническая очередь конкретного участника
  - `lead_briefing` = каноническая очередь лида
  - `task_list` = inventory/search surface, который постепенно уходит в filtered role
- Phase 2 добавляет `revision` и только потом, если реально нужно по профайлингу, `delta`

Главная мысль: проблема не в том, что `task_list` "слишком длинный". Проблема в том, что он сейчас смешивает **inventory**, **workflow state**, **операционный приоритет** и **шум**, заставляя LLM самому угадывать "что мне делать сейчас".

⚠️ После дополнительного code review важны 4 уточнения:

- сейчас в коде нет общего board-level lock поверх task + kanban + review mutations, но Phase 0 надо ограничить controller snapshot/mutation scope, а не пытаться сразу перевести под него все main-side readers
- reviewer для review-задачи в Phase 0/1 надо выводить только из текущего review cycle в `historyEvents`, потому что оба write-path сегодня заводят kanban review entry с `reviewer: null`
- `needsClarification: "lead"` в коде сейчас auto-clear'ится шире, чем обещают prompt-инструкции, поэтому safest Phase 0 - explicit clear only
- `task_list` нельзя резко ломать сменой default semantics, потому что lead prompts уже используют его как full inventory entrypoint

---

## 1. Почему вообще понадобился этот redesign

Сейчас у системы есть 2 разных read-path, но ни один из них не задаёт правильную operational semantics:

### `task_list`

- технически возвращает почти весь список задач команды
- это не "очередь работы", а полу-сырой inventory dump
- он слишком тяжёлый по payload
- главное, он **не говорит явно**, кто сейчас должен действовать по задаче
- агенту приходится самому вычислять:
  - моя ли это задача
  - жду ли я ревью
  - я ли ревьюер
  - надо ли пинговать лида
  - задача реально actionable или просто informational

### `task_briefing`

- даёт более компактное представление
- но сейчас завязан в основном на `owner === memberName`
- поэтому не покрывает важные сценарии:
  - задача формально owned одним участником, но action сейчас у ревьюера
  - задача зависла из-за отсутствующего reviewer
  - задача ждёт решения лида
  - участнику нужна awareness по своим задачам, даже если actionOwner временно не он

Итог:

- лид не получает нормальную operational queue
- тиммейт может не видеть "что от него реально требуется"
- LLM тратит токены и качество на вывод политики из сырых полей
- при росте команды и количества задач путаница становится системной

---

## 2. Что именно не так в текущей модели

### 2.1 `task_list` сегодня слишком близок к raw dump

По факту текущий `task_list` делает почти "отдать все задачи, слегка урезав крупные поля". Это blocklist-подход:

- убираются тяжёлые поля вроде комментариев и истории
- почти всё остальное сохраняется

Такой подход плох не только по размеру, но и по смыслу:

- агенту всё ещё видны почти все задачи команды
- инструмента нет opinionated workflow surface
- список не говорит, какие карточки именно должны попасть в текущую очередь участника

### 2.2 `task_briefing` сегодня не отделяет action от awareness

Сейчас логика ближе к "покажи мои assigned tasks". Но operational queue и assigned list не одно и то же.

Примеры:

- owner = `alice`, reviewer = `bob`, задача в review  
  `alice` должна понимать, что задача не пропала, но actionOwner уже `bob`
- задача completed, reviewer ещё не назначен  
  action нужен не owner, а лиду
- задача ждёт ответа от user  
  actionOwner = `user`, но лид должен видеть это как oversight item

### 2.3 Raw task list не должен быть основным surface для LLM

LLM лучше работает, когда система даёт:

- кто сейчас должен действовать
- почему именно он
- какое следующее ожидаемое действие
- что informational, а что actionable

LLM хуже работает, когда ему дают 50 карточек и ожидают, что он сам выведет workflow policy.

### 2.4 Важные факты из текущего кода

Ниже то, на что уже можно опираться в rollout, без изобретения новой подсистемы с нуля:

- `task_list` сегодня реально отдаёт почти весь team inventory в урезанном виде, а не opinionated queue
- `task_briefing` сегодня в основном строится через `owner === memberName`
- `review_request` технически может отправить задачу в review даже без явно резолвленного reviewer
- active reviewer для agenda-safe routing в Phase 0/1 надо выводить только из текущего review cycle в `historyEvents`; per-task kanban reviewer сейчас не является надёжным signal
- runtime identity для участника уже умеет частично резолвиться из существующего runtime context
- UI и MCP уже в основном идут через `agent-teams-controller`, то есть rollout можно делать эволюционно вокруг текущего controller layer
- task и kanban сегодня пишутся atomically по файлам, но не transactionally как единый board update
- controller-side task/kanban write paths сейчас вообще не используют существующий `withFileLockSync(...)`; текущий lock primitive живёт отдельно, синхронный, busy-wait, с acquire timeout `5s` и stale timeout `30s`
- `review_request` сейчас делает multi-step sequence `kanban -> task history -> message`, значит queue read действительно может увидеть промежуточное состояние
- `review_request` при ошибке отправки уведомления сейчас делает только `kanban.clear`, но уже записанный `review_requested` history event не откатывает
- `needsClarification: "lead"` в task store сейчас auto-clear'ится при комментарии любого не-owner автора, а не только лида
- `task_list` использует blocklist-подход, поэтому payload может незаметно разрастаться при появлении новых task-полей
- текущий `task_list` в MCP напрямую вызывает `controller.tasks.listTasks()` без фильтров и затем прогоняет результат через `slimTaskForList(...)`, то есть filter-capable inventory contract пока даже не выбран
- `task_list` входит в teammate operational tool catalog, значит prompt-only migration недостаточна - нужен ещё catalog/access rollout
- в репо есть как минимум две локальные `.d.ts` декларации для `agent-teams-controller`, и они уже расходятся по полноте surface
- `mcp-server` тесты сейчас явно проверяют текущую blocklist-semantics `task_list`, значит migration должна обновлять и test contract, а не только runtime
- `owner` и `needsClarification` хранятся как текущие поля task payload, но не имеют такого же history-backed контракта, как review transitions
- task logs умеют видеть `task_set_owner` / `task_set_clarification`, но это отдельный observability слой, а не базовый queue source of truth
- в schema у `kanban-state.tasks[taskId]` есть `reviewer`, но официальный mutation patch сейчас не несёт reviewer как поддерживаемый per-task signal
- prompt знает правило вида "если есть reviewer/qa/tech-lead, отправляй на review", но это не равняется канонической machine-readable review policy в runtime state
- roster resolution уже существует минимум в двух вариантах: controller-side `resolveTeamMembers(...)` и main/UI-side `TeamMemberResolver`, и они нормализуют состав команды не полностью одинаково
- main-side `TeamDataService` compatibility layer сейчас резолвит `reviewer` как `kanbanTaskState.reviewer ?? history(review_approved|review_started|review_requested)`, а `reviewState` берёт из persisted field, что уже шире и слабее, чем queue-safe current-cycle contract
- `setTaskOwner` и `task_set_clarification` меняют task payload и `updatedAt`, но не добавляют workflow events в `historyEvents`
- stall-monitor уже использует более строгую review-window semantics, где открытое review окно начинается с `review_started`, а не просто с `review_requested`

Это важно, потому что план не требует:

- переписывать storage
- менять формат task-файлов
- вводить новый отдельный board runtime

---

## 3. Цели redesign

Нужно добиться одновременно 5 свойств:

1. **Однозначность**
   По каждой активной задаче должен существовать один primary `actionOwner` или явно `none/user`.

2. **Компактность**
   Обычный teammate не должен получать весь board dump только ради того, чтобы понять свои 2-4 задачи.

3. **Надёжность**
   Read model не должен становиться вторым нестабильным source of truth.

4. **Понятная иерархия surfaces**
   Bootstrap, operational queue, full context и inventory/search должны быть разными инструментами.

5. **Эволюционность**
   Phase 1 должен сильно улучшить поведение без большого риска stale projection bugs.

---

## 3.1 Confidence Map After Code Review

Ниже зоны, где после просмотра кода у нас разная степень уверенности.

### A. Derived agenda как базовый read model

`🎯 10   🛡️ 10   🧠 6`

Почему уверенность высокая:

- это не требует второго durable state
- current storage уже содержит достаточно сигналов для derived routing
- основной риск здесь не идея, а discipline around rollout

### B. Controller-owned board snapshot + lock

`🎯 9   🛡️ 9   🧠 5`

Почему уверенность выросла:

- после дополнительного просмотра видно, что main-side raw readers (`TeamTaskReader`, `TeamKanbanManager`) живут отдельно и не требуют немедленного включения в agenda path
- для agent-facing queue достаточно сначала сделать один канонический controller snapshot contract
- это сильно уже и безопаснее, чем пытаться в Phase 0 синхронно унифицировать весь repo вокруг одного lock API

### C. Reviewer resolution

`🎯 8   🛡️ 9   🧠 4`

Почему уверенность стала выше:

- и controller-side `kanbanStore.setKanbanColumn(...)`, и main-side `TeamKanbanManager.updateTask(...)` при переводе в `review` записывают `reviewer: null`
- значит ambiguity здесь на самом деле меньше, а не больше: Phase 0/1 просто не должны опираться на per-task kanban reviewer
- остаётся чётко определить только current-cycle precedence внутри `historyEvents`

### D. Clarification semantics

`🎯 8   🛡️ 10   🧠 3`

Это всё ещё слабая зона текущего runtime, но у неё теперь есть понятный safe fallback.

Причина:

- prompts говорят одно
- код auto-clear'ит флаг шире
- но safest fix очень прямой: в Phase 0 убрать implicit auto-clear из routing contract и жить через explicit `task_set_clarification clear`

### E. `task_list` migration без silent breakage

`🎯 7   🛡️ 7   🧠 5`

Почему:

- целевая роль `task_list` понятна
- но менять его default резко опасно, потому что старые лид-промпты уже ожидают текущую семантику
- значит migration должна идти через новый canonical surface, а не через скрытую подмену смысла

### F. Queue-side roster normalization

`🎯 7   🛡️ 8   🧠 5`

Почему это остаётся важной зоной:

- controller-side `resolveTeamMembers(...)` и UI-side `TeamMemberResolver` до сих пор фильтруют roster не полностью одинаково
- для queue это критично, потому что invalid owner/reviewer routing зависит от того, кого мы вообще считаем валидным member
- но здесь достаточно зафиксировать минимальный queue contract и покрыть его тестами, без большого package refactor

### G. Lead identity normalization for `lead_briefing`

`🎯 6   🛡️ 8   🧠 4`

Почему это остаётся слабее других зон:

- controller-side `inferLeadName(...)` использует ad hoc heuristics: `agentType === "team-lead"`, `role` содержит `lead`, имя `team-lead`, иначе первый config member
- shared `leadDetection` utilities уже живут по чуть более другому контракту
- для `lead_briefing` и future ergonomic clarification clear нельзя опираться на "может быть это и есть lead" без явного phase rule

### H. Tool-catalog scoping for `lead_briefing`

`🎯 8   🛡️ 9   🧠 4`

Почему это важно:

- текущий `mcpToolCatalog` режет доступность по group-level `teammateOperational`, а не по per-tool policy
- если просто положить `lead_briefing` в existing task-group, он автоматически окажется в teammate operational tool set
- это не runtime bug, но это прямой путь к лишнему шуму и путанице у teammate agents

---

## 3.2 Top 3 Options In The Least Certain Areas

Ниже не "все возможные идеи", а именно те развилки, где реально можно ошибиться архитектурно.

### A. Где должен жить shared board lock

**1. Controller-owned board snapshot API + controller-local team lock**

`🎯 10   🛡️ 9   🧠 5`

Примерный объём: `80-160` строк изменений

Суть:

- внутри `agent-teams-controller` ввести один канонический `withTeamBoardLock(...)` или `getBoardSnapshot(...)`
- под него завести multi-file mutations review/task/kanban и agenda reads
- main-process не заставлять в той же фазе массово переходить на этот primitive, если ему не нужен именно agenda-grade snapshot

Почему это лучший вариант:

- один semantic owner для agent-facing queue
- не раздувает Phase 0 до cross-layer refactor всей файловой модели
- оставляет возможность позже экспортировать тот же snapshot наружу, если он реально понадобится UI

**2. Exported generic shared primitive across controller + main**

`🎯 7   🛡️ 8   🧠 6`

Примерный объём: `100-180` строк изменений

Суть:

- сделать универсальный lock/snapshot contract, который одинаково используют controller и main

Риск:

- полезно в долгую, но для ближайшего rollout это уже больше работа, чем нужно
- есть риск начать чинить "архитектурную красоту" вместо реально агентского queue path

**3. Пер-file lock orchestration без отдельного team lock**

`🎯 3   🛡️ 3   🧠 6`

Примерный объём: `60-120` строк изменений

Суть:

- пытаться добиться консистентности через набор локов на task/kanban файлы

Риск:

- сложнее reasoning
- выше риск partial interleaving
- хуже читается и хуже тестируется

Выбор:

- брать **вариант 1**
- вариант 2 рассматривать только если после rollout тот же snapshot contract реально понадобится non-controller consumers

### B. Как резолвить reviewer для active review cycle

**1. Pure history-first current-cycle resolver**

`🎯 10   🛡️ 10   🧠 4`

Примерный объём: `70-140` строк изменений

Суть:

- сканировать history backwards только в пределах текущего review cycle
- использовать `review_started.actor` и `review_requested.reviewer` как основные сигналы
- в Phase 0/1 вообще **не использовать** `kanban-state.tasks[taskId].reviewer` как routing signal

Почему это лучший вариант:

- максимально опирается на уже существующие durable events
- согласуется с уже существующей derivation логикой review state через history
- это полностью соответствует реальному коду: и controller, и main сейчас создают review-entry с `reviewer: null`

**2. History-first now, kanban fallback only after writer hardening**

`🎯 6   🛡️ 8   🧠 6`

Примерный объём: `110-210` строк изменений

Суть:

- сначала расширить write-path так, чтобы per-task `reviewer` реально persist'ился
- только после этого разрешить kanban fallback в resolver

Риск:

- это уже не Phase 0 hardening, а изменение durable semantics
- если делать одновременно с agenda rollout, возрастает blast radius

**3. Новый persisted reviewer slot в task schema**

`🎯 7   🛡️ 8   🧠 7`

Примерный объём: `120-240` строк изменений

Суть:

- добавить explicit reviewer прямо в task payload и синхронизировать его в review flow

Плюсы:

- проще future reads

Минусы:

- новая durable schema responsibility
- выше цена ошибок и миграции

Выбор:

- для Phase 0/1 брать **вариант 1**
- вариант 3 оставлять как later optimization, только если history-based resolver окажется недостаточным

### C. Как harden'ить clarification clearing

**1. Phase 0 explicit-clear-only semantics**

`🎯 10   🛡️ 10   🧠 3`

Примерный объём: `25-60` строк изменений

Суть:

- не делаем никакой implicit auto-clear частью routing contract
- clarification снимается только через явный `task_set_clarification clear`
- prompts и briefing обновляются синхронно

Почему это лучший вариант:

- максимально надёжно
- убирает silent false negatives в очереди
- делает поведение легко тестируемым и объяснимым

**2. Controller-layer lead-aware auto-clear after alias hardening**

`🎯 8   🛡️ 9   🧠 6`

Примерный объём: `70-140` строк изменений

Суть:

- после стабилизации lead identity вернуть удобство:
  - `lead` clarification clear'ится на комментарий лида
  - `user` clarification clear'ится на комментарий пользователя

Риск:

- нужно сначала жёстко определить:
  - canonical lead identity
  - alias policy (`team-lead`, фактическое имя лида, возможный `lead`)
  - valid actor normalization

**3. Протянуть explicit `canClearClarification` / `leadName` в taskStore API**

`🎯 5   🛡️ 6   🧠 6`

Примерный объём: `50-110` строк изменений

Суть:

- taskStore всё ещё делает auto-clear, но получает workflow policy сверху

Риск:

- API store начинает знать слишком много про workflow policy

Выбор:

- для Phase 0 брать **вариант 1**
- вариант 2 оставлять как optional ergonomics pass только после стабилизации lead alias semantics

Отдельное уточнение:

- это не двухстрочная правка в storage layer
- `taskStore.addTaskComment()` сам по себе не знает, кто является lead для команды

Поэтому "clear only when lead answers" нельзя надёжно реализовать внутри store без:

- переноса policy выше, в controller/context layer
- или явной передачи lead-aware policy signal в storage API

### D. Как делать queue revision в Phase 2

**1. Stable hash of compact agenda DTO**

`🎯 9   🛡️ 9   🧠 4`

Примерный объём: `40-90` строк изменений

Суть:

- как в `feedRevision`, считать hash от уже нормализованного compact agenda payload

Почему это лучший вариант:

- не требует extra durable file
- легко проверять
- удобно для `unchanged` short-circuit

**2. Team directory mtime / file timestamps**

`🎯 4   🛡️ 4   🧠 3`

Примерный объём: `20-40` строк изменений

Риск:

- платформенная хрупкость
- плохая детерминированность

**3. Dedicated revision counter file**

`🎯 7   🛡️ 8   🧠 6`

Примерный объём: `70-140` строк изменений

Плюсы:

- дешёвые reads

Минусы:

- ещё одна durable write responsibility

Выбор:

- сначала **вариант 1**
- вариант 3 рассматривать только если hash on read реально станет bottleneck

### E. Где должна жить canonical agenda derivation logic

**1. Controller-owned single implementation**

`🎯 9   🛡️ 9   🧠 5`

Примерный объём: `90-170` строк изменений

Суть:

- agenda derivation живёт в `agent-teams-controller`
- MCP tools только оборачивают её
- main-process, если ему нужен тот же semantic surface, либо вызывает controller API, либо использует тот же exported helper

Почему это лучший вариант:

- один semantic owner
- меньше риска drift между MCP/runtime/UI
- уже сейчас controller является главным write-path для board operations

**2. Отдельные реализации в controller и main-process**

`🎯 4   🛡️ 4   🧠 4`

Примерный объём: `120-220` строк изменений

Риск:

- review/clarification semantics почти гарантированно разъедутся со временем
- сложнее тестировать и объяснять различия

**3. Новый общий workspace package / shared helper**

`🎯 7   🛡️ 8   🧠 7`

Примерный объём: `140-260` строк изменений

Плюсы:

- архитектурно чище в долгую

Минусы:

- это уже mini-refactor package boundaries
- для Phase 0/1 цена выше, чем польза

Выбор:

- для ближайшего rollout брать **вариант 1**
- вариант 3 оставлять как later cleanup, если agenda surface реально понадобится нескольким runtime слоям в одном виде

### F. Как уводить `task_list` от teammate default workflow

**1. Prompt + tool-catalog phased migration**

`🎯 9   🛡️ 9   🧠 5`

Примерный объём: `60-120` строк изменений

Суть:

- сначала вводим `lead_briefing`
- затем меняем prompts
- затем убираем `task_list` из teammate operational catalog или переводим его в less-prominent surface

Почему это лучший вариант:

- migration управляемая
- меньше surprising behavior для уже работающих flows

**2. Prompt-only migration**

`🎯 5   🛡️ 5   🧠 2`

Примерный объём: `15-35` строк изменений

Риск:

- `task_list` всё равно остаётся у тиммейта "под рукой"
- модель будет продолжать иногда использовать его как shortcut

**3. Instant hard removal from teammate catalog**

`🎯 6   🛡️ 7   🧠 4`

Примерный объём: `20-60` строк изменений

Плюсы:

- быстро убирает temptation

Минусы:

- выше шанс сломать существующие prompt assumptions и recovery workflows

Выбор:

- брать **вариант 1**

### G. Как трактовать "review required" без явной policy-модели

**1. Explicit-review-only semantics in Phase 0/1**

`🎯 10   🛡️ 10   🧠 3`

Примерный объём: `20-50` строк изменений

Суть:

- queue считает review обязательным только когда есть явный review state / review cycle signal
- completed task без active review не получает auto-routing в `assign_reviewer` только потому, что "в команде есть reviewer"

Почему это лучший вариант:

- не выдумывает policy, которой в runtime state сейчас нет
- минимизирует ложные lead action items

**2. Inference from free-form member roles**

`🎯 3   🛡️ 3   🧠 3`

Примерный объём: `20-40` строк изменений

Суть:

- пытаться читать `role` вроде `reviewer`, `qa`, `tech-lead` и решать, что completed task должна уйти в review

Риск:

- free-form role text не является надёжным policy contract
- легко получить false positives и странные queue jumps

**3. Introduce explicit review policy field later**

`🎯 8   🛡️ 9   🧠 7`

Примерный объём: `90-180` строк изменений

Суть:

- в будущем добавить machine-readable team/task review policy
- только тогда можно safely строить routing вроде `completed -> assign_reviewer` без explicit review event

Выбор:

- для Phase 0/1 брать **вариант 1**
- вариант 3 держать как possible future enhancement

### H. Какая roster resolution считается канонической для queue

**1. Controller-owned roster normalization for queue**

`🎯 8   🛡️ 9   🧠 5`

Примерный объём: `50-110` строк изменений

Суть:

- queue в controller layer использует controller-side roster resolver
- но этот resolver сначала доводится до **минимально достаточного** predictable contract:
  - removed members
  - lead alias normalization
  - suppression of phantom inbox-derived aliases where necessary
  - ignore qualified external recipients
  - ignore generated/internal pseudo-agent names, если они не пришли из explicit config/meta

Плюсы:

- queue остаётся рядом со своим runtime context
- не появляется cross-layer dependency на UI resolver

**2. Reuse UI `TeamMemberResolver` semantics indirectly**

`🎯 5   🛡️ 6   🧠 7`

Примерный объём: `90-170` строк изменений

Суть:

- пытаться тащить roster rules из main/UI слоя обратно в controller path

Риск:

- package boundary усложняется
- для ближайшего rollout это слишком тяжело

**3. Shared future roster package/helper**

`🎯 7   🛡️ 9   🧠 8`

Примерный объём: `120-220` строк изменений

Суть:

- вынести roster normalization в реально общий helper/package

Плюсы:

- меньше semantic drift в долгую

Минусы:

- для Phase 0/1 это уже дополнительный refactor

Выбор:

- в ближайшем rollout брать **вариант 1**
- но явно зафиксировать expected queue roster semantics тестами, чтобы drift от UI не был скрытым

### I. Где должен жить `lead_briefing` в MCP tool catalog

**1. Отдельная `lead` group с `teammateOperational: false`**

`🎯 10   🛡️ 10   🧠 4`

Примерный объём: `30-70` строк изменений

Суть:

- добавить отдельную tool group, например `lead`
- положить туда `lead_briefing`
- не смешивать этот tool с existing `task` group
- синхронно расширить `AgentTeamsMcpToolGroupId` в обеих локальных `.d.ts`

Почему это лучший вариант:

- текущий catalog already group-scoped, а не per-tool scoped
- это самый дешёвый способ гарантировать, что lead surface не попадёт в `AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOL_NAMES`
- semantics остаётся прозрачной: teammate task tools отдельно, lead-only tool отдельно

**2. Оставить `lead_briefing` в `task` group, но добавить per-tool denylist override**

`🎯 5   🛡️ 7   🧠 6`

Примерный объём: `40-90` строк изменений

Суть:

- сохраняем существующую `task` group
- поверх неё добавляем дополнительную per-tool политику, чтобы скрыть только `lead_briefing`

Риск:

- чинит symptom, а не модель
- делает catalog rules менее очевидными
- повышает шанс future drift между group semantics и effective availability

**3. Оставить `lead_briefing` в `task` group и полагаться только на prompts**

`🎯 2   🛡️ 2   🧠 1`

Примерный объём: `5-20` строк изменений

Суть:

- tool физически доступен тиммейтам
- просто стараемся не упоминать его в teammate prompts

Риск:

- это не access policy, а надежда на prompt discipline
- модель всё равно сможет брать лишний tool как shortcut
- именно так и рождается путаница "почему у меня есть lead queue"

Выбор:

- для rollout брать **вариант 1**
- отдельную per-tool policy layer обсуждать только если позже реально появятся mixed-access tools внутри одной semantic group

### J. Где должна жить semantics для filtered `task_list`

**1. Dedicated controller-owned inventory method с явным allowlisted output contract**

`🎯 9   🛡️ 10   🧠 5`

Примерный объём: `50-110` строк изменений

Суть:

- raw `tasks.listTasks()` остаётся raw/read helper
- для `task_list` вводится отдельный semantic owner:
  - либо public `tasks.listTaskInventory(filters?)`
  - либо internal controller helper с тем же смыслом, если public width хотят держать узкой
- output contract фиксируется как explicit inventory row allowlist, а не `slimTaskForList(...)` blocklist passthrough

Почему это лучший вариант:

- фильтры и payload-shaping живут рядом с controller-owned queue/inventory semantics
- не приходится тихо переопределять смысл старого raw `listTasks()`
- migration к компактному output становится явной и тестируемой

**2. Перегрузить существующий `tasks.listTasks(filters?)` и постепенно менять его смысл**

`🎯 5   🛡️ 6   🧠 4`

Примерный объём: `35-90` строк изменений

Суть:

- тот же метод начинает иногда означать raw list, а иногда filtered inventory

Риск:

- имя метода начинает врать о своей семантике
- выше шанс type/runtime drift и неожиданных побочных эффектов в existing callers

**3. Оставить controller raw, а фильтрацию и shape собирать прямо в MCP tool**

`🎯 4   🛡️ 5   🧠 3`

Примерный объём: `25-70` строк изменений

Суть:

- `task_list` MCP tool сам вызывает raw `tasks.listTasks()` + kanban/review helpers и строит filtered inventory локально

Риск:

- semantics inventory начинает жить вне controller
- MCP и другие consumers почти гарантированно начнут drift'ить

Выбор:

- брать **вариант 1**
- raw `tasks.listTasks()` не надо тихо превращать в semantic inventory API

### K. Как безопасно seed'ить lead-first tool access после появления `lead_briefing`

**1. Отдельный explicit lead bootstrap seed list**

`🎯 9   🛡️ 10   🧠 4`

Примерный объём: `25-70` строк изменений

Суть:

- не переиспользовать `AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES` как proxy для lead-first surfaces
- завести отдельный explicit список initial lead bootstrap tools
- включить туда `lead_briefing` и другие реально нужные first-turn lead surfaces

Почему это лучший вариант:

- lead bootstrap и teammate operational workflow - разные вещи
- появление lead-only tool больше не ломает initial permission seed path
- semantics разрешений становится явной, а не побочной

**2. Seed'ить лидеру все registered agent-teams tools**

`🎯 4   🛡️ 6   🧠 2`

Примерный объём: `10-30` строк изменений

Суть:

- чтобы не думать о разделении, лид получает сразу весь namespaced surface

Риск:

- слишком широкий blast radius по permissions
- теряется смысл role-scoped tool surfaces

**3. Ничего не seed'ить отдельно, положиться на runtime permission prompt**

`🎯 3   🛡️ 5   🧠 1`

Примерный объём: `5-15` строк изменений

Суть:

- `lead_briefing` может быть доступен, но первый вызов пройдёт через ad hoc permission flow

Риск:

- первый ход лида становится менее детерминированным
- prompt говорит "сначала вызови lead_briefing", а runtime может отвечать permission friction

Выбор:

- брать **вариант 1**
- bootstrap-critical lead surfaces не должны зависеть от teammate permission list случайно

### L. Как удержать agenda/inventory helpers internal при текущем `bindModule(...)`

**1. Вынести их в отдельный internal module, который controller не bind'ит**

`🎯 9   🛡️ 10   🧠 5`

Примерный объём: `40-100` строк изменений

Суть:

- agenda/inventory derivation живёт в отдельном internal helper module
- `tasks.js` импортирует его, но не ре-экспортирует целиком
- `createController()` не видит этот helper module как public API

Почему это лучший вариант:

- accidental public export risk исчезает по самой структуре кода
- проще держать public controller contract узким

**2. Оставить helpers в `tasks.js`, но не экспортировать их**

`🎯 8   🛡️ 8   🧠 3`

Примерный объём: `20-50` строк изменений

Суть:

- helpers остаются локальными функциями файла

Риск:

- работает, но `tasks.js` и так уже перегружен разными обязанностями
- выше шанс, что позже кто-то всё же экспортнет helper "для удобства"

**3. Экспортнуть helper из `tasks.js`, но считать его internal по договорённости**

`🎯 1   🛡️ 2   🧠 1`

Примерный объём: `5-15` строк изменений

Суть:

- helper появляется в `module.exports`, но мы просто стараемся не использовать его как public API

Риск:

- при текущем `bindModule(...)` это уже не internal helper, а реальный public controller method
- это прямой путь к silent surface creep и type drift

Выбор:

- брать **вариант 1**
- вариант 2 допустим только если хотят минимальный diff и готовы жёстко держать export discipline

### M. Как harden'ить lead bootstrap readiness для `lead_briefing`

**1. Role-aware required-tool preflight после wiring stabilization**

`🎯 9   🛡️ 10   🧠 5`

Примерный объём: `40-100` строк изменений

Суть:

- после того как `lead` group, registration path и permission seed уже стабилизированы
- добавляем role-aware preflight invariant:
  - teammate path требует `member_briefing`
  - lead path требует `lead_briefing`
- validation делается через тот же `tools/list` / `tools/call` style readiness check

Почему это лучший вариант:

- если prompt делает `lead_briefing` canonical first action, runtime тоже должен это уметь проверять
- исчезает класс багов "prompt уже требует tool, а launch path его ещё не гарантирует"

**2. Prompt-level canonical first call + explicit fallback until readiness proven**

`🎯 7   🛡️ 7   🧠 2`

Примерный объём: `15-40` строк изменений

Суть:

- lead prompt рекомендует `lead_briefing`
- но пока нет role-aware preflight, допускается fallback на inventory path при tool/permission failure

Риск:

- migration мягче, но менее детерминированна
- остаётся окно, где canonical surface ещё не является hard runtime invariant

**3. Ничего не проверять дополнительно и надеяться на registration/permissions**

`🎯 2   🛡️ 4   🧠 1`

Примерный объём: `5-15` строк изменений

Суть:

- считаем, что если tool зарегистрирован где-то в системе, этого достаточно

Риск:

- код уже показывает, что explicit MCP readiness gate сейчас существует только для `member_briefing`
- значит для lead path это просто wishful thinking, а не контракт

Выбор:

- брать **вариант 1**
- до его внедрения prompt не должен делать `lead_briefing` hard bootstrap blocker без fallback

### N. Где должен жить source of truth для lead bootstrap tool list

**1. Exported controller/package constant рядом с existing teammate constants**

`🎯 10   🛡️ 10   🧠 3`

Примерный объём: `20-50` строк изменений

Суть:

- если нужен lead bootstrap tool list, он живёт не локально в `TeamProvisioningService`
- а экспортируется из `mcpToolCatalog` рядом с:
  - `AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOL_NAMES`
  - `AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES`
- например как:
  - `AGENT_TEAMS_LEAD_BOOTSTRAP_TOOL_NAMES`
  - `AGENT_TEAMS_NAMESPACED_LEAD_BOOTSTRAP_TOOL_NAMES`

Почему это лучший вариант:

- bootstrap runtime не получает второй ручной список tool names
- catalog/permissions/prompts/tests смотрят в один и тот же source of truth
- migration для `lead_briefing` не размазывает naming policy по нескольким слоям

**2. Локальный список прямо в `TeamProvisioningService`**

`🎯 4   🛡️ 5   🧠 2`

Примерный объём: `10-30` строк изменений

Суть:

- просто прописать lead bootstrap tools строками в runtime service

Риск:

- это создаёт второй source of truth рядом с catalog
- при следующем tool rename или regrouping drift почти неизбежен

**3. Вычислять список динамически из `AGENT_TEAMS_MCP_TOOL_GROUPS` по эвристике**

`🎯 5   🛡️ 6   🧠 5`

Примерный объём: `20-60` строк изменений

Суть:

- runtime сам выводит lead bootstrap tools из group metadata или naming conventions

Риск:

- слишком неявно для bootstrap-critical path
- эвристика потом будет спорить с реальным prompt/runtime contract

Выбор:

- брать **вариант 1**
- bootstrap-critical tool lists должны экспортироваться явно, а не вычисляться по косвенным признакам

---

## 3.3 Decision Freeze For Phase 0/1

Чтобы rollout не расползся и агенты не получили смесь полу-готовых правил, для Phase 0/1 фиксируем жёсткие ограничения:

- per-task `kanban reviewer` не участвует в routing, пока write-path не начнёт реально его поддерживать
- `kanban.reviewers[]` трактуется только как reviewer pool / availability list, а не assignment на конкретную задачу
- clarification в routing contract живёт через explicit clear, а не через implicit "кто-то ответил"
- board lock в Phase 0 обязан покрыть controller agenda snapshot и multi-file board mutations, но не обязан сразу заменять все main-side raw readers
- queue roster использует controller-owned normalization c явно зафиксированными тестами, а не ad hoc смесь controller/UI эвристик
- `lead_briefing` в Phase 1 остаётся role-scoped surface без обязательного `leadName` параметра
- `lead_briefing` в catalog живёт в отдельной non-teammate-operational group, а не прячется внутри `task` group
- delivery уведомлений не входит в rollback boundary board-state mutation; board commit и message send надо разводить
- новая tool group не считается введённой, пока у неё нет явного registration path без duplicate registrations
- lead-first bootstrap не зависит только от teammate operational permission seed list
- source of truth для lead bootstrap tools экспортируется явно, а не живёт локальным списком в runtime service
- availability `lead_briefing` и permission seed для него трактуются как разные rollout concerns
- canonical first-turn `lead_briefing` не становится hard bootstrap invariant раньше, чем у lead path появляется явная readiness validation или безопасный fallback
- agenda/inventory helpers не утекают в public controller surface через случайный `module.exports`
- filtered `task_list` не должен вечно оставаться MCP-local blocklist wrapper над raw `tasks.listTasks()`
- generic board snapshot helper не становится public API, пока у него нет второго доказанного consumer

---

## 3.4 Concrete Migration Blockers Found In Code

Это не теоретические риски, а уже существующие места, которые диктуют rollout order.

### A. Lead prompt still teaches `task_list`

`🎯 10   🛡️ 10   🧠 2`

Факт из кода:

- `TeamProvisioningService` прямо содержит строку `List all tasks: task_list { teamName: "..." }`

Следствие:

- нельзя считать migration завершённым, пока lead prompt не будет переписан на `lead_briefing` как canonical first call
- одного нового MCP tool недостаточно
- member path сегодня жёстко валидирует именно `member_briefing`; lead path такого bootstrap gate пока не имеет
- поэтому у плана только 2 честных варианта:
  - либо `lead_briefing` сначала canonical recommendation with fallback
  - либо после stabilization wiring добавить явный lead-side preflight invariant
- prompt-only canonicalization без одного из этих двух путей здесь недостаточна

### B. Member path already anchors on `member_briefing` -> `task_briefing`

`🎯 10   🛡️ 10   🧠 2`

Факт из кода:

- member bootstrap сейчас жёстко валидирует наличие `member_briefing`
- member prompts уже учат использовать `task_briefing` как compact queue

Следствие:

- teammate migration почти не требует semantic renaming
- основной prompt migration blocker сейчас именно на lead path, а не на teammate path

### C. Current `task_briefing` renderer lives in `taskStore`

`🎯 9   🛡️ 9   🧠 4`

Факт из кода:

- `tasks.taskBriefing(...)` просто проксирует в `taskStore.formatTaskBriefing(...)`

Следствие:

- нельзя делать `lead_briefing` как второй независимый renderer рядом в store
- сначала нужен общий structured agenda DTO в controller-owned layer, и только потом два text renderer поверх него

### D. Local `.d.ts` shims already drift in concrete ways

`🎯 10   🛡️ 9   🧠 3`

Факт из кода:

- `src/types/agent-teams-controller.d.ts` и `mcp-server/src/agent-teams-controller.d.ts` уже расходятся не только "вообще", а по конкретным методам и формам
- примеры:
  - main shim не знает `tasks.memberBriefing(...)`
  - main shim не знает `tasks.getTaskComment(...)`
  - main shim не знает `review.startReview(...)`
  - main shim не знает `runtime`
  - `lookupMessage(...)` типизирован по-разному между shim файлами

Следствие:

- любой rollout нового agenda/helper surface обязан идти вместе с type-sync gate
- иначе документ будет обещать безопасную миграцию, а монорепа получит тихий type/runtime drift

### E. `lead_briefing` лучше, чем `lead_queue`, именно в Phase 1

`🎯 9   🛡️ 9   🧠 3`

Причина выбора:

- текущие briefing surfaces уже текстовые и хорошо ложатся в prompt workflow
- `lead_briefing` семантически ближе к уже существующим `member_briefing` и `task_briefing`
- JSON/queue-style surface можно добавить позже отдельным mode или отдельным tool, не мешая Phase 1 rollout

Итог:

- в Phase 1 canonical lead surface называем **`lead_briefing`**
- название `lead_queue` не используем как primary tool name в первой фазе

### F. Lead name inference still drifts from shared lead detection

`🎯 9   🛡️ 8   🧠 3`

Факт из кода:

- controller-side `inferLeadName(...)` ищет lead по ad hoc правилам и даже может упасть в `config.members[0]`
- shared `leadDetection` utilities живут по другому контракту и не должны тихо расходиться с queue semantics

Следствие:

- нельзя делать `lead_briefing` tool, который зависит от обязательного `leadName` input или от жёсткого "угадай одного lead actor" до того, как это выровнено
- role-scoped `lead_briefing` безопаснее, чем name-scoped surface

### G. Как `lead_briefing` должен резолвить lead identity

**1. Role-based lead surface without required `leadName` input**

`🎯 10   🛡️ 10   🧠 3`

Примерный объём: `20-40` строк изменений

Суть:

- `lead_briefing` - это role-scoped surface
- tool не требует `leadName`
- внутри response можно вернуть display header с каноническим lead name, если он надёжно резолвится, но routing не зависит от этого имени

Почему это лучший вариант:

- lead agenda одна на команду, а не на произвольного actor name
- не заставляет новый tool зависеть от слабого `inferLeadName(...)` как от hard requirement
- снижает шанс ложных ошибок из-за alias drift

Edge cases, которые этот выбор должен переживать без падения:

- в конфиге нет ни одного явно резолвимого lead candidate
- в конфиге несколько lead-like actors и single canonical name не выводится надёжно
- исторические task payload всё ещё содержат owner/reviewer alias `team-lead`

Во всех этих случаях:

- `lead_briefing` всё равно должен возвращать valid oversight queue
- допустим generic header уровня `Lead queue`
- ошибка из-за ambiguous lead identity здесь считается неправильным поведением Phase 1

**2. Require explicit `leadName` parameter**

`🎯 4   🛡️ 6   🧠 4`

Примерный объём: `20-50` строк изменений

Суть:

- сделать `lead_briefing(memberNameLikeLead)` по аналогии с `task_briefing(memberName)`

Риск:

- лишняя зависимость от prompt/runtime name correctness
- появится ещё один alias-sensitive contract там, где role-based surface и так достаточен

**3. Infer lead name hard and fail if ambiguous**

`🎯 5   🛡️ 7   🧠 5`

Примерный объём: `40-80` строк изменений

Суть:

- заставить tool сначала выбрать один canonical lead name и падать при малейшей ambiguity

Риск:

- создаёт лишний bootstrap blocker для surface, которому имя лида не нужно для core routing

Выбор:

- для Phase 1 брать **вариант 1**
- отдельную canonical lead-name cleanup делать независимо от самого `lead_briefing`

### H. Public API width in Phase 0/1

**1. Keep new snapshot/agenda helpers internal, expose only user-facing surfaces**

`🎯 9   🛡️ 10   🧠 3`

Примерный объём: `20-50` строк изменений

Суть:

- structured agenda DTO и board snapshot helper живут как internal controller implementation detail
- наружу в public controller/tool surface добавляются только:
  - `tasks.taskBriefing(...)`
  - `tasks.leadBriefing(...)`
  - расширенный `task_list(...)`

Почему это лучший вариант:

- минимальный public blast radius
- меньше type-shim drift
- проще Phase 0 acceptance и rollback

**2. Export generic `getBoardSnapshot(...)` immediately**

`🎯 5   🛡️ 7   🧠 5`

Примерный объём: `40-90` строк изменений

Риск:

- второй consumer для этого API ещё не доказан
- придётся сразу синхронно расширять runtime export surface и оба локальных `.d.ts` shims

**3. Export both generic snapshot helper and structured agenda DTO**

`🎯 3   🛡️ 5   🧠 6`

Примерный объём: `70-140` строк изменений

Риск:

- слишком раннее раскрытие внутреннего abstraction surface
- потом намного сложнее будет менять внутренний shape без downstream breakage

Выбор:

- для Phase 0/1 брать **вариант 1**

### I. `mcpToolCatalog` сейчас group-scoped и не умеет безопасно скрывать `lead_briefing` внутри `task`

`🎯 10   🛡️ 10   🧠 3`

Факт из кода:

- `AGENT_TEAMS_MCP_TOOL_GROUPS` определяет teammate visibility на уровне whole group через `teammateOperational`
- `task` group сейчас teammate-operational
- `lead_briefing`, если просто добавить его в `AGENT_TEAMS_TASK_TOOL_NAMES`, автоматически попадёт в `AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOL_NAMES`
- обе локальные `.d.ts` декларации сейчас знают только group ids:
  - `task`
  - `kanban`
  - `review`
  - `message`
  - `process`
  - `runtime`
  - `crossTeam`

Следствие:

- rollout `lead_briefing` должен включать не только новый tool, но и отдельное catalog решение
- safest Phase 1 choice:
  - новая `lead` group
  - `teammateOperational: false`
  - синхронное обновление обеих `AgentTeamsMcpToolGroupId` деклараций
- prompt migration без catalog migration здесь недостаточна

### J. Board lock в controller path ещё не существует как реальный board primitive

`🎯 10   🛡️ 9   🧠 4`

Факт из кода:

- task/kanban write paths сегодня не обёрнуты в общий board lock
- существующий `withFileLockSync(...)` живёт отдельно и используется не board path'ом, а cross-team inbox/outbox flow
- сам primitive синхронный, busy-wait и имеет фиксированные таймауты `5s` acquire / `30s` stale

Следствие:

- нельзя писать в плане просто "reuse existing lock" и считать, что board consistency уже почти есть
- нужен новый явный board contract:
  - один lock на team board scope
  - без silent unlocked fallback
  - без ложного обещания, что low-level writes уже сериализованы сами по себе

### K. `review_request` сейчас может оставить history/kanban drift при ошибке уведомления

`🎯 10   🛡️ 10   🧠 4`

Факт из кода:

- `review_request(...)` делает `kanban.set -> task.history/reviewState update -> message send`
- если `message send` падает, catch делает только `kanban.clear`
- уже записанный `review_requested` history event не откатывается

Следствие:

- Phase 0 не должен строиться на предположении, что текущий rollback у review flow transactionally чистый
- safest fix:
  - board mutation commit считать отдельной фазой
  - уведомления отправлять post-commit как best-effort side effect
  - queue semantics не должна зависеть от успеха inbox delivery

### L. Main-side compatibility helpers уже расходятся с queue-safe reviewer contract

`🎯 9   🛡️ 9   🧠 4`

Факт из кода:

- `TeamDataService.attachKanbanCompatibility(...)` берёт `reviewState` из persisted field
- `reviewer` там резолвится как `kanbanTaskState.reviewer ?? history(review_approved|review_started|review_requested)`

Следствие:

- agenda rollout нельзя строить через reuse этих compatibility semantics
- current-cycle queue resolver должен жить отдельно и явно
- если потом main/UI захочет тот же semantic surface, он должен звать официальный queue/inventory contract, а не копировать старую compatibility derivation

### M. У `task_list` ещё нет настоящего backing contract для filters

`🎯 10   🛡️ 9   🧠 3`

Факт из кода:

- MCP `task_list` сейчас делает только:
  - `controller.tasks.listTasks()`
  - `.map(slimTaskForList)`
- `ControllerTaskApi.listTasks()` типизирован без filters

Следствие:

- filters/limit для `task_list` требуют не только новую zod-схему в MCP tool
- нужно отдельно выбрать semantic owner:
  - dedicated controller inventory method
  - или internal controller inventory helper
- иначе filtered `task_list` получится полуручным MCP-side overlay без нормального contract owner

### N. Новая MCP group требует отдельного registration wiring, а не только catalog entry

`🎯 10   🛡️ 10   🧠 3`

Факт из кода:

- `mcp-server/src/tools/index.ts` строит registration через `REGISTRATION_BY_GROUP[group.id]`
- если добавить новый group id без этого map entry, `registerTools()` получит `undefined register`
- если наивно направить и `task`, и `lead` group на один и тот же `registerTaskTools`, легко получить duplicate registration того же tool set

Следствие:

- rollout новой `lead` group обязан синхронно решить registration strategy
- safest path:
  - либо отдельный `registerLeadTools`
  - либо другой явный one-time registration design без дублирования task tools
- одного изменения `mcpToolCatalog.js` здесь недостаточно

### O. Lead permission seed path сейчас завязан на teammate operational tool set

`🎯 10   🛡️ 9   🧠 3`

Факт из кода:

- `TeamProvisioningService` в lead bootstrap spec кладёт `permissionSeedTools` из `AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES`
- runtime suggestion expansion и teammate settings seeding тоже завязаны на этот же список
- этот permission seed path вообще активируется только когда `skipPermissions === false`
- при `skipPermissions !== false` launch идёт через `bypassPermissions`, и availability tool'а определяется registration/runtime wiring, а не seed list

Следствие:

- если `lead_briefing` уходит в новую non-teammate group, он не попадёт в lead bootstrap seed автоматически
- prompt может требовать `lead_briefing` как first call раньше, чем runtime permission path к нему стабилизирован
- rollout должен добавить отдельный lead-first seed contract, а не надеяться, что teammate list "и так почти подходит"
- при этом в плане надо различать 2 разных вопроса:
  - tool **available** at runtime
  - tool **pre-allowed/seeded** in permission-enabled mode
- смешивать availability и permission seeding в один пункт нельзя, иначе rollout обещает слишком много

### Q. MCP preflight readiness сейчас зафиксирован только для `member_briefing`

`🎯 10   🛡️ 9   🧠 3`

Факт из кода:

- `TeamProvisioningService` делает explicit `tools/list` + `tools/call` validation для `member_briefing`
- при отсутствии этого tool launch path падает как real bootstrap error
- аналогичного explicit readiness gate для `lead_briefing` сейчас нет

Следствие:

- если `lead_briefing` становится canonical first call, это пока ещё не равно hard-validated launch invariant
- Phase 1/1.5 должен выбрать один из честных путей:
  - добавить role-aware required-tool preflight
  - или сохранить explicit fallback до его появления
- нельзя писать в плане так, будто у lead path уже есть та же степень bootstrap гарантии, что и у teammate path

### R. Для lead bootstrap list сейчас нет exported constant, аналогичного teammate constant

`🎯 10   🛡️ 9   🧠 2`

Факт из кода:

- `mcpToolCatalog.js` экспортирует `AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES`
- `TeamProvisioningService` импортирует именно этот exported constant
- аналогичного exported constant для lead bootstrap surfaces сейчас нет

Следствие:

- если lead bootstrap tools выбрать правильно, их всё равно легко положить "временным локальным массивом" в runtime service
- это создаст новый source of truth рядом с catalog и tests
- safest path:
  - экспортировать dedicated lead bootstrap constants из controller package root
  - и уже их использовать в runtime/bootstrap wiring

### S. Unreadable task rows сейчас silently выпадают из raw reader

`🎯 9   🛡️ 9   🧠 4`

Факт из кода:

- `taskStore.listRawTasks(...)` обходит все task JSON files
- при `normalizeTask(...)` error такая строка просто пропускается
- это значит, что malformed task row может исчезнуть из list-based views без явного сигнала

Следствие:

- derived queue не должна inherit'ить semantics "если задача не читается, притворимся, что её нет"
- особенно опасно это для lead surface, потому что board corruption превращается в silent omission
- safest Phase 0 path:
  - queue-grade snapshot builder собирает `anomalies[]`
  - `lead_briefing` поднимает такие случаи как repair bucket / warning summary
  - `task_briefing` не делает вид, что board чист, если snapshot уже увидел unreadable rows

### P. `createController()` автоматически публикует весь `module.exports` bound module'а

`🎯 10   🛡️ 10   🧠 3`

Факт из кода:

- `controller.js` делает `bindModule(context, tasks)` поверх всего `module.exports` из `internal/tasks.js`
- значит любой новый export из `tasks.js` автоматически становится method на `controller.tasks`

Следствие:

- internal agenda/inventory helpers нельзя просто "временно экспортнуть" из `tasks.js`
- иначе public controller surface начнёт расползаться почти случайно
- safest path:
  - отдельный internal helper module
  - или local non-exported functions в `tasks.js`

---

## 4. Что не является целью

- не строим в Phase 1 полноценный event-sourced board engine
- не переносим source of truth в отдельный projection-файл
- не делаем сложный real-time delta protocol с первой итерации
- не пытаемся заменить `task_get` подробной очередью
- не делаем `task_list` основным рабочим API для тиммейта

---

## 5. Рассмотренные варианты

### Вариант 1. Derived agenda on read + team lock + role queues

`🎯 10   🛡️ 10   🧠 6`

Примерный объём: `250-420` строк изменений

Суть:

- не создаём persisted projection как новый durable слой
- строим derived queue прямо во время чтения
- читаем raw task/review/kanban состояние под общим team-level lock
- делаем канонические queue surfaces для лида и участника
- `task_list` превращаем в filtered inventory

Плюсы:

- минимальный риск двойного source of truth
- проще доказать корректность
- быстрее rollout
- меньше шансов получить stale queue

Минусы:

- нет built-in delta sync с первого дня
- каждое queue чтение требует пересчёта

### Вариант 2. Persisted projection sidecar с первого дня

`🎯 8   🛡️ 7   🧠 6`

Примерный объём: `320-520` строк изменений

Суть:

- при каждом mutation пересчитывать и сохранять projection-файл рядом с board state

Плюсы:

- быстрые чтения
- удобная база для future delta

Минусы:

- второй durable слой
- выше риск расхождения raw state и projection
- нужно аккуратно закрывать partial write / multi-file atomicity

### Вариант 3. Сразу agenda + delta + persisted projection

`🎯 6   🛡️ 5   🧠 8`

Примерный объём: `450-750` строк изменений

Суть:

- сразу строить полноценный snapshot/revision/delta протокол

Плюсы:

- самая "умная" архитектура на бумаге

Минусы:

- это лучший способ слишком рано усложнить систему
- высокий риск словить subtle bugs в очередях
- большая цена ошибок, потому что именно queue tool влияет на поведение агентов

### Выбор

Выбираем **Вариант 1 как Phase 1**, а delta/revision переносим в **Phase 2**.

Это даёт правильную последовательность:

1. сначала стабилизируем семантику и ownership
2. потом оптимизируем транспорт и payload

---

## 6. Архитектурный принцип

Правильный порядок слоёв такой:

1. **Raw source of truth**
   - task files
   - kanban-state
   - review history / reviewState

2. **Derived decision layer**
   - `actionOwner`
   - `nextAction`
   - `queueCategory`
   - `watchers`
   - `reasonCode`

3. **Role-based queue surfaces**
   - teammate agenda
   - lead agenda via `lead_briefing`

4. **Inventory/search surface**
   - filtered `task_list`

5. **Full-detail surface**
   - `task_get`

⚠️ Важно: политика работы должна жить в layer 2, а не в голове LLM.

---

## 7. Канонические tool surfaces

### 7.1 `member_briefing`

Назначение:

- identity
- роль
- рабочие правила
- как пользоваться board tooling

Не должно включать:

- полный живой список задач
- большие live queue payload

Причина:

- bootstrap-инструмент не должен разрастаться вместе с board state
- иначе он станет одновременно и prompt bootstrap, и live queue, и будет быстро протухать

### 7.2 `task_briefing`

Назначение:

- каноническая compact operational queue для конкретного участника

Новый смысл:

- не просто "мои assigned tasks"
- а "что мне сейчас делать и что мне важно знать"

Структура ответа:

- identity / actor
- `actionable`
- `awareness`
- компактные counters
- `revision` в future phase

⚠️ Важное уточнение после code review:

- в текущем runtime `task_briefing` возвращает текст, а не JSON
- поэтому safest Phase 0/1 path такой:
  - внутри строим **structured agenda DTO**
  - наружу по-прежнему рендерим компактный текст для совместимости
  - JSON-variant можно добавлять позже как отдельный surface или новый output mode

Так мы не блокируем future delta/revision, но и не делаем лишний breaking change в самом начале.

Exact Phase 1 contract:

- input:
  - `teamName`
  - `memberName` - обязателен
- output:
  - text briefing
- semantics:
  - actor-specific
  - primary teammate operational surface
  - built from internal structured agenda DTO, а не напрямую из legacy formatter logic

Дополнительное архитектурное правило:

- `taskStore.formatTaskBriefing(...)` в нынешнем виде не должен становиться permanent semantic owner новой agenda logic
- правильный direction такой:
  - controller-owned structured agenda DTO
  - текстовый renderer для `task_briefing`
  - текстовый renderer для `lead_briefing`

### 7.3 `lead_briefing`

Нужен отдельный lead surface.

Выбор имени для Phase 1:

- canonical tool name: `lead_briefing`

Почему не `lead_queue`:

- текущие briefings уже текстовые
- prompt ecosystem уже заточен на human-readable briefing surfaces
- это уменьшает объём breaking changes в MCP descriptions и lead prompts
- future structured/JSON variant можно добавить позже без конфликта имён

Почему не надо использовать raw `task_list` как lead queue:

- лид тоже не должен разгребать весь inventory каждый ход
- lead queue должна показывать именно:
  - unassigned
  - reviewer missing
  - clarification needed
  - dependency repair
  - review routing anomalies
  - waiting on user
  - aggregate board pressure

Рекомендация по rollout:

- вводим новый lead-specific surface отдельно
- в первой фазе это именно `lead_briefing`, а не новый JSON queue contract
- только после этого перестаём учить lead использовать `task_list` как first stop
- не делаем silent redefinition `task_list` в тот же самый момент

Exact Phase 1 contract:

- input:
  - `teamName`
  - без обязательного `leadName`
- controller contract:
  - `tasks.leadBriefing(): Promise<string>`
- MCP contract:
  - `lead_briefing { teamName, claudeDir? }`
- output:
  - text briefing
- semantics:
  - role-scoped lead operational surface
  - не зависит от точного caller alias
  - может отображать resolved lead name в header, но routing не должен зависеть от него
- ambiguity handling:
  - unique lead name найден -> можно показать его в header
  - unique lead name не найден -> вернуть generic `Lead queue` header без ошибки
- catalog placement:
  - отдельная `lead` group
  - `teammateOperational: false`
  - `lead_briefing` не должен попадать в `AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOL_NAMES`

### 7.3.1 Bootstrap sequencing for `lead_briefing`

Здесь нельзя делать rollout "в любом порядке".

Безопасная последовательность такая:

1. сначала зарегистрировать `lead_briefing` как отдельный tool surface:
   - новая `lead` group
   - явный registration path в `mcp-server/src/tools/index.ts`
   - синхронные `.d.ts` updates
2. потом экспортировать отдельный lead bootstrap tool list рядом с teammate constants
3. потом wired'ить lead permission seed path для режима, где `skipPermissions === false`
4. потом выбрать один честный runtime contract для first-turn availability:
   - либо role-aware preflight hard-check
   - либо явный documented fallback
5. только после этого переписывать lead prompt так, чтобы `lead_briefing` был canonical first action

No-go rule:

- нельзя сначала написать в lead prompt "сначала вызови `lead_briefing`", а потом уже разбираться, видит ли его runtime вообще
- нельзя считать `bypassPermissions` mode доказательством того, что отдельный lead bootstrap path не нужен
- availability, registration и permission seeding - это три разных слоя rollout

### 7.4 `task_list`

Новая роль:

- filtered inventory/search
- fallback browse tool
- не основной operational queue

Желаемое поведение:

- additive filters только по стабильным dimension'ам:
  - `owner`
  - `status`
  - `reviewState`
  - `kanbanColumn`
  - `relatedTo`
  - `blockedBy`
  - `limit`
- для routine workflow агентам в prompt рекомендуем не `task_list`, а `task_briefing`

Что сознательно **не** добавляем в первой фазе:

- `member` filter
- `reviewer` filter

Причина:

- `member` слишком двусмысленный: owner, actionOwner, watcher или просто "как-то связан"
- `reviewer` в текущем runtime не является стабильным raw inventory field
- actor-centric queries должны идти через `task_briefing` и `lead_briefing`, а не через перегруженный `task_list`

Уточнение по фильтрам:

- `status` фильтрует raw `task.status`
- `reviewState` фильтрует effective review state
- `kanbanColumn` в первой фазе допустим только как alias для review overlay columns:
  - `review`
  - `approved`
- не надо вводить generic `column=todo|in_progress|done`, будто inventory layer уже знает full kanban model для всех задач
- `relatedTo` и `blockedBy` должны принимать обычный task ref в том же формате, что и `task_get` / `resolveTaskRef`

Правила фильтрации:

- фильтры conjunctive, а не "любой из"
- `limit` применяется после фильтрации
- отсутствие фильтров сохраняет совместимую unfiltered semantics
- filtered `task_list` не сортирует по agenda-priority и не подменяет `actionOwner`
- output остаётся slim inventory JSON, а не agenda DTO
- если filter требует kanban knowledge (`reviewState`, `kanbanColumn`), он реализуется в controller-owned inventory layer, а не через raw `taskStore.listTasks()` напрямую

Exact Phase 1 MCP contract:

- `task_list { teamName, claudeDir?, owner?, status?, reviewState?, kanbanColumn?, relatedTo?, blockedBy?, limit? }`

Exact backing rule:

- raw `tasks.listTasks()` не надо тихо переопределять как filtered inventory API
- safest path:
  - dedicated controller inventory contract
  - или internal controller-owned inventory helper, который является semantic owner для MCP tool
- MCP layer не должен сам становиться permanent owner review/kanban-aware filtering logic

Output-shape migration rule:

- текущий `slimTaskForList(...)` blocklist-подход приемлем только как legacy compatibility starting point
- целевой compact contract для `task_list` должен быть explicit allowlist inventory row
- migration на allowlist делается явно и с contract tests, а не тихо "когда-нибудь потом"

Public-surface rule for Phase 0/1:

- `task_briefing`
- `lead_briefing`
- `task_list`

это public MCP/controller surfaces.

А вот:

- structured agenda DTO
- generic board snapshot helper

остаются internal implementation details, пока у них не появится второй доказанный consumer.

### 7.4.1 Target inventory row for `task_list`

Чтобы migration away from blocklist была однозначной, у `task_list` нужен целевой public row contract уже в плане.

Target V1 row:

```ts
type TaskInventoryRow = {
  id: string;
  displayId: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  owner?: string;
  reviewState: 'none' | 'review' | 'needsFix' | 'approved';
  needsClarification?: 'lead' | 'user';
  blockedBy?: string[];
  blocks?: string[];
  related?: string[];
  commentCount: number;
  createdAt?: string;
  updatedAt?: string;
};
```

Важно:

- здесь `reviewState` - это effective inventory review state, а не слепой passthrough сырого `task.reviewState`
- inventory row deliberately не включает:
  - `comments`
  - `historyEvents`
  - `workIntervals`
  - `attachments`
  - `prompt`
  - `sourceMessage`
  - произвольные future fields по blocklist-инерции
- allowlist должен быть закрытым и тестируемым
- если позже реально понадобится ещё одно поле, его добавляют осознанно через contract change, а не "оно само просочилось"

Уточнение по migration safety:

- в раннем rollout лучше сначала добавить фильтры и новый `lead_briefing`
- а default unfiltered semantics `task_list` оставить совместимой, пока prompts и callers не переедут
- teammate catalog можно урезать раньше, чем глобально менять meaning самого инструмента

### 7.5 `task_get`

Роль остаётся прежней:

- полный контекст одной конкретной задачи
- history/comments/dependencies/files/clarifications

Новая практика:

- queue surface выдаёт компактные карточки и ссылки на task ids
- детали читаются через `task_get`

---

## 8. Derived read model

### 8.1 Raw входы

Derived layer должен смотреть на:

- `task.status`
- `task.owner`
- `task.dependencies`
- `task.reviewState`
- history events по review / status / clarification
- kanban column
- reviewer pool availability
- runtime identity actor
- queue roster snapshot

### 8.1.1 History-derived vs field-derived signals

Это важное уточнение после code review.

Не все workflow-сигналы в текущей системе одинаково "историчны":

- **history-derived**
  - review state
  - review cycle transitions
  - work status transitions
- **field-derived**
  - current owner
  - current `needsClarification`
  - current dependency lists
  - current related links

Практическое следствие:

- review resolver можно и нужно строить на `historyEvents`
- owner/clarification resolver нельзя делать так, будто у него такой же append-only history contract внутри task JSON
- task logs и transcript activity могут быть полезны для диагностики, но не должны становиться required input для queue derivation в Phase 0/1
- actor identity normalization обязательна:
  - реальное имя лида
  - `team-lead`
  должны считаться одним logical actor там, где речь идёт о valid ownership/reply semantics
- roster validity должна проверяться по одной канонической queue-side нормализации, а не по смешению controller и UI resolver heuristics

Ещё одно важное следствие:

- queue semantics и stall-monitor semantics не обязаны совпадать 1-в-1
- для queue review может быть actionable уже с `review_requested`
- для stall-monitor "started review" может начинаться только с `review_started`

Это не конфликт, а разные вопросы:

- queue отвечает "кто должен сделать следующий шаг"
- stall-monitor отвечает "есть ли доказательство, что review реально начали"

### 8.1.2 Hard exclusions for Phase 0/1

Чтобы derived queue не строилась на сигналах, которые код сегодня не поддерживает как надёжные:

- не используем `kanban-state.tasks[taskId].reviewer` для routing
- не используем `kanban.reviewers[]` как assignment конкретного reviewer
- не используем task logs / transcript activity как required input
- не выводим mandatory review из free-form role текста вроде `reviewer`, `qa`, `tech-lead`

### 8.1.3 Signal trust matrix

Важное правило: derived queue не "усредняет" все сигналы. У каждого сигнала должен быть свой trust level.

| Signal | Role in queue | Trust level in Phase 0/1 |
| --- | --- | --- |
| `historyEvents.review_*` текущего цикла | active review routing | authoritative |
| `task.reviewState` | fallback review signal | advisory fallback |
| `kanban-state.tasks[taskId].column` | overlay hint for review/approved | advisory fallback |
| `task.owner` | current accountable implementer | authoritative after roster normalization |
| `task.needsClarification` | current wait reason | authoritative after explicit-clear hardening |
| `task.blockedBy` / `blocks` / `related` | current dependency graph | authoritative but target refs must be revalidated |
| `kanban.reviewers[]` | reviewer pool / candidate set | advisory only, never per-task routing |
| `kanban-state.tasks[taskId].reviewer` | per-task reviewer | forbidden for routing in Phase 0/1 |
| task logs / transcript activity | diagnostics | debug-only |

Практическое правило:

- если два сигнала противоречат друг другу, выигрывает более trusted source
- weaker signal можно использовать только как fallback, но не как "доказательство против" stronger signal

### 8.1.4 Conflict resolution when sources disagree

Ниже не просто примеры, а конкретные implementation guardrails:

| Conflict | Winner | Why |
| --- | --- | --- |
| `historyEvents` говорит, что review активен, а `task.reviewState === none` | history | review cycle уже durable в истории |
| `review_approved` или `review_changes_requested` уже записан, но kanban всё ещё выглядит как `review` | history | stale kanban overlay не должен держать review открытым |
| `task.reviewState === review`, но current-cycle reviewer не резолвится | lead `assign_reviewer` | open review без валидного reviewer хуже, чем false confident routing |
| `needsClarification` выставлен и одновременно есть owner/reviewer routing | clarification | вопрос/блокер сильнее обычного execution flow |
| owner невалиден, но review reviewer валиден | lead `assign_owner` | потерян accountable owner, Phase 0/1 чинит ownership раньше обычного routing |
| `requestReview` durable commit прошёл, а notification send упал | committed board state | queue truth не должна зависеть от доставки сообщения |

Дополнительный guardrail:

- derived queue не пытается "склеивать" conflicting truth из `task.reviewState` и `kanban` в новый synthetic state
- если resolver не может безопасно доказать ownership/reviewer path, он обязан деградировать в lead repair bucket

### 8.2 Derived поля

Минимальный набор:

```ts
type DerivedActionOwner =
  | { kind: 'member'; memberName: string }
  | { kind: 'lead' }
  | { kind: 'user' }
  | { kind: 'none' };

type DerivedNextAction =
  | 'execute'
  | 'review'
  | 'apply_changes'
  | 'assign_owner'
  | 'assign_reviewer'
  | 'clarify_with_user'
  | 'clarify_with_lead'
  | 'repair_dependencies'
  | 'wait_dependency'
  | 'wait_review'
  | 'none';

type DerivedQueueCategory = 'actionable' | 'waiting' | 'oversight' | 'done';
```

### 8.2.1 Minimal internal agenda DTO for Phase 0/1

Чтобы text renderers не собирали семантику каждый по-своему, у внутреннего DTO должен быть один минимальный контракт:

```ts
type AgendaItem = {
  taskId: string;
  displayId: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  reviewState: 'none' | 'review' | 'needsFix' | 'approved';
  actionOwner: DerivedActionOwner;
  nextAction: DerivedNextAction;
  queueCategory: DerivedQueueCategory;
  reasonCode: string;
  owner?: string;
  reviewer?: string | null;
  blockedBy?: string[];
  watchers?: string[];
  needsClarification?: 'lead' | 'user';
  lastMeaningfulEventAt?: string;
  derivedFrom?: string[];
};

type AgendaAnomaly = {
  code:
    | 'unreadable_task'
    | 'invalid_dependency_ref'
    | 'invalid_owner_ref'
    | 'invalid_reviewer_ref';
  detail: string;
  taskId?: string;
};

type AgendaSnapshot = {
  actor:
    | { kind: 'member'; memberName: string }
    | { kind: 'lead' };
  actionable: AgendaItem[];
  awareness: AgendaItem[];
  anomalies: AgendaAnomaly[];
  counters: {
    actionable: number;
    awareness: number;
    blocked: number;
    waitingOnUser: number;
    waitingOnLead: number;
    reviewNeeded: number;
    anomalies: number;
  };
};
```

Важно:

- это internal contract для derivation + rendering
- `task_briefing` и `lead_briefing` рендерятся из него
- `task_list` из него не рендерится и не обязан совпадать с ним по shape

Дополнительно полезно:

- `reasonCode`
- `watchers`
- `relatedMemberNames`
- `blockedBy`
- `reviewer`
- `lastMeaningfulEventAt`
- `derivedFrom`

Где `derivedFrom` - это внутренний debug/verification след:

- `history_review_requested`
- `history_review_started`
- `kanban_state`
- `clarification_flag`
- `dependency_graph`
- `owner_status`

Он не обязателен в финальном публичном payload, но сильно помогает тестировать resolver и объяснять спорные queue decisions.

Ограничение по `lastMeaningfulEventAt`:

- это поле нельзя делать опорой для routing
- его можно использовать для sorting / summaries / tie-breaks

Причина:

- часть важных изменений живёт только в current task fields и `updatedAt`
- а не в полноценном append-only workflow event stream

### 8.2.2 `reasonCode` should use a closed v1 taxonomy

Если `reasonCode` оставить "любой строкой", resolver и renderer очень быстро начнут drift'ить.

Минимальный закрытый v1 набор лучше зафиксировать сразу:

- `waiting_user_clarification`
- `waiting_lead_clarification`
- `owner_missing`
- `owner_invalid`
- `review_reviewer_missing`
- `review_requested_waiting_pickup`
- `review_in_progress`
- `dependency_broken`
- `dependency_waiting`
- `needs_fix`
- `owner_executing`
- `owner_ready`
- `completed_no_followup`
- `terminal_approved`
- `terminal_deleted`
- `anomaly_unreadable_task`

Это не значит, что список никогда не расширится.

Это значит:

- расширение должно быть явным
- snapshot tests и text renderers должны работать от одной allowlist reason codes
- новая строка reasonCode считается contract change, а не случайной внутренней деталью

### 8.3 Что такое `actionOwner`

`actionOwner` - это **один primary actor**, который должен сделать следующий meaningful workflow шаг.

Это не:

- просто owner
- просто reviewer
- просто последний писавший комментарий

Это именно ответ на вопрос:

> кто сейчас должен сдвинуть задачу вперёд

### 8.4 Что такое `watchers`

`watchers` - это **не primary routing**, а вспомогательная visibility-модель.

Их роль:

- awareness
- summaries
- future notifications
- optional context in lead queue

Их нельзя использовать как главный способ строить operational queue, иначе лид или участник снова начнут видеть почти всё подряд.

---

## 9. Базовый precedence для `actionOwner`

Ниже канонический порядок принятия решения. Более раннее правило сильнее позднего.

### 9.1 Terminal

Если задача:

- deleted
- approved
- окончательно завершена без ожидаемого follow-up

Тогда:

- `actionOwner = none`
- `nextAction = none`
- в operational queue не попадает
- остаётся доступной через inventory/search

### 9.2 Clarification from user

Если задача явно ждёт ответа от пользователя:

- `actionOwner = user`
- `nextAction = clarify_with_user`
- лид получает oversight item
- owner получает awareness item, если задача его

### 9.3 Clarification from lead

Если задача ждёт решения/уточнения от лида:

- `actionOwner = lead`
- `nextAction = clarify_with_lead`

Phase 0 guardrail:

- пока clarification semantics стабилизированы через explicit clear, комментарий лида сам по себе не считается достаточным для снятия wait-state
- это сознательная консервативность: лучше лишний lead oversight item, чем скрытый неочищенный blocker

### 9.4 Invalid owner

Если owner отсутствует, пустой, удалён или не резолвится в roster:

- `actionOwner = lead`
- `nextAction = assign_owner`

Уточнение:

- `owner === "team-lead"` нельзя автоматически считать invalid
- alias `team-lead` и canonical lead name должны проходить через одну lead-normalization логику

### 9.5 Review requested, reviewer unresolved

Если задача ушла в review, но reviewer не удалось надёжно определить:

- `actionOwner = lead`
- `nextAction = assign_reviewer`

### 9.6 Review requested, reviewer resolved

Если review активен и reviewer валиден:

- `actionOwner = member(reviewer)`
- `nextAction = review`
- owner получает awareness item `wait_review`

Дополнительная проверка валидности reviewer обязательна:

- если reviewer помечен как removed member
- или reviewer больше не резолвится в текущий roster

то задача должна деградировать в:

- `actionOwner = lead`
- `nextAction = assign_reviewer`

Уточнение:

- reviewer нельзя выводить только из `kanban-state.reviewers[0]` как будто это стабильное назначение на конкретную задачу
- для queue нужен отдельный resolver активного reviewer именно для **текущего review cycle**
- safest precedence:
  - latest `review_started.actor` внутри текущего review cycle
  - latest `review_request.reviewer` внутри текущего review cycle
  - иначе unresolved -> `assign_reviewer`

Здесь есть важное ужесточение после повторного code review:

- в Phase 0/1 **не надо** делать fallback в `kanban-state.tasks[taskId].reviewer`
- текущие write-path на входе в review всё равно пишут туда `null`
- значит такой fallback только создаст ложное ощущение надёжности, но не даст реальной пользы

Практическая реализация должна быть совместима с уже существующей history-based derivation review state:

```ts
function resolveCurrentCycleReviewer(task, validMembers) {
  const events = [...(task.historyEvents ?? [])];

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];

    if (event.type === 'review_started' && isValidQueueMember(event.actor, validMembers)) {
      return { reviewer: event.actor, source: 'history_review_started_actor' };
    }

    if (
      event.type === 'review_requested' &&
      isValidQueueMember(event.reviewer, validMembers)
    ) {
      return { reviewer: event.reviewer, source: 'history_review_requested_reviewer' };
    }

    if (event.type === 'review_approved' || event.type === 'review_changes_requested') {
      break;
    }

    if (event.type === 'status_changed' && event.to === 'in_progress') {
      break;
    }

    if (event.type === 'task_created') {
      break;
    }
  }

  return { reviewer: null, source: 'none' };
}
```

Консервативное правило:

- если resolver сомневается, задача идёт в lead queue как `assign_reviewer`
- лучше false positive в lead queue, чем false confident routing на не того reviewer

И ещё один важный guardrail:

- даже если в `kanban-state` schema есть поле `reviewer`, Phase 0/1 не должны считать его canonical signal
- пока официальный mutation surface не поддерживает reviewer как стабильно обновляемое per-task поле, history-first resolver остаётся единственно правильной базой

Дополнительные edge rules:

- если `review_started.actor` и `review_requested.reviewer` расходятся, выигрывает `review_started.actor` как более сильное доказательство того, кто реально взял review
- если reviewer совпадает с owner, queue не пытается "исправить" это сама - self-review сегодня не запрещён runtime-контрактом, значит это отдельная policy-задача, а не routing-эвристика
- если последний `review_requested.reviewer` или `review_started.actor` больше не проходит queue roster normalization, routing деградирует в `assign_reviewer`, а не в попытку взять "первого доступного reviewer из пула"

### 9.7 Broken dependencies

Если есть dependency на несуществующую, deleted или испорченную задачу:

- не делаем auto-unblock
- `actionOwner = lead`
- `nextAction = repair_dependencies`

### 9.8 Healthy blocking dependency

Если задача блокируется живой dependency:

- `actionOwner = none`
- `nextAction = wait_dependency`
- owner получает awareness
- лид может видеть это только в aggregate summary или при stall/escalation

### 9.9 Needs fixes after review

Если был `review_request_changes` или equivalent state:

- `actionOwner = member(owner)`
- `nextAction = apply_changes`

### 9.10 In progress

Если задача реально исполняется и ничего выше не сработало:

- `actionOwner = member(owner)`
- `nextAction = execute`

### 9.11 Pending with owner

Если задача pending и готова к работе:

- `actionOwner = member(owner)`
- `nextAction = execute`

### 9.12 Completed without active review

Если задача completed, reviewer не нужен или ещё не инициирован:

- в Phase 0/1 по умолчанию `actionOwner = none`
- completed task не должна автоматически превращаться в `assign_reviewer` только из-за reviewer pool или free-form reviewer role в команде

Важно:

- пока в системе нет explicit machine-readable review policy, queue не должна придумывать обязательность review из эвристик
- review routing начинается только с явного review signal:
  - `review_requested`
  - `review_started`
  - `reviewState === review`
  - future explicit review policy field, если он когда-то появится

---

## 10. Критические edge cases

### 10.1 Self-review

Если `reviewer === owner`, это плохой routing.

Правильное поведение:

- не давать такой задаче стать нормальной review-card для owner
- отправлять её в lead queue как `assign_reviewer`
- reasonCode: `self_review_invalid`

### 10.2 Несколько reviewers

Если когда-то появится multi-review:

- Phase 1 не должен пытаться распределить actionOwner между несколькими людьми
- если активных reviewers > 1, это lead attention item, пока не появится формальная multi-review модель

Иначе будет неочевидный primary owner.

### 10.3 Missing reviewer после `review_request`

Даже если текущий runtime допускает `review_request` без reviewer, queue layer не должен делать вид, что всё нормально.

Правильное поведение:

- lead action item
- не "висит у owner"
- не "висит ни у кого без объяснения"

### 10.3.1 Previous review cycle bleed-through

Отдельный риск:

- если reviewer выводится из history слишком грубо, можно случайно подтянуть reviewer из предыдущего review cycle

Поэтому queue resolver должен быть cycle-aware:

- смотреть на последние review events
- учитывать reset после возврата задачи в `in_progress` / нового рабочего цикла
- не использовать старого approver как текущего reviewer только потому, что это последнее известное review-событие

### 10.3.2 Review requested but not started yet

Это отдельный важный sub-state.

Если:

- review уже request'нут
- reviewer валиден
- но `review_started` ещё не было

то для queue это всё равно reviewer-owned actionable item:

- `actionOwner = member(reviewer)`
- `nextAction = review`
- `reasonCode` стоит различать, например `review_requested_waiting_pickup`

Но при этом нельзя механически переносить сюда stall-monitor semantics:

- для stall policy review окно может считаться ещё не "started"
- для queue reviewer уже является тем, кто должен сделать следующий шаг

### 10.4 Missing/deleted dependency

Это не wait-state. Это broken workflow.

Правильное поведение:

- лид получает repair item
- owner не должен автоматически считать задачу разблокированной

### 10.5 Комментарий на completed/review/approved задаче

Новый комментарий сам по себе не меняет `actionOwner`.

Иначе будут ложные reopening-сигналы.

Комментарий может:

- обновить `lastMeaningfulEventAt`
- появиться в awareness

Но не должен автоматически переводить задачу в actionable queue другого актёра.

### 10.6 Owner changed mid-review

Если owner поменяли, пока review активен:

- actionOwner остаётся reviewer, пока review открыт
- новый owner видит awareness
- после `review_request_changes` или `review_approve` уже действует обычная пост-review логика

### 10.6.1 Removed member as owner/reviewer

Если owner или reviewer указывает на участника, который уже в `removedNames`:

- queue не должна считать такого actor valid action owner
- это не waiting state, а routing repair case

Правильное поведение:

- removed owner -> lead queue `assign_owner`
- removed reviewer -> lead queue `assign_reviewer`

Причина:

- `resolveTeamMembers(...)` уже умеет исключать removed members из активного roster
- значит derived agenda должна использовать ту же реальность, а не слепо верить старому имени в task field/history

### 10.7 Runtime identity не определился

После code review это не такой большой риск для `task_briefing`, как казалось сначала, потому что текущий MCP tool уже требует явный `memberName`.

Поэтому правильная формулировка такая:

- для `task_briefing` ambiguity runtime identity не должна быть primary problem
- для `member_briefing` fallback по runtime identity остаётся полезным bootstrap-path
- если появится future tool без явного `memberName`, он уже не должен молча опираться на неуверенную runtime identity

Если system не смогла надёжно вывести `memberName` там, где identity всё же нужна:

- queue tool не должен молча вернуть `No tasks`
- нужно:
  - либо требовать `memberName`
  - либо возвращать явную ошибку identity resolution

Тихой пустой очереди быть не должно.

### 10.8 Внешние записи мимо controller

Если кто-то пишет в raw файлы вне контроллера:

- derived read path всё равно должен уметь читать tolerant snapshot
- но team-level lock гарантирует consistency только для controller-driven mutations

Это важно явно зафиксировать, чтобы не переоценить силу lock.

### 10.9 Race при multi-file update

Самый опасный баг в этой зоне:

- reader увидел уже обновлённый task
- но ещё старый kanban/review state

или наоборот.

Именно поэтому Phase 1 лучше строить вокруг:

- общего mutation coordination
- общего snapshot чтения под одним team-level lock

### 10.10 Unreadable / corrupt task row

Это отдельный failure mode, который нельзя трактовать как "задачи просто нет".

Если queue-grade reader не может нормализовать task row:

- snapshot builder должен записать anomaly
- `lead_briefing` должен показать repair/warning signal
- `task_briefing` не должен молча превращать board problem в "No tasks"

Важное уточнение:

- tolerant snapshot допустим
- silent omission - нет

Самая опасная версия бага здесь такая:

- damaged task исчезает из inventory
- никто не видит, что board уже частично испорчен
- derived queue выглядит "чище", чем реальное состояние команды

---

## 11. Как должны выглядеть очереди

### 11.1 Очередь участника

Участник должен получать не "все свои задачи", а такой shape:

```json
{
  "actor": { "kind": "member", "memberName": "alice" },
  "actionable": [
    {
      "taskId": "task-12",
      "displayId": "12",
      "subject": "Implement sync retries",
      "actionOwner": { "kind": "member", "memberName": "alice" },
      "nextAction": "execute",
      "queueCategory": "actionable",
      "reasonCode": "owner_ready",
      "reviewer": null,
      "blockedBy": []
    }
  ],
  "awareness": [
    {
      "taskId": "task-9",
      "displayId": "9",
      "subject": "API auth refactor",
      "actionOwner": { "kind": "member", "memberName": "bob" },
      "nextAction": "review",
      "queueCategory": "waiting",
      "reasonCode": "waiting_review"
    }
  ],
  "anomalies": [],
  "counters": {
    "actionable": 1,
    "awareness": 1,
    "blocked": 0,
    "waitingOnUser": 0,
    "waitingOnLead": 0,
    "reviewNeeded": 0,
    "anomalies": 0
  }
}
```

Ключевая идея:

- **actionable** должно быть коротким и операционным
- **awareness** должно быть ещё компактнее и не засорять reasoning

### 11.2 Очередь лида

Лид должен получать не full board, а priority bucket:

- needs owner assignment
- needs reviewer assignment
- needs clarification from lead
- broken dependency graph
- waiting on user

Важно:

- `stalled review / stalled work` не должны становиться primary lead bucket самого agenda resolver в Phase 0/1
- stall-сигналы можно потом добавить как отдельное summary/enrichment, если они уже приходят из существующего stall-monitor surface

Плюс summary:

- сколько задач у кого actionable
- сколько pending review
- сколько blocked
- сколько orphaned / anomalous

Лид потом уже по id прицельно открывает `task_get` или filtered `task_list`.

### 11.3 Inventory

`task_list` остаётся полезным, но только как:

- browse/search
- audit/debug
- filtered discovery

Не как "starting point for every turn".

---

## 12. Почему `watchers` нужны, но не должны править миром

Полезные watcher-кейсы:

- owner должен знать, что его задача ушла на review
- лид должен знать, что задача ждёт user input
- reviewer может быть watcher до момента formal review assignment

Но если строить queue по watchers, получится:

- лидер снова видит почти весь board
- участник получает слишком много secondary state
- LLM начинает путать "надо делать" и "полезно знать"

Поэтому правило такое:

- **routing делается по `actionOwner`**
- **watchers идут только во вторичный слой visibility**

---

## 13. Locking и consistency model

### 13.1 Что вводим

В Phase 0 вводим controller-owned team-level board lock для операций, которые меняют:

- task files
- review routing
- kanban state
- derived queue snapshot reads

Но lock должен жить на правильном уровне:

- не внутри каждой мелкой low-level функции
- а вокруг **композитных board operations**
- и вокруг queue snapshot read, который хочет увидеть консистентный cross-file state

Рекомендуемая реализация:

- новый controller-owned primitive вида `withTeamBoardLock(paths, fn)`
- lock file рядом с team state, например в `teamDir`
- reuse можно брать только как low-level идею file-based exclusivity, но не как слепое обещание, что текущий primitive уже подходит без contract hardening

После дополнительного code review это важно уточнить жёстче:

- существующий `withFileLockSync(...)` sync-only и busy-wait
- его текущие таймауты `5s` acquire / `30s` stale сами по себе ещё не являются доказанным board contract
- Phase 0 не должен молча падать обратно на unlocked read/write, если board lock не взят

Минимальный board-lock contract для плана:

- один lock на board scope команды, а не набор несвязанных task-file lock'ов
- lock timeout должен отдавать явную ошибку mutation/read caller'у, а не скрытый unlocked fallback
- lock держим только вокруг canonical board files и derived snapshot build
- уведомления и прочие non-board side effects не должны бесконечно удерживать board lock

### 13.1.1 Mutation classes and exact commit boundary

Чтобы rollout не был расплывчатым, полезно разделить board operations на 3 класса:

**Class A - routing-affecting task mutations**

- `task_set_owner`
- `task_set_status`
- `task_start`
- `task_complete`
- `task_set_clarification`
- `task_add_comment`, если комментарий меняет queue-visible state или `lastMeaningfulEventAt`
- dependency link/unlink, если оно меняет blocking graph

Правило:

- даже если durable write происходит в один task file, mutation всё равно должна проходить под board lock
- иначе queue snapshot под тем же contract не имеет единого serialization point

**Class B - multi-file board mutations**

- `review_request`
- `review_start`
- `review_approve`
- `review_request_changes`
- любые операции, которые меняют и task state, и kanban overlay, и возможно несколько task rows

Правило:

- весь board commit происходит под одним board lock
- lock release только после того, как durable board files уже записаны

**Class C - post-commit side effects**

- inbox/system notifications
- observability warnings
- expensive attachment copy/link work, если оно не влияет на queue routing

Правило:

- эти шаги идут после board commit
- они не имеют права отменять уже committed board mutation

### 13.2 Зачем

Чтобы queue read видел:

- либо старый консистентный state
- либо новый консистентный state

Но не невозможную смесь.

### 13.3 Почему этого достаточно для Phase 1

Потому что Phase 1 не добавляет второй durable projection.

Следовательно:

- нечему отдельно "протухать"
- нет projection write, который надо атомарно коммитить рядом с raw state

### 13.4 Ограничение

Если кто-то пишет в raw файлы вообще в обход controller, lock этого не предотвратит.

Но это допустимое ограничение, если:

- UI
- MCP tools
- planned task workflow

маршрутизируются через controller.

После дополнительного просмотра кода это допущение выглядит разумным:

- основные UI mutation paths уже идут через `getController(...).tasks/review/kanban`
- но это не значит, что в Phase 0 надо сразу переписать все main-side read paths под тот же lock

Отдельно важно:

- board читают не только MCP tools
- main-process сервисы вроде `TeamTaskReader`, `TeamKanbanManager` и stall-monitor snapshots тоже строят picture of truth из тех же файлов

Более правильный scope для первой фазы:

- queue projector читает state под controller-owned lock
- review/task multi-file mutations используют тот же controller-owned lock
- если позже какой-то non-controller consumer реально потребует agenda-grade snapshot, он должен идти через официальный snapshot API, а не копировать сырой read path

Иначе можно случайно раздуть rollout до общего I/O refactor и потерять фокус на агентском operational surface.

### 13.4.1 Notification boundary must be post-commit

Это отдельное ужесточение после просмотра `review_request(...)`.

Для queue correctness опасно, когда board mutation и inbox notification живут в одном pseudo-transaction, но rollback умеет откатить только часть шагов.

Phase 0 rule:

- canonical board mutation commit завершается до отправки inbox/system notifications
- notification send считается best-effort side effect
- неуспешная доставка уведомления не должна оставлять board в "откаченном наполовину" состоянии

Практический смысл:

- queue semantics не зависит от того, дошло ли служебное сообщение
- если уведомление упало, нужен warning/observability signal, а не partial rollback board state

### 13.4.2 Failure contract must be explicit

У board path должен быть не только lock, но и понятная failure semantics.

Минимальный contract:

- lock acquire timeout -> explicit retryable error, никакого unlocked fallback
- board commit failed до durable write -> mutation error, side effects не запускаются
- board commit succeeded, side effect failed -> mutation считается committed, side effect failure попадает в warning/diagnostics
- snapshot reader встретил unreadable row -> snapshot помечает anomaly, а не делает вид, что board полностью здоров

Это особенно важно для `review_request(...)`-подобных flows:

- если task/history уже committed
- а notification не ушла

то queue обязана видеть committed review state, а не fictional rollback state

---

## 13.5 Почему clarification надо стабилизировать до agenda rollout

Это отдельный guardrail, потому что здесь уже есть расхождение между "как система себя описывает" и "как она реально работает".

Сейчас:

- prompts говорят, что `needsClarification: "lead"` auto-clear'ится, когда отвечает lead
- код в task store снимает этот флаг, когда комментирует **любой не-owner автор**

Риск:

- derived queue может решить, что лидер ответил и задача больше не ждёт clarification
- хотя фактически мог прокомментировать другой teammate или reviewer

Рекомендуемая нормализация перед полноценным agenda rollout:

- **Phase 0 safe mode**
  - любой clarification clear'ится только через явный `task_set_clarification clear`
  - queue не верит implicit auto-clear вообще
- **Phase 1 optional ergonomics**
  - после стабилизации lead identity можно вернуть:
    - `lead` clarification clear на комментарий лида
    - `user` clarification clear на комментарий `user`

Это важное изменение по сравнению с предыдущей версией плана:

- раньше мы пытались сразу сохранить удобство auto-clear
- теперь приоритет сдвинут в пользу надёжности и объяснимости

Практический вывод для rollout:

- в Phase 0 `needsClarification` становится надёжным routing-сигналом именно потому, что clear происходит только явно
- ambiguous clarification больше не должен зависеть от того, кто случайно оставил комментарий

Минимальный implementation note:

- Phase 0: убрать implicit clear из routing expectation и синхронно обновить prompts/briefings
- если потом возвращать ergonomic auto-clear, делать это только на controller layer, а не внутри storage

No-go rule:

- нельзя оставлять situation, где prompt обещает "lead comment closes clarification", а queue layer всё ещё зависит от текущего store behavior "любой non-owner comment clears it"

### 13.6 Почему task logs не должны становиться queue dependency в Phase 0/1

После дополнительного code review видно, что task log / transcript слой уже умеет видеть:

- `task_set_owner`
- `task_set_clarification`
- reviewer details в board activity

Но это **не** означает, что queue надо строить поверх логов.

Почему это плохая идея для первой фазы:

- логи тяжелее и дороже для read path
- это observability layer, а не canonical board state
- появится второй semantic source рядом с task/kanban state
- при расхождении будет очень сложно объяснить, почему board показывает одно, а queue решила другое

Правило для Phase 0/1:

- queue derivation строится только из canonical board state:
  - task files
  - kanban state
  - roster resolution
- task logs допускаются только как:
  - debug aid
  - diagnostics
  - future validation tooling

---

## 14. Phase rollout

### Phase 0 - Hardening the weak signals first

Это новая обязательная фаза после дополнительного code review.

Её цель:

- не начинать agenda rollout поверх уже известных semantic cracks

Что делаем:

1. вводим controller-owned `withTeamBoardLock(...)` / `getBoardSnapshot(...)` для agenda reads и multi-file board mutations
2. выделяем отдельный queue-grade reviewer resolver, который работает только по текущему review cycle history
3. выносим inbox/system notifications за board-state commit boundary, чтобы message delivery не ломала queue semantics частичным rollback'ом
4. в Phase 0 переводим clarification semantics в explicit-clear-only mode и синхронно обновляем prompts/briefings
5. фиксируем canonical queue roster normalization в controller layer, а не в нескольких runtime местах сразу
6. создаём внутренний structured agenda DTO + text renderers для backward-compatible `task_briefing` и нового `lead_briefing`
7. выбираем настоящий semantic owner для filtered `task_list` и не оставляем это MCP-local ad hoc логикой
8. фиксируем registration strategy для новой `lead` group, чтобы `registerTools()` не получил missing или duplicate registration path
9. экспортируем явный source of truth для lead bootstrap tool list рядом с existing teammate constants
10. добавляем отдельный lead bootstrap permission seed path для `lead_briefing` и других first-turn lead surfaces
11. выбираем lead bootstrap strategy честно:
   - role-aware preflight
   - или explicit fallback, пока preflight ещё не внедрён
12. держим agenda/inventory helpers вне accidental public `controller.tasks` surface
13. добавляем filters/limit в `task_list`, не ломая пока его default meaning
14. синхронизируем local `.d.ts` contracts для `agent-teams-controller`, чтобы новые exports/tools не жили только в runtime без type surface
15. явно фиксируем phase rule: no inferred mandatory review without explicit policy signal
16. переписываем lead prompt snippets в `TeamProvisioningService`, чтобы canonical first call стал `lead_briefing`, а не raw `task_list`
17. вводим queue-grade anomaly reporting, чтобы unreadable task rows не исчезали silently из board views

Критерий завершения Phase 0:

- у нас есть набор слабых сигналов, которые либо стабилизированы, либо явно помечены как unreliable
- после этого derived agenda уже можно строить на нормальной базе, а не на wishful thinking

Phase 0 exit gates:

- agenda resolver не использует per-task kanban reviewer
- review/task multi-file operations и agenda snapshot используют один controller lock contract
- board-state mutations не откатываются частично из-за ошибки inbox/system notification
- clarification больше не может тихо исчезнуть из queue из-за комментария произвольного teammate
- queue roster normalization зафиксирован тестами на `team-lead`/`lead`, removed members, external recipients и generated ids
- новая `lead` group имеет реальный MCP registration path без duplicate tool registration
- exported lead bootstrap constant существует и используется как source of truth
- lead bootstrap permission seed включает `lead_briefing`, если prompt делает его first action
- lead path либо валидирует `lead_briefing` как required tool, либо сохраняет явный fallback до такой валидации
- agenda/inventory helper не утёк в public `controller.tasks` surface случайным export'ом
- filtered `task_list` больше не висит на неопределённой MCP-only semantics
- `task_list` default unfiltered semantics остаётся совместимой, несмотря на добавление filters/limit
- lead prompt больше не рекламирует `task_list` как primary board entrypoint
- `lead_briefing` contract зафиксирован как role-scoped tool без обязательного `leadName`
- generic board snapshot helper остаётся internal implementation detail
- queue snapshot больше не может silently терять unreadable task rows без warning/anomaly signal

### Phase 1 - Semantic cleanup without persisted projection

Цель:

- правильно определить action routing
- сократить payload
- убрать путаницу между inventory и queue

Что делаем:

1. добавляем derived resolver для `actionOwner` / `nextAction` / `reasonCode`
2. строим новый queue projector поверх raw state
3. используем controller-owned team-level lock для queue snapshot и board mutations
4. перерабатываем `task_briefing` под operational agenda
5. добавляем отдельный `lead_briefing`
6. ужимаем и фильтруем `task_list`, но без слишком раннего silent semantic break
7. обновляем prompts, чтобы:
   - teammates стартовали с `task_briefing`
   - lead стартовал с `lead_briefing`
   - `task_list` использовался только при необходимости browse/search
8. поэтапно меняем teammate operational tool catalog, чтобы `task_list` перестал быть default teammate shortcut
9. переводим `task_list` output с legacy blocklist semantics на explicit allowlisted inventory contract, когда callers уже готовы к явному переходу
10. только если когда-то появится explicit review policy, рассматриваем более сильный post-complete review routing

Ожидаемый результат:

- агент сразу видит свой реальный action set
- лид видит routing issues и pressure points, а не весь board dump
- исчезает большая часть лишней token-нагрузки

### Phase 1.5 - Compatibility and prompt hardening

Что делаем:

- сохраняем backward compatibility имени `task_briefing`
- если нужно, старый формат прячем за флагом или мягким переходом
- обновляем tool descriptions
- обновляем team provisioning instructions
- меняем lead prompts так, чтобы `lead_briefing` стал canonical first call, а `task_list` остался inventory/audit tool
- teammate prompts дополнительно поджимаем, чтобы они не тянули `task_list` без явной причины
- если role-aware lead preflight выбрали не сразу, сохраняем temporary explicit fallback path до завершения readiness hardening
- обновляем tests, которые сегодня закрепляют blocklist-semantics `task_list`, чтобы transition был явным и осознанным

### Phase 2 - Revision first, delta second

Важно: Phase 2 не должен начинаться, пока Phase 1 не покажет стабильную queue semantics.

### Phase 2A - Revision / no-change short-circuit

Добавляем:

- stable queue `revision`
- возможность ответа `unchanged`

Это уже даст экономию токенов и ускорение без сложного diff protocol.

Лучший practical path:

- повторить pattern, уже используемый в `feedRevision`
- строить `revision` как stable hash от уже нормализованного compact agenda DTO
- обязательно сортировать items детерминированно перед hashing

Что именно должно входить в revision payload:

- actor
- actionable task refs + minimal derived fields
- awareness task refs + minimal derived fields
- counters
- critical summary buckets for lead queue

Что не должно влиять на revision в первой версии:

- декоративный текст renderer
- локальные wording changes
- поля, которые не меняют queue semantics

### Phase 2B - Optional delta sync

Делать только если реально нужно по профайлингу.

Возможный контракт:

- клиент передаёт `sinceRevision`
- если сервер может корректно отдать delta, отдаёт delta
- если нет, отдает full compact queue

Правило:

- delta должен быть **оптимизацией транспорта**
- а не единственным способом понять board state

---

## 15. Миграция и backward compatibility

### Что не ломаем

- `task_get` остаётся source of full details
- `member_briefing` остаётся bootstrap tool
- старые raw task files остаются валидными

### Что меняется в поведении

- `task_briefing` перестаёт быть простым owner list
- lead перестаёт использовать full `task_list` как первую точку входа
- teammate больше не зависит от общего списка задач команды
- reviewer routing становится более явным и меньше зависит от "угадай reviewer из косвенных полей"
- clarification queue semantics в первой фазе становятся deliberately explicit, а не "магически auto-cleared"

### Совместимость

Если где-то старый runtime ещё вызывает `task_briefing` с ожиданием owner-only semantics, это обычно безопасно:

- новая agenda всё ещё покажет owned actionable items
- просто дополнительно добавит правильный awareness

`task_list` compatibility надо трактовать отдельно и жёстче:

- Phase 0/1:
  - можно сохранить совместимую unfiltered semantics
  - но filters/limit уже должны идти через выбранный semantic owner, а не через случайный MCP overlay
- Phase 1/1.5:
  - переход к explicit allowlisted inventory row делается как осознанный contract change
  - tests и prompt/docs migration должны идти в той же фазе, а не постфактум

Отдельный compatibility note:

- новые controller exports / tool names / helper contracts нельзя добавлять только в runtime код
- нужно синхронно обновлять:
  - `src/types/agent-teams-controller.d.ts`
  - `mcp-server/src/agent-teams-controller.d.ts`
  - runtime export surface

После повторного code review здесь уже есть конкретные известные расхождения, а не абстрактный риск:

- main shim не знает `tasks.memberBriefing(...)`
- main shim не знает `tasks.getTaskComment(...)`
- main shim не знает `review.startReview(...)`
- main shim не знает `runtime`
- `lookupMessage(...)` типизирован по-разному в двух shim файлах

Именно поэтому новый public controller contract в этой задаче должен быть узким:

- добавить `tasks.leadBriefing(): Promise<string>`
- сохранить `tasks.taskBriefing(memberName): Promise<string>`
- не добавлять generic public `getBoardSnapshot(...)` в ту же фазу

Иначе получится неприятный класс ошибок:

- код работает локально в одном слое
- но типы и другой слой monorepo продолжают жить со старым контрактом

---

## 16. Что конкретно важно протестировать

### 16.1 Unit tests на resolver

Нужны table-driven тесты для сценариев:

- pending + owner
- in_progress + owner
- completed + reviewer missing
- review + reviewer resolved
- review + reviewer missing
- review + stale reviewer from previous cycle
- review requested but not started yet
- review column entry exists but per-task kanban reviewer is null
- self-review
- removed owner
- removed reviewer
- canonical lead name vs `team-lead` alias
- zero explicit lead candidates still yields valid lead queue
- multiple lead-like members do not make `lead_briefing` fail
- external inbox recipient does not become valid queue member
- generated/internal pseudo-agent id does not become valid queue member
- completed task + reviewer pool configured + no explicit review event
- waiting on user clarification
- waiting on lead clarification
- clarification cleared by wrong actor
- healthy dependency block
- broken dependency
- needsFix after review
- approved/deleted terminal
- unreadable task row produces anomaly instead of silent omission

### 16.2 Snapshot tests на queue surfaces

Проверить отдельно:

- teammate actionable/awareness
- lead action buckets
- filtered inventory outputs
- anomaly summary surfaces in lead-facing outputs when board rows are unreadable
- `lead_briefing` text output не дублирует весь board и не превращается в disguised `task_list`
- `lead_briefing` output не зависит от обязательного `leadName` input

### 16.3 Concurrency tests

Проверить:

- multi-file mutation не даёт невозможного mixed snapshot
- read под lock не ломает корректность
- stale lock cleanup не создаёт ложных успешных чтений
- board lock timeout не приводит к silent unlocked fallback
- `review_request` и `review_request_changes` не оставляют queue в промежуточном ambiguity state
- ошибка inbox/system notification после board commit не оставляет history/kanban drift
- unreadable task row не теряется silently и поднимается как anomaly
- новая `lead` group не ломает `registerTools()` и не вызывает duplicate registration существующих task tools
- exported lead bootstrap constant совпадает с реальным runtime usage path, а не дублируется локальным списком
- если lead path делает `lead_briefing` hard first action, readiness preflight действительно валидирует его наличие
- текстовый renderer `task_briefing` не расходится со structured agenda DTO

### 16.4 Prompt-path tests

Проверить, что team prompts реально подталкивают:

- member -> `task_briefing`
- lead -> `lead_briefing`
- details -> `task_get`

И отдельно зафиксировать:

- `TeamProvisioningService` больше не содержит lead hint `List all tasks: task_list ...` как primary recommendation
- новый lead hint рекомендует `lead_briefing` раньше, чем `task_list`
- если lead prompt делает `lead_briefing` hard-first, launch/preflight path тоже проверяет этот tool, а не только prompt text

### 16.5 Contract tests and type sync

Проверить:

- local `.d.ts` shim declarations синхронны с реальным runtime surface
- `AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOL_NAMES` отражает новый teammate access policy
- `lead_briefing` явно отсутствует в `AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOL_NAMES`
- если вводится новая `lead` group, обе локальные `AgentTeamsMcpToolGroupId` декларации знают `lead`
- если выбран public controller inventory method, обе локальные `.d.ts` декларации знают и его точный contract
- у каждого `AgentTeamsMcpToolGroupId` есть валидный registration path в MCP layer
- exported lead bootstrap tool constants синхронны между runtime package surface, `.d.ts` и фактическим bootstrap usage
- lead bootstrap permission seed contract отдельно зафиксирован:
  - `lead_briefing` доступен для first-turn lead flow
  - seed path не зависит только от teammate operational list
  - seed path трактуется отдельно от general runtime availability при `bypassPermissions`
- lead bootstrap readiness contract отдельно зафиксирован:
  - teammate path hard-checks `member_briefing`
  - lead path не объявляется equally strict, пока не добавлен explicit preflight или documented fallback
- accidental helper exports не появляются в `createController(...).tasks`, если они не объявлены частью public contract
- `task_list` tests меняются осознанно и явно фиксируют transition semantics, а не ломаются побочным эффектом
- queue-side roster normalization behaviour зафиксирован явно и не drift'ит незаметно относительно UI expectations
- `task_list` filter contract зафиксирован отдельно:
  - only stable filters
  - conjunctive semantics
  - `limit` after filtering
  - no hidden agenda ordering
- `task_list` output contract зафиксирован отдельно:
  - explicit allowlisted inventory row as target contract
  - migration away from legacy blocklist is explicit and tested
- queue anomaly contract зафиксирован отдельно:
  - unreadable task rows surface as anomaly
  - lead-facing outputs do not silently hide board corruption
- `TeamProvisioningService` lead prompt contract зафиксирован отдельно:
  - `lead_briefing` рекомендуют раньше `task_list`
  - строка `List all tasks: task_list ...` больше не используется как primary recommendation
- `lead_briefing` public contract зафиксирован отдельно:
  - no required `leadName`
  - text surface in Phase 1
  - role-scoped semantics, not name-scoped semantics

### 16.6 Non-goals enforcement tests

Проверить:

- queue derivation не зависит от task logs/transcript activity в Phase 0/1
- owner/clarification semantics не подменяются history heuristics там, где canonical signal - это текущее task field
- queue не копирует бездумно stall-monitor правило "open review window only after review_started"

---

## 17. Признаки того, что rollout удался

### Хорошие сигналы

- lead перестал регулярно вызывать полный `task_list` для рутинной навигации
- teammate получает короткий actionable набор
- меньше "забытых" задач в review без reviewer
- меньше orphaned tasks
- меньше случаев, где LLM делает неверный workflow шаг из-за неоднозначного контекста

### Плохие сигналы

- queue стала слишком "умной" и начала скрывать важные задачи
- разные инструменты дают разное понимание одного и того же task state
- lead queue снова разрастается до pseudo-full-board
- delta/revision добавлены слишком рано и ломают простые сценарии
- clarification queue decisions всё ещё расходятся с реальным поведением board
- reviewer остаётся "магическим" и не объясняется понятным resolver precedence

---

## 17.1 Conservative Bias Rules

Если сигнал неоднозначен, queue system должна ошибаться в сторону безопасности:

1. ambiguous reviewer -> lead queue, а не speculative reviewer routing
2. ambiguous clarification clear -> lead oversight, а не скрытие wait-state
3. ambiguous dependency integrity -> repair bucket у лида, а не auto-unblock
4. ambiguous ownership -> `assign_owner`, а не молчаливая подстановка watcher/last actor
5. unreadable task row -> anomaly / lead repair signal, а не тихое исчезновение из queue

Это очень важное правило для LLM-facing surface:

- false positive в lead queue обычно терпим
- false negative в actionable queue часто приводит к реально потерянной работе

---

## 18. Чего делать не надо

### Не надо 1

Не надо сразу вводить persisted `board-projection.json` как обязательную истину.

Это красивее на схеме, но опаснее в реальности.

### Не надо 2

Не надо строить primary queue по `watchers`.

Это почти гарантированный путь обратно к информационному шуму.

### Не надо 3

Не надо считать, что фильтрованный `task_list` уже равен agenda.

Даже хороший фильтрованный inventory не заменяет явный `actionOwner`.

### Не надо 4

Не надо молча возвращать пустую очередь, если runtime identity не определился.

Такие silent failures очень дорогие.

### Не надо 5

Не надо строить Phase 1 на предположении, что текущие clarification и reviewer signals уже идеально надёжны.

Сначала их нужно harden или честно ограничить область применения.

### Не надо 6

Не надо добавлять новый queue surface только в runtime код, забыв про tool catalog, local `.d.ts` и тестовый контракт.

Для этой зоны "почти работает" особенно опасно, потому что баг всплывает не сразу и не в одном месте.

### Не надо 7

Не надо соблазняться task logs как "богаче сигналами" и тихо тащить их в основной queue resolver первой фазы.

Это почти гарантированный способ получить вторую, более дорогую и менее объяснимую source-of-truth плоскость.

### Не надо 8

Не надо делать `lead_briefing` как второй независимый renderer рядом с `taskStore.formatTaskBriefing(...)`.

Если teammate и lead surfaces будут собираться разными ad hoc formatter'ами, drift почти неизбежен.

### Не надо 9

Не надо преждевременно экспортировать generic `getBoardSnapshot(...)` как public controller API.

Пока у него нет второго доказанного consumer, это только увеличит surface area и type-sync burden.

### Не надо 10

Не надо вводить в `task_list` misleading filter вроде `column=todo|in_progress|done`, будто inventory layer уже стал полным kanban projection.

Для actor-centric и agenda-centric views есть `task_briefing` и `lead_briefing`.

### Не надо 11

Не надо класть `lead_briefing` в existing `task` group и надеяться, что prompts сами спрячут его от тиммейтов.

Если доступность инструмента определяется catalog'ом, то и ограничение должно быть в catalog, а не только в тексте подсказок.

### Не надо 12

Не надо оставлять `task_list` навсегда на blocklist-подходе только потому, что так проще пережить первую миграцию.

Иначе payload снова будет незаметно пухнуть при каждом новом task field, а inventory surface опять начнёт вести себя как полу-сырой dump.

### Не надо 13

Не надо завязывать rollback board-state mutation на успех inbox/system notification.

Если notification упала, надо сигнализировать о delivery problem, а не оставлять history и kanban в полурасходящемся состоянии.

### Не надо 14

Не надо добавлять новую `lead` group только в catalog и `.d.ts`, забыв про `mcp-server/src/tools/index.ts`.

Иначе rollout сломается не на semantics, а на missing registration path.

### Не надо 15

Не надо считать teammate operational permission seed list автоматически подходящей базой для lead-first surfaces.

Как только появляется lead-only tool вроде `lead_briefing`, это предположение перестаёт быть надёжным.

### Не надо 16

Не надо экспортить agenda/inventory helper из `internal/tasks.js` "временно", если он не должен быть public API.

При текущем `bindModule(...)` это уже не временный helper, а новый `controller.tasks.*` method.

### Не надо 17

Не надо писать в prompt, что `lead_briefing` является обязательным first step для лида, если runtime path ещё не умеет это валидировать или честно fallback'ить.

Иначе получится фальшивая bootstrap-гарантия: текст обещает одно, а launch contract её ещё не держит.

### Не надо 18

Не надо заводить lead bootstrap tool list как локальный массив в `TeamProvisioningService`, если catalog уже является source of truth для MCP surface.

Иначе первый же rename/regrouping даст тихий drift между catalog, permissions и bootstrap runtime.

### Не надо 19

Не надо inherit'ить из текущего raw reader правило "unreadable task row можно просто пропустить".

Для queue это не tolerant behavior, а скрытая потеря board truth.

---

## 19. Рекомендуемый implementation order

1. ввести controller-owned board lock primitive / snapshot API
2. вынести board notifications в post-commit best-effort path
3. перевести clarification routing в explicit-clear-only semantics и обновить prompts
4. выделить queue-grade reviewer resolver для текущего review cycle
5. формализовать queue roster normalization
6. выделить общий derived resolver `resolveTaskActionState(...)`
7. покрыть resolver table-driven тестами
8. собрать structured agenda DTO + text renderers
9. обновить `task_briefing`
10. добавить `lead_briefing`
11. завести отдельную `lead` tool group и синхронно обновить local `.d.ts` group unions
12. завести для `lead` group отдельный MCP registration path без duplicate task registrations
13. экспортировать dedicated lead bootstrap tool constants из controller package surface
14. добавить explicit lead bootstrap permission seed contract
15. выбрать lead bootstrap readiness path:
   - explicit preflight
   - или temporary documented fallback
16. удержать agenda/inventory helpers вне accidental public controller surface
17. выбрать backing contract для filtered `task_list`
18. добавить filters/limit в `task_list`, не ломая его default слишком рано
19. после migration readiness перевести `task_list` на allowlisted inventory row contract
20. обновить tool descriptions и provisioning prompts
21. после стабилизации добавить `revision`
22. только потом решать, нужен ли `delta`

## 19.1 Likely Change Surface

Наиболее вероятные точки изменения, если реализовывать этот план без лишнего расползания:

- `agent-teams-controller/src/internal/tasks.js`
  - новый `lead_briefing` surface
  - controller-level agenda snapshot orchestration
  - agenda renderer wiring
- `agent-teams-controller/src/internal/agenda.js` или аналогичный internal helper module
  - safest home для derived agenda/inventory helpers, которые не должны стать public controller methods автоматически
- `agent-teams-controller/src/internal/taskStore.js`
  - storage-only cleanup
  - legacy formatting only
  - убрать из store implicit clarification policy как routing assumption
- `agent-teams-controller/src/internal/review.js`
  - queue-grade reviewer resolution hooks
  - board commit vs notification side-effect boundary
  - при необходимости явнее фиксировать signals текущего review cycle
- `agent-teams-controller/src/internal/fileLock.js`
  - база для controller-owned board lock primitive
- `agent-teams-controller/src/internal/runtimeHelpers.js`
  - queue roster normalization
  - lead alias normalization helpers
  - `inferLeadName(...)` scope reduction so role-scoped `lead_briefing` does not depend on weak name inference
- `src/shared/utils/leadDetection.ts`
  - only if controller-side lead normalization is aligned with shared rules instead of ad hoc heuristics
- `src/shared/types/team.ts`
  - only if future explicit review policy is introduced
  - until then, no invented review-required field in Phase 0/1
- `mcp-server/src/tools/taskTools.ts`
  - новый lead tool
  - optional filters/limit для `task_list`
  - совместимая эволюция `task_briefing`
  - явный transition away from `slimTaskForList(...)` blocklist semantics
- `mcp-server/src/tools/index.ts`
  - registration wiring for new `lead` group
  - защита от missing/duplicate group registration
- `agent-teams-controller/src/mcpToolCatalog.js`
  - phased teammate access policy for `task_list`
  - отдельная `lead` group
  - registration of `lead_briefing`
  - exported lead bootstrap tool constants
- `src/main/services/team/TeamProvisioningService.ts`
  - prompt migration для lead/member flows
  - lead bootstrap permission seed split from teammate operational seed
  - role-aware MCP readiness validation or explicit fallback for `lead_briefing`
- `agent-teams-controller/src/controller.js`
  - only if public bind surface needs extra guardrails around what becomes `controller.tasks.*`
- `src/types/agent-teams-controller.d.ts`
  - local type shim sync for main app
- `mcp-server/src/agent-teams-controller.d.ts`
  - local type shim sync for MCP package
- `mcp-server/test/tools.test.ts`
  - explicit transition of `task_list` expectations
- `agent-teams-controller/test/controller.test.js`
  - reviewer resolver and clarification semantics hardening
- `src/shared/utils/taskHistory.ts`
  - при необходимости helper для current review cycle traversal

Принцип:

- сначала добавлять новые explicit surfaces
- только потом снижать роль старых ambiguous surfaces

---

## 20. Финальная формулировка решения

Итоговое решение, к которому пришли:

- **Phase 0:** hardening слабых сигналов (`lock`, `reviewer resolver`, `clarification semantics`, compatible renderer)
- **Phase 1:** derived projection on read как база
- **Primary routing:** через `actionOwner`
- **Secondary visibility:** через `watchers`
- **Main teammate surface:** `task_briefing`
- **Main lead surface:** отдельный `lead_briefing`
- **Search/inventory:** `task_list` с filters/limit и постепенным уходом из роли default queue
- **Inventory contract:** `task_list` идёт к explicit allowlisted `TaskInventoryRow`, а не остаётся вечным blocklist dump
- **Consistency:** controller-owned team-level lock around board mutations and queue snapshot reads
- **Reviewer source:** only current-cycle history in Phase 0/1
- **Clarification source:** explicit clear semantics first, convenience auto-clear only later if really needed
- **Signal trust:** history/task/kanban signals имеют явный priority order, queue не усредняет conflicting inputs
- **Lead contract:** `lead_briefing` role-scoped, without required `leadName`
- **Lead plumbing:** отдельная `lead` group, отдельный MCP registration path и отдельный lead bootstrap permission seed
- **Bootstrap sequencing:** lead prompt становится hard-first only after registration + seed + readiness path are real
- **Public API discipline:** snapshot/DTO helpers stay internal until a second real consumer exists
- **Export discipline:** agenda/inventory helpers не должны случайно становиться `controller.tasks.*` methods через `bindModule(...)`
- **Board anomalies:** unreadable task rows surface as anomalies, not as silent omissions
- **Phase 2:** сначала `revision`, потом только при реальной необходимости `delta`

Это самый оптимальный баланс между:

- надёжностью
- предсказуемостью для агентов
- понятностью инструментария
- умеренной сложностью rollout

Если сформулировать совсем коротко:

> Не надо учить агента самому вычислять board policy из сырых задач. Надо один раз правильно вывести `actionOwner` и отдать каждому актёру его компактную очередь.
