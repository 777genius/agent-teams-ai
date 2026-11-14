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

### R8 — V2 readiness must join the original native credential instead of requiring a copied key

#### Exact current regression and scope

This is a bounded correction to the already published P05 §16B.3 preparation path, on F `c423b7336bde14c79c149509cc2c5b0d4778c215`. It precedes the separate required managed-file credential handoff. Source remains unchanged until this appendix has independent/root review and is published. It does not activate the remaining B2 allocation/Stop/cold work or qualify `{file:...}` references.

The original `OpenCodeV2CapturedConfiguration.ts` blob `6e63f8e6367a46676e7c841d67751e91c335226c` takes the selected literal/env key out of native provider settings and requires it to match the original `OpenCodeV2CredentialScope` snapshot. `OpenCodeV2ModelProbe.ts` `48bfa19034b3cda99a4151855c1cc1f4f37d14a2` builds its private `observedProvider` from those settings at127–130. Its existing start sequence then awaits the original native identity, `credential.prepare`, and exact model attestation before calling `observeProvider` at253, and before session creation/model input. The credential owner `OpenCodeV2SessionCredential.ts` `8b71749a79186e70a12a3181921c5a7475f13ff3` has already produced the private witness `{scopeDigest, credentialId}` from the captured account source and original native key client; this is not a model result or a Renderer assertion.

Current `OpenCodeLocalModelReadiness.ts` `63246d03002749a444cf783dd97b8113a8c80065` captures an auth snapshot only for its local-candidate branch at135–136, and at165–167 requires a nonempty `nextOptions.apiKey` whenever the original Main policy has `hasConfiguredApiKey=true`. A valid V2 provider whose key came from the captured config, with no duplicate key in baseline settings, therefore reaches the observer after successful credential preparation with no `apiKey` property and is refused. This is a source-proven regression in the new private readiness consumer. No earlier native receipt is claimed to have exercised that exact keyed B3 route.

The Main configured-key flag is a policy classification, not proof of the account or key. Do not repair this by copying key bytes into the observation, inserting a fake string, removing the flag check, accepting arbitrary provider metadata, or declaring an unavailable/unknown credential authless. Preserve the distinct already supported V2 baseline route: when the original same-provider `embedded.providerConfiguration.settings.apiKey` supplies native settings and there is no selected auth entry, `credential.prepare` returns undefined but the old private provider observation still contains that actual original settings key. The present helper accepts it and excludes coordination. This valid route must not acquire a new auth.json requirement merely because the stripped-key route needs a digest join.

#### Minimal same-owner correction

Keep the existing one-argument private observation callback. At the same original V2 callback site, after the same successful `credential.prepare` and model attestation, add one private `credentialScopeDigest` data property only when that same `nativeCredential` is present. Its value is exactly `nativeCredential.scopeDigest`; copy no `credentialId`, key, path, auth document, or raw native reply. If the owner returned `undefined`, omit the property. Build the observation from the existing provider fields plus this one field; do not modify native configuration or the owner result. Do not publish the new field through a DTO, RPC, source receipt, profile, checkpoint, model catalog or native Session event. Its absence alone is not an authentication conclusion.

In the existing readiness helper, capture the original V2 `OpenCodeV2CredentialScope` before constructing the ordinary adapter even when the route has a configured key. Reuse its existing bounded namespace/source reader and original owner/source callback. Also retain the original V2 baseline settings key, if any, only for the exact original `nativeModel.providerId === input.providerId`, from the captured same-provider embedded recipe before any await; it is not selected from later observed metadata. The existing model-selection helper drops that baseline when switching providers. Keep the existing V1 local-candidate capture rule unchanged. The original private-URL/approval and configured-route validation still precede this capture. Reuse this one captured V2 view for currentness, applicability and the existing hashed `accountDigest`; the existing full private effective-provider/configuration digest continues to bind any baseline settings key. Do not create a credential ledger, change auth.json, call a credential API or allocate a native owner here.

At the original observer, after the existing object/options/URL/source checks, validate the new field against that same captured view. A present captured auth key requires an own, finite lowercase64-hex `credentialScopeDigest` exactly equal to the view's digest. An absent captured auth key requires the field to be absent; null, empty, malformed, unexpected or mismatched data refuses. Recheck the original currentness before accepting the observation. For V2, Main's configured-key condition is satisfied by that real present-key/digest join, or by the distinct preserved baseline path: original captured auth absence, no credential field, and a nonempty valid observed `options.apiKey` exactly equal to the retained original same-provider baseline key. That baseline alternative is selected from the original recipe, never from an arbitrary observed string or another provider. A matching baseline with absent auth remains keyed, not authless, and disables the coordination branch as before. Preserve the existing current owner/profile/source checks for it. For V1 retain the original native effective `options.apiKey` check. Existing options-shape checks are not removed. Neither Main's flag nor a caller-supplied digest can substitute for the captured scope.

The V2 field is emitted only at the existing callback after the real original native key preparation. The helper's check joins that operation to its original account snapshot; it does not infer native connection success from file presence. Native `undefined` is acceptable only with the original captured auth absence; it does not prove the absence of a baseline settings key. The original ordinary execution, cleanup, capability and policy requirements remain required on both routes. A present captured native key or a genuinely retained baseline settings key remains outside the authless coordination branch. The authless V2 observation stays byte-equivalent to its old provider row because no new field is emitted; its existing exact `expectedProvider` comparison for the separate coordination phase is unchanged. V1 observations and the V1 policy-origin file-token treatment remain unchanged.

Keep the original ordinary adapter construction, run/close order, single native-key preparation Promise, exact source/model/current checks, original absolute deadline, cancellation and cleanup rules. No new HTTP/native/model request, retry, timeout or public input is added. Unknown ownership or failed original cleanup remains held. A private scope digest remains a private equality witness and cannot authorize a new attempt or repair a cold/claimed record. Retained profiles, source records, opaque checkpoint bytes and old receipt schemas do not change.

#### Exact source manifest and existing critical case

All three preimages were read at the parent above and independently matched the current native `5543a5b8843fb5471e8e4555c9b0595b9143afbe` and qualification `174ee44acfcf6d09a7f3228ce4e2e3cf5456c0d3` heads. Root still rechecks preimages at publication. There are exactly two production files and one existing test file; no additional helper, contract, owner, schema, fixture, inventory, dependency or workflow file is authorized by R8.

| Path | Exact preimage | Authorized change |
| --- | --- | --- |
| `packages/legacy-agent-host/src/adapters/providers/OpenCodeV2ModelProbe.ts` | `48bfa19034b3cda99a4151855c1cc1f4f37d14a2` | Add only the original native credential's private scope digest at the existing post-prepare observation. Preserve all native ordering and configuration. |
| `packages/legacy-agent-host/src/adapters/providers/OpenCodeLocalModelReadiness.ts` | `63246d03002749a444cf783dd97b8113a8c80065` | Capture/join the original V2 auth view for keyed and authless routes and use it for the V2 configured-key check. Keep V1 and all URL/approval/source/deadline/cleanup conditions. |
| `packages/legacy-agent-host/tests/opencode-configuration-source.test.ts` | `452a3c3079e7e23fa87ee5fadfb3bf8cce3cf65e` | Extend the existing `original Main source, exact approval and whole-command commitment survive bounded grouped probes` case with the finite V2 keyed regression and refusal branches. Preserve every existing case and assertion. |

