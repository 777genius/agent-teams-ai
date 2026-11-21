# После `bd4b82d1`: исправление CI fixtures и диагностика retained open

**Полная frontend/Host/provider приёмка остаётся открытой.** Этот набор устраняет установленные ошибки тестовых типов и finite setup, включает пропущенные Host-тесты в существующий gate и добавляет недостающую закрытую диагностику original runtime open. Причина его текущего `unavailable` ещё не установлена.

Работа продолжается в Draft [PR #1192](https://github.com/777genius/agent-teams-ai/pull/1192), ветка `fix/frontend-parity-completion-20261113`. Родитель — `bd4b82d1a265a12d4999a5c78b46d3cf4a71c57e`, его дерево — `571df35ede19f976c0cb896a8626d2d518e3423d`. Target base остаётся `8d46f13fe87b4a25156b6be8331119eb8d0f790e`.

Объединённое дерево с 15 source/workflow изменениями, до этой записки и JSON: `998d02b6295938c535101b05ea1dee7abbf3b9fb`. Preimages, Git blobs, SHA-256, отдельные source reviews и неизменяемые terminal summaries сохранены в [headbd4-followups-20261118.json](evidence/headbd4-followups-20261118.json).

## Что исправляется

| Участок | Установленная проблема | Изменение и граница |
|---|---|---|
| Main runtime diagnostic test | `assert.deepEqual(lines, [])` сужал массив до `never[]` перед последующим writer callback; application typecheck отказал с TS2345. | Проверяется то же точное отсутствие вывода через `lines.length === 0`. Последующая полная проверка содержимого сохранена. |
| Host runtime diagnostic test | Присваивание readonly `checkReadiness` и неполный cast factory options дали TS2540/TS2352. | Отказ readiness задаётся при создании того же finite Session; сохраняются receiver, driver, ended promise и close. Factory получает полный типизированный набор, запрещённые последующие обращения завершаются `assert.fail`. |
| Исходная native setup fixture | Девять старых finite cases не включали новый dependency `readDesktopNativeHostProcesses` в Function-created scope. Все 25 Desktop lanes остановились в общем Node prerequisite. | Тест извлекает фактические production helpers, использует закрытые Host/metadata identities и отдельно учитывает пассивные source observations. Старые фиксированные операции, CDP payloads, дедлайны, одноразовость, Error identity и cleanup assertions сохранены. Новый case проверяет отсутствующий, повторный и переиспользованный Host до последующих действий. |
| Семь Host diagnostic tests | Файл компилировался, но отсутствовал в явной исполняемой Node-команде Host contracts; соответствующая Main test matrix была skipped. | Один аргумент добавлен в существующую serial contract command. Нового job, step, runner, команды или бюджета нет. |
| Retained original open | После 42 finite PASS исходный Desktop open вернул только `reason=unavailable`, `outcome=not-dispatched`. Сведения о внутреннем этапе отсутствовали в прочитанном job log. | Один private Main observer фиксирует закрытые phase/category/outcome после исходного результата и cleanup. IPC пишет только ранний отказ shell/context до handoff; handed-off request наблюдает Main. Admission, Core, public IPC DTO и фактические действия не изменены. |
| Чтение retained diagnostic | Durable Main log не попадает в обычный stdout сценария. | После всех прежних cleanup/native checks E2E один раз ограниченно читает два известных private log-файла. Вывод содержит только status/reason либо status/phase/category/outcome. Старые save, основной Error, AggregateError и неизвестный cleanup-долг имеют прежнюю семантику. |

## Связь записи Main с исходным вызовом

Private payload содержит ровно шесть полей: `v`, `mainPid`, `operationHash`, `phase`, `category`, `outcome`. Hash вычисляется от UTF-8 `JSON.stringify(['open', original teamName, original intentId])`. Это диагностическая связь, она не предоставляет полномочий запуска или сигнала.

Существующий logger получает один объект; фактические redaction и persistent serializer сохраняют его закрытые значения и помещают в прежний восьмиполевой NDJSON envelope. Исходные request, error message/stack/cause, пути, environment и tokens не попадают в новую запись.

Сценарий использует уже захваченный `app.electron.pid`, а не PID dev launcher. Оба прежних literal intent и обе Launch-expression сохранены побайтно, включая общий 240 s allowance. Binding захватывает исходный вызов; после успешного await он сразу очищается, а при отказе сохраняется до диагностического чтения после cleanup. Поздний посторонний отказ не использует старую запись.

Читаются только `userData/logs/app-errors.ndjson` и опциональный `app-errors.1.ndjson`: максимум 2 MiB на файл, 64 KiB на строку и 8192 записи суммарно. Проверяются private canonical owner directories, regular single-link files, исходные descriptor/path identities до и после чтения и повторная неизменность всех файлов/родителей. Partial, foreign, duplicate, changed, unsafe, malformed и over-budget данные остаются `diagnostic-unknown`; выбор последней удобной записи не используется.

Новый reader делает дополнительное ограниченное I/O после прежней очистки. Он не добавляет CDP/RPC, provider action, process probe, retry, таймер или новый deadline. Ошибки чтения и вывода не заменяют прежний результат; запись не доказывает native release или provider readiness. Invalid/unbound requests и исключения раннего IPC capture не получают нового диагноза.

## Реальное выполнение на родителе `bd4b82d1`

Все 29 исходных runs attempt 1 завершены: 3 SUCCESS / 12 FAILURE / 14 SKIPPED. Последний packaged run впервые наблюдался terminal 18 ноября в 11:39:30.846 UTC. Все 29 runs permanently retired; дальнейшие обращения к их runs/jobs/artifacts не выполняются. Ни rerun, ни cancel, ни manual dispatch не использовались.

| Исходный attempt 1 | Зафиксированный результат |
|---|---|
| [Host Emulated](https://github.com/777genius/agent-teams-ai/actions/runs/44286416943) | FAILURE: 4 frontend jobs SUCCESS, 25 Desktop prerequisite jobs FAILURE и отдельный failed aggregate. UI exercise steps этих 25 lanes не выполнялись. Linux Skills Node gate: 462 PASS / 9 FAIL / 0 SKIP, всего 471. Для Darwin отдельно наблюдалось 457 PASS / 9 FAIL / 5 SKIP; Linux counts не переносятся на другие платформы. |
| [Teams](https://github.com/777genius/agent-teams-ai/actions/runs/44286417073) | FAILURE на всех трёх платформах: обязательный application typecheck отказал с TS2345. Electron journey steps skipped. |
| [Main](https://github.com/777genius/agent-teams-ai/actions/runs/44286417110) | FAILURE: 1 SUCCESS / 3 FAILURE / 11 SKIPPED jobs. Fast workspace typecheck отказал с TS2345, следующий Fast lint skipped. В retained job отдельные strict scripts typecheck и lint успешны; 42/42 finite tests PASS — 29 launch и 13 model. Затем первая исходная scoped original open отказала с `unavailable/not-dispatched`, до read/prepare/roster/Launch. |
| [Host process](https://github.com/777genius/agent-teams-ai/actions/runs/44286417528) | FAILURE на всех пяти платформах в build prerequisite из-за двух ошибок типов нового Host test. Native qualification steps skipped. Это не доказательство повторения прежних Windows readiness/cleanup отказов. |
| [Stage1](https://github.com/777genius/agent-teams-ai/actions/runs/44286416907) | FAILURE: 5 SUCCESS / 4 FAILURE. Оба Windows embedded, Linux embedded, Ubuntu Native SPI и durable HTTP discovery имеют SUCCESS statuses. Два static jobs остановились на Host test types. Оба Darwin embedded jobs отказали на разных исходных P09 assertions. |
| [Packaged](https://github.com/777genius/agent-teams-ai/actions/runs/44286416858) | SUCCESS всех семи jobs: classifier, пять платформ и packaged full gate. Пять artifact records сохранены как metadata only; archive bytes, screenshots и физические receipts не исследованы. |
| Остальные 23 runs | 2 SUCCESS ограниченных Dependency Review/Announcements gates, 7 FAILURE и 14 SKIPPED. Пять failures — TS2345 в application typecheck; два — dependency audit. Downstream native/update skipped не считаются выполненными. |

Четыре фактических frontend logs дают **26 203 PASS / 38 SKIP**, всего 26 241 test; **2177 PASS / 7 SKIP** файлов, всего 2184 уникальных, без пересечения shards. В частности, выполнены 33 memberRuntimeSummary, 15 stoppedImportDiagnostics, 15 runtimeOpenDiagnostics и 8 retainedLegacyMainAdmission cases. Успешное runtime-выполнение не устраняет отдельную ошибку typecheck.

В неуспешном Linux Skills Node prerequisite отдельно установлены PASS для новых 21 owner-epoch, 11 metadata lifecycle и 13 UI deadline cases. Они не закрывают оставшиеся девять failures или последующие Desktop journeys. **Семь Host diagnostic cases на родителе не были выполнены**; новая CI wiring предназначена для их фактического запуска.

Job/step SUCCESS, однократно прочитанный test log и metadata артефакта учитываются отдельно. Текущие ZIP, screenshots, source-freeze maps и физические receipts не скачивались и не проверялись: exec-среда по-прежнему недоступна. Полная native/UI/vendor квалификация по metadata не объявляется.

## Проверка нового набора

- Все 15 source paths и modes сверены с деревом родителя: 10 существующих файлов и 5 новых; неожиданных изменений нет.
- Независимые source reviews завершены для test-type correction, native setup fixture, Host contract wiring, Main/IPC producer, reader/parser/caller и Main CI wiring. Наблюдение сохраняет прежние 9 awaits Main composition и 0 awaits IPC; исходные call expressions проверены побайтно.
- Новые producer tests: 29 authored cases — 19 helper privacy/failure/observer cases и 10 actual Main/IPC cases. В двух producer test files 37 cases вместе с восемью ранее существовавшими. Отдельно authored 27 reader/parser/FS/caller cases и один setup case с тремя Host identity вариантами. Это новые тесты, **не выполненные результаты**.
- Все изменённые production TypeScript файлы ниже 800 физических строк; новый helper 107, contract 52, Main composition 330, IPC 71. Coexistence script 780 строк. Тестовые файлы и YAML не используются как исключения к production cap; сам size guard ещё не исполнялся.
- **Новый набор: tests / types / lint / architecture / build / native / Desktop / E2E — NOT RUN на момент source freeze.** Последняя read-only проверка exec в 11:32:30 UTC также вернула `No usable execution environment is available`. Успехи родителя и более старых commits не квалифицируют эти новые bytes.

В существующую retained Node-команду добавлен один новый test argument; в её существующий strict lint list — два новых script paths. Условия, jobs, runners, permissions, toolchains и бюджеты не меняются. Обычный автоматический CI нового head должен исполнить объединённые исправления.

## Оставшиеся границы

В этом parent cohort прежние восемь UI failures из [отчёта 87](87-runtime-import-diagnostics-and-bounded-observers-2026-11-18.md) не были повторно достигнуты из-за общего prerequisite. Новый finite setup и прежние diagnostics не объявляются исправлением всех этих UI сценариев.

P09 остаётся открытым по [source writer decision](40-p09-source-writer-decision-2026-11-16.md). В текущем Darwin x64 первый отказ: compiler-default baseline / kernel-image-validity, errno 13 и codeSigningError -67062. На ARM64 первый mutation oracle увидел `LIB/BIN/MAIN` после изменения исходных bytes. Подтверждённое завершение control-процессов не закрывает source-identity assertion. Исходный pathname/argv0/$0/resource/writer контракт не ослаблен; ни одна альтернатива не внедрена.

Оба audit jobs содержат 79 vulnerability records (1 low, 17 moderate, 61 high), соответствующих 21 distinct structured advisory. Единственный нерешённый HIGH/CRITICAL advisory — [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf), picomatch <=4.0.7. Официальная страница при проверке 18 ноября в 10:49:57 UTC указывала patched version `None`; latest release — 4.0.7. Результат не заменён waiver, неизвестной версией или принудительным major upgrade.

Draft status, target base и прежний порядок доставки сохраняются. Реальные Claude/Codex, Stage2, merge/main, release и включение Host по умолчанию не выполнялись. Новые данные должны прийти от исходных автоматических attempt 1 следующего head; terminal runs родителя больше не опрашиваются.
