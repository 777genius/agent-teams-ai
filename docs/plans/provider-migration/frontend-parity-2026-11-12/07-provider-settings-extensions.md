# 07. Настройки провайдера, лимиты, skills, MCP и plugins

Статус: source capture/publication, selected native config, app default и V1 saved limits реализованы; actual acceptance G1–G4 и extension/skill consumption ещё открыты.
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

### R8 — сохранённый app default и V1 limits до фактического launch

**Повторное source review перед реализацией; выбран private snapshot в existing recipe, согласовано с root.**
P07 native config опубликован `6a2bb4b88bffbe001e16ff7fd27430f330b43517`.
Он не закрывает отдельную цепочку preference file → новый launch: UI уже читает/сохраняет default и limits,
но source recipe пока не получает эти значения. Именно эту цепочку исправляет следующий срез.

1. **Сохранить donor precedence.** [R6] хранит app preferences; [R7] выбирает project default,
   затем all-projects default. В [R1] `prepareProfileInternal` (`3581–3654`) default накладывается на imported config,
   а limits объединяются global → project; `applyOpenCodeModelLimitOverrides` (`927–962`) задаёт
   `limit: { context, output }` выбранного qualified model. V2 `materializeOpenCodeV2CatalogScope`
   (`4021–4050`) тоже предпочитает app default перед config default, но не подключает V1 limits editor.
   Явно выбранная в Team модель остаётся выше default. Очистка project default возвращает global/native fallback.

2. **Один preference owner.** Переиспользовать [S7] `FileManagedProviderPreferences.capture/read` и
   `resolveManagedPreferences`; добавить узкий read-only export из `runtime-provider-management/main`.
   Он получает original descriptor roots и guard, возвращает только resolved default и числовые
   `contextTokens/outputTokens` по qualified model ID. Не переносить неизвестные поля, timestamps, paths,
   raw config или credentials в Host DTO. Global capture не читает project preferences другой вкладки.
   Запись остаётся в существующих `setDefault`/`setLimits`, с сохранением посторонних полей.

3. **Использовать existing source publication/recovery.** Передать canonical safe snapshot через
   существующий `runtime.source.refreshConfiguration`, сохранить его в той же immutable candidate/recipe.
   Digest входит в прежнюю source/config revision; одинаковые семантические значения не создают revision
   из-за timestamps или порядка ключей. V1 получает этот refresh без V2 config import; V2 сохраняет R5–R7
   references и получает app default. Retry старого command использует original `publicationJson`,
   даже если preference file уже B. Новый command может опубликовать B; retained A остаётся A.
   Не добавлять второй settings store/journal или Host reader пользовательских preference paths.

4. **Применять limits после реального выбора модели.** `applyOpenCodeRuntimeSource` задаёт app default
   для следующего base recipe; existing `applyLaunchConfiguration` затем сохраняет explicit Team selection.
   После этого применить **только V1 override реально выбранного qualified model** через existing
   `withOpenCodeModelLimits`, обобщив его environment helper при необходимости. Safe snapshot остаётся
   private частью recipe, а все overrides не разворачиваются в `OPENCODE_CONFIG_CONTENT`.
   Это сохраняет non-default model и нынешний inline budget. V2 принимает app default, а declared limits
   продолжают идти через strict selected config; новый V2 editor/override route не вводится.
   Native preflight и actual launch должны видеть одинаковые selected values; cross-provider qualified
   model обновляет provider/model как одну пару, без чужого providerConfiguration.

5. **Связать Save/Refresh и первый запуск.** Existing management capture сравнивает safe snapshot digest
   вместе с configuration references. Успешный Save остаётся успешным даже при failed Refresh, с прежним
   предупреждением и без ложного native verification. До **новой** Create/saved-Team preparation вызвать
   тот же узкий captured OpenCode refresh для исходных context/project/owner; это применит уже сохранённые
   preferences и после перезапуска приложения, когда Settings ещё не открывали. Сначала original guard,
   recover/publish, затем capture/probe; read/cancel/lookup/submit существующей preparation не перечитывают
   настройки и не переадресуют исходный intent. Existing schedule capture переиспользует тот же recipe,
   без второго scheduler preference reader. `DesktopBackendFeature` получает только узкий method/call,
   существующий `captureScheduledRuns` сохраняется.

