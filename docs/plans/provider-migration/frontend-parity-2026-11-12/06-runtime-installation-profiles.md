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

### §16: проверенный source cut асинхронного хеширования

`verifyRuntimeSourceCandidate` и оба места проверки в `RuntimeSourceIndex` используют async reads
не более64KiB с прежним полным SHA-256 и пределом1GiB. Исходные дескрипторы удерживаются до
финальной синхронной проверки fd/path и публикации; проверки writer/seal выполняются вокруг await,
а все выходы закрывают дескрипторы. Ошибка после публикации не превращает её в статический отказ.

Независимое source review Account и root — PASS. Сборка Host, test types, 20 existing identity/selection
сценариев, fast lint и source cap — PASS; совместная root-проверка с R7 credentials: 37/37 PASS.
Actual native/Desktop ещё требует обычного CI. Этот срез не закрывает pre-exec pathname race,
stale seed/retained history, дедупликацию grant scopes или восстановление Create после source mismatch.

## 17. Published Create восстанавливается после смены runtime source — review 9

План до source. Review `PRRT_kwDORVTEtM622S08`; current source проверен на
`64c33f663ba48f34352b927a5d4a88fb2ec04b12` (эти Create/model paths не менялись в
`a2f327c8b07142a2ec857a5be6e0924c84f0fcef`). База этого документа —
`76b31ccc39984695f0f986e2c5d8a94bfeb770ec`; §15–16 и их actual proof сохранены.

### Круг 1 — конкретная ошибка и прежняя возможность

- В `CreateTeamLaunchCoordinator.submit` registry уже published и capture B уже
  зарегистрирован до проверки `readLaunchSourceSelections`. Если исходный submit
  прерван здесь, `lookup` возвращает null до start admission. После source C
  новый model proof C не может законно запустить immutable B; повтор original Create
  отказывает `creation-source-changed`. Existing test в `team-create-launch.test.ts`
  доказывает отсутствие открытия, но не возможность продолжить работу.
- `CapturedTeamRegistry.submitCreation` превращает даже известную published Team в
  hold/unknown; `retainedCreateSubmission` поэтому держит единственный Create slot.
  Нельзя освободить slot по одному отсутствующему start record: original submit
  может ещё продолжать async capture/worktree и позднее стартовать.
- Донор `4a0e06277fe216d9f82dbbede362668fe46622ee`:
  `CreateTeamDialog.tsx:2173–2250` отдельно сохраняет Team через createConfig и
  открывает её; ordinary Launch существует в
  `TeamProvisioningCreateLaunchOrchestration.ts:198+`. Сохраняем возможность
  работать с уже созданной Team и явно запустить её позже. Не утверждаем, что
  донор имел именно новый Host receipt recovery.
- Current ordinary `createHostTeamLaunchSubmission` уже даёт fresh command →
  `capture:<command>` → start. `TeamRuntimeRegistration` и
  `teamRoster.assertRosterEditable` проверяют исходные unresolved/attached resources,
  а `executeRuntimeLaunch` повторяет current-roster guard после worktree await.
  Эти owner guards сохраняются.
- Второй найденный seam: `model.configuration.read` для ещё не запущенного B сейчас
  возвращает B; same-provider draft probe сохраняет B sourceReference. Одна
  partial-навигация не доказывает цепь current C → proof C → capture C → start C.

### Круг 2 — один partial result и существующий prospective model read

1. В existing Create coordinator удерживать только active original command IDs на
   lifetime самого исходного submit Promise: захват до первого await, удаление только
   после settlement в finally. Timeout/abort RPC не завершает этот lifetime. Это ограничено
   текущей Host RPC concurrency; отдельного scheduler, очереди, таймера или журнала
   нет. Concurrent same-ID submit/lookup возвращает прежний held/unknown, не
   наблюдает временное отсутствие start как завершённую операцию.
2. Original lookup по exact command/draft/context по-прежнему сначала проверяет
   registry и полный retained capture. Если original start admitted — прежний
   replay/read. Если полного capture ещё нет, registry pending, writer потерян,
   record повреждён или custody неопределённа — прежний hold/unknown, без partial.
   Для completed capture без original start проверить исходный summary и Runtime
   bindings этого original capture через existing read/roster proof: startedAtMs=null,
   summary.admission отсутствует (и preparation, и aggregate start любого command,
   не только ids.start), все attempts unclaimed, no attached/unresolved resources.
   TeamLaunchOwner.summary уже выводит admission из record.preparation либо
   record.startCommandId; чужой admitted/prepared command не становится partial. Более поздний
   другой run этой Team не приписывается старой команде; его outcome остаётся в
   existing Team/runtime read, а partial не заявляет его cleanup. Проверка не останавливает и не
   открывает process. Только этот конкретный pre-admission случай даёт
   `partialCreated` с original creation receipt и actual retained launch summary.
