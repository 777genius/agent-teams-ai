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
| F1 | Реализация и R2 готовы; UI E2E остаётся | Три original GUI attempts остановлены SIGKILL main SSR до Electron. Найден лишний import edge при чтении profile: та же схема без полной Host composition, −69256 KiB PSS в bounded import check. Следующий original GUI проверяет это изменение. | pr_graph; reviewflow; root |
| F2 | Реализация и focused contracts готовы | Canonical Host agenda блокирует review work при lead/user clarification до review cycle; старый app path — re-export. Agenda 26/26 и cycle 3/3 PASS. | reviewflow |
| M1 | Native E2E PASS на `2f33d566` | Все 8 original steps за 151754 ms: media bytes/4 MiB normalization, 11 model requests, cold history/attachments, restored native readiness, no replay, оба stop custody=released и cleanup=true. Desktop GUI и vendor auth этим результатом не квалифицируются. | media; R2 reviewflow; root |
| E1 | Исходные отказы исправлены; текущий E2E остаётся | Композиция 22 source закрывает HTTP/store cycle, finite metadata, retained authority, trusted input, Kanban и точечные type/test отказы.611 frontend/IPC PASS в 20 файлах по отдельным scoped runs; полный текущий Host/GUI verdict остаётся. | root |
| W1 | x64 исправление готово; ARM64 открыт | Синхронное чтение configured key входит в прежнюю closing freshness-проверку; 36 focused checks PASS. ARM64: 6 последовательных MCP probes не укладываются в исходные 15 секунд. Итоговый cleanup подтверждён; deadlines и currentness сохранены. | pr_graph; root |
| P9 | Открыто: контракт | Установить выполнимую границу original-path / writer / consumed bytes; текущую гарантию не сужать без явного решения. Независимые работы продолжаются. | root |
| D1 | Композиция и независимое ревью готовы; CI остаётся | Все 22 postimages связаны с exact c8 parent, внешние изменения сохранены, source-size policy PASS. Получить результат оригинальных обязательных gates опубликованного среза. | root |

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

- 18 ноября, actual native `747123a6`: source/build/archive gate прошёл;
  coordination и business Host завершились с подтверждённым cleanup, Host exit 0.
  Business `runtime.open` дошёл до проверки capability projection без сохранённого
  runtime-open/consumer refusal. Исходный TEST validator отклонил новое поле
  `nativeMedia`, поэтому ready assertion, первый business model request и DM
  не достигнуты; полный сценарий по-прежнему INCOMPLETE.
- 18 ноября, M1 fixture R2: optional `nativeMedia` проверяется закрытой схемой
  из шести полей, с точной revision, whitelist MIME, modality consistency и
  верхними пределами 4 MiB / 5 / 8 MiB. Прежние boolean/private-key/input
  проверки сохранены; malformed, лишние и несовместимые поля отвергаются.
  Existing attachment suite 12/12 и scoped strict TS 7.0.2 PASS. Два старых
  app assertions учитывают только captured PNG capability и валидный TEST
  binding; исходные seal/revoke/auth, no-byte-read и cleanup проверки сохранены.
  Existing member suite 3/3 PASS после исправления fixtures; независимое R2 PASS.
  Production код, deadlines и отрицательные lifecycle oracles не изменены.
- 18 ноября, F1 UI prerequisites: точный Electron 44.10.1 / ABI 149 и rebuilt
  better-sqlite3 прошли реальный in-memory SELECT 1. Original LinuxNodeExec и
  captured Corepack 0.36.0 / pnpm 11.22.0 inputs подготовлены. Xvfb с исходной
  XAUTHORITY успешно проверен по разрешённому harness localhost TCP пути.
  GUI journey ещё не исполнялся; запланирован после native run без одновременной
  тяжёлой нагрузки и изменения исходных deadlines.

- 18 ноября, actual native `047f002e`: original source/build gates, compound
  readiness и business nativeReady прошли; оба input terminal succeeded, все
  11 business model requests завершились без modelFailures. PNG 4 MiB реально
  нормализован до 159 bytes / 2000×1 с точными red pixels и новым digest;
  PNG/JPEG/GIF/WebP и PDF 589 bytes прошли exact-byte проверки. На сохранённом
  attachment read исходный TEST parser отказал: source API возвращает chunk
  384 KiB, base64 512 KiB, а generic TEST line guard допускает лишь 256 KiB.
  Полный run INCOMPLETE, elapsed 144388 ms; business exit 0 не заменяет cleanup
  (overall false). Cold readback/restore не заявляются как PASS.
