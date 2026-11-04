# OpenCode V2 в новом Host: отдельная qualification lane

Статус: **design + source audit, реализация и native E2E ещё не подтверждены**.
Владелец 4 ноября 2026 запросил V2 отдельно от ранее принятого Stage 1.
Зависимость — [Stage 1](stage-1-legacy-host.md), [Stage 2](stage-2-new-cores.md).
Это не переключатель по умолчанию и не изменение существующего UI.

## 1. Факты и текущие расхождения

| Источник / contract                                                           | Проверенный факт                                                                                                                            | Вывод                                                                                              |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/legacy-agent-host/src/composition/runtimeProfile.ts` PR #982        | OpenCode profile принимает только `1.18.35` / `1.19.4`; `OpenCodeMemberProvider` вызывает `createOpenCodeV1DriverFactory`                   | Host V2 **ещё не подключён**, нельзя переименовать V1 factory                                      |
| `old-provider-implementations` PR #1 `7573a508`, `v2-driver-config.ts`        | `snapshotDriverConfig` допускает только `2.0.0` / `2.0.21` и требует существующий `nativeSessionId`, bound loopback и read-only probe       | Не расширять список версий без actual protocol/native qualification; сборка не равна работе модели |
| Desktop main `runtime.lock.json` `62709419`                                   | Для V2 pinned qualified engines включают `2.0.0`, `2.0.32`, `2.1.4` на разных OS/arch; есть отдельные delivery descriptors                  | Launcher engine qualification **не переносится автоматически** на standalone Session SPI driver    |
| Desktop `docs/plans/opencode-provider-generation-compatibility-2026-11-01.md` | Новые установки V1; существующий/явно выбранный V2 сохраняется; Cursor/Kiro/SuperGrok OAuth/Copilot OAuth V2 managed routes не адаптированы | Не ставить этим маршрутам `supported`; `xai` API key не путать с `supergrok` OAuth                 |
| Официальная [миграция V1→V2](https://dev.opencode.ai/v2/docs/migrate-v1/)     | Новые server/plugin API; V1 конфиги читаются частично совместимо; V1 plugins не работают в V2                                               | Нельзя использовать V1 клиент, plugin injection или V1 resume contract без V2 proof                |

Нормативны **выбранные exact source и опубликованные runtime artifacts**,
а не версия из каталога моделей или успешный login. Официальный
[embedded SDK](https://dev.opencode.ai/v2/docs/build/sdk/) может быть
пригодным механизмом, но только если его custody соответствует
фактическому Node/Electron/Host, process/cleanup и invariant старого порта.
Новый транспорт не создаётся только ради более красивой структуры.

## 2. Граница и архитектурное решение

- Оставить существующий UI, `AgentBackendApi`, Team→Runtime port, Session SPI
  и единственный Team/Task/Message writer. V1 adapter неизменен.
- Ввести **явно выбранный native generation/profile** в trusted Host composition
  (не выводить из имени модели, CLI PATH или формы). Использовать существующую
  generation-compatibility логику frontend, но не дублировать её allow/deny матрицу.
- Отдельный приватный V2 provider adapter за Session SPI: versioned server API,
  owned read/submit/permission/interrupt/checkpoint; секреты и нативные IDs
  не выходят в renderer/public Task DTO. Нет per-model или per-failure fallback на V1.
- V2 config/profile translation должна сохранить исходные V1 файлы, owner/namespace,
  MCP permissions и checkpoint identity. V1 plugin implementation нельзя
  автоматически объявить V2-compatible. Смена generation не усыновляет
  active/unknown V1 session.
- Совместные utility допускаются только для **проверенных** одинаковых правил
  (bounded parsing, authority, nonce, resource cleanup). V1 и V2 протоколы,
  модель permission, authentication и event ordering не объединять ради DRY.
- Без новых feature flags, второго UI, второго журнала, background probes,
  автоконверсии user files и автоматического режима rollout.

## 3. Минимальные delivery slices

1. **V2.0, static gate.** Зафиксировать exact binary/engine SHA, selected OS/arch,
   published API/client package, capabilities, negative versions; сравнить
   `2.0.21` из provider factory с текущими `2.0.32/2.1.4`. Открыть provider
   package PR только при доказанной поддержке выбранного protocol.
2. **V2.1, provider library.** Native V2 test-owned server/client transport;
   trusted session selection, identity, tool/permission mapping, event parser,
   status/missing/not-submitted taxonomy; V1 regression suite без изменений.
3. **V2.2, Stage 1 Host adapter.** Вписать V2 profile/config в существующую
   композицию без смены Team/Runtime owners и без нового UI. Первая вертикаль:
   один выбранный TEST member, handshake → submit → observe → stop → readback.
4. **V2.3, parity.** Existing Create/Launch/Resume, mixed providers, Tasks,
   approvals/interrupt, MCP/team tools, messages, cross-team, review/attachment,
   lost ACK, cold restart и resource custody.
5. **V2.4, release candidate proof.** Pinned native tuples, full CI + CodeQL,
   packed Electron, independent reviews и actual data/provenance receipts.
   Real account/subscription proof отдельно, если действительно доступен;
   synthetic pass не повышает `unverified` до model `verified`.

Если нужен дополнительный API endpoint, меняем единственный owning
provider adapter и тестируем контракт, не дублируем raw V2 протокол в Desktop.

## 4. E2E contract matrix и stop conditions

| ID  | Положительное доказательство                                               | Обязательное отрицательное доказательство                                      |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| V01 | Native V2 binary/engine/version/digest и выбранный profile                 | Старый или неподдерживаемый version, подменённый exe, чужой profile → HOLD     |
| V02 | Чтение config, auth namespace, model/provider/agent и MCP policy           | Нельзя подменить credentials, V1 plugin не объявляется V2 plugin               |
| V03 | Session submit → native ack → ordered feed → terminal outcome              | Lost ACK/UNKNOWN не повторяет submit, late feed не откатывает cursor           |
| V04 | Permission/reply и targeted interrupt/control                              | Stale/foreign reply не grant; interrupt A не отменяет B                        |
| V05 | Cold selected resume с настоящим native history prefix                     | Несовместимый V1 checkpoint или missing V2 history → explicit HOLD             |
| V06 | Existing CreateTeamDialog/LaunchTeamDialog, Tasks, DM, cross-Team и review | Нет дополнительного writer, двойного recipient effect, replay под другим owner |
| V07 | Stop/close/cleanup всех captured child resources, backed process ledger    | Shared/foreign child не убивается, UNKNOWN custody не считается clean          |
| V08 | Selected macOS/Windows/Linux native + packed and CodeQL, actual receipts   | Не заявлять платформы, для которых нет proof; no release/default switch        |

## 5. Ревью решения до кода

**Security critic:** auth scope, exact process custody, stale authority,
permission grant, MCP tools и внешняя config mutation — стоп-факторы.

**Contract critic:** V1/V2 различия в событиях, отсутствующих сессиях,
checkpoint/history, owner binding и typed errors. TypeScript assignability
не считается behavioral proof.

**Test/UX critic:** независимые нормальные Electron UI сценарии,
cold restart, cancelled/unknown effects и visual checks существующих controls.
Два ревью и исправления по замечаниям обязательны в implementation PR;
этот документ **не утверждает**, что независимые агенты уже провели ревью.

Пока все V01–V08 и M01–M19 для selected V2 комбинации не подтверждены,
OpenCode V2 в **новом** Host не считается интегрированным. Stage 1 остаётся
V1-only, но существующая отдельная V2 интеграция приложения не удаляется.
