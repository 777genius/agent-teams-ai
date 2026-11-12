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