Within that existing critical case, create fresh original TEST configuration/auth/approval references, derive the V2 scope digest through the real `OpenCodeV2CredentialScope`, and use the existing explicit synthetic ordinary-adapter boundary to deliver the private observation. Do not label that observation as an executed native client. The positive has the original Main configured-key policy, a real matching captured literal key/auth namespace, valid original URL/source, no copied `options.apiKey`, and the exact private digest; it reaches one ordinary success/close with `not-applicable` coordination, no metadata request and no challenge. Check the existing result's account witness changes with the actual scope rather than accepting the policy flag alone.

Independently reach missing/null/malformed/foreign digest and present/absent mismatch refusals, changed original auth or revoked owner during the ordinary boundary, and a wrong/unapproved URL with an otherwise correct digest. These branches must refuse before a synthetic model-input counter can advance and still close the original adapter through its existing owner path. A fresh genuine authless case requires no credential field; an arbitrary field cannot convert it to keyed success. Separately preserve a fresh V2 baseline-settings key with genuine selected auth absence and the exact same original provider/key observation, including its keyed/no-coordination result. An unmatched observed key, a key from another baseline provider, or an observed string with no original baseline cannot satisfy Main's keyed condition. Keep V1's real-key observation requirement and all prior private-destination, original approval, whole-command retention and cold no-replay assertions. These are sub-branches in the same case, not new suites or extra native invocations.

#### Verification and the remaining file-token task

Root publishes only after root/independent source review. Run the existing Host build, Host test types and this existing configuration-source test under the canonical pinned setup; run the existing model-probe/management cases only where needed to resolve a concrete consumer/type risk. All source files stay within their current size gates. Ordinary existing CI/native/Desktop qualification remains required before acceptance; a synthetic observation or source proof is not a native pass. Preserve the current Linux authless compound-proof inputs and all existing native business/request counts.

The separate next amendment must connect an original managed `{file:...}` config leaf to a bounded, owned, current file-key view and the same native credential owner/cold witness. It must also state the actual old4a explicit literal/env/file key precedence relative to auth.json: the original Main local-provider writer creates the managed file and config token without publishing a selected auth.json entry. R8 changes neither the existing literal/env conflict rule nor the file-token rejection, and must not be described as full credential parity. That remaining handoff, its exact native original-key cases and its precedence decision are mandatory follow-through; no arbitrary secret reader or B2 allocation authority is granted here.


### R9 — explicit V2 config-key precedence and the original UI-managed file handoff

#### Scope, sequence and the remaining manual-token obligation

This connected subset follows published R8 (`c7aa04f33fbdc6b0c53bf1c72aebd314e3336f1c`). It restores the selected original literal/env key and the original Main-managed absolute/legacy-`~` file route through the existing V2 credential owner. It does not claim complete file-token parity. A manually configured absolute, home-relative or config-relative token is part of the old UI/config route and remains a mandatory follow-through, including the original native resolution rules. Root has selected a separate minimal private same-native-owner bridge for that follow-through: exact selected original `apiKey` leaf, native configuration source/account/provider, opaque source/credential witness and currentness, without a generic path RPC, public secret, new process, owner or journal. Its absence today is an implementation gap, not a request for user authorization. Its exact source/D scope must receive a connected bounded plan and peer review before edits; R9 can proceed independently once this plan is published.

R9 source is initially zero. Its implementation boundary is the thirteen existing paths below; no Main/UI, profile/reference schema, D contract/archive, source journal, new helper, workflow or native invocation is authorized by this subset. Existing working branches are reviewed independently before publication. R8 and the now-published P05 §16B.3d source-origin correction remain intact; preserve all of their existing branches in the shared configuration test. Remaining B2 allocation/Stop/cold activation is separate and is not enabled by this handoff.

#### Source-backed legacy behavior and current refusal

The old frontend baseline is `777genius/agent-teams-ai@4a0e06277fe216d9f82dbbede362668fe46622ee`. `OpenCodeLocalProviderSupport.ts` `b59158e77f0002298f6adeca91aaf793ea1084ed` creates a key in canonical `HOME/.config/opencode/agent-teams-credentials`, uses mode0600, and binds its filename to the provider and the first16 hex characters of SHA256 of `path.resolve(configPath)`. It accepts both the legacy unrotated `<provider>-<scope>.key` and the rotated UUID filename. `createProviderApiKeyReference` initially produces `{file:~/.config/opencode/agent-teams-credentials/<filename>}`; `commitProviderConfigWithCredential` commits an absolute `{file:<staged credentialPath>}` into the exact config leaf. `OpenCodeLocalProviderConfigWriter.ts` `65e01d744bd44b5a16d543456c4fecd65edee109` writes that config/key pair without creating or rewriting the selected `auth.json` entry. This is an ordinary supported Main route, not a requirement to pre-seed auth for the test.

The same original connector `OpenCodeLocalProviderConnector.ts` `8e0804fcbd906067099546e6d3ec4de167ce1aed` treats any nonempty configured `options.apiKey` string as a keyed route, while `buildDeferredProviderListEntry` defers its connectivity/authentication check to native OpenCode. It does not require the managed filename. Thus manual file references are also old UI/config scope; the managed subset cannot be labelled full parity. The Main policy selector and Host native source selector are separate: Main recognizes four project locations, while the current Host source reader recognizes its two original root project files. A Main `.opencode` selection or matching URL is not proof of the native config leaf and must not become a secret-file grant in R9.

Exact old native V1 `anomalyco/opencode@148842ef7cb1bc34192b3fff57d0f9721ab9c801`, `packages/opencode/src/provider/provider.ts` `42fde1ee0e86b96f956920d3cfa8e6e0e5f96a06`, reapplies configured options and assigns the stored/provider key only when `options.apiKey === undefined` (1788–1835). Its variable loader `52c449538fa19b7986c12906429ab31bdd783daf` resolves env/file references before that selection. For the selected ordinary compatible config route, the explicit literal/env/file key therefore wins over a stored plain API key. The current F `OpenCodeV2CapturedConfiguration.ts` `6e63f8e6367a46676e7c841d67751e91c335226c` instead requires explicit literal/env equality with present auth, and selector `a35d07bf38869f029682c846b215281b2308769d` refuses file references before allocation. Those refusals are an identified compatibility gap; R9 must not describe them as old parity.

Exact V2 `anomalyco/opencode@68bc26b7da1990ce10ffecfbc1e09eb13aa5d824` has the opposite credential merge at `packages/core/src/model-resolver.ts` `1e13ea150caad79e78bee199bc509b1e70a0d3d4`: native credential settings override configured settings at202–226. Consequently copying an explicit key back into native settings while importing the different auth key would still select the wrong key. R9 chooses the effective explicit key in the existing Host credential capture and passes that same key through the existing finite native key import. It does not rewrite auth.json, import both keys, introduce an authentication fallback or infer connection success from a config/file read.

The ordinary native materializer was checked before selecting this subset. F `OpenCodeV2EmbeddedChild.ts` `772a5c38e10241f2923755561a42f80f52f5db09` passes the original private configuration as `config.content`; package binding `5f29eb242ae7dce6c96953214029c819bb992bc2` changes package declarations only. Native `server/process.ts` `3abd8b81524652eb69de2b5ed01b7f1bc3087cf4` → `server/routes.ts` `70dfe24ff05500866cc74cef578f6fa66acc7b17` → `core/config.ts` `943d251f43132b83022882cc8be83951c19ad8a5`232–242 still calls `ConfigVariable.substitute`. Loader `4f96c085b860754d1a2fb414a146e6d6e8320083` resolves absolute/`~` tokens, but a relative token in this virtual-content route is relative to `Location.directory`, not the original config leaf. Missing/unreadable becomes empty plus a warning; that is not a successful credential capture. Provider handler `ab9c2201a5eea69a943b47cf871aec49ada22e14`, provider schema `6306eb374d91b4c45768ed76cd3fbda33d2378d1` and config handler `9713b10a5201c4f2a9e74e1e8f7677840b21c5e3` can expose resolved native settings/entries, but neither they nor `ConfigVariable` retain file-target identity/currentness evidence. The current D finite catalog deliberately strips settings. A future private native bridge must connect those missing facts rather than treating a successful model reply, a raw provider setting or the unchanged config filename as a file witness. R9 changes none of these native/D paths.

