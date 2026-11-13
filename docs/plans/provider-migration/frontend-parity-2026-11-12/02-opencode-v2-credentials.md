# 02. OpenCode V2: существующие маршруты подключения по ключу

Статус: D protocol/directory опубликованы; Host/Main реализация и native journey подготовлены, итоговые native/Desktop gates ещё не завершены.
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
- Подтверждённый native failed terminal отличать от boolean false/timeout. После своего `key-published`, qualified failed terminal и confirmed cleanup обычный новый Connect может явно исправить ключ, только если текущий authDigest совпадает с исходной owned publication. Чужой V1 ключ и unknown POST таким разрешением не становятся.

### Шаг C — совместимость с профилями и app flow

- В `CapturedRuntimeProviderManagementClient.ts` сохранить plain-key вариант без лишнего auth selector.
- Для неизвестного исхода использовать только existing Host credential ledger: `credential.pending` находит исходный незавершённый intent, `credential.resume` проверяет exact payload fingerprint и читает receipt. Отдельного Main journal нет.
- Не вводить generic command bus ради одного pending credential intent.
- В `OpenCodeV2ManagementHost.ts` убрать постоянные пустые auth methods только для доказанного selected route.
- Подключить native authenticated/configured observations и показать их существующей projection `capturedManagementCatalog.ts`.
- Согласовать с планом 06 момент смены revision после credential change; текущая операция завершает исходный target.
- Connect verification переиспользует finite native probe из P05 внутри того же credential intent и того же target.
- Не вызывать публичный `ModelProbeOwner.start` из `CredentialCommandOwner.perform`: оба резервируют тот же resourceId,
  что даёт self-conflict. Один внешний owner/fence и persisted original verification reference, без второго command journal.
- Самостоятельный Test model по-прежнему проходит обычный ModelProbeOwner; connect не делает второй автоматический probe.
- При неудаче probe сохранить native transaction state: original intent может остаться pending/held после credential publication.
- Qualified native rejection возвращает безопасный `verification-rejected`: UI сообщает, что ключ сохранён, а модель не прошла проверку, и позволяет явный corrected Connect. Transport unknown остаётся pending; его не превращают в rejection по одному cleanup.
- В UI не показывать общий successful connect и не удалять pending marker; показывать исходную ошибку verification с доступным readback/recovery.
- Не создавать автоматический повторный Test model или альтернативную модель после pending/failed original proof.
- При forget не удалять чужой HOME/config, external credentials или credentials других providerIds.

### Шаг D — E2E и regression

- Расширить имеющийся V2 desktop fixture и native management test; единый TEST provider записывает число native effects.
- Пройти V2 UI connect/original-intent reconnect/readback и V1 forget после cold restart на тех же artifact bytes.
- Включить V1 connect/forget в тот же regression journey, без второй дублирующей E2E-строки.
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
| Исправление своего неверного ключа | Native HTTP401 → configured/unverified → restart → обычный Connect с исправленным ключом | Qualified failed terminal + cleanup + неизменённый owned authDigest; новая явная операция успешна, чужой ключ не заменён |
| Ошибка проверки / fence | Credential publication выполнена; original probe success/error/unknown под тем же owner | Нет self-conflict fence; pending/held сохраняется; нет второго inference, false connected или потери evidence |
| Граница V1/V2 | В рамках предыдущего V1 journey проверить запрещённый V2 OAuth route | V1 regression PASS; V2 не предлагает ложный поддержанный OAuth workflow |

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

### Implementation receipts — первый source slice

