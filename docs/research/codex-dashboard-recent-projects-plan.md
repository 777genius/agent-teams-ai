# Codex Dashboard Recent Projects Plan

**Дата**: 2026-04-14  
**Статус**: Reference-quality architecture plan  
**Goal**: сделать `Dashboard -> Recent Projects` эталонной feature по `SOLID`, `Clean Architecture`, `Ports/Adapters`, `DRY`  
**Canonical standard**: этот документ фиксирует рекомендуемый shape для будущих feature в проекте

## Executive Summary

Выбранный вариант:

`Full vertical slice in src/features with core separated from process adapters`
`🎯 9   🛡️ 10   🧠 8`
Примерно `700-1000` строк изменений

Это решение фиксируется как **предпочтительный architectural template для будущих feature**, если feature:

- затрагивает более одного process boundary
- содержит заметную бизнес-логику
- имеет отдельный use case, который хочется развивать независимо

### Что это значит

- создаём feature `src/features/recent-projects`
- внутри feature есть **свои слои**:
  - `contracts`
  - `core/domain`
  - `core/application`
  - `main/composition`
  - `main/adapters`
  - `main/infrastructure`
  - `preload`
  - `renderer`
- app shell только **собирает** feature, но не владеет её логикой

### Главная корректировка относительно прошлого плана

Прошлая версия уже была неплохой, но для "эталонной" фичи ей не хватало жёсткости в четырёх местах:

1. use case был описан слишком близко к DTO, а не как application core
2. adapters и infrastructure были недостаточно разведены
3. не был явно сформулирован набор архитектурных запретов
4. inner circles были слишком близко привязаны к `main`, хотя это не main-specific business logic

Этот документ исправляет именно это.

---

## 1. Top 3 Architecture Options

### 1. Full vertical slice + strict Clean Architecture inside the feature

`🎯 9   🛡️ 10   🧠 8`
Примерно `700-1000` строк

Идея:

- feature lives in one place
- core/domain and core/application isolated from process details
- ports explicit
- adapters explicit
- process boundaries preserved inside the feature

Почему это лучший вариант:

- лучший long-term shape
- легко расширять новыми providers
- легче удерживать логику фичи в одном bounded context
- это реально можно показывать как reference implementation

### 2. Vertical slice, но без жёсткого разделения `application / adapters / infrastructure`

`🎯 7   🛡️ 7   🧠 6`
Примерно `500-750` строк

Плюсы:

- меньше файлов
- быстрее в реализации

Минусы:

- быстро поплывут ответственности
- adapters начнут смешиваться с use case
- через несколько итераций feature станет "папкой со всем подряд"

### 3. Renderer feature + main service outside feature

`🎯 8   🛡️ 8   🧠 6`
Примерно `450-700` строк

Плюсы:

- проще
- достаточно хорошо для одной задачи

Минусы:

- хуже ощущается как единая feature
- логика снова размазывается по repo

### Final choice

Берём **вариант 1**.

---

## 2. Product Goal

Когда пользователь открывает homepage, он должен увидеть **последние проекты, где недавно реально работал**, включая:

- Claude activity
- native Codex activity
- merged карточки, если это один repo или folder

### Acceptance criteria

1. Claude-only пользователь не видит поведенческой регрессии.
2. Codex-only пользователь видит свои проекты на homepage.
3. Claude + Codex в одном repo не создают дубликатов.
4. Карточка показывает provider logos.
5. Если standalone `codex` отсутствует или `codex app-server` не стартует, homepage спокойно деградирует в Claude-only.
6. В `ssh` context локальные native Codex проекты не подмешиваются.
7. `DashboardView` остаётся экраном-компоновщиком, а не бизнес-слоем.

---

## 3. Non-Goals For Phase 1

Не делаем:

- native Codex sessions в sidebar
- native Codex session detail opening
- model badges
- file-based Codex session index
- persistent `codex app-server`
- live notifications from Codex
- global provider-agnostic session index
- injection Codex data into `repositoryGroups`

