# Завершение frontend parity: 13 ноября 2026

## Фактический E2E на `d894df69` и исправление Windows TEST wrapper

[Исходные результаты](../evidence/frontend-parity-d894-observed-checks.json)
привязаны к `d894df69792fc46cf4a215d3e34d22f462bbe5b5`; полные receipts
сохранены без изменения bytes. Они не объявляются результатом следующего SHA.

| Сценарий | Фактический результат | Граница результата |
| --- | --- | --- |
| Windows x64, OpenCode 2.1.4, ручное разрешение | PASS, 262,600 с, cleanup true | Все шесть исходных шагов: Team/MCP/effect/permission, сохранённая конфигурация, PNG, checkpoint, новый Host и cold restore без повторного model/tool input |
| Windows x64, автоматическое разрешение | PASS, 224,401 с, cleanup true | Те же шесть исходных шагов; оба исходных Host завершились с кодом 0 |
| Windows ARM64, ручное разрешение | INCOMPLETE, 157,855 с, cleanup true | Вход consumed и permission resolved; terminal assertion false. Автоматический сценарий не выполнялся |
| macOS x64, OpenCode 2.1.4 | Business PASS, 239,322 с, cleanup true | Последующий отдельный POSIX image/mutation gate остался INCOMPLETE; весь job не считается PASS |

Во всех успешных business receipts — 11 запросов к localhost model peer,
ноль model failures. Vendor authentication, Desktop и release qualification
по-прежнему false. На Windows x64 весь исходный V2 job и финальный verifier
прошли; budget и oracle native fixture побайтно совпадают с предыдущим
`28bc9ef4`. Это не отдельный benchmark и не доказательство причины прежнего
ARM64/Windows сбоя: продолжительность sampled CPU включает idle, а passive
trace достигает исходного лимита до завершения успешных сценариев.

Отдельный process workflow на обеих Windows-архитектурах установил точную
ошибку TEST wrapper: UTF8 кириллица в literal batch path прочитана `cmd` как
другой путь. Исправлен ровно один token на `%~dp0TEST argv.mjs`. Unicode
каталог, исходный launcher, adversarial argv, stdin/output, codepage, timers
и обе проверки остановки сохранены. Независимое review, обратное побайтное
сравнение, Node syntax и классификация исходным resolver прошли. **Нативное
выполнение пяти wrapper modes и трёх A/B journeys на новом SHA ещё требуется.**

Чистая установка исходного frozen lockfile прошла локально. На собственном
полном dependency graph прошли оригинальные Electron 44.10.1/sqlite rebuild,
Host/ledger/controller/MCP builds и 44 проверки harness без skips. Исходный
Xvfb не смог открыть local/unix listening sockets; Electron приложение
не запускалось, UI PASS не заявляется. Полный `pnpm typecheck:workspace`
снова завершился exit 137 на первом frontend проекте после успешных
Host/ledger builds, без TS diagnostic; следующие проекты не выполнялись.
Семь исходных UI lanes и полный canonical type CI остаются необходимыми.


## Windows A/B: отдельный E2E на каждый provider

Поверх опубликованного `b37bfb9d9ce0112758eab1365332468bd84eaeb9` добавлены
три самостоятельных исходных Windows controller invocation: Codex, Claude SDK
и OpenCode V1 с конечными TEST peers. Каждый получает собственные Job, sandbox,
sentinel и receipt при прежних лимитах 120 / 60 секунд. Исходный wrapper/service
сценарий и его verifier сохранены побайтно. Неуспех прекращает следующие шаги.

Каждый journey проверяет публикацию B при живом A, источник B в management,
model probe и Team launch, доступную исходному provider standalone-возможность,
холодные чтения и повторы без новой allocation. Claude дополнительно проходит
реальное сохранение SDK checkpoint и restore A в новом Host при текущем B.
V1 не объявляется поддерживающим standalone или native Resume. Все настоящие
процессы в этих трёх сценариях — закреплённый Node и исходные TEST helpers;
настоящий Codex/Claude Code не запускается даже для `--version`.