6. **Минимальные проверки и повторное ревью.** Расширить existing preference/source integration cases:
   project → global fallback; saved file → source → new launch; explicit non-default model со своим V1 limit;
   successful Save + failed Refresh; lost ACK retry с A после записи B. Использовать существующие native
   fixtures: V1 effective config/readback с app default и selected limit; V2 model B против native default A,
   с проверкой actual request. Already running A продолжает работу после публикации B. Actual Desktop
   journey использует те же descriptor preference roots и штатный remote CI. Не добавлять unit на каждый
   getter/mapper и не дублировать проверенные parsers/atomic write primitives. Перед publication проверить
   cross-feature barrel, original-owner fence, отсутствие secret fields и прежние size/protocol budgets;
   при приближении `RuntimeSourceIndex` к 800 строкам вынести только stateless projection, без нового owner.

**Результат R8 review:** отвергнуто разворачивание всех limit overrides в inline config до model selection:
оно теряло non-default choice или раздувало private config. Выбран snapshot + selected-only application.
Ни работающий receipt, ни mocked preferences test не закрывают native/Desktop acceptance сами по себе.


## R9 — external MCP: закрыть выявленное UI/native несоответствие

**Source review до изменений.** [M1]/[M2] предлагают `inheritLead`, `inheritScopes`, `strictAllowlist`, `appOnly`.
[R2] действительно формирует только controller server. В exact `@opencode/schema@2.1.4`,
`dist/mcp.js`, native поддерживает local command/environment и remote URL/headers; `codemode: false`
выставляет прямые tools. Exact `@opencode/core@2.1.4` `dist/tool/mcp.js` →
`dist/chunks/location-xyswfhq2.js` формирует namespace заменой символов вне `[a-zA-Z0-9_-]` на `_`
и проверяет permission action `<namespace>_<tool>`. Это новый bounded adapter для уже доступной политики UI,
а не утверждение, что старый V2 запуск её применял.

1. **Переиспользовать capture.** `captureRuntimeMcp.ts` остаётся единственным выбором user/project/local
   catalog, precedence и allowlist. Для embedded 2.1.4 сохранить выбранные `capturedMcpServers` и original
   `capturedMcpSource` тем же immutable launch artifact. Не подключать `OpenCodeMcpPolicyPlugin` V1,
   не читать ambient config второй раз в engine и не менять controller endpoint/bearer.
2. **Сохранить старые identities.** `capturedRuntimeMcpRecipes.ts` реконструирует новые non-empty captures
   существующим overlay. Прежний empty V2 capture без новых полей должен давать прежний recipe bytes/digest.
   `inheritNativeMemberMcp.ts` переносит только original authenticated lead selection; account/model/provider
   сохраняются у нового member. Published 2.0.0/2.0.21 path не получает embedded-only capability автоматически.
3. **Добавить маленькую V2 translation.** Один helper преобразует captured stdio в native local
   `{ command: [executable, ...args], environment }`, http/sse — в native remote с исходным URL/headers.
   V2 сам выбирает совместимый HTTP transport. Все внешние servers имеют `codemode: false`; remote также
   `oauth: false`, соответствуя текущему captured transport contract без нового login owner.
   Mapping не меняет сохранённые пользовательские config-файлы и не запускает команды при metadata read.
4. **Сохранить permission boundary.** Для выбранных внешних namespaces добавить только native rule
   `<namespace>_*`: manual → ask, auto → allow. Builtin tools и Team MCP сохраняют нынешние rules.
   До allocation отклонить collisions уже нормализованных namespaces и все четыре privileged Team action
   prefixes, включая `agent-teams_extra` и `mcp__agent_teams__x`, а не только exact raw `team`/`agent-teams`;
   иначе выбранный внешний сервер мог бы получить автоматическое разрешение Team tool в manual режиме.
   `appOnly` даёт ровно controller без внешних конфигураций и разрешений.
   Внешних servers максимум 255: вместе с единственным Team controller это native inventory budget 256.
5. **Проверять настоящий native inventory.** `OpenCodeV2EmbeddedMemberProvider` сверяет точный набор имён
   всех ожидаемых connected servers и прежний original Team catalog receipt. Тот же source-current guard
   применяется до allocation/dispatch; изменение источника не заменяет конфигурацию running session.
   Лишние ambient servers не принимаются; retry не пересобирает selection из current catalog.
   Cleanup остаётся у существующего native Session/custody; отдельный manager внешних процессов не добавляется.
6. **Приёмка без размножения тестов.** Existing MCP/source/overlay suites расширить лишь critical cases:
   namespace authority collision, прежний empty digest, selected-source drift и original retry после изменения файла.
   Native gate использует один sentinel MCP с real tool effect и original readback: strictAllowlist допускает только
   выбранный server, appOnly не обнаруживает и не вызывает его, Team tools работают в обоих случаях.
   Реальный native lifecycle подтверждает cleanup. Existing Desktop member-policy controls затем сохраняют
   выбранную policy и выполняют тот же один native tool; API setup не выдаётся за UI acceptance.