---

## 4. Architecture Standards For This Feature

## 4.1 Single Responsibility

Каждый модуль меняется по одной причине:

- `domain` - business rules recent projects
- `application` - orchestration use case
- `adapters` - translation in/out
- `infrastructure` - конкретные технологии и внешние системы
- `input adapters` - IPC/HTTP wiring
- `preload` - renderer bridge
- `renderer/ui` - rendering
- `renderer/hooks` - interaction orchestration

## 4.2 Open / Closed

Новый provider должен подключаться новым source adapter, а не переписыванием use case.

## 4.3 Liskov

Любой source adapter должен удовлетворять одному и тому же порту:

- Claude source
- Codex source
- будущий Gemini source

## 4.4 Interface Segregation

Порты должны быть узкими:

- `RecentProjectsSourcePort`
- `RecentProjectsCachePort`
- `ClockPort`
- `LoggerPort`
- `ListDashboardRecentProjectsOutputPort`

Не должно быть толстых универсальных сервисов.

## 4.5 Dependency Inversion

Use case зависит только от портов.

Use case **не знает** про:

- `ipcMain`
- `Fastify`
- `ipcRenderer`
- `child_process`
- `electron`
- Zustand
- React

## 4.6 DRY

Нельзя дублировать:

- merge rules
- provider presentation mapping
- navigation fallback flow
- task/team aggregation by associated paths
- Codex thread fetch policy

## 4.7 Clean Architecture Rule

Допустимое направление зависимостей:

`main/adapters/input -> core/application -> core/domain`
`main/adapters/output -> core/application ports`
`main/infrastructure -> core/application ports`
`renderer/hooks -> renderer/adapters -> contracts`
`preload -> contracts`

Недопустимо:

- `core/domain -> core/application`
- `core/application -> main/infrastructure`
- `core/application -> main/adapters`
- `renderer/ui -> store/api`
- `shared/app-shell -> feature internals`

---

## 5. Hard Architectural Corrections

Это места, где нужно быть особенно аккуратным.

### Correction 1 - Feature contracts are not the same thing as app shell contracts

Ошибка, которую легко сделать:

- положить DTO в feature
- а потом заставить весь `src/shared/types/api.ts` зависеть от feature internals как от обычного shared-layer

Правильнее:

- `feature contracts` живут внутри feature и описывают форму recent-projects
- `app shell` может **композировать** feature API fragment, но не должен владеть feature моделью

Это тонкая, но важная разница.

### Correction 2 - Use case must not return infrastructure-shaped data

Use case работает с `core/application response model`, а не с raw app-server rows и не с renderer card model.

### Correction 3 - UI must not own navigation policy

`RecentProjectCard` не должен знать, как работает:

- worktree match
- refresh repository groups
- add custom path
- synthetic fallback group

Это responsibility interaction adapter/hook.

### Correction 4 - `DashboardView` must become a composition root for the screen

Он не должен:

- ходить в API
- мержить данные
- решать navigation flow
- агрегировать task/team decorations

---

## 6. Recommended Feature Structure

