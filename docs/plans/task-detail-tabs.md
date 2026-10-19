# Детали задачи в диалоге и независимых вкладках

> Статус: полный plan исправлен по точному source `57a0b04d9fcf2d8238e7913b054c661cc028a960`; четыре requested review/fix rounds и одно целевое correction после primary final audit complete. Файл является полным implementation handoff; новый broad review cycle не выполнялся.

База реализации обновлена fast-forward до `e94d0a06a52f9cf776b361af92a426c569ecff29`. Проверенный upstream diff не изменяет task read/dialog/tab/store core; новые OpenUI renderer, localization, desktop E2E config, dependencies и Git delivery policy сохраняются. Исторические четыре review receipts относятся к source выше.

## Summary

Сохранить существующий task dialog из канбана, graph, sidebar и task links и добавить рядом с верхним заголовком loaded dialog кнопку **«Открыть в отдельной вкладке»**. Кнопка создает независимую top-level task tab в focused pane либо активирует существующую task tab того же `(contextId, teamName, canonical taskId)` в ее pane.

Dialog, task tab и graph одного identity используют один renderer read-model и одну task session. Полные untruncated данные общие; drafts не копируются между host и tab. Задачи разных команд с одинаковыми canonical ID одновременно изолированы.

Критический инвариант: все открытые surfaces показывают согласованные live data; compact snapshot никогда не заменяет более новую accepted full DTO или ее tails; устаревший async response не пишет новое состояние; независимые full reads разных task identities в одной team не отменяют и не инвалидируют друг друга; handoff не теряет text, chips, pending attachments, reply или inline edits.

## Current understanding

| Exact source evidence | Consequence |
| --- | --- |
| `TeamDetailView.tsx:249-301` хранит `selectedTask`/`loadedTask`, refetches по `selectedTaskUpdatedAt` и строит `dialogTaskMap`; `TaskDetailDialog.tsx:234-327` делает `taskMap.get(task.id) ?? task`. | Удалить host-local full DTO и stale fallback; все surfaces читают один detail entry. |
| `GlobalTaskDetailDialog.tsx:53-100` вызывает `selectTeam(teamName, { skipProjectAutoSelect: true })`; `useGraphTaskDetailDialog.tsx:30-64` строит map только из compact `teamData.tasks`. | Global dialog не меняет selection/project; graph использует тот же full detail read-model. |
| `teamTaskSnapshotCompaction.ts:1-45` обрезает description/prompt до 2000, comment text до 120, history note до 500, source message до 1000. | `teamDataCacheByName` — compact projection/preview, не Save base и не authority готового full task. |
| `TeamDataService.ts:561-567,833-851 -> taskBoard.js:16-18 -> tasks.js:322-324 -> taskStore.js:451` читает includeDeleted; `taskStore.js:390-445` кидает `TASK_NOT_FOUND`, который preload превращает в rejected `Task not found: ...`. | Accepted `null` либо current `Task not found` — missing; DTO `status:'deleted'` — deleted; иная current IPC error — transient/provisioning/draft/unavailable. |
| `TeamTaskReader.ts:609-621` фильтрует deleted из snapshot; `teamSnapshotStructuralSharing.ts:12-94` сохраняет ссылки на равные values. | Отсутствие compact task не tombstone; suffix-only write может не изменить compact reference и обязан приходить через watcher/task event. |
| `teamSlice.ts:2872-3182` (`selectTeam`) и `3187-3350` (`refreshTeamData`) оба commit-ят `teamDataCacheByName/globalTasks` после проверки только context/team scope; `TeamDataReadWork.ts:13-105` дает dedup, но не ordering provenance. | Оба snapshot paths используют общий team snapshot epoch/latest-started snapshot serial; full reads имеют отдельные per-task identity provenance. |
| `store/index.ts:1854-1914,2126-2216` получает `task`/`task-log-change(change)` и планирует `refreshTeamData`; `FileWatcher.ts:1224-1255` дает canonical taskId из basename. | Синхронная source invalidation отклоняет старую affected snapshot/full read; read другого full task identity остается независимым. |
| `store/index.ts:967-1023` считает visible только active `team`/`graph`; hidden task tab не участвует в refresh. `PaneContent.tsx:136-158` хранит hidden tabs mounted. | Разделить data-interest и visible expensive work; две active panes обновляются без keyboard focus. |
| `TaskCommentInput.tsx:66-69` и `TaskCommentsSection.tsx:100-120` создают два draft hooks с key без context и читают `selectedTeamData.config.projectPath`; `hideInput` не удаляет hooks. | Один mounted composer/session writer; projectPath берется из team-scoped cache. |
| `TaskCommentsSection.tsx:53-55,183-195` строит DOM id только из taskId/commentId и ищет через `document.getElementById`. | Lookup ограничен surface root и полной identity. |
| `TaskLogsPanel.tsx:138-149` и root listener `store/index.ts:1441-1484` независимо toggling-ят IPC tracking. | Только root владеет IPC; panel регистрирует demand. |
| `teamSlice.ts:1413-1421`, `TeamDetailView.tsx:2311-2323`: `pendingReviewRequest` не имеет target и очищается до awaited `requestOpenChangeReview(...): Promise<boolean>`. | Request адресуется и очищается только после confirmed `true`. |
| `editorSlice.ts:328-330` пишет глобальный `editorPendingRevealFile`; первый active `TeamDetailView` открывает overlay (`TeamDetailView.tsx:1683-1690,3671-3678`). | Editor request адресуется target team tab; существующий `ProjectEditorOverlay` остается единственным editor workspace. |
| `taskReferenceUtils.ts:185-210` возвращает `teamName`, но callbacks `TaskDetailDialog.tsx:1195-1207` и `TaskCommentsSection.tsx:356-368` передают только taskId. | Structured ref сохраняет teamName; legacy без team ограничен team текущей поверхности. |
| `tabSlice.ts:137-203,266-415`: dedup только sessions, `setActiveTab` для `team`/`graph` делает `selectTeam`; `contextSlice.ts:98-169` нормализует только legacy `usage`. | Task discriminator обрабатывается раньше team selection; restore validation чистит malformed/mismatched task tabs. |