**R9 native gate после повторного review.** Один дополнительный шаг существующего Linux embedded job
в `.github/workflows/opencode-v2-stage1-preflight.yml`, без новой matrix. Новый
`packages/legacy-agent-host/tests/opencode-v2-captured-mcp.native.ts` переиспользует pinned Node/Bun/engine,
`buildNativeV1Host`, `startHost` и production `captureRuntimeMcp`. Реальный stdio server
`fixtures/native-opencode-v2-mcp/server.mjs` имеет один tool и исходную process identity.
Два запуска членов: strictAllowlist + manual once (external effect и Team reply) и appOnly (только Team reply);
lead recipe остаётся неоткрытым. Всего пять localhost inference requests. Проверить исходные receipts,
точный native tool result, физическое завершение исходного MCP child, cold read/lookup без нового процесса
или inference. CI требует отдельный полный receipt и сохраняет INCOMPLETE при ошибке/отмене; это ещё не
Desktop member-policy acceptance и не vendor inference. Прежний 11-request native Host сценарий не меняется.

**R9 проверка упрощения.** Остаются прежние catalog, launch artifact, member creation и permissions owners.
Нет нового MCP registry, protocol version, plugin injection, middleware, renderer API или provider daemon.
Control не удаляется для скрытия mismatch. До native и Desktop receipts пункт 07-G3 остаётся открытым.
Независимый повторный review подтвердил reuse owners и empty-capture compatibility; уточнения по normalized
prefixes, exact inventory и original retry внесены до implementation.

## R10 — подтвердить consumption plugins/skills в том же native namespace

**Найденный acceptance gap.** В `scripts/legacy-agent-host/desktop-native-extensions-fixture.ts`
`prepareDesktopNativeExtensionsFixture` заменяет только `hostProfile.management` на отдельный
`native-extensions/{home,config,tmp}`. Existing UI smoke действительно выполняет Install/Uninstall,
проверяет `settings.json` и native `plugin list`, но runtime member не использует этот namespace.
`desktop-skills-fixture.ts` намеренно требует `profile.runtime === undefined` и refusal-only CLI:
он доказывает Create/Edit/Import/Trash/original-target safety, но не native consumption.
Эти результаты сохраняются; 07-E4/E5 требуют отдельного короткого same-profile продолжения.

**Existing seams для reuse.** Production `composition/claudeSettingSources.ts` сохраняет
`user/project/local`, `runtimeCaptureSource.ts` переносит их независимо от MCP policy,
`adapters/providers/ClaudeMemberProvider.ts` передаёт их в native Query. [S3]/[S4] уже владеют
mutations и original target. P03 `desktop-native-commands-ui-proof.ts` и
`tests/fixtures/native-claude-commands/model.ts` проверяют actual native command inventory,
marked Composer Send и реальный Team MCP reply. Нужен acceptance wiring через эти границы;
production reader/registry/API заранее не добавляется.

1. **Один captured namespace.** Вариант existing `native-launch-ui` готовит настоящий pinned Claude
   через `prepareDesktopBackendFixture`, затем получает management profile из этого же runtime member:
   executable SHA, `cwd`, `HOME`, `CLAUDE_CONFIG_DIR`, account binding и setting sources совпадают.
   Descriptor по-прежнему явно выбирает original project/user scope. Сравнить эти private identities
   до старта приложения; в receipt сохранить только их digest и выбранный scope. Не заменять runtime
   чужим profile после запуска. Neighbor TEST namespace остаётся неизменным.
   Этот digest не включает runtime generation/capture identity: новый запуск обязан получить новые IDs.
2. **Один native setup, реальные UI mutations.** Marketplace setup использует прежнюю exact CLI action
   из `desktop-native-extensions-fixture.ts`. Existing Plugins panel устанавливает
   `frontend-design@claude-plugins-official`; дождаться original completed operation, затем прочитать
   native installed inventory и source digest. Не писать `enabledPlugins`, installed metadata или
   plugin-directory flags вручную. Вынести только повторно используемый plugin UI phase либо добавить
   узкие lifecycle hooks existing helper; не дублировать полный MCP/negative extension journey.
3. **Skills через имеющиеся controls.** В том же captured profile existing Create/Review/Apply создаёт
   небольшой user skill и project skill с различимыми TEST body markers; existing Edit меняет project
   marker A→B. Сохранить scoped bytes/digests после completed original journals. Использовать текущие
   `SkillsPanel` scope/root choices, без fixture записи вместо UI mutation. Прежние import/source-drift,
   Trash и held Codex случаи не повторять в новом inference journey.
