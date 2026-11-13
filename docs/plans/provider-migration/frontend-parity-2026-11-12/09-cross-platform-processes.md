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
- Linux identity включает boot UUID, PID namespace и стабильный 64-bit pidfs inode; signal выполняется через pidfd.
  PID и `/proc` start ticks отдельно не являются durable identity.
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
  Проверка `fstatfs(PID_FS_MAGIC)` обязательна: старый anonymous-inode pidfd не даёт пригодной durable inode identity.
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

## 13. Linux native/Host срез, 2026-11-12

- `native/registered-process-linux.c` использует original pidfd на каждом boundary; `captureRoot` вызывается синхронно
  после реального isolated spawn. Same-session admission и bounded live ancestry удерживают оригинальные descriptors;
  чужой root, сменившаяся цепочка, namespace или incarnation не создают право сигнала.
- `LinuxRegisteredProcess.ts` подключён через существующий `processCustody.ts`. Capture v3 имеет `platform: linux`;
  Darwin v1/v2 читаются без переписывания bytes/hash. Shared `loadProcessNativeArtifact.ts` сохраняет прежние проверки
  digest/canonical file/cache; второй процесс, daemon или command journal не появился.
- Cold read/signal открывает pidfd и сначала проверяет сохранённый per-boot inode; final `pidfd_send_signal(SIGTERM)`
  получает этот descriptor. Это сохраняет Unix baseline одного SIGTERM выбранному service, не обещает Windows tree Stop на Linux.
  PID/start-time эвристика и `kill(pid)` fallback отсутствуют. `accepted` по-прежнему не означает observed exit.
- Native executable evidence связывает original root с kernel `/proc/PID/exe`, device/inode и полным pinned SHA256 файла.
  Packaging actor строит N-API 8 artifact и записывает фактически требуемую ELF/glibc версию; Host не запускает compiler.
- Фактическая приёмка: **Node 24.21.0** и **Electron 44.10.1 / Node 24.22.1**, Linux **6.18.57 x64**,
  same-/cross-session, foreign lineage, wrong inode/namespace, provider/bridge exit, новый cold worker, original SIGTERM,
  neighbor survival, SID drift и finite natural cleanup. Проверялись настоящий checked manifest и Host composition.
  Оба runtime использовали одинаковый binary SHA; измеренный glibc минимум — **2.33**. Existing process regression suites — **18/18**.
- Existing guarded native workflow дополнен Linux x64 lane с matching source paths; draft/repository guard сохранён.
  Node repository runtime, Host Node и pinned Electron имеют отдельные native receipts; отсутствие pidfs не является skip/PASS.
- **Открыто:** kernels без stable pidfs identity (upstream до 6.9), более старые libc/artifact tuples, actual SDK/Desktop/packaged
  Linux M19 и общий explicit recovery retry. Успех этого среза не разрешает молча убрать работавший Unix Stop на старых kernels.
  Windows service debug candidate остаётся отдельным незакрытым gate.