3. Same-ID submit, прочитав такой partial, только возвращает его. Он не возобновляет
   start B, не переписывает capture B/его source refs и не создаёт новую Team.
   Первое выполнение, ещё не опубликовавшее Team, сохраняет прежний Create+Launch
   путь. Изменённый draft с тем же ID остаётся conflict; unknown record не становится
   partial по catch-all. Новый durable terminal marker не нужен для этой границы:
   inactive submit + existing completed capture/owner proof дают явный read branch.
4. `CapturedTeamRegistry` после отказа/потерянного ACK делает один original
   `team.creation.lookup`; он умеет вернуть и admitted, и partial result.
   Только owner-confirmed отсутствие создания позволяет прежний editable refusal.
   Main регистрирует тот же canonical handle через existing `registerDynamic`.
   В private result добавить закрытый additive `partialCreated:true`;
   public `TeamCreateResponse.launchStatus` получает `unconfirmed`.
   runId остаётся ID **настоящего capture B**, не фиктивным admission/native session.
5. Existing renderer Host-create helper проверяет canonical team/run IDs и делает
   ordinary fetchTeams. Для `unconfirmed` он не включает provisioning polling и
   не показывает запуск успешным. Existing Create completion освобождает только
   original intent при прежнем foreground epoch и открывает эту Team. В existing
   TeamList confirmation/notice показать: Team сохранена, запуск не подтверждён;
   дальнейший Launch — явное действие на существующей Team. Organization placement
   и original context-change/unknown holds не меняются.
6. Для этого ещё не начатого complete capture использовать existing
   `savedTeamModelProbe` как **model-only prospective** read current C.
   Eligibility проверяется Host-side при read и каждом existing probe current check:
   exact current captured Team/roster, отсутствует summary.admission любого command
   (включая preparation), отсутствует claimed attempt,
   исходные Runtime bindings не attached и не имеют unresolved custody. Для
   prospective C проверить **все retained launches/resources этой Team**, как уже
   делает RuntimeTeamCoordinator.assertRosterEditable, а не только latest B.
   Existing `assertRosterEditable` можно переиспользовать с read-authority mode
   только для этой inspection; мутации сохраняют прежний control mode.
   Ранее зарегистрированная история сама по себе не даёт eligibility.
7. `model.configuration.read` для eligible never-started capture возвращает existing
   `saved-model-` source digest от текущего saved roster + source C. Этот digest,
   original authority и source refs проходят existing `captureSavedTeamModelProbe`;
   `source(options)` повторно проверяет eligibility и C при продолжении probe.
   Native start/claim, смена roster/source/authority делают proof stale. Перед новым
   capture/start остаются existing registration/roster/source guards; зелёный UI
   check сам по себе не даёт полномочий обойти их.
   Running/admitted A, Resume и обычный pinned capture model path остаются прежними;
   не менять общее правило same-provider draft на latest defaults.
8. После зелёного C пользователь делает ordinary Launch: current roster save →
   fresh capture command C → start C. Existing synchronous registration/admission
   и post-await current guards запрещают поздний start B после C; если B уже
   admitted/attached/unknown, existing mutation refusal сохраняется.
   Старые records/unknown ownership не удаляются, никакого automatic Stop/retry.

### Круг 3 — доказать полную recovery цепь в existing tests

- Расширить existing interrupted-Create case с реальными registry/runtime/source
  journals: B preflight → published complete capture B → injected interruption
  до start → source C → original lookup/submit partial → cold read того же result.
  Ordinary model.configuration/probe должен выбрать именно executable/source C,
  затем existing roster/capture/start с fresh ID открывает только C один раз.
  Старый Create после этого не открывает B и не меняет его record/source references.
  Существующий running-B/defaults-after-C test остаётся byte-for-byte по assertions.
- В том же existing file проверить concurrent same-ID lookup/submit на deferred
  capture: пока original flow жив, partial недоступен; после отказа он доступен
  только при выполненных owner checks. Claimed/unknown custody и незавершённый
  capture/worktree не подтверждают partial. Это finite controlled composition,
  не заявка на native provider inference.
- Existing Main Create/refusal tests проверяют один original lookup, canonical
  registration, additive projection и сохранение ambiguous transport hold.
  Existing renderer Create test проверяет same-owner partial → navigation/slot
  release без provisioning poll; foreground change и настоящий unknown сохраняют slot.
  Новая suite, runner или искусственный native failpoint не нужны.
- Source closure: existing CreateTeamLaunchCoordinator/RuntimeTeamCoordinator,
  createLaunchContracts, executeRuntimeLaunch/savedTeamModelProbe/teamRoster;
  existing Main CapturedTeamRegistry/createdHostTeam, shared response,
  renderer Host-create helper/TeamList. Никакого нового owner/journal/framework.
  Before code — independent plan review + root commit/push; after code —
  independent authority/recovery review, Host/Main/renderer targeted types,
  existing critical tests, lint/caps и штатный native/Desktop Create/Launch CI.
  Actual CI подтверждает обычный UI/native path; injected interruption отдельно
  обозначается как controlled journal recovery, без переноса native PASS на него.

