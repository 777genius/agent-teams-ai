# Новый набор после `615a264f`: runtime, metadata и наблюдения E2E

**Полная frontend/Host/provider приёмка пока не завершена.** Этот набор сохраняет исходные проверки владения, допустимости запуска, повторов и дедлайнов. Он исправляет отображение захваченной конфигурации и два ограниченных пути наблюдения; отдельно добавляет недостающие сведения о фактических отказах.

Работа продолжается в существующем Draft [PR #1192](https://github.com/777genius/agent-teams-ai/pull/1192), ветка `fix/frontend-parity-completion-20261113`. Родитель этого набора — `615a264fcd168a5643fde4ec39ab173075e4d6c9`, target base — `8d46f13fe87b4a25156b6be8331119eb8d0f790e`.

Исходное дерево только с 27 изменёнными source/workflow файлами, до добавления этой записки и JSON: `f24a0f817349025d561c477f235213cdea3c9327`. Полный список Git blobs, SHA-256, preimages, ревью и статусов находится в [head615-followups-20261118.json](evidence/head615-followups-20261118.json).

## Что меняется

| Группа | Изменение | Сохраняемый инвариант |
|---|---|---|
| Карточки участников — 2 файла | Захваченный Host member с отсутствующей configured runtime settings больше не получает выдуманную подпись из настроек lead. Существующий UI показывает ожидание конфигурации либо только роль. | Явная пустая конфигурация по-прежнему допускает наследование; явные Codex/OpenCode и legacy inheritance сохраняются. |
| Открытие Runtime — 7 файлов | Фиксированные source/phase/category, хеши исходного profile/configuration и время позволяют связать первое исключение factory с внешним Runtime отказом. Main принимает запись через прежний ограниченный stderr decoder. | Первый diagnostic записывается до исходных revoke/close. Ошибка cleanup сохраняет прежний приоритет; held/nativeReady/custody и все guards/awaits остаются прежними. |
| Импорт остановленной команды — 6 файлов | Private Main diagnostic различает этапы захвата source/Host, receipts, подготовки, публикации и регистрации. Записываются только четыре закрытых поля. | Исходные reason/outcome, effect flags, lost-ACK reconciliation и `return run()` без нового await сохранены. Ожидаемый `native-custody-unverified` остаётся исходным основанием выбора original runtime. |
| Metadata — 4 файла | Пассивное ожидание lifecycle count допускает законный промежуток между освобождением directory metadata и готовностью provider metadata. Затем выполняется прежняя физическая проверка. | Только исходный remainder setup 180 s либо Review preflight 120 s с прежней точки начала; physical window ограничен `min(5 s, remaining)`. Exact source/Host/owner, retained prefix, native birth, отсутствие retired PID и Runtime=0 обязательны. |
| Завершение owner epoch — 2 файла | После отказа прежних signal identity guards допускается только пассивное подтверждение естественного завершения исходного ChildProcess. | Тот же birth/parent/original Node invocation, exit 0 без signal, отсутствие всех первоначальных PID и Host PID, всей группы, финальный census и port в исходные 3 s. Изменённый argv никогда не становится полномочием для сигнала. |
| Чтения UI — 2 файла | В существующих failure paths появляются ограниченные phase/count/time observations. Для точного finite Create control добавлены булевы DOM-признаки в тот же evaluate. | Прежний порядок clock/owner/preparation/evaluate/context-retry/pause и исходный exception сохраняются. Дополнительных CDP, RPC, inputs, таймеров, повторов и окон ожидания нет. Эти DOM-признаки не раскрывают все внутренние причины disabled. |
| Retained refusal — 2 файла | Исходный generic failure prefix дополняется уже полученными public reason/outcome из фиксированного набора. Неизвестные и accessor/inherited значения не раскрываются. | Те же шесть awaits, один intent, исходный receiver, подготовка, обязательный roster, Launch и cleanup в пределах 240 s. При двух ошибках прежнее внешнее AggregateError может по-прежнему скрывать внутреннюю диагностическую строку. |
| Форма записей Quit — 1 файл | При прежнем отказе проверяется только ограниченная выборка уже прочитанных Dirents; в лог попадают счётчики, без имён и путей. | Исходный predicate, его short-circuit и тот же exception сохранены. Не добавлены FS reads, time reads, retries либо допуск временных файлов. |
| Существующий CI gate — 1 workflow | В прежний Node gate включён finite metadata lifecycle test; восемь изменённых script paths добавлены в явный lint list. | Node 24.21, build order, jobs/conditions/permissions/runners/timeouts неизменны. Deadline tests уже импортируются из team-ui test; второй аргумент для них не добавлен. |

Новые diagnostics не сериализуют исходные exception message/stack/cause, request, environment, token, capability, project path или Team name. Ошибка наблюдателя, в том числе отвергнутый Promise, не меняет исходный отказ.

## Статус проверки нового набора

Это **новые версии исходников после потери exec-среды**. Их нельзя считать побайтным восстановлением всех прежних локальных candidates.

- Все 27 путей, modes и preimages проверены через immutable Git objects; пять новых целевых файлов отсутствуют в родителе.
- Независимые source reviews завершены. В частности, проверены callback границы, отсутствие пересекающихся правок, сохранение исходных awaits/guards/effects и совместимость metadata caller с UI helper.
- Все новые и изменённые production TypeScript файлы этого набора остаются ниже 800 строк; наибольший — RuntimeOwner, 771 строка. Длинные существующие production TypeScript файлы не увеличены.
- **Новые tests, types, lint, build, native/Desktop/E2E — NOT RUN на момент публикации этого набора.** Source-only review, inverse comparison и подсчёт строк не заменяют исполнение gate.
- Новый package test автоматически входит в прежний Host test glob; Main tests входят в прежний Vitest include. Фактический набор и результаты следующего CI необходимо проверить по его собственному плану и точному head.
- Добавлены адресные случаи для отсутствующей конфигурации, сохранения первоначальной ошибки/UNKNOWN при диагностике, закрытых полей, пределов исходного срока и отсутствия PID. Цель по количеству тестов или покрытию не устанавливается.

Рабочая exec-среда пропала приблизительно в 08:10 UTC. Последняя read-only проверка доступности в 09:21:43 UTC снова вернула отсутствие среды. После потери среды не выполнялись локальные app/native/vendor процессы, installs, SQLite rebuild или подмена toolchain. Новые результаты должен дать обычный автоматический CI после публикации этого конкретного diff.

Предыдущие 33/22/128 PASS локальных candidates не перенесены на новые postimages. Опубликованные в `615` 35 finite tests и его types/lint также относятся только к `615`.

## Что фактически произошло в CI родителя `615a264f`

Все 29 автоматических `pull_request` runs original attempt 1 наблюдались до первого terminal и затем были сняты с наблюдения. Получено девять SUCCESS, шесть FAILURE и четырнадцать SKIPPED. Ручных dispatch/rerun/cancel не было.

| Запуск | Итог и установленный объём |
|---|---|
| [Teams creation](https://github.com/777genius/agent-teams-ai/actions/runs/44269678658) | SUCCESS, три платформы; исходные application typechecks и Electron journeys имеют успешные step statuses. |
| [Main](https://github.com/777genius/agent-teams-ai/actions/runs/44269678601) | FAILURE. Полный workspace typecheck и Fast lint успешны. Retained finite tests: 35/35 PASS, 0 SKIP — 22 launch/Coordinator и 13 model. Затем Desktop не подтвердил исходный runtime open. Одиннадцать других jobs явно skipped. |
| [Host Emulated](https://github.com/777genius/agent-teams-ai/actions/runs/44269678482) | FAILURE: 21 успешное задание, восемь неуспешных UI-сценариев и отдельный failed aggregate. Все четыре frontend shard jobs успешны; их текущие counts/skips не установлены. |
| [Host process fixtures](https://github.com/777genius/agent-teams-ai/actions/runs/44269678470) | FAILURE: Linux и обе macOS jobs успешны, Windows x64/ARM64 отказали на разных исходных границах. |
| [Packaged](https://github.com/777genius/agent-teams-ai/actions/runs/44269678454) | SUCCESS всех семи jobs: classifier, пять платформ, full gate. |
| [Stage1](https://github.com/777genius/agent-teams-ai/actions/runs/44269678565) | FAILURE: шесть SUCCESS, три FAILURE. Windows x64/ARM64 успешны; два разных первых отказа Darwin P09 и Linux credential cleanup остались открытыми. |
| Остальные 23 runs | Семь SUCCESS ограниченных tooling/content/dependency gates, два dependency-audit FAILURE и четырнадцать SKIPPED. Native updater lanes, которые были skipped, не считаются выполненными. |

**Ограничение доказательств:** текущие ZIP, screenshots, source-freeze maps и физические cleanup receipts не скачивались и не проверялись в недоступной exec-среде. В JSON разделены job/step statuses, однократно прочитанные failed logs и metadata артефактов. Успех job не расширен до универсальной native/vendor/release или полной frontend parity квалификации.

## Первые установленные отказы

| Сценарий | Установлено по этому head | Что остаётся неизвестным |
|---|---|---|
| V2 Review | Исходный initial target read и один mouseMoved вернулись; после hover истёк общий 30 s read deadline, до press/release этого click. | Нет подтверждения geometry, focus, context либо конкретной стоимости фаз. Metadata правка начинается позже и этот ранний отказ не исправляет. |
| Retained original UI | После одного Detail Launch не наблюдался ожидаемый диалог original-runtime choice. | Содержимое текущего modal и причина held не прочитаны из архива. Исторический screenshot не перенесён на этот запуск. |
| V2 Add | Исправленный aria-label selector и исходный submit прошли; completion Add не наблюдался в прежние 90 s. | Нельзя отличить отсутствие команды, held, поздний результат или Runtime open failure. Remove/Restore этой lane не достигнуты. |
| M16 import | Перед исходным Create-and-Launch target всё ещё disabled/pointer-events-none; input этого вызова не отправлялся. | Точная ветвь внутреннего disabled predicate не установлена. Concrete catalog fixture fix сам по себе не закрыл этот E2E. |
| V2 attachments | Первоначальный global metadata capture отказал на строгом количестве активных scopes. | Точная последовательность lifecycle/cutoff не получена из архива; attachment UI не достигнут. |
| Collaboration Restore | Исходные Add/Remove и освобождение старой generation достигнуты; после одного Carol Restore completion не наблюдался в 75 s. | Новая generation и фактическое первое исключение provider не установлены. Отсутствие готового journal не означает отсутствия spawn. |
| Quit active | Строгая форма списка command-directory entries не прошла после исходного Send и проверки пустого Composer. | Конкретная запись, тип и count неизвестны. Временный файл причиной не объявлен. |
| V2 Resume | Preflight/scroll/readiness/metadata этапы вернулись; финальный Launch отказал в initial read guard до hover/press/release, поскольку исходный preflight срок исчерпан. | Не установлено, какая фаза израсходовала остаток. Новый input, probe или срок не выдавался. |
| Retained coexistence | После 35 успешных finite tests не подтвердился original runtime open первой scoped relaunch. | Public reason в прежнем сообщении потерян. Новая diagnostic делает его видимым, но ещё не исправляет причину. |
| Windows x64 Host | Consumer cutoff readiness превышен на 122 ms. | Длительности current/reference проверок не доказывают точную причину. Logged handleAbsent=false находится до witness wait и не доказывает последующий cleanup debt. |
| Windows ARM64 Host | Standalone completion не подтверждён; для slot 24 prepare dispatched, root/witness не подтверждены, строгая physical cleanup assertion действительно отказала. | Stop/drain/release flags не закрывают этот исходный долг. Причина prepare uncertainty не установлена. |
| Stage1 Linux credentials | Третья Host epoch завершилась exit 1, cleanup=false; timeout journal held/probe-intent. | Последние transport/read-cut и unconfirmed close diagnostics не устанавливают первичную причину transport failure. |

## Незакрытые внешние границы

P09 сохраняется как отдельный открытый контракт [source writer decision](40-p09-source-writer-decision-2026-11-16.md). На Darwin ARM64 прежний mutation oracle увидел `LIB/BIN/MAIN` markers после изменения байтов; на Darwin x64 первый отказ иной: compiler-default baseline / kernel-image-validity, errno 13. Успешные предшествующие business/custody steps не закрывают эту проверку. Контракт исходного пути, исполнения и допустимых writers не ослаблен.

Два ancillary runs отказали на dependency audit. Текущий lock содержит picomatch 2.3.2/4.0.4; прочитанный официальный [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) на момент проверки 18 ноября около 08:53 UTC не указывал patched version. Это отдельная незакрытая причина CI, без waiver, незаявленной версии либо принудительного major upgrade.

Stage2, merge в main, release и включение Host по умолчанию не выполнялись. Реальные Claude/Codex не запускались. Обычный автоматический CI следующего head должен проверить этот новый набор; прежние terminal runs повторно не используются.
