# 05. Выбор модели, default и проверка перед запуском

Статус: план реализации; production не изменён, новые E2E ещё не выполнены.
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
6. **05-E6 — Variant и сбой.** Выполнить baseline-qualified V2 variant, затем недопустимый variant/отказ доступа.
   Первый отражён native readback; второй сохраняет старый default и не создаёт ложную успешную проверку.

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
**R3 — интеграционное ревью с 02/03/06/07: pending; проверить shared ownership и отсутствие двойного бюджета.**
План не считается прошедшим R2/R3 только потому, что перечислил эти стадии.

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
