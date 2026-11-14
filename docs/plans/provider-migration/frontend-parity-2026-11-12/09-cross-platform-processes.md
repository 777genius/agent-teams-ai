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


## 60. Original Taskboard and producer refusals: bounded failure observations

### R1 — exact evidence and remaining uncertainty

This is a TEST observation plan, not an inferred product fix. At original head
7ce224d148205867d46fd2ca980a48e1b9e8c48b, Main run43440481656 has three distinct failures:

| Original job | Immutable original log | What the log proves |
| --- | --- | --- |
| 131936501218 | 282dfad6a3a3aeffb15ba942fea5c239c797bd8e | The one Mark resolved attempt was followed by the failed banner-clear read at desktop-task-board-ui-smoke.ts:463. |
| 131936501807 | 7ec75ea4848855eb0c072bbab56f30ed3271ec3e | Saved donor producer finally437 reports INCOMPLETE; the earlier caught failure is not visible. |
| 131936501853 | 6cb87a09af9b88dcb38cf0b5329fdb65e06c271f | The original current-legacy model rejects catalog read number nine under its unchanged limit8; sourceFrozen and cleanup absence do not establish the completed business/Stop stage. |

The official original ZIP downloads do not supply inspected inner receipts in the unavailable executor. Do not infer a Task mutation failure, a donor UI cause, or legitimate catalog cadence from these final assertions. All three source callers and model632808e8729145967b321f4fd41625ce4a71c995 remain byte-identical between7ce and native12d54316c69326fd3d405459ebf77062d818324f.

Runtime0.0.158, exact tag treef5c69c2e9024ffc36a5db5eafe30f53539b52f62 in777genius/agent_teams_orchestrator, has a process-local catalog cache (anthropicCatalog.ts adec3f0b3655f691c0efa87ae0910e7e7625a707:1233–1272). Its full registry status fetches the catalog; summary does not (registry.ts57f89dd1d54b7dd5c124933c2290db460ec49209:442–489). Frontend ClaudeMultimodelBridgeService68e89e584395a022fa4e7b4d7017a7f3a397f154:1222–1333 starts scoped status commands and reuses completed results only for OpenCode. This establishes why a warm-process cache does not prove a whole-producer limit8; it does not justify raising that limit.

### R2 — only three existing source paths

| Path | Exact preimage | Narrow change |
| --- | --- | --- |
| scripts/legacy-agent-host/desktop-task-board-cross-team-ui-smoke.ts | ebaf64ed7e8e3c1e8ecfe5571cd031ed01c375b7 | Observe the existing Taskboard failure at its existing caller; the794-line UI implementation stays untouched. |
| scripts/legacy-agent-host/desktop-donor-saved-producer.ts | bee89100fc5740abaeacd2b9e1fd9ee5f2b508df | Retain a closed attempted stage and project the original caught source before its existing finally assertion. |
| scripts/legacy-agent-host/desktop-stopped-import-prior-run.ts | d239c0e806ac17535dafb5b532b6f639a191b056 | Project the original caught stage plus existing oracle and captured-child facts. |

Reuse the unchanged §59 projectDesktopHarnessFailure(error, repository, desktopProofSources). The published parent implementation is ab850ddfc2d146a420f1685f84b5424f7f36d0bd; native retains its original e5625eb9a2ad06ac0c3e5798a07381dbd25e44ca. Its16KiB stack/40-line/six-relative-frame bounds and frozen allowlist remain intact. All three callers, desktop-ui-controls.ts and the existing pure command-entry validators are already in the frozen Desktop source closure. No shared observations/smoke/inventory file, new helper file or production owner changes belong to this slice. Root retains those shared files.

### R3 — Taskboard: distinguish original command evidence from the stale banner

Catch only the rejected existing runDesktopTaskBoardUiSmoke promise in its existing caller. Collect this diagnostic only when the already retained proof identifies its one original created task and its latest recorded UI action is the attempted click with the exact recorded label `clear original clarification once`. There is no second click, DOM evaluation, RPC, command lookup through a live owner, recovery or replay. Other failure stages continue to propagate without this extra journal observation.

Use the original createReceipt binding/effects.taskId, original fixture root and fixed TEST Team namespace. Validate the original task ID before deriving its fixed file. Read that canonical task and enumerate the existing .host-owner/commands directory once, using read-only no-follow FDs and canonical original paths. Bound the directory walk to128 entries, each JSON read to64KiB plus one over-limit detection byte, and combined file reads to1MiB. Verify regular-file shape and retained-FD/named-path identity before and after the bounded read. Do not follow new paths supplied by JSON. An unsafe, missing, malformed, replaced, oversized or incomplete observation stays unavailable; there is no diagnostic retry.

Use existing pure validateCommandEntry/teamCommandPath validation, without constructing a Team owner or store. Match only original binding/principal, exact original taskId, operation task.clarification and value null. Emit no IDs, names, payloads, filenames or rows. The closed result reports canonical clarification as user/lead/absent/unknown, scan completeness, matching count and the five existing phase counts prepared/applying/completed/rejected/held. Counts are null when the scan is not complete; never fabricate a zero. Validated unrelated receipt families do not contribute.

These are bounded point observations, not an atomic Team transaction. A zero matching count does not prove that an in-flight action will never dispatch; a completed count alone does not authorize another action or substitute for the existing acceptance assertions. The result lets the next failed run distinguish retained null-command/canonical-state evidence from the unchanged banner; unstable files explicitly leave that distinction unresolved.

### R4 — saved producer: retain the earlier caught location

Keep a local closed attempted-stage value at existing control boundaries: connect, create-form, model-selection, member-configuration, save, native-drain, quit, source-capture. It describes the operation being attempted, not confirmed completion. In the existing catch, retain that stage and the §59 projection of that exact original error before the existing throw/finally flow. Do not parse or print the raw error, assertion values, stack, private receipt or UI labels.

No additional file/DOM/process read is needed. Existing raw private receipt fields, ordinary Quit, native/group absence, source freeze, INCOMPLETE and final guard remain unchanged. Cleanup-only failure without a preceding caught source must remain explicitly unclassified rather than attributed to an earlier successful stage.

### R5 — stopped producer: stage and existing counters, without changing the model

Keep a closed attempted stage at existing boundaries: connect, create-form, model-selection, launch-settings, create-launch, source-identity, reply, stop, create-task, stop-proof, quit, oracle-drain, source-capture. At the existing original catch, project its source once and read only already available original values:

- catalogLimitExceeded is true only for the existing first oracle failure literal bounded original legacy catalog reads. Under the unchanged source guard this supplies catalogReadsAtLeast9; it is not an exact final catalog count. Other/unknown failures are not relabelled.
- Native business count is the existing currentLegacyTurns length (bound1), model-probe count is currentLegacyProbes length (bound8). Invalid/overflow values are unavailable, not clamped into successful acceptance.
- Captured-native count comes only from native.captured(), whose implementation copies the original in-memory map (desktop-captured-app.ts:48–85). Bound32 and report overflow separately. Do not call observe(), remaining(), processTable(), selectedDesktopRuntime(), ps or any new census. This count is retained witness metadata, not proof of currently live or released processes.

The original model, catalog limit8, HEAD limit32, probe/input limits, response handling, sealed-first-failure rule and finishCurrentLegacySource drain stay byte-identical. No getter, counter API, cache, new request or model-file size change is needed. Stage plus these source-bound facts tells whether the catalog refusal occurred before Create, during the one native turn, or during later Stop/Quit observation; it does not claim its network/CPU cause.

### R6 — output, failure precedence and qualification

The Taskboard catch saves and emits its one closed observation. Each producer retains the original catch observation, then uses its existing final failure boundary to save and emit at most one labelled JSON diagnostic row after the original cleanup/freeze observations. Without a prior caught error, report only cleanup-or-freeze/unclassified and the already available closed cleanup/freeze flags; do not assign a successful earlier stage as a cause. Every row is at most4KiB, constructed only from fixed enums, finite counts/booleans and the §59 projection. Serialization/reading/logging failures must be contained and leave the exact original caught error, existing finally/cleanup and failing acceptance unchanged. Never print an arbitrary receipt/error field. Missing diagnostic data is unavailable, never PASS, completed, no-dispatch or release.

No new test suite, helper framework, job, matrix row, native invocation, input, permission, timer, polling loop, read retry or budget increase is introduced. No baseline raise or code compression is authorized; the three existing script files remain below800 physical lines. Independent review checks exact original-failure identity, read bounds/no-follow containment, closed output and all unchanged actions. Existing script types/lint/source cap and the next normal coherent-head original CI gates supply execution evidence. This plan and source-only review do not close any of the three acceptance failures.


## 61. Genuine old Claude Host checkpoint: original-executable proof and ordinary current Main Resume

### Review 1 — demonstrated defect and exact acceptance scope

This is a plan before source changes. D's current stable source is `4b005ece46dfe141013ac4fb06220b20d955b90f` in agent-teams-ai/old-provider-implementations; its Claude factory/open/config blobs remain the ones identified below. F source preimages are verified at `1160b575c4e43db045ab8726fd16d27bd611196a`. F still selects the checked D3b39 archive `f2514f0bec64a2da36511595fe2d6c67d9cbaa6e0da865a65375c2d7c7fe39a2`; D4b005 CI success is not evidence that this later archive is installed in F.

The genuine exact1d0 producer is already separate from synthetic compatibility tests: run43420487453/job131868952891/artifact14036966833 recorded old-Host ONE, unchanged checkpoint/native bytes, current public-D refusal before native callbacks, and old-owner cold TWO. Preserve those facts and the independent standalone test. The first local producer attempt whose outcome was lost remains INCOMPLETE/unknown; it is neither replayed nor retrospectively assigned an outcome. The later7ce old-corpus failure was the exact stale archive literal already corrected by §58, not new evidence about checkpoint semantics.

Old F `1d0f97f55de566036c970eab4f36b84620afdb3f` used SDK0.3.305 and D9ede's checked archive `fc8a821aff5b96b649647dac3853c831acf83d1555a480dc1f9645006600cb89`. Its actual CapturedProcess required the SDK-requested command to equal the original captured executable path and verified its SHA before spawn. Current F supplies that selected executablePath to D. The current D compatibility hash adds this path when present; old Host checkpoints omitted that one field. This does not authorize accepting arbitrary old opaque bytes, deriving a filename from PATH, or ignoring other compatibility fields.

The target acceptance is **a genuine old Host checkpoint consumed through the ordinary current Main UI**. The first Main/Electron executable in this bounded test may already be current: it selects the frozen old Host in its original captured descriptor. Its successor is the same current Main selecting the current Host. Do not label this an old-Main executable upgrade. There is no new old-frontend checkout/build, generic checkpoint import, public migration operation, owner rebind, or protocol change.

### Review 2 — source authority and the missing-journal counterexample

The relevant unchanged source contracts are:

| Source | Immutable blob | Binding fact |
| --- | --- | --- |
| CheckpointCoordinator.ts | `cc6a36675b183d68ed29c9fd409694a0754adbdb` | readCheckpoint272–295 verifies the exact ref/request, published payload/source config/history, closed/released idle source, current grants and exactly one original current-Host opening target before returning opaque bytes. |
| createMemberEntry.ts | `48e6e6ca24e09966297a2461bd1b3b0abd14ed17` | The persisted selected base digest must equal the full compiled base profile; selected effective digest must equal the prepared profile at that technical generation. |
| runtimeCaptureSource.ts | `3a7d6b0d4f1db25670531cc1eb904ca7a7e30ca5` | Original capture recipes/configuration and registered member scope are validated before compiling a runnable entry. Raw recipeDigest and compiled base-profile digest are distinct and must not be equated. |
| launchConfiguration.ts | `ecb0e8061d1e27685cc099e3a7121cb5ebb03329` | Its closed app options change selected model/settings; they do not replace the captured executable, account or namespace. |
| TeamLaunchOwner.ts | `29822d71440cef625bdc2b43263cbeba7a9c96e2` | A missing launch file may be initialized from today's seed at66–88. selectRestore319–357 validates the source selection and atomically appends the new restore attempt and matching restoration row. |
| FileTeamRuntimeBindings.ts | `04cbb4bda9a4ecba22cfbd664e86de1c16e8733a` | The existing fenced projection reads the authoritative launch record, validates its fingerprint/preparation/native additions/selection chain and returns the selected base/effective digests. |
| validateLaunchRecord.ts | `f53a249f6597bba3502c3071da69676eeb171141` | Member attempt IDs are unique, bounded to65 and currentAttemptId is the last entry; full attempt-field checks currently cover only that current attempt. |

Thus today's entry.selection, current seed, a matching hostIncarnation by itself, or source cleanup alone cannot prove which executable produced the checkpoint. In particular, a missing old launch journal can be recreated from a current seed and then receive a restore selection. A second cold startup must not turn that recreated row into original producer evidence.

Use the original append already owned by selectRestore. For the exact selected restoration command/ref/member, its target attempt is `restore-${runtimeDigest(commandId)}`. The immediately preceding attempt in that same member's bounded list was current when the atomic source→target selection was published. Existing retries and member actions only append; native addition creates a separate member list. Later append-only operations preserve this adjacency. This is a source-derived join to the exact restoration row, not a search for any attempt sharing a Host nonce.

A selected Skip is the one same-binding exception to a directly claimed predecessor: memberActions.publish appends a new attempt without changing the Runtime binding. If the exact predecessor is such a validated selected Skip, follow only that action's original sourceAttemptId backward through the same member/binding. Each link must point to an earlier retained attempt and the same validated source/selected binding; the existing65-attempt limit bounds the walk. Refuse cycles, missing/ambiguous links and arbitrary unclaimed attempts. Do not infer a source from timestamps, labels or a shared Host nonce, and do not discard legitimate Resume-after-Skip merely because its last metadata-only attempt is unclaimed.

For this projection, explicitly validate every historical field actually consumed, rather than treating the current-only validator as historical proof. Require one matching target attempt and one preceding source attempt; source claimed must be true, its original hostIncarnation must equal the checkpoint source Runtime record, its identity/times/boolean fields must be well-formed, and noAllocation must not claim a known nonallocation. The exact row supplies original sourceBinding/reference and current selected binding; both must join the selected member/run and Runtime facts. Missing, malformed, ambiguous or unclaimed lineage refuses. Do not rewrite an old attempt or manufacture a new claim to obtain this proof.

### Review 3 — narrow F composition proof, without a Runtime/API extension

Extend the existing private TeamRuntimeBindings.current / TeamOwner.runtimeSelection projection with an optional **checkpoint reference**, used only by the Claude restoration proof. Ordinary callers receive the existing selected projection and behavior. When the reference is supplied, the same original Team read authority/store fence validates the exact selected restoration and returns a closed source-claim projection from the same launch record. There is no new journal, owner, RPC, renderer field, cleanup authority or explicit recovery/replay operation. This reuses the existing Team read semantics: runtimeSelection calls authorize/state, whose original state path may run roster.recover (TeamOwner513–540). Do not mislabel it a new raw no-recovery read, bypass that authority path, or call recover directly. The new claim projection itself only validates/returns original launch data; existing recovery cannot manufacture the required original source claim. The callback makes exactly two explicit synchronous runtimeSelection calls on this legacy candidate: the initial source-claim snapshot and one final equality/current-selection reread after the separate Runtime reads. Each successful existing runtimeSelection performs two state visits (authorize→state and its direct state call), so these are four additional recovery-bearing visits, not zero; the existing authority/allocation callbacks at entry/exit retain their own read semantics as well. There is no loop, direct recover call or extra await. TeamRosterTransitions.recover81–92 (875fd7165c2ea4d39e8cc2e222d62807cdfa1cc5) only completes the already-decided config/state projection and invalidates its existing cache; it cannot write launch attempts, claimed/hostIncarnation fields or Runtime records. Both snapshots must preserve the same original source claim; recovery cannot supply a prospective claim, and a missing original claim still refuses. TeamOwner's change is only the optional argument and forwarding on its existing lines; its current800-line limit is not raised or met by code compression.

A directly consumed composition helper constructs a synchronous, request/ref-local reader for this one provider factory opening. It captures the original selected request, target binding, base/effective profile and authority closure, and returns no mutable authority object. Its checks are:

1. The supplied ref is exactly the original request.checkpointRef; every OpenConfig field and required capability belongs to that original captured request. The current target Runtime is the exact opening/unknown record for this binding/current Host and has restoredFrom with that ref and sourceBinding.
2. The selected Team projection is still the same target, original member/run and restoration command. Its baseConfigurationDigest equals the full captured base profile; its effective configuration/generation digest equals the current selected compiled profile. Original captured recipe/configuration/registration validations remain in force. A new seed or default fallback is not a source.
3. Read the exact source Runtime through the existing private readCapturedSession surface, outside the Team fence. Require the original same profile/session/config scope, closed/released/unattached idle source and published reference/history accepted by the existing readCheckpoint path. Join its binding and original hostIncarnation to the exact preceding claimed launch attempt described above. No Runtime fence is nested inside the Team fence.
4. Require the source and target profile generation/configuration chain to match the existing validated restore chain. The original base digest preserves the captured executable path and SHA across these transitions; closed launch preparation cannot change them. If a retained original effective-profile digest is available in preparation/source selection, check it as well. Do not claim an old effective digest was stored where the journal retains only the invariant base digest.
5. Require the selected Claude profile's executable {path,sha256} to equal that original captured base identity, with canonical nonempty path and full SHA shape. Recheck the captured Team/grant/selection/allocation authority after the sequential reads, including the second exact source-claim projection comparison described above. Existing actual file/hash, MCP source, custody, input and physical cleanup checks remain unchanged.

The returned private Host evidence contains only the exact checkpoint reference, captured OpenConfig and original/selected executable {path,sha256}. It does not return an expected compatibility hash, a release assertion, an allow flag, a provider-supplied selector, or opaque/native session contents. The reader is synchronous: it introduces no new await, retry, deadline or background lifetime. The existing D factory calls it only after its original successful readCheckpoint and only when the narrow legacy hash is a candidate. Existing probe/custody guards continue to fence subsequent asynchronous SDK/file work.

A static descriptor with no original claimed source journal fails this gate. A static descriptor that retains a genuine, exactly bound original launch claim is judged by that same evidence; the mere static/captured label grants nothing. Missing-journal recreation and a later cold restart must still fail before native construction.

### Review 4 — D owns the compatibility comparison

Keep the public three-argument openClaudeSession strict. Factor its current implementation only as needed for an internal Host entry that the existing factory consumes; do not add that internal entry to the package's public export barrel.

The existing private ClaudeDriverHost receives one optional synchronous source-reader callback. The factory binds it to the same frozen selected request/ref whose opaque value came from its original readCheckpoint. F's provider/context wiring supplies the reader from Review3; generic callers without it retain current behavior.

The internal open algorithm keeps this order:

- Validate/snapshot configuration and parse checkpoint exactly as today. Ephemeral checkpoints, malformed payloads and a different engine remain incompatible.
- A normal current compatibility match follows the unchanged current path without calling the source reader.
- Only for engine0.3.305 and an actual current-hash mismatch, compute a second hash from the same snapped configuration with **only executablePath omitted from that hash projection**. Never omit it from the real configuration or SDK options. Every other current compatibility component—namespace/HOME/config directory, account/trusted binding, cwd, revision, model, native and required tools/order, permissions/settings, extra args, attachment and subagent policy—remains in the same hash.
- If this one legacy projection does not equal the actual unchanged checkpoint hash, refuse before the source reader/native callbacks. Otherwise require the reader's closed proof, exact ref/request, original path+SHA equal selected path+SHA, and selected path equal the real config.executablePath. Missing/invalid proof yields checkpoint-incompatible, with no fresh fallback.
- Only then run the existing native session-store check, ordinary SDK readiness/construction and original custody path. Reuse the actual original selected executable path; no ambient SDK/PATH replacement.
- Newly emitted checkpoints still use the normal current compatibility function, including executablePath. No opaque hash, nativeSession, checkpoint payload, Runtime history, original claim or handle is rewritten.

This is a compatibility rule inside D's trusted Host composition, not a general public open option. The optional callback's type is reachable through the already exported private ClaudeDriverHost type; no new public Runtime contract or top-level compatibility switch is introduced.

### Review 5 — focused controlled qualification before native acceptance

Extend the existing D factory restore/effective-config cases, preserving the public-open negative. A genuine controlled checkpoint produced with the old no-path configuration may be used as a unit fixture; label it synthetic, not an old-Host upgrade corpus. Verify the same native session is selected only with exact source proof, actual SDK options retain the selected path, and its next checkpoint uses the normal path-inclusive hash. Cover missing/wrong ref/request/path/SHA proof, changed nonpath compatibility fields and no-reader calls; count source-reader, sessionExists, probe and query callbacks so all refusal boundaries are visible. Do not weaken or replace existing configuration/namespace/permission tests.

Extend the existing controlled runtime-team-host selected-checkpoint case and its existing fixture. Exercise the real Team launch claim→Runtime checkpoint→Stop→cold restore chain and inspect the composition reader for that exact opening. Add bounded variants within this existing suite for missing/recreated launch history, a second cold startup after recreation, a foreign member/source/ref, malformed or unclaimed predecessor, the exact same-binding Skip link versus an unrelated claim, changed base executable identity, and revoked current authority. Use original captured payload bytes; test faults occur only after the original owner has closed and are restored explicitly. Verify old Runtime/checkpoint/native input records remain unchanged and no controlled provider handoff/input is released on refusal. A direct Runtime-only test or a fabricated source-proof object does not close F provenance.

D check/build/pack verification must finish on the exact candidate. Root alone publishes D, consumes its official checked archive, updates F's ordinary package pin/lock/provenance, and keeps installed declarations/archive equality intact. The existing standalone current-provider archive literals in native-claude-host.native.ts and ci.yml must move to this exact checked archive together, preserving §58's old pins and strict negative. No symlink/package bypass, SDK upgrade or contract archive change is authorized.

Then run the coherent Host build, Host/script types and the existing focused cases. A resource kill or unavailable executor is not PASS; the same normal candidate-head CI may supply the required result before final acceptance/upward merge. Do not repeat native experiments merely because local execution is unavailable.

### Review 6 — one existing Desktop Resume invocation, two honest Host epochs

Use only the existing Claude `native-resume-ui` matrix row. The exact1d0 checkout and frozen Host-only build already exist. Keep its independent standalone old→old/current-public-D-negative prerequisite unchanged. Do not reuse that standalone producer root, operation IDs or native history as the Desktop session; the already necessary Desktop root is fresh and its first original ONE is produced by old Host.

A directly consumed TEST preparation/inspection helper selects that frozen donor Host and resolves its SDK-native executable through the **original installed D→SDK→platform package chain**, as the current donor test already does. Require SDK0.3.305, the original native SHA, checked old D/contracts archives and frozen source/dist/lock provenance. Verify the current D/archive and current Host source/dist separately. Both the original and current readTeamHostProfile validators must accept the same unchanged profile bytes before effects; never drop a selected field to force old compatibility. Do not edit either checkout's source or old compiled output.

Before the first app/native effect, compare the naturally produced old/current compiled dist/cli.js bytes and SHA, captured Node/version/SHA, profile/build/owner identity and storage scope. Identical cli.ts source alone is insufficient. The first TEST descriptor names the real old compiled entry; the successor names the real current entry at its own canonical path. Their immutable owner tuple must naturally be identical. The original profile bytes, executable path/SHA, ownerId/revision/storageRoot/profileId/buildId/protocol/nodeSHA/entrySHA, Team scope and handleId stay unchanged. A tuple mismatch leaves the route unqualified before effects; never copy a bootstrap, substitute an expected hash, relabel a build or migrate a handle to make this gate pass.

Create the successor descriptor as a separate immutable file with its own actual descriptor SHA. Do not rewrite the original descriptor or profile. Its only deliberate selection difference is the genuine current Host entry path; actual identical entry bytes are a prerequisite, not an assertion forced into the data. Preserve original env/profile file pins, timeouts, native CLI path and all descriptor scopes. Record both full Host source/dist identities, so equal small entry bytes do not obscure different producer/consumer implementations.

The first current Main follows its normal descriptor registration and public Launch UI against old Host. It creates the real immutable handle in the normal `userData/agent-backend/bindings` store, uses the original selected model/settings and sends ONE exactly once. After the existing Stop, retain unchanged original checkpoint bytes/native-history prefix, original Runtime/source selection/base profile and the actual persisted handle record. Check the stored owner tuple against both naturally captured profiles; a descriptor or renderer handle alone is not persisted-owner proof.

At the existing single cold boundary, retain all current assertions: one public Quit, original app exit0, entire original group and captured Host absent, writer lock gone, native/metadata cleanup complete, original Runtime/checkpoint unchanged and eight model observations unchanged. Only after these proofs may the caller adopt the already verified successor fixture, descriptor, ChildProcess/group and new CDP. Every failure cleanup keeps the correct original/new process object and selected fixture; do not query the exited old CDP or silently mutate original fixture pins. Use the existing guarded cold helper with a closed explicit checkpoint-upgrade option, never a generic arbitrary owner switch.

The second current Main must load the same actual stored handle through BackendOwnerRouter/ DesktopBackendFeature unchanged. Those production paths compare the stored whole owner JSON/tuple and preserve immutable handles; no migration API is added. Verify the same handle bytes, source Runtime/checkpoint/history prefix, ownerResourceRef and Team scope after real cold discovery. The existing Launch helper receives the actually adopted successor fixture through one explicit current-fixture accessor before invoking Resume; an old hostEntry must not remain in later census/cleanup helpers.

Perform the same real Resume click, no input on Resume, one new technical generation, then ordinary Composer/Send TWO once. Require the same actual native session/history marker, existing main terminal result and Team effects, original settings, two total business inputs, exactly eight first-turn plus three second-turn model requests and existing second Stop/physical cleanup. Preserve the original source checkpoint bytes while the current generation emits its own normal checkpoint; D's focused test proves the exact current-hash emission rule, and the real receipt must retain both observed opaque hashes/session identities without rewriting either.

This qualifies old Host→current Main/Host consumption only on natural owner equality. Current→current Resume, old→old Resume, D-only inspection, a successful compatibility hash calculation, or a callback count alone cannot substitute for this UI/native result. No extra model request, input, permission approval, startup, cold epoch, job, matrix row, runner or timeout increase is planned. The existing180s standalone prerequisite, Desktop row45-minute job limit, current UI/operation polls and original cleanup budgets remain unchanged.

### Review 7 — exact source ownership and bounded publication slices

D source is limited to its existing Claude SDK factory/open-session and existing factory test:

| D path suffix under packages/provider-implementations | Preimage |
| --- | --- |
| src/features/provider-session-implementation/adapters/claude-sdk/factory.ts | `386b833f6600452f9f41968bb04266413bff21ad` |
| src/features/provider-session-implementation/adapters/claude-sdk/open-session.ts | `dd8a10a9ed4684a692fa6a771c9612a6309a888c` |
| tests/features/provider-session-implementation/claude-sdk/factory.test.ts | `3676b224f6b660c71d53d4448bfa37065f7d7d36` |

F production is limited to the existing private selection/context/provider path plus one directly consumed proof helper:

| F path under packages/legacy-agent-host | Preimage |
| --- | --- |
| src/team/ports.ts | `c86f1f8c4c72315af8116f36d5c0e43617beeab4` |
| src/adapters/team/FileTeamRuntimeBindings.ts | `04cbb4bda9a4ecba22cfbd664e86de1c16e8733a` |
| src/team/TeamOwner.ts | `cac55964ea60016be093ee14bd67c9ed6a420c3c` |
| src/composition/createRuntimeMemberProviderFactory.ts | `abc1c70c289aac1c1cb7ea8288f4e4d009aa2661` |
| src/composition/createClaudeCheckpointSource.ts | New, directly used by that factory; no independent store/API |
| src/adapters/providers/MemberProvider.ts | `ba07244fcc8128056cc5db3992f80e7a612a8003` |
| src/adapters/providers/ClaudeMemberProvider.ts | `49c7e2cb975921f5f121fc34b2a9460f51dbb76b` |
| tests/runtime-team-host.test.ts | `ce7f45c43a35ae17a7ccc4eeb5276b6084716ee8` |

No production Runtime, checkpoint storage, Main routing/store, public RPC/MCP or renderer changes are authorized by this plan.

The existing TEST lane changes are confined to these paths and the normal checked archive/pin files:

| F TEST path | Preimage / purpose |
| --- | --- |
| scripts/legacy-agent-host/desktop-claude-checkpoint-upgrade.ts | New direct preparation/readonly evidence helper; frozen original and actual successor descriptors/owner facts |
| scripts/legacy-agent-host/desktop-backend-fixture.ts | `c041f8662b8bd5db1665563edb76f5773fe4cb45`; explicit old-Host selection only for this qualified TEST mode; default/other provider paths unchanged |
| scripts/legacy-agent-host/desktop-proof-fixture.ts | `5aff276a8b0f1c2b07727e12b5995b58d34b945f`; select the explicit pair for the existing Claude Resume row |
| scripts/legacy-agent-host/desktop-captured-app.ts | `48c091170baefb5d1404c7beac9200991989f52c`; preserve guarded cold closure, then verify the explicit successor and unchanged real handle |
| scripts/legacy-agent-host/desktop-backend-smoke.ts | `eb033a2ff980564c21be67c65bba0ed99f2c8143`; retain/adopt each actual fixture/process at its existing spawn, include final readonly proof in existing receipt |
| scripts/legacy-agent-host/desktop-launch-ui-smoke.ts | `6b819a2ec7060ad1ec93cda49ecd9320f849e877`; pass the actually selected successor fixture to the existing unchanged Resume journey |
| scripts/legacy-agent-host/desktop-proof-sources.ts | `3f8d41fb20553ee9890a8f14e39e26ad2dcaabfc`; exact directly consumed helper/dependency entries, preserve all existing pins |
| packages/legacy-agent-host/tests/native-claude-host.native.ts | `09ee50328f1b6d8854f5e22719750fda51009cb6`; checked current-archive literal only, original standalone producer/negative/old-owner acceptance unchanged |
| .github/workflows/ci.yml | `2f00c1be87037da32332ad42493c7130bb896dd5`; existing row's explicit donor selection/pins and closed old→current receipt assertions, plus coherent archive literal |

New readonly TEST observations use fixed original paths and established bounds: immutable handle ≤16 KiB, original profile/descriptor within their existing schemas/budgets, launch journal ≤1 MiB, checkpoint payload ≤8 MiB and native history within the existing64 MiB bound. Validate canonical path/regular file/link/size and retained FD identity before and after bounded reads; preserve missing/corrupt/changed evidence as failure. No raw account/token/body output, directory-wide discovery, unbounded read or new polling/retry loop. Reuse the existing finite source/dist/archive proof helpers and stream native-file hashes; no whole-binary dump. Private retained artifacts and closed receipt facts are separate.

Root composes child-specific ci/smoke deltas without dropping qualification/native changes; no force or branch update by the implementation peer. Preserve each existing file cap, including TeamOwner800 and script800; use the one consumed helper for its coherent responsibility, with no baseline raise, cosmetic compression, new suite or generic framework.

Acceptance remains pending until independent source reviews, exact D/archive/F type/focused checks and this ordinary native Desktop gate pass. On an unavailable executor, prepare immutable source/handoffs and use the next already-required normal CI; do not label source review as compilation or runtime success. Publish this plan before any of these source edits.

## 62. Original POSIX actor failure: bounded case/stage observation

### Review 1 — actual native-only failures

The original native12d preflight run43457244534 completed. Linux job131994517305 passed the existing POSIX actor (immutable log559cbfa1d7ee0e64beb6ba4d59df43347946921b). Darwin x64 job131994517109 failed the actor's existing errno assertion at463 with13 rather than0 (log3b5000490a1c5c7fec4659d1e30b90348070b5f5). Darwin ARM job131994517191 failed at483 because the original mutation case retained LIB/BIN:A/MAIN:A markers (log6cabd9196bcb5da98d05500287ef60ba34e2896b). The complete per-case receipt is retained in the ordinary artifact but its members have not been read in this session. Do not assign a case label, native stage or cause from an assertion line alone.

The passing Linux actor qualifies only that controlled fixture. Both Darwin failures remain real failures. No result closes the product pathname-to-exec gap or qualifies installed/custom executables and scripts.

### Review 2 — one existing TEST file, original observation only

Only native repair branch contains this actor. Its source path is packages/legacy-agent-host/tests/registered-process-executable.native.ts, preimage6108342759147bcb480e634ccad7877a0807adc9; the C controller882c986d13920db54720b4672dd6cfc55e361aaf remains unchanged. Parent and qualification receive this plan only, with no newly introduced actor or job.

At the existing per-case assertion catch, retain a closed projection for the first original failing observation. It uses only that already decoded/validated fact, the locally enumerated case label, existing bounded marker list and controller-interruption boolean. Do not reread any file, call native code, start another child, examine the exception, or change failure selection. Preserve the original failure object and all later bounded cases.

The fixed TEST_POSIX_EXEC_FAILURE row contains sourceHead, platform/arch, original case label and native stage; errno, execErrno and mutationAfterCheckErrno; original stopped-before-user, marker-absence, image-observed/matched, resumed and cleanup booleans; the existing marker names, exitCode/exitSignal and original controllerInterrupted. It omits PIDs, birth/inode identities, paths, arguments, environment, hashes of user material, raw stdout/stderr and exception text. The case/stage/marker values use only the existing finite vocabulary and numeric/boolean projections are validated. One line is at most2048 UTF-8 bytes including its newline. Invalid/missing diagnostic data yields an absent observation, never a replacement cause or PASS.

Emit at most once, only after the existing cleanup and successful original receipt write, before the unchanged final rethrow. Contain observation/emission errors so they cannot mask the original failure. Original receipt-write failure keeps its original precedence; it does not justify another write or retrospective case inference. Retain the complete existing private receipt and all original assertions.

### Review 3 — acceptance without another suite

Do not change actor code, codesigning, compiler flags, enumerated cases, timeout120000, deadline100000, per-case budget20000, cleanup4000, runner permissions, workflow or fixture/product qualification flags. In particular no acceptance of Darwin markers, errno13 or a missing observation is added.

Use independent source review, affected script/test type checking and the next already-required ordinary native candidate CI. The existing failing case itself must retain its original failure while supplying its closed case/stage row. No new unit suite or native replay is warranted for this diagnostic-only addition. Source review remains SOURCE_ONLY_UNEXECUTED until canonical checks execute; a cause or platform fix can be planned only from actual evidence.

Root alone publishes the plan before this one-file source change, composes the native-only delta and immediately pushes every commit. No merge to main or upward merge is included.


## §63 — original compatible-API effort and donor preconnect oracles after the actual 1160 producer failures

Status: PLAN ONLY. This appendix changes no production behavior, native budget, source identity, cleanup policy or published result. The source proposal below requires root publication and independent review before implementation. The original failing runs remain failed until the existing ordinary gates execute a coherent candidate.

### Review 1 — actual evidence, source facts and remaining uncertainty

The original parent head 1160b575c4e43db045ab8726fd16d27bd611196a produced two distinct failures:

- Saved donor job132024091001, full log blob947c2a8fda0e1a558a0a0f8f7d3150b4f2e18ae3, reports phase quit and an assertion at desktop-donor-saved-producer.ts371. That assertion is the existing model.failures equality. Original wrapper exit0, signal null, empty original group, absent listener, absent captured births and absent unmatched selected executable have already passed at lines347–360. The reported phase is the last retained stage; it is not proof that ordinary Quit failed. The private original model error has not been read, and this plan does not identify its actual first message from the phase or cleanup booleans.
- Current stopped producer job132024090988, full log blobed8517497a57727b2f34972c5b59d39ecbab62aa, reports model-selection with the original model.failures assertion at desktop-stopped-import-prior-run.ts199 while the original UI call at215 is looking for Low. The existing closed diagnostic establishes catalogLimitExceeded=true and lowerBound9, zero business turns and zero consumer probes; the twenty captured native children and all original cleanup/source-freeze facts remain separate evidence. This establishes a genuine ninth catalogue request, not the reason for all nine requests.

The compatible-API effort mismatch is source-proven. Runtime0.0.158 tag f5c69c2e9024ffc36a5db5eafe30f53539b52f62 and donor0.0.160 tag e13edcd3d4ffbecc0272ae30195cc6b15b710ee7 contain the same anthropicCatalog.ts adec3f0b3655f691c0efa87ae0910e7e7625a707. Its API-compatible builder assigns supportedReasoningEfforts=[], defaultReasoningEffort=null and supportsFastMode=false to the returned gateway rows, including the fixture's actual Sonnet4.6 model. The original teamEffortOptions.ts32eca9e61d1f2a2ce4ffc97c0e13eea742061b25 therefore renders the exact #lead-effort control disabled with Not supported. CreateTeamDialog.tsx0a06948c13254c1b5fb724b5483629b5467263571526–1528 maps the empty selected effort to undefined, and TeamMetaStore.ts99c2ae66d7bc51535eab90166a79503897fa3004299 preserves omission in serialization. The saved donor already asserts this original UI behavior under P10§24. The stopped producer's two Low actions and later forced low metadata assertion were missed by that correction. Waiting for the impossible Low control can extend the active observation period, but this is only a source explanation for the wait, not a measured allocation of the nine GETs.

A second, independent protocol mismatch is also source-proven. Old4a and the current frontend use the same CliProviderModelAvailabilityService.ts eeac204b1ca9afc16e0c7c59574df61f433fd675 and providerModelProbe.ts233363243dd639556ae58e3ca1801dea5af27df0. Their ordinary native model check executes -p with the exact PONG input. Both pinned runtime versions use entrypoints/cli.tsx ce5308b112e1a0b36c73a139c0feb49ef8fc2561 → main.tsx1d5898a83dc2d9c59b9b1cbcad3c4b1c6a71a408 → entrypoints/init.ts e03a6a5b1d2792bb886030a4c6a5825dde069a48 → utils/apiPreconnect.ts6a8de649b3ff3918dd27b31a90a7678f8c92161a. In the captured producer environment, that once-per-process preconnect sends HEAD to the exact ANTHROPIC_BASE_URL, with no credentials or body. The isolated URL is the model server root /. The runtime status fast path is separate and does not establish that every status process performs a preconnect.

The current oracle632808e8729145967b321f4fd41625ce4a71c995 admits this exact HEAD only when originalLegacyRead is true, although it separately admits the donor's catalogue and exact PONG. Therefore a legitimate donor PONG process can seal the oracle on its preceding HEAD. The runtime's ignored preconnect response does not erase the fixture's first failure. This is a concrete missing protocol case; it remains an inference, not observed proof, that it was the first failure in job132024091001. Catalogue exhaustion or another first error is still possible.

### Review 2 — seven existing TEST paths, no product or workflow delta

