# 08. Windows: полноценный Host runtime для Claude, Codex и OpenCode V1

Статус: broker-backed Windows launch и интеграция `WindowsCapturedProcess` частично реализованы.
Actual Claude SDK scoped Stop прошёл на Windows x64/ARM64: head `dde51b477db6a41fc4d69ab6fbe1e10f6db3e5e2`,
run `43372037195`, jobs `131709784668`/`131709784742`. Это provider/subtree proof;
Main-retained owner, обычные register/Processes, same-Main cold recovery и полная Desktop-приёмка ещё не завершены.
Их следующий согласованный source cut описан в [09, §38](09-cross-platform-processes.md).
Codex/OpenCode не получают qualification по Claude receipt; документ не объявляет Windows parity завершённой.
Область: сохранение существующих Windows-возможностей приложения в Stage 1.
Main не сливается; переключение основного backend и Stage 2 в эту работу не входят.

## 1. Зафиксированные исходные версии

- Actual main: `4a0e06277fe216d9f82dbbede362668fe46622ee`.
- Stage 1: `1d0f97f55de566036c970eab4f36b84620afdb3f`.
- Проверенный Stage 1 source tree: `ec540290c86af9755c94e52ac795aeda8586a98f`.
- Все ссылки ниже закреплены за этими commits; состояние внешних CLI после них не предполагается.

| Поведение | Actual main / существующий oracle | Stage 1 gap |
| --- | --- | --- |
| Create/Launch выбирает provider и запускает его в выбранном проекте | [LaunchTeamDialog](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/renderer/components/team/dialogs/LaunchTeamDialog.tsx), [CreateTeamDialog](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/renderer/components/team/dialogs/CreateTeamDialog.tsx) | Общий native profile принимает только POSIX cwd/executable |
| Windows CLI: `.exe`, поддержанные npm/Bun shims, `.cmd/.bat`, пробелы/не-ASCII | [childProcess](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/main/utils/childProcess.ts), [Windows oracle](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/test/main/utils/childProcess.windows.test.ts) | `CapturedProcess` запускает exact executable напрямую, без Windows launch recipe |
| Stop/timeout/cancel завершает запущенную работу и дочерние процессы | Тот же `childProcess.ts`: `killProcessTreeAndWait`, Windows cleanup | Без tree source завершение Windows parent не считается cleanup; source подключён к V2 |
| Профиль/домашние каталоги сохраняются при повторном запуске | Existing launcher передаёт рабочий каталог и окружение | Claude/Codex/V1 имеют POSIX ограничения HOME/config/native paths |

Stage 1 evidence:

- [nativeProcessProfile](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/composition/nativeProcessProfile.ts): cwd/executable `startsWith('/')`.
- [runtimeProfile](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/composition/runtimeProfile.ts): отдельное расширение только V2; V1 сохраняет POSIX validation.
- [CapturedProcess](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/adapters/providers/CapturedProcess.ts): исходный child, sealed admission, injected tree source и conservative Windows cleanup.
- [WindowsJobCustody](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/adapters/providers/WindowsJobCustody.ts): уже есть handle/Job ownership, loader связан с V2 embedded graph.
- [V2 EmbeddedServer](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/adapters/providers/OpenCodeV2EmbeddedServer.ts) пишет private startup frame после custody; [V2 EmbeddedChild](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/adapters/providers/OpenCodeV2EmbeddedChild.ts) импортирует engine после frame. Это Bun child; переиспользуется принцип gate.
- [legacy-host.lock.json](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/legacy-host.lock.json) и [stage-node](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/scripts/legacy-agent-host/stage-node.ts): bundled Node 24.21.0 уже закреплён для Windows x64/ARM64.

