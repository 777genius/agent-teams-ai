# Цель: завершить Hosted Web Core v1 end-to-end

Актуализировано 2026-08-31. Это текст для постановки цели, а не утверждение, что перечисленные действия уже выполнены. Он заменяет прежнюю последовательность работ и прежний запрет по проценту swap. Разрешение пользователя на точечный доступ к архивам получено; сама настройка ещё не выполнена.

## Результат и границы

Ты главный оркестратор Hosted Web Core v1 в `777genius/agent-teams-ai`. Доведи именно согласованную MVP-версию до полностью проверенного E2E-ready состояния: работоспособный собранный Hosted-стек, закрытые обязательные Core v1 сценарии, независимый финальный review, принятые изменения в ветке PR #252 и актуальные связанные PR.

Не расширяй задачу до полной desktop parity или разработки нового универсального runtime. Источник продуктового scope: `docs/hosted-web-core-v1-scope-lock.md`. Источник разделения релизов: `docs/hosted-v1-runtime-release-topology.md`. Учитывай `docs/hosted-opencode-downstream-policy.md`, активный execution router и его принятые переходы. Старый completion plan используй только в непротиворечащей Core v1 части.

Core v1 включает pairing/auth, зарегистрированные workspaces, создание команды с начальным составом, prepare/launch/observe/stop/restart, задачи/Kanban, сообщения, SSE/reconnect, ограниченные логи/диагностику и минимальные approvals. Review UI, attachments, расширенное управление участниками, hosted terminal, Keycloak, multi-tenant и горизонтальное масштабирование не добавляй. Уже существующий deferred-код и desktop-поведение сохраняй.

Завершение означает `immutable output -> independent review -> adoption -> commit -> push -> exact-head / exact-artifact proof`, а не наличие патчей, зелёных fixture-тестов или отчётов.

## Уже выданные разрешения

1. Разрешено административно добавить контроллеру чтение и evidence-custody доступ только к существующим архивам этой задачи, на которые ссылается её сохранённый ledger. Перед изменением сохрани точную прежнюю конфигурацию, проверь canonical paths и отсутствие выхода через symlink, сохрани denied roots. Добавляй точные необходимые archive roots, не весь диск или чужие проекты. После изменения проверь чтение evidence, неизменность архивов и admission. Не подменяй журнал и не удаляй корректные записи ради зелёного gate. Повторного разрешения на этот конкретный ремонт не нужно.
2. Заполненность swap сама по себе больше НЕ закрывает admissions. Старое правило `swap >50%` отменено. Реальную нехватку памяти, активный swapping, OOM, устойчивое memory pressure и нехватку диска по-прежнему учитывай.
3. Обычные scoped commits/push, hosted workers, focused tests и необходимые переходы к проверкам в новых disposable sandbox/test environments выполняй самостоятельно при выполненных технических предусловиях. Обновляй исполнительные packets штатным review/adoption-путём. Не используй старое `HOLD` как повод бесконечно ждать нового пользовательского approve, но не обходи его изменением флагов или выдуманным acceptance.
4. Это не разрешение трогать реальные пользовательские проекты, чужие процессы/изменения, отключать проверки, сливать Hosted в legacy main/dev или выполнять неоговорённое destructive/production действие.

## Текущая точка, которую нельзя потерять

Перечисленные SHA являются снимком на 31 августа, а не вечной базой. Перед применением сверяй свежие remote heads через `gh` и Git.

- PR #252: `refactor/hosted-web-feature-boundaries`, head `b5a3216dc59aa2a438338c75a8d20b3cae1d1748`. Новый коммит исправляет partial writes и interrupted recovery manifests.
- PR #503: `test/hosted-actual-owner-e2e-r1`, head `5356ea380f2d566c835f04f96770a2d2ab50f210`, base - ветка #252. Сейчас у него 14 собственных коммитов и отсутствует один новый коммит #252. Синхронизируй обе стороны без потерь и force-push.
- Release-lock candidate `4017e1f80e372e40f3084c008e85d2150dcba26c`, ветка `feat/hosted-release-lock-parser-r512`: сохранён и запушен, но review r520 требует исправлений.
- Signed-producer candidate `e911d3772a7225218e205597f09a5e3f2a4f2f6f`, ветка `fix/hosted-signed-producer-review-r519`: сохранён и запушен, но review r522 требует исправления. Эти две checkpoint-ветки НЕ являются принятым кодом #503.
- Orchestrator `777genius/agent_teams_orchestrator`: PR #45 на `fac886d9dd7e85fc3c46c035fb8567446dd8d99f` уже содержит шесть ранее уникальных activation-коммитов #44. Не cherry-pick их повторно. #44 и #45 не мержить в legacy main/dev.
- Owner r423 и release r433 сохранены. r423 требует адаптации к текущему контракту; r433 - составной patch с унаследованными изменениями r423, а не независимый release-only slice. Переиспользуй пригодные части после review, не применяй composite целиком поверх уже принятого кода.
- OpenCode downstream: `777genius/opencode-anomaly`; учитывай PR #1/#2 и отдельную sandbox candidate line #3/#4, не смешивая их eligibility. Upstream-переход отслеживается в `agent-teams-ai#471`.
- По последней принятой записи выполнена source admission, но финальные built-artifact/no-fake E2E и production eligibility не доказаны. Не выдавай ранее пройденные unit/fixture проверки за эту готовность.