| Existing path | Exact preimage | Narrow change |
| --- | --- | --- |
| scripts/legacy-agent-host/desktop-stopped-import-prior-run.ts | ff6622d0bf6d87f5321d8c272205096f7ef0f7c2 | Observe the actual disabled effort control and require omitted original saved effort. |
| scripts/legacy-agent-host/desktop-stopped-import-fixture.ts | 71dfae471ad0c8d1fdc3247b91236725b1f9bc92 | Make effort optional only in CurrentNativeStoppedImportSeed; retain the separate rich Low fixture. |
| scripts/legacy-agent-host/desktop-stopped-import-ui-smoke.ts | b3df0c619b9b86f4fbdbc83e9f3636bf1c6a9816 | Preserve that omission through original import and exact model-proof comparison. |
| scripts/legacy-agent-host/desktop-stopped-import-fixture.test.ts | a2754a1b9968e0c360742e87c78af4add0f67930 | Use a genuinely absent effort property in the existing omitted-selection case, retaining Low and both mismatch refusals. |
| packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts | 632808e8729145967b321f4fd41625ce4a71c995 | Admit the same exact bounded original HEAD for the mutually exclusive donor epoch, with a distinct donor counter. |
| packages/legacy-agent-host/tests/fixtures/native-claude-team/model.test.ts | bd968e145c3d9a86b46521e45994ef6be74d5b1f | Extend existing current/donor HTTP cases to exercise exact donor admission and independent first-failure refusals. |
| scripts/legacy-agent-host/desktop-donor-saved-producer.ts | bbade7afcc4900dc9c29d1330e09405c03f22735 | Add only a closed first-model-failure classification to the existing failure-only §60 projection. |

These are existing transitive proof sources, so no inventory addition is required. The current workflow does not require a literal Low setting for this genuine source branch; source/receipt equality and all existing assertions continue to apply. Parent/native/qualification preimages must be checked before composition; no child-specific source delta may be overwritten.

For the current stopped producer, keep the original single Sonnet4.6 selection and use the same existing read-only wait helper to assert #lead-effort is a disabled HTMLButtonElement with the exact original Not supported label. Remove only the two impossible Low actions; do not click a substitute value, inject settings, synthesize a failed model check or force a default. After the existing source-owned Stop/Quit, require meta.effort===undefined and absence of its own effort property. Preserve every other source/configuration, task, native-history, Stop/release and byte-freeze assertion.

Only the actual-current-native-solo seed permits missing effort; the synthetic rich Low corpus remains unchanged. On import, require the actual-current seed and imported owner.savedSettings to retain the same absent own property, in addition to all original saved-field equalities. assertStoppedImportModelChecks accepts an optional effort property but still compares every retained receipt and actual consumer request to exactly selected.effort, including undefined. It must not substitute low, medium or an alias. The existing test still proves Low success and both cross-effort refusals, and its omitted-selection positive now has no effort own property. This is an oracle correction, not a change to native request shaping.

The stopped producer is currently797 physical lines. Keep its narrow replacement within the existing800-line limit; do not compact unrelated code, raise the limit or add a baseline exception. The shared model lives in the already excluded tests/fixtures scope of the existing size policy; do not amend that policy. All other changed source paths retain their existing limits.

### Review 3 — donor HEAD admission, epoch ownership and unchanged conservation

Reuse the existing HEAD branch and its exact original checks. It may run only when originalDonorRead or originalLegacyRead was captured for this request; the existing constructor already forbids enabling both original epochs. Preserve the first-failure seal, exact URL /, absent Authorization and x-api-key, absent transfer-encoding, absent-or-zero content-length, zero received bytes and204 empty response. No other method, pathname, query, credential or payload becomes accepted.

Increment a separate donorSavedPreconnectRequests counter for originalDonorRead, otherwise the existing currentLegacyPreconnectRequests. Each remains bounded by32, the already declared maximum original captured native births; preconnect is once per original native process. This is admission of a previously rejected, source-derived protocol operation, not an increase to an existing request cap. Catalogue GET limits stay8 per original producer, donor/current PONG limits stay8, current source business input stays exactly1, native census stays32, and all existing token/consumer/model budgets remain unchanged. No counters reset at a successful response or at finish.

The same pendingDonorReads/pendingLegacyReads and original finish barriers already cover every HTTP method. Preserve those counters, the one-time original epoch closure, existing15s finish bound and no-consumer-before-settlement rule. Do not change the return shape of finishDonorSavedProbes or add a request to the desktop journey. After closure, a fresh HEAD must refuse; an earlier failed request must continue to seal all later requests.

Extend the existing donor case with one exact HEAD before its original catalogue/PONG, and keep its original post-close catalogue rejection as its first failure. Replace the former blanket donor-refusal variant in the current HEAD case with a genuinely closed donor epoch, so that the new supported case is not accidentally tested as forbidden. Within the existing donor case, use fresh isolated model instances for malformed path/query, nonzero body, each credential header, overflow after32 genuine successes and closed-epoch HEAD. Each negative must be the first failing request in its own instance and leave business/consumer observations empty. The existing current case's original late POST rejection must retain its ordering; no new HEAD may seal the oracle before that assertion. Do not add a new suite or actual native invocation.

### Review 4 — accurate failure observation without a cause claim

The existing donor failure-only projection may add firstModelFailure with a fixed vocabulary: catalogue-limit, preconnect-epoch, preconnect-limit, unclassified or null. It reads only the first already retained model.failures element; exact equality to the fixed oracle assertion messages selects a known label, a different present string is unclassified, and an empty original failures array yields null. No raw error text, requested model, account, URL, path, environment, payload, response body or stack is copied. There is no additional RPC, CDP evaluation, file read, census, request, loop or timer.

Retain the existing4096-byte log cap, try/catch containment, original receipt write, original failure object/status and cleanup precedence. Do not relabel phase quit as a cleanup failure, and do not turn missing/unclassified observation into proof of HEAD, absence of GET9, or successful shutdown. Exact message matching may conservatively classify a differently formatted runtime assertion as unclassified; broad substring parsing or raw logging is unnecessary. This diagnostic does not control admission or change an assertion.

### Review 5 — acceptance and remaining gates

Independent source review must check the exact runtime/frontend source chain, no-effort ownership through original saved bytes/import/probe, epoch-exclusive HEAD bounds, first-failure ordering and all child compositions. Run the existing stopped-import fixture case, existing shared model HTTP cases, affected script/Host test type checks, formatting and source-size guard through the ordinary canonical environment. If the executor is unavailable, these remain pending for normal candidate CI; source review is not execution.

The next already-required original saved donor and current-native stopped-import journeys must still prove their original ordinary Quit and captured native absence, immutable source bytes, actual source-owned Stop for the current producer, read-only import and existing authorized Launch continuation where applicable. No rerun, new job, new matrix entry, timeout increase, catalogue cap increase, hidden UI retry or extra native input is introduced by this plan. If catalogue9 still occurs after the impossible Low wait is removed, it remains a real failing gate requiring its own observed/source-backed explanation; this appendix does not preauthorize a larger cap.

Root alone publishes the reviewed plan before source changes, and publishes each coherent source cut with immediate push/readback. No production compatibility claim, native PASS, upward merge or merge to main is authorized by an unexecuted oracle correction.

## 64. Consume the checked checkpoint-compatible archive with every active proof pin

This is a bounded refinement of §61's already reviewed normal dependency consumption. The exact P09 prefix is f323db47b161e04b78ef61db4e5239c35919a5cd. Source/native/packaged acceptance remains pending; a checked package does not replace any F gate.

### First review — immutable input and current evidence

D advanced from ce03c60d620bfc6152623597637971ca8c529469 to 68dca527b779ebb82923f30d7b08441085d8b579 by one inspected four-file commit. Its Codex projection permits the official nullable ChatGPT email while retaining the allowlist; unsupported humanCommand/future command kinds are declined before automatic approval because requiredHumanApproval is not negotiated. It preserves §61's original checkpoint-source contract, R28's native-cut preparation and the independently reviewed model-variant projection.

The exact source/packed-consumer CI43479531998 passed. Its checked artifact14062879890 is184234 bytes, ZIP SHA256854f74916005deb7e5a9f23fed41a99605bfb5757c24c269c0b573ff4374d822. The downloaded receipt names this exact source; archive entries, size and digest were verified. Provider TGZ is177100 bytes, SHA25607241cca756e69aa6001df41d6a7408aad5d8ab4c8277f9d70f35d0d66736c73, integrity sha512-RdXbo97Amr2CMjqfe8HxzrB02WwwZqzGEWhixzgHqCEqTOdQ11CZ/vTW77SRCJGhbwXTZ5SuQzBnpJVEMX4baA==. Contracts TGZ is byte-identical to the existing canonical9ede pin, SHA256aaf9506473f6a2868a375a6087e1b4edc561b38f34101ef7a8703a73bb2674db.

Native run43479531758 attempt1 has52 successful jobs and one macOS embedded-target-model job cancelled before any step. One standard failed-job retry on this unchanged head was requested; its outcome must be observed, not inferred. Previous ce03 native success is not assigned to68d. The checked artifact's own source-and-packed-consumer-only qualification and nativeHostQualified=false/packagedElectronQualified=false remain unchanged even if this separate native run later passes.

### Second review — smallest coherent consumer edit

| Existing F path / exact preimage | Change |
| --- | --- |
| packages/legacy-agent-host/package.json1442148b48a700eb00d7f3e7df429260f54665c5 | Point only provider-implementations at the new immutable checked TGZ. Keep SDK and contracts pins. |
| pnpm-lock.yaml13d24c7b4c38f374ad299cb5e02e63b2e462b882 | Generate the matching file resolution/integrity with pinned pnpm11.22.0; reject unrelated dependency drift. |
| packages/legacy-agent-host/tests/native-claude-host.native.ts09ee50328f1b6d8854f5e22719750fda51009cb6 | Replace only the current provider digest; genuine old donor pins, refusal and old-owner proof remain. |
| packages/legacy-agent-host/tests/native-codex-team.native.ts1a01e2ad74be8006423960c1bc7099af9af93014 | Replace only the same current provider digest at the existing installed-archive check. Preserve §22.1 diagnostics, zero-unexpected assertion and finite candidate version/input/permission/cleanup proof. |
| .github/workflows/ci.yml2f00c1be87037da32332ad42493c7130bb896dd5; qualification variant c4b33ea519f0f40c5527e34b644c290a8e209faa | Compose the separately reviewed §61 three-block ordinary Claude Resume wiring and update all five active current-provider digest literals plus both active archive paths. Keep old donor and contracts values, jobs/matrices/budgets and every existing assertion. |

Create only vendor/provider-migration/claude-checkpoint-68dca527/agent-teams-provider-implementations-0.0.0.tgz, README.md, source-receipt.json and checked-artifact-receipt.json. Copy the exact official TGZ and receipt bytes; never rebuild/repack or patch installed output. Follow the existing source-receipt format, recording actual source/tree/check-job IDs, checked ZIP and TGZ identities and unchanged contracts location. Do not duplicate the byte-identical contracts package. Historical vendor directories/receipts and historical proof records stay immutable.

The CI current-provider literal at654 and native Codex literal at151 were found by a complete active-source search; they are the same archive custody check, not new native operations. This appendix adds the one omitted Codex TEST path to §61's finite scope. Search again after composition to prove no active stale current pin remains, while preserving deliberate historical values.

### Third review — installation and actual gates

Install through the normal project package manager and original dependency policies. The existing readNativeProviderArtifact/verifyNativeProviderArtifact adapter must read the new owning manifest/receipt and compare every installed provider dist JavaScript file to its archive. No stale node_modules link, generated declaration substitution, widened protocol eligibility or hand-written lock integrity is acceptable.

Run Host build/test types, canonical Main types, legacy Host script types, the existing critical runtime-team-host restoration case, relevant source/fixture tests, source-size guard and lint. Any real compiler mismatch in nullable metadata or the new private checkpoint declaration is investigated at its actual consumer; an additional source path requires an exact bounded follow-up before editing. Preserve the common parent and separately reviewed child source compositions. Source review is not test execution.

Root records the exact dependency and native/check outcomes, commits and immediately pushes the reviewed working heads, and reads back refs/trees. Active live PR checks are allowed to finish before a new head; no cancellation, redundant full rerun, main merge, Stage2 activation or release. The ordinary old-Host ONE → physical Quit → current-Host cold Resume → TWO receipt and original cleanup remain the §61 acceptance gate.

### §64.1. Generate the unchanged dependency's file record without resolving unrelated workspaces

The normal full/scoped project lock-only resolver did not finish in the restored local environment: earlier processes were killed, and the bounded384MiB measurement explicitly ended with V8 heap exhaustion (peak resident590684KiB). The original lock13d24c7b4c38f374ad299cb5e02e63b2e462b882 remains unchanged. Do not repeat those same attempts or weaken repository install policies. D68's separate native run has now completed53/53 successfully on the exact head, including the one original never-started job's standard retry.

The old3b39 and new68 checked TGZ package/package.json objects were compared in full and are identical, including name/version, dependencies, peers, optional dependencies, exports and engine metadata. Only the archive identity and existing file locator need to change in the owning lock. No dependency graph change is authorized by this refinement.

Use pinned pnpm11.22.0 to generate the new file resolution in one temporary, private packed-consumer workspace outside the repository. Select the exact verified TGZ and existing canonical contracts archive; preserve the repository's release-age, peer, override and build policies for those dependencies. Normalize only fixture-relative file locators to the same actual checked files. Run the ordinary lock-only resolver offline with one worker; no package repack, patch, registry substitution or ignored security/build policy. The consumer is a dependency-resolution fixture, never native/Host/packaged acceptance.

Read pnpm's generated file record and independently compare its integrity to SHA512 of the exact177100 TGZ bytes. Transfer only that generated integrity and the checked locator into the existing full lock: the five original3b39 path occurrences and one original integrity scalar. Preserve all transitive package/snapshot values and the existing supports-color peer identity byte-for-byte. Require exact old-lock SHA before editing; reversing only these declared scalar substitutions must recover the complete original lock. Any metadata, peer, dependency or additional lock change refuses this narrow operation and needs investigation.

The full repository must then pass its ordinary frozen-lockfile install with all original policies/hooks, and the unchanged installed-provider/archive equality verifier. No partial node_modules execution or synthetic successful install receipt is permitted. This is a bounded pnpm-generated lock update for byte-identical dependency metadata; it does not waive compilation, meaningful tests or any native/Desktop gate. Root and an independent peer review the exact generated record and minimal lock diff before source publication.

## 65. Preserve native 2.1.4 implicit integration identity during captured credential preparation

This is a bounded P09/P05 catalog correction after the actual qualification591 Linux failure. The exact P09 prefix is 90c0cdf7ea7e4b8c10291913c0a4ab4eba475f50. Only the existing credential selector and one existing focused test file are in scope. It does not change P05 §16's private purpose, readiness protocol or source authorization.

### First review — observed failure and exact source distinction

Original job132057339187 on source5912c66f915b1feb9e78c7ec7c97e9d882788583 passed the existing embedded native lifecycle, then failed the first model-probe catalog assertion. Its retained R29 line reports unknownProbeCancelled=true, catalogAttempted=true, catalogCompleted=true, catalogPhase=first-call, catalogReply=held, modelRequests=3, cleanup=true, traceLimited=true, and metadataFailure={epoch:1,stage:credential,code:held,elapsedMs:8679,deadlineExpired:false,aborted:false}. The original log was read through the official job-log endpoint. This is an actual completed refusal with confirmed fixture cleanup, not evidence of a timeout or a still-running catalog RPC.

The diagnostic records the outer credential stage, not the exact failing branch. Current/auth/config revocation and original process-custody loss can also raise held there. The following source defect therefore explains a supported failing input and is consistent with this run; the actual branch and native repair remain unqualified until the unchanged real gate executes. The prior successful/cancelled probes and unknown-variant cancellation are preserved as separate original outcomes. No failure is assigned to the cancellation merely because it preceded the catalog.

Primary source is the official anomalyco/opencode tag v2.1.4, resolved through GitHub to commit68bc26b7da1990ce10ffecfbc1e09eb13aa5d824:

| Exact primary path / blob | Relevant native behavior |
| --- | --- |
| packages/core/src/config/plugin/provider.ts / 21a1a87edb84544120c69b58ac5bbdf9188bc562, lines23–42 and54–76 | A configured provider gets a same-ID integration and a plain-key method if absent. The configured provider is enabled; this transform does not add integrationID to its provider row. |
| packages/schema/src/provider.ts / 6306eb374d91b4c45768ed76cd3fbda33d2378d1 | integrationID is optional; Info.empty(id) omits it. |
| packages/core/src/provider.ts / b4f88d649d1b8e34434b715fe05e61a4c754b52b, lines448–469 | Native availability resolves the integration using provider.integrationID ?? provider.id, then respects provider activation and original connections. |
| packages/server/src/handlers/provider.ts / ab9c2201a5eea69a943b47cf871aec49ada22e14, lines12–15 | The public provider-list handler returns that native available-provider projection. |
| packages/core/src/aisdk-native.ts / 9bbbbd66a463ece24411b61fda8579d76d99e15e, lines24–54 | The configured AI SDK package translation changes package/options/model fields; it does not manufacture an integrationID. |

Primary links: https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/config/plugin/provider.ts and https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/provider.ts. F's original runtime.lock pins engine2.1.4; the official tag source explains its declared contract. This read is not a new measurement of the original runner's installed engine bytes.

F OpenCodeV2SessionCredential.ts8a2a46db5175467a7e152bce2415f2a9f89ffd47 lines35–39 currently chooses catalog.provider ? catalog.provider.integrationId : same-ID-directory-integration. Thus a valid already-present configured provider without the optional explicit integrationId refuses, whereas an absent provider can use the original same-ID fallback. D's original native catalog projector preserves an absent integrationID as absent; it does not invent a relation. This defect is independent of any inference about when the original runner's native inventory became available.

### Second review — minimal selector and retained authority

Keep the original selected providerId, captured credential scope, catalog read and post-read current check. Retain a present native catalog.provider.integrationId as the selected explicit reference. Only when that explicit reference is absent, consult the same original owner's readDirectory and accept the entry whose native integration id exactly equals the original providerId. Preserve the existing held result when no such entry exists.

Use the existing pinned D directory decoder: it already validates the original location, finite row bounds and unique native integration IDs. No name/description similarity, first-row selection, ambient provider, remembered connection or generated integration is admitted. A foreign-only directory, wrong location, duplicate native IDs or missing integration cannot authorize a key POST.

An explicit native integration reference is never replaced by the implicit fallback after its own read/connect fails. A legitimate explicit integration ID may differ from providerId; the original native reference remains authoritative and the existing key client still checks that exact ID/location. A missing or foreign readback for that explicit reference remains a refusal; a same-ID directory entry must not rescue it. Preserve original error types rather than translating every native refusal into held.

All subsequent operations are unchanged: captured.readKey, the existing same-account/source/config guards, the actual key client's empty-before/plain-key check, one original connect attempt and exact credential readback, disposal, final current check, and the memoized preparation Promise. No new transport option, permission, credential journal, publication, session, prompt, timer, polling loop or automatic retry is introduced. The fallback is a finite existing read route under the same native owner, custody checks, abort signal and absolute deadline. Metadata and model-probe callers share this correction; it does not bypass their original authority or start P05 §16B.

### Exact two-file source scope

| Existing F path / exact preimage | Planned change |
| --- | --- |
| packages/legacy-agent-host/src/adapters/providers/OpenCodeV2SessionCredential.ts / 8a2a46db5175467a7e152bce2415f2a9f89ffd47 | Select the explicit integrationId when present; otherwise use the existing exact same-ID directory fallback. Preserve every original check/await/dispose/once boundary. |
| packages/legacy-agent-host/tests/opencode-v2-credential-scope.test.ts / 1e1ff69f27fb937eab506d8590c6368393d735e1 | Extend the existing credential publication/rollback case with the session-credential selector and actual pinned owned/key clients against a finite TEST loopback peer. Keep the existing source-file/foreign-key/rollback assertions. |

Both preimages were reread at current working parent2249be257b28e1b3aaf7fdb5a1cc70fb7d115d13 and match the actual591 source. The TEST peer supplies only synthetic native envelopes and TEST keys; this is a protocol/selector regression, not a native-engine or authentication qualification. It does not replace the captured process/native gate.

The existing case must distinguish: (1) present configured provider with omitted integrationId plus exact same-ID integration succeeds; (2) absent provider retains its prior exact fallback behavior; (3) a valid explicit native reference remains authoritative without a directory fallback; (4) missing and foreign-only implicit integrations refuse before any key POST; (5) a wrong-scope or wrong-ID explicit readback refuses without falling back to an available same-ID row. Retain exact original location/request accounting and one connect per accepted original preparation; repeated prepare calls return the original Promise and do not repeat reads or POST. The real original auth.json bytes remain unchanged by native preparation. Use normal client disposal and TEST listener cleanup, no module/global fetch monkeypatch or vendor/source rewrite.

### Third review — checks and actual acceptance

After plan publication, prepare only these two source candidates, obtain independent source review and send exact preimages/final blobs/readbacks to root. Root alone publishes/consumes the coherent dependency cut. The earlier D68 change does not repair this F selector and its successful checks are not transferred to this change.

Run the existing credential-scope test file, Host build/test types, relevant fast lint and source-size/diff guards when the authorized setup slot and complete ordinary installation are available. If execution is unavailable, keep the candidate explicitly source-only and let ordinary candidate CI perform required checks; do not use partial node_modules or substitute declarations. Preserve prior install137 outcomes and original native failure.

The next already-required existing opencode-v2-model-probe.native.ts gate must complete its original catalog/model/default/variant assertions, repeated metadata reads, model request accounting and physical cleanup with unchanged budgets and inputs. No new native experiment, job, matrix, cap increase or timeout is authorized here. Only that observed result can qualify the native catalog path; source review alone cannot identify the original held branch or mark frontend/Team readiness complete.

## 66. Isolate inherited Linux descriptors in an explicit captured child launch chain

This is a plan-only Linux Stage1 correction based on the original85ee Desktop failure, appended to exact P09 blob2014abaf02438fea939428cb89e29470d5b9bb63. The source review base is native working200892cfc18845ed8a9f3b736f8eb73e7cd42e0c; parent e29dbde300ea73ec4e46e5f57f9e007ca5473552 has separately identified Host-client/profile variants. Later P10-only working updates do not change these preimages. No source, default activation, native experiment, CI restart or qualification follows from this plan alone.

### 66.1. Actual failure, required coverage and independent open claims

The retained linux85-3 artifact identifies the same original CDP listening socket inode24086 in Electron Main5454/fd61 and fixture MCP builder Node5552/fd61. The existing closed observation says fixtureMcpBuilderEntry=true, Host=false, and closeOnExec=false. This is an actual builder inheritance observation. It is not evidence that this holder was the Host, that a runtime input ran, or that prebuilding the MCP bundle would correct later child launches.

The exact current path is WorkspaceMcpBundle.ts37b559838b774022fb5bd94400a55ee590b5a67d: its buildCurrentBundle calls execCli with the selected Node and original tsup entry, source fingerprint, private output generation, cwd and original120s timeout. That actual build must remain in the journey. Main's later Host version probe and Host allocation can inherit the same descriptor. Independent source review also found the original shell-environment child, Main-owned MCP HTTP child, its ps census, synchronous Unix ownership ps, and the portable process-start probe. They are part of this correction; fixing only WorkspaceMcpBundle is insufficient.

The existing assertOwnedCdpListener and same-socket/original-birth evidence stay unchanged. There is no permission or sandbox change, stale-process kill, arbitrary numeric-FD operation after a census, prebuild-as-proof, conditional listener-guard suppression, or replacement CDP transport.

This is descriptor isolation before target user code. It does not resolve §47/§50 executable path/content TOCTOU or make a new claim of POSIX race-free image binding. Preserve the actual separate85ee Darwin results: x64 compiler-default baseline refused kernel-image with errno13 before resume and cleanup=true; ARM ad-hoc after-check mutation succeeded but the resumed original image emitted LIB/BIN:A/MAIN:A and exited0, violating the existing strict no-user-instruction-after-mutation oracle. Those assertions, existing Windows original-HANDLE facts and their remaining qualifications are unchanged.

### 66.2. Chosen mechanism and primary source basis

Use one explicitly selected, static Linux-x64 native exec helper. Node still creates and returns the original real ChildProcess. The helper closes unintended descriptors in its own process and execs the original selected program in the same PID. It creates no grandchild, broker, worker, replacement process registry or new cleanup owner. Parent descriptors and descriptor flags are untouched.

This is preferred to a parent-wide close_range(CLOEXEC): a parent call would change a shared Main policy and still leave a creation-to-fork race with other Electron threads. It is also smaller than a new N-API posix_spawn owner, which would replace Node's current ChildProcess/stdio/wait interface. Neither alternative is silently installed.

The source basis is exact and independently inspectable:

| Primary source | Relevant fact |
| --- | --- |
| electron/electron v44.10.1, shell/common/node_bindings.cc, blob87efc4a1a8a8520bebe7b710e4f95743d738577d | The Main environment deliberately enables stdio inheritance. This is not a new option the application can safely pretend was disabled. |
| nodejs/node v24.21.0 and v24.22.1, deps/uv/src/unix/process.c, same blob539e7d9417d3bf9b8e73bc416e1165b0d6d59d65 | Linux child setup handles declared stdio, clears CLOEXEC for intended descriptors, performs cwd/identity/env setup, then execvp. Ignored extra slots do not close arbitrary inherited descriptors. |
| nodejs/node v24.21.0, lib/child_process.js, blob779aebab83183153fea6f5fcbc3ccc339492ee80 | execFile creates a spawn with a finite option projection; it does not forward an extra stdio array. Its callback collector/error/encoding/limits must not be replaced by an assumed extra-fd option. It also does not forward detached. |
| torvalds/linux v6.18, fs/file.c, blob28743b742e3cf65b36227033d4e3ecd643108bd3; include/uapi/linux/close_range.h, blob2d804281554c5cd8379ce07f45e21e6f355d1568 | close_range operates on the calling task's descriptor table, with explicit close versus CLOEXEC modes. Child-only closure avoids parent-I/O mutation. |
| bminor/glibc glibc-2.34, posix/execvpe.c, blob39257d30deb5781e2c689f93619e2d94577f857a | execvp keeps slash-qualified targets, original PATH search and the standard ENOEXEC script fallback. The helper must preserve these original rules, not select a new binary or invent a shell command. |
| GNU C Library release2.34 and official closefrom file-action change | close_range requires the actual supported kernel; posix_spawn closefrom is safe because the child has its own descriptor table. These are mechanism evidence, not evidence that this application has executed the proposed helper. |

Primary URLs: https://github.com/electron/electron/blob/v44.10.1/shell/common/node_bindings.cc ; https://github.com/nodejs/node/blob/v24.22.1/deps/uv/src/unix/process.c ; https://github.com/nodejs/node/blob/v24.21.0/lib/child_process.js ; https://github.com/torvalds/linux/blob/v6.18/fs/file.c ; https://github.com/bminor/glibc/blob/glibc-2.34/posix/execvpe.c ; https://sourceware.org/pipermail/libc-announce/2021/000032.html ; https://sourceware.org/pipermail/glibc-cvs/2021q3/073654.html .

### 66.3. One child, exact target and a closed exec-error channel

The original selected Node or command, original argv0 and argument array, cwd, environment, uid/gid where already used, stdio0/1/2 and original detached/group choice are captured before allocation. There is no new resolver, fallback binary, PATH override, shell quoting layer, environment stripping, PID recapture or post-allocation target substitution.

The parent's original spawn explicitly allocates one private status pipe at child fd3 in addition to the original stdio0/1/2. No numeric descriptor is learned from a process census. The static helper checks its one closed invocation grammar, marks this status descriptor CLOEXEC, calls close_range(4, UINT_MAX, 0), and then calls execvp with the original target and original argv vector. The helper does not fork. Its fixed fd3 is the declared per-allocation pipe, not a guessed external descriptor. Extra intentional child stdio or IPC descriptors are refused before this selected allocation unless a later explicit plan qualifies their exact preservation; they are never silently discarded.

Close-range failure, missing syscall, denied syscall, malformed invocation or status setup failure must prevent target exec. There is no procfs scan fallback, loop closing observed parent numbers, relaxed seccomp policy, retry with direct spawn, or dynamic helper fallback. Linux-x64 is the only candidate tuple. Actual close_range support is required; a version string alone does not turn ENOSYS/EPERM into support.

An exec/setup failure may write one fixed binary status record, no more than16 bytes, containing a constant magic/version, a closed stage and a finite positive errno. No pathname, argv, environment, stack or arbitrary stderr text is authority. Short/error delivery remains unknown. The helper then exits nonzero. On successful exec the status descriptor closes automatically; target code and its descendants do not retain it.

A helper spawn event proves only allocation of that original physical child. Empty status EOF alone is not target readiness: it also occurs if the helper dies before exec. The original Host handshake, original CLI result/exit or exact MCP health/identity proof remains necessary. An early signal, partial/extra/duplicate status, pipe error or uncertain exit retains unknown custody and uses original cleanup. A valid exec errno from the original private pipe can prove target refusal before target effect, but cannot rewrite the fact that the helper child was allocated.

Never emit a fabricated Node spawn/exit/close event or mutate a ChildProcess PID/spawnargs to pretend this was a direct target launch. Inspect existing callers that listen for spawn: that event remains physical helper allocation, while readiness needs the original target-specific evidence. A known helper exec error is delivered through the existing caller's failure-handling branch with this explicit provenance. The original real close/exit events, process group, birth and reap remain authoritative. Streaming owners must not clear the retained child or publish absence merely because the target was refused.

### 66.4. Preserve original exec, synchronous probe and cleanup contracts

The selected-only adapter is a concrete implementation of this one launch chain. It is not a replacement child_process module, a global monkeypatch, an atfork callback, a provider framework or a general process manager. Unselected and non-Linux calls continue to use the original Node functions byte-semantically.

For callback execFile calls, use original spawn plus the private status pipe and a bounded collector because Node execFile cannot receive that pipe. Preserve the actual original option projection, output encodings, success callback values, nonzero code/signal, error code/path/spawnargs where justified, maxBuffer and kill signal. In particular, do not accidentally start a new process group by honoring a detached field that original Node execFile ignored. The existing execCli independent stdout/stderr limits, timeout output head/tail, overflow unknown outcome, cancellation, tracking and killProcessTreeAndWait stay in their existing owner.

The synchronous ps adapter returns the original spawnSync status/signal/error/output contract; fd3 is private and removed from its public output projection. Its original encoding, input, maxBuffer and existing timeout remain. A native target errno is mapped only from the valid original status record. No EOF or helper exit is converted into successful ps output or a fabricated process-absence fact.

Capture each existing finite deadline before selection validation/allocation, and pass only its remaining budget to the original collector/probe. Do not add a fresh handoff deadline, a post-status deadline or a second cleanup allowance. Calls that previously had no finite timer do not receive an invented success timeout. Status parsing is fixed-size and joined to the original child lifecycle. Abort/overflow/deadline races settle the original caller once while original cleanup still owns that same child and group; late status cannot revise a settled result or permit a second target launch.

For CapturedHostClient, retain this.child and its real close Promise before any async handoff observation. The original handshake can be written to the existing stdin and is still required; no helper status becomes Host ready. A proven exec refusal can feed the existing transport failure path, but final child cleanup remains separate. Existing Main Windows retained owner/native transport is untouched.

For shellEnv and the MCP owner, retain their original command/frame or HTTP readiness predicates, error ordering and cleanup. Connect handoff failure to their already captured operation; do not use synthetic child.emit('error') or make an unrelated listener believe no child existed. Existing legitimate fallback is not broadened by a helper error and never falls back to a direct unisolated launch.

### 66.5. Main-only capture, original Host identity and complete bounded launch coverage

The helper selection belongs to the private Main composition. Capture it once from the original trusted Stage1 startup environment together with the existing descriptor selection, before the first Node/shell/MCP probe. It names the canonical private helper manifest and its SHA256. Partial/invalid selection refuses before any effect. Once selected, failed verification never silently selects the ordinary direct path. A new selection needs a new explicit Main composition, not renderer input or mutation of a retained one.

Install this choice at the existing registerDesktopAgentBackend startup boundary. The launch adapters must refuse an explicitly requested but not-yet-initialized candidate before allocating any child, so an earlier probe cannot leak a descriptor while initialization is pending. The known initializeAgentBackendConnection boundary precedes the ordinary Main runtime/MCP bootstrap. Verify that ordering against every actual Stage1 caller before freezing source; no early callback may silently bypass it.

Do not add a field to SelectedHostProfile, its env, capture/digest, Host handshake, provider source hash, old checkpoint or owner receipt. §61's genuine old1d Host whole-owner/profile remains unchanged. Only Main records the separately selected physical handoff. Both old and current Host entries remain the exact original entries passed as target argv; a helper change cannot relabel a checkpoint source or recapture an old runtime. Parent e5bb1558c32a1271fe32c7ff45cd7a1b7f18fe11 and native857bc8a9ca4fc6d5d26770f33f5d57add752df5b profile variants preserve all their original differences.

The source-backed required routes are:

| Original route | Required join |
| --- | --- |
| WorkspaceMcpBundle.buildCurrentBundle -> execCli | The actual fingerprinted tsup build, original selected Node, cwd/env, output generation and120s budget use the same helper selection. No prebuild replacement. |
| McpNodeRuntimeProbe and ordinary binary/version discovery -> execCli | Original command/PATH priority and bounded output are unchanged; no discovery fallback after isolation refusal. |
| AgentTeamsMcpHttpServer.defaultSpawnProcess -> spawnCli | Original ChildProcess/PGID, HTTP readiness/identity and retained Stop remain; helper allocation is not server ready. |
| shellEnv.readShellEnv -> raw spawn | Original shell/mode/nonce-framed env read and original fallback/exit logic join the selected Main launcher. |
| selectedHostProfile.validateHostProfile -> raw execFile --version | Original version probe uses the helper independently of, and before, the original Host spawn. |
| CapturedHostClient.open -> raw spawn | The same selected Node/Host entry and original child owner survive handoff. |
| AgentTeamsMcpHttpServer.execFileText -> raw execFile ps | Original retained-consumer and cleanup census use the same selected callback executor; missing evidence stays null/held. |
| unixProcessTable.readUnixProcessTable -> spawnSync ps | Original synchronous ownership/birth/group census uses the selected sync adapter. |
| Main processStartTime -> task-change-ledger processStartTime -> execFile ps | Pass a narrow optional executor through the existing Main adapter; default portable callers, per-sweep cache and unknown semantics remain unchanged. |

An independent final source inventory must confirm the actual captured Stage1 bootstrap, MCP, Host and original cleanup paths have no remaining unisolated child allocation. It is not enough to assert that all calls use execCli, and a transient ps process is not exempt. Darwin-only xcode-select and Windows-only taskkill are not Linux gaps. Unrelated unselected legacy/SSH/terminal routes are not silently activated or claimed qualified by this finite Stage1 change. If an additional actually reachable captured-Main route is found, extend the exact path list through a bounded plan amendment before editing; never patch a global module to hide the gap. Existing listener checks run through the full unchanged journeys, not just once after startup.

### 66.6. Explicit helper delivery and no implicit activation

Use the existing Linux native-artifact build discipline: canonical pinned compiler/inspector/source, new empty private output directory, input hashes before/after, exact binary hash and immutable manifest. Build a separate static ELF helper and separate helper manifest. Do not change the existing N-API8 library manifest, pidfd behavior, libuv implementation or registered-process authority. The helper is not a new N-API preload.

The inspected helper must be ELF64/x86-64 with no PT_INTERP and no DT_NEEDED. A dynamic loader or LD_PRELOAD must not execute before descriptor cleanup. The original target environment is still passed unchanged; isolation precedes the original target's loader. Record exact source/compiler/inspector/link inputs available to the build, helper bytes and protocol/kernel capability. A missing static toolchain or unexpected ELF refuses this candidate; do not install a dynamic substitute or relax flags. This is a checked build and finite qualification, not a claim that pathname hashing solves executable mutation.

Main validates the exact canonical selected manifest and helper bytes, original file identity, private regular-file shape and executable mode before use. Verification cannot invoke a compiler, inspector child or helper version probe inside Main before isolation. The TEST staging actor performs compilation/ELF inspection before Electron starts. Staging has no authority to launch a provider.

Extend the existing build script with an explicit helper build/export and a closed stage-only invocation. Existing Linux native proof supplies that helper to the original Node26, Node24 and Electron-as-Node runs. In existing Linux Desktop input preparation, carry its pinned reference through the same closed TEST environments into Main appEnvironment. The original Host env/profile remains untouched. qualify-linux-process-cold-ui must explicitly forward and retain the pin because its existing environment deliberately drops unrelated ambient variables; the packed cold route already uses that same function.

The first activation is only the explicitly selected Linux Stage1 candidate under this checked private delivery. No ordinary Main/default/release route, new platform tuple or unknown kernel is enabled by source publication or by the synthetic/native helper case. A packed E2E must state whether the helper is a separately pinned TEST launch input; it must not describe that as a release-packaged helper if the release closure does not contain it.

### 66.7. Exact bounded source scope

All existing rows below were resolved from the native200892 source tree, with separately fetched critical launch paths. Root composes current-parent/child variants and preserves unrelated published changes. No frozen source-size cap is raised; if a file needs room, extract a meaningful existing implementation into the declared helper rather than compress formatting. Additional paths require review before editing.

| Path | Exact preimage | Intended delta |
| --- | --- | --- |
| src/main/utils/linuxChildLaunchSelection.ts | new | New concrete Main-only immutable selection/verification; no Host-profile or public DTO field. |
| src/main/utils/linuxChildLaunch.ts | new | New selected-only same-child spawn/execFile/spawnSync adapters and bounded private exec-status handling. |
| src/main/ipc/agentBackend.ts | f173a19a246418d0c4dd62fa513966993d52bb66 | Initialize the explicit private selection from the original captured startup environment before Main bootstrap probes. |
| src/main/utils/childProcess.ts | 7c01a042f49cc89c430b1d657c66acd59f0b76b7 | Use the selected adapters at the existing execFile/spawn allocation seams; original tracking, groups, output limits and cleanup remain. |
| src/main/utils/shellEnv.ts | f050b6a27640e9c977c7d606d9e4e7b299d737f5 | Route the original shell environment child through the same Main selection; preserve its original frame/exit/fallback rules. |
| src/main/utils/unixProcessTable.ts | b804b51a2df531abf7cefcd3d2947a9e521d0600 | Route the original synchronous ps through the same selected spawnSync adapter. |
| src/main/utils/processStartTime.ts | 3f616321ab5ba08dcd5f25014bf04701dad2abe2 | Pass the selected Main executor through the existing portable probe adapter. |
| packages/task-change-ledger/src/review/storage/processStartTime.ts | d3d917cf269557f3672a49f6d52a5e68cc66bb04 | Optional original-exec dependency only; default portable behavior and original cache/unknown/diagnostic semantics remain. |
| src/main/services/team/AgentTeamsMcpHttpServer.ts | ce7a75fbc1aa249bd4cbd91cd79f38d55c7769d1 | Keep spawnCli ownership; route original ps callbacks and connect known handoff failure to its original startup-failure path. |
| src/features/agent-backend/main/infrastructure/selectedHostProfile.ts | 857bc8a9ca4fc6d5d26770f33f5d57add752df5b | Use Main-selected execFile only for the original version probe. Profile shape/capture/digest remain byte-semantically unchanged. |
| src/features/agent-backend/main/infrastructure/CapturedHostClient.ts | d678b334f9a18a0948939b2b457f73d438e636fb | Use Main-selected allocation; retain exact child before any await and preserve original handshake/failure/shutdown paths. |
| packages/legacy-agent-host/native/linux-child-exec.c | new | New static Linux-x64 helper: preserve 0–2 plus private fd3, close_range child-only, then original execvp. |
| packages/legacy-agent-host/scripts/buildLinuxProcessNativeArtifact.ts | 8abd36f9adc5f3680b736ff1bc7f6edd4e334bfe | Add a separate explicit helper build/export and stage-only entry using existing checked compiler/inspector/private-output discipline; original NAPI manifest untouched. |
| packages/legacy-agent-host/scripts/qualifyLinuxProcessNative.ts | f188de0e7930fbb302adf62d74a1888f09b4d6b0 | Supply the independently pinned helper to the existing Linux proof; retain both original automatic/warm modes and their budgets. |
| packages/legacy-agent-host/tests/registered-process-linux.native.mjs | f198ef77405b34401dadca58038ff79d27f6310f | Extend the existing actual native proof with same-PID handoff, declared high-fd witness, original stdio/argv/cwd/env, exec refusal and cleanup. |
| scripts/legacy-agent-host/desktop-backend-fixture.ts | 805c7b9188c09b060b9ad9ad8313699cb843585c | Read the explicit TEST staged helper selection before Electron launch; do not compile inside Main/Host. |
| scripts/legacy-agent-host/desktop-runtime-source-fixture.ts | b7614e807efc89e393762be8d54857c1961c1561 | Pass helper reference only in Main appEnvironment; never modify the captured Host profile environment. |
| scripts/legacy-agent-host/desktop-backend-smoke.ts | f765fcf27da9ee68be8c61e6d2de017d50dc904d | Retain the existing original launch-chain selection/evidence with unchanged strict listener checks and actual builder/Host flow. |
| scripts/legacy-agent-host/qualify-linux-process-cold-ui.ts | c824e35c0fec25a7109b2efe08b7735b6655ab2e | Carry the already pinned helper reference through the original closed environment into both existing source and packed cold-UI invocations; retain it in the original proof. |
| test/main/utils/childProcess.test.ts | 7315575a858e3758b3639281738ec4f56f42c0da | Extend existing process-boundary cases for callback/error/output/deadline/stdio semantics; no mirrored helper suite. |
| test/main/utils/shellEnv.test.ts | ce308ed87fd46c436ce8db1a8eee66ef982e55d1 | Existing environment-frame case retains exact original command and refusal/fallback behavior under selection. |
| test/main/utils/processStartTime.test.ts | 66627b98dd4bf69d4878a2d197c163a53819e904 | Existing probe case verifies original executor and unchanged unknown/cache semantics. |
| test/main/services/team/AgentTeamsMcpHttpServer.test.ts | e8ca3cd3aae5091f4c47e2df82ee1901de42fc15 | Existing startup/cleanup cases exercise original child and failure path without false readiness. |
| test/features/agent-backend/capturedHostClient.test.ts | 532841c9738606b34db684593810a9aa870d1d24 | Existing client case requires original handshake after handoff, helper crash remains unknown and same child cleanup. |
| .github/workflows/sentry-owned-process-native.yml | 3201d6b60577de31956524885abee3b971609dee | Extend existing Linux native step/receipt checks; no new job/matrix/time allowance. |
| .github/workflows/ci.yml | 6f526607d3416584a936b838ba03108e4ae64e30 | Stage the selected helper in existing Linux Stage1 input-preparation blocks and retain existing E2Es. |

