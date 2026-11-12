# 07. Настройки провайдера, лимиты, skills, MCP и plugins

Статус: source capture/publication foundation реализован и проверен; native consumption и G1–G4 ещё открыты.
Цель: сохранить применимые возможности существующего frontend, используя уже выделенных владельцев.
Новая архитектура не даёт основания игнорировать сохранённую настройку или объявить рабочий control unsupported.
Публикация source/profile revisions целиком принадлежит [06](06-runtime-installation-profiles.md).
Выбор модели/default и prelaunch probe принадлежат [05](05-model-selection.md); credentials — планам 01/02.
Этот план владеет преобразованием config и фактической применимостью настроек/расширений к выбранному runtime.

## 1. Закреплённые источники

- Product main: `777genius/agent-teams-ai@4a0e06277fe216d9f82dbbede362668fe46622ee`.
- Stage1: `777genius/agent-teams-ai@1d0f97f55de566036c970eab4f36b84620afdb3f`.
- Runtime main: `0.0.160`, `777genius/agent_teams_orchestrator@e13edcd3d4ffbecc0272ae30195cc6b15b710ee7`.
- [M1] `MemberMcpPolicyPanel`: inheritLead/inheritScopes/strictAllowlist/appOnly — существующие choices UI.
- [M2] `TeamProvisioningOpenCodeTeamConfigWriter`: сохраняет per-member MCP policy вместе с model/effort.
- [M3] `ExtensionStoreView`: существующие вкладки skills, MCP, plugins и provider capability projection.
- [M4] `openCodeLocalModelLimits`: limits card появляется только для существующей `configured_local` local-model projection.
- [M5] `MembersEditorSection`: MCP lock — пользовательский общий toggle, не V2 capability gate.
- [S1] `CapturedRuntimeProviderManagementClient`: default/limits API уже есть; используется existing preference store.
- [S2] `managedProviderPreferences`: project/global precedence и сохранение посторонних полей.
- [S3] `NativeExtensionCoordinator`: native Claude MCP/plugin read/mutate/diagnose и original-target journal.
- [S4] `SkillCoordinator`: captured roots, preview/mutation/lookup, проверка original source.
- [S5] `captureRuntimeMcp`: Claude/Codex/V1 capture; V2 external policies сейчас явно отвергаются.
- [S6] `OpenCodeV2EmbeddedConfig`: private selected provider configuration и controller MCP, ambient plugins не импортируются.
- [R1] `OpenCodeProfileManager`: global/XDG/explicit/project merge и `materializeOpenCodeSelectedScopeAuth`.
- [R2] `OpenCodeV2ExecutionConfig`: selected custom model mapping; native config содержит только controller MCP.
- [R3] `OpenCodeProviderManagementAdapter`: limits editor идёт через V1-only `withManagedOpenCodeClient`.
- [R4] `OpenCodeV2LaunchPlan`: effort→variant и создание private profile с выбранным provider config.
- [R5] `OpenCodeV2RuntimeStatus`: extensions/effort в read-status помечены capabilities_pending; это не весь launch contract.

## 2. Доказанное поведение и оставшиеся вопросы

| Возможность | Current main/source | Stage1/reuse | Необходимая работа |
| --- | --- | --- | --- |
| Project/global defaults | Работают отдельные preference owners | Store/API реализованы | Довести выбор в 05, здесь не писать второй store |
| Configured local model limits V1 | Existing editor проверяет и сохраняет override | `configureModelLimits` и file store есть | Проверить фактическое применение нового launch |
| Declared V2 custom model limits | R1→R2 переносит native model `limit` | Есть `providerConfiguration`, нет полного config input path | Перенести selected declaration без потери полей |
| V2 limits editor | R3 отвергает non-V1; M4 может вообще не показать card для V2 catalog_provider | V2 probe отвергает limits | Сначала actual UI gate; скрытый/disabled control не считать working V2 editor |
| Claude native MCP/plugins | Existing registry/install UI | S3 владеет native файлами и командами | Reuse, original-target checks, capability/UI parity |
| Skills пользователя/проекта | Existing Skills UI и root scopes | S4/collection уже выделены | Проверить save/read/launch consumption, без второго skill scanner |
| V1/Codex selected MCP | Политики per-member уже сохраняются | Есть captured catalog/recipes | Проверить scopes/allowlist и actual native tool availability |
| V2 external MCP | M1/M2/M5 предлагают policy, R2 формирует только controller | S5 запрещает external choice | Existing UI/native mismatch; исправление квалифицировать отдельно от старого working native parity |
| Произвольные OpenCode plugins | V2 R2 допускает только builtin configuration | Ambient import запрещён | Проверить конкретные advertised routes; не обещать весь plugin ecosystem |

