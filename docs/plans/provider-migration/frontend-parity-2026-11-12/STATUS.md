# Завершение Host / frontend parity

Обновлено: **19 ноября 2026**. Единственный текущий рабочий план.

**Текущее продолжение:** владелец выбрал P09 **A** — исходный путь с доверием всем
writers выбранной ревизии до завершения её использования. [Принятый контракт](40-p09-source-writer-decision-2026-11-16.md)
зафиксирован. Срез source/native acceptance реализован и прошёл независимый R2;
[проверки, точные hashes и исправленные замечания](evidence/p09-contract-a-review-20261119.json)
сохранены отдельно от native приёмки. На текущем fbc Darwin x64 job135773065012
и Linux x64 job135773064871 полностью PASS: по8 original-path A observations PASS,
cleanup=true; strict counterexamples и INCOMPLETE сохранены отдельно,
installed/release qualification=false. Darwin ARM A ещё queued. Полные оригинальные
[native receipts](evidence/p09-contract-a-native-receipts-fbc77ea-20261119.tar.gz)
сохранены. A и два независимо проверенных исправления ниже опубликованы в1192 как
`fbc77ea6b9a35f4be640d7b1e103b992a3f3a45e`. Его source CI на19:09:24UTC:
Host13 PASS/3 FAIL/13 queued, native V2 8 PASS/1 queued; Fast feedback и все4 frontend
shards PASS. Очередь не является отказом или PASS. [Точные jobs и первые отказы](evidence/ci-fbc77ea-incremental-20261119.json)
отделены от PR-body edited run: его metadata gate ожидаемо отказал для Draft и
не исполнял source qualification.

**Новый срез поверх fbc, локально проверен и прошёл независимый R2:** Live Add сохраняет
исходные authority observations при одной same-Team physical publication вместо
двух; Runtime/captured проверки остаются после освобождения Team lock. Resume
observer связывает исходную prospective saved command с Main handle/scope и
payload, сохраняя единственный command/source/cutoff. Это только выбор срока
ожидания: независимая квалификация saved source до acquisition не заявляется.
Три LiveRoster сценария и57/57 observer cases PASS. Дополнительно62/62 cases
прежнего UI helper подтверждают пассивный same-CDP снимок hydration при отсутствии
Launch. Retained submit использует актуальный текст «Launch team». Пассивные Darwin
startup marks сохраняют исходный catch/cleanup/error;38/38 controlled cases PASS,
после исправления test facade type два затронутых cases также PASS. Windows timing
разделяет существующий account interval на provider/allocation с сохранением
исходных callback counts/clocks;5/5 targeted cases PASS. Это измерения прежних
границ, а не ускорение native readiness.

[Шесть source slices, RED/GREEN, проверки и независимый R2](evidence/parity-readiness-observer-fixes-20261119.json)
и [raw logs с canonical compiler scope](evidence/parity-readiness-local-checks-20261119.tar.gz)
сохранены. Общий scripts TS7 и оба архитектурных guard PASS. Независимая integration
custody сверила все19 файлов/1,042,288bytes, шесть манифестов,16 source/dist pins и
три Host build hashes: расхождений нет. Каждый новый source требует собственного
original CI; выполненные fbc результаты не переносятся. Native jobs вручную не
перезапускаются.

