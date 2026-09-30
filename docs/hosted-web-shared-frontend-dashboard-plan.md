# Общий frontend Desktop/Hosted: полный пример Dashboard

Дата: 2026-09-30. Source baseline: `debb837d4660065f30925bfd4ec0897fbfa5c11d`, PR `777genius/agent-teams-ai#252`.
Статус: **план следующего bounded increment; этот документ не является реализацией или runtime evidence**.
Изменения считаются от указанного SHA. Ранее доставленные F1/F2/D1/N1 повторно не оцениваются.

## 1. Результат и границы

Цель - один Dashboard frontend с общими представлением и логикой пользовательского взаимодействия для Electron и Hosted browser.
При одинаковых доказанных данных пользователь видит одинаковые карточки, поиск, состояния загрузки и переходы.
Desktop сохраняет богатые локальные возможности; Hosted сохраняет безопасные HTTP/SSE adapters и серверную authority.
Не достаточно обернуть разные экраны одинаковым заголовком или заменить Recent Projects списком зарегистрированных workspace.

Полный целевой slice:

1. Общие layout, поиск по карточкам, очистка, pagination отображения, running rows, project cards и retry/error UX.
2. Recent Projects в Hosted с настоящей доступной активностью зарегистрированных workspace и безопасным открытием chooser.
3. Общие navigation interaction и palette presentation; Desktop сохраняет поиск sessions, Hosted получает workspace/team navigation.
4. Один владелец текущего directory read, selection и request lifetime на Hosted workspace; D1/N1 продолжают использовать его.
5. Явные capability boundaries для native actions и неизвестных данных; никакой эмуляции Electron в браузере.
6. Проверка personal production composition, emitted import graph, Desktop регрессий и sandbox browser flow.

**Не входит:** новый team runtime, terminal в браузере, установщик server CLI, provider login из Dashboard, session viewer в Hosted,
полная унификация Kanban, roster/messages/review UI, новая DI-платформа, persistence framework или зависимости.
Dashboard не становится owner команд launch/create/task-write/message-relay. Эти workflows остаются в существующих features.

### 1.1. Отношение к принятым документам

- [Core v1 scope lock](hosted-web-core-v1-scope-lock.md) определяет включённые продуктовые возможности.
- Keycloak/OIDC multi-user profile остаётся deferred по scope lock; этот increment не создаёт для него producer
  и не делает его release gate. Общие DTO/reader не запрещают позднее подключение отдельного профиля.
- [Foundation plan](hosted-web-foundation-delivery-plan.md) уже выбрал и доставляет F1/F2/D1/N1; здесь описан следующий Dashboard slice.
- [Feature architecture standard](FEATURE_ARCHITECTURE_STANDARD.md) остаётся владельцем правил архитектуры.
- [AGENTS](../AGENTS.md), [CLAUDE](../CLAUDE.md), [guardrails](../AGENT_CRITICAL_GUARDRAILS.md) задают безопасность и gates.
- [Phase router](hosted-web-phases/START_HERE.md) не получает новый обязательный документ или новую трактовку parked r6 `HOLD`.
- Реализация остаётся в линии #252 с сохранением существующего PR, ветки и review history. Новый replacement PR не нужен.