Donor references:
[Create form](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/renderer/components/team/dialogs/CreateTeamDialog.tsx),
[Create/Launch orchestration](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/main/services/team/provisioning/TeamProvisioningCreateLaunchOrchestration.ts).

## 18. Повторные descriptor handles не расширяют source grant — review 16

План до source; thread `PRRT_kwDORVTEtM622S17`, parity
`cd2406a1cd040cf451a504857ebd5c985579c3da`. `DesktopBackendFeature.captureSourceTarget`
переносит каждый подходящий handle в `teamScopes`. Descriptor допускает512 handles,
private grant —256 scopes. Несколько handles одной Team имеют одинаковую тройку
team/project/workspace и не дают новых прав, но257 таких aliases блокируют capture.

### Круг1 — совместимость исходных записей

Main-only dedup недостаточен. `managementTargetId` зависит от selected+owner и
не меняется от aliases; `RuntimeSourceIndex` включает **полную исходную** grant
representation в seedRevision, publication revision/fingerprint, receipt selectionDigest
и publicationJson. Существующие records/receipts могли сохранить повторные scopes.
Нельзя переписать их, нормализовать при чтении schema или ослабить проверку старых hashes.

1. В existing Main `captureSourceTarget` убрать только одинаковые тройки
   `(teamId, projectId, workspaceId)`, сохранив первый порядок distinct triples.
   Фильтр original context/owner сохраняется. Grant schema по-прежнему требует
   максимум256 **distinct** scopes;257 реально разных не обрезаются и не принимаются.
   targetId, owner/context/seed fields и descriptor512 bound не меняются.
2. В Host boundary сопоставлять новый grant с **исходной сохранённой representation**
   только при точном равенстве всех остальных fields и равенстве множеств троек.
   Перестановка/повтор одного scope не меняют authority; добавление, удаление
   scope, чужой owner/revision/context/path/runtime/profile/config по-прежнему conflict.
   Incoming grant и original grant отдельно проходят прежний current seed/authority
   validator. Это не решение отдельного stale-seed review12.
3. Для lookup/replay конкретного command первым источником является его original
   publicationJson, если он существует. До повторного использования проверить его
   прежние command/source/resource/profile/config/provider, expectedRevision,
   fingerprint, selectionDigest и revision против **его исходного grant+seed**.
   После equivalence check использовать тот же original grant в existing algorithm.
   Terminal rejected/no-allocation operation остаётся собственным receipt, даже если
   позже опубликована другая операция; не превращать её в новый native effect.
4. Для current/retained/new publication использовать original grant из полностью
   валидированной existing source chain. Если первой index publication ещё нет,
   единственная unfinished original operation с валидным publicationJson сохраняет
   свою representation и исходный seed revision. Несколько unfinished operations,
   отсутствие нужного snapshot либо повреждённый snapshot не разрешают догадку,
   новый grant baseline или повтор native verification; прежний held остаётся held.
   При отсутствии retained/unfinished authority новый grant сохраняется как получен.
5. Применить binding последовательно к current, retained, lookup, recover,
   refreshConfiguration и capturePublication, **до** вычисления новых fingerprints.
   Existing raw journal validation, previous-revision chain, pointer CAS,
   exact original request/candidate identity, native identity/cleanup, pending same-ID
   coordination и immutable records сохраняются. При повторном вызове не читается
   current UI selection вместо original scope.
6. `RuntimeSourceIndex.ts` сейчас770 lines при cap800. Перенести существующий
   чистый publicationSnapshot validator и маленькое scope-equivalence сравнение в
   один узкий `runtimeSourceGrantAuthority.ts`; storage owner остаётся прежним.
   Snapshot validator не получает новый journal, writer, cache или API.
   Main dedup остаётся в existing capture method; новая generic grant migration,
   schema transform, version registry и background repair не нужны.

### Круг2 — конечные проверки

- Existing real Main/Host source test: private descriptor с257 aliases одной
  допустимой Team проходит source capture/current через настоящий Host subprocess;
  полученный original grant содержит одну тройку. Foreign-context/owner handles
  не попадают в неё. Отдельная existing-schema negative сохраняет отказ257 distinct.
- Existing Host publication/cold test: сначала сохранить допустимый legacy grant
  с duplicate scopes; затем new deduplicated/reordered equivalent grant читает тот
  же current/retained и original lookup/replay. До/после read byte-for-byte сравнить
  original index/receipt. Следующая новая publication продолжает исходную chain и
  сохраняет её grant representation; original command не re-admit/re-execute.
- Existing crash/recovery test дополнить потерей выполнения после durable prepared
  snapshot **до первой index publication**, затем cold recover через deduplicated
  grant. Сохраняются original commandId/fingerprint/selectionDigest/revision/
  publicationJson; candidate не заменяется текущим selection. Existing lost-ACK
  after pointer case остаётся. Corrupt/missing/ambiguous snapshot отказывает.
