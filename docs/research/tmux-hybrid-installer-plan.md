# План: Hybrid tmux Installer для Desktop App

Дата: 2026-04-14

Рекомендуемый подход: `Hybrid installer`

Оценка подхода: 🎯 9   🛡️ 8   🧠 6

Примерный объём первой качественной реализации:
- `macOS/Linux installer + UI + status/progress + manual fallback` - `900-1400` строк
- `Windows WSL wizard + richer status` - ещё `700-1200` строк
- `Windows runtime enablement через WSL tmux` - ещё `600-1200` строк

Итого полноценный вариант, где Windows не просто умеет "установить", а реально получает пользу от `tmux` - примерно `2200-3800` строк.

## 1. TL;DR

Нужно сделать отдельный feature slice `tmux-installer`, где main-side orchestration layer по UX-паттерну похож на существующий `CliInstallerService`, но не копирует его буквально.

Ключевая идея:
- `macOS` - автодетект `Homebrew`, fallback на `MacPorts`, иначе manual install
- `Linux` - автодетект native package manager, установка через `sudo` в PTY, честный step-based progress
- `Windows` - не притворяться native installer'ом, а сделать честный `WSL wizard` + проверку/re-check каждого шага

Самый важный architectural gotcha:

⚠️ Сейчас Windows-путь в приложении вообще не использует `tmux`, даже если пользователь сам его поставит в WSL.

Это видно прямо в коде:
- `src/main/services/team/runtimeTeammateMode.ts` жёстко отключает process/tmux path на `win32`
- `src/main/ipc/tmux.ts` проверяет только host `tmux`, а не `wsl ... tmux`

Следствие:
- сделать только installer на Windows недостаточно
- если хотим честно обещать "лучший опыт после установки", нужно добавить хотя бы базовую WSL-aware tmux detection
- если хотим реальный runtime gain на Windows, нужно отдельно включить WSL tmux path в runtime-решении teammate mode

## 2. Цели

### Продуктовые цели

- Пользователь может установить `tmux` максимально удобно из UI
- UI честно показывает, что происходит: `checking`, `installing`, `verifying`, `completed`, `error`
- Если установка не удалась, пользователь не остаётся в тупике
- Manual fallback всегда есть и всегда OS-specific
- Никаких фейковых "100% success", если verification не прошло
- Ошибки формулируются человеческим языком, а не сырым stack trace

### Технические цели

- Не ломать текущий `TmuxStatusBanner`
- Сделать фичу по canonical standard из `docs/FEATURE_ARCHITECTURE_STANDARD.md`
  - source of truth для новой фичи - `src/features/tmux-installer/`
  - `src/renderer/components/dashboard/TmuxStatusBanner.tsx` должен стать thin wrapper или compatibility entrypoint, который импортирует только public renderer entrypoint фичи
- Переиспользовать существующие примитивы:
  - `CliInstallerService` как референс по progress/event architecture
  - `PtyTerminalService` как база для PTY lifecycle, но не полагаться на него "как есть"
  - `TerminalModal` только как визуальный reference, не как источник истины для installer flow
  - shell env resolution из существующих infra helpers
- Сделать state machine, которую можно тестировать unit/integration тестами
- Не делать platform-specific хаос прямо в React-компоненте

### Не-цели v1

- Не собирать `tmux` из source автоматически
- Не устанавливать Homebrew автоматически
- Не поддерживать экспериментальные native Windows forks `tmux` по умолчанию
- Не делать "реальный процент" там, где package manager его не даёт
- Не пытаться тихо обходить OS security model

## 3. Внешние факты, на которых строится план

