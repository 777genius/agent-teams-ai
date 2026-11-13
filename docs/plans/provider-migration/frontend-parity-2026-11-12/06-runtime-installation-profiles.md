# 06. Установка runtime и профиль следующего запуска

Статус: source lifecycle и OpenCode installer consumers реализованы и проверены на Main/Host integration; полные Desktop/native journeys и расширение qualification ещё не завершены.
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
Revision фиксирует auth source/namespace, не его изменяемые secret bytes: explicit login/logout сохраняют native semantics.
Внешняя замена credential/config/executable файла проверяется соответствующим owner; она не разрешает silent rebind и не требует второго vault.
Новый profileId привязывается к immutable revision и добавляется через existing private admission; старый ID не перезаписывается.
Текущая реализация сохраняет все опубликованные revisions и их app-managed artifact closures: pruning/GC опубликованных
records/bytes не реализован. Поэтому capture до его durable записи также защищён этим консервативным retention.
Если позднее появится pruning, его отдельный план обязан учитывать live in-flight captures до первого await наряду
с existing captures/management receipts. Сейчас отдельные refcount store, GC daemon и миграция journals не нужны.

### Lifecycle операции

1. **Select:** зафиксировать существующий source choice, provider/context, previous revision и command identity.
2. **Prepare:** resolver/installer готовит candidate; app-controlled download ещё не является available profile.
3. **Verify:** проверить native identity, engine qualification, paths/bytes и применимый account/config snapshot.
4. **Publish:** сравнить previous revision; одной atomic index publication сохранить immutable candidate,
   его original commandId/previousRevision и current pointer. Отдельный management ACK receipt записывается после этого.
5. **Use:** новый probe/launch захватывает эту revision; старые binding и cancellation targets не меняются.
6. **Recover:** по command identity прочитать published receipt/previous pointer и вернуть известный исход.

Неизвестный native install outcome нельзя объявить failure или автоматически повторить как новый intent.
Если publication проиграла более новому выбору, candidate остаётся невыбранным; UI предлагает refresh существующего состояния.
Existing management receipt plumbing хранит publication command outcome. При потере ACK `lookup` находит original
commandId в сохранённой immutable index record и восстанавливает receipt; уже выбранный C не становится доказательством B.

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
**R3 — интеграционное ревью, выполнено root 2026-11-12; входной published SHA `cda065d869ccffb5930ed2a817b3e0654b00bb31`.**

- Проверены actual static capture/restore в `DesktopBackendFeature`, private `admitTeamProbeProfile` и `ProfileWriterLease`.
- Подтверждено: публикация требует Main-only trusted grant и Host verification; добавить одну map/current-pointer проекцию, а не менять descriptor задним числом.
- Найдена неоднозначность «immutable account»: сохранён source binding, не копия secret bytes. Explicit credential mutation и внешняя замена не маскируются новой revision.
- Один writer P06 владеет `DesktopBackendFeature`, `runtimeRecipe`, `runtimeCaptureSource`, `RuntimeTeamCaptures` и новым source index; P01/P02/P05/P07 передают небольшие mapping patches последовательно.
- Минимальный contract и recovery seed требуют peer review перед подключением consumers. План принят для этого первого среза; installer/native/active-old E2E ещё не выполнены.

## 10. Реализация первого среза — 2026-11-12

- Реализованы private Main→Host `runtime.source.current/retained/publish/lookup`, immutable source index под existing `ProfileWriterLease`, CAS и receipts в existing `FileManagementCommandStore`.
- Grant выводится из исходного descriptor и фиксирует provider/context/project/seed profile и original static Team scopes. Candidate не принимает account/environment/provider configuration; generic renderer management invoke этих методов не допускает.
- `RuntimeTeamCaptures` фиксирует revision до async preparation. Старый capture без ссылки читает seed; сохранённая ссылка восстанавливает original revision, независимо от current pointer.
- Сохранён побайтовый расчёт seed management targetId. Main восстанавливает retained target через исходный descriptor; новые immutable profile IDs допускаются existing account/probe/Skills/extensions owners.
- Первый admission разрешает только relocation/repair exact seed executable SHA и того же qualified embedded manifest/version. Это ещё не admission новой CLI version или перехода V1/V2.
- Проверки: Host production build и test types — PASS; source/templates/worktree/runtime-host — **50/50 PASS**; Main/real child Host и existing desktop/management — **17/17 PASS**; targeted fast lint и source-size guard — PASS.
- Проверены два последовательных publication, stale CAS, dedupe, old/retained replay после cold restart, ACK loss после pointer write, отказ при scope/bytes/config injection и missing published index. Native provider inference и Desktop installer UI этими тестами не подтверждаются.
- Изменение lazy semantics ограничено management capture: чтение current revision запускает выбранный Host; native provider operation начинается только по явному запросу. Connection discovery остаётся lazy.
- Root рассмотрел ограниченный срез и разрешил publication. Общий root typecheck переносится на combined gate: первый local запуск завершён exit 137 без TS diagnostics во время параллельных сборок; Host checks выше завершены успешно.
- Осталось: installer/discovery→native qualification→publication, поддержка нового version/generation и artifact retention, source consumers Create/Edit/Relaunch и P05/P07, реальные native/Desktop journeys раздела 7. Main merge/activation не выполнялись.