#### A. Keep source selection pure and retain the actual selected leaf

Extend the existing private `captureOpenCodeConfigurationSource` result with a read-only selected-`apiKey` origin accessor, derived from the same original parsed documents and exact original merge order. It returns the original file reference/path and digest for the surviving `provider[providerId].options.apiKey` leaf, or a distinct inline/no-leaf result. Track replacement of any ancestor of that four-segment path; do not find the last equal value, provider name or URL after merging. A later partial model/options override inherits the original key origin; an ancestor replacement or an explicit new key replaces it. Validate that the retained origin resolves to the actual merged leaf and recheck the original source before returning it. No additional file read, schema field, stored receipt or source-reference byte changes are introduced by origin tracking. Main policy-origin evidence is not substituted for this actual native config source.

In the existing pure selector, handle only a complete raw selected `options.apiKey` `{file:...}` token as a private file-reference result. Extract that leaf before running the unchanged recursive environment resolver over the remaining selected provider/model fields. Do not allow a file token in `baseURL`, headers, model/body fields or a different provider. Do not turn an environment value containing `{file:...}` into file authority. The ordinary literal/env key path continues to use only the original captured environment; unresolved, empty, malformed or control-bearing values remain refused. The file result carries no key bytes, invokes no I/O and does not declare the reference usable. `RuntimeSourceIndex` and candidate verification still call this pure selector only; publication does not allocate or import a credential. Actual managed ownership and file validity are checked below before any native child/key action. Manual/inline/relative or otherwise unsupported file references remain a concrete held/invalid route in this subset, with the mandatory private-native bridge still open; there is no silent auth fallback.

#### B. Capture one effective selected key in the existing credential scope

Add one narrow internal capture path to `OpenCodeV2CredentialScope`, used only by `captureOpenCodeV2Configuration`. It starts with the same original account namespace, canonical HOME/XDG roots, selected provider, auth view and owner callback. The original auth-only `capture`, publication, corrected-key replacement and rollback operations keep their behavior and digest bytes. Foreign selected auth in the alternative V1 namespace, malformed or non-API selected auth, unknown ownership and changed roots still refuse even when an explicit config key is available. A different valid plain API key in the same captured primary account is the compatibility case, not a different account grant.

For a selected literal/env key, use that exact resolved key as the effective key. If it equals the original present auth key, return the original auth key view and digest so existing matching-key checkpoints continue to compare byte-for-byte. If original auth is absent or is a different valid primary plain key, create a private read-only effective-key view bound to that original auth snapshot, selected source-origin/config identity, account/provider and effective key. The original captured auth snapshot remains a currentness input, even when it is not the chosen key. Its later change invalidates this capture rather than silently switching credentials. The same source may change only according to the existing bound-config rule described below. No auth file is written by this capture and no new credential journal is added.

For a managed file, require the raw token from the exact surviving original file leaf, its exact selected provider, and its source path/digest. The only accepted destinations in R9 are a direct regular file under the original canonical `HOME/.config/opencode/agent-teams-credentials`, expressed as the old absolute path or exact legacy `~` prefix. Reproduce the old ownership relation using SHA256 of the original `path.resolve(configPath)`, not a current UI path or the target's basename alone. Accept the old unrotated filename or the exact rotated UUID form from the original writer. Require the selected leaf's config path, provider, scope hash, owned directory and captured account to agree before opening the file. An inline value, another config's filename, another provider, traversal, arbitrary absolute path, env-generated token or coincidentally matching URL is insufficient. Read-only config symlink mapping remains governed by the existing source capture; it does not license a linked credential target.

The secret read is finite and read-only inside the existing scope. Walk the original managed directory chain, reject symlinks/non-directories or changed canonical identities, then open the exact regular non-symlink file with the existing `O_RDONLY|O_NOFOLLOW` pattern. Require a single link and the original current user's private file mode on POSIX; retain Windows identity checks without claiming POSIX mode semantics. Use a cap-plus-one positional fd read of at most64KiB+1, strict UTF-8, native-equivalent outer whitespace trimming and the existing finite/nonempty/control-free key validation. Compare canonical path plus before/fd-after/path-after dev/ino, size, mode, uid, nlink, mtimeNs and ctimeNs and directory identities; recheck source/account/owner around this read. Missing, unreadable, empty, oversized, linked, changed or malformed input refuses before native allocation/import; it never becomes an authless route. The private view binds the full file witness and effective key in its digest; keys, raw file contents and file paths do not enter public DTOs, source receipts, command journals or error strings.

The effective view uses the existing private shape `{digest, present, isCurrent, readKey}` and a narrow in-memory provenance check if required for the optional internal handoff parameter. Only the captured configuration produces that view. The receiving session owner must join it to the same captured account/HOME/XDG/provider and original configuration owner; a caller-supplied string/digest or a structurally similar public input cannot select a key. This is not a new registry, serialized capability or Renderer input. The effective file view always rechecks its original file/auth/account witness. Literal/env values remain the captured immutable config values. The original configuration owner still rechecks its source before binding; after `bindRunningSession`, an ordinary config publication affects the next capture while this running child retains its original private config, as before. Binding does not remove file/auth/current-owner checks. Keep these checks acyclic: the selected key's own account/file currentness does not call back into the configuration wrapper which itself checks the key.

#### C. Reuse the original native credential, observer and cold joins

`captureOpenCodeV2Configuration` exposes the private effective key view only when an explicit captured config key is selected, removes the obsolete equality/absence refusal for that route, and keeps keys out of the translated provider settings. Its selected overlay follows the original config merge precedence; an explicit source key must not be replaced by a different baseline settings key. The distinct baseline-only recipe path retains its current behavior, including R8's original same-provider key/auth-absence branch. Passive whole-directory configuration capture must not acquire an unrelated auth key simply because the new helper exists.

Add an optional private captured-view parameter to the existing `captureOpenCodeV2SessionCredential` function and pass the exact configuration-owned view from the existing ModelProbe, member-provider and provider-scoped ManagementHost callers. When absent, the old auth-only capture remains the default. The original once-only preparation Promise, deadline/admission, current checks, real integration selection, empty-before/key POST/single-after ownership, disposal and failure semantics remain unchanged. Only the effective key selected above goes through that same original POST. There is no second connect, new rollback authority, retry or additional request within that original finite native preparation sequence; a newly admitted explicit-key route uses that existing sequence exactly once. Metadata-only global directory reads remain metadata-only and do not become credential import operations.

Keep the existing native Session metadata shape `{scopeDigest, credentialId}` and public contracts unchanged. New explicit/file routes use the new private effective-view digest; old auth-only and matching literal/env routes retain their old digest. On cold resume, recapture the exact original source/account and, for managed files, the original file witness; require equality with the original Session scope digest and the existing native credential-id/read-only integration checks. Do not rewrite opaque checkpoints, replace the original native credential, repair a foreign database, reconstruct a claim or rerun an acknowledged/unknown intent. A missing or changed file/auth/source witness stays held. These checks continue through the shared native member provider used by direct launch, restore and scheduled successors; no separate schedule key reader is added.

