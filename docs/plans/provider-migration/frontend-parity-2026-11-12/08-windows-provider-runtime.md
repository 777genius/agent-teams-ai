# 08. Windows: полноценный Host runtime для Claude, Codex и OpenCode V1

Статус: план реализации; production-код не изменён. R1/R2 выполнены; R3 design-check и поправки внесены ниже.
Native qualification остаётся pending; документ не объявляет готовый Windows runtime или завершённую приёмку.
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
P09 поздняя service registration/subtree этим не закрывается. Production и native execution этим дополнением не подтверждены.