Два независимых reviewer одобрили точные пять файлов. На объединённых bytes
`b37bfb9d` + provider `97690540` прошли оба исходных TS7 проекта: retained-host
и broker-only. YAML, 11 Bash blocks и извлечённый JavaScript verifier проверены;
PowerShell здесь не исполнялся. Новая обязательная проверка требует все три
фиксированных receipt и оригинальный drain каждого controller. **Это пока
готовый и проверенный E2E-код, а не успешное выполнение Windows-сценариев.**

Предыдущая попытка объединить три journey под одним controller сохранена как
HOLD и не публиковалась. Полный CI и Electron UI на новом SHA остаются открытыми.

## Проверенный срез `b37bfb9d` поверх `28bc9ef4`

Полная P08 phase 2 опубликована в `28bc9ef4705c68649256ca236985c5b222e3e1e5`
(tree `45f7550986499a612371a9e2eea4fadc4515bcb4`). Приватная исходная
ассоциация runtime проходит через Main, Host, management, Team, schedules и
model preflight. Она не сохраняется в enumerable recipe, не выводится из
profile digest и не позволяет другому Team заимствовать исходное разрешение.
Контрольные результаты этого среза: 78 Host, 14 queue и 20 Main checks PASS.
Это пересекающиеся группы, а не общий счётчик frontend coverage.

Следующий срез включает три независимо рассмотренных изменения:

| Изменение | Фактически выполненная проверка | Ещё требуется |
| --- | --- | --- |
| Checked provider `97690540` | Исходный CI провайдера: 525 source tests и два packed consumers на каждой из двух Node; frontend Host build и 43 существующих Codex finite-peer tests PASS, 0 skips | Frozen-install CI и новый точный frontend E2E |
| Закрытая синхронная проверка Team authority | Host/ledger и Host test types PASS; 12 критических filesystem checks и исходная группа 75 checks PASS, 0 skips; объединённые CPU + provider bytes дополнительно прошли 38 authority/runtime checks | Исходный Windows OpenCode E2E с прежними readiness/terminal budgets |
| Lazy-start TEST barrier | Исходная группа Desktop backend: 13 PASS, 0 skips; fixture требует реального `createHostServer`, прежде чем принять результат | Новый CI на текущем source |

На одном и том же реальном filesystem fixture число вызовов изменилось с
1 lock / 6 namespace validations / 7 state reads до 1 / 3 / 1. Следующая
проверка снова читает полное состояние; grants, lifecycle, отдельные
`workAllowed` cuts и финальная namespace validation сохранены. Это измерение
вызовов, а не обещание ускорения Windows или доказательство native cleanup.

Оригинальный provider archive имеет SHA-256
`73dbbfba5e8fed6719ccdeaae499a47284b72ac831c33a2c7206fbf2799f77b8`.
Он скопирован из checked artifact без пересборки; contracts, Claude и OpenCode
bytes не изменились. Отдельная OpenCode матрица провайдера прошла 53 jobs,
но её SPI receipts по-прежнему содержат `qualified: false`, а packed receipt
не квалифицирует native Host или packaged Electron.

На точном `28bc9ef4` Darwin x64 process job `132204573711` прошла:
134 Host checks (ещё 2 Linux-only skips), 49 protocol, 63 Main и 23 POSIX
lifecycle checks. Windows ARM64 дошёл до исходного launcher fixture, где
получен exit 1 вместо 0; provider scenarios не достигнуты. Этот результат
сохранён как INCOMPLETE с cleanup true, а не назван успешным Windows E2E.

Семь независимых Electron UI lanes опубликованы с исходными строгими
assertions. Их queued/running состояние не считается PASS. Новый пассивный
TEST observer прошёл 5 regressions, но сам по себе не устанавливает причину
второго CDP holder в прежнем e7 management failure. Исторические успешные
Team/Taskboard screenshots и неуспешный management receipt сохранены.

Полный локальный `pnpm typecheck` на `28bc9ef4` завершился exit 137 после
успешной Host/ledger сборки, без итогового результата frontend compiler.
Результат не заменяется частичными types. Повтор с поддерживаемым
`--singleThreaded` на объединённом срезе тоже был убит SIGKILL через 168,2 с
на первом проекте, до итогового результата: последний наблюдаемый RSS —
2,24 GiB, пик — 2,28 GiB. Все восемь проектов были запланированы, но следующие
семь не запускались после отказа первого. Полные types остаются открытыми;
локальные повторения в этом окружении прекращены. Реальные Codex и Claude
Code не запускались. PR #1192
остаётся Draft; main, release, Stage 2 и default activation не изменяются.