The readiness helper consumes the actual V2 captured config-key view rather than reading a Main policy token or inserting a fake `options.apiKey`. Its actual native source is exactly `embedded.configurationSource` when present; the helper's fallback project/policy reader cannot manufacture a native file grant when that reference is absent. Reuse the helper's existing captured source view when it is exactly the original native reference, with the same currentness and reference-digest checks; a narrow private configuration-capture parameter may carry that already validated view, but a mismatched or fallback-only source refuses instead of being adopted. Do not add a duplicate whole-source read solely to find the key origin. Reuse the existing original source/policy/currentness checks and captured view for the private account digest. At the same R8 observer, require the same real completed native `credentialScopeDigest` for the new effective view. Keep the absent-key rule and original same-provider baseline alternative distinct. Literal/env/managed-key routes stay outside authless coordination; ordinary native execution/cleanup is still required, and neither file presence nor a digest asserts authentication success. V1 observations, V1 native file resolution, private-network approval checks, model/source/URL joins and no-tool/coordination sequencing remain unchanged.

#### Exact source cut and preimages

The following preimages were independently matched on parent `c1348ebfb415bdf1198ab086919fa99deba98abc`, native `655547d4ef3b4f19c15084cecd901d2da0234eab` and qualification `efd3a6cf88adf25a0cfb3c65829ee5d65849a8cf`. Root must recheck all three current trees before source publication and preserve the published §3d test additions. Paths below are relative to `packages/legacy-agent-host/`.

| Existing path | Exact preimage | R9 change |
| --- | --- | --- |
| `src/adapters/providers/OpenCodeConfigurationSource.ts` | `b919ef2e802da8947cbd81f858cb50f744b79c1c` | Private exact selected-key leaf origin from the existing merge |
| `src/adapters/providers/OpenCodeV2CredentialScope.ts` | `7daf7fc69933ebcd7c1b13019ac11cef5a6f3f3f` | Effective explicit key and bounded original managed-file view |
| `src/adapters/providers/OpenCodeV2CapturedConfiguration.ts` | `6e63f8e6367a46676e7c841d67751e91c335226c` | Original config precedence and private selected-key handoff |
| `src/adapters/providers/OpenCodeV2SessionCredential.ts` | `8b71749a79186e70a12a3181921c5a7475f13ff3` | Consume the same original optional key view, preserve default auth path |
| `src/adapters/providers/OpenCodeV2ModelProbe.ts` | `68b27f0367970b7ed71355afbf04dbe56df7a09e` | Forward its original configuration-owned view |
| `src/adapters/providers/OpenCodeV2EmbeddedMemberProvider.ts` | `07b3c4b6c26e93c31d6e6dcc0f23ab0c7fd9da45` | Same handoff for native allocation and cold Session join |
| `src/adapters/providers/OpenCodeV2ManagementHost.ts` | `97c38270a42b428e60524820e4761f9a3653741d` | Same handoff only for original provider-scoped catalog credential |
| `src/adapters/providers/OpenCodeLocalModelReadiness.ts` | `4b285933894336849c8d19b4ae5226343218f1a6` | Join completed native R8 digest to actual selected effective view |
| `src/composition/openCodeSelectedProviderConfiguration.ts` | `a35d07bf38869f029682c846b215281b2308769d` | Pure selected-key reference extraction; no secret read/public field |
| `tests/opencode-configuration-source.test.ts` | `a2069c3fa9f77cd72493f71d1c55f97fff8d806a` | Extend the same five cases; preserve R8 and separately published §3d |
| `tests/opencode-v2-credential-scope.test.ts` | `a49d8960f53bb5ecc1485cabc0e56216052cc086` | Extend existing real-client/key-scope cases |
| `tests/opencode-v2-model-probe.native.ts` | `d07280188edc39526a1852b895084eb179740a3c` | Original global literal/no-auth and project managed-legacy-file probe routes |
| `tests/opencode-v2-embedded-host.native.ts` | `00ef7dc0dfdf069ded53f6ed35105814306ecc0a` | Original keyed branch uses managed absolute file over different primary auth, including cold |

All changed production/newly touched TEST source must stay within the existing800-line policy. This is nine production paths and four existing tests/fixtures, without a new suite. The original archive, profile/reference schemas and source inventory are unchanged; no source freeze entry is needed because these existing paths are already consumed by their ordinary gates.

#### Existing focused and native acceptance

Extend the original configuration-source cases with real original config/auth/managed files, not a fabricated key-presence boolean. Cover exact merge-origin inheritance/replacement, absolute/legacy managed references, absent auth, conflicting same-primary API auth and unchanged auth bytes, matching-key historical digest equality, source revocation before bind, bound config-A preservation, file/auth change after bind and cold recapture mismatch. Refuse wrong provider/config filename scope, inline/manual/relative references in this subset, symlink/hardlink/oversize/empty/malformed/foreign sources. Preserve the original five cases and R8 observation branches. The old first-case assertion that different primary auth necessarily makes explicit config invalid is intentionally replaced with the source-proven precedence assertion; the independent foreign-account, malformed-source and currentness refusals remain. Do not claim all old assertions were byte-identical when correcting that obsolete contract.

In the existing credential-scope cases, pass a real configuration-owned effective view to the real pinned D clients against the finite TEST HTTP peer. Assert the exact original selected key POST, empty-before/single-after credential id, one original preparation Promise and no repeated request on replay. Cold acceptance uses the same original Session binding and read-only native credential-id verification; changed file/account/provider/source refuses before any connect. Keep original auth publication/replacement/rollback and explicit integration alias/refusal coverage. Synthetic custody/native clients remain labelled synthetic and cannot qualify the engine or account.

Use the already existing native model-probe case, with its same global-A/project-B/cancelled-B input sequence and all original receipt/custody/cleanup/no-replay assertions. The global selected literal key works with no selected auth entry; preserve unrelated auth data. The project override's exact regular `opencode.jsonc` leaf carries a managed legacy-`~` file reference using the original provider/config-path filename relation and mode0600. The existing native wire bearer oracle must observe the file's TEST key. Keep the current global config symlink/source-origin test; do not claim that it was an original Main-created managed config. No additional model input, native child, probe intent, poll deadline or budget is added. Original provider-scoped metadata reads reuse the same selected file/credential route and still assert that inventory alone is not connected/authenticated proof. Original cold management receipts still return without a fresh native inference.

In the existing embedded lifecycle case, preserve the Linux source authless B1 coordination branch exactly. In its existing keyed branches, place the managed absolute token in the genuine project config before capture/profile hashing and give the same selected primary auth entry a different TEST key. The original native model requests must use the explicit file key. Preserve original project-A→project-B bound-config behavior and restore the original project bytes before the existing cold resume; keep the original managed file intact for that cold join. Retain all business input, manual/auto permission, image, checkpoint/history, interrupt/Stop, physical custody and cleanup assertions and existing request caps. This is an adaptation of the original native scenario, not a new native invocation or an assertion that the unexecuted candidate passed. Missing/changed-file cold negatives are covered by the existing focused owner cases without adding a native replay.

Root runs the normal exact-toolchain Host build, Host test types, these existing focused files, canonical script types and source/diff guards after independent source review. Native qualification remains the ordinary exact-head lanes and original packaged lifecycle routes. A source/unit PASS does not establish actual file-token native, old UI end-to-end, cold account or packaged acceptance. The manual-token bridge remains mandatory after R9; its native-owned file resolution, original leaf-relative behavior and strict source/currentness witness require their own reviewed connected cut, not a relaxed native oracle or a public secret reader.


## R10 — Manual selected-file keys through the same native credential request

### R10.1. Scope, status and the gap being repaired

