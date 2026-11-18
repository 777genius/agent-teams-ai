# Завершение Host / frontend parity

Обновлено: 18 ноября 2026. Единственный текущий рабочий план.
Последний проверенный app source: `f60dcc107c00c58c0a577f2661f9f0eaf80a596f`.
Provider entrypoints и четыре Host import-only изменения прошли R2.
Canonical provider check PASS; provider `b19494fd` опубликован.
Taskboard и task review cycle GUI PASS; ReviewFlow остановился на невидимой ссылке.
Навигация к footer исправлена через существующий bounded trusted scroll; R2 PASS.

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
| F1 | Taskboard и task review cycle GUI PASS на f60; ReviewFlow INCOMPLETE | Довести переход к footer в scrollable popover, затем original Settings/Approved/reopen и все три owner-routing epochs. Сохранить current request/cycle, final receipt и пустой cleanup. | pr_graph; media; reviewflow; root |
| F2 | Реализация и focused contracts PASS | Сохранить canonical Host agenda: lead/user clarification блокирует review work до review cycle; app path остаётся re-export. Не выдавать UI сохранение lead_then_human за исполненный lead handoff. | reviewflow |
| M1 | Native E2E PASS только на 2f33d566 | Сохранить точный native receipt; новый package оценить по затронутым boundaries. Desktop/vendor auth/release этим native run не квалифицированы. | media; R2 reviewflow |
| E1 | Исходные source/fixture отказы исправлены; текущий GUI остаётся | После первого GUI выполнить минимальную очередь изменённых Create/import/retained/Resume/Add/collaboration путей; исходные authority/source/no-replay/cleanup assertions обязательны. | root; pr_graph |
| W1 | x64 source fix готов; Windows acceptance открыт | Нужны original Windows x64/ARM64 gates и same-Main packaged recovery. ARM64 первая причина отказа не установлена; 15 s и все шесть разделённых probe boundaries сохраняются. | root; media |
| P09 | Открыто: решение о контракте | Установить выполнимую границу original pathname / разрешённый writer / consumed bytes; до отдельного решения не сужать гарантию и не менять failed oracle. | root |
| D1 | Композиция и независимое ревью готовы; gates открыты | Получить обязательные current-tree CI, полный workspace typecheck и необходимые platform результаты. Pending/исторические scoped PASS не заменяют их. | root |

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

## Сейчас выполняется: завершить original ReviewFlow GUI

На exact f60 source `taskBoardUiProof=PASS`, `taskReviewCycleUiProof=PASS`.
Taskboard прошёл create/dependency/association/assignee/clarification/order,
blocked-start и последующий success, reload и attachments. Review cycle прошёл
исходные девять состояний complete→request→request_changes→start→comment→complete→
request→approve→disapprove, итог completed/none в Done. R2 связал source hashes
всех трёх UI proofs с опубликованными Git objects; отдельный visual signoff не заявлен.

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

## Original GUI: компактная история незавершённых запусков

Все запуски пока **INCOMPLETE** и без финальных owner epochs. Последний дошёл
до реального UI; предыдущие завершались до него. Cleanup.remaining пуст;
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

Действующий experimental selector — только 1024 + UV4 для прежних семи Linux/x64
finite emulated modes. Retired 512/768, произвольные flags, malformed/two selectors
отвергаются; exact Node/UV проверяются до/после normalizer. Focused 10/10 и R2 PASS.
Original 1536/default/native, parent heap, команды/plugins и deadlines сохранены.
Профиль действует на TEST app-chain, включая Electron Main; Host closed env
не наследует NODE_OPTIONS/UV. Maps-off меняет debug artifacts main/renderer,
не preload; byte-identical build/Sentry qualification не заявлены.
Explicit OOM новых попыток не устанавливает причину прежних SIGKILL.
Последний и следующий original GUI используют существующий профиль 1536
с исходным UV behavior. Его parent heap, capture pins и Host environment прежние;
новых resource selectors, production knobs или deadlines для этого не вводилось.

## Оставшиеся обязательные gates и минимальная очередь

1. Опубликовать минимальное исправление footer navigation и actual GUI evidence;
   provider archive/install/Host build неизменны и повторной проверки не требуют.
2. Один original task-board-cross-team-ui на чистом новом source. При успехе читать
   final durable receipt после exit и всех трёх owner-routing epochs: ранняя
   console PASS недостаточна. Host/source/owner/cleanup guards обязательны.
3. Затем очередь без duplicate basic taskboard: emulated-selection-ui,
   emulated-import-ui, emulated-import-lifecycle-ui, emulated-retained-original-ui,
   emulated-claude-lifecycle-ui, emulated-collaboration-ui. Запускать только нужные
   изменённые boundaries; перенос старого PASS требует доказанного scope equality.
4. emulated-installer-ui локально BLOCKED_PLATFORM: требуется исходный Darwin
   qualification; Linux selection не объявляется его заменой. Darwin ARM original
   preflight 30 s и native startup/Resume остаются отдельными gates.
5. W1: final catalog staged около 14993 ms, prepare/resume=0, cleanup подтверждён;
   first checkSite/deadlineExpired неизвестен. Все шесть probes разделены async/
   state/native boundaries. Два sync guard формально дублируются, но измеренного
   вклада нет: patch отклонён. Нужен исходный ARM64 результат с прежними 15 s,
   плюс Windows same-Main recovery на обеих архитектурах по Report 30.
6. Полный workspace typecheck остаётся INCOMPLETE: последний root app TS7
   --noEmit --singleThreaded на c8, GOMEMLIMIT=512MiB/GOGC=50/GOMAXPROCS=2 — SIGKILL
   за 36229 ms, 0 bytes diagnostics; остальные 11 canonical invocations не запускались.
   Предыдущие exit 137 и full typed lint interruption также не PASS. Scoped Host/consumer
   checks не заменяют gate; новый тяжёлый повтор требует конкретного основания.
7. P09: прежний contract original path/argv/env/cwd/resources и защита от writer
   пока не доказаны для исходных Darwin adversarial cases. Направления A/B из
   Report 40 не выбраны. Не вводить silent copy, запрет scripts, новый permission
   policy или доверие writer без отдельного решения; независимые работы продолжаются.

Проверки выполнять по очереди без конкурирующих GUI/native/build процессов и
изменения frozen source/deps. Source R2 не равен native PASS; повторять только
затронутые сценарии и конкретные оставшиеся risks, сохраняя required CI gates.

## CI snapshot, исходные receipts и решения

Снимок GitHub на 4f5ae2dc: **43 review threads resolved**, новых open findings нет.
CI proof / Host emulated / process / packaged / Teams creation / V2 static —
**queued, не PASS**. Повторные workflow не запрашиваются; отменённые cohorts
и skipped jobs не квалифицируют новый срез.

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