- Existing scope-widening case дополнить удалением/добавлением реально другого
  разрешённого scope: семантическое отличие не маскируется dedup. No new unit suite;
  только реальные boundary/recovery assertions в existing integration files.
- Host build/test types, focused Main types, existing affected integration files,
  lint/cap и independent source review. Actual provider/Desktop flows остаются
  штатным exact-head CI; controlled fixture не квалифицирует native inference.

### Круг3 — границы решения

Review12 (изменившийся bootstrap seed), review24 (verify→exec pathname race) и
§17 Create recovery не входят в этот cut. Не ослаблять `seed()` и original chain
validators ради прохождения нового alias case. Root публикует и проверяет этот
план перед source; independent review должен отдельно проверить сохранность
pre-first-publication recovery и отсутствие silent widening/old-hash rewriting.

Independent plan review (Profiles) — PASS. Выбор source chain/unfinished intent
ограничен тем же targetId; чужая source operation не задаёт эту representation.
Published либо unfinished original command при наличии chain должен сохранить
её **raw** original grant, не только эквивалентный set. Terminal held/no-resource
receipt без собственного index record читается как его прежний отказ; он не
меняет более позднюю chain и не разрешает новый native effect.

### §18 validation: исправить прежний prepared-recovery TEST oracle

После correction Host20/20 existing source-selection/native-identity cases PASS,
включая duplicate/reordered grant, immutable read/replay и два cold recovery окна.
Existing Main file дал4/5 PASS; его старый `restarted installer` case ожидает
prepared после публикации **отсутствующего** executable. Это противоречит уже
принятому §15 R2: static source refusal сохраняется terminal held/no-resource и
не восстанавливается созданием файла задним числом. Новый alias binding это
поведение не вводит; отказ обнаружился при полном existing-file прогоне.

Минимально исправить сам существующий TEST case: подготовить valid original
executable до publication; existing private TEST Host entry вызывает настоящий
FileManagementCommandStore.write для original prepared record и затем один
TEST-scoped throw, имитируя потерю выполнения после durable intent. Такая же
граница уже используется existing Host interruptPrepared helper. Ни production
failpoint, ни изменение raw record, fake receipt или native replay не добавляются.
Cold restart восстанавливает тот же saved publication через штатный installer,
без нового acquisition/candidate capture; missing-file static refusal остаётся
отдельно проверенной immutable held. Counts/budgets и existing native identity
tests сохраняются. Root source-круг и negative baseline: старый built Host отказал
в новых двух alias/recovery cases; rebuilt Host прошёл все20.

### §17/§18 source cut: recovery и aliases

§17 production/test candidate состоит из14 existing files. Account независимо
перечитал Host core; root проверил все production deltas и три meaningful existing
test deltas, включая concurrent original submit, cold partial read, actual model
proof C и fresh launch C без старого B replay. §18 добавляет пять files (один
маленький чистый validator extraction); Profiles и root source review — PASS.

До отключения executor наблюдались: §17 Host12/12, Main/renderer35/35,
targeted types/build/lint PASS; §18 Host20/20, real Main/Host5/5, Host testtypes,
build и fast lint PASS. Старый built Host воспроизвёл оба alias/cold refusal.
Основной Main recovery oracle теперь создаёт valid executable и прерывается
только после настоящего durable prepared write; static missing-file refusal
по-прежнему terminal held и не используется как crash simulation.

Executor отключился до финальной фиксации всех local Git SHA. Source восстановлен
из exact base `cd2406a1cd040cf451a504857ebd5c985579c3da` и записанных edits;
все19 новых immutable blobs проверены полным GitHub readback. Четыре tracked §18
prefixes и шесть §17 prefixes совпали с independently прочитанным local git diff
до потери среды. Это не перенос прежнего execution PASS на новый commit:
source review завершён, **точный опубликованный head ещё требует штатного CI**.
Ни один native/Desktop gate, неизвестный outcome или неполный локальный native
producer не объявляется прошедшим из-за этой реконструкции.

§17 manifest `217ea431c595d51262766cd4f65b7c6d8517d6f8` сохраняет разницу
между прежними local checks и новым candidate. §18 original authority/receipt
representations неизменны; source Index774, helper50 и Main feature778 lines.
Новые owners/journals, unit suites, timeout increases и skip не добавлены.

## 19. Старый source не должен останавливать весь Host (review1186/12)

Основание — актуальный source `3db75ad8`, а не предположение по review.
В `RuntimeSourceIndex.ts:719–774` каждый retained record проходит `seed()`
против **нынешнего** private profile; constructor вызывает этот read, а
`retainedManagementProfiles()` немедленно строит все старые profiles.
Изменение owner revision, удалённый Team scope или отсутствующий management seed
одного record поэтому препятствуют загрузке всех остальных sources.
`RuntimeTeamCaptures.restore():56–62,312–328` затем eager-compile всех captures,
а `RuntimeTeamCoordinator.ts:111–123,270–309` успевает установить seed entries
до этого восстановления. Исправление одного constructor недостаточно.

