# 03. Slash-команды и настройки действующей сессии

Статус: план; production, provider contracts и artifacts пока не изменяются.
Frontend baseline: `4a0e06277fe216d9f82dbbede362668fe46622ee`.
Stage 1 baseline: `1d0f97f55de566036c970eab4f36b84620afdb3f`.
Срез включает live-session model/effort/fast для Claude, Codex и поддерживаемых OpenCode routes.
Выбор параметров до запуска принадлежит плану 05; общий profile lifecycle — плану 06.

## 1. Существующий frontend и подтверждённый gap

- `MessageComposer` разрешает standalone slash только живому lead, без attachments и без cross-team адресации.
- [Main: `MessageComposer`](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/renderer/components/team/messages/MessageComposer.tsx).
- `teams.ts` сохраняет raw slash без обычной message wrapper и передаёт его live non-OpenCode lead через stdin.
- [Main: `handleSendMessage` raw slash branch](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/main/ipc/teams.ts).
- Tests подтверждают raw routing и для известной `/compact`, и для неизвестной standalone команды.
- [Main: routing regression tests](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/test/main/ipc/teams.test.ts).
- Этот тест доказывает доставку в stdin; он не доказывает исполнение всех команд каждым native provider.
- Shared suggestions содержат 10 команд, Codex-specific список — 21; project/user skills добавляются отдельно.
- [Main: `getSuggestedSlashCommandsForProvider`](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/renderer/utils/providerSlashCommands.ts).
- [Main: `buildSlashCommandSuggestions`](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/renderer/utils/skillCommandSuggestions.ts).
- `annotateSlashCommandResponses` сохраняет вид команд и их результатов в существующей истории сообщений.
- [Main: `annotateSlashCommandResponses`](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/main/services/team/teamMessageSlashResults.ts).
- Host `processSend` и `sendMessage` отвергают любой `parseStandaloneSlashCommand`, включая skills.
- [Stage 1: `createHostTeamMutations`](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/src/features/agent-backend/renderer/createHostTeamMutations.ts).
- Текущий Session SPI имеет submit/observe/interrupt/checkpoint/close, но не публичный control для compact/reset/model.
- Stage 1 наблюдает compaction и context epochs; ручная команда compaction от этого автоматически не появляется.
- [Stage 1: `RuntimeOwner`](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/runtime/RuntimeOwner.ts).

## 2. Закрываемая поверхность команд

До реализации заполнить компактную provider × command матрицу: old native result, новый native API, способ проверки.
У каждой клетки должен быть статус `proven`, `existing-ui-unverified` или `not-offered`; suggestion не меняет статус на `proven`.

| Семейство | Existing controls/commands | Владение и ожидаемый механизм |
| --- | --- | --- |
| Контекст | `/compact`, `/clear`, `/reset`, `/new` | Native control и корректный context boundary; aliases сверяются с провайдером |
| Live настройки | `/model`, `/effort`, `/fast`, `/plan`, `/permissions`, `/personality` | Управление исходной сессией, safe-point/readback, её сохранённые настройки |
| Read-only вывод | `/cost`, `/usage`, `/status`, `/mcp`, `/diff`, `/copy` | Существующие authoritative reads/clipboard, без фиктивного inference |
| Conversation actions | `/review`, `/fork`, `/resume`, `/agent`, `/quit`, `/exit` | Existing provider semantics и existing lifecycle ports, без чужой session selection |
| UI/native integrations | `/mention`, `/apps`, `/plugins` | Существующий UI/native operation; проверить, что был рабочий маршрут, а не только строка подсказки |
| Skills/custom commands | Project/user skill slash, известные native plugin commands | Выбранный captured skill/extension; command identity и допустимость args |

Для OpenCode raw-stdin ветка baseline явно отличается: не обещать паритет с Claude только из общей подсказки.
Если старая команда действительно работала, её нельзя убрать или оставить unsupported ради зелёного теста.
Если была только подсказка без рабочего native handler, явно зафиксировать неопределённость и проверить её до изменения UX.
Новая реализация не обязана придумывать provider capability, которой не было в старом приложении.

## 3. User stories и acceptance

1. Пользователь вводит поддерживаемую команду в прежний Composer, видит отправленную команду и её реальный результат.
2. `/compact` меняет native context и сохраняет обязательные team/MCP instructions в последующих turns.
3. `/clear` и aliases следуют подтверждённой native семантике; не удаляют задачи/файлы/команду продукта.
4. Live model/effort/fast применяется к нужной сессии и подтверждается следующим turn/native readback.
5. Текущий turn не уничтожается ради изменения настройки; время применения соответствует проверенной provider семантике.
6. После reconnect/resume видно подтверждённое актуальное значение; launch defaults меняются только если прежний UI это явно просил.
7. Skills продолжают вызываться из текущих подсказок и не теряются из-за общей slash-проверки.
8. Неизвестный результат команды не даёт второго compact/reset/model update при повторном открытии панели.
9. Late reply от старого run/member generation не меняет настройки или историю нового run.
10. При недоступном native действии UI показывает конкретную причину, а обычный slash не отправляется модели как просьба «сымитировать команду».

