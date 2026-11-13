# 05. Выбор модели, default и проверка перед запуском

Статус: реализован первый Host slice выбора embedded V2 model/variant; новые native/ Desktop E2E ещё не выполнены.
Область: существующие Desktop Create/Edit/Relaunch и Provider Settings для Claude, Codex, OpenCode V1/V2.
Результат: выбранные пользователем модель и применимые параметры доходят до реального нового запуска.
Команды `/model`, `/effort`, `/fast` работающей сессии принадлежат [03](03-session-commands.md).
Общий lifecycle доступного runtime-профиля принадлежит [06](06-runtime-installation-profiles.md).
Настройки native provider и лимиты принадлежат [07](07-provider-settings-extensions.md).

## 1. Неизменяемые исходные точки

- Product main: `777genius/agent-teams-ai@4a0e06277fe216d9f82dbbede362668fe46622ee`.
- Stage1: `777genius/agent-teams-ai@1d0f97f55de566036c970eab4f36b84620afdb3f`.
- Runtime текущего main: `0.0.160`, source `777genius/agent_teams_orchestrator@e13edcd3d4ffbecc0272ae30195cc6b15b710ee7`.
- Версии и engine `2.1.4` связаны через [main runtime.lock.json][M0]; подмена latest запрещена при сравнении.
- [M1] `ClaudeMultimodelBridgeService.mapRuntimeProviderModelCatalog`: модель и доступные efforts из native каталога.
- [M2] `openCodeV2ModelCatalog.findOpenCodeModelsBlockedOnV2`: неполный read-каталог не отвергает custom model из global config.
- [M3] `TeamProvisioningOpenCodeTeamConfigWriter.buildOpenCodeTeamConfig`: сохраняет model/effort участников.
- [S1] `launchConfiguration.applyLaunchConfiguration`: Claude/Codex/V1 уже отображаются; V2 ограничен захваченной моделью.
- [S2] `teamModelProbeRecipe.resolveTeamModelProbeRecipe`: общий выбор сохранённого/draft recipe и защита от устаревшего источника.
- [S3] `savedTeamModelProbe.captureSavedTeamModelProbe`: source/revision, journal, проверка актуальности.
- [S4] `OpenCodeV2ModelProbe.createOpenCodeV2ModelProbe`: реальный native probe, но только captured model/variant.
- [S5] `captureTeamModelProbeSelection`: отдельные ветви never-captured saved source и ранее созданного launch.
- [S6] `openCodeV2NoToolConfig`: model probe намеренно использует другую tool/permission policy, чем рабочая session.
- [R1] `OpenCodeV2LaunchPlan`: передаёт `member.effort`/`body.effort` в `variant`, затем в native selection.
- [R2] `OpenCodeV2RuntimeStatus`: read-каталог публикует пустой `supportedReasoningEfforts`; это отдельная UI-проекция.
- [R3] `OpenCodeV2DefaultModels`: project/global default уже сохраняются старым runtime после выбранной проверки.

## 2. Текущее поведение и доказанный разрыв

| Возможность UI | Baseline main | Stage1 | Действие |
| --- | --- | --- | --- |
| Выбор модели Claude/Codex/V1 | Сохранённая настройка участвует в launch | Основной mapping уже есть | Проверить existing journeys, чинить конкретное расхождение |
| Выбор другой OpenCode V2 модели | Launch принимает selectedModel, default хранится отдельно | Probe/launch допускают только captured pair | Достроить derivation до allocation |
| Default для проекта/всех проектов | Project → global → native fallback | Preference owner уже реализован | Соединить разрешённый default с фактическим recipe |
| Проверка модели до запуска | Native execution подтверждает выбранную конфигурацию | Есть journal и native probe | Не считать metadata/credential status выполненным probe |
| V2 effort/variant | Source переносит effort; picker может ничего не предлагать | Явный effort отвергается | Квалифицировать прежний допустимый saved/direct путь |
| Custom/global model | Read-каталог может её не перечислить | Captured provider ограничивает выбор | Использовать выбранную конфигурацию из 07 |
| Повторный запуск сохранённой команды | Настройки и текущий provider access сохраняют смысл | Есть canonical saved configuration | Проверить round-trip без silent default |

Source trace доказывает передачу V2 variant, но не успешное выполнение каждой модели.
В начале реализации нужен ограниченный baseline probe из 07: default и один объявленный native variant.
До его результата отсутствие вариантов в fixture не является основанием удалить сохранённый effort.
Если старый маршрут воспроизводимо отказывает, сохранить его точный предел и понятную причину.
Если маршрут работает, новый Host обязан выполнить тот же пользовательский сценарий.
Не обещать поддержку произвольных строк variant, которых выбранная native модель не объявляет.

## 3. Acceptance criteria

- 05-A1: Create/Edit/Relaunch сохраняют provider, model, effort и применимый fast/context без потерь.
- 05-A2: новый V2 запуск допускает другую проверенную модель, не меняя уже запущенную сессию.
- 05-A3: UI показывает выбранную модель; native readback подтверждает тот же provider/model/variant.
- 05-A4: probe и launch связывает один digest выбранных model/provider/config/limits/account/runtime inputs; purpose-specific policy различается явно.
- 05-A5: смена проекта, аккаунта, binary или config revision делает старый probe неприменимым.
- 05-A6: неуспешная проверка не сохраняет новый default и не удаляет прежний.
- 05-A7: успешно записанный default остаётся записанным при ошибке последующего refresh; UI не заявляет rollback.
- 05-A8: очистка project default возвращает global/native fallback, не переписывая другие проекты.
- 05-A9: отказ/отмена завершают исходный native probe и его owned process; повторный prompt сам не запускается.
- 05-A10: отсутствие модели в неполном каталоге само по себе не запрещает существующий configured model.
- 05-A11: ошибка legacy saved choice видна до allocation; она не превращается в другую модель.
- 05-A12: live slash controls не реализуются вторым путём через prelaunch API.

## 4. Минимальная архитектура и повторное использование

Оставить `RuntimeProviderManagementPort` и существующие feature DTO точкой входа UI.
Не создавать отдельные model registry, capability service или новый framework профилей.
`FileManagedProviderPreferences` остаётся единственным владельцем project/global default.
`savedTeamModelProbe` и `ModelProbeOwner` остаются владельцами исходной проверки и её результата.
`captureSavedTeamModelProbe` применим только до первого runtime capture; Edit/Relaunch с историей использует existing captured-launch ветку S5.
`applyLaunchConfiguration` остаётся общим чистым mapping app choices → private native recipe.
План 06 предоставляет неизменяемый base profile и его revision; 05 выводит launch-specific candidate.
Смена модели в одном draft не публикует её как глобальный runtime default для других команд.
Сохранять существующие provider-specific проверки: Claude context/effort, Codex effort/fast, V1 variant.
Для V2 разрешать новый native pair только из проверенного selection context, до создания session.
Внутри main/Host хранить структурированную пару provider/model; не угадывать её по неоднозначному slash.
Renderer передаёт существующий app choice, а не executable path, произвольный config или credential material.
Default preference, captured profile и active session имеют разных владельцев и не должны дублировать состояние.
Общий selection digest не включает operationId/sessionId, probe-agent имя и deny-all tool policy; эти различия проверяются отдельно по назначению.
Для credentials сохраняется account/resource binding и его действительность; секреты не включаются в public proof metadata.
Такая привязка фиксирует выбранный auth source/namespace, а не обещает неизменность содержимого внешнего credential файла.
Явные login/logout/credential mutations сохраняют прежнюю семантику; при исчезновении доступа возвращается реальная ошибка,
без копирования токена в profile revision или автоматического выбора другого account.

## 5. Порядок реализации и контракты

### 05.1. Зафиксировать baseline без создания новых механизмов

1. Сопоставить current UI model/default/effort controls с существующими DTO и saved member settings.
2. Прочитать pinned R1–R3 и исполнить bounded capability cases 07-G1/G2 в отдельном test project.
3. Записать exact native version, выбранный route и результат default/variant; секреты не сохранять.
4. Проверить пределы допустимого custom model по selected config, а не по наличию строки в read-каталоге.

### 05.2. Связать выбор и проверяемый candidate

1. В `CapturedRuntimeProviderManagementClient.ts` сохранить исходный project/account/catalog context команды.
2. В `capturedManagementCatalog.ts` переносить подтверждённые native IDs и variants, не выводить их из displayName.
3. В `teamModelProbeRecipe.ts` разрешить V2 candidate из выбранного provider recipe и app model choice.
4. В `savedTeamModelProbe.ts` включить selection digest в existing journal/currentness для saved и captured-launch ветвей S5.
5. В `OpenCodeV2ModelProbe.ts` проверять candidate, а не разрешать произвольный запрос поверх старого профиля.
6. `limits` и provider config приходят из 07; их схема не дублируется в model selector.
7. Возвращать обычный существующий model-test result; дополнения контракта должны иметь одного владельца.
8. Не требовать побайтового равенства no-tool probe config и working session: сравнивать общий selection, отдельно подтвердить обе policy.

### 05.3. Применить тот же выбор при launch

1. Изменить `launchConfiguration.ts` только после появления проверяемого V2 derivation из 05.2.
2. `runtimeCaptureSource.ts` и `executeTeamLaunch.ts` получают тот же effective choice и revision.
3. Проверить native readback в `OpenCodeV2ModelVariant.ts`/owned session до принятия пользовательского input.
4. Не ослаблять custody, protocol/version, permission и identity проверки ради прохождения новой модели.
5. Для saved/relaunch сохранять native session history binding отдельно от следующего launch candidate.
6. Старая работающая сессия продолжает свой captured model; перевод active session принадлежит 03.

### 05.4. Defaults и UI завершение

1. `setDefaultModel` сначала проверяет выбранный candidate, затем пишет existing preference store.
2. Отдельно отразить «сохранено, обновление списка не удалось», как требует R3.
3. `clearProjectDefaultModel` меняет только project preference и повторно вычисляет fallback.
4. `CapturedRuntimeProviderStatusClient.ts` отображает доступные варианты и выбранный default без ложной auth proof.
5. Использовать существующие model picker/effort controls; не добавлять второй экран выбора runtime.
6. Собрать PR после устойчивого контракта 06 и выполнить реальные Desktop journeys ниже.

## 6. Зависимости и владение изменениями

| Участок | Единственный writer | Потребитель |
| --- | --- | --- |
| Publication/base profile revision | 06 | 02, 03, 05, 07 |
| Prelaunch model/variant derivation | 05 | Create/Edit/Relaunch |
| Provider config/limits transformation | 07 | 05 probe и 06 source capture |
| Account/auth capture | 02 | 05 через existing management target |
| Live command admission/readback/persistence | 03 | Существующий chat UI |
| Общая статусная проекция | 06 владеет runtime identity, 05 model rows | Последовательная интеграция по согласованному diff |

05 и 07 могут параллельно менять собственные adapter helpers и E2E scenarios.
`runtimeCaptureSource.ts`, `launchConfiguration.ts` и management contract нельзя редактировать одновременно.
05 публикует mapping patch после контракта 06; 07 вносит config additions отдельным последовательным diff.
Если 03 нужен тот же validator, он импортирует существующую чистую функцию через public boundary.
Новая live state machine в этот план и оценку не включается.

## 7. Реальные E2E journeys

Все сценарии выполняются в test-only проектах через Desktop `pnpm dev:mcp` и CDP.
Запуск browser-only UI или mocked Host receipt не закрывает native acceptance.
Настоящий pinned native engine с localhost model fixture допустим: fixture должен наблюдать фактический request/variant.
Vendor access квалифицируется отдельно при выделенном test account; обычные E2E не читают пользовательские credentials.

1. **05-E1 — Create + другая модель.** Выбрать V2 model B вместо captured A, выполнить Test, создать команду.
   Проверить UI выбор, native model/variant readback, один короткий ответ и завершение owned процесса.
