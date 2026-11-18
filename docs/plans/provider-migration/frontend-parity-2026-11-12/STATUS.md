# Завершение Host / frontend parity

Обновлено: 18 ноября 2026. Это текущий рабочий план и краткий статус.
Исторические планы и receipts остаются по прежним ссылкам; их статусы не
переносятся автоматически на новое дерево.

## Цель и границы

Завершить согласованный перенос в изолированный Host с сохранением работающих
возможностей текущего Desktop frontend для Claude, Codex, OpenCode V1/V2.
Поручение от 18 ноября: работать автономно и параллельно, вести один актуальный
план, не дублировать реализацию, сразу публиковать коммиты и проверять изменения
end-to-end без повторения неизменённых дорогих матриц.

Stage 2 / замена ядер остаётся отложенной ([решение](https://github.com/777genius/agent-teams-ai/pull/1105#issuecomment-6771443351)).
Release и включение Host по умолчанию не являются частью этой реализации.
Реальные Claude/Codex не запускаются: используются существующие protocol peers;
OpenCode проверяется существующим pinned localhost model сценарием.
Не ослаблять source/owner/currentness/cleanup/UNKNOWN проверки ради зелёного CI.

Исходные refs: app #1192 `9a8d7ffd8e680d7e951b671f0d39a4585e6c1926`,
main `3ba3475559c1052d799732bb61badd9da5d54164`,
provider #8 `f5d632a6122df2f6995451bd33e6a0fbcda67680`.
Основной путь доставки: #1192 → #1186 → #982; результаты дочерних PR проверяются
по содержимому. Исторические CI snapshots не сливаются механически.

## Единственный текущий список работы

| ID | Состояние | Остаток и критерий готовности | Исполнитель |
| --- | --- | --- | --- |
| F1 | В работе: реализация | Согласованно интегрировать текущий main; ReviewFlow settings/defaults/overrides, human approval и Lead sign-off проходят через действующего Host owner, общий controller и историю/MCP. | frontend_parity; интеграция root |
| F2 | В работе | Перенести проверку reviewer clarification в Host policy до назначения review work; сохранить re-export старого пути. | frontend_parity |
| M1 | В работе: реализация | Восстановить поддерживаемые текущим frontend MIME/размеры вложений V2 и точно отразить возможности model+transport в UI; исходники провайдера меняются только в provider repo, приложение получает проверенный immutable artifact. | stage2_v2 |
| E1 | Частично готово | 8 лишних assertions и 2 import/export-order ошибки исправлены; далее исправлять только установленные причины Create/import/retained/Resume/installer/Add сценариев. | pr_graph; product ownership root |
| W1 | В работе: две причины | x64 расходует readiness lease на повторные проверки namespace/source; ARM64 успевает выполнить 5 из 6 MCP probes до остановки harness. В обоих исходных артефактах итоговый cleanup подтверждён; требования currentness сохраняются. | pr_graph; root |
| P9 | Открыто: контракт | Установить выполнимую границу original-path / writer / consumed bytes; текущую гарантию не сужать без явного решения. Независимые работы продолжаются. | root |
| D1 | Запланировано | Свести изменения в одну композицию, провести независимое ревью, затронутые E2E и обязательные gates; обновить этот статус фактическими SHA/результатами. | root |

Уже реализовано, повторная разработка не требуется: базовый Host/Session SPI,
embedded V2 2.1.4, Logs/Thinking/source/filter/fullscreen/stderr, accounts/models,
native suggestions, schedules, live membership и retained launch.
Наличие реализации не заменяет приёмку её текущего интеграционного пути.

## Объём и риски

Строки — новое/существенно изменённое рукописное содержимое. Готовые изменения
main, generated файлы, архивы и исторические evidence в оценку не входят.

| Срез | Продукт / тесты, LOC | Сложность / надёжность подхода / уверенность, из 10 |
| --- | --- | --- |
| F1 ReviewFlow | 800–1600 / 500–1000 | 7 / 8 / 7 |
| F2 clarification | 20–80 / 80–180 | 3 / 9 / 8 |
| M1 media parity | 600–1400 / 500–1100 | 7 / 7 / 5 |
| Общие readiness/lifecycle + membership | 0–1100 / 200–600 | 7 / 7 / 4 |
| W1 Windows | 0–650 / 250–650 | 8 / 7 / 4 |
| Остальная main integration | 0–150 / 0–150 | 4 / 8 / 7 |
| Lint / test / CI glue | 0 / 100–300 | 3 / 9 / 6 |

Итого без P9: 1420–4980 product + 1630–3980 tests/CI.
Нулевой нижний предел означает резерв диагностики: причина может оказаться
только в TEST-коде. Пересекающиеся исправления считаются один раз.
P9 не имеет подтверждённого конечного LOC до решения о контракте;
[имеющаяся записка](40-p09-source-writer-decision-2026-11-16.md) сохраняет оба
невыбранных направления и их ограничения.

## Параллельная работа без дублирования

- Root — единственный writer ref и index приложения. Исполнители редактируют
  непересекающиеся файлы общего checkout; provider имеет отдельный checkout; каждый созданный commit
  сразу публикуется обычным fast-forward с expected SHA.
- F1/F2 владеют review/work-sync контрактами и owner adapters. M1 владеет V2
  media port и capability projection. E1/W1 владеют конкретными TEST/CI и
  установленными process/readiness исправлениями.
- Общий файл получает одного владельца до редактирования. Новая информация
  вносится сюда; отдельные планы с тем же scope не создаются.
- При движении удалённой ветки перечитать новый HEAD, сохранить чужие изменения
  и согласовать пересекающийся diff; force push и подмена истории запрещены.
- Сохранять текущие owners, storage, controller policy и UI. Не создавать
  параллельный scheduler, auth owner, event bus или реализацию ReviewFlow.

## Минимальная достаточная проверка

1. R1: проверить scope, реальные точки владения, существующий код main/provider
   и критичные границы до реализации. R2: независимое ревью конкретного плана/diff;
   исправить подтверждённые замечания и записать результат ниже.
2. Для среза: pinned TypeScript 7, затронутые lint/architecture guards,
   точечные тесты существенных правил и существующий E2E пользовательского пути.
   Не добавлять unit tests для простого переноса/форматирования.
3. Существующие успешные оригинальные результаты использовать на неизменённых
   границах после review diff. Повторять затронутые проверки, не все исторические
   матрицы на каждое изменение документации.
4. Очередь/skip/cancel/UNKNOWN не являются PASS. Во время CI продолжать
   независимую работу; не запускать дублирующие workflow.
5. Итоговая приёмка относится к собранному дереву и затронутым provider artifacts;
   обязательные GitHub gates сохраняются. Не считать source review native PASS.

## Проверенные исходные результаты

- App `9a8d7ffd`: все 4 frontend shards SUCCESS.
- Все 5 packaged platform jobs SUCCESS; aggregate проверяется отдельно.
  [Run 44314176630](https://github.com/777genius/agent-teams-ai/actions/runs/44314176630).
- Process fixtures: Linux/Darwin x64/ARM64 SUCCESS; Windows x64/ARM64 FAILURE
  в разных сценариях. [Run 44314176538](https://github.com/777genius/agent-teams-ai/actions/runs/44314176538).
- V2/SPI/static: 7 SUCCESS, обе Darwin mutation lanes FAILURE.
  [Run 44314176336](https://github.com/777genius/agent-teams-ai/actions/runs/44314176336).
- Host Desktop содержит реальные отказы; full E2E не принят.
  [Run 44314176310](https://github.com/777genius/agent-teams-ai/actions/runs/44314176310).
- Старые registration/settlement замечания #1188 и token-identity #1227 уже
  исправлены в текущем коде и повторно в backlog не включаются.

## Журнал текущей реализации и ревью

- 18 ноября, R1: root сверил актуальные app/main/provider SHA, граф PR и исходники.
  Устранены двойной подсчёт merged дочерних PR и ошибочное включение Stage 2.
  Разделены реальные gaps F1/F2/M1 и резерв диагностики E1/W1; P9 выделен отдельно.
- 18 ноября, R2 F1/F2: сохранить единый controller; различать human grant и
  переданное имя; проверять current review request. Глобальные defaults читаются
  из доверенного Main источника, входят в read-only snapshot/preimage и повторно
  проверяются перед publish; не расширять task write allowlist и не копировать
  глобальные defaults в team overrides. Старые work-sync paths остаются re-export.
- 18 ноября, R2 M1: native 2.1.4 поддерживает PNG/JPEG/GIF/WebP и PDF, но сам
  отбрасывает video. UI должен честно показать эту границу. Нормализация изображения
  может изменить байты: приватный authenticated native receipt связывает исходный
  digest, фактический normalized digest, session/input и captured child generation;
  ACK/history и cold restore проверяют его. Raw/text-only wire limits не повышаются.
- 18 ноября, R2 W1: финальные receipts обоих Windows jobs подтверждают cleanup;
  промежуточная false строка не считается утечкой. x64: повторное полное обследование
  съедает lease; ARM64: шесть физических MCP probes вокруг одного запуска съедают
  окно наблюдения. До подтверждённого решения нижняя оценка product LOC равна 0.
  Memoization и ослабление проверок по одним таймингам не принимаются.
- 18 ноября, R2 приёмки: исходные packaged PASS переиспользуются только для
  доказанно неизменённых boundaries; изменение imports/composition требует review.
- 18 ноября: текущий main интегрируется; 21 текстовый конфликт разрешается
  предметно, с сохранением disapprove, human approval, lead sign-off и Host routing.
  Root разрешил 8 UI/worker/IPC конфликтов; остальные review/work-sync у F1/F2.

- 18 ноября, E1: изолированно исправлены 8 избыточных non-null assertions и
  2 import/export-order ошибки. Root проверил точный diff; fast ESLint трёх файлов
  и diff --check PASS, TypeScript pin 7.0.2. Первая typed ESLint попытка прервана
  OS (137), поэтому typed PASS не заявляется. Поведение не менялось.
