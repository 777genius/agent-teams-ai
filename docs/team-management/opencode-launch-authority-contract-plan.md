# OpenCode: план устойчивой проверки контракта запуска

Дата: 2026-09-07. Статус: контракт реализован и выпущен в runtime `v0.0.84`, [PR #68](https://github.com/777genius/agent_teams_orchestrator/pull/68), commit `b567c93a3f424e5d23301cbce5f6f7ade8273c18`. Frontend PR #604 и release PR #605 merged. App `v2.13.2` остаётся draft; выполняется Linux recovery. Актуальная доставка и незавершённая приёмка зафиксированы в конце документа.

Разделы 1–15 сохраняют принятый план, исходные оценки и исследованные версии до реализации. Их формулировки «актуальный main», «перед реализацией» и порядок PR относятся к тому этапу; они не означают, что уже выпущенный контракт нужно реализовать повторно.

## Уточнение по результатам настоящего E2E (2026-09-07)

Полный helper с настоящим OpenCode и подключённым MCP опроверг первоначальное предположение о порядке `/config.permission`. Обе pinned-версии загружают config с `propertyOrder: original`, но Effect HTTP response encoder сериализует известные permission keys перед неизвестным `*`. Исполняемый порядок в `/agent` остаётся правильным. Это не inline/file различие. Прежняя локальная ordered `/config` проверка блокировала исправный запуск.

План исправлен: один дополнительный свежий `/agent` read, точный managed policy tail после универсального reset и проверенный Truncate exception. Запрет дополнительных inventory reads сужен до `/config/providers`; требование не воспроизводить upstream defaults остаётся. Старое conformance evidence доказывает значения и effective rules, но не порядок JSON-ключей `/config`.

## 1. Решение и граница задачи

Заменить сравнение произвольного JSON выбранного провайдера на небольшой положительный контракт поддержанных настроек запуска. Встроить его в существующий `refreshSelectedProfileAuthority()`, сохранить остальные проверки, проверять порядок исполняемых permissions через `/agent` и закрыть обнаруженные пробелы cancellation.

В production не добавлять калибровочный OpenCode host, загрузку upstream schema, сохранённый T0 baseline, новый registry, общий semantic-diff framework или свой движок permissions. Не добавлять зависимости.

Контракт отвечает на вопрос: «сохранились ли поддержанные приложением настройки данного подготовленного запуска?» Он не обещает доказать всё внутреннее поведение произвольного OpenCode/plugin через информационные API.

Исходный [разбор инцидента](opencode-selected-config-authority.md) сохраняет ценность как история и эмпирические наблюдения. Его рекомендации calibration-first в разделах 9 и 13 заменяются этим планом. Успешный Z.AI E2E и Windows-проверка из исходного документа по-прежнему не считаются выполненными.

Оценка после аудита: 🎯 уверенность 8/10, 🛡️ надёжность в описанной границе 8/10, 🧠 сложность 5/10. Полный основной runtime-срез с тестами и CI: ориентировочно 1 000–1 600 changed LOC. Безопасный frontend smoke-wrapper и conformance fixtures оцениваются отдельно; это не обещание уложить все платформенные проверки в прежние 600–950 строк.

### Сравнение трёх подходов

1. **Положительный контракт + существующий execution proof (рекомендуется).** 🎯 8/10 · 🛡️ 8/10 · 🧠 5/10. Основной runtime-срез примерно 1 000–1 600 changed LOC с тестами/CI. Явно защищает поддержанное намерение; неизвестные будущие root-поля требуют расширения контракта. Нет второго production host.
2. **Изолированная калибровка + проверки критичных свойств.** 🎯 7/10 · 🛡️ 8/10 · 🧠 8/10. Предварительно 1 800–3 000 changed LOC с тестами. Лучше переносит нормализацию, но добавляет lifecycle, изоляцию и cache invalidation; одинаковое исчезновение критичного поля в эталоне и live всё равно требует отдельной проверки намерения. Ключ version × config недостаточен при зависимости от env, файлов, plugins и каталога.
3. **Сохранить hotfix и квалифицировать поддержанные версии.** 🎯 9/10 как временное исправление · 🛡️ 5/10 на будущих релизах · 🧠 2/10. Дополнительно примерно 100–250 changed LOC тестов/CI. Минимальный риск текущего изменения, но список исключений остаётся и проблема повторится.

Оценки LOC приблизительные, не включают generated artifacts и развёртывание внешней CI-инфраструктуры. Baseline T0/T1 отдельно не входит в тройку: он обнаруживает изменение, но не доказывает допустимость исходного состояния.

## 2. На каком коде основан план

Исследование выполнено без запуска runtime, provisioning, model requests или тестов на пользовательских проектах.

| Источник | Зафиксированная версия |
| --- | --- |
| Runtime `777genius/agent_teams_orchestrator`, актуальный `main` | `9247cbb08db7d6d5130635face0f89e9f69f65fb`, `v0.0.83` |
| Hotfix инцидента | PR #66, merge `49d44c33c6b28df8f540c60f187271a3e91b2b0e` |
| Frontend `777genius/agent-teams-ai`, актуальный `main` | `8c74f8705b1975cbae0316f176b681247ccbc90d`; `runtime.lock.json` указывает `0.0.83` |
| OpenCode `1.18.29` | `16747470f976aca3d362ad730bcd3fe82ecc2c9a` |
| OpenCode `1.18.4` | `49c69c5ed3ccf706b61b3febb43c8aaff7f8325e` |

Runtime исследован по отдельной копии исходников из `git archive` точного SHA. Локальный runtime checkout находится на `fix/opencode-session-relaunch-followup` и содержит незакоммиченные Cursor-изменения. Локальный frontend checkout также отличается от опубликованного `main`. Их нельзя принимать за release evidence или включать в реализацию попутно.

Перед реализацией заново прочитать актуальный `main` и delta от этих SHA. Для кода создать отдельный чистый checkout/worktree от актуального основания; не переключать и не очищать существующие рабочие ветки. Имена новых веток выбирать по правилам репозитория, без `codex/`. При связанном issue сохранять `Refs` в commit и ссылку в PR; не выдумывать номер issue.

## 3. Подтверждённые факты, влияющие на дизайн

Ссылки R1–R12 и U1–U6 расшифрованы в конце документа. Номера строк относятся к зафиксированным SHA.

| Факт | Следствие |
| --- | --- |
| R1:67–170: helper возвращает `profile | null`, callback диагностики изолирован | Сохранить return contract; ошибка наблюдаемости не меняет допуск |
| R2:1333–1359: приложение импортирует `provider/model/small_model/plugin`; provider subtree сохраняется целиком | Нельзя проверять только curated baseURL и забыть custom SDK options/credentials |
| R2:2520–2545: импорт глубоко объединяется с managed config, затем применяются overrides и isolation | Ожидание строится из окончательного prepared config, не непосредственно из каталога |
| R2:757: model-limit override заменяет `limit`, в том числе может убрать старый `input` | Нельзя восстановить старый limit из каталога при сравнении |
| R3:313–395: strict provisioning намеренно не получает provider/agent inventory | `snapshot.configProviders === null` здесь штатно; нельзя объявлять inventory уже доступным |
| R4:2656/2672/3399 и R5:685: helper используется в readiness, strict launch и повторных действиях сессии | Допустить ровно один параллельный `/agent` read; не добавлять provider inventory |
| R5:682–685: stop намеренно обходит live authority | Недоступный MCP не должен препятствовать abort/status/SSE |
| R6:1221/1466/1613: поле `resolvedConfigFingerprint` содержит разные домены на selected и broad путях | Не записывать новый contract digest или broad digest в существующий selected hash |
| R1:147–148: `contractConfigIdentity` относится к полному MCP config | Это не hash всего `selectedConfig`; его алгоритм не менять |
| R4:3434–3492: production strict launch использует свежий nonce proof на retained host | Сохранять fresh proof; reusable wire proof не превращать в baseline |
| U2:1937–1998: без explicit `small_model` возможен автоматический выбор по family/date/plugin | Одной selected model для защиты provider-конфига недостаточно |
| U2:185: cost участвует в authless OpenCode model filtering | Cost, family и release_date нельзя все вместе объявить декоративной metadata |
| U3/U4: permission order значим; U4 дописывает служебный allow для Truncate.GLOB | Не сортировать rules; сравнивать только доказанный reset-tail, не весь upstream defaults prefix |
| R2:2141 и R6:240: текущие generic fingerprints теряют порядок permission maps/arrays | Проверять actual ordered `/agent` rules локально; broad digest требует отдельного compatibility-решения |
| R11: CI запускает task-change-ledger и dev build | Зелёный существующий CI не доказывает selected authority; нужен focused job |

Дополнительные ограничения:

- `kiro` и `cursor-acp` запрещены для strict launch/probe на исследованном release (R2:1954). Этот план не включает их поддержку. Их статические curated-конфиги можно покрыть pure tests, но не считать успешный launch обязательным или разрешённым этим изменением.
- Наличие 11 моделей в `/config/providers` при 7 в `/config` не означает, что нынешний comparator сравнивал эти два списка. Он сравнивает `/config` с prepared config. Эти источники нужно строго различать.
- `runLaunchWithProvisioningSnapshot()` с reusable execution proof не имеет production callers в исследованном коде. Не строить дизайн вокруг оптимизации этого legacy пути.

## 4. Инварианты и честные ограничения

### 4.1 Обязательные инварианты

1. Expected contract формируется из подготовленного намерения, до первого asynchronous read; ни одно expected значение не берётся из live response.
2. Неизвестный результат, malformed обязательное поле, mismatch или cancellation не дают разрешения на следующие действия.
3. Никакого directional subset внутри permissions, options, headers, variants или MCP.
4. Имя provider, model IDs с вложенными `/`, profile scope, auth, project behavior и точные session/run/lease/CAS проверки сохраняются.
5. Точный MCP config binding включает command argument order, environment и URL. `connected` сам по себе недостаточен.
6. Успешный refresh не переписывает host registry, session store, исходный prepared config, capability hash или execution proof.
7. Stop сохраняет существующее исключение из live checks и точную проверку адресуемого процесса/сессии.
8. Никаких provider requests, установки plugins или запуска дополнительного host внутри comparator.

### 4.2 Граница положительного provider-контракта

Поддержанные runtime-поля проверяются явно. Произвольные неизвестные root-поля provider/model не входят в новую live-проекцию, но остаются в исходном config и существующих source/scope/managed fingerprints.

Это осознанное сужение прежнего «любой JSON drift = ошибка». Не называть неизвестные поля автоматически безопасными: будущая версия OpenCode или plugin может придать им смысл. Поддержка новой runtime-root возможности требует расширения контракта и conformance test.

Одновременно невозможно строго проверять любые неизвестные root-поля, допускать их удаление upstream и не иметь schema oracle, provenance или исключений. Выбран положительный контракт. Не добавлять строгий residual bag: он вернёт исходный баг для imported `structured_output`.

Произвольные plugin effects, mutable approvals OpenCode и скрытые SDK defaults не доказаны равенством `/config`. Доверие к их интерпретации устанавливается на проверенных версиях conformance-проверками. Не обещать универсальную совместимость с любым будущим бинарём и не вводить без необходимости жёсткий production version allowlist.

## 5. Точная форма provider-контракта

Предлагаемый небольшой модуль: `src/services/opencode/OpenCodeLaunchProviderContract.ts`. Две чистые операции: построить проекцию из config и сравнить expected/live. Названия функций можно уточнить при реализации; отдельные service classes, registries и dependency containers не нужны.

| Область | Защищённые значения |
| --- | --- |
| Selected provider entry | Presence, корректная object shape |
| Provider | `api`, `npm`, `env`, `id`, `whitelist`, `blacklist` |
| Provider options | Весь `options` object с произвольными вложенными ключами |
| Configured models | Presence `models` и точное множество его ключей |
| Каждая configured model | `id`; вложенные `provider.api`, `provider.npm` |
| Непрозрачные model bags | Полностью `options`, `headers`, `variants` |
| Model runtime descriptor | `limit`, `family`, `release_date`, `status`, `attachment`, `reasoning`, `temperature`, `tool_call`, `interleaved`, `modalities`, `cost` |
| Верхние selectors | Существующие проверки `model` и `small_model`; квалификация selected model отдельно |

Правила реализации:

- Контракт применяется ко всем selected providers, включая imported/custom. Никакого `if providerId === 'zai-coding-plan'`.
- Вложенные supported structures вроде `limit`, `cost`, `modalities`, `interleaved` имеют проверенную JSON shape. Сравнивать заданные структуры полностью; не терять `limit.input`, model header или параметры variant.
- В opaque bags сохранять неизвестные ключи и типы: `options.route`, custom endpoint/header, `options.environment`, credentials и SDK-specific flags могут менять выполнение. Не использовать рекурсивную проекцию по списку известных SDK options.
- Обычные object keys сравнивать независимо от порядка; array order сохранять. Не считать весь JSON деревом unordered collections.
- Различать `absent`, `null`, `{}`, `[]` и реальные значения. Expected absent не означает «принимаем любой live». Не превращать invalid object в `{}` через permissive `asRecord`.
- Для обязательного expected поля потеря live presence всегда mismatch. Не восстанавливать live SDK/endpoint/limit из expected или models.dev.
- Встроенный provider может отсутствовать в `/config` с обеих сторон. Это допустимый state; его динамическую реализацию подтверждает существующий execution proof в своей ограниченной области.
- Проверять **все configured models** selected provider. Добавление даже `models.extra = {}` в `/config` создаёт исполнимый маршрут; добавление/удаление ключа отклоняется.
- Пополнение expanded inventory в `/config/providers` не является изменением configured model set. Этот endpoint не участвует в новом refresh.
- Production comparator не содержит строк `structured_output` или `CONFIG_DROPPED_MODEL_FIELDS`. Поле может оставаться в исходном каталоге и regression fixtures.

### 5.1 Environment, secrets и fingerprint helpers

Expected строится после merge/overrides/isolation из `profile.managedConfig` и retained `profile.env`, не из текущего `process.env`.

Нельзя без проверки использовать `buildManagedConfigFingerprint()` как единственный comparator новой проекции: его generic normalization исключает любой вложенный `environment` и remote `url`. Для transport bags это может потерять значимое значение. Нельзя менять этот общий helper в рамках задачи: от него зависят существующие сохранённые identities.

Нужна локальная JSON-value comparison для contract, сохраняющая все выбранные значения. Не переносить в неё `resolveIdentityEnvironment`, `redactConfigIdentity` или `secretIdentity`: они поддерживают дополнительный `${...}` синтаксис, маскируют/хешируют ссылки и нормализуют URL query. Это identity-policy, а не точное значение, полученное OpenCode. Старые helpers и golden vectors оставить неизменными.

Для expected-only подстановки повторить только маленькое правило U6, проверенное на обоих pinned SHA: один проход `{env:...}` по тому же сериализованному JSON, который передан как `OPENCODE_CONFIG_CONTENT`, затем JSON parse. Использовать только captured retained env, без fallback к новому ambient process.env. Missing/empty env превращается в пустую строку как у pinned upstream; требование к непустому endpoint/credential проверяется отдельно. Invalid JSON после подстановки не авторизуется. Это учитывает, что upstream подставляет текст до parsing, в том числе в ключах; нельзя молча заменить его другим recursive value resolver.

Live response не интерполировать повторно. `${...}` не считать OpenCode-подстановкой. Если значение env само содержит `{env:OTHER}`, повторный проход не выполнять. Не сортировать query parameters, не удалять fragment и не нормализовать endpoint URL новым comparator. Значения secrets допустимы только в памяти; не добавлять их в diagnostic/fixtures/logs или persistent cache.

Обязательная matrix: literal secret; `{env:...}` для route/secret; отсутствующее и пустое env; изменение ambient env при неизменном retained env; URL query и routing headers; вложенный `environment`; literal `{env:...}` в live; env value с ещё одной ссылкой; повторяющиеся query parameters в разном порядке; подстановка, делающая JSON невалидным. Live value не используется для заполнения expected.

Не расширять поддержку `{file:...}` и иных внешних подстановок новым файловым resolver внутри comparator. U6 выполняет file substitution после env, поэтому ссылка на файл может появиться и из env value. Если защищённое expected значение требует такого чтения, сохранять fail-closed результат и явно классифицировать этот сценарий как неподтверждённую совместимость. Это ограничение должно попасть в release evidence, если затрагивает проверяемую конфигурацию.

## 6. Остальная конфигурация и permissions

Не заменять весь `selectedConfig()` одним permissive contract. В основном срезе меняется provider comparison; остальные существующие проверки сохраняются:

- `model`, `small_model`, `plugin`, `default_agent`;
- весь `/config.agent`, включая prompt/options и неизвестные добавления в managed names;
- top-level `permission`, `command`, `share`, `snapshot`, `autoupdate`;
- отдельное полное MCP comparison.

Не разрешать дополнительные `/config.agent` records, project prompt или injected command попутно. App safe import и реальный OpenCode load имеют разные источники: raw project/.opencode/managed config может пережить inline deep merge. Текущие негативные тесты защищают эту границу.

### 6.1 Effective managed permission check

`/config` сохраняет строгую проверку значений, presence, mode, tools, prompt/options и неизвестных добавлений, но его object key order не является доказательством исполнения. Source raw snapshot сохраняет порядок и не изменяется.

Добавить один `client.listAgents()` параллельно существующим чтениям, с тем же deadline/abort. Для трёх canonical agents `teammate`, `teammate-bootstrap`, `teammate-model-probe`:

1. До await построить ordered expected rules из captured raw config. Поддержанная политика начинается `{permission: '*', pattern: '*', action: 'deny'|'ask'}`. Текущие auto/manual/bootstrap/probe удовлетворяют этому условию.
2. В live требовать ровно одну запись каждого managed name и корректный массив rules. Modes и остальные agent values продолжают защищаться `/config` comparison.
3. Найти последний universal reset в live rules и сравнить весь tail: точные expected rules в исходном порядке плюс ровно один upstream Truncate allow для `path.join(profile.env.XDG_DATA_HOME, 'opencode', 'tool-output', '*')`.
4. Missing/duplicate agent, неверный reset action, перестановка nested rules, лишнее/удалённое правило после reset и неправильный/лишний Truncate exception отклоняются.
5. Prefix до universal reset не сравнивается: по подтверждённой last-match семантике универсальное правило перекрывает все предыдущие правила для любого permission/pattern. Это доказанная граница, а не permissive поиск произвольной подпоследовательности.
6. Не создавать evaluator, catalogue upstream defaults или сохранённый baseline. Иные managed policies без universal reset и неожиданные root permissions в prepared launch config отклонять как неподдержанные. Реальный safe import root permission не принимает; не расширять эту поддержку искусственными fixtures.

Сохранить адаптации absent command ↔ `{}` и absent agent options ↔ `{}`. Не восстанавливать потерянные live permission/tools. `/config` key reordering с правильными `/agent` rules принимается; изменение реального порядка rules отклоняется.

### 6.2 Граница гарантии

Служебный Truncate allow не означает общий доступ к внешним каталогам: допускается только точная известная exception rule для captured isolated data path. Mutable approvals и произвольные plugin effects не доказываются этим API. Новые suffix rules требуют явного compatibility review; неизвестный prefix уже перекрыт universal reset.

Причина изменения плана подтверждена pinned source: [Effect HTTP encoder](https://github.com/Effect-TS/effect-smol/blob/cd7ab658994104bd6fe8f841f1440bea32c387f5/packages/effect/src/unstable/httpapi/HttpApiBuilder.ts#L636), OpenCode Permission Config StructWithRest и реальные file/inline probes. Транспорт config и алгоритмы persisted fingerprints не меняются.

## 7. Алгоритм refresh и cancellation

Сохранить orchestration flow; добавить ровно одно свежее `/agent` чтение для необходимого effective policy evidence.

1. До первого await проверить selected model/scope и срок выполнения; снять глубокую локальную копию raw expected config/env и используемых identity fields, затем построить provider/permission contract.
2. Проверить целостность prepared config относительно существующего managed fingerprint. Это не заменяет отдельную ordered permission check.
3. Выполнить чтения: `/config`, `/agent`, MCP status через `attachIfMissing:false`, project metadata и scope. Новый reader не запускает attach/connect/repair.
4. Проверить deadline; валидировать shape полученного `/config` до проекции.
5. Выполнить прежние MCP checks, новый provider contract, effective managed permission tails и сохранённые остальные config checks. Убрать provider из старого полного JSON/fingerprint comparison, иначе оно повторно отвергнет уже разрешённую metadata normalization. При этом сохранить `provider` как допустимое имя поля в диагностике нового validator. Не передавать новую проекцию обратно в helper, удаляющий nested environment.
6. Проверить scope token/config/auth identity и новое expected-behavior evidence.
7. После последнего await ещё раз проверить deadline и сохранность захваченного prepared ожидания. Сравнить исходный config/env/identity с глубокой локальной raw-копией, сохраняя порядок permissions и все transport values. Старый managed fingerprint для этого недостаточен. Простого JSON.stringify тоже недостаточно для raw integrity: он теряет undefined-valued additions. Снимок должен сохранять presence и значимый порядок исходных значений. При изменении expected source не принимать обновлённое значение за новый эталон.
8. Вернуть новый profile с обновлённым projectBehaviorFingerprint только при полном успехе. Не менять host/store/prepared object.

Локальной копии/чистого contract достаточно; не нужен глобальный freeze всего HostManager или новая система ревизий. Старый fingerprint не доказывает исходный порядок policy до входа в helper: доверенной точкой остаётся подготовка профиля, а helper защищает захваченное намерение своего вызова. Promise.all не является атомарным снимком сервера. Проверки ловят расхождения в существующих контрольных точках, а не доказывают невозможность любого промежуточного изменения.

В `OpenCodeBridgeCommandHandler` оба readiness refresh сейчас не получают `phaseContext`. Обернуть их существующим `runtimeDeadline.runPhase('post_probe_refresh', ...)` и передать context в helper. Strict launch callback уже передаёт context; не заводить второй deadline и не менять cleanup reserve.

Для bounded completion недостаточно проверки после await: ожидание auth/behavior evidence должно прерываться существующим abort-race helper даже при зависшей операции, не создавая нового deadline. Late rejection должен быть обработан. Дисковые metadata/auth reads могут завершиться после abort. Их поздние результаты не должны разрешить bootstrap/prompt/commit, обновить cache или переписать profile. Сохранить `profile | null` внутри helper и timeout/cancellation classification внешнего deadline wrapper.

## 8. Call sites, persistence и reuse

| Путь | Что проверить при интеграции |
| --- | --- |
| Selected readiness, R4:2656/2672 | До/после execution probe один retained host, прежнее expected-behavior намерение, общий deadline |
| Strict launch closure, R4:3399 | Повторные проверки вокруг MCP/model proof, reuse, materialization, bootstrap и commit остаются |
| Session reuse, R5:649–745 | Exact store identity до/после live read и после retain lease; replacement не получает старый prompt |
| Send/reconcile/preview/refresh | Real checker работает; один `/agent` read, нет provider inventory и лишних writes |
| OAuth refresh, R5:886–904 | Сохраняется refresh auth -> prepare нового профиля при необходимости -> authority; не разрешать произвольный auth drift |
| Stop | Обходит live/MCP checks, но не exact session/run/process identity |
| Persistent adoption | Сохраняет selected managed fingerprint domain и старые sealed records |

Не менять `OpenCodeExecutionProof` schema 1, expected-behavior v2, wire fields, TTL, capability snapshot IDs или host/session registry format. Не вызывать `refreshResolvedConfigFingerprint()` на selected path. Не использовать существующий MCP proof cache или readiness cache как authority baseline.

Не добавлять `getConfigProviders()` в refresh. `listAgents()` теперь обязателен для fresh effective permissions; ответ не используется как baseline. Проверка model identity и фактический запрос остаются задачей existing execution proof. Остальные дополнительные API используются только в изолированном compatibility harness.

## 9. Обязательная тестовая матрица

Expected fixtures строятся независимо из намерения. Live fixtures отражают зафиксированные ответы бинаря, но не служат expected baseline. Не обновлять golden fixtures автоматически из текущего live при падении теста.

| ID | Сценарий | Результат |
| --- | --- | --- |
| P01 | Existing imported DeepInfra model с `structured_output`; live удалил поле | Accept без production drop-list |
| P02 | Добавлено/удалено неподдержанное model root annotation | Supported contract unchanged; accept с описанной границей гарантии |
| P03 | Изменён/удалён/добавлен защищённый provider/model field | Reject |
| P04 | Неизвестный вложенный ключ в `options/headers/variants` изменён | Reject |
| P05 | Endpoint query, header, npm, API model alias, credentials, `options.environment` изменены | Reject |
| P06 | Configured model добавлена/удалена, включая `extra:{}` | Reject |
| P07 | Expanded `/config/providers` inventory содержит больше моделей | Не влияет на refresh; никаких provider inventory reads |
| P08 | Unselected configured model family/date/status/cost/route изменены при absent small_model | Reject |
| P09 | Model limits после overrides совпадают; затем context/input/output изменён | Accept, затем reject |
| P10 | Builtin provider absent на обеих сторонах; nested model ID | Сохранить supported поведение и canonical parsing |
| P11 | Absent/null/object/array/empty string/malformed protected shape | Не маскировать различия; malformed обязательные значения reject |
| P12 | Перестановка обычных object keys / значимого array order | Accept / reject соответственно |
| A01 | Teammate auto/manual, bootstrap и probe на двух версиях | Текущие управляемые конфигурации проходят |
| A02 | `/config` key reorder при правильном effective tail; затем перестановка actual `/agent` rules/nested patterns | Accept, затем reject |
| A03 | Пропали agent/mode/permission/emitted tools | Reject; live adapter не восстанавливает потерю |
| A04 | Prompt/options/unknown managed-agent field/top-level permission/command injection | Существующие negatives остаются reject |
| A05 | Agent options={} и command={} штатные defaults | Accept без изменения prepared/evidence |
| L01 | MCP name/config/URL/env/command order/connection/tool-proof mismatch | Reject до следующих member effects |
| L02 | Scope/auth/project changed before/after proof или bootstrap | Reject; ранее committed member сохраняется |
| L03 | Abort во время HTTP и последнего auth read, late resolve/reject | Zero downstream effects и late writes; bounded completion |
| L04 | Prepared input изменился во время await: только permission order, nested environment, remote URL либо retained env | Reject по raw-копии; не переопределять ожидание live-значением |
| L05 | Send/reconcile/preview/refresh повторяются на selected session | Sealed record и hash domains не меняются |
| L06 | Store replacement during retain; stale session reuse | Старый prompt не отправлен; нет незаметного создания replacement session |
| L07 | Real selected persistent adoption через новый manager/process | Тот же host/session, реальный reader, без broad fingerprint rewrite |
| L08 | Stop после disconnect MCP/config drift | Точная адресуемая сессия останавливается по существующему stop contract |
| D01 | Callback бросает; ошибка содержит secret; hostile key/value | Fail-closed; diagnostic не содержит исходных данных |

Pure provider fixtures покрывают Z.AI, MiniMax, Kimi, три Xiaomi региона, Atlas, Copilot, builtin provider и imported custom provider. Kiro/Cursor покрываются как data fixtures с сохранением их текущего unsupported launch status.

Не ослаблять существующий тест `refreshes selected config/project/auth/MCP authority and fails closed on each mutation`. Дополнять его matrix и сохранять imported DeepInfra regression: он доказывает отсутствие привязки решения к одному curated provider.

Ограничения текущих тестов, которые нужно закрыть:

- Bridge tests и `OpenCodeIssue443PersistentCommand.test-support.ts` часто stub'ят сам authority helper. Они не доказывают новый comparator.
- `OpenCodeSelectedSessionAuthority.test.ts` использует настоящий helper, но mock HostManager. Он не доказывает реальный registry adoption.
- Добавить один bounded sandbox integration сценарий с real checker и реальным create/adopt путем HostManager против тестового HTTP OpenCode server. Это не требует LLM или реальных credentials.

## 10. Безопасный harness и live evidence

### 10.1 Обнаруженная проблема существующего wrapper

В актуальном frontend `scripts/prove-opencode-team-provisioning.mjs` default project = repoRoot, default model = `opencode/big-pickle`. Более того, preflight вызывается как `preflightOpenCodeLiveEnvironment({ repoRoot })`, без сформированного `env`, sandbox projectPath и requiredModels. Одного `OPENCODE_E2E_PROJECT_PATH` сейчас недостаточно: preflight всё равно может запустить OpenCode в реальном repoRoot.

Перед использованием этого wrapper исправить узкий путь:

- Создавать новый sandbox project либо требовать явно тестовый target; не fallback на repository root.
- Передавать preflight те же `env`, `projectPath`, `requiredModels`, которые получит тест.
- Проверить в тесте argv/cwd/env preflight и downstream launcher.
- Устранить downstream восстановление `os.userInfo().homedir`: оно обходит изоляцию wrapper. Preflight и live test должны сохранять согласованные HOME/XDG roots, а не создавать разные credential/config contexts.
- Отдельно обработать optional `OPENCODE_E2E_DEFAULT_MODEL_LAUNCH`: его модель, requiredModels и test roots должны соответствовать именно этому сценарию; основной curated canary не подменяется big-pickle.
- Для test credentials явно задать разрешённый источник; не возвращать настоящий HOME и не копировать весь пользовательский auth profile ради прохождения проверки.
- Невалидная sandbox-конфигурация останавливает запуск до spawn.
- Cleanup удаляет только созданные этим run директории и процессы. Не удалять чужие профили, teams или shared hosts.

Это самостоятельный небольшой frontend PR. Pure runtime contract tests от него не зависят; зависимы только live проверки через этот wrapper. Если используется новый самостоятельный sandbox conformance harness, опасный wrapper не запускать и его исправление не превращать в блокер для независимых тестов.

### 10.2 Два уровня доказательства

**Conformance без model inference:** на новых test-only проектах получить реальные `/config`, `/config/providers`, `/agent`, `/mcp` для OpenCode 1.18.4 и 1.18.29; запустить наш реальный checker. Зафиксировать фактическую binary identity, OS, fixture input и redacted results. Начальная матрица: обе версии на Linux/чистом CI, актуальная из этих версий на Windows и macOS; полный декартов продукт не требуется без нового платформенного риска.

Изолировать project/cwd и HOME/USERPROFILE/APPDATA/LOCALAPPDATA/XDG roots/TMP. Исключить унаследованные OPENCODE config/permission overrides, пользовательские auth/plugin paths и чтение родительского проекта. Системные managed settings и `{file:...}` не устраняются одной сменой HOME: выполнять эталонные probes на чистом disposable runner, проверять отсутствие посторонних config sources. Не выдавать локальный temp HOME за полноценную изоляцию.

Тестовые provider/MCP endpoints направлять на локальные fixtures; не выполнять запросы к реальным customer identities. Пробы с plugins отдельно контролируют init/install/connect effects. Для permission conformance использовать настоящий pinned upstream evaluator/test harness или безопасную фактическую engine-обработку запроса. Самописная копия evaluator не является независимым доказательством.

**End-to-end с моделью:** один плановый canary на реально доступном curated provider с managed block; отдельно Z.AI с действующей разрешённой тестовой подпиской. Проверить selected readiness, strict launch, managed bootstrap, сообщение, reconnect/adoption и stop; хотя бы один смешанный запуск сохраняет secondary-lane semantics. После сборки проверить нужный packaged artifact, не только source launcher.

Если Z.AI auth недоступна, сохранить provider failure отдельно от authority result. Не считать 401 успешным Z.AI E2E, не подменять его OpenRouter/big-pickle и не делать автоматические повторные inference-запросы после неопределённого результата.

Отсутствующий binary/credential и skipped live test не превращаются в passed gate. Live-подтверждение публикуется отдельно от unit/fixture evidence.

## 11. Порядок реализации и review budget

### PR A: основной runtime-контракт

Основание: актуальный runtime main. Один когерентный ownership scope: selected authority, его тесты и focused CI.

1. Добавить pure provider contract и независимые mutation tests P01–P12.
2. Снять expected до первого await, заменить provider comparison, удалить `CONFIG_DROPPED_MODEL_FIELDS` и `normalizeSelectedProviderModels()`.
3. Добавить effective `/agent` permission check, сохранив закрытые остальные config проверки и две существующие адаптации defaults.
4. Подключить deadline к readiness calls, final expiry check и защиту от позднего успеха.
5. Дополнить реальные helper/session tests и real reader + adoption sandbox integration.
6. Добавить focused CI job на Linux и Windows для этой области; сохранить pinned Bun/lockfile и существующие CI jobs.
7. Провести независимый review exact patch/SHA и focused verification. Не требовать повторного полного CI без новых изменений или недоказанного риска.

Цель 1 000–1 600 changed LOC, ориентир до 2 000 без отдельно объяснённых fixtures. Если объём растёт из-за broad fingerprints/plugin migration/framework, вернуть scope к этому контракту. Не разделять validator и необходимые negative tests на разные merge points.

### PR B: безопасный frontend live-wrapper, при использовании существующего пути

Ориентировочно 80–180 строк с focused tests. Может выполняться независимо от PR A. Сохраняет корректный runtime source path для dev и exact built artifact для release smoke.

### Финальная qualification

На exact runtime SHA PR A выполнить conformance и curated canary через безопасный путь. Сохранить исходные fixtures/evidence рядом с тестами или в принятом artifact location, без credentials. Проверить binary SHA/версию и реально запускаемый launcher.

Runtime PR можно review/merge как отдельный доказанный срез; полнота доставки требует заявленной qualification. Не объявлять исправление Windows/Z.AI доказанным только из-за merged PR.

### Отдельная последующая задача: broad fingerprint order

R6 рекурсивно сортирует `/agent` arrays. Это подтверждённый дефект, но алгоритм используется legacy migration/adoption и persisted broad digests. Не менять его незаметно внутри PR A.

Для отдельного fix потребуется сортировать только явно unordered внешние коллекции, сохранять вложенный порядок, выбрать policy для старых unversioned digests и проверить leases/PID reuse/stop. Не заменять старый digest новым после одного health success. Этот follow-up не является зависимостью selected provider-контракта, который намеренно не использует broad digest.

## 12. Команды проверки

Выполняются при реализации из отдельного sandbox/test checkout; в исследовании этого плана не запускались. Имена нового файла являются частью предлагаемого изменения.

```bash
bun test src/services/opencode/OpenCodeLaunchProviderContract.test.ts src/services/opencode/OpenCodeProvisioningProbe.test.ts src/services/opencode/OpenCodeSelectedSessionAuthority.test.ts

bun test src/services/opencode/OpenCodeBridgeCommandHandler.test.ts src/services/opencode/OpenCodeStrictLaunchCoordinator.test.ts src/services/opencode/OpenCodeHostManager.test.ts src/services/opencode/OpenCodeRuntimeDeadline.test.ts

bun test src/services/opencode/OpenCodeProfileManager.test.ts src/services/opencode/OpenCodeSessionBridge.test.ts src/services/opencode/OpenCodeExpectedBehaviorFingerprint.test.ts src/services/opencode/OpenCodeExecutionProof.test.ts src/services/opencode/OpenCodeCuratedSubscriptionCatalog.test.ts

bun run build:dev
```

Runtime использует Bun и не имеет frontend `pnpm typecheck` script. Для быстрого TS preflight применим `tsc7 --noEmit`, если он поддерживает текущий tsconfig; fallback на pinned local compiler без изменения tsconfig ради инструмента. Зафиксировать baseline существующих ошибок отдельно, не выдавать фильтрацию ошибок за полный зелёный typecheck. Финальные repository gates имеют приоритет.

Новый focused CI script должен включить также добавленные deadline/adoption test files, если они выделены отдельно. Не запускать весь `src/services/opencode` glob без проверки opt-in live tests и побочных эффектов.

Для frontend wrapper использовать focused Node tests либо существующий Vitest harness по типу модуля. При symlink node_modules не запускать команды, способные неявно переустановить общие зависимости: использовать прямой существующий entrypoint или отдельную frozen установку в TEST checkout. Production package проверяется `bun run build`/release workflow по действующим правилам, а не `cli-dev` вместо production launcher.

## 13. Диагностика, выпуск и rollback

Сохранить совместимые `selected_config_match` + безопасные top-level field names; frontend уже отображает их. Если нужен дополнительный reason, только закрытый enum, без значений, dynamic object keys, URLs, model blobs, env или provider error text. `exception` продолжает показывать безопасный error class. Проверить, что callback exception не разрешает запуск и не ломает отказ.

В этой задаче не добавлять feature flag, отключающий проверку безопасности, или fallback «принять live». Откат основного comparator - обычный revert PR A. Persisted host/session/evidence форматы не меняются, поэтому не требуется очистка пользовательского состояния ради rollback.

При будущем выпуске: новый runtime tag/artifacts -> frontend `runtime.lock.json` с verified digests -> проверка packaged build -> поддержанный publish flow. Не менять pin и не публиковать релизы во время написания/согласования плана. Release canary использует только явно тестовые проекты/identities.

Если окончательный patch всё-таки изменяет fingerprint domain или persistent wire schema, этот rollback-раздел больше неверен: остановить расширение scope и обновить план до реализации такой миграции.

## 14. Критерии завершения

- [x] Ни одного production списка schema-dropped model fields; imported DeepInfra hotfix regression проходит без него.
- [x] Все configured model runtime descriptors и opaque SDK bags защищены; selected-only упрощение не внесено.
- [x] Дополнительный expanded catalog не вызывает fail; дополнительный configured route вызывает fail.
- [x] Порядок permissions защищён по `/agent` reset-tail, без доверия порядку `/config` и без смены persisted fingerprint algorithms.
- [x] Existing provider limits/agent options/prompt/command/MCP/auth/scope/project negatives сохранены.
- [x] Helper остаётся `profile | null`; ошибка/abort/late result не приводит к member effects или writes.
- [x] Reuse/adoption/preview/reconcile/send проверены реальным reader, включая свежие effective policies; stop работает при недоступном MCP.
- [x] Ровно один необходимый `/agent` GET, никаких новых provider inventory GET, calibration hosts, authority caches, registry migrations или зависимостей.
- [x] Focused CI действительно исполняет новые tests на Linux и Windows (run34149790888, SHA3595a929).
- [x] Conformance evidence двух pinned OpenCode версий получено в полной тестовой изоляции.
- [ ] Curated live launch и packaged proof зафиксированы; Z.AI и Windows имеют отдельный честный status.
- [x] Независимое review выполнено на конечном production SHA3595a929 и version-only delta be27add1; исходные чужие изменения не затронуты.
- [x] Broad fingerprint defect и неизвестные будущие runtime-root поля явно записаны как оставшиеся ограничения.

## 15. Проверенные исходники

Runtime ссылки привязаны к exact release SHA; путь и строка в тексте выше относятся к нему.

- R1: [OpenCodeSelectedProfileAuthority](https://github.com/777genius/agent_teams_orchestrator/blob/9247cbb08db7d6d5130635face0f89e9f69f65fb/src/services/opencode/OpenCodeSelectedProfileAuthority.ts).
- R2: [OpenCodeProfileManager](https://github.com/777genius/agent_teams_orchestrator/blob/9247cbb08db7d6d5130635face0f89e9f69f65fb/src/services/opencode/OpenCodeProfileManager.ts).
- R3: [OpenCodeProvisioningProbe](https://github.com/777genius/agent_teams_orchestrator/blob/9247cbb08db7d6d5130635face0f89e9f69f65fb/src/services/opencode/OpenCodeProvisioningProbe.ts).
- R4: [OpenCodeBridgeCommandHandler](https://github.com/777genius/agent_teams_orchestrator/blob/9247cbb08db7d6d5130635face0f89e9f69f65fb/src/services/opencode/OpenCodeBridgeCommandHandler.ts).
- R5: [OpenCodeSessionBridge](https://github.com/777genius/agent_teams_orchestrator/blob/9247cbb08db7d6d5130635face0f89e9f69f65fb/src/services/opencode/OpenCodeSessionBridge.ts).
- R6: [OpenCodeHostManager](https://github.com/777genius/agent_teams_orchestrator/blob/9247cbb08db7d6d5130635face0f89e9f69f65fb/src/services/opencode/OpenCodeHostManager.ts).
- R7: [OpenCodeCuratedSubscriptionCatalog](https://github.com/777genius/agent_teams_orchestrator/blob/9247cbb08db7d6d5130635face0f89e9f69f65fb/src/services/opencode/OpenCodeCuratedSubscriptionCatalog.ts).
- R8: [ProvisioningProbe tests](https://github.com/777genius/agent_teams_orchestrator/blob/9247cbb08db7d6d5130635face0f89e9f69f65fb/src/services/opencode/OpenCodeProvisioningProbe.test.ts).
- R9: [SelectedSessionAuthority tests](https://github.com/777genius/agent_teams_orchestrator/blob/9247cbb08db7d6d5130635face0f89e9f69f65fb/src/services/opencode/OpenCodeSelectedSessionAuthority.test.ts).
- R10: [ExecutionProbe](https://github.com/777genius/agent_teams_orchestrator/blob/9247cbb08db7d6d5130635face0f89e9f69f65fb/src/services/opencode/OpenCodeExecutionProbe.ts).
- R11: [Runtime CI](https://github.com/777genius/agent_teams_orchestrator/blob/9247cbb08db7d6d5130635face0f89e9f69f65fb/.github/workflows/ci.yml).
- R12: [Runtime deadline](https://github.com/777genius/agent_teams_orchestrator/blob/9247cbb08db7d6d5130635face0f89e9f69f65fb/src/services/opencode/OpenCodeRuntimeDeadline.ts).
- U1: [OpenCode provider schema](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/core/src/v1/config/provider.ts).
- U2: [OpenCode provider resolution/SDK/small model](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/opencode/src/provider/provider.ts).
- U3: [Permission schema/order](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/core/src/v1/config/permission.ts), [actual evaluation](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/opencode/src/permission/index.ts).
- U4: [Agent normalization](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/core/src/v1/config/agent.ts), [effective agents/default exceptions](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/opencode/src/agent/agent.ts).
- U5: [Config load/merge order](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/opencode/src/config/config.ts).
- U6: [Текстовая env/file substitution](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/opencode/src/config/variable.ts).
- F1: [Frontend smoke wrapper](https://github.com/777genius/agent-teams-ai/blob/8c74f8705b1975cbae0316f176b681247ccbc90d/scripts/prove-opencode-team-provisioning.mjs), [preflight](https://github.com/777genius/agent-teams-ai/blob/8c74f8705b1975cbae0316f176b681247ccbc90d/scripts/lib/opencode-live-preflight.mjs).

При дальнейшей работе сначала проверить delta от выпущенного runtime `v0.0.84`. Исследованные, но не воспроизведённые live риски остаются тестовыми обязательствами, а не уже доказанными исправлениями.

Дополнительная пользовательская приёмка: отдельный Copilot E2E на `github-copilot/gpt-5-mini` из отчёта, с запуском команды, выполнением задачи и проверяемым файлом в новом sandbox. Provider/config gate alone не считается успехом.

## Доставка и оставшаяся приёмка (2026-09-07)

- **Runtime выпущен:** [PR #68](https://github.com/777genius/agent_teams_orchestrator/pull/68) merged в `b567c93a3f424e5d23301cbce5f6f7ade8273c18`, source tag `v0.0.84`; [публичные бинарники](https://github.com/777genius/agent_teams_orchestrator_binaries/releases/tag/runtime-v0.0.84). Все пять платформ собраны; manifest/GitHub digests, anonymous download gate и native app bootstrap проверены. [Runtime build run](https://github.com/777genius/agent_teams_orchestrator/actions/runs/34150738449).
- **Проверки контракта:** final focused suite 645 tests / 3253 assertions, dev/production builds; новых typecheck ошибок относительно baseline нет. [CI run 34149790888](https://github.com/777genius/agent_teams_orchestrator/actions/runs/34149790888) на `3595a929` завершил все шесть jobs, включая полный Windows authority suite и conformance. Production-код release head совпадает с этим проверенным срезом. Linux conformance покрывает pinned OpenCode 1.18.4/1.18.29, inline/file и auto/manual с настоящим permission engine и MCP; у локальной macOS-проверки сохранено ограничение системной изоляции.
- **Frontend интегрирован:** [PR #604](https://github.com/777genius/agent-teams-ai/pull/604), merge `3d7c427064053badf6c5412edc006fe980d67fe4`, изолирует wrapper и cleanup; 24 wrapper tests прошли. [PR #605](https://github.com/777genius/agent-teams-ai/pull/605), merge `906395bc7cf846b2c3debc8271e4853fb7173e5f`, закрепляет runtime assets и служит основанием tag `v2.13.2`.
- **App пока draft:** в [исходном release run](https://github.com/777genius/agent-teams-ai/actions/runs/34151777575) Windows/macOS собраны; Linux дважды сообщил smoke OK, но завис на удерживаемых descendant pipes. Выполняется отдельный [Linux recovery run 34155202396](https://github.com/777genius/agent-teams-ai/actions/runs/34155202396). Packaged qualification, финальная публикация и updater guard пока не завершены.
- **Z.AI: отрицательная приёмка выполнена.** По уточнённому запросу пользователя действующих credentials нет. Один canary опубликованного darwin-arm64 runtime с заведомо неверным disposable key прошёл config gate и получил настоящий HTTP 401; task dispatch отсутствовал, cleanup подтверждён. Обработка реального 401/403 envelope проверена. Это отказ авторизации, не успешное authenticated task E2E.
- **Copilot: положительная приёмка не выполнена.** Прежний config blocker устранён, но execution probe и отдельная диагностика `/responses` получили `model_not_supported`. Причина account/limits не установлена; task/file E2E не засчитан.
- **Windows: отдельный дефект исправлен, исходный инцидент не доказан.** Fresh `launch_runtime` теперь сохраняет managed fingerprint для strict adoption. Persisted algorithms и wire schema не менялись; старые несовпадающие live-записи остаются fail-closed. Registry wipe/migration не добавлены. Причина и исправление именно пользовательского upgrade-инцидента без его artifacts остаются неподтверждёнными.
- **Оставшиеся требования:** успешный curated/mixed secondary-lane canary, Copilot assigned-task/file proof, полная packaged qualification и проверка исходного Windows-состояния. Broad fingerprint order и неизвестные будущие runtime-root поля остаются отдельными ограничениями исходного плана.

Независимые технические ревью production-изменений выполнены; зелёный ReviewRouter gate не заявляется, поскольку его provider отклонил запуск из-за quota. Runtime/provisioning проверки выполнялись только в новых TEST/temp проектах. Исходные dirty checkout и пользовательские auth stores сохранены. Локальный архив содержит redacted canary/conformance artifacts; проверяемые PR, CI и release-ссылки приведены выше.