Контекст восстановления: `.codex-preserved/hosted-v1-r521-resume.md`, `hosted-r523-readonly-audit.md`, `hosted-r524-blocked-audit.md`. Их исторические требования ждать разрешение на архивы и снижать процент swap отменены этим текстом; остальные доказательства и review findings сохраняются.

## Первые действия и критический путь

1. Сделай один ограниченный recovery pass: свежие heads, task-owned worktrees/jobs обоих хостов, незавершённые generations, сохранённые patches/bundles и controller admission. Восстанови разрешённый доступ к архивам. Старый реестр v126-v141 и принятый P0 evidence переиспользуй; дополни только недоказанные записи. Не запускай весь исторический P0 заново и не перетестируй чужой ReviewRouter.
2. Безопасно включи новый head #252 в чистую integration-ветку #503. Сохрани оба набора изменений; проверь recovery tests нового коммита и затронутые integration gates. Перед новым writer slice зафиксируй обновлённую exact base.
3. Закрой три r520 finding: оба lock-файла в CI path filters; повторная проверка всех lock/legacy entries перед возвратом при гонках создания/замены, включая корректное завершение чтений; строгая SemVer grammar. Добавь детерминированные regression tests, не ослабляя существующую filesystem custody.
4. Закрой r522 finding: настоящие OpenCode session/request identities должны поступать из валидированного источника. Golden capture обязан пройти настоящий native parser до cross-join; убрать обход через null/cast. Не ослаблять identity checks ради теста.
5. Независимо review-нь новые поколения этих двух patches, последовательно прими пригодные результаты, commit/push в #503 и докажи targeted exact-head gates. Старые verdict не переносить автоматически на новые bytes.
6. Доведи cross-repository source integration Product/Owner/OpenCode. Переиспользуй r423/r433 и существующие producers. Закрой несовпадения authenticated handoff, accepted schema, producer roles, descriptor ownership и реального production caller. При уже принятом r409/r431 контракте сохраняй четыре роли и один OpenCode process; изменение этого контракта требует отдельного обоснованного решения, не тихой подмены fixture.
7. После source acceptance последовательно пройди недоказанные стадии: изолированная Hosted-сборка -> проверенные/подписанные артефакты -> точные locks и stack manifest -> input freeze -> sandbox run -> независимое принятие evidence. Используй существующий trust chain; не добавляй вторую систему подписей или новый слой платформы без необходимости.
8. Выполни реальный built-artifact E2E и закрой недостающие Core v1 сценарии и Phase 10. Fake-runtime допустим для быстрых промежуточных тестов, но не для финального proof. Каждый live-run имеет собственную identity и новый test sandbox. После неоднозначного эффекта сначала reconciliation; автоматический повтор запрещён. Новый запуск после доказанного безопасного завершения/исправления оформляй как новую попытку, сохранив прежнюю.
9. После принятого no-fake evidence интегрируй #503 в #252 по разрешённой Hosted topology, проверь итоговый SHA и точную идентичность испытанных артефактов. Не объявляй финальным CI старого head. Любое изменение исполняемых bytes требует новой затронутой проверки.

## Оркестрация без лишнего WIP

Работай через subscription-runtime workers на хостинге, не через локальных сабагентов на Mac. Модель `gpt-5.6-sol`, service tier `fast`: implementation - `medium`; planning, architecture, independent evidence и final review - `xhigh`.

Предпочитай старый сервер при достаточных ресурсах. Проверяй machine-id, доступную память, диск и занятые task slots, а не только alias/load average. Старый: `188.166.24.162`, machine-id `93732118417e46618cefafc022c8b1db`. Новый: `209.38.106.83`, machine-id `be0aad971ea647fab370acd110b469b7`.

До восстановления admission не запускай product writers; безопасный bounded read-only evidence можно выполнять параллельно. После восстановления начинай с одного writer. Второй непересекающийся writer допускается после первого доказанного цикла review/adoption/push/proof; уже имеющееся валидное доказательство этого цикла засчитывается без повторного ритуала. Максимум два product writers, один integration owner; очередь готовых к review outputs не больше двух. Независимые read-only lanes добавляй по реальной необходимости и ёмкости, не ради числа воркеров. Совпадающий subscription account не требует сериализации, если runtime допускает capacity.

Каждому worker дай отдельный job/workspace, exact base, непересекающийся ownership scope, тесты, reviewer, бюджет и rollback. Shared composition, build integration, runtime ownership и adoption сериализуй. Тяжёлые build/typecheck/E2E - максимум один одновременно на физический хост под host-global lock; не создавай обход через второй registry. Два хоста могут выполнять независимые тяжёлые работы, если каждая отдельно допущена и не делит mutable state.