Запрос на полноценный Dashboard задаёт целевой продуктовый результат. Bounded дополнение уже записано в
[scope lock](hosted-web-core-v1-scope-lock.md#accepted-shared-dashboard-increment-2026-09-30), а foundation plan
ссылается на этот increment. Нельзя молча расширять его до deferred Hosted capabilities.

**Точный смысл amendment для scope lock:**

> В рамках выбранного Dashboard increment Hosted получает тот же feature frontend для Recent Projects, локального поиска
> по доступным карточкам и перехода в Team Chooser, что Desktop. Recent Projects включают только зарегистрированные,
> допущенные workspace с подтверждённой recent activity из доступных существующих источников. Wire DTO не содержит
> filesystem paths, repo identities, provider credentials или synthetic-path targets. Navigation выполняет существующий
> workspace-select admission перед открытием chooser. Dashboard palette поддерживает доступные workspace/team переходы.
> Полный session search/viewer, native filesystem actions, CLI installation/auth/update и terminal не добавляются этим решением.
> Unknown activity/counts/runtime отображаются как unknown; отсутствие данных не преобразуется в нули или offline.
> Реализация обязана сохранить Desktop rich actions, Hosted auth/grant/CSRF/Origin, generation/revision/SSE fences и graph guard.

Этот amendment - prerequisite кода нового Hosted recent facade/route и его UI.
Частичные checkpoints полезны отдельно, но итог нельзя назвать полным Dashboard до выполнения всей принятой матрицы.

### 1.2. Выбранный подход и альтернативы

| Вариант | Оценка | Изменения после baseline | Решение |
|---|---|---:|---|
| Feature-owned общий Dashboard + узкие реальные adapters | 🎯 7/10 🛡️ 9/10 🧠 9/10 | 16.5-26.95k changed LOC | Выбран: общий flow, проверяемые границы, сохраняются richer facts |
| Только общий layout, отдельные hooks/карточки/поиск | 🎯 6/10 🛡️ 7/10 🧠 3/10 | 1.5-3.0k | Не выполняет запрос об общей interaction logic; это лишь промежуточный checkpoint |
| Перенос Desktop App/store/ElectronAPI целиком в Hosted | 🎯 2/10 🛡️ 2/10 🧠 9/10 | 15-30k, низкая точность | Нарушает graph/security boundaries; не рассматривается для реализации |

Числа prospective, не измеренный будущий diff. Основной диапазон подробно разложен в §15.

## 2. Проверенное состояние на baseline

### 2.1. Уже сделанное: использовать, не переписывать

| Область | Текущий seam | Как использовать |
|---|---|---|
| F1 | Shared controller task semantics, используемые Product/Desktop/Hosted | Не копировать формулы ради карточек Dashboard |
| F2 | `src/features/team-task-board/core/application/CreateTaskInteractionController.ts`, `hostedCreateSessionRegistry`, create/non-create handles | Не менять lifetime unresolved mutations при переключении экрана |
| D1 | `src/features/running-teams/renderer/hosted.ts`, `RunningTeamsSectionView`, `rankRunningTeamFacts` | Включить существующий view в общий Dashboard; сохранить известные/unknown facts |
| N1 | `src/features/team-directory/core/domain/teamDirectory.ts`, renderer public entrypoint | Переиспользовать search/order/filter/open intent в chooser/palette |
| Hosted directory source | `useHostedTeamDirectorySource`, `loadTeamLifecycleList`, `loadHostedTeamRuntimeEvidence` | Один session над Dashboard и chooser; не второй fetch loop |
| Emitted graph guard | `docker/vite.hosted-renderer.config.ts`, `verify-hosted-no-terminal-artifact.mjs` | Реальная сборка доказывает отсутствие forbidden dependencies |

D1 уже различает positive running evidence, неизвестный runtime, stale и incomplete.
N1 уже использует opaque identity, scope/read epoch и не трактует unknown как offline.
F1/F2 считаются prerequisite evidence; их старые LOC и тестовые наборы не входят в стоимость нового extraction.

### 2.2. Dashboard и native окружение

[Desktop DashboardView](../src/renderer/components/dashboard/DashboardView.tsx) - 176 строк, но transitive dependencies значительно шире.
Он непосредственно читает `useStore`, монтирует native banners и собственный `CommandSearch`.
Поле поиска фильтрует Recent Projects, но сейчас непустой query скрывает running teams и останавливает их alive read.
H2 меняет это поведение на локальную фильтрацию уже загруженных running rows без нового network read.
Отдельная кнопка/shortcut открывает глобальную CommandPalette.
`CommandSearch` подписывает `window.keydown`, фокусирует input сразу и ещё через 50 ms, не проверяя modal occupancy.
`useKeyboardShortcuts` одновременно регистрирует shell CmdK, но отсекает editable target до этой ветки.
При удалении Dashboard listener H2 переносит CmdK перед editable guard с IME/overlay guards; остальные shortcuts не меняются.
`isActive` передаётся только CLI banner: скрытый Dashboard не должен сохранять собственный глобальный shortcut после extraction.

`CliStatusBanner.tsx` - 2,829 строк: installer/auth/model catalogs/provider quotas/update actions, store, API и analytics.
Он остаётся Desktop extension; тащить его в shared view ради нескольких статусов нельзя.
`DashboardUpdateBanner` использует updater store; `WindowsAdministratorBanner` читает native elevation status.
`WebPreviewBanner` относится к legacy web preview и не является Hosted production баннером.
`TmuxStatusBanner` сейчас возвращает `null`; создание Hosted no-op метода ради него не требуется.

### 2.3. Recent Projects: renderer audit

| Source | Фактическая ответственность | Изменение |
|---|---|---|
| `renderer/hooks/useRecentProjectsSection.ts` (308 строк) | Global tasks/teams/context/provisioning, cache, alive read, filtering, 11+8 display limit | Desktop source mapping оставить отдельным; общие filter/limit вынести |
| `renderer/hooks/useOpenRecentProject.ts` (152) | Worktree match, sessions, synthetic repository, config add path, native folder selection | Desktop navigation adapter; пути не выходят в shared actions |
| `renderer/ui/RecentProjectsSection.tsx` (188) | Hook вызван из UI; loading/error/empty, picker, cards/load more | Разделить connected wrapper и browser-safe collection view |
| `renderer/ui/RecentProjectCard.tsx` (245) | Rich DTO + path action + progress + providers + activity | Общая card view получает normalized facts и доступные actions |
| `renderer/view-models/recentProjectsSectionViewModel.ts` (153) | Путь/branch/time/path grouping, task sums, rich `TeamSummary` | Desktop projection сохранить; shared card model не содержит rich DTO |
| `renderer/utils/recentProjectOpenHistory.ts` | `localStorage` путей, 48 h priority, максимум 120 записей | Только Desktop storage adapter; чистую ranking policy вынести из storage |
| `renderer/utils/recentProjectsClientCache.ts` | Один in-memory payload/key, TTL 15/30 s, dedupe in-flight | Сохранить Desktop поведение; Hosted отдельный authority-scoped cache |

Renderer barrel `recent-projects/renderer/index.ts` экспортирует connected UI и path history.
Его нельзя импортировать Hosted без выделения узкого browser-safe entrypoint.
`RecentProjectCard` содержит native `title={providerId}` и вложенный `role=button` внутри button.
В переносимой карточке исправить оба доступностных дефекта: Radix Tooltip и два соседних controls в контейнере.

### 2.4. Recent Projects: HTTP и source audit

Текущий путь уже существует, но **не доказывает Hosted Dashboard parity**:

```text
src/main/standalone.ts: createRecentProjectsFeature
  -> src/main/http/index.ts: registerRecentProjectsHttp
  -> GET /api/dashboard/recent-projects
  -> Hosted access deployment-query authorization
  -> ListDashboardRecentProjectsUseCase + current presenter
```

`createRecentProjectsFeature` собирает Claude source и `CodexSessionFileRecentProjectsSourceAdapter`.
Это не обещание источника OpenCode или Gemini. Тип provider union сам по себе не доказывает доступность источника.
Use case объединяет candidates по identity, кеширует 10/30 s, умеет degraded sources и stale fallback.
Presenter возвращает `primaryPath`, `associatedPaths`, branch, repo identity и `openTarget`.

HTTP adapter получает `projectWorkspaceId(request, project.id)` и заменяет `id`, `primaryPath`, `associatedPaths`, `openTarget`.
Остальные поля остаются через `...project`. При ошибке возвращается `{projects: [], degraded: true}`.
`HostedIdentityService.projectWorkspaceId` ищет точное совпадение **runtimeWorkspaceId**.
Claude candidate identity - `repo.identity.id` либо `path:<normalized path>`; это не установленная эквивалентность runtimeWorkspaceId.
Следовательно, текущий join может отфильтровать допущенную карточку либо объединить related paths до проверки grant.
Это source-confirmed риск контракта; реальное проявление надо доказать fixture, а не объявлять уже доказанную утечку.
`WorkspaceRegistration`/startup manifest содержат только `declaredRootHash`, не admitted path. Текущий Claude source
вызывает `scan`/repository grouping до проекции; Codex session-file source сканирует глобальные sessions,
кеширует cwd и вызывает identity/filesystem enrichment после scan. Ни один нельзя использовать в Hosted посредством
позднего фильтра. Production Compose монтирует `.claude`, но не Codex metadata и не workspace root;
`/home/node` - tmpfs, поэтому implicit `os.homedir()/.codex` также не источник E2E evidence.

Обязательная проверка в backend checkpoint:

- Две зарегистрированные roots одного repo, одна запрещённая related root и разные runtime IDs.
- Полное отсутствие host paths, remote URLs, branch/path-derived private names и неразрешённых provider facts в JSON/errors/logs.
- Grant storage failure не является пустой успешной выборкой; auth/grant failure не превращается в stale data другого scope.
- Отсутствующий Codex session mount не компенсируется монтированием credential-bearing `CODEX_HOME` или запуском provider.
- Старый generic HTTP route сохраняет Desktop/legacy API shape вне Hosted auth, но в Hosted не остаётся обходным route.

### 2.5. Command search и palette

[CommandPalette](../src/renderer/components/search/CommandPalette.tsx) - 654 строки, тесно связана со store/API.
Без выбранного проекта она фильтрует repository groups по name/path и показывает до 10.
С проектом ищет sessions: минимум 2 символа, debounce 400 ms, limit 50; global mode вызывает `searchAllProjects`.
Project click выбирает repo и оставляет palette открытой; session click переносит query и точные match anchors в viewer.
Есть Escape/arrows/Enter, Cmd/Ctrl+G, IME guard, overlay occupancy и защита от позднего ответа устаревшего query.
Эти Desktop функции сохраняются; простая замена palette списком команд их не заменяет.

Hosted сейчас не монтирует эту palette и не имеет соответствующего session viewer в выбранном Dashboard scope.
Цель данного increment - тот же search/palette UI и navigation interaction для поддержанных project/team targets.
Session search/viewer остаётся отдельным slice с backend/read/privacy acceptance; это не скрытый prerequisite Dashboard.

### 2.6. Running teams и chooser

`HostedRunningTeamsSection` получает **тот же** directory state, что `HostedTeamLifecycleList` внутри `HostedTeamWorkspace`.
`HostedTeamWorkspace` уже имеет два `useHostedCoordinationEvents`: workspace scope для lifecycle и team scope
для task/message invalidations. Dashboard/chooser разделяют один workspace-scope owner; выбранная team оставляет
свой team-scope owner. Новый recent read может подписаться на invalidation bus владельца workspace, но не монтирует
третий coordination hook/EventSource.
`loadHostedTeamRuntimeEvidence` выполняет wave с concurrency 4 и общим deadline 10 s.
Только control state `stop + runId` доказывает running; `launch + null runId` доказывает offline.
Постоянный lifecycle `ready/degraded` не заменяет runtime evidence; incomplete wave не даёт empty-success.

`team-directory` владеет query/order/status union и open-intent scope/readEpoch validation.
Desktop sorting сохраняет running first, current project placement, known activity и teamName tie-break.
Hosted sorting использует только доказанные displayName/runtime/opaque key; отсутствующие description/counts не фабрикуются.
Не делать отдельный Dashboard endpoint для runtime summary; существующие D1/N1 owners уже решают этот read flow.
Текущий `running-teams/renderer/index.ts` экспортирует connected `RunningTeamsSection`, но не публичный Desktop
read/model adapter. H2 добавляет этот узкий public seam и рендерит shared running view из общего DashboardScreen;
не импортирует private hook в новый feature и не подменяет экран набором platform-only slots.

## 3. Целевая структура и import boundaries

Предлагаемые новые имена ниже - контракт плана, не утверждение об уже существующих файлах.

```text
src/features/dashboard/
  renderer/index.ts                 # browser-safe public frontend
  renderer/models/                 # только presentation/action contracts
  renderer/hooks/useDashboardInteraction.ts
  renderer/ui/DashboardScreen.tsx
  renderer/ui/DashboardSearch.tsx
  renderer/view-models/             # соединение готовых section models
src/features/recent-projects/
  renderer/hosted.ts                # browser-safe shared view/model/filter exports
  renderer/ui/RecentProjectsSectionView.tsx
  renderer/hooks/useProjectCollectionInteraction.ts
  renderer/models/ProjectCardModel.ts
  contracts/hosted.ts               # явный Hosted wire DTO + strict parsers
  main/composition/createHostedRecentProjectsFeature.ts
  main/adapters/input/http/registerHostedRecentProjectsHttp.ts
  main/adapters/output/             # scoped sources / safe presenter / root-resolution port
src/features/command-search/
  renderer/index.ts                 # browser-safe palette UI + interaction
  renderer/hooks/useCommandSearch.ts
  renderer/models/                  # supported modes, result facts, navigation intent
  renderer/ui/CommandSearchDialog.tsx
src/renderer/composition/dashboard/ # Desktop source + navigation + extensions
src/renderer/hosted/dashboard/      # Hosted source + navigation + shell wiring
```

Не создавать `core/main/preload` в `dashboard` или `command-search` без принадлежащего им use case.
Recent Projects уже full slice и остаётся owner своего merge/read/domain, transport contracts и HTTP wiring.
Dashboard собирает section models через public surfaces, а не импортирует private hooks соседнего feature.
`recent-projects` не импортирует `dashboard`: направление зависит от источника к presentation, без feature cycle.
Общий Dashboard реально рендерит search/running/projects; произвольные `children` для каждого блока не заменяют shared UI.
Допускаются два явных shell slots: `environmentNotices` и `environmentTools` для native/hosted extensions.

```text
Desktop composition -> dashboard/renderer <- Hosted composition
                     -> recent-projects/renderer/hosted
                     -> running-teams/renderer/hosted
Palette composition -> command-search/renderer
                     -> team-directory/renderer (готовые read/navigation semantics)
Desktop adapter -> IPC/preload             Hosted adapter -> HTTP + existing SSE owner
```

Shared code не импортирует `@renderer/store`, `@renderer/api`, `window.electronAPI`, `App`, native hooks или session store.
Нельзя добавить alias/stub/no-op для прохождения graph guard. Public barrel проверяется transitive, включая dynamic imports.
Обычные pure CSS/UI/date/localization helpers допустимы после проверки их реальных dependencies.

## 4. Контракты: support, availability, facts

Три понятия имеют разные owners:

| Понятие | Owner | Пример |
|---|---|---|
| Support | Принятый product scope + composition contract | Hosted не поддерживает native folder reveal |
| Availability | Текущий transport/authority/selection state | Workspace select поддержан, но auth check или mount временно недоступен |
| Knowledge | Конкретный read snapshot | Runtime работает, но число tasks неизвестно |

Не кодировать все три в `isElectron`, `disabled` или truthiness callback.
Типы иллюстративные; реальные `WorkspaceId`, `TeamId`, `BootId`, revisions брать из существующих contracts.

```ts
type Fact<T> =
  | { kind: 'known'; value: T }
  | { kind: 'unknown'; reason: 'not_provided' | 'partial' | 'read_failed' };
type ActionState =
  | { support: 'unsupported'; reason: 'native_only' | 'outside_scope' }
  | { support: 'supported'; availability: 'checking' }
  | { support: 'supported'; availability: 'unavailable'; reason: string }
  | { support: 'supported'; availability: 'available' };
interface ViewIdentity {
  scopeKey: string;           // непрозрачный ключ, не путь
  targetKey: string;          // lookup в текущем adapter snapshot
  readEpoch: number;          // локальный epoch; не server resource revision
}
interface ProjectCardModel {
  identity: ViewIdentity;
  name: string;
  subtitle?: string;          // Desktop display path либо Hosted safe workspace label
  activity: Fact<{ observedAt: number; freshness: 'fresh' | 'stale'; confirmedAt: number }>;
  providers: Fact<readonly { id: string; freshness: 'fresh' | 'stale' }[]>;
  branch: Fact<string>;
  taskCounts: Fact<{ pending: number; inProgress: number; completed: number }>;
  activeTeams: Fact<readonly { targetKey: string; displayName: string }[]>;
  open: ActionState;
  reveal: ActionState;
  desktopPathDetails?: readonly { label: string; text: string }[];
}
interface CollectionRead<T> {
  scopeKey: string;
  readEpoch: number;
  rows: readonly T[];
  phase: 'initial_loading' | 'ready' | 'refreshing' | 'failed';
  completeness: 'complete' | 'partial';
  stale: boolean;             // хотя бы один retained fact stale; card сохраняет точную per-source freshness
  message?: string;          // безопасный пользовательский текст
}
```

`desktopPathDetails` - данные presentation, никогда transport target; Hosted mapper не заполняет их.
Не экспортировать `DashboardRecentProject`/`TeamSummary` внутри общего card model или callback.
Provider IDs нормализовать на boundary; неизвестный badge не рисует Gemini и не доказывает source completeness.
`known:0` рисуется как ноль только там, где это полезно; `unknown` не создаёт progressbar или ложный offline.
`lastActivity` должен быть конечным epoch ms; invalid/future timestamp обрабатывается без исключения date formatter.

### 4.1. Узкие actions и результат открытия

```ts
type OpenResult =
  | { kind: 'opened' }
  | { kind: 'cancelled' }
  | { kind: 'stale_target' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'failed'; message: string };
interface DashboardNavigation {
  openProject(intent: ViewIdentity): Promise<OpenResult>;
  openTeam(intent: ViewIdentity): Promise<OpenResult>;
  openChooser(): void;
}
interface DesktopDashboardExtensions {
  selectFolder?: () => Promise<OpenResult>;
  revealProject?: (intent: ViewIdentity) => Promise<OpenResult>;
  openSessionPalette: () => void;
}
```

Desktop extensions не входят в обязательный Hosted adapter interface. Unsupported action не имеет зарегистрированного effect.
Общий hook блокирует повторное open того же intent до settlement и показывает доступный row-level статус.
Adapter перед effect повторно проверяет актуальные scope, epoch, target и availability: UI disabled не является authorization.
`cancelled` выбора папки не ошибка; `opened` разрешено только после подтверждённого navigation admission.
Navigation error не прячется в logger; local raw exceptions не попадают в Hosted текст.

### 4.2. Граница состояния

| Состояние | Место | Lifetime |
|---|---|---|
| Query, clear, visible count, focus anchor | Shared renderer hooks | Mounted dashboard в данном scope; reset по смене scope |
| Palette query/index/mode/read generation | `command-search` interaction | Открытая palette; close отменяет read, не серверные команды |
| DTO cache, stale read, source retries | Feature read adapter/session | Auth/context scope; хранит только разрешённые данные |
| Selected workspace/team и navigation view | Composition root | App session; validated against latest directory/registry |
| Hosted grant/auth, source generations/revisions | Существующие feature authorities + server-only hash/root resolver | Сервер и authenticated shell |
| Create/non-create unresolved intent | Доставленные F2 registries/handles | Не зависит от Dashboard или palette mount |
| Native provider status/update/install | Desktop banner owners | Существующий Desktop lifecycle |

Dashboard hook не вызывает network на каждый символ: фильтрация уже загруженных карточек локальная.
Не хранить Hosted query, command bodies, idempotency keys, receipts или pending locators в `localStorage`.
Desktop open-history сохраняется; чистая ranking policy получает историю как input, а не читает storage сама.
Hosted history по умолчанию только в памяти authenticated session. Reload не обещает перенос локального open priority.

## 5. Source-to-target migration map

| Текущий source | Цель | Сохраняемый invariant / удаляемая duplication |
|---|---|---|
| `DashboardView.CommandSearch` | `dashboard/renderer/ui/DashboardSearch` + interaction hook | Одна query/clear/focus policy; shortcut принадлежит active shell |
| `DashboardView` layout | `dashboard/renderer/ui/DashboardScreen` | Один markup section ordering/responsive; Desktop wrapper становится composition |
| `RecentProjectsSection` | Shared view + existing Desktop connector | UI больше не обращается к store; error/load more поведение едино |
| `RecentProjectCard` | Shared normalized card view | Rich Desktop facts остаются; Hosted не получает path action |
| `useRecentProjectsSection` | Desktop read adapter + shared collection interaction | Cache/context/provisioning отдельно от filter/visible limit |
| `useOpenRecentProject` | Desktop navigation adapter | Worktree/synthetic path/session behavior остаётся Desktop |
| `recentProjectOpenHistory` | Desktop repository adapter + pure priority function | Existing 48 h/120 limits и storage key не теряются |
| `registerRecentProjectsHttp` Hosted branch | Explicit Hosted facade/DTO registration | Удалить legacy opaque-ID-as-path masquerade на Hosted path |
| `createRecentProjectsFeature` | Сохранить Desktop; добавить scoped Hosted composition | Те же merge semantics, разные admitted sources/presenter |
| `HostedRunningTeamsSection` | Узкий Hosted model adapter, view в общем Dashboard | Нет второй ranking policy или directory wave |
| `HostedTeamWorkspace` | Stable workspace read boundary + explicit dashboard/chooser/team views | Один directory session и workspace-scope event owner; team-scope owner остаётся для task/message; F2 registry выше mounts |
| `HostedApplicationShell` | Home/dashboard navigation, registry admission, notices | Не дублировать auth revalidation или терять selected scope |
| `CommandPalette` | Desktop connector + `command-search` common presentation/interaction | Desktop sessions и anchors сохраняются; Hosted navigation results реальны |
| `TeamListView`, `HostedTeamLifecycleList` | Существующие N1 public owners | Только передача intent/selection, без повторного rewrite chooser |
| Native banners | Desktop `environmentNotices` / tools | Имеющиеся listeners не попадают в Hosted bundle |

Удалять старую активную filter/open/focus policy в том же checkpoint, где подключены её реальные consumers.
Тонкий legacy delegate допустим. Две постоянно действующие state machines под feature flag - недопустимый финал.

## 6. Hosted Recent Projects: конкретный backend slice

### 6.1. Источник и identity

Список Recent Projects означает recent **подтверждённую активность**, а не все зарегистрированные workspace.
Дополнительно явное действие «All workspaces» открывает существующий registry chooser, включая workspace без активности.
Это сохраняет полезный first-use путь и не переименовывает registry в recent list.

**Hash не является path, но path уже есть в authenticated bootstrap.**
`deploy/hosted-launcher/lib/admission.mjs` вычисляет `declaredRootHash = sha256(Buffer.from(workspaceRoot))`
и подписанный/digest-bound `runtimeInstance.workspaceRoots` содержит этот root. H0 фиксирует server-only
`AdmittedWorkspaceRootResolver(snapshot, runtimeInstance)` без новой bootstrap schema: `admitHostedReadRoot`
проверяет каждую абсолютную нормализованную reference, resolver строит hash -> roots и сопоставляет её с
`WorkspaceRegistration.declaredRootHash`. **Каждая** registration, включая disabled/tombstone и denied,
должна иметь ровно один hash match для полной карты границ; иначе весь recent read unavailable, потому что
нельзя исключить скрытый nested root внутри разрешённого parent. Для usable binding дополнительно требуются
boot/generation текущего snapshot и доступный mount; collision/duplicate/unmounted root даёт unavailable.
Само совпадение hash не выдаёт grant: public workspace ID разрешается отдельно через existing auth authority.
Не добавлять поля в `WorkspaceRegistration`, `TeamLifecycleReadBootstrapSource` strict parser, browser DTO или grant DB.
Production personal launcher уже монтирует workspace same-path через `deploy/hosted-launcher/compose.personal-host.yml`;
base Compose сама этого mount не даёт. H0 фиксирует personal + E2E конфигурацию; H3a реализует resolver
и его read-only consumer. Для нескольких workspace personal launcher должен
выдать все roots/registrations в existing signed fields и смонтировать каждый exact path; новых bootstrap keys нет.
H3a расширяет `createSessionIdentity`/sandbox producer на bounded список workspace, оставляя top-level
`workspaceId` и Owner mountBinding за текущим A; все дополнительные bindings используют тот же boot, собственные
revision/generation/hash и не получают Owner write authority. Existing single-root launcher input остаётся совместимым.

**Сначала ownership, затем grant:** минимальный cwd сопоставляется с **полным server-only registry/root map**,
включая denied и disabled registrations, до principal projection. Для cwd нужен абсолютный canonical `realpath`
существующего каталога и path-segment containment (не строковый prefix); symlink escape отбрасывается.
Выбирается deepest containing root по segment
boundary; если deepest root принадлежит C без grant/disabled/unavailable, факт отбрасывается и **не падает назад**
к разрешённому parent A. При ambiguity root map весь read unavailable; при невалидном cwd факт отбрасывается;
неизвестный nested root без регистрации остаётся частью A по declared containment. Только после выбора exact
runtime workspace ID проверяется live grant. Ни activity timestamp, provider fact, cache entry, partial completeness,
error или count C не меняют A. Worktree вне root получает отдельную карточку только с собственным binding/grant;
repo/remote не объединяют workspace. Правило одинаково для Claude и Codex и выполняется до aggregation.

H3a вводит **новые Hosted-only readers**, использующие существующие bounded JSONL header/time parsers, но не
`ClaudeRecentProjectsSourceAdapter`, `ProjectScanner.scanWithWorktreeGrouping`, `WorktreeGrouper`,
`CodexSessionFileRecentProjectsSourceAdapter.list()` или `RecentProjectIdentityResolver` как готовый Hosted source.
Claude reader перечисляет только mounted `.claude/projects`, читает bounded header для authoritative cwd и после
root admission использует mtime/activity; decoded directory fallback без cwd не допускается. Codex reader
перечисляет только mounted `sessions`/`archived_sessions`, читает bounded session_meta header для cwd/source/time,
проводит root admission **до** dedupe по cwd, top-N cap, cache и любого filesystem/Git enrichment.
Discovery/stat ограничены этими metadata mounts, а cache хранит только admitted per-workspace records под
authority fingerprint; глобальный Desktop cache не используется. Не читать тела transcripts, remote/config/auth,
не логировать cwd/filenames, не запускать CLI/app-server. Превышение budget даёт partial, не complete empty.

Read algorithm: authenticate -> capture grant/registry/bootstrap fence -> resolve **all registered roots** ->
read minimal headers -> canonicalize and assign each fact to deepest registered workspace -> check exact grant ->
aggregate максимум timestamp
по `(runtimeWorkspaceId, provider)` -> project public ID/label -> revalidate grant + boot/revision/mount/root fence
перед response **и каждым cache hit**. `ListDashboardRecentProjectsUseCase` и Desktop merge остаются без изменений;
Hosted facade имеет отдельную per-workspace aggregation, safe presenter и bounded cache (текущий scope,
не универсальный LRU). Недоказанный root или storage failure не превращается в пустую успешную выборку.

Metadata mounts для Claude и Codex являются read-only **только** указанными subtrees, без целого `CODEX_HOME`,
`auth.json` или provider credentials. Existing `/data/.claude` RO mount покрывает Claude projects в personal
production composition и E2E. Codex получает **два** RO bind mounts только для sessions и
archived_sessions с target `/data/codex-metadata/{sessions,archived_sessions}` и явным configured host source;
те же targets/RO flags у personal и E2E marker-owned fixtures. `CODEX_HOME` не задаётся на credential home;
Hosted reader получает эти paths явной конфигурацией. Если Codex mounts не настроены, profile стартует без них и
помечает source unavailable. Existing personal same-path workspace mount сохраняется; для personal multi-root
нужен generated launcher mount с точным signed path. E2E сохраняет writable lifecycle fixture другим owners.
H0 документирует host vars и mount layout;
H3b включает compose wiring. Если Codex metadata mount не задан, source явно `unavailable` и ответ partial;
двух-provider E2E/gate проходит только в profile с обоими mounts и fixture metadata. Один Claude-only profile
не может служить доказательством полной provider coverage.

Claude/Codex activity читается из реально доступных session metadata; не запускать CLI или app-server ради Dashboard.
OpenCode recent source отсутствует в текущем feature: не придумывать ему timestamp из статуса running.
Новый OpenCode activity source нужен только отдельным следующим parity slice, когда Desktop тоже предоставляет такой источник.
Hosted поддержка OpenCode team runtime остаётся неизменной независимо от coverage Recent Projects.

### 6.2. DTO и route

Предлагаемый route: `POST /api/hosted/v1/dashboard/recent-projects`, body `{schemaVersion: 1}`.
Выбран POST-query, как registry/list: cookie credentials, CSRF и Origin проверяются действующим Hosted middleware.
Добавить точное authorization правило; не расширять wildcard `/api/*` и не принимать path/URL/root из browser.

```ts
interface HostedRecentProjectDto {
  workspaceId: WorkspaceId;
  label: string;              // registry-generated safe label: текущий контракт Workspace N
  registrationRevision: number;
  mountGeneration: number;
  sources: readonly {
    provider: 'anthropic' | 'codex';
    observedAt: number;       // timestamp из admitted metadata
    confirmedAt: number;      // server read time последнего успешного source read
    freshness: 'fresh' | 'stale';
  }[];                         // 1-2 facts; карточка существует только при наличии fact
  openAvailability: 'available' | 'mount_unavailable';
}
type HostedRecentProjectsResult =
  | { schemaVersion: 1; kind: 'recent-projects';
      deploymentId: DeploymentId; bootId: BootId;
      readAt: number;
      completeness: 'complete' | 'partial';
      projects: readonly HostedRecentProjectDto[] }
  | { schemaVersion: 1; kind: 'unavailable'; code: 'source_unavailable' | 'authority_changed' };
```

Использовать существующие branded parsers/limits; decoder exact-key, bounded arrays, unique workspace IDs/providers,
finite nonfuture timestamps (`observedAt <= confirmedAt <= readAt`, с bounded clock skew policy).
DTO сознательно не содержит path, synthetic target, Git remote, branch или `TeamSummary`.
Activity UI вычисляет из максимального `sources.observedAt`, не из текущего registry; badge получает freshness своего
source. Если более новая activity stale, общий activity stale, даже если другой provider fresh. Отсутствие activity
оставляет workspace в All Workspaces, не создаёт fake recent row.
Task counts/branch/active teams не добавлять в wire без отдельного authoritative источника; UI уже умеет unknown.
Эти поля можно обогатить фактами текущего выбранного workspace из существующих reads, без N workspace fan-out.
Формат label по текущему registry - `Workspace N`; красивые repo names требуют изменения privacy/display-name контракта.

**Legacy route:** в Hosted registration запретить старый GET через точный authorization policy и не монтировать его как обход.
В non-Hosted HTTP/IPC сохранить старый DTO для Desktop/legacy consumers. Состав server routes проверяет это различие.
Не оставлять два браузерных recent API с разными redaction semantics. Нет shipped Hosted wire, требующего вечного dual support.
Существующий standalone recent facade можно переиспользовать только после scoped mapping; простой cast запрещён.

### 6.3. Stale, cache и update

- Initial load: skeleton, затем rows/empty/error; partial-empty показывает недоступные источники, а не «нет проектов».
- Cached rows после network failure остаются stale, если текущая authority подтверждена; 401 сначала revalidation.
- `completeness` относится к покрытию источников, `freshness` - к происхождению **каждого** source fact.
  Complete + fresh facts = полный read; partial + fresh Claude/stale Codex или наоборот = честный смешанный read;
  partial + только stale facts = last-known rows; partial + `projects: []` = недоступность, не «нет проектов».
  Stale rows показываются с последним `confirmedAt`; source refresh переводит только его facts в fresh. Даже обычный
  TTL cache сохраняет исходные `confirmedAt` и freshness, не подменяет их временем cache hit.
- Успешный grant refresh без workspace удаляет её rows/target map; cache не переживает principal/deployment reset.
- Read response проверяется по local request generation + deployment/boot + актуальному registration/mount snapshot.
- Workspace-scope SSE invalidation только помечает существующий recent source dirty через workspace owner;
  team-scope task/message owner остаётся отдельным, новый EventSource не открывается.
- Event payload не заменяет query DTO; duplicate invalidation coalesces в один pending read плюс один trailing refresh.
- Пока нет доказанного event для provider session metadata, refresh on entry/focus и bounded existing TTL честнее обещания realtime.
- Degraded retry использует существующие 30 s первые три попытки, затем 120 s; timers выключены для inactive/disposed source.
- Hosted facade не возвращает старый complete payload как fresh: fallback клонирует admitted facts с
  `freshness:'stale'`, оставляет исходный `confirmedAt`, ставит `completeness:'partial'` и новый `readAt`.
  Common Desktop use case/presenter не меняет форму ответа. После grant/root fence loss stale facts запрещены.

### 6.4. Открытие проекта

Card click содержит только `ViewIdentity`; Hosted adapter находит canonical workspace в актуальном authorized snapshot.
Затем вызывает существующий registry `select(workspaceId)` и принимает возвращённый workspace/mount state.
Перед вызовом capture `{publicWorkspaceId, deploymentId, bootId, registrationRevision, mountGeneration,
requestGeneration, authorityEpoch}` из текущего registry + recent snapshot. Поскольку wire select request содержит
только `workspaceId`, **сервер не выполняет selection side effect**: это admission read, а выбор хранит shell.
После ACK сравнить response `workspaceId`, `registrationRevision`, `mount.bootId`, `mount.mountGeneration` с capture,
а также текущие deployment/boot/authority epoch, актуальный registry row и request generation. Любое несовпадение
даёт `stale_target`, повторный registry read и новый explicit click; нельзя переходить по старому ACK.
Только после совпавшего ACK shell ставит selection и открывает chooser.
Ошибка switch не удаляет прежнюю workspace; row получает понятную ошибку/Retry, late A response не переключает уже выбранную B.
Повтор click пока selection pending не создаёт второй request. Abort/timeout разрешается новым registry list и select
без recovery server effect, поскольку select ничего не мутирует.
После успешного open записать memory-only open priority; при failed/cancelled не менять сортировку.

### 6.5. Multi-root promotion и directory read - обязательный H3 checkpoint

Multi-root fixture не работает на текущем backend только от нового Dashboard route. В
`createStandalonePromotionStorage.ts` при `workspaceRoots.length !== 1` `promotionRoot` становится `null` и
promotion отключается. H3a меняет **только выбор root**: admit/normalize каждую signed
`runtimeInstance.workspaceRoots` reference, выбрать ровно одну с
`sha256(UTF-8 root) === current mountBinding.declaredRootHash`, затем выполнить существующие проверки
`draftPublicationAvailable`, `health === healthy`, boot/authority/restoreGeneration и прежний storage init.
Ноль или больше одного match, invalid path/hash или чужой mount - fail closed без выбора первого root.
Это не расширяет promotion на B: writer по-прежнему закреплён за current signed mountBinding A.
Тесты A/B и ambiguous match доказывают, что storage выбирает A и не открывает B; existing single-root gate остаётся.

`standalone.ts` сейчас передаёт в `createMountBindingScopedTeamLifecycleReadPorts` только
`bootstrap.mountBinding`, а `MountBindingScopedIdentityGateway` в `teamLifecycleReadComposition.ts` фильтрует
все team identities не этого workspace. Renderer затем фильтрует пустой список B и ошибочно считает его fresh.
H3c создаёт bounded **read-only** composition per enabled/current-boot binding из admitted registry snapshot,
используя прежний `createTeamLifecycleReadAuthority`/scoped ports для каждого binding и общий durable identity
gateway; никакого writer/promotion authority для B. Новый Hosted-only scoped list route принимает
`{schemaVersion, publicWorkspaceId, cursor, expectedRevision}`. HTTP до dispatch разрешает public -> runtime ID
через existing grant, берёт exact per-binding host, после read повторяет grant + boot/mount/revision fence и
проверяет, что все returned items принадлежат этому runtime workspace. Отсутствующий/unavailable binding даёт
typed unavailable, не `success: []`. Existing unscoped canonical route и его контракт не расширяются для
browser selection; Hosted directory transport замыкает выбранный public workspace ID на scoped route, сохраняя
один `useHostedTeamDirectorySource`/runtime wave. Cursor/revision остаются внутри одной workspace; A cursor
нельзя применить к B. При A -> B -> A session/read epoch делает поздний ответ B недействительным.

`resolveHostedTeamWorkspaceId` и downstream team read surfaces не должны остаться на A-only host: durable
identity `workspaceBinding.workspaceId` выбирает per-binding read host, а response/identity checksum сверяются
с тем же binding до attribution; team-message/task read adapters получают тот же exact binding только через
existing authorization, без нового send/write владельца. Если B downstream read нельзя допустить, его team
target показывает `unavailable` и не выдаёт `opened`; H6 не считает такой journey полным Dashboard target.
В sandbox создать реальные team identities/summary/runtime fixtures в A и B, проверить непустой chooser и
open team в обоих scopes, auth isolation, pagination/cursor и unavailable при потерянном B binding.

### 6.6. Workspace/team capabilities и effect fence

`HostedWorkspaceDto.mount.capabilities` сейчас содержит **только Git** operations; он не разрешает config,
promotion, lifecycle, task, message или operator effect. `HostedTeamWorkspace` сейчас монтирует
`HostedTeamLifecycleControls` и `HostedTeamConfigurationPanel` по глобальному `authEffectsAvailable`, поэтому
после read-only B dispatch нельзя оставить этот prop как write admission. H3d добавляет отдельный read-only
access projection для выбранного `(publicWorkspaceId, optional publicTeamId)` с exact-key DTO:
`{deploymentId, bootId, registrationRevision, mountGeneration, grantRevision, teamIdentityRevision?,
capabilities[]}`. Capabilities - `directory.read`, `team.open`, `configuration.read`,
`configuration.write`, `promotion.execute`, `lifecycle.command`, `task.read`, `task.write`,
`message.read`, `message.send`, `operator.control`. Snapshot выдаёт server composition после live grant,
binding health и team attribution; не выводится из Git capabilities, роли или local `selectedWorkspaceId`.
Точный team target и team-level grant нужны для каждого team capability; без team ID остаются только workspace
reads и `configuration.write` создания в owner A. При смене team/workspace или fence snapshot отменяется.

Для B по умолчанию выдаются `directory.read`, `team.open` и лишь те `configuration.read`/`task.read`/
`message.read`, для которых H3c реально подготовил exact per-binding read port. **Никаких write/operator caps B**.
Для A `configuration.write` требует current Owner mount, healthy binding, draft publication и live grant;
`promotion.execute` дополнительно требует выбранный current promotion root/storage и Owner fence;
`lifecycle.command` - текущий Owner lease/ready и exact team binding; `task.write` - существующий
controller task authority; `message.send` - существующий message relay authority; `operator.control` -
существующее permission policy для `owner/admin/member/viewer` и current Owner binding, без новой роли
`operator`. Это только уже принятые Core actions; manual approval, post-creation roster administration и
advanced diagnostics остаются deferred. Каждая capability исчезает независимо при недоступности её owner;
ни одна не выдаётся из одного факта `health:healthy` или registry grant. Backend route повторно проверяет свой
grant/binding/owner fence **перед effect**; UI snapshot не является authorization token.

H4 принимает этот snapshot в Hosted shell и передаёт явные scoped access flags: не монтирует configuration
create/delete/promote и lifecycle controls для B, не создаёт F2 create intent, не показывает task mutation и
message send controls без соответствующего team capability. Read-only task/message panels показывают данные
лишь при `*.read`, иначе честное unavailable; `team.open` становится `opened` только при допущенных read
surfaces. Pending click/effect захватывает workspace/team ID и весь fence; после A->B, grant revoke, remount,
owner loss или late response не запускает эффект и не применяет receipt в другом scope. F2 unresolved A intent
остаётся в existing registry, но B не получает его commands. H6 проверяет на реальных A/B scopes отсутствие
у B кнопок/listeners/HTTP write requests и серверный отказ forged B writes по каждому семейству; A сохраняет
доказанные owner-bound actions и их прежние receipts.

### 6.7. Durable multi-root provisioning

Baseline personal launcher **не принимает список**: `config.mjs` читает `workspaceRoot`, `state.mjs` хранит один
`workspaceId`, `admission.mjs` выпускает один `personal.main`, `compose.mjs` устанавливает
`HOSTED_WORKSPACE_IDS=state.workspaceId`, а override монтирует один same-path root. H3a расширяет operator config
до bounded `workspaces: [{registrationKey, root}]` + `ownerRegistrationKey`; root - абсолютный canonical host path,
ключ уникален, owner key обязателен и не меняется неявно. Вместо случайных IDs при каждом boot durable state v2
хранит `registrationKey -> {workspaceId, canonicalRoot, declaredRootHash, enabled/tombstone, registrationRevision,
mountGeneration}` под существующим state lock и atomic write. Reorder config не меняет ID/revision; rootHash
закрепляется навсегда за key и ID, а public grants остаются привязаны к тому же runtime ID. Новый key получает
новый ID; старый ID никогда не переиспользуется. Remove создаёт tombstone с monotonic revision, но не удаляет
record; re-add того же key **только с тем же hash** возвращает прежний ID и повышает revision/generation;
замена root требует нового key/ID и явного regrant. Указание прежнего key с другим root отклоняется до start,
не ретаргетит старые grants. Все enabled mount generations растут при новом signed boot, owner generation и
restoreGeneration сохраняют текущие monotonic rules; failed start не переиспользует выданную generation.

V1 single-root state мигрирует в v2 **один раз**: `personal.main` получает существующий `state.workspaceId`, а
не новый ID. Durable `stateDir/session.env` содержит launcher-issued bootstrap после записи session env;
`stopPair` удаляет `/run/owner-gN`, но не этот файл. Файл может быть записан до неудачного
`compose.startProduct`, поэтому сам по себе не доказывает успешный boot. Migration читает его только как launcher-owned regular file
с проверкой uid/mode/size, извлекает exact bootstrap, сверяет deployment/workspace ID, root hash и
mountGeneration (не больше persisted state; пропущенные reserved generations допустимы) с v1 `state.json` и текущим config root. При доступном `/run`
дополнительно проверяет signed admission; после обычного stop/reboot отсутствие `/run` не блокирует миграцию,
если durable session.env и state совпали. Если `mountGeneration===0` и успешной session ещё не было,
первый config root может зафиксировать hash. При stale/missing/corrupt session.env у уже запускавшегося v1
нужен явный operator recovery с доказанным исходным root; молчаливого retarget нет. Migration под lock сначала
пишет immutable root-pin/evidence в stateDir, затем v2 state; crash между ними возобновляет сверку pin.
`writeState` проверяет identity/key/hash invariants и monotonic
revision/generation под lock до атомарной замены. Тесты restart: reorder A/B, remove B, re-add B same root,
replace B root under new key, ordinary stop->upgrade->start, reboot без `/run`, stale session.env/state,
grant continuity/revocation и no-ID-reuse. После v2 write rollback выключает B activation и оставляет v2
state: старый v1 launcher его не читает. До первого v2 boot можно восстановить сохранённый v1 snapshot только
если counters не продвинулись; после первого v2 boot нужен v2-compatible launcher rollback, без downgrade state.
V1->v2 migration здесь защищает существующие personal workspace IDs/grants, а не добавляет общую совместимость
с невыпущенными Hosted форматами. `readState` сейчас ограничен 16 KiB: schema v2 получает явный размерный budget,
согласованный с максимумом registrations, и bounded parse/write; не оставлять limit ниже допустимого state.

Personal producer: operator config -> state v2 allocation -> signed existing-field `workspaceRoots` + manifest
для всех enabled/tombstone boundaries (root path tombstone хранится в durable state; active mount ему не нужен,
но он участвует в deepest-root exclusion) -> generated launcher-owned
Compose override с exact same-path bind mounts для enabled roots -> `HOSTED_WORKSPACE_IDS` как sorted
comma list enabled runtime IDs -> Product auth `seedWorkspaces`
-> явное per-user grant через существующий local-control `grantWorkspace` -> registry projection.
Config file/env пользователя не может подменить launcher-owned IDs, mounts или bootstrap. **Grant/seed B ещё не
делает B видимым:** H3b вводит launcher-owned `HOSTED_DASHBOARD_MULTI_ROOT_ACTIVE` (default false),
связанный с текущим signed boot/deployment, как server-only `A-only` fence в registry list **и select**,
recent route, scoped directory и access projection. До H3d backend fences + H4 UI gating/точных тестов даже
заранее выданный B grant остаётся невыбираемым через любой Hosted entrypoint; новый frontend не рекламирует B.
H6 активирует B только на проверенном exact SHA одним launcher-owned boot/config switch и Product restart:
старый process обслуживает A-only, новый - полный admitted set; generation/boot меняются. Rollback тем же
switch/restart скрывает B также из старых registry list/select, очищает B cache/targets и сохраняет A/F2 state.
Client-only flag/скрытая кнопка не является защитой. Ключ добавить в `LAUNCHER_OWNED_COMPOSE_KEYS`;
activation не принимает browser и operator compose env.
При регистрации существующих roots не копировать `init`-овский `ensureDirectory`: он меняет owner/mode.
Read-only проверка canonical path, ownership и mount допуска отделена от provisioning и не меняет права
пользовательских проектов.

Keycloak/OIDC остаётся deferred boundary из scope lock: существующий profile и generic contracts сохраняются,
но отдельный multi-root producer, grants, Compose override и Keycloak E2E/release gate **не входят** в H0-H6.
Его поздний slice обязан соблюдать те же durable IDs, admission/capability fences и privacy DTO; текущий план
не объявляет Keycloak production parity. Personal producer и sandbox проходят restart/grant fixtures.

## 7. Desktop adapter: точный preservation contract

Desktop composition передаёт source snapshot и actions, привязанные к captured `activeContextId`/request epoch.
Mutable global API после переключения local/SSH не используется старым intent без повторного context check.

Обязательно сохранить:

- `existing-worktree`: existing navigation state, initial sessions fetch, `openTeamsTab(projectPath)`.
- `synthetic-path`: поиск existing group, refresh, повторный поиск, затем add custom project path и synthetic group.
- Ephemeral path rejection и deleted project refusal; paths не преобразуются в opaque IDs внутри Desktop storage.
- Native picker cancel без ошибки; reveal не открывает chooser и не увеличивает recent-open ranking.
- Global task counts, alive/provisioning teams, provider badges, branch, related-path tooltip и local open history.
- Initial 11 cards, load more +8, все совпадения при непустом query; clear сбрасывает display limit.
- 15/30 s client cache и 10/30 s source cache semantics до доказанной необходимости изменения.
- Native updater, provider CLI/install/auth/catalog/rate-limit controls и platform warnings через Desktop slots.

Общий view может изменить wrapper markup для a11y/responsive; это не причина удалить богатые данные или заменить их zeros.
Existing swallowed navigation exceptions преобразовать в `OpenResult.failed`, оставив безопасный diagnostic в Desktop logger.
Не добавлять новый generic service locator или объект из сотни Electron методов. Adapter имеет только нужные read/open функции.

## 8. Общие search и palette interaction

### 8.1. Inline Dashboard search

Одна строка query принадлежит `useDashboardInteraction`; trimming/case folding производится в общей pure filter policy.
Recent source предоставляет только разрешённые search tokens: Desktop name/path/associated paths/branch; Hosted label.
Running source предоставляет текущие безопасные display fields; не искать Hosted по скрытым server paths.
Пробелы эквивалентны пустому query. Query не отправляется в сеть и не вызывает новую runtime evidence wave.
H2 удаляет query из read lifetime `useRunningTeamsSection`, иначе фильтрация продолжит обнулять rows и отменять alive read.
Clear возвращает фокус в input, сбрасывает pagination, но не выбранную workspace/team.
«No matches» отличается от complete empty, partial source и failed read; counts не обещают total unseen records.
Не фильтровать только первые 11 карточек: сначала filter complete loaded collection, потом display limit для empty query.

### 8.2. Общая palette и различия режимов

```ts
type PaletteMode = 'projects' | 'teams' | 'sessions';
interface PaletteResult {
  key: string;
  title: string;
  subtitle?: string;
  intent: ViewIdentity;       // adapter-owned target map; не path
  secondaryText?: string;
}
interface PaletteSource {
  supportedModes: readonly PaletteMode[];
  load(mode: PaletteMode, query: string, signal: AbortSignal): Promise<{
    rows: readonly PaletteResult[]; partial: boolean; total: Fact<number>;
  }>;
  open(mode: PaletteMode, intent: ViewIdentity): Promise<OpenResult>;
}
```

Это feature-sized port для двух реальных consumers, не универсальный command bus.
Rich session renderer может получать отдельный typed session-result model; нельзя flatten и потерять exact match anchors.
Общими становятся dialog/focus/keyboard/loading/error/late-read protection; backend search strategies остаются adapters.

| Сценарий | Desktop | Hosted default этого плана |
|---|---|---|
| Cmd/Ctrl+K на Dashboard | Existing project/session mode | Project/workspace navigation palette |
| Search project | Repository groups, name/path, existing 10-result limit | Safe authorized recent + All Workspaces label matches, local filter |
| Выбор проекта | Выбрать repo, переключить palette в sessions | Registry select, затем teams этого workspace в palette/chooser |
| Team result | Использовать N1 если exposed в Dashboard navigation | N1 directory results, scope/read epoch fence, открыть team |
| Session search | 400 ms, >=2 chars, 50 results, exact anchors | Unsupported: режим/shortcut G не монтируется |
| Global session search | Существующая Cmd/Ctrl+G функция | Не рекламируется; не вызывает legacy search endpoint |

Таким образом Hosted project/team search конкретно реализуется; это не обещание полного session UI без backend acceptance.
Если отдельно выбрана session parity, нужен другой slice: scoped search DTO, pagination/partial, viewer, anchors и privacy tests.
Рекомендуемый default здесь - сохранить Desktop sessions, дать Hosted workspace/team navigation и ясные mode labels.

### 8.3. Keyboard и focus

- Один shortcut listener в active shell; `isActive=false`, modal и composing input не запускают второй action.
- Использовать Radix Dialog и общие Input/Button/Tooltip primitives; title/description и focus return обязательны.
- Escape закрывает palette; arrows не дают index -1 при пустом списке; Enter без selected result ничего не делает.
- IME Enter/arrows принадлежат IME; browser refresh/history shortcuts не переопределяются.
- Loading нового query сразу сбрасывает старые results/selection; ответ A после B не принимает ни rows, ни error.
- Desktop initial autofocus сохраняется только при активном Dashboard без открытого overlay; убрать 50 ms focus stealing.
- Hosted на touch viewport не открывает клавиатуру автоматически. Desktop/touch различие задаёт shell focus policy.
- После refresh удалённой focused row фокус переводится на section heading/next row; stable IDs удерживают обычный фокус.

## 9. Dashboard UX matrix

| Секция/действие | Shared frontend | Desktop | Hosted | Приёмка |
|---|---|---|---|---|
| Page layout | Один `DashboardScreen`, тот же порядок общих sections | Native notices/tools slots | Access/reconnect notices slots | Одинаковые fixture facts дают одинаковый общий markup |
| Select team | Одна кнопка/action label | Existing teams tab/context | Current workspace chooser; без scope сначала workspace selection | Переход не запускает команду или runtime |
| Search/clear | Один input/query/filter/empty model | Name/path/branch разрешены | Только public safe fields | Query не создаёт network storm |
| Recent cards | Одна card view/collection | Rich path/provider/branch/count/activity | Safe label/activity и доказанные optional facts | Это activity list; registry-only substitute не принят |
| All workspaces / select folder | Явный extension control | Native picker | Existing registered-workspace chooser | Hosted не открывает native picker и не принимает typed path |
| Open project | Shared pending/error/intent handling | Worktree/session/teams flow | Registry admission -> chooser | Late click не пересекает scope |
| Reveal folder | Явная secondary action карточки | Existing openPath | Unsupported, control отсутствует | No no-op, no hidden listener |
| Running teams | Existing D1 shared view/ranking | Active/provisioning/idle + counts | Positive running evidence; counts unknown при отсутствии source | Unknown не выдаётся за offline/zero |
| Open running team | Shared target intent | Existing team tab | Current directory target -> selected team | Rename/duplicate name не ломает ID |
| Retry | Общие visible states/labels | Existing read ports | Auth-aware HTTP reads | Failed refresh не становится empty-success |
| Provider CLI/status | Desktop extension | Все текущие controls | Только существующие Hosted diagnostics вне общего CLI banner | Нет install/auth methods в browser bundle |
| App update / Windows warning | Desktop extension | Сохранить | Unsupported | Не меняет production Hosting update mechanism |
| Reconnect/access | Shared notice rendering | Context-specific read error | Existing auth + SSE state | Нет второго auth owner или EventSource |
| Loading | Skeleton/count status | Existing cache source | Admitted source state | Нет layout jump в buttons или focus loss |
| Partial/stale | Notice + retained permitted rows | Degraded sources | Missing source/runtime/refresh | Нет false «no projects/no teams» |
| Complete empty | Empty state + usable next action | Select folder | All Workspaces | Отличается от partial-empty |
| Accessibility | Landmarks, labels, status/alert, non-nested buttons | Keyboard/mouse | Keyboard/touch | Нет native title; progress только known |
| Responsive | Один grid/breakpoints | Desktop widths | Browser narrow/wide | 320/768/1280 CSS px, 200% zoom без horizontal page overflow |

Card grid: один столбец на узком viewport, два на среднем, 3/4 при достаточной ширине; min-width:0 и перенос label.
Running grid использует тот же responsive принцип вместо нынешних фиксированных трёх columns в noncompact D1 view.
Не утверждать pixel identity разных platform slots: одинаковым является общий Dashboard workflow и его presentation.
Все новые видимые строки проходят existing localization namespaces; вынесенные legacy English строки включить в bounded migration.

## 10. Security и authority invariants

1. Browser targetKey непрозрачен; navigation map создаётся только из текущего admitted DTO.
2. Никакой path/remote/repository hash не используется как Hosted public ID, query token, tooltip или error detail.
3. New route имеет exact auth policy; Origin/CSRF/cookies/Host checks остаются в существующем middleware.
4. Source mapping проверяет grant до enrichment и снова до response/cache hit; absence и storage failure различны.
5. Registry/mount revision, auth epoch, source generation и local read epoch не сливаются в одно число.
6. Смена source generation не переписывает frozen F2 mutation body/expectedRevision/idempotency identity.
7. Подтверждённый logout/forget/reset/deployment change очищает sensitive view cache и targets; network timeout не является revoke.
8. Ровно один existing workspace-scope subscription/reconciler для lifecycle и ровно один team-scope
   subscription/reconciler для task/message при выбранной team; replay cursors, gap/resync и snapshot handoff
   сохраняются отдельно по scope. Dashboard/chooser не создают duplicate в любом scope.
9. Product не получает write доступ к tasks или новый runtime operation; Owner/controller остаётся единственным task writer.
10. Owner message pump остаётся единственным relay; Dashboard navigation не добавляет side-effect send/launch.
11. New source reader не монтирует provider credentials и не запускает discovery вне sandbox/допущенных roots.
12. Unsupported controls не только скрыты: route/effect/listener отсутствуют либо authority explicitly rejects capability.
13. Existing graph classifier остаётся строгим: no Desktop App/store/broad API/notifications/telemetry/Sentry/terminal/Node/Electron.

## 11. Edge cases и обязательное поведение

| Случай | Поведение | Сильная проверка |
|---|---|---|
| A -> B -> A во время recent read | Поздний A не затирает B; новый A проверяется своим epoch | Hook/composition race test |
| Две карточки с одинаковым именем | ID различны, правильный target | Navigation integration |
| Один repo, разные grants/worktrees | Не объединять authority; excluded path не влияет на DTO | HTTP + source fixture |
| Workspace удалён между list и click | `stale_target`/not found; refresh registry, без fallback path | Hosted adapter test |
| Mount generation сменился | Старый target отклонить; fresh select/read | Route/composition test |
| 401, затем revalidation same identity | Block action, сохранить только ещё допустимые stale facts | Auth integration |
| 403 или 503 без доказанного revoke | Не уничтожать F2 uncertain identity; availability blocked | Existing F2 composition + navigation case |
| Auth identity/deployment изменились | Очистить targets/cache/queries, stop old subscriptions | Shell integration |
| Source timeout с частью rows | Partial notice, working rows; retry не считается empty | Recent facade test |
| Все sources упали после known rows | Stale/partial, явно устаревшие rows | Cache fallback regression |
| Все sources доступны и нет активности | Complete empty + All Workspaces | Shared view test |
| Нет Codex metadata mount | No auth home fallback; Codex unavailable, partial при Claude facts | Production/e2e compose parity + backend admission test |
| Nested roots, sibling и worktree другого grant | Longest admitted root только для данного principal; related repo ничего не добавляет | Root-binding/source fixture до enrichment |
| Stale Claude + fresh Codex в одной row | Per-source freshness/confirmedAt сохранены; activity stale если максимум stale | Hosted DTO/facade test |
| Select ACK после revision/mount/boot change | Старый ACK не переключает shell; registry refresh и новый click | Deferred select response test |
| Invalid activity timestamp | Skip/reject bad source fact, partial; не crash formatter | Contract/source test |
| Future clock timestamp | Bounded display («just now»), не бесконечный priority | Pure ranking test |
| SSE duplicate/gap/reconnect | Existing reconciler, coalesced invalidation, eventual refresh | Один composition event test |
| Slow source, repeated Refresh | Один inflight и максимум один trailing refresh | Read owner test |
| Late palette A success/error после B | Ничего не менять в B | Common interaction test |
| Empty palette + ArrowDown/Enter | Не index -1, нет вызова action | Keyboard test |
| IME composition | Enter подтверждает candidate, не навигацию | Keyboard test |
| Native picker cancel | Без ошибки/записи history | Desktop adapter test |
| Reveal click | Открывает папку один раз, не общий primary action | DOM interaction test |
| Browser back/remount Dashboard | Selection сохранена; F2 registry выше view | Shell integration |
| Team rename/revision change | Open re-resolves current ID; старый exact read intent rejected | Existing N1 + boundary test |
| Query + partial directory | Явно partial; отсутствие match не утверждает global absence | View model test |
| 200% zoom/touch keyboard | Controls доступны, focus visible, scroll local | Sandbox visual proof |

## 12. Checkpoints и порядок интеграции

Каждый checkpoint - bounded code review unit, целевой бюджет до ~2k changed LOC без отдельно объяснённых fixtures.
Ветка #252 сохраняется; checkpoints интегрировать последовательно в неё. Не создавать поздний replacement stack.
Общий invariant не разрезать: safe route и его auth/redaction tests интегрируются вместе.
В таблице LOC включают additions+deletions и focused tests; диапазоны не являются deadline.

| ID | Scope/ownership | Depends | Precondition | Postcondition | Rollback | LOC |
|---|---|---|---|---|---|---:|
| H0 | Docs/contract owner: scope amendment, signed root join, durable migration proof, personal producer/mount inventory, capability/activation matrix | Baseline | Прочитаны source и scope lock | Hash/denied nested, v1 migration, B A-only staging и personal deployment зафиксированы | Docs revert; никаких effects | 200-400 |
| H1 | Recent UI owner: normalized card/view + Desktop connector | H0 | Existing recent tests | Desktop рендерит shared view; rich facts сохранены | Revert extraction с connector, wire unchanged | 1,100-1,650 |
| H2 | Dashboard UI owner: screen/query/active shortcut/focus, running public adapter + Desktop slots | H1 | H1 public browser-safe facet | Desktop использует новый Dashboard; running query фильтрует локально; один CmdK handler | Revert wrapper wiring+shared extraction вместе | 1,000-1,600 |
| H3a | Launcher/state + Recent owner: v1->v2 durable registrations, existing-field multi-root issuer, hash resolver, promotion root fix, scoped sources/freshness | H0 | Scope amendment и durable contract записаны | Stable A/B IDs/restart/grants + safe A/B/C facade, пока не advertised | Roll back new facet; state v2 не ретаргетить | 4,400-6,800 |
| H3b | HTTP/personal deployment owner: exact recent route, generated personal mounts + ID list/grants, A-only server activation fence, metadata parity, legacy closure | H3a | DTO/source proof и personal issuer available | B seeded but hidden from registry list/select и all Hosted routes; no leak/bypass | Flip A-only fence and disable new facet; never restore unsafe legacy path | 1,800-2,900 |
| H3c | Directory backend owner: per-binding read-only host/dispatch, scoped route, team attribution/downstream read fence | H3a | Durable signed root map и existing scoped ports | A/B teams только в своём grant; missing B typed unavailable | Keep A-only legacy host; disable scoped route | 2,100-3,400 |
| H3d | Access owner: workspace/team capability projection и server effect fences для config/promotion/lifecycle/tasks/messages/operator | H3b,H3c | A/B read/write authority известна | B read-only; A owner-bound writes по точным scopes | Не рекламировать новые B targets до закрытия gates | 1,500-2,600 |
| H4 | Hosted composition owner: shared Dashboard/open-project, B-scoped directory/access transport, per-control effect gating, two event owners | H2,H3b,H3c,H3d | Safe HTTP + access snapshot ready, F2 stable | Dashboard -> A/B project -> chooser -> team; B без write controls; ACK fence | Revert Hosted screen wiring; existing workspace shell жив | 1,800-3,000 |
| H5a | Search owner: shared palette interaction/presentation, Desktop connector | H2 | Existing race tests; добавить узкие anchors/IME assertions | Desktop search behavior сохранён через common owner | Revert search extraction, wire unchanged | 900-1,500 |
| H5b | Search/Hosted owner: workspace/team palette adapter | H4,H5a | N1 source/selection already shared | Hosted CmdK реально navigates, no sessions advertisement | Remove Hosted palette binding | 500-900 |
| H6 | Integration owner: staged->active personal A/B/C HTTP/Compose + 21-row view + reboot/migration/capability proof, graph/a11y E2E | H4,H5b | Exact backend/UI fences proved | Activate B on exact SHA; old registry list/select and rollback verified | A-only switch + restart; v2 state preserved | 1,200-2,200 |

H3a и H1/H2 можно делать параллельно в непересекающихся модулях; H5a после H2 независимо от HTTP.
До H4/H5b production Hosted build ещё не импортирует новые facets H1/H2/H5a: ранний graph proof требует
узкого actual-build fixture consumer, либо явно остаётся недоказанным до Hosted composition. Успех старого
Hosted bundle сам по себе не подтверждает переносимость неиспользуемого facet.
Ownership непересекающийся: один writer на shared model/public barrel; compositions меняет integration owner.
H3a делить на durable state/issuer, hash resolver/promotion и scoped-readers/facade PR;
H3b - на profile provisioning и route/authorization PR; H3c - на per-binding hosts и scoped dispatch PR.
H3d серверные effect fences интегрирует вместе с их contract tests. Новые routes закрыты до admission proof;
при review budget >2k делить по реально проверяемой границе;
не делить redaction fix и его route policy на небезопасный промежуток.
Hosted workers - отдельные jobs/workspaces exact base; unrelated edits не откатываются. Code/test heavy work выполнять на сервере.

### 12.1. Совместимость и rollback без скрытого долга

- H1/H2/H5a не меняют persistent Desktop schema, IPC shape или user settings; отмена не требует data migration.
- H3 создаёт новый Hosted DTO; не читать его как старый Desktop payload и не сохранять в path-based history.
- Rollback Hosted UI отключает advertisement, client effects и listener вместе; safe backend route может остаться inert.
- Нельзя восстановить потенциально unsafe legacy Hosted route только ради старого UI rollback.
- Existing pairing/auth/Owner/controller/SSE capabilities не отключаются общим «Dashboard failed» flag.
- После H6 удалить migrated old active branches; временные compatibility delegates только перенаправляют вызов.

## 13. Минимальные содержательные тесты

Перед каждым новым тестом writer указывает, какая реальная поломка делает его красным.
Не тестировать текст исходника/число компонентов/мок как самоцель. Не копировать expected result из проверяемой функции.
Сильная граница проверяется один раз; дополнительные слои нужны для своего риска (transport, authorization, lifetime).

| Граница | Что сделает тест красным | Проверка |
|---|---|---|
| Shared project view | Unknown counts стали zero/progress; reveal вызвал primary open | DOM assertions + actions |
| Collection interaction | Query фильтрует только первые 11; clear не reset limit | One view/hook behavior suite |
| Shared navigation | Late intent открывает другой scope; double click два effects | Captured epoch + deferred promises |
| Desktop preservation | Потеря worktree/synthetic fallback/context/anchor | Existing tests + focused adapter integration |
| Hosted root resolver + recent facade | Hash принят за path; C вложен в A и без grant наследует A; repo merge до grant | A/B granted + nested denied C/sibling/symlink, A output неизменен при C activity |
| Durable launcher identity | Reorder/restart сменил ID; remove/re-add retarget; replacement унаследовал grant | v1 migration + A/B stop/reboot/tombstone/re-add/new-key cases в personal issuer |
| Promotion/root choice | Несколько signed roots отключили promotion либо выбрали B | Existing single-root + A/B + duplicate/hash mismatch fail-closed |
| Scoped directory | B показывает fresh empty, B cursor принят в A, grant сменился после read | Real A/B team fixtures, typed unavailable и exact fence |
| Workspace/team capabilities | B видит write control/отправляет request; A теряет разрешённый Owner effect; stale team fence переносит receipt | Exact access DTO, UI control/effect и forged-route A/B tests по config/promotion/lifecycle/task/message/operator |
| HTTP boundary | Missing CSRF/Origin accepted; old route bypasses new policy | Fastify injection/real auth middleware |
| Scope-bound cache | Auth/grant change получает старые rows; stale маскируется fresh или смешанный provider state | Same facade with changed authority и per-source timestamps |
| Hosted composition | Второй directory load/wave или duplicate workspace/team subscription; Dashboard remount потерял F2 intent | Production shell integration с real hooks и count per scope |
| Project select | Response старого boot/revision/mount переключает shell | Deferred ACK после registry/authority change |
| Palette interaction | IME submit, stale response, empty index, failed search silent | Common keyboard/read tests |
| Emitted build graph | Shared barrel тащит store/API/native/terminal | Actual Vite build + existing verifier |
| Browser/Desktop UI | Workflow виден, но control не работает в composition | Один matched sandbox journey на shell |

Сохранить и расширять ближайшие существующие тесты:

- `test/features/recent-projects/renderer/{hooks,ui,view-models,utils}`.
- `test/features/recent-projects/core/application/ListDashboardRecentProjectsUseCase.test.ts`.
- `test/features/running-teams/renderer`, `test/features/team-directory/teamDirectory.test.ts`.
- `test/features/team-lifecycle/renderer/useHostedTeamDirectorySource.test.ts`.
- `test/renderer/components/search/CommandPalette.test.tsx`.
- `test/renderer/hosted/HostedApplicationShell.test.tsx`, `test/renderer/components/team/HostedTeamWorkspace.test.tsx`.
- `test/architecture/hosted-web/phase-10/hosted-no-terminal-actual-vite-build.test.ts`.

Новые tests предлагаются в `test/features/dashboard`, `test/features/command-search`,
`test/features/recent-projects/main/adapters/input/http` и рядом с Hosted recent facade.
Red-before/green-after обязателен по возможности для join/leak/stale-fallback/focus дефектов; в документации отметить, какой reproduce доказан.

## 14. Команды проверки и sandbox evidence

Команды сверены с `package.json` baseline. Это план будущих прогонов; при составлении документа они не запускались.
Использовать `set -o pipefail` перед pipeline, чтобы `tail -20` не скрывал ненулевой exit code.

```bash
# Быстрые независимые checks после своего checkpoint.
pnpm typecheck 2>&1 | tail -20
pnpm lint:fast:files -- <фактически-изменённые-ts-tsx-файлы>
pnpm guard:feature-architecture
pnpm guard:source-file-size

# Ближайшие существующие suites; выбрать связанные с checkpoint, не все после каждой правки.
pnpm exec vitest run test/features/recent-projects test/features/running-teams test/features/team-directory
pnpm exec vitest run test/features/team-lifecycle/renderer/useHostedTeamDirectorySource.test.ts
pnpm exec vitest run test/renderer/components/search/CommandPalette.test.tsx
pnpm exec vitest run test/renderer/hosted/HostedApplicationShell.test.tsx test/renderer/components/team/HostedTeamWorkspace.test.tsx

# Настоящий browser emitted graph, не только source grep или typecheck.
pnpm exec vitest run test/architecture/hosted-web/phase-10/hosted-no-terminal-actual-vite-build.test.ts

# Финальный широкий gate для общей frontend миграции на сервере.
pnpm lint 2>&1 | tail -20
pnpm test 2>&1 | tail -20
pnpm build 2>&1 | tail -20

# Desktop interactive verification: только fixture/sandbox state и renderer CDP.
pnpm dev:mcp

# Built Hosted production composition: существующий Docker/Playwright harness.
pnpm test:hosted:e2e
```

`pnpm typecheck` уже использует pinned native TS7; глобальный `tsc7` дополнительно не запускать.
`pnpm lint:fix` не применять. Source-size baseline/caps не расширять; новые production files <=800 строк.
Actual-build test уже собирает Hosted renderer во временный output и проверяет manifest/digests/import graph.
Не дублировать тот же build отдельной командой без нового риска; сохранить его output/evidence SHA.
Финальный CI и Desktop build обязательны по действующему PR workflow, но повтор успешного того же SHA без изменений не нужен.

### 14.1. E2E scope

Текущий Hosted harness имеет `core`, `phase-6`, `phase-8`, но отдельного Dashboard suite пока нет.
В H6 добавить `dashboard` suite в `test/fixtures/hosted-v1/browserSuites.ts`, testMatch `dashboard.spec.ts`, personal mode.
Новый suite использует **реальный built Product, auth, registry и HTTP/SSE** с marker-owned sandbox fixtures.
После регистрации действительная команда: `HOSTED_E2E_SUITE=dashboard pnpm test:hosted:e2e`.
Не выдавать её за уже доступную baseline команду. Не запускать весь historical proof matrix ради CSS/layout.

Один Hosted journey:

1. Расширить `createSandbox.ts` реальными marker-owned A/B roots с grant и registered C **внутри A** без grant;
   sibling/worktree/symlink cases, signed manifest/runtime roots, настоящие teams в A/B, provider metadata
   и production-equivalent mounts. C меняет свои metadata, но поля A не меняются. Это HTTP/Compose proof.
2. Pair -> Dashboard recent A/B rows; проверить safe labels/activity и отсутствие C/paths в network payload;
   оба provider facts действительно получены из metadata mounts, а не из mock route.
3. Отдельная typed **view fixture** с 21 уникальным admitted `workspaceId` проверяет Search/clear/Load more
   11 -> 19 -> 21 и поиск по всем 21 без раздувания production Compose. Она не заменяет A/B/C HTTP proof.
   В live A/B journey CmdK workspace -> teams -> open team и card path дают тот же admitted target.
4. До activation выдать B grant, но проверить отказ старых registry list/select, recent и directory для B.
   После exact-SHA activation проверить, что B появляется одновременно во всех этих surfaces; rollback снова
   скрывает B и очищает targets/cache, а A остаётся доступен.
5. Проверить promotion storage для current A при multi-root bootstrap; chooser A/B показывает собственные
   реальные teams, B не монтирует config/lifecycle/task/message/operator writes, forged B requests отвергнуты
   сервером по каждому семейству; A сохраняет owner-bound writes. Missing B binding - typed unavailable.
6. Simulate failed refresh/partial source с fresh Claude + stale Codex, retry, workspace-scope SSE invalidation
   и A/B switch с задержанным A select ACK и revision/mount сменой.
7. Revoke A grant/сменить mount generation; stale action rejected, rows reconciled.
8. Dashboard -> team -> Dashboard во время existing F2 pending test command; registry identity не теряется.
9. Logout -> sensitive rows/targets исчезли; reconnect не создал duplicate workspace-scope или team-scope
   subscription/reconciler и вторую directory list/runtime wave.

Один Desktop journey через `dev:mcp` CDP и test fixtures:

1. Fixture recent projects с rich paths/branch/counts/active teams, включая deleted и synthetic cases.
2. Search/clear, open known project/team, CmdK sessions с existing match anchors и IME.
3. Проверить сохранённые Desktop banners без реального install/login/update эффекта.
4. Picker/reveal контракт проверить adapter-level fakes; native folder picker во время automated UI не открывать.
5. Capture 320/768/1280 px и 200% zoom, keyboard focus/Tooltip/Dialog и отсутствие nested button.

Не использовать реальные проекты, не открывать их runtime/terminal, не выполнять task assignment/agent launch на них.
Для Dashboard proof не нужен реальный provider launch: runtime facts seed через test APIs/fixtures.
Отдельные ранее принятые Core provider/mixed-team live gates сохраняются, но не размножаются на каждый Dashboard checkpoint.
Heavy builds/Docker/Playwright проводить на hosted worker с изолированными каталогами/ports/compose name.
Evidence: exact Product SHA, fixture IDs, команды/exit codes, redacted HTTP assertions, screenshots, graph manifest hash.

## 15. Оценка остатка и точности

Единица: changed LOC (`added + deleted`), включая перестановку существующего кода и focused tests.
Это incremental diff от `debb837d4`, не весь PR #252 и не размер просмотренного source.

| Группа | Диапазон | Включено |
|---|---:|---|
| H0 scope/contracts docs | 200-400 | Amendment, durable migration proof, personal activation/capability matrix |
| H1-H2 shared frontend + Desktop | 2,100-3,250 | Cards/screen/query/slots, rich Desktop mapper, running adapter/CmdK и focused regressions |
| H3a-H3b Hosted data/admission | 6,200-9,700 | State v2/migration, personal issuer/mounts/ID list, A-only fence, hash resolver, promotion, sources/DTO/route |
| H3c directory backend | 2,100-3,400 | Per-binding hosts, scoped route/transport, attribution and A/B team tests |
| H3d capability/backend | 1,500-2,600 | Exact access projection и effect fences по config/promotion/lifecycle/task/message/operator |
| H4 Hosted composition | 1,800-3,000 | Dashboard, ACK fence, B-scoped reads, per-control action gating, stable F2/two event scopes |
| H5a-H5b command search | 1,400-2,400 | Shared palette + both adapters, Desktop anchors/IME |
| H6 integration/E2E/cleanup | 1,200-2,200 | Staged->active A/B/C personal proof, 21-row view, stop/reboot/rollback, graph/a11y |
| **Итого** | **16,500-26,950** | Personal Dashboard target после scope amendment |

Из них production ориентировочно 10.1-16.3k, tests/fixtures 6.0-10.0k, docs 0.2-0.4k; грубое распределение внутри total.
Оценка времени: 32-50 engineering days для implementation + 5-8 для review/exact-SHA gates;
при независимых frontend/backend lanes - около 6-9 календарных недель, без ожидания release approval.
Точность total: 🎯 4/10. Архитектурная уверенность: 🎯 8/10; надёжность при выполнении gates: 🛡️ 9/10; сложность: 🧠 9/10.
Durable personal provisioning, B activation и workspace/team effect gating - главный источник разброса; palette extraction - второй.
Запас на подтверждённые новые scope gaps сверх диапазона: до 20-30%, не автоматическое разрешение расширить реализацию.
Hash/root resolver, multi-root read dispatch и Claude/Codex metadata mounts уже входят в диапазон;
session viewer или Owner protocol - отдельный scope.
Ранее выполненные F1/F2/D1/N1, all-facets F0b, полный Kanban и native CLI refactor в total отсутствуют.
Текущий plan document не считать production LOC; измеренный финальный diff вывести после интеграции.

## 16. Решения, риски и неопределённость

| ID | Статус / решение | Риск / уверенность | Как закрывается |
|---|---|---|---|
| D-01 | ✅ Полный Dashboard target, включая Hosted recent activity | Scope expansion относительно D1/N1; 🎯 9/10 | Материализовать точное amendment §1.1 до кода |
| D-02 | ✅ Общая feature UI/interaction, separate adapters | Hidden native imports; 🛡️ 9/10 | Actual emitted graph + оба real consumers |
| D-03 | 🔒 Owner/controller/SSE/auth boundaries неизменны | Последствия утраты высокие | Security invariants и regression gates |
| D-04 | ✅ Hosted безопасные `Workspace N` labels | Меньше удобства, чем local path/name | Сохранять текущий registry contract; name privacy отдельное решение |
| D-05 | ✅ Shared palette, Desktop sessions, Hosted workspace/team mode | Возможное ожидание full session parity | Явные mode labels; отдельный session-viewer slice вне этого плана |
| D-06 | ✅ Rich native controls остаются Desktop extension | Потеря Desktop фич при унификации | Rich fixture acceptance, не lowest-common-denominator DTO |
| R-01 | ⚠️ Legacy recent join identity != runtime identity | 🎯 8/10 source risk, runtime ещё не проверен | H3 red fixture + scoped map + close legacy Hosted route |
| R-02 | ⚠️ Codex metadata не mounted; `/home/node` tmpfs; personal workspace mount есть только в launcher override | 🎯 9/10 source/config fact | H0 exact inventory, H3b personal/E2E metadata target parity |
| R-09 | ⚠️ Signed roots + hashes есть, но join для Dashboard отсутствует; denied nested C опасен | 🎯 9/10 source fact | H3a full-map hash resolver до grant, ambiguous/missing fail closed |
| R-10 | ⚠️ Multi-root отключает promotion, current directory host показывает B fresh empty | 🎯 9/10 source fact | H3a minimal promotion root selection; H3c per-binding read hosts + typed unavailable |
| R-11 | ⚠️ B получает глобальные write controls без workspace/team effect admission | 🎯 9/10 source fact | H3d exact scoped capabilities/backend fences; H4 UI gating, A/B forged-write proof |
| R-12 | ⚠️ Launcher v1 singleton state/config/Compose не дают durable multi-root identity | 🎯 9/10 source fact | H3a v2 migration и stable keys; H3b personal producer, stop/reboot/restart/grant fixtures |
| R-13 | ⚠️ B grant до UI gate откроет старый shell | Высокий impact | H3b default A-only в registry list/select и всех Hosted reads; H6 exact-SHA activation/rollback |
| R-03 | ⚠️ Shared palette выносит session navigation anchors | 🎯 7/10 | Desktop exact-match integration test до удаления old branch |
| R-04 | ⚠️ Перемонтирование workspace теряет pending F2 state | Высокий impact | Registry выше экранов, remount race test |
| R-05 | ⚠️ Stale source fallback сегодня может выглядеть fresh | 🎯 8/10 source behavior | H3 explicit stale/partial facade state, regression |
| R-06 | ⚠️ Exact control-state reads дают неполную wave | Нельзя улучшать UI выдуманными фактами | Preserve unknown/incomplete, не новый polling owner |
| R-07 | ⚠️ Localization/helpers transitive runtime dependency | Средний impact | Public entrypoint audit + bundle proof |
| R-08 | ⚠️ Большой существующий #252 продолжает меняться | Base/merge drift | Rebase evidence по SHA; не применять старые LOC как exact backlog |

Неопределённость не является поводом заблокировать независимые H1/H2/H5a.
Для R-02 writer проверяет base + launcher override Compose config и sandbox mount inventory, без credential reads.
Accepted production/test profile должен иметь оба Codex metadata mounts и signed workspace roots для полного
Dashboard target; если mount отсутствует,
route честно возвращает partial/unavailable, а release gate полного target остаётся красным. Нельзя выдавать Claude-only
evidence за two-provider proof или монтировать owner credential home.

### 16.1. Следующие экраны и Kanban hazard

Этот pattern применим к следующим screens только после собственного source/scope audit.
Не объявлять «frontend уже общий» для board/messages/settings из-за общего Dashboard.
На baseline Desktop Kanban использует `todo/in_progress/review/done/approved`, а Hosted renderer имеет свою presentation map.
Доставленный F1 устраняет часть semantic duplication, но сам по себе не делает две column presentation идентичными.
При следующем Kanban slice проверить current column IDs/order/labels и move intents против controller semantics.
Это **later migration hazard**, вне Dashboard scope и LOC. Не исправлять column drift попутно в H1-H6.

## 17. Acceptance criteria

План реализован только если одновременно выполнено следующее:

- [ ] Scope amendment явно записано; нет подмены accepted Core v1 полномасштабной Desktop parity.
- [ ] Desktop и Hosted production entrypoints используют один DashboardScreen, card view и shared interaction owners.
- [ ] Реальный Hosted Recent Projects отражает доступную подтверждённую Claude/Codex activity из scoped metadata
      mounts с exact hash join к existing signed roots, а не только registry или mocked data; denied nested C не
      влияет на parent A.
- [ ] Project card -> admitted workspace -> chooser -> team работает кнопкой и keyboard; search/palette имеет честные labels.
- [ ] Desktop worktree/synthetic navigation, native actions, rich counts/branch/provider/activity и session anchors сохранены.
- [ ] Hosted DTO не содержит paths/repo identity/secrets; old recent GET не обходит новый authorization/redaction path.
- [ ] Support, availability и unknown facts различаются; per-provider fresh/stale + confirmedAt переживают cache fallback,
      partial/stale не выдаются за complete empty.
- [ ] D1/N1 reused; одна directory read/wave, ровно один workspace-scope и один team-scope event owner при выбранной
      team; query не инициирует backend fan-out.
- [ ] Select ACK проверяет captured deployment/boot/revision/mount/authority epoch и не навигирует при stale response.
- [ ] Load more доказан на typed view fixture из 21 уникальной workspace activity row: 11 -> 19 -> 21;
      A/B/C безопасность отдельно доказана через real HTTP/Compose.
- [ ] Multi-root promotion выбирает current binding A по hash; A/B имеют реальные непустые team directory и
      open-team journeys, lost B binding возвращает typed unavailable, не fresh empty.
- [ ] B имеет только доказанные read capabilities; configuration/promotion/lifecycle/task/message/operator
      write controls/effects отсутствуют и forged writes отвергаются backend. A owner-bound effects сохранены.
- [ ] После stop/reboot/reorder/remove/re-add/replacement runtime IDs и grants не ретаргетятся; v1 single-root
      migration сохраняет `personal.main` ID из durable evidence, rollback после v2 write не возвращает v1 schema.
- [ ] B grant до activation не проходит старые registry list/select или новые routes; exact-SHA activation
      и rollback меняют server visibility атомарно, сохраняя A.
- [ ] Dashboard/chooser remount не теряет F2 pending identities и не меняет Owner/controller write authority.
- [ ] Native-only controls/effects отсутствуют в Hosted, а Desktop extensions функциональны.
- [ ] Shared view не импортирует App/store/broad API; actual bundle graph проходит без aliases/stubs/новых exceptions.
- [ ] Keyboard, IME, focus return, Tooltip/Dialog, responsive/zoom проверены на sandbox fixtures.
- [ ] Focused tests, full PR gates и sandbox UI evidence относятся к итоговому exact SHA.
- [ ] Нет новых dependencies, production files >800 строк или повышенных legacy caps.
- [ ] Старые активные common policies удалены либо стали thin delegates; нет двух конкурирующих interaction owners.
- [ ] Итоговый отчёт различает source proof, deterministic tests, UI proof и недоказанное runtime coverage.

Публикация релиза, deployment, реальные provider/team действия и merge не разрешаются автоматически этим планом.
Документ готовит следующий reviewable increment; реализация начинается только после синхронизации authoritative scope.
