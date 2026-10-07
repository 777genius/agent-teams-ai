# Управление командами с помощью промпта

Пересмотренный план, 2026-10-08. Заменяет прежний editable checklist/preset-switch план. Create-only core уже поставлен в merged PR #847-#850; здесь описано его продолжение. Эта правка меняет только документ, без тестов/runtime-запусков.

## Цель и принятый UX

В списке команд кнопка **Manage teams with a prompt** (локализованная: **Управлять командами с помощью промпта**) открывает popup. Сначала пользователь пишет свободный запрос; ниже смотрит встроенные TEAM templates и участников как справку. Copy формирует один prompt для внешнего агента с запросом, определениями шаблонов и действующим MCP/CDP подключением. Целевой сценарий: одним запросом создать несколько команд, изменить существующие и переместить ненужные в корзину.

✅ Шаблоны и roster здесь read-only. Никаких чекбоксов, редактирования имён/ролей, обязательного выбора типа, preset snapshots или второго team editor. Подсказка прямо объясняет: назвать шаблон в запросе, изменить имена/роли/обязанности и попросить несколько команд. Каталог подходит разным проектам, без SaaS-only терминологии.

Attachments API Engineer/Backend Lead - материал для кратких role briefs: уточнение контрактов, bounded ownership, meaningful checks, independent review, handoff/evidence. Не переносить придуманные model names, department hierarchy, постоянные approval gates, обязательные Slack/GitHub, outbox/аудит/SLO платформу или требование полного теста для каждого изменения.

🔒 [Принятый core-план](external-agent-mcp-cdp-team-templates.md) остаётся authority MCP lifecycle, binding, CDP и providerless marker. Его прежний create-only сценарий расширяется **явно**: configuration edit + reversible trash + наблюдаемое обновление списка. Эти capabilities не считать уже реализованными и не добавлять молча во все старые copy actions.

## Проверенная отправная точка и gaps

| Уже есть | Что требуется для нового сценария |
| --- | --- |
| `src/features/team-templates/core/index.ts`: четыре `TeamTemplateV1`; `ExternalAgentPromptAction/Dialog` и `TeamTemplateReferences` уже реализованы. | Менять help/prompt по proven capabilities; read-only UI не строить заново. |
| `RosterParticipantFrame/Identity` уже общие для `MemberDraftRow`, `LeadModelRow` и каталога; create/launch используют тот же roster composition. | Сохранить прямой reuse этих display primitives, без новой extraction или disabled editor. |
| MCP `team_list/get/create`; controller связывает их с HTTP. | Нет configuration-update/trash tools; добавить узкие tools, не arbitrary patch/shell. |
| HTTP create/get; IPC updateConfig/replaceMembers/deleteTeam. | Общие application use cases и HTTP parity; HTTP не вызывает IPC handler. |
| Edit dialog сохраняет config и roster отдельными вызовами; только roster использует `runLiveRosterMutation`. `updateConfig/deleteTeam/restoreTeam` обходят этот gate. | Configuration-only edit без runtime side effects; общий persistence/lifecycle seam с manual writers, честные partial results. |
| `runLiveRosterMutation/tryRunLiveRosterMutation` и launch admission используют existing team lock; `fingerprintSavedLaunchSettings` исключает presentation/roster. | Переиспользовать lock, но добавить management revision и fresh snapshot, а не выдавать saved-launch fingerprint за полную revision. |
| deleteTeam записывает deletedAt в config.json; restore снимает marker. | Draft без config не поддерживает trash. deleteDraft вызывает permanent deletion и категорически не подходит. |
| TeamChangeEvent проходит IPC и HTTP SSE; store coalesces fetchTeams, защищает context/request ordering. | Явный сигнал после committed management mutation и короткая информация об изменении; watcher не знает его причины. |
| TeamList сортирует running/project/activity и отдельно показывает Trash. | Временный приоритет created/edited без изменения lastActivity/runtime status. |

## Scope и ограничения первой поставки

In scope: уточнить existing popup/help и единый prompt builder, MCP create/update/trash, draft-trash/restore parity, list refresh и краткую информацию о последних изменениях. Existing request persistence/read-only каталог сохраняются; их переписывание в оценку не входит.

