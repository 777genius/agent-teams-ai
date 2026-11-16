# V1 OpenCode: соседние проверки владельца при чтении готовности

## Основание и граница изменения

Исходный Process Acceptance на `3be1fb3ec43d5682aa2ca77a6af62e6fa27b597b`, run `43933487270`, attempt 1, Windows x64 job `133531812580`, завершился FAILURE в шаге 22 (`Qualify original opencode source A B with TEST peer`). В оригинальном Team-A сценарии первая наблюдённая причина — `probe-expiry`: `probeNow=1794856136448`, `probeCutoff=1794856136198`, превышение 250 ms. Затем consumer сообщил `phase=reference/reason=threw`, а native resume — `preparation-failed`. Это отдельный отказ после пройденных сборки и контрактов; весь job не квалифицирован.

Оригинальный receipt содержит 23 вызова consumer current: 10 721 ms суммарно, reference 9 842 ms, account inspection 5 604 ms, вложенные account authority callbacks 5 256 ms. Это включающие друг друга интервалы, их нельзя складывать. Последний вызов занял 434 ms; проверка cutoff перед reference произошла за 163 ms до истечения. Эти данные устанавливают вклад повторных authority callbacks, но не обещают успешный native результат после сокращения повторов.

Сохраняются original poll 15 s, probe/consumer cutoff, read-before-resume, native custody и все критерии готовности/очистки. В исходном отказе slot 2 был физически подготовлен, но `resume.calls=0`; secondary cleanup assertion остановился на требовании `resumed` до проверки HANDLE. Поэтому `originalHandleAbsent=false` в этом receipt не является наблюдением живого остаточного процесса. Внутренний `cleanup=false` остаётся неподтверждённой очисткой независимо от внешнего controller `activeProcesses=0`.

## Два исходных файла

| Файл | Исходный Git blob | Предмет изменения |
| --- | --- | --- |
| `packages/legacy-agent-host/src/composition/prepareTeamModelReadiness.ts` | `561580091cc89067c9a1b2e80b0fa402e8950043` | Устранение соседних повторов owner callback только внутри уже существующего private V1 member bracket. |
| `packages/legacy-agent-host/tests/saved-team-model-probe.test.ts` | `91c0d5773aa6799636c03c507533914c37b6d996` | Точные положительные счётчики диагностируемых callbacks и их пояснения; исходные отрицательные проверки и формулы времени сохраняются. |

Путь bracket использует original retained probe, member inspection, V1, declared configured API key и отсутствие native file-key witness. Completed/ok/clean остаются отдельными обязательными проверками ModelProbeOwner перед принятием reference. Public capture/transfer, V2, выбранный file key, authless account и прочие ветви продолжают исходную последовательность проверок. Production файл после изменения занимает 783 физические строки при лимите 800.

## Почему сохраняются самостоятельные проверки

`OpenCodeConfigurationSource.isCurrent()` синхронно вызывает свой `read()`: полный owner callback перед свежим чтением выбранных файлов, затем полный owner callback после построения reference. В private bracket ведущий callback `nativeCurrent()` непосредственно повторяет первый из них. Его пропуск ограничен этим bracket; исходный leading callback сохраняется при `!bracket`.

Перед второй проверкой `nativeCurrent()` bracket также вызывает тот же owner callback непосредственно перед его повтором в source reader. Убирается только этот внешний дубль. Каждый прежний свежий configuration read и его обе границы остаются.

`OpenCodeReadinessOrigin.isCurrent()` выполняет `inspect()`: полный owner callback до свежего чтения policy/approval sources и после их разбора. Далее следуют только сравнения digest. Внешний callback сразу после `policy.isCurrent()` повторяет эту заключительную проверку; убирается только он. Target по-прежнему читается до последней свежей проверки policy, поэтому изменение owner или consulted source внутри target отказывается прежним closing read.

Полный callback сохраняет все составляющие: provider identity, writer, captured Team availability, provider authority, original allocation authority, principal/grant revision и control access. Между сокращаемыми повторами нет `await`, нового чтения источника или продуктового эффекта. Кэш, общий lock, новая capability, продление proof и переиспользование результата между вызовами не вводятся. Во всяком последующем `assertCurrent()` файлы и владелец проверяются заново. Исходные проверки времени в consumer и ModelProbeOwner остаются на прежних местах.

## Точные диагностические ожидания

На успешное private V1 inspection остаётся 15 полных callbacks вместо 19: initial 1, reference entry 1, opening policy 2, configuration capture 4, first native source 2, second native source 2, closing policy 2, final 1. Два успешных inspection дают 30 вместо 38. При исходном target throw до closing policy и final authority выполнено 12 вместо 15 callbacks. Это намеренное изменение trace; утверждать сохранение каждого прежнего повторного callback нельзя.

В тесте меняются только эти два положительных счётчика и их сообщения. Все вложенные timing sums, fractional rounding, clock-failure isolation, exact original error identity, first-refusal latch и отсутствие diagnostic clocks без подписчика остаются исходными. Сохраняются отрицательные сценарии owner revocation, consulted Main source replacement, точной границы expiry, смены credential, а также проверка свежего shadowed native source. Не меняются assertions original probe bytes, pending/consumed identity, отсутствие business allocation, повторное consumption и отсутствие нового native probe.

## Проверка и публикация

Перед source commit обязательны полный R1, независимый R2 и прочтение фактически опубликованного documentary commit. Source меняет только два перечисленных файла. Публикация использует обычный CAS push с сохранением входящих изменений и полезных активных исходных CI jobs.

Проверка выполняется существующими исходными CI lanes: Host/management contracts, saved-team-model-probe negatives, Process Windows source A/B на Node и исходных native brokers, затем остальные исходные gates текущего head. Локально выполняются только чтение исходников, сравнение текста и вычисление hash. Изменение положительных callback counts не является измерением native ускорения или PASS; такой вывод возможен только из нового исходного receipt с теми же сроками и условиями.

На момент этой записи native исправление ещё не измерено. Windows ARM Codex readiness, Windows V2 manual first-input terminal и Linux V2 credentials проверяются по собственным исходным отказам; результат этой V1 правки на них не переносится. P09 остаётся HOLD, направления A/B плана 40 не выбраны. Stack #1192 → #1186 → #982 остаётся Draft; эта правка не выполняет merge, release, default activation или Stage 2.

## Исходные материалы

- [Оригинальный Windows x64 job](https://github.com/777genius/agent-teams-ai/actions/runs/43933487270/job/133531812580).
- `windows-source-opencode-receipt.json`: 18 988 bytes, SHA-256 `ce5ae1f2d42a8d26cb63df038323ba201961d4b8277730df3e4116f16dcd13af`.
- Исходный job log: 421 134 bytes, SHA-256 `16625242ff1d026dbfa6adfe4b37c281bebe44ab73dfb0fa16904786b3959df9`.
- Исходный artifact `14260830362`: 58 129 bytes, SHA-256 `3a711025bcc040f2517702f8f8e35b2e9141b4e78521ec33e2f9a1005fac3974`; все 18 members проверены по CRC и точным извлечённым байтам. Windows source pins соединены с текущими Git blobs через исходное LF→CRLF checkout-преобразование.
