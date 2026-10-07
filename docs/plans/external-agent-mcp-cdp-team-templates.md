# Готовые команды и внешний AI через MCP + CDP

План реализации, 2026-10-07. Изменён только этот документ; runtime и проверки не запускались.

## Цель и границы

Пользователь выбирает готовый состав команды или описывает задачу внешнему AI. Приложение копирует один prompt с составом, инструкциями и действующими адресами. AI сохраняет адаптированный draft непосредственно через MCP; команда появляется в приложении без переноса JSON обратно. Provider/model выбираются позднее.

- ✅ Шаблон - роли, состав, lead instructions и workflow, а не shell-команда/preset запуска.
- ✅ Доменные действия идут через MCP, полный UI-доступ - через нативный raw CDP и собственные инструменты внешнего агента: DOM, screenshots, input, JS, console/network.
- ✅ MCP работает вместе с desktop app независимо от AI-provider, auth и orchestrator launcher. Создание/copy/connect не запускают команду.
- 🔒 CDP - opt-in, только loopback, полный renderer trust, включая exposed preload API. Это не ограниченный MCP scope; main-process inspector не открывается.
- 🔒 Prompt не добавляет tools в произвольный клиент. Поддержка означает доказанный локальный MCP/CDP путь с честными registration/reload требованиями.

В первую поставку входят четыре встроенных состава: разработка фичи, исправление бага, code review, исследование; picker, editable preview и providerless draft; app-owned MCP, instance/context binding, live discovery, CDP toggle и copy prompt. Нет JSON import/export, marketplace/CRUD шаблонов, собственного UI/Playwright proxy, `ui_click`/`ui_fill`, arbitrary shell/JS MCP, OS/native-dialog automation, remote tunnels/cloud hosting или новой auth/RBAC/DI платформы.

Оценка после повторного аудита простоты: примерно 1 900-3 350 production LOC, 400-800 дополнительных tests/harness LOC при переиспользовании existing suites и 100-250 docs/config; всего около 2 400-4 400 changed LOC. Уверенность оценки 6/10: patch ещё нет, основные неопределённости - root-switch безопасность и existing edit/launch paths. Это ориентир, не квота на код/тесты; новый harness может увеличить объём только при доказанной необходимости.

Реализацию выполнять в отдельном managed worktree. Текущий checkout и чужие dirty edits не использовать как implementation workspace; исходный SHA и перенос нужного контекста определить перед началом реализации. Создание этого плана не означает начала реализации.

## Проверенная отправная точка

- `mcp-server/src/tools/teamTools.ts` уже предоставляет `team_list/get/create`; create сохраняет draft без launch, optional provider/model. Нужен новый opt-in контракт unresolved runtime, а не второй writer.
- MCP поддерживает stdio/httpStream; `AgentTeamsMcpHttpServer` владеет child, loopback `/mcp`, health identity, generation, deduplicated start и port selection.
- MCP стартует внутри `createOpenCodeRuntimeAdapterRegistry` после binary resolution. Early return при отсутствующем launcher обходит сервер.
- `startHttpServer` переиспользует singleton loopback `HttpServer`. `httpServer.enabled` регулирует auto-start; provisioning/work-sync уже demand-start вызывают его независимо от flag.
- Forced `claudeDir` в MCP не закрепляет control API: controller перебирает explicit `controlUrl`, общий state-file, env с fallback. Это может направить вызов другому app.
- `createTeamConfig` пишет `team.meta.json`/`members.meta.json`, не CLI `config.json`. `getSavedRequest`, launch/UI подразумевают Anthropic без provider.
- `dev:mcp` использует CDP 9222; packaged harness задаёт remote-debugging flags. Это precedent, не proof нового toggle/discovery или подписанных сборок всех OS. Изученные packaging settings не задают собственной fuse policy; actual binary проверить отдельно.

## Architecture и authority

Следовать `FEATURE_ARCHITECTURE_STANDARD.md` и q, без пустых слоёв/whole-service hosts.