Основания R3: Microsoft [Job inheritance](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects),
[nested Job breakaway](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs) и [ненаследуемый Job handle](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-createjobobjectw);
Node 24.21.0 [stdio/IPC](https://nodejs.org/download/release/v24.21.0/docs/api/child_process.html#optionsstdio),
[startup options](https://nodejs.org/download/release/v24.21.0/docs/api/cli.html#node_optionsoptions) и [uv_spawn source](https://github.com/nodejs/node/blob/v24.21.0/deps/uv/src/win/process.c).
Source подтверждает `CreateProcessW`; разрешающий Job libuv не отменяет внешний Job Host без breakaway.

## 2. Результат для пользователя и границы

На Windows x64 и ARM64 пользователь выполняет прежние Create → Launch → Send/tool →
Stop → повторный Launch/Resume для каждого заявленного provider profile.
Путь с пробелами/кириллицей и прежний поддержанный installed launcher не ломают этот маршрут.
Настройки, credentials, MCP и tools попадают в тот captured профиль, который выбрал пользователь.

Этот план владеет запуском, captured launch recipe, окружением и cleanup native дерева.
План 06 владеет обнаружением/установкой/обновлением и публикацией нового provider profile.
План 07 задаёт provider config/MCP/extensions; здесь сохраняется их точная передача процессу.
План 09 владеет регистрацией фонового service, его identity, health/history и Processes → Stop.
План 10 собирает итоговую Desktop-приёмку; сценарии ниже становятся её входными доказательствами.
Код общего Windows Job loader учитывается здесь один раз; план 09 его переиспользует.

Не добавляются новые платформы: Linux ARM64 исключён до отдельного подтверждения baseline.
Darwin x64/ARM64 и Linux x64 сохраняют прежние маршруты и получают ограниченную регрессионную проверку.
Наличие binary для OS не заменяет доказательство его запуска и поддержанных функций.
До реализации составить короткую таблицу provider × Windows arch × исходный launcher:
заявленный в actual main маршрут получает обязательный successor, с точной версией и видом поставки.
Нельзя расширять обещание на отсутствующий у provider binary или исключать работающий baseline по результату нового preflight.

## 3. Acceptance до начала реализации

1. Native Launch реально выполняет хотя бы одну provider operation и tool/MCP effect, а не только `--version`.
2. Приложение принимает прежние поддержанные Windows launcher/path cases; отказ не выдаётся за parity.
3. До первого provider input зафиксированы executable bytes, immutable argv prefix, cwd, env и native ownership.
4. Stop/cancel/launch failure завершают именно своё дерево; другой provider/team и соседний TEST process живы.
5. Parent exit, terminal metadata или пустой UI не считаются завершением дерева.
6. UNKNOWN не превращается в success по timeout; последующий запуск не присваивает старое дерево.
7. Cold restart не повторяет доставленный input; Resume возвращает выбранную native историю.
8. Поставленный Host работает без checkout, ambient system Node и случайного native module из PATH/cache.
9. Общие path/profile изменения сохраняют исходные bytes, digests и binding старых Darwin captures;
   прочитать старую запись не означает нормализовать её или перепубликовать под новой identity.
10. До Job admission provider/plugin code и его descendants не исполняются.
    Broker/launcher identity не выдаётся за actual CLI identity; provider stdin открывается после установки authority.

## 4. Минимальное решение и повторное использование

Первый implementation slice: существующий broker core вынесен в Host package, Main paths переэкспортируют его.
Host build, tooling typecheck и **45 existing protocol/gate tests PASS**. Wire/native behaviour не изменялся;
SDK facade, product wiring и Windows/native qualification остаются следующим срезом.
Второй срез добавляет structural SDK facade и сценарий в existing native gate: **5 facade + 45 protocol tests PASS**,
Host build/tooling typecheck PASS. Проверка Windows x64/ARM64 запускается отдельно на опубликованном SHA;
Node 24.21 добавлен к существующим Node 26/Electron gates. Provider wiring ещё не завершён.

Сохраняется `CapturedProcess` и существующие provider adapters; новый supervisor/framework не вводится.
Предпочтительный кандидат после дополнительного R3 — существующий atomic owned-process broker с его target stdio;
альтернатива gated Node bootstrap ниже остаётся только для доказанного несовместимого launch shape. Новый native protocol не создаётся.
Windows Job kernel/custody и existing broker qualification переиспользуются; окончательный выбор фиксирует structural SDK/native gate.

### 4.1. Пути и launch recipe

- Общая проверка native path выбирается по captured OS tuple, а не по строке, присланной renderer.
- Перенести применимые правила из `openCodeV2StaticPreflight.ts`; V2 больше не держит отдельную копию общего правила.
- Canonical executable/directory проверяются на native Windows; casing, junction и drive semantics не угадываются на Linux.
- Перед ужесточением UNC/device/alias rules снять actual-main census; поддержанный baseline path получает successor/test.
- Known npm/Bun shim разрешается в конкретные runtime/script/argv; содержимое shim и целевые bytes входят в capture.
- Для поддержанного opaque `.cmd/.bat` сохраняется узкий captured shell recipe и существующие escaping rules.
- Не допускаются динамический PATH lookup после capture, склеивание пользовательской shell-строки или автоматический новый executable.
- `CapturedProcess.launch` по-прежнему проверяет exact admitted recipe; provider request не меняет interpreter/argv prefix.
- Captured HOME/USERPROFILE/config/TEMP и Windows env casing согласованы; required provider credentials не теряются от нового allowlist.
- Secrets не пишутся в receipt; фиксируются только имена разрешённых полей и редактированные fingerprints.

### 4.2. Одна Windows custody

- Выделить проверяемую Windows native dependency selection из `OpenCodeV2EmbeddedGraph` в общий loader.
- Existing broker владеет своим atomic-created Job; existing `WindowsJobKernel`/custody сохраняют нынешний V2 route.
  Одна allocation имеет одного cleanup owner; не назначать ей второй параллельный Job owner и не дублировать broker protocol.
- Shared verified dependency/artifact loader переиспользуется; потребители не выбирают произвольные native bytes.
- Передать tree source в Claude/Codex/V1 runtime adapters и short-lived management/model/auth children.
- Обнаруженный child остаётся собственностью launch даже при rejected configuration или отказе bootstrap.
- До Job admission разрешён только доверенный bootstrap, который не импортирует provider/plugins и не создаёт children.
  Direct spawn произвольного CLI с поздним assign не допускается; отсутствие воспроизведённой гонки не доказывает barrier.
- Original custody owner (broker или выбранный existing kernel) удерживает ненаследуемый Job handle без breakaway;
  target CLI не получает его через IPC или environment. Закрытие control при Host crash сохраняет containment.
- Retained Job handle позволяет закончить cleanup после root exit; handle закрывается ровно после подтверждённой очистки.
- После Host crash новый Host читает durable UNKNOWN и разрешённое восстановление; он не принимает numeric PID за ownership.

### 4.3. Альтернатива: gated bootstrap и readiness (не реализовывать параллельно с broker)

1. Host проверяет bytes bundled Node и bootstrap в captured artifact closure P06; запускает fixed entry с builtin-only imports.
   Bootstrap стартует из trusted directory с отдельным scrubbed env: без `NODE_OPTIONS`, `NODE_PATH`, preload/import/config
   и иных startup inputs пользователя. Provider cwd/env/credentials передаются позже и сохраняют прежнюю допустимую семантику.
2. `CapturedProcess` удерживает настоящий bootstrap ChildProcess; existing custody проверяет root executable/birth и назначает Job.
   Только после успешного membership/current-authority check Host отправляет bounded одноразовый start frame по отдельному Node IPC.
   EOF/error/cancel/неверный nonce до gate не запускают CLI; duplicate frame не создаёт второй child.
3. Bootstrap повторно проверяет exact captured CLI/launcher recipe и создаёт его обычным `spawn` уже из Job.
   CLI наследует Job; получает только нужные stdio/captured env, без control fd и startup inputs bootstrap.
   Job libuv и Job Host не смешиваются: membership проверяется именно для retained Job Host.
4. Root Node identity и actual CLI identity — разные поля capture/readiness. Bootstrap синхронно удерживает original CLI handle
   через existing kernel на spawn boundary и сообщает nonce/PID/birth/executable evidence; HANDLE через Node IPC не пересылается.
   Host открывает свою копию, сверяет original birth/bytes/membership, затем ACK разрешает закрыть bootstrap copy.
   До ACK original handle удерживается; PID без этого handoff не создаёт authority. Early CLI exit проверяется как отдельный outcome.
5. Синхронный `launch()` может получить SDK write раньше readiness: простое наследование stdin это не исправляет.
   Минимальный вариант — stdout/stderr наследуются, stdin побайтно передаётся bootstrap только после Host readiness ACK,
   с bounded backpressure/EOF/error и без разбора provider protocol. Existing transport не переписывается, fake ChildProcess не вводится.
   Bootstrap сохраняет actual CLI exit/error outcome; Host не принимает живой wrapper за готовую provider session.

Native [CREATE_SUSPENDED → assign → ResumeThread](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)
остаётся резервом только при доказанной невозможности этого gate/identity/stdio контракта на поддержанном launcher.
Новый native transport заранее не планируется; existing broker уже реализует atomic admission и проверяется первым.
Резерв не разрешает отказаться от baseline функции; нижеописанные bootstrap-specific шаги нужны только при выборе этой альтернативы.
Это закрывает admission runtime дерева P08; отдельный service scope/late registration из P09 остаётся самостоятельным gate.

## 5. Порядок реализации и затрагиваемые места

1. **Сначала native harness и baseline.** Расширить `windows-job-custody.native.ts` и existing mixed fixture:
   зафиксировать executable, launcher kind, path cases и проверку barrier для раннего descendant.
   Проверить existing broker → structural SDK spawn adapter → native target streams/exit; pinned SDK допускает структурный процесс.
   Canonical broker core разместить в existing Host package, Main использует тонкий reexport. Не создавать новый пакет/протокол.
   В `resume(installOwner)` установить original authority до provider execution/input; launch с undefined PID не считается capture.
   Только при доказанной несовместимости этого seam проверять альтернативный Node gate/CLI handoff.
   Выпустить failing receipt для каждого отсутствующего маршрута; не маскировать unsupported skip как PASS.
2. **Общий path/recipe capture.** Изменить `nativeProcessProfile.ts`, `runtimeProfile.ts`,
   `management/profile.ts`; узкий structural process port/adapter расположить рядом с `CapturedProcess.ts`.
   `WindowsLaunchBootstrap` нужен только при выборе альтернативы, не как обязательный дополнительный файл.
   Учесть `mcpPolicyPlugin.path`, cwd и все provider config roots, а не только executable.
   Новые profile fields остаются private composition; старые POSIX profiles читаются без миграции active sessions.
   Для старого Darwin corpus проверить исходные bytes/digests до и после чтения; новые discriminator fields не дописываются назад.
3. **Общий native loader.** Изменить `WindowsJobCustody.ts`, `OpenCodeV2EmbeddedGraph.ts`,
   `OpenCodeV2EmbeddedServer.ts`; добавить shared dependency capture без копирования всей V2 dependency graph.
   Broker source/native bytes входят в verified closure; при выборе bootstrap он использует existing kernel/ABI.
   Проверить OS/arch/ABI/digest до загрузки; несовпадение прекращает новый launch до provider input.
4. **Runtime wiring.** Изменить `MemberProvider.ts`, `createRuntimeMemberProviderFactory.ts`,
   `ClaudeMemberProvider.ts`, `CodexMemberProvider.ts`, `OpenCodeMemberProvider.ts` и `CapturedProcess.ts`.
   Один immutable source создаётся composition; adapters не выбирают другую native библиотеку самостоятельно.
   В `CapturedProcess` различить control/broker process, original native target capability и SDK structural facade.
   Facade не выдаётся за `ChildProcess`, не использует broker PID как target PID и не меняет provider wire protocol.
5. **Короткие операции.** Подключить тот же launch/custody путь к `ClaudeManagementHost.ts`,
   `ClaudeAuthConversation.ts`, `CodexManagementHost.ts`, `OpenCodeManagementHost.ts`, `readCodexMcpCatalog.ts`.
   Координировать с auth/model планами, не переписывать их business workflows здесь.
6. **Packaging.** Расширить `scripts/legacy-agent-host/prepare-opencode-v2-native.ts` и candidate staging
   минимальным общим native dependency input; provider-specific graph остаётся provider-specific.
   Изменить `stage-opencode-v2-packaged.ts`/candidate manifest там, где сейчас ресурс доступен только V2.
   Переиспользовать staged broker build/manifest и Node из lock; bootstrap digest добавлять только при выбранной альтернативе.
   Win x64/ARM64 ABI, Node N-API, source/native SHA и runner OS записываются как проверенная поставка.
7. **Native/Desktop.** Переиспользовать `desktop-mixed-native-fixture.ts`, `desktop-backend-smoke.ts`,
   `desktop-mixed-process-proof.ts`, `run-packaged-opencode-v2.ts`; добавить режимы, не копировать harness.
   CI расширить native Windows jobs и `electron-packaged-ci.yml`; полный UI маршрут не подменять headless Host receipt.

## 6. E2E-first: обязательные опасные сценарии

Все действия выполняются в новых TEST проектах/профилях. Никаких настоящих пользовательских команд.
Provider CLI/SDK, OS processes, Host и UI настоящие; scripted localhost inference допустим и явно отмечается.

| ID | Сценарий | Что должно быть доказано |
| --- | --- | --- |
| W01 | Windows x64/ARM64: Create/Launch/Send/tool/Stop Claude, Codex и V1 | Native effect + reply; stopped original Job и owned descendants; независимый сосед жив |
| W02 | Unicode/shim/env aliases; hostile startup options; input до readiness и большой поток | Control/launcher не загружает user code; правильные argv/cwd/config; stdin до admission не доставлен; bytes/EOF не искажены |
| W03 | Задержанный/дублированный resume/gate, admission failure/cancel; CLI сразу создаёт child и выходит | До Job нет provider/children; один spawn; control/root identities различимы; ранний descendant остаётся в Job; failure cleanup подтверждён |
| W04 | В середине input Stop одного member, второй работает; потерян ACK Stop | Один captured stop effect; second member продолжает reply; retry возвращает receipt, не сигналит новый PID |
| W05 | Crash Host/control process до resume, на owner installation и после tool effect; cold reconnect | Нет orphan/input replay; original UNKNOWN виден; новое поколение не принимает старую numeric identity |
| W06 | Быстрый auth/model/catalog CLI exit, timeout/cancel до и после ACK | Actual exit/error различимы; нет оставшегося child/Job/IPC; повторная операция возможна; concurrent session живёт |
| W07 | Stop → exact checkpoint → cold Resume, затем fresh relaunch | Resume сохраняет нужную native history; fresh run имеет новую identity; оба cleanup подтверждены |
| W08 | Packaged candidate, checkout/legacy/runtime search paths недоступны | Bundled exact native ABI загружен; Launch/tool/Stop работают; подменённый artifact отклонён до input |

W01, W03, W06, W08 обязательны на каждой заявляемой паре provider/Windows arch из baseline таблицы.
Остальные сценарии распределяются по provider/transport рискам; общая матрица не требует всех сочетаний моделей.
W03 нельзя закрыть лишь controlled child: после него actual supported launcher также проходит boundary.
Для W03 controlled fixture подтверждает atomic admission → authority installation → resume/input; один timing race не доказывает отсутствие окна.
Ограниченный Darwin regression включает неизменность старой serialized identity, а не только успешный новый launch.
Cold UI/registered service identity из плана 09 не считается выполненной W05 автоматически.

## 7. Узкие unit-проверки и доказательства

Точечные units нужны лишь для новых опасных правил escaping/env ambiguity и отказов native admission/retirement,
которые не покрывает existing harness; реальные ancestry, создание потомков и cleanup доказываются native journeys.
Не добавлять snapshot каждого mapper или копию oracle под новым именем.
Existing `windows-job-custody.test.ts` расширяется; отдельный generic framework для тестов не создаётся.
Каждый native receipt содержит commit/tree, OS/arch/build, bootstrap и actual CLI version/digest/birth, launch/session/Job identity,
состояния original root/descendants и foreign neighbor до/после, exit/cleanup и границы inference.
`cleanup=true` требует OS observation; UNKNOWN/timeout/metadata terminal сохраняются отдельными полями.
Новые сценарии сопровождаются typecheck, focused existing suites и source-size/architecture guards.
Полный итоговый CI и сохранение receipts принадлежат плану 10; повторные native прогоны нужны по изменённой границе.

## 8. Объём, зависимости и риск

Оценка после reuse: **900–1 800 production LOC**, **1 000–1 800 test/E2E LOC**.
Считаются новые/существенно изменённые строки; перенос Windows loader, vendor/generated/lock и тесты планов 06/07/09/10 не прибавляются.
Диапазон включает маленький bootstrap, root/CLI identity handoff и stdin readiness. До W03 численно не уменьшаем:
отказ от нового native spawn transport экономит работу, но actual SDK/short-lived semantics ещё требуют квалификации.
Если доказанно нужен suspended bridge, оценка пересматривается по его узкому контракту; функция не исключается ради цифры.
Зависимости: 06 предоставляет captured selection; 07 — effective config; 09 потребляет общий native dependency; 10 выполняет общую приёмку.
Сложность **8/10**; уверенность в LOC **6/10**; достижимая надёжность после перечисленной приёмки **8/10**.
Последняя оценка — engineering confidence в границах проверенных profiles/OS, не вероятность отсутствия багов.

## 9. R1: реальная самопроверка плана

Проверены actual-main `childProcess.ts`, Windows oracle, Stage 1 profiles, все `new CapturedProcess` call sites
и отдельная V2 custody wiring. Найденные замечания отражены в текущем тексте:

- **R1-08-01:** одной path schema недостаточно; добавлены supported shim/argv/env и short-lived management children.
- **R1-08-02:** capture до input не исключает ранний descendant; введены W03 и explicit create-in-job decision gate.
- **R1-08-03:** V2 native PASS не доказывает прежний Windows UI; W01/W08 требуют соответствующий original Desktop маршрут.
- **R1-08-04:** строгая V2 path policy могла потерять baseline UNC/alias cases; добавлен census до изменения policy.
- **R1-08-05:** границы с installer и registry были склонны к двойному учёту; owner/shared loader и LOC разведены.

## 10. R2: независимое ревью и исправления

Reviewer: `/root/estimate_profiles_models`; исходная опубликованная ревизия плана:
[`7c4c77156879ed6d5a2bfce058efdfbd612ed112`](https://github.com/777genius/agent-teams-ai/blob/7c4c77156879ed6d5a2bfce058efdfbd612ed112/docs/plans/provider-migration/frontend-parity-2026-11-12/08-windows-provider-runtime.md).
Повторно прочитаны `CapturedProcess.launch`, `createWindowsJobCustodyForKernel` и `WindowsJobKernel.assign`
на закреплённой Stage 1 базе; сопоставлены границы P06/P09/P10. Тесты и production не изменялись.

- **R2-08-01:** условный bridge оставлял структуру spawn-before-assign. На R2 введён обязательный native bridge;
  R3 ниже сохраняет инвариант до provider execution, но заменяет избыточное средство доверенным gate.
- **R2-08-02:** общий path helper мог незаметно изменить hash прежних Darwin записей. Добавлен byte-preserving decoder
  и чтение legacy corpus без записи/нового binding; новую схему используют только новые captures.
- **R2-08-03:** фраза «обе архитектуры» могла обещать отсутствующие provider tuples. Введён явный baseline census;
  все заявленные маршруты обязательны, native proof и original Desktop proof остаются отдельными.
- **R2-08-04:** unit-бюджет мог дублировать native harness. Оставлены только локальные опасные инварианты;
  общий Job loader принадлежит P08, Processes не получает второго supervisor.

## 11. R3: design-check и исправление выбранного средства

Замечание координатора `/root`; source/official-doc analysis и поправки `/root/estimate_profiles_models`.
Исходная опубликованная ревизия: [`98aa3fe55b541481336975f1d545b8b1739650fb`](https://github.com/777genius/agent-teams-ai/blob/98aa3fe55b541481336975f1d545b8b1739650fb/docs/plans/provider-migration/frontend-parity-2026-11-12/08-windows-provider-runtime.md).

- **R3-08-01:** R2 требовал native create bridge даже для управляемого bootstrap. Выбран gate на bundled Node,
  повторяющий проверяемую V2 ordering boundary; provider/plugins до Job по-прежнему запрещены, suspended bridge — резерв.
- **R3-08-02:** wrapper мог подменить CLI identity, а ранний SDK write — обойти проверку. Добавлены original-handle handoff,
  отдельные root/CLI fields и stdin readiness ACK; control channel не смешивается с native protocol.
- **R3-08-03:** startup environment и Job libuv могли разрушить предпосылки gate. Зафиксированы scrubbed bootstrap env,
  exact artifact/ABI, внешний Job без breakaway и ненаследуемый Job handle; официальные основания приведены в разделе 1.

Design-check выполнен; W01–W08 native/Desktop qualification ещё не выполнялась. Оставшийся feasibility gate — actual
CLI handle handoff/быстрый exit и stdin/EOF semantics на обеих Windows arch. P09 service admission этим не закрыт.
Итоговый интеграционный допуск серии остаётся у координатора; production-код и тесты этим review не изменены.

### R3 дополнение — существующий broker и точный SDK contract

Reviewer: `/root/estimate_platform_acceptance`; проверены Stage1 broker/bridge и установленный pinned SDK **0.3.305** (`sdk.d.ts`).
`spawnClaudeCodeProcess` синхронно возвращает **structural SpawnedProcess**, не Promise и не обязательно Node ChildProcess:
stdin/stdout, killed/exitCode, kill и on/once/off для exit/error. Поэтому async broker prepare допустимо скрыть за небольшим
синхронным facade с backpressure до resume, сохранив реальные target events; cast broker ChildProcess как CLI запрещён.

- [Existing broker](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/tools/owned-process-broker/broker.cpp)
  уже создаёт root атомарно в Job через JOB_LIST + CREATE_SUSPENDED; owner устанавливается до resume.
- [Existing bridge](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/src/main/utils/ownedProcess/windowsBroker.ts)
  предоставляет **target stdin/stdout/stderr**, root PID/birth/exit и отдельные control/Stop/drain/release facts.
- Граница sync Host `CapturedProcessPort` сейчас избыточно требует ChildProcessWithoutNullStreams; допускается сузить private
  interface до фактически используемой process shape, не имитируя kernel handle и не выдавая broker PID за target.
- До выбора facade проверить early SDK write/EOF/abort, prepare failure, original root early exit и полный output tail;
  pending allocation остаётся у custody, facade error не доказывает отсутствие native allocation.
- Broker core сейчас живёт в Main utility, а Host имеет отдельный tsc rootDir/package: reuse требует одного canonical
  source location/явного package entry, а не копии protocol/native кода или импорта Host→Electron layer.
- Native x64/ARM64 и pinned Electron harness уже существует в `sentry-owned-process-native.yml`; расширить его target-stdio
  сценарием и actual provider/packaged proof. Новый Node bootstrap/native spawn addon до этой проверки не нужен.

**R3-08-04:** ранее не учитывался готовый atomic broker с stdio, из-за чего gate проектировался заново.
Исправлено: broker reuse — первый кандидат, Node gate — условная альтернатива; выбор проверяется конкретным SDK/stdio contract.

## 9. Implementation receipts

- Existing Windows broker core переиспользуется Host и Main; структурный SDK process facade не выдаёт PID broker за PID провайдера. Pending capability удерживается до async prepare; исходные owner/observers устанавливаются до resume/stdin.
- `WindowsCapturedProcess` сохраняет original capability и подтверждает Stop + Job empty + release. POSIX ChildProcess и отдельный V2 process-tree path сохранены. Реальные Windows paths допускаются без подмены на POSIX; broker path/digest/arch берутся из private captured profile.
- Host build, Host test types и native-tooling TypeScript PASS. Focused suite: 65 passed, один существующий skip отдельного dedicated-main gate; protocol suite 45/45 PASS. Native harness добавляет product CapturedProcess, Unicode/space paths, quoted argv, captured env/binary stdin, root-first descendants и соседний sentinel.
- Provider library source `bc1c93b5eedd410b519559ee5bbe036a50fc5670`: exact Node 24.21.0 и 26.11.1 `pnpm check` PASS, по 510 source tests + packed consumers. В frontend подключён immutable archive SHA-256 `ceafcfc99defd2a402cef7091041bf46bd828c3baeff8bc05529f06f397fd384`; Session SPI bytes неизменны. Frozen frontend install PASS.
- **Открыто:** actual Windows runner/native-provider/Desktop proof, trusted candidate delivery и P09 service-specific custody. Generic candidate staging сохраняет прежний Unix gate до завершения Windows registered-service ownership; fixture preparation не является Windows PASS. Draft-only CI policy не ослаблялась.
P09 поздняя service registration/subtree этим не закрывается. Production и native execution этим дополнением не подтверждены.

## 12. Windows ARM terminal archive staging failure — shared extractor (plan, 2026-11-13)

### Round 1 — observed failure and existing behaviour

The original packaged qualification on source `2227a997542fd603aab2bc8410433dacfa4e83a8`, [job 131916033009](https://github.com/777genius/agent-teams-ai/actions/runs/43429091393/job/131916033009), failed before packaging/launch. The locked orchestrator archive staged successfully. The next existing step downloaded terminal-platform 0.3.4 for Windows ARM64, then `Expand-Archive` failed inside Microsoft.PowerShell.Archive because its `ExtractToDirectory` three-argument overload was unavailable. The stager consequently reported its missing required files and exited1. This establishes an extraction-path failure; it does not establish a terminal/provider runtime regression or a passing packaged test.

[stage-terminal-platform-runtime.mjs at 52cf](https://github.com/777genius/agent-teams-ai/blob/52cfb512b54a52919ae6a3ab50ac7b7c1e1402a7/scripts/stage-terminal-platform-runtime.mjs) still has its own bare `powershell`/`Expand-Archive` branch. In the same checkout, [stage-runtime.mjs](https://github.com/777genius/agent-teams-ai/blob/52cfb512b54a52919ae6a3ab50ac7b7c1e1402a7/scripts/stage-runtime.mjs) already delegates archive extraction to [runtime-payload-cache.mjs](https://github.com/777genius/agent-teams-ai/blob/52cfb512b54a52919ae6a3ab50ac7b7c1e1402a7/scripts/lib/runtime-payload-cache.mjs). Its Windows route validates ZIP entry metadata, calls the existing absolute inbox .NET reader through a fixed encoded script and environment-held paths, verifies CRC/expanded sizes and rejects irregular output entries. It does not use the failing Archive module.

### Round 2 — minimal implementation

1. Import and call the same existing `extractArchive` helper from terminal staging. Replace only the duplicate extraction body; do not create another ZIP reader, fallback ladder, PowerShell probe, runtime choice or shell resolver.
2. Let the existing terminal `runOrThrow` accept and forward the helper's options, exactly as the existing orchestrator stager does. The environment carrying archive/destination/manifest and the fixed `shell:false`/hidden Windows process options must reach the original spawn. Preserve rejection on a spawn error/nonzero status.
3. Preserve terminal lock/version/archive checksum selection, payload name/required files, destination, publication, ensure/clean semantics and work-directory ownership. The helper's tar.gz and non-Windows ZIP commands are the same existing commands. No runner/image change, job timeout change, archive pin change, new download or second extraction attempt is part of the fix.
4. Extend the existing `runtime-payload-cache.test.mjs` caller table with the terminal stager. The same critical contract must prove exact helper options/literal paths, original thrown error propagation and irregular-output refusal. Include the actual terminal wrapper's `runOrThrow` in this existing test route so losing the environment cannot pass through a mocked forwarding function.
5. Run the existing terminal stage/ensure/clean integration test on this Linux environment and the existing shared extraction contract cases. Inspect the exact diff, targeted lint and source-size guard. Local Linux results and mocked Windows selection establish these limited contracts only.
6. The unchanged Windows ARM64 packaged lane on the next coherent commit must perform the real locked terminal extraction and complete packaging/launch. Preserve the original failure receipt. Passing the old orchestrator step, a new local tar test, or source review alone does not close Windows terminal acceptance.

### Round 3 — boundaries and independent review

Keep this change to the existing terminal staging script and its existing shared extraction test, plus this plan/evidence. No dependency or production Host/SDK change is needed. Validate the fixed options path rather than adding tests for each local helper. Ask an independent peer to review the exact extraction reuse and the option-forwarding check before publication. This plan does not authorize a release, published package or a merge to main.

## 13. Packaged Windows cancellation failure: preserve the original cleanup boundary (plan, 2026-11-13)

### Round 1 — actual failure and evidence limit

The original source `7ce224d148205867d46fd2ca980a48e1b9e8c48b` [Windows x64 packaged job 131953003561](https://github.com/777genius/agent-teams-ai/actions/runs/43440481505/job/131953003561) failed in existing step 25, before the packaged native journey. Type compilation completed; the `packaged cancellation restores inputs only after original native cleanup is attested / timeout-clean` subtest failed at `packaged-opencode-v2-inputs.test.ts:406`: `receipt.cleanup` was false, expected true. Its elapsed time was 1663.9544 ms. The adjacent `clean-error` and `unknown` subtests passed. Preserve the complete original log blob `af850a45e148eaf8509add3eea042ceabab3a5dc`; this is an existing TEST failure, not evidence that the real packaged native Host reached its journey.

The same existing test already checked the injected harness error and its source-unavailable marker before the failing assertion. Its timeout harness awaits stdin EOF, writes its fixed matching `cleanup:true` receipt, then throws the intended TEST error. The runner independently observes the original child exit, reads and checks that receipt, and only then may restore the source checkout, legacy directory and bundle. Its final `cleanup` combines native attestation with restoration/verification results. Thus the single false value does not identify which boundary failed.

The test captures the runner's stdout/stderr through its existing `spawnSync`; it does not publish the captured inner receipt/error on this failure. Its existing `t.after` deletes the temporary fixture root. The existing workflow uploads real packaged receipts, not those deleted fixture files. The available original log cannot establish whether attestation, a particular rename, or the restored-source check failed. Do not assume a transient Windows rename error, invent an error code, change exit observation to close, or add retries/timer slack from this evidence.

A separate [Windows ARM64 packaged job 131953003484](https://github.com/777genius/agent-teams-ai/actions/runs/43440481505/job/131953003484), original log blob `ec7fcb57da53a21a9df22c74f824603560482f54`, reached the actual packaged native journey. Its existing inline receipt records four model requests, an unknown input without terminal, original Host exit 1 and `cleanup:false`. The outer runner then fails its original `native.cleanup === true` guard and retains all isolated inputs. This is a distinct unqualified native outcome; it does not explain the x64 synthetic cleanup failure or establish the cause of the ARM input/cleanup failure. Both heads still consumed provider archive `f2514f0bec64a2da36511595fe2d6c67d9cbaa6e0da865a65375c2d7c7fe39a2`, before R28's D candidate.

### Round 2 — smallest necessary observation

Change only these two existing TEST files; their exact preimages are the same at the actual 7ce head and the current native 12d head:

| Existing path | Original blob | Bounded change |
| --- | --- | --- |
| `scripts/legacy-agent-host/run-packaged-opencode-v2.ts` | `bc1ee67f269679c7466bfd43d003695e53ee328f` | Preserve closed facts from the original exit, receipt validation and existing restoration catches in the original receipt. |
| `scripts/legacy-agent-host/packaged-opencode-v2-inputs.test.ts` | `3834b61e2bb249b0dbf770934592534b18cd7b05` | Add the closed projection to the existing failed cleanup assertion and validate it in the same three cancellation dispositions. |

1. Add one local, finite diagnostic object to the existing runner receipt. Record booleans for original exit observed, original receipt read/parsed, original receipt identity bound and native cleanup confirmed. The existing three restoration booleans remain the final restoration facts. Update each flag only at its original boundary; a timed-out caller, parse failure, missing receipt or unknown cleanup cannot manufacture a true flag.
2. Capture the first original failure and the first restoration/verification failure separately. The expected scenario rejection in `timeout-clean` must not hide a later restore failure. Each projection contains only a fixed stage literal and a fixed code literal. Stages distinguish original exit, receipt read/parse, receipt binding, native cleanup attestation, scenario checks, source restore, legacy restore, bundle restore, restored-source verification and temporary-root cleanup. The code whitelist is finite (the relevant filesystem codes, `ERR_ASSERTION`, and a single `unknown` fallback); it must not copy arbitrary error names/codes.
3. Capture the stage and code from the same existing catch/error object. Do not perform another filesystem read, child observation, process lookup or error reconstruction. Read only an own data property for the error code, under a nonthrowing projection; getters, raw messages, stacks, paths, argv, environment and arbitrary nested fields must not enter the new diagnostic object.
4. Keep original errors, AggregateError order, exit result, receipt binding assertions, `nativeCleanupConfirmed`, restore admission, all existing rename calls and the final cleanup/status predicate unchanged. The observation cannot affect admission, cleanup authority or restoration. In particular, an attested cleanup is still required before restoration, and native unknown still retains the original inputs.
5. The existing test exposes only this finite projection plus its existing boolean restoration facts in the original assertion's diagnostic message. It must not dump captured stdout/stderr or serialize the whole receipt, which can contain private paths. Missing/malformed projected fields remain fixed unknowns; they cannot turn the original assertion into a passing result.
6. Extend the same existing `clean-error`, `timeout-clean` and `unknown` cases to check the diagnostic contract. The two attested cases must preserve the original true cleanup/restoration assertions; the unknown case must preserve the false/retained-input assertions and distinguish failure before native attestation. Check the closed shape and absence of fixture paths/raw injected error text in the new projection. No new suite, runner, child, callback protocol or failure injection is needed.
7. Preserve the production runner's 480000 ms observation and 90000 ms cancellation bounds, the existing disposable-test-only 100 ms substitution, the 25000 ms outer spawn limit and the existing test/job budgets. Do not retry the failing scenario or weaken either success or unknown oracle.

### Round 3 — review, validation and interpretation

Root and an independent peer review this exact append before source. Review the two source deltas against the immutable preimages, then run the existing relevant scripts typecheck and the same packaged-input test when the normal executor or canonical CI is available. At present the executor is unavailable; source publication alone is not an executed/typechecked/native PASS. Do not create another execution route or rerun the old job.

The next unchanged packaged lane must retain the original failure as failure while exposing its specific original boundary if it recurs. Only that evidence can justify a later cause-specific repair. This observation does not close the x64 failure, does not qualify the ARM native input or cleanup, and does not change Host/provider source eligibility, pins, launch policy, filesystem authority or frontend features. Root remains the only publisher.

## 14. Settle an original Windows registration's definitive missing capture as refusal

### Round 1 — current review finding and the exact native contract

The unresolved [PR 1188 inline finding 4567158486](https://github.com/777genius/agent-teams-ai/pull/1188#discussion_r4567158486) remains present in the current native working commit `cbcdb472c6bbfcdd03f1b3231fbb0d625a3432c3`. This is a source-confirmed branch defect, not a new observed Windows execution. `WindowsTeamProcessCommands.ts` `08190730623d973884b7397a977e6b63070d680e` persists the original capture intent and requested/unknown registration before the first await (375–398). Its `continueRegister` (113–139) recognizes confirmed `not-dispatched`, but an original native `refused` reply with no saved capture falls through to the unchanged requested receipt. Lookup (451–463) repeats that projection without redispatch. Consequently this one rejected registration can indefinitely retain the Team journal's pending debt.

The intended correction is narrower than treating every refusal as no effect. The following existing source chain establishes the exact missing case:

- `tools/owned-process-broker/serviceScopes.h` `7a7fd19445532317d54b24870d598eede0b0024a`, `registerCurrent` 157–170, checks the original broker's retained current-PID index and original HANDLE. Missing index or an already exited original root throws `ERROR_NOT_FOUND` before setting `registered=true`; it never opens or adopts a PID. This is refusal of that registration, not evidence that every process or scope is absent.
- `tools/owned-process-broker/broker.cpp` `e975eb78a3096150ffe6e4b6409aeaadf8e2fb3e` 344–374 maps that error to the exact `ServiceRefused/Missing` reply on the original request. The successful branch obtains the same retained key and queries it before producing `ServiceCaptured`. In `serviceScopes.h`, `query` 189–192 only obtains that keyed record and calls `observe`; `observe` 74–86 records query errors in facts rather than throwing them. `retire` 251–265 cannot erase a registered or stopping record. A concurrent genuine Stop/settlement can clear the previously registered flag and retire that same record between registerCurrent and query. Thus not every capture-operation Missing is necessarily emitted before registered=true. In that post-register query case, the Missing reply confirms that no keyed registration remains for this refused command; it does not authorize another operation's cleanup, erase that operation's receipt/capture, or establish universal absence.
- `owned-process/codec.ts` `7a2aedea1413e3c2af3be85889451bd015534d79` defines `ServiceRefusal.missing` and strictly decodes the five-byte refusal (201–203, 255–259). Microsoft documents [`ERROR_NOT_FOUND` as 1168](https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--1000-1299-). The new terminal branch requires this exact reason/code pair; unknown, mismatched and other refusal pairs remain unchanged.
- `owned-process/WindowsServiceOperations.ts` `9cef2b31f755cca4df39d3aa4ad8b837c20f2ac1` 172–215 sends `ServiceCaptureCurrent` from the original capture entry, retains its original wire request and stores the validated reply on that same entry. A late native reply remains original lookup evidence; it does not authorize another native capture.
- `owned-process/RetainedWindowsServices.ts` `840e021b3dae5d4ad7a637b495c4e7f6c6cd5a4a` 59–78 and 159–170 looks up the original operation reference, checks the complete retained intent and returns that operation's snapshot. It does not replace a capture result with a later process query. `HostWindowsServices.ts` `c2f10e7f1302895dc96686cef362c6537757cb6a` 102–134 keeps an outer Host lookup refusal, incomplete reply, wrong operation or transport failure as `unknown`; only a completed matching lookup can yield the retained typed native outcome.
- Existing `registeredProcessContracts.ts` `45d10c81c949f57e1c2c09995cda86beef0a562b` 101–105 already supports `{ phase: 'refused', native: 'refused' }`. `validateProcessRecords.ts` `f705b85ab6a8ca07f02683e1a07f964316da7593` maps that state to the existing public `rejected` phase and validates the original fingerprint/intent. `TeamProcessCommands.ts` `4fc0413a4f93b712659fbac0a1db2cb76e922541` 243–263 independently retains every other pending receipt, metadata row and original capture when checking release.

This finding is specific to the Windows facet already implemented in the native child. The parent working commit `85a8e38e861b29a3f704897a981b5a3f95c30218` and qualification working commit `30bdb8d62234554f31006c47a4d314fbc8aa57bb` do not contain `WindowsTeamProcessCommands.ts` and retain the older non-Windows test blob `76d9db0868a86ac79eb58d3b52eef01ba59623e9`. This plan does not authorize importing the whole Windows implementation into those branches, activating another provider, or declaring a completed Windows native qualification. Root composes the two source changes only where the exact existing native facet/preimages are present.

### Round 2 — two existing files, one exact terminal transition

| Existing native path | Exact preimage | Bounded change |
| --- | --- | --- |
| `packages/legacy-agent-host/src/process/WindowsTeamProcessCommands.ts` | `08190730623d973884b7397a977e6b63070d680e` | Recognize only the original capture's exact Missing/1168 refusal after the existing current/Team/registrar/original-receipt checks. |
| `packages/legacy-agent-host/tests/registered-process-commands.test.ts` | `69aa5fca3a74ab36fc8fd4a8f8346ed89051de2f` | Extend the existing Windows capture-ACK and uncertain-policy cases, using the same finite synthetic native port and journal. |

Add the terminal branch beside the existing confirmed no-dispatch branch. It applies only while the same registration is still pending, its original intent is a capture, the result is `refused` with `reason === ServiceRefusal.missing` and `nativeCode === 1168`, there is no saved `receipt.capture`, and `originalRegistration.policyRequested === false`. Reuse the existing codec enum and a named local constant/comment for the documented native code. Persist `{ phase: 'refused', native: 'refused' }` through the existing receipt writer, invalidate the same projection, and return the original frozen receipt. Keep the complete command ID, principal, request digest, authority revision, native intent and original registration input unchanged.

The native request really was dispatched and refused, so do not label this branch `native:'not-requested'`. Do not invent a completed process row, native absence, Stop, settlement, signal result, capture, release or replacement command. The old not-dispatched branch remains byte-for-byte behaviorally unchanged. Any saved capture or previously requested policy effect excludes the new branch and follows the existing saved-capture/policy recovery logic; that existing logic may complete a genuinely attached original row, while an interrupted unattached policy write remains held. Unknown replies and all other refusal pairs remain subject to the original hold/recovery rules. Preserve the current source/grant/registrar checks after every await and the existing Team fence, deadlines, finite counts and no-redispatch rule.

The existing TEST port may accept one optional captured-result fixture value, stored in its original operation-result map before the original run reply, so a deliberately lost acknowledgment can later return the same saved refusal through lookup. Do not add an alternate production port, transport, journal or native request. Extend the existing capture-ACK case with independently fresh original fixtures for immediate Missing/1168 and original unknown-then-retained-Missing lookup. Assert exactly one original capture dispatch, no policy registration or row, no Stop/settlement, the original intent/request retained, terminal native-refused/public-rejected receipt, stable repeat register/lookup, and unchanged generic cold release admission when this refused registration is the only debt. A synthetic unknown or nonmatching refusal must remain held, with cold release refused; cover wrong reason, wrong native code and the existing not-dispatched distinction without accepting arbitrary refusal. In a fresh original fixture with a prior successful registration, a second command's exact missing refusal must leave the first command, captured row and original capture byte-identical, and must not satisfy release while that earlier original capture remains live or unknown. This controls the cross-command boundary relevant to the concurrent-settlement race without claiming to reproduce a native scheduler interleaving.

In the existing interrupted-policy case, after the real synthetic capture and interrupted original policy write, inject the exact Missing result only as a controlled contradictory lookup reply. Assert that this cannot erase the saved capture, change the original policyRequested witness, mark the command refused or release the unattached metadata row; original subsequent recovery/conflict assertions stay in place. This is a defensive journal boundary test, not a claim that the native operation normally changes its immutable reply. All existing test names, cases, successful capture/stop/natural-settlement assertions and native budgets remain. Keep the same files below their current 800-line limit; add no suite, workflow, native invocation, C++ change, schema field, PID reopening or generic refusal framework.

### Round 3 — independent review and honest qualification

Before source, root and an independent peer review this exact append and the native Missing-to-original-intent chain. Source is still unchanged at plan freeze. After publication, review the exact two-file delta, including refusal provenance, preservation of saved-capture/policy debt, native-refused versus not-requested labeling and all original receipt bytes except their normal state/fingerprint update. Root coordinates the existing Host build/types and the existing registered-process command tests in its normal single setup slot. The original Windows broker/service and retained native gate remain required ordinary qualification; a controlled-port regression does not prove an OS capture, cleanup or full provider integration.

No timeout increase, automatic retry, fresh capture on lookup, public API expansion, branch-wide provider activation or resolution of the POSIX executable race in P09 §47 follows from this correction. Other captures, active/unknown scopes, provider cleanup debt and whole-job release guards remain authoritative. Root remains the sole publisher of source, plans and refs.


## 15. Recover original Windows settlement only after confirmed no-dispatch

### Round 1 — fresh review, current source and the exact recovery gap

The new [PR1188 finding4571073506](https://github.com/777genius/agent-teams-ai/pull/1188#discussion_r4571073506), thread `PRRT_kwDORVTEtM63X3pn`, was published on2026-11-14 at02:53:58UTC against current native PR head `dfd0089e038669b3c662df18cf20841e365bbeac`. Root freshly read that thread and the current working source `8857d0411c1249f84c40c98298762c517b8a336c`. This is a confirmed source defect, not a claim that a new Windows native gate reproduced it.

`WindowsTeamProcessCommands.ts` blob `345f8441b22e689bac0c3fb77fc555391fde35a4`227–253 persists an original settlement intent on the completed genuine Stop receipt, then discards the outcome. Its later `lookup` reads only that same intent. A definitive `not-dispatched` therefore leaves no durable fact that allows a subsequent call to prepare another settlement. `naturalOriginal`258–265 correctly excludes captures already owned by a completed genuine Stop, so the separate natural-absence recovery cannot repair this receipt. Preserve that distinction: a natural exit must not mint or impersonate Stop.

The outcome has a concrete existing meaning. `WindowsServiceOperations.ts` `9cef2b31f755cca4df39d3aa4ad8b837c20f2ac1` refuses before wire dispatch for expired deadlines/admission/capacity and retains the original result; an operation already sent stays unknown until its actual reply. `HostWindowsServices.ts` `c2f10e7f1302895dc96686cef362c6537757cb6a`124–134 returns a definitive no-dispatch only for an original first-effect call that never reached admission; a serialized lookup with no such result remains unknown. `RetainedWindowsServices.ts` `840e021b3dae5d4ad7a637b495c4e7f6c6cd5a4a`106–169 may also refuse before retaining a native entry, while a retained entry is looked up by its exact original intent. Its `retirable`220–227 requires every original scope to be settled. Neither physical absence nor a completed Stop alone settles that bookkeeping owner.

The same source read found one adjacent admission window in the existing natural-settlement path: after persisting a new intent, the post-fence `aliveBudget` return can avoid even the original `run` call. No native operation then exists for a serialized lookup. Resolve this within the same existing facet: its original first-effect call must either receive a definitive no-dispatch or retain the original unknown result. This does not extend the deadline or authorize a late native send; the existing Host/Main first-effect boundary enforces it. A confirmed no-dispatch may be recorded after its deadline, under the original current/admin/receipt checks, because recording that already completed no-effect outcome performs no new native action.

### Round 2 — one optional receipt fact and the existing owners

Use one optional private literal field `nativeSettlementNotDispatched?: true` on the existing `ProcessCommandReceipt`, only for a completed genuine Windows Stop with its exact `nativeSettlement`. This is not another journal, lifecycle state machine, public API or absence proof. No `false` default is synthesized. Old receipts without the field retain their exact fingerprint and lookup-only uncertainty. The existing natural path keeps its own `nativeAbsence.settlement` state and receives no new field.

Include the new field in the canonical receipt fingerprint only when present. Validate that it is exactly `true`, that the original operation is `terminate`, state is completed/observed-absent, the capture is v5, and the same existing strict settlement-intent/capture/source checks pass. Reject the field on registration, metadata operations, non-Windows captures, missing intent and all other phases. Do not change old receipt hashes, schemas, original Stop state, command/principal/request/authority, native Stop intent, retained process row or physical absence evidence. `projectProcessViews.ts` `83c0c9dd7a07767c3b9895deb16283a13375c077`58–76 already constructs a closed public receipt; leave it unchanged so this private field and native intent remain absent from both Desktop and MCP output.

At entry to `settle`, retain whether this invocation's original receipt already contains the confirmed no-dispatch fact and its exact original settlement intent. Inside the current Team/admin fence, mint a new settle intent only if none exists, or if this call entered with that exact confirmed no-dispatch fact and the current retained intent still matches. Clear the optional fact only while replacing that exact intent and persist before dispatch through the original owner. A call which discovers no-dispatch during its own await must record it and return; it must not automatically retry. Concurrent callers that entered before the fact was known cannot spend it as a new grant.

After the original `outcome` await, retain all current/source/Team checks and exact `storedOriginal` comparisons. Persist the new literal only for `result.state === 'not-dispatched'` on that same still-current intent. Unknown, refused, conflict, transport exception, late missing lookup and mismatched results do not imply no effect or permission to retry. A newer settlement intent invalidates a late older result instead of being overwritten. Successful settlement needs no new public or durable success state: the existing Main retained owner already owns that outcome and replays remain lookup-only. No new Stop, capture, PID lookup, deadline reset, timer, background loop, retry count or cleanup allowance is introduced.

For natural settlement, preserve the original entry-time `retryNoDispatch` guard, exact registration anchor, native absence evidence, original requested/settled states and natural-versus-Stop exclusion. Remove only the post-persistence early return which could strand a newly prepared first-effect intent. Pass its unchanged deadline to the existing `outcome`; an expired first-effect attempt must be answered by the existing no-dispatch boundary. In the existing result fence, permit persistence of a confirmed no-dispatch even when that original deadline has just elapsed, while retaining original authority and same-intent checks. Other late result handling stays unchanged. This closes the adjacent no-admission window without converting unknown into no-dispatch or replaying an original request.

### Exact source cut

Only the native working branch contains this Windows facet. Root publishes source only there; parent and qualification receive the plan, not a partial copy of Windows implementation. These exact source preimages were read from the native working tree and local bytes were independently hashed.

| Existing path | Preimage | Change |
| --- | --- | --- |
| `packages/legacy-agent-host/src/process/WindowsTeamProcessCommands.ts` | `345f8441b22e689bac0c3fb77fc555391fde35a4` | Persist genuine Stop no-dispatch and admit one later exact-scope settlement; close the same natural first-effect admission window. |
| `packages/legacy-agent-host/src/process/registeredProcessContracts.ts` | `45d10c81c949f57e1c2c09995cda86beef0a562b` | One optional private literal, no synthesized default or public field. |
| `packages/legacy-agent-host/src/process/validateProcessRecords.ts` | `f705b85ab6a8ca07f02683e1a07f964316da7593` | Exact placement/value validation and conditional fingerprint participation. |
| `packages/legacy-agent-host/tests/registered-process-commands.test.ts` | `c2fd6d4d183a073094fe5251860ffa9915a55aaf` | Extend existing Windows Stop/natural cases; retain existing case names and all prior assertions. |

### Round 3 — bounded verification and qualification

Extend the existing genuine Stop uncertainty case using its original finite native port, real journal and closed public projection. For each definitive capacity/deadline outcome, retain the original registration and one genuine Stop; demonstrate that the first settlement call records no-dispatch without another native attempt, the next independently admitted cold lookup uses one new settlement intent on the same original capture, and repeated lookup does not dispatch again. Preserve original Stop/capture counts, the older returned receipt's immutability, metadata replacement protection, source/authority checks and all natural-path assertions. Check that old receipts with no new field keep their prior fingerprint, a changed/invalid field or wrong receipt placement is rejected, and the private field is absent from the existing public projection. No new suite or native run is added.

Retain the existing natural pre-admission/lost-ACK tests, including unknown serialized lookup before original admission, one first dispatch, same-intent late success, and later-call-only no-dispatch recovery. Extend that same finite fixture only as needed to prove that an expired first-effect no-dispatch is durably distinguished from an unknown prior dispatch; do not add clock sleeps, a production test hook or a synthetic success claim for Windows. Source files and the existing TEST file stay under800 physical lines.

Root and one independent peer review this exact plan before source, then independently review the four-file delta. Root uses the existing owned native checkout and its own frozen dependencies for serial Host build, Host TEST types, the existing registered-process command tests and source-size/diff guards. The original ordinary exact-head Windows broker and provider gates remain required. A controlled-port PASS does not prove actual OS cleanup or solve the separate POSIX execution race. Keep active live PR heads unchanged while their original CI runs; every working/docs commit is pushed immediately and read back before further publication.


## 16. W01 continuation: подключить Codex и OpenCode V1 к исходному Main-retained Windows owner

### 16.1. Основание и точная граница этого среза

Это продолжение W01 и [P09 §38](09-cross-platform-processes.md), а не исключение Codex/OpenCode V1 из Windows parity. В actual main `4a0e06277fe216d9f82dbbede362668fe46622ee` общий `process_register/list/stop`, Team MCP, Processes и Stop не ограничены Claude. Полная исходная цепочка и ограничения старого PID/taskkill пути закреплены evidence blob `b660d0ef3df35724c6e1c051562e961cfa5a9513`: `processTools.ts` `4038c52a3593002d28c3ff6b112c4a50c8ab2c00`, общий tool catalog `21b0cfc516f545475d5c1f29ea8f0304b35379e4`, `TeamMcpConfigBuilder` `0319105cfbadff51a058d6a36ece758f73c4c6d4`, `providerAwareCliEnv` `867fdb2f0928c38646b788b166b6671a73eff90e`, OpenCode availability `b2be19ef08bae4b02dccca7c59f4b582db647f6f`, `ProcessesSection` `e2f4b096b02870e0ae2a6c3122d95699978626cb`. Старое best-effort завершение по PID не переносится в новый captured owner.

Текущий native snapshot — `ad17fbbd267851291abdca9b565638c774262834`; текущий P08 prefix — `885ab21b3f189a69574d134dd123321dd6328dbb`. На нём Windows Sentry `43582230320`, x64 `132409208231` и ARM64 `132409208308`, завершили исходные Claude gates: evidence `187001867b3230eaebb0fff760bca83137b14d26`. Это не Codex/V1 qualification. Factory до сих пор передаёт Windows service/custody ports только Claude; Codex/V1 constructors не передают существующий retained port, а pre-member metadata/MCP/readiness создают свои `CapturedProcess` без него. При `service-scopes-v1` это реально неподключённый путь, не допустимый окончательный HOLD.

Исправление применяется сначала к native repair, где уже существуют опубликованные R14/R15 и Main-retained custody. Parent/qualification propagation после точной native qualification остаётся обязательной stack-интеграцией, не новым решением пользователя. Этот срез квалифицирует указанные direct native executables и обычные backend registration/Stop/cold-owner пути. Он не объявляет выполненными все launcher/shim/SDK-conversation/Desktop/release требования W01; поддержанные npm/.cmd пути остаются в общей цели и не отвергаются как arbitrary wrapper. POSIX §75 этим механизмом не переоткрывается.

### 16.2. Production scope: восемь существующих файлов, один существующий owner

Все пути ниже находятся в `packages/legacy-agent-host/src/`. SHA в столбце — точные native preimages snapshot выше; перед source freeze применяется явно названная последовательная композиция.

| Путь | Native preimage | Единственная связанная обязанность |
| --- | --- | --- |
| `composition/createRuntimeMemberProviderFactory.ts` | `4222f92b8e50368fb488d95ba5981e6051e7db09` | Передать существующие retained launch и registered-process ports конечному набору Claude/Codex/OpenCode V1; сохранить service capability/current Team fences. |
| `adapters/providers/CodexMemberProvider.ts` | `888621ff837e6c308fd0b34ec6c33e03abaee2a1` | Присоединить actual captured member environment к тому же port; expose существующий async Windows registration hook; дать default MCP census такой же captured process factory. |
| `adapters/providers/OpenCodeMemberProvider.ts` | `dca266583ddbaa8bb9671c83053b7153404c7d61` | Присоединить actual V1 config/MCP/password-derived profile к retained port и существующему Windows registration hook. |
| `adapters/providers/readCodexMcpCatalog.ts` | `ee4c8fce0aa5c1683f746c20403d032f42b25d08` | Опциональный private process factory для исходного `mcp list --json`; прежний default, codec, deadline и confirmed cleanup сохраняются. |
| `composition/TeamHost.ts` | `751dbe756fa3baa05309d6b4a5189f28c042ac45` | Передать уже созданный `HostWindowsLaunch` в существующую management composition. |
| `composition/createHostProviderManagementComposition.ts` | `0fbf6d2018389fef849cd9217fb41207aa96ae0b` | Создать private constructor callback поверх того же owner и передать существующему coordinator. |
| `composition/ProviderManagementCoordinator.ts` | `88c18318b45bf34465e9296e7b0b6b6522ec818f` | Пропустить callback в уже существующие V1 `createProcess` и Codex coordinator seams. |
| `composition/CodexManagementCoordinator.ts` | `651951881885bf6cfc35ed1ad78e836c31493a86` | Передать callback в уже существующий третий constructor argument `CodexManagementHost`; текущие target/root/queue/close guards остаются. |

Два пересечения имеют по одному writer. P06 §25B B9 меняет только finite protocol/version admission в Codex member: frozen successor `c486cd5130baa3f3d2c889f223e847a77fc40e2d`, manifest `dfa1112f5841f64fa0c4ceda47ffcb9b870948d6`; W01 накладывает свою отдельную дельту на этот опубликованный successor, не возвращает `888621`. B9 `CodexManagementHost` successor `ac87419633085b2ea517b9a0c3df442bf1982b78` и management/profile — read-only для W01. P05 §23 отдельно исправляет fence-safe `isCurrent/canCaptureRegisteredProcess` в factory; W01 берёт окончательный опубликованный §23 blob и сохраняет его callbacks целиком. Финальный manifest обязан содержать фактические оба composed preimages и inverse, а не только историческую таблицу.

Новые production owner, service, registry, journal, wire/renderer поля и native broker protocol не создаются. `TeamHost` уже хранит один Main-retained launch owner; coordinator/factory получают ссылку на него. Этот callback допускается только для исходного native Windows owner/selected broker; отсутствие owner у заявленного service-capable profile остаётся отказом, не переключает механизм. OpenCode V2 не включается в новый forwarding predicate и сохраняет свой существующий путь. В других OS/default injected-test branches прежние constructor defaults остаются.

### 16.3. Точный launch/registration join и derived environment

Member factories передают retained port только после того же исходного capture, который реально использует launch. Для Codex это `captured` с Team bearer env; для V1 — `captured` после исходных MCP tools/config, local config, namespace/password/witness изменений. Не брать исходный profile до этих изменений, не удалять `windowsBroker.capability` и не переносить member privilege в отдельный metadata process. `CapturedProcess` получает прежние current/capture/process-custody arguments и шестой retained-port argument; пятый tree-source argument не подменяется.

Существующие `CapturedProcess` `7fc0b23faf93756f8dac159eec97292a6085c634`, `WindowsCapturedProcess` `2a06560fc6a783d84b093f1eca77ee7065ff2c3a` и `HostWindowsLaunch` `9822137ec81e398d264e6db8465f2ad6837453c0` остаются source-unchanged. Они удерживают original pending capability до await, устанавливают оригинальный suspended HANDLE/Job до resume/input и принимают registration только из единственного original resumed, nonclosed allocation. Member возвращает уже существующий `prepareRegisteredWindowsProcess` hook; generic MCP handler и его full Team/grant/source checks не заменяются. `process.write` требуется так же, как раньше.

Management factory получает actual selected profile от существующего `OpenCodeManagementHost.createProcess` после его env augmentation или от `CodexManagementHost` после profile/roots capture. Прежний `isCurrent/canAllocate`, full management target и close/debt semantics не меняются. Каждая короткая операция имеет отдельную original allocation/capability того же Main owner; она не может стать member root. Derivation `teamModelProbeProfile` `8f5a9b10521ed707df82ed1b90fc923aa5432274` уже сохраняет `windowsBroker`; не добавляется новый inference/readiness route.

Default Codex catalog продолжает ровно тот native `mcp list --json`, который требует исходный consumer. Нельзя кешировать census, пропустить повторные source checks или выдать ожидаемый catalog за native ответ. Переданный optional callback меняет только custody construction; D parser, native request, terminal exit0, bounded stdout и dispose/confirmedStop не меняются. Исходные POSIX registered-root hooks остаются. Failed/unknown launch, registration, stop, release или source-currentness остаются held с исходной cleanup authority; PID lookup/adoption, `taskkill`, secondary broker и timer-based success запрещены.

### 16.4. TEST и workflow scope; native inputs

| Путь от корня repo | Native preimage | Связанная дельта |
| --- | --- | --- |
| `tools/owned-process-broker/nativeVendorInputs.ts` | `9e6a4756d79defb424cb18967089afeb221d077d` | Закрытые Codex0.162/V1 1.19.4 input variants; старый Claude selection/download unchanged. |
| `tools/owned-process-broker/nativeRetainedHostGate.ts` | `d94742582f0cc937118db5ed82c7ffef27bc9d50` | Два explicit provider cases в том же Main owner/controller; exact short-operation/member allocation ledger и pre-hash V1 initial provenance. |
| `tools/owned-process-broker/nativeRetainedServiceScenario.ts` | `f7c6d8f6a637f55b4cd1a142add89443207efc40` | Использовать исходный scoped two-service warm/cold Stop для новых provider cases, сохранив старый Claude path. |
| `packages/legacy-agent-host/tests/fixtures/native-codex-team/model.ts` | `afbdff2b405fedd04461d5398c2e95ba70f0eda9` | Один закрытый opt-in finite process scenario через существующий Responses decoder/encoder. |
| `packages/legacy-agent-host/tests/fixtures/native-opencode-team/model.ts` | `3204ac6ac5ead2ba6b1621f9ad7d30b041bd1902` | Такой же opt-in через существующий Chat Completions/native-tool parser плюс исходный один ordinary probe. |
| `.github/workflows/sentry-owned-process-native.yml` | `1188fa5b89d59b739d927082d1b6954a57181819` | Последовательно вызвать два новых provider cases внутри существующего Windows x64/ARM64 job после старых Claude gates и проверить закрытые receipts. |
| `tools/owned-process-broker/nativeRetainedProviderFixture.ts` | отсутствует: exact native path404 проверен | Один TEST helper: finite provider recipe/semantic process steps и expected original root roles. Он не содержит нового HTTP server, native protocol, production owner или диагностического сборщика. |

Итого 8 production + 6 существующих TEST/workflow + 1 новый TEST helper. Helpers `process-foreground-service.ts`, `nativeGateContext`, `gateController.cpp`, broker C++, D dependency, production schemas/permissions и существующие большие model-oracles не копируются. Новый helper не импортирует оба HTTP model fixtures обратно: fixtures сохраняют свои codecs, передают только проверенные native call/result fields закрытому semantic callback. Никакого runtime import cycle. Старые model options/defaults, 8 ordinary-probe / 16 business+notification ceilings и все исходные Claude modes/assertions сохраняются. Новых unit suites и permutation matrix не добавляется.

Официальные release metadata и exact delivered-D call chain сохранены в `479ab15fe5fc60ce50c883d7211d4c582b0ade96`. При подготовке плана provider binaries не скачивались/не исполнялись. Native download — только будущий original Windows gate:

| Provider/arch | Release asset | Размер compressed, bytes | SHA-256 compressed |
| --- | --- | ---: | --- |
| Codex0.162 x64 | `codex-x86_64-pc-windows-msvc.exe.tar.gz`, asset622686900 | 111636000 | `38a0fa27656ec23b9faa7d91ec84d8d8a6895ebf8616e872399949db44c55ba6` |
| Codex0.162 ARM64 | `codex-aarch64-pc-windows-msvc.exe.tar.gz`, asset622709364 | 102346096 | `e661c0ce6ff3a39eb63608c98116bf12abb1399e7b9fdb0b350d1a1de6114bf8` |
| OpenCode1.19.4 x64 | `opencode-windows-x64.zip`, asset665834171 | 81744896 | `93b899277bd6f68803009e32bf71772ce43c34b18adf1e93b9b4d8780fdf62e5` |
| OpenCode1.19.4 ARM64 | `opencode-windows-arm64.zip`, asset665834160 | 75791921 | `36e696fd1d275b469ab02a1ccc00d161bfdcc0a4ffa93c2b7a4e57399f3ff347` |

Источники: [Codex release407151970 / rust-v0.162.0](https://github.com/openai/codex/releases/tag/rust-v0.162.0) и [OpenCode release420695951 / v1.19.4](https://github.com/anomalyco/opencode/releases/tag/v1.19.4). Codex selected regular PE bytes дополнительно равны официальному direct-EXE digest: x64 `dce685d569526ef4712fa82d20ff20e1309baad5fcd34215e1126698f611242f`, ARM64 `d5d233fa93a8ea6ff856cdc2146eb216121144c2fed5568f5dea7ee47cb409f1`. Tar paths не используются как output paths; единственное совпадение immutable executable bytes пишется в фиксированный новый TEST filename. Direct334MB EXE не обходят исходный 256MiB compressed-download bound. Codex0.162 использует существующий native fixture `code_mode=false`;0.169 qualification по Darwin не переносится на Windows.

Для V1 ZIP использовать существующий `assertSafeRuntimeZip` (`691d283945958ba873805c85ad66ddd8d508b377` facade / `7a9f9a85965d65472053757db9c893fecd4d78bf` validator) и Windows extractor `a605b7a2578594710abbd24fa774d81c6ed7180a`: весь original archive bounded/regular, один выбранный `opencode.exe`, no symlink/reparse/traversal/duplicate, PE соответствует arch. Validator не ослабляется ради неизвестного archive shape. Если официальный archive не проходит исходный parser, gate не заменяет его ambient executable/другим binary. Выбранные native bytes и version/arch/official archive SHA записываются в новый wx selection до owner capture; повторный hash перед/после flow обязателен. Наличие ARM64 archive не является execution PASS.

Сохраняются исходные input download60s, compressed256MiB/expanded512MiB, известный Git Bash path+hash, captured Node24.21, service actor/seed hashes и explicit fresh TEST namespace. Provider `--version`, install scripts или PATH search не используются как substitute native acceptance. Fixed SystemRoot/ComSpec/Git Bash/Node paths приходят из существующего job recipe. Zip extraction вызывает только исходный fixed system PowerShell reader с validated manifest, не unknown executable.

### 16.5. Конкретные profile, ordinary preparation и model actions

В каждом новом case создаётся свой explicit controller sandbox и **один** member с исходным process.write grant, service-capable staged product broker, fresh HOME/XDG/account namespace, actual captured workspace и TEST loopback model endpoint. Shell, actual Node/actor paths и byte hashes фиксируются до profile serialization. Service actor лежит/пишет в этом же выбранном workspace; командная строка получается только из этих captured TEST paths через существующее quoting. Новые cases используют текущие supported native options/permission path, не изменяют production security settings или sandbox defaults, не добавляют shell/PID fallback. Если выбранный native tool не может выполнить этот supported recipe, original gate обязан отказать.

Codex profile берёт существующий0.162 native fixture recipe: config/model provider, Responses route, TEST key, update/analytics/remote-model/plugin traffic disabled, `code_mode=false`, current approval/sandbox selection. `capturedMcpServers={}` и чистый fresh CODEX_HOME задают **ожидаемый** empty external catalog через существующий pure D decoder `decodeCodexConfiguredMcpCatalog('[]')`. Это fixture precondition; пять настоящих native census ниже должны самостоятельно подтвердить этот digest. Team endpoint/token/required tools добавляет прежний production adapter, не TEST config. Перед runtime.open выполняется ровно один исходный `management.codex.metadata` для `teamModelProbeProfile(member)`, `includeModels=false`, `includeRateLimits=false`; это реальные account/config metadata без model inference/thread/turn и без credential mutation.

V1 использует исходную keyed TEST provider/model config, local endpoint, отключённые title/summary/autocompaction/update/telemetry, named member agent и explicit captured Git Bash shell. До profile write/hash вызывается существующий `captureInitialRuntimeModelAdmission` `e709df02ff4ce926c6d1721b5549024f6c945949` для точного `runtime.open / TEST-original-open / memberId`. Нельзя добавить provenance после первого owner или вызвать private initial route вместо supplied Main origin. Ordinary B2 остаётся production-owned: keyed config, без managed limits и authless coordination дают ровно один existing no-tool model probe и один management native root; original source/account/currentness/receipt release precede member allocation. TEST endpoint не засчитывает synthetic OK как receipt; gate соединяет actual released original probe с original action/profile/consumer.

Два существующих model fixtures получают только закрытый opt-in process scenario, несовместимый с candidate169, UI, mixed, coordination, peer и другими scenario options. Их текущие request method/route/model/size/parser/failure-seal остаются; V1 ordinary probe принимается только в исходной opening phase, с прежним exact prompt/no tools и ключом. Business inference начинается после полного original readiness/custody join. Один явный Team message/input вызывает ровно четыре business POST:

1. Native advertised shell tool (`exec_command` у Codex с captured shell; исходный V1 Bash tool) исполняет один фиксированный command, который запускает два неизменённых foreground TEST Node actors как background children с отдельным перенаправленным stdout/stderr. TEST harness/model server сами этих services не spawn'ят.
2. Только после actual native shell result с original call ID/успешным завершением и появления двух bounded nonce-bearing service records model запрашивает исходный Team `process_register` для primary с точными pid/port/url/label/command. Используется прежнее bounded readonly ожидание service records, clipped к исходному business deadline.
3. Только после реального успешного MCP result/command identity первой регистрации запрашивается регистрация neighbor; никаких synthetic product files/rows или прямой записи registry.
4. Только после второго actual MCP result native model завершает тот же business turn фиксированным terminal marker. Один original input, один native terminal; без дополнительного turn/retry.

Все advertised tool names выбираются из существующего strict native tool parser; нельзя заменить неизвестный tool общей shell-командой, скрыть native error или допустить произвольный call. Semantic helper удерживает original tool IDs/result pairing, две разные services/nonce/commands и phase, не выбирает latest result. Четыре POST включают terminal. Native SDK background-task notification не требуется у этих двух обычных shell cases: receipt явно `nativeSdkBackgroundTaskQualified:false`, notification count0. Старый Claude notification loop/count/assertions остаются в прежнем Claude branch без изменения.

### 16.6. Точная арифметика и original physical custody

Delivered D tar SHA256 `91350f829b72f83e613505bb444ff0d9ef98fb0835e3e438b918bbea8d930f94` не меняется. Нельзя предположить один Codex census: actual F `resolveConfiguration` делает первый; D `driver.open` второй; D mandatory `checkReadiness` третий; F `RuntimeOwner.allocate` четвёртый; D readiness перед единственным submit пятый. Полные delivered source bytes/hashes находятся в `479ab15f`; `RuntimeOwner` `7848030933816757816c43e2a08dd0f9cbed7563`. Третий и четвёртый не объединяются; никакого кеша/изменения D.

| Успешный новый case | Management metadata roots | MCP census roots | Ordinary readiness roots / POST | Member roots | Business inputs / POST | Всего original roots | Short roots released до business |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Codex0.162 x64 или ARM64 | 1 | 5 | 0 / 0 | 1 | 1 / 4 | 7 | 6 |
| OpenCode V1 1.19.4 x64 или ARM64 | 0 | 0 | 1 / 1 | 1 | 1 / 4 | 2 | 1 |

Codex при original runtime.open имеет metadata1+census4+member1=6 allocations; последний census относится к исходному одному submit, после него7. V1 имеет2 к завершению original open. Итоговые model HTTP POST: Codex4, V1 5; других model requests/GET, coordination, notification turns или source inventory requests новый scenario не допускает. Эти суммы укладываются в существующие8/16, counters никогда не reset'ятся. Они относятся только к двум новым cases, не заменяют прежние Claude4 business + native notifications и one-allocation assertions.

Whole custody observation ledger не фильтруется по count-minus-shortcuts. По original capability/ProcessOwner/launch chunks+commit hash и decoded immutable launch body устанавливаются executable/cwd/env/argv и назначение каждого root: metadata app-server без member token; пять точных `mcp list --json`; V1 readiness serve с original disabled-tools/probe profile; member с actual captured Team environment. Captured capability и prepared root должны совпасть с service capture; member нельзя выбрать как «последний/оставшийся PID». Original suspended HANDLE witness сохраняется для **каждого** allocation. Сравнение decoded argv/env выполняется в памяти на существующем custody observer; в evidence остаются closed role, original capability/root, hashes и counts, без raw bearer/password/environment и без нового collector. Все короткие операции имеют собственные confirmed Stop, drain, release и original absent witness до business; member единственный остаётся alive. Не переносить одну capability между ними и не признавать exit code вместо release ACK. Неизвестный/лишний root, missing ordinal, повторная short launch или невозможность доказать роль оставляют case INCOMPLETE.

Используется существующий scoped service scenario: две genuine registrations; primary warm Human Stop, neighbor+member alive; original Host loss без Stop member; successor Host в **том же Main** с original unchanged profile; cold list/lookup и neighbor Human Stop по исходному processRef, без нового capture/root/input. Строго остаются capture2/stop2/settle2, coldSettle1, исходные bounded query/lookup gates, full original intent/principal/grant/history equality и independent original target birth/HANDLE. У successor allocation0, input write0, capture0; short-operation factory тоже не может стартовать в cold epoch. `signalAccepted:'unknown'` в исходной Windows public contract не превращается в true.

После двух scoped Stops member root всё ещё alive до original whole-owner cleanup; исходный unrelated sentinel жив. Final Main close подтверждает original Job zero/release и отсутствие всех original roots/targets; cleanup errors/unknown остаются в receipt и проваливают gate. Для новых cases metadata/census/probe close counts относятся только к коротким roots; они не засчитываются как member cleanup и не стираются из totals. Старые Claude exact counters остаются отдельными прежними условиями.

### 16.7. Бюджеты, workflow и проверка

Новых jobs/matrix entries/workflow activation, cancellation/rerun, таймерных допусков и повторных attempts нет. В существующем Windows job после неизменённых Claude gates выполняются два новых controller invocations (`codex-scoped-services`, `opencode-v1-scoped-services`), по одному каждого на x64 и ARM64. Job30min, исходный controller120s (`gateController.cpp` `e15e859feb445a0e83043d288aab3d001ee03ab4`), Host startup10s/request45s/write5s/shutdown1s, original business35s, warm/cold Stop10s и native cleanup bounds не повышаются. Codex metadata prelude и runtime.open делят **один** исходный opening45s clock через существующий `CapturedHostClient.request.remainingMs` (`55ba1f24741dd9acc5fcd3e92b2cc2d58325c615`), а не получают два полных opening budgets. Extra readonly service-file wait clipped к уже идущему business deadline; replay/read/cold не renew cutoff.

Новые exact receipts явно указывают provider/version/arch/head, input selection/host/node/broker/actor digests, весь root-role ledger и original references, exact model counters, native process registry/physical Stop/same-Main cold proof, cleanup; `sdkColdConversationQualified`, `nativeSdkBackgroundTaskQualified`, `desktopQualified`, `releaseQualified` остаются false. Workflow читает собственный provider receipt и проверяет эти поля/суммы, без «любого PASS», без переноса Claude/Darwin facts. Исходные failure artifacts, finally/drain, controller emergency evidence и current checked D pin сохраняются.

Source gate: exact root+independent peer, каждый file full readback/forward+inverse; две shared composition deltas отдельно; исходные line caps без повышения (особенно TeamHost/ProviderManagementCoordinator/model fixtures), без сжатия или extraction только ради cap. Небольшой новый TEST helper обоснован одной общей finite provider fixture обязанностью, не переносом production ownership. Root выполняет canonical Host build/test types/tooling types и требуемые existing checks; новая bounded source logic не создаёт большого unit matrix. Native qualification — только следующие original x64/ARM64 runs того же job на exact published head. До обеих original receipts PASS connected feature остаётся unqualified; реальная несовместимость protocol/permission/archive/custody требует source diagnosis, не пропуска проверки и не permanent HOLD, названного parity.



### 16.8. Уточнение V1 acceptance: отдельный management probe, затем zero-probe native initial

Этот appendix заменяет только ошибочное объяснение одного V1 probe как автоматического B2 proof в §§16.4–16.6 и уточняет общий opening budget в §16.7. Восемь production paths, общий owner, Codex7 roots, два новых existing-job cases, исходные Claude flows, остальные inputs/guards/counts/deadlines и весь source scope остаются прежними. Source этих двух model-fixture opt-in branches до этого уточнения не написан. Production custody forwarding независимо разрешён опубликованным §16.

**Причина.** `captureInitialRuntimeModelAdmission` и последующий `attachInitialRuntimeModelAdmission` в `composition/initialRuntimeModelAdmission.ts` `e709df02ff4ce926c6d1721b5549024f6c945949` сохраняют `native-bootstrap` при отсутствии исходного prepared locator; ветка original attach возвращает undefined reference, не вызывает ModelProbeOwner и не расходует inference. Keyed TEST config не превращает этот путь в B2. У existing retained gate нет настоящего Main-captured policy origin, поэтому он не фабрикуется. Обычный `management.catalog` также не подходит как короткая V1 операция: `ProviderManagementCoordinator` `88c18318b45bf34465e9296e7b0b6b6522ec818f` сохраняет successful V1 Host в `hosts`, и endpoint остаётся занят. Его lifecycle ради TEST не меняется.

Вместо этого новый V1 case явно выполняет одну самостоятельную поддержанную `management.probe.start/read` операцию перед исходным initial Open. Её role/receipt label — **`standalone-management-probe`**. Она квалифицирует фактический management Windows process factory и последующее original clean close. Это не initial readiness, не B2 preparation/coordination и не разрешение для Runtime; native initial по-прежнему проходит все собственные source/account/owner/claim guards без ссылки на эту receipt.

| Исходный неизменяемый source | Точный blob | Значение для последовательности |
| --- | --- | --- |
| `composition/createProviderManagementMethods.ts` | `708d880bb9be0dcaae978b97b0686b548b7873a3` | `management.probe.start` передаёт raw body в original `probes.start`; `probe.read` — control/read. Это не Team envelope. |
| `composition/teamLaunchModelProbe.ts` | `8f5a9b10521ed707df82ed1b90fc923aa5432274` | `teamModelProbeProfile(member)` даёт исходный profile/config ID, native executable/cwd/env/account/broker и тот же selected V1 endpoint. |
| `composition/createHostProviderManagementComposition.ts` | `0fbf6d2018389fef849cd9217fb41207aa96ae0b` | Этот derived profile уже включается из original runtime members; второй одноимённый management profile не добавляется. W01 меняет здесь только уже разрешённый retained constructor callback. |
| `management/ModelProbeOwner.ts` | `b30cf0d7b41251d99933d66c0a0fc5185e9170d9` | Strict ordinary start без private purpose; original pending receipt предшествует native run. Completed/ok появляется только после `native.close`, writer/target checks и original store/fence settlement. Unknown close остаётся held/resourceHeld. |
| `composition/ProviderManagementCoordinator.ts` | `88c18318b45bf34465e9296e7b0b6b6522ec818f` | Ветка no-limits обычного probe вызывает один `probeModel`; close вызывает `retireHost`, который удаляет именно этот cached Host только после successful close. |
| `adapters/providers/OpenCodeManagementHost.ts` | `c726d6a556193a008eefd3a22a21868641dfd23d` | Probe использует настоящий derived disabled-tools/password/witness profile; close идёт через original custody `confirmStopped`. |
| `adapters/providers/runOpenCodeModelProbe.ts` | `c1240460eeac5c7ed26269ef6e86d3b89b31c17d` | Один original session + один exact no-tool model message, native response/session/provider/model/terminal checks. |
| `adapters/providers/FileManagementCommandStore.ts` / `management/commandRecords.ts` | `2d6031ae7c0c0aad5d637581f5242714536ac215` / `9cd092f5d78e9a80cb922d65a29be5f2b7b96976` | Exact command-hash filename, bounded digest/schema-validated durable receipt, `completed` требует `resourceHeld:false`. Public snapshot не содержит resourceHeld. |

**Последовательность и бюджет.** Original profile полностью фиксируется до первого owner, включая `captureInitialRuntimeModelAdmission` для единственного `runtime.open / TEST-original-open / alice-id`, без `prepared` locator. После original `client.start()` один исходный opening45s clock начинается до management prelude. Raw `management.probe.start` вызывается ровно один раз с фиксированным `commandId: 'TEST-standalone-management-probe'`, точными `profileId/configRevision` из derived member profile и исходными TEST provider/model; без context, purpose, limits, readinessScope или Main origin. Все start/read/Open calls получают только оставшееся время этого одного clock через существующий `CapturedHostClient.request.remainingMs`; новый полный таймер не выдаётся. Existing native probe timeout не увеличивается и не выдаётся за gate deadline.

Start может законно вернуть running. Gate читает только тот же original command/profile/config через `management.probe.read`, не повторяет start, не меняет IDs и не добавляет probe. Только running допускает ещё read в оставшемся clock, с исходным bounded ожиданием и конечным лимитом128 readbacks; completed/ok обязателен. Null/held/cancelled/refusal, исчерпание remaining или лимита — failure с прежним finally/cleanup, не retry/recovery attempt. Перед Open проверяются один probe model POST, original command/fingerprint/target, фактические stop+release ACK и absent HANDLE этого единственного management root. Для actual resourceHeld читается только его точный уже существующий private receipt, bounded64KiB+1 regular no-link descriptor с before/after identity, digest и original stored-model schema; constructor store/write/list не вызываются. Требуются `phase:'completed'`, `ok:true`, `resourceHeld:false`, exact original identity/fingerprint, отсутствие private purpose/readiness/preparation/scope. Не объявлять это поле прочитанным из public snapshot.

После confirmed original release тот же selected loopback serve endpoint должен быть освобождён до member: краткий TEST exclusive-bind/close на точном endpoint проверяет отсутствие retained listener, внутри того же remaining clock и с обязательным close/finally; он не создаёт native process и не отправляет HTTP/model input. Затем phase закрывается для model requests и вызывается исходный `runtime.open` с тем же заранее captured initial action. Только actual nativeReady/current member custody переводят единственный business input в business phase. Probe receipt не копируется в profile, initial locator, launch consumer или current readiness и не переносит полномочие между process roots. Cold successor не повторяет management start/read/probe/Open и не создаёт metadata root.

**Finite fixture contract.** Единственная optional `retainedProcess` ветка несовместима с прочими model scenario options. Общий структурный callback type объявляется в существующем Codex model fixture; V1 импортирует только type. Поля: fixed `turn`, `phase(): 'standalone-management-probe' | 'business' | 'closed'` и `next({provider, step, userText, tools, previous})`, возвращающий только одно из исходных advertised `exec_command`/`bash`/`process_register` actions с finite input либо undefined для terminal. `previous` содержит original callId/name/parsed input/output, а tools — names/optional namespaces после существующего native decoder. Новый TEST helper не импортируется runtime-зависимостью в package fixture. Undefined terminal выбирается явно, без fallback в старые actions; оба старых codecs/default branches сохраняются.

Только V1 в phase `standalone-management-probe`, при probes0/business0 и original exact prompt/no-tools/route/model/key, может выдать единственный ordinary response. Никакого generic `allowModelProbes` для этого режима. Codex допускает0 probes. Во время member Open phase closed; business phase начинается после описанных physical/receipt guards, затем ровно4 business POST и прежние actual call/result joins. Existing8 probe/16 business ceilings не повышаются и не сбрасываются. Successful V1 total остаётся5 model POST, но смысл первой операции исправлен: **1 standalone management +0 initial/B2 +4 business**. Это прогноз требуемой новой actual acceptance, не исполненный PASS.

Исправленная V1 ledger: standalone management root1 (stop/release/absent до member), native initial member root1, initial/B2 roots0, total roots2; business input1/POST4, management POST1, coordination0/notifications0. Label прежней `readiness serve` роли заменяется на standalone management role; member всё так же единственный original allocation с Team MCP/token и original registered-process hook. Codex7/short6 ledger и его metadata prelude неизменны. Workflow проверяет исправленные exact role/count/receipt fields в том же existing Windows x64/ARM64 job, сохраняя текущие failure artifacts, old Claude assertions и все deadlines.

Source scope не расширяется: это дельта уже разрешённых gate/helper/V1-model/workflow branches в §16.4, существующие preimages не менялись; production8 forwarding не изменяется этим amendment. До original Windows x64 и ARM64 qualification ни standalone-management-probe, ни member service registration/Stop/cold путь не считаются проверенными.


### 16.9. Shared catalog factory propagation is separate from retained Windows activation

P06 §25.17 requires an exact pre-App original-child witness for the independent Darwin ARM Codex source-selection proof. Authorize, only after the cross-plan review and explicit source GO, common propagation of the already reviewed W01 private optional fourth `createProcess` parameter in `readCodexMcpCatalog.ts`: baseline `ee4c8fce0aa5c1683f746c20403d032f42b25d08` to exact W01 candidate `7230804bd10e8a521cb3e1b1e9760920e9ebcef5`. The delta is only the CapturedProcessPort type import, optional factory signature and factory-or-original-constructor expression. All original D launch arguments, currentness, environment/cwd, terminal, bounded decoding and dispose→confirmStopped behavior remain byte-identical. Without an explicit private factory the original constructor remains selected.

This is a platform-neutral internal construction port, not common activation of W01's retained Windows owner chain. Native-first Windows source/qualification requirements, broker HANDLE/registered-root authority, callback/environment joins and §16.8's physical/model arithmetic remain unchanged. No Windows control, admission, release or native-result claim follows from this propagation or from C10's separate Darwin proof. Preserve the current native implementation if W01 has already published the identical port; root composes the common delta once.

The source-only C10 fixture wrapper delegates to the same original CapturedProcess and immediately observes the actual returned handle/PID/birth through the existing read-only captured-app helper; it cannot grant ownership from a path or replace cleanup. P06 §25.17 retains unconditional original cleanup and fails an absent/ambiguous witness. The catalog port is the only production path added to C10's previously reviewed scope. No source change or execution is performed by this plan amendment; the existing W01 native gates remain required.

## 17. W01: восстановить исходную compiler boundary и три original-deadline callbacks

**План до source.** Prefix этого appendix — P08 `32bef8ff8309ca3f44bd1429a0c4427a42cbe4cd`. Область — четыре существующих TEST/build-scope файла native-ветки; production, зависимости, native protocol, модели и workflow не меняются. Windows same-Main product Retry / Processes UI остаётся отдельным ещё не разрешённым source cut.

### 17.1. Наблюдённый первый отказ и предел доказательства

Original run `43594548604`, Windows x64 job `132446162113`, exact head `c04761a8b45e31ff0c08e69fe5c628b9d555f528` остановился 2026-11-14 12:50:19 UTC на **первой** исходной команде `node node_modules/@typescript/native/bin/tsc --noEmit -p tools/owned-process-broker/tsconfig.json`. Host build перед ней завершился; последующий retained-host compiler, protocol tests, broker build и actual Windows native cases не начались. Полный original log — blob `e80d16e82ec1d5e4163ab29ea6cebb6c9e665f1e`; compact evidence — `d146741105cb336fca97a246f39cbea620685ee7`. Artifact `14114403121` содержит только `source-sha.txt`: ZIP 186 bytes, SHA256 `af5b52581a31e096e8a527fd42c271991e098c15f7b85d60c83ff3accf12ec57`, independently downloaded/hash-checked and read. Native receipt отсутствует; этот отказ ничего не доказывает о Windows runtime/custody.

Исходный low-level config `55bf5418` включает `*.ts` и уже исключает две Main integration entry points — `nativeRetainedHostGate.ts` и `nativeRetainedServiceScenario.ts`. Новый `nativeRetainedProviderFixture.ts` забыли исключить: он стал самостоятельным root и втянул application graph под чужие `noUncheckedIndexedAccess` / ambient types. Отсюда одновременно появились Main/shared diagnostics. Это не основание менять application types или compiler flags.

Отдельный исходный `tsconfig.retained-host.json` blob `b9399da33bc4da55ac819f266cf6f279ab057d7a` уже включает обе retained entry points и их обычные imports: Gate → Scenario → новый helper. Он остаётся побайтно неизменным и обязательным. Отдельно actual log показал четыре ошибки helper: dependency resolution, optional `memberTools`, переданный number вместо deadline callback и generic member union без `protocolRevision`. Source-backed проверка обнаружила такие же number/callback ошибки ещё в Gate и Scenario; они являются **предсказанными следующими diagnostics**, а не результатом ещё не выполненного второго compiler.

### 17.2. Exact write scope

| Existing native path | Exact preimage | Разрешённое изменение |
| --- | --- | --- |
| `tools/owned-process-broker/tsconfig.json` | `55bf54184ebf52a5bb25ab85da64d8208aad2019` | Добавить только `nativeRetainedProviderFixture.ts` в существующий список integration exclusions. |
| `tools/owned-process-broker/nativeRetainedProviderFixture.ts` | `9c20baafaa3cdf4cc35b47bd9541ab63fd2e50ef` | Правильный public installed dependency entry; точный прежний empty TEST catalog; реальные narrowing guards; original deadline callback. |
| `tools/owned-process-broker/nativeRetainedHostGate.ts` | `f239988b353cdd924dd78587249776673a40f90d` | Только уже условный `remainingMs` становится функцией того же захваченного `deadline`. |
| `tools/owned-process-broker/nativeRetainedServiceScenario.ts` | `ece47cb1e0a0912e5271c9bbff0d497b1f92f361` | Только provider-fixture `remainingMs` становится функцией того же захваченного `deadline`. |

Других writable paths и новых файлов нет. Native-first P08 delivery сохраняется: parent/qualification не получают отсутствующий у них W01 helper или частичный перенос Windows activation. Root сверяет current native preimages перед publication.

### 17.3. Public dependency и прежняя synthetic recipe

Bare `@agent-teams/provider-implementations/codex` из root-level `tools/` не разрешается: эта frozen dependency принадлежит `packages/legacy-agent-host`. Использовать её установленный **public entry target** `../../packages/legacy-agent-host/node_modules/@agent-teams/provider-implementations/dist/codex.js`, с существующими TypeScript declarations. Это ровно `./codex` import target из поставленного package exports, не private internal decoder. Никакого нового root dependency, paths alias, symlink, package pin или provider implementation change.

Дополнительно checked D `91350f829b72f83e613505bb444ff0d9ef98fb0835e3e438b918bbea8d930f94` не экспортирует `decodeCodexConfiguredMcpCatalog` через public entry. Public package / JS / declarations blobs — `edb720f302f8835b431e6a5ed259c27f7ee665d7`, `5ff2d27bb1169626dd4efdbbeda41503ca80687e`, `d44e683c5bb3d12030230e512010550077e694eb`; все равны соответствующим bytes исходного pinned TGZ. Decoder source `43d0fc9353d9ef580ba3c27cfa7e1ef0788d273f` показывает: literal `[]` даёт ровно `{digest: sha256('[]'), servers: []}`.

В прежнем synthetic fixture месте `capturedMcpCatalog: decodeCodexConfiguredMcpCatalog('[]')` использовать уже public `captureCodexConfiguredMcpCatalog({digest: hash('[]'), servers: []})`. Сохраняются metadata/digest до original profile hash, frozen empty server list, existing public `captureCodexMcpPolicy` и `codexMcpPolicyArgs`. Эта TEST recipe не выдаётся за actual native census: прежние реальные metadata/catalog roots, argv, configured policy, tool/result, absence и cleanup assertions остаются без изменений. Private decoder не экспортируется и его реализация не копируется.

### 17.4. Narrowings и один исходный clock

В helper после original `selectedMember && selectedProfile` guard явно проверить `provider === 'codex' || provider === 'opencode'` до возврата member. Это уже единственные два construction arms W01; narrow inferred return type сохраняет runtime refusal остальных variants и делает receipt `protocolRevision` корректным. Для tool iteration положительно проверить сам исходный `memberTools` перед прежними includes/MCP checks и циклом. Не использовать `any`, отключение strict flags, assertion cast или non-null assertion вместо реальной проверки.

У `CapturedHostClient.request` original options контракт — `remainingMs?: () => number` (native blob `2b947608`, request264–284): функция читается непосредственно при admission и ограничивает исходный request timeout. Во всех трёх W01 callers вернуть функцию, вычисляющую остаток **того же уже захваченного absolute deadline**. Helper — `() => remaining(deadline)`; Gate — `() => Math.floor(deadline - performance.now())` внутри прежнего `originalDeadline !== undefined` arm; Scenario — `() => remaining(deadline)` внутри прежнего `providerFixture` arm. Deadline creation, original before/after guards, outer timeout, source recipe, count ledgers и cleanup не меняются. Никаких новых clocks, повторных model inputs, root allocations, retries или увеличения 45s/35s/10s budget.

### 17.5. Проверка и публикация

До source нужны root + independent bounded plan review и plan publication. Source freeze содержит четыре полных файла, exact forward/inverse diffs и line counts; все старые case names/assertions и Claude/default branches сохраняются. Новых unit cases не добавляется: это correction реально остановившегося original compiler gate и его уже существующих consumers, а не новый behavior framework.

Root последовательно выполняет original low-level compiler, неизменный retained-host compiler и исходный protocol test command, затем только требуемые существующие focused/script/size guards. Обе compiler команды и все их strict options остаются обязательными; отсутствие helper в low-level project не означает отсутствие проверки helper. Source PASS/локальный compiler PASS не равен Windows qualification: actual W01 x64 и ARM64 cases должны пройти в следующем обычном CI на соответствующих exact heads, без rerun текущего run, изменения workflow/deadline или превращения отсутствующего native receipt в PASS.

## 18. Windows: explicit product Retry in the same Main, then original Processes UI Stop

**PLAN ONLY; source 0.** Append to exact P08 f32fe430b9b1fc1886d009e7c910f6e49d1c7c6a, after the published W01 compiler correction. This is the connected continuation of W01 / P09 §38, delivered to the native branch first. Root reserves this section and owns plan publication, SOURCE GO, canonical checks, refs and the next ordinary CI. Evidence/source inventory: 66fe531ff425e327892533bb482548474ea076d2. No unmerged Main or new physical owner is implied by this plan.

### 18.1. Concrete remaining product and acceptance gaps

The current native Router ca56af0e stores a captured client per owner, rejects duplicate owner registration, and can only restart that same client object. CapturedHostClient 2b947608 becomes permanently sealed after failure. DesktopBackendFeature 9dfb9058 keeps the same captured object in its clients map and uses that identity in existing registry/import/management/source-currentness closures. A Router-only replacement would therefore be incomplete. The actual TeamDetailView b009c986 load-error surface has no Retry action. The old native ServiceScenario creates its successor through an externally supplied TEST controller; this proves neither product rebind nor a real Processes UI action.

This is distinct from the completed original evidence. Linux 393e7e0a86026e3daddc5597b0543565b89f412f (43582230320/132409208084) starts a new Electron Main after its earlier Host; Darwin 399be4f7807eeaa9cc689ec3cf15e376483fa6af (43582225377/132409194111) combines SDK warm Stop with a separate controlled cold UI. Neither is same-Main Windows evidence. Windows Dashboard 88c4cbefa4f6bf512d40c5db69222b87a178f7e4 (43582225409/132409193650) supplies a working packaged Windows app/bootstrap path, with zero model inputs; it does not prove registered process Stop. Batch4 W01 x64 and ARM64 both stopped before native execution at the same first compiler gate; the §17 fix and local compiler/protocol PASS do not replace actual W01 x64/ARM64 qualification.

### 18.2. Finite existing public route and one explicit user action

Use the existing validated agentBackend.invoke transport and existing captured sender/context guard. Add only two closed operations: host.recovery.capture with an empty payload, and host.recovery.start with exactly one opaque capability string. Both carry the original handle and the same original commandId. The capability has no PID, executable path, owner selector, profile, native key or permission fields. No method is added to Host RPC or the native broker protocol.

Capture can return only a closed ready result, meaning the exact current captured native client is already positively ready and no work was started, or a captured result with one opaque Main-issued capability. Start returns only the closed ready result after the exact candidate completes its original handshake and native bind. Failures use existing invalid/forbidden/hold/unavailable/shutting-down outcomes. Missing callbacks, malformed extra fields, stale/foreign capabilities and absent authority refuse. This result is projected directly in the Main facade and cannot pass arbitrary private objects through the generic Host projector.

The capability is issued only after a positive original-client observation: the existing Main-owned native custody object is present, that exact ChildProcess really had a PID and emitted its own close event, its client is sealed/native-aborted, and the full original owner/handle/source tuple remains current. An error string, timeout, disconnected transport, missing PID, saved journal, process-table absence or ready-looking receipt cannot establish this condition. A positively ready current native client may answer capture read-only, covering a lost prior acknowledgement without making another Host.

The existing real Team load-error surface gains one small Retry component. It uses the existing localized Retry label and Button, is shown for a captured Host selection in Electron Windows (platform presentation is not authority), and retains one original command/capability while pending. The click performs capture and, only for a captured result, start. A ready result requests the original scoped refreshTeamData; no initial Runtime Open, Resume, Launch, message/input, model proof or prior command is replayed. A second click while pending sends nothing. Context change/unmount discards the UI result and prevents a not-yet-admitted continuation; Main owns cleanup once a candidate is admitted. No recovery is initiated by getConnections, getData, process.list, discovery, background refresh or a timer.

### 18.3. Same owner, one candidate, original currentness and shutdown

Retain the finite capability, original full input/scope, cutoff, predecessor client, candidate and one in-flight/result promise on the existing RegisteredOwner. There is no new owner registry, durable journal, generalized retry queue or saved rebind ticket. Each start admits at most one candidate; repeated same-capability/same-command calls join that same promise and recheck current authority around awaits. A capability cannot be replayed against another original client, handle, context or later recovery generation. Another explicit action cannot replace a running/uncertain candidate. Once a known failed candidate is itself positively closed, a later explicit action may capture that exact current predecessor; old capabilities stay non-dispatching. A completed ready candidate may later have its own genuine exit and its own explicit action.

A thin stateless composition helper receives the original descriptor selection, handle definitions, clients map and Router. It uses the existing original source readers; it never calls captureMainWindowsCustody to make a second owner. Reuse the existing CapturedWindowsCustody profile/source parser through a read-only extraction in that same infrastructure file. Keep its original constructor path and checks. Re-read the captured descriptor/private Host profile, original SHA, exact Node/CLI files and source tuple; no latest source search, global preference substitution or mutable renderer inputs are accepted.

Immediately before publication, the original guard, full retained binding, predecessor identity, physical owner identity, source and deadline must still match. Replace the Router record and Feature clients-map value synchronously in one non-awaiting composition step, retaining the same physical custody reference and unchanged handle store/binding. Install the one candidate before awaiting its start. Existing object-identity closures then become stale naturally, and late catches belonging to the old Router record cannot seal the new record. A failed candidate is retained for original cleanup/currentness rather than rolling the maps back over an uncertain effect.

The new client binds to the same RetainedWindowsCustody instance/mainEpoch and exact profile digest through the existing attach path, which already requires previous native-aborted context plus the genuine hostExited promise. Broker, kernel Job, original service HANDLEs, capabilities/generations and pending original control receipts remain with that owner. The new Host obtains the ordinary writer lease through the existing controller protocol; Main neither deletes a lock nor adopts its PID. No native root is reacquired from persisted process metadata.

Shutdown seals recovery synchronously and joins any admitted candidate/start flight and its original client disposal before Feature closes the single retained physical owner. A late source read cannot publish after shutdown or allocate an untracked child. This preserves the existing Main cleanup owner even if the UI disappears or the response is lost.

### 18.4. One original startup cutoff, limited to explicit recovery

The first capture for a genuinely exited client fixes the original deadline before its asynchronous binding/source work, using that captured profile's existing startupTimeoutMs. Replayed capture/start does not create or extend a clock. No timeout/budget field is accepted from the renderer. A read-only ready response admits no work.

Add an optional trusted remaining callback to the existing CapturedHostClient construction/start path, used only by this explicit recovery. The ordinary default client path remains unchanged. Carry the same callback through existing source/Node validation, clip the original Node --version timeout, check it immediately before the actual Host spawn, and use its remaining value for the original handshake and native bind. Check original authority/time again after each await and before publication of readiness. Failure after child creation seals and disposes that same child; no later implicit retry follows. Existing startup/native/default timeouts are not increased.

This is a small admission addition, not a new startup state machine. Keep CapturedHostClient within 800 physical lines, Feature within 800 and TeamDetailView within its unchanged 3750 baseline. Thin calls may delegate the new recovery composition to its cohesive helper; no cap-only code relocation, packing, cap increase or strictness exemption is authorized.

### 18.5. Exact writable production and controlled-case scope

All nineteen existing preimages below were independently fetched at native 0099a763 after §17 source. The Feature predecessor is specifically the published §27/28 9dfb9058 successor, including both original source-selection refresh call changes. Parent and qualification do not receive partial native custody or recovery activation.

| Existing path | Exact native preimage |
| --- | --- |
| src/features/agent-backend/contracts/operations.ts | 31db672efac0bf96cbb00bb8a8b3a319afd17023 |
| src/features/agent-backend/main/adapters/input/validateBackendOperation.ts | eab2e2bb61eae5ad3f1ebcce32712fbde7f51f5d |
| src/features/agent-backend/main/adapters/input/BackendOperationsFacade.ts | b99b2b26e5727cf458cb993befd4bc2abbc5af3b |
| src/features/agent-backend/main/application/BackendOwnerRouter.ts | ca56af0e2b3a706d02189103e65e5410f8116ec6 |
| src/features/agent-backend/main/infrastructure/CapturedHostClient.ts | 2b94760821f9c0154d6e14994ed35fe63a6bb8dd |
| src/features/agent-backend/main/infrastructure/selectedHostProfile.ts | 64da74ac4d9d4280b2d768ce214120b416ab6566 |
| src/features/agent-backend/main/infrastructure/CapturedWindowsCustody.ts | 8d51bdb0480d74afc1d9fb086cdc706b4f6b4437 |
| src/features/agent-backend/main/composition/DesktopBackendFeature.ts | 9dfb9058af5fa1fefbc44d003fd0e7613bfdd8e7 |
| src/features/agent-backend/renderer/createHostBackendRenderer.ts | baddadb15ab013f923036718dc1aec88744a69d2 |
| src/features/agent-backend/renderer/index.ts | 014444eba8be98681ffb69763556f804a235dd5c |
| src/renderer/components/team/TeamDetailView.tsx | b009c986172915e8017beb3501f8bdb21cfa4984 |
| test/features/agent-backend/backendOwnerRouter.test.ts | 974999b069a67b2d7c988a92a44a8b64440f3b04 |
| test/features/agent-backend/capturedHostClient.test.ts | 62e039fed7c0dcef6cb566d2c5dc02968b5415eb |
| test/features/agent-backend/desktopBackendFeature.test.ts | 180ac708a6354e3d03eb1ba1997b818d5e679bff |
| tools/owned-process-broker/nativeRetainedHostGate.ts | f90ac7253d33ed46ef563e8e77403e56ab2d25e8 |
| tools/owned-process-broker/tsconfig.json | ffa71d12592f0449f7000cf0d43f75db6e05c5a4 |
| tools/owned-process-broker/tsconfig.retained-host.json | b9399da33bc4da55ac819f266cf6f279ab057d7a |
| .github/workflows/electron-packaged-ci.yml | bdf3d06491b3d2ad8e0c41c8aa3a23ec85eb1dce |
| scripts/legacy-agent-host/desktop-proof-supplementary-sources.ts | f5708eb7d23a05f11a3a9f383886d3ade653dfb1 |

Four new paths, and no other new source files:

- src/features/agent-backend/main/composition/recoverCapturedHost.ts
- src/features/agent-backend/renderer/HostBackendRetryAction.tsx
- tools/owned-process-broker/nativeWindowsAppFixture.ts
- tools/owned-process-broker/nativeWindowsAppGate.mjs

Production responsibilities are finite. operations/validator/facade add the two closed calls; Router owns the existing-owner capability/flight; client and its existing profile validator enforce the original exit/budget; CapturedWindowsCustody exposes only its existing read-only source validation; Feature supplies one thin original-map delegate. The new renderer component is exported through the existing renderer index and inserted into the existing load-error branch; the existing renderer read-order set classifies only recovery.capture as a read. No TeamsAPI widening, preload channel, HTTP endpoint, source preference API, process DTO or native protocol change is needed.

Use only the three named existing Main test files and their existing cases. Exercise the meaningful boundaries: actual original child-close versus missing/alive/unknown; same-owner successful rebind with one candidate and unchanged handles; duplicate continuation/lost ACK without another start; stale guard/source/foreign capability refusal before effect; ordinary discovery/read does not recover; same fixed cutoff including source/handshake delay; and shutdown during candidate startup retains/disposes it before physical-owner close. Existing case names/assertions remain. No field-by-field permutation matrix or new broad unit suite is authorized. The actual Windows lane below remains mandatory.

### 18.6. Connected packaged Windows acceptance using existing owners and codecs

Extend only the existing win32-x64 and win32-arm64 rows of electron-packaged-ci, with their existing 90-minute job deadline, original matrix and all original assertions/steps retained. Add one finite real-app scenario after the original packaged V2 Host qualification has completed. Do not add a workflow/job or rerun an old journey. Final acceptance requires the original W01 provider/custody cases on both Windows tuples as well as this new UI case; until those real gates pass, source/controlled tests do not establish Windows parity.

Reuse the existing trusted buildAndStageBroker selection and service-scopes-v1 product, original exact vendor-selection input and query/synchronize-only native fixture. Stage the existing scoped broker/manifest into the actual candidate extraResources before packaging. The original native broker C++/protocol, vendor versions, hashes and build timeouts stay unchanged. The new driver reuses packagedArtifact, preparePackagedProfile, packagedTarget and original Windows process/listener ownership helpers; it does not copy their large implementations. Its application executable, app.asar/renderer, Host closure, captured Node and broker are the actual packaged resources, with the existing readPackagedOpenCodeV2 manifest/full-closure verification reused for the Node/Host paths. The earlier packaged V2 qualification retains its source/legacy relocation checks; nothing about that gate is bypassed or reclassified.

Export/reuse the existing native Gate's prepareProfile with one narrow optional captured packaged Node/CLI input, so old Gate calls, their defaults and recipes remain exact. Complete the new fixture recipe before its original hash: actual packaged Node and Host CLI, exact old vendor/Bash, main-windows-v1, one ordinary Claude member, private HOME/workspace, real process.write registration grant, and the original static UI seed. Its small TEST Host wrapper imports that actual CLI and exposes only the existing one-shot crash barrier. It is never a fake provider. The existing preparePackagedProfile result is the base for a new closed immutable app environment with only the two captured descriptor path/hash fields added before first spawn; parent environment is not merged arbitrarily and no field is changed after capture.

The new TEST fixture reuses startProcessModel with its existing windowsScopedServices port, readProcessServices/probeProcessService, original foreground actor, existing strict process receipt/schema parser and original Cdp/UI controls. There is no new model mode or broad model/probe allowance. Its port joins each completion to the exact original public UI Stop command/result, same WindowsServiceCapture and retained query HANDLE evidence. The actual callback may wait only within that Stop's already-started deadline.

The finite sequence is:

1. Launch one actual packaged Electron Main and capture its original PID/birth, application/renderer identity and actual backend handle. Through the existing public Main route, perform the one ordinary initial member Open and the original PROCESS_BOOTSTRAP input. Both original services must be genuinely registered through MCP. Capture the full two original registration receipts before changing lifetime; provider root/mainEpoch/capability/generation and target pid/birth/key must agree with those original records.
2. Retain exactly three observation-only query/synchronize witnesses from those receipts: provider root, primary and neighbor. These confer no stop/adoption authority. Check both original Processes rows from the same Main and exact handle. Validate complete rows, not just count or labels.
3. Trigger only the captured TEST Host-A crash barrier. Establish actual Host A exit while the original Main, provider and both service witnesses remain alive. Do not create another CapturedHostClient in the harness, replace Main, supply another descriptor, delete a writer lock, refresh source selection or send native input.
4. Show the genuine existing Team load-error surface and click its new Retry once. Verify the same Main PID/birth and mainEpoch, one new actual Host B, original source/handle/captures unchanged and ordinary writer ownership recovered by Host B. The public Processes view must again contain both exact original processRefs/tuples. No Runtime Open/Resume/Launch/input occurs after the crash.
5. Use the existing Processes UI Kill control for primary once. Before the next action require its exact completed original scoped Stop/settlement receipt and retained target HANDLE absence, while neighbor and provider are still alive. Then use the same original UI Kill control for neighbor once and require its own exact completed scope/settlement plus absence. This second explicit action permits reuse of the already strict two-scope model protocol; it does not replace the untouched earlier native or Linux/Darwin scenarios.
6. Invoke original product Quit once and require actual Main/App/Host exit, retained provider/service witness completion, no owned native/broker/group/listener remainder, and unchanged source/packaged/native input hashes. Cleanup/observation uncertainty leaves the receipt INCOMPLETE; no taskkill, PID adoption or external cleanup can turn it into PASS.

Read original records only to join these exact observed commands, captures, runtime input and writer/source identities. No fake receipt, synthetic accepted native intent or latest-green search is allowed. The model server is closed once in finally; actual process cleanup stays with the product Main and its original owner. Any fallback cleanup is separately reported and disqualifies the successful acceptance claim.

### 18.7. Explicit counts, clocks, source pins and compiler coverage

The new case uses the existing Claude protocol: one member root, one initial Runtime Open, one business input and exactly four business model POSTs; zero ordinary/Settings probes; two MCP process registrations; two explicit UI Stop commands with their original two native scope Stop/settlement pairs; at most the existing two native notification acknowledgements. There is no business request after Host A exit. The same provider root stays retained until final Quit. Original Main startup plus the one explicit successor perform their ordinary Node validation/handshake, with exactly one Host successor; neither is a provider ModelProbe. Build/vendor preparation is separate pre-App work, not disguised inference. No new native allocation is authorized by the recovery path beyond the one replacement Host child; cold control is only read/lookup/Stop of the retained service captures.

Each of the three query witnesses uses the existing maximum of four zero-time observations and one wait: provider alive after bootstrap/Host exit/Retry/final scoped Stops; primary alive before crash/after Retry then absent after its Stop; neighbor alive before crash/after Retry/after primary Stop then absent after its own Stop. Existing source/writer/runtime records and independent whole-family census remain required. The evidence reports what was observed; numeric PID metadata by itself never becomes product authority.

One 300-second outer TEST case cutoff is fixed before App startup and only clips existing segments: original packaged startup ≤120s; original initial Open ≤45s; original PROCESS_BOOTSTRAP turn ≤35s; original Host-exit observation ≤10s; Retry limited to the captured original profile startup timeout (the reused fixture is 10s, including source validation/handshake/bind); each original UI Stop ≤10s; the existing original cold-process Quit observation ≤30s, with one existing ≤3s Quit acknowledgement wait inside that phase. These sum below the outer limit. UI/readonly polling must check the active original phase cutoff, without renewing it after a reply. No job deadline, native actor TTL, protocol bound or old case timer is increased. Failure cannot be repaired by another click/Host/input/model request.

The new app fixture is an integration entry: add only that file to the existing low-level compiler exclusions, and include it explicitly in the original retained-host project. Both original compiler commands and strict flags remain mandatory. The new .mjs app driver uses the established Windows .mjs harness style and receives a parser check; its imported typed fixture/Gate remain in retained-host compilation. Do not drag the Main graph under the low-level project's flags or disable checking. The original 49 protocol cases remain the same.

Append a separate finite Windows Retry source-list export to the existing supplementary roster; do not change the original roster order/default arrays. The new driver combines the existing complete desktopProofSources with that explicit list. In addition to all new production/driver files, the list pins the reused Windows Gate, native witness/events/vendor selectors, both original compiler configs, build selector, packaged/platform/CDP helpers and the exact packaged workflow. The concrete extra construction roots, absent from the base roster snapshot, are:

- src/features/agent-backend/main/infrastructure/CapturedWindowsCustody.ts
- tools/owned-process-broker/nativeRetainedHostGate.ts
- tools/owned-process-broker/tsconfig.json
- tools/owned-process-broker/tsconfig.retained-host.json
- .github/workflows/electron-packaged-ci.yml
- src/features/agent-backend/main/composition/recoverCapturedHost.ts
- src/features/agent-backend/renderer/HostBackendRetryAction.tsx
- tools/owned-process-broker/nativeWindowsAppFixture.ts
- tools/owned-process-broker/nativeWindowsAppGate.mjs
- tools/owned-process-broker/nativeGateContext.ts
- tools/owned-process-broker/nativeGateEvents.ts
- tools/owned-process-broker/nativeVendorInputs.ts
- scripts/build/buildOwnedProcessBroker.ts
- scripts/e2e/opencode-diagnostics/packaged.mjs
- scripts/e2e/opencode-diagnostics/platform.mjs
- scripts/e2e/release-updater/cdp.mts

This is a source pin list, not runtime discovery or import traversal. All new files are at most 800 lines, all existing caps stay unchanged, and all old source/default branches are checked by exact inverse at freeze. Frozen source lists and actual packaged/broker/Node/CLI/vendor hashes are captured before App and checked after original cleanup.

### 18.8. Review, source and acceptance gates

Before source: root and an independent agent review the exact plan, root composes any now-current predecessor changes, publishes the append, and gives SOURCE GO. Scope additions or a failed physical prerequisite require an explicit amendment; the plan itself does not authorize a generic recovery service or code outside the table.

Source freeze must provide all exact native variants, full forward/inverse diffs, physical line counts and the unchanged old branch/oracle evidence. Root runs the original focused Main cases, full app type/lint/size gates where available, both unchanged broker compiler commands, original protocol cases and only the required script guards. Native/packaged evidence comes from the next ordinary CI at exact published heads. All W01 provider cases and the new real-app scenario must pass on both x64 and ARM64 before this parity item is complete. Current POSIX §75 remains its distinct issue; neither this plan nor earlier Linux/new-Main receipts resolves it.

### 18.9. Reachable explicit Refresh, then separate Retry, while Team data is retained

This is a bounded correction to the unpublished section 18 source, not a claim that the packaged scenario has run. The existing `teamSlice` catches preserve an already selected/cached Team snapshot but clear `selectedTeamError`. The original `TeamDetailView` renders its error branch before its data branch. Consequently a genuine failed Host read cannot expose the proposed error-only Retry while keeping the original Processes rows visible. A same-Team tab click is not a replacement for this missing route: `TabBar` calls `setActiveTab`, but `tabSlice` and the two TeamDetail selection effects skip a full read when the same Team is still selected. Page reload, tab restoration, synthetic store writes and an inferred refresh are not acceptance mechanisms.

The source-backed unavailable presentation accepts exactly two existing complete strings: `Host team read unavailable`, emitted by `readHostPagedSnapshot` after a refused original scoped snapshot, and `Host teams unavailable`, emitted by `createHostTeamsApi.connections` when the original public discovery is held. The latter is essential: `registerBackendConnections` calls `discoverBindings`, whose original registry/retirement read may encounter a sealed owner before any snapshot. Its existing catch returns hold with no bindings. An earlier failed request may already have sealed that owner, so this appendix does not promise discovery or `ownerBinding` remains readable. Neither string proves child exit, native custody release or permission to create a successor. They only select presentation for the same cached Windows Electron canonical Host key.

Keep `ownerBinding`, discovery, registry/retirement reads and all ordinary request/start/readHandle guards unchanged. Original `CapturedHostClient.start` refuses a sealed or quiescing predecessor before `open`; Refresh cannot allocate its successor. The existing Retry handler derives the original opaque handle directly from the retained canonical Team key and invokes capture/start without calling `getConnections`. Only those separate Main operations may admit recovery, with the same positive actual-child-close, original custody, currentness and immutable source checks from section 18. A held discovery caused by anything else may expose the control but cannot pass those independent checks.

Use the already approved new `HostBackendRetryAction.tsx` as one cohesive recovery surface around the existing `renderBody()` result. Its props add `children` to the original `teamName` and `onReady`; the surface reads only the matching selected Team's existing data/error. A call-time pure predicate uses the original canonical Host selection parser, Electron-mode check and Windows presentation check. The error predicate additionally requires exact equality with one of the two complete strings above, without substring/foreign-error matching. These exported predicates are available through the existing renderer public index and do no module-initialization API/store/platform reads.

For a Windows Electron captured Host Team with retained data, the surface always keeps the existing localized **Refresh** action available, including while either exact unavailable error is already retained. That click invokes only the supplied original `refreshTeamData(teamName)` callback, once. It cannot invoke recovery capture/start or change the Host client. If the read publishes either exact unavailable error, the surface additionally presents the existing localized load-failure message and a separate **Retry** action; Refresh remains present. Recovery is possible only on a subsequent explicit click, using the same section 18 capture/start sequence, one command ID, closed result validation and original context/epoch/mount/currentness checks. The same synchronous pending flag disables both actions during either request; completing Refresh must not fall through into Retry. An earlier genuine background read may already have retained the exact error, but it cannot remove the driver's required explicit Refresh or turn it into a conditional skip. After a successful recovery, the existing original callback refreshes metadata once. No periodic read, read-effect recovery, automatic retry, Runtime operation, business input or model probe is added.

The two existing cached-data catch arms in `teamSlice` retain either exact error only when the call-time Windows/Electron/canonical-Host predicate also holds. They retain the exact old selected data/cache references and all current request/context/token/nonce checks. Successful original reads clear the error as before. Generic transient failures, legacy Team keys, browser mode and non-Windows mode keep their original error-clearing behavior. The surface returns the original children in those modes; it does not hide retained data or add a control. Other error/draft/provisioning branches remain unchanged. On either exact retained Host unavailable error only, TeamDetail bypasses its full-page error branch and keeps the original data body. One flex column surface reserves a finite banner/action area and a min-height-zero body; it does not duplicate the Retry component or place a banner alongside an unbounded size-full sibling.

The change adds exactly two existing writable paths to section 18, verified at native repair `3ebdb7`:

| Additional path | Exact preimage | Existing line limit |
| --- | --- | --- |
| `src/renderer/store/slices/teamSlice.ts` | `18c1b1e647ea733a51e58892f35daa931040e206` | 4992 current; 5020 frozen ceiling |
| `test/renderer/store/teamSlice.test.ts` | `113ccdf9edb63cd350f349b01f77850d0e26997d` | Existing TEST; preserve original declarations/assertions |

The already approved component, renderer index and TeamDetail are sequential successors of the exact renderer4 candidate manifest `6dfcc8e9fdd21bd5b58a14d1b053896d89f49d0f`; that candidate is not published source. Keep the same filenames and facade semantics. Remove the previous four-line error-only insertion, use one normal three-line wrapper around `renderBody()` and the shared exact-error predicate in the old error condition. With the naturally multiline predicate import this leaves TeamDetail at 3750, its unchanged ceiling; no packing, cap-only extraction or unrelated cleanup. Other section 18 Main APIs and source preimages are unchanged. The total approved section 18 source scope becomes 21 existing paths plus the same four new paths.

Extend only the existing Team-slice transient-error/cached-selection cases. Preserve their legacy Network-timeout assertions, then prove the two exact Windows Host unavailable outcomes retain the same selected/cache data and their original error, both original read entry points obey the same rule, and the next successful original read clears it. Include the essential browser/non-Windows refusal of this presentation branch without a field-by-field matrix. No new case declarations, test file, mock recovery authority or UI polling framework is introduced. The original focused Main cases retain their sealed ordinary-read refusal and recovery authority assertions; the two presentation strings do not turn those refusals into successful metadata reads. The actual packaged UI remains the complete Refresh-to-separate-Retry action/currentness/custody gate.

The native driver first displays the real original Processes rows, obtains the original positive Host A exit observation, then clicks this real **Refresh** once and observes one of the two exact unavailable errors through the recovery surface while the same rows/data remain. That click and observation fit inside the already bounded original 10-second Host-exit phase; they do not start another phase clock. Only then does the separate **Retry** click start its existing bounded recovery phase. The complete phase budgets, 300-second outer deadline, model/native counters, one successor, two original Kill actions and final Quit remain unchanged. The original sealed discovery or snapshot must retain its original refusal; an unexpected successful read or absent surface does not authorize a fallback call, re-click, reload or native operation.

Keep the existing source roster arrays/order unchanged. The new separate Windows source-list export still pins all section 18 construction roots; the complete base `desktopProofSources` already names `teamSlice.ts`. Add the existing Team-slice TEST path to the Windows-specific list so the new critical oracle is also frozen. Check the combined list for exact coverage, with no import traversal or duplicate-list workaround. Root must publish this exact appendix and give SOURCE GO before these two additional paths or the renderer successor are edited. Root retains all execution/publication ownership; no native/UI qualification follows from this plan or its source review.

### 18.10. Keep the renderer import graph lazy and freeze the existing Main oracles

A source read during section 18.9 found one initialization cycle: the Team slice imports the public backend renderer entry, that entry exports the recovery component, and a runtime import of `@renderer/store` from that component reaches the store initializer before the slice's `const createTeamSlice` is initialized. The existing renderer API uses a lazy proxy, but that does not remove the component-to-store edge. The localization hook/provider has no such store import.

Within the same six approved renderer/Team-slice paths, the recovery component uses only a type import of the original store hook and accepts `store: typeof originalUseStore`. `TeamDetailView` supplies its already imported original `useStore`. The component binds that stable prop to a local hook name and calls it unconditionally; all original selectors, `getState` reads, context/epoch/mount checks and synchronous shared pending admission remain unchanged. No new store, hook factory, subscription owner, eager API read or extra file is added. Name the shared two-error predicate `isHostReadUnavailable`; the natural two-name public import and normal multiline wrapper keep TeamDetail at its original 3750-line ceiling without packing or cap-only extraction. This is dependency wiring, not a change to either action or Main authority.

The already approved separate Windows source list also pins the three existing Main oracle files `test/features/agent-backend/backendOwnerRouter.test.ts`, `test/features/agent-backend/capturedHostClient.test.ts` and `test/features/agent-backend/desktopBackendFeature.test.ts`, alongside the section 18.9 Team-slice test. They are qualification inputs, not production imports. Keep all prior roster arrays/order and production construction roots unchanged; these are three extra literals in the already writable supplementary roster. No new test declaration or write path is authorized. All section 18/18.9 time, counter, cleanup, source and currentness gates remain required.