Read-only source проверен на pinned runtime, а не только по fixture с `supportedReasoningEfforts: []`.
R1 читает canonical global/XDG/explicit config, затем project; project имеет приоритет над импортированным.
R1 материализует только выбранный provider/model; поддерживает package/baseURL/объявленный model и bound credential.
R2 валидирует model aliases, capabilities, limits, variants и отвергает неизвестные несовместимые поля явно.
R3 `configureModelLimits` вызывает `withManagedOpenCodeClient`, который отказывает generation != V1.
Поэтому editor и declared native limit — разные сценарии; нельзя записать их одной строкой «V2 limits поддержаны».
Для external MCP source уже показывает controller-only config, но frontend policy affordance требует отдельной проверки.
V2 declared model limits/variant, V1 limits editor и возможный V2 editor — три разные capability rows, не общий флаг settings supported.

## 3. Ограниченная проверка baseline до реализации

Эти проверки обязательны; они не создают бессрочный исследовательский проект и не меняют scope по умолчанию.
Использовать два изолированных test profiles: pinned main/runtime и Stage1, одинаковые test inputs.
Native engine настоящий; локальный совместимый provider/MCP fixture используется только как наблюдаемый endpoint.
Fixture фиксирует полученный model/variant/body/tool call; mocked Host receipt доказательством не считается.

- **07-G1 — V2 default/variant:** один declared custom model, default и один native variant из его schema.
  Пройти существующий saved/launch путь и записать native selection/request; передать результат владельцу 05.
- **07-G2 — Config/limits:** global model A и project override B с различимыми native limits/settings.
  Проверить declared launch; отдельно записать card visible/hidden и routeKind, нажать только реально доступный existing limits editor.
- **07-G3 — External MCP:** test server с одним безопасным sentinel tool; existing UI strictAllowlist и appOnly.
  Проверить, предлагает ли V2 UI policy, попадает ли tool в native inventory и может ли выполняться.
- **07-G4 — Extensions:** один существующий Claude plugin и skill; проверить UI mutation и native consumption.
  Для V1/Codex прочитать effective MCP inventory; не разворачивать всю provider×plugin матрицу.

На один positive case достаточно одного короткого native input и readback; после него штатно закрыть owned runtime.
Фиксировать commit/artifact digest, source scopes, effective fields и receipt без токенов/credential bodies.
Если операция доступна в UI, но old runtime её игнорирует, это выявленный product mismatch, а не разрешение удалить её.
Для exposed mismatch оформить отдельную строку «исправление existing UI/native несоответствия» и bounded adapter, не назвать её старой рабочей V2 возможностью.
Если control уже недоступен с конкретной provider reason, сохранить точную границу; новую возможность не обещать.
Любая открытая G-проверка остаётся незакрытым пунктом acceptance, а не формальным PASS/skip.

## 4. Acceptance criteria

- 07-A1: declared settings выбранного provider/model сохраняют прежний precedence и значения в native launch.
- 07-A2: посторонние providers, поля preferences и пользовательские файлы не перезаписываются заодно.
- 07-A3: limits из existing доступного local editor после успешного Test применяются к launch; declared V2 limits проверяются отдельно без нового editor.
- 07-A4: invalid/неподтверждённые limits не сохраняются как verified; прежняя конфигурация продолжает работать.
- 07-A5: model probe и launch используют один config snapshot/revision, а не повторно читают разные live файлы.
- 07-A6: skills/plugin/MCP mutations сохраняют original project/account scope при foreground switch.
- 07-A7: proven MCP scopes сохраняют native inventory; exposed V2 mismatch получает отдельный qualified adapter, appOnly исключает external tools.
- 07-A8: изменение MCP policy не отключает unrelated native instructions/skills/hooks у Claude.
- 07-A9: UI capability означает реализованный и проверенный маршрут, а не просто наличие native API.
- 07-A10: нет доступного existing control, который новый Host безусловно отправляет в unsupported без завершённого G-case.
- 07-A11: конфигурация B не изменяет уже running captured A; next-launch publication использует только 06.
- 07-A12: malformed config даёт понятную scoped ошибку; он не трактуется как пустой успешно применённый config.
- 07-A13: failed/unknown extension mutation читает исходный journal; чужой повторный native install не запускается автоматически.
- 07-A14: все 07-G1…G4 имеют проверяемые results и связанный required implementation/explicit existing limit.

