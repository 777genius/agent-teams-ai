# 01. Codex: вход через браузер и device code в Host

Статус: реализация P01; полная native/Desktop приёмка остаётся открытой.
Первый source slice опубликован: [provider PR #8](https://github.com/agent-teams-ai/old-provider-implementations/pull/8),
commit `09c2859f932be6eeb6fe26289bb997d8e0a81289`. Typed start/cancel/private completion готовы;
`pnpm check` PASS на Node 24.21.0 и 26.11.1 / pnpm 11.18.0 (509 source tests + два packed consumers на каждом).
Frontend получает retained verified archive `691a7a62…`; Session SPI pin не меняется. Host/UI/native login acceptance ещё открыта.
Host core опубликован в `0d1b2ccb50bfdcf3d4c5d6804cba0dc0ab388958`: bounded early-ID correlation,
browser/device completion, exact cancel, ChatGPT readback и confirmed original custody.
Контролируемые Host/D/child проверки: **23/23 PASS** (`codex-login`, `codex-metadata`, `management-oauth`).
Main slice `7f4316c36cd0e942f5c2d0277a284f9c7180538f` сохраняет существующий account IPC/DTO/presenter и поддерживает subscribe/copy/reopen/cancel.
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
Реальные Settings-кнопки вынесены в отдельный Ready test-only [PR #1187](https://github.com/777genius/agent-teams-ai/pull/1187),
commit `e7d02adff43da420e4aed3d3cdb8e7a479c8aac7`: отдельный Linux `codex-login-ui` job, прежний Stage 1 gate не изменён.
Локальный Electron не стартовал: обычный listen получил EPERM, штатная эскалация отклонена policy; UI/native PASS не заявлен.
Harness narrow typecheck, 15 CI-policy tests и focused lint пройдены; native start/cancel проверяются штатным CI.
Уточнение known-rejection реализовано отдельным срезом: exact native `success:false` + confirmed cleanup дают `failed/native-rejected`.
Host/D/TEST child и критичный cleanup invariant: **26/26 PASS**; Main account tests: **13/13 PASS**, включая явный retry другим режимом.
EOF/lost reply/чужой ID/wrong-account по-прежнему не разрешают автоматический повтор. Native error остаётся приватным.
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
11. Точный native `account/login/completed(success:false)` разрешает новый **явный** вход только после confirmed original cleanup.
    EOF, lost reply, чужой ID, неверный account readback и неизвестная очистка остаются held; raw native error в UI не передаётся.

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
| Подтверждённый отказ | Получить exact-ID `success:false`, дождаться cleanup, повторить вход кнопкой | Ошибка без URL/code/raw native error; один новый вход только по явному действию; uncertain outcome остаётся held |
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

### R4 — actual Linux Desktop outcome и перенос готового census correction, 2026-11-13

Qualification head `b54390e9844a4f868c6f460905c4d9664e1340e8`,
[run 43335609196 / job 131606204672](https://github.com/777genius/agent-teams-ai/actions/runs/43335609196/job/131606204672)
прошёл предшествующие actual Claude/Codex finite schedule cases, затем завершил
Codex login Desktop со статусом INCOMPLETE. Извлечённый официальный artifact
`14006993377` (ZIP159818 bytes, SHA256
`3a86be2577ece34ad6ca92a48bbb8aeaaf9cc00e85cd6fb64126a8983a98e9d0`)
сохранил точную причину: `assert.ok(pid && ppid !== undefined && pgid)`.
Падение произошло в общем process census до действий на экране входа;
оно не доказывает ошибку Codex login protocol и не даёт UI PASS.

В native child уже опубликован correction
[c5ae9b03](https://github.com/777genius/agent-teams-ai/commit/c5ae9b03a84965f9e497d60d4ff6beac1c5640b8):
наблюдение допускает корректный Linux PGID0, но captured app group по-прежнему
должен быть положительным. Malformed/non-integer rows отклоняются, сигналов
из census нет. Перенести ровно existing parser hunk и один уже написанный
regression в parity, затем штатно синхронизировать qualification branch.
Не менять login UI/protocol, native identities, deadlines или критерии cleanup.
Actual login Desktop и завершение vendor authentication остаются отдельными
незакрытыми проверками; source correction не считается их выполнением.


### R5 — оставшийся actual login gate после census correction, 2026-11-13

Повторно прочитаны exact qualification head `b54390e9844a4f868c6f460905c4d9664e1340e8`,
`desktop-codex-login-ui-proof.ts` (`c64813ba`), TEST opener
`desktop-codex-login-fixture.ts` (`5d988c5e`) и existing
`codex-login-desktop` job. Предыдущий PGID0 отказ не достиг UI; оснований
менять login product code по этому результату нет.

1. Штатно синхронизировать Ready PR1187 с текущей parity веткой, разрешить actual
   source conflicts и запустить прежний job на итоговом exact HEAD. Он должен
   сохранить native Codex0.162.0 checksum, private TEST roots, source freeze,
   original Quit/cleanup и оба режима; queued/skipped не заменяют PASS.
2. Existing actual journey уже делает browser/device start → native pending,
   Copy acknowledgment, один explicit Electron→TEST OS opener с digest исходного
   URL, закрытие/открытие Settings dialog без второго start и original Cancel.
   Затем проверяет signed-out readback, cleared private fields, released original
   namespace, отсутствие logout и trusted UI clicks. Новый тестовый framework или
   дополнительные native inputs для этих проверок не нужны.
3. Early/foreign/null completion, cancel-before-login, lost start reply,
   Main recreation/context switch, original target, wrong-account, refresh/logout
   serialization и задержанная cleanup confirmation проверяются existing Host/D/TEST
   process и Main safe-E2E. Их final-pin проверки остаются обязательными; новые
   unit tests на каждую ветку не добавляются.
4. Этот actual UI job **не завершает vendor authentication**. Browser/device success
   с dedicated authorized TEST account, exact native completion, исходным ChatGPT
   account/quota/readiness readback и подтверждённой cleanup остаются отдельной
   квалификацией. TEST child completion, показанный код и успешная отмена не
   подтверждают её. Пользовательский HOME или существующие личные credentials
   не являются заменой выделенного test account.

Source scope review — PASS. Actual Linux login UI и native authenticated completion
пока pending; новый код login на основании census-only отказа не требуется.

### R6 — исправления подтверждённых auth recovery замечаний, 2026-11-13

Source audit выполнен на `24ba208ada96020938d59a96d97094d8a37c13e4`;
auth paths сохранены в parity `1bfccb9d1b2b695264ccd4f890eafa7ecfeb84c0`.
Замечания PR1186 сопоставлены с текущим кодом, а не приняты по тексту review.
Этот срез не закрывает отдельно указанное в R5 успешное vendor authentication.

#### Исходные контракты и ссылки

- Старый frontend: [CodexLoginSessionManager.cancel](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/features/codex-account/main/infrastructure/CodexLoginSessionManager.ts)
  захватывает исходную session, убирает observer, отменяет её loginId и закрывает
  её client; Cancel не выполняет logout.
- Новый [CapturedCodexLogin](https://github.com/777genius/agent-teams-ai/blob/1bfccb9d1b2b695264ccd4f890eafa7ecfeb84c0/src/features/runtime-provider-management/main/adapters/output/CapturedCodexLogin.ts)
  уже удерживает original target, commandId, private intent и Host receipt.
  Исправления остаются в этом owner, без второго OAuth engine.
- [createCapturedCodexFeatures](https://github.com/777genius/agent-teams-ai/blob/1bfccb9d1b2b695264ccd4f890eafa7ecfeb84c0/src/features/runtime-provider-management/main/adapters/output/createCapturedCodexFeatures.ts)
  сохраняет прежние account/quota/readiness DTO;
  [CapturedCodexAuthCommands](https://github.com/777genius/agent-teams-ai/blob/1bfccb9d1b2b695264ccd4f890eafa7ecfeb84c0/src/features/runtime-provider-management/main/adapters/output/CapturedCodexAuthCommands.ts)
  владеет existing credential intent/recovery.
- [FileCodexAuthIntentStore](https://github.com/777genius/agent-teams-ai/blob/1bfccb9d1b2b695264ccd4f890eafa7ecfeb84c0/src/features/runtime-provider-management/main/infrastructure/FileCodexAuthIntentStore.ts)
  хранит только original routing, не credentials. Существующие bounded scan,
  per-target lock, atomic create и identity checks остаются основой.
- [OAuthOperationOwner.finish/stop](https://github.com/777genius/agent-teams-ai/blob/1bfccb9d1b2b695264ccd4f890eafa7ecfeb84c0/packages/legacy-agent-host/src/management/OAuthOperationOwner.ts)
  уже синхронно fences original entry перед awaited cancellation cleanup.

#### 1. Повтор восстановления после transient failure

Threads `PRRT_kwDORVTEtM622S19` и `PRRT_kwDORVTEtM625cCu` описывают один defect:
rejected `this.recovery` остаётся навсегда. Следующий account read или Cancel
повторяет rejection даже после восстановления store/context.

- В существующем owner объединить original recovery в один coalesced promise.
  При rejection очистить только тот promise, который по-прежнему является текущим.
- Следующий явный read/cancel повторяет bounded intent lookup и restore исходного
  target/context, затем только `oauth.read(original commandId)`.
- Не переигрывать `oauth.start`, не выбирать текущий аккаунт вместо сохранённого.
  Чужой context и неизвестный результат остаются unavailable/held.

#### 2. Отдельное подтверждение retirement исходного intent

Thread `PRRT_kwDORVTEtM6275kS`: terminal receipt помечает entry settled до
успешного retire; после ошибки удаления intent дальнейшие observe/cancel не
повторяют retire. Та же проблема возможна после доказанного pre-admission refusal.

- После terminal receipt native effect остаётся fenced; хранить в том же entry
  только короткое private состояние pending retirement исходного intent и
  ожидаемую terminal projection. Публичный DTO и durable format не расширять.
- Повтор observe/cancel сначала делает только idempotent `intents.retire(original)`.
  Одновременные вызовы используют один текущий retirement promise; rejection
  очищает promise, но сохраняет исходный pending intent для следующего вызова.
- После успеха восстановить idle/cancelled/native-rejected projection и один раз
  опубликовать settled/account readback. Не оставлять transient failure как вечный
  failed и не повторять native cancellation/read/start для уже известного terminal.
- Exact pre-admission refusal / доказанный not-dispatched также требует retry
  только local retire: у такой операции нет native receipt, поэтому `oauth.read`
  не может служить её восстановлением.
- `held` по-прежнему сохраняет intent. Retry восстановления/retirement не должен
  в том же start invocation незаметно перейти к новому login.

#### 3. Один retained login для account facade

Thread `PRRT_kwDORVTEtM622S2D`: settled held A оставляет свой intent, а
target-local admission на B допускает второй. После restart bounded scan уже не
может выбрать единственную original operation.

- До admission учитывать existing `pendingLogin()` для всех targets, а не только
  `read(selected targetId)`. Held A запрещает новый login B до подтверждения A.
- Глобальный login check/create сериализовать существующим `withFileLock` в этой
  же private directory, затем использовать прежний per-target lock/atomic create.
  Это одна admission lock, не новый journal/registry; credential operations
  сохраняют target-local семантику.
- Не удалять чужой/held intent и не возвращать его данные как состояние B.
  Existing 256-file scan bound и exact original identity checks сохраняются.

#### 4. Logout остаётся привязан к выбору в момент действия

Thread `PRRT_kwDORVTEtM622S2H`: logout сейчас ждёт starting/cancel, а затем
`auth.execute` заново захватывает foreground target.

- Захватить target для logout до первого ожидания login cleanup.
- Передать этот же immutable target существующему auth command owner; после
  ожиданий проверить его original current-authority guard до credential effect.
- Смена A→B во время ожидания должна завершить original cleanup и отказать
  устаревшему logout; B не получает `credential.forget`. Normal refresh и
  original-intent lookup сохраняют прежнюю семантику.
- Не добавлять renderer operation selector, RPC, новую очередь или account cache.

#### 5. Private intent storage и platform capabilities

Thread `PRRT_kwDORVTEtM625cCn`: POSIX group/other mode check сейчас применяется
к Windows directory/file. [Node 24.21 file modes](https://nodejs.org/download/release/v24.21.0/docs/api/fs.html#file-modes)
не предоставляют на Windows различие owner/group/others; это не ACL-проверка.

- Применять существующую POSIX privacy проверку только на поддерживающих её ОС;
  продолжать запрашивать 0700/0600 при создании.
- Сохранить directory lstat/realpath/dev/ino fence и bounded exact UTF-8/schema read.
  Для file read добавить same-original-file lstat→open/fstat→read→fstat/lstat
  identity/type/size/mtime сверку, как в existing credential scope. Symlink/replaced
  path не принимается даже там, где O_NOFOLLOW отсутствует.
- В existing contextId validator исправить escaped character class: запрещать
  реальные NUL/CR/LF, сохраняя обычные буквы n/r и цифру 0. Existing original-context
  recovery case уже проверяет этот путь; новый parser/framework не нужен.
- Не добавлять ACL broker, private path в IPC или ослабление POSIX permissions.
  Windows directory получает обычные inherited app userData ACL; mode bits не
  объявляются доказательством этих ACL.
- Threads `PRRT_kwDORVTEtM622S1y` и `PRRT_kwDORVTEtM622S2U`: existing
  Host `codex-login.test.ts` и Main `capturedCodexLogin.safe-e2e.test.ts`
  запускают POSIX shebang TEST child без Windows custody broker. Пометить только
  эти process fixture registrations unsupported на win32. Настоящая Windows
  SDK qualification остаётся отдельной проверкой, skip не считается её PASS.
- Thread `PRRT_kwDORVTEtM622S2Q`: root test/test:ci используют Host dist, но
  чистый local checkout не гарантирует его сборку. Переиспользовать existing
  Host build command как script prerequisite; CI уже строит Host. Не добавлять
  auto-build в test body или новый runner. Root проверяет согласование CI.
- `PRRT_kwDORVTEtM622S2X` уже исправлен: IPC fixture имеет typed handle-only port.
  Повторного source edit для этого замечания нет.

#### 6. Cancel/completion: точная семантика, без ложного успеха

Thread `PRRT_kwDORVTEtM620TQK` требует уточнить формулировку шага B:
completed receipt, сохранённый до cancel fence, остаётся completed. Если первым
сработал original stop fence, поздний complete не меняет эту operation на completed:
подтверждённый close даёт cancelled, неподтверждённый cleanup — held.
Отдельный account readback может показать, что vendor уже сохранил login;
Cancel не откатывает credentials и не вызывает logout. Сам boolean close не
доказывает успешную authentication. Переписывать Host lifecycle ради terminal
названия не требуется.

#### 7. Конечные проверки и review

- Расширить существующий `capturedCodexAuth.test.ts`: fail-once store/restore
  recovery, exact-ID terminal/pre-admission retirement retry и held-A→B refusal.
  Assertions проверяют отсутствие второго start/native effect и сохранение
  original identity. Store roundtrip/foreign-file case переиспользует тот же файл;
  POSIX chmod assertions применяются только там, где mode bits имеют этот смысл.
- Existing Main safe-E2E дополнить одним controlled logout race:
  удержать original cancel response, сменить foreground A→B, отпустить response;
  B не получает logout. Использовать прежние private TEST roots, Host/D fixture
  и cleanup, без нового процесса-сервера или unit-матрицы.
- Проверить чистый test prerequisite, exact-pin Host build/types, только затронутые
  существующие cases, fast lint и source cap. Root запускает required exact-head
  gates; Linux Desktop Start/Copy/Cancel и отдельный vendor-success gate из R5
  остаются обязательными и не подменяются этими controlled cases.

Круг 1, source: каждое замечание сверено с actual call path; 17/34 объединены,
23 уже исправлено, cancel request не превращён в speculative Host rewrite.
Круг 2, failure semantics: отдельно проверены pre-admission retirement без receipt,
held cross-target admission, transient retry и selection change во время await.
Новый store, auth framework, retry timer и широкая unit suite не требуются.
Следующий круг: независимое plan/diff review, затем targeted execution и exact-head CI.