R9 is published at parent 4df7d90a0fd9e9ddb2a2b8b6d9e0de4e72f3f6f8, native e59abd934a30a499e70b1d6426d67d91fd1e95da and qualification 233844263f5ecbab9389ba0961984bef5c552746. Its final evidence f2ace7a19effd353a8c0eea9ef2b0ddcb9974090 records the Host build, Host TEST types, eight existing configuration/credential cases, script types and source guard PASS. That evidence is not manual-file native qualification. This appendix is PLAN ONLY; source remains zero until root publishes the reviewed plan. The exact P02 prefix is 6438fed141244a8984deb0ef1640c72b6d0a4ea9.

The old Main local-provider UI accepted a manually entered nonempty apiKey expression as well as its own managed credential file. Its native 1.19.4 ConfigVariable supported absolute, home-relative and config-leaf-relative file expressions, including several file expressions in one selected value. R9 restores literal/environment precedence and the actual UI-managed file route; it deliberately does not read arbitrary manual files in F. The mandatory remaining route is the original selected manual apiKey leaf. It must work without rewriting auth.json, publishing the key to a Renderer DTO, changing a release, or replacing a real native credential ID with a fabricated marker.

This is a new private bridge built inside the existing original native child and existing credential request. It is not an already existing generic file grant. The original selected config/source, captured account/provider/model/cwd and exact native owner authorize only that leaf's materialization. Neither Main's separate policy-origin selection nor a filename/HOME match can substitute for the native source. The existing R9 literal, environment, managed-file, auth-only and baseline-only paths retain their original digest and conflict/currentness behavior.

### R10.2. Primary evidence and actual entry seam

Official native 2.1.4 source is fixed at anomalyco/opencode 68bc26b7da1990ce10ffecfbc1e09eb13aa5d824. Server process 3abd8b81524652eb69de2b5ed01b7f1bc3087cf4 exposes start(options, lifecycle, transform). Its transform surrounds the same original application/HTTP request. It does not create another listener, native owner or child. F EmbeddedChild772a currently invokes this exact start method after complete graph verification and package binding. Config943d251f43132b83022882cc8be83951c19ad8a5 invokes ConfigVariable4f96c085b860754d1a2fb414a146e6d6e8320083; the latter consumes FSUtil.Service (a7344ebb064d587db27bf4ee468ef870e8591f18). The selected operation can supply a scoped FSUtil reader without replacing the application's filesystem service or mutating a module global.

The transform is outside the native dispatch authentication check. Therefore the same original authorizedRequest implementation, 67dbd9947816bf7a78c50ef729002188dd5473c1, with the original server password/username, MUST run before parsing a private source operation into any file read. The original application still authenticates and validates location, integration and key import afterward. The private branch additionally accepts only the original finite method/path/query/reference and fixed Basic-auth request made by D; it cannot turn another authenticated native route into a file operation. An unauthorized/wrong-reference/wrong-location request cannot read or spend the selected source attempt.

Integration handler dfdbaa447620a9af7ceac9cd7ca962bbe8d2dda9 passes the original payload key into Integration.Service.connection.key and returns NoContent. Protocol49b0c78206def2c0383418bb3d59cf1656255d47 requires a key string. A source-reference body without a key cannot be silently interpreted as a literal key by an unmodified native endpoint. Effect-TS/effect at effect@4.0.1, packages/effect/src/http/HttpServerRequest.ts, blob b6e36d01eee354c183e98e61f5731d5af4f88859, provides fromWeb and scoped request service replacement. The bridge supplies the real materialized key only to the original request effect; method, URL/location, authorization, original request scope/interruption and remote address remain those of that same admitted request.

The old relative-origin proof is separate: 1.19.4 ref148842ef7cb1bc34192b3fff57d0f9721ab9c801, Config9e10b67fe703609a3ccf243ebe1801bf338961d3 uses the path of a real config leaf, and uses the actual native ctx.directory for OPENCODE_CONFIG_CONTENT. Variable52c449538fa19b7986c12906429ab31bdd783daf expands home and relative paths. The new native virtual-content default alone would resolve every relative file against the generated config directory; that is insufficient. R9's exact surviving leaf origin must be supplied to the scoped native materializer.

### R10.3. Selected source before allocation

The existing ConfigSource selectedKeyOrigin is reused without another whole-config read. The pure selector continues to refuse file interpolation in other fields/providers. It distinguishes the exact R9 managed spelling from a raw selected manual file expression before attempting a read. An R9 managed-owner, permission or currentness failure must not fall through a catch to the manual route. The manual route is a separate declared native-selected capability, including ordinary absolute/home/relative files and stable manual aliases; it is not made authoritative by a basename or managed-directory guess.

Introduce one private branded deferred-source value, distinct from CapturedOpenCodeV2Key. It has no readKey method, no fabricated successful key digest and no claim that a credential is already imported. Its immutable descriptor contains only the original raw selected apiKey leaf, exact source reference/commitment and winning leaf origin, original account namespace/auth snapshot commitment, provider/model, actual captured cwd/HOME and only the captured environment needed for this leaf. It is associated with the original configuration owner by identity, not just structurally equal data. Its source/auth/root currentness checks run before allocation and before the same existing handoff. A copied descriptor from an unrelated configuration object must refuse.

Only a raw selected leaf that itself contains file syntax can choose this route. Environment expansion that creates a new file expression outside an original file-expression slot remains refused; no recursive interpolation of returned key bytes is introduced. Referenced environment values come from the original captured profile, with no fallback to process.env. A virtual source uses the original selected native cwd, not the generated config directory or a Main policy cwd. File sources use the actual original surviving leaf path. Missing origin, ambiguous provider/source, foreign auth namespace, invalid auth source and account/root drift stay held; presence of a manual file does not repair those guards.

CapturedConfiguration removes this selected apiKey from translated provider settings before the generated config reaches the application. It carries the deferred descriptor separately into the original server init frame. ConfigVariable is invoked once for this selected private leaf at credential preparation, and its resulting key is not placed back in global native config for a second substitution. Existing catalog-only construction may carry the descriptor but does not materialize/import it or certify credentials.

### R10.4. Same-request private D extension

Use the existing createOpenCodeV2CredentialClient and its existing finite wire. Add explicit connectSelectedSource(reference, acceptProof) and readSelectedSource(reference, acceptProof) operations; their exact exposed type remains private to Host consumers. Ordinary read/connectKey/rollback semantics stay byte-equivalent. The source and literal connects share the same synchronous attempted guard, set before the first original integration read, so concurrent or mixed callers cannot obtain a second POST.

Fresh preparation keeps the original ordered sequence: original catalog/relation selection; key-client integration GET proving a plain key method and no connections; one original integration POST with a closed source reference instead of a key; then the original integration GET proving exactly one actual key credential. The explicit integration relation or already-reviewed same-ID fallback is still selected through the original owned catalog/directory path, with all currentness checks. No new provider relation is guessed in the transform. The reference is bound to the descriptor and original ready/init nonce; the path integration must be the exact relation captured by that same original prepare operation.

The private POST body is exactly { selectedSource: { schemaVersion: 1, reference, deadline } }, with a 64-lowercase-hex reference and a positive safe-integer original cutoff, no key and no path selector. The wire computes the source request cutoff once at request entry as the existing overall deadline clipped by its original 30-second request allowance; this does not add/reset a timer or extend an allowance. The cold GET uses only the fixed private headers x-agent-teams-selected-source = v1:<reference> and x-agent-teams-selected-source-deadline = the same canonical decimal cutoff. These fields are constructed from the original wire config, not caller-supplied path/deadline input. Reject duplicate, malformed, unknown-version or out-of-bound private fields. The unmodified server must reject the new POST body, not import a dummy value.