## 5. Архитектура и минимальный объём изменений

`FileManagedProviderPreferences` сохраняет defaults/overrides; он не превращается в owner native credentials.
`NativeExtensionCoordinator` остаётся владельцем Claude extension mutations; не дублировать CLI invocation в main IPC.
`SkillCoordinator` и существующий `CapturedSkillsCollection` остаются владельцами roots/проектных коллекций.
`capturedRuntimeMcpRecipes`/catalog selection сохраняют durable per-member policy и original source digest.
`captureClaudeSettingSources` сохраняет native setting sources независимо от MCP appOnly.
Нужен небольшой selected-provider config adapter: JSONC read/precedence/declared model translation по R1/R2.
Он отдаёт private prepared configuration в publication use case 06; renderer получает только existing summary/diagnostics.
Auth-bearing headers/settings materialize через existing bound credential/source owner; selection index 06 не становится второй plaintext копией секрета.
Read/probe/launch должны использовать тот же captured source либо выявить изменение до effect. External file mutation не трактовать
как автоматически применённую новую revision; explicit auth mutations не обещают сохранение старых token bytes для active session.
Не импортировать whole user config/ambient executable plugins в V2 ради обхода captured-profile ограничения.
Предыдущий working plugin route сохраняется отдельным квалифицированным adapter, если G4 подтвердит требование.
Не переносить 4 000 строк legacy `OpenCodeProfileManager`: извлечь только выбранную data transformation и explicit IO port.
Не создавать universal capability registry; existing provider status получает capabilities от реальных owner results.

## 6. Порядок реализации и файлы

### 07.1. Закрыть baseline вопросы

1. Выполнить 07-G1…G4 и записать source→UI→native table для четырёх provider routes.
2. Сверить selected fields с R1/R2: package/baseURL/aliases/settings/body/capabilities/limits/variants и qualified package availability в выбранном graph.
3. Передать variant qualification в 05, auth materialization contract в 02 и publication inputs в 06.
4. Назначить каждому mismatch либо конкретный existing owner fix, либо небольшой отдельный provider adapter.

### 07.2. Настройки и limits

1. В `runtime-provider-management/main/adapters/output/` добавить только недостающий capture selected config.
2. Использовать существующие file/JSONC utilities и explicit captured source identities; не принимать raw config из renderer.
3. Сопоставить schema selected config с `openCodeV2EmbeddedProfile.ts` и `OpenCodeV2EmbeddedConfig.ts`.
4. `providerConfiguration` сейчас лишь bounded JSON; использовать strict selected-model codec R2, alias conflict/partial variants не нормализовать потерь ради.
5. `CapturedRuntimeProviderManagementClient.configureModelLimits` продолжает использовать existing store/probe flow.
6. `OpenCodeV2ModelProbe.ts` получает limits/config только по qualified G2 route, согласованному с 05.
7. Publication нового config/limits snapshot выполняет 06; 07 не меняет available pointer напрямую.
8. Проверить native readback/observed request: совпадение DTO или записи preference недостаточно.

### 07.3. Extensions и MCP

1. В `capturedClaudeMetadata.ts`/status projection отображать actual owner capabilities без blanket supported.
2. В existing `captureDesktopNativeExtensions` и `CapturedNativeExtensions` сохранить original sender/scope guard.
3. Native mutations проходят существующий `CapturedExtensionCommandLedger` и Host owner, без второго transaction log.
4. Skills используют existing capture/cache/collection; исправить только доказанные missing bindings/projection.
5. `captureRuntimeMcp.ts`, `inheritNativeMemberMcp.ts`, `capturedRuntimeMcpRecipes.ts` сохраняют per-member selection.
6. Если G3 подтверждает exposed V2 policy, добавить bounded server translation + native readiness/inventory/custody; отдельно отметить новый native adapter.
7. Для V2 разрешать только захваченные configured servers; встроенный Team controller не заменяется внешним сервером.
8. Preserve allowlist/scope и transport/env semantics; не открывать доступ всем ambient MCP ради одного tool.
9. Cleanup затрагивает только owned test/runtime resources; native shared server не объявлять owned по одному имени.

