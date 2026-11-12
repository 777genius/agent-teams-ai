# 06. Установка runtime и профиль следующего запуска

Статус: план реализации; production не изменён, сценарии ещё не выполнены.
Цель: сохранить существующие обнаружение, установку, выбор и обновление runtime в новой архитектуре.
Этот документ — единственный owner общего lifecycle профиля для планов 01–07.
Модели используют его в [05](05-model-selection.md), config/расширения — в [07](07-provider-settings-extensions.md).
Он не описывает миграцию основной ветки, Stage2 kernel или массовое переключение работающих команд.

## 1. Закреплённые источники

- Product main: `777genius/agent-teams-ai@4a0e06277fe216d9f82dbbede362668fe46622ee`.
- Stage1: `777genius/agent-teams-ai@1d0f97f55de566036c970eab4f36b84620afdb3f`.
- [M1] `OpenCodeRuntimeInstallerService`: обнаружение override/app-managed/PATH, native version probe, установка и update.
- [M2] `openCodeRuntimeBinaryEnv`: разрешение wrapper/native binary и существующих explicit overrides.
- [M3] `CliStatusSection`: существующий пользовательский путь проверки и обслуживания runtime.
- [M4] `runtime.lock.json`: main runtime `0.0.160`, отдельный qualified engine `2.1.4` и платформенные receipts.
- [S1] `runtimeProviderQuickConnect.canManagedInstallChangeOpenCodeRuntime`: captured-host сейчас нельзя сменить installer.
- [S2] `CapturedRuntimeProviderStatusClient`: captured engine ready, self-update/version/path presentation скрыты.
- [S3] `runtimeRecipe.resolveRuntimeRecipe`: exact member recipe и provider template для нового member.
- [S4] `RuntimeTeamCaptures`: durable capture/registration, replay исходного launch и восстановление.
- [S5] `ProfileWriterLease`: единственный writer canonical storage root; lock не доказывает native process custody.
- [S6] `loadDesktopBackendDescriptor`: trusted creation/management bindings, renderer не выбирает owner/path.
- [S7] `runtimeCaptureSource`: canonical saved settings, recipe digest и сохранённые ссылки на MCP.
- [S8] OpenCode installer slice уже имеет generation policy, immutable V2 support instances и byte verification.
- [S9] `DesktopBackendFeature.captureProviderManagement/restoreProviderManagement` пока ищут только статические descriptor bindings.
- [S10] `ProviderManagementCoordinator.admitProbeProfile` уже допускает immutable private profiles; разные bytes под тем же profileId отвергаются.

## 2. Что сохраняем и что требуется соединить

| Текущий пользовательский сценарий | Уже существует | Недостающая связка |
| --- | --- | --- |
| Использовать поставляемый runtime | Packaging и pinned qualification | Согласованный source label и next-launch profile |
| Найти установленный CLI | Resolver, native version probe, PATH | Результат discovery должен породить проверенный available profile |
| Скачать отсутствующий CLI | Installer и progress | После успеха native selection становится доступной новому capture |
| Обновить выбранную generation | Versioned install и support repair | Новая revision не заменяет active captured binding |
| Явный override | Существующие advanced/environment choices | Не делать silent fallback при timeout/несовместимости override |
| Refresh после изменения установки | Cache invalidation | UI/management/model probe видят одну новую selection revision |
| Перезапуск приложения | Descriptor и captured runtime recovery | Новые choices восстановлены, старые captures восстановлены по своей revision |

«Embedded» описывает способ доставки/запуска engine, а installed CLI описывает отдельный источник выбора.
CLI version, engine version и Host build нельзя свести в одно поле версии.
Не добавлять новую галерею источников: оставить уже существующие UI actions и advanced override semantics.
Если конкретный provider не предлагал обновление из UI, этот план не придумывает для него updater.

## 3. Acceptance criteria

- 06-A1: существующие source discovery/install/update choices доступны в Host режиме с прежним смыслом.
- 06-A2: UI показывает источник и применимость результата к следующему запуску понятным обычным текстом.
- 06-A3: только exact verified bytes/version/platform позволяют опубликовать новую available revision.
- 06-A4: после публикации новый capture использует новую revision, active capture остаётся на старой.
- 06-A5: изменение PATH/override во время операции не меняет уже захваченную цель установки/проверки.
- 06-A6: отмена/ошибка не публикуют candidate; предыдущая revision применима, пока её исходные bytes доступны и совпадают.
- 06-A7: повтор после неизвестного результата сначала читает исходный receipt и не запускает вторую установку вслепую.
- 06-A8: recovery старого launch читает его recipe revision, а не current provider template.
- 06-A9: update сохраняет generation V1/V2, если пользователь отдельно не выбрал переход.
- 06-A10: explicit override не заменяется app-managed бинарником только потому, что managed install прошёл успешно.
- 06-A11: busy текущая команда продолжает отвечать/останавливаться через своего owner после update другой команды.
- 06-A12: удаление старых app-owned bytes не происходит, пока на них ссылается live/recoverable capture.
- 06-A13: renderer не может передать новый private owner, executable hash или arbitrary provider profile.
- 06-A14: неполная qualification новой версии видна как конкретная причина до нового launch, без ложного Ready.

