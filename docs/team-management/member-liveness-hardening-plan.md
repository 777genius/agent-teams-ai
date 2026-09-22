# Member Liveness Hardening Plan

## Коротко

Нужно исправить кейс, где launch UI висит на `Members joining`, участники выглядят как `starting`, а runtime memory показывает около `2 MB`. По текущему коду это почти наверняка значит, что UI видит tmux pane/shell PID, а не реальный teammate runtime.

Главное изменение: разделить "что-то зарегистрировано", "pane/shell жив", "процесс runtime реально найден" и "member сделал bootstrap/check-in". Сейчас эти сигналы частично смешаны через `runtimeAlive`.

Рекомендуемый путь: **UI + строгая liveness-модель**.
🎯 9/10 🛡️ 9/10 🧠 7/10 Примерно 650-950 строк production-кода + 350-550 строк тестов.

## Почему не UI-only

Топ 3 вариантов:

1. UI-only diagnostics
   🎯 7 🛡️ 4 🧠 3 Примерно 180-260 строк.
   Покажет, что происходит, но backend все равно сможет считать shell живым runtime. Зависание станет понятнее, но не надежнее.

2. UI + строгая liveness-модель
   🎯 9 🛡️ 9 🧠 7 Примерно 650-950 строк.
   Исправляет причину: weak evidence больше не маскирует timeout, UI получает понятные причины, self-heal остается только для надежных сигналов.

3. Полный lease/heartbeat runtime manager
   🎯 8 🛡️ 10 🧠 9 Примерно 1200-1800 строк.
   Самый надежный вариант, но слишком большой для первого фикса. Его лучше делать после варианта 2, когда станут видны реальные runtime-команды и частота edge cases.

## Что проверено в коде

Факты, которые важны для плана:

- `mcp-server/src/tools/runtimeTools.ts` уже содержит `runtime_bootstrap_checkin` и `runtime_heartbeat`. Это сильный сигнал, его надо сделать главным источником подтверждения.
- `agent-teams-controller/src/internal/runtime.js` уже прокидывает `runtimeBootstrapCheckin()` в desktop runtime.
- `src/main/services/team/TeamBootstrapStateReader.ts` уже читает `bootstrap-state.json`, `bootstrap-journal.jsonl` и классифицирует stuck bootstrap. Там уже есть важные тайминги: `ACTIVE_BOOTSTRAP_STUCK_CLASSIFICATION_MS = 3 min` и `TERMINAL_BOOTSTRAP_ONLY_PENDING_GRACE_MS = 5 min`.
- `TeamProvisioningService.getLiveTeamAgentRuntimeMetadata()` собирает evidence из config/meta/persisted runtime/tmux/process table и прогоняет его через strict resolver.
- Для tmux раньше читался только `#{pane_id}\t#{pane_pid}` через `listTmuxPanePidsForCurrentPlatform()`. `pane_pid` часто является shell (`zsh`, `bash`, `sh`), поэтому `2 MB` выглядело логично.
- `attachLiveRuntimeMetadataToStatuses()` теперь повышает member до `runtimeAlive: true` только через strong evidence: `confirmed_bootstrap` или `runtime_process`.
- `reevaluateMemberLaunchStatus()` больше не доверяет старому `runtimeAlive === true` без live metadata.
- `OpenCodeTeamRuntimeAdapter.mapBridgeMemberToRuntimeEvidence()` теперь не выставляет `runtimeAlive: true` для bridge-only `created` или `permission_blocked`. Такие сигналы остаются candidate/pending до bootstrap или OS verification.
- `recordOpenCodeRuntimeBootstrapCheckin()` и `recordOpenCodeRuntimeHeartbeat()` уже пишут `confirmed_alive`, `runtimeAlive: true`, `bootstrapConfirmed: true`, `nativeHeartbeat: true` через `updateOpenCodeRuntimeMemberLiveness()`. Значит confirmed state уже есть, надо не дать слабым сигналам выглядеть как он.
- `OpenCodeLaunchTransactionStore.canMarkOpenCodeRunReady()` уже требует `member_session_recorded`, `required_tools_proven` и `bootstrap_confirmed`. Это strict readiness precedent, который надо сохранить.
- Renderer уже получает оба источника: `memberSpawnStatuses` и `teamAgentRuntimeByTeam`. Но `MemberCard` сейчас получает только `runtimeSummary` строкой, а не сам `TeamAgentRuntimeEntry`.
- `teamSlice.areTeamAgentRuntimeEntriesEqual()` должен сравнивать `livenessKind`, `pidSource` и diagnostic fields, иначе UI может не перерендериться при смене strict evidence.
- `teamSlice.areMemberSpawnStatusEntriesEqual()` должен сравнивать visible liveness fields (`livenessKind/runtimeDiagnostic`) и продолжать игнорировать timing-only fields.
- `areLaunchSummaryCountsEqual()` должен сравнивать aggregate diagnostic counts (`shellOnlyPendingCount`, `runtimeProcessPendingCount`, `runtimeCandidatePendingCount`, `noRuntimePendingCount`, `permissionPendingCount`). UI не должен использовать legacy `runtimeAlivePendingCount` как process evidence.
- `TeamAgentRuntimeWatcher` обновляет runtime snapshot раз в 5 секунд, а spawn statuses раз в 2.5 секунды. Диагностические поля должны попадать либо в оба snapshot слоя, либо UX должен быть устойчив к задержке runtime snapshot.
- Renderer `member-spawn` event сейчас вызывает refresh spawn statuses, но не runtime snapshot. Если tooltip/detail зависят от `TeamAgentRuntimeSnapshot`, event handler тоже должен запланировать runtime refresh.
- Runtime tools принимают `metadata`, но `recordOpenCodeRuntimeBootstrapCheckin()` и `recordOpenCodeRuntimeHeartbeat()` сейчас используют только `diagnostics`. Если runtime присылает PID/version/command в `metadata`, эта информация теряется.
- `handleMemberSpawnToolResult()` раньше при reason `already_running` делал `setMemberSpawnStatus(..., "online", ..., "process")`. В strict model это заменено на `waiting` + runtime re-evaluation.
- `waitForTmuxPanesToExit()` использует `listTmuxPanePidsForCurrentPlatform()` только как "pane exists" check. Поэтому старый `listPanePids()` wrapper должен остаться ровно pane-existence helper, а не получить новую liveness-семантику.
- Для member liveness strict model включена по умолчанию без отдельного env-флага.
- `src/shared/types/api.ts`, `src/preload/index.ts` и `src/renderer/api/httpClient.ts` уже прокидывают `getMemberSpawnStatuses()` и `getTeamAgentRuntime()` через shared snapshot types. Новый контракт можно добавить optional fields без нового IPC channel, но browser HTTP fallback должен возвращать валидный старый shape.
- `TeamProvisioningService.readUnixProcessTableRows()` сейчас приватный, sync и читает только `pid,command`. Для надежного liveness нужен `ppid`, WSL-aware execution и unit-test seam. Это не должно оставаться приватным ad hoc helper внутри огромного service.
- `getLiveTeamAgentRuntimeMetadata()` сейчас читает tmux panes и process table внутри одного метода. После strict model там станет слишком много правил, поэтому план должен вынести pure resolution в отдельный helper/module.

## Главная проблема

Текущий `runtimeAlive` слишком широкий:

```text
tmux pane exists
-> pane_pid is zsh/bash with low RSS
-> metadata.alive = true
-> MemberSpawnStatusEntry.runtimeAlive = true
-> grace timeout does not fail
-> UI shows starting/joining for minutes
```

Нужно прекратить использовать один boolean для разных уровней доверия.

## Целевой контракт

### Evidence ladder

Сигналы должны оцениваться сверху вниз:

1. `confirmed_bootstrap`
   Member сделал `member_briefing`, `runtime_bootstrap_checkin`, `runtime_heartbeat`, meaningful inbox heartbeat или успешный bootstrap transcript. Это самый сильный сигнал.

2. `runtime_process`
   Найден процесс runtime с надежной идентичностью: `--team-name <team>` + `--agent-id <agentId>`, или OpenCode bridge вернул валидный `runtimePid`/`sessionId`, и PID жив.

3. `runtime_process_candidate`
   Найден non-shell descendant под tmux pane, но без строгого identity match. Это diagnostic signal, не strong alive signal в первой реализации.

4. `permission_blocked`
   Runtime/bridge явно говорит, что требуется permission approval.

5. `shell_only`
   Tmux pane жив, но foreground command или root pane process выглядит как shell, и runtime child не найден.

6. `registered_only`
   Member есть в `config.json`/`members.meta.json`, но live process не найден.

7. `stale_metadata`
   Есть persisted `agentId`, `tmuxPaneId` или `runtimePid`, но live evidence не подтвержден.

8. `not_found`
   Нет полезных runtime данных.

### Strong vs weak

Только эти состояния ставят `runtimeAlive: true`:

- `confirmed_bootstrap`
- `runtime_process`

Эти состояния не ставят `runtimeAlive: true`:

- `runtime_process_candidate`
- `permission_blocked`
- `shell_only`
- `registered_only`
- `stale_metadata`
- `not_found`

Почему `runtime_process_candidate` не strong: non-shell child может быть `node`, `script`, `sleep`, wrapper или одноразовая команда. Без `teamName/agentId/sessionId` это слишком рискованно для снятия failure.

## Тайминги

Оставить текущий `MEMBER_LAUNCH_GRACE_MS = 90_000` как короткий timeout для отсутствия strong evidence.

Добавить отдельный bootstrap stall deadline:

```ts
const MEMBER_BOOTSTRAP_STALL_MS = 5 * 60_000;
```

Правила:

- После 90 секунд:
  - `shell_only`, `registered_only`, `stale_metadata`, `not_found` -> `failed_to_start`.
  - `permission_blocked` -> не hard fail, показать permission UI.
  - `runtime_process_candidate` -> warning, но не считать ready.
  - `runtime_process` -> warning `waiting for bootstrap`, но не hard fail на 90 сек.

- После 5 минут:
  - `runtime_process_candidate` без bootstrap -> `failed_to_start`.
  - `runtime_process` без bootstrap -> `runtimeDiagnosticSeverity: "warning"` и launch banner должен перестать быть мутным: `runtime alive but no bootstrap after 5 min`.

Важно: verified runtime process не надо сразу убивать или hard fail-ить только потому, что bootstrap не пришел. Но UI не должен продолжать generic `starting`.

