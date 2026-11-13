# 03. Slash-команды и настройки действующей сессии

Статус: R5 Host/Main/Composer и Desktop command journey опубликованы; R6 уточняет builtin review и remaining provider inventory. Actual native/Desktop acceptance ещё открыт.
Frontend baseline: `4a0e06277fe216d9f82dbbede362668fe46622ee`.
Stage 1 baseline: `1d0f97f55de566036c970eab4f36b84620afdb3f`.
Old runtime source: `777genius/agent_teams_orchestrator@e13edcd3d4ffbecc0272ae30195cc6b15b710ee7`.
Provider source D: `agent-teams-ai/old-provider-implementations@d58500bc983e897506e23d7b0bc8da1209864edd`.
Сохраняем работающие frontend команды; live model/effort/fast входят сюда только после проверки actual старого маршрута.
Prelaunch параметры принадлежат плану 05, profile lifecycle — 06; отдельную панель управления не создаём.

## 1. Actual frontend baseline и подтверждённый gap

- `MessageComposer` разрешает standalone slash только живому lead, без attachments и cross-team адресации.
- [Main: `MessageComposer`](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/renderer/components/team/messages/MessageComposer.tsx).
- `teams.ts` передаёт raw slash без message wrapper в stdin живого non-OpenCode lead; tests проверяют доставку, не native semantics.
- [Main: raw slash branch](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/main/ipc/teams.ts).
- Lead запускается с `--print --input-format stream-json --output-format stream-json`, включая create/launch.
- [Main: exact launch args](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/main/services/team/provisioning/TeamProvisioningLaunchTeamFlow.ts).
- [Main: exact create args](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/main/services/team/provisioning/TeamProvisioningCreateTeamFlow.ts).
- В этом режиме old runtime оставляет только `prompt && !disableNonInteractive` либо `local && supportsNonInteractive`.
- [Old runtime: `commandsHeadless`](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/main.tsx).
- Следовательно наличие команды в TUI/подсказке не доказывает её доступность в Desktop lead: `local-jsx` отфильтровывается.
- Shared suggestions — 10 имён, Codex — 21; объединение содержит **25 уникальных имён**, а не 31 реализованную операцию.
- [Main: shared names](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/shared/utils/slashCommands.ts).
- [Main: Codex names](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/renderer/utils/providerSlashCommands.ts).
- Project/user skills берутся из `skillCommandSuggestions.ts`; список ограничивается реально captured catalog выбранного профиля.
- Host renderer сейчас отвергает любой standalone slash, включая команды с уже существующим native маршрутом и skills.
- [Stage 1: blanket guard](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/src/features/agent-backend/renderer/createHostTeamMutations.ts).
- **Claude manual compact уже идёт через `team.execute → message.send → Session.submit`**, без нового `Session.control`.
- Native regression проверяет physical `compact_boundary` с trigger `manual`, новый context epoch и последующий team/MCP turn.
- [Stage 1: existing native compact proof](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/tests/native-claude-compaction.native.ts).
- Это не означает, что любая slash-строка допустима как prompt: разрешаем только подтверждённый native-command маршрут.

## 2. Ограниченный inventory actual handlers

Статусы различаются: native proof; source-supported, требующий journey; explicit old unsupported; UI/native mismatch; not-offered.
Строки ниже покрывают все 25 имён. Перечень skills добавляется из одного test profile, а не из всего возможного plugin ecosystem.

| Имена из frontend | Old handler в exact headless launch | Вывод для parity / Stage 1 |
| --- | --- | --- |
| `/compact` | `commands/compact/index.ts`: local, noninteractive=true; `compact.ts` вызывает native compaction | Claude reuse существующего `submit` и boundary proof; Codex отдельно проверяет, что старый эффект относится к его native context |
| `/cost` | `commands/cost/index.ts`: local, noninteractive=true; `cost.ts` возвращает cost либо subscription/overage состояние | Сохранить реальный вывод; проверить normalization локального результата, не подставлять нулевые usage |
| `/clear`, `/reset`, `/new` | `commands/clear/index.ts`: aliases; **noninteractive=false** | Source явно исключает их из этого режима; проверить видимый отказ/молчаливый UX, не проектировать reset по одной подсказке |
| `/model`, `/effort`, `/fast`, `/plan`, `/usage` | Соответствующие `commands/*/index.ts`: **local-jsx** | Exact headless filter исключает; live controls не считаются proven, prelaunch working settings остаются в 05 |
| `/permissions`, `/status`, `/mcp`, `/diff`, `/copy`, `/resume`, `/quit`, `/exit`, `/plugins` | `commands/*/index.ts`: local-jsx; exit alias quit, plugin alias plugins | В old runtime это TUI UI, не готовый headless API; Codex suggestion не меняет это свойство |
| `/review` | `commands/review.ts`: **prompt**, builtin handler создаёт review prompt | Проверить old headless journey и сохранить handler/args; наличие Codex TUI review API здесь не требуется автоматически |
| `/fork` | `commands.ts`: условная регистрация `FORK_SUBAGENT`; не unconditional Desktop capability | Проверить exact bundled feature/version; нет доказанного working baseline из одного suggestion |
| `/mention`, `/apps`, `/agent`, `/personality` | Нет одноимённой builtin регистрации в просмотренном old `commands.ts`; `agents` — другое имя | Codex-specific UI/native mismatch до проверки; не объявлять старой рабочей операцией native Codex TUI |
| Project/user/plugin skill commands | `commands.ts` + prompt handler; user-invocable/noninteractive фильтры, hooks и args | Сохранить captured identity и фактический native execution; не заменять plugin command произвольным path |

- [Old: command registry/aliases](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/commands.ts).
- [Old: compact metadata](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/commands/compact/index.ts), [clear metadata](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/commands/clear/index.ts), [model metadata](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/commands/model/index.ts).
- [Old: local/prompt/skill execution](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/utils/processUserInput/processSlashCommand.tsx).
- Для Codex это inventory внешнего old orchestrator, **не** доказательство исполнения native Codex TUI команд.
- Old Codex bridge использует `thread/start|thread/resume` и `turn/start` с model/effort; отдельный slash handler этим не доказывается.
- [Old: Codex native bridge](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/services/codexNative/appServerRunner.ts).
- OpenCode raw-stdin ветка baseline исключена: V1/V2 получают отдельную проверку actual offered/accepted поведения; Claude матрица на них не переносится.

## 3. Короткий discovery gate до нового control contract

1. На disposable old Desktop profile повторить exact launch и по одному случаю каждой спорной группы: с args/без args, следующий turn.
2. Записать handler/version, UI результат, native effect/readback; для Codex сверить target thread, для OpenCode — version и реально доступный маршрут.
3. `working` требует сохранения; `explicit unsupported` не требует изобретать новую функцию; enabled-but-silently-ignored остаётся явным UX gap.
4. Для последнего выбрать конкретное исправление текущего UI или доказанный native adapter, отразить решение в матрице до coding.
5. Для каждого добавляемого live operation назвать actual API pinned artifact; ACK, application point и безопасное восстановление проверить отдельно.
6. Проверить captured project/user skill и один разрешённый plugin command; userInvocable=false не превращать в доступную команду.

Уже известные API, которые ограничивают выбор:

- Claude compact: существующий `Session.submit` с original raw command; нативное событие compaction является readback.
- Old SDK stream protocol имеет `set_model`, `set_permission_mode`, `set_max_thinking_tokens`, `apply_flag_settings`, `get_settings`.
- [Old: exact control handlers](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/cli/print.ts).
- Они **не** доказывают одинаковый public API pinned SDK или использование live settings frontend; не изобретать `Query.compact()`/`setEffort()`.
- D Claude `QueryHandle` сегодня открывает interrupt/close/mcpServerStatus/optional stopTask; новое расширение требует source + pinned SDK проверки.
- [D: Claude session](https://github.com/agent-teams-ai/old-provider-implementations/blob/d58500bc983e897506e23d7b0bc8da1209864edd/packages/provider-implementations/src/features/provider-session-implementation/adapters/claude-sdk/session.ts).
- D Codex использует `thread/start`, `thread/resume`, `turn/start`; mutable settings/compact/review adapter сейчас не подтверждён.
- [D: Codex client](https://github.com/agent-teams-ai/old-provider-implementations/blob/d58500bc983e897506e23d7b0bc8da1209864edd/packages/provider-implementations/src/features/provider-session-implementation/adapters/codex-protocol/app-server.ts).
- Нет разрешения на generic raw RPC, ambient CLI или новый prompt «сделай вид, что сменил настройки» при отсутствии native метода.

## 4. Acceptance и минимальная архитектура

1. Пользователь вызывает proven command/skill из прежнего Composer и видит её результат в исходной conversation.
2. Compact меняет native context; следующий turn сохраняет обязательные team/MCP инструкции и наблюдаемый context epoch.
3. Локальный результат `/cost` и command errors отображаются как native command output, а не как случайный следующий assistant turn.
4. Captured skill исполняется с исходными args и scope; stale generation не переключает выполнение на другой profile/run.
5. Потерянный ACK не создаёт повтор compact/skill effect; read/reattach не вызывает команду снова.
6. Если discovery докажет working live setting/reset, сохранить его actual semantics и проверить следующий turn/resume; launch default не менять скрыто.
7. Explicit old unsupported остаётся понятным отказом; enabled-but-ignored UI закрывается явным проверенным решением, не записывается в PASS.
8. Attachments/cross-team/offline restrictions и обычные сообщения не регрессируют.

- Сохранить Composer/parser и `teamMessageSlashResults.ts`, но асинхронные результаты связывать с original inputId/commandId.
- Для доказанного native slash достаточно bounded classification/allowed args на существующем `message.send`, original binding и input ledger.
- Claude compact не требует нового Session SPI, нового receipt journal или отдельного event bus.
- Native local result normalization и captured skills принадлежат D adapter; Host хранит authority и историю, не native protocol.
- Только если working old действие нельзя выразить существующим API, добавить узкий optional Session operation именно для него.
- Не создавать заранее union compact/reset/model/effort/fast/permissions и session-settings revision framework.
- Для доказанного live setting достаточно existing session metadata/readback; дополнительный snapshot нужен лишь при реальном recovery gap.

## 5. Порядок реализации и конкретные места

### A — закончить bounded evidence matrix

- Дополнить таблицу выше old Desktop receipts для спорных групп, exact artifact/version и selected provider.
- Проверить `skillCommandSuggestions.ts`, registry/userInvocable и one selected plugin, не весь возможный каталог.
- Зафиксировать причины `not-offered`/`unsupported`/`UI mismatch`; review gate не разрешает молча удалить working возможности.

### B — существующий Host input path

- В `src/features/agent-backend/renderer/createHostTeamMutations.ts` заменить blanket guard на выбранный command/skill dispatch.
- Разрешение должно повторно проверяться в Host boundary по captured capability/identity; renderer string не даёт authority.
- Переиспользовать `team/contracts.ts`, `validateTeamCommand.ts`, `RuntimeOwner` input identity/no-replay; новые поля добавлять лишь для отсутствующей correlation.
- Raw native command не оборачивать обычными agent/inbox instruction blocks; использовать уже проверенную compact preparation ветку.
- В projection сохранить command/result metadata и привязку к original input; ограничить поздний ответ старой generation.
- Не увеличивать frozen `RuntimeOwner.ts`: узкую helper-функцию вынести рядом при необходимости, owner не переписывать.

### C — только доказанные отсутствующие native операции

- Если gate выявляет working capability без D route, менять исходники `old-provider-implementations`, не vendored dist.
- Расширить `provider-session-contracts/contracts/session.ts` и конкретный adapter минимальным методом после проверки pinned native API.
- Для next-turn settings записать application point; native acceptance и фактически применённое значение различать.
- Если нужен Host operation, согласованно добавить его в `contracts/operations.ts`, `TeamHost.ts` и original receipt owner.
- Собирать artifacts штатно, pin immutable commits/hashes; согласовать общий D pin с 01, 05 и 07.
- Исходный неизвестный effect остаётся pending/unknown; close/restart не означает разрешение повторного native control.

### D — существующий UI и E2E

- Сохранить ограничения Composer, pending-send ownership и оформление сообщений; новая session-control панель не требуется.
- Для `/model` без args сначала проверить old UX; не обещать восстановление TUI picker, которого Desktop не показывал.
- Prelaunch model/effort/fast controls проверяет 05; здесь проверяются только доказанные live команды и исправления mismatch.
- Расширить имеющиеся native/desktop fixtures; проверки provider-specific, Claude PASS не квалифицирует Codex/V1/V2.

## 6. E2E-first и точечные unit

Harness: `desktop-composer-ui-smoke.ts`, `desktop-skills-ui-smoke.ts`, `desktop-resume-ui-smoke.ts`.
Native reuse: `native-claude-compaction.native.ts`, Codex resume и OpenCode fixtures; localhost model server не подменяет native engine.

| Сценарий | Действие в actual UI / native fixture | Обязательный результат |
| --- | --- | --- |
| Claude compact continuation | Composer → `/compact focus` → task/MCP turn | Physical manual boundary, один epoch/effect, исходные instructions и история результата |
| Local command output | `/cost` после turn; один native отказ | Реальный cost/subscription/error output принадлежит исходной команде; не ложное model reply |
| Captured skills | Project/user skill и разрешённый plugin command из suggestions | Native handler, args/hooks и selected scope; userInvocable=false не вызывается |
| Lost ACK + reconnect | Прервать reply после compact/skill effect, открыть исходную conversation | Original lookup, нет повторной отправки; retained unknown не превращается в completed |
| Generation race | Сменить run/profile после admission, получить поздний result | Effect/result остаётся у исходного target; новый run не получает старые настройки/сообщение |
| Native inventory gaps | Old/new exact launch для спорной группы Codex и OpenCode | Зафиксирован working/unsupported/mismatch; enabled-but-ignored не считается parity |
| Conditional live/reset | Только для capability, доказанной gate: применить → следующий turn → resume | Actual model/effort/context effect, безопасный application point и readback, без скрытого изменения defaults |
| Restrictions + обычный текст | Attachments, другой recipient, offline lead; затем обычное сообщение | Понятный отказ и отсутствие регрессии обычных сообщений/attachments |

- Unit добавлять только для опасных pure rules: bounded command/alias classification и captured skill scope.
- Duplicate/lost ACK/generation проверять расширением existing input-ledger test, не новым зеркальным suite.
- Atomic control против close/checkpoint тестировать отдельно только если после gate действительно добавлен native control.
- Не писать unit на каждый forwarded mapper, UI branch или каждое из 25 имён.

## 7. Оценка после source review

- Подтверждённый базовый маршрут с reuse: production **600–1 100**, E2E/fixture **650–1 100**, unit **80–160** строк.
- Отдельный условный резерв после native gate: **400–900** production и **350–650** E2E строк для реально требуемых дополнительных controls.
- Резерв не объявляется обязательной работой по всему Codex TUI; gate может убрать его либо выявить конкретную более дорогую capability.
- Prelaunch catalogs/settings из 05, profile publication из 06, config/extensions из 07 здесь повторно не считаются.
- Сложность базового пути **6/10**; с новым live native control **8/10**; ожидаемая надёжность после приёмки **8/10**.
- Уверенность базовой оценки **7/10**, условного резерва **4/10**; цель — сохранённые capabilities, не написание исходных 3 200 строк.
- Implementation-ready: native gate закрыт по всем offered группам, remaining UI mismatches имеют конкретное решение и E2E.

## 8. Review

### R1 — авторская критика, выполнена 2026-11-12

- Найдено: 10 shared commands не покрывали Codex suggestions и skills; добавлен inventory и граница с 05/06.
- Найдено: result нельзя привязать к следующему случайному reply; добавлена original command/input correlation.
- Первоначальный R1 предполагал новый typed control для compact и live settings; R2 ниже исправил это по source evidence.

### R2 — независимое review, выполнено 2026-11-12

- Reviewer: `estimate_platform_acceptance`; просмотренная версия документа `bedaf5aae9d81033704636b5362472ddab5818d3`.
- Проверены frontend main/Stage 1, old runtime `e13edcd3d4ffbecc0272ae30195cc6b15b710ee7`, D `d58500bc983e897506e23d7b0bc8da1209864edd`.
- Найдено: suggestions принимались за live frontend capabilities; exact launch headless исключает clear и local-jsx handlers.
- Исправлено: source-linked bounded inventory 25 имён; working, unsupported и enabled-but-ignored различаются до реализации.
- Найдено: новый `Session.control` для Claude compact дублировал уже native-tested `message.send → submit`.
- Исправлено: existing manual boundary proof переиспользуется; новый contract допускается лишь после доказанного gap и actual API.
- Найдено: generic 21-command/TUI promise завышал объём и требовал несуществующих methods.
- Исправлено: указаны имеющиеся APIs, discovery gate, сниженная базовая оценка и отдельно неопределённый резерв; нет обещания готовности спорных групп.

### R3 — интеграционное review, выполнено 2026-11-12

Reviewer: root; входной published SHA `cda065d869ccffb5930ed2a817b3e0654b00bb31`.
Повторно прочитаны old `commandsHeadless` filter, Stage1 composer guard и actual native manual-compaction proof.

- Подтверждён minimal path Claude compact через existing input ledger; отдельные Session.control/journal/settings framework не требуются.
- Skills/config принадлежат P07, prelaunch selection P05, live capability проверяется здесь; один mapping не объявляется общей четырёхпровайдерной поддержкой.
- Native inventory — первый исполняемый шаг, не причина откладывать уже доказанный compact/skill slice. Неясные offered groups остаются явными gates до их acceptance.
- Общий conversation journey с P07/P10 проверяет compact → tool → cold Resume; existing lost-ACK/epoch tests расширяются без второго полного suite.
- План принят для исполнения discovery и базового среза. Review не заменяет native proof спорных команд и не разрешает скрыть control вместо исправления.

### R4 — exact SDK и текущая Host composition, выполнено 2026-11-12

Входные опубликованные реализации: frontend `ff22eefbaa7459941befb6c47a72e1508aaef7bc`,
D `7b6fe181` с explicit captured Claude executable; установлен SDK `0.3.305`.
SDK source references ниже относятся к файлу `@anthropic-ai/claude-agent-sdk/sdk.d.ts` из exact pinned package,
а не к будущему API или SDK из ambient PATH.

1. **Источник доступных skills.** `Query.supportedCommands()` возвращает список текущей native сессии;
   `SlashCommand` содержит `name`, `aliases`, `builtin`, description/argument hint.
   `SDKCommandsChangedMessage` обновляет этот список внутри той же Query.
   В D добавить optional read-only callback с bounded projection имён/aliases/builtin и чтением из
   **той Query, которой принадлежит отправляемый input**. Host сохраняет этот снимок только у captured
   `ClaudeMemberProvider`; новый scanner, поиск произвольного skill path и management Query не нужны.
   Builtin marker не даёт автоматического разрешения всем командам: первый срез допускает только
   proven `/compact`, source-supported `/cost` и `/review`, плюс actual native non-builtin skills.
   Aliases разрешаются по exact native names и builtin precedence, без подмены одноимённой skill.

2. **Обычный durable маршрут.** Убрать blanket renderer refusal только для captured Host route,
   сохранив ограничения Composer: user → живой lead, без attachments/cross-team/group delivery.
   Host проверяет actual provider, original member generation и доступную команду; UI-поле providerId
   само по себе не authority. Команда идёт через прежний `message.send`/outbox/Runtime input ledger.
   `formatTeamMessage` сохраняет raw command без rich-message wrapper только для этого явно
   квалифицированного случая. Старые durable receipts должны продолжать восстанавливать прежние bytes.
   Сохранить original commandId/inputId при lost ACK; повторный read или переключение foreground не
   делает новый submit. Generic `Session.control`, второй журнал и повторный native CLI не добавлять.

3. **Контекст после compact.** Pending team reminder нельзя вставлять перед slash, иначе native
   parser перестанет видеть команду. Local compact/cost оставляют pending reminder следующему
   обычному model turn; skill/review не должны потерять обязательные team/MCP инструкции.
   Использовать existing context preparation и captured system configuration; отдельный prompt
   «выполни команду» запрещён. В native journey проверить повторный compact и последующий tool turn.

4. **Результат и provenance.** `SDKResultSuccess` имеет `local_command`, `user_message_uuid` /
   `user_message_uuids`, `result`; эти поля позволяют связать локальный результат с original input.
   `SDKLocalCommandOutputMessage` (`system/local_command_output`) **не имеет input UUID**:
   его нельзя приписывать текущему запросу только по времени. Первый срез нормализует локальный
   текст лишь при совпадении native command и уже доказанной input correlation; plain assistant,
   background и child output не становятся результатом команды. Main отображает этот output в
   исходной conversation, используя existing runtime activity identity; старое правило «следующий
   thought после slash» не используется. `/cost` обязан показать actual output, включая subscription
   сообщение; отсутствие подтверждения не превращается в нулевые usage или успешный ACK.

5. **Provider boundaries.** Codex native app-server и OpenCode V1/V2 не получают Claude slash parser.
   Для old TUI-only suggestions сохраняется явный отказ с доступными launch settings из P05.
   Source-supported `/review` и skills проверяются отдельно от TUI-only controls. Если exact native
   artifact не исполняет какой-либо рабочий old handler, gate остаётся открытым до конкретного
   adapter/UX решения; удаление suggestion само по себе не считается восстановленной возможностью.

6. **Минимальные проверки.** Один critical D test на bounded catalog + correlated local output и
   чужой/background frame; existing Host message/epoch tests расширить отказами actor/member/provider,
   exact raw bytes и unchanged lost-ACK identity. Actual native journey — compact → cost → captured
   project/user skill с args → tool → cold resume; одна отдельная проверка plugin command при P07
   captured settings. Desktop journey подтверждает доступную команду и видимый original result.
   Эти fixtures запускаются штатным remote CI; локальные socket/Desktop ограничения не обходятся.

Review decisions: не расширять frozen 800-line `RuntimeOwner`, не вводить control framework,
не переносить hooks/secrets в renderer, не объявлять полный `supportedCommands` список поддержкой
всех TUI действий. Source gate определяет реализацию; статус PASS требует actual native/Desktop receipts.

### R5 — реализация и оставшаяся приёмка, 2026-11-12

Опубликованы D `04e40ea05f93ca6fd1b73010d680f579ff14a9d0`, checked frontend pin
`501478457ac8e2a0b724294108041c4107d7dc1d` и Host/Main/Composer
`d88a37d0d1348494d800e2cb83b49976c83313c9`.

- Same-Query catalog и `commands_changed` передают bounded имена/aliases; Host допускает только
  captured Claude lead и квалифицированные builtin families. Metadata не создаёт новый native input.
- Explicit `nativeCommand: true` сохраняет raw slash bytes через существующий message/outbox ledger.
  Старые rich slash receipts без marker продолжают иметь прежний wrapper. Actor, generation,
  live capability и original receipt проверяются в Host, а не доверяются renderer.
- Pending compact reminder не вставляется перед slash и сохраняется следующему обычному input.
  Captured system/MCP configuration остаётся у той же native Query.
- Только terminal local result с exact native input UUID/operation становится обычным lead reply.
  Его deterministic ID живёт в существующем Team message ledger; lost reply ACK/cold lookup
  восстанавливают исходный reply без native replay. Нет нового журнала и «следующего thought».
- Local gates: D full checks на Node 24/26 PASS; Host build и TEST types PASS; critical Team
  integration 11/11, Main suites 52/52, прежний pure compact oracle 2/2 PASS; focused Main/renderer
  types, fast lint и source-size guard PASS. Это не actual native/Desktop acceptance.
- Existing `native-claude-compaction.native.ts` расширен marked `/compact`, `/cost` без model spend,
  project/user commands с args и actual Team MCP, original receipts после cold Host restart.
  Одна step добавлена в существующий macOS Stage1 Desktop job; exact archive/installed bytes,
  fixture/source hashes, actual returned output и cleanup входят в proof. Receipt пока ожидается.

Следующий узкий UI-срез использует существующий `native-launch-ui`, его Launch/Stop/cleanup и
тот же native Team model server. Вариант `LEGACY_DESKTOP_COMMANDS_UI=1` добавляет три TEST helpers:
подготовку private captured command sources, finite model response oracle и actual Composer journey.
Новый proof mode, отдельный runner, production test API и второй model server не нужны.

1. До запуска приложения записать project/user command fixtures; включить их captured setting sources,
   пересчитать private Host profile/descriptor pins штатным TEST fixture способом.
2. После обычного Launch и его native reply выбрать `/cost` из видимых suggestions и нажать Send один
   раз. Проверить original rich command marker, raw native input, exact output в переписке и отсутствие
   нового model request. Никакого вызова send через CDP `evaluate` вместо пользовательского действия.
3. Через тот же Composer выполнить `/compact` с args, увидеть physical boundary; следующий `/cost`
   не должен потреблять pending reminder. Выбрать project command, передать args и получить actual
   native Team MCP reply при сохранённых system instructions.
4. Перезагрузить renderer, открыть исходную переписку и проверить неизменные command/input/reply IDs
   и model request count. Existing Launch journey затем проверяет Stop/cleanup; cold Host recovery
   остаётся в native fixture, без дублирования полного Desktop cold suite.

Открытые gates: actual native и Desktop receipts этого среза; source-supported builtin `/review`;
captured plugin command вместе с P07; спорные Codex/OpenCode command groups из inventory. Ни
source checks, ни removal неподходящей suggestion не закрывают эти gates. Если SDK local result
не возвращает доказуемый original UUID/output, требуется штатный supported boundary, а не
ослабление correlation или присвоение несвязанного `system/local_command_output`.

R5 UI implementation checkpoint: три TEST helpers и узкие hooks существующего Launch готовы.
`nativeCommands`/`commandRequests` остаются optional и взаимоисключаются с schedule variant.
CI запускает followup `native-launch-ui` только в существующей base `native-create-ui` lane;
новые job/runner и production APIs не добавлены. Строгий retained receipt проверяет четыре
original sends, два native local outputs, три inference requests, неизменные IDs после reload,
обычный Stop, physical cleanup и source freeze. Focused scripts types, fast lint, YAML и
source-size guard PASS; фактический native/Desktop результат ожидается от remote CI.

### R6 — builtin review и проверка provider-specific границ, 2026-11-12

Входной Desktop source cut: `2b73113b210ba742238822ca8a9cc8e125f8da48`.
Следующий срез не меняет production command contract: Claude `review` уже входит в bounded
same-Query allowlist. Требуется подтвердить native parser, исходные args, Team tool и UI reply.

#### Подтверждённые source references

- Old [`commands/review.ts`](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/commands/review.ts):
  `/review` имеет `type: prompt`, `source: builtin`, без `disableNonInteractive`; args передаются
  в `LOCAL_REVIEW_PROMPT` как PR number. `/ultrareview` — отдельный `local-jsx` remote route;
  он не входит в этот срез и не подменяет `/review`.
- Old [`main.tsx`](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/main.tsx),
  `commandsHeadless`: prompt commands без запрета доступны в исходном print/stream-json запуске.
- Old [`QueryEngine.ts`](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/QueryEngine.ts):
  `processUserInput` вызывается до provider branch; local commands возвращают output до native
  Codex turn. Однако `executeCodexNativeTurn` получает исходный `prompt`, а не expanded
  `messagesFromUserInput`. Само наличие prompt handler не доказывает native Codex slash semantics.
- Old [`services/compact/compact.ts`](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/services/compact/compact.ts)
  вызывает `queryModelWithStreaming`; [`services/api/client.ts`](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/services/api/client.ts)
  явно отвергает Anthropic fetch adapter при `codex-native`. Это ограничение исходного direct
  compact path; native thread compaction для Codex нельзя объявлять работающей по UI suggestion.
- Old [`commands/cost/cost.ts`](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/commands/cost/cost.ts)
  читает process cost tracker либо subscription state.
  [`codexNative/transcriptProjector.ts`](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/services/codexNative/transcriptProjector.ts)
  отдельно накапливает actual Codex usage; это не подтверждает заполнение общего USD/model-cost
  tracker. Новая UI не должна синтезировать нулевую цену как verified native cost.
- Frontend [`teams.ts`](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/main/ipc/teams.ts),
  raw slash branch `isLeadRecipient && isAlive && !isOpenCodeRecipient`: V1/V2 OpenCode исключены
  из этого parser handoff. Их обычная message delivery и declarative settings остаются отдельными
  возможностями; одинаковый текст подсказки не создаёт им Claude command API.

| Группа | Что доказано исходным маршрутом | Следующий результат |
| --- | --- | --- |
| Claude `/review` | Headless prompt handler и captured Host allowlist существуют | Native + Desktop parser/args/tool/reply/recovery в текущем journey |
| Codex `/compact` | Общий compact handler вызывает несовместимый с codex-native API client | Не считать рабочим старым native effect; actual provider inventory остаётся отдельным gate |
| Codex `/review`, named skills | Shared preprocessing существует, native branch получает original prompt | Не переносить Claude expansion в Codex без доказанного provider boundary |
| Codex manually typed `/cost` | Old wrapper local output существовал, но его USD authority не подтверждена | Сохранить вопрос отображения actual usage открытым; сверить existing captured Stats/output, не подставлять нули |
| OpenCode V1/V2 raw slash | Frontend исключал native stdin branch для обоих поколений | Проверять их поддержанные configuration/conversation features; не объявлять чужой parser native parity |
| TUI-only names из таблицы 25 имён | Headless filter исключает соответствующие handlers | Сохранять понятное ограничение; исправления Launch settings выполняет P05 |

#### Минимальная реализация review

1. В existing `native-claude-compaction.native.ts` потребовать builtin `review` в actual live catalog;
   добавить один marked `message.send` с distinct TEST args после user/project commands. Проверить
   исходные commandId/inputId/raw bytes, отсутствие prefix и ровно один actual Team MCP reply.
2. В existing `fixtures/native-claude-compaction/model.ts` добавить finite `review` phase:
   actual native request содержит builtin review instruction и exact args; captured system/MCP
   сохраняется. Oracle возвращает один Team `message_send` tool и один завершённый ответ после
   настоящего tool result. Не выполнять `gh`, внешний PR fetch или vendor inference ради fixture.
   Это проверка маршрута команды; качество code review и внешний GitHub workflow не заявляются.
3. В existing Desktop command helpers добавить выбор `/review` из того же меню после project skill,
   исходные args и видимый native Team reply. После reload сохраняются все пять original sends.
   Использовать тот же server/Launch/Stop; не добавлять mode, runner, API или вторую полную suite.
4. Обновить strict retained-receipt checks: native journey — 8 original receipts и 10 model requests;
   Desktop commands — 5 sends и 5 requests. Native cold lookup и renderer reload не добавляют
   submit, native allocation или output. Сохранить timeout/cleanup/source-freeze guards.

Локальные проверки: existing pure compact oracle regression, Host TEST types и focused scripts
types/lint. Новые unit cases не требуются: важные assertions находятся в actual native/Desktop
journeys. Старые CI запуски не отменять; новый опубликованный source проходит обычные проверки.

#### Review плана и дальнейший scope

- Авторский круг: отдельная review command implementation не нужна — qualified raw submit уже
  существует. Убраны новый command coordinator, generic Session.control и отдельная suite.
- Повторный source круг: Codex fallback нельзя объявлять равным Claude, OpenCode raw stdin branch
  исходно исключён. Эти выводы уточняют baseline, не заменяют remaining actual acceptance.
- P07 extension/skill consumption остаётся отдельным gate: текущие Desktop mutation fixtures
  доказывают scoped file/native CLI changes, но используют другой management namespace либо
  refusal-only metadata binaries. Для следующего шага нужен тот же captured configuration у UI
  mutation и настоящего нового native launch. `NativeExtensionCoordinator`/`SkillCoordinator`
  остаются владельцами; новый scanner и прямое редактирование native installation metadata запрещены.

### R7 — Codex `/cost`: сохранённый ответ на основе actual usage, 2026-11-13

Исходный source cut: `9be8497995ad77db387c71d7f6d0c667b62e455a`.
R6 review source опубликован в `8e4229bcdfc522a108542d5071860ad137ee844e`;
actual native/Desktop acceptance остаётся открытым. Следующий срез сохраняет local
conversation output для Codex без нового native command API.

#### Источник данных и границы

- Old [cost handler](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/commands/cost/cost.ts)
  исполнялся локально до Codex turn и читал общий process cost tracker.
  [Cost formatter](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/cost-tracker.ts)
  показывал USD, API/wall duration, code changes и model usage. Однако
  [Codex projector](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/services/codexNative/transcriptProjector.ts)
  накапливал actual usage отдельно; old USD/нулевые счётчики не доказывают native billing.
- D [notification mapper](https://github.com/agent-teams-ai/old-provider-implementations/blob/04e40ea05f93ca6fd1b73010d680f579ff14a9d0/packages/provider-implementations/src/features/provider-session-implementation/adapters/codex-protocol/notification-mapper.ts)
  принимает `tokenUsage.last` как snapshot; [driver output](https://github.com/agent-teams-ai/old-provider-implementations/blob/04e40ea05f93ca6fd1b73010d680f579ff14a9d0/packages/provider-implementations/src/features/provider-session-implementation/adapters/codex-protocol/driver-output.ts)
  передаёт input/output tokens, без USD и cache breakdown. Новый отчёт не рассчитывает цену
  по прайсу и не выводит subscription/overage состояние другого провайдера.
- Host [readTeamActivity / summarizeTeamActivity](https://github.com/777genius/agent-teams-ai/blob/9be8497995ad77db387c71d7f6d0c667b62e455a/packages/legacy-agent-host/src/composition/readTeamActivity.ts)
  уже связывает usage с original input, оставляет последнее значение для session/input,
  сохраняет gaps и неизвестные значения. Общий Stats агрегирует retained member history;
  для `/cost` тот же reader ограничивается одним captured Codex binding.
- [TeamLaunchSummary](https://github.com/777genius/agent-teams-ai/blob/9be8497995ad77db387c71d7f6d0c667b62e455a/packages/legacy-agent-host/src/team-launch/contracts.ts)
  имеет original `startedAtMs`. Только matching launch даёт «Elapsed since this launch»;
  отсутствие времени остаётся unknown. Это не API duration и не полный lifetime native thread.

#### Минимальная реализация

1. Добавить только ready/current Codex lead capability `cost` в существующий safe catalog.
   Claude продолжает использовать actual same-Query native handler. Иные команды и провайдеры
   не получают новый маршрут. Composer, user/lead, attachments/cross-team ограничения сохраняются.
2. Сохранить wire `message.send` и существующий `nativeCommand:true` как explicit raw-format
   marker. Host самостоятельно определяет exact Codex `/cost`; строка renderer не даёт authority.
   Новый явный `hostCommand: cost` хранится только в private original receipt, а не становится
   универсальным control SPI или новым публичным catalog discriminator.
3. После проверки original command UUID/fingerprint и actor/binding внутри existing Team command
   fence capture reported stats, matching launch identity и bounded reply. Snapshot и private marker
   сохраняются вместе в original prepared CommandReceipt до первого product effect; uncertain write
   recovery сначала читает этот receipt и не заменяет сохранённый snapshot новыми stats. Caller
   не передаёт текст ответа, usage, provider identity или ready proof; новый journal не нужен.
4. Узкий helper в existing Team message owner пишет исходную command row и derived reply через
   тот же canonical writer с deterministic original command/binding IDs и exact readback.
   Для этого private Host command не создаётся native outbox, Runtime input, Session.submit,
   model request или fake native UUID. Native Claude reply correlation не меняется.
5. Ответ явно обозначает captured session и retained activity. Показывать только reported input
   и output tokens, «Price not reported by Codex», matching launch elapsed и наличие gaps.
   Нет данных — понятное «not reported», а не ноль. Partial retention не объявляется полным
   session total; API duration, cache breakdown, code changes и цены не угадываются. Любое ограничение
   snapshot явно оставляет partial/gap; elapsed фиксируется один раз как finite nonnegative now-start.
6. Completed lookup и восстановление частично записанного ответа используют сохранённые
   snapshot/IDs/bytes. Они не перечитывают более новый usage и не обращаются к native engine.
   Новая явная `/cost` имеет новый UUID и новый snapshot. Старые receipts без private marker
   сохраняют прежнюю трактовку; новая generation не получает чужой незавершённый ответ.
7. Основные точки: `nativeSessionCommandAdmission.ts`, `projectRuntimeMember.ts`,
   `RuntimeTeamCoordinator.ts`, `TeamHost.ts`, `team/contracts.ts`,
   `executeTeamCommand.ts`, `commitTeamMessage.ts` и один узкий helper.
   Не расширять frozen большие файлы: admission/formatting/recovery вынести в helper,
   оставаясь внутри существующих owners. D и generic Session contract не менять.

#### Проверка и несколько кругов review

- Source-круг: old local output нужно сохранить, но old global Claude counters не дают права
  показывать Codex USD; read-only Stats становится единственным источником чисел.
- Architecture-круг: новый публичный command kind и renderer routing исключены. Private marker
  отделяет Host-derived output от native local output; original Team ledger сохраняет recovery.
- Независимый круг (Profiles): использовать existing prepared→terminal protocol для fault между
  command/reply; replay сохраняет elapsed/bytes, bounds не превращают partial в total.
- Две критичные интеграции в existing Host tests: reported/partial/unknown usage без double count
  и отказ stale/foreign generation; fault между command/reply write с original replay после
  изменения usage, неизменными bytes/IDs и нулевым native dispatch. Новая unit suite не нужна.
- В existing actual Codex native/Desktop journey после успешного turn выбрать `/cost` и проверить
  visible reply, original receipt, reported token snapshot, unknown USD и неизменное количество
  native inputs/model requests. Reload и cold original lookup не создают повторного ответа.
  Использовать существующий model server, Launch/Stop, source freeze и physical cleanup.
- Source checks и implementation receipt не заменяют actual remote CI. После публикации
  проверять exact head штатно; P03 gate закрывается только подтверждённым native/Desktop
  результатом, без нового runner, blind rerun или ослабления existing assertions.

#### R7 implementation: проверенный source cut

Private cost snapshot теперь записывается в существующий prepared receipt, входит в fingerprint
только у новых Host replies и удаляется из публичной RPC projection. Canonical message writer
публикует deterministic ответ; отдельный native outbox не создаётся. Recovery переиспользует
сохранённые usage, elapsed и IDs после частичной записи.

Повторный source review прошёл по actor/current binding, старым fingerprints, private projection,
original recovery и отсутствию native dispatch. Изменены только две существующие критичные интеграции:
Host RPC usage/unknown/replay и сбой между command row и reply. Компиляция и выполнение этого cut
ещё требуют CI: текущая локальная среда недоступна. Native/Desktop acceptance остаётся открытой;
source review не заменяет результат E2E.

#### R7 actual native/Desktop acceptance cut

В existing native Codex scenario настоящий D/native runtime выполняет прежние11 model requests.
После последнего turn Host получает одну explicit `/cost`; helper читает фактически записанные
private snapshot/receipt и canonical reply, сравнивает reported tokens с existing Stats.
Повтор исходного command и cold Host lookup сохраняют bytes/elapsed/IDs; Runtime inputs,
native outbox и число model requests не увеличиваются.

Existing Codex Desktop Resume journey выполняет выбор `/cost` через настоящий Composer после
первых8 model requests, показывает ответ и сохраняет screenshot. После штатных Stop/Quit,
нового app/Host и Resume проверяются прежний отчёт и receipt до второго prompt. Только
technical generation меняется; исходная session history и cost snapshot неизменны.
Новые runner/mode/unit suites не добавлены; два helper входят в существующий source freeze.

Независимый review Profiles и root source review пройдены. Root дополнительно сделал сравнение
чисел точными строками, чтобы expected1 не принимал prefix11. Compile/native/Desktop результаты
нового cut ещё pending; наличие сценария и source review не объявляются E2E PASS.

### R8 — исправление каталога Claude после actual SDK failure, 2026-11-13

**Доказанная причина.** Native gate `e2af82d`, run `43338183806`,
job `131599601406`, отказал на «actual Query advertises compact» до первого model request.
Отдельная read-only инициализация pinned `@anthropic-ai/claude-agent-sdk@0.3.305`
на Linux x64 с новым TEST HOME/config вернула 46 строк. Каталог содержит `compact`,
`usage` с aliases `cost/stats`, `code-review` с alias `review` и обе TEST skills.
D `04e40ea` преобразовал его в пустой массив: native builtin `__remote-workflow`
не соответствует product grammar. Это служебная metadata, а не разрешённая UI command.
Проверка не отправляла prompt, не поднимала listener/MCP и завершила original child с code 0.
SDK JS digest совпал с прежним qualified `c8d3e6cf…`; это diagnosis, не полный P03 PASS.

1. В existing D `claude-sdk/commands.ts` отделить bounded native metadata spelling от
   product executable spelling. Native underscore names допустимы при проверке metadata;
   строки и aliases, не представимые прежней product grammar, исключаются из product catalog.
   Не расширять `claudeCommandName`, Host parser, builtin allowlist или raw dispatch.
2. Сохранить прежние shape/count/byte bounds, builtin precedence и alias correlation.
   Невалидные типы, NUL/чрезмерные данные по-прежнему не дают command authority.
   Один служебный native builtin не должен скрывать другие допустимые команды.
3. Добавить один критичный regression в existing D command integration: вернуть фактические
   46 catalog rows, получить прежние compact/cost/review/user capabilities, исключить
   `__remote-workflow` и проверить отказ его raw-command grammar. Новая unit suite не нужна.
4. Проверить D штатным full check под Node 24 и 26; повторить тот же read-only catalog projection
   на исправленном D. После checked pack/pin выполнить существующие native Claude commands и
   Desktop Launch/Composer gates на exact head. Не менять intentional old artifact corpus,
   model counts, receipt correlation, waits или критерии PASS.

**Review 1 — parity.** Actual native metadata содержит private names; product grammar не обязана
разрешать их пользователю. **Review 2 — минимальность.** Исправляется существующий codec и один
regression; нет новой discovery API, списка разрешённых внутренних commands или fallback dispatch.
Compact, cost, review и scoped skills остаются открытыми до actual native/Desktop acceptance.

### R9 — aggregate Stats после нового Launch, 2026-11-13

На `1628b70e` [Codex Desktop Resume](https://github.com/777genius/agent-teams-ai/actions/runs/43356141566/job/131658636833)
завершил первый native turn, затем отказал на read-only `team.activity.stats.read`
до отправки `/cost`. Source audit выявил две связанные ошибки aggregate reader:
он перечисляет оставшийся пустой configured recipe и проверяет каждую запись
через current delivery, которая после captured Launch уже относится к другому run.

Минимальный correction в `readTeamActivity.ts` пропускает только запись без
Runtime record и attached session. Чтение фактических records использует прежнюю
authority `RuntimeActivityCoordinator.snapshot/feed`: exact retained entry,
current Team read grant и existing Runtime fence. Удаляется только дублирующий
current-delivery guard aggregate reader; control/dispatch/restore authorization
не меняется. Такой read path уже используется `resolveRuntimeControlEntry`;
`RuntimeTeamCaptures.restore` валидирует source и binding всех retained captures.

Existing real-composition test сохраняет один launch/input и проверяет reported
usage после первого captured turn, после второго capture с новой delivery и после
cold reconstruction. Пустой recipe не увеличивает generations. Existing revoked-read
case дополнен Stats/logs: потеря current read grant по-прежнему запрещает ответ.
Новая unit suite и новая native allocation не нужны. Root source review выполнен;
compiler/test/native/Desktop результаты этого correction ещё pending.

Отдельный оставшийся пункт — история generation после Resume/Restart:
`RuntimeTeamCoordinator.rekey` удаляет predecessor entry, поэтому aggregate Stats
не перечисляет прежнюю generation. Correction выше сохраняет отдельные launches,
но не закрывает этот пункт. Следующий минимальный срез должен проецировать
существующие validated restore/member-action journals без второго registry,
сохранить original input attribution и не суммировать повторно native cumulative
cost при продолжении одной session. До source review и actual acceptance это
остаётся открытым несоответствием P03.

### R10 — retained Stats и Codex `/cost` после Resume/Restart, 2026-11-13

**Проблема.** R9 сохраняет отдельные captured Launch, но после Resume/Restart existing
`RuntimeTeamCoordinator.rekey` удаляет predecessor из runtime registry. Его actual activity
остаётся в исходном Runtime store, однако Stats и новый Codex `/cost` её не перечисляют.
Возвращаем read-only историю через уже сохранённую цепочку выбора; runnable entries,
новый journal, migration записей и новый RPC для этого не требуются.

#### Авторитетный источник и минимальные изменения

1. Узкий private helper рядом с `readTeamActivity.ts` получает captured current entry
   и existing retained launch по точным `teamId/launchId`.
   [TeamLaunchOwner.readRestorations/memberActions](https://github.com/777genius/agent-teams-ai/blob/1628b70e50533a80d2f9d5bc8ea6edcb08a19dda/packages/legacy-agent-host/src/team-launch/TeamLaunchOwner.ts)
   уже возвращают validated selections без opening/reconciliation. Не читать произвольные
   файлы, не создавать второй индекс и не восстанавливать runnable `MemberEntry`.
2. Построить конечную цепочку predecessor→selected из restore rows и только завершённых
   `restart` actions. Pending/refused/skip не создают новую generation. Действующие
   [validateLaunchRecord](https://github.com/777genius/agent-teams-ai/blob/1628b70e50533a80d2f9d5bc8ea6edcb08a19dda/packages/legacy-agent-host/src/team-launch/validateLaunchRecord.ts)
   и [validateMemberSelectionChain](https://github.com/777genius/agent-teams-ai/blob/1628b70e50533a80d2f9d5bc8ea6edcb08a19dda/packages/legacy-agent-host/src/team-launch/memberActions.ts)
   проверяют fingerprint, один backend/team/run/member, отсутствие развилок/циклов,
   порядок generations и неизменные base configuration/context. Дополнительно связать
   последний selected binding/configuration digests с actual captured current entry.
   Сохранить existing bounds: до 64 restores и 64 actions, общий read limit 256 sources
   и существующие event/page/byte budgets. Несогласованный journal остаётся hold.
3. Использовать эту проекцию в existing aggregate Stats/log reader и ограничить новый
   Codex `/cost` только цепочкой его выбранного entry. Отдельные Launch и fresh Restart
   остаются отдельными native sessions. Original bindings/input IDs/operation refs и
   attribution берутся из прежних Runtime records; старые события не копируются в новую
   generation. Повторный readonly запрос, reload и cold Host ничего не отправляют провайдеру.
4. В existing Runtime read authorization разрешить отсутствующий registry binding только
   при exact membership в той же validated projection и действующем human Team read grant.
   Snapshot/feed по-прежнему проверяют authority до и внутри Runtime fence. Current grant
   проверяется и после aggregate read. Admit/dispatch/control, current delivery,
   provider creation и selection authority остаются прежними. Не давать историю по одному
   совпадению member name, PID, session ID или caller-supplied digest.
5. Usage сохраняет existing per-original-input deduplication. Не складывать одинаковый
   cumulative USD повторно после продолжения той же native session.
   [Официальное описание Claude SDK](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
   указывает, что resumed result включает прежние расходы session; последний reported
   cumulative value заменяет предыдущие. Для этого private grouping соединяет только
   validated Resume edges с подтверждённой provider semantics; fresh Restart/new Launch
   образуют отдельные группы. Снижение total, missing/partial retention или неподтверждённая
   семантика дают unknown и понятный gap, а не вычисленную цену. Codex USD по-прежнему
   `not reported`; отдельный price table и native transcript parser не добавляются.
6. Не менять публичные DTO и сохранённые `/cost` receipts. История вычисляется при новом
   readonly query или новом explicit command. Recovery старой команды использует прежний
   captured snapshot/elapsed/IDs/bytes, даже если после неё появились новые turns.

#### Проверка и review

- Source-круг: сравнить actual rekey и original validators; включать именно сохранённые
  predecessor bindings, а не новую in-memory копию owner/registry.
- Architecture-круг: reuse двух existing journal projections и Runtime activity owner;
  отказаться от нового persistence API, registry, event migration и общей hierarchy.
  Не расширять frozen большие файлы: вычисление цепочки остаётся в отдельном узком helper.
- Независимый review перед публикацией source: current human authority, foreign bindings,
  pending/corrupt edges, exact current config anchor и отсутствие native calls/второго journal.
- Расширить две существующие критичные интеграции: реальный Host composition
  Launch→turn→Resume→turn→fresh Restart→cold read проверяет retained input totals без дублей;
  existing command/authority case проверяет новый `/cost`, сохранение старого receipt,
  отказ revoked grant и foreign/corrupt lineage. Не добавлять набор unit tests на каждый helper.
- В существующем actual Codex Desktop Resume journey сравнить Stats и visible `/cost`
  до/после выбранного Resume и после reload, без дополнительных native model requests
  ради самой статистики. Existing Stop/Quit/source-freeze/cleanup guards обязательны.
  Source review, fixtures и локальная компиляция не заменяют exact-head native/Desktop CI.

R10 является планом следующего среза. R9 fix и существующие receipts не объявляют эту
историю завершённой; готовность фиксируется только после implementation review и проверок.


### R11 — implementation и локальная проверка R9/R10, 2026-11-13

- Source-круг закрыт: `runtimeActivitySources.ts` проецирует только existing validated
  `readRestorations()` / `memberActions().read()` и связывает current endpoint с exact
  selected profile/base/configuration. Historical binding разрешён только для read
  в той же цепочке; original admit/dispatch/control остаются прежними.
- Architecture-круг закрыт: новый registry, Runtime entry, storage writer и RPC не добавлены.
  Aggregate Stats/logs сохраняет весь retained launch; Codex `/cost` обрывает predecessor
  traversal на fresh Restart. Публичные DTO и сохранённые command snapshots прежние.
- USD: optional external Claude executable не доказывает version semantics по одной
  SDK revision. Поэтому resumed cumulative USD остаётся unknown с gap, без нового
  pricing/qualification API. Снижающийся cumulative total и partial/gap также не дают цену.
- Найден и исправлен реальный R9 cold edge: captured cleanup создаёт `config: null`,
  empty-input Runtime sentinel даже для никогда не открытого recipe
  (`RuntimeOwner.stopCapturedSession` → `emptySession`). Такой detached sentinel
  не считается activity. Реальный open/restore пишет config **до allocation**, поэтому
  открытая пустая session остаётся видимой; история inputs никогда не удаляется фильтром.
- Исправлен oracle R9: actual RPC возвращает `value.stats`. Existing capture/cold case
  теперь даёт ровно одну actual generation и 17/9 tokens. Existing Resume case даёт
  17/9 → 24/12 после второго original input и сохраняет результат после cold read.
  Existing Codex command case проверяет new `/cost` 24/12 после cold Resume, unknown
  после fresh Restart, aggregate Stats трёх действительно открытых generations и
  неизменность первого receipt/output. Foreign/corrupt lineage отказывает.
- Локально: Host build, Host test types и Desktop scripts types **PASS**; весь existing
  `runtime-team-host.test.ts` **29/29 PASS**. Новая unit suite не создавалась.
- Existing actual Codex Desktop Resume journey расширен: readonly Stats до второго
  turn; после уже существующего второго turn — один visible Composer `/cost`.
  Expected totals проверяются независимо как прежний snapshot + actual current-input
  usage journal. Дополнительных native prompts для Stats/command нет; старый reply
  сравнивается по original snapshot/bytes.

**Оставшийся gate:** independent review source и exact-head native/Desktop CI ещё pending.
Локальные composition fixtures/typecheck не являются native или Desktop PASS.


### R12 — ограниченный разбор имени slash command

PR1186 `PRRT_kwDORVTEtM625QoJ` указывает на overlapping whitespace regex в
`packages/legacy-agent-host/src/team/nativeSessionCommand.ts`.
Текущий код использует из match только command name и сохраняет исходный trimmed text.

1. Разбирать только bounded имя (1–64 символа) с whitespace/end boundary.
   Остаток строки не сканировать второй regex-группой: native arguments по-прежнему
   передаются в исходном trimmed `raw`, без нового parser/normalizer.
2. Сохранить прежние допустимые names, Unicode whitespace, многострочные аргументы,
   отказ пустой/слишком длинной/невалидной команды и native ownership gates.
3. В existing command integration добавить только существенные boundary/adversarial
   inputs; проверить одинаковый результат до/после для конечного набора форм и
   большой whitespace suffix без отдельной benchmark/unit suite.

Source-круг: parser consumers читают только `name/raw`; arguments API не меняется.
Architecture-круг: один bounded regex, без dependency или command framework.
Независимое source review и existing command tests обязательны до source publication.

Existing foreign-cost case при исполнении оказался остановлен раньше нужной проверки:
он меняет commandId, оставляя старый payload.messageId. Исправить только oracle, связав
оба ID с одной original попыткой; проверка чужой generation должна дойти до hold,
а production запрет несовпадающих message/command IDs остаётся прежним.

### R13 — builtin /review в закреплённом Claude SDK 0.3.305

**План до source.** На parity `522c80d168d698fc6842ee649cc4822406cd2632`
actual Create job [131717484659](https://github.com/777genius/agent-teams-ai/actions/runs/43373956602/job/131717484659)
отказал в `native-claude-compaction.native.ts` до Desktop UI:
`native builtin review expands its prompt`. Artifact `14014049387`,
ZIP SHA256 `b73b8e25fa91c9d57a639cd127b94e46f37f86fd750b097e2e75bc9dd8eaacc7`.
Оба TEST oracle — `fixtures/native-claude-compaction/model.ts` и
`fixtures/native-claude-commands/model.ts` — требуют прежние expert-reviewer/PR-number
строки. Эти строки отсутствуют в actual pinned native CLI; изменение product
command parser или D dispatch по этому отказу не обосновано.

#### Источник нового критерия

В отдельном изолированном TEST Linux scope прочитан первый настоящий model request
через установленный SDK `0.3.305`, native CLI `2.1.305`, Node `24.21.0`.
Native executable SHA256
`86cb722ab68348877dba7971e4d0c659919e05e6228c05e006e83da320e656ef`.
Два конечных original query — Sonnet4.6 и Opus4.6 — передали ровно один исходный
`/review TEST_NATIVE_P03_EXACT_REVIEW_ARGUMENTS` каждый. В обоих expanded user
blocks присутствуют exact target header и heading сбора diff; основной recipe
одинаков. Только localhost модель возвращала конечный текст, инструментов не было.
Для каждого query: один model request, SDK result success, original child exit0,
HTTP server закрыт, private TEST root удалён. Это inspection native recipe на Linux,
не Host, vendor-auth, Darwin или Desktop qualification.

#### Минимальный correction

1. В двух existing TEST model scripts заменить только устаревший review-prompt
   predicate. Требовать actual expansion в **одном user text message**:
   exact ``Review target: `TEST_NATIVE_P03_EXACT_REVIEW_ARGUMENTS` `` и
   `## Phase 0 — Gather the diff`. Bare slash input, generic review prose,
   неправильные args и совпадение только в system/tool text не доказывают expansion.
   Для второго model request искать retained original user message в той же history:
   latest user там законно является tool_result.
2. Если predicate переиспользуется, оставить маленький TEST helper в existing
   compaction model, откуда commands model уже импортирует constants. Не добавлять
   dependency, recipe parser, полный proprietary prompt snapshot или версионный
   allowlist/fallback на старые фразы.
3. Сохранить exact selected model, captured role/system context, original args,
   marked slash command receipt, MCP tool/reply IDs и text, два requests на command,
   compaction/current-context checks, original process ownership, cleanup и budgets.
   Production SDK/Host/D code и native effect sequence не меняются.
4. Расширить только existing critical model test: raw slash, wrong target,
   отсутствующий diff heading, system-only совпадение отказываются; observed minimal
   recipe в actual user history принимается. Existing tool_result/role/tool-count
   assertions остаются. Отдельная unit suite на шаблон не нужна.
5. После независимого source review проверить existing compaction model tests,
   Host test types и scripts types. Далее штатный exact-head Create/Commands
   native/Desktop CI должен пройти всю прежнюю цепь; локальный recipe inspection
   и обновлённый TEST oracle не являются полным e2e PASS.

**Круг1 — факты:** сопоставлены actual Darwin failure и два bounded native Linux
request на тех же SDK/CLI/model revisions. **Круг2 — минимальность:** меняется
только сломанный predicate, причём совпадение ограничено одним user message;
сильные product/ownership/effect guards сохраняются. **Круг3:** independent review
плана, commit+push перед source, затем independent diff review и existing gates.

Independent plan review (Account) — PASS: оба original local receipts/model bodies
проверены, anchors находятся в user text; wrong target, raw slash и system-only
match не дают acceptance. До source отдельно воспроизведено, что прежний oracle
отказывает на обоих actual pinned request bodies с тем же review-expansion assertion.

R13 source3 independent review (Account) — PASS. Existing two critical model
cases PASS; Host test types, scripts types, fast lint и diff check PASS.
Corrected shared predicate также принял **неизменённые** оба actual local
recorded request bodies, которые до исправления отвергал прежний predicate.
Raw slash/wrong target/missing heading/system-only/assistant/split-message cases
по-прежнему отказываются. Production files0; native/Desktop acceptance pending.


### R14 — actual CI: восстановление Promise-контракта и unopened activity oracle

Qualification head `7563eb067b9196ca416a56228f9c7e38a2455a17`, parent
`64c33f663ba48f34352b927a5d4a88fb2ec04b12`,
[run43377998027](https://github.com/777genius/agent-teams-ai/actions/runs/43377998027):
Host job131741574632 падает в existing `team-code-review.test.ts:317` с
`Team operation hold`; Main job131741574659 — в `hostActivityRouting.test.ts:196`
с generation1 против actual null. Сверка с exact current
`3db75ad8b323bede28d92c99c6d8eb1defb50f1b` подтверждает, что оба source seam ещё
не изменены. Это две разные причины, не повод ослаблять recovery/authority.

**Круг1 — причинная граница и минимальный source.**

1. `TeamOwner.resumeTaskCommands`289–291 добавил synchronous
   `resumeHostCostCommands` перед existing `TaskRecovery.resume`.
   `resumeHostCostCommands`261–263 валидирует все command families; отказ
   `validateCommandEntry`138–139 теперь может выйти до возврата Promise.
   Existing `TaskRecovery.run`267–275 выполнял тот же отказ внутри async operation.
   Пометить **только** existing owner method как async: scan и исходный Task
   continuation остаются в прежнем порядке/owner fence; unknown family по-прежнему
   даёт HOLD, но через прежний Promise-контракт. Не ловить/пропускать receipt,
   не запускать заново review mutation, не менять fingerprint/phase.
2. R9/R10 intentionally исключают никогда не открытые configured recipes:
   `readTeamActivity`74–77 проверяет unattached + отсутствующий record либо
   config=null/inputs=[], а empty projection189–205 имеет generation=null.
   В existing `hostActivityRouting`194–225 provider ни разу не открывается.
   Исправить ровно его stale expectations на generation=null и generations=0;
   сохранить null reported usage/cost, пустые events и явный retained-activity gap.
   Existing `contexts=[]` продолжает проверять отсутствие allocation.

**Круг2 — falsification и приёмка.**

Existing `team-code-review` pending case должен сначала вернуть пустой Task
continuation, сохранить original interrupted file/unknown review receipt,
затем после намеренного unknown-family изменения вернуть rejected Promise/HOLD.
Его `assert.rejects(originalMethod())` не переводить в catch, который скрывает
синхронную регрессию. Нужны existing focused Host case/types и Main activity case;
R9/R10 opened-empty/retained-history cases остаются прежними. Новая unit suite,
runtime generation или native input не нужны.

Source peer review проверяет, что async меняет лишь способ выдачи ошибки, а
activity oracle не скрывает реально открытый пустой runtime. После root commit+push
обычные CI jobs должны выполнить эти cases на новом source. Executor сейчас
недоступен; этот план и immutable source readback не являются executed PASS.


### R15 — actual builtin /review: установить расположение захваченного контекста

Exact current3db, Create job131757637356,
[run43386943005](https://github.com/777genius/agent-teams-ai/actions/runs/43386943005),
artifact14020313358 (ZIP SHA256
`94f5a311a16c30d37ffa31e34334a728f32044a82a98df723b32a3130d2c0a86`):
existing compaction/native-command journey прошёл project/user commands, затем
первый `/review` send на764 отказался с
`named native command keeps captured team system configuration`.
R13 exact review expansion уже принят; отсутствует отдельное доказательство,
где native положил захваченный marker. Прежние local Sonnet/Opus request bodies
после потери среды недоступны, а сохранённая сводка доказывает только user review
anchors. Их нельзя использовать как разрешение ослабить system predicate.

**Круг1 — измерить тот же original failed request.** В existing
`fixtures/native-claude-compaction/model.ts` вынести уже существующий strict
body.system marker check в маленький TEST helper; вызвать его в двух прежних
command-model helpers через existing import. Accepted requests сохраняют прежнее
условие: marker обязан быть в serialized body.system. Никакой user/assistant/
tool-result fallback не вводится.

Только при исходном отказе добавить к его existing assertion message закрытый
JSON projection того же body: фиксированная command phase, body/system SHA256,
system shape и число marker-bearing blocks по закрытым role/type категориям.
Не более16 role/type counters; whole projection не более2KiB, исходный body
уже ограничен existing2MiB guard. Не печатать тексты, произвольные role/type names,
tool input/results, paths, endpoints, headers, environment или request dump.
System absence остаётся refusal. Existing modelFailures и обычный CI log/receipt
уже сохраняют exception message, поэтому новый artifact schema/channel не нужен.

**Круг2 — falsification без native расходов.** В existing model.test добавить
один critical case: marker только вне system по-прежнему отвергается; failure
facts называют только закрытую role/type категорию и SHA/counts. Проверить
projection bound и отсутствие deliberately unique TEST raw text. Обычный
system-positive путь, exact review target/user anchors, native MCP result/cause,
model selection, original IDs, ten-request bound и cleanup не меняются.
Не добавлять replay, prompt, unit suite или новую CI row.

**Круг3 — вывод только из факта.** Independent source review и existing model
tests/types, затем следующий уже необходимый exact-head native Create gate.
Source пока не исполнен; после actual projection отдельно определить:
действительно ли context перенесён в другой доверенный native frame или потерян,
и как это соотносится с прежним frontend. Диагностика не закрывает parity и не
превращает missing captured configuration в успешный native command.

## R16 — Первый одиночный "/" в captured Composer

**Actual receipt boundary.** Source235, run `43394002053`, job `131780548885`
завершился с `UI read timed out: captured native command suggestions`:
`desktop-native-commands-ui-proof.ts:51 → desktop-codex-cost-ui-proof.ts:94 →
desktop-launch-ui-smoke.ts:349`. Это первый /cost **до** исходного Stop/Resume.
Native Launch уже прошёл existing eight-request assertions и Stats read; сам /cost
ещё не отправлен. Artifact `14023246198`, ZIP SHA256
`583eabbc08cebdefbe895d2be386f344fcbf39c5074da78ee4bc8969f15c004e`.
Из completed log не следует, что native capability потеряна: receipt/PNG/runtime
в ZIP пока не прочитаны. Ни runtime failure, ни causal closure не заявлены.

### Круг1 — воспроизводимый UI seam

В current `MessageComposer.tsx:432–495` наличие command suggestions зависит от
текста, начинающегося с "/". При пустом тексте child получает пустой список,
хотя exact captured lead уже имеет `sessionCommands`.
`MentionableTextarea.tsx:443–453` включает "/" в triggerChars лишь при непустом
commandSuggestions. Первый input обработан старым render:
`useMentionDetection.ts:285–317` вызывает onValueChange, затем проверяет новый
текст со старым triggerChars и dismiss. Новая render-проекция сама detection
не вызывает; hook ждёт следующий input/selection event. Поэтому одиночный "/"
может не открыть каталог, хотя дальнейшая обычная печать случайно исправляет UI.

В existing `MessageComposer.pendingSend.test.tsx` добавить один critical
controlled case с настоящим MentionableTextarea/useMentionDetection для этого
case через существующий component mock boundary. Exact captured Codex lead
имеет только /cost, draft первоначально пуст. Focus и **один** input "/",
без дополнительного character/selection/key event, должны открыть ровно /cost.
Никакого Send, backend invocation, skill lookup или альтернативного command
catalog. Старые pending-send cases сохраняют прежний mock. Это проверка
существующей пары компонентов, не новая UI test suite или harness.

### Круг2 — минимальная исправляющая ветка

В том же memo `MessageComposer` читать уже имеющиеся captured commands
независимо от текста. Только captured-host branch переносится перед
`slashCommandDataEnabled`; управление visibility/trigger остаётся у прежнего
MentionableTextarea. Legacy built-ins и IO project/user skills сохраняют
свои прежние guards, включая lazy fetch; команды из management/другого
provider/current global defaults не добавляются.

Снятие captured capability удаляет /cost из suggestions при следующем render;
пустой captured список не переключается на legacy. Existing deferred-data
case по-прежнему обязан показать ноль expensive reads до нужного trigger.
Не добавлять повторный input в E2E, таймер, polling effect для искусственного
открытия меню или изменение native /cost admission.

### Круг3 — ограниченная квалификация

Изменения: один production Composer и один existing component-test файл.
Focused renderer test/types/lint; по возможности сначала original-source RED
и затем исправленный PASS. Пока executor недоступен, source-only составление
не является выполнением этого условия. Независимый source review обязателен.

Далее тот же уже существующий Codex Resume UI job должен пройти первый catalog
→ one Send → исходный Host-local report без model/input allocation, затем
Stop/cold Resume, retained report и новый /cost по существующим assertions.
Если actual gate снова не покажет каталог, отдельно разобрать original runtime
projection/фокус по фактическому receipt; не ослаблять готовность, generation,
captured-host authority, exact catalog или successful cleanup.

## R17 — actual native `/review` fork context before a provider change

### Круг 1 — подтверждённая причина и прежняя возможность

Actual235 `native-claude-compaction` остановился на первом `/review` request:
native expansion и original arguments уже прошли, но captured member marker
отсутствовал в system и во всех 16 закрытых role/block counters. Предыдущие
project/user команды сохранили marker и выполнили свои original MCP replies.
Receipt SHA256 `ebc07efeed7e9427e861382ef504a81864c196012277ed38a2e248d3acfb58d4`;
cleanup и source pins подтверждены. Это не successful review acceptance.

Source audit сохранён отдельным immutable blob
`c687a6b50befccb17dcbc43f966a68bc9090cef3`. В actual installed Linux SDK0.3.305 /
CLI2.1.305 binary SHA256
`86cb722ab68348877dba7971e4d0c659919e05e6228c05e006e83da320e656ef`
bundled `code-review` alias `review` выбирает fork. Native slash dispatcher
`no → aen → lR` создаёт отдельный general-purpose prompt; actual systemPrompt
строится из его `getSystemPrompt`, а parent append остаётся только в options.
Linux source объясняет Darwin symptom как inference; это ещё не новый native
wire proof.

Прежняя возможность проверена по exact donor4a, без подмены runtime:
[lock1757d797](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/runtime.lock.json)
указывает runtime0.0.160 / `e13edcd3d4ffbecc0272ae30195cc6b15b710ee7`.
Его [review](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/commands/review.ts)
— inline prompt без `context: fork`;
[dispatcher](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/utils/processUserInput/processSlashCommand.tsx)
выделяет fork только при явном поле. Original
[bootstrap loader](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/hooks/useNativeAppManagedBootstrapContextInjection.ts)
передаёт member context как meta user prefix в ту же conversation через
[Inbox submission](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/hooks/useInboxPoller.ts).
Сохранять нужно доступность captured context при review, а не выдуманное
требование, что старый frontend всегда размещал его в API system field.

### Круг 2 — один отдельный bounded TEST proof публичного hook

1. Создать новый isolated TEST project/HOME/config и original session/input UUID.
   Не использовать root235 операции, session/history, личный HOME или credentials.
   Зафиксировать SDK/package/native hashes до и после; выбранный binary только
   actual pinned Linux0.3.305. Никакого vendor source patch.
2. Reuse existing finite localhost Anthropic SSE implementation из
   `tests/fixtures/native-claude-team/model.ts`: original parser/request-size
   ceiling2MB и обычный `emitResponse`. Для одноразового diagnostic driver
   допустим точный перенос emitter в TEST scratch с записанным source hash;
   новый постоянный harness, workflow или suite не нужен. Принять ровно один
   model request и вернуть один plain-text TEST result; любые tool-use/model
   continuation/retry отказать. Token-count endpoint, если native его вызовет,
   остаётся в прежнем finite bound8, отдельно от inference.
3. SDK public `query` получает ровно один original `/review` с exact TEST args,
   model Sonnet4-6, `tools: []`, пустые MCP/allowedTools, strictMcpConfig и
   пустые settingSources. `canUseTool` отказывает всем неожиданным запросам.
   Не включать internal appendSubagent flag, coordinator mode или permission
   bypass; не переписывать slash text/native recipe.
4. Передать разные TEST markers: один через обычный parent preset append,
   другой — только через публичный
   [SubagentStart additionalContext](https://code.claude.com/docs/en/hooks#subagentstart).
   Hook проверяет actual original session_id, bounded native child id/type и
   original cancellation signal; возвращает только context string, без
   permission decision, updatedInput, authorization/registration или MCP grant.
   Его marker не является копией parent marker и не маскирует отсутствие parent
   append. Pinned source `lR → hTr → additionalContexts → hook_additional_context`
   вызывается и для slash fork, не только Agent tool; native proof проверяет это.
5. Сохранить только закрытый receipt: original input/session IDs, bounded native
   child ID/type, hook/request/result counts, body/system hashes, role/marker
   presence, exact review expansion booleans и native parent result association.
   Не сохранять raw request, full prompts, transcript paths, environment или
   произвольные hook fields. Missing original correlation остаётся unknown,
   synthetic `forked-command-*` не превращается в observed Agent tool.
6. Original session bound45s не увеличивать. Public spawn hook сохраняет именно
   original ChildProcess/native identity; original SDK close/EOF и штатный
   captured-process cleanup должны завершиться с actual exit и read-only
   physical absence. Root exit, deadline или отсутствие event сами по себе
   не являются whole cleanup. Собрать bounded failure receipt в finally,
   закрыть localhost listener; не делать автоматический повтор input.

### Круг 3 — граница результата и следующий product cut

Proof выше квалифицирует только public hook delivery и actual fork/result
identity. Он не закрывает P03 feature/e2e и не меняет strict current oracles.

Сравнить отдельно два уже существующих product scope:
- Original235 fixture задаёт `nativeTools: []`, поэтому ordinary subagent port
  отсутствует; это не положительный тест parent MCP authority для native fork.
- Обычный product profile с tools получает `ClaudeSubagents.hook`: child требует
  original Agent-parent provenance, current original input и разрешённый child
  tool; `createCapturedClaudeSubagents` исключает Team/MCP tools. Slash-fork
  не получает этот parent только из native ID или context marker.

После successful proof подготовить отдельное peer-reviewed уточнение D:
literal original captured `projectInstructions.append` может передаваться как
public child context с прежними session/signal guards, но не даёт child
личность/полномочия Team member. Не менять ordinary child authorization,
native receipt provenance, MCP scopes или main-thread correlation ради зелёного
oracle. Before product implementation отдельно определить observed review
result/tool path; прежние project/user MCP assertions сохранить. Затем reuse
existing D critical hook case и actual compaction/Desktop command gates,
без fake parent marker, новых native inputs в существующих journeys и
расширения timeouts.

## R18 — captured `/review` context and its original native result

### Круг 1 — actual proof and the visible result contract

R17 executed once in a new private TEST scope under exact Node24.21.0 and the
pinned SDK0.3.305 Linux executable. Evidence manifest
`cd4bf26edeaa944c05993a2a4b9cb867eaabcc4a` contains the frozen driver,
Node-stripped executable and closed receipt
`02da33de04568350b1fbfd3274e9951a0180ba8e`
(SHA256 `ba03c7baaf3be64d35cd960cc1b0a5deedd1b15d5dda38e8527819c95e036628`).
There was one inference, one public SubagentStart callback, no tools or permission
requests, and 1.663 seconds elapsed within the original 45-second bound. Native
exit0, absence of the original captured process group, listener closure and
unchanged source hashes were observed. Profiles independently reviewed the
driver source. Original235 remains INCOMPLETE; this proof is not Host/Desktop
feature acceptance.

The parent append marker was absent in every role; the separate hook marker
was in one user block. The native task-start/task-notification and child user
frame used the hook's native child ID. The main success result contained the
plain review response and echoed the exact original native user UUID. Its
main-thread assistant frame had neither a child ID nor an original UUID echo.
The hook's prompt_id differed from the submitted UUID, and its control
toolUseId is not an observed Agent parent.

Source references for the next change:
- D [session](https://github.com/agent-teams-ai/old-provider-implementations/blob/f4b4ac3f6fa4284091aca333e114778a8e84acd7/packages/provider-implementations/src/features/provider-session-implementation/adapters/claude-sdk/session.ts):
  PendingInput/captured command, currentInput, public hooks, accept/correlate
  and exact echoed-result branch. An un-echoed assistant remains unbound.
- D [commands](https://github.com/agent-teams-ai/old-provider-implementations/blob/f4b4ac3f6fa4284091aca333e114778a8e84acd7/packages/provider-implementations/src/features/provider-session-implementation/adapters/claude-sdk/commands.ts)
  and [existing actual catalog test](https://github.com/agent-teams-ai/old-provider-implementations/blob/f4b4ac3f6fa4284091aca333e114778a8e84acd7/packages/provider-implementations/tests/features/provider-session-implementation/claude-sdk/commands.test.ts):
  builtin canonical code-review, alias review, exact-name precedence and
  immutable catalog capture already exist.
- Host [publisher](https://github.com/777genius/agent-teams-ai/blob/235b01b489a4f428b72c7667b0c89061c82cab1b/packages/legacy-agent-host/src/composition/publishNativeCommandOutput.ts)
  already derives one visible /cost reply through the original Team ledger,
  exact binding/input/operation, terminal state, delivery fingerprint and
  nativeSessionCommandCause. Reuse this route; do not create a child MCP call.
- Donor inline review and bootstrap references remain in R17. Functional
  output belongs to the original human turn; the child is not a Team member.

### Круг 2 — one native Read proof, then the complete command path

Before changing D, run one new isolated TEST /review operation with one Read
of its own immutable TEST file. Use the same exact Node/SDK/native pins, private
HOME/project, public hooks, original 45-second bound and captured ChildProcess
cleanup as R17. The finite localhost model may accept exactly two inference
requests: one returns one native Read; the second requires that original
tool_result and its TEST file marker, then returns the final review text.
No MCP, shell, write, Agent call, retry or second input is admitted.

Use public SDK `settings.permissions.ask: ['Read']` solely in this TEST
query so ordinary in-workspace read approval cannot skip the permission seam.
Keep tools=['Read'], allowedTools=[], no permission bypass. Record closed
task-start/hook/PreToolUse/canUseTool sequence facts. Allow once only the exact
original toolUseID, Read name, native child ID, unchanged TEST-file input and
active signal; return no persistent permission update. Require actual
canUseTool.agentID to join the task/hook child, the genuine Read result, exact
original main-result UUID, unchanged TEST-file/source hashes and original
physical cleanup. Keep bounded closed task_started facts: actual task/tool
IDs and field-presence, task_type, parent_task_id, foreground/background
flag, spawn depth, skip_transcript/ambient flags and exact canonical command
label comparison; preserve monotonic task/hook/tool callback ordering.
Do not store raw descriptions or prompts.

Production routing has an explicit prerequisite: these actual public fields
and their source-backed origin must distinguish this native command fork
from a late/background ordinary Agent child. Same session, current input
and general-purpose type alone are insufficient. If the discriminating
field is missing, the needed envelope arrives only after a blocking hook,
or the identity/ordering differs, retain the unknown qualification and
amend the design before product source. Do not invent an origin from
timing, an omitted field alone or a synthetic parent string.

The production path is the existing authorized native command, not ordinary
Agent delegation: Host nativeSessionCommandAuthorized/nativeSessionCommandCause
already require the original completed human-to-lead command and captured
binding. D retains that original PendingInput and the immutable selected
profile. No new permission RPC, Team grant or configuration owner is needed.

1. Keep the captured canonical builtin command on the original PendingInput.
   Only that code-review selection qualifies; a custom command named review,
   a stale catalog, ordinary text and other native commands do not.
   Add at most one transient native fork correlation to that same pending
   input. It is not a registry, replay record, tool owner or runnable entry.
2. Observe the original SDK task-start metadata before the existing generic
   child observer consumes it. Require the same native session, current handed
   PendingInput, canonical review fork, a bounded native child ID and native
   general-purpose/top-level foreground identity. Conflicting or missing
   native metadata provides no context. The pinned native source registers
   this task via KPn before lR invokes SubagentStart; control callbacks may
   still race the output iterator, so use the existing original-input
   cancellation/deadline pattern for their bounded join. Do not equate
   hook prompt_id with nativeRef or turn a synthetic forked-command name
   into an Agent parent.
3. The public SubagentStart callback joins that exact original child/session
   and active PendingInput, rechecks revocation and currentInput after any
   await, then returns only the existing immutable
   nativeOptions.projectInstructions.append as additionalContext.
   No internal SDK option, prompt rewrite, environment injection, grant,
   permission decision or updated tool input is added. Existing Pre/Post
   hooks and ordinary Agent/subagent/tool-binding rules remain unchanged for
   their existing scopes.
4. Add the minimum explicit command-native-tool route to that same original
   PendingInput, not an Agent parent entry. After exact native task→hook child
   provenance is established, a native PreToolUse for that child may bind its
   exact toolUseID/name using the existing per-session tool ownership and
   tombstone checks. Its allowed names are only the original selected
   nativeTools minus existing Team/Task/Agent/MCP/scheduling/delegation
   exclusions; a command name or child ID does not select additional tools.
   This route returns a neutral hook result, never a permission grant.
   The original SDK permission mode, selected auto-allowed tools, deny rules
   and original canUseTool/Interactions path still decide execution.
   An ordinary Agent child continues through the existing ClaudeSubagents
   guard. Missing/foreign child, conflicting/reused tool ID, changed current
   input or revoked signal cannot enter the command route.
5. Route an actual command-child canUseTool request only after its agentID
   and toolUseID/name match that exact native pre-tool observation and current
   PendingInput. Reuse existing Interactions and its cancellation/answer
   handling; retain the native child identity instead of rewriting it as a
   main-thread call. The callback that publishes the interaction may attribute
   this proven command operation to its original input, but must not insert
   an ordinary Agent parent, call the Team/MCP binding or auto-approve it.
   Normalize only that original child's actual tool/tool-result activity
   under the existing input/event byte budgets. Child text, usage and terminal
   frames do not complete the parent turn or get reattributed as a main result.
   Keep physical subprocess custody with the original SDK owner; this adds no
   process registration, replay or cleanup substitute.
6. In the existing exactly echoed main-result branch, project the successful,
   nonempty native code-review result into one complete text fact under a
   separate reserved `native-command-result:` message-ref namespace.
   Require original session/nativeRef, main-thread shape, captured builtin
   command and the original fork correlation; a child result, foreign echo,
   failed result, missing result or custom command never gets this projection.
   Preserve the existing local-command namespace and its /cost behavior.
   Filter model-supplied text IDs from both reserved namespaces before adding
   this trusted projection. Do not reattribute the unbound assistant frame.
7. Extend the existing Host publisher's closed namespace check for this
   review result, retaining its single-output ambiguity check and all original
   Team cause, authority and ledger guards. The visible reply uses the same
   existing `native-command-output-${runtimeDigest({ binding, inputId })}`
   identity and /review summary. Exact lookup/recovery publishes it once,
   without a second native input, another model request or an invented
   message_send receipt.

### Круг 3 — existing critical verification and full parity closure

- Extend the existing D commands case with the real native field shapes:
  task/control ordering, literal context, exact echoed main result and
  reserved-prefix refusal. Keep foreign UUID/session, custom-command,
  cancellation and ordinary MCP/Agent boundaries exercised through that
  same fixture. Exercise the exact Read permission/tool-result path, including
  an unrelated child/tool refusal and stale response after cancellation, in
  the existing command/interaction cases. Do not introduce a new general
  test matrix.
- Extend the existing Host team-rich-message publication case for the new
  explicit namespace and deterministic original reply. Retain original
  /cost publication, repeated lookup and ambiguous/missing output refusal.
- In the existing native compaction and Desktop native-command journey,
  change only the review result mechanism: the native compaction scenario
  uses one Read/tool-result exchange followed by a plain final response;
  Desktop's review phase uses one plain final response. Both require the
  exact native recipe/arguments and captured context in the actual
  hook-delivered user block. Project/user commands still perform their
  original two-request MCP tool/result exchanges with exact tool IDs.
  The review assertion must prove exact terminal input/operation, original
  native result text, one deterministic published Team reply and visible
  conversation output; it must explicitly stop claiming a native MCP reply.
  Compare original input/receipt/inbox bytes after cold lookup/reload and
  require no added native allocation/request or duplicate publication.
  Desktop's plain review uses one inference; the native filesystem proof uses
  its exact two-round Read/result exchange. Input counts, ownership/cleanup
  guards and time budgets do not increase. Retain closed failure diagnostics
  and source-pin checks.
- Qualify the command-tool route in the existing native commands fixture with
  one actual read of a prepared TEST file and its original permission reply,
  using the already existing original review input. Select Read in that
  fixture's captured nativeTools; prepare its public TEST ask-Read setting
  before source capture using the already selected settingSources, and
  retain/hash that source alongside the TEST file. Use the existing Runtime
  interaction reply route for exactly the observed original permission.
  Do not add an arbitrary SDK option or permission bypass to product config.
  The tool-result model
  round replaces the previous child-MCP round: no additional native input or
  larger budget is required. Retain the exact two-request review bound in that
  scenario; the Desktop plain-result phase may remain one request because it
  proves UI publication/reload. Freeze each scenario's actual expected counts,
  rather than sharing an incorrect blanket total.
- Full review parity requires all three observed parts: captured context,
  native filesystem-tool/permission behavior under the original profile and
  visible exact main-result publication with cold/reload stability. A source
  review, the tool-free R17 experiment or a plain response alone does not
  close this item. Do not widen ordinary Agent, Team/MCP or process authority
  to make the new command path pass. Unsupported native task/permission
  provenance stays unknown and causes a plan correction before release.


### R18 follow-up — public PermissionRequest path, with native policy unchanged

**Круг 1 — что известно и что ещё нужно доказать.** Оригинальный Read
experiment остаётся `INCOMPLETE`: receipt
`aca36b31f0aeaf3cd5d655eef637f58943de599c`, evidence manifest
`759274ea071a40ad9244014d3f6b4cb913f3db38`, pinned source audit
`0d954f797132d7af41a064673141fa8b6df96842`. Он наблюдал один original
PreToolUse, ноль canUseTool и неуспешный predicate исходного Read result;
точный raw error body не сохранён. Original child/listener cleanup подтверждён.
Повтор того же operation/root или замена этого результата на PASS запрещены.

В exact SDK0.3.305 native source slash dispatcher не передаёт canUseTool в
fork. Нейтральный PreToolUse сохраняет explicit ask, а fallback `asksNoHost`
не доставляет его existing Host UI. Production `captureClaudeSettingSources`
по умолчанию загружает user/project/local: это поддерживаемая политика,
а не искусственная особенность TEST. PreToolUse allow не отменяет native
ask/deny. `dontAsk`, bypass, удаление правил и silent auto-approval непригодны.

Официальные [permissions docs](https://code.claude.com/docs/en/agent-sdk/permissions)
документируют `permissionPrompts: 'none'`: canUseTool не вызывается, но
PermissionRequest hook ещё может решить исходный запрос, иначе native
отказывает. [SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
добавил option в0.3.259; прочитан immutable changelog blob
`9b67287225a06d3814e967a3fc6e548d3613633c`. Это public **query-level**
option, не изменение permissionMode и не доказательство работоспособности
в нашем fork. Наличие более новой0.3.323 само по себе не доказывает fix.

До нового native запуска прочитать exact уже закреплённые SDK/native bytes:
public Options и сериализацию option; native flag→permission context;
наследование этого context исходным slash fork; branch
shouldAvoidPermissionPrompts→PermissionRequest; финальную native обработку
allow/deny и updatedInput. Сохранить byte offsets/hash и краткие source
выводы. Не редактировать бинарник, не передавать internal option и не
выбирать другой SDK по предположению. При недоказанном inheritance — только
source finding и уточнение плана, без production изменения.

[PermissionRequest reference](https://code.claude.com/docs/en/hooks#permissionrequest)
не обещает tool_use_id в hook input. Отдельный prerequisite: реальный public
callback/envelope должен позволить однозначно связать ответ с original
PreToolUse tool ID, native child/session и PendingInput. Нельзя выбрать
один из параллельных одинаковых инструментов по имени/таймингу/первому
совпадению. Отсутствующий или неоднозначный ID оставляет route неподтверждённым.
`defer`/новый resume не является заменой этой связи или permission host.

**Круг 2 — bounded TEST proof, только после source prerequisite.** Reuse
immutable R18 driver `9fdc6c9c1fabc708fd12306ba0b5f472e4d79943`, exact
Node24/SDK0.3.305/native hashes и original cleanup. Два независимых fresh
TEST scopes, без reuse прежнего root/operation: (a) сохранённый explicit
ask:Read с once approval через public PermissionRequest; (b) explicit
native deny:Read как отрицательный tripwire. В каждом ровно один native
/review input, максимум два inference, один предложенный Read своего
неизменяемого TEST файла, ноль MCP/shell; прежний45s bound включает cleanup.
Не менять mode, allow list, original Read arguments или source settings
ради прохождения (кроме намеренно отдельного deny-сценария).

В ask case добавить public option и PermissionRequest callback; прежний
canUseTool остаётся счётчиком недопустимого неожиданного пути. Context и
origin должны пройти все прежние task→SubagentStart→PreToolUse guards.
Callback получает только exact original tool/child/session/input; повтор,
foreign ID, abort или expired original deadline даёт отказ. Allow не пишет
updatedPermissions и не меняет input; actual native tool_result обязан
содержать original toolUseID, success и TEST file marker. Main result
обязан эхом связаться с original user input. В deny case успешный Read
запрещён, approval callback не может перевести native deny в allow;
нужен exact original error tool_result без file marker и корректный main
terminal, а не один счётчик запроса.

Сохранить closed факты: callback ID presence/equality, child/session,
native permission mode, исходный tool/input digest, request/result counts,
is_error и marker presence отдельно (не один совмещённый predicate), source
hashes, original physical cleanup. Raw prompt/path/tool body не публиковать.
Если public hook не передаёт необходимую identity или callback не вызывается,
закончить scope с честным INCOMPLETE/refusal, без fallback approval и rerun.
Текущая недоступность executor не является execution evidence.

**Круг 3 — только затем решение о D.** Proof не включает глобальное изменение
provider option. Query-level переключение затронуло бы также обычные main
tools, Agent children, questions и MCP, поэтому до такого изменения нужен
отдельный bounded source review полного existing approval маршрута.
Кандидат должен reuse `Interactions.request` и original Host approval
owner, его exact-once reply, deadline, abort/cancel и current-input checks;
source settings, native allow/ask/deny/mode и ordinary Agent/MCP authority
остаются действующими. Не добавлять параллельный interaction registry,
permission RPC, session rule или synthetic Agent parent.

В existing D command/interaction cases затем проверить original approval,
user denial, abort/timeout/stale reply и отсутствие второго effect; native
deny не доходит до разрешающего UI пути. Question answer сохраняет свой
original question contract. Нужная public correlation и эквивалентность
обычных путей обязательны прежде product rollout. До их подтверждения R18
context/result/tool parity остаётся открытой; existing native/Desktop gate
и предыдущий failed status не ослабляются.
