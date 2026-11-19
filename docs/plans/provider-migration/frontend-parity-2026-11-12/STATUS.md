# Завершение Host / frontend parity

Обновлено: **19 ноября 2026**. Единственный текущий рабочий план.

**Полная E2E-приёмка ещё не завершена.** Последний проверенный CI-срез —
`9ec6cb6f567af14233965a77c4c4a043adc29487`, база `8d46f13f`.
На нём прошли полный cross-team/ReviewFlow GUI, workspace typecheck и fast lint,
четыре frontend shards, все пять packaged-платформ и их общий gate.
Из 25 Desktop lanes прошли 20. Оставшиеся отказы перечислены ниже.
Продолжения `90b7fb4a`, `e754d233`, `917a7d3c`, `41ab8f64` и `3b459631` опубликованы. Строгая локальная
[Host-сборка e754](evidence/host-build-e754d233-20261119.json) PASS за 10.064s,
все 14 input pins совпали. Новые правки не получают результаты приёмки9ec
автоматически. При последнем чтении workflows 917 были автоматически отменены
после supersession; на 41ab — 16 queued и 14 skipped, новых PASS не заявляется.
На 3b исходный import lifecycle прошёл producer Stop/release, export/import,
reload, ProductTask readback, точную input correlation и видимый fresh Host reply.
Следующий отказ — TEST читает ответ сессии из product-only `team.snapshot`.
Проверка исправлена на тот же `team.messages.page`, который использует чат.
Также убран неиспользуемый static Runtime seed этой фикстуры: штатный Quit
иначе оставляет для него техническую tombstone. Production shutdown и строгий
final sessions oracle сохраняются. Полный lifecycle пока INCOMPLETE;
cleanup=true, все 1909 source hashes совпали. Retained после отказа не запускался.

## Доставка и границы

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

| ID | Первый отказ на 9ec | Текущая работа и критерий завершения | Владелец |
| --- | --- | --- | --- |
| E1-Stop / Import | Producer Stop, export/import и input correlation уже пройдены. На 3b после visible reply отказал неправильный TEST read из product snapshot. | Canonical conversation page и template-only fixture готовы: 2/2 новых tests, strict types и R2 PASS. Exact final oracle сохранён. Далее исходные fresh Host Stop, cold readback и полный final validator. | root; pr_graph |
| E1-Retained | [Retained UI](https://github.com/777genius/agent-teams-ai/actions/runs/44455698034/job/135330056793): prepare/held. [Main retained V1/V2](https://github.com/777genius/agent-teams-ai/actions/runs/44455698135/job/135350275468): coordinator admission, not-eligible/not-dispatched. | Закрытая prepare-boundary диагностика готова: 42/42 tests и R2 PASS. Read-fence использует исправленный drain существующей очереди; связь с исходным отказом ещё проверяется. Требуются исходный UI и отдельный V1/V2 coexistence open/history/Stop/cold/cleanup. | pr_graph; media |
| E1-Add | [Linux V2 management](https://github.com/777genius/agent-teams-ai/actions/runs/44455698034/job/135330056490): `original add completes`. | По current receipt Add сохранён held до member publication, model probe не прошёл credential preparation/cleanup. Закрытая first-close диагностика передана Host→Main, 30/30 actual-source checks и R2 PASS. Нужен исходный Add/Remove/Restore/Stop/cold после сборки. | media |
| E1-Review | [Darwin ARM V2 Review](https://github.com/777genius/agent-teams-ai/actions/runs/44455698034/job/135330056601): исходный preflight deadline. | Initial-seed/model-source fix опубликован в90b, exact-byte focused proof и R2 сохранены. Нужен affected original preflight/Review. Source test не заменяет Darwin acceptance. | media |
| E1-Resume | [Darwin ARM V2 Resume](https://github.com/777genius/agent-teams-ai/actions/runs/44455698034/job/135330056653): `one fresh Team capture`. | Проверенный numeric observation patch опубликован в90b без нового read/await/input/retry. Нужны новая исходная диагностика и успешный Resume; старый отказ произошёл ещё до первого Stop/cold boundary. | pr_graph |
| W1 | [Windows ARM Codex](https://github.com/777genius/agent-teams-ai/actions/runs/44455697852/job/135330054589) и [x64 OpenCode](https://github.com/777genius/agent-teams-ai/actions/runs/44455697852/job/135330054744): original source readiness. | Установить причинный участок по current original evidence; native OpenCode finalReason не является Windows observer. Сохранить исходный cutoff и все authority probes; получить current source A/B и recovery evidence. Закрытые причины отказа observation сохранены отдельной TEST-правкой, 2/2 actual-source checks и R2 PASS; native gate этим не закрыт. | media; root |
| P09 | Darwin x64/ARM mutation witness остаются отрицательными. | Требуется отдельный выбор контракта original pathname / writer / consumed bytes по Report40. До решения не сужать гарантию и не менять failed oracle. Независимые исправления продолжаются. | root / owner |
| Delivery | Четыре acceptance workflows красные из-за перечисленных отказов. | Проверять только затронутые сценарии, сохранить обязательные current-head gates. После qualification завершить разрешённый PR-маршрут. Не останавливать независимую работу из-за CI queue. | root |

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
побайтово сохранены. Новый provider source или перепаковка не нужны.

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

[Исторические входы coexistence](evidence/coexistence-historical-inputs-20261119.json)
подготовлены отдельно: четыре clean pinned checkout, проверенные V1 packages1.19.4
и runtime0.0.158. Исходные donor dependency install (49.793s) и strict Electron
44.10.1 ensure (18.860s) завершились с exit0. Donor SQLite ABI149 (171.019s),
runtime0.0.160 (22.276s), controller (0.234s) и MCP (2.599s) также готовы.
Исходники/lockfile и SQLite основного app неизменны; провайдеры не исполнялись.
Остались подготовка current-source V2 и исходный native coexistence тест;
подготовка не является результатом E2E.

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

## P09: решение ещё не выбрано

[Report40](40-p09-source-writer-decision-2026-11-16.md) описывает две разные границы:
A — original path с явно доверенными оставшимися writers и исключением остальных
на всё время consumption; B — отдельная фиксированная версия executable/script
с согласованным изменением path/provenance, `$0`, self-read и ресурсов.
Ни один вариант не принят. Silent copy/chmod, запрет scripts или доверие writer
не являются разрешённым исправлением исходного контракта.

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
