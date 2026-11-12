# P10. Приёмка существующего frontend, обновление и восстановление

Статус: план; R1 выполнен, R2/R3 ожидаются. Реализация и новая приёмка не объявлены.

## 1. Что сохраняем и на что опираемся

Проверяем привычный путь Settings → Create/Launch → Tasks/messages/tools →
Review/Processes → Stop/Quit → повторный запуск приложения/Resume. Сохраняем
существующие команды, данные, attachments, выбор модели и историю. Отдельный
тестовый экран или прямой API-вызов вместо original control не доказывает UI parity.

База старого frontend: [`4a0e062`](https://github.com/777genius/agent-teams-ai/tree/4a0e06277fe216d9f82dbbede362668fe46622ee).
Новая исходная база: [`1d0f97f`](https://github.com/777genius/agent-teams-ai/tree/1d0f97f55de566036c970eab4f36b84620afdb3f).

Переиспользуем готовые сценарии и реальные границы их доказательств:

- [desktop-retained-opencode-coexistence.native.ts](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/scripts/legacy-agent-host/desktop-retained-opencode-coexistence.native.ts): прежний владелец и новая команда рядом;
- [desktop-native-review-ui-smoke.ts](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/scripts/legacy-agent-host/desktop-native-review-ui-smoke.ts) и соседние continuation/readback helpers: реальные Read/Edit, Keep/Reject/Undo/Redo и cold history;
- [desktop-native-quit-ui-smoke.ts](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/scripts/legacy-agent-host/desktop-native-quit-ui-smoke.ts): обычный Quit и восстановление;
- [desktop-native-process-ui.ts](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/scripts/legacy-agent-host/desktop-native-process-ui.ts): исходный Processes UI;
- [зафиксированная предыдущая приёмка](https://github.com/777genius/agent-teams-ai/pull/1110#issuecomment-6810678279): полезна как regression baseline, не заменяет новые проверки P01–P09.

Есть существенная готовая база; переписывать Teams, Tasks, сообщения или Review
ради новой серии тестов не нужно. Дополнительный production-код здесь — резерв
на найденные регрессии, а не заранее запланированная новая подсистема.

## 2. Подтверждённые границы предыдущих доказательств

1. Пять native/packaged OpenCode V2 tuples не равны пяти полным Desktop journeys:
   прежние receipts явно отделяют native Host от `desktopJourneyQualified`.
2. Основные source UI journeys выполнялись на macOS ARM64. Их PASS не переносится
   на Windows Claude/Codex/V1 и Windows/Linux Processes из P08/P09.
3. Stopped legacy import проверен на синтетических прежних записях. Нужна небольшая
   репрезентативная коллекция данных, созданных действующим старым frontend.
4. Retained coexistence не доказывает весь опубликованный старый runtime:
   `publishedRuntimeComplete=false` должен сохраниться в старом отчёте.
5. Review уже имеет реальный proof поддерживаемых Read/Edit путей. Универсальный
   Undo любого Bash/background side effect не добавляем, если старый frontend
   тоже не предоставлял проверяемого такого поведения.
6. Localhost model fixture подтверждает связку с реальным runtime, но не вход
   в аккаунт vendor. Симуляцию OAuth нельзя назвать успешным vendor login.

## 3. Минимальный состав изменений

- Расширить существующие scripts/legacy-agent-host fixtures и UI journeys только
  сценариями, которые появились в P01–P09 или закрывают конкретную границу выше.
- Сохранять нынешний формат receipts, source pins, attachments и screenshots.
  Не создавать новый E2E framework, dashboard, runner service или общую DSL.
- В существующем CI связать необходимые scenario jobs с одним интеграционным SHA.
  Сохранить отдельные результаты provider/OS; зелёный агрегатор не должен скрывать
  пропущенную обязательную строку.
- Исправлять обнаруженный дефект в владельце соответствующей функции, а не
  обходить его через harness, искусственные waits, повторный prompt или новый UI.
- Для недесктопных операций с существующим HTTP API выполнить один smoke через
  этот adapter к тому же use case. Не делать полную вторую UI матрицу браузера.

## 4. Пошаговое выполнение

### A. Установить конечный список сценариев

1. Собрать E2E IDs из P01–P09; убрать дубли одинаковых setup/recovery цепочек.
2. Для каждого ID записать существующий UI control, ожидаемый внешний эффект,
   provider/OS и место сохранения доказательства. Отдельно отметить native и UI.
3. Сохранить список в обычной Markdown таблице в этом плане или существующем
   evidence README; не вводить schema/генератор ради маленького статичного списка.
4. Выбрать по одному репрезентативному позитивному и критичному failure/recovery
   сценарию каждого изменяемого контракта. Расширять только по найденному риску.

### B. Подготовить данные старого приложения

1. В disposable TEST HOME/project запустить зафиксированный старый frontend/runtime.
2. Через существующий UI создать saved team, выполнить короткую задачу/сообщение,
   получить Review change, остановить команду и закрыть приложение.
3. Сохранить минимальный очищенный corpus: необходимые team/session/config/Review
   файлы, версия producer и checksum; исключить secrets и данные реальных проектов.
4. Отдельно получить interrupted/UNKNOWN case в управляемом sandbox, если он
   затрагивается новой реализацией. Не редактировать JSON так, чтобы выдать
   синтетическую запись за фактически созданное старым приложением состояние.

### C. Выполнить upgrade/recovery journeys

1. На копии corpus открыть новый frontend; проверить saved teams/history/models.
2. Импортировать остановленную команду штатным путём и запустить новый Host run.
3. Проверить task/message/attachment identity, Review history и настройки.
4. Сделать обычный Quit; после старта прочитать историю без нового model request.
5. Выполнить Resume там, где он поддерживался; убедиться в отсутствии дубликатов
   задач, сообщений, login operations и scheduled side effects.
6. В отдельном запуске оборвать подтверждение одной принятой операции, перезапустить
   процесс и проверить readback/reconcile. Не отправлять её повторно автоматически.

### D. Проверить собранное приложение на затронутых OS

1. Использовать существующие native jobs и сборку приложения с точными dependencies.
2. Для каждой поддерживаемой платформы выполнить короткую сквозную цепочку:
   обнаружение runtime → Launch → native tool → Stop → холодное чтение истории.
3. На Windows отдельно выполнить Claude/Codex/V1 из P08, а не только V2.
4. На Windows/Linux выполнить Process registry/health/Stop из P09, включая
   выживание чужого процесса и доказанное завершение принадлежащих потомков.
5. В полном macOS UI journey проверить новые controls P01–P07; на других OS
   повторить платформенно зависимые controls, OAuth callback/device flow,
   installer и сохранение путей. Не умножать все pure UI cases на все tuples.
6. Визуально просмотреть screenshots новых состояний: прогресс, cancel, ошибка,
   повторная попытка, отключённое действительно неподдержанное действие.

## 5. Обязательные E2E истории

| ID | Сценарий | Что является успехом |
| --- | --- | --- |
| A10-01 | Старый frontend создал stopped team → новый импорт/Launch | Сохранённые параметры/история доступны; новый run имеет нового явного owner |
| A10-02 | Изменение runtime/model/account → active run + следующий launch | Активный run сохраняет binding; новый получает выбранную конфигурацию |
| A10-03 | Task + DM + attachment → tool result → Quit → cold history | Исходные IDs/bytes и результат читаются без повторного inference |
| A10-04 | Read/Edit → Keep/Reject → Undo/Redo → restart | Файлы и Review UI согласованы; чужие изменения не присвоены задаче |
| A10-05 | Lost acknowledgement у принятого действия → restart | Reconcile показывает фактический результат; второй side effect не создан |
| A10-06 | Packaged native launch/tool/Stop на затронутых tuples | Настоящий adapter/процесс; все принадлежащие потомки остановлены |
| A10-07 | Existing HTTP adapter для изменённого недесктопного use case | Те же правила и ошибки, что у IPC; отсутствует обход владельца |
| A10-08 | Старый retained run рядом с новой Host-командой | Старый владелец сохранён; targeted stop не затрагивает соседа |

Provider-specific login, schedules, commands, model и Processes cases остаются
в своих планах; здесь не создаются их вторые копии.

## 6. Точечные тесты и бюджет

Новые unit-тесты по умолчанию не нужны. Если E2E выявит ошибку чистого decoder,
identity/dedupe или правила восстановления, добавить минимальный regression case
рядом с исправляемым кодом. Не тестировать mock call order, каждый receipt mapper
или наличие строк в исходнике. Для link/checksum проверки документов достаточно
разового проверочного скрипта, не нового обязательного suite.

Оценка новых/существенно изменённых строк:

- production: **500–1 500 резерв исправлений**, без переписывания работающего ядра;
- интеграционные/E2E helpers и scenarios: **700–1 300**, с reuse существующих harness;
- units: **0–100** только при выявленном конкретном опасном инварианте;
- сложность: **7/10**, ожидаемая надёжность решения после приёмки: **8/10**,
  уверенность оценки объёма: **6/10**.

Эти числа — ориентир планирования, не цель по строкам и не вероятность отсутствия
багов. Повторные матрицы оправданы изменённым native контрактом или конкретной
оставшейся регрессией; ожидание runner само по себе не повод для перезапуска.

## 7. Зависимости, review и критерии завершения

P10 исполняется частями после готовности вертикальных срезов P01–P09. Общую
CI-композицию и acceptance manifest изменяет координатор, чтобы параллельные
авторы не размножали jobs или разные версии одного fixture. Сценарии, доступные
до завершения зависимостей, выполняются сразу в sandbox.

Финальная запись содержит exact SHA, package/runtime versions, OS, scenario IDs,
результат каждого обязательного job, original receipt/screenshots и cleanup.
Не считать queued/running/skipped успехом. Vendor login без test account остаётся
отдельным непроверенным свойством; сначала проверить доступные штатные test routes
и выполнить остальную работу, а не останавливать весь план заранее.

Готовность: все обязательные истории проходят, обнаруженные дефекты исправлены,
existing controls сохранены, независимое ревью текущего diff закрыто. PR остаётся
в пределах Stage 1; merge в `main`, релиз и переключение default не выполняются.

| Круг | Реальное замечание | Исправление / статус |
| --- | --- | --- |
| R1 | Предыдущая оценка смешивала новые features и резерв дефектов, а также native package proof и полный UI | Резерв выделен; сценарии разделены; existing harness переиспользуется; unit-бюджет сокращён до конкретных регрессий |
| R1 | Полная матрица каждого control на каждой OS избыточна | Полный representative UI + native platform-sensitive subset; матрица расширяется по конкретному риску |
| R2 | Независимое ревью | Ожидает |
| R3 | Интеграция с P01–P09 и реальными CI jobs | Ожидает |