## Rollout mode

Строгая модель меняет поведение launch timeout, поэтому изначальный план рассматривал rollout через отдельный флаг.
Текущая реализация после hardening включает strict liveness по умолчанию и не содержит старый переключатель режима.

Актуальное поведение:

| Area                           | Strict-only behavior                  |
| ------------------------------ | ------------------------------------- |
| `livenessKind`                 | always filled when evidence exists    |
| UI labels                      | enabled                               |
| `runtimeAlive` from shell-only | always false                          |
| `already_running` shortcut     | waits for strong runtime verification |
| timeout self-heal              | strong evidence only                  |
| launchDiagnostics              | enabled for warning/error states      |

Operational rollback должен быть отдельным code revert или follow-up setting, а не скрытым env-флагом.

## Structured launch diagnostics

Файлы:

- `src/shared/types/team.ts`
- `src/main/services/team/TeamProvisioningService.ts`
- `src/main/services/team/progressPayload.ts`
- `src/renderer/components/team/ProvisioningProgressBlock.tsx`

`TeamProvisioningProgress` сейчас почти полностью строковый:

- `message`
- `warnings`
- `cliLogsTail`
- `assistantOutput`

`cliLogsTail` и `assistantOutput` уже специально ограничены (`PROGRESS_LOG_TAIL_LINES`, `PROGRESS_OUTPUT_TAIL_PARTS`), чтобы не провоцировать renderer OOM. Поэтому нельзя решать проблему "непонятно что происходит" простым расширением логов.

Добавить маленький структурированный payload:

```ts
export interface TeamLaunchDiagnosticItem {
  id: string;
  memberName?: string;
  severity: 'info' | 'warning' | 'error';
  code:
    | 'spawn_accepted'
    | 'runtime_process_detected'
    | 'runtime_process_candidate'
    | 'tmux_shell_only'
    | 'runtime_not_found'
    | 'permission_pending'
    | 'bootstrap_confirmed'
    | 'bootstrap_stalled'
    | 'stale_runtime_event_rejected'
    | 'process_table_unavailable';
  label: string;
  detail?: string;
  observedAt: string;
}

export interface TeamProvisioningProgress {
  // existing fields...
  launchDiagnostics?: TeamLaunchDiagnosticItem[];
}
```

Bounded contract:

- максимум 20 diagnostic items в progress payload;
- newest-first или stable sorted by severity/member;
- no raw unbounded command strings;
- process command must be sanitized/truncated;
- member-level details live in `MemberSpawnStatusEntry`/`TeamAgentRuntimeEntry`, progress diagnostics are only summary.

Renderer:

- `ProvisioningProgressBlock` can render a compact "Diagnostics" disclosure above Live output.
- It should show code-specific rows like `bob - shell only - tmux pane foreground command is zsh`.
- It should not require opening CLI logs to understand common stuck states.

Recommended UI rows:

```text
bob    shell only              tmux pane foreground command is zsh
jack   waiting for bootstrap   verified runtime process, no check-in yet
tom    no runtime found        spawn accepted 94s ago
```

This is separate from `Copy diagnostics`, which can include full sanitized JSON.

## Типы

Файл: `src/shared/types/team.ts`

```ts
export type TeamAgentRuntimeLivenessKind =
  | 'confirmed_bootstrap'
  | 'runtime_process'
  | 'runtime_process_candidate'
  | 'permission_blocked'
  | 'shell_only'
  | 'registered_only'
  | 'stale_metadata'
  | 'not_found';

export type TeamAgentRuntimePidSource =
  | 'lead_process'
  | 'tmux_pane'
  | 'tmux_child'
  | 'agent_process_table'
  | 'opencode_bridge'
  | 'runtime_bootstrap'
  | 'persisted_metadata';

export type TeamAgentRuntimeDiagnosticSeverity = 'info' | 'warning' | 'error';

export interface TeamAgentRuntimeEntry {
  memberName: string;
  alive: boolean;
  restartable: boolean;
  backendType?: TeamAgentRuntimeBackendType;
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  laneId?: string;
  laneKind?: 'primary' | 'secondary';
  pid?: number;
  runtimeModel?: string;
  rssBytes?: number;
  livenessKind?: TeamAgentRuntimeLivenessKind;
  pidSource?: TeamAgentRuntimePidSource;
  processCommand?: string;
  paneId?: string;
  panePid?: number;
  paneCurrentCommand?: string;
  runtimePid?: number;
  runtimeSessionId?: string;
  runtimeLeaseExpiresAt?: string;
  runtimeLastSeenAt?: string;
  runtimeDiagnostic?: string;
  runtimeDiagnosticSeverity?: TeamAgentRuntimeDiagnosticSeverity;
  diagnostics?: string[];
  updatedAt: string;
}
```

В `MemberSpawnStatusEntry` добавить только компактные поля для launch UI:

```ts
export interface MemberSpawnStatusEntry {
  // existing fields
  runtimeDiagnostic?: string;
  runtimeDiagnosticSeverity?: 'info' | 'warning' | 'error';
  livenessKind?: TeamAgentRuntimeLivenessKind;
  livenessLastCheckedAt?: string;
}
```

Почему `runtimeSessionId` и `runtimeLastSeenAt` важны:

- OpenCode runtime tools всегда передают `runtimeSessionId`.
- `runtime_bootstrap_checkin` и `runtime_heartbeat` уже являются lease-like сигналом.
- Без `runtimeLastSeenAt` UI не сможет отличить "процесс подтвержден 10 секунд назад" от "persisted state висит со вчера".
- `runtimeLeaseExpiresAt` можно не включать в Phase 0, но тип стоит заложить сразу, если lease/heartbeat manager будет Phase 5.

## Runtime tool metadata

Файлы:

- `mcp-server/src/tools/runtimeTools.ts`
- `src/main/services/team/TeamProvisioningService.ts`

`runtime_bootstrap_checkin` и `runtime_heartbeat` уже принимают `metadata`, но main сейчас не извлекает из нее ничего. Это упущение: OpenCode/runtime может передать полезные low-level детали, которые не стоит парсить из logs.

Поддержать bounded metadata:

```ts
interface RuntimeToolMetadata {
  runtimePid?: number;
  processCommand?: string;
  runtimeVersion?: string;
  hostPid?: number;
  cwd?: string;
}
```

Parser:

```ts
function parseRuntimeToolMetadata(value: unknown): RuntimeToolMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const raw = value as Record<string, unknown>;
  const runtimePid =
    typeof raw.runtimePid === 'number' && Number.isFinite(raw.runtimePid) && raw.runtimePid > 0
      ? Math.trunc(raw.runtimePid)
      : undefined;
  const processCommand =
    typeof raw.processCommand === 'string' ? raw.processCommand.slice(0, 500) : undefined;
  return {
    ...(runtimePid ? { runtimePid } : {}),
    ...(processCommand ? { processCommand } : {}),
  };
}
```

Security/robustness:

- bound string lengths;
- ignore nested objects except allowlisted fields;
- never put raw metadata into logs/UI;
- include sanitized fields in copy diagnostics.

`updateOpenCodeRuntimeMemberLiveness()` should accept sanitized metadata:

```ts
await this.updateOpenCodeRuntimeMemberLiveness({
  teamName,
  runId,
  memberName,
  runtimeSessionId,
  observedAt,
  diagnostics: payload.diagnostics,
  metadata: parseRuntimeToolMetadata(payload.metadata),
  reason: 'OpenCode runtime bootstrap check-in accepted',
});
```

If metadata has `runtimePid`, still verify it:

- PID must be alive now;
- command must still look like the expected runtime, if command info is available;
- runId/teamName/sessionId must match current tombstone/launch state.

Do not trust metadata PID by itself.

## Internal metadata

Файл: `src/main/services/team/TeamProvisioningService.ts`

Расширить внутренний тип:

```ts
interface LiveTeamAgentRuntimeMetadata {
  alive: boolean;
  backendType?: TeamAgentRuntimeBackendType;
  agentId?: string;
  pid?: number;
  metricsPid?: number;
  model?: string;
  tmuxPaneId?: string;
  livenessKind?: TeamAgentRuntimeLivenessKind;
  pidSource?: TeamAgentRuntimePidSource;
  processCommand?: string;
  panePid?: number;
  paneCurrentCommand?: string;
  runtimeSessionId?: string;
  diagnostics?: string[];
}
```

Helper:

```ts
function isStrongRuntimeEvidence(metadata: LiveTeamAgentRuntimeMetadata | undefined): boolean {
  return (
    metadata?.livenessKind === 'confirmed_bootstrap' || metadata?.livenessKind === 'runtime_process'
  );
}

function isWeakRuntimeEvidence(metadata: LiveTeamAgentRuntimeMetadata | undefined): boolean {
  return (
    metadata?.livenessKind === 'runtime_process_candidate' ||
    metadata?.livenessKind === 'permission_blocked' ||
    metadata?.livenessKind === 'shell_only' ||
    metadata?.livenessKind === 'registered_only' ||
    metadata?.livenessKind === 'stale_metadata' ||
    metadata?.livenessKind === 'not_found'
  );
}
```

## Liveness resolver seam

Файл: `src/main/services/team/TeamRuntimeLivenessResolver.ts`

Не стоит держать весь liveness algorithm внутри `TeamProvisioningService`. Там уже смешаны launch state, persistence, progress, tmux, OpenCode, inbox audit и runtime snapshot. Для надежности и тестов лучше вынести pure resolver.

Варианты:

1. Вынести только pure helpers
   🎯 8 🛡️ 7 🧠 4 Примерно 120-180 строк.
   Быстро, но `getLiveTeamAgentRuntimeMetadata()` останется большим orchestration методом.

2. Вынести resolver с input/output контрактом
   🎯 9 🛡️ 9 🧠 6 Примерно 220-340 строк.
   Лучший баланс: service собирает raw facts, resolver принимает facts и возвращает `LiveTeamAgentRuntimeMetadata`.

3. Вынести полноценный runtime monitor service
   🎯 8 🛡️ 10 🧠 8 Примерно 500-800 строк.
   Архитектурно чище, но слишком большой шаг для текущего фикса.

Рекомендация: вариант 2.

Resolver input:

```ts
export interface ResolveTeamMemberRuntimeLivenessInput {
  teamName: string;
  memberName: string;
  agentId?: string;
  backendType?: TeamAgentRuntimeBackendType;
  providerId?: TeamProviderId;
  tmuxPaneId?: string;
  persistedRuntimePid?: number;
  persistedRuntimeSessionId?: string;
  trackedSpawnStatus?: MemberSpawnStatusEntry;
  openCodeEvidence?: TeamRuntimeMemberLaunchEvidence;
  pane?: TmuxPaneRuntimeInfo;
  processRows: readonly RuntimeProcessTableRow[];
  nowIso: string;
}
```

Resolver output:

```ts
export interface ResolvedTeamMemberRuntimeLiveness {
  alive: boolean;
  livenessKind: TeamAgentRuntimeLivenessKind;
  pidSource?: TeamAgentRuntimePidSource;
  pid?: number;
  metricsPid?: number;
  panePid?: number;
  paneCurrentCommand?: string;
  processCommand?: string;
  runtimeSessionId?: string;
  runtimeDiagnostic: string;
  runtimeDiagnosticSeverity: TeamAgentRuntimeDiagnosticSeverity;
  diagnostics: string[];
}
```

`TeamProvisioningService` responsibilities after extraction:

- read config/meta/persisted launch/runtime state;
- batch-read tmux pane runtime info once;
- batch-read process table once;
- call resolver per member;
- cache and expose the resolved metadata;
- invalidate caches on check-in/heartbeat/restart/stop/pane kill.

Resolver responsibilities:

- classify shell-only vs runtime process vs candidate;
- enforce strong/weak evidence rules;
- choose `pidSource`;
- sanitize diagnostics;
- never read filesystem, tmux, process table or stores directly.

This seam makes the hardest rules unit-testable without spawning tmux or fake processes.

## Tmux runtime info

Файл: `src/features/tmux-installer/main/infrastructure/runtime/TmuxPlatformCommandExecutor.ts`

Сейчас читается только pane PID. Нужно получать больше контекста:

```ts
export interface TmuxPaneRuntimeInfo {
  paneId: string;
  panePid: number;
  currentCommand?: string;
  currentPath?: string;
  sessionName?: string;
  windowName?: string;
}

async listPaneRuntimeInfo(paneIds: readonly string[]): Promise<Map<string, TmuxPaneRuntimeInfo>> {
  const normalizedPaneIds = [...new Set(paneIds.map((paneId) => paneId.trim()).filter(Boolean))];
  if (normalizedPaneIds.length === 0) return new Map();

  const format = [
    '#{pane_id}',
    '#{pane_pid}',
    '#{pane_current_command}',
    '#{pane_current_path}',
    '#{session_name}',
    '#{window_name}',
  ].join('\t');

  const result = await this.execTmux(['list-panes', '-a', '-F', format], 3_000);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || 'Failed to list tmux panes');
  }

  const wanted = new Set(normalizedPaneIds);
  const infoByPaneId = new Map<string, TmuxPaneRuntimeInfo>();

  for (const line of result.stdout.split('\n')) {
    const [paneId = '', rawPid = '', currentCommand = '', currentPath = '', sessionName = '', windowName = ''] =
      line.split('\t');
    const normalizedPaneId = paneId.trim();
    if (!wanted.has(normalizedPaneId)) continue;

    const panePid = Number.parseInt(rawPid.trim(), 10);
    if (!Number.isFinite(panePid) || panePid <= 0) continue;

    infoByPaneId.set(normalizedPaneId, {
      paneId: normalizedPaneId,
      panePid,
      currentCommand: currentCommand.trim() || undefined,
      currentPath: currentPath.trim() || undefined,
      sessionName: sessionName.trim() || undefined,
      windowName: windowName.trim() || undefined,
    });
  }

  return infoByPaneId;
}
```

Оставить старый метод как wrapper:

```ts
async listPanePids(paneIds: readonly string[]): Promise<Map<string, number>> {
  const info = await this.listPaneRuntimeInfo(paneIds);
  return new Map([...info.entries()].map(([paneId, pane]) => [paneId, pane.panePid]));
}
```

Compatibility rule:

- `listPanePids()` remains "does this pane exist and what is its root pane PID".
- It must not imply teammate runtime liveness.
- Existing callers like `waitForTmuxPanesToExit()` should keep working without knowing about `livenessKind`.

## Process table

Нужен `ppid`, иначе невозможно понять, есть ли runtime child под tmux pane.

```ts
interface RuntimeProcessTableRow {
  pid: number;
  ppid: number;
  command: string;
}
```

Do not implement this as `readUnixProcessTableRows()` inside `TeamProvisioningService`. The current helper is private, sync and native-only. The strict model needs a testable, platform-aware provider.

Recommended shape:

```ts
export interface RuntimeProcessTableProvider {
  listRuntimeProcesses(): Promise<RuntimeProcessTableRow[]>;
}
```

`TmuxPlatformCommandExecutor` can implement it because it already knows whether the current tmux runtime is native or WSL-backed.

На macOS/Linux:

```ts
ps -ax -o pid=,ppid=,command=
```

На Windows/WSL важно: `ps` должен выполняться внутри той же WSL distro, где выполняется tmux. Host-side Windows `ps` не увидит Linux children.

Практичный вариант:

- добавить в `TmuxPlatformCommandExecutor` метод `listRuntimeProcesses()`;
- внутри Windows ветки использовать `TmuxWslService` и запускать `wsl -d <distro> -e ps -ax -o pid=,ppid=,command=`;
- на native платформах использовать обычный `execFile('ps', ...)`.

Пример парсинга:

```ts
function parseRuntimeProcessTable(output: string): RuntimeProcessTableRow[] {
  const rows: RuntimeProcessTableRow[] = [];

  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;

    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    const command = match[3]?.trim() ?? '';

    if (Number.isFinite(pid) && pid > 0 && Number.isFinite(ppid) && command) {
      rows.push({ pid, ppid, command });
    }
  }

  return rows;
}
```

Performance contract:

- read process table once per runtime snapshot, not once per member;
- reuse the same rows for every member resolver call;
- respect the existing backend cache TTL around 2 seconds;
- if process table read fails, return an explicit diagnostic and do not mark shell-only as strong alive.

Failure contract:

- `process_table_unavailable` is a warning, not an immediate hard fail by itself;
- if tmux pane info is available but process table is unavailable, classify as `shell_only` only when `pane_current_command` is shell-like;
- if both tmux and process table are unavailable, classify as `stale_metadata` or `not_found` based on persisted evidence;
- do not self-clear a previous failure on provider failure.

### PID freshness and reuse

PID alone is not identity. A stale persisted `runtimePid` can be reused by the OS for another process.

Rules:

- Never treat persisted PID as strong evidence without reading the current process table.
- A PID match is strong only if current command identity also matches expected runtime identity.
- If possible later, add process start time to the table and compare it with `firstSpawnAcceptedAt`/`runtimeLastSeenAt`.
- If process start time is unavailable, use command identity and current run/session identity as the minimum.

Optional future row:

```ts
interface RuntimeProcessTableRow {
  pid: number;
  ppid: number;
  command: string;
  startedAtMs?: number;
}
```

Do not block Phase 1 on `startedAtMs`; block it on "no PID-only strong evidence".

## Shell detection

```ts
const SHELL_COMMAND_NAMES = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'login', 'tmux']);

function basenameCommand(command: string | undefined): string {
  const firstToken = command?.trim().split(/\s+/, 1)[0] ?? '';
  const base = firstToken.split(/[\\/]/).pop() ?? firstToken;
  return base.replace(/^-/, '').toLowerCase();
}

function isShellLikeCommand(command: string | undefined): boolean {
  return SHELL_COMMAND_NAMES.has(basenameCommand(command));
}
```

## Runtime identity matching

Текущий `commandContainsCliArgValue()` лучше заменить на helper, который поддерживает оба вида:

- `--agent-id abc`
- `--agent-id=abc`
- quoted values

Минимально:

```ts
function extractCliArgValues(command: string, argName: string): string[] {
  const escapedArg = argName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(?:^|\\s)${escapedArg}(?:=|\\s+)("([^"]*)"|'([^']*)'|([^\\s]+))`,
    'g'
  );

  const values: string[] = [];
  for (const match of command.matchAll(pattern)) {
    const value = (match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (value) values.push(value);
  }
  return values;
}

function commandArgEquals(command: string, argName: string, expected: string | undefined): boolean {
  if (!expected?.trim()) return false;
  return extractCliArgValues(command, argName).some((value) => value === expected.trim());
}
```

Strong process match:

```ts
function isVerifiedRuntimeProcess(params: {
  row: RuntimeProcessTableRow;
  teamName: string;
  agentId?: string;
}): boolean {
  return (
    commandArgEquals(params.row.command, '--team-name', params.teamName) &&
    commandArgEquals(params.row.command, '--agent-id', params.agentId)
  );
}
```

Sanitize any command before it reaches UI/logs/copy diagnostics:

```ts
const SECRET_FLAG_PATTERN =
  /(--(?:api-key|token|password|secret|authorization|auth-token)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi;

function sanitizeProcessCommandForDiagnostics(command: string | undefined): string | undefined {
  const trimmed = command?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(SECRET_FLAG_PATTERN, '$1[redacted]').slice(0, 500);
}
```

Do not use sanitized commands for identity matching. Match on the raw process table row inside main process memory, then only expose sanitized/truncated command text.

## Descendant resolution

```ts
function collectDescendants(
  rows: readonly RuntimeProcessTableRow[],
  rootPid: number
): RuntimeProcessTableRow[] {
  const childrenByParent = new Map<number, RuntimeProcessTableRow[]>();

  for (const row of rows) {
    const bucket = childrenByParent.get(row.ppid) ?? [];
    bucket.push(row);
    childrenByParent.set(row.ppid, bucket);
  }

  const result: RuntimeProcessTableRow[] = [];
  const queue = [...(childrenByParent.get(rootPid) ?? [])];

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) continue;
    result.push(next);
    queue.push(...(childrenByParent.get(next.pid) ?? []));
  }

  return result;
}
```

Resolution:

```ts
interface ResolvedRuntimeProcess {
  kind: TeamAgentRuntimeLivenessKind;
  pid?: number;
  command?: string;
  pidSource?: TeamAgentRuntimePidSource;
  diagnostics: string[];
}