2. **05-E2 — Defaults.** Записать global A, project B; перезапустить app; новый проект берёт A, исходный B.
   Очистить project default; убедиться, что следующий launch использует A, а активная B не изменилась.
3. **05-E3 — Saved/relaunch.** Сначала проверить never-captured saved draft, затем Edit/Relaunch уже captured Team для применимых providers.
   Native конфигурация каждого supported route совпадает с UI; unsupported choice даёт прежнюю явную причину.
4. **05-E4 — Гонка выбора.** Начать probe A, сменить project/account/model на B до завершения.
   Результат A не разрешает запуск B и не сохраняет B default; исходный probe корректно закрывается.
5. **05-E5 — Custom model.** Объявить модель только в применимом global/project config из 07.
   Проверить модель через существующий UI, затем launch; неполный read-каталог не блокирует её автоматически.
6. **05-E6 — Variant и сбой.** Для exact baseline, квалифицирующего variant, выполнить его и подтвердить native readback;
   затем недопустимый variant/отказ доступа сохраняет старый default и не создаёт ложную успешную проверку.
   Если exact baseline доказанно не поддерживает variant, сохранить его явный native refusal как отдельный unsupported outcome,
   а не успешный variant test. Пустой/неполный catalog сам по себе такого доказательства не даёт; положительная проверка
   owned embedded `2.1.4`, чей native variant contract установлен в §10, остаётся обязательной.

Критичные новые tests: candidate/source revision mismatch, captured/saved branch admission и cancellation boundary.
Неоднозначный ID, default precedence и successful-write/failed-refresh расширять только при изменении соответствующего validator; existing suites переиспользовать.
Не дублировать весь E2E сценарий десятками mock-тестов каждого внутреннего вызова.
Один contract test проверяет передачу тех же choices через существующий IPC; public API остаётся прежним.

## 8. Оценка и критерии завершения

- Production: **1 050–1 850** новых/существенно изменённых строк, включая bounded V2 variant mapping.
- Tests/E2E: **850–1 500** строк; ориентир 700–1 250 E2E и 150–250 критичных/contract tests за счёт reuse existing suites.
- Это бюджет, не цель заполнения строками; переносы, generated files и существующий harness не считаются.
- Общая publication machinery из 06, config mapping из 07 и live slash logic из 03 здесь не учтены повторно.
- Сложность: **7/10**; ожидаемая надёжность после acceptance: **8/10**; уверенность оценки: **7/10**.
- До probe нельзя выдавать ожидаемую надёжность за измеренную вероятность отсутствия багов.
- Done: acceptance 05-A1…A12, native evidence 05-E1…E6, relevant CI на точном PR head.
- Evidence содержит commit, runtime/artifact digest, выбранные native IDs, outcome и cleanup receipt.
- Ошибка версии/credential не закрывается статусом skip; исправляется доступное или фиксируется конкретная внешняя причина.

## 9. Ревью плана

**R1 — собственное критическое ревью выполнено 2026-11-12; исправления внесены в этот текст.**
Найдено: прежняя оценка могла принять пустой V2 effort picker за отсутствие работающего variant пути.
Исправлено: добавлены pinned R1/R2, mandatory baseline qualification и native readback в 05.1/05.3/05-E6.
Найдено: general profile publication могла дублироваться между моделями и installer.
Исправлено: 05 выводит launch candidate; единственный publication owner и его бюджет находятся в 06.
Найдено: успешная запись default с упавшим refresh могла выглядеть как неуспешная запись.
Исправлено: acceptance 05-A7 и шаг 05.4.2 сохраняют известный результат записи.
**R2 — независимое source review выполнено 2026-11-12; reviewer `estimate_account_commands`, reviewed commit `92d88845657e845f9b5080c1617245342c7061ab`.**
Найдено: требование одинакового полного config digest конфликтовало с фактическим no-tool probe и рабочими native permissions.
Исправлено: A4 и 05.2 связывают общий selection input; operation/session/purpose-specific поля проверяются раздельно.
Найдено: акцент только на savedTeamModelProbe пропускал запрет saved source при наличии runtime history.
Исправлено: S5, шаг 05.2.4 и E3 явно покрывают captured-launch ветку, а не ослабляют её guard.
Найдено: 400–650 строк unit/contract повторяли уже имеющиеся preference/normalization tests.
Исправлено: новый unit объём ограничен опасными admission/cancel cases, E2E остаётся главным доказательством.
Native engine + observable localhost response отделены от mocked Host receipt и отдельной vendor qualification.
**R3 — интеграционное ревью, выполнено root 2026-11-12; входной published SHA `cda065d869ccffb5930ed2a817b3e0654b00bb31`.**

- Перепроверены capture/restore в `DesktopBackendFeature`, immutable admission coordinator и границы P02/P03/P06/P07.
- Найдено: immutable account binding можно ошибочно прочитать как snapshot secret bytes. Уточнён original source/namespace, сохранена семантика явных auth mutations без нового token store.
- Подтверждено: draft model derivation не публикует общий pointer; probe и launch сравнивают selection, а их tool policies остаются разными.
- Selection/config/next-launch/restart — один совместный E2E с P06/P07/P10; новый unit suite на каждый mapper не нужен.
- План принят для реализации после минимального P06 contract; G1/G2 native results и captured Edit/Relaunch остаются критериями приёмки.

## 10. Первый implementation slice и повторная проверка

**2026-11-12, P05 model/variant foundation; acceptance остаётся открытым.**

### R1 — native contract и минимальное изменение

- Pinned engine `2.1.4` публикует named variants в `Model.variants`; native `withVariant` применяет только объявленный ID, а `default` означает отсутствие override. Проверены `core/dist/types/model.d.ts` и `core/dist/chunks/location-xewrm1yq.js` из закреплённого engine graph.
- D `old-provider-implementations@4a42ab8cefb9421325c36a91983af4a4d598f46d` добавляет в existing `readCatalog` только список variant IDs. Settings/headers/body не попадают в public catalog. Existing protocol tests расширены двумя критичными проверками malformed/duplicate variant и отсутствия private settings; новый registry не создаётся.
- `openCodeV2ModelSelection.ts` выводит native pair из existing UI choice до allocation. Смена provider удаляет private configuration предыдущего provider; executable/environment/account/engine остаются исходными. При смене модели прежний variant не наследуется молча.
- `launchConfiguration` и finite model probe применяют общий derivation. Старые externally owned V2 `2.0.0/2.0.21` сохраняют прежний captured-only предел; новая возможность относится к owned embedded `2.1.4`.
- `OpenCodeV2ModelSelection` читает actual native catalog перед `session.create`: выбранный model должен быть enabled/default для этого captured config, variant — объявлен, а рабочая Team требует native tool capability. После await повторяется original owner/deadline fence. Это проверка допуска, не второй model journal.
- Saved Default может выбрать текущую private model/config recipe для нового embedded запуска. Account/environment/executable/engine identity сравниваются прежним способом; история уже running session не переписывается.

### R2 — проверка границ и компактные tests

- Перепроверены bare/qualified model IDs, provider-prefixed native ID, foreign provider configuration, engine drift и отмена до allocation. Existing saved/create/journal tests переиспользованы; добавлен один короткий critical native-catalog admission case.
- P02 credential capture теперь отказывает уже при revoked construction. Existing regression test проверяет оба момента: отозванный owner до preparation и потерю authority после preparation до run; оба не создают child/namespace.
- Host build и test types — PASS. Четыре existing suites (`opencode-v2-model-probe`, `saved-team-model-probe`, `management-model-probe`, `team-create-launch`) — **56/56 PASS**. Fast lint — 0 errors; deliberate control-character ID regex имеет existing warning class. Source size guard — PASS, limit 800 не увеличен.
- D full `pnpm check` — PASS на Node `24.21.0` и `26.11.1` перед публикацией variants slice. Следующий immutable consumer pin должен включать этот commit; старая projection без variants отказывает, а не выдаёт ложный PASS.

### R3 — наблюдаемое native доказательство и остающаяся работа

- Existing `opencode-v2-model-probe.native.ts` теперь должен выполнить original model A, другой model B с объявленным `high`, затем отменённый B/high. Actual HTTP body обязан содержать правильные model/`reasoning_effort`, tools отсутствуют; неизвестный variant не вызывает четвёртый model request. Cold recovery использует original journal без replay.
- Existing `opencode-v2-embedded-host.native.ts` выбирает B/high через production `applyLaunchConfiguration`; все 11 фактических native model requests, Team tools, attachment и cold restore проверяют этот выбор. Workflow требует новый `modelSelection` receipt и точные probe observations.
- Эти native journeys подготовлены и typechecked, **ещё не исполнены**. Local socket/Desktop ограничение не обходится; native proof выполняется штатным remote CI после нового D pin. Они не заменяют Desktop Create/Edit/Relaunch acceptance.
- Ещё открыты: 07-G1/G2 baseline/selected config, project/global Default → actual new launch, custom global/project declarations, full Desktop 05-E1…E6, и проверка конкретных existing Claude/Codex/V1 choices в общем acceptance. Первый slice не объявляет весь P05 завершённым.

## 11. Review исправления credential verification model — 2026-11-13

Источник повторного аудита: exact frontend `522c80d168d698fc6842ee649cc4822406cd2632`,
PR #1186 threads `PRRT_kwDORVTEtM620TRR` и `PRRT_kwDORVTEtM62675X`.
Комментарии сверены с исходниками; они сами по себе не считаются доказательством поведения.

### R1 — конкретный разрыв и минимальное изменение

- В `OpenCodeV2CredentialOperation.ts` после native key connection выбирается enabled model текущего provider;
  fallback может отличаться от `profile.nativeModel`. Сейчас новый pair записывается в копию profile до общего
  `selectOpenCodeV2ManagementModel`, поэтому старый `variant` ошибочно выглядит выбором для новой модели.
- Вывести verification profile из **исходного** profile через уже существующий `selectOpenCodeV2ManagementModel`
  (`composition/openCodeV2ModelSelection.ts`). При смене pair прежний variant снимается; при том же pair сохраняется.
  Никакого нового effort/default не назначать. Private provider configuration сохраняется только для прежнего provider.
- Original command/provider, auth publication, native credential witness, cleanup и единственная verification operation
  остаются у прежних owners. Это исправление derivation до probe, не новый credential retry или повод повторить Connect.

### R2 — повторная проверка границ и доказательства

- Не менять actual выбранную модель команды ради credential check; речь только о конечной проверке уже выбранного key provider.
  Не превращать unsupported variant в успешную проверку и не переносить private settings чужому provider.
- Расширить existing selection case в `opencode-v2-model-probe.test.ts`: same pair сохраняет variant,
  model/provider fallback снимает его, исходный profile неизменен. Не добавлять отдельную mapper suite.
- В existing `opencode-v2-credentials.native.ts` использовать original pair с отличающимся variant и enabled fallback,
  сохранив прежние четыре native requests, wrong-key correction, no-tool prompt, lost outcome и cleanup assertions.
  Actual verification request должен выбрать fallback без чужого variant; remote native result проверяется отдельно от типов.
- Уточнение 05-E6 выше различает подтверждённый unsupported baseline и обязательный positive `2.1.4` путь.
  Существующие negative/default-preservation проверки не становятся optional.
- Статус: план до source change. Независимое review, compile и actual native acceptance ещё не объявлены выполненными.

[M0]: https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/runtime.lock.json
[M1]: https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/main/services/runtime/ClaudeMultimodelBridgeService.ts
[M2]: https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/features/runtime-provider-management/core/domain/openCodeV2ModelCatalog.ts
[M3]: https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/main/services/team/provisioning/TeamProvisioningOpenCodeTeamConfigWriter.ts
[S1]: https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/composition/launchConfiguration.ts
[S2]: https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/composition/teamModelProbeRecipe.ts
[S3]: https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/composition/savedTeamModelProbe.ts
[S4]: https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/adapters/providers/OpenCodeV2ModelProbe.ts
[S5]: https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/composition/savedTeamModelProbe.ts
[S6]: https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/adapters/providers/OpenCodeV2EmbeddedConfig.ts
[R1]: https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/services/opencode/bridge/OpenCodeV2LaunchPlan.ts
[R2]: https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/services/opencode/catalog/OpenCodeV2RuntimeStatus.ts
[R3]: https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/features/runtimeProviderManagement/adapters/opencode/OpenCodeV2DefaultModels.ts