## 11. Source-aware Create и model consumers — 2026-11-12

- `captureCreateTeamDraft` и saved/captured model selection читают тот же source reference, что runtime capture. Legacy seed digest остаётся прежним; новая revision входит в draft/source evidence.
- Create проверяет source до registry mutation и сверяет фактический original capture перед start. Новая зелёная проверка current C не разрешает старый pending capture B; исходный уже admitted start продолжает использовать прежний receipt.
- Captured Edit/default берёт private recipe из retained revision, saved model configuration — из current revision. Publication не меняет действующие bindings и не возвращает default к seed executable.
- Отмена Create probe использует exact original intent в existing probe journal, без recapture текущего executor. Предыдущий seed context поддерживается для upgrade/recovery; чужой draft не может отменить исходный probe.
- R1 обнаружил потерю original cleanup после смены source и ложное использование fresh C proof для pending B; исправлены обе границы до review.
- Host build, test types, targeted lint и source-size guard — PASS. `team-create-launch`, `saved-team-model-probe`, `runtime-source-selection`, `management-model-probe`: **53/53 PASS**.
- Добавлены 5 сценариев с реальными source index/Team registry/capture/probe journals и тестовым provider driver. Это проверка composition/recovery, не native inference или Desktop UI E2E.
- Срез не объявляет готовыми installer/new-version/V1↔V2 qualification, V2 model/variant mapping, config parity или полный Create recovery UI после source conflict. Эти пункты остаются в 05/06/07 и финальной native/Desktop приёмке.

## 12. Native identity admission — 2026-11-12

- Private candidate различает `nativeCli` (path/hash/version/generation) и execution executable. Для V2 CLI выбирает generation, original qualified Bun/embedded 2.1.4 остаётся исполнителем; SDK revision Claude не выдаётся за CLI version.
- Новый SHA требует owned finite `--version`, точного ожидаемого ответа и проверки bytes до/после. Child получает только captured platform/home/config paths, без credential env, loader options или ambient `process.env`; output ограничен 4 KiB. Исходный 10s cap исправлен в срезе 13 под существующий installer budget.
- Current qualification намеренно конечная: Codex — existing 0.162.0 protocol pin; V1 — existing stable 1.x minimum 1.16.0; V2 — stable 2.x selector поверх captured qualified 2.1.4 engine. Для Claude новый SHA должен подтвердить ту же CLI version, что original seed. Более новая Claude/Codex version и V1↔V2 transition пока получают конкретный отказ.
- `runtime.source` использует existing command journal: prepared → verifying → verified → published, либо held с redacted reason. Receipt записывается до child; verified recovery не повторяет native execution, а published ACK recovery читает исходный outcome.
- Unknown cleanup удерживает original check/handle в живом owner. Повтор того же intent может подтвердить cleanup именно этого handle; cold verifying/held не создаёт child, не принимает PID и не становится current. Host shutdown отдельно сохраняет cleanup под исходным lease после seal admission.
- R1 исправил две реальные границы: не терять live handle при unknown cleanup; не терять подтверждённый cleanup при Host seal. Дополнительно проверены post-version byte drift и crash после verified до publication.
- Host production build и targeted fast lint — PASS. `runtime-source-native-identity`, `runtime-source-selection`, `management-model-probe`: **21/21 PASS**; real Main→child Host publication/restart: **1/1 PASS**.
- Восемь новых сценариев используют disposable shell fixtures для actual process ownership/`--version` и fault injection cleanup. Это не утверждение о выполненном inference настоящих Claude/Codex/OpenCode. V2 CLI/engine policy проверена структурно; native engine/Desktop journeys остаются required gates.
- На момент этой проверки общий `typecheck:test` имел только две параллельные Darwin/Linux fixture ошибки у platform owner, а size guard — три Desktop harness файла другого среза. Наши production files ≤800; combined gates повторяет root после интеграции.
- Осталось: installer/discovery publication consumer, отдельная квалификация последующих Claude/Codex versions и generation transition, full artifact acquisition/retention wiring, 05/07 и native/Desktop journeys. Main merge/activation не выполнялись.

