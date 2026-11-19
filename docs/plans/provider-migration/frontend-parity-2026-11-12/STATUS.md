# Завершение Host / frontend parity

Обновлено: **19 ноября 2026**. Единственный текущий рабочий план.

**Текущее продолжение:** владелец выбрал P09 **A** — исходный путь с доверием всем
writers выбранной ревизии до завершения её использования. [Принятый контракт](40-p09-source-writer-decision-2026-11-16.md)
зафиксирован. Срез source/native acceptance реализован и прошёл независимый R2;
[проверки, точные hashes и исправленные замечания](evidence/p09-contract-a-review-20261119.json)
сохранены отдельно от ещё не полученного native PASS. На завершившихся source/GUI
jobs `33ea959ad1b2496ab393e04fa50e610e092224ec` подтверждены новые PASS и точные
границы оставшихся отказов. В снимке17:55:56UTC running=0, пять jobs queued;
их очередь не является отказом или PASS. Следующий настоящий source update
включает A и два независимо проверенных исправления ниже, без ручных CI actions.

**Текущий проверенный срез поверх A:**

- Default launch authority удерживает один исходный Team lock на прежние
  синхронные execution/control/revision checks. Реальный путь
  createRuntimeTeamLaunch → startMember → RuntimeOwner.openSession воспроизводил
  две physical publications; теперь одна, все исходные проверки сохранены.
  18/18 regressions, TS7 Host build/test types, lint, source guard и R2 PASS.
- Retained scope больше не принимает публикацию Main-owned
  `CLAUDE_TEAM_CONTROL_URL` за смену account/runtime. Исключено только это поле
  из трёх ambient process identity сравнений; frozen child environment,
  shell/config/account/PATH/executable guards сохранены. Два RED cases через
  настоящий publisher сменились33/33 PASS; scoped TS7 и R2 PASS.

[Точные diff hashes, RED/GREEN и границы](evidence/parity-retained-authority-fixes-20261119.json)
и [журналы](evidence/parity-retained-authority-checks-20261119.tar.gz) привязаны к
четырём изменённым файлам. Windows readiness и original retained Desktop должны
дать собственный результат; локальный PASS не подменяет эти проверки.

A опубликован на checkpoint `f6c223c9f83224218214e6c79643588a3369e3ba`.
[Исходная локальная Linux-попытка](evidence/p09-contract-a-local-linux-20261119.json)
на чистом source и pinned Node24.21.0 завершилась exit1: plain control PASS,
затем PTRACE_TRACEME вернул EPERM на `trace-initial`. Original children/group
подтверждённо очищены; до восьми product rows выполнение не дошло. Общий receipt
INCOMPLETE. Изменения oracle, привилегий, budgets и повторный запуск не применялись;
native qualification остаётся задачей штатных CI runners.