| Boundary | Владелец |
| --- | --- |
| `features/team-templates/contracts`, `core` | `TeamTemplateV1`, каталог и apply policy. Pure код, без provider discovery/Electron. |
| Template apply/save | Pure apply заполняет существующий editor; сохранение через `api.teams.createConfig`. Собственный main service/IPC/`CreateDraftTeam` port для статического каталога не нужен. |
| `features/external-agent-connection/contracts`, `core` | Connection DTO, чистая сборка prompt, ready/stale semantics. |
| `external-agent-connection/main` | Сборка MCP/control/CDP snapshot и недостающего binding context; composition использует existing supervisor. Не дублирует child lifecycle, retry, port selection или state machine. |
| IPC/HTTP/preload/renderer | Adapters общего facade; renderer через app API, public entrypoints и shared Radix primitives. UI не читает process/store напрямую. |
| Existing team stores | Authority draft. Selection policy принадлежит общему team contract/pure resolver, не template UI. |

Каталог - поставляемый код с `schemaVersion`, `id/version`, названием, описанием, `teamPrompt` и `members{name,role,workflow,isolation?}`. `teamPrompt` содержит lead coordination; reserved canonical lead не добавляется обычным teammate. Нет provider/backend/model, cwd, credentials, CLI flags или permissions bypass. Копия становится независимым draft; обновление каталога её не меняет. Connection snapshot производный; persist только setting CDP и existing supervisor state.

## Providerless draft без legacy regression

1. Добавить opt-in `runtimeSelectionVersion: 1` в новые template/external drafts. Отсутствие marker сохраняет legacy Anthropic fallback. Никакой массовой миграции.
2. С marker отсутствие team provider означает unresolved; отсутствие member provider означает наследование после выбора team/lead provider. Pure resolver selected/unresolved используется main и renderer.
3. Сохранить marker через `TeamMetaStore` read/write normalization, patch/edit paths, saved-request DTO, fingerprints/cache invalidation и IPC/HTTP/MCP. В `agent-teams-controller/src/internal/runtime.js:createTeam` whitelist `compactBody` уже сохраняет `runtimeSelectionVersion`; добавить `expectedContext`, который промежуточный adapter сейчас отбрасывает. Не терять marker при обновлении другого поля. Unknown marker version - unsupported ошибка, не legacy fallback.
4. До provider model unresolved и selector недоступен. После явного provider отсутствие model означает его поддержанный default, показанный в UI. Explicit backend/model требует provider; смена provider сбрасывает несовместимые параметры существующей политикой.
5. Save/read/reopen не создают runtime. Launch всех входов требует выбранного team/lead provider; inherited members разрешены. На сильной application boundary возвращать `RUNTIME_SELECTION_REQUIRED` до spawn/launch-state mutations, включая HTTP/MCP/preload вызовы.
6. `team_create` получает additive marker; без него backward compatibility. Prompt передаёт marker; create result/readback явно отражают draft и unresolved selection.
7. Общая validation выполняется до записи: kebab-case teamName <=64, existing reserved/member rules, unique names, request/count/string limits согласно существующим persistence ceilings. IPC/HTTP/MCP не поддерживают разные правила. Failed create откатывает только свои artifacts.

Template apply использует existing editor/save API, MCP - existing controller/HTTP API; оба приходят в один writer. Existing Claude-folder import не превращается в portable-template importer.

## MCP lifecycle и context fence