Основание durable identity: [systemd pidfd inode contract](https://www.freedesktop.org/software/systemd/man/latest/sd_pidfd_get_inode_id.html);
original-process signal/exit: [pidfd_open](https://man7.org/linux/man-pages/man2/pidfd_open.2.html) и
[pidfd_send_signal](https://man7.org/linux/man-pages/man2/pidfd_send_signal.2.html).

## 14. Проверка прежнего Linux baseline и ABI, 2026-11-12

- Immutable Main [`4a0e062/README.md`](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/README.md)
  объявляет Linux desktop и AppImage/deb/rpm/pacman; явного минимального kernel/glibc там нет.
  [`docs/RELEASE.md`](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/docs/RELEASE.md)
  сохраняет Ubuntu 22.04 package-test host. В
  [`updater-linux-packages.yml`](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/.github/workflows/updater-linux-packages.yml)
  этот host предоставляет kernel; deb GUI выполняется в Ubuntu 24.04 container, rpm/pacman — в своих distro.
  Это не даёт основания объявить kernel ≥6.9 новым обязательным минимумом или считать все старые версии доказанно поддержанными.
- Warm pidfd на старом kernel может оставаться у существующего живого Host owner; смерть этого owner уничтожает descriptor.
  Cold recovery без stable pidfs identity нельзя выдавать за exact identity по PID, start ticks или `/proc` inode.
  Для такого случая остаётся explicit held; безопасный warm путь и соответствие старому Linux Stop ещё требуют реализации/приёмки.
- Измеренные локальные ELF symbol floors: новый adapter — GLIBC **2.33**, Host Node 24.21.0 — **2.28**,
  Electron 44.10.1 executable — **2.25**. Последнее число не описывает все библиотеки Electron bundle.
  Manifest честно фиксирует **построенный** artifact; это не утверждение нового product minimum.
  Следующий ABI шаг — сборка тем же проверенным C source на самом старом существующем CI toolchain/container
  и повторная native проверка того же бинарника на выбранных OS tuples, без удаления identity checks и без runtime compilation.
- Kernel capability gap, ABI delivery и actual SDK/Desktop/packaged M19 — отдельные gates. Успех native component lane
  закрывает только проверенные Node/Electron + kernel/libc tuples; широкая Linux parity пока не заявляется.

## 15. Следующий Linux actual SDK gate, подготовлен 2026-11-12

- Existing `desktop-native-process-model/fixture/host` переиспользуют реальный Claude SDK 0.3.305: два background Bash
  services, один MCP register, один Human Stop через original processRef, соседний service жив до отдельного owner cleanup.
  Native Linux SDK из frozen pnpm closure имеет SHA256 `86cb722ab68348877dba7971e4d0c659919e05e6228c05e006e83da320e656ef`.
  TEST runner копирует проверенные bytes в private single-link executable; hardlinked pnpm store не ослабляет custody checks.
- Linux root oracle — отдельный конечный read-only TEST actor. Он валидирует полный original capture и тот же manifest/binary,
  затем наблюдает сохранённый root identity, без root-as-descendant capture и без signal API. Production loader/port неизменны.
  **Локально PASS:** original root same-live → собственный finite EOF/self-exit → exact absent; service пережил root и завершился
  по natural TTL. Harness signals — 0. Node 24.21.0, тот же проверенный native artifact.
- `qualify-linux-process-sdk.ts` фиксирует source/native/profile/Host closure до/после; existing guarded Linux CI выполняет
  genuine SDK scenario и сохраняет original failure receipt/TEST fixture. Typecheck scripts, source-size guard и diff check PASS.
  Локальный HTTP listener недоступен по разрешениям среды, поэтому actual SDK success пока не заявлен; проверку выполнит CI.
- Desktop M19, packed delivery, old-kernel warm/cold distinction и ABI qualification остаются отдельными незакрытыми gates.

## 16. Реальные результаты CI #1188 и Windows correction

- Linux source [`1607c957`](https://github.com/777genius/agent-teams-ai/commit/1607c957ed0e31e0490f8601c9abc29c95df48b8):
  [job 131515965672](https://github.com/777genius/agent-teams-ai/actions/runs/43313667815/job/131515965672) — **SUCCESS**.
  Отдельно выполнены repository Node, Host Node 24.21.0 и pinned Electron N-API/cold-original native gates.
  Этот run ещё не содержит actual SDK/Desktop сценарии из §15; они остаются pending.
- Windows [x64 job](https://github.com/777genius/agent-teams-ai/actions/runs/43313667815/job/131515966316) и
  [ARM64 job](https://github.com/777genius/agent-teams-ai/actions/runs/43313667815/job/131515966103): native compile и protocol suites PASS;
  P08 Node launch/facade/captured-provider/root-first prefix PASS, затем TEST P09 `debug-service` падает до child readiness:
  broker exit 75. Independent controller доказал final `activeProcesses=0`. Следующие Electron/Host Node lanes ещё не выполнялись.
- Correction [`e6779d2`](https://github.com/777genius/agent-teams-ai/commit/e6779d2ff2ffdc718a778860f600327a8774e81c):
  debug event HANDLE больше не считается автоматически имеющим query/wait/Job-assignment права. `DuplicateHandle` запрашивает
  ровно необходимые права у **того же** kernel object; отказ закрывает admission, `OpenProcess(pid)` fallback отсутствует.
  Root проверяется через `CompareObjectHandles`, не через query чужого access-mask. Это исправляет доказанный contract defect;
  фактический DWORD исходного CI не сохранился, поэтому нельзя заранее объявлять эту гипотезу единственной причиной падения.
- TEST-only fd4 сохраняет один 16-byte record `stage/error/event/pid` и не удерживает target stdout/stderr.
  Harness сразу фиксирует ранний broker exit; production protocol, staged files, cleanup authority и workflow guard прежние.
  Native TS, existing protocol **45/45**, source-size и diff-check PASS. Повторная Windows квалификация исправленного source **pending**.

Права и identity: [Debugging Events](https://learn.microsoft.com/en-us/windows/win32/debug/debugging-events),
[AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject),
[DuplicateHandle](https://learn.microsoft.com/en-us/windows/win32/api/handleapi/nf-handleapi-duplicatehandle),
[CompareObjectHandles](https://learn.microsoft.com/en-us/windows/win32/api/handleapi/nf-handleapi-compareobjecthandles).

## 17. Linux cold Desktop: отдельное подготовленное окно M19

- Existing controlled fixture допускает подтверждённый `linux-x64` artifact и original pidfd captures; Darwin путь сохраняется.
  Host A регистрирует реальный service, штатно закрывается и освобождает writer lease; новый Host B читает ту же запись.
  Original `ProcessesSection` выполняет один Stop по original ref, показывает stopped history без второго Kill control;
  живой сосед отвечает до отдельного cleanup. Final root observation использует exact saved kernel identity, не PID-only probe.
- `qualify-linux-process-cold-ui.ts` принимает единственный успешный SDK receipt из §15 и проверяет прежние source/native pins.
  Это controlled cold UI, **не доказательство SDK services surviving a Host crash**. Runtime sessions/inputs/model servers в этом
  отдельном окне равны нулю. Сохраняются original UI/Host receipts, frame/command identity, cleanup и source freeze.
- Matching paths и finite authenticated Xvfb step добавлены в существующий Linux native workflow; draft/repository guard прежний.
  Повторно используются общие P01 Linux Node/display/Corepack/lsof seams; stage1 macOS workflow не расширяется.
  Реальный Linux UI результат ещё **pending**. Packaged UI, supported older kernels/libc и Windows service scope остаются открытыми.

## 18. Закрытые причины следующего CI падения, без преждевременного PASS

- Run `43319965104` на `b3c64cc` снова прошёл Linux kernel gates в repository Node, Host Node и Electron.
  Genuine SDK остановился в `open-unknown` до первого model request: SDK выбирал свой bundled Claude вместо captured executable.
  D [`7b6fe181`](https://github.com/agent-teams-ai/old-provider-implementations/commit/7b6fe18170ee51bf7d679a9ba85801963e07271a)
  теперь передаёт caller-selected absolute `executablePath` в штатный `pathToClaudeCodeExecutable`; изменять профиль после capture нельзя.
  Native custody checks не ослаблены. Проверены реальный SDK spawn request без process allocation, полные Node 24/26 checks
  и retained packed consumer. Выбранный provider artifact — `c035a09d5b6795e5f440b0d5ffef52d23604f31618232a36356c7133f63b11e6`.
- Windows x64/ARM того же run обнаружил linker `LNK1181 kernelbase.lib`. TEST helper использует штатный `GetModuleHandleW`
  + `GetProcAddress` для `CompareObjectHandles` с точной SDK function signature; отсутствующий export закрывает gate.
  Числовой PID не заменяет kernel object comparison. Новый frontend source `74a356e7` опубликован в #1188;
  native run `43324122047` должен подтвердить обе Windows архитектуры и Linux SDK/cold UI. Результат пока **pending**.
- На exact `74a356e7` [Windows x64 job 131552128523](https://github.com/777genius/agent-teams-ai/actions/runs/43324122047/job/131552128523)
  завершён **SUCCESS**: все23 native gates под Node26.12.1, Electron44.10.1/Node24.22.1 и HostNode24.21.0.
  В каждом runtime завершены TEST `debug-service-cancel`, `debug-service`, `debug-service-root-first`; independent controller
  подтвердил `rootExitCode=0/activeProcesses=0`. Это x64 native feasibility с retained HANDLE/nested Job,
  не vendor SDK compatibility, не production registration/Stop/cold recovery. ARM64 и Linux SDK/UI ещё pending.

## 19. Linux packed M19: тот же сценарий на реальном builder output

- Candidate adapters теперь допускают ровно `linux-x64`; прежний Darwin путь сохраняется. Existing `stageCandidate`
  переносит полный установленный Host graph, pinned Node, provider tarballs, Claude SDK, Codex helper pair, OpenCode V1
  и проверенный process artifact. Нового package manager, владельца процессов или parallel recovery implementation нет.
- `qualify-linux-process-packed.ts` требует успешные original SDK и source cold UI receipts с exact hashes,
  собирает unsigned Electron directory штатным builder и передаёт captured packed paths в **тот же** cold UI scenario.
  Проверяются native/Host/provider bytes, package dependency links, app executable/asar, renderer/resources freeze,
  original-ref Stop/history, соседний service и окончательная native cleanup. Guard/draft/repository policy прежние.
  `installerClaim` и `sdkColdSurvivalClaim` остаются false; это узкая проверка installed-layout M19, не вся release матрица.
- Локально из стабильного child `74a356e7` materialized **120 пакетов / 7 917 файлов**; manifest
  `f46284dbb234036185e3975494e8cbe3b9f5a77bcda8e919a51ffb031a9f0521`, Host dist до/после идентичен.
  Provider/SPI tarballs совпали с выбранными bytes; Node/native bridge прошли отдельный relocation proof.
  Candidate regressions **4/4**, script types/source-size/diff/YAML PASS. Managed Git и terminal runtime staged штатно
  с locked SHA verification. Product renderer build локально завершён системой с exit 137; builder/UI PASS не заявляется.
- Matching Linux workflow готовит настоящий production bundle, сохраняет shipping terminal/Git resources и запускает packed
  proof после source UI PASS. Hosted packed build/ UI, older-kernel warm/cold parity, ABI tuples и Windows production service Stop
  остаются открыты до фактических отдельных receipts. OpenCode V2 delivery/install qualification этим M19 fixture не подменяется.

## 20. Older Linux: проверенные границы и узкий план до production source

**Статус: план, реализации warm path ещё нет.** Этот addendum не меняет advertised OS minimum и не объявляет cold recovery
на старом kernel решённым. Frozen packed patch из §19 остаётся отдельным срезом к `74a356e7`.

- Main baseline из §14 не задаёт Linux kernel/glibc minimum. Самый старый **явно закреплённый host** в существующей CI — Ubuntu
  22.04 package lane; его deb GUI работает в Ubuntu 24.04 container. Это разные границы: container не проверяет старый kernel.
- Pinned [Node 24.21.0 BUILDING.md](https://github.com/nodejs/node/blob/v24.21.0/BUILDING.md) объявляет x64 kernel ≥4.18,
  glibc ≥2.28 и официальный RHEL 8 build. Это ограничение выбранного Node, не новое утверждение о всём продукте.
  Native artifact пока требует GLIBC2.33: `readelf --dyn-syms` установил две причины — `stat` и `fstat`; syscall/pidfs не требует
  именно этой libc. Сборка на Ubuntu 22.04 сама по себе не доказывает floor2.28.
- [pidfd_open](https://man7.org/linux/man-pages/man2/pidfd_open.2.html) доступен upstream с5.3, возвращает original kernel descriptor
  и поддерживает exit polling. [pidfd_send_signal](https://man7.org/linux/man-pages/man2/pidfd_send_signal.2.html) сигналит именно
  этот объект и не выбирает новый процесс после PID reuse. Это отдельная возможность от
  [durable pidfs inode](https://www.freedesktop.org/software/systemd/man/latest/sd_pidfd_get_inode_id.html).
  Проверяется фактическая capability; release string и distro backports не заменяют probe.
- Сейчас `TeamHost.ts → createProcessCustody → createQualifiedLinuxProcessApi → kernelIdentity` требует pidfs ещё при создании
  Host. Поэтому выбранный artifact на старом ядре может блокировать unrelated Host functionality. Это обязательный defect,
  а не допустимое отключение только кнопки Stop. `CapturedProcess.launch` уже отдельно удерживает неуспешную registration capture
  и не возвращается к позднему PID adoption; этот существующий boundary сохраняется.

### Минимальная реализация в существующем owner

1. `registered-process-linux.c`: разделить `pidfd-live` и `pidfs-inode64` capability probe. Сохранить текущий durable path.
   Для warm root/service удерживать **реальный original pidfd** в private N-API handle object с finalizer; poll/read/signal
   используют тот же descriptor, не повторяют `pidfd_open(storedPid)`. Один source/loader, без daemon/helper server.
   Initial root capture остаётся синхронным до первого yield/private stdin. Отдельно проверить pinned Node/libuv reaping boundary;
   null `exitCode` само по себе original identity не доказывает.
   В [pinned libuv process.c](https://github.com/nodejs/node/blob/v24.21.0/deps/uv/src/unix/process.c) `uv__chld` вызывает loop-owned
   `uv__wait_children`, который reap-ит только `process->pid`; [signal.c](https://github.com/nodejs/node/blob/v24.21.0/deps/uv/src/unix/signal.c)
   ставит notification + `SA_RESTART`, без `SIG_IGN/SA_NOCLDWAIT`. Capture до yield использует этот boundary; посторонний reaper недопустим.
2. Admission остаётся bounded native walk: root parent/PGID/SID, same-session либо live ancestry ≤16, retained descriptors
   для всей цепочки, повторная проверка alive/PPID/SID перед выдачей capture. Чужой target, смена lineage, отказ kernel capability
   или недоказанное initial root — отказ конкретной process action. Root-as-service и SID/PID эвристики не добавляются.
3. `LinuxRegisteredProcess.ts`: тот же Host-level `ProcessCustody` хранит private handle objects и finite capture-key mapping.
   Persisted warm record получает отдельный discriminant/owner-instance/capture key, а не выдуманный `pidfdId`.
   Key — только lookup в текущем owner; signal authority возникает из retained native object + original binding/current fence.
   Повторная registration того же live объекта должна вернуть тот же capture; lookup по PID допускается только как индекс
   к уже удержанному и заново проверенному descriptor, никогда как право захватить replacement.
4. `registeredProcessContracts.ts` / `validateProcessRecords.ts`: новый private capture вариант, строгий decoder, старые Darwin
   v1/v2 и Linux durable v3 без изменений. Existing processes.json / command owner / receipt journal остаются единственными.
   Private fields по-прежнему не выходят в Desktop/MCP projection. Размер native retention ограничен существующими registry/
   command bounds; descriptor освобождается после доказанного exit либо owner disposal, без смены объекта под старым key.
5. Cold Host без original handle возвращает `unknown/held`, `canTerminate=false`; восстановление по PID/start ticks/proc inode
   запрещено. Уже durably completed `observed-absent` receipt может доказывать окончательность **того же original capture**:
   `TeamProcessCommands` должен переиспользовать этот terminal proof для history/release, чтобы не превращать завершённый Stop
   в вечный held после рестарта. Requested/accepted/lost ACK и metadata-stopped таким доказательством не являются.
6. `processCustody.ts` / `TeamHost.ts`: подтверждённое отсутствие kernel capability не обрушает весь Host; metadata/прочие команды
   остаются доступны, native process action получает finite unsupported/held result в существующей UI/diagnostics projection.
   Artifact hash/schema/loader integrity failure не маскируется общим catch и не превращается в разрешённый fallback.

### ABI-поставка и реальная приёмка

- Сначала штатный glibc2.28 build на поддерживаемом RHEL8-family toolchain: официальный
  [UBI8 image](https://catalog.redhat.com/software/containers/ubi8/ubi/5c359854d70cc534b3a3784e), фиксированный resolved digest,
  официальный compiler/binutils + pinned Node24/N-API headers. Это build-only container в existing Linux CI.
  Перед source change проверить фактические UAPI syscall declarations; недостающие headers требуют явно зафиксированного
  штатного header package, а не symbol-version hacks или подмены libc. Первый artifact обязан измерить floor ≤2.28 через readelf.
- `buildLinuxProcessNativeArtifact.ts` сохраняет compiler/header/source/inspector/image identity и вычисленный ABI minimum.
  Один и тот же binary должен реально загрузиться под Node24 в glibc2.28 userspace и пройти existing native suites под
  repository Node и Electron на квалифицированном kernel; отсутствие capability не считается PASS/skip нужного сценария.
- Existing finite actor/harness дополняется опасными случаями: warm Stop при отсутствии pidfs; service пережил provider root;
  sibling/foreign процессы остаются живы; отказ при SID/ancestry drift; повторная registration не меняет original ref;
  lost ACK без второго signal; новый Host не принимает старый warm key; completed absent history/release переживает restart.
  Unit нужны только для новых discriminants, binding/terminal-proof правил; отдельные mapper tests не добавляются.
- Старый kernel проверяется на **реальном** existing Ubuntu22 host с записанными kernel/capabilities. Container на новом kernel
  проверяет только libc. Если штатный host уже получил pidfs, execution warm path на нём полезен, но не подменяет old-kernel
  acceptance. Отдельно остаются kernels без pidfd capability и GUI/package ABI tuples; новый support minimum не объявляется.
  В частности, Node baseline kernel4.18 без фактического pidfd получает explicit unavailable process capability с сохранением
  остальных функций Host; этот режим не называется full warm Stop parity.
- Оценка добавления/существенного изменения: **280–440 production LOC**, **220–360 native/E2E LOC**, **50–90 build/CI LOC**
  с reuse нынешних harness и command owner. Сложность7/10, confidence6/10 до native old-kernel/ABI receipt.
  Review gate до implementation: initial-root reaping proof, terminal absent reuse, supported toolchain image/declarations.

## 21. CI `74a356e7`: Windows обе архитектуры PASS, Linux SDK readiness defect

- [Native run43324122047](https://github.com/777genius/agent-teams-ai/actions/runs/43324122047) завершён на exact `74a356e7`.
  Windows x64 job131552128523 и ARM64 job131552128478 — **SUCCESS**: реальные Node26, Electron44 и HostNode24 lanes,
  включая retained-HANDLE/nested-Job service gates. Это TEST feasibility/P08 evidence, не production P09 service-stop parity.
- Linux job131552128047: Node26/HostNode24/Electron native identity/cold-original gates **PASS**. Step11 genuine SDK service
  scenario **FAIL**, cold Processes UI не запускался. Actual SDK теперь использует выбранный native Claude и advertised MCP catalog.
  Retained artifact13993238362 (`5e384f29580a2b81894be1790898a01b90a82aa0b2413cd2c7235aeb1a1de9c3`) показывает readiness race:
  background task принят в23:20:25.394, oracle запросил metadata в23:20:25.468, neighbor server опубликовался в23:20:25.551.
- Узкий TEST fix: после двух original background receipts ждать только первоначальную публикацию services ≤10s;
  missing file разрешает повторить **read**, без повторного Bash/MCP/native signal. Уже существующая некорректная metadata
  немедленно отклоняется. Foreground fixture публикует JSON атомарным rename. Sealed failure/no-replay rule сохраняется.
  Delayed-file/corrupt-file/deadline regression и scripts TS **PASS** локально; новый genuine SDK/ColdUI/packed receipt ещё нужен.
  Source fix не переносит незавершённый §20 native source в child PR и не заменяет недостающее доказательство UI.

## 22. Узкий warm owner cut: implementation и реальные локальные receipts

**Уточнение доставки, 13 ноября:** перечисленные ниже локальные результаты относятся к первоначальному неопубликованному
warm cut. После потери локальной execution-среды его полный patch недоступен; опубликованный child `a920ceca` ещё не содержит
эту реализацию. Восстановление по §20 выполняется как новый source cut от текущего Git, с отдельными review/compile/native
результатами. Совпадение с прежним patch, binarySHA и PASS не предполагается; воспроизводимые ABI actors сохранены отдельно.

- Один native source теперь отдаёт actual pidfd/pidfs capabilities. Durable v3 остаётся предпочтительным; без pidfs выбирается
  private v4 `owner-pidfd-v1`. Оpaque N-API objects удерживают original descriptors в существующем Host owner; cold Host
  не принимает serialized capture key. Нет PID-only сигнала, повторного adoption, daemon или второго receipt journal.
- `LinuxWarmProcess.ts` ограничивает retention10000 captures, связывает полный original capture/root/registrar с handle,
  повторная registration возвращает прежний ref только после новой lineage проверки и проверки удержанного live объекта.
  `LinuxRegisteredProcess.ts` сохраняет проверку source bytes/executable inode и возвращает unavailable только конкретной
  process capability при отсутствии pidfd. Ошибки artifact hash/schema/loader остаются фатальными для выбранного artifact.
- `TeamProcessCommands` использует existing completed `observed-absent` receipt **того же полного capture** для history/release
  после owner restart. Accepted/requested/metadata-stop и чужой capture с тем же PID/commandId не завершают cleanup.
- Исправлен общий native edge: zombie thread-group leader не доказывает отсутствие процесса, пока worker threads ещё живы.
  `/proc` Z/X/error возвращает unknown; только original pidfd polling доказывает whole-process exit. Регрессия действительно
  вызывает `pthread_exit` у leader при живом worker и проверяет warm/durable refusal до конечного естественного завершения.
- Реальные `TEST-linux-warm-node24` и `TEST-linux-warm-electron` на kernel6.18.57 прошли original durable journey и warm owner
  journey: root/bridge exit, foreign/sibling survival, duplicate ref, cold-owner refusal, SID drift, zombie leader, finite cleanup.
  Один binarySHA `ce931c5c9039111c1623bbec7a0344fa98c11d2001ac078d3507cad1d729a1fd`; manifestSHA
  `228d56adeb32ae8b0b6db0cdead03ebc9af6a4d7b668e5124d24c495759bafd5`.
  Host build/test types, scripts TS,21 process regressions и source-size guard PASS. Capability-unavailable startup regression
  — **synthetic boundary test**, не свидетельство kernel4.18 execution.
- Native3-runtime CI, реальный old-kernel automatic selection и ABI2.28 build **ещё открыты**. Локальный artifact имеет
  measured GLIBC2.33; этот cut не объявляет advertised older-Linux parity завершённым и не подменяет SDK/Desktop/packed gates.

## 23. ABI2.28 и real older kernel: проверенный следующий gate

**До ABI implementation.** Official [runner-images `b66f42f5` Ubuntu2204 README](https://github.com/actions/runner-images/blob/b66f42f50774c09b9d1de4e149ba1a5fd00f9c39/images/ubuntu/Ubuntu2204-Readme.md)
описывает image20261101.347.1 с kernel6.8.0-1070-azure и Docker28.0.4. Это пригодный **реальный host** для проверки отсутствия
pidfs, но README не доказательство фактического job: acceptance требует записать runtime capabilities и actual capture.version4.
Изменение hosted image, pidfs backport или отсутствие pidfd не превращается в skip/PASS; gate должен показать несовпадение.

1. Добавить один Linux Ubuntu22 job в existing native workflow с теми же Ready/same-repo/manual guards. Повторить только
   bounded process suites, без SDK/UI/packed дублей. На этом host требуется actual automatic v4 admission из production
   `createProcessCustody`, исходный warm Stop после root exit, cold-owner refusal, terminal history и thread-leader regression.
2. Для libc использовать official UBI8:8.10 build-only image и существующий repository pattern
   [updater-linux-packages.yml](../../../../.github/workflows/updater-linux-packages.yml): `pull → inspect RepoDigests → FROM exact digest`.
   Local registry/catalog/CDN responses не дали проверяемых image/RPM bytes; digest не выдумывать. CI разрешает tag один раз,
   сохраняет разрешённый base digest и final toolchain image ID, затем build/load выполняется только на этих exact bytes.
3. Стандартный `dnf` из UBI repos устанавливает compiler/binutils/glibc-devel/kernel-headers; сохраняются package NEVRAs,
   compiler/inspector/source/N-API header hashes. Native C обязан компилироваться с реальными `SYS_pidfd_open`/
   `SYS_pidfd_send_signal` UAPI declarations. Если пакет их не содержит, gate останавливается: numeric syscall/libc hacks нет.
4. Изолированный build actor использует существующий `buildLinuxProcessNativeArtifact`; schema/hash output не переписывается
   после выбора. Дополнительный ABI receipt связывает immutable manifest/binarySHA с image/package/toolchain evidence.
   `readelf` обязан показать minimum≤2.28. **Тот же binary** реально загружается в UBI glibc2.28 под pinned HostNode24;
   compile/load работают без сети, с обычными Docker restrictions, без privileged/seccomp ослабления.
5. После вывоза original artifact на Ubuntu22 существующие Node24 native suites проверяют automatic warm selection и cleanup;
   built artifact/ABI receipts удерживаются одним exact-source artifact. Repository Node26 и Electron compatibility уже входят
   в existing modern-kernel lane; ABI job сохраняет минимальный объём и не объявляет GUI/installer или kernel4.18 qualification.
6. Kernel4.18 без actual pidfd остаётся finite unavailable process capability с рабочим unrelated Host. Synthetic startup test
   из §22 проверяет эту policy boundary, но реального kernel4.18 receipt пока нет. Cold original handles без owner и завершённого
   observed-absent receipt остаются held. Main merge/activation и supported OS minimum не меняются.

Приёмка этого шага — три разных факта: measured ELF ABI≤2.28, genuine load в glibc2.28 userland и native warm capture/Stop на
реальном host без pidfs. Container разделяет kernel host и подтверждает только первый/второй факты. До всех трёх receipts — pending.

## 24. Windows после native feasibility: минимальная оставшаяся product работа

**Read-only review перед source.** В [exact646 native run](https://github.com/777genius/agent-teams-ai/actions/runs/43331388215)
x64 job131576684914 прошёл Node26/Electron/HostNode24; ARM/Linux ещё не завершены на момент записи.
Ранее exact74 прошёл обе Windows архитектуры (§21). Это доказательство TEST retained HANDLE/nested Job, а не Windows M19.

### Проверенные gaps в текущем source

- [TEST debug scope](https://github.com/777genius/agent-teams-ai/blob/646147879b71490e307f6cfc694276903a750874/tools/owned-process-broker/debugServiceTest.h)
  удерживает original event HANDLE и nested Job, но ограничен64 cumulative records, не имеет production retirement/query/capture API.
  `OWNED_PROCESS_TEST_DEBUG_SERVICE` и private Stop mode2 не входят в staged product broker; их нельзя просто включить флагом.
- [CapturedProcess](https://github.com/777genius/agent-teams-ai/blob/646147879b71490e307f6cfc694276903a750874/packages/legacy-agent-host/src/adapters/providers/CapturedProcess.ts)
  на Windows запускает `WindowsCapturedProcess`, а `captureRegisteredProcess` ищет только обычные `processRoots`.
  `processCustody.ts` выбирает Linux/Darwin; Windows registration/observe/signal backend ещё отсутствует.
- [OpenCodeV2EmbeddedServer](https://github.com/777genius/agent-teams-ai/blob/646147879b71490e307f6cfc694276903a750874/packages/legacy-agent-host/src/adapters/providers/OpenCodeV2EmbeddedServer.ts)
  передаёт отдельный `processTreeSource`/`WindowsJobCustody` и обходит P08 broker. Его работающий whole-provider Job не покрывает
  late service registration. Перевод на broker требует сохранить original Bun executable observation и private bootstrap-before-input.
- `RegisteredProcessNative.capture/observe/signal`, `createMemberProcessMcpPort` и `TeamProcessCommands` синхронны;
  `store.fenced` не может удерживаться через broker await. Purge также вызывает synchronous `assertReleased`.

### Следующий минимальный срез и порядок

1. Сначала existing **unstaged TEST** broker квалифицирует actual captured provider launch/tool paths
   на существующих qualified Windows tuples. [Current TEST pins](https://github.com/777genius/agent-teams-ai/blob/646147879b71490e307f6cfc694276903a750874/scripts/e2e/opencode-native-windows-pins.ts)
   ограничивают V1 x64 и V2 x64/ARM64, но не определяют весь product support. Current frontend
   `OpenCodeRuntimeInstallerService.ts`/`packageSelection.ts` выбирают native arm64 download, однако
   `openCodeWindowsNpmBinaryDiscovery.ts` принимает explicit exe без arch-filter, а `generation.ts`
   не исключает V1 по platform. Поэтому установленный x64 V1 на ARM64 через штатную emulation остаётся
   отдельным parity gate; отсутствие native arm64 package не отменяет working installed path.
   Broker primitive по-прежнему проверяется на обеих архитектурах.
   Переиспользовать finite native model/oracle: реальный provider создаёт два services из одного tool task;
   выбранный service имеет child до registration и после неё; Stop сохраняет provider, соседний service и foreign witness.
   Проверить handshake, stdio, cancellation, native exceptions/debug detection и root-first exit. Это bounded gate, не новая SDK обёртка.
2. После vendor proof перенести проверенное admission ядро из TEST header в небольшой helper **того же broker**.
   Один owner/generation и original HANDLE/Job остаются authority; PID/birth только ищут уже захваченный original record.
   Отдельный scope key не переиспользуется. Retire unregistered record только после original root exit **и** Job ActiveProcesses=0;
   registered/pending scope сохраняет exact terminal facts до existing command settlement. Не переносить TEST лимит64 cumulative
   в долгоживущую сессию; bounded live records и accounting проверяются тем же native gate, без PPID scan/adopt fallback.
3. В existing `protocol.h`/`owned-process/{codec,contract,windowsBroker}` добавить только finite service capture, read-only query
   и scoped Stop. Capture возвращает original scope; query никогда не сигналит; Stop требует exact owner/scope и один attempt.
   Отсутствие root при живых children — present, завершение требует root exit+zero nested Job count. Provider Stop остаётся отдельным.
   Расширение wire/version и staged manifest проверяются вместе; новый daemon, package или второй protocol не создаётся.
4. Подключить `WindowsRegisteredProcess` к `WindowsCapturedProcess`/`CapturedProcess` и current Host process composition.
   Узкий async port допускает existing sync Darwin/Linux implementation. Prepare/request записывается под existing Team fence,
   fence освобождается перед await; перед commit повторно проверяются тот же receipt/capture, registrar, current source и authority.
   Это затрагивает `TeamProcessCommands`, `createTeamProcessMethods`, `createMemberProcessMcpPort` и lifecycle release call sites;
   Promise нельзя выдавать за native accepted. `lookup` не повторяет Stop, unknown effect остаётся original requested intent.
   Для synchronous purge допустим только уже сохранённый exact terminal proof; live query сначала завершается вне fence.
5. V2 использует тот же broker только после квалификации actual Bun graph. Сохранить measured executable/root identity через
   read-only original HANDLE evidence; не передавать observable facade в old `ChildProcess` capture и не открывать root по PID.
   Existing V2 graph/config/bootstrap checks остаются. Затем пройти current Processes UI и packaged artifact на обеих архитектурах.

### Уточнение §24.3–4 перед product source: wire lifetime и async fence

**Основание:** прочитаны immutable `f418ea2e09c38ee5dfdfb1ddbc15b3e5a851dc46`
[broker loop](https://github.com/777genius/agent-teams-ai/blob/f418ea2e09c38ee5dfdfb1ddbc15b3e5a851dc46/tools/owned-process-broker/broker.cpp),
[Windows client](https://github.com/777genius/agent-teams-ai/blob/f418ea2e09c38ee5dfdfb1ddbc15b3e5a851dc46/packages/legacy-agent-host/src/owned-process/windowsBroker.ts)
и [process owner](https://github.com/777genius/agent-teams-ai/blob/f418ea2e09c38ee5dfdfb1ddbc15b3e5a851dc46/packages/legacy-agent-host/src/process/TeamProcessCommands.ts).
Это план следующих малых срезов; actual Windows vendor gate ещё не прошёл. TEST helper §26 не активирует продукт.

1. **Раздельные replies внутри прежнего wire.** Добавить finite capture/query/Stop/settle requests и service replies
   в `tools/owned-process-broker/protocol.h`, `broker.cpp` и Host `owned-process/{codec,contract}.ts`.
   Scoped reply не использует `Stopped`: current `WindowsCapability.consume(Op.stopped)` публикует provider-root exit
   из payload. Service outcome не входит в `TreeReceipt`/whole-provider release. Missing scope, stale owner,
   busy/incomplete observation — finite refused/unknown; absence требует original service root exit **и**
   свежий nested Job ActiveProcesses0. Query/settle не вызывают TerminateJobObject.
2. **Долгая сессия не имеет лимита 1024 всех сообщений.** Current C loop считает cumulative frames,
   TS ограничивает nextId1024, а Stop/Release replay maps —65/66 entries. Прямое добавление UI polling исчерпает
   эти пределы. Использовать уже существующие monotonically increasing uint64 request IDs/high-watermark;
   ограничивать concurrent waiters/unsettled effects и bounded settled replay entries, а не lifetime query count.
   Read-only queries не занимают effect replay history. Identical pending/cached effect replay не dispatch-ится снова.
   Evicted/retired old ID не становится новым effect: finite stale/unknown, без повторного signal или abandon здорового
   provider только из-за старого запроса. Mismatched owner/frame и повреждённый protocol остаются отказом containment.
   При нехватке unsettled capacity новый effect отказывается **до dispatch**; pending unknown не вытесняется.
   Native/TS изменения и monotonic-ID/replay cases должны быть одним проверяемым срезом; просто поднять constants нельзя.
3. **Одна исходная Windows authority.** `WindowsCapturedProcess.ts` устанавливает private prepared-root binding
   внутри прежнего `prepared.resume(installOwner)`, до первого stdin. Узкий optional prepared-root seam в
   `registeredProcessContracts.ts` дополняет existing POSIX `captureRoot(ChildProcess)`, не подменяет его facade cast.
   Новый `process/WindowsRegisteredProcess.ts` хранит только original broker/scope capabilities в том же Host owner.
   Сериализованный capture связывает registrar, owner generation, provider root и non-reused scope key/target birth;
   его numeric PID — metadata lookup уже удержанного объекта, никогда authority для OpenProcess/adoption.
   Версию capture согласовать с опубликованным Linux warm union; не переписывать его новый вариант.
   Missing original owner после restart возвращает unknown и не восстанавливается из capture strings.
4. **Явная квалифицированная capability до launch.** Product debug/admission path выбирается private staged manifest
   до CreateProcess; renderer/environment flags его не включают. `buildOwnedProcessBroker.ts`, штатное staging/manifest
   и Host loader проверяют тот же protocol/capability/binary tuple. Старый root-only broker не становится scoped-capable
   по отсутствию ошибки. Exact wire revision и manifest меняются совместно; второй transport/daemon/package не нужен.
   Current `windowsBroker.ts` близок к800 строкам: finite service codec/port допускается вынести в один маленький
   `owned-process/windowsServiceScopes.ts`, получающий request closure исходного owner, без нового request journal.
5. **Await только вне существующего Team fence.** `RegisteredProcessNative` допускает sync POSIX или async Windows
   result; `TeamProcessCommands` адаптируется **поверх** согласованного Linux warm cut. Для register/Stop сначала
   краткий fence проверяет principal, source/registrar, authority revision, immutable row/capture и original commandId,
   сохраняет prepared/requested intent. Native observation/capture ожидается вне fence; после неё второй fence
   заново проверяет те же значения и исходный receipt, прежде чем менять metadata/settle результат.
   Для destructive Stop последний auth check, requested persistence и **синхронная постановка исходного native request**
   происходят в одном fence/call stack; ждём лишь его Promise снаружи. Windows signal не может скрывать предварительный
   await/query перед dispatch. Refusal до отправки отличается от unknown после отправки; timeout/late ACK не превращается
   в success или новый effect. Revoked/current-source change после await оставляет исходную неопределённость.
6. **Все проекции ждут результат.** `createTeamProcessMethods.ts`, `createMemberProcessMcpPort.ts`,
   `mcp/{contracts,processTools}.ts`, provider capture consumers и release/purge call sites обновляются вместе.
   Existing native-input authority захватывается один раз и проверяется повторно после await; Promise не проходит
   в JSON/result projection как accepted. List/lookup сравнивают исходные rows/captures после observation,
   lookup никогда не повторяет Stop или capture по PID. Existing Processes row/Stop/error-retry UI сохраняется.
   Purge не держит sync fence во время native await: предварительное read-only observation и final fence revalidation;
   внутри final fence годится только уже подтверждённый exact terminal proof.
7. **Natural exit использует исходный owner, без нового durable journal.** Новый Linux warm owner сохраняет
   portable absence только в completed terminate receipt с digest полного capture; natural-exit факт остаётся
   owner-local после poll исходного pidfd. Windows сохраняет ту же границу: fresh original root exit+Job0 позволяет
   закрыть HANDLE и оставить terminal facts в записи **того же scope registry**, не создавать synthetic Human Stop.
   Зарегистрированный exact scope после этого наблюдается absent только через ещё живой original owner; после его
   потери без completed terminate receipt — unknown. Unregistered scope можно retire; registered terminal metadata
   и unresolved capture/Stop сохраняются до existing settlement/unregister. Live HANDLE capacity и bounded retained
   metadata считаются отдельно; неизвестный pending effect не вытесняется. Освобождение одной registration не снимает
   удержание другой registration того же scope. Positive portable natural-exit cold proof, если он потребуется,
   требует отдельного review existing journal settlement; этот wire cut его не обещает.
   Whole-provider Job0 остаётся отдельным cleanup proof и не заменяет scoped Stop receipt.

**Короткая приёмка этих срезов:** actual vendor gate на x64/ARM64; query-последовательность более прежних1024 сообщений
без нового процесса/потери соседнего service; cache retirement с повтором old exact request без redispatch;
lost capture/Stop ACK с read-only reconciliation; authority/source change между observation и commit;
natural service exit, освобождение original handles и warm exact-scope tombstone без ложного portable cold proof. Текущий native controller
и existing Host/process fixtures расширяются, новый тестовый framework не вводится. Unit только wire bounds,
exact identity/receipt/replay и fence race; повторять tests каждого DTO/mapper не требуется.

**R11 source findings:** distinct reply, cumulative wire caps, late-await authorization и natural-exit settlement
были скрыты формулировкой «добавить async port»; теперь имеют явные границы и gates. Root сверил natural-exit
семантику с новым Linux owner; exact staged capability и native vendor proof ещё pending. Весь product cut
нельзя называть implementation-ready.
Порядок публикации: helper §26 → typed wire/native qualification → Host fence/capture → existing UI/packaged proof.
Оценка прежнего production диапазона §24 не суммируется повторно с этим уточнением.

**Точность PID объяснения:** удержанный original process HANDLE сохраняет process object и его PID
([Microsoft PROCESS_INFORMATION](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/ns-processthreadsapi-process_information)).
Exact pid+birth lookup в §26 — defensive identity правило, не доказанный физический PID-reuse дефект при живом HANDLE.
Native churn проверяет retirement/old key rejection; принудительное переиспользование PID не объявляется проведённым.

### Cold owner: что ещё не доказано

Current broker создаёт [unnamed, non-inheritable Jobs](https://github.com/777genius/agent-teams-ai/blob/646147879b71490e307f6cfc694276903a750874/tools/owned-process-broker/ownedJob.h)
и завершает lifetime при control EOF. [Microsoft Job semantics](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-createjobobjectw)
описывают kill-on-last-close; это containment, а не сохранённое новым Host наблюдение original subtree.
Поэтому PID/FILETIME исчезнувшего service root, RootExit или broker EOF сами по себе не дают cold `observed-absent` всех детей.
Новый Host переиспользует existing **completed full-capture observed-absent receipt**; без него и original scope возвращает held.
Warm lost ACK сверяется read-only с тем же удержанным scope, без нового signal; cold replay scope не реконструирует.
Automatic cold settlement после потери владельца остаётся отдельным gate: сначала доказать штатное сохранение original
terminal outcome в существующем owner/lifetime, без второго journal, named-Job adoption или PID-only fallback.
Просто дублировать Job handle в Main нельзя: дополнительный handle меняет kill-on-last-close lifetime.
До этого gate Windows cold recovery и M19 целиком **не считаются выполненными**.

### Уточнение cold scope после независимого source review

- В baseline [processStore](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/agent-teams-controller/src/internal/processStore.js)
  читает прежние rows из `processes.json`; list проверяет PID. UI Stop проходит через
  [TeamDataService.killProcess](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/main/services/team/TeamDataService.ts)
  в [killProcessByPid](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/main/utils/processKill.ts),
  где Windows вызывает `taskkill /T /F /PID` без durable process incarnation.
  [ProcessesSection](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/renderer/components/team/ProcessesSection.tsx)
  показывает running/Stop при `isTeamAlive && !stoppedAt`. История, состояние и Stop сохраняются; отсутствие в legacy
  надёжной custody не разрешает объявить живые ранее поддержанные services вечной read-only историей.
- [Stage1 §8](../stage-1-contracts.md#фоновые-services-отличаются-от-teammate-runtime) и
  [controlled cold acceptance](../m19-controlled-cold-ui-acceptance.md) отдельно требуют положительный путь
  register/list → Host restart → UI Stop **живого original**. Already-absent history не заменяет этот proof.
  P09 §4.4 допускает фактическую Windows kill-on-close остановку при Host crash; эта отдельная история доказывает
  absence/readback, а не cold survival. Ни один результат нельзя распространить на весь M19 без его собственных gates.
- В [current CapturedHostClient](https://github.com/777genius/agent-teams-ai/blob/a920ceca8a199ee21f8d7780e003bd23a387b590/src/features/agent-backend/main/infrastructure/CapturedHostClient.ts)
  Main удерживает исходный ChildProcess, но shutdown всегда возвращает `providerCustody:'unresolved'`.
  [BackendOwnerRouter](https://github.com/777genius/agent-teams-ai/blob/a920ceca8a199ee21f8d7780e003bd23a387b590/src/features/agent-backend/main/application/BackendOwnerRouter.ts)
  запрещает duplicate owner/storageRoot, seals закрытого owner и не умеет автоматически заменить его client.
  Автоматический повтор effect, второй supervisor и тестовый обход sealed owner не добавляются. Узкий product
  rebind исходного Main owner после доказанного конца старого Host теперь планируется отдельно в §30.

**Отклонённое доказательство:** named Job + `OpenJobObject/ERROR_FILE_NOT_FOUND` после смерти broker.
[Microsoft object lifetime](https://learn.microsoft.com/en-us/windows-hardware/drivers/kernel/life-cycle-of-an-object)
позволяет убрать имя temporary kernel object при handle count0 раньше исчезновения оставшихся pointer references.
Следовательно, исчезнувшее имя не доказывает отсутствия original children; PID/FILETIME/RootExit этого не исправляют.

**Отдельный возможный cleanup cut, пока не product решение cold:** existing Main client может запускать Node Host
как atomic root внешнего Job через те же `createWindowsOwnedLaunchPort/OwnedProcessFacade`. Original pending capability
удерживается до await; authority устанавливается внутри `prepared.resume` до stdin. Provider brokers и их Jobs остаются
вложенными, их HANDLE не дублируется в Main, kill-on-last-close lifetime provider Job не меняется.
Завершение допускается только по original Host-root exit + fresh outer Job ActiveProcesses0 + drain/release.
Это общий cleanup старого Host epoch после его завершения, никогда не Stop отдельного service при живом Host.

Такой cut сам по себе не передаёт native authority новому Main/Host, не завершает process command receipt и не разрешает
новый live UI Stop. Если позже он понадобится для recovery, private Host epoch должен быть записан в исходный Windows
capture до effect; original opaque terminal proof связывается с полным capture и тем же existing command owner.
Main не пишет Host journal напрямую; PID, renderer payload, сериализованный `confirmed:true` или новая generation
не заменяют proof. Его перенос/settlement остаётся отдельным review gate; новый receipt journal не создаётся.
При полном Main crash исходная capability теряется: outer Job containment нельзя объявить durable cold proof.

Следующий source шаг остаётся ограниченным §24.2–4: после actual vendor PASS — warm service capture/query/scoped Stop
в текущем broker/Host owner и безопасная async граница existing Team fence. Outer Host cleanup можно принять независимо
только с native nested-Job/Host-death/foreign-survival evidence; он не предпосылка warm регистрации и не закрывает cold gate.
**R10 finding/fix:** исключены named-Job absence и автоматический router restart; baseline, positive cold Stop,
Windows crash→absence и outer cleanup теперь имеют разные доказуемые границы без сокращения прежних возможностей.

**R9 findings:** выявлены V2 bypass, sync fence/async broker boundary и отсутствие cold subtree proof. Все три внесены в план;
product source не менялся. Оценка после TEST reuse:600–950 production LOC,350–600 native/E2E LOC; cold lifetime решение сверх
этого диапазона не выдумано. Confidence6/10 до actual vendor proof. Unit только exact scope/receipt/identity и опасные wire bounds.

## 25. Exact a920: actual SDK PASS, Linux Desktop parser correction, 2026-11-13

[Native run43336809115](https://github.com/777genius/agent-teams-ai/actions/runs/43336809115)
завершён для `a920ceca8a199ee21f8d7780e003bd23a387b590`:
Windows x64 job131594926188 и ARM64 job131594926115 — PASS прежних native TEST gates.
Linux job131594925825 прошёл Node26/HostNode24/Electron primitive и genuine Claude SDK background services → selected Stop.
Это первый закрытый actual SDK Linux gate после readiness correction; Windows vendor scenario ещё не выполнялся.

Linux cold UI остановился раньше Host B/UI Stop: `desktop-backend-observations.ts` проверял PGID через truthiness.
Receipt сохранил точный assertion, но не исходную проблемную строку `ps`; нельзя приписывать артефакту отсутствующий census.
Проверенный source defect: допустимый Linux PGID0 отвергается для всей таблицы. Узкая правка сохраняет такие строки,
строго проверяет ровно3 целых поля (PID>0, PPID/PGID>=0) и запрещает group0 как captured app group.
Один regression test одновременно проверяет PGID0, чужую группу, malformed/overflow rows и отсутствие signal.
Original HANDLE/ChildProcess cleanup, birth identity, deadlines и positive cold acceptance не ослаблены.
Packaged M19 в этом run не был достигнут; ни source cold UI, ни packaged M19 пока не PASS.
Artifact `registered-linux-x64-a920…` SHA256:
`aba813fcddfe301e7ee937c3f8d5044dee23b2a150c8e6f945a7aec03a3f2a82`.

Подготовленный Windows vendor gate использует actual SDK0.3.305 + captured native executable,
один native Session, background Bash services, scoped Stop и последующее продолжение того же Session.
Readiness label означает успешный SDK readiness call, без непроверенного утверждения о внутреннем await initialize.
R11 independent review выявил слишком короткий срок жизни TEST witnesses/actors:
только `vendor-*` actors теперь удерживаются до cleanup под прежним independent controller deadline;
обычные TEST modes, product и CI timeout не расширены.
Vendor auth, Windows registry/Host integration, cold owner, Desktop и release не объявлены проверенными.

Для exact подготовленных7 vendor +2 parser files локально прошли Host build, broker tooling TS,
Host test types, desktop scripts TS,21/21 observations tests и прежний source-size guard800.
MSVC compile и actual Windows vendor execution остаются следующим CI gate; локальный Linux TypeScript их не заменяет.

## 26. Узкий следующий Windows helper cut до product activation

План дополняет §24.2, не заменяет остальные gates. После публикации §25 можно подготовить и независимо проверить
общее native admission ядро; production `DEBUG_PROCESS`, staged broker selection и Host registration
не включаются до actual vendor PASS. Новый daemon, package, protocol или receipt journal не добавляется.

- Перенести original HANDLE/nested Job хранение из `debugServiceTest.h` в небольшой helper
  `tools/owned-process-broker/serviceScopes.h` того же broker. В первом cut его вызывает только existing unstaged TEST adapter.
  Event HANDLE duplication, object equality, membership, prebirth assignment и ContinueDebugEvent остаются прежними.
- Каждая запись получает monotonically increasing, nonreused scope key внутри original broker generation.
  PID индекс нужен лишь для выбора уже захваченного живого original во время registration; дальше используется exact scope.
  Новый процесс с повторным PID не заменяет старую scope identity. Original provider root отдельно исключён из service capture.
- Запись владеет HANDLE/Job через RAII; scoped operation удерживает shared lifetime, пока ждёт Windows.
  Registry mutex никогда не удерживается во время ожидания exit: debug loop должен выполнять ContinueDebugEvent.
  Retire unregistered запись можно лишь после original root-exit и свежего Job ActiveProcesses0;
  registered/pending запись удерживается до existing settlement. Счётчик bounded live records не становится cumulative lifetime cap.
- Initial loader-breakpoint flag хранится у exact record; прежний вечный set по PID не переносится.
  Все остальные native exceptions по-прежнему передаются программе. Ошибка prebirth admission сохраняет fail-closed containment.
- Scoped Stop использует existing broker request-id deduplication; повтор того же frame не сигналит заново.
  Вечный `terminationRequested` заменяется bounded in-flight ownership: новый отдельно разрешённый attempt допустим
  после завершения предыдущего, а его прежний unknown outcome не переписывается. Второй command journal не создаётся.
  Read-only scope observation возвращает только actual root-exit/Job facts; она никогда не вызывает termination и не выдаёт whole-provider receipt.

Приёмка через существующий native scenario: original service root exit при живых детях; scoped Stop/parallel retirement без
HANDLE reuse; повтор старого scope/request после retirement не захватывает новый process; bounded series коротких children
превышает TEST live-cap cumulatively и сохраняет соседний live service/provider. Foreign witness и финальный whole-owner
cleanup обязательны. Capacity/lifetime checks дополняют actual vendor gate, не подменяют его и не доказывают cold recovery.
Использовать прежний independent controller/deadline; если реальные measured phase limits не помещаются, выделить одну
короткую ветку существующего gate, не увеличивать общий timeout без причины.

После native evidence остаются отдельные §24.3–5: finite typed wire/staged capability, async Host fence integration,
V2 Bun graph, current Processes UI и packaged proof. `TeamProcessCommands`/Linux owner в этом helper cut не меняются.
Оценка cut: примерно200–320 native/helper строк с переносом existing code,50–100 строк native checks/adapters;
это не обещание полного Windows parity. Root/source review обязателен до activation.

## 27. Exact c5 native CI: завершённые результаты и узкое исправление подготовки Windows

[Run43348419492](https://github.com/777genius/agent-teams-ai/actions/runs/43348419492)
проверил exact source `c5ae9b03a84965f9e497d60d4ff6beac1c5640b8`; все три jobs завершились.

- Windows x64 [job131633266739](https://github.com/777genius/agent-teams-ai/actions/runs/43348419492/job/131633266739)
  и ARM64 [job131633266857](https://github.com/777genius/agent-teams-ai/actions/runs/43348419492/job/131633266857):
  existing Node26, Electron и HostNode24 native gates PASS. Step14 подготовки pinned Claude завершился
  `Selected official integrity is still in the exact frozen repository lock`; actual SDK vendor step15 не выполнялся.
  Exact Git lock содержит обе выбранные SRI SDK0.3.305. Старый текстовый поиск требует LF:
  на exact LF bytes он проходит, на их CRLF форме воспроизводимо отказывает. Исправление нормализует только CRLF→LF
  перед прежним exact package/version/SRI search. Обе архитектуры проходят LF/CRLF textual checks; изменённый SRI отвергается.
  Это проверка исходных строк в V8, не native execution. Raw runner lock из artifact пока не прочитан;
  CRLF — подтверждённый дефект проверки, но конкретные checkout bytes не объявляются наблюдёнными.
- Linux [job131633266519](https://github.com/777genius/agent-teams-ai/actions/runs/43348419492/job/131633266519):
  Node26/Node24/Electron primitive PASS; step11 **genuine Claude SDK → background Bash services → MCP register →
  выбранный Human Stop → ordinary owner close PASS**, source freeze PASS. Step12 cold Host Processes UI завершился
  wrapper exit1; packed preparation и packed UI steps13/14 не достигнуты. После исправления parser из §25
  новая точная причина ещё не установлена: общий Actions log содержит только `desktop-backend-smoke.ts` child exit1.
  Original evidence удержан в artifact `14003779154`, `registered-linux-x64-c5ae9b03a84965f9e497d60d4ff6beac1c5640b8`.
  Artifact получен официальным download API; его ZIP content ещё не извлечён из-за unavailable executor.
  До чтения original logs нельзя приписывать отказ прежнему parser или заявлять UI Stop/cleanup PASS.

Следующий отдельный cut — только Windows EOL fix и этот status; текущий завершённый source не перезапускается.
§26 helper draft имеет source review exact retained pid+birth lookup отдельно от current-event PID index и deadline
перед destructive dispatch; удержанный original HANDLE не допускает physical PID reuse, как уточнено в §24; compiler/native qualification ещё не выполнена, staged product activation отсутствует.
Windows vendor, Host registry/async fence, positive cold UI, packaged M19 и Linux older-kernel/ABI gates остаются открыты.

## 28. Linux warm custody, старый ABI и проверка живого worker после выхода leader

Следующий source cut следует §23. Native durable pidfs v3 остаётся предпочтительным; настоящий kernel probe
выбирает owner-local pidfd v4 там, где durable pidfs отсутствует. Исходные pidfd удерживаются в том же owner,
root захватывается до первого await; stale/unknown и новый Host не усыновляют PID. Полный native capture,
registrar, root и source identity сохраняются. `/proc` Z/X или ошибка чтения не доказывают отсутствие:
оно принимается только по исходному pidfd. Завершённый terminate receipt с observed-absent и digest полного
capture переносит terminal proof; естественный exit без такого receipt остаётся owner-local фактом.

В existing Linux native actor добавлен один thread-leader случай: main thread завершён, worker продолжает
жить до прежнего TEST TTL. Observe обязан вернуть unknown, signal — refuse, worker не закрыт; финальная
absence подтверждается исходным kernel handle. Прежний native runner исполняется в automatic и forced-warm
режимах, без второго suite и без увеличения его45s bound. C actor собирается с pthread.

Один existing-style Ubuntu22 ABI job использует официальный UBI8 image, разрешённый в точный RepoDigest,
и фиксирует toolchain image ID/RPM versions. Тот же NAPI8 artifact действительно собирается и загружается
в glibc2.28 userspace; ELF minimum должен быть не выше2.28. Затем неизменные bytes проходят native runner
на actual host kernel, где automatic capture обязан быть v4. Новый kernel с pidfs не может незаметно
выдать warm gate PASS. Container не подменяет kernel; настоящий kernel4.18 этим ещё не квалифицирован.
Build/load offline с read-only source/Node mounts и private TEST output; source/hash/frozen inputs проверяются.

До последней потери executor локальный14-file cut прошёл Host build/test types,12 critical cases и genuine
Node24.21 automatic/forced-warm proof на kernel6.18.57. Тогдашний binary SHA256:
`01f7cf27c7ae2615e7ef9c0e999f2066d24b3e5479cc2a915215ce257cdbe57e`,
manifest SHA256 `9b5ab8c74e30393d527e6e4c7ee5a0c2a964afc33a48b5850e9a63f544b3f278`.
Remote source восстановлен из сохранённых applied patches; эти результаты не переносятся автоматически
на окончательный cut. Новые thread-leader/двойной runner/ABI scripts и workflow имеют независимое source review,
но ещё требуют compiler и actual CI. Совокупный новый cut не объявлен qualified.

Для unresolved Linux cold UI failure §27 existing harness добавляет только безопасную failure projection:
фиксированный kind и до6 разрешённых source frames из bounded stack; без Error.message/actual/expected,
raw paths, secret payload или нового product DTO. Wrapper читает только исходный private TEST receipt
с size/regular-file/no-follow checks. Исходный failure и artifact сохраняются; время, admission и cleanup
не меняются. Always-upload сохраняет также partial native proof/capture при падении до итогового JSON.
Ни warm native proof, ни glibc ABI не заменяют positive cold Processes UI и packaged gates.

## 29. Exact f418 Windows vendor: подтверждённое падение и сохранение конечной диагностики

На `f418ea2e09c38ee5dfdfb1ddbc15b3e5a851dc46`
[run43352783873](https://github.com/777genius/agent-teams-ai/actions/runs/43352783873)
Windows x64 job131647594264 и ARM64 job131647594608 прошли подготовку pinned SDK/Bash после EOL correction.
Actual SDK открывается, readiness и submit ACK завершаются, но START не получает matching result за прежние35s.
Scoped Stop и continuation ещё не достигнуты. Submit ACK не равен native provider acceptance. Independent
controller после failure подтвердил activeProcesses0; это cleanup, не успешный vendor service scenario.
Linux [job131647594499](https://github.com/777genius/agent-teams-ai/actions/runs/43352783873/job/131647594499)
завершён: genuine Node26/Node24/Electron native steps6/8/9 PASS; step11 actual Claude SDK → background Bash →
MCP register → selected Human Stop → ordinary owner close PASS, source freeze PASS. Step12 cold Host Processes UI
снова завершился wrapper exit1 после44s; inner cause ещё скрыта в private receipt, packed steps13/14 skipped.
Official evidence сохранено в artifact `14007732210` (1,867,526 bytes); ZIP получен, но ещё не извлечён при
unavailable executor. Отказ не приписывается прежнему parser и не заменяется предположением; §28 safe diagnostics
входят в следующий source cut. Run завершён и не перезапускается.

Existing Windows TEST fixture теперь снимает закрытый snapshot до teardown: fixed phase, model HTTP counters,
8 SPI event kind counts и correlation counts для2 исходных operations. Только enum/count/boolean попадают
в receipt и failure log; тексты, IDs, paths, payloads и Error.message не добавляются. Cleanup cancellation
не засчитывается как native completion. Исходная ошибка/aggregate и все35s/7s/45s bounds сохранены.
Два diagnostic files прошли независимый source/privacy review; compiler/native verification ещё pending.

§26 helper также подготовлен и source-reviewed: shared original HANDLE/Job lifetime, bounded records с retirement
только unregistered root-exit+Job0, monotonic scope keys, exact request replay, deadline непосредственно перед
destructive dispatch. Existing TEST scenario проверяет80 последовательных завершённых children при live cap64,
old-key retirement и чужой живой service. Это не имитация физического PID reuse при удержанном HANDLE.
Registered terminal scope пока удерживает HANDLE до releaseRegistration; отдельный owner-local tombstone без
HANDLE относится к будущему §24.3–4, а не к уже подготовленному §26 helper.
Production scoped Windows capability не включена. После actual vendor PASS остаются typed wire, async Team fence,
V2 custody, original Processes UI, packaged evidence и отдельный положительный cold-owner gate §24.

## 30. Windows cold Host: необходимый lifetime исходного Main owner (план до source)

**R12 research, без product activation.** Сохранить live original service через Host restart и одновременно
оставить нынешний broker привязанным к EOF этого Host нельзя: `broker.cpp::abandon` завершает процесс с sole Job handles,
а выход debug thread по умолчанию также завершает debuggees
([Microsoft DebugSetProcessKillOnExit](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-debugsetprocesskillonexit)).
[Job semantics](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) распространяют kill-on-last-close
на вложенные Jobs. Это несовместимость выбранного lifetime с положительным cold сценарием, не основание убрать сценарий.

### Проверенные альтернативы и выбранная граница

| Вариант | Проверенный контракт / граница |
| --- | --- |
| `NtQueryInformationProcess(ProcessTelemetryIdInformation=64)` | [Microsoft](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntqueryinformationprocess) документирует query; [структура](https://learn.microsoft.com/en-us/windows/win32/devnotes/process_telemetry_id_information_type) содержит ProcessStartKey/ProcessSequenceNumber/BootId, min client Windows10. Это кандидат для process-incarnation observation, но не original Job/subtree custody; Server2022/ARM native qualification не выполнена. |
| `SystemBasicProcessInformation.SequenceNumber` | [Microsoft](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntquerysysteminformation) гарантирует обнаружение PID reuse, но API доступен с Windows11 build26100.4770; не общий Server2022 baseline. |
| ETW process key / kernel helper | [ETW](https://learn.microsoft.com/en-us/windows/win32/api/evntrace/ns-evntrace-enable_trace_parameters) определяет unique-in-boot Process Start Key. Это не восстанавливает потерянный Job; новый tracing owner/driver не нужен выбранному пути. |
| Исходный broker остаётся у существующего Main | Сохраняет те же original HANDLEs, debug thread, scope keys и control stream. Не нужны PID reopen, job-name adoption, extra daemon или новый command journal. Это выбранный путь для **Host restart в том же Main epoch**. |

Process key не объявляется доказанным portable subtree token. [IsProcessInJob](https://learn.microsoft.com/en-us/windows/win32/api/jobapi/nf-jobapi-isprocessinjob)
не предоставляет original Job HANDLE по чужому process HANDLE; named-Job absence по-прежнему не proof.
Полный Main crash — отдельный cleanup исход; этот cut не обещает сохранение живых services через исчезновение Main.

### Минимальная реализация с явными transport constraints

1. **Физический owner с момента launch.** Один прежний broker на provider allocation создаётся существующим Main
   composition и живёт ровно его captured owner epoch. Main удерживает pending capability **до первого await**;
   исходный prepared root/scope устанавливается до resume/stdin. Host сохраняет logical Runtime/Team ownership
   и единственный существующий журнал commands. Main native adapter не пишет его файлы и не решает provider policy.
   Broker/Job handles не дублируются второму владельцу; simple duplication не решает lifetime debug thread.
   Изменение kill-on-loss явно: provider broker зависит от Main control EOF, а не от транспорта временного Host.
2. **Existing private transport требуется расширить, не выдавать его за готовый duplex port.**
   В `packages/legacy-agent-host/src/{contracts,index,framing,output}.ts` и
   `src/features/agent-backend/main/infrastructure/CapturedHostClient.ts` текущие readers принимают
   Main→Host requests и Host→Main responses/notifications. Они ещё не поддерживают reverse custody requests.
   Добавить одну закрытую Windows-native request/response family в этом же канале, с согласованной captured capability,
   раздельными original request IDs/Host epochs, finite schema, deadlines и bounded pending count.
   Каждый запрос связан с exact original Host child/epoch и captured launch/profile/spec; после seal старые
   allocation/write/control requests отвергаются. Уже начатый effect только reconciles исходный receipt без replay.
   Не использовать lossy `notifyData`/`host.gap` для SDK stdio: `HostOutput.sendData` может выбрасывать сообщения.
   Control reserve для Stop/release/close сохраняется независимо от data backpressure; новый socket/daemon не требуется.
3. **Stdio/backpressure — обязательный контракт, не telemetry.** Host SDK получает малый structural facade через
   существующий `OwnedProcessFacade`/Windows adapter; Main владеет настоящими stdin/stdout/stderr original broker.
   Использовать bounded pull/read-credit или equivalent lossless bounded frames через тот же private channel;
   chunk/queue bounds укладываются в прежние frame/priority budgets, binary bytes не преобразуются через lossy text.
   Writable callback подтверждает завершение исходной native write, не enqueue RPC. Readable pause/_read сохраняют
   backpressure, EOF/exit/error и final drain независимы; stdio completion никогда не является tree proof.
   Не расширять общие quotas ради этого порта и не отправлять bytes в logs/renderer notifications.
4. **Host loss не делает implicit native close.** Seal старый Host input epoch, сохранить Main capability,
   original pending outcomes и bounded stream state; late stdin ACK не даёт разрешение на replay.
   Неподтверждённый Runtime input остаётся unknown; новый Host не начинает заново SDK turn и не присваивает старый
   conversation iterator. Process read/Stop может работать с original scope независимо от этого Runtime hold.
   Во время отсутствия consumer stdout/stderr остаются bounded/paused; private control Stop не зависит от их drain.
   После настоящего physical Stop выполняется прежний bounded drain. Если existing facade не разделяет
   transport disposal и physical Stop, добавить один явный owner operation; не использовать fake `closed=true`.
5. **Guarded rebind вместо снятия sealed guards.** `BackendOwnerRouter.ts` и
   `main/composition/{createCapturedHostClient,DesktopBackendFeature}.ts` получают только узкий
   original-owner rebind: тот же живой Main epoch, exact profile/build/source/storage binding, подтверждённый exit
   исходного ChildProcess Host и успешный захват прежнего `ProfileWriterLease` новым Host.
   Старый client навсегда sealed; новый client не делит writer с ним. Existing lock recovery не обходится, файлы
   lock не удаляются по возрасту/PID из renderer. Новый Main epoch/чужой owner/изменённый source не rebind-ится
   к старому scope. Это отдельный product recovery путь; автоматический повтор effect или цикл restart не добавляется.
6. **Связь с §24.3–4 без второго owner map авторизации.** Main хранит свои physical capability objects,
   Host `WindowsRegisteredProcess` связывает их с полным private capture и текущей Team authority.
   Scope access идёт через исходный Main native owner, а command admission/settlement — через прежний Host journal/fence.
   Renderer получает только existing processRef/rows. Нельзя передать raw HANDLE, PID+birthday, executable/env или
   новый произвольный scope selector через публичный IPC вместо captured native source.
   Все process lease/rebind refs остаются private. Host async checks и physical Main epoch проверяются на каждом await.
   V2 sealed graph и selected executable сохраняют полную свежую original attestation через закрытую
   Host→Main capability operation. Прошлая проверка Main или измерение PID после rebind её не заменяют.
7. **Main quit/crash отдельно.** Changed-source refusal не отбрасывает исходные cleanup capabilities:
   Main Quit/cleanup использует уже удержанные handles, без rebind или новой allocation.
   Quit сначала seals admission, затем original provider scopes/Jobs stop→drain→release
   по существующему порядку. Main loss закрывает control ownership и включает прежнее containment broker/debugger.
   Это не live cold recovery и не автоматический durable `observed-absent`: такой результат допустим только по
   genuine terminal proof, сохранённому существующим command owner. Без него состояние unknown; PID/name отсутствие
   не создаёт cleanup receipt. Independent TEST controller может подтвердить фактическую Main-loss очистку отдельно.

**Необходимое изменение прежнего решения §24:** blanket запрет router restart заменяется только пунктом5 —
доказанный rebind того же Main physical owner после конца старого Host. Общий auto-restart, duplicate owner/storage,
новый supervisor, переназначение чужих handles и полный Main-cold survival по-прежнему не разрешены этим планом.

**Linux warm lifetime — отдельная последующая проверка.** Тот же Main physical owner и private transport могут
удерживать исходную Linux pidfd capability через Host replacement; второй owner/daemon для этого не нужен.
Текущий Host-local warm v4 этого не доказывает. Для такого переноса исходный spawn/capture должен изначально
принадлежать Main с тем же capture-before-yield; отдельно проверить native loader/ABI в Main и сохранение
original-fd poll/lineage guards. Передача числа fd,
PID reopen или Host-local receipt без живого исходного fd не является retention. Этот Windows cut не активирует
Linux перенос и не квалифицирует его cold сценарий.

### Приёмка до product activation

Расширить существующие native/controlled-cold/Desktop fixtures, не создавать общий recovery framework:
actual Host A register/list → явный same-Main detach/rebind с завершением Host A → Host B → тот же processRef → scoped Stop;
это отдельный recovery путь: прежний `host.shutdown`/Quit по-прежнему выполняет stop→drain→release,
а не сохраняет процессы при любом graceful exit. После scoped Stop original service descendants исчезают,
provider/neighbor/foreign witness остаются живыми. Отдельно проверить
Host crash при capture/Stop/stdio write, late old-epoch reply и read-only lookup без replay; pressure stdout/stderr
не мешает control Stop; changed Main epoch/profile/writer отказывается; Quit и Main death имеют собственный
original-root/Job/witness cleanup proof. Затем тот же current Processes UI и packaged artifact на x64/ARM64.
Actual SDK/Bun compatibility, writer handoff и lossless reverse transport остаются реальными gates;
fixture-only broker retention не заменяет ни один из них. Review root + независимый peer обязателен до source;
vendor PASS обязателен до product activation. Warm helper/wire из §26/§24.3 можно готовить независимо.

## 31. Следующий §24.3 срез: scoped wire и bounded replay (source review, native pending)

**Основа:** exact native head `55d95d83a181e66fcc17fa682d9602cf2819fb52`;
обычный merge в `9d364968ea1c9f74b6ec9636604b9e4e0064849e` сохранил все шесть preimages.
Ни этот Markdown, ни unattached source blobs не включают новую capability в продукт.
Текущий native run `43361737432` относится к **9d3649**, без следующего wire среза.

### Что меняется в существующем broker

- Добавлены отдельные finite capture/query/Stop/settle opcodes и service responses.
  Payload связывает non-reused scope key и original birth; lookup capture использует
  exact retained PID + birth, без OpenProcess/adoption. Service facts не являются
  `TreeReceipt` и не проходят через whole-provider `publishRoot`.
- Native service handlers остаются только в прежней TEST debug сборке.
  Обычный staged broker отвечает `unqualified`; product manifest/debug flag,
  Host process integration и public UI в этом срезе не активируются.
  Прежние TEST mode2/mode3 намеренно сохранены: actual vendor fixture пока использует
  прежний TEST adapter. Его исход нельзя объявлять квалификацией нового typed wire.
- У прежнего reply mutex один bounded effect history: максимум 4 unresolved effects
  и 64 settled replies. Query не занимает replay history; pending unknown не вытесняется.
  C lifetime frame limit 1024 убран, TS request ID идёт до uint64 max без reset;
  существующий предел 4 TS waiters остаётся. Service workers ограничены 3, native работа
  заканчивается до публикации ответа. Нового transport, journal или worker framework нет.
- Identical pending/cached effect не dispatch-ится повторно. Evicted ID получает finite
  retired/unknown refusal без нового effect и без abandon здорового провайдера.
  Это **не** означает known-not-sent для прежней попытки: её effect мог завершиться.
  Mismatched retained request/generation/corrupt frame сохраняет containment refusal.
- Native Stop budget фиксируется при admission до worker. Узкий шестой hunk в
  `serviceScopes.h` передаёт optional original monotonic admission time в прежний
  `Scopes.stop`; очередь и ожидание registry потребляют тот же budget, перед
  TerminateJobObject вновь проверяется deadline. Existing TEST callers сохраняют
  собственный budget; query/settle не посылают signal.

### Явные границы registration и lifetime

Повторный `ServiceCapture` с новым request ID возвращает **тот же scope** и ставит
прежний registration boolean. Это не несколько независимых native leases.
Будущий product contract для нескольких logical registrations одной scope, late MCP
registration и их settlement ещё должен быть согласован с existing Host registry/fence;
нельзя снять чужую действующую регистрацию одной командой settle.
Этот срез не добавляет owner-local terminal tombstones, durable natural-exit proof,
Main retention/rebind (§30), WindowsRegisteredProcess или TeamProcessCommands изменения.

### Проверка и следующие gates

Существующий controlled native scenario, без новой suite, теперь проверяет 1025
последовательных read-only queries, 64 дополнительных settled capture responses и
retired original request ID; original scope/provider остаются живы. Также проверяются
zero-budget Stop без signal, настоящий scoped Stop, settlement и replay исходного
Stop ACK после retirement, отказ нового Stop/query по закрытому scope.
Foreign/neighbor/provider witnesses и самостоятельный whole-provider cleanup сохранены.
После замечания peer проверка потока ответов сохраняет единственный
`rootExit`: до whole Stop его нет; затем проверяются original root birth и exitCode.
Root exit, service absence и full provider cleanup по-прежнему разные факты.

Root review всех 6 source файлов и независимый Profiles TS/conformance review — PASS;
Независимый Account C lifetime/cleanup review — PASS. Exact preimages проверены по native tree,
каждый draft blob прочитан обратно без различий. **Compile/native execution ещё не было**:
executor недоступен, результат 9d не переносится на этот следующий срез.
Native и TS changes с existing conformance fixture должны публиковаться вместе после
review, затем получить собственные exact-head checks. Текущий 9d run не отменяется.
После actual vendor PASS отдельно продолжаются manifest/capability/Host async-fence,
registry/Processes UI, cold owner и packaged acceptance; этот source cut их не закрывает.

| Path | Exact preimage | Reviewed draft blob |
| --- | --- | --- |
| `tools/owned-process-broker/protocol.h` | `98b2a2743863ab29598aa6306691332bc7144360` | `60f9ae497a0bc8f9cf9d7cc32c278bc6afbfe4a4` |
| `tools/owned-process-broker/broker.cpp` | `b82e54077c41242027cbe6400f7240972074f460` | `50aaa950504f76d2c34fdfe71632f16238ca62a1` |
| `tools/owned-process-broker/serviceScopes.h` | `6a4b39286bb4d0489aca8ec2aaf203015d404507` | `f837c905946282906d8ced5a5a260c0e43c26b2d` |
| `packages/legacy-agent-host/src/owned-process/codec.ts` | `3f8268481f09b232c9f567f0fb1f64678d3877f0` | `ae5eded9c4f0520a65be73fa1bc8c92e135f3b91` |
| `packages/legacy-agent-host/src/owned-process/windowsBroker.ts` | `2beae81680a9a4dd2e849e624a03b5321fa450b4` | `3684ca835d4ff592c261f553f2fdf9bce8972422` |
| `tools/owned-process-broker/nativeDebugServiceScenario.ts` | `893f5ebe6fe3cc5d4294e26450f35e22db50c5e8` | `6cbc36e76cdf2c3ee80419c5098f7c4da8a55a77` |

## 32. Actual 9d compile findings и извлечённая f418 cold UI причина

Run [43361737432](https://github.com/777genius/agent-teams-ai/actions/runs/43361737432)
проверяет exact `9d364968ea1c9f74b6ec9636604b9e4e0064849e`.
Windows x64 job `131676600657` и ARM64 `131676600672` завершились failure на шаге9:
MSVC /WX отклонил TEST lambda `broker.cpp:334` — локальный `birth` скрывает global birth
(C4459/C2220). Поэтому этот запуск ещё не проверил native service/vendor поведение.
Узкое исправление `e911cd6220f783304af506ae3a273bdc40252016` меняет только три использования
локального имени на `serviceBirth`; новый wire broker `50aaa950504f76d2c34fdfe71632f16238ca62a1`
содержит то же механическое исправление поверх reviewed `0d90199e7a1c04f82e01d40bbd289c6cd675d93b`.
Таблица §31 указывает уже этот окончательный draft; native semantics и deadlines не изменены.

Linux ABI job `131676600784` завершился failure на шаге7 **до** native artifact/load proof:
старые headers штатного glibc2.28 toolchain не определяют `SYS_pidfd_open`.
Reviewed draft `841cda775caf1f7618dea59e89267d85c888d158` добавляет guarded x86-64 syscall number434
и явный отказ x32; runtime capability probes, pidfd lifetime и guards остаются прежними.
Основание: [официальная Linux v6.1 syscall table](https://github.com/torvalds/linux/blob/v6.1/arch/x86/entry/syscalls/syscall_64.tbl),
exact blob `c84d12608cd2de9e45f6cc166169cf70ecbf7518`.
Это не symbol-version hack, не расширение product tuple и не объявление ABI/native PASS.
Linux pidfs job `131676600318` перешёл в in_progress (шаг5); его не отменяем и не перезапускаем.
Локальный executor восстановлен; прежняя запись §31 об отсутствии compile относится к моменту
первоначального source review. Новые фактические результаты приведены ниже и не заменяют native CI.

Официальный f418 Linux artifact `14007732210` извлечён после восстановления executor:
ZIP 1,867,526 bytes, SHA256 `32c0294d8c9406998a48a5cf033a0a01b292d28ad0f06e7510ae38923b916649`.
В `cold-ui/fixture/desktop-backend-receipt.json` исходная ошибка — `one CDP listener: 2 !== 1`.
Первый listener и matching Main найдены за27.5s; повторная ownership проверка отказалась до UI operations.
Причина двух holders ещё проверяется; повторные строки, inherited descriptor или посторонний listener
не считаются доказанными без соответствующего наблюдения. Original primary/neighbor/root cleanup — PASS;
это не cold UI/Processes/packaged PASS и не основание ослаблять CDP ownership assertion.

### Локальная проверка восстановленного следующего среза

Pinned pnpm11.22.0 frozen install завершён; Host build, owned protocol typecheck,
legacy-host scripts typecheck, existing protocol tests **45/45**, source-size guard и diff check — PASS.
Первый protocol typecheck обнаружил четыре отсутствующие finite phase labels:
`service-capture`, `service-query-lifetime`, `service-effect-retirement`, `expired-service-stop`.
В прежнем `tools/owned-process-broker/nativeGateDiagnostics.ts` добавлены только четыре union literals:
preimage `4f3e90d2b7643a7d94fdfe8c204a0f90e0bee71c` →
draft `1717e066d2c2fe7e608ee22f308aa884556afa00`.
Это обязательный **седьмой wire файл**; без него первоначальные шесть файлов не компилировались.
Runtime handlers, native guards, data projection и budgets этим исправлением не меняются.

Existing `qualifyLinuxProcessNative.ts` на Node24.21.0 с C draft `841cda775caf1f7618dea59e89267d85c888d158`
прошёл genuine automatic v3 и forced warm v4: completed=true, cleaned=true.
Original target Stop выполнен один раз, соседний service жив; changed session отказывается.
Отдельный настоящий live worker после выхода thread leader наблюдается как unknown и не получает signal.
V3 cold original read/Stop доказан в этом kernel; warm v4 в новом owner остаётся unknown/refused,
как требует retained-handle lifetime. Это не Windows и не older-kernel cold proof.
Локальный artifact имеет libc minimum2.33; glibc2.28 supply/load всё ещё ждёт исправленный CI gate.
Manifest SHA256 `e08f7ea208b6bd1e25c850c6c2f2d2c60869053d9191e9c1fabec75145e178f5`,
binary SHA256 `01f7cf27c7ae2615e7ef9c0e999f2066d24b3e5479cc2a915215ce257cdbe57e`.
Windows MSVC compilation, typed scoped native scenario, actual vendor journey и cold UI/packaged
по-прежнему pending: Linux и source checks не заменяют эти проверки.

## 33. Следующая диагностика original CDP holders без изменения guard

Exact 9d Linux artifact `14010465062` (ZIP SHA256
`7a3704cc12750be90ba346ce0872e963118f1affe93e3385cbd0b647dce49148`)
снова содержит `one CDP listener: 2 !== 1`, до UI operations. Native Node26/Host24/Electron
и actual SDK register/Stop — PASS; cold UI и packaged не пройдены.
Одна локальная bounded пустая TEST Electron44.10.1 репродукция дала один PID/FD;
original exit0 и пустая captured group подтверждены. Она не воспроизводит CI defect и не является qualification.

До следующего native push расширить **тот же исходный Linux lsof read**, не делать racy follow-up после assert:
existing captured TEST PID group + selected CDP port + LISTEN filter, прежний timeout и maxBuffer.
Machine fields дают PID, FD, family, inode/device если доступны, finite local endpoint/state.
Парсер ограничивает retained diagnostic records16; unique PID count вычисляется по полному исходному output.
Несколько descriptors одного PID сохраняют прежнюю семантику; два PID всегда отказываются, даже если inode совпал.
Никакой socket/PID adoption, signal, retry или смены listener не добавляется; Darwin `-t` путь прежний.

В existing `desktop-backend-observations.ts` private error→facts WeakMap связывает finite projection с той же
исходной assertion, а existing `desktop-backend-smoke.ts` catch сохраняет только эти facts в TEST receipt.
Нет argv, env, произвольного filename или raw lsof output в projection. Отсутствующий inode явно unknown,
а socket device не объявляется доказанной стабильной identity. Исходная ошибка/cleanup остаются прежними.
Один critical case в existing observations tests проверяет две holder identities и privacy; новой suite нет.
Затем actual next Linux CI должен дать оригинальные descriptor facts. Только по ним выбирается исправление.

## 34. Actual dc16 gates и следующий закрытый Main↔Host custody срез

Основа — native `dc16f3373edd5994c41fb30ff660b0dd6a2beecc`, run
[43366664072](https://github.com/777genius/agent-teams-ai/actions/runs/43366664072).
Linux ABI job `131692551805` — **SUCCESS**: один native artifact построен и загружен
в offline glibc2.28 userspace, затем на actual older host kernel пройден automatic warm gate.
Manifest SHA256 `56e833541798b7f1142e17e9e9e90408c18b2aa4a42eb79151069b7f9819958a`,
binary SHA256 `f078213b34b9a8190251951a8d76e0cadb99400124ce29ddaa70a143a545b584`.
Это supply/warm proof; он не превращает Host-local pidfd в cold capability после смерти owner.

Windows x64 job `131692552110` и ARM64 job `131692552014`: compilation/types и genuine Node/Electron/Host24 gates — PASS;
actual Claude vendor step15 — **FAILURE**. До исходного START deadline35s наблюдались
model backgroundTool=1, backgroundResult=0, tool=1, interaction=1, result=0.
Whole-provider cleanup и original Job release подтверждены. Тестовый observer сохраняет interaction,
но не вызывает SPI `respondToInteraction`, поэтому genuine permission остаётся без ответа.
Следующий узкий TEST fix разрешает не более одного запроса только с exact START input/operation,
original session, kind=permission, tool=Bash и полным совпадением captured command/description/background input.
Ответ `{ kind: 'permission', decision: 'allow' }` завершает только original pending interaction;
settings/permission policy, product flags, deadlines и native custody не меняются.
Другой запрос немедленно отказывается; ожидание результата не заменяется blanket auto-approval.
Новый exact-head vendor run ещё требуется. На обеих Windows архитектурах наблюдался тот же original interaction; Linux pidfs текущего run продолжается штатно.

### Следующий отдельный source срез по §30, до product activation

Current `CapturedHostClient.receive` воспринимает любой id как обычный RPC reply;
`createHostServer` принимает только requests, а data notifications допускают потерю и gap.
Поэтому native stdio нельзя передавать через текущие generic notifications или считать
добавление callback готовым Main retention. Нужен один закрытый private custody family
на том же captured stdin/stdout с конкретным subprocess consumer уже в первом срезе.

| Файл | Минимальное изменение |
| --- | --- |
| `packages/legacy-agent-host/src/owned-process/hostCustody.ts` (новый) | Закрытые operation/reply schemas и узкий Host endpoint; без generic RPC framework и свободного имени метода. |
| `packages/legacy-agent-host/src/owned-process/index.ts` | Private export через уже существующий entry; browser-safe `contracts.ts` не получает native DTO. |
| `packages/legacy-agent-host/src/index.ts` | Явная optional native binding, routing reverse replies/private readiness и seal текущего endpoint. Default CLI не активирует capability. |
| `packages/legacy-agent-host/src/output.ts` | Reliable private frames в существующих bounded output budgets; native bytes не идут в lossy data lane. |
| `src/features/agent-backend/main/infrastructure/CapturedHostClient.ts` | Reverse requests принимаются только от original captured Host child/epoch и заранее supplied private physical-owner port. |
| `src/features/agent-backend/main/composition/createCapturedHostClient.ts` | Optional trusted port injection; lifetime physical owner не переносится внутрь per-Host client. |

Первый consumer — TEST physical-owner port, удерживаемый независимо от обоих Host clients.
Он даёт заранее captured opaque capability для bounded stream read/write/end и original observe/Stop/release;
в этой версии нет native spawn, произвольных executable/argv/env, нового Job, daemon, socket или journal.
Real Main owner, свежая graph/executable attestation, WindowsRegisteredProcess и async TeamProcessCommands
остаются следующими отдельными integrations. TEST transport proof не квалифицирует их и не восстанавливает SDK turn.

Ограничения wire/ownership:

- Direction, original Main epoch, Host incarnation и exact pending entry отделяют reverse IDs от обычных RPC IDs.
  Binding относится к captured profile/source и private capability; старый Host не может адресовать successor.
  После seal EOF/timeout делает старое ожидание terminal unknown; late reply не завершает новую epoch,
  native effect не повторяется. Timeout транспорта сам по себе не означает известное отсутствие dispatch.
- Existing pending32/control reserve8 сохраняются в обоих направлениях; constants не повышаются.
  Private frames делят прежние output/write byte budgets с ordinary traffic, а не получают ещё одну безлимитную очередь.
  Work не занимает reserved control slots. Actual subprocess test обязан доказать Stop progress при stdio pressure.
  Проверяется также заполненный work byte budget, а не только число pending slots.
- Stdio передаётся bounded pull replies, максимум16KiB bytes за chunk; bytes не выводятся в notifications.
  Private readiness hint без payload и с одной outstanding отметкой на stream позволяет не держать
  24 long-poll requests на тихих процессах и не использовать busy polling. Hint не является native receipt.
  Readiness/EOF обрабатываются до generic notifications; lossless byte order и original write callback обязательны.
  Hint идёт только reliable private lane; outstanding mark снимается подтверждённым read/drain,
  а не локальной попыткой отправки, иначе потерянный hint оставит stream навсегда в quiet состоянии.
- Native deadline фиксируется original Main owner при admission; `performance.now()` разных процессов не сравнивается.
  Host disappearance не уничтожает reference исходного cleanup owner. Detach/rebind, обычный Quit,
  source drift и Main death сохраняют различные semantics §30; этот срез не меняет product shutdown.

Добавить только critical cases в existing `test/features/agent-backend/capturedHostClient.test.ts`
и `packages/legacy-agent-host/tests/transport.test.ts`: actual Host A/B subprocesses; bounded stream pressure
при свободном control reserve; partial write/EOF → unknown без replay; old-epoch reply; private bytes
не появляются в UI notifications; original TEST owner продолжает cleanup после закрытия Host A.
Новых suites/runner нет. До source требуется root + peer review; затем focused build/types и эти existing tests.
Actual Windows SDK/Bun, retained physical handles, writer handoff и cold Processes UI/packaged gates остаются обязательными.

### Следующий native selector, не скрытая PID adoption

Production register получает PID, тогда как уже проверяемый C `ServiceCapture` требует PID+birth.
Минимальное последующее расширение — `Scopes.registerCurrent(pid)` под прежним registry mutex:
`currentPids` → original retained record → consistent PID и живой original HANDLE (`WAIT_TIMEOUT`) → key+birth.
Только CREATE_PROCESS_DEBUG_EVENT уже захваченного provider; нет OpenProcess, process-table lookup или нового scope.
Это означает **текущий живой original child в момент первого atomic admission**; историческую incarnation,
о которой caller помнил ранее, один PID не доказывает. Missing/retired/unknown отказываются без fallback.
Actual retry сохраняет request ID/receipt/key в existing effect cache; новый ID нельзя назвать replay.
Existing exact capture остаётся. После initial capture все query/Stop/settle идут только по original key;
новый tombstone registry ради исторического PID lookup не вводится. Этот selector требует собственного native proof
и пока не входит ни в первый transport cut, ни в product `RegisteredProcessCapture` union.

## 35. Linux cold UI: наблюдение двух исходных CDP holders до изменения admission

Фактический run [43366664072](https://github.com/777genius/agent-teams-ai/actions/runs/43366664072),
head `dc16f3373edd5994c41fb30ff660b0dd6a2beecc`: Linux job `131692551964` прошёл native Node26,
Host Node24, Electron и actual SDK/service Stop; cold UI step12 отказал до UI interaction, packed steps13/14 skipped.
Artifact `14012602104`, ZIP SHA256 `d7f18526518ca796ebb0ebdbbd2fdd53b302182d7b98767ede038face8477320`,
сохранил original failed lsof read: PID5448/FD61 и PID5536/FD61, оба IPv4 loopback LISTEN,
`inode=null`, `device=null`. Первый PID подтверждён Chromium log исходного Electron; роль второго не установлена.
Одинаковый FD не доказывает общий socket. Controlled root/primary/neighbor cleanup и пустая app group подтверждены,
но это не proof cold UI/packaged parity. ABI lane отдельно PASS; выводы о Main/Windows cold authority не меняются.

Официальный [lsof manpage, OUTPUT FOR OTHER PROGRAMS](https://lsof.readthedocs.io/en/stable/manpage/)
указывает, что inode `i` и protocol `P` взаимоисключающие и выводятся только доступные поля.
Поэтому текущий `-FpfDtinPT` с TCP не гарантирует inode; ещё один такой же read не закрывает неопределённость.
Следующий срез — только passive диагностика в existing `desktop-backend-observations.ts` и его existing regression,
без изменения строгого `one CDP listener`, signal authority, выбора renderer или условий PASS:

1. Перед original lsof сохранить birth/parent facts максимум64 уже captured TEST group entries из исходного ps read.
   Linux `/proc/<pid>/stat` читается до4KiB; vanished/ambiguous/oversize/непокрытый лимитом PID → диагностическое unknown.
2. Только после прежнего отказа и только для его retained PID/FD с отсутствующим inode прочитать
   `/proc/<pid>/fd/<fd>` как symlink; принимать лишь `socket:[decimal]`. Сверить process birth до/после
   этого read и с pre-lsof capture; изменение/исчезновение даёт unknown, не fallback или adoption.
3. В той же ограниченной диагностике сохранить parent/PGID и finite role из оригинального процесса;
   `/proc/<pid>/cmdline` читается до4KiB только для retained holders и проецируется в фиксированный role enum.
   Никаких argv/env/payload/path dumps: разрешены только известные роли Electron/Node и `unknown`.
   Показать, что FD observation сделано **после** original census; оно не является атомарным lsof snapshot
   и не доказывает непрерывное владение FD между чтениями. Непрерывность нельзя вывести из одного PID.
4. Сохранить original AssertionError и прежний WeakMap receipt; supplemental failure не заменяет его
   и не влияет на cleanup. Верхние границы group/process/FD reads явные; max16 retained descriptors,
   никаких machine-wide searches, periodic polling или второго runner.
5. Дополнить один existing critical diagnostic case: reused/vanished birth не получает socket identity,
   two-holder refusal сохраняется даже при совпадающем socket inode; private markers не сериализуются.
   После root/peer source review и focused types этот TEST срез идёт в очередной необходимый native cut,
   без отмены/ручного повторения текущего штатного run для `dde51b477db6a41fc4d69ab6fbe1e10f6db3e5e2`.

Это discovery gate перед исправлением actual harness cause. Пока нет новых exact-source artifacts,
shared-socket inheritance, безопасный alternate admission и успешный Linux cold UI/packaged не заявляются.

## 36. Следующий review-driven cut: четыре ограниченных lifecycle/build исправления

Source baseline — `dde51b477db6a41fc4d69ab6fbe1e10f6db3e5e2`; перед изменениями root/peer review.
Никаких новых владельцев, журналов, native fallback, увеличения timeout или изменения product activation.

| Подтверждённый thread | Причина в текущем source | Минимальная правка и доказательство |
| --- | --- | --- |
| `PRRT_kwDORVTEtM622S05`, failed prepare cleanup | `WindowsCapability.prepare` после sealed race возвращает retained `cleanup`, но `WindowsCapturedProcess.stop` вызывает drain только при `allocation.prepared`; release затем отказывает из-за `drainSettled=false`. | Перенести уже существующий typed `drain(deadline)` в `PendingOwnedProcess`; wrapper дренирует ту же pending capability и лишь затем передаёт её genuine receipt в release. 3s drain и native Stop/release proof сохраняются; incomplete drain отдельно от tree absence. |
| `PRRT_kwDORVTEtM622S1t`, expired Stop cache | Таймер разрешает shared `stopOperation.promise` как unknown, но pointer остаётся до wire ACK/60s; новые explicit close attempts используют уже завершённый unknown и исчерпывают wrapper limit4. Немедленная повторная отправка тоже неверна: native `stopBusy.exchange(true)` при ещё активном Stop вызывает `abandon()`. | Удалять только истёкшую shared operation при её deadline, сохраняя original wire waiter/ID и immutable result прежнего attempt. Проверять expiry также при новом admission, если timer callback задержан. Новый explicit attempt ждёт settlement прежнего wire Stop в своём прежнем deadline; только после него допускается fresh wire dispatch/accounting того же original Job. Late old ACK может снять ожидание, но не завершает и не удаляет новый attempt. |
| `PRRT_kwDORVTEtM622VsE`, native failure artifacts | Node26/24/Electron qualifier выполняется до `cp`, поэтому при его failure исходная artifact/manifest directory не попадает в always-upload. | Existing always artifact step включает три exact `$RUNNER_TEMP/TEST-linux-{node26,node24,electron}-$GITHUB_RUN_ID` directories независимо от exit qualifier. Failure остаётся failure; нет broad filesystem glob/new job. |
| `PRRT_kwDORVTEtM622VsM`, private build directory | Recursive mkdir разрешает существующую empty directory, не обеспечивая заявленный контракт new/private. | Exclusive leaf mkdir, canonical parent и проверка созданной leaf identity/type/owner/private mode перед compiler. Existing directory/symlink отказывается; существующие permissions не исправляются chmod. Native/ABI callers уже создают private parent и передают несуществующую leaf `artifact`. |

Конкретные source paths: `packages/legacy-agent-host/src/owned-process/contract.ts`,
`src/adapters/providers/WindowsCapturedProcess.ts` относительно того же Host package,
`src/owned-process/windowsBroker.ts`, `packages/legacy-agent-host/scripts/buildLinuxProcessNativeArtifact.ts`
и `.github/workflows/sentry-owned-process-native.yml`. Main reexports используют canonical Host core автоматически.
`windowsBroker.ts` на этом baseline содержит786 строк. Чтобы не обходить800-line cap сжатием lifecycle-кода,
механически вынести существующие `boundedFile`/`verifyStagedBroker` в соседний `brokerArtifact.ts`;
исходный module импортирует и reexport-ит ту же функцию с прежней сигнатурой. Все PE/hash/manifest/input bounds
сохраняются; это перенос существующей проверки, не новый owner, protocol или admission policy.
Нативный broker/Job owner и прежние 4 wire waiters/64 attempt receipts остаются; native `stopBusy`/confirmed accounting
не заменяются предположением, что deadline означает неотправленный effect. Один старый attempt не replay-ится новым ID.
Если исходный wire не завершился до deadline следующего attempt, следующий тоже остаётся unknown без второго Stop frame;
завершение transport ожидания без ACK не доказывает, что native `stopBusy` освобождён: fresh dispatch допускается лишь
после actual original wire reply, либо original broker terminal state исключает любые новые отправки.

Расширить существующий `tools/owned-process-broker/protocol.test.ts` двумя critical cases:
Stop во время held prepare → failed preparation, original bounded drain, receipt/release; expired shared Stop →
immutable original unknown, отсутствие второго Stop frame до original ACK, затем fresh explicit attempt/ACK и
невозможность завершить его старым ACK. Это synthetic wire policy, не native cleanup proof.
В `registered-process-build-selection.test.ts` добавить только refusal существующей непригодной directory без compiler call;
положительный build/load остаётся реальным existing Linux/ABI CI. Native Windows facade/prepare cancellation сценарий
проверяется existing harness при следующем штатном native cut; guard/timer не ослабляются ради теста.

Отдельно остаётся `PRRT_kwDORVTEtM623zRW`: root-oracle deadline привязан к регистрации, а поздняя cleanup фаза имеет
собственный допустимый бюджет. Перед его правкой нужен узкий phase-boundary вариант с тем же original capture,
одним initial read и bounded cleanup window, без увеличения времени/числа native queries. Этот finding не скрывается
ни source PASS transport §34, ни успешными SDK runs; он не расширяет текущий четырёхпунктный cut.

## 37. Original-root oracle: deadline именно выполняемой фазы

`PRRT_kwDORVTEtM623zRW` подтверждён текущим source, но не объявляется причиной любого CI failure:
`desktop-process-root-oracle.ts` создаёт `Date.now()+180000` при регистрации, а
`desktop-native-process-host.ts` сначала доказывает root live, затем выполняет реальные provider/RPC/service
фазы и обращается к тому же oracle только после owner Stop/close. Его cleanup loop уже имеет собственный
30s deadline и3s interval. Валидные предыдущие фазы могут израсходовать старые180s до первого cleanup read.

Минимальный срез — три existing helper/caller и один critical case в existing observations test:

1. `createDesktopProcessRootOracle` сохраняет тот же validated original capture, exact artifact selection и
   суммарный max12 запросов; ни новый oracle/capture, ни новый native owner между фазами не создаются.
   `observe(deadlineMs)` принимает absolute deadline исходного caller; перед каждым read требует остаток,
   ограничивает native actor timeout значением `min(5000, remaining)` и отвергает поздний ответ.
2. `desktop-native-process-host.ts`: initial `same-live` read получает прежний max5s; cleanup передаёт
   original deadline уже существующего30s `wait` в callback, а не создаёт новый срок при каждой итерации.
   Остальные callback этого helper сохраняют прежнее поведение; interval3s и total query cap не растут.
3. `desktop-controlled-process-fixture.ts`: единственный read после original EOF/child cleanup использует
   тот же max5s. Existing15s ожидание root exit и3s ожидание детей не меняются.
4. Один bounded test: время между initial и cleanup переводится за180s; original capture/selection/argv
   не меняются, cleanup использует свой исходный30s и обрезает каждое чтение до остатка. Просроченный caller,
   поздний ответ и13-й запрос отвергаются без signal/replay. Это проверка бюджета TEST actor, не native proof.

Общая длительность native/provider/UI сценария не увеличивается и внешний CI timeout остаётся прежним.
Меняется ошибочная привязка read deadline к неактивной прошлой фазе; Windows/Linux product custody,
opaque captures, decoder и root-only запрет production signal не затрагиваются. До source нужен root review.

## 38. Main-retained Windows owner: следующие product cuts после actual vendor PASS

**План до source, база документа `f85fafb10a232a5e850ecd5b86cdf851a4803fbf`.**
На exact `dde51b477db6a41fc4d69ab6fbe1e10f6db3e5e2`, run `43372037195`, Windows x64
job `131709784668` и ARM64 job `131709784742` завершены SUCCESS, включая actual Claude SDK subtree Stop.
Оба оригинальных vendor receipt подтверждают один Session, один разрешённый Bash interaction,
service subtree absent, живой provider после scoped Stop и продолжение того же Session; final whole-Job cleanup PASS.
Они явно сохраняют `registryQualified/coldOwnerQualified/desktopQualified/releaseQualified=false`.
Это разрешает перейти от feasibility к продуктовой интеграции Claude на этих двух tuples;
Codex, OpenCode V1 и Bun/V2 не получают qualification по этому результату.
Следующий обычный native head `fe6eece10344cf1cd6f7dbc216c7eb19070c7c9e` содержит reviewed §34–37;
его новый run `43377890875` ещё не даёт runtime evidence для описанной ниже реализации.

### Конкретный source gap и порядок

| Срез | Текущее ограничение | Конечный результат этого среза |
| --- | --- | --- |
| A. Настоящий Main owner + ordinary launch | `HostCustodyOwner` уже injected, но product `DesktopBackendFeature` его не создаёт; `TeamHost` не включает native transport, `WindowsCapturedProcess` запускает broker внутри Host. | Та же обычная Claude factory/SDK получает facade, физический pending/broker с момента allocation принадлежит существующему Main owner. Host loss сохраняет его handles и sealed input epoch. |
| B. Scoped service adapter | `serviceScopes.h`/wire проверены, но debug loop и service operations всё ещё `OWNED_PROCESS_TEST_DEBUG_SERVICE`; Main/Host capture union Windows не содержит. | Явно поставляемый scoped-capable product artifact, original-current-child selector и typed capture/query/Stop/settle на той же capability. |
| C. Journal/fence + Processes | `TeamProcessCommands` и MCP wrappers рассчитывают на synchronous native calls; UI уже использует processRef и original command lookup. | Async native work вне Team fence, обязательная повторная проверка исходной authority, прежние rows/history/Stop без PID fallback. |
| D. Same-Main Host recovery | Router навсегда seals исходный client и пока не умеет заменить его после настоящего exit. | Один явный original-owner rebind, прежний processRef/receipt доступен новому Host, scoped Stop и Quit проходят реальный UI/packaged путь. |

Срезы публикуются и проверяются отдельно; A не объявляется завершённой registration/cold фичей.
Сначала A с настоящим consumer, затем B/C, затем D. Доставка Main/Host/OS capability выбирается только доверенной
composition; новые пользовательские настройки, alternate Processes panel и Stage2 не добавляются.

### A. Физический owner, prepare/resume и полный stdio contract

1. В canonical `packages/legacy-agent-host/src/owned-process/` добавить один `RetainedWindowsCustody` adapter
   поверх существующего `createWindowsOwnedLaunchPort`, без второго broker/helper process. Main composition
   удерживает его в прежнем `CapturedBackendOwner` рядом с текущим client, а не в новом registry авторизации.
   Adapter хранит реальные pending/prepared objects и только bounded physical receipts; Team commands он не пишет.
   `allocate` регистрирует pending до любого await/prepare. Host transport abort закрывает только binding/input admission,
   не вызывает `abandonControl`, `release` или implicit whole-Job Stop; Main Quit остаётся physical cleanup owner.
2. Закрытый `hostCustody.ts` расширяется ровно operations подготовки/resume и lifecycle observation.
   Размер native launch сейчас до1MiB (`codec.ts::MAX_LAUNCH_BYTES`), а reverse frame32KiB/chunk16KiB;
   нельзя незаметно урезать валидные environment/args или увеличить frame budget.
   Использовать bounded begin/chunk/commit подготовки **в том же pending object**: точные length/digest/offset,
   один текущий staging buffer на attached owner и последовательную bounded очередь original prepares.
   Chunk остаётся work lane; commit/resume проверяет complete captured spec; Stop/control reserve8 не ждёт загрузки.
   Это временные private bytes, не файл/журнал/новый generic blob protocol; EOF/expiry не даёт права повторить effect.
   Begin/chunk/commit/resume разделяют один original absolute launch deadline из существующего captured budget,
   включая очередь: per-frame timeout ограничен его остатком, а не начинается заново на каждом chunk.
   Main фиксирует собственный monotonic deadline при первом admission из переданного остатка; timestamp другого
   процесса не сравнивается с его performance.now. Expiry закрывает staging/input admission, сохраняет original
   pending/physical cleanup и никогда не разрешает поздний commit/resume под новой Host epoch.
3. Main получает broker selection из того же hash-bound private Host profile, выбранного `SelectedHostProfile.env`
   (`LEGACY_AGENT_HOST_PROFILE_PATH/SHA256`), а не из renderer или отдельного независимого broker preference.
   Малый composition helper переиспользует bounded canonical file read; при необходимости вынести только этот
   существующий reader из `readProfile.ts`, чтобы Main не импортировал Team/SDK composition ради чтения файла.
   Closed request связан с original binding/profile/source/launch snapshot; Host повторяет текущий Runtime/source guard
   до prepare и resume, Main заново проверяет selected broker/target и неизменность captured selection.
   Изменившийся source запрещает новую allocation/resume, но никогда не отбрасывает original cleanup capability.
4. Host remote launch adapter реализует существующий малый `OwnedLaunchPort`/prepared contract, без cast в ChildProcess.
   `OwnedProcessFacade` остаётся синхронным SDK return value; pending request уже удержан, prepared root/observers
   установлены внутри `resume(installOwner)` до native resume и первого stdin. ACK write означает actual native callback.
   Main читает paused original stdout/stderr bounded chunks без потерь для исходного живого Host epoch.
   После Host loss сохраняются ещё не доставленные bounded buffers; доставка in-flight в погибший Host остаётся
   unknown. Старые bytes/SDK iterator не replay-ятся преемнику; нового read journal этот cut не вводит.
   Root exit с exact birth/code передаётся отдельным reliable lifecycle readiness внутри той же закрытой family:
   его нельзя ждать до stdout EOF, который может удерживать ещё живой descendant. Используется тот же marker/rearm
   принцип §34, без polling или lossy data notifications; EOF, root exit, transport failure и tree proof различаются.
   Ready markers/partial spec/queued writes имеют общие конечные бюджеты; data pressure не съедает Stop reserve.
5. Подключить один общий captured bridge через `TeamHost` → `RuntimeTeamCoordinator` →
   `createRuntimeMemberProviderFactory` → `MemberProviderContext` → ordinary `CapturedProcess/WindowsCapturedProcess`.
   Не делать фиктивный `captureRoot(ChildProcess)` для remote facade: Windows launch capability отдельная typed ветка
   существующей custody composition, POSIX root source сохраняет прежний контракт. Management/scheduled/V2 consumers
   переносятся через тот же seam только со своими existing source guards и реальной tuple qualification.
   Файлы A: `owned-process/{hostCustody,index,RetainedWindowsCustody,HostWindowsLaunch}.ts`,
   `adapters/providers/{CapturedProcess,WindowsCapturedProcess,MemberProvider}.ts`, перечисленные composition callers,
   Main `composition/{DesktopBackendFeature,createCapturedHostClient}.ts`, `CapturedHostClient.ts` и один narrow
   Main selection helper. Существующие близкие к800-line composition files получают только wiring; extraction допустим
   для связанного уже существующего кода, без обхода cap и второго orchestration framework.

Первый acceptance A — actual captured Main client → ordinary Host CLI/Team factory → pinned Claude → existing broker
на Windows x64/ARM64, с тем же captured source и исходной Main cleanup authority. Existing transport subprocess test
добавляет physical-owner consumer и проверяет prepare→install→resume, write/EOF/root ordering и original Host loss;
он не заменяет actual native run и не объявляет conversation restore. Нет отдельной новой test suite.

### B/C. Original service scope и асинхронный прежний command owner

1. `debugServiceTest.h` выделяет уже проверенный debug loop в общий небольшой helper; TEST modes2/3 и diagnostic-file
   writer остаются TEST-only. `broker.cpp`, CMake/build/manifest и `brokerArtifact.ts` получают явную scoped capability;
   старый whole-Job manifest не становится service-capable по наличию opcode. Native fixture отдельно проверяет
   staged product binary, а не выдаёт unstaged TEST binary за product. No-debug fallback при failed admission запрещён.
2. `Scopes.registerCurrent(pid)` выбирает только живой original child этого provider под прежним mutex
   (`currentPids` → retained record → original HANDLE live); capture effect входит в existing replay cache до lookup.
   Это current-child admission, не доказательство исторического PID. Missing/retired/unknown отказывает;
   никакого OpenProcess/ancestry scan/PID+FILETIME adoption. Existing `registerExact` остаётся для exact TEST witness.
   После capture все query/Stop/settle используют original key/birth и provider capability, никогда повторный PID selector.
3. Private Windows capture добавляется как новая version в `registeredProcessContracts.ts` и existing strict validators:
   same Main epoch, physical provider capability/generation, original root identity, scope key/birth, registrar.
   Это metadata lookup живой Main authority, не transferable HANDLE и не permission создать новый native target.
   Capture канонический: requestId/time/new Host incarnation в его digest не входят; repeated register того же active PID
   обязан получить прежний scope/registrar, иначе current registry правильно возвращает conflict.
4. Async ветка остаётся в `TeamProcessCommands` и прежнем `commands/` journal. Register сначала проверяет admit/replay,
   фиксирует original intent **до нового await**, затем capture outside fence; после ответа вновь проверяет original
   grant/revision/registrar/input/source и актуальные rows. Capture receipt сохраняется до register/attachOriginal.
   Stop сохраняет requested-unknown и exact full capture, rechecks authority непосредственно перед synchronous enqueue;
   await reply вне fence, settlement только после повторной проверки исходного receipt/fingerprint.
   Lookup reconciles исходный request, не пересылает Stop и не делает новый capture при потерянном ACK.
5. Не превращать всю Team snapshot policy в async. `TeamOwner.collectProductState` получает metadata projection;
   существующие explicit `team.process.list/lookup/terminate` и MCP methods ждут свежую native observation отдельно.
   Внутренние prepare/read/settle helpers одни; POSIX sync adapter и Windows awaitable adapter используют тот же
   journal/validator/row policy. Обязательные callers: `createTeamProcessMethods`, `createTeamProcessComposition`,
   `createMemberProcessMcpPort`, `mcp/{contracts,processTools}` и lifecycle `assertReleased` — promise нельзя забыть
   ни в projection, ни в cleanup admission. Старый synchronous fence никогда не удерживается через await.
6. Current `registered:boolean` относится к physical scope, не к каждому register command: существующий active PID
   имеет максимум одну row, но разные completed receipts сохраняют тот же original capture. Metadata stop/unregister
   и replacement registration не являются release authority. Settle допускается лишь после genuine scope absence
   и durable reconciliation исходных pending terminate receipts. Old rows/receipts продолжают читать absence:
   completed observed-absent из прежнего journal переносим; natural-exit tombstone остаётся owner-local §24.3–4.
   Missing native key после release никогда не означает live/absent и не разрешает recapture.

Приёмка B/C расширяет существующий Windows native vendor gate: обычный `process_register` через реальный Team MCP,
Main-held scope → current list → operator Stop → same provider continuation + neighbor/foreign survivor.
Добавить в existing process-command tests только critical async cases: revoke/source change между admission и reply,
lost capture/Stop ACK без replay, repeated same PID registration с canonical capture, metadata removal при pending Stop.
UI по-прежнему получает лишь processRef/rows, а не capability/env/birth selector. Не добавлять новый journal или leases.

### D. Rebind, Quit и границы полного результата

`BackendOwnerRouter` заменяет client внутри уже зарегистрированного exact owner только после observed old child exit,
при живом исходном Main custody epoch, неизменных profile/build/storage/source и новом successful `ProfileWriterLease`.
Старый client остаётся sealed; никаких автоматических mutation retries/restart loop. Public recovery entry связывается
с существующим error/retry/Stop control и opaque handle, не принимает путь/PID/owner и выполняет сначала read/reconcile.
Обычный `host.shutdown`/Quit по-прежнему stop→drain→release. Explicit recovery после Host crash/detach отдельно;
непредоставленный old SDK iterator и неизвестный original Runtime input не превращаются в resumed conversation.
После rebind original registration/Stop/history имеют тот же processRef/full capture, а new Host incarnation используется
только в private transport admission. Changed-source refusal не мешает Main Quit освободить original handles.

Окончательная приёмка — existing real Windows Processes UI и packaged artifact: Host A register → same-Main Host loss →
Host B fresh writer → original row/history → scoped Stop → provider/neighbor alive → Main Quit original cleanup.
Отдельно Main death и cancelled/late old epoch проверяются independent captured witness; Main loss не даёт durable
absence без настоящего ранее сохранённого proof. Cold/Linux warm перенос и V2 sealed graph нельзя закрыть этим Claude
gate: V2 требует fresh complete graph/executable attestation через Main port и actual Bun tuple; Codex/V1 свои native gates.

**R1 self-review до source:** выявлены и включены launch1MiB↔frame32KiB mismatch, root exit до pipe EOF,
sync Team snapshot/MCP projection и canonical capture при repeated register. **R2 Account:** B/C/D design PASS,
register replay/attachOriginal/metadata-unregister constraints проверены по source. **R2 Profiles:** A/attestation
согласованы с двумя точными исправлениями — unknown delivery в погибший Host и один deadline всей подготовки;
они включены выше. Root подтвердил выбранные owner/stdio boundaries; final text передаётся на readback до source.
Никакой product source из этого раздела пока не изменён и feature parity завершённой не объявляется.

**A lifecycle amendment после чтения actual shutdown source.** `CapturedHostClient.shutdown` сейчас делает
sealNative/stdin.end, а `HostServer.dispose` закрывает обе pipe/native client до `onDispose`; remote cleanup в Main
через уже закрытый канал невозможен. Добавить ровно один private prepare-shutdown в прежнюю custody family:
сначала exactly-once `onSeal` и запрет public/allocate/prepare/resume/write, затем exactly-once исходный `onDispose`,
сохраняя private read/observe/Stop/drain/release по уже удержанным capabilities до original disposal ACK/EOF.
Это не повторное admission по PID/current grant/profile. Один existing absolute shutdown deadline включает prepare,
cleanup/ACK и последующее ожидание exit; per-phase/per-reply timeout его не продлевает. ACK и late replies остаются
привязаны к исходному Host binding; старый A не закрывает epoch B. Failure path сразу seals transport и сохраняет
Main physical owner; timeout/EOF не создаёт release/absence proof. Main Quit имеет независимый final cleanup исходных
capabilities даже при недоступном Host. Точки source: существующие `index.ts`, `HostCustodyClient`,
`CapturedHostClient.shutdown` и Main composition; generic lifecycle framework, второй journal и новый budget не нужны.
Root подтвердил необходимость этой границы, Account подтвердил retained-owner/late-epoch ограничения до source.

## 39. Claude checkpoints до explicit executablePath — genuine producer перед compatibility change

План до source. Review #1188 `PRRT_kwDORVTEtM623zRO` проверен по actual
Stage1 `1d0f97f55de566036c970eab4f36b84620afdb3f`, native head
`fe6eece10344cf1cd6f7dbc216c7eb19070c7c9e` и pinned D `f4b4ac3f`.
Это отдельная compatibility граница; source §38 и его Main-held custody не меняются.

### Круг 1 — установленная причина и границы доказательства

- В [old ClaudeMemberProvider](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/adapters/providers/ClaudeMemberProvider.ts)
  `ClaudeConfig` не получает executablePath. Current Host передаёт exact
  `profile.executable.path`. У current D `claude-sdk/config:compatibility` этот
  optional field входит в hash; `open-session` отказывает несовпадающему checkpoint
  до sessionExists/query. Это не просто замечание к тесту.
- Exact1d0 использует `opencode-v2-host-9ede557c` provider archive SHA256
  `fc8a821aff5b96b649647dac3853c831acf83d1555a480dc1f9645006600cb89`, contracts
  `aaf9506473f6a2868a375a6087e1b4edc561b38f34101ef7a8703a73bb2674db`.
  Локальные bytes сверены с git1d0. Его dependency pins: Claude SDK `0.3.305`,
  Anthropic SDK `0.122.0`, MCP SDK `1.32.0`, Zod `4.6.7`. Old D не имел
  executablePath; current hash дополнительно поддерживает disallowedTools и
  sessionPersistence. Нельзя считать любые различия между версиями только path.
- Старые `p4-mixed-native-restore-handoff.json`, `p5-existing-resume-ui-v1/manifest.json`
  и `m16-existing-cold-resume-ui-handoff.json` сохраняют genuine native Resume
  receipts. P5 фиксирует immutable source/resumed checkpoint SHA256
  `2111e6b38d08cf23fded72fbf456998f0505a35cfd0bf87f258798e703de4d3a` /
  `d5f257b0e25afed1edfac0c5a28d599ae2d24e0bc87b5931dcbdc382f353cb18`.
  Их исходные payload bytes/executed corpus не найдены в текущем checkout;
  manifests сами по себе не являются новым old→current compatibility PASS.
  Local1628/f418 checkpoints уже получены после executablePath change.
- Donor4a `TeamProvisioningLeadRuntimeRestart:buildLeadRuntimeResumeArgs` использует
  original native `--resume` под legacy owner. `stopped-team-import/snapshot:disposition`
  исключает checkpoint/runtime-checkpoints; import создаёт новый Host run.
  Эти пути не превращают legacy session ID в Host checkpoint и не заменяют
  сохранение ранее поддержанного Host Resume.
- Host `CheckpointCoordinator.compatible` проверяет original profile/config/member,
  history/custody/generation. Его read projection намеренно лишь
  owner-eligible/native-backing-unverified; полную native совместимость проверяет D.
  `createMemberEntry` проверяет original base/config digest, а CapturedProcess
  по-прежнему требует exact path, SHA256 и unchanged file identity перед spawn.

### Круг 2 — сначала неизменяемый old corpus и настоящий переход владельца

1. Подготовить isolated checkout exact1d0 и собрать его original Host с original
   lockfile/archive, Node24.21.0 и тем же pinned SDK. Записать commit, полный source/
   dist digest, installed archive equality, SDK/native digest и canonical executable
   path. Никаких изменений old production source, изменения checkpoint hash или
   добавления/удаления executablePath в его config.
2. Переиспользовать parameterized `fixtures/native-host.ts:startHost` и bounded
   `native-claude-team/model.ts` из existing single-provider journey. Только новый
   private TEST HOME/config/workspace/store и localhost model; original application
   records создают Host/Team/Runtime RPC. Existing Darwin-only suite не объявлять
   Linux suite и не снимать её guard: локальная POSIX inspection с этими helper
   ports имеет отдельную явно записанную platform boundary. Если dependency/runtime
   недоступны, сначала проверить обычный pinned install/имеющиеся artifacts.
3. Original1d0 Host получает один existing ONE input, terminal history, обычный
   checkpoint/Stop и confirmed original cleanup. До consumer сохранить неизменённые
   checkpoint bytes+SHA, native transcript prefix/hash, original member/base/config
   digests, native path/SHA и полный source owner/profile reference. Файлы читаются
   только из этого TEST scope; fixture не создаёт opaque payload, native session ID,
   runtime record или release receipt. При baseline Resume использовать original
   old owner и exact native identity, без повторной отправки ONE.
4. Отдельно проследить штатный cold-upgrade путь. `BackendOwnerRouter` связывает
   owner revision с profile/build/Node/Host entry digest; `FileHandleBindingStore`
   не перезаписывает старые handles. Нельзя заменить Host entry, owner/profile hash
   или bootstrap прежними значениями ради достижения D. Зафиксировать, выбирает ли
   current Main retained original owner или имеется явный существующий переход на
   новый owner. Неизвестный/отсутствующий переход остаётся отдельным migration gap,
   а не разрешением обойти binding и не объявлением старых checkpoints unsupported.
5. С actual old payload воспроизвести current refusal на неизменной captured member
   configuration. При inspection через public D использовать exact original bytes
   и подтверждённую config projection; отсутствие allocation/model request должно
   следовать из original boundary. Такой driver-level результат отдельно пометить:
   он не доказывает Desktop owner migration. Сопоставить все effective compatibility
   fields, не убирать дополнительные различия до совпадения.

### Круг 3 — узкая correction только после producer и authority proof

6. По сохранённому corpus выбрать минимальное D-owned правило совместимости только
   для доказанно того же original captured executable/config/account/workspace.
   До code описать exact proof/eligibility в amendment этого плана и независимо
   проверить его. Нельзя принимать любой prior hash, удалять executablePath из
   current config, переписывать opaque payload, обходить sessionExists или переносить
   чужой executable/model/namespace. Default standalone D остаётся strict;
   Host не получает native checkpoint parser. Если нужен product source-owner
   transition, его authority должна быть доказана прежде positive migration claim.
7. Менять D только в source repository и доставить обычный immutable package/pin;
   vendored dist/tgz вручную не редактировать. Переиспользовать existing driver
   checkpoint case для critical same-original acceptance / changed executable,
   config или missing history refusal. Не создавать новый compatibility registry,
   journal, generic migration framework или отдельную unit suite.
8. Existing native single-provider Resume journey завершает old producer→current
   authorized consumer: Resume не повторяет ONE, ordinary TWO содержит прежнюю
   native history и выполняется один раз; сохраняются product launch/member,
   selected model/effort, checkpoint immutability, original cleanup и прежние
   finite budgets. Actual Desktop cold Resume и required exact-head checks остаются
   отдельной приёмкой. Current→current PASS либо pure hash comparison не закрывают
   old→current путь. До подтверждения этого результата review thread остаётся open.

Source closure сначала TEST evidence/inspection с existing ports; production/API
cut определяется только подтверждённым original corpus и существующей authority.
Root публикует этот план до source; результаты каждого круга дописываются отдельно.

Independent plan reviews (Profiles и root) — PASS. Reused TEST helpers должны
соответствовать exact old RPC contract; source/dist identity old producer фиксируется
до выполнения. Current before/after file checks не закрывают отдельный review24
о промежутке verify→exec: здесь они сохраняются, но pinned execution этим не
объявляется доказанным. D-only evidence не подменяет Main owner transition.


## 40. Уточнение приёмки §38 A: свежий факт по исходному Windows HANDLE

- В первом кандидате `nativeRetainedHostGate.ts` проверка `witness.process.exitCode === null` после выхода Host доказывает лишь отсутствие полученного Node события. Она недостаточна для положительного утверждения, что исходный native process ещё жив. Такой кандидат не считается native PASS.
- В existing TEST witness добавляется отдельный opt-in `vendor-query-wait-gated`: прежний `OpenProcess` + exact birth выполняется один раз, **до первого resume исходного provider**. Дальнейшие максимум четыре запросa `Q` используют только уже удержанный HANDLE и `WaitForSingleObject(handle, 0)`: `WAIT_TIMEOUT → alive`, `WAIT_OBJECT_0 → absent`, прочее → отказ. PID повторно не открывается, process table не используется. Это одномоментное наблюдение HANDLE, без обещания будущей живости.
- После одного фиксированного `W` тот же witness переходит в прежнее ожидание исходного exit и завершается с тем же проверяемым кодом. Ошибочный/лишний запрос закрывает TEST протокол с ошибкой. Никаких новых сигналов или управления provider у свидетеля нет; его время жизни по-прежнему ограничивает исходный independent controller Job и общий deadline 120 s.
- Узкие файлы: `tools/owned-process-broker/nativeFixture.cpp`, existing `nativeGateContext.ts` (типизированный TEST helper для двух закрытых ответов), новый `nativeRetainedHostGate.ts`. Остальные fixture modes и production broker неизменны. Native gate требует `alive` после обычного SDK input, `alive` после доказанного exit Host в crash-case и `absent` после Main cleanup через тот же исходный HANDLE; затем original witness exit0 и controller Job0. Соседний sentinel остаётся жив до собственного cleanup.
- Это исправление TEST oracle. Оно не активирует private product mode, не подтверждает rebind/Registry/SDK cold conversation и не заменяет реальное исполнение на Windows x64/ARM. Пока новый сценарий не прошёл, §38 A остаётся source candidate.
- Основание: [Microsoft WaitForSingleObject](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject); исходный HANDLE, а не Node event delivery, задаёт объект наблюдения.


## 41. §39: genuine old checkpoint в существующем native Resume CI

План до TEST source. Локальный isolated exact1d0 checkout, frozen install и build
были выполнены; producer был запущен, но его результат не был прочитан до потери
исполняемой среды. Этот запуск остаётся **INCOMPLETE / outcome unknown**: checkpoint,
успех или ошибка native не заявляются. CI использует новый private TEST root и
новые original operation IDs; прежний root не подхватывается и ONE в нём не
повторяется. Это новый независимый corpus, не replay незавершённого опыта.

### Круг 1 — штатный CI seam и минимальные файлы

- Использовать существующую строку `stage1-desktop` с
  `matrix.mode == 'native-resume-ui' && !matrix.variant` в
  [ci.yml](https://github.com/777genius/agent-teams-ai/blob/cd2406a1cd040cf451a504857ebd5c985579c3da/.github/workflows/ci.yml).
  Runner, Node24.21.0 darwin-arm64, root GO, current source/native freeze,
  45-minute job budget и обычный current Desktop cold Resume сохраняются.
  Новый runner, matrix row, scheduled job или увеличение native timeout не нужны.
- Перед обычным UI journey добавить `actions/checkout@v6` exact
  `1d0f97f55de566036c970eab4f36b84620afdb3f` в отдельный
  `.stage1-checkpoint-donor`, `persist-credentials: false`. Это тот же штатный
  checkout seam, который уже применён к P10 donor4a; оба checkout независимы.
  Проверить HEAD и чистоту tracked source до/после frozen install/build.
- Donor собирается original `pnpm-lock.yaml` и packageManager
  `pnpm@11.22.0`, без подмены provider archive, SDK или старых source files.
  Использовать существующий pinned Node/pnpm и обычный Host build с его
  task-change-ledger prebuild. Before execution сохранить original source/dist,
  original provider/contracts archive и installed D bytes, SDK/native path+SHA.
  Для producer действуют original9ede pins §39; current D f4 archive проверяется
  отдельно: SHA256 `73c7034aef1283ee694114d2a31d12383370286b45c18120958ca0edef789957`.
  Actual compiled `dist/cli.js` old/current SHA, Node SHA и original persisted
  owner/build/profile fields сравниваются отдельно, без изменения ожидаемых
  значений. Source `cli.ts` у old1d/current cd2406 имеет один blob
  `255c0952a3a58e511c7bd790b1b34dd0d1330393`, но это ещё не compiled equality.
  Полный source/dist/D provenance обоих исполнителей сохраняется даже при
  равенстве entry SHA; одинаковая entry не означает одинаковый implementation.
- Единственный native TEST entry — существующий
  [native-claude-host.native.ts](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/tests/native-claude-host.native.ts).
  Добавить explicit opt-in donor mode, сохранив default path. Reuse original
  `native-host.ts:startHost` и finite `native-claude-team/model.ts` из frozen
  donor, с записанными source hashes; current orchestration hash хранить отдельно.
  Не запускать старую Darwin suite на другой OS и не ослаблять её guard.
  Existing 180-second test deadline, readiness/input/cleanup budgets сохраняются.
  Если небольшой TEST projection нужен для читаемости, поместить его в существующий
  fixture module; отдельный harness, suite или compatibility framework не создавать.

### Круг 2 — producer, неизменённые bytes и отрицательный current consumer

1. Original donor Host и его original D создают application records обычными
   Team/Runtime RPC в новом TEST HOME/config/workspace/store. Существующий selected
   model `claude-opus-4-6`, effort `medium`, MCP/tool effects и ONE/TWO scenario
   сохраняются. Native executable определяется именно original SDK resolver,
   проверяется по selected Darwin pin; PATH fallback и другой установленный CLI
   не допускаются.
2. После одного terminal ONE и settled original notifications вызвать обычный
   `runtime.checkpoint` с source generation, затем original `runtime.stop`.
   Использовать exact RPC contract из
   [old native-mixed-host.native.ts](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/tests/native-mixed-host.native.ts):
   `memberId, checkpointId, expectedGeneration`, а Restore —
   `memberId, reference, expectedGeneration`. Не создавать checkpoint/restore
   records напрямую и не синтезировать release.
3. До любого consumer заморозить исходные checkpoint bytes и SHA, original
   sourceBinding/profileId/sourceConfig, selected member/base/config digests,
   source owner/build/Node/entry identities и native transcript prefix+SHA.
   Проверять bytes вновь после каждого этапа. Native backing остаётся в том же
   private namespace; его session ID, cwd, profile, model endpoint и config
   не переписываются.
4. Выполнить только driver-level negative inspection через **current public D**
   `openClaudeSession` из checked f4 archive на actual original opaque payload.
   Все compatibility fields выводятся из original saved selection и exact old
   adapter/D projection, включая required-tool order, generated instructions,
   attachment metadata и optional fields. Before invocation original D's pure
   compatibility computation обязана совпасть с genuine checkpoint hash.
   При несоответствии projection test отказывает: запрещены подбор hash, удаление
   полей, подмена opaque bytes или ослабление equality.
5. Current projection отличается только explicit canonical original executablePath;
   его selected bytes и namespace остаются теми же. Non-hash callback ports в
   этой отрицательной inspection — TEST tripwires: sessionExists, probe, native
   launch и attachment resolution не должны вызываться. Требовать exact
   `checkpoint-incompatible`, ноль native allocations/model requests и полную
   неизменность corpus. Не использовать test SDK query, чтобы выдавать fake native
   успех. Это доказательство actual old payload + current public-D refusal,
   не Main migration и не положительный Resume.
6. После negative inspection original **old owner** штатно cold-starts со своим
   прежним profile/build/entry, выполняет original selected Restore и один TWO.
   Resume не отправляет ONE повторно; его own new generation обязательна.
   Existing native history/tool marker, один эффект ONE и один TWO, canonical
   replies, model/effort и terminal cleanup доказывают пригодность самого corpus.
   Этот old→old baseline не переименовывается в old→current. Общий native input
   count — прежние два; current-D negative check не добавляет input.

### Круг 3 — reviewable receipts и граница следующего исправления

- Existing CI step обязан прочитать единственный receipt данного нового запуска,
  проверить donor commit/archive/source/dist/native hashes, immutable original
  checkpoint, old baseline restored history, no-allocation current refusal и
  confirmed original cleanup. Closed status явно называется
  `CORPUS_QUALIFIED_CURRENT_D_REFUSED`; его нельзя считать provider parity PASS.
  Любая непроверенная projection, missing history, cleanup unknown или лишний
  model request оставляют этап неуспешным и original diagnostic evidence доступным.
- Расширить existing `always()` artifact whitelist только этим TEST receipt,
  bounded original Host diagnostics, frozen checkpoint/native TEST transcript
  prefix и source identity manifest. Не загружать личный HOME, общий cache,
  неотфильтрованные environment dumps или файлы соседних TEST roots.
- Прежний current Desktop cold selected Resume выполняется как раньше и имеет
  свой receipt. Для ordinary current Main route сначала сравнить actual old
  persisted owner/handle с independently captured current client identity:
  ownerId/revision/storageRoot/profileId/protocolVersion/buildId/Node SHA/entry SHA
  должны действительно совпасть; original private profile bytes и executable
  остаются неизменными. При genuine compiled equality существующий router может
  законно выбрать current entry под той же retained identity — отдельный migration
  API заранее не требуется и его отсутствие само по себе не объявляется gap.
  Нужна actual ordinary route через existing Main, а не вывод из одинакового
  source blob. Standalone producer сам по себе не создаёт Main handle: его
  отсутствие нельзя восполнить ручной записью; такой route остаётся отдельной
  проверкой existing Desktop journey с genuine initial persisted handle.
  Если actual entry/Node/build/profile/owner расходятся, current route обязан
  отказать; нельзя подставлять old hash, менять binding или bootstrap. Только
  такое подтверждённое расхождение требует отдельного reviewed transition.
- Только после genuine corpus/strict refusal и authority audit выбрать D-owned
  compatibility correction по §39, отдельно опубликовать exact eligibility plan
  и доставить через owning source repo/immutable package. Затем тот же native
  journey должен действительно выполнить TWO через authorized current consumer
  с original history, без дополнительных prompt retries. Current→current UI
  PASS, pure hash equality и old→old baseline не закрывают thread
  `PRRT_kwDORVTEtM623zRO`.

Самопроверка: defaults и existing UI не заменены; donor source не модифицируется;
новой production API/registry нет; чужая executable identity не ослабляется;
неизвестный первый local outcome сохранён отдельно. Source ещё не изменён.

Независимый cold-owner source audit (Profiles, exact cd2406): BackendOwnerRouter
`registerOwner` фиксирует profile/build/Node/entry identity и не принимает повторный
ownerKey/storageRoot; `resolveOwner` требует whole original owner equality;
`createHandle/retain` сохраняют original owner и scope, default change не переносит
handle. FileHandleBindingStore использует immutable `atomicCreateAsync`, метода
update/rebind нет. Эти seams подтверждают retained-original-owner routing и запрещают подмену
identity. Они не запрещают current implementation, если actual compiled entry,
Node, build/profile и все persisted owner fields действительно остаются прежними.
Равенство и ordinary current Main route ещё не исполнены; source audit не
зачитывается вместо них.

## 42. §38 A: admission при одновременных Launch и Close

**Доказанный source gap A30.** `HostedTeamDefinition.members.max(256)` допускает более 32 участников; `TeamLaunchOwner.start` вызывает `startMember` для каждого без общего serial wait. `RuntimeTeamCoordinator.close` также начинает закрытие всех entry и pending opens параллельно. Текущий `HostCustodyClient.request` немедленно возвращает refusal при 24 work / 32 total pending. Поэтому медленные prepare могут сорвать следующий allocate/stdio, а одновременные Stop — закрепить unknown в original attempt cache до освобождения capacity. Это не native failure из CI; это достижимая ошибка admission в новом source candidate. A30 не активировать и не публиковать как готовый bridge.

### Узкая коррекция в существующем transport

1. Единственная bounded admission queue остаётся внутри existing `HostCustodyClient`, только для закрытого native family. `HostWindowsLaunch` вызывает её с operation discriminator и отложенным builder исходного call. Work и control сохраняют FIFO внутри каждой lane; control выбирается раньше work. Идентификатор wire request присваивается **один раз, только при первом dispatch**. Из очереди не делается повторный dispatch или automatic retry.
2. У очереди ограничены continuation references (не более 1536, то есть 6 на уже ограниченные 256 allocations); один stream pull / serialized stdin write и coalesced original Stop сохраняют собственные bounds. Frame/base64 материализуется лишь при admission. Data остаётся в исходных bounded SDK/native streams и captured launch spec; отдельная копия queued wire payload не создаётся. Сам serialized launch buffer по-прежнему максимум 1 MiB и один во время staging.
3. Existing `HostOutput` предоставляет узкую проверку private capacity и callback после освобождения исходной write capacity. Это позволяет ждать одновременно request slots **и** общий priority byte budget; нет polling, таймерных retries, нового scheduler class или отдельного RPC. Existing 32/8 pending limits, 32 KiB frames, 16 KiB chunks, priority/data budgets и write timeout не увеличиваются. Work не забирает восемь control slots или reserved control bytes.
4. Original absolute deadline фиксируется до попадания в очередь. Allocate/chunks/commit/prepare/resume используют единый прежний launch deadline; Stop/drain — срок исходного caller. Queued request на deadline или seal завершается как **known-not-dispatched operation**, что не является process absence/cleanup proof. После dispatch timeout/EOF остаётся unknown; старый outcome, attemptRef и original Main custody не переписываются.
5. Кратковременная capacity pressure сама по себе не завершает original Stop неизвестным: та же original invocation ждёт slot и получает только свой ACK. Исчерпанный original deadline не продлевается; новый explicit close использует существующий bounded attempt contract, без автоматического нового ID и без повторения ранее dispatched effect.
6. Host loss запечатывает очередь исходной binding/epoch, не переводит её successor. Graceful input seal отклоняет queued allocate/resume/write/end, но оставляет original read/observe/Stop/drain/release до прежнего disposal deadline. Физический owner Main и original cleanup сохраняются независимо от queued replies.
7. Existing launch staging tail допускает ожидание одного исходного spec на retained allocation (до 256), вместо отказа на 33-м члене. Копируется/фиксируется исходный immutable spec до ожидания; бинарный buffer кодируется только при начале serial staging, после commit начинается следующая staging. **Длительный native prepare не сериализует остальные SDK.** FIFO внутри work/control и original hint marker правила §34 сохраняются.

### Файлы и приёмка

- Production: `owned-process/hostCustody.ts` (closed admission), `owned-process/HostWindowsLaunch.ts` (lazy builders / original bounds), existing Host `output.ts` + `index.ts` (capacity callback). Main physical owner, broker protocol и receipt semantics не меняются.
- Расширить existing `transport.test.ts` и/или actual subprocess case в `capturedHostClient.test.ts` с existing `retainedNativeCustody.ts`; не создавать mapper unit suite. Барьеры явные, без timer inflation.
- При удержанных work requests более 24 original launch/stdio calls ожидают admission; после освобождения slot исходные bytes проходят ровно один раз. Более 32 одновременных original cleanup calls также ждут свои слоты, не становятся cached unknown только из-за заполненности. Пока work и byte budget заняты, control сохраняет резерв.
- Проверить deadline-before-dispatch (zero native effect), EOF/seal queued (no successor delivery), original dispatched lost ACK (unknown без replay), сохранение lower-sequence work после control overtaking и нового readiness edge после старого read. Использовать существующие две regression boundaries §34 вместо дублирования suite.
- Полный A source снова проходит build/type/subprocess review после коррекции. Предыдущие 21 PASS относятся к A30 и не выдаются за тестирование новой очереди. Native §38/40 остаётся обязательным на Windows x64/ARM; никакой default activation до actual result.

Independent plan review: §41 Profiles + root — PASS; exact compiled identity
equality остаётся проверкой, source cli equality её не заменяет. §42 root —
PASS: queue pressure не является completed/absent proof, original deadline
действует до первого dispatch, dispatched unknown никогда не replays. Временный
refusal до dispatch и физический cleanup различаются; bounded explicit subsequent
close не должен переиспользовать навсегда ошибочно закешированный no-dispatch
unknown. Existing control reserve и wire byte limits не повышаются.


## 43. Linux CDP: exact fe6 результат и ограниченная корреляция original child

Run [43377890875](https://github.com/777genius/agent-teams-ai/actions/runs/43377890875)
на `fe6eece10344cf1cd6f7dbc216c7eb19070c7c9e` завершён: Windows x64/ARM64 actual
vendor gates и Linux ABI — PASS. Linux Node26/Host24/Electron primitives и
actual SDK прошли; cold UI job `131728577364` отказал, packed не запускался.
Original artifact `14017750996` содержит Electron Main PID4903/startTicks28365
и Node PID5003/PPID4903/startTicks28478: после исходного census у обоих FD60,
socket inode22546 и неизменный process birth до/после supplemental read.
Это совместимо с inherited socket, но не доказывает непрерывность FD между
чтениями. Старые app.log/census не связывают PID5003 с captured Host: он появился
после startup census; raw argv намеренно не сохранялся. Называть его Host рано.

### Круг1 — что подтвердили primary sources, и чего это не доказывает

- Exact [Electron44.10.1 DEPS](https://github.com/electron/electron/blob/v44.10.1/DEPS)
  фиксирует Chromium152.0.7977.169 и Node24.22.1.
  [TCPServerSocketFactory](https://github.com/electron/electron/blob/v44.10.1/shell/browser/ui/devtools_manager_delegate.cc)
  использует обычный Chromium TCP server. Exact
  [SocketPosix::Open](https://github.com/chromium/chromium/blob/152.0.7977.169/net/socket/socket_posix.cc)
  передаёт SOCK_STREAM в
  [CreatePlatformSocket](https://github.com/chromium/chromium/blob/152.0.7977.169/net/socket/socket_descriptor.cc):
  POSIX socket создаётся без SOCK_CLOEXEC, затем задаётся nonblocking.
- Exact [Node24.22.1 libuv child setup](https://github.com/nodejs/node/blob/v24.22.1/deps/uv/src/unix/process.c)
  на Linux не закрывает произвольные inherited descriptors. Три stdio pipes не
  означают close-all. Дополнительные stdio `ignore` при fd>=3 также пропускаются;
  это не корректное исправление. Darwin использует другой spawn путь с
  POSIX_SPAWN_CLOEXEC_DEFAULT; его PASS не переносится на Linux.
- [Electron main parts](https://github.com/electron/electron/blob/v44.10.1/shell/browser/electron_browser_main_parts.cc)
  действительно поддерживает remote-debugging-pipe. Но exact Chromium
  [pipe setup](https://github.com/chromium/chromium/blob/152.0.7977.169/content/browser/devtools/devtools_agent_host_impl.cc)
  и [handler](https://github.com/chromium/chromium/blob/152.0.7977.169/content/browser/devtools/devtools_pipe_handler.cc)
  сами по себе не доказывают закрытие fd3/4 при Node spawn. Менять TCP на pipe,
  не доказав endpoint isolation, недостаточно. UtilityProcess также не является
  drop-in: иной Node и отсутствие stdin в official API меняют qualified Host.
- Это source-level объяснение возможной inheritance, не actual reproduced fix
  и не доказательство того, какой именно Node child держит socket в CI.
  Не добавлять shell/native launcher, descriptor mutation либо alternate CDP
  admission на основании одной этой гипотезы.

### Круг2 — закрыть единственную оставшуюся неопределённость

В existing TEST failure projection `desktop-backend-observations.ts` добавить
опциональную **однократную** корреляцию с уже captured fixture Node/Host entry.
Её вызывает только existing `desktop-backend-smoke.ts` catch с исходным
AssertionError и своими неизменными fixture paths. Сохраняются original WeakMap
facts; никакого нового lsof/ps census, запуска команды, RPC, signal или recovery.

1. Только для max16 исходных retained PID/FD с проверенным original process
   birth прочитать bounded proc facts. Сопоставить startTicks/PGID/parent до и
   после с прежней supplemental observation. Socket symlink до/после должен
   совпасть с уже наблюдённым socket inode; иначе всё новое — unknown.
   Совпадение остаётся **неатомарной диагностикой**, а не полномочием.
2. Внутри этого же bounded read сравнить полный NUL argv с ровно двумя captured
   строками `fixture.node`, `fixture.hostEntry` и отдельно `/proc/pid/exe`
   с captured Node path. В receipt выводятся только boolean/null, никогда сами
   argv, executable path, env или raw ошибки. Это сопоставление объявленных
   путей, не криптографическая проверка actual executable bytes.
3. Прочитать до4KiB `/proc/pid/fdinfo/fd`; принимать единственную корректную
   octal flags строку и выдавать только `closeOnExec: boolean | null`.
   [Linux proc fdinfo](https://github.com/torvalds/linux/blob/v6.14/fs/proc/fd.c)
   включает O_CLOEXEC в flags из actual descriptor table. Missing/oversize/
   malformed/reused descriptor остаётся unknown. Номер FD никогда не используется
   для закрытия или изменения flags.
4. Original `holderCount=2` и AssertionError сохраняются. Не принимать второй
   PID даже при совпадении inode, Host argv или child lineage. Новая projection
   помечается `after-failed-census`, `atomic:false`; она не изменяет original
   census или уже сохранённые facts. Проекция не перечитывается в polling loop.
5. Расширить только existing critical observations case: exact fixture match,
   иной argv, missing flags и reused birth дают ожидаемые закрытые поля;
   private markers отсутствуют. Прежние no-signal, max16 и strict two-holder
   assertions остаются. Нового unit suite и новых TEST process launches нет.

### Круг3 — доставка и решение по факту

После независимого source review включить этот TEST срез в следующий уже нужный
native commit вместе с §38/40/42. Existing Linux job сам сохранит original failed
receipt; workflow, matrix, retries, runner и budgets не меняются. Локальный
executor сейчас недоступен: новые sources не объявляются typechecked/executed;
обязательны checks опубликованного exact head.

Если actual argv/executable comparison связывает inherited non-CLOEXEC socket
с original Host, следующий product план должен закрыть descriptor inheritance
на реальном original launch boundary без numeric-PID adoption и без нарушения
selected Node/entry/profile identity. Если это другой child, исправляется его
фактический launch path. До такого результата не выбирать глобальное закрытие
FD, hidden flag mutation или обход strict guard. Полное Linux cold UI/packed
подтверждается только последующим реальным successful journey с прежними
UI/input/Stop/cleanup assertions.

Self-review: §33/35 факты не переименованы в PASS; raw paths и proc данные
не становятся public authority; нет дополнительного runner/retry. Это
ограниченная diagnostic delta к уже необходимому запуску, не завершение Linux.

## 44. §42: исходный wire debt и shared reply capacity в Main

**Конкретная оставшаяся граница.** §42 исправляет Host slots/Host output, но Main `receiveNative` ещё отвечает refusal при занятом `canWrite(HOST_CUSTODY_FRAME_BYTES + 1)`, даже если Host не превысил24/32. Этот путь присутствует в existing actual subprocess case с ограниченным shared byte budget; новый §42 barrier case не проверял блокированный Main stdin. Кроме того, Host timeout сейчас удаляет pending, тогда как Main может продолжать исходный effect; поздний ACK игнорируется, освобождая Main hint, но оставляя Host marker. Одного Main hint cap32 недостаточно для такой разошедшейся истории. Публикация §38 A остаётся отложена до замыкания этой границы.

### Одна исходная операция, два состояния завершения

1. В existing `HostCustodyClient.pending` разделить однократное завершение caller и фактическое завершение wire request. После dispatch logical timeout возвращает caller **unknown один раз**, но original ID/call/admittedHint и занятый slot остаются до exact original ACK или terminal transport seal. Deadline не перезапускается, effect не отправляется повторно. Late ACK валидируется по прежним binding/ID/result, освобождает только этот wire debt и его exact marker; success не переписывает уже выданный unknown.
2. Queued до dispatch deadline/seal по-прежнему даёт known-not-dispatched operation, не process absence. При полном отсутствии wire admission новый explicit close может использовать следующий существующий bounded attempt после освобождения capacity; старый expired attempt/deadline не переименовывать и не продлевать. Добавить именно этот critical case рядом с48-member close, не ограничиваться happy path.
3. Host queue учитывает весь original wire debt, включая caller-expired entries. Это сохраняет общий предел32 и work≤24, не даёт повторным timeout скрыто увеличивать Main outstanding effects. Readiness bounds32 и existing state reserve не увеличивать: exact late ACK завершает original marker прежде следующих Main hints; changed-marker правило §34 сохраняется. При terminal seal owner Main продолжает держать физическую custody, даже когда транспортные записи удалены.

### Узкое admission на принимающей стороне

4. В closed native request envelope добавить обязательный finite `remainingMs` (integer1…30000), вычисляемый из **того же Host absolute deadline непосредственно перед первым send**. Это единственная новая часть wire shape; method/capability/owner/receipts не меняются. Main фиксирует local monotonic deadline при decode **до первого await**, затем вычитает всё своё queue wait. Для allocate/Stop/drain native `budgetMs` дополнительно ограничивается этим остатком; prepare/resume сохраняют прежний Main allocation deadline. Не выдавать относительный budget за точное измерение IPC latency: более ранний Host timeout остаётся unknown, а уже начатая операция сохраняется и не переигрывается.
5. Existing Main `nativePending` хранит bounded waiting/running original request entries; второй owner map, журнал или daemon не нужен. Всего≤32, work сохраняет8 control slots. До native admission call ожидает **реального** shared reply-byte reservation; control выбирается первым, порядок каждой lane FIFO. `canWrite` учитывает только реально reserved/running replies, а не все waiting entries: полная очередь не должна резервировать сама себя и блокировать progress. Сам waiting payload уже ограничен original frame32KiB и32 wire requests; staging/chunk/stdio bounds не повышаются.
6. Main pump просыпается только от actual stdin write callback, освобождения исходного native reply reservation или поступления call — без polling/retry. После reservation effect вызывается ровно один раз, same epoch/input guards повторно проверяются. Receiver queue expiry до effect превращается в bounded refusal reply в **той же исходной entry**, который сам ждёт original output capacity; не заводить untracked result queue и не запускать effect ради освобождения очереди. Уже reserved reply имеет приоритет над новым admission; reservation обменивается на original output frame ровно один раз. После начала effect expiry не освобождает его reserve/debt и не означает cleanup: original result/receipt остаётся у Main owner до завершения либо потери транспорта.
7. Quiescing отклоняет ещё не admitted allocate/prepare/resume/write/end; original read/observe/Stop/drain/release остаются в прежнем disposal budget. EOF/terminal seal завершает только transport waiting/results; late A не попадает successor B и не освобождает B reservations. Main final cleanup независимо от этого пути.
8. Совместно изменить только existing `owned-process/hostCustody.ts`, Main `CapturedHostClient.ts` и те же existing transport/subprocess fixtures. §42 HostOutput/bridge сохраняются. Закрытая private family квалифицируется как один captured Main+Host build; обновить все existing raw private-family fixtures. Старый/malformed envelope без обязательного remainingMs отклоняется **до effect**, без silent default budget или compatibility fallback. Публичные provider/renderer контракты и native broker wire не меняются.

### Проверяемые границы

- Existing small-shared-budget subprocess case теперь требует ожидания original read calls, затем reserved Stop и eventual exactly-once replies после original barriers; ранняя capacity refusal больше не считается успешной совместимостью. Не поднимать его limits или timers.
- Отдельно удержать реальный Main stdin write callback/bytes и проверить, что original native call ещё не начал effect; после освобождения capacity он исполняется один раз, а expired до admission — ни разу. Control использует прежний reserve.
- В existing Host transport case: timeout возвращает immutable unknown, pending wire debt продолжает занимать slot; exact late ACK освобождает только его marker/slot, subsequent original queued call проходит. Проверить stale hints после timeout и неизменность нового marker, без расширения hints map.
- Existing48-member launch/graceful close, byte-pressure, EOF/old epoch, lost-ACK/no-replay и §34 order/readiness cases остаются обязательными. Build/types/actual subprocess и Windows §38/40 выполняются на окончательном source; прежние A30/§42 source review не подменяют эти результаты.

Independent plan review: root и Profiles — PASS; новые source/execution results пока отсутствуют.


## §41 follow-up — ограничить output во время original donor gate

**Найдено при root review qualification merge, до новой execution claim.**
В опубликованном §41 workflow `a84f5236f33261d12cc0dea3450a40da02a34e87`
`spawnSync` направляет stdout/stderr прямо в fd; проверка файла≤8MiB
выполняется только после выхода. Она не ограничивает writer во время работы.
Предыдущий source review это пропустил. Genuine corpus/old→old/current-D
acceptance по-прежнему требуют actual CI, исправление ниже их не подменяет.

### Круг1 — ровно existing workflow seam

1. В `Qualify genuine old checkpoint and strict current D refusal before
   Desktop Resume` заменить только direct-file stdio на
   `['ignore', 'pipe', 'pipe']` и `maxBuffer: 8 * 1024 * 1024`.
   Путь Node, original argv, cwd, environment pins, old1d/current source
   equality, dependency/archive hashes и сам native test не меняются.
2. После original `spawnSync` взять его фактические stdout/stderr Buffers,
   определить captured byte count и сохранить не более8MiB combined bytes
   по прежнему artifact path, **до** assertion по overflow/error/status.
   Консоль получает только эти bounded bytes. Так original partial output
   сохраняется и при native/child failure; post-exit stat больше не выдаётся
   за действующий output limit. Это тот же простой bounded-buffer приём,
   который уже используется qualification13 scheduled-native prerequisite.
   Не добавлять streaming collector, новый helper/framework или второй child.
3. После сохранения partial bytes требовать captured combined size≤8MiB,
   отсутствие `run.error` и status0; только затем разбирать единственный
   actual receipt и проверять прежние corpus, no-allocation, original history,
   source freeze и `cleanupConfirmed` assertions. Частичный/truncated log,
   maxBuffer termination, отсутствие receipt/child close не доказывают cleanup.
   Не синтезировать INCOMPLETE receipt, release или подтверждение остановки.

### Круг2 — бюджеты и falsification

Existing native test180s, provider45s и job45min остаются прежними.
В этом узком correction не вводить новый внешний timeout и не увеличивать
существующие бюджеты: дополнительный kill ровно на180s мог бы оборвать
уже предусмотренный original finally/Host close. При output-limit error
gate остаётся failed/cleanup-unqualified; никакого native rerun или signal
по заново найденному PID. Сохранённый log не заменяет original custody proof.

Source peer проверяет точный diff одного workflow step: никакой потери
qualification13 policy/Node guards при последующем merge, bounded allocation
и запись partial log до error assertion. Использовать существующую CI
проверку workflow и следующий уже необходимый native-resume row; не добавлять
новую suite/runner/model input. Исполнение correction пока pending.

### §43 actual CI: explicit type for the retained census counter

Native head `dfcea017fad525e24e53d775088a72d013a5b96d`,
[run43394213408/job131781100866](https://github.com/777genius/agent-teams-ai/actions/runs/43394213408/job/131781100866):
Host build прошёл, scripts typecheck остановился с TS7022 на
`desktop-backend-observations.test.ts:131` (`censusReads = reads`).
Добавить только явный `number` к сохранённому счётчику в existing loop.
Initializer, строгий listener guard, failure projection, число census reads
и byte-equality assertions остаются прежними. Новые tests и бюджеты не нужны.
Это исправление compilation, не доказательство устранения Linux listener leak;
следующий штатный native cut обязан повторно пройти types и actual gate.

## 45. §38 B/C: явная native поставка и исходный prepared intent до await

**Уточнение до следующего source, база P09 `37cd3b4dd32a9899f92dfecbb9ab3f3489ba8711`.**
A/§40/42/44 и §43 опубликованы в native child `dfcea017fad525e24e53d775088a72d013a5b96d`;
run `43394213408` только начался. Новый A source не получает native PASS от прежних vendor runs.
B/C остаются отдельной ещё не включённой фичей; этот раздел не меняет §38 D и не обещает восстановление SDK iterator.

### Проверенные границы текущего source

- [`brokerArtifact.ts` на fe6](https://github.com/777genius/agent-teams-ai/blob/fe6eece10344cf1cd6f7dbc216c7eb19070c7c9e/packages/legacy-agent-host/src/owned-process/brokerArtifact.ts)
  принимает ровно schema1/шесть полей и проверяет PE/digest. Это whole-Job delivery, не доказательство service scopes.
  [`debugServiceTest.h`](https://github.com/777genius/agent-teams-ai/blob/fe6eece10344cf1cd6f7dbc216c7eb19070c7c9e/tools/owned-process-broker/debugServiceTest.h)
  включает debugger и `Scopes{64}` только в TEST target; product manifest не должен объявить их по наличию opcodes.
- [`TeamProcessCommands.admit/register`](https://github.com/777genius/agent-teams-ai/blob/fe6eece10344cf1cd6f7dbc216c7eb19070c7c9e/packages/legacy-agent-host/src/process/TeamProcessCommands.ts)
  сейчас создаёт prepared object, но пишет его лишь **после** synchronous capture. Простое добавление await оставит
  effect без durable original intent. Existing `commands/`, validator/fingerprint и Team fence остаются единственным owner.
- [`registeredProcessContracts.ts`](https://github.com/777genius/agent-teams-ai/blob/fe6eece10344cf1cd6f7dbc216c7eb19070c7c9e/packages/legacy-agent-host/src/process/registeredProcessContracts.ts)
  допускает только Darwin/Linux capture; synchronous `signal(capture)` не несёт original command/deadline.
  A Windows allocation не добавляется в POSIX `processRoots`: нужен настоящий typed consumer исходной Main capability.

### B1. Одна явно выбранная сборка с service scopes

1. Выделить общий debug loop из `debugServiceTest.h` в небольшой helper рядом с `serviceScopes.h`.
   Product compile capability отдельна от `OWNED_PROCESS_TEST_DEBUG_SERVICE`; TEST modes2/3, diagnostic FD4
   и fault injection не входят в staged product binary. Один broker по-прежнему создаёт исходный provider и его Jobs;
   второго daemon/debugger/owner не появляется. Failed scope admission не переключается на недоказанный no-debug режим.
2. `CMakeLists.txt`, `scripts/build/buildOwnedProcessBroker.ts` и `brokerArtifact.ts` получают закрытый
   schema2 manifest с единственной явной capability `service-scopes-v1`; schema1 остаётся только whole-Job.
   Exact schema/PE/digest проверяются до launch, выбранная capability входит в private captured profile/selection.
   Поле из renderer/имя файла/успешный неизвестный opcode не являются admission. Название executable можно сохранить
   в отдельном штатном staging directory; за один launch выбирается ровно одна проверенная поставка.
3. Подключение допускается сначала для ordinary Claude Windows x64/ARM64, с собственным actual staged-product gate.
   Codex/V1/Bun, management и scheduled consumers не переключаются вслед за общим manifest reader.
   Перед выбором product quota сопоставить текущие1024 Team rows и lifetime зарегистрированных originals с live-child
   accounting; TEST limit64 не переносить молча. Явный конечный quota и отказ при исчерпании сохраняют original cleanup.
4. В той же native `Scopes` добавить current-child selector: под mutex взять `currentPids→records`, проверить
   retained HANDLE live и согласованность записи, вернуть original key/birth. Это только первый atomic current admission;
   historical PID не доказывается. Effect получает место в existing request cache **до** lookup. Retry исходного intent
   использует прежнюю запись/ответ; новый ID не превращается в replay. Query/Stop/settle далее работают только по scope key.

### B2/C. Journal → один native effect → fence settlement

1. В existing `ProcessCommandReceipt` добавить только закрытое private native-intent поле, достаточное для ссылки
   на original capture/Stop request: operation, original provider capability/generation и стабильный operation reference.
   Валидатор и fingerprint включают это поле; отсутствие поля в настоящих старых receipts остаётся прежним legacy path.
   Это metadata ссылки в том же journal, не HANDLE, не новый target и не отдельный журнал/авторизационный registry.
   Broker wire ID назначает и удерживает тот же Main physical owner; durable operation reference связывает его с командой.
2. Register под синхронным fence делает enter/admit/replay, проверяет input/rows/registrar, сохраняет prepared intent
   **до первого await и до отправки current-child capture**. Replay возвращает прежний receipt/lookup, не захватывает PID снова.
   Native await идёт вне fence. По ответу повторно читаются exact receipt/fingerprint, grant revision, original registrar,
   captured source и актуальные active PID rows; только затем разрешены policy register/attachOriginal.
   Original capture evidence фиксируется прежде этих policy writes; отказ/утрата authority не выдаётся за отсутствие effect
   и не лишает Main уже удержанной cleanup capability.
3. Canonical Windows capture хранит same-Main owner epoch, provider generation/root identity, scope key/birth и registrar.
   CommandId/requestId/time/новая Host incarnation не входят в physical digest. Повторная регистрация той же active row
   возвращает тот же original capture; отдельные completed command receipts продолжают хранить каждый свой original result.
   Новая capture version получает strict keys/limits в `validateProcessRecords.ts`, включая row PID consistency.
4. Stop пишет requested-unknown + exact original capture + native-intent до синхронного enqueue, повторяет исходную
   authority перед enqueue и ждёт ответ вне fence. Original deadline включает очередь; §44 remaining/wire debt сохраняются.
   Timeout/Host loss не создают новый Stop ID. Lookup читает/reconciles именно original Main operation; потерянный capture
   ACK не разрешает повторный current-child lookup, потерянный Stop ACK не разрешает повторный TerminateJobObject.
   Existing broker допускает три service worker и четыре исходных wire waiter/pending effect; bounded admission
   остаётся у того же physical capability, учитывает original deadline и оставляет место whole-provider cleanup.
   Эти пределы не повышаются до32 Host slots; очередь не создаёт новый effect ID после unknown.
   Native `dispatchError=0` само по себе не доказывает dispatch: уже пустой scope мог не получать signal.
   Portable completed absence требует свежего original scope proof; accepted signal и metadata stop его не заменяют.
5. `registered:boolean` остаётся lifetime физического scope. Settle разрешён после genuine absence и durable reconciliation
   связанных pending receipts; metadata unregister/replacement registration не освобождают HANDLE. После settle original
   completed observed-absent читается из прежнего journal, естественное завершение остаётся owner-local tombstone.
   Missing key не означает absence и не допускает повторный capture. Bounded original operation replies остаются при том
   же Main pending capability, без второго application journal.
6. Точный TS cut: `owned-process/{contract,codec,windowsBroker,RetainedWindowsCustody,HostWindowsLaunch,hostCustody}.ts`,
   private Windows capture adapter и existing `process/{registeredProcessContracts,validateProcessRecords,TeamProcessCommands}.ts`.
   Затем только await propagation в `createTeamProcessMethods/createTeamProcessComposition/createMemberProcessMcpPort`,
   `mcp/{contracts,processTools}` и lifecycle `assertReleased`. Team snapshot остаётся синхронной metadata projection;
   реальные list/lookup/terminate ждут native read отдельно. POSIX custody/decoder и старые receipts не переписываются.

### Конечная проверка именно этого cut

Existing Windows vendor/Main gate использует **staged schema2 product broker**, обычную Claude factory и реальный Team
`process_register`; проверяет canonical repeated registration, list → original operator Stop → scope absent при живых
provider/neighbor/foreign witness и продолжение исходного Session. Existing process-command cases расширяются лишь
для prepared-before-await, revoke/source change до commit, lost original capture/Stop ACK, metadata removal при pending Stop.
Неизменённые replay, old receipt decode и async caller closure проходят прежние suites. Отдельной test framework нет.
Same-Main Host rebind, остальные provider tuples и packaged Processes UI остаются §38 D/общей приёмкой.

**R1 source critique:** исправлены неверные предположения «admit уже durable» и «TEST opcode означает product capability»;
отдельно отмечены original operation reference, canonical capture и signal/absence distinction.
**R2 Account:** B2/C authority/replay design PASS: prepared intent до await, original operation reference,
canonical capture, повторный fence и cleanup custody сохранены. **R2 Profiles:** B1 delivery/attestation design PASS:
schema1/schema2, exact staged PE/private selection, TEST isolation и конечные quota явно разделены.
Root review pending; production source по §45 не изменён. Existing3 service worker/4 waiter не повышаются.

R3 root: план source-reviewed; схема поставки и два исходных command fence сохраняются. Actual A/B native acceptance остаётся обязательной; B1 можно подготовить отдельным неактивным срезом без изменения текущего running A head.

## 46. Actual dfcea Windows A: canonical capture до первого Host spawn

Exact native head `dfcea017fad525e24e53d775088a72d013a5b96d`, run `43394213408`,
x64 job `131781101241`: прежние Node/Electron/Host facade gates и actual Claude service-scope step15 PASS.
Новый A step16 отказал в `validateHostProfile:80` с `profile-mismatch/not-dispatched`, до Host spawn/native input.
По этому результату Main-retained A, graceful/crash HANDLE proof и дальнейшие B/C/D не квалифицированы.

Controller выдал TEST sandbox с `RUNNER~1`; fixture захватывает file paths через обычный `realpathSync`,
а production guard сравнивает их с `fs.promises.realpath`. В exact
[Node24.21 lib/fs.js](https://github.com/nodejs/node/blob/v24.21.0/lib/fs.js) обычный sync — JS walk,
а `realpathSync.native` и [promises.realpath](https://github.com/nodejs/node/blob/v24.21.0/lib/internal/fs/promises.js)
вызывают один `binding.realpath`; Windows [libuv](https://github.com/nodejs/node/blob/v24.21.0/deps/uv/src/win/fs.c)
получает canonical name через `GetFinalPathNameByHandleW`. Короткое имя не является равной canonical строкой.

Узкий исправляющий cut: `SelectedHostProfile.nodeExecutable/hostEntry` в
`tools/owned-process-broker/nativeRetainedHostGate.ts` захватываются через `realpathSync.native`.
Source follow-up перед публикацией также проверил `CapturedWindowsCustody.verifyLaunch`: native canonical equality
обязательна для `spec.cwd`. Поэтому `prepareProfile` один раз разрешает **исходный controller sandbox** через
тот же native realpath, затем строит cwd/env/storage/profile paths прежними join из этого каталога.
Исходный controller sandbox guard до вызова сохранён; нет нового root, path fallback или ослабления equality.
Candidate blob `945eb8f7d37b4500a4f3b0e6c06ea5db1961afbb` относительно `bef380e2d19fd423c54af5694117d1dc95ad249c`;
readback MATCH. Hashes по-прежнему вычисляются из фактически созданных/captured файлов; canonical paths обозначают
те же TEST locations. Strict equality/isFile checks, deadlines, first-input admission и original cleanup сохранены.
Account source peer PASS для двух file captures и дополнительного canonical-root hunk; compiler/native execution pending.
Это TEST capture correction; runtime PASS для новых bytes ещё нет. Existing exact-head A gate должен
дойти до ordinary native turn и исходных HANDLE observations в обоих режимах, без нового oracle/runner/таймера.
Текущие ARM/Linux jobs продолжают штатно; новую проверку получит следующий необходимый source commit.

## 47. POSIX verify → exec: подтверждённый разрыв и оставшееся доказательство

Thread `PRRT_kwDORVTEtM622qol` остаётся открытым по actual source
`235b01b489a4f428b72c7667b0c89061c82cab1b`. Это source audit; нового native запуска,
исправления production или положительного safety outcome здесь нет.

### Что именно подтверждено

- `CapturedProcess.ts` (`b5c545e518ec91e7efa784ee2e494dfa0038644e`) проверяет pathname/SHA,
  затем делает дополнительные directory reads и вызывает `spawn(request.command, request.args, ...)`.
  Исходный executable descriptor до exec не удерживается. Поздний `captureRoot/readRootExecutable`
  не исключает исполнение подменённого файла до этой проверки.
- `RuntimeSourceNativeVersion.ts` (`0ec09130bf10bca87b64a13efc4aab5494b13d30`) использует тот же
  CapturedProcess для `--version`; исправление P06 async hashing относится к publication admission.
  Его descriptor закрывается в `verifyRuntimeSourceCandidate` и не является launch capability.
- Exact [Node24.21 libuv process.c](https://github.com/nodejs/node/blob/v24.21.0/deps/uv/src/unix/process.c)
  передаёт pathname в Linux `execvp` и Darwin `posix_spawn`. Повторный hash непосредственно перед
  этим вызовом уменьшает окно, но не закрывает его. Профиль сейчас не ограничивает executable только ELF/Mach-O.

### Исключённые короткие решения

1. Не вводить blanket `mode & 022 === 0` или доверие всему GID текущего пользователя.
   [Homebrew installer](https://github.com/Homebrew/install/blob/main/install.sh) штатно задаёт
   `g+rwx`, на macOS обычно группе `admin`, на Linux основной группе пользователя.
   Членство других пользователей не следует из owner UID/GID. Это потребовало бы новой trust policy
   и могло бы сломать поддерживаемую installed/custom установку.
2. Mode alone не доказывает macOS ACL; см. [Apple file-system ACL semantics](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileSystemDetails/FileSystemDetails.html).
   Sticky ancestors и writable executable требуют отдельных доводов; world-writable `/tmp` нельзя
   просто принять или запретить без проверки исходного protected child.
3. Linux fd execution не является автоматически переносимым на macOS. В current
   [XNU devfs_fdesc_support.c](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/miscfs/devfs/devfs_fdesc_support.c)
   `fdesc_open` обслуживает специальное дублирование fd, а `fdesc_read` возвращает ENOTSUP;
   обычный `exec("/dev/fd/N")` не считать equivalent of Linux `/proc/self/fd/N`.
   Удержание inode также само по себе не запрещает in-place запись в него.
4. Не копировать одиночный executable в новый cache и не считать это прозрачной заменой:
   argv0, interpreter scripts, executable-relative assets/dylibs и reported provenance должны сохраниться.
   Postspawn pathname/hash, advisory lock или успешный `--version` не заменяют pre-execution proof.

### Следующий узкий proof, до выбора product implementation

- В существующем POSIX native TEST seam связать original captured file с реально выбранным kernel image,
  сохраняя original process/session/group custody. Контролируемая замена pathname между verification и
  allocation должна дать **ноль инструкций TEST replacement**, а не только поздний отказ/cleanup.
  Отдельно различить rename replacement и in-place mutation; не выдавать одно за покрытие другого.
- Linux candidate: запуск из исходного проверенного descriptor, если доказаны byte stability и сохранение
  original argv/env/cwd/executable identity/relative resources. Никакого silent fallback к pathname.
- Darwin candidate: существующий private native adapter и
  [POSIX_SPAWN_START_SUSPENDED](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/posix_spawnattr_getflags.3.html)
  позволяют рассмотреть проверку до user-space. Сам suspended state недостаточен:
  нужны exact kernel-selected file/image, исходные birth/parent/session и проверенные bytes до resume.
  Пока штатный original-image proof и совместимость с уже разрешёнными custom executables не установлены,
  новый launch API/порт/административные entitlements не проектировать как готовое решение.
- В выбранном existing gate сохранить native/installed/custom пути, все текущие аргументы и environment,
  sibling resources, provenance, cancellation и исходное cleanup. Не менять executable identity contract,
  не добавлять daemon, новый owner/journal или увеличенный deadline. Новый native результат нужен именно
  для новых bytes; текущий source audit не разрешает production activation.

**R1:** найдено конкретное pathname окно, отдельно от P06 publication fd/hash и postspawn custody.
**R2:** исключены permission/group shortcuts, непереносимый fd alias и незаметная смена executable location.
Решение остаётся pending proof; до его получения thread и этот native acceptance пункт не закрываются.

## 48. Genuine old checkpoint: retain the observed generation on later controls

**Evidence before the change.** Exact parity head `235b01b489a4f428b72c7667b0c89061c82cab1b`,
job `131780549007`, original artifact `14023871625`
(ZIP SHA256 `303438118f5e09229df8d13c7918d9c5dfa42215a964af700ca5d4a4f2de3b51`)
is INCOMPLETE, with cleanup confirmed. Its eleven model observations contain ONE and TWO,
the original ONE native tool IDs in every TWO request, the selected Opus/medium options and
the original team context. Both original business receipts completed. The first old Host
checkpoint/Stop and the second old Host restore succeeded; the failure is the second
`runtime.dispatch` at native-claude-host.native.ts:384, after TWO.

### Source cause and smallest correction

- The exact unchanged donor commit `1d0f97f55de566036c970eab4f36b84620afdb3f`,
  `packages/legacy-agent-host/src/composition/resolveRuntimeControlEntry.ts`, rejects a
  non-read control after a restore when `expectedGeneration` is absent. Its
  `runtimeControlValues.ts` already accepts that field. Current Host retains the same rule.
- The fixture's original `runtime.read` immediately preceding each dispatch already retains
  the actual selected generation in `finalRuntime`. Supply that exact observed generation to
  the existing dispatch. Do the same for the final Stop and for the existing cold outbox
  dispatch using the original cold `runtime.read` result.
- Preserve the original command IDs, one call per operation, the original capture/reference,
  old Host source/dist/provider bytes, the strict current-D refusal and zero-allocation counters.
  No replacement intent, retry, new generation lookup or provider admission is added.
- Keep the fixture failure strict. A failed dispatch should report only its closed
  `ok/code/outcome` fields in the assertion, so another refusal cannot disappear behind
  a bare false/true diagnostic. Do not log native inputs or opaque checkpoint bytes.
- The actual old source and receipt are the references; no production control guard is weakened.
  This is a three-control TEST call-site correction, not a D compatibility implementation.

### Verification and review rounds

1. **R1 — original evidence and source:** verify the artifact digest and all eleven original
   model observations; compare the exact donor guard and current guard. The old checkpoint is
   still unqualified until the complete corrected gate finishes.
2. **R2 — authority and scope:** independent review must confirm every supplied generation comes
   from the same original selected Runtime read, including after cold restart; original IDs and
   budgets remain unchanged. Do not skip dispatch/Stop, relabel the earlier failed run, or edit
   donor source to make the corpus pass.
3. **R3 — executable proof:** run the existing Host-script typecheck and the existing selected
   runtime control/restore regression coverage, then the original native checkpoint gate on the
   new exact head. Require checkpoint/history/PDF/native tool receipts, both original business
   inputs, strict no-allocation refusal, final ordinary Stop/restart/replay and original cleanup.
   No new unit-test suite or larger timeout is needed for the existing typed field.

The subsequent §39 compatibility correction and current-Main route qualification remain open.
A qualified old corpus alone cannot close the compatibility review thread.

## 49. §45 B2/C: original service operation through the existing broker

**Source refinement before the next implementation.** B1 delivery and the bounded native
current-child selector remain inactive candidates; their source reviews do not qualify staged
Windows behavior. Current A gate still needs the §46 TEST capture correction. Main cold rebind,
other providers and packaged Processes UI remain separate acceptance work.

### Concrete missing seams

- `WindowsCapability.request` retains an expired wire waiter, but its `received(): void` callback
  cannot retain the late decoded reply for original capture/Stop lookup. Preserve the original
  frame at this same waiter; do not resolve the timed-out caller again or allocate another wire ID.
- `windowsBrokerReference` currently hashes an explicit schema1 projection. An optional private
  `service-scopes-v1` selection must participate in that projection, schema validation and all
  Host/Main/broker verification calls. An absent field preserves the original schema1 reference;
  no consumer infers the capability from a filename or successful opcode.
- Whole-provider release ends the original broker's service handles too. Missing scope/closed
  transport is never absence. Retain an actual terminal scope fact, or derive owner-local absence
  only from the same capability's genuine `job-membership` whole-Job receipt and the scope's
  previously proven membership. Root exit, EOF, metadata stop and `no-local-dispatch` are insufficient.

### Small typed API and one physical owner

1. Add an optional closed service port to the prepared original process. It allocates a pure
   pending capture/Stop/settle operation before dispatch; read-only query does not create durable
   operation history. Main stores this pending object under the original journal operation reference
   before running it. The operation retains its exact request, first deadline, wire ID when assigned,
   immutable initial outcome and the latest original validated reply. Lookup reads that object;
   it never resends capture/Stop or calls the current-child selector under a fresh ID.
2. A narrow `owned-process/WindowsServiceOperations.ts` helper may hold this typed queue/state,
   using the existing `WindowsCapability` transport and decoder. It is not another broker or RPC
   family. At most three service requests hold the existing four wire slots; whole-provider
   Stop/release retains the fourth. Queue admission and native Stop payload consume the original
   absolute deadline. Late ACK retires only its own wire debt. Service replies cannot enter
   `publishRoot`, manufacture a whole-Job `TreeReceipt`, or rewrite another operation.
3. Keep original service operation references at the existing Main allocation. The explicit ceiling
   is 10000 per allocation, matching the existing Team command-entry ceiling; no unresolved record
   is evicted. Read-only queries do not consume it. Scope facts remain bounded by the selected
   product's 4096-scope ceiling. Capacity refusal precedes dispatch and preserves whole-provider
   cleanup. Neither the native64 settled-frame cache nor Host32 slots becomes application history.
4. Ordinary Claude first uses its exact installed original root capability; PID does not select a
   provider, member or new root. Any nonunique/unavailable root selection stays held until its
   explicitly qualified route exists. Canonical capture uses original Main epoch, provider capability/
   generation/root, native scope key/birth, target PID and registrar. A new command or replacement
   Host does not change that physical identity. Same scope with conflicting registrar/physical
   metadata refuses instead of overwriting the original result.
5. Extend only the existing private Host custody family with typed service capture/query/Stop/
   settle/lookup. Same binding, lane, remaining budget, quiescing and late-ACK rules apply.
   New captures require current input/source admission; query, original Stop, settlement and lookup
   remain cleanup operations on already retained capabilities. Source refusal cannot discard cleanup.
6. The existing Team journal stores the original native intent before the first await, exactly as
   §45 specifies. Native work remains outside the synchronous Team fence; after-await settlement
   rechecks the same receipt, grant, registrar/source and active rows. Async list/lookup/terminate
   use exact original capture, while synchronous Team snapshots project metadata only. POSIX
   capture and genuine old receipt decoding remain unchanged.

### Verification scope

Extend existing broker protocol and retained-owner/Host process-command tests for the one genuine
late service reply, bounded queue plus whole-provider cleanup reserve, prepared-intent-before-await
and no duplicate effect on lookup. Use the existing Windows staged-product/ordinary Claude gate
for registration, original subtree Stop, neighbor/provider survival and original Session continuation;
an unstaged TEST helper does not replace that proof. No new test framework, runner or time budget.

**R1:** the late-frame loss, explicit capability hash projection and whole-release boundary are
confirmed in exact `dfcea017` source. This is a design refinement only; source/compile/native
acceptance of this next layer is pending. B1/native-selector source reviews remain separate.

### Actual798 native build follow-up — product callback parameter

Run `43404243605`, Windows x64 job `131814506262`, failed in step9 before native
scenarios. MSVC reports C4459/C2220 at `broker.cpp:45`: the new product-only
`service_runtime::run` parameter `root` hides the original broker's global
`root` at line26. Keep warnings-as-errors and every native guard. Rename only
that parameter to `originalRoot` and its one forwarded argument; the same
original HANDLE, shared debug loop, target selection and budgets remain unchanged.

R1: exact compiler log and source agree. R2: independent two-line source review.
R3: existing C++ build and original native gates on the next necessary source
head; a Linux TypeScript/test pass cannot substitute for MSVC. Current ARM/Linux
jobs continue normally; do not cancel or rerun them for this correction. ABI job
`131814506670` already passed, but it is not Windows product qualification.

### Existing Main retirement and prepared registration payload

Source at `689dddb`, `RetainedWindowsCustody.retire`, currently removes released
allocations beyond64; their service-operation references would disappear with them.
Keep unresolved service intents at that same allocation. A released allocation is
evictable only after its original service effects and registered scopes have settled;
a logical timeout, missing ACK, metadata removal or Host loss does not qualify it.
Do not detach the original late-reply callback while that debt remains retained.

Preserve both existing capacity components: at most256 active allocations and at most
320 total retained allocations (the existing256 active plus64 terminal allowance).
Before a new allocation, retire only eligible settled released entries; when retained
debt fills this bound, refuse new allocation before creating a pending/native effect.
Original lookup, query, Stop, drain, release, settlement and Main Quit keep their
existing control route and reserve. No additional owner, PID fallback or journal is
introduced. Whole-Job evidence may close only an already proven scope of that exact
Main allocation; an unknown capture without its original scope reply remains unknown.

`TeamProcessCommands.register` retains only `requestDigest` before its current native
capture; label/port/url/command enter `original` only after the registry write. The
async Windows path therefore stores a closed original registration-input projection
beside its prepared native intent in the existing receipt, using the existing field
limits. Both optional projections enter the fingerprint only when present; legacy
receipts remain unchanged. Lookup may complete only that recorded request after the
original grant/registrar/source and current rows are checked again. Missing historical
payload never authorizes a fresh capture or reconstructed registration.

R1: exact retirement and register sources checked. R2: independent review before
source. Extend the existing retained-owner/process-command cases for exhausted
retained debt, original late ACK and journal-before-await; no separate test suite.

## 50. §47: actual POSIX counterexamples and the next native proof

**Scope:** first qualify a native launch boundary; do not change production `CapturedProcess`,
source publication, executable formats, trust policy or ordinary installed/custom behavior yet.
The unresolved thread remains `PRRT_kwDORVTEtM622qol`. Source context is parity
`d35ef8256a9f24294b2fe50e8290ccb9841d9eb1`; its pathname launch retains the §47 gap.

### Actual isolated evidence, kept separate from source reasoning

Immutable evidence manifest: `a0bdd614cee5aafc94a9637c6cb25faa21319c2e`.
Both probes used only fresh TEST files, UID1000, Linux6.18.57 x86_64, glibc2.41 and
cc14.2.0. They changed no repository code, permissions policy, container setting or provider data.

- FD compatibility/counterexample receipt `12029689683fc3153657ccfb12eea7d7055c167e`,
  SHA256 `aca0da0d271d1e73d6bad0de6dd046f01176a9ee39a077be90e07a64005c941e`,
  completed ten controlled cases. Pathname replacement after capture executed TEST B.
  FD execution survived rename and executed A, but rewriting that same retained inode before
  exec executed B, including its constructor. An open writer caused ETXTBSY at native exec;
  closing the writer after changing bytes allowed B. The latter is not protected by retaining an FD.
- The native FD positive case preserved explicit argv0/arguments/environment/cwd, a sibling
  asset and a shared library loaded through `$ORIGIN`; `AT_EXECFN` nevertheless changed.
  Script FD execution with CLOEXEC failed with ENOENT. Without CLOEXEC it changed `$0` to
  an FD path, and the same-inode script rewrite executed B. These are concrete compatibility
  and safety counterexamples, not permission to disable scripts or drop original provenance.
- Pre-user-stop receipt `6425eb1b9dca10995022caff543de1ab6ff859ac`, SHA256
  `1a0e6eeca1d195313590f6c86eccf036e7f2822f2ca210cfdcd3c664777ae542`,
  is **UNAVAILABLE**: the original child received PTRACE_TRACEME EPERM before exec.
  No selected payload instruction ran; the original child was reaped and its group absent.
  The first probe attempt had an unclassified initial-stop assertion; the retained receipt
  comes from its corrected classification, not a successful protected launch. Do not infer
  whether seccomp, ptrace policy or another restriction supplied EPERM, and do not change it.
- Every completed counterexample reaped its original child and observed original group absence.
  These observations do not qualify a Linux protected launch or any Darwin execution.

### Minimal practical candidate to prove

Prefer an **original-path launch stopped before selected user-space instructions** over replacing
the installed executable location. This preserves argv0, loader/resource lookup and provenance
if the operating system can prove the selected image and stabilize its bytes. A final pathname
hash followed by resume is not such a proof.

1. Linux: a direct original child uses PTRACE_O_TRACEEXEC, and the original parent handles the
   exact PTRACE_EVENT_EXEC before the loader or executable runs. At that stop, open the
   kernel-selected `/proc/<original-child>/exe`, compare its original dev/inode and complete SHA,
   retain the original birth/session/group and exercise write denial on the same inode.
   Use pathname exec with the original argv/env/cwd; FD exec is only a negative/control case.
   Refuse replacement before any TEST library/executable constructor instruction. A writer
   already open at exec and a write attempted after the final image check are separate cases.
   Ptrace EPERM remains unavailable; no capability, sysctl, container or setuid workaround.
2. Darwin: use POSIX_SPAWN_START_SUSPENDED on the direct original child, with the existing
   audit-token/parent/birth/session and dynamic SecCode guest validation approach. The proof
   must first establish that these observations are available while the child has not executed
   user code. Separately attempt same-inode mutation after the final successful image check
   but before resume. A signed-image comparison alone must not be called byte stability.
   Record actual kernel image, signature enforcement, rename/in-place outcome and first
   instruction markers on both existing Darwin architectures. No new entitlement or CS flag.
3. Keep a native binary plus interpreter-script control. The kernel image of a script may be
   its interpreter; validating that interpreter cannot silently validate the selected script body.
   Preserve `$0`, relative assets, explicit arguments/environment and original source identity.
   A native-only positive result does not close custom/script parity. No silent pathname fallback,
   copied-executable fallback, new group/mode refusal or signature requirement is authorized.

The Linux source basis is [exec.c at v6.18](https://github.com/torvalds/linux/blob/v6.18/fs/exec.c)
(blob `4298e7e08d5d78ea327c10e9e962780b3d976e1a`) and
[PTRACE_O_TRACEEXEC semantics](https://man7.org/linux/man-pages/man2/ptrace.2.html):
the source denies writes to the opened native executable and reports the exec stop before
return to user space. This is a candidate argument, not execution evidence in the blocked sandbox.
Apple's inspected [kern_exec.c](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_exec.c)
blob `47420f9f8f620233f112e87a51ed8f576caa3546` has the old v_writecount/ETXTBSY
check under `#if 0`; do not transfer Linux write-denial semantics to Darwin.
Its [vfs_subr.c](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/vfs/vfs_subr.c)
blob `77a16c1a21ed3af64fd686231374e824eb6bb3f7` requires the private
`com.apple.private.vfs.file-leases` entitlement for F_SETLEASE. That is excluded, not a fallback.
These Apple source observations are not a claim about every qualified runner's exact kernel;
the actual OS-build-bound proof remains required.

### Smallest next repository slice and acceptance

- TEST only: extend the existing `registered-process-executable.native.ts` qualification and a
  narrowly scoped native TEST actor for the original-path cases above. Run in the already
  existing Linux/Darwin `embedded-v2-native-host` jobs of
  `.github/workflows/opencode-v2-stage1-preflight.yml`; retain the existing Darwin custody
  scenario, source/artifact binding and all provider journeys. No new runner/matrix or SDK input.
- A new TEST C helper is permitted only if needed to perform these platform calls before any
  selected instruction; it is compiled into the private fixture directory and is never staged
  as a product artifact. It is not a production launch port, broker or generic framework.
- Keep the existing outer native-test/job budgets. Bound every original child, output and receipt;
  retain the original returned child and reaping state for cleanup, never signal a reaped PID or
  adopt a later numeric PID. Scope receipts to TEST values, source/binary hashes and closed facts.
  An unavailable primitive or missing pre-execution observation is incomplete, not a skipped PASS.
- Before proposing production integration, require normal launch with original resources and
  zero replacement instructions for rename and in-place adversaries, including the mutation
  after the last successful image check. Then qualify the unchanged installed runtime paths
  and custom-wrapper semantics under the same primitive. No postspawn kill can substitute.
- Node's current ChildProcess API does not expose this stop boundary. A proof must not fabricate
  a ChildProcess around a PID or call the existing postspawn custody result pre-execution proof.
  Choose any smallest existing private-adapter/facade integration only in a subsequent reviewed
  amendment after actual platform results; no second owner or journal is pre-authorized.

**R1:** the full review thread, current callers and §47 source contracts were reread.
**R2:** actual same-inode/script counterexamples exclude FD-only and path-copy shortcuts;
the sandbox's EPERM is kept distinct from a failed or successful operating-system primitive.
**R3:** independent plan review must verify the after-check mutation, original-child cleanup
and existing-job scope before the TEST slice. Production/thread closure remains pending.

## 51. Actual689 Windows Main-route refusal: bounded TEST evidence

Run `43407471332` completed both Windows jobs `131825241907` (x64) and
`131825242028` (ARM64) with step16 failure at the first ordinary `runtime.open`.
Artifacts `14027448985`/`14028393083` contain `main-retained-graceful.json`:
phase `native-open`, all five successful-operation counters zero, model requests zero,
cleanup true. Both direct native vendor receipts passed original scoped Stop and
same-Session continuation, but do not qualify the ordinary Main/Host route.
The current rpc assertion discards the returned finite code/outcome. Its counters
increment only after a successful private call, so zero is not proof of no attempted effect.

Change only the existing `nativeRetainedHostGate.ts` TEST observer. Retain the first
failed method from its existing closed route set, allowlisted code/outcome and separate
bounded attempted-private-operation counters; preserve all original success counters
and assertions. After that original refusal, make at most one read-only `runtime.read`
for the same member/binding, without calling the failing route again. Project only
closed phase/custody/diagnostic classifications and boolean readiness/attachment/seal.
Bound this diagnostic by the lesser of one second and the unspent original45s request
deadline; if unavailable, record unknown and continue original cleanup. The original
assertion/error remains the failure, even if this read fails.

No stderr, error.message, arbitrary payload, profile path, argv, environment or private
native identity is retained. Do not change product guards, SDK input, success criteria,
retry behavior, runner or time budgets. Use the next necessary native source cut;
current Linux jobs continue normally. R1: exact original receipts and rpc/counter source
checked. R2: independent finite-projection review before source. Actual cause is still
unproven; a pre-open rejection must not be repaired by guessing from success counters.

### §50 review clarification: compiler-default and ad-hoc TEST artifacts

Keep the compiler-default native binary and library as an independently recorded case. On Darwin,
a second case may sign only fresh private TEST payload/library copies with ordinary ad-hoc signing
(`codesign --sign -`), before capturing their original bytes. No entitlement, hardened-runtime,
kill/hard option, provider-file change or permission change is allowed. Record compiler-default
and ad-hoc inputs/digests and outcomes separately; never overwrite the former with the latter.
Unavailable dynamic validation of an unsigned original is an incomplete original case, not a
negative image match or a reason to omit that format. Even a successful signed-native proof does
not qualify compiler-default/unsigned executables, scripts, installed/custom runtimes or product
activation. Keep the same existing native test/job budgets, matrix and original-child cleanup.

## 52. Team journal: original Windows registration/Stop без async внутри Team fence

**Статус:** план следующего связного B2/C-среза; private Main/Host consumer из manifest
`5f8ed1db069e48303ffa34b4138297a96b14fc74` имеет peer source PASS, но его восстановленные
тесты не исполнены. Actual Main → ordinary Claude gate §51 ещё не прошёл; production
service capability по-прежнему не включаем для остальных провайдеров/default schema1.

### 52.1. Проверенная существующая граница

- [TeamProcessCommands@689](https://github.com/777genius/agent-teams-ai/blob/689dddb61cedf0649379975735bac162c87c2836/packages/legacy-agent-host/src/process/TeamProcessCommands.ts)
  уже владеет `commands/`, fingerprint, grant fence, register/terminate/lookup.
  `register` сейчас синхронно сохраняет native capture до policy write; receipt содержит
  digest запроса, но не поля исходной регистрации. Windows capture/lookup требуют await.
- [TeamOwner@689](https://github.com/777genius/agent-teams-ai/blob/689dddb61cedf0649379975735bac162c87c2836/packages/legacy-agent-host/src/team/TeamOwner.ts)
  вызывает `processCommands().list()` внутри синхронного product snapshot. Этот путь нельзя
  сделать Promise или снабдить вторым authoritative cache. [MCP wrapper@689](https://github.com/777genius/agent-teams-ai/blob/689dddb61cedf0649379975735bac162c87c2836/packages/legacy-agent-host/src/composition/createMemberProcessMcpPort.ts)
  также пока проверяет current/source только синхронно.
- [Public methods@689](https://github.com/777genius/agent-teams-ai/blob/689dddb61cedf0649379975735bac162c87c2836/packages/legacy-agent-host/src/process/createTeamProcessMethods.ts)
  уже async и используют явную public projection. Новые private intent/capture поля не входят
  в renderer/MCP result; `processRef`, существующая Processes row и Stop остаются прежними.
  [Main@689](https://github.com/777genius/agent-teams-ai/blob/689dddb61cedf0649379975735bac162c87c2836/src/features/agent-backend/main/infrastructure/CapturedHostClient.ts)
  уже уменьшает любой `budgetMs` на время своей очереди до `port.handle`.

### 52.2. Минимальные контракты и порядок

1. Расширить `RegisteredProcessCapture` только строгим v5 из уже проверенного
   `retainedServiceContracts`; legacy Darwin v1/v2 и Linux v3/v4 декодируются без переписывания.
   У receipt schema1 добавить optional `nativeIntent` и закрытую `originalRegistration`
   (`pid/label/port?/url?/command?`, original policy memberName, `policyRequested`).
   Использовать существующие пределы label1024, url/command4096 и общий receipt128KiB.
   Новые поля участвуют в fingerprint только при наличии; old fingerprint/bytes не меняются.
2. В существующем `TeamProcessCommands` оставить sync metadata/snapshot API. Добавить один
   узкий Windows async facet через `WindowsTeamProcessCommands.ts`, получающий те же
   admit/readReceipt/persist/view/select/enter callbacks и тот же store. Никакого второго
   command registry, native owner, receipt journal или background recovery loop.
   Sync view для v5 допускает durable completed terminate absence; иначе возвращает unknown,
   без POSIX-adapter вызова или придуманного canTerminate.
3. Windows `register`: под текущим fence проверить command replay, grant, original registrar,
   input и active PID rows. Mint pure intent от единственного уже installed/resumed original
   provider capability; сохранить его и закрытый original input **до первого await**.
   Original requested/unknown registration разрешён только при этих Windows полях; это
   application intent, не утверждение, что native capture уже состоялся.
   Повтор original command возвращает receipt; serialized intent никогда не вызывает run.
4. Capture run/lookup выполняется снаружи fence. После ответа войти в тот же fence, заново
   проверить current grant/source/registrar, original receipt/intent/fingerprint и текущие rows.
   Genuine capture сохраняется до любой policy mutation; changed source/отказ policy не
   удаляют Main pending object и исходную cleanup authority.
   Перед первым `registry.register/attachOriginal` сохранить `policyRequested:true`.
   После этого recovery не вызывает register второй раз: завершить можно лишь по единственной
   текущей row с тем же `capturedByCommand`, full capture и original policy input; иначе held.
   Так lost capture ACK позволяет закончить ещё не начатую policy phase, а uncertain policy
   write не превращается в повторную регистрацию.
5. Windows list/read: зафиксировать исходные private captures под read fence, выполнить
   bounded native query снаружи и снова проверить grant/current rows под fence. Сопоставлять
   observation только по полному capture digest, не PID. Per-call projection не сохраняется
   как authoritative cache; changed rows остаются unknown. Не больше трёх одновременных
   native queries; один общий deadline, оставшиеся после его истечения строки unknown.
6. Stop: под admin fence выбрать exact processRef/capture, persist original pure Stop intent
   и requested/unknown receipt перед run. Lookup использует только original intent snapshot
   и query того же capture; не пересылает Stop и не recapture по PID.
   Absence требует точных retained/native facts; `signalAccepted` остаётся unknown, если
   исходный protocol reply не доказывает принятие сигнала. Native refusal/transport loss
   сами по себе не означают no effect; только явный not-dispatched может быть rejected.
   Завершение pending Stop сохраняет существующий completed/observed-absent full-capture proof,
   в том числе после metadata unregister и при наличии replacement row.
7. Settle первого connected cut разрешён лишь после genuine absence и reconciliation всех
   исходных pending terminate receipts для той же physical scope. Pure settle intent сохранить
   optional в **том же** completed terminate receipt до await; lookup читает только его original
   pending result. Никакого fake Human Stop для natural exit. Естественный terminal scope
   остаётся читаемым из original Main; автоматическое retirement natural registered scopes
   без completed Stop пока отдельный незакрытый gate, не объявлять его выполненным.
8. Один deadline начинается при входе в public/MCP async process operation до capture/source
   work и переносится через admission → run/query → settlement. Верхняя граница10s соответствует
   существующему Windows provider Stop; reverse-frame max30s и native limits не увеличиваются.
   Истёкший queued intent не исполняется; already dispatched unknown остаётся original.
   MCP wrapper должен await результат и снова проверить source/current, сохранив opaque
   failure и cleanup ownership при отказе после await.

### 52.3. Конкретные файлы и следующий proof

- `process/registeredProcessContracts.ts`, `validateProcessRecords.ts` — v5 и optional receipt
  fields; `processReceiptFingerprint` остаётся единственным fingerprint алгоритмом.
- `process/TeamProcessCommands.ts` + один небольшой `WindowsTeamProcessCommands.ts` —
  shared synchronous owner callbacks и Windows async phases; `createTeamProcessMethods.ts`
  await facet перед прежней projection. `team/createTeamCommandAccess.ts` передаёт optional
  private port; `TeamOwner.ts`/его snapshot не увеличивать и не переводить на async.
- `CapturedProcess.ts`, `WindowsCapturedProcess.ts`, provider `MemberProvider.ts` и обычный
  `ClaudeMemberProvider.ts` — pure prepareCapture от exact existing pending root; если нет
  ровно одного eligible original root, отказ до capture. Объявить эти common paths до edits.
- `createMemberProcessMcpPort.ts`, `createTeamProcessComposition.ts` и существующий Host wiring —
  same-member capture facet и global original-Main cleanup facet для read/Stop/lookup после
  Host replacement. Никакой implicit activation Codex/OpenCode V1/V2.
- [`mcp/contracts.ts`@689](https://github.com/777genius/agent-teams-ai/blob/689dddb61cedf0649379975735bac162c87c2836/packages/legacy-agent-host/src/mcp/contracts.ts)
  расширяет только существующий process port до sync/Promise результатов;
  [`mcp/processTools.ts`@689](https://github.com/777genius/agent-teams-ai/blob/689dddb61cedf0649379975735bac162c87c2836/packages/legacy-agent-host/src/mcp/processTools.ts)
  await register/list/metadata/lookup до прежней explicit projection. Имена и schemas tools,
  metadata-only Stop/unregister, public результат и authority checks не меняются.
- Продолжить existing command/registered-process fixtures: (a) lost capture ACK → cold lookup
  finishes once, (b) grant/source change после await не публикует row, (c) interrupted policy
  phase не регистрирует повторно, (d) pending Stop + metadata removal + replacement PID
  сохраняют original receipt и terminal history. Это проверки реальных опасных границ,
  не отдельная suite для каждого mapper.
- После исправления actual §51: existing native Windows Main/Host journey использует отдельно
  staged schema2 product broker и genuine Claude background service → MCP register → Processes
  read/Stop. Original service HANDLE absent, соседний service и provider alive; lost ACK и
  same-Main Host replacement читают original receipt. Actual Windows x64/ARM CI и существующая
  Linux/Darwin regression необходимы; source/test-double PASS их не заменяет.

**R1 self-review:** обнаружен sync snapshot caller; сохранён sync API вместо Promise в snapshot.
Обнаружено отсутствие original policy input и границы before-policy-write; добавлен один закрытый
receipt field с `policyRequested`, чтобы recovery не повторял неизвестный metadata effect.
Natural registered-scope retirement и full Main cold lifetime явно не повышены до готовых.
**R2:** Root и Account — bounded plan PASS; MCP sync projection gap закрыт явной source closure выше.
**R3:** review новой реализации и actual native/old-format proof pending.


### 52.4. Pure intent без вложенного Runtime fence

Source review обнаружил дополнительную границу: [RemotePending.registrationSource@be779](https://github.com/777genius/agent-teams-ai/blob/be779ca99a5626b1ec81d1b9c223245d86d0b1d6/packages/legacy-agent-host/src/owned-process/HostWindowsLaunch.ts)
сейчас вызывает общий input guard, а ordinary Claude передаёт туда
[canAllocate@be779](https://github.com/777genius/agent-teams-ai/blob/be779ca99a5626b1ec81d1b9c223245d86d0b1d6/packages/legacy-agent-host/src/composition/captureMemberProviderAuthority.ts),
который читает Runtime. При mint pure capture intent внутри Team fence такой путь недопустим.

В существующий private `HostWindowsLaunch.port`/original `RemotePending` добавить optional
`captureCurrent`. Без него новая service capture отказывается; прежние launch/cleanup остаются
доступными. Ordinary Claude передаёт уже существующий Team-only `canCaptureRegisteredProcess`
(factory использует `authority.isCurrent`, а не `authority.canAllocate`); только
`registrationSource` использует этот guard вместе
с original sealed/resumed/exit/schema2 checks. Launch, prepare, resume и stdin оставляют прежний
full current. Pure selector не выбирает root по PID и не выполняет native dispatch.
Outer MCP wrapper продолжает проверять captured Runtime input вне Team fence до/после await;
native service admission также повторно проверяет исходную Main capability/source.
Расширить один существующий critical fixture, чтобы pure prepare не входил в Runtime guard,
а revoked Team capture и обычный input по-прежнему отказывались. Нового owner/authority cache нет.


### 52.5 — узкое исправление фактического CI lint

Native branch head `689dddb61cedf0649379975735bac162c87c2836`, existing
Main CI job `131841865959`, завершился четырьмя blocking lint errors.
Это source gate, не результат native execution; прежние provider receipts
и незакрытая Windows Team integration не меняют статус.

**Круг 1 — точные причины.** В
`src/features/agent-backend/main/composition/DesktopBackendFeature.ts`
(blob `341f6a7e9307620f4f7868b9b2ed6ae86f6a8ed8`) existing closeNativeOwners
передаёт Promise.all union Promise<boolean> | true, запрещённый
@typescript-eslint/await-thenable. В
`src/features/agent-backend/main/infrastructure/CapturedHostClient.ts`
(blob `a987c4ec992bd8da5a1a7557991b2eca4a4f0954`) три NativeRequest optional
fields одновременно используют ? и | undefined, запрещённые
sonarjs/no-redundant-optional. Main tsconfig и feature test tsconfig не
включают exactOptionalPropertyTypes; это не Host package interface.

**Круг 2 — минимальные изменения.** Только fallback отсутствующего
nativeCustody заменить на Promise.resolve(true), сохранив тот же
параллельный close, same results.some и hold. У timer, reply и admittedHint
удалить избыточное | undefined, сохранив optional fields и все присваивания,
deadlines, transport, control reserve и wire schemas. Ни blanket lint fix,
ни подавления rule, ни новых unit tests. Проверить diff этих двух paths
и отсутствие пересечения с §52 implementation.

**Круг 3 — независимая проверка.** Root публикует этот plan до source.
Peer сверяет unchanged runtime semantics и actual relevant tsconfigs.
Следующий обычный exact-head lint/features и types должен подтвердить
исправление; пока новых execution результатов нет. Отдельный старый
qualification job `131794213135` падает на SchedulerStopBarrier nested
assignment: это уже исправлено в parent d35 и переносится штатным parent
sync, без второго source edit.


## 53. Linux CDP: уточнить конкретный original Node child перед product fix

### Круг 1 — уже наблюдённое и оставшаяся неопределённость

Actual native `79847dee72c5ed1c08914a44409f76c0dd25d168` artifact
`14026961740` (ZIP SHA256
`3c200d9f7e9fd34bc8e73912d751c6fc5e91e13c1171b52e0f82c5d52616721e`)
связывает исходный Electron Main5154 и direct Node5245 с одним socket
inode22591/FD60, non-CLOEXEC, при стабильном process birth до/после.
Node executable совпал с fixture, полный Host argv **не** совпал.
Поэтому считать этот PID captured Host нельзя. App.log сообщает о dev MCP
build, но сам по себе не связывает build с PID5245. Более новый689 artifact
`14028911546` пока не разобран: нельзя переименовать его failure в ту же причину.

Exact [WorkspaceMcpBundle](https://github.com/777genius/agent-teams-ai/blob/689dddb61cedf0649379975735bac162c87c2836/src/main/services/team/WorkspaceMcpBundle.ts)
(blob `37b559838b774022fb5bd94400a55ee590b5a67d`) действительно запускает
selected Node с canonical `mcp-server/node_modules/tsup/dist/cli-default.js`,
`--out-dir` и новой output directory. Пока это только проверяемый кандидат.
Public libuv uv_disable_stdio_inheritance является best-effort: exact Node
24.22.1 implementation останавливает scan при первой дыре FD>15; это не
гарантия для observed FD60. CDP pipe также не доказывает isolation, поэтому
ни один такой вариант сейчас не выбран исправлением.

### Круг 2 — минимальная diagnostic delta в существующей попытке

1. Только source/Linux harness до original Electron launch один раз сохранить
   canonical path фиксированного tsup entry из того же repository. При
   недоступном path diagnostic остаётся unavailable; production launch и
   initial assertions не меняются. Packed scope не получает этого expectation.
2. В существующую однократную after-failed-census correlation добавить
   `fixtureMcpBuilderEntry: boolean | null`. Использовать уже прочитанный
   bounded NUL argv: exact selected Node + exact captured builder entry,
   единственный --out-dir и один непустой output argument, без вывода strings.
   Это совпадение declared entry/invocation shape, не attestation output path,
   JS bytes или execution purpose. Все original birth/socket checks, max16,
   fdinfo bounds и immutable failed census остаются прежними.
3. В existing smoke catch вывести ту же закрытую cdpListenerFailure projection
   один раз в existing CI log с fixed TEST prefix и cap32KiB. Receipt остаётся
   исходным носителем тех же facts. Никакого нового census/RPC/input/signal,
   чтения дополнительных process paths или workflow/artifact/job/runner.
4. В одном existing critical observation case добавить builder и иной argv
   рядом с прежними Host/executable/reused-birth/changed-socket assertions.
   Retained holderCount2 по-прежнему является failure; raw path/argv markers
   по-прежнему отсутствуют, lookup не повторяет read. Новой suite нет.

Declared paths: desktop-backend-observations.ts, desktop-backend-smoke.ts и
desktop-backend-observations.test.ts. Root публикует plan до этих TEST edits;
peer проверяет bounded source и неизменный original strict admission.

### Круг 3 — решение по exact evidence

Следующий уже необходимый native Linux gate даст факт builder match, другой
child либо unknown в доступном original log. После actual exact match
исправлять его настоящий launch boundary, с сохранением selected Node/entry,
stdio/control/custody; заранее не добавлять глобальное закрытие descriptors,
native/shell wrapper или hidden mutation. Даже если builder подтвердится,
поздний captured Host launch проверяется отдельно: prebuild сам по себе
не устраняет общую наследуемость descriptor. Final Linux acceptance требует
полного cold UI и packed journey с исходным strict listener guard,
native inputs, Stop/Quit и cleanup. Эта диагностическая правка не PASS и не
закрытие Linux. Новые source bytes не исполнялись в недоступной local среде.

### Уточнение §44: единая типизация пустой очереди HostOutput — actual CI 689 (2026-11-13)

- Actual [Main CI 689, validate step14](https://github.com/777genius/agent-teams-ai/actions/runs/43407471337/job/131841866561) завершился с двумя TS2322 в `packages/legacy-agent-host/src/output.ts:124,131`: исходный `frame` выведен как `Buffer`, тогда как существующие `encode()` и `data.shift()` возвращают также `undefined`. Отдельные Host build/test types этой межпроектной типовой проверки не заменяют.
- Минимальный source cut — одна явная аннотация `let frame: Buffer | undefined` на исходном извлечении priority entry ([точный source dd1ee0ca](https://github.com/777genius/agent-teams-ai/blob/689dddb61cedf0649379975735bac162c87c2836/packages/legacy-agent-host/src/output.ts#L118-L134)). Порядок control/work/data, byte accounting, callback, budget, существующая проверка `if (!frame) return` и все runtime ветки сохраняются. Новая suite не нужна; проверка — исходный root TypeScript closure при следующем необходимом coherent head. Этот type-only fix не означает PASS нового native gate.

## 54. Естественное завершение Windows service: исходная registration receipt и lifecycle preflight (план, 2026-11-13)

### Круг 1 — подтверждённый разрыв и граница исправления

Source base — native working [a3e57fb](https://github.com/777genius/agent-teams-ai/tree/a3e57fb61e13e7f7dead9eec10c105f73f1aabe4), содержащий опубликованный §52. В [TeamProcessCommands](https://github.com/777genius/agent-teams-ai/blob/a3e57fb61e13e7f7dead9eec10c105f73f1aabe4/packages/legacy-agent-host/src/process/TeamProcessCommands.ts#L99-L109) синхронная durable absence выводится только из completed `terminate` receipt. [Windows async list](https://github.com/777genius/agent-teams-ai/blob/a3e57fb61e13e7f7dead9eec10c105f73f1aabe4/packages/legacy-agent-host/src/process/WindowsTeamProcessCommands.ts#L264-L290) уже может показать настоящее `absent` и выключить Stop, но это наблюдение не сохраняется. Поэтому естественно завершившийся v5 service остаётся `unknown` для [assertReleased](https://github.com/777genius/agent-teams-ai/blob/a3e57fb61e13e7f7dead9eec10c105f73f1aabe4/packages/legacy-agent-host/src/process/TeamProcessCommands.ts#L240-L256), и lifecycle может оставаться held.

[OwnerScopedTeamPurge.admission](https://github.com/777genius/agent-teams-ai/blob/a3e57fb61e13e7f7dead9eec10c105f73f1aabe4/packages/legacy-agent-host/src/adapters/lifecycle/OwnerScopedTeamPurge.ts#L28-L55) выполняет окончательную проверку references под синхронным Team fence, включая повторную проверку внутри destructive boundary. Native await туда не помещается. Исправление добавляет private async preflight до этой границы и сохраняет окончательные синхронные проверки. Открывать Processes до удаления, нажимать фиктивный Stop или создавать новый process command не требуется.

### Круг 2 — минимальное изменение в тех же владельцах

1. **Доказательство хранится в исходной регистрации.** Добавить необязательное строгое `nativeAbsence` только в structurally validated completed `register` receipt с v5 capture, originalRegistration и настоящим original capture intent. Поле содержит fixed schema/kind, digest полного canonical capture, один из существующих evidence kinds `native-scope | retained-terminal | original-whole-job` и закрытое состояние собственного settlement. `operation: register`, principal, commandId, requestDigest, authorityRevision, original registration input, capture и состояние `completed/not-requested` сохраняются. Это факт наблюдения, а не новый Human Stop. Поле входит в существующий fingerprint только при наличии; bytes/hash старых receipts без поля не меняются.

2. **Факт допускается только от исходного Main.** Existing `WindowsRegisteredProcessPort.query` должен вернуть validated `observed/absent` для точно того же полного v5 capture в исходном deadline. [RetainedWindowsServices](https://github.com/777genius/agent-teams-ai/blob/a3e57fb61e13e7f7dead9eec10c105f73f1aabe4/packages/legacy-agent-host/src/owned-process/RetainedWindowsServices.ts#L81-L103) уже связывает scope с original Main epoch, provider capability/generation/root, target key/birth/PID и registrar; native absence требует original root exit вместе с Job activeProcesses=0, либо ранее сохранённый terminal/тот же genuine whole-Job proof. `EOF`, один rootExit, missing scope, PID lookup, metadata stoppedAt, no-local-dispatch или чужой whole-Job receipt фактом не становятся. Неподдержанный/утраченный original owner сохраняет hold.

3. **Private reconciliation под текущим Team admin.** Расширить существующий Windows facet одним private `reconcileNaturalAbsence(originalDeadline)`, используемым lifecycle composition. Он сканирует уже существующие validated process receipts/rows того же binding, включая исходные регистрации других principals, как это уже делает admin `assertReleased`. Public `readReceipt/lookup` с проверкой principalId не ослабляется. Не подставлять principal регистрации в новые grants и не требовать живой MCP input от cleanup давно завершившегося Runtime. Подходящий original completed register выбирается только по полной captured identity. Неизвестная незавершённая registration не превращается в completed по одному PID.

4. **Await остаётся за fence.** В исходном Team fence проверить read+admin, current writer/profile, binding, исходную receipt и полную capture; взять неизменяемый снимок. Query выполняется снаружи. После await отдельно проверить полный current guard, затем снова под Team fence перечитать grant, original receipt/capture и текущие receipts/rows. Только совпадающий, своевременный `observed/absent` позволяет сохранить факт. Source/grant/epoch change либо истечение исходного deadline перед новой записью оставляют исходную custody/evidence удержанной; catch не превращает такой отказ в разрешение продолжить mutation. Повторный capture, fresh PID selector и replay native effects отсутствуют.

5. **Одна physical scope, несколько прежних регистраций.** Уже сохранённый natural-absence anchor для exact full capture выбирается прежде новой записи. Если его ещё нет, выбрать один completed original register детерминированно под тем же fence и сохранить факт до любого settle await; последующие calls находят этот anchor в существующем journal. Новая metadata registration или unregister не удаляет его. Несогласованные дубликаты/разные capture держат hold. Все строки/receipts того же full capture используют этот факт, без нового owner map, lease counter или parallel journal. Existing genuine completed Stop absence остаётся отдельным уже поддержанным путём; естественное завершение не создаёт второй Stop/settle для него.

6. **Settlement не уничтожает неизвестные original requests.** Перед mint/dispatch и после await проверить отсутствие unresolved `terminate` для exact full capture; такие receipts удерживают cleanup и остаются доступны своим прежним original lookup. Не помечать их завершёнными от имени нового lifecycle command. После durable natural absence pure `prepareControl(capture, 'settle')` сохраняется в существующем `nativeSettlement` этого же original register до первого run. Последующее восстановление использует только исходный operationRef/lookup. Full-capture `settled` допускает пометку завершённого settlement; это не Stop и не signal. Registered scope/исходные Main pending refs и лимиты retention сохраняются до настоящей native settlement/debt qualification.

7. **Неизвестность и доказанный no-dispatch различаются.** Закрытое состояние natural settlement различает ещё не подготовленный intent, requested/unknown, подтверждённый no-dispatch и подтверждённый settled. Unknown/lost ACK удерживает тот же intent и допускает только original lookup. Genuine typed no-dispatch сохраняется с исходным intent; в этом call автоматического повтора нет. Только последующий явный lifecycle preflight может заменить такой доказанно не исполнявшийся settlement intent новым для той же immutable capture, после повторных current/admin/debt checks и в собственном исходном budget. Ни query refusal, ни timeout/transport error не дают этого разрешения. Это не позволяет навечно превратить pre-admission pressure в cleanup unknown и не переигрывает dispatched uncertainty.

8. **Синхронный читатель получает только durable truth.** Existing sync `observeOriginal` может считать v5 absent по проверенному `nativeAbsence` с тем же full-capture digest. `assertReleased` для этого нового natural пути дополнительно требует подтверждённый settlement и отсутствие unresolved original receipts. При pending settlement Processes может честно показывать absent/Stop disabled, но destructive lifecycle остаётся held. Совершённый original Stop и POSIX версии 1–4 сохраняют прежние правила. Новые private fields не проходят explicit Desktop/MCP projection. Terminal fact не зависит от дальнейшей доступности закрытого HANDLE; он не даёт права захватить новый процесс.

9. **Lifecycle работает без предшествующего UI polling.** Перед ещё не пересечённой destructive boundary existing `OwnerScopedTeamPurge.purge` повторно использует собственную admission-проверку actor/binding/expectedRevision/deleted/cleanupPending и завершённости command receipts, пока без финального references assertion. Затем через optional private hook в `createTeamBackupComposition`/`createHostTeamLifecycleComposition` вызывает этот same-owner reconciliation вне Team fence. После await остаются прежние full admission и повторная atomic boundary validation. Уже `deleting/deleted` original intent продолжает прежний захваченный путь без нового query/adoption. Deadline preflight начинается при входе в исходный purge call, до lookup/initialization/admission, ограничен прежними 10 s process facet и не обновляется для query/settle/lookup; concurrency native queries не выше прежних 3. Очереди, Main controls reserve и physical capacities не увеличиваются. Наличие нового live capture после preflight приводит к отказу final sync admission.

10. **Source closure и разумный размер.** Плановый bounded cut: `process/registeredProcessContracts.ts`, `validateProcessRecords.ts`, `WindowsTeamProcessCommands.ts`, `TeamProcessCommands.ts`; `composition/createHostTeamLifecycleComposition.ts`, `createTeamBackupComposition.ts`, `TeamHost.ts`; `adapters/lifecycle/OwnerScopedTeamPurge.ts`. Используется уже существующий global retained Windows port, без `prepareCapture` authority. TeamOwner (800 lines), Runtime conversation restore, новые provider flags, named Jobs и OS PID adoption не меняются. Если helper выходит за cap, сначала отдельная обоснованная extraction, не сжатие форматирования.

### Круг 3 — проверка исходного дефекта и честная приёмка

- Расширить существующие `registered-process-commands.test.ts` и `lifecycle-process-release.test.ts`: completed original registration другого principal; естественное exact-scope absence; admin purge/preflight **без прежнего list/Stop**; durable fact + exact settled readback после пересоздания Host-side journal. Fake/synthetic primitive в этих случаях явно остаётся synthetic, не OS qualification.
- Critical branches в тех же cases: reused PID/другая capture не получают absence; unresolved Stop удерживает settle; после source/grant change и deadline нет новой записи; lost settlement ACK не создаёт новый intent, original late result завершает только его; genuine pre-admission no-dispatch разрешает только следующий явный preflight, а unknown — нет. Legacy fingerprint без поля и public cross-principal lookup refusal должны сохраниться.
- После source/build/types и этих focused tests требуется существующий staged Windows gate: настоящий service естественно завершился, original provider и соседний service живы; original native query подтверждает full-scope absence, scoped settle освобождает только эту registration; повторный Host/read/lifecycle использует сохранённый факт без native Stop/PID reselection. Остальные original processes завершаются прежним Main cleanup. Новый runner, hidden replay и увеличение timers не нужны.
- Пока actual Main ordinary-Claude/service-registration gate не завершён, этот cut не объявляет Windows full parity или cold Runtime conversation restore. Ранее опубликованный §52 source peer PASS не становится исполнением §54; production activation по-прежнему ограничена уже согласованными фактическими gates.

## 55. Actual Windows Team MCP registration и natural service retirement в существующем native gate (план)

Source comparison: [nativeRetainedHostGate08848](https://github.com/777genius/agent-teams-ai/blob/388ace1f854016ca1a3d1a57195d23cb89f70c54/tools/owned-process-broker/nativeRetainedHostGate.ts) запускает обычный Claude через Main/Host, но pins schema1, использует `NATIVE_TEAM_TWO` и честно публикует `registryQualified:false`. Direct vendor gate не закрывает Team MCP/journal. [Existing startProcessModel](https://github.com/777genius/agent-teams-ai/blob/388ace1f854016ca1a3d1a57195d23cb89f70c54/scripts/legacy-agent-host/desktop-native-process-model.ts#L118-L134) уже содержит конечные 2 actual Bash background calls → advertised `process_register` → terminal response и привязывает последующие notifications к исходным native task/tool IDs. Это существующий oracle для reuse.

### Круг 1 — один дополнительный режим того же Windows gate

- Добавить явный TEST mode `natural-services` в existing `nativeRetainedHostGate`, сохранив неизменными `graceful/crash` и их schema1 requirements. В том же existing Windows x64/ARM job штатный builder отдельно stages non-TEST product target с явным `service-scopes-v1`; только новый режим получает hash-checked schema2 reference и capability. Нет TEST FD4/debug flag в product target, нет автоматического upgrade старых references.
- Новый режим использует тот же original CapturedHostClient ↔ TeamHost ↔ ordinary Claude provider ↔ Main retained broker. В его TEST team дать native member исходный `process.write` grant до launch; Human остаётся admin. Отправляется один явный `PROCESS_BOOTSTRAP` через обычный `team.execute`; broker/service capture никогда не вызывается вместо MCP registration из теста.
- Reuse `startProcessModel` с узкой explicit Windows projection option. Его default Linux/Darwin assertions не меняются. Новый режим требует completed registration + original processRef, а исходный v5 result честно `unknown/canTerminate:false`: §52 sync snapshot не выдаётся за свежий native query. Затем actual public `team.process.list` должен дать `same-live/canTerminate:true` для original primary; private captured receipt подтверждает original native intent/full v5 capture, а не metadata-only register.
- Те же два foreground HTTP actors запускает actual native Bash; helper seed/copy/hash находятся только внутри original controller sandbox. Для нового режима primary получает explicit TEST-only completion rule: после одного GET на свой исходный nonce endpoint сервер отдаёт ответ и нормально закрывается (`natural-request`, exit0). Default 300000 ms TTL и прежний actor mode сохраняются; нет SIGTERM/Terminate/Stop или private release-файла для primary. Completion oracle принимает этот новый fixed reason только в explicit mode и сохраняет strict original task/tool/status binding.

### Круг 2 — физические факты и lifecycle не смешиваются

1. Independent queryable witnesses удерживают original primary/provider HANDLEs по уже полученным original native births до natural completion; numeric PID не становится новой product authority. Neighbor не имеет зарегистрированного v5 birth: его живость подтверждает ответ на exact original nonce HTTP endpoint с теми же pid/port из исходного native background task, без утверждения independent HANDLE proof и без нового capture. После первичного ответа/нормального закрытия primary: его original HANDLE absent, actual public list показывает absent/Stop disabled, original provider HANDLE ещё alive, соседний service отвечает на свой исходный nonce. Для primary/provider используются прежние zero-time HANDLE observations/own scope query; no kill/root-as-service substitution. Никакие дополнительные native witness modes или новые product selectors ради этого oracle не вводятся.
2. Native background completion остаётся notification исходного task, без нового human input/Bash/registration. Oracle остаётся конечным: исходные 4 scripted responses, максимум по одному exact completion notice для каждого original background task; нет повтора после первой ошибки. Unexpected task/status/extra inference сохраняет FAIL, не переписывается в ожидаемый успех. Для normal primary ожидается actual exit0, для последующего whole-Team cleanup не выводить status по предположению: если native notification успел прийти, подтвердить его исходным retained cleanup fact и exact task identity.
3. После natural primary proof выполнить обычный Human Trash через существующий lifecycle route; это законный whole-Team Runtime cleanup. Дождаться original Host shutdown и его настоящего child exit. Затем создать один новый `CapturedHostClient` с тем же captured profile/source и тем же живым original Main owner. В этой второй epoch не вызывать `runtime.open`, не отправлять native input и не выбирать новый PID. Main retains original released allocation/scope, пока original service registration ещё не settled; новая epoch использует только существующие query/control по original full capture. Late replies старой epoch не завершают новые calls.
4. Во второй epoch вызвать обычный explicit Human purge с исходным Team binding/expectedRevision; §54 preflight должен получить original retained native absence и подтвердить original settlement до существующего final admission. Успех actual purge, отсутствие второго capture/native input/process terminate и точные scope/control receipts проверяются существующими real methods/owner observation. Не вводить TEST RPC, monkeypatch `TeamOwnerStore.write`, pause boundary или новый журнал ради съёма внутренних bytes. Existing §54 cold journal cases отдельно доказывают optional fields/fingerprint/settlement persistence; native gate заявляет actual same-Main lifecycle restart/purge admission, а не самостоятельный raw-byte oracle. `register` не переименовывается в Stop, отсутствие primary не выводится из общего cleanup.
5. Живость provider/neighbor заявляется **до Trash**. После legitimate whole-Team cleanup проверяются original absence и genuine release; lifecycle settlement не называется scoped Stop при живом соседнем service. Original unrelated sentinel переживает весь Main cleanup. Existing root witness and source-refusal cleanup assertions сохраняются в прежних режимах; новое успешное receipt не меняет `sdkColdConversationQualified/desktopQualified/releaseQualified` на true без их собственных gates.

### Круг 3 — bounded source и приёмка

Planned TEST closure: existing `tools/owned-process-broker/nativeRetainedHostGate.ts`; один directly consumed scenario helper `tools/owned-process-broker/nativeRetainedServiceScenario.ts` для этой конечной registration/lifecycle sequence, чтобы не превысить source cap; existing `scripts/legacy-agent-host/desktop-native-process-model.ts`, `scripts/legacy-agent-host/fixtures/process-foreground-service.ts`; existing `.github/workflows/sentry-owned-process-native.yml`. Новая ветка может прочитать существующую original registration receipt до purge для сверки source/capture/command identity; after-deletion durable field проверяется focused cold journal case, без подмены его actual native результатом.

Сохраняются existing startup10 s, request45 s, native turn35 s, process10 s, original outer-controller deadline, cleanup/witness bounds и matrix. Дополнительный режим имеет собственный original controller sandbox и не продлевает исходные `graceful/crash` attempts. Stage/type/source closures проверяются на exact next coherent head; actual Windows compiler/ordinary SDK/Team MCP/natural exit обязательны. При любом неизвестном route, notification, registry, source/current или cleanup outcome receipt остаётся INCOMPLETE. Это не исправляет gate путём ослабления production guard и не активирует новую capability для обычного пользователя.


### 55.1. Existing TEST envelope closure — source-localized refusal before native allocation

Exact native689 tree retains `teamHostEnvelope.ts` blob `402b4c951efe6a59fef747eb237642815facfdbf` and TeamHost `55dcdf13faab787310e4e5c2a718bad5c38a6290`: `runtime.open/read` and `team.execute` use the strict existing envelope with `binding.schemaVersion:1` and `binding.handleId`. Existing TEST gate `945eb8f7d37b4500a4f3b0e6c06ea5db1961afbb` (current diagnostic successor `08848f9054aece875763c910276011683c9e1b9a`) omits both fields and sends only `owner/scope`. The parser therefore refuses that TEST request before Runtime/native admission. This is a verified source defect consistent with the existing zero-attempt evidence; the corrected actual Windows outcome remains pending.

Within the same declared gate file, add the two required fixed TEST binding fields to its existing envelope; keep the original owner, scope, command IDs, payloads, deadlines, failure projection and native assertions. The new natural-services helper uses that same complete public envelope. No production parser change, alternate route, native guard relaxation, request replay, or implicit capability activation is authorized by this correction. Default graceful/crash still require schema1 broker selection and their original physical facts.

### 55.2. Exact 2227 Linux ABI preflight: await the existing asynchronous MCP catalog

[Native run 43429091215, Linux ABI job 131897760976](https://github.com/777genius/agent-teams-ai/actions/runs/43429091215/job/131897760976) at exact `2227a997542fd603aab2bc8410433dacfa4e83a8` completed the Host build and scripts typecheck, then failed one of 29 existing tests (28 PASS). The first failing assertion path is `registered-process-owner.test.ts:149`: its synchronous `tools.call('process_register', ...)` is rejected as `MCP operation unsupported`. The actual ABI/native step was skipped; this result is not an ABI failure or a Windows/native qualification.

The §52 catalog intentionally marks the five process tools asynchronous; `mcp/tools.ts` refuses them in `call` and awaits the original invocation in `callAsync`. Correct only the existing catalog test in `packages/legacy-agent-host/tests/registered-process-owner.test.ts`: make its callback async and await the original register, metadata-stop and unregister through `callAsync`. Preserve command IDs, payloads, catalog exclusions, private-token projection, registry/history assertions and exact zero OS-signal count. No production schema/guard, native authority, deadline, CI matrix, test count or retry changes. Re-execute the same existing ABI-preflight test selection locally, retaining the actual current run and waiting for its remaining native jobs normally.

### 55.3. Exact 2227 Windows preflight: keep the Main scenario in its existing type project

[Windows x64 job 131897760826](https://github.com/777genius/agent-teams-ai/actions/runs/43429091215/job/131897760826) at exact `2227a997542fd603aab2bc8410433dacfa4e83a8` passed the Host build and stopped in the first step8 command, `tsc --noEmit -p tools/owned-process-broker/tsconfig.json`. Its `*.ts` include takes the new `nativeRetainedServiceScenario.ts` as a protocol-project root, while only the original `nativeRetainedHostGate.ts` is excluded. The helper's Main type import therefore brings Main sources into the separate protocol-only options, producing 17 diagnostics (unchecked-index/union errors and absent React namespace). Native compilation and provider/ordinary Main/service gates did not execute on this job.

Classify the helper with the same original Main gate: add its exact basename to the protocol project's existing exclude, and explicitly include it alongside the gate in `tsconfig.retained-host.json`. Keep every compiler option, protocol source include, workflow command and both mandatory typechecks unchanged. The retained-host project already reaches the helper transitively; local `--listFilesOnly` confirms the helper, gate and CapturedHostClient are checked there. Record that same closure after the correction, run both existing typechecks and the existing protocol suite. This adds no source suppression, runtime change, new test/matrix, budget or native qualification; the current run remains untouched.


## 56. Actual Windows public Processes: scoped Stop and live same-Main Host rebind — plan before source

### Круг 1 — граница недостающего доказательства и исходные API

На exact live `2227a997542fd603aab2bc8410433dacfa4e83a8` native run `43429091215` завершился до actual Windows scenarios: обе Windows job остановились на §55.3 type-project closure, обе Linux job — на §55.2 async MCP test. Working `c0f708abb5a1e62d22c3f6add873a70f26aaa348` содержит опубликованные узкие исправления; local 29 existing process tests, 49 protocol/events tests и оба existing Windows type projects PASS не являются actual ordinary Windows qualification. Другие live 2227 workflows продолжаются штатно; ни отмена, ни rerun этим планом не разрешаются.

§55 `natural-services` доказывает другой переход: normal primary exit, provider/neighbor alive до Trash, затем genuine whole-Team cleanup и same-Main cold purge. Он не доказывает selected public Stop при живом соседнем service либо cold Stop ещё живого original scope. Existing direct vendor/debug-broker PASS также не покрывает обычные Team MCP / public Processes routes. Добавить один explicit `scoped-services` TEST mode в существующий retained-Host gate, последовательно покрывающий оба оставшихся перехода. Существующие `graceful`, `crash`, `natural-services` сохраняют свои режимы, assertions и claims.

Source anchors на exact working c0f:
- [Existing retained Host gate](https://github.com/777genius/agent-teams-ai/blob/c0f708abb5a1e62d22c3f6add873a70f26aaa348/tools/owned-process-broker/nativeRetainedHostGate.ts): ordinary Claude runtime/open/input, original staged selection, Main owner, TEST crash marker, native witness и independent controller cleanup.
- [Existing service scenario](https://github.com/777genius/agent-teams-ai/blob/c0f708abb5a1e62d22c3f6add873a70f26aaa348/tools/owned-process-broker/nativeRetainedServiceScenario.ts) и [finite process model](https://github.com/777genius/agent-teams-ai/blob/c0f708abb5a1e62d22c3f6add873a70f26aaa348/scripts/legacy-agent-host/desktop-native-process-model.ts): два original background tasks, actual MCP registration, strict command/receipt, same-Main successor, exact task-notification wrapper.
- [Public process methods](https://github.com/777genius/agent-teams-ai/blob/c0f708abb5a1e62d22c3f6add873a70f26aaa348/packages/legacy-agent-host/src/process/createTeamProcessMethods.ts) и [Windows command journal](https://github.com/777genius/agent-teams-ai/blob/c0f708abb5a1e62d22c3f6add873a70f26aaa348/packages/legacy-agent-host/src/process/WindowsTeamProcessCommands.ts): `team.process.list/terminate/lookup`, original 10 s operation deadline, full `processRef`, Human admin, persisted original Stop intent, native await outside the fence, same-capture completed absence and settlement.
- [Host service port](https://github.com/777genius/agent-teams-ai/blob/c0f708abb5a1e62d22c3f6add873a70f26aaa348/packages/legacy-agent-host/src/owned-process/HostWindowsServices.ts) и [original Main owner](https://github.com/777genius/agent-teams-ai/blob/c0f708abb5a1e62d22c3f6add873a70f26aaa348/packages/legacy-agent-host/src/owned-process/RetainedWindowsCustody.ts): old serialized intent имеет lookup-only semantics; новый explicit Human Stop может mint original control intent только из полного retained capture; attach B требует same Main/profile digest и actual old attachment abort+exit. Service query/Stop/settle являются existing cleanup operations, не требуют старого SDK iterator.

### Круг 2 — original authority, physical facts и последовательность

1. **Один исходный provider и два actual registered services.** Только новый explicit mode выбирает существующий schema2 `service-scopes-v1` staged product artifact и original `alice-session/process.write` grant до первого launch. Default schema1 selections не меняются. Один ordinary Claude `runtime.open` и один original `team.execute/message.send` запускают существующие primary/neighbor background tasks. Actor остаётся прежним: тот же 300000 ms TTL, без `primaryCompletion:'natural-request'`, без новых сигналов, listener modes или resource limits.
2. Сохранить четыре original model rounds. В step2 новый mode выдаёт ровно два индексированных MCP `process_register` tool blocks с разными фиксированными tool-use/command IDs и original primary/neighbor PID/nonce/port/url/label. Это требует узкой явной ветки существующего one-block emitter; существующие single-register modes не меняются. Step3 проверяет оба exact tool-use IDs, оба completed register receipts, разные `processRef`, conservative `unknown/canTerminate:false`, отсутствие лишнего/повторного результата. Не полагаться на `results.at(-1)` или порядок завершения параллельных MCP calls. Actual SDK исполнение двух blocks остаётся обязательным native gate, а не предположением.
3. Existing Main port observer сохраняет **до ACK** оба original capture intents и полные v5 captures. Каждый связывается с original allocation capability/generation/root, same Main epoch/profile/source, original registrar и своим original service PID. Exactly two successful captures относятся к epoch A; subsequent operations сопоставляются по полному capture/key/birth, а не по PID. Из каждого successful native capture один раз открыть существующий independent TEST queryable witness на exact PID+birth, удержать его исходный HANDLE; это oracle, не product admission authority. Read-only original registration receipts должны совпасть с retained captures/intents/registrar и public processRefs.
4. Fresh public `team.process.list` на том же original binding показывает оба original processRefs как `same-live/canTerminate:true`. Первый public Human `team.process.terminate` вызывается ровно один раз с original primary processRef и новым фиксированным Human commandId. Перед первым await production journal обязан удерживать свой original intent; observer сверяет original service-stop capture и последующее настоящее `stopped/absent` evidence. Public receipt должен закончить `operation:terminate, state.phase:completed, state.native:observed-absent` на том же commandId/full capture. Windows `signalAccepted:'unknown'` не заменять вымышленным `true`.
5. **Warm selected Stop при живых provider и neighbor.** Original primary HANDLE после этого Stop — absent, neighbor HANDLE — alive, provider root HANDLE — alive. Fresh public list сохраняет primary identity с absent/canTerminate:false и neighbor с same-live/canTerminate:true. До этого checkpoint нет whole-provider Stop/release, Trash, Main.close или смены Host. Original unrelated sentinel жив. Только такой checkpoint разрешает claim `warmPublicScopedStopQualified`.
6. **Утрата A с сохранением исходного Main.** После terminal bootstrap и принятого warm-primary notification использовать существующий TEST wrapper marker: original CLI сам завершается кодом91. Дождаться actual original Host exit и existing client seal/disposal; graceful shutdown до crash не использовать, поскольку он меняет исследуемый lifetime. Удалить только этот одноразовый TEST crash marker после подтверждённого выхода A и до B; executable/hostEntry/profile/source bytes остаются исходными. Не создавать новую native allocation и не применять PID kill/reopen. Fresh provider HANDLE observation после actual A exit должна оставаться alive.
7. Создать ровно один новый `CapturedHostClient` на том же live physical Main, profile, storage, captured sources и broker selection; новый Host получает собственную epoch/writer только после old abort+exit. Через обычный public `team.process.list` B прочитать original neighbor processRef как same-live/canTerminate:true и primary как original absent row. Fresh neighbor HANDLE подтверждает alive после этого cold query. Нет `runtime.open`, нового message/input, launch/resume/write/end, service-capture или повторного register; отдельный TEST counter проверяет попытки, а не только successful replies.
8. **Cold explicit scoped Stop.** Через B один раз вызвать public Human `team.process.terminate` с original neighbor processRef и отдельным фиксированным Human commandId. Это новое явно запрошенное control действие над прежним capture; оно не является replay старого command или новым capture по PID. Observer требует полный исходный neighbor capture и original Stop intent перед ACK; public completed/observed-absent receipt и actual neighbor HANDLE absent должны совпасть. Provider HANDLE остаётся alive после cold Stop. Только после этих фактов разрешается `sameMainColdPublicStopQualified`; отсутствие scope, transport EOF, timeout либо rootExit без scope evidence оставляет INCOMPLETE.
9. Для обоих Stop разрешён лишь existing read-only `team.process.lookup` по тому же original Human commandId, если первый результат ещё requested, внутри того же original 10 s phase deadline. Никаких повторных terminate, новых effect IDs или бюджетов после unknown. Capture/Stop/settle observers сверяют original command/capture joins; settled scope не превращает новый PID lookup в recovery. Public lookup остаётся principal-bound.
10. После cold checkpoint B закрывается через existing client shutdown; original Main.close должен подтвердить своё cleanup, original provider HANDLE стать absent, все original witnesses drained, unrelated sentinel оставаться alive. До этого cleanup оба scoped Stop доказаны отдельно от whole-Job termination. Existing finally сохраняет initial failure, original Main pending/handles и independent controller Job cleanup; отсутствие semantic success не мешает настоящему original cleanup.

### Круг 3 — конечный oracle, нагрузка и точный source scope

**HANDLE query budget остаётся прежним: максимум четыре Q на каждый original witness, затем прежний W/drain.** Primary: alive перед warm Stop, absent после него (2). Neighbor: alive до warm Stop, alive после warm Stop, alive после cold B query, absent после cold Stop (4). Provider: alive после warm Stop, alive после actual A exit, alive после cold Stop, absent после Main.close (4). Не добавлять hidden polls, повторное открытие HANDLE, inferred `alive` fields или увеличение native query mode. Новый receipt именует эти реальные phase-specific checks, не подменяет immediate-after-input и after-host-loss measurements старых режимов.

**SDK notifications.** Для warm primary требуется завершённый acknowledgement исходного background task перед crash A. Дополнительное cold-neighbor notification возможно только от того же original provider, но не является условием доказательства нового SDK conversation: SDK iterator старого Host не восстанавливается. Любой допущенный notification должен иметь exact original taskId/toolUseId/outputFile wrapper и не повторяться; всего ≤2. Для forced Windows Stop normal closing/closed actor events не фабрикуются: допускается только честный bounded original listening/lifecycle prefix вместе с genuine same-role/full-capture public Stop evidence. Callback ожидания original Stop факта находится вне Stop implementation, поэтому public Stop не ждёт model reply и не образует deadlock. Нельзя использовать `originalWholeCleanup` как доказательство scoped Stop или принимать произвольный failed notification без исходного scope. Не наблюдённый cold notification не объявляется доставленным.

**Exactly four existing TEST files:** `tools/owned-process-broker/nativeRetainedHostGate.ts`, `tools/owned-process-broker/nativeRetainedServiceScenario.ts`, `scripts/legacy-agent-host/desktop-native-process-model.ts`, `.github/workflows/sentry-owned-process-native.yml`. Scenario helper прямо используется original gate; новый orchestration module/owner, product API, journal, C mode, native witness type, test suite, actor change и capability auto-activation не нужны. Исходники остаются в прежних file-size caps; mechanical extraction допускается только отдельным review, а не форматным сжатием.

В существующем Windows job добавить mode `scoped-services` рядом с existing `natural-services`, с отдельным original controller sandbox/receipt и тем же explicit schema2 stage. Одна дополнительная invocation покрывает **оба** public Stop перехода; нет новой matrix/job/runner или отдельного provider для каждого Stop. Оба x64/ARM64 должны пройти actual staged product/ordinary SDK/Team/public route. Сохранить startup10 s, request45 s, native turn35 s, per-process10 s, original Host-exit5 s, witness/drain limits, controller120 s и whole-job30 min; очереди и ожидание двух register blocks входят в исходный deadline. Не продлевать исходный controller attempt, не сбрасывать phase deadline при lookup и не увеличивать TTL.

Приёмка exact next coherent head: existing Host build/type projects, scripts/protocol typecheck и targeted lint/source cap; existing protocol/tests только по затронутому риску; затем actual Windows native receipt со strict finite phase facts, exactly one allocation/prepare/resume, exactly two original captures, exactly two scoped Stop effects (primary A / neighbor B), same Main epoch, two observed Host incarnations, no B input/capture/launch and confirmed original cleanup. Любой extra effect, source/grant mismatch, unknown receipt/settlement либо invalid notification оставляет INCOMPLETE и сохраняет initial failure. `sdkColdConversationQualified`, `desktopQualified`, general provider/platform parity и `releaseQualified` остаются false: этот gate проверяет ordinary Team/public Processes contracts, а renderer clicks и packaged UI требуют своего existing acceptance. Никаких положительных native claims до actual receipts.

## 57. POSIX TEST actor: минимальная переносимость после actual 2227 compile failures

### Круг 1 — зафиксировать настоящий предел CI

Exact live source `2227a997542fd603aab2bc8410433dacfa4e83a8`,
[run43429091345](https://github.com/777genius/agent-teams-ai/actions/runs/43429091345):
Linux job131897761669 и Darwin ARM job131897761474 завершили existing
step24 до запуска POSIX native cases. В original Linux log GCC13 с
`-Werror` отвергает игнорируемый результат write в C307/310 и read в318/324;
Darwin compiler не видит `errSecSuccess` в214/215/216/218. Это ошибки
компиляции TEST actor, не native отрицательный результат и не evidence,
что прежний image/byte-stability guard прошёл или не прошёл.

Source остаётся одним existing
[fixtures/posix-exec-native.c](https://github.com/777genius/agent-teams-ai/blob/b13f668315b38182d6a0f47f10eef54cd43aaceb/packages/legacy-agent-host/tests/fixtures/posix-exec-native.c),
preimage `65ae717da1a36dada1571191060df833c373caf1`.
Оригинальный TS runner в registered-process-executable.native.ts354–365
уже компилирует controller, sibling library и payload с
`-std=c11 -Wall -Wextra -Werror -O2`, Security/CoreFoundation на Darwin.
Параметры compiler, flags и CI budgets не ослабляются.

### Круг 2 — ровно один TEST C path

1. Darwin: явно подключить `Security/SecBase.h`, где Apple объявляет
   `errSecSuccess = 0`
   ([official SecBase.h](https://github.com/apple-oss-distributions/Security/blob/main/base/SecBase.h)).
   Сохранить SecCode API, exact original audit token, no-network validity,
   code-signing flags, сравнение original executable и все CF releases.
   Не заменять код возврата произвольным числом и не обходить проверку
   неподдерживаемого/неподписанного изображения.
2. Linux child: зафиксированный errno ptrace/execve передать прежним
   original error pipe одним write sizeof(int). Проверить возвращённый
   byte count. Полный write сохраняет прежний exit111/112; failed/short
   write завершает этот же original child отдельным finite failure113,
   не продолжает exec/resume и не объявляет успешную доставку errno.
   Не вводить повторный syscall loop, новый IPC/frame, signal или child.
3. Linux parent: только после original waitpid и target_pid=0 прочитать
   прежний pipe в local temporary integer. Публиковать execErrno лишь при
   exact sizeof(int) и положительном errno; read error сохраняет его
   errno, EOF/short/invalid report даёт EIO и execErrno=0. Частичные bytes
   нельзя использовать как EPERM/ETXTBSY или отсутствие процесса. Два
   одинаковых early-exit branches могут использовать один маленький
   private Linux-only helper; writer helper также Linux-only, чтобы
   Darwin/TEST_LIBRARY/TEST_PAYLOAD не получили unused-function warning.
4. До read parent уже закрыл свою write end, а original child reaped;
   новых ожиданий/таймеров нет. Все original PID slots, reap blocking,
   cleanup, generation/identity, ptrace stop-before-user-space, suspended
   Darwin launch, mutation-after-last-check, execve pathname/argv/env,
   retained writer и marker proofs остаются. Никаких production adapters,
   permission/capability workaround, signing-policy changes или новой
   квалификации по факту компиляции.

### Круг 3 — проверки и честный статус

До source — root publication и независимый peer. Проверить точный one-file
diff и readback. Локально разрешена только компиляция того же controller,
library и payload с прежними strict flags; при необходимости воспроизвести
Linux warn-unused-result на compile-only invocation с
`_FORTIFY_SOURCE=2`, сохранив его и для final bytes. Не запускать повторный
ptrace native scenario и не выдавать Linux compile за Darwin compile.

Новая test suite/case, oracle, runner, retry, timeout или workflow не нужны.
Existing compiler-default/ad-hoc/script/mutation cases следующего штатного
CI остаются обязательными. Полный original errno получит прежний
writer-open/ETXTBSY case; unknown/short pipe не может пройти этот oracle.
Текущий2227 и прежний local EPERM receipt сохраняются неизменными. Source
peer, local compiler и actual Linux/Darwin native outcomes отмечаются
раздельно; original-path product activation этим исправлением не разрешается.

**R1:** exact CI compiler diagnostics сопоставлены с четырьмя discarded I/O
results и отсутствующим declaration header. **R2:** выбран fixed-size
fail-closed original pipe без изменения custody/primitive. **R3:** peer,
source и compile/native execution новой редакции ещё pending.


## 58. Genuine old Claude corpus qualified; keep the current archive pin coherent

**Actual evidence.** Parity head `9ea802cc0f8c873c8349512cb010fe54e34fdd70`,
[run43420487453, job131868952891](https://github.com/777genius/agent-teams-ai/actions/runs/43420487453/job/131868952891)
completed the existing genuine-old-checkpoint step successfully on 2026-11-13.
The assertion result is `CORPUS_QUALIFIED_CURRENT_D_REFUSED`: the unchanged
1d0 donor produced the original checkpoint, resumed its native history through
the old owner and completed both original inputs with confirmed cleanup.
The current public D at that head refused the same checkpoint before all native
allocation/backing/probe callbacks. The job also checked eleven original model
observations, exact source/dist/archive/native identities and unchanged frozen
checkpoint/profile/launch/native-prefix digests. Compiled old/current entry
equality was true. This is a qualified old corpus and strict refusal; it does not
establish the ordinary current Main owner route or positive old-to-current Resume.

Artifact14036966833 has archive SHA256
`a3e16a7cd4f0100d41de2e8c24bac7655cd7e225bdbe54fbd3623c37ecd1a4ab`.
The job log and exact assertion source were read. The downloaded archive's
contained payload has not been independently unpacked in the currently
unavailable executor; no claim of that additional inspection is made.

### R1 — narrow integration mismatch found before the next run

R20 already changed the owning package dependency to the checked immutable
`claude-review-3b39a50b` archive, SHA256
`f2514f0bec64a2da36511595fe2d6c67d9cbaa6e0da865a65375c2d7c7fe39a2`.
Two existing TEST assertions still demand the previous current archive
`73c7034aef1283ee694114d2a31d12383370286b45c18120958ca0edef789957`:
`CURRENT_SHA256` in `packages/legacy-agent-host/tests/native-claude-host.native.ts`
(preimage `9d1edf7a60d7ceb6494a0df0ed53fc880d90d6a9`) and the matching current-provider
assertion in the existing genuine-corpus step of `.github/workflows/ci.yml`
(parent preimage `0eab99cf8121dec4de96678b9fa1679eba27b4d3`).
The queued 7ce run has not reached this step; this mismatch is established from
its exact source, not presented as an observed CI failure.

### R2 — smallest correction and preservation

Replace exactly these two current archive literals with the checked 3b39 digest.
Keep the explicit equality, original donor commit/archive/contracts/native pins,
strict current-D refusal, immutable corpus checks, zero-allocation assertions,
both original inputs, eleven requests, cleanup, job conditions and budgets.
No provider code, checkpoint hash algorithm, opaque payload, owner binding,
installed archive or dependency lock changes belong to this correction.
Root composes the workflow edit separately into the qualification child so its
existing child-only CI obligations remain byte-preserved.

### R3 — verification and remaining compatibility work

Independent review checks both literal replacements against the already
verified immutable package receipt and the exact current package dependency.
No new unit test is useful for this pin-only correction. The existing canonical
Host-script typecheck and genuine corpus/current Desktop Resume CI on the
updated head remain required. The previous 9ea success does not qualify 3b39.
The §39 compatibility rule and ordinary current-Main transition remain open;
no boolean legacy-hash escape, checkpoint rewrite or automatic migration is
authorized by this evidence. Publish this amendment before either source edit.


## 59. Original Desktop failure: make the existing safe source projection visible

### R1 — observed failure and the missing distinction

At original parity head 7ce224d148205867d46fd2ca980a48e1b9e8c48b,
Main run 43440481656, job 131936501910 finishes the ordinary mixed V2
journey and fails its separate step29 captured-MCP Desktop journey.
The latter writes INCOMPLETE at 15:07:31Z, then the final guard throws.
Its original log blob is f72e915df8ec7aa2ce2f3e0d7f65295ce0bc6f01.
The log exposes the retained receipt path, but the guard's stack identifies
only the final acceptance assertion, not the original caught failure.

Original artifact 14048513679 is retained, 1395462 bytes, ZIP SHA256
e53c7bc0882453d5f867402ea0f717fc989ac5071dd7788afaa9ee3411693f4f.
The official download has succeeded; its inner receipt has not been read
while the executor is unavailable. No original failure phase, native cause,
cleanup outcome or similarity to the standalone V2 failures is inferred.

The native child already contains projectDesktopHarnessFailure in
desktop-backend-observations.ts (e5625eb9a2ad06ac0c3e5798a07381dbd25e44ca).
It projects the original caught Error to a fixed kind and at most six
relative frames from the already frozen desktopProofSources allowlist.
It never includes the raw message, assertion values, cause, environment,
absolute workspace root or outside-source stack. That existing projection
is currently saved in the private receipt but omitted from the final log.

### R2 — smallest source change, with each branch preserved

Reuse that exact function; do not add a second diagnostic implementation.

| Path | Parent preimage | Native preimage | Qualification preimage |
| --- | --- | --- | --- |
| scripts/legacy-agent-host/desktop-backend-observations.ts | 15d28a939caa103774b972ecc82a7a95af24a685 | e5625eb9a2ad06ac0c3e5798a07381dbd25e44ca | da5b24520e4036a806cd23676fa07f6ab2ae99d6 |
| scripts/legacy-agent-host/desktop-backend-smoke.ts | cf78c2fc64b108560be1a5d8e63ac8c748a38036 | dcbe0a47a2f67c054762ac106febd39241f92e3c | 2aa3691c77f2621026f991e5dc3284dc5f1f8a9c |

1. Copy only the unchanged existing projection function to parent and
   qualification observations modules. The native copy stays byte-identical.
   Keep every platform listener/custody function and its imports unchanged.
2. Parent and qualification catch blocks call that same projection once for
   the original caught error, repository root and frozen source allowlist;
   the native catch already does so. Preserve the original error, INCOMPLETE,
   cleanup, debt, retained receipt and final failing assertion.
3. In the existing final summary line, include this fixed failureSource only
   when status is not PASS and the original catch supplied it. Keep all
   existing summary fields, including qualification's Codex login projection.
   Do not print the private receipt, raw errors, screenshots, child output,
   native IDs, URLs, commands or artifact/archive bytes.
4. Keep original 16 KiB inspected-stack bound, 40-line scan and six-frame
   cap, filename allowlist/containment, source freeze and all test budgets.
   This observation cannot authorize retry, another UI action, native input,
   permission, cleanup signal, source selection or successful acceptance.

### R3 — review and actual acceptance

Root and an independent peer compare the copied function byte-for-byte
with e5625eb9, inspect each exact two-file branch delta, and confirm that the
summary cannot acquire a raw Error or a raw receipt field. This small
observation change adds no test suite, helper framework, job, matrix row or
native invocation. Existing script checks, source cap/type/lint and ordinary
Desktop gates remain required; source-only publication is not execution.

The next ordinary coherent-head CI, triggered by reviewed source changes
after the previous run is terminal, supplies the actual original failure
location if the journey fails again. A failed journey stays failed. A green
journey must still satisfy all original native MCP/permission/effect/Stop
and retained-settings assertions. This section closes only missing safe
failure visibility, not the unobserved underlying MCP failure.