- 18 ноября, CI compile follow-up: исходный Darwin x64 process job
  [135015705253](https://github.com/777genius/agent-teams-ai/actions/runs/44364834233/job/135015705253)
  на `747123a6` обнаружил TS2322 в projection `reviewFlow`. Один `as const`
  сохраняет исходные три литерала вместо widened string; runtime не меняется.
  Exact affected CI project `tools/owned-process-broker/tsconfig.retained-host.json`
  прошёл pinned TS 7.0.2; resolved file list подтверждает включение projection.
  Independent R2 и diff check PASS; полный workspace typecheck этим не заменяется.
- 18 ноября, M1 frame R2: TEST parser согласован с уже существующим exact
  384 KiB attachment contract. Только успешный ответ на pending message attachment
  read с исходным digest, закрытыми envelope/metadata, canonical base64 и точными
  offset/nextOffset/byte count может превышать generic 256 KiB. Сохраняются
  исходные 256 KiB для raw envelope без base64 и всех остальных frames, а также
  существующий абсолютный Host limit 1 MiB. Product chunk/upload alignment,
  raw/public provider budgets, deadlines и original native assertions не менялись.
  Регрессии отвергают неизвестный id, другой method, notifications/errors,
  лишние поля, неправильные digest/offset/size, noncanonical base64 и raw padding.
  Existing observer/close suite 5/5, scoped strict TS 7.0.2 и независимое R2 PASS.
  Schema загружается lazily из исходного Host dist после build, сохраняя bootstrap.
- 18 ноября, actual native `19b5bf34`: первый зафиксированный consumer refusal
  имеет phase=cutoff, observedAt на 1527 ms позже original cutoff. Coordination
  PASS с cleanup=true и 4 model requests; business DM не достигнуты. Initial
  graph phase заняла 14236 ms; business probe утратил admission через 24561 ms,
  но продолжил опрос до исходного 120-second launch budget. Run INCOMPLETE,
  elapsed 213504 ms, business exit 1 / stdoutValid=true / cleanup=false.
  Этот run не проверяет новый chunk reader; прежний media delivery PASS не
  переносится на cold recovery. Проверка graph performance продолжается.
- 18 ноября, E1 failed-opening R2: при missing catalog receipt и окончательном
  отказе исходного canAllocate probe теперь сразу выходит через прежний disposal
  и single owned cleanup. Missing receipt при действующей allocation остаётся
  transient; valid receipt не добавляет новых allocation reads. Новый state/cache
  не введён. Existing member suite 8/8, source/test strict TS 7.0.2 и R2 PASS;
  false/throw admission, warmup recovery и sticky stop/dispose UNKNOWN проверены.
- 18 ноября, F1 original GUI `19b5bf34`: main SSR transform в electron-vite
  получил SIGKILL до Electron/CDP/Host, не исчерпав original 180-second startup.
  Receipt INCOMPLETE, cleanup.remaining=[], source freeze сохранён. OOM не
  доказан: у погибшего процесса отсутствовала resource telemetry.
  Первый ограниченный повтор использует существующий exact TEST heap 1536 MiB
  с исходными sourcemaps. Selector явно допущен для task-board-cross-team-ui
  и четырёх finite queue modes с тем же unconditional build: selection, import,
  claude-lifecycle, collaboration. Два прежних finite modes и отдельные native
  guards сохранены; arbitrary modes/flags/ambient NODE_OPTIONS отвергаются.
  Admission → closed environment → real dev normalizer: 6/6 PASS, R2 PASS.
  Все три build/resource helper уже входят в исходный frozen source roster;
  повторные pins не добавлены. Actual GUI acceptance ещё не получена.
- 18 ноября, E1 performance R1: import-equivalent пары unchanged graph verifier
  с parent heap 256/512 MiB не подтвердили улучшение: средние 5.505/5.458 s,
  RSS около 327–328 MiB, GC 126–158 ms; второй run быстрее независимо от heap.
  Actual graph 14.236 s этим baseline не воспроизведён. Graph и parent heap
  не изменены. Следующий конкретный фактор — исходный TEST observation loop
  каждые 25 ms с полным profile/authority read, конкурирующий с graph verification;
  его стоимость и границы проверяются отдельно от production source guards.
- 18 ноября, E1 observer R2: найден и удалён только синхронный дубль полного
  writer/profile/digest guard перед `manager.probes.read`. Сам read первым
  действием выполняет тот же callback через assertAdmission; abort проверяется
  до него, без промежуточного await. Tick 25 ms, producer currentness, original
  deadline, terminal receipt и cleanup проверки сохранены; cache не добавлен.
  Existing revoked-authority case 1/1 PASS, два независимых source review и
  diff check PASS. Влияние на полный native run ещё не измерено.
- 18 ноября, actual native `e114dd13`: coordination PASS / cleanup=true,
  4 requests + 1 metadata, original receipt unchanged; cumulative step 72467 ms
  против 88992 ms в предыдущем run. Ordinary graph 11964 ms, first-submit
  23053 ms. Business owned probe и permissions прошли; initial-context PUT
  вернул 204, первый GET — headers 200 на 23858 ms. Второй GET не начался.
  Business open 65201 ms, held/custody-unresolved; child exit 0, Host exit 1,
  stdoutValid=true, overall cleanup=false, business model requests=0.
  SQLite readback содержит один исходный instruction entry, 694 UTF-8 bytes.
  Headers не доказывают завершение чтения тела; причинный branch ещё неизвестен.
  Missing-catalog fix в этом run не был задействован. UNKNOWN не заменяется
  наблюдаемым выходом ребёнка, пока отсутствует подтверждение полного owner release.
- 18 ноября, F1 GUI resources на `e114dd13`: fixed1536 с исходными картами
  остановлен SIGKILL через 15.1 s, actual Vite RSS peak 448868 KiB. Повтор с
  уже поддерживаемым exact maps-off flag — тот же original main SSR refusal
  через 47.316 s; sampled aggregate PSS peak 1266242 KiB, Vite PSS peak
  646380 KiB, harness PSS peak 308303 KiB. Оба receipts INCOMPLETE до
  Electron/Host/UI, cleanup.remaining=[], source freeze сохранён. OOM-sender
  не установлен. Maps-off меняет debug artifacts main/renderer, не preload;
  идентичность всех build bytes и Sentry qualification не заявляются.
- 18 ноября, E1 readback diagnostic R2: существующий undici trailers observer
  наблюдает только original request objects для log и instructions, с прежними
  scalar/row/byte bounds, без чтения тел и дополнительных native requests.
  Это transport completion перед handler.onComplete, не подтверждение JSON,
  captured current, dispose или application readback. CPU summary отдельно
  считает точные empty-URL VM states GC/program; старые индексы сохранены,
  исходные frame names/paths не публикуются, raw CPU profile удаляется как прежде.
  Existing diagnostic suite 5/5, strict scoped TS 7.0.2, R2 и diff check PASS.
- 18 ноября, actual native `2f33d566`: исходный полный OpenCode V2 2.1.4 E2E
  PASS (1/1), elapsed 151754 ms, все 8 steps, cleanup=true; оба Host завершены
  exit 0 / stdoutValid=true, исходный и cold-restored Stop подтверждают
  custody=released. Coordination PASS с неизменённым receipt, 4 model requests
  и 1 metadata; business ровно 11 requests, modelFailures=[], две once approvals,
  исходные tool effects ONE/TWO, completed task, comment и два user replies.
  PNG/JPEG/GIF/WebP и PDF 589 bytes доставлены точно; 4 MiB PNG нормализован
  до 159 bytes / 2000×1 с exact red pixels. Public readback всех 6 исходных
  вложений совпадает с оригиналами. Cold restore создаёт новую generation,
  возвращает nativeReady=true, сохраняет 11 requests и прежние effects; lookup
  и повтор двух command IDs возвращают исходные receipts без повторной работы.
  Source/compiled inputs/provider archive неизменны на протяжении проверки;
  SHA256 receipt `423c4aa672793dc191d5a342e376aa1512d11f189b2b2047facd3dd150ae08f5`.
  Диагностика видит оба initial-context transport ends и последующий ready;
  прежняя пауза e114 не воспроизведена, её причина этим PASS не устанавливается.
  vendorAuthQualified/desktopQualified/releaseQualified остаются false.
  Независимый R2 подтвердил final node:test verdict, все 8 original assertions,
  оба custody release и совпадение всех 6 закреплённых digest; повторный run
  не выполнялся. Passive trace достиг своего прежнего лимита и не используется
  как доказательство cold restore или позднего cleanup.
- 18 ноября, delivery snapshot `2f33d566`: app #1192 и provider #8 остаются
  Draft на исходных bases, без merge/release. Все 43 review threads #1192
  resolved; original текущие CI gates queued. Очередь и отменённые предшествующие
  cohorts не засчитываются в PASS; повторные workflow не запускались.
- 18 ноября, F1 resource R1/R2: четыре import-only children без запуска app
  или vendor CLI сравнили исходные imports (PSS 297016 KiB), parent CLI heap256
  (267996), common Taskboard roots (280044) и прямой schema import (227760).
  Только последний edge исправлен: readProfile берёт тот же schema object/type
  из teamHostProfile вместо TeamHost re-export; 388 лишних module loads исчезают
  у read-only consumer. Тело readProfile и captured file/digest/path/fd guards
  неизменны. Actual Host CLI сам импортирует createTeamHost, его composition
  сохраняется; оба source paths уже закреплены в исходном roster. Broad lazy
  rewrite и новый parent heap не применяются. R2 принял exact двухстрочный diff;
  native receipt остаётся evidence исходного 2f33, без замены SHA/digest.
  Первые две compiler attempts завершились 137 без TS diagnostics (default
  и bounded Go profile). Строгий clean Host build на TS 7.0.2 завершён PASS
  за 10.349 s с штатным --singleThreaded и compiler-only GOMEMLIMIT=512MiB,
  GOGC=50, GOMAXPROCS=2; все project options и исходный timeout 60 s сохранены.
  Ledger build PASS за 1.513 s. Это ресурсный профиль компилятора; noCheck,
  изменение runtime environment или перенос прежнего native SHA не применялись.


- 18 ноября, E1/D1 follow-up: подготовлена композиция 22 source/test/config на
  exact `c8ab4139c4f3e0f763effffdd44d6412188ba388`; все pre/post hashes
  проверены, внешний OpenCode/finite-build commit сохранён без пересечений.
  HTTP-only entrypoint разрывает renderer/store cycle; exact public root допущен
  обеими ESLint policies, descendants остаются закрыты. Actual matrix 90/90 и
  full configured fast lint четырёх изменённых boundary files PASS.
- Bounded frontend/IPC:611 PASS в 20 различных файлах по отдельным immutable-base
  runs; это не один full-suite/native PASS. Cross helper 52/52, finite metadata 5/5,
  ledger 2/2, retained authority 2, trusted controller 2 и TeamDataService 3 PASS
  сохраняют отдельные scopes и name-filtered skips.
- Original 19 frontend 4: три collection refusals покрыты 57/57. Attachment fixture
  согласован с прежним capability-level PDF refusal: 15/15. Kanban wrapper теперь
  сначала выполняет исходный strict state read, затем прежний policy lookup;
  один controller и один неизменённый native-member callback дали RED→GREEN.
  Publication/no-write assertions сохранены, атомарность двух reads не заявляется.
- Original 19 Windows Teams остановлен до Electron: исправлены generated translation
  declaration и readonly test assignment. Pinned generator добавил один ключ;
  locales/UI calls/production readonly не изменены. Translation-only TS 7.0.2 exit 0,
  actual Host ReviewFlow 10/10 PASS. Combined test+translation TS timeout 45 s остаётся
  INCOMPLETE; combined 17-file lint SIGKILL (-9) также не PASS, тяжёлых повторов нет.
- Actual полный source-size evaluator на e114+22: 5161 production paths,
  141 frozen exceptions,800-line limit, 0 violations. Канбан 220 lines; existing
  httpClient 1864 и full ESLint 1168 не выросли. Generated declaration исключён
  прежней явной policy, baseline не менялся. Независимое R2 поздних изменений PASS.
- Все 15 остающихся original 19 workflows terminal CANCELLED, ранее 14 SKIP закрыты.
  Исполненные frontend 4 / Windows Teams failures и Windows static Stage1 success
  сохранены отдельно; cancelled scopes не квалифицированы. Логи двух failed jobs
  повторно не читались. Current full Host/GUI/platform acceptance и P09 остаются.
  [Отчёт и проверяемые receipts](90-original-9a8-failure-followup-2026-11-18.md).

- Поздний parent adoption: внешний `2f33d566` сохраняет новые F1/M1 findings
  и две TEST diagnostics правки. Все 22 pre/post bindings прежние; полный набор
  5161 production blob tuples равен уже проверенному e114+22. Переносится только
  source-size verdict; новый native/GUI результат из равенства не следует.
  Original e114 cohort закрыт: 14 SKIP / 15 CANCELLED. Два native jobs отменены
  на подготовке до assertions; исходные логи и artifact metadata сохранены один раз.

- Финальный parent adoption: сохранён внешний c8 readProfile import fix и
  полный новый F1/M1 journal. Два import targets меняются при прежних 9 строках;
  все 22 source postimages прежние. Actual полный size evaluator c8+22:
  5161 production paths / 141 frozen / 800 limit / 0 violations. Native PASS
  внешнего M1 остаётся привязан к исходному 2f33, без нового исполнения здесь.