function resolveTmuxRuntimeProcess(params: {
  teamName: string;
  agentId?: string;
  pane: TmuxPaneRuntimeInfo;
  rows: readonly RuntimeProcessTableRow[];
}): ResolvedRuntimeProcess {
  const descendants = collectDescendants(params.rows, params.pane.panePid);

  const verified = descendants.find((row) =>
    isVerifiedRuntimeProcess({
      row,
      teamName: params.teamName,
      agentId: params.agentId,
    })
  );

  if (verified) {
    return {
      kind: 'runtime_process',
      pid: verified.pid,
      command: verified.command,
      pidSource: 'tmux_child',
      diagnostics: ['matched tmux descendant by team-name and agent-id'],
    };
  }

  const candidate = descendants.find((row) => !isShellLikeCommand(row.command));
  if (candidate) {
    return {
      kind: 'runtime_process_candidate',
      pid: candidate.pid,
      command: candidate.command,
      pidSource: 'tmux_child',
      diagnostics: ['found non-shell descendant without team/member identity'],
    };
  }

  if (isShellLikeCommand(params.pane.currentCommand)) {
    return {
      kind: 'shell_only',
      pid: params.pane.panePid,
      command: params.pane.currentCommand,
      pidSource: 'tmux_pane',
      diagnostics: [
        `tmux pane is alive, but foreground command is ${params.pane.currentCommand}`,
        'no verified runtime descendant process was found',
      ],
    };
  }

  return {
    kind: 'not_found',
    diagnostics: ['tmux pane exists, but no runtime process could be identified'],
  };
}
```

## OpenCode bridge correction

Файл: `src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter.ts`

Сейчас `pendingRuntimeObserved = createdOrBlocked && runtimeMaterialized`, а `runtimeMaterialized` фактически означает "bridge вернул member". Это не равно live runtime.

Надо разделить:

- `agentToolAccepted`: bridge принял/создал member.
- `runtimeAlive`: есть подтвержденный live runtime signal или confirmed bootstrap.
- `bootstrapConfirmed`: `launchState === "confirmed_alive"`.

Пример:

```ts
function mapBridgeMemberToRuntimeEvidence(
  memberName: string,
  launchState: OpenCodeTeamMemberLaunchBridgeState,
  sessionId: string | undefined,
  runtimePid: number | undefined,
  pendingPermissionRequestIds: string[] | undefined,
  runtimeMaterialized: boolean,
  diagnostics: string[]
): TeamRuntimeMemberLaunchEvidence {
  const confirmed = launchState === 'confirmed_alive';
  const failed = launchState === 'failed';
  const permissionBlocked = launchState === 'permission_blocked';
  const validRuntimePid =
    typeof runtimePid === 'number' && Number.isFinite(runtimePid) && runtimePid > 0;
  const hasRuntimeSession = typeof sessionId === 'string' && sessionId.trim().length > 0;
  const runtimeLivenessKind = confirmed
    ? 'confirmed_bootstrap'
    : validRuntimePid
      ? 'runtime_process'
      : permissionBlocked
        ? 'permission_blocked'
        : hasRuntimeSession
          ? 'runtime_process_candidate'
          : undefined;

  return {
    memberName,
    providerId: 'opencode',
    launchState: failed
      ? 'failed_to_start'
      : confirmed
        ? 'confirmed_alive'
        : permissionBlocked
          ? 'runtime_pending_permission'
          : 'runtime_pending_bootstrap',
    agentToolAccepted: confirmed || runtimeMaterialized,
    runtimeAlive: confirmed || validRuntimePid,
    bootstrapConfirmed: confirmed,
    hardFailure: failed,
    hardFailureReason: failed ? 'OpenCode bridge reported member launch failure' : undefined,
    pendingPermissionRequestIds:
      pendingPermissionRequestIds && pendingPermissionRequestIds.length > 0
        ? [...new Set(pendingPermissionRequestIds)]
        : undefined,
    sessionId,
    ...(validRuntimePid ? { runtimePid } : {}),
    ...(runtimeLivenessKind ? { livenessKind: runtimeLivenessKind } : {}),
    diagnostics,
  };
}
```

Важно: `sessionId` без `runtimePid` лучше считать candidate, а не strong live process. Session id полезен для delivery/permission correlation, но сам по себе не доказывает, что процесс сейчас жив.

Также `toOpenCodePersistedLaunchMember()` должен сохранять `runtimePid` и `sessionId`, если они есть. Сейчас для primary OpenCode launch evidence это легко потерять.

### OpenCode transaction/readiness invariant

`canMarkOpenCodeRunReady()` уже требует `bootstrap_confirmed`, поэтому новая liveness-модель не должна поднимать aggregate state в `clean_success`, если есть только:

- bridge `created`;
- `sessionId` без bootstrap;
- permission request;
- stale launch-state member.

Regression test:

```ts
expect(
  canMarkOpenCodeRunReady({
    members: [{ name: 'bob', launchState: 'runtime_pending_bootstrap' }],
    // checkpoints exist except bootstrap
  }).ok
).toBe(false);
```

### Stale runtime events

`assertOpenCodeRuntimeEvidenceAccepted()` already checks tombstones/current run ownership before accepting bootstrap/heartbeat/delivery evidence. This must remain the gate for all strong OpenCode liveness.

Rules:

- `runtime_bootstrap_checkin` from an old `runId` must not revive a stopped/relaunched member.
- `runtime_heartbeat` from an old lane must not refresh `runtimeLastSeenAt`.
- Runtime metadata from rejected evidence must not be written to persisted launch state.
- UI copy diagnostics should include `runId` and `runtimeSessionId` only after accepted evidence.

Regression tests:

```ts
await expect(
  service.recordOpenCodeRuntimeHeartbeat({
    teamName,
    runId: oldRunId,
    memberName: 'bob',
    runtimeSessionId: oldSessionId,
  })
).rejects.toThrow();
```

## `getLiveTeamAgentRuntimeMetadata()`

Новая логика:

1. Сначала читать durable status:
   - `bootstrapConfirmed`
   - `lastHeartbeatAt`
   - `runtime_bootstrap_checkin`
   - transcript success

2. Потом читать verified runtime:
   - process table match by `--team-name` + `--agent-id`
   - OpenCode runtimePid/sessionId
   - tmux descendant with verified identity

3. Потом diagnostic-only:
   - tmux pane shell
   - config/meta registration
   - stale persisted metadata

Sketch:

```ts
const status = this.findTrackedMemberSpawnStatus(run, memberName);
const diagnostics: string[] = [];

let livenessKind: TeamAgentRuntimeLivenessKind = 'not_found';
let pid: number | undefined;
let pidSource: TeamAgentRuntimePidSource | undefined;
let processCommand: string | undefined;

if (status?.bootstrapConfirmed === true) {
  livenessKind = 'confirmed_bootstrap';
  diagnostics.push('bootstrap was confirmed by member check-in or heartbeat');
}

if (livenessKind !== 'confirmed_bootstrap' && metadata.agentId) {
  const processPid = processPidByAgentId.get(metadata.agentId);
  if (processPid) {
    livenessKind = 'runtime_process';
    pid = processPid;
    pidSource = 'agent_process_table';
    diagnostics.push('matched process table by team-name and agent-id');
  }
}

if (livenessKind !== 'runtime_process' && paneInfo) {
  const resolved = resolveTmuxRuntimeProcess({
    teamName,
    agentId: metadata.agentId,
    pane: paneInfo,
    rows: processRows,
  });

  livenessKind = resolved.kind;
  pid = resolved.pid;
  pidSource = resolved.pidSource;
  processCommand = resolved.command;
  diagnostics.push(...resolved.diagnostics);
}

if (livenessKind === 'not_found' && metadata.agentId) {
  livenessKind = 'stale_metadata';
  diagnostics.push('persisted agent id exists, but no live process matched it');
}

const alive = livenessKind === 'confirmed_bootstrap' || livenessKind === 'runtime_process';

metadataByMember.set(memberName, {
  ...metadata,
  alive,
  livenessKind,
  ...(pid ? { pid } : {}),
  ...(pidSource ? { pidSource } : {}),
  ...(processCommand ? { processCommand } : {}),
  ...(paneInfo
    ? {
        panePid: paneInfo.panePid,
        paneCurrentCommand: paneInfo.currentCommand,
      }
    : {}),
  diagnostics,
});
```

Fallback policy:

- Если enhanced tmux info failed, не возвращать `alive: true` только из старого `panePid`.
- Если `ps` failed, показывать diagnostic `process table unavailable`; не self-clear failure.
- Если cached metadata есть, сохранять `model/backendType`, но не сохранять stale `alive`.
- Если `previousMember.bootstrapConfirmed === true`, persisted launch state может оставаться confirmed для истории, но runtime snapshot должен показывать `alive` отдельно от historical `bootstrapConfirmed`. Иначе UI может считать старого member live после stop/relaunch.

## Persisted launch state

Файл: `src/main/services/team/TeamLaunchStateEvaluator.ts`

Сейчас `RuntimeMemberSpawnState` и persisted member normalization не знают про новые diagnostic поля. Нужно расширить аккуратно, чтобы старые snapshots читались без migration.

Добавить в `PersistedTeamLaunchMemberState`:

```ts
runtimeSessionId?: string;
livenessKind?: TeamAgentRuntimeLivenessKind;
pidSource?: TeamAgentRuntimePidSource;
runtimeDiagnostic?: string;
runtimeDiagnosticSeverity?: TeamAgentRuntimeDiagnosticSeverity;
```

Правило:

- persisted `livenessKind` можно использовать для UI explanation;
- persisted `livenessKind` нельзя использовать как live proof без свежего `lastRuntimeAliveAt` или live runtime check.

Normalize:

```ts
function normalizeLivenessKind(value: unknown): TeamAgentRuntimeLivenessKind | undefined {
  return value === 'confirmed_bootstrap' ||
    value === 'runtime_process' ||
    value === 'runtime_process_candidate' ||
    value === 'permission_blocked' ||
    value === 'shell_only' ||
    value === 'registered_only' ||
    value === 'stale_metadata' ||
    value === 'not_found'
    ? value
    : undefined;
}
```

`updateOpenCodeRuntimeMemberLiveness()` должен сохранять:

```ts
livenessKind: 'confirmed_bootstrap',
pidSource: 'runtime_bootstrap',
runtimeSessionId: input.runtimeSessionId,
runtimeDiagnostic: undefined,
runtimeDiagnosticSeverity: undefined,
```

`toOpenCodePersistedLaunchMember()` должен сохранять:

```ts
runtimePid: evidence?.runtimePid,
runtimeSessionId: evidence?.sessionId,
livenessKind: evidence?.bootstrapConfirmed
  ? 'confirmed_bootstrap'
  : evidence?.runtimeAlive
    ? 'runtime_process'
    : evidence?.pendingPermissionRequestIds?.length
      ? 'permission_blocked'
      : undefined,
