# OpenCode V2 → Stage 1 Host: адаптация и проверка независимости от форка

**Статус:** план реализации, обновлён 10 ноября 2026 по последнему поручению владельца. Это не подтверждение выполненного E2E.
**Scope:** завершить зависимые PR; основной frontend PR #982 **не сливать в main**, не выпускать релиз и не включать новый backend по умолчанию. **Stage 2 отложен.**

Зависимости: [Stage 1 #982](https://github.com/777genius/agent-teams-ai/pull/982) → [preflight #1106](https://github.com/777genius/agent-teams-ai/pull/1106) → [Host V2 #1110](https://github.com/777genius/agent-teams-ai/pull/1110). Provider: [extraction #1](https://github.com/agent-teams-ai/old-provider-implementations/pull/1) → [V2 correction #2](https://github.com/agent-teams-ai/old-provider-implementations/pull/2). Границы: [Stage 1](stage-1-legacy-host.md), [контракты](stage-1-contracts.md), [M01–M19](compatibility-matrix.md), [программа](README.md). Поручение на V2 отдельно от исходной V1-приёмки: [scope #1110](https://github.com/777genius/agent-teams-ai/pull/1110#issuecomment-6772010714).

## 1. Что действительно есть

- Provider repo `agent-teams-ai/old-provider-implementations` пока показывает документационную default-ветку `bootstrap`; код двух пакетов находится в `feat/extract-providers` (PR #1), доработки V2 — в #2. Путь к исходникам не означает опубликованный или квалифицированный runtime.
- `packages/legacy-agent-host` — отдельный Node-пакет/процесс **в frontend-репозитории**. Provider implementations и Session SPI находятся в отдельном provider repo. Перемещать Host в ещё один Git-репозиторий не нужно.
- Выбранный Stage 1 Host-owned candidate проверялся настоящими Electron/SDK/CLI с localhost inference. Это не vendor-login/subscription proof. Стандартные dev/dist, staging и `resources/runtime` ещё содержат прежний `claude-multimodel`: независимость нового пути и удаление форка из всей поставки — **разные результаты**.
- Snapshot аудита: frontend runtime `0.0.159`, Stage 1 #982 — `0.0.158`; существующий V2 engine `2.1.4` квалифицирован старым runtime на macOS arm64/x64, Windows arm64/x64, Linux x64, но не Linux arm64. Перед интеграцией перепроверить exact refs/lock, не переносить старый PASS на новый Host.
- Текущие private Host/provider gates допускают V2 `2.0.0/2.0.21`, а V1-профиль Host — `1.18.35/1.19.4`. Старый Frontend при первой установке выбирает V1 `1.19.5`; при явном обновлении V1 использует npm metadata, а для V2 выбирает engine из qualification manifest. Это **наблюдаемый baseline, не новая целевая политика**.
- Проверенный donor V2 — `777genius/agent_teams_orchestrator/src/services/opencode`: native protocol, delivery, permissions, lifecycle. Не копировать целиком `OpenCodeV2ExecutionOwner`, `OpenCodeV2AdmissionStore` и их журналы: новый Host уже имеет своих владельцев.

## 2. Один владелец, существующие интерфейсы

```text
Existing Electron UI / preload / HTTP contracts
    → AgentBackendApi / BackendOwnerRouter
    → Stage 1 Host
        Team: tasks, roster, messages, review, product approvals
        Runtime: durable input, session generation, process custody, stop/recovery
        → provider-neutral Session SPI
        → one OpenCode V1 adapter OR one OpenCode V2 dialect adapter
        → official native engine / model / tools / MCP
```

| Слой             | Ответственность                                                         | Запрет                                                    |
| ---------------- | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| Frontend         | Установка, выбор поколения/модели, auth UI, статусы, существующие формы | Прямой native execution из renderer, второй Team writer   |
| Backend routing  | Выбранный owner каждого handle, IPC/HTTP, отображение результатов       | Смена владельца после UNKNOWN, скрытый fallback на fork   |
| Host Team        | Задачи, сообщения, roster, review и продуктовые разрешения              | Нативный HTTP decoder или ещё один provider runtime       |
| Host Runtime     | Единственный durable admission, поколения сессий, owned child, recovery | Копия старого V2 Owner/admission journal                  |
| Provider adapter | Ограниченный native transport, dialect, события/tool results            | Product store, отдельный durable ledger, frontend imports |

Runtime выдаёт ограниченную session/transport lease; native child custody остаётся Host-owned. Provider не получает право усыновлять shared процессы или чужие сессии. Host не импортирует renderer/feature implementation; UI не импортирует Host internals.

Clean Architecture/SOLID/DRY означают явные зависимости и повторное использование **проверенных правил**, не механическое объединение несовместимых V1/V2 протоколов. Не добавлять БД, framework, scheduler, feature flags, новое UI или интерфейс на каждый helper. `OpenCodeV2MemberProvider.ts` (~783 строки) сокращать только по реальной ответственности; сохранить existing readback/cleanup helpers и предел новых production-файлов ≤800 строк.

## 3. Целевая политика версий: latest stable своего поколения

**Последнее решение владельца заменяет фиксированную первую установку `1.19.5`.** Сохраняем V1 по умолчанию, широкий совместимый диапазон, явное обновление и отдельную квалификацию engine. Не смешивать version discovery, installation и launch admission.

1. **Первая установка:** последняя стабильная поддерживаемая **V1**, определённая по официальным metadata в выбранном диапазоне. Не глобальный `latest`, способный переключить major, и не вечный pin на `1.19.5`.
2. **Обновление:** пользователь может явно обновить установленную V1 до latest stable V1, V2 — до latest stable V2. Уже выбранное поколение сохраняется. Явно выбранная совместимая версия не меняется без действия пользователя; prerelease/чужое поколение не подставляются автоматически. Не добавлять отдельный каталог версий/новый экран без необходимости: переиспользовать installer и существующее действие Update.
3. **Пользовательский CLI ≠ execution engine ≠ wire dialect.** Для V2 сохраняется `stable-v2-qualified-engine`: stable CLI в опубликованном диапазоне `>=2.0.0, <3.0.0` может обслуживаться отдельным проверенным engine. Latest CLI не разрешает автоматически latest непроверенный engine. Точная engine/platform/dialect/digest выбирается из одного trusted qualification/delivery contract; обновление engine требует native E2E, а не новой строки allowlist.
4. **V1 также не ограничивать двумя patch-версиями.** Согласовать Host/provider admission с существующим опубликованным диапазоном и проверенным API/возможностями. Native tests обязаны покрыть baseline `1.19.4`, бывший default `1.19.5` и выбранную latest stable V1. Не обещать проверку всех будущих выпусков; несовместимый протокол отказывать до опасных side effects. Не расширять строковый список вслепую.
5. **Безопасное разрешение latest:** один раз получить metadata, проверить stable semver/major/package/platform, зафиксировать exact version и integrity, проверить root/native package соответствие, затем скачать эти байты. Смена dist-tag между чтениями не меняет выбранную версию. Проверять checksum/digest и атомарно активировать; при ошибке сети, metadata или проверки оставить предыдущую рабочую установку, без скрытого downgrade.
6. **Обновление не мигрирует активную команду.** Не менять исполняемые файлы/engine binding живой или UNKNOWN-сессии. Сохранить versioned installation и pinned engine для её stop/reconcile/resume; новая версия доступна новым запускам. Не создавать новую систему миграции: reuse existing installer, owner binding и checkpoint compatibility.
7. **Одна политика, несколько потребителей:** существующие `openCodeV2Contract.ts`, `pinnedOpenCodeV2Contract.ts`, `generation.ts`, `installPolicy.ts` и `packageSelection.ts`. Trusted composition передаёт Host immutable descriptor обеих версий, dialect, OS/arch, graph/executable digest, account/profile и session generation. Renderer не назначает capabilities и не передаёт secrets в manifest/логи.
8. Missing/unqualified engine, wrong ABI, unknown wire, несовместимый checkpoint/plugin или unsupported OS → честный unsupported/HOLD, без silent V2→V1/fork fallback. Не изменять пользовательские HOME/XDG/config/plugins/auth. Unsupported V2 OAuth/plugin маршруты не становятся поддержанными от успешной установки или login.

## 4. Реализация минимальными вертикальными срезами

### A. Provider library — исправить фактический протокол

Работать в существующем provider PR #2 поверх #1. Freeze source SHA и один выбранный artifact; не копировать library в Frontend.

- Приоритет — уже проверяемый embedded SDK/engine `2.1.4` с persistent events. Выбрать **одну** execution surface; не портировать параллельно stock CLI и embedded runtime ради полноты.
- Сверить реальные `{data}` envelopes, session create/get/prompt, message cursor, persistent SSE/terminal, tool call/result IDs, MCP, permissions и interrupt. Старые fixtures не удостоверяют новый wire; при необходимости добавить минимальную dialect strategy внутри existing adapter.
- Доказать native model → непустой assistant → durable terminal → cold readback без дополнительных model calls. Один ACK, пустой log или `idle` без исходного input correlation — не успех.
- Проверить loopback/auth, scoped session/credentials, bounded JSON/SSE/stream budgets, foreign permissions, cancellation/lost ACK. После принятого или UNKNOWN input не повторять POST. Physical PID/birth/digest проверяется владельцем, не подменяется wrapper/package hash.
- Node24/26, frozen dependency graph, `pnpm check`, packed consumers и независимое review. Сохранять public exports и V1. Выдать immutable archive после приёмки; не редактировать vendored dist.

### B. Host — соединить с единственным Runtime owner

Использовать #1106 → #1110; согласовать актуальную базу #982, не сливая её в main.

- Устранить разрыв V1 install/admission и V2 CLI/engine/dialect в `runtimeProfile.ts`, `openCodeV2StaticPreflight.ts`, `OpenCodeV2MemberProvider.ts`. Текущие native gates не ослаблять до положительного proof; новый широкий диапазон не должен означать произвольную wire совместимость.
- Захватить Team/run/member/session/generation/account/command ID до side effects; один durable intent и один owner на native child. Initial instructions отправлять не более одного раза до разрешения UNKNOWN; readback проверяет исходный digest/revision.
- Реальные `external_directory: deny|ask`, once/reject, stale/revoked approval проверять **tool side effect**, включая project saved `always` и plugin hooks/их доказанное отсутствие. Чтение JSON rules само по себе не доказывает enforcement. Неподдержанный persistent grant/MCP/plugin явно отказать до мутации.
- Переиспользовать custody/permissions/context/observer helpers. Проверить targeted interrupt/Stop, sibling survives, child PID reuse, app crash, durable recovery, no double writer. Exit Host не равен доказательству завершения всех детей.

**Выход A+B:** один полный native Host V2 turn + MCP/tool/permissions + durable terminal + Stop/cold Resume; V1/Claude/Codex не регрессировали. Это ещё не полный Desktop cutover.

### C. Desktop — прежний UX, новый execution path

- Оставить текущие Create/Launch/Resume, Settings/model picker, Tasks/Review/Processes, notifications и IPC/HTTP DTO. Без нового UI, отдельного store или скрытого фонового launch.
- Installer/status/catalog/auth используют existing feature ports и trusted Host composition. Новые Host-owned команды не вызывают fork даже для startup/status/models/auth/Stop; проверить negative sentinel, а не только отсутствие fork на prompt.
- Различать old-owner и Host-owned handles. Старые active/UNKNOWN/архивы сохраняют исходного владельца. Mixed old/new ownership не объявлять поддержанным без отдельного proof; нет автоматической V1↔V2 миграции или relay неизвестной операции.

### D. Приёмка, затем отдельное удаление ненужного legacy

- Сначала deterministic localhost inference с реальными SDK/CLI/Host, затем native tool/MCP/permission и оригинальный Electron CDP. Только disposable TEST проекты/HOME; не использовать рабочие проекты/подписки/ambient credentials.
- Полная UI цепочка: Create → Launch → Task/tool → peer/group → Review → targeted Stop → Quit → cold readback/Resume. Использовать существующие harness/контролы; positive и negative cases, не второй тестовый framework.
- Проверить затронутые packaged tuples macOS arm64/x64, Windows arm64/x64, Linux x64: native Node/Bun/engine graph, ASAR, Windows wrapper, startup/stop. Linux arm64 не объявлять поддержанным без delivery и native proof. Большую матрицу запускать на интеграционном HEAD, не на каждом неизменяющем границы коммите.
- Опциональный реальный бесплатный OpenCode model smoke — [#1171](https://github.com/777genius/agent-teams-ai/issues/1171): bounded requests/time/token budget, disposable data, отсутствие secrets; сетевой сбой/429 не превращать в fake PASS или mandatory flaky gate. Claude/Codex vendor OAuth/подписки — отдельная согласованная ручная приёмка.
- Сохранить original receipts/screenshots, exact source/package/engine digests, OS, input/session/owner identity и cleanup. Если source/runtime изменился — повторить affected checks, не переносить старый PASS без доказанной неизменности.
- Только после этого удалить лишние fork bootstrap/probes/imports из нового пути. Удалять старый binary из всей поставки можно лишь когда нет unresolved old-owner obligations либо есть проверенный read/stop/reconcile/archive path. Rollback/default действует на новые unbound handles; пользовательские данные не удалять. Production cutover/release остаётся отдельным решением.

## 5. E2E-матрица и критерий готовности

| Граница                     | Обязательная проверка                                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Latest installation         | Fresh latest stable V1; V1→latest V1; V2→latest V2; prerelease/major jump отказ; metadata/tag race; corrupt archive и interrupted install сохраняют прежнюю версию      |
| Compatibility               | V1 baseline/default/latest проходят Host; V2 installed CLI отличается от qualified engine; missing/wrong platform/dialect отказывается до эффекта                       |
| Running session + update    | Команда сохраняет свой binary/engine/checkpoint; новое обновление не меняет её stop/recovery и не повторяет input                                                       |
| Native model/terminal       | Исходный accepted input, непустой assistant, persisted terminal/cursor, cold lineage, no extra model POST                                                               |
| Tool/MCP/permissions        | Реальный эффект/запрет, paired call/result IDs, child cleanup, saved always/plugin precedence, once/reject/revoke                                                       |
| Team UI                     | Tasks/Unicode comments/attachments/TaskRef, human/peer/group, review/apply/reject, notifications, exact selected model/member                                           |
| Lifecycle/UNKNOWN           | Targeted stop/interrupt, sibling survives, Quit/crash/cold Resume, PID identity, lost ACK и zero replay                                                                 |
| Packaging/fork-free         | Точные native bytes, без source checkout/system runtime dependency; Host path не вызывает legacy CLI даже для management                                                |
| Mixed retained V1 / Host V2 | В одном TEST-профиле старый V1 handle и новый Host-owned V2 handle; routing, Stop и cold readback каждого сохраняют состояние и процессы другого; без cross-owner relay |
| Retained data               | Старый owner не усыновлён; tasks/history/UNKNOWN/архивы сохранены; нет destructive migration                                                                            |

Релевантные [M01–M19](compatibility-matrix.md) и [V01–V08: native V2 E2E contract matrix](https://github.com/777genius/agent-teams-ai/blob/866568ee421fa595f0c99d4e3dbc0f173062a87d/docs/plans/provider-migration/opencode-v2-host-integration.md#L158-L170) обязательны для новой композиции. Ссылка V01–V08 фиксирует определения проверок, а не возобновляет отложенный Stage 2 или старые version pins. Не считать native provider-only или старый runtime доказательством нового Host/Electron. Replay, лишние права, shared-process kill, fake success, исчезновение истории, неподтверждённый engine/dialect, hidden fallback и красные exact-head gates — **stop-ship**.

## 6. Порядок merge и ограничения

1. **Provider #1 → default `bootstrap`:** исходники можно сделать видимыми без npm/release, но после собственных exact-head CI, packed consumer и реального независимого review. Neutral/skipped reviewer из-за лимита — не review. Не менять default на незавершённую ветку вместо проверки.
2. **Provider #2:** после #1 retarget на default; сохранить ancestry обычным merge, без force-push и массового rebase. Проверить только его diff, исправить findings, завершить его native/source/packed gates. Merge source не означает включение V2 в продукт.
3. **Host #1106 → #1110 → ветка Stage 1:** интегрировать в порядке зависимостей после проверки текущей базы, selected provider artifact и E2E. Нужные latest-policy изменения делать в owning installer/Host/provider, не через дублирование версии. Не трогать чужую одновременно изменяемую ветку без сверки нового HEAD.
4. **План #1173 → Stage 1:** docs-only CI/review; это разрешённый зависимый merge, не #982→main. Постоянно добавлять новые plan/framework PR не требуется.
5. **Финальные gates:** repo-pinned TypeScript ≥7.0.2, `.ts` для нового TS, `pnpm typecheck`, lint и архитектурные/source-size guards, provider Node24/26 `pnpm check`, соответствующие Host/native/Electron/packed проверки, Full qualification/CodeQL и независимое review на окончательном HEAD. Не ослаблять guards/тесты для green. Source CI, native qualification, release readiness показывать отдельно.
6. **Не входит в разрешённый merge:** #982→main, Stage 2 #1105, публикация пакетов/релиза, переключение production backend и удаление действующего legacy compatibility. Основной PR остаётся открытым; Stage 2 отложен.

Ориентир оставшейся адаптации: 1 700–3 900 production LOC и 3 400–6 750 tests/E2E LOC, не считая существующего кода. Это оценка, не норматив по объёму и не обещание отсутствия багов. Не создавать дополнительные слои ради достижения чисел.

Перед каждым merge: один owner/writer; выбранный native proof; нет скрытого fallback; сохранены права/история/UNKNOWN; latest resolved один раз в exact verified bytes; live session не изменена; корректны base/head и оригинальные receipts. При отрицательном ответе исправить конкретный слой, не начинать лишнюю миграцию.
