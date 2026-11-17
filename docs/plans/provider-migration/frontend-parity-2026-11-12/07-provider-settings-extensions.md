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

## R12 — исправить два выявленных V2 Desktop lifecycle несоответствия

Actual e2af run `43338183806`: Resume `131599600965` показывает единственную TEST-model,
но disabled с `Provider management outcome unavailable`; менять selector или обходить ready gate нельзя.
В `ProviderManagementCoordinator.catalog` status (`includeModels: true`) и directory (`{}`)
выбирают разные native catalog modes одного profile; concurrent request может закрыть child предыдущего
read. Active Quit `131599601058` отдельно наблюдает два metadata children после публикации global/project
sources, тогда как старый TEST witness требовал один. Source index обоих artifacts содержит эти два scopes.

1. **Согласовать reads у existing owner.** Последовательно выполнять весь V2 catalog участок
   matches → close/create → read для одного original profile, сохраняя независимость разных profiles.
   Завершить старый read до замены его child; следующий request повторно проверяет exact profile/revision
   и authority. Ошибка не отравляет последующие reads; seal/revocation остаётся немедленным и запрещает
   queued allocation. Это bounded in-memory sequencing существующего owner, без второго pool,
   scheduler, journal или повторного запроса после неизвестного результата.
2. **Сохранить deadlines.** Deadline фиксируется при приёме request, ожидание предыдущего read входит
   в него; native read получает только оставшийся срок. Истёкший queued request не стартует child.
   Не увеличивать Host/UI/CI timers и не возвращать stale catalog как fresh.
3. **Сначала подтвердить происхождение metadata children.** Два опубликованных global/project
   sources ещё не доказывают наличие двух независимых native owners: descriptor использует один
   management profile. Сопоставить оба original spawn/capture с catalog/model-probe ownership и
   проверить результат после исправления concurrent reads. Если второй child — неосвобождённый
   прежний owner, исправить его lifecycle; увеличивать expected count для принятия утечки нельзя.
   Только подтверждённый набор original birth identities допускается в hot/cold cleanup witness.
   Прежний mixed/passive fixture с одним owner сохраняет exact-one proof. Подготовленный TEST
   metadata cut удерживается до этой проверки; production catalog correction от него независим.
4. **Одна необходимая regression.** Расширить existing management recovery test overlap status/directory:
   завершение первого read предшествует close, оба результата относятся к исходному profile;
   rejected predecessor не запрещает следующий допустимый read, seal не выделяет новый child.
   Actual Desktop Resume/Quit продолжаются штатным CI; отсутствующий native результат остаётся открытым.

**Review 3 — ownership.** Root отклонил вывод «два source records → два процесса» без PID/owner
correlation. Catalog correction прошёл Host build, test types и4 focused Node24 checks, включая
seal во время awaited old-owner close. Actual Desktop E2E остаётся открытым.

**Review 4 — original source/child correlation.** TEST witness сначала выполняет существующий
read-only global loadModels(null), сохраняет единственный original child с birth identity и
реальный derived profileId из current RuntimeSourceIndex. После обычного project catalog/preflight
сохраняется тот же global child и ровно один новый project child; оба связаны с exact source revision.
Нет открытого Runtime, held probe или изменения прежних closed session records. Cold cleanup
проверяет каждый исходный child, а mixed/passive сохраняют прежний exact-one сценарий.

Root review отдельно исправил повторный baseline после Page.reload: обычный renderer reload
должен сохранить оба original owners, а новая global capture допустима только после настоящей
cold Resume границы. Platform independently проверил source/child и passive cleanup guards.
Эти TEST изменения прошли source review; fresh types, focused existing lifecycle checks и
actual UI/native results для нового cut ещё необходимы. Expected count сам по себе не proof.

**Review 5 — штатная смена metadata mode и точный lifecycle witness.** Actual a76 run
`43354049572`, Active Quit job `131651721320`, падает на сохранении global PID 6350:
после успешного project read присутствуют два children, но прежний global уже отсутствует.
`CapturedRuntimeProviderStatusClient.readOpenCodeRuntimeStatus` запрашивает directory `catalog({})`,
а `loadModels` — provider catalog; `ProviderManagementCoordinator.readV2Catalog` после завершения
старого read штатно закрывает несовпавший mode и создаёт следующий owner. Review 4 ошибочно
требовал бессменный PID. Production lifecycle ради этого TEST ожидания не меняем.

1. **Привязать наблюдение к original owner.** Existing global/project source projections сохраняют
   один seed cwd/environment; случайные catalog namespaces и private endpoint не входят в
   RuntimeSourceIndex. Поэтому cwd, число children, время появления или PID сами по себе не
   определяют owner. В existing `OpenCodeV2ManagementHost` наблюдать только catalog ready и итог
   original close: captured profile/config hash, закрытый directory/provider mode, hash provider
   selection, original nonce-checked ready PID/startIdentity. Ready не переснимается по PID;
   released означает уже подтверждённые `server.stopOwned()` и cleanup исходных namespaces.
   Credential command owners сюда не входят; ошибка диагностического sink не влияет на результат.
2. **Переиспользовать private diagnostic path.** Передать эти фиксированные bounded записи через
   существующие Host stderr framing, `decodeClaudeCloseDiagnostics`, `CapturedHostClient` и
   `logger.diagnostic` в existing `app-errors.ndjson`. Не добавлять RPC/public DTO, journal,
   owner, сигнализацию, произвольный error/config/auth payload или чтение secret stdin/proc args.
   Не повышать лимиты; максимум ready + один released/unknown на исходный catalog owner.
3. **TEST проверяет всю цепочку.** Связать profile hashes с exact derived global/project source
   records, а original ready — с captured Host и наблюдаемыми native birth facts. Сохранить
   прежние original identities: штатная замена допустима только после confirmed original release
   и физического отсутствия прежнего child; новый child обязан иметь собственный owner-ready
   witness того же captured scope/mode. Ни текущий selector, ни новый count не заменяют эту связь.
   На поздних UI/readback границах повторно проверять ту же накопленную цепочку; не создавать
   replacement baseline и не считать metadata child Runtime. Все unaccounted children, duplicate
   live owners, unknown close, source drift или missing evidence остаются failure.
4. **Сохранить существующие границы.** Passive/mixed one-owner сценарии сохраняют exact original
   birth/absence; ordinary renderer reload не создаёт новый Host baseline. Новый baseline разрешён
   только после actual cold Host boundary. Existing closed Runtime digest, no held model probe,
   zero metadata inference и original Runtime Stop/Quit cleanup остаются обязательными.
5. **Проверка без расширения suite.** Дополнить existing bounded diagnostic decoder regression
   проверкой original identity, finite stages, malformed/secret rejection и broken sink; existing
   Desktop lifecycle test — законной released→ready сменой и отказом при missing release/лишнем
   child. Затем actual прежние Active Quit, cold Resume и R11 UI gates на одном новом SHA.
   Таймеры, assertions готовности и production admission не ослаблять. До исполнения это source
   correction, а прежние Review 4 source checks не считать actual PASS.

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

#### R11 source review connected acceptance

Connected TEST cut использует existing native-launch-ui и один follow-up шаг existing mixed-V2 job.
Native oracle принимает пять ordinary requests и отдельные bounded no-tool probes; policy settings,
исходный actor birth/ancestor, единственный external effect и original Team replies связаны с receipts.
После Stop проверяются три released Runtime, отсутствие original actor и сохранённые source owners.

Root review нашёл гонку повторного preflight при readback. Сценарий теперь дожидается readiness
через существующий control, закрывает dialog, затем проверяет completed/cancelled original probes
с resourceHeld=false и неизменность всех закрытых Runtime, прежде чем фиксировать count/PASS.
Account independently reviewed final UI/oracle/cleanup. Types и actual native/Desktop run для этого
cut ещё не выполнены: unavailable local executor, CI remains required. Новых unit suites нет.

### R13 — V1 metadata endpoint после Save/Refresh: фактический регрессионный разбор

Actual `capturedManagement.safe-e2e.test.ts` на `1628b70e` завершает сохранение all-projects
default с `runtime-unhealthy`. Диагностика separate TEST native process подтвердила
`EADDRINUSE`: `RuntimeSourceIndex.managementProfile` создаёт отдельные profile/revision для
project/global и новой конфигурации, сохраняя seed endpoint; прежний metadata child ещё владеет
этим портом. Ошибка возникает в первом `readCatalog` до нового `model.probe`, а не в model
limit validation. Не менять ожидаемый saved view и не повышать таймауты.

Минимальный порядок исправления в существующем V1 owner:

1. В `ProviderManagementCoordinator` последовательно выполнять полную original V1 операцию
   на одном captured endpoint, включая завершение предыдущего read. Использовать тот же
   bounded promise-chain приём, что в existing V2 catalog read; V2 branch не менять.
2. Перед работой нового derived profile проверить исходные target/current/deadline заново,
   закрыть только прежний V1 host из existing owner map на этом endpoint и потребовать его
   confirmed cleanup. Никакого поиска процесса по порту/PID, shared-process kill, port guess,
   fallback/adoption или изменения captured account/config.
3. Existing `ManagementResourceFence` сохраняет запрет закрывать чужой active OAuth/probe
   между authorize и callback. Проверка допускается только для исходного command, которому
   принадлежит reservation; metadata read не получает право прервать его. Unknown cleanup
   оставляет исходный owner и блокирует замену. Cancel использует только свой captured host.
4. Ожидание очереди входит в прежний deadline; отмена/revocation до allocation не создаёт child.
   Ошибка предыдущей операции не отравляет всю очередь, но cleanup debt не теряется. Конструктор
   и captured profile сами по себе процесса не создают; новые store/owner/scheduler не нужны.
5. Переиспользовать actual IPC→Host→TEST process preferences scenario: global/project Save,
   наследование/default, V1 limits, cancel и shutdown должны пройти с теми же утверждениями.
   Добавить только узкую проверку overlapping metadata и чужой pending OAuth в existing
   management integration suite, если этот boundary не покрыт текущим case.
6. Отдельная stale oracle в `team-create-launch.test.ts`: после P05/P07 `foreign/TEST-open`
   — это structured `providerId=foreign` и `model=TEST-open` по
   `launchConfiguration.applyLaunchConfiguration` / `captureCreateTeamDraft`. Проверить обе
   части, тот же private account и нулевые Team/native effects; production mapping не менять.

Review 1: one-shot metadata close после каждого GET отклонён — он обрывает штатный shared
OAuth owner и создаёт лишние процессы. Выбран переход только между original owners на одном
endpoint с прежней authority/fence. Source fix, focused checks и actual результат ещё не выполнены.


### R12, review 6 — исходная native identity и durable redaction

Actual Desktop V2 на `f2050de7`, run `43367646201`, job `131695834199`
останавливается в `readEvents` на проверке `startIdentity`. Скачан официальный
active-Quit artifact `14012120872`, ZIP SHA256
`4f3ff4b6e4e1ce9e0d08f2e8ac243074c3d51f7fe9e81bfee1c019d1fb322848`.
Этот ZIP сохраняет failure/receipt, но не `userData/logs`; конкретные исходные байты
native identity из него не установлены.

