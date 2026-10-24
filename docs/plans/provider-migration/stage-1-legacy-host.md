# Этап 1: совместимый legacy-host поверх provider-implementations

**Физическое отделение провайдеров (24 октября):** исходники `provider-implementations`
и независимого Session SPI теперь находятся в [old-provider-implementations](https://github.com/agent-teams-ai/old-provider-implementations).
Перенос подготовлен в [draft PR #1](https://github.com/agent-teams-ai/old-provider-implementations/pull/1), CI Node 24/26 прошёл;
merge не выполнялся. Зависимости от движка старого `agent-runtime` у этих пакетов нет.
Host/Team/Runtime owner и адаптеры Desktop остаются во frontend. Выбранные архивы
не меняются: все 206 provider и 10 SPI emitted-файлов совпадают с отдельным репозиторием.
Этап 2 по-прежнему не входит в работу.


**Обязательное правило UI (прямое указание владельца, 22 октября): использовать
только существующий UI. Не писать новые альтернативные формы/диалоги запуска,
создания команды, resume/relaunch, задач или review.** Сохраняются существующие
компоненты, поля и сценарии. Интеграция меняет backend/API adapters и необходимые
источники данных; недостающая поддержка доводится в backend. E2E проходит через
эти же пользовательские controls, прямой API setup не заменяет приёмку диалога.
Для Launch/Create используются именно `LaunchTeamDialog` и `CreateTeamDialog`:
полноценный E2E включает ввод/изменение значений, submit существующей кнопкой,
наблюдение progress и проверку сохранённых/effective настроек через backend.
Ссылка на этот план обязательна в описании каждого draft PR; формат закреплён
в [правилах доставки программы](README.md#описание-каждого-draft-pr).

Это весь текущий implementation scope: P0–P8 / M01–M19. Этап 2 с будущими
Orchestrator и agent-runtime сейчас не выполняется и не нужен для завершения
этого плана; см. [зафиксированное решение](README.md).

Статус: P0–P6 и dev E2E из P8 реализуются в изолированных lanes;
сохранённые scoped proofs перечислены в матрице совместимости. Packed candidate
P7 и итоговая приёмка P8 ещё не завершены; весь этап 1 остаётся открытым.
Направление принято владельцем; производственная готовность не объявляется.
Основание и оценки: [двухэтапная программа](README.md).
Функциональный denominator: [матрица совместимости](compatibility-matrix.md).
Точные recovery/RPC/checkpoint решения: [протоколы этапа 1](stage-1-contracts.md).

## 1. Цель, scope и конечный результат

Получить изолированный Desktop candidate, в котором существующий UI управляет
полноценными командами Claude/Codex/OpenCode через выделенный legacy-host и одну
provider library. Исполнение не запускает fork CLI, не импортирует fork source,
не использует его React/AppState/QueryEngine как скрытую dependency. Разрешён
официальный executable конкретного провайдера, выбранный его driver/host profile.

Сохраняется пользовательское поведение текущего продукта: roster/roles, solo/team,
запуск/ready, tasks/assignment/dependencies, DM/group/cross-team, approvals,
interrupt/stop/restart/resume, context/settings, activity/logs/usage, TaskRef,
evidence/review и provider connection. Все строки M01–M19 обязательны; при
обнаружении используемого сценария вне матрицы добавляется строка до его удаления.
Первый vertical slice не уменьшает scope окончательного результата.

Вне этапа: разработка будущего Orchestrator/runtime; redesign всей task-модели;
автоматическое принятие живых процессов старого owner; cross-owner relay;
новый агентский loop; новый backend `ar`; новая server/multi-tenant платформа;
production rollout и изменение текущего release default. Не переносим скрытые
upstream CLI возможности без потребителя в сохраняемой матрице.

Этап завершён только после P8. Реализация каждого P-шагa остаётся в worktree.
Merge/release допускается обсуждать после результата и review по отдельному
решению владельца, а не автоматически в конце скрипта.

## 2. Рабочие места и артефакты

| Lane          | Ownership                                                                                   | Запрещённые пересечения                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Frontend/host | `packages/legacy-agent-host`, Desktop feature/client, test fixtures и локальная composition | Изменять release checkout, копировать whole-service facades, переписывать renderer одновременно с backend |
| Provider      | Только provider package, его private adapters/tests/exports и необходимые owning metadata   | Team/Task/Message writers, текущий runtime engine, копия host-очереди                                     |
| Integration   | Отдельный frontend worktree с точными refs/artifacts обоих lanes                            | Sibling source aliases, общий dist/node_modules, использование production userData                        |
| Future cores  | Изолированные прежние worktrees; результаты сохраняются как donors/evidence                 | Делать их незавершённый код dependency первого этапа или автоматически продолжать старый A–F delivery     |

На P0 фиксируются base HEAD/branch/worktree каждого lane. Работа начинается от
выбранного committed baseline; новые release-правки позже импортируются отдельным
проверенным delta. Dirty работа не захватывается whole-tree copy/cherry-pick.

Каждый запуск использует новый `TEST-*` project/workspace, отдельные HOME,
provider config/data/cache и Electron userData. CDP 9222 используется по умолчанию;
если он занят, штатный `dev:mcp` launcher выбирает следующий свободный порт.
Smoke фиксирует этот TEST endpoint и проверяет принадлежность captured app process
group перед подключением и каждым действием. Чужое окно не подключается/останавливается.
Cleanup действует только на captured run/process/port/storage данного harness.
Не меняются пользовательские auth, teams, worktrees, inboxes или updater channels.

## 3. Размещение и transport

В frontend workspace создаётся один package `packages/legacy-agent-host`:

```text
packages/legacy-agent-host/
  src/
    team/          # legacy business use cases + owned ports
    runtime/       # technical session/input/control + owned ports
    adapters/      # legacy files, provider SPI, process/IO, Git, MCP
    composition/   # конкретная сборка host и entrypoint
  tests/           # reused fixtures + boundary/integration proofs
src/features/agent-backend/
  contracts/       # browser-safe app API/DTO fragments
  core/            # owner routing / request binding ports
  main/            # host client, composition, adapters
  preload/         # тонкий IPC bridge
  renderer/        # только реальная boundary-интеграция существующего UI
```

Точное деление внутри package следует существующим use cases; пустые папки,
интерфейсы для каждого helper и inheritance manager не создаются. Вне feature
используются её public entrypoints; новые production-файлы не превышают 800 строк,
legacy size/provisioning ratchets не увеличиваются.

Host запускается как отдельный **выбранный Node process** для одного Desktop TEST
profile; renderer не импортирует package. Это исключает зависимость provider SDK
от Node ABI Electron. Version/executable/config проверяются до allocation.
Desktop владеет соединением и captured child host; runtime-модуль владеет native
provider children. Выход host не считается доказательством остановки его детей.

Для установленного candidate Node поставляется **внутри candidate resources**
отдельным pinned artifact выбранного OS/arch tuple, вне ASAR. P1 фиксирует exact
version/digest, build-time acquisition и resource path; P7 проверяет эти bytes.
Existing staging/packaging helpers расширяются этим artifact, новый downloader
при startup не создаётся. Electron-as-Node и пользовательский PATH не являются
fallback. В dev допускается явно captured совместимый TEST Node; такой dev PASS
не доказывает packaged runtime. Host/SDK разрешаются относительно своих artifacts,
не соседнего checkout. Source/digest получения Node фиксируется в existing manifest.

Локальный transport — JSON-RPC по stdio с request IDs и ограниченными framing/
payload/notification buffers. Нынешний `JsonRpcStdioClient` использует unbounded
`readline`, session timeout и force-close, поэтому целиком для постоянного host
не подходит. Reuse ограничивается пригодными primitives за owned port; shared
Codex client попутно не переписывается. Host framing/control описаны в
[протоколе соединения](stage-1-contracts.md#2-соединение-и-ошибки).
Новый network daemon и второй message broker не вводятся. Логи идут отдельно от RPC.

IPC и существующий HTTP adapter Desktop вызывают один feature API. HTTP здесь
не требует browser-dev smoke: пользовательская проверка выполняется в Electron.
Этап 2 сможет заменить host client на client нового ядра за тем же consumer port.

## 4. Три сохраняемые границы

### 4.1 Desktop backend port

Owner binding фиксируется **до мутации**: backend identity/revision, storage root,
project/workspace, team/run/member identity и generation. Display name/provider
label не является ключом полномочий или маршрутизации. Старые accepted/unknown
commands навсегда сохраняют original binding, даже после смены default target.
Новые command IDs на retained handle также сохраняют его owner; positive routing
probe при смене default/rollback задан в §1/§7 протоколов.

API группируется по реальным app capabilities: Team/lifecycle, Task/review,
messages/groups, activity/queries, connection/config, command outcome. Существующие
совместимые DTO используются повторно. Legacy paths/native session IDs/credentials
не становятся renderer API. Экран не выбирает reader по provider ID.

Stable command ID, descriptor и fingerprint задаются до первого dispatch.
Повтор того же intent возвращает прежний результат; изменённый payload даёт
conflict. После response loss — lookup исходного outcome у исходного owner.
Timeout/transport abort не означают cancel и не разрешают fallback в fork.
Истёкший/неразрешимый outcome остаётся UNKNOWN, а не создаёт новый UUID.

Read API имеет snapshot и change/progress sequence. Разные feeds не делят один
выдуманный глобальный cursor. После потери retention — rehydrate/явный gap.
Согласованный snapshot содержит cursor для replay; поздний snapshot/result
не откатывает cache. Точный handoff описан в
[протоколе reads](stage-1-contracts.md#согласованный-snapshot-и-feed).

### 4.2 Team → Runtime port

Team-модуль передаёт immutable member/workspace/config binding, требуемые
capabilities, input identity/content, control target и checkpoint reference.
Runtime возвращает отдельно admission, handoff/consumption, terminal и cleanup.
Он не решает статус Task и не разбирает имя команды из текста.

Runtime API включает cohesive session conversation: open/submit/observe,
reply/interrupt/close, read/reconcile/checkpoint/restore. Имена следуют P1 binding,
а не обещанию одинаковых методов будущего engine. При добавлении capability
проверяются её ошибки, concurrency и side effects, а не только TypeScript shape.

### 4.3 Runtime → Provider SPI

Используется существующий curated Session SPI provider library. Legacy runtime
реализует private configuration/checkpoint/custody ports её фабрик; concrete SDK
types остаются в composition/adapters. Прямой runtime-implementation import и
`createInteractiveSessionHost` нынешнего runtime для этапа 1 не требуются.

Нынешние `submit/observe/respondToInteraction/interrupt/checkReadiness/checkpoint/
close` сохраняются с их действительными гарантиями. Provider checkpoint opaque;
его engine/config/account/workspace compatibility не переопределяется host.
Не хватает нужного наблюдения — добавляется scoped backward-compatible capability
provider library с проверкой, а не второй raw-protocol adapter в Desktop/host.

Host и provider package устанавливаются из проверенных packed artifacts вне
donor checkout. Уже известна install/build coupling: нынешний consumer test
устанавливает весь `agent-execution` и custody dependencies. P1 выделяет один
type/schema-only contracts artifact, рабочее имя `@agent-teams/provider-session-contracts`,
в том же workspace по штатным правилам owning repo. D и legacy-host используют
его напрямую; прежний curated entrypoint re-export этих же определений сохраняет
существующих consumers. В artifact нет engine/PG/custody implementation,
SDK imports и доменных Team/Task types. Нового contracts repo не создаётся.

## 5. Единственные владельцы состояния

| Состояние                                               | Writer на этапе 1                               | Как взаимодействует Desktop                                                 |
| ------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------- |
| Team config/member metadata/bootstrap intent            | Team-модуль legacy-host                         | Command/query через captured backend                                        |
| Tasks, assignments, dependency graph, comments          | Team-модуль через extracted stores              | Все UI/MCP mutations идут в те же use cases                                 |
| Inbox, sent/group/cross-team messages, delivery intent  | Team-модуль                                     | UI читает projection; delivery выполняется конкретной runtime session       |
| Task change evidence/review decisions                   | Team-модуль; technical capture у runtime/driver | Existing review UI через scoped API                                         |
| Sessions, inputs, interaction/control, runtime progress | Runtime-модуль                                  | Наблюдение/control через Team boundary                                      |
| Native SDK/protocol session и volatile callbacks        | Provider driver + private runtime custody       | Прямого доступа нет                                                         |
| View cache, pending request identity                    | Desktop                                         | Производная проекция и existing command ledger, не второй Task/inbox writer |

Сохраняются нужные legacy file formats, atomic writes, locks, stale-run/tombstone
guards. Их read/write adapters находятся за owner ports. Для host-owned команд
старые прямые Desktop writers/watchers отключаются в том же vertical slice.
Read-side код можно переиспользовать в host, но запрос не выполняет repair.

Существующий command-outcome/idempotency механизм расширяется только недостающими
binding/fingerprint/phase/resource identities. Подготовленные resource/message IDs
фиксируются до эффекта. Multi-file update не объявляется атомарной транзакцией:
под owner lock делаются deterministic writes по original IDs, затем фиксируется
outcome. Частичная запись сверяется по тем же IDs/versions; conflicting/unknown
state удерживается. «Повторить весь handler» не является recovery strategy.
Если конкретный store не даёт такого протокола, его slice сначала получает один
узкий durable intent/receipt owner; новый generic workflow engine не строится.

Execute, partial-effect census, reconcile/retry и revoke используют тот же
resource/authority fence. Возраст Started/timeout не доказывает остановку первого
handler. `not_applied` допустим только после исключения его поздних writes;
иначе UNKNOWN/HOLD. Current authority проверяется и перед completed-result replay,
который existing command runner может вернуть без вызова handler.
Порядок и минимальные receipt-поля заданы в
[протоколе команды](stage-1-contracts.md#3-команда-и-частичная-запись).

Прежние бизнес receipts и технические input records имеют разные обязанности.
Один Message не становится вторым inbox store в runtime; один handoff не получает
два независимых dispatch ledger. Provider не пишет продуктовые team/task файлы.
Completed business receipt не снимает delivery obligation: startup/reconnect
существующего outbox owner доводит исходный intent до durable runtime admission
по [протоколу delivery](stage-1-contracts.md#delivery-после-business-commit).

## 6. Обязательные переходы и сложные случаи

### 6.1 Session и input

До native allocation сохраняется opening intent с exact generation/config.
Для native create, потерявшего ответ, нет второго create по title/member name.
Session становится ready после handshake, mandatory tools и config proof;
PID, inbox file, `member_briefing` или `registered` этого не доказывают.
Team bootstrap отдельно подтверждает initial context exact generation и считает
статусы по сохранённому expected roster, включая не создавшие session members.
Partial launch, human-permission wait и scoped retry описаны в
[bootstrap-протоколе](stage-1-contracts.md#team-bootstrap-и-частичный-запуск).
Потеря обязательного MCP/tool инвалидирует member readiness и удерживает новые
handoffs до свежего same-binding proof; control и исход active input учитываются
отдельно. Детали: [readiness recovery](stage-1-contracts.md#readiness-при-потере-обязательной-зависимости).

До handoff сохраняются input/operation ID, fingerprint, binding и delivery intent.
Одновременно допускается один активный turn конкретной session, очереди и output
ограничены. Бюджеты заданы доверенной конфигурацией, не текстом prompt.

| Наблюдаемый исход                         | Продолжение                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Admitted, dispatch ещё надёжно не заявлен | Dispatch по тому же intent и fencing                                                                   |
| Доказанный known-not-sent                 | Policy-controlled повтор того же intent допустим; новый intent не подставляется                        |
| Consumption/handoff без terminal          | Ждать/прерывать exact operation; не считать Task выполненной                                           |
| Handoff uncertain или crash после claim   | Reconcile исходный binding/evidence; без доказательства остаётся UNKNOWN и блокирует следующий handoff |
| Result + iterator exception               | Один terminal; исключение отдельно ухудшает здоровье/даёт diagnostic                                   |
| Native terminal неизвестного типа         | Unknown/unsupported; не успех и не безопасный retry                                                    |

После host restart сначала читаются persisted obligations. In-memory отсутствие
team/process не означает завершение. Старая generation не переоткрывается; новый
writer не допускается при unresolved ownership. Persisted PID, port/title или
`kill(pid,0)` сами по себе не дают права принять процесс под управление.

### 6.2 Control и stop

Reply permission/question идёт независимо от заполненной prompt queue и связывается
с exact interaction/session generation/operation/expiry. Смена roster/revoke
проверяется handler до product effect и после relevant owner lock. Late/duplicate
conflict/post-abort reply не выдаёт grant. После restart старый callback не оживает.

Interrupt A, пришедший после result A, не отменяет B. Control и next handoff имеют
общий per-session fence. `requested`/RPC ACK не является `cancelled`.
Close сначала закрывает admission, затем дожидается outcome/drain/custody.
Unknown stop сохраняет debt и не допускает replacement generation.
Ещё не claimed inputs получают durable cancelled/not-sent; drain не исполняет
отложенные prompts. Targeted discard UI и revoke сериализуются с admission/claim,
не удаляют чужие/новые rows и не скрывают UNKNOWN. Подробности и crash recovery:
[очередь/discard/stop](stage-1-contracts.md#очередь-discard-и-stop).

Shared OpenCode backing нельзя завершать при stop одного member: логическое
закрытие session и физический stop host — разные права. Runtime хранит exact
captured ownership и active session references. Host disposal пытается закрыть
все принадлежащие ему ресурсы, даже если первый close неизвестен/упал.
Cooperative child/group cleanup не выдаётся за универсальную защиту от внешних
writers; более сильные guarantees требуют соответствующего profile/evidence.

### 6.3 Messaging, tasks и tools

Tool identity получается из trusted member/run binding. Переданные моделью actor,
team, member, task или permission mode не дают authority. Scoped MCP endpoint
проверяет current membership/role/task grants и idempotency. UI и agents вызывают
одни use cases. Native Claude Team/Task/SendMessage writers не включаются вторым
ядром; имена legacy tools при необходимости переводятся в MCP boundary.

Обычный SDK subagent без `team_name` отличается от persistent teammate. Текущий
Desktop допускает его в solo DO; эта возможность сохраняется с action-mode gate.
Нынешний D блокирует все `Agent` tools и не сохраняет child provenance: это явный
provider gap P4, а не готовая поддержка. Нужны scoped parent/child observations и
custody/control; одного whitelist имени недостаточно. Subagent не получает
teammate identity или расширенные Team grants из переданного моделью payload.

Revocation и mutating handler сериализуются одним существующим owner authority
fence до финальной записи/outcome. Проверка grants повторяется внутри него;
receipt/result disclosure также требует current authority. Если eligibility
приходит из внешнего порта, его version/lease должен явно покрывать commit или
dispatch. Последний async запрос перед COMMIT сам по себе не даёт такой гарантии.
Для этого используется конкретный lock/revision protocol, не новая auth-платформа.

Message commit, input admission, client consumption, доказанное context/read и
explicit reply учитываются отдельно. Одно text/result событие не отмечает inbox
прочитанным и не создаёт фиктивный ответ. Structured TaskRef сохраняется в полях
сообщения/комментария/описания, не восстанавливается по display number.

Все providers получают сообщения через один delivery owner. Извлечённая семантика
inbox не оставляет одновременно старый Claude poller, OpenCode bridge и новый
dispatcher на одном intent. Lead — отдельный адресат; peer DM не проходит через
него. Group/cross-team используют retained recipients, delivery IDs и принадлежность
одному backend. Cross-team parity первого этапа доказывается между host-owned
командами. Active old-owner teams сохраняют прежний путь между собой; новый host
не присваивает их процессы/receipts. Смешанный old-owner↔host обмен не включается
незаметно: до rollout такие команды завершаются прежним owner либо требуется
отдельный принятый bridge scope. Это учитывается в delivery decision, а не скрывается
за отметкой полной совместимости нового host.

Task completion/review сохраняет действующие product правила: provider result
сам по себе не означает выполненную задачу; stale assignment не оживляет старую
работу. Dependencies/claim/update/delete/reopen сохраняют свои guards. Новые N2
модели будущего ядра здесь не внедряются. Tool-output change capture и review/apply
проверяются на настоящих TEST Git bytes; SDK checkpoint не заменяет change ledger.
Trash, Team/Task/member restore, permanent delete и backup имеют отдельные
переходы/guards из [§11 протоколов](stage-1-contracts.md#11-trash-restore-backup-и-окончательное-удаление).
Product tombstone не стирает unresolved runtime debt и не означает physical stop.

### 6.4 Config, context и наблюдение

Provider/model/account/workspace/settings/tool revisions связываются до запуска.
Private credentials projection получает только выбранный driver. Нет ambient
наследования старых team/bootstrap/MCP writers, auth/config чужого user profile.
Конфликт config, missing required MCP или неподдержанная capability отказывает
до execution; не переключает backend/model/account автоматически.

Skills/hooks/project instructions/context compaction сохраняют пользовательский
смысл по матрице. Отсутствующую настройку нельзя молча отбросить. Нужное поле
добавляется в provider-owned config adapter, а не в vendor-independent core.
Для реальной auth route проверяется её допустимость/работоспособность отдельно;
существующий login UI нельзя незаметно превратить только в API-key workflow.

Management сохраняет existing `RuntimeProviderManagementPort` отдельно от session
conversation: native executor заменяет fork CLI, login/status/launch используют
один selected profile. TEST isolation и production credential namespace различаются.
Effective settings, auth flow, compaction observation и native attachments
детализированы в [§9 протоколов](stage-1-contracts.md#9-config-auth-context-и-attachments).

Логи нормализуются с exact source/message/block/tool IDs; одинаковый текст разных
сообщений не схлопывается. Частичные/complete события одного блока не дублируются.
`isMeta`, internal blocks, chunks, subagent filtering, TaskRef и unknown usage
сохраняются. Недоказанная attribution остаётся unknown/gap. Фабрикация Claude
transcript/tool results/usage ради старого parser запрещена; adapters переводят
реальные observations в compatibility projections. Legacy archives read-only.

### 6.5 Restore и старые obligations

Restore только по explicit checkpoint/native session identity при совместимых
engine/config/account/workspace и подтверждённой custody прежней generation.
Нет `continue latest`, подмены endpoint hash или нового fresh session под видом
resume. Incompatible/missing checkpoint виден в UI. Продолжение с новым engine
может быть отдельным пользовательским действием с новым context/run binding.

Runtime сохраняет opaque checkpoint **в idle до close** под тем же session fence,
затем публикует durable reference; нативная history и private config/store binding
сохраняются отдельно от token. Crash между capture/write/publication и восстановление
после uncertain input описаны в
[checkpoint-протоколе](stage-1-contracts.md#5-checkpoint-и-положительный-restore).
Для каждого заявленного provider profile нужен успешный selected-session restore
после host restart; набор одних отказов missing/incompatible не закрывает M09.

Legacy recovery inventory читает launch/bootstrap/lane/session/stop/command records
без quarantine/repair. Corrupt/unreadable/incomplete census означает UNKNOWN/HOLD,
не пустой список. Старый `getAliveTeams()` после restart не доказательство terminal.
Оригинальные unresolved stop/request IDs сохраняются, shared hosts не убиваются.
Остановленная saved команда имеет явный путь Relaunch: validated product snapshot
в отдельный host-owned namespace и новый run, без native adoption и replay старых
inputs. Архив/receipts остаются исходному owner. Его границы и приёмка определены
в [offline relaunch](stage-1-contracts.md#явный-relaunch-остановленной-сохранённой-команды).

## 7. Фазы реализации

P0–P6 и dev E2E P8 — **in progress**; packed candidate P7 и итоговый handoff P8
ещё не приняты. Для P4 сохранены native mixed-team/restore/peer proofs, для P5/P6 —
scoped Electron Create/Launch/Resume/import/Changes и native Claude/Codex evidence.
Их точный scope и ограничения указаны в [матрице](compatibility-matrix.md).
Полный UI cutover, остальные сценарии и вся приёмка этапа остаются открытыми.
Для завершённой фазы фиксируются actual ref,
артефакт, выполненная проверка и конкретный acceptance, а не процент по LOC.

### P0. Зафиксировать source и недостающую совместимость

**Scope:** только affected source/artifact inventory и worktree setup.
Использовать [sources-and-reuse](sources-and-reuse.md); не повторять аудит всего
upstream и уже доказанные exact-byte тесты.

1. Выбрать committed frontend/provider/donor refs, проверить dirty diff. Явно
   зафиксировать включаемые owner patches; release dirty tree не включать.
2. Сопоставить M01–M19 с entrypoint, state writer/reader, известным oracle,
   provider capability и местом extraction. Для mixed modules перечислить только
   используемые transitive dependencies. Snapshot файла не доказывает авторство.
   Отдельно различить persistent teammates и обычные native subagents, а также
   solo DO/обзорные modes; не объявлять их взаимозаменяемыми.
3. Отметить уже готовые public provider exports/контракт/fixtures; отдельно gaps:
   native custody/config/MCP, checkpoint, context/usage/evidence, OS packaging.
   Выписать source→effective mapping settings/auth namespace и supported attachment
   MIME/model/recipient paths. Указать controller/MCP, Changes backfill, review,
   attachment и process-registry writers, не только CLI entrypoints.
   Включить queued-message list/discard и saved-team relaunch: первый переписывает
   inbox, второй обязан сохранить product data при новом execution owner.
   Включить trash/restore/permanent deletion и backup/reconcile/prune, включая
   member-work-sync restore. Внешние TaskRefs не переназначать imported team owner.
   Для M13 указать exact capture mechanism и необходимые before/final/attribution
   proofs; notification-only путь без anchors/chain не считать готовым capability.
4. Создать изолированные lanes и один integration root, записать их refs/owners.
   Команды будущих scripts отмечать planned, пока package реально не создан.

**Выход:** frozen selection manifest + заполненные source/oracle cells матрицы;
ни один используемый сценарий не остаётся «вне scope случайно».
**Не входит:** production rewrite, запуск на user project, новые ADR всех будущих ядер.

Один selection manifest содержит для каждого seam `sourceRef/path/blob`, нужный
symbol/use case, целевой module/owner, replacement port, M-ID и oracle. Рядом
фиксируются selected artifact digests, provider/Node profiles и известные gaps.
Это рабочие данные реализации; отдельный генератор inventory не требуется.

### P1. Замкнуть contracts/packages и один технический walking slice

**Зависит от:** P0. **Scope:** три границы §4 и package closure.

1. Создать legacy-host package и Desktop feature public port; существующий gateway
   переиспользовать только после проверки absence of future-engine dependency.
   Добавить package в `pnpm-workspace.yaml`, build/typecheck/test scopes и dist
   composition. Existing root scripts перечисляют workspaces явно и сами новый
   package не проверят. Host/API contract modules browser-safe; executor Node-only.
   Зафиксировать поставку standalone Node из §3: artifact/version/digest/resource
   path для selected tuple и включение в existing build staging. На user Node не опираться.
2. Привязать current provider SPI/exports и exact artifact. Снять dependency на
   source checkout/implementation нынешнего runtime; type-only import проверить
   внешним packed consumer. Выделить contracts artifact из §4.3 с compatibility
   re-export; не считать прежний install всего runtime достаточным proof.
3. Реализовать stdio host connection/handshake: protocol/build/capabilities,
   request bounds, safe failure, captured executable/profile, отдельные logs.
   Data overflow ведёт в gap/recovery; provider control/outcome progress не ждёт UI
   очереди. Snapshot/cursor handshake входит в тот же transport slice.
4. Пройти open → два inputs → text/tool/result → close на fixture driver и выбранном
   packed provider. Этот walking slice не является командной приёмкой.
5. Проверить достаточный capture mechanism выбранных provider profiles
   из [§10](stage-1-contracts.md#10-task-lifecycle-и-evidencereview) минимальным
   существующим fixture. Это ранняя проверка feasibility, а не весь P6 ledger/review.
   При отсутствии механизма пересмотреть этот seam до широкого P2/P3 extraction;
   сохранять условие M13 явно открытым, не добавлять fallback provider loop.

Минимальный consumer устанавливает host, D и contracts из tarballs в новый TEST
root. В lock/install/build closure нет `agent-execution` implementation, PG,
filesystem-custody engine или fork. Отдельный прежний consumer проверяет re-export;
изменение published peer/exports допускается только с owning package metadata.

**Выход:** package запускается без fork/runtime checkout и Electron globals;
контрактные unknown/error/control значения не сглаживаются в success. Поставка Node
определена; capture mechanism сохраняет observable M13 либо его seam исправлен
до допуска зависимого широкого переноса.
**Проверка:** strict build/consumer + существующие relevant session fixtures.
**Не входит:** full UI cutover, полный business store, новая generic transport platform.

Node profile выбирается по **пересечению** engines всего selected closure.
Исследованный D допускает Node24/26, а existing MCP package только Node24:
для совместного baseline применим `>=24.21.0 <25`. D-only Node26 PASS не доказывает
работу host/MCP на Node26. Смена диапазона требует owning package/test delta;
system Node пользователя не используется молча вместо captured executable.

### P2. Выделить командный owner и авторитетные tools

**Зависит от:** P1. **Scope:** Team/Task/Message stores/use cases/MCP, пока с
управляемым runtime port. Бизнес-правила сохраняются, storage redesign не совмещается.

1. Извлечь bootstrap/roster/task/mailbox/group/dependency use cases из выбранных
   donor/front-end paths. Убрать React/AppState/global session/ToolUseContext через
   small owned ports; SDK agent loop остаётся у official provider.
   Canonical Task policy брать из `agent-teams-controller` taskBoard/tasks/review/
   kanban; `TeamTaskWriter` только store helper. Process registry/background services
   сохранять отдельно от teammate readiness/custody.
   Bootstrap сохраняет expected roster/revision и individual outcomes из §4
   протоколов; completion не вычисляется только по созданным native sessions.
2. Дать каждому store одного writer. Desktop legacy mutations для host-owned
   handle направить в тот же host facade; откат routing не включает второй writer.
3. Реализовать shared MCP tool registration/legacy schema mapping, trusted actor,
   current grants, stable command outcomes и duplicate/conflict/partial-write
   recovery из §5 и [протокола команды](stage-1-contracts.md#3-команда-и-частичная-запись).
   Read-only tools не создают команду/сессию побочно. Task-create idempotency helper
   донора служит образцом deterministic IDs, не общей квитанцией всех mutations.
   Existing MCP `getController` — прямой файловый writer; заменить его injected
   handler ports/proxy для host-owned handles. Схемы сами по себе этого не меняют.
   Exact mapping и scoped connection описаны в
   [§8 протоколов](stage-1-contracts.md#8-mcp-и-полный-cutover-владельцев).
4. Сохранить product approvals, task assignment/dependencies/claim/comments,
   group/cross-team recipients, TaskRefs и review-facing facts. Новые модели
   будущего Orchestrator не копировать в этот legacy scope.
   Task/comment blob bytes и metadata имеют captured owner/storage binding;
   проверить partial write, read-after-restart и remove через existing adapters.
5. Подключить existing outbox startup/reconnect recovery с durable runtime admission
   ACK. Добавить targeted queued-message cancellation через Runtime port вместо
   inbox-only discard; P2 использует управляемый runtime adapter, P3 проверяет race
   с реальным dispatch. Business completed не завершает доставку.
6. Сохранить distinct trash/restore/permanent-delete policy и reuse existing
   identity-fenced helpers; backup/restore/prune — scoped owner adapters из §11.
   Product delete не удаляет единственное evidence unresolved runtime obligation.
   Restore missing product files согласуется с current completed outcomes/tombstones;
   устаревший backup не отменяет завершённую mutation и не вызывает её replay.

**Выход:** actual filesystem/stores fixture доказывает Team/Task/Message эффекты,
дубли, wrong actor/revoke и restart outcome; нет fake fixture-only Task handler.
**Не входит:** provider-specific spawn/queue, live user state, UI redesign.

### P3. Runtime owner без implementation нынешнего agent-runtime

**Зависит от:** P1; portable handlers из P2 подключаются через port.
**Scope:** sessions/input/control/state/custody, один выбранный driver сначала.

1. Извлечь применимые launch/config/lock/deadline/stop механизмы; сохранить
   ownership и resource scope. Не переносить in-process Claude task/AppState loop.
2. В existing technical state adapter добавить необходимые generation/input/
   fingerprint/claim/outcome facts до эффектов; один durable dispatch owner.
3. Соединить provider factories, bounded queue/read loop, independent interaction
   replies и control fence. Output progress привязан к exact session/input;
   session-level diagnostics без attribution не становятся Task activity.
   Подключить typed attachment references/native materialization, effective config
   и compaction observation. Text-only SPI не считается готовым attachment transport.
   Missing capability исправляется в D; host не дублирует native protocol.
   Readiness proof включает mandatory tools и invalidate/recover того же binding;
   queued input не обходит потерянную dependency, reconnect не подменяет proof.
4. Реализовать stop/drain/debt/restart reconcile/explicit restore. Unknown open,
   handoff и custody не вызывают повтор native create/submit/generation.
   Capture/persist/publish checkpoint делается до close; session/native backing
   сохраняет history после host restart. Положительный restore и crash в publication
   проверяются отдельно от missing/incompatible checkpoint.
   Unclaimed inputs получают terminal not-sent при stop/revoke/discard; cancellation
   tombstone также блокирует admission ещё не увиденного Runtime delivery ID.
5. Проверить две concurrent sessions: stop/control A не затрагивают B; retained
   state после host crash не приводит к speculative process adoption.

**Выход:** реальная owned technical persistence + packed driver проходят те же
важные session guarantees, включая lost receipt/no replay и selected restore.
**Не входит:** импорт нынешнего embedded Host/PG core, Task completion policy,
универсальный process supervisor или автоматическая смена runtime.

### P4. Полноценные несколько участников и три provider-пути

**Зависит от:** P2 + P3. **Scope:** соединённый headless team workflow.

1. Запустить один TEST team с A=Claude, B=Codex, C=OpenCode через
   authoritative MCP и localhost inference с actual SDK/CLI/protocol paths.
   Сначала пройти bootstrap transitions: initial context applied → member usable
   → aggregate ready по expected roster; не подставлять уже готовые fixture members.
2. Human → B → human, A↔B, B↔C, C↔A и group получают реальные recipient inputs
   и explicit ответы; проверить отсутствие lead relay/duplicates. Вторая host-owned
   TEST team с одним member нужна для разрешённого cross-team roundtrip.
3. Каждый из трёх providers получает Task, делает meaningful TEST effect, task update/comment и
   completion проходят owner policy. Wrong task/member/role/revoked session
   отвергаются handler, а не только mock permission callback.
4. Для выбранных Claude/Codex/OpenCode profiles подтвердить config/readiness и native
   permissions/questions. Недостающая возможность provider library реализуется
   один раз в D; private host adapter не дублирует её transport algorithm.
5. Проверить context/compaction/restart и shared OpenCode isolation на фактических
   профилях. Unsupported сохраняет безопасный отказ, но строку parity не закрывает.
   Actual compact→roster change→next input проходит один reminder owner. Native
   options/request подтверждают settings и поддерживаемые attachment paths;
   их наличие только в UI metadata недостаточно.
6. В solo DO выполнить обычный SDK subagent tool-call с дочерним TEST effect;
   передать parent/child provenance через provider-owned observation capability,
   проверить запрет в недопустимом mode и отсутствие невыданной Team authority.
   Control родителя закрывает его owned descendants, не других members.
7. В existing mixed-launch fixture проверить partial исход: A ready, B ждёт human
   permission дольше startup grace, C known failure до allocation. Scoped retry C
   не запускает A/B повторно; crash/restart сохраняет B obligation без оживления
   volatile callback и без speculative replacement. Детали — §4/§7 протоколов.

**Выход:** headless bootstrap/messaging/task/runtime части M01–M10 и необходимые
runtime части M13–M19 проходят actual host path; целые строки не объявляются
закрытыми до остальных product/UI acceptance P6/P8;
каждый provider имеет свой exact evidence tuple, а не чужой mock PASS.
**Не входит:** переключение production Desktop или real model/auth claim по dummy API.

### P5. Подключить существующий Desktop целиком

**Зависит от:** P4 для live workflows; mapping/fixture работа допускается раньше.
**Scope:** feature API routing, reads/feeds, user workflows и startup isolation.

1. Заменить CLI/bootstrap calls для выбранного нового owner на host API. В UI
   сохранять формы/канбан/диалоги; добавить только реально нужные статусы/ошибки.
   Уточнение владельца: переиспользуются существующие CreateTeamDialog,
   LaunchTeamDialog и Resume/relaunch controls со всеми текущими полями и
   сценариями. Отдельный урезанный Host UI не создаётся. Недостающую поддержку
   existing API/fields реализует backend adapter/owner; она не заменяется новой формой.
2. Сохранить target generations/command identities до dispatch и после restart;
   missing/offline target показывает connection state, не fallback в fork.
3. Направить live reads/log streams/task evidence/review/config в host projections.
   Отключить для этих handles старые filesystem/protocol readers и backend timers.
   Включить `ChangeExtractorService` backfill/repair, attachment stores и process
   health polling в sentinel cutover. Открытие Changes не запускает native repair.
4. Сохранить исходные archive/receipts read-only; active old-owner obligations имеют
   отдельные reconciliation/stop paths с исходными identities. Для stopped saved
   team выполнить explicit product snapshot import/relaunch из §6 протоколов:
   новый storage/run binding с retained TaskRefs/history, без shared writable root.
   Inventory UNKNOWN не допускает этот переход, broad cleanup или отмену recovery.
   В import map различить internal/external TaskRefs, включая encoded links;
   feature navigation несёт owner qualification. Backup startup/timers для этих
   roots также идут через host owner, legacy publication имеет sentinel.
5. Передать все явные settings/auth/skills/hooks/extensions действия в admitted
   adapter. Скрытие контролов или новый error вместо прежней функции не parity.
   Убрать fork executor из provider-management port; synthetic progress/code/cancel
   и status→session проверяют shared account/profile binding. Реальный OAuth
   остаётся qualification при наличии TEST account, не prerequisite fixture работ.
6. Переключить полный review mutation entrypoint: Apply/Reject, recovery, Undo/Redo,
   edited-file save/delete, rename restore и decisions/history; старый writer
   не остаётся активным из-за отдельного IPC channel. Background process UI читает
   host registry, scoped OS stop делегирует runtime adapter.
   Existing queued-message listing/discard идёт тому же owner; незавершённая
   доставка не скрывается удалением строки inbox. Snapshot/replay закрывает race
   mutation между чтением state и подключением feed.
7. Включить app Quit/Relaunch в existing shutdown coordination: captured host owner
   учитывает pending opens и active sessions, синхронно seals work/recovery ingress,
   сохраняет control/MCP до bounded cleanup. Legacy stop/kill fallback не обслуживает
   host-owned resources. Порядок и timeout/debt — §2 протоколов.

**Выход:** обычный Electron UI показывает/управляет host-owned командой при sentinel
старых CLI/readers; IPC и HTTP вызывают те же semantics, late feeds не меняют target.
**Не входит:** browser dev mode, native folder picker automation, переписывание
глобального Zustand store/старых сервисов ради новой структуры.

#### Подключение существующих Launch/Create/Resume форм

UI остаётся один. Для адаптации проверяется фактическая цепочка существующего
`LaunchTeamDialog`: hydrate → provider/model/workspace preflight →
`replaceMembers` → `launchTeam` → существующий provisioning progress.
Прямой `team.launch.start` в TEST setup проверяет backend, но эту цепочку не закрывает.

| Existing API / consumer                                 | Что должен дать Host adapter                                                                                                                               | Условие приёмки                                                                                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `getSavedRequest`, `getData`                            | Авторизованные settings, workspace и provider/model каждого captured member в existing DTO; metadata не берётся из legacy files/global defaults            | Существующий prefill сохраняет выбранные значения, включая `false`/off; поздний ответ не меняет текущий контекст                          |
| `prepareProvisioning`, project/provider/model checks    | Явный captured Team/default-owner context, проверка выбранной configuration/capabilities и actual required native evidence через provider-management ports | Нет fork preflight, speculative agent allocation или fabricated model/auth success; несовместимый параметр объясняется тем же existing UI |
| `replaceMembers`, member settings                       | Authoritative roster use case с исходной revision/intent и policy, включая workspaces/instructions/MCP settings                                            | Нет renderer-owned roster writer; смена состава не теряет product data и не дублирует работающих members                                  |
| `launchTeam`, `createTeam`, `createConfig`              | Полный used request mapping в Team/Runtime owners, stable command до dispatch; unbound create захватывает backend до effects                               | Все сохранённые поля имеют effective mapping; UNKNOWN не создаёт повторный intent, capability gap остаётся незакрытым acceptance          |
| `getProvisioningStatus`, existing progress subscription | Owner-qualified application run identity и правдивые individual/aggregate outcomes, source timestamps, reconnect/read path                                 | Нет lookup по совпавшему legacy имени, invented PID/ready либо отката progress поздним ответом                                            |
| Existing Resume/relaunch controls                       | Explicit selected checkpoint/new run semantics и сохранённые settings/history через того же owner                                                          | Обычный dialog/control выполняет restore; API-only proof не закрывает UI acceptance                                                       |

E2E идёт через обычные controls этих компонентов: выбор проекта/provider/model,
настройки участников и advanced options → preflight → ровно один submit →
видимый progress → сообщения/задачи → stop/selected resume. TEST API допускается
для изолированного staging/диагностики; actual launch/create/resume в приёмке
диалога выполняется его существующей кнопкой. Неизвестный outcome проверяется
чтением исходного intent, без повторного клика. Новая сокращённая форма не
является допустимым ускорением этих шагов.
Автоматизация использует Electron `pnpm dev:mcp` и renderer CDP; не создаёт
тестовую замену диалога. Сохранённые значения проверяются повторным открытием
того же диалога после reload. Ошибки валидации, отмена и отказ backend проверяются
через существующие controls, с сохранением введённых пользователем значений
при исправимой ошибке.

Приёмка существующих диалогов фиксируется раздельно:

- **Create:** открыть существующий `CreateTeamDialog` штатной кнопкой, заполнить
  состав и настройки, создать команду и проверить сохранённый состав после reload.
  Если выбран запуск при создании, его progress и native allocation также проверяются.
- **Launch:** открыть существующий `LaunchTeamDialog` из сохранённой команды,
  проверить prefill, изменить параметры и запустить штатной кнопкой. Проверить
  effective configuration в Host и наблюдаемые native параметры, затем сообщение,
  задачу, ответ и остановку через существующие controls.
- **Resume/relaunch:** использовать существующий control и его диалог; проверить
  выбранную историю, новую generation и сохранение настроек. Для fresh relaunch
  проверить новую историю согласно прежнему сценарию, без скрытого resume.

Для каждого используемого поля проверяется путь значение формы → request →
сохранённое решение owner → effective запуск/поведение. Одной видимой галочки,
успешного mock handler или появления окна недостаточно. Не требуется полный
перебор комбинаций: сохраняется покрытие существенных режимов из матрицы и
проверяется риск потери/игнорирования настроек. Без Claude TEST-доступа actual
SDK/CLI работает с локальным fixture API; результат явно отделяется от проверки
реального vendor API/auth. Это не отменяет полноценные команды, задачи и сообщения.

Обычный Launch передаёт исходный подтверждённый roster command в
`team.launch.capture`, затем запускает полученный run с исходным launch command.
Capture использует сохранённые Team settings и private provider recipes; desktop
не передаёт executable, account или environment. Регистрация новых bindings/grants
атомарна в прежнем Team owner state, source хранится в существующей launch record.
Запись capture не запускает native agent. Current capture определяется также по
launch ID: одинаковая версия настроек не даёт предыдущему run снова стать текущим.
Исторические reads выбирают исходный run/generation и не разрешают старые controls.

При retry существующего Relaunch сохраняются исходный run ID, member-settings
baseline и подтверждённые шаги. Stop адресуется этому run через существующий
`cancelProvisioning(runId)`. После подтверждённого roster save потеря launch ACK
не повторяет stop/save и не останавливает новую команду. Неопределённый roster save
восстанавливается с прежними command/payload у того же owner; обновлённые UI tokens
не подменяют исходный baseline. Continuation остаётся локальным состоянием прежнего
диалога и не сериализуется в roster DTO. Это не новый journal или lifecycle owner.

Первоначальный compiler требует private recipe каждого выбранного участника и
провайдера. Отказы для новых участников, неподключённого backend, worktree/custom
args и дополнительных MCP policies остаются открытой реализацией этапа 1, а не
сужением матрицы. Положительный API/controlled-provider proof этих границ не
закрывает actual SDK или Electron dialog E2E.

### P6. Change evidence, review и user-visible parity

**Зависит от:** P4 + нужные P5 reads. **Scope:** M11–M15 и оставшиеся сценарии матрицы.

1. Извлечь Git capture/task attribution/review/apply use cases. Сохранить task/run/
   workspace/window attribution, исходные bytes, conflict и interrupted apply.
   Использовать проверенный в P1 capture path: hooks либо anchored window/native
   change chain с доказанными before/final bytes и timeline/outcomes. Новый preimage
   перед tool effect ожидается только там, где его требует выбранный механизм.
   Final capture учитывает hooks/failed/background effects; недоказанное имеет gap.
   Fork globals заменить immutable binding; один turn-end diff не даёт attribution.
2. Подключить context usage, private/internal messages, chunks/subagents/task logs,
   edits/commands и structured references без синтетических success observations.
   Реальный P4 subagent виден как child родителя; фильтры не теряют его output
   и не присваивают его другому teammate/task. Архивного fixture display недостаточно.
3. Закрыть оставшиеся реальными сценариями: add/remove/restart member, solo→team,
   failed launch/retry, task review/reopen/dependencies, notification/action paths.
   Task completion/review/needsFix/approve с cascade notifications проверяются
   отдельно от file Reject→Undo/Redo и stale snapshot/revision refusal. Детали и
   конкретный failed-tool capture proof заданы в
   [§10 протоколов](stage-1-contracts.md#10-task-lifecycle-и-evidencereview).
   Тот же review workflow включает positive mixed-hunk Apply и сохранность exact
   bytes/decisions/history после reconnect и host restart.
   Existing lifecycle/backup suites закрывают trash при UNKNOWN stop, restore без
   dispatch и interrupted identity-fenced purge; Electron проверяет видимые действия.
4. Сопоставить M01–M19 с proof на host path; missing observation требует driver/
   projection доработки. Нельзя считать «UI не упал» доказательством корректности.

**Выход:** ни один обязательный пользовательский сценарий не подменён unavailable
или legacy fallback. Ограничения конкретного real-provider/OS tuple видны отдельно.
**Не входит:** новый Work evaluation lifecycle или новые продуктовые функции.

### P7. Packed candidate без fork executable

**Зависит от:** P5 + P6. **Scope:** packaging/bootstrap и воспроизводимый install.

1. Убрать обязательное download/stage/probe/import fork из candidate dev/dist
   пути. Official SDK/CLI binaries выбираются по exact artifacts; generic terminal
   platform packaging не меняется попутно.
2. Собрать clean external consumer/desktop candidate без sibling repos и старого
   CLI. Проверить host executable/Node version, native modules, SDK resolution,
   ASAR/path spaces, stdio purity, exit/drain и config location.
   Системный Node сделать недоступным для harness; resolved Node должен быть
   candidate-owned artifact из §3 с ожидаемым digest и executable permissions.
3. Проверить repo-supported OS/architecture tuples существующей packaging matrix;
   unsupported tuple не становится supported от успеха на macOS.
4. Сохранённый rollback artifact не является активной dependency. Ветки с активными
   old-owned runs сохраняют explicit compatibility control до их завершения.
5. На actual packed Electron artifact выполнить короткий TEST workflow:
   startup → host ready → input → targeted control → close с недоступным fork.
   Записать digest artifact и resolved host/Node/provider paths. Он проверяет
   packaged bytes/ASAR; полный dev UI suite повторять на каждом OS tuple не нужно.

**Выход:** candidate install не требует executable форка ни при startup, ни при
host-owned user actions; release/signing/publication ещё не выполняются. Наличие
ещё активного explicit old-owner compatibility пути описывается отдельно и
запрещает заявление, что весь установленный продукт уже глобально отказался от форка.

### P8. Интеграционный E2E, review и handoff

**Зависит от:** P5 + P6 для dev E2E/affected gates. Они могут идти параллельно P7
на согласованных source refs/provider artifacts. Итоговый review/handoff candidate
требует результатов обоих P7/P8; короткий installed workflow доказывается только P7.

1. Запустить один развиваемый harness в integration worktree: normal Electron
   `pnpm dev:mcp` + реальный legacy-host + packed provider + localhost inference.
   Проверить пользовательские workflows матрицы, а не прямые store calls вместо UI.
2. На том же ownership path воспроизвести restart/response-loss/control/revoke
   failures, проверить no duplicate effects и narrow cleanup. Fault fixtures не
   дублируются на каждом слое без отдельного проверяемого риска.
   App Quit/Relaunch проходит новый owner path без recovery при shutdown; следующий
   startup не оживляет очередь и сохраняет unresolved debt. Headless order/timeouts
   проверяются existing shutdown suites, Electron подтверждает фактическое wiring.
3. Выполнить required gates затронутых repos на выбранных final refs. Раздельно
   сохранить build/test, synthetic native integration, real auth и OS qualification.
4. Провести содержательное review final diff и remaining gaps. При существенном
   риске использовать отдельного доступного reviewer; self-review не называть
   независимым. Исправления проверять на affected boundaries.
5. Зафиксировать `candidate`, exact refs/artifacts, M01–M19, cleanup и известные
   ограничения. Не merge/publish/activate; следующий шаг — решение о доставке.

Конкретные F01–F09 из [протоколов](stage-1-contracts.md#7-фокусные-проверки-отказов)
выполняются на ближайшей meaningful boundary. В Electron повторяются routing,
reconnect и видимые состояния, а не вся headless fault suite.
Acceptance из §8–§11 дополняет эти fault probes существующими product workflows;
новых harness/CI gates для каждого пункта не требуется.

**Выход:** проверенный и reviewable candidate. Без real Claude access возможен
`candidate-synthetic` с end-to-end PASS, но production auth qualification остаётся недоказанной.
Полная реальная доступность продукта не заявляется на основании dummy credentials.

## 8. Параллельность без пересечений

P0 → P1; затем P2 и P3 допускают разные owners. P4 соединяет их. P5 projections
можно готовить на recorded fixtures параллельно P3/P4. P6 evidence ведётся отдельно
с явными ports; после P5/P6 dev E2E P8 и packaging P7 могут идти параллельно.
Final candidate связывает результаты с одной выбранной source/artifact composition;
relevant delta требует только affected перепроверки. Package manifest, общие
contracts/composition и shared policy имеют одного назначенного writer.

Большая фаза разбивается на reviewable coherent checkpoints, ориентир около
2k handwritten changed LOC без generated/lockfile частей. До решения о доставке
это локальные ветки/checkpoints; открытие/merge серии PR не prerequisite работы.
Нельзя дробить один atomicity/authority invariant между несовместимыми commits.

## 9. Проверки: минимальная достаточная схема

| Граница                        | Когда проверяется                           | Что ловит                                                                     |
| ------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------- |
| SPI + external packed consumer | P1 и после relevant contract/package change | Скрытая runtime/fork dependency, неверный public export, Node incompatibility |
| Team store/MCP integration     | P2; affected изменения                      | Duplicate/conflict/partial commit, wrong actor/revoke, recipients/task refs   |
| Runtime/provider suite         | P3/P4; affected control/recovery change     | Unknown replay, очередь/control, поздний interrupt, ложный stop/restore       |
| Actual TEST Git evidence       | P6                                          | Неверная attribution, потеря changes/review, конфликт apply                   |
| Electron UI E2E                | P5 smoke, P8 итоговая композиция            | IPC/read-side/owner drift, legacy fallback, неверные user actions             |
| Packed OS candidate            | P7                                          | Bootstrap/ASAR/native binary/config/path и отсутствующий fork                 |
| Required repo gates            | На final candidate/ref                      | Обязательные types/lint/build/tests/architecture, без ослабления policy       |

Frontend TypeScript: `pnpm lint:fast:files -- <changed-files>`, `pnpm typecheck`,
focused tests и затронутые source-size/provisioning guards. Итоговый broad gate
следует реальному `package.json` выбранного baseline. Новые host/package scripts
добавляются и проверяются в P1; их имена не выдаются за уже существующие команды.
Новые Node harness/helpers пишутся на TS/MTS с meaningful strict typecheck.

Успешные exact-byte проверки переиспользуются. Повтор нужен после relevant delta,
новой finding или изменения environment; один final exact-ref CI остаётся
обязательным при будущей доставке. Для изменения только этих документов достаточно
проверки ссылок/примеров/diff, запуск native agents и полного app suite не нужен.

## 10. Definition of done и условия пересмотра

- [ ] M01–M19 имеют actual acceptance на новом host path и exact provider tuples;
      synthetic compatibility и real auth/OS qualification отмечены раздельно.
- [ ] Provider library имеет одну редактируемую реализацию; fork и нынешний runtime
      implementation отсутствуют в её требуемой runtime/build closure.
- [ ] Team/runtime mutations имеют одного owner, UNKNOWN не replay, old runs не adopted.
- [ ] Старый UI проходит команды, задачи, сообщения, approvals, logs/review/config
      без активного CLI/readers форка; archive и old obligations сохранены отдельно.
- [ ] Packed candidate и заявляемые OS tuples проверены; credentials не использовались
      из user profile, cleanup закрыт или явно отражён как unresolved debt.
- [ ] Review completed, существенных unresolved findings нет; доставка не выполнена.

`candidate-synthetic` достаточен для review и дальнейших разрешённых fixture работ,
но не является `release-qualified`. Непроверенные real auth/OS/active-old-owner
условия остаются открытыми до решения о production delivery. Они не требуют
повторять успешные mock/native-local сценарии без relevant изменений.

Если перенос требует утащить QueryEngine/AppState или вторую полную provider
реализацию, пересматривается конкретный seam/оценка до его переноса. Если нужен
новый business feature вместо сохранения старого, он выделяется из этапа 1.
Нужная существующая capability при этом не удаляется из матрицы молча.