1. После wiring team data/control APIs demand-start существующий `startHttpServer`, затем `AgentTeamsMcpHttpServer`; убрать provider-owned старт/stop. Runtime adapters используют тот же handle/app context. Не создавать второй listener и не менять persisted `httpServer.enabled`.
2. Одна appInstanceId на процесс, общая для adapters; supervisor owner UUID остаётся технической child ownership identity. Coordinator выдаёт immutable context `{appInstanceId, dataRootFingerprint, connectionGeneration}`. Generation растёт при rebinding/root change/MCP replacement; renderer target имеет отдельную generation.
3. Desktop-bound child получает exact loopback controlUrl, forced root и context. Controller resolver для control/runtime/work-sync tools использует только bound URL, без state-file/env fallback, rejects differing overrides `APP_CONTEXT_MISMATCH`; standalone stdio сохраняет lookup. Context headers/redirect policy передавать через фактический `runtime.js:requestJson` fetch builder, а не только MCP schema.
4. Каждый bound control request несёт immutable child context, проверяемый main до операции. External marker create дополнительно требует `expectedContext` из prompt/discovery; новый MCP handshake не подтверждает актуальность старого prompt. Поля expectation не credentials и не authentication.
5. Root switch сначала закрывает admission и отзывает старый generation; ждёт завершения допущенных mutations на captured root либо отменяет до записи, затем перезапускает owned MCP child с новым binding. Старые SDK sessions исчезают вместе с child; собственного session/auth механизма не добавлять. Validation/admission/captured-root operation образуют одну границу: после проверки нельзя читать изменившийся global root и писать в него.
6. Old same-port session после rebinding получает штатную transport session ошибку; stale child/request context main отвергает до mutation. Новый initialize требует discovery и обновлённого expectedContext, без автоматического повторения uncertain create. На create ожидаемый app/root/generation сравнивается повторно с live coordinator до admission; reconnect сам по себе не доказывает актуальность prompt.
7. `starting -> ready -> error/stopped`; ready означает owned MCP child с подтверждённой health identity и готовый exact bound control. Это доступность сервера, не proof подключения клиента. Initialize/discovery выполняет внешний клиент и transport test; собственный MCP client/session внутри coordinator не создавать, snapshot/copy не запускают self-probe. Provider status отдельно. Existing startPromise/port scan/owned cleanup сохраняются; bounded retries, UI «Повторить», без endless respawn. Shutdown запрещает starts и останавливает только owned resources.
8. Root/context/SSH mode changes отражаются явно; неподдержанный remote active context не перенаправляет local mutation. Несколько app имеют отдельные bindings. Общий data root означает общий storage; имя конфликтует через existing atomic mkdir/identity fence с 409, а не fictitious single-instance lock. Проверить фактическую cross-process conflict семантику.

Context/admission защита реализуется на общей bound control boundary и существующем root-switch lifecycle, с captured dependencies у затронутых operations. Не строить универсальный admission framework для приложения или отдельный coordinator для каждого tool; другие mutation paths менять только при доказанном участии в root-race.

Existing endpoint имеет широкий tool set и не является read-only/scoped security boundary. Проверить FastMCP Host/Origin handling: absent Origin CLI допустим, foreign browser Origin - 403, без wildcard CORS. Loopback не аутентифицирует локальные процессы.

## Полноценный CDP и discovery

1. `externalAgentCdpEnabled=false` по умолчанию. «Включить и перезапустить» объясняет полный renderer trust; pending restart не объявляет endpoint ready. Disable тоже требует restart, до него UI честно сообщает открытый доступ.
2. Читать setting и задавать renderer debugging switches до Electron `ready`. Не применять main `--inspect/--inspect-brk` или `webContents.debugger` как замену external CDP.
3. Короткий disposable packaged spike доказывает `port=0` с instance-owned `DevToolsActivePort` на pinned Electron/OS. Если unsupported, выбрать свободный порт перед relaunch и подтвердить ownership после запуска; bind race даёт error, не attach к чужому listener. Не hardcode 9222.
4. Читать `/json/version` browser WS и `/json/list` targets. Exact main renderer определяется mainWindow/webContents authority плюс renderer instance marker; не `targets[0]`, title или одиночный URL. Дополнительные окна/DevTools не выбираются. Агент повторно проверяет marker перед UI mutation.
5. Snapshot выдаёт HTTP origin, browser WS, exact targetId/page WS. Browser endpoint может видеть другие targets этого app; выбранный target - контракт клиента, не enforceable restriction raw CDP.
6. Renderer recreation/crash отзывает target; rediscovery публикует новый target generation. Reload того же target требует readiness/marker recheck, но не выдумывает новый id. Copy получает свежий snapshot.
7. Native CDP не получает выдуманного token/auth или немедленного revoke. Packaged evidence подтверждает loopback bind, реальные endpoint/target и отсутствие main inspector; signing/fuses не ослаблять. `nodeCliInspect` fuse относится к Node inspector, не renderer CDP.

