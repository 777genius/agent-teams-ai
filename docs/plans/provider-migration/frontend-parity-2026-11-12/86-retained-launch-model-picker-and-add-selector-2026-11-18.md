# Восстановленные исправления E2E — 18 ноября 2026

Статус: **Draft; полная E2E-приёмка остаётся открытой.**

Исходная ревизия — [68956f3fd5e4f4ad300f8f627d085097d531eaa5](https://github.com/777genius/agent-teams-ai/commit/68956f3fd5e4f4ad300f8f627d085097d531eaa5).
Доставка продолжается в [PR #1192](https://github.com/777genius/agent-teams-ai/pull/1192),
ветка `fix/frontend-parity-completion-20261113`, база
`8d46f13fe87b4a25156b6be8331119eb8d0f790e`. Merge, release, Stage 2 и включение
Host по умолчанию не выполнялись.

## Три конкретных исправления

### Retained OpenCode: исходный scoped Launch

В Main-прогоне 689 вызов старого `teams.launchTeam` после выбора Host был
отклонён: он не имел исходного scope выбора original runtime. Сценарий
coexistence теперь использует существующий renderer transport и существующий
`RetainedLegacyLaunchCoordinator`:

1. Один фиксированный intent открывает original-runtime choice.
2. Читаются и сверяются сохранённые Team, cwd, provider, model, permissions и версия.
3. Выполняется исходный prepare, затем **обязательный roster с точным saved.members**.
4. Только подтверждённый roster допускает единственный Launch.
5. Закрывается тот же choice; при потерянном open ACK используется тот же intent.

Два прежних места Launch сохраняют свои запросы и первоначальный предел
240 секунд. Подготовка, roster, Launch и подтверждение close входят в этот предел.
Потеря ACK не порождает повторную отправку. UNKNOWN-долг остаётся у исходного
Main owner. Изменений production Main admission нет.

Первый вариант helper не включал обязательный roster; его review отозван.
Опубликованная версия соответствует финальному rev3, включая проверку cutoff
после close. В существующий шаг CI добавлен только путь нового regression test.
Это исправление coexistence harness не закрывает отдельный UI-отказ
`Stopped Team import held`.

### M16: конкретная модель finite Claude peer

Finite peer объявлял `claude-sonnet-4-6`, но не отдавал каталог по существующему
wire-контракту. Исходный picker выбирал fallback alias `sonnet`, который исходная
проверка правильно отвергала как отсутствующий в каталоге.

Добавлен только каталог finite TEST peer. Picker получает конкретный model ID;
`dynamic:false` сохранён. Production mapper, resolver и разрешение запуска не
изменены; alias и неизвестная модель по-прежнему отвергаются. Regression проходит
через фактический finite Node peer, исходный Main mapper, picker и launch validation.
Все bytes bootstrap/PONG/lifecycle после metadata-ветки остались прежними.

### Add Members: существующая кнопка с aria-label

В оригинальном TeamDetailView Add — кнопка с иконкой и `aria-label="Add"`.
Два harness искали её по тексту `Add` и могли остановиться до клика.
Исправлены ровно три существующих обращения: scroll+click в live membership
и click в roster lifecycle. Порядок действий, mutations и deadlines сохранены.

## Проверка до отключения среды

| Исправление | Подтверждённый результат | Граница доказательства |
| --- | --- | --- |
| Retained scoped Launch rev3 | 22/22 regression checks; focused types, lint, source cap и diff PASS | Фактический Main Coordinator с finite authority ports; не новый app/native E2E |
| M16 finite catalog | Baseline RED, затем 4/4 mapper/picker/preflight checks; существующие 13+18 finite checks PASS; scripts и focused types, lint/cap/diff PASS | Finite peer; новый тест намеренно пропускается на win32; не vendor auth или native Windows |
| Add Members selector | Scoped lint и diff PASS; actual исходная кнопка и точный diff прочитаны независимо | Новый Desktop путь ещё должен пройти CI; whole scripts typecheck после интеграции не выполнялся |

Это **57 успешно выполненных адресных проверок** для retained и M16, а не
57 новых E2E-сценариев. После отключения среды тесты не запускались.

## Побайтное восстановление и публикация

Около 08:10 UTC рабочая среда стала недоступна. Последующая read-only проверка
вернула `No usable execution environment is available`; перенос локального
отчёта также был недоступен. GitHub оставался доступен.

Восстановлены только полные группы файлов, чьи SHA-256 совпали с зафиксированными
до отключения postimages. Исходные файлы взяты из immutable Git 689; новые Git blobs
прочитаны обратно. Root независимо сверил preimages, postimages и точный diff.
Семантически похожие переписывания не выдавались за проверенный исходник.

Сопоставления blob/SHA-256, прежние manifests и ограничения сохранены в соседнем
машиночитаемом отчёте `evidence/head689-recovery-20261118.json`.
Прежняя объединённая сборка Host с 15 локальными файлами прошла в 08:06:45,
но это не сборка опубликованного здесь набора и не новая полная проверка.

## Закрытый CI для исходного 689

Все перечисленные original attempt 1 завершились и retired. Повторный запрос
старых runs, скачивание тех же artifacts, rerun/cancel/manual dispatch не выполняются.

| Набор | Последний terminal результат и значимая граница |
| --- | --- |
| [Teams](https://github.com/777genius/agent-teams-ai/actions/runs/44252221927) | SUCCESS на трёх OS; configuration-only original UI, без provider execution |
| [Host Emulated](https://github.com/777genius/agent-teams-ai/actions/runs/44252221838) | FAILURE: 21 успешный job, восемь failed сценариев и failed aggregate |
| Frontend shards внутри Host Emulated | 26 162 PASS / 38 SKIP / 0 FAIL, 2182 distinct files; это offline frontend coverage |
| [Host fixture](https://github.com/777genius/agent-teams-ai/actions/runs/44252221762) | Linux и Darwin x64/ARM64 PASS; Windows x64/ARM64 не уложились в исходный readiness deadline |
| [Packaged](https://github.com/777genius/agent-teams-ai/actions/runs/44252221877) | Все пять actual V2 Host scopes PASS отдельно; общий набор FAILURE из-за Darwin x64 finite peer identity |
| [Stage 1](https://github.com/777genius/agent-teams-ai/actions/runs/44252222114) | Семь jobs PASS; два Darwin P09 source-writer failures |
| [Main](https://github.com/777genius/agent-teams-ai/actions/runs/44252222089) | Workspace typecheck и fast feedback PASS; retained coexistence отказался на original scope |

Отдельно проверены V2 active+queued Quit/cold и pending-open Quit/cold:
сохранённые сообщения/задачи, original app exit 0, физическое отсутствие собственных
процессов и отсутствие повторной inference. В pending-open сценарии UNKNOWN-долг
**сохранён**, а не объявлен released. Эти положительные строки не закрывают
полный Launch/Resume, automatic relaunch, P09 или всю матрицу.

## Непубликованные изменения и оставшаяся работа

Три ранее проверенные группы не включены: guard отображения captured member labels
(33 tests PASS), приватная диагностика Runtime/factory open (22 tests PASS) и
пассивное подтверждение natural exit для epoch cleanup (128 tests PASS).
Их полные файлы остались в недоступной среде; hashes и пути frozen handover
сохранены в JSON. Восстановленный один production-файл labels не публикуется
отдельно от его regression-файла.

Metadata-readiness candidate остаётся **DRAFT с известным RED**: последняя проверка
владельца должна предшествовать последнему `remainingMs()`. До отключения
получено 25 PASS / 1 FAIL в 26 тестах. Перестановка ещё не применена. Нужно
исправить порядок, выполнить исходные tests/types/lint/cap и получить final review,
сохранив первоначальные 120/180 секунд и физический observer до пяти секунд.

Новые причины ещё предстоит установить:

- Collaboration Restore: новая generation held/open-unknown; отсутствие peer journal
  не доказывает отсутствие spawn. Подготовленная private diagnostic не опубликована.
- Retained-original UI: один Detail Launch вернул import held/not-dispatched;
  caught cause потеряна. Узкая диагностика Main ещё не написана.
- V2 Resume: preflight и две metadata scopes прошли; после одного Launch click
  не появился один свежий Team capture. Уже скачанные PNG/state/runtime/error
  artifacts не были прочитаны до отключения.
- Windows readiness и packaged Darwin peer identity: дедлайны и строгие process
  oracles не ослаблены; причинного исправления пока нет.
- P09 source-writer contract остаётся отдельным открытым решением владельца;
  см. [варианты и последствия](40-p09-source-writer-decision-2026-11-16.md).
- Записанный security audit по picomatch не закрыт; waiver, изменение lockfile
  и предположение о неизвестной patched version не использованы.

Следующий прогон должен относиться к новому опубликованному commit. Предыдущий
PASS не переносится автоматически на новый source, а текущие queued/running/skipped
не считаются приёмкой.