Каталог остаётся `feature/bug/review/research`, без маркетинга и Full SaaS HQ. Все четыре коротких определения входят в copied prompt: UI не угадывает references через regex/NLP, агент выбирает по запросу. Каталог - data, не authorization/permissions. Existing teams агент читает через list/get; popup не копирует все team snapshots или workspace.

Допустимые edits: displayName, description/color, lead instructions, active teammate names/roles/workflows. Directory teamName не переименовывается. Provider/model, marker, cwd/worktree/isolation, flags, MCP policy, credentials и launch identity сохраняются; runtime настройка и перенос между проектами здесь не поручены.

Рекомендуемый bounded MVP: создавать drafts; изменять и trash только drafts/остановленные команды, вне provisioning. Running/provisioning возвращают TEAM_ACTIVE/TEAM_PROVISIONING до writes; агент объясняет необходимость остановки в приложении. Автоматического Stop/Restart/Force-stop нет. Это явное ограничение configuration-only scope, а не обещание полного live управления.

Out of scope: launch/назначение задач/сообщения агентам, live roster reconciliation, permanent delete/empty trash, automatic restore, batch transaction/rollback engine, persistent change history/receipts/pins, full audit/event sourcing/diff viewer, собственный AI runner, SDK fallback, RBAC/auth platform, template CRUD, новое discovery/endpoint ownership.

## Popup и общий roster display

```text
Управлять командами с помощью промпта                 Закрыть
Что нужно сделать?
[Создай команды разработки и проверки для импорта CSV.
 Основой возьми feature и review. В старой team-a ...]
Назови шаблоны ниже, измени роли/имена словами, запроси несколько команд.
Можно менять остановленные команды и убирать их в корзину.

Доступные шаблоны команд (справка)
Build a feature          Plan, implement, independently review
[Coordinator] [planner / Architect] [builder / Developer] [...]
Fix a bug               ...       [раскрыть обязанности]
Review code             ...       [раскрыть обязанности]
Research a solution     ...       [раскрыть обязанности]

MCP ready • UI access off            [Настройки подключения]
[Посмотреть итоговый prompt]         [Скопировать prompt для агента]
```

Поле запроса первое и получает initial focus; пустое поле блокирует Copy с inline подсказкой, без validation step. Пример - placeholder. Сохранять запрос отдельно от createTeamDraft, scoped к стабильному profile/root через existing draft hook, без ephemeral appInstanceId в storage key; Copy/закрытие его не очищают. Поздняя hydration не стирает fresh input.

Все четыре названия/descriptions видны; workflow раскрывается shared Collapsible. Карточки справочные: нет применения или скрытого изменения manual draft. Роли/coordinator видны; model/provider/permissions controls отсутствуют.

DRY: `TeamTemplateReferences.tsx` уже использует `RosterParticipantFrame`/`RosterParticipantIdentity` из `src/renderer/components/team/members/RosterParticipantFrame.tsx`, palette/avatar helpers и layout tokens. CreateTeamDialog/launch сохраняют inputs/actions внутри того же presentation; каталог оставляет статические name/role/workflow. Не монтировать MemberDraftRow с no-op callbacks, не запускать provider discovery ради справки, не копировать MemberCard и не делать schema-driven UI. Frozen rows/dialogs не увеличивать сверх cap.