```

Mapping functions that must be updated:

- `RuntimeMemberSpawnState` pick list must include `livenessKind`, `runtimeDiagnostic`, `runtimeDiagnosticSeverity`.
- `snapshotFromRuntimeMemberStatuses()` must copy those fields into `PersistedTeamLaunchMemberState`.
- `snapshotToMemberSpawnStatuses()` must copy them back into `MemberSpawnStatusEntry`.
- `normalizePersistedLaunchSnapshot()` must normalize unknown old files without dropping valid new fields.

Example:

```ts
statuses[memberName] = {
  status,
  launchState: entry.launchState,
  error: entry.hardFailure ? entry.hardFailureReason : undefined,
  hardFailureReason: entry.hardFailureReason,
  livenessSource,
  agentToolAccepted: entry.agentToolAccepted,
  runtimeAlive: entry.runtimeAlive,
  bootstrapConfirmed: entry.bootstrapConfirmed,
  hardFailure: entry.hardFailure,
  pendingPermissionRequestIds: entry.pendingPermissionRequestIds,
  firstSpawnAcceptedAt: entry.firstSpawnAcceptedAt,
  lastHeartbeatAt: entry.lastHeartbeatAt,
  livenessKind: entry.livenessKind,
  runtimeDiagnostic: entry.runtimeDiagnostic,
  runtimeDiagnosticSeverity: entry.runtimeDiagnosticSeverity,
  updatedAt: entry.lastEvaluatedAt,
};
```

Backward compatibility:

- old snapshots without these fields should behave exactly as today;
- new optional summary counts should default to `0` at presentation time;
- do not bump snapshot `version` unless a required field is introduced. For this plan, keep `version: 2`.

## `attachLiveRuntimeMetadataToStatuses()`

Текущий behavior:

```ts
if (metadata.alive) {
  nextEntry.runtimeAlive = true;
  nextEntry.livenessSource = 'process';
}
```

Новый behavior:

```ts
const strongRuntimeAlive = isStrongRuntimeEvidence(metadata);
const weakRuntimeEvidence = isWeakRuntimeEvidence(metadata);

if (
  strongRuntimeAlive &&
  current.hardFailure !== true &&
  current.launchState !== 'failed_to_start'
) {
  nextEntry.status = 'online';
  nextEntry.agentToolAccepted = true;
  nextEntry.runtimeAlive = true;
  nextEntry.hardFailure = false;
  nextEntry.hardFailureReason = undefined;
  nextEntry.error = undefined;
  nextEntry.livenessSource = current.bootstrapConfirmed ? current.livenessSource : 'process';
  nextEntry.livenessKind = metadata.livenessKind;
  nextEntry.runtimeDiagnostic = undefined;
  nextEntry.runtimeDiagnosticSeverity = undefined;
  nextEntry.launchState = deriveMemberLaunchState(nextEntry);
}

if (weakRuntimeEvidence && current.bootstrapConfirmed !== true) {
  nextEntry.runtimeAlive = false;
  nextEntry.livenessKind = metadata.livenessKind;
  nextEntry.runtimeDiagnostic = buildRuntimeDiagnostic(metadata);
  nextEntry.runtimeDiagnosticSeverity = metadata.livenessKind === 'shell_only' ? 'warning' : 'info';
}
```

Self-heal из `failed_to_start` оставить только для strong evidence:

```ts
if (
  strongRuntimeAlive &&
  current.launchState === 'failed_to_start' &&
  isAutoClearableLaunchFailureReason(failureReason)
) {
  // clear auto failure
}
```

## Spawn tool result handling

Файл: `src/main/services/team/TeamProvisioningService.ts`

`handleMemberSpawnToolResult()` раньше содержал shortcut:

```ts
if (parsedStatus.reason === 'already_running') {
  this.setMemberSpawnStatus(run, spawnedMemberName, 'online', undefined, 'process');
}
```

В strict liveness модели это опасно: `already_running` доказывает, что runtime/CLI отказался дублировать spawn, но не доказывает, что нужный teammate сейчас прошел bootstrap или что текущий pane PID является runtime процессом.

Итоговая логика:

```ts
if (parsedStatus.reason === 'already_running') {
  this.agentRuntimeSnapshotCache.delete(run.teamName);
  this.liveTeamAgentRuntimeMetadataCache.delete(run.teamName);
  this.setMemberSpawnStatus(run, spawnedMemberName, 'waiting');
  this.appendMemberBootstrapDiagnostic(
    run,
    spawnedMemberName,
    'already_running requires strong runtime verification'
  );
  void this.reevaluateMemberLaunchStatus(run, spawnedMemberName);
}
```

Tests:

- `already_running` + shell-only pane -> stays pending/warning, no `runtimeAlive`.
- `already_running` + verified process -> can become `runtime_pending_bootstrap`.
- `already_running` + confirmed bootstrap -> confirmed alive.

## `reevaluateMemberLaunchStatus()`

Текущий early return по `refreshed.runtimeAlive` слишком широкий.

Новый sketch:

```ts
await this.refreshMemberSpawnStatusesFromLeadInbox(run);
await this.maybeAuditMemberSpawnStatuses(run, { force: true });

const refreshed = run.memberSpawnStatuses.get(memberName);
if (!refreshed) return;

const runtimeByMember = await this.getLiveTeamAgentRuntimeMetadata(run.teamName);
const runtime = findRuntimeMetadataForMember(runtimeByMember, memberName);
const strongRuntimeAlive = isStrongRuntimeEvidence(runtime);

if (refreshed.launchState === 'failed_to_start' || refreshed.launchState === 'confirmed_alive') {
  return;
}

if (strongRuntimeAlive) {
  this.setMemberRuntimeDiagnostic(run, memberName, {
    livenessKind: runtime?.livenessKind,
    message: 'Runtime process is alive, waiting for teammate bootstrap/check-in.',
    severity: 'warning',
  });
  return;
}

if (runtime?.livenessKind === 'permission_blocked') {
  return;
}

const reason =
  runtime?.livenessKind === 'shell_only'
    ? `Teammate did not join within the launch grace window. Tmux pane is alive, but only shell command "${runtime.paneCurrentCommand ?? 'unknown'}" was detected.`
    : runtime?.livenessKind === 'runtime_process_candidate'
      ? 'Teammate did not confirm bootstrap. Only an unverified runtime process candidate was found.'
      : 'Teammate did not join within the launch grace window.';

