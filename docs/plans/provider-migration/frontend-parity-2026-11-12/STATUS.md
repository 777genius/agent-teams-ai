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
| F1 | Реализация и R2 готовы; UI E2E остаётся | Main интегрирован. Settings/defaults/overrides, human authority и Lead cycles используют текущего owner/controller. Существующий task-board UI journey дополнен default → override → inherit → Approve → reopen; нужен исполненный результат. | reviewflow; root |
| F2 | Реализация и focused contracts готовы | Canonical Host agenda блокирует review work при lead/user clarification до review cycle; старый app path — re-export. Agenda 26/26 и cycle 3/3 PASS. | reviewflow |
| M1 | Реализация, R2 и package checks готовы; native E2E остаётся | Provider `aad5c2f8` и immutable archive интегрированы: PNG/JPEG/GIF/WebP/PDF, 5 файлов / 4 MiB каждый / 8 MiB суммарно, model modality gates. Existing native journey дополнен normalization и cold readback; нужен фактический результат. | media; root |
| E1 | Исправление готово; E2E остаётся | Полный status wire finite peer исправляет отказ Create/import; 2 contract checks PASS. Остальные исходные Create/import/retained/Resume/installer/Add journeys требуют текущего результата. | pr_graph; product ownership root |
| W1 | x64 исправление готово; ARM64 открыт | Синхронное чтение configured key входит в прежнюю closing freshness-проверку; 36 focused checks PASS. ARM64: 6 последовательных MCP probes не укладываются в исходные 15 секунд. Итоговый cleanup подтверждён; deadlines и currentness сохранены. | pr_graph; root |
| P9 | Открыто: контракт | Установить выполнимую границу original-path / writer / consumed bytes; текущую гарантию не сужать без явного решения. Независимые работы продолжаются. | root |
| D1 | В работе | Свести изменения в одну композицию, провести независимое ревью, затронутые E2E и обязательные gates; обновить этот статус фактическими SHA/результатами. | root |

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
  ACK/active history проверяют его. Cold checkpoint сохраняет session identity и
  media revision; повторная аттестация всех прошлых ACK после restart не заявляется.
  Raw/text-only wire limits не повышаются.
- 18 ноября, R2 W1: финальные receipts обоих Windows jobs подтверждают cleanup;
  промежуточная false строка не считается утечкой. x64: повторное полное обследование
  съедает lease; ARM64: шесть физических MCP probes вокруг одного запуска съедают
  окно наблюдения. До подтверждённого решения нижняя оценка product LOC равна 0.
  Memoization и ослабление проверок по одним таймингам не принимаются.
- 18 ноября, R2 приёмки: исходные packaged PASS переиспользуются только для
  доказанно неизменённых boundaries; изменение imports/composition требует review.
- 18 ноября: текущий main интегрируется; 21 текстовый конфликт разрешён
  предметно, с сохранением disapprove, human approval, lead sign-off и Host routing.
  Сохранены единые work-sync re-exports и shared history helpers.
  ReviewFlow/Lead sign-off: 56 PASS; controller review/briefing/disapproval: 46 PASS;
  history: 3 PASS; clarification/cycle/status-detail: 7 PASS. Ledger, controller и
  Host build PASS под Node 24.21 / TypeScript 7.0.2. Нативные Host команды и
  captured-owner настройки F1 остаются в следующем срезе.

- 18 ноября, E1: изолированно исправлены 8 избыточных non-null assertions и
  2 import/export-order ошибки. Root проверил точный diff; fast ESLint трёх файлов
  и diff --check PASS, TypeScript pin 7.0.2. Первая typed ESLint попытка прервана
  OS (137), поэтому typed PASS не заявляется. Поведение не менялось.

- 18 ноября, продолжение после переноса чата: опубликованное объединение main
  `d269cf9b20b783717044a3da03643f66f1b93ebd` проверено по tree
  `f2555b2edaa8f80788a1d5c535dad5ad55b1608a`; все незапушенные F1/M1/E1
  изменения восстановлены без повторного merge. Root остаётся единственным writer.
- 18 ноября, E1/W1 R2: `reviewflow` и root проверили точный readiness diff.
  Configured key вычисляется внутри существующего capture callback до closing
  source/owner observation. Последующие account/policy/target fences сохранены.
  Под Node 24.21.0: OpenCode configuration + saved model readiness 36/36 PASS;
  finite status `--summary`/full 2/2 PASS, включая production отказ partial response;
  scoped fast lint и diff check PASS. Native Windows результат ещё не заявлен.
  Незапушенное увеличение ARM TEST deadline с 15 до 90 секунд исключено; исходные
  15 секунд сохранены. Отдельного подтверждённого ARM исправления пока нет.

- 18 ноября, F1/F2 R2: независимое ревью нашло и подтвердило исправление двух
  ошибок lost-ACK: настоящий structured `code` вместо `reason` и lookup исходного
  commandId также при structured `outcome: unknown`. Frozen original handle,
  запрет replay mutation и сохранение unknown при неудачном lookup проверены
  в 10/10 renderer routing checks. Host ReviewFlow integration 7/7, UI Section
  12/12, store 9/9 PASS; Host test types и legacy-host script types PASS на
  pinned TS 7.0.2. Глобальные defaults не записываются в team override.
  Добавлен оригинальный UI journey через Settings/Approved и reopen; R2 PASS,
  исполненный GUI E2E пока не заявлен. Source roster разбит без потери pins.
- 18 ноября, E1 CI R2: ready-PR job теперь использует существующие finite
  Claude/Codex protocol peers и original login/runtime/schedule UI modes;
  реальные vendor binaries удалены из этого job. Required gate, deadline,
  original-command, real cron-tick, no-replay и cleanup проверки сохранены.
  Общий input capture вынесен в composite action byte-for-byte. Workflow-policy
  17/17, YAML parse, shell syntax и независимое review PASS.