При MemAvailable >=8 GiB допускай heavy jobs; при 4-8 GiB только лёгкую bounded работу; ниже 4 GiB не начинай новые jobs на этом хосте. Устойчивый thrashing/OOM или недостаток места требуют уменьшения параллелизма/переноса на другой хост. Не сбрасывай swap и не чисти системные caches только ради показателя. Освобождай только доказанно task-owned disposable данные/процессы, предварительно сохранив outputs; иначе переключайся на доступное направление.

10 минут без meaningful milestone - повод проверить прогресс, не автоматически убивать работу. Для длительных jobs задавай измеримый budget; по исчерпании сохраняй результат и останавливай только точный owned process group. Перед writer проверяй возможность Git lock. Если sandbox делает `.git` read-only, worker готовит patch/manifest; внешний integration shell выполняет механический commit после проверки, без повторных бесполезных writer launches.

## Сохранность и доставка

- Не меняй грязное локальное дерево пользователя и не смешивай работу с `fix-win-arm64-support`. Работай в чистых изолированных checkout правильных Hosted-веток.
- Для каждого output сохраняй repository, full base SHA, patch SHA-256/bytes, tracked/untracked manifest, generation, owner, tests, verdict и integration SHA. Между хостами передавай Git-состояние через проверенный bundle от общего base; грязный workspace не становится authoritative state.
- Freeze и terminally classify прерванную generation до замены. Сохраняй rejected/superseded/failed outputs, включая failed-no-output receipts v140/v141. Не требуй внедрить все сохранённые строки: пригодность определяет контракт и review.
- Один authoritative ledger с append-only evidence. Target accepted-but-unpushed = 0; каждый принятый slice commit/push до следующей adoption. Preservation-ветки явно отличай от accepted product code.
- Не создавай replacement-stack для существующего большого #252 и не переписывай review history. Новые независимо доставляемые изменения держи bounded, ориентир до 2 000 changed LOC с обоснованными исключениями.
- Не чини ReviewRouter: его ведёт другой агент. Не обходи обязательный check; при внешнем сбое фиксируй blocker и продолжай независимые проверки.
- Не смешивай Hosted runtime с legacy `runtime.lock.json`, desktop artifacts и обычными `v*` release triggers. #44 можно признать superseded только после принятой карты сохранённых инвариантов; owner integration направляй только в согласованную Hosted compatibility line. Сам #252 не мержить в legacy main в рамках этой цели.
- OpenCode оставляй минимальным downstream patch queue. Перед production promotion обязательно закрой актуальный upstream/security drift по принятой policy; фиксированный исторический pin не означает разрешение навсегда отстать от upstream.

## Проверяемый Definition of Done

Поддерживай матрицу всех девяти обязательных Core proof groups: auth/security; lifecycle/process cleanup; durable effects/retry; SSE/restart; tasks/messages; workspace containment; capability degradation; runtime ingress; approvals. Каждая строка связана с текущим требованием scope lock, production-composed кодом и принятым exact-head/exact-artifact evidence. Исторические 9 P1 buckets сопоставь этой матрице без потери требований, а не переименуй в Done.

Готово только когда:

1. Все обязательные Core строки закрыты; нет скрыто вырезанных требований или advertised-but-unimplemented controls.
2. Собранный Compose/Caddy Hosted-стек прошёл реальный browser workflow: pairing/login -> registered workspace -> draft/team -> prepare/launch -> задачи и сообщения -> SSE/reload/reconnect -> approval -> stop -> supported full restart. Отдельные suites не зависят от состояния предыдущих.
3. Для каждого рекламируемого provider пройден предусмотренный sandbox live smoke; сохранены desktop regression/packaging gates и отсутствие скрытого desktop runtime/listener в Hosted.
4. Phase 10 доказана в Core scope: compatibility, bounded benchmark, restart, backup/restore в пустую цель с ротацией authority, chaos, rollback и terminal-absence/process cleanup. Новый recovery fix #252 проверен.
5. Нет unclassified/orphan outputs и accepted-but-unpushed кода. Старые outputs имеют immutable terminal disposition; все принятые изменения присутствуют в соответствующих remote-ветках.
6. Итог #503 включён в ветку #252 без потери новых изменений; связанные Owner/OpenCode PR и артефакты имеют понятные зависимости, сохранённую lineage и безопасный порядок дальнейшего merge/release.
7. Финальный обязательный CI зелёный на итоговом SHA; независимый reviewer принимает точные code/artifact/evidence identities и выдаёт GO без незакрытых release-blocking findings.
8. Есть краткий запускной runbook, точные stack/artifact identities, ограничения поддерживаемого профиля и проверенный rollback. Release/production eligibility не включена раньше положенного evidence.

Внешний blocker не является выполнением цели. Если действительно нужны новые полномочия или внешнее действие, укажи конкретное условие и уже исчерпанные безопасные варианты. Не останавливайся на обычном завершении worker, создании patch, отчёте или устаревшем resource threshold.

Метрика продуктивности: принятые и запушенные slices, закрывающие обязательные пользовательские сценарии с проверяемым evidence. Не число воркеров, строк кода или отчётов. В коротких обновлениях сообщай: что стало доказанно готово, commit/PR, результат проверки и следующий оставшийся барьер.