this.setMemberSpawnStatus(run, memberName, 'error', reason);
```

Для `runtime_process_candidate` лучше использовать 5 минут, не 90 секунд:

```ts
const acceptedAtMs = Date.parse(refreshed.firstSpawnAcceptedAt ?? '');
const elapsedMs = Number.isFinite(acceptedAtMs) ? Date.now() - acceptedAtMs : 0;
if (
  runtime?.livenessKind === 'runtime_process_candidate' &&
  elapsedMs < MEMBER_BOOTSTRAP_STALL_MS
) {
  return;
}
```

## Runtime snapshot and memory display

`getTeamAgentRuntimeSnapshot()` сейчас выбирает `rssPid = liveRuntimeMember?.pid ?? liveRuntimeMember?.metricsPid`. Это нормально для сбора метрики, но UI должен знать источник.

Правило:

- `pidSource = tmux_pane` + `livenessKind = shell_only` -> memory is shell/pane RSS, не runtime RSS.
- `pidSource = tmux_child` или `agent_process_table` -> memory is runtime process RSS.
- OpenCode shared host `metricsPid` -> показать как shared host, не как member-owned runtime.
- `launchSnapshotAlive` сейчас может сделать `alive: true`, если persisted launch member был `runtimeAlive` или `bootstrapConfirmed`. После изменения это надо разделить:
  - `historicallyConfirmedBootstrap` - для display/history.
  - `alive` - только свежий live runtime или свежий heartbeat lease.

Добавить в `TeamAgentRuntimeEntry`:

```ts
runtimeDiagnostic?: string;
pidSource?: TeamAgentRuntimePidSource;
paneCurrentCommand?: string;
historicalBootstrapConfirmed?: boolean;
runtimeLastSeenAt?: string;
```

UI tooltip может объяснить:

```text
RSS source: tmux pane shell
PID: 26691
Command: zsh
Runtime process: not found
Bootstrap: no check-in yet
```

## Restartability semantics

Файлы:

- `src/main/services/team/TeamProvisioningService.ts`
- `src/renderer/components/team/members/MemberDetailDialog.tsx`

Важно не смешать `alive` и `restartable`.

`shell_only` должен быть `alive: false`, но часто должен оставаться `restartable: true`, если есть `tmuxPaneId`. Иначе пользователь увидит `shell only`, но не сможет нажать Restart.

Rules:

- `confirmed_bootstrap` / `runtime_process` with member-owned PID -> `alive: true`, `restartable: true`.
- `shell_only` with `tmuxPaneId` -> `alive: false`, `restartable: true`, restart kills pane.
- `registered_only` without PID/pane -> `alive: false`, `restartable: false`.
- OpenCode shared host `metricsPid` -> `restartable: false` unless adapter owns a member lane stop/restart path.
- `in-process` -> keep `restartable: false`.

`restartMember()` already kills persisted tmux panes via `killTmuxPaneForCurrentPlatformSync(paneId)`, so strict liveness should not remove pane ids from runtime snapshot just because they are weak evidence.

Test:

```ts
expect(shellOnlyRuntimeEntry).toMatchObject({
  alive: false,
  restartable: true,
  livenessKind: 'shell_only',
  pidSource: 'tmux_pane',
});
```

## IPC/store implications

Файлы:

- `src/main/ipc/teams.ts`
- `src/renderer/store/index.ts`
- `src/renderer/store/slices/teamSlice.ts`
- `src/renderer/components/team/TeamDetailView.tsx`

IPC уже возвращает `TeamAgentRuntimeSnapshot`, значит новый контракт проходит без нового channel. Но store equality обязательно надо обновить:

```ts
function areTeamAgentRuntimeEntriesEqual(
  left: TeamAgentRuntimeEntry | undefined,
  right: TeamAgentRuntimeEntry | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  return (
    left.memberName === right.memberName &&
    left.alive === right.alive &&
    left.restartable === right.restartable &&
    left.backendType === right.backendType &&
    left.pid === right.pid &&
    left.runtimeModel === right.runtimeModel &&
    left.rssBytes === right.rssBytes &&
    left.livenessKind === right.livenessKind &&
    left.pidSource === right.pidSource &&
    left.paneCurrentCommand === right.paneCurrentCommand &&
    left.runtimeDiagnostic === right.runtimeDiagnostic &&
    left.runtimeDiagnosticSeverity === right.runtimeDiagnosticSeverity &&
    left.runtimeLastSeenAt === right.runtimeLastSeenAt
  );
}
```

Если не сделать это, backend может правильно вычислять `shell_only`, а UI продолжит показывать старую карточку из-за suppressed store update.

Нужно обновить и spawn equality:

```ts
function areMemberSpawnStatusEntriesEqual(
  left: MemberSpawnStatusEntry | undefined,
  right: MemberSpawnStatusEntry | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  return (
    // existing visible fields
    left.status === right.status &&
    left.launchState === right.launchState &&
    left.error === right.error &&
    left.hardFailureReason === right.hardFailureReason &&
    left.livenessSource === right.livenessSource &&
    left.runtimeAlive === right.runtimeAlive &&
    left.runtimeModel === right.runtimeModel &&
    left.bootstrapConfirmed === right.bootstrapConfirmed &&
    left.hardFailure === right.hardFailure &&
    // new visible diagnostic fields
    left.livenessKind === right.livenessKind &&
    left.runtimeDiagnostic === right.runtimeDiagnostic &&
    left.runtimeDiagnosticSeverity === right.runtimeDiagnosticSeverity
  );
}
```

Summary equality:

```ts
function areLaunchSummaryCountsEqual(
  left: PersistedTeamLaunchSummary | undefined,
  right: PersistedTeamLaunchSummary | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  return (
    left.confirmedCount === right.confirmedCount &&
    left.pendingCount === right.pendingCount &&
    left.failedCount === right.failedCount &&
    left.runtimeAlivePendingCount === right.runtimeAlivePendingCount &&
    left.shellOnlyPendingCount === right.shellOnlyPendingCount &&
    left.runtimeProcessPendingCount === right.runtimeProcessPendingCount &&
    left.runtimeCandidatePendingCount === right.runtimeCandidatePendingCount &&
    left.noRuntimePendingCount === right.noRuntimePendingCount &&
    left.permissionPendingCount === right.permissionPendingCount
  );
}
```

Event handling:

```ts
if (event.type === 'member-spawn') {
  if (isStaleRuntimeEvent) return;
  seedCurrentRunIdIfMissing();
  scheduleMemberSpawnStatusesRefresh(event.teamName);
  scheduleTeamAgentRuntimeRefresh(event.teamName);
  return;
}
```

If `scheduleTeamAgentRuntimeRefresh()` does not exist, add a small debounced variant mirroring `scheduleMemberSpawnStatusesRefresh()`.

Polling:

- `TeamSpawnStatusWatcher` - 2.5 sec.
- `TeamAgentRuntimeWatcher` - 5 sec.
- Backend runtime metadata cache TTL is 2 sec.

Для launch UI лучше продублировать короткий `livenessKind/runtimeDiagnostic` в `MemberSpawnStatusEntry`, а подробные PID/command детали оставить в runtime snapshot. Тогда badge меняется быстро, tooltip догоняет через runtime snapshot.

Cache invalidation checklist:

- invalidate `agentRuntimeSnapshotCache` and `liveTeamAgentRuntimeMetadataCache` on runtime check-in;
- invalidate on heartbeat;
- invalidate on member restart/stop/remove;
- invalidate when tmux pane kill succeeds;
- invalidate when launch state store writes a new liveness diagnostic.

Without this, a member can remain visually `shell only` for up to the polling interval after a valid check-in, which is acceptable, but not after an explicit check-in event.

## API/preload propagation

No new IPC channel is needed, but the type propagation still has sharp edges.

Files to verify:

- `src/shared/types/team.ts`
- `src/shared/types/api.ts`
- `src/preload/index.ts`
- `src/renderer/api/httpClient.ts`
- `src/renderer/store/slices/teamSlice.ts`

Rules:

- New fields on `TeamAgentRuntimeEntry`, `MemberSpawnStatusEntry` and `PersistedTeamLaunchSummary` must be optional at first.
- `src/preload/index.ts` can keep the same `invokeIpcWithResult<TeamAgentRuntimeSnapshot>()` calls.
- `src/shared/types/api.ts` should not need method signature changes, but typecheck must prove it.
- `src/renderer/api/httpClient.ts` browser fallback must still return valid snapshots when new fields are absent.
- Renderer helpers must tolerate `undefined` `livenessKind` and map it to current behavior.

Recommended type compatibility test:

```ts
const snapshot: TeamAgentRuntimeSnapshot = {
  teamName: 'demo',
  updatedAt: new Date().toISOString(),
  runId: null,
  members: {
    bob: {
      memberName: 'bob',
      alive: false,
      restartable: true,
      livenessKind: 'shell_only',
      pidSource: 'tmux_pane',
      paneCurrentCommand: 'zsh',
      updatedAt: new Date().toISOString(),
    },
  },
};
```

This catches accidental required fields before runtime.

## Progress diagnostics update path

`updateProgress()` currently accepts only:

```ts
Pick<
  TeamProvisioningProgress,
  'pid' | 'error' | 'warnings' | 'cliLogsTail' | 'configReady' | 'messageSeverity'
>;
```

If `launchDiagnostics` is added to `TeamProvisioningProgress`, `updateProgress()` must accept it explicitly:

```ts
extras?: Pick<
  TeamProvisioningProgress,
  | 'pid'
  | 'error'
  | 'warnings'
  | 'cliLogsTail'
  | 'configReady'
  | 'messageSeverity'
  | 'launchDiagnostics'
>
```

And keep it bounded:

```ts
launchDiagnostics: boundLaunchDiagnostics(
  extras?.launchDiagnostics ?? run.progress.launchDiagnostics
),
```

Do not store this as `assistantOutput`. `assistantOutput` is rendered as markdown and is the wrong surface for machine-produced liveness facts.

## Renderer UX

### Member card labels

Файлы:

- `src/renderer/utils/memberHelpers.ts`
- `src/renderer/components/team/members/MemberCard.tsx`
- `src/renderer/utils/memberRuntimeSummary.ts`

Новые visual states:

```ts
export type MemberLaunchVisualState =
  | 'waiting'
  | 'spawning'
  | 'permission_pending'
  | 'waiting_bootstrap'
  | 'shell_only'
  | 'runtime_candidate'
  | 'registered_only'
  | 'stale_runtime'
  | 'error'
  | null;
```

Mapping:

```ts
function resolveLaunchVisualState(params: {
  spawnStatus?: MemberSpawnStatusEntry;
  runtimeEntry?: TeamAgentRuntimeEntry;
}): MemberLaunchVisualState {
  const { spawnStatus, runtimeEntry } = params;

  if (spawnStatus?.launchState === 'failed_to_start') return 'error';
  if (spawnStatus?.launchState === 'runtime_pending_permission') return 'permission_pending';

  if (runtimeEntry?.livenessKind === 'shell_only') return 'shell_only';
  if (runtimeEntry?.livenessKind === 'runtime_process_candidate') return 'runtime_candidate';
  if (runtimeEntry?.livenessKind === 'registered_only') return 'registered_only';
  if (runtimeEntry?.livenessKind === 'stale_metadata') return 'stale_runtime';

  if (
    spawnStatus?.launchState === 'runtime_pending_bootstrap' &&
    runtimeEntry?.livenessKind === 'runtime_process'
  ) {
    return 'waiting_bootstrap';
  }

  return spawnStatus?.status === 'spawning' ? 'spawning' : 'waiting';
}
```

Labels:

```ts
const MEMBER_LAUNCH_LABELS: Record<Exclude<MemberLaunchVisualState, null>, string> = {
  waiting: 'starting',
  spawning: 'starting',
  permission_pending: 'permission',
  waiting_bootstrap: 'waiting for bootstrap',
  shell_only: 'shell only',
  runtime_candidate: 'process candidate',
  registered_only: 'registered',
  stale_runtime: 'stale runtime',
  error: 'spawn failed',
};
```

Текущий `MemberCard` не принимает `runtimeEntry`, поэтому надо изменить props:

```ts
interface MemberCardProps {
  // existing
  runtimeEntry?: TeamAgentRuntimeEntry;
  spawnEntry?: MemberSpawnStatusEntry;
}
```

И передавать из `MemberList`:

```tsx
<MemberCard
  // existing
  runtimeEntry={isRemoved ? undefined : runtimeEntry}
  spawnEntry={isRemoved ? undefined : spawnEntry}