## Scope and boundaries

### In scope

- Существующий dialog во всех текущих entrypoints и кнопка **«Открыть в отдельной вкладке»** рядом с верхним заголовком loaded dialog.
- Независимые top-level task tabs разных команд; dedup строго `(contextId, teamName, canonical taskId)` по всем panes.
- Общий live detail/session для dialog, task tab и graph: fields, owner, status/review, clarification, group chat, links, attachments, comments/replies/chips, history, changes/logs и deletion.
- Полные untruncated task data; context/team/task isolation; resource-scoped request-start stale protection для team snapshots, independent full task reads, mutation post-effects, draft I/O и review/editor requests.
- Handoff text/chips/pending attachments/reply/dirty subject/description/submit state без autosend/autosave.
- Существующие close/reorder/drag/split/restore, derived labels, linked-task navigation, loading/retry/missing/deleted states.
- Focused critical unit tests и один реальный Electron `dev:mcp` CDP E2E на новых synthetic projects с настоящими IPC/main readers/writers/filesystem watcher.

### Out of scope

- Замена dialogs/links tabs по умолчанию, новый backend/API/IPC schema, удаление compaction.
- Durable restart platform, LRU/refcount registry, eviction policy, storage platform, вторая store или universal class hierarchy.
- Параллельные независимые inline/comment/review/file-editor workspaces; `changeReviewLifecycleCoordinator` и `ProjectEditorOverlay` остаются владельцами lifecycle.
- Agent/provider/runtime/orchestration/provisioning/assignment semantics и новые workflow controls.
- Tests на real projects/teams, agent/command/terminal/provider launches, browser mode, Computer Use, native picker.
- Generic composer migration, coverage quota, unrelated cleanup/formatting.

### Constraints and dependencies

- Реализация — существующие renderer store/components плюс cohesive feature-local helpers в `src/features/team-task-detail/`; публичный renderer entrypoint используется callers. `core/domain` получает только pure identity/merge rules.
- `renderer/ui` получает view-model/actions через props и не импортирует store/API. Main/preload API не расширяются: используется существующий `api.teams.getTask` и текущие task mutations.
- Не создавать broad storage platform, LRU/refcount registry или второй parallel authority. Использовать `teamDataCacheByName`, `selectTeamDataForName`, `refreshTeamData`, `TeamDataReadWork`, `draftStorage`, tab/pane APIs, текущие task mutations, review coordinator и editor overlay.
- `refreshTeamData` остается owner командного compact snapshot; feature-local gate добавляет только provenance/commit decision и не меняет transport/API.
- Новые production files проходят `pnpm guard:source-file-size`; длинная реализация не добавляется в `store/index.ts` или `TaskDetailDialog.tsx`.
- `pnpm typecheck` — единственный TS7 gate.

## Risks and weak spots

1. **Resource-scoped compact/full ordering — главный correctness risk.** S0 `refreshTeamData`, запущенный до события/mutation, может завершиться после S1 full read. `updatedAt`, equal reference и completion не доказывают порядок. Одновременно global same-team serial либо one current identity неправильно конкурируют между independent task X/Y и допускают starvation.
2. **Compact suffix truncation.** Snapshot содержит только prefixes; он не может быть Save base или source of truth для arrays/tails.
3. **Global selection contamination.** Global dialog, comment input и task links сейчас зависят от `selectedTeam*`; исправление должно быть team-scoped без скрытого `selectTeam`.
4. **Два surface writer.** `hideInput` не предотвращает duplicate draft hooks; submit/save flags и async completion сейчас не identity-scoped.
5. **Routing.** Review/editor request без target/nonce может быть потреблен другой active surface; file reveal также глобальный.
6. **Rollback.** Новый union type без совместимого discriminator может восстановиться как blank tab.

## Proposed approach

### Decisions

Tab representation:

```text
Option A: type 'team' + optional taskDetail discriminator
🎯 confidence 9/10  🛡️ reliability 9/10  🧠 complexity 3/10
Option B: new type 'task-detail'
🎯 confidence 8/10  🛡️ reliability 6/10  🧠 complexity 5/10
Option C: dialog-local tab emulation
🎯 confidence 3/10  🛡️ reliability 3/10  🧠 complexity 2/10
```