`ConnectionInfoV1`: immutable context, app version/profile fingerprint, observedAt; MCP status/url/transport/generation; control status; CDP status/httpOrigin/browserWsUrl/rendererTargetId/rendererWsUrl/targetGeneration; capabilities, errorCode/reason/recovery. Disabled/error поля не содержат fabricated endpoint. `app_get_connection_info` без arbitrary URL/path читает live facade через bound control; IPC/HTTP возвращают тот же DTO, без credentials/environment dump.

## Copy prompt и bootstrap

Кнопка рядом с templates и в Settings копирует запрос пользователя + канонические `teamPrompt` и roster выбранного шаблона как data, id/version для provenance, context, реальные endpoints и инструкции. External AI не должен угадывать содержимое по template id; отдельный catalog getter не нужен. User task/role text отделить от trusted connection instructions. При MCP error не копировать обещание ready; CDP disabled допускает явно MCP-only вариант, полный вариант требует CDP ready.

Порядок внешнего агента:

1. Через уже загруженные native MCP tools вызвать discovery, сверить app/root/generation. При той же app/root и новом generation обновить expectedContext из live ответа; target generation обновляет только CDP target. Смена app/root требует нового prompt/подтверждённого context, без mutations.
2. Если tools отсутствуют, определить свой клиент. Штатные snippets: Claude Code `claude mcp add --transport http --scope user <unique-name> <actual-url>`; Codex `codex mcp add <unique-name> --url <actual-url>`. Без запуска обоих CLI, перезаписи unrelated entries или чтения credentials; значения shell-safe. Регистрация выполняется разрешёнными собственными tools агента либо штатным client UI.
3. Registration не гарантирует tools текущего turn. Без доказанной hot registration сообщить точный reload/restart/new session шаг и проверить discovery после него. Profile suffix в name исключает молчаливую перезапись соседнего подключения.
4. SDK/client-helper fallback не входит в обязательную первую поставку: не создавать, не устанавливать и не обещать поддержку собственного fallback клиента. Если внешний агент уже имеет совместимый MCP client helper, он может использовать его; curl health не считается MCP proof.
5. Нет MCP/HTTP client capabilities - конкретная инструкция/ограничение, без имитации tools/JSON roundtrip. Нет CDP клиента - MCP draft возможен, UI limitation явная. Cloud localhost без local executor unsupported.
6. Составить команду по задаче, `team_create(marker=1, expectedContext, ...)`, затем `team_get`; показать сохранённые роли/workflow, unresolved runtime и видимость draft. Launch только по отдельной явной команде пользователя. Для UI - собственный raw CDP tool, точный target и marker.

Пример сокращён (адреса демонстрационные; продукт подставляет фактические values и полный canonical roster):

```text
Создай draft команды для панели аналитики. Основа feature-delivery v1.
Контекст: appInstanceId=app-123, dataRootFingerprint=root-abc, connectionGeneration=7.
MCP: http://127.0.0.1:43421/mcp (Streamable HTTP).
CDP: http://127.0.0.1:43802; browser WS ws://127.0.0.1:43802/devtools/browser/abc;
renderer target=page-456, WS ws://127.0.0.1:43802/devtools/page/page-456.
Canonical data: teamPrompt="Lead координирует bounded задачи и приёмку";
members=[{name:"developer",role:"Разработка",workflow:"Реализовать и проверить"},
{name:"reviewer",role:"Ревью",workflow:"Проверить инварианты и дефекты"}].
Сначала app_get_connection_info; сверь все три поля context и renderer marker.
Если tools не загружены, выполни штатную регистрацию своего клиента;
назови необходимый reload, не выдавай настройку за успешное подключение.
Создай через team_create с runtimeSelectionVersion=1 и expectedContext,
provider/backend/model не задавай; прочитай team_get. Команду не запускай.
JSON обратно не передавай. При context mismatch останови mutations.
```

