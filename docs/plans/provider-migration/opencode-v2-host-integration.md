# OpenCode V2 в новом Host: отдельная qualification lane

Статус на 5 ноября 2026: **частичные native/embedded TEST E2E подтверждены на Linux x64, macOS arm64 и Windows Server 2022**,
но Stage 2 Host integration, реальные model/tool permissions, macOS/Windows packaged E2E
и production rollout **не квалифицированы**.
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

### Текущие проверенные native TEST-срезы (5 ноября 2026)

Штатный CLI upstream [OpenCode `v2.0.21`](https://github.com/anomalyco/opencode/tree/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72)
квалифицировался на выделенном Linux x64 AVX2 runner со временными
HOME/XDG/workspace, тестовой loopback-аутентификацией и pin SHA-256
фактического ELF. Доказательства принадлежат
[Provider Draft PR #2](https://github.com/agent-teams-ai/old-provider-implementations/pull/2);
его результат **не** опубликован как Host/Runtime API.

| Проверенная часть | Native TEST evidence | Ограничение |
| --- | --- | --- |
| ELF, PID, Basic Auth, OpenAPI и очистка | [CI 41944555707](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/41944555707) | Только Linux x64; `qualified:false` |
| Session create/read/delete и cold restart | [CI 41945394624](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/41945394624) | Без модели и tools |
| Permission deny/ask/reject и последующий 404 | [CI 41946568366](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/41946568366) | Native resolver, не tool invocation |
| Ordered allow/deny/ask, last-match-wins | [CI 41951065982](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/41951065982) | Только тестовые правила |
| Durable synthetic inbox, retry с тем же ID | [CI 41947094675](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/41947094675) | `resume:false`, без model turn |
| Lost ACK после принятого POST: readback, 0 retries | [CI 41950984060](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/41950984060) | Отдельная TEST-owned инъекция |
| Foreign session/permission отказ, first writer wins | [CI 41950529696](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/41950529696) | Native TEST-only identity |
| Real V2 user `/prompt`, durable inbox, lost ACK и 0 повторных POST | [CI 41954680976](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/41954680976) | `resume:false`, без исполнения модели |
| Local fake LLM: native model turn и assistant readback | [CI 41956054950](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/41956054950) | **STOP-SHIP:** `Session.log` возвращает только `log.synced` (watermark 12), без событий; terminal V03/V05 не доказан |
| Embedded `@opencode/sdk@2.0.21`, `events.persist:true`: настоящий TEST-local model turn → session.inbox.delivered → terminal → cold restart | [Linux x64 embedded-model job 127022083313](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/41959447572/job/127022083313), HEAD `43da939` | Один owned input, один durable terminal, 13 событий, сохранённые ID и 0 дополнительных model calls после cold restart; `qualified:false`, **не stock CLI**, не Host, не packed/Electron |
| Embedded SDK V2.0.21 macOS Intel x64: реальный model turn, native cursor и cold lineage | [CI 41963876230](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/41963876230), [artifact 13386946386](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/41963876230/artifacts/13386946386) | Отдельный поддерживаемый `macos-15-intel` runner; проверены арх. `darwin-x64`, 13 durable событий, 1 доставка, 1 terminal, projector=`succeeded`, `earlyModelRequests=0`, `completed:true`, `cleanup:true`; `qualified:false`, **не Electron** |
| Embedded SDK V2.0.21 macOS arm64 и Windows Server 2022: production codec, реальный message cursor, durable terminal и cold readback | [macOS job 127027822033](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/41961125113/job/127027822033), [Windows job 127027821885](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/41961125113/job/127027821885) | В обоих фактических артефактах 13 событий, 1 delivered, 1 terminal, `earlyModelRequests=0`, `cleanup:true`, `qualified:false`; без Electron/Host custody и настоящих tool permissions |
| Embedded SDK V2.1.4 Linux x64 / Windows Server 2022, disposable local model | [Linux run 41962941291 artifact 13385813105](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/41962941291/artifacts/13385813105), [Windows artifact 13386526095](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/41962941291/artifacts/13386526095) | Оба фактических JSON: `completed:true`, `cleanup:true`, 13 событий, одна delivery, один terminal, zero early inference, cold no-replay. **Driver `not_qualified`**: 2.1.4 не входит в его pinned pins; SDK TEST не является SPI/Electron-допуском |
| Embedded SDK V2.0.0 Node ESM install negative | [Linux run 41962808454 job 127032878914](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/41962808454/job/127032878914) | Публикация `@opencode/sdk@2.0.0` не разрешает `dist/opencode`; native turn не исполнялся. Это packaging/API hold, не отсутствие `idle` и не допустимый PASS |

**Runner mapping correction:** официальные labels GitHub Actions задают `macos-15` = Apple Silicon arm64, `macos-15-intel` = Intel x64; прежние отчёты, называвшие `macos-15` x64, описывали архитектуру неверно. Intel x64 **подтверждён отдельно** на `macos-15-intel` точным [прогоном 41963876230](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/41963876230), без заявления об Electron/Host. Unsupported `macos-15-arm64` заменён, платформа процесса теперь проверяется внутри TEST harness.

На уровне Desktop [Host Draft PR #1106](https://github.com/777genius/agent-teams-ai/pull/1106)
реализует лишь статический V2 candidate/HOLD preflight; на
[`0477fe8105`](https://github.com/777genius/agent-teams-ai/commit/0477fe81058edbdbed0f3e3858ec48e0df6693aa)
Fast feedback [SUCCESS](https://github.com/777genius/agent-teams-ai/actions/runs/41951312245),
но обязательная Full qualification Draft преднамеренно не выдаёт merge certificate.
Нативный TEST model turn уже вызвал локальный fake provider и записал assistant
readback, **но не подтвердил terminal/event lineage**: живой
`GET /api/experimental/session/:id/log?follow=false` вернул только `log.synced`,
хотя watermark увеличился и сообщения доступны. Фикстуры V2-драйвера нельзя
считать доказательством работающего read/observe **на штатном CLI**. Однако
встроенный SDK предоставляет отдельный проверенный TEST-путь с явным
`events.persist:true`: на Linux x64 в действительном embedded model-turn
прошли native event/assistant lineage и cold readback. Это не переключает
продукт на SDK и не квалифицирует process custody, V1/V2 permission/tool mapping,
выбранные OS-архивы или Desktop UI.
Ни один native receipt пока **не** доказывает передачу владения процессом/сессией
в Host, реальные MCP/tool permissions, selected Electron package
или M01–M19 нового Orchestrator/Runtime.

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
- **Effective V2 permission gate:** официальный
  [V1→V2 migration guide](https://dev.opencode.ai/v2/docs/migrate-v1/)
  подтверждает изменение default: V1 запрашивает разрешение на доступ вне
  проекта, V2 по умолчанию допускает `external_directory`. Нельзя наследовать
  это расширение прав как «совместимую» конфигурацию. Host сверяет effective
  ordered `permissions` и выбранную product policy; при отсутствии
  подтверждённого ask/deny пути удерживает запуск (HOLD), не переписывая
  пользовательские файлы. В V2 `bash→shell`, `task→subagent`,
  `write/patch→edit` — это изменение семантики, не простое имя в UI.
  V1 plugin hooks должны отдельно проходить
  [V2 plugin migration](https://dev.opencode.ai/v2/docs/build/plugins/migrate-v1).
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
   lost ACK, cold restart и resource custody. Отдельный native TEST:
   доступ за пределы workspace требует выбранного explicit grant (если политика
   требует ask), default-allow не считается авторизацией Host.
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
| V02 | Чтение **effective** config/auth/agent/MCP/ordered permissions            | Нет implicit `external_directory` allow, чужой auth или V1 plugin reuse       |
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