## 4. Минимальная архитектура

- Сохранить существующий Composer, parser, metadata и оформление command/result в activity.
- В Host mutation boundary различать обычное сообщение, typed session command и captured skill invocation.
- Native codecs и provider-specific controls находятся в source repo provider library, не в renderer/Host transport.
- Предлагаемый optional Session control port типизирован по ограниченному набору реально поддерживаемых операций.
- Capability declarations описывают operation/arguments; не создавать generic raw RPC или shell passthrough.
- RuntimeOwner сохраняет исходный `RuntimeBinding`, commandId, phase и native outcome под уже существующим member fence.
- Существующие Runtime store/command receipt используются повторно; отдельный event bus/journal не нужен.
- Для live settings достаточно небольшого подтверждённого session-settings snapshot с revision и application point.
- Snapshot принадлежит действующей сессии; общей publish/revision механикой управляет план 06.
- Восстановление использует существующие checkpoint/restore ports; неизвестный control outcome не replay автоматически.
- Read-only commands используют существующие captured projections и не стартуют новую conversation ради ответа.
- Skill invocation берёт существующий captured catalog и исходную skill identity; arbitrary filesystem path из slash args не становится authority.
- Не добавлять fallback к ambient CLI/stdin другого профиля, чтобы обойти отсутствующий D метод.

## 5. Порядок реализации и точные места

### Шаг A — native inventory перед универсальным интерфейсом

- Сопоставить строки `providerSlashCommands.ts`, `slashCommands.ts`, `skillCommandSuggestions.ts` с actual old native handler.
- Для спорных Codex `/apps`, `/plugins`, `/agent`, `/fork`, `/resume` проверить old workflow и публичный native API отдельно.
- Для Claude/Codex model/effort/fast проверить SDK/app-server параметры, current-turn policy и сохранение после resume.
- Для OpenCode V1/V2 проверить лишь фактически предлагаемые команды и variant semantics; не копировать чужие enums.
- Записать native source/version и минимальную E2E проверку каждой proven группы в capability matrix.
- Если native метод отсутствует, сначала source extension D/SDK adapter; простой перевод строки в `submit` не считается реализацией.

### Шаг B — provider source и Session contract

- В `agent-teams-ai/old-provider-implementations` расширить source Session contract и provider adapters узким control union.
- Предложенные payload: compact с optional focus; reset; live settings с проверяемыми model/effort/fast/permission fields.
- Conversation fork/resume и закрытие переиспользуют существующие lifecycle/checkpoint методы там, где совпадает семантика.
- Разделить requested/accepted/applied/unknown; native ACK не подменяет readback применения.
- Для provider, который применяет параметр только на next turn, сохранять этот application point в результате.
- Собрать source/contract artifacts штатно, привязать immutable commits и hashes; vendored dist не редактировать.
- Согласовать единый artifact pin с планом 01, чтобы login и Session controls не перетёрли друг друга.

### Шаг C — Host control и persist/readback

- Дополнить `packages/legacy-agent-host/src/runtime/contracts.ts` минимальными command/settings records.
- Вынести control helper рядом с `RuntimeOwner.ts`, если добавление нарушает source-size guard; owner не переписывать.
- Подключить helper к `RuntimeOwner` authorization `control`, current binding, busy/checkpoint guards и shutdown.
- Добавить typed operation в `src/features/agent-backend/contracts/operations.ts` и Host route composition `TeamHost.ts`.
- Если используется existing Team command receipt, расширить `team/contracts.ts` и `validateTeamCommand.ts` согласованно.
- Захватывать profile/run/member generation до native эффекта; validation отказ должен быть явно `known-not-sent`.
- После успешного control сохранить подтверждённые session settings и context boundary; после unknown — только исходный pending record.
- Не изменять активную сессию чужим model default update из плана 05.

### Шаг D — existing frontend adapter

- В `createHostTeamMutations.ts` заменить общий unsupported dispatch на typed command/captured skill route.
- Сохранить existing lead/attachments/cross-team restrictions и pending-send ownership при context switch.
- Связать результат с исходным commandId в message/activity projection; не приписывать следующий случайный assistant turn команде.
- `/model` без аргумента должен сохранить существующий пользовательский выбор, а не молча выбирать default.
- Read-only command output и user-facing errors используют прежние components; новая команда-панель не нужна.
- Проверить, что live setting readback обновляет visible controls и переживает reload; scope application не скрывать.

### Шаг E — E2E и native evidence

