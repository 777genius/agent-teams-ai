# Завершение frontend parity: 13 ноября 2026

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