- tmux official install wiki перечисляет package manager команды для Linux/macOS и отдельно static binaries только для common Linux/macOS platforms: [tmux Installing wiki](https://github.com/tmux/tmux/wiki/Installing)
- Homebrew formula для `tmux` сейчас показывает `brew install tmux`, bottle support для macOS и Linux, stable `3.6a`: [Homebrew tmux](https://formulae.brew.sh/formula/tmux)
- MacPorts для `tmux` сейчас рекомендует `sudo port install tmux`, версия `3.6a`: [MacPorts tmux](https://ports.macports.org/port/tmux/)
- Microsoft для WSL пишет: открыть PowerShell в administrator mode, выполнить `wsl --install`, затем restart machine: [Install WSL](https://learn.microsoft.com/en-us/windows/wsl/install)
- Microsoft также документирует `wsl --list --online`, `wsl --distribution ... --user ...`, `wsl --status`, `wsl --shutdown`: [Basic commands for WSL](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)
- Microsoft отдельно держит manual WSL install path для older Windows builds / server-like scenarios: [Manual installation steps for older versions of WSL](https://learn.microsoft.com/en-us/windows/wsl/install-manual)

## 3.1 Самые рискованные места плана после перепроверки

Это секции, где изначально была наименьшая уверенность и которые были усилены после дополнительной проверки.

### ⚠️ Windows installer != Windows runtime support

Самый критичный момент:
- `WSL wizard` сам по себе ещё не даёт реальной выгоды рантайму
- пока `runtimeTeammateMode` и `tmux status` не станут `WSL-aware`, Windows-часть будет только подготавливать окружение

Именно поэтому в этом плане Windows runtime enablement выделен как обязательный follow-up, а не "nice to have".

### ⚠️ Не надо по умолчанию ставить tmux внутри WSL как `root`

Изначальная идея с:

```powershell
wsl --distribution Ubuntu --user root -- sh -lc "apt-get install -y tmux"
```

слишком оптимистична для v1.

Почему это риск:
- distro может быть ещё не bootstrap-ready
- поведение imported/custom distros менее предсказуемо
- мы можем получить "сработало технически, но пользователь не понимает, что произошло"

Более надёжное решение:
- сначала довести distro до явного `bootstrapped` состояния
- затем запускать install flow через PTY внутри `wsl.exe`
- по умолчанию ставить как обычный Linux-user через `sudo`, а не скрыто через root
- `--user root` оставить только как optional future optimization, не как default v1 path

### ⚠️ Linux immutable distros надо считать unsupported для v1 auto-install

Если это:
- `rpm-ostree`
- Silverblue / Kinoite
- transactional-update / MicroOS

то "обычный package manager install в хост" либо не тот путь, либо вообще misleading UX.

Надёжнее:
- детектить immutable-host признаки
- сразу переводить пользователя в `manual-only guidance`
- не делать вид, что обычный `dnf install tmux` или `zypper install tmux` там надёжен

### ⚠️ Не надо делать `apt-get update` всегда перед install

Изначальный пример с:

```bash
apt-get update && apt-get install -y tmux
```

практически рабочий, но хуже как default:
- медленнее
- больше сетевых точек отказа
- лишний шум в логах

Надёжнее:
- сначала пробовать `install`
- если ошибка похожа на stale metadata / package not found due to old index, делать controlled retry с `update`

### ⚠️ Windows elevation надо проектировать как отдельный тип шага, а не как "ещё один child process"

Это место долго оставалось самым неформализованным.

Проблема:
- WSL core install часто требует elevation
- типичный способ вызвать UAC это PowerShell `Start-Process -Verb RunAs`
- по официальному синтаксису `Start-Process` режим с `-Verb` относится к `Use Shell Execute`, а redirect-параметры живут в другом parameter set, поэтому надёжного "RunAs + live redirected stdout/stderr в тот же процесс" по умолчанию ожидать нельзя. Это мой вывод из PowerShell docs: [Start-Process](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/start-process?view=powershell-7.6)

Следствие:
- elevated Windows step нельзя моделировать как обычный `spawn child and stream logs`
- это должен быть отдельный class of step в installer state machine

Надёжнее:
- либо делать `external elevated step + fresh probe afterwards`
- либо, если очень нужны diagnostics, запускать временный elevated helper script, который пишет итоговый JSON/status file в temp location, а app его потом читает
- но даже в варианте с status file финальное решение всё равно принимать только после fresh system probe

### ⚠️ Нельзя строить Windows path вокруг "default distro" как единственного источника истины

Это ещё один недооценённый риск.

Проблема:
- пользователь может установить `tmux` в `Ubuntu`
- потом default distro поменяется на `Debian` или custom distro
- если приложение смотрит только на default distro, UX станет "tmux снова пропал", хотя на самом деле он установлен в целевом окружении

Надёжнее:
- default distro использовать только как initial heuristic
- после явного wizard choice или успешного install persist'ить `preferred WSL distro`
- дальше status/runtime сначала пробуют persisted distro, а уже потом fallback на default

### ⚠️ Windows WSL runtime должен явно выбрать binary model для `claude`

Это один из самых недооценённых технических рисков.

Проблема:
- текущий `ClaudeBinaryResolver` на Windows может вернуть разные executable shapes: `.exe`, `.cmd`, `.bat`, `.com`
- runtime через WSL tmux не может бездумно считать, что любой найденный host binary одинаково пригоден
- `.cmd` / shell-wrapper path особенно рискованны из-за quoting, shell fallback и cleanup semantics

Дополнительный факт из Microsoft docs:
- Windows tools from WSL must include executable extension
- batch scripts are not direct executables there and need `cmd.exe /C ...`  
Источник: [Working across Windows and Linux file systems](https://learn.microsoft.com/en-us/windows/wsl/filesystems)

Практический вывод для v1 Windows runtime follow-up:
- если идём через WSL tmux + Windows interop, prefer native Windows `.exe` binary
- не считать `.cmd`/`.bat` автоматически runtime-ready без отдельного validation path
- Linux binary inside WSL - это отдельная модель с другими config/auth consequences, её нельзя смешивать с host-binary path без явного решения

## 3.2 Дополнительные design constraints после IOF

- Не использовать `pkexec` в v1 как основной Linux privilege path
  - слишком много variability по desktop environment, polkit agent, headless режимам
  - для нашего desktop app более предсказуемый путь это `PTY + sudo`
- Не строить installer на существующем `PtyTerminalService`/`TerminalModal` без доработки
  - текущий `PtyTerminalService` стримит output только в renderer и не даёт main-side control surface
  - текущий `TerminalModal` сам спавнит процесс и потому не подходит как source of truth для service-owned installer state
- Не показывать raw terminal output без ограничения размера
  - нужен ring buffer
  - нужен redaction policy для чувствительных строк
- Не запускать одновременно `auto-install` и `manual terminal` для одной и той же установки
- Не собирать install команды строковой конкатенацией
  - в плане должны фигурировать `command + args + env + requiresPty`
  - shell string допустим только для заранее заданного inner `sh -lc`, собранного из наших шаблонов, а не из пользовательского ввода
- Для Windows WSL core install не обещать live stdout/stderr как обязательную возможность
  - elevated child process может открываться во внешнем окне/UAC flow
  - progress для этого шага должен быть step-based, а не "мы всегда покажем все логи"
- Для Windows elevated steps нужен отдельный execution contract
  - `pending_external_elevation`
  - `waiting_for_external_step`
  - `external_step_finished`
  - `external_step_failed`
  - это не то же самое, что PTY-backed install на Linux/WSL userland
- Не требовать WSL 2 там, где `tmux` уже реально работает в WSL 1
  - для продукта важнее usable tmux path, чем конкретная WSL version label
- Не оставлять в `TmuxStatus` двусмысленное поле `available`
  - после добавления WSL-aware path нужен явный раздел `host` / `wsl` / `effective`
- Все platform-specific решения должны жить в main-process service layer, не в React

## 4. Текущее состояние кодовой базы

### Feature-стандарт, который надо учитывать

- authoritative document для этой задачи - `docs/FEATURE_ARCHITECTURE_STANDARD.md`
- он задаёт canonical template для medium/large feature:
  - `src/features/<feature>/contracts`
  - `src/features/<feature>/core/domain`
  - `src/features/<feature>/core/application`
  - `src/features/<feature>/main/composition`
  - `src/features/<feature>/main/adapters/input`
  - `src/features/<feature>/main/adapters/output`
  - `src/features/<feature>/main/infrastructure`
  - `src/features/<feature>/preload`
  - `src/features/<feature>/renderer`
- эта задача точно подпадает под full slice, потому что:
  - пересекает больше одной process boundary
  - вводит свой transport bridge
  - вводит свой use case и policy logic
  - имеет main/preload/renderer orchestration
- `src/renderer/features/CLAUDE.md` можно использовать только как локальную подсказку для внутренних renderer-паттернов, но не как главный стандарт этой фичи
- structural reference implementation для этой фичи - `src/features/recent-projects`
  - public entrypoints
  - composition-root wiring
  - preload bridge pattern
  - renderer dumb UI + hook orchestration

### Что уже есть

- `src/main/ipc/tmux.ts`
  - простой `getStatus()`
  - cache TTL
  - probe через `tmux -V`
- `src/shared/types/tmux.ts`
  - минимальный `TmuxStatus`
- `src/renderer/components/dashboard/TmuxStatusBanner.tsx`
  - баннер на дашборде
  - OS-specific manual commands
- `src/main/services/infrastructure/CliInstallerService.ts`
  - хороший референс по installer progress events
  - `setMainWindow()`
  - `sendProgress()`
  - `checking/downloading/verifying/installing/completed/error`
- `src/main/services/infrastructure/PtyTerminalService.ts`
  - PTY для interactive terminal workflows
- `src/renderer/components/terminal/TerminalModal.tsx`
  - уже есть UI для живого терминала и status footer
- `src/main/ipc/config.ts`
  - уже есть полезные WSL helpers:
  - candidate resolution для `wsl.exe`
  - UTF-16-aware decode WSL output
- `src/main/utils/pathDecoder.ts`
  - уже есть path translation utility для WSL mount paths

### Где уже есть ограничения

- `src/main/services/team/runtimeTeammateMode.ts`
  - на `win32` сейчас всегда возвращает `forceProcessTeammates: false`
- `src/main/services/team/TeamProvisioningService.ts`
  - Windows-пропуски по `ps`-based live process detection
  - `kill-pane` работает только через host `tmux`
- `src/main/services/infrastructure/PtyTerminalService.ts`
  - сейчас умеет только `spawn/write/resize/kill`
  - data/exit события уходят напрямую в renderer, но не в installer service
  - сам `node-pty` там optional native addon, так что installer не должен предполагать его наличие без capability check
- `src/renderer/components/terminal/TerminalModal.tsx`
  - это self-managed terminal UI, который сам запускает PTY
  - attach к уже идущему installer session сейчас не поддерживается

### Что можно переиспользовать из `agent_teams_orchestrator`

- package manager resolver:
  - `src/utils/nativeInstaller/packageManagers.ts`
- WSL-aware tmux execution:
  - `src/utils/tmuxSocket.ts`

Это не код "скопировать как есть", а скорее reference implementation и source of ideas.

## 5. Главный продуктовый вывод

### Что можно обещать пользователю честно

#### macOS / Linux

Можно обещать:
- установка из UI
- понятный progress/status
- проверка результата
- fallback на manual install

#### Windows

Можно обещать:
- удобный guided WSL setup
- честный status по каждому шагу
- понятный "что делать дальше"

Нельзя честно обещать:
- silent one-click install без admin/reboot/setup user
- что это сработает на каждом корпоративном ноуте без вмешательства IT

## 6. Рекомендуемая архитектура

### 6.1 Новые сущности внутри feature slice

Добавить:

- `src/features/tmux-installer/core/application/use-cases/GetTmuxStatusUseCase.ts`
- `src/features/tmux-installer/core/application/use-cases/InstallTmuxUseCase.ts`
- `src/features/tmux-installer/core/application/use-cases/CancelTmuxInstallUseCase.ts`
- `src/features/tmux-installer/core/application/use-cases/GetTmuxInstallerSnapshotUseCase.ts`
- `src/features/tmux-installer/core/application/ports/TmuxStatusSourcePort.ts`
- `src/features/tmux-installer/core/application/ports/TmuxInstallerRunnerPort.ts`
- `src/features/tmux-installer/core/application/ports/TmuxInstallerSnapshotPort.ts`
- `src/features/tmux-installer/main/composition/createTmuxInstallerFeature.ts`
- `src/features/tmux-installer/main/adapters/input/ipc/registerTmuxInstallerIpc.ts`
- `src/features/tmux-installer/main/adapters/output/presenters/TmuxInstallerProgressPresenter.ts`
- `src/features/tmux-installer/main/adapters/output/sources/TmuxStatusSourceAdapter.ts`
- `src/features/tmux-installer/main/adapters/output/runtime/TmuxInstallerRunnerAdapter.ts`
- `src/features/tmux-installer/main/infrastructure/installer/TmuxInstallStrategyResolver.ts`
- `src/features/tmux-installer/main/infrastructure/installer/TmuxCommandRunner.ts`
- `src/features/tmux-installer/main/infrastructure/platform/TmuxPlatformResolver.ts`
- `src/features/tmux-installer/main/infrastructure/platform/TmuxPackageManagerResolver.ts`
- `src/features/tmux-installer/main/infrastructure/wsl/TmuxWslService.ts`
- `src/features/tmux-installer/main/infrastructure/wsl/WindowsElevatedStepRunner.ts`
- `src/features/tmux-installer/main/infrastructure/wsl/TmuxWslPathBridge.ts`
- `src/features/tmux-installer/main/infrastructure/wsl/TmuxWslPreferenceStore.ts`

### 6.2 Canonical feature slice по стандарту

Для `tmux-installer` нужен full feature slice, а не renderer-local feature.

Рекомендуемая структура:

```text
src/features/tmux-installer/
  contracts/
    api.ts
    channels.ts
    dto.ts
    index.ts
  core/
    domain/
      models/
      policies/
    application/
      models/
      ports/
      use-cases/
  main/
    index.ts
    composition/
      createTmuxInstallerFeature.ts
    adapters/
      input/
        ipc/
          registerTmuxInstallerIpc.ts
      output/
        presenters/
        sources/
        runtime/
    infrastructure/
      installer/
      platform/
      wsl/
  preload/
    createTmuxInstallerBridge.ts
    index.ts
  renderer/
    index.ts
    adapters/
    hooks/
    ui/
    utils/
```

Почему именно full slice:
- feature пересекает `main -> preload -> renderer`
- у feature есть собственные transport contracts
- у feature есть собственная orchestration logic и policy layer
- у feature есть platform-specific runtime/infrastructure детали, которые нельзя размазывать по app shell

### 6.2.1 Slice responsibilities

`contracts/`
- DTO
- API fragment types
- IPC channel constants
- без store access, Electron-specific wiring и business orchestration

`core/domain/`
- чистые business rules
- capability classification
- error normalization policy
- manual hint selection rules
- completion / retry / fallback invariants
- без Electron, child_process, PTY, package manager calls

`core/application/`
- use cases
- source/output/cache ports
- response models
- orchestration contracts
- без Electron, React, Zustand, child process modules

`main/composition/`
- composition root feature
- wiring use cases, adapters, infrastructure
- небольшой facade для app shell registration

`main/adapters/input/`
- IPC handlers
- перевод transport input в use case calls

`main/adapters/output/`
- presenters
- adapters для source/cache/runtime ports
- тонкий слой между infra и core/application

`main/infrastructure/`
- `PtyTerminalService` integration
- OS/package manager specifics
- WSL detection
- elevated step runner
- binary probing
- path bridge

`preload/`
- thin bridge
- зависит от `contracts/`
- без composition logic

`renderer/`
- dumb UI
- hooks orchestration
- adapters DTO -> view model
- небольшие pure utils

### 6.2.2 Renderer sub-structure внутри canonical slice

Внутри `src/features/tmux-installer/renderer/`:

```text
renderer/
  index.ts
  adapters/
    TmuxInstallerBannerAdapter.ts
  hooks/
    useTmuxInstallerBanner.ts
  ui/
    TmuxInstallerBannerView.tsx
  utils/
    formatTmuxInstallerText.ts
```

Правила:
- `renderer/ui` не импортирует `@renderer/api`, `@renderer/store`, `@main/*`, Electron APIs
- hooks не ходят в `window.electronAPI` напрямую
- transport usage идёт через shared renderer API abstraction
- `TmuxStatusBanner.tsx` остаётся compatibility wrapper и импортирует только `@features/tmux-installer/renderer`

### 6.2.3 Жёсткие правила соответствия standard doc

Обязательные правила:
- app shell и другие фичи импортируют только:
  - `@features/tmux-installer/contracts`
  - `@features/tmux-installer/main`
  - `@features/tmux-installer/preload`
  - `@features/tmux-installer/renderer`
- не делать deep-import feature internals снаружи
- `core/domain` side-effect free
- `core/application` не знает про Electron/React/Zustand/child processes
- `renderer/ui` dumb and presentational
- transport bridge тонкий и живёт в `preload/`
- architecture ориентируется на browser/Tauri-friendly direction

Public entrypoints:

```ts
// src/features/tmux-installer/contracts/index.ts
export * from './api';
export * from './channels';
export * from './dto';

// src/features/tmux-installer/main/index.ts
export { createTmuxInstallerFeature } from './composition/createTmuxInstallerFeature';
export { registerTmuxInstallerIpc } from './adapters/input/ipc/registerTmuxInstallerIpc';

// src/features/tmux-installer/renderer/index.ts
export { TmuxInstallerBannerView } from './ui/TmuxInstallerBannerView';

// src/features/tmux-installer/preload/index.ts
export { createTmuxInstallerBridge } from './createTmuxInstallerBridge';
```

Чего не делать:

```ts
// не импортировать снаружи
import { TmuxInstallerBannerAdapter } from '@features/tmux-installer/renderer/adapters/TmuxInstallerBannerAdapter';
import { InstallTmuxUseCase } from '@features/tmux-installer/core/application/use-cases/InstallTmuxUseCase';
```

App-shell shim rules:
- если трогаем `src/main/ipc/tmux.ts`, он должен остаться только registration/compatibility shim
- если трогаем `src/preload/index.ts`, он должен только подключать `@features/tmux-installer/preload`
- никакой business logic не должна жить в этих shared shell файлах

### 6.2.4 Renderer error model по standard

Внутри feature нужен typed error layer, а не просто `string | null` everywhere.

Рекомендуемо:

```ts
export class TmuxInstallerFeatureError extends Error {
  constructor(
    readonly code:
      | 'ADAPTER_ERROR'
      | 'SNAPSHOT_ERROR'
      | 'PROGRESS_STREAM_ERROR'
      | 'INVALID_STATUS'
      | 'INVALID_PROGRESS',
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'TmuxInstallerFeatureError';
  }
}
```

Где:
- adapter ловит IPC/external shape проблемы и заворачивает их в typed error
- domain service мапит их в user-facing banner state
- UI не работает напрямую с exception shapes

### 6.3 IPC и contracts

Расширить `tmux` API:

```ts
export interface TmuxAPI {
  getStatus: () => Promise<TmuxStatus>;
  install: () => Promise<void>;
  invalidateStatus: () => Promise<void>;
  cancelInstall: () => Promise<void>;
  onProgress: (cb: (event: unknown, data: TmuxInstallerProgress) => void) => () => void;
}
```

Новые IPC channels:

```ts
export const TMUX_GET_STATUS = 'tmux:getStatus';
export const TMUX_INSTALL = 'tmux:install';
export const TMUX_INVALIDATE_STATUS = 'tmux:invalidateStatus';
export const TMUX_CANCEL_INSTALL = 'tmux:cancelInstall';
export const TMUX_INSTALLER_PROGRESS = 'tmux:progress';
```

⚠️ Для feature-based renderer architecture этого недостаточно. Нужен ещё snapshot endpoint, чтобы feature мог восстановиться после remount/reload и не зависеть от того, был ли progress event пойман вживую.

Добавить:

```ts
export const TMUX_GET_INSTALLER_SNAPSHOT = 'tmux:getInstallerSnapshot';

export interface TmuxAPI {
  getInstallerSnapshot: () => Promise<TmuxInstallerSnapshot>;
}
```

Где:
- main process держит актуальный installer state как source of truth
- renderer slice при mount сначала делает `getStatus()` + `getInstallerSnapshot()`
- затем подписывается на live progress

Это должно жить в `src/features/tmux-installer/contracts/`, а не в случайных shared renderer types.

### 6.4 Shared types

Рекомендуемое расширение feature contracts/dto в `src/features/tmux-installer/contracts/`:

```ts
export type TmuxInstallStrategy =
  | 'homebrew'
  | 'macports'
  | 'apt'
  | 'dnf'
  | 'yum'
  | 'zypper'
  | 'pacman'
  | 'wsl'
  | 'manual'
  | 'unknown';

export type TmuxInstallerPhase =
  | 'idle'
  | 'checking'
  | 'preparing'
  | 'requesting_privileges'
  | 'pending_external_elevation'
  | 'waiting_for_external_step'
  | 'installing'
  | 'verifying'
  | 'needs_restart'
  | 'needs_manual_step'
  | 'completed'
  | 'error'
  | 'cancelled';

export interface TmuxInstallHint {
  title: string;
  description: string;
  command?: string;
  url?: string;
}

export interface TmuxAutoInstallCapability {
  supported: boolean;
  strategy: TmuxInstallStrategy;
  packageManagerLabel?: string | null;
  requiresTerminalInput: boolean;
  requiresAdmin: boolean;
  requiresRestart: boolean;
  mayOpenExternalWindow?: boolean;
  reasonIfUnsupported?: string | null;
  manualHints: TmuxInstallHint[];
}

export interface TmuxWslStatus {
  wslInstalled: boolean;
  rebootRequired: boolean;
  distroName: string | null;
  distroVersion: 1 | 2 | null;
  distroBootstrapped: boolean;
  innerPackageManager: TmuxInstallStrategy | null;
  tmuxAvailableInsideWsl: boolean;
  tmuxVersion: string | null;
  tmuxBinaryPath?: string | null;
  statusDetail?: string | null;
}

export interface TmuxWslPreference {
  preferredDistroName: string | null;
  source: 'persisted' | 'default' | 'manual' | null;
}

export interface TmuxBinaryProbe {
  available: boolean;
  version: string | null;
  binaryPath: string | null;
  error: string | null;
}

export interface TmuxEffectiveAvailability {
  available: boolean;
  location: 'host' | 'wsl' | null;
  version: string | null;
  binaryPath: string | null;
  runtimeReady: boolean;
  detail?: string | null;
}

export interface TmuxStatus {
  platform: TmuxPlatform;
  nativeSupported: boolean;
  checkedAt: string;
  host: TmuxBinaryProbe;
  effective: TmuxEffectiveAvailability;
  error: string | null;
  autoInstall: TmuxAutoInstallCapability;
  wsl?: TmuxWslStatus | null;
  wslPreference?: TmuxWslPreference | null;
}

export interface TmuxInstallerProgress {
  type: TmuxInstallerPhase | 'status';
  detail?: string;
  percent?: number;
  rawChunk?: string;
  error?: string;
  status?: TmuxStatus;
  nextManualHint?: TmuxInstallHint | null;
  externalStepLabel?: string;
  canRetryNow?: boolean;
}
```

Смысл полей:
- `host` - что доступно нативно в текущей ОС host
- `wsl` - что доступно внутри WSL на Windows
- `effective` - какой path приложение реально может использовать
- `effective.runtimeReady` важнее простого "binary found", потому что именно он отвечает на вопрос "persistent teammate path действительно можно включать"
- `wslPreference` - какой distro приложение считает целевым для tmux path и почему

## 7. UX и state machine

### 7.1 Принципы UX

- Не писать "сломано", если app просто работает без `tmux`
- Не скрывать platform-specific ограничения
- Не показывать фейковый `%`, если это невозможный процент
- Всегда давать следующий шаг
- Ошибка должна отвечать на 3 вопроса:
  - что не получилось
  - почему это могло случиться
  - что делать дальше

### 7.2 Основные UI состояния

- `Not installed, can auto-install`
  - CTA: `Install tmux`
- `Installing`
  - шаги
  - status detail
  - optional raw logs
  - если `mayOpenExternalWindow === true`, явно предупреждать про отдельное admin/system window
- `Waiting for external admin step`
  - не показывать пустой терминал
  - показывать понятный текст, что Windows мог открыть отдельное elevated окно
  - CTA: `Re-check`
- `Needs manual step`
  - CTA: `Open guide`
  - CTA: `Retry`
- `Needs restart`
  - CTA: `Re-check after restart`
- `Completed`
  - CTA: `Re-check`
- `Error`
  - human-readable error
  - retry
  - manual fallback

### 7.3 Что показывать вместо fake percent

Для package managers использовать не byte progress, а step progress:

```ts
const STEP_WEIGHTS = {
  checking: 10,
  preparing: 20,
  requesting_privileges: 30,
  installing: 70,
  verifying: 90,
  completed: 100,
};
```

То есть progress bar остаётся, но он отражает phase progression, а не сеть.

Это честно и UX-wise полезно.

## 8. Платформенная матрица

## 8.1 macOS

### Стратегия

Порядок:
1. Если `tmux` уже есть - успех, install не нужен
2. Если найден `brew` - использовать Homebrew
3. Иначе если найден `port` - использовать MacPorts
4. Иначе manual fallback

### Почему так

- `brew install tmux` - лучший UX путь для macOS
- MacPorts useful fallback, но более niche
- автоматическая установка Homebrew сама по себе слишком тяжёлая и рискованная для v1

### Команды

#### Homebrew

```bash
brew install tmux
```

#### MacPorts

```bash
sudo port install tmux
```

### Реализация

- использовать shell-aware PATH resolution
- проверять `brew` не только в текущем `PATH`, но и в common prefixes:
  - `/opt/homebrew/bin/brew`
  - `/usr/local/bin/brew`
- `brew install tmux` можно запускать как обычный child process со streaming stdout/stderr
- не вводить `HOMEBREW_NO_AUTO_UPDATE=1` как default optimisation без отдельной валидации
  - это может ускорить UX, но также меняет expected brew behavior
  - если захотим это делать, лучше отдельным tiny spike и только с fallback probe после install
- `port install tmux` запускать через PTY, потому что возможен пароль
- если `brew` install вдруг начинает требовать interactive input или ведёт себя нестабильно через pipes, разрешён fallback на PTY и для `brew`

### Edge cases

- GUI app стартанул не из shell, `brew` не в PATH
- на Intel/macOS старый prefix
- `brew` есть, но formula tap сломан
- bottle download не удался, formula уходит в source build
- `xcode-select` / CLT не установлены
- MacPorts есть, но пользователь отменил `sudo`
- и `brew`, и `port` есть одновременно
- `brew` установлен, но prefix permissions повреждены
- приложение запущено без полного login-shell PATH, но `brew` реально установлен

### Решение по приоритету

Если есть и `brew`, и `port`:
- по умолчанию брать `brew`
- в detail UI можно написать `Using Homebrew (preferred)`

## 8.2 Linux

### Стратегия

Порядок:
1. Если `tmux` уже есть - успех
2. Разобрать `/etc/os-release`
3. Определить distro family
4. Подтвердить наличие package manager binary
5. Сформировать install command
6. Выполнить через PTY

### Почему PTY, а не `execFile`

- `sudo` часто требует TTY
- пользователю может понадобиться ввести пароль
- package manager output полезен как live log
- но PTY должен быть owned main-process installer service, а не renderer modal

### Поддерживаемые менеджеры v1

- Debian / Ubuntu -> `apt-get`
- Fedora / RHEL -> `dnf`
- older RHEL / CentOS -> `yum`
- openSUSE -> `zypper`
- Arch -> `pacman`

### Явно unsupported для auto-install v1

- immutable rpm-ostree hosts
- transactional-update based hosts
- нестандартные embedded/container systems без нормального package DB

Для них:
- auto-install capability = `supported: false`
- только manual guidance
- reason text должен быть явным, не generic

### Команды

#### Debian / Ubuntu

```bash
sudo apt-get install -y tmux
```

#### Fedora / RHEL

```bash
sudo dnf install -y tmux
```

#### old RHEL / CentOS

```bash
sudo yum install -y tmux
```

#### openSUSE

```bash
sudo zypper --non-interactive install tmux
```

#### Arch

```bash
sudo pacman -S --needed --noconfirm tmux
```

### Почему именно такие флаги

- `apt-get -y`
  - Debian manpage: `-y, --yes, --assume-yes` делает install non-interactive и abort'ит на unsafe conditions вроде unauthenticated packages: [apt-get(8)](https://manpages.debian.org/bookworm/apt/apt-get.8.en.html)
- `dnf -y`
  - DNF command reference: `-y, --assumeyes` автоматически отвечает yes на вопросы: [DNF Command Reference](https://dnf.readthedocs.io/en/latest/command_ref.html)
- `zypper --non-interactive install`
  - SUSE docs явно рекомендуют `--non-interactive` до команды `install` для scripted usage: [SUSE zypper docs](https://documentation.suse.com/sles/15-SP5/html/SLES-all/cha-sw-cl.html)
- `pacman --noconfirm`
  - Arch manual: bypasses confirmation prompts и предназначен для scripted usage; `--needed` не переустанавливает уже актуальный target: [pacman(8)](https://man.archlinux.org/man/pacman.8.en)

### Почему `apt-get`, а не `apt`

Официальная tmux wiki в user-facing тексте показывает `apt install tmux`, но для scripted/background workflow стабильнее использовать `apt-get`.

Это design inference, а не quote from source.

### Почему не `pkexec`

Хотя `pkexec` теоретически даёт более desktop-native privilege prompt, в v1 он хуже по надёжности:
- зависит от polkit integration в системе
- отличается по поведению между DE/WM
- в некоторых средах отсутствует или ведёт себя нестабильно

Поэтому default path:
- `PTY + sudo`

### Почему не делаем `apt-get update` always-on

Лучший default flow:

```bash
sudo apt-get install -y tmux
```

Fallback retry only if needed:

```bash
sudo apt-get update && sudo apt-get install -y tmux
```

Причина:
- меньше network surface area
- быстрее happy-path
- проще читать логи

### Linux edge cases

- пользователь уже root -> не добавлять `sudo`
- `sudo` не установлен
- пользователь не в sudoers
- package manager lock:
  - `apt` lock
  - `pacman` lock
- repository metadata stale
- offline network
- unsupported distro family
- host/container environment без нормального package database
- `tmux` установился, но verification через `tmux -V` всё равно не проходит из-за PATH/env
- immutable distro, где host package install не должен быть auto path
- `sudo` требует TTY password prompt, но пользователь закрывает modal
- `pacman` keyring / mirror init issues
- `dnf` metadata or repo config corruption
- `zypper` registration/repo state issues на SUSE
- `yum` / enterprise repo family, где `tmux` отсутствует в подключённых repo
- `zypper` interactive repo/license conditions, которые не должны auto-accept'иться молча

### Ошибки, которые нужно распознавать отдельно

- permission denied / authentication failure
- package manager locked
- package not found
- network / mirror resolution failed
- cancelled by user
- immutable host unsupported
- package manager present, but repository configuration invalid
- repository missing required channel / EPEL-like repo not enabled

## 8.3 Windows

### Главная продуктовая позиция

Windows в v1 не должен притворяться нативной `tmux` платформой.

Путь:
- `WSL wizard`
- затем установка `tmux` внутри WSL
- затем re-check

### Важный architectural caveat

⚠️ Пока runtime Windows не станет WSL-aware, этот wizard даст только "prepared environment", но не реальный runtime win.

Поэтому план на Windows нужно делить на два слоя:

#### Layer A

Installer / wizard / detection / guidance

#### Layer B

Runtime enablement:
- WSL-aware `tmux` detection
- WSL-aware teammate mode decision
- WSL-aware pane/session ops

### Рекомендуемый flow

#### Шаг 1. Проверка WSL core и distro state

Пробуем:

```powershell
wsl --status
```

Если WSL не установлен:
- показываем CTA `Install WSL`
- detail: нужен admin и, возможно, restart

Если `wsl --status` itself unsupported on older build:
- не классифицировать это как обычный "WSL missing"
- это отдельный capability signal
- дальше либо fallback probe через `wsl --list --verbose`, либо сразу manual Microsoft guidance для older Windows path

Если WSL установлен, но дистрибутива ещё нет:
- это отдельное состояние, не путать с `WSL missing`
- дальше нужен install конкретного distro, а не повторная "общая" диагностика

Дополнительное правило:
- не блокировать сценарий только потому, что distro на WSL 1
- если inner `tmux` запускается и будущий runtime smoke test проходит, это usable path

#### Шаг 2. Установка WSL

Если WSL отсутствует полностью, рекомендуемый путь:

```powershell
wsl --install --no-distribution
```

Если хотим объединённый flow "WSL + сразу Ubuntu":

```powershell
wsl --install -d Ubuntu --no-launch
```

Если install hangs или Store path problematic, дать fallback hint:

```powershell
wsl --install --web-download -d Ubuntu
```

Флаги тут выбраны не случайно:
- `--no-launch` documented in Microsoft basic commands as "install distro but do not launch it automatically": [Basic commands for WSL](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)
- `--web-download` documented in Microsoft install guide как fallback, если install hangs at `0.0%`: [Install WSL](https://learn.microsoft.com/en-us/windows/wsl/install)
- `--no-distribution` documented in Microsoft basic commands for the case where WSL itself is not installed and you want to skip distro install during the core setup: [Basic commands for WSL](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)

⚠️ Самое важное ограничение этого шага:
- `wsl --install` обычно требует elevation
- из обычного Electron process нельзя обещать, что мы всегда тихо запустим elevated child и будем стримить его live output назад в UI

Поэтому для v1 надёжный UX такой:
- step-based progress внутри баннера
- явный текст `An administrator window may open`
- если нужен внешний elevated PowerShell, это нормально
- после завершения шага всегда делать fresh re-check, а не верить только exit code внешнего окна

Почему это лучше для нашего плана:
- у нас уже есть отдельные UX steps `Install WSL` и `Install Ubuntu`
- `--no-distribution` лучше совпадает с этой state machine
- меньше путаницы, когда WSL core установился, а distro ещё нет

Предпочтительный execution model для этого шага:
1. app создаёт temp marker directory
2. app запускает elevated helper через PowerShell `Start-Process -Verb RunAs -Wait`
3. helper выполняет `wsl --install ...`
4. helper пишет короткий JSON result file в temp directory
5. app читает result file, но всё равно делает fresh probe через `wsl --status` / `wsl --list`

Это лучше, чем надеяться на redirected stdout/stderr, который в `RunAs` flow ненадёжен.

Implementation note:
- helper лучше запускать как temp `.ps1` file, а не как огромную inline command string
- так меньше quoting bugs и проще сохранять diagnostics/result file

### Почему `--no-launch`

Это даёт нам больше контроля над wizard flow:
- сначала установить
- потом отдельно проверить reboot requirement
- потом отдельно вести пользователя в first-launch/bootstrap

### Шаг 3. Restart detection

После WSL install:
- если `wsl --status` / `wsl -l -v` всё ещё не готово
- или Windows сообщает, что optional components activated but reboot required

UI state:
- `needs_restart`
- кнопка `Re-check after restart`

Отдельный edge:
- для older Windows builds, где `wsl --install` вообще не поддерживается, сразу переводить в manual guidance на official Microsoft manual install page, а не пытаться эмулировать unsupported flow: [Manual installation steps for older versions of WSL](https://learn.microsoft.com/en-us/windows/wsl/install-manual)

### Шаг 3.5. Установка Linux distro, если WSL core уже есть

Если `wsl --status` успешен, но список дистрибутивов пуст:
- это не повод повторять full WSL core install
- дальше нужен именно install distro

Рекомендуемый путь:

```powershell
wsl --list --online
wsl --install -d Ubuntu --no-launch
```

Если online catalog недоступен или Store path заблокирован:
- сразу дать manual Microsoft guidance
- не обещать, что приложение само обойдёт Store/corporate restrictions

Продуктовое правило:
- `Install WSL` и `Install Ubuntu` должны быть разными step labels в UI
- это уменьшает путаницу при поддержке и в error analytics

Design rule:
- `Install Ubuntu` тоже не надо моделировать как гарантированно одинаковый in-app step на всех Windows машинах
- где-то он пройдёт как normal command path, где-то уйдёт в Store / external flow, где-то упрётся в policy
- поэтому и этот шаг должен завершаться только fresh probe'ом по факту появившегося distro, а не optimistic success UI

### Шаг 4. Distro bootstrap

Даже когда WSL установлен, пользователь может ещё не пройти first-launch distro setup.

Признаки:
- distro установлена, но inner command падает
- first launch требует initial decompression или user creation

Решение:
- отдельный шаг `Complete Linux distro setup`
- открываем пользователю команду:

```powershell
wsl -d <SelectedDistro>
```

После этого пользователь:
- ждёт распаковку
- создаёт Linux username/password

Затем возвращается в app и нажимает `Re-check`.

### Почему bootstrap должен быть отдельным шагом, а не скрытой автоматикой

Это более надёжно и честно:
- пользователь видит создание Linux account/password
- меньше магии
- меньше platform-specific assumptions про state дистрибутива
- проще поддержка и диагностика

### Шаг 4.1 Distro selection policy

Если default distro уже есть:
- используем её

Если distro нет:
- предлагаем `Ubuntu` как recommended default
- но в коде не хардкодим будущие команды на имя `Ubuntu`
- реальное имя выбранного/установленного дистрибутива всегда берём из `wsl --list --verbose` / `wsl --list --quiet`

Лучший practical rule:
- для списка имён дистрибутивов prefer `wsl --list --quiet`
- `--list --verbose` использовать в основном для diagnostics и best-effort `distroVersion`
- это снижает зависимость от локализованных header/state строк в output. Microsoft docs отдельно показывают `--quiet` как режим "show only distribution names": [Basic commands for WSL](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)
- если нужно понять именно default distro, лучше опираться на stable markers вроде `*` prefix / persisted preference, а не на локализованные текстовые суффиксы

Если их несколько:
- в v1 можно брать default distro
- если default не определён, нужна явная UI selection или forced recommendation

Нельзя молча выбирать произвольную distro, если их несколько и default неочевиден.

Если default distro есть, но его family unsupported для нашего auto-install v1:
- не пытаться "угадать" команды
- либо даём manual guidance для этого дистрибутива
- либо предлагаем отдельно установить supported distro, например Ubuntu
- не меняем default distro молча

Важное уточнение после IOF:
- default distro нужен только как first guess
- после user choice или успешной установки приложение должно persist'ить `preferred distro`
- дальнейшие `status`, `verify` и будущий runtime follow-up сначала используют persisted distro
- если persisted distro исчезла из `wsl --list`, это отдельный recoverable state:
  - clear stale preference
  - показать понятный re-select / re-install flow

### Шаг 5. Установка tmux внутри WSL

Когда distro доступна, дальше стратегия как на Linux, но команды выполняются внутри WSL.

Надёжный v1 default:
- запускать install внутри `wsl.exe` через PTY
- использовать Linux-user path с `sudo`
- не делать hidden root install по умолчанию

Например для выбранного distro:

```powershell
wsl --distribution <SelectedDistro> -- sh -lc "sudo apt-get install -y tmux"
```

Если distro не Debian-based:
- читаем `/etc/os-release` внутри WSL
- подбираем inner package manager как для Linux
- если family unsupported, останавливаем auto path и даём manual guidance вместо рискованной "магии"

Нюанс UX:
- пароль здесь обычно не Windows admin password, а Linux password выбранного WSL user
- это нужно явно подписать в UI, иначе пользователь будет думать, что приложение просит "не тот пароль"

Нюанс надёжности:
- если делаем retry вроде `apt-get update && apt-get install`, лучше держать это в том же PTY session
- так мы не теряем `sudo` timestamp и не заставляем пользователя вводить пароль дважды без причины

Optional future optimization:
- после явной проверки bootstrap-ready state можно отдельно исследовать `--user root`
- но это не должно быть основным путём v1

### Шаг 6. Verification

```powershell
wsl --distribution <SelectedDistro> -- sh -lc "tmux -V"
```

Но для надёжности этого мало.

Рекомендуемая verification ladder:
1. `tmux -V`
2. безопасный smoke test на отдельном socket name, чтобы не трогать пользовательские tmux sessions

Например:

```powershell
wsl --distribution <SelectedDistro> -- sh -lc "tmux -L codex-smoke -f /dev/null new-session -d true && tmux -L codex-smoke kill-server"
```

Именно smoke test лучше отвечает на вопрос "runtime path реально живой", а не только "binary существует".

Для Windows follow-up это особенно важно:
- smoke test должен по возможности использовать тот же adapter path, который потом будет использовать runtime
- иначе можно случайно проверить "tmux работает в интерактивном `wsl sh -lc`", но не проверить "наш main-process adapter реально умеет работать с ним стабильно"

### Windows edge cases

- user denied UAC prompt
- WSL install succeeded partially
- reboot required
- no distro installed
- distro exists but not bootstrapped
- imported distro без launcher quirks
- default distro не Ubuntu
- inner distro не Debian-based
- inner distro unsupported для v1 auto-install
- WSL networking / store download issues
- corporate policy blocks virtualization
- `wsl.exe` есть, но kernel/update broken
- WSL установлен, но default distro не выбрана
- `wsl --install` partially succeeded, но distro не зарегистрировалась
- пользователь завершил bootstrap partially и закрыл окно
- Windows build слишком старый для `wsl --install`
- app не elevated и WSL core install ушёл во внешний admin window без live stdout
- 32-bit helper process path quirks для `wsl.exe`; defensive note из Microsoft docs - при необходимости `C:\\Windows\\Sysnative\\wsl.exe --command`: [Basic commands for WSL](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)
- locale-sensitive WSL output, если где-то случайно полагаться на human-readable headers вместо quiet list / stable markers

## 9. Самое важное решение по Windows runtime

Если хотим сделать Windows path не "paper feature", а реально полезным, нужно обязательно сделать follow-up:

### 9.1 `tmux:getStatus` на Windows должен стать WSL-aware

Сейчас status проверяет host binary. Это не подходит.

Нужно:
- сначала probe host tmux
- если `win32` и host tmux нет:
  - resolve `wsl.exe` через candidate list, а не слепо через `'wsl'`
  - decode output defensively, потому что `wsl.exe` может возвращать UTF-16LE / mixed encoding
  - probe `wsl --status`
  - probe persisted/default/selected distro
  - probe inner `tmux -V`
- собирать не один boolean, а нормальный `host / wsl / effective` snapshot
- не считать WSL 1 автоматическим fail, если smoke test на `tmux` проходит

У нас уже есть полезные reference pieces в кодовой базе:
- `src/main/ipc/config.ts`
  - candidate paths для `wsl.exe` (`System32`, `Sysnative`, fallback `wsl.exe`)
  - UTF-16-aware decoding output
  - `listWslDistros()` с несколькими command variants (`--list --quiet`, `-l -q`, `-l`)

Их нужно не дублировать ad-hoc, а переиспользовать или вынести в общий helper.

Ещё одно правило:
- `distroVersion` полезен как diagnostic field, но не должен быть gating factor сам по себе
- gating factor это usable adapter path + smoke test, а не просто цифра `1` или `2`

### 9.2 `resolveDesktopTeammateModeDecision()` на Windows

Сейчас:

```ts
if (process.platform === 'win32') {
  return {
    injectedTeammateMode: null,
    forceProcessTeammates: false,
  };
}
```

Для полноценного Windows support это надо заменить на WSL-aware decision path.

### 9.3 Team runtime ops

Нужно отдельно решить:
- как запускать `tmux` команды через `wsl -e tmux ...`
- как резолвить `wsl.exe` и его output decoding consistently во всех runtime ops
- как хранить pane ids / target ids
- как делать cleanup
- как переводить Windows `cwd` в WSL path и обратно
- как не ломаться на UNC paths вида `\\\\wsl.localhost\\<distro>\\...`
- как пинить `WSL_INTEROP` для долгоживущего tmux server
- как persist'ить целевой distro и не ломаться, если default distro изменился
- какой `claude` binary model считается supported внутри WSL tmux runtime

Это не детали, а критичные runtime requirements.

Отдельное правило:
- прямые tmux runtime-команды на Windows должны идти через direct exec path (`wsl -e tmux ...` / `wsl --exec tmux ...`), а не через shell wrapper
- shell wrapper оставляем только там, где реально нужен `sh -lc`, например для package-manager install steps

Почему это важно:
- tmux format strings вроде `#{socket_path}` содержат `#`
- если команду отдать login shell'у, shell может интерпретировать это как comment и сломать вызов
- этот баг уже отражён в orchestrator reference

#### 9.3.1 Path translation

Если team runtime на Windows будет реально работать через WSL tmux, то `request.cwd` и любые project-related paths нельзя просто пробрасывать как есть.

Нужно:
- для Windows host paths делать conversion в WSL path
- для UNC WSL paths проверять совпадение distro
- иметь fallback manual conversion, если `wslpath` unavailable

Reference ideas уже есть в:
- `agent_teams_orchestrator/src/utils/idePathConversion.ts`
- `src/main/utils/pathDecoder.ts`

Без этого можно получить очень неприятные полубаги:
- tmux стартует, но в неправильном `cwd`
- runtime работает только для `C:\\...`, но ломается на `\\\\wsl.localhost\\...`
- путь формально передан, но внутри WSL не существует

#### 9.3.1.a Cross-filesystem performance and case semantics

Это отдельный риск, который нельзя путать с "путь существует".

По Microsoft docs:
- при работе из Linux command line fastest path - хранить файлы в WSL filesystem
- работа по `/mnt/c/...` возможна, но медленнее
- Windows и Linux по-разному ведут себя по case sensitivity  
Источник: [Working across Windows and Linux file systems](https://learn.microsoft.com/en-us/windows/wsl/filesystems)

Следствие для плана:
- `translatedCwdExists === true` ещё не означает "runtime path хороший"
- если project cwd живёт на Windows filesystem и внутри WSL превращается в `/mnt/c/...`, runtime может быть functional, но slower
- это не должно блокировать v1, но это должно попадать:
  - в diagnostics
  - в optional UX hint вроде `For best performance on Windows + WSL, store the project inside the WSL filesystem`

Ещё один subtle point:
- Windows file systems часто case-insensitive
- Linux file systems case-sensitive
- любые runtime assumptions на равенство путей должны быть нормализованы очень аккуратно

Дополнительный факт:
- Microsoft документирует `WSLENV` как bridge для env vars между Windows и WSL, включая path translation flags  
Источник: [Working across Windows and Linux file systems](https://learn.microsoft.com/en-us/windows/wsl/filesystems)

Практический вывод:
- `WSLENV` можно рассматривать как future optimisation/helper
- но для v1 лучше не делать его primary correctness layer
- path bridge должен оставаться явным и testable в нашем коде

#### 9.3.2 `WSL_INTEROP` pinning

Самый скрытый и опасный runtime bug сейчас подсвечен в orchestrator reference:
- tmux server, стартовавший через краткоживущий `wsl.exe`, может унаследовать нестабильный interop socket
- после detach/exit spawning `wsl.exe` interop перестаёт корректно работать для дальнейших Win32 launches из tmux

Reference:
- `agent_teams_orchestrator/src/utils/tmuxSocket.ts`

Практический вывод для плана:
- Windows runtime follow-up должен явно закладывать `WSL_INTEROP=/run/WSL/1_interop` при создании isolated tmux server
- и ставить его в tmux global environment для новых sessions

Иначе можно получить очень неприятный класс багов:
- installer/verify выглядит успешным
- tmux server поднимается
- но позже реальные команды из persistent teammate path начинают падать на interop/timeouts

#### 9.3.3 Isolated socket and `TMUX` env override

Ещё один обязательный runtime requirement:
- приложение не должно работать в пользовательском tmux server по умолчанию
- нужен отдельный isolated socket, как в orchestrator reference

Нужно:
- создавать свой socket name, например `claude-<pid>` или другой deterministic app-specific format
- все tmux команды гонять через `-L <socket>`
- дочерним процессам внутри teammate runtime прокидывать правильный `TMUX` env, указывающий на наш socket
- cleanup всегда делать только по нашему socket name / server pid, не по generic tmux targets

Иначе можно словить очень неприятный bug class:
- user уже работает в своём tmux внутри WSL
- приложение начинает управлять не своим server/session
- cleanup и `kill-pane` задевают не тот runtime

#### 9.3.4 `claude` binary model inside WSL tmux

Нужно принять explicit решение, что именно запускает teammate runtime внутри WSL pane:

Вариант A - host Windows `claude.exe` через WSL interop
- 🎯 8   🛡️ 7   🧠 6
- `150-350` строк follow-up logic
- Плюсы:
  - ближе к текущей архитектуре desktop app
  - reuse существующего host-side `ClaudeBinaryResolver`
  - меньше шансов разъехаться по auth/config flows
- Риски:
  - нужно жёстко prefer `.exe`
  - `.cmd`/`.bat` wrappers нельзя считать автоматически эквивалентными
  - interop/runtime smoke test должен проверять именно этот path

Вариант B - Linux `claude` внутри WSL distro
- 🎯 5   🛡️ 6   🧠 8
- `400-900` строк follow-up logic
- Плюсы:
  - более "нативная" Linux execution model внутри tmux
- Риски:
  - отдельная установка binary внутри WSL
  - потенциально другой auth/config root
  - больше drift от текущего Windows desktop runtime
  - если бинарь/скрипты лежат на mounted Windows filesystem, semantics file permissions в WSL становятся отдельным источником проблем: [File permissions for WSL](https://learn.microsoft.com/en-us/windows/wsl/file-permissions)

Рекомендация для v1 follow-up:
- идти через вариант A, но только если available binary это пригодный `.exe`
- если resolver на Windows дал только `.cmd`/`.bat`, не поднимать `runtimeReady=true` без отдельного validated wrapper path

#### 9.3.5 Config/auth root semantics for Windows `claude.exe` from WSL

Это ещё один важный слой, который легко пропустить.

Факт из Microsoft docs:
- Windows executables, запущенные из WSL, работают как Win32 apps активного Windows user и retain WSL working directory for the most part  
Источник: [Working across Windows and Linux file systems](https://learn.microsoft.com/en-us/windows/wsl/filesystems)

Inference для нашего проекта:
- если teammate runtime внутри WSL pane запускает host `claude.exe`, нужно явно проверить, какие config/auth/session roots он использует в таком режиме
- нельзя автоматически считать, что "working dir внутри WSL" означает "и config root тоже WSL"

Практический вывод:
- Windows runtime readiness probe должен включать не только запуск бинаря, но и sanity check на auth/config behavior тем же adapter path
- для v1 лучше держать модель консервативной:
  - prefer host Windows auth/config expectations
  - не объявлять runtime-ready, если probing показывает разъехавшийся config root или странный auth state

Самый логичный reference - `agent_teams_orchestrator/src/utils/tmuxSocket.ts`.

Если это не входит в текущую итерацию, UI/документация должны честно говорить:
- `WSL setup prepares tmux support`
- `full Windows persistent teammate runtime will be enabled in follow-up`

## 10. Надёжность: как сделать "без багов"

## 10.1 Installer mutex

Нельзя запускать 2 инсталла параллельно.

Нужно:

```ts
if (this.installing) {
  this.sendProgress({
    type: 'error',
    error: 'tmux installation is already in progress',
  });
  return;
}
```

## 10.2 Every install ends with verification

Нельзя считать install успешным по exit code package manager alone.

Успех только если:
- install command exit code success
- повторный status probe нашёл `tmux`
- `tmux -V` реально исполняется
- для runtime-critical enablement желательно проходит и лёгкий smoke test на isolated socket/session

Для Windows runtime-critical enablement это лучше уточнить ещё жёстче:
- smoke test должен по возможности запускать тот же `claude` binary model, который потом реально пойдёт в teammate runtime
- тест уровня `tmux ... new-session -d true` полезен, но не доказывает, что interop launch path для реального CLI тоже живой
- если binary model это host `claude.exe` from WSL, probe должен подтверждать и auth/config sanity, а не только факт старта процесса

## 10.2.1 Do not gate only on tmux version string

Ещё один скрытый риск - слишком доверять `tmux -V`.

Почему:
- package-manager версии на enterprise / LTS системах могут быть сильно старыми
- но для нас важен не номер сам по себе, а наличие конкретных runtime capabilities

Практический rule:
- installer status может показывать `tmux -V`
- но runtime readiness должен опираться на capability probes:
  - isolated socket create
  - `has-session`
  - `display-message -p`
  - `set-environment -g`
  - если Windows follow-up использует это - `new-session -e`

Иными словами:
- `tmux` version string полезен для diagnostics
- capability contract важнее, чем числовой version gate, если мы заранее не зафиксировали минимальную supported версию

## 10.3 No fake silent fallback

Нельзя:
- проглотить ошибку `brew not found`
- переключиться на другой strategy без явного detail
- показать completed, если verification failed

## 10.4 Structured error taxonomy

Нужен нормализатор ошибок:

```ts
type TmuxInstallErrorCode =
  | 'ALREADY_INSTALLED'
  | 'PACKAGE_MANAGER_NOT_FOUND'
  | 'UNSUPPORTED_PLATFORM'
  | 'AUTH_CANCELLED'
  | 'PERMISSION_DENIED'
  | 'PTY_UNAVAILABLE'
  | 'NETWORK_ERROR'
  | 'PACKAGE_LOCKED'
  | 'PACKAGE_NOT_FOUND'
  | 'RESTART_REQUIRED'
  | 'WSL_NOT_INSTALLED'
  | 'WSL_COMMAND_UNSUPPORTED'
  | 'WSL_DISTRO_MISSING'
  | 'WSL_DISTRO_NOT_READY'
  | 'EXTERNAL_ELEVATION_CANCELLED'
  | 'EXTERNAL_ELEVATION_FAILED'
  | 'VERIFY_FAILED'
  | 'USER_CANCELLED'
  | 'UNKNOWN';
```

И map в user-friendly messages.

Важное правило для нормализатора:
- не полагаться только на exact English stderr text
- где возможно, использовать:
  - exit code
  - observable state вроде lock files / missing binary / missing distro
  - несколько broad regex patterns вместо одного exact message

Иначе:
- локализованные Linux/Windows системы будут часто падать в `UNKNOWN`
- а UI станет выглядеть "случайно нестабильным", хотя root cause классифицируемый

## 10.5 Retry semantics

- `Retry` должен re-run plan resolution с нуля
- перед retry:
  - kill active child/pty
  - invalidate status cache
  - clear stale progress state

## 10.5.1 Cache semantics during and after install

Кэш статуса здесь легко превратить в источник ложных UI состояний.

Правила:
- пока install active, negative cache entries нельзя считать authoritative
- после любого install step, который потенциально меняет system state, нужен explicit invalidate
- после Windows external elevated step нужен mandatory fresh probe, даже если helper сообщил success
- после app restart UI должен восстанавливаться не из in-memory installer state, а из свежего system probe

Итог:
- installer flow должен быть idempotent
- partial install / app restart / crashed renderer не должны оставлять "залипшее installing" состояние

## 10.5.2 Recovery after app restart or renderer crash

Особенно важно для Windows external elevated steps.

Правила:
- in-memory progress state не считается durable truth
- после app relaunch service сначала смотрит на system state, а не пытается "доигрывать" старый progress bar
- если остались temp marker/result files от elevated step:
  - их можно использовать только как diagnostics hint
  - final UI state всё равно решает fresh probe
- старые marker/result dirs нужно периодически cleanup'ить по age, чтобы не копить мусор и не читать stale outcome как новый

## 10.6 Cancellation semantics

Нужен `cancelInstall()`:
- убивает child/pty
- шлёт `cancelled`
- не оставляет broken installing flag

Но для Windows external elevated step это работает иначе:
- после `Start-Process -Verb RunAs` приложение уже не контролирует тот процесс так же, как обычный child
- значит `Cancel` в этом состоянии это скорее `stop waiting locally`, а не гарантированное terminate внешнего admin window

Надёжный UX contract:
- если step ещё не ушёл во внешний elevated flow, `Cancel` действительно отменяет install locally
- если step уже ушёл во внешний elevated flow:
  - app переводит себя в cancelled/abandoned waiting state
  - явно пишет, что external administrator window may still be open
  - после этого truth source всё равно fresh probe, а не предположение "мы точно всё остановили"

## 10.7 Diagnostics

Добавить diagnostic log рядом по стилю с `CliInstallerService`:
- detected platform
- chosen strategy
- PATH used
- package manager path
- raw exit code
- stderr tail
- verify result

### 10.8 Raw log hygiene

Нельзя бесконтрольно складывать весь terminal output в renderer/store.

Нужно:
- ring buffer по строкам или байтам
- upper bound на память
- redaction rules для очевидно чувствительных фрагментов
- не persist raw install terminal logs на диск по умолчанию
- не логировать пользовательский input в PTY вообще
- пароль/keystrokes пользователя не должны попадать ни в raw chunks, ни в diagnostics

Минимум:

```ts
const MAX_RAW_CHUNKS = 400;
const MAX_RAW_BYTES = 256 * 1024;
```

## 11. Детальный implementation plan

## Phase 1. Feature contracts and registration

Файлы:
- `src/features/tmux-installer/contracts/api.ts`
- `src/features/tmux-installer/contracts/channels.ts`
- `src/features/tmux-installer/contracts/dto.ts`
- `src/features/tmux-installer/contracts/index.ts`
- `src/features/tmux-installer/main/index.ts`
- `src/features/tmux-installer/preload/createTmuxInstallerBridge.ts`
- `src/features/tmux-installer/preload/index.ts`
- `src/renderer/api/httpClient.ts`
- host registration points:
  - `src/preload/index.ts`
  - app shell main bootstrap

Что делаем:
- расширяем типы
- добавляем install/invalidate/cancel/progress API
- browser-mode stubs возвращают safe no-op behavior

## Phase 2. Main-process status refactor

Файлы:
- `src/features/tmux-installer/main/index.ts`
- `src/features/tmux-installer/main/composition/createTmuxInstallerFeature.ts`
- `src/features/tmux-installer/main/adapters/input/ipc/registerTmuxInstallerIpc.ts`
- `src/features/tmux-installer/main/adapters/output/sources/TmuxStatusSourceAdapter.ts`
- `src/features/tmux-installer/core/application/use-cases/GetTmuxStatusUseCase.ts`
- host registration point:
  - app shell main bootstrap, который импортирует только `@features/tmux-installer/main`
  - если `src/main/ipc/tmux.ts` сохраняется ради совместимости, то только как thin registration shim

Что делаем:
- выносим status computation из голого IPC handler в feature use case + adapter chain
- status probe должен использовать enriched PATH / interactive shell env, а не только process PATH
- для macOS дополнительно проверять common brew prefixes, иначе получим false negative после успешного install
- feature facade умеет:
  - `getStatus()`
  - `install()`
  - `cancelInstall()`
  - `invalidateStatus()`
  - `setMainWindow()`

## Phase 2.2 WSL preference persistence

Новый модуль:
- `src/features/tmux-installer/main/infrastructure/wsl/TmuxWslPreferenceStore.ts`

Что делаем:
- сохраняем `preferred distro` после явного Windows wizard choice или после первого успешного install/verify
- status service сначала пробует persisted distro
- если persisted distro больше не существует, store self-heals:
  - mark stale
  - clear preference
  - вернуть UI в `re-select distro` / `manual guidance`

## Phase 2.1 PTY plumbing refactor

Файлы:
- `src/main/services/infrastructure/PtyTerminalService.ts`
- feature-local wrapper `src/features/tmux-installer/main/infrastructure/installer/TmuxInstallTerminalSession.ts`
- возможно новый attach-style renderer component вместо прямого reuse `TerminalModal`

Что делаем:
- добавляем main-side control surface для PTY session
- installer service должен получать:
  - raw chunks
  - exit code
  - ability to write input
  - explicit dispose lifecycle
- renderer не должен быть владельцем installer process
- если attach UI делаем позже, installer всё равно остаётся source of truth

## Phase 3. Strategy resolver

Новый модуль:
- `src/features/tmux-installer/main/infrastructure/installer/TmuxInstallStrategyResolver.ts`

Псевдокод:

```ts
export async function resolveTmuxInstallPlan(): Promise<TmuxInstallPlan> {
  if (process.platform === 'darwin') return resolveMacPlan();
  if (process.platform === 'linux') return resolveLinuxPlan();
  if (process.platform === 'win32') return resolveWindowsPlan();
  return manualOnlyPlan('Unsupported platform');
}
```

Важно:
- resolver должен учитывать не только OS/package manager, но и локальные capability flags
- пример: если путь требует interactive `sudo`, а PTY capability недоступен, auto-install надо честно выключать и переводить пользователя в manual guidance

## Phase 4. macOS install runner

- detect `brew`
- else detect `port`
- else manual

Нерискованный rule:
- не auto-install Homebrew
- не auto-run remote shell scripts

## Phase 5. Linux install runner

- parse `/etc/os-release`
- choose command
- run command in PTY
- stream raw logs
- verify
- if immutable host detected -> short-circuit to manual fallback
- if retry with `update` is needed, prefer doing it in the same PTY session

## Phase 6. Renderer slice inside feature

Новые файлы:
- `src/features/tmux-installer/renderer/adapters/TmuxInstallerBannerAdapter.ts`
- `src/features/tmux-installer/renderer/hooks/useTmuxInstallerBanner.ts`
- `src/features/tmux-installer/renderer/ui/TmuxInstallerBannerView.tsx`
- `src/features/tmux-installer/renderer/utils/formatTmuxInstallerText.ts`
- `src/features/tmux-installer/renderer/index.ts`

Не делать primary architecture через новый global slice, пока это не стало реально нужно нескольким независимым surface'ам.

Лучше так:
- installer state canonical в main process
- renderer slice читает snapshot + подписывается на progress events
- local React state внутри feature hook достаточно для v1
- если позже появится второй surface с тем же state, можно отдельно решить, нужен ли shared renderer cache

Feature hook return shape:

```ts
{
  viewModel: TmuxInstallerBannerViewModel;
  actions: {
    install: () => Promise<void>;
    cancel: () => Promise<void>;
    refresh: () => Promise<void>;
    toggleDetails: () => void;
  };
}
```

Hook boundary rules:
- hook не должен импортировать `api` напрямую
- hook не должен знать про IPC channel names
- hook не должен нормализовать platform-specific ошибки
- это ответственность renderer adapter и main-side use case/presenter layers

## Phase 7. Banner UX

Создать feature view:
- `src/features/tmux-installer/renderer/ui/TmuxInstallerBannerView.tsx`

И оставить `src/renderer/components/dashboard/TmuxStatusBanner.tsx` как thin wrapper:

```tsx
import { TmuxInstallerBannerView } from '@features/tmux-installer/renderer';

export function TmuxStatusBanner(): JSX.Element {
  return <TmuxInstallerBannerView />;
}
```

Внутри feature view:

- `Install tmux` button
- status line
- progress bar
- `Show details` / `Hide details`
- error block
- manual fallback buttons

UI logic:
- если `autoInstall.supported === false`, не показывать install CTA
- если `needs_manual_step`, показывать step-specific CTA
- если `needs_restart`, показывать restart CTA
- если live installer session уже идёт, feature должен подхватить её через snapshot и не сбрасывать UI в `idle`

## Phase 7.1 Feature integration points checklist

Чтобы реализация реально соответствовала guide, в PR и в финальной implementation notes надо перечислить изменённые host integration points.

Ожидаемые integration points для этой задачи:
- `src/features/tmux-installer/contracts/*`
- `src/features/tmux-installer/core/*`
- `src/features/tmux-installer/main/*`
- `src/features/tmux-installer/preload/*`
- `src/features/tmux-installer/renderer/*`
- app shell registration points for main/preload/renderer
- `src/renderer/components/dashboard/TmuxStatusBanner.tsx`

Если появятся дополнительные host touchpoints, это должно быть явно объяснено, а не "само выросло".

## Phase 7.2 Definition of done по feature standard

Перед merge реализация считается готовой только если:
- feature живёт в `src/features/tmux-installer/`
- структура соответствует canonical template из `docs/FEATURE_ARCHITECTURE_STANDARD.md`
- `contracts`, `core`, `main`, `preload`, `renderer` заполнены осмысленно
- `core/domain` side-effect free
- `core/application` покрывает use case orchestration
- public imports идут только через feature entrypoints
- shared shell files не содержат business logic, только registration shims
- renderer business logic не осталась в `TmuxStatusBanner.tsx`
- есть как минимум:
  - domain policy tests
  - application use case tests
  - critical renderer utility tests
  - one adapter-level mapping test
- `pnpm typecheck` проходит
- `pnpm build` проходит
- import/lint guard rails не позволяют deep-import feature internals снаружи
- integration points перечислены в PR notes

## Phase 8. Windows WSL wizard

Сделать это отдельным sub-flow внутри feature use case + infrastructure path, а не if/else spaghetti inside banner.

Новый helper:
- `src/features/tmux-installer/main/infrastructure/wsl/TmuxWslService.ts`

Методы:

```ts
interface TmuxWslService {
  getStatus(): Promise<TmuxWslStatus>;
  installWsl(): Promise<TmuxWslStepResult>;
  ensureDistro(): Promise<TmuxWslStepResult>;
  ensureBootstrapReady(): Promise<TmuxWslStepResult>;
  installTmuxInsideDistro(): Promise<TmuxWslStepResult>;
  verifyTmux(): Promise<TmuxWslStepResult>;
}
```

Важно:
- `installWsl()` должен поддерживать сценарий `external elevated step`
- его контракт не должен предполагать "я всегда верну полный live log"
- success этого шага всегда подтверждается только последующим fresh probe

## Phase 8.1 Windows elevated runner

Новый модуль:
- `src/features/tmux-installer/main/infrastructure/wsl/WindowsElevatedStepRunner.ts`

Ответственность:
- создавать temp working dir для elevated step
- писать helper script / args
- запускать PowerShell `Start-Process -Verb RunAs -Wait`
- читать result JSON / stderr tail file если helper успел их записать
- нормализовать outcome в:
  - `elevated_succeeded`
  - `elevated_cancelled`
  - `elevated_failed`
  - `elevated_unknown_outcome`

Ключевое правило:
- даже `elevated_succeeded` не завершает installer flow само по себе
- после него всегда идёт fresh probe реального system state

## Phase 9. Windows runtime follow-up

Это можно вынести в отдельную PR/итерацию, но в этом документе оно считается обязательным follow-up.

Файлы:
- `src/main/services/team/runtimeTeammateMode.ts`
- `src/main/ipc/tmux.ts`
- `src/main/services/team/TeamProvisioningService.ts`
- `src/features/tmux-installer/main/infrastructure/wsl/TmuxWslPathBridge.ts`

Нужно:
- сделать WSL-aware tmux detection
- перестать hard-disable tmux path на Windows, если WSL tmux реально доступен
- добавить отдельный adapter для `tmux` команд через `wsl -e`
- добавить path bridge для `cwd` и project-related paths
- заложить `WSL_INTEROP` pinning strategy при создании isolated tmux server
- ввести explicit policy для supported `claude` binary shape внутри WSL runtime

## 12. Пример скелета feature facade

```ts
export class TmuxInstallerFeatureFacade {
  #mainWindow: BrowserWindow | null = null;
  #installing = false;
  #activeChild: ChildProcess | null = null;
  #activePty: TmuxInstallTerminalSession | null = null;
  #cachedStatus: { value: TmuxStatus; at: number } | null = null;

  setMainWindow(window: BrowserWindow | null): void {
    this.#mainWindow = window;
  }

  async getStatus(): Promise<TmuxStatus> {
    // 1. detect host tmux
    // 2. detect install capability
    // 3. on Windows also detect WSL readiness
    // 4. return unified snapshot
  }

  async install(): Promise<void> {
    if (this.installing) {
      this.sendProgress({ type: 'error', error: 'tmux installation is already in progress' });
      return;
    }

    this.installing = true;
    try {
      this.sendProgress({ type: 'checking', detail: 'Detecting installation strategy...' });
      const plan = await resolveTmuxInstallPlan();

      if (!plan.autoInstallSupported) {
        this.sendProgress({
          type: 'error',
          error: plan.reasonIfUnsupported ?? 'Automatic install is not available on this machine',
          nextManualHint: plan.manualHints[0] ?? null,
        });
        return;
      }

      await this.executePlan(plan);

      this.sendProgress({ type: 'verifying', detail: 'Verifying tmux...' });
      const status = await this.invalidateAndGetFreshStatus();
      if (!status.effective.available) {
        throw new Error('tmux installation finished but verification failed');
      }

      if (!status.effective.runtimeReady) {
        this.sendProgress({
          type: 'needs_manual_step',
          detail: 'tmux is installed, but runtime integration is not ready yet on this machine',
          status,
        });
        return;
      }

      this.sendProgress({
        type: 'completed',
        detail: `Installed ${status.effective.version ?? 'tmux'} via ${status.effective.location ?? 'unknown path'}`,
        status,
      });
    } catch (error) {
      this.sendProgress({
        type: 'error',
        error: normalizeTmuxInstallError(error).userMessage,
      });
    } finally {
      this.installing = false;
      this.activeChild = null;
      this.activePty = null;
    }
  }

  async cancelInstall(): Promise<void> {
    killProcessTree(this.activeChild);
    this.activePty?.dispose();
    this.sendProgress({ type: 'cancelled', detail: 'Installation cancelled' });
  }

  private sendProgress(progress: TmuxInstallerProgress): void {
    safeSendToRenderer(this.mainWindow, TMUX_INSTALLER_PROGRESS, progress);
  }
}
```

## 12.2 Пример runtime readiness rule для Windows follow-up

```ts
function isWindowsWslRuntimeReady(ctx: {
  tmuxSmokeOk: boolean;
  wslInteropPinned: boolean;
  targetDistroExists: boolean;
  translatedCwdExists: boolean;
  claudeBinaryPath: string | null;
  configRootSanityOk: boolean;
}): boolean {
  if (!ctx.tmuxSmokeOk) return false;
  if (!ctx.wslInteropPinned) return false;
  if (!ctx.targetDistroExists) return false;
  if (!ctx.translatedCwdExists) return false;
  if (!ctx.claudeBinaryPath) return false;
  if (!ctx.configRootSanityOk) return false;

  const lower = ctx.claudeBinaryPath.toLowerCase();
  return lower.endsWith('.exe');
}
```

Это intentionally conservative rule.

Смысл:
- лучше временно недовключить Windows WSL runtime, чем считать runtime-ready сценарий с `.cmd` wrapper или broken path translation

## 12.1 Пример Windows elevated step runner

```ts
interface WindowsElevatedStepResult {
  outcome: 'elevated_succeeded' | 'elevated_cancelled' | 'elevated_failed' | 'elevated_unknown_outcome';
  detail?: string | null;
  resultFilePath?: string | null;
}

export class WindowsElevatedStepRunner {
  async runWslInstall(args: string[]): Promise<WindowsElevatedStepResult> {
    const tempDir = await fsp.mkdtemp(join(tmpdir(), 'tmux-wsl-install-'));
    const resultFile = join(tempDir, 'result.json');
    const helperScript = join(tempDir, 'run-wsl-install.ps1');

    await fsp.writeFile(
      helperScript,
      buildWslInstallScript({
        wslArgs: args,
        resultFile,
      }),
      'utf8'
    );

    const ps = await execFileNoThrow('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"${escapePowerShell(helperScript)}\"'`,
    ]);

    // Do not trust only PowerShell exit code. UAC cancellation and helper failures
    // are better inferred from the result file plus a fresh WSL probe.
    if (await fileExists(resultFile)) {
      const payload = JSON.parse(await fsp.readFile(resultFile, 'utf8')) as {
        ok?: boolean;
        detail?: string;
      };
      return {
        outcome: payload.ok ? 'elevated_succeeded' : 'elevated_failed',
        detail: payload.detail ?? null,
        resultFilePath: resultFile,
      };
    }

    if (looksLikeElevationCancelled(ps.stderr, ps.stdout, ps.code)) {
      return {
        outcome: 'elevated_cancelled',
        detail: 'Administrator permission request was cancelled',
        resultFilePath: null,
      };
    }

    return {
      outcome: 'elevated_unknown_outcome',
      detail: ps.stderr || ps.stdout || null,
      resultFilePath: null,
    };
  }
}
```

Это не production-ready код, а reference shape.

Главная идея здесь важнее синтаксиса:
- elevated Windows step отделён от PTY/Linux install logic
- результат helper script это только дополнительная диагностика
- truth source всё равно fresh `wsl --status` / `wsl --list` probe после шага

## 13. Пример Linux resolver

```ts
export async function resolveLinuxPackageManager(): Promise<TmuxInstallStrategy> {
  const osRelease = await readOsRelease();

  if (isDistroFamily(osRelease, ['debian'])) return 'apt';
  if (isDistroFamily(osRelease, ['fedora', 'rhel'])) return (await hasBinary('dnf')) ? 'dnf' : 'yum';
  if (isDistroFamily(osRelease, ['suse', 'opensuse'])) return 'zypper';
  if (isDistroFamily(osRelease, ['arch'])) return 'pacman';

  if (await hasBinary('apt-get')) return 'apt';
  if (await hasBinary('dnf')) return 'dnf';
  if (await hasBinary('yum')) return 'yum';
  if (await hasBinary('zypper')) return 'zypper';
  if (await hasBinary('pacman')) return 'pacman';

  return 'unknown';
}
```

## 14. Пример Windows WSL status probe

```ts
async function getWslStatus(): Promise<TmuxWslStatus> {
  const wslStatus = await execWslNoThrow(['--status']);
  if (wslStatus.code !== 0) {
    return {
      wslInstalled: false,
      rebootRequired: false,
      distroName: null,
      distroVersion: null,
      distroBootstrapped: false,
      innerPackageManager: null,
      tmuxAvailableInsideWsl: false,
      tmuxVersion: null,
      statusDetail: wslStatus.stderr || wslStatus.stdout || 'WSL not available',
    };
  }

  const preferredDistro = await wslPreferenceStore.getPreferredDistro();
  const list = await execWslNoThrow(['--list', '--verbose']);
  const distro = resolveTargetDistro({
    preferredDistro,
    listOutput: list.stdout,
  });
  const distroVersion = parseDefaultDistroVersion(list.stdout);
  if (!distro) {
    return {
      wslInstalled: true,
      rebootRequired: false,
      distroName: null,
      distroVersion: null,
      distroBootstrapped: false,
      innerPackageManager: null,
      tmuxAvailableInsideWsl: false,
      tmuxVersion: null,
      statusDetail: 'WSL installed but no Linux distribution is configured',
    };
  }

  const bootstrapProbe = await execWslNoThrow([
    '--distribution',
    distro,
    '--',
    'sh',
    '-lc',
    'printf ready',
  ]);

  if (bootstrapProbe.code !== 0 || !bootstrapProbe.stdout.includes('ready')) {
    return {
      wslInstalled: true,
      rebootRequired: false,
      distroName: distro,
      distroVersion,
      distroBootstrapped: false,
      innerPackageManager: null,
      tmuxAvailableInsideWsl: false,
      tmuxVersion: null,
      statusDetail:
        bootstrapProbe.stderr || bootstrapProbe.stdout || 'Linux distro bootstrap is not finished',
    };
  }

  const tmuxProbe = await execWslNoThrow([
    '--distribution',
    distro,
    '--',
    'tmux',
    '-V',
  ]);
  return {
    wslInstalled: true,
    rebootRequired: false,
    distroName: distro,
    distroVersion,
    distroBootstrapped: true,
    innerPackageManager: null,
    tmuxAvailableInsideWsl: tmuxProbe.code === 0,
    tmuxVersion: tmuxProbe.code === 0 ? extractTmuxVersion(tmuxProbe.stdout || tmuxProbe.stderr) : null,
    statusDetail: tmuxProbe.code === 0 ? null : tmuxProbe.stderr || tmuxProbe.stdout || null,
  };
}
```

Где `execWslNoThrow()`:
- сам выбирает подходящий `wsl.exe` candidate
- запускает с `encoding: buffer`
- затем декодирует stdout/stderr defensively, потому что `wsl.exe` output на Windows не всегда стабильно UTF-8

А `resolveTargetDistro()`:
- сначала пробует persisted preference
- если её нет или она stale, использует default distro / selected distro heuristic
- не должен silently switch runtime target, если preference сломалась и это меняет expected behavior пользователя

А `parseDefaultDistroVersion()`:
- должен считаться best-effort helper только для diagnostics
- если parser не уверен, лучше вернуть `null`, чем принять неправильное runtime decision

## 15. Error UX copy guidelines

Плохой текст:
- `ENOENT`
- `spawn failed`
- `exit code 1`

Хороший текст:
- `Homebrew was not found. Install Homebrew first or use the manual instructions below.`
- `The package manager asked for administrator privileges and the request was cancelled.`
- `Interactive installation is not available because terminal support is missing in this app build. Use the manual command below.`
- `WSL was installed, but Windows restart is still required before tmux can be set up.`
- `This Windows version does not support the automatic WSL setup flow used by the app. Follow the Microsoft manual steps below.`
- `WSL is available, but no Linux distribution is installed yet. Install Ubuntu first, then continue.`
- `<SelectedDistro> is installed in WSL, but its first-launch setup is not finished yet. Open it once, finish Linux user setup, then re-check.`
- `WSL setup needs an administrator step in a separate window. Complete that step, then come back and press Re-check.`

## 16. Тест-план

### Unit tests

- status resolver for every platform
- package manager resolver
- error normalizer
- WSL output parsers
- WSL executable candidate resolver + UTF-16/mixed output decoding
- progress phase mapping
- WSL preferred-distro resolver
- elevated-step restart recovery logic
- locale-robust default-distro resolution
- supported Windows `claude` binary-shape policy
- locale-robust package-manager error classification
- config/auth-root sanity probe for Windows `claude.exe` from WSL
- tmux capability probes vs plain version string

### Integration tests with mocks

- install success on brew
- brew missing -> manual fallback
- apt sudo password prompt path
- package manager lock errors
- verification failure after install
- PTY capability missing -> no interactive auto-install path
- Windows:
  - WSL missing
  - WSL install goes through external elevated step and requires re-check
  - external elevated step returns no result file -> unknown outcome -> fresh probe decides
  - WSL install requires restart
  - `wsl --status` unsupported on older build -> manual guidance
  - distro missing
  - distro bootstrap pending
  - unsupported default distro -> manual or install-supported-distro guidance
  - tmux install inside WSL success
  - runtime smoke test passes only when same adapter path is used
  - persisted preferred distro disappears -> self-heal without misleading "installed" state
  - app restart during external elevated step -> self-heal from fresh probe, not stale in-memory state
  - direct `wsl -e tmux ...` path works for tmux format strings with `#`
  - host Windows resolver returns `.cmd` only -> runtime stays conservative, no false ready
  - host `claude.exe` launches from WSL but config/auth root behaves unexpectedly -> runtime stays not ready
  - `tmux -V` succeeds but required runtime capability probe fails -> no false ready

### Manual matrix

- macOS Apple Silicon + Homebrew
- macOS Intel + Homebrew
- macOS + MacPorts only
- Ubuntu
- Fedora
- Arch
- openSUSE
- Fedora Silverblue / similar immutable host -> manual fallback only
- Windows 11 clean machine without WSL
- Windows 11 with WSL but no distro bootstrap
- Windows 11 with ready supported distro
- Windows 11 with WSL 1 distro where tmux still works
- Windows 10 older build -> manual Microsoft guidance only
- Windows runtime with project on `C:\\...` path -> WSL path translation works
- Windows runtime with project on `\\\\wsl.localhost\\<distro>\\...` path -> distro match handling works
- Windows with multiple distros and changed default distro -> persisted target stays stable
- Windows runtime on `/mnt/c/...` project -> works but surfaces performance diagnostic

## 16.1 Остаточные uncertainty points после самого жёсткого IOF

Они уже не блокируют план, но их лучше закрыть маленькими spikes до полной реализации.

1. Windows elevated helper UX
   - 🎯 8   🛡️ 8   🧠 5
   - `100-200` строк spike
   - Нужно проверить на реальной машине, как стабильно работает `Start-Process -Verb RunAs -Wait` + temp result file и какие коды/сообщения приходят при UAC cancel.

2. WSL distro install path under corporate restrictions
   - 🎯 7   🛡️ 7   🧠 4
   - `50-120` строк spike
   - Нужно подтвердить, когда `wsl --install -d ...` реально помогает, а когда сразу надо переводить пользователя в manual Microsoft docs.

3. PTY attach model для installer UI
   - 🎯 8   🛡️ 9   🧠 6
   - `150-300` строк spike
   - Нужно быстро выбрать: расширяем существующий `PtyTerminalService` или делаем небольшой отдельный installer-session adapter.

4. WSL runtime path bridge + interop pinning
   - 🎯 7   🛡️ 9   🧠 7
   - `150-350` строк spike
   - Нужно проверить на реальном Windows path mix: `C:\\...`, `\\\\wsl.localhost\\...`, spaces, different distro names, и подтвердить поведение `WSL_INTEROP=/run/WSL/1_interop` для долгоживущего tmux server.

5. Preferred distro persistence semantics
   - 🎯 8   🛡️ 8   🧠 5
   - `80-180` строк spike
   - Нужно подтвердить, где и как лучше хранить `preferred WSL distro`, чтобы не получить ложные переключения при смене default distro и при этом не создать лишнюю сложность миграции настроек.

6. Windows `claude` binary model through WSL interop
   - 🎯 7   🛡️ 8   🧠 6
   - `120-260` строк spike
   - Нужно подтвердить на реальной машине: `claude.exe` path, `.cmd` fallback behavior, quoting, cleanup и минимальный smoke test именно через тот binary shape, который потом пойдёт в teammate runtime.

7. Config/auth root sanity for `claude.exe` launched from WSL
   - 🎯 6   🛡️ 8   🧠 6
   - `100-220` строк spike
   - Нужно проверить, какой effective config/auth/session root реально использует host `claude.exe`, запущенный из WSL tmux pane, и не появляется ли drift между Windows root и WSL working directory.

## 17. Rollout strategy

### PR 1

- shared types
- main service skeleton
- macOS/Linux installer
- banner UI
- manual fallback UX

### PR 2

- Windows WSL wizard
- richer status snapshot for WSL

### PR 3

- Windows runtime enablement through WSL tmux

Это лучше, чем пытаться протащить всё одним PR.

## 18. Самый важный список "не наступить"

- не делать Windows wizard без честного copy, если runtime ещё не использует WSL tmux
- не auto-install Homebrew в фоне
- не считать install успешным без `tmux -V`
- не считать `tmux:getStatus().effective.available === true` синонимом "host tmux есть"
- не смешивать service-owned installer PTY с renderer-owned terminal modal
- не использовать fake 0-100 network progress для package managers
- не терять stderr/stdout
- не запускать `sudo` через non-TTY child
- не делать default hidden root install внутри WSL
- не пытаться auto-manage immutable Linux hosts как обычный `dnf/apt` Linux
- не хардкодить PATH без shell env merge
- не запускать Windows WSL runtime без path translation layer
- не поднимать Windows tmux server в WSL без явного `WSL_INTEROP` pinning strategy
- не привязывать Windows runtime только к current default distro
- не молча менять целевой WSL distro после успешной установки tmux
- не считать `.cmd`/`.bat` эквивалентом `.exe` для Windows WSL runtime без отдельной валидации
- не считать успешный старт `claude.exe` из WSL достаточным доказательством корректного config/auth root
- не прятать manual fallback, если auto-install unavailable
- не делать installer logic inside React component

## 19. Мой итоговый recommendation

Делать именно так:

1. Сначала качественный `tmux-installer` feature slice для `macOS/Linux`
2. Сразу же заложить правильный shared contract под Windows WSL
3. На Windows не останавливаться на "installer wizard only"
4. Обязательно follow-up на WSL-aware runtime support, иначе ценность Windows-части будет неполной

Если делать по этому плану, получится действительно качественно:
- удобно
- понятно
- с нормальной диагностикой
- без дешёвых UX-обманок
- с честным fallback для ручной установки
