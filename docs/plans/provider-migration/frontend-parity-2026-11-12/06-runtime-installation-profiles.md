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

### §19 presence refinement: pending product projection не является native history

Root review candidate `66226a77a60fdf122d3f6ef19ddaa0bcda80eaca` выявил две
лишние positive-причины. `TeamRosterTransitions.ts:235–259` сохраняет
`rosterProjection` при любом changed saved roster/settings и затем применяет
только original config projection. Pure product Edit без Runtime может
законно оставить эту промежуточную запись. Она сама не включает Coordinator:
existing product recovery и его actor/error проверки остаются прежними.

`TeamLifecycleTransitions.ts:51–61` ставит `cleanupPending` для любого
trash, даже когда original `targets` и `runtimeBindings` пусты.
`createHostTeamLifecycleComposition.ts:91–94` уже различает эти случаи:
без Runtime original cleanup допускается только при двух пустых массивах.
Сам pending marker не является evidence native allocation.

Поэтому presence reader использует original lifecycle receipt по единственному
`cleanupCommandId` через existing `teamCommandPath` и
`validateTeamLifecycleReceipt`; проверяет exact command/Team binding,
trash operation и completed business decision. Nonempty original targets
или runtimeBindings сохраняют необходимость strict Runtime path; missing,
malformed, foreign или незавершённая decision остаётся hold. Никакого
lookup/replay/settleCleanup, обновления grants/marker или нового journal нет.
Пустые validated arrays не являются новым release proof: lifecycle owner
сохраняет исходный pending receipt и прежние cleanup правила.

Member/name grammar и пределы256/1024 совпадают с bootstrap definition,
`safeSegment` и `TeamRosterTransitions.validate`; lifecycle поля ровно
`deletedAt?`, `cleanupCommandId`, `cleanupPending` из original contract.
`runtimeNeverLaunched` semantics не меняются, old absent marker не
превращается в новое global-startup ограничение. Existing focused cases
сохраняют grants:[], revoked public reads и unknown custody; добавить
проверку product-only pending projection/empty cleanup без native effects,
с original bytes и отказом при повреждённом retained receipt. Новых suites,
timeouts или pass-claims нет; execution ждёт восстановления среды.

### §20. Actual Host suite: namespace admission and the captured-source test seam

**Round1 — actual d35 evidence.** Job131824838303 completed the existing Host
build/types and then failed two of its Host tests. The cross-Team binding case
constructs a partial Coordinator with Object.create; it has no captures owner,
so the new source-availability guard throws TypeError before the intended
binding checks. Separately, the orphan-Task namespace case observed newly
created management/runtime-source directories after rejected Host admission.
The latter is a production initialization regression; preserve the original
no-persistent-additions expectation and the transient-lease release check.

**Round2 — narrow correction before allocation.**
`createHostProviderManagementComposition` currently constructs
`RuntimeSourceIndex` unconditionally. Its two store constructors create the
fixed `runtime-sources` and `management-commands` namespaces even when the
profile has no management sources or retained history. Construct this owner
only when current management profiles exist or either original fixed namespace
exists under the captured profile writer. Check both namespace paths; only
ENOENT proves absence. Present unsafe or corrupt state and other I/O failures
still reach the existing strict validation/hold path. No directory scan,
fallback source, cleanup deletion, lazy generic store or Host initialization
reordering is introduced.

With no current management profiles and neither namespace, use the existing
empty retained-profile/command result and undefined sources. Continue deriving
management profiles from current runtime members/templates exactly as before.
An existing source index, even after removal of the current seed or command
namespace, must still be validated; retained publications, orphan receipts and
unknown cleanup debt are never ignored. Existing source restore/close owners
and current-source authority stay unchanged.

In the existing cross-Team test only, provide its missing controlled captures
dependency. It validates the exact Team and can refuse a retained unavailable
source. Preserve all property-order, stale-generation, immutable-copy and
revoked-member assertions; add one source-refusal assertion proving that this
guard runs before reading a session. Do not weaken the production guard or add
an optional no-op path.

**Round3 — acceptance.** Run the original namespace/cross-Team Host files,
existing runtime-source history/restore cases and Main publication cases,
then the full current Host gate on the corrected exact source. No new suite,
native input, runner, budget or relaxed assertion. Source review is separate
from execution; the original d35 failures remain failures until these checks
succeed.


## 21. Настоящий UI source selection/install/update и точные qualification границы

### Круг 1 — прежняя функция, уже полученное доказательство и оставшийся разрыв

Это дополнение сохраняет §17–20, исходные grants/receipts/captures и все
unknown cleanup outcomes. Source не меняется этим документом. Основание:
product main 4a0e06277fe216d9f82dbbede362668fe46622ee и current source
52cfb512b54a52919ae6a3ab50ac7b7c1e1402a7; последнее добавило только R25
diagnostics поверх проверяемых здесь production paths.