WorkspaceMcpBundle37b559838b774022fb5bd94400a55ee590b5a67d and McpNodeRuntimeProbe3b51c301f18d0d58f51c201398e19e68ba42474d are mandatory read/proof anchors, not planned behavior edits. Parent/native CapturedHostClient variants84e5018bed42c7a0e8465385a484419e1af20b15/d678b334f9a18a0948939b2b457f73d438e636fb must retain their existing private Windows transport difference. The existing Native C registered-process-linux.c841cda775caf1f7618dea59e89267d85c888d158 is not modified to add a global descriptor policy.

### 66.8. One coherent proof cut using existing gates

First compile the exact static helper with the existing strict warnings and inspect its actual ELF. Extend existing process-boundary cases, not a duplicate generic framework suite, to distinguish: unchanged unselected behavior; original selected target/argv0/PATH/script fallback/cwd/env; intended stdio0–2; callback/encoding/maxBuffer and original code/signal; missing target and permission refusal; malformed/short/extra status; helper death before exec; cancellation while original child exists; one settlement; and unchanged original cleanup. A status EOF plus a crashed helper must not pass a target-ready or process-absence assertion. Verify execFile's actual non-detached behavior and spawnCli's original detached group separately.

Extend the existing Linux native gate with an explicitly owned high descriptor, passed through documented raw TEST stdio into the helper to reproduce a non-CLOEXEC inherited fd above a gap. The production adapter still rejects extra intentional stdio; this TEST injection proves the native close primitive rather than granting a product descriptor exception. Original parent file/socket state remains usable. The selected Node must demonstrate same ChildProcess PID, original argv/cwd/env and ordinary stdio, and absence of the exact inherited descriptor identity before its first TEST action; its original descendant must not regain it. A reused fd number for a different new target resource is not the original leaked descriptor; likewise a newly opened target fd3 is not the closed private status pipe. Do not manipulate an arbitrary FD learned from a census. Retain the original pidfd/automatic/warm/cold and cleanup assertions. The existing per-run45s bounds and CI step/job limits remain.

Then run the already-existing Linux SDK -> cold Host Processes UI -> packed cold Host path in sentry-owned-process-native.yml, and the existing Linux retained-source Desktop lane in ci.yml, with the one coherent helper/consumer/fixture cut. The actual WorkspaceMcpBundle build must execute through the selected chain; the first shell/version probe and the later Host also use it. Existing strict original CDP listener checks must remain positive throughout startup, UI, rebind and cleanup. Require real Host handshake, original Processes Stop/history, original source-selection A continuation/Stop/B launch and existing cleanup; a direct helper proof or unchanged Node test cannot substitute for those UI/Team gates.

Use existing observations, immutable original source pins and receipts to bind helper selection and the original target, never a second process census as mutation authority. Keep diagnostics closed and bounded; no raw env/argv/error payload is added to public logs. Do not add a new job, matrix, business input, runtime experiment, polling loop, request cap or timeout increase. A new failure is retained and investigated under the same review rules, not hidden by prebuilding, another PID, direct fallback or a weaker listener oracle.

### 66.9. Review, delivery and acceptance

Before source GO, root and independent peers review the exact helper protocol, Main-only selection, complete finite launch map, callbacks/synchronous semantics, original custody/deadlines and existing native/actual-Electron gate placement. Source implementation then produces exact per-path preimages/final blobs/line counts and readback equality. Root alone publishes the coherent child candidate, composes shared parent/qualification variants and lets original active CI finish normally. There is no direct-main/upward merge or default activation based on this plan.

Required checks are strict helper compilation/ELF, Host/Main and relevant script/test types, existing focused tests, lint and source-size/diff guards, followed by actual exact-head native and original Electron journeys. If execution is unavailable, all prepared source remains explicitly unexecuted; no stale environment or earlier Windows/Linux PASS transfers to the new helper. Any residual FD holder, ambiguous exec/cleanup, incomplete original UI result or unsupported tuple leaves this Stage1 fix unqualified. §47/§50 executable stability and other provider acceptance remain independent even after all §66 descriptor-isolation gates pass.

## 67. Genuine old Claude checkpoint: derive the original launch base from its persisted capture

### Review 1 — actual original-producer failure and source-backed distinction

Parent e29dbde300ea73ec4e46e5f57f9e007ca5473552, run43497088359/job132132912191, reaches the original old1d Host checkpoint and fails before Quit at desktop-claude-checkpoint-upgrade.ts281. The validated journal's baseConfigurationDigest is1a6bbe8d787715f95fdf357ed99f8dc321f400e46d63e93626a112957b16d142; hashing the fixture's static profile seed gives941e571600916e6f531680f54a84e053b1cf6dcc93b6419d85f614f504b17d36. These are TEST-specific digests. No cold current-Host Resume has passed in this run.

The current proof30df6c1a60b6ce37e64502551925dda99d07bc77 uses the static currentProfile.runtime.members seed as the launch base. Exact old1d source distinguishes that seed from a configured capture: RuntimeTeamCaptures.ts compiles the persisted capture and installs its compiled profiles; createMemberEntry retains that compiled baseProfile; createRuntimeTeamLaunch hashes entry.baseProfile. runtimeCaptureSource.ts compileRuntimeMemberProfile applies original saved choices, cwd, native instructions, capture session/principal/config revision and generation. Therefore seed equality is not the correct general oracle for an original configured Launch. This is a source-established proof defect; the actual journal's optional capture branch must be validated before selecting a reconstruction.

Reference all old code at immutable1d0f97f55de566036c970eab4f36b84620afdb3f under packages/legacy-agent-host/src/composition: RuntimeTeamCaptures.ts, runtimeCaptureSource.ts, createMemberEntry.ts and createRuntimeTeamLaunch.ts. Do not infer which fields differ from two hashes or transplant a newly generated capture.

### Review 2 — one TEST proof, same original persisted inputs

Only change scripts/legacy-agent-host/desktop-claude-checkpoint-upgrade.ts after the existing original launch-file read and its old validator succeeds. Select the original base by the validated journal structure, never by trying candidates until a hash matches:

- If definition.capture is absent, use the exact old validator's original static member, requiring the same member/provider/executable identity as the already-equal old/current profile.
- If definition.capture is present, parse it with the exact old1d runtimeCaptureSourceSchema and use its original compileRuntimeCapture on the same old profile and original Team definition. Require the persisted capture's exact original launchId/roster/member relationships and exactly one compiled member for the selected source binding. Before calling the compiler, require exactly the original one-member capture and its complete persisted mcpRecipeReferences; each original reference must bind that member. Missing references remain failure, so the compiler cannot fall back to recapturing ambient MCP configuration. The existing compiler then reads only original digest-bound MCP recipe artifacts; do not call captureRuntimeSource, captureRuntimeMcp, a model/native probe, a writer or any new input. Require the original namespace/launch parents to exist before this metadata reconstruction; missing paths remain failure.
- Require the reconstructed original base digest to equal the journal's unchanged baseConfigurationDigest. Reuse that exact original base in the old applyLaunchConfiguration plus persisted preparation/runtime generation check. Keep the full configurationDigest, source config/session/generation, original attempt/claimed/noAllocation, owner/profile/executable, handle, checkpoint bytes, SDK/native versions and history prefix assertions. No comparison is deleted or replaced by the value it is meant to verify.

Retain all original source/archive/compiled-module pins, original old Host ONE input, original Quit/physical absence/writer release, current Host cold Resume TWO input and unchanged whole-owner/profile identity. The current Host must independently accept the original persisted capture and checkpoint; this TEST correction cannot repair or bypass a product restore refusal. Do not rewrite the journal/profile/checkpoint, fill an absent old field, substitute a current capture, or change the original budgets/counts. No new production capability, migration or synthetic old checkpoint is included.

### Review 3 — exact existing cold E2E

Root publishes this plan before source. A peer checks the two finite journal-structure branches against exact old source and confirms reconstruction is metadata-only and follows original identity. No new unit suite or additional native journey is needed. Existing Host/script types and the original old1d-to-current cold selected Resume job remain the qualification gates. Source review does not establish which actual field caused the old digest mismatch or qualify Resume; the next ordinary exact-head E2E must still pass every original byte/owner/cleanup/input assertion.

## 68. Original current-frontend stopped producer: retain bounded catalog-read timing

### Review 1 — actual evidence, with no guessed production fix

Parent e29dbde300ea73ec4e46e5f57f9e007ca5473552 run43497088359/job132132912556 fails the original stopped-producer oracle at desktop-stopped-import-prior-run.ts199 while the original Optional launch settings control is being opened. The closed diagnostic establishes at least9 catalog GETs against the unchanged8 cap, zero business inputs and zero model probes,20 captured native children, frozen source and successful original cleanup. It does not identify the caller or prove a frontend retry loop. §63's bodyless preconnect correction did not by itself resolve this separate catalog failure.

captureCurrentStoppedSourceInputs7ec419 confirms this producer executes the actual current checkout and its pinned ordinary runtime0.0.158, with no Host descriptor. It is distinct from donor4a and the old1d checkpoint producer. Current useTeamModelProviderStatus fca15, cliInstallerSlice3958 and ClaudeMultimodelBridgeService68e89 show project-prefetch, original epoch/in-flight joins and summary/catalog hydration, but the retained log does not yet distinguish duplicate view reads, an unhealthy episode, source-scope changes or expiration. Do not add a guessed cache, suppress a real readiness check, replace explicit model selection with a default, or alter the frozen native payload.

### Review 2 — only original observations, no new work or authority

Expose the existing currentLegacyCatalogRequests scalar through a read-only TEST getter from the already-created model fixture. It returns its original counter; it cannot reset the counter, create an epoch, perform a request, or change response/failure behavior. Keep the exact8 catalog cap, first-failure seal, method/path/key checks, bodyless HEAD32, token/probe/business budgets and all original responses unchanged.

At the existing desktop UI step callback retain the already-known phase and that scalar alongside the existing step. Do not add a new CDP read, listener, timer, native command, retry or user action. On the original failure, project at most the existing13 literal producer phases into first/last observed catalog counts, plus the current count. Keep only finite0..9 counts; malformed observations are unknown, not success. The existing structured assertion frames and catalog/native/probe/cleanup fields remain. Never print original selector, label, DOM text, argv, environment, HTTP headers/body, paths, process identities or raw errors in this diagnostic.

Move the existing small failure projection into the already-used stopped-import fixture module to keep the800-line prior-run file below its unchanged cap. The helper is a pure projection of existing observations. It does not perform discovery or cleanup and cannot change the outcome. The existing4096-byte closed diagnostic ceiling, original throw/finally, source-freeze, actual Stop/Quit/absence and consumer acceptance remain.

| Path | Exact preimage | Change |
| --- | --- | --- |
| packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts | 009a990eb188b4eb54b1d8486a0adcaa7a48b25e | Read-only getter for the existing original catalog scalar only. |
| scripts/legacy-agent-host/desktop-stopped-import-prior-run.ts | e8790566e5a1eebdeef005234d657e0824d0a84b | Enrich existing UI step observation; call pure failure projection, retaining the same original failure and cleanup. |
| scripts/legacy-agent-host/desktop-stopped-import-fixture.ts | 7ec419a5803e29b9b03fe4bda3b37243af3db0a8 | Existing module owns the bounded pure closed projection; no new framework/module. |

### Review 3 — qualification boundary

Root publishes this plan before source and obtains independent review of the narrow getter/projection and unchanged oracle. Reuse the existing source-size/types and ordinary stopped-import E2E; no new unit suite, native journey or diagnostic-only rerun. The observation change travels with the next coherent reviewed repair cut after active CI completes. Its output is diagnostic evidence, never PASS or evidence that catalog requests are legitimate. Use the actual phase/count observations and retained original source to choose any subsequent product correction under a separate reviewed plan. The producer and full Host-import E2E remain incomplete until their unchanged assertions actually pass.

### 66.10. Retained legacy-A startup preserves the original absent descriptor choice

The delivery audit found an existing finite branch, not a new product mode: desktop-retained-opencode-coexistence.native.tsa6406ec's original epoch0 deliberately removes both Host descriptor environment fields while keeping the same actual Main frontend and retained V1 A. The later Host epoch and both source-selection journeys use the captured descriptor. Selecting the descriptor-isolation helper only when a Host descriptor is present would reject the original legacy-A half or leave its Main children unisolated.

Clarify §66.5: capture the original **nullable descriptor pair** together with the explicit helper pin. Exactly both descriptor fields absent is a legitimate original composition choice for this retained legacy-A epoch. Exactly both present preserves the original Host descriptor choice and its existing validation; a partial pair is refused. Bind the original pair's exact values before the first asynchronous effect and require the same choice during initialization/re-entry. Do not infer the pair from a later boolean, current Host, UI state or changed environment.

This does not activate a helper by default. Its separate manifest/hash pair must still be explicitly present, valid, immutable for the original Main composition and verified before every selected child allocation. Once requested, failure remains refusal with original custody; an absent Host descriptor is not permission to fall back to a direct unisolated launch or clear the helper pins. No Host profile, digest, checkpoint, source selection, renderer API or legacy runtime binary changes.

Only the already-declared linuxChildLaunchSelection.ts and its agentBackend.ts initialization call need this precision; the original retained runner's intentional descriptor removal is preserved. Existing selection/child tests must distinguish absent-both, present-both, partial pair, drift and unchanged unselected startup. The same original retained V1-A → Host-V2 controls and the two source-selection journeys remain the actual gates, with no added journey, business input, budget or timeout.


### 66.11. Standalone SDK baseline and selected Main acceptance

The existing `qualify-linux-process-sdk.ts` (865401e9e925d34d97c792a62fa345a9d85f0f80) instantiates `CapturedHostClient` in an ordinary Node process; it does not call Main's `registerDesktopAgentBackend` or install Main's helper selection. Passing the retained TEST helper pin through its workflow is not evidence that this standalone SDK allocation used the helper. Keep that original SDK custody/Stop scenario unchanged as the unselected baseline. The selected helper's actual Main builder, version, shell and Host chain is qualified by the existing cold Electron, packaged cold Electron and retained OpenCode UI lanes, together with the existing Node/Electron native helper proof. No SDK qualifier path, activation mechanism or extra input is added. Preserve the original SDK receipt and require all downstream original UI receipts independently.


## 69. Saved effort and native Claude default are different assertions

### Review 1 — exact failing boundary and original selection

Parent e29dbde300ea73ec4e46e5f57f9e007ca5473552 / CI43497088359 / job132132912621 fails at desktop-stopped-import-ui-smoke.ts60: the genuine no-tool request contains requestedEffort='high', while the imported donor setting is absent. The earlier checks of every completed management receipt, including row.effort===undefined, have already passed. This is not evidence that import wrote an explicit effort. Keep the existing persisted-owner omission, source-byte, receipt-selection and no-native-Team-input assertions.

The donor fixture80c2794255b280c411c0a09c752f6e5d1ca50187 selects exact claude-sonnet-4-6 and requires omitted saved effort. Current fixture21497c9884e85c7cd34d682d07fe923781b1de8e supplies a clean private native account/environment with no effort override. D model-probe57fdf89754d1592511a9acf264859282e9745d4f passes an SDK effort option only when the captured request contains it; Host teamLaunchModelProbe6ae19ee22a00c21fd748f5a4d6b283bfaa0702f5 likewise preserves omission. The CI setup pins @anthropic-ai/claude-agent-sdk0.3.305 and the Darwin ARM native executable ea3ea3c08d2a9634a4651e687fcf900d410c489bce2b00f22bd7352b91ba704f before this journey. Native wire defaulting does not mutate those saved choices.