The child transforms only that request, invokes the original authorized handler with the captured key, and wraps only a genuine successful empty 204 with one bounded private proof response. The original error/status response remains failure. The private POST 200 JSON is exactly { schemaVersion: 1, sourceReference, witness }; the cold GET 200 JSON adds only integration, containing the original integration envelope. The witness is a bounded opaque base64url string, decoded/closed-validated by the F helper; D validates version/reference/keys/string bound and retains the original integration decoder. D strictly decodes this private response and invokes the supplied synchronous acceptProof after complete original body cleanup and before the final integration GET. This lets the original subsequent beforeRequest checks include the newly issued file witness. An acceptProof failure spends the original attempt, prevents qualification and cannot trigger another POST or rollback without the existing empty-before/single-after ownership evidence. After the final GET the returned credentialId is the actual original native ID.

Cold preparation performs the original single integration GET, with the private source reference, and no POST. The same native owner materializes the current selected leaf and wraps only the original valid integration JSON response with a proof. D retains the same strict integration decode and original credentialId/method/count checks. The current materialized scope digest must equal the original session metadata scopeDigest; the native credential ID must equal the original ID. No file witness is substituted for either. Invalid response body shape or a non-JSON/unknown stream form refuses rather than guessing.

The parent owns every network request throughout. Keep original readPassword, beforeRequest, createV2RequestAdmission.acquire/close, request/body signal, pending tracking, body limit/chunk limit, redirect checks, cancellation, disposal and unknown-cleanup handling. The admission lease is held until the actual response/body cleanup finishes, including malformed/private proof responses and cancellation. A prepare result or native child exit is not a replacement release acknowledgment. There is no reverse callback IPC, transferred fetch client, second request queue, additional HTTP read or generic read operation.

### R10.5. Native scoped materialization and exact byte use

The original single EmbeddedChild receives the descriptor in its existing private init frame; the existing 256-KiB frame limit remains. Its same verified graph resolves a finite set of additional already-delivered ConfigVariable/FSUtil/HTTP/auth modules, requiring the same native 2.1.4 packages and identical Effect 4.0.1 instance. No altered engine release, ambient import, global monkey patch, process or listener is introduced. Missing delivered exports is a real gate failure, not permission to select another package.

The new child-only helper installs a finite HTTP transform when a deferred descriptor is present. Valid authentication and exact original descriptor/reference/method/location checks precede any source read. The first valid fresh source POST is spent synchronously before materialization/await. A second POST, a cold descriptor's POST, foreign source, changed relation or late operation refuses. The existing parent prepare Promise remains single-flight. Original read-only cold materialization never upgrades into an import.

The actual delivered ConfigVariable receives only a JSON object containing the selected raw apiKey and its true path/virtual origin. Provide FSUtil.Service only within that substitution effect. All other native filesystem services remain original. The scoped reader accepts only the paths generated from those original raw file slots under the captured environment; it has no caller-supplied general filename parameter. Native absolute, home expansion, leaf-relative resolution, whitespace trimming, JSON escaping and composite concatenation determine the value. Native key bytes containing token-looking text are not interpreted a second time.

New bridge bounds are explicit: raw selected expression and final valid key at most 64 KiB; paths at most 8192 characters; at most 32 distinct resolved dependencies and 64 materializer reads across both possible native escaping passes; at most 64 KiB per file and 256 KiB read bytes for one materialization; complete private descriptor/proof at most 64 KiB inside the original enclosing frame/record/wire limits. These are finite native bridge limits, not claims that the old CLI imposed identical limits. Exceeding a limit stays held without auth fallback. Existing request/model/input limits are not raised.

Capture path/alias identity before reading, an actual original descriptor opened on the canonical regular target, its before/after dev/ino/mode/uid/nlink/size/mtime/ctime identity, exact content hash, and the original directory/symlink-resolution chain before/after. Read with a finite buffer and close the descriptor in finally. Stable manual symlinks/hardlinks remain ordinary manual-file behavior; they do not acquire the R9 managed-file ownership claim. Refuse special files, cycles, changed alias/parent/file identity, invalid UTF-8, empty result, overlong/control-containing key or any missed/currentness check. The existing auth/root/selected-source checks remain independent. Do not use mtime alone or claim these observations exclude a later writer.

Native ConfigVariable catches unreadable files into empty text plus a warning. The scoped reader must latch any such failure and invalidate the entire operation even if another fragment would make a nonempty key. No warning becomes successful authless/not-applicable. Check the original request cutoff and cancellation before/after bounded reads and materialization; do not create a replacement deadline, watcher or TTL. Synchronous filesystem calls are not claimed to have hard realtime bounds. Original parent request timeout and actual child cleanup remain necessary.

Only the captured materialized key is supplied to the same original Integration handler. Revalidate the captured dependency identities/hashes after the original handler returns and before issuing the proof. Mutation followed by uncertain response/currentness remains unknown; do not infer that the native key was never imported. Errors use closed existing failure classes, never raw paths, key fragments, native cause text or substituted config.

### R10.6. Native-issued source witness and new post-close delegation

The proof is a closed, bounded, versioned private value containing the original descriptor/source/account/provider/model/cwd commitments, original native issuer/ready reference, stable effective key scopeDigest, and exact dependency path/identity/content hashes. It contains no raw key, decoded file content, password, public credential status or arbitrary path request. The scope digest commits the actual native materialized value, original selected source and auth snapshot plus file witness; it is stable for the same cold source/key, while PID/nonce remain separate issuer provenance. R9 digests are untouched.

F accepts it only at the original SessionCredential prepare/read continuation, while the same original server/ready object, process custody, request reference, captured configuration and account remain current. A structural copy or another server/probe's proof cannot manufacture fresh issuance. The in-memory branded accepted value can expose a file-only hash revalidator and an opaque persisted encoding for its original private record; it never exposes readKey.

This is an explicit new narrow delegation from that successful native-selected leaf capture: F may reopen and hash only the exact issued dependencies, with the same bounded before/fd/after/path checks, after the native process has closed. It never decodes a secret into a string or returns content. A fabricated path record, Main policy-origin digest or arbitrary public input cannot initiate this read. Cold consumption must come from the exact original validated StoredModelProbe record/context/target and its original source/account selection, not a copied latest successful result.

Keep the file-only revalidator acyclic: it must not call the outer configuration/probe current callback or require a closed child to become live again. Each caller separately joins it to its own current original source/auth/account/owner checks. No new native child, HTTP request, model input, file watcher, registry or journal is allowed for post-close verification. Unknown native release cannot be converted into a valid reusable proof merely because the file still hashes identically.

### R10.7. Readiness, durable original receipt and actual Runtime credential

OpenCodeLocalModelReadiness gains a private optional second observation argument for the branded native file proof. The existing provider object still reports only its actual credentialScopeDigest; no fake apiKey string or public configured-key boolean is inserted. For a deferred manual source, the helper requires matching original descriptor/source/account/provider/model/cwd and the actual native digest before recording the same existing accountDigest wrapper. It may not treat absent proof as authless, warning or not-applicable. Valid keyed routes remain ordinary-only, with no coordination challenge. V1 and R8 baseline-only observation behavior stay unchanged.

ProviderManagementCoordinator and NativeModelProbe forward only this private witness. ModelProbeOwner captures it with the original result, validates its full closed schema/commitment, then persists it only on the existing exact completed, successful, cleanly released native-local-readiness record. The record's purpose/context/selection/profile/command/account commitments bind it to that same probe; failed, cancelled, held or resourceHeld records cannot qualify. Extend only an optional bounded private field of StoredModelProbe; old records retain their bytes and continue decoding. The original public snapshot/DTO explicitly omits this field. Do not add a record file or recover/replay an absent native proof.