```text
src/features/recent-projects/
  contracts/
    index.ts
    dto.ts
    channels.ts
    api.ts
  core/
    domain/
      RecentProjectCandidate.ts
      RecentProjectAggregate.ts
      ProviderId.ts
      policies/
        mergeRecentProjectCandidates.ts
    application/
      use-cases/
        ListDashboardRecentProjectsUseCase.ts
      ports/
        ClockPort.ts
        LoggerPort.ts
        RecentProjectsCachePort.ts
        ListDashboardRecentProjectsOutputPort.ts
        RecentProjectsSourcePort.ts
      models/
        ListDashboardRecentProjectsResponse.ts
  main/
    index.ts
    composition/
      createRecentProjectsFeature.ts
    adapters/
      input/
        ipc/
          registerRecentProjectsIpc.ts
        http/
          registerRecentProjectsHttp.ts
      output/
        presenters/
          DashboardRecentProjectsPresenter.ts
        sources/
          ClaudeRecentProjectsSourceAdapter.ts
          CodexRecentProjectsSourceAdapter.ts
    infrastructure/
      cache/
        InMemoryRecentProjectsCache.ts
      identity/
        RecentProjectIdentityResolver.ts
      codex/
        CodexBinaryResolver.ts
        CodexAppServerClient.ts
        JsonRpcStdioClient.ts
  preload/
    index.ts
    createRecentProjectsBridge.ts
  renderer/
    index.ts
    adapters/
      RecentProjectsSectionAdapter.ts
    hooks/
      useRecentProjectsSection.ts
      useOpenRecentProject.ts
    ui/
      RecentProjectsSection.tsx
      RecentProjectCard.tsx
    utils/
      navigation.ts
      projectDecorations.ts
```

### Why this structure is the cleanest

- `contracts` - cross-process public contract
- `core/domain` - invariant business rules
- `core/application` - use case orchestration through ports
- `main/adapters/input` - driving adapters
- `main/adapters/output` - driven adapters
- `main/infrastructure` - concrete implementations
- `main/composition` - feature composition root
- `preload` - isolated renderer bridge
- `renderer` - feature presentation

Это уже не просто "feature folder", а полноценный vertical slice.

### Canonical template for future features

Для будущих feature в проекте фиксируем такой шаблон как базовый:

```text
src/features/<feature-name>/
  contracts/
  core/
    domain/
    application/
  main/
    composition/
    adapters/
      input/
      output/
    infrastructure/
  preload/
  renderer/
```

Использовать этот шаблон по умолчанию **для feature среднего и большого размера**.

Если feature маленькая и:

- не имеет отдельного use case
- не вводит новый bridge/API
- не содержит сложной business logic

то допускается упрощённый вариант без полного `core/main/preload` набора.

### What is mandatory

- `contracts/`
- `core/domain/`
- `core/application/`
- `main/composition/`
- хотя бы один из:
  - `main/adapters/input/`
  - `main/adapters/output/`
- `renderer/`, если у feature есть UI

### What is optional

- `preload/`, если feature не требует нового bridge/API
- `main/infrastructure/`, если feature не ходит во внешние runtime dependencies
- `renderer/adapters/`, если feature очень маленькая
- `renderer/hooks/`, если feature purely presentational

### When `core/` is required

`core/` обязателен, если feature:

- содержит независимые business rules
- имеет merge/filter/decision policy
- имеет хотя бы один use case, который хочется тестировать изолированно
- потенциально будет расширяться новыми providers / sources / policies

### When `core/` may be skipped

`core/` можно не создавать, если feature:

- purely presentational
- только прокидывает данные без трансформации правил
- не имеет собственного use case
- по сути является thin UI wrapper around existing app logic

### What should not be used as the default standard

- `main/domain/application/presentation`
- `preload/domain/application/presentation`
- `ui/domain/application/presentation`

Причина:

- это смешивает process axis и architecture axis
- это создаёт ложную симметрию
- это размывает единственный business core

---

## 7. Dependency Matrix

### Allowed imports

#### `contracts`

Can import:

- nothing app-specific
- TS built-ins only

#### `core/domain`

Can import:

- `contracts` if types are pure and stable
- other `core/domain` files

Cannot import:

- `core/application`
- `adapters`
- `infrastructure`
- `electron`
- `fastify`
- `@main/*`

#### `core/application`

Can import:

- `core/domain`
- `core/application/ports`
- `contracts`

Cannot import:

- `ipcMain`
- `Fastify`
- `child_process`
- `@renderer/*`

#### `main/adapters/input`

Can import:

- `core/application`
- `core/domain`
- `contracts`

Cannot import:

- renderer code

#### `main/adapters/output`

Can import:

- `core/application`
- `core/domain`
- `contracts`
- `main/infrastructure`

