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