B2's planned captureOpenCodeProbeAccount(profile, input, isCurrent, originalStoredProbe) reads the same original receipt and uses this native-issued file-only delegation alongside the existing R9 effective key/auth currentness. It produces the same wrapped accountDigest, with no native execution. Main policy origin and native source remain distinct; an unconsulted global/approval arm provides no file or account authority. Consume must not reread an unrelated current config or replace the original readiness group with a newer one.

The current MemberProviderContext has only authority/currentness callbacks; it does not carry the credential digest returned later by a native owner. R10 therefore explicitly adds a private assertReadinessCredential(scopeDigest) callback from the exact B2 consumed original reference through createRuntimeMemberProviderFactory and MemberProviderContext to V2 EmbeddedMemberProvider. The B2 helper retains the original expected effective native digest and its currentness. Immediately after that allocation's credential.prepare, before Session creation/input, the V2 provider calls this callback with its actual returned scopeDigest and rechecks currentness. Missing or mismatching required B2 evidence holds and follows the original owned cleanup. A generic isCurrent callback cannot stand in for this equality.

The original factory still consumes before endpoint allocation and rechecks the same reference after await, with all existing authority/worktree/Runtime checks. Direct TEST authorities remain explicit and do not count as B2 acceptance. Cold checkpoint Resume uses its original saved scopeDigest/credentialId and read-only preparation; it does not launch a fresh readiness probe or rewrite the checkpoint. Old profiles, native recipes, session metadata shape, original handles and checkpoint payload bytes are unchanged.

### R10.8. Exact implementation sequence and composition boundary

Stage A is the exact three D paths in the table below: finite client/wire plus meaningful extensions of existing cases. D code is source-reviewed independently, then root publishes through its ordinary exact-head checks and checked artifact flow. No F branch may call new methods against the old installed archive. Consuming the actual checked D artifact is the existing separate root-owned dependency update, with original receipt/archive/lock provenance and ordinary canonical gates.

Stage B is the complete F connected scope below, using two private helpers. The native-owned descriptor/materializer/proof and all Host consumers are one coherent behavior change; do not publish a partial manual source route without its consumer/currentness/cleanup checks. Existing B2-owned commandRecords, ModelProbeOwner, factory/context and its already-declared new preparation helper are composed by root against their final frozen B2 bytes. Their current published preimages are recorded here; the preparation helper is not yet in the source tree. Its exact B2 preimage and the shared-file composed deltas require a small reviewed manifest amendment before editing those shared lines. This is a source-composition gate, not permission to omit the Runtime credential equality.

Stage C is the original focused/canonical/native qualification described below, with no extra workflow or rerun invented for diagnosis. Root alone owns heavy checks and publication. No source ref, package pin, live PR head or native invocation is changed by this plan author.

### R10.9. Existing critical tests and genuine native qualification

D extends its existing credential-client cases, retaining their names, raw-key assertions and disposal checks. Prove source fresh GET/POST/GET and cold single GET, real final credentialId, shared at-most-once claim across source/literal calls, strict unknown/malformed/extra/ref/status proof refusal, and stock-server rejection of source bodies. Exercise original admission through delayed response/body cleanup, cancellation and uncertain release; no callback ACK may substitute for cleanup. A throwing proof consumer cannot cause a second mutation. Existing rollback ownership remains necessary.

F extends existing configuration/credential cases only: original selected leaf versus foreign source/account/cwd; manual absolute/home/relative/composite and raw environment-injected-token refusal; no F secret materialization before native issuance; exact alias/file drift and malformed/missing/empty/read-bound negatives; structural-copy proof refusal; genuine D loopback source sequence/once/cold ID checks. Preserve the complete R8 and §3d branches in configuration-test53295. The initial preparation request cap remains the original ten; only the original distinct cold phase can admit its existing additional reads on the same counter. No reset or second POST.

The existing model-probe and saved-team model-probe cases exercise original purpose/context/target/release record persistence and consumption, public omission, unknown release, after-close file drift, and a later actual-native-digest mismatch before business allocation. Synthetic adapters/HTTP peers are labelled as such; they do not establish actual native materializer semantics. All original cleanup/finally and primary error order remain unconditional on a new witness assertion.

In the existing native model-probe case, replace one original keyed global selection with a manual selected leaf whose three absolute/home/relative fragments concatenate to the same existing TEST key; keep the project R9 managed source and all original input/cancel/catalog/permission/model-body/secret assertions and request ceilings. In the existing embedded Host case, the already keyed non-coordination branch uses a manual project key so its original business, checkpoint and cold continuation prove the same actual scopeDigest/credentialId without another POST. The unpackaged Linux x64 authless coordination branch remains unchanged; do not pretend it proves a manual key. Original eleven business requests, original model/tool caps, permissions, image/history and physical cleanup remain.

The existing Linux embedded-server native case retains its one original child and 180-second allowance. Add the selected-source fixture before allocation, an unauthorized source request that cannot read/spend the file, one genuine same-child key import/readback and bounded proof/no-secret checks, then post-original-Stop hash-only revalidation and a file-drift refusal without a new child. Exact arithmetic for this existing case is twelve additional HTTP requests: one unauthorized selected-source POST; three original readCatalog GETs (/api/provider, /api/model, /api/model/default); four original readDirectory GETs (the same three plus /api/integration); one original key integration GET, one selected-source POST and one final integration GET; and one readSelectedSource integration GET. The unique configured TEST provider must actually have no explicit integrationId (native Info.empty6306eb374d91b4c45768ed76cd3fbda33d2378d1 and config plugin21a1); the same-ID directory row is asserted, not guessed. D900929ed38ea49605f07a8ca3dca7c75bc5a4c09 and ec430bf1bfbdba10e6dddd3e2560a9c2de5e6b02 establish the 3+4 read order. A TEST-local counter admits at most these twelve added calls and compares their full method/path order; it never resets. The original three session/session/info GETs remain unchanged, giving fifteen total HTTP requests in the case. The final selected-source GET qualifies that read-only subpath on the same owner, not a physical cold restart; actual cold remains the original embedded Host continuation. The unauthorized response body and all admitted D bodies are drained/closed under their original paths. Existing D per-request deadline/body/chunk limits and the original server-case 180-second allowance/one child remain; there is no model inference or model-counter increase, new native scenario or replacement of its original custody/environment/nonce/stop/confirm/group-absence assertions. Other native tuples obtain the actual input/cold proof from the original Host case above. Every original finally remains effective if any added assertion fails.

Run only the relevant existing D and F cases, Host build/types, canonical script checks and existing source guard in root's serial slot. Every changed/new production file remains within the existing source-size policy (800 lines, with no new or raised exception). Existing TEST files remain existing cases under the original test exclusion; saved-team-model-probe.test.ts is already longer than 800 and is not misreported as below that cap. No new test suite is introduced. The ordinary exact-head D and F native lanes must validate delivered module exports, actual request transformation, actual original credential use, cold identity and cleanup. Passing source review or synthetic tests does not close these gates or the independent POSIX execution-image race.

### R10.10. Fixed source inventory

The following preimages are from the exact R9 published trees named in R10.1 and D002db02a255c532adf43ee12cf5ed56a3e6d6f5b. Parent and qualification differ from native only where shown. Root performs a fresh preimage check before each source cut and preserves child variants. The two new helpers are directly consumed; add only their paths to the existing supplementary proof roster. The main roster cap is unchanged. The already-declared B2 preparation helper is a shared composition dependency, not a second preparation owner.

D: three existing paths.

