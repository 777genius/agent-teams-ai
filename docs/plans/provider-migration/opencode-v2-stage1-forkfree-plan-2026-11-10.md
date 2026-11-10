
# OpenCode V2 → Stage 1 Host: план адаптации и fork-free cutover

**Статус:** план на 10 ноября 2026; не код, не новое E2E-доказательство и не разрешение на merge/release.  
**Владелец:** Agent Teams. **Stage 2 (новые Orchestrator/agent-runtime) отложен.**  
**Цель:** перенос фактически работающего OpenCode V2 из старого `claude-multimodel` в существующий Stage 1 Host без второго владельца, лишних миграций или изменения UX.

Связанные PR: [Stage 1 #982](https://github.com/777genius/agent-teams-ai/pull/982); [V2 static #1106](https://github.com/777genius/agent-teams-ai/pull/1106) → [V2 Host #1110](https://github.com/777genius/agent-teams-ai/pull/1110); [provider extraction #1](https://github.com/agent-teams-ai/old-provider-implementations/pull/1) → [provider V2 #2](https://github.com/agent-teams-ai/old-provider-implementations/pull/2). Нормативные документы: [Stage 1](stage-1-legacy-host.md), [контракты](stage-1-contracts.md), [матрица M01–M19](compatibility-matrix.md), [общая программа](README.md).

## 1. Исходное состояние, проверенное по GitHub

- `agent-teams-ai/old-provider-implementations`: default `bootstrap` содержит документы; код находится в `feat/extract-providers` ([PR #1](https://github.com/agent-teams-ai/old-provider-implementations/pull/1), переведён в **Ready for review**), доработки V2 — в зависимом Draft #2. Это не пустой проект. После **собственных** exact-head CI, независимого review и проверки package/public exports PR #1 можно слить в `bootstrap` как source extraction **без npm/release**. #2 не считать готовым вслед за #1 и не удалять vendored package до его замены проверенным артефактом.
- `packages/legacy-agent-host` — независимый **пакет и процесс внутри frontend-репозитория**, не отдельный Git-репозиторий. Provider Session SPI и Claude/Codex/OpenCode adapters живут в provider repo. **Не выделяем Host в новый repo сейчас:** это перемещение само по себе не исправляет ответственность или E2E.
- Stage 1 candidate уже проходит реальные Electron/SDK/CLI tests с ограниченным localhost inference и не нуждается в запуске fork для **новых Host-owned действий**. Однако стандартные `pnpm dev`/`pnpm dist` и `resources/runtime` ещё используют/упаковывают старый `claude-multimodel` для legacy-path. Полный production cutover **не выполнен**.
- Frontend `main` на момент аудита закрепляет runtime **0.0.159** и диапазон V2 `>=2.0.0, <3.0.0`; квалифицированный **engine** `2.1.4` на macOS arm64/x64, Linux x64, Windows arm64/x64 (Linux arm64 без delivery). Stage 1 #982 ещё закрепляет **0.0.158** и расходится с текущим `main`: перед integration сверить exact runtime/artifact lock и затронутые UI/IPC изменения. Старый runtime native PASS **не** является Host V2 PASS.
- Donor, который **уже работает**: `777genius/agent_teams_orchestrator`, `src/services/opencode/host/OpenCodeV2ExecutionHost.ts`, `.../OpenCodeV2ExecutionOwner.ts`, `execution/OpenCodeV2SessionService.ts`, `OpenCodeV2AdmissionStore.ts`, native transport, permissions, messages и packaging. Не копировать целиком Owner/журналы: Stage 1 уже владеет Team/Task/Message/Runtime.
- Draft #1106/#1110 и provider #2 содержат реальный native TEST прогресс. Но standalone V2 SPI пока допускает `2.0.0/2.0.21`, а выбранный Frontend engine — `2.1.4`. Это **protocol/qualification gap**, который нельзя закрыть добавлением версии в строковый список. Pass provider TEST или старого runtime ≠ Host→Electron V2 PASS.

## 2. Единственная архитектура владения

```text
Existing Electron UI (CreateTeamDialog / LaunchTeamDialog / Settings / Tasks / Review)
    ↓ existing preload/HTTP + AgentBackendApi + BackendOwnerRouter
Stage 1 Host: packages/legacy-agent-host (один captured owner на handle)
    Team: roster / Tasks / DM / groups / review / notifications / product policy
    Runtime: one durable intent ledger / generation / session / queue /
             native subprocess custody / recovery / stop / checkpoint
    ↓ existing provider-neutral Session SPI
old-provider-implementations: OpenCode V1 adapter | OpenCode V2 dialect adapter
    ↓ official native OpenCode engine, private authenticated endpoint, MCP/tools
```

| Слой | Владеет | Не должен делать |
| --- | --- | --- |
| Frontend feature UI | Установка V1/V2, статус, каталог, выбор моделей, auth UI, формы и отображение | Прямой provider subprocess execution, второй Team/Task writer |
| `src/features/agent-backend` | Captured owner routing / IPC / HTTP / state projections | Смена owner у старой сессии, fallback на fork после неизвестного исхода |
| Host Team | Конфигурация команды, задачи, сообщения, review и product approvals | Provider-specific HTTP, выделение второго native session owner |
| Host Runtime | Durable IDs, launch/session/stop, process/generation/permissions authority, recovery | Дублировать V2 owner store или передавать UNKNOWN другому владельцу |
| Provider SPI | Native V1/V2 HTTP/SDK dialect, bounded read/write, event/tool normalization | Новый durable ledger, Task ownership, приложение или renderer |
| Legacy runtime | Только явно сохранённые old-owner handles/архивы до безопасного retirement | Новый fallback для Host-owned V2 |

**Clean Architecture / SOLID / DRY:** переиспользовать existing ports и явную composition; не копировать `OpenCodeV2ExecutionOwner`/`AdmissionStore`, journal, auth managers или целый runtime. **Host Runtime отвечает за persistent ownership/admission/cleanup**, а provider adapter получает только ограниченную session lease/transport; native child запускается и останавливается по делегированному Host-owned custody, без второго durable owner. UI не импортирует Host internals; Host не импортирует renderer/feature implementation. Без нового repo, БД, очереди, UI, flags и generic framework.

## 3. Политика установки и версий — сохраняем один существующий контракт

Нормативные Frontend sources: `src/features/opencode-compatibility/core/domain/openCodeV2Contract.ts`, `pinnedOpenCodeV2Contract.ts`, `generation.ts` и `src/features/opencode-runtime-installer/core/domain/installPolicy.ts`.

1. OpenCode отсутствует → установка выбирает **V1 baseline `1.19.5`**. Installed V1 остаётся V1, installed/явно выбранная V2 — V2; нет per-model/per-failure fallback. **Обязательный найденный gap:** V1 профиль Stage 1 Host #1110 допускает лишь `1.18.35/1.19.4`; нельзя считать frontend default `1.19.5` совместимым без нативной проверки. Согласовать V1 admission с текущим продуктом **отдельно от V2 wire**, не добавляя версии в allowlist вслепую.
2. `installedCliVersion` (версия пользователя), `selectedQualifiedEngineVersion` (проверенная engine) и `wireDialect/capabilities` — **разные идентичности**. Stable CLI в опубликованном диапазоне только распознаётся; Team launch допустим, когда конкретный engine/платформа/доставка/протокол подтверждены.
3. Published qualified engine/delivery manifest — **единый источник выбора** для Frontend. Host получает immutable trusted descriptor (CLI, engine, dialect, selected model/profile/account, platform/arch, digest native executable + graph, session owner/generation); не вводить вторую таблицу «разрешённых пользовательских версий» и не доверять renderer-supplied capabilities.
4. Поддерживать другие стабильные установленные V2 CLI по уже опубликованной **range + qualified engine** policy; версия CLI **не равна** версии engine и не разрешает произвольную 2.x API-семантику. Выбрать **один** доказанный execution surface для `2.1.4` (приоритет — существующий tested embedded SDK/engine с persisted events), а не параллельно портировать stock CLI и embedded runtime. Другой wire dialect вводить **только** по измеренной необходимости.
5. Missing/foreign/outdated engine, недоказанный dialect, prerelease, неподдержанная платформа или несовместимый checkpoint → явный HOLD/unsupported без скрытого перехода на V1. Сохранить исходную session identity, настройки, плагины и credentials.
6. Support installer и V2 delivery должны работать без старого `claude-multimodel` для нового Host-owned path; хранение verified V2 native support отдельно от legacy CLI допустимо. Не тащить source checkout, чужой системный Node/Bun или unpinned npm «latest».

## 4. Порядок реализации — четыре небольших слоя и один отдельный cleanup

### A. Provider package: настоящий engine 2.1.4 и Session SPI

Owning repo: Draft provider #1 → #2; исходники `packages/provider-implementations/.../opencode-protocol/v2-*`.

- Freeze source SHA/provider archive и текущий **0.0.159 V2 delivery descriptor**. Сопоставить **фактический** native 2.1.4 embedded SDK/engine wire (не npm wrapper): session/create/get/prompt `{data}` envelope, cursor, `events.persist`/SSE terminal lineage, tool call/result, MCP, permission/interrupt/auth. Отдельные 2.0.21/2.1.4 fixtures не дают общего API автоматически.
- Проверить и при необходимости добавить **минимальный dialect-specific decoder/transport** внутри существующей V2 provider factory. Не дублировать transport в Host или Frontend и не менять V1 adapter ради ложного DRY.
- На disposable native 2.1.4 показать actual model turn → assistant output → durable terminal и cold readback, а также tool effect, permission deny/ask и MCP. `Session.log` без полноценного native event lineage — HOLD, не успешная модельная сессия.
- Проверить bound loopback/Basic Auth, реальные PID+birth/digest (не wrapper SHA), exact source package/SDK graph, bounded HTTP/SSE, чужую сессию/permission/lease и rollback/revoke. После accepted или UNKNOWN POST — **никакого повторного выполнения**. Node24/26, packed consumer и независимый security review; E2E с localhost model proof ≠ оплаченная подписка.
- Не merge/publish provider #1/#2 до собственных current-SHA CI и review; после приёмки выбрать **один immutable archive** в Host.

**Выход:** standalone V2 dialect для проверенной 2.1.4 engine; V1 не меняется, пакет не зависит от прежнего runtime/форка.

### B. Stage 1 Host: один native owner, без копирования старых журналов

Owning repo: текущий Stage 1 package, Draft #1106 → #1110.

- В `runtimeProfile.ts`, `openCodeV2StaticPreflight.ts` и `OpenCodeV2MemberProvider.ts` заменить повторённые exact `2.0.0/2.0.21` как **пользовательскую version policy** на immutable qualified engine/dialect selection. До реальной native qualification не расширять допускающий запуск guard.
- Захватывать Team/run/member/session/generation, command ID и account namespace **до** native side effects. Process custody, allocated child, lease, interrupt, close/UNKNOWN, cold recovery остаются у существующего Host Runtime; provider управляет только сессионным protocol transport.
- `OpenCodeV2MemberProvider.ts` (~783 строк) не делить **ради длины**: сначала переиспользовать `CustodyReadback`, `PermissionReadback`, `InitialContextReadback`, `ObserverCleanup`. Вынести лишь проверяемую реальную ответственность, если требуется изменение/превышается правило **≤800 физических строк** для нового production-файла. Без generic manager, facade inheritance и доп. интерфейсов на каждый helper.
- Native initial instructions ставятся **ровно один раз**, затем attested readback по session/generation/config revision. Не переотправлять PUT/POST после неясного ACK. Реальный Stop не должен убивать общий/чужой OpenCode процесс.
- Native `external_directory: deny|ask` должен реально **блокировать внешний TEST tool effect**, включая project-scoped сохранённый `always` и native plugin hooks (или доказанное отсутствие), а не просто возвращать JSON правила. Default V2 allow не наследовать; `once/reject`, stale grant и обрыв в момент approval fail-closed. Непроверенная plugin/tool-approval/MCP capability означает явный unsupported/HOLD **до side effects**.

**Выход:** Stage 1 Host→OpenCode V2 native turn, known terminal, tool/MCP/permission/Stop и cold-safe recovery, без второго owner/store.

### C. Frontend glue: не трогать существующий UX

- Сохраняются оригинальные `CreateTeamDialog` / `LaunchTeamDialog` / Resume / Task Board / Review / Processes / Provider Settings / model picker; никаких новых диалогов или feature flags.
- Использовать existing app installer, qualified model catalogs, per-project config и provider-management port. Связать UI и IPC с captured Host owner **для новых Host-owned команд**; native metadata и account profile передавать только через existing trusted composition, а не renderer-флаги.
- В old-runtime коде различить **explicit old-owner compatibility** и новые Host-owned команды. Пресечь старые fork probes, `runtime status/models/auth`, subprocess launch и watchers для Host-owned handles даже **до первого prompt**; проверять sentinel-ами. Не удалять по пути старые данные/историю.
- Изменение V2 engine/встроенного plugin или неожиданного capability показывает честный diagnostic/unsupported; не обещает запуск на основании login/каталога моделей.

**Выход:** те же пользовательские действия создают, запускают, контролируют и читают команду через единственный новый Host.

### D. End-to-end квалификация (обязательная до cutover)

- **Offline deterministic:** реальные Claude Agent SDK / Codex CLI / OpenCode V1/V2 + TEST-only localhost inference и настоящие команды/инструменты. Никакой real user data, исходных проектов или credentials CI.
- **Положительный E2E по возрастающей сложности:** (1) provider native `2.1.4` model/tool + terminal/cold lineage; (2) тот же turn через **один** Stage 1 Host owner/MCP/permission/Stop; (3) original Electron Create/Launch→Task→peer/group/review→Resume/Stop; (4) выбранные packaged OS. Не запускать полный M01–M19/5-OS suite **на каждом маленьком коммите**, если границы unchanged.
- **Native negative:** error/lost ACK до/после admission, no retry on UNKNOWN, foreign/stale session/permission, no double writer/duplicate Task, wrong model dialect, denied external access despite persisted allow/hooks, shared backing stop, lifecycle process reaping.
- **UI/packed:** оригинальный Electron CDP (не новый harness/UI), Create→Launch→Task→DM/Group→Review→Stop→Quit→cold readback; арх./delivery/Node/Bun/ASAR/Windows wrapper. Реально протестировать поддерживаемые macOS ARM/x64, Windows ARM/x64, Linux x64; не заявлять Linux arm64.
- **Real providers separately:** опциональный bounded настоящий бесплатный OpenCode model test по [#1171](https://github.com/777genius/agent-teams-ai/issues/1171), не flaky required CI. Claude/Codex live subscription OAuth, quota, revoked permissions — отдельно и с согласованными TEST-аккаунтами. Локальный mock ответ **не** называется vendor-auth E2E.
- Evidence на **финальном SHA**: original receipts/screenshots, source pins, ZIP SHA-256/CRC, native binary digest/version, platform, owner/generation/command ID, cleanup results; reuse только для неизменившихся boundaries.

### E. Fork-free cleanup — отдельный небольшой PR после D

- Удалить из новых Host-owned путей зависимость на старый CLI/bootstrap/probes/management, убедиться в отрицательном sentinel. Не переносить в новый backend whole legacy modules.
- `pnpm dev/dist`, staging и `resources/runtime` менять лишь после подтверждения **нулевой активной зависимости новых Host-owned путей** от fork (startup/management/status/model/auth/stop, даже без prompt). Удаление legacy binary из **всей** поставки отдельно: либо все старые obligations окончательно завершены, либо для каждого retained old-owner handle сохранён working read/stop/reconcile/archive path. Rollback/default применяются только к **новым unbound handles**, без live migration.
- Никакой автоматической миграции активных V1/V2 sessions или пользовательских профилей; ни merge #982 в `main`, ни релиз/активация Host без отдельного owner decision.

## 5. Минимальная E2E-матрица и stop-ship

| Test | Доказательство |
| --- | --- |
| Fresh / V1 / V2 | Default V1 `1.19.5` **и Host V1 admission доказаны вместе**; installed V1→V1, V2→V2, explicit V2; без fallback |
| Arbitrary stable V2 CLI in range | Правильная identity native CLI + выбранная qualified engine/платформа/dialect; incompatible = HOLD |
| Wrong engine / wrong ABI / unsupported OS | Refuse **до** session/native mutation; no access to user credentials |
| Real model → terminal | Nonempty assistant + original accepted input + persisted native terminal and cold lineage |
| Tools/MCP | Exact native tool effect, call/result pairing, tool permission, MCP child custody and cleanup |
| Permissions | deny/ask/once/reject, late revoke, saved `always` and plugin hook precedence, no stale grant |
| Team+UI | Real Create/Launch, task/review/attachments, human/peer/group, source logs, notification/ref links |
| Runtime controls | Targeted Stop/interrupt, independent sibling survives, app Quit, crash/cold Resume, no PID reuse |
| UNKNOWN | Lost ack, durable ID, read-only reconciliation, zero extra POST/launch; never fresh-as-resume |
| Packaging | Actual runtime bytes, signed/pinned delivery, no source checkout/system Node or fork on new host path |
| Legacy state | Old owner unchanged, no replay/adoption, no user data loss, no destructive reset |

Replay, чужие права, shared-process kill, фальшивый tool/success, неподтверждённый `2.1.4` wire/permissions/MCP, зависимость нового Host от fork, потеря V1/истории и красный exact-head CI — **stop-ship**. Повторить релевантные M01–M19 и V01–V08, не копируя весь тестовый framework.

## 6. PR-последовательность, проверки, оценка

1. **Provider source #1 → `bootstrap`** можно слить после current-head Node24/26 `pnpm check`, packed-consumer и независимого review: это публикация **исходников в default Git-ветке, не npm/release/активация Host**. Уже существует Ready PR #1. Затем обновить base для #2 на `bootstrap` обычным Git merge/rebase **без force**; не сливать V2 #2 без своего protocol/Native E2E/security review и исправления unresolved threads.
2. **Host #1106 → #1110:** работать в зависимых Draft только для **Stage 1 V2**, актуализировать базу #982 с текущим main осторожно, затем закрыть настоящий qualified 2.1.4 и V1 `1.19.5` gap. Предыдущее прямое поручение владельца подтверждено в [#1110 scope](https://github.com/777genius/agent-teams-ai/pull/1110#issuecomment-6772010714), **не** в Stage 2 #1105; не переносить весь `OpenCodeV2ExecutionOwner`.
3. **Frontend glue + E2E:** минимальный patch существующих feature ports и старых Electron controls; один selected package/build graph и original UI proof. Ни новых UX страниц, ни state migration, ни второй owner.
4. **Finishing gates:** на точном final HEAD `pnpm typecheck`, `pnpm lint`, `pnpm lint:mcp`, `pnpm guard:source-file-size`, `pnpm guard:team-provisioning-architecture`, focused Host/native, Full CI + CodeQL + затронутые packed/native OS E2E и independent architecture/security review. Draft Fast feedback ≠ merge-pass; оригинальный Source/Electron proof другой SHA ≠ текущий код.
5. **Решения о merge раздельны:** docs-plan PR #1173 можно слить в **Stage 1 branch**, если он пройдёт собственный docs review/CI; source extraction #1 — в provider `bootstrap` по п. 1; #1106/#1110/#2 пока HOLD. **#982 → `main`, релиз и retirement старого fork требуют отдельного решения владельца; Stage 2 исключён.**

**Ориентир оставшегося нового кода**, не считая уже написанного: **1 700–3 900 production LOC**, **3 400–6 750 tests/E2E LOC** плюс удаление дубликатов. Сложность ~8/10, цель — 9/10 уверенности после exact-head native/UI/packed acceptance; не обещание нулевых багов.

**Критический review перед каждым merge:** один writer/owner? Существует оригинальный native proof именно выбранного engine? Нет ли скрытой ветки fallback? Нет ли второго каталога версий, дополнительной БД, UI/сервиса без consumer? Не исчезли ли effective permissions/TaskRef/review/history/UNKNOWN? Сравнены ли exact refs, артeфакты и cleanup? Есть ли positive и negative сценарий, а не только API mock? Все ответы проверяемы по неизменённым receipts.

**Результат:** Stage 1 Host обслуживает Claude/Codex/OpenCode V1/V2 и прежний UX без fork executable на новом пути. Старый runtime сохраняется лишь для явно старых обязательств до отдельного безопасного retirement. Stage 2 — **вне scope**.