Cannot import:

- renderer code

#### `main/infrastructure`

Can import:

- `core/application/ports`
- `core/domain`
- `contracts`
- technology-specific libs

#### `main/composition`

Can import:

- `core/application`
- `main/adapters/input`
- `main/adapters/output`
- `main/infrastructure`
- `contracts`
- `@main/*`

#### `preload`

Can import:

- `contracts`
- feature preload helpers
- Electron preload APIs

Cannot import:

- `main/*`
- renderer code

#### `renderer/ui`

Can import:

- renderer hooks
- renderer adapters
- simple feature-local UI utilities

Cannot import:

- store directly
- API directly
- main code

#### `renderer/hooks`

Can import:

- `api`
- `useStore`
- feature contracts
- feature adapters/utils

---

## 8. Ports And Adapters Design

## 8.1 Domain Model

### `RecentProjectCandidate`

Это provider-agnostic внутренний объект, из которого потом строится response.

```ts
export interface RecentProjectCandidate {
  identity: string;
  displayName: string;
  primaryPath: string;
  associatedPaths: string[];
  lastActivityAt: number;
  providerIds: ProviderId[];
  sourceKind: 'claude' | 'codex';
  openTarget:
    | { type: 'existing-worktree'; repositoryId: string; worktreeId: string }
    | { type: 'synthetic-path'; path: string };
  branchName?: string;
}
```

### `RecentProjectAggregate`

Это уже merged domain shape до presenter mapping.

```ts
export interface RecentProjectAggregate {
  identity: string;
  displayName: string;
  primaryPath: string;
  associatedPaths: string[];
  lastActivityAt: number;
  providerIds: ProviderId[];
  source: 'claude' | 'codex' | 'mixed';
  openTarget:
    | { type: 'existing-worktree'; repositoryId: string; worktreeId: string }
    | { type: 'synthetic-path'; path: string };
  branchName?: string;
}
```

### Merge policy

`core/domain/policies/mergeRecentProjectCandidates.ts`

Это чистая функция без side effects.

Именно тут живёт истинная business rule:

- dedupe by identity
- prefer `existing-worktree`
- merge provider ids
- max by recency
- unset conflicting branch

---

## 8.2 Application Ports

### `RecentProjectsSourcePort`

```ts
export interface RecentProjectsSourcePort {
  list(): Promise<RecentProjectCandidate[]>;
}
```

### `RecentProjectsCachePort`

```ts
export interface RecentProjectsCachePort<T> {
  get(key: string): Promise<T | null>;
  set(key: string, value: T, ttlMs: number): Promise<void>;
}
```

### `ClockPort`

```ts
export interface ClockPort {
  now(): number;
}
```

### `LoggerPort`

```ts
export interface LoggerPort {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}
```

### `ListDashboardRecentProjectsOutputPort`

```ts
export interface ListDashboardRecentProjectsOutputPort<TViewModel> {
  present(aggregates: RecentProjectAggregate[]): TViewModel;
}
```

Это важный момент.  
Если хотим действительно clean use case, use case не должен знать финальный transport DTO напрямую.

---

## 8.3 Application Use Case

`core/application/use-cases/ListDashboardRecentProjectsUseCase.ts`

```ts
export interface ListDashboardRecentProjectsDeps<TViewModel> {
  sources: RecentProjectsSourcePort[];
  cache: RecentProjectsCachePort<TViewModel>;
  output: ListDashboardRecentProjectsOutputPort<TViewModel>;
  clock: ClockPort;
  logger: LoggerPort;
}

export class ListDashboardRecentProjectsUseCase<TViewModel> {
  constructor(private readonly deps: ListDashboardRecentProjectsDeps<TViewModel>) {}

  async execute(cacheKey: string): Promise<TViewModel> {
    const cached = await this.deps.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const batches = await Promise.all(this.deps.sources.map((s) => s.list()));
    const aggregates = mergeRecentProjectCandidates(batches.flat());
    const viewModel = this.deps.output.present(aggregates);

    await this.deps.cache.set(cacheKey, viewModel, 10_000);
    return viewModel;
  }
}
```