## 13. Private native selection из installer — 2026-11-12

- В прежний private `publish` добавлен `nativeSelection`: Main передаёт фактически выбранный native CLI и, при наличии, verified engine delivery, не получает Host-private Bun path.
- Host нормализует selection в прежний полный candidate строго по `expectedRevision`. Наследование executor/delivery использует исходную retained revision, а не current pointer; fingerprint и existing journal остаются прежними.
- Повтор native-only и эквивалентного full-candidate запроса имеет один outcome, даже после следующего publication и cold restart. Неизвестная expected revision отвергается до запуска child.
- Исправлен native version budget: одна общая deadline 30 секунд, на Darwin 60 секунд, по существующему `openCodeVersionDiagnostics`; оба Claude reads делят этот бюджет. Этот срок не делает unqualified version совместимой.
- Host production build и test types — PASS; source identity/selection **14/14 PASS**. Real Main→child Host native publication и restart — **1/1 PASS**. Новые fixtures подтверждают replay/executor ownership; настоящий provider inference ими не заявляется.
- R1 проверил byte-order прежнего `publishRuntimeSourceSchema`, exact parent inheritance и недоступность операции generic renderer management. Для V2 отдельный тест меняет current graph/executor, затем восстанавливает original native-only receipt с прежней парой.
- `OpenCodeV2SupportInstaller.captureInstalled` использует existing installed receipt и полную проверку immutable delivery, выдаёт только original directory/manifest/platform для Host admission. Existing support suite **18/18 PASS**, targeted lint — PASS; lifecycle journey проверяет same-size corruption, repair в новый instance и сохранение исходной captured ссылки.
- Срез предоставляет private consumer seam; wiring установки/обнаружения в Desktop, квалификация новых Claude/Codex и V1↔V2, P05/P07 и native/Desktop acceptance остаются открытыми.

## 14. Installer consumer и восстановление исходной операции — 2026-11-12

- Existing Install и Refresh вызывают узкий `CapturedOpenCodeRuntimeInstaller`: sender/context/grant и previous revision фиксируются до acquisition. Только Host publication делает установленный native CLI доступным новому capture; промежуточный installer progress не выдаётся за завершённую Host-проверку.
- Existing `runtime.source` receipt сохраняет нормализованный publication input без credentials/environment. Новый Main-only `recover` продолжает единственную исходную незавершённую операцию до нового acquisition. Неизвестный cleanup или cold verifying не запускают второй child; legacy receipt без snapshot не восстанавливается из current defaults.
- Snapshot ограничен 2 MiB, file receipt для `runtime.source` — 4 MiB + 64 KiB с учётом JSON escaping до 256 original Team scopes. Остальные management receipts сохраняют прежний предел 64 KiB; JSON-RPC ceiling не расширен. Чтение выделяет буфер по проверенному размеру открытого файла.
- Ответ после lost ACK читается по original command ID. Даже если уже опубликован C, завершение B возвращает original B; новая current revision не используется как подтверждение старой операции. Немедленный Refresh после Install сверяет тот же receipt и не повторяет native `--version`.
- Status различает native CLI version, embedded engine version и opaque source revision. Existing managed-install action доступен для current Host source; explicit override сохраняет свой прежний запрет на managed replacement. Private executable paths не добавлены в Host status DTO.
- R1 повторно проверил recovery/fingerprint, original sender guards, generation preservation и status/progress ordering. Извлечён только existing provider-status composition, чтобы `agentBackend.ts` остался ниже frozen 800-line cap; новый service/registry/transaction log не добавлен.
- Source/identity recovery tests: **16/16 PASS**. Consumer suites: **110/110 PASS**, включая real Main→child Host→finite executable fixture, retained target после restart, lost ACK B/current C и восстановление prepared selection до нового acquisition. Focused canonical TypeScript, targeted lint и source-size guard — PASS.
- Эти проверки не являются native inference настоящего provider или Desktop UI acceptance. Открыты реальные E1–E6, новая Claude/Codex qualification и V1↔V2 переход, полный config/model consumer P05/P07. Main merge/activation не выполнялись.

