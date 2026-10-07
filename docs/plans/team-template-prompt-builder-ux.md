# Управление командами с помощью промпта

Пересмотренный план, 2026-10-07. Заменяет прежний editable checklist/preset-switch план. Только документ; реализации, тестов и runtime-запусков нет.

## Цель и принятый UX

В списке команд действие **Управлять командами с помощью промпта** открывает popup. Сначала пользователь пишет свободный запрос; ниже смотрит встроенные TEAM templates и участников как справку. Copy формирует один prompt для внешнего агента с запросом, определениями шаблонов и действующим MCP/CDP подключением. Один запрос может создать несколько команд, изменить существующие и переместить ненужные в корзину.

✅ Шаблоны и roster здесь read-only. Никаких чекбоксов, редактирования имён/ролей, обязательного выбора типа, preset snapshots или второго team editor. Пользователь словами указывает основу и адаптации. Большие role briefs из attachments остаются предложениями: берём краткие обязанности/handoff/evidence, не model names, бюджеты, департаменты или обязательные Slack/GitHub.

🔒 [Принятый core-план](external-agent-mcp-cdp-team-templates.md) остаётся authority MCP lifecycle, binding, CDP и providerless marker. Его прежний create-only сценарий расширяется **явно**: configuration edit + reversible trash + наблюдаемое обновление списка. Эти capabilities не считать уже реализованными и не добавлять молча во все старые copy actions.

## Проверенная отправная точка и gaps

| Уже есть | Что требуется для нового сценария |
| --- | --- |
| Четыре `TeamTemplateV1`; `TeamRosterEditorSection -> MembersEditorSection -> MemberDraftRow` используются create/launch. | Read-only reuse seam: MemberDraftRow требует edit callbacks и запускает model/workflow hooks; disabled props не превращают его в чистый preview. |
| MCP `team_list/get/create`; controller связывает их с HTTP. | Нет configuration-update/trash tools; добавить узкие tools, не arbitrary patch/shell. |
| HTTP create/get; IPC updateConfig/replaceMembers/deleteTeam. | Общие application use cases и HTTP parity; HTTP не вызывает IPC handler. |
| Edit dialog сохраняет config и roster отдельными вызовами; live mutation может restart/remove runtime members. | Configuration-only edit без runtime side effects; partial results должны быть честными. |
| deleteTeam записывает deletedAt в config.json; restore снимает marker. | Draft без config не поддерживает trash. deleteDraft вызывает permanent deletion и категорически не подходит. |
| TeamChangeEvent проходит IPC и HTTP SSE; store coalesces fetchTeams, защищает context/request ordering. | Явный сигнал после committed management mutation и короткая информация об изменении; watcher не знает его причины. |
| TeamList сортирует running/project/activity и отдельно показывает Trash. | Временный приоритет created/edited без изменения lastActivity/runtime status. |

## Scope и ограничения первой поставки

In scope: popup, сохранение свободного текста через existing draft persistence, read-only каталог, один prompt builder, MCP create/update/trash, draft-trash/restore parity, list refresh и краткая информация о последних изменениях.

Каталог остаётся `feature/bug/review/research`, без маркетинга и Full SaaS HQ. Все четыре коротких определения входят в copied prompt: UI не угадывает references через regex/NLP, агент выбирает по запросу. Каталог - data, не authorization/permissions. Existing teams агент читает через list/get; popup не копирует все team snapshots или workspace.

Допустимые edits: displayName, description/color, lead instructions, active teammate names/roles/workflows/isolation. Directory teamName не переименовывается. Provider/model, marker, cwd/worktree, flags, MCP policy, credentials и launch identity существующей команды сохраняются; runtime настройка и перенос между проектами здесь не поручены.

Рекомендуемый bounded MVP: создавать drafts; изменять и trash только drafts/остановленные команды, вне provisioning. Running/provisioning возвращают TEAM_ACTIVE/TEAM_PROVISIONING до writes; агент объясняет необходимость остановки в приложении. Автоматического Stop/Restart/Force-stop нет. Это явное ограничение configuration-only scope, а не обещание полного live управления.

Out of scope: launch/назначение задач/сообщения агентам, live roster reconciliation, permanent delete/empty trash, automatic restore, batch transaction/rollback engine, persistent change history/receipts/pins, full audit/event sourcing/diff viewer, собственный AI runner, SDK fallback, RBAC/auth platform, template CRUD, новое discovery/endpoint ownership.

## Popup и общий roster display