## 7. Зависимости и parallel ownership

| Boundary | Writer | Внешний consumer |
| --- | --- | --- |
| Selected config/limit translation | 07 | 05 probe, 06 publication |
| Available profile lifecycle/storage | 06 | 07 передаёт validated snapshot |
| Model/default/variant choice | 05 | 07 поставляет declared configuration |
| Credentials/auth journal | 01/02 | 07 сохраняет reference, не secret copy |
| Native extensions/skills | 07 | Existing Desktop extension panels |
| Live `/model`/`effort`/`fast` | 03 | Использует общий config input, но свой session command |

07 может параллельно писать config helpers и extension-specific tests после фиксации private inputs 06.
`OpenCodeV2ModelProbe.ts` меняет 05; 07 передаёт prepared mapping patch для последовательной интеграции.
`runtimeCaptureSource.ts` меняет 06; MCP additions вводятся отдельным согласованным diff.
`CapturedRuntimeProviderStatusClient.ts` имеет один writer на интеграционный шаг: 06 identity, 05 models, 07 capabilities.
При native provider package change сначала обновить выделенный provider PR/artifact, затем exact consumer pin.
Основная ветка не сливается; intermediate PRs остаются в feature lane до полного acceptance.

## 8. Реальные E2E journeys

Использовать существующий Desktop/CDP harness, test-only projects и pinned real native runtimes.
Сценарии 05/06 переиспользуют fixtures/readback; одинаковый code budget не считать второй раз.

1. **07-E1 — Global/project config.** UI выбирает custom model из global config, project override изменяет его settings.
   Новый launch использует project поля; другой test project использует global; чужие config bytes не меняются.
2. **07-E2 — Limits.** Для реально показанного local editor выставить пределы, Test/save, restart, launch; для V2 declared limits использовать config путь.
   Native effective values совпадают; отсутствие V2 card фиксирует existing limit, без создания новой UI feature ради теста.
3. **07-E3 — MCP policies.** В смешанной Team задать allowlist и appOnly, выполнить безопасный external sentinel tool.
   Проверить native inventory каждого применимого provider, отсутствие forbidden tool и обычную работу Team MCP.
4. **07-E4 — Claude plugin.** Existing UI устанавливает test-only plugin, native session видит его capability.
   Удаление отражается в следующем захваченном запуске; original pending request не переключается на другой account.
5. **07-E5 — Skills.** Создать/изменить skill в user/project scope через existing UI, перезапустить приложение.
   Проверить список, scoped bytes и native consumption в новом запуске; другая project collection не изменилась.
6. **07-E6 — Изменение источника.** Во время Test изменить выбранный config/MCP file или foreground project.
   Устаревший результат не публикует новую revision; retained original operation доступна для lookup/cleanup.
7. **07-E7 — V2 UI mismatch gate.** Для доступных после G2/G3 controls пройти полный UI→Host→native route.
   Нельзя зачесть лишь disabled button; previously offered functionality требует исполнимого результата и readback.

Новые focused tests: strict selected-model alias/variant conflict и source-identity mutation между Test/publication.
Existing precedence, foreign path, unrelated preferences и original-target lookup suites расширять только при изменении их boundary.
Повторно не тестировать все filesystem primitives/skill parsers: existing suites остаются достаточным основанием reuse.
Для новых native mappings нужен один schema/contract case и негативный случай, а не mock каждой строки transformation.

## 9. Оценка и закрытие

