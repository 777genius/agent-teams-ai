# 09. Processes: registry, состояние, история и Stop на Windows/Linux

Статус: план реализации; production-код не изменён. R1/R2 и focused R3 выполнены; Windows service-launch gate открыт.
Область: M19 существующего frontend, без нового process supervisor и без Stage 2.
Main не сливается; выпуск/включение Host по умолчанию в этот план не входят.

## 1. Baseline и подтверждённый разрыв

- Actual main: `4a0e06277fe216d9f82dbbede362668fe46622ee`.
- Stage 1: `1d0f97f55de566036c970eab4f36b84620afdb3f`, tree `ec540290c86af9755c94e52ac795aeda8586a98f`.
- Строки прежних планов M19 — oracle обязанностей; старый scoped PASS не распространяется на другую OS.

| Существующий путь | Immutable source | Что сохраняем |
| --- | --- | --- |
| Processes: label, PID, member, port/URL, running/stopped, время и Stop | [main ProcessesSection](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/renderer/components/team/ProcessesSection.tsx) | Тот же раздел и действия; история после reload |
| Agent регистрирует service; list проверяет liveness; stop/unregister меняет registry | [main processStore](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/agent-teams-controller/src/internal/processStore.js) | Существующие поля, регистрация, stable row, metadata semantics |
| UI Stop вызывает cross-platform остановку | [main TeamDataService](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/main/services/team/TeamDataService.ts), [processKill](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/main/utils/processKill.ts) | Остановка выбранного service; Windows baseline использует `taskkill /T`, Unix — SIGTERM |
| Новый Host уже хранит original capture и durable Stop receipt | [TeamProcessCommands](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/process/TeamProcessCommands.ts) | Requested до native effect, idempotency, original-ref lookup, UNKNOWN |
| Нативная реализация Stage 1 доступна только Darwin | [processCustody](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/composition/processCustody.ts), [contracts](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/process/registeredProcessContracts.ts), [artifact loader](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/process/readPackagedProcessArtifact.ts) | Добавить Windows/Linux backend, сохранив существующий Darwin |

Подтверждённый gap — не отсутствие всего Processes UI: он уже умеет `processRef`, `observation`,
`canTerminate` и pending Stop. Не хватает native identity/capture/observe/signal на Windows/Linux.
`RegisteredProcessCapture.target/root` сейчас жёстко имеют `DarwinProcessIdentity`.
`validateProcessRecords.ts` и loader требуют qualified Darwin build.
Пяти-платформенный V2 Job cleanup не доказывает остановку одного зарегистрированного service.

## 2. Границы с соседними планами

P08: provider launch, original root/tree custody, Windows ABI loader, cleanup всей своей runtime allocation.
P09: доказанная связь конкретного service с original provider, registry/history, targeted UI Stop и восстановление receipt.
P06: publication следующего профиля. P10: upgrade и итоговая packaged Desktop matrix.
Windows kernel/ABI selection из P08 используется повторно; второй loader/process registry не создаётся.
Linux native identity/signal adapter и его artifact относятся к P09.
UI не получает handle, native token, путь к библиотеке или разрешение сигналить произвольный PID.

Supported delivery: Windows x64/ARM64, Linux x64; Darwin x64/ARM64 сохраняется и регрессируется.
Linux ARM64 не добавляется из-за наличия теоретически переносимого C/TS кода.
Внутри этой OS-матрицы берутся заявленные provider/launcher tuples из baseline P08;
наличие V2 package не доказывает регистрацию service любым другим provider.
Список проверенных OS/kernel/ABI записывается в candidate receipt; несовпадение нельзя превращать в PASS.

## 3. Acceptance: что пользователь должен получить