## 4. Один lifecycle и одна source of truth

Существующий Host private profile остаётся корнем доверия и seed для первоначальных recipes.
Не изменять задним числом descriptor/`TeamHostProfile` и не перезаписывать их сохранённые digest.
Расширить существующий private recipe source immutable **available selection revisions** и одним current pointer на provider/context.
Это индекс выбора исходного recipe, не второй capture store: runtime registrations, launch records и operation receipts остаются у existing owners.
Публикует уже работающий Host под своим `ProfileWriterLease`; Main не захватывает второй writer lock на тот же root.
File adapter хранит только новые base revisions/current pointer; seed revision читает неизменяемый descriptor, без копии всей team/account history.
`RuntimeTeamCaptures` сохраняет ссылку на выбранную revision вместе с уже существующим recipe digest.
Compile/replay читает эту revision; выбор current выполняется один раз до первого capture нового intent, включая exact-member recipe.
Existing exact-member recipes/history продолжают ссылаться на старую revision до явного нового launch intent.
Management captures получают profileId/configRevision той же available revision; действующий command target не перепривязывается.
05 выводит model-specific candidate из base revision, не пишет current pointer на каждую смену draft model.
07 публикует config input через этот же use case, не создаёт второй settings-profile registry.
Account plan передаёт существующий bound auth-resource reference; plaintext credentials не попадают в selection records.
Новый profileId привязывается к immutable revision и добавляется через existing private admission; старый ID не перезаписывается.
Retained references вычисляются из existing captures/management receipts; отдельные refcount store, GC daemon и миграция journals не нужны.

### Lifecycle операции

1. **Select:** зафиксировать существующий source choice, provider/context, previous revision и command identity.
2. **Prepare:** resolver/installer готовит candidate; app-controlled download ещё не является available profile.
3. **Verify:** проверить native identity, engine qualification, paths/bytes и применимый account/config snapshot.
4. **Publish:** сравнить previous revision, записать immutable candidate и атомарно сменить current pointer.
5. **Use:** новый probe/launch захватывает эту revision; старые binding и cancellation targets не меняются.
6. **Recover:** по command identity прочитать published receipt/previous pointer и вернуть известный исход.

Неизвестный native install outcome нельзя объявить failure или автоматически повторить как новый intent.
Если publication проиграла более новому выбору, candidate остаётся невыбранным; UI предлагает refresh существующего состояния.
Existing management receipt plumbing хранит publication command outcome; current pointer и receipt с одинаковым commandId сверяются при recovery.

## 5. Контракты и последовательность изменений

### 06.1. Зафиксировать минимальный private контракт

1. В `src/features/agent-backend/contracts/` добавить только DTO результата выбора, нужного existing UI.
2. В `DesktopBackendFeature` добавить Main-only publication port: existing installer/resolver result → captured descriptor owner/context → private Host request.
3. Host request принимает commandId/expected previous revision и verified source reference; scope выводится из existing trusted descriptor grant.
4. Private source record сохраняет CLI/native generation, CLI version, engine version и source kind раздельно.
5. Секреты, native paths и receipt internals не попадают в renderer DTO; diagnostics используют existing redaction.
6. Host повторно проверяет package/graph digest, canonical paths и native identity; renderer path/hash или model tool input не даёт права publication.

### 06.2. Реализовать owner без подмены существующих captures

1. Добавить узкий recipe-source adapter рядом с existing composition/profile ownership; не заменять `RuntimeTeamCaptures`.
2. Расширить private Main→Host operation allowlist и Host schema/authorization; общий renderer management payload остаётся без произвольных профилей.
3. Сохранить existing `admitProbeProfile` validation и immutable profileId; восстановить нужные revisions до чтения original operation journals.
4. В `runtimeRecipe.ts` передавать явно выбранный available source; existing source остаётся доступным для replay.
5. В `runtimeCaptureSource.ts` расширить сохранённую capture ссылку; старые records читаются по seed revision.
6. В `RuntimeTeamCaptures.ts` зафиксировать revision до async worktree/MCP preparation и перепроверить её currentness.
7. `DesktopBackendFeature.captureProviderManagement` выбирает current revision, `restoreProviderManagement(targetId)` ищет retained revision в Host source index под исходным descriptor grant.
8. Не перезапускать Host целиком при ordinary installer completion: это нарушило бы active binding других команд.

