# 02. OpenCode V2: существующие маршруты подключения по ключу

Статус: план реализации; изменения production и native credentials не выполнялись.
Frontend baseline: `4a0e06277fe216d9f82dbbede362668fe46622ee`.
Host baseline: `1d0f97f55de566036c970eab4f36b84620afdb3f`.
Цель: существующие V2 key-connect/original-intent reconnect и проверка подключения работают через Host; V1 forget сохраняется.
Новые OAuth-интеграции, новые подписочные планы и новый secrets service в этот срез не входят.

## 1. Точный baseline и граница доказательства

- Providers, Quick Connect и onboarding используют общий `RuntimeProviderManagementPort`.
- `AgentTeamsRuntimeProviderManagementCliClient.connectProvider` передаёт API key существующему `runtime providers connect`.
- [Main: `connectProvider` и `forgetCredential`](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/features/runtime-provider-management/main/infrastructure/AgentTeamsRuntimeProviderManagementCliClient.ts).
- V2 plain-key route намеренно не передаёт auth option selector; это сохранённый regression invariant.
- [Main: `buildSetupAuthSelector` tests](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/features/runtime-provider-management/renderer/hooks/runtimeProviderManagementInternals.test.ts).
- Onboarding выбирает Kimi CN/global integration по выбранному пользователем домену аккаунта.
- [Main: `useRuntimeProviderOnboarding` Kimi V2 tests](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/test/renderer/features/runtime-provider-management/useRuntimeProviderOnboarding.test.ts).
- Наличие этого UI и proxy не доказывает успешный native login каждой подписки; такую проверку нужно получить отдельно.
- Main уже запрещает V2 SuperGrok/GitHub Copilot OAuth и Cursor/Kiro CLI routes.
- Прочие V2 routes помечены `unverified` с разрешённым connect, а не объявлены доказанно поддержанными.
- [Main: `resolveOpenCodeProviderCompatibility`](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/features/runtime-provider-management/core/domain/openCodeProviderCompatibility.ts).
- Дополнительно прочитан native source `e13edcd3d4ffbecc0272ae30195cc6b15b710ee7`: `connectOpenCodeV2Provider` принимает только plain key и требует selected-model proof.
- Он согласует native connection с shared auth mirror и защищает существующие V1 credentials; эти ограничения нельзя потерять при переносе.
- [Native donor: `connectOpenCodeV2Provider`, `buildOpenCodeV2KeySetupForm`, `rollbackOpenCodeV2OwnedConnection`](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/features/runtimeProviderManagement/adapters/opencode/OpenCodeV2ProviderManagement.ts).
- Source read подтверждает реализацию key route, но не версию установленного у пользователя CLI и не vendor account success.
- `submitConnect` передаёт reconnect напрямую в connectProvider, без автоматического forget; native connect требует initially empty private connection store.
- Поэтому бесшовная замена произвольного existing key не доказана baseline и не объявляется новой обязанностью parity.
- [Main: `submitConnect` и отдельный `forgetProvider`](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/features/runtime-provider-management/renderer/hooks/useRuntimeProviderManagement.ts).
- В Stage 1 `ProviderManagementCoordinator.credentials.validate` отвергает все V2 credential mutations.
- OAuth V2 также отвергается; изменение этого ограничения не требуется для parity указанных key routes.
- [Stage 1: `ProviderManagementCoordinator`](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/composition/ProviderManagementCoordinator.ts).
- `OpenCodeV2ManagementHost` показывает только selected provider; `authMethods: []`, `connected: false` выставлены явно.
- [Stage 1: `OpenCodeV2ManagementHost.read`](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/adapters/providers/OpenCodeV2ManagementHost.ts).
- Работающий V1 connect/forget сохраняется и служит донором receipt/fence поведения, но не V2 protocol codec.
- Дополнительный R2 проверил donor `e13edcd…`: [V2 directory](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/features/runtimeProviderManagement/adapters/opencode/OpenCodeV2ProviderDirectory.ts) предлагает connect/use/configure, без forget.
- `forgetManagedCredential` остаётся в V1 managed-client; [explicit regression](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/features/runtimeProviderManagement/adapters/opencode/OpenCodeProviderManagementAdapter.test.ts)
  `legacy provider mutations reject v2 inventory before host acquisition` прямо включает forget.
- Поэтому успешный V2 disconnect не является доказанным old workflow; native `credential.remove` в donor используется для owned rollback.
- Перед implementation проверить существующие V2 Settings/Quick Connect controls: если они всё же предлагают forget,
  зафиксировать это как existing-UI/native mismatch с отдельным решением R3, не выдавать за перенесённую рабочую функцию.