Выбран **A**: `Tab.type` остается `'team'`, `teamName` остается единственным team field, `taskDetail: { contextId, taskId }` отличает task surface. Причина не только rollback: source содержит множество whole-team assumptions, поэтому надежность дает полный audit и централизованные predicates. Option B сокращает некоторые branches, но старый renderer восстановил бы неизвестный `TAB_ICONS[tab.type]`/blank content.

Read coordination:

```text
Option A: маленькие request-start commit gates поверх существующих reads
🎯 confidence 9/10  🛡️ reliability 9/10  🧠 complexity 5/10
Option B: расширить ScopedReadRequests/TeamDataReadWork скрытыми epochs
🎯 confidence 6/10  🛡️ reliability 6/10  🧠 complexity 6/10
Option C: независимый fetch каждой поверхности
🎯 confidence 3/10  🛡️ reliability 2/10  🧠 complexity 2/10
```

Выбран **A**. `ScopedReadRequests` и `TeamDataReadWork` сохраняют текущий контракт live work; gate хранит team snapshot `{sourceEpoch,latestStartedSnapshotSerial}` и per-full-task `{sourceEpoch,latestStartedFullSerial}` плюс bounded pending flags. Нет global same-team read equality, scheduler, registry, LRU или refcount.

### Ordinary-team tab audit and ownership

Ввести только `isTaskDetailTab(tab)` и `isOrdinaryTeamTab(tab)` (`type==='team' && !tab.taskDetail`). Bare behavioral `tab.type === 'team'` запрещен.

| Exact branch | Minimal change / owner | Verification |
| --- | --- | --- |
| `teamSlice.ts:2339` `openTeamTab` | Dedup/activate/create только ordinary; отдельный `openTaskDetailTab` dedup по полному tuple. Удалить игнорируемый third `taskId` после перевода Global dialog. | Ordinary + task A открыты; `openTeamTab(A)` выбирает ordinary. |
| `teamSlice.ts:1367-1383`, used `4655,4734,4767` | `isVisibleInActiveTeamSurface` только ordinary team/graph; task refresh owns detail. | Task-only tab не запускает provisioning/member fetch. |
| `teamSlice.ts:3047-3057` | Label sync только ordinary; task label обновляет feature по accepted full subject + team display. Source line — label sync, не cleanup. | Rename не затирает task subject. |
| `teamSlice.ts:2045,3941,3993` delete/permanent cleanup | Add cohesive cleanup `contextId/teamName` для task requests/timers/detail/session; tabs остаются c unavailable. Restore invalidates and refreshes. | A/B isolation + delete/unavailable/restore. |
| `viewedTeamNotificationSync.ts:10-23` | Возвращает team только для ordinary/graph; task не вызывает `setViewedTeamForNotifications`. | No viewed-team request. |
| `useKeyboardShortcuts.ts:207-216` | Cmd+Shift+G только ordinary; task не dispatch-ит team graph/action. | Positive ordinary/negative task. |
| `SortableTab.tsx:82-91,153-200` | Task icon + team color, но `TeamTabSectionNav` только ordinary; generic drag/close/menu сохраняются. | Icon/menu assertions. |
| `FileLink.tsx:102-114` | Task surface provider `{contextId,teamName,projectPath}` from `selectTeamDataForName`; file action использует addressed editor request. | A/B opens exact project/target tab. |
| `PaneContent.tsx:136-177` | Early `TaskDetailTab`; ordinary `TeamDetailView` branch unchanged. | Task никогда не монтирует `TeamDetailView`. |
| `tabSlice.ts:389` | Early task activation без `selectTeam`, `openTeam`, project navigation. | A->B не меняет selected team/project. |
| `store/index.ts:967-1023` | Не расширять whole-team visible helper; отдельный visible task-detail identity set для task/log demand. | No team inbox/message/process polling; task event refreshes detail. |
| `contextSlice.ts:98-169,230-254`, `sessionRequestIdentity.ts:24-25` | Filter malformed/mismatched task tabs; include `taskDetail` in serialized tab owner scope. | Context A/B restore + replaced owner. |

### Ownership and identity

`TaskDetailIdentity = { contextId, teamName, taskId }`; `taskId` — canonical `TeamTask.id`, совпадающий с basename task file. `displayId`, subject и display team name используются только для lookup/labels. Один pure builder создает key `JSON.stringify([contextId, teamName, taskId])`; компоненты не собирают key вручную.

Authorities:

- persisted task JSON/controller — canonical saved data;
- `detailById[key].full` после accepted full read — renderer authority для всех saved task fields и untruncated arrays;
- `teamDataCacheByName[teamName].tasks` — compact preview/projection и сигнал invalidation;
- `globalTasks` — sidebar preview only;
- `sessionById[key]` — редактируемые drafts/ownership, не saved task data.

После ready full DTO compact snapshot не перезаписывает `subject`, `description`, `prompt`, `owner`, `status`, `comments`, `historyEvents`, `sourceMessage`, relationships или attachments. Существующие `kanbanState`/`changePresence` являются отдельными derived UI state и не переписывают saved/full fields. Save/submit никогда не читает compact.

### Request-start ordering and invalidation

Существующий `TeamRequestScope`/context/team epoch guard остается внешней проверкой scope. Внутри scope хранить два независимых resource-ordered read provenance:

- team snapshot resource `{sourceEpoch, latestStartedSnapshotSerial, pendingSnapshot}` для обоих `selectTeam` и `refreshTeamData`;
- per full task identity `{sourceEpoch, latestStartedFullSerial, pendingFull}` для существующего `api.teams.getTask(teamName, canonicalTaskId)`; `contextId` входит только в renderer identity/scope, IPC signature не меняется.

`sourceEpoch` растет синхронно до async work только для affected resources: `task`/content `task-log-change(change)` инвалидируют team snapshot и этот task full read; `config`/team-wide signal инвалидирует team snapshot и только явно affected full reads; accepted local mutation/restore/delete intent и team deletion/reset следуют тому же rule. Событие либо read другого task identity не меняет source epoch/full serial X.

Каждый physical read получает latest-started serial внутри своего ресурса: `snapshotReadSerial=++latestStartedSnapshotSerial` либо `fullReadSerial=++latestStartedFullSerial`. Snapshot equality never сравнивается с full serial. Full response X также никогда не сравнивается с snapshot request либо full request Y.

```text
snapshot start:  serial=++snapshot.latestStarted; capture(scope,snapshotEpoch,serial)
full X start:    serial=++task[X].latestStarted; capture(scope,taskEpoch[X],serial,identity=X)

snapshot commit: scope current && snapshotEpoch unchanged && serial===snapshot.latestStarted
full X commit:   scope current && identity===X && taskEpoch[X] unchanged
                 && serial===task[X].latestStarted
else resource:   no that-resource cache/full/derived/error/spinner write;
                 at most one successor for that same resource when invalidation/demand remains
```

Epoch/serial меняются на request start/source invalidation, never completion. `updatedAt`, equal references, `TeamDataReadWork` token и completion не дают provenance. Synchronous invalidation обеспечивает cross-endpoint protection: event/mutation X до delayed S0 или delayed full X делает эти reads stale и может требовать affected successor; delayed full Y остается commit-eligible при unchanged task Y epoch/latest serial. Никакая request X не cancel-ит Y, не очищает spinner/error Y и не ставит successor Y. Один `current.identity` на team scope запрещен.

Общий gate покрывает `selectTeam` и `refreshTeamData` для team snapshot. `TeamDataReadWork` остается dedup owner; stale joined response не commit-ится, pending/marked-fresh дает один successor только для invalid resource. `finally` только освобождает live-work token. Derived overlay, если потребуется для compact preview поверх ready full, использует narrowly scoped overlay provenance и не переносит full DTO authority; general scheduler/registry/LRU/refcount/global request serialization не добавляются.

`ensureTaskDetail` держит in-flight promise в открытом `detailById[key]`; join только для current epoch. Stale promise заменяется reference и не пишет. Hidden tabs получают invalidation/demand, но не own full read до activation/visible dialog.

### Detail state, deletion and errors

`ensureTaskDetail(identity)` запрашивает current `refreshTeamData(teamName,{withDedup:true})`, затем `api.teams.getTask(teamName,canonicalTaskId)` без select/open/project navigation.

| Current result | Behavior |
| --- | --- |
| Compact only | `hydrating`; preview; Save/submit blocked. |
| Accepted full | `ready`; atomic full replace. |
| Accepted `null` либо `Task not found: <taskId>` | `missing`; stale fallback запрещен. |
| Accepted `status:'deleted'` | sticky `deleted` до accepted non-deleted restore. |
| `TEAM_PROVISIONING` | `provisioning`; keep last full; event successor. |
| `TEAM_DRAFT`/team deletion/unavailable | `unavailable`; editing blocked. |
| Other current error + full | `stale + error`; keep full; manual Retry. |
| Other current error без full | `unavailable + error`; preview only; manual Retry. |
| Compact absent | Не tombstone. |

Snapshot сравнивает compact task с baseline только для refresh demand; никогда не заменяет ready full. Event/suffix-only ставит `refreshPending` и запускает full successor, даже если structural sharing сохранил reference.

Delete/restore: capture origin + epoch до IPC; success ставит `deleting`/`restoring`; failed снимает intent без backend retry. Request до success не отменяет intent. Accepted deleted/non-deleted подтверждает terminal state. Временно stale non-deleted full не воскрешает confirmed delete до watcher successor/Retry; restore symmetricно. Intent ограничивает controls и не создает per-tab Restore.

### Session, drafts and mutations

`sessionById[key]` хранит comment text/chips/reply/pending attachments, dirty subject/description, per-part `editRevision`, submit/save revision и `inlineEditOwnerSurfaceId`. Dialog/tab/graph одной задачи читают один session. Только owner surface может вызывать edit/submit controls; вторая visible surface показывает те же значения read-only. Параллельных inline editors нет. `ProjectEditorOverlay` остается отдельным глобально одиночным file editor.

Durable comment text/chips использует узкий adapter над `draftStorage` c текущим 24h TTL и keys `JSON.stringify(['task-comment', contextId, teamName, taskId])` / `JSON.stringify(['task-comment-chips', ...])`. Только для `contextId === 'local'` при отсутствии нового key прочитать legacy `taskComment:${teamName}:${taskId}` и `taskCommentChips:${teamName}:${taskId}`; legacy удалить только после успешного нового write. SSH context не наследует legacy.