1. Реальный SDK/CLI создаёт TEST service и регистрирует его штатным process/MCP маршрутом.
2. Original Processes UI показывает label/member/PID/port/URL, реальное состояние и сохранённую историю.
3. Один Stop завершается наблюдаемой остановкой выбранного service; foreign process и другой service живы.
4. Windows сохраняет обычную остановку дочерних процессов выбранного service; весь provider Job не уничтожается ради одной строки.
5. На Unix сохраняется прежний targeted signal; полная runtime-tree cleanup принадлежит P08, а не UI metadata.
6. Stop/unregister metadata сами по себе не доказывают OS остановку и не удаляют pending native obligation.
7. После lost ACK/crash повторное чтение наблюдает original receipt; завершение требует OS evidence, новый PID не сигналится.
8. После relaunch строки имеют новую process incarnation; прежняя строка остаётся историей и не выбирает новый процесс.
9. Старые Darwin captures, metadata-only rows и read-only чужие Team данные читаются без разрушительной миграции.
10. Package содержит exact native artifact; для работы не нужны compiler, SDK headers, system Node или checkout.
11. Живой original после `requested`-before-native crash можно остановить явным повторным действием;
    чтение/lookup не сигналит, pending не блокирует этот случай навсегда, replacement остаётся untouched.

## 4. Минимальные контракты и OS backends

Сохраняются `RegisteredProcessNative`, `RegisteredProcessRootSource`, `TeamProcessCommands`,
controller storage, Main/Host transport и существующий `ProcessesSection`.
Добавляются два небольших OS adapters; dispatcher — явный switch по выбранному supported tuple.
Не вводятся второй event log, framework регистрации, универсальный RPC `kill(pid)` или daemon.

### 4.1. Capture и долговечная identity

- Новая capture version использует discriminant платформы и неизменный registrar:
  `backendId/teamId/runId/memberId/generation`, original root и target identity.
- Darwin v1/v2 читаются прежним decoder; их persisted bytes/hash/processRef не переписываются для удобства новой схемы.
- Windows identity основана на original process handle, PID, creation FILETIME и проверенном executable identity.
- Linux identity включает boot/start identity и original process handle; signal выполняется через pidfd.
- Handle существует только внутри adapter; durable capture содержит проверенные identity fields, не числовой handle/address.
- Captured identity не образуется из одного PID, команды, label, port, имени файла или текущего UI selection.
- При регистрации native backend доказывает принадлежность живому original root, включая требуемую ancestry/membership.
- Обновление label/URL не меняет incarnation; новое создание процесса получает новую capture и processRef.
- Старые metadata-only rows остаются видимыми; они не повышаются до OS kill authority задним числом.
- Если stopped-import сохраняет legacy row, действие к живому legacy owner остаётся у него до остановки/перехода.
- Unknown platform/version сохраняется как неподдержанная read-only история либо явный bounded error, не как пустой список.

### 4.2. Windows: проверенный reuse и незакрытая граница service birth

- `WindowsJobKernel` умеет original HANDLE/FILETIME/executable, `isMember`, Job count/terminate; ancestry/adopt/subtree API в нём нет.
- Existing `owned-process-broker` создаёт **один новый root** в собственном ненаследуемом no-breakaway Job:
  `PROC_THREAD_ATTRIBUTE_JOB_LIST` + `CREATE_SUSPENDED`; `resume(installOwner)` допускает выполнение после записи owner.
- `Stop` держит original root HANDLE, вызывает `TerminateJobObject` только своего Job и требует fresh `ActiveProcesses=0` + root exit.
- [S-broker: native admission/Stop](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/tools/owned-process-broker/broker.cpp).
- [S-port: existing allocation/resume/Stop contract](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/src/main/utils/ownedProcess/contract.ts).
- Его protocol имеет Launch/Resume/Stop/Release/RootExit: нет adopt existing PID, descendant-handle inventory,
  arbitrary subtree selection, read-only Job observation или cold reconnection к unnamed Job. Stop не заменяет чтение.