**Свежие fbc отказы:** Windows x64 source A снова отклонён после исходного probe
cutoff (+214ms), cleanup=true/3 HANDLE absent.22 account intervals содержат176
вложенных authority callbacks;4705ms нельзя приписать одной из двух составляющих.
Darwin Review остановился раньше: graph23.309s, затем native-launch без ready;
startup timeout правдоподобен, но не доказан; final group/Host absent. Resume
остановился ещё до preflight: original Open Team выполнен, Launch не найден за
исходные30s. Post-failure кнопка видна, но её время появления неизвестно;
оставшийся original group PID означает cleanup debt. Подготовлена ограниченная
пассивная диагностика исходных границ и сохранён разбор receipts, без изменения budgets,
oracles, currentness, callbacks или UI actions. Retained-original теперь прошёл
прежние runtime/model metadata и два finite model-probe PONG; новый отказ точно
связан с устаревшим текстом submit selector: actual footer «Launch team», сценарий
искал «Launch». Исправлены только два scoped selector literals, R2/lint PASS.
Original group пуст, оба management peer absent; bootstrap/reply/Stop ещё не
достигнуты. Все4 frontend shards и canonical Team workspace types/typed lint на
fbc PASS; это не заменяет pending native/GUI paths. Отдельный retained V1/V2 coexistence
job135782182242 прочитал исходную V1 history, выполнил Stop/reopen без replay, затем
отказал до original runtime dispatch: coordinator-admission/source-unreadable.
Точный внутренний source boundary не наблюдён; cleanup=true. Допуск не ослабляется,
следующая отдельная работа — конечная пассивная причина в существующей private
диагностике без нового чтения или действия.

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
| E1-Retained | На33 metadata отказывала после Main control URL. На fbc original135773059015 runtime/model/PONG readiness PASS, затем scoped Launch selector mismatch. | Published ambient identity fix33/33/R2 подтверждён прохождением прежней границы. Actual frontend footer «Launch team» вместо ожидаемого «Launch»; исправлены только scroll/click literals, R2/lint PASS.192 original DOM reads resolved, retries0, bootstrap/reply/Stop ещё нет. Original group пуст/2 management peer absent. Нужны полный original Desktop и отдельный native V1/V2 coexistence. | root |
| E1-Add | На33 прежний /proc ENOENT не повторился; Settings PASS, исходный Add Carol остановился на held native model probe. | Exact command: native-ready → credential, без attestation/session-create; первый отказ не установлен. Same-Team fix готов:2→1 publications, все4 namespace scans и5 исходных state reads сохранены, добавлен внешний read grant; Runtime/captured checks вне lock.3 сценария, Host TS7 build/test types/lint/source guard и R2 PASS. Immutable owner check теперь также отказывает при owner replacement на cleanup пути. Native влияние ещё не измерено. | delivery_review; root |
| E1-Review | На33 preflight дошёл до attestation; на fbc остановился раньше, после graph23.309s/native-launch, без native-ready. | К native-launch оставалось≤6.688s исходного startup30s, но конкретный отказ не установлен. resourceHeld=false, final group/Host absent. Пассивные отметки после original custody launch/endpoint и в existing catch готовы;38/38 controlled cases, final affected2, canonical scoped TS7/lint/R2 PASS. Без новых authority reads/I/O/deadlines. Нужен original Darwin Review PASS. | root |
| E1-Resume | На33 observer сравнивал saved-model revision со старым runId. На fbc новый более ранний отказ: original Open Team прошёл, Launch не найден за30s; до preflight не дошёл. | Observer fix57/57 и R2 PASS: original Main handle/full scope/payload/roster/context/action/destination, один command/source/cutoff, без новых read/await/retry. Только wait-bound contract, не source qualification. Свежая post-failure кнопка не доказывает её наличие во время121 исходного DOM read. Route audit не доказал transport serialization; selectedTeamLoading отсутствует в старом snapshot. Пассивные hydration facts в исходном CDP read62/62/R2 PASS. Original group PID10102 остаётся, Host absence unknown. | root |
| W1 | fbc Windows ARM135773054102:110 original reads/15.207s; последний read уже nativeReady=true/allocated/owned/attached, но после исходного15s cutoff. | Provider readiness true на14.6823s другого clock anchor; first-refusal ledger пуст. Не переносить33 before-await как новую причину. Final cleanup=true/7 original HANDLE absent. Original cutoff/currentness/authority сохранены; текущий gate INCOMPLETE, не PASS. | root; delivery_review |
| W2 | fbc Windows x64 job135773054657: Codex/Claude A/B PASS; OpenCode A probe-expiry+214ms, final cleanup=true/3 HANDLE absent. | Published default launch fix сохраняет checks под одним Team lock;18/18/R2 PASS. В22 account intervals176 callbacks,4705ms; provider и allocation уже имеют по одному fence. Общий generic wrapper недопустим из-за отдельного launch-store suffix в других routes. Пассивное разделение исходного timing готово:5/5, Host TS7 build/test types/lint/R2 PASS; count означает outer intervals, не вложенные callbacks. Безопасная новая оптимизация пока не доказана. | root |
| P09 | Darwin strict mutation witnesses остаются отрицательными либо INCOMPLETE. | A принят: current fbc Darwin x64 job135773065012 и Linux x64 job135773064871 PASS, по8/8 product-path rows, cleanup=true. Строгие script/mmap counterexamples, Darwin EACCES/-67062 и все45 assertions сохранены; installed/release=false. Отдельный native receipt Darwin ARM ещё queued и обязателен. | root; retained_e2e |
| D1-current | fbc canonical Team135773058570 и все4 frontend shards PASS. | Полный workspace typecheck, исходные typed-lint scopes, Runtime/Team contracts и Team UI завершены. Прежние локальные exit137 и scoped TS7 сохранены отдельно. Следующий изменённый source требует собственных gates. | root |
| E1-Other | Cross-team33 и Darwin pending-open Quit PASS. Active Quit33 не достигнут: исходная180s launch setup истекла с custody-unresolved. Installer/attachments queued. | Active probe ранее завершён; launch started с14.810s оставшегося original probe lifetime, это не доказанная первопричина. App exit0/group empty, Host не наблюдён. Сохранить исходные сценарии, deadlines и UNKNOWN; нужны новые actual results. | root |
| Delivery | fbc77ea6 опубликован в1192; новый проверенный срез опирается на этот parent. На18:52 все43 inline threads resolved, formal approval не заявляется. | Публикация каждого source с expected SHA; затем обычный current-source CI и исправление доказанных причин. Observer один, чтения не чаще5min; никаких ручных rerun/dispatch/cancel. Ready/parent merge имеют отдельно описанный конфликт автоматического real-provider execution; independent Draft-safe work продолжается. | root |

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