Почему это лучше прошлого варианта:

- use case orchestration не знает ни про renderer, ни про IPC DTO
- output model отдаётся через presenter port
- cache тоже внешний порт, а не private field in use case

Это уже настоящий `ports/adapters` shape.

---

## 8.4 Adapters

### `DashboardRecentProjectsPresenter`

Responsibility:

- `RecentProjectAggregate[] -> DashboardRecentProject[]`

Это output adapter, реализующий `ListDashboardRecentProjectsOutputPort`.

### `ClaudeRecentProjectsSourceAdapter`

Responsibility:

- взять active Claude context
- получить grouped repos
- превратить их в `RecentProjectCandidate[]`

Это driven/output adapter, реализующий `RecentProjectsSourcePort`.

### `CodexRecentProjectsSourceAdapter`

Responsibility:

- если context не local -> `[]`
- если `codex` missing -> `[]`
- через `codex app-server` достать recent thread summaries
- применить identity resolver
- превратить это в `RecentProjectCandidate[]`

Это тоже driven/output adapter, реализующий `RecentProjectsSourcePort`.

### Why adapters are separate from infrastructure

Потому что adapter переводит **между моделями и портами**, а infrastructure решает **как технически достать данные**.

Пример:

- `CodexAppServerClient` - infrastructure
- `CodexRecentProjectsSourceAdapter` - adapter

Это разные причины для изменения.

---

## 8.5 Infrastructure

### `CodexBinaryResolver`

Только определяет доступен ли standalone `codex`.

### `CodexAppServerClient`

Только транспорт к `codex app-server`.

### `JsonRpcStdioClient`

Только generic stdio JSON-RPC plumbing.

### `RecentProjectIdentityResolver`

Хотя он помогает бизнес-логике, по природе он infrastructure helper, потому что зависит на git/path environment semantics.

### `InMemoryRecentProjectsCache`

Concrete cache adapter.

---

## 9. Contracts Layer

Feature contracts должны содержать только:

- публичные DTO
- API fragment interface
- channel constants

### Recommended files

```text
src/features/recent-projects/contracts/
  dto.ts
  api.ts
  channels.ts
  index.ts
```

### DTO

```ts
export type DashboardProviderId = 'anthropic' | 'codex' | 'gemini';

export type DashboardRecentProjectOpenTarget =
  | { type: 'existing-worktree'; repositoryId: string; worktreeId: string }
  | { type: 'synthetic-path'; path: string };

export interface DashboardRecentProject {
  id: string;
  name: string;
  primaryPath: string;
  associatedPaths: string[];
  mostRecentActivity: number;
  providerIds: DashboardProviderId[];
  source: 'claude' | 'codex' | 'mixed';
  openTarget: DashboardRecentProjectOpenTarget;
  primaryBranch?: string;
}
```

### API fragment

```ts
export interface RecentProjectsElectronApi {
  getDashboardRecentProjects(): Promise<DashboardRecentProject[]>;
}
```

### Channel constant

```ts
export const GET_DASHBOARD_RECENT_PROJECTS = 'get-dashboard-recent-projects';
```

### Important shell rule

`src/shared/types/api.ts` не должен "владеть" этой feature.  
Он может только **композировать** feature fragment:

```ts
import type { RecentProjectsElectronApi } from '@features/recent-projects/contracts';

export interface ElectronAPI extends RecentProjectsElectronApi {
  // existing app methods...
}
```

Это намного чище, чем дублировать feature method shape внутри `shared/types/api.ts`.

---

## 10. Public API, Input Adapters And Composition Root

## 10.1 Feature Main Public API

`src/features/recent-projects/main/index.ts`

Должен экспортировать только:

- use case factory/composer
- input adapter registration helpers
- necessary public ports if really needed