- Расширить Composer/skills/resume smoke на actual Host и pinned native engines с localhost model fixtures.
- В тестовой модели проверить фактический model/effort/fast payload, а не только текст «настройка сохранена».
- Для compact/reset проверить следующий turn, context epochs и MCP/task continuity, не только control receipt.
- К каждому native provider прикладывать собственный результат; успешный Claude сценарий не квалифицирует Codex/OpenCode.

## 6. Основные E2E сценарии

Harness: `desktop-composer-ui-smoke.ts`, `desktop-skills-ui-smoke.ts`, `desktop-resume-ui-smoke.ts`.
Native база: `native-claude-compaction.native.ts`, существующие Codex resume и OpenCode V2 fixtures.

| Сценарий | Что делаем | Что обязано быть доказано |
| --- | --- | --- |
| Compact continuation | Composer → compact → следующий task/MCP turn | Native compaction и новый context epoch; сохранены team инструкции/история результата |
| Reset/aliases | Создать контекст, вызвать proven reset/new/clear, отправить новый turn | Подтверждённая native семантика; нет удаления задач, подмены run или stale context |
| Live settings | Во время/между turns выбрать model/effort/fast, затем новый turn | Provider получает новые значения в нужной точке; старый turn завершён по policy |
| Reconnect/resume | Применить настройки, перезапустить UI/Host по допустимому пути, resume | Settings/readback восстановлены; defaults другого профиля не подменяют сессию |
| Lost ACK + old generation | Прервать ответ после effect, сменить run, открыть панель | Нет replay; late result привязан к старой операции и не меняет новый run |
| Skills/custom | Вызвать selected project и user skill из suggestions | Captured identity/args доходят до native route; обычный message wrapper не ломает команду |
| Informational/special | Выполнить proven cost/status/mcp и provider-specific conversation action | Данные соответствуют текущей session authority; реальные native outputs, без фиктивного prompt |
| UI restrictions | Slash с attachments, неверным recipient, offline lead; обычный текст затем | Сохранены понятные ограничения; обычные сообщения/attachments не регрессировали |

Для live settings один parameterized сценарий покрывает поддерживаемые provider tuples; не копировать harness на каждого.
Матрица показывает omitted/unverified cases отдельно; один общий PASS без списка команд не достаточен.

## 7. Ограниченные unit и оценка

- Unit: normalization/aliases и запрет восприятия обычного текста как управляющей команды.
- Unit: commandId/fingerprint + run generation mismatch, duplicate/lost-ACK receipt без повторного effect.
- Unit: atomic control против close/interrupt/checkpoint и недопустимое применение старого settings result.
- Unit: authoritative capabilities/argument validation; arbitrary raw RPC/secret fields не проходят boundary.
- Остальные UI и native transitions проверять E2E; не тестировать зеркально каждую ветку provider adapter.
- Production: **1 600–3 200** строк, включая live-session model/effort/fast Claude/Codex и новые D controls.
- E2E/fixture: **1 200–2 300** строк; критичные unit: **200–400** строк; общее количество не является целью.
- Prelaunch catalogs/defaults/model selection из плана 05 и общий profile lifecycle из 06 повторно не считаются.
- Сложность **8/10**; ожидаемая надёжность после приёмки **7/10**; уверенность оценки **5/10**.
- Главная неопределённость — old native semantics специальных команд; inventory может сузить или расширить подтверждённый объём.
- Закрытие среза требует сохранения всех proven old workflows; неподдержанная подсказка учитывается отдельно, а не скрывается.

## 8. Review

### R1 — авторская критика, выполнена 2026-11-12

- Найдено: расчёт по 10 shared commands игнорировал 21 Codex suggestion и dynamic skills.
- Исправлено: добавлена полная группировка и отдельный native inventory gate; suggestion не объявляется capability.
- Найдено: live Claude/Codex settings могли потеряться между планами 03 и 05.
- Исправлено: live control/readback/persistence и дополнительные 400–800 production строк явно включены здесь.
- Найдено: удаление общего slash guard отправило бы `/compact` обычным prompt, без требуемого native эффекта.
- Исправлено: typed control contract, applied readback и следующий actual turn включены в acceptance.
- Найдено: существующая эвристика «следующий reply — результат slash» опасна при асинхронном Host control.
- Исправлено: результат связывается с original commandId; late-generation E2E обязателен.

### R2 — независимое cross-review, pending

- Проверить completeness capability inventory, границу 05/06 и минимальность расширения Session SPI.
- Зафиксировать reviewer/docs commit и исправления; native unknowns не закрывать текстовым согласием.

### R3 — повторное review после R2, pending

- Проверить устранение замечаний, сохранение provider-specific семантики и достаточность native E2E.
- Implementation-ready версия должна назвать оставшиеся неизвестные native methods и способ их проверки до кодирования.
