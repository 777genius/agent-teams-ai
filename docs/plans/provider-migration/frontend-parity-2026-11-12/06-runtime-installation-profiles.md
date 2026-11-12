# 06. Установка runtime и профиль следующего запуска

Статус: план реализации; production не изменён, сценарии ещё не выполнены.
Цель: сохранить существующие обнаружение, установку, выбор и обновление runtime в новой архитектуре.
Результат выбора применяется к следующим запускам; активные команды сохраняют исходный runtime/account binding.
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
Установка пакета не доказывает auth, model access или успех конкретного Team launch.

## 3. Acceptance criteria

- 06-A1: существующие source discovery/install/update choices доступны в Host режиме с прежним смыслом.
- 06-A2: UI показывает источник и применимость результата к следующему запуску понятным обычным текстом.
- 06-A3: только exact verified bytes/version/platform позволяют опубликовать новую available revision.
- 06-A4: после публикации новый capture использует новую revision, active capture остаётся на старой.
- 06-A5: изменение PATH/override во время операции не меняет уже захваченную цель установки/проверки.
- 06-A6: отмена/ошибка не публикуют незавершённый profile; предыдущая available revision остаётся применимой.
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
Внутри его canonical storage namespace добавить узкий owner **available provider selections**.
Это одна versioned запись выбора и указатель текущей revision на provider/context, а не общий migration framework.
Writer использует существующий `ProfileWriterLease`; public lifecycle реализуется одним небольшим use case.
Файловый adapter хранит immutable revisions и atomically published pointer; отдельная БД не нужна.
Изначальный descriptor импортируется как seed один раз, без запуска native работы и без смены Team owner.
`RuntimeTeamCaptures` сохраняет ссылку на выбранную revision вместе с уже существующим recipe digest.
Compile/replay выбирает именно эту revision; «latest» допустим только до первого capture нового intent.
Existing exact-member recipes/history продолжают ссылаться на старую revision до явного нового launch intent.
Management captures получают profileId/configRevision той же available revision; действующий command target не перепривязывается.
05 выводит model-specific candidate из base revision, не пишет current pointer на каждую смену draft model.
07 публикует config input через этот же use case, не создаёт второй settings-profile registry.
Account plan передаёт проверенный account binding; этот owner не хранит вторую копию credentials.

### Lifecycle операции

1. **Select:** зафиксировать существующий source choice, provider/context, previous revision и command identity.
2. **Prepare:** resolver/installer готовит candidate; app-controlled download ещё не является available profile.
3. **Verify:** проверить native identity, engine qualification, paths/bytes и применимый account/config snapshot.
4. **Publish:** сравнить previous revision, записать immutable candidate и атомарно сменить current pointer.
5. **Use:** новый probe/launch захватывает эту revision; старые binding и cancellation targets не меняются.
6. **Recover:** по command identity прочитать published receipt/previous pointer и вернуть известный исход.

Неизвестный native install outcome нельзя объявить failure или автоматически повторить как новый intent.
Если publication проиграла более новому выбору, candidate остаётся невыбранным; UI предлагает refresh существующего состояния.
Не реализовывать universal transaction/event-sourcing framework: использовать existing operation/receipt plumbing.
Новый record ограничен provider selection, его revisions и retained references; task/account/history данные не копировать.

## 5. Контракты и последовательность изменений

### 06.1. Зафиксировать минимальный private контракт

1. В `src/features/agent-backend/contracts/` добавить только DTO результата выбора, нужного existing UI.
2. В main application определить focused port публикации проверенной selection и чтения выбранной revision.
3. Private payload содержит provider/context, expected previous revision, source identity и verified artifact/config references.
4. Private source record сохраняет CLI/native generation, CLI version, engine version и source kind раздельно.
5. Секреты, native paths и receipt internals не попадают в renderer DTO; diagnostics используют existing redaction.
6. Согласовать поля с 01/02/05/07 до параллельной правки shared contract.

### 06.2. Реализовать owner без подмены существующих captures

