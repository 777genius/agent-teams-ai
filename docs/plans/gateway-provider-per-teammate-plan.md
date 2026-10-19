# План: Gateway-провайдер с выбором и учётом на каждого тиммейта

**Статус:** v5 (финальная, после 4 кругов ревью по 3 критика)
**Тестовый стенд:** локальный [agent-teams-ai/sub2api](https://github.com/agent-teams-ai/sub2api)

## 1. Цель

Каждый тиммейт (Claude Code, Codex, OpenCode) **отдельно** выбирает:

- провайдера и модель (per-member поля `providerId`/`model` уже есть),
- gateway-подключение: профиль (endpoint) + **свой** API-ключ (новое),
- его расходы учитываются **отдельно** от других тиммейтов.

Наш будущий backend и sub2api (стенд) обязаны уметь одно и то же — контракт §3.

## 2. Границы скоупа

**Входит:**

1. Per-member gateway-биндинг: профиль + персональный API-ключ тиммейта.
2. Доставка биндинга в спавн трёх рантаймов (§5), включая per-member env в
   bootstrap-пути (работа в репо оркестратора — §5.1, шаг 3а).
3. Учёт расходов per-member (`gateway_exact`) в token-usage, `byAgent`.
4. UI: выбор профиля/модели на строке тиммейта, управление профилями.
5. Прогон сценариев §8 на локальном sub2api.

**Не входит (явно):**

- управление пулом аккаунтов/группами/ротацией — это админка бэкенда;
- биллинг, квоты, per-member бюджеты;
- **лид команды** — вне gateway-биндинга, использует своего провайдера;
- OAuth/subscription через gateway — только API-key режим; рантайм вне
  API-key режима → блок биндинга с ошибкой (единое правило);
- миграция `anthropic.compatibleEndpoint` и `codex.customProvider`;
- HTTP-адаптер фичи — desktop-only (осознанное исключение из standard);
- деплой sub2api в приложение;
- импорт учёта с субдневной точностью (§6 — агрегаты по дням);
- стабильные id тиммейтов/команд — идентичность биндинга по имени, как и
  везде в token-usage (run-identity `team:…:member:…`); смена имени =
  ручная перевязка (§9).

## 3. Gateway-контракт

| Потребность | Эндпоинт | Auth |
|---|---|---|
| Anthropic Messages | `POST /v1/messages` | ключ тиммейта |
| OpenAI Responses | `POST /v1/responses` | ключ тиммейта |
| OpenAI Chat Completions | `POST /v1/chat/completions` | ключ тиммейта |
| Каталог моделей + проба ключа | `GET /v1/models` | ключ тиммейта |
| Учёт по ключу | `GET /v1/usage` | ключ тиммейта |

Пути фиксированы контрактом и захардкожены — настраиваемых путей в профиле нет.
Единица учёта = API-ключ (один ключ на тиммейта ⇒ сервер различает тиммейтов
без своих заголовков; уникальность ключа обеспечиваем на своей стороне, §6).
Учёт через gateway `/v1/usage`, а не панельный `/api/v1/usage`: панель требует
JWT-сессию — второй тип креденшела не вводим.

**Учёт — гранулярность (уточнение контракта):** `/v1/usage` отдаёт агрегаты
(суммарные и маргинальные), не строки запросов и не матрицу день×модель.
Разрез день×модель получаем запросом на конкретный день
(`start_date=D&end_date=D` → `model_stats` этого дня). Запросы всегда с явными
датами; отсутствующие поля (`model_stats` и пр.) обрабатываются как пустые.

## 4. Архитектура

Фича `src/features/gateway-provider/` по `docs/FEATURE_ARCHITECTURE_STANDARD.md`:

```text
src/features/gateway-provider/
  contracts/          # DTO, IPC-каналы
  core/domain/        # GatewayProfile, MemberGatewayBinding, resolveGatewayConnectionSpec,
                      # toArtifactId, per-runtime маппинги (чистые функции)
  core/application/   # use-cases
  main/
    composition/      # createGatewayProviderFeature
    adapters/input/   # IPC
    adapters/output/  # HTTP-клиент gateway (в т.ч. GatewayUsageSource-адаптер)
    infrastructure/   # GatewayProviderStore
  preload/
  renderer/
```

| Что | Ответственность | Где |
|---|---|---|
| `GatewayProfile` | `id`, `baseUrl`, `displayName` | `core/domain` |
| `MemberGatewayBinding` | `(teamName, memberName) → {profileId, apiKeyRef}` | `core/domain` |
| `resolveGatewayConnectionSpec` | чистая функция → **нейтральный** `GatewayConnectionSpec` (`baseUrl`, провайдер-id, `credentialRef`, `wireApi`, model; **без** env-имён — это знание рантайма) | `core/domain` |
| `toArtifactId` | санитизация `gateway-<teamName>-<memberName>` → `[a-z0-9_-]` | `core/domain` |
| per-runtime маппинги | чистые функции spec → артефакт рантайма (env-имена `ANTHROPIC_*`, форма Codex `-c`, запись провайдера OpenCode); легаси-швы их только **вызывают**, схемы артефактов не дублируют | `core/domain` |
| `GatewayProviderStore` | один JSON в app-config dir: профили + биндинги | `main/infrastructure` |
| `GatewayUsageSourcePort` | порт чтения учёта — в **token-usage** (потребитель импорта), ре-экспорт из `@features/token-usage/main` (deep-import'ы запрещены standard'ом); HTTP-адаптер реализует его в gateway-provider | `src/features/token-usage/…` |

Ключи тиммейтов — в существующем `ApiKeyService` (крипто уже там, не дублируем);
биндинг несёт только `apiKeyRef`. Храним вне `team.ts`, т.к. ключи не должны
попадать в конфиг и бэкапы команды. Use-case «`apiKeyRef` → литерал ключа +
список значений для редакции» — в `main/application/` фичи (main-only
оркестрация над legacy `ApiKeyService`; в core домен его не тянем): его
потребляют шаг 3а и редакция launch-артефактов (§5.3), других читателей
секрета нет. Инжект `GatewayUsageSourcePort` → адаптер — в app shell
(`main/index`), без импортов фича→фича. Для frozen-baseline файлов держим
net-дельту ≤ 0; для новых границ фичи включаем eslint-ограничения импорта
(по стандарту).

## 5. Доставка биндинга в рантаймы

Сейчас `buildCrossProviderMemberArgs` собирает один `envPatch` на провайдера,
мержится в общий `shellEnv` — два тиммейта с разными ключами невозможны.
Контракт меняем на per-member: `Map<memberName, {envPatch, configOverrides}>`.

### 5.1 Точки per-member инъекции

Потребители нового контракта (все, кого трогает смена формы результата):

- `TeamProvisioningCreateDeterministicSetupFlow` (~:335 мерж в `shellEnv`) —
  member-патчи больше **не** попадают в общий `shellEnv`;
- `TeamProvisioningLaunchDeterministicSetupFlow` (:412) — то же;
- `TeamProvisioningLaunchDeterministicSpawnFlow` (:111, :587 →
  `inheritedProviderArgs`) и `TeamProvisioningLaunchDeterministicRunFlow` (:84);
- `buildWorkspaceTrustLaunchArgs`
  (`TeamProvisioningWorkspaceTrustLaunchArgs.ts:19`, spread всех полей :38–46);
- type-only правки подписей: `TeamProvisioningEnvRuntimePorts.ts:34–38`,
  `TeamProvisioningProviderRuntimeFacade.ts:147`.

Точки применения per-member env:

- **Прямой путь** (рестарт/добавление): `TeamProvisioningMemberLifecycle`
  уже строит env per-member (:632) и передаёт в `spawnCli` (:986–996) —
  member-патч ложится сюда.
- **Bootstrap-путь** (создание/запуск через лида): bootstrap-spec не содержит
  env → шаг 3а (§10). In-process lane (`handleSpawnInProcess`) тиммейта в
  процессе лиды per-member env принять не может → **gateway-биндинг требует
  separate-process спавна** (tmux/native); in-process + биндинг = prepare-ошибка.

Биндинги резолвятся в `buildCrossProviderMemberArgs` через lookup-порт по
образцу `TeamProvisioningEnvRuntimePorts` (инжект композицией; `memberSpecs`
из team-конфига ключей не несут). Единая функция применения
`applyGatewayMemberEnvPatch` — **единственное** место, где патч попадает в env
тиммейта.

**Порядок применения (constraint):** gateway-патч применяется строго **после**
`applyProviderRuntimeEnv` и **вне** team runtime settings bundle — тогда
`clearExplicitAnthropicRouteEnv` и `stripCompetingAnthropicEnv` его не видят,
правки в них не нужны. Единственный фронтовый фильтр, который может срезать
ключ, — helper-mode список `ANTHROPIC_HELPER_MODE_COMPETING_AUTH_ENV_KEYS`;
gateway-режим не сочетается с helper-режимом (блок, как в §9). Единый
env-тест на это правило (порядок + выживание ключа) — в фронтенде; в
оркестраторе — свой минимальный тест проброса `extraEnv` (шаг 3а), без
общих фикстур между репо.

### 5.2 Per-runtime артефакты

Маппинг spec → артефакт — доменные функции (§4), ниже — что они собирают:

| Рантайм | Артефакт тиммейта | Стык (только вызывает маппинг) | Per-member механизм |
|---|---|---|---|
| Claude Code | env `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` | `TeamProvisioningEnvBuilder` (лимит 800, запас есть) | member env-патч (§5.1) |
| Codex | `-c` overrides: свой провайдер-id с `base_url`, `env_key="CODEX_API_KEY"`, `wire_api="responses"` | `buildCodexCustomProviderConfigOverrides` (`src/main/services/runtime/ProviderConnectionService.ts:188`); обе формы CLI (codex-exec `-c` и inline `--settings` JSON) | **per-member overrides** (base_url живёт в конфиге, не в env); ключ тиммейта в его env; binding фиксирует api-key режим |
| OpenCode | запись провайдера в (глобальном) `opencode.json`, `apiKey = {file:~/.config/opencode/agent-teams-credentials/…}` | `OpenCodeLocalProviderConnector`/`OpenCodeLocalProviderSupport` | per-member запись + model-route `<providerEntry>/<modelId>`; файл ключа пишет **существующий** writer коннектора (rotation-имена, `assertProviderApiKeyReplacement`) |

**Идентификаторы артефактов:** `gateway-<teamName>-<memberName>`, sanitized
(`[a-z0-9_-]`, точки и прочее → `-`) — иначе (а) коллизия двух команд с
одинаковыми именами тиммейтов в общем `opencode.json`, (b) точка в имени
ломает TOML-путь `model_providers.<id>.*` у Codex. Санитизация — `toArtifactId`
из §4, в единственном экземпляре.

### 5.3 Утечки ключей

Bootstrap-spec env несёт литеральные значения ключей (оркестратор не умеет
резолвить ref'ы) — литерал и список значений для редакции рождает единый
use-case §4 (main/application). Поэтому: ключи **не** попадают в диагностику/
логи (whitelist-only в `TeamProvisioningRuntimeDiagnostics` остаётся
whitelist-only), а в launch-failure артефактах редактируются по **известным
значениям** из того же use-case; паттерны под кастомные форматы не плодим.
Стендовые `sk-...` уже покрыты существующей редакцией.

## 6. Учёт расходов (token-usage)

`GET /v1/usage` (sub2api) возвращает **агрегаты** — суммарные и маргинальные
(по дням / по моделям за диапазон), не строки запросов и не матрицу день×модель.
Поэтому:

- Импортёр (в token-usage, `main/infrastructure`, реализует
  `TokenUsageImporterPort`) запрашивает `/v1/usage` **на каждый день** окна
  (`start_date=D&end_date=D`, всегда явные даты) — `model_stats` такого запроса
  и есть разрез день×модель. События: одно на (ключ, день, модель),
  `usageSourceKind: 'gateway_exact'`; отсутствующие/пустые поля = 0 событий за
  день.
- **Идемпотентность и id:** детерминированный id события `(apiKeyRef, day,
  model)` + существующий ledger upsert-by-id ⇒ повторный импорт обновляет, а не
  дублирует; растущий "today"-бакет перезаписывает то же событие. Семантика
  ref: `ApiKeyService` возвращает **тот же** `apiKeyRef` для того же литерала
  ⇒ повторный ввод ключа не плодит события. Уникальность: ключ привязан
  максимум к одному биндингу — валидация при привязке/prepare (ошибка при
  повторном использовании), иначе инвариант «один ключ = один тиммейт» и
  атрибуция `apiKey → member` ломаются. Смена ключа = другой `apiKeyRef` =
  новые события, старые не трогаются.
- **Атрибуция:** импортёр штампует `teamName`/`memberName` (`agentName`,
  run-identity) в событие **в момент импорта** (биндинг читается только тогда)
  — смена биндинга не осиротит исторические события. `appRunId` обязателен
  контрактом события (`TokenUsageEventDto`) и события без него отбрасываются
  ledger'ом → заполняем детерминированным синтетическим ключом окна
  `gateway:<apiKeyRef>:<day>`. `byAgent` сейчас строится только по runs
  (события, не привязанные к run, уходят в `unmappedEventCount`) → в
  `snapshotProjection` добавляется минимальный fallback: события с
  `agentName` без run попадают в `byAgent` своего агента (файл у лимита 800 —
  net-дельта ≤ 0).
- **Запросы:** `requests` из `ModelStat` сохраняется в существующем JSON-поле
  события (`providerUsage`); `requestCount` в summary суммирует вес события
  (fallback 1) — иначе «точный» учёт показывал бы запросов = числу
  (день×модель).
- Порт `GatewayUsageSourcePort` — в token-usage (§4), адаптер HTTP — в
  gateway-provider, инжект композицией (app shell).
- `byAgent` в `snapshotProjection` уже есть (дополнение — fallback выше).

## 7. UI

1. **Настройки → «Gateway providers»**: CRUD профилей. Отдельной «проверки
   соединения» нет — она совмещена с пробой ключа (§7.2).
2. **Строка тиммейта** (`MemberGatewaySelector` рядом с `TeamModelSelector`):
   выбор профиля + ввод ключа (сразу в `ApiKeyService`, в UI не отображается) +
   выбор модели из `GET /v1/models` **его ключом** (= проба ключа; невалидный
   ключ → ошибка на строке). Пустой каталог моделей → ошибка на строке
   («каталог моделей пуст»), ручного ввода модели нет.
   `MemberDraftRow` (frozen cap 1001) — врезка компонента, net-дельта ≤ 0.
3. Смена имени черновика команды (`renameDraftTeamDirectory`) → биндинги
   показываются отвязанными, перевязка вручную (новой rename-логики нет).

## 8. Сценарии на локальном sub2api

Стенд: `git clone https://github.com/agent-teams-ai/sub2api`, `deploy/` +
`docker-compose.local.yml` (Postgres + Redis + sub2api).

**Seed:** админка → 2–3 аккаунта в группе → API-ключи тиммейтов, **обязательно
привязанные к группе** (ungrouped-ключи не пройдут авторизацию на gateway-путях).
**Пре-шаг:** `/v1/models` и `/v1/usage` отвечают ключом тиммейта (остальное
прикроют сценарии ниже).

1. **Claude Code ×2**, разные ключи → оба отвечают; `/v1/usage` каждого ключа
   показывает свои агрегаты; `byAgent` различает тиммейтов.
2. **Codex ×2 с разными профилями** → каждый ходит через свой per-member
   override (`/v1/responses`); ключи раздельны в учёте.
3. **OpenCode** → ответ через `/v1/chat/completions`, ключ в учёте.
4. **Смешанная команда** (по тиммейту каждого рантайма) → три ключа, три
   агрегата, `byAgent` показывает трёх.
5. **Смена биндинга** (другой профиль/ключ) → новые события идут на новый
   `apiKeyRef`, старые события с исторической атрибуцией сохраняются (§6).

## 9. Edge cases

| Случай | Поведение |
|---|---|
| Ключ невалиден/отозван | проба `GET /v1/models` ключом тиммейта → ошибка на строке, без фолбэка |
| Профиль удалён, на него ссылается тиммейт | prepare-ошибка «профиль не найден» |
| Сервер отклонил ключ (в т.ч. авторизация) | generic-ошибка «авторизация ключа отклонена» на строке (диагноз причин — на стороне стенда, §8 seed) |
| Один ключ пытаются привязать к двум тиммейтам | валидация при привязке → ошибка (инвариант «один ключ = один тиммейт», §6) |
| Два тиммейта, один провайдер, разные ключи | per-member патч поверх базы (§5.1) |
| Одинаковые имена тиммейтов в разных командах / имя с точкой или спецсимволами / конкурентная запись `opencode.json` | одно правило: team-scoped sanitized id + запись одной операцией через сериализованный writer (§5.2) |
| Рантайм auto-suffixed имя (`alice` → `alice-2`) | prepare-ошибка «effective-имя не совпадает с настроенным, перевяжите вручную» |
| In-process lane + биндинг | prepare-ошибка (биндинг требует separate-process спавна, §5.1) |
| `/v1/models` пуст | ошибка на строке, ручного ввода нет (§7.2) |
| Удаление/замена ключа OpenCode-записи | через существующий writer коннектора (`assertProviderApiKeyReplacement`) |
| Утечка ключей | whitelist-only диагностика, редакция по известным значениям (§5.3) |
| Rename черновика команды / тиммейта | ручная перевязка (§7.3), исторический учёт не переписывается |

## 10. Этапы

| # | Шаг | Результат |
|---|---|---|
| 1 | `contracts` + `core/domain`: профили, биндинги (с валидацией уникальности ключа), `resolveGatewayConnectionSpec`, `toArtifactId`, per-runtime маппинги, eslint-границы фичи | домен + тесты |
| 2 | `main`: `GatewayProviderStore`, ключи через `ApiKeyService`, use-case «ref → литерал + redaction-значения» (`main/application`), IPC; в token-usage — `GatewayUsageSourcePort` + ре-экспорт из `@features/token-usage/main`; инжект адаптера в app shell | обвязка |
| 3 | Per-member доставка: member-aware контракт `buildCrossProviderMemberArgs` (потребители §5.1 + type-only подписи `EnvRuntimePorts`/`ProviderRuntimeFacade`), `applyGatewayMemberEnvPatch` (единственная точка применения) + **один** env-тест (constraint порядка + выживание ключа), per-member `-c` для Codex, записи OpenCode через существующий writer, prepare-правило separate-process | тиммейты ходят через gateway своими ключами (прямой путь) |
| 3а | **Внешняя задача (репо `agent_teams_orchestrator`)**: (а) сериализация `env` из фронтового `TeamProvisioningBootstrapSpec.ts`; (б) поле `env` в zod-схеме `bootstrapMemberSchema` (`teamBootstrapSpec.ts:35`, `z.strictObject` — без него неизвестный ключ отвергается); (в) проброс литералов в `extraEnv` на **всех** separate-process спавн-путях: `spawnMultiAgent.ts:1880` и `:2207` (tmux-ветки `buildInheritedEnvVars`), `handleSpawnNativeProcess` (`extraEnv` в `buildInheritedEnvObject` ~:2664); gateway-ключи не срезаются `shouldClearAnthropicApiKeyForTeammateSpawn`; минимальный свой тест проброса `extraEnv` | bootstrap-путь per-member |
| 4 | UI: секция профилей + `MemberGatewaySelector` | выбор per-member |
| 5 | Импортёр `gateway_exact` (запрос на каждый день окна, события (ключ, день, модель) со штампом `agentName`, синтетическим `appRunId`, весом `requests` в `providerUsage`) + `GatewayUsageSource`-адаптер + fallback в `snapshotProjection` (события с `agentName` → `byAgent`) | учёт per-member |
| 6 | Пре-шаг контракта + прогон §8 на sub2api | готово |

**Оценка:** ~4–5.5k строк (с тестами), преимущественно новые файлы фичи.
Вне этой оценки: шаг 3а в репо оркестратора (~0.3–0.5k) и возможные правки
sub2api, если пре-шаг §8 выявит несоответствие контракту.