[Свежий33 Team gate](https://github.com/777genius/agent-teams-ai/actions/runs/44565800673/job/135707276069)
прошёл полный workspace typecheck, исходные typed-lint scopes, Runtime/Team
contracts и Team UI. [Taskboard](https://github.com/777genius/agent-teams-ai/actions/runs/44565800673/job/135707275138)
также PASS. [Точные jobs, artifact digests и Windows ARM audit](evidence/ci33-incremental-20261119.json)
отделяют эти выполненные результаты от остальных gates. Все4 frontend shards,
cross-team, три POSIX process architectures и native V2 Linux/Windows x64/ARM64
также PASS. Darwin V2 Quit во время открытия прошёл original journey и cold
readback. Retained, Membership, Darwin Review/Resume/active Quit и Windows source
readiness остаются открыты; их оригинальные failures и cleanup сохранены.

**Полная E2E-приёмка ещё не завершена.** Stop-fix опубликован в
`960ed53c88e664c45a9fe0cc3d054ea83ae50dd3`. В этом срезе исправлены сохранённые
настройки retained original, начальную папку его private selector, гонку TEST
process census и выявленные code gates. [Evidence и source hashes](evidence/parity-fixes-20261119.json)
отделяют исходные отказы, целевые PASS и ещё не выполненные native проверки.
[Журналы и точные compiler configs](evidence/parity-fixes-20261119-logs.tar.gz)
содержат воспроизводимые входы и manifest размеров/SHA-256.

Проверено локально: восемь исходных Stop regressions, шесть WorkSync ordering
cases, восемь facade guards, одиннадцать owner-hydration cases, оба OpenCode
transfer сценария, шесть source-readiness/projection cases и process-census test
с десятью внутренними вариантами. Независимый R2 — PASS. Typed lint затронутых
файлов: 0 errors, 36 warnings; source-size и provisioning architecture guards PASS.
Исходные deadlines, authority/custody проверки и отрицательные outcomes сохранены.

Полный workspace compiler дважды завершился exit137 без TS-diagnostics.
Повтор того же канонического TS7 command ограничивал только память и параллелизм
compiler (`GOMEMLIMIT=4GiB`, `GOMAXPROCS=2`); исходные проекты и compiler options
не изменены. Это INCOMPLETE, а не compiler PASS. Отдельная scoped strict проверка
TS7 завершилась PASS: все14 изменённых файлов и их transitive imports, с исходными
compiler options и шестью ambient declarations. Desktop scripts проверены отдельно
с исходным NodeNext config. Этот scoped PASS не заменяет полный workspace gate.
Локальный исходный Desktop run невозможен: штатный установленный Xorg не смог
открыть требуемые local/unix sockets. Transport, display policy и native oracles
не обходятся; чистый CI остаётся обязательной частью приёмки.

[Исходный CI7fe](evidence/ci-7fe15c47-20261119.json) уже подтвердил import lifecycle,
Windows x64 source fixtures, Creation page на трёх платформах и native V2 на Linux
и обеих Windows architectures. V2 Settings завершился до отдельного membership
отказа. Windows ARM source readiness остаётся INCOMPLETE, но final receipt
подтверждает cleanup=true и отсутствие всех семи исходных HANDLE. Промежуточные
false до witness.wait не являются финальным cleanup outcome.

На7fe cross-team прошёл предшествующие Taskboard/ReviewFlow пути, но final reload
не загрузил main.tsx: Chromium ERR_INSUFFICIENT_RESOURCES. Installer не начал
сценарий: original ps census превысил свой3s предел. Эти исходные проверки не
ослабляются. Неисполненные Resume, attachments и Darwin ARM process jobs на7fe
позже cancelled; текущие source jobs должны дать собственный результат.

Исторический9ec6cb6f содержит полный cross-team/ReviewFlow GUI, четыре frontend
shards, workspace typecheck, fast lint,20/25 Desktop lanes и пять packaged
платформ с aggregate PASS. Эти доказательства остаются привязаны к исходному
source. Success metadata-only packaged workflow7fe с пропущенной матрицей не
является новым packaged PASS. CI вручную не перезапускается и не отменяется.

## Доставка и границы

[Проверка маршрута и автоматических запусков](evidence/delivery-route-20261119.json)
подтвердила отдельную границу доставки: перевод1192 в Ready запускает настоящий
Codex installer smoke с `--version`; обновление уже Ready1186 выбирает native
Desktop с настоящими Claude/Codex. Штатного Ready/merge пути, одновременно
исполняющего эти gates и сохраняющего текущий запрет таких запусков, в workflows
нет. Перед этим переходом требуется согласовать именно объём автоматических
native запусков. Это не останавливает независимые исправления, ревью и Draft-safe
CI. Gates, protection, labels и статусы ради обхода не изменялись.

- App [#1192](https://github.com/777genius/agent-teams-ai/pull/1192) и
  [provider #8](https://github.com/agent-teams-ai/old-provider-implementations/pull/8)
  остаются Draft. Маршрут: **#1192 → #1186 → #982**. Main merge, release,
  включение Host по умолчанию и Stage 2 не разрешены.
  [Решение об отложенном Stage 2](https://github.com/777genius/agent-teams-ai/pull/1105#issuecomment-6771443351).
- Реальные Claude/Codex не запускать, включая version. Использовать исходные
  finite protocol peers; OpenCode — только согласованный pinned native runtime
  с TEST-local model. Все проверки — в отдельных TEST projects.
- Сохранить source/owner/currentness, authority, private snapshots, process
  custody, исходные deadlines, negative oracles и cleanup. UNKNOWN, skip,
  cancel и queued не являются PASS; exit ребёнка не заменяет owner release.
- Один владелец у каждого общего файла. Root публикует app ref/index с проверкой
  expected SHA; сохраняет внешние коммиты, без force push. Каждый созданный
  коммит сразу публикуется. Во время original GUI/native source/deps/build frozen.
- Не добавлять второй controller, scheduler, auth owner, event bus или ReviewFlow.
  Не менять bundler, global defaults, deadline или acceptance ради TEST.

## Проверено на 9ec6cb6f

[Снимок приёмки](evidence/ci-9ec6cb6f-acceptance-20261119.json) содержит точные
jobs, SHA/base/merge, URLs и первые отказы. Все полученные PR workflow завершены:
11 success, 4 failure, 14 skipped, pending 0. Все 43 inline review threads
resolved; approval review этим не заявляется.

| Область | Подтверждённый результат |
| --- | --- |
| F1 — полный Taskboard / ReviewFlow | [Original cross-team GUI PASS](https://github.com/777genius/agent-teams-ai/actions/runs/44455698034/job/135330056479), включая три owner epochs. Это полный `task-board-cross-team-ui`, отдельно от более узких taskboard/review lanes. |
| D1 — исходные code gates | [Fast feedback PASS](https://github.com/777genius/agent-teams-ai/actions/runs/44455698135/job/135350275471): реальные шаги workspace typecheck и Fast lint завершились успешно. Четыре frontend shards PASS. Старые TS2540/TS2339 и локальный SIGKILL не являются текущим результатом. |
| Packaged Desktop | Все пять platform jobs и [полный gate PASS](https://github.com/777genius/agent-teams-ai/actions/runs/44455698083/job/135383187603). Исторический Windows ARM capture gap на42a4 не переносится на этот результат. |
| E1 — остальные Desktop routes | 20/25 lanes PASS, в том числе selection, import, collaboration, Claude lifecycle, installer, team, active Quit и pending-open Quit. Import lifecycle и retained — отдельные незакрытые пути. |
| Native embedded V2 | Linux x64, Windows x64 и ARM64 PASS. [Linux](https://github.com/777genius/agent-teams-ai/actions/runs/44455698117/job/135330058113) включает credentials/cold recovery, permissions/Stop, external MCP и полный verifier. Darwin functional steps проходят, общий job отказывает позже на P09. |
| Host process fixtures | Linux x64, Darwin x64 и ARM64 PASS. Windows source A/B остаются открыты. |

Полные исходные журналы десяти отказавших jobs сохранены в
[архиве](evidence/ci-9ec6cb6f-job-logs-20261119.tar.gz), с manifest размеров и SHA-256.
Это декодированные GitHub logs с нормализованными LF; исходные verdict сохранены.

## Осталось: один план и один владелец

| ID | Исходный отказ | Текущая работа и критерий завершения | Владелец |
| --- | --- | --- | --- |
| E1-Stop / Import | [Original import lifecycle7fe PASS](https://github.com/777genius/agent-teams-ai/actions/runs/44539501369/job/135613921599). | Старый startup отказ664 закрыт этим исходным job. Новый Stop regression из frontend shard2/4 учитывается отдельно ниже; PASS импорта не квалифицирует все Stop paths. | root |
| E1-Stop / Aggregate | На7fe семь failures launch matrix и один cancellation failure. | Исправлено: source fence передаётся через исходную public Stop chain. Все8 исходных падавших cases PASS, прежние6 WorkSync ordering cases PASS, facade guard8/8 PASS, Fast lint и независимое R2 PASS. Assertions, actions и deadlines не изменены. Это целевые локальные результаты; current source acceptance ещё нужна. | root; parity_review |
| E1-Retained | На33 hydration/private-selector waits прошли; metadata effect отсутствовал после собственной публикации Main control URL. | Исправлены три ambient identity сравнения; 33/33 cases, scoped TS7 и независимый R2 PASS. Original33 scope очищен, launch не достигнут. Нужен новый полный original Desktop и native V1/V2 coexistence. | parity_review; root |
| E1-Add | На33 прежний /proc ENOENT не повторился; Settings PASS, исходный Add Carol остановился на held native model probe. | Exact command связан с trace: native-ready → credential, без attestation/session-create. Inline credential path содержит catalog/connect/readback; существующие данные не отделяют конкретную операцию от currentness refusal. No Carol Runtime allocation. Изменять TTL/guards оснований нет; нужны причина и исходные Add/Remove/Restore/Stop/cold. | delivery_review; root |
| E1-Review | На33 READY, но Team preflight held до Launch. Native-ready и credential пройдены; после attestation нет session-create. | Граница: attestOpenCodeV2ModelSelection → readiness.observeProvider. Close через1.322s после исходного probe expiry не доказывает первопричину. Original Quit/group/Host absence подтверждены. Нужны обоснованное исправление и исходный Darwin Review PASS без изменения budgets/custody. | parity_review; root |
| E1-Resume | На33 READY; исходный wait `one original OpenCode preflight command; no mutation retry` истёк до Launch/Stop/cold/Resume. | Numeric observation patch исполнен; receipt и source hashes сохранены. Quit timeout/unconfirmed, app exit0/group empty, Host не наблюдён. Анализировать уже полученные counts/trace, затем пройти исходный Resume; неизвестную custody не считать PASS. | parity_review; root |
| W1 | [Windows x64 source7fe PASS](https://github.com/777genius/agent-teams-ai/actions/runs/44539500343/job/135613817235); ARM Codex A всё ещё не достигает nativeReady до исходного cutoff. | [Свежий33 ARM](https://github.com/777genius/agent-teams-ai/actions/runs/44565800920/job/135707175233): final cleanup=true, все7 original HANDLE absent; последний event catalog before-await, окончания readiness/Runtime publication нет. На7fe catalog успел завершиться. Provider/scenario clocks имеют разные anchors. Обоснованного source fix не найдено; нужен original ARM PASS без изменения cutoff/currentness/authority. | root; delivery_review |
| W2 | [Свежий33 Windows x64](https://github.com/777genius/agent-teams-ai/actions/runs/44565800920/job/135707175584): Codex и Claude source A/B PASS; OpenCode A отклонён на probe-expiry,183ms после исходного cutoff. | Все3 original HANDLE absent, final cleanup=true. Default launch authority теперь объединяет прежние синхронные checks под тем же Team lock; RED2/GREEN1 publications,18/18 cases и R2 PASS. Сэкономленные миллисекунды не заявлены; нужен original Windows result с прежним cutoff/actions. | delivery_review; root |
| P09 | Darwin x64/ARM mutation witness прежней гарантии остаются отрицательными. | A принят. Два раунда плана и независимый R2 source завершены; 8 product-path rows используют настоящий CapturedProcess, отдельный Darwin mmap schedule сохраняет контрпример. TS7 Host build/test types и C compile PASS. Старые45 strict assertion lines сохранены. Нужны native результаты Linux и обеих Darwin architectures на frozen source; прежние outcomes не переклассифицируются. | root; parity_review |
| D1-current | На7fe compiler-шаги завершались; frontend shards1/2/4 и typed lint FAIL. | Полный workspace typecheck и исходные typed-lint scopes в33 Team job135707276069 PASS; все4 frontend shards33 также PASS. Локальные exit137 сохранены отдельно, scoped TS7 не подменяет полный CI результат. Facade guard8/8, оба OpenCode transfer paths и source guard PASS. | root |
| E1-Other | Cross-team33 и Darwin pending-open Quit PASS. Active Quit33 не достигнут: исходная180s launch setup истекла с custody-unresolved. Installer/attachments queued. | Active probe ранее завершён; launch started с14.810s оставшегося original probe lifetime, это не доказанная первопричина. App exit0/group empty, Host не наблюдён. Сохранить исходные сценарии, deadlines и UNKNOWN; нужны новые actual results. | root |
| Delivery | Снимок33: Host22success/5failure, process3success/2failure, V2 7success/1failure; running0, fivequeued. | Опубликовать reviewed source поверх checkpointA в1192, дождаться обычного current-source CI, исправлять доказанные причины. Не выполнять ручных rerun/dispatch/cancel. Ready/parent merge имеют отдельно описанный конфликт автоматического real-provider execution; independent Draft-safe work продолжается. | root |

## Что уже реализовано и повторно не разрабатывается

Host/Session SPI, embedded OpenCode V2 2.1.4, Logs/Thinking/source/filter/fullscreen/
stderr, accounts/models, suggestions, schedules, membership и retained launch
уже существуют. Незакрытые строки выше относятся к конкретной интеграционной
приёмке этих путей.

**ReviewFlow.** Human grant отделён от переданного имени; request/cycle и current
owner перепроверяются. Trusted Main defaults входят в snapshot/preimage и recheck;
inherit не копируется в override. ACK recovery ищет исходную command по frozen
handle без повторной mutation; неизвестный lookup остаётся UNKNOWN. Canonical
Host agenda блокирует review work на lead/user clarification до review cycle;
старый app path — re-export. Сохранение `lead_then_human` в UI само по себе не
доказывает исполненный lead handoff. Полный текущий F1 указан в таблице выше.

**Solo publication.** Все четыре production-файла ранее проверенного исправления
побайтово входят в9ec. Finished, ещё принадлежащий Main Unix solo run допускается
только при точном run/session/child birth, пустых roster и сохранённой currentness
до/после await. Publication/release fencing, rejection и rollback сохранены.
Ранее выполненные 126/126 Linux checks остаются доказательством этих неизменённых
boundaries; это не новый aggregate9ec и не Windows PASS. Original 41ab lifecycle
прошёл публикацию, native Stop/release и последующий импорт.

**Media и provider.** Native TEST receipts030 подтверждают PNG/JPEG/GIF/WebP,
точный PDF, нормализацию PNG 4,194,304→159 bytes, public readback, Stop, cold Host
Resume без model/tool replay и cleanup на пяти платформах. Windows manual/auto
сохранены отдельно. OpenCode2.1.4 не принимает video; UI не должен обещать его
отправку. Desktop/vendor-auth/release qualification этими media receipts не
заявляется. Provider pin `b19494fd` неизменён: implementation archive191145B,
SHA256 `ad05bd8c799c4d2c366a6eab72f937466355a5994eac6bd201ee754217cf5aa7`.
Canonical provider check ранее PASS; все252 старых compiled outputs и SPI archive
побайтово сохранены. Audit19nov: текущий archive содержит256 dist outputs плюс
10 SPI outputs; SHA-256/SHA-512/Git blob, manifest и lock совпадают с receipt.
В provider#8 нет inline threads или review submissions. Его единственный
coordination comment указывает на [#11](https://github.com/agent-teams-ai/old-provider-implementations/pull/11),
уже merged17nov в ветку#8 и включённый в pin `b19494fd`. Это read-only audit,
не новый build или approval. Новый provider source или перепаковка не нужны.

## Восстановленные кандидаты и порядок проверки

Рабочая среда восстановлена. [Запись recovery](parity-executor-outage-recovery-20261119.json)
содержит точные local-only pins, verification и R2; перечисленные там hashes
не объявляются удалёнными uploads. Initial seed/model source и passive read-cut finalReason восстановлены в точных
проверенных bytes: 10/10 finite checks для каждого, scoped strict types и
независимый R2 сохранены. Все preimages совпадают с9ec. Initial-seed fix разрешает
prospective model read только для ещё не запущенного seed с доказанным released
custody; complete-capture exceptions по-прежнему выходят наружу. finalReason
передаёт закрытую причину в уже существующей TEST native OpenCode диагностике,
без новых runtime действий или Windows qualification.
Resume numeric observation также восстановлен в точных bytes: прежние 52/52
checks до/после, восемь новых checks, focused TS7 и independent R2 сохранены.
Исходные read/await/input/deadline не изменены; это диагностика, не Resume PASS.
[Readiness evidence](evidence/recovered-readiness-9ec6cb6f-20261119/index.json) и
[Resume adoption](evidence/recovered-resume-9ec6cb6f-adoption.json) содержат pins.
Canonical solo config census и WorkSync integration прошли 153 focused checks и
независимое source review; original producer 917 и 41ab подтвердили native Stop.
Source proof, diagnostics и полная интеграционная приёмка учитываются отдельно.
[Stop / WorkSync evidence](evidence/solo-stop-work-sync-e754d233-20261119.json)
содержит точные pre/post hashes, исходные test logs, независимый R2 и scoped
compiler result. Последние6 ordering cases — повтор после test-typing fix,
они не суммируются с153. Actual42 archive принят только как canonical content;
исторический INCOMPLETE и отсутствие original release не изменены.

1. Независимые владельцы завершают назначенные patches; root сохраняет один план
   и публикует конкретный diff вместе с source-scoped evidence.
2. Для WorkSync сохранить синхронный capture исходной native authority и Stop
   ровно один раз под прежним lock. Drain — вне identity/team/publication locks;
   затем recheck исходной epoch/successor и строгая проверка artifacts. Не заменять
   drain на dropTeam или parked queue; ProductTask writes остаются отдельными.
3. Проверить изменённые boundaries и независимый R2. Сборку Host выполнять один
   раз после изменения его source, до новой original GUI-проверки.
4. После публикации clean SHA запускать только затронутые исходные сценарии,
   без конкурирующих GUI/build/source mutations. Сохранять final receipt и cleanup.
   Повторное исполнение original action и увеличение deadline не допускаются.
5. Успешные неизменённые проверки не повторять без конкретного риска; текущие
   обязательные CI gates не заменять историческими результатами.

[V2 membership evidence](evidence/membership-probe-close-90b7fb4a-20261119/index.json)
сохраняет актуальный original Add: один command, held model probe, отсутствие
публикации участника/session. Последний marker — credential, до attestation.
Новая failure-only Host→Main запись передаёт только уже захваченные closed scalar
поля, ≤768B, первая на probe; прежние phase, 8192B framing, clocks, authority,
request/Stop/drain и UNKNOWN сохраняются. 30/30 focused tests PASS и independent
R2 подтверждают эту диагностику; продуктовая причина ещё не квалифицирована.

[Original import lifecycle917](evidence/gui-import-lifecycle-917a7d3c-20261119.json)
сохраняет producer PASS и consumer INCOMPLETE отдельно. Ровно один bootstrap/turn,
подтверждённый native release, post-Stop ProductTask и1908 неизменных source hashes.
Consumer app завершился с exit0/remaining=[], но Host не был наблюдён:
`capturedHostAbsent=null`, строгий collector cleanup=false.
[Исправление export](evidence/stopped-import-canonical-artifacts-917a7d3c-20261119.json)
связано с11 неизменными original source files и их каноническими writers.
Соседние неизвестные пути, неканонические URI stems и прежние negative oracles
по-прежнему отклоняются; native authority и notification delivery не переносятся.

[Original import lifecycle 41ab](evidence/gui-import-lifecycle-41ab8f64-20261119.json)
подтверждает export/import, dialog после reload, Task и единственный новый Host
input с terminal=succeeded. Отказ исходной проверки logical inputId == SDK UUID
сохранён как INCOMPLETE; visible reply, последующий UI Stop и cold readback этим
запуском не заявляются. Строгий cleanup=true, Host absence подтверждён, все 1909
source hashes совпали; отдельный exit code Host не выдумывается.
[TEST input correlation](evidence/finite-import-correlation-41ab8f64-20261119.json):
3/3 целевых tests PASS, включая 31 подмену, strict TS7 PASS за 2.546s и R2 PASS.
GUI и final validator используют одну функцию; canonical preparation validator
переиспользован. Peer добавляет только SHA256 уже прочитанных raw SDK bytes.
Production source, действия, read/await и deadlines не менялись; точная Host-сборка
41ab используется повторно. Исторический failed run не превращается в PASS.

[Original import lifecycle 3b](evidence/gui-import-lifecycle-3b459631-20261119.json)
прошёл новую корреляцию и показывает ответ в original lead chat. Product snapshot
доступен, но по контракту не содержит Runtime conversation; исходный assert на
его `messages` сохранился как failure. UI Stop и последующий cold readback ещё
не выполнены. Все 1909 pins равны, cleanup квалифицирован; это не общий PASS.
[Два TEST-исправления](evidence/finite-import-followup-3b459631-20261119.json)
прошли 2/2 целевых cases, strict TS7 за 2.525s и независимое ревью. Первый
положительный test run и исправление единственной union-typing ошибки сохранены
отдельно; повторные 2 cases не суммируются. Публичная conversation проверяется
одним общим helper с прежним 384KiB cap, точной binding и без pagination/gaps.
Пустой Runtime members допускается только в этой pinned import-фикстуре;
остальные режимы сохраняют одного member. Исходный final census `[after]`,
production tombstone и все UI Stop/cold/no-replay assertions сохранены.

[Original import lifecycle 036](evidence/gui-import-lifecycle-0369480a-20261119.json)
разделяет GUI proof PASS (58 steps) и общий INCOMPLETE. Producer завершён штатно;
consumer прошёл single input, public conversation, Stop/release, peer absence и
stopped reload. Перед successful Quit общий guard обнаружил один refused
`codex app-server`; sentinel остановил вызов, vendor Codex не исполнялся.
Та же строка есть в 41ab и 3b до consumer preflight; attribution к no-Host producer
следует из append order, точные PID/time отсутствуют. Cleanup после отказа
квалифицирован; он не заменяет successful Quit/final acceptance.
[Sentinel-исправление](evidence/finite-import-sentinel-0369480a-20261119.json)
переиспользует существующий режим: разрешённый metadata-запрос Codex version
теперь сообщает «не установлен» через exit78, а app-server остаётся запрещён.
Закрытый opt-in действует только для исходного finite Claude import recipe;
native donor guards и прочие modes неизменны. Единственный затронутый factory
case PASS, strict TS7 PASS за 6.646s, independent R2 PASS. Production, original
producer/UI/final validator и общий no-agent guard побайтово сохранены.

[Original 588](evidence/gui-import-lifecycle-58851e65-20261119.json) остановился
после native Stop и единственного post-Stop Task, до consumer. Source peers/groups
удалены, inputs frozen; обычный successful Quit не достигнут, top-level collector
cleanup/child-input qualification не получена. Retained и mode validators не
запускались. Отсутствующие boolean означают diagnostic exec/parse failure;
реальный отказ canonical release дал бы boolean false.
[Пассивная диагностика](evidence/finite-import-diagnostic-58851e65-20261119.json)
перемещает одну существующую строку присваивания перед прежними assertions;
остальной source побайтово одинаков, R2 PASS. Новых tests/read/action/deadline нет.
Единственный отдельно разрешённый AFTER-EXIT child использует исходные command,
cwd, closed env, 10s и 128KiB. Его exit0/оба true/11 неизменных файлов сохранены
как debug; первоначальная причина 588 остаётся UNKNOWN.

[Исторические входы coexistence](evidence/coexistence-historical-inputs-20261119.json)
подготовлены отдельно: четыре clean pinned checkout, проверенные V1 packages1.19.4
и runtime0.0.158. Исходные donor dependency install (49.793s) и strict Electron
44.10.1 ensure (18.860s) завершились с exit0. Donor SQLite ABI149 (171.019s),
runtime0.0.160 (22.276s), controller (0.234s) и MCP (2.599s) также готовы.
Исходники/lockfile и SQLite основного app неизменны; провайдеры не исполнялись.
Current-source V2 подготовлен на664 за73.933s; canonical coexistence preparation
PASS за13.124s. [Общий evidence664](evidence/original-e2e-66444904-20261119.json)
сохраняет исходные verdicts, hashes и cleanup каждого отдельного запуска.
Native coexistence завершился FAIL за312.951s: первый retained V1 не подтвердил
custody protocol, native session/bootstrap отсутствуют, model observations=0.
Original cleanup=true и cleanupFailures=[] не заменяют бизнес-приёмку.

Exact f5c helper использует abstract AF_UNIX, поэтому глубина TMPDIR не объясняет
лимит socket name. Версии, helper/image hashes, argv/env и packet limits совпали.
Один отдельный local capability check вернул EPERM на создание AF_UNIX socket,
без bind/connect/listen или native process. Source/R2 подтверждает: helper
требует этот syscall уже при measure, до image open/fork. Это установленное
ограничение текущей среды, отдельно от несохранённой причины664.
WeakMap diagnostic теряется внутри исторического runtime до JSON projection;
current Main не может восстановить исходный объект ошибки. Замена transport,
изменение frozen source или повтор того же local coexistence не выполнялись.

На664 import producer прошёл исходные Stop/read/Task/Quit и сохранил все входы.
Consumer завершился INCOMPLETE до import UI: physical app group пуста,
failure Quit ACK/exit0/listener absent, но Host не наблюдался и отдельный
emulated-runtime census сообщил observationFailed. Native Settings тоже
остановился на startup readiness; Host/native cleanup подтверждён, обычный Quit
не подтверждён. Mode validators не выполнялись на failed receipts.

[Пассивный startup-срез](evidence/startup-readiness-66444904-20261119.json)
сохраняет прежние первые24 samples и одну последнюю закрытую запись. В ней есть
номер и фаза попытки, последний завершённый snapshot, monotonic/epoch время
call/completion/failure/final rejection и закрытая категория отказа.
Исходный evaluate, порядок commands/owner guards, READY predicate, deadline,
context retry и объект ошибки сохранены. Один new test проходит25 ответов и
отказ26-го вызова, проверяя cap, отсутствие новых reads/discovery и утечки
private error payload. Его PASS и strict types/R2 не являются GUI PASS.
Существующие Main app-errors уже содержат время renderer killed/recovery;
причина kill, включая OOM или отправителя сигнала, остаётся UNKNOWN.

[Retained prepare evidence](evidence/retained-prepare-boundary-20261119.json)
содержит 42/42 checks и независимый R2. Единственная существующая diagnostic
запись сохраняет закрытое имя последнего внутреннего этапа; исходная ошибка,
source/target guards, число чтений/await и deadline не изменены. Следующий GUI
покажет недостающее наблюдение; текущий held не объявляется исправленным заранее.

## Новые исходные Windows observations

[Два оригинальных Windows artifact](evidence/ci-9ec6cb6f-windows-refusals-20261119.json)
сверены с API digest и сохранены. ARM Codex прошёл source A за 14803.6281ms;
source B вернул ready=true за 15184.6772ms и был отклонён исходным post-await
15s cutoff. На x64 OpenCode source A остался held: first probe-expiry +103ms;
21 consumer check заняли 10417ms, из них reference9597ms и account5527ms
(включая authority5083ms). Эти измерения не разрешают кешировать authority
или считать поздний readiness своевременным. Оба original cleanup=true.

[TEST observer R2](evidence/windows-projection-refusal-r2-20261119.json) подтверждает
сохранённые 4 rows/512B, exact epoch/Host exit/digest join и все negative checks.
Новые закрытые причины различают invalid/conflict/capacity/byte budget и boundary
reader; UNKNOWN остаётся UNKNOWN. Новых reads, действий, ожиданий или deadlines нет.

## P09: выбран A, реализация и приёмка в работе

[Report40](40-p09-source-writer-decision-2026-11-16.md) описывает две разные границы:
A — original path с доверием всем сохраняющим write/rename/FD/mmap authority writers
до подтверждённой очистки всех consuming scopes; B — отдельная фиксированная версия executable/script
с согласованным изменением path/provenance, `$0`, self-read и ресурсов.
Владелец явно принял A19nov. В текущем срезе доверены все субъекты с возможностью
изменить выбранный source; исключение иных writers не заявляется. Silent copy/chmod
или запрет scripts не входят в выбранное изменение.

В original Darwin witness после mutation исполняется `SCRIPT:B`; cleanup всех
children/groups не доказывает byte identity. Исторические x64 code-signing errno
и реально наблюдавшийся exec различаются. Не делать универсальный вывод о
невозможности OS-гарантий из этих конкретных counterexamples.

## История и evidence без дублирования

- [Полный журнал до9ec](https://github.com/777genius/agent-teams-ai/blob/9ec6cb6f567af14233965a77c4c4a043adc29487/docs/plans/provider-migration/frontend-parity-2026-11-12/STATUS.md)
  сохраняет всю прежнюю хронологию, source hashes и qualification scopes.
- [Полный original030 F1 receipt](parity-030-review-flow-final-receipt.json.gz):
  Taskboard, девять review-cycle steps, ReviewFlow и три owner epochs PASS;
  default восстановлен в `agent_approval`, inheritedAfterReload=true,
  hostsAbsent=true, remaining=[]. Rollback epoch использовал разрешённый SIGTERM;
  natural exit всех epochs не заявляется.
- [Локальный Taskboard547](evidence/gui-taskboard-547e603c-fixed1536-uv4-20261118.json)
  завершился INCOMPLETE позднее выполненных footer/default/approve действий,
  при sidebar после reload; это исторический failed run, не PASS9ec.
- [Локальная очередь547](evidence/gui-queue-547e603c-finite1536-uv4-20261118.json):
  selection/import PASS, import lifecycle INCOMPLETE на publication/reply до
  solo fix. Текущий9ec уже проходит этот участок и отказывает на Stop.
- [Native030](parity-030-native-arm-original-proofs-030.json),
  [WinARM42a4](parity-42a4-native-win-arm-success-20261119.json),
  [Darwin x64 P09](parity-42a4-native-darwin-x64-posix-witness-20261119.json) и
  [Darwin ARM P09](parity-42a4-native-darwin-arm-posix-witness-20261119.json)
  сохраняют исходные platform/source verdict.
