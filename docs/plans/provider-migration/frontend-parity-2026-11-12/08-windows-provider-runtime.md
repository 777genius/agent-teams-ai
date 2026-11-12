# 08. Windows: полноценный Host runtime для Claude, Codex и OpenCode V1

Статус: план реализации; production-код не изменён. R1/R2 выполнены ниже; R3 — pending.
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

## 4. Минимальное решение и повторное использование

Сохраняется `CapturedProcess` и существующие provider adapters; новый supervisor/framework не вводится.
Добавляется один малый общий Windows launch helper и расширяется existing native profile validation.
Windows Job kernel/custody переиспользуются вместе с их existing native tests.

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
- `WindowsJobKernel` и `createWindowsJobCustodyForKernel` остаются единственной реализацией Job ownership.
- V2 продолжает использовать ту же dependency; совпадающие bytes не загружаются под двумя независимыми владельцами.
- Передать tree source в Claude/Codex/V1 runtime adapters и short-lived management/model/auth children.
- Обнаруженный child остаётся собственностью launch даже при rejected configuration или отказе bootstrap.
- Любой выполняемый root помещается в Job до начала его исполнения: ранний descendant возможен до первого provider input.
- Existing `CapturedProcess.spawn` → `WindowsJobCustody.capture` → `kernel.assign` не обеспечивает этот barrier.
- До adapter wiring выбрать и квалифицировать узкий native create-in-job bridge: создание уже в Job либо suspended create,
  assignment и только затем resume. Отсутствие воспроизведённой гонки не разрешает оставить spawn-then-assign.
- Bridge сохраняет existing stdin/stdout/stderr transport и exact recipe; сканирование PID после запуска его не заменяет.
- Отказ assignment/capture или cancel до resume завершает original suspended root, закрывает Job/handles и не разрешает input.
- Retained Job handle позволяет закончить cleanup после root exit; handle закрывается ровно после подтверждённой очистки.
- После Host crash новый Host читает durable UNKNOWN и разрешённое восстановление; он не принимает numeric PID за ownership.

## 5. Порядок реализации и затрагиваемые места

1. **Сначала native harness и baseline.** Расширить `windows-job-custody.native.ts` и existing mixed fixture:
   зафиксировать executable, launcher kind, path cases и проверку barrier для раннего descendant.
   Выбор native bridge — обязательное входное решение, а не условие, зависящее от удачного расписания теста.
   Выпустить failing receipt для каждого отсутствующего маршрута; не маскировать unsupported skip как PASS.
2. **Общий path/recipe capture.** Изменить `nativeProcessProfile.ts`, `runtimeProfile.ts`,
   `management/profile.ts`; небольшой helper расположить рядом с `CapturedProcess.ts`.
   Учесть `mcpPolicyPlugin.path`, cwd и все provider config roots, а не только executable.
   Новые profile fields остаются private composition; старые POSIX profiles читаются без миграции active sessions.
   Для старого Darwin corpus проверить исходные bytes/digests до и после чтения; новые discriminator fields не дописываются назад.
3. **Общий native loader.** Изменить `WindowsJobCustody.ts`, `OpenCodeV2EmbeddedGraph.ts`,
   `OpenCodeV2EmbeddedServer.ts`; добавить shared dependency capture без копирования всей V2 dependency graph.
   Проверить OS/arch/ABI/digest до загрузки; несовпадение прекращает новый launch до provider input.
4. **Runtime wiring.** Изменить `MemberProvider.ts`, `createRuntimeMemberProviderFactory.ts`,
   `ClaudeMemberProvider.ts`, `CodexMemberProvider.ts`, `OpenCodeMemberProvider.ts` и `CapturedProcess.ts`.
   Один immutable source создаётся composition; adapters не выбирают другую native библиотеку самостоятельно.
5. **Короткие операции.** Подключить тот же launch/custody путь к `ClaudeManagementHost.ts`,
   `ClaudeAuthConversation.ts`, `CodexManagementHost.ts`, `OpenCodeManagementHost.ts`, `readCodexMcpCatalog.ts`.
   Координировать с auth/model планами, не переписывать их business workflows здесь.