- D key protocol опубликован в [`b4499afb`](https://github.com/agent-teams-ai/old-provider-implementations/commit/b4499afb7a48c4efb67e4a494690aca0921672ef).
- Сверен официальный `@opencode/client@2.1.4`: archive SHA256 `bf888e996a3cc8e2884ca1d5503b00de4d8253af012facc62305c9156451e197`, npm integrity проверен.
- Finite credential client: native integration read, единственный key POST, exact readback, rollback только собственного credential; Session SPI не расширен.
- Protocol invariants: 5/5 PASS; full `pnpm check` на Node 24.21.0 и 26.11.1 / pnpm 11.18.0 PASS, включая packed consumers.
- Combined immutable provider archive SHA256 `659039aad0693903555be363ce055bf0c50864b385486f8313f6f3b6600a1cc2`; SPI archive остался побайтно прежним.
- Host `OpenCodeV2CredentialScope` использует existing captured `XDG_DATA_HOME/opencode/auth.json`; HOME alternative остаётся read-only conflict input.
- Scope build и три группы critical invariant tests PASS: cold read/preservation/owned rollback, foreign conflict, namespace/symlink/revocation.
- Compare-before-publication действует под Host writer lease; он не объявляется cross-process CAS с независимым внешним CLI.
- **P02 ещё не завершён:** подключение Host transaction, единая connect-verification, UI intent/recovery и native/Desktop gate остаются следующими шагами.
- Protocol fixtures не являются квалификацией реального vendor key или successful native model request.

### Implementation receipts — Host/Main wiring и native journey

- D private credential witness опубликован в [`189bd47`](https://github.com/agent-teams-ai/old-provider-implementations/commit/189bd47ccd33edd9d5abedf7075f3e53dd38bb42); all-provider directory — в [`91eb501`](https://github.com/agent-teams-ai/old-provider-implementations/commit/91eb501568286b4c99135271c88f335a6136928b). Combined Node24/26 checks и immutable package validation PASS.
- `OpenCodeV2CredentialOperation` использует existing owner/fence, native key POST/readback, guarded native auth.json publication и один finite probe. `OpenCodeV2SessionCredential` импортирует только выбранный key; private witness хранится в native session metadata, не в instructions.
- Exact core2.1.4 source выявил migration всех ключей из Global.data/auth.json в новую БД. `OpenCodeV2EmbeddedServer` задаёт private child XDG_DATA_HOME внутри owned DB namespace; исходный account scope остаётся Host capture.
- Passive directory не импортирует ключи. Saved source показывается как configured/unverified; connected требует последнюю завершённую verification для текущего authDigest. Более новый failed/unknown intent не скрывается старым успехом.
- Main сохраняет existing forms, V2 native key selector и V1 Forget. Fresh Connect получает UUID; original pending/resume — только read/fingerprint control, без повторной отправки. Дополнительного UI или credential journal нет.
- Critical preflight до последнего integration review: Host build/testtypes, 31 Host tests, 11 Main tests, focused Main types и fast lint PASS. После R4 нужен общий rebuild/testtypes на финальном combined tree.
- `opencode-v2-credentials.native.ts` и Linux preflight step подготовлены: actual401 → cold corrected key → success, lost ACK readback, saved-key Check, отдельный timeout → cold no-replay. Native SQLite читается только для TEST evidence: один credential на intent и отсутствие foreign key; секреты не входят в receipt.
- Этот journey ещё должен пройти в штатном CI. Desktop Providers/Quick Connect и regional route acceptance остаются открытыми; source/fake preflight не выдаётся за native/vendor/Desktop PASS.

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

### R3 — интеграционное review, выполнено 2026-11-12

Reviewer: root; входной published SHA `cda065d869ccffb5930ed2a817b3e0654b00bb31`.
Сопоставлены donor `connectOpenCodeV2Provider`, actual action set, `CredentialCommandOwner`, management admission и P05/P06/P10.

- Подтверждён один credential intent/fence: finite connect verification внутри него, public Test model отдельно. Self-conflict не устраняется ослаблением fencing.
- Подтверждены plain-key, original-intent recovery и compare-before-remove rollback; V2 standalone forget не добавлен за пределами baseline.
- Найден двойной V1 regression budget; сценарии объединены. Shared account UI startup/reconnect использует P10, native key protocol проверяется отдельно от Codex login.
- План принят для реализации; native key/action-set и actual durable namespace ещё требуют исполнения, а не только source review.

### R4 — integration review: неверный ключ и неизвестный ответ

- Reviewer: root; проверены exact2.1.4 `v2-turn-projection.ts`, `driver-session.ts`, native `Integration.connection.key` и credential storage API.
- Найдено: boolean false от probe не различает подтверждённый отказ и потерянный ответ. `wasRejected()` теперь принимает только исходный qualified `execution.failed` с matching idle snapshot; transport/outcome unknown не даёт права повторять операцию.
- Согласован узкий путь исправления своего подтверждённо записанного неверного ключа через обычный Connect. Existing ledger даёт authority только для последней rejected publication с неизменённым authDigest и подтверждённой очисткой.
- Новый явный UUID использует обычный native key POST в своей private DB и guarded writer существующего auth.json. Старые DB/receipts остаются исходными; прямых DB mutations, automatic delete-and-replace и нового repair UI нет.
- Native acceptance раздельно проверяет HTTP401/corrected key и timeout/no-replay. Пока эти проверки не прошли, R4 является review кода, а не native qualification.

### R5 — bounded native read-only snapshots при открытии V2 Host

**Основание, 2026-11-13.** На source `61bcc71785bc23aeabb3a9a288fdb6a001c6ac16`
Darwin arm64 [job131636477308](https://github.com/777genius/agent-teams-ai/actions/runs/43349349312/job/131636477308)
вернул native readiness через166734ms при captured budget120000ms; Windows x64
[job131636477278](https://github.com/777genius/agent-teams-ai/actions/runs/43349349312/job/131636477278)
не закончил `runtime.open` за180s. В обоих случаях ordinary model requests равны0.
Это подтверждённые failures; source показывает повторение дорогой проверки,
но доля времени каждой операции пока отдельно не измерена.

В `OpenCodeV2EmbeddedMemberProvider.withClient.beforeRequest` каждый native GET
повторяет `server.readNativeCustody`. В arm64 trace47GET/POST до readiness;
вместе с `server.start` это как минимум48 измерений. На Darwin
`DarwinRegisteredProcess.readRootExecutable` читает и SHA256-проверяет весь Bun
между двумя проверками original audit token/birth; на Windows
`WindowsJobCustody.readExecutable` сохраняет original process/Job HANDLE,
читает весь Bun и проверяет native identity до/после. Эти проверки остаются
источником image authority; size/mtime-only cache их не заменяет.

**Минимальная форма, один существующий владелец.**

1. Добавить только internal `withReadOnlyClient(signal, callback)` в V2 embedded
   composition. Callback получает закрытый `Object.freeze` port из существующих
   `identity/readSession/readCatalog/savedPermissionsEmpty/builtinPluginsOnly/readMcp/instructions`.
   В port нет create, credential connect/remove, PUT, prompt, permission reply,
   interrupt, config или raw fetch; тип и runtime object совпадают. Pinned методы
   проверены по D source: они выполняют только GET. Если транспорт передаёт method
   в admission, дополнительно требовать GET; нового generic routing layer нет.
   Lease active закрывается при settlement callback и в finally. Сохранённый
   method после callback не отправляет запрос; начатые, но не await-consumed
   operations не дают positive result. Публикуется только конечный прочитанный
   DTO, без lazy promise/stream/function, переносящих native чтение за snapshot.
2. Захватить исходные server object, `OpenCodeV2EmbeddedReady`, nativeSessionId,
   profile/credential authority и endpoint. Полный custody read до первого GET
   сверяет version, executable path/SHA, PID/startIdentity с этим original pin.
   В конце выполнить такой же полный read и exact equality. После await final
   custody и `client.dispose()` повторно проверить current, signal, original live
   capture и absolute deadline непосредственно перед возвратом. Ни callback result,
   ни `nativeImages`, readiness или capability не публиковать до final proof.
3. Узкий `server.isOriginalLive(originalReady)` сравнивает именно тот object,
   полученный после nonce-checked startup, с текущим ready и retained child;
   проверяет same endpoint, lifecycle, stopping и исходный ChildProcess alive.
   Он не читает/переоткрывает PID, не утверждает неизменность image bytes и не
   становится signal/Stop authority. Full native custody до/после остаётся обязательным.
4. Перед каждым GET и чтением исходного password проверять signal, original
   live capture и existing `current()` (profile, lease, credential, MCP source).
   Host revocation не может разрешить следующий запрос. Endpoint/password
   принадлежат прежнему child; нового lookup, owner, child или credential cache нет.
5. Один snapshot получает исходный absolute owner deadline и использует
   `min(ownerDeadline, now + 30000)`, не более16 native requests,
   существующие response/body budgets и обязательный `client.dispose()`.
   Owner deadline фиксируется до первой async операции исходного probe/start;
   retry или следующий GET не создаёт новый budget. Callback выполняет один
   конечный read pass. Activation retry остаётся снаружи с тем же deadline.
   Accepted-ветка `owned.probe` тоже проверяет deadline непосредственно перед
   true: прежний deadline check только в false-ветке недостаточен.
   Повторная попытка не превращает failed custody в ready.

**Точные места применения.**

- `owned.probe`: identity/session/permissions/plugins/MCP и при необходимости
  image catalog составляют один read pass (не более8GET). Полный before/after
  заменяет повторный full image read между этими GET. При false/unavailable
  snapshot не оставляет положительной capability; configuration binding идёт после proof.
- `readNativeEffectivePermissions`: один snapshot трёх GET; результат содержит
  тот же original PID/startIdentity, session/model/rules и isolation checks.
  Внешний `OpenCodeV2MemberProvider.probe` сохраняет отдельные initial/final
  custody и policy checks вокруг initial context PUT.
- P05 catalog attestation: каждый existing `readCatalog` pass из трёх GET
  использует этот port; polling loop и before-session-create model/variant gate
  сохраняются. Credential prepare и session create остаются отдельными operations.
- Single-read instruction checks можно оставить существующему пути.
  Connect/import, createSession и context PUT всегда используют прежний
  full-custody-before-request transport; read-only port к ним недоступен.

**Почему это сохраняет admission.** Уже действующий
`OpenCodeV2MemberProvider.resolveConfiguration` использует для D active-turn
GETs `requests.beforeRequest` с current/ready/original request lease между
полными probe attestations. Здесь тот же принцип применяется только к конечному
internal чтению: callback ещё не выдаёт readiness или result, original lifetime
проверяется перед каждым request, full image/native identity повторно сверяются
до приёма результата. Byte replacement, owner/credential revocation, original
child exit и uncertain cleanup по-прежнему не дают positive receipt.
Временное отсутствие authority не создаёт новый capture.

**Проверки и порядок публикации.**

- До source: независимый review этого API/границ, commit+push плана.
- Два критических regression в существующем V2 Host seam: current loss между
  GET запрещает следующий HTTP; final native/image mismatch запрещает result
  и readiness, сохраняя original cleanup. Port не предоставляет write methods.
  Не добавлять тест на каждый getter или отдельную framework suite.
- Source review: записать точный count full custody reads для одного pass;
  сверить abort/dispose и отсутствие принятого промежуточного результата.
  При недостаточном timing evidence использовать bounded diagnostics_channel
  durations существующих manifest/image checks, без native IDs, raw paths,
  headers, bytes, новых запросов или изменения admission.
- Host build/test types и затронутые critical tests; затем existing exact-head
  V2 native matrix/credential/model/MCP/Desktop lanes. Linux finite-SSE delay
  имеет отдельный passive response-end/contentEncoding trace; исправление
  startup не считается его доказанным исправлением.
- Native/Desktop acceptance остаётся pending до реальных receipts.
  Новых budgets, ручных CI rerun, main merge и feature activation нет.

R5 independent plan review: `/root/profiles_models_continue`, 2026-11-13.
Уточнены final checks после custody/dispose и наследование absolute owner deadline
без нового budget на retry; nativeImages остаётся локальным до final proof.
Root review добавил закрытие port lease после callback/finally, отказ при escaped
или не дождавшихся body operations и проверку pinned GET-only methods.
Это review плана, не compiler/native/Desktop PASS.

R5 source review: `/root/profiles_models_continue`, 2026-11-13. Проверены закрытый
runtime port, inherited deadline, original ready identity, full before/after,
escaped/lazy refusal и unchanged mutation path. Probe5GET (8с image catalog)
использует2 full reads; policy3GET и catalog3GET также по2. Добавлены ровно2
critical tests и3 identity assertions в existing native server fixture.
Старый Main fixture приведён к обязательным private HOME/current catalog/ready
contracts с сохранением его3 cleanup/attachment scenarios. Новый helper и critical
test включены в explicit Desktop source freeze inventory. Compiler, native matrix
и Desktop acceptance этого source cut ещё pending; source review не заменяет их.

### R6 — отдельное HTTP-соединение для конечной V2 operation

#### Наблюдение после R5 и проверка штатного поведения

На frontend `1628b70e50533a80d2f9d5bc8ea6edcb08a19dda`, preflight run
`43356141497`, Windows x64 job `131658678680`, R5 прошёл original identity
read и сохранил credential preparation. После response #11 integration-read
на 52067ms следующий provider-catalog GET #12 начался на 61398ms и получил
ECONNRESET на 61441ms. Original child stdin закрыт позже, на 61447ms.
Open завершился за 60614ms, modelRequests=0, custody-unresolved, cleanup=false.
Это ошибка до inference, а не превышение 120000ms bootstrap budget.
Прежние Darwin/Windows receipts также показывают reset после idle около 6000ms.
Сами эти timings не доказывают получение FIN: причина reuse проверяется
стандартным HTTP поведением и последующим actual native gate.

Проверенные первичные источники:

- [Node 24.21.0 request.js](https://github.com/nodejs/node/blob/v24.21.0/deps/undici/src/lib/core/request.js),
  blob `8c9675d60b35e76bbd37ecd88046f911d4385284`: fixed `Connection: close`
  разрешён и выставляет `request.reset=true`.
- [Node 24.21.0 client-h1.js](https://github.com/nodejs/node/blob/v24.21.0/deps/undici/src/lib/dispatcher/client-h1.js),
  blob `ed119b7156bcdbad3e1eda88295a7fd1f23bf292`: reset отправляет close,
  исключает дальнейший reuse и закрывает socket после полного response body.
  Встроенный idle validation уже использует setImmediate; ещё один yield
  сам по себе не является доказанным исправлением.
- [Bun 1.4.3 HTTP server](https://github.com/oven-sh/bun/blob/bun-v1.4.3/src/js/node/_http_server.ts)
  (`fae709e723b65c86b76ba84cd954e51b5d341b17`) и
  [Bun 1.4.4](https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/js/node/_http_server.ts)
  (`958ba989a17d6954996f46ff3797d059b4312375`) учитывают request close;
  default idle timeout — 5000ms + buffer1000ms.

#### Минимальный срез

1. **D — единственное место изменения HTTP policy.** В existing trusted header
   projection добавить фиксированный `connection: close`. Все три builders
   ограничены canonical `http://127.0.0.1:<port>`; внешний inference transport,
   V1, MCP actors, server settings и global fetch/dispatcher не меняются.
   Не вводить Host wrapper, second Agent, dependency, option или helper framework.
   `fetch keepalive:false` не использовать как настройку socket pooling.

   | D source в adapters/opencode-protocol | Покрываемые конечные operations |
   | --- | --- |
   | `v2-execution-transport.ts` | Owned identity/catalog/directory/session create/read, prompt, message pages, finite SSE log; тот же builder для PNG |
   | `v2-control-transport.ts` | Permissions, interrupt/inbox cancel, instructions read/PUT |
   | `v2-credential-wire.ts` | Integration read, единственный connect POST и owned rollback |

   `OpenCodeV2EmbeddedMemberProvider` / R5 snapshot,
   `OpenCodeV2ManagementHost`, `OpenCodeV2ModelProbe` и
   `createOpenCodeV2DriverFactory` используют эти existing builders.
   Active-session poll/readlog не должен остаться на отдельном keep-alive path.
   Исходная D база — `f5b2f3ba84afb0e90236728c951ba9e4a375e29f`;
   исправление Claude catalog из этого SHA входит в тот же будущий archive/pin.
2. **Сохранить все смысловые границы.** Fixed header не берётся из caller input;
   arbitrary headers по-прежнему удаляются. NativeRequest и fetch init содержат
   одинаковую trusted projection. Endpoint/password, method/body, session binding,
   beforeRequest admission, full native custody, request/owner deadlines,
   body/chunk limits, complete SSE codec и dispose/abort остаются прежними.
   Закрывать соединение только после полного ответа/штатного abort; не обрывать body.
   Каждый mutation по-прежнему dispatch один раз. Lost ACK остаётся unknown:
   никаких automatic retry, reconnect-and-replay или повышения budgets.
   Accept-Encoding и polling interval не меняются.
3. **Проверить существующие границы без новой suite.** Дополнить имеющиеся
   header-projection tests execution/control проверкой fixed close и отказом
   наследовать caller `Connection: keep-alive`; credential fixture проверяет
   тот же header для read/connect/rollback. В existing actual Node HTTP fixture
   проверить request close и разные original sockets для последовательных calls.
   Сохранить прежние lost-response/no-replay assertions и exact effect counts.
   Обновить короткие comments/README, описывающие trusted native headers.
4. **Обычная квалификация и immutable pin.** D full checks на exact Node24.21.0
   и Node26.11.1, существующие checked-pack и native jobs; source review не
   заменяет их. Использовать официальный checked archive с реальными bytes,
   SHA256/SHA512 и source receipt, затем обновить frontend package/lock pin.
   Intentional retained-old corpus не переписывать и архив не пересобирать
   вместо уже квалифицированного. При unavailable executor local PASS не заявлять.
5. **Actual acceptance на новом source.** Дождаться existing V2 native matrix
   Windows/Darwin/Linux и regression pinned V2.0.21; проверить readiness,
   credential/model/tool/approval, Stop и cold Resume с original cleanup.
   После нового frontend pin проверить связанные Main/Desktop lanes, включая
   actual Claude catalog/commands. Linux finite-SSE delay остаётся отдельным
   вопросом до response-end/contentEncoding evidence и успешного turn;
   устранение startup reset не считается автоматически его исправлением.
   Не создавать manual rerun, не merge main, не активировать feature/release.

R6 до implementation проходит независимый peer review и root publication.
План сохраняется на отдельной docs branch, чтобы текущий R5 native run завершился
штатно; публикация плана не является compiler, native или Desktop PASS.

### R7 — исправление своего отклонённого ключа после смены runtime source

PR1186 `PRRT_kwDORVTEtM6246fc` повторно сверён с frontend
`522c80d168d698fc6842ee649cc4822406cd2632`. Комментарий review не считается
самостоятельным доказательством; ниже — найденные source boundaries и план до кода.

#### Круг 1 — прежнее поведение и точная причина

- В [старом submitConnect](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/features/runtime-provider-management/renderer/hooks/useRuntimeProviderManagement.ts)
  новый явный Connect использует выбранный provider/project/runtime revision; отдельный Forget не вызывается автоматически.
  [CLI client](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/features/runtime-provider-management/main/infrastructure/AgentTeamsRuntimeProviderManagementCliClient.ts)
  передаёт эту операцию existing native connect. Произвольная замена чужого ключа не становится supported workflow.
- В текущем [ProviderManagementCoordinator](https://github.com/777genius/agent-teams-ai/blob/522c80d168d698fc6842ee649cc4822406cd2632/packages/legacy-agent-host/src/composition/ProviderManagementCoordinator.ts)
  `replaceableV2Auth` использует `v2CredentialState`, который предварительно отбирает exact profileId/configRevision.
  [RuntimeSourceIndex.managementProfile](https://github.com/777genius/agent-teams-ai/blob/522c80d168d698fc6842ee649cc4822406cd2632/packages/legacy-agent-host/src/composition/RuntimeSourceIndex.ts)
  создаёт новый immutable `runtime-source:<revision>`, сохраняя accountBinding и credential environment.
  Поэтому исходная qualified rejection исчезает из replacement lookup при неизменённом ключе.
- [OpenCodeV2CredentialScope.selected/prepare](https://github.com/777genius/agent-teams-ai/blob/522c80d168d698fc6842ee649cc4822406cd2632/packages/legacy-agent-host/src/adapters/providers/OpenCodeV2CredentialScope.ts)
  уже вычисляет private authDigest из accountBinding, providerId, HOME/data root paths и dev/ino,
  auth subdirectory identities и выбранного значения. Это готовое доказательство того же account/key;
  одного resourceId или совпадения текста ключа недостаточно.
- Existing composition восстанавливает original retained profiles из runtime-source index до чтения command journals.
  `CredentialCommandOwner` уже сохраняет monotonic finishedAtMs, original target, progress и cleanup;
  lookup/resume исходного command остаются привязаны к его прежнему target.

#### Круг 2 — минимальное изменение и отказные границы

1. Оставить qualification `connectedV2/v2CredentialState` на exact profile/model. Для replacement сделать
   отдельный небольшой проход по существующему owner journal в том же Coordinator, без нового store/helper framework.
2. Отбирать тот же existing resourceId и providerId, исключая только текущий уже admitted commandId.
   Любой unfinished/unknown outcome в этом namespace запрещает новый intent **даже с тем же key**:
   простой возврат undefined недостаточен, потому что Scope.prepare допускает повтор неизменённого ключа.
   Existing ManagementResourceFence и cleanup-held checks продолжают действовать.
3. Использовать последний однозначный опубликованный auth witness по existing finishedAtMs;
   более поздний успешный credential mutation отзывает прежнее rejected-publication разрешение.
   Clean confirmed no-publication rejection не является новой публикацией. Отсутствующее/неоднозначное
   terminal evidence не превращать в разрешение и не пропускать unknown rows по profileId.
4. Candidate должен остаться исходным `credential.set`: terminalRejection, probe-completed,
   verification.ok=false, resourceHeld=false и known terminal time. Найти его original retained V2 profile
   и проверить original row через `assertManagementTarget` против **этого** профиля.
   Затем сравнить сохранённый authDigest с новым `OpenCodeV2CredentialScope(profile, provider).capture().digest`.
   Foreign accountBinding/HOME/data identity/provider, изменённый key или отсутствующий original profile отказываются.
5. Вернуть только этот existing private digest в прежний Scope.prepare. Его повторный read/current guard
   и compare-before-publication защищают изменение key между lookup и записью.
   Сама новая операция использует новый current profile, original command journal и обычный native connect/probe/cleanup.
   Старый receipt не переписывать, успешную проверку A не переносить на B, старый POST/probe не replay-ить.

#### Existing проверки и завершение

- В `opencode-v2-management-recovery.test.ts` расширить существующий controlled recovery scope:
  original private auth publication + validated original rejection → новый source profile того же account →
  новый explicit corrected Connect проходит admission. Проверить cold retained-profile recovery,
  неизменность original receipt и exact native-admission count. Это boundary proof, не native vendor success.
- Тем же bounded case проверить отказ при current authDigest/account/namespace mismatch, новой успешной publication
  и unknown old-profile intent с confirmed cleanup, включая попытку нового ID с прежним key. Ни нового native effect,
  ни изменения ключа/receipt при отказе. Existing credential-scope tests сохраняют V1/foreign-source и publication guards.
- После freeze Profiles взять exact native fixture `43bc150c91262074fdd1a7453464e38425227fc5`.
  В existing `opencode-v2-credentials.native.ts` между HTTP401 и cold corrected Connect опубликовать обычную
  новую runtime source revision через existing RPC/index на тех же квалифицированных TEST runtime bytes.
  Private bootstrap TeamHostProfile/profileHash не переписывать; original rejected receipt читать по старому target,
  corrected Connect и дальнейшие existing steps используют новый target.
- Сохранить unavailable-model/high → enabled fallback без чужого variant из P05, ровно прежние четыре
  inference requests, current timeout/effect counts, unknown-intent no-replay и original cleanup assertions.
  Новый source profile до corrected Connect показывает configured/unverified; он не получает connected по чужой revision.
  Existing required-step список в `opencode-v2-stage1-preflight.yml` требует новый marker
  `runtime_source_revision_preserves_original_rejected_key_replacement_authority`, чтобы CI проверял этот переход.
- Проверить Host build/test types, существующие coordinator/credential-scope suites, fast lint/source cap;
  actual native/Host/Desktop outcome подтвердить на следующем штатном exact-source CI cut.
  Не создавать новую suite/runner, не расширять native budgets и не объявлять native PASS по source review.
- Следующий круг — independent plan review и root immediate commit/push, затем implementation и независимый diff review.

### R7: проверенный source cut

Исходный `ProviderManagementCoordinator` теперь ищет разрешение заменить отвергнутый ключ по прежнему
account/provider/auth namespace, сохраняя точную исходную запись и digest. Неизвестный intent блокирует
новый Connect даже с тем же ключом; смена account/HOME/key и более поздняя успешная публикация
не наследуют разрешение. Connected/verification по-прежнему относятся к точной revision профиля.
Native journey включает обычную публикацию runtime source между 401 и холодным исправлением ключа;
новый marker обязателен в прежнем workflow, прежние четыре inference request сохранены.

Независимое source review Profiles и root — PASS. Сборка Host, test types, 17 credential tests,
fast lint и source cap — PASS; совместная root-проверка credentials + async source selection: 37/37 PASS.
Это source/controlled proof; новый actual native Host/Desktop результат должен дать штатный CI.

## 2026-11-13: native directory with an implicit same-ID integration

The allowed native 2.1.4 credential scenario on source `96bb78f` failed before
any credential/model effect: the configured `TEST-local` provider was present,
but Host returned `authMethods: []`. A separate read-only query through its
original owned OpenCode metadata process confirmed that `/api/provider` omits
`integrationID` for this configured provider while `/api/integration` declares
the exact same `TEST-local` ID with a plain `key` method. The diagnostic closed
the original owner and confirmed the original PID absent.

Bounded correction, for independent review before implementation: preserve an
explicit native integration ID; only when that field is absent, resolve the
provider's exact ID against the same owned directory's integrations. Apply the
same selection to passive directory projection, explicit key operations and
captured session credentials. An explicit missing/different link must not fall
back to another integration. No heuristic name matching, fabricated auth method,
new credential store, or automatic key retry is introduced. The existing native
plain-key check, original intent, account binding, byte limits and cleanup remain
authoritative. Expected production delta: three selection expressions, under 20
lines across two existing adapters.

Acceptance uses the original failing native credential scenario: rejected key,
explicit correction, source revision, lost ACK, cold lookup, later saved-key
probe, retained unknown intent and preserved foreign auth. Its result is separate
from emulator and Desktop evidence. The native model-probe scenario also needs
its strict expected catalog to include the exact safe variant IDs added by P05;
the observed low/medium/high and high sets must be compared exactly.

The same-ID correction passed the 13 focused credential/configuration/recovery
checks and the native journey now reaches the original HTTP 401 rejection.
At the next source-publication observation, the test must retain exactly two
metadata owners: original profile A and new profile B. The existing coordinator
explicitly keeps its V2 hosts by immutable profile ID; publishing B does not
replace A. Record A's original PID before publication, require it still present
among the two afterwards, and retain both original-image and final PID-absence
checks. Independent provider review confirmed this census correction; it is not
a production cleanup change or permission to accept an arbitrary process count.

Native model-probe evidence on `26043bb687700046d4cad189707ce0d09c9d8b83`
completed the two selected-model requests and original cancellation without a
replay, then failed while observing the refused variant. This remains
INCOMPLETE. Preserve the original Host exit code, signal and diagnostic byte
count in its receipt even when cleanup throws, so a subsequent exact-source
run can diagnose that failure. No timeout, production behavior or success
assertion is relaxed.