- [S-wire: actual finite opcodes](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/tools/owned-process-broker/protocol.h).
- На исходном S это был unactivated slice. P08 wiring в
  [`a6839b7`](https://github.com/777genius/agent-teams-ai/commit/a6839b77455f32fe701ca944bdc11a9c7a39f5a8)
  уже подключает broker к `CapturedProcess` при captured Windows profile; реальные Windows vendor/packaged проверки ещё обязательны.
- Main/Host `process_register` получает PID **после запуска**. Existing actual SDK fixture сначала создаёт два Bash background services,
  затем регистрирует primary: один provider Job содержит и выбранный service, и живого соседа.
- [S-journey: actual birth-before-register](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/scripts/legacy-agent-host/desktop-native-process-model.ts).
- Поздний `AssignProcessToJobObject(target)` не помещает прежних children в новый Job. Snapshot/PPID scans и повторные обходы
  не закрывают новые births; уничтожение provider Job нарушает targeted Stop. Подтверждённого handoff primitive в source нет.

**Проверяемый минимальный кандидат:** тот же broker запускает provider с `DEBUG_PROCESS`; его existing admission thread
принимает kernel `CREATE_PROCESS_DEBUG_EVENT` до первого user-mode исполнения каждого наблюдаемого потомка.
Original event HANDLE дублируется, проверяется членство в outer Job; процесс получает собственный private nested Job до `ContinueDebugEvent`.
Будущие children наследуют цепочку Jobs, поэтому поздний `process_register` выбирает уже удерживаемую service scope.
PID/birth только сопоставляют запись с kernel-captured original; `OpenProcess(pid)` не создаёт authority.
Stop выбранного nested Job сохраняет provider и соседний service; duplicate request не создаёт второй native attempt.
Это отдельная TEST build variant существующего broker, пока **не production режим и не доказанная SDK совместимость**.

[Debugging Events](https://learn.microsoft.com/en-us/windows/win32/debug/debugging-events),
[WaitForDebugEvent](https://learn.microsoft.com/en-us/windows/win32/api/debugapi/nf-debugapi-waitfordebugevent) и
[Nested Jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs) описывают нужные primitives.
Job `NEW_PROCESS` notification не заменяет этот путь: доставка не гарантирована, PID может уже относиться к другой incarnation
([completion port contract](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_associate_completion_port)).
Debug chain может прерваться, если потомок сам запускает новый `DEBUG_PROCESS`; такой service без original retained record остаётся unknown.
Существующая scope наблюдаемого предка продолжает охватывать унаследованные Jobs; это не доказательство полного census всех service roots.
Late `DebugActiveProcess`/snapshot не являются fallback. Если debug режим несовместим с native SDK, нужен реальный pre-birth launch seam:
Claude `PreToolUse.updatedInput` и D Codex app-server client сами по себе его не предоставляют.

**09-WG — ограниченный feasibility gate до registry/UI wiring:**

1. В existing native gate подготовить две private service scopes внутри живого outer fixture; дети до/после register,
   root-first exit и Stop первой. Original handles/health второй и outer process должны доказать сохранение соседей.
2. Сначала выполнить TEST debug-service native gate, затем проверить **actual** current provider/tool paths с тем же debug admission,
   включая два services из одного native shell task. Проверить loader breakpoint/exception semantics, native SDK handshake, stdio,
   provider root-first exit, bounded handle retirement и ненаблюдаемую debug chain; fixture не квалифицирует эти vendor случаи.
   Сохраняются прежний Bash/exec/background результат, registration PID, stream/notification semantics; одна allocation на весь shell
   недопустима, если Stop выбранного service убивает второй service из того же task.
3. Если native provider несовместим с выбранным debug seam, описать точное минимальное source изменение и пересчитать работу;
   обычные уже запущенные services нельзя объявить metadata-only и считать весь M19 выполненным. Без seam Windows baseline открыт.
4. Для выбранного service-scoped пути согласовать async broker boundary: `RegisteredProcessNative.signal` сейчас synchronous,
   тогда как broker Stop async. Requested сохраняется **до** await; read остаётся без signal, duplicate не создаёт второй attempt.
5. Если projection должна видеть children после root exit, добавить небольшой read-only Job observation в тот же private protocol
   или доказать иной existing путь; **сейчас такого opcode нет**. RootExit/PID gone не является tree cleanup.
6. Прогнать actual SDK M19-01/02 на Windows x64/ARM64; controlled native gate отдельно квалифицирует primitive, не заменяет Desktop.

P08 provider Job и service nested Job не смешиваются в authority: provider Job никогда не получает service Stop.
При control/Host loss kill-on-close может остановить service; cold lookup наблюдает original outcome, не открывает новый Job по PID.
Existing broker сохраняет unknown attempt и genuine private receipt; не создавать второй durable journal поверх `TeamProcessCommands`.

### 4.3. Linux

- Небольшой N-API adapter открывает pidfd для exact original target и удерживает его на observation/signal boundary.
- Original identity и ownership проверяются до действия; проверка по `/proc` без удержанного kernel handle недостаточна.
- Reopen после restart допустим только из durable captured identity с проверкой incarnation, а не из UI PID.
- PID сменился до/между проверками: `stale`/`absent`, без signal новому процессу.
- Kernel без требуемого pidfd API явно не квалифицирован; build/run proof фиксирует minimum kernel/ABI.
- Никаких `kill(-pid)`/shell `pkill` как fallback для неподтверждённой registered identity.
- Переиспользовать existing native artifact build/selection, добавив Linux source и tuple; не компилировать при старте приложения.

### 4.4. Observe, Stop и recovery

- Состояния остаются `same-live`, `absent`, `stale`, `unknown`; uncertain не отображается как «остановлено успешно».
- Existing durable receipt записывается до native signal; accepted означает запрос, а не подтверждённое завершение.
- Repeated commandId возвращает original receipt; `lookup` наблюдает тот же captured target и никогда не посылает signal.
- Crash между requested/signal/ack не запускает автоматический новый signal; история сохраняет исходный original-ref.
- `same-live` после requested-before-signal crash не доказывает known-not-sent; исходный intent никогда не исполняется заново.
- Тот же Processes row различает «проверить результат» и явный «повторить остановку»; нового экрана/постоянного polling нет.
- Явный retry создаёт новый commandId в прежнем journal с immutable `retryOf` текущего recovery-head commandId,
  original processRef/capture digest и current authority. Перед записью/действием повторно проверяется та же incarnation.
- `lookup`/refresh, повтор прежнего commandId и потерянный ACK не создают retry. Один retry commandId допускает один native attempt.
- Existing `view` запрещает любое pending и отказывает при двух requested одной capture; просто снять `!pending` недостаточно.
  Owner признаёт только одну линейную recovery-цепочку для exact target, без forks; повторная доставка child intent идемпотентна.
  Проекция отдаёт узкое `canRetryStop` при current authority/same-live, не превращает обычный `canTerminate` в обход pending.
- Предыдущий UNKNOWN сохраняет историю/неопределённость; linked intent не переписывает его в known-not-sent/успех.
  Projection показывает один актуальный recovery head, включая unregister case; отсутствие original завершает observation
  каждой связанной записи без signal и без потери сведений о том, чей native attempt был accepted/unknown.
- При `absent`/`stale`, замене row/capture или потере current authority retry не сигналит.
  Контракты нового receipt читают старые записи без добавления полей и сохраняют существующие bounded storage limits.
- Cold Host может открыть handle только после проверки durable incarnation; чужой процесс с тем же PID остаётся untouched.
- При Host crash Windows Job может штатно уничтожить service: cold UI показывает его отсутствие, а не искусственное выживание.
- Controlled cold-surviving fixture отдельно проверяет identity/recovery; она не объявляется доказательством SDK cold survival.

## 5. Порядок реализации с владельцами файлов

1. **Failing native/Desktop сценарии первыми.** Параметризовать existing `desktop-native-process-fixture.ts`,
   `desktop-native-process-ui.ts`, `desktop-controlled-process-fixture.ts` и qualification runners по platform.
   Выделить actual SDK warm Stop и controlled cold identity proof; задокументировать различие в receipts.
2. **Версия private capture.** Изменить `process/registeredProcessContracts.ts`, `validateProcessRecords.ts`,
   `projectProcessViews.ts`; сохранить v1/v2 decoding и original processRef старых persisted records.
   Unit-проверки нужны для опасных identity/version rules, а не для каждого нового DTO.
3. **Windows adapter — после 09-WG.** Добавить `process/WindowsRegisteredProcess.ts`, связывающий original service scope с registry.
   При выборе existing broker переиспользовать `ownedProcess/contract.ts`, `windowsBroker.ts` и `tools/owned-process-broker`;
   только подтверждённый seam/async observation адаптировать, без копирования kernel, протокола или WindowsJobCustody.
   Provider-level Job из P08 не доказывает service-level closure; exact native debug/SDK proof обязателен до product wiring.
4. **Linux adapter.** Добавить `process/LinuxRegisteredProcess.ts` и `native/registered-process-linux.c`.
   Реализовать capture/observe/signal через fixed native API; pidfd и identity никогда не приходят из renderer.
5. **Composition.** Изменить `composition/processCustody.ts`, `createMemberProcessMcpPort.ts`,
   `createTeamProcessComposition.ts`; adapters должны удовлетворять прежним ports, без platform branches в React.
   `CapturedProcess` root handoff согласовать с P08; этот общий файл редактирует назначенный владелец P08.
6. **Registry/recovery.** Изменить `TeamProcessCommands.ts`, receipt validator/fingerprint и shared process request/view types;
   existing prepared/requested/lookup semantics, storage fencing и commandId dedupe переиспользуются.
   Добавить linked retry admission/projection в одном owner; проверить concurrency, duplicate delivery и unregister.
   Main/Host adapter и `ProcessesSection` передают явный retry intent, не превращают старый query в signal.
   `ControllerProcessPolicy.ts` остаётся мостом к прежнему processStore, без новой базы history.
7. **Packaging.** Расширить `readPackagedProcessArtifact.ts`, `scripts/buildProcessNativeArtifact.ts`,
   `scripts/qualifyRegisteredProcessNative.ts` и candidate staging для OS backend selection.
   Windows kernel использует поставку P08; при выбранном broker добавить его exact EXE/manifest через existing `buildOwnedProcessBroker.ts`.
   Existing `.github/workflows/sentry-owned-process-native.yml` проверяет x64/ARM64 Node/Electron; packaged product inclusion отдельно обязательно.
   Linux фиксирует N-API, architecture, libc/kernel capability, source/binary digests.
   Нативная сборка выполняется в build actor; runtime загружает только проверенный packaged artifact.
8. **UI/CI.** Existing `ProcessesSection.tsx` и host process adapter получают описанное recovery-состояние;
   focused existing UI test проверяет различие query/retry, внешний вид раздела не переписывается.
   Расширить native jobs, `run-process-qualification.ts` и packaged pipeline, не создавать параллельный test orchestrator.

## 6. E2E-first: реальные опасные сценарии

Только новые TEST проекты, managed fixtures и свои процессы. Реальные OS вызовы обязательны.
Snapshot схемы или `process.platform='win32'` на Linux не считается Windows проверкой.

| ID | Сценарий | Наблюдаемый результат |
| --- | --- | --- |
| M19-01 | SDK/tool запускает service → MCP register → existing Processes → Stop | Правильная строка; original process отсутствует; другой service и foreign neighbor продолжают health reply |
| M19-02 | Actual SDK: early/late child, root-first exit, два services из одного tool task; Stop одной строки | Scope замкнут до birth; весь выбранный service остановлен; provider/сосед живы; shell/provider Job count недостаточен |
| M19-03 | Original завершается; stale capture сравнивается с replacement incarnation | Новый process не получает signal; original row остаётся history; не превращается в новую live row |
| M19-04 | Crash после requested до native и lost ACK после effect; cold lookup → explicit retry → duplicate retry | Lookup не сигналит; same-live original получает один новый attempt по linked intent; replacement/соседи живы; unregister не скрывает pending |
| M19-05 | Cold retained readback и отдельно surviving controlled service | История/label/URL сохраняются; same-live exact identity допускает один Stop; absent/stale не дают повторный kill |
| M19-06 | Read-only чужая Team и metadata-only legacy row | Данные видимы; чужой файл не изменён; поддельный PID/processRef не создаёт native authority |
| M19-07 | Повторный Launch с тем же label/port; задержанный Stop прежней строки | Новый service продолжает работать; новая identity/ref; старый receipt не перенаправляется |
| M19-08 | Packaged app без checkout/SDK compiler; неверный native digest/ABI | Original UI Stop работает с exact artifact; несовместимый artifact не создаёт kill capability и имеет явную диагностику |

M19-01/02/08 выполняются на Windows x64 и ARM64; M19-01/04/08 — на Linux x64.
Darwin получает focused regression M19-01/04 и чтение сохранённого v1/v2 fixture:
исходные bytes/hash/processRef сравниваются до/после cold read, а не только после повторной serialization.
M19-03 проверяется native original-handle lifetime и controlled stale incarnation; чистый unit покрывает equality/race decision.
Нельзя обещать детерминированное OS PID recycling за короткий CI timeout или заменять им остальной native proof.
Actual SDK registration выполняется на каждом новом OS backend; controlled cold fixture не подменяет его.
План P10 объединяет остальные UI/upgrade сценарии, не переписывая эти fixtures.

## 7. Evidence и ограниченные unit-тесты

Native receipt: source SHA, artifact SHA/ABI, OS/kernel/build/arch, provider и captured original identities,
registration/Stop commandId, before/after observations, число signal attempts и результат foreign neighbor.
History snapshot содержит metadata, processRef и receipt transition без приватных handles/credentials.
`requested`, `accepted`, `absent` и `stale` различаются; terminal UI row не доказывает cleanup.
Ограниченные unit additions: byte-preserving capture-version decoder и linked-retry fork/dedupe/authority rules,
если этих случаев нет в existing suites; native identity, ancestry и signal проверяются реальными OS journeys.
Typecheck, native build qualification, focused Desktop/packaged сценарии и guards завершают локальный срез.
Итоговый объединённый SHA и полная приёмка — P10; успешная controlled проверка не называется универсальным OS proof.

## 8. Объём и надёжность

С reuse existing commands/UI/harness: **1 000–1 900 production LOC**, **1 000–1 800 test/E2E LOC**.
Общий Windows loader/Job kernel, посчитанный в P08, здесь повторно не считается; только registry-specific добавления.
Новый Linux adapter/нативный source/packaging входят в эту оценку; vendor/generated и переносы исключены.
Диапазон условен до 09-WG: TEST debug-service candidate переиспользует broker, но native/vendor admission ещё не квалифицирован.
Неизвестный объём provider-source integration не маскируется в оценке «готового Windows adapter»; после gate обновить LOC/CI tuples.
Если доказательство Windows service-tree ownership требует большого отдельного supervisor, сначала пересмотреть подход;
такой supervisor не является принятой архитектурой или скрытым условием малого LOC.
Сложность **9/10**; уверенность в LOC **5/10**; ожидаемая надёжность после описанной приёмки **8/10**.
Последнее — оценка engineering confidence для заявленного scope, не обещание нулевой вероятности ошибок.

## 9. R1: реальная самопроверка

Прочитаны actual-main UI → TeamDataService → processKill/processStore, current TeamProcessCommands,
Darwin contracts/validator/artifact loader, Windows kernel и cold UI qualification script.
В текущий план внесены следующие исправления:

- **R1-09-01:** `WindowsJobCustody` нельзя вызвать для Stop одной строки: это убило бы весь provider Job; введён target/service scope.
- **R1-09-02:** main Windows использует `/T`; добавлены descendants до/после registration и обязательный M19-02.
- **R1-09-03:** перенос только на Windows оставлял бы Linux без M19; добавлен pidfd backend и его native/package gate.
- **R1-09-04:** normalization старых Darwin captures могла изменить processRef; запрещена перезапись original bytes/hash.
- **R1-09-05:** cold fixture ранее могла выглядеть как SDK-survival proof; actual SDK warm и controlled cold явно разведены.
- **R1-09-06:** PID reuse нельзя обещать вызывать бесконечным churn; E2E проверяет retained kernel handle, unit — опасное identity rule.
- **R1-09-07:** pending запрещает canTerminate, UI делает лишь lookup; добавлен M19-04 и явная задача закрыть requested-before-signal dead end в том же owner/UI.

## 10. R2: независимое ревью и исправления

Reviewer: `/root/estimate_profiles_models`; исходная опубликованная ревизия:
[`783422b95a139a4c8c1d22623651d57c882136f9`](https://github.com/777genius/agent-teams-ai/blob/783422b95a139a4c8c1d22623651d57c882136f9/docs/plans/provider-migration/frontend-parity-2026-11-12/09-cross-platform-processes.md).
Проверены Stage 1 `TeamProcessCommands.view/terminate/lookup`, contracts и Windows kernel/custody;
сопоставлены original Processes UI, P08 и P10. Production и тесты не менялись.

- **R2-09-01:** nested Job после появления детей не доказывает замкнутый service scope. Добавлен source/native admission
  gate до wiring; PID snapshot и уничтожение provider Job запрещены как подмена targeted Stop.
- **R2-09-02:** same-live pending раньше позволял лишь бесконечный lookup. Определён explicit linked retry через один
  journal/owner: новый intent, original capture, current authority, отсутствие forks и один attempt на commandId.
- **R2-09-03:** простое добавление второго requested ломало existing `view` (>1 pending). В план добавлены chain projection,
  unregister retention и отдельное observation completion без перезаписи прежнего UNKNOWN в недоказанный успех.
- **R2-09-04:** legacy decoder мог сохранить смысл, но изменить bytes/hash. Darwin corpus теперь проверяется byte-for-byte;
  native/Desktop, actual SDK и controlled cold evidence разделены, platform claims ограничены baseline tuples.

## 11. R3: focused native feasibility review, выполнено 2026-11-12

Reviewer: `/root/estimate_platform_acceptance`; входная версия P09 `ce577820717e0357b5ccbcf944ef8d4c71c627a2`.
Прочитаны broker.cpp/protocol.h, OwnedLaunchPort/windowsBroker, WindowsJobKernel/Custody, process MCP registration,
actual SDK process fixture и `.github/workflows/sentry-owned-process-native.yml`; production/CI не запускались и не менялись.

- **R3-09-01:** existing broker доказывает новый Job-root, но не capture уже существующего service subtree.
  Убрана неопределённая надежда на native handoff; описаны реальные primitives, отсутствующие API и кандидат pre-birth service scope.
- **R3-09-02:** одна scope на provider либо shell task может убить соседний service. Добавлен actual двух-service tool case в 09-WG/M19-02.
- **R3-09-03:** broker Stop async, current native signal sync; нельзя ждать внутри Team fence либо выдавать async Promise за accepted.
  Добавлен explicit requested-before-await gate и повторное использование единственного durable owner.
- **R3-09-04:** RootExit не покрывает surviving children, protocol не умеет read-only Job observation/cold adopt.
  Названо минимальное возможное protocol дополнение как новая работа, а не уже доступная функция; cold PID re-adoption исключён.
- **R3-09-05:** existing Windows CI staging не доказывает product packaging или SDK launch interception.
  Reuse build/gate paths сохранён, actual packaged/Desktop proof обязателен; Windows service-launch gate остаётся открытым.

Focused R3 не закрывает 09-WG: до реализации требуется конкретный provider/tool seam, а не согласие с абстрактной схемой.

## 12. R3 addendum и bounded native feasibility slice, 2026-11-12

- **R3-09-06:** ненадёжные Job notifications не дают complete ownership. Выбран проверяемый TEST путь через pre-execution
  debug events и nested Jobs; отдельный supervisor, PPID census, PID fallback и второй durable journal не добавляются.
- **R3-09-07:** debugger обязан продолжать EXIT events до ожидания фактического native exit. Loop остаётся на existing creating
  thread; command reader/Stop независимы. Root/outer HANDLE дублируются под existing state lock до освобождения этого lock:
  обычный watcher может закрыть собственный root HANDLE, поэтому заимствование его после unlock было ошибкой.
- **R3-09-08:** fixture first breakpoint handling не доказывает поведение реальных SDK при exceptions/debug detection.
  `debugServiceTest.h` компилируется только с `OWNED_PROCESS_TEST_DEBUG_SERVICE`; staging по-прежнему содержит лишь product broker/manifest.
  Private TEST Stop payload не создаёт product receipt и не является новым public protocol/capability.
- **Native scenarios:** pre-resume cancel без первого эффекта; две service branches с children до registration;
  service-root-first exit; wrong birth без эффекта; lost-ACK duplicate; targeted Stop с original HANDLE witnesses и native
  provider stdin reply после Stop; затем отдельный genuine whole-provider cleanup. Foreign sentinel сохраняется.
  Root-first fixture имеет явный readiness barrier, independent witnesses подтверждают capture до exit; timing sleep не служит доказательством.
- **Локальная проверка:** exact frontend Node 24.21.0, native-tooling TypeScript PASS, existing protocol/event suites **45/45 PASS**.
  Это Linux structural evidence, не Windows qualification. CMake/MSVC и настоящие x64/ARM64 Node/Electron runs выполняются existing native CI.
- **Остаётся:** native gate outcome; actual provider debug compatibility и два services в одном tool task; bounded production record
  retirement/identity binding; read-only scope observation; registry async Stop и единственный recovery owner; packaged Desktop proof.
  До этих результатов P09 остаётся частично реализованным; 09-WG и M19 не закрыты.