## 15. Повторный source admission review — 2026-11-13

Сверен exact frontend `522c80d168d698fc6842ee649cc4822406cd2632`; review #1186 indices
2/3/11/25/31 рассматриваются по исходному коду, а не как готовые инструкции.

### R1 — подтверждённые границы существующего lifecycle

- `FileRuntimeSourceIndex.publish` уже атомарно сохраняет record с commandId/previousRevision и pointer;
  `RuntimeSourceIndex.lookup` чинит потерянный ACK по original record, даже после публикации C.
  Это уточнение §4, не новая transaction store и не изменение формата.
- Index не удаляет опубликованные revisions. `OpenCodeRuntimeInstallerService` создаёт V2 version directory с новым UUID;
  удаление temp/unpublished directory не является GC опубликованных bytes. Существующий installer отказывает
  несовместимой замене сохранённого V1 directory. Текущий in-flight capture не зависит от отсутствующего pruning.
- Исходный frontend задаёт cwd участника в saved member settings; текущий `runtimeCaptureCwd` уже определяет
  member override и worktree precedence. Source pointer должен выбираться для того же effective cwd, что recipe.

### R2 — три узких исправления до дальнейшей native приёмки

1. **Member cwd.** В `runtimeCaptureSource.ts:captureRuntimeRecipeSources` вызвать existing `runtimeCaptureCwd`
   для соответствующего roster member вместо общего `savedSettings.cwd`. Выбор всё ещё фиксируется до async preparation;
   lead и member без override сохраняют прежний cwd, future worktree не становится новым current lookup при replay.
   Тот же original member cwd передать в `recipes` → `resolveCapturedRuntimeRecipe`; иначе B reference сразу
   проверяется как A и отвергается. Здесь helper получает saved settings без later worktree override: reference
   выбирался до async подготовки, а конечный runtime cwd по-прежнему вычисляется с actual worktree targetPath.
2. **Повторное подтверждение cleanup.** В `RuntimeSourceIndex.close` снимать только совпадающий rejected closing Promise,
   сохраняя sealed admission, original native checks и durable unknown receipt. Следующий shutdown может повторно
   наблюдать/закрыть те же handles; он не запускает native verifier заново и не принимает новый process по PID.
   Успешно закрытые checks остаются удалёнными, успешный close остаётся idempotent.
3. **Ошибка до native allocation.** Если static candidate verification после durable `prepared` не проходит
   из-за отсутствующих/изменённых/нечитаемых bytes, сохранить исходный receipt как `held`, `resourceHeld:false`,
   с существующим `source-changed` (или точным configuration reason), затем вернуть bounded admission error.
   Запись требует существующей writer/cleanup authority. Не утверждать отсутствие process для verifying/unknown
   receipt: прежняя recovery ветка обязана вернуть его held до этого этапа. Новый явный исправленный intent после
   известного no-allocation refusal допустим; replay старого intent остаётся исходным отказом.

### R3 — проверить результат без новой тестовой подсистемы

- Расширить `runtime-source-selection.test.ts`: lead/project A и worker/effective project B фиксируют разные
  правильные source references, cold compile сохраняет их. Existing lost-ACK B/current-C и scope refusal оставить.
- В `runtime-source-native-identity.test.ts` расширить existing shutdown/unknown-cleanup сценарий: первое close
  unconfirmed, второе подтверждает **тот же** check; run count остаётся один. Добавить no-allocation static failure
  в существующий admission case: original terminal held, unchanged current, fresh repaired intent может завершиться.
- Host build/types, focused integration и existing lint/source cap обязательны. Native/Desktop acceptance остаётся
  отдельной проверкой exact HEAD; эти tests не выдаются за native provider inference.
- Отдельно остаются design gaps review 9/12/13/16/24/30: interrupted Create recovery, stale seed history,
  синхронное чтение большого executable, pathname verify→exec и auth replacement между source revisions.
  Повторный проход обнаружил связь 16 с 12: blanket dedup `teamScopes` меняет digest ранее опубликованного grant
  при том же targetId. Нельзя решать descriptor aliases изменением original record/fingerprint или повышением 256-scope
  limit; совместимость retained grant требует отдельного узкого решения до такого source edit.
  Этот срез не маскирует их, не вводит общий cache/owner/journal и не объявляет PR/планы полностью закрытыми.
- Статус: авторские проходы R1/R2/R3 выполнены по коду; независимое review и source implementation впереди.