Один writer сериализует load/save/delete по storage key c `storageSeq`. Late hydration применяется только при неизменившемся part `editRevision`; старый storage write не воскрешает cleared/newer draft. Submit/save capture `{ editRevision, contentSnapshot }`; success очищает только submitted revision. Typed successor остается; error сохраняет text/chips/attachments/reply и дает manual Retry без auto retry.

Pending attachments/reply/dirty subject/description живут в memory session. External saved change во время inline edit не перезаписывает draft и не autosaves on blur: показать conflict; явный Save использует существующий `updateTaskFields`, Cancel возвращает latest value. Backend CAS не создается.

Task mutations используют существующие store actions/API, но эти actions должны захватывать origin scope до IPC и выполнять встроенные refresh/error/draft effects только при current origin. Нельзя разрешить success из context A запускать refresh/clear в context B. Глобальный `addingComment` заменяется identity-scoped submit state. Stale UI никогда не повторяет backend write.

### Shared content, shells and handoff

- `TaskDetailContent` — presentation composition metadata/description/relationships/attachments/changes/logs/history/comments; получает готовый view-model/actions.
- `TaskDetailDialog` — существующий Radix shell/portal/lightbox/focus/`DialogTitle`/`DialogDescription`.
- `TaskDetailTab` — semantic heading, own scroll root, loading/error; без nested Dialog.
- Cohesive hooks поверх одного store не создают независимых sources of truth.

Кнопка рендерится внутри header content рядом с существующим `headerExtra`, чтобы сохранить global «Открыть команду». Она доступна только loaded task, localized, RU label ровно **«Открыть в отдельной вкладке»**, с accessible name/themed Tooltip без native `title`. `TaskDetailDialogProps` получает локальный callback `onOpenInTaskTab`; main/preload API не меняются.

Handoff:

1. Синхронно capture identity/session: text, chips, pending attachments, reply, dirty fields и submit revision; storage flush не barrier.
2. Предлагаемый feature/store action `openTaskDetailTab(identity)` синхронно сканирует все panes, dedup строго по canonical tuple, создает tab в focused pane либо активирует owning pane и возвращает `{ tabId, paneId, created }`. Существующий `openTab` остается `void`.
3. One-shot section/scroll seed не создается: новая tab продолжает тот же session и собственный scroll state.
4. Передать `inlineEditOwnerSurfaceId`; dialog закрывается только после confirmed activation. Нет blur autosave, clear draft/reply/attachments или autosend.

`TaskDetailTab` использует `type: 'team'` c `taskDetail: { contextId, taskId }`. Label — team display name + `#displayId` + current subject через существующий 50-char `truncateLabel`/Tooltip; label derived и не identity key. `setActiveTab` для task discriminator не вызывает `selectTeam`/project navigation.

Comment DOM lookup ограничен `scrollRoot` и строится из `surfaceId+contextId+teamName+taskId+commentId`. Unread/read tracking принадлежит visible surface; hidden tab и закрытие dialog не помечают comments read. `TaskCommentsSection` получает `projectPath` из `selectTeamDataForName(teamName)`.

### Live refresh and visibility

- **Data interest:** все task-detail tabs текущего context, active `team`/`graph` tabs и открытый global dialog. Task event/local mutation invalidates и запускает coalesced team/full refresh даже для hidden task tab; hidden tab не создает own full fetch.
- **Visible expensive work:** active tab каждого pane + `document.visibilityState === 'visible'` + открытый dialog. `isPaneFocused`/keyboard focus не участвуют; две active split panes обновляются одновременно.
- Hidden mounted tab не создает 20s changes refresh, 8s activity poll, 1s duration tick, stream reload, IntersectionObserver read marking или own `getTask`.

Timer callback повторно проверяет current context/identity/visible demand. Один event burst планирует один `refreshTeamData`; per-surface fanout отсутствует. Activation task tab делает один dedup refresh/full read без reset drafts. `taskSignalKind='log'` не меняет content freshness.

`TaskLogsPanel` больше не вызывает `setTaskLogStreamTracking`. Root listener — единственный IPC owner и синхронизирует tracking для существующих visible team/graph consumers плюс surfaces с открытым task logs demand; закрытие одного panel не выключает другого. `document.hidden` снимает visible expensive demand.

### Navigation, review/editor and deletion

`openTaskDetailTab` проверяет nonempty identity, разрешает display reference внутри target team через `taskMatchesRef`, затем canonical dedup по всем panes. `forceNewTab` не создает duplicate task tab.

- same-team ref в task tab открывает/активирует target task tab и сохраняет source session;
- same-team ref в обычном dialog сохраняет текущий board reveal;
- href c `teamName` использует только эту team; legacy href без team использует team текущей поверхности, никогда не selected global team; missing target показывает missing state.

Review использует существующую ordinary team tab и `changeReviewLifecycleCoordinator`. Addressed request: `{ contextId, teamName, targetTeamTabId, nonce, taskId, filePath, requestOptions }`. Action сначала активирует/создает target ordinary team tab, затем matching `TeamDetailView` вызывает существующий `requestOpenChangeReview`. Pending очищается только после awaited `true`; refusal сохраняет request/draft c Retry/Close. Другой pane/context/team/tab/nonce не потребляет request.