[Immutable acceptance audit](https://api.github.com/repos/777genius/agent-teams-ai/git/blobs/93c904871af47e8e51740c1481815d8120a4f225)
содержит original9ea run43420487308/job131868949407, artifact14038305562,
ZIP SHA256 e210824c6dfb1168f1b0e56d04762852370ca81c362e47cc96bede478d9fc806,
три исходных receipt и отдельный readonly npm metadata snapshot.
Архив проверен до parsing. Native V1 1.19.4, 1.19.5 и resolved latest=1.19.5
прошли прежний Linux Host case: actual8 model requests, tools/permission/task,
original Stop/cold readback, cleanup=true, Host exit0. Два executable SHA256:
A=538fcb1b6408c8d4608822acee19f7ff5b3a3eb3383c0633c4f06170857312a7,
B=7df4e4136301f16589b0f30bf91a61380fca5f8ef22dd36570f5ebe1d4ec802c.
Wire protocol revision в обоих receipts остаётся1.19.4, что не подменяет
observed CLI version1.19.5.

Тот же actual A receipt отдельно подтверждает stock Electron
OpenCodeRuntimeInstallerService update1.19.4→1.19.5, пока исходный A input
и permission были pending. Before/after совпали original PID/birth/device/
inode/executable, profile/session/runtime-state/projection/checkpoint hashes;
оба installer children завершились0, cleanup=true. Это уже выполненная
qualification, её не нужно повторять новым набором version cases.
Она не подтверждает renderer Update, runtime.source publication или новый
B capture: receipt прямо оставляет desktopQualified=false.

Old source anchors уточняют E1–E7 без выдуманных возможностей:
- installPolicy old6d6bd1ef/currentd3f0c096: fresh default main был1.19.5;
  current получает latest. Обновление сохраняет установленную generation.
- OpenCodeV2InstallAction 77373e9c одинаков в old/current: обычный fresh
  Install предлагает V1; supported1.x/2.x не получают кнопку major migration.
  Existing V2 action обслуживает support install/repair. Поэтому E6 не
  означает обязательный новый UI V1↔V2 switch.
- Old/current generation.ts d62527b0 разрешает stable V1 от1.16.0;
  pinnedOpenCodeV2Contract4338ae48 отдельно связывает qualified CLI selector,
  engine и platform delivery. Для ближайшего proof берём именно V1
  1.19.4→1.19.5, не произвольную будущую1.x.
- OpenCodeRuntimeInstallerService old2c1c873c/current581a6578 сохраняет
  override→app-managed→PATH discovery. Advanced override задаётся существующим
  environment выбором до запуска приложения; обычного нового path picker нет.
  UI не предлагает managed replacement выбранного override.
- Main runtime0.0.160 baseline, current retained release0.0.158, Host build,
  OpenCode CLI1.19.x, V2 engine2.1.4 и Bun version — разные identities.
  Ни один TEST не переписывает runtime.lock ради совпадения provenance.

Обнаружены два production consumer gap, независимо от native timeout R25:
1. CapturedRuntimeProviderStatusClient947d5ede, readOpenCodeRuntimeStatus,
   возвращает captured Ready/version/sourceRevision, но не latestVersion,
   updateAvailable, compatibleV2Version. После V1 native publication
   fallback на installer getStatus уже не вызывается. Existing
   runtimeInstallActionUi1cc580a9 требует updateAvailable для healthy1.19.4,
   а V2 repair control требует compatibleV2Version: эти действия могут
   исчезнуть именно после успешного выбора. Нельзя обойти это прямым
   installer IPC из TEST или добавить synthetic Ready в renderer store.
2. CodexRuntimeInstallerService1efd89b6 и codexRuntime IPC116bd300 остались
   старым stock installer/use-case путём. Успех install/invalidate не
   вызывает captured runtime-source publication; provider metadata и
   будущие launches продолжают читать прежний seed/source. Это отдельная
   недостающая связка, не повод ослабить native qualification.

Readonly official metadata от2026-11-13T13:55:10Z:
opencode-ai/latest=1.19.5; @openai/codex/latest=0.169.0. Все URLs, payload
hashes и package integrity сохранены в audit. Codex0.164.0 встречается как
пример нового package layout, но не является обоснованной целью этого update.
Metadata existence не доказывает protocol compatibility или native запуск.
[Отдельный V2 metadata snapshot](https://api.github.com/repos/777genius/agent-teams-ai/git/blobs/b69eb6b4243809e4964758b0275c86de484ac03a)
от14:13:42Z фиксирует @opencode/cli/latest=2.3.0 и exact2.0.21:
это другой package, не opencode-ai/latest1.19.5. Current packageSelection
и engineForNativeVersion по записанному stable-v2-qualified-engine policy
выбирают для stable CLI2.3.0 прежний engine2.1.4. Это source eligibility,
не actual installed/native/UI qualification. getLatestQualifiedOpenCodeV2Version
возвращает engine version и не заменяет latest CLI metadata.
Нет нового скачивания/исполнения provider в этом audit.

### Круг 2 — минимальная последовательность implementation и настоящего Desktop proof

Первым закрыть OpenCode maintenance projection, затем один explicit TEST
mode в существующем retained-opencode-coexistence Linux job; P05 Settings
prelude остаётся у mixed lane, P07 extension acceptance остаётся в своём
existing native-launch case. Новый job/platform/version matrix не нужен.

**Maintenance cut.** Reuse существующие pure latest-version selection и
qualified V2 contract, вычисляя только maintenance presentation по исходной
captured CLI version/generation. Не смешивать captured Ready с ambient
getStatus другого executable/source. Один original target/selection
захватывается до metadata await; прежние target/current/revision guards
перепроверяются после него до возврата. Existing metadata failure сохраняет только ещё-current verified Ready без
выдуманного latest/update; source replacement по-прежнему отказывает и
не превращает stale result в Ready. Metadata read не создаёт source. Для override
managed Update остаётся скрыт. CLI-less embedded seed не называется
установленным CLI2.1.4: engine readiness и CLI maintenance различаются.
Existing3-second metadata policy не заменяется retry/TTL/cache или native
probe. Проверить в прежнем capturedRuntimeStatus case published V1 path,
source replacement во время metadata read и original V2 CLI/engine split;
existing UI action test подтверждает настоящий Update/Repair predicate.
Точные production paths первого cut: src/main/composition/createDesktopProviderStatusPort.ts
и src/features/runtime-provider-management/main/adapters/output/CapturedRuntimeProviderStatusClient.ts.
Существующий dependency object получает flat readonly resolver function;
composition связывает его с resolveLatestOpenCodeVersion(cliVersion,
getOpenCodeRuntimePlatformCandidates()) из прежних
src/main/services/infrastructure/openCodeRuntimeLatestVersion.ts и
OpenCodeRuntimeInstallerService.ts. Existing
getLatestQualifiedOpenCodeV2Version/process platform contract предоставляет
только независимо известную engine qualification для actual CLI-backed V2;
это не stock latest и не основание включать repair у CLI-less seed.
Новый maintenance service/port/owner/store не создаётся; helpers и package
selection policy остаются прежними. В output входят только известные
latest/update/compatible-engine presentation fields. Unknown eligibility
остаётся отсутствующей; network failure не стирает независимо проверенную
readiness или independently known existing support contract.
Catch покрывает только optional registry lookup, а target/source/revision
проверки остаются снаружи и не превращаются в fallback. Existing cases:
test/features/runtime-provider-management/capturedRuntimeStatus.test.ts,
test/renderer/components/cli/CliStatusVisibility.test.ts и
test/renderer/components/cli/OpenCodeV2InstallAction.test.ts. Перед source —
exact небольшой manifest/preimages; никаких изменений source qualification/
admission или повторного native catalog ради maintenance.

**Desktop lane.** Добавить один явный source-selection mode к существующему
desktop-retained-opencode-coexistence.native.ts и его current job. Default
retained legacy V1/Host V2 test остаётся прежним. Reuse original
startRetainedOpenCodeApp, desktop-ui-controls, guarded Quit, original child
birth/custody/absence checks, pinned Node24.21/Electron44.10.1, finite model
oracle и sourceFreeze. Текущий job30min/test900s и native budgets не растут.
Недостаток времени остаётся INCOMPLETE, не повод повторить business action.

В mode две последовательно закрываемые fresh TEST namespaces, потому что
fresh Install и update существующего A имеют разные исходные состояния:
1. **Missing installed choice→Install B.** Private delivered Host seed
   сохраняет настоящий verified A executable, но ни PATH/override, ни
   app-managed manifest не объявляет его установленным CLI. Это отсутствие
   installed choice, не отсутствие доставленного Host provider. Existing
   original UI Install скачивает stock B1.19.5, показывает реальный progress/
   result и публикует selection через captured installer. Только после
   published receipt обычные Create/model preflight/Launch получают B.
   Один genuine text input/reply, original Stop и обычный Quit с physical
   absence закрывают эту namespace до следующей. Не писать product
   current.json/source records, историю или release facts из harness.
2. **PATH A→Refresh→Update B при живом A.** В новой namespace полный
   verified package A доступен в private PATH, explicit overrides отсутствуют.
   Original UI Refresh выбирает A через selectInstalled/native version
   receipt; затем обычный Create/Launch и один input/reply создают actual A.
   Snapshot перед Update связывает exact source revision/capture/binding,
   original executable bytes/path/package closure и child birth.
   Existing visible Update запускается один раз, без direct IPC, devstore
   mutation или selector, которого нет у продукта. Published B не меняет
   original A capture/config/reference/native identity. После publication
   послать второй ordinary input A и получить его reply через прежний owner,
   затем original Stop A и подтвердить его absence.
3. **Новый capture B и cold readback.** Только после original A Stop/absence
   создать и запустить новую Team B; capture обязан ссылаться на published
   B revision и actualB executable. Один input/reply, original Stop B.
   Ordinary Quit, весь original app/Host/native/metadata cleanup и writer
   release предшествуют cold successor того же profile. Истории A/B и
   immutable source receipts сохраняются; cold startup не воспроизводит
   inputs/installer/publication. Source Freeze/actual native hashes остаются
   теми же до/после cold boundary.

Итого четыре business inputs в новом mode: один fresh-install B, два A
до/после publication B, один fresh B после A Stop. Отдельные original
catalog/preflight observations расходуют прежний finite model cap32;
их count/phase фиксируются, но не выдаются за business input. Unknown
preflight/ACK не даёт повторять Create/Launch/Update. Если source wiring
требует иных эффектов, сначала уточняется bounded flow, а не расширяется
oracle во время прогона.

Последовательность A Stop→B Launch намеренная: runtimeCaptureSource/
runtimeRecipe сохраняют original V1 recipe.endpoint, а
OpenCodeMemberProvider запускает serve на его exact port. Этот slice
доказывает active A после publication B и новый B capture, но не заявляет
одновременные два V1 servers на одном template endpoint и не переписывает
порты/recipes из TEST. Existing actual legacy V1+Host V2 coexistence — другое
доказательство и не заменяет этот same-provider source transition.

Staging A использует полный genuine package с official integrity, actual
--version и executable hash; никакой copy-only executable, wrapper rewrite,
PATH search после capture или удаления old bytes. B скачивает original
installer из official registry. До UI action проверяется, что stock
selection всё ещё exact1.19.5; после него проверяется actual receipt/version/
hash. Dist-tag drift или другой candidate оставляет этот proof INCOMPLETE;
не подменять metadata registry и не запускать неквалифицированный новый B.
Нет утверждения поддержки будущего latest по одному semver или hash.

TEST source seam ограничен существующим native entry, его model/helper,
prepare-retained-opencode-coexistence, desktop-backend-fixture и одним
прямо используемым source-selection UI helper; workflow меняет root.
Для Linux V1 нужен explicit source-fixture option, не использование
packaged candidate только ради выбора Node. Native recipe/descriptor TEST
preparation заканчивается до первого Owner bootstrap; после него
profile/source/history/pins не переписываются. Fixture уже790 lines:
cohesive preparation при необходимости переносится в directly consumed
helper, без сжатия строк/поднятия baseline. Exact paths/hashes и source cap
фиксируются перед implementation. Account mixed Settings paths не меняются.

### Круг 3 — что этот slice не закрывает и следующий точный qualification шаг

**Override и V2 support.** Existing E4 требует ordinary discovery/Refresh
с исходным explicit override и honest refusal для unavailable/mismatch;
managed Update не обязан менять override. После ordinary Quit/absence
можно начать следующий app epoch с другим явным environment выбором,
но нельзя менять environment исходного capture. Это отдельное небольшое
дополнение к тому же source-selection mode после первого actual результата.
Для V2 required next transition — genuine installed selector2.0.21→stock
selector2.3.0 при прежнем pinned engine2.1.4/platform delivery, затем
existing UI support repair той же selected CLI. Это не execution CLI2.3.0
как engine и не qualification engine2.3.0. Native CLI --version/hash,
source publication и actually executing2.1.4 graph/Bun проверяются отдельно.
Repair создаёт новую immutable support instance, старая closure удерживается
для A. Только настоящий current CLI допускает его maintenance projection;
engine-only seed Ready не превращается в installed CLI/доступный repair.
Stock tag drift остаётся INCOMPLETE для exact пары, не требует override
registry. Нового Bun/engine2.1.5 или major switch этот шаг не обещает.
До отдельного bounded source/acceptance amendment V2 update/repair остаются
открытыми; metadata и нынешний engine-only native PASS их не заменяют.

**Codex.** Exact seed protocol/native CLI0.162.0 и текущий stock updater
candidate0.169.0 — необходимая проверяемая пара. runtimeProfile/management
schemas и runtimeSourceQualification сейчас требуют exact0.162.0.
Сначала один explicit candidate mode в существующем native Codex lane
должен проверить genuine verified0.169.0 через public pinned D protocol:
initialize/catalog, выбранный model, ordinary input/permission/Stop и
cold Resume тех же original references в пределах уже имеющегося сценария.
Нельзя назвать candidate0.162.0, переписать checkpoint/config hash или
использовать mocked version output, чтобы пройти Host schema. Direct-D
proof и штатный Main/Host proof обозначаются раздельно. Только после
actual evidence и отдельного source amendment допускается exact finite
eligibility policy и Codex installer→существующий captured-source consumer.
Новая source registry, arbitrary version range и молчаливый downgrade
не нужны. Если pinned D не совместим, required change/pin определяется
по original failure, не заранее. Точный fixture/source manifest и deadline
для этого next step публикуются отдельно; этот §21 не разрешает новый
provider запуск или ослабление guard.

**Claude/Host delivery.** Native Claude version читается по original seed,
SDK0.3.305 не является CLI version; отдельный Claude UI updater source
не найден. Whole runtime/Host release update не объявляется эквивалентом
CLI selection и не переписывает0.0.158/0.0.160 provenance. Existing
packaged/retained-owner gates остаются owner этого delivery evidence;
не создавать отсутствовавший updater ради таблицы.

**Review/acceptance order.** R1 выполнен: exact old/current source, original
9ea artifact и official metadata. R2: root/independent peer проверяют
maintenance/source distinction, same-provider A retention и реальность
UI actions до source. После narrow source — existing relevant status/
installer/source cases, types/lint/cap, затем current normal Linux Desktop
job; no new generic unit suite/runner или CI rerun до root publication.
R3 требует actual new Desktop receipt с четырьмя inputs, original A/B
identities, published source receipts, cold history и full cleanup.
Source-only PASS, прежние Linux receipts и будущий Darwin/Windows результат
не переносятся друг на друга. §§17–20 stale/unknown/grant isolation и
retained custody остаются обязательными во всех этих flows.


## 22. Codex 0.169.0: первый bounded public-D candidate proof до source eligibility

Статус на 2026-11-13: PLAN ONLY. Этот appendix уточняет Codex-часть §21.
Он не объявляет CLI 0.169.0 поддержанным Host, не меняет provider pins и не
разрешает запуск до отдельного source review/GO. Исходная пара остаётся
A=0.162.0, B=0.169.0; число в protocolRevision не заменяет actual --version.

### Круг 1 — реальные существующие проверки и недостающие границы

Source audit выполнен по frontend
[7ce224d148205867d46fd2ca980a48e1b9e8c48b](https://github.com/777genius/agent-teams-ai/tree/7ce224d148205867d46fd2ca980a48e1b9e8c48b)
и D
[3b39a50b28319a3e91e0779493f0d64acb98d2e5](https://github.com/agent-teams-ai/old-provider-implementations/tree/3b39a50b28319a3e91e0779493f0d64acb98d2e5).
В D нет отдельной найденной actual native Codex suite. Его
driver-permissions.test.ts и checkpoint cases — controlled protocol tests.
Под «existing lane» в §21 понимаются существующие F native fixtures,
публичный D API и уже имеющаяся CI job, а не несуществующий D native gate.

| Требование | Существующий точный source | Что надо доказать для B |
|---|---|---|
| initialize / native readiness | F native-codex-team.native.ts + fixtures/native-codex-team/driver.ts; D factory.open → initialize → thread/start, actual MCP readiness | Те же реальные wire/SDK границы на проверенных 0.169 bytes; ACK submit остаётся client-consumed / providerAcceptance unknown |
| Native model catalog / выбранный model | F native-codex-metadata.native.ts и desktop-codex-resume-fixture.ts используют Host metadata с literal 0.162; D public CodexAppServerClient имеет initialize/listModels/readModelConfiguration | Один отдельный metadata child с public D, bounded actual catalog; выбранное значение должно затем совпасть с model в actual inference requests |
| Input / Team MCP / effects | Direct fixture исполняет CODEX_TEAM_ONE/TWO, реальные task/message tools, ONE+TWO bytes, 11 Responses requests | Переиспользовать тот же model и реальные MCP effects; не заменять native tools synthetic replies |
| Manual permission | Direct fixture выставляет approvalPolicy=never; controlled D permission tests не являются native доказательством | Один exact modern Bash approval с исходными session/input/operation/interaction refs; отсутствие effect до allow, затем реальный effect |
| Stop | Direct fixture закрывает original child после двух завершённых inputs; Host fixture имеет отдельный owner Stop | Дополнительно проверить interrupt активного candidate C2 input через public Session: requested/unconfirmed отдельно от actual cancelled terminal, затем original close/child exit |
| Cold Resume | Direct fixture не сохраняет checkpoint; native-codex-host cold часть — readback без нового input. Existing Desktop Codex Resume делает настоящий selected restore, но на 0.162 | Получить genuine checkpoint C1, закрыть C1, открыть новый native process C2 через тот же public factory и original checkpointRef; actual thread/resume и prior context без повторной отправки ONE |
| Stock installer → captured source | CodexRuntimeInstallerService + codexRuntime IPC одинаковы в old main4a0e062 и current7ce, install/invalidate не публикуют source | Отдельный следующий consumer cut после native evidence; успех установки не квалифицирует D/Host |

D публичные source anchors:
[Session/DriverFactory contract](https://github.com/agent-teams-ai/old-provider-implementations/blob/3b39a50b28319a3e91e0779493f0d64acb98d2e5/packages/provider-session-contracts/src/features/provider-session-contracts/contracts/session.ts)
(blob bd4668e0cf16ee7c2c2eb0d7b63863049b7cb5f6);
[public codex export](https://github.com/agent-teams-ai/old-provider-implementations/blob/3b39a50b28319a3e91e0779493f0d64acb98d2e5/packages/provider-implementations/src/codex.ts)
(c83aabee50ed75973eeae36a3ddbd0d37c7aa7ce).
driver-config d02d3c6ab540aa6415fbf32e16bf6e3be2f0377e допускает непустую
protocolRevision, а driverCompatibility включает её вместе с исходными
tenant/project/session/config/source/model params. Поэтому candidate
может честно использовать 0.169.0 без изменения D или Host schema.
driver-session ace1ef025ff21f7f14e0d82554372cdd8693507f возвращает собственный
checkpoint v2/nativeThreadId/itemOwners/compatibility; factory
daeeb1f64df310c895aa2df1c84f66d04a3d33b8 восстанавливает только полученный
original checkpoint. Эти bytes не переписываются под новую версию.
Точная функция driverCompatibility, lines105–113, destructures только
{tenantId, projectId, sessionId}; binding.generation отсутствует в hash.
Config binding каждого open обязан совпасть со своим request, поэтому
C2 использует согласованную новую generation, а все поля compatibility
остаются исходными. Это same0.169 checkpoint proof; cross-version
restore0.162→0.169 не заявляется. Старые A histories сохраняют original
0.162 executable/capture/provenance.

### Круг 2 — точный candidate и evidence до первого исполнения

Официальный release
[rust-v0.169.0](https://github.com/openai/codex/releases/tag/rust-v0.169.0)
опубликован 2026-11-13T08:37:05Z, release id443990865.
Annotated tag a41fe5b443652cbdbee57717fbb9fd78d8d8b32a указывает на exact
[source commit d32063f96c2dff1dc96af839b3952abb6acfeda4](https://github.com/openai/codex/tree/d32063f96c2dff1dc96af839b3952abb6acfeda4).
Readonly release API сообщает для полного
[codex-npm-darwin-arm64-0.169.0.tgz](https://github.com/openai/codex/releases/download/rust-v0.169.0/codex-npm-darwin-arm64-0.169.0.tgz):
153831622 bytes, SHA256
d67d443253294438a21fde15753d7c1174e6a32147d842eb84428479d664c93d.
Первый candidate берёт именно этот полный platform package в отдельный
TEST directory, сохраняет весь vendor target и sibling resources; stage
не заменяет прежние 0.162 artifacts. До parsing проверяются длина/hash
архива, package/platform/version и containment regular files; затем actual
executable --version должен быть ровно codex-cli 0.169.0. SHA256 бинаря и
нужных siblings измеряются после verified extraction, сохраняются в
immutable input receipt и повторно сверяются до каждого launch и после
cleanup. Сейчас эти archive bytes не скачаны/не исполнены; API digest не
выдаётся за уже измеренный executable hash.

Registry audit §21
[93c904871af47e8e51740c1481815d8120a4f225](https://api.github.com/repos/777genius/agent-teams-ai/git/blobs/93c904871af47e8e51740c1481815d8120a4f225)
в 13:55:10Z фиксирует @openai/codex/latest=0.169.0, root metadata SHA256
bc0cad6c06791b215d5bead6313227eb3d85a25b4c44b575a21e1fceb17f3b29
и root npm integrity
sha512-KhzYlkKPxoNssR8CEm45IjqnFWn7UtlF4CiD3tOJPea51xBs7MaHy0UQG9GSbCqk6Lrjn5QdJDV0QD1/FgWlGw==.
Это не platform tarball integrity. Stock installer отдельно проверяет SRI
своего exact platform package. Побайтовая идентичность GitHub release
tarball и будущего registry download не предполагается: при consumer
qualification записываются оба provenance и реальные selected bytes.

D остаётся тем же F dependency, без repack/pin update:
vendor/provider-migration/claude-review-3b39a50b/agent-teams-provider-implementations-0.0.0.tgz,
SHA256 f2514f0bec64a2da36511595fe2d6c67d9cbaa6e0da865a65375c2d7c7fe39a2,
SRI sha512-OskMRUunXXpgl7jWcFSS1UuAQIhmH0Uqjcc/IRQc4enDFsv4tqGebjlhM9cSMIkPO82+S+JXQb359vKjiyNRNA==.
[Existing source receipt](https://github.com/777genius/agent-teams-ai/blob/7ce224d148205867d46fd2ca980a48e1b9e8c48b/vendor/provider-migration/claude-review-3b39a50b/source-receipt.json)
связывает source3b39, original checked artifact14043230900 и
Node24.21/26.11 pnpm check PASS. Это source/packed-consumer evidence,
не actual Codex0.169 execution. Contracts archive остаётся aaf9506473f6a2868a375a6087e1b4edc561b38f34101ef7a8703a73bb2674db.

### Круг 3 — один explicit mode, исходные budgets и original refs

Первый tuple — Darwin ARM64, существующий pinned Node24.21.0.
C1/C2 ниже — два последовательных app-server процесса одного candidate
0.169.0; они не обозначают old/new version pair A0.162/B0.169 из §21.
Используется уже существующая stage1-desktop matrix row
variant=native-codex-resume-ui, до её ordinary Desktop launch.
Job сохраняет 45min; native test сохраняет общий 180s, D limits30s,
existing60s input wait, конечные read-only observer caps и cleanup bounds.
Каждый фазовый wait ограничивается remaining общего исходного deadline;
нет retry, нового runner/job/matrix или увеличения timeout.
Stock codex-runtime-smoke остаётся отдельным installer/version gate.
Остальные tuples не становятся eligible из результата Darwin ARM.

Предлагаемый exact invocation в этой row (ещё не выполнен):

~~~sh
LEGACY_CODEX_TEAM_GO=1 \
LEGACY_CODEX_CANDIDATE_VERSION=0.169.0 \
LEGACY_CODEX_CANDIDATE_INPUTS="$STAGE1_INPUTS/codex-0.169.0/input-pins.json" \
LEGACY_NATIVE_PROVIDER_ARTIFACT=vendor/provider-migration/claude-review-3b39a50b/agent-teams-provider-implementations-0.0.0.tgz \
LEGACY_NATIVE_PROVIDER_SHA256=f2514f0bec64a2da36511595fe2d6c67d9cbaa6e0da865a65375c2d7c7fe39a2 \
resources/legacy-agent-host/node/v24.21.0/darwin-arm64/node --test \
packages/legacy-agent-host/tests/native-codex-team.native.ts
~~~

Only exact explicit 0.169 mode допускает candidate pins; отсутствие mode
сохраняет прежний 0.162 сценарий, иной literal отказывает до spawn.
Новый mode reuse existing TEST Team/MCP/model и caller-owned original
ChildProcess transport. Он упражняет public D Session прямо; не проводит
candidate через Host schema, RuntimeSourceIndex или fake Runtime restore.

1. **Metadata.** До conversation один отдельный original child использует
   public CodexAppServerClient.initialize + listModels({limit:100,
   includeHidden:false}) + readModelConfiguration. Одна первая bounded
   page достаточна для выбора visible text model; полный каталог не
   заявляется. Default startup provider — тот же isolated TEST_fixture,
   его localhost/dummy-key config и no-user-home остаются прежними.
   Нет account/login/refresh или inference probe. Отдельный metadata
   client завершается и original child подтверждён exited до C1.
   Один stdio stream всегда имеет ровно одного RPC owner; native factory
   и metadata client не читают одновременно один pipe.
2. **C1 / ONE / permission.** Выбранный model и exact0.169 revision входят
   в настоящий config до первого conversation child и больше не меняются.
   Новый mode добавляет только для уже существующего первого exec_command
   explicit require_escalated при approvalPolicy=on-request.
   Реальный modern item/commandExecution/requestApproval должен дойти до
   Session interaction Bash. До единственного allow проверяются exact
   current session/input/operation и original normalized command/cwd,
   native-effect.txt ещё отсутствует. Public
   respondToInteraction(originalRef,{kind:'permission',decision:'allow'})
   должен вернуть ok; session/persistent allow rule не создаётся.
   D approval-request a6c8bee2b7e6efca8e5bca6a5e9f8db1c3e94dfd и
   driver-interactions7b3c366ae6251fec60346e77febde5a07297136e показывают
   точный modern one-shot путь. item/permissions/requestApproval,
   diagnostic, отсутствие interaction или неизвестная форма не считаются
   permission PASS. Должны произойти исходные task effects, ONE bytes,
   command exit7/tool-error и terminal succeeded C1.

   Source prerequisite подтверждён по official0.169 commitd32063f, не по
   названию option. Сохраняется именно workspace-write из existing driver;
   danger-full-access/external sandbox не используются. Native
   config/permission_config.rs blob04baea04840d8952f88c22b242835685d1b22fa3,
   lines88–101, переводит WorkspaceWrite в workspace_write profile;
   protocol/permissions.rs6cc2839485cbbcbd4d7aad47a707ce234ea09fcc,
   lines804–858, строит Restricted filesystem policy. В
   [core/src/exec_policy.rs](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/core/src/exec_policy.rs)
   blobfce3479f90fe0f63ed7b123768de675476a73f69, lines915–931,
   OnRequest + Restricted + requests_sandbox_override даёт Prompt;
   Unrestricted/ExternalSandbox дали бы Allow. Тот же file433–489 переводит
   Prompt в NeedsApproval, если policy не отказывает. В пустом private
   TEST home не создаются exec allow rules, hooks или persistent grants;
   внешний managed policy не обходится, неожиданный результат держит FAIL.
   handlers/mod.rsda4da19939255755fd31634cd8aa72036ba069ab, lines327–332,
   сохраняет RequireEscalated как permissions_preapproved=false;
   orchestrator.rs9ba96e57eea42bcd988b1d4d257d92149a50cc3a, lines208–235,
   awaits approval до первого execution attempt. В
   app-server/src/bespoke_event_handling.rs485f8e144532ffcb67f89b48aeaaf8a7388f7b58,
   lines785–806, original thread/turn/item/command становятся native
   CommandExecutionRequestApproval; app-server-protocol/src/protocol/common.rs
   52ed76c60687defce3f3405148ff15b44769d433, line1899, задаёт exact wire
   item/commandExecution/requestApproval. Этот trace обосновывает выбранный
   stimulus; PASS требует реальный original interaction и эффект после
   allow, synthetic approval из TEST не допускается.
3. **Original checkpoint / cold native C2.** После terminal C1 и idle
   вызывается public Session.checkpoint. Его opaque payload сохраняется
   один раз в private0600 TEST file с digest/reference. Затем C1.close
   должен вернуть cleanup=confirmed и original C1 child завершиться.
   Новый original child C2 запускается с тем же native home, package,
   config/account/model/MCP context; новый binding generation не меняет
   opaque bytes/compatibility/nativeThreadId. Единственный readCheckpoint
   callback возвращает payload только по original captured reference.
   Native facts требуют один thread/start C1 и один thread/resume C2 с тем
   же original thread; no fresh-thread fallback. Перед TWO у C2 ноль submits
   и нет новых business effects; ONE не воспроизводится.
4. **C2 / TWO / active Stop.** Второй новый input/operation отличается от C1;
   model обязан видеть prior context и исходные native tool IDs.
   TWO выполняет существующий append и Team reply. Только его последний
   уже существующий model response удерживается TEST server без отправки
   synthetic terminal; после получения этого original request caller
   вызывает C2.interrupt(originalOperationRef). requested/unconfirmed
   отдельно от matching actual result cancelled. Второй Stop/новый input
   по timeout не допускается. Затем C2.close и exit original C2 child.
   Таким образом остаются два business inputs и те же 11 model requests
   (8 C1 +3 C2); второй terminal здесь отменён намеренно. Header/request
   effects не считаются terminal. Server close выполняется в cleanup,
   не используется как доказательство успешного interrupt.
5. **Receipt / cleanup.** Сохраняются candidate/native/D/Node provenance,
   actual selected model, original child refs, input/operation joins,
   checkpoint digest/ref, exact thread-resume equality, permission-before-
   effect, one interrupt/actual cancelled, finite HTTP/tool/effect counts,
   original close/exit и first failure. Metadata не считается business
   input. Все three original children (metadata/C1/C2) имеют retained
   cleanup с момента spawn; fallback cleanup сохраняет INCOMPLETE вместо
   превращения unknown close в PASS. Existing original-child cleanup
   не выдаётся за whole descendant custody, production Host Stop или
   renderer acceptance. Opaque payload/native config/tokens остаются
   private TEST artifacts; summary не публикует bearer/env/raw stderr.
   Initial outcome и оригинальные ошибки не заменяются поздним cleanup.

Actual model/catalog/approval behavior0.169 остаётся gate: например,
новый native route или incompatible checkpoint сохраняет failure и
требует отдельного source-backed решения. Oracle не выдумывает model
catalog, не принимает произвольный tool и не подстраивает count после
прогона. [Official exact app-server source](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/app-server/README.md)
отдельно описывает startup-provider model/list и сохранённый provider
при cold resume; это контрактное основание проверки, не её исполнение.

### Минимальный source manifest и последующий consumer

До source нужны второй independent review и root publication этого плана.
Первый TEST cut ограничен следующими existing files; полный immutable
manifest проверяется ещё раз относительно actual integration head:

| Path | Exact preimage at7ce |
|---|---|
| packages/legacy-agent-host/tests/native-codex-team.native.ts | 13455bbe85f0f99301bab014aa0219c89a9a7e02 |
| packages/legacy-agent-host/tests/fixtures/native-codex-team/driver.ts | b1de89b55c7123d71b1ec0956cbfb3edb2e353b7 |
| packages/legacy-agent-host/tests/fixtures/native-codex-team/model.ts | 0ab116513b4e8098fe8a5cec6449cf53074fcb39 |
| packages/legacy-agent-host/tests/fixtures/native-codex-team/model.test.ts | 3a75e20efba06287f8072fded058ae9624d1babc |
| .github/workflows/ci.yml | 0eab99cf8121dec4de96678b9fa1679eba27b4d3 |

Driver reuse ограничивается непосредственно используемым original process
IO/config helper в том же файле, чтобы metadata/C1/C2 имели одинаковый
cleanup contract. Нет общего нового RPC/orchestration framework.
Existing model case расширяется только для critical candidate marker/count,
default mode unchanged и одного held original final response без extra
request/replay. Before-allow no-effect, native checkpoint/resume и actual
cancelled проверяет настоящий native case, не synthetic model test. Existing build/testtypes/target lint/source caps обязательны до final
acceptance/upward merge. При unavailable executor допустима reviewed
source-only publication кандидата для обычного canonical CI; она не
объявляется локальным PASS. Эти проверки должны реально пройти на exact
candidate head, а их PASS не заменяет actual native receipt.

Следующий production slice сейчас не разрешён: после actual proof надо
отдельно уточнить finite tuple/version eligibility и обычный Main/Host
proof, затем связать Codex stock installer с уже существующим captured
source port. Read-only preimages этой недостающей связки:

- CodexRuntimeInstallerService.ts:
  src/features/codex-runtime-installer/main/infrastructure/,
  1efd89b69448ccc93d97328a990f0e194d70e5bc; stock install реально проверяет
  platform SRI/full vendor layout и пишет current.json, но source не
  публикует. Same-version repair сейчас может replace versionDir;
  retained A closure нельзя считать автоматически защищённой этим путём.
- src/main/ipc/codexRuntime.ts116bd3001be3f872d0f47da253394a75927c0485
  и createCodexRuntimeInstallerFeature.ts06c919fef1d2d63b411072f92a4a895fc556f15a:
  stock composition, без existing captured source consumer.
- src/features/agent-backend/main/infrastructure/CapturedRuntimeSources.ts
  0b3fe40f6cc29c2a4c53b10ad1d96aaea7b87a0e уже даёт current/recover/
  publish/lookup. CapturedOpenCodeRuntimeInstaller35e58d04 и его composition
  3c56cfb8 показывают existing source/expectedRevision/lost-ACK discipline;
  Codex не получает вторую source registry, новые implicit PID owners
  или автоматический fallback после refused publication.
- Host composition/runtimeProfile a1daa87f33aceeae3fe81d9d91217d89ed12bb8d,
  management/profile e1af7fe25cd74a1c2710713853eaae729b81ed1a и
  runtimeSourceQualification3b6d4abafd37c0677f5e4b32334b958416975c98
  остаются прежними; exact native version, actual executable/source и
  retained capture не превращаются в arbitrary semver range.

Положительный первый receipt означает только actual public-D candidate
Darwin ARM proof при перечисленных inputs/policies. Он не закрывает
Linux/Windows, public Main/Host source admission, renderer Install/Update,
A0.162 active while B0.169 installed, genuine retained A/B Stop, или
same-profile cold Desktop histories. Эти required §21 flows сохраняются
до следующих обычных source/owner/UI receipts. Если D требует изменения,
оно планируется из конкретного original failure и проверяется отдельно;
old0.162 остаётся доступен без relabel/downgrade или переписывания history.


### §21 Desktop implementation refinement — reachable controls and exact TEST source boundary

**Review 4 — source reachability before a browser helper.** The healthy dashboard
prerequisite does not expose Refresh: `OpenCodePrerequisite` returns no content
for a Ready gate. Its `provider-quick-opencode-refresh` control is therefore not
the planned healthy A selector. Settings' catalog refresh also does not by itself
prove a runtime-source selection. No hidden-button click, direct installer IPC,
renderer-store mutation or new product control substitutes for either route.

The actual existing control is Create's
`[data-testid="team-model-selector-refresh-providers"]` in
[TeamModelProviderActions](https://github.com/777genius/agent-teams-ai/blob/48a28a6198cda1e2668e92f575505dddf7d69c35/src/renderer/components/team/dialogs/TeamModelProviderActions.tsx),
blob `256f40673f9c11390fc83e90597b738dae0f0042`, byte-identical at old frontend
`4a0e06277fe216d9f82dbbede362668fe46622ee`. It is rendered above the provider
tabs and disabled only while its original refresh is pending. Its original
callback independently invokes `invalidateOpenCodeRuntimeStatus` followed by
`fetchOpenCodeRuntimeStatus`; the existing Codex/CLI/catalog work and error
projection remain unchanged. Main's original
[openCodeRuntime IPC](https://github.com/777genius/agent-teams-ai/blob/48a28a6198cda1e2668e92f575505dddf7d69c35/src/main/ipc/openCodeRuntime.ts)
`invalidateStatus` reaches `CapturedOpenCodeRuntimeInstaller.selectInstalled`.
Thus the second namespace opens the ordinary Create form, expands the original
lead model control and clicks that one visible Refresh once. Before/after
read-only source records must establish the expected A native-version
publication and exact current target; a healthy label alone is insufficient.
Other provider status outcomes are retained and do not authorize a second click.

Fresh Install and live-A Update use the existing visible OpenCode controls in
`CliStatusBanner`/`runtimeInstallActionUi`; the new maintenance cut supplies
the original captured CLI's optional update metadata. Each control is located
by its existing OpenCode scope and exact original label, checked visible/enabled
and clicked once through `desktop-ui-controls`. Missing installed choice is
observed before Install. A different discovered executable, unexpected stock
candidate, hidden control or failed/unknown source publication fails this proof;
the harness neither removes ambient files nor forces a Ready/Install state.

**Review 5 — initial TEST inputs, accounting and cleanup.** An explicit
`nativeOpenCodeSourceSelection` option belongs only to the existing disposable
fixture. It captures verified full-package A, the original finite model URL,
separate fixed member/management endpoints and initial `missing` or `path`
choice. The new choice uses the actual selected Node24 executable on Linux.
Its V1 recipe/provider template and management seed are complete before the
first `createFilesystemTeamOwner` call. A is delivered as a real executable
reference without inventing an installed `cliVersion` on the management seed.
The original offline sidebar seed need not acquire a Runtime delivery merely
to supply a provider template; initial definitions are validated by the same
Host schemas before any app exists. No later profile, descriptor, pin, source,
registry, Team or history rewrite is allowed.

For this option alone, omit OpenCode's TEST sentinel from the two existing
sentinel directories, omit all three existing OpenCode override variables and
build the original app environment with the private TEST bins/selected Node
plus system utility paths. Only the PATH namespace includes the canonical
`bin` directory of the full verified A package. The missing namespace excludes
A from discovery. The shell probe still preserves the exact initial environment;
other sentinel/override guards remain. Actual stock discovery, including its
unchanged fallback rules, decides whether the expected missing/A state exists.
An unexpected original discovery is an INCOMPLETE result, not permission to
delete/install over it or search for a replacement.

The four business inputs remain exactly those in §21. The first input of each
new Team is the ordinary Create form's `#team-prompt`, delivered once by its
existing Create-and-Launch path. This follows
`desktop-create-launch-ui-smoke.ts`'s original initial-input proof; it is not
followed by an extra Send. Only A's second input uses the existing real Composer
and once-only Send after B publication. Fixed distinct TEST markers bind the
fresh-installed B, A-before-update, A-after-update and newly captured B.
Every marker joins its original creation/launch/runtime input and actual native
request/reply. The no-tool Host preflight accepts only the exact existing
`Reply only OK. Do not use tools, access files or run commands.` prompt with
its original no-tool shape. It is recorded separately and consumes the same
total model cap32; default legacy strict-launch/PONG behaviour is preserved.

The source-selection mode reuses `startRetainedOpenCodeApp`, its original
CapturedProcess, renderer ownership, selected-path/image witnesses, normal Quit,
cleanup and namespace census. The initial fresh-install namespace is fully
closed before the PATH namespace starts. Original A remains live across the
once-only B installation/publication and its second input; A Stop/released
Runtime plus original physical absence precede new B Launch on the unchanged
member endpoint. New B Stop precedes normal Quit. Every retained native/metadata
birth and unmatched selected image remains part of the existing absence
requirement, with no PID adoption or new signal authority. Cold startup keeps
the same descriptor/profile/owner and reads the actual A/B histories and source
receipts without another Create, input, install, Refresh or publication.

**Exact candidate source manifest.** These preimages were read back at working
`48a28a6198cda1e2668e92f575505dddf7d69c35`; no UI source bytes have changed.
Root owns the existing `ci.yml` invocation/receipt assertion and composes its
current preimage separately. All file paths below are under
`scripts/legacy-agent-host/`.

| Path | Exact preimage | Narrow change |
|---|---|---|
| desktop-retained-opencode-coexistence.native.ts | 9f569ea02e190a94e35f087620f6d812b8e52d16 | One explicit source-selection branch after the shared clean-source/build/Node setup; default retained legacy/V2 body remains unchanged. Same900s case. |
| prepare-retained-opencode-coexistence.ts | 049a7416e5896b266d8ea9d2241d116a900812b7 | Explicit mode verifies full staged A and its package/lock/integrity evidence, uses the existing pure stock selection helper for exact B1.19.5 metadata, and writes a separate bounded input receipt; ordinary retained preparation unchanged. |
| desktop-backend-fixture.ts | 0672763ee3533bb033dfa5aec9adf027bc897105 | Initial Linux V1 source option, exact source descriptor and sentinel/env choice before Owner bootstrap. Preserve the public environment export and all default callers. |
| desktop-runtime-source-fixture.ts | new, directly consumed | Cohesively hold the existing V2 recipe/profile-preparation block and existing environment builder, preserving their default bytes/behaviour; add only the declared V1 source preparation beside them. This frees real preparation code from the790-line fixture without compression or a raised baseline. |
| desktop-runtime-source-selection.ts | new, directly consumed | The two sequential namespaces, genuine UI actions, original durable/native/source joins and cleanup/cold readback. Reuse existing app/UI/Create/read-only Runtime helpers; no new browser/process owner or generic driver. |
| desktop-retained-opencode-model.ts | d0db11b91875bbe6a3a5c87014e3eb35251d9a1c | Explicit finite source-selection mode for four fixed business markers and exact original Host no-tool preflights; same32 cap, same HTTP size/endpoint checks and original default mode. |
| desktop-retained-opencode-model.test.ts | a651cfa2b53402fdd0e4a36035af818926ffa565 | Extend the existing business/probe case for the explicit mode, exact prompt/owner/marker joins and first-violation refusal; no new suite. |

The preparer's metadata lookup is evidence before the original UI action, not a
fake registry, source publication, new native session or implementation of the
installer. B is still downloaded and verified by the stock installer. A's
existing package closure remains available throughout A; measuring the official
package/SRI, actual binary/version and source inputs does not rewrite it.
All new helpers fall under the existing whole
`scripts/legacy-agent-host` source-freeze input. Account's mixed Settings files
and product status/qualification guards are not edited by this UI cut.

**Review/qualification.** Root and an independent peer review this exact
boundary before the helper source. Review the default-preserving extraction
bytewise, then run existing focused model/fixture cases, script/Host types and
source-size/lint guards when execution is available. No new generic unit suite,
sampler, workflow job/matrix, native budget or timer is introduced. The existing
Linux job receives one explicit additional mode and retains its30min budget and
ordinary retained proof. Its actual new receipt must establish all four inputs,
original A retention, B publication/new capture, cold history and complete
cleanup. Environment loss means the present manifest is source-only planning;
previous native/maintenance/source reviews are not executions of these bytes.

### §21 final TEST observation and transitive-source closure

The final source review of helper `desktop-runtime-source-selection.ts` at `925b438f083009dfa990fad007eddfd84647d53d` found two narrow acceptance-boundary refinements, before the first candidate-head execution. This is source evidence, not an observed native failure or a change to provider admission.

**Live atomic snapshots.** `FileRuntimeSourceIndex.publish` (blob `ed164ecd499dac64d4df2b7890e45cf1b5c7f1cd`, lines 171–186) and `FileManagementCommandStore.write` publish a bounded temporary file by rename. `TeamOwnerStore.write` delegates through `ControllerAdapter.writeTeamJson` (blob `45ca266cf44afd3a65c5db3312640d71f67328eb`) to the existing controller atomic writer (`58311c77563351d5812caa652285aed64e3f58c7`). The existing `readDesktopNativeStopSessions` also explicitly reads atomic session records; it is unchanged. Therefore a retained fd and the named live Team/source/receipt path can legitimately disagree during a read. A mismatched observation must never supply accepted bytes or evidence, but it need not abort the original wait for publication.

In the new TEST helper only, distinguish such an identity-inconsistent bounded snapshot with one private error type. The existing 90-second `poll` may discard only that observation and repeat its read within the **same original deadline**. Keep the original cap-before-allocation, cap-plus-one positional reads, no-follow/canonical/regular-file checks, full retained-fd and named-path identity checks, and all subsequent JSON/schema/digest/source/ownership validation. Missing paths, unsafe path/shape, malformed bytes, invalid digest/schema and other I/O failures remain hard refusal. No inconsistent bytes are accepted; a subsequent read must independently satisfy every original check. Direct immutable-input/profile reads and quiescent cold/cleanup reads remain strict, with no general read retry.

Also join the already-required selected source index and its exact published management command in the **same existing source-publication poll**, before accepting either as the completed observation. `RuntimeSourceIndex` currently publishes the index immediately before its command receipt (lines 420–421); the TEST must not interpret the short interval as a completed command. Retain every final grant, command ID, expected revision, CLI/hash, fingerprint, phase and resource-held assertion. This only waits for the original publication to settle; it does not publish, recover, reissue Install/Refresh/Update, reopen a native session or add a new timeout.

**Transitive source pin.** The extraction makes `desktop-runtime-source-fixture.ts` a direct dependency of the already-pinned `desktop-backend-fixture.ts` in every original Desktop fixture. Add exactly `scripts/legacy-agent-host/desktop-runtime-source-fixture.ts` beside that existing entry in `desktop-proof-sources.ts` (preimage `dd2c3e5750efe08e7310e00066b849d6a9a5f247`). Root composes this one line with Account's independent P05 helper addition. Do not add the standalone source-selection journey to unrelated Desktop proof inventories; its existing native source assertion already covers the scripts directory.

The seven-file journey, four business inputs, 32 model-request cap, original physical cleanup/cold boundaries, default extraction and the declared CI recipe remain unchanged. Only the TEST observation helper and this one transitive inventory line change after publication of this clarification. Independent source review and the normal candidate-head compiler/native gates remain required; no execution PASS is transferred to the revised bytes.


## 23. Codex installer → exact captured source, with permitted protocol emulation (2026-11-13)

### R1 — concrete remaining functionality and exact source comparison

The current user explicitly permits subscription-free emulation for Codex/Claude and forbids executing their real binaries. This implementation therefore uses actual Main/Host/source owners with disposable TEST CLI/protocol actors, and labels that evidence as emulated. It does not claim a vendor login, inference or platform-native qualification receipt. The earlier §22 requirement to execute a real Codex candidate is not a reason to leave the existing Install/Update control disconnected under this instruction.

`codexRuntime.ts` still composes the stock installer only: successful acquisition changes `current.json`, but never calls `CapturedRuntimeSources.publish`. New Host captures keep the old seed. Separately, same-version repair removes its old `versionDir`, which can destroy bytes referenced by a retained capture. Both are concrete product gaps. General discovery remains read-only; only existing explicit Install/Update/Refresh actions select a new source.

Official current release read on 2026-11-13 identifies [rust-v0.169.0](https://github.com/openai/codex/releases/tag/rust-v0.169.0). The immutable official source pair is old [c1382380de69521303b416720a52f42d51af6248](https://github.com/openai/codex/tree/c1382380de69521303b416720a52f42d51af6248) and new [d32063f96c2dff1dc96af839b3952abb6acfeda4](https://github.com/openai/codex/tree/d32063f96c2dff1dc96af839b3952abb6acfeda4). Generated schemas under `codex-rs/app-server-protocol/schema/json` were compared by immutable blob SHA and parsed structure, not by the release number alone:

| Existing D/Host route | Exact 0.162 → 0.169 schema observation | Required bounded proof |
| --- | --- | --- |
| Initialize/model catalog | Initialize response and ModelList response are byte-identical; new initialization capability and model-provider query fields are optional | Existing initialize/catalog fixtures, with absent optional capability and new optional metadata |
| Browser/device login, cancel/logout | Login params/response, cancel params/response and completion notification are byte-identical | Existing account IPC → Host/D → TEST child browser/device/cancel/recovery journeys |
| Account/read, quotas | Existing API-key/ChatGPT cases retain required fields; optional workspace/user fields and new account/plan variants are added | Existing finite public projection ignores private/new optional fields; no new GCP/Bedrock UI capability is promised |
| Config/MCP | Existing config/read and MCP status request shapes are unchanged; optional search-provider and tool-list metadata are added | Existing selected configuration/census and exact runtime readiness tests |
| Thread start/resume, input | ThreadStart params are byte-identical; ThreadResume's selected thread/model/config fields and TurnStart's existing text/image inputs retain their required shapes; additions concern optional audio/context/tool metadata | Existing public D/Host open, selected model/effort, original checkpoint Resume and non-replay scenarios |
| Approval/Stop/terminal | Command/file approval responses and turn/interrupt request/response are byte-identical; command approval adds a human-command kind; item/turn payloads add timestamps, metadata and new error variants | Existing explicit permission flow and original interrupt/cancelled terminal checks; no automatic grant for new actions |

No arbitrary latest/range admission follows. The intended finite version set is `0.162.0` and `0.169.0`, conditioned on the existing actual executable digest, version readback, platform/process-custody and source grant checks. Unknown later versions remain visibly unqualified. A new accepted source derives its own protocol revision from its verified native CLI version; prior profiles, source records, running captures and checkpoint compatibility bytes remain unchanged.

### R2 — smallest implementation and authority boundaries

Reuse the stock `CodexRuntimeInstallerService` for package metadata, SRI, complete vendor-layout extraction, version observation and progress. Give every successful acquisition a fresh immutable instance directory; update only the existing current manifest, retaining earlier instance paths. Do not add a second installer, source registry or pruning policy.

A feature-private captured installer uses the existing `current/recover/publish/lookup` port. Capture the sender's original Codex grant before the first asynchronous acquisition. Coalesce only the same original source and operation; another source cannot borrow its install result. Recover the original durable publication before new acquisition; lost ACK reads only its original command ID. Recheck the original source revision after acquisition and before publication. A foreground change refuses publication and must not select a replacement account/project. Capture the selected CLI through a bounded retained file handle, not a renderer-supplied pathname; changed bytes fail before publication. Supported Windows wrappers retain their original identity and use the independently captured shared Windows launcher recipe, rather than an artificial `.exe`-only restriction.

The existing service's terminal progress is accepted only after the captured publication callback completes. Downloading/extracting may be shown normally; a physical install alone must not emit the UI's final `ready`/100% success while Host publication is held. General GET_STATUS remains installation discovery, with no new source effect; explicit Refresh/invalidations route through the same captured selection. A refusal reports that the installed version is not selected for new launches and preserves the old capture. The existing flow has no public installer cancellation action: this slice does not invent one; abandoned UI/context cannot authorize a late source publication.

Exact production files proposed:

- `src/features/codex-runtime-installer/main/application/CapturedCodexRuntimeInstaller.ts` (new small feature-local consumer).
- `src/features/codex-runtime-installer/main/infrastructure/captureCodexNativeSelection.ts` (new bounded private image capture; no execution).
- `src/features/codex-runtime-installer/main/infrastructure/CodexRuntimeInstallerService.ts` (immutable instance and terminal-result acceptance; retain its source-file cap).
- `src/features/codex-runtime-installer/main/composition/createCodexRuntimeInstallerFeature.ts`, `main/adapters/input/ipc/registerCodexRuntimeInstallerIpc.ts`, `src/main/ipc/codexRuntime.ts` (existing facade/IPC wiring only).
- `src/main/ipc/agentBackend.ts` (existing private runtime-source capture also accepts Codex).
- `packages/legacy-agent-host/src/management/profile.ts`, `src/composition/runtimeProfile.ts`, `src/composition/runtimeSourceQualification.ts`, `src/composition/RuntimeSourceIndex.ts` (finite 0.169 schema admission and new-source derivation; no edits to process custody or old records).

Verification extends existing `test/main/features/codex-runtime-installer/CodexRuntimeInstallerService.test.ts` (same-version repair preserves old bytes and no final Ready before accepted result), `test/features/agent-backend/desktopRuntimeSources.test.ts` (real Main/Host A0.162 → B0.169 publication, original A retained and cold restoration, original lost-ACK/recovery), and `packages/legacy-agent-host/tests/codex-member-provider.test.ts` (existing emulator at the finite second revision; model/effort, permission, input, interrupt and checkpoint identity). Reuse existing account/model source suites and D fixtures; add no broad helper-test matrix. Root owns `CodexLoginConversation` and its direct custody test. Windows member-provider wiring is owned separately and is not changed here.

Approximate bounded addition: 250–400 production lines and 150–300 focused acceptance lines, principally extending existing fixtures. Complexity 7/10: acquisition progress, source admission and old running identity are separate states. Expected reliability after exact-source fixture acceptance 8/10; confidence before implementation 7/10. Official schemas plus protocol emulation establish the requested functional boundary, while paid vendor execution remains intentionally unperformed.

### R3 — independent review before implementation

The coordinator reviews the exact finite qualification and installer/publication plan before source edits. Review must reject arbitrary semver acceptance, changing old checkpoint/profile revisions, source publication from a different foreground context, deleting retained package instances, lost-ACK retry that redownloads blindly, or final Ready before the original Host receipt. Implementation results will be recorded separately from this plan.

### R4 — accepted source boundaries and observed emulated verification

The coordinator approved the finite version set after independently reading the exact official schemas. Independent review required two compatibility fixes in D before admission: preserve explicit nullable ChatGPT email without exposing new workspace/user fields, and decline `humanCommand` or unknown command-approval kinds before any policy callback. Initialization does not opt into `requiredHumanApproval`. These changes are published in provider commit `68dca527b779ebb82923f30d7b08441085d8b579`; its checked package passed both Node 24 and 26 CI, and the retained local package was byte-identical to the checked artifact. No old checkpoint or profile is relabelled.

Physical installation and selected Host readiness remain separate facts. When acquisition succeeds but original publication is refused or unknown, `installed` remains true and state is `failed`, with an explicit not-selected error. The original renderer records success and performs its automatic Refresh only for `installed && state === 'ready'`. A thrown capture/publication error also exits the checking state. General GET_STATUS never publishes. A later independent source publication cannot be overwritten by the previous install's automatic Refresh. Recovery uses only the original durable receipt, without inventing a current binary path or redownloading.

Observed local verification uses the pinned Node 24.21.0 and checked D archive. It executes actual Main IPC, Host, D and disposable protocol/version actors; it never executes real Codex or Claude, including version discovery:

| Existing acceptance route | Observed result and scope |
| --- | --- |
| Codex member provider, runtime-source selection and native identity suites | 45 passed, 0 skipped. Both exact protocol revisions cover selected config/MCP, input/tool flow, original interruption and cold checkpoint identity; 0.162 → 0.169 derives a new recipe while retained 0.162 remains unchanged; 0.170 refuses. |
| Desktop runtime sources plus captured Codex browser/device login | 13 passed, 0 skipped before the additional original-IPC assertions. The 0.169 account actor includes nullable email, new plan and private optional fields; projection remains finite. |
| Installer service, captured Codex DTO and original renderer consumers | 121 passed, 0 skipped. Immutable same-version instances, delayed final Ready, truthful failed publication, no success Refresh and capture-error recovery are exercised. |
| Final installer service and source-owner regression after exclusive temp acquisition and recovery refinement | 39 passed, 0 skipped. Original durable preparation recovers before acquisition; a foreground change and unknown version cannot replace the old selection. |
| Final Desktop runtime-source suite through the actual registered installer IPC | 9 passed, 0 skipped. Private capture failure has no legacy fallback; lost ACK looks up the original command; later source publication survives automatic Refresh; cold original management target is preserved. |
| Compiler boundaries | Host and all Host-test TypeScript projects pass after the existing event predicate was narrowed. A focused Main TypeScript project covering the affected owners and integration tests passes. Full Main typecheck previously exhausted local memory; this focused result does not replace the full CI gate. |

The suite counts describe successive affected-source checks and are not summed as distinct cases. Original logs are retained beside the checkout (`integration-codex-0169-host.log`, `integration-codex-0169-main-host.log`, `integration-codex-installer-consumers.log`, `integration-codex-source-final.log`, `integration-codex-ipc-source-final.log`, `integration-codex-focused-typecheck.log`). Source changes are frozen for coordinator publication after these checks.

Windows scoped source execution is a separate concrete remaining seam: `RuntimeSourceNativeVersion` and later source-selected launches need the original Main port plus an independently verified source admission. P08 §15 owns that work and its real Windows Node/C++ fixture receipts. This POSIX/emulated acceptance does not claim those Windows paths or paid-vendor execution passed. The supported-wrapper source capture is preserved so the P08 owner can connect the existing launcher without changing installer or profile authority.