## 16. Ограниченное асинхронное чтение выбранного executable — review 13

### Круг 1 — причина и сохраняемая функция

- Review `PRRT_kwDORVTEtM622S1p` сверён с source `64c33f663ba48f34352b927a5d4a88fb2ec04b12`.
  Existing `verifyRuntimeSourceCandidate.ts:verifyRuntimeSourceExecutable` принимает файл до 1 GiB,
  затем выполняет `readFileSync(fd)` и SHA256 всего Buffer в Host event loop. Проверка выполняется
  при admission и повторно непосредственно перед `RuntimeSourceIndex.publishCandidate` publication.
  Объявление внешней функции `async` не делает эти чтения асинхронными.
- Сохраняется существующий Install/Refresh/explicit source workflow из [M1]/[M3]: тот же выбранный путь,
  тот же expected SHA/version, тот же original command и qualified native verifier. Не менять installed
  executable location, формат selection/receipt или current/retained revision semantics.
- Это ограниченный срез чтения source selection. Отдельный `CapturedProcess.verifyExecutable` перед
  native `--version` пока тоже синхронный; его pathname verify→exec gap остаётся review 24.
  Этот план не обещает полностью устранить Host startup latency или создать pre-exec byte pin.

### Круг 2 — минимальный private read и publication boundary

1. В существующем `verifyRuntimeSourceCandidate.ts` читать исходный открытый descriptor асинхронно
   блоками не более 64 KiB и обновлять SHA256 по каждому прочитанному блоку. Не собирать весь файл
   в Buffer/array, не открывать pathname заново на каждый блок и не использовать worker/child/cache.
   Сохранить предел 1 GiB, canonical path, regular-file/no-follow, executable mode и точный expected SHA.
   Short read/EOF и growth проверять по фактическому числу bytes и original size; лишние bytes не принимать.
2. Сохранить private original descriptor и его dev/ino/size/mtimeNs/ctimeNs до завершения проверки.
   Перед/после чтения сверять opened fd и pathname; конечный recheck должен видеть именно original inode,
   а не новый файл по тому же имени. Все открытые descriptors закрывать в finally при success/refusal.
   Одновременно удерживается не более двух existing executable selections, никаких persistent handles.
3. Existing owner callback проверяет writer/sealed state до и после await каждого блока.
   Потеря authority или seal прекращает read до native allocation/admission; новая writer authority не
   превращает старую попытку в новый intent. Запись terminal no-allocation receipt использует прежний
   cleanup writer; без него нельзя заявлять завершённый cleanup или переписывать journal.
   Recovery verifying/unknown и повторное подтверждение original native cleanup из §15 не меняются.
4. Обновить оба existing callsites: первоначальную candidate verification и final verification после
   original native version outcome. Final async read удерживает проверенные fd до publication block.
   После последнего await повторить original writer/seal, fd/path identity и configuration checks;
   затем `lookup/admit/store.publish/receipt` выполняются без нового await до existing atomic publication.
   Сохранить existing store expectedRevision/CAS и original fingerprint; не переносить publication errors
   под catch, который мог бы переписать уже опубликованный outcome как static refusal.
5. Private fd/hash result нужен только внутри этой одной проверки; новый public API, owner, очередь,
   journal, retained cache или настройка лимита не добавляются. Изменения остаются в двух existing
   production files; `RuntimeSourceIndex.ts` сохраняет предел 800 строк без новой exception.

### Круг 3 — критическая проверка и независимый review

- В existing `runtime-source-native-identity.test.ts` один controlled finite executable размером в несколько
  блоков должен пропустить event-loop control callback до publication. Callback sealing/revocation
  запрещает native allocation/admission/current-pointer update и сохраняет original refusal/recovery.
  Это ordering assertion, не нестабильный wall-clock performance threshold и не 1 GiB benchmark.
- В том же existing boundary проверить replacement/byte drift между asynchronous read и final publication:
  проверенный старый fd не разрешает новый pathname; прежний pointer и original command outcome сохраняются.
  Сохранить existing verified/lost-ACK recovery, post-version drift и unknown-cleanup assertions.
- До source — independent plan review и immediate commit/push. После source — peer review обоих callsites,
  Host build/test types, затронутые integration tests, lint и size guard. Native/Desktop gates остаются
  штатными exact-source CI; новых runners, budgets, manual rerun или main merge нет.
- Статус: выполнены авторские source/design/test-plan проходы; compiler/native результаты не заявляются.

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