Official references, read2026-11-13: [Claude Code effort selection](https://code.claude.com/docs/en/model-config#adjust-effort-level) states that unset configuration falls through to the model default; [Sonnet4.6 effort](https://platform.claude.com/docs/en/build-with-claude/effort) identifies high as that model's default. These current documents corroborate the exact pinned native observation; they are not qualification for another native version, account or model. No API call, native input or version upgrade is added to discover a default.

### Review 2 — finite TEST correction with saved-state checks retained

Add one pure helper in the existing desktop-stopped-import-fixture.ts. An explicit selected effort must remain exactly that value. Only omitted effort for the exact already-pinned claude-sonnet-4-6 fixture maps to expected native wire effort high; an omitted value for any other model fails instead of receiving a generic default. This is an expected-output assertion, never a saved-setting normalizer, product policy or value derived from the observed request.

Use that helper for the existing model.probes[].requestedEffort assertion in desktop-stopped-import-ui-smoke.ts and the original business observation in desktop-stopped-import-launch-ui.ts. Keep management row.effort compared directly to the saved selection, and keep all owner/import/source checks directly compared to the untouched donor bytes. The same shared preflight helper covers the actual donor saved-only consumer and the actual-current stopped source; the latter's separate producer/catalog failure remains open. Synthetic fixtures with explicit low remain unchanged.

Extend the existing single model-proof case in desktop-stopped-import-fixture.test.ts: omitted saved/receipt effort with the exact expected native high passes; a receipt rewritten to high, wire omission/wrong effort, unsupported default model, explicit-selection mismatch, held/cancelled/duplicate/over-budget checks and any Team input still fail. No new test suite, native request, capture, job, timing allowance or looser set of accepted wire values.

Exact four source paths, all under scripts/legacy-agent-host/: desktop-stopped-import-fixture.ts69d65c32aa4254900bbefa1826fbb5fedf9ab3e5; desktop-stopped-import-ui-smoke.tsd8547bfc505a7b81fd368cbabec661e4d539d6f4; desktop-stopped-import-launch-ui.ts95e2f90cf84f8a25a43486113433a684ecdcf32c; desktop-stopped-import-fixture.test.ts70dc7fb47c650111c6686131a4bb30ec18793195. No donor checkout or production file changes.

### Review 3 — acceptance remains the original journeys

Publish this plan first, review the exact four-file delta independently, then publish the coherent source. Require existing types/source-size and the focused original test plus actual unchanged donor import/reload/no-allocation and stopped-source fresh Host Launch/Stop/reload on the corrected head. Missing saved effort must remain absent after import and reopening, and the original native request counts, no-tools boundaries, selected model, manual permission, effects, physical cleanup and cold replay refusal remain exact. Source review is not a native PASS; the earlier producer/catalog issue must still be resolved before the stopped-source journey can pass.


### 66.12. Preserve the three source variants without importing unrelated native code

The root preimage inventory on the working branches confirms that the parent and qualification branches do not contain buildLinuxProcessNativeArtifact.ts, qualifyLinuxProcessNative.ts, registered-process-linux.native.mjs or qualify-linux-process-cold-ui.ts. Those existing NAPI/registered-process qualification paths belong to the native child. Do not copy their unrelated implementation upward as part of this shared fix.

On the native child, retain the original NAPI builder export byte-for-byte and add the reviewed static helper export/explicit CLI in that same existing builder file. On parent and qualification, create the same named builder path with only the exact common file/hash validation, static buildLinuxChildExecArtifact function and explicit helper CLI. The native-only qualifier, native proof and cold-UI file stay only on the native child; the unchanged parent/qualification Sentry files remain Windows-only. The shared helper code and C source must match across all variants, while the existing retained OpenCode prep (and qualification Codex login prep) calls the same reviewed explicit builder CLI. This uses the already declared source paths, with no additional package dependency, NAPI import or new execution lane.

Compose each shared delta against its own current full blob. The distinct bases are selectedHostProfile parent/qualification e5bb1558c32a1271fe32c7ff45cd7a1b7f18fe11 versus native857bc8a9ca4fc6d5d26770f33f5d57add752df5b; CapturedHostClient parent/qualification84e5018bed42c7a0e8465385a484419e1af20b15 versus natived678b334f9a18a0948939b2b457f73d438e636fb; desktop-backend-fixture parent21497c9884e85c7cd34d682d07fe923781b1de8e, qualification90322b1beff9473dd6f7a6e6bc85a92effe380ab, native805c7b9188c09b060b9ad9ad8313699cb843585c; desktop-runtime-source-fixture parentb2c8feea489fc814025cff6f6fcebcf326422805 versus native/qualificationb7614e807efc89e393762be8d54857c1961c1561; desktop-backend-smoke parent256530edb7a0e06bc06b1c14cc9ebd8dd7f51ee9, qualification8e6f18b1b91439cb7932db2edcfc2339166437c0, nativef765fcf27da9ee68be8c61e6d2de017d50dc904d; capturedHostClient.test parent/qualification7ee59e4badbaada6b9372f9741b744b9d31bd049 versus native532841c9738606b34db684593810a9aa870d1d24. Preserve all original private Windows, source-selection, checkpoint and login behavior. Recheck actual preimages at publication; the frozen manifest must give each final variant explicitly.

No full-file replacement may silently import child behavior, and no working-source composition is a qualified upward PR merge. Independent source review and the original exact-head required/native/Electron checks remain mandatory.

## 71. Restore the original Desktop fixture type gate without changing its journeys

### Review 1 — exact CI diagnostics and current source

Parent e29dbde300ea73ec4e46e5f57f9e007ca5473552 / [validate job132160940412](https://github.com/777genius/agent-teams-ai/actions/runs/43497088359/job/132160940412) reaches the original typecheck:legacy-host-scripts gate and fails on three source shapes: the checkpoint interface parameter shadows the imported checkpoint reader (TS2502); the runtime-source fixture spreads a schema JSON settings value without proving it is an object (TS2698); and two source-publication predicates use an optional selected row without a direct nonundefined guard (TS18048). These are compiler failures, not native qualification or permission to skip the fixture gate.

The current checkpoint source is25f998ff3e5725f42a1450205dc80d4d0e6d7b34 after §67. Runtime-source fixture bases are parentb2c8feea489fc814025cff6f6fcebcf326422805 and native/qualificationb7614e807efc89e393762be8d54857c1961c1561; pending §66 adds only the separately selected helper input to their own variants. Source-selection is64a6264ded31b6ba0990a67d55b8643c9dd97aec. Preserve all three full variants and the independent §66 patch when composing.

### Review 2 — three finite corrections

1. In scripts/legacy-agent-host/desktop-claude-checkpoint-upgrade.ts rename only the beforeQuit interface's checkpoint parameter. Its type must continue to be Awaited<ReturnType<typeof checkpoint>> of the original imported reader. This changes no JavaScript, reader, record, callback argument or checkpoint equality.
2. In scripts/legacy-agent-host/desktop-runtime-source-fixture.ts retain the existing settings value in a local variable and assert that it is a nonnull object and not an array before spreading it. Preserve every original setting and replace only the same TEST baseURL with the original /host/v1 endpoint. Do not cast unknown JSON to a record, silently replace it with an empty object or accept a different native configuration.
3. In scripts/legacy-agent-host/desktop-runtime-source-selection.ts require selected to exist explicitly in each of the two existing publication predicates before reading commandId/revision. The original optional comparisons already reject an absent row for both null and string version selections; this expresses that same condition directly for the compiler. Preserve original poll/deadline, index cardinality, original command and revision identity, management receipt and cold readback checks.

No production source, public DTO, new test suite, native call, UI action, retry, timeout, request count, source pin or original assertion is removed or relaxed. Existing malformed settings still refuse; the correction makes the original object expectation explicit.

### Review 3 — publication and acceptance

Publish this plan first, independently review the exact three-file delta, then publish it with the current reviewed source cut and its exact variant preimages. Run the unchanged legacy Host script typecheck and original source-size gate; the actual checkpoint and retained OpenCode Install/Refresh/Update journeys remain required on the resulting PR head. Local memory exhaustion is not a typecheck PASS. No new unit case is needed for the erased parameter rename or equivalent narrowing predicates; the unchanged original fixture/native gates exercise the runtime object assertion.


### 66.13. Freeze the six shared launch sources in the existing Desktop proof

#### Review 1 — exact omission and evidence boundary

The composed §66 inventory (`24f004b3ae9d3c87e789773a5a612f01283d0e5a`) contains six shared launch sources absent from `scripts/legacy-agent-host/desktop-proof-sources.ts` (`ee554279a5388d33585f5bff9ec4fc15f5f31aca`) and its three imported rosters (`1a72f3be239ab78351a33a2e0bab1813bd62ca5e`, `6f3dad8e7f0bc576754260563b52d0fe77b2b28a`, `74b128c5701ae5a384bcc2863412c8fd336469de`). The existing `desktop-source-freeze.ts` (`da5d5319b7514c85aaafa18aba8043793826b361`) hashes only enumerated files before the proof and at the original flow/cleanup checks.

The existing `desktop-captured-app.ts` (`c6a1e564219df097148671f2440a130657662e48`, lines230–234) separately captures compiled Main/preload bytes after startup and explicitly does not claim a reproducible source-to-bundle rebuild. That compiled evidence and the separate helper manifest/binary pin do not freeze omitted repository sources. In addition, the reviewed TEST runtime fixture and smoke import `linuxChildLaunchSelection.ts` directly. This is a finite source-evidence omission; it is not evidence of a changed executable, a completed native qualification or a new runtime authority defect.

#### Review 2 — one existing roster, exactly six entries

The root roster already has 797 physical lines, so adding six separate entries there would exceed the existing 800-line limit. Keep that file unchanged. After publishing this amendment, change only the existing `desktopProofProcessSources` array in `scripts/legacy-agent-host/desktop-proof-supplementary-sources.ts`, preimage `1a72f3be239ab78351a33a2e0bab1813bd62ca5e` (146 lines before this six-line addition). The root roster already imports and spreads this array at its original position. Add these six exact paths there, retaining every previous entry and its order, with no formatting compression or cap change:

- `src/main/utils/linuxChildLaunchSelection.ts`
- `src/main/utils/linuxChildLaunch.ts`
- `src/main/utils/unixProcessTable.ts`
- `src/main/services/team/AgentTeamsMcpHttpServer.ts`
- `packages/legacy-agent-host/native/linux-child-exec.c`
- `packages/legacy-agent-host/scripts/buildLinuxProcessNativeArtifact.ts`

All six exist in the coherent parent, native and qualification variants after §66.12. The existing source freeze must hash the builder actually present in each branch; the shared-only builder and native builder remain distinct as already reviewed. Do not add native-only qualifier, native proof or cold-UI paths to this shared roster. No glob, directory scan, new roster module, native allocation, mutation, observation event, retry, timing allowance or workflow change is introduced. The original proof and its existing failure projection consume the same finite list.

#### Review 3 — verification and limits

Independently review the six-entry delta, verify that removing exactly those entries recovers the complete preimage, and verify each path against the corresponding composed manifest. Existing duplicate removal, all source/compiled/helper checks, every original assertion and cleanup boundary remain unchanged. The normal existing Desktop journeys must produce the expanded before/after source evidence on the actual candidate head; source review alone is not that execution result. This closes only the enumerated-source omission and makes no new source-to-bundle reproducibility, Linux native, default activation or §47 executable-race claim.


## 72. Retain configured preparation across its validated original Skip

### Review 1 — actual failing step and source cause

The original parent head `e29dbde300ea73ec4e46e5f57f9e007ca5473552`, run `43497088359`, Host shard job `132160940504`, reports 1225 passed, one failed and two skipped tests. The sole failure is the existing `runtime-team-host.test.ts` case “selected checkpoint resumes through a new Host/generation, retains Team delivery ownership and fences stale controls”. Its assertion at line 2546 receives `{ok:false,code:'hold',outcome:'unknown'}`. That line checks the original `team.member.action.prepare/execute` Skip loop after the configured launch, real original input, checkpoint and awaited Stop. It precedes `f.restart()` and the first Restore request. Do not describe this observation as a failed native Resume or change the checkpoint compatibility proof to hide it.

The exact source chain establishes a deterministic refusal after genuine Skip publication. `memberActions.ts` (`011bcd1aae9f8b8f28ade0218016fd0741923818`) validates that a Skip changes only `skipped:false` to `true`, retaining the original binding and all other selected-member fields. Its `publish` method writes that exact selection, its roster/fingerprint, the original action attempt and the action's `selected` phase. `transitionRuntimeMember.ts` (`f500cf8f3d1c957d76ec206a7d54d9bad537b9b8`) retains original Stop, released custody, provider/endpoint retirement and authority checks before publication; its final action lookup reloads the launch record. `validateLaunchPreparation` currently rejects `selected.skipped` unconditionally, although the original configured preparation is deliberately retained. The original error wrapper in `createTeamMemberActionMethods.ts` (`8e9eacad398e6576cde4e56257726f722c7f6e40`) maps that refusal to the observed held/unknown result. An intervening existing authorized reader may encounter the same invalidity sooner; the final lookup alone is enough to prove the source defect. The original log does not identify the first internal reader.

Reuse the existing validated record rather than adding a second lineage pass. `validateLaunchRecord.ts` (`f53a249f6597bba3502c3071da69676eeb171141`) calls `validateRestoreJournal` before preparation validation; `validateRestoreJournal.ts` (`198a88cdb54fd69360b979baf762a4f9ed326f4f`) validates the combined member-selection chain whenever action rows exist. `FileTeamRuntimeBindings.ts` (`0ab5ce68f39e0af005e6ea8652cd6a1ba341be1a`) also performs that validation before preparation projection. The remaining direct caller, `TeamLaunchOwner.prepare` (`29822d71440cef625bdc2b43263cbeba7a9c96e2`), first loads the validated record and explicitly rejects a skipped member before assigning any new preparation. These callers already establish the exact same-record evidence needed by this repair. No new raw reader, recovery operation, mutable authority parameter or persistence owner is needed.

### Review 2 — two existing files, exact proposed delta

| Existing path | Exact preimage |
| --- | --- |
| `packages/legacy-agent-host/src/team-launch/launchPreparation.ts` | `78b708cecb6956ee703969b1c4b35191e56bc639` |
| `packages/legacy-agent-host/tests/runtime-team-host.test.ts` | `002153245391176601e3cdac38949537b352e009` |

In the existing preparation validator only, replace the unconditional skipped-member refusal with a finite projection from the same record's already validated action rows. A skipped prepared member is permitted only when an original row has phase `selected`, action `skip`, the exact member ID and an entire `selected`-member digest equal to the entire current selected member. Use the existing `ActionLaunchRecord` type through a type-only import and the existing canonical `runtimeDigest`; do not import or invoke another lineage validator. Existing action validation owns the 64-row limit, original source/selected relationship, action fingerprint and selected-chain checks. A missing receipt, prepared/requested/closed/refused action, different action/member or different complete selected member cannot satisfy this exception. Merely setting the current definition's skipped flag is still corrupt.

Retain every existing preparation guard: original command identity, source roster identity, one-to-256 member bound, 256 KiB bound, member uniqueness, preparation fingerprint, settings object shape, binding, configuration/base digests, configuration revision, the existing selected-restore digest rule and original start-command equality. Retain the direct preparation admission's refusal to prepare skipped members. Do not delete the original configuration, rewrite the preparation or action journal, change any launch/restore/input identity, weaken source/current checks, broaden this repair to other selection transitions, add authority state or change deadlines, retries, RPCs or native cleanup.

Extend only the already failing real Host case. Keep its original configured launch, original input/checkpoint/Stop, exact Skip command, cold new Host/Restore, delivery ownership, stale controls and all existing §61 source-provenance negatives. After the genuine Skip succeeds and before the existing restart, retain the exact original launch-journal bytes. In one critical negative, remove that original selected Skip receipt while leaving the current skipped definition, its fingerprint, attempts and original preparation unchanged. Require the original public `team.launch.read` to refuse with `hold`; restore the exact retained bytes in `finally`, then continue the original positive cold flow. This negative must exercise the unexplained-skipped-selection guard rather than a deliberately mismatched roster fingerprint. Assert that this temporary read-only refusal leaves original open/input counts and the retained checkpoint source/payload unchanged. No extra provider allocation, business input, mutation retry, wait, timer or test suite is introduced. The existing controlled Session is a TEST mechanism; its success is not a claim of native Claude or Desktop qualification.

### Review 3 — publication and acceptance

Publish this exact plan before editing the two files, then freeze their full bytes and review the minimal validator/test delta independently. Root must verify the two preimages in each current working branch before publishing; unrelated source and branch variants remain intact. Source review must specifically confirm prior selection-chain validation, the exception's complete selected-member equality, refusal without the original Skip row, and unchanged preparation/configuration checks.

Run the canonical Host build and type checks, the existing `runtime-team-host.test.ts` file and unchanged source-size/lint gates on the coherent candidate. The original Host shard and normal native/Desktop checkpoint gates remain required; do not replace them with the TEST negative. While the executor is unavailable, execution stays pending and normal CI may perform the existing gates after publication. Neither source review nor the earlier 1225 passing cases qualifies the corrected Skip, cold Restore or native checkpoint flow. This amendment repairs the source-proven configured-Skip defect only; §70 remains reserved for the separately unresolved Taskboard artifact investigation.


## §70 — retain the original Taskboard press-time target and owner facts

### Original evidence and the remaining boundary

The original e29 Taskboard job `132132912641`, run `43497088359`, failed at `desktop-task-board-ui-smoke.ts:463` while waiting for the clarification banner to clear. The original artifact `14074038808` was downloaded through the official artifact tool and read locally without rerunning the journey. Its ZIP is 923843 bytes, SHA-256 `c36ef79dc31b86bd9f6da6db612334224289b981d98ed550511d1372c84f5c22`. Its final receipt remains `INCOMPLETE`; the canonical task still says `needsClarification: "user"`.

The retained last three input rows are the original trusted `pointerdown`, `pointerup`, and `click`. The press/release point is `(986.20703125, 183.1484375)`; the click reports integer `(986,183)`. All three target the clarification banner's DIV and have `buttonClass: null`. The same point is the center of the Mark resolved button in the retained final dialog rectangle, and the earlier assigned/blocked screenshot shows the same layout. The complete archived command directory contains the original setup clarification command with value `"user"`, but no retained clearing command. This establishes the delivered target mismatch; it does not prove that a current Host null-clear command was rejected, nor does absence of a persisted row prove that no pre-journal request was attempted.

The §60 diagnostic's `receiptScanComplete: false` is not an empty-journal result. The original fixture deliberately retains an accepted task-comment journal row of 1802843 bytes, exceeding that diagnostic's unchanged 64 KiB per-file cap. The offline artifact inspection does not authorize increasing that cap, removing the large-row fixture, or changing the original scan.

Exact `desktop-task-board-ui-smoke.ts` `9dd028e52aca670f1b7059286b8110c3cdb47430` already joins the original Task identity/surface, accepted assignment and current owner before Mark resolved. Its `pointOf` (203–204) requires the unique enabled control and an actual `elementFromPoint` hit. Lines 449–461 use that same expression at every existing settling sample. The shared `desktop-ui-controls.ts` `c66034be1aeee83d88e829808f72db853dad6c57` remeasures after hover and requires two stable samples before the one physical press. The input events and screenshots therefore do not establish stale coordinates, a missed hover, or an insufficient delay.

The exact Header `bae3d01fadaabcaed70d63de1bd6da9fe909c3d9` disables Mark resolved only when its current `sessionController.isOwner` is false. The actual Button `a460eed1cbaf3ec1771951fb1073393fdde86401` applies `disabled:pointer-events-none`. A transient disabled control is a possible explanation, not an observed fact. The current Session hook `5180e47a337cbb4a917aec80156ab5c1883a789a` joins context, live Team, ready phase, deletion state, task identity and owner surface. Original task/config change handling (`da2ae39b3293d34ac2d14d0875f009a6ce9dd627:1581`, `f0543a009984bbfef7f00acd9e729c9f57aef755:350–387`) can invalidate the existing detail, but `5d5da9534eeacf34d554b2df2ed5573876c3a09c` and `0a1ede79d40bc05af35b67fcf27ed7594d71abb2` retain phase during ordinary read-start/invalidation. Pending refresh alone is consequently not a proven disable cause.

The original passive row records its event target, coordinates, focus, and default-prevention facts. It does not retain the expected control's disabled/computed-pointer state, the event-time DOM hit, rendered owner, current owner relation or detail phase. The failure screenshot records those DOM rectangles and disabled flags only later. The original app log and module/load diagnostic contain no corresponding event-time TaskDetail refresh or owner transition. These are the precise missing observations.

### One existing TEST source path

| Existing path | Exact preimage at current parent `2f6f3db0c6685dda535dfe866f7264249129ecab` | Bounded change |
| --- | --- | --- |
| `scripts/legacy-agent-host/desktop-ui-controls.ts` | `c66034be1aeee83d88e829808f72db853dad6c57` | Add a closed Task clarification observation inside the existing passive input handler only. |

The same handler may retain one optional closed `taskClarification` object for its existing `pointerdown`, `pointerup`, and `click` rows. Read the visible Task detail dialog containing the original event target and its unique literal `Mark resolved` control. Bound the existing dialog control census to 128. If the Task dialog/control is absent or ambiguous, do not attach a guessed identity. Use the existing current-React-fiber/alternate check, capped at 256 root links and 128 parent links, as already established in `desktop-task-comment-input-target.ts` `c2947089f5162cd798325d4da73f12459301ee7e`. Match the open dialog's actual Team/task/controller identity and surface before reading the corresponding original dev-store entries. Do not manufacture an owner or use a stale alternate. Malformed, missing or ambiguous owner evidence remains null while independently established DOM facts can remain available.

The fixed fields are: whether the event target is the control/its descendant or the control's immediate parent; whether the original event point is inside the current control rectangle; whether the event-time `elementFromPoint` hit is the control/its descendant; control connected/disabled booleans; computed pointer-events projected only to `auto | none | other | null`; the rendered owner's boolean; the current stored surface/revision match; current context/selected-Team matches; and the original detail's `hydrating | ready | missing | deleted | provisioning | unavailable | null` phase, loading, refreshPending and deletion-intent-present booleans. A malformed or unavailable boolean is null, not a fabricated false. These fields are observations, not an admission predicate, proof of native authority, or a diagnosis inferred from one flag.

Copy only those closed scalars; retain no DOM node, React/controller/store object or event reference beyond the original handler. Never export identity strings, task text, command IDs, selectors, paths, credentials, account fields, raw error, owner/session objects or arbitrary CSS. Limit the serialized additional object to 768 bytes; a projector exception or overflow produces null without changing the original event row or propagation. Read existing DOM and dev-store state only; do not invoke a controller method, store action, refresh, renderer API or application callback. There is no new import, CDP command, file read, process, listener, subscription, timer, queue or history.

The original event set, capture/passive flags, 96-row input ring and 32-row drag ring remain unchanged. No extra sample is generated, no counter resets beyond the original observeInput calls, and no business action is retried. The shared hover/stability/one-press implementation, Mark resolved expression, original 30-second read waits, canonical assertions, command journal, §60 scan caps, failure status and cleanup stay byte-identical. Existing failure capture already retains these input rows in the original artifact; no new failure-time CDP read or log payload is necessary. The original fixture and source roster already include this helper, so no inventory, workflow, budget or production path is added.

### Validation and acceptance

Root coordinates canonical script types, lint/source-size/diff checks and the existing relevant TEST checks with the available build slot. Do not create another native journey, unit suite, provider request or manual rerun to obtain this observation. The next already-required ordinary Taskboard gate retains its exact success assertions and reports its original failure if it still fails. Source review and the recovered e29 artifact do not count as successful Mark resolved acceptance. A subsequent functional change must be justified by actual retained event-time facts and receive its own reviewed plan; this diagnostic cannot weaken owner or click guards.

Root and an independent peer review this exact appendix before the one source edit; root alone publishes. This supersedes the earlier prospective §70 scan-stage-only diagnostic direction because the original artifact is now available. The established hit mismatch is retained, and its event-time cause remains unknown.


## 73. Keep the synthetic Linux exec-error fixture in its own errno domain

### Actual Windows failure and exact source boundary

The completed child environment lanes `43515479266` / Windows job `132196262503` and `43515485178` / Windows job `132196283809` both fail the existing `shellEnv` case “keeps the strict resolver login then interactive fallback order”, at its added selected-helper refusal assertion. Each reports 172 passed, one failed and 15 skipped tests. Their original Linux and macOS jobs succeeded. This is an actual Windows assertion failure, not the earlier canceled macOS job. The recorded runtime is Node `v26.12.1`.

Exact `test/main/utils/shellEnv.test.ts` `8c7f61f2dc0834ecf741783315acb1a09ddc61c7` supplies a synthetic Linux exec-status frame with positive errno `2`. Its selected-executable spy deliberately bypasses the production platform/selection check; the suite's JavaScript `process.platform = 'darwin'` stub does not change Node's compiled platform errno table. Exact `src/main/utils/linuxChildLaunchSelection.ts` `86103b92c6c8dc1dae9333c19afc53c730b2cba8` converts the validated exec errno with `getSystemErrorName(-errno)` and retains `error.errno = -errno`. Consequently the actual Windows test receives `code: 'Unknown system error -2'` instead of its literal `'ENOENT'`.

The official Node `v26.12.1` [util documentation](https://github.com/nodejs/node/blob/v26.12.1/doc/api/util.md#utilgetsystemerrornameerr), blob `bfc70c6be8f66b48248df8cee58439a82e83cd18`, specifies that this numeric-to-name mapping is platform-dependent. Its bundled [libuv errno definitions](https://github.com/nodejs/node/blob/v26.12.1/deps/uv/include/uv/errno.h#L245-L249), blob `ac00778cfc59fb55e361b24fc81a965a5e8f97e7`, assign Windows `UV__ENOENT = -4058`, while non-Windows uses the platform `ENOENT`. These sources explain the observed fixture mismatch. They do not establish a defect in the Linux-only production conversion or a Windows selected-helper launch.

### One existing TEST path

Only `test/main/utils/shellEnv.test.ts`, exact preimage `8c7f61f2dc0834ecf741783315acb1a09ddc61c7`, changes. Follow its existing builtin-mock pattern: keep `node:util` exports and `getSystemErrorName` behavior as passthrough to the actual module unless an explicit local TEST mapper is active. In the already present synthetic Linux refusal branch only, activate a finite mapper that accepts exactly `-2` and returns the literal `ENOENT`; other arguments refuse. Retain that mapper's call evidence, require exactly one call with `-2`, and clear the optional mapper in the same existing `finally` that restores the selected-executable spy. No other test uses the Linux mapper.

Keep the original 12-byte Linux frame, positive wire errno `2`, literal expected `code: 'ENOENT'`, allocated-child identity, kill count, pending-before-real-close assertion, original real `close` event, no-interactive-replay assertion and empty-cache result. Also assert the existing production error's original numeric `errno: -2`. Preserve the original login-then-interactive fallback assertions and all remaining cases. Do not change the fixture to a Windows errno, accept an unknown error code, compute the expected code with the same production conversion, bypass error projection, skip the selected branch on Windows or add a test suite.

Production `shellEnv.ts` `0757597ef0bbdc593ce1691e0a5b33f131a81d75`, the selected-launch adapter/class, callback error `code`/`errno`/target projection, actual ChildProcess lifetime, platform checks, cleanup, deadlines and native failure behavior remain unchanged. This controlled TEST mapping does not replace actual Linux errno qualification. The existing native Linux proof `packages/legacy-agent-host/tests/registered-process-linux.native.mjs` `f5959483a2441a5b53570c55df8b855f39003a94` still requires genuine missing-target errno `2`, denied-target errno `13`, empty user output, exact exec-status frame and actual close, and separately rejects treating a target exit code as an exec failure. That file and its gate are not edited.

### Review and acceptance

Root and an independent peer review this appendix before the one-file source edit. Freeze and compare the exact source bytes; outside the builtin passthrough fixture and the original selected refusal branch, all assertions and behavior must remain unchanged. The source-size policy `fbdcb4bdd5bef2ed13c34821c451d0c965e3b8e0` and guard `65775f7889470056ef7cd91ad6c56d9351e6cdfc` already exclude test paths; the existing file has 1174 physical lines. Do not change any source cap or baseline.

Root coordinates the existing focused `shellEnv.test.ts`, canonical type/lint checks and the same ordinary three-platform environment lane with its current setup slot and budgets. No native rerun, workflow change, retry, fresh allowance or production activation is introduced. Source review remains separate from execution. The two recorded Windows failures remain actual failures until corrected bytes pass the original gate; this repair makes no claim about the independent V1 source-selection CDP timeout, Linux descriptor isolation or POSIX executable-race qualification.


## 74. Preserve the original source-selection status failure and existing renderer-event context

### Original artifact and exact localization

The original [e29 retained OpenCode Desktop job](https://github.com/777genius/agent-teams-ai/actions/runs/43497088359/job/132160940327), run `43497088359`, first passed the ordinary retained coexistence journey in 463037 ms. Its following V1 source-selection invocation failed with `CDP timeout: Runtime.evaluate`; the V2 source-selection invocation was not reached. These are separate journeys and namespaces. Later missing-V2-receipt checks are consequences of the earlier failure, not another observed V2 product failure.

Official artifact `14079601289` was downloaded once and read without executing either journey. Its ZIP is 129621 bytes, SHA-256 `8ee29b0e7e51ef3d0162d14e8f43866bf58acf6e5ba49bc8a6ae2cf03936b924`. The original V1 receipt is `INCOMPLETE`, initial `missing`, epoch 1. It retains the genuine missing status, one physical Install OpenCode V1 click, installed package B `1.19.5` and its verified executable digest `7df4e4136301f16589b0f30bf91a61380fca5f8ef22dd36570f5ebe1d4ec802c`. It has no `currentStatus`, completed `publication` field, Team creation or model observations. Its `cleanup` is true and `cleanupErrors` is empty. The declared business-marker array is fixture configuration, not evidence that an input occurred.

Exact original `desktop-runtime-source-selection.ts` `64a6264ded31b6ba0990a67d55b8643c9dd97aec`, lines 362–421, polls the original source index and published management receipt, verifies the source grant, CLI digest/canonical path, installed manifest and original publication fingerprint. It assigns `phase.installedManifest` at line 407. The remaining statements before line 422 are synchronous assertions; their failure would not produce a CDP timeout. The missing `currentStatus` and exact failure therefore localize this failure to the original renderer-status observation at lines 422–425, after the original publication was observed and validated. The later assignment of `phase.publication` has not happened yet; its absence must not be described as absent Source publication.

The current journey preimage `8fdaf9624bc4f8d6ae76b4a74da9670ae301a3b1` differs from that original only by the explicit `selected` narrowing checks required by §71. Its status expression is a synchronous projection of `window.__agentTeamsDevStore.getState()`, with no renderer API action or awaited IPC. The shared CDP client `scripts/e2e/release-updater/cdp.mts` `1e2573088eabbca71aeb758d56a22836668f5bdc` sends the original evaluation with `awaitPromise:false`, retains an original pending request and rejects it after its unchanged 30 seconds if no matching response has been processed. A socket close would reject with a different fixed error. This distinguishes the observed timeout from a returned status that merely failed the ready predicate; it does not identify renderer, transport, scheduling or backend causality.

The existing app owner `desktop-retained-opencode-app.ts` `e752dc2fcce988d50f8eb77a9afb90455373d8f0` enables Runtime, Log and Page events and the CDP client already retains notifications. That app helper records events only on its own startup-failure path. The later source-selection failure retains neither the last completed status observation nor the already-buffered notification context for the failed status call. Its archived app log contains ordinary startup/watch messages and an unrelated Codex management refusal; neither proves the cause of this timeout. No source-backed product repair follows from this artifact. §66 descriptor isolation remains a separately qualified change, not an assumed fix for this observation.

### One existing TEST file and exact finite observation

Only `scripts/legacy-agent-host/desktop-runtime-source-selection.ts`, preimage `8fdaf9624bc4f8d6ae76b4a74da9670ae301a3b1`, changes. Root checks this preimage in each working branch before publication. Keep the existing status expression byte-identical and call it exactly once at each original invocation. Add an explicit local observation purpose to its six existing call sites: `published-source`, `missing-before-install`, `path-before-support`, `path-before-refresh`, `repair-before-confirm`, and `repair-completion`. The surrounding poll, acceptance predicates, current-source checks and call order remain unchanged.

For that original status call, retain its already selected app/CDP object, the starting length of that object's existing event array and a monotonic start reading. Maintain only a saturating attempt number, at most 1024 with an overflow flag, and one closed last completed result. A successful original call returns the exact original value and replaces only this private last-result projection; there is no diagnostic output on success. Its fixed fields may report: original purpose and capped attempt, whether the returned status was present, original installed/loading booleans, state projected to `idle | checking | downloading | installing | ready | failed | null`, source projected to `missing | path | override | app-managed | captured-host | null`, version projected to the already pinned `a | b | engine | other | null`, source-revision presence and equality to the already captured original selected revision when the purpose is `published-source`, and a nonnegative safe-integer scope revision or null. The state/source enums come from existing `src/shared/types/cliInstaller.ts` `2585793708732b1a5597b07b4b08f064fb495238`; `other` version means another nonempty version string, not malformed input. Copy only own data properties. Missing or malformed evidence is null, never a fabricated false. Do not export the version string, source revision, identity, target or object. The optional expected revision is diagnostic comparison input from the same existing selection, never authority or another lookup.

If the original evaluation rejects, capture only its first failure before cleanup can change the evidence. Record that same purpose/attempt, elapsed milliseconds capped at the existing 900000 ms outer TEST allowance with an explicit capped flag, the fixed reported-error class `cdp-timeout | cdp-closed | other`, and the last closed result or null. Map only the two exact existing local error messages; never copy an arbitrary error message, stack, code, object or thrown value. A completed null or malformed prior response must not leave an older success mislabeled as the last response. The error classifier and elapsed value are observations, not proof that a target did or did not execute.

At that first failure, inspect at most the last 16 already retained notifications appended since this same call began, from the same captured CDP object. Read no earlier app/epoch's buffer and create no new subscription. Retain only fixed ordered kinds for the exact methods `Runtime.executionContextCreated`, `Runtime.executionContextDestroyed`, `Runtime.executionContextsCleared`, `Runtime.exceptionThrown`, `Runtime.consoleAPICalled`, `Log.entryAdded`, `Page.frameNavigated`, `Page.frameDetached`, `Page.loadEventFired`, `Inspector.detached` and `Inspector.targetCrashed`; all other or malformed methods become `other`. The existing client array is append-only in this journey, not a ring. Capture its original array identity, starting length and, if present, last existing entry reference as a private prefix witness; validate that witness before using the interval. If the array/prefix changed or its length decreased, report interval/count/kinds as unknown rather than a complete empty interval. Otherwise record the observed interval's count saturated at 1024, an overflow flag and whether its last-16 export is truncated. Read each method through an own data descriptor. This witness proves only the locally retained interval; it is not a claim of complete remote notification delivery. Never copy event parameters, exception/console text, URLs, frame/context IDs, source paths, headers, credentials or native payloads. Absence of a notification is not absence of a crash or transport problem, and the bounded export is not a claim that the existing shared event array is itself bounded.

Attach at most one `statusFailureObservation` to the existing namespace receipt, no larger than 2048 UTF-8 bytes including its serialized value. Projection failure or overflow yields a fixed unavailable observation; it must not throw, replace the original failure, retry the call or upgrade the result. Keep a first-capture flag so later cleanup cannot replace or enrich that original failure. Return/rethrow the original value/error unchanged. Use the existing final receipt write after the existing cleanup; add no file, console output, CDP request, renderer action, native read, timer, polling interval, screenshot or retry. Do not re-evaluate status on failure.

### Preserved proof and acceptance

Preserve the source/package/SRI/manifest guards, captured owner and source/current checks, physical UI actions, all Install/Update/Repair success assertions, original A continuation and Stop, B next launch, cold history and no-input guarantees. Preserve all native ownership/cleanup and metadata-lineage accounting. Keep the 30-second CDP request timer, 90-second status poll, 900-second outer TEST allowance, existing steps/event infrastructure and workflow/matrix unchanged. The diagnostic does not authorize another input or launch when the original acknowledgment is uncertain.

The source stays within the existing 800-line limit without increasing a baseline or adding a helper framework. Root and an independent peer review this exact appendix before source. Then review the full one-file delta for return/error identity, original expression/call-count preservation, first-failure timing, same-buffer slicing and closed projection. Root coordinates canonical script types, lint/source-size/diff checks with its existing setup slot; do not add a test suite or manual native run. The next required ordinary source-selection gate retains all original success assertions and may still fail. Until actual retained evidence supports a functional change, the V1 timeout's cause and acceptance remain unresolved.


## 71.1. Close the observed ESM fixture and compiler-environment type failures

Root's coherent local verification retained `logs/final-focused-main.log`: five original Main suites ran 185 cases, 184 passed and the added selected-child branch in the existing maxBuffer case failed before its signal assertions. The exact error is that Vitest cannot spy on `fs.readFileSync` through a non-configurable ESM module namespace, at `childProcess.test.ts:1078`. This is the existing `3d31be84b4dedf7970a753cc9570c2c5e2697278` TEST correction's module-boundary failure, not evidence that cleanup signals were sent or that the original cleanup oracle is wrong. Root separately ran the §73 `shellEnv` file: 46 cases passed; that result does not qualify this different fixture.

The same coherent Host test-type check retained `logs/final-host-test-types.log`. It reports `buildLinuxProcessNativeArtifact.ts:123`: `PATH` is absent from the inferred `{LC_ALL:string}` type of the spread-created local compiler environment. The existing code still reads and passes that exact environment at runtime. Other errors in that log belong to separate owners and fixes; this amendment does not claim to close the whole type check.

| Existing path | Exact preimage / variant | Minimal change |
| --- | --- | --- |
| `test/main/utils/childProcess.test.ts` | `3d31be84b4dedf7970a753cc9570c2c5e2697278` | Replace only the failing namespace-spy mechanism with a scoped builtin TEST factory. |
| `packages/legacy-agent-host/scripts/buildLinuxProcessNativeArtifact.ts` | native `27488de24d8157f868a9ee5263503f76f267f55e`; shared parent/qualification helper-only `38b5aa247e2d0709e68a5aaaa7361337dc3c5f5c` | Add an explicit `NodeJS.ProcessEnv` annotation to the existing local `environment` constant. |

In the existing child-process test file, use its established `vi.mock(..., importOriginal)` mechanism for the `fs` module. Preserve every actual export and delegate `readFileSync` to the actual implementation by default. A private hoisted TEST boolean may enable only the existing selected-child branch's synthetic `/proc/(901|902|903)/stat` observations, and only for its actual `utf8` read. Return the exact same original stat string, including the parenthesized command, state plus 18 zero fields and the original PID in the start-ticks position. The current `unixProcessTable.ts` consumer imports `readFileSync` from `fs`, requests `utf8`, and reads field 19 after the command; retain that actual contract. Every other path, encoding and read delegates to the original function without recursion or replacement of the real module namespace.

Enable the boolean within that same existing branch's `try`, and reset it in its original `finally`, together with the native-kill and selection spies. Remove the failed dynamic-namespace spy and its restoration; add no new test, process, census, helper, wait or fallback. Keep the existing 901/902 signal assertions, exact original native error/target evidence, same-child pending-before-close check, real close, two SIGTERM count and the 903 census-refusal/original-25-ms-timeout assertions byte-identical. Do not solve the failure by omitting start ticks, broadening PID admission, fabricating close, weakening cleanup, or increasing a timeout.

The builder's annotation supplies the existing string/undefined environment index signature only. Preserve the environment spread and `LC_ALL:'C'` value, original `PATH` lookup, selected compiler/inspector/source pins, tool/link closure, static ELF inspection, shared absolute deadline and all output/custody checks. The annotation emits no runtime code. Apply it to both existing variants at that same helper function; retain the native NAPI builder and the parent/qualification absence of that unrelated function exactly. No compiler flags, native source or package/delivery policy changes.

Root and an independent peer review this exact note before source. Freeze the one test and two builder variant blobs, verify the inverse delta and preserve the current source caps; do not alter the baseline. Root alone applies/publishes and coordinates the existing failed test file and canonical Host test-type check in the single available check slot. These source edits do not authorize another native run, CI retry, dependency install or new suite. Execution remains pending until those checks finish; §74's separate diagnostic source is not folded into these fixes.


## 71.2. Keep the reconstructed checkpoint profile's existing union type

The fresh D002 consumer at `ebb3debaa381fa7cc34d346eb49a507423d0e453` passed frozen installation, archive/dist equality, Host/ledger builds and canonical Host test types. Its separate canonical `typecheck:legacy-host-scripts` reports one remaining TS2322 at `desktop-claude-checkpoint-upgrade.ts:309`: `let base = seed` is narrowed to Claude by the preceding original seed-provider assertion, while the unchanged old compiler returns the original provider union.

In the one existing file, preimage `b64fe10746e044cae4982f4fbb24e265362da1ca`, annotate only that local variable as `NonNullable<typeof oldProfile.runtime>['members'][number]`. This is the actual unchanged original member union, not a cast or a new schema. Keep every subsequent original member/team/provider/executable assertion, capture compilation, native/session/launch joins, digest calculation and cleanup unchanged. The original provider equality still rejects a mismatched reconstructed provider before use; the annotation emits no runtime code. Do not substitute the static seed for the genuine compiled profile or add a test/native invocation.

Root and an independent peer review the exact note and one-line inverse delta. Root commits/pushes with normal lease/readback and repeats the existing failed script type check. Existing Host test-type and focused case success remain separate evidence; no whole-app/native success follows from this fix.


## 75. POSIX selected-image proof: original Darwin receipts and the remaining authority boundary

### 75.1. Scope and conclusion

This is an evidence and proof-boundary amendment to §§47/50/62, not authorization to change production, the native actor, its assertions or supported executable formats. The original review thread [PRRT_kwDORVTEtM622qol](https://github.com/777genius/agent-teams-ai/pull/1186#discussion_r4556997490) remains unresolved. Its concern is the already-published lower-trust pathname/in-place writer between verification and actual consumption of the selected executable. This amendment does not add a privileged attacker, task-memory mutation, arbitrary future dependency integrity or a new sandbox threat model.

The complete original Darwin artifacts now distinguish three facts: the compiler-default x64 image-observation path refuses before user code; the ad-hoc Mach-O mutation cases continue with A markers; the interpreter-script negative control actually executes B. None can be substituted for another. In particular, A markers are not evidence that B executed, and they are not proof that the entire kernel-selected image equals the captured bytes. Both original fixture results remain INCOMPLETE under their unchanged oracle.

Evidence manifest: `7bd7f8b68e8655f84cc68649b6c7e7c6a6f6807d` in `777genius/agent-teams-ai`. It preserves the closed original twenty observation rows, ZIP/member identities, source pins and explicit limits of the source inference. It adds no native execution or synthesized acceptance.

### 75.2. Exact original artifacts, read without a replay

All facts below come from ordinary run [43515484835](https://github.com/777genius/agent-teams-ai/actions/runs/43515484835), source `8f28b801f513187b84b17f8748745dc563b6e43a`, Node24.21.0. Both artifacts contain `opencode-v2-posix-exec.json`; the original C source SHA256 is `b6ecbe29bfbaa4542534244bb002de1828394cfcea676f27b44044745471fcdc`.

| Original job | OS build in original receipt | Official artifact | ZIP bytes / SHA256 | Receipt bytes / SHA256 |
| --- | --- | --- | --- | --- |
| [132196281665 / Darwin x64](https://github.com/777genius/agent-teams-ai/actions/runs/43515484835/job/132196281665) | `24G830` | `14082626502` | 9628 / `389ac24acc6a4f55422caf1c19ae1a63f0f6b15aa396c25da541e947ff1436aa` | 14234 / `e9e5ae5663863c8f9b40a5df88bef243c385435e3ecc4de6712794173e813720` |
| [132196281676 / Darwin ARM64](https://github.com/777genius/agent-teams-ai/actions/runs/43515484835/job/132196281676) | `24H232` | `14081930739` | 10237 / `4be87d4c33b8c128a645cc242e0a886b9a3593f77a655ac92c9114fac6be743d` | 14293 / `ec33655fb58fdfb1076fb30edc9f0061ca73312d53a7641c59431fa7a72c493c` |

Official downloads were checked against these exact outer digests and sizes. Extraction inspected only bounded original JSON members, rejected absolute/parent paths and symlinks, and executed no member. Each receipt retains ten rows; every row confirms the original child reaped, original group absent and cleanup true. Both overall receipts retain `nativeFixtureQualified=false`, `productQualified=false`, `installedRuntimeQualified=false`, `customExecutableQualified=false`, `scriptQualified=false`, `status=INCOMPLETE`.

| Original case | x64 observation | ARM64 observation | What is established |
| --- | --- | --- | --- |
| compiler-default plain | A markers, exit0 | A markers, exit0 | Original ordinary fixture executes with its original argv/resources. |
| compiler-default suspended baseline | `kernel-image`, errno13, execErrno0, stopped before user code, no image observation/resume/markers; cleanup true | Image matched; A markers, exit0; flags `0x22020001` | The selected default x64 observation chain is unavailable/refusing in this actual run; the ARM result cannot qualify it. |
| ad-hoc baseline | Image matched; A markers, exit0 | Same | This signed TEST variant passes its baseline only. |
| ad-hoc rename / in-place before image check | Image mismatch, no resume/markers | Same | These controlled replacement cases were refused before fixture instructions. |
| ad-hoc after-check / already-open writer | Mutation returns0; resumed; `LIB/BIN:A/MAIN:A`, exit0 | Same | The file write succeeded but the recorded payload remained A. Both rows are still INCOMPLETE under the unchanged no-marker-after-write assertion. |
| script plain | `SCRIPT:A`, exit0 | Same | Original script semantics remain an existing compatibility requirement. |
| script negative control | Interpreter image differs from script; intentional resume after mutation0; `SCRIPT:B`, exit0 | Same | Validating only the interpreter cannot validate the subsequently read selected script. The negative control deliberately continues past image mismatch; it is not evidence that a correct product script guard admitted B. |

The ad-hoc process flags are `0x22000001` on both architectures. The current x64 baseline's zero flags are an unavailable observation, not proof that the compiler output is unsigned. The individual failing Security/proc call was not retained. Do not infer it from the aggregated EACCES.

### 75.3. What the current source actually proves

The original actor is `packages/legacy-agent-host/tests/fixtures/posix-exec-native.c`, blob `882c986d13920db54720b4672dd6cfc55e361aaf`; its existing caller is `packages/legacy-agent-host/tests/registered-process-executable.native.ts`, blob `e5ffada8250e2a65076b74419e539b842b5867d2`.

The Darwin `original_image` function at205–229 joins the original direct child's audit token to proc path and dynamic SecCode, checks validity, compares a signing path, then obtains signing flags. Several distinct failures collapse to EACCES. At the later `kernel-image` stage the actor opens the returned pathname, obtains file identity and hashes that open file. Its receipt field `kernelSha256` names that existing observation; it is not a hash of the child's mapped private VM object. Retaining the original PID/birth/parent/group/audit token protects child identity, but it does not turn a reopened path into a retained capability for all mapped bytes.

The current production `CapturedProcess.ts`, blob `7fc0b23faf93756f8dac159eec97292a6085c634`, still verifies the selected executable at119, verifies directories, then uses the original pathname spawn at122–128. Its hash/stat checks at270–287 do not hold an executable descriptor through kernel selection. `verifyRuntimeSourceCandidate.ts` (`b08299f6d342f12da8fff60ddaadf3f121c94bc3`) retains an FD while hashing at publication, then closes it; that does not become a launch capability. `nativeProcessProfile.ts` (`34daeaecc7fa6d9f809bb3c69e0b7acdcde7fd73`) binds path and SHA without requiring Mach-O, ELF or a signature. Existing `runtime-source-native-identity.test.ts` (`5bb419c418c07f1d8050e47afb1131a1903ec5e3`) includes executable shell wrappers. Preserve this contract.

The actor's original distinction stays intact: successful ETXTBSY after-check write denial permits A; a successful mutation currently requires no library/payload marker and a terminating signal. No acceptance edit is authorized here. A future implementation cannot obtain a PASS merely by reclassifying the present A-marker rows.

### 75.4. Primary source explains a Mach-O candidate, not a qualified replacement

Inspected Apple source pins are XNU `f6217f891ac0bb64f3d375211650a4c1ff8ca1ea` and Security `db15acbe6a7f257a859ad9a3bb86097bfe0679d9`. These exact public sources are not established as byte-equivalent to either original runner's kernel/Security build. They supply a bounded mechanism to investigate, not OS qualification.

- [Mach-O loader](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/mach_loader.c) (`a07d07363ab3120eb968d0c2e74c598af09ff235`,2163–2176) maps file-backed segments with private copying. [Vnode pager](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/osfmk/vm/bsd_vm.c) (`0a9f38a2257fdbb18d7dc5634c02f1fcc076bef7`,398–437) chooses delayed-copy semantics.
- [VM object copying](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/osfmk/vm/vm_object.c) (`e2dd65e1fb875c550e3ad3965d01d69eaa39d5e8`,3627–3693), [clustered writes](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/vfs/vfs_cluster.c) (`806e747acd9d419b52607d776c7e7af2b7a1621b`,4352–4363) and [pageout](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/osfmk/vm/vm_pageout.c) (`cc456d0c391d5fa990ecc7859b310e89012dc310`,6115–6132,6348–6385) preserve old data for private copies before modifying backing pages. That mechanism is consistent with observed A continuation after an ordinary same-inode write. It does not by itself prove which complete bytes were selected across earlier concurrent loading/hash operations.
- [Dynamic code validation](https://github.com/apple-oss-distributions/Security/blob/db15acbe6a7f257a859ad9a3bb86097bfe0679d9/OSX/libsecurity_codesigning/lib/Code.cpp) (`da3c6b0522167f8576c11454b30fb827fbf4245b`,181–242) joins dynamic state with static signing information. [Static validation](https://github.com/apple-oss-distributions/Security/blob/db15acbe6a7f257a859ad9a3bb86097bfe0679d9/OSX/libsecurity_codesigning/lib/StaticCode.cpp) (`be158f70e5c75d9c86728c291dd887e57b2199e4`,534–560,726–736) can reject missing CodeDirectory as unsigned. Therefore this chain is not established as a format/signature-neutral image witness. This source fact does not identify the original x64 failing subcall.
- [Process flags](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/osfmk/kern/cs_blobs.h) (`9d36c1af4a00548fd47b1da6d95c0635326a6ff6`) show that the observed ad-hoc flags lack the individual CS_HARD, CS_KILL and CS_ENFORCEMENT bits. [Invalid-page handling](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/kern_cs.c) (`c1c3929fb6505c3f1c74a4da1c565031ebc2949e`,249–317) distinguishes these actions. Do not turn those individual flags into a claim that global AMFI/pmap policy is disabled, or predict a later signal solely from successful SecCode validity.

The useful candidate is an exact original **mapped-image** binding that permits verified A to continue despite a later file update. It still needs a public, available witness for the complete selected bytes, a proof spanning the load/check interval, and source/OS-bound stability of later page consumption. The present pathname hash and A markers supply none of those missing joins automatically. This is separate from the script problem below.

### 75.5. The selected-script counterexample and the necessary authority

The existing script control already uses the same writer and preservation requirements as §50. After the original child is stopped with its interpreter selected, the controller rewrites the selected script and resumes. The interpreter then reads the pathname and produces SCRIPT:B. No additional attacker ability or future dependency policy is needed for this counterexample.

[Darwin exec source](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/kern_exec.c) (`47420f9f8f620233f112e87a51ed8f576caa3546`,script handling603–737,2499–2507,6118–6138) switches to the interpreter and passes the ordinary script pathname. Its special set-ID handling is not an authorized workaround. [Linux exec.c v6.18](https://github.com/torvalds/linux/blob/v6.18/fs/exec.c) (`4298e7e08d5d78ea327c10e9e962780b3d976e1a`,1685–1725) releases the original script file's executable write denial on interpreter substitution before the exec trace event; [binfmt_script.c](https://github.com/torvalds/linux/blob/v6.18/fs/binfmt_script.c) (`637daf6e4d4520f21d0cbfee242337f97e06d882`) passes its filename to the interpreter. Neither native-image witness can silently stand for script-body integrity.

For this already-observed case, another observational hash merely becomes another last check. If the same existing writer can change the original script after that check and before the relevant interpreter read, the later read is not bound to the checked bytes. Avoiding B while retaining arbitrary existing script behavior therefore needs one of two additional capabilities:

1. Exclude that writer from the original selected path/inode for the relevant selected-script consumption, under an explicitly justified source/writer authority contract; or
2. Bind those later reads to the original verified bytes through a separately qualified mechanism, while preserving the existing script's pathname/$0, argv/env/cwd, resource lookup and process custody.

This states a necessary boundary for the current launch-only proposal, not a claim that every conceivable OS design is impossible. It neither authorizes chmod/ACL changes nor substitutes a copy or an interpreter-specific wrapper. Retaining an FD without byte stability is insufficient, as §50 already observed. No blanket script refusal is permitted.

### 75.6. Alternatives examined and their precise remaining limits

| Candidate | Source/evidence-backed limit | Decision or proof still required |
| --- | --- | --- |
| Original-path pre-user stop + reopened hash | Current actor can reject controlled pre-check replacements; the reopened file is not the complete mapped VM object, and a script is read later. | Exact mapped image/bytes and stability for native binaries; separate script-consumption authority. |
| Existing dynamic SecCode chain | Individual x64 failure is collapsed; unsigned validation is not neutral; code-signing identity alone is not the requested general SHA/custody proof. | Available unsigned/custom-compatible image witness; no new CS flags, signing requirement or entitlement. |
| Public process region/path information | [proc_info.c](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/proc_info.c), blob `c061a09289afe73572456395af70de2cd92b69fc`,1132–1163 exposes region vnode facts, while1379–1470 returns a path from the text vnode. A matching file-backed region/path is not on its own a full original-image hash. | Unambiguous original kernel image binding and stable bytes, not selection of any matching region. |
| Reading the stopped task's VM | [task_read_for_pid](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/kern_proc.c), blob `a08362b2e777ee607e226d869131efd5e164e526`,6074–6186 includes POSIX, MACF and taskgated checks. | A universally available own-child capability is not established. No permission/entitlement bypass or equivalent-memory claim. |
| File data generation count around load/hash | [getattrlist contract](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/man/man2/getattrlist.2), blob `8429aa7b281b4b39966639e95e2ab99a25bfb9a9`,637–655 defines nonzero unchanged data generation but makes zero invalid and permits it for mapped files. | Actual filesystem support and a usable nonzero count across this mapping remain unproved. Zero, missing returned attribute or metadata timestamps cannot become success. Even a valid finite bracket does not govern a later script read. |
| More specific HFS generation behavior | HFS `core/hfs_vnops.c` blob `cd5a56aa74f6dae8b8e2e6760e5bb0bf2d2d9fd3`,1158–1172 returns zero for a writable mapping. XNU `vm_map.c` blob `fb4fae0136e0c53233cf2deb3bd498d86ebf8d7c`,5230–5246 removes write protection from pager notification for private COW. | This narrower source does not identify/qualify the original runner volume's implementation or all supported custom locations. It is an unqualified native-only research lead, not the chosen product fix. |
| Advisory lock, late hash/kill, immutable-instance naming alone | None excludes the already-permitted noncooperating in-place writer from the subsequent script read. An installer promise not to overwrite A covers that writer only. | An actual enforced or explicitly trusted writer boundary; no broad owner/GID inference. |
| FD alias, copied executable, file lease or changed code-signing policy | §47/50 already record argv/provenance/resources/script counterexamples or excluded private authority. | These stay excluded. No fallback is authorized by this appendix. |

This table does not make scripts unsupported and does not transfer a partial Mach-O proof to the whole product.

### 75.7. The concrete owner decision before a different authority design

Continue work on the independent product/CI items. No project-wide pause follows from this record.

The unresolved policy decision is specifically whether the selected-source contract may change **who can still write the original selected executable/script, or how its bytes are consumed**, while retaining the existing frontend feature. This is narrower than approving a generic sandbox, refusing unsigned files, trusting an entire group, or changing the user's executable location without consent.

Under the present §47 contract, the writer remains one already considered able to perform the selected pathname/in-place change. Marking a custom source trusted or assuming its updates cooperate would narrow that threat boundary; it cannot be presented as fixing the same arbitrary-writer race. Conversely, a new mechanism that freezes/rebinds the actual reads must prove the old execution semantics and needs its own authority/design approval. Neither choice is implied by source capture, a verified version, an original process handle, nor the existing immutable installer publication.

Root/owner must select or authorize such a boundary before a future proposal relies on it. If no boundary change is authorized, keep the existing frontend compatibility and open §47 gap; do not claim a protected script launch from an interpreter-image check. Native Mach-O proof work may remain separately possible within existing constraints, but it cannot close script parity and cannot remove today's failed oracle by fiat.

### 75.8. Requirements for any next bounded implementation proposal

No production or TEST source change is authorized here. A later proposal must name exact current paths/preimages, its public API/authority, the original process object and cleanup, and the finite source formats/OS/filesystem facts it actually proves. It must address all of these joins before activation:

- The exact original selected bytes are connected to the kernel's actual selected native image before any replacement instruction, including the original rename, same-inode, already-open writer and after-final-check schedules.
- Original verified A continuation and execution of unverified B are distinguished through an actual binding proof. A few A markers or a path SHA cannot substitute for that proof. Existing zero-marker-after-write assertions remain unchanged until a separately reviewed proof and acceptance decision, not an incidental green test edit.
- The selected script's later reads are covered by the expressly approved authority/compatibility boundary; no native-only PASS is promoted to script/custom/installed qualification.
- Original argv0/$0, arguments, environment, cwd, executable-relative resource behavior, selected provenance, physical child/birth/group and cleanup remain intact. No numeric PID adoption, copied-location fallback, extra owner/journal, code-signing policy, entitlement or unsupported-format shortcut.
- Qualification uses only a subsequently reviewed extension of the existing native lane and its existing budgets. This record authorizes no rerun, new matrix, timeout increase, background experiment or ignored failure.

The exact x64 Security/proc subfailure and generation-count availability can be investigated only if they serve that concrete proposal. A generic extra diagnostic does not itself solve script read authority or establish mapped-image equality.

### 75.9. Publication and review

The only deliverables in this cut are this appendix and the immutable original-evidence manifest. The current C actor, caller, production launcher, source profiles, permission policy and every native qualification flag stay unchanged. Root is the sole publisher; verify the full prior P09 prefix before appending.

Independent review must check the twenty original rows and distinctions above, the selected-script source path, the conditional Mach-O inference and the exact narrow owner decision. A source-only review is not native qualification. §47 and its review thread remain open, with a concrete proof/authority requirement instead of an unsupported race-free claim.


## 76. Existing Linux launch helper: exact types and synchronous cleanup ownership

### Review 1 — current CI failures and exact unchanged sources

Qualification head `e551565da1daf06c104bf0403e4b7f28949e71fd`, Main run43515479588, has two concrete static failures. Validate job132206650385 reports childProcess.test.ts1005: the declared `Buffer` return of the existing TEST execStatus helper widens its actual Buffer.alloc result to ArrayBufferLike, while Node24's spawnSync output contract requires a non-shared buffer. Main lint job132206650584 reports eight errors in the two existing Linux helper modules: an object type alias, four redundant assertions, a try/promise structure and two throws of a memo typed unknown. The same two production preimages remain in current repair35cea655; this is not a claim that the new parent CI has finished.

The other old test-shard failure, management-model-probe.test.ts434's SDK transport optional-property mismatch, is already corrected in the published B1 source and passed the root's clean Host test type check. Do not change that test or the SDK again for this slice.

| Path | Exact current preimage | Bounded change |
| --- | --- | --- |
| `src/main/utils/linuxChildLaunch.ts` | `17fc7cdd21d5a5fff9527c114b96bef7372571d2` | Use an interface for Handoff, remove only the three redundant assertions reported in this file, and separate synchronous original cleanup invocation from its returned promise rejection handler. |
| `src/main/utils/linuxChildLaunchSelection.ts` | `86103b92c6c8dc1dae9333c19afc53c730b2cba8` | Keep the exported boolean classifier unchanged, narrow the original memo assignment locally to Error-or-undefined, and remove the one already-narrowed string assertion. |
| `test/main/utils/childProcess.test.ts` | `9446abefc6578baaef789bfa333dec085bda7052` | Remove only execStatus's widening return annotation; infer the exact Buffer.alloc return. |

Root rechecks these preimages in all three working trees. There are no workflow, dependency, descriptor, native C, provider or unrelated formatting changes.

### Review 2 — preserve the original effects and failure identities

`isLinuxChildLaunchFailure` returns true only for a LinuxChildLaunchFailure (an Error subclass) or an Error in the original WeakSet, but false also includes ordinary Error instances. Keep its exported boolean signature and body byte-identical: an `error is Error` predicate would incorrectly exclude ordinary Errors from its false branch. Type only the original memo as `Error | undefined`; at its existing assignment retain the original classifier first, then use `&& error instanceof Error` for local narrowing. A true classifier already guarantees this second condition, so the same original Error object is retained; every other value still constructs the same fixed selection failure. No cast, wrapping, changed classifier call order or new fallback is introduced. Keep the original initialization, repeated-selection refusal, native allocation classification and every thrown object unchanged.

In linuxChildLaunch, replace only the Handoff declaration syntax, remove the two unnecessary `frame[5]!` assertions after the exact-length guard, and let Buffer.isEncoding supply its existing narrowing without `as BufferEncoding`. In Selection, retain the original typeof check and pass its already-narrowed row[key] to hashPattern without the cast. Do not remove any length, frame, checksum, file identity, descriptor, directory, architecture or option predicate.

The cleanup callback needs both boundaries: it may throw synchronously while obtaining the original cleanup promise, and that promise may reject later. Keep the callback invocation synchronous in a try/catch, retaining its returned `Promise<void>` in a local. On a synchronous exception, invoke the same kill closure and return from the failure listener. Outside that try, attach the same rejection handler to the returned promise. The actual original caller in childProcess.ts (`7ce6cfe1150747d6a43bd9854bd86b209eb44597`,184–187) returns its original killProcessTreeAndWait promise; it does not return a custom thenable. No deferred invocation, extra microtask wrapper, await, child discovery, event synthesis, signal target, deadline or second cleanup owner is introduced. The callback remains pending until this exact child's genuine close, and the tree owner's cleanup still begins before any fallback immediate-child signal.

The TEST execStatus helper continues allocating the same12 bytes and writing the same magic/version/stage/errno. It returns that same original Buffer with an inferred non-shared ArrayBuffer type. No copying, casting, changed synthetic event, widened mock contract or assertion is needed.

### Review 3 — bounded verification and publication

Root publishes this appendix after independent plan review, then reviews and publishes only the three exact source deltas with immediate pushes and ref/tree/blob readback. Source-only review must distinguish erased type changes, the equivalent local Error narrowing and the narrowly equivalent valid-Promise cleanup control flow; no lint rule, type check or platform guard is disabled.

Use the existing childProcess critical cases, the existing source-size guard, Main test types and the normal type-aware Main lint shard. The earlier fast lint result does not cover these type-aware rules, and the earlier54 passing childProcess runtime cases do not establish test compilation. Do not add a new suite or expand native inputs. The ordinary existing CI remains authoritative for native helper/custody and full application qualification; no active head is replaced or manually rerun for this static correction.

The local executor became unavailable before this proposal. That does not make a source review or a queued CI run a successful check. Keep execution pending until the existing checks actually complete through the restored normal environment or ordinary exact-head CI.

## 77. Mixed Settings failure summary: follow the original nested proof owner

### 77.1. Evidence and exact remaining uncertainty

The original mixed V1/V2 Main jobs 132132912633/132132912657 in run 43497088359 and the later exact-checkout 0543d437695318f0157e6d600d76abdce5c51e8e jobs 132237640568/132237640765 in run 43527759884 have the same closed failure projections. They retain 10/9 UI steps respectively, with the last step the original OpenCode Manage mouseClick marked attempted; both retain final cleanup remaining 6, capturedHostAbsent:false and appSignalCode:SIGTERM. The final cleanup assertion is an independent unresolved debt and can mask the earlier error in the console. It is not permission to signal again, relax absence or mark the journey passed.

The new full original job logs are immutable blobs c5d030df2e7b16db01695e513ed9c9b76a95ada4 (V1) and 063a564c5ad2d9d3eaead345fa623a0b9fe9d4a4 (V2), with complete readback. Their artifacts are 14087660020 (185644 bytes; ZIP SHA256 88cda10ee664fc8cdcb0451ddb1b431f5ca6adbddb7232effee8cff119916fca) and 14086698584 (187143 bytes; ZIP SHA256 f6ed76a8f4a208a46866344baea34f2b2184950a79a0c2938e38071d17b5e252). Their name suffix is d7419a7f67d0f6fce6486f294c609d6b5d4b86f7, distinct from the checked-out PR head; the earlier artifact suffix is ddea0acc3cab5b487f43f563335220aca364913d. Full old/new receipt source identities and archive members are still unread because the executor is unavailable. No claim of artifact source identity is made from these suffixes.

This amendment corrects a demonstrated source projection defect, not the cause of the UI failure. The existing attempted click is recorded before the two original CDP input commands finish; without the original receipt it does not establish DOM delivery. Actual Manage in CliStatusBanner 0d811b6e5c980876b7eaca5846f459bdd61fe895 only selects the provider and opens its existing lazy dialog. The nested Models tab is present independently of catalog completion but may remain disabled by the original state. No guessed lazy-load, input, native catalog or cleanup cause is adopted.

### 77.2. The original owner and one-line correction

The original desktop-mixed-create-launch-ui-smoke.ts 3b689edbe2a5dd9f0c1af453164dc2397ba5839d assigns its proof to evidence.mixedCreateLaunchProof, then passes that same proof as the evidence argument to createMixedProviderSettingsProof. The original desktop-mixed-provider-settings.ts 522c99c88a9ddbb0dfa7a7397046188aa963402b assigns providerSettings on this passed object before returning the helper whose runPrelude emits the Settings/Manage steps. Thus the retained Settings record belongs at evidence.mixedCreateLaunchProof.providerSettings.

The existing projectDesktopMixedSettingsFailure instead reads providerSettings from the root evidence. Its settingsRecorded:false, settingsStatus:null, settingsSteps:null and settings-derived milestone/owner fields therefore do not locate the original failure. Change only that own-data lookup to read providerSettings from the already captured mixed object. Do not create a root alias, relocate stored proof, add fallback to a foreign root record or infer a missing/malformed nested record from UI steps.

| Path | Exact preimage | Bounded change |
| --- | --- | --- |
| scripts/legacy-agent-host/desktop-backend-observations.ts (parent) | 6b6c3fa3846c9dd080223865866f5baceb8be7e3 | In the existing mixed failure projection only, replace own(value, 'providerSettings') with own(mixed, 'providerSettings'). |
| Same path (native child) | 5c24c871fb066476eba002a3e08a889311539658 | Compose the same one-line lookup change on this original variant; retain every existing Linux admission, listener and fixture-correlation difference. |
| Same path (qualification child) | b9e0769cb89f5cc6ef536f109341642cd0ec1d31 | Compose the same one-line lookup change on this original variant; retain every existing Linux listener diagnostic difference. |

Keep root coldSettingsBoundary and cleanup observations at their original owners. Preserve every closed field, enum, count/byte cap, own-data descriptor check, getter refusal, null/missing semantics, all original errors and throw/finally order. The summary remains failure-only diagnostics; no product/runtime/renderer/source/custody code, clicks, CDP calls, IO, listeners, timers, retries, budgets, inputs, cleanup signals or acceptance assertions change. The parent preimage was verified and its one-line source published first. The publication guard then stopped before either child because their existing Linux diagnostic variants have different full-file preimages. Their mixed failure projector is byte-identical to the original parent projector. Apply the same one-line delta separately against each verified branch preimage above; never replace a child file with the parent candidate. This refinement changes no source scope or behavior.

### 77.3. Review, checks and next evidence

Root publishes the plan before source. Independent review verifies the two original producer assignments, each original branch preimage and its exact inverse: removing this one-line delta recovers that branch's entire original file. The existing source-size/types and ordinary mixed UI acceptance remain required; no new test suite or diagnostic-only native rerun is added for this record-owner correction.

The first substantive runtime diagnosis still comes from the original archive: evidence.failure, nested mixedCreateLaunchProof.providerSettings and its steps, rendererFailureSnapshot.inputEvents and visible DOM, rendererDiagnostics, failureQuit, beforeHarnessCleanup and original group/Host observations. The receipt was already written before the console cleanup assertion. Read these original retained facts when execution becomes available, or the next already-authorized ordinary CI artifact; do not add diagnostics merely because transfer/extraction is temporarily unavailable. Corrected summary output does not establish that Manage delivered a click, that Models became usable, or that any cleanup debt settled. Actual mixed V1/V2 parity remains INCOMPLETE until the original UI, native, cold-start and absence assertions pass.


## 78. Genuine Claude checkpoint upgrade: retain the original optional launch preparation

### Review 1 — a valid original journal without a separate preparation

Parent0543d437695318f0157e6d600d76abdce5c51e8e Main43527759884/job132237640813 reaches the original pre-Quit checkpoint capture and fails at desktop-claude-checkpoint-upgrade.ts324: journal.preparation is undefined. Artifact14088430723 is verified (788465 bytes; ZIP SHA256 828a4fd0067f35e3d7d0cfb1d2f4cb9790bbb23e07d1b3e8ce99351fe4e829c3); the803951-byte Desktop receipt has SHA256 efca788cfd7b0857dcbb2afe7e675582a97d74d3b28127d893ca04ac08d164fe. The original3552-byte captured launch2525357400d479fa54e634092b9e030d5c9f99506f8d3a16a3aae0834c4bd201.json has SHA256 8c7d39f328d4370366fcc57198abce930b6faabeef10b298481d1c53c6a29122. It contains the original definition.capture, saved settings and MCP recipe reference, selected member, sourceRosterRevision and a ready claimed attempt, with no preparation property. Its selected baseConfigurationDigest and configurationDigest are equal.

This journal was emitted by the genuine exact1d0f97f55de566036c970eab4f36b84620afdb3f Host. That commit's validateLaunchPreparation78b708cecb6956ee703969b1c4b35191e56bc639 explicitly accepts absent preparation. Its createMemberEntryf2a7008beff70622fab1330cf25da05ecff061fa starts from the original base profile, applies launch configuration only if the retained selection contains it, restores the selected generation and verifies the derived digest. A captured saved configuration can already be fully compiled without a second options preparation. Do not invent such a preparation or treat absent preparation as permission to ignore any digest.

### Review 2 — reproduce that original read-only reconstruction

Only scripts/legacy-agent-host/desktop-claude-checkpoint-upgrade.ts changes, from common preimage2f1b01ca94f00f465e1417eed20d6b5c98a750df. Preserve the existing original Host imports, complete journal validation, captured namespace checks, compileRuntimeCapture, recipe/launch/member/binding joins, base digest and original attempt/incarnation assertions before this point.

Start the local effective-profile calculation from that already verified original base. If journal.preparation is present, retain the existing exact-one-member selection and applyLaunchConfiguration from the original Host module with that original member configuration. If it is absent, keep the verified base unchanged; do not call applyLaunchConfiguration with invented empty/default input or read a current selector. In both paths apply the same retained runtimeGeneration and require the same final runtimeDigest equality with the selected member, followed by unchanged generation/configRevision/sessionId equality with the original runtime record. Present-but-malformed preparation still fails the original journal validator and exact-member assertions. No cast, optional-chain success fallback or skipped equality is allowed.

All checkpoint bytes, original private files, executable/SDK/dependency/entry pins, natural whole-owner equality, source freeze, old donor Main/Host authority, Stop/Quit, successor descriptor, cold actual input TWO and custody requirements stay unchanged. No product launch/runtime/read/restore behavior, checkpoint rewriting, caller-owned override, constructor side effect, native input, retry or deadline is added.

### Review 3 — source and the same actual upgrade gate

Root publishes the plan first; independent review checks the exact original1d source and the retained launch, and verifies that both reconstruction paths converge on every existing digest/identity assertion. Run the existing script types, source-size checks and the same ordinary cold selected Claude Resume CI. No new unit suite can substitute for this genuine old-Host checkpoint journey. Source review and the first epoch do not qualify the second epoch; status stays incomplete until the original full upgrade and physical cleanup pass. Push each commit immediately, with no main merge or active-head replacement.


## 79. Current-stopped legacy catalog: repair the original live counter before attributing the ninth read

### Review 1 — original evidence and exact limits of the diagnosis

The original parent head is `0543d437695318f0157e6d600d76abdce5c51e8e`, tree `d6fd8db73820ec74e375f5cf2b36e0b4fe1bafd0`. Artifact14087676265 has ZIP SHA256 `7c252c86563b76949ef6b61a93f940c22d0f4eed80e82cd58828bdcff8595657`. Its original `stopped-import-prior-run.json` is29662 bytes/SHA256 `f72a7958ee2cf23f64eca11655f741706ad11783a643be91f3386c8a747a9a4b`; `desktop-backend-receipt.json` is308824 bytes/SHA256 `4de21caa4cd9102c04077afa14ad42302e09a77047314693605f6814f40db97f`; the original app log is9146 bytes/SHA256 `09532ca7b67c3f16f562bdd5ad85a04769bff99c552d38589fdf97d46800c4e6`. These original extracted members were read and independently hashed. The first sealed model failure is exactly `bounded original legacy catalog reads`, with zero business/probe input observations and clean original cleanup. The receipt reaches the launch-settings hover after selecting Sonnet4.6; it does not record the optional-settings press or the later business prompt. The diagnostic reports `catalogLimitExceeded:true` and `catalogReadsAtLeast:9`, yet all existing phase/step counter projections report0.

The contradiction has a deterministic TEST source cause. In `packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts` blob `f73aee50c9495d01cc114812ef2d30f05b331882`, the original GET handler increments the closure-owned `currentLegacyCatalogRequests` before the unchanged `<=8` assertion. At lines827–834 the returned model uses a conditional object spread containing a getter with that name. JavaScript spread reads the getter once while constructing the return object, copying its initial0 as an ordinary data property. Consequently `desktop-stopped-import-prior-run.ts` blob `41270638b4c552e5f535ff966506fbfaa1e6b13a` lines202–205 and its existing failure projection see a frozen0. The original `finishCurrentLegacySource` closure reads the live variable correctly, but it closes the producer epoch and is not a read-only diagnostic substitute. Do not call it after failure to recover the count or manufacture a successful donor.

Exact original runtime0.0.158 source is repository `777genius/agent_teams_orchestrator`, tag `v0.0.158`, tree `f5c69c2e9024ffc36a5db5eafe30f53539b52f62`. `src/services/runtimeBackends/anthropicCatalog.ts` blob `adec3f0b3655f691c0efa87ae0910e7e7625a707` has process-local cache/in-flight state and the compatible-endpoint list GET at929–950/1259–1266. `registry.ts` blob `57f89dd1d54b7dd5c124933c2290db460ec49209` calls that catalog for full Anthropic status at442–469; its separate summary at472–535 does not. `src/cli/handlers/model.ts` blob `e488fa67903605b605d245153c57862a167f42ef` also calls that catalog. A new full-status/model-list process can therefore make a fresh GET even after another process completed. This establishes native call semantics, not the identity of each original GET sender.

There is a concrete source candidate for repeated UI reads, but the artifact does not prove it alone exhausted the cap. Original `CreateTeamDialog.tsx` blob `0a06948c13254c1b5fb724b5483629b546726357` line634 uses `useProjectScopedRuntimeProviderStatuses.ts` blob `86ef08f91debd3b23c296a3dc9dd743592f45a06`; `useTeamModelProviderStatus.ts` blob `fca15f048890ec180c188fea3f6ff1305a23d857` issues the scoped read when enabled. Later expansion mounts `LeadModelRow.tsx` blob `08dae7b331b457809333f31d56a776f74489e726` line290 and `TeamModelSelector.tsx` blob `51d0421e7b01acb87390d2e6ed4b685c22776c45` line1156 with the same prefetch enabled. A completed earlier read is not joined: Renderer `cliInstallerSlice.ts` blob `3958bb219db5509e6c6433a006e5a0bfacb2791f` only shares in-flight requests; `ClaudeMultimodelBridgeService.ts` blob `68e89e584395a022fa4e7b4d7017a7f3a397f154` line1277 permits completed-read reuse only for scoped OpenCode. Its global catalog hydration is another original caller. These source files were compared bytewise with the original0543 tree. The original captured PID/birth list has no argv/IPC-to-GET join, and the eagerly copied counter lost its phase distinction; do not assign all nine reads to a particular hook, infer an automatic loop, or change production freshness from this evidence. The three shutdown `prepareProvisioning` errors name unresolved Control API startup; `TeamProvisioningEnvBuilder.ts` blob `87e37ef5d543922ea3dd902417ce256a6ac5b239` line402 awaits that API before returning the environment, while `TeamProvisioningPrepareCoordinator.ts` blob `230902c1bf488a71ec4ac42b5d1fe481b73ebae0` awaits environment construction before its probe/model checks. Those errors are not a retained trace of nine successful catalog reads.

### Review 2 — two existing TEST paths, no new observation or authority

| Existing path | Exact source preimage | Authorized change |
| --- | --- | --- |
| `packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts` | `f73aee50c9495d01cc114812ef2d30f05b331882` | Return the same constructed model object with a live own accessor for `currentLegacyCatalogRequests` only when the original `currentLegacySource` option is present. |
| `packages/legacy-agent-host/tests/fixtures/native-claude-team/model.test.ts` | `c9f50944bba48a40c93dcdfb32fdbb37fff1985f` | Extend only the existing current-legacy source case to observe the already-counted reads and independently retain the original eight-read refusal boundary. |

Use a local result object and a narrowly conditional own-property definition, preserving the existing returned object's type inference, enumerability and absence of this field in unrelated modes. The accessor only returns the original closure counter. It does not increment, perform I/O, close an epoch, capture a process, publish status, or grant readiness. This avoids replacing the eager getter with another spread, adding a second counter, widening every model mode with an undefined property, or copying a later snapshot once. Keep all original return fields and methods on that same object; no generic getter helper or new file.

In the same existing test, retain the current positive two-catalog-read/one-text-turn/one-probe/close flow. Add observations0 before its first GET,1 after the first accepted original URL,2 after the accepted `?limit=1000` URL, and2 after the original epoch's existing late refusal. Keep `finishCurrentLegacySource`'s original frozen2 assertion. Add one fresh current-legacy sub-scope inside that same case: its first eight GETs remain accepted, its ninth is the first `bounded original legacy catalog reads` failure, and a subsequent refused read cannot advance the already sealed original counter. Assert live8 then9, original failure identity and zero business/probe allocations. Preserve the field's absence in the already existing unrelated-mode sub-scope. These are finite HTTP-only TEST calls against the original local server, not additional native invocations or business inputs; no new suite or case name.

The GET8 cap, POST/input/probe caps, HEAD32 cap, root/body/credential/path guards, first-failure sealing, epoch ownership, pending-read drain, model reply bytes, timer values, native census, original UI sequence and all cleanup decisions remain byte-identical. The existing producer phase/step/failure readers are unchanged and automatically observe the live value. Do not add request logging, CDP collectors, native probes, a retry, a sleep, a UI action, cache/TTL changes, or a cap increase. The actual native catalog-cap failure remains unresolved until its original ordinary gate completes; a corrected diagnostic cannot qualify that run retroactively.

### Review 3 — review and existing gates

Publish this plan before source. Freeze and independently review the exact two-file delta, preserving all existing positive/negative assertions and the source-size limit. Root runs existing Host TEST types and the affected existing model test file in the owned build slot, then the same ordinary current-stopped producer gate. Source-only or synthetic HTTP success must remain separate from the actual native source/physical cleanup proof. Use the repaired existing phase counts to resolve any remaining original-caller question; a production read-sharing change requires its own reviewed source/authority plan and cannot be inferred as authorized by this counter repair. Root alone publishes and immediately pushes; no active live PR head is replaced.


## 80. Provider Manage: shared API-key reads belong to the original API-key provider views

### 80.1. Original failure evidence and the independent source defect

Parent0543d437695318f0157e6d600d76abdce5c51e8e Main43527759884 fails mixed V1 job132237640568 and V2 job132237640765 after the original OpenCode Manage action. Original artifacts14087660020 and14086698584 were downloaded and their complete ZIP hashes verified: 88cda10ee664fc8cdcb0451ddb1b431f5ca6adbddb7232effee8cff119916fca and f6ed76a8f4a208a46866344baea34f2b2184950a79a0c2938e38071d17b5e252. Their extracted Desktop receipts have SHA256 0ddddc4d6f1471f817dcfd7ef8ad75ec12ec64cab8a26b3cd1f4f0bc814aeb79 and 5c02a37a0bf11bec0325413835e17634987e6becc882059985e71727467fe968. This supersedes only §77's earlier unread-receipt boundary; the artifact-name suffix is not source identity.

Both receipts retain failure "CDP command timed out: Runtime.evaluate", unavailable renderer failure snapshot/screenshot, and an attempted but unconfirmed timed-out Quit. Nested mixedCreateLaunchProof.providerSettings is present and INCOMPLETE, with no completed Settings steps. The final UI step records attempted Manage mouseClick at29189ms for V1 and31103ms for V2, before the original two Input commands finish. Configured native-model observations/probes/failures are empty. Cleanup leaves the original Electron process and five children, including the original captured Host; capturedHostAbsent remains false. Neither DOM delivery nor successful cleanup follows from the attempted click. Both app logs contain openCodeRuntime:getStatus "Backend routing: hold", but no original stack locates the later CDP stall. Keep that refusal and cleanup debt separate.

The next existing journey operation is modelsTab→scrollTo→Runtime.evaluate with a synchronous DOM query and parentElement traversal. Actual UI-controls15703898ff4639a442745f93c6083688b1c04ff4 advances parentElement on each iteration; no source-proved infinite TEST loop was found. Original selected-source hashes for the dialog, extensionsSlice, extensions IPC and UI controls match the inspected bytes. ApiKeyService published source and compiled Main digest remain separate evidence; no reproducible source-to-bundle equivalence or native stack is claimed.

A smaller source defect is established independently. ProviderRuntimeSettingsDialog87b55692a18e7f2816f0bfc6c7cbc59f1dd94d1a758–766 unconditionally calls fetchApiKeys and fetchApiKeyStorageStatus on open/initial-provider change. Its existing isApiKeyProviderId193–195 accepts only anthropic, codex and gemini. For OpenCode, selectedApiKey/apiKeyConfig are absent, showApiKeySection is false and the shared-key storage-info UI is unreachable. Its original RuntimeProviderManagementPanel owns OpenCode's own provider credentials. OpenCode opening therefore requests shared-key list/decryption and storage availability whose results this view does not consume.

The original chain is extensionsSlice754ed5045d34afaa6820fe6327474c8ee32bcb461127–1155→apiKeys list/storage IPC→ApiKeyService13499598e8270c34e76422ba60fcc18f657d18df. getStorageStatus207–208 calls isSecureBackend235 and safeStorage.isEncryptionAvailable synchronously before its first await. list68–78 decrypts existing stored keys; save94–96 encrypts them. The constructor only captures a path. Repository source has no other renderer caller of fetchApiKeyStorageStatus. Earlier stored-key list/lookup/decrypt or save/encrypt could nevertheless have reached the OS facility, and Chromium can initialize encryption independently. An absent collected key-store file does not establish that those calls never occurred.

### 80.2. Exact pinned primary mechanism and its limits

Original pnpm-lock2510bda55aa76aedb090cd8d4e37383edb2c4e10 pins Electron44.10.1. Its [safeStorage API source](https://github.com/electron/electron/blob/v44.10.1/shell/browser/api/electron_api_safe_storage.cc), a5a765fe8ebfac1796f1d0be2ff03ed8f6ffbe5a147–156, synchronously calls OSCrypt::IsEncryptionAvailable in Main. Its [pinned documentation](https://github.com/electron/electron/blob/v44.10.1/docs/api/safe-storage.md), 30d76a8b9bd888f988d95be3feb0927a12037d49, describes possible current-thread blocking for macOS Keychain user input.

Electron's [pinned restore patch](https://github.com/electron/electron/blob/v44.10.1/patches/chromium/revert_oscrypt_remove_sync_backend.patch), 1768af62b90eaaf571a37d8db2460ad8f3c8895f, supplies the synchronous implementation removed from upstream: IsEncryptionAvailable→DeriveKey under the original lock→KeychainPassword.GetPassword. Already-derived-key and previous-failure branches can return immediately; a cold availability call can enter Keychain. Electron DEPSd61cdf4fad70083b7a21042900f3ce6a0b0c51ea pins Chromium152.0.7977.169. Its [keychain password source](https://github.com/chromium/chromium/blob/152.0.7977.169/components/os_crypt/common/keychain_password_mac.mm), f240dc22ee391c98c8768af7141b7447b6507cc6, and [KeychainV2](https://github.com/chromium/chromium/blob/152.0.7977.169/crypto/apple/keychain_v2.mm), ab98692fea614cec6b8ad891e59420ca8958a66a213–223, reach SecItemCopyMatching. Pinned Electron MAS patch9c598df4e0c251ff0851e2171d4793f6c77db4ca adjusts service/account lookup, not this synchronous boundary.

A target Runtime.evaluate timeout does not establish a renderer-only stall. The [exact Chromium152 DevTools HTTP handler](https://github.com/chromium/chromium/blob/152.0.7977.169/content/browser/devtools/devtools_http_handler.cc), fbfe1abebb19119387d55a1296aba5fd1ca7d99b529–532, posts each WebSocket message to BrowserThread UI before885–890 forwards it to the connection client. Main/UI blocking can delay dispatch to the renderer. This makes the mechanism compatible with the symptoms; the original artifacts have no actual Keychain prompt/stack or call entry/exit record. Do not declare either actual timeout caused by Keychain. Remove the independently proved unused potentially blocking work, then require the unchanged ordinary native gates.

Do not substitute isAsyncEncryptionAvailable as an equivalent security result: its exact implementation initializes a different encryptor with different availability semantics. No OS prompt suppression, mock Keychain, signing change, plaintext/AES fallback, exception-to-success, encrypted-storage bypass or new timer is proposed.

### 80.3. Two existing paths and original UI transition ownership

| Path | Exact common preimage | Bounded change |
| --- | --- | --- |
| src/renderer/components/runtime/ProviderRuntimeSettingsDialog.tsx | 87b55692a18e7f2816f0bfc6c7cbc59f1dd94d1a | Scope the original pair of shared-key reads to the existing isApiKeyProviderId and the original open/initial-selection or accepted provider-tab transition. |
| test/renderer/components/runtime/ProviderRuntimeSettingsDialog.test.ts | 67872d8c5093f03f1ff849b837d5d02b209783c2 | Expand the existing OpenCode management-panel case with call counts and actual tab/open transitions; keep every existing test name and key form/save oracle. |

Use the same two store functions unchanged. Keep the original initialProviderId selection effect. Request shared details only for anthropic/codex/gemini; an OpenCode opening or OpenCode-only rerender starts neither read. A small component-local ref may remember that this pair was requested within the same original open/initial-provider scope. It contains only an attempted-read boolean, never a key, availability, grant, source, outcome or permission. Reset it at the beginning of every execution of the original opening effect: close, initial-provider change and either store action identity changing all start the same fresh effect scope as before. Preserve original StrictMode/effect replays; never turn this into a mount-only or ever-read cache. The local helper also refuses to dispatch while open is false. Stable action identities on an ordinary rerender do not restart the effect. The original store functions retain their current-context guards and success/failure handling.

The opening effect must use the original initialProviderId, not stale selectedProviderId from the previous opening. Close-on-Anthropic→reopen-on-OpenCode must not initiate a keychain read while the original selected-state effect catches up. Preserve the original dependencies on open, initialProviderId and the two action identities, directly or via the local stable callback, and the immediate original initial selection.

For the first API-key provider tab selected inside an OpenCode-opened dialog, call that same request-pair helper in the existing Tabs.onValueChange branch under its unchanged !runtimeProviderOperationBlocking guard. Keep provider selection, keyboard/tab interaction, active-operation exclusion and all API-key forms/controls. One shared read already fills the same all-key store for other API-key tabs in that scope, so changing tabs does not repeat it. Initial API-key opening still requests the original pair. Reopening starts a fresh original scope as before. No automatic retry, new promise owner or authority/cache is introduced. Existing in-flight reads retain their original context handling; they are not cancelled, replayed or promoted into new authority.

No Main service/IPC, preload, DTO, source selection, native catalog, key read/decrypt/encrypt/storage policy, save/delete, Host/profile/owner, launch, permission, cleanup, harness, workflow, native input, clock or budget changes. OpenCode's own Settings management is unchanged. No API-key control or real security result is removed or fabricated. This is provider-view work ownership, not a claim that the OS facility is unavailable.

The frozen production cap stays3113 physical lines (baselinefbdcb4bdd5bef2ed13c34821c451d0c965e3b8e0); the original has3084. Stay within that cap without a baseline edit, generic abstraction, new file or large-dialog refactor.

### 80.4. Existing-case verification and actual acceptance

Retain the existing OpenCode test's original panel fields, connection/configuration callbacks and exact refresh reasons. The existing local Tabs mock203–233 currently renders buttons without invoking the original onValueChange. Wire only that local mock through a small React context so a test tab click calls the original supplied callback and preserves disabled and any original onClick; do not set product selection state directly or claim a no-op click exercised a transition. This is the same test file and original UI callback, not a new product seam, framework or native effect. Extend the same case with its React render/tab and mocked store boundary:

- OpenCode reaches its original panel with both shared-key counts zero, including an ordinary rerender.
- The first accepted API-key tab selection calls both original functions exactly once and leaves its original key view reachable.
- Returning to OpenCode or selecting another API-key provider in that same scope does not repeat the reads or cause save/delete/config mutation.
- Close while an API-key provider is selected and reopen with initialProviderId OpenCode: counts remain unchanged despite stale prior selected state. A later explicit API-key selection starts one fresh pair.
- An initial API-key opening still requests the original pair. A changed identity of either original store action starts a fresh original effect scope and read pair for an API-key opening; stable identities do not. The original StrictMode/effect replay must not be suppressed by the attempted-read ref. Keep all existing Anthropic/Codex/Gemini encrypted-key save, deletion refusal and connection tests unchanged.

Publish and independently review this plan before source. Review exact preimages/inverse, unchanged key/storage service bytes, tab guard, effect dependencies and reopen semantics. Use the existing dialog file's focused tests, renderer types/lint and source-size guard in the root-owned serialized slot, without a duplicate suite or native probe. The original ordinary mixed V1/V2 Settings→Create→business→cold→cleanup journeys remain mandatory with identical real UI controls, catalog/model/default/permission/native counts, physical cleanup assertions and deadlines. Their next result can establish whether this correction is sufficient or expose another cause. Source/unit PASS is neither native parity nor proof of the earlier Keychain hypothesis; no failed receipt is rewritten or reclassified.


## 81. Saved donor import: retain the original sentinel boundary before current Main

### Review 1 — separate the missing evidence from a routing claim

The original parent0543d437695318f0157e6d600d76abdce5c51e8e saved-import job132237640693 retains a successful exact4a0e06277fe216d9f82dbbede362668fe46622ee donor save-only epoch and successful current import/reload lookups, then fails the original whole-log sentinel assertion. Verified artifact14086554483 has ZIP2031249 bytes/SHA256 bfff2fd626ca466d7ce486315f35e73da72ab60ee9fc2f3d9fcbe6e7164145e0; the original729580-byte receipt SHA256 is ad50fa558508ab89c650badc666e58511375bcc0180dd60cdec73aefcd4f0f6a. The common census includes two refused codex calls with argc1 and no option flags. It retains neither the original non-option argument nor the boundary between applications, so this evidence cannot identify their command or assign them to current Main.

The old donor and current application share the TEST Claude root and sentinel log. The producer excludes root/bin from its PATH, but the exact donor buildMergedCliPath source d2d0b04c7b4ec0789d97da085736e34e563e89cf explicitly adds that Claude root's local/node_modules/.bin. The fixture creates the same deny-all-nonversion sentinels there. Old CodexBinaryResolver uses that merged path; old Codex control-plane sessions use an app-server argument. This source makes a donor-time metadata refusal possible, not proven. The original current Main app log instead records a backend-unavailable/not-dispatched Codex account read. Do not infer an actual fallback, excuse the refusals, or classify every one-argument Codex call as harmless.

### Review 2 — bounded facts in the existing producer and log

Change only scripts/legacy-agent-host/desktop-backend-fixture.ts (parent preimage0f1b4bb725633afafd4acf04ff6efd857c997bfa; native child89e1b7e17aec7412529f395ef2276756b09b5eda; qualification child53375bffaa6585d5a7428be796b9e7a9531bff03) and scripts/legacy-agent-host/desktop-donor-saved-producer.ts (common48de0a5c43d4a7c9db2f4762dde217b53d9f5f5b). Apply the same sentinel-record projection to each branch's own source; preserve every existing child Linux preparation and source/descriptor variant byte-for-byte. In the existing sentinel log record add only a fixed redacted command classification for exactly one argument equal to app-server; all other commands receive null. Never copy raw positional arguments, environment, stdin or credentials. Keep the original allowed expression, fixed version bytes, exit0/78 and refusal behavior unchanged. This records an attempted command; an app-server label does not grant metadata or business authority.

In the existing donor producer, after its original successful Quit, original app group/listener/native absence checks and closed donor model epoch, but before returning to start current Main, read the original owned sentinel log once. Use the existing TEST path and a bounded regular-file size check (at most64KiB before parsing); require unchanged size/mtime around that read and complete newline-delimited object records. Missing/corrupt/changed evidence is a failure, not an empty success. Retain the original byte length, SHA256, count and parsed rows in that donor proof's existing receipt. Do not truncate, replace or reset the log, suppress a refusal, launch a probe, execute another native command or change the saved product corpus. The existing producer status still requires all original native/model/source/cleanup conditions.

The ordinary current Main and final whole-log sentinel assertions, permitted-call predicates and all consumer source/input/cold checks remain byte-identical. The next ordinary run may still fail that assertion; its retained boundary and fixed command classification will establish whether any specific refusal belongs to the already closed donor or to current Main. A future acceptance or production routing change requires that evidence and a separate reviewed plan. No additional diagnostic-only run, collector process, workflow, retry, timer or cleanup exception is introduced.

### Review 3 — preserve the current failure until it is explained

Root and a peer compare the exact two-file delta, especially unchanged sentinel execution and whole-log consumer predicates. Run existing script types and source-size checks; do not add a new unit suite for this read-only diagnostic. Use the next same ordinary actual donor/import E2E. The old receipt is not retroactively reclassified and this evidence correction is not a native or routing pass. Commit and immediately push, leaving active live heads and main unchanged.

## 81.1. Preserve the existing exact sentinel fixture expectation

### Review 1 — existing consumer and platform boundary

The §81 fixed redacted command field is published in working source72dc5d82796396de336c935da0edbb8311c1f116. scripts/legacy-agent-host/candidate-runtime-paths.test.ts compares the complete generated sentinel records: its codex --version object lacks the new command:null field. Parent/qualification preimage is b98e1fffc943074c710894149e31b4fa05761f7b; native-child preimage is 96294445978e533b6485232e691caaa46320a723. The affected packed-paths case is Darwin ARM64 only in parent/qualification, while the existing native-child variant also permits Linux x64. Preserve both original platform conditions. The current workflows do not invoke this particular file directly, so do not claim an automatic future script-test pass. Ordinary Desktop acceptance predicates remain unchanged.

### Review 2 — one field in each branch's own test

Add command:null to only that existing expected codex --version object. Preserve complete deepEqual, original three sentinel calls, refusal/exit checks, shell rows, subsequent metadata rows and slice(3), original platform skip and every unrelated variant byte. Add no case, provider call, fallback, timeout, cap, workflow or production change. Do not project away the added field or weaken exact record equality. The same one-line edit must invert to each branch's own exact preimage.

### Review 3 — focused execution and honest qualification

Root and peer verify both exact variant deltas against the generated §81 sentinel record. Materialize the current native-child source with this one-field correction in an isolated checkout; reuse available Git objects, then use a fresh canonical frozen install rather than copying dependencies. When the current heavy check has released its slot, run the same existing test file on Linux x64 under pinned Node24. Its original native-child condition must execute the packed-paths assertion without a platform override. A Linux skip in parent/qualification is not a pass for their Darwin-only case. Retain exact source/test identities and actual case counts; direct Darwin execution and native donor/import qualification remain unclaimed. Publish the reviewed correction with immediate commit/push/readback after this focused existing Linux case passes. No additional test suite, platform substitution, native provider launch, runner or CI replay is introduced.


## 82. Linux V2 credential native oracle: retain the exact original metadata owners across source publication

### 82.1. Original observed failure and the limit of that evidence

This is a one-file TEST correction proposed after the completed original workflow `43527760087`, Linux job `132237640331`, at source head `0543d437695318f0157e6d600d76abdce5c51e8e` (before R32). The native lifecycle and model-probe steps passed; the following existing credential case failed at `opencode-v2-credentials.native.ts:66`, called from line 220, with `2 !== 1` and the original message “the Host owns only its catalog and current finite operation”. Publication of source B and its passive directory read had already returned successfully. The failure is not the earlier credential-selection `held` result and does not establish a runtime performance cause.

The official artifact is `14091041749`, ZIP SHA-256 `d965602da1e9b876f9b92c9a3c8664236ce3caaa406102e7676f417822678d33`. Its original `opencode-v2-credentials.json` has SHA-256 `a3afd947bcb821a1751359ab984972872de6def0a2384b732821e4232994ab71` and immutable F blob `26f1e29efc2ddbb455b457f4cf7a0c401d240ebd`. It reports `INCOMPLETE`, `cleanup:true`, one refused model request, and one Host with exit 0/no signal/valid stdout. The original observer asserts cardinality before recording the failing PIDs. Therefore `nativeProcessCount:2` contains earlier observed PIDs, not the identities of the two children at the failure. The later database census was not reached, so `nativeCredentialCount:0` is not evidence that the original key effects were absent. This proposal does not retroactively identify the failing pair or turn the old receipt into PASS.

The same workflow's SPI job `132237640337` actually succeeded; its original receipt blob `52ff48e202d994abef5e23f265bc1709c572d092` retains `qualified:false`, `productQualified:false`, and `packagedElectronQualified:false`. It is not an additional failure addressed here. Subsequent Linux permission/captured-MCP/qualification steps were skipped after the credential failure, so the two earlier successful steps are not whole-lane acceptance.

### 82.2. Exact source cause and retained ownership

The only changed path will be `packages/legacy-agent-host/tests/opencode-v2-credentials.native.ts`, preimage `f9151cadde423af36ba31b5284c526138012ad81`. This blob is byte-identical on original 0543 and the checked current working tree. The one existing test and its four Host epochs remain the only native invocation. No production, D, workflow, shared fixture, public DTO, archive pin, or source inventory path changes are authorized by this section.

Read-only source anchors in F:

| Path | Exact blob | Relevant original behavior |
| --- | --- | --- |
| `packages/legacy-agent-host/src/composition/ProviderManagementCoordinator.ts` | `95187064e85b8c7303105c8924710f2d6e6bafca` | `v2Hosts` is keyed by profile ID; admission adds B without replacing A; `readV2Catalog` selects only its requested profile; credential work closes only that profile's catalog; original seal/close joins all retained catalogs and operations. |
| `packages/legacy-agent-host/src/composition/RuntimeSourceIndex.ts` | `397850fec1e4e25a24c29f77f10d357134609688` | Publication admits the new management profile and atomically publishes B without retiring A; `managementProfile` derives the new profile from the original seed/candidate and exact published identity. |
| `packages/legacy-agent-host/src/adapters/providers/OpenCodeV2ManagementHost.ts` | `97c38270a42b428e60524820e4761f9a3653741d` | Catalog owners emit original ready/closed observations; a retained key-command owner does not emit catalog lineage. |
| `packages/legacy-agent-host/src/adapters/providers/createClaudeCloseDiagnostic.ts` | `6c8bfdfcf34298a7b513f7a9600301d0256bed32` | Existing `opencode-metadata` records contain the captured profile hash, mode, provider hash, original PID/start identity, and ready/released/cleanup-unknown stage; they confer no custody or cleanup authority. |
| `packages/legacy-agent-host/src/adapters/providers/OpenCodeV2CredentialOperation.ts` | `0b7b2bbf7c0538b965551c795a776ec6ed92c1e6` | The original key engine is closed before its verification probe starts. Verification ID is derived from that same command; the original result/cleanup must settle before the command returns. |
| `packages/legacy-agent-host/src/adapters/providers/OpenCodeV2ModelProbe.ts` | `48bfa19034b3cda99a4151855c1cc1f4f37d14a2` | A probe's two private directories are fresh children named from the digest of its exact selected profile and original probe command ID. Its actual Session is private provider-management work. |
| `packages/legacy-agent-host/src/adapters/providers/OpenCodeV2EmbeddedServer.ts` | `a7447324a75e43f566c03eeaf03dc1af67c2b669` | The actual child receives those directories as `XDG_DATA_HOME` and `XDG_CONFIG_HOME`; Linux custody checks `pid:startTicks`, process-group/session identity, executable identity, and original child liveness. |
| `packages/legacy-agent-host/tests/fixtures/native-host.ts` | `429d9dbcfe93733647aacd4da6973e3f2f07631b` | Existing `startHost.onDiagnostic` observes that original child's stderr; original EOF/exit/termination cleanup remains the owner. |
| `packages/legacy-agent-host/src/composition/openCodeV2ModelSelection.ts` | `77f26b866e9aba755d32f055c309ea9bcdb5ddd3` | Existing pure selection produces the actual probe profile and removes the unavailable model's variant when selecting the known fallback model. |
| `packages/legacy-agent-host/src/composition/applyOpenCodeRuntimeSource.ts` | `958e53a9d61cb007b25d2614b8587f5956bf3dcc` | Existing pure source application preserves this exact captured candidate's recipe apart from its published identity/executable. |
| `packages/legacy-agent-host/src/management/profile.ts` and `identity.ts` | `e1af7fe25cd74a1c2710713853eaae729b81ed1a`, `d4e5631330f08ccc4138353f6e2b5f49f7cac01f` | Reuse canonical profile parsing and management digest for the expected original probe recipe; do not duplicate or approximate their normalization. |

After the rejected key, the test opens A's directory again. The existing coordinator retains that new A catalog. Publishing B does not close it. The subsequent B directory read creates a distinct B catalog. Therefore the source-derived expected set at the failing boundary is the exact previously captured A catalog plus the exact newly captured B catalog. It is not a permission to accept any two Bun processes. The next ordinary run must establish these identities from its own original witnesses.

### 82.3. One original, finite metadata lineage per Host epoch

Install the existing `onDiagnostic` callback when each original `startHost` is constructed, before the first handshake or management request. Bind the callback to that immutable Host epoch and original Host PID, never the mutable later `host` variable. A is the original profile/configuration tuple in the fixture. B is introduced only from the successful original publication receipt; its recipe is derived from that original candidate and seed using the existing pure functions above. No ambient/current selection or arbitrary profile can enter the allowed set.

Consume only the existing `legacy-agent-host: opencode-metadata ` line format. Validate the exact closed JSON keys, the SHA-256 of `JSON.stringify([profileId,configRevision])`, `mode:'directory'`, `providerHash:null`, positive safe PID, exact Linux `pid:startTicks`, and the three finite stages. Validate the entire original event prefix before taking any phase subset: a ready record is unique, its release must match its own original identity, released history is retained, and a PID cannot be rebound to a different birth or Host epoch. A foreign/duplicate/reordered/malformed record, cleanup-unknown, or missing required lineage is a failure or unknown proof; it is never an empty successful set.

The original success path has exactly five metadata allocations: A before rejected Connect, reopened A, B before the first cold boundary, B after the next cold boundary, and B in the final epoch. Each has at most one ready and one terminal observation. Bound the accepted metadata ledger globally to ten records across all four epochs, with at most 1 KiB per matching line and one bounded partial line; there is no epoch reset that grants more capacity. Unrelated stderr is neither retained nor printed; its oversized nonmatching lines may be skipped with bounded framing memory. An oversized matching line or an eleventh matching record seals the TEST observer's failure. The data callback never throws into the original Host event handler: it retains only the first closed failure for the existing awaited assertions/final cleanup.

Stdout RPC completion and stderr delivery have no assumed cross-pipe ordering. A missing ready/released row may be awaited passively through the already installed callback, bounded by the original Node test context's abort signal and unchanged 240,000 ms test timeout. There is no fresh per-stage timer, deadline reset, catalog call, probe, or mutation retry. After the required original prefix is available, perform the physical census once; changed/missing physical identity refuses instead of rescanning until a desired result appears. Neither a diagnostic release nor this passive wait substitutes for original Host cleanup or physical absence.

### 82.4. Exact physical child and intent joins

Extend the existing `/proc` direct-child census to retain the original Host parent, PID, process group, session, and field-19 start ticks. Require the same Linux shape already used by `linuxBirth`: non-zombie original child, process group and session equal to that native PID, and exact `pid:startTicks`. Recheck the original identity around the existing `/proc/PID/exe` Bun hash read. Match every live catalog child to its own validated ready record and expected profile tuple; retain the same A birth before and after B publication. Any extra or missing child fails the exact set comparison.

The actual model-bearing child is a finite verification/check probe, not a Team runtime and not the already closed native key engine. Preserve the original four HTTP payload/credential/tool/prompt checks. Before each original Connect or explicit Check call, capture its existing command/profile/configuration/model tuple as that phase's sole admitted TEST observation target. A Connect verification ID uses the existing `connect-verify-` plus canonical digest of that same original Connect command ID; the saved-key Check uses its original `TEST-saved-key-check` ID. Resolve the expected profile through the existing canonical source/model functions, including the original removal of `high` for the fallback model. This does not start another operation or write a new command/receipt.

Do not identify the probe merely as whichever Bun remains after catalog subtraction. At the original HTTP callback, read its original `/proc/PID/environ` through a bounded descriptor read (64 KiB plus one overflow byte; EOF required). Keep only the two exact XDG directory values in memory. Both must be canonical direct children of the original captured data/config roots and have the exact `agent-teams-v2-probe-<first 16 hex digits of managementDigest({profile,commandId})>-<fresh suffix>` prefix. Capture those exact directory paths once for this original intent and reject a different intent, directory, or previously released/reused birth. Recheck the same parent/PID/birth/group/session around this observation. All other environment bytes are discarded, never exported, logged, or included in an assertion diff. This distinct probe namespace prevents an unexplained A/B catalog child from being reclassified as the HTTP-bearing operation.

There is at most one such probe at each of the four original HTTP requests and no probe at settled passive boundaries. Retain its original birth for subsequent absence checks; do not invent identity from a port, PID count, current selector, or command response. The three intervening key-engine allocations remain governed by their original operation close/custody proofs; this observer does not claim to have enumerated those short-lived engines. It adds no signal or kill authority. Diagnostic PIDs and observed paths are proof inputs only.

### 82.5. Stage-specific expected sets and original cleanup

Names A0/A1/B1/B2/B3 denote distinct original ready births, not newly assigned identities or interchangeable allowances.

| Original stage | Exact live metadata set | Original finite probe |
| --- | --- | --- |
| Host 1 initial passive directory | A0 | None |
| Host 1 rejected Connect's first HTTP request | Empty; A0 has its original release and physical absence | The rejected Connect verification only |
| Host 1 directory after rejected Connect | New A1 | None; rejected probe absent |
| Host 1 B publication plus B directory | Original A1 plus new B1 | None |
| Original Host 1 Stop / before Host 2 | Empty | None; all observed original groups/births absent |
| Host 2 corrected Connect's second HTTP request | Empty | Corrected original Connect verification only |
| Host 2 completed/lost-ACK replay and original Stop | Empty | None; original corrected probe absent |
| Host 3 cold directory | New B2 | None; no old epoch child adopted |
| Host 3 saved-key Check's third HTTP request | Original B2 | Original explicit Check only |
| Host 3 completed Check | Original B2 | None; original Check probe absent |
| Host 3 unverified Connect's fourth, held HTTP request | Empty; B2 released and absent | Original unverified Connect verification only |
| Host 3 retained unknown result and original Stop | Empty | None; original held probe physically gone, intent remains held |
| Host 4 cold pending/resume/changed-key/new-ID refusals | Empty | None; zero replay |
| Host 4 final passive directory | New B3 | None |
| Original Host 4 Stop and final cleanup | Empty | None; all original observed groups/births absent |

The full original metadata history and all observed probe births are retained through the case. Every original cold boundary must establish absence of all its previous children/groups before the next Host starts; release records alone are insufficient. The existing `process.kill(-pid,0)` ESRCH assertions remain physical absence checks, not new signal authority. No unknown extra PID becomes an allowed catalog/probe just because it hashes to Bun. Any new assertion failure still executes the unconditional original Host/model/final cleanup, preserves the original failure, and appends cleanup errors through the original aggregation. Do not throw from a new pre-cleanup check in a way that skips original close.

### 82.6. Existing-case validation and acceptance gate

Keep the same single existing native test and all original business assertions. Add only local pure refusal checks within that case, using copies of the already captured A1+B1 proof, to demonstrate that unchanged cardinality cannot accept a foreign profile, a replaced original birth, or an unexplained child. They issue no native/HTTP/management actions and do not mutate the retained original lineage. Keep the real positive continuation through all four Host epochs so the new helper cannot pass by testing copied data alone.

The original 240,000 ms case, 30,000 ms profile/model-probe bounds, 45,000 ms original saved-probe observation, four HTTP requests, three original key database effects, selected/foreign auth preservation, no secret in model context or durable receipts, exact lost-ACK/reconnect/readback, no replay after unknown, model limits, build/source pins, and final receipt predicates remain. Do not increase any cap, timeout, request count, test count, retry, or cleanup allowance. Do not change production catalog retention to satisfy the old one-child assertion. The file must stay below the existing 800-line ceiling without changing a baseline or extracting an unplanned generic framework.

Before source publication: exact one-file source/inverse review and independent owner/lineage peer. Before acceptance: canonical Host test types and relevant source guard, then the existing ordinary Linux V2 native credential gate at the actual candidate head with its original receipt and full downstream lane checks. If an executor is unavailable, these checks remain pending for ordinary CI; source review is not native PASS. No separate diagnostic native run, rerun of the old receipt, or fabricated identity is authorized. Any different actual next failure remains a failure and requires its own evidence before another plan.

## 83. Retained OpenCode source-selection Desktop: restore the original project configuration before choosing Local models

### 83.1. Actual original failure and qualification boundary

This is a TEST-input and existing-UI-path correction, not a product model-classification change. The original [Main run43527759884, job132267613072](https://github.com/777genius/agent-teams-ai/actions/runs/43527759884/job/132267613072) used exact head `0543d437695318f0157e6d600d76abdce5c51e8e`. Its original retained legacy-V1/Host-V2 coexistence invocation passed in374962.304038ms. The subsequent explicit V1 source-selection invocation failed in114940.059575ms with `UI read timed out: original TEST-model; no mutation retry`, at `desktop-ui-controls.ts:171` → `scrollTo:301` → `desktop-runtime-source-selection.ts:559` → `create:652` → the existing native caller. The later V2 invocation was skipped; missing-V2-receipt and INCOMPLETE receipt-gate failures do not establish another native failure. Full original job log: F Git blob `f0794c7a8f01736ef7ae45ca8f1b28bb92cfa143`.

Original artifact14092731950 was downloaded through the official artifact tool and verified before bounded extraction: ZIP486764bytes, SHA256 `ce2fad3ff7c94cc11443149dff0cf58c6ff969906133fbb4385bceb56f21ae9c`,15 regular relative-path members. Its `retained-opencode-source-selection.json` is22050bytes, SHA256 `b912a86f0d6b3b0f23c347ebbd9bc475418ab4dea7bf93cf72b37d276d7b793d`, computed Git blob `f7aa430475ab269f037ea8ab01dd2c12cbfac540`. The extracted index records every member hash. No executable from that artifact was run.

The full original receipt has generationV1, statusINCOMPLETE, cleanuptrue, empty cleanupErrors/modelFailures and exactly one no-tool Host sourcePreflight observation. Its sole namespace is the initial-missing case. Genuine UI installation published app-managed V1B1.19.5 before Create; the final recorded UI action is the physical attempt on `team-model-selector-provider-nav-opencode`, after selecting the original workspace and opening the lead model picker. There is no TEST-model selection, Create submission or business-marker inference. The four `businessInputs` strings are the planned markers, not evidence that those inputs ran. The record has24 existing UI steps. It records input attempts, not a DOM snapshot proving the React callback's final state.

The only screenshot in this artifact belongs to the earlier passing coexistence namespace `TEST-desktop-backend-qYtgAh`, not the failed source-selection namespace `TEST-desktop-backend-6X9mkm`; it cannot prove the failed picker contents. Source analysis below establishes an input/selector contract mismatch without inventing a failed DOM snapshot or claiming that a replacement already passed. No new diagnostic collector or diagnostic native invocation is proposed.

Section80 concerns an unused storage-status call when opening a non-API-key management dialog. This original path performs Providers-page Install and then Create; it never opens that dialog or clicks Manage. Its failure is the existing UI read deadline, not the mixed journey's CDP command timeout. Section80 is not the source fix for this case.

### 83.2. Exact old/current consumer contract

The audited old frontend is `4a0e06277fe216d9f82dbbede362668fe46622ee`. The local inventory, local visibility, route classification and scoped-catalog helper files below are byte-identical between that frontend and original0543. Although `TeamModelSelector.tsx` changed elsewhere, its complete local-inventory/source-resolution, source-tab construction, model-inventory filtering, source normalization and tab-navigation blocks were independently compared byte-for-byte and match. This is an existing frontend input contract, not a newly imposed local-provider policy.

| Exact source | Git blob at original0543 | Relevant contract |
| --- | --- | --- |
| `src/renderer/components/team/dialogs/TeamModelSelector.tsx` | `51d0421e7b01acb87390d2e6ed4b685c22776c45` (old full file `df97ab3a5a56b43038e8f7c2489d83ff4d77d38f`) | Generic OpenCode selects source set `{opencode}`. The existing Local models tab clears source IDs, selects the local route and calls the ordinary OpenCode provider handler. The source-tab list excludes noncurated configured-local rows. |
| `src/features/runtime-provider-management/renderer/hooks/useOpenCodeProviderModelCatalog.ts` | `828a1e6c636cb39b1904ef6bacc545e741060dd6` | An explicit source `opencode` scopes the catalog to that provider; local-model selection uses the ordinary unscoped catalog. |
| `src/renderer/components/team/dialogs/openCodeVisibleModelOptions.ts` | `e185320ef3a87d91e00ab765950e0f1f2c3ced58` | A selected source set excludes a model whose actual source ID differs. |
| `src/features/runtime-provider-management/renderer/hooks/useOpenCodeLocalProviders.ts` | `968bcc7b5b9d6f137cc0c2e36a76df20627fb685` | Existing global/project reads retain the real project provider; provider IDs supply the local-route classification and overlay. Errors remain errors and do not manufacture complete inventory. |
| `src/features/runtime-provider-management/main/infrastructure/OpenCodeLocalProviderConnector.ts` | `8e0804fcbd906067099546e6d3ec4de167ce1aed` | Reads the selected canonical project config; OpenAI-compatible provider, baseURL, key presence and declared model keys come from that file. |
| `src/features/runtime-provider-management/main/infrastructure/openCodeGlobalConfigOverrides.ts` | `cbe3d2b3c5e5fb5b8a6a9fa142b7d9cb26332ba4` | The project reader accepts the existing canonical config candidates and rejects ambiguity/symlinks. Native-profile inline config is not a Main project inventory. |
| `src/features/runtime-provider-management/main/infrastructure/OpenCodeLocalProviderSupport.ts` | `b59158e77f0002298f6adeca91aaf793ea1084ed` | A configured endpoint with a key produces the existing deferred list entry from declared models; this list path sends neither the key nor a direct connectivity/coordination probe. Native OpenCode verification remains required. |
| `src/renderer/components/team/dialogs/openCodeLocalModelOverlay.ts` | `9c15eaa97352e913c09c7e3d84fb2137e56845e2` | The real configured project entry supplies the original model option/descriptor. Needs-verification is selectable but is not verified readiness. |
| `src/renderer/components/team/dialogs/openCodeLocalCatalogVisibility.ts` / `src/shared/utils/opencodeModelRoute.ts` | `49c2f506a3066224bd3197f595a080609e80ab63` / `0085f8eda0b80198a005e26807266d743106a84d` | `test-local` is not a hardcoded known-local ID. Its native-only catalog row must not be treated as a proved local inventory entry. |
| `src/features/runtime-provider-management/main/infrastructure/OpenCodeLocalModelRuntimeInspector.ts` | `90e45c63a10216a8806f1bfa436666405e87798e` | The original clean project-provider entry takes precedence over global fallback; a keyed endpoint keeps the native verification route and does not acquire a direct credential-bearing probe. |
| `packages/legacy-agent-host/src/adapters/providers/openCodeConfiguredAuthless.ts` / `readOpenCodeCatalog.ts` | `14b91af7788556021b884211526e296f1511c61d` / `d909942615af815937366df91ccddf27b639863f` | Literal-loopback OpenAI-compatible config is classified by the existing policy even when the TEST key is present. This policy is unchanged. |
| `src/main/services/gateway/composeGatewayProviderRuntime.ts` | `8ef11bc0c9d8b591ea7133a501c42dd17ba0049a` | The existing Main composition creates the ordinary local provider connector; it does not read the captured native recipe as Main local inventory. |

The source-selection fixture creates a fresh workspace, sends V1 configuration through the captured native profile's `OPENCODE_CONFIG_CONTENT` or V2 configuration through the captured embedded recipe, and gives Main its separate original HOME/XDG environment. It does not write any `workspace/opencode.json`. Consequently a guessed `nav-test-local` is unsupported: the UI does not construct that tab for the actual configured-local classification. Nor does the word “loopback” alone prove Local models membership. A correct Local models path requires the existing project inventory to receive the same original configuration before first use.

### 83.3. Declared scope and immutable preimages

Only two existing TEST paths change. The plan is appended to exact P09 preimage `087f4f769df24a95d668db05ab195014984b9904`. Source preimages were read at the current working heads parent `c423b7336bde14c79c149509cc2c5b0d4778c215`, native `5543a5b8843fb5471e8e4555c9b0595b9143afbe`, qualification `174ee44acfcf6d09a7f3228ce4e2e3cf5456c0d3`.

| TEST path | Parent preimage | Native / qualification preimage | Allowed change |
| --- | --- | --- | --- |
| `scripts/legacy-agent-host/desktop-runtime-source-fixture.ts` | `a8494323be732916183a71cdb65762b27b095603` | `ef1c380e11373c5ff7d2a08bc4788821fd1f8672` | Only the existing explicit `nativeOpenCodeSourceSelection` preparation branch creates the matching canonical project config before any owner. |
| `scripts/legacy-agent-host/desktop-runtime-source-selection.ts` | `a5e0032b24f1480a8db18f1e723d2c7ab4c2c8bd` | same | Retain/pin that original TEST input and replace the original single nav selector with the existing Local models selector. |

The five existing native/qualification environment lines for DISPLAY, XAUTHORITY and COREPACK_HOME remain exactly their own variant; they are not copied into the parent or dropped from children. Ordinary desktop-backend fixture branches, legacy coexistence, non-source-selection V2 flows, production UI/Main/Host code, model server, caller and workflows remain unchanged. No new path, public option, test suite, job or matrix is introduced. Both V1 and V2 explicit source-selection invocations use the same corrected setup, but the original artifact only proves a V1 failure; V2 acceptance remains an actual next-run obligation.

### 83.4. Restore the genuine project input before first ownership

In the already explicit `nativeOpenCodeSourceSelection` branch, after constructing and validating the original native member recipe, derive a small canonical project document from that recipe. It has the same provider ID `test-local`, OpenAI-compatible npm adapter, original `${model.url}/host/v1` baseURL, original TEST-only key and sole `TEST-model` declaration. V1 values come from its actual captured inline provider; V2 values come from its actual captured embedded providerConfiguration, with the existing `aisdk:@ai-sdk/openai-compatible` package mapped to the same established Main config npm spelling. Validate those exact finite identities before writing. Do not infer an endpoint from a changed current/default source or create another model/credential.

Write the provider/model subset to the fresh canonical `root/workspace/opencode.json` before the runtime profile/descriptor is published or the first Main/Host/engine owner starts. Use exclusive creation and mode0600; an existing file or incompatible declaration fails setup. Require the workspace/path to remain the original canonical location. Read back the bounded created bytes and compare them with the intended document. This is fixture preparation of an existing user-facing config input, not a runtime write to an active closure. The native inline/embedded recipe, its complete limits/permission/agent/model declarations and the original endpoint/metadata split remain byte-equivalent. The TEST projection does not alter the native classification or synthesize a catalog entry.

The journey retains this original input's canonical path/hash in the existing immutable-input evidence before first app start, checks it with the existing JSON helper at64KiB and file helpers, and reuses the existing immutable-pin checks before cold startup and after the original phases. There is one additional original config pin per existing namespace, at most two overall. Add only that finite project-input pin to the receipt; do not copy the key/config body into an added diagnostic log. A project-config drift remains a failure. No extra management action, model request, process allocation, fixture environment injection or publication is permitted to establish this input.

The precondition is deliberately project-scoped. It does not change Main's original global environment, suppress its existing global-config warnings, or convert an incomplete global lookup into authoritative success. The old project-provider path already supplies the matching entry independently; later readiness/currentness/whole-origin and source guards keep their own authority. The project file is stable across A→B installation, original A continuation, original Stop and cold history. It never authorizes an experimental local-model override or counts as completed native readiness.

### 83.5. Select the existing control and retain every business oracle

In the original `create()` helper, replace only the existing provider navigation selector with `team-model-selector-provider-nav-local-models`, and label the two existing UI-control calls accurately. Use the same original `scrollTo` and one `click`, with their existing geometry/hit/ownership checks and deadlines. The actual tab handler sets the OpenCode provider through the original callback and filters by the real local inventory just prepared. Do not call a React handler, set store/DOM state, invent `nav-test-local`, clear filters by an extra click, or fall back to another provider/model.

Keep the original exact TEST-model option selector, physical model click, custom-project selection, optional settings, four initial/continuation markers, original native request model/endpoint rules and32-request ceiling. Keep exact saved model `test-local/TEST-model`, `allowExperimentalLocalModels` absent/false, original source grants and receipts, A retained after B installation, original A continuation, explicit original Stop, B's next launch, metadata/member lineage census, whole cleanup, cold no-input/history and unchanged source-index assertions. No pending/unknown state becomes PASS and no wait/retry/scroll budget grows. The file's current787 physical lines must stay within its existing800-line cap without raising a baseline or compressing unrelated source.

### 83.6. Review and acceptance

Before source GO: root and independent peer read this exact appendix and the old/current consumer chain. Before source publication: review both full variant diffs, prove all bytes outside the declared opt-in preparation and original nav/input-pin changes remain unchanged, and verify the five native/qualification environment lines remain intact. Existing non-source-selection branches must receive no new filesystem write.

Use the existing script type check and source-size/diff guards in the assigned serialized verification slot; no new unit suite or native diagnostic run is requested. Final acceptance requires the unchanged existing Linux retained Desktop lane at the actual candidate head: original coexistence plus both explicit V1 and V2 source-selection invocations, their original receipts and all downstream gates. A source review or synthetic config check cannot qualify the installation, native runtime, source transition, model execution, cold history or cleanup. Preserve the original0543 failure and classify any next actual failure separately before changing anything else.

## 84. Complete the existing Linux qualification inputs

### 84.1. Actual failures and unchanged acceptance

At live native head `dfd0089e038669b3c662df18cf20841e365bbeac`, Sentry run `43548417919` passed the Windows x64 and ARM64 native jobs. Linux ABI job `132305022500` failed in the existing `proveIsolatedChild` assertion because its caller supplied neither `LEGACY_LINUX_CHILD_EXEC_MANIFEST` nor `LEGACY_LINUX_CHILD_EXEC_SHA256`; immutable full log is `67cb7ddf6ebe91d120b411b4a83539acfbaca95e`. Linux pidfs job `132305022667` passed native/SDK/cold-UI phases and failed before packed cold UI at the terminal resource tree comparison; full log is `7c233d3a23d2bab747c30903056d935ca3cbbd93`. Artifact `14097391897` is 30,706,845 bytes with SHA256 `3350901a0d88595c499200daefe7fbf0859464cb6310da578ead9eeb2df891a1`; its packed receipt retains sourceFreeze PASS and the unequal source/packed digests. Neither Linux gate is qualified.

The locked builder's actual `builder-util@26.16.0/out/fs.js` (SHA256 `69c433388691bb4dde009f5d50f9650aeaa600ce4d8340c971ac3de98d6afa51`) unconditionally omits names `.gitkeep` and `.DS_Store` while copying. The committed terminal source directory retains exactly the root `.gitkeep` placeholder (Git blob `8b137891791fe96927ad78e64b0aad7bded08bdc`, one newline, SHA256 `01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b`). This establishes an invalid comparison between the source staging tree and shipping payload. The available artifact does not contain both terminal file trees, so it does not establish that this is the only difference. The next exact-head native run must still prove equality of every shipping path and byte; any other discrepancy remains a failure.

### 84.2. Exact scope and minimal changes

Only these two existing TEST actors in the native child change. Parent and qualification branches do not contain them. Production code, the native helper/builder, dependency pins, workflow/job matrix, native case set, model/business inputs, process ownership, observation oracles and all deadlines remain unchanged. No new file or unit suite is required.

| Existing path | Exact preimage | Change |
| --- | --- | --- |
| `packages/legacy-agent-host/scripts/qualifyLinuxProcessAbiHost.ts` | `29feeb37ef17e61a5057c3d94b61200dbb2ca425` | Stage the same original checked static helper once and pass its exact manifest to the existing older-kernel journey. |
| `scripts/legacy-agent-host/qualify-linux-process-packed.ts` | `8da6c933a126c17fff08dfdb7a758d26b8932331` | Compare the complete packed terminal payload with the source payload after excluding only the exact tracked root placeholder; retain the complete original source-tree freeze. |

The source basis is native working head `e59abd934a30a499e70b1d6426d67d91fd1e95da`. This appendix extends exact P09 `03b1a1814e42cbd661fb9feb1b459a5a246640c1`.

### 84.3. ABI caller supplies the existing helper

Reuse `buildLinuxChildExecArtifact` from the already captured `buildLinuxProcessNativeArtifact.ts` (`e81aca726f321a77fded1f0d051ba7e1da5aefaf`), exactly as the existing `qualifyLinuxProcessNative.ts` caller does. Use the original host compiler plus real inspector, source hashes and a new private child directory beneath this same TEST output. This helper is static and separate from the unchanged NAPI artifact built/loaded in actual glibc2.28; do not relabel a host-built NAPI module as ABI evidence.

Pass the exact returned manifest path/hash only to this existing native invocation through a narrow optional environment argument on its existing `run` function. Preserve the original 45-second journey and overall job timeout. Recheck the helper manifest/binary hashes after the journey and require its already emitted `isolated-same-child-launch` fact to name that binary, retain the parent descriptor and complete cleanup. Retain the helper selection in the same host receipt. No extra native journey, process fallback, capability override or changed older-kernel oracle is introduced.

### 84.4. Strict packed payload equality

Keep the original complete source terminal tree in `frozenInputs.trees` and every before/after `verify()` check. Before building, compute one additional expected shipping digest with the same sorted relative-path + NUL + exact bytes + NUL algorithm as the existing `treeHash`. Its only exception is the root-relative `.gitkeep`, whose exact contents must first equal the committed one newline. Do not omit arbitrary hidden files, other placeholders, metadata, executable files, nested paths or `.DS_Store`; any additional builder exclusion still makes equality fail.

Compare the full packed terminal `treeHash` against that expected shipping digest and retain both expected shipping digest and original complete source digest in the receipt. Retain full packed-tree freezing after comparison and all existing managed Git, asar, native selection, packed-capture, cold UI, original Stop/history and cleanup assertions. Do not copy extra files into the builder result, modify source staging after capture, trust a new mutable default, replace a package or relax a runtime hash. The source and shipping scopes are explicit and independently frozen.

### 84.5. Review and proof

Root and an independent peer review this exact plan before source. Review both full source deltas and verify that all original invocation counts, native assertions, timeouts and downstream packed cold UI calls remain. Root runs the existing script typecheck, source-size and diff guards in the serial slot. The actual unchanged ABI and packed Linux jobs on the next ordinary reviewed head are mandatory; local checks cannot qualify glibc2.28, the actual older kernel, packed Electron or its cold UI. Preserve these failed run receipts and classify any next failure separately.


## P09 §85 — Match the existing Linux native coordination receipt

The completed Linux x64 job 132305011089 of run 43548414066 (source 5ca255671764862da273b65b8df18262cfdc0f82; immutable log bf18efa08e40bbd6c1fa7b81ca935387ffca6c74) passed the original embedded Host journey and failed only the final exact receipt-step comparison. The actual seven-step receipt includes the already required `original_native_coordination_and_cleanup_before_business_host` before the six existing business/history steps. The workflow still expects six on every tuple. The original fixture selects coordination only when unpackaged Linux x64; Darwin and Windows retain the six-step contract.

Scope is one existing TEST workflow: `.github/workflows/opencode-v2-stage1-preflight.yml`, exact parent/native/qualification preimage `5aadbfad98c35764394ea525bed802bee35a3da1`. In the existing final product-path proof step, require the coordination prefix exactly on Linux x64 and retain the existing deep equality for the full ordered sequence. Require that tuple's existing coordination receipt to report PASS and cleanup true. Keep the other tuples' original sequence unchanged. Do not filter receipt steps, accept a subset, loosen PASS/cleanup, alter modelRequests=11, change a model/tool count, add or rerun a job, modify a native fixture, raise a time limit, or change an input/artifact pin.

Review this exact failure mapping and one-path change independently before editing. Validate the changed embedded Node assertion against the original downloaded Linux receipt and the existing Windows/Darwin sequence forms; changed/missing coordination, missing/reordered business steps and an unexpected prefix on another tuple must reject. This is a finite check of the existing assertion, not a new native scenario or permanent unit suite. The next naturally required run remains the native workflow acceptance. No main merge or production source change is included.


### §85a — Preserve the native qualification workflow variant

The publication preimage guard confirmed that parent/qualification use `5aadbfad98c35764394ea525bed802bee35a3da1`, while native qualification uses `3be140eacf0d35e532b275695fd3ed145a264a67`. The native-only difference is its existing POSIX executable observation step and artifact path. Apply the same reviewed five-line receipt assertion delta to that native preimage and preserve every byte of its POSIX step/artifact. This corrects the §85 preimage enumeration, not its one-path scope or behavior. Parent source `a1b015556b2da3c8b6dfeb325f2a320251921a9f` was published before the guarded child preimage mismatch; the child was not modified by that rejected publication step.

## 86. Preserve Linux allocated-child cleanup while correcting the existing promise lint error

**Plan before source.** Native PR1188 exact head `dfd0089e038669b3c662df18cf20841e365bbeac`, ordinary CI43548417857, lint-main job132314428200 failed only one error: `src/main/utils/linuxChildLaunch.ts:198`, `sonarjs/no-try-promise`. Original log blob `3d0d7590089e2c20a66fd9776b2acd6cbf1425da` retains the complete diagnostics. Validate job132314428316 separately failed the already repaired §3e test type mismatch; this amendment does not relabel either run as green.

One production path, common preimage `5a92d868e4f0d8a7d52f8e5d254e0c79c2234131`: in the existing allocated-failure callback, replace the split synchronous try / later promise.catch with an immediately invoked async closure that calls and awaits that same `onAllocatedFailure(child, error)` inside one try/catch. The closure runs the callback synchronously up to its first await, retaining the original tree owner's immediate cleanup request before any immediate-child signal. Both a synchronous throw and an asynchronous rejection invoke the existing kill function. Fulfilment does not signal. The original callback still settles only on the same child's genuine close; all stdio, failure ownership, deadline and timer behavior remains unchanged.

No new cleanup owner, delayed timer, retry, launch, fake close, PID adoption, protocol, exception suppression or lint-rule exemption. The same already required process/launch checks plus focused lint and source-size/diff checks validate the correction. Extend an existing cleanup case only if its current assertions cannot distinguish invocation order and rejected cleanup; do not add a redundant unit-test suite. Preserve all actual native and packaged gates. Root and an independent peer review this exact finite change before source qualification and immediate working-branch commit/push; no main merge.

## 87. Preserve one physical desktop action across Composer blur and an existing Task detail refresh

### 87.1. Original evidence, source match, and qualification boundary

This appendix addresses two separate ordinary desktop acceptance failures. The first is a layout change during one physical press. The second is a button becoming disabled while its existing Task detail read is pending. Neither permits replaying the physical click, inserting a delay, weakening the final business assertion, changing a native budget, or turning a saved diagnostic into a successful native run. P03's existing command identity, native reply and Show more proof remain the command acceptance contract. P09 §70 supplies the already captured Taskboard press facts; this appendix adds no collector.

Artifact `14094802645`, original `TEST-desktop-backend-SU9YZc/desktop-backend-receipt.json`, is719875 bytes/SHA256 `36ab85816d8672421a2daf08c759296543c2557e85d3c1086ff34613817ff91d`. It fails `original native cost body expanded; no mutation retry`. The existing trusted input trace records pointerdown33814 on the Show more BUTTON, textarea focusout33816, button focusin33823, then pointerup33826 at the same coordinates on a paragraph. The eventual click targets a DIV. These are the original Renderer `timeMs` observations, not a conversion to the harness's separate monotonic clock. The source chain below explains a focus-driven footer collapse capable of moving the target during that press. No second command or second expansion click is authorized.

Artifact `14096056835`, original `TEST-desktop-backend-ZEzlY3/desktop-backend-receipt.json`, is800625 bytes/SHA256 `dbd29597e59ae4dd4951eb123e45a40fc5a8ca6dcfd9076fb29ffd13c04a49b8`. It fails `clarification banner cleared; no mutation retry`. At pointerdown39447 and the same physical pointerup/click, the point is inside the connected Mark resolved control, but hits its banner parent: `controlDisabled:true`, `pointerEvents:none`, `renderedOwner:false`, `detailPhase:ready`, `detailLoading:true`, `detailRefreshPending:false`, and `deletionIntentPresent:false`. The captured surface, owner revision, context and selected Team comparisons are true. The canonical clarification remains `user`; incomplete receipt scanning remains unknown. These facts establish a disabled-control interaction, not an absent Host clear operation or a proven particular invalidation sender. The original trace does not expose every term of the `isOwner` expression; do not label loading itself as its source predicate.

Both original receipts' enumerated source SHA256 values match the current bytes for MessageComposer, useComposerTextarea, useTaskDetailSession, teamTaskDetailSlice, taskDetailReadAuthority, teamSlice, createHostTeamChanges, the original session domain, the existing UI controls and both acceptance callers. The independently saved comparison is `state/account-s87/evidence-source-comparison.json`. Other exact source locators below were read from the current canonical source; their absence from an old receipt's finite source roster is not an old artifact proof. No compilation, runtime or next ordinary acceptance is claimed by this plan.

### 87.2. Exact existing source inventory

Only the following eight existing paths are writable after the plan is published and both independent review rounds finish. Production4, existing TEST/support4; no new source file, public Host operation, DTO/schema, controller, registry, queue, persistent intent, dependency or process is introduced. Root verifies these preimages against each working branch before composition and preserves any unrelated branch variant.

| Path | Exact preimage | Bounded change |
| --- | --- | --- |
| `src/renderer/components/team/messages/MessageComposer.tsx` | `7f67cddae1c05530dead896d22682823ded7e27b` | Pass the existing noncompact footer class override through the existing input. |
| `src/renderer/components/team/messages/MessageComposer.pendingSend.test.tsx` | `102afa6618d1cacac6c4612cdc622d007d762a9f` | Extend existing focus/layout cases using the already available real-editor harness. |
| `src/features/team-task-detail/renderer/hooks/useTaskDetailSession.ts` | `5180e47a337cbb4a917aec80156ab5c1883a789a` | One finite, ephemeral clarification-resolution continuation within the original mounted session lifecycle. |
| `src/features/team-task-detail/renderer/hooks/useTaskDetailPresentation.ts` | `6d5a37b2aab32e7e20dec0bf9e8cf2a27f475333` | Route its existing Mark resolved action through that same session method. |
| `src/features/team-task-detail/renderer/ui/TaskDetailHeader.tsx` | `bae3d01fadaabcaed70d63de1bd6da9fe909c3d9` | Only this button uses the finite clarification-action availability; all other controls keep their original ownership gates. |
| `test/renderer/components/team/dialogs/taskDetailSessionFixture.ts` | `ade923c40ebcdceab66c175a5b0371a73b35f6e2` | Add the corresponding exact controller test members; no general permissive fallback. |
| `test/features/team-task-detail/renderer/taskDetailSession.integration.test.tsx` | `b9f3f23f1cf450b50447ded2911480fddbfcad6c` | Extend existing original refresh/deletion/retirement cases with the real session and read lifecycle. |
| `scripts/legacy-agent-host/desktop-proof-integrated-sources.ts` | `6f3dad8e7f0bc576754260563b52d0fe77b2b28a` | Add only the two changed Presentation/Header source paths to the existing source roster. |

MessageComposer is1170 physical lines and stays under its original1175 cap. Session610, Presentation347, Header465 and roster592 stay below800 after their narrow deltas. The already oversized generic MentionableTextarea1431 and index.css1950 are read-only. Existing tests keep their names and suites; the policy/baseline is not edited. New size pressure requires simplifying this exact cut, not creating unplanned helpers or increasing a cap.

### 87.3. Composer: retain the original noncompact footer footprint, clear its content immediately

The exact focus hook `useComposerTextarea.ts` `dd4160c9c90429e005682ba2c66a265aa8fca6a4` immediately clears `isComposerFocused` when focus leaves the Composer DOM, including a React portal. MessageComposer uses this boolean for `showHint` and textarea focus for Saved. It supplies `footerRight` as an existing Fragment even when its children are absent. `MessageComposerInput.tsx` `d88b511e00c1dbf58ed5da97285dd2b2db2b31d3` already forwards the existing textarea props to `ComposerTextarea`; `ComposerSurface.tsx` `9e1cf3a76ef6a442c212ed806837e8f728e9e5f4` already adds `message-composer-flat-footer` and forwards `footerClassName`. `MentionableTextarea.tsx` `d35f05006fed50a3e4e4694e8289e5062451fb8d` keeps the wrapper for that Fragment but combines `empty:hidden` with the caller's footer class. The original stylesheet `d7b10afad64e97233287a33040fd9826680856a3` gives that footer a28px minimum height and its existing spacing. The empty selector removes the footprint despite that minimum. This collapse is synchronous with the ordinary outside blur.

Add only `footerClassName={!isCompactLayout ? 'empty:flex' : undefined}` at the existing MessageComposerInput call. The existing `cn` implementation `edac9f2d5c71d414a8a30e6c1050bac4ca6f7ffe` uses `twMerge`, so the same-variant display override replaces `empty:hidden` on this noncompact footer. The original CSS height/spacing stays; no new size measurement, observer, pointer listener, timer or focus policy is needed. The compact path retains the current empty-hidden behavior. Other MentionableTextarea/ComposerTextarea users do not acquire the override. Hint text and Saved still disappear immediately when the existing focus predicates say so. Internal toolbar focus still preserves the hint; portal/outside focus still clears it. No `preventDefault`, DOM `.click()`, pointer capture or deferred blur is introduced.

Extend the existing `keeps the hint footer while focus moves to Composer controls and clears it outside` case and its existing neighboring layout/toolbar case as needed, without adding cases. Use the same file's real-editor switch to inspect the actual MentionableTextarea footer where the override is merged. Verify the same footer element remains, `empty:hidden` is absent only on the noncompact instance, and the existing noncompact display override survives the outside-blur boundary while the actual hint/Saved children are immediately absent. Preserve the existing toolbar one-call count and portal/outside focus assertions, and check compact retains the original class. Unit DOM assertions qualify the layout contract and focus behavior; only the existing ordinary Electron physical Show more gate qualifies actual pointer geometry.

### 87.4. Taskboard: retain all original authority and refresh rules

`useTaskDetailSession.ts` computes `isOwner` from active context, switching, accepted live Team metadata, ready phase, deletion intent, full task identity/deletion state, and original surface ownership. It does not use loading as an ownership grant. Its `requireOwner`, exposed as `canEditNow`, rereads current store state and verifies the captured context/Team epochs and owner revision. These predicates and every existing caller remain unchanged.

`teamTaskDetailSlice.ts` `5d5da9534eeacf34d554b2df2ed5573876c3a09c` starts an existing full read by setting loading=true/refreshPending=false before its original metadata await. It accepts a fresh Team snapshot, starts/joins the existing full-task resource, and commits only its original current token. Task invalidation marks refreshPending; Team clearing marks unavailable and retires session work. `taskDetailReadAuthority.ts` `f0543a009984bbfef7f00acd9e729c9f57aef755` currently retires accepted Team metadata on invalidation. `teamSlice.ts` `18c1b1e647ea733a51e58892f35daa931040e206` also performs that invalidation after accepted task mutations. Its original clarification mutation and its own scope checks, refresh and fetchAllTasks remain unchanged.

The ordinary Host hint adapter `createHostTeamChanges.ts` `35489f548d404ea46fdae237df3f41347c1f14cc` projects a fresh generic invalidation as legacy config+inbox hints. Its feed does not prove that only a task changed. Therefore this plan does not retain accepted Team metadata across unknown config hints, exempt a task refresh from the original authority checks, relax isOwner/canEditNow, or borrow a compact task snapshot as full authority. The existing read coordinator `78aa195ac48348566a055ee5c337a5d0236ae336` remains the only owner of ordinary detail-read demand. The core read model `0a1ede79d40bc05af35b67fcf27ed7594d71abb2` and token/scope contract `22b98633fe8d2ce3e097e5a322bfe9adc801ac67` remain unchanged.

The original session domain `4899240d8b664c3d66fb2aadfce9f20adc630b80` already contains typed comment submission and subject/description save state. Those represent different business operations, so this cut neither reuses their nonce/receipt as a clarification request nor adds a new domain state kind. It uses one local continuation cell and the existing mounted session's cleanup. This cell has no command ID, persistence, RPC or business authority before the existing read has settled successfully.

### 87.5. Exact finite clarification continuation

Add only a clarification-specific action and its availability to the existing TaskDetailSessionController. The Presentation action delegates to it; the Header changes only the Mark resolved button to use that availability. A waiting clarification intent disables this same action, so repeated clicks while it is pending cannot add work. All other Task controls still use the original ownership gates. The button may remain interactive across the particular owner-to-refresh transition because accepting this user intent does not dispatch a mutation.

For an immediate action, require the original current owner, the same full ready task and non-null clarification, and no pending/loading detail refresh; then run the existing `setTaskNeedsClarification(teamName, taskId, null)` once. For a deferred action, capture synchronously from the existing session/store before subscribing: full context/Team/task identity, original context and Team epoch scope, enabled/active origin, surface ID and owner revision, current clarification value, and current full-read token fields. Require ready full data for that exact task, no task deletion or deletion intent/error, matching live session owner/revision, a full token for the same original scope, loading=true, and refreshPending=false. This admits only an already-started refresh of a previously ready task. It never treats initial hydration, a future queued refresh, a compact preview, missing metadata, an unknown owner or an old retained task as permission to mutate. If these facts are absent, accept no continuation and perform no effect.

Observe this already-running read through the existing synchronous store subscription. Do not call ensureTaskDetail, refreshTeamData, getTask, a coordinator, any native action, or any timer from this action. Install the listener and immediately recheck its captured facts, so no settlement between admission and subscription can be missed. The local cell may bind at most one original successor full token when the existing metadata stage advances into its full-task stage. Compare complete original token fields (resource/key/sourceEpoch/serial/physicalStartOrder/scope), not object identity: read start stores the original token's value copy, while successful commit stores the result token. A further different read token is a different read episode and cancels this intent. No new token, serial, cutoff or source epoch is minted here.

Cancel and unsubscribe immediately on any new refreshPending invalidation, context/Team epoch change, context switch, surface/owner revision change, task identity change, task/Team unavailability or deletion, non-ready phase/error, clarification value change, hidden/disabled originating surface, or original session unmount. The listener must inspect each synchronous store transition; a later ready state cannot revive a cancelled intent. A rejected or superseded read is not retried and cannot borrow the next read's success. Cleanup follows the same session identity/surface lifecycle as its existing ownership cleanup, including React effect cleanup/replay. No stale callback may outlive a handoff or mutate a new task shown by the same component.

There is one precise exception to the intermediate cancellation list: while the captured original refresh is still loading, absent accepted Team metadata is the reason to continue waiting, never a grant. Explicit deleted Team state, a failed read's unavailable/error phase, identity/epoch invalidation and the other cancellation conditions still cancel immediately. A generic config hint received after the intent is captured produces refreshPending and cancels it. Do not wait through that hint by retaining an earlier accepted metadata witness.

Proceed only after that same read finishes loading=false and refreshPending=false with a non-null original full token that passes the existing `isTaskDetailTokenCurrent` check under the captured scope. Require full ready data for the exact task, unchanged clarification, no error/deletion, unchanged context/Team epochs and same original owner/surface revision. Invoke the original `canEditNow`/requireOwner immediately before the mutation, with no await or fresh selection between that check and the existing call. Clear/unsubscribe the local continuation before dispatch to prevent reentrant store updates or another notification from dispatching twice. The resulting Host operation remains the original operation with its original payload and own custody/currentness checks. This plan adds no replay after a failed/unknown mutation and no synthetic receipt. Later store changes from the one dispatched mutation follow the original flow.

The React state needed to render this action's pending availability belongs to the existing local session UI state; it is not added to TaskDetailSession's durable/domain shape. Its cleanup is specific to this one action, not a general await-until-editable framework. Preserve original comment/save/file/route behaviors bytewise outside the local clarification join. If implementation cannot prove the stated same-read and lifecycle cancellation using these existing facts, stop that source subset for a precise plan correction; do not substitute loading-only success or start another read.

### 87.6. Existing critical tests and unchanged ordinary acceptance

Use the real useTaskDetailSession and original store/read coordinator in the existing session integration file. Extend the existing `refreshes same-ID tasks across teams once per identity from root interest` case with a controlled original metadata/full-read settlement, retaining its original two-Team read counts and every original assertion. A ready task with clarification enters that original refresh; the same owner can submit one clarification intent while original canEditNow is false, zero mutations occur before successful full-read completion, and the one exact original mutation occurs afterward. Calling the action again while pending cannot add work. The other Team remains independent. The controller test may observe the existing mutation port without claiming Host/native execution; it must not replace the original session ownership or full-read acceptance checks with a truthy stub.

Extend the existing deletion/retirement cases with bounded, fresh subscopes for the newly introduced pending action: deletion accepted before refresh completion, owner transfer/revision or context/Team epoch change, new invalidation/successor read, read failure/unavailable, changed clarification, and actual unmount. Each retains the original late completion and proves zero clarification mutations after cancellation, including a later ready state. Preserve the original comment/draft/save effects and their counts. The existing typed fixture gets only the finite controller members needed by its original consumers. No new test suite, arbitrary delay, fake native success or weakened permission assertion is authorized. Tests of an unavailable/missing owner remain refusal tests rather than waiting for some future owner.

Add only useTaskDetailPresentation and TaskDetailHeader to the existing integrated source array beside its current Task detail entries; Composer and Session are already enumerated. Preserve every existing entry, collector, hash algorithm, source cap, comparison, physical action, journal/input proof, acceptance budget and cleanup. `desktop-ui-controls.ts` `15703898ff4639a442745f93c6083688b1c04ff4`, `desktop-native-commands-ui-proof.ts` `0384efbca6aeaa66850a636b03176c0a9f939cad`, and `desktop-task-board-ui-smoke.ts` `9dd028e52aca670f1b7059286b8110c3cdb47430` are read-only. Their one physical click and passive waits remain exactly the ordinary gate; no DOM click, second mutation, hit-target fallback, hover replay, enlarged timeout or automatic retry is added.

### 87.7. Review and delivery order

Before source, perform two independent review rounds: first critique the concrete focus/layout and same-read/owner-lifetime design against the original sources; then review the frozen revised appendix, exact eight-path inventory, full-prefix composition and critical negatives. Root reads the same frozen text, publishes the plan immediately with readback, and gives source GO only after those reviews. Round1 concerns must be resolved explicitly rather than carried as an optional implementation debt. Source0 until that gate; the Composer subset can be authorized separately if Taskboard's continuation still needs correction.

Implement in isolated staging only. Freeze complete before/after hashes and inverse diffs, request independent source peers for both cuts, and give Root the final manifest. Root owns serial focused existing tests, canonical relevant types/lint/source-size checks and normal desktop/native qualification. No alternate live PR, special diagnostic workflow, extra model invocation or old-run replay is introduced. Successful unit/type checks will qualify only their stated scope. The original /cost and Taskboard failures remain actual failed evidence until a new ordinary current-head run completes their original one-action business and cleanup assertions.


## 88. Carry the existing 8192 MiB source-build allowance into the original controlled Darwin cold-UI TEST environment

### 88.1 Actual terminal failure and original evidence

The ordinary parent Main run `43570716992`, job `132374282713`, at PR head `ea16834de1c133fcd2756965977064a97e82afba` completes the original process/packed qualification and its three controlled process tests, then fails the separate source Desktop cold-UI proof. The job's merge-checkout identity is `3bf9e4b39238bb154a7c6acf4d6c6f91b48a03be`; retain that distinction from the PR head. Full original job log: `c7b3254c1ea220283f84aab0906e0bbea2222132`.

The original small proof artifact `14103703086` was downloaded through the official connector's artifact file reference. Its exact size is 1,434,415 bytes and ZIP SHA256 is `e2f4adb2196ff49b07f7485855c434ccda0994ce9cadd267c9948d106543db2a`. The archive contains 144 members. Only the necessary existing logs/receipts were extracted; the separate 3.16 GB artifact, a native rerun and a new diagnostic collector were not needed. The closed evidence record is `873e7f4b31d78d22b2859f56fc1f81f6a601bd81`.

| Original member in `TEST-desktop-backend-VqVMxZ` or its original parent directory | Retained evidence |
| --- | --- |
| `desktop-app.log` | Blob `e104aaab59beeea6488717c26a0c3c8e5f5c4582`; original SHA256 `9b13ba129b9afd1a4061c9689a92a5608c2e7b6857307704aa69c0d6c3139f7e`. |
| `desktop-backend-receipt.json` | Original SHA256 `e14dbbc8d94a6fd108c5e040e30894ffe78a603e55c9c6d4a2c23bf9378d65b1`; exact extracted bytes and closed projection retained. |
| `cold-ui.log` | Blob `2de0d504d985c756c338e05af0a06080d6291e8a`; original SHA256 `964b675de1c535fc8b7c256191b038e226d59880fc13bf9ca2b697bcc6418b31`. |
| `cold-ui-runner-oracle.json` | Blob `e6d1756fb56f0ea4b272212ff5a2025dc09c8f17`; original SHA256 `2eed36e64fac0aad2755a2b0ecf10e8a7360a69487eebce2bbb4d921978cd202`. |

The pinned Node v24.21.0 dev process transforms 3963 modules and reaches SSR “rendering chunks”. Its final GC rows report about 2034–2050 MiB used before `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`; `electron-vite dev` then terminates with SIGABRT. The existing capture assertion reports `captured app exited during startup` at `desktop-captured-app.ts:116`; this is not a startup deadline expiry. The receipt has `status: INCOMPLETE`, `appExitCode: 1`, no occupied CDP listener and no Main-owned captured Host B. The original controlled native root/services and standalone Host A had already been allocated; their original cleanup observes all three native identities absent and Host A closed. Do not turn that cleanup result into a successful Host B/Processes UI Stop proof.

The job log identifies a Namespace `6x14` macOS ARM runner and profile `namespace-profile-macos-15`; it does not measure free RAM at the failing allocation. This plan makes no capacity guarantee from the label and does not add a resource collector.

### 88.2 Exact source chain and existing allowance

The existing package build at `package.json` `7afadd43590e265d6691b47f0c4b3cda02f4e3a9` and the same job's pre-freeze build at `.github/workflows/ci.yml` `b992f42311f62005ee24d51df71a2e83a4268a1f` already invoke `node --max-old-space-size=8192 ...electron-vite.js build`. That original build passes before the P7 freeze. The separate later cold-UI source startup invokes the same selected Node and pinned pnpm entry through the unchanged `dev:mcp` route and performs a dev build.

The original `qualify-process-cold-ui.ts` constructs a closed child environment without `NODE_OPTIONS`. Its original fixture later constructs a second closed `desktopBackendEnvironment`, also without that field. Therefore setting an outer workflow variable alone does not reach the dev process. `desktop-backend-smoke.ts` `54ea6231bbf80210923bf0028760cf9103c33ba9` passes that fixture environment to its unchanged captured spawn. `scripts/dev-with-runtime.mjs` `9cc8140d2a88207312580450aa9db0c8abc63b0a` copies its own environment into `uiEnv`, calls the existing `ensureMinimumNodeOldSpaceEnv`, then uses the same environment for `pnpm exec electron-vite dev`. The unchanged helper `scripts/lib/node-options.mjs` `423d10be677fa86cc12a56cf433a378e4a0639e5` leaves an absent value absent and preserves an explicit 8192 value; its default minimum of 2048 does not create a flag when none was supplied.

The original before-app source freeze exactly matches the current qualifier, source-environment helper, smoke actor and dev launcher bytes. Both changed TEST source paths are already explicitly listed. The unchanged `node-options.mjs` dependency is not currently listed; add its one explicit source pin below because its preservation of the fixed value is part of this proof. Do not claim implicit import traversal.

### 88.3 Three existing writable paths, original variants

| Existing path | Exact preimage | Bounded change |
| --- | --- | --- |
| `scripts/legacy-agent-host/qualify-process-cold-ui.ts` | Common `0c8acfd8afdba093ef90ef2010cf41babcf865f5` | Add literal `NODE_OPTIONS: '--max-old-space-size=8192'` in the original closed child environment. The existing Darwin/arm64/Node/GO and original-P7 checks remain first. |
| `scripts/legacy-agent-host/desktop-runtime-source-fixture.ts` | Parent `f423eabcb069dfb918f39a1789900f050e314c9d`; native and qualification `a450545f823491093faac6df1bb1a80420b08619` | At original environment construction, add that same literal only for the exact positive Darwin/arm64 + `LEGACY_PROCESS_COLD_UI_GO === '1'` + `LEGACY_DESKTOP_PROOF_MODE === 'process-cold-ui'` conjunction. Preserve each variant's entire existing delta. |
| `scripts/legacy-agent-host/desktop-proof-supplementary-sources.ts` | Common `c117bf12e003234f0415bc594bec13caf37a6ea7` | Add exactly the existing `scripts/lib/node-options.mjs` path. Keep all prior entries/order, the hook and live-driver/source pins. |

Use the fixed literal at both closed environment boundaries. Do not read, concatenate, normalize or forward arbitrary parent `NODE_OPTIONS`; the existing production dev/helper code remains unchanged. Construct this value before the original fixture/capture/start path. Do not mutate an already captured environment, rebuild a selection after a failure, retry the startup or change the pinned Node/pnpm executable, argv, cwd, original process-group owner, source selection or cleanup order.

The positive tuple restriction is deliberate: the native Linux qualifier `qualify-linux-process-cold-ui.ts` `7d794bda2c08141b63e11b6c156b1608659a65ce` also uses the same mode/GO flags and must retain its existing environment in this bounded Darwin fix. Other source, packed, mixed, donor and retained modes also remain unchanged. Default branches must produce the same own properties and values, without adding an undefined `NODE_OPTIONS` key.

Disclose the original environment sharing: `desktop-controlled-process-fixture.ts` `8eeba7cf03ccbb5a1df041f595c7084dd0735013` already passes `fixture.appEnvironment` to its controlled TEST root. In this selected Darwin scope that original Node root receives the same fixed heap option; it remains the same finite TEST process with the same script, handles, native registration and cleanup. No provider Runtime or model input is added, and no native custody observation becomes synthetic. Do not describe this as a Vite-only environment that cannot be inherited.

This is the existing 8192 MiB source-build allowance made explicit in the selected TEST launch, not a new general runtime memory policy. Preserve the original 180,000 ms startup window, 45-minute job, 300,000 ms controlled-service TTL, all native/model/HTTP counters, original P7 evidence, refusal behavior and final source/physical-absence assertions. No production path, new source file, workflow/job/step, platform skip, public flag, diagnostic collector, source-size baseline or timeout change is permitted.

### 88.4 Review, source proof and original gate

Publish this appendix before source work. Freeze the three-path/four-distinct-blob candidate and variant manifest. Root and independent peer review exact environment literals, the positive mode/tuple conjunction, original dev Node route, untouched default branches and the one source-pin addition. Verify forward/inverse equality for each own preimage and that only this explicit field is added in the selected environment. Preserve all existing case declarations and assertions; no new suite or a test mirroring the conditional is needed.

Root owns the existing script type/source-size checks and the next authorized ordinary current-tuple process/cold-UI gate. It must complete the original actual Host restart and Processes UI Stop with unchanged identity, custody, source freeze, neighbor independence, final Quit and physical cleanup. The next receipt must bind the revised qualifier/environment bytes and the newly listed unchanged `node-options.mjs` bytes. Source review and the earlier original P7 PASS do not establish that the revised dev build or cold-UI gate succeeds. Do not advance active live heads, dispatch a new diagnostic workflow or rerun the failed native attempt merely to acquire another observation.


## 89. Preserve the packaged cold Processes UI proof without a dev-server module import

### 89.1 Exact original failure and qualification boundary

The original native Sentry run `43570723528`, job `132374303165`, head `6562a78f147f288edf79d652d9661b651c661af0`, completed the source cold UI arm and then failed its separate packaged arm. The source receipt has `status: PASS` and `positiveStop: COMPLETED_ORIGINAL_REF_STOP`. The packaged desktop receipt has `status: INCOMPLETE` and the original error `TypeError: Failed to fetch dynamically imported module: file:///api/index.ts`, at `desktop-native-process-ui.ts:160:5` through the original smoke call at 413. This is a TEST source-server import used under the captured packaged renderer's `file:` URL; the same import occurs in the later post-Stop observation at 366.

Official artifact `14106476241` was downloaded once as file `file_00000000d74c8246b9d99a8c8ea7cf4d`, verified at 33,737,929 bytes and SHA256 `80d5ade9670fa9b0ed6a90f87873d74a6356c79e32c10efe561a1720f3c29d57`. Only eight selected original members were extracted. Closed evidence manifest `084bfab8ceaa7ca7570ef89a6f65ccc072ceebf2` records all member hashes, source/packaged distinction and unchanged original job log `46769dbc0a5ab08886ee10fb66ced0af20e722e2`. Durable original small members include source receipt `900be5aff58151318b91f036ced8dd256b7e6a5b`, packaged receipt `814f927e649d43471098230d8a8829f8970ca0ba`, packaged log `3e0438b6a552c1a80e73439c10f9a6ca2cc5a546`, app log `52f7191ae3fe51f2adb3113ff5ecb9da94f76693`, and controlled-service receipt `5a2f944b7e59939a52723610587ff3cf78467580`. All uploaded bytes were read back exactly.

The packaged app reached the real ProcessesSection original row: original primary PID 6621, the original opaque process reference, `observation: same-live`, and `canTerminate: true`. Standalone Host A PID 6645 had exited 0/null with its writer released; cold Host B PID 6790 was distinct and observed. The failing import preceded `coldOwnerRead`, the original Stop input, its command receipt and the post-Stop observation. Failure cleanup subsequently observed the original root/primary/neighbor absent. It is not a successful packaged Stop, a new native identity/custody failure, the Darwin source-build OOM in §88, or new evidence about POSIX §75. No native rerun was used for this diagnosis.

### 89.2 Existing public read and original owner

`src/renderer/api/index.ts` `1c0623475dd6cf9f9d735d784e4aaf3ab8a9c158` routes Host Team `getData` through `createHostBackendRenderer`, not directly through the legacy preload `teams.getData`. `createHostTeamsApi.ts` `c69c98f1ab47b5a118225fb30fa23e7df3d653f6` selects one connection by the original Host Team selection key, and its `getData` performs one existing public `process.list` for that selected handle, followed by `readBackendProcesses`. It does not merge process inventories from other connections; the final Team view passes this selected owner's complete process array through. Its other snapshot/lifecycle/roster reads are not a substitute for the process inventory.

`createAgentBackendBridge.ts` `c0e58c715cc0095627d74a83f6129786a823c901` already exposes `window.electronAPI.agentBackend.getConnections()` and `.invoke()` in the packaged preload. `contracts/connections.ts` `edd0cba7255617eb894c9d9529b45ffb34523179` and `contracts/processes.ts` `41dd6a8e480b98e85922312fbc4e95089b58f609` retain the ordinary handle/current-owner and strict bounded process contracts. `createHostBackendRenderer.ts` `baddadb15ab013f923036718dc1aec88744a69d2` classifies `process.list` as a read. This TEST change does not change any renderer or Main/Host authority implementation.

The existing `verifyCapturedDesktopBinding` in `desktop-captured-app.ts` `11915e0d9fd425620b8c975901bd4dc65e6b8f27` has already retained `evidence.discovery`, required ready state and exactly one binding for this scope, checked the exact fixture handle, closed binding keys, ownerResourceRef and teamResourceRef, and pinned the actual packaged renderer/app.asar. The new packed read must use that retained original full binding, not select a new latest handle. Preserve its handle, both resource refs, label and all member metadata; absence, duplicates, foreign owner or any changed binding means refusal, not an empty process inventory.

### 89.3 Bounded three-path source scope and variant preimages

Preimages were freshly matched on parent `0737f90229661487590af047348cf67330701bbe`, native `1753d03965daaf51e1bb901f356a3464c7ea122e`, and qualification `8c7bdfaa7c06b46e942c2388617e89eaf5736b8f`. The three writable TEST paths have six distinct blobs:

| Existing path | Exact preimage and variant | Bounded change |
|---|---|---|
| `scripts/legacy-agent-host/desktop-native-process-ui.ts` | Common `b31d14cf1d8327d076aae497d5ed610b5f34ec08`, 380 lines | One finite TEST read helper and optional captured packed-renderer input. Only the two existing process observations select this read; all later predicates/effects remain. |
| `scripts/legacy-agent-host/desktop-native-process-ui.test.ts` | Parent/qualification `f0ca67038da2ba60bff054ae3c122ce3711e74c1`, 21 lines; native `0654b9085d11cd27b29a35e279c565a9119f4e27`, 56 lines | Extend the two original observer cases with the finite bridge/read refusal coverage below; retain every original line/assertion and the native-only third atomic-service-readiness case byte-for-byte. No new case or suite. |
| `scripts/legacy-agent-host/desktop-backend-smoke.ts` | Parent `54ea6231bbf80210923bf0028760cf9103c33ba9` (797 lines); native `adc9a6d2988cc9377f3044794f04bd2769072d73` (800); qualification `447006b5ec8322bd8a0cab24e51e64e40209cf8a` (790) | Forward the already verified `packed.rendererUrl`, only when the existing packed capture is present, in the existing `qualifyColdProcessUi` options object. Preserve each own variant, all existing mode guards and line counts. |

Do not add a path, workflow, public flag, production export, dependency or source-size exception. The UI helper, its test, smoke caller and existing strict process parser are already explicitly listed in the source-freeze rosters; no new roster entry or import traversal is needed. Keep each smoke variant's original 797/800/790 physical-line budget with a normal in-place property addition at the existing call site, without unrelated compression or extraction.

### 89.4 Exact packed observation and unchanged source default

The optional packed renderer input comes only from the original successfully parsed captured candidate. The UI helper admits it only inside the existing controlled Linux x64 cold-process TEST scope and original GO, with the retained original discovery binding and `hostTeamSelectionKey(fixture.handleId)`. It must not infer packaged mode from a failed source import, add a fallback after an exception, or read a different environment/handle after failure. Freeze the retained binding as a private JSON value before the first observation and reuse that exact value after Stop.

Each of the two original `Runtime.evaluate` observations remains one evaluation. In the packed arm it verifies the current renderer URL against the original captured URL (using the already established query/hash normalization), retains the current preload/backend object, reads existing public connections once, and requires ready state with exactly the retained original full binding. It then invokes exactly one `process.list` with that original handle, a fresh ordinary read command ID, and the original empty payload. After the awaited reply, read existing connections once more and require the same full original binding, the same preload/backend object and the same captured renderer URL. A missing, ambiguous, malformed or changed owner, a refused/unknown result, or an unavailable bridge must throw at this original observation. No retry, wait, fallback, new signal, process registration or native input is allowed.

Apply the existing `readBackendProcesses` to the complete successful reply in the TEST caller, including every returned row; do not filter away a neighbor, unrelated row, duplicate or malformed process. Return only that canonical process projection and identify the packed public-read route in the proof. Do not fabricate a full `getData` Team snapshot or claim that the direct packed read exercised the source-only module loader or all of its unrelated Team reads. The actual UI still uses the original product renderer adapter; the independent packed observation reads the same canonical process operation through its supported public bridge.

With no explicit packed input, preserve the original source `import('/api/index.ts')` and `api.teams.getData(selection)` expression and returned data unchanged. No raw legacy `window.electronAPI.teams.getData`, DOM/store write, handler call, private function-name discovery, compiled-bundle scraping, production global export, raw Host transport or alternate Stop route is permitted.

Preserve both original observation positions and every original predicate after them: the one original processRef row, observation/canTerminate equality with real React props; physical visible original-row Stop control; one original termination command/receipt and native request; original owner/history and primary/neighbor lifecycle; exact post-Stop row deep equality, stopped style/indicator and absence of Kill; existing native/Host incarnation, source, bundle, receipt, Quit and physical cleanup checks. Source/POSIX/readback modes, all other smoke arms, startup/deadline/TTL budgets and the existing process/model/native counters stay unchanged. A packed refusal remains INCOMPLETE.

### 89.5 Existing-case coverage, review and original gate

Within the two existing TEST cases, exercise the actual new read helper with a finite `evaluate` stub that evaluates its emitted expression against an owned fake preload and location. Verify a successful complete two-row process array, the exact retained handle and empty payload, one `process.list` and two connection reads for each packed observation, and post-Stop projection without a mutation. Keep the original React-fiber assertions. Verify the unchanged source expression and returned data without invoking a packed bridge.

Keep refusal coverage in those same cases focused on the main boundaries: a foreign or ambiguous original owner before the read must dispatch zero process reads; one owner change after the awaited read must retain exactly the one original process read with no retry; a refused reply stays refused; and one malformed or duplicate process reply demonstrates the existing strict parser. Preserve the successful complete-row and unchanged-source assertions above. All implementation guards still apply, but do not add separate field-by-field permutations of member/label/handle/resource fields or every state/bridge/URL transition handled by the same exact-binding predicate. Preserve the native-only third case and its original timing/atomic-publication assertions exactly. These are controlled TEST assertions, not an OS/native qualification.

Publish this appendix before source work. Freeze all six source blobs and per-variant forward/inverse proofs; root and independent peer review exact route/owner joins, default expression, complete process projection, existing cases and unchanged native variant. Root owns the existing focused test file, script type/source-size checks and publication. The next authorized ordinary native Linux source-and-packed gate must still complete the original captured Host restart, real ProcessesSection Stop and final physical cleanup. The original source PASS and source review cannot establish that the revised packaged gate has passed. No live-head advance, workflow rerun/cancellation, extra collector or new native experiment is authorized by this amendment.

## 90. Repair the twelve original agent-backend lint errors without changing the captured authority contract

### 90.1 Original failure and already-published repairs

This appendix is a finite lint repair, based on the original terminal native workflow `43570723512`, head `6562a78f147f288edf79d652d9661b651c661af0`, actual checkout merge `6713b4e4fe0562bb23872faba807410ae4d0b774`. Its `lint (features)` job `132377335457` finishes with exactly **12 errors and 1430 warnings**. Full immutable log: `ea64d3f027a92e3e9d8c265d6dda46f68aa92150`. Bounded classification, all five original logs, current source maps and preserved native variant differences: evidence `3296e3dc241eedde85b51d9a646f90d637679963`. Log and source bytes were independently read back; no local lint, compiler or test result is inferred from this source review.

The native validate job `132377335396` fails only the existing `capturedDefaults.test.ts:167` readonly-property delete (TS2704), already corrected by R34.1 `d9ae6d299f6c089a6e33f4ecba61dfc57fc3f26f` → `d97412d8d0115e4458d89d5fbc6ea20b2fe851ef`. Its original log is `b1e4834529f03d05a667e8dbc4a223ec722c071b`. The native test shard job `132377335447` passes **424 agent-teams-controller tests in 19 files and 78 mcp-server tests in 4 files**, then stops in Host TEST typechecking on exactly the two `runtime-worktree-capture.test.ts:402/429` TS2379 diagnostics. P11 §16 already corrects that file `2b11a5f7edd046ec9beb1631141ac1147380c262` → `11d964d1d12e71fe275d683289beab9f395407fd`. Its original log is `de4720113e36d6a03daadbcd29932274a389bfdd`. **Host runtime tests did not execute in that job**; the live Stop, TLO seal and Create checks are distinct evidence.

Because the child variants contain different Windows custody code, the two corresponding qualification logs were read once to confirm the boundary. Qualification workflow `43570718937`, head `ce66cd4c0bc9222a93e36cbc8aa039da465a4d01`, actual merge `8819be2a6e59f21c890e63364b3d5d2a557bfa1e`, has the same sole validate TS2704 and two TEST TS2379 errors, with the same 424/78 passing counts before the Host typecheck. Logs: validate `132378965989` → `bfc8add8c7d50d41ec11babd119539d104324a4d`; test `132378966039` → `a7c8e980eef86146de8fb32c1fbfa6a586785a48`. The original failing runs are not post-repair qualification.

### 90.2 Exact eight existing writable paths and variant preimages

The current parent `a390e771aaced8f7eacc0517b6b4b9b9b84dc380`, native `381398813e6c5b725248917cbcae2b5ffdc83a70`, and qualification `dd72da5b5884b784f097615993a90c747659a177` source maps were read directly. All eight lint paths still have their original failed-run bytes within their own variant. The table gives complete preimages; parent and qualification are identical for these paths. These **eight production paths / ten distinct blobs** are the entire source scope. No TEST, manifest, workflow, dependency, generated file, lint configuration, public DTO/schema or new file is writable.

| Existing path | Parent and qualification preimage | Native preimage | Original errors |
| --- | --- | --- | ---: |
| `src/features/agent-backend/contracts/operations.ts` | `90d91180d410494bc7c08a91b1e5de1110991b11` | `90d91180d410494bc7c08a91b1e5de1110991b11` | 1 |
| `src/features/agent-backend/main/adapters/input/teamOperationValues.ts` | `ef26303e94304bb81bb60f071e4d7d24e2db0168` | `ef26303e94304bb81bb60f071e4d7d24e2db0168` | 1 |
| `src/features/agent-backend/main/application/BackendOwnerRouter.ts` | `b4d0a08ac79717a8320b20322403841fb5faf4ec` | `f974ca8178fccdbadbb13445126eeb1a4eae8efe` | 1 |
| `src/features/agent-backend/main/application/captureHostScheduleTarget.ts` | `cda295f61946ac0851016d7d3850666c91ec6ad0` | `cda295f61946ac0851016d7d3850666c91ec6ad0` | 1 |
| `src/features/agent-backend/main/composition/DesktopBackendFeature.ts` | `bd757836d09071b5a000bab33dc1525ed948400a` | `d063974bbbbf0fba439dc20d1167240f9a241f98` | 1 |
| `src/features/agent-backend/main/infrastructure/CapturedLocalModelReadiness.ts` | `4511c5cc787163317fe563e48673880481ae5cb5` | `4511c5cc787163317fe563e48673880481ae5cb5` | 5 |
| `src/features/agent-backend/main/infrastructure/CapturedRosterCommands.ts` | `6968b42f01fc71cd0e38866c7667bf392c237d74` | `6968b42f01fc71cd0e38866c7667bf392c237d74` | 1 |
| `src/features/agent-backend/main/infrastructure/CapturedTeamRegistry.ts` | `860d7a183f099f516c67a8b537708fa82731ee69` | `860d7a183f099f516c67a8b537708fa82731ee69` | 1 |

### 90.3 Exact syntax changes

1. Apply the repository's existing `simple-import-sort/imports` ordering only to the import declarations of the seven reported paths: all table rows except `CapturedRosterCommands.ts`. Preserve every imported symbol, module specifier, alias and type-only designation; do not add imports or fix unrelated warnings. Existing exports and module bodies remain unchanged except for the following separately enumerated local syntax changes.
2. In `CapturedLocalModelReadiness.ts:45`, express the existing private object alias `Definition` as an `interface` with the **same three fields and types**: `owner: BackendOwnerRef`, `contextId: string`, and `scope: BackendScope`. This changes the erased declaration form only; no field, optionality, visibility, schema, parser or call-site type is broadened.
3. In that same file's original `scope(kind, workspace)` function, extract the nested `globalHome ??= await fs.realpath(homeInput)` assignment from the conditional expression. Initialize a local `root` to the same `workspace`; only inside the original `kind === 'global'` branch perform **the same nullish assignment** to the already-existing enclosing `globalHome`, then select that value as `root`. Preserve the original real `current()` immediately before the selection and immediately after it. The filesystem call remains conditional on the same global branch and original nullish value, at the same await boundary. Preserve the existing function-local memo and selected path; do not introduce a new cache, permission, fallback, read or await.
4. Remove only the two compiler-erased, lint-reported non-null assertions on `view!` at the original lines 565 and 572. The existing view read and launch/roster checks already precede both callbacks. Preserve the two predicates, selected rows, short circuits, every authority/currentness check and every router invocation.
5. In `CapturedRosterCommands.ts:56`, remove only the lint-reported non-null assertion from `retained[0]!`. Preserve `readScope`, the after-await guard, the exact-one-record check, and `this.original` with the same array entry and handle. No lookup, dispatch, retained result or ledger behavior changes.

This accounts for **seven import-sort errors, one declaration-form error, one nested-assignment error and three redundant non-null assertions = twelve errors**. The 1430 reported warnings are outside this cut. No rule disable, assertion weakening, new test, timer, native command, capture, retry or owner is introduced.

### 90.4 Preserve native custody and all original admission boundaries

The native `BackendOwnerRouter.ts` retains its original `RetainedWindowsCustody` import and `CapturedBackendOwner.nativeCustody` property. The native `DesktopBackendFeature.ts` retains its original `captureMainWindowsCustody` import, captured owner/client handoff, initialization-failure cleanup, shutdown chaining and complete `closeNativeOwners()` body. These are actual native custody behavior; the parent file must not overwrite them. Sort each variant's own imports and verify its own inverse independently.

All other executable statements and conditions remain byte-identical except for the equivalent extraction in §90.3(3). In that extraction, do not move either `current()`, evaluate `fs.realpath` for project scope or an already captured global root, reset the existing memo, or reorder any capture/selector operation after it. Main-origin selection, scheduler bindings, same-request cutoff, source/file identity, imported producer/Host contracts and the original physical cleanup remain the existing contract.

### 90.5 Review, publication and validation

Keep source at zero until this exact appendix is independently reviewed and published. Freeze source/diffs for all three variants with ten original/full final hashes, explicit old/new import declarations, and a finite inverse for the four local syntax categories. Independently verify that all original native custody additions and all out-of-scope bytes survive. Root remains the sole publisher and heavy-check owner.

Root then runs the existing features lint gate and the canonical Main typecheck on the composed source. The published R34.1 and P11 §16 checks retain their separate evidence. No new unit case is needed for erased declarations or an equivalent local extraction; do not create a broad new test campaign. The next authorized ordinary CI runs provide actual whole-head results. This appendix does not rerun/cancel a workflow, change a live head, relax a warning/error policy, or qualify any native runtime acceptance.

## 91. Keep the original process-stop selection type in the backend contract leaf

### 91.1 Actual failure and the dependency that exposes it

This is a two-path type-ownership repair for the existing strict scripts build after §89. The original two process-observer cases passed separately; that result does not qualify the scripts typecheck. Root's actual scripts typecheck on composed source `a390e771aaced8f7eacc0517b6b4b9b9b84dc380` failed with exactly `src/features/agent-backend/contracts/processes.ts(37,43): error TS2307: Cannot find module '@shared/types/team' or its corresponding type declarations.` The complete original log is immutable blob `d39bb0b96468029cb843c223bac7c7464d9791c3`; it is a compiler failure before a new native acceptance run.

The source edge is concrete: the §89 `scripts/legacy-agent-host/desktop-native-process-ui.ts` imports the existing strict `readBackendProcesses` parser from `../../src/features/agent-backend/contracts/processes.ts` at line 13 and calls it at line 62. That contract module has no other import dependency; its line 37 aliases `ProcessStopSelection` to `import('@shared/types/team').CapturedTeamProcessStop`. The original shared declaration at `src/shared/types/team.ts:806–809` contains only `processRef: string` and `originalCommandId?: string`. Resolving this otherwise unrelated erased alias pulls in the shared Team type graph. The scripts project `tsconfig.legacy-agent-host-scripts.json` (`cc479baf31482568a34f7ec4971f45070437777d`) intentionally uses strict NodeNext/noEmit and has no UI aliases.

The repair puts that existing two-field contract beside the process operations and parser that already own it. It does not change compiler resolution policy or copy the runtime parser into a fixture. The former §89 accepted/refused process observations, exact owner joins and native oracles remain separate and unchanged.

### 91.2 Exact writable scope and current preimages

The following two complete source blobs were freshly fetched from all three working variants. No third source, config, test or roster path is authorized by this appendix.

| Existing writable path | Parent / native / qualification preimage | Planned delta |
| --- | --- | --- |
| `src/features/agent-backend/contracts/processes.ts` | `41dd6a8e480b98e85922312fbc4e95089b58f609` on all three | Replace its one erased type alias with the exact original two-field exported interface named `ProcessStopSelection`. |
| `src/shared/types/team.ts` | `a2620b67a93bc82c78124f4b6ea0f55ed72ee01a` on all three | Replace its original four-line `CapturedTeamProcessStop` interface with a type-only re-export of `ProcessStopSelection` under that same original public name. |

The pinned source-read heads are parent `bd26037a23069c8cbdd8fbbbe85af5ac57c1c0b3`, native `29fc2ba25ad192a22a63d1898d380898218e2023`, and qualification `ea4d9df8ccc76afae978569ae8717098e84486f4`. Publication must recheck these exact two blob preimages even if unrelated working changes advance. Current P09 prefix is exactly `00bc1c937e5d1eaae46234ed3b72749fa3ca811b`; this appendix does not replace any §90 text.

### 91.3 One canonical declaration, two unchanged exported names

At the existing alias location in `contracts/processes.ts`, retain the preceding original comment and introduce only:

```ts
export interface ProcessStopSelection {
  processRef: string;
  originalCommandId?: string;
}
```

At the existing shared declaration location, use the ordinary existing feature-alias resolution available to the UI/Main projects, with a type-only re-export:

```ts
export type {
  ProcessStopSelection as CapturedTeamProcessStop,
} from '@features/agent-backend/contracts/processes';
```

There is one canonical field declaration. Its names, string types, required/optional distinction and mutability are unchanged; no index signature, readonly modifier, default or widening is added. Both original exported names remain available. The scripts graph now terminates at the backend contract leaf instead of resolving Team/UI types. The shared side already uses feature contract imports and exports; this reverse type-only edge introduces no runtime import or new file.

The bounded repository-wide TypeScript/JavaScript usage census found only the original declaration/alias, the renderer's type-only import and `captured?: ProcessStopSelection` parameter in `src/features/agent-backend/renderer/createHostProcessControls.ts`, and `captured?: import('./team').CapturedTeamProcessStop` in `src/shared/types/api.ts:590`. There is no internal use of the old name inside `team.ts`, so a re-export is sufficient. No second declaration or module augmentation of either type or these two modules was found in repository source/tests/scripts/packages. This is the compatibility basis for replacing the former interface with a re-export; it is not an assertion about hypothetical external declaration-merging clients.

### 91.4 Runtime and acceptance boundaries

Every byte of `processes.ts` outside that one type declaration and every byte of `team.ts` outside its replaced declaration must remain unchanged. In particular, retain all original process record fields, `isProcessRef`, `assertOriginalProcessStop`, `readBackendProcess`, `readBackendProcesses`, the 1024-row bound, duplicate-identity refusal, capability checks and original stop selection/recovery logic. The renderer consumer and shared API parameter are read-only source references, not edit targets.

Keep `tsconfig.legacy-agent-host-scripts.json`, every other config, NodeNext, strict/noEmit, include roots and alias tables byte-identical. Do not add a suppression, cast, duplicate interface/schema/parser, looser process DTO, runtime import, fixture fallback or package dependency. No source action, read, request, mutation, timer, native count, owner authority, cleanup or retry changes. Existing source-proof roster `scripts/legacy-agent-host/desktop-proof-sources.ts` already contains the contracts path at line 645; no new path is introduced or roster allowance requested. The small contracts module grows from 141 to 144 physical lines; the existing shared module shrinks by one line.

### 91.5 Review and finite verification

Source stays zero until independent review and root publication of this exact plan. After source GO, stage only these two deltas, freeze full before/after hashes and exact inverse proof for all three variants, and verify the runtime suffix from `export const isProcessRef` through end-of-file byte-for-byte. Independently verify the type export name/shape and that no import edge remains from the contracts leaf to shared Team types.

Root owns canonical validation: repeat the originally failing scripts typecheck on the composed source, then the existing Main/renderer typechecks needed to verify both unchanged consumer names, plus the existing source/lint gates for these paths. Reuse already scheduled canonical checks where they cover the same composed source. No new unit case or new native campaign is justified for this erased two-field relocation; existing §89 tests retain their own prior result and actual future ordinary CI retains its original acceptance role. This appendix does not claim that the compiler has passed, that a native failure is fixed, or that any workflow has been rerun.


## 92. Use the existing source-build heap allowance at the captured Darwin Desktop TEST boundary

### 92.1 Actual new failure and its limited scope

Status: PLAN ONLY / source0. This appendix preserves the entire current P09 `67e83c640af6ec32c82b6e3841d4016c9cdc1503` as its exact prefix. It refines §88's TEST environment scope using a new actual failure; it does not change production memory policy, source/Runtime authority or any acceptance result.

Parent Main run43582225377, job132409194247, uses PR head `3a2882e1e07cfc0c8f6f51be322b6244b7e6a179` and executed merge `9ca2fac456faf7cbc138b984f282df8f606ac659`. The original Create-with-native-launch source Desktop attempt fails before Electron/CDP/Host entry. Full job log is `fa73a4965659c1cbf463e2c3bd5cf5e54da717f5`. Official artifact14109011693 is207203 bytes, ZIP SHA256 `12eef0ce5505214203e728dd13f4a9a02590fc48fb4e6440d35c4f03ddc24320`; only its original small logs/receipt were read, with no rerun.

The original `desktop-app.log` blob `e579692e604f5a60797c755c27348ad9ff0b7df1` shows the pinned Node24.21.0 dev build transform3964 modules and enter SSR rendering, then fail at about2034 MiB with `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`. The unchanged `electron-vite dev` child terminates with SIGABRT and its original `dev:mcp` leader exits1. `connectCapturedDesktopApp` reports the downstream original “captured app exited during startup” assertion. The180000ms startup deadline did not expire.

Original receipt blob `e1993278524211d7e3a649669e9ba41b4ad5e646` is INCOMPLETE/native-create-ui with operations[], no occupied CDP listener and capturedHostObserved=false. Cleanup has remaining[]; capturedHostAbsent remains null because that Host was never observed. Source hashes before/after match. The only sentinel row is the original allowed `claude-multimodel --version`, blob `6364a862f901e4ca8d4ecccb4d90cdd842a44162`. The earlier genuine Claude commands proof and original47 script cases passed in this job; those independent results do not qualify the unstarted Create flow. Evidence packet `e9a559d4d0ff0bc4840230df9461f1a8c6e046c8` retains complete hashes and source joins. No free-RAM measurement or runner-capacity guarantee is inferred.

One subsequent read of five other terminal original jobs and their small artifacts confirms the same app-log sequence in every row:3964 modules, SSR rendering, V8 heap-limit OOM and electron-vite SIGABRT. These are observed failures, not deductions from the common outer assertion:

| Original job | Existing variant | Original app-log blob |
| --- | --- | --- |
|132409194267|native-mixed-v2-create-launch-ui|`0aa80559f33b5f02d715ccae148965dd4952e1ab`|
|132409194287|stopped-import-ui|`41af570b194e5c06523a050d0c127f78c04672e3`|
|132409194289|stopped-import-native-launch, actual current-source producer|`b512127fc25c8f370c225c6acf586d945bd6c9a9`|
|132409194324|native-quit-pending-open-readback|`e84672380ee88b26d1f0adcbae29292a57c52520`|
|132409194356|native-create-member|`3f96b979534d502fe7b3c65294c4668fd427bc75`|

Bulk evidence `1a47eb9b2a09c602a41c8c58bc78211e6a474be0` retains all five complete job-log blobs, verified archive IDs/lengths/SHA256, exact original receipt-member hashes and extracted observations. Receipts are INCOMPLETE with operations[], preserved source freeze and empty cleanup. The stopped-import-native-launch producer also explicitly records phase=connect and zero catalog/model/business/native-child counts. Its outer Stop/Quit assertion is downstream of the same failed builder, not an observed Stop defect. No other job result or model behavior is inferred from this set.

Root separately verified original P7 job132409194111 SUCCESS on the same Darwin ARM merge/Node24.21, evidence `399be4f7807eeaa9cc689ec3cf15e376483fa6af` and cold oracle `d808ee395c2616e1b5d882b4ca8ecaf2f2cfcfa3`, artifact14109036894. Its existing8192 cold arm reached the original source/packed launch-stop and separate cold Host/UI child-stop/physical-absence boundaries. This agent did not download that artifact again. That positive result supports retaining the old arm exactly; it does not qualify the newly included source modes or SDK cold survival.

### 92.2 Existing shared source-build entry, without a second mode registry

The current `desktop-backend-smoke.ts` `e890e4ecacd577e74bd3a900203c9971071a427f` requires `LEGACY_DESKTOP_BACKEND_GO === '1'` at its original entry before preparing the fixture. Its existing mode handling and `prepareDesktopProofMode` `df626ac0ed3a335699c556601bab859b5b82d829` retain the finite known-mode and additional original native/controlled grants. No new list of modes, public flag, selector or helper is required.

The common workflow `ci.yml` `b992f42311f62005ee24d51df71a2e83a4268a1f` already sets that explicit BACKEND_GO in the captured source Desktop setup at1028. The original cold qualifier `fc655e33538c3bed7b35b80d34b871890c03b5fc` also sets BACKEND_GO='1', its original PROCESS_COLD_UI_GO and mode in one closed child environment at110. Thus its supported source invocation satisfies the common entry predicate; its own existing8192 literal remains unchanged.

The same smoke module selects a packed invocation only from its original truthy `LEGACY_DESKTOP_PACKED_CAPTURE_PATH`, validated by `readCapturedCandidateElectron` before fixture creation. At its original spawn, a packed process receives a copy of the same fixture environment. Exclude that existing packed branch from the new common arm by using the identical source-versus-packed discriminator; do not newly send a Node option into packaged Electron. Preserve the complete pre-existing cold arm independently, including its prior behavior for low-level flag combinations outside the normal qualifier. The source branch continues through the unchanged selected Node/pinned pnpm `dev:mcp` invocation.

The actual environment helper `desktop-runtime-source-fixture.ts` currently supplies the8192 literal only to §88's Darwin/arm64 process-cold conjunction. Therefore native-create-ui reaches the original source builder without it. The production launcher `dev-with-runtime.mjs` `9cc8140d2a88207312580450aa9db0c8abc63b0a` copies its original environment and calls unchanged `ensureMinimumNodeOldSpaceEnv`; `node-options.mjs` `423d10be677fa86cc12a56cf433a378e4a0639e5` leaves an absent value absent and preserves8192. The existing package/CI source build already uses8192 as recorded in §88. Make that same allowance explicit at the one shared authorized source TEST environment construction rather than add mode-specific heap branches after each failure.

### 92.3 One existing write path, two exact variants

| Existing TEST path | Exact full preimage | Bounded change |
| --- | --- | --- |
| `scripts/legacy-agent-host/desktop-runtime-source-fixture.ts` | Parent `6a7d279caf2d2254ab0cae2bd87103069d87ba67` (298 lines); native and qualification `46054fc75555c65df9d099efb08a01f80353bfe6` (303 lines) | Keep the outer Darwin + arm64 tuple and the complete existing cold conjunction; add only OR (BACKEND_GO='1' + original source branch, falsy PACKED_CAPTURE_PATH). Retain the exact fixed `NODE_OPTIONS: '--max-old-space-size=8192'` field and the empty-object alternative. |

These three preimages were read from exact current heads `3a2882e1e07cfc0c8f6f51be322b6244b7e6a179`, `0e88cb3d18ac710148230bd2dfe5b5f45b22a248` and `ad17fbbd267851291abdca9b565638c774262834`. Preserve each full child variant, including Linux input handling. Do not change the qualifier, smoke, package/lock, workflow, production dev helper, dependencies, source caps or any assertion.

The exact selected predicate is:

```ts
process.platform === 'darwin' && process.arch === 'arm64' &&
((process.env.LEGACY_PROCESS_COLD_UI_GO === '1' &&
  process.env.LEGACY_DESKTOP_PROOF_MODE === 'process-cold-ui') ||
 (process.env.LEGACY_DESKTOP_BACKEND_GO === '1' &&
  !process.env.LEGACY_DESKTOP_PACKED_CAPTURE_PATH))
```

This field is constructed once in the existing fixture environment, before the original app capture/spawn. It must not read, concatenate or forward arbitrary parent NODE_OPTIONS. The old cold conjunction remains sufficient exactly as before; it is not made dependent on the new GO/source conjunction. The new arm requires the positive tuple, BACKEND_GO and the original non-packed branch. If neither arm applies, add no field, including no undefined property. Existing Linux and unselected/default branches stay unchanged; existing packed behavior changes nowhere because only the new arm excludes packed, while the old cold arm is preserved verbatim. This explicitly supersedes only §88's narrower other-source-mode exclusion for the common authorized Darwin source builder.

Disclose unchanged environment sharing: the source fixture environment is passed to its original selected Node/pnpm/dev descendants, and the controlled-process fixture can pass it to its original TEST root as already recorded in §88. This is not claimed to be a Vite-only value. Native provider recipes, their fixed flags/environment, original authority and model operations are not rewritten by this amendment. All180000ms startup and original per-job/case/action deadlines, request/model limits, process-group ownership, actual Stop/Quit and physical cleanup oracles remain unchanged.

The helper is already explicitly pinned in `desktop-proof-sources.ts` at633 and the unchanged node-options dependency in `desktop-proof-supplementary-sources.ts` at10. No source-roster edit or new file is required.

### 92.4 Review and normal verification

Root publishes this exact appendix before source GO. Independent review must confirm the common positive source entry, exact preservation of the original cold arm, packed exclusion from only the new arm and full variant inverse. Freeze only the one-path/two-distinct-blob predicate delta after GO; every other byte remains unchanged. No new unit test that merely mirrors the conditional or new diagnostic collector is needed.

Root owns existing script types, scoped lint/source-size/source-freeze checks and the ordinary next exact-head source Desktop gates. The actual original Create journey must then reach its real UI/native result with its unchanged assertions, and each other existing mode retains its own independent CI qualification. The new common source scope does not infer failures beyond the six actual original logs above, or claim that larger permitted heap alone guarantees successful compilation. Do not retry the failed attempt, reset a running build, extend a timeout, skip a platform, loosen the original exit assertion or claim this source review as E2E PASS.


### 92.5 Exact executed-checkout clarification

This is a provenance-only correction to §92.1 and evidence packets `e9a559d4d0ff0bc4840230df9461f1a8c6e046c8` / `1a47eb9b2a09c602a41c8c58bc78211e6a474be0`; their original log, receipt and archive bytes are unchanged. Each already retained full log for jobs132409194247,132409194267,132409194287,132409194289,132409194324 and132409194356 explicitly checks out and reports `git log -1 --format=%H` as `3a2882e1e07cfc0c8f6f51be322b6244b7e6a179`, also the original SOURCE_HEAD assertion. That is their executed checkout. `9ca2fac456faf7cbc138b984f282df8f606ac659` is their workflow/artifact-name merge identity, not the checkout. Thus §92.1's wording “executed merge” is superseded for these six jobs only. Exact original excerpts and line references are retained in `1a2177ca17ce94f894fe87de206ed715b3132872`; no CI log was fetched again or job repeated.

P7 job132409194111 separately executed `9ca2fac456faf7cbc138b984f282df8f606ac659`, as root verified from its own original evidence `399be4f7807eeaa9cc689ec3cf15e376483fa6af`; do not call it the same executed checkout as the six failed source builds. All six observed V8 heap failures, the existing cold-arm positive result within its own exact input, §92's one-file/two-variant scope and fixed-heap predicate are unchanged. This clarification adds no source or acceptance action and transfers no qualification between the two commits.

## 93. Preserve the process-stop alias through the existing public contracts entrypoint

### 93.1 Original failure and exact scope

The original parent run43582225377, Main lint job132411599809, checked out and reported `git log -1 --format=%H` as merge `9ca2fac456faf7cbc138b984f282df8f606ac659`. Its unchanged command `pnpm lint:ci:files src/main src/preload src/shared src/types --cache-location .eslintcache-main` finished with **3311 problems: one error and3310 warnings**. The sole error is `no-restricted-imports` at `src/shared/types/team.ts:806:1`: the §91 alias imports `@features/agent-backend/contracts/processes` instead of a feature public entrypoint. Full original UTF8 log `a83273263055b0f7b32f0dbddf9b9c42adee1c50` (1325687 bytes) and facts/steps bundle `b26a8b7a6935de82a958cd029b86de5ac948bde8` have complete matching readbacks. This is a concrete new architecture-lint error; it is separate from previously repaired type and features-lint failures.

The existing rule in `eslint.config.js` blob `7ca4b71fe3a357c00c110c9b75d3034e06e4b22c`, `feature-public-entrypoints-only`, applies to shared code and rejects `@features/*/contracts/*`. The already existing `@features/agent-backend/contracts` public entrypoint is the correct boundary. Keep the rule, compiler configuration, canonical interface and parser unchanged.

### 93.2 Exactly two existing source paths

| Existing path | Exact full preimage in parent, native and qualification | Minimal change |
| --- | --- | --- |
| `src/features/agent-backend/contracts/index.ts` | `62b03f3b8019162cfb6a154919503aec2c654088` | Add only `export type { ProcessStopSelection } from './processes';` beside the existing alphabetic contract exports. |
| `src/shared/types/team.ts` | `55e75e63dc6221a49d2c04ece6980e0ff7b1e091` | Change only the existing `CapturedTeamProcessStop` type re-export source from `@features/agent-backend/contracts/processes` to `@features/agent-backend/contracts`. |

All six current working-branch file reads match these preimages. The shared file is also byte-identical at the original failing merge. The underlying `src/features/agent-backend/contracts/processes.ts` blob `596444a7ef545c17f455bf00363c0d643bb13913` remains outside the write scope. It continues to own the unchanged canonical interface:

```ts
export interface ProcessStopSelection {
  processRef: string;
  originalCommandId?: string;
}
```

The public barrel exports only this existing type by name; do not re-export process runtime functions or duplicate the interface. The shared public name `CapturedTeamProcessStop` remains an alias of that same interface. This preserves both fields, their optionality and existing consumer semantics. Both added/repointed exports are type-only and add no runtime import or effect. All process operations, receipt/currentness guards, strict parser, Stop behavior and emitted runtime logic remain unchanged. No test, configuration, new file, source-cap, provider, native or workflow change belongs to this correction.

### 93.3 Publication and bounded verification

Root publishes this exact appendix on P09 prefix `14a1646a1747f3be034c4edba7e892115d954076` before source GO. Freeze the exact two-file delta and complete readbacks; inverse checks must restore both full preimages, and the canonical process interface/parser must remain byte-identical. Preserve every other barrel export and every other shared type byte.

Root owns the existing Main lint and relevant strict type gates on the composed source. No new unit case or native campaign is required for this type-only entrypoint correction. The unavailable executor leaves the interrupted local Main check unknown; neither source review nor the earlier checked Host results substitute for the next ordinary original CI type/lint result. The retained V1/V2 Desktop job132411599820 has a separate actual `team.launch.start` HOLD/unknown and unread artifact14111966683; this correction makes no claim about that failure or any native qualification.

## 94. Retain closed startup facts in the original Codex Login target read

### 94.1 Original failure and limited conclusion

Original qualification run 43582227542 / job 132422928717 executed checkout `0e88cb3d18ac710148230bd2dfe5b5f45b22a248`. Original evidence `e9affc1249051a9cf897f18b070e6f7f88acf82a` and triage `c235cfafa2900ce843457a63bc6bb755cd6ac481` retain zero visible matches for `button[aria-label="More actions"]`, zero UI steps/cases and no authorization attempt. The failure precedes the first hover or click.

Causal audit `1b580b61029af781929a3d446c3a544e0f1251bf` reads the exact Main/Renderer chain. Independent backend/account handlers precede legacy service readiness; Renderer waits for startup-ready before mounting App. The harness catches its unavailable `config:getClaudeRootInfo` request separately. Its failure does not establish a React exception. Startup failure/pending state, hidden or differently labelled target, and render failure remain unproven alternatives because this artifact lacks the relevant same-read DOM facts.

### 94.2 One existing TEST path

Only `scripts/legacy-agent-host/desktop-ui-controls.ts` may change, from exact parent/native/qualification preimage `15703898ff4639a442745f93c6083688b1c04ff4`; all three current reads match. Within `clickExpression`, enrich only the first `readPoint(label)` for the existing exact More-actions selector and `open existing More menu` label. Subsequent hover/stability reads and every other control retain their original expressions. Existing NativeExtensions caller blob `f4de929a00bc1be8330e8530be116b1c19cc04e7` reuses that selector/label, so its same first unavailable read receives these passive facts too; no caller change or observed failure is claimed for that flow.

The same existing evaluation executes its original target expression once. Only an unavailable result gains closed facts: raw selector count capped at 256, existing visible count, root presence/child count capped at 16, existing UI-initialized flag, splash presence/positive-size visibility/error/slow classes, document-complete and English/empty-language booleans, and a boolean matching the existing ErrorBoundary fallback's sole full-screen child/heading/alert-icon shape. That last field reports shape, not component ownership or an exception. Diagnostics never participate in target eligibility.

Retain only booleans and bounded integers in the existing failure-facts object. Preserve the original failure and cause. Do not collect text, HTML, attribute values, URLs, account data, authentication material or console messages. Add no CDP/IPC call, startup query, listener, click, reload, retry, timer, case or budget. Keep original ownership guards, 30-second deadline, 100ms passive cadence and successful point result unchanged.

### 94.3 Review and unchanged boundaries

Read-only inspection of existing `desktop-team-ui-smoke.test.ts` blob `7fdae995de965243dea7f3deda3496f0a3da5259` confirms its four control cases use other selectors/labels; two require byte-identical owner/hover expressions. Preserve those checks and all original input counts. No test write is authorized; any necessary test delta needs its own declared scope.

Freeze/inverse-check the one source delta; root owns existing script/control gates and the next original Desktop qualification. Source review cannot establish the missing-menu cause or E2E success. The acknowledged Quit left the previously observed esbuild process after its leader exited; the receipt does not prove survival for the full three-second cleanup window. This cut neither repairs that debt nor permits signaling or claims cleanup success.

## 98. Keep the Codex resolver TEST type import at the existing public feature boundary

Plan before source. Original native CI run43594548748, job132449753971, headc04761a8b45e31ff0c08e69fe5c628b9d555f528 failed on one `no-restricted-imports` error in `src/main/services/infrastructure/codexAppServer/__tests__/CodexBinaryResolver.test.ts:11`. Original full log is blob97ed83387918eb23ab45197efa3481afee3a82eb. This is a TEST type import diagnostic, not a native provider or product resolver failure. Existing warnings remain warnings.

The sole writable file has exact preimage37aadfb9c291f5ddb0803e50b664c5b48dc58066 on parent, native and qualification repairs. Replace only the source string of `import type { CapturedCodexManagedManifest }` with `@features/codex-runtime-installer/main`. The existing public entry already exports this identical type. Preserve the partial runtime mock's original private `importActual` target, every fixture, case, assertion, timeout and production source byte. Do not widen a lint exception, export a new API, change strict options or alter tests to accept a different result.

Root and an independent peer first verify the public export and this one-line write scope, then publish this appendix. After SOURCE GO, freeze the exact one-line forward/inverse diff and run the original `lint:ci:files` configuration against this original TEST file. No new unit test is needed: the change erases at runtime and the existing execution assertions are byte-identical. Keep the ordinary full Main lint and compiler CI gates mandatory; a bounded local lint result is not whole-repository or native qualification. Commit and immediately push each reviewed repair ref; do not advance live PR heads while original CI is active.

## 95. Connect the original configured Quit/Composer Launch to its exact fixture role and one OpenCode preparation

### 95.1 Original evidence and unchanged production authority

Read-only packet `b32566be77052151206877eb1d174ac118e94f9a` retains the original batch4 jobs, full logs, artifact hashes and source joins. They executed `09fefda4c255fa172a52b89b2815d18085c79afc`; `889325183907aa17e91c8fb992afa086cab9c621` is the artifact merge label only. Claude active/pending Quit jobs132446133176/132446133267 and V2 active/pending jobs132446133073/132446133211 stop at the existing configured Launch response: the fixture contains only Alice with role member, while the mandatory Main configuration projection requires one lead. No model request or native allocation is accepted at that failure.

PNG Composer job132446133228 already has Alice as lead. It reaches a rejected model request, with the oracle failure “native request retains deliberate TEST business input”; no business/probe observation is accepted. The exact Main `CapturedLocalModelReadiness` aggregate branch (blob `7d916d7e2b1edfe07d814184b1fbcf6b5bb553b3`) and Host `prepareTeamModelReadiness` (`d51831e769c6dc1906e60eeffc3dc20178aee1c6`) require one ordinary preparation for this original configured OpenCode Launch. The current lifecycle oracle enables ordinary probes only for Resume. The rejected HTTP body is not retained; this is a source-backed connected diagnosis, not a reconstructed wire observation.

Repair the two TEST joins together. Keep the production one-lead projector, Main origin/currentness, exact action/target/account/source, original Host receipt/released cleanup and allocation guards unchanged. Do not activate resumeMode, introduce a native bootstrap exemption, seed a successful proof or call another preparation owner.

### 95.2 Finite existing scope and sequential preimages

Only these nine existing TEST paths may change. No workflow, production file, new helper path, dependency, native case, timeout or source-size baseline is added. The mode and runner preimages are the already frozen C10 successors; root publishes/composes that cut first. All other rows were read from the current three source variants. Preserve W01 native-only behavior and every unrelated qualification/native delta.

| Existing path | Parent | Native | Qualification |
| --- | --- | --- | --- |
| `scripts/legacy-agent-host/desktop-backend-fixture.ts` | `2455282769cf3f129ae539ef034f9ed37964c3cc` | `2845e09bd38161818d358f7648a0b870a4f92bb5` | `3ae0c010b11c554996d825f6cef3b4b73ef2d121` |
| `scripts/legacy-agent-host/desktop-proof-fixture.ts` | `235639b475ebb8688756f0380df5d87d398e5bbf` | `998652fcaf71261cb838af38014278e0c02650a0` | `a9733fc656085a2dd478e04aad1c989e29e01987` |
| `scripts/legacy-agent-host/desktop-proof-mode.ts` | `9969cd67757a5ece3d4a2ede60fabe1006738b27` | `9969cd67757a5ece3d4a2ede60fabe1006738b27` | `b51acd4dda16537f460bc3ae9aef4f1f3d1c57e1` |
| `scripts/legacy-agent-host/desktop-backend-smoke.ts` | `ac98687de5b410d9eca287e91ce492eb1fe42675` | `6f58f8e2ae8675489e67d5b1d62b55ef7a6b90d3` | `0a40bfbf284e2f4a94e9cf564b89b951559bf16f` |
| `scripts/legacy-agent-host/desktop-native-stop-fixture.ts` | `0b4a8973310038dc7a13750b9583c6d8a215bd83` | `0b4a8973310038dc7a13750b9583c6d8a215bd83` | `0b4a8973310038dc7a13750b9583c6d8a215bd83` |
| `packages/legacy-agent-host/tests/fixtures/native-opencode-team/model.ts` | `3204ac6ac5ead2ba6b1621f9ad7d30b041bd1902` | `f49a5b22f1cb58c7a23e560061019b5fa8fd0940` | `3204ac6ac5ead2ba6b1621f9ad7d30b041bd1902` |
| `packages/legacy-agent-host/tests/fixtures/native-opencode-team/model-probe.ts` | `90e2b904d8cedeb9e63becbd7e81ed71e7382c26` | `90e2b904d8cedeb9e63becbd7e81ed71e7382c26` | `90e2b904d8cedeb9e63becbd7e81ed71e7382c26` |
| `packages/legacy-agent-host/tests/fixtures/native-opencode-team/model.test.ts` | `e09e08f1a57a3213d3bb43d46f7fd3d32c17cdb7` | `e09e08f1a57a3213d3bb43d46f7fd3d32c17cdb7` | `e09e08f1a57a3213d3bb43d46f7fd3d32c17cdb7` |
| `scripts/legacy-agent-host/desktop-opencode-v2-fixture.test.ts` | `e7dd31bff029300b478be3086b960764908ee088` | `e7dd31bff029300b478be3086b960764908ee088` | `e7dd31bff029300b478be3086b960764908ee088` |

The existing source rosters already include model, model-probe, fixture and stop helper; no dangling or new roster entry is needed. Existing `desktop-launch-ui-smoke.ts` C10 successor `f22c23b06e7701cbfccb527d1ccf594a5fa8379d` is read-only.

### 95.3 Genuine fixture topology and one original Main action

Add one private TEST setup option to `prepareDesktopBackendFixture`, passed only from the already selected `nativeStopMode` in `desktop-proof-fixture`. It marks the existing Alice row as lead before profile serialization/hash/descriptor pinning. Preserve Alice/member IDs, existing principals/grants, generations, executable/configuration, role-context marker, saved fields, child recipes and any Bob member. This does not enable launchDialog or change its defaults/management/creation branches. The original group/attachment lead remains lead; unrelated fixture modes retain their exact old role expression.

The V2 lifecycle mode adds an explicit configured-launch-preparation option only when it will call the existing `prepareDesktopNativeStop` setup. Resume and other oracle options retain their old values. Replace that helper's private provider-only OpenCode argument with a finite OpenCode model port on the same existing caller expression, so the selected provider and its preparation window are connected. Missing model/port for the positive OpenCode arm refuses before the original action; it cannot silently select Claude.

The setup still performs the same original launch read, native global/project catalog reads and exact configuration. Immediately around its sole `team.launch.start` / `TEST-explicit-sandbox-setup-launch`, arm the returned `configuredLaunchPreparation` for that literal original command and unchanged selected launch/roster/member/model. The command ID attributes the TEST window; the native HTTP request is not claimed to echo it. Preserve the existing response evidence and assert `start.ok` first; on success additionally require one consumed preparation and the same model probe ledger entry. A finally disarm has no timer/effect and must not mask an original failure. No new Main IPC, separate probe.start, polling loop, retry or setup replay is introduced.

### 95.4 Existing no-tools protocol owner and closed oracle window

The existing `native-opencode-team/model-probe.ts` already owns exact ordinary-probe recognition, including the single pinned V2 trailing MAX_STEPS message. Extend this same protocol owner with the finite configured-launch window and its existing ordinary SSE reply. Move only the current ordinary reply block from model.ts into a typed reply function here: preserve request model/fallback, probe-count response ID, created timestamp, both exact chunks, status/content type and DONE/end order. Mechanical inverse must reconstruct the original reply body, accounting only for its explicit body/response/probe-count parameters. Coordination, W01 and business response codecs remain in their current branches. This cohesive classification/window/reply boundary owns the new preparation behavior; it is not a layout-only extraction.

The positive configured option is V2 only and cannot combine with allowModelProbes, Settings, live-membership, coordination, shared-session, retained-process or other specialized probe modes. Preserve the ordinary lifecycle's original member/principal, image and held-response options. The closed window starts idle, arms once for the exact original setup command, and accepts exactly one original no-tools prompt at the existing route with TEST-model and the original TEST Bearer key, only while probes=0 and business=0. Wrong shape/route/model/key, unarmed, duplicate, rearmed, business-before-preparation or post-disarm probe fails through the existing sealed failure path. The exact V2 suffix rule is reused, not widened to arbitrary assistant text. After successful consumption and disarm, the existing business oracle handles the deliberate input unchanged. Neither cold reads nor a later action can rearm this window.

Keep the global ordinary probe ceiling8 and business ceiling16. Preserve the native model's complete W01 branch and file cap800 through the semantic protocol extraction; no line packing or baseline increase is permitted.

### 95.5 Explicit request arithmetic and original clocks

| Original lane | Preparation HTTP requests | Business HTTP requests | Required total |
| --- | --- | --- | --- |
| Claude active Quit | unchanged0 | unchanged1 held original request; second Runtime input stays queued | 1 |
| Claude pending-open Quit | unchanged0 | unchanged0 | 0 |
| V2 active-input Quit | exactly1 (delta+1 against previously allowed0) | unchanged1 held; second Runtime input stays queued | 2 |
| V2 pending-open Quit | exactly1 (delta+1) | unchanged0 | 1 |
| V2 PNG Composer | exactly1 (delta+1) | unchanged original ONE8 plus TWO3 | 12 |

Metadata reads add no inference. This is one already-required production preparation, not an extra business input. Keep the model HTTP15000ms, provider/management120000ms, selected V2 client180000ms and original Main budget `min(100000, selected requestTimeoutMs)`; Host preparation remains bounded by that remaining original Main cutoff and its captured modelProbeTimeoutMs. Keep the existing post-Start readiness waits (V2180000/Claude45000), input/Quit/Stop/cold deadlines and process observations unchanged. The TEST window adds no clock, renewal or capacity. Cold acceptance retains the same exact business/probe counts and zero automatic input; its original assertions are not waived.

### 95.6 Existing-case verification and freeze

Extend only the existing first model-oracle case with finite synthetic subscopes for the exact V2 configured preparation and refusal boundaries (unarmed/duplicate/rearm/wrong model/key/suffix, business before completion); preserve all original names, assertions and request loops. A passing single preparation uses the original SSE codec and does not add a native campaign. In the existing V2 descriptor composition case, construct the explicit file-only setup fixture and check the genuine lead plus unchanged member/management/descriptor identity and pins; its original launchDialog fixture assertions remain. No Corepack/Electron/model native process is added by that test.

Freeze all three variants and exact inverse checks, including the moved reply body and all C10/W01 preimages. Independent peer and root publication precede source. Root owns the existing controlled cases, strict script/Host types and source-size gates, then ordinary original Desktop jobs. Source review alone does not qualify Quit, PNG, native custody or cold readback. The separate Resume/Review saved-roster transfer, prior-run heap and donor drain findings remain outside this cut.

## 96. Preserve the captured Darwin ARM source build heap in the current stopped-import producer

Original batch4 job132446133160 executed `09fefda4c255fa172a52b89b2815d18085c79afc`. Its retained packet `b32566be77052151206877eb1d174ac118e94f9a`, raw job log `38ffdf47737da97c4f73b57174cc82e6e9c860fb` and artifact14114885541 identify a failure in `desktop-current-stopped-app.log`: the current source App builder reaches approximately2053MiB and terminates with V8 heap exhaustion/SIGABRT before App startup, the original native turn or import. The artifact ZIP is98776bytes, SHA256 `f0d9b8842434e500e029db93a0b80b960ee728b32a1ba0613d7c9c52dd7beac8`. Native observations and input/metadata counters are empty, and cleanup reports no remaining process; neither the native journey nor import is qualified by this failed run.

The §92 common builder correction does not reach this path. `produceDesktopCurrentStoppedTeam` constructs a separate literal child environment rather than inheriting the common source fixture environment. Its original `captureCurrentStoppedSourceInputs` already positively asserts Darwin, arm64 and Node24.21.0, validates the current frozen source and selected runtime, and returns before that child environment is assembled. The producer additionally requires the original stopped-import-launch mode and rejects donor-saved-only. This is the same bounded current-source build boundary, not the historical donor producer or a general runtime setting.

The sole writable path is `scripts/legacy-agent-host/desktop-stopped-import-prior-run.ts`, preimage `41270638b4c552e5f535ff966506fbfaa1e6b13a` in parent, native and qualification. Add exactly `NODE_OPTIONS: '--max-old-space-size=8192'` to that existing literal environment after its original tuple/source admission. The unconditional literal is scoped by the already mandatory Darwin ARM assertions; do not create a second platform selector or copy an ambient NODE_OPTIONS value. Read-only source witness `scripts/legacy-agent-host/desktop-stopped-import-fixture.ts` is `b69f6132475fd33ab6d9c6d6b7d7ff4acf97e881`.

Preserve every other environment field, original Node→Corepack→dev:mcp invocation, source/runtime hash, executable selector, no-Host-descriptor assertion, existing UI/native sequence, sentinel census and cleanup. Do not modify the common builder, old donor, workflow, dependencies, test cases, process/HTTP counts, deadlines, source-size baseline or acceptance assertions. The fixed8192 value matches the already reviewed common builder; this cut does not retry allocation with progressively larger heaps.

Freeze the one source hunk with an exact inverse for all three variants, then obtain independent source review and root publication. Root runs the existing script/type/source guards and the original stopped-import Desktop lane; no new case or native campaign is added. Static review establishes only the connected environment correction. Actual source build, one original native turn, original Stop/Quit, import and cold acceptance remain required. The saved-donor drain observation and §95/§29 failures are separate and are not claimed fixed.

## 99. Prepare the original V1 native fixture configuration directory before its source freeze

### 99.1 Original failure and controlled boundary

Batch4 Codex Resume job132446133227 fails in its existing native mixed-team Restore prerequisite, before the Desktop Codex scenario. It executed09fefda4c255fa172a52b89b2815d18085c79afc. Original log e0fe7ce2996b6b31f61c00b28b717db01d4ac42d and artifact14115158301 (38988449bytes; SHA25692267bd0ddd8d3b6ccd6fb654e308edd7f892f2a4c04d53df26df4e3ebab425c) retain Alice/Claude and Bob/Codex ready, while Carol/OpenCode1.19.4 goes from opening to unresolved custody in3.866seconds. This is earlier than the original45second opening deadline. No business request or Restore selection is accepted; the V1 database has no session/message/part row. Host close exits1 and masks the original private opening exception, so that exception is not reconstructed.

The original producer creates Carol's XDG config root but leaves its opencode directory absent. The pinned native engine creates that directory and ordinary auxiliary files; the original artifact contains them. The unchanged OpenCodeConfigurationSource records the first missing ancestor for every configuration source. Once the native engine creates the missing directory, the original frozen reference is stale even if no opencode.json or opencode.jsonc was written. The original initialModelAdmission currentness check therefore cannot remain valid through this transition.

A controlled read-only-source filesystem reproduction using the current built capture function confirmed all three boundaries: capture before namespace creation becomes stale after mkdir; namespace created before capture remains current after ordinary .gitignore and node_modules creation; subsequently creating an actual configuration file still invalidates the capture. This is a deterministic source-boundary reproduction, not a native execution or proof of the masked exception. Pinned upstream1.19.4 configuration sources retain the global config directory and create its auxiliary files; no runtime flag or dependency change is justified.

### 99.2 One existing TEST producer change

The sole writable path is packages/legacy-agent-host/tests/native-mixed-host.native.ts, exact preimage58cd0322d2fdcb7f4122dd47113c072d9d102ede in all three repair variants. Add the single literal carol/config/opencode to the existing ordered directory list after all member roots. The existing mode0700 mkdir loop prepares it before any profile serialization, source capture or Host process. Retain the existing private root, XDG path, native binary and all profile fields. Do not create a config file, copy donor state or perform native initialization outside the original Host action.

Production capture/currentness, source identities, private initial admission, allocation and custody checks remain unchanged. Preserve every original script flag, command, input, model/probe counter, runtime receipt, Restore assertion, deadline, cleanup and executable pin. No retries, extra native actions, new helper, source-size exemption or oracle relaxation is permitted. Other fixture producers and product first-use flows require their own connected evidence and are not silently changed by this TEST correction.

### 99.3 Review and acceptance

Freeze the one-line source diff and its full inverse for all three identical variants. Independent plan review and publication precede source; independent source review precedes publication. Root runs the existing Host test compiler and source guard with the coherent cut, then the same original native mixed Restore prerequisite and Desktop Codex job through ordinary CI. No new named test or native campaign is added. Passing the controlled boundary alone does not qualify native startup, Host cleanup, Restore or Desktop Resume; all remain required on the final CI head.