Shared Radix Dialog/Button/Collapsible/Tooltip, existing Textarea/Label. Read-only content selectable; keyboard/focus return, aria descriptions/errors, visible focus, короткий Copied/error live status. Dark/light, zoom и narrow около 320 CSS px: одна колонка без horizontal page scroll; button/portal не перекрывают текст. Ориентиры: [WAI grouping](https://www.w3.org/WAI/tutorials/forms/grouping/), [WCAG reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html).

## Prompt и внешний клиент

Расширить единственный `buildExternalAgentPrompt` в `src/features/external-agent-connection/core/domain/connectionPrompt.ts`: existing freeform request + templates[] + live snapshot + явный create/manage intent. Старый template-create caller сохраняет create-only intent. Management instructions перечисляют только proven capabilities; текущая schema имеет лишь draftCreation/rendererControl, поэтому edit/trash help нельзя включать заранее. UI не собирает второй bootstrap текст и не владеет endpoint настройками.

Copy получает свежий snapshot, сверяет profile/app/root и пишет clipboard ту же строку, что доступна в read-only preview. Включить exact MCP URL, appInstanceId/dataRootFingerprint/connectionGeneration, observedAt; при CDP ready/opt-in - exact origin, browser/renderer WebSocket, targetId/targetGeneration. Request/templates отделены от trusted connection policy. MCP unavailable блокирует Copy; CDP off/restart-required даёт честный MCP-only prompt. Edit/context change инвалидирует Copied; clipboard failure оставляет selectable preview, не вызывает mutation.

Агент: native MCP discovery -> сверить app/root/generation -> list/get нужных команд -> только требуемые create/edit/trash -> readback каждого результата -> success/failed/uncertain по каждой команде. Просьба убрать означает trash, никогда hard delete. Нет launch/stop/tool-permission изменений. DisplayName не identity: при неоднозначности нужен точный teamName, без угадывания targets.

Сохраняются actual client registration, reload/new-session и localhost/local-executor ограничения core. Prompt сам не добавляет native tools; shell registration не доказывает, что текущий agent session их загрузил. Hosted/cloud agent не получает доступ к loopback пользователя автоматически. Проверять команды по установленному клиенту и [Claude Code MCP](https://code.claude.com/docs/en/mcp)/[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli); если native discovery недоступно, сообщить конкретный шаг/ограничение, без JSON roundtrip, туннеля или нового client helper. Raw CDP остаётся full renderer trust; domain mutations идут MCP, не кликами по permanent-delete UI. Отсутствие hard-delete в новых tools - контракт flow, не новая security граница широкого endpoint/preload.

## Mutation contracts и ownership

Ownership: connection feature владеет popup/bootstrap, `team-templates` - authoritative definitions, team application boundary - persistence policies. Добавить только нужные configuration use cases рядом с existing team feature/service; composition получает focused store/lifecycle gate/context/emitter ports, не whole-service host, inheritance или universal manager. `src/main/ipc/teams.ts`, `src/main/http/teams.ts`, `mcp-server/src/tools/teamTools.ts` и `agent-teams-controller/src/internal/runtime.js`/`desktopControlBinding.js` остаются adapters общего use case. HTTP не вызывает IPC; renderer через app API. Policies browser-safe; filesystem/HTTP/Electron снаружи.

Новые tools: team_update и team_trash, strict schemas без permanent/path/arbitrary flags/relaunch. Target - точный `teamName` из list/get; displayName служит поиску, совпадающие displayName требуют уточнения. Требуют expectedContext и непрозрачный expectedRevision из fresh get. Controller переносит поля до HTTP; main проверяет expectation и immutable child binding, держит existing `BoundControlContext` root fence до конца операции. Discovery capabilities additive отражают реально доступные edit/trash; отсутствие поля означает unsupported.

`team_update` принимает ровно одну группу за call: metadata patch, lead-instructions replacement или active-roster replacement. Unknown/forbidden поля отклоняются. Metadata: omitted сохраняется, empty очищает только optional description/color, empty displayName invalid. Lead instructions: omitted недопустим для этой группы, empty явно очищает сохранённое поле. Roster: omitted недопустим, [] означает lead-only; роли/workflow являются replacement значениями для переданных active members.

Для update использовать узкие группы, не обещать общую транзакцию нескольких файлов:

| Контракт | Write и ожидаемый результат |
| --- | --- |
| create | Existing draft writer, marker=1, existing name-conflict fence. Новый draft unresolved; no launch. Tracking management intent additive, не permission/identity bypass. |
| update metadata | Draft пишет team.meta; обычная команда использует canonical config writer и синхронизирует соответствующие existing saved-launch metadata, чтобы следующий launch не вернул старые values. Не синтезировать launch metadata для imported legacy команды. |
| update lead instructions | Сохранённое `team.meta.prompt`. Не менять legacy/providerless semantics или создавать launch metadata с defaults ради успешного ответа. Нет saved request - unsupported, не no-op success. |
| update roster | Merge с authoritative roster до `TeamDataService.replaceMembers`: этот writer сейчас сбрасывает omitted provider/model/MCP fields. Сохранять их у прежних members, lead и removed tombstones; новым - existing inheritance, unresolved draft не получает provider defaults. |
| trash | Только deletedAt: draft team.meta, обычная команда config. Никаких unlink/rm/permanent coordinator. Already trashed - unchanged, без новой даты/ложной activity. |

Один запрос может использовать несколько tools на одну команду. После каждого call fresh get даёт revision для следующего. Metadata + roster в двух calls - отдельные commits данных: failure второго не откатывает первый. No-op возвращает unchanged, без Edited/event. Агент не подменяет edit новой командой и не скрывает failure новым именем.

Member name - persisted identity: сравнение по existing case-insensitive policy, не по role. Переименование = explicit remove old + add new в replacement roster, с tombstone старого имени; histories/tasks/inboxes не переписываются и старый agentId новому не переносится. Роли/workflow прежнего имени меняются без сброса его runtime settings. Reserved/duplicate/invalid имена отклоняются до writes.

Existing atomicWrite даёт atomic replacement отдельного файла, **не** crash transaction всего draft/нескольких files. Create уже пишет несколько artifacts: сохранять его identity fence/узкий rollback, а после неизвестного исхода readback required fields. Любой reused writer с несколькими writes имеет explicit partial/uncertain результат; не вводить crash journal или глобальный transaction engine ради этого flow.

Revision: additive `configurationRevision` в `team_get`, непрозрачный fingerprint persisted writable config/meta/members, marker/deletedAt и identity директории, без runtime/activity timestamps и mtime-only identity. Existing `fingerprintSavedLaunchSettings` не достаточен: он исключает displayName/description/color, roster и trash. Get читает coherent fresh snapshot под тем же focused gate; mutation внутри него проверяет context, existence/identity, provisioning/alive/deletedAt, expectedRevision, затем пишет и делает readback. Recreate имени инвалидирует token; stale/busy отказ не делает writes. Не сверять revision с тёплым worker/config cache.

Fingerprint соблюдает existing file limits до allocation и ограничивает actual reads при росте файла. Unreadable member metadata запрещает management writes. Stopped config-only команда без member metadata возвращает existing roster через GET, но replacement roster отклоняется до writes, чтобы не потерять provider/model/MCP/history; новые saved drafts без config остаются writable. Не добавлять второй parser ради legacy hydration.

🚨 Общий gate - обязательный seam первой поставки: existing `runLiveRosterMutation/tryRunLiveRosterMutation` нормализуют ключ `trim().toLowerCase()` и делегируют в тот же `withTeamLock`, что launch admission. Добавить focused adapter этого gate, без второй map/framework. Через него провести actual writes manual metadata/roster/trash/restore и management use cases. Сохранить manual UI semantics: best-effort Stop у manual trash выполняется до узкой persistence gate; не оборачивать весь stop-helper и не брать второй non-reentrant lock внутри. При переносе draft rename/delete и permanent-delete учитывать existing name/identity coordinator: competing identity writers не должны обходить fenced read/write. Закрывать только участвующий seam, не рефакторить весь provisioning.

Launch должен проверять trash и потреблять fresh saved configuration уже под этим gate: HTTP draft launch сейчас читает saved request/делает rename до admission. Между чтением и admission нельзя запускать уже trashed draft или перезаписать свежие edits stale launch snapshot. Normal `buildLaunchSyntheticRequest` берёт config name/color, но не description; `persistDeterministicLaunchMetadata` заменяет team.meta и пишет `request.prompt`. Нужна узкая preservation parity: description и saved lead instructions переживают следующий launch; omitted launch prompt наследует свежий saved prompt, explicit user prompt имеет приоритет. Это исправление потребителя сохранённых settings, без нового launch flow. Configuration-only tools сами launch/stop не вызывают.

При HTTP rename черновика destination identity/lifecycle gate удерживается через rename и provisioning continuation существующего `renameDraftTeam`. Проверка занятого destination остаётся до второй блокировки; manual two-argument rename сохраняет прежнее поведение.

Гарантия первой поставки охватывает participating app writers одного bound main process. File-system edits/другой app process на shared root не превращаются в безопасный CAS от одной проверки hash. Не обещать cross-process atomicity и не добавлять root registry/global transaction engine; если текущий supported workflow требует её, это отдельный доказанный dependency до включения edit/trash.

Draft trash: добавить deletedAt в `TeamMetaStore` read/write normalization, `TeamConfigReader` и `src/main/workers/team-fs-worker.ts` draft summaries, get/restore и launch/update admission; `team-data-worker` нужен для cache invalidation. Config не синтезируется ради trash. UI restore возвращает тот же draft/marker/roles; missing/already restored не создаёт новый draft. Existing permanent-delete UI сохраняет отдельный контракт; management никогда не вызывает deleteDraft. Restore доступен existing UI flow, новый MCP restore tool пока не нужен.

## Change info и list refresh

Основа - маленький typed management result DTO в response/event: operationId, committedAt, kind created/edited/trashed, changed-field keys и counts/до трёх имён roster changes. Summary вычисляет server по actual before/after, renderer локализует keys; не доверять AI description, не хранить prompts/secrets/diffs. Никакого дополнительного файла/store на диске, receipt reader, history или full diff engine.

Сведения session-only: existing renderer store держит context-scoped map последнего notice на команду, максимум 20 последних команд. После reload/root switch детали и подсветка исчезают; initial/resume fetch восстанавливает сами команды. Без TTL timers, persisted cursors, replay или отдельного activity store; persistent last-change обсуждать лишь при реальном запросе на history.

Result metadata после confirmed commit/readback, вторично относительно команды. Недоступный summary/event delivery не превращает saved mutation в failed и не повторяет write. Duplicate operationId не создаёт второй notice; более старый committedAt не заменяет новый notice, равные timestamps используют стабильный teamName tie-break для списка. Текст описывает недавнее действие, не аудит всех последующих edits.

После commit invalidate existing team/config/list caches и отправить TeamChangeEvent(type=config) с additive management result/context metadata через current IPC onTeamChange и HTTP SSE team-change. Reuse `src/main/index.ts` fanout и `src/renderer/store/index.ts` listener; watcher остаётся fallback, не summary authority. Duplicate signals coalesce; каждый success обновляет list, без ожидания конца всего prompt. Revision не используется как ordering token; event ordinal/watermark или новый event bus не нужны.

Response-to-UI race: event может прийти раньше ответа внешнему клиенту или list readback. Сначала сохранить notice и schedule existing scoped refresh; показать его на canonical card только когда команда есть в актуальном list, без synthetic duplicate row. Если initial fetch уже in flight, поставить один follow-up refresh после него: нынешний fetchTeams guard может иначе пропустить invalidate. Не считать badge доказательством сохранения и не ждать UI acknowledgment перед success response.

Store делает existing scoped fetchTeams, для открытой команды refreshTeamData. External trash извлекает/reuses cleanup из `teamSlice.deleteTeam`, без повторного delete call: clear selection, team-local epochs/transient tombstones; поздние replies не воскрешают карточку. Trash очищает notice сразу; отсутствующий target - после fresh readback, начатого после event, чтобы старый snapshot не стёр pending create. Не создавать runtime/process event ради refresh. IPC/HTTP consumers получают одинаковые DTO; stale-root event/response игнорируется до badge/reorder.

Created/edited - сверху текущего **отфильтрованного** списка в Recent changes группе, existing `TeamListView.tsx` cards, без duplicate rows. Newest committedAt first; badges Created/Edited (локализованные Создана/Изменена), одна строка например `Роли: +2/-1; изменено описание`, если facts известны. Trash уходит только в existing Trash section.

Session highlight живёт до reload/context reset либо вытеснения из bounded map. Не менять user order/project filter/running status/lastActivity. Нет новых polling loops или таймера завершения batch. Filter скрывает результат - короткая подсказка и existing clear-filter action, без автоматического сброса фильтра.

Нет spinner выполнения внешнего prompt: приложение не знает, подключился ли агент и завершил ли все tools. Copied означает clipboard success; UI показывает committed changes/connection status. Краткий disabled Copy лишь на фактическом snapshot/clipboard await; никаких задержек или batch-complete по idle timer.

## Edge cases и recovery

| Ситуация | Поведение / evidence |
| --- | --- |
| Несколько команд, failure на второй | Первые successes видны; separate readback/result. Нет all-or-nothing или automatic rollback/trash успешных. |
| Потерян mutation response | Get исходного teamName, сверить desired fields/deletedAt/revision. Confirmed state - success; conflicting/uncertain - stop, не blind retry/new name. |
| Concurrent manual edit/launch/recreate | Общий normalized gate + fresh revision/identity/lifecycle check до write. Busy/stale - явный отказ и fresh get, без blind retry/overwrite; launch после trash тоже отклоняется. |
| Missing/already trashed | Missing - not-found; trash again unchanged; update trashed rejection. Не auto-restore. |
| Empty/invalid roster/name collision | Общая create/roster validation до commit; lead-only разрешён, malformed строка не silently dropped. |
| Root switch/reload/SSE gap | Context fence защищает write; scoped fetch восстанавливает list. Root/reload очищает notices; пропущенные details не восстанавливаются. |
| Data saved, event/refresh failure | Mutation success сохраняется; notice может отсутствовать. Snapshot refresh без повторного mutation. |
| Duplicate/late event или initial fetch in flight | operationId/committedAt и existing context/request epochs защищают notice/list; один follow-up refresh, без прогресс-state machine. |
| Crash между writes | Readback/partial outcome; не подтверждать полный desired edit по наличию только team directory. |

## Phases, проверки и оценка

1. Existing UI checkpoint: проверить reuse/readonly/help/actual Copy, добавить capability-aware create/manage intent без нового UI editor. Не обещать edit/trash до наличия tools; implemented core не переписывать.
2. Management contract checkpoint: сначала общий gate/manual-writer seam, fresh revision и launch-consumption parity; затем metadata/lead edits, roster/trash + draft restore. Capability открывается только вместе со всеми её guards, HTTP/controller/MCP и focused proof; core create-only path сохраняется.
3. Observable result checkpoint: typed result/event facts, session-only map, existing fanout/store cleanup, badges/top ordering. Без дополнительной persistence/event platform/full diff.

Meaningful tests ближайшей сильной границы: расширить `mcp-server/test/http.e2e.test.ts` create -> narrow edit -> trash -> get/list, stale context/revision и отсутствие hard deletion. Writer/lifecycle integration с sandbox roots/fake runtime ловит сброс marker/provider/MCP fields, rename tombstones, draft restore и metadata/lead preservation при launch. Её concurrency contract: paused management mutation конкурирует с actual manual metadata/trash/restore и launch по одному normalized key; management stale revision и trashed/active/provisioning отказывают до writes. Existing `TeamProvisioningRosterMutationLock.test.ts` lock/reentrancy tests сохранить и переиспользовать, не дублировать проверку самого lock. `test/renderer/store/teamChangeThrottle.test.ts` boundary ловит event-before-response/list, initial-fetch invalidate, root isolation, external-trash cleanup и reload reset. Один Electron UI flow доказывает readonly participant reuse и multi-team partial results. Нет source-text tests или DTO snapshots. Перед тестом назвать поломку, которая его сделает красным; не повторять сценарий на каждом слое.

Future gates: pnpm typecheck, focused lint/tests, source-size/provisioning architecture guards по diff; MCP/controller checks по новым contracts. UI только Electron pnpm dev:mcp/CDP на новом sandbox/test project, isolated roots/userData, без Computer Use/native picker. Heavy proof hosted; реальные пользовательские проекты/launch/terminal/agent actions запрещены. Handwritten harness TS/MTS с typecheck.

Ориентир сверх implemented core: UI/prompt 100-180 production LOC; configuration/draft trash/revision 700-1 100; result/event/store/list 150-250. **Production 950-1 530, meaningful tests 330-480, docs/i18n 50-100; всего 1 330-2 110 changed LOC. 🎯 7/10 🛡️ 8/10 🧠 6/10.** Рост относительно прежней оценки - закрытие подтверждённых manual-writer/launch seams и preservation tests; existing popup/roster/MCP/CDP не считаются заново. Верхняя граница зависит от identity-coordinator wiring; cross-process CAS не включён. Dependency-safe checkpoints около 2 000 LOC, без разрезания context/revision invariants.

Acceptance: свободный запрос без roster form; четыре состава в знакомом read-only представлении; native клиент сохраняет несколько providerless drafts, изменяет stopped/draft и trash без hard delete/launch. Manual writers и launch не обходят общий gate; management stale revision/active/provisioning отклоняются до writes, trashed draft не запускается, saved edits переживают restore и следующий launch. Каждый committed result refreshes list; created/edited сверху с достоверным bounded session-only summary. После reload остаются команды, без старой подсветки/details. Partial failure/stale context не скрываются; mutation success независим от clipboard/badge/event delivery.

Rollback: убрать management entry/tools/view и очистить ephemeral notices, оставить данные и compatible deletedAt/marker readers. Create-only prompt не откатывает edits/trash и не отзывает CDP/MCP; connection shutdown/restart остаётся core policy.

📌 Один свободный запрос, read-only templates и Copy; затем узкие configuration mutations и фактические результаты. Сложность в draft trash/concurrency/refresh, а не в выборе отделов.
