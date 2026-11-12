# 01. Codex: вход через браузер и device code в Host

Статус: реализация P01; полная native/Desktop приёмка остаётся открытой.
Первый source slice опубликован: [provider PR #8](https://github.com/agent-teams-ai/old-provider-implementations/pull/8),
commit `09c2859f932be6eeb6fe26289bb997d8e0a81289`. Typed start/cancel/private completion готовы;
`pnpm check` PASS на Node 24.21.0 и 26.11.1 / pnpm 11.18.0 (509 source tests + два packed consumers на каждом).
Frontend получает retained verified archive `691a7a62…`; Session SPI pin не меняется. Host/UI/native login acceptance ещё открыта.
Host core опубликован в `0d1b2ccb50bfdcf3d4c5d6804cba0dc0ab388958`: bounded early-ID correlation,
browser/device completion, exact cancel, ChatGPT readback и confirmed original custody.
Контролируемые Host/D/child проверки: **23/23 PASS** (`codex-login`, `codex-metadata`, `management-oauth`).
Следующий Main slice сохраняет существующий account IPC/DTO/presenter и поддерживает subscribe/copy/reopen/cancel.
Login intent хранит только operation ID, target ID, mode и **original context ID**; credential rows остаются совместимыми.
Cold recovery использует прежний context grant; запись login без context остаётся held и не заимствует текущий контекст.
Перед публикацией account/URL Main сравнивает свежий foreground target ID; исходные read/cancel остаются у старого owner.
Auth readiness переиспользует `evaluateCodexLaunchReadiness`, включая независимую доступность ключа из captured env.
Это baseline account/runtime gate; успешный account read не заменяет ModelProbeOwner перед запуском из плана 05.
Main controlled acceptance: **12/12 PASS**, из них три existing account IPC → Main → real Host/D → TEST child E2E;
browser, device code, потерянный ответ с повторным Main и сменой контекста, refresh/logout, секреты вне intent/progress.
Дополнительные Host metadata проверки: **3/3 PASS**, включая ChatGPT account вместе с captured API key без выдачи key bytes.
Эти результаты не являются actual Electron button proof и не доказывают вход в vendor account.
Native browser/device completion, реальный Electron Login UI и финальные exact-SHA CI receipts пока открыты.
Основание: сохранить возможности текущего Desktop frontend при включённом Host.
Baseline frontend: `4a0e06277fe216d9f82dbbede362668fe46622ee`.
Baseline Stage 1: `1d0f97f55de566036c970eab4f36b84620afdb3f`.
Ветка интеграции: `feat/provider-host-frontend-parity-20261112`; merge в main не входит в этот срез.

## 1. Что уже существует и что теряется

- В текущем UI доступны вход ChatGPT через браузер, вход по device code, отмена, refresh и logout.
- `useCodexAccountSnapshot` вызывает существующий account API и наблюдает pending login даже при скрытой панели Providers.
- [Main: `useCodexAccountSnapshot`](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/features/codex-account/renderer/hooks/useCodexAccountSnapshot.ts).
- `CodexLoginSessionManager.start` открывает выбранный app-server и вызывает `account/login/start`.
- Browser использует тип `chatgpt`, device code — `chatgptDeviceCode`; завершение приходит через `account/login/completed`.
- `cancel` отменяет исходный loginId и закрывает именно принадлежащую операции сессию; pending start также отменяется.
- [Main: `CodexLoginSessionManager.start/cancel`](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/features/codex-account/main/infrastructure/CodexLoginSessionManager.ts).
- [Main: существующие protocol/lifecycle tests](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/features/codex-account/main/infrastructure/__tests__/CodexLoginSessionManager.test.ts).
- Это рабочий программный маршрут и проверенный protocol baseline; данный аудит не выполнял новый вход в настоящий аккаунт.
- В Host-фасаде `startChatgptLogin` и `cancelLogin` сейчас возвращают `unsupported`, `subscribe` пуст, login всегда `idle`.
- [Stage 1: `createCapturedCodexFeatures`](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/src/features/runtime-provider-management/main/adapters/output/createCapturedCodexFeatures.ts).
- `CapturedCodexAuthCommands` уже реализует durable refresh/logout; повторять эту инфраструктуру не нужно.
- [Stage 1: `CapturedCodexAuthCommands`](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/src/features/runtime-provider-management/main/adapters/output/CapturedCodexAuthCommands.ts).
- Поставленный `CodexAppServerClient` имеет read/refresh/logout, но не публичные login start/cancel методы.
- Следовательно, нужен небольшой source change в provider library, а не обход Host старым ambient app-server.
- R2 проверил source `d58500bc983e897506e23d7b0bc8da1209864edd`: `adapters/codex-protocol/app-server.ts`
  имеет `readAccount/refreshAccount/logoutAccount`; `account/login/completed` сейчас попадает в generic unsupported event.
- Existing UI также позволяет скопировать ссылку и device code и повторно открыть страницу входа:
  [CodexLoginLinkCopyButton](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/renderer/components/runtime/CodexLoginLinkCopyButton.tsx).

## 2. Пользовательский результат и приёмка

1. Пользователь нажимает «Войти» и получает тот же выбор browser/device-code, что в текущем приложении.
2. Повторный клик при pending login наблюдает исходную операцию; второй процесс и второй вход не запускаются.
3. После завершения обновляются account, quota и доступность запуска из выбранного профиля.
4. Выбор `auto/chatgpt/api_key` сохраняет прежнюю семантику; успешный login не меняет предпочтение самовольно.
5. Отмена работает до старта app-server, при ожидании браузера и при device-code ожидании.
6. Смена проекта/профиля не переносит pending login на новый target и не отменяет чужую операцию.
7. Перезапуск UI восстанавливает наблюдение за исходным target; неизвестный результат не превращается в автоматический повтор.
8. Ошибка входа, таймаут и неподтверждённая очистка отображаются честно; счётчик «вошёл» требует account readback.
9. Существующие refresh/logout/API-key сценарии продолжают работать после добавления login.
10. Copy link/code и повторное открытие исходной ссылки работают в Settings, banner и Create/Launch reconnect; новый login не создаётся.

## 3. Минимальная архитектура

- Оставить существующие account DTO, preload API, экран и hook; новая панель входа не нужна.
- Main захватывает выбранный `CapturedProviderManagement` один раз до первого внешнего эффекта.
- Host владеет login lifecycle, native child, auth namespace и окончательным результатом.
- Повторно использовать `OAuthOperationOwner`, `ManagementCommandStore` и `ManagementResourceFence`.
- [Stage 1: `OAuthOperationOwner`](https://github.com/777genius/agent-teams-ai/blob/1d0f97f55de566036c970eab4f36b84620afdb3f/packages/legacy-agent-host/src/management/OAuthOperationOwner.ts).
- Codex-specific native conversation адаптирует browser/device code к существующим start/read/cancel владельца OAuth.
- Не копировать 342 строки старого login manager и не создавать второй общий OAuth engine.
- Host authorization reply остаётся private Host→Main; generic `management.oauth.progress` не содержит URL/code.
- Существующий Codex account DTO сохраняет краткоживущие `authUrl/userCode` для выбранной операции и authorised renderer,
  чтобы прежние copy/reopen controls продолжали работать; durable store, diagnostics и общий progress их не получают.
- URL проверяется как HTTPS без userinfo и открывается через существующий `openExternal` boundary; новый auto-open при read запрещён.
- Device user code — отображаемый код для vendor страницы, не access token и не authorization code для `oauth.complete`.
- Не отправлять native loginId, credentials, process paths и произвольные native instructions в публичные progress events.
- Durable intent хранит operationId и исходный target, но не пароль, token, authorization URL или device code.
- При cold restart возможно только чтение receipt или явная неподтверждённость; восстановление UI не запускает новый login.
- Общие profile revision/recapture правила принадлежат плану 06; здесь используется его порт, без нового registry.

## 4. Изменения по шагам

### Шаг A — подтвердить контракт native login

- В source repo `agent-teams-ai/old-provider-implementations` найти исходный `CodexAppServerClient` и его protocol codecs.
- Зафиксировать выбранный source commit и версии native Codex до изменения; источник не выбирать по stale default branch.
- Добавить типизированные start/cancel/completion методы только для уже используемого `account/login/*` протокола.
- Поддержать ровно browser и device code; не делать универсальный raw RPC интерфейс для Desktop.
- Проверить completion filter по исходному loginId и закрытие notification subscription вместе с client.
- Зарегистрировать typed login observer до отправки start; bounded early-completion buffer связывается с ответом по exact loginId.
- Отсутствующий/чужой loginId не объявлять успехом по тому, что другой account/read уже вернул пользователя; ambiguous outcome сохраняется.
- Оба режима завершаются `nativeCompletion`; device-code route использует `completionMethod: auto`, не paste-code flow.
- Изменения делать в исходниках owning repo, собрать immutable archive и записать source commit + digest.
- Vendored `dist`, tgz bytes и lockfile integrity вручную не редактировать.
- Archive update и проверка внешнего consumer проходят штатным путём provider repo и frontend pin.

### Шаг B — native conversation под существующим Host owner

- Расширить `packages/legacy-agent-host/src/composition/CodexManagementCoordinator.ts` фабрикой Codex login conversation.
- Выделить небольшой `CodexLoginConversation.ts` рядом с provider adapters, если lifecycle не помещается в текущий host.
- Использовать `CapturedProcess`/`codexByteTransport`, захваченный HOME/CODEX_HOME и существующее custody закрытие.
- Подключить Codex flow к management routing, не смешивать его с conversation Session SPI.
- В `packages/legacy-agent-host/src/management/contracts.ts` добавить только безопасное представление нужного состояния.
- Для device code расширить private authorization reply; не включать code в persisted/public OAuth snapshot.
- Logout/refresh и login должны сериализоваться по тому же auth namespace через существующий fence.
- После cancel сначала закрыть исходную native conversation; completed race разрешить по фактическому receipt/readback.
- Cancel не вызывает logout и не удаляет уже сохранённые native credentials. Если completion успел раньше отмены,
  состояние аккаунта читается отдельно: отменённое ожидание не означает откат состоявшегося входа.
- `OAuthOperationOwner.finish` доверяет `complete()` и сам не закрывает child: Codex `complete()` обязан проверить account
  и завершить client/custody до `true`; cleanup=false не освобождает namespace под completed receipt.
- Проверить login против refresh/logout: общий resource fence сериализует mutations; owner readback не ждёт собственной reservation.

### Шаг C — account facade и UI observation

- В `createCapturedCodexFeatures.ts` заменить два unsupported метода адаптацией к captured login flow.
- Восстановить `subscribe` и проецировать реальное login состояние вместо постоянного `idle`.
- Переиспользовать intent/restore подход `CapturedProviderOAuth`; Codex presentation не проталкивать в общий provider DTO.
- Account read после completion выполняется на исходном target, затем UI принимает его только для текущего выбора.
- `setMainWindow` и dispose должны подключать/снимать нужные подписки, без скрытого повторного открытия браузера.
- `getLaunchReadiness` переиспользует baseline `evaluateCodexLaunchReadiness` с native account и captured API-key availability;
  выбранная модель отдельно проверяется существующим ModelProbeOwner в плане 05, без нового общего readiness store.
- Binary path override продолжает отклоняться captured boundary; выбор executable выполняет план 06.

### Шаг D — end-to-end доказательства

- Расширить существующий Desktop account proof и общий Host/D protocol fixture; отдельный тестовый framework не вводить.
- Нынешний account proof вызывает API через CDP и исключает ChatGPT login. Добавить нажатия существующих browser/device
  кнопок и проверку панели; прямой API setup допустим только для подготовки, не вместо пользовательского действия.
- Для integration использовать новые sandbox HOME/CODEX_HOME и только TEST credentials.
- Сначала зафиксировать regression refresh/logout, затем browser/device-code и cancel/restart сценарии ниже.
- После protocol proof выполнить native Codex smoke на pinned binary; genuine account completion фиксировать отдельным receipt.
- Fixture PASS не называть доказательством успешного входа в настоящий ChatGPT account.

## 5. E2E, являющиеся основным критерием

База: `scripts/legacy-agent-host/desktop-codex-account-proof.ts`, `desktop-backend-smoke.ts`, actual Host/D fixture.
Донор lifecycle сценариев: `packages/legacy-agent-host/tests/management-oauth-host.e2e.ts`; его старые pins обновлять только штатно.

| Сценарий | Действие через существующий UI/API | Проверяемый результат |
| --- | --- | --- |
| Browser happy path | Войти, открыть выданный URL, завершить controlled native login | Один start; pending → account readback; UI показывает исходный account |
| Device code | Выбрать device code, увидеть/скопировать код, завершить вход | Код только в нужной панели; account обновлён; секреты не попали в receipt |
| Early completion + reopen | Completion приходит до start reply; затем copy/reopen в прежнем reconnect UI | Не потерян exact loginId; одна операция; исходная ссылка/код доступны без повторного start |
| Double click + cancel | Дважды нажать вход, отменить до открытия и при ожидании | Один native child; отмена исходного loginId; cleanup подтверждён |
| Потерянный ответ | Удержать completion/ACK, переподключить UI | Read исходной операции; нет повторного start и повторного browser open |
| Смена выбора | Начать на A, выбрать B, отменить/завершить A | B не получает credentials/состояние A; A очищается своим владельцем |
| Regression | После login выполнить refresh, logout, затем API-key сценарий | Прежняя семантика account/quota/предпочтения; нет новых запусков модели |
| Fence/cleanup | Пока login pending вызвать refresh/logout; задержать native cleanup после completion | Нет deadlock, credential race или ложного completed; namespace остаётся held до cleanup |
| Native qualification | Pinned Codex + выделенный тестовый account, оба способа входа | Native completion и account readback на выбранных bytes; отдельная маркировка доступа |

В тестовых receipts: commit/archive hashes, profile revision, operationId, последовательность фаз и cleanup result.
Не записывать login URLs с чувствительными query, device code, tokens или пользовательские credentials.
Доступ к реальному тестовому аккаунту не заменять чтением пользовательского HOME.

## 6. Ограниченный unit список

- Расширить existing protocol table для early/foreign/missing loginId и cancel-before-allocation; не копировать старый manager suite.
- Один тест receipt/target mismatch и duplicate operationId с другим mode/profile.
- Один тест public projection: запрет credentials/native instructions и срок жизни device-code presentation.
- Не дублировать unit-тестами каждую ветку UI hook: переходы состояния покрываются Desktop E2E.

## 7. Зависимости, объём и риски

- Владение: этот срез — account login и Codex native methods; план 06 — capture/profile revision/readiness.
- План 03 может менять ту же provider library, но Session controls не смешиваются с account methods.
- Archive publish/pin имеет одного владельца интеграции: два параллельных среза не выпускают несовместимые pins.
- План 02 использует существующие credential owners, но не меняет Codex account presentation.
- Объём production: **500–900** новых/существенно изменённых строк; перемещения/generated excluded.
- Проверки: **450–800** строк E2E/fixture и **100–180** строк критичных unit; это оценка, не quota.
- Сложность **5/10**; ожидаемая надёжность после приёмки **8/10**; уверенность оценки **7/10**.
- Надёжность — инженерная оценка, не вероятность отсутствия ошибок и не уже достигнутая характеристика.
- Главные риски: completion/cancel race, device code projection и сохранение original target при смене профиля.
- Реальный vendor login может требовать интерактивного тестового доступа; его отсутствие отмечается как неполная квалификация.
- Кодовый срез считается готовым после E2E и required gates на exact HEAD; native auth evidence показывается отдельно.

## 8. Реальные круги review

### R1 — авторская критика, выполнена 2026-11-12

- Найдено: generic OAuth public progress намеренно исключает authorization details; слепой reuse терял бы device-code UI.
- Исправлено: code выделен в private authorization reply и краткоживущую account projection, без хранения в intents/events.
- Найдено: старый login manager подтверждает протокол, но не наличие login API в новом D artifact.
- Исправлено: добавлен отдельный source-repo extension и immutable archive gate; запрещена правка vendored dist.
- Найдено: успешный account read не доказывает model launch readiness.
- Исправлено: readiness передана общему profile порту; сохранён отдельный native qualification результат.
- Проверены cited symbols и существующие account/Host proof harness; production в R1 не изменён.

### R2 — независимое cross-review, выполнено 2026-11-12

Reviewer: `estimate_platform_acceptance`; входной docs commit `bedaf5aae9d81033704636b5362472ddab5818d3`.
Прочитаны actual-main manager/UI, source D `d58500bc…`, Host OAuth owner/fences и Codex management adapter.

- **R2-01-01:** Main-only URL исключал прежний Copy/reopen UI. Сохранена ephemeral Codex DTO projection; общий progress/store остаются без URL/code.
- **R2-01-02:** Device code можно ошибочно принять за paste authorization code. Явно назначены native completion и `auto` для обоих режимов.
- **R2-01-03:** Notification после start subscription теряла early completion; добавлены bounded pre-reply correlation и exact-ID native test.
- **R2-01-04:** OAuth owner не закрывает child на success сам; `complete()` теперь обязана включать account readback и подтверждённый cleanup.
- **R2-01-05:** Последовательный regression не проверял login/logout/refresh fence; добавлен один общий race/cleanup E2E.
- LOC остаётся предварительной оценкой; UI copy/reopen переиспользует существующие controls, новый auth framework не нужен.

### R3 — интеграционное review, выполнено 2026-11-12

Reviewer: root; входной published SHA `cda065d869ccffb5930ed2a817b3e0654b00bb31`.
Повторно проверены `CodexLoginSessionManager.cancel`, `OAuthOperationOwner.finish`, private management capture и P02/P06/P10.

- Найдено: cancel/completion формулировка могла потребовать удаления уже опубликованного account. Уточнены cancel≠logout и account readback без rollback credentials.
- Найдено: existing Desktop account harness не нажимает Login и не доказывает UI flow. Добавлены реальные control actions; общий setup с P02/P10 переиспользуется.
- Подтверждены границы: D только typed native codec, Host — process/auth lifecycle, P06 — source revision, Main — прежняя account projection. Второго OAuth engine/store нет.
- План принят для реализации. Native vendor completion остаётся отдельной незакрытой квалификацией; R3 не является её PASS.