1. Добавить узкий composition owner и file adapter в `packages/legacy-agent-host/src/`, рядом с existing profile ownership.
2. Использовать existing Host request validation/admission; публикация разрешена trusted Desktop intent, не model tool input.
3. Seed current template из `TeamHostProfile`, затем разрешать read by immutable selection revision.
4. В `runtimeRecipe.ts` передавать явно выбранный available source; existing source остаётся доступным для replay.
5. В `runtimeCaptureSource.ts` расширить сохранённую capture ссылку; старые records читаются по seed revision.
6. В `RuntimeTeamCaptures.ts` зафиксировать revision до async worktree/MCP preparation и перепроверить её currentness.
7. `CapturedProviderManagement`/composition используют тот же source owner, сохраняя retained read/cancel исходной команды.
8. Не перезапускать Host целиком при ordinary installer completion: это нарушило бы active binding других команд.

### 06.3. Соединить existing installer и resolver

1. `OpenCodeRuntimeInstallerService` остаётся владельцем package selection, integrity, extraction и progress.
2. В существующий successful result boundary подключить prepare/verify/publish; не вшивать policy внутрь IPC.
3. Передать native binary identity после wrapper resolution из `openCodeRuntimeBinaryEnv`.
4. OpenCode V2 CLI выбирает generation; engine/graph должен оставаться в pinned qualified contract.
5. Новая неподтверждённая engine version требует обычного qualification/release change, а не dynamic bypass.
6. Уточнить поведение same-version repair: не удалять directory с bytes, на которые ссылается active/recoverable capture.
7. При необходимости repair использовать уже применяемую immutable-instance схему и новый receipt, а не overwrite.
8. PATH/override файлы не копировать и не удалять автоматически; изменившаяся identity требует новой проверки выбора.

### 06.4. UI, refresh и recovery

1. `CapturedRuntimeProviderStatusClient.ts` получает available source status и отдельно активный captured status.
2. `runtimeProviderQuickConnect.ts` снимает blanket prohibition только после готового publication boundary.
3. Existing status/install UI отображает installation progress и отдельный результат выбора для нового запуска.
4. Known install success + failed publication отображаются раздельно; не заявлять, что приложение уже сменило runtime.
5. Cache invalidation затрагивает catalog/probe source revision; retained operation lookup остаётся связан с original target.
6. On restart восстановить pointer/receipts и затем captures; незавершённый candidate не становится current по наличию файла.
7. В baseline recovery test проверить старую Team с seed capture и новую Team с published revision одновременно.

## 6. Зависимости, PR и parallel write ownership

| Изменение | Writer | Условие передачи |
| --- | --- | --- |
| Available selection owner/record/contract | 06 | Минимальный contract review перед остальными consumers |
| Installer result → publication | 06 | Existing install verification reuse |
| Account binding для selected source | 01/02 | Отдают validated reference, не собственный publisher |
| Model candidate/probe | 05 | Читает revision, не меняет available pointer |
| Provider config snapshot | 07 | Передаёт prepared data этому publisher |
| Live slash change | 03 | Своё session command; не подменяет source pointer |
| Platform custody/packaging qualification | План платформ | Использует те же exact artifact references |

Первый PR: private contract + source owner + seed/recovery; затем installers/status; затем integration consumers.
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
   Их history/Resume используют свои bindings; новая Team получает текущий selection, не старый template.

Критичные unit/contract cases: CAS previous revision; duplicate command lookup; wrong hash/platform; malformed receipt.
Отдельно покрыть same-version repair с retained reference и старую capture без нового revision поля.
Не дублировать существующие archive traversal/integrity suites: расширить только изменённый boundary.
Один transport contract test проверяет, что renderer не может внедрить private source или owner.

## 8. Оценка и завершение

- Production: **1 400–2 300** новых/существенно изменённых строк, включая одну publication/recovery реализацию.
- Tests/E2E: **1 300–2 100** строк, ориентир 850–1 400 на реальные journeys и 450–700 на focused contracts.
- Оценка уточнена вверх: immutable source revisions/replay нельзя заменить одной invalidation cache строкой.
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
**R2 — независимое ревью source ownership/atomic recovery: pending.**
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