## 2. Пользовательские истории и acceptance

1. Из существующей карточки провайдера пользователь открывает форму и сохраняет ключ в выбранном V2 account scope.
2. При необходимости выбирает прежний regional route; ключ не отправляется провайдеру другого региона.
3. Reconnect сохраняет existing route semantics: подтверждённый original intent читается повторно, конфликтующий existing connection не перезаписывается.
4. V1 Forget продолжает удалять managed credential и показывать оставшийся env/config доступ; V2 не получает выдуманного supported action.
5. Connect сохраняет показанную формой проверку одной модели; «ключ сохранён» и «подключение проверено» остаются разными результатами.
6. После перезапуска приложения выбранное подключение остаётся доступным; временный metadata namespace не становится хранилищем ключа.
7. Неудачный native ответ/потерянный ACK не приводит к автоматическому повтору credential mutation.
8. V2 OAuth routes, уже заблокированные main, сохраняют прежние объяснения; этот срез не выдаёт их за новые возможности.
9. Новый автоматический delete-and-replace workflow не вводится; V2 conflict не разрешается скрытым вызовом rollback как пользовательского forget.
10. На V1 те же controls и сохранённые credentials продолжают работать.

## 3. Минимальная архитектура и reuse

- UI, формы, regional mapping и `RuntimeProviderManagementPort` остаются источником продуктового поведения.
- `CapturedRuntimeProviderManagementClient` уже умеет connect/forget, проверяет receipt и читает тот же captured target.
- [Stage 1: `CapturedRuntimeProviderManagementClient`](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/src/features/runtime-provider-management/main/adapters/output/CapturedRuntimeProviderManagementClient.ts).
- Переиспользовать `CredentialCommandOwner`, `FileManagementCommandStore`, `ManagementResourceFence` и `credential.lookup`.
- `CredentialCommandOwner` сохраняет fingerprint для matching, но не raw secret в command journal.
- [Stage 1: `CredentialCommandOwner.execute/lookup`](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/management/CredentialCommandOwner.ts).
- Native V2 codec принадлежит provider implementation; Host выбирает captured namespace и владеет native lifecycle.
- Ключ хранится штатным native credential route, совместимым с выбранным V2 runtime, а не в новом app-level vault.
- Temporary catalog/probe directories остаются расходуемыми; durable credentials имеют существующий явно выбранный scope.
- Общую публикацию profile revision, выбор scope и recapture реализует план 06; здесь только credential effect/readback.
- Каталоги, defaults, prelaunch effort и model preferences относятся к плану 05.
- Данные об authentication method и connected state выводить из фактического native readback; не hardcode `true` после API call.
- Не запускать модель при пассивном чтении Providers; connect выполняет объявленную формой verification, отдельный Test model — повторную явную проверку.

## 4. Пошаговая реализация

### Шаг A — зафиксировать поддерживаемый native key contract

- Использовать прочитанный `connectOpenCodeV2Provider` как native donor; сопоставить actual packaged CLI version и V2 action-set gate.
- Записать immutable source permalink, native V2 version и точный credential namespace до начала кода.
- Для каждого visible route проверить plain-key method и providerId/region; дополнительные auth forms baseline сейчас отвергает.
- Отдельно проверить key-connect и owned rollback без conversation allocation/побочного OAuth; объявленная model verification идёт следующим явным этапом того же intent.
- Конкретные donor APIs: `integration.get({location,integrationID})`, `integration.connect.key({location,integrationID,key})`,
  `credential.remove({credentialID})` только для доказанного owned rollback; форму pinned 2.1.4 сверить с delivered SDK.
- Если текущий D API не экспортирует нужный метод, добавить узкий typed management codec в source repo `agent-teams-ai/old-provider-implementations`.
- Не ослаблять allowlist session-owned V2 transport ради global credential API; management adapter получает отдельный finite captured scope.
- Собрать immutable artifact штатным путём и обновить frontend pin; не редактировать tgz/dist вручную.
- Если main route реально не работает на выбранном native V2, зафиксировать это в capability matrix и исправить доступный native adapter.
- Неподтверждённый маршрут не скрывать молча и не считать закрытым одной формой в UI.

### Шаг B — V2 credential effect через существующего владельца

- В `packages/legacy-agent-host/src/composition/ProviderManagementCoordinator.ts` разрешить qualified V2 set и его owned rollback;
  самостоятельный V2 forget не добавлять без результата baseline gate/R3 выше.