Прежний пользовательский смысл [M1–M3, S3–S7] сохраняется: выбор следующего
runtime не переназначает старый запуск; повреждение/недоступность его исходного
профиля не должны менять выбор другой команды. Этот срез не вводит bootstrap
migration, восстановление private env по digest или adoption старого процесса.
Исходный review thread: `PRRT_kwDORVTEtM622S1n`.
§17 recovery и §18 original grant representation остаются обязательными.

### Круг1 — целостность истории отдельно от права её исполнить

1. В existing source owner отделить полный structural history read от проверки
   current eligibility конкретного source. Ни records, ни current pointers не
   фильтровать из сохранённого index и не перезаписывать. Существующие file bounds,
   no-follow/identity, schema/digest, unique identities, revision formula,
   target chain и pointer equality проверяются **для всех** records, как прежде.
   Corrupt/missing journal, несогласованные fingerprint/command/source/resource/
   profile/config/provider, broken chain и чужой snapshot по-прежнему held,
   а не «устаревший seed».
2. Связать original receipt с record и его original grant без подстановки нового
   private seed. Первый previousRevision должен равняться original
   `selectionDigest`; следующие records сохраняют ту же raw grant representation
   и тот же исходный selectionDigest. Original publicationJson, когда он имеется,
   проходит прежние payload/fingerprint/revision проверки против самого receipt.
   Уже поддержанные records без snapshot не переписывать и не отвергать только
   из-за отсутствия нового поля; unfinished recovery без нужного snapshot
   остаётся held. Recorded selectionDigest в этом чтении — **ссылка истории**,
   не доказательство существования/пригодности private recipe.
3. Перед возвратом runnable management profile, current source, probe, новым
   capture, publication/recovery или resolve original reference отдельно выполнить
   прежние current owner/scope/seed checks, recompute exact
   `runtimeDigest({ grant, seed })`, qualification и native identity checks.
   Только конкретное отсутствие/несовпадение current seed/authority после
   structural validation получает private typed unavailable outcome.
   Arbitrary exception, I/O, malformed candidate или повреждённый receipt
   таким outcome не становятся. Никакого «если нет old seed, взять новый».
4. `retainedManagementProfiles()` допускает в existing management registry только
   eligible exact profiles; history всё равно остаётся полностью проверенной.
   Original pending/unknown management commands и resource fences сохраняются
   под исходными IDs, включая случаи, когда соответствующий profile недоступен.
   Не запускать новое исполнение/cancel по другому profile и не освобождать fence
   из-за фильтрации runnable profiles. Composition должна учитывать retained
   source history и когда current management seed больше не задан.
5. Для recipe selection сначала определить original matching scope/runtime/path
   и его project/global specificity, затем проверить eligibility выбранного
   source. Selected unavailable project source не разрешает fallback на global
   или seed; original explicit reference всегда разрешается только в его record.
   Bare seed допустим лишь при настоящем отсутствии matching retained selection.
   Existing ambiguity остаётся held; unrelated scopes/providers не блокируются.
   Историческая scope matching не выдаёт нынешнее право: current authority
   проверяется отдельно непосредственно перед использованием.
6. Реальное добавление/удаление scope не эквивалентно aliases §18. В этом срезе
   targetId/fingerprint и scope-set authority не меняются: несовместимый original
   target остаётся локально held/conflict. Не объявлять это автоматической
   поддержкой изменения descriptor grants. Другая eligible explicit selection
   в другом original target должна работать без переписывания старой chain.

### Круг2 — восстановление Team и исходный cleanup debt

7. В existing `RuntimeTeamCaptures` сделать предварительный restore pass по Team
   **до** публикации seed/retained entries в runnable maps Coordinator. Сначала
   проверить сохранённый launch record/source, completed worktree source и
   registration; `runtimeCaptureRegistration()` вычисляет original bindings
   без private seed. Затем compile eligible original recipes прежним способом.
   Все структурные/registration ошибки остаются fail-closed.
8. Если именно typed source-unavailable не даёт восстановить capture, удержать
   эту Team в private in-memory restore state. Не устанавливать для неё seed
   fallback, fake profile, empty Runtime record или новый launch owner.
   Для минимального среза Team остаётся целиком held; частичное включение её
   членов/старых captures и автоматическая миграция здесь не требуются.
   Другие полностью проверенные Teams устанавливаются штатно.
   Team definitions, messages/tasks, captures, binding selections, checkpoints
   и old handles не удаляются и не переименовываются.
9. Existing Team entry points для model proof, capture/start/retry/Resume,
   member input, roster mutation и runtime activity обязаны увидеть этот
   unavailable state; отсутствие runnable entry не становится seed preflight,
   «нет истории», zero-cost/empty activity или разрешением нового запуска.
   Обычное чтение Team/history через прежнего Team owner остаётся доступным.
   Guard повторяется после async boundary; текущие running/eligible owners и
   их физический cleanup не переключаются на новый source.
