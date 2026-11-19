# Завершение Host / frontend parity

Обновлено: 19 ноября 2026. Единственный текущий рабочий план.
**Полная E2E-приёмка остаётся незавершённой.** Этот коммит содержит только два
проверенных исправления типов существующих tests; runtime JavaScript обоих tests
побайтово сохранён. Все5162 production leaves идентичны опубликованному42a4.
Original результаты ниже относятся к `42a4ee210aff6ffa310025d024fd55cfbdbcd277`,
а собственная проверка следующего source остаётся обязательной.

Все четыре исходных frontend safe shards на42a4 завершены: **26410 tests passed,
38 skipped,0failed**;2199 test files passed/7skipped. Повторяемые UI contract suites
к этой сумме не прибавляются. Все пять packaged platform jobs также SUCCESS,
но их receipt/platform qualification и Windows ARM capture gap разделены ниже.
Main Fast feedback остановлен тем же TS2540, а original retained Desktop —
`coordinator-admission / unknown / not-dispatched`; это отдельный незакрытый путь.

Рабочая среда стала unavailable до загрузки остальных подготовленных кандидатов.
В этот коммит они **не входят**. Их точные local-only pins, проверки, оставшиеся
дизайны и запреты повторного чтения CI сохранены в
[записи восстановления](parity-executor-outage-recovery-20261119.json).
Provider `b19494fd` сохраняет ранее подтверждённый canonical PASS; нового provider
source нет. Полный F1/source scope030 остаётся историческим подтверждением.

## Цель, доставка и неизменные границы

Завершить согласованный перенос в изолированный Host с сохранением текущего
Desktop frontend для Claude, Codex, OpenCode V1/V2. Работать автономно,
параллельно по независимым файлам, сразу публиковать готовые коммиты и проверять
затронутые end-to-end пути без повторения неизменённых дорогих матриц.