```text
Управлять командами с помощью промпта                 Закрыть
Что нужно сделать?
[Создай команды разработки и проверки для кабинета.
 Основой возьми feature и review. В старой team-a ...]
Можно создать несколько команд, изменить состав или убрать в корзину.

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

DRY seam: выделить маленький display-only roster frame/identity presentation из create/launch композиции; переиспользовать palette/avatar/lead helpers и layout tokens. Create/launch используют frame со своими inputs/actions, preview - со статическими name/role/workflow. Не монтировать editor с no-op callbacks, не запускать provider discovery ради справки, не копировать MemberCard и не делать schema-driven UI. Frozen rows/dialogs уменьшаются bounded extraction, не растут сверх cap.

Shared Radix Dialog/Button/Collapsible/Tooltip, existing Textarea/Label. Read-only content selectable; keyboard/focus return, aria descriptions/errors, visible focus, короткий Copied/error live status. Dark/light, zoom и narrow около 320 CSS px: одна колонка без horizontal page scroll; button/portal не перекрывают текст. Ориентиры: [WAI grouping](https://www.w3.org/WAI/tutorials/forms/grouping/), [WCAG reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html).

## Prompt и внешний клиент

Расширить единственный buildExternalAgentPrompt: freeform request + templates[] + live snapshot + MCP-only/with CDP. Старый template-create caller сохраняет свой явный intent; management instructions не подменяют его молча. UI не собирает второй bootstrap текст и не владеет endpoint настройками.

Copy получает свежий snapshot, сверяет app/root и пишет clipboard ту же строку, что доступна в read-only preview. Request/templates отделены от trusted connection policy. MCP unavailable блокирует Copy; CDP off/restart-required даёт честный MCP-only prompt. Полный вариант требует фактического CDP ready и existing opt-in. Edit/context change инвалидирует Copied; clipboard failure оставляет selectable preview, не вызывает mutation.

Агент: native MCP discovery -> сверить app/root/generation -> list/get нужных команд -> только требуемые create/edit/trash -> readback каждого результата -> success/failed/uncertain по каждой команде. Просьба убрать означает trash, никогда hard delete. Нет launch/stop/tool-permission изменений. DisplayName не identity: при неоднозначности нужен точный teamName, без угадывания targets.

Сохраняются actual client registration, reload/new-session и localhost/local-executor ограничения core. Prompt сам не добавляет tools. Raw CDP остаётся full renderer trust; domain mutations идут MCP, не кликами по permanent-delete UI. Отсутствие hard-delete в новых tools - контракт flow, не новая security граница широкого endpoint/preload.

## Mutation contracts и ownership

Маленький application facade рядом с existing team feature/service. Composition получает focused ports stores, lifecycle/team lock, context admission и change emitter; не whole-service host, inheritance или repository framework. IPC/HTTP вызывают те же use cases, renderer через app API. Policies browser-safe; filesystem/HTTP/Electron снаружи.

Новые tools: team_update и team_trash, strict schemas без permanent/path/arbitrary flags/relaunch. Требуют expectedContext и target snapshot revision из get. Controller переносит поля до HTTP; main проверяет payload expectation и immutable bound child context до admission, держит root fence до завершения. Старый prompt/child/root не меняет новый context. Discovery capabilities additive отражают реально доступные edit/trash; отсутствие поля означает unsupported, не готовность.

Для update использовать узкие группы, не обещать общую транзакцию нескольких файлов:

| Контракт | Write и ожидаемый результат |
| --- | --- |
| create | Existing draft writer, marker=1, existing name-conflict fence. Новый draft unresolved; no launch. Tracking management intent additive, не permission/identity bypass. |
| update metadata | DisplayName/description/color; draft пишет team.meta, обычная команда config. Omitted fields сохраняются; empty очищает только optional поле. |
| update lead instructions | Соответствующая team metadata. Не менять legacy/providerless semantics или создавать launch metadata с defaults ради успешного ответа. Нет saved request - unsupported, не no-op success. |
| update roster | Existing roster policy: сохранять runtime/MCP/identity неизменённых members, lead и removed tombstones; новым - existing inheritance. Empty означает lead-only. |
| trash | Только deletedAt: draft team.meta, обычная команда config. Никаких unlink/rm/permanent coordinator. Already trashed - unchanged, без новой даты/ложной activity. |

Один запрос может использовать несколько tools, в том числе на одну команду. Metadata + roster в двух calls - отдельные commits данных: failure второго не откатывает первый. No-op не выдаёт Edited. Агент не подменяет edit новой командой и не скрывает failure новым именем.

Existing atomicWrite даёт atomic replacement отдельного файла, **не** crash transaction всего draft/нескольких files. Create уже пишет несколько artifacts: сохранять его identity fence/узкий rollback, а после неизвестного исхода readback required fields. Любой reused writer с несколькими writes имеет explicit partial/uncertain результат; не вводить crash journal или глобальный transaction engine ради этого flow.

Revision - непрозрачный token текущих writable config/meta/members и identity директории, не displayName/hash prompt/mtime-only. Переиспользовать existing fingerprints и edit-source snapshot semantics. Проверить token внутри общей team mutation/lifecycle критической секции до write; recreate того же имени инвалидирует token. Existing launch admission и management mutation должны использовать общий lock/ключ: check inactive -> write нельзя гонять против launch. Это focused stale-overwrite guard, не version framework всего приложения.

Сравнение revision отдельно от write не является CAS. Проверить реальные lock/writer seams, включая ручной edit. При shared root двух app instances не обещать cross-process CAS без общей focused lock boundary и evidence. Внешние writers, не соблюдающие lock, не покрываются простым snapshot guard. Не вводить fictitious single-instance root lock; выявленный незакрытый race исправить в этой boundary или явно сузить заявленный contract, не скрывать в UI.

Draft trash: additive deletedAt normalization, summary/get/saved-request/restore parity и отказ launch/update trashed target. Config не синтезируется ради trash. UI restore возвращает тот же draft/marker/roles. Existing permanent-delete UI сохраняет отдельный контракт; management никогда не вызывает deleteDraft.

## Change info и list refresh

Основа - маленький typed management result DTO в response/event: server timestamp, kind created/edited/trashed, changed-field labels и counts/несколько имён roster changes. Summary вычисляет server по actual before/after, не доверяет AI description; без полных prompts/secrets/diffs. DTO - узкий future extension seam. В MVP нет дополнительного файла/store на диске, receipt reader, information writes или сверки списка с persisted change revision.

Сведения session-only: existing renderer store держит context-scoped map последнего notice на команду. После reload детали и подсветка исчезают; initial/resume fetch восстанавливает сами команды. Это принятое ограничение, не повод добавлять history/replay. Persistent last-change имеет смысл только после конкретного запроса на восстановление activity.

Result metadata после confirmed commit/readback, вторично относительно команды. Недоступный summary/event delivery не превращает saved mutation в failed и не повторяет write; list всё равно refresh по существующим signals. Last successful management operation wins; несколько edits дают один notice. Текст означает факты этого недавнего действия, не аудит всех последующих edits.

После commit invalidate existing team/config/list caches и отправить TeamChangeEvent(type=config) с additive management result/context metadata через current IPC onTeamChange и HTTP SSE team-change. Watcher fallback, не origin/summary authority. Duplicate signals coalesce; success tool не ждёт конца всего prompt. Непрозрачный CAS revision нельзя сортировать: использовать existing fanout order/sequence, при отсутствии sequence добавить простой in-memory ordinal management event в этом же emitter, scoped к app/context, без stream framework.

Store принимает лишь новый sequence для той же context/team, игнорирует duplicate/older notices. Dismiss/expiry/trash очищают notice payload и top highlight; только небольшой last-sequence watermark остаётся до context reset, чтобы delayed event не вернул закрытую подсветку. App/root change очищает map целиком. Никаких durable cursors, отдельных subscriptions или recovery storage.

Store делает existing scoped fetchTeams, для открытой команды refreshTeamData. External trash использует тот же renderer cleanup/transient tombstones, что UI delete: выбранная удалённая команда и поздние replies не воскресают. Не создавать runtime/process event ради refresh. IPC/HTTP consumers получают одинаковые DTO; stale-root event/response игнорируется до badge/reorder.

Created/edited - сверху текущего **отфильтрованного** списка в Recent changes группе, existing TeamList cards, без duplicate rows. Newest accepted event first; badges Создана/Изменена, одна строка например `Роли: +2/-1; изменено описание`, если facts известны. Trash очищает active notice и уходит только в existing Trash section.

Приоритет/подсветка 5 минут от server timestamp либо dismiss. Не менять user order/project filter/running status/lastActivity. После expiry ordinary groups/sort; reload начинает без notices. Нет seen cursors/event replay/новых polling loops. Filter скрывает результат - короткая подсказка и existing clear-filter action, без сброса фильтра.

Нет spinner выполнения внешнего prompt: приложение не знает, подключился ли агент и завершил ли все tools. Copied означает clipboard success; UI показывает committed changes/connection status. Краткий disabled Copy лишь на фактическом snapshot/clipboard await; никаких задержек или batch-complete по idle timer.

## Edge cases и recovery

| Ситуация | Поведение / evidence |
| --- | --- |
| Несколько команд, failure на второй | Первые successes видны; separate readback/result. Нет all-or-nothing или automatic rollback/trash успешных. |
| Потерян mutation response | Get исходного teamName, сверить desired fields/deletedAt/revision. Confirmed state - success; conflicting/uncertain - stop, не blind retry/new name. |
| Concurrent edit/launch/recreate | Revision/identity/lifecycle rejection до write; fresh get, без overwrite новой пользовательской правки. |
| Missing/already trashed | Missing - not-found; trash again unchanged; update trashed rejection. Не auto-restore. |
| Empty/invalid roster/name collision | Общая create/roster validation до commit; lead-only разрешён, malformed строка не silently dropped. |
| Root switch/reload/SSE gap | Context fence защищает write; scoped fetch восстанавливает list. Root/reload очищает notices; пропущенные details не восстанавливаются. |
| Data saved, event/refresh failure | Mutation success сохраняется; notice может отсутствовать. Snapshot refresh без повторного mutation. |
| Older/duplicate event после dismiss/trash | Context/sequence guard не возвращает старый notice; CAS revision не используется как ordinal. |
| Crash между writes | Readback/partial outcome; не подтверждать полный desired edit по наличию только team directory. |

## Phases, проверки и оценка

1. Read-only UI checkpoint: roster seam + popup + references + request draft + actual Copy/bootstrap. Не обещать edit/trash до наличия tools.
2. Management contract checkpoint: stopped/draft update/trash, revision/context guard, HTTP/controller/MCP parity, draft restore. Management prompt только для proven capabilities; core create-only path сохраняется.
3. Observable result checkpoint: typed result/event facts, session-only map, existing fanout/store cleanup, badges/top ordering. Без дополнительной persistence/event platform/full diff.

Meaningful tests ближайшей сильной границы: existing real MCP HTTP flow create -> narrow edit -> trash -> get/list/restore, stale context/revision и отсутствие hard deletion; writer/lifecycle integration для marker preservation и launch/edit race; existing IPC+HTTP event/store flow refresh/root isolation/older-event rejection/external-trash cleanup. UI flow доказывает readonly preview без discovery hooks, multi-team partial results и потерю ephemeral highlight после expiry/dismiss/reload. Нет storage/receipt-reader tests, helper/каждая-role/source-text tests или DTO snapshots. Перед assertion назвать регрессию; не повторять сценарий на каждом слое.

Future gates: pnpm typecheck, focused lint/tests, source-size/provisioning architecture guards по diff; MCP/controller checks по новым contracts. UI только Electron pnpm dev:mcp/CDP на новом sandbox/test project, isolated roots/userData, без Computer Use/native picker. Heavy proof hosted; реальные пользовательские проекты/launch/terminal/agent actions запрещены. Handwritten harness TS/MTS с typecheck.

Ориентир сверх core: UI/roster/prompt 400-650 production LOC; management/draft trash/revision 650-1 100; result/event/store/list 160-280; meaningful checks 260-470; docs/i18n 50-100. **Всего 1 520-2 600 changed LOC. 🎯 6/10:** lock/CAS seam и stopped-team instruction persistence не доказаны. Они могут увеличить scope; не маскировать CRUD UI-only оценкой. Dependency-safe checkpoints около 2 000 LOC, без разрезания context/revision invariants.

Acceptance: свободный запрос без roster form; четыре состава в знакомом read-only представлении; native клиент сохраняет несколько drafts, изменяет stopped/draft и trash без hard delete/launch. Каждый committed result refreshes list; created/edited временно сверху с достоверным session-only summary. После reload остаются команды, без старой подсветки/details. Partial failure/stale context не скрываются; mutation success независим от clipboard/badge/event delivery.

Rollback: убрать management entry/tools/view и очистить ephemeral notices, оставить данные и compatible deletedAt/marker readers. Create-only prompt не откатывает edits/trash и не отзывает CDP/MCP; connection shutdown/restart остаётся core policy.

📌 Один свободный запрос, read-only templates и Copy; затем узкие configuration mutations и фактические результаты. Сложность в draft trash/concurrency/refresh, а не в выборе отделов.