### 06.3. Соединить existing installer и resolver

1. `OpenCodeRuntimeInstallerService` остаётся владельцем package selection, integrity, extraction и progress.
2. В существующий successful result boundary подключить prepare/verify/publish; не вшивать policy внутрь IPC.
3. Передать native binary identity после wrapper resolution из `openCodeRuntimeBinaryEnv`.
4. OpenCode V2 CLI выбирает generation; engine/graph должен оставаться в pinned qualified contract.
5. Новая неподтверждённая engine version требует обычного qualification/release change, а не dynamic bypass.
6. Retention покрывает CLI, Bun/Node и embedded graph/package/manifest closure, а не только executable, пока есть live/recoverable references.
7. При необходимости repair использовать уже применяемую immutable-instance схему и новый receipt, а не overwrite.
8. PATH/override файлы не копировать и не удалять автоматически; при внешней замене old revision получает held, без silent rebind на новый binary.

### 06.4. UI, refresh и recovery

1. `CapturedRuntimeProviderStatusClient.ts` получает available source status и отдельно активный captured status.
2. `runtimeProviderQuickConnect.ts` снимает blanket prohibition только после готового publication boundary.
3. Existing status/install UI отображает installation progress и отдельный результат выбора для нового запуска.
4. Known install success + failed publication отображаются раздельно; не заявлять, что приложение уже сменило runtime.
5. Cache invalidation затрагивает новые reads; retained auth/probe/skill cancellation восстанавливает exact original targetId, даже если current revision иная.
6. On restart восстановить pointer/receipts и затем captures; незавершённый candidate не становится current по наличию файла.
7. В baseline recovery test проверить старую Team с seed capture и новую Team с published revision одновременно.

## 6. Зависимости, PR и parallel write ownership

| Изменение | Writer | Условие передачи |
| --- | --- | --- |
| Recipe-source revision index/contract | 06 | Минимальный contract review перед остальными consumers |
| Installer result → publication | 06 | Existing install verification reuse |
| Account binding для selected source | 01/02 | Отдают validated reference, не собственный publisher |
| Model candidate/probe | 05 | Читает revision, не меняет available pointer |
| Provider config snapshot | 07 | Передаёт prepared data этому publisher |
| Live slash change | 03 | Своё session command; не подменяет source pointer |
| Platform custody/packaging qualification | План платформ | Использует те же exact artifact references |

Первый PR: private contract + recipe-source revision index + seed/recovery; затем installers/status и consumers.
`runtimeCaptureSource.ts` и `CapturedRuntimeProviderStatusClient.ts` изменяются последовательно, с явным владельцем diff.
Не объединять все планы в один большой refactor и не переносить существующие файлы ради симметрии каталогов.
После contract merge в feature lane 05/07 работают в своих helpers; интеграционные изменения в 06 делает один writer.
Merge в main и activation не являются частью этого плана.

## 7. Реальные E2E journeys

Desktop проверяется через `pnpm dev:mcp`/CDP, только на новых test projects и test-owned installations.
Архивы/installed receipts фиксируют exact versions; для изменения версии используют qualified пару, не latest на момент теста.

1. **06-E1 — Отсутствует runtime.** Открыть existing install action, скачать, увидеть progress и выбрать результат.
   Создать Team; native identity совпадает с опубликованной revision, а UI не требует ручной правки descriptor.
2. **06-E2 — Installed/PATH.** С разрешённым test PATH обнаружить совместимый CLI и выполнить новый launch.
   Затем сменить PATH до окончания refresh: старый ответ не меняет более новый выбор.
3. **06-E3 — Update при active Team.** A работает на revision N; обновить managed runtime и запустить B на N+1.
   A отвечает и штатно останавливается через N, B использует N+1; чужие процессы не затронуты.
4. **06-E4 — Override и managed install.** Выбрать test override, выполнить managed install/update.
   Override остаётся effective; после явного снятия override следующий launch использует проверенную managed revision.
5. **06-E5 — Сбой и restart.** Оборвать test-owned операцию после extraction и отдельно после pointer publication.
   Restart восстанавливает соответственно N или N+1; не делает второй download/install без нового intent.