10. Quarantine **не доказывает cleanup**. Current `RuntimeTeamCoordinator.close()`
    проверяет только installed entries; простое skip создало бы false complete.
    Retain только original launch/binding references в existing restore owner,
    без второго registry/journal. Для shutdown/cleanup aggregate читать исходные
    validated launch attempts/member actions и `FileRuntimeStore.fenced().siblings()`
    по exact backend/team/member: он уже проверяет все generations/run bindings
    этой записи. Все referenced original bindings остаются учтёнными, даже если
    compile их private recipe недоступен.
11. Closed/released original records с завершёнными inputs/interactions и без
    pending original effect допускают лишь подтверждение уже завершённого cleanup.
    Missing record при claimed attempt, pending admission/selection, unknown
    custody, malformed sibling либо отсутствие достаточной original evidence
    оставляют cleanup held. Never-started отсутствие допустимо только вместе
    с полным original unclaimed/no-admission доказательством.
    Не вызывать `stopCapturedSession()` ради получения отсутствующей записи:
    его текущий trusted cleanup path способен создать empty record.
    Существующие live owned ports продолжают собственный cleanup; чтение файлов
    не создаёт signal rights, adoption или новую возможность физически остановить
    чужой/потерянный процесс. Main-held original cleanup handles сохраняются.
12. Если восстановлен **тот же** исходный private profile/authority, ordinary
    cold restore снова проверяет и использует прежние identities/bytes.
    Появление только нового seed не считается восстановлением старого.
    Нового unavailable journal, migration command, background repair или GC нет.

### Круг3 — минимальные source seams и проверки

- History/current-eligibility split живёт в existing `RuntimeSourceIndex` и
  `runtimeSourceGrantAuthority`; чистый original history validator при
  необходимости вынести туда из Index, сохранив cap800 (сейчас774).
  Private typed outcome проходит через existing `runtimeSourceContracts` /
  `runtimeCaptureSource`, без нового renderer RPC и раскрытия private profile.
- Restore/debt pass остаётся у `RuntimeTeamCaptures`; текущие
  `validateLaunchRecord`, original registration и FileRuntimeStore читаются
  повторно, не создаётся альтернативный validator/owner. Coordinator сейчас796:
  вынести связанный existing restore/install fragment, если нужно для cap800,
  а не сжимать код и не поднимать лимит. Management composition изменяется
  только для разделения retained history и executable profiles.
- В existing source-selection integration расширить cold case: original A
  опубликован; затем current profile теряет его seed/scope/revision, а B
  имеет другой valid target. Host конструируется, B current/publication
  работают, A original lookup/resolve остаются held. Байты index/receipts A
  неизменны. Missing/corrupt receipt/chain всё ещё останавливает проверку;
  stale project source не выбирает global/seed.
- В existing real Team/Runtime composition case сохранить capture A и valid
  Team B, выполнить cold reconstruction с unavailable A: B проходит обычный
  controlled capture/start/input, A не вызывает provider allocation и не
  получает seed fallback. Проверить исходную pending/claimed/missing debt:
  close held; отдельно genuine original released/settled state даёт только
  cleanup completion. Original A history/opaque/checkpoint bytes неизменны.
  Возврат exact old seed повторно читает A, не создаёт replacement run.
- Это controlled ownership/recovery cases, не native upgrade corpus. Использовать
  existing integration files, без mapper unit suite/новой CI matrix/таймаутов.
  Host build/testtypes, затронутые existing cases, focused Main contracts,
  lint/cap и independent source review; actual Desktop/provider gates — только
  на опубликованном exact head через прежний CI.

Первый self-review выявил два скрытых fallback: eager seed installation перед
restore и отсутствие skipped Team в shutdown aggregate. Оба включены выше;
нельзя закрыть review12 одним catch в constructor. Peer design review (Account)
подтвердил separation history/authority, all-original debt и запрет seed fallback.
Исходный review отдельно упоминает изменение множества scopes; этот срез
не ослабляет отказ такой смены и не смешивает её с уже исправленной aliases
эквивалентностью. Source ещё не изменён; выполнение новых gates не заявляется.

### §19 restore clarification: retained captures без source reference

Retained capture может ссылаться на original bare seed без recipeSources. Только
после structural launch/source/registration validation restore pass может
классифицировать exact отсутствие current private recipe либо несовпадение
saved recipeDigest как typed unavailable для этой Team. Early reference-eligibility
check предшествует private template resolution, чтобы отсутствие template не
обходило этот путь. Fresh capture не меняет свои refusal semantics; ambiguous/
malformed templates, schema/record/I/O ошибки не превращаются в unavailable.
Новый seed не подставляется вместо старого; его private bytes не реконструируются.

### §19 preflight retained native additions

`restoreNativeRuntimeEntries.ts:21–64` также eager-compile сохранённых additions
внутри `installLaunch`. Ранний restore pass проверяет их original launch/creation
receipt и selection binding до публикации runnable maps, используя временную
проекцию тех же existing entries. Только restore-only exact missing private
recipe или несовпадение сохранённого recipeDigest получает тот же unavailable;
malformed/ambiguous capture, receipt/registration/I/O ошибки остаются global hold.
Fresh native member capture не меняется. Никакого второго registry, исправления
старых digest или нового launch owner для недоступной Team не создаётся.