- App [#1192](https://github.com/777genius/agent-teams-ai/pull/1192) и provider #8
  остаются Draft на исходных bases; маршрут доставки: **#1192 → #1186 → #982**.
  Merge в main, release, включение Host по умолчанию и Stage 2 не разрешены.
  [Решение об отложенном Stage 2](https://github.com/777genius/agent-teams-ai/pull/1105#issuecomment-6771443351).
- Реальные Claude/Codex запрещены, включая version и binary с localhost endpoint.
  Использовать исходные finite protocol peers; OpenCode — только разрешённый
  pinned native/local-model сценарий. Все проверки выполняются в TEST projects.
- Сохранить source/owner/currentness, authority, private snapshots, process custody,
  исходные deadlines, negative oracles и cleanup. UNKNOWN/skip/cancel/queued
  не являются PASS; exit 0 ребёнка не заменяет подтверждённый owner release.
- Root — единственный writer ref/index приложения. Общему файлу назначается один
  владелец; provider имеет отдельный checkout. Сохранять чужие изменения и оба
  родителя при reconciliation; обычный expected-SHA update, без force push.
- Не создавать второй controller, scheduler, auth owner, event bus или ReviewFlow.
  Не менять bundler/plugins или global defaults ради прохождения TEST.

Подробная прежняя хронология сохранена в
[опубликованном журнале 4f5ae2dc](https://github.com/777genius/agent-teams-ai/blob/4f5ae2dcb10c83fb6b3a3862b8d5065e0c7843ab/docs/plans/provider-migration/frontend-parity-2026-11-12/STATUS.md).
Её исторические SHA, оценки LOC и receipts не перепривязываются к новому дереву.

## Живой план: готово / осталось / критерий приёмки

| ID | Состояние | Следующий результат и критерий готовности | Владелец |
| --- | --- | --- | --- |
| F1 | Полный original030 PASS | Final receipt подтверждает Settings/override/inherit/Approved/reopen, ровно3 completed commands и3 холодные owner epochs. Guarded SIGTERM в rollback epoch отдельно от natural exit. Следующая source-композиция требует собственного original gate. | root |
| F2 | Реализация и focused contracts PASS | Сохранить canonical Host agenda: lead/user clarification блокирует review work до review cycle; app path остаётся re-export. Не выдавать UI сохранение lead_then_human за исполненный lead handoff. | reviewflow |
| M1 | Original030 native PASS: Darwin x64/ARM64 и Linux x64 manual; Windows x64/ARM64 manual/automatic | Corrected media-roster verifier прошёл на Darwin/Windows; Darwin job падает отдельно на P09, Linux — на credentials до финального verifier. Сохранить точные receipt/platform scopes; Desktop/vendor auth/release не квалифицированы. | media; R2 reviewflow |
| E1 | Teams GUI3OS, finite Claude/Codex/OpenCode и ряд desktop routes PASS на030; active Quit/Review/Resume, live Add и retained paths INCOMPLETE | Quit11+15, schedule3RED→80PASS, packaged RED→2PASS и solo publication4RED→98PASS подтверждены finite actual-source checks. Native diagnostic capture6PASS улучшает только активированные native fixtures; retained private observer8RED→70PASS сохраняет причину отказа. Original acceptance нового source, неизвестные отказы и cleanup debt остаются открытыми. | root |
| W1 | Windows ARM64 native OpenCode PASS; Host source A/B acceptance открыт | На030 ARM Codex read109 вернулся ready=true после15s; x64 Codex/Claude A/B PASS, OpenCode A/B отказал по expiry. Разные original failures не объединяются; guard timings не дают разрешения ослаблять cutoff. Packaged Darwin require defect исправлен в отдельном TEST fixture follow-up, его native qualification ещё требуется. | root; media |
| P09 | Открыто: решение о контракте | Установить выполнимую границу original pathname / разрешённый writer / consumed bytes; до отдельного решения не сужать гарантию и не менять failed oracle. | root |
| D1 | Полный canonical workspace typecheck + feature tsc и original typed lint PASS на030; Frontend shard1 FAIL на schedule race | Для новой композиции нужны её original gates и обязательные platform checks; F1 на030 завершён. Локальные80 schedule tests не заменяют полный shard. D1 подтверждён отдельным Host Desktop linux-x64/team; Main merge сохраняет собственный Node26/merge provenance. | root |

Уже реализованы базовый Host/Session SPI, embedded V2 2.1.4,
Logs/Thinking/source/filter/fullscreen/stderr, accounts/models, native suggestions,
schedules, live membership и retained launch. Повторная разработка не требуется;
приёмка текущего интеграционного пути остаётся отдельной обязанностью.

## Завершено: узкие provider imports и запуск Main

Срез опубликован в f60dcc10; original GUI с профилем 1536 прошёл Main/preload,
renderer/Main readiness, backend discovery и первые два UI proofs:

1. Provider `./captured-configuration`: ровно четыре уже публичные capture-функции
   напрямую из определяющих модулей, без общего internal/provider barrel.
2. Отдельный `./codex-mcp-catalog`: тот же `readCodexConfiguredMcpCatalog` и уже
   публичный тип каталога, без wrapper. Reader не чистый при вызове: сохраняет
   caller-owned launch/dispose, captured HOME/CODEX_HOME, canRead/abort, фактический
   terminal, 1 MiB и исходные timeout/cleanup проверки; import сам не запускает IO.
3. Host: только value imports в runtimeProfile, runtimeExtraArgs,
   capturedRuntimeMcpRecipes и readCodexMcpCatalog; тела и type-only imports прежние.
4. Existing packed consumer: fresh process с SDK-denying resolve/load hooks и
   negative control, закрытые export sets, пять прежних binding identities,
   type consumer, bounded fake metadata port и отказ canRead до launch.

**R2 и canonical provider check PASS**, exit 0 за 143.529 s: оба builds/types,
577/577 source tests и оба packed consumers 1/1, включая SDK refusal и пять
binding identities. TEST environment исправлен на HOME + CODEX_HOME до запуска.
Сразу опубликован provider `b19494fd2de47538a1c9315e338199ff41bbe497`,
tree `43c3778781815b87269056d3a6ceafb16cb28f08`. Exact tested archive — 191145 bytes,
SHA256 `ad05bd8c799c4d2c366a6eab72f937466355a5994eac6bd201ee754217cf5aa7`.
Все прежние 252 compiled outputs и SPI archive побайтово сохранены; добавлены
только четыре facade JS/d.ts и package exports. App принял implementation pin
`captured-config-b19494fd`; SPI остаётся на прежнем aad-каталоге.
Штатный `pnpm install --frozen-lockfile --ignore-scripts --prefer-offline`
PASS за 20.415 s, проверены 2533 supply-chain entries. Strict Host TS7 build
с `--singleThreaded`, compiler-only 512MiB/50/2 PASS за 10.431 s;
source receipt записан. Main SSR на исходном профиле 1536/maps-off собрал
3712 modules за 28.54 s; preload — 117 modules за 200 ms. При 1024 память
заканчивалась уже после transform. Итог UI имеет отдельный scope ниже.

Независимый static audit 4f5: 3816 app files, 99 value-imported Host public subpaths,
334 compiled Host modules; все шесть provider-barrel рёбер находились в этих
четырёх Host-файлах. `/owned-process` имеет 104 local modules. Прямые MCP SDK
Server/StreamableHTTP/request-schema imports у OpenCodeCoordinationEndpoint
остаются необходимыми protocol imports. Устранение всех SDK не заявляется.

## История F1 до успешного original030

На exact f60 source `taskBoardUiProof=PASS`, `taskReviewCycleUiProof=PASS`.
Taskboard прошёл create/dependency/association/assignee/clarification/order,
blocked-start и последующий success, reload и attachments. Review cycle прошёл
исходные девять состояний complete→request→request_changes→start→comment→complete→
request→approve→disapprove, итог completed/none в Done. R2 связал source hashes
всех трёх UI proofs с опубликованными Git objects. Отдельно осмотрены семь
сохранённых screenshots: нужные task/review состояния читаемы. У initial ещё
loading skeleton; blocked-start показывает временный mutation-boundary warning,
исчезнувший после reload. Visual review сохраняет эти оговорки, не меняя verdict.

ReviewFlow открыл policy panel одним trusted click и прочитал inherited
agent_approval. Следующая ссылка `open existing default settings link` активна,
но ниже clip: matches=1, centerInViewport=false, hitPresent=false. Исходные 30 s
истекли после 152 owner checks/read evaluations; settings mutation ещё не было.
Скриншот подтверждает штатный scrollable popover высотой около 384 px.
Для четырёх существующих footer actions используется готовый ui.click
scrollBeforeClick с requireCenterHit: общий прежний 30 s и максимум 12 wheels,
проверки owner/deadline/hit и один click сохраняются. Product layout не меняется.
Следующий original GUI должен подтвердить полный ReviewFlow и три owner epochs.
Изменён только TEST helper: три строки delegate и четыре footer call sites;
pinned Node 24.21 syntax check, diff check и independent actual-diff R2 PASS.
Файл уже включён в исходный source-freeze roster; product/build/deps прежние.
[Производная сводка исходного f60 GUI](evidence/gui-taskboard-f60dcc10-fixed1536-20261118.json)
связывает source, 22 command receipts и 10 screenshots с hashes. Это bounded
summary общего INCOMPLETE, не полный receipt и не новый общий PASS.


**Повтор на 823ef00a:** Main/preload/renderer готовы, Taskboard PASS. Review cycle
успел сохранить Approve receipt и Approved screenshot, затем original Page.reload
на 235.474 s не завершился до исходного CDP Runtime.evaluate timeout. Новый footer
helper не вызывался, ReviewFlow proof/settings mutation отсутствуют. Позже log
зафиксировал renderer `killed 9` и recovery navigation на 300.414 s; отправитель
сигнала и OOM не установлены. `lastCheckAt` записан перед synchronous owner census,
поэтому он не доказывает точное время отправки зависшего CDP request.
Wrapper exit 1 за 318.542 s; Quit unconfirmed. Fallback cleanup подтвердил
capturedHostObserved=true, capturedHostAbsent=true, remaining=[]; app SIGTERM,
source freeze/cleanup без ошибок. Исходный renderer исчез до fallback cleanup;
сам cleanup не объясняет его kill. Failure screenshot показывает recovery splash.
[Производная сводка 823 GUI](evidence/gui-taskboard-823ef00a-fixed1536-20261118.json)
сохраняет hashes и границы наблюдения. Full E2E остаётся INCOMPLETE.

На 823 passive peak total PSS 3612806 KiB; Vite 1689258 KiB / 23 threads,
original renderer 1544628 KiB / 23 threads. В доступных diagnostic events нет
Runtime.exceptionThrown; фильтры console/log не позволяют исключить все warnings
или busy loop. Между f60 и 823 из 1883 source pins изменился только footer helper,
до которого последний прогон не дошёл. Следующая проверка меняет только finite
app resource context на 1536 + UV4; это эксперимент, не доказанное исправление kill.

## Подтверждённая реализация и границы результатов

| Срез | Что завершено | Проверено; чего результат не доказывает |
| --- | --- | --- |
| F1 authority/defaults | Human grant отделён от переданного имени; current review request/cycle fenced. Defaults из trusted Main входят в snapshot/preimage и recheck до publish; task write allowlist не расширен, defaults не копируются в override. | ReviewFlow/lead 56, controller 46, history 3, clarification/status 7 PASS в своих исходных runs; не current GUI. |
| F1 ACK recovery | Structured code вместо reason; original command lookup также при structured outcome=unknown, frozen handle, без повторной mutation; неизвестный lookup сохраняет unknown. | Renderer routing 10/10, Host integration 7/7, UI Section 12/12, store 9/9 PASS; UI journey добавлен и прошёл R2, исполненный GUI ещё отсутствует. |
| F2 agenda | Canonical Host owner; clarification блокирует review до cycle; старый app path re-export. | Agenda 26/26 и cycle 3/3 PASS. |
| E1/W1 readiness | Configured key вычисляется внутри исходного capture callback до closing fence; account/policy/target checks сохранены. | Configuration + saved-model 36/36, finite status 2/2 PASS; нового Windows native PASS нет. |
| Installer | Failed Host acceptance не делает новый candidate ready в следующем warm/cold getStatus; сохраняется принятая версия. | 34/34 PASS, source не менялся; не Darwin installer GUI. |
| E1 startup | Inventory batch 12 полностью settles; per-file identity/hash/mode, symlink/count/unlisted/abort/closing checks сохранены. Удалены только доказанные sync duplicate guards; cache/TTL не добавлены. | Graph 12/12; authority/native-action 20/20; revoked observer 1/1 PASS. Darwin original startup qualification остаётся. |
| E1 failed open/diagnostics | При окончательно потерянной allocation missing receipt идёт в прежний disposal; transient допустим только при действующей authority. Passive diagnostics не читают тела/секреты и не заменяют verdict. | Member 8/8; diagnostic suite 5/5 + scoped strict TS PASS. Ранние UNKNOWN receipts остаются UNKNOWN. |
| CI/Unicode fixture | Ready job использует finite Claude/Codex peers и исходные UI/cron/no-replay oracles; ASCII batch сохраняет Unicode пути через captured env/%~dp0. | Workflow policy 17/17; launcher 5/5 PASS; обязательные CI/platform gates не заменены. |
| Main readiness imports | readProfile берёт тот же schema напрямую; public /team-host/readiness содержит только три старых named values. Type-only imports/guards прежние; новые source pins сохранены. | Strict Host build PASS 10.318 s; scoped NodeNext consumer TS7 PASS 0.867 s. Не полный workspace и не memory/OOM proof. |

### E1/D1: 22-file composition и доказательства

- Incoming d6 на exact c8 parent и отдельные resource изменения сохранены вместе;
  все 22 pre/post SHA1/SHA256 совпали. HTTP-only entrypoint разрывает store cycle;
  strict Kanban read предшествует прежнему policy lookup, оба reads сохранены.
- Retained TEST authority связана с exact owner/profile; finite metadata/status
  имеют production shape. Trusted UI geometry сохраняет 30 s, 16 samples,
  owner/deadline checks, один hover/press/release и 12 wheel events без replay.
- **611 frontend/IPC PASS в 20 файлах по отдельным immutable-base scoped runs** —
  не единый aggregate/full-suite/native PASS. Attachment 15, Kanban 2,
  Host ReviewFlow 10 и name-filtered cases имеют собственные отдельные scopes.
- Actual boundary matrix 90/90, fast lint четырёх boundary files и translation-only
  TS7 PASS. Source-size evaluator c8+22: 5161 production paths, 141 frozen
  exceptions, limit 800, zero violations; policy/baseline не ослаблены.
- Combined 17-file lint SIGKILL (-9) и combined test/translation TS timeout 45 s —
  INCOMPLETE. Historical missing snapshots/logs не реконструированы.
- [Report 90](90-original-9a8-failure-followup-2026-11-18.md),
  [source manifest](evidence/parity-followup-source-manifest-20261118.json),
  [finite witness](evidence/parity-followup-finite-checks-20261118.json) и
  [evidence index](evidence/head9a8-followups-20261118.json) сохраняют точный scope.

## M1: source-scoped native PASS и media contract

**PASS на `2f33d5668944ef6804557690b20ce51b70245aab`, Linux x64 / OpenCode 2.1.4:**
исходный E2E 1/1, все восемь original steps за 151754 ms, cleanup=true.
Coordination: четыре model requests + одна metadata, неизменённый receipt.
Business: ровно 11 requests, modelFailures=[], две once approvals, эффекты ONE/TWO,
completed task/comment и два replies. Оба Host exit 0 / stdoutValid=true;
исходный и cold-restored Stop подтверждают custody=released.

PNG/JPEG/GIF/WebP и PDF 589 bytes доставлены точно. Исходный PNG 4 MiB нормализован
до 159 bytes / 2000×1 с exact red pixels. Public readback шести исходных attachments
побайтово совпал. Cold restore дал новую generation/nativeReady=true, сохранил
11 requests и эффекты; lookup/replay двух command IDs вернули прежние receipts.
Source, compiled inputs и provider archive сохранялись на протяжении проверки;
независимый R2 проверил final verdict, восемь assertions и шесть pinned digests.

- [Полный исходный receipt](evidence/native-opencode-v2-media-2f33d566-20261118.json):
  SHA256 `423c4aa672793dc191d5a342e376aa1512d11f189b2b2047facd3dd150ae08f5`.
- [Исходный terminal log](evidence/native-opencode-v2-media-2f33d566-20261118-terminal.json):
  SHA256 `f6af0041569fce0993fba9f30307ada02f86ce6a0fd9dbad1776b25c174a1a45`;
  JSON хранит original UTF-8 bytes/hash и допускает точное восстановление.
- Receipt остаётся на 2f33; новый source/package не получает его PASS автоматически.
  vendorAuthQualified/desktopQualified/releaseQualified=false. Saturated passive
  trace не служит доказательством cold restore/позднего cleanup; причина e114 pause
  этим последующим PASS не установлена.

Media: максимум 5 файлов, 4 MiB/source, 8 MiB/source total; PDF только при model modality
и exact bytes; video не рекламируется, unsupported media не становится reference.
Authenticated private receipt связывает source/normalized digest, session/input,
child generation и deadline. Cold checkpoint сохраняет session/media revision;
повторная аттестация всех старых ACK после restart не заявляется.
TEST parser допускает исходный 384 KiB chunk только для exact pending attachment read
с canonical base64/closed envelope/offset/digest; прочие frames и stripped envelope
сохраняют 256 KiB, абсолютный Host frame 1 MiB. Product/raw budgets не увеличены.

## Original GUI: история прежних незавершённых запусков

Все запуски пока **INCOMPLETE** и без финальных owner epochs. Два последних
прогона с original 1536 дошли до реального UI; меньшие heaps завершались до него. Cleanup.remaining пуст;
исходный startup 180 s не увеличивался.

| Source / профиль | Фактический результат Main SSR | Наблюдение |
| --- | --- | --- |
| 19b5bf34 / default | SIGKILL, около 60 s | Telemetry отсутствует; OOM не доказан. |
| e114dd13 / 1536, maps on | SIGKILL, 15.1 s | Vite RSS 448868 KiB; sender неизвестен. |
| e114dd13 / 1536, maps off | SIGKILL, 47.316 s | Total PSS 1266242 KiB; OOM не доказан. |
| c8ab4139 / 1536, maps off | SIGKILL, 16.3 s wrapper | Harness PSS 264450 KiB после schema import fix; причина сигнала неизвестна. |
| 356fe604 / 512 + UV4 | Explicit V8 OOM/SIGABRT, 27.214 s | Retained heap 509.9 MB; Vite 11 threads. |
| 9f63bec3 / 768 + UV4 | Explicit V8 OOM/SIGABRT, 24.241 s | Retained heap 760.4 MB; Vite 11 threads. |
| **4f5ae2dc / 1024 + UV4, maps off** | **Explicit V8 OOM/SIGABRT, 30.248 s** | Retained heap 1010.7 MB; Vite PSS 1205049 / total 1786707 KiB; source freeze/cleanup без ошибок. |
| f60dcc10 / 1024 + UV4, maps off | 3712 modules transformed, затем explicit OOM/SIGABRT; 53.099 s | Retained heap 996.2 MB; Vite PSS 1197674 / total 1757584 KiB. |
| **f60dcc10 / original 1536, maps off** | **Main/preload/renderer PASS; Taskboard + review cycle PASS; ReviewFlow link offscreen** | Wrapper 334.508 s, exit 1; failure Quit acknowledged, listener absent, appExit 0; capturedHostObserved=false, отдельный Host exit не заявляется. |
| **823ef00a / original 1536, maps off** | **Main/preload/renderer и Taskboard PASS; reload после Approved INCOMPLETE** | Wrapper 318.542 s, exit 1; CDP Runtime.evaluate timeout, позднее renderer killed 9. Quit unconfirmed; fallback подтвердил Host absent и remaining=[]; новый footer не исполнен. |

Действующий experimental selector — `LEGACY_DESKTOP_TEST_FINITE_HEAP_1536_UV4=1`
для прежних семи Linux/x64 finite emulated modes: exact Node heap 1536 и UV pool 4.
Retired 512/768/1024, произвольные flags, malformed/two selectors отвергаются;
exact Node/UV проверяются до/после normalizer. UV4 выбирается по явному selector,
а не по Node option, который теперь совпадает с original 1536. Оба новых test
blocks актуализированы, восемь original blocks сохранены. Focused **10/10 PASS**,
zero skips, 1550.741 ms; independent actual-diff R2 PASS. Log SHA256
`1af0934696abe38fc8276dd0bb23108eda7aa9cd8f9cd6f73434f06601bca4ab`.
Original 1536/default/native, parent heap, команды/plugins и deadlines сохранены.
Профиль действует на TEST app-chain, включая Electron Main; Host closed env
не наследует NODE_OPTIONS/UV. UV4 ограничивает libuv/Rollup concurrency, не задаёт
Chromium threads и не гарантирует меньший retained graph. Пассивный observer
добавляет только CPU ticks из уже читаемого bounded /proc/PID/stat; прежние
cadence/limits/identity guards сохранены. До завершения нового original run
профиль не считается решением renderer failure.
Maps-off меняет debug artifacts main/renderer, не preload; byte-identical
build/Sentry qualification не заявлены. Explicit OOM меньших heaps не
устанавливает причину остальных SIGKILL.

## Оставшиеся обязательные gates и минимальная очередь

1. Original030 F1 завершён: footer исполнялся, final receipt и все три холодные
   epochs PASS. Provider archive/install/Host build не повторять без причины.
2. Композиция25source paths опубликована как42a4 после завершения полезных
   original jobs030. Подготовлены два type-only исправления: generic arguments в
   тесте загрузчика и mutable exitCode у локального synthetic child в solo test. Публиковать только после свежей проверки отсутствия полезных
   executing/live-assigned jobs42a4; каждый commit сразу expected-SHA push.
   Сохранить Draft/base и все ранее опубликованные source/proof leaves.
3. Новые original CI должны проверить конкретные исправленные boundaries:
   active Quit, scheduler metadata, packaged loader и original solo producer.
   Selection/import/collaboration/taskboard и finite provider conversations уже
   имеют отдельные PASS030; их данные не перепривязываются к новому source.
4. Review, первая Resume epoch, native live Add, retained-original preparation
   и retained V1 relaunch требуют доказанной причины и original приёмки.
   Не увеличивать deadlines и не принимать поздний snapshot за готовность до cutoff.
5. W1: original 823 Windows ARM64 source-A Codex получил nativeReady=true на
   109-м read за 15298.7404 ms; post-await assertion исходных 15000 ms отказал
   до принятия true. allocated/sealed=false совместимо с готовым active Runtime.
   OpenCode-only factory fix не исполняется в этой Codex ветви. Причинный вклад
   отдельных guards не измерен; deadline и все шесть probes сохранены. Нужны
   current ARM64 и Windows same-Main recovery на обеих архитектурах по Report 30.
6. На030 original Host Desktop linux-x64/team завершил полный canonical workspace
   typecheck (12 invocations), отдельный agent-backend tsc и все исходные typed lint
   scopes с0errors. Это закрывает полный typecheck/typed-lint scope D1 именно для030; следующая source-композиция
   требует собственного original gate. Старые локальные SIGKILL/exit137 остаются
   историческими отказами и не меняются на PASS; нового локального heavy retry нет.
7. P09: прежний contract original path/argv/env/cwd/resources и защита от writer
   пока не доказаны для исходных Darwin adversarial cases. Направления A/B из
   Report 40 не выбраны. Не вводить silent copy, запрет scripts, новый permission
   policy или доверие writer без отдельного решения; независимые работы продолжаются.

Проверки выполнять по очереди без конкурирующих GUI/native/build процессов и
изменения frozen source/deps. Source R2 не равен native PASS; повторять только
затронутые сценарии и конкретные оставшиеся risks, сохраняя required CI gates.

## CI snapshot, исходные receipts и решения

Снимок GitHub на 823ef00a: **43 review threads resolved**, новых open findings нет.
Последующие original results 823: frontend shard 4/4 — 549 PASS / 2 SKIP files,
6790 PASS / 7 SKIP tests, 0 FAIL; Teams Ubuntu и macOS — SUCCESS. Skills и
Codex-login GUI jobs также SUCCESS. Это их исходные scopes, не весь frontend
или новый source. Windows x64 manual и automatic native cases прошли каждый
1/1; итоговый job FAILURE из-за устаревшего точного CI roster после native PASS.
Проверка нового roster на двух неизменённых receipts описана ниже; исходный
GitHub conclusion не переписывается. Host Windows ARM64 отказал в ожидании
original source Team readiness: nativeReady=true вернулся за 15.2987404 s, после
исходного 15 s deadline. allocated/sealed=false означает допустимый active Runtime,
а не незавершённый seal. Codex не проходит изменённую OpenCode-only ветвь factory;
этот fix не заявляется исправлением W1. Все original endpoints до 547 включительно
сохранены и выведены из повторного опроса; текущий 030 отслеживается отдельно. Повторные workflows не
запрашиваются; cancelled/skipped/queued и отдельные PASS не квалифицируют весь срез.

| Исторический source 9a8d7ffd | Результат и исходный run |
| --- | --- |
| Frontend | Все четыре shards SUCCESS, только исходный scope. |
| Packaged | Пять platform jobs SUCCESS; [44314176630](https://github.com/777genius/agent-teams-ai/actions/runs/44314176630), aggregate отдельно. |
| Process | Linux/Darwin x64/ARM64 SUCCESS, Windows x64/ARM64 FAILURE; [44314176538](https://github.com/777genius/agent-teams-ai/actions/runs/44314176538). |
| V2/SPI/static | Семь SUCCESS, обе Darwin mutation lanes FAILURE; [44314176336](https://github.com/777genius/agent-teams-ai/actions/runs/44314176336). |
| Host Desktop | Реальные failures, full E2E не принят; [44314176310](https://github.com/777genius/agent-teams-ai/actions/runs/44314176310). |

Подробные контракты и оставшиеся критерии:
[Report 29: acceptance/custody](29-reconciled-acceptance-and-custody-followups-2026-11-15.md),
[Report 30: Windows same-Main retry](30-windows-same-main-retry-integration-2026-11-15.md),
[Report 40: P09 writer decision](40-p09-source-writer-decision-2026-11-16.md),
[Report 90: source/evidence follow-up](90-original-9a8-failure-followup-2026-11-18.md).
Registration/settlement замечания #1188 и token identity #1227 уже исправлены;
повторно в backlog не включать. Все historical evidence остаются по своим SHA.

## E1/D1 follow-up: native Restart, feature lint и receipt roster

- Устранён вложенный захват одной authority-блокировки через разные Team и
  launch store instances при consumption model readiness. Исправление ограничено
  provider factory: существующий небатчированный inspector сохраняет полную
  authority/assertAllocation проверку; исходные Team/owner pointers проверяются
  до и после неё. R2 подтвердил read/control во всех ветвях, account/source,
  completion/retirement, expiry, equality и final-authority guards. Preclaim
  batching, правила блокировок, deadlines и test oracle сохранены.
- Неизменённый исходный cross-provider callback: RED на 9f, GREEN на 9f+factory;
  три существующих negative cases на exact 4f+factory: 3 PASS /0 FAIL /0 SKIP.
  Первый отказ изоляции из-за отсутствующего prepared policy asset сохранён
  отдельно; после восстановления одного ранее закреплённого JS asset исходный
  отказ воспроизведён. Пассивная встроенная диагностика установила reference
  inspector boundary до account capture/probe expiry при consumer cutoff margin
  71659 ms. Это finite actual TS source, ControlledSession/probe doubles,
  временная файловая система и loopback MCP; native/compiled/GUI qualification
  и performance-вывод этим результатом не заявляются.
- Type-only ReviewFlowElectronApi импорт теперь проходит через существующий
  public contracts barrel; два других lint-изменения сортируют renderer exports
  и member-work-sync imports. Scoped checks на 9f: actual fast config —
  2 errors → 0 errors/0 warnings; actual architecture rule — private leaf
  refused → public barrel accepted. Unchanged preimages/rules приняты на 4f,
  затем исходные изменения сохранены при f60 и 547 adoption; нового lint run нет.
- Actual complete size evaluator на f60+4 (historical execution): 5162 production paths, 141 frozen,
  800 limit, 0 violations. Изменённые production LOC: 116→116,42→42,186→186,
  factory367→371; frozen/coordinator/readiness bodies сохранены. При 823/547
  adoption прежние source tuples сохранены, кроме внешних bounded TEST helpers:
  ReviewFlow223→226, observations720→720, finite-node-options84→85. Новый
  workflow diff630→631; новый полный evaluator run не заявляется. Historical
  22 postimages — 21 exact и один supplementary roster с внешним новым pin.
- Новый f60 provider archive сохраняется целиком. Его entrypoints и смена
  dependency — отдельная область qualification; результаты 9f/4f не
  переименовываются в новый native/GUI PASS. Полные snapshots, хеши, R2,
  retained isolation refusal, passive diagnostic и current adoption:
  [restart/lint evidence index](evidence/parity-restart-lint-followup-20261118.json).

- Original Windows x64 verifier после native PASS ожидал старый шестишаговый
  roster. Добавлен ровно один уже безусловно записываемый producer marker всех
  image MIME/PDF/4 MiB normalization, между PNG и checkpoint. Остальные bytes
  workflow, producer, runtime/approval/currentness/cleanup assertions сохранены.
  Один finite запуск фактического inline verifier: исходный RED воспроизведён;
  GREEN полностью проверил оба original 823 manual/auto receipts; три negative
  варианта missing/extra/reordered steps отвергнуты. Node24.22.3/Linux VM с явно
  заданным Windows context и read-only receipt port — не новый native/GUI/CI run.
  Исходный artifact ZIP сохранён с API SHA256 для последующей проверки; новый
  CI gate остаётся отдельным. Все post-roster qualification и shell assertions
  выполнены на обоих исходных receipts.

## Original 030: подтверждённые отдельные scopes и сохранённые отказы

- Host Darwin x64, original job `135167669442`: SUCCESS на exact 030. Node Host
  contracts: 190 PASS / 2 SKIP; broker: 63 PASS в четырёх файлах; retained Main:
  128 PASS в девяти; POSIX Node/shell lifecycle: 29 PASS / 0 SKIP. Исходные
  source-before/after assertions прошли. Provider source-A/B gates на Darwin
  пропущены; native provider, Desktop, executable admission и release этим job
  не квалифицированы. Negative custody cases сохраняют собственные отказы,
  blanket cleanup/handle-absence PASS не заявляется.
- Teams Windows, original job `135167670062`: SUCCESS; 28 census/teardown tests
  и полный исходный Create/Back/tab/process-restart/Copy/Launch flow. Подтверждены
  retained draft, provider navigation, advanced CLI/native overrides, config-only
  rejection, template/organization, schedule create/delete и zh-TW native TaskTab.
  Windows cleanup: три завершения по 17 captured process identities, точное
  отсутствие процессов/CDP ports, taskkill exit0 и temporary profile removed.
  processGroupAbsent=null не переименовывается в POSIX qualification.
- Восемь из 40 исходных Windows PNG осмотрены: Create/edited/restarted,
  localized TaskTab, dark/light, CSS200/nativeElectron200. Исходный artifact result
  точно совпадает с final log object; ZIP SHA совпадает с original upload log.
  При CSS200 видны горизонтальная прокрутка/выход контента вправо; native200
  сохраняет split pane с узким scrollable editor и обрезанной подписью template.
  Исходные Rendered flags не являются полной responsive/usability qualification;
  по этим кадрам отдельная новая регрессия не установлена.
- Native Quit Darwin ARM64, original job `135167683004`: FAILURE до intended
  guarded active Quit. Main/native setup готовы; два исходных Send зафиксированы.
  Первый отказ — строгий `files()` при чтении commands: три regular entries,
  два допустимых JSON names. Имя третьего файла исходный diagnostic не сохранил.
  После отказа guarded failure Quit acknowledged, app exit0, remaining=[],
  captured Host absent; это не PASS исходного active Quit/cold readback.
- Actual source связывает writer с Team authority fence и атомарным
  `.tmp.<uuid>` в той же commands directory. Незаблокированный async scanner
  может пересечь это промежуточное состояние. Такая гонка установлена по коду;
  фактическое имя третьего файла в original failed run остаётся неизвестным.
  Live snapshot исправлен в кандидате под тем же fence:11 Node regression cases
  и15 finite source checks PASS, включая исходный RED. Intended native Quit
  ещё требует original приёмки нового source; failure cleanup не заменяет её.

Teams workflow завершён SUCCESS на трёх OS и навсегда выведен из наблюдения
после одного terminal capture. Host workflow завершён FAILURE:22successful useful jobs,7failed useful jobs и
failed aggregate;30terminal jobs,29artifact metadata records сохранены однократно.
Все его endpoints выведены из наблюдения. Exact-head full D1
завершён SUCCESS в Host Desktop `linux-x64, team`, job135167682454:
полный canonical workspace typecheck, дополнительный feature tsc и исходные typed lint
scopes. Step12 исполнялся23:21:20–23:35:12 UTC; main/preload/shared/types0errors/3361warnings,
renderer0/1464, features0/1554, MCP0/4. Fast prefix0/14 — отдельный scope.
Team UI/source/receipt/cleanup verifier также SUCCESS. Full F1 завершён SUCCESS в
`linux-x64, cross-team`, original job135167682430: полный final receipt и все три
owner-routing epochs проверены после завершения. Scope и guarded rollback exit
описаны ниже; ordinary Team UI сам по себе этого не доказывает. Main CI
использует merge commit, и его результат сохраняет собственный source provenance.
Root проверил immutable merge `e1cd736d`: его tree точно равен tree 030. Поэтому
отдельный Linux tooling PASS связывается с теми же bytes: восемь noEmit configs,
25 tests и scoped Linux lint (0 errors / 72 warnings). Исполнялся Node26.12.1
с предупреждением о требуемом Node24; это не полный D1 и не Node24 runtime gate.


## Follow-up: четыре исправления и два диагностических дополнения

Независимый source review завершён для четырёх исправлений и двух diagnostic captures. Source/owner fences,
исходные deadlines, строгие negative oracles и состав workflow не ослаблены.
Подробные hashes, исходные failures и finite results собраны в
[индексе follow-up](parity-030-followup-index-20261119.json).

1. **Quit:** live polling теперь получает existing Team authority lock с
   `acquireTimeoutMs=0`, читает directory и все JSON под одним fence и всегда
   освобождает его. Busy writer оставляет ожидание в прежнем20s/100ms poll.
   Неизвестные файлы, stale temp, symlink/directory, malformed/non-object JSON
   и превышение256 по-прежнему дают отказ. Original strict quiescent snapshots
   не изменены. Три изменённых scheduler production paths дополнительно включены
   в существующий finite source freeze; прежние pins сохранены. Existing Node suite подключает новый regression test; его11 cases
   PASS, отдельная actual-source проверка дала15 PASS, включая RED→GREEN против
   настоящего atomic writer. Scoped fast lint0errors/0warnings. Это Linux finite
   witness с Worker/shared PID, не отдельный Darwin native Quit PASS.
2. **Schedules:** исходный frontend shard1 на030 дал550PASS/1FAIL файлов,
   6349PASS/1FAIL/6SKIP tests. Единственный отказ — после actual cron, pause и
   restart persisted status стал active. Фоновый finalizer читал запись до
   metadata queue, а затем сохранял её целиком поверх уже committed pause/edit.
   Новый обязательный `ScheduleRepository.updateSchedule` читает, выполняет
   синхронный updater и пишет под существующей queue. Три background операции
   timestamps/reset/increment используют этот порт. Missing/deleted row остаётся
   отсутствующей; смена ID, ошибка callback/I/O отвергаются, queue восстанавливается.
   Старый код провалил три детерминированные interleavings; кандидат прошёл80/80
   tests в четырёх файлах, включая8 новых concurrency cases. Пауза и редактирование
   проверяются после настоящего stop/start; provider execution запрещён TEST port.
   R2 PASS. Production LOC: Scheduler847→836 при прежнем frozen cap847,
   repository219→236, interface24→26; policy/baseline не изменены.
   Final new test fast lint0/0; inherited7errors в старом SchedulerService.test.ts
   и2warnings в неизменённом dispatch body сохраняются. Global lint/typecheck PASS
   из этого результата не следует; original Host cron/restart ждёт нового CI source.
3. **Packaged attachments:** TEST harness может находиться вне captured Host.
   `startHost` создаёт lazy `createRequire` от уже выбранного абсолютного Host entry;
   один loader обслуживает request schema и large response. Standalone helper
   остаётся lazy; manifest/hash/path/source-hidden assertions, schema/digest/offset/
   size guards сохранены. Original030 source воспроизвёл MODULE_NOT_FOUND; кандидат
   дал2/2 PASS: relocation regression и прежний strict-frame test. Negative cases
   включают foreign metadata, oversize, wrong digest, invalid request и отсутствие
   captured contract без checkout fallback. Это actual fixture/Node resolution
   с in-memory transport и pinned pure schemas, без запуска Host/native/app/build.
   Root R2 PASS; packaged native journey ещё требует original CI.

4. **Owned solo publication.** Original finite Create producer976 ожидал90s
   `launch-state.json` version2 с publicationRunId/leadSessionId и не дошёл до import.
   Исходный Main factory безусловно отвергал Create (`isLaunch=false`) и empty roster.
   Принят ранее сохранённый, но не опубликованный workspace-кандидат; внешние файлы
   не изменялись. Допуск ограничен captured POSIX Anthropic solo child с исходной
   birth identity, тем же run/session, строго пустыми rosters, tracked run и текущим
   publication/Stop epoch. Finished phase сохраняется; rejected facade
   readMembersMeta Promise не становится пустым roster. Прежний canonical reader
   сохраняет null→[] для absent/malformed/timeout metadata; новая строгая проверка
   этого reader не заявляется. В полном final artifact976 root members.meta.json
   имеет35bytes и {version:1,members:[]}; это поздний retained snapshot, не атомарный
   срез момента отказа. [Уточнение metadata scope](parity-solo-metadata-scope-clarification-20261119.json)
   ограничивает соответствующие широкие фразы исторических reviews. Очереди,
   beforeCommit guards и rollback прежние.
   Четыре семантических RED assertions на original bodies; затем98/98 PASS в четырёх
   связанных suites,0skip. Начальный missing runtime.lock harness error сохранён
   отдельно и исправлен immutable030 файлом. Fast lint8paths0errors/0warnings,
   independent R2 PASS; POSIX custody tests явно ограничены соответствующей платформой.
   In-memory custody/real filesystem proof не квалифицирует native GUI и отдельный
   orphan cleanup отказ original976.
5. **Native passive diagnostics.** Подписка на уже существующий producer channel
   `driver-close-failed` сохраняет только закрытые stage/outcome и opaque binding.
   First-event reserve, прежние row/byte caps, own-data projection и отказ malformed
   payloads проверены actual-source RED→6PASS. Runtime/provider cleanup и verdict
   не меняются. Observer действует только в уже активирующих его native fixtures;
   Desktop/Main его не активируют, поэтому отказы Review/Add/retained этим не
   диагностированы. Дополнительный literal source pin включает сам helper.

6. **Private retained eligibility diagnostics.** При original V1 action=open
   coordinator-admission возвращал not-eligible/not-dispatched; исходная причина
   readEligibility была потеряна при сведении к `other`. Два production owners
   теперь передают её существующему bounded observer после currentness check.
   Допущенный native-custody-unverified branch, public result и cleanup прежние;
   observer не ожидается, его throw/rejection не меняет отказ. Existing projection
   сохраняет только закрытые category/phase и hash, без raw error/path/token.
   Actual-source8RED→70/70PASS:13новых случаев и57существующих coordinator/projection
   tests; fast lint3paths0/0, independent R2 PASS. Первые missing-static-asset
   harness attempts сохранены отдельно и не считаются RED. Generic fence errors
   остаются unknown; original V1 отказ не объявлен исправленным или принятым.

Полная финальная source-size композиция030+25source paths проверена actual
неизменёнными classifier/counter/evaluator:5162 production files,141 frozen legacy
caps, предел800 для новых production files,0violations. Scheduler836≤847;
baseline/policy не изменены. Исторические12path и22path проверки сохранены с
собственными hashes; итоговый25path report отдельно. Supplementary403lines
сохраняет прежние Quit/scheduler/native-helper pins и добавляет ровно шесть
production owners/dependencies retained observer в общей supplementary array.
Новый regression выбирается прежним Vitest test/**/*.test.ts. Integrated603lines
сохраняет исходный список и три solo source dependencies.

## Original 030: дополнительные UI, native и packaged результаты

- Teams Ubuntu/macOS/Windows GUI SUCCESS. Ubuntu28/28 teardown/census; исходные
  flow flags true и POSIX processGroupAbsent/temporaryProfileRemoved true.
  Windows имеет собственные captured-identity cleanup semantics, описанные выше.
  Только8/40 Windows screenshots осмотрены; другие visual scopes не приписываются.
- TEST installer UI SUCCESS: настоящий stock app Update route с emulated A/B
  версиями0.162.0→0.169.0, один download/update/sourcewrite, A runtime сохранён,
  B использует опубликованный TEST executable. `vendorsAllowed=false`,
  `nativeQualification=false`; реальный Codex не запускался.
- OpenCode QuitPendingOpen и chat-attachments original jobs SUCCESS. PendingOpen
   verifier допускает released-close либо retained held/open-unknown debt; без
   decoded final receipt одна из этих ветвей не заявляется. Chat: два original
   inputs, PNG2x1, cold0replay/0runtime allocations; metadata count1 — отдельно.
   Оба jobs имеют original source/physical-cleanup verifier PASS.
- Retained-original UI остановился после одного detail Launch, до explicit original
   runtime choice. Prepare held/not-dispatched записан примерно54ms после начала ожидания;
   последующий30s read-only poll ожидал другой dialog. Это отказ подготовки,
   не доказанная медленная готовность. Его внутренняя причина не установлена;
   typed native-custody-unverified имел бы отдельный explicit-choice route.
   App0,remaining[],TEST peers absent; capturedHostObserved=false/Absent=null.
   Повтор action и смягчение deadline не применялись.
- Finite Linux Claude/Codex conversations и schedules SUCCESS. В каждом job
  исходные503 common tests и7 tests PASS, source/selected-lane/cleanup verifier
  SUCCESS. Повторённые common tests не суммируются как уникальное покрытие;
  реальные vendor executables запрещены в обоих modes.
- Native Darwin x64 manual: original receipt PASS,11 model requests,
  zero model failures, все7 media/checkpoint/cold-no-replay steps и cleanup=true.
  Corrected roster step24 PASS; entire job FAIL отдельно на P09. Native Darwin
  ARM64 manual и его roster verifier также PASS, auto пропущен; P09 отдельно FAIL.
- Native Windows x64 и ARM64 manual и automatic: original receipts PASS,
  по11 requests, zero failures, все7 steps, cleanup=true. Это native/local-model
  qualification; vendorAuth/Desktop/release flags false.
- Host Linux x64 SUCCESS:192 Node contracts,63 broker,128 retained Main,
 29 POSIX, descriptor closure6+6 и retained-pidfd63. Два original native custody
  receipts completed/cleaned и automatic/warm=true. Этот scope не квалифицирует
  SDK/Desktop/older ABI или Windows source A/B.
- OpenCode Review Darwin ARM64: исходный preflight120s истёк до Launch.
  Final dialog blocked, captured model check unsuccessful; durable ordinary
  `model.probe` retained held/resourceHeld=true. Источник и журнал подтверждают
  отсутствие clean-close acknowledgement к original cutoff, но не точную
  причину. Main HOME/config-invalid сам по себе не объясняет отказ: для данного
  provider coordination not-applicable, ordinary success/clean close допустил бы
  готовность. Failure Quit app0/remaining[]/captured Host absent — отдельный scope.
- OpenCode Resume Darwin ARM64: истёк original preflight в ПЕРВОЙ epoch,
  до Launch/Stop/cold boundary. Поздний snapshot показывает readiness verified
  и enabled Launch; durable probe completed/ok/clean. Это не доказывает готовность
  до cutoff1795043837560. Failure Quit app0/remaining[], но capturedHostObserved=false
  и capturedHostAbsent=null; captured Host absence PASS не заявляется.
- Packaged Darwin x64/ARM64, Linux x64 и Windows x64/ARM64: все пять original
  targets повторили один дефект. Relocated generated TEST Host требует
  `../../dist/attachments/contracts.js` относительно RUNNER_TEMP и падает
  MODULE_NOT_FOUND. Native receipt INCOMPLETE,11requests/0model failures и cleanup=true;
  wrapper подтверждает restoration source/bundle/legacy. TEST fixture теперь
  загружает contracts от уже captured packaged Host entry. Actual finite RED→2PASS
  и независимый root R2 завершены; original native receipt остаётся INCOMPLETE.
- Windows Host ARM64 Codex: read109 ready=true на15436.7295ms после исходных15s.
  allocated/unsealed — нормальный active Runtime. Поздние non-atomic snapshots
  не заменяют predicate. Windows x64 Codex/Claude source A/B SUCCESS; OpenCode A/B
  held/open-unknown, expiry/currentness отказ — отдельный original boundary.
  Эти отказы не исправляются увеличением budgets или повтором исходного action.

## Original 030: поздние gates и отдельные оставшиеся отказы

- Management UI SUCCESS: model/effort/credential controls на TEST peers, original
  source/receipt/cleanup verifier PASS. Шарды frontend2,3 и4 завершены SUCCESS:
  shard2:549PASS/2SKIP files,6873PASS/18SKIP tests;
  shard3:548PASS/3SKIP files,6358PASS/7SKIP tests;
  shard4:549PASS/2SKIP files,6790PASS/7SKIP tests. Shard1 остаётся FAIL;
  общего frontend-suite PASS нет.
- Linux x64 native manual receipt PASS:11requests,0model failures,cleanup=true,
  восемь stages с initial coordination. Native catalog/model probe также PASS:
  семь stages, original cancellation, selected variant, published global/project
  source и cold management readback. Поздний credential scenario INCOMPLETE:
  после пяти stages и намеренного четвёртого timeout request Host epoch3 exit1,
  driver-close unconfirmed, journal held/resourceHeld=true, cleanup=false.
  Первая observed read-cut after-log имеет transport_failure при deadlineExpired=false
  и aborted=false; trace cap не позволяет восстановить полный transport timeline.
  Последующие permission/MCP/final-product verifier steps21–24 пропущены.
  Server-stop сам по себе не заменяет driver cleanup, причина не объявлена исправленной.
- Linux V1 original native versions1.19.4/1.19.5/latest→1.19.6 PASS, по8requests.
  Managed update1.19.4→1.19.6 сохранил исходную pending native session и её pinned
  process/source/state bytes. Это TEST-local-model scope без Desktop/vendor/release.
- Main FastFeedback SUCCESS на actual mergee1cd736d (tree030), Node26.12.1:
  полный canonical workspace typecheck, lint:fast0errors/228warnings и actual
  source-size5162/141/800 PASS. Его runtime provenance не заменяет отдельный D1.
- Main retained Desktop FAIL на повторном запуске сохранённого V1 после выбора
  Host в app1, до нового V2 business runtime. Coordinator вернул
  not-eligible/not-dispatched; app diagnostic discover-bindings/unavailable —
  отдельное наблюдение, не доказанная атомарная причина. Первая legacy V1 history
  сохранилась (два сообщения); cleanup=true,cleanupFailures=[],modelFailures=[].
  Coexistence, последующие V2/source/donor-history stages не квалифицированы.
  Main final aggregate завершился FAILURE по RETAINED_COEXISTENCE_RESULT=failure;
  это dependency verdict на прежних merge bytes, а не новое runtime исполнение.
  Полный terminal capture Main завершён однократно, scope выведен из наблюдения.

## Original 030: полный F1 и поздние Desktop scopes

Original cross-team job135167682430 завершён SUCCESS. Полный receipt сохранён
побайтово:21382647bytes,SHA256`ed994cbd73c010eb4050785a58ddf230d02d4215a755522453d85860b9d88674`;
его deterministic gzip приложен к индексу. ReviewFlow override `lead_then_human`,
inherit=null и approve дали ровно3 completed Host commands, actor=user;
`human_approved`, inheritedAfterReload=true, default agent_approval restored,
reopen без replay. Footer исполнялся через6 wheel и22 click inputs.

Все три cold epochs default-b/unavailable-a/rollback-a PASS с исходными source
assertions. Trusted descriptor менял defaultOwner и creation.owner; это именно
cold owner-routing TEST scope. Восемь product census comparisons совпали по
файлам и hashes;1883source pins до/после равны,dirty=false. Root app и первые две
cold epochs exit0. Rollback-a потребовал guarded SIGTERM; затем hostsAbsent=true,
remaining=[],cleanupFailure отсутствует. Всеобщий natural exit не заявляется.
Сохранение lead_then_human не означает исполненный native lead handoff;
реальных vendor runtimes и native Host children в этом TEST proof нет.

Поздние original TEST UI jobs extensions/taskboard/collaboration/processes/import/
selection/review и Codex login завершены SUCCESS. Finite OpenCode conversations
также SUCCESS; повторные503+7 common checks не суммируются как уникальные тесты.
Каждый compact сохраняет собственные source/receipt/cleanup scopes и raw-log hashes.

Native Desktop management983 имеет два разных результата. Settings PASS:
5scripted model requests и5original probe processes, все probes absent,
capturedHostAbsent=true,app0,1895source pins равны. Следующий live membership
сценарий выполнил один Carol Add, но original90s completion assertion отказал.
Поздние roster/launch и native-local-readiness journal held/resourceHeld=true
не устанавливают внутреннюю причину или выжившего физического ребёнка.
Later Remove/Restore/Stop/cold/history не квалифицированы. Live failure cleanup:
remaining[],app0,finite peers absent,capturedHostObserved=false/Absent=null,
1883source pins равны. Step31 был receipt/physical-cleanup verifier Settings,
не permission/MCP exercise. Native passive observer в Desktop не активирован.

Original solo producer976 остановился до import; его обычный Stop и успешный
freeze не достигнуты. Failure Quit завершил app0 и подтвердил TEST peer absence,
но оставил pid4745/ppid1/pgid4671: captured leader absent, cleanup debt retained
без сигнализации чужой группе. Новый solo snapshot fix не выдаётся за исправление
этого отдельного cleanup debt; оригинальный общий FAIL сохранён.

## Завершённое наблюдение original030 и предел сохранённого журнала

Все полезные original jobs030 завершены; новый source не отправлялся во время
их исполнения. Native/Main owner закрыл13workflow scopes:12 имеют полный terminal
capture, последний packaged scope — полный canonical jobs page с7terminal jobs
и явно записанный пробел сохранения. Его aggregate failure00:58:41 подтверждён
job page; последующие однократные запросы final log/run metadata/artifact inventory
не были сохранены из-за ошибки локального decoder. Эти endpoints не перечитывались,
а их содержимое не объявлено полученным. Все пять исходных platform raw proofs
и MODULE_NOT_FOUND failures сохранены независимо. Host/Teams terminal capture
полон и также выведен из наблюдения. Это предел evidence, не изменение verdict.

## P09: исходный полный Darwin x64 журнал на 030 и исторический 547

Отдельный native OpenCode E2E и corrected media verifier на030 прошли; весь
original Darwin Stage1 job FAILURE на P09. Полный x64 journal030 сохраняет те же
case classifications, что исторический original547; результаты не перепривязаны.
Полный Darwin ARM64 journal отличается:7 PASS/2 INCOMPLETE/1 COUNTEREXAMPLE,
compiler-default baseline PASS. На ARM не переносятся x64 unsigned-baseline refusal
и его6/3/1 counts. Оба ARM incomplete — ad-hoc after-check/writer-open; script
COUNTEREXAMPLE тот же по классификации. Все10 ARM cleanup/reaped/group-absence true.
POSIX journal содержит 10 исходных witnesses: 6 PASS, 3 INCOMPLETE и один явный
script COUNTEREXAMPLE. Unsigned compiler baseline отказал на kernel-image-validity
с errno13 / codeSigningError -67062. Ad-hoc after-check и writer-open дали
mutationErrno0, затем LIB/BIN:A/MAIN:A и exit0: это нарушение прежнего oracle,
а не доказательство исполнения native B. Script-negative действительно дал
SCRIPT:B после успешной mutation. Все десять original processes reaped,
groups absent, cleanup=true; controllerInterrupted=false. Qualification flags
остаются false, общий статус INCOMPLETE. Прежнее решение о writer/path/consumed
bytes не принято; oracle, исходная поддержка scripts и граница доверия не меняются.


## Original 42a4: исправление типизации теста до native acceptance

Original Host process jobs Windows ARM64 (135261468433) и Darwin ARM64
(135261468917) остановились на компиляции Host tests: TS2339 в
`native-host-close.test.ts(107,42)` и `(107,65)` для `base` и `specifier` у `never`.
Их native/process acceptance steps не исполнялись. Это отдельная ошибка нового
теста; прежняя runtime причина packaged `MODULE_NOT_FOUND` здесь не проверялась.
Исходные журналы сохранены, их terminal log endpoints выведены из наблюдения.

Причина установлена по фактической декларации `@types/node`24.12.4:
`node:assert/strict` использует generic assertion `deepStrictEqual<T>`, поэтому
`assert.deepEqual(loads, [])` сужает массив до `never[]`, несмотря на последующие
записи через callback. Изменены только две строки — добавлены `<typeof loads>`.
Оба исходных сравнения с пустым массивом, callback, проверки captured entry и
specifier, отказ при отсутствующем contract и frame oracle сохранены.

Фактический TS7.0.2 на исходном тесте воспроизвёл ровно обе исходные ошибки;
кандидат прошёл focused noEmit без diagnostics. Полный JavaScript после удаления
типов идентичен байт в байт. Два существующих finite loader/frame regressions
прошли2/2 без skips. Использованы подготовленные compiled declarations/pure schemas;
это не новый product build, не Windows/native acceptance и не полный workspace gate.
Independent R2 подтвердил ровно два type arguments и32 pinned input/receipt files.

Индекс исправления и исходных доказательств:
[parity-test-types-index-20261119.json](parity-test-types-index-20261119.json).
Production source, deadlines, runtime cleanup, source rosters и size policy не
меняются. Предыдущие F1/D1/native результаты остаются привязанными к030; текущие
original42a4 и будущий successor требуют своих результатов. P09 writer/path
решение не выбрано, причины остальных incomplete boundaries не подменяются
этой ошибкой компиляции.


## Original 42a4: второй test-only type отказ и независимый native PASS

Весь Host process workflow44434982536 завершён: все пять исходных платформ
отказали на той же компиляции теста TS2339; последующие native steps10–23 не
выполнялись. Сохранены все пять journals, final workflow metadata, canonical
job page и inventory пяти artifacts; повторное чтение этих endpoints запрещено.
Содержимое ZIP artifacts для compile-only failure не загружалось.

Original Teams Ubuntu135261468624 и Windows135261468308 отдельно подтвердили
другую ошибку: root TypeScript проверка отказала с TS2540 в
`TeamProvisioningPersistenceReconcileFacade.test.ts(607,15)` при присваивании
`f.child.exitCode = 0`. Isolated Host production build в обеих jobs прошёл;
Create/Back/Resume/Copy/Launch E2E и его screenshots/receipts не созданы.

Причина — локальный synthetic child был объявлен как `ChildProcess`, чей Node
type имеет readonly `exitCode`. Сам объект создан тестом и его изменение
имитирует подтверждённое завершение: после `recordVerifiedCliProcessRelease`,
перед `processClosed` и проверкой Stop completion. Только его local TEST view
теперь явно содержит mutable `exitCode: number | null`. Runtime object, custody,
очередность release/exit/Stop, отрицательные проверки и production types сохранены.
Actual TS7 source-excerpt noEmit воспроизвёл TS2540 и прошёл после изменения;
полный преобразованный JavaScript теста совпадает. Это ограниченное доказательство
типов, а не полный file/project typecheck. Один существующий positive Stop case
проверен в подготовленном finite harness без native child/build/install.

Отдельный native Stage1 Windows ARM64 job135261468893 на том же42a4 завершился
SUCCESS. Его original artifact подтверждает manual и auto OpenCode2.1.4 journeys:
в каждом11 TEST-local model requests,0model failures, семь completed stages,
media/tool/MCP/permission, сохранение исходной config, Stop и cold Host Resume
без model/tool replay. В каждом два captured Hosts завершились exit0/no signal,
stdout valid и cleanup=true. Windows original/neighbor Job custody cleanup
подтверждён отдельным receipt. Это не Desktop/vendor-auth/release qualification;
Linux coordination на этом tuple остаётся unqualified. Отсутствие close-failure
events само по себе не использовано как доказательство cleanup.

Оба source исправления затрагивают только типы существующих tests. Все5162
production leaves идентичны опубликованному42a4, исходный size guard не менялся
и повторный его запуск не заявляется. Прочие original CI продолжают сохранять
свои самостоятельные verdicts; полноценный successor gate ещё требуется.


### Дополнительные original42a4 результаты на момент сборки исправлений

Frontend shard2 job135261470422 завершился SUCCESS:550files passed/2skipped,
6891tests passed/18skipped/0failures. SmartSchedules.safe-e2e14 и live snapshot
factory8 входят в эти6891, а не прибавляются к ним. Shard1, полный typecheck,
actual Solo producer и native UI этим результатом не квалифицируются.

Finite Codex UI job135261471138 прошёл original conversations/schedules через
pinned TEST peers и final exact-source/receipt/cleanup verifier. Installer UI
job135261470910 прошёл stock Codex Update с retained original Team source и
тот же штатный verifier. Оба режима emulated; реальный vendor Codex не запускался.
Общие исходные unit counts между lanes не суммируются как уникальные тесты.
Artifact metadata сохранены из original uploads, отдельные ZIP/visual audits
для этих UI jobs не заявляются.

Darwin x64 job135261468754 и ARM64 job135261468687 имеют отдельные completed
embedded Host PASS/cleanup=true и custody PASS/cleanup=confirmed receipts.
Оба job в целом FAILURE на последующем P09 POSIX witness step25. На x64 первый
сохранённый assert476:18 относится к `SecCodeCheckValidity` return−67062:
helper отображает отказ в свой default EACCES13, но `execErrno=0`; это не
наблюдавшийся execve denial. ARM compiler-default baseline PASS, первый отказ
assert496:24 — after-check markers. На обеих архитектурах after-check и
writer-open допускают успешную mutation и затем `LIB/BIN:A/MAIN:A`, что нарушает
существующий no-user-markers oracle. Script-negative сохраняет явный `SCRIPT:B`
COUNTEREXAMPLE. Все10 children/groups на каждой архитектуре очищены; это не
доказательство byte identity или mutation prevention. Native runtime PASS и
POSIX INCOMPLETE не объединяются в общий PASS; P09 contract остаётся невыбранным.


## Поздний original42a4 срез и недоступность рабочей среды

[Индекс32 исходных Host/Teams jobs](parity-42a4-ui-final32-index-20261119.json)
содержит22success/10failure с точными log/evidence hashes. Settings native PASS
сохраняется отдельно от следующего membership отказа `3 !== 2` до Add. Failed
three-child snapshot отсутствует; последний successful currentPhysical нельзя
использовать для определения лишнего PID. Resume остановлен до исходного Launch
click; active Quit — при setup до Quit business; Review — после исходного click
и успешного model preflight, но до подтверждённого capture. Полного native UI PASS
эти observations не дают. Original Solo Create/reply/Stop достигнуты, required
nativeRelease отсутствует, WorkSync и cleanup debt остаются открытыми.

[Четыре frontend shards](parity-42a4-frontend-four-shards-20261119.json) дают
26410PASS/38SKIP/0FAIL. Source-only finite cases из других lanes не прибавляются.
Main job135299854804 воспроизводит readonly exitCode TS2540, который исправлен
здесь только в synthetic test view. Job135299855013 дошёл до original V1 history,
затем retained open отказал not-eligible/not-dispatched; исходный receipt имеет
cleanup=true. Подробный новый Main receipt/ZIP и Linux packaged receipts были
сохранены локально до отключения среды; их bytes сейчас недоступны. Их hashes в
записи восстановления не выдаются за удалённые uploads, endpoints не повторяются.

На свежем объединённом census03:48:16 UTC все полезные42a4 jobs завершены; остаются
три служебных queued/unassigned aggregators. Это наблюдение сохранено как три
полных raw response объекта; непосредственно перед commit требуется новый gate.
Сам по себе queued статус недостаточен: runner assignment также должен отсутствовать.

Независимое review frozen type-only tree a7c092df сохранено в
[type-tree R2](parity-type-tree-r2-20261119.json). Новая запись состояния добавляет
только документацию/evidence поверх того же проверенного source. Draft PR1192,
исходный base, маршрут1192→1186→982, provider pin, source-size baseline и runtime
oracles сохранены. P09 contract из Report40 не выбран. После восстановления среды
нужно завершить WorkSync integration и незакрытые runtime/UI причины; этот коммит
не является завершением всей миграции.