6. **06-E6 — V1/V2/support repair.** Обновить V1 в V1, явно выбрать V2 и выполнить support-only repair.
   CLI/engine versions раздельны, квалификация соблюдена, active old capture не теряет доступ к своим bytes.
7. **06-E7 — Saved capture coexistence.** Перезапустить app с сохранённой seed Team и published Team.
   History/Resume используют свои bindings; новый launch берёт current selection; pending auth/probe N читается/отменяется после публикации N+1.

Критичные unit/contract: CAS/duplicate publication; запрет private source injection; old-target restore после смены revision.
Hash/platform/malformed receipt suites переиспользовать; same-version repair и old seed record проверять E2E recovery, без зеркальной mock-матрицы.
Не дублировать существующие archive traversal/integrity suites: расширить только изменённый boundary.
Один transport contract test проверяет, что renderer не может внедрить private source или owner.

## 8. Оценка и завершение

- Production: **1 400–2 300** новых/существенно изменённых строк, включая одну publication/recovery реализацию.
- Tests/E2E: **1 000–1 700** строк, ориентир 850–1 400 E2E и 150–300 на опасные admission/publication contracts.
- Все общие profile costs посчитаны здесь один раз; model mapping, auth protocol, config transformations — в owners планов.
- Сложность: **8/10**; ожидаемая надёжность после acceptance: **8/10**; уверенность оценки: **7/10**.
- Done: 06-A1…A14 и 06-E1…E7, evidence двух concurrent revisions, crash recovery и exact-head CI.
- Existing native process custody/UNKNOWN semantics сохраняются; store lock не используется как право завершить процесс.
- Нельзя закрыть план только unit-тестами publisher или успешным скачиванием без launch/readback.

## 9. Ревью плана

**R1 — собственное критическое ревью выполнено 2026-11-12; найденные ошибки исправлены в тексте.**
Найдено: замена current template ломала бы replay старого capture, который заново вычисляет recipe digest.
Исправлено: capture хранит selection revision; immutable records остаются читаемыми после нового выбора.
Найдено: same-version repair может удалить directory, нужную active binding, даже при versioned install.
Исправлено: 06.3.6–7 и 06-E6 требуют retention/новый immutable instance до publication.
Найдено: прежнее описание «установить новую версию» смешивало CLI version и qualified engine version.
Исправлено: разные поля, отдельная qualification и explicit refusal до launch.
**R2 — source review выполнено 2026-11-12; reviewer `estimate_account_commands`, reviewed commit `01547868d3da2636902691b8c13eb4fbaca8f080`.**
Найдено: новый selection owner мог дублировать durable capture; private «trusted intent» не называл actual вход и retained management lookup.
Исправлено: добавляется только base-recipe revision index; existing captures/receipts сохраняются, Main-only installer result проходит Host admission под descriptor grant.
Найдено: текущие capture/restore management ищут статический descriptor, а coordinators не допускают replacement существующего profileId.
Исправлено: current/retained lookup разделены, immutable revision получает новый profileId через existing admission, original target остаётся доступным.
Найдено: retention лишь executable недостаточен для V2 graph; внешний PATH нельзя гарантировать неизменяемым.
Исправлено: сохранена app-owned dependency closure, external mutation даёт held; unit budget сокращён за reuse existing suites.
**R3 — совместное ревью 01/02/03/05/07 и platform plan: pending; закрыть контракт и file ownership до implementation.**

[M1]: https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/main/services/infrastructure/OpenCodeRuntimeInstallerService.ts
[M2]: https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/main/services/runtime/openCodeRuntimeBinaryEnv.ts
[M3]: https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/renderer/components/settings/sections/CliStatusSection.tsx
[M4]: https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/runtime.lock.json
[S1]: https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/src/features/runtime-provider-management/core/domain/runtimeProviderQuickConnect.ts
[S2]: https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/src/features/runtime-provider-management/main/adapters/output/CapturedRuntimeProviderStatusClient.ts
[S3]: https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/composition/runtimeRecipe.ts
[S4]: https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/composition/RuntimeTeamCaptures.ts
[S5]: https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/adapters/profile/ProfileWriterLease.ts
[S6]: https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/src/features/agent-backend/main/infrastructure/loadDesktopBackendDescriptor.ts
[S7]: https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/composition/runtimeCaptureSource.ts
[S8]: https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/src/features/opencode-runtime-installer/README.md
[S9]: https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/src/features/agent-backend/main/composition/DesktopBackendFeature.ts
[S10]: https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/composition/ProviderManagementCoordinator.ts