### §19 отсутствие current runtime в composition

`TeamHost.ts:256–266` раньше создавал Coordinator только при profile.runtime.
Existing RuntimeTeamCaptures получает узкий readonly predicate original capture
registration или original seed launch file по известной Team/run identity.
Только наличие такой истории включает обычный restore/debt pass при отсутствии
current runtime; malformed/unsafe file и I/O не скрываются как «истории нет».
Host без runtime и без retained истории сохраняет прежний путь. Seed/recipe не
подставляется; original Runtime/custody и Main-held cleanup остаются прежними.

### §19 MCP artifacts: original bytes до current base eligibility

Independent source review нашёл ещё одну current/history связь:
`capturedRuntimeMcpRecipes.ts:128–145` проверяет original artifact и
`runtimeDigest(base)` одним generic refusal. Поэтому `runtimeCaptureSource`
и `compileNativeMemberRuntimeCapture` не достигают restore-only unavailable
при изменении private child/template, даже когда original MCP reference цел.

Existing bounded/no-follow artifact reader разделяет две проверки. Сначала
полностью проверить original command/member/reference digest, schema и доступные
без private seed provider/overlay constraints; missing/corrupt artifact остаётся
generic hold. Этот structural pass охватывает все retained capture/native-addition
MCP references до первого current seed/source eligibility отказа, чтобы недоступный
template не скрывал повреждённую сохранённую запись. Ни catalog IO, ни новый
artifact/registry, ни изменение original bytes для него не нужны.

Затем load/reconstruct по-прежнему сравнивает exact current base digest и прежние
provider/cwd/profile constraints. Только restore path после original validation
классифицирует доказанное несовпадение current base как RuntimeSourceUnavailable.
Fresh capture/retry и ошибки reconstruction не получают такого исключения;
unknown/malformed protocol-specific state не превращается в разрешение исполнения.
Ранний исходный artifact pass не выдаёт runnable recipe или cleanup authority.

В existing MCP/Team integration case сохранить реальные capture artifacts,
изменить только current template, проверить локальное held этой Team и работу
другой; missing/corrupt artifact при том же unavailable seed должен оставаться
общим отказом. Контроль unchanged artifacts/receipts и исходного cleanup debt
сохраняется. Это уточнение найденного seam; source/CI PASS пока не заявляется.

### §19 проверка cold replay: повторное trusted admission точного probe profile

Первый фактический focused Node24.21 прогон materialized §19/R19 среза дал
58/61 PASS. Два отказа были ошибками TEST oracle: имя Runtime-файла должно
использовать `runtimeDigest(normalizeBinding(binding))`, как FileRuntimeStore;
Host onDispose rejection даёт `cleanup: failed`, сохраняя unknown native custody.
Исправляются только эти ожидания в existing composition case, без ослабления
original debt, payload или custody assertions.

Следующий прогон той же новой unavailable-history case также показал, что
`roster.replace members:[]` повторяет исходный пустой roster и штатно является
no-op. Existing mutation assertion использует реальное добавление TEST bob,
сохраняя строгое ожидание hold и неизменность исходных bytes/grants. Production
no-op semantics не меняются; это уточнение oracle, не новый обход mutation gate.

Третий отказ — source regression в candidate ProviderManagementCoordinator
`edec81ca6fec37cf997677060c731169fba5c84a`. Existing stopped fresh capture case
успешно завершает original model probe, закрывает Host, затем тот же cold
`team.launch.probe.start` возвращает hold. Read-only debugger в отдельной TEST
копии сохранил исходный FAIL и показал actual chain
`assertTargetAvailable → target → ModelProbeOwner.start → executeTeamModelProbe`.
Production методы, guard и результат не подменялись; Runtime/generation mismatch
этим отказом не подтверждается.

**Круг1 — причина.** Constructor отмечает retained command target недоступным,
если его profile отсутствует в начальном списке management/seed profiles.
Dynamic Team probe profile штатно восстанавливается позже из current captured
Team. `executeTeamModelProbe` проводит original roster/control/selection/current
проверки и вызывает private `admitTeamProbeProfile`, но отметка unavailable
сохраняется даже после успешного exact admission.

**Круг2 — минимальная коррекция.** После полного успешного private admission
и existing same-profile digest check удалить только marker exact
`{profileId, configRevision}` из existing unavailableTargets. Снятие marker
не берёт profile из journal или RPC и не восстанавливает его из нового seed.
Если current authority/recipe недоступны, private admission не произойдёт;
конфликт/ошибка admission сохраняет marker. Pending/unknown command rows,
resource fence, original receipt и physical target digest не меняются.
Последующие ModelProbeOwner.select/assertManagementTarget/current проверки
по-прежнему обязательны до replay или нового native effect.