- Основной production budget: **500–900** строк для selected config/limits integration и точечных owner fixes.
- Основные tests/E2E: **600–1 050** строк (450–850 E2E, 150–200 критичных tests) сверх переиспользуемых suites.
- Bounded резерв для подтверждённого UI mismatch V2 external MCP/limits: **650–1 100 production**, **800–1 300 tests/E2E**.
- Полный диапазон при требуемом adapter: **1 150–2 000 production**, **1 400–2 350 tests/E2E**; это не новый framework.
- G2/G3 решают конкретную реализацию резерва; они не разрешают автоматически вычеркнуть frontend обещание.
- V2 effort mapping/qualification посчитаны в 05; source publication в 06; auth в 02 — здесь не суммируются повторно.
- Сложность: **7/10**; ожидаемая надёжность после acceptance: **8/10**; уверенность baseline budget: **7/10**, резерва: **6/10**.
- Done: 07-A1…A14, закрытые G-cases, реальные E1…E7, exact-head CI и отсутствие новых unowned writers.
- Исторические receipts Stage1 подтверждают reuse, но не заменяют проверку изменённого native config.

## 10. Ревью плана

**R1 — собственное критическое ревью выполнено 2026-11-12; исправления включены в текст.**
Найдено: source old runtime был доступен, поэтому прежняя «неизвестность» limits/MCP была слишком широкой.
Исправлено: прочитаны pinned R1–R5; разделены V1-only editor и V2 declared limits, controller-only config и UI policy.
Найдено: owner separation могла ошибочно считаться потерей всей plugin/skills/default реализации.
Исправлено: S1–S4 явно переиспользуются; бюджет включает только конкретный mapping/consumption boundary.
Найдено: условный резерв позволял бы незаметно закрыть обещанную UI возможность как неподдерживаемую.
Исправлено: G2/G3/G4 и 07-A10/A14 требуют проверяемого решения, а 07-E7 запрещает fake completion disabled кнопкой.
**R2 — source review выполнено 2026-11-12; reviewer `estimate_account_commands`, reviewed commit `783422b9`.**
Проверены pinned runtime R2/R3 и actual frontend M4/M5: V2 declared limits ≠ V1-only editor; MCP lock не является V2 gate.
Исправлено: G2/E2 не создают несуществовавшую limits card; exposed V2 MCP mismatch отделён от уже working native parity.
Найдено: Host providerConfiguration — generic JSON, тогда как donor строго валидирует aliases/partial variants; config может содержать auth material.
Исправлено: strict native codec/package availability и bound-secret materialization обязательны; source index не хранит второй auth store.
Unit список сокращён до новых опасных mapping/source-mutation cases; existing extension/fencing suites переиспользуются.
**R3 — интеграционное ревью, выполнено root 2026-11-12; входной published SHA `cda065d869ccffb5930ed2a817b3e0654b00bb31`.**

- Проверены selected config/limits границы, management admission и P02/P03/P05/P06; generic bounded JSON не объявлен native config validation.
- Найдено: auth headers могли стать второй persisted secret copy или silently reread между probe/launch. Уточнён existing owner/source capture, изменение проверяется до effect.
- G1/G2 даёт один native selection/config journey совместно с P05/P06; G3/G4 сохраняют отдельный tool/native effect, без полной provider×plugin матрицы.
- Live slash и prelaunch config не дублируют state machine; файлы общего recipe меняет P06, model probe — P05.
- План принят для bounded G1–G4 и последующей реализации. Ни неподтверждённый V2 editor, ни external MCP не записаны как готовые capabilities.

## 11. Уточнение implementation boundary после P05/P06

**R4 — повторное source/ownership review, 2026-11-12; согласовано с root до расширения source owner.**