6. **Packaging.** Расширить `scripts/legacy-agent-host/prepare-opencode-v2-native.ts` и candidate staging
   минимальным общим native dependency input; provider-specific graph остаётся provider-specific.
   Изменить `stage-opencode-v2-packaged.ts`/candidate manifest там, где сейчас ресурс доступен только V2.
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
| W02 | Пробелы/кириллица, supported `.cmd`/npm shim, captured env с case aliases | Правильные argv/cwd/config; нет command injection/другого PATH binary; неизменная выбранная identity |
| W03 | CLI сразу создаёт descendant; parent выходит до ответа; отдельно cancel/assign failure до resume | Root не исполняется до Job admission; потомок не выходит из Job; failure не оставляет root; cleanup требует отсутствия всего дерева |
| W04 | В середине input Stop одного member, второй работает; потерян ACK Stop | Один captured stop effect; second member продолжает reply; retry возвращает receipt, не сигналит новый PID |
| W05 | Crash Host после tool effect и durable admission, затем cold reconnect | Нет повторного input/tool; original UNKNOWN виден; новое поколение не принимает старую numeric identity |
| W06 | Auth/model/catalog timeout или cancel на short-lived native child | Нет оставшегося child/Job; повторная операция возможна; concurrent session не остановлена |
| W07 | Stop → exact checkpoint → cold Resume, затем fresh relaunch | Resume сохраняет нужную native history; fresh run имеет новую identity; оба cleanup подтверждены |
| W08 | Packaged candidate, checkout/legacy/runtime search paths недоступны | Bundled exact native ABI загружен; Launch/tool/Stop работают; подменённый artifact отклонён до input |

W01, W03, W06, W08 обязательны на каждой заявляемой паре provider/Windows arch из baseline таблицы.
Остальные сценарии распределяются по provider/transport рискам; общая матрица не требует всех сочетаний моделей.
W03 нельзя закрыть лишь controlled child: после него actual supported launcher также проходит boundary.
Для W03 controlled fixture подтверждает порядок admission/resume; один успешный timing race не доказывает отсутствие окна.
Ограниченный Darwin regression включает неизменность старой serialized identity, а не только успешный новый launch.
Cold UI/registered service identity из плана 09 не считается выполненной W05 автоматически.

## 7. Узкие unit-проверки и доказательства

Точечные units нужны лишь для новых опасных правил escaping/env ambiguity и отказов native admission/retirement,
которые не покрывает existing harness; реальные ancestry, создание потомков и cleanup доказываются native journeys.
Не добавлять snapshot каждого mapper или копию oracle под новым именем.
Existing `windows-job-custody.test.ts` расширяется; отдельный generic framework для тестов не создаётся.
Каждый native receipt содержит commit/tree, OS/arch/build, provider version/digest, launch/session/Job identity,
состояния original root/descendants и foreign neighbor до/после, exit/cleanup и границы inference.
`cleanup=true` требует OS observation; UNKNOWN/timeout/metadata terminal сохраняются отдельными полями.
Новые сценарии сопровождаются typecheck, focused existing suites и source-size/architecture guards.
Полный итоговый CI и сохранение receipts принадлежат плану 10; повторные native прогоны нужны по изменённой границе.

## 8. Объём, зависимости и риск

Оценка после reuse: **900–1 800 production LOC**, **1 000–1 800 test/E2E LOC**.
Считаются новые/существенно изменённые строки; перенос Windows loader, vendor/generated/lock и тесты планов 06/07/09/10 не прибавляются.
Диапазон включает обязательный небольшой create-in-job bridge; если actual launcher требует нового большого transport,
оценка пересматривается после W03, а функциональность не исключается ради исходной цифры.
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

- **R2-08-01:** условный bridge оставлял доказанную структуру spawn-before-assign. Теперь native admission до исполнения
  обязателен; W03 проверяет раннего потомка и отказ/cancel до resume, без объявления PID scan решением.
- **R2-08-02:** общий path helper мог незаметно изменить hash прежних Darwin записей. Добавлен byte-preserving decoder
  и чтение legacy corpus без записи/нового binding; новую схему используют только новые captures.
- **R2-08-03:** фраза «обе архитектуры» могла обещать отсутствующие provider tuples. Введён явный baseline census;
  все заявленные маршруты обязательны, native proof и original Desktop proof остаются отдельными.
- **R2-08-04:** unit-бюджет мог дублировать native harness. Оставлены только локальные опасные инварианты;
  общий Job loader принадлежит P08, Processes не получает второго supervisor.

R3: pending — повторная критика исправленного плана и runnable acceptance matrix.
Реализация начинается только после завершения требуемых кругов планового review.
