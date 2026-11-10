# Источники, уже сделанное и границы reuse

Навигация: [программа](README.md) · [P0](stage-1-legacy-host.md#p0-зафиксировать-source-и-недостающую-совместимость).

Это source map для начала этапа 1. Ни один перечисленный dirty checkout не является
автоматически выбранной поставкой. Перед переносом P0 фиксирует точные Git blobs,
imports closure, relevant tests и artifact digest. Accepted ADR других repos
не изменяются этим frontend-планом.

## 1. Frozen donor и наблюдаемые seams

Fork inventory ниже привязан к commit
`969afc56ec39d92c33dd5aabd15ef782da94dd87`, baseline upstream
`38c09970c2925bb36a340c546ac53229f3d7bda5`. Локально наблюдался более поздний HEAD
`3bf24764f25dfd7588b9c8b23748fa0891fd85df` и dirty edits. Новые изменения из него
требуют отдельного inclusion decision; эти цифры их не описывают.

Подсчёт `git ls-tree` + `git show` выбранного ref, физические production TS/TSX
строки без test/spec/fixtures. Это размеры исходников, не объём будущих изменений,
не доказательство авторства и не готовая переносимая closure.

| Донор                                                                         | Files / physical LOC | Disposition первого этапа                                                                                     |
| ----------------------------------------------------------------------------- | -------------------: | ------------------------------------------------------------------------------------------------------------- |
| `src/services/teamBootstrap`                                                  |           21 / 4 327 | Извлечь нужные workflow/state/guards в Team; отделить ToolUseContext/global session/spawn                     |
| `src/services/agentTeams`                                                     |            6 / 1 147 | Разделить product store/config и adapter/composition; не переносить как второй runtime manager                |
| `src/services/boardTaskActivity`                                              |            6 / 1 537 | Product activity у Team, technical event capture у runtime/provider                                           |
| `src/services/taskChangeLedger`                                               |            4 / 4 155 | Reuse Git capture, отдельно task attribution/review authority                                                 |
| `src/services/codexNative`                                                    |           20 / 5 972 | Сопоставить с уже выделенным driver; не копировать вторую app-server реализацию                               |
| `src/services/opencode`                                                       |         145 / 50 922 | Выбирать нужные механизмы/config/custody/recovery; существующий D покрывает только выбранные кластеры         |
| `src/utils/swarm`                                                             |          25 / 10 347 | Разделить process/control/identity и Claude in-process dependencies; весь каталог не является runtime library |
| TeamCreate/TeamDelete/SendMessage/TaskCreate/Update/Get/List tool directories |           24 / 2 579 | Извлечь use cases/schema semantics; renderTool/buildTool/Claude state заменить MCP boundary                   |

Отдельные mixed files: `useInboxPoller.ts` — 4 649 строк;
`spawnMultiAgent.ts` — 3 580; `tasks.ts` — 864;
`teammateMailbox.ts` — 2 039; `groupMailbox.ts` — 272.
Они используют React/AppState, bootstrap globals, task types и внутренние tool
registries. Перенос без seam замены снова потянет Claude engine.
Эти числа не следует суммировать с общей оценкой как независимые work packages.

Исходный [Codex manifest](../runtime-provider-extraction-source-manifest.json)
остаётся неизменённым inventory, а не manifest всего legacy-host. Новый selection
manifest ведётся рядом с реализацией и дополнительно фиксирует целевой module,
source blob/hash, replacement port и existing oracle для каждого выбранного seam.

## 2. Frontend oracle и release isolation

Исследованный committed baseline: `07e7d8e0d44f4a3999e2693dfa2986d6b3819403`.
Original checkout содержит активные release/feature edits; они не включаются в
worktree этой документации и не выбираются production baseline автоматически.

Ключевые места для P0:

- `src/main/services/team/provisioning/*`: launch/member/runtime flows; сохранять
  thin facade и composition по нормативному provisioning standard.
- `TeamDataService`, `TeamTaskReader/Writer`, `TeamInboxReader/Writer`,
  `TeamMessageFeedService`: существующие data ownership, TaskRef и message semantics.
- `mcp-server` и `agent-teams-controller`: пригодные schemas, trusted identity и
  handlers; сравнить реальные writers, не добавить второй MCP storage engine.
- `src/features/member-log-stream`, task-change/review/context/usage features:
  source attribution и presentation oracle, а не причина синтезировать transcripts.
- `src/features/team-runtime-recovery`, OpenCode bridge/lanes/stop records:
  persisted obligations; mutating quarantine readers не подходят read-only census.
- `scripts/dev-with-runtime.mjs`, staging/dist scripts и provider management:
  скрытые executable probes/import/download/config dependencies до первого prompt.

Подготовленные ранее worktrees frontend boundary/N1/N2 — donors после review их
конкретного patch и ownership; целиком не cherry-pick. Новая программа не признаёт
старые singleton UI proofs доказательством полной совместимости.

## 3. Provider package: reuse без повторного написания

Наблюдаемый package: `@agent-teams/provider-implementations`, workspace path
`packages/platform/provider-implementations`; public exports root/composition,
`claude`, `codex`, `opencode`, `session-io`. Архитектурное размещение принято
runtime ADR-0092; перемещение пакета в другой repo не является шагом этого плана.

Ранее квалифицированный initial archive SHA256:
`3d547879a7ea0d5af48dccec285e8c6afca3eddde13a4a77ab15588650db0e8d`.
Зафиксированы Node24/26 strict/packed, 137 behavioral checks и 24 SDK/CLI localhost
проверки. Это evidence выбранных bytes, не native parity всей библиотеки/host.

Отдельные successor proofs:

- Codex D archive `01f97cae091297d31ee834e4bb92b74aab67f9e577792a52aadd9dfc93c735ff`:
  actual Codex 0.162.0 + public C + real TEST PostgreSQL + local Responses/MCP;
  пять POST, targeted interrupt, deny→native cancel→cancelled, MCP once, cleanup.
- OpenCode D archive `d1e99f5336bddc1e79f84aec71f9e8154eb2c3d8827a37f3b82cfe22a457aba4`:
  actual OpenCode 1.18.35, две processes, A1/A2/B1/stopA/B2, четыре local model POST.
  Это не proof публичного C Host/MCP/cross-backing restore для OpenCode.

Это разные archives с разными patches, не один уже объединённый qualified release.
P0 выбирает один coherent source/artifact, integrating only reviewed deltas, и
повторяет только недоказанные affected checks. Временные локальные receipt paths
сохранены в [исторической матрице](../runtime-provider-extraction-capabilities.md);
нужные для delivery proof должны стать восстанавливаемыми version-bound artifacts,
а не prerequisite существования чужого `/tmp`.

## 4. Подтверждённые gaps для реализации

Это результат source review, не новый выполненный native proof. Frontend paths
относятся к `07e7d8e0`; provider paths — к исследованному D worktree. P0 закрепляет
их фактические blob IDs в selected manifest, прежде чем использовать как donor.

| Gap и source seam                                                                         | Почему нельзя считать готовым                                                                                | Минимальный scope                                                                                      |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| D `tests/package/install-consumer.ts`, package peers                                      | Packed consumer ставит весь `agent-execution` + custody; erased type imports не замыкают independent install | P1: один contracts artifact, старый re-export, clean minimal consumer                                  |
| D Claude `config.ts`, `session.ts`; frontend `TeamProvisioningPromptBuilders.ts`          | D запрещает все Agent tools и отбрасывает child correlation, а frontend разрешает ordinary Agent в solo DO   | P4/P6: execution gate, parent/child provenance/custody, actual child scenario; без native Team writers |
| D Claude/Codex `Session.checkpoint()`, factory `readCheckpoint`, Claude `open-session.ts` | Idle-only token и `sessionExists` требуют runtime-owned durable publication и native history                 | P3/P4: capture до close, retain store, positive selected restore, publication crash                    |
| Frontend `ApplicationCommandRunner.ts`, `workerOps.ts`                                    | Stale Started/reconcile и completed replay могут идти вне обычного handler                                   | P2: общий authority/resource fence, проверка replay, отсутствие позднего original writer перед retry   |
| Frontend `mcp-server/src/utils/taskCreationIdempotency.ts`                                | Только task.create; optional key оставляет прямой новый create                                               | P2: mandatory command identity + outcomes остальных mutations, reuse deterministic IDs                 |
| Frontend `JsonRpcStdioClient.ts`                                                          | Unbounded readline, short session lifecycle/force-close, `@main` imports                                     | P1: narrow primitive reuse + bounded host transport; не менять shared Codex client попутно             |

Дополнительно подтверждены используемые product seams:

| Source seam                                                                                                   | Нужное изменение плана                                                                                                           | Owner / фаза                                  |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `mcp-server/controller.ts` и `taskTools/messageTools`; `AgentTeamsMcpHttpServer`                              | Direct controller writer заменяется injected host handlers; scoped MCP principal и stable mutation IDs                           | Team/MCP; P2/P5                               |
| `TeamProvisioningStreamEvents` + `IdlePromptInjection`; D `normalize.ts`                                      | Compact event сейчас теряется; нужен observation + один актуальный Team reminder через admission                                 | D + Team/Runtime; P3/P4                       |
| `RuntimeProviderManagementPort` + `AgentTeamsRuntimeProviderManagementCliClient`; `EnvBuilder`; D `config.ts` | Fork management executor и несовместимый default CLAUDE_CONFIG_DIR namespace; native management adapter с тем же account binding | Management adapter; P3/P5                     |
| `TeamLaunchRequest`, frontend extension builders; D `options`/PreToolUse hook                                 | Effective effort/permission/context/settings и composition hooks не следуют из UI metadata                                       | Private provider adapter; P3/P4               |
| Frontend `agent-attachments` adapters; D text-only `Input.content`/submit                                     | Нужны typed artifact references и native parts; сохранять existing recipient/MIME restrictions                                   | Host artifacts + D; P3/P4                     |
| `taskBoard/tasks/review/kanban/taskLifecycle`; `TeamTaskAttachmentStore` и attachment IPC                     | Product lifecycle/notifications и отдельный appData blob writer шире Task CRUD                                                   | Team; P2/P6                                   |
| Fork `toolExecution.ts`, `TaskChangeLedgerService`; frontend `ChangeExtractorService`, `review.ts`            | Pre/post/failure/background capture требует нового seam без globals; backfill-read и все review writers должны перейти owner     | Runtime capture + Team evidence/review; P5/P6 |
| `processTools/processStore`, `TeamDataService.processHealthTick/killProcess`, `ProcessesSection`              | Registry и scoped OS stop используются UI; это отдельный M19, не agent liveness                                                  | Team registry + runtime OS port; P2/P5/P6     |
| `src/main/ipc/teams.ts:4404`, `teams/teamQueuedUserMessages.ts:197`                                           | Inbox-only discard не отменяет новый durable delivery/input; exact listed IDs и late arrivals должны сохраняться                 | Team cancellation + Runtime fence; P2/P3/P5   |
| `TeamDetailView.tsx:2174`, `dialogs/teamRelaunchFlow.ts`                                                      | Existing Relaunch шире archive reading; stopped saved team должен запускаться без fork с сохранёнными product data               | Team offline import/new run + Desktop; P5     |
| `TeamMcpConfigBuilder.ts:551`, root `package.json` extraResources                                             | Existing bootstrap использует Electron-as-Node, standalone Node для нового host пока не поставляется                             | Node artifact composition/staging; P1/P7      |
| `teamSoftDeleteFlow`, `TeamMemberRestorePlan`, controller `tasks.js`, `permanent-deletion/*`                  | Trash, restore и permanent purge имеют разные guards/targets; общий delete теряет debt или восстанавливает старую authority      | Team lifecycle + existing IO adapters; P2/P6  |
| `TeamBackupService.ts:171–180`, `TeamBackupRestoreService.ts`, member-work-sync restore                       | Startup restore/reconcile/prune — отдельные writers; runtime files в backup не дают права на execution                           | Team-scoped backup adapter/cutover; P2/P5     |
| `src/main/index.ts:1281,3051`, `TeamProvisioningShutdownCoordination.ts`                                      | Quit/Relaunch останавливает прежние registries; новый host/pending opens должны войти в shutdown без recovery/чужого kill        | Desktop composition + Runtime cleanup; P5/P8  |
| `shared/types/teamBoardTask.ts`, `renderer/utils/taskReferenceUtils.ts`, `useTaskSuggestions.ts`              | TaskRefs/encoded links не имеют backend identity и бывают cross-team; blanket import rebinding направляет их не тому owner       | Import map + feature navigation; P1/P5        |

Дополнительный read-only осмотр provider source привязан к clean package files
commit `7805dbf49d298f21bbb489faa99fe79a1116c17a`, не к новому qualified artifact.
Codex item notifications и OpenCode turn snapshots сами не доказывают полный M13;
Claude tool-binding PreToolUse — частичный seam, не весь final/background capture.

Повторное сравнение с frozen donor уточняет **требуемую parity**, не только форму SPI:
`src/services/tools/toolExecution.ts:1265` ожидает capture перед tool, но
`TaskChangeLedgerService.ts:3373` возвращает null при capture failure, сохраняя
обычное выполнение. Summary использует первый before/последний after.
`OpenCodeLedgerBridgeService.ts:737` использует authored toolpart anchors и native
snapshot windows; `OpenCodeToolpartChangeReconstructor.ts:375` запрещает snapshot-only
authorship. Frontend review проверяет bytes/hash/conflicts, не наличие конкретного
callback. Поэтому P1 квалифицирует достаточный hook/window/native-chain mechanism;
универсальный awaited per-tool barrier и запрет tool при capture failure не являются
унаследованным требованием. Недоказанные changes остаются gap/nonreviewable. Чтение
source не заменяет native proof выбранного profile.

Claude `session.checkReadiness` проверяет native MCP status/tools; Codex/OpenCode
опираются на injected probe. Поэтому новый host adapter обязан подтвердить exact
required-tool set и invalidation, а не считать boolean probe достаточным сам по себе.

Проектные guards и OS profiles проверяются на selected baseline. Например,
Unix-only проверки абсолютного пути в provider config не доказывают Windows
support; P0/P7 должны сопоставить такой код с реально заявляемой packaging matrix.
Эти gaps входят в существующие work packages оценки, не суммируются повторно.
Уточнения delivery recovery, transport pressure, feed handoff и queue cancellation
конкретизируют уже оценённые Team/Runtime/Desktop части. Offline relaunch использует
legacy product formats и scoped snapshot import; generic live migration не оценена
и не добавляется. После P0/P1 фактическая closure может изменить диапазон, но число
страниц плана само по себе не является основанием пересчитать LOC.
Node staging относится к packaging/composition, lifecycle/backup — к Team adapters,
owner qualification refs — к Desktop/import. Эти изменения включаются в selected
closure и пересчёт P0/P1; перенос existing helpers не считается новым engine.
Диапазон 15–25k предполагает доступный native capture mechanism. Если P1 его не
подтвердит, цена и конкретный capture seam пересматриваются до широкого extraction.
Здесь «доступный» означает достаточный для before/final/attribution/review guards,
а не обязательно synchronous per-tool interception. Bootstrap/partial outcomes
входят в существующие Team/Runtime work packages, нового launch manager нет.

## 5. Что делать с нынешним runtime и новым Orchestrator

Runtime C delivered checkpoint `8d89b28f07426846b3ded7c6bd933363d9dc468c`
содержит пригодные session/input/control/custody contracts и rejecting tests.
Они могут служить oracle и source donor по собственным правилам repo. Этап 1
не зависит от его PG implementation, Assembly или embedded Host.

Старые B/C evidence, E singleton integration, N1 roster/direct delivery и N2 Work
разработки сохраняются в прежних worktrees. Полезные отдельные решения/fixtures
reuse после mapping на legacy semantics; unfinished future-core code не становится
обязательным prerequisite legacy-host. Ранее доставленные commits не откатываются.

Публикации tooling/Foundation и native governance остаются результатами тех
репозиториев, а не новым gate этого плана. Для изменений D соблюдаются реальные
scoped package/architecture gates; их нельзя обходить ни копированием source,
ни переименованием legacy-host в fixture.