Editor routing использует отдельный addressed request `{ contextId, teamName, targetTeamTabId, nonce, filePath }`. Target `TeamDetailView` активирует существующий `ProjectEditorOverlay` для точного `data.config.projectPath`, затем вызывает текущий `revealFileInEditor(filePath)`. Task tab не содержит editor workspace; глобальный `editorPendingRevealFile` не устанавливается до target confirmation.

Delete использует существующий shared confirm и `softDeleteTask`. Cancel сохраняет surface. Confirmed accepted full `status: 'deleted'` дает read-only deleted state на всех identity surfaces, не закрывает tabs и не чистит drafts. Предложить существующий переход в team trash и Close/Retry; per-tab Restore нет. Restore через trash дает accepted full refresh. Team deletion/unavailable очищает detail work этой team и показывает distinct unavailable state.

ContextSnapshot сохраняет task tab только при `tab.taskDetail.contextId === snapshot._metadata.contextId` и nonempty team/task ID. Invalid/mismatched entries согласованно удаляются из `openTabs`, panes, selections и active IDs. Отсутствие `teamByName` до hydration не missing. TTL 5 минут не меняется. Rollback старого кода игнорирует `taskDetail` и деградирует до обычного team tab.

## Detailed implementation steps

1. **Identity/read/session** — pure identity rules; request-start snapshot/full commit gates; compact/full ownership; state transitions; origin-aware existing task mutations; session/revisions/draft adapter. Strongest unit tests до host changes.
2. **Dialog extraction** — общий content/hooks для `TaskDetailDialog.tsx`, comments/group-chat/attachments/logs; host в `TeamDetailView.tsx`, `GlobalTaskDetailDialog.tsx`, graph hook. Удалить `loadedTask`, global `selectTeam`, incorrect projectPath и duplicate draft hooks; сохранить текущие controls/lazy sections. Checkpoint работает без top-level tabs.
3. **Task tabs/handoff** — optional `taskDetail` discriminator в `renderer/types/tabs.ts`; feature action/dedup; early branch в `PaneContent.tsx`/`setActiveTab`; label/icon/drag/menu integration; context normalization; button/handoff/localization.
4. **Live/routing/cleanup** — data-interest/visible helpers; event/local-mutation invalidation; root log demand owner; addressed review/editor requests; cross-team refs; surface-scoped comment DOM/read tracking. Cleanup timers/observers; не расширять review/editor lifecycle.
5. **Verification/handoff** — focused tests рядом с существующими strong boundaries; typed `scripts/e2e/task-detail-tabs-desktop.ts` c минимальными helpers в `scripts/e2e/task-detail-tabs/`; регистрация в `scripts/tsconfig/tsconfig.desktop-e2e.json`. Зафиксировать exact SHA/source diff и acceptance evidence.

## Edge cases

| Case | Required behavior | Evidence |
| --- | --- | --- |
| S0 compact starts; event/mutation; S1 full commits; delayed S0 resolves | S0 не пишет cache/full overlay/error; newer status/comments остаются; один successor удовлетворяет invalidation. | Deferred request-start provenance test с литеральными DTO. |
| Concurrent X/Y в одной team + compact; compact/full resolve в любом порядке | Оба full X/Y accepted при unchanged sources и разных identities; exactly one full read каждого task absent real invalidation; X не cancel-ит Y, не очищает его spinner/error и не ставит Y successor solely из-за read X. Compact provenance проверяется только по snapshot resource. | Один focused deferred assertion c X/Y/compact controlled promises, прогон обоих resolve orders и literal call-count/accepted-state checks. |
| Два reads одного resource: snapshot либо full X завершаются в обратном порядке | Более ранний start отклоняется по latest-started serial только этого resource; completion не меняет generation; full Y не затрагивается. | Deferred out-of-order test per resource. |
| S2/source invalidation до ответа S1 | S1 rejected; один latest successor того же affected resource; stale `finally` не влияет; unrelated full read остается eligible. | Controlled promises с разными DTO. |
| Только suffix изменился, compact reference равен | `task` либо `task-log-change(change)` растит source epoch и запускает full successor. | Equal-reference unit + real watcher E2E. |
| Same canonical ID A/B; context ID reused после epoch reset | Независимые keys/epochs; stale response/error/draft не пишет чужую scope. | Deferred A/B и A -> B -> A tests. |
| Long description/comment/history/source | UI читает accepted full tails; compact никогда не Save base. | Unit merge + E2E markers после 2000/120/500/1000 and saved JSON tails. |
| Initial unselected refresh/full transient | Terminal feature error/Retry; нет infinite loading и `selectedTeamError`; last-known full остается stale. | Failure/retry test. |
| Compact временно нет, затем deleted confirmed | Warning absence не tombstone; deleted только по accepted current full status; fallback не воскрешает DTO. | Transition test + delete E2E. |
| Submit/save + newer typed revision | Completes только submitted revision; newer остается; A/B pending/error изолированы. | Deferred success revision test. |
| Late draft hydration/storage operation | Старый load не заменяет typed revision; serialized старый write не воскрешает cleared/newer draft. | Controlled draft I/O test. |
| Handoff text/chips/attachments/reply/inline edit | Все переживает activation; close только после success; нет autosend/autosave. | Component test + E2E fixture. |
| Dialog + tab одного identity | Один read/session/submit и один inline writer; DOM/read tracking surface-scoped. | Shared-surface test + E2E. |
| Hidden tab; две visible panes без focus | Hidden не expensive/read-mark; active panes live; activation догружает stale без reset. | Fake timers + external watcher E2E. |
| Cross-team/legacy task ref | Сохраненный teamName строгий; legacy ограничен surface team; missing не заменяется selected team. | Routing test. |
| Review/editor request | Только matching context/team/tab/nonce consume; refusal не теряет request; editor через existing overlay. | Routing/nonce test. |
| Malformed/mismatched restore tab | Удаляется из root/panes/selections; valid остается loading; rollback имеет обычный team fallback. | Context normalization regression. |