Source diagnosis отдельно подтверждён детерминированным проходом настоящих producer,
Main decoder и persistent formatter: допустимый Darwin
`bootUUID:pid:pidVersion:birth` превращается в `[redacted]:pid:pidVersion:birth`.
`DarwinRegisteredProcess.readRootExecutable` создаёт исходную строку;
`createOpenCodeMetadataDiagnostic` и `decodeClaudeCloseDiagnostics` принимают её
без изменения. Далее `persistentAppLog.formatPersistentLogMessage` вызывает
`sentryConfig.redactSentryEvent`, который штатно скрывает UUID. Прежние constructed
`TEST-boot` cases не проходили через этот formatter и не проверяли данный boundary.
Ссылки относятся к точному [source f2050de7](https://github.com/777genius/agent-teams-ai/tree/f2050de7e2bf52feb695393cb4dc07d1c0ee8d9a).

Минимальное исправление:

1. Только в существующем `CapturedHostClient` metadata diagnostic callback построить
   закрытую durable projection: прежние owner/mode/provider/PID/stage/Host PID плюс
   `startIdentityHash = SHA256(UTF-8 exact decoded original startIdentity)`.
   Raw identity не передавать в общий logger. Host custody, stderr decoder и native
   equality не менять; не отключать redaction и не допускать `[redacted]` как identity.
2. В `desktop-opencode-metadata-lineage.ts` принимать ровно прежние поля с заменой
   `startIdentity` на обязательный hex64 `startIdentityHash`. Ready/close/successor
   по-прежнему связаны полным owner tuple; immutable prefix и запрет reused PID остаются.
   Hash всегда получается из captured original ready, а не из текущего UI/PID.
   Независимый OS census с parent/group/executable и неизменным `ps` birth сохраняется:
   native identity hash и physical birth — разные доказательства, одно не подменяет другое.
3. Расширить существующий critical subprocess/diagnostic case реальным проходом
   producer → Host stderr → Main decoder/callback → persistent formatter → proof reader.
   Проверить исходный UUID-format, одинаковый hash ready/confirmed-close, отказ при
   иной native identity/owner и при raw/redacted поле. Existing lifecycle case продолжает
   проверять original physical birth и retired absence. Новая suite/таймауты не нужны.
4. Выполнить focused tests/types/lint; exact-head existing Desktop V2 lanes остаются
   обязательной native приёмкой. Никакого вывода о product startup/Resume из исправления
   test-observation boundary.

Review 1: причина разделена на observed CI failure и воспроизводимый source-backed
redaction path; отсутствие raw artifact bytes явно сохранено. Review 2 (Account):
hash делать до logger из уже проверенного original observation, explicit fields,
без spread неизвестных полей; custody и redaction остаются прежними. Review 3 (Root):
полный native owner tuple и независимое physical birth evidence обязательны;
hash не даёт process authority и не допускает PID adoption. Source fix ещё не выполнен.


### R14 — measured V2 startup cost before changing read composition

Actual native Windows `f2050de7` receipt (job `131695720785`) reports original
`runtime.open` elapsed 127415ms against its unchanged 120000ms launch budget.
The original child became ready at 24962ms; native session creation completed near
98932ms; the plugins response reached headers at 125155ms. All 19 observed HTTP
requests reached successful response headers and no HTTP reset was recorded.
Headers do not prove complete body-read latency. The original cleanup remained
responsible for the same child; this is still an incomplete native journey.

Source evidence separates two candidates. `OpenCodeV2SessionCredential.prepare`
reads a catalog and, when its provider is absent, reads the directory again before
key import; selected-model attestation subsequently reads another catalog.
Independently, `EmbeddedMemberProvider.current` nests configuration and credential
source checks whose callbacks re-enter original Team/writer authority. A local
constructed TEST-source measurement through the actual capture functions and pinned
D client counted 20 outer authority callbacks for one current check, and 220 for a
single identity snapshot (11 current checks, one fake GET, two stub custody reads).
That test has no native child and a constant-true authority: it proves amplification,
not the time spent by the actual Windows owner or the cause of its timeout.

The next cut is measurement only, using the existing source native journey:

1. Add an explicit TEST-only CPU-profile option to `tests/fixtures/native-host.ts`
   for the original Host process. Use pinned Node24's standard `--cpu-prof`,
   default 1000us sampling, and an exact file in the existing private TEST root.
   Keep the same Host launch, captured profile, child ownership, request sequence,
   120s native budget and ordinary cleanup. No inspector listener/port, function
   replacement, process adoption, injected cache or extra inference.
2. Enable it only alongside the existing source-only
   `native-opencode-team/passive-diagnostics.ts` observation for the first actual
   Host epoch. Packaged runs and normal product launches stay unchanged. Correlate
   that epoch's totals with its existing original-open/HTTP/child timeline; distinguish
   inclusive stack time from exclusive sample time and never add overlapping totals.
   Do not infer per-request sample alignment from unrelated clock origins; the profile
   covers the first Host epoch and its normal cleanup, not an invented startup span.
3. After that original Host exits, read only its exact bounded regular profile file.
   Project an allowlisted category table for configuration reads, credential reads,
   Team/writer authority, custody/image checks, D transport, and other/idle.
   Retain only finite counts/durations and qualification status in the existing
   native JSON receipt. No raw source URLs, filesystem paths, function arguments,
   profile body or call stacks are uploaded. Discard the raw TEST profile after
   projection; absent/truncated/unparseable data is unavailable evidence, not zero
   work or successful startup. No new runner, workflow matrix or production protocol.
4. Check the projection with one actual pinned-Node finite profile and existing
   source/types gates. The next normal native CI run supplies platform attribution;
   do not rerun or relax it merely to obtain timing. Keep current command/control,
   abort/deadline/source checks and all image attestations byte-identical.
5. Only after these measurements identify the cost, propose the smallest correction
   in the existing read composition/guard call graph. No mutable freshness cache,
   guessed port, reduced cleanup proof, higher timeout or claim that grouping alone
   fixes startup. Existing native model/tool/MCP/Stop/cold Resume remains the gate.

Review 1: HTTP headers and inter-request gaps alone cannot attribute body processing,
source validation or custody cost. Review 2 (Account): credential `selected/read`
re-enters owner checks both before and after successful reads; missing files have a
different count, so no constant call count is imposed on native execution. Review 3
(Root): measure the same actual finite Host first; upload only the closed aggregate,
keep raw profiles private, and leave production checks unchanged until attribution.

#### R14 follow-up — различать отказ чтения профиля до вывода о CPU

Actual `522c80d168d698fc6842ee649cc4822406cd2632`, Darwin x64 job `131716085217`
завершился с original Host exit1 и `originalHostCpu.status=unavailable`,
`reason=file-unavailable`, `rawDiscarded=true`. Original open занял126906ms,
весь fixture142430ms; 15 HTTP responses успешны, model requests0. Это не CPU attribution и не доказательство
отсутствующего файла: current reader отдельно выдаёт `missing` для ENOENT, но
`file-unavailable` объединяет size/type, open/read и fd/path identity refusals.

1. В existing `native-opencode-team/passive-diagnostics.ts:readOriginalHostCpuProfile`
   разделить только закрытые причины: stat/shape, empty/over-limit, open/read,
   incomplete/changed-file, invalid profile и discard failure. При наличии stat
   сохранить только bounded числовой size fact: min(original size,16MiB+1) с явным
   признаком превышения, не выдавая clamp за точный размер. Ни paths, errors,
   stack frames, profile bytes или произвольные filesystem metadata в receipt не добавляются.
2. Сохранить прежний maximum16MiB, original regular-file/no-symlink/nlink check,
   fd/path identity до/после, exact original path и обязательное удаление raw.
   Oversized файл классифицировать до allocation/read; не увеличивать cap,
   sampling interval, native/cleanup budget и не переносить CPU profiling в product.
   `missing`, неполный profile и ошибка discard по-прежнему unavailable, не нулевые samples.
3. В existing `native-host-close.test.ts` один finite pinned-Node case использует
   тот же `startHost(...testCpuProfile:true)` и обычный `process.exit(1)` TEST child:
   исходный nonzero exit остаётся failure, его реальный профиль можно прочесть и удалить.
   В этом же bounded case проверить missing и empty/over-limit refusal без чтения
   oversized bytes; artifact содержит только закрытый result. Новая suite/runner не нужна.
4. Проверить types/lint и этот existing test; затем ждать следующий штатный native CI.
   Пока actual reason/sample attribution неизвестны, не менять read composition,
   freshness/custody checks или startup timeout по одной гипотезе.

Круг1: точный receipt/source различает `file-unavailable` и ENOENT. Круг2:
официальный Node24.21.0 `src/inspector_profiler.cc` (blob
`559b4fd27d56abed0a9aaa7981e10fe12ebb0c2a`) пишет результат через `WriteFileSync`
при завершении profiler. Локальный finite Node24.21.0 process.exit(1) действительно
создал7822-byte profile; existing projector вернул available и удалил raw. Это
подтверждение TEST exit1 path на Linux, не объяснение Darwin отказа. Круг3:
independent plan review/root commit+push перед source; R15 и production не меняются.

## R15 — cold V2 readback сохраняет подтверждённую metadata lineage

Факт: PR1186 head `522c80d168d698fc6842ee649cc4822406cd2632`, job
`131717484578` / run `43373956602`: native active-input Quit завершился PASS,
но второй app readback INCOMPLETE. Original artifact `14013109806`,
ZIP SHA256 `d7dd3e617499c752091a911d72431935be71bc38f14a5f1aeff9a6aaadc55065`.
Cold helper сохранил metadata child7327; поздний UI census уже не нашёл его.
Смена metadata mode — объяснение из текущего source, требующее actual lineage evidence;
legacy passive check требовал вечного существования прежнего PID. Нельзя
исправлять это принятием произвольного нового child или удалением проверки.

1. После **того же единственного** existing cold loadModels получить actual selected
   global source/profile из existing runtime-source index и наблюдать его через
   уже реализованный `captureMetadataObservation/readDesktopMetadataLineage`.
   Выделить лишь маленький read-only wrapper в existing desktop-native-stop-fixture.
   Не повторять catalog RPC и не создавать новую native operation.
2. Cold assertNoRuntimeChildren обновляет captured observation по exact Host birth,
   прежним profile hashes и непрерывной original lineage. Successor допустим только
   после exact previous ready→released и physical absence прежнего PID, с собственной
   подтверждённой birth; unknown cleanup/foreign profile/PID reuse отказываются.
   Existing Runtime records, source/profile/executable digests остаются неизменными,
   zero Runtime allocation и один active metadata owner сохраняются.
3. В cold evidence сохранить original capture и latest validated readback capture.
   Ordinary Quit затем должен подтвердить release **всех** исходных и successor
   metadata identities из этой lineage, до harness cleanup. Применить existing
   bounded log-drain/absence machinery к cold metadata branch; hot paths сохраняются.
4. Расширить existing V2 lifecycle case именно cold transition/cleanup:
   confirmed retired original + exact successor допускаются; missing release,
   чужой active child, reused PID или оставшийся successor после Quit отказываются.
   Это проверка correlation; actual пяти cold Desktop jobs остаётся отдельным gate.
   Не увеличивать timeouts, не повторять native input/metadata calls ради PASS.

Source-круг нашёл несовпадение old passive cold path с уже production-supported
global/provider metadata handoff. Второй круг сохраняет original-owner proof,
zero-runtime invariant и cleanup всех поколений. Следующий шаг — independent
diff review, existing scripts types/tests и штатный exact-head Desktop CI.


## R16 — первый OpenCode status привязан к уже захваченному configuration target

**План до source, база документа `4900526b4043ce159f57125da0ae36cfe16e9264`.**
Actual Review на `522c80d168d698fc6842ee649cc4822406cd2632`, job `131717484574`,
artifact `14013479408`: обычный `openCodeRuntime:getStatus` записал
`Native runtime selection changed`; global и project configuration publications присутствуют,
seed `embedded.configurationSource` отсутствует. Один отдельный no-tool Team probe завершён,
business inputs0. Позже Review остановился на expected2 metadata scopes / actual1.
Артефакт сохранил только первоначальный global ready child6322 под Host6040;
private metadata NDJSON и последующих closed events в нём нет. Эти два отказа
нельзя объявлять одной доказанной причиной.

### A. Устранить несовместимые snapshots в существующем status read

Source-цепочка конкретна: `CapturedRuntimeProviderStatusClient.ts:167–182`
читает `sources.current()` до `deps.capture(null)`.
`DesktopBackendFeature.captureCurrentManagementTarget:708–716` внутри capture
вызывает `refreshCapturedRuntimeConfiguration`; этот existing helper при первом
V2 configuration capture может законно опубликовать новый source revision и вернуть
derived management profile. Сравнение старого seed snapshot с этим новым target
даёт ложный отказ собственного первого чтения. Старый frontend определял выбранный
runtime и показывал status; штатная фиксация его configuration не должна сама
делать это чтение устаревшим.

1. Сохранить original `captureGuard` и захваченный `sources` handle. В том же
   `readOpenCodeRuntimeStatus` сначала дождаться `deps.capture(null)`, и только
   затем получить `selection = sources?.current()`. Это перестановка existing
   read относительно разрешённой initial configuration publication, не retry.
2. Запросить тот же единственный `target.request('catalog', {})`. Сохранить
   unchanged final `target.isCurrent()/current()`, exact profileId/configRevision,
   native generation и повторный `sources.current().revision` guard.
   Другая publication после capture, смена context/owner или unknown остаются отказом;
   текущая UI selection не заменяет исходный target. V1 CLI/null fallback и V2
   engine/installed-source DTO не меняются. Число capture/current/catalog calls прежнее.
3. Расширить existing `capturedRuntimeStatus.test.ts` case о current source:
   controlled first configuration publication происходит внутри original capture;
   один status read возвращает ready для именно этой derived selection.
   Затем existing concurrent-source-change case по-прежнему обязан отказать.
   Проверить counts для одного capture/catalog и прежних двух current reads.
   Existing foreground-revocation cases сохранить; новой unit suite не создавать.
4. Проверить focused Main types и этот existing test file. Actual штатный Desktop CI
   должен заново проверить first status и исходные Launch/Review пути; локальный
   controlled case не доказывает native execution и не закрывает expected2/actual1.

### B. Сохранить закрытые факты исходного metadata отказа

Для отдельного Review1!=2 недостаёт causal evidence. Не добавлять catalog reads,
не ослаблять live-owner count и не выгружать private unfiltered app logs.

1. В existing `readDesktopMetadataLineage` сохранить только уже прочитанные и
   schema-validated closed events из **того же** log read, если последующая lineage
   validation бросила ошибку. Малый private WeakMap связывает исходный Error с
   конечной diagnostic projection: original Host PID, expected profile hashes,
   максимум128 closed lifecycle events и только встреченные в этом же existing
   physical census PID из этих events. Никаких argv/env/command paths, raw log lines,
   произвольных error objects или новых authority records.
2. Прежняя ошибка, strict validation и bounded observation deadline сохраняются.
   Existing `desktop-backend-smoke.ts` catch добавляет projection в failure receipt,
   только если она присутствует у именно этой ошибки. Никаких повторных log/OS reads,
   изменения exception outcome или adoption/replay после отказа. Ошибка чтения
   до validated events не получает выдуманную пустую lineage.
3. В existing lifecycle test case проверить actual private TEST log framing:
   один validated active scope при expected2 по-прежнему бросает исходную ошибку,
   а projection точно содержит исходные closed events; successful cleanup этим
   не доказывается. Достаточно одной critical existing-case проверки и scripts types.
4. Следующий штатный exact-source Review run позволит различить отсутствие project
   ready, подтверждённый release, незавершённый mode handoff и unknown cleanup.
   Только его факты определят дальнейший product/test fix. R15 cold source,
   source/profile identity и native operation budgets остаются прежними.

**Круг1:** совместно сверены actual artifact и точные current source callbacks:
собственная first configuration publication действительно находится между двумя
несогласованными snapshots. **Круг2 (Profiles):** минимально переносится только
selection read после target capture; final revision/foreground guards и original
sources handle сохраняются. **Круг3:** root/independent plan review и немедленный
commit+push перед source; A и diagnostic B не подменяют native acceptance.

### R14/R15 source evidence перед R16

R14 closed file classification и R15 cold lineage опубликованы в parity commit
`a2f327c8b07142a2ec857a5be6e0924c84f0fcef`. R15 four-file diff независимо проверен
Profiles и root; R14 two-file diff — Account и root. Root24 existing UI/lifecycle
cases (включая11 cold lineage) и4 finite Node24 sampler/close cases — PASS;
scripts/Host test types, fast lint и source cap — PASS. Native failure reason,
all cold Desktop flows и отдельный Review2-owner результат ещё требуют actual CI.
R16 A/B root design review — PASS: exact original handles/guards и прежние budgets сохранены.

### R16 A/B implementation evidence

Five-file cut основан на parity `a2f327c8b07142a2ec857a5be6e0924c84f0fcef`.
A переносит единственный selection read после original target capture; final
profile/revision/generation/foreground guards и counts остаются прежними.
B связывает immutable closed metadata projection только с original validation Error
после того же parsed log read; malformed/unvalidated logs projection не получают.
Ожидаемые два metadata owner, original exception и native calls не изменены.

Existing first-publication case сначала воспроизвёл отказ (15 PASS / 1 FAIL),
после correction весь existing file16/16 PASS. Existing lifecycle file11/11 PASS.
Profiles и root source review — PASS; root повторил эти27 cases на coherent a2 base.
Focused Main types, scripts types, fast lint (0 errors, 2 прежних warnings) и
source-size cap — PASS. Новая unit suite не добавлялась.
Actual first-status/Desktop acceptance и отдельная причина Review expected2/actual1
остаются pending штатного exact-head CI; diagnostic projection не означает fix
неустановленной metadata причины.


## R17 — actual profile-over-limit: достаточная CPU детализация в прежнем размере

Exact parity `3db75ad8b323bede28d92c99c6d8eb1defb50f1b`, run
[43386942824](https://github.com/777genius/agent-teams-ai/actions/runs/43386942824):
Darwin x64 job131757593612 и Windows ARM64 job131757593845 завершают original open
за125133/131063ms при unchanged120000ms budget, без model requests и с unresolved
cleanup. Darwin ARM64 job131757593960 доходит до allocated/nativeReady, но bootstrap
занимает159746ms, затем первый input не достигает модели; ordinary cleanup там
подтверждён. Все три actual receipts дают `originalHostCpu.reason=profile-over-limit`,
bounded lower size16777217 и `rawDiscarded=true`. Теперь конкретная причина
недоступности профиля установлена; CPU attribution всё ещё отсутствует.

### Круг1 — минимальная корректировка именно измерения

R14 follow-up запрещал менять sampling до выяснения причины чтения. После этих
actual facts следующий срез явно заменяет **только** его default1000us sampling
на фиксированный10000us (10ms) в исходном TEST Host. Официальный
[Node24.21.0 CLI](https://github.com/nodejs/node/blob/v24.21.0/doc/api/cli.md)
поддерживает `--cpu-prof-interval` в microseconds. Наш вопрос — стоимость
многосекундных фаз и повторных source checks; субмиллисекундная детализация для
этого не требуется. Меньшая частота уменьшает ожидаемое число samples/stack nodes,
но успешное размещение профиля в лимит заранее не гарантируется.

- В existing `tests/fixtures/native-host.ts` explicit first-Host CPU option
  добавляет ровно `--cpu-prof-interval=10000`; вернуть configured interval рядом
  с original profile path. Default product Host и native child не получают flag.
- Existing `readOriginalHostCpuProfile` принимает captured configured interval;
  closed receipt называет его `samplingIntervalUs`, а не ложно оставляет
  `defaultIntervalUs:1000`. Existing legacy caller может явно сохранить1000;
  exact new native caller передаёт interval исходного ChildProcess fixture.
  Фактические sampled durations по-прежнему берутся из original V8 timeDeltas,
  не умножаются на configured interval и не получают выдуманной точности.
- Maximum16MiB, nofollow/regular/nlink, fd/path identity, original-exited check,
  exact path, raw discard и unavailable outcomes остаются прежними. Никаких
  чтений слишком большого файла, raw uploads или расширения maximum nodes/samples.

### Круг2 — смысл native сценария сохраняется

Original request sequence, provider source/config/image checks, native120s и
обычный cleanup не меняются. Не добавлять кэш, искусственное serial wait,
новый runner, повтор промпта либо повтор failed run. Это менее тяжёлая
диагностика в следующем необходимом exact-head preflight, а не performance fix.
На Windows/Darwin/Linux сохраняются отдельные actual receipts. Старые timings
с1000us sampler не объявляются равными timings нового10000us sampler.

### Круг3 — приёмка и следующий вывод

Расширить существующий finite exit1 sampler case в `native-host-close.test.ts`:
original Node получает explicit interval10000, generated profile читается,
closed projection указывает именно его, исходный exit1 не превращается в success,
raw удаляется. Existing missing/empty/over-limit и privacy assertions сохраняются;
новая unit suite не нужна. Source review и focused Host test types обязательны;
executor сейчас недоступен, поэтому ни source review, ни immutable blob readback
не выдаются за executed test.

После actual native результата использовать категории R14 с оговоркой про
sampling/перекрывающиеся inclusive stacks. Если профиль снова unavailable,
не выводить причину задержки по одним HTTP headers. При usable profile выбрать
минимальный product read-composition fix с сохранением проверок свежести и
физического owner, затем повторно пройти original native tools/MCP/approval/
Stop/cold Resume. До этого startup parity остаётся открыта.

Self-review: повышается только шаг диагностического sampling, не admission limit,
timeout или допустимый размер. Native failures и отсутствие attribution показаны
явно; source ещё не менялся.


## R18 — actual seal during catalog disposal: точный AbortError oracle

Qualification head `7563eb067b9196ca416a56228f9c7e38a2455a17`,
[run43377998027](https://github.com/777genius/agent-teams-ai/actions/runs/43377998027),
job131741574610: existing `hostOpenCodeV2EmbeddedMember.test.ts`240–261 ожидает
generic `OpenCode V2 embedded session unavailable`, но original pending catalog
read после provider.seal() возвращает AbortError. Exact source/test на current3db
совпадает с old64; это не доказательство потери cleanup или доступа к attachment.

**Круг1 — source contract.** `OpenCodeV2EmbeddedMemberProvider` captureClient
связывает wire signal с original private abort; seal вызывает abort().
Existing `OpenCodeV2ReadOnlySnapshot.check`35 сначала делает
`signal.throwIfAborted()`, после client.dispose повторно attest/check.
Следовательно исходный abort обязан завершить pending read до original byte
resolver. Сохранить этот порядок: не заменять production abort на generic error
и не ослаблять current-owner/disposal checks.

**Круг2 — самый узкий TEST diff.** В том же held-disposal case заменить только
message matcher на exact structured `{ name: 'AbortError' }`. Оставить actual
barrier entered → original provider.seal → release, rejection, resolver never
called и cleanup===true. Соседний original callback failure + rejected disposal
по-прежнему требует UNKNOWN и exact cause; text-only capability case не менять.
Новый harness, timer, provider input или native request не нужны.

**Круг3 — приёмка.** Independent diff review, existing focused test/types, затем
прежний Main CI job на опубликованном source. Source review и GitHub blob equality
не подменяют execution: executor сейчас недоступен. Это correction oracle, не
новый product lifecycle fix и не закрытие pending V2 startup/native acceptance.


## R19 — убрать транзитивно повторённые V2 current checks

### Actual evidence и предел вывода

Exact parity `235b01b489a4f428b72c7667b0c89061c82cab1b`: Windows x64 —
`104540586 / 130556486 us` в nearest exclusive категории `team-writer` /
всего sampled Host; Darwin x64 — `96.57 / 131.62 s`. Model requests0.
Это sampled Host stacks с interval10ms из R17, не точная стоимость отдельной
функции, Bun CPU или HTTP. Размер будущего ускорения пока неизвестен.

Source цепь: `OpenCodeV2EmbeddedMemberProvider.ts:49–59` →
`OpenCodeV2CapturedConfiguration.ts:88–89` →
`OpenCodeV2SessionCredential.ts:24–27` →
`OpenCodeV2CredentialScope.ts:61–71,117–142`.
Исходный callback повторно проверяет captured member/Team writer и original
grant/fences; `TeamOwnerStore.fenced` синхронно проверяет свой namespace.
`RuntimeSourceIndex` в этой обычной цепи после capture не вызывается.
Source index и сам Team writer/fence этот срез не меняет.

### Круг1 — три замены в двух существующих файлах

1. `OpenCodeV2EmbeddedMemberProvider:57–58`: передать credential capture
   `configuration.isCurrent` вместо wrapper
   `() => contextCurrent() && configuration.isCurrent()`.
   Configuration уже проверяет именно исходный `contextCurrent`.
2. Там же aggregate `current:59` взять из `credential.isCurrent`, убрав
   дублирующие `contextCurrent() && configuration.isCurrent()`.
   Credential захватывает original configuration callback до allocation.
3. `OpenCodeV2SessionCredential:26`: использовать `captured.isCurrent`
   вместо `() => isCurrent() && captured.isCurrent()`.
   Его primary read всегда начинается с `check()` → original owner callback,
   включая отсутствующий auth.json; after-read checks остаются прежними.

Статический пример: unbound configuration source без explicit config key,
существующий primary auth и отсутствующий alternate auth дают20→9 original
owner вызовов внутри aggregate current. Это расчёт по коду, не measured counter;
другие наборы файлов/ключей дают другие числа. Тест с assertion этого числа
и обещание пропорционального ускорения не нужны.

### Круг2 — original authority и ключи сохраняются

Никакого сохранённого результата, TTL, microtask cache или переноса результата
через await. Каждый current заново читает original auth/config и вызывает
original authority; все существующие checks до/после await остаются на месте.
Seal/abort/deadline/canAllocate, native nonce/PID/birth/image, read-only snapshot
final proof и проверки native mutations не меняются.

`OpenCodeV2CapturedConfiguration` не редактируется. Explicit config key
по-прежнему захватывается original credential scope, обязан совпасть с original
auth key и перепроверяется через `key.isCurrent()`, включая его owner callback.
Config/native key conflict, alternate V1 auth, file/namespace identity и digest
guards сохраняются. `bindRunningSession()` продолжает снимать только source
freshness для running A; owner/key остаются current. Новый source относится
к следующему capture. Cleanup-unknown не становится успехом.

### Круг3 — critical cases и actual native gate

Расширить existing cases без новой unit suite:

- `hostOpenCodeV2EmbeddedMember.test.ts`: original pending read/dispose barrier,
  затем owner revocation либо actual auth source mutation; after-await refusal,
  attachment resolver не вызван, original cleanup сохранён. Existing seal
  AbortError и callback failure + failed disposal остаются точными.
- `opencode-v2-credential-scope.test.ts` / existing configuration-source case:
  actual TEST files и transitive session/config current, включая absent→present
  auth, explicit config key match/conflict и revocation. Original scope не
  заменяется mock, всегда возвращающим true.

Independent review прослеживает все три private closures и explicit-key ветку.
Затем focused existing tests и Host/Main types. Executor сейчас недоступен:
immutable readback/source review не являются execution.

Следующий необходимый exact-head native preflight сохраняет original120000ms,
внутренние deadlines, request/input limits, custody и cleanup. Сопоставить
R14/R17 sampled evidence и actual model/tool/MCP/approval/Stop/cold Resume.
До успешного native результата startup gap открыт; достаточность трёх замен
для прохождения CI заранее не утверждается.

### R19, дополнительный круг — тот же predicate в finite model probe

Actual235 mixed Desktop job131780548934 после original Bob Restart → whole
Stop → renderer reload принял новый OpenCode model check. В original
management row3958a684… остаются `phase=running/resourceHeld=true`, model
`TEST-model`; commandId `team-preflight-2bbd40ae…` точно воспроизводится из
сохранённых handle + текущих launch/rosterRevision + Carol + qualified model.
Claude/Codex/OpenCode probes перед cleanup равны8/1/1, failures пусты.
Это исключает отказ Resume до model admission, но не устанавливает, где
внутри native startup/cleanup остановился probe. CPU этого check не измерялся.

**Круг1 — доказательство по исходным closures.**
`OpenCodeV2ModelProbe.ts:112–116` захватывает configuration с original
`contextCurrent`, затем передаёт в SessionCredential повторный
`contextCurrent && configuration.isCurrent` и ещё раз повторяет оба в current.
Configuration.isCurrent всегда начинает с того же owner callback; explicit
config-key scope и source freshness проверяются далее. CredentialScope.selected
всегда начинает primary read с check → сохранённый configuration callback,
включая missing auth/parent directory. SessionCredential R19 использует этот
captured.isCurrent. Поэтому credential current транзитивно содержит оба
удаляемых условия, original directory identities и closed/abort guards.

**Круг2 — две замены в одном существующем provider файле.**
Передать `configuration.isCurrent` напрямую в SessionCredential и использовать
`credential.isCurrent` как aggregate current. Других substitutions не делать.
Model probe не вызывает bindRunningSession: source freshness остаётся
обязательной весь finite check. Original config-key equality/conflict и
alternate auth checks неизменны; никакого cache, TTL или переноса результата
через await. Assert до/после каждого await, beforeRequest custody lease,
readPassword, canAllocate, original90s model timeout и cleanup не меняются.
Это устранение повторной композиции, не измеренный performance результат
и не доказательство исправления observed mixed failure.

**Круг3 — существующая критичная проверка.**
В `opencode-v2-model-probe.test.ts` расширить existing effect-free/revoked-run
case: owner revoke, actual absent→present auth и original configuration mutation
между capture и run должны отказать до создания probe namespace; same run Promise,
no replay и original idempotent close сохранить. Проверить отсутствие namespace
до close, чтобы cleanup не скрыл попытку allocation. Existing configuration/
credential tests R19 и sealed/dispose cases переиспользовать, без нового sampler
или suite. Independent closure review, focused Node24 tests и types; следующий
необходимый exact-head native/mixed gate с прежними budgets остаётся обязательным.


## R20 — exact-head native results and the TEST source-response classifier

### Observed d35 evidence

The unchanged Linux `opencode-v2-embedded-host.native.ts` on parity
`d35ef8256a9f24294b2fe50e8290ccb9841d9eb1` completed all six original
phases with11 model requests, no model failures and original cleanup confirmed.
Receipt SHA256 `cb38773c51b4e18f6ab26328d17c3f38d6770ef1b4cc400d6e1246ca5f786d20`.
This is Linux source/native evidence, not a Windows/macOS or packaged acceptance.

The separate original model-probe case failed before native allocation or
inference: `native-host.ts:297` applied the Runtime session DTO allowlist to
`runtime.source.current`. Its expected source-summary keys are deliberately
different. The original failure remains INCOMPLETE; zero native processes,
zero model requests, Host exit0 and cleanup confirmed. No timeout is involved.

The d35 CI Windows ARM64 and Darwin ARM64 embedded cases are also INCOMPLETE:
the former reached no model request; the latter reached four and then the
original terminal deadline. Their nearest exclusive team-writer CPU samples
remain98.328s and99.453s respectively. R19 alone therefore does not close the
cross-platform startup/performance gap. No bound or cleanup requirement changes.

### Round1 — distinguish the existing private source family

In existing `tests/fixtures/native-host.ts`, handle the six registered
`runtime.source.*` names before the existing session projection assertion.
Use the existing strict `runtimeSourceSummarySchema` for current, its array
for retained, and `runtimeSourcePublicationSchema` for publish and refreshConfiguration.
Lookup and recover may return null; recover has no unfinished publication in
that valid case. An unrecognised source
method must fail. Keep the explicit no-Bearer response assertion.

This is TEST response classification only. Do not expand the session DTO
allowlist, change production RPCs, expose paths/credentials, or replace native
model probing with a mock. The schemas come from the exact source contracts
that the original Host registers in `createRuntimeSourceMethods.ts`.

### Round2 — minimum source and independent review

One existing fixture file, no new module or unit suite. Review all six action
return types in `RuntimeSourceIndex`, including nullable lookup/recover and strict
nested selection. Existing session/activity/checkpoint assertions remain
unchanged. A peer verifies the finite classifier before source execution.

### Round3 — original acceptance, unchanged budgets

Run Host TEST types and existing member projection negative cases. Then run
the same native model-probe case once on the corrected source using already
verified pinned runtime/engine/Bun inputs. Preserve its request limits,
configuration A-to-B checks, ordinary final cleanup and immutable input
receipts. Any later native failure is recorded and investigated separately.
The actual Windows/macOS writer-cost issue needs its own source-backed plan
and exact native proof; it is not declared solved by this fixture correction.


## R21 — bounded synchronous credential/configuration reads

### Round1 — remaining cost and original ownership

Actual d35 Windows/Darwin embedded receipts still spend most sampled Host time
inside the original Team writer authority (R20); R19 is insufficient. Every
credential-current check calls selected(), which reads the primary auth file
and the alternate conflict source synchronously. Each private read currently
re-enters the full owner callback before/after its own file. The callback then
rechecks captured configuration, which independently repeats that same owner
ahead of source/key predicates that already include it.

No cache or retained proof is proposed. The owner and immutable config/auth
sources must still be read afresh on every call, with all checks around awaits
and native effects unchanged. TeamOwnerStore, Team grants/roster/launch readers,
writer locks and current member binding semantics are outside this slice.

### Round2 — two existing files, one synchronous operation boundary

1. In `OpenCodeV2CredentialScope`, separate the existing root identity checks
   from the original owner callback. Private read keeps root checks at its
   existing before/after points plus every FD/type/path/digest check unchanged.
   selected() checks owner and roots before its first source read and after
   both primary/alternate reads and validation, before returning any key/digest.
   There is no await, callback exposed to callers, mutation or native effect
   between these boundary checks. An early missing-file return is still inside
   the selected boundary. providerIds(), the only other read caller, gets the
   same explicit owner+root checks before/after its one read. Constructor/write/
   publication/rollback guards remain, and no private unguarded read is exported.
2. In `OpenCodeV2CapturedConfiguration.isCurrent`, evaluate an existing key
   predicate when present. For an unbound captured source use source.isCurrent,
   which checks this exact original owner before/after its synchronous reads.
   Otherwise a present key already includes that owner; if neither source nor
   key supplies it, call ownerCurrent directly. Thus all key/source predicates
   still run as required, without a separate duplicate leading owner callback.
   A bound running session keeps key+owner checks; only its documented config
   freshness exemption remains. Finite model probes never bind.

Unlike a per-tick/TTL/microtask cache, the result is not reusable by another call.
These checks delimit one synchronous read operation; its filesystem identity
checks remain per file. Do not move/remove the after-read boundary, any await
guard, explicit key conflict, alternate-auth conflict, signal/deadline,
canAllocate, custody check, permission policy or cleanup-unknown handling.

### Round3 — independent proof and minimum regression coverage

Peer review follows every caller of the now identity-only private read and
all four source/key/bound combinations. Reuse existing credential-scope,
configuration-source, V2 model-probe and Main embedded-member cases for owner
revocation, auth missing-to-present, root replacement, config-key conflict,
bound running A versus next captured B, after-await revocation and failed cleanup.
Extend only an existing critical case if providerIds after revocation lacks
coverage; no call-count assertion, new suite or synthetic performance promise.

After Host/Main targeted types and these existing cases, run the unchanged
Linux full native and model-probe cases from a pushed clean source commit.
Cross-platform exact-head CI keeps the original120s/native deadlines and all
model/tool/MCP/approval/Stop/cold checks. Source simplification or local PASS
alone does not close the Windows/macOS gap; preserve original failed receipts.


## R22 — model selection guard без неиспользуемой Runtime projection

### Круг 1 — исходный факт и граница причинного вывода

Actual mixed V1 job `131818772113` сохраняет новый original OpenCode
`team-preflight-d4bad0c185b279709abd8deea9035ae667fbe72d56c48de6eecd836813381a2d`
как running/resourceHeld при отсутствии нового Claude model request.
Закрытый TEST diagnostic в логе появился в `10:06:18.883971Z` с
baseline8/observed8; original row expiresAt=`1794564380563`
(`10:06:20.563Z`). Следовательно, запись ещё не просрочена в момент
diagnostic; из running нельзя вывести сломанный timer или бесконечную работу.
V2 job `131818772401` также не увидел нового Claude probe. Эти факты не
устанавливают стоимость конкретного Host callback или native phase.

Независимый source audit на `d35ef8256a9f24294b2fe50e8290ccb9841d9eb1`
обнаружил более узкую, доказуемую лишнюю работу:

- [captureTeamModelProbe](https://github.com/777genius/agent-teams-ai/blob/d35ef8256a9f24294b2fe50e8290ccb9841d9eb1/packages/legacy-agent-host/src/composition/teamLaunchModelProbe.ts)
  в assertSelection читает `launch.read(action)`, затем использует только
  launchId, rosterRevision и membership по memberId. Attempt status, readiness,
  custody, timestamps, admission summary и native context этому guard не нужны.
- [TeamLaunchOwner.read/project/summary](https://github.com/777genius/agent-teams-ai/blob/d35ef8256a9f24294b2fe50e8290ccb9841d9eb1/packages/legacy-agent-host/src/team-launch/TeamLaunchOwner.ts)
  сначала делает тот же authorized/load/validation, затем project читает Runtime
  каждого claimed member. Project меняет только attempt observation fields;
  эти три selection поля остаются исходными. Ошибка Runtime observation ловится
  и превращается в attempt unknown, который model guard всё равно не читает.
- [createRuntimeTeamLaunch](https://github.com/777genius/agent-teams-ai/blob/d35ef8256a9f24294b2fe50e8290ccb9841d9eb1/packages/legacy-agent-host/src/composition/createRuntimeTeamLaunch.ts)
  связывает этот callback с readSession и текущими provider evidence getters.
  [RuntimeOwner.readSession](https://github.com/777genius/agent-teams-ai/blob/d35ef8256a9f24294b2fe50e8290ccb9841d9eb1/packages/legacy-agent-host/src/runtime/RuntimeOwner.ts)
  читает original transaction под Runtime fence; он не открывает, не останавливает,
  не dispatch-ит и не восстанавливает native session. RuntimeActivityCoordinator
  добавляет публикацию только в put, которого здесь нет.
  Team authorization внутри read повторно валидирует Team state/retained bindings.
  Ordinary roster recovery исходного Team уже сохраняется в неизменном
  authorized callback нового selection read; отдельного native recovery effect
  из project не теряем.

После Stop попытки остаются claimed: projection продолжает обходить released
Runtime records. Это source-backed amplification, не measured объяснение90s.
Для уже admitted capture prospective saved-model branch не становится
разрешённым: isUnstartedCaptureEditable проверяет original admission. Его
полную history/custody проверку этим изменением не трогаем.

### Круг 2 — минимальный внутренний read

1. Добавить в существующий TeamLaunchOwner один явно названный composition-only
   `readModelProbeSelection(action)`. Под **тем же** options.authorized(action)
   вызвать **тот же** private load, сохраняющий full fingerprint, expected roster,
   native additions, restore/resume/preparation/retry и current attempt validation.
   Вернуть новый закрытый object только с launchId, rosterRevision и ordered
   memberIds из тех же record fields, что использует public summary.
   Никаких Runtime observations, cache, retained proof, нового журнала или RPC.
2. Только assertSelection в captureTeamModelProbe использовать этот read;
   прежние action start→control, read/cancel→read, cancellation branch,
   original owner/lease/current capture, member Runtime control authority
   для non-draft, source/recipe/config digest и operator/member revision comparisons
   остаются на тех же местах. Все before/after-await и native-effect проверки
   остаются. Новый read не отвечает на вопросы readiness, release или canWork.
3. Полный public launch.read, readOriginalStart, refresh, DTO, UI status,
   настоящие Runtime reads и все start/Stop/retry/Resume/cleanup пути неизменны.
   Поиск existing equivalent завершён: readRestorations не содержит selection;
   memberActions.read требует существующий member и только read authority,
   поэтому не заменяет start/control и fresh-draft-member cases.
   Не добавлять optional boolean, меняющий значение общего public read.

### Круг 3 — независимый review и один существующий critical case

До source — root publication этого append. Peer сверяет три project-invariant
поля и все ошибки load/authorization, а также отсутствие нужного recovery/effect
в удаляемом observation обходе. Source scope: TeamLaunchOwner.ts,
teamLaunchModelProbe.ts и один existing Team launch case.

Расширить существующий authorization/corrupt-roster case в
`packages/legacy-agent-host/tests/team-launch.test.ts`: настоящий controlled
Launch с claimed members, затем original observation unavailable; selection
остаётся exact без обращения к Runtime observation, public read всё ещё
показывает unknown. Использовать existing controlled read callback как
tripwire/census, не подменять production guards. Revoked grant и corrupt
original launch по-прежнему отказывают; original bytes и native open/input
counts не меняются от selection inspection. Это один meaningful case,
не новая suite и не timing/call-count benchmark производительности.

Нужны Host build/test types, existing team-launch/model-probe/saved-probe
cases, lint/source caps. После этого обычные mixed V1/V2 Desktop и native
model-probe gates на exact coherent head проверяют результат с прежними
90s/native deadlines, model request counts и cleanup obligations.
До actual gates не объявлять timeout устранённым, не менять budgets,
не ослаблять source/actor/custody и не нормализовать original failed receipts.

**R1:** проверены actual expiry и неиспользуемые project fields; отсутствие
sampled mixed CPU данных сохранено явно. **R2:** прочитаны authorized/load,
full launch validator, Runtime read transaction и existing read alternatives;
guard не зависел от project status даже при observation refusal.
**R3:** независимый plan/source review и execution ещё требуются; среда
недоступна, новые source bytes пока не созданы.

## 23. R23: исходные current closures metadata-owner без повторных conjuncts

### Круг 1 — actual evidence и точная граница вывода

На exact `9ea802cc0f8c873c8349512cb010fe54e34fdd70` native V2 Linux
job `131868949378` прошёл полный Session с 11 model requests, оригинальным
cleanup и cold Resume. Отдельный model-probe затем завершил три реальные
no-tool запроса, cancellation и отказ неизвестного variant, но
`opencode-v2-model-probe.native.ts:352` получил `{ok:false,code:'held'}`
на последующем `management.catalog`. Receipt сохранил cleanup=true и exit0;
его неточная внутренняя причина не становится доказанным timeout.
Artifact `14037505505`, ZIP SHA256
`daba2ffff6a05c91d5594313f7d130e27ae53d11ccbe5c2305728e9b9993ef82`;
model-probe receipt SHA256
`6a768ccc0fc43c7058c878983114c2a0f7c82d87772d08c32a0028ac3adc17c6`.

Существующие 10ms CPU projections первого Session Host показывают широкий
nearest-stack category `team-writer-authority`, например Windows ARM
135979223/186387141 us и Linux 16856115/33815857 us. Это разные платформы
и фазы выполнения; category не выделяет metadata-owner, конкретную функцию
или чистое OS CPU time. Эти данные не доказывают причину отказа catalog
или ожидаемую экономию от следующего изменения.

### Круг 2 — один private file, те же original guards

Source `packages/legacy-agent-host/src/adapters/providers/OpenCodeV2ManagementHost.ts`
blob `b6745ac48217f15bc782508d31375073da92254a` сохранил два conjunct
sites, аналогичных уже проверенным R19 ModelProbe:

1. `catalogCredential` получает owner callback
   `() => this.selectionCurrent() && this.configuration.isCurrent()`.
   Передать вместо него `this.configuration.isCurrent`.
2. `current()` возвращает `selectionCurrent() && configuration.isCurrent() &&
   (catalogCredential?.isCurrent() ?? true)`. Возвращать
   `catalogCredential?.isCurrent() ?? configuration.isCurrent()`.

Эквивалентность основана на exact captured closures, не на кратковременном
кэше. `captureOpenCodeV2Configuration` создан здесь с owner
`() => this.selectionCurrent()`: unbound source, explicit key и ветка без
source/key сохраняют эту проверку. R21 `isCurrent` обязательно проверяет
original key witness, затем source либо owner fallback; scope/key
`isCurrent` вызывает original owner до/после синхронного выбора auth,
включая absent-file/directory. `captureOpenCodeV2SessionCredential`
возвращает именно captured scope current; его supplied owner остаётся
тем же configuration closure. При отсутствии catalogCredential
(пассивный directory и retained key-operation owner) остаётся полный
configuration current. ManagementHost не вызывает bindRunningSession;
все original directory identity, source/config/key, seal/abort,
override и captured profile guards остаются.

Все места `assertCurrent`, signal/deadline проверки, before/after-await,
native custody, password read, session/key effects, pending leases,
exact metadata lifecycle и confirmed cleanup неизменны.
Нельзя удалять проверку explicit config key, объединять проверки через await,
сохранять результат current, вводить TTL или менять Team writer/namespace
fence. Никаких изменений timeoutMs, original 30s metadata/120s Session budget,
HTTP/native input counts, retry или data-source selection.

### Круг 3 — узкая проверка и публикация

До source root публикует append, независимый peer сверяет оба owner пути,
включая absent credential, selected-provider catalog и retained key operation.
Source scope — ровно две замены в одном existing private file.
Проверки используют существующие configuration-source, credential-scope,
model-probe и management-recovery cases: revoke, absent→present auth,
explicit key conflict, original source drift, catalog serialization/seal,
expiry и unknown cleanup. Новая suite, synthetic native success или
benchmark не нужны. При обнаружении непокрытой ветки сначала согласовать
один meaningful existing-case delta, не писать тест подсчёта implementation calls.

Нужны actual Host build/test types, эти focused cases, lint/source cap.
Следующий штатный native matrix сохраняет исходные сценарии и budgets.
Source-equivalence PASS отдельно от execution PASS; успешная проверка
closures не закрывает Windows input-cut/Darwin startup задержки и не
объявляет Linux catalog timeout причиной. Прежде более широких оптимизаций
Team authority нужны отдельные measured attribution и новый план.

## 24. R24: уточнить уже существующую CPU projection до выбора следующего product fix

### Круг 1 — actual evidence и предел нынешней классификации

R23 сохранил actual exact-9ea outcomes и их ограничения. Например, original
Windows ARM Session Host дал 135979223 exclusive sampled us в
`team-writer-authority` при sampledUs=186386897 и profileDurationUs=186387141;
Linux — 16856115 при sampledUs=33815728 и profileDurationUs=33815857.
Windows x64 projection
`invalid-profile` остаётся unavailable, а не нулевой стоимостью. Эти samples
не доказывают причину original startup/input/catalog отказа и не предсказывают
эффект R21–R23; следующий coherent native head ещё требует штатной приёмки.

На source base `e6191749318dbc8c2a609710cc60a6d2fb86aa65` classifier
[passive-diagnostics.ts](https://github.com/777genius/agent-teams-ai/blob/e6191749318dbc8c2a609710cc60a6d2fb86aa65/packages/legacy-agent-host/tests/fixtures/native-opencode-team/passive-diagnostics.ts)
(`fbca5e10af9881a1d2be2d0e46867e6dc3080b6b`) назначает эту широкую category
по ближайшему allowlisted ancestor. Поэтому вложенные filesystem scans,
проверки состояния и копирование binding попадают в один результат.
Сначала нужна более точная закрытая projection того же profile; production
guards, новый sampler и отдельный provider/benchmark run не нужны.

Source проверен отдельно от timing: `TeamOwnerStore.fenced` валидирует
namespace до/внутри original file fence; `TeamOwner.state` читает и проверяет
original state, вызывает registration validation, existing roster recovery
и current bindings всех members. `FileTeamRuntimeBindings.read` валидирует
original launch/fingerprint/restore/member-action/preparation; `current`
строит selection и клонирует всю result projection, включая prepared
configuration. Один лишь факт, что caller использует binding, не разрешает
выбросить остальные проверки или clone.

### Круг 2 — два existing TEST paths, прежняя сумма и новый конечный разрез

1. В existing `projectCpuProfile` **не менять** семь broad categories, их
   matchers, nearest-ancestor precedence, exclusive/inclusive arithmetic,
   sampled/unsampled totals или исходные validation predicates. Добавить
   отдельный `teamWriterDetails`: fixed ordered array только из закрытых
   family labels и целых sample/time totals. Он разбивает лишь samples,
   чья прежняя exclusive category равна `team-writer-authority`.
   Суммы detail samples/us обязаны точно равняться этой прежней строке;
   inclusive broad columns сохраняют прежнее overlap и не складываются.
2. Detail lookup использует exact source suffix + finite function name;
   оба берутся только из уже прочитанного original frame. На stack tree
   наследуется ближайшая известная detail family; unknown/native/inlined
   frames не получают выдуманную функцию. Закрытая таблица:

   | Detail family | Исходный source frame / значение |
   | --- | --- |
   | `namespace-fence` | `adapters/team/TeamOwnerStore.[jt]s`: `fenced`, `validateNamespace`; дочерние directory/tree/lock frames наследуют этот контекст |
   | `team-state` | `team/TeamOwner.[jt]s`: `state`; residual включает read/projection и existing recovery, поэтому это **не** доказательство pure-validation CPU |
   | `team-state-validation` | `team/TeamRuntimeRegistration.[jt]s` и `team/TeamRosterTransitions.[jt]s`: только `validate` |
   | `launch-binding-read` | `adapters/team/FileTeamRuntimeBindings.[jt]s`: `read`, вместе с вызываемыми original validators |
   | `launch-binding-current` | тот же exact file, `current`: current selection/result projection; не все функции с именем current |
   | `launch-binding-clone` | exact Node `node:internal/worker/js_transferable` / `structuredClone` **только** когда ближайший retained detail context — original `FileTeamRuntimeBindings.current`; clone другого source/read/Team не получает этот label |
   | `other-writer` | остаток original broad writer samples, включая неизвестные/непредставленные V8 frames |

   Concrete source blobs: Store `17c422fbabf290e582dad1f48f973d85d42dc082`,
   TeamOwner `cac55964ea60016be093ee14bd67c9ed6a420c3c`,
   Registration `37268ad69e08c79c3b9da1b66a377a6d8df2a6e3`,
   Roster `875fd7165c2ea4d39e8cc2e222d62807cdfa1cc5`,
   Bindings `04cbb4bda9a4ecba22cfbd664e86de1c16e8733a`.
   Pinned Node24.21 builtin source confirms its structuredClone wrapper calls
   nativeStructuredClone. Это source match, не доказательство наличия такого
   frame в следующем V8 profile: если он отсутствует, sample остаётся в
   current/other bucket, а clone cost отдельно не заявляется.
3. Новый разрез ограничен fixed seven rows. Frame names, URLs, paths, stacks,
   arguments, IDs и raw CPU bytes не добавляются в receipt/log/artifacts.
   Сохраняются original 10ms interval, только first original Host, чтение
   после его exit, 16MiB cap, node/sample/tree/time validation, original
   fd/path identity и обязательное raw unlink. Missing/malformed/oversized/
   changed/discard-failed profiles остаются unavailable. Windows x64
   `invalid-profile` не исправляется нормализацией; validation-reason
   refinement в этот минимальный cut не входит.
4. Native fixture caller, старт Host/children, HTTP/input counts, source
   authority, writers, locks, deadlines, cleanup, CI matrix/workflow и
   receipt status не меняются. Это measurement-only source, не разрешение
   на memoization/TTL, удаление guards или перенос проверки через await.

### Круг 3 — независимый review и original finite case

До source root публикует append; peer проверяет exact matches, stack scope,
broad-total conservation и что `state` не назван pure validation.
Source scope только `tests/fixtures/native-opencode-team/passive-diagnostics.ts`
и existing `tests/native-host-close.test.ts`
(`7429312e29105f6db0949bef71c615eba9cba7bf`).

В том же existing exit1/sampler case сохранить настоящий исходный Node child
и прежние отказ/cleanup assertions. Добавить небольшой **synthetic** stack
profile через existing bounded file reader: вложенные namespace/state/
binding-read/clone branches, одноимённый foreign frame и sample вне writer.
Проверить прежние broad totals, exact partition/conservation, unknown
fallback, отсутствие raw private source text и обязательное удаление файла;
малformed profile по-прежнему unavailable. Это проверка attribution/privacy,
не новый sampler, timing benchmark, suite или simulated native success.

Нужны existing four native-host-close cases, Host test types, targeted lint
и source cap. Actual refined numbers получит только очередной штатный native
matrix на exact coherent head; уже завершённые и текущие runs не повторяются
и не отменяются. До этих новых original receipts оставляем bottleneck и
любое более широкое product исправление открытыми.

**R1:** сопоставлены actual broad receipts с точным classifier и source chain.
**R2:** проверены nested validation/recovery/clone scopes и сохранение прежней
арифметики; изменение ограничено passive projection. **R3:** независимый
plan/source review и execution ещё требуются; новые source bytes не созданы.

## Review 25 — исходный model-probe catalog: закрытые passive события до следующего исправления

### Круг 1 — наблюдённый отказ и проверенная граница исходников

Original clean-head `e6191749318dbc8c2a609710cc60a6d2fb86aa65`
`opencode-v2-model-probe.native.ts` завершился INCOMPLETE: первый
`management.catalog` в строке 352 вернул `{ok:false,code:"held"}`.
74.307 s — длительность всего test case, **не** измерение catalog.
До него фактически прошли три no-tool запроса (global A, project B/high,
original cancelled probe), отказ неизвестного variant без model input;
original Host exit=0 и cleanup=true. Receipt blob
`ae99d0353a1d9d384b9be13dee8def98fe33ed19`,
SHA256 `a4397d6aa99bf43eda7753975a2d3ecbc279a2672429e849c6d44954df72dbcf`;
исходный log blob `8c8ade529fec6b4ca236319a43841a33fe715ef1`.
Это воспроизводит границу actual 9ea Linux failure, но не доказывает
одинаковую внутреннюю причину. R23 входит в e619 и **не устранил этот
наблюдаемый отказ**; source equivalence и performance/causality — разные выводы.

Source chain проверен на этих bytes: первый coordinator catalog read
создаёт original metadata owner, затем `OpenCodeV2ManagementHost.read`
проверяет current/config/auth/custody, запускает child, читает identity,
plugins/permissions/MCP, готовит credential и ждёт directory activation.
Несколько разных отказов дают тот же closed `held`; receipt не содержит
маршрутов или native stage, потому что этот fixture не подключает уже
существующие `testImports/onDiagnostic`. Ни repeated custody hashing,
ни metadata activation, ни timeout пока не установлены как причина.
Production guards и исходные 30 s catalog / 60 s probe budgets не меняются.

Отдельная точная граница: `selectOpenCodeV2ManagementModel` переносит
`effort`, management schema допускает string `max`; declared variant
проверяется `attestOpenCodeV2ModelSelection` только **после**
`server.start` и credential preparation. Поэтому отсутствие четвёртого
model request не доказывает отсутствие четвёртого child. Существующий
`nativeProcessCount:3` считает census только трёх inference cases.
Исходный flow допускает 3 probe children + 1 refused-variant child +
1 metadata child. Это source-derived предел пяти, а не утверждение,
что все пять уже наблюдались в утраченном stderr.

### Круг 2 — минимальная диагностика тех же originals

1. В existing model-probe fixture подключить тот же
   `fixtures/native-opencode-team/passive-diagnostics.ts`, что уже используется
   original embedded Session test: один receipt collector, явный
   `--import` через `startHost.testImports`, `onDiagnostic` с номером
   исходной Host incarnation. Первый и уже существующий cold Host сохраняют
   прежний start/close flow. CPU sampling не включать.
2. В observer и receipt decoder заменить только child ordinal bound 4 на 5,
   по проверенному выше actual scenario source. Сохраняются 256 events плюс
   original trace-limit marker, 4096 request bound, 512-char line, 64 KiB
   pending/child-output bounds, exact EmbeddedChild entry filter и прежние
   closed event/route/stage/method/status/code fields. Ни provider inputs,
   ни child allocation caps production этим не меняются. Если trace-limit
   достигнут, это частичная диагностика; отсутствие позднего события не
   выдаётся за отсутствие child/effect или доказанную причину.
3. Добавить только `passiveNativeDiagnostics` в existing success/failure
   receipt **после прежнего cleanup**. Сохраняются original thrown error,
   status, cleanup, requests, nativeProcessCount и hosts meanings. Не хранить
   raw stderr, native IDs, URLs, headers, body, paths, keys, command text
   либо CPU profile; transient raw chunks проходят прежнюю closed projection.
   Нет новых RPC, endpoint probes, proc reads/census, процессов, model inputs,
   повторных effects, timers, wait loops, workflow/job/runner или sampler.
4. Диагностика различает original child spawn/ready/failure stage/exit и
   последовательность уже состоявшихся HTTP routes/responses/errors.
   Даже успешный последний response не доказывает конкретный последующий
   guard failure: следующий product plan требует фактических новых closed
   observations, а не предположения о задержке.

Source base `6405e93f4a8db67ceab835ddcee23ed6a829b7fe`; **ровно три existing
TEST paths**:
- `packages/legacy-agent-host/tests/opencode-v2-model-probe.native.ts`,
  preimage `fa3c35f86c975e7cf7125503456ae1eb6ae824a1`;
- `packages/legacy-agent-host/tests/fixtures/native-opencode-team/passive-diagnostics.ts`,
  preimage `2c186e5c4e2035bf2675ed16015feb0a4019e4e1`;
- `packages/legacy-agent-host/tests/native-host-close.test.ts`,
  preimage `19a5ae5f38779fb628ab552b0f983b9cc401733e`.

### Круг 3 — original assertions и проверка projection

В том же existing failed-original-child/diagnostic case добавить небольшой
synthetic decoder input: child 5 сохраняется, выход за finite bound не
получает новый ordinal, split chunks собираются, неизвестные raw поля/
native text не попадают в output. Это decoder/privacy assertion, не fake
пятый native child и не новая suite; настоящий finite Node child и все
четыре existing cleanup/CPU cases сохраняются. R24 broad/detail totals,
validation/raw discard и все CPU bytes остаются неизменными.

Перед source — root publication и independent peer. После source — exact
diff/readback, existing four cases, Host test types, targeted lint/cap.
Native выполнение — только original unchanged scenario на следующем
coherent qualified head под управлением root/штатного CI; не новый
benchmark, повтор provider flow ради числа тестов или rerun текущего CI.
Следующая receipt должна честно сохранять исходный failure даже при
missing/truncated diagnostic. Ни catalog PASS, ни ускорение, ни полная
platform/desktop qualification этим append не объявляются.

**R1:** проверены original receipt/hash, fixture flow и неоднозначность held.
**R2:** проверены post-spawn variant attestation и необходимый finite5
observer bound; остальные budgets/authority не меняются. **R3:** peer/source
review и новое исполнение ещё требуются; production и TEST source не изменены.

## Review 26 — различить создание исходного HTTP request и попытку записи в его socket

### Круг 1 — actual 52cf и точная граница доказательства

Original clean-head `52cfb512b54a52919ae6a3ab50ac7b7c1e1402a7` с R25
завершил первый model probe как INCOMPLETE: inference requests=0, cleanup=true.
Receipt blob `4720a154e7935c4bcb636f2a01f37ba7899f07b8`, SHA256
`f70f32817c0384cf1fbe35b9c1e4dc80735cf87493840f4968f1cbe45e1a2b63`.
Original child ready — 19326 ms; первые 17 HTTP responses успешны.
Request18 `GET plugins` создан в 25683 ms; response headers не наблюдались,
request-error/unknown — 56439 ms, duration=30756 ms. Input ended — 56450 ms,
original child exited0 — 56782 ms. Это иной фактический first-failure cut,
чем e619 catalog: одинаковая внутренняя причина, CPU/OOM или сеть не доказаны.

В exact installed 2.1.4 server `pairing-49c878v9.js:14–15` вызывает
`response2(Plugin.Service.use(plugin => plugin.list()))`; core
`location-hfkcnh3h.js:67–69` возвращает текущий inventory без await/lock/network.
`pairing-gymtz25n.js:31–40` только формирует Location/data; объявленный рядом
5s `awaitPlugins` в этом handler не используется. Provider/model/plugin
разделяют location middleware, а original каталог уже получен с тем же
directory. Это исключает утверждение «plugin.list обязательно ждёт network
или activation», но не доказывает, что запрос вообще достиг этого handler.

Проверены именно [Host/D selected-source boundaries на 52cf](https://github.com/777genius/agent-teams-ai/tree/52cfb512b54a52919ae6a3ab50ac7b7c1e1402a7/packages/legacy-agent-host):
no-tool config сохраняет plugins=[], empty MCP и deny permissions;
embedded start — project:false, models.fetch:false. Built-ins остаются
частью engine, поэтому plugins=[] не объявляется отключением всех внутренних
инициализаторов. Driver submit ещё не начат. Original D finite transport
ставит прежний максимум30s до HTTP; observed duration сам по себе не
устанавливает причину ожидания и не разрешает увеличение budget.

Нынешнее событие `request` — подписка на `undici:request:create`.
Exact [Node v24.21.0 request.js](https://github.com/nodejs/node/blob/v24.21.0/deps/undici/src/lib/core/request.js)
публикует его в constructor (228), до отправки. Официальный
[client-h1.js](https://github.com/nodejs/node/blob/v24.21.0/deps/undici/src/lib/dispatcher/client-h1.js)
публикует `sendHeaders` в1282 перед writeBuffer, а GET без body вызывает
socket.write в1456–1463 и затем `onRequestSent` в1476.
Последний публикует `undici:request:bodySent` в request.js247.
Те же места проверены в native bundled Undici исходного Node24.21 бинарника.
Ни одно из двух событий не подтверждает kernel delivery, серверный ingress,
handler completion или effect/ACK.

### Круг 2 — ровно два passive события того же original request

1. В existing observer добавить подписки только на уже существующие
   `undici:client:sendHeaders` и `undici:request:bodySent`. Join — точный
   request object из прежнего WeakMap, созданный original create subscriber;
   чужой object с совпадающим URL/числом/полями не принимается. Не создавать
   новый request ordinal, lookup по URL/socket или отдельный owner/cache.
   Новые phases только для двух прежних closed routes: `plugins` и
   `model-catalog`. Все original create/response/error для остальных routes
   остаются прежними; их новые write phases намеренно не наблюдаются.
2. Closed events — `request-send-headers` и `request-body-sent`.
   Каждое выдаётся не более одного раза для этого original request; два
   boolean markers живут в том же WeakMap value. В output только прежние
   request ordinal, route/method, atMs и durationMs от original create.
   `sendHeaders` означает начало original writer path; `bodySent` для
   данного finite GET — возврат после original socket.write. Даже bodySent
   без response не называется получением запроса Bun. Отсутствие события
   при truncation/неподдерживаемом channel остаётся неизвестным.
3. Не читать/сериализовать headers, body/chunks, origin/path/query,
   credentials, Error.message/cause/stack, socket/FD/address или engine text.
   Существующие epoch/platform/Node24.21 opt-in, exact child filter,
   projection и counters сохраняются. Пределы прежние: 256 events плюс
   один trace-limit,4096 requests,5 child ordinals,512-char line,64KiB pending
   и child-output. Новые события расходуют тот же общий event budget;
   насыщение означает частичный trace, не отсутствие позднего effect.
   Фильтр двух routes ограничивает расход прежнего256-event cap, чтобы
   не удвоить все события до позднего catalog failure; это сознательная
   неполнота write-phase coverage, а не увеличение trace/deadline budget.
4. Нет новых HTTP/RPC/connect/health reads, response/body consumers,
   subprocesses, proc census, timers, polling, engine patches, native hooks
   или изменения исходного failure/cleanup/status. Host/D product guards,
   original30s/60s budgets, SDK/model counts и CI matrix/workflow неизменны.
   CPU sampler/projection R24 и прочие passive events не меняются.

Source base52cf, совпадающие preimages на working native b13f668:
- `packages/legacy-agent-host/tests/fixtures/native-opencode-team/passive-diagnostics.ts`
  — `016df1d5a9f04d797a283bb7a54bf36144fb6b7b`;
- `packages/legacy-agent-host/tests/native-host-close.test.ts`
  — `861f4f769b6d126b39c1156d46d25513e15520bf`.

### Круг 3 — узкая identity/privacy проверка и предел результата

В том же existing failed-original-child/diagnostic case сохранить единственный
finite Node child,50ms sampler work, exit1, original cleanup и все CPU/file
assertions. Через его explicit TEST import подать маленькую **synthetic**
последовательность diagnostic-channel publications: original create, оба
новых события, duplicate и foreign request object с теми же полями.
Проверить same-original join, once-only markers, отсутствие foreign event,
новых phases у другого original route и raw private fields, затем прежнюю
receipt projection. Это не HTTP/native
исполнение; реальный network request и новый child не нужны. Не добавлять
suite или повышать10s test budget.

Перед source — root publication и independent peer по semantics/write
boundary/privacy. После source — exact diff/readback, прежние four cases,
Host test types, targeted lint/source cap. Actual observed write phases
получит только исходный native scenario на следующем согласованном coherent
head. Текущие CI не отменяются/не повторяются; unknown original failure не
меняется ради диагностики. Product fix требует новых фактических данных,
и даже полный write trace не подменяет server-side proof.

**R1:** original receipt и exact Node/engine/Host source сопоставлены.
**R2:** выбран same-object passive join с прежними limits; native delivery
не приписывается событию socket.write. **R3:** peer/source/execution pending;
этот append не меняет source и не квалифицирует platform/SDK flow.


## Review 27 — connect the existing native auth actions to every current frontend entry

### R1 — actual route and missing wiring

The P05 settings availability fixes deliberately did not claim that Login/Logout
worked. A follow-up source audit found two missing consumers of the already
implemented captured-Claude flow. At current Banner blob
`c511a89d2b1af822a327221a5e9b523060d927a0`, generic Connect/Disconnect still
set a legacy terminal request and require `cliStatus.binaryPath`.
The actual Settings → Providers page renders this Banner. Provisioning's existing
settings wrapper, blob `a8d39bdd1086ca8106393d2c4bdd3cfb5013da75`, likewise
routes its dialog's Login request directly to that terminal.

The working Section implementation is the reference:
`CliStatusSection.tsx` blob `ce0a93347e54e2dcbb6480ef7ba171b371f16f9f`
already uses `useProviderAuthenticationActions`
(`e675e12f10451cfe240fb817a828dc3424e61728`) and passes
`nativeClaudeAuthAction` into the same `ProviderRuntimeSettingsDialog`.
The hook starts the original Main setup-form capture before awaiting logout
confirmation, fences context changes, carries the original project/token and
never falls back to a legacy terminal after a native capture failure. The
existing dialog/header/panel then owns the actual captured authentication flow.

Three Codex dashboard controls (copy login link, device-code login and
generate/open browser link) call the existing Codex account hook or open its
returned URL. They nevertheless share the legacy binary-path predicate.
OpenCode's existing Atlas connection action opens the existing settings dialog
and has the same unnecessary predicate. Neither route launches that legacy command.

### R2 — narrow wiring; no new authentication owner

1. Reuse the existing authentication hook in Banner and provisioning. Only a
   provider with the existing `nativeAuthManagement === 'claude'` marker routes
   to the captured-Claude action; ordinary legacy providers keep their terminal
   route. Store/pass the typed original native action to the existing dialog,
   and clear it when that dialog closes. Preserve the original provider/project,
   confirmation, context fence, error display and native cleanup owner.
2. In Banner, captured-Claude Connect/Disconnect uses confirmed installed Host
   availability with the existing busy/global-loading gates. A legacy provider
   still needs its legacy command path. No generic permission to run arbitrary
   commands is introduced. The three native Codex controls and settings-only
   Atlas action use installed/busy/loading availability plus their original
   Codex operation state; they no longer require an unrelated legacy path.
   Their visibility, native readiness/authentication and target admission remain
   owned by the current account/status APIs.
3. Reuse the existing `ProviderAuthenticationTerminal` for Banner's legacy
   provider terminal. Preserve Banner's existing by-provider-ID fallback in that
   shared helper using the existing `getProviderTerminalCommandById`.
   Keep the real command-path guard, args/env, once-only close/recheck behavior
   and current translated presentation. This removes the duplicated terminal
   projection/body and allows the Banner to stay below its frozen2835-line cap.
   The separate ordinary single-runtime terminal remains unchanged.
4. Provisioning retains its current terminal body and settings refresh behavior.
   The new captured-Claude action uses the existing dialog/header/panel. There
   is no new browser launcher, API/IPC method, token store, native query, timer,
   auth state machine or generic provider abstraction.

Exact source boundary: the two wrappers above plus
`src/renderer/components/runtime/ProviderAuthenticationTerminal.tsx`
(preimage `160f40e95b252bf4a64e69db78c69013d846ca56`).
Do not modify the shared authentication hook, Main/Host ownership, provider status
projection, product flags, generated artifacts or source-size baseline.

### R3 — focused existing coverage and actual acceptance

Extend existing `test/renderer/components/cli/CliStatusVisibility.test.ts`
from `34c7e0ec09c3fa5d1178e1de5027055071dc9acb` and
`test/renderer/components/team/dialogs/ProvisioningProviderRuntimeSettingsDialog.test.ts`
from `deb9aac5af8538033589d9cb52650583cdb44ab5`.
Keep the P05/P06 cases byte-preserved. Exercise actual captured-Claude Connect
(and confirmed Disconnect) with installed/null-path status, original setup-form
project/token, no legacy terminal, capture-error refusal and close reset.
The existing legacy login/close test remains. Extend the existing Codex reconnect
case with null-path status and real click/disabled-state assertions. The
provisioning case must show its original request reaches the same captured
action without premature status refresh or an authentication-success claim.

Run the existing focused Renderer tests, canonical types, lint and source-size
guard when execution is available. These route checks do not simulate completed
vendor OAuth and cannot replace the existing native/account/Desktop acceptance.
No new test suite, login retry, CI job/matrix, timeout or model input is added.
Root publishes this amendment after independent review and before source edits.


## Review 28 — bounded parallel final observations and original V2 read-failure evidence

### R1 — exact failures and the limited causal claim

The original parity head is 7ce224d148205867d46fd2ca980a48e1b9e8c48b,
V2 preflight run 43440481760. The source Host embedded journey failed at
opencode-v2-embedded-host.native.ts:321 in Windows x64 job 131936500078,
Darwin x64 job 131936500162 and Windows ARM64 job 131936500721.
Each original receipt proves native readiness/context applied, exactly four
model requests and no model-fixture failures. The fourth response is the
original shell action after task create/assign/start; neither a second input
nor a replacement model request is authorized by these failures.

Windows x64 and Darwin x64 subsequently expose observe-ended, input unknown
and nativeReady=false. Their passive streams reach the first turn's
session/log/message-pages/log/session sequence, then the original child stdin
closes before the Host stdin closes. Windows ARM64 instead reaches only the
first session/log observations before its outer original 90-second input wait
expires; its last snapshot remains nativeReady=true, input consumed and no
interaction. Host EOF then precedes its child EOF/exit0. Darwin ARM64 job
131936500457 passes the same embedded journey; its total 262613 ms is not a
per-phase measurement or proof that the other failures have one cause.

D gives one 30-second deadline to the whole finite native cut. The x64 timings
are consistent with that first read exhausting its budget before permission
observation, but the original receipts omit the exact internal read-failure
code. This remains an inference. The CPU projection covers the whole original
Host including cleanup and does not establish which guard caused one failure.
Immutable triage summary b8f798e2eec7fd266afb66f1865cb5ecc988cdf1 retains the
four original log blobs and serialized receipt hashes.

Linux job 131936500382 passes embedded execution and fails model-probe catalog
line360 after the unknown variant was refused/cancelled. Its new metadata
owner is independent and outside this sequencing change. Successful metadata
HTTP200 observations in the three embedded receipts do not supply the missing
Linux catalog receipt or explain its held result. Its original artifact
14049208353 is downloaded but not extracted while the executor is unavailable.

### R2 — exact four-file scope and retained admission

D repository agent-teams-ai/old-provider-implementations is based on
3b39a50b28319a3e91e0779493f0d64acb98d2e5. F preimages below are unchanged from
7ce224d148205867d46fd2ca980a48e1b9e8c48b at the current candidate publication.

| Repository and path | Exact preimage | Planned delta |
| --- | --- | --- |
| D packages/provider-implementations/src/features/provider-session-implementation/adapters/opencode-protocol/v2-native-cut.ts | 82cb9edd7ab3ca966ec0fcdeeadeb9e773685853 | Parallel final pair with original cleanup; closed failure-only diagnostic |
| D packages/provider-implementations/tests/features/provider-session-implementation/opencode-protocol/v2-native-cut.test.ts | 4e16b541c355700202332e6d4d04119c3843712a | Existing finite HTTP, changed-history and cancellation cases |
| F packages/legacy-agent-host/tests/fixtures/native-opencode-team/passive-diagnostics.ts | e2e8dd4c341a0a41a4fb2c841e2c8e80a8949ab4 | Subscribe/project one private fixed read-failure event into the same original receipt |
| F packages/legacy-agent-host/tests/native-host-close.test.ts | 365a1024743547886f52090b245c51501f3f432f | Extend the existing sole finite synthetic child/privacy case |

Read-only D anchors: v2-driver-backend.ts 942e3ecca79bec1bf0b0009427703fa54dbe8140;
driver-session.ts 414227660d319ae09e3d5095e54bbbad2ef57061;
v2-turn-projection.ts f1620b146f4ea02f807aed3c3ea32c5f503a44ae;
v2-session-control.ts d1afd3c30bf2f36bbbce3cfcce323de55e9487a0;
v2-bounded-await.ts 86c04808f56a21ecf67d7ae9582e360233f49bde.
F OpenCodeV2MemberProvider.ts 89f2eb8711025416f7afd07727ed62fcd4ad3dad
retains original observer cleanup. RuntimeOwner's observe-ended projection
and public Runtime/IPC/status contracts are unchanged.

The first session GET/decode remains strictly before the first log GET.
The existing foreign-workspace/flat-envelope case explicitly requires exactly
one request, zero log reads and zero message pages on that refusal. Therefore
the suggested parallel before-session/before-log pair is rejected: it would
move log access ahead of the established binding validation.

Retain this order:
1. Validate/snapshot original supplied binding and input; create the same
   single 30-second cut deadline and shared physical-byte ledger.
2. Read and validate the initial session, then the initial full log.
3. Read every original message page serially, using the original pin-specific
   first-page order and exact returned cursor chain through its terminal page.
4. Only after complete pagination start the existing final log and final
   session reads together, with at most two reads outstanding.
5. Join both results and run both existing complete canonical comparisons
   against the before-log/before-session snapshots before returning any cut.
   Neither final result independently authorizes publication.

This removes one proven serial dependency. It does not reduce current,
credential or custody checks, skip history, cache mutable selection, create a
new owner/transport, or resolve the Windows ARM64 initial-read delay.
All original HTTP/media/location/session checks, 8 MiB response and 32 MiB
aggregate physical-byte bounds, chunk bounds, eight pages, 1600 messages and
4096-event projection limit remain. The deadline is not renewed per sibling,
page, retry or cleanup.

A cut-local abort scope joins the final siblings to the same original signal.
A first rejection or revocation aborts its sibling and joins both bounded
original read promises through allSettled before returning failure.
Already-started underlying transport/body custody retains existing cancellation,
late-response disposal and UNKNOWN semantics. Late sibling success cannot
replace the original refusal; unconfirmed sibling cleanup cannot become clean
invalidity/completed evidence. A cleanup-unknown result takes precedence over
a merely invalid snapshot. The same byte ledger accounts for both bodies.
There is no detached read, successor-epoch delivery or added cleanup allowance.

PendingPermissions stays after a complete qualified turn. Its source names an
assistant message and tool ID, not independently the submitted input. Emitting
an interaction therefore still requires full original delivery interval,
input/attachment match, assistant lineage and running-tool join. There is no
early permission emit/prefetch, implicit grant, always-rule, extra prompt,
second input or unknown-to-success fallback. Changed cuts use only existing
bounded observation behavior, never effect replay.

### R3 — explicit failure-only observation, without control policy

Current D driver-session catches a failed original read and seals unknown;
F's existing child/Undici observer cannot recover the discarded inner stage.
The same D native-cut file may publish one fixed private diagnostics_channel
event for a terminal failed cut. It does not publish on success or the ordinary
mutable_native_readback path that the existing driver treats as a pending
observation. The channel is an observation only, not a public Session method,
Runtime event, injectable callback, return status or authority/recovery input.

The payload consists only of:
- a closed stage selected at the original call site: initial session, initial
  log, message pagination, final log, final session, comparison or admission;
- a closed reason projected from known internal failure codes, including
  deadline, cleanup unknown, invalid response/binding/envelope/transcript,
  existing byte/frame limits and an unknown fallback;
- capped elapsed milliseconds and literal deadlineExpired/aborted booleans.

Capture these facts at the original failure point before error translation,
self-abort or cleanup can confuse their meaning. Concurrent final failures keep
their own lexical stage; a mutable shared last-stage variable is insufficient.
After both original final promises are joined, publish only the selected
terminal failure projection, then preserve the existing outward error/UNKNOWN
semantics. DeadlineExpired is a measured comparison with the original cut
deadline, not an assertion that every failure after that time was caused by it.

No original error object, raw message, cause, stack, session/input/tool ID,
URL/path, body, header, credential or native payload enters the channel.
Construct a fixed primitive projection; never spread an error or source object.
No subscriber means no receipt publication. The TEST subscriber must remain
non-throwing and reject invalid/accessor-shaped data; diagnostics must not
execute native work or replace the original failure/cleanup.

The existing F preload subscribes within its original source-Host setup and
projects the fixed event into the same TEST_OPENCODE_V2_DIAGNOSTIC stream.
The receipt parser projects it again. Retain the existing 256-event plus
trace-limit allowance, 512-byte row bound, 64 KiB input buffer and captured
Host epoch. The new event consumes that same cap; no separate telemetry store,
raw log, new runner/job/matrix, timing budget or inference request is added.
A synthetic channel publication is only a privacy/format check; the next
ordinary candidate run must supply any actual native failure observation.

Primary platform source for this observation is Node v24.21.0
https://github.com/nodejs/node/blob/v24.21.0/lib/diagnostics_channel.js .
Inactive channel publish is a no-op; active subscribers execute synchronously.
Because subscriber exceptions are not an authority-safe error channel, the
existing TEST observer collects bounded data without assertions/throws inside
its callback. No Node-level channel error handling is altered.

### R4 — existing critical coverage and honest acceptance

Extend the existing successful finite-HTTP case with a deterministic final
pair barrier: the final log is not released until the final session read has
actually started. Assert both start after the last message page, total requests
remain the original six, and full cut/provider facts remain unchanged.
This is controlled concurrency proof, not a sleep-based latency threshold.

Preserve the exact one-GET foreign/flat initial refusal. Extend changed-history
coverage to complete the final sibling independently and still reject any
changed log/session without publishing a partial result. Extend existing
cancellation/late-response coverage to prove failing/revoked final siblings
settle under the original signal, readers are cancelled/released where
observable, and unconfirmed late fetches remain UNKNOWN. Within these cases,
check one closed terminal diagnostic and zero events for ordinary mutable-cut
observation; raw injected payloads remain absent.

Extend the existing sole failed-Node-child case with explicitly synthetic
private channel records: valid fixed fields survive, unknown fields/IDs/raw
token/path/stack and invalid primitive shapes do not, and the original exit1,
CPU evidence, all R26 observations and close/cleanup assertions remain.
No new test suite or normal-test real provider is introduced.

Obtain root and independent plan review before source. After implementation
run existing D native-cut, driver-native, driver-session and factory coverage
plus normal pnpm check under the repository's exact Node/PNPM pins. Run F's
existing native-host-close case and canonical affected type/lint gates.
If the executor is unavailable, required checks stay pending and run in normal
candidate CI before final acceptance/upward merge; source-only publication is
not a PASS. No required guard/test is waived.

Only root publishes reviewed source and any later verified D archive consumer
update. Installed D dist must match its checked archive through the existing
artifact verifier before F's ordinary native gate qualifies the candidate.
Keep existing matrix, per-gate budgets, model counts, original child/capture
identities, permission/interrupt/checkpoint/cleanup and failure assertions.
Source review and controlled concurrency do not establish native success;
current actual failures remain until coherent-head execution supplies proof.


## Review 29 — original Linux metadata-catalog failure, with a reserved closed observation

### R1 — exact failures and the separate owner boundary

The original Linux model-probe case fails at its first management.catalog,
opencode-v2-model-probe.native.ts:360, after the unknown-variant probe has
already returned cancelled at line356. This is present in three immutable
original logs: parity7ce job131936500382 (blob
0f68d6a4961c407372dee03e83cdf5ddf8472788; case58552.848932ms),
qualification62f job131938757997 (blob
c2a13ffb49a1296bf8c86229780a29fb239d93d1; case59282.964454ms),
and native12d job131994517305 (blob
559cbfa1d7ee0e64beb6ba4d59df43347946921b; case80750.115391ms).
Each log exposes only the original closed reply {"ok":false,"code":"held"}.
Those case durations are not measurements of the catalog call. The private
model-probe receipt members have not been extracted; do not infer their
contents, a timeout, CPU pressure, activation failure or a decoder defect.

ModelProbeOwner ae3912d6a4f3a3a46f0bb8a12e11e72334b90519:142-156,
236-277 retains the original probe close/fence result. The completed cancel
is consistent with a released probe resource; an uncertain native close
would retain resourceHeld. ProviderManagementCoordinator
8d2d656cc043d135fef925698363c4ec48e2eb48:578-665 serializes catalog calls
through its separate v2CatalogReads and v2Hosts, with a new metadata owner
and catalog namespaces. It does not reuse the probe object or reserve its
ModelProbeOwner resource. Its original 30000ms catalog deadline is captured
before the metadata queue; the probe's separate60000ms does not transfer.

OpenCodeV2ManagementHost c25ee725dab4cda3f151a79c4d489a89e530330a
starts that original metadata child, then reads identity, plugins, saved
permissions, MCP, optional credential preparation and full directory.
The full directory reads provider/model/default/integration and validates
every returned projected row. Selected-model probe admission validates
its selected provider/model; these are different paths. The outer methods
adapter708d880bb9be0dcaae978b97b0686b548b7873a3 translates otherwise
unclassified errors to held. A successful previous probe cannot identify
the failing metadata stage.

Official upstream is independently located from opencode.ai's repository
link and the v2.1.4 tag, commit68bc26b7da1990ce10ffecfbc1e09eb13aa5d824:
[provider available snapshot](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/provider.ts)
uses integration connections and activation;
[model handlers](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/server/src/handlers/model.ts)
wait for activation through the existing server helper;
[integration handler](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/server/src/handlers/integration.ts)
also waits for activation.
Their blobs are b4f88d649d1b8e34434b715fe05e61a4c754b52b,
5af4334c68aa4079b50a21e54c3b5c99fb2742e7 and
dfdbaa447620a9af7ceac9cd7ca962bbe8d2dda9.
Canonical runtime sourcef5c69c2e9024ffc36a5db5eafe30f53539b52f62,
bun.lock5a27e40bf9d146a1bd7f8a68d454ad9868b7a2a0 pins
@opencode/server@2.1.4 and its @opencode/core@2.1.4 dependency.
This locates exact upstream semantics; it is not an asserted byte comparison
with the shipped compiled chunks, or proof that any activation wait caused
the three failures. F still consumes checked D3b39/f251; D4b005's green jobs
do not qualify this unchanged F metadata path.

### R2 — exact four-file candidate; no changed control or native behavior

Use these verified preimages from current parent1160b575c4e43db045ab8726fd16d27bd611196a:
- packages/legacy-agent-host/src/adapters/providers/OpenCodeV2ManagementHost.ts
  c25ee725dab4cda3f151a79c4d489a89e530330a;
- packages/legacy-agent-host/tests/fixtures/native-opencode-team/passive-diagnostics.ts
  c905cddbdebfa1aed8fe963279383515a32fe6b3;
- packages/legacy-agent-host/tests/native-host-close.test.ts
  15bd06999447025ae99b18731f6ea921aaccbeb6;
- packages/legacy-agent-host/tests/opencode-v2-model-probe.native.ts
  7ff5ff738424370cc6699b2dc7127609fc2a345d.

Instrument only the existing metadata read. A fixed private diagnostics_channel
agent-teams:opencode-v2:metadata-read-failed emits at most once per failed
read, with stage, reason, elapsedMs, deadlineExpired and aborted. No successful
read or ordinary empty-inventory activation-loop iteration emits this event.
The original per-read diagnostic start is monotonic; deadlineExpired compares
the same caller absolute deadline already passed to read, and aborted records
the original read signal. Before that signal exists, aborted is null (unknown),
never an invented false; after creation it is the original boolean. Reason is
not inferred from those flags. Neither a diagnostic timestamp nor the schema's
existing timeout range creates a new operational deadline.

The finite stages are admission, native-client, identity, plugins,
permissions, mcp, credential, directory, activation-wait, current,
projection, dispose and result-current. native-client includes original
startup/first retained-client establishment; it does not claim a particular
internal startup substage. Preserve exact evaluation and short-circuit order
when separating the existing combined read-only guard into stage-marked
expressions. All provider/custody/configuration checks, 50ms activation wait,
serial directory calls, model counts, no-tool config, readonly selected
endpoint refusal and every cleanup action remain unchanged.

Capture the first original failure at its lexical stage before dispose,
self-abort or outer error translation. Preserve its original object for
rethrow and the existing failed/failure precedence. A dispose failure may
be the first diagnostic failure only if no earlier read failed; it cannot
replace an earlier reason/stage. Existing cleanupUnknown, tracked pending
retirement, close and directory removal continue unchanged. nativeClient
failure and the final current check also receive their original lexical
stage without moving the native await or changing the cleanup path.
The observer must be nonthrowing and cannot determine the public result.

Reason is an allowlisted own data-property code only: held, conflict,
invalid, busy, deadline, cleanup_unknown, transport_failure,
authority_mismatch, disposed, http_failure, media_type, body_limit,
frame_limit, invalid_response, invalid_native_catalog,
native_catalog_binding_mismatch, capabilities_pending, unqualified_version,
ABORT_ERR, or unknown. At most one already-known ClientError/Transport
wrapper may be inspected through own data descriptors for its original
cause code; no generic cause traversal. Do not read arbitrary getters,
error.message, stack, argv, environment, paths, endpoint, credentials,
request IDs, profile/provider/model IDs, response fields or raw bodies.
Elapsed is a finite nonnegative integer under the existing3600000ms
diagnostic time-field bound; this changes no timeout or wait.
The event is frozen and the fixed projection is checked again by the TEST
subscriber and again at the receipt boundary.

### R3 — reserve a terminal slot and bytes within the existing capture bounds

The existing generic trace has256 event slots and one trace-limit marker.
Reserve one of those256 slots for the first valid metadata-read-failed in
each original Host observer. There remain at most255 ordinary events,
one metadata failure and the same single trace-limit marker: total<=257,
never a reset, second collector, new process or additional subscription
epoch. Invalid records do not consume the terminal reservation; subsequent
valid metadata failures in that Host cannot replace the first. The existing
parent capture spans Host epochs1/2: its count, aggregate bytes and one terminal
reservation remain global to that same capture, retain the first valid terminal
overall, and never reset or allocate another terminal slot on epoch change.

The current64KiB check is a raw pending+incoming-chunk guard, not an aggregate
emitted-byte ledger. State this accurately. Add bounded closed-trace byte
accounting at the existing producer and receipt collection: ordinary lines
must leave space for both the maximum512-byte closed terminal line plus LF
and the same maximum512-byte trace-limit line plus LF, inside64KiB.
Reserve at most2x513 bytes; do not increase the original512 line limit,
64KiB raw buffering guard, request4096 or child5 bounds. The source deliberately
trades at most one ordinary event and the necessary finite byte space for
the late terminal observation. The first valid terminal event remains
eligible after ordinary count/byte saturation. Overflow or foreign raw
stderr that trips the existing raw guard still yields missing/unknown
diagnostics, never a claimed cause or success.

Extend the existing original model-probe failure path to publish one small,
closed TEST_NATIVE_V2_CATALOG_FAILURE line after its existing cleanup.
Use only the original catalog reply/phase, original captured passive event,
sourceHead, fixed booleans/counts and cleanup result. In particular expose
whether the first catalog call was attempted/completed, the already-confirmed
unknown-probe cancel, and whether the trace was limited. Do not print the
whole receipt, original exception or raw diagnostic object.
No additional RPC, native read, retry, input, IO read, awaited write or timer
is introduced. The existing receipt file remains complete; all original
success assertions and original failure/cleanup exception order remain.
A missing event is explicitly unknown and may mean failure before read,
raw capture overflow or unavailable diagnostics.

### R4 — same existing critical coverage and honest acceptance

Extend the sole existing synthetic failed-Node-child case, preserving its
original exit1, CPU read/discard, R26 request-object joins and R28 cut event.
Publish a valid metadata failure only after the ordinary trace has saturated;
verify it survives exactly once without allowing a second failure to replace
it and without exceeding the total event/line/byte limits. Use the existing
in-memory receipt checks to exercise byte pressure as well as slot pressure.
A malformed stage/reason/flag/elapsed or own accessor is refused (the sole
null flag is pre-signal aborted); getters
are never invoked, and injected raw token/path/stack never reaches the
closed event or assertion output. Compare only the safe projection or a
boolean contract assertion, never an untrusted raw object.

This controlled test proves diagnostic identity, cap and privacy behavior,
not actual native failure stage. Required Host build, existing native-host-close
case, affected canonical types/lint and source-size checks run when execution
is available, or in the ordinary candidate CI before final acceptance.
There is no new suite, job, matrix, execution retry, timer/cap increase,
provider pin, permission policy, native launch owner or product eligibility.
Only root publishes after root and independent source review.
The next ordinary original native run may distinguish deadline, invalid
catalog, ownership/current refusal or transport/cleanup. No cause is claimed
until that new observation actually exists; current Linux failures remain.

## Review 30 — refine the original namespace-fence sampled-stack attribution

### R1 — observed evidence and the bounded question

The original e29dbde receipts reported the following first-Host sampling
results. These are the already completed original jobs, not new runs:

| Original job / platform | sampledUs | writer exclusive sampledUs | namespace-fence exclusive sampledUs | nodeCount / sampleCount | fileBytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| [132132912841, Windows x64](https://api.github.com/repos/777genius/agent-teams-ai/actions/jobs/132132912841) | 149629498 | 79163933 | 72218739 | 26762 / 14555 | 6113051 |
| [132132912961, Windows ARM](https://api.github.com/repos/777genius/agent-teams-ai/actions/jobs/132132912961) | 193032508 | 138847670 | 123412990 | 29721 / 18635 | 7133927 |
| [132132913050, Darwin x64](https://api.github.com/repos/777genius/agent-teams-ai/actions/jobs/132132913050) | 198047584 | 133363007 | 120904811 | 17645 / 6526 | 4210370 |

All three retained projections have samplingIntervalUs=10000 and
rawDiscarded=true. The profile covers the same original Host epoch1,
including its existing cleanup. These sampled stack durations neither
measure pure namespace validation CPU nor identify syscall counts, lock
contention, exact wall-time responsibility, or a cause of the native
terminal failure. The deleted profiles cannot be reclassified retrospectively.

Review24 already identifies namespace-fence through the nearest original
TeamOwnerStore.fenced/validateNamespace frame. That bucket can contain
directory-prefix checks, recursive tree inspection, lock acquisition or
release, and unclassified work under the protected callback. Refine only
that existing bucket so the next ordinary run can distinguish the known
source families. No production optimization or guard change is selected.

### R2 — exact source and controller path prerequisite

Use these immutable sources at parent
15fc115e92b249b5d6cb35dbf8dbe78dd784ea4c:

- packages/legacy-agent-host/src/adapters/team/TeamOwnerStore.ts,
  17c422fbabf290e582dad1f48f973d85d42dc082: fenced calls
  validateNamespace before the lock and again inside its callback.
  validateNamespace contains the exact local functions directoryPath and
  tree (lines68 and84); the former walks path components with lstatSync,
  the latter recursively inspects readdirSync entries.
- packages/legacy-agent-host/src/adapters/team/ControllerAdapter.ts,
  45ca266cf44afd3a65c5db3312640d71f67328eb, lines62–79:
  withTeamFileFence is the existing withFileLockSync export obtained from
  agent-teams-controller/src/internal/fileLock.js. Do not assume this
  import points at controller/dist.
- agent-teams-controller/package.json,
  293fb7e08df5e9cc00663e0e5454dfde6ecfb103: CommonJS main is src/index.js;
  both src and dist are published roots.
- agent-teams-controller/scripts/build.mjs,
  bf2ce41041a9aee92261319e86cf802d82004739: recursively copies src to
  dist without transforming function names or rewriting imports.
- agent-teams-controller/src/internal/fileLock.js,
  3c087f7e7f35106e72340c3eca51b325e10d8314: the exact synchronous
  acquisition/release helpers are source-backed; withFileLockSync and
  withFileLock each invoke an arbitrary protected callback.
- scripts/legacy-agent-host/candidate-closure.ts,
  b6ad8b343f2210cec5e51c0876e9cbefcafc64b7, lines95–157: packaged
  dependency roots are copied to numeric host/packages/NNNN folders.
  A numeric folder alone is not proof of the controller package identity.

A controller family match requires the normalized, segment-anchored path
/agent-teams-controller/(src|dist)/internal/fileLock.js and an exact
allowlisted function name. The src path is the actual current Host import;
the dist path is the verified copy-equivalent build layout, not a claim
that an old profile used it. Do not match generic internal/fileLock.js,
arbitrary numeric package roots, or a function name by itself.
If packaging, inlining or an unavailable frame prevents this exact match,
retain residual attribution. No new path lookup, require.resolve, module
load, file read, profiler hook or source-root inference is introduced.

### R3 — two-file TEST-only change, preserving the original sums

Only these existing files may change after the reviewed plan is published:

1. packages/legacy-agent-host/tests/fixtures/native-opencode-team/passive-diagnostics.ts,
   preimage 1148b16387db9ef033ed6e9efa1e5f785783ea04.
2. packages/legacy-agent-host/tests/native-host-close.test.ts,
   preimage 8bbd83ce4406438b066dcc7c58c57d1bbba35705.

Keep all seven original broad categories, all seven teamWriterDetails
rows, original order, matching rules, exclusive/inclusive arithmetic and
attribution string unchanged. Add one fixed four-row namespaceFenceDetails
partition to an available CPU projection; each row carries only family,
exclusiveSamples and exclusiveSampledUs. Its fixed families are
directoryPath, tree, controller-lock and residual. It is additional detail
of the original namespace row, never additional sampled time.

directoryPath and tree require the exact existing
/adapters/team/TeamOwnerStore.[jt]s suffix plus the corresponding exact
function name. controller-lock requires the controller path above and
one of these existing named private operations:

codeOf, statOrMissing, readOrMissing, unlinkOrMissing, removeEmptyGate,
isProcessAlive, parsePid, writeComplete, recoverGate, acquireGate,
readLockInfo, sameLock, recoverDataLock, releaseLock, tryAcquire,
sleepSync, resolveLockOptions, acquireFileLockSync.

In particular sleepSync is matched only with that controller path and
the original namespace/writer context; no generic sleep or filesystem
frame becomes a controller match. The wrapper functions withFileLockSync
and withFileLock are not controller-lock roots. Their exact frames reset
the new subfamily to residual, so an arbitrary protected callback is not
automatically described as lock work. Anonymous release-wrapper overhead
without a more precise private helper remains residual.

Traverse only the same already validated original stack tree. Compute the
original broad category and writer family first, with their current rules
unchanged. The new subfamily is eligible only while the original exclusive
category is team-writer-authority and the original writer family is
namespace-fence. Outside that intersection reset the subfamily to residual;
never carry a directory/lock label across a different broad/writer family.
Every new exact fenced or validateNamespace frame also resets it to
residual before any narrower descendant match. Within the eligible context
a nearest exact directoryPath, tree or controller helper frame supplies
the subfamily inherited by its unclassified synchronous descendants.
The wrapper boundary above resets it again. Returning to a sibling branch
uses its own original ancestor context, not a global last-seen label.

For every eligible original sample, increment exactly one new row using
the same original sample count and timeDelta. The four rows must sum
exactly to the unchanged namespace-fence row for both counts and sampledUs.
They are source-family stack attribution, including native descendant
work, not isolated function self-time or a proof of pure validation cost.
Unknown, inlined and unmatched work remains residual without a guessed
family, a new broad category, or invented cause.

No raw frame/function name, URL, pathname, stack, arguments, IDs or private
text is copied into the receipt. Only the four fixed labels and bounded
integer totals leave the projection. An unavailable/invalid profile
remains unavailable and gains no successful detail rows.

### R4 — original limits and meaningful existing coverage

Keep the existing first-Host-only sampler, 10000us native interval and
supported interval validation, original native scenario/deadlines,
16MiB file limit, fixed node/sample/duration bounds, one connected acyclic
tree check, safe timeDelta arithmetic, before/after file identity checks,
original read/discard failure semantics and mandatory raw-profile unlink.
All R25–R29 event, byte, request and child limits and first-failure
observations remain untouched. No new child, run, retry, stage, job,
matrix, benchmark, production read, lock, timer or retained raw profile.

Extend the same existing failed-original-Node-child test case. Preserve
its one actual child and all earlier broad/writer expected values, exit1,
privacy, malformed-profile, file-size and unlink assertions. Add finite
controlled profile data inside that same case to prove:

- All four exact new rows, nearest descendant inheritance, recursive tree
  attribution and both count/time conservation against the original row.
- Exact controller src and copy-equivalent dist paths match only the
  finite named helpers; a wrong path, same-named foreign function and
  numeric packaged path remain residual.
- Wrapper callback work, a nested fresh fenced/validateNamespace boundary
  and missing/inlined frames remain residual until a precise new match.
  A lock frame outside the original namespace/writer intersection, or a
  nested different broad/writer family, contributes no new namespace row.
- An invalid original tree/sample still returns unavailable, without the
  new detail field; no raw marker/path/function name escapes and each
  controlled raw profile is discarded by the same reader.

These controlled profiles prove the classifier contract only. They do
not prove the family distribution, improvement, successful native input
or failure cause on any platform. Host build, the existing native-host-close
suite, affected canonical types/lint and source-size checks remain required
before acceptance. With execution unavailable, source publication remains
SOURCE_ONLY_UNEXECUTED and those checks run in ordinary CI, without changing
budgets or retrying the original jobs. Root alone publishes after root
and independent plan/source review.


## Review 31 — bind the V2 management catalog and key operation to the native optional integration ID

### R1 — exact failure, native contract, and the baseline limit

The original Linux V2 preflight at F
`e29dbde300ea73ec4e46e5f57f9e007ca5473552`, job
`132132912845`,
failed at `opencode-v2-model-probe.native.ts:383`: the first catalog RPC
completed with an `ok` reply, then `authMethods: []` differed from
the unchanged `['api']` assertion. Its preceding version, default,
model details, `connected: false`, and `configuredAuthless: true`
assertions passed. The original closed failure row records
`unknownProbeCancelled: true`, `catalogCompleted: true`,
`catalogPhase: first-assertions`, three model requests, and
`cleanup: true`. This is separate from the earlier held catalog RPC.
The log does not retain the raw provider/integration response bodies;
the source finding below must not be called an inspected raw response
or a successful corrected native run.

Exact F `OpenCodeV2ManagementHost.ts` blob
`0a78ee125848aee947b409d2e6a3253be4a5ecab` loses an allowed relationship
in two places. Catalog projection selects
`integrations.get(provider ? provider.integrationId ?? '' : id)`.
A present provider with no explicit ID therefore cannot use a genuine
same-ID integration from that very directory. The original
`keyOperation` similarly chooses only `provider.integrationId`
when a provider exists, and returns held before its original callback.
The existing frontend projection
`capturedManagementCatalog.ts` `d462486c7914ff325a7fe24466f224d55200458b`
uses actual `authMethods` to enable Connect/API-key setup; it does
not synthesize an API-key capability from `configuredAuthless`.

Primary native source is official
[anomalyco/opencode@68bc26b7da1990ce10ffecfbc1e09eb13aa5d824](https://github.com/anomalyco/opencode/tree/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824),
the published 2.1.4 tag source, not a newly measured installed bundle.
`packages/schema/src/provider.ts` `6306eb374d91b4c45768ed76cd3fbda33d2378d1`
declares optional `integrationID`; its empty provider omits that field.
`packages/core/src/config/plugin/provider.ts`
`21a1a87edb84544120c69b58ac5bbdf9188bc562` creates a same-ID integration
with a genuine key method when that configured integration is absent.
`packages/core/src/provider.ts`
`b4f88d649d1b8e34434b715fe05e61a4c754b52b:459` resolves
`record.provider.integrationID ?? Integration.ID.make(record.provider.id)`.
`packages/server/src/handlers/provider.ts`
`ab9c2201a5eea69a943b47cf871aec49ada22e14` returns those available records.

The consumed D68 source is
`agent-teams-ai/old-provider-implementations@68dca527b779ebb82923f30d7b08441085d8b579`,
checked archive SHA-256
`07241cca756e69aa6001df41d6a7408aad5d8ab4c8277f9d70f35d0d66736c73`.
Its `v2-owned-catalog.ts` `900929ed38ea49605f07a8ca3dca7c75bc5a4c09`
omits the projected ID only for native `undefined`; a present ID must
be a nonempty string of at most 2048 characters with no control characters.
Null, empty, numeric, and malformed values refuse as
`invalid_native_catalog`. `v2-owned-directory.ts`
`ec430bf1bfbdba10e6dddd3e2560a9c2de5e6b02` retains the exact location,
unique provider/integration IDs and the original four finite GETs;
`plainKey` is true only for an actual `key` method with no form.
`v2-credential-client.ts`
`7cc07068845c4fc2ec995ac599e74fe8a0b32103` then verifies the selected
integration ID and directory again before any key POST and verifies
the original empty-before/single-after credential ownership.

The older frontend/runtime is not evidence that this exact implicit-ID
case previously succeeded. Old F `4a0e06277fe216d9f82dbbede362668fe46622ee`
consumed runtime `e13edcd3d4ffbecc0272ae30195cc6b15b710ee7`;
its `OpenCodeV2ProviderDirectory.ts` `825f53115b899ea2cfc4f7e50266aa07058c487f`
used the same empty lookup, and test `bc86ea6c58a006b51d5d223349ff190235c70ff4`
explicitly refused a null relationship even beside a same-ID integration.
This change aligns the current qualified 2.1.4 decoder/management consumer
with native optional-ID semantics while preserving explicit aliases,
unsupported integration forms and the existing native/UI acceptance gates.

### R2 — two existing source paths; no additional owner or API

Both preimages below were read back unchanged at current F
`2f6f3db0c6685dda535dfe866f7264249129ecab` before this plan.

| Existing path | Exact preimage | Bounded change |
| --- | --- | --- |
| `packages/legacy-agent-host/src/adapters/providers/OpenCodeV2ManagementHost.ts` | `0a78ee125848aee947b409d2e6a3253be4a5ecab` | Correct only catalog projection and the original keyOperation integration selection. |
| `packages/legacy-agent-host/tests/opencode-v2-credential-scope.test.ts` | `83c106fb12267e57a7023cfce788277ffa780e5a` | Extend the existing first critical case with controlled original Host/client protocol subscopes. |

Catalog uses an explicit decoded `integrationId` unchanged when present.
Only when that field is truly absent may it look up the provider's exact
ID in the already-read integrations map. It advertises `api` only when
that actual row reports `plainKey: true`. Missing rows, unrelated rows,
key forms and other authentication methods do not acquire an API-key
capability. Existing integration-only directory entries retain their
original behavior.

The original keyOperation applies the same optional-ID distinction.
A present decoded native ID remains authoritative even when different
from the provider ID; failed or absent explicit target evidence cannot
fall back to a same-ID row. Only the absent-ID branch may select a
genuine same-ID row from the original decoded directory. Keep the
existing excluded integration IDs and catalog filters exactly in their
current branches. Preserve the original retained command ID, native
identity, plugins, permissions, MCP, source/current checks, original
signal/deadline, original credential client, callback, disposal order,
cleanup-unknown precedence and command journal. No additional GET,
POST, prompt, retry, selector refresh, mutation, timeout or allowance
is introduced by either production change.

No D decoder, schema, renderer, IPC, key store, native fixture, workflow,
package pin or provider eligibility changes are in this scope. In
particular the original native `authMethods: ['api']` assertion in
`opencode-v2-model-probe.native.ts` `d07280188edc39526a1852b895084eb179740a3c`
is unchanged. P05's separate authless readiness fixture does not
replace this catalog/key capability requirement.

### R3 — meaningful existing coverage and unchanged acceptance

Retain all existing credential-scope cases, including their original
SessionCredential finite peer modes, source auth bytes and no-replay
assertions. Extend only the first case with explicitly synthetic
management protocol subscopes. Construct the real Host with a validated
TEST profile and the original captured filesystem/current checks;
replace only that instance's existing private `nativeClient`
launch/custody admission boundary. Return real pinned owned-session
and credential clients connected to the finite TEST HTTP peer.
There is no new production injection/export or synthetic native
qualification, and catalog/keyOperation themselves are not mocked.

Each explicit catalog or key operation owns its original client,
signal and deadline; never refresh a failed operation or reuse a
closed Host as a retry. The peer verifies original location and
authorization, a bounded request body, exact route/method ordering,
and a finite operation ledger. A catalog needs only its four original
identity/plugin/permission/MCP observations plus the existing four
directory GETs; a successful key operation adds the existing
integration read, one original key POST and its readback. Failed
selection cannot POST. Existing peer limits and production budgets
are not raised, and each new explicit controlled operation is joined
and disposed before its peer closes.

The added assertions distinguish: a configured provider with an
absent ID plus a real same-ID plain-key integration; an explicit
different-ID alias with a distracting same-ID row; a dangling/foreign
explicit target which must not fall back; absent/unrelated integration
rows; a genuine key method with a form; malformed null/empty/numeric
native IDs rejected by the real decoder; and the existing excluded-ID
policy. Positive catalog evidence must still leave `connected`
unproved. A successful key callback must retain the exact selected
integration, perform exactly one original POST, and return its genuine
client readback. All refusal subscopes require zero POST and unchanged
source auth bytes. The old selector must fail at least the absent-ID
catalog and original key-operation assertions, so this is not a
test that merely restates the new expression.

Host build, the affected existing critical suite, canonical Host/test
types, lint and source-size checks remain required before acceptance.
Root coordinates the available execution slot; no independent native
rerun or CI cancellation is authorized by this plan. Source review or
controlled peer success cannot be transferred to native execution,
user authentication, Desktop Connect or performance. The unchanged
ordinary native and frontend gates remain the acceptance evidence.
Root alone publishes after root and independent plan/source review.


## Review 32 — keep the final provider admission and control checks under one original Team fence

### R32.1. Original failure evidence and the limit of its attribution

Read-only original evidence is `state/child1188-v2-original-receipts.json` (277732 bytes, SHA-256 `d5ca8cbba82e055e76fa1066baafa08d4be7ae101e0cd566ca7cce4fe5050ac0`), retained from native child head `8f28b801f513187b84b17f8748745dc563b6e43a`, run `43515484835`. The three original jobs are Darwin x64 `132196281665`, Windows x64 `132196281740`, and Windows ARM64 `132196281793`. Each receipt is INCOMPLETE, reaches original native Ready, retains an input without terminal, and confirms original cleanup. This plan does not reinterpret that cleanup as successful input completion.

| Original job/platform | Open elapsed ms | Whole original Host sampled us | Namespace-fence exclusive sampled us | Model requests |
| --- | ---: | ---: | ---: | ---: |
| 132196281665 / Darwin x64 | 71472 | 164288506 | 113482386 | 8 |
| 132196281740 / Windows x64 | 57951 | 151261690 | 100566138 | 4 |
| 132196281793 / Windows ARM64 | 97944 | 193216889 | 125623596 | 0 |

The input uses its original 90-second deadline. The CPU projection covers the original source Host including cleanup; its sampled time is neither isolated function self-time nor input-only CPU. R30's already-published finer directoryPath/tree/controller-lock/residual partition is absent from these original receipts and remains an ordinary new-CI observation gate. No claim that lock acquisition, directory traversal, sleep, provider latency or any one subfamily caused all three failures follows from the broad namespace total. A synthetic lock-count regression cannot qualify native performance.

### R32.2. Exact source repetition and the existing private boundary

Current `captureMemberProviderAuthority.ts` `0042153f6711b1f4ef35f95ed68e9daf85d533d1` lines 29–41 first invokes the original coordinator/current callback, then compares the captured Team object, binding, delivery, full profile, configuration and principal, and finally invokes `authorizeMemberBinding(binding, 'admit')` followed by `authorizeRuntimeAccess(originalPrincipal, binding, 'control')`. There is no await between these final two calls. Keep the coordinator/current call and every immutable comparison at their original position.

The original coordinator `RuntimeTeamCoordinator.ts` `ad6d518e15f4d9ad7100cbea42e8707b00588e49` lines 751–760 checks the writer, captured availability, roster, endpoint lifetime and dispatch authority. It is outside this source cut. In particular, do not move a new Team lock ahead of `ProfileWriterLease.assertCurrent` or wrap the entire provider guard. The ordinary roster and dispatch guards are not removed or merged by R32.

`TeamOwner.ts` `3ff23c20479bc4cf9579dd985cb3f3520a1cb9fa` lines 395–407 delegates the final checks to `TeamDeliveryAuthority.ts` `e0e9199961d62e86bbe025c1576aaa00c49a31f3`. The latter's `authorizeMember` at 64–69 fences the unchanged `memberAuthorized` predicate; `runtimeAccess` at 32–61 separately fences the original principal/grant/current-member check. A standalone successful pair therefore obtains and releases the same canonical Team lock twice.

The new selector is the literal `'provider'`, confined to these two existing private class/helper signatures and the single original provider-authority call site. It is not a permission, public Runtime action, Team connection command, Host RPC, management operation, DTO or native Session action. The complete current production call-site search finds these class calls only in Host composition; every existing ordinary caller supplies `'read'`, `'control'`, or its already-narrowed read/control action. `TeamOwner.connect`, transport parsers, contracts, permission lists, captured records and fingerprints remain unchanged. No public caller can request the new branch through a widened wire schema.

### R32.3. Exact bounded production change

Add `'provider'` to the existing private `TeamOwner.authorizeRuntimeAccess` action union and the corresponding `TeamDeliveryAuthority.runtimeAccess` union. The TeamOwner delegation remains otherwise identical. Before the existing read/control body, the helper handles only this literal with the following finite synchronous composition:

```ts
if (action === 'provider') {
  return options.store.fenced(() =>
    memberAuthorized(binding, 'admit') && runtimeAccess(principalId, binding, 'control')
  );
}
```

The old read/control implementation below that branch must remain byte-identical. The recursive call uses only the fixed original `'control'` action, so this is one bounded nesting, not a retry or new dispatch. It calls the original `memberAuthorized` first and, only on success, the original `runtimeAccess(..., 'control')`. Both original fresh state/grant/selection reads, their short circuit, rejection conditions and exception propagation stay in use. Do not replace either with the other's boolean or add an authorization cache.

Replace only the final admit/control pair in `captureMemberProviderAuthority.assertCurrent` with the single private `authorizeRuntimeAccess(original.principalId, entry.binding, 'provider')` call. All other captured identities, coordinator/writer checks, allocation/lifetime guards, checkpoints, original Runtime reads and every existing pre/post-await call remain unchanged.

Reuse `TeamOwnerStore.fenced` `17c422fbabf290e582dad1f48f973d85d42dc082` exactly as it is. The outer fence performs its existing pre-lock and post-lock namespace validation. The nested original control fence still performs `validateNamespace()` before the same-store depth check and then uses the still-held original lock. Only the second acquire/release cycle disappears. For a standalone final pair, the existing protocol changes from two outer acquisitions/four validation visits to one outer acquisition plus one synchronous nested control visit/three validations; no code suppresses a validation or treats an old scan as current. Already-nested callers continue using their original outer lock.

Do not use `withLaunchAuthority(read)` as a substitute: that would add a separate authorize/state/roster.recover operation before the original admit. Do not alter controller file-lock publication, owner tokens, cleanup, wait/retry policy, namespace traversal, per-await source/current checks, permissions, TTL, limits or deadlines. The original `finally` releases the one real lock on success, false, or exception. No lock or state snapshot survives an await or a completed guard.

### R32.4. Four existing paths and exact preimages

| Existing path | Exact preimage | Authorized delta |
| --- | --- | --- |
| `packages/legacy-agent-host/src/composition/captureMemberProviderAuthority.ts` | `0042153f6711b1f4ef35f95ed68e9daf85d533d1` | Replace only the final two authority calls with the finite private provider pair. |
| `packages/legacy-agent-host/src/team/TeamOwner.ts` | `3ff23c20479bc4cf9579dd985cb3f3520a1cb9fa` | One existing action-union addition; retain the 800-line source cap and delegation. |
| `packages/legacy-agent-host/src/team/TeamDeliveryAuthority.ts` | `e0e9199961d62e86bbe025c1576aaa00c49a31f3` | Same private union plus the bounded provider branch; old read/control body unchanged. |
| `packages/legacy-agent-host/tests/member-provider-authority.test.ts` | `a0760de812af6c0b698c2be23a28269d22741d7d` | Extend only the existing restored-provider-authority case, retaining both existing case names and original assertions. |

These four preimages are shared by the inspected current repair/native/qualification sources. Root rechecks each actual publication tree and preserves unrelated branch-specific bytes. No source, controller dependency, public contract, diagnostic projector or native fixture outside these four paths is authorized by this plan.

### R32.5. Meaningful existing regression and ordinary validation

Extend `restored provider authority binds the complete open request and keeps current fences` using its existing real filesystem Team owner and controlled Runtime record. Keep the original fixture, full checkpoint/open fingerprint, host-incarnation, config mutation, allocation-count and target-lifetime assertions. The fixture's controlled coordinator callback isolates the final provider pair; this must be labelled as a controlled authority/lock proof, not a real native latency result.

Observe, without fabricating results, the original canonical authority lock token while the existing real Team store reads its state. A scoped pass-through observation may wrap the existing store read solely for this original Team; it must return the exact original result and leave errors unchanged. One successful original guard must reach both original member/grant reads under the same nonempty canonical lock token, and that lock must be absent after return. The next independent guard must obtain a new token rather than reuse the old token or permissions. Retain the existing original per-request comparisons; do not satisfy the test by mocking the authority booleans or introducing a production counter.

Use the same existing case to distinguish an admitted member from a principal that cannot control that member, and to prove that original revocation/current-state changes are observed on a later guard. No Runtime open/input/native effect may follow either refusal. A failing original coordinator/current callback must precede all new pair lock/state work and preserve its original thrown value. Check release after refusal and retain original exception/finally and cross-store exclusion coverage from the unchanged `team-owner-store-fence.test.ts` (`f81e5d2a84ff76643e91bd36f8bab08fdb86f577`). Every test hook is scoped and restored; no new suite or test-only production API.

After independent source review, root performs the ordinary coherent Host/ledger build, existing Host test types, the existing authority/fence cases and required normal CI. Do not repeat native inputs or create a benchmark/matrix for this slice. Source cap and diff checks remain required. Review must verify that the old read/control body and all non-pair provider guard bytes are unchanged, and that no public action/parser/schema was widened.

### R32.6. Publication and acceptance boundaries

This is plan-only until root publishes the reviewed appendix and authorizes the four-source cut. Root is the only publisher. Preserve the already-queued ordinary R30 baseline run; do not update an active head or rerun an old failure merely to obtain faster feedback.

The source-level claim is limited to eliminating one repeated canonical acquisition for the final synchronous provider authority pair while retaining its original checks. The actual cause of the recorded namespace time, the amount attributable to this pair, Ready latency, and terminal completion remain unqualified until original R30 detail and the ordinary post-change native gate are read with their real platform/source/pin identities. Do not compare unlike lanes as a causal timing result. If the native gate still fails, retain its original input/receipt/cleanup and investigate that evidence without relaxing waits, permissions, unknown ownership or timeouts.

## Review 33 — group the original synchronous provider guard after the writer prelude

### R33.1. Original post-R32 evidence

The original source-host jobs at head `6d7449224b47924028b43a153cb249c2982a1b51`,
run `43548415982`, still fail the existing terminal assertion. Their receipt
bytes and hashes were read from the completed original logs and independently
verified, without replaying a model request.

| Job / platform | Host sampled us | Controller-lock sampled us | Directory sampled us | Tree sampled us | Requests / cleanup |
| --- | ---: | ---: | ---: | ---: | --- |
| 132305016744 / Windows x64 | 147469869 | 50497434 | 19930152 | 17657528 | 4 / true |
| 132305016769 / Windows ARM64 | 179073169 | 52150593 | 14036346 | 23298602 | 4 / false |
| 132305016820 / Darwin x64 | 218034488 | 89193225 | 13336502 | 20641410 | 0 / true |

Original receipt blobs are respectively `bc00b76b9d495e1292eda903c18b2966e89cecaf`,
`5dfb6baac323072a698c66e28d2b5b769b3816d5`, and
`a5b110ce2d4e4618c92603eac5ff5309161be9bb`.
The independently retained wrapper file has SHA-256
`f19ca9fdab4c5f36f099c14d2a81baee357691363c8d6996e80d9cb346e00419`
and 237680 bytes; it also retains the separate parent packaged failures.
These are the original whole-host sampled-stack partitions including cleanup,
not isolated function self-time or an input-only benchmark. The evidence does
not attribute all latency to a lock, prove cleanup on ARM64, or qualify native
performance. The original 90-second input and 120-second bootstrap limits remain.

### R33.2. Bounded source change and guard order

Keep R32's private provider admission/control pair. Its caller still performs
the original coordinator guard in separate synchronous Team fences before that
pair. A finite private callback can keep those existing checks within one
already-held Team fence. No predicate, source scan or state read is cached.

1. Pass an optional private `beforeTeamAuthority(entry)` callback from the
   coordinator through the existing member factory to the captured provider
   authority. It repeats only the original writer and captured-Team availability
   prelude, in that order, before touching any new Team lock. The old full
   coordinator/current callback still runs unchanged inside the grouped call;
   those two prelude checks therefore occur again. This is an explicit added
   check, not a claim that physical read counts are unchanged.
2. Add an optional synchronous fourth callback to the existing private
   `TeamOwner.authorizeRuntimeAccess` / `TeamDeliveryAuthority.runtimeAccess`
   composition methods. Accept it only for the literal `'provider'`; reject a
   supplied callback on `'read'` or `'control'` before doing their work.
   No Host method, DTO, permission or public runtime action gains a field.
3. On the provider branch, enter the same original `store.fenced`, invoke that
   callback, then run the unchanged `memberAuthorized(binding,'admit') &&
   runtimeAccess(principal,binding,'control')` pair. The callback executes the
   original full coordinator/current guard followed by the exact original Team
   object, binding, delivery, profile, configuration and principal comparisons.
   Use the originally captured Team owner for the outer grouping; mutable entry
   state cannot select a different outer authority namespace.
4. Preserve short circuit and error identity. A callback exception propagates
   verbatim through the original `finally`; it is not converted into a false
   authorization result. Missing optional composition port keeps the old guard
   order and old separate-call behavior for existing controlled consumers.
5. Keep every existing `TeamOwnerStore.fenced` validation, including validation
   before nested depth reuse. Keep controller acquisition/publication/release,
   per-await checks, source/account predicates, runtime reads and all original
   allocation and lifetime boundaries. The grouped callback is synchronous and
   ends before the original Runtime lookup or any await. No lock, token, boolean
   permission or state snapshot survives it. Do not use
   `withLaunchAuthority('read')`: that adds unrelated recovery/state work.

This changes repeated acquisition around a cohesive existing guard. It does not
change the controller dependency, namespace traversal, resource custody,
permissions, request counters, cleanup conclusions or native timeouts.

### R33.3. Exact existing paths and connected-source composition

| Existing path | Inspected repair / qualification preimage | Native preimage |
| --- | --- | --- |
| `packages/legacy-agent-host/src/composition/RuntimeTeamCoordinator.ts` | `da96d4667c7139e75d6990d6376b1980d0c9508c` | `ad6d518e15f4d9ad7100cbea42e8707b00588e49` |
| `packages/legacy-agent-host/src/composition/createRuntimeMemberProviderFactory.ts` | `53f4c270f1634a65f8eb465f11b7e2e59242ee22` | `966c5c6e758be51cde700073f6035bd5a4056d00` |
| `packages/legacy-agent-host/src/composition/captureMemberProviderAuthority.ts` | `bccb77ceb951a0fada6c1637211d2171926b561b` | `bccb77ceb951a0fada6c1637211d2171926b561b` |
| `packages/legacy-agent-host/src/team/TeamOwner.ts` | `42345e89da5ad5533c39d7f258a67e531207da3c` | `42345e89da5ad5533c39d7f258a67e531207da3c` |
| `packages/legacy-agent-host/src/team/TeamDeliveryAuthority.ts` | `857e9673a2f9d7f5a4cb9841b6adde81d108d42c` | `857e9673a2f9d7f5a4cb9841b6adde81d108d42c` |
| `packages/legacy-agent-host/tests/member-provider-authority.test.ts` | `e0cd4db39c3b201de59613585e94347448bb7516` | `e0cd4db39c3b201de59613585e94347448bb7516` |

These six files are the entire source/test scope. There are no new files.
Coordinator/factory/TeamOwner also participate in the already approved B2 and
live-membership work. This appendix is a plan, not permission to overwrite those
pending deltas: root must freeze their final connected blobs and record exact
post-composition preimages plus the small R33-only diff before source GO. Preserve
the native Windows-launch fields and the 800-line/frozen-file limits. No source
file cap or public contract is widened.

### R33.4. Existing focused regression and execution

Extend the existing real-store case in `member-provider-authority.test.ts`;
retain both existing test names, their original assertions and the R32 final-pair
proof. Use the original lock-token observation to check that the new full guard
and final pair see one still-held token, that it is absent after return/refusal,
and that a later independent call obtains fresh authority. A synthetic token
observation proves grouping only, not native latency.

Within that same case retain complete-request/current-generation, revocation,
foreign-principal, allocation/lifetime and cleanup assertions. Check the new
prelude refusal happens before any Team lock/read, the original inner callback
exception is preserved, and a supplied callback cannot enter read/control.
No production counter, permissions stub, new suite or native benchmark is needed.

Root serially runs the coherent Host build/test types and the existing authority
and fence cases, then source-size and diff guards. Ordinary exact-head native
and packaged jobs remain the performance and behavior acceptance gate. Keep
their original inputs, model/HTTP arithmetic, deadlines, output assertions and
cleanup requirements. A continued failure requires analysis of its new original
receipt; this plan grants no rerun or timeout increase.

### R33.5. Review and publication

Design review identified and incorporated the three requirements above:
unchanged callback exceptions, explicit rejection outside provider, and the
additional writer/availability prelude. Independent review of this exact
appendix precedes publication; independent review of exact frozen connected
source precedes delivery. Root commits and immediately pushes each reviewed
plan/source change with expected-head and readback checks. Active PR heads wait
for their current CI; no merge to main, activation or release is part of this cut.

### R33.6. Exact connected preimages and the existing thin delegate

The already approved R33 change uses the following frozen connected source, including B2, live membership and the R10 fresh-credential callback. These preimages replace the earlier inspection-only hashes in R33.3; the same six existing paths are the entire scope. No additional source file, test case, owner or public contract is introduced.

| Existing path | Repair / qualification preimage | Native preimage |
| --- | --- | --- |
| `packages/legacy-agent-host/src/composition/RuntimeTeamCoordinator.ts` | `5bc960019be8bfa884fd660522507cb3429feaa0` | `5195d41ecb9c57561bb34efd146b74f8e53078f6` |
| `packages/legacy-agent-host/src/composition/createRuntimeMemberProviderFactory.ts` | `adef6bf38b5278d2d968748fa21fbfc6cc0fb1a3` | `c0e97718f436e63b1dda033c65501d5d9026f516` |
| `packages/legacy-agent-host/src/composition/captureMemberProviderAuthority.ts` | `bccb77ceb951a0fada6c1637211d2171926b561b` | `bccb77ceb951a0fada6c1637211d2171926b561b` |
| `packages/legacy-agent-host/src/team/TeamOwner.ts` | `3418f77e61c48aa683060120b00d4c6f025fb1ab` | `3418f77e61c48aa683060120b00d4c6f025fb1ab` |
| `packages/legacy-agent-host/src/team/TeamDeliveryAuthority.ts` | `857e9673a2f9d7f5a4cb9841b6adde81d108d42c` | `857e9673a2f9d7f5a4cb9841b6adde81d108d42c` |
| `packages/legacy-agent-host/tests/member-provider-authority.test.ts` | `e0cd4db39c3b201de59613585e94347448bb7516` | `e0cd4db39c3b201de59613585e94347448bb7516` |

`TeamOwner.authorizeRuntimeAccess` remains a direct delegate to its existing `deliveryAuthority.runtimeAccess`. Its parameter tuple is derived with `Parameters<ReturnType<typeof createTeamDeliveryAuthority>['runtimeAccess']>` and forwarded unchanged. The one existing method therefore owns the exact three original arguments and optional fourth synchronous callback; there is no duplicate signature or new interface. This cohesive delegate simplification retains the 800-line limit without removing checks or changing formatting elsewhere. The other R33 semantics and the original two test names remain exactly as specified in R33.2 and R33.4.

The factory retains R10's independent fresh-preparation credential callback after `canAllocate`; grouping the original current guard does not move readiness consumption, credential verification, endpoint creation, allocation or any await. Coordinator and factory preserve every existing native Windows-launch field and forwarding path. Each variant is composed from its own frozen preimage. Root reviews the exact R33-only diff before publication and owns all compiler, test and original native acceptance runs.

## R34. Preserve the original scoped default-model controls in captured provider Settings

### Review 1 — actual frontend contract and failure

Both original mixed Desktop cases on head `5ca255671764862da273b65b8df18262cfdc0f82` reach Settings → Models but time out waiting for the original inheritance card. Original artifacts `14096340511` (344613 bytes, SHA-256 `b16024222eeda0531204d43abadd997eecaa5bff64155ec435c72738f3a374db`) and `14096490437` (317652 bytes, SHA-256 `ef3afe717ff44d91ad70d1fd1f2a0bdd72e43c8d1eaf4b815d55834b0e495e07`) show the legacy configured-model panel instead. Their failed receipts remain incomplete.

`core/domain/providerManagementView.ts::supportsScopedDefaultModelInheritance` requires the existing `configuredModels` field alongside project path and the three saved-default fields. The captured management adapter already reads the same saved preferences and returns those three fields when its original preferences store exists, but omits `configuredModels`. The unchanged original panel therefore selects its legacy branch deterministically. B2 readiness, a longer UI timeout, or a second click cannot repair that missing DTO field.

### Review 2 — two existing files, same captured catalog and authority

| Existing path | Exact common preimage | Change |
| --- | --- | --- |
| `src/features/runtime-provider-management/main/adapters/output/CapturedRuntimeProviderManagementClient.ts` | `6f7a206efdc28ccdbe97ea4ff282b600b4394161` | In the existing `preferences.store` view projection, return `configuredModels` from the already-read current catalog's configured or connected providers, using the existing `models` and `preferenceModelRows` helpers and the same resolved preferences. |
| `test/features/runtime-provider-management/capturedDefaults.test.ts` | `c880573ce82e498d91cc789d88c0d1552b851b17` | Extend the existing global-default case, including a fresh absent-preferences scope; preserve every original case name and mutation/probe oracle. |

Do not issue another catalog/probe request or manufacture a model when a summary catalog contains no model rows. An empty catalog projection is a supported empty list, while absence of the original preferences store still omits the capability field and keeps the existing unavailable diagnostic. Project/global/default inheritance and managed limits come from the same original captured preferences. Every projected row retains `availability: untested`, `proofState: needs_probe` and `requiresExecutionProof: true`; catalog presence never becomes an execution grant. Preserve the existing final `isCurrent` check, degraded refresh behavior, source ownership, API-key actions, native/default model semantics and all request counts.

The test fixture may expose its existing one model in the summary catalog for the existing global-default case, matching the original catalog schema. Assert the real `supportsScopedDefaultModelInheritance` predicate, exact default/proof fields, and one catalog request for a read-only view. A fresh absent-preferences scope inside that same existing global-default case must keep that predicate false. Do not add a suite, a synthetic renderer replacement, a new DTO/capability flag, or change the UI predicate/harness.

### Review 3 — checks and original acceptance

Root and an independent peer review the exact small diff against these preimages. Run the existing captured-defaults test file, the relevant renderer/main type gate, fast lint and source-size guard in the serialized slot. Publish each reviewed commit with immediate push and readback. Both original mixed V1/V2 Settings → Create → native conversation → cold reopen → physical cleanup cases remain mandatory with their existing controls, budgets, model counts and assertions. Passing this focused contract test does not qualify either Desktop journey.


## R34.1. Construct the absent-preferences TEST target without mutating its readonly contract

### Exact current failure and scope

Two ordinary pull-request runs at head `ea16834de1c133fcd2756965977064a97e82afba` fail the unchanged `tooling-quality` step `pnpm typecheck` with the same TS2704 at `test/features/runtime-provider-management/capturedDefaults.test.ts:167`: “The operand of a 'delete' operator cannot be a read-only property.”

| Run | Original failed job | Full original log blob |
| --- | --- | --- |
| `43570716994`, Windows official installer fresh and native OTA | `132374282347` | `ce6560a88cc8c2afb10a1b293a5dfee02537132f` |
| `43570716881`, Windows native updater predecessor feasibility | `132374282230` | `21f286f28b129120b46a11c68467e2f086cc8617` |

The exact workflow sources are `.github/workflows/updater-windows-ota.yml` `b3e0f2399762cbbe0ba1b207515be63267c8566e` and `.github/workflows/updater-windows.yml` `9fdb53189d0712a5111c00071677a0bdd6eff25d`. Their pull-request arm runs whole-workspace typechecking and then the existing controlled tooling checks. The native Windows input and installation arms require `workflow_dispatch`; their skipped result in these pull-request runs is intentional event gating, not evidence of an installer/native failure or a reason to dispatch new Windows work. No branch-protection or merge-policy status is inferred from the workflow names.

R34's fresh missing-store scope creates a `CapturedProviderManagement` target with preferences and then deletes its readonly `preferences` property before the first `loadView`. The runtime behavior exercised by the existing case is correct, but the synthetic construction violates the target's declared immutable contract. This is one TEST setup correction, with no production capability, API or guard change.

### Exact one-existing-file change

Only `test/features/runtime-provider-management/capturedDefaults.test.ts`, common preimage `d9ae6d299f6c089a6e33f4ecba61dfc57fc3f26f`, is in scope. Official reads confirm these same bytes in the current parent head and current qualification/native working trees; no variant substitution is needed.

Add a default-true third parameter `withPreferences = true` to the existing private `fixture(configuredAuthless = false, summaryModels = false)` helper. In the same original `const target: CapturedProviderManagement` literal, include `preferences: { projectRoot, globalRoot }` only when that parameter is true, using a conditional object spread. Keep the readonly target type annotation and every other target field, captured object, callback, directory, request, refresh and currentness behavior unchanged.

In only the existing global-default case's fresh missing-store scope, construct `await fixture(false, false, false)` and remove the subsequent `delete absent.target.preferences`. The target must lack its own preferences property from creation, before it is closed over by the original capture callback. Preserve the unchanged `loadView(input)` call, the real `supportsScopedDefaultModelInheritance(...)` false assertion and the `configuredModels` property-absence assertion. This retains the exact intended missing-store observation without an unsafe cast, a widened mutable type, a delete helper or a caller-side projection.

All original fixture calls keep the default-true behavior. Preserve all seven existing case declarations, assertions, model/catalog/probe counts, inheritance/default/limit behavior and source/current-context refusals. Do not add a suite or test case, change production/store/UI code, alter workflow conditions, skip typechecking, add an installation/native invocation, or change a timer, source-size baseline or resource limit.

### Review and actual gate

Root publishes this exact amendment before source work. Freeze the three small source hunks and full final file; exact inverse must restore `d9ae6d299f6c089a6e33f4ecba61dfc57fc3f26f`. Root and an independent peer check the absent-property construction and unchanged assertions/default branch. Root owns the canonical `pnpm typecheck` continuation and the existing captured-defaults file in the serial check slot, plus the applicable existing lint/size gate. Do not advance active live heads, rerun or cancel their workflows.

Previous runtime test success did not establish TypeScript validity; source review does not replace the currently failing canonical typecheck. Original mixed Settings/Create/native acceptance from R34 remains unchanged. The separate P11 fixture digest correction, V2 `runtime.open` refusal and process cold-UI startup heap failure are not part of this TEST change.