**Круг3 — проверка.** Повторно использовать существующий stopped fresh capture
cold replay case: original completed receipt возвращается без второго run,
новый explicit intent запускает один новый probe. Существующие unavailable
management/debt cases должны оставаться held и сохранять исходные bytes/fences.
Новых suites, RPC, owners, таймаутов или native budget нет. Source peer review,
Host build/types и focused existing tests обязательны на exact corrected bytes;
actual Desktop/native gates отдельно, timing улучшение здесь не заявляется.

### §19 correction: runtime-presence проверка не требует прав чтения пустой Team

**Факт CI.** На exact `d35ef8256a9f24294b2fe50e8290ccb9841d9eb1`
job `131824838277` дал единственный FAIL из 6572 выполненных Main tests:
`desktopRuntimeSources.test.ts`, case «real Main/Host publication preserves
legacy target bytes and restores every retained target after restart».
Получен `transport-closed (unknown)` до Host handshake; child stderr в этом
job log не опубликован. Следующая причина установлена по exact source chain,
не выдана за уже выполненный локальный reproduction.

**Круг1 — контракт и причина.** Case вызывает `fixture('claude', false, 257)`:
одна static Team имеет `grants: []`, current `profile.runtime` отсутствует.
`readProfile.ts` применяет `teamHostProfileSchema`; общая
`hostedTeamDefinitionSchema` разрешает такую Team. `TeamHost.attachTeam`
читает roster при dynamic attach, но намеренно не требует actor read для
static definition. До §19 отсутствие runtime сохраняло product/management
Host без Coordinator. `TeamRegistry.restore` также отделяет inaccessible
creation от остальных static Teams. Это допустимый профиль; добавление grant
в fixture замаскировало бы production regression.

Новый `TeamHost.ts:257 → hasRetainedTeamRuntime` вызывает
`TeamRuntimeRegistration.all` через `runtimeCaptures(principalId)`.
`all` требует actor read до проверки наличия registrations, поэтому пустая
static Team останавливает весь Host. `TeamOwner.state` не является заменой
для readonly presence: он вызывает `roster.recover` и проецирует runtime
bindings. Existing revoked-read/replay tests сохраняют значение и обязательны.

**Круг2 — минимальный composition-only predicate.**

- В existing `TeamRuntimeRegistration` добавить приватный для trusted
  composition boolean: под original TeamStore fence прочитать fixed
  `state.json`, проверить ready/schema/original binding, существующие
  registration fingerprints/limits и форму необходимых member/pending полей.
  Только наличие validated captures, active/removed delivery или pending
  исходного состояния требует runtime restore. Ошибки/неоднозначный долг
  не превращаются в «истории нет». Не вызывать actor authorization,
  `TeamOwner.state`, roster recovery или native операции.
- Передать этот узкий boolean через existing TeamOwner composition surface,
  не через connect/MCP/RPC. Existing `runtimeCapture/runtimeCaptures` и
  все actor read/control/replay проверки остаются прежними.
- `hasRetainedTeamRuntime` использует этот predicate плюс прежний exact
  seed-launch file по original Team/run. Missing file означает только
  отсутствие этого known record; unsafe/malformed/I/O не подавляются.
  `RuntimeTeamCaptures.prepareRestore/restore` пропускают actor read
  только для Team без current private member seed и без такой истории.
  Это нужно и когда соседняя Team имеет retained Runtime и уже включает
  общий Coordinator. Профили не подменяются, Team не удаляется из product map.
- Presence не является authority или подтверждением cleanup. Семантика
  `runtimeNeverLaunched` не меняется: отсутствие старого marker не создаёт
  новое правило global hold для product-only startup, а наличие не
  освобождает original custody. Реальные/неполные captures, deliveries,
  pending lifecycle/seed records проходят прежний strict restore/debt path;
  revoked actor не получает read. Все original bytes, fences, неизвестные
  исходы и lifecycle/Main cleanup owners сохраняются.

Source scope: existing `TeamRuntimeRegistration.ts`, `TeamOwner.ts`,
`RuntimeTeamCaptures.ts`; никакого нового registry, journal, public DTO,
fallback seed, scan чужих namespaces или изменения native budget.

**Круг3 — проверка.** Сохранить original Main case с `grants: []`,
257 aliases и всеми publication/restart assertions. В existing Host
unavailable/unknown cleanup case добавить отдельную static Team без grants
и без Runtime; доступная/retained Team должна по-прежнему пройти свои
исходные операции, закрытие с genuine unknown custody — остаться failed.
Public read пустой или revoked Team должен оставаться forbidden. Проверить
malformed original registration/pending state и seed evidence как hold;
никакого catch-forbidden или synthetic release. Новых suites/runners нет.

После source peer review нужны build/types и original Main 5 cases +
focused existing Host recovery/authority cases на exact исправленных bytes.
Среда сейчас недоступна: plan/source review не означает execution PASS;
исходный CI FAIL сохранён, таймауты и assertions не ослабляются.
