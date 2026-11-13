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
