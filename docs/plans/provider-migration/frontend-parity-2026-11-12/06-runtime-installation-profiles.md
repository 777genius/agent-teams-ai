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

### §22.1 — original metadata callback evidence for the actual 0.169.0 candidate refusal

**Status: PLAN ONLY / source 0.** This amendment leaves §23 reserved for the
separate OpenCode V2 installation/selection work. It does not change Codex
eligibility, the checked D artifact, provider configuration, the original
candidate acceptance assertions, or any native invocation.

**Observed failure.** On original F head
`1160b575c4e43db045ab8726fd16d27bd611196a`,
ordinary job `132024091308`, step 19
completed the original initialize, model/list and config/read awaits, then
`readCandidateCatalog` line 236 failed `2 !== 0` in the `unexpected` callback
count. The original subtest took 878.113459 ms. Immutable original job log:
F blob `aca5e82f3db016d24313f0e70e46dabf226d3b22`. The log shows no separate
cleanup error in the AggregateError, but that alone is not a cleanup receipt.
Artifact 14059882436 has ZIP SHA-256
`567a2ff2695cc859d3259646f9d89d8828b97c13152a4cceda11bf569f27f764`;
its member contents have not been read. No repeat run is authorized by this
amendment.

**Exact contract finding; no invented identities.** In consumed D
`3b39a50b28319a3e91e0779493f0d64acb98d2e5`,
[app-server.ts 223–242](https://github.com/agent-teams-ai/old-provider-implementations/blob/3b39a50b28319a3e91e0779493f0d64acb98d2e5/packages/provider-implementations/src/features/provider-session-implementation/adapters/codex-protocol/app-server.ts#L223)
(blob `612a2b847a4aab640819c5e4d40632e1af98e53f`) forwards unbound native
notifications through `onEvent` as `unsupported_raw_event`, with optional
thread/turn identity; only the separate account-login completion has its own
private path. The callback therefore is not a conversation-only contract.
The public event union is
`session-types.ts` `58062e883ef8dca93687608b2cb661cf6961b0fd` +
`contracts/codex-events.ts` `52c7dca32ecb7a86927e728811b3c608cf0e547d`.

Official `openai/codex` tag `rust-v0.169.0` resolves through tag object
`a41fe5b443652cbdbee57717fbb9fd78d8d8b32a` to commit
`d32063f96c2dff1dc96af839b3952abb6acfeda4`.
Its [app-server/lib.rs 1286–1310](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/app-server/src/lib.rs#L1286)
(blob `7a2892b5984f815b1aaab59e584364b82f66e755`) sends
`remoteControl/status/changed` on successful connection initialization after
configuration warnings; the candidate's original initialize has no notification
opt-out. [startup_warnings.rs](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/app-server/src/startup_warnings.rs)
(blob `b2eec2f6b2b4d9c8865da4eac69b6db6bf754127`) sends `configWarning`
and supports separate background `warning` notifications. These source facts
disprove a general zero-callback metadata assumption. They do **not** identify
both callbacks in this actual run or prove that an unknown notification is
benign.

The F callback currently increments a number and discards the event.
The existing wire inspector also does not retain unsolicited notifications;
candidate receipts retain outbound methods, approvals and selected replies,
not those incoming event identities. More artifact readback cannot be assumed
to reconstruct information this source never stored.

**Smallest observation, same two existing TEST files.**

| Existing path | Exact preimage on working parent 3c77393 | Planned delta |
|---|---|---|
| `packages/legacy-agent-host/tests/fixtures/native-codex-team/driver.ts` | `49b868c3275422887dc03e9b910ac54a326bdf03` | Retain a closed bounded projection from the original metadata `onEvent`, plus the original lexical metadata stage and completed-await flags; expose only a frozen snapshot to the existing receipt owner. |
| `packages/legacy-agent-host/tests/native-codex-team.native.ts` | `3e9677bd30d74967763358a871ff482baf44b639` | Add that snapshot to the existing candidate receipt and one bounded failure-only summary after the original cleanup and successful receipt write. |

1. Install the observation before the original client is initialized. Keep
   `unexpected += 1` and the existing `assert.equal(unexpected, 0)` unchanged.
   The original initialize/list/config calls, their order, deadlines, failure
   propagation, permission refusal, client.close and original child cleanup
   remain byte-semantically unchanged. No new wire read, RPC, listener, signal,
   timer, retry or process is introduced.
2. Retain at most eight rows. Each row contains only the original lexical
   stage (`initialize`, `model-list`, `config-read`, `assertions`, `closing`
   or `closed`), the closed D normalized event type (all declared union
   literals, otherwise `other`), a closed native method classification, and
   two booleans for a valid nonempty original threadId/turnId being present.
   No actual ID, native payload, command, argument, error/warning text, path,
   endpoint, account or token is copied.
3. The native method projection accepts only explicit fixed literals
   `remoteControl/status/changed`, `configWarning`, `warning`,
   `deprecationNotice`, `account/updated`, `account/rateLimits/updated`,
   `mcpServer/startupStatus/updated`, `thread/started`, `turn/started`,
   `turn/completed`, `item/started`, `item/completed`. Unknown values become
   `other`; a normalized event without rawType uses `not-exposed`.
   No string-prefix fallback or arbitrary method/error string is retained.
   Own data descriptors prevent getters from becoming observation effects.
4. Keep a separate saturating observed-count projection (0…9, where 9 means
   at least nine) and an overflow flag; this never replaces or changes the
   original assertion counter. Set each completed-await flag immediately
   after that original await returns, before a later assertion can fail.
   An incomplete/invalid diagnostic remains unknown and cannot change the
   original test result.
5. The native receipt reads the original metadata driver's snapshot, without
   selecting another driver/process. The failure-only console line performs
   a second closed projection and is at most 2048 UTF-8 bytes including LF.
   Emit only after original cleanup and successful original receipt write;
   keep original first failure, cleanup errors and their AggregateError order.
   A diagnostic failure/overflow cannot throw in place of that original error.
   Existing candidate success and default 0.162.0 paths gain no admission rule.
6. A subsequent acceptance-rule correction requires the actual closed event
   evidence and another reviewed plan. This cut neither ignores the observed
   two events nor declares them configuration-only, and it cannot produce a
   candidate PASS while the original zero assertion fails.

**Review and validation.** Independently review the exact source delta for
finite keys/enums, untouched count-zero oracle, no raw assertion dumps, and
original cleanup/error ordering. Check existing Host TEST/tool type projects,
targeted lint/source-size gates and the unchanged ordinary CI lane on the
coherent candidate head. No new suite/job/matrix or timeout increase is needed
for this passive two-file observation. Executor unavailability means no local
execution claim; source-only publication is not test, native, permission,
checkpoint, Stop or consumer-eligibility qualification.


## 23. OpenCode V2: first Install, stock CLI update and healthy support Repair through the original UI

**Status and authority.** Plan only; no production or TEST source has been changed for this section. The exact full preimage is P06 blob `922fda585a5d70c6b0c088a2b9e2969d843a92fc` (including §22.1). This closes the V2 install/source-selection part left explicit in §21. It does not qualify the Codex §22 candidate, POSIX execute-image race, or an unexecuted Desktop journey. Root remains the publisher. The intended first actual tuple is the existing Linux x64 source-selection Desktop lane, not a new runner, job or matrix.

### 23.1. Observed old/current boundary and the smallest product change

1. At the old frontend `4a0e06277fe216d9f82dbbede362668fe46622ee`, `src/main/ipc/openCodeRuntime.ts` blob `07bd3a4f5437ddbfc0cbbe1fe07c4f14f1c0590b` used the stock installer status. The old stock service blob `2c1c873c1198c515a03fe129374100121cc13e22` discovered override/app-managed/PATH CLI, ran its owned version check and projected optional support. A genuine PATH V2 CLI without support therefore exposed the existing Support Install action.
2. Current `openCodeRuntime.ts` blob `d1acd9627413a871a2e20d1d2dd1f41e12fdfc12` first reads the selected Host status; only explicit native V1 null uses the stock source. `CapturedRuntimeProviderStatusClient.ts` blob `c48ffaedfe8328f31907eb470a87b6b03377423a`, 176–224, correctly reports a captured V2 engine even without an installed selecting CLI. In that case it has no `compatibleV2Version`, while the existing UI blob `77373e9c0e6ff3729acc4449c3fa9ff85467dd22`, 31–36, requires that field. The UI is byte-identical to the old component. Thus a captured CLI-less V2 engine can be usable while the ordinary PATH-A Support Install control is unreachable. Refresh is not a bootstrap substitute: current `CapturedOpenCodeRuntimeInstaller` requires a fully captured support installation before publishing its native selection.
3. Do not replace the captured result with a stock status. In particular, `openCodeDashboardCatalogPolicy.ts` blob `3bbd44568d53de624570a447376144afa4d2ec6c`, 17, rejects top-level `v2Support:'required'`. Such replacement would hide a valid selected engine and violate §21's original-source rule.
4. Limit production edits to three existing files: the shared runtime status DTO, the original IPC status composition and the existing V2 Install/Repair component. Add one optional, closed **display-only maintenance projection** to `OpenCodeRuntimeStatus`: a missing-CLI case with the exact compatible engine version, or an installed-CLI case with its CLI version, that same engine version and `support:'required'|'ready'`. The field is `v2Maintenance?: {kind:'missing'; engineVersion:string} | {kind:'installed'; cliVersion:string; engineVersion:string; support:'required'|'ready'}`. No path, descriptor grant, publication command, native permission or launch flag is added to this projection. The original top-level `installed/state/version/engineVersion/sourceRevision/v2Support` result remains unchanged.
5. This field is an observation for the existing maintenance controls. Model/catalog, launch, Runtime admission, profile/schema eligibility and source publication do not consume it. Existing preload return plumbing and the renderer store already retain the whole typed status; they do not need a new IPC or store action. The unselected/explicit-V1 branches and the old default fresh V1 button remain unchanged.

### 23.2. Original source-fenced maintenance discovery

1. Keep the existing sender/foreground capture and `native.readOpenCodeRuntimeStatus()` first. Its missing evidence, thrown failure or changed context is still an IPC refusal; no stock success may replace it. Older adapters without the original engine/source-revision fields return their existing result without new maintenance claims.
2. For a successful selected V2 result with its exact engine/revision, capture the existing private `CapturedRuntimeSources` from that same IPC sender. Read its current summary after the native read, because the existing native target capture may publish its first configuration. Require the returned revision to equal the native status revision and the same V2 engine. A real replacement/mismatched original summary refuses the request. A published CLI needs no extra bootstrap projection. No compatible original V2/configuration evidence means no maintenance observation, not a new source or fallback execution.
3. Before stock discovery retain the full validated summary: sourceId, revision, profileId, configRevision, sourceKind, nativeGeneration, absence of cliVersion, engineVersion, configurationCurrent and preferencesDigest. Eligible bootstrap evidence requires the original V2 configuration to be current and the exact engine to be qualified for the current platform by the existing pinned compatibility helper.
4. Call the existing stock `getReadinessStatus()` once. It resolves only installed readiness and does not wait for optional latest-registry metadata. It retains the existing override/app-managed/PATH priority, version cache, time limits and support-status checks. The stock version probe is `probeOpenCodeBinaryVersionCached` → `execCli(binary,['--version'])`; `openCodeVersionDiagnostics.ts` blob `b27f70c0492bcdc3e2646ea335d98f6ef58faaec` and `childProcess.ts` blob `7c01a042f49cc89c430b1d657c66acd59f0b76b7` retain the original ChildProcess/group/birth and existing timeout cleanup. This section adds no ambient launcher, shell command, version timeout or native ownership claim.
5. After that await, including an optional discovery failure, read the same private source summary and check the original foreground again **outside the discovery catch**. Compare all retained original fields, never replace expectedRevision with a later one. Source/target/grant refusal is not an optional-registry/discovery failure. A concurrent publication or configuration/selection change must not return a maintenance result associated with the earlier engine.
6. Only an actual stock `installed:false, source:'missing', state:'idle'` can produce the missing-CLI projection. A failed version check, broken override, unsupported/foreign generation or uncertain result cannot become “missing.” Only an actual installed V2 CLI whose existing pinned engine mapping and stock compatible engine both equal the original captured engine can produce the installed projection. A genuine missing-support status is allowed as `support:'required'` but its top-level idle/error state is not copied. A discovery exception or unqualified result leaves the successful captured engine result without maintenance fields.
7. This read does not call publish/recover/refreshConfiguration/install. Its extra source reads use the existing original private port and original foreground checks. It does not select a PID, start a provider conversation or mutate a grant. The current version-only stock probe remains independently owned and bounded. The unresolved POSIX validate-path-to-spawn limitation from P09 is not solved or hidden here.
8. Explicit Install still runs the current `CapturedOpenCodeRuntimeInstaller` (blob `35e58d04cbe1368a282a17d73876eb0a5ebb7625`) through composition `3c56cfb8c7074e1f6b31c9a7b29f008acda10155`. `captureOpenCodeNativeSelection.ts` blob `8a8e739cc6f99c01291e47412c96b73eeb5d5acf` captures the actual CLI and full support. Host `RuntimeSourceNativeVersion.ts` blob `0ec09130bf10bca87b64a13efc4aab5494b13d30` performs original native version/cleanup proof, and `RuntimeSourceIndex.ts` blob `397850fec1e4e25a24c29f77f10d357134609688` publishes the original bounded intent. None is changed by this section.

### 23.3. Existing controls, fresh download and Repair meaning

- A selected captured V2 engine with genuine stock-missing maintenance evidence exposes the existing V2 install button with `{generation:'v2'}`. This is the real first CLI download plus support acquisition. An unselected fresh frontend still shows its existing V1 default; this change does not promote a V1→V2 major migration.
- A selected CLI-less V2 engine with genuine PATH A and missing support exposes the existing Support Install with exactly `{generation:'v2',supportOnly:true}`. Existing confirmation/action/store/source-publication paths remain authoritative. No preparatory support installation or direct source write in the TEST may substitute for this UI action.
- After A/B is published, the existing captured CLI status/update metadata route continues to supply Update and the ordinary Support Repair dialog. The maintenance extension does not invent latest metadata or convert the engine's 2.1.4 label into CLI 2.0.21/2.3.0.
- Healthy Repair confirms the existing dialog and executes the same support-only action. `OpenCodeV2SupportInstaller.ts` blob `7d62e5206b9a4cd726048cc05619f60df1caa2c8`, 174–176, first fully verifies the installed closure and returns it if healthy. It must not force a fresh instance. New immutable support installation remains the existing absent/corrupt route; no active closure is corrupted, removed or rewritten by the TEST.
- The current disposable `lastSelection` cache reuses the original B publication only for exact same sourceId/current revision/full nativeSelection and original lookup receipt. The planned same-Main healthy Repair case must prove those equalities and the same B command/record; this is not a cross-cold dedup promise. The default failure/recovery behavior stays unchanged.
- Because Ready B already exists before Repair, it is not completion evidence. Use the existing read-only renderer store's original install scope revision/loading state, original dialog disappearance and original current-source/support readback to observe completion of the one confirmation. No store setter, action monkeypatch, test callback in production or additional install request is introduced.

### 23.4. Exact candidate inputs and original source records

1. Use the already approved V2 selector pair from §21: genuine selecting CLI A `@opencode/cli@2.0.21`, stock latest candidate B `@opencode/cli@2.3.0`; engine stays `2.1.4`, Linux Bun stays `1.3.11`. Published registry metadata observed in blob `b69eb6b4243809e4964758b0275c86de484ac03a` distinguishes those CLI packages and their platform optional dependencies. That metadata is not native acceptance. Do not relabel an engine or V1 executable as the CLI candidate.
2. Extend only the existing TEST input preparer and its bundled original stock selector adapter. The adapter's source inventory/build digest remains checked against the original source head. Add a finite V2 call shape beside the current V1 one, with exact qualified engine 2.1.4 and the existing Linux platform package. Do not introduce a generic semver/framework or modify product selection.
3. Ordinary pinned package acquisition retains exact root/native package manifests, frozen package-lock integrity, native executable hashes and before/after bytes. Stage an independent exact B reference package for executable/hash comparison; the product UI must still perform its own stock B download and verification. No copied staged B or synthetic registry response may satisfy product acquisition.
4. Resolve the actual stock candidate using the original selector and existing public metadata bounds: at most eight metadata reads, original 15-second read bound and 16 MiB cap. Expect exact B 2.3.0; different latest/tuple/layout is an explicit failed prerequisite, not silently repinned or treated as equivalent. Record actual native package integrity, tarball, manifest and executable hash before the UI test. Those native values are not yet claimed known by this plan.
5. Reuse existing `prepare-opencode-v2-native.ts` delivery/Bun staging and `prepareDesktopOpenCodeV2Recipe` / `desktopOpenCodeV2ManagementProfile` for the captured initial engine, before first Team owner. The first engine is a verified actual graph, not an installed CLI/support receipt. In each fresh app namespace the app-managed CLI/support installation is absent until its genuine Install action. Preserve the normal private profile/descriptor freeze. Preserve the existing source-selection option, not the separate top-level `nativeOpenCodeV2` flag: `desktop-backend-fixture.ts` blob `c041f8662b8bd5db1665563edb76f5773fe4cb45`, 636–646, emits only `[null]` management scope for source selection. Before start assert exactly one original management descriptor entry with projectPath:null and the fixed source-management profile/config; do not add a project grant. The helper's internal V2 recipe reuse therefore does not create a fourth metadata scope.
6. The same localhost model/original four business markers remain. Only the finite V2 recipe changes its original provider base URL to the existing `/host/v1` route before the first owner. The model, permission policy, request cap and four input identities do not gain a new response/retry mode.
7. V2's ordinary first metadata capture calls `refreshCapturedRuntimeConfiguration` (blob `6af55c63ae61637f3cf15274a4ab4f23c15894aa`). With the fresh V2 recipe this legitimately publishes one original `intent:'configuration'` record before CLI installation. Verify that exact original configuration record/receipt, original grant, pinned Bun and absence of nativeCli. Do not transplant V1's empty-index assumption. Then require exactly one additional full CLI publication for Install A/B, with the correct previous revision, published command, native version, full original candidate and resourceHeld=false. The prior configuration/CLI records remain byte-identical; no arbitrary extra publications are accepted.
8. A native V2 selection binds the selecting CLI separately from the executor: `candidate.nativeCli` must match actual installed A/B, while `candidate.executable` remains the original Bun and `candidate.embedded` is the actual full installed support 2.1.4. Existing Host capturePublication 299–318 preserves the original Bun and configuration while accepting the exact support/CLI selection. Record these independently.

### 23.5. Two genuine UI namespaces in the existing bounded lane

Use one explicit finite V2 mode of the existing `desktop-runtime-source-selection.ts` journey and existing native test. Preserve V1/coexistence behavior and their existing invocations. The V2 mode reuses the existing two namespaces, model and four markers rather than adding a duplicate harness.

| Original phase | Required visible action and full original evidence |
| --- | --- |
| Fresh selected V2, no CLI/support | Read the usable original engine plus genuine missing maintenance result. Verify no app-managed CLI/support and the original configuration-only source record. Click the existing V2 Install once. Product stock download/full support verification publishes B 2.3.0; verify its actual app-managed manifest/SRI/native hash, exact original source command/revision and engine 2.1.4. |
| Fresh-install B member | Ordinary Create/model choice and original `TEST_SOURCE_INSTALL_B` input consume that B recipe source. Actual native reply, Runtime input/operation, session/binding and physical executor evidence must agree. Original visible Stop confirms that member's release/absence before leaving the namespace. |
| Separate PATH A without support | The original app PATH exposes genuine A 2.0.21, with no app-managed CLI/support. Status keeps the captured engine usable and shows Support Install. Click it once; full verification publishes exact PATH A. Only then ordinary Create/model choice and `TEST_SOURCE_PATH_A` launch A. No setup installation or Refresh substitutes for this first action. |
| A stays active while B is installed | Existing visible Update A→B uses the original stock selector/download and publishes exactly the next B record. A's original launch/capture/recipeSources, Runtime/session/input, native birth and A source bytes stay unchanged/alive. B current selection alone does not prove any member uses B yet. |
| Healthy support Repair | From the real dialog confirm exactly once. Observe original action completion, unchanged support instance/manifest/full closure/CLI B bytes, exact same B source command/revision and no new CLI publication. A remains the same original live member. The outcome is healthy verification, not a manufactured reinstall/new instance. |
| Actual A continuation and Stop | Send only the existing `TEST_SOURCE_LIVE_A` input through A's Composer. Require the same original Runtime/session/binding/native birth and previous native history, unchanged first input and one actual response. Stop A through the original UI; release and original-birth absence precede any B member capture. |
| Next launch uses B | Ordinary Create/new `TEST_SOURCE_UPDATE_B` consumes B's original full source reference, not a substituted current PID. Require a distinct new session/binding/native birth, actual response and exact B CLI selection with engine still 2.1.4. Stop B and confirm its original release/absence. |
| Same-profile cold history | Quit/cleanup the original app, start the existing same-profile cold app, and read both original histories. Preserve source index/receipts, launch records, original session/input bytes and all native input counts. No install, Runtime open/input, source publication or fabricated Stop is admitted by readback. All original management resource debt must be released. |

The TEST may read the original source/management/runtime files using the existing bounded same-file snapshot logic and retained schema/digest checks. It must not instantiate recovery writers, inject command receipts, preselect by editing the index, call hidden product install APIs, or treat metadata-only engine readiness as successful member execution.

### 23.6. Physical process evidence, cleanup and unchanged bounds

1. V1's selected CLI `serve --hostname ... --port ...` census cannot identify a V2 member. Exact `OpenCodeV2EmbeddedServer.ts` blob `a7447324a75e43f566c03eeaf03dc1af67c2b669`, 267–289, passes database/endpoint in private stdin and gives both metadata and member the same Bun/embedded-child argv. Successful catalog reads retain `ProviderManagementCoordinator.v2Hosts` (blob `8d2d656cc043d135fef925698363c4ec48e2eb48`, 630–657). A settled management receipt is not proof that a passive catalog Bun exited. The earlier single-unclassified-Bun proposal is explicitly rejected.
2. Reuse `readDesktopNativeHostProcesses` from existing `desktop-native-stop-fixture.ts` blob `0b4a8973310038dc7a13750b9583c6d8a215bd83` to retain the original Host inside the already captured app group, including its exact Node/entry and birth. Add only an export of the **unchanged existing closed log parser** `readEvents` in `desktop-opencode-metadata-lineage.ts` blob `4a44b17258758dbcec0fa59c8ac9d16a78752d6b`. Its framing, own finite field set, 4 MiB accepted-log limit and 128-event checks remain unchanged. The existing parser checks size after `readFileSync`; this is not a new bounded-FD-read or allocation proof. No new product log, native observer, process selector or log stream is added.
3. In the source-selection helper read the complete original Host event sequence once per existing bounded observation, validate its immutable prior prefix and every original ready/released identity **before** partitioning. Derive the only eligible profile hashes from the genuine configuration/A/B source records and original captured management identity; at most the three explicitly expected published records exist in the path namespace. Reject unknown profiles, unknown/duplicate/reused PIDs, cleanup-unknown and any dropped prior event. Do not gain three independent log budgets: the original complete event count/byte checks and retained receipt ledger remain global, with no reset when source changes.
4. For each still-live exact original profile present in that validated full sequence, reuse `captureDesktopMetadataLineage` with that one profile and its retained prior lineage. A retired profile retains its earlier captured lineage and uses the existing `assertDesktopMetadataReleasedEvidence` zero-active/physical-absence path; never call the live-owner assertion with a silently dropped retired slice or weaken its active-size check. A fully retired profile without its original prior lineage remains unconfirmed. The existing helper's 1–2-profile bound stays unchanged. Each excluded live metadata process must have the exact original ready/current-owner chain, captured Host parent, Bun executable and still-live birth; on Linux additionally join the logged startIdentityHash to SHA256 of the observed original `pid:startTicks`. Retired/released rows never hide a live recycled process. Keep every original event/birth through source changes; do not reconstruct a new ready baseline from the current UI selection.
5. Observe the original metadata lineage from the first original Host/configuration stage, before Install/Create. Around each later witness require unchanged full original source-index and management-command snapshots; all original command resource debt must be settled, but retained catalog owners are accounted separately. Genuine expected A/B publication extends the allowed source-record prefix only at its explicit observed action, never during a witness. Before the original Create, every direct Host Bun child must be accounted for by the validated live metadata identities: exactly zero unclassified children. After the actual original Runtime becomes ready, subtract only those proved identities and require exactly one remaining original Bun child. Any extra/unknown child remains a failed/unknown witness, not an ignorable background process.
6. Join that remaining child's exact original birth with the same one expected Runtime/launch/capture source and actual original model response. Retain it unchanged for A continuation, and require its actual absence after original Stop before capturing B. The fixed endpoint and source/runtime evidence are separate joins; this is not a kernel socket-owner proof from argv. Production's existing embedded ready nonce/PID/startIdentity verification and custody remain unchanged. CLI version subprocesses are acquisition evidence, not a member oracle.
7. Include Bun and all observed metadata births among the existing bounded original observations/file pins. At original Quit use the same retained ready→released chains and original physical absence, alongside the existing Runtime/source/management cleanup evidence. No newly discovered PID gains signal authority; no new read may manufacture a close receipt. Support completion readback uses the original installed manifest/instance and full existing verifier results. No post-check image immutability or POSIX race-free claim follows.
8. Preserve existing absolute bounds: test timeout 900 seconds, existing CI job timeout 30 minutes, existing source model 32 requests/four business inputs, UI observation 90 seconds, 64 original process identities, 512 UI steps and original cleanup budgets. Reuse V2 recipe's already existing 120-second readiness/model limits; leave V1 limits unchanged. No timeout/cap increase, extra business retry, replacement input or new test framework.
9. Amend the existing source-selection CI job with one explicit invocation of this same V2 mode and its bounded input/receipt artifacts. Keep the V1/source/coexistence invocations. The extra required proof must fit the unchanged existing job budget; exceeding it is a real failed gate, not permission to grow the budget or call partial progress PASS.
10. The Linux CDP ownership guard and all existing source/native cleanup guards remain. A startup/metadata stall means the relevant UI/business phase was not qualified. Current V2 failures and candidate fixes from P07 remain separate evidence; this plan does not predict their cause or borrow D-only CI success.

### 23.7. Frozen intended source scope and critical verification

The following exact preimages were read from the current parent source tree (root composes later unrelated changes, especially its workflow). No new production/test module or public endpoint is needed.

| Existing path | Exact preimage | Intended delta |
| --- | --- | --- |
| `src/shared/types/cliInstaller.ts` | `7ab31be0aa86d6e8a0cf6f94b5b3197f92f0c92e` | Optional closed display-only maintenance union on the existing runtime status. |
| `src/main/ipc/openCodeRuntime.ts` | `d1acd9627413a871a2e20d1d2dd1f41e12fdfc12` | Successful original V2 status + one stock readiness observation, exact source/current fences, no native-error fallback. |
| `src/features/opencode-runtime-installer/renderer/OpenCodeV2InstallAction.tsx` | `77373e9c0e6ff3729acc4449c3fa9ff85467dd22` | Existing explicit Install/Support Install/Repair controls consume the new maintenance projection; old defaults remain. |
| `src/main/ipc/openCodeRuntime.test.ts` | `08fb5ea0ed7510ca8f6db2cf182fc1455680262e` | Extend original status cases for source/revision/current fencing, missing/required maintenance, native failure vs optional discovery failure and no publication. |
| `test/renderer/components/cli/OpenCodeV2InstallAction.test.ts` | `5198ce30c1f9f050050a2f5a91148495ea59c30f` | Existing control cases prove selected-V2 missing download/support-only/healthy Repair payloads and unchanged fresh/V1 defaults. |
| `src/renderer/components/dashboard/openCodeDashboardCatalogPolicy.test.ts` | `76acb4faae467c4edbb918c5ea0e21404b842ce6` | Extend existing ready/refusal cases: nested missing/required maintenance cannot disable valid original engine evidence or grant a failed engine readiness. Production gate unchanged. |
| `scripts/legacy-agent-host/desktop-runtime-source-selection.ts` | `df7d6eef28abcfb17eca4133b69298ea959999b6` | Finite V2 branch of original two-namespace/four-input journey, original configuration baseline, healthy Repair and actual Bun observation. |
| `scripts/legacy-agent-host/desktop-opencode-metadata-lineage.ts` | `4a44b17258758dbcec0fa59c8ac9d16a78752d6b` | Export the unchanged closed whole-log parser for the explicit source proof; existing lineage APIs and all limits stay unchanged. |
| `scripts/legacy-agent-host/desktop-runtime-source-fixture.ts` | `0523b645076339840460e7947a3ac10fbd4b785c` | Explicit V2 source-selection recipe reuses existing verified V2 preparation before first owner. |
| `scripts/legacy-agent-host/prepare-retained-opencode-coexistence.ts` | `26906648d1633d32a7b7945c9b03ac9f66ae5a81` | Finite V2 package/selector input evidence beside the original modes, no provider session. |
| `packages/legacy-agent-host/tests/fixtures/native-opencode-install-selection.ts` | `fdc9941ebc4ec4ef98f927df70757b143a648c57` | Exact V2 typed selector call beside V1; same measured original pure implementation. |
| `scripts/legacy-agent-host/desktop-retained-opencode-coexistence.native.ts` | `2e53102bdce1bba7f3b724d76f9c59f0866b6da2` | Dispatch the explicit V2 mode to the same test/helper under the same timeout. |
| `.github/workflows/ci.yml` | `2f00c1be87037da32332ad42493c7130bb896dd5` (read parent variant; root owns latest composition) | Existing-lane input stage/invocation/closed receipt assertions/artifacts only; no job/matrix/budget changes. |

**Critical cases, not a new suite.** Existing IPC cases must distinguish (a) actual PATH required support from native failure, (b) genuine stock missing from failed/broken override, (c) discovery rejection while the exact engine remains usable, (d) same foreground with source/config revision changed after stock await, and (e) rejected foreground after optional failure. Assert original top-level status unchanged, fixed native/status read counts and zero publish/install calls. Extend existing renderer cases to check exact payload and no accidental installed-V1/default major migration. In the existing catalog policy case, nested maintenance must not weaken or invert the original gate. No copied TEST result can replace the actual source/Host/UI journey.

**Review and acceptance.** First review this exact plan and the three-path DTO/IPC/UI boundary with root and independent peers. After publication, implement only the declared connected scope, retain all per-file source caps (each changed production file and new helper logic below the existing 800-line limit), then freeze exact blobs/preimages. If a necessary extraction or extra path emerges, return a concrete plan refinement before that source edit; do not compress formatting or silently grow scope. Require normal build, Host/test/scripts/Main/renderer types as relevant, targeted existing tests/lint/source-size gates and the one ordinary coherent native/UI lane. Unavailable local execution remains explicitly unexecuted; normal CI supplies required execution before final acceptance. Qualification is the actual selected V2 initial Install/download → A active across B publication and healthy Repair → original A Stop → B next launch/Stop → cold history route. Source review, stock metadata, selector success, package installation, engine catalog or a direct provider test alone does not complete this parity.

## 24. Original V1 source-input prerequisite: published root bin layout

**Actual result, not a UI failure.** Parent head `1160b575c4e43db045ab8726fd16d27bd611196a`, job `132034324322`, installed exact `opencode-ai@1.19.4`, `opencode-linux-x64@1.19.4` and Corepack 0.36.0 with pnpm 11.22.0 and `--ignore-scripts --save-exact`. The platform executable passed the existing fixed SHA256 check. The earlier original V1/Host-V2 coexistence native test passed in 386521.54 ms at 18:10:50 UTC, and its 12 model cases passed. The next V1 source-selection input step failed at 18:10:51 in `pin()` → `realpath()` on the hard-coded `node_modules/opencode-ai/bin/opencode` (preparer line77). Its UI test did not start; the later missing source-selection receipt is a consequence. Full decoded original log is F blob `fdbfae9e53f3651d6a3ba3609e4898f302dcf8cd`. No native/CI rerun was used for this investigation.

**Official layout evidence.** The official `anomalyco/opencode` tag `v1.19.4` resolves to commit `148842ef7cb1bc34192b3fff57d0f9721ab9c801`. Its workspace `packages/opencode/package.json` blob `39aa5a2946d7902b51efaa45b459e0b29fbe05d4` is private source metadata, not the published npm manifest. Exact `packages/opencode/script/publish.ts` blob `ac1cafff56f46e9611a9ff78aa05217d21a907ef`, 34–69, writes the published root file `bin/opencode.exe` and declares `bin.opencode = './bin/opencode.exe'` on all supported platforms. That published file initially reports that postinstall was not run. Exact `postinstall.mjs` blob `fa303b746b8c585561986f8399e4a038f1bd507c`, 27–29 and 146–170, selects the platform binary and copies it to that root `.exe` path. With the actual ignored scripts, that copy is not performed. The TEST already selects the separately installed platform executable as its real native input; it must not execute the uninitialized root bin.

Primary immutable locators:
- https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/opencode/script/publish.ts
- https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/opencode/script/postinstall.mjs
- https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/opencode/package.json

The source-backed cause is the preparer's assumption that the workspace launcher layout is the published npm layout. It matches the original ENOENT. The original installed root manifest/file contents are not available in the retained inline job log, so this plan does not claim to have inspected those runner bytes. The corrected prerequisite must validate them during the next ordinary run and fail on any mismatch.

**One existing TEST file only.** Amend `scripts/legacy-agent-host/prepare-retained-opencode-coexistence.ts`, preimage `26906648d1633d32a7b7945c9b03ac9f66ae5a81`. In the existing V1 source-selection input branch, read the exact installed `opencode-ai@1.19.4` manifest already required by the preparer. Require the exact published bin map for `opencode` to `./bin/opencode.exe`; do not search for alternate launchers or guess a native path. Resolve its package root canonically, then pin that declared file using the same regular-file/size/SHA256 helper and require it to remain inside the original package root. Retain the existing `rootManifest` and `rootLauncher` evidence fields and every downstream before/after hash check. Document that this root-bin pin is unexecuted package-layout evidence; the independently pinned `opencode-linux-x64/bin/opencode` remains the only original A executable.

**Preserved boundaries.** Keep exact package versions and root/native SRI, fixed native A SHA256, source/bundle selector digests, stock B1.19.5 qualification, manifest hash, package-lock pin, frozen input/readback checks, `--ignore-scripts`, all action IDs/budgets and cleanup unchanged. Do not enable or run postinstall, copy the native binary into the root package, replace the missing root proof with the native pin, add a broad fallback path, remove a pin, change product source selection, or report the unstarted UI phase as failed/passed business execution.

**Review and validation.** Independently review the exact one-file manifest/bin/containment delta against the official publish source, then retain existing scripts types/lint/source-size checks and the unchanged ordinary source-selection lane. There is no new test suite, job, matrix, package acquisition or native experiment. Executor remains unavailable; source publication alone is not executed validation. This narrow repair should land before §23's later extension of the same preparer, whose immutable preimage must then incorporate this reviewed repair rather than restore the wrong hard-coded path.

### 23.8. Place the finite source-lineage composition in its existing TEST helper

The full source-selection journey preimage `df7d6eef28abcfb17eca4133b69298ea959999b6` already has 607 newline-terminated lines. Adding the required whole-log configuration/A/B partition alongside the V2 publication, Repair and member checks in that one file risks the unchanged 800-line cap. Preserve the exact §23 oracle; place only its source-specific metadata composition beside the existing lineage functions instead of compressing the journey or creating another module.

Amend the existing declared `scripts/legacy-agent-host/desktop-opencode-metadata-lineage.ts`, preimage `4a44b17258758dbcec0fa59c8ac9d16a78752d6b`, beyond the originally planned parser export: add one finite TEST helper, `captureDesktopSourceMetadataLineage`, for this source-selection journey. It receives the same original Host fact, the only eligible profile hashes derived from the genuine configuration/A/B records (at most three), the original observed process facts and the previously retained whole lineage. It returns the retained per-profile lineages and exact live metadata births. A final original-Quit call additionally requires every observed profile to be retired; it cannot create cleanup evidence.

The helper performs exactly one unchanged `readEvents` call per original observation. Validate the complete accepted log, existing 4 MiB/128-event limits, immutable global prior prefix, same original Host, all eligible profiles and global no-PID-reuse before any per-profile partition. Never reset or multiply a log/event budget by three. Keep the existing live `captureDesktopMetadataLineage` and retired `assertDesktopMetadataReleasedEvidence` APIs and their 1–2-profile bounds unchanged, invoking them with one original profile at a time. A retired profile requires its previously retained physical lineage; missing original lineage, unknown cleanup, foreign profile, replaced birth or surviving retired PID is still refusal. No arbitrary Bun child is filtered.

The journey retains the Linux-only join against the actual original `pid:startTicks`, its source-index/management snapshot fences, the zero/one unclassified member assertions, and all original Runtime/source/input/Stop/cold-history checks. The helper neither reads new kernel/socket fields nor obtains process control, grant, install, source-publication or Runtime authority. This is only the planned read-only observation composition in an existing matching module. Existing parser framing, ordinary lineage callers, native effects, cases, timers, budgets and the approved 13-path inventory are unchanged. Keep both changed files under their existing source caps and independently review the exact wrapper/caller deltas before publication; source review alone does not qualify the native journey.

## 25. Codex installation retention and captured-source publication — separate storage and selection phases

**Status: PLAN ONLY; source0.** This appendix extends exact full P06 blob 260cabca3bc8874e9f144d6268e71a527416cf71, which preserves a53355fa83661ac3b18e763329b18a2a3cc03393 and the published §23.8 helper amendment. Root is the only publisher. Phase A below is the first, two-existing-file source cut after root and independent review; phase B is mandatory follow-through, but has **no source authorization** until its connected manifest, native eligibility evidence and acceptance accounting are amended and reviewed. No phase-A source or checks have run. Root has reported a restored executor; actual checks wait for the assigned isolated checkout and coordinated toolchain. Until those results, this work remains SOURCE_ONLY_UNEXECUTED. Neither a successful package download nor phase-A tests establish that the captured Host selected a new Codex runtime.

### 25.1 Original facts and the precise missing behavior

CodexRuntimeInstallerService.ts1efd89b69448ccc93d97328a990f0e194d70e5bc is byte-identical to the exact old frontend4a0e06277fe216d9f82dbbede362668fe46622ee. Its installInternal703–725 stages a verified package, then unconditionally removes versions/<platformVersion>/<vendorTarget> before renaming the staged directory into that fixed path. A second installation of the same version can therefore replace the original captured package A. This is source-proven stock behavior still lacking the retention integration; no observed active-process failure is claimed. writePackageFiles481–497 preserves the whole selected vendor closure and executable modes, including codex, rg and sandbox helpers; retaining only the principal executable would not preserve this behavior.

The manifest at runtimes/codex/current.json is currently written with ordinary writeFile736–740. Its schemaVersion1 contains the absolute binaryPath, original root/platform versions, target, integrity and installedAt. The existing parser90–106 and resolver118–120 do not require the fixed directory layout. An immutable instance path therefore needs no manifest schema migration, public API change, symlink or rewritten captured profile.

The source-publication gap is distinct. registerCodexRuntimeInstallerIpc.ts080627b6ac8f91b8af48d79725308dc56d8e8062 and shell codexRuntime.ts116bd3001be3f872d0f47da253394a75927c0485 call only the stock get/install/invalidate facade. They do not capture the original sender/source grant or publish a Host source receipt. P06 §21 already records this gap, and §§22/22.1 qualify/observe the genuine0.169 candidate without authorizing this consumer. Phase A will not silently close or bypass it.

### 25.2 Preserve the two existing resolution contracts

| Existing surface | Exact current behavior to retain |
| --- | --- |
| Stock installer status, service1efd89:515–536 | A usable managed manifest is reported before PATH discovery. If managed verification fails, the original PATH fallback and reported failure semantics remain. Registry unavailability remains optional status metadata. |
| Actual legacy binary resolution, CodexBinaryResolver.ts0f9778298640bfd421531e501386e26be99d1cf4:runResolve and cache revalidation | A working process CODEX_CLI_PATH takes precedence, followed by a distinct working shell override, then a verified managed executable, then PATH. Preserve existing Windows PATHEXT/shim expansion, enriched environment, stale-override fallback, cached-positive/miss and launch-verification rules. |
| Captured sessions, account operations and checkpoints | Their original executable/configuration/account/source references remain fixed. Installing B does not change A's profile, input, permission, auth intent, checkpoint bytes or cleanup owner. New foreground selection and retained original operations are different uses of the existing ports. |

The stock installed-status object is not proof of the effective custom/override choice. Phase A edits neither resolver. Phase B must carry the original Main selection witnesses and preserve the existing priority; it may not infer override absence from sourceKind=captured, a binary name, a version string or current process.env read after an await. A real custom override must not be displaced merely because installation produced an app-managed package. Missing original selection provenance holds the original pointer rather than choosing an ambient fallback.

### 25.3 Phase A — two-file immutable package storage

1. Keep the existing metadata selection, platform package/SRI checks, streaming/unpacked caps, full extraction, executable modes and one original staged --version verification. Do not add another native process, change package/version selection, enable package postinstall, or alter any download/version/retry budget.
2. Replace only the fixed publication destination with a fresh invocation-owned sibling instance, for example versions/<platformVersion>/<vendorTarget>-<randomUUID>. Reuse the existing randomUUID import and staging/rename helpers. The instance is new even for the same advertised version and identical package bytes. Do not put B inside A's original package directory, remove a prior destination, reuse a version-only identity, or mutate a PATH/custom package. The new UUID destination is not an intentional target for any earlier complete package. Ordinary rename is not a universal no-replace primitive and may replace an existing empty directory on some platforms; this change does not claim a new race-free namespace guarantee. Do not add a collision-repair path that deletes an observed destination.
3. Preserve the complete extracted B closure under that instance before advertising it. Keep the original temporary-directory cleanup while it is still the invocation's unpublished staging directory. Once rename succeeds, clear tempDir as today: a later manifest failure must not delete B, which may already be referenced. No pruning, retention registry, reference-count service, new daemon or garbage-collection policy is introduced.
4. Publish the unchanged manifest shape/text through existing atomicWriteAsync from the same @main/utils/atomicWrite barrel already used for renamePathWithRetry. Use its existing strict file synchronization and directory synchronization options; do not change the shared implementation, add an unlink-before-rename fallback, or create a second persistence abstraction. This establishes complete-file replacement through the existing helper, not a new claim that every package byte is power-loss durable.
5. Preserve the original error/progress/result ordering. A pre-commit manifest failure leaves the old complete pointer and A bytes. A failure after the helper's actual rename, such as directory synchronization failure, can leave B visible: report the original failure, retain both complete packages, and do not claim rollback or confirmed non-publication. Do not delete B or rewrite the manifest back to A in a catch. Existing later status reads use the actual manifest; no automatic second install is spent.
6. Existing schemaVersion1 manifests and old fixed-layout A directories remain readable. Do not migrate, rewrite, chmod or remove them. The same-version path-safety fix is useful independently of0.169 eligibility, but remains stock acquisition only until phase B.

| Phase-A changed path | Exact preimage at workingbe270ccb | Authorized change |
| --- | --- | --- |
| src/features/codex-runtime-installer/main/infrastructure/CodexRuntimeInstallerService.ts | 1efd89b69448ccc93d97328a990f0e194d70e5bc | Fresh immutable destination and existing atomic manifest helper only; existing resolver/selection/status/public API unchanged. |
| test/main/features/codex-runtime-installer/CodexRuntimeInstallerService.test.ts | a70c3cc04839bea8c230ee0bd7db5a1faa3804eb | Extend the existing verified-install and installed-runtime failure coverage with real TEST filesystem retention and publication-boundary assertions. No new suite/native invocation. |

Read-only implementation anchors: src/main/utils/atomicWrite.ts b1dc835f72954f26e18838b44ae5e83d9fac1a15 re-exports atomicWriteAsync; packages/task-change-ledger/src/review/io/atomicPersistence.ts58e271064d25e302c57cf8d90bffc9393bc10670 performs temporary-file sync, rename and optional directory sync, and explicitly distinguishes post-rename errors. Its existing tests test/main/utils/atomicWrite.test.ts54af1cbde01d0a7ea3ab5dd7db66d30f67beedd1 remain a dependency gate, not a third edited path. Service is currently781 physical lines (782 newline-split entries); stay <=800 without compressing unrelated code or changing any baseline.

### 25.4 Phase-A critical verification

Extend the existing small verified-tar installation case, retaining its192MiB advertised-header boundary, to install two different complete TEST payloads with the same platform/version metadata. The test must use the real installer/extraction/manifest/filesystem path, preserve the first result and original bytes, and prove: A and B canonical executable paths differ; A principal/helper bytes and relevant executable modes remain unchanged; B contains its own full principal/helper payload; the normal manifest resolver selects B. The existing execCli stub remains explicitly synthetic; this is a filesystem regression test, not a retained native-process claim. The old implementation must fail the distinct-path/A-bytes assertions.

Retain the existing registry-offline/PATH case and its original assertions. In the same existing suite, cover original managed A when package verification or atomic manifest publication fails. Inject faults at the actual TEST filesystem boundary, with no production fault parameter: before manifest rename, assert exact original complete manifest bytes and all A package bytes; after actual manifest rename but failed directory sync, allow only a complete A-or-B pointer consistent with the observed commit point, preserve both packages, retain state=failed/original error and do not spend another install. A post-rename case must not accidentally pass because an earlier failure already stopped the operation.

Keep existing parser/legacy fixed-directory, PATH shell discovery, package integrity/path traversal and complete payload tests. Run the unchanged CodexBinaryResolver.test.ts1b832bd21cb985b68fb4a6532a0ca4408be413d5 priority/cache cases as a relevant regression gate; no resolver source/test changes are needed for A. Focused tests, canonical Main types, fast lint and the source-size guard remain required. With no executor, freeze/review source and let ordinary candidate CI execute these gates; never label an unexecuted source cut PASS at runtime.

### 25.5 Phase B — original captured selection, not a second installer framework

Before B source, publish a connected amendment with exact final paths/preimages after A and the currently checked dependency pin. Candidate native0.169 must first satisfy the existing §22 actual catalog/input/permission/Stop/cold proof; §22.1 notification diagnostics alone are insufficient. Current runtimeSourceQualification.ts3b6d4abafd37c0677f5e4b32334b958416975c98 admits Codex only when native version equals the seed protocolRevision, while runtimeProfile.ts a1daa87f33aceeae3fe81d9d91217d89ed12bb8d and management/profile.ts e1af7fe25cd74a1c2710713853eaae729b81ed1a retain their existing finite native contracts. Any change to this exact qualification/protocol mapping needs its own reviewed finite amendment. No arbitrary version range, false0.162 label, opaque checkpoint rewrite or silent downgrade is authorized here.

The intended consumer is one Codex-specific application adapter in the existing feature, following the already present CapturedOpenCodeRuntimeInstaller35e58d04cbe1368a282a17d73876eb0a5ebb7625 ownership pattern, not a generalized installer framework. Capture the original event's sender/context/descriptor source grant before native acquisition. Read the original full source summary once, preserve the initial expectedRevision across all awaits, and retain an invocation-owned pending result before a duplicate can spend acquisition/publication. Recovery uses only the saved original command/candidate; do not replace it with today's installed file or current pointer.

Reuse CapturedRuntimeSources0b3fe40f6cc29c2a4c53b10ad1d96aaea7b87a0e publish/lookup/recover and its owner/foreground guards. A new source publication requires canonical actual executable path, complete native identity/hash/version qualification and a published original receipt. Static discovery must not allocate a second legacy app-server or use a legacy --version resolver outside the original Host source-verification owner. Read-only rechecks fence the original selection; they do not supply a fresh expectedRevision. A lost response is resolved by that command's lookup/recover, never by another install or current/default adoption.

Stock installer publish(status) emits ready progress before its IPC result today (1efd89:549–565/742–756). The B amendment must explicitly gate the captured branch's user-visible Ready/result on the source publication receipt, including that progress channel; suppressing only the IPC Ready would be incomplete. Acquisition progress can remain visible with its real meaning. The existing renderer installCodexRuntime action in cliInstallerSlice.ts3958bb219db5509e6c6433a006e5a0bfacb2791f:1590–1620 immediately invalidates/refetches after success: this must reconcile the same original publication, not create a second revision. GET/status remains observation, and a failed captured/native read never falls through to a legacy app-server.

Existing generic Host consumers already provide the narrow destination: RuntimeSourceIndex397850fec1e4e25a24c29f77f10d357134609688 nativeSelection299–319, currentForRecipe594–611, resolveRecipe614–639 and managementProfile734–741 use the provider's original grant/source. DesktopBackendFeature e278f1894e408f54c483ad8ace2a5df9eecbd8ea:567–584 accepts codex; captureCurrentManagementTarget708–717 reads the selected source. New metadata/preflight/new Launch may use qualified B. Original A operation/login/Runtime/checkpoint references and package stay retained; source-pointer advancement is not revocation of an admitted A session.

| B connection / existing test anchor, not source GO | Current exact preimage |
| --- | --- |
| src/main/ipc/agentBackend.ts, captureDesktopRuntimeSources593–605 currently literal opencode | f173a19a246418d0c4dd62fa513966993d52bb66 |
| src/main/ipc/codexRuntime.ts | 116bd3001be3f872d0f47da253394a75927c0485 |
| src/features/codex-runtime-installer/main/adapters/input/ipc/registerCodexRuntimeInstallerIpc.ts | 080627b6ac8f91b8af48d79725308dc56d8e8062 |
| src/features/codex-runtime-installer/main/composition/createCodexRuntimeInstallerFeature.ts | 06c919fef1d2d63b411072f92a4a895fc556f15a |
| src/features/codex-runtime-installer/main/index.ts | ecf3d3a2d15e66e40a6fa71f4c73f2f49da65f24 |
| src/features/codex-runtime-installer/main/application/CapturedCodexRuntimeInstaller.ts | proposed new directly consumed adapter; exact responsibilities above |
| src/features/codex-runtime-installer/main/infrastructure/captureCodexNativeSelection.ts | proposed new static original-selection adapter; no native owner |
| test/features/agent-backend/desktopRuntimeSources.test.ts | f9899d88c28aa10f91887b470b56b8b23a33440c |
| packages/legacy-agent-host/tests/runtime-source-selection.test.ts | 70269120d2929044b38141ef6ec2f4611a409f11 |
| packages/legacy-agent-host/tests/runtime-source-native-identity.test.ts | 5bb419c418c07f1d8050e47afb1131a1903ec5e3 |
| test/features/runtime-provider-management/capturedCodexFeatures.test.ts | 93b251caf7f0a04fff04b3cb6339357875aba32b |

The B amendment must close original custom/PATH/managed precedence, unavailable/changed foreground or owner after each await, publication conflict, lost ACK and cold original lookup, and no re-spend on immediate UI invalidation. Extend the existing critical cases; do not create a parallel authority registry or a broad new installer test framework. If original custom-choice witnesses cannot be recovered through the existing Main composition, report that exact missing join before code rather than treating a stock managed status as proof.

### 25.6 Ordinary retained-A → selected-B Desktop follow-through

The acceptance must use ordinary Desktop controls against fresh private TEST projects and real pinned native packages. Existing source anchors are the Settings Providers route and CliStatusBanner0d811b6e5c980876b7eaca5846f459bdd61fe895:654–665/1372–1397, the existing CodexRuntimeUpdateDialog9126b7b907e3828261b0b5a6cb140547754d02a9, and the existing native Codex Desktop family: desktop-codex-resume-fixture.ts e8b351deb3184237ae2f0d9f40a3b0aabd5c3b65, desktop-launch-ui-smoke.ts6b819a2ec7060ad1ec93cda49ecd9320f849e877, desktop-codex-cost-ui-proof.ts and the original physical/cold helpers. Later unrelated published changes, including §61 child variants, must be composed rather than overwritten.

Required route: original ordinary Launch/input on qualified A; while A is retained, open the real Codex Update dialog and use its one install action; observe actual package verification and the original Host publication receipt for B; observe the existing metadata/model refresh against B; prove original A continues or settles its already admitted input and original Stop through its unchanged identity; ordinary fresh Launch on B must use B's new source/capture and real native effect; then the existing genuine Quit/Host/writer/child-absence boundary and cold read must retain the original A history/checkpoint/source bytes and current B selection. An A checkpoint is not silently resumed on B, and a new B session must not inherit A's native thread by a version/hash rewrite.

Do not invent a healthy same-version Repair button: current Codex controls primarily expose missing-runtime Install and available-version Update, and completed Update dialog hides its action. Phase A proves same-version invocation safety through the existing installer API tests; ordinary UI acceptance uses the actual available Update route. A future explicit Repair UI claim requires its own original-control evidence. Valid custom override/PATH fallback cases remain the source-priority acceptance boundary; no TEST store assignment may force an otherwise hidden action or replace user selection.

B's connected amendment must freeze one explicit mode in an already existing Codex Desktop lane, exact candidate/package hashes, native process/metadata custody, UI helper/fixture/inventory/CI preimages and one conserved input/request ledger before editing it. Preserve the existing default /cost, ONE→cold Resume→TWO and original permission/cleanup assertions; do not silently repurpose their counts or drop them to make room. Actual0.169 direct-D proof does not replace this Main/Host/UI route. No new job/matrix, timer/cap increase, native invocation, test-only mutation RPC or source eligibility change is authorized by this plan alone. A physically retained old executable, a clean model text test or a successful source receipt by itself is not the complete UI proof.

### 25.7 Review, publication and limits of the claim

Root and independent peer review the exact phase-A two-file candidate, its before/after filesystem assertions and the post-rename uncertainty behavior. Verify the full P06 prefix/readback, exact working-head preimages and existing size/type/lint/test gates. Root publishes normal reviewed commits; no active CI is cancelled or replaced. Phase A may proceed independently once authorized, while §§22/22.1 and B remain open.

A complete fix requires immutable retained packages **and** the later qualified original-source consumer/ordinary Desktop acceptance. Archive/dependency consumption, native protocol qualification, source review, synthetic filesystem verification and real retained-A/B behavior are separate evidence. Current source-only work claims none of the pending executions.

### 22.2 Codex connection notifications are typed native connection facts, not Session output

Status: PLAN ONLY; source0. This prerequisite is independent of installer/source eligibility. The F plan base is exact P06 full202905cf4362d3fa2d0721ca03b109e5fc6827fc; root may compose it with the separately frozen §25B append70cf83631ef34a4c299d55299d86ec0c7768e7c1 without losing either exact prefix. D source base is agent-teams-ai/old-provider-implementations commit68dca527b779ebb82923f30d7b08441085d8b579. Root is the only publisher and must recheck current D preimages before publication. No SDK/native version bump, F0.169 eligibility, installer mutation, new native run, TEST callback whitelist or relaxed count assertion is authorized by this plan.

#### 22.2.1 Actual failure and independently verified primary contracts

F parente29dbde300ea73ec4e46e5f57f9e007ca5473552, run43497088359/job132132912611, reaches the original native-codex-team candidate metadata path and fails readCandidateCatalog's2!==0 session-callback assertion. The existing closed observation says initialized/modelList/configRead completed, count2, overflowfalse; both events occurred at model-list, were unsupported_raw_event, and had no thread/turn. Their exact methods were configWarning and remoteControl/status/changed. Raw params were not retained by that diagnostic; this evidence does not prove either actual payload already satisfies the decoder below, nor that the rest of the0.169 journey passes.

D app-server.ts2f071c4e1af44ca2bca6a7b96e53699dd8712eca:223–242 routes only account/login/completed to a private typed connection observer. Other unbound notifications become onEvent unsupported_raw_event, including these two native connection messages. This is the source-proven routing gap; changing a TEST counter would hide it.

Exact official native source is openai/codex commitd32063f96c2dff1dc96af839b3952abb6acfeda4 (rust-v0.169.0):

| Primary contract | Exact source | Required meaning |
| --- | --- | --- |
| ConfigWarningNotification | schema JSON blobc89e42a2b45d90dd2de64baf3274ec001f9e0a0e | Required summary:string; optional nullable details/path; optional nullable range with required start/end positions, each line/column unsigned integer. No thread/turn identity. |
| RemoteControlStatusChangedNotification | schema JSON blob2f305c7d781f761cd1b1404701eed81b2657bee1 | Required installationId:string, serverName:string and status disabled/connecting/connected/errored; optional nullable environmentId. No thread/turn identity. |
| app-server/src/lib.rs1249–1310 | Exact commitd32063f, original connection state after initialize | On the first transition to initialized, native sends initialize notifications and the remote-control status to that exact connection_id. |
| app-server/src/startup_warnings.rs15–28 | Exact commitd32063f | Configuration warnings are sent to the specified original connections. Its separate send_warning32–38 uses the different warning method and is outside this correction. |

Primary URLs: https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/app-server-protocol/schema/json/v2/ConfigWarningNotification.json ; https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/app-server-protocol/schema/json/v2/RemoteControlStatusChangedNotification.json ; https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/app-server/src/lib.rs ; https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/app-server/src/startup_warnings.rs .

#### 22.2.2 Narrow typed decoding and connection ownership

Add one small codex-protocol connection-notifications module. It recognizes exactly the two complete method strings above and returns a closed discriminated union. A config warning retains its typed summary and optional details/path/range for its original native connection owner; a remote-control notice retains the exact finite status and typed installation/server/environment fields for that owner. These private fields never become a public Session event, conversation text, permission request, ready/auth fact, diagnostic payload or log message. Do not infer thread ownership from the current input, timing, active session, model-list phase or warning text.

Validate the original finite wire shape before consuming it. Required fields must be present with their declared types; optional nullable fields preserve absence/null instead of inventing a value. Range positions accept observed zero and require nonnegative safe integers, including all four original coordinates. Validate strings with finite bounds (summary/details/path and connection identity strings at most8192 UTF-16 code units each, with no NUL); preserve valid text verbatim rather than trimming it into a different warning. The existing maxFrameBytes/maxDepth/chunk limits still bound the entire raw message. No new queue, unbounded history or output budget is created.

The two decoder objects and nested range objects use closed known keys. In particular, any threadId/turnId/thread/turn/item or other extra field refuses; a known method with foreign attribution is not silently consumed as a connection notice. A malformed known payload throws only a fixed CodexProtocolError code such as codex.protocol.invalid-connection-notification, with no raw summary/path/identity/error data. The original CodexRpcClient.read catch/close path then preserves sent=unknown versus not-sent, rejects existing pending requests, aborts original server requests and seals existing sessions. It does not retry, reinitialize, kill a different child or claim native cleanup.

Add an optional onConnectionNotification observer to the existing CodexAppServerOptions, installed by the caller before the existing client starts reading. The new discriminated type can remain internal to the adapter and be inferred through that existing options type; do not add a new package export, transport/API family or public Session event. Freeze/copy the validated notice before invoking the observer. Validate first, then invoke this optional synchronous observer inside a bounded try/catch. A consumer exception is not malformed native wire and cannot close/seal the original RPC or Session, change readiness/permission/lifetime, trigger a retry, or emit private data. Do not add an asynchronous queue/history. The observer is notification-only: no return value controls RPC, permissions, readiness, login, source publication or process custody.

Route these exact validated connection notifications in CodexAppServerClient.notification before thread/turn dispatch. The original client must have begun its initialize operation; do not require handshakeComplete, because native can send these notices after its initialize response and before the client's initialized write finishes. A notice received before any initialize attempt is a fixed protocol refusal. After close, the existing RPC sealed state already prevents dispatch. A caller may omit the observer: validation still runs and only these exact two valid messages are consumed, with no manufactured Session event. Missing observer is not permission to consume malformed or unknown input.

Preserve account/login/completed byte-semantically, including its existing exact login observer/decoding. Preserve every other method's existing routing, including generic warning/error, thread/started, native turn/tool notifications, foreign/unbound events and unsupported raw events. The same method carrying a request id is still a server request handled by the original approval/unsupported-request path; it cannot evade request handling by resembling a notification. Remote connected/errored status is neither transport/process custody nor provider authentication. Configuration-warning text does not relax any later config/MCP/model/permission assertion.

CodexAppServerClient itself is the original connection owner; no PID, account identity or thread is reconstructed from the notice fields. The existing F metadata/driver code need not subscribe in order to avoid false Session events, and must retain its current strict native assertions. This is typed protocol support, not a TEST special case or an assertion that all native warnings are harmless.

#### 22.2.3 Exact source scope and existing tests

| Repository/path | Exact preimage | Planned change |
| --- | --- | --- |
| D packages/provider-implementations/src/features/provider-session-implementation/adapters/codex-protocol/connection-notifications.ts | new | Directly consumed finite typed decoder and immutable union only. |
| D packages/provider-implementations/src/features/provider-session-implementation/adapters/codex-protocol/app-server.ts | 2f071c4e1af44ca2bca6a7b96e53699dd8712eca | Optional original connection observer and exact pre-thread typed routing. Existing auth/turn/approval code stays unchanged. |
| D packages/provider-implementations/tests/features/provider-session-implementation/codex-protocol/metadata.test.ts | ac95dd3cc3e70518b486a6a024b131cde1b40c4f | Extend the existing finite real subprocess-wire metadata case: valid connection notices with observer absent still produce zero conversation/approval events and unchanged read-only native requests. |
| D packages/provider-implementations/tests/features/provider-session-implementation/codex-protocol/app-server.test.ts | a9c321b821a09c9ec82f5782a1889a771c407530 | Extend existing ordered-turn and transport-loss cases for typed observer isolation, unknown/scoped routing and independently reached malformed refusal. |

Existing TEST subprocess fixture61ad864f060ad5694a4877786791d138525b723a already supports an original notify command, so no fixture/transport source is needed. Keep existing test names/cases and original assertions. The valid observer case must prove exact immutable typed notices, no Session output/terminal/approval ownership change, and continued original A/B turn behavior. Include a throwing observer in that same existing case: both original turns and metadata requests still proceed, with no protocol-close, extra write or raw private error output. The absent-observer case must actually inject both valid methods over the existing wire and retain the current no-conversation-event assertion; do not replace it with a whitelist.

Malformed tests must separately reach required-field/type/null/range/enum/string-bound and extra attribution refusals. Pure decoder rows may extend the existing negative case, but at least the wrong-attribution and malformed-known payloads must reach actual original wire/RPC closure on fresh disposable clients, so an already closed first negative cannot mask a later case. Assert fixed private error code, original sent/queued acceptance, no observer success and no new RPC write. A distinct unknown method and the original generic warning must retain their former event behavior; a known-looking server request still receives the original unsupported response. No real provider, user credential, new native input or process outside disposable fixtures is used by normal tests.

#### 22.2.4 Delivery, qualification and B boundary

Read D AGENTS.md e57b42d71de52315f36fe071f6f1b82fbe041123: provider protocol belongs in adapters, consumer lifecycle/custody remains caller-owned, exact pnpm11.18.0 and CI Node versions, pnpm check before delivery, no package/release publishing. Prepare the four-file immutable source handoff only after root publishes this plan and gives source GO. Root and independent peer review the decoder/owner/lifetime/privacy and old code byte-preservation before root commits/pushes. Keep package names/exports compatible and source caps unchanged.

Run ordinary exact-head D checks and native CI under the existing workflow; if execution is unavailable, record source-only status and require normal CI rather than transferring an older PASS. Root consumes the official checked artifact through the normal archive hash/member/pin/lock recipe. Then rerun only the already-required original F0.169 candidate as part of its normal native lane, with zero unexpected Session callbacks and all catalog/permission/ONE/checkpoint/C2 resume/TWO/interrupt/cleanup assertions unchanged. The current raw notification payloads and subsequent native behavior remain unqualified until that actual gate passes. F eligibility/§25B source is still gated; this correction alone does not enable0.169 or claim the installer/retained-A→B UI complete.


### 22.3. Existing model-probe refusal case follows the typed connection boundary

**Observed failure, separate from native qualification.** D head `d6ca7005b2795293464a66b4d397ba35aafb5f91`, ordinary check run `43507160099`, Node24 job `132167697199` and Node26 job `132167697556` fail the existing `model-probe.test.ts:234` case. The Node24 original log records `PromiseRejectionHandledWarning` followed by `codex.probe.unknown` from `model-probe.ts:158`. No extra run is needed to infer that the test attaches a rejection handler too late: its exact source starts the probe, awaits fixture traffic and a synthetic terminal, and only then awaits the probe as an expected false result.

There are exactly three existing malformed `remoteControl/status/changed` notification inputs in that case: an extra foreign `threadId`, an unknown status string, and an array status. The published §22.2 decoder now validates these known connection notifications before turn dispatch, including when no optional observer is installed. Invalid native wire closes the original RPC; it must not become an ignored diagnostic or a successful/clean false inference result. The unchanged probe maps that original active terminal uncertainty to the exact `codex.probe.unknown` rejection, then performs its original captured-child disposal. Its production outcome and strict decoder are correct under the published plan and remain unchanged.

**Single-path TEST closure.** Extend only the existing case in D `packages/provider-implementations/tests/features/provider-session-implementation/codex-protocol/model-probe.test.ts`, exact preimage `eec75b0c37c1b8399000cea6232c9b2e80d7b41d` on the above head. Attach both fulfillment and rejection settlement handlers immediately when each original probe Promise is created, before any awaited fixture operation. The local tagged result must retain the original returned boolean or exact original error for the later assertion; it cannot convert a rejection to false, suppress a failed assertion or install a process-wide rejection handler.

Keep all original invalid input frames and the request-shaped warning control. For only the three enumerated malformed-known connection frames, require rejection by an Error whose message is exactly `codex.probe.unknown`; the existing original one-turn allocation and captured-child disposal must still each occur once. Observe this failure without supplying a later synthetic successful terminal to a closed connection. Every other existing foreign/malformed metadata, unknown notification and metadata-looking request must retain its original false-result assertion after the same original completed fixture terminal. Distinguish the three finite inputs explicitly in this case; do not accept arbitrary errors or permit false as an alternative to unknown. Assert one original `turn/start` and one original disposal for each path, with no second probe, queued input, retry, new timeout or additional fixture case.

**Acceptance and publication.** Production `model-probe.ts` (preimage `4f88fc479a18929c3781098fd3feab84af2c3ce5`), decoder, dispatcher, RPC cleanup, connection-observer isolation and all F assertions stay byte-unchanged. Root publishes this amendment before the source change; obtain independent source review and readback for the one-file delta. The original Node24/26 check, full existing source tests and ordinary native gates remain required. No skipped/quarantined case, timeout increase, broad reject acceptance or extra native experiment is authorized. Source review is not executed test evidence, and this test closure neither qualifies actual Codex0.169 payloads nor enables §25B publication.

### 25.8 Connected phase-B amendment: original selection, publication and retained A

Status: PLAN ONLY, source0. This appendix extends the exact published P06 full blob 202905cf4362d3fa2d0721ca03b109e5fc6827fc. Phase-A source30cb7adb915afc23d9ed8b17da91efe9c878e41a and existing testc80c75ab38768431b21e5069bd2dc279f35b90c2 are already published on all three working branches; their source reviews are not compiler/native acceptance. The source inventory below is resolved from parente29dbde300ea73ec4e46e5f57f9e007ca5473552; root's later P10 workflow-only update must be composed rather than overwritten. Root alone publishes. No B production, TEST, protocol eligibility or native experiment is authorized until this connected plan and the gates below receive explicit GO.

This amendment replaces §25.5's tentative static-only discovery with a source-proven bounded original resolver seam. Static status cannot preserve valid process/shell overrides and stale-override fallback by itself. It does not authorize an optional getStatus() native probe after an unrelated await, a new resolver registry, a fresh current/default choice during recovery, or treating the presence of any override as a permanently unsupported state.

Actual new prerequisite: parente29 run43497088359/job132132912611 fails the original0.169 catalog zero-session-event assertion before business input. The retained §22.1 observation has count2/overflowfalse, completed initialize/modelList/configRead, and two model-list callbacks: unsupported_raw_event/configWarning and unsupported_raw_event/remoteControl/status/changed, each without thread/turn. The count remains a failure. Official schemas and the D68 connection notification dispatcher must first receive a separate narrow reviewed typed-decode/connection-owner correction; a TEST method whitelist, ignored callback count, guessed harmless payload, or weaker session oracle is not a qualification. Full original §22 catalog/permission/input/checkpoint/Stop/cold proof remains required afterward.

### 25.9 Original authority and the concrete bounded resolver

Capture the original Main active composition, sender/context guard, descriptor/grant, operation kind and resolver inputs synchronously at the existing IPC entry before the first await. The frozen resolver inputs include process CODEX_CLI_PATH, the distinct cached-shell override, the shell snapshot identity and relevant values, original process/shell/merged PATH and PATHEXT, and the environment actually supplied to the original version probe. Do not refresh the shell in the middle of this operation or reconstruct a missing witness from a later status. Static managed-manifest reads and their identity are captured under that same admission; a subsequent install may change only the manifest to the exact B returned by this operation, never to a third observed package.

Reuse CodexBinaryResolver0f977829's original order: verified process override; distinct verified shell override; the original verified managed candidate; PATH in its original shell/merged/process order with its existing duplicate handling. Reuse the original path-like/PATHEXT and enriched-environment rules, actual execCli child/collector/cleanup and existing version timeout. Do not call resolve() and trust its disposable positive/version caches as a new captured proof. Add one private entry in this existing resolver which consumes frozen inputs and the original synchronous fence and returns a closed invocation-owned result. The ordinary resolver API, legacy caches, miss/stale-positive behavior and unselected frontend path stay unchanged.

The captured entry has one absolute resolution deadline using the existing 15000ms verification constant, captured before its first asynchronous filesystem/probe step; every original candidate probe receives only the remaining portion. Static candidate enumeration and hashing must check this same deadline. There is no per-candidate reset, retry, extra shell process or new cleanup allowance. The original ordered candidate set comes only from the frozen inputs; it cannot grow from a later environment read. A deadline or an unconfirmed probe cleanup is held, not proof that an override is stale. This captured-operation bound does not change the legacy resolver's timeout/cache behavior.

A nonexistent/non-executable candidate, or a genuine original launch failure with confirmed termination/no child, can advance to the next original candidate. A timeout, abort, output-unknown result, processTerminationError, ambiguous helper handoff or failure to establish the actual original child outcome stops resolution as held. Preserve the original execCli physical ownership rather than classifying an arbitrary error string as cleanup proof. A valid custom candidate wins even if acquisition installed B; a stale original custom candidate may fall through to the original managed/PATH choice only under the confirmed-failure rule. Before and after every await, recheck the original foreground/owner/environment witness; the final source read must still equal the captured expected revision.

captureCodexNativeSelection is only the static file/invocation part of this original resolver result: canonical selected path, regular file/executable shape, finite file bound, retained read-only descriptor, streamed SHA256 and original descriptor/path identity before/after. Preserve the original command and argv semantics. On Windows, the existing PATHEXT/npm shim/native adapter rules must be traced to the actual original invocation closure; a hash of a .cmd wrapper cannot be relabelled as the hash of the native executable. No generic wrapper execution framework or blind first-candidate substitution is added. This is an explicit implementation/qualification gate for supported Windows selection, while the first0.169 native tuple remains Darwin ARM64. The old legacy resolver remains available unchanged on its existing platforms.

Main's private captureDesktopRuntimeSources helper is the authority seam. Extend its runtimeId union to codex and pass its already captured synchronous sender/active guard to this concrete caller while keeping the existing source port and public IPC names. The resolver cannot independently authorize a grant. No new public path, generic management RPC, target selector, second process registry or global selection cache is introduced. Platform §66 may later change the underlying physical Main launch implementation; preserve that shared helper's original known-vs-unknown handoff semantics and compose its source rather than forking another launcher.

The before/after file and source checks are necessary observation fences, not a solution to §47/§50 executable mutation between verification and exec. That pre-exec stability claim remains separately unqualified. Neither a successful --version nor a matching hash proves a race-free future image or authorizes mutating a retained A.

### 25.10 A private read-only identity join and honest initial status

Current RuntimeSourceSummary has no executable path/hash witness, and an initial captured Codex summary has no cliVersion. DesktopBackendFeature's original descriptor captures grant/profile/config, not an original override-resolution receipt. Do not invent that existing witness, infer native version from protocolRevision, or label the resolver's B version as current A.

Add one optional SHA256-shaped nativeExecutableDigest to the existing private runtime-source summary, for Codex only. Compute it with one canonical pure function from the exact already validated original executable {path,sha256}: the seed when no record exists, otherwise that original selected record's native executable. Export the pure function through the existing runtime-sources contract module so Main and Host use identical bytes. It is a read projection only. Do not add it to stored RuntimeSourceRecord, publication input/fingerprint, management command receipt, owner/profile hashes, old checkpoints, or old serialized payloads. Existing old record/receipt bytes must remain identical.

The actual bounded resolver result may supply an initial current version only after its canonical path+SHA digest equals that original summary digest and the same full source summary/foreground/owner still matches after the await. Existing published cliVersion must also agree. A mismatching resolver candidate is not current metadata: retain the current source and wait for the explicit select/install publication path. Where current version is unavailable, leave it unknown; do not manufacture0.162 or mark a configured protocol as measured. Registry latest-version metadata is optional and display-only; errors cannot bypass the original source/current recheck.

This summary is already a private Main-to-Host surface; enforce the boundary in closed schemas and Main projections. CodexRuntimeStatus may add only closed captured-host/override presentation and the original sourceRevision needed for the existing UI's freshness semantics. No digest, native path, raw override/env, account field or command receipt is exposed in a new Renderer/preload field. Existing binaryPath is omitted on the captured branch. Existing frontend controls retain their normal loading/error/install/update behavior; no fake healthy Repair control is created.

### 25.11 One original acquisition and source publication, including progress and recovery

Use one concrete CapturedCodexRuntimeInstaller in the existing feature, with one bounded pending operation per original source and an original request fingerprint including operation, expected revision and captured resolver witnesses. Duplicate same-original invocations join that pending promise; changed source, intent or witnesses do not borrow it. The stock service remains the sole acquisition owner and keeps its existing installPromise. An incompatible concurrent captured/legacy acquisition cannot adopt another operation's progress or publication authority.

At entry read the original full current summary. Before any new acquisition or new resolver selection, use existing sources.recover() to reconcile one original unfinished Host command. Recovery uses only the durable saved command/candidate/grant, including native unknown debt; never replace it with today's managed manifest, environment, source pointer or new commandId. No retry loop is added. A held original cleanup stays held. The same original source/current guard is checked before acquisition, after acquisition, after resolution/hash, and immediately before publication; no re-read supplies a replacement expectedRevision.

Keep phase-A acquisition intact: original package selection/SRI/unpacked bounds, complete UUID sibling package, one staged verification and strict atomic current.json. The captured internal acquisition path returns that exact complete B/manifest result to its original wrapper. It does not make B current in Host. A valid original custom selection still wins after B is installed. A stale original override falls through according to §25.9, using only this operation's B as the managed candidate. On source/foreground conflict, retain A and complete B; no rollback/delete/prune or second acquisition.

Gate both result and progress. The service's current publish(status) sends state=ready/progress=ready immediately after current.json; that is too early for the captured branch. Route its acquisition progress through an invocation-owned internal sink established before the installPromise starts. Ordinary legacy broadcasting remains unchanged. Captured checking/downloading/installing may be shown honestly, but only the adapter may send the captured terminal Ready after the original source result is confirmed. No global mutable suppression toggle, second installer service or per-window alternate acquisition owner is introduced. If room is needed in the781-line service, extract only cohesive existing pure status/progress formatting into the declared helper; do not raise the800-line cap or compress unrelated code.

For a genuinely changed selected executable, create one commandId, retain the exact candidate and expectedRevision in the original pending operation, then use existing sources.publish(nativeSelection). Host's prepared journal precedes its native verification/publication as today. A lost response is resolved only by sources.lookup(the same commandId), or the existing cold recover of that saved input. Ready requires the original published selection, current full summary/identity and exact qualified version. It never follows package acquisition alone.

RuntimeSourceIndex322–349 hashes previousRevision, commandId, grant and candidate; even the same executable with a new commandId creates a different revision. Therefore immediate UI invalidate/refetch must not republish. First recover original debt. Then, when the bounded resolver candidate is identical to the validated current source identity/version and source kind, return that current selection without new source mutation; if an in-memory original command is retained, validate it with lookup. Cold current() already revalidates the original selected record/receipt through retainedSeed; use that durable record rather than inventing a new command when the cache is gone. The initial captured same-executable case can use its matched measured version without manufacturing a stored source publication. Any source-kind transition or changed executable requires the explicit original selection path.

GET/status is observation: it may use the bounded original-admission resolver to establish an otherwise unknown current version, and optional registry metadata, but it never acquires a package, publishes a source, replays input or starts a legacy app-server. INVALIDATE_STATUS preserves the existing explicit selection behavior when the original installed choice actually changed; when triggered by successful install it only reconciles that same completed selection. A failed current/native read cannot fall through to the legacy facade. A package left complete by a Main crash before any Host publication intent is not secretly adopted during GET/recover: a later explicit user selection is a new intent and may reuse the exact already installed complete package without another download, after all current guards.

After valid custom A survives an installation of managed B, the final status must describe current A and the actual completed acquisition accurately; it must not say B is selected or fabricate updateAvailable=false. Existing dialog detail/progress text can explain that the custom selection remains. This is not an error-based override disablement. Source publication is independent of retained A account/Runtime operations; their original binding, native process, command/checkpoint references and full package closure remain unchanged.

### 25.12 Finite native protocol eligibility and both profile projections

Do not widen0.169 eligibility until the original §22 actual candidate fully passes with the exact checked D artifact and the typed-notification prerequisite. The existing candidate is0.169.0 Darwin ARM64, official npm archive codex-npm-darwin-arm64-0.169.0.tgz,153831622 bytes,SHA256 d67d443253294438a21fde15753d7c1174e6a32147d842eb84428479d664c93d. Its already checked complete input-pins manifest supplies the actual native/helper/layout hashes; do not replace them with guessed constants or infer other OS/architectures. Existing0.162 eligibility remains unchanged.

After that gate, use exact finite protocol literals0.162.0 and0.169.0, with the new version admitted only on the actually qualified tuple. Apply the same finite helper before direct member and metadata native allocation, so a permissive schema alone cannot enable an unqualified direct seed. A declaration parser can represent both literals; allocation/selection still enforces the finite qualified tuple. No semver range, latest alias, SDK upgrade or automatic0.169 enablement on Windows/Linux is authorized.

RuntimeSourceQualification currently requires candidate native version equal seed.protocolRevision. Replace only that Codex rule with the reviewed finite old/new mapping. RuntimeSourceIndex.resolveRecipe and managementProfile must both derive protocolRevision from the exact verified selected native version. They currently clone the seed while changing the executable, which would falsely label B as0.162. The original seed/current A stays0.162; resolving an old retained source uses that record's original version, not today's pointer. Existing checkpoint compatibility remains strict: no opaque bytes, compatibility hash, native thread or source reference is rewritten to make A resume on B.

### 25.13 Exact production and existing critical-test scope

These are the complete proposed production paths; no generic installer framework, new registry or changes to the ordinary child_process owner are included. Existing child-specific variants must be composed from their current full preimages at freeze; the table is the parent source baseline, not permission to overwrite a child.

| Path | Exact parent preimage | Narrow role |
| --- | --- | --- |
| src/main/services/infrastructure/codexAppServer/CodexBinaryResolver.ts | 0f9778298640bfd421531e501386e26be99d1cf4 | One private captured-selection entry reusing original candidate order and probe owner; legacy API/cache unchanged. |
| src/features/codex-runtime-installer/main/infrastructure/captureCodexNativeSelection.ts | NEW | NEW: static canonical file/hash and original invocation witness; no child or publication owner. |
| src/features/codex-runtime-installer/main/application/CapturedCodexRuntimeInstaller.ts | NEW | NEW: original captured admission/pending promise, acquisition, source receipt and status/progress composition. |
| src/features/codex-runtime-installer/main/infrastructure/CodexRuntimeInstallerService.ts | 30cb7adb915afc23d9ed8b17da91efe9c878e41a | Captured internal progress destination and original acquisition result; preserve published phase-A immutable storage. |
| src/features/codex-runtime-installer/main/infrastructure/codexRuntimeInstallerPresentation.ts | NEW | NEW only as cohesive extraction of existing pure status/progress formatting needed to keep service <=800; no state, native call or extra owner. |
| src/features/codex-runtime-installer/main/composition/createCodexRuntimeInstallerFeature.ts | 06c919fef1d2d63b411072f92a4a895fc556f15a | Wire one existing service and private captured acquisition/progress facade. |
| src/features/codex-runtime-installer/main/adapters/input/ipc/registerCodexRuntimeInstallerIpc.ts | 080627b6ac8f91b8af48d79725308dc56d8e8062 | Existing three handlers choose original captured admission or unchanged legacy facade. |
| src/features/codex-runtime-installer/main/index.ts | ecf3d3a2d15e66e40a6fa71f4c73f2f49da65f24 | Export only the directly consumed Main composition entries. |
| src/features/codex-runtime-installer/contracts/dto.ts | 858d0b9e4e39a3be6a112641d2944680079e259c | Closed captured/override source presentation and optional sourceRevision; no executable identity digest/path exposure added. |
| src/main/ipc/codexRuntime.ts | 116bd3001be3f872d0f47da253394a75927c0485 | Create the concrete captured adapter and capture original resolver/sender witnesses before first await. |
| src/main/ipc/agentBackend.ts | f173a19a246418d0c4dd62fa513966993d52bb66 | Existing private runtime-source capture admits codex; expose its original synchronous fence to that concrete Main caller without a public RPC. |
| packages/legacy-agent-host/src/composition/runtimeSourceContracts.ts | a545390171c7674cea7116972bf55cabd18fb3a8 | One canonical executable identity digest function and optional closed private summary field; stored records/intents unchanged. |
| packages/legacy-agent-host/src/composition/RuntimeSourceIndex.ts | 397850fec1e4e25a24c29f77f10d357134609688 | Compute private identity summary from exact original source; finite Codex protocol projection in both recipe and management. |
| packages/legacy-agent-host/src/composition/runtimeSourceQualification.ts | 3b6d4abafd37c0677f5e4b32334b958416975c98 | Finite qualified version/tuple helper and original-source qualification, gated by actual §22 completion. |
| packages/legacy-agent-host/src/composition/runtimeProfile.ts | a1daa87f33aceeae3fe81d9d91217d89ed12bb8d | Exact protocol literals only; preserve old profiles. |
| packages/legacy-agent-host/src/management/profile.ts | e1af7fe25cd74a1c2710713853eaae729b81ed1a | Same finite protocol literals for metadata owner. |
| packages/legacy-agent-host/src/adapters/providers/CodexMemberProvider.ts | 888621ff837e6c308fd0b34ec6c33e03abaee2a1 | Apply finite new tuple admission before any new direct 0.169 allocation; old retained references unchanged. |
| packages/legacy-agent-host/src/adapters/providers/CodexManagementHost.ts | e721c8027f81fbf31e6fd956fd1f69c218a770af | Same finite new tuple admission for the original metadata allocation. |

The following existing test files provide the connected failure gates. Extend meaningful existing cases, not a parallel suite. Source-only review does not establish compilation, native operation or real update acceptance.

| Path | Exact parent preimage | Narrow role |
| --- | --- | --- |
| src/main/services/infrastructure/codexAppServer/__tests__/CodexBinaryResolver.test.ts | 1b832bd21cb985b68fb4a6532a0ca4408be413d5 | Extend existing priority/failure/cache cases for captured witnesses and clean-vs-unknown fallback. |
| test/main/features/codex-runtime-installer/CodexRuntimeInstallerService.test.ts | c80c75ab38768431b21e5069bd2dc279f35b90c2 | Keep A retention/fault cases; extend existing progress case for acquisition-only captured reporting. |
| test/features/agent-backend/desktopRuntimeSources.test.ts | f9899d88c28aa10f91887b470b56b8b23a33440c | Existing real captured source/IPC cases: authority, receipt recovery, current version join, cold no-op and private projection. |
| packages/legacy-agent-host/tests/runtime-source-selection.test.ts | 70269120d2929044b38141ef6ec2f4611a409f11 | Finite B recipe+management mapping; old A references/records and same-selection no-op. |
| packages/legacy-agent-host/tests/runtime-source-native-identity.test.ts | 5bb419c418c07f1d8050e47afb1131a1903ec5e3 | Original native verification/debt plus wrong-version/tuple/full identity refusal. |
| test/features/runtime-provider-management/capturedCodexFeatures.test.ts | ca5dd7f0ab993d175797a0e092438fc3a25cb8ef | Original account/catalog target remains A; fresh target follows B, no fallback or raw identity output. |
| test/features/codex-runtime-installer/renderer/CodexRuntimeUpdateUi.test.tsx | dcddba93f4c69d7d79baafa0798ce73772292a62 | Existing Update dialog case observes delayed Ready, original control and failure; no new repair UI. |
| test/renderer/components/runtime/codexRuntimeInstallAction.test.ts | e0ffa59bac4a95e2023763702431d8919a282661 | Existing success/refresh case proves one publication, and failed result cannot claim B. |

Resolver cases must distinguish valid process override, distinct shell override, known stale override→managed, known stale managed→PATH, captured environment/manifest drift, and unknown cleanup/deadline which refuses before the next candidate. Preserve all old cache/legacy tests. Include exact same path with changed file identity/hash; wrapper/native identity must not be guessed. Installer/IPC cases must reach acquisition completion while publication is still pending and prove no early Ready; original lost ACK lookup must produce one acquisition/one publication, and current/invalidation/cold reads must not create a second revision. A failure must retain A and B bytes and the original error/debt.

Host cases must prove both B member and management protocol0.169, all old A source/profile/checkpoint bytes unchanged, wrong version/tuple/identity refused before native allocation, and the new private digest absent from stored records and public Renderer status. Keep explicit foreign/missing grant and stale foreground refusals. Existing Renderer action case must preserve actual install→invalidate→refresh ordering without re-spending acquisition or publication. No failed fixture may pass because a previous negative already sealed the tested branch.

### 25.14 One ordinary retained-A/update-B Desktop proof, separately from the original default journey

Use the existing Darwin ARM Codex Desktop source job and its real Settings Update control. Keep its original default /cost, ONE→Stop→Quit→Resume→TWO invocation and all assertions unchanged. Add exactly one explicit source-selection invocation to that same job after the0.169 prerequisite is available; no new job/matrix or increased job deadline. The new invocation has its own original finite case deadline and must fit the remaining existing job budget. A timeout is a failed qualification, not a reason to enlarge either budget. The ordinary selected code path does not activate outside this explicit TEST option.

The new proof starts from the unchanged genuine0.162 A profile/native package and one captured original management/Team source. Reuse the existing real metadata/catalog preparation and private localhost model configuration. Stage the official complete B archive through the existing input-pin discipline as the expected-byte witness, but let the original installer use its actual official registry/network path. CodexRuntimeInstallerService30cb7adb has a fixed registry.npmjs.org URL and only a resolveLatestVersion dependency; it has no existing package transport injection. Do not invent one for this proof, substitute a stub executable, run package scripts, change a global registry setting, write a managed manifest directly or add a production registry URL flag. Before the Update click, require the real advertised root/platform metadata and selected package to equal the already qualified0.169 pins. Drift before the action refuses that attempt; drift after the action preserves the original qualification/publication refusal and is a failed journey, never rewritten metadata. After acquisition require the full actual B closure and source identity to match the official expected input pins.

Two business inputs only, using one conserved model ledger: A ONE retains its existing eight inference rounds/seven tool operations; fresh B TWO uses the existing three-round/two-tool chain, with an explicit fresh-session oracle requiring absence of A's prior native thread/tool context. Total business HTTP requests are exactly11, plus exactly the two ordinary Launch model probes, both inside the existing probe cap8. The original default resumed-TWO prior-context assertions remain unchanged in their mode. No counter reset, hidden model turn, retry, native Send replay or extra permission/Stop input is allowed. Preserve each existing native request/output/MCP receipt and effect-file check.

Hold only A's original final HTTP response after its real native tool/receipt chain has reached that original request. While that original A process/input remains retained, use the actual Codex Update notice/dialog and one existing install action. Observe actual package verification, then the original source publication and actual B metadata refresh. Release that same A response once; require A's original terminal/reply and ordinary Stop using A's unchanged binding/path/birth/native thread. This demonstrates continuation across B selection without a third input. A model-side held response is a TEST timing stimulus, not a synthetic Host completion.

Use the ordinary Fresh Launch control for B after A is genuinely stopped. This is source-proven in the existing dialog: LaunchTeamDialog5fd3c0b8 initializes continuationMode='fresh'315 and resets it798; HostTeamResumeSectione885a05c exposes #launch-continuation-mode with the real Fresh Launch/Resume checkpoint options; useHostTeamResume5f202c7f permits fresh preflight only after original unresolved restorations are excluded. useLaunchDialogRosterSubmission4a6b0865 invokes props.onLaunch for that original fresh branch. Existing desktop-relaunch-ui-smoke90649db6 already uses the reopened prompt and the actual Launch team control, checks a distinct capture/native conversation and restoredFrom absent. Reuse those concrete control/identity rules in the new Codex-specific helper; no product dialog changes or mutation IPC. Require B's current source revision, profile protocol0.169, actual original executable/hash from the acquired complete B and a new native thread; the original TWO tool/receipt/effect sequence must complete under that B. Then use the existing genuine Quit→original app group/Host/writer/native-child absence→same-profile successor boundary. Cold read must retain original A history/source/checkpoint bytes, B's current selection and B's new history, with zero cold business input or automatic Resume on the wrong version.

Physical custody includes the original A and every original metadata/preflight child, not just the current runtime or one PID with the Codex basename. Reuse original captured executable/birth and Host/group evidence, recording all observed preflight/catalog children before the runtime starts. A completed management journal alone does not prove a native child absent. At the cold boundary require all original matching births plus no unmatched same-selected executable child; keep original immutable package/config/source records and the existing held-unknown behavior. Do not select a fresh numeric PID to mutate or subtract an unproved metadata process.

These are the proposed existing-lane integration paths. They are connected acceptance work, not optional debt; the actual typed-callback/protocol gate and concrete official-package/control checks above must be satisfied before their source GO. Shared smoke/fixture/CI variants and exact latest workflow preimage are root-composed.

| Path | Exact parent preimage | Narrow role |
| --- | --- | --- |
| scripts/legacy-agent-host/desktop-proof-mode.ts | e8ffd6f121cec23ac78d0249d0e6129ad1c18265 | One explicit source-selection option in the existing Codex source journey; default mode unchanged. |
| scripts/legacy-agent-host/desktop-codex-resume-fixture.ts | e8b351deb3184237ae2f0d9f40a3b0aabd5c3b65 | Reuse exact A recipe and actual initial catalog; add finite official B staged package input and source-selection preparation. |
| scripts/legacy-agent-host/desktop-codex-source-selection.ts | NEW | NEW: one directly consumed ordinary UI Update/A-stop/B-launch/cold proof. |
| scripts/legacy-agent-host/desktop-launch-ui-smoke.ts | f22ca3fc2296bcdebfe20241268aaabc5710b669 | Narrow original-input handoff/callback needed by this explicit mode; default /cost/resume path unchanged. |
| scripts/legacy-agent-host/desktop-backend-smoke.ts | 256530edb7a0e06bc06b1c14cc9ebd8dd7f51ee9 | Select the explicit proof and retain its original source/physical/cold receipt; preserve all child variants. |
| packages/legacy-agent-host/tests/fixtures/native-codex-team/model.ts | ce78873626e2a0aa59ee91556dfd890d6378e719 | One mutually exclusive TEST source-selection scenario, existing ONE/TWO tool chain, held original A final response and fresh B context oracle. |
| packages/legacy-agent-host/tests/fixtures/native-codex-team/model.test.ts | 355d1b402f36cec580df52a8f3a94bf84f7706c8 | Extend the existing native request scenario case; preserve default prior-context and first-failure negatives. |
| scripts/legacy-agent-host/desktop-codex-resume-fixture.test.ts | 671c0929756fd1d7153ef5829e71c74f4c2866b0 | Existing fixture case retains default pins and verifies explicit finite B input selection. |
| scripts/legacy-agent-host/desktop-proof-sources.ts | ee554279a5388d33585f5bff9ec4fc15f5f31aca | Add only the new directly consumed helper and preserve all existing frozen sources. |
| .github/workflows/ci.yml | 6f526607d3416584a936b838ba03108e4ae64e30 | Root-owned existing Codex Darwin ARM source job: retain default invocation and add exactly one explicit source-selection invocation within original job deadline. |

desktop-codex-cost-ui-proof.ts b690c535a7482beb75abd090ca90bfc76ba7f95d, desktop-resume-ui-smoke.ts1a21e95f73196616ef79e60fa7877b8d79fa6595, desktop-captured-app and source-freeze remain original custody/control dependencies, not blanket edit authority. Any necessary additional helper path, changed case count or production TEST transport hook requires a bounded amendment before source. No release-package/default-platform claim follows from this one source job.

### 25.15 Review and staged GO

First review this complete connection and exact private-identity boundary. Next finish the separate typed0.169 connection-notification correction and the unchanged actual §22 gate; root consumes only the official checked exact D archive and normal pin/lock path. Only then authorize the finite F protocol/installer source slice and its existing test extensions. The UI slice follows one coherent compiled dependency/source cut with its exact official package and original control/custody witnesses frozen. This sequencing keeps all of B mandatory while avoiding source that falsely enables an unqualified version.

Required checks are the existing resolver/installer/source/account/UI cases, canonical Host/Main/script/test types, fast lint and unchanged source-size caps, followed by the original native candidate and actual retained-A/update-B Desktop journey. Preserve original default /cost/resume gates and every active CI run. If execution is unavailable, prepare/review immutable source only and let ordinary exact-head CI run the required gates; do not transfer earlier source/OS/installation PASS. Root is the sole publisher, all preimages/readbacks/child compositions must be explicit, and §47/§50 pre-exec stability remains an independent open qualification.

### 22.4. Consume the checked connection-notification package coherently

**Review 1 — original checked bytes.** D commit976905403b40078c3c2cfae3c442d5ec91056fc2, tree314dc396b2f49fbc588421040e80fa7d15fa35a4, has successful [source/packed-consumer CI43510761520](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/43510761520) and all53 jobs of [native43510761545](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/43510761545). It contains §22's typed Codex connection notification handling and §22.3's existing malformed-notification test correction. Official checked artifact14078576670 is185401 ZIP bytes with SHA256 f6c7f2a5d609e9ddf651b4cccffd83c7027e3d37c4560613e3d6a8537aaf90d9. Its provider TGZ is178265 bytes, SHA25673dbbfba5e8fed6719ccdeaae499a47284b72ac831c33a2c7206fbf2799f77b8 and SHA512 integrity eSYYzVEIXTHDPR7Mou+/ff7YlnEOS7nwJHt6knLer1Zb1Qv+Nvnp4xhMsjJRjpnIJwiTFTQvHQ3wq/xreFWtJw==. Download and verify those original bytes; do not locally repack or publish a package. The original receipt's source-and-packed-consumer-only qualification and false Host/Electron flags remain unchanged. Native OpenCode success does not qualify Codex0.169 or the application.

**Review 2 — exact consumer and lock scope.** Add vendor/provider-migration/codex-notifications-97690540/{agent-teams-provider-implementations-0.0.0.tgz,checked-artifact-receipt.json,source-receipt.json,README.md}. Retain the original CI receipt bytes and record exact source/tree, source-check jobs, native run, ZIP/TGZ identities and explicit pending frontend qualification in the separate provenance. Keep the historical archives and the canonical contracts bytes; the checked contracts TGZ remains6220 bytes/SHA256aaf9506473f6a2868a375a6087e1b4edc561b38f34101ef7a8703a73bb2674db.

Update only the active file dependency in packages/legacy-agent-host/package.json, its five existing locators and one integrity in pnpm-lock.yaml, and the original SHA/path assertions in .github/workflows/ci.yml, packages/legacy-agent-host/tests/native-codex-team.native.ts and packages/legacy-agent-host/tests/native-claude-host.native.ts. All other dependency versions, peer snapshots, contracts and prior donor hashes stay exact. First compare complete old/new package metadata, then generate a normal isolated packed-consumer lock record with the repository's pinned pnpm11.22.0 and validate that record against the proposed main-lock stanza. Require an inverse comparison back to the complete old lock; no broad dependency re-resolution, disabled hooks or manual invented integrity. Compose each workflow with its existing native/qualification variant and pending §66 helper prep; never replace one branch's full workflow with another.

**Review 3 — original frontend acceptance.** Publish/review this appendix before the nine-file consumer delta; publish the coherent pins only after their source/byte review. Require normal frozen installation, existing source/types/Host tests, exact archive-to-installed-dist equality and the original Codex0.169 gate before the existing Darwin Desktop Resume scenario. Claude old-checkpoint and OpenCode native regressions remain required, with original input counts, deadlines, approval/Stop/cleanup and cold replay checks. A working-branch source update is not an upward PR merge or a completed native result. P06§25B implementation remains gated on the actual0.169 frontend proof.


### §22.5. Consume the checked B1 terminal-classification archive

The source correction specified by P05 §16B/§16B.1 now has a checked immutable candidate: D commit `002db02a255c532adf43ee12cf5ed56a3e6d6f5b`, tree `3f84051ada26be0daa581f14366a570766e4eacf`. Its [source/packed CI](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/43523252960) passed on Node 24.21.0 (job132222526249) and 26.11.1 (job132222525824), with pnpm11.18.0. The separate [native run](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/43523252663) completed all53 jobs successfully. Those results qualify D; the application's Host, UI and packaged journeys remain pending.

**Round1 — exact artifact and unchanged package graph.** Original checked artifact14083322711 is186311 bytes, ZIP SHA-256 `a2c5039ad1e74ff708a7892584792ce2d55b81e5c51f49a64701ffb2c4e2a272`. Its provider archive is179177 bytes, SHA-256 `ae1a7f4063d893e0d76f509971d3940ee0a37902fbdf752a737d9c88390d6d8d`, Git blob `c1e181dfd3948c4da94303324b50954decd2cd9b`, SRI `sha512-OB+TqAcVd7SkxJO26FgJycwybBeHIHA1ElbyqXD17W30dFsUqLgc+y/SWXrwnVZzHvPMZlnXExzD2EOh/qMBSA==`. Compare the complete raw package.json against consumed97690540, all archive member names and changed bytes, and the original receipt's commit/length/digests. Metadata must remain byte-identical; only the reviewed OpenCode terminal-classification compiled files change. Contracts remain the original byte-identical6220-byte archive, SHA-256 `aaf9506473f6a2868a375a6087e1b4edc561b38f34101ef7a8703a73bb2674db`. Keep that canonical contracts pin and all historical archives.

**Round2 — one existing consumer replacement.** Add only the checked provider archive, unmodified `checked-artifact-receipt.json`, provenance `source-receipt.json` and README under `vendor/provider-migration/opencode-local-readiness-002db02a/`. Update the existing dependency locator in `packages/legacy-agent-host/package.json`, generate `pnpm-lock.yaml` with canonical pnpm11.22.0 in the full workspace, and update only the existing current-provider digest/path pins in `tests/native-{claude-host,codex-team}.native.ts` and `.github/workflows/ci.yml`. Root checks all three branch preimages, retaining qualification's own workflow. The lock delta may contain only the original five provider locators and one SRI; all transitive versions, peers, snapshots, metadata and supply-chain decisions stay unchanged. Do not rewrite package metadata, skip policy/patches, build a substitute archive, relax a native assertion or retarget historical migration/installer fixtures.

**Round3 — application qualification.** Root and an independent peer review this append, the original archive and final exact consumer delta. Root commits and immediately pushes with expected-ref/readback checks. Use the existing fresh canonical frozen node-ci installation, verify all installed provider JavaScript against the original checked archive, then run the existing Host build/types and affected existing cases. The next required original F native/UI jobs must run against these exact bytes, including both authless B1 cases and existing Codex0.169/Claude/Desktop Resume assertions. No new suite, native invocation, retry, deadline, matrix, public DTO or dependency policy is introduced. B2 allocation authority remains inactive until its separate reviewed implementation and evidence.


## 26. Codex 0.169 candidate: consume its original Responses Lite tool palette

### Review 1 — exact failed candidate and native format

The original parent0543d437695318f0157e6d600d76abdce5c51e8e Main43527759884/job132237640715 fails inside the required native0.169 candidate before the Desktop Resume application starts. Artifact14087861467 is10519 bytes with ZIP SHA256 bc443388f3164bd54ba58b2b047edfb8293a1f8ab6f075b4794c61de04dc1208. Its22400-byte receipt has SHA256 06f84351c4ac9a313dcadd0be0932e578a02003f6b0e5654606ac175e3682616. Native initialize/model-list/config-read complete, the actual catalog selects gpt-6.1-sol, and C1 reaches native MCP-ready with the six original Team tools. The first original ONE inference has effective context but the TEST reader observes an empty body.tools list and rejects task_create. No C2, checkpoint, Desktop or successful native eligibility is claimed.

The exact official rust-v0.169.0 source at [d32063f96c2dff1dc96af839b3952abb6acfeda4 client.rs](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/core/src/client.rs) places tools in the first developer additional_tools item and omits body.tools for use_responses_lite. The same commit's [models-manager/models.json](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/models-manager/models.json), blob489ebe3f2483348641a16160ce8491dd077eabca, marks this selected model use_responses_lite:true and tool_mode:code_mode_only. The failed receipt did not retain raw request bytes: this diagnosis is supported by exact native source and the observed empty old field, and the next original gate must establish the actual full request/result path.

F already has a strict reader for this format in tests/fixtures/native-codex-team/responses-ui.ts (b5683a221081a4a32b42778019fc3c4a5b44fcab). It validates one first developer additional_tools declaration, its native identifier, no simultaneous body.tools, actual namespaces and at most one valid Lark exec executor. It binds results to each exact original issued call, handles native code-mode return shape, checks MCP text/structured receipts agree, rejects resumable shell results, and verifies original cold call/output history. Do not invent a second decoder or choose another model.

### Review 2 — connect the existing strict path, retain the same actions

Source scope is only packages/legacy-agent-host/tests/fixtures/native-codex-team/model.ts (ce78873626e2a0aa59ee91556dfd890d6378e719) and the existing packages/legacy-agent-host/tests/codex-responses-ui.test.ts (83a4569c1d527aa8751ab4b64d60946712fa3cf8). Enable the existing uiPalette path for candidate169 as well as the already supported UI scenario. Its existing issued/linkedOutput, codeModeCall, codeModeResult, codeModeReceipt, commandExit and originalCallIds branches then handle the actual native declaration. Direct function palettes remain supported by that same strict reader.

Remove only the now-duplicate candidate-only shell-result parsing that blindly selects the last function_call_output and forces codeMode:false. The common palette branch must still check exactly exit7 after ONE's original shell and exit0 after TWO's original shell, and expose the same toolResultError fact. Keep the candidate's original model equality, finite ONE/TWO bounds, seven original history IDs, final held response and all native action arguments unchanged. Each code-mode script still selects exactly one original named native action from ALL_TOOLS and invokes it once; no assumed successful receipt, synthetic tool, foreign result or added action is permitted.

Reuse the existing positive Lite ONE/TWO test with a candidate variant, preserving the current UI variant and every negative decoder/linkage case. The candidate variant uses its normal exclusive candidate169 options, default bob principal, actual chosen-model equality, original7+2 actions,8+3 requests, one-shot permission arguments on the ONE command, seven linked retained history IDs, and the same deliberately held final response with abort cleanup. Retain the existing direct-function candidate case in model.test.ts unchanged and run it as a regression. The TEST tools validate protocol scripting only; they cannot attest native permission, child custody, cold restoration or version eligibility. No additional test file, collector, workflow, model probe or native invocation is introduced.

### Review 3 — actual qualification remains the prerequisite

Publish and independently review this plan before source. Root and a peer review the two exact deltas; run existing Host test types, the affected existing model/Responses tests and the source-size guard. Then use the same required native0.169 candidate before the same Desktop cold Resume gate, with unchanged deadlines and input counts.

Native acceptance still requires the actual original model catalog and six MCP tools; original ONE8 requests and TWO3 requests; two original business inputs; one actual approval before the ONE effect with exact original command/CWD; failed shell exit7 and tool-result error; original checkpoint bytes and thread identity; no TWO effect on restore; exact ONE/TWO file bytes; the held original response followed by an actual interrupt/cancel terminal; and original child/Host close and confirmed physical drain. All provider/executable/archive pins and required capabilities remain unchanged. P06§25B resolver/installer implementation remains gated on that successful actual proof. D's native success, decoder tests or this source change cannot substitute for it. Push each commit immediately; no main merge or replacement of an active live PR head.


## 27. V1 version runner: validate the producer's explicit unqualified coordination field

### Review 1 — a successful original native journey rejected by its receipt schema

Parent0543d437695318f0157e6d600d76abdce5c51e8e V2 workflow43527760087/Linux static job132237640286 completes its first actual V1 version journey, then fails in verifyNativeV1VersionReceipt with exactly one unexpected top-level key: coordination. Original artifact14090755217 is1902 bytes; ZIP SHA256 eec5ae48a7d705cba6fe6fc1f77a639c962ab181e345fce35d1188109dc7c770. The original native-v1-1.19.4.json is4479 bytes, SHA256 27438daaa1e9ee7cabbca62fc775522f56124b12402f8819efe37ed856fd03a9. Its existing native steps are complete, both original Hosts exit0 with valid stdout, cleanup is true, and exactly8 ordinary model requests are recorded. Its managed update changes1.19.4 to1.19.5 while preserving the exact before/after original pending session and process evidence. The overall runner failed before subsequent selected versions; no all-version, Desktop, vendor or release qualification follows from this first receipt.

The producer opencode-v1-version-host.native.ts (add047a727ecb04fdb57eb7aec9dcc15fe227425) always emits coordination. For this runner's active-update baseline the existing qualifyCoordination condition is false, so that field is exactly {status:'unqualified',cleanup:null}. The separate native coordination scenario has different steps and is not part of this receipt verifier's present contract. The version runner27d0ce8d8972cee4b23030b4173108c37460f322 passes the exact expected source/build/update identity to the verifier; keep that path unchanged.

### Review 2 — one closed field, no broader qualification

Change only packages/legacy-agent-host/tests/opencode-v1-version-receipt.ts (04b44e5bc852101e0d94630b5fc3049db2601be9) and its existing opencode-v1-version-receipt.test.ts (3ac8a7305743313336513987f5be45e1ddd8bccb). Add coordination to the required exact top-level key set and require deep equality to the producer's exact unqualified/null object. Missing values, claimed PASS/cleanup:true, additional nested diagnostic data or another shape must fail. Do not make it optional, allow unknown keys, remove the producer field, strip receipt data, qualify native coordination here or broaden the accepted stage list.

Update the existing positive fixture with this same field. Extend the existing missing/mismatched-field table and existing unknown-diagnostic case to retain rejection of missing, falsely qualified and extra nested coordination data. Keep every existing source/version/integrity/build/native/model-count/preferences/Host-exit/managed-update assertion and every prior negative test unchanged. No native producer, registry selection, dependency, installer, timeout, action, invocation or workflow changes.

### Review 3 — verify the original scope

Publish/review this plan before the two-file delta. Root and an independent peer compare the failed original receipt with producer, runner and consumer. Run the existing receipt tests and Host TEST types; retain the existing source-size gate. Then the same ordinary version runner must complete its original full sequence on the new head. Reading the original successful first receipt or passing synthetic receipt cases does not make the failed workflow green. Commit and immediately push, preserve active live heads and do not merge main.