4. **Настоящий новый launch и invocation.** Закрыть extension panel и штатно перезапустить приложение
   на тех же descriptor/profile pins, затем использовать existing Launch controls. Actual native Query
   inventory должен содержать installed plugin command и оба user/project skills. Выбирать command
   из существующей подсказки Composer; P03 marked dispatch проверяет original inventory и отправляет
   raw command один раз. Native request должен содержать тело выбранного plugin/skill, а не только
   введённое имя/arguments: для TEST skills проверять markers, для установленного plugin — bounded
   body witness из фактически установленного `SKILL.md`, с отдельным source digest.
   Witness читается по native installed inventory именно выбранного namespace; package/version закреплены.
   Не подставлять содержимое файла в product send. Finite model oracle возвращает один безопасный Team MCP reply;
   проверить exact journal/input receipt и видимый ответ.
5. **Следующий launch после удаления.** Штатно Stop/дождаться released custody, затем existing UI
   Uninstall. После completed mutation открыть новый runtime через existing Launch control с новым capture и проверить actual new Query inventory: plugin отсутствует, user/project skills остаются.
   Старый command receipt и terminal input не воспроизводятся, прежний plugin name нельзя отправить
   через stale suggestion. Новый runtime identity обязателен; reload renderer и `plugin list` поодиночке
   не заменяют эту проверку. Изменения не переадресуют уже captured request на другой project/account.
6. **Ограничить harness.** Один TEST variant flag existing Launch mode, несовместимый с schedule/command
   variants; отдельный небольшой helper содержит только plugin/skill lifecycle и его finite oracle phases.
   Existing cost/compact/review checks P03 не переписывать. Если второй fresh launch требует другого
   initial prompt, изменить его через тот же Launch dialog; не вызывать runtime/product mutation через
   CDP evaluate. Существующие request/protocol limits не увеличивать автоматически; exact phase counts
   и cleanup должны быть видны в receipt. Нет новой provider×extension матрицы или production scanner.
7. **Проверка и закрытие.** Сначала focused scripts TS/Host contracts и existing guard regressions только
   для реально изменившихся boundaries. Actual Desktop запускается обычным remote CI на exact HEAD;
   сохраняет install/skill journals, native inventory before/after, body witnesses, visible replies,
   same-namespace digest и cleanup. Required CI verifier не принимает отсутствующий consumption блок.
   07-E4/E5 закрываются только после native result; file mutation, успешный CLI exit и mocked catalog
   отдельно для этого недостаточны. Codex/V1 MCP inventory остаётся 07-E3, OpenCode V2 MCP — R9.

**R10 review 1 — parity.** Выбран actual native Launch profile вместо второго management-only namespace;
проверяются UI mutations, native body и следующий launch после uninstall, а не только installed list.
**R10 review 2 — упрощение и scope.** Сохранены NativeExtensionCoordinator/SkillCoordinator/P03 command
owners. Existing isolated negative suites остаются на месте; новый scenario добавляет только недостающую
связь mutation→new native Query. Любой найденный production mismatch сначала фиксируется точным source
ref и исправляется в существующем owner, а не обходится TEST profile или ручной metadata подстановкой.
**Независимый review:** уточнено различие same-namespace и нового runtime capture, а также происхождение
plugin body witness из original installed inventory. Эти уточнения внесены до implementation.

## R11 — Desktop acceptance выбранного MCP и appOnly

**Точный оставшийся gap R9 / 07-G3.** Native Linux receipt ещё не проверяет сохранение policy
настоящими controls. [M1] и [M2] на donor `4a0e062` совпадают с текущими файлами:
`inheritLead`, `inheritScopes`, `strictAllowlist`, `appOnly`, scopes и allowlist должны сохраниться.
В `captureRuntimeMcp.ts` lead использует общий catalog независимо от member policy; поэтому этот
сценарий проверяет настоящих teammates, а не назначает policy единственному lead.

1. **Один existing Launch variant, один запуск.** Добавить TEST flag к `native-launch-ui`,
   несовместимый с schedule/commands/extensions variants. Переиспользовать pinned V2 fixture
   и штатные seed/profile owners: один lead без external catalog, два teammates с одним исходным
   TEST catalog. Catalog содержит `TEST.selected` и `TEST.excluded`; исходные recipes и namespace
   фиксируются до spawn. Initial prompt оставить пустым через обычное поле Launch, чтобы lead
   не создавал inference. Metadata/probe requests учитывать отдельно от пяти ordinary model requests.