Лучше не экспортировать наружу все внутренние классы поштучно без необходимости.

### Better pattern

```ts
export { createRecentProjectsFeature } from './composition/createRecentProjectsFeature';
export { registerRecentProjectsIpc } from './adapters/input/ipc/registerRecentProjectsIpc';
export { registerRecentProjectsHttp } from './adapters/input/http/registerRecentProjectsHttp';
```

### Why factory is better than many exports

Это уменьшает coupling composition root к внутреннему строению feature.

## 10.2 Feature Composition

Добавить:

```text
src/features/recent-projects/main/composition/createRecentProjectsFeature.ts
```

```ts
export function createRecentProjectsFeature(deps: {
  getActiveContext: () => ServiceContext;
  getLocalContext: () => ServiceContext | undefined;
  logger: LoggerPort;
}) {
  // instantiate infrastructure
  // instantiate adapters
  // instantiate presenter
  // instantiate cache
  // instantiate use case
  // return entrypoint-facing surface
}
```

Именно это делает feature self-contained и масштабируемой.

## 10.3 IPC input adapter

`main/adapters/input/ipc/registerRecentProjectsIpc.ts`

Он не должен знать, как строится Codex client, cache или merge policy.

Он должен только:

- принять feature facade
- зарегистрировать handler
- прокинуть `cacheKey`

## 10.4 HTTP input adapter

То же самое для Fastify route.

## 10.5 Preload bridge

`preload/createRecentProjectsBridge.ts`

Bridge должен возвращать только feature API fragment:

```ts
export function createRecentProjectsBridge(): RecentProjectsElectronApi {
  return {
    getDashboardRecentProjects: () =>
      ipcRenderer.invoke(GET_DASHBOARD_RECENT_PROJECTS),
  };
}
```

Это хороший пример thin interface adapter.

---

## 11. Renderer Architecture

### 11.1 Renderer public entrypoint

`src/features/recent-projects/renderer/index.ts`

```ts
export { RecentProjectsSection } from './ui/RecentProjectsSection';
```

Внешний мир должен импортировать только это.

### 11.2 `useRecentProjectsSection`

Responsibility:

- загрузить `DashboardRecentProject[]`
- взять decorations из store
- через adapter получить card models
- отдать state for UI

### 11.3 `RecentProjectsSectionAdapter`

Responsibility:

- `DashboardRecentProject[] + task/team decorations -> RecentProjectCardModel[]`

Он не должен:

- выполнять fetch
- открывать проекты

### 11.4 `useOpenRecentProject`

Responsibility:

- encapsulate navigation policy

Это interaction adapter, а не UI helper.

Сюда выносится:

- `findMatchingWorktree`
- refresh repository groups
- `addCustomProjectPath`
- synthetic fallback group

### 11.5 `RecentProjectCard`

Responsibility:

- чистая presentation

Не импортирует:

- `useStore`
- `api`
- navigation utils

### 11.6 `RecentProjectsSection`

Responsibility:

- layout
- error/loading/empty states
- search filtering
- cards grid

---

## 12. DRY Rules For This Feature

### Rule 1

Одна merge policy в `domain/policies/mergeRecentProjectCandidates.ts`

### Rule 2

Одна navigation policy в `renderer/hooks/useOpenRecentProject.ts`

### Rule 3

Одна provider presentation mapping function в `renderer/utils/projectDecorations.ts`

### Rule 4

Одна Codex fetch policy в `CodexRecentProjectsSourceAdapter`

### Rule 5

Одна cache policy в `InMemoryRecentProjectsCache`

---

## 13. Tech Decisions For Codex

### Decision

Для phase 1 использовать:

- ephemeral `codex app-server`
- only `sourceKinds: ['vscode', 'cli']`
- include live + archived
- no file parsing

### Why

- этого достаточно для homepage use case
- не тянем слишком рискованную нативную storage-зависимость
- уменьшаем complexity