- 18 ноября, W1 Unicode fixture: batch source стал ASCII; `%~dp0` и captured
  environment сохраняют Unicode paths и исходные argv. Fixture native copy
  создаётся и проверяется до capture; production source/P9 не изменены.
  Actual launcher capture/verifier 5/5, pinned Node syntax и diff check PASS;
  нового Windows OS E2E результата нет.
- 18 ноября, ограничения локальной проверки: полный app workspace typecheck
  дважды остановлен с exit 137 без TS diagnostics (включая bounded heap run).
  Это не PASS; узкие успешно завершённые проверки выше сохраняют свой scope.

- 18 ноября, публикация: E1/W1 `26d1600d`, F1/CI/Unicode `88cc5828` и provider
  `aad5c2f8bedc7782f6d5f3746a47b74f0c3735d6` опубликованы сразу после commit.
  Provider tree `a2d6de72a62c778642b207dff5939d1e1cc9ff43` clean; retained
  archives сверены с 252 implementation + 10 SPI dist files. App получает новый
  immutable каталог `v2-media-aad5c2f8`; старые archives не менялись.
  Frozen pnpm 11.22 install и 2533 supply-chain checks PASS.
- 18 ноября, M1 R2: private authenticated receipt связывает исходный prompt body,
  фактическую normalization, original child/session/input и конечный deadline.
  Native limits: 5 файлов всего, 4 MiB/source, 8 MiB/source total; public/raw
  budgets не повышены, video не рекламируется. PDF допускается только при model
  modality и сохранении исходных байтов. Unsupported media не превращается в reference.
  Source build/types и original packed consumer PASS; первоначальный source run
  577/577, финальный 576/577 с unchanged Codex fixture timing failure, затем
  original Codex file 4/4 и affected suites 19/19 PASS. Полный `pnpm check`
  одним непрерывным зелёным run не заявляется. App media 19/19 и native harness
  targeted TS 7.0.2 PASS. Native execution ещё остаётся.
- 18 ноября, review closure: 23 подтверждённо исправленных #1192 threads resolved
  после source/R2 аудита. Для failed Host acceptance установщика добавлен regression
  warm/cold status: принятой остаётся старая revision/version; при отсутствии
  подтверждённой версии другой installed candidate не даёт ready. 34/34 PASS
  (Node 24.22.3); source не менялся. Root R2 и diff check PASS.
- 18 ноября, текущая E2E диагностика: Darwin ARM Resume job 134984181853
  ([run 44356006994](https://github.com/777genius/agent-teams-ai/actions/runs/44356006994))
  остановился на original preflight до Resume. Probe cleanup подтверждён;
  внутренние 30 секунд startup расходуются в том числе на graph verification
  (~23 секунды). Диагностика безопасного parallel inventory продолжается;
  deadline и graph/source проверки не ослаблены.

- 18 ноября, E1 graph R2: независимые каталоги проверяются ограниченными batch
  по 12, только после принятого parent read. Каждый исходный batch полностью
  settles до отказа или следующего чтения. Сохранены symlink/unlisted/type/count,
  per-file fd/stat/hash/mode, abort и closing manifest checks; cache не добавлен.
  На тех же 24 664 files / 5073 directories: inventory 2095 → 583 ms, full
  verification 8473 → 6430 ms (Linux Node 24.21). File phase не менялась;
  её часть разницы timing не считается отдельным улучшением. Original + extended
  graph invariants 12/12 PASS, root R2 PASS. Darwin startup qualification остаётся.
- 18 ноября, full typecheck: дополнительный diagnostic run с реальным native
  compiler и GOMEMLIMIT=768MiB/GOGC=50/GOMAXPROCS=2 также exit 137 без TS
  diagnostics. Ledger и Host prebuild прошли; полный workspace gate не подтверждён.
  Новые тяжёлые локальные повторы не запускаются; successful narrow checks
  сохраняют только свой указанный scope.

- 18 ноября, actual native `199fef38` (Linux x64, OpenCode 2.1.4): исходный
  source/build/archive gate прошёл; coordination/readiness PASS с 4 model requests
  и подтверждённым cleanup. Business `runtime.open` вернул held/open-unknown
  до первого business model request и до media DM; весь сценарий INCOMPLETE,
  business cleanup=false. Child exit 0 не заменяет подтверждение owner release.
  Наблюдаемый отказ совпал с original readiness cutoff: admission 90 секунд,
  открытие заняло ~25 секунд при отдельном launch budget 120 секунд. Source chain
  сохраняет исходный cutoff до nativeReady; его продление не допускается.
  Следующий срез удаляет только доказанный синхронный повтор closing authority
  read и сохраняет existing refusal diagnostics для точной проверки причины.

- 18 ноября, E1 closing-guard R2: в opening `canAllocate` уже закрывает authority
  перед немедленным синхронным `setupCurrent`; только повтор этого guard удалён.
  Allocated ветка теперь сама выполняет тот же closing guard после Runtime read.
  Никакая проверка не переносится через await; readiness cutoff не меняется.
  Ledger/Host build, 20/20 authority/native-action checks и root R2 PASS.
- 18 ноября, E1 diagnostic R2: passive TEST receipt сохраняет первый исходный
  sanitized runtime-open и consumer refusal с cutoff/observedAt. Hash/ID/raw error
  не записываются; 257 rows / 64 KiB / 512-byte input limit сохранены. Четыре
  observer checks, strict scoped TS 7.0.2 и независимое media review PASS.
  Следующий original native run выполняется на чистом опубликованном срезе.