## Focused critical tests

1. **Read/invalidation:** exact S0/S1 ordering выше; concurrent X/Y + compact resolve в обоих порядках; resource-scoped request-start generations; A/B/context isolation; equal compact + event; full tails ownership; deleted/missing/transient; stale then/catch/finally.
2. **Session/handoff:** dialog -> tab preservation; one writer/owner; late hydration/storage sequence; submit/save с typed successor; attachments/reply; legacy migration order.
3. **Navigation/resources:** addressed review/editor nonce; cross-team refs; task-tab dedup/context normalization; hidden work suppression; two visible panes без focus; one log IPC owner.

Сохранить ценные assertions из `TaskDetailDialog.test.ts`, `teamSliceContextRace.test.ts`, `PaneContent.test.tsx` и draft/comment/context tests. Expectations задавать literals/fixtures, не вычислять production helper. Нет coverage/test quota.

## Focused Electron E2E

Harness использует реальный **Electron `pnpm dev:mcp` + preload IPC + main task readers/writers + filesystem watcher**. Real projects/teams, provider/runtime/agent/terminal launches запрещены. Browser mode, Computer Use и native picker не используются.

Fixture создает run-owned scratch root c manifest, `TEST-project-A/B`, двумя UUID team names, отдельными config/members/team meta/kanban/task files и одинаковым canonical task ID; teams idle и без process records. HOME/Claude root/Electron userData/`CLAUDE_CONFIG_DIR`/XDG/TMPDIR задаются только child app. Hosted run использует worker-owned scratch и не меняет agent env/home.

Reuse pattern `scripts/e2e/group-chats-desktop.ts`: deny-runtime wrapper отвечает только на `runtime.lock.json` version, пишет audit и отвергает provider/lifecycle command exit 77; любой lifecycle invocation делает run red. Harness владеет единственным `dev:mcp`, извлекает фактический CDP port из собственных logs, фиксирует SHA/diff/fixture/PID/process group и не attach к пользовательскому app. Linux использует `xvfb-run`.

Один сценарий:

1. Открыть A через dialog; проверить full tails; ввести typed comment text/chips, dirty description/reply и маленький fixture attachment через DOM file input; открыть tab. Проверить handoff/dedup/отсутствие truncation/autosend.
2. Открыть B с тем же canonical ID во второй pane; сохранить B subject/description/groupChat/owner существующим UI. Проверить persisted **B** JSON и unchanged A, labels/projectPath chips; без assignment/agent activity.
3. Открыть dialog A рядом c A/B tabs. Атомарно перезаписать sandbox task/kanban JSON вне renderer. Через real watcher проверить dialog/tab A, unchanged B и active passive pane без keyboard focus. Затем suffix-only rewrite оставить compact projection равной и проверить новые tails через event-driven full successor. Screenshot обеих identities. Отдельный unit evidence доказывает, что delayed stale compact response не восстанавливает старые status/owner/comments.
4. Отправить один sandbox comment из tab; проверить один persisted comment, shared appearance в dialog и сохраненный newer draft. Hide/reactivate/move A сохраняет session/inline state.
5. Cancel delete A; confirm delete B; проверить read-only deleted без stale controls на B surfaces, close/reopen A и отсутствие renderer errors/runtime launches.

Async races остаются unit tests. E2E не заменяет controlled store/API tests и обязан пройти watcher assertion без forced renderer refresh. Dev-store staging допустим только для pane navigation/evidence readback, не для data correctness.

Artifacts: `evidence.json` c exact SHA/assertions, desktop log, runtime audit, before/after task JSON/hashes и handoff/live screenshots. Exit 0 только после содержательных assertions; failure сохраняет evidence. Cleanup останавливает только owned app/process/CDP.

## Estimated implementation size

LOC — staffing evidence, не completion percentage; delivery обязан замерить фактические changed/new/moved production LOC.

| Category | Evidence-backed estimate | Dominant uncertainty |
| --- | --- | --- |
| New handwritten production | **1,100-1,900 LOC** | Read/session adapters и addressed routing после удаления дублирующей dialog logic. |
| Existing production moved/refactored | **700-1,300 LOC** | Extraction из `TaskDetailDialog.tsx` (1,709 строк), comment sections (669+457), wiring `TeamDetailView.tsx` (3,745) и stores; moves не считаются новой логикой. |
| Focused critical tests | **650-1,100 LOC** | Число deferred promise fixtures для ordering/session/exclusivity. |
| Electron E2E + helpers | **450-800 LOC** | Надежный synthetic fixture/CDP assertions; reference `group-chats-desktop.ts` — 517 строк. |

## Verification commands