## Failure paths и проверки

| Риск | Ожидаемое поведение / evidence |
| --- | --- |
| Нет provider/auth/launcher | MCP/control ready, create/read работают; runtime не запускается. |
| Child/control failure, occupied port | Error/recovery, bounded retry, одна owned start attempt; чужой listener не выбран. |
| Same-process root switch / stale same-port session | Context rejection до записи; никакой команды в новом/чужом root. |
| Duplicate name / concurrent create | 409 без overwrite; test реальной atomic conflict, без предположения глобального lock. |
| Lost create response | Сначала get исходного teamName; совпадающий draft подтверждает успех, mismatch/uncertain - stop. Не retry с новым именем. |
| Malformed/partial persistence | Validation до mutations, narrow rollback; existing drafts сохранены. |
| CDP pending/crash/multiple targets | Status/error, без fabricated WS/first-target attach; rediscovery exact renderer. |
| Clipboard failure / freshness race | Copy-success только после успеха; readback/context проверка защищает stale snapshot. |

Тесты только на важный independent contract/observable regression, который existing suite не ловит. Перед новым тестом назвать конкретную поломку; сначала расширить ближайший existing suite. Существующие ценные тесты сохраняются, новых suites ради coverage не создавать.

| Ближайшая сильная проверка | Поломка, которую ловит |
| --- | --- |
| Один table-driven unit selection resolver | Новый draft превращается в Anthropic, legacy меняется, unknown marker silently accepted. |
| Existing persistence metadata test: create/edit/reopen | Marker теряется при unrelated edit; reopening меняет selection. |
| Existing сильная launch boundary | Unresolved request создаёт launch state/spawn до отказа. Не повторять на IPC/HTTP/MCP. |
| Bound control/root-switch fixture | Stale context или root switch между admission/write меняет другой root. |
| Один real MCP HTTP contract, расширить `mcp-server/test/http.e2e.test.ts` | MCP → controller → HTTP → saved/readback теряет marker/context; stale mutation accepted. Здесь же provider/launcher independence. |
| Один disposable packaged CDP smoke | Toggle/restart, exact target или renderer recreation работают неверно; input/screenshot/JS/console/network подтверждаются в том же проходе. |
| Один template/edit/copy UI flow | Состав теряется, clipboard failure показывает success, pending endpoint объявлен ready. Проверить в том же desktop flow, если это не ухудшает диагностику. |

Не добавлять отдельные unit tests для формы каталога, getters, DTO snapshots, текста каждого prompt, каждого CDP метода и повторного supervisor lifecycle. Existing `AgentTeamsMcpHttpServer` suites уже проверяют start coalescing, shutdown/ownership/readiness и foreign occupied port; расширять их только при изменении этих contracts. `teamMcpControl.integration.test.ts` с прямым tool call и intercepted fetch/Fastify.inject полезен для wiring, но не заменяет реальный MCP transport. Один сценарий не дублировать по всем слоям; дополнительный тест оправдан только отдельным незакрытым риском. Никаких процентных coverage targets или требования теста на каждый новый helper.

Все runtime/E2E - disposable sandbox projects, isolated HOME/userData/data roots, свои ports, owned cleanup; никакого runtime/terminal/agent action на реальных проектах. Heavy Electron/packaged proof - hosted workers. Новые handwritten harness `.ts`/`.mts` с meaningful typecheck.

