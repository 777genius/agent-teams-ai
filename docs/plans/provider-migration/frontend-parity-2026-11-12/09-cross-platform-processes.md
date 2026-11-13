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