- В [R1] `getOpenCodeConfigImportPaths`/`readSafeOpenCodeRuntimeConfigImport`/`readProjectOpenCodeRuntimeConfig` подтверждён порядок: canonical HOME → XDG → explicit `OPENCODE_CONFIG` → inline `OPENCODE_CONFIG_CONTENT` → project root `opencode.json`/`opencode.jsonc`. Выбранный provider merge сохраняет project precedence; ambient executable plugins в новый V2 graph не импортируются.
- Начать с маленького read-only selected-config adapter: strict selected model mapping по [R2], bounded JSONC read и source fingerprint. Host выводит пути из **исходного private profile** (`HOME`, XDG, explicit config, cwd); Main/renderer не передают произвольный файл. Не переносить whole donor profile manager.
- Existing P06 source record хранит только выбранные file references/digests и inline digest. Raw config, API key, headers и environment values не идут в source index, receipt или renderer DTO. При материализации selected declaration Host проверяет исходные paths/digests до и после bounded read; changed/malformed source даёт scoped отказ.
- Existing Save/Refresh захватывает новый source reference через того же P06 owner. Новый pointer применяется только к новым captures. Already captured run/receipt сохраняет original reference; повторный probe/launch не перечитывает иной источник под старой revision.
- P02 остаётся owner credential source. Config `options.apiKey` и env/file substitutions получают private captured port с `digest/isCurrent/readKey`; один native import выбирается по подтверждённому donor precedence. Custom provider без native integration использует только private selected config и source fence; native credential ID для него не выдумывается.
- Проверено: existing `CapturedRuntimeProviderManagementClient.view(previous)` уже сохраняет успешную запись preferences при failed refresh, поэтому второй default store/новый recovery flow не нужен. Проверка **default → actual new launch** и применение persisted V1 limits остаются обязательными отдельными пунктами.
- P05 native fixtures подготовлены для model B/declared `high`, но ещё не исполнялись. P07 расширит тот же observable request для global/project override; G1…G4 не считаются закрытыми от наличия fixtures или source trace.
- Root владеет `DesktopBackendFeature`: config integration передаёт ему только узкий capture/refresh hook. Production/test file cap 800 и текущие protocol budgets не увеличиваются; проверки ограничены strict alias/variant mapping, changed original source и общим native journey.

### R5 — конкретный refresh/retry и global/project порядок

- Main-only `runtime.source.refreshConfiguration({commandId, expectedRevision})` получает grant из original descriptor. Host сам захватывает config references и публикует их через существующие `RuntimeSourceIndex`/`runtime.source` receipt; renderer не получает read-file API.
- Повтор того же command после lost ACK/Host restart использует **original `publicationJson`** и original expected revision. Он не захватывает обновившийся config под прежним command ID. Неопределённый или изменённый original source остаётся scoped held, без второго native эффекта.
- Global capture читает только HOME/XDG/explicit/inline sources. Он не читает `seed.cwd` как project и не переносит его config в другой проект. Project capture добавляет только original project root files; такой reference нельзя применить к другому cwd.
- Existing Save/Refresh: capture original context → recover existing source intent → publish captured config reference → получить новый management target → читать/probe выбранную модель. Next launch берёт тот же revision; already captured launch остаётся со своим reference/config.
- Source candidate для config-only публикации сохраняет прежний executable/engine/source kind; для исходного seed допустим `captured`, без выдуманного `bundled/path` provenance. Existing installer native selection сохраняет свой прежний набор source kinds.
- Выделенный read-only mapper сначала проверяется на official `@opencode/schema@2.1.4` (registry metadata/pack/tar SHA512 совпадают). Donor `2.0.32` validator не подключается к новой схеме. Raw selected values остаются только private process input; index хранит references.
- Native package должен присутствовать в выбранном verified engine graph; capture config не разрешает ambient install/import. Arbitrary credential `{file:...}` не становится поддержанным от строки в JSON: existing app-owned gateway marker требует отдельной квалификации, остальные сохраняют доказанный strict-source предел.

### R6 — проверенный source foundation и следующая native граница

- `OpenCodeConfigurationSource` фиксирует global/project JSONC sources; `openCodeSelectedProviderConfiguration` валидирует selected aliases/limits/variants по точной схеме 2.1.4. В source record остаются references/digests и структурированный default provider/model/variant.
- `RuntimeSourceIndex.refreshConfiguration` использует существующий receipt и original publication snapshot. Проверен lost ACK после pointer publish: cold retry возвращает A даже после изменения файла на B; новый command публикует B, retained A не переназначается. Malformed JSONC не становится пустым config.
- `refreshCapturedRuntimeConfiguration` подключён в существующий Main management capture. Неприменимые providers сохраняют прежний путь; актуальные references не создают новую revision при повторном Refresh. Публикация source сама по себе ещё не доказывает native model request.
- Проверки foundation: Host build/testtypes и Main focused TypeScript PASS; 51 focused Host checks, в том числе четыре новых config/codec cases, PASS; source refresh/recovery subset 16/16 и существующий Main/Host source integration 4/4 PASS. Реальный native/Desktop запуск ожидает штатного CI.
- Повторно прочитан [R1]: launch materializer берёт `snapshot.selectedAuthCredential`; `options.apiKey` лишь требует наличия resolved credential. Доказанного приоритета отличающегося config key нет. До native qualification конфликтующий key должен давать scoped отказ; ни новый credential store, ни silent override не вводятся.
- Catalog baseline [R1] `materializeOpenCodeV2CatalogScope` импортирует **все declared models выбранного provider**, launch — только выбранный model. Следующая native интеграция сохраняет эту разницу и source fence.
- Повторный просмотр official 2.1.4 уточнил package boundary: `AISDKNative.rewrite` переводит известные legacy SDKs (включая `@ai-sdk/openai-compatible`) в bundled native providers; **оставшийся dynamic SDK** попадает в loader с `npm.add`. Перед native consumption нужно использовать этот native rewrite, затем exact resolution внутри verified delivery. Не копировать package registry и не подменять SDK вручную; маршрут ambient установки не допускается.