| Клиент/сборка | Evidence сейчас | Нужно доказать |
| --- | --- | --- |
| Claude Code | Official HTTP registration docs, без запуска | Version, registration/reload, native tools create/read + собственный raw CDP. |
| Codex local | Official HTTP docs + `mcp add --help --url`, connection не проверен | Тот же flow; client/network sandbox не обходится. |
| Cursor | Official Streamable HTTP docs | До actual proof - «инструкция, не проверено». |
| Existing SDK fallback | Протокол изучен | За первой поставкой; без отдельного proof не заявлять поддержку. |
| Packaged OS | Existing harness precedent | Artifact SHA/version/fuses, toggle/relaunch/bind/discovery/target для заявленных OS. |

Acceptance: один конкретный local client/version проходит native MCP providerless draft и raw CDP на disposable packaged app одной заявленной OS; остальные version/OS не наследуют verified label. Широкая client/OS matrix и одинаковые E2E во всех клиентах не блокируют этот slice. Evidence: head/artifact SHA, isolated paths, context/endpoints, tool results, draft readback/UI screenshot, отсутствие launch side effects. Не логировать credentials.

Future gates: `pnpm typecheck` (pinned TS7, без global tsc7), `pnpm lint:fast:files -- <changed files>`, focused Vitest; MCP `pnpm --dir mcp-server typecheck`/`test`; controller `pnpm --dir agent-teams-controller test` и `build` перед packaged proof (отдельного typecheck script нет); source-size/provisioning architecture guards по scope. Каждый checkpoint - независимый review и required CI актуального head, без повторения доказанных phases без нового риска.

## Checkpoints и откат

Dependency-safe PR, цель около 2 000 changed LOC каждый с tests:

1. Templates + unresolved persistence/UI/launch guard: самостоятельный полезный slice.
2. Single app-owned MCP/control binding/discovery.
3. CDP opt-in/early startup/exact target + packaged proof.
4. Canonical prompt/bootstrap + supported external-client proof.

Оценка production по ответственности: templates/editor 250-450, providerless semantics 600-1 000, MCP/binding/discovery 500-900, CDP 400-700, prompt/UI 180-300 LOC. Tests считать по самостоятельным рискам, не дублировать один сценарий на каждом слое. Checkpoints задают bounded scope, а не требуют заполнить LOC budget.

Не разрезать один selection/context invariant ради размера; превышение budget объяснить фактической coherent boundary. Реализация ещё не разрешена этим документом. Не увеличивать frozen oversized files; orchestration выносить через feature entrypoints.

Откат CDP: off + restart. Внешний и internal MCP используют общий unauthenticated listener: скрытие copy UI не отзывает endpoint; отключение listener прекращает и internal HTTP bridge, который затем использует существующий stdio fallback где поддержан. Не обещать external-only revoke. Данные drafts сохраняются. Reader/launch guard marker должны оставаться совместимыми при rollback UI; downgrade к старому reader небезопасен из-за implicit Anthropic и не заявляется безопасным без отдельной миграции/блокировки запуска.

Оставшиеся spikes: packaged ephemeral-port discovery и exact client reload flow; доказать минимальную недоказанную фазу до маркировки поддержки. Не внедрять платформу ради этих неопределённостей.

Два независимых review плана завершены: round 1 - context fence, canonical template payload, shared-root semantics; round 2 - controller whitelist/request builder и сквозной transport test. Все 3+1 findings отражены выше. Это проверка плана, не доказательство реализации/runtime.

## Первичные источники

Проверены 2026-10-07. Protocol version negotiate с фактическим FastMCP, не автоматически обновлять зависимости ради новой spec.

- [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports): session/JSON/SSE, Origin и localhost требования.
- [Claude Code MCP](https://code.claude.com/docs/en/mcp), [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Cursor MCP](https://cursor.com/docs/mcp): registration/configuration; actual reload flow требует proof.
- [Electron switches](https://www.electronjs.org/docs/latest/api/command-line-switches), [CommandLine](https://www.electronjs.org/docs/latest/api/command-line): renderer debugging и early startup.
- [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses), [main debugging](https://www.electronjs.org/docs/latest/tutorial/debugging-main-process), [CDP](https://chromedevtools.github.io/devtools-protocol/index.html): разные inspector surfaces и native protocol.