### Timeouts

- initialize: `3_000 ms`
- each list call: `3_000 ms`
- total Codex fetch: `8_000 ms`
- cache TTL: `10_000 ms`

---

## 14. Guard Rails

Если хотим, чтобы feature правда была эталонной, нужны guard rails.

### Recommended rule set

1. Outside feature import only public feature entrypoints:
   - `@features/recent-projects/contracts`
   - `@features/recent-projects/main`
   - `@features/recent-projects/preload`
   - `@features/recent-projects/renderer`

2. No deep imports from one process subtree into another.

3. `renderer/ui` components cannot import store or API directly.

4. `core/application` cannot import `electron`, `fastify`, `child_process`.

5. `core/domain` must remain side-effect free.

### Optional but recommended later

- add `no-restricted-imports` rules to enforce this automatically

---

## 15. Implementation Sequence

### Step 1

Create feature tree:

- `src/features/recent-projects`

### Step 2

Add alias support:

- `tsconfig.json`
- `tsconfig.node.json`
- `electron.vite.config.ts`

### Step 3

Create contracts:

- DTO
- API fragment
- channel constant

### Step 4

Create domain:

- candidate
- aggregate
- provider id
- merge policy

### Step 5

Create application layer:

- use case
- ports
- response model

### Step 6

Create output adapters:

- Claude source adapter
- Codex source adapter
- presenter

### Step 7

Create infrastructure:

- cache
- identity resolver
- Codex binary/client/json-rpc

### Step 8

Create feature composition root:

- `createRecentProjectsFeature`

### Step 9

Create driving input adapters:

- IPC
- HTTP

### Step 10

Create preload bridge

### Step 11

Create renderer:

- section adapter
- section hook
- open hook
- card UI
- section UI

### Step 12

Integrate into app shell:

- `src/main/index.ts`
- `src/main/ipc/handlers.ts`
- `src/main/http/index.ts`
- `src/preload/index.ts`
- `src/renderer/components/dashboard/DashboardView.tsx`

### Step 13

Add tests and architecture review pass

---

## 16. Test Strategy

### Domain tests

- merge policy
- branch conflict behaviour
- openTarget preference
- provider dedupe

### Application tests

- use case orchestrates sources + cache + presenter
- cache hit path
- cache miss path
- degraded Codex path still returns Claude result

### Adapter tests

- Claude source mapping
- Codex source mapping
- presenter mapping
- renderer section adapter mapping
- `useOpenRecentProject` navigation policy

### Infrastructure tests

- in-memory cache TTL
- Codex binary resolver success/failure
- app-server client request/timeout handling

### Renderer tests

- loading / empty / error states
- provider logos shown
- task/team decorations aggregated by `associatedPaths`

### Manual checks

1. local context without `codex`
2. local context with `codex`
3. mixed Claude + Codex repo
4. Codex-only non-git folder
5. ssh context

---

## 17. Anti-Patterns To Avoid

Не делать:

- одну папку feature без внутренних слоёв
- use case, который напрямую знает про `CodexAppServerClient`
- presenter logic inside React components
- store/API imports inside `RecentProjectCard`
- дублирование navigation fallback
- прямой import feature internals из app shell
- подмешивание recent-projects logic обратно в `DashboardView`

---

## 18. Final Recommendation

Если эта feature должна быть эталоном, то лучший shape такой:

- **feature-центричная структура**
- **строгий ports/adapters**
- **composition root внутри самой feature**
- **тонкий app shell**
- **тонкие input adapters и preload bridge**
- **чистый renderer UI без бизнес-логики**

Итоговый выбранный подход:

`Full vertical slice in src/features with core separated from process adapters`
`🎯 9   🛡️ 10   🧠 8`
Примерно `700-1000` строк

Это дороже, чем прагматичный hybrid, но это уже действительно можно считать reference implementation по `SOLID`, `Clean Architecture`, `Ports/Adapters` и `DRY`.