Ниже сохранён предыдущий проверенный срез и история: его provider pin,
CI состояния и результаты относятся к указанным старым SHA.

## Предыдущий проверенный срез: `e7c6f4b1`

[Draft PR #1192](https://github.com/777genius/agent-teams-ai/pull/1192) содержит
исправления этой работы и согласован с новым HEAD базового #1186
`e29dbde300ea73ec4e46e5f57f9e007ca5473552`. Опубликованный merge commit —
`e7c6f4b1ec758541738724425d2556a1558c8397`; его родители сохраняют как ранее
проверенные исправления `f0d275e6`, так и одиннадцать новых базовых commits.
Данные ниже описывают фактически проверенные границы, а последующие разделы
сохраняют историю работы. Общая frontend/platform приёмка ещё не объявляется.

Выбранный provider archive остаётся из
[`old-provider-implementations` #8](https://github.com/agent-teams-ai/old-provider-implementations/pull/8),
source `68dca527b779ebb82923f30d7b08441085d8b579`, SHA-256
`07241cca756e69aa6001df41d6a7408aad5d8ab4c8277f9d70f35d0d66736c73`.
Новый base содержит дополнительную копию тех же bytes для Claude checkpoint;
package, lock и qualification workflows последовательно выбирают существующий
`frontend-parity-68dca527` archive. Новый provider graph не создавался.

| Область | Фактический результат | Открытая граница |
| --- | --- | --- |
| P01/P05/P07 — accounts, models, settings | На объединённых bytes прошли 62 проверки Main/renderer consumers; checked provider source/packed suites ранее дали 526 PASS без skips | Это не вход в настоящий Codex/Claude и не отдельный Desktop screenshot |
| P02 — OpenCode V2 credentials | На чистом `e7c6f4b1` настоящий OpenCode 2.1.4 прошёл 401 → source publication → явное исправление → lost ACK → cold recovery → saved-key Check → неизвестный intent без replay; все четыре Host завершились с кодом 0 | Vendor authentication, Desktop и release этим localhost сценарием не квалифицированы |
| P03/P04 — conversation, schedules, recovery | Настоящий pinned Claude SDK с конечным TEST Node peer прошёл rich messages, Allow/Deny, questions, commands, task completion, checkpoint/new Host/Resume и Stop; сборка и 48 затронутых Host checks прошли | Полная разрешённая Electron-последовательность Codex/Claude/V1 ожидает текущий UI CI |
| P06 — installation/source transitions | 33 проверки Codex installer прошли; объединённый Claude checkpoint/Skip regression проходит, повреждённая цепочка отклоняется | Динамическая Windows source association P08 phase 2 проверяется отдельным следующим срезом |
| P08/P09 — process ownership | Linux FD exec stage прошёл 6 native fixtures на Node и отдельно 6 на Electron; afterPack — 63 PASS; оригинальные Main/Host authority suites на объединённых bytes — 40 PASS, runtime team — 30 PASS | Windows/macOS и native процессы должны дать собственные receipts; Darwin mutation feasibility остаётся отдельным незакрытым gate |
| P10 — original UI and recovery | Desktop helper/types — 44 PASS; UI harness сохраняет исходные controls, strict single-CDP-owner guard, sentinels и cleanup | На новом source запущен штатный Host Emulated Acceptance; queued/running не считаются PASS |

Проверки в строках пересекаются и не складываются в общий счётчик покрытия.
Новая база потребовала конкретного исправления Skip: исходная валидная цепочка
явного Skip теперь принимается после configured Launch/Stop; отсутствующие,
невыбранные или hash-consistent повреждённые transitions по-прежнему отказывают
до новой allocation. Право провайдера проверяется под одним исходным синхронным
Team lock без кэша authority между await, изменения таймеров или ослабления
writer/namespace/policy checks.

Native credential receipt сохранён
[полностью](../evidence/frontend-parity-e7c6-v2-credentials.json), SHA-256
`1f178e850809da0c8d9fab1d29280478bbc6c80eaecb9fb5b6a3c7f2681f5ffe`.
Прогон занял 174,55 секунды, дал ровно четыре исходных model requests и три
native credential rows; foreign auth bytes сохранены. Cleanup подтверждён;
kernel OOM counter остался 83 → 83. Ранее неуспешный local `6fbc` receipt
сохранён и не переименован в PASS. Успешный повтор не устанавливает причину
того старого сбоя и не приписывается диагностике либо Team authority patch.

На точном `e7c6f4b1` запущены
[Host Emulated Acceptance](https://github.com/777genius/agent-teams-ai/actions/runs/43507523266),
[Host process fixtures](https://github.com/777genius/agent-teams-ai/actions/runs/43507523307),
[V2 preflight](https://github.com/777genius/agent-teams-ai/actions/runs/43507522897)
и [общий CI](https://github.com/777genius/agent-teams-ai/actions/runs/43507523549).
Первый Windows process job выявил POSIX-only путь в controlled schedule fixture;
строгая production path schema корректно отказала до запуска процесса.
Независимо проверенное исправление использует native absolute путь внутри
исходной временной директории и не запускает реального провайдера.
Darwin ARM64 process job `132168946689` прошёл: 81 Host checks (два Linux-only
skip), 49 protocol, 53 Main и 23 actual POSIX Node/shell lifecycle checks.
Он явно не квалифицирует native registration, executable admission, Desktop
или vendor runtime. На Darwin x64 исправленная Corepack/pnpm bootstrap стадия
тоже пройдена; результат всей job пока не заявляется.

Host TS7 build и focused desktop-script types прошли. Полный frontend typecheck
локально ранее завершился OOM/137 без итогового PASS; он остаётся открытым до
точного успешного общего CI либо отдельного полноценного прогона. #1192 остаётся
Draft: реальные Codex/Claude jobs пропущены штатными Draft gates, без изменения
required checks. Main, release и default activation не изменяются.

## Зафиксированная исходная точка

- Frontend integration: PR #1186, `1160b575c4e43db045ab8726fd16d27bd611196a`.
- Stage 1: PR #982, `1d0f97f55de566036c970eab4f36b84620afdb3f`.
- Дочерняя UI qualification: #1187, `62f9165578ce84ca1daaa44cabdb8ee380fef2a1`.
- Дочерняя platform qualification: #1188, `12d54316c69326fd3d405459ebf77062d818324f`.
- Provider library: `agent-teams-ai/old-provider-implementations` #8,
  `be99aa252454feb7730fe64787a4ecd8c9bdbd6b`.

Цель остаётся прежней: сохранить работающие возможности текущего приложения
через Host и выделенные провайдеры. Планы P01–P10 и ссылки на исходные handlers
остаются основным перечнем. Этот документ фиксирует последующий срез работы,
а не объявляет предыдущие незавершённые доказательства успешными.

## Текущая инструкция владельца по проверкам

Не запускать реальные Codex и Claude Code, в том числе с localhost inference.
Другие платные provider runtimes также заменяются существующими эмуляторами.
Допускается OpenCode с бесплатными моделями. Новый E2E результат явно различает
эмуляцию provider protocol, настоящий Host/IPC/persistence, Electron UI и
проверку собственно vendor runtime. Последняя этим срезом не заявляется.

Изменения публикуются в Draft PR. Перед переходом Ready или интеграцией в
существующую ветку необходимо проверить автоматические workflows: текущий
Ready #1186 запускает реальные Codex/Claude. Настройки защиты и обязательные
проверки не ослабляются; skipped native job не считается PASS. Main, default
activation, release и Stage 2 в эту задачу не входят.

## Параллельные срезы и проверяемые результаты

| Срез | Известное расхождение / работа | Доказательство |
| --- | --- | --- |
| Accounts, models, configuration | P05 теряет OpenCode model variants между D, Host и Main; текущий selector становится disabled | Существующий TEST protocol peer, Host management и реальный renderer control; сохранить безопасные native IDs |
| Commands, schedules, recovery | P04 permissive read повреждённой run history может затереть исходную связь с Task после lost ACK | Существующий safe E2E с отдельным Host process, corrupted history, cold recovery и проверкой отсутствия второй Task |
| Process/platform ownership | Интегрировать уже имеющиеся исправления #1188 до новых изменений; проверить unresolved review на текущем коде | Protocol/controller tests с собственными TEST child processes, scoped Stop, сохранение соседнего процесса |
| Integration and UI | Разрешить конфликты #1187/#1188 с текущим #1186; сохранить новые model/default/source settings | Компиляция TypeScript 7, текущие focused suites, разрешённые Electron/emulated journeys |

Новые исправления должны менять только подтверждённые расхождения. Не вводить
новый scheduler, credential store, process manager или параллельный UI. Изменение
D делается в исходном provider repository; frontend получает неизменяемый
проверенный пакет, без ручной правки vendored `dist`.

## Критика и порядок интеграции

1. R1: перечитать актуальные HEAD и original failed jobs. Тело PR и исторический
   PASS не заменяют проверку текущего source. Отличить уже исправленное в child
   PR от отсутствующего product behavior.
2. R2: независимые владельцы проверяют соответствие старому handler, границы
   authority и отказные пути. Исправление не должно превращать UNKNOWN в
   known-not-sent, запускать повторное действие или придумывать capability.
3. R3: после объединения проверить текущий diff и affected boundaries. Не
   повторять дорогую матрицу ради количества; повторить конкретный затронутый
   путь. Эмуляция не доказывает vendor authentication или native compatibility.

Для каждого исправления сохраняется failing-before / passing-after, если
существующий harness воспроизводит дефект. Unit additions ограничены опасными
инвариантами. Проверка пользовательского сценария имеет приоритет над тестами
getter/helper и количеством строк.

Предварительная оценка двух подтверждённых product fixes: 70–115 production LOC,
70–120 строк в существующих проверках; сложность 4/10, надёжность решения 8/10,
уверенность в диагнозе 9/10. Разрешение конфликтов и исправления по результатам
platform проверки оцениваются отдельно после чтения child diff.

## Критерии завершения этого среза

- Устранены подтверждённые потери функционала без выключения прежних controls.
- Все опубликованные изменения привязаны к точному SHA и проверенному D archive.
- Выполнены необходимые допустимые E2E/интеграционные проверки и независимый
  review; очереди, SKIP, source-only review и исторические результаты разделены.
- Остаточные незавершённые native/platform пункты названы прямо. До их фактической
  проверки общий перенос не помечается полностью квалифицированным.
- #982 остаётся вне main; ни release, ни default-path switch не выполняются.

## Проверенные исправления и текущая приёмка

- **P04:** повреждённая или нечитаемая история runs больше не считается пустой.
  До исправления существующий safe E2E принимал повторный trigger после lost ACK;
  после исправления он отклонён до записи/dispatch, исходные bytes и Task сохранены.
  Отсутствующий файл по-прежнему означает первый запуск. Срез опубликован в
  `0805eff6914564f4541b1da3c2cab16197c8ba1f`; 193 затронутые проверки прошли без skips.
- **P05:** безопасные OpenCode variant IDs проходят D → Host → Main. Existing
  selector получает только `low/medium/high`, допустимые прежним OpenCode IPC
  контрактом; неизвестные/disabled значения и private configuration не предлагаются.
  Provider source `ce03c60d620bfc6152623597637971ca8c529469` проверен `pnpm check`
  на Node 24.21.0 и 26.11.1 в [CI 43473901596](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/43473901596).
  Frontend использует исходный checked artifact; ZIP и оба package digests
  перепроверены. Пакет contracts остался byte-identical.
- **P08/P09:** CapturedProcess сохраняет точность inode и nanosecond timestamps.
  Linux custody сравнивает signed Node Stats и unsigned C identity по тем же
  64 битам с явной проверкой диапазона. Исходный Linux native fixture отказал на
  high-bit inode до исправления; после него original Stop, cold lookup, соседний
  процесс, namespace/session negatives и cleanup прошли на собственных C/Node
  процессах. Это не закрывает отдельное окно между path verification и exec.

После установки нового checked D объединённый Host собран TypeScript 7.0.2.
Account/config acceptance прошла в текущем integration checkout на Node 24.21.0:
6 существующих файлов, 44 PASS, 0 FAIL, 0 SKIP; отдельно OpenCode management —
10 PASS, 0 FAIL, 0 SKIP. Это actual Main IPC → отдельный Host → TEST protocol/HTTP
peer с shutdown/readback и подтверждённым отсутствием 18 дочерних TEST процессов.
Видимый renderer control этой группой не заявляется. Независимое source review
проверило effort predicate и точное сравнение process identity.

Новая отдельная `Host Emulated Acceptance` workflow разрешает Draft PR и только
исходные offline Team/Taskboard modes. До fixture preparation она отклоняет
любые inherited native/scenario selectors, проверяет отсутствие runtime и
management profiles, сохраняет source hashes, исходные screenshots и receipts.
Неожиданный sentinel вызов или незавершённая очистка делает проверку INCOMPLETE.
38 проверок admission/CDP/startup прошли локально; actual Desktop результат
остаётся открытым до выполнения CI и просмотра исходных screenshots.
Existing native/required workflows и production admission не ослаблены.

Текущая инструкция допускает эмуляторы как проверку frontend-функциональности
платных агентов. Такие результаты учитываются как emulated functional acceptance;
они не переименовываются в vendor authentication/native compatibility. Историческое
требование native runtime в старых разделах планов не запрещает эту разрешённую
проверку. Любой оставшийся product defect рассматривается отдельно от отсутствия
разрешения на native vendor run.

## Текущий опубликованный срез и отдельные границы приёмки

Проверенный пакет providers обновлён до
`68dca527b779ebb82923f30d7b08441085d8b579` из PR provider #8.
Его штатный [CI 43479531998](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/43479531998)
прошёл на Node 24.21 и 26.11.1; архив и пакет повторно проверены перед
frozen установкой во frontend. Nullable Codex account email и неизвестные
approval payloads обрабатываются явно; ненеготированный humanCommand не
получает автоматическое разрешение. Исходные реальные Codex/Claude не запускались.

P06 опубликован в `26043bb6`: установка пишет новую неизменяемую директорию,
ready появляется после принятия source исходным Host, а ошибка выбора остаётся
повторяемой явным действием пользователя. Прежние retained bytes и активные
receipts не переназначаются. Проверены реальные Main IPC/source-переходы,
renderer-consumers и обе конечные Codex protocol revisions 0.162/0.169.

P08 phase 1 опубликован в `0233b1b6`: finite account/auth/model/MCP операции,
отдельные scheduled runs и native version qualification получают исходный
Main process port. 25 проверок маршрутизации/MCP, Main selection, Host build,
test types, targeted lint и source caps прошли. Фактическая Windows-матрица
ожидает штатный CI; dynamic source admission phase 2 остаётся отдельной работой.

Codex TEST peer прошёл actual Host → checked D → Node child → original MCP:
preflight, partial/final, Allow/Deny, question answer/decline, protocol interrupt,
local /cost без нового input, Runtime Stop и отсутствие всех исходных peer PID.
Существующий Desktop harness теперь проводит Launch, Composer, те же решения,
Stats/Logs, renderer reload, task-first Schedule Add/Edit/Pause/Resume/Run now/
Delete и Team Stop через исходные controls. Он сохраняет 14 оригинальных PNG,
receipt и точный source. Source/type/guard checks прошли; actual Electron
и визуальная проверка ещё не заявляются. Standalone schedules и Claude/V1
conversation имеют отдельные оставшиеся сценарии.

Разрешённый настоящий OpenCode 2.1.4 уже дал отдельные PASS для embedded Team,
captured MCP и permission lifecycle на предыдущем точном source `96bb78f4`.
Эти receipts не приписываются текущему HEAD. После исправления same-ID
integration и exact variant catalog повторная credential/model-probe приёмка
на новых source остаётся INCOMPLETE из-за неожиданного завершения Host;
сохраняются неуспешные receipts, проверяются исходный сигнал и память процесса.
Ни timeout, ни cleanup assertion ради зелёного результата не ослаблены.