/>
```

Затем `buildMemberLaunchPresentation()` должен принимать `runtimeEntry` или хотя бы `livenessKind`:

```ts
const launchPresentation = buildMemberLaunchPresentation({
  member,
  spawnStatus,
  spawnLaunchState,
  spawnLivenessSource,
  spawnRuntimeAlive,
  runtimeEntry,
  runtimeAdvisory: member.runtimeAdvisory,
  isLaunchSettling,
  isTeamAlive,
  isTeamProvisioning,
  leadActivity,
});
```

То же нужно для `MemberDetailHeader` и `MemberHoverCard`, иначе список и detail view будут расходиться по labels.

### Tooltip

Tooltip examples:

```text
bob
Spawn accepted: yes
Registered in config: yes
Runtime: tmux pane alive, foreground command is zsh
Runtime process: not found
PID source: tmux pane
Bootstrap: no member_briefing/check-in yet
```

```text
alice
Spawn accepted: yes
Runtime: verified process detected
PID source: tmux child
Bootstrap: waiting for member_briefing/check-in
```

```text
tom
Spawn accepted: yes
Runtime: not found after 90s
Bootstrap: no check-in
Last error: Teammate did not join within the launch grace window.
```

### Launch banner

Файл: `src/renderer/utils/teamProvisioningPresentation.ts`

Generic:

```text
4 teammates still joining
```

Заменить на aggregate detail:

```text
4 teammates still joining - 3 shell-only, 1 waiting for bootstrap
```

Helper:

```ts
function summarizePendingLaunchDiagnostics(params: {
  statuses: Record<string, MemberSpawnStatusEntry>;
  runtimeEntries: Record<string, TeamAgentRuntimeEntry> | undefined;
}): string | null {
  const counts = {
    shellOnly: 0,
    waitingBootstrap: 0,
    candidate: 0,
    permission: 0,
    noRuntime: 0,
  };

  for (const [memberName, status] of Object.entries(params.statuses)) {
    if (status.launchState === 'confirmed_alive' || status.launchState === 'failed_to_start') {
      continue;
    }

    const runtimeEntry = params.runtimeEntries?.[memberName];
    if (status.launchState === 'runtime_pending_permission') counts.permission += 1;
    else if (runtimeEntry?.livenessKind === 'shell_only') counts.shellOnly += 1;
    else if (runtimeEntry?.livenessKind === 'runtime_process') counts.waitingBootstrap += 1;
    else if (runtimeEntry?.livenessKind === 'runtime_process_candidate') counts.candidate += 1;
    else counts.noRuntime += 1;
  }

  const parts = [
    counts.shellOnly ? `${counts.shellOnly} shell-only` : '',
    counts.waitingBootstrap ? `${counts.waitingBootstrap} waiting for bootstrap` : '',
    counts.candidate ? `${counts.candidate} process candidates` : '',
    counts.permission ? `${counts.permission} awaiting permission` : '',
    counts.noRuntime ? `${counts.noRuntime} no runtime found` : '',
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(', ') : null;
}
```

Сейчас `buildTeamProvisioningPresentation()` принимает только spawn statuses/snapshot, не runtime entries. Есть три варианта:

1. Добавить `runtimeSnapshot?: TeamAgentRuntimeSnapshot` в `buildTeamProvisioningPresentation()`.
   🎯 8 🛡️ 8 🧠 5 Примерно 80-130 строк.

2. Дублировать aggregate diagnostic counts в `MemberSpawnStatusesSnapshot.summary`.
   🎯 9 🛡️ 9 🧠 6 Примерно 120-190 строк.

3. Использовать только `progress.message`.
   🎯 6 🛡️ 5 🧠 3 Примерно 30-60 строк.

Рекомендую 2: backend уже лучше знает truth model и может атомарно отдать `shellOnlyCount`, `runtimeProcessPendingCount`, `candidateCount`, `noRuntimeCount`. UI тогда не зависит от race между 2.5 sec spawn polling и 5 sec runtime polling.

Расширить summary:

```ts
export interface PersistedTeamLaunchSummary {
  confirmedCount: number;
  pendingCount: number;
  failedCount: number;
  // Compatibility aggregate only. Do not use as process evidence in UI.
  runtimeAlivePendingCount: number;
  shellOnlyPendingCount?: number;
  runtimeProcessPendingCount?: number;
  runtimeCandidatePendingCount?: number;
  noRuntimePendingCount?: number;
  permissionPendingCount?: number;
}
```

### Stepper semantics

Файл: `src/renderer/components/team/provisioningSteps.ts`

The current stepper uses:

- `heartbeatConfirmedCount`
- `processOnlyAliveCount`
- `pendingSpawnCount`
- `failedSpawnCount`

After strict liveness, `processOnlyAliveCount` must mean **strong runtime process only**. It must not include:

- `shell_only`
- `runtime_process_candidate`
- `registered_only`
- `stale_metadata`
- `permission_blocked`

Mapping:

```ts
if (entry.launchState === 'runtime_pending_bootstrap') {
  if (entry.runtimeAlive === true && entry.livenessKind === 'runtime_process') {
    processOnlyAliveCount += 1;
  } else {
    pendingSpawnCount += 1;
  }
}
```

Why this matters: the screenshot problem is exactly the UI being stuck on "Members joining". Shell-only should remain in joining until it fails, while verified process can move toward finalizing but still show `waiting for bootstrap`.

### Copy diagnostics

Добавить в launch details или member tooltip маленькое действие `Copy diagnostics`.

Payload:

```ts
interface MemberLaunchDiagnosticsPayload {
  teamName: string;
  memberName: string;
  launchState?: MemberLaunchState;
  spawnStatus?: MemberSpawnStatus;
  livenessKind?: TeamAgentRuntimeLivenessKind;
  livenessSource?: MemberSpawnLivenessSource;
  pid?: number;
  pidSource?: TeamAgentRuntimePidSource;
  paneId?: string;
  panePid?: number;
  paneCurrentCommand?: string;
  processCommand?: string;
  runtimeDiagnostic?: string;
  diagnostics?: string[];
  updatedAt?: string;
}
```

Это поможет быстро понять проблему на скрине друга без доступа к его машине.

## Файлы для изменения

Backend/shared:

- `src/shared/types/team.ts`
  - добавить liveness/pid source типы;
  - расширить `TeamAgentRuntimeEntry`;
  - добавить компактные diagnostic fields в `MemberSpawnStatusEntry`.
  - добавить bounded `TeamLaunchDiagnosticItem` и `TeamProvisioningProgress.launchDiagnostics`.

- `src/main/services/team/TeamRuntimeLivenessResolver.ts`
  - вынести pure liveness classification;
  - принимать tmux/process/OpenCode/persisted facts;
  - возвращать strong/weak classification и sanitized diagnostics.

- `src/features/tmux-installer/main/infrastructure/runtime/TmuxPlatformCommandExecutor.ts`
  - добавить `listPaneRuntimeInfo()`;
  - добавить `listRuntimeProcesses()` или equivalent;
  - оставить `listPanePids()` совместимым wrapper.

- `src/features/tmux-installer/main/composition/runtimeSupport.ts`
  - экспортировать `listTmuxPaneRuntimeInfoForCurrentPlatform()`;
  - экспортировать process table helper, если он живет в tmux runtime executor.

- `src/main/services/team/TeamProvisioningService.ts`
  - расширить `LiveTeamAgentRuntimeMetadata`;
  - parse sanitized runtime tool `metadata`;
  - добавить strict evidence helpers;
  - использовать `TeamRuntimeLivenessResolver`;
  - обновить `updateProgress()` extras для `launchDiagnostics`;
  - переписать tmux/process resolution;
  - убрать strong `online/process` shortcut из `already_running`;
  - исправить `attachLiveRuntimeMetadataToStatuses()`;
  - исправить `reevaluateMemberLaunchStatus()`;
  - invalidate runtime caches на check-in/heartbeat/restart/stop;
  - прокинуть diagnostics в `getTeamAgentRuntimeSnapshot()`.

- `src/main/services/team/TeamLaunchStateEvaluator.ts`
  - нормализовать persisted liveness diagnostic fields;
  - считать optional diagnostic counts в summary;
  - не превращать stale persisted `runtimeAlive` в live proof.

- `src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter.ts`
  - не считать `created` bridge member strong alive без `runtimePid`;
  - сохранить `runtimePid` и `sessionId` в persisted launch state.

- `src/main/services/team/runtime/TeamRuntimeAdapter.ts`
  - расширить `TeamRuntimeMemberLaunchEvidence` полями `livenessKind`, `pidSource`, `runtimeDiagnostic`;
  - сохранить backward compatibility для существующих adapters.

- `src/main/services/team/progressPayload.ts`
  - добавить `boundLaunchDiagnostics()` и не расширять raw log tails.

- `src/shared/types/api.ts`
  - проверить, что existing `getMemberSpawnStatuses()` и `getTeamAgentRuntime()` contracts не требуют нового channel.

- `src/preload/index.ts`
  - оставить существующие IPC methods, убедиться typecheck проходит с optional fields.

- `src/renderer/api/httpClient.ts`
  - browser fallback должен оставаться valid при отсутствующих diagnostic fields.

- `src/renderer/store/slices/teamSlice.ts`
  - обновить `areTeamAgentRuntimeEntriesEqual()`;
  - обновить `areMemberSpawnStatusEntriesEqual()`;
  - обновить `areLaunchSummaryCountsEqual()`;
  - убедиться, что runtime diagnostic changes не suppress-ятся.

- `src/renderer/store/index.ts`
  - на `member-spawn` event обновлять и spawn statuses, и runtime snapshot.

Renderer:

- `src/renderer/utils/memberHelpers.ts`
  - добавить visual states и labels.

- `src/renderer/utils/memberRuntimeSummary.ts`
  - memory summary должен учитывать `pidSource`.

- `src/renderer/components/team/members/MemberList.tsx`
  - передать `runtimeEntry` и `spawnEntry` в presentation/member card layer.

- `src/renderer/components/team/members/MemberCard.tsx`
  - badge + tooltip + copy diagnostics.

- `src/renderer/components/team/members/MemberDetailHeader.tsx`
  - использовать тот же launch presentation contract, что и card.

- `src/renderer/components/team/members/MemberHoverCard.tsx`
  - не отставать от list/card labels.

- `src/renderer/utils/teamProvisioningPresentation.ts`
  - aggregate launch diagnostics.

- `src/renderer/components/team/provisioningSteps.ts`
  - `processOnlyAliveCount` считать только для strong runtime process.

- `src/renderer/components/team/ProvisioningProgressBlock.tsx`
  - добавить компактный Diagnostics disclosure для `launchDiagnostics`.

## Tests

Backend:

- `TeamRuntimeLivenessResolver.test.ts`
  - tmux foreground shell + no child -> `shell_only`;
  - verified process row by `--team-name` + `--agent-id` -> `runtime_process`;
  - non-shell descendant without identity -> `runtime_process_candidate`;
  - persisted PID without current process identity -> `stale_metadata`;
  - process command secrets are redacted in diagnostics;
  - provider failure diagnostic does not produce strong alive.

- `TeamProvisioningService.test.ts`
  - tmux shell-only pane не ставит `runtimeAlive`;
  - shell-only после 90 секунд становится `failed_to_start`;
  - stale persisted `tmuxPaneId` не self-clear-ит failure;
  - verified process by `--team-name` + `--agent-id` ставит `runtimeAlive`;
  - runtime process candidate не считается strong alive;
  - OpenCode `created` без `runtimePid` не ставит `runtimeAlive`;
  - OpenCode `created` с `runtimePid` ставит `runtimeAlive`;
  - OpenCode `sessionId` без `runtimePid` становится `runtime_process_candidate`, а не strong alive;
  - `runtime_bootstrap_checkin` сохраняет `runtimeSessionId`, `livenessKind: "confirmed_bootstrap"`;
  - stale runtime heartbeat от old `runId` rejected и не меняет launch state;
  - runtime metadata PID без process identity не становится strong alive;
  - `already_running` + shell-only не ставит `runtimeAlive`;
  - permission blocked остается pending permission, не hard fail.

- `TmuxPlatformCommandExecutor.test.ts`
  - `listPaneRuntimeInfo()` парсит `pane_current_command`;
  - `listPanePids()` остается совместимым pane-existence helper;
  - process table parser поддерживает `pid`, `ppid`, `command`;
  - WSL branch не использует host process table.

Renderer:

- `memberHelpers.test.ts`
  - `shell_only` -> `shell only`;
  - `runtime_process` + pending bootstrap -> `waiting for bootstrap`;
  - `runtime_process_candidate` -> `process candidate`;
  - permission state не затирается runtime diagnostics.

- `memberRuntimeSummary.test.ts`
  - `2 MB` с `pidSource=tmux_pane` получает tooltip/source `tmux pane shell`;
  - runtime child показывает обычный runtime memory.

- `teamSlice.test.ts`
  - изменение `livenessKind` обновляет `teamAgentRuntimeByTeam`;
  - изменение `runtimeDiagnostic` обновляет `teamAgentRuntimeByTeam`.
  - изменение spawn `livenessKind/runtimeDiagnostic` обновляет `memberSpawnStatusesByTeam`;
  - изменение optional summary diagnostic counts обновляет presentation.
  - `member-spawn` event schedules both spawn status refresh and runtime snapshot refresh.

- `httpClient.test.ts`
  - browser fallback `getTeamAgentRuntime()` remains valid without diagnostic fields;
  - browser fallback `getMemberSpawnStatuses()` remains valid without summary diagnostic counts.

- `teamProvisioningPresentation.test.ts`
  - banner показывает `3 shell-only, 1 waiting for bootstrap`;
  - pending permission получает отдельный count.

- `provisioningSteps.test.ts`
  - `shell_only` не увеличивает `processOnlyAliveCount`;
  - `runtime_process_candidate` не увеличивает `processOnlyAliveCount`;
  - `runtime_process` увеличивает `processOnlyAliveCount`.

- `ProvisioningProgressBlock.test.tsx`
  - renders bounded `launchDiagnostics`;
  - does not require opening CLI logs to see `shell only`;
  - long process command is truncated/sanitized.

## Phases

### Phase 0 - Diagnostics without behavior change

🎯 10 🛡️ 10 🧠 4 Примерно 180-260 строк.

Добавить новые optional fields и заполнить `livenessKind`, `pidSource`, `paneCurrentCommand`, `diagnostics`, но пока не менять timeout behavior.

Цель: увидеть на реальном launch, что именно определяется у друга: shell-only, process candidate, stale metadata или OpenCode bridge claim.

Add:

- `TeamRuntimeLivenessResolver` pure tests;
- process table/tmux providers;
- strict-only runtime evidence flow without a runtime-mode switch.

Verification:

```bash
pnpm typecheck
pnpm exec vitest run test/main/features/tmux-installer test/main/services/team/TeamProvisioningService.test.ts
```

### Phase 1 - Strict strong evidence

🎯 9 🛡️ 9 🧠 7 Примерно 220-320 строк.

Переключить `attachLiveRuntimeMetadataToStatuses()` на strong evidence only. Shell/pane/candidate больше не выставляют `runtimeAlive`.

Verification:

```bash
pnpm exec vitest run test/main/services/team/TeamProvisioningService.test.ts
```

### Phase 2 - Timeout and self-heal hardening

🎯 9 🛡️ 9 🧠 6 Примерно 120-180 строк.

Исправить `reevaluateMemberLaunchStatus()`:

- shell-only/no-runtime/stale -> fail after 90s;
- permission -> stay pending permission;
- candidate -> warning, fail after 5 min;
- verified runtime -> warning, no false hard fail at 90s;
- auto-clear failure только по strong evidence.

### Phase 3 - UI visibility

🎯 9 🛡️ 8 🧠 6 Примерно 220-320 строк.

Добавить:

- labels `shell only`, `waiting for bootstrap`, `process candidate`;
- tooltip;
- aggregate banner detail;
- copy diagnostics.

### Phase 4 - Real launch validation

🎯 8 🛡️ 9 🧠 6 Примерно 100-180 строк тестовых fixtures/scripts.

Manual checks:

```bash
tmux list-panes -a -F '#{pane_id} #{pane_pid} #{pane_current_command}'
ps -ax -o pid=,ppid=,command= | rg '<team-name>|<agent-id>|claude|codex|opencode'
```

Scenarios:

1. Успешный Anthropic tmux launch.
2. Shell-only pane.
3. Missing MCP/member_briefing.
4. Permission pending.
5. OpenCode bridge member without `runtimePid`.
6. OpenCode bridge member with `runtimePid`.
7. Restart member while old pane exists.

## Acceptance criteria

1. Tmux pane жив, foreground command `zsh/bash/sh`, runtime child не найден:
   - `TeamAgentRuntimeEntry.alive === false`
   - `livenessKind === "shell_only"`
   - `pidSource === "tmux_pane"`
   - UI показывает `shell only`
   - после 90 секунд member становится `failed_to_start`

2. Найден process с `--team-name <team> --agent-id <id>`:
   - `TeamAgentRuntimeEntry.alive === true`
   - `livenessKind === "runtime_process"`
   - `MemberSpawnStatusEntry.runtimeAlive === true`
   - UI показывает `waiting for bootstrap`, если bootstrap еще не пришел

3. Member сделал check-in:
   - `bootstrapConfirmed === true`
   - `livenessKind === "confirmed_bootstrap"`
   - `launchState === "confirmed_alive"`
   - UI показывает `ready`

4. Persisted metadata есть, process не найден:
   - не self-clear failure;
   - не `runtimeAlive`;
   - UI показывает `stale runtime` или `registered`.

5. OpenCode bridge вернул member без `runtimePid`:
   - `agentToolAccepted === true`;
   - `runtimeAlive === false`;
   - UI показывает pending/bridge diagnostics, не `online`.

6. `2.0 MB` больше не выглядит как полноценный runtime:
   - tooltip объясняет `RSS source: tmux pane shell`;
   - launch badge показывает `shell only`.

7. Launch details объясняет stuck state без открытия logs:
   - `launchDiagnostics` содержит bounded rows;
   - UI показывает хотя бы `shell only`, `waiting for bootstrap`, `no runtime found`;
   - `cliLogsTail` и `assistantOutput` остаются bounded.

8. Store suppression не скрывает диагностику:
   - изменение `livenessKind` меняет renderer state;
   - изменение summary diagnostic counts меняет presentation;
   - `member-spawn` event refreshes runtime snapshot.

9. Rollout безопасен:
   - strict behavior включен по умолчанию;
   - diagnostics UI остается доступным без отдельного mode flag;
   - rollback требует явного code revert или отдельного follow-up setting.

10. Provider failures не создают ложный ready:

- process table failure дает `process_table_unavailable`;
- tmux/process provider failure не self-clear-ит failure;
- command diagnostics sanitized and truncated.

## Main risks

### False negative для реального runtime

Если реальный teammate не содержит `--team-name`/`--agent-id` в command, strict model может понизить его до candidate.

Mitigation:

- Phase 0 сначала собирает diagnostics без behavior change.
- Candidate не fail-ится за 90 секунд.
- Allowlist runtime command markers добавлять только после реальных данных.

### Windows/WSL process tree

Host-side process table не увидит Linux tmux descendants.

Mitigation:

- process table должен жить рядом с tmux executor;
- Windows branch должен запускать `ps` внутри WSL distro.

### OpenCode shared host

Один OpenCode host PID может обслуживать несколько members.

Mitigation:

- `runtimePid` хранить как `metricsPid`, если это shared host;
- `restartable=false`, если PID не member-owned;
- UI label `shared OpenCode host`, не "member runtime".

### UI overload

Слишком много деталей в карточке сделают интерфейс шумным.

Mitigation:

- короткий badge в карточке;
- детали в tooltip;
- aggregate counts в banner;
- полный JSON только через copy diagnostics.

### Process command privacy

`ps` command can include cwd, file paths, API keys or tokens.

Mitigation:

- identity matching uses raw command only inside main process memory;
- UI/logs/copy diagnostics receive sanitized command only;
- redact common secret flags;
- truncate command strings to 500 chars;
- do not include raw runtime tool metadata.

### Process table overhead

Reading `ps` per member would be wasteful and flaky on large systems.

Mitigation:

- read process table once per runtime snapshot;
- keep existing 2 sec backend cache TTL;
- do not call `pidusage` for weak shell-only rows unless UI needs memory display;
- cap diagnostics to 20 progress rows.

## Minimal safe patch order

1. Добавить типы и optional fields.
2. Добавить sanitized runtime tool metadata parser.
3. Добавить tmux `listPaneRuntimeInfo()` и сохранить wrapper `listPanePids()`.
4. Добавить process table provider/parser с `ppid`.
5. Вынести `TeamRuntimeLivenessResolver`.
6. Заполнить `livenessKind`.
7. Написать backend tests на shell-only, verified runtime, stale event, metadata PID.
8. Переключить `attachLiveRuntimeMetadataToStatuses()` на strong evidence.
9. Исправить `already_running` shortcut.
10. Переключить timeout/self-heal logic на strong evidence.
11. Исправить OpenCode bridge mapping.
12. Обновить persisted summary diagnostics и store equality.
13. Добавить `launchDiagnostics` в progress payload и UI disclosure.
14. Добавить renderer labels/tooltips/banner.
15. Добавить copy diagnostics.
16. Manual validation: создать команду, проверить pending names, runtime diagnostics и отсутствие false-ready shell-only процесса.

## Expected UX

Before:

```text
bob   starting   2.0 MB
jack  starting   2.0 MB
tom   starting   2.0 MB
```

After:

```text
bob   shell only             Anthropic · Opus 4.7 · 2.0 MB
jack  waiting for bootstrap  Anthropic · Opus 4.7 · 418 MB
tom   spawn failed           no runtime process after 90s
```

Launch banner:

```text
4 teammates still joining - 3 shell-only, 1 waiting for bootstrap
```

Tooltip for shell-only:

```text
Spawn accepted: yes
Registered in config: yes
Runtime process: not found
Tmux pane: alive
Foreground command: zsh
PID source: tmux pane
Bootstrap: no member_briefing/check-in yet
```