```sh
git diff --check
pnpm lint:fast:files -- <только затронутые production TS/TSX>
pnpm exec vitest run \
  test/renderer/store/teamTaskDetailSourceAuthority.test.ts \
  test/renderer/store/teamTaskDetailSession.test.ts \
  test/renderer/store/teamTaskDetailNavigation.test.ts \
  test/renderer/components/team/dialogs/TaskDetailDialog.test.ts \
  test/renderer/store/teamSliceContextRace.test.ts \
  src/renderer/components/layout/PaneContent.test.tsx
pnpm typecheck
pnpm guard:source-file-size
pnpm lint
xvfb-run -a -s '-screen 0 1440x1000x24' pnpm exec tsx scripts/e2e/task-detail-tabs-desktop.ts
pnpm build
```

Workload запускается один раз с сохраненным handle/evidence. Обязательный broad CI — на final implementation SHA. Не запускать `pnpm dev:web`, real-data smoke, agent launch smoke, `pnpm lint:fix`, глобальный `tsc7`, coverage sweep или unrelated formatting.

## Rollback / kill switch

Task file schema/backend API не меняются; feature flag/platform kill switch не нужны. При checkpoint rollback сначала убрать tabs/live integration, но оставить shared read/session, пока dialog его использует.

Tab representation backward compatible: rollback старого renderer code игнорирует `taskDetail` и восстанавливает обычный `type: 'team'` tab, а не blank/unknown tab. Context normalization отбрасывает только malformed/mismatched task metadata. Legacy draft migration неразрушительна; новые draft keys не удаляются автоматически при rollback.

## Acceptance criteria

- Kanban/graph/sidebar/links сохраняют dialog; loaded dialog содержит localized «Открыть в отдельной вкладке» возле верхнего заголовка и создает top-level task tab.
- Несколько задач разных команд с одинаковыми canonical ID открыты вместе; dedup точно `context+team+canonical ID`; label показывает team identity/current subject.
- Dialog/task tab/graph используют один live read-model и полные untruncated details. Fields/owner/groupChat/comments/history/status/changes/deletion синхронизируются после event/mutation без manual refresh; suffix tails не теряются.
- Никакой delayed compact snapshot или older-start full response не регрессирует newer accepted full status/owner/comments/tails того же resource. Generation provenance относится к request start, не completion; concurrent X/Y same team выполняют exactly one full read each absent real invalidation и не создают cross-task successors.
- Global/task reads не меняют `selectedTeamName`/`selectedProjectId`; ordinary open/dedup/inbox/keyboard/team refresh/labels выбирают только ordinary tabs, а task actions — только task tabs. Каждый async path несет identity/epochs и не пишет чужую scope.
- Dialog -> tab сохраняет text/chips/attachments/reply/dirty edits/submit state. Hidden tab, split move и live update не сбрасывают drafts; success завершает только submitted revision.
- Hidden tabs не создают background polling/read marking; все active split panes live без keyboard focus; log IPC tracking имеет одного owner.
- Existing dialog capabilities, structured cross-team refs и существующие review/editor lifecycle доступны; параллельных независимых editors нет.
- Missing/deleted/transient/team-unavailable различимы; stale fallback не воскрешает deleted tasks.
- Новые production files проходят size guard, public feature entrypoints используются callers, unrelated changes отсутствуют.
- Focused critical tests, exact-source sandbox Electron E2E c real IPC/watcher, typecheck/lint/build и обязательный exact-head CI доказаны; implementation review final SHA не имеет unresolved blockers.

## Round 4 findings and targeted final correction

| Finding | Resolution |
| --- | --- |
| Bare `type:'team'` влияет на open/dedup, inbox read, shortcuts и whole-team refresh, не только render. | Полный branch audit, центральные predicates, ownership и positive/negative tests. |
| Round 3 gate относился только к `refreshTeamData`, но `selectTeam` также commit-ит snapshots/global tasks. | Общий request-start gate покрывает оба snapshot paths. |
| Missing canonical task rejected `Task not found`, а не только successful `null`. | Точная missing classification; transient/provisioning/draft разделены. |
| `teamSlice.ts:3051` — label sync, а не deletion cleanup. | Label exclusivity и `clearDeletedTeamLocalState`/delete cleanup разделены. |
| **Targeted correction после primary final audit:** global latest-started serial на `context+team` делал full X/Y взаимно stale, а one current identity не представлял several open tasks; это создавало fetch churn/starvation при simultaneous tabs. | Team snapshot serial покрывает только `selectTeam`/`refreshTeamData`; per full task identity epoch/latest-started serial покрывает `getTask`; synchronous source invalidation сохраняет S0/cross-endpoint protection без cross-task cancellation/successors. |
| One-shot section/scroll seed расширял requested handoff. | Удален; сохраняются только draft/chips/attachments/reply/inline state. |
| File/change/chip/attachment actions могли потребить editor request другого pane. | Surface file identity + addressed target ordinary team tab request. |
| LOC-оценка отсутствовала и смешивала extraction moves. | Раздельные evidence-backed ranges; delivery публикует факт. |

Planning blockers: **нет**. Остаются обязательные implementation gates, а не planning blockers: production implementation, focused critical tests, real synthetic Electron E2E, independent exact-code review, PR и broad CI. Имена helpers/actions можно уточнять без ослабления identity, resource-scoped ordering, ordinary-tab exclusivity, handoff и acceptance contracts.