| Path | Exact preimage |
|---|---|
| packages/provider-implementations/src/features/provider-session-implementation/adapters/opencode-protocol/v2-credential-client.ts | 7cc07068845c4fc2ec995ac599e74fe8a0b32103 |
| packages/provider-implementations/src/features/provider-session-implementation/adapters/opencode-protocol/v2-credential-wire.ts | 1f7c9a76c971c0a94971e8b3ceec20f0badd42ec |
| packages/provider-implementations/tests/features/provider-session-implementation/opencode-protocol/v2-credential-client.test.ts | 86e8d9d1dab2f74d7710d0532d28b199e182a2ba |

F: 27 logical paths (24 currently existing, two new bridge helpers, and one already-declared B2 helper awaiting its frozen preimage).

| Path | Parent / qualification preimage | Native preimage if different | Purpose |
|---|---|---|---|
| packages/legacy-agent-host/src/composition/openCodeSelectedProviderConfiguration.ts | 6b011c5b67ab97af5a5b2fd3ba28d2a69a4b7cf4 | same | Pure selected raw-leaf classification; other file fields remain refused |
| packages/legacy-agent-host/src/adapters/providers/OpenCodeV2CredentialScope.ts | c9288ba5bf37aeb221895ee289c3fdc4632c5f11 | same | Existing auth/source capture plus branded deferred manual source; original concrete paths retained |
| packages/legacy-agent-host/src/adapters/providers/OpenCodeV2CapturedConfiguration.ts | ffe6903dbc7dd5595d491b0bb51c64767597070c | same | Separate deferred source from stripped translated key settings; exact existing source reuse |
| packages/legacy-agent-host/src/adapters/providers/OpenCodeV2SessionCredential.ts | 6512a45b3e5172af4c0468b8c6a51386629ebeba | same | Same once-only prepare, source-client proof acceptance and cold actual ID/digest checks |
| packages/legacy-agent-host/src/adapters/providers/OpenCodeV2EmbeddedGraph.ts | 1f0c9c38dfc56db7a57023052151bf14290bac57 | same | Finite delivered materializer/HTTP/auth module resolution with same Effect identity |
| packages/legacy-agent-host/src/adapters/providers/OpenCodeV2EmbeddedChild.ts | 772a5c38e10241f2923755561a42f80f52f5db09 | same | Original init and start transform; same process/scope/cleanup |
| packages/legacy-agent-host/src/adapters/providers/OpenCodeV2EmbeddedServer.ts | a7447324a75e43f566c03eeaf03dc1af67c2b669 | same | Private descriptor/reference tied to original ready/custody |
| packages/legacy-agent-host/src/adapters/providers/OpenCodeV2ModelProbe.ts | 8fd501912bf0e6049ca8861e99dadfa8b21cd337 | same | Original native prepare observation and private file-proof forwarding |
| packages/legacy-agent-host/src/adapters/providers/OpenCodeV2EmbeddedMemberProvider.ts | 02ee4972611ad40325cbe25a24516adf39d8625e | same | Original Session credential source and required later digest callback |
| packages/legacy-agent-host/src/adapters/providers/OpenCodeV2ManagementHost.ts | d2dd9aa2c9749f8829a57b64c53fd212ccc225b7 | same | Carry descriptor through same retained metadata owner without catalog key import |
| packages/legacy-agent-host/src/adapters/providers/OpenCodeLocalModelReadiness.ts | 07043c89dbfb0be24fa074df8357a784f4090eca | same | Actual native file proof, original keyed applicability/account digest/currentness |
| packages/legacy-agent-host/src/composition/ProviderManagementCoordinator.ts | 2b8b74dca620cddcb2a8363f9f9cacc22d3913e3 | same | Private optional proof callback forwarding; no public route |
| packages/legacy-agent-host/src/management/ModelProbeOwner.ts | a8100a823ec8861951322970dfbc1121ddcfa415 | same | Original clean completed probe witness persistence/omission; shared B2 composition |
| packages/legacy-agent-host/src/management/commandRecords.ts | 8d8b6dc93c73bae0ea287db69efe153bd64e5c66 | same | Optional closed private witness on original probe record; shared B2 composition |
| packages/legacy-agent-host/src/adapters/providers/MemberProvider.ts | 654479ccc0a8abe6cd2e9b6208d459e6921d4947 | add838c80d4b77e459dd4ddbc8ea1152a488a911 | Private actual readiness credential assertion; preserve native-only context fields |
| packages/legacy-agent-host/src/composition/createRuntimeMemberProviderFactory.ts | 53f4c270f1634a65f8eb465f11b7e2e59242ee22 | 966c5c6e758be51cde700073f6035bd5a4056d00 | Same consumed B2 reference → private assertion; preserve child factory guards |
| packages/legacy-agent-host/src/composition/prepareTeamModelReadiness.ts | B2 declared NEW; compose after freeze | same | Already-declared B2 helper; exact original record hash-only account consumer and callback |
| packages/legacy-agent-host/tests/opencode-configuration-source.test.ts | 53295ed45a3e0d72e996910ea2b8a904da877ae7 | same | Existing selected-source/credential provenance cases; preserve R8 and §3d |
| packages/legacy-agent-host/tests/opencode-v2-credential-scope.test.ts | eb3d58186ba61ce70415ad5c16f8f4d5f520498c | same | Existing finite real-client sequence/cold/negative cases and original caps |
| packages/legacy-agent-host/tests/opencode-v2-model-probe.test.ts | 69228ea7d2b2e1583521e6440cace5b3ad80d45b | same | Existing private native observation/cleanup cases |
| packages/legacy-agent-host/tests/saved-team-model-probe.test.ts | fa7d33fcc44577c79395d8cb4cb1a9a51534101a | same | Existing original released receipt/account consume and mismatch cases |
| packages/legacy-agent-host/tests/opencode-v2-model-probe.native.ts | 6525dee3263fce89d6049ada4d1abf889a1a1a16 | same | Original manual global key; retain project managed route and original input limits |
| packages/legacy-agent-host/tests/opencode-v2-embedded-host.native.ts | ce8f5056e3a55aee8116314ebcc7016464d5d00b | same | Original keyed project/cold manual route; Linux authless coordination unchanged |
| packages/legacy-agent-host/tests/opencode-v2-embedded-server.native.ts | 030ababdf0f58eb6ae7fbc47a3418f2013b3c878 | same | One original Linux child, real private source request and post-close witness |
| scripts/legacy-agent-host/desktop-proof-supplementary-sources.ts | e48911d3d3e1f736ef2da9fb6b740e86e240a97e | same | Two directly consumed new helper paths only |
| packages/legacy-agent-host/src/adapters/providers/OpenCodeV2SelectedFileKey.ts | NEW | same | NEW private descriptor/proof schema, brand and bounded hash-only delegation |
| packages/legacy-agent-host/src/adapters/providers/OpenCodeV2NativeFileKey.ts | NEW | same | NEW child-only scoped native materializer and original HTTP transform |

### R10.11. Completion and refusal boundaries

Completion requires the checked new D artifact, independent source peers, canonical focused gates and the ordinary genuine native proofs, then the connected B2 allocation gate. Until those are observed, manual file parity remains open. A held file/source/credential/currentness/cleanup result must stay held; no literal/auth fallback, guessed integration, missing-proof authless classification, fresh probe on lookup, post-close child recreation, source rewrite, opaque checkpoint migration, or count/timeout relaxation is part of this plan.

The new authority is limited and explicit: native materialization of the exact original selected raw apiKey leaf, followed by a native-issued exact-dependency hash delegation to the same private original receipt. There is no public arbitrary-path endpoint, secret store, raw key DTO, generic service, release patch, new process/owner or independent journal. Existing key/file/config bounds and the new finite bridge bounds are enforced rather than silently claiming unbounded CLI behavior. This plan authorizes that connected restoration for review; it does not claim it is already implemented or qualified.