2. **Сохранить policy через UI.** В `LaunchTeamDialog` открыть MCP controls конкретных member rows.
   Первому выбрать `strictAllowlist`, user=true/project=false/local=false и вписать `TEST.selected`;
   второму выбрать `appOnly`. Проверить фактические значения controls, выполнить один Launch после
   штатного preflight, затем прочитать original captured roster/settings и сопоставить точным member IDs.
   Не применять policy через CDP API, JSON editor или правку durable files после запуска.
3. **Проверить native поведение.** Переиспользовать finite oracle и stdio actor из
   `tests/fixtures/native-opencode-v2-mcp/`: три запроса у selected member, два у appOnly.
   Через обычный Composer отправить каждому один исходный input. Selected inventory содержит только
   `TEST_selected_write_marker`; appOnly не содержит ни одного внешнего tool. Для manual permission
   нажать original Allow once, проверив отсутствие эффекта до ответа. Реальный actor создаёт один
   nonce-bound файл, его instance ID приходит в native result. Оба участника посылают реальный Team MCP
   reply; exact command/input/outbox receipts и видимый текст должны совпасть.
4. **Сохранить original scope и cleanup.** Oracle получает original captured principal каждого
   teammate через узкий callback; нынешние native-gate defaults не меняются. Actor на Darwin использует
   existing read-only `processFacts` для original birth identity; Linux startTicks proof сохраняется.
   Это наблюдение не даёт права сигналить процесс. Host остаётся единственным custody owner.
   `TEST.excluded` никогда не стартует, selected actor стартует и выполняет tool ровно один раз.
   После UI Stop все три Runtime sessions sealed/released, исходный actor физически отсутствует.
   Повторно открыть Launch и проверить сохранённые policy/scopes/allowlist, затем закрыть без запуска;
   original receipts и число model/effect events не меняются.
5. **Подключить существующий CI.** Один follow-up step в уже существующем
   `native-mixed-v2-create-launch-ui` job использует его Node/Bun/engine/custody preparation;
   отдельной matrix, runner, production API или новой protocol version нет. TEST helper содержит
   только этот journey; общие single-member Resume/11-request assertions не ослабляются.
   Source closure и receipt verifier требуют обе policy, пять requests, один once approval/effect,
   два Team replies, original input IDs и cleanup. Отсутствующий блок остаётся INCOMPLETE.
6. **Проверить перед закрытием.** Focused scripts/Host types, затем actual Desktop на exact HEAD.
   Не добавлять mapper unit suites, не увеличивать timers и не считать source review выполненным e2e.
   Найденный production mismatch сначала исправить в существующем capture/permission owner.
   Existing native R9 и остальные MCP modes остаются отдельными уже определёнными gates.

**Review 1 — parity.** Сохранены donor controls и per-member semantics, actual UI save связывается с
native tool/effect. **Review 2 — упрощение.** Два teammates в одном Launch заменяют два relaunch;
existing actor/oracle, Composer и Stop переиспользуются. Lead не получает external source и не
маскирует appOnly. Пункт 07-G3 остаётся открытым до успешного Desktop receipt.

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
[R6]: https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/services/opencode/OpenCodeManagedPreferences.ts
[R7]: https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/services/opencode/OpenCodeManagedDefaultSelection.ts
[S7]: https://github.com/777genius/agent-teams-ai/blob/6a2bb4b88bffbe001e16ff7fd27430f330b43517/src/features/runtime-provider-management/main/infrastructure/FileManagedProviderPreferences.ts

#### R10 повторный review связанного native/Desktop cut

Связанный сценарий использует прежние Install, Create/Review/Apply, Edit, Composer, Launch, Stop
и Uninstall. TEST inference проверяет фактический expanded body, аргументы и original Team reply;
source body не подставляется в product prompt. Cold startup перед первым Launch сохраняет четыре
исходных management receipts, а новый Query после Uninstall сохраняет user/project skills и уже
не предлагает удалённый plugin.

При независимом review сохранены прежние Resume checks и немедленное владение каждым новым
ChildProcess у caller. Обе cold границы получают явный secondCleanup. До первого Launch
проверяется отсутствие открытой Runtime session/input и inference; штатный краткий metadata
process не объявляется нарушением. После первого Quit группа должна быть физически пуста,
Host отсутствовать, writer lock освобождён до второго spawn.

Source review также исправил ошибку hash helper: namespace — объект, поэтому применяется
существующий canonical runtimeDigest, а не byte-only digest. Удалены дублирующие механизмы;
общий cold callback вынесен в существующий desktop-captured-app, уменьшая общий runner.
Source closure включает новые helpers и ранее добавленные Host cost/V2 MCP adapters.
Compile, настоящий UI/native запуск и exact-head CI остаются необходимыми gates.