### R7 — native input и исправление найденной совместимости paths

- Native consumption использует один private `OpenCodeV2CapturedConfiguration`: для запуска только selected model, для catalog — все declared models выбранного provider. Raw headers/body/API key не добавляются в durable profile или receipt; config key должен совпадать с original P02 credential, иначе возвращается scoped ошибка.
- После native readiness работающая сессия сохраняет исходный private config A. `captureMemberProviderAuthority` проверяет original entry/profile/config и Team grant, а не current `RuntimeSourceIndex` pointer; `OpenCodeV2CredentialScope` проверяет original auth source. Поэтому изменение config или публикация B не останавливают A и не переназначают его. Pending probe/catalog и cold capture по старому reference сохраняют source freshness gate.
- Root review подтвердил exact native package rewrite + manifest-contained resolution в существующем EmbeddedGraph. Builtin declaration остаётся для полной native translation; remaining dynamic SDK получает только проверенный file URL до engine start. Второй package manager и ambient install не вводятся.
- Найдено несовпадение с [R1] `readSafeOpenCodeRuntimeConfigFile`: donor читает обычные symlinked/hardlinked config через `readFile`, тогда как новый read-only reader отвергал их. Исправить **существующий** `OpenCodeConfigurationSource.readSource`: зафиксировать canonical target и identities исходного link/ancestors, читать canonical target через stable FD, проверить path mapping и fstat до/после. Retarget даже на файл с одинаковым содержимым меняет captured identity; новый файловый owner/journal не нужен.
- Existing native model-probe fixture должен использовать global config через symlink и project override, затем наблюдать реальные model/body/headers/limits/default. Existing Team fixture меняет config после readiness и требует исходные A settings во всех последующих запросах. Проверка scoped UI error сохраняет safe reason без raw config/token.
- Промежуточные проверки native input: Host build и 28 focused tests PASS до последнего type-only/noise fix; Main focused TypeScript, 11 management UI tests, fast lint без ошибок и source-size guard PASS. Общий Host rebuild/testtypes выполнить после согласованного P03 package pin; actual native/Desktop и G1–G4 остаются открытыми до штатного CI.

[M1]: https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/renderer/components/team/members/MemberMcpPolicyPanel.tsx
[M2]: https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/main/services/team/provisioning/TeamProvisioningOpenCodeTeamConfigWriter.ts
[M3]: https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/renderer/components/extensions/ExtensionStoreView.tsx
[M4]: https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/features/runtime-provider-management/renderer/openCodeLocalModelLimits.ts
[M5]: https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/renderer/components/team/members/MembersEditorSection.tsx
[S1]: https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/src/features/runtime-provider-management/main/adapters/output/CapturedRuntimeProviderManagementClient.ts
[S2]: https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/src/features/runtime-provider-management/core/domain/managedProviderPreferences.ts
[S3]: https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/extensions/NativeExtensionCoordinator.ts
[S4]: https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/skills/SkillCoordinator.ts
[S5]: https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/composition/captureRuntimeMcp.ts
[S6]: https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/adapters/providers/OpenCodeV2EmbeddedConfig.ts
[R1]: https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/services/opencode/OpenCodeProfileManager.ts
[R2]: https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/services/opencode/profile/OpenCodeV2ExecutionConfig.ts
[R3]: https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/features/runtimeProviderManagement/adapters/opencode/OpenCodeProviderManagementAdapter.ts
[R4]: https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/services/opencode/bridge/OpenCodeV2LaunchPlan.ts
[R5]: https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/services/opencode/catalog/OpenCodeV2RuntimeStatus.ts