- Оставить запрет refresh/OAuth для маршрутов, у которых такого native контракта нет.
- Добавить узкий V2 credential adapter рядом с `OpenCodeV2ManagementHost.ts`; общий coordinator остаётся диспетчером.
- Использовать существующие owner/resource fences и process custody, а не второй journal или отдельный daemon.
- После native operation выполнить readback на том же auth namespace и вернуть существующий `ProviderCredentialReceipt`.
- Сохранить V1 shared-auth conflict guard и compare-before-remove для owned connection; rollback не должен удалять изменение другого владельца.
- `completed` выдаётся только после известного результата и подтверждённой очистки принадлежащего operation ресурса.
- Неизвестный outcome сохраняет исходный commandId/target; последующее действие сначала делает lookup, не повторную запись.

### Шаг C — совместимость с профилями и app flow

- В `CapturedRuntimeProviderManagementClient.ts` сохранить plain-key вариант без лишнего auth selector.
- Для неизвестного исхода добавить/reuse compact durable intent со ссылкой на target и commandId, без ключа.
- Не вводить generic command bus ради одного pending credential intent.
- В `OpenCodeV2ManagementHost.ts` убрать постоянные пустые auth methods только для доказанного selected route.
- Подключить native authenticated/configured observations и показать их существующей projection `capturedManagementCatalog.ts`.
- Согласовать с планом 06 момент смены revision после credential change; текущая операция завершает исходный target.
- Connect verification переиспользует finite native probe из P05 внутри того же credential intent и того же target.
- Не вызывать публичный `ModelProbeOwner.start` из `CredentialCommandOwner.perform`: оба резервируют тот же resourceId,
  что даёт self-conflict. Один внешний owner/fence и persisted original verification reference, без второго command journal.
- Самостоятельный Test model по-прежнему проходит обычный ModelProbeOwner; connect не делает второй автоматический probe.
- При неудаче probe сохранить native transaction state: original intent может остаться pending/held после credential publication.
- В UI не показывать общий successful connect и не удалять pending marker; показывать исходную ошибку verification с доступным readback/recovery.
- Не создавать автоматический повторный Test model или альтернативную модель после pending/failed original proof.
- При forget не удалять чужой HOME/config, external credentials или credentials других providerIds.

### Шаг D — E2E и regression

- Расширить имеющийся V2 desktop fixture и native management test; единый TEST provider записывает число native effects.
- Пройти V2 UI connect/original-intent reconnect/readback и V1 forget после cold restart на тех же artifact bytes.
- Выполнить один V1 regression route с теми же UI controls, чтобы общий client не сломал старое подключение.
- Реальные vendor routes квалифицировать отдельно от controlled TEST key route; receipt явно называет проверенный route.

## 5. Существенные E2E

Harness: `scripts/legacy-agent-host/desktop-opencode-v2-fixture.ts` и существующий Desktop CDP smoke.
Host/native база: `native-opencode-management-host.native.ts`, `opencode-v2-management-recovery.test.ts`.
Test provider использует localhost и isolated TEST auth namespace; не реальные пользовательские credentials.

| Сценарий | Пользовательское действие | Обязательная проверка |
| --- | --- | --- |
| Первое подключение | Providers → выбранный V2 provider → key connect с объявленной verification | Один set и одна connect-verification; native readback; verified выбранная модель |
| Regional key route | Выбрать Kimi CN/global, сохранить TEST key | Исходный providerId/region совпадает от UI до native request; соседний scope неизменён |
| Reconnect + restart | Повторить исходный connect, открыть приложение снова; затем проверить conflicting key | Original receipt/readback без повторного POST; конфликт не перезаписывает credential; preferences сохранены |
| V1 Forget / V2 boundary | V1 удаление при env auth; проверить action set V2 и owned rollback race | V1 scope сохранён; V2 rollback не превращён в новый forget; чужой credential не удалён |
| Потеря ответа | Удержать ACK после native set, переподключить UI | Lookup исходного command; нет второго set и переноса на новый profile |
| Ошибка проверки / fence | Credential publication выполнена; original probe success/error/unknown под тем же owner | Нет self-conflict fence; pending/held сохраняется; нет второго inference, false connected или потери evidence |
| Граница V1/V2 | V1 connect/forget, V2 запрещённый OAuth route | V1 regression PASS; V2 не предлагает ложный поддержанный OAuth workflow |

Receipt содержит route identity, scope fingerprint, commandId, native effect count, probe result и cleanup result.
В логах, screenshots и receipts отсутствуют raw keys, credential payload и пользовательские auth paths.
Native vendor PASS прикладывается только для реально проверенного account/model, без обобщения на все маршруты.

## 6. Только опасные unit-инварианты