## 12. Captured MCP Desktop: exact label text beside the real Checkbox (plan, 2026-11-13)

### Review 1 — actual new-head failure and source cause

On exact [9ea802cc](https://github.com/777genius/agent-teams-ai/tree/9ea802cc0f8c873c8349512cb010fe54e34fdd70), Main run43420487453/job131868952753 completed the original mixed Create/Launch flow with PASS at12:08:47, including its original cold readback. The later, separate captured-MCP flow failed before Launch: `UI read timed out: original scope before click; no mutation retry`. Its original artifact14033859930 has ZIP SHA256 `3e277ab923807575434334411cb5d2efef472d67ac46445b58632a10950b7360`; the retained yAGbHF receipt SHA256 is `02cc986718f0bec6717589ce3eddf4fab1dddfa459bcdf8de0b06b0ea2881b33`. Source and archive hashes were checked before inspection. The last attempted control selected Strict allowlist. The saved dialog shows that mode and all three scope controls; model business requests are0, probes3, failures0. Ordinary Quit exited0 and its process group is empty. This failure supplies no evidence about MCP invocation, permission or Runtime cleanup after Launch, because none was reached.

In [desktop-opencode-v2-mcp-ui-proof.ts](https://github.com/777genius/agent-teams-ai/blob/9ea802cc0f8c873c8349512cb010fe54e34fdd70/scripts/legacy-agent-host/desktop-opencode-v2-mcp-ui-proof.ts) (blob `e53aba0500f9bfba076aa59f4fecc7e58064a7f2`), both scopeState and scopePoint identify a label through `label.querySelector("span")`. [MemberMcpPolicyPanel](https://github.com/777genius/agent-teams-ai/blob/9ea802cc0f8c873c8349512cb010fe54e34fdd70/src/renderer/components/team/members/MemberMcpPolicyPanel.tsx) (blob `4036800813841d598a84c3c14341104bb204be27`) renders the real Checkbox followed by its direct text span. [Checkbox](https://github.com/777genius/agent-teams-ai/blob/9ea802cc0f8c873c8349512cb010fe54e34fdd70/src/renderer/components/ui/checkbox.tsx) (blob `9ad642ea9550b2fc20d6d074111dfbf8bf93c9dc`) renders a nested Radix Indicator span containing the check icon. When checked, that earlier descendant span has no scope text, so the helper cannot match the original user label. English scope text remains lowercase; CSS capitalization in the saved visible dialog is not a localization defect. Existing MemberDraftRow tests mock Checkbox as an input and do not establish this actual Radix DOM shape.

### Review 2 — one existing TEST file, two exact selector corrections

After root publishes this append, change only the two label-text queries in scopeState/scopePoint to `:scope > span`. Keep the original captured member-row selector, exact scope text, exactly-one-label refusal, original role=checkbox identity, checked/disabled assertions, physical geometry/hit checks and once-only click. No production component, label, CSS, translation, grant, profile, native owner, model oracle, input count, timeout or workflow changes. Readback of checked, unchecked and disabled app-only scopes continues through the same original controls. No fallback to a different member, positional checkbox index or a synthetic expected state.

### Review 3 — bounded validation and honest qualification

Independently review both replacements against the original component. When pinned local dependencies finish installing, use one isolated TEST DOM rendering of the actual Checkbox and original label structure to demonstrate the old descendant query selecting the empty checked indicator, and the corrected direct-text query selecting the same user/project/local label in checked, unchecked and disabled states. This read-only DOM proof creates no app/Host/native actor and is not a native MCP PASS. Run the existing relevant script types/lint; no new generic helper or unit suite is warranted for two TEST selectors. The next ordinary captured-MCP Desktop gate must still establish its full original five business requests, separate bounded probes, actual captured policies/actors, original Allow once, all-member Stop and cold settings readback. Its remaining INCOMPLETE outcomes stay failures. Root remains sole publisher; source bytes have not changed at this plan boundary.


## 13. Settings defaults and visible V1 limits through the existing mixed Desktop lanes (plan, 2026-11-13)

### Review 1 — exact frontend behaviour and the remaining proof

This is an acceptance gap, not a claim that the current product path is broken. On exact frontend [4a0e0627](https://github.com/777genius/agent-teams-ai/tree/4a0e06277fe216d9f82dbbede362668fe46622ee), [OpenCodeDefaultModelInheritanceCard](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/features/runtime-provider-management/renderer/ui/OpenCodeDefaultModelInheritanceCard.tsx) exposes separate all-projects/project choices and the original “Use default” action. [ModelRow](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/features/runtime-provider-management/renderer/ui/RuntimeProviderModelRow.tsx) supplies Test and selection, through [useRuntimeProviderManagement](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/features/runtime-provider-management/renderer/hooks/useRuntimeProviderManagement.ts). These are the same ordinary UI surfaces that the Host route must support.

The old [OpenCodeLocalModelLimitsCard](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/features/runtime-provider-management/renderer/OpenCodeLocalModelLimitsCard.tsx) is inside the lead/member model controls, not the Settings defaults card. It shows only a genuinely local provider/model with a configured-local route and performs the original Configure → native verification → Save. The [local route classifier](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/shared/utils/opencodeModelRoute.ts) includes `local`; it does not classify the existing TEST provider `test-local` as local. Do not synthesize route metadata or change that classifier to make an editor appear.

The current [capturedManagement.safe-e2e](https://github.com/777genius/agent-teams-ai/blob/6405e93f4a8db67ceab835ddcee23ed6a829b7fe/test/features/runtime-provider-management/capturedManagement.safe-e2e.test.ts) covers IPC selection, project clearing, saved limits and restart with a TEST executable. It does not establish Renderer clicks or genuine-provider consumption. The existing [mixed Create/Launch journey](https://github.com/777genius/agent-teams-ai/blob/6405e93f4a8db67ceab835ddcee23ed6a829b7fe/scripts/legacy-agent-host/desktop-mixed-create-launch-ui-smoke.ts) establishes the real three-provider path, but uses an explicit OpenCode model and has no Settings mutations. Its first Edit boundary currently reloads the renderer rather than restarting the application.

Current source supplies the small seams needed: [captured preferences](https://github.com/777genius/agent-teams-ai/blob/6405e93f4a8db67ceab835ddcee23ed6a829b7fe/src/features/runtime-provider-management/main/adapters/output/CapturedRuntimeProviderManagementClient.ts) uses the existing original target and FileManagedProviderPreferences; saving a configured-authless default invokes one native probe even when Renderer sends `probe:false`. [runOpenCodeModelProbe](https://github.com/777genius/agent-teams-ai/blob/6405e93f4a8db67ceab835ddcee23ed6a829b7fe/packages/legacy-agent-host/src/adapters/providers/runOpenCodeModelProbe.ts) checks the actual native selected-model limit before the ordinary no-tool request. No new store, selection authority, production UI or public RPC is needed for this planned proof.

### Review 2 — one extension of each existing invocation

Use the two already-existing mixed V1/V2 invocations in ci.yml. Extend each original journey; do not add a job, matrix row, second complete mixed journey, separate native suite or product UI mode. Keep the existing Claude/Codex choices, Team tools, group messages, isolated Bob Restart, Stop and final readback. Share one directly consumed TEST Settings helper and the existing CDP controls.

1. **Prepare two real captured choices before any app exists.** In the existing private fixture declare model A `TEST-model` and distinct model B `TEST-project-model`, served by the same finite loopback model endpoint. V1 uses the genuine configured-authless `local` provider; V2 keeps its existing `test-local` provider and pinned embedded engine. Both choices must appear in the actual native catalog. Their declared context/output values are distinct. Keep executable/engine/account/owner identities, endpoint custody, native context and existing business model A unchanged. Add only the original descriptor's global and project preference roots inside the TEST root, using the same descriptor schema as capturedManagement.safe-e2e. Stage a second empty TEST project/context through existing TEST fixture setup if needed for the ordinary project picker; never use a real folder or native folder dialog. Do not prewrite the expected defaults or selected limits.

2. **Run Settings before the one original Create.** Navigate through the ordinary Settings/provider management controls using real CDP Input. Capture the exact selected TEST project and the original inheritance card. Choose global A once, await the original saved/readback outcome, choose project B once, then press the original Test B once. Require the actual three no-tool requests in order A, B, B; the B Test result must belong to the captured provider/model and show success only after that request. Read the original private preference files after the UI actions to correlate what was saved; file reads are evidence, not mutations. View the second TEST project to establish inherited A without writing its project preference; return to the first project, clear its override once, and require UI/project readback A with the project model absent and global A unchanged. Returning to Settings must not replay an action.

3. **Use the one original Create for the limits control.** Continue the existing Create form and rich mixed settings, not a second temporary Create. Give Carol the OpenCode provider through the existing controls/roster input, leaving its model to the actual current default rather than inserting A through TEST JSON. Read the effective visible A and what the application actually persists. For V1, require the actual local card for A, enter context `65536` and output `1536`, and press Apply & verify once. Require the actual fourth no-tool request with the selected model/limit, success plus saved override, and no tool effects. For V2, retain its declared model limits and record the actual existing card state; do not invent, enable or exercise a V2 editor.

4. **Keep experimental-local semantics explicit.** Observe the original local-model override as false before changing it. For V1 use the ordinary visible override when the native local choice requires it, and assert the resulting Launch request/recipe; V2 retains its original false behaviour. Old4a and current Create save-only omit allowExperimentalLocalModels from createConfig, while the live Launch request has its own override. Do not assert that Save-only persisted a true value which it did not write. Preserve this distinction and the exact saved settings; if Launch requires the original checkbox again, perform that one explicit user action. No automatic grant, forged readiness or blanket relaxation of model checks.

5. **One real cold boundary after Save.** Save the original Team once and perform its existing Edit description/Save once. Replace the first existing post-Edit Page.reload with one ordinary captured app Quit and one same-profile cold startup, then perform the same Edit hydration/Cancel assertions. Reuse restartCapturedDesktopApp with an explicit TEST `settings-saved-before-launch` boundary, not an additional restart harness. At this boundary every provider's business observations must be zero, the created Team has no Runtime capture/delivery, and only legitimate never-opened static records may exist. Capture the original metadata children/lineage through the existing read-only witnesses; require their actual release/absence, original app exit0/null, empty original process group and released original Host writer before the sole successor spawn. Preserve exact Node, Host entry, build, profile, descriptor, source/bundle hashes, owner/handle and TEST HOME. No rebind, synthetic cleanup, process adoption or fallback signal qualifies this boundary.

6. **Prove persistence and actual consumption.** Retain hashes of the original preference files, saved roster/settings/receipt and completed model-probe records before Quit; verify them after cold startup and read the same Settings/limits values. Require exactly one successor app/Host with a new physical identity after original absence. Replace stale CDP/UI handles in the existing caller, then continue the same original Launch dialog, preflights and once-only Launch. V1 must show A and the saved override and its actual native business requests must use model A/output1536; selected native configuration must retain context65536. V2 must use A with its original declared limits and no V1 override. Correlate the source selection/configuration and current member capture with that native request; a UI label or saved file alone is not success. Preserve the existing MCP/native effects and real user replies. Active-session immutability and failed-save/refresh cases remain covered by their existing controlled/native cases; this positive UI journey does not silently claim new failure injection coverage.

### Review 3 — exact accounting, small implementation boundary and acceptance

- The new Settings work contributes exactly **4 V1 / 3 V2 no-tool model requests**: global save A, project save B, explicit Test B, and V1 Apply & verify A. These are added to the existing ordinary Create/Launch probe budget and existing business turns; no counter is reset, truncated or hidden. Retain all probe observations and a closed purpose/step projection. A finite original Settings expectation permits exactly one request for each corresponding UI intent and rejects another model, tools, a duplicate or a request after that expectation closes. The existing ordinary OpenCode probe allowance remains8, Claude's original native/cold budgets remain unchanged, and Codex's original budget remains unchanged. The native inference total is the sum of all retained categories. If actual ordinary UI scheduling produces an additional effect, retain the original failure and diagnose it; do not silently increase the allowance or replay the click.
- Use the existing 30s read/90s UI/preflight and original native operation budgets. The one cold startup uses the existing guarded startup/cleanup bounds. Do not extend the job timeout, model response timeout or process cleanup window. Read-only polling may wait inside its original deadline; mutation retry, second Create/Launch, duplicate Test/Save and automatic restart retry are forbidden.
- Keep the preference descriptors/file roots and two-model declarations in `desktop-mixed-native-fixture.ts`, with the small optional recipe declaration in `desktop-opencode-v2-fixture.ts`; non-mixed V2 fixtures retain their original single model. The directly consumed Settings helper may be `desktop-mixed-provider-settings.ts`. Reuse `desktop-mixed-dialog-settings.ts`, `desktop-mixed-edit-team-ui.ts`, `desktop-mixed-create-launch-ui-smoke.ts`, `desktop-captured-app.ts` and their current smoke caller for the UI/cold boundary. Keep native request validation/accounting in the existing OpenCode TEST model helper. Add the direct helper to the existing source-freeze inventory and require the finite new proof in the existing two ci.yml receipt assertions. No unrelated production adapter change is authorized by this acceptance plan.
- Extend only the existing relevant fixture/model case for the critical phase/count/model/limit rejection and preserved total accounting. Existing script/Host test types, focused tests, lint and source-size guard validate the cut; no unit suite for selectors, each getter or a new generic browser driver. Before publication, review the exact catalog/descriptor scope, original preference currentness, metadata cleanup and counter conservation independently.
- Existing mixed evidence remains visible. The added receipt separately records original UI attempts, saved global/project results, fallback, V1 card/verification (or V2 declared-limit route), full cold boundary, selected capture and native request facts. Missing/held/unknown readback or failed cleanup leaves the original result INCOMPLETE; no raw account, token, arbitrary command, config body or ambient path is emitted.
- Both unchanged lane identities must pass their full ordinary native Desktop acceptance on the new coherent source and pinned artifacts. Source review, direct IPC tests, model response stubs and renderer reload are not substituted for this result. This append is plan-only; neither implementation nor a new native/UI execution has occurred. Root remains sole publisher and publishes the reviewed plan before source edits.

### §13 source clarification — the existing Default choice and V1 limits card

Exact current [CreateTeamDialog](https://github.com/777genius/agent-teams-ai/blob/7ce224d148205867d46fd2ca980a48e1b9e8c48b/src/renderer/components/team/dialogs/CreateTeamDialog.tsx) gives the roster editor raw members. [MemberDraftRow](https://github.com/777genius/agent-teams-ai/blob/7ce224d148205867d46fd2ca980a48e1b9e8c48b/src/renderer/components/team/members/MemberDraftRow.tsx) passes its effective model value to the existing limits card; the Default label may resolve A while that raw model value remains empty. Therefore the card need not be visible while Default is selected.

Within the same original V1 Create, first observe Default resolving to A, temporarily select that visible A through the ordinary model control, perform the one planned Apply & verify, then return to the ordinary Default choice before Save. Require the final raw member model to be absent/empty and the actual saved/requested effective recipe to inherit A. No harness JSON assigns A. Persisted limits remain keyed to that actual A and must be consumed by the original native Launch after cold startup.

This is only a clarification of the existing UI path: the four V1 no-tool requests, single Create/Apply/Save/Launch intents, cold boundary, actual output/context checks and V2 flow remain as planned. An extra automatic inference is retained as a failure for diagnosis; selecting A and returning to Default does not authorize a larger probe budget or a replay. Root verified the current source and accepted the narrow path before its implementation.


### §13 prerequisite — provider Settings availability without a legacy CLI pathname

**Review 1: exact current source and preserved availability semantics.** The captured status adapter deliberately returns `binaryPath:null` after original Host health succeeds; `installed:true` identifies that usable management transport, not authentication, model access or a Ready native provider. The three provider rows retain their independent status/failure projections. See [CapturedRuntimeProviderStatusClient](https://github.com/777genius/agent-teams-ai/blob/7ce224d148205867d46fd2ca980a48e1b9e8c48b/src/features/runtime-provider-management/main/adapters/output/CapturedRuntimeProviderStatusClient.ts), blob `947d5edece5d3cde5238881e3bd8e31b14ac700d`.

Two existing Renderer gates still require the retired shared CLI pathname:

- [CliStatusSection](https://github.com/777genius/agent-teams-ai/blob/7ce224d148205867d46fd2ca980a48e1b9e8c48b/src/renderer/components/settings/sections/CliStatusSection.tsx), blob `ecb7a1dbb204ca75d2d51de72e341606b28eb5b7`, disables Manage when `!effectiveCliStatus.binaryPath && provider.nativeAuthManagement !== 'claude'`. The button is already inside the installed-controls branch. Its own ProviderRuntimeSettingsDialog already receives `!effectiveCliStatus.installed || isBusy || cliStatusLoading`; the stale entry-button guard makes the OpenCode and Codex paths unreachable.
- [ProvisioningProviderRuntimeSettingsDialog](https://github.com/777genius/agent-teams-ai/blob/7ce224d148205867d46fd2ca980a48e1b9e8c48b/src/renderer/components/team/dialogs/ProvisioningProviderRuntimeSettingsDialog.tsx), blob `d05419011f92a0b899653c69782051dc97810ffd`, passes `disabled || cliStatusLoading || !cliStatus?.binaryPath`. This independently disables the original Create/Launch provider settings.

Opening these settings is not a native launch, credential grant or model verification. Preserve access to configuration, Install and Login after a provider-level failure, as the original dialog permits. Do not add a provider `supported`, `authenticated`, catalog-ready or model-proof condition. Claude's captured authentication route, Codex's account/install actions and OpenCode's management panel retain their original selected-provider loading/currentness/action guards and Main/Host authority. The existing [ProviderRuntimeSettingsDialog](https://github.com/777genius/agent-teams-ai/blob/7ce224d148205867d46fd2ca980a48e1b9e8c48b/src/renderer/components/runtime/ProviderRuntimeSettingsDialog.tsx), blob `87b55692a18e7f2816f0bfc6c7cbc59f1dd94d1a`, already composes `connectionBusy`, `codexActionBusy`, `runtimeBusy` and OpenCode's `disabled || selectedProviderLoading` independently of a successful model check.

**Review 2: the two narrow corrections and existing regression cases.**

1. In CliStatusSection change only the Manage button's disabled condition to `!effectiveCliStatus.installed || isBusy || cliStatusLoading`, matching its existing dialog. Keep the installed-controls/error branches, provider selection, status text, Connect/Disconnect handlers and all native actions unchanged. An absent/unconfirmed Host remains outside usable installed controls; a busy/global-loading host cannot initiate this settings interaction.
2. In ProvisioningProviderRuntimeSettingsDialog change only the pathname term to `!cliStatus?.installed`: the complete condition becomes `disabled || cliStatusLoading || !cliStatus?.installed`. Preserve the caller's busy/disabled state and unknown-installation refusal. Keep the existing `providerTerminal && cliStatus?.binaryPath` TerminalModal guard and real command unchanged. Do not synthesize a pathname, redirect terminal authentication or change any login policy in this correction.
3. Extend the existing [CliStatusSection.test.tsx](https://github.com/777genius/agent-teams-ai/blob/7ce224d148205867d46fd2ca980a48e1b9e8c48b/test/renderer/components/settings/CliStatusSection.test.tsx), base blob `3ab343687ad6ade5e1c9f01d70075142d4d06e49`: use captured installed/null-path status, click the actual OpenCode Manage button and require the original project/provider dialog to open. Preserve its model-only/no-auth/no-team-launch assertions and the existing unavailable-provider diagnosis. Within that case check loading disables the entry/dialog and missing Host does not expose usable Manage; these checks must not invoke a model, auth or replacement effect.
4. Extend the existing three-provider refresh case in [ProvisioningProviderRuntimeSettingsDialog.test.ts](https://github.com/777genius/agent-teams-ai/blob/7ce224d148205867d46fd2ca980a48e1b9e8c48b/test/renderer/components/team/dialogs/ProvisioningProviderRuntimeSettingsDialog.test.ts), base blob `79ec52e6cb1d87f2ab6909f2decb9a7a295143b9`, with an explicit installed/null-path installation fixture for Anthropic, Codex and OpenCode. Assert the original dialog is enabled and retains the selected provider/project, while caller disabled, global loading or uninstalled status still disables it. Keep the original awaited invalidation/refresh/currentness assertions. The terminal remains absent without an actual binary. Do not add a new suite or substitute a TEST DOM override.

This is a concrete source defect discovered while preparing §13, not a claim that the new genuine Settings/native journey has run. It authorizes only those two production gates and two existing test files after root publishes this append. Source review and required type/focused Renderer validation must complete before final acceptance or upward merge. While the executor is unavailable, the normal candidate-head CI performs those checks; publication of a reviewed candidate is not a validation PASS. The original two mixed native lanes still establish the full UI/default/limits/cold acceptance. No request allowance, timeout, provider status, source authority or cleanup guard changes. Root remains sole publisher.


### §13 cold-discovery clarification — retain the one genuinely created Team

The existing TEST [verifyCapturedDesktopBinding and restartCapturedDesktopApp](https://github.com/777genius/agent-teams-ai/blob/7ce224d148205867d46fd2ca980a48e1b9e8c48b/scripts/legacy-agent-host/desktop-captured-app.ts), base blob `dd2bfacf7ce7369b90250bd152408787df65cb30`, expect one discovery binding outside the original cross-team cases. That assumption is correct at initial fixture startup but is too narrow after §13's one actual Create/Save. [DesktopBackendFeature.discoverBindings](https://github.com/777genius/agent-teams-ai/blob/7ce224d148205867d46fd2ca980a48e1b9e8c48b/src/features/agent-backend/main/composition/DesktopBackendFeature.ts), source blob `e278f1894e408f54c483ad8ace2a5df9eecbd8ea`, reads the original durable creation registry and registers its published Team before returning bindings.

For this exact `settings-saved-before-launch` TEST boundary, pass the created handle already read from the one original published registry receipt by [desktop-mixed-create-launch-ui-smoke.ts](https://github.com/777genius/agent-teams-ai/blob/7ce224d148205867d46fd2ca980a48e1b9e8c48b/scripts/legacy-agent-host/desktop-mixed-create-launch-ui-smoke.ts), base blob `d8d80aa0258ac2974f9655cfe46d710d42fb8493`. Before the one Quit, use the existing read-only discovery function to capture exactly the fixture handle plus that created handle, with their original closed binding shape and member rows. Require distinct exact handle IDs, the same original ownerResourceRef and distinct teamResourceRef values. Preserve the original registry receipt/owner state bytes separately. No caller-selected arbitrary count or additional unknown handle is accepted.

Reuse the existing discovery parsing in the cold helper. On the sole successor, require that same two-element handle set and exact retained binding values, alongside all original descriptor/build/profile/Node/entry/HOME checks. Other cold modes keep their previous one-/three-binding expectations. The change is TEST-only in the already planned cold helper and its current callers; no production discovery/registry policy changes. It does not relax the separate exact-one OpenCode management-child guard, alter native input counts, re-open Settings catalogs after the boundary or authorize another app startup.

This clarifies the existing durable Create/owner/handle cold proof. Source remains pending root publication and review; candidate-head types/required existing native lanes remain the acceptance gates, with no execution PASS inferred while the executor is unavailable.


### §13 provider-page reachability closure — original Dashboard/Settings Manage

Independent review traced the actual ordinary Settings page: [SettingsView](https://github.com/777genius/agent-teams-ai/blob/ec537ab62479923a65130d0e8888cc30eb702340/src/renderer/components/settings/SettingsView.tsx), blob `cc9ff146c8b29ee6815141dec6ed9b7f8d79acf3`, renders CliStatusBanner inside `provider-settings-page` for the Providers section. The separately corrected CliStatusSection and provisioning dialog remain valid fixes, but do not prove that this actual page is reachable.

[CliStatusBanner](https://github.com/777genius/agent-teams-ai/blob/ec537ab62479923a65130d0e8888cc30eb702340/src/renderer/components/dashboard/CliStatusBanner.tsx), exact preimage `feb5df37bd700e1b25365eec5a64c183152308a6`, has both stages of the same obsolete pathname gate. The `runtime-manage-${provider.providerId}` button uses the shared `actionDisabled = isBusy || !cliStatus.binaryPath`; its ProviderRuntimeSettingsDialog separately receives `isBusy || cliStatusLoading || !renderCliStatus.binaryPath`. Correct both settings predicates in this one existing production file:

- Manage button: `isBusy || cliStatusLoading || !cliStatus.installed`.
- Its settings dialog: `isBusy || cliStatusLoading || !renderCliStatus.installed`.

Keep the shared `actionDisabled` variable byte-unchanged: existing Login, Logout, account-link and other action-specific consumers still use it. Keep the actual TerminalModal binaryPath guard/command unchanged. Preserve all provider status, selected-provider loading, native authentication/currentness and IPC guards. An installed Host permits viewing configuration for a provider whose model/auth check failed; it does not manufacture Ready, authentication or native execution. Global loading, installer busy and absent/unconfirmed Host still prevent usable settings actions.

Extend one focused case in the existing `test/renderer/components/cli/CliStatusVisibility.test.ts`, **base `0f31d8c449122ddb1bb3c2d88993d46777fbc8e7`**, preserving the already-reviewed P06 maintenance case. Exercise each original Anthropic/Codex/OpenCode Manage control with installed/null-path status and unsuccessful provider status; assert its real click selects the original provider and enables the existing dialog. Check global loading/absent Host refusal and retain the existing auth/terminal predicate boundary; no login/install/config/native effect may be introduced by opening settings. No new suite or broad provider matrix is required.

The §13 helper will navigate ordinary Settings → Providers and use the original `runtime-manage-opencode` control, not an obsolete Advanced assumption or a TEST DOM mutation. This two-file correction is a separate reviewable prerequisite to the larger Settings/native journey. Root publishes this clarification before source edits; normal candidate-head type/focused Renderer checks and original native acceptance remain required, and none is reported PASS while execution is unavailable.


### §13 successful captured readiness — preserve the actual local-model override state

Source review found an incorrect UI expectation in §13's proposed successful V1 journey. The captured saved-Team path in [prepareCapturedTeamModels](https://github.com/777genius/agent-teams-ai/blob/7ce224d148205867d46fd2ca980a48e1b9e8c48b/src/features/agent-backend/main/application/prepareCapturedTeamModels.ts), blob `2664631cab1a589e3f8f03a88c057e4f65c874d1`, returns either a successful original `capturedTeamReadiness` or a failed result with its original message. It does not emit a model issue with `experimentalOverrideAvailable`. The renderer [hasExperimentalLocalModelOverride](https://github.com/777genius/agent-teams-ai/blob/7ce224d148205867d46fd2ca980a48e1b9e8c48b/src/renderer/components/team/dialogs/providerPrepareDiagnosticsModels.ts), blob `5f18ece092a530e97ee0c9a9a204e94cc90423b0`, only reads that flag from the matching original model issue. [LaunchTeamDialog](https://github.com/777genius/agent-teams-ai/blob/7ce224d148205867d46fd2ca980a48e1b9e8c48b/src/renderer/components/team/dialogs/LaunchTeamDialog.tsx), blob `5fd3c0b8591006e183629de9594f30fa3bacf573`, renders the local-model override checkbox only for failed eligible checks. Selecting the genuine V1 `local` provider does not make this checkbox appear when the original captured check succeeds.

Replace only the impossible false-to-true checkbox expectation in this successful Settings/native journey. Both V1 and V2 must retain `allowExperimentalLocalModels` absent or false in the original saved settings before the cold boundary, the actual Launch/capture and the stopped readback. Require the existing ordinary captured model-readiness result and enabled Launch control; do not seed a true value, fabricate a failed model result, click hidden controls or alter any readiness/authority predicate. The planned TEST helper and its existing mixed-dialog caller assertions may reflect this actual state after root publishes this clarification. The existing `settings-saved-before-launch` cold sequence, exact two bindings and all original cleanup/source checks are unchanged.

V1 still uses the actual `local` recipe and visible local limits editor: Default A → visible explicit A → one Apply & verify for context 65536/output 1536 → Default. Keep the absent saved member model, four original V1 Settings requests, three V2 Settings requests, original business/probe budgets, exact captured preference/source/configuration joins and genuine native A/output-1536 evidence. V2 retains its original provider and has no invented limits editor. No extra request, timeout, native input, configuration mutation or production change is authorized by this clarification.

The **failed-local experimental override remains a separate, unqualified parity point**. A successful captured readiness proof does not establish that a failed local model can be explicitly overridden through the Host path. This source finding does not declare that feature supported or closed, and this journey must not report acceptance for it. Its baseline semantics and original failure/permission boundaries need separate evidence before any product or oracle change.

This amendment corrects the acceptance expectation, not an observed native-run failure. The reconstructed TEST slice is source-only; independent review and the normal candidate-head type/focused/native Desktop gates remain required before final acceptance or upward merge. Root remains sole publisher.


### §13 Default before Save — retain the original concrete-route serialization

A second source check corrects §13's proposed absent saved-model assertion. The old frontend at `4a0e06277fe216d9f82dbbede362668fe46622ee` and the current reviewed source have byte-identical [openCodeDefaultModel.ts](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/renderer/components/team/dialogs/openCodeDefaultModel.ts), blob `963db881fff3cc73fb37ece00576eed9159940aa`, and [useOpenCodeProviderScopedModelAuthority.ts](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/renderer/components/team/dialogs/useOpenCodeProviderScopedModelAuthority.ts), blob `3403c7253e20459c6514dcb0211096f55bdd2884`. For an OpenCode teammate with no model and a Claude lead, `materializeOpenCodeDefaultSelections` resolves the actual project default into the teammate's effective model. This concrete value is intentionally used for submission.

The [old CreateTeamDialog](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/renderer/components/team/dialogs/CreateTeamDialog.tsx), blob `39b9fb49756821a2d3c72cb6c3ff603a792fd239`, builds the request from `effectiveMemberDrafts` and passes `request.members` to Save-only `createConfig`. Current blob `0a06948c13254c1b5fb724b5483629b546726357` retains that chain. The existing member builder serializes the resulting concrete route; Launch uses the same effective-draft model. Requiring saved Carol.model to be absent would reject the original supported behavior.

Keep the actual Default selection proof **before** Save: the TEST roster JSON supplies no Carol model, the original selector visibly selects Default A, V1 temporarily selects explicit A for its one limits verification, and the ordinary selector visibly returns to Default before Save. Do not write A into the TEST roster or change product serialization. Record the selected Default control and the corresponding already-verified project/default preference A as evidence of this original choice.

After the one Save, require the exact concrete route derived from that original source: `local/TEST-model` for the genuine V1 local recipe or `test-local/TEST-model` for the V2 recipe. Pass this closed expected route from the captured fixture generation into the existing saved-settings/Launch-hydration assertions. The durable member settings, Edit/Cancel, same-profile cold readback, Launch capture and stopped readback must retain that exact A and the other original settings. The original runtime-source reference, captured preferences/configuration identity and actual native request must still agree with A; V1 context65536/output1536 verification is unchanged.

This is an acceptance-oracle correction within the already planned mixed dialog/helper/caller files. It adds no UI mutation, native input, model request, state write or production behavior. Global A → project B → Test B → clear → inherited A is still proved through the real Settings UI before the draft is materialized. The successful captured readiness/false-override correction immediately above remains in force, as do four/three Settings requests, all original business budgets, one cold boundary and complete physical cleanup.

Independent source review and the normal candidate-head type/focused/native Desktop gates remain required. The source comparison establishes original serialization semantics; it is not a native execution PASS. Root publishes this append before changing the draft assertions.

## 14. Baseline local-model policy: no supported override of a failed native-tool probe

### Review 1 — exact original composition and writers

This corrects only the §13 statement that a failed-local experimental override is an outstanding supported-feature parity point. The exact original frontend is `4a0e06277fe216d9f82dbbede362668fe46622ee`; the compared current tree is `f9c3451e3d0733e7d5216dd4ed5aad2ad0b5e83e`. This is a source-contract audit, not a native execution result.

The following ordinary production chain is byte-identical in those two trees:

| Source | Immutable blob | Relevant original contract |
| --- | --- | --- |
| OpenCodeLocalModelRuntimeInspector.ts | `90e45c63a10216a8806f1bfa436666405e87798e` | The only availability assignment is `experimentalOverrideAvailable:false` at567; failed native-tool coordination remains blocking. The allow flag is documented as retained for launch-cache identity. |
| TeamProvisioningServiceComposition.ts | `142767a1bc6ab462a415c1b70c71f864032cbb1e` | Lines661–669 pass the real exported inspector unchanged into the ordinary preparation facade. |
| TeamProvisioningPrepareFacade.ts | `b82d39f22fde3b9400616f4fc97376984c0fdc32` | Lines142/182 forward the same callback to the existing coordinator. |
| TeamProvisioningPrepareCoordinator.ts | `230902c1bf488a71ec4ac42b5d1fe481b73ebae0` | Line307 forwards it into selected-model preparation; returned issues are retained. |
| TeamProvisioningOpenCodeModelPreparation.ts | `93ed4ef85565d66d75b570186afc0877e89bb3b0` | Lines292–295 call that inspector. Lines395–409 propagate availability only when the original blocking result explicitly contains true. |
| OpenCodeLocalModelPreflight.ts | `3fc317d520ecacb5aec8a27fe413f248583b699b` | The allow flag changes the inspection-cache key and supplied input, but every blocking result still contributes diagnostics and makes ok false. |
| OpenCodeTeamRuntimeAdapter.ts | `35487475fdfe96f8ccae62f5d73780570aaf21d9` | Launch reuses that preflight and refuses its blocking result; the option does not skip the gate. |

The adapter composition is also explicit: old Main index blob`802954baa373170c79c55628db8bfbdd08718926`:685–688 and current blob`6ac0ff69ee9fce5be4b4de185b0355bdda469462`:696–699 pass the same inspector to OpenCodeTeamRuntimeAdapter. The facade, coordinator and adapter wrapper do not synthesize an override-eligible issue. Other inspector outcomes omit the availability flag; unavailable verification is a warning that leaves the real execution probe authoritative, distinct from a proven failed tool probe.

### Review 2 — Renderer propagation does not create eligibility

Old providerPrepareDiagnosticsModels.ts blob`05e2d989dc7da05d15c66503079957901aa6a2fe`:57–66 requires a matching model issue whose flag is already true. Its current blob`5f18ece092a530e97ee0c9a9a204e94cc90423b0` preserves this function. Old providerPrepareDiagnostics.ts blob`d041a0048b83436f1f5672bb1d8c9e7b209f0960`:112–122 sets aggregate availability only after all failed model results already have that flag; its per-model true assignments are guarded by the same issue predicate. They are propagation, not an independent production writer.

The unchanged experimentalLocalModelOverrideState.ts blob`860310280a1c3e2d714e824a379396775d546a4e` requires at least one failed check and true availability on every failed check before the UI can enable the option. Synthetic true values in Renderer tests verify this consumer contract; they do not establish an ordinary original producer or a supported force-launch route.

For this inspected baseline production graph, failed native-tool verification therefore has no supported experimental override path. Correct the §13 parity inventory accordingly. Do not add a true writer, force a checkbox, weaken a readiness predicate, change request parsing or remove the retained option merely to satisfy the earlier mistaken expectation.

### Review 3 — preserve the genuine readiness obligation

The already-reviewed successful Settings/defaults/limits journey correctly retains the option absent or false. Its four V1/three V2 Settings requests, one cold boundary, native consumption assertions and physical cleanup remain unchanged. No TEST source or product edit is needed for this documentation correction.

This does not qualify current Host local-model safety or functional readiness. Whether its captured model proof preserves the original failed-tool/context refusal policy is a separate source and acceptance question; a successful no-tool model request or the absence of the old checkbox is not proof of that equivalence. Keep that question explicit without inventing an override feature or transferring a synthetic test result to native acceptance. No new job, matrix, suite, provider run, permission, input or budget change is authorized here. Root publishes this reviewed clarification; execution evidence still comes from the original relevant coherent-head CI.

## §15 — closed observation of the original Settings/cold failure (PLAN ONLY)

### Review 1 — exact new evidence, and what it does not identify

The first ordinary parent qualification of the §13 Settings/cold journey at parent source `1160b575c4e43db045ab8726fd16d27bd611196a` failed in mixed V1 job `132024091150`. The complete original log is F blob `f365ff0452fbc4817c03a46a70e31236c1b419bc`: it records one prepared fixture at16:56:26.443 UTC and `INCOMPLETE` at16:58:17.028 with `failureSource={kind:"error",frames:[]}`. The later assertion at desktop-backend-smoke.ts:751 reports unconfirmed captured-group cleanup. This elapsed interval is the whole observed harness interval, not a measurement of any Settings/model operation. Artifact `14059238033` was retained, but its member bytes have not been read in the current environment.

The existing log therefore distinguishes an original ordinary Error from the later cleanup assertion but does not identify the failed Settings action, whether Create/cold startup was reached, or the original native failure. Do not infer a local-readiness failure, change a selector or guard, replay a click, raise a timeout/count, or claim the new Settings journey passed. The genuine local tool/context-readiness audit remains separate, reserved for §16; §14's absence-of-override clarification remains unchanged.

### Review 2 — the needed facts already exist in memory

The original mixed caller `desktop-mixed-create-launch-ui-smoke.ts` blob `3b689edbe2a5dd9f0c1af453164dc2397ba5839d`:137–162 installs `evidence.mixedCreateLaunchProof` and its original UI `steps` before the Settings prelude. The directly consumed helper `desktop-mixed-provider-settings.ts` blob `522c99c88a9ddbb0dfa7a7397046188aa963402b`:170–176 installs `providerSettings`; its four possible original model-verification receipts are appended at259–261 only after the exact command/source/model/current checks and original completion. Their fixed step names are `global-default`, `project-default`, `project-test`, and V1-only `local-limits`. A missing step is not evidence of no dispatch.

`desktop-ui-controls.ts` blob `c66034be1aeee83d88e829808f72db853dad6c57`:168–175 records `mouseClick`/`label`/`state:"attempted"` before the one physical dispatch. Hover and wheel rows are also observations made before their original action. These rows do not confirm a click acknowledgement, successful UI transition, native execution or completion. `waitRead` does not append its own read label; the new diagnostic must not invent such a phase or call the last click the failed read.

The existing cold helper `desktop-captured-app.ts` blob `48c091170baefb5d1404c7beac9200991989f52c`:508–515 retains `coldSettingsBoundary`, then `firstQuit.attempted`, `firstCleanup`, and `secondEpoch` at609/622/652. Original cleanup in desktop-backend-smoke.ts:660–683 adds `secondCleanup` and `cleanup`. The final console row follows the original receipt write at742–746. All inputs for this proposal are these already-retained values; no file, process, DOM, RPC, model or network observation is added.

### Review 3 — exact source slice and ownership

Only these two existing TEST paths are authorized after plan publication; no product file, UI helper, model oracle, captured-app cleanup, source inventory or workflow changes:

| Path | Parent preimage on3c77393 | Native preimage on233af6 | Qualification preimage ond3351e |
| --- | --- | --- | --- |
| scripts/legacy-agent-host/desktop-backend-observations.ts | `ab850ddfc2d146a420f1685f84b5424f7f36d0bd` | `e5625eb9a2ad06ac0c3e5798a07381dbd25e44ca` | `45490b246f9c68eeaa57fe88be207289b002114c` |
| scripts/legacy-agent-host/desktop-backend-smoke.ts | `eb033a2ff980564c21be67c65bba0ed99f2c8143` | `b8b58fab7902fd1a6a83454950618bc94ef7dea0` | `754a0ffd771fa2e856772f7b7078c3aa466aa444` |

Add one directly consumed pure projector, `projectDesktopMixedSettingsFailure`, to the existing observations module. Preserve every branch-specific function and all §59 failure-source projection bytes. In the smoke file add its import and one optional field in the existing final console object, only for `mixedMode && evidence.status !== "PASS"`. The original catch/rethrow, receipt write, cleanup sequence, final strict assertions and their precedence remain byte-identical. Projection failure returns a fixed unavailable value; it cannot throw, replace the original error, change status or change cleanup.

Use exact three-way composition for child variants. Current physical smoke lengths are774/777/767 lines (one additional split-line entry for the trailing newline); observations are437/655/508. Keep every resulting source below its existing800-line ceiling without removing blanks, compressing unrelated code, changing baselines or creating a new helper framework.

### Review 4 — closed fields and finite bounds

The projector accepts the retained evidence object and returns a versioned object no larger than4096 UTF-8 bytes. Read only own data properties; never invoke diagnostic getters or serialize an input object. Every unknown, absent or malformed outcome is null or an explicit unknown/unavailable state. Absence may produce false only for a field whose name explicitly means that a particular retained record is present; it never produces a false failure or a clean/native-completed inference.

- Keep proof/settings/cold statuses only from the existing finite `PASS/INCOMPLETE/UNKNOWN` set, generation only `v1/v2`, and explicit record-presence markers for mixed/settings/cold evidence. A failure before proof construction remains distinguishable from a failure with retained settings steps.
- Summarize the original UI step list with a bounded count (at most1024, otherwise unknown/overflow) and at most the final eight data rows. Each row contains only a fixed stage code, the known action kind `mouseMoved/mouseClick/mouseWheel` or unknown, and whether the original row explicitly recorded `state:"attempted"`. No selectors, expected text, target geometry, arbitrary labels, model names, paths, IDs or raw monotonic values are copied. Unknown labels map to `other`; do not scan backwards past an unknown recent action and mislabel an earlier stage as current.
- Fixed stage matching is exact, never a regex/prefix substring over arbitrary labels. Settings labels come only from the inspected original literals: `original menu for Settings`, `original Settings`, `original Providers page`, `original OpenCode Manage`, `original Models tab`, `original project context`, `select original TEST project`, `Change: Default model`, `Use another model: This project: workspace`, `original configured provider`, `expand original configured provider`, `select and verify original global default`, `select and verify original project default`, `Test the original project model once`, `clear original project override once`, `close original Settings`, `close original member JSON`, `expand original Carol model`, `temporarily select A through the existing model control`, `original context limit`, `original output limit`, `Apply and verify original limits once`, `restore original inherited Default before saving`, and `collapse original Carol model`.
- Add only the inspected fixed Create/Edit/Launch/Stop boundary labels to that same finite mapping: `Create the original saved3-member roster once`, `open existing EditTeamDialog`, `save original Edit intent once`, `reopen existing EditTeamDialog after reload`, `open original mixed Launch dialog`, `reopen original mixed Launch before Submit`, `submit original mixed Launch once with successful captured readiness`, and `original whole Team Stop once`. Emit normalized enum codes, never these original strings. Cold epochs are derived from retained cold fields, not inferred from these action labels.
- Inspect at most the four original settings receipt rows. Emit only their fixed step, `phase:"completed"` or unknown, and strict boolean/null `resourceHeld`; do not copy command/source/revision/model fields. Invalid/oversized/duplicate rows make that projection unknown, not an empty successful receipt set. These are recorded validated receipts, not a new claim about the native outcome of an unrecorded action.
- Emit record-presence markers for the existing `projectOverride`, `clearedProject`, `defaultBeforeSave`, `created`, and `nativeCapture` milestones. Copy only strict boolean/null `originalSettingsOwnersReleased`, `sameSettingsAfterCold`, and `successorOwnersReleased`; do not synthesize completion from a later marker.
- For cold boundary retain only its closed status, strict boolean/null original Quit-attempt marker and second-epoch-recorded marker. Project at most first cleanup, second cleanup and final cleanup. Each contains only bounded original remaining-count (at most256, otherwise null), observed exit code0..255 or null, a fixed signal enum or null, strict boolean/null captured-Host-absence and writer-release flags, and `failureRecorded` (string→true, missing field on an existing cleanup record→false, malformed→null). Missing cleanup records themselves remain null. Do not print PIDs/PGIDs, process commands, paths, exit prose, cleanup error text or infer a confirmed release from a missing value.

If even the constructed closed object exceeds4096 bytes, return a fixed overflow/unavailable object. Do not truncate raw input into the log. The projector does not mutate evidence, recompute fingerprints, inspect receipts on disk, poll, retry, call cleanup, or count a diagnostic row as business/native input.

### Review 5 — validation and acceptance

Root and independent peer review must compare the exact parent and both child deltas, all fixed labels against their actual writers, malformed/absent handling, finite input/output access and unchanged error/cleanup order. Keep this to the two declared source paths; no new suite or generic test framework. Existing scripts typing/source-size/lint gates and the same ordinary mixed V1/V2 jobs remain the execution gates. The current executor is unavailable, so the initial candidate is SOURCE_ONLY_UNEXECUTED; source review does not become compilation/native evidence.

The next ordinary coherent parent CI, after normal existing runs terminate, may expose the original retained UI stage/receipts/cold/cleanup facts. A stage code narrows the last recorded original action; it never proves the cause or authorizes repeating it. No rerun, provider input, census, timer/count increase, permission change or functional readiness change is authorized by this section. Root remains sole publisher; §16 retains the distinct genuine local-readiness follow-through.

## 16. Local-model tool coordination and context-floor parity: qualify the native proof before connecting allocation

**Status: phased PLAN ONLY.** P05 full preimage is 697a243e38f3df3c9ba7b317845a54246a44f08f, including the published §15 failure projection. §14 removed an unsupported experimental-override claim; it did not remove the real old blocking policies below. No source is changed by this appendix. Root publishes the reviewed plan before source. The first source authorization is **phase A only**: a private native coordination purpose under the existing ModelProbeOwner and its bounded original qualification. Production Team admission is phase B and requires a further exact connected-scope amendment and peer review. Native challenge success alone must never be reported as completed local-readiness or Desktop parity.

### Review 1 — the actual old policy and the missing current proof

The exact baseline is frontend4a0e06277fe216d9f82dbbede362668fe46622ee. src/features/runtime-provider-management/main/infrastructure/OpenCodeLocalModelRuntimeInspector.ts90e45c63a10216a8806f1bfa436666405e87798e and src/main/services/team/provisioning/TeamProvisioningOpenCodeModelPreparation.ts93ed4ef85565d66d75b570186afc0877e89bb3b0 are byte-identical in that baseline and the audited current source. The actual TeamProvisioningServiceComposition.ts142767a1bc6ab462a415c1b70c71f864032cbb1e callback, runtime/OpenCodeLocalModelPreflight.ts3fc317d520ecacb5aec8a27fe413f248583b699b and readiness/OpenCodeTeamLaunchReadiness.tsf28ef1f52e4cfb078b939e522e3de1649c5a65f6 establish this chain; it is not an inference from a dormant UI flag.

| Original fact/policy | Required parity meaning |
| --- | --- |
| Project selection precedes global selection; the configured compatible provider, selected model and endpoint are resolved from that original route. A known local route without its provider, or a non-Ollama route without the selected live model, blocks. | Keep exact captured-source/configuration/route applicability. Do not classify every configured-authless or arbitrary remote model as local. Do not discover another ambient endpoint to rescue a selected route. |
| Explicit metadata tools=false blocks. A known effective context below16384 blocks;65536 recommendation and small model size are advisory. | Tool and context refusal are independent. Declared catalog/training context or a configured override is not evidence of actual loaded context. Unknown metadata retains the old warning/inspection distinction. |
| Actual coordination requires task_briefing, its returned nonce, then message_send with that exact nonce/destination. Plain text or JSON pretending to call tools fails. | Current native engine/MCP discovery and an OK text completion do not demonstrate that the selected model can perform this protocol. |
| Non-Ollama effective context comes from the original local runtime metadata; Ollama /api/ps is read after the attempted model coordination, including failure. Configured num_ctx and trained context are separate facts. | Do not manufacture a context-floor pass from model catalog limits or from an override. Preserve after-load ordering for Ollama. |
| Configured API-key routes, and non-Ollama remote routes, return the old unverified warning before the direct coordination/context branch. Inspection exceptions are not proof of unsupported tools; subsequent native execution remains authoritative. | Phase B must retain this applicability boundary. The fact that native transport could carry a key does not authorize widening the mandatory local policy to remote/keyed routes. |
| The only availability writer sets experimentalOverrideAvailable=false; allowExperimentalLocalModels participates in identity, not a force-launch permit. | No bypass flag or invented failed-local override belongs to this work. |

The old direct coordinator is OpenCodeLocalModelCoordinationProbe.ts885233cb11e90ff4ca9a3160afe0c30955899be9. It used a finite90-second observation and two actual provider tool responses. Porting its model HTTP request is expressly excluded: the replacement must use the selected owned native engine and its captured account/configuration.

Current Host model checks have a narrower, real guarantee. runOpenCodeModelProbe.ts c1240460eeac5c7ed26269ef6e86d3b89b31c17d verifies deny-all permission, catalog/model/variant/selected limits, disables every native tool and accepts one completed assistant text. OpenCodeV2ModelProbe.ts d9b9c32bc16f7d96437ee03cbc18a30565427b98 uses the same no-tool policy with the original owned embedded2.1.4, credential/configuration guards and one text input. Its current result is not an inert two-tool coordination proof.

CreateTeamLaunchCoordinator e12544809a43518074d7cdde4430676c9c44ff4d:49–127 already serializes original grouped model probes and requires completed/unexpired success before submit. Saved selection uses teamLaunchModelProbe6ae19ee22a00c21fd748f5a4d6b283bfaa0702f5, savedTeamModelProbe2ec7eabb2a37ce7e06549d3b39413fd690d0fbaa and Main prepareCapturedTeamModels2664631cab1a589e3f8f03a88c057e4f65c874d1. These paths currently consume the text-only result. Main's returned capturedTeamReadiness contains selection/launch/signature/expiry, not a durable stronger-purpose receipt reference. That absence is a source fact, not permission to reuse a no-tool receipt as a new proof.

RuntimeOwner7848030933816757816c43e2a08dd0f9cbed7563:229–237 subsequently checks driver native readiness and required engine capabilities. createRuntimeTeamLaunch2e7329e08e27037c71dec8b8bb22a0df085b9ee5 combines that with captured context. Neither is the old selected local model's coordination/context-floor policy. The current local-policy parity gap remains open; the published R19/R21/R22/R23 performance substitutions do not close it.

### Review 2 — phase A: one private, purpose-bound mechanism in the existing owner

1. Keep ordinary management.probe.start/read/cancel and Settings Test byte-compatible in meaning: their input remains strict and their native configuration remains no-tools. No renderer/public profile flag may select a tool-capable probe. Add only a private composition entry on the existing ProviderManagementCoordinator/ModelProbeOwner for the literal purpose native-local-coordination-v1. It reuses the same original target selection, FileManagementCommandStore, ManagementResourceFence, command/context identity, cancellation and physical close. It is not a second probe owner, grant registry, queue, cache or TTL service.
2. The private producer, not a caller-supplied profile or RPC object, selects that purpose. Bind the original command fingerprint/context to the purpose and exact captured management selection, model/variant/limits/cwd/configuration/account/source witnesses. Record the fixed purpose with the original durable command before any listener/session/child/input. The existing public parser must reject a supplied purpose field. An old record without the purpose remains its original historical text-test outcome and is never upgraded or respent.
3. A private current-purpose read must require the original identity/context/target, completed=true outcome, resourceHeld=false and the exact purpose. No latest-success scan or model-name-only equivalence is allowed. A mismatched reused ID refuses; a replay/cold read returns the original outcome without preparing another native mechanism. NativeModelProbe construction must still allocate nothing; only run after the original stored admission can create resources.
4. The purpose operation uses the existing whole probe timeout, at most90000ms, with one absolute deadline captured at original admission. Child startup, MCP availability, the single submitted native prompt, both tool calls, terminal observation and cleanup consume that same original budget. Each awaited phase rechecks the original scope and remaining deadline. No restarted phase timer, per-tool90 seconds or inferred success after cancellation is permitted. Existing shorter fixture bounds remain shorter.
5. The private challenge is a small purpose-specific MCP endpoint using the already installed MCP SDK. It exposes exactly two inert tools, with fixed closed schemas, and a fresh private nonce revealed only by the first completed tool result. The second tool must consume that exact nonce and fixed challenge destination. It never receives a TeamOwner/connection, Runtime binding authority, real task/message mutation method, filesystem command, account mutation, plugin or broad permission. It is not the business Team MCP endpoint with a fabricated Team grant.
6. Bind endpoint authentication to this original operation and sole native session. Use the existing64KiB maximum request-body size as a ceiling, at most16 MCP protocol requests, at most2 concurrent requests and exactly2 accepted tool invocations; all waits use the original probe deadline. Preserve the existing native prompt1024-byte, output32768-byte and128-event limits. Bound the endpoint output within those original budgets; unexpected tools, repeats, reordered second-before-first, wrong nonce/destination, malformed schemas or foreign request credentials cannot pass. Retain only finite private tool facts needed for the result. The result is based on actual endpoint calls/results plus the original native session/input/tool/terminal observations. Do not equate an MCP transport request ID to a native tool-use ID without actual API evidence; join each at its real protocol boundary.
7. One native prompt asks for the two-step coordination. The model must actually obtain the nonce through the first tool, invoke the second, and reach the original terminal result. Text quoting tool JSON, a synthetic terminal, catalog discovery alone, a foreign session, a tool error or mere advertised tool names cannot produce ok. Require native tool identifiers/ordering where the existing protocol exposes them, and preserve the independent endpoint result/nonce evidence. No direct model HTTP shortcut is used in product code.
8. V1 uses a dedicated purpose configuration derived from the captured profile and the existing CapturedProcess/OpenCodeManagementHost lifetime. The ordinary shared management host's deny-all policy is never patched in place. Reuse the existing withV1Host endpoint-operation serialization and original close/retire path when an owner already exists; do not run two V1 servers on the same captured endpoint. Refused or unknown original close remains held.
9. V2 uses the existing owned embedded2.1.4 ModelProbe lifetime, its original Bun/graph/credential/configuration/beforeRequest custody checks and private data/config directories. The coordination branch admits only the exact challenge server/two tools; all builtin execution, foreign MCP, subagents and ambient plugins stay denied. Keep openCodeV2NoToolConfig and its one-step ordinary behavior unchanged; a separately named private configuration function may construct the finite coordination branch. Its exact native policy/MCP discovery must be attested before submitting the prompt. No D protocol or engine-version guard is relaxed. Before allocation, qualify the purpose configuration against the original captured fixture bytes and reject foreign MCP/plugin/agent inputs; do not invent a V1 environment flag or silently inherit ambient configuration. The existing native cases have a private known configuration; how arbitrary supported captured local configurations are reduced to an equally closed purpose configuration is an explicit phase-B source prerequisite, not inferred from a clean fixture.
10. Close/seal fences the challenge endpoint and native observation before releasing anything. Success is durable only after actual original child/session/endpoint close is confirmed. Failed/aborted/transport-unknown and cleanup-unknown remain distinct existing owner outcomes; resourceHeld/unknown debt is retained. Missing Runtime allocation is never cleanup evidence for this separate probe. Same-ID start/cancel/read after completion or cold reopening does not send another input.
11. Phase A is deliberately inactive in ordinary Create/Launch/Resume callers. The private entry is exercised by the existing native qualification fixture only. It proves a native coordination mechanism; it does not yet prove the old local applicability, metadata context floor, visible warning semantics or allocation enforcement. No production Team can become newly usable because this section exists.

### Review 3 — phase A exact source scope and existing gates

All following preimages were read from F1160 or an unchanged immutable published source. Root composes later unrelated work, especially the §61 factory/Host changes. Phase A does not edit those factory/allocation paths, Main, Renderer, workflow, D or source eligibility. If implementing the declared mechanism requires another path or a default-policy semantic change, return an exact amendment before that source edit. Preserve the existing per-file caps; do not compact unrelated code or raise a baseline.

| Path under packages/legacy-agent-host/ | Exact preimage | Phase A delta |
| --- | --- | --- |
| src/management/ModelProbeOwner.ts | ae3912d6a4f3a3a46f0bb8a12e11e72334b90519 | Private purpose admission/current read; same durable owner, original public parser/replay/close. |
| src/management/commandRecords.ts | 778361e3602933d3c1bea42d952036b5ecd82055 | Optional closed stored purpose/version; absence keeps historical no-tool semantics. |
| src/composition/ProviderManagementCoordinator.ts | 8d2d656cc043d135fef925698363c4ec48e2eb48 | Private native purpose entry using original captured target/account fence and existing V1 endpoint retirement; no public method registration. |
| src/adapters/providers/OpenCodeManagementHost.ts | bc2ac0fc825d27d301c336c096c14cd43bb92d53 | Strict private purpose configuration/run branch; default deny-all construction/probe unchanged. |
| src/adapters/providers/OpenCodeV2ModelProbe.ts | d9b9c32bc16f7d96437ee03cbc18a30565427b98 | Trusted private coordination branch in the same native lifetime; default text probe unchanged. |
| src/adapters/providers/OpenCodeV2EmbeddedConfig.ts | c4d238f3c5e97f3de613bccf3573e26d97a8fa09 | Separate finite challenge config; original no-tool and member config functions unchanged. |
| src/adapters/providers/OpenCodeCoordinationProbe.ts | new, directly consumed | Purpose runner/closed original-session proof for V1 and shared challenge contract; no alternative native owner. |
| src/adapters/providers/OpenCodeCoordinationEndpoint.ts | new, directly consumed | Finite authenticated inert two-tool endpoint; no Team/Runtime/data mutation ports. |
| tests/management-model-probe.test.ts | 109139f33c7542f9b849226729a77d9835f1eab8 | Extend existing at-most-once/revoke/cleanup cases: wrong or absent purpose cannot qualify; late/cold/unknown does not replay or release. |
| tests/fixtures/native-opencode-team/coordination-probe.ts | new, native cases only | Original private composition/writer-lease setup and finite proof/cleanup receipt before first business Host. |
| tests/fixtures/native-opencode-team/model.ts | f369dc4015c20dce846ee2642ccfd3931c2ee837 | Explicit armed challenge response sequence with real prior tool results; separate finite counts under the existing total request ceiling. |
| tests/fixtures/native-opencode-team/model.test.ts | c17c6409be60323f3c44384e53b3fddbf319b6a7 | Extend the existing oracle case with wrong/repeated/missing nonce/native-tool result refusals; independent first-failure checks. |
| tests/native-opencode-host.native.ts | 0e2020d1e0f4e28dd50c28e0c8312106835ee898 | One phase-A purpose operation in the existing first Linux x64 native case, before original Host startup; original business flow/counts remain. |
| tests/opencode-v2-embedded-host.native.ts | bad1005920ef5acb71755376c825a2b65680d3c3 | The corresponding existing Linux x64 embedded native case; original Session/tool/approval/Stop/cold flow remains. |

The first actual tuple is Linux x64 V1 and owned embedded V2 in their original source cases; do not run the added phase from the exported V2 packaged reuse or the V1 peer/shared variants. No new runner, job, matrix, provider version or hidden diagnostic execution is introduced. Other platform/default cases retain their original behavior and must report the new purpose as unqualified there; Linux success is not Windows/Darwin acceptance or production activation.

The qualification explicitly invokes the private mechanism; it does not claim that the fixture proves the old mandatory local-policy predicate. The native helper uses the actual captured management profile derived from the original fixture selection and the existing private ProviderManagementCoordinator, original FileManagementCommandStore and acquireProfileWriterLease761cfba79bd4a993442681d4ec2decdad57efc3b. It does not inject a synthetic select/authority callback, new Team grant, Runtime session or native receipt. Preserve the actual native/config/account bytes. Complete and physically close the original purpose owner, verify its completed released receipt and release its original writer lease before starting the existing business Host. The Host profile must already include the genuine selected management recipe before its normal hash/freeze; no opaque source/profile rewrite after ownership starts. Retain all original profile/native byte checks and before/after process absence. Failure aborts that original case; no subsequent business startup is used as cleanup proof.

Arm exactly one two-tool coordination sequence: three finite native model rounds (briefing call; nonce-consuming send call; terminal). The existing ordinary model observations remain eleven business requests and the same original ONE/TWO inputs. Enforce coordination rounds plus ordinary business observations <= the original16 ceiling; a separate fixed coordination count of3 cannot reset or enlarge that shared bound. The original dialog/settings probe accounting remains separate and unchanged. Existing180-second V1 case and existing V2 case/platform controller deadlines remain unchanged; the original probe budget is <=90000ms, not added to the case deadline. No business command or input is retried. Extra tool/model rounds are refusal, not hidden retries.

The existing synthetic owner/oracle cases cover plain text/fake JSON, second-before-first/wrong nonce, duplicate tool call, malformed/foreign identities, cancellation/revocation at an await, close-unknown, same-ID replay and cold lookup. Preserve meaningful original negative ordering: an earlier failed oracle must not make a later boundary assertion pass accidentally. No new broad model suite is needed. The unchanged ordinary no-tool model-probe tests remain regression gates and must still prove no tool allocation. Host/build/test/script types, targeted tests/lint/caps and ordinary native receipts remain required. Executor absence means SOURCE_ONLY_UNEXECUTED, not a waived gate.

### Review 4 — phase B: mandatory connected amendment before any allocation change

After the phase-A source and actual native mechanism are reviewed, amend this section with exact remaining source preimages and proof transfer/consumption fields. Phase A source permission does not authorize this phase. The smallest intended path is several thin asynchronous callers feeding the same existing probe owner, not a new global queue or a90-second wait inside a member factory.

| Existing entrypoint/source anchor | Intended phase-B boundary |
| --- | --- |
| CreateTeamLaunchCoordinator e1254480:49–127/279–338 and captureCreateTeamDraft4984b0e77b0f6d63c1ba0d2d2759c5156e9720b8 | Reuse original serial grouped preparation before any Team/member claim. Strong purpose receipt references remain tied to exact original draft/source/configuration, and final capture must prove the same relevant execution selection. A no-tool receipt cannot be silently reused; a changed/expired original intent requires its existing explicit preparation/retry semantics. |
| Saved/Create read helpers6ae19ee2/2ec7eabb and executeRuntimeLaunch810fc2da540d9b2ca084b82c0b803fcc7966a613 → executeTeamLaunchfd684c459a84b1a3e7148c9ad78f1e52c789508d | Original aggregate preparation serially proves each exact selected required local route before any member claim. Compile/apply the requested launch configuration before proving it, not entry's old profile. Preserve original prompt/start identity and current-source/roster/worktree guards. No latest-model-result scan or implicit source fallback. |
| executeCapturedRuntimeControl113924227d60528bd26917197e17b5052772b0fd:180–188 | Direct new open uses its existing higher async seam before startMember. Already claimed/openFingerprint/unknown/cold original requests only observe/reconcile their original evidence; they cannot mint another probe. |
| restoreMemberSession0a768c50356c600e7df0de3ec1878d54d85cf332 | Original source custody/checkpoint/authority and exact original selected target remain primary. Prove only a genuinely new target in the existing async preparation before its first native claim; no re-probe on original restore lookup/replay or §61 legacy checkpoint read. |
| transitionRuntimeMemberf500cf8f3d1c957d76ec206a7d54d9bad537b9b8 / executeMemberAction096716f18306250426d016504665973b0b614b3c | Fresh Restart after confirmed original release and before new start; initial pre-Stop current checks must not start another fixed-endpoint V1 probe. Retry follows the exact original selected intent and existing no-allocation eligibility. |
| preflightNativeMemberModeld0e4d0b73b20b18842a38061dbbf7329ef8e30af | Reuse this existing90-second native-add model owner/guard/cancel seam for applicable local proof before the new member is installed. Preserve exact original native input/authority and no new tool grant. |
| createRuntimeMemberProviderFactory abc1c70c289aac1c1cb7ea8288f4e4d009aa2661, with published §61 composition53f4c270f1634a65f8eb465f11b7e2e59242ee22 | Synchronous consumption of exact original purpose + policy witness before endpoint/provider effects and again at the original allocation boundary. No model request, owner creation, wait or fallback from this factory. Current/native context capability checks still run; strong proof is additional. |
| scheduledRunCapture87ba64ee70f374021a04429c680eb9c7683cde4b / ScheduledRunProvider3eb0a840e5c4ae8ca2afdba811fe0a5c0a38ecf9 | Standalone scheduled OpenCode is currently unsupported. Preserve that refusal; do not invent another scheduler consumer. Team occurrences using aggregate launch inherit that same guarded path. |

The metadata-policy witness must port the exact old route predicate and refusal rules, using the captured original configuration/credential/source references. Do not reuse broader isConfiguredAuthless as the policy predicate. A missing known local provider, selected unloaded non-Ollama model, explicit tools=false or known effective context below16384 remains a refusal. Unknown inspection facts stay unknown/warning as in the baseline and cannot be relabeled tools=false. If native coordination is required by that original predicate, only the new purpose can supply it. Reuse the existing bounded original metadata read behavior, including the Ollama after-load /api/ps order, with no direct provider model inference. Exact metadata helper paths and field schema must be frozen in the phase-B amendment before implementation.

An admissible proof reference is explicit and bound to the original receipt, owner/target, captured source/config/account/model/variant/limits/cwd and operation intent. Its transport is a reference to owner-validated evidence, not a renderer assertion. Do not treat generation/member IDs as interchangeable or drop them from a digest merely to make draft and allocated profiles match. Any legitimate draft-to-capture mapping must be proved through the existing creation/launch source ownership and exact execution selection, then preserved in the original launch preparation/attempt. A new source B does not revoke or reinterpret an already admitted running A; expiry gates a new allocation, not later business input under an existing valid captured session.

Cold handling and cancellation are mandatory design gates, not optional followups. ModelProbeOwner ae391:206–207 makes a prior running record without its original active Promise held; same-ID lookup cannot recreate it. TeamLaunchOwner29822d71440cef625bdc2b43263cbeba7a9c96e2:382–445 claims the attempt and starts the member timer before Runtime.open, so no native proof wait belongs there. launchRetry0ba4db000759464ba57c84d43661d750d68f6d53:82–84 accepts only failed+noAllocation; it does not make management probe debt released. RuntimeOwner.stopSession:515–516 refuses a missing record, while lifecycle cleanup can create an empty closed Runtime record. Neither proves that a pending probe child is absent. The connected amendment must preserve the original probe cancellation/cleanup handle through Stop/Trash/shutdown and prevent a late successful probe from causing a later allocation. Unknown original native debt remains held and discoverable.

Do not add an automatic new queue because aggregate member starts are concurrent. Reuse the existing serial preparation before claims and explicit existing resource-fence busy/refusal semantics for concurrent independent intents. Original exact receipt refs prevent a second inference when the prepared result is consumed. Preserve existing caller identity and at-most-once pending Promise boundaries before the first await. A confirmed pre-allocation failure may only become retryable through the existing original attempt/noAllocation contract; it cannot synthesize a historical claimed source or bypass §61's exact predecessor/Skip provenance.

Before phase B can be source-authorized, existing critical cases must have an exact plan for: text-only old receipt rejected; selected plain-text/fake-tool model blocked; explicit tools=false and actual-context floor independently blocked; remote/keyed warning boundary preserved; allowed local nonce proof admits exactly one member; source/config/key/member drift at every relevant await refuses; pending Stop/cleanup and cold unknown do not replay; two applicable members use original serial preparation; original captured A stays valid after B publication; direct open/Restore/Restart/native-add cannot bypass factory consumption. Reuse existing management-model-probe, team-launch, runtime-team-host and saved-team-model-probe cases and the existing native/Settings/source lanes. Freeze exact request accounting before those native consumer changes; no cap, timer or native-input increase is preauthorized here.

### Review 5 — evidence and completion

Root and an independent peer review phase A before source. Freeze exact candidate blobs/readbacks, then run the existing meaningful gates when an execution environment exists. If native behavior does not expose a required identity/policy/tool/result fact, retain it as unqualified and return a bounded design amendment; do not downgrade the proof, use direct HTTP, or promote a synthetic test result to native acceptance.

Current F consumes the previously captured D artifact; the later D ce03c60d620bfc6152623597637971ca8c529469 variant-projection source is separate evidence until F's normal verified pin/publication actually consumes it. Neither a future D source change nor a passed unrelated catalog/engine test closes this feature gap.

Completion requires both parts: actual native purpose proof with confirmed cleanup, and the subsequently reviewed connected policy/refusal at every new-allocation boundary with the original ordinary native/UI acceptance. Phase-A success, one supported tuple, a UI text Test or source review alone is explicitly insufficient.

### §16.1. Use the existing Linux V1 native case for the first purpose qualification

The §16 V1 TEST path was imprecise. `tests/native-opencode-host.native.ts` at `0e2020d1e0f4e28dd50c28e0c8312106835ee898` explicitly selects the Darwin ARM Node and the pinned Darwin1.19.4 executable. A Linux-only branch there would not execute. Leave that original case unchanged.

Substitute `tests/opencode-v1-version-host.native.ts`, exact preimage `1bece60cb1104033352e9b9c526ec3a8a0ba4ffa`, for that one path in the phase-A14-path inventory. This existing case asserts Linux x64 and Node24.21.0, verifies the original npm/native package identity and integrity, measures the selected executable and its actual --version, and already runs the original selected model/limits through Host, permission, tools, Stop and cold receipt readback.

Run the additional private purpose operation only when `!activeUpdate && version === '1.19.4'`, after original native/profile verification and before the first business Host allocation. Add the selected private management recipe before the original profile bytes/hash are frozen; retain the existing original composition/writer lease and complete native/endpoint cleanup before releasing that lease and starting the Host. All other V1 versions and the active-update variant retain their original behavior.

This case has eight original business model responses for its single original business input, not the Darwin case's eleven/two. Keep those eight responses, the one permission reply, exact task/message/file effect, selected model/limits and cold replay refusal unchanged. The separate three native coordination responses yield eleven total under the original model ceiling of sixteen. Preserve the existing normal180-second case deadline and active-update420-second variant; no new input, retry, job, version, matrix or timeout is authorized.

The V2 source-case selection and all other §16 paths remain unchanged. Linux V1 qualification does not qualify Darwin V1; actual native proof, connected phase B, context-floor/applicability policy and final synchronous consumption remain separately required. Source and compiler checks alone cannot close those gates.