- Одна таблица route/region + plain-key selector, с V2 OAuth exclusions из текущего compatibility policy.
- Один тест original commandId/resource binding при lost ACK/restart и запрет replay с другим payload.
- Один тест redaction и distinction configured/authenticated/probe-success в public projection.
- CRUD UI, повторное открытие формы и happy-path readback проверяются E2E, без зеркальных unit на каждый wrapper.

## 7. Владение, оценка и риски

- Этот срез владеет credential mutation, readback, pending intent и отображением результата подключения.
- План 05 владеет catalogs/default/model probe selection; план 06 — profile lifecycle и publication.
- Plan 01 использует общие management owners; changes в owner abstractions интегрируются одним согласованным patch.
- Production: **500–900** новых/существенно изменённых строк, без общего profile registry и native generated code.
- E2E/fixture: **450–850** строк; unit: **100–180** строк; сокращать при reuse существующих сценариев.
- Сложность **6/10**; ожидаемая надёжность после приёмки **8/10**; уверенность размера **6/10**.
- Это оценка реализации известных key routes, не обещание поддержки всех upstream plugins.
- Главный риск — temporary V2 catalog namespace: записанный туда ключ исчезнет после cleanup и даст ложный happy path.
- Второй риск — vendor route может требовать native feature, которой нет в текущем D API; source extension входит в диапазон для key-connect/owned rollback.
- OAuth browser integration и новые companion adapters не маскировать как небольшой key adapter change.
- Готовность: existing controls и V1 regression работают, restart подтверждён readback, V2 action-set gate закрыт и required gates успешны на exact HEAD.

## 8. Review

### R1 — авторская критика, выполнена 2026-11-12

- Найдено: прежняя оценка могла принять все разрешённые UI routes за квалифицированную V2 auth поддержку.
- Исправлено: отдельно указаны `unverified`, main exclusions, native contract gate и отдельные vendor receipts.
- Найдено: reuse read-only metadata child без отдельного durable scope теряет credentials при cleanup.
- Исправлено: storage namespace обязан совпадать с native runtime credential scope; temporary directories исключены из durable записи.
- Найдено: новый UUID на каждом повторном connect после lost ACK может повторить effect.
- Исправлено: добавлен узкий pending-intent/lookup шаг с исходным target, без нового общего журнала.
- При дополнительном source review найдено: native connect включает model proof и V1/shared-auth conflict guards.
- Исправлено: сохранены connect verification и owned rollback; plain-key scope не расширен до дополнительных auth forms.
- Проверены actual coordinator refusals и существующий CredentialCommandOwner; новые production API ещё не заявлены существующими.

### R2 — независимое cross-review, исправления внесены 2026-11-12

- Reviewer: root; reviewed docs commit `01547868`, PR #1186.
- Найдено: обещание замены existing key было шире native `before.connections.length === 0`; UI reconnect не выполняет forget автоматически.
- Исправлено: сохранены original-intent reconnect и conflict semantics; явный forget отделён от connect, seamless replacement не обещан.
- Найдено: таблица connect → Test model могла требовать вторую автоматическую inference сверх существующей connect verification.
- Исправлено: один connect включает одну объявленную verification; дополнительные explicit Test действия не являются автоматическим шагом.
- Найдено: probe failure в donor сохраняет pending intent, а не обязательно завершённую запись с простым error status.
- Исправлено: acceptance/E2E сохраняют original pending/held и запрещают ложный connected, новый inference и удаление evidence.
- Повторная проверка root после этих исправлений ожидается; R2 не объявляется принятой автоматически.

Дополнительный независимый R2: reviewer `estimate_platform_acceptance`, 2026-11-12;
входной docs commit `bedaf5aae9d81033704636b5362472ddab5818d3`, D source `d58500bc…`, donor `e13edcd…`.

- **R2-02-04:** V2 forget был назван working baseline без handler; найден explicit donor rejection. Разделены V1 regression, V2 action-set gate и owned rollback.
- **R2-02-05:** nested public model probe занял бы reservation credential owner. Указан reuse finite native probe под одним intent/fence.
- **R2-02-06:** V1 `/auth` и session-owned V2 wire не дают generic credential authority. Названы реальные integration APIs и узкий management scope.
- Проверены source functions/tests, owner reservation и temporary V2 metadata namespaces. Production не изменён; R3 gate остаётся обязательным.

### R3 — повторное review после R2, pending

- Перепроверить поддержку именно existing key routes и ограниченность изменений в generic owners.
- Утвердить implementation-ready план только после устранения найденных противоречий и фиксации native qualification границ.
