# Member Log Stream V2 Research Addendum

## Scope

Этот документ углубляет места с самой низкой уверенностью из основного плана:

- OpenCode lane/session resolution;
- Codex native member-wide feasibility;
- Claude/member transcript attribution;
- parser/cache safety;
- architecture placement;
- renderer performance budget;
- oversized message/content budget;
- IPC validation and abuse limits;
- IPC registration/composition safety;
- exact stream DTO/render contract;
- cumulative subagent snapshot dedupe;
- OpenCode projection mapper extraction;
- message/window truncation semantics;
- member popup live refresh event policy;
- API shape между renderer, preload и main.

Вывод после code research: вариант 2 остается правильным, но детали нужно сделать строже. Особенно важно не использовать `findMemberLogPaths()` как основной источник и не вызывать OpenCode transcript без `laneId`, если lane уже известен.

## Executive Findings

| Зона | Было | Стало после research | Решение |
| --- | --- | --- | --- |
| Claude/member transcript | Уверенность высокая | Еще выше: есть готовый `findRecentMemberLogFileRefsByMember()` с mtime, sessionId и сортировкой | Использовать его, не `findMemberLogPaths()` |
| OpenCode lane | Средняя уверенность | `TeamMemberSnapshot` уже несет `providerBackendId/selectedFastMode/resolvedFastMode/laneId/laneKind/laneOwnerProviderId`, renderer получает это через spread | Типизировать `ResolvedTeamMember`, передавать `laneId` в `getMemberLogStream` и bridge |
| Codex native | Низкая уверенность | `readTaskRuns()` физически task-keyed, а projector keeps only native tool events | First PR skipped; partial trace only as separate phase with honest label |
| Parser cache | Средняя уверенность | `parseFiles()` вызывает `retainOnly()`, а `retainOnly()` чистит и cache, и `inFlight` entries | Держать отдельный parser instance для member stream |
| UI reuse | Средняя уверенность | `TaskLogStreamSection` содержит task-specific copy и loading logic | Вынести generic view, оставить source-specific containers |
| Architecture placement | Уверенность высокая | Feature standard прямо подходит: cross-process feature, own policy, transport wiring, more than one adapter, provider roadmap | Делать `src/features/member-log-stream` canonical slice, with thin app-shell integration |
| Render pressure | Низкая уверенность | `MemberExecutionLog` рендерит все groups и держит их expanded by default | Ограничивать backend response budget |
| IPC validation | Средняя уверенность | `laneId` содержит `:`, значит `validateMemberName` не подходит | Добавить отдельную optional lane validator |
| Cumulative subagent logs | Низкая уверенность | `findRecentMemberLogFileRefsByMember()` dedupe только by filePath, а subagent snapshots могут быть cumulative | Добавить/использовать ref metadata и dedupe by member/session/kind перед parse |
| OpenCode projection mapping | Средняя уверенность | Есть richer mapper в task source и lossy mapper в stall monitor | Вынести generic mapper из task source, не из stall monitor |
| Finder ref metadata | Средняя уверенность | Current refs не несут `kind`/`sizeBytes`, но full parse ради `messageCount` удвоит IO | Добавлять lightweight metadata и не считать `messageCount` полным parse |
| Renderer extraction | Средняя уверенность | `TaskLogStreamSection` смешивает generic stream view и task-specific copy/reload | Вынести `ExecutionLogStreamView`, оставить containers source-specific |
| Budget semantics | Низкая уверенность | `maxChunks` не ограничивает большой AI chunk с сотнями tool calls | Добавить message budget и pair-aware trimming before chunk build |
| Content budget | Низкая уверенность | One huge tool result can render through `DisplayItemList` even with low message count | Add content-char budgets before chunk build |
| Live refresh | Средняя уверенность | member stream не знает taskId, а `task-log-change` не несет memberName | Reload on same-team `log-source-change` and `task-log-change`, debounced |
| IPC composition | Уверенность высокая | `initializeTeamHandlers()` positional deps make legacy team IPC a bad owner for this feature | Register feature IPC through `@features/member-log-stream/main`, do not add service to team handlers |
| Browser fallback | Средняя уверенность | Browser API must satisfy feature API even without Electron IPC | Вернуть complete empty `MemberLogStreamResponse`, как task stream fallback |
| Historical members | Средняя уверенность | Finder attribution uses `knownMembers` from config/meta/inbox, not necessarily removed popup member | Add requested names to attribution set inside recent-ref finder |
| Finder options compatibility | Средняя уверенность | `findRecentMemberLogFileRefsByMember()` уже используется positional `mtimeSinceMs` callers | Add backward-compatible third-arg parser, not object-only signature |
| Lead transcript mtime window | Новая находка | `mtimeSinceMs` сейчас фильтрует candidates, но lead transcript добавляется до этого filter | Apply mtime window consistently to lead and candidate refs |
| Segment metadata | Средняя уверенность | `BoardTaskLogSegment` has no provider/session label, so mixed sources become opaque | Use `MemberLogStreamSegment.source` metadata without file paths |
| Segment render keys | Новая находка | Task stream key uses `participantKey:firstChunkId`, good for tail growth but risky across member sources | Generic view gets caller-provided segment key builder |
| Renderer reload pressure | Новая находка | Task stream drops stale responses by request seq but still allows parallel IPC calls | Member stream should coalesce in-flight reloads |
| Live tracking activation | Новая находка | `TaskLogStreamSection` subscribes, but `TaskLogsPanel` enables `TeamLogSourceTracker`; member popup has no equivalent parent | Add member stream tracking activation while popup section is mounted |
| IPC option strictness | Новая находка | `TEAM_GET_DATA` rejects unknown option keys before dispatch | Reject unknown member-stream option keys too |
| Participant/source identity | Новая находка | `BoardTaskLogParticipant` is actor identity, while provider/session/lane is source identity | Keep participant actor-based and render provider/session from `segment.source` |
| Since reload semantics | Новая находка | Renderer state replacement plus since-filtered partial response can hide older visible segments | First PR uses full bounded background reloads, not client-side incremental merge |
| Chunk date shape | Средняя уверенность | Renderer group transformer expects Date objects, while tests can use JSON-like fixtures | Keep task stream assumption, add shared normalizer only if needed |
| Parser in-flight ownership | Новая находка | Shared parser can delete another stream's active parse dedupe through `retainOnly()` | Parser ownership is per stream service unless cache API is redesigned |
| OpenCode mapper source | Новая находка | Stall-monitor mapper drops non-string content blocks and `toolUseResult` | Shared mapper source must be `OpenCodeTaskLogStreamSource` |
| Tracker activation | Новая находка | `TeamLogSourceTracker` uses team/consumer reference counts and only runs while consumers are active | Add `member_log_stream` consumer, not a member-specific watcher |
| Runtime lane validation | Новая находка | Existing member validator rejects `:`, but lane ids can be `secondary:opencode:<member>` | Add optional lane validator that preserves exact lane id |
| Generic renderer purity | Новая находка | `TaskLogStreamSection` mixes fetch/debounce/copy/render helpers | Extract render-only view and keep API/fallback/gates in containers |

## 0. Architecture Boundary Decision

### Repo Standard Tension

`docs/FEATURE_ARCHITECTURE_STANDARD.md` говорит, что full feature slice нужен, когда feature spans process boundaries, имеет business rules, transport bridge, more than one adapter и provider roadmap.

`Member Log Stream V2` подходит под этот стандарт:

- feature spans main/preload/renderer;
- feature owns merge, dedupe, budget and provider coverage policy;
- feature needs transport wiring;
- feature has multiple source adapters: Claude, OpenCode, Codex skipped/partial later;
- roadmap явно ведет к variant 3/provider extensibility.

Текущая реальность кода все еще важна:

- task stream уже живет в `src/main/services/team/taskLogs/stream`;
- member popup уже живет в `src/renderer/components/team/members`;
- team IPC уже централизован в `src/main/ipc/teams.ts`;
- `api.teams` уже содержит `getMemberLogs`, `getTaskLogStream`, `getLogsForTask`.

Поэтому правильная стратегия не "перетащить весь team logs слой", а создать feature slice для новой member stream capability and keep old surfaces as integration points.

### Options

#### A. Canonical feature slice with thin legacy integration

🎯 8.5   🛡️ 9   🧠 7  
Примерно 1500-2300 LOC.

Плюсы:

- соответствует feature standard;
- contracts/core/application/source ports становятся clean architecture boundary;
- provider sources расширяются по OCP;
- старый task stream and legacy `MemberLogsTab` не мигрируются в этом PR;
- app shell imports only public feature entrypoints.

Минусы:

- больше файлов и немного больше boilerplate;
- нужно аккуратно сделать compatibility with existing `MemberDetailDialog` and app API;
- нужно добавить import-boundary discipline from the start.

#### B. Legacy extension in current team services

🎯 7   🛡️ 6.5   🧠 5  
Примерно 550-850 LOC.

Плюсы:

- минимальный blast radius;
- ближе к существующему `Task Log Stream`;
- быстрее внедряется.

Минусы:

- легко получить большой `MemberLogStreamService` с provider-specific ветками;
- хуже соответствует feature architecture standard;
- future variant 3 будет сложнее выделять.

#### C. Existing team surface plus source ports

🎯 8   🛡️ 8   🧠 6  
Примерно 1300-2050 LOC, если включить ref metadata dedupe, mapper extraction, renderer shared view, member tracking activation, dialog-level fallback tests, OpenCode in-flight protection, renderer reload coalescing и provider-neutral message hygiene extraction.

Плюсы:

- renderer-facing API is feature-owned, for example `api.memberLogStream`; existing `api.teams` can remain only as a thin compatibility delegate if needed by current popup wiring;
- implementation остается рядом с existing `taskLogs/stream`;
- provider/runtime логика делится на отдельные source classes;
- часть будущей миграции к feature slice будет подготовлена.

Минусы:

- это все еще не full canonical feature slice;
- нужно дисциплинированно не смешать orchestration, provider IO и UI DTO в одном файле.

### Recommendation

Выбрать A для первого PR.

Правило:

- `src/features/member-log-stream/contracts` owns DTOs, channels, normalize helpers and API fragment types;
- `core/domain` owns pure policies: merge order, budget decisions, dedupe keys and coverage semantics;
- `core/application` owns `MemberLogStreamSource` ports and the use case;
- `main/adapters/output/sources` owns Claude/OpenCode/Codex source adapters;
- `main/adapters/input/ipc` owns validation and IPC translation;
- `preload` owns thin bridge;
- `renderer/ui` owns presentational components only;
- old `MemberLogsTab`, task stream and task exact logs are not migrated in this PR;
- if existing `api.teams` is needed for compatibility, it delegates to feature contracts/use case and does not own DTO/policy.

### Exact Standard Compliance

The feature should be reviewable against `docs/FEATURE_ARCHITECTURE_STANDARD.md` without special exceptions:

- `contracts/` owns only DTOs, API fragment types, channel constants and normalize helpers.
- `core/domain/` owns pure policies: source merge order, source coverage state, dedupe keys, budget decisions and safe source metadata.
- `core/application/` owns use cases and ports: `MemberLogStreamSource`, clock/logger/cache/tracking ports and response models.
- `main/composition/` wires concrete adapters and exposes `MemberLogStreamFeatureFacade`.
- `main/adapters/input/ipc/` owns IPC validation and transport translation.
- `main/adapters/output/sources/` owns Claude/OpenCode/Codex source adapters.
- `main/infrastructure/` owns runtime bridge helpers, parser wrappers, TTL/in-flight cache and filesystem details.
- `preload/` owns only a thin feature bridge.
- `renderer/hooks/` owns API calls, tracking activation, team-change subscriptions and reload coalescing.
- `renderer/ui/` owns presentational components only.

Clean Architecture dependency rule:

- domain imports no application/adapters/infrastructure/framework/process code;
- application imports no main/preload/renderer or concrete IO;
- adapters import inward to application/domain and outward to infrastructure;
- renderer UI receives props and view models, never direct API/store/Electron access;
- app shell imports only public entrypoints.

SOLID and DRY application:

- SRP: `GetMemberLogStreamUseCase` coordinates use case flow only; provider IO stays in source adapters; renderer UI only renders.
- OCP: adding Codex partial/full later means adding or swapping a source adapter, not rewriting renderer or use case branches.
- LSP: all sources honor the same `included | partial | skipped` result shape and fail softly for expected absence.
- ISP: core ports stay narrow. Do not pass `TeamDataService`, Electron events or renderer member snapshots through core.
- DIP: use cases depend on ports; concrete finder/bridge/parser implementations live outside core.
- DRY: one DTO owner in feature contracts, one stream render primitive, one OpenCode projection mapper, one provider-neutral message hygiene helper set.

Lint status:

- Generic feature guard rails already exist in `eslint.config.js` for `src/features/*`.
- Implementation should rely on those first and add member-log-stream-specific guard rails only if generic messages are not strict enough.
- Targeted lint command: `pnpm exec eslint src/features/member-log-stream --cache --cache-location .eslintcache --cache-strategy content`.

Project standard cross-check:

- Top-level `CLAUDE.md` says new medium/large features default to `src/features/<feature-name>` and must follow `docs/FEATURE_ARCHITECTURE_STANDARD.md`.
- `docs/FEATURE_ARCHITECTURE_STANDARD.md` requires the full slice when a feature spans process boundaries, owns business policy, has transport wiring, has multiple adapters or has a provider roadmap. Member log stream matches all five.
- `eslint.config.js` already enforces generic public-entrypoint, core-domain, core-application, preload and renderer-UI guards for `src/features/*`.
- `src/features/recent-projects` confirms the public entrypoint pattern: `contracts/index.ts`, `main/index.ts`, `preload/index.ts` and `renderer/index.ts` expose only supported surface.
- `src/features/CLAUDE.md` is referenced by `CLAUDE.md`, but is absent in this worktree, so the binding standard for this plan is the top-level `CLAUDE.md` plus `docs/FEATURE_ARCHITECTURE_STANDARD.md`.

## 0.1 Source-Port Design

Чтобы не нарушить SRP/OCP, `GetMemberLogStreamUseCase` не должен сам знать все детали Claude/OpenCode/Codex.

Нужен internal interface:

```ts
interface MemberLogStreamSourceInput {
  teamName: string;
  memberName: string;
  laneId?: string;
  budget: MemberLogStreamBudget;
  sinceMs?: number | null;
  forceRefresh?: boolean;
}

interface MemberLogStreamSourceResult {
  provider: MemberLogStreamProvider;
  status: 'included' | 'partial' | 'skipped';
  segments: MemberLogStreamSegment[];
  warnings: MemberLogStreamWarning[];
}

interface MemberLogStreamSource {
  readonly provider: MemberLogStreamProvider;
  load(input: MemberLogStreamSourceInput): Promise<MemberLogStreamSourceResult>;
}
```

First PR sources:

- `ClaudeMemberTranscriptStreamSource`;
- `OpenCodeMemberRuntimeStreamSource`;
- `CodexNativeMemberTraceStreamSource` only as skipped coverage adapter, no heavy trace scan.

`GetMemberLogStreamUseCase` responsibilities:

- normalize already-validated options;
- call sources fail-soft, preferably with `Promise.allSettled()` plus deterministic merge order;
- merge source results;
- enforce global budget;
- sort final segments;
- build response metadata and warnings.

It should not:

- parse OpenCode CLI output directly;
- scan Codex trace directories directly;
- know renderer copy;
- know old `MemberLogsTab` fallback details.

## 0.2 Renderer Performance Budget

### Facts

`MemberExecutionLog`:

- transforms all chunks into conversation groups;
- reverses all groups;
- renders all groups;
- keeps everything expanded by default unless user collapses groups;
- has no virtualization.

Repo already depends on `@tanstack/react-virtual`, and `ActivityTimeline` uses it. But adding virtualization to log stream in first PR would be a separate UI behavior project.

### Decision

Do not add virtualization in first PR.

Instead enforce backend budget:

```ts
const DEFAULT_MEMBER_LOG_STREAM_BUDGET = {
  maxTranscriptFiles: 40,
  maxSegments: 30,
  maxChunks: 250,
  maxSourceMessages: 1200,
  maxMessagesPerSegment: 300,
  maxTotalContentChars: 800_000,
  maxMessageContentChars: 80_000,
  maxToolResultContentChars: 120_000,
  openCodeMessageLimit: 400,
  openCodeTimeoutMs: 5_000,
};
```

Budget semantics:

- candidate transcript refs are newest-first before capping;
- source segments are sorted by timestamp before final response;
- global merge keeps newest useful content if sources exceed budget;
- message budget is enforced before chunk build when one file/session is too large;
- chunk budget is enforced after chunk build by dropping oldest whole chunks/segments first;
- response includes `truncated: true` and warning `large_log_window_limited` when any cap is hit;
- renderer shows a short "showing recent log stream" note from warnings.
- content-char budgets are enforced before chunk build so a single huge markdown/tool result cannot freeze the popup after expansion.

Why this is safer:

- prevents popup freezes;
- avoids new virtualization bugs;
- keeps v2 focused on correct data/source behavior.

Future:

- add `Load older` only after source cursor semantics exist;
- add virtualization only if product needs audit-sized member streams in popup.

## 0.2.1 Pair-Aware Truncation

### Facts

`ChunkBuilder` groups all "AI" category messages until the next real user/system/compact boundary. A single AI chunk can contain many assistant messages, tool calls and tool results.

So this is not enough:

```ts
maxChunks: 250
```

One chunk can still become a large `displayItems` list in `MemberExecutionLog`.

### Decision

Add message-level budget:

```ts
maxSourceMessages: 1200;
maxMessagesPerSegment: 300;
```

Truncation should happen in this order:

1. Dedupe transcript refs.
2. Sort candidate refs newest-first and cap files.
3. Parse selected files.
4. For each file/session, trim parsed messages before chunk build if it exceeds `maxMessagesPerSegment`.
5. Build chunks.
6. Drop oldest whole segments/chunks to satisfy `maxSegments`, `maxChunks`, and `maxSourceMessages`.

Pair-aware rule:

- if retaining a meta user tool-result message with `sourceToolUseID`, also retain the assistant message containing the matching `toolCalls.id`;
- if retaining the matching assistant would exceed the hard message budget, drop the orphan result instead of rendering an unpaired result;
- preserve chronological order after expansion;
- mark response `truncated: true`;
- add warning `segment_message_window_limited`.

Do not attempt text-level truncation inside `EnhancedChunk` in first PR. It is safer to drop old message windows than to mutate renderer-specific chunk internals.

## 0.2.3 Content-Size Budget

### Facts

`MemberExecutionLog` renders AI groups expanded by default. `DisplayItemList` previews are short, but expanded items can render full markdown/tool result content. So these budgets are not sufficient by themselves:

```ts
maxChunks: 250;
maxMessagesPerSegment: 300;
```

One tool result can still contain hundreds of thousands of characters.

### Decision

Add content budgets before chunk build:

```ts
maxTotalContentChars: 800_000;
maxMessageContentChars: 80_000;
maxToolResultContentChars: 120_000;
```

Rules:

- apply after message-window trimming and before `BoardTaskExactLogChunkBuilder.buildBundleChunks()`;
- preserve `uuid`, `sourceToolUseID`, `sourceToolAssistantUUID`, tool call ids and tool result ids;
- replace oversized text/content fields with a short placeholder that states the content was truncated for popup display;
- do not mutate file-backed parser cache arrays in place. Clone the affected `ParsedMessage` objects before truncating;
- set `truncated: true`;
- add warning `message_content_limited`.

Risk rating:

🎯 8   🛡️ 8   🧠 5  
Approx 120-220 LOC.

This is safer than relying on UI collapse/expand behavior, because the current execution log starts expanded.

## 0.2.4 ParsedMessage Hygiene Boundary

### Facts

`BoardTaskLogStreamService` already has useful private message hygiene helpers:

- `cloneBlock()`;
- `cloneMessageContent()`;
- `mergeMessages()`;
- `pruneEmptyInternalToolResultMessages()`;
- `retainSyntheticToolUseAssistants()`.

It also has task-specific cleanup:

- `sanitizeJsonLikeToolResultPayloads()`;
- `sanitizeToolResultContent()`;
- `sanitizeToolResultPayloadValue()`.

That task cleanup is not fully provider-neutral. It is designed around board/task tool payloads and can replace JSON-like tool result payloads with `''` when it cannot extract a board-tool display string. In member-wide logs, a JSON-looking tool result can be a legitimate Bash/API/tool output. Applying task cleanup wholesale would risk hiding useful member logs.

### Options

#### A. Reuse task sanitization as-is for member stream

🎯 5   🛡️ 4   🧠 3  
Approx 20-80 LOC.

Fast, but unsafe. It can hide useful non-board JSON outputs in a member-wide stream.

#### B. Extract provider-neutral hygiene and add member-specific truncation

🎯 8.5   🛡️ 9   🧠 6  
Approx 180-340 LOC.

Create a small shared main-process helper, for example:

```ts
src/main/services/team/taskLogs/stream/ParsedMessageStreamHygiene.ts
```

Provider-neutral exports:

- clone message/content blocks without mutating parser-cache objects;
- prune empty internal tool-result messages;
- retain synthetic tool-use assistants by clearing only the synthetic model marker;
- count/truncate message content by char budget;
- preserve `uuid`, `toolCalls.id`, `toolResults.toolUseId`, `sourceToolUseID`, `sourceToolAssistantUUID` and `toolUseResult.toolUseId`.

Keep board/task cleanup either private to `BoardTaskLogStreamService` or export it with a name that makes the scope explicit, such as `sanitizeBoardToolResultPayloads()`.

#### C. Skip content hygiene and rely only on message-window limits

🎯 6   🛡️ 5   🧠 2  
Approx 0-60 LOC.

Too weak. One retained tool result can still be huge.

### Decision

Use option B.

Implementation rules:

- do not run board-specific JSON payload cleanup across all member logs;
- truncate oversized strings/arrays recursively but preserve linking ids;
- when truncating `toolUseResult.content`, `toolUseResult.message`, `toolUseResult.file.content`, `oldString`, `newString`, or `stderr/stdout`, keep the surrounding object shape;
- replace text with a compact placeholder that includes original char count and retained char count;
- clone only changed messages to keep memory reasonable;
- test with a JSON Bash output to confirm it is truncated if huge but not blanked just because it is JSON.

Risk rating:

🎯 8.5   🛡️ 9   🧠 6  
Approx 180-340 LOC.

## 0.2.2 MemberExecutionLog Process Filtering

### Facts

`MemberExecutionLog` passes `memberName` into `AIExecutionGroup`.

`AIExecutionGroup` filters only `group.processes` by `p.team?.memberName`; it does not filter the raw AI steps or tool executions.

That means:

- OpenCode projection segments with no `Process[]` still render normal tools/output;
- Claude chunks with team `Process[]` avoid showing another member's subagent panels;
- synthetic/fake `Process` objects are not required for member stream.

### Decision

Do not synthesize fake `Process` entries for OpenCode member stream.

Render OpenCode through normal tool/output chunks from projected messages. Only use `Process[]` when real process metadata already exists.

Add a renderer regression test that a segment with `actor.memberName` and no `processes` still displays tool/output items.

## 0.3 IPC Validation And Limits

### Facts

Existing validators:

- `validateTeamName` fits `teamName`;
- `validateMemberName` fits member names;
- `validateTaskId` is task-only;
- `laneId` can contain `:`, for example `secondary:opencode:alice`, so `validateMemberName` is wrong for lane.

### Correct IPC Policy

Add a local helper near the handler, or a shared guard if reused:

```ts
export function validateOptionalRuntimeLaneId(value: unknown) {
  if (value == null) return { valid: true, value: undefined };
  if (typeof value !== 'string') return { valid: false, error: 'laneId must be a string' };
  const trimmed = value.trim();
  if (!trimmed) return { valid: true, value: undefined };
  if (trimmed.length > 256) return { valid: false, error: 'laneId exceeds max length (256)' };
  if (/[\0-\x1F\x7F/\\]/.test(trimmed)) {
    return { valid: false, error: 'laneId contains invalid characters' };
  }
  return { valid: true, value: trimmed };
}
```

Options policy:

- `limitSegments`: integer, clamp to `1..80`, default 30;
- `since`: if present, must parse as valid date, otherwise return IPC error;
- `laneId`: optional, max 256, no control chars or path separators, allow `primary` and colon-separated ids like `secondary:opencode:alice`;
- `forceRefresh`: optional boolean;
- unknown option keys rejected.

Do not lowercase or otherwise normalize `laneId`. It should be trimmed only, because the orchestrator/runtime record lookup may treat lane ids as exact identities.

Additional code research: `TEAM_GET_DATA` validates options with an allow-list and rejects unknown keys before dispatching to the service/worker. Member log stream should follow that stricter style because option typos can otherwise disable `laneId`, `since` or `forceRefresh` silently.

Recommended allow-list:

```ts
const allowed = new Set(['limitSegments', 'since', 'laneId', 'forceRefresh']);
```

Return `Unknown getMemberLogStream option: ${key}` for extra keys.

Security:

- do not expose transcript file paths in renderer response;
- warnings can mention counts and provider names, not absolute paths;
- service can log paths to main logger if needed.

## 0.4 Exact Stream DTO And Renderer Contract

### Facts

`BoardTaskLogSegment` is already the right low-level render unit:

```ts
interface BoardTaskLogSegment {
  id: string;
  participantKey: string;
  actor: BoardTaskLogActor;
  startTimestamp: string;
  endTimestamp: string;
  chunks: EnhancedChunk[];
}
```

`MemberExecutionLog` only needs `EnhancedChunk[]` plus optional member visual props. It does not know task ids, provider ids, or source metadata.

Additional type research:

- `BoardTaskLogStreamResponse.source` is a task-only union: transcript, OpenCode task runtime fallback/attribution and Codex task trace fallback values.
- `BoardTaskLogStreamResponse.runtimeProjection` is also task-specific, with attribution/heuristic/trace counters that are not the right member coverage model.
- `BoardTaskLogSegment` has no `source` field, so it is safe as the render primitive but not enough as the member DTO by itself.
- Therefore `MemberLogStreamResponse` should be a standalone shared response type, not `extends BoardTaskLogStreamResponse` and not an `Omit<BoardTaskLogStreamResponse, ...>` unless the omitted fields are fully replaced.

Recommended DTO shape:

```ts
type MemberLogStreamSource =
  | 'member_transcript'
  | 'member_mixed_runtime'
  | 'member_runtime_only'
  | 'member_empty';

interface MemberLogStreamResponse {
  participants: BoardTaskLogParticipant[];
  defaultFilter: 'all' | string;
  segments: MemberLogStreamSegment[];
  source: MemberLogStreamSource;
  coverage: MemberLogStreamCoverage[];
  warnings: MemberLogStreamWarning[];
  truncated: boolean;
  generatedAt: string;
  metadata: MemberLogStreamMetadata;
}
```

This keeps task stream source semantics untouched and avoids having member-only source values leak into task UI copy or task tests.

`TaskLogStreamSection` currently owns too much:

- response normalization through `asEnhancedChunkArray`;
- participant visual mapping;
- segment key building;
- segment headers;
- participant chips;
- loading, empty and error copy;
- live reload behavior;
- task-specific `describeStreamSource()` text.

### Decision

Extract generic render-only view, not a generic data loader:

```ts
interface ExecutionLogStreamViewProps<TStream extends ExecutionLogStreamLike> {
  title: string;
  description: string;
  stream: TStream | null;
  loading: boolean;
  error: string | null;
  emptyTitle: string;
  emptyDescription?: string;
  teamName: string;
  forceSegmentHeaders?: boolean;
  boundedHistoryNote?: string | null;
}
```

Keep loaders separate:

- `TaskLogStreamSection` loads task stream and keeps task-status reload behavior.
- `MemberLogStreamSection` loads member stream and passes `laneId`/budget options.

This avoids accidentally bringing task-specific reload and copy into member popup.

## 0.4.1 Member Segment Metadata

### Facts

`BoardTaskLogSegment` is enough for rendering chunks, but it does not identify provider source or safe session/lane labels:

```ts
interface BoardTaskLogSegment {
  id: string;
  participantKey: string;
  actor: BoardTaskLogActor;
  startTimestamp: string;
  endTimestamp: string;
  chunks: EnhancedChunk[];
}
```

For task stream this is acceptable because the whole section is task-scoped and source text is global. For member stream, multiple Claude sessions and OpenCode lane projection can appear in one popup. Without segment metadata, the UI either hides important context or parses `segment.id`, which is brittle.

### Decision

Use a member-specific extension:

```ts
interface MemberLogStreamSegmentSource {
  provider: MemberLogStreamProvider;
  label: string;
  sessionId?: string;
  laneId?: string;
  messageCount?: number;
  truncated?: boolean;
}

interface MemberLogStreamSegment extends BoardTaskLogSegment {
  source: MemberLogStreamSegmentSource;
}
```

Then:

- `MemberLogStreamResponse.segments` uses `MemberLogStreamSegment[]`;
- `MemberLogStreamResponse` stays standalone and does not extend `BoardTaskLogStreamResponse`;
- `ExecutionLogStreamView` remains generic over base `BoardTaskLogSegment`;
- `MemberLogStreamSection` can pass a segment label renderer that uses `segment.source`;
- task stream stays unchanged;
- segment source metadata never includes absolute file paths.
- segment ids use provider, normalized team/member, session id and a short hash/fingerprint, not raw absolute paths.

Risk rating:

🎯 8.5   🛡️ 8.5   🧠 4  
Approx 40-90 LOC.

This is safer than overloading `segment.id` or adding provider labels into chunk text.

Path rule:

- hash `filePath + mtimeMs + sizeBytes` if a file fingerprint is needed;
- never send `filePath` to renderer in `id`, `source`, `warnings` or `metadata`;
- main logger may record file paths for diagnostics, but response DTO should not.

## 0.4.2 Chunk Date Shape

### Facts

`MemberExecutionLog` calls `transformChunksToConversation()`, and `groupTransformer` uses `Date` methods on chunk and semantic-step timestamps. Existing task stream works because Electron IPC/preload returns structured-clone data and the service tests usually pass Date-shaped chunks.

Additional code research: `src/renderer/api/httpClient.ts` already has an ISO date JSON reviver and comments that Electron IPC preserves `Date` instances via structured clone while HTTP JSON needs rehydration. So the runtime date risk is lower than expected for normal app and browser-mode API paths.

The remaining risk is mostly tests and ad hoc fixtures. Renderer unit tests often use lightweight segment fixtures, and browser fallback has no real chunks. If the new generic view starts accepting JSON-like chunk fixtures with ISO strings without going through the HTTP client's reviver, it can fail in `durationMs = endTime.getTime() - startTime.getTime()`.

### Decision

Do not add broad date rehydration by default in the first implementation. Keep the same runtime assumption as task stream.

But add a clear guardrail:

- `ExecutionLogStreamView` tests should use Date-shaped `EnhancedChunk` fixtures when they expect real rendering;
- if a JSON-like fixture is needed, add one shared helper such as `normalizeEnhancedChunkDates()` and use it from both task/member stream normalization;
- do not scatter ad hoc `new Date()` calls across render components.

Updated risk rating:

🎯 9   🛡️ 8.5   🧠 3  
Approx 0-120 LOC depending on whether a normalizer is needed.

This keeps variant 2 aligned with existing task stream behavior without hiding a serialization assumption.

## 0.4.3 Renderer Normalization And Source Headers

### Facts

`TaskLogStreamSection.normalizeResponse()` currently reconstructs only known task-stream fields:

```ts
return {
  participants: response.participants,
  defaultFilter: response.defaultFilter,
  source: response.source,
  runtimeProjection: response.runtimeProjection,
  segments: ...
};
```

If this exact function is reused for `MemberLogStreamResponse`, it can accidentally drop member-only fields:

- `coverage`;
- `warnings`;
- `truncated`;
- `generatedAt`;
- `metadata`;
- `segment.source`.

`TaskLogStreamSection` also hides segment headers when there is only one participant:

```ts
participants.length > 1 || selectedParticipantKey !== 'all'
```

That is correct for task logs, but wrong for member logs. Member stream often has one participant, while the important context is per-segment provider/session/lane source.

Additional UI-model research: `BoardTaskLogParticipant` is actor identity. The renderer uses participant labels for chips, member badges and color lookup. Provider/runtime/session identity is a different axis. If member stream encodes provider/session as participant keys, one selected member can appear as multiple people and the "All" filter becomes misleading.

### Options

#### A. Reuse task view logic as-is

🎯 5   🛡️ 4   🧠 2  
Approx 40-100 LOC.

Low effort, but it can hide provider/session labels and silently drop response metadata.

#### B. Generic view preserves stream shape and accepts a segment-header renderer

🎯 9   🛡️ 9   🧠 5  
Approx 120-240 LOC.

The generic view should:

- normalize chunks with `asEnhancedChunkArray`;
- preserve the rest of the stream object with object spread, including `coverage`, `warnings`, `metadata`, `truncated`, `generatedAt` and `segment.source`;
- let callers pass `forceSegmentHeaders`;
- let callers pass `renderSegmentMarker` or `getSegmentMetaLabel`;
- keep task copy/source text in `TaskLogStreamSection`;
- keep member provider/session labels in `MemberLogStreamSection`.
- not import `api.teams`, feature gates, `MemberLogsTab`, provider sources or task/member loading hooks;
- receive already loaded `teamMembers` from the container so the pure view can be tested without the global store;
- keep fallback UI outside the generic view, because fallback policy is different for task vs member.

For member stream:

- `forceSegmentHeaders: true`;
- label each segment with `segment.source.label`;
- optionally show safe `sessionId` short prefix or `laneId`, never file path;
- show bounded-history/coverage warnings outside the repeated segment blocks.
- keep `participantKey` actor-based, for example `member:<normalizedName>`, and do not create `claude:<member>`/`opencode:<member>` pseudo-participants;
- if source filtering is needed later, add a separate source filter instead of overloading participant chips.

Additional renderer key research: current `TaskLogStreamSection.buildStableSegmentRenderKey()` uses `participantKey:firstChunkId`, not `segment.id`. That preserves expanded/collapsed React state when a live refresh extends the tail of the same segment and changes the segment id. Existing tests cover this behavior.

For member stream, the same default key can collide more easily because different providers/sessions can have one selected participant and similar first chunk ids. Do not change the task default blindly.

Add a caller-provided key strategy:

```ts
buildSegmentRenderKey?: (segment: TSegment) => string;
```

Rules:

- task stream default keeps current `participantKey:firstChunkId` behavior;
- member stream passes a source-aware key such as `${segment.id}:${segment.chunks[0]?.id ?? segment.startTimestamp}`;
- `segment.id` must already be path-safe and stable across refreshes;
- tests should cover both task tail-growth state preservation and member source collision avoidance.

#### C. Duplicate task stream UI into member component

🎯 7   🛡️ 6   🧠 4  
Approx 180-320 LOC.

Works quickly, but drift from task stream UI will grow and future variant 3 migration gets harder.

### Decision

Use option B.

Risk rating:

🎯 9   🛡️ 9   🧠 5  
Approx 160-300 LOC.

## 0.4.4 Renderer Request Coalescing

### Facts

`TaskLogStreamSection` uses `requestSeqRef` to ignore stale responses. That prevents stale UI writes, but it does not prevent parallel IPC calls when visibility reload, `log-source-change`, and `task-log-change` happen close together.

For task logs this is acceptable because the source is task-scoped. For member stream, one request can parse many files and may also call OpenCode runtime transcript. Parallel duplicate calls are a bigger performance risk.

### Decision

`MemberLogStreamSection` should coalesce active loads:

- keep one active request for the current `teamName/memberName/laneId/options` key;
- if a background reload is requested while active, set a pending reload flag instead of starting a second IPC call;
- when the active request finishes, run at most one pending background reload;
- if the component unmounts or key changes, ignore old results and clear pending reload state;
- initial foreground load still shows loading, background reload keeps old stream visible.

This complements backend/source in-flight protection. It is not a replacement for it, because multiple windows or tests can still call IPC directly.

Risk rating:

🎯 8.5   🛡️ 8.5   🧠 5  
Approx 80-160 LOC with tests.

## 0.4.4.1 Since And Full-Response Replacement

### Facts

`getMemberLogStream` options include `since` as a useful backend performance hint. But the renderer state model is full response replacement: `setStream(response)`. A since-filtered response is partial unless the API explicitly says it includes enough prior segments to replace the visible stream.

### Decision

First PR should not do client-side incremental merge.

- Initial load requests a full bounded stream.
- Background reload requests a full bounded stream too.
- `log-source-change` background reload adds `forceRefresh: true`, but not `since`.
- `since` remains validated at IPC and covered in service tests, but UI should not use it for replacement reloads until there is an explicit merge contract.
- If incremental reload is added later, response metadata must say whether it is `complete` or `partial`, and renderer must merge by source-aware segment id.

Risk rating:

🎯 8.5   🛡️ 9   🧠 3  
Approx 0-60 LOC, mostly tests and avoiding a tempting optimization.

This prevents a subtle UI regression where fresh logs appear, but older visible segments disappear after a background reload.

## 0.4.5 Member Popup Fallback Boundary

### Facts

`MemberDetailDialog` currently renders old logs directly:

```tsx
<MemberLogsTab teamName={teamName} memberName={member.name} />
```

The same old `MemberLogsTab` is also used by task logs through `ExecutionSessionsSection`, where it is labeled as legacy session-centric transcript browsing. That means changing `MemberLogsTab` itself is not a member-popup-only change.

Existing dialog tests live at:

- `test/renderer/components/team/members/MemberDetailDialog.test.ts`

That test file mocks `MemberLogsTab`, so replacing the import without updating the mock can cause noisy test failures that are unrelated to the stream logic.

### Options

#### A. Replace `MemberLogsTab` internals with new stream

🎯 5   🛡️ 5   🧠 4  
Approx 120-260 LOC.

This looks small, but it affects task `Execution Sessions` too. It also removes the clean rollback path.

#### B. Gate at `MemberDetailDialog` and keep `MemberLogsTab` untouched

🎯 9   🛡️ 9   🧠 4  
Approx 80-180 LOC.

This is the safest first implementation:

- renderer feature gate on: render `MemberLogStreamSection`;
- renderer feature gate off: render old `MemberLogsTab`;
- initial stream error: show error and explicit old logs fallback;
- background refresh error: keep last good stream and surface the error state unobtrusively.

Task `Execution Sessions` remains untouched because it still imports `MemberLogsTab` directly.

#### C. Let `MemberLogStreamSection` import and own `MemberLogsTab`

🎯 6   🛡️ 6   🧠 5  
Approx 100-220 LOC.

This hides fallback inside the new component, but makes the boundary muddier. It also makes it easier to accidentally couple legacy UI copy and new stream copy.

### Decision

Use option B.

Implementation guardrails:

- keep fallback decision in `MemberDetailDialog`, not inside the stream renderer;
- do not change `MemberLogsTab` behavior in the first PR;
- add a `MemberLogStreamSection` mock in `MemberDetailDialog` tests;
- test gate-on and gate-off rendering;
- test that first-load stream failure keeps the Logs tab active and shows explicit old logs fallback;
- keep `ExecutionSessionsSection` expectations unchanged.

Risk rating:

🎯 9   🛡️ 9   🧠 4  
Approx 80-180 LOC.

This reduces the highest accidental renderer regression risk without changing the backend design.

## 0.5 Cumulative Subagent Snapshot Dedupe

### Facts

`findLogsForTask()` already has this warning in code:

- in-process teammates can produce cumulative JSONL snapshots;
- the largest file is a superset of smaller files;
- task flow dedupes subagent snapshots by `sessionId + memberName` and keeps the largest `messageCount`.

But `findRecentMemberLogFileRefsByMember()` currently returns:

```ts
interface MemberLogFileRef {
  memberName: string;
  sessionId: string;
  filePath: string;
  mtimeMs: number;
}
```

It dedupes only exact `filePath`. That is not enough for member stream, because parsing multiple cumulative snapshots can duplicate the same turn several times.

Another discovered edge case: attribution uses `knownMembers`, built from current config, member meta and inbox names. If the popup is opened for a historical/removed member that is no longer present in those sources, syntax-only IPC validation still will not make attribution recognize that name.

### Options

#### A. Use refs as-is and rely on chunk/message ids

🎯 5   🛡️ 5   🧠 3  
Approx 0-80 LOC.

Low implementation cost, but duplicate stream entries are likely in cumulative snapshot cases.

#### B. Extend `MemberLogFileRef` with optional metadata and dedupe before parse

🎯 8   🛡️ 8   🧠 5  
Approx 120-220 LOC.

Add optional fields without breaking existing callers:

```ts
interface MemberLogFileRef {
  memberName: string;
  sessionId: string;
  filePath: string;
  mtimeMs: number;
  sizeBytes?: number;
  messageCount?: number;
  kind?: 'lead_session' | 'member_session' | 'subagent';
}
```

Then `ClaudeMemberTranscriptStreamSource` can:

- group subagent refs by `memberName + sessionId`;
- keep largest `messageCount` when available, otherwise largest `sizeBytes`, tie-break by newest `mtimeMs`;
- keep root member session refs separately;
- cap after dedupe, not before.

Do not stream every candidate only to compute `messageCount` in first PR. Use it when a caller already has it; otherwise `sizeBytes` is the cheap proxy for cumulative JSONL snapshots.

Also change `findRecentMemberLogFileRefsByMember()` so it adds requested member names to the attribution set before calling `getCachedSubagentAttribution()` / `getCachedMemberSessionAttribution()`.

Suggested shape:

```ts
const attributionMembers = new Set(knownMembers);
for (const key of requestedMembersByKey.keys()) {
  attributionMembers.add(key);
}
```

Use `attributionMembers` only for attribution. Keep the returned `memberName` as the caller's requested casing from `requestedMembersByKey`.

#### C. Parse all refs, then dedupe by message uuid

🎯 6   🛡️ 7   🧠 7  
Approx 180-350 LOC.

More robust when metadata is missing, but expensive and can still miss duplicates if synthetic/tool result uuids differ.

### Recommendation

Use B.

This is the most important correction to the earlier plan. Without it, variant 2 can be correct by attribution but noisy by duplication.

Add the requested-member attribution augmentation to B. It is small, but it is what makes removed-member popup logs actually possible instead of only syntactically allowed.

## 0.6 OpenCode Projection Mapper Boundary

### Facts

`ClaudeMultimodelBridgeService.getOpenCodeTranscript()` returns `transcript.logProjection.messages`.

`OpenCodeTaskLogStreamSource` already has working private mapping from `OpenCodeRuntimeTranscriptLogMessage` to `ParsedMessage`:

- content block conversion;
- tool call/result conversion;
- `sourceToolUseID`;
- `sourceToolAssistantUUID`;
- `toolUseResult`;
- sanitized text content.

There is also a separate `toParsedMessage()` in `OpenCodeTaskStallEvidenceSource`, but it is not equivalent. It maps non-string content to `[]` and does not build `toolUseResult`. That is acceptable for stall evidence rows, but not for a user-visible log stream.

But that file also contains task-specific logic:

- task marker matching;
- task windows;
- attribution records;
- foreign team marker filtering;
- task fallback heuristics.

### Options

#### A. Copy the private mapper into member source

🎯 7   🛡️ 6   🧠 4  
Approx 150-220 LOC.

Fast, but mapper drift is likely.

#### B. Extract generic mapper and make both task/member sources use it

🎯 8.5   🛡️ 8.5   🧠 6  
Approx 180-300 LOC.

Create a small file near stream sources, for example:

```ts
// src/main/services/team/taskLogs/stream/OpenCodeRuntimeProjectionMapper.ts
export function mapOpenCodeProjectionMessagesToParsedMessages(
  messages: OpenCodeRuntimeTranscriptLogMessage[]
): ParsedMessage[];

export function countProjectionToolCalls(messages: ParsedMessage[]): ProjectionToolCounts;
```

Only move generic projection conversion. Do not move task marker/window logic.

Extraction source must be `OpenCodeTaskLogStreamSource`, not `OpenCodeTaskStallEvidenceSource`.

Implementation detail:

- first move the task-source mapper to the shared file without behavior changes;
- update `OpenCodeTaskLogStreamSource` to call the shared mapper;
- then let `OpenCodeMemberRuntimeStreamSource` call the same mapper;
- leave stall monitor as-is unless a separate test-backed cleanup proves identical behavior is intended there.

#### C. Reuse `OpenCodeTaskLogStreamSource`

🎯 3   🛡️ 3   🧠 4  
Approx 80-160 LOC.

Wrong abstraction. It is task-scoped by design.

### Recommendation

Use B. This is a small refactor, but it reduces long-term drift and gives member stream the exact same OpenCode rendering semantics as task stream.

Important: do not use the stall-monitor mapper as the shared base. That would make the implementation look shared while silently degrading member stream content rendering.

## 0.6.1 OpenCode Runtime Call Budget

### Facts

`OpenCodeTaskLogStreamSource` already protects task stream fallback with:

- a small cache keyed by task/window/attribution;
- an `inFlight` map so concurrent calls join the same bridge request;
- `CACHE_TTL_MS = 1_500`;
- transcript limits of `200` for heuristic and `500` for attributed mode.

Member stream will reload on same-team `log-source-change` and `task-log-change`. Even with debounce, those events can arrive close together while a popup is open. Calling `runtime transcript` for every refresh can make the popup feel slow and can add unnecessary process churn.

### Options

#### A. No OpenCode member-source cache

🎯 7   🛡️ 6   🧠 2  
Approx 0-40 LOC.

Simple, but repeated refreshes can spawn repeated bridge calls. Timeout protects the popup from hanging, but not from extra work.

#### B. Add member-source TTL cache and in-flight join

🎯 8.5   🛡️ 8.5   🧠 4  
Approx 80-160 LOC.

Use a cache key like:

```txt
teamName::memberName::laneId-or-none::limit
```

Rules:

- default TTL `1_500ms`, matching task OpenCode fallback;
- `forceRefresh` can bypass completed cache, but should still join an existing in-flight request for the same key;
- cache both `null` and successful responses briefly, because repeated failures should not spawn repeated CLI calls;
- do not share this cache with `OpenCodeTaskLogStreamSource`;
- keep timeout handling inside the bridge/source, not renderer.

#### C. Add a long cache in `ClaudeMultimodelBridgeService`

🎯 5   🛡️ 5   🧠 6  
Approx 120-240 LOC.

This centralizes caching but risks changing behavior for status/stall/task callers that use the same bridge for different freshness expectations.

### Decision

Use option B.

This keeps OpenCode member stream responsive without changing bridge semantics for other callers.

Risk rating:

🎯 8.5   🛡️ 8.5   🧠 4  
Approx 80-160 LOC.

## 0.7 Live Refresh Policy

### Facts

`TeamChangeEvent` has:

- `log-source-change` without task id;
- `task-log-change` with `taskId`, but no `memberName`;
- `tool-activity`, which can be frequent and is intended for live tool indicators;
- no event that means "logs for member X changed".

Task stream can reload only for one `taskId`. Member stream cannot do that safely.

Additional code research: task logs do not rely on `onTeamChange` subscription alone.

- `TaskLogStreamSection` listens to `onTeamChange` and schedules reloads.
- `TaskLogsPanel` separately calls `api.teams.setTaskLogStreamTracking(teamName, true)` while task log activity tracking is relevant.
- That IPC maps to `TeamLogSourceTracker.enableTracking(teamName, 'task_log_stream')`.
- `TeamLogSourceTracker` only watches transcript/log freshness sources while at least one consumer is active.
- Member popup has no `TaskLogsPanel` parent, so just adding `onTeamChange` in `MemberLogStreamSection` can miss fresh events when no other UI has enabled tracking.

### Decision

For an open member popup:

- enable log-source tracking while the stream section is mounted;
- reload on same-team `log-source-change`;
- pass `forceRefresh: true` for `log-source-change`, because `TeamMemberLogsFinder` discovery cache has a 30s TTL;
- do not pass `since` from renderer for replacement reloads in the first PR;
- reload on same-team `task-log-change`, because it is still a log-source freshness signal;
- do not reload on `tool-activity`;
- debounce at least as strongly as task stream, preferably 500-750ms for member stream;
- do not clear existing stream on background refresh failure;
- reload on visibility return only if popup is still open.

Risk rating:

🎯 8   🛡️ 8   🧠 4  
Approx 40-80 LOC.

This may reload for tasks owned by other members, but only while the member popup is open and with debounce. That is safer than missing fresh logs because `task-log-change` lacks member attribution.

### Tracking Activation Options

#### A. Reuse `setTaskLogStreamTracking()` from member popup

🎯 8   🛡️ 7   🧠 2  
Approx 20-50 LOC.

This works because it increments the same `task_log_stream` consumer count. The downside is semantic drift: member UI would call a task-named API.

#### B. Add `setMemberLogStreamTracking()` mapped to a new tracker consumer

🎯 8.5   🛡️ 9   🧠 4  
Approx 90-170 LOC.

Add:

- feature `MEMBER_LOG_STREAM_SET_TRACKING` channel;
- feature API method or thin compatibility delegate;
- feature preload bridge and browser no-op fallback;
- `TeamLogSourceTrackingConsumer | 'member_log_stream'`;
- IPC handler that calls `TeamLogSourceTracker.enableTracking(teamName, 'member_log_stream')`.

This keeps UI language correct and lets task/member stream lifecycles have separate consumer counts while sharing the same underlying watcher.

Important implementation detail from code:

- `TeamLogSourceTracker` consumer counts are per team and consumer name, not per member.
- That is correct for member stream because the watcher scope is team/session-level.
- Do not add one watcher per member popup. Add one `member_log_stream` consumer and rely on reference counts for multiple popups.
- If the component remounts with a different `teamName`, cleanup must disable the previous team before enabling the next team.
- Disabling `member_log_stream` must not close the watcher while `task_log_stream`, `change_presence`, `tool_activity` or `stall_monitor` still has a positive count.

#### C. Do not enable tracking from member popup

🎯 5   🛡️ 4   🧠 1  
Approx 0 LOC.

This is unreliable. It only works when another part of the UI has already enabled log-source tracking.

### Tracking Decision

Use B.

It adds a little transport work, but it removes a hidden dependency on `TaskLogsPanel` and avoids calling task-named APIs from member logs.

## 0.8 IPC And Composition Integration

### Facts

`src/main/ipc/teams.ts` currently has many positional dependencies and already owns legacy team APIs. That is exactly why member log stream should not be added there as another owned service.

Current legacy facts still matter:

- `src/main/ipc/teams.ts` owns existing team handlers;
- task stream still uses `TEAM_GET_TASK_LOG_STREAM`;
- `src/preload/index.ts` and `src/renderer/api/httpClient.ts` already expose legacy team API fallbacks;
- `src/main/index.ts` is the composition point where feature facades can be instantiated.

### Options

#### A. Feature-owned IPC and composition

🎯 8.5   🛡️ 9   🧠 4  
Approx 80-180 LOC for transport wiring.

This is the correct first PR choice after adopting the canonical feature slice.

Implementation rule:

```ts
const memberLogStreamFeature = createMemberLogStreamFeature({
  logsFinder,
  logSourceTracker,
  runtimeBridge,
  logger,
});

registerMemberLogStreamIpc(ipcMain, memberLogStreamFeature);
```

Feature-owned files:

- `src/features/member-log-stream/contracts/channels.ts`;
- `src/features/member-log-stream/contracts/api.ts`;
- `src/features/member-log-stream/preload/createMemberLogStreamBridge.ts`;
- `src/features/member-log-stream/main/composition/createMemberLogStreamFeature.ts`;
- `src/features/member-log-stream/main/adapters/input/ipc/registerMemberLogStreamIpc.ts`.

Test rule:

- feature IPC registration test expects feature channel registration/removal;
- app-shell integration test imports only `@features/member-log-stream/main`;
- existing task stream handler tests remain unchanged and prove legacy team IPC was not disturbed.

#### B. Add member stream into `initializeTeamHandlers()`

🎯 5   🛡️ 4   🧠 2  
Approx 30-70 LOC.

This is no longer the recommended path. It is locally cheap, but it violates feature ownership and risks shifting positional dependencies in `initializeTeamHandlers()`.

Do not choose this.

#### C. Convert legacy team initializer to a dependency object

🎯 7   🛡️ 9   🧠 7  
Approx 250-450 LOC.

This is a useful legacy IPC hygiene refactor, but it is separate from member log stream. It should not be bundled unless the PR explicitly pays that cost.

### Required Feature Handler Contract

Add feature-owned channels, for example:

```ts
export const MEMBER_LOG_STREAM_GET = 'member-log-stream:getMemberLogStream';
export const MEMBER_LOG_STREAM_SET_TRACKING = 'member-log-stream:setTracking';
```

Add register/remove symmetry in feature input adapter:

```ts
ipcMain.handle(MEMBER_LOG_STREAM_GET, handleGetMemberLogStream);
ipcMain.handle(MEMBER_LOG_STREAM_SET_TRACKING, handleSetMemberLogStreamTracking);
ipcMain.removeHandler(MEMBER_LOG_STREAM_GET);
ipcMain.removeHandler(MEMBER_LOG_STREAM_SET_TRACKING);
```

Add feature API and preload shape:

```ts
getMemberLogStream(
  teamName: string,
  memberName: string,
  options?: {
    limitSegments?: number;
    since?: string;
    laneId?: string;
    forceRefresh?: boolean;
  }
): Promise<MemberLogStreamResponse>
```

Handler behavior:

- validate `teamName` with `validateTeamName`;
- validate `memberName` with `validateMemberName`, but do not require current team membership;
- validate `laneId` with the new runtime-lane validator, not with `validateMemberName`;
- clamp `limitSegments` before passing options to service;
- reject invalid `since`;
- validate `forceRefresh` as boolean when present;
- reject unknown option keys;
- call the feature facade/use case with normalized options.

Validator placement note:

- `src/main/ipc/guards.ts` keeps `ValidationResult` local today;
- safest implementation is to export concrete helpers like `validateOptionalRuntimeLaneId()` and `validateOptionalBooleanOption()` from `guards.ts`;
- if validators stay local in the feature input adapter, do not import a non-exported `ValidationResult` type.

### Browser Fallback

The renderer API/browser fallback must satisfy the feature API even when Electron IPC is unavailable. If `api.teams` compatibility delegates are kept, they must delegate to the same fallback shape.

Return a complete empty response:

```ts
{
  participants: [],
  defaultFilter: 'all',
  segments: [],
  source: 'member_empty',
  coverage: [],
  warnings: [],
  truncated: false,
  generatedAt: new Date().toISOString(),
  metadata: {
    scannedTranscriptFileCount: 0,
    includedTranscriptFileCount: 0,
    droppedSegmentCount: 0,
    droppedChunkCount: 0,
    droppedMessageCount: 0,
  },
}
```

Do not throw in browser fallback. Throwing would make renderer code need an Electron-only branch even though task stream already uses a safe empty fallback.

### Recommendation

Use option A in the implementation PR.

🛡️ The main bug risk is not the new stream logic here. It is accidentally pulling the feature back into legacy `team` IPC/service ownership and weakening the feature boundary.

## 1. Claude Transcript Attribution

### Facts

`TeamMemberLogsFinder` уже содержит лучший source для member stream:

```ts
findRecentMemberLogFileRefsByMember(
  teamName: string,
  memberNames: readonly string[],
  mtimeSinceMs?: number | null
): Promise<MemberLogFileRef[]>
```

Дополнительный compatibility факт: этот method уже используется не только будущим member stream.

- `TeamMemberRuntimeAdvisoryService` вызывает его с третьим positional numeric arg.
- Existing live tests вызывают его с `null` и numeric `mtimeSinceMs`.
- `discoverProjectSessions(teamName, { forceRefresh })` уже поддерживает cache bypass.
- `getLogSourceWatchContext()` и `getLiveLogSourceWatchContext()` уже передают `forceRefresh` в discovery path.
- Current method calls `discoverProjectSessions(teamName)` without options, so member stream needs object-form options only to add `forceRefresh`.
- Current lead transcript branch pushes the lead ref after `fs.stat()` but before any `mtimeSinceMs` check.
- Current refs have only `memberName`, `sessionId`, `filePath` and `mtimeMs`.

Значит для member stream нельзя делать breaking object-only замену третьего аргумента.

Нужен backward-compatible options parser:

```ts
type FindRecentMemberLogFileRefsOptions =
  | number
  | null
  | {
      mtimeSinceMs?: number | null;
      forceRefresh?: boolean;
    };
```

Implementation rule:

- numeric third arg остается `mtimeSinceMs`;
- `null` остается "без mtime window";
- object third arg включает `mtimeSinceMs` и `forceRefresh`;
- only object form can bypass discovery cache;
- existing advisory callers do not need changes.

Он возвращает:

```ts
{
  memberName: string;
  sessionId: string;
  filePath: string;
  mtimeMs: number;
  kind?: 'lead_session' | 'member_session' | 'subagent';
  sizeBytes?: number;
  messageCount?: number;
}
```

Metadata rule:

- `kind` and `sizeBytes` are cheap and should be added by the finder;
- `messageCount` is optional and should be filled only when existing attribution/session metadata already knows it;
- do not parse full JSONL files in `TeamMemberLogsFinder` just to compute `messageCount`, because `ClaudeMemberTranscriptStreamSource` will strict-parse the selected refs afterward.

Почему это лучше, чем `findMemberLogPaths()`:

- уже сортирует refs по `mtimeMs desc`;
- дедуплицирует `filePath`;
- возвращает `sessionId`, который нужен для stable segment id;
- умеет lead transcript;
- использует ту же attribution precedence, что и старые member logs;
- принимает `mtimeSinceMs`, что дает cheap performance window.

### Correct Implementation

🎯 9   🛡️ 9   🧠 4  
Примерно 120-220 LOC для Claude-only member stream service.

Service должен:

1. Вызывать `findRecentMemberLogFileRefsByMember(teamName, [memberName], { mtimeSinceMs: sinceMs, forceRefresh })`.
2. Dedupe cumulative subagent refs before cap, using `kind + memberName + sessionId`, then `messageCount`, `sizeBytes`, `mtimeMs`.
3. Сразу применять cap по ref count после dedupe: default `maxTranscriptFiles = 40`.
4. Парсить только capped refs через отдельный `BoardTaskExactLogStrictParser`.
5. Для каждого ref строить отдельный segment.
6. Ограничивать total chunks глобальным budget, default `maxChunks = 250`.
7. Сортировать response segments по `startTimestamp asc`, чтобы renderer мог reverse как task stream.
8. Возвращать warning `large_log_window_limited`, если refs/chunks больше cap.

### Risks

- Если member был переименован, finder ищет только переданное имя.
- Если `knownMembers` не содержит historical removed member, attribution может не найти старые logs.
- Если заменить third arg object-only, можно сломать runtime advisory и live tests, которые уже передают numeric/null.
- В текущем коде lead transcript добавляется до candidate scan и не проходит `mtimeSinceMs` filter.
- Если finder начнет считать `messageCount` через full parse, он удвоит IO и сделает popup тяжелее на больших историях.
- Text mention остается low-confidence fallback. Это уже существующий риск, не новый.

### Mitigation

- Не требовать current config membership в IPC handler.
- В plan добавить future alias map, но не делать в v2.
- В coverage явно писать `claude_transcript included/partial`.
- Расширять third arg finder-а через compatibility parser, а не менять его на object-only.
- При object/numeric `mtimeSinceMs` применять time window и к lead transcript, и к member/subagent candidates.
- Если lead transcript старше `mtimeSinceMs`, не возвращать его в recent refs.
- Добавить tests на numeric, `null` и object options формы.
- Добавить tests, что `forceRefresh` передается в `discoverProjectSessions()` только через object form.
- Добавить tests, что optional metadata не ломает existing advisory callers и не требует full parse внутри finder.

## 2. OpenCode Lane Resolution

### Facts

В репо уже есть deterministic lane identity:

```ts
buildPlannedMemberLaneIdentity({
  leadProviderId,
  member,
})
```

Для mixed team с non-OpenCode lead и OpenCode member lane становится:

```txt
secondary:opencode:<memberName>
```

`TeamMemberResolver` уже кладет в `TeamMemberSnapshot`:

- `laneId`;
- `laneKind`;
- `laneOwnerProviderId`.

Renderer получает resolved member через spread snapshot:

```ts
return {
  ...snapshot,
  status,
  messageCount,
  lastActiveAt,
}
```

Но `ResolvedTeamMember` type сейчас явно не содержит runtime/lane fields, хотя фактический объект их несет. Это хрупко для новой реализации.

Дополнительный code research:

- `src/shared/types/team.ts` объявляет `TeamMemberSnapshot.laneId/laneKind/laneOwnerProviderId`;
- `src/shared/types/team.ts` также объявляет `TeamMemberSnapshot.providerBackendId/selectedFastMode/resolvedFastMode`;
- `src/shared/types/team.ts` не объявляет эти поля на `ResolvedTeamMember`;
- `src/renderer/store/slices/teamSlice.ts` делает `return { ...snapshot, status, messageCount, lastActiveAt }`, поэтому runtime object уже несет lane fields;
- renderer code уже обращается к lane fields в некоторых utility paths, но без полноценного `ResolvedTeamMember` contract это легко превращается в касты и drift.

### Correct Implementation

🎯 8.5   🛡️ 9   🧠 4  
Примерно 180-320 LOC.

Нужно сделать так:

1. Расширить `ResolvedTeamMember` type полями:
   - `providerBackendId?: TeamProviderBackendId`;
   - `selectedFastMode?: TeamFastMode`;
   - `resolvedFastMode?: boolean`;
   - `laneId?: string`;
   - `laneKind?: 'primary' | 'secondary'`;
   - `laneOwnerProviderId?: TeamProviderId`.
   Data mapping almost does not change, because `buildResolvedMember()` already spreads `snapshot`.
2. Расширить `getMemberLogStream` options:

```ts
{
  limitSegments?: number;
  since?: string;
  laneId?: string;
}
```

3. В `MemberLogStreamSection` передавать `member.laneId`, если:
   - `member.providerId === 'opencode'`;
   - `member.laneOwnerProviderId === 'opencode'`;
   - `member.laneId` непустой.
   Не передавать `laneId` для non-OpenCode members, даже если в старом snapshot случайно остался lane-like field.
4. В `ClaudeMultimodelBridgeService.getOpenCodeTranscript()` добавить optional `laneId`.
5. В тот же params добавить optional `timeoutMs`, чтобы member popup не зависал на provider probe path.
6. Bridge должен append:

```ts
if (params.laneId?.trim()) {
  args.push('--lane', params.laneId.trim());
}
```

7. Если `laneId` неизвестен, можно сделать best-effort no-lane call, но только с catch ambiguity error.
8. Ambiguity превращать в warning `opencode_ambiguous_lane`, не в hard failure.
9. Timeout/runtime missing превращать в `opencode_runtime_timeout` или `opencode_runtime_unavailable`, не в hard failure.
10. Add a small member-source TTL cache and in-flight join around OpenCode runtime transcript calls.

### Why This Is Safer

Orchestrator уже защищает от unsafe resolution:

```txt
Multiple OpenCode session records exist ... pass --lane to select one
```

Desktop должен уважать это, а не обходить.

### OpenCode Member Stream Semantics

Для member stream нельзя использовать task-specific logic из `OpenCodeTaskLogStreamSource`:

- не применять task marker spans;
- не применять task work intervals;
- не фильтровать по task owner;
- не читать task attribution records как основной source.

Правильный member OpenCode segment:

- получить projection messages за выбранный member/lane;
- cap по `limit`, default `openCodeMessageLimit = 400`;
- cap по времени, default `openCodeTimeoutMs = 5_000`, потому что текущий bridge path использует `execCli` timeout and can otherwise delay the popup;
- build chunks через `BoardTaskExactLogChunkBuilder`;
- segment id включает `teamName`, `laneId`, `memberName`, `sessionId`;
- source coverage: `opencode_runtime included`;
- если projection пустой: `opencode_runtime skipped`.

Implementation detail:

- не использовать `OpenCodeTaskLogStreamSource` напрямую, потому что он task-specific;
- вынести reusable projection-to-ParsedMessage helpers из `OpenCodeTaskLogStreamSource` в small mapper, если без копипаста не обойтись;
- покрыть старый task source тестами после extraction, чтобы не сломать task stream.

### Risks

- `ResolvedTeamMember` type drift может скрыть runtime/lane fields от TS.
- Старые teams могут не иметь lane metadata.
- OpenCode primary-only teams могут использовать `laneId: primary`.
- Runtime transcript может быть stale или пустым.

### Mitigation

- API принимает laneId от renderer, но main может recompute fallback lane identity later.
- Для v2 достаточно renderer laneId + safe no-lane fallback.
- Не merge multiple lanes.
- Не показывать OpenCode как complete, если он skipped/partial.

## 3. Codex Native Member-wide Feasibility

### Facts

`CodexNativeTraceReader` хранит traces здесь:

```txt
.member-work-sync/runtime-hooks/codex-native-traces/
  processed/<team>/<task>/*.jsonl
  incoming/<team>/<task>/*.jsonl.tmp
```

Header содержит:

- `teamName`;
- `taskId`;
- `ownerName`;
- `runId`;
- `cwd`;
- `startedAt`.

Значит member filtering по `ownerName` технически возможен.

Но текущий API:

```ts
readTaskRuns({ teamName, taskIds, includeIncoming })
```

task-first. Он не умеет:

- перечислить все task dirs для team;
- выбрать последние N runs по ownerName;
- ограничить scan без taskId;
- возвращать member-wide coverage.

Current implementation detail:

- It only lists `processed/<team>/<task>` and optional `incoming/<team>/<task>`.
- It caps latest candidates after task-dir collection, currently to 10 files.
- It dedupes by `team/task/runId`, preferring non-partial/newer candidates.
- That strategy is safe for a known task id, but not enough for member-wide history because there is no bounded owner index.

Еще важнее: `CodexNativeTraceProjector` проектирует только native tool events, а не полный разговор Codex. То есть даже если сделать member-wide reader, это будет "Codex native tool trace", а не полный Codex log stream.

### Options

#### A. Keep Codex skipped in first implementation

🎯 9   🛡️ 9   🧠 2  
Примерно 20-40 LOC для coverage warning.

Плюсы:

- самый надежный первый релиз;
- нет риска тяжелого scan по trace tree;
- честное product обещание.

Минусы:

- Codex участники не получат новый native trace в member popup.

#### B. Add partial Codex native tool trace as phase 2

🎯 7   🛡️ 7   🧠 7  
Примерно 250-450 LOC.

Новый метод:

```ts
readMemberRuns({
  teamName,
  ownerName,
  includeIncoming,
  limitRuns,
  maxTaskDirs,
})
```

Алгоритм:

1. Resolve trace root.
2. List `processed/<team>` task dirs and optional `incoming/<team>` task dirs.
3. Collect jsonl/jsonl.tmp candidates with stat.
4. Sort by `mtimeMs desc`.
5. Cap candidates before full parse.
6. Parse headers/runs.
7. Filter normalized `ownerName`.
8. Deduplicate by `team/task/runId`, prefer non-partial and newer mtime.
9. Project via `CodexNativeTraceProjector`.
10. Return segment with source label `codex_native_trace_partial`.

Additional required caps:

- `maxTaskDirs` before candidate collection;
- `maxTraceCandidates` before full parse;
- `maxTraceRuns` after owner filtering/dedupe;
- default `includeIncoming: false` unless the member is currently active or the UI explicitly requests live partial files.

Минусы:

- scanning all task dirs может быть тяжелым;
- trace может быть native-tool-only и выглядеть неполным;
- incoming partial files требуют аккуратного JSONL handling.
- scanning by owner without an index can become O(number of tasks), so it should not ride inside the first PR.

#### C. Full Codex member-wide log support

🎯 5   🛡️ 5   🧠 9  
Примерно 700-1200+ LOC.

Нужно строить отдельный index по Codex runtime/session events, не только native tool traces. Это уже вариант 3.

### Recommendation

Для варианта 2:

- first PR: Codex skipped with explicit `codex_member_wide_not_supported`;
- optional second PR: partial native tool trace with honest UI label;
- do not present Codex native trace as full logs.

## 4. Parser Cache Safety

### Facts

`BoardTaskExactLogStrictParser.parseFiles()` делает:

```ts
this.cache.retainOnly(new Set(uniquePaths));
```

`BoardTaskExactLogsParseCache` delegates to `BoardTaskActivityParseCache`, whose `retainOnly()` removes both:

- parsed cache entries;
- active `inFlight` parse promises outside the retained file set.

Это значит: если один service instance парсит task files, а другой потом member files на том же parser instance, второй вызов может вычистить не только cache первого, но и его active parse dedupe. В худшем случае это не ломает correctness напрямую, но создает duplicate reads, timing-sensitive cache churn и flaky performance под параллельными reload.

### Correct Implementation

🎯 9   🛡️ 9   🧠 3  
Примерно 20-60 LOC.

Для v2:

- `ClaudeMemberTranscriptStreamSource` получает собственный `BoardTaskExactLogStrictParser`.
- Не шарить parser instance с `BoardTaskLogStreamService`.
- Не инжектить task-stream parser в тестах как "удобный shared mock", потому что это маскирует ownership rule.
- Если понадобится общий parser, сначала redesign cache API: `retainOnly()` должен стать owner-scoped или LRU-based.

Future improvement:

- заменить `retainOnly()` на bounded LRU cache;
- либо добавить namespace/owner key для task/member cache ownership;
- тогда task/member services смогут безопасно шарить parser.

Но это не нужно для первого релиза.

## 5. API Shape Refinement

### Previous Draft

Изначально было достаточно:

```ts
getMemberLogStream(teamName, memberName, options?)
```

### Updated API

После research лучше зафиксировать:

```ts
getMemberLogStream(
  teamName: string,
  memberName: string,
  options?: {
    limitSegments?: number;
    since?: string;
    laneId?: string;
    forceRefresh?: boolean;
  }
): Promise<MemberLogStreamResponse>
```

Почему `laneId` в options:

- renderer уже знает выбранного member object;
- это самый дешевый и точный path для OpenCode secondary lanes;
- main все равно валидирует strings;
- если поля нет, main может fallback to no-lane best-effort.

Почему `forceRefresh` в options:

- `discoverProjectSessions()` кэширует discovery на 30 секунд;
- same-team `log-source-change` означает, что session ids/source context could have changed;
- renderer can pass `forceRefresh: true` only for that event path;
- regular task-log-change reloads can keep the cache.

Почему не передавать весь member:

- меньше IPC surface;
- меньше drift между renderer snapshot и main truth;
- no need to trust UI for provider selection.

## 6. Correct First Implementation Sequence

Updated safest order:

1. Create `src/features/member-log-stream` with contracts, core/domain, core/application, main composition, preload bridge and renderer public entrypoints.
2. Add feature-owned `MemberLogStreamResponse`, `MemberLogStreamSegment.source`, response metadata, warnings and `ResolvedTeamMember` runtime/lane fields. Do not extend or broaden `BoardTaskLogStreamResponse.source`.
3. Add feature IPC channels, feature preload methods, browser fallback and optional compatibility methods on `api.teams` for `getMemberLogStream` plus `setMemberLogStreamTracking`.
4. Add IPC validation helpers in the feature input adapter or shared guards, including exact-preserving optional `laneId` validation. Register feature handlers append-only without shifting existing `initializeTeamHandlers()` positional dependencies.
5. Add core source-port interfaces and budget constants.
6. Extend `MemberLogFileRef` with optional `kind`/`sizeBytes`/`messageCount`, add backward-compatible `findRecentMemberLogFileRefsByMember()` third-arg options parsing, apply `mtimeSinceMs` to lead refs, augment requested members into attribution, keep `messageCount` cheap-only, then add ref dedupe tests.
7. Add `ClaudeMemberTranscriptStreamSource` using `findRecentMemberLogFileRefsByMember`, ref dedupe and dedicated parser instance owned by member stream.
8. Extract provider-neutral `ParsedMessage` hygiene helpers and keep board/task JSON cleanup scoped.
9. Add pair-aware message-window trimming and content-size truncation before chunk build.
10. Extract `OpenCodeRuntimeProjectionMapper` from `OpenCodeTaskLogStreamSource` without moving task-window logic. Do not use the narrower stall-monitor mapper as the base.
11. Add `GetMemberLogStreamUseCase` with merge, sort, budget, truncation and identical active request join layer.
12. Add source-local OpenCode member TTL cache and in-flight join.
13. Export/instantiate the feature facade in main composition and register/remove the new IPC handler.
14. Add renderer feature `ExecutionLogStreamView` render-only extraction with shape-preserving normalization and caller-provided segment key strategy.
15. Add `MemberLogStreamSection` with tracking activation, reload coalescing, actor/source identity separation and without importing old `MemberLogsTab`.
16. Wire `MemberDetailDialog` gate-on/gate-off boundary with old `MemberLogsTab` fallback, importing only `@features/member-log-stream/renderer`.
17. Add OpenCode bridge `laneId` and `timeoutMs`.
18. Add `OpenCodeMemberRuntimeStreamSource` using the shared mapper, while leaving stall-monitor mapper migration as a separate optional cleanup.
19. Add coverage/warnings and backend truncation semantics.
20. Keep Codex skipped in first PR.
21. Optional follow-up PR: `CodexNativeTraceReader.readMemberRuns`.

## 7. Revised Risk Ratings

| Risk | Before | After research | Notes |
| --- | ---: | ---: | --- |
| Showing another member's Claude logs | 🛡️ 7 | 🛡️ 8 | Existing finder has strong attribution precedence |
| OpenCode wrong lane | 🛡️ 6 | 🛡️ 8 | Pass laneId from snapshot, respect orchestrator ambiguity |
| Codex completeness claim | 🛡️ 5 | 🛡️ 8 | Mark skipped/partial honestly |
| Codex member-wide scan cost | 🛡️ 4 | 🛡️ 9 | First PR does not scan task-keyed trace tree for member-wide owner history |
| Parser cache regression | 🛡️ 6 | 🛡️ 9 | Dedicated parser instance avoids parsed cache eviction |
| Parser in-flight eviction | 🛡️ 5 | 🛡️ 9 | Same ownership rule avoids deleting another stream's active parse dedupe |
| UI copy drift from task stream | 🛡️ 7 | 🛡️ 8 | Generic view extraction avoids duplicated renderer logic |
| Popup freeze on large history | 🛡️ 4 | 🛡️ 8 | Backend budget avoids rendering audit-sized logs |
| Architecture drift | 🛡️ 5 | 🛡️ 9 | Canonical feature slice plus source ports keeps provider logic isolated and follows repo standard |
| Feature boundary deep imports | 🛡️ 5 | 🛡️ 9 | Generic `src/features/*` lint guard rails plus public-entrypoint imports protect Clean Architecture direction |
| IPC lane validation | 🛡️ 6 | 🛡️ 8.5 | Dedicated lane validator handles `secondary:opencode:*` safely without rewriting exact ids |
| Cumulative subagent duplicates | 🛡️ 5 | 🛡️ 8 | Ref metadata plus pre-parse dedupe avoids repeated turns |
| OpenCode mapper drift | 🛡️ 6 | 🛡️ 8.5 | Shared projection mapper avoids copy-pasted conversion |
| Wrong OpenCode mapper base | 🛡️ 5 | 🛡️ 9 | Extract from task source, not from the narrower stall-monitor mapper |
| Finder metadata overreach | 🛡️ 5 | 🛡️ 8 | `kind`/`sizeBytes` stay cheap; no full parse just for `messageCount` |
| Oversized single segment | 🛡️ 4 | 🛡️ 8 | Message budget catches huge chunks that `maxChunks` cannot |
| Live refresh misses | 🛡️ 6 | 🛡️ 8 | Same-team `task-log-change` reload covers task freshness signals |
| IPC dependency shift | 🛡️ 5 | 🛡️ 8 | Append-only service injection avoids breaking positional handler setup |
| Browser fallback compile drift | 🛡️ 6 | 🛡️ 8 | Full empty response keeps feature API and any compatibility delegate satisfied outside Electron |
| Removed member attribution | 🛡️ 5 | 🛡️ 8 | Requested member names are added to finder attribution set |
| Finder options compatibility | 🛡️ 6 | 🛡️ 9 | Backward-compatible third-arg parser keeps advisory and live tests stable |
| Lead mtime window bypass | 🛡️ 6 | 🛡️ 9 | Apply `mtimeSinceMs` to lead transcript before pushing lead ref |
| Mixed source context loss | 🛡️ 6 | 🛡️ 8 | Member segment metadata gives UI safe provider/session labels |
| Segment key collisions | 🛡️ 6 | 🛡️ 8.5 | Generic view supports task default key and member source-aware override |
| OpenCode popup delay | 🛡️ 5 | 🛡️ 8 | Popup-specific timeout and fail-soft source handling avoid blocking Claude transcript logs |
| Renderer duplicate reloads | 🛡️ 5 | 🛡️ 8.5 | Member section coalesces active loads and runs at most one pending reload |
| Live tracking not activated | 🛡️ 4 | 🛡️ 9 | Dedicated `setMemberLogStreamTracking()` activates `TeamLogSourceTracker` while popup stream is mounted |
| Tracking consumer leak | 🛡️ 5 | 🛡️ 8.5 | Team-level `member_log_stream` consumer uses existing reference counting and cleanup tests |
| Stale discovery after launch | 🛡️ 5 | 🛡️ 8 | `forceRefresh` on `log-source-change` bypasses 30s finder discovery cache |
| Huge single tool output | 🛡️ 4 | 🛡️ 8 | Content-char budgets protect renderer beyond message/chunk count |
| Renderer Date shape drift | 🛡️ 6 | 🛡️ 8.5 | HTTP client already revives ISO dates, remaining risk is mostly test fixtures |
| DTO source union drift | 🛡️ 5 | 🛡️ 9 | Standalone `MemberLogStreamResponse` avoids mutating task `BoardTaskLogStreamResponse.source` semantics |
| Member popup fallback regression | 🛡️ 6 | 🛡️ 9 | Gate at `MemberDetailDialog`, leave shared `MemberLogsTab` and task `Execution Sessions` untouched |
| Resolved member runtime/lane type drift | 🛡️ 6 | 🛡️ 9 | Shared type explicitly declares runtime/lane fields already present at runtime |
| OpenCode bridge call churn | 🛡️ 5 | 🛡️ 8 | Short source-local TTL and in-flight join mirror task source behavior |
| Board/task sanitization leakage | 🛡️ 5 | 🛡️ 9 | Extract provider-neutral message hygiene, keep board JSON cleanup scoped to task stream |
| IPC option typo drift | 🛡️ 5 | 🛡️ 9 | Unknown member-stream options are rejected with an allow-list before service dispatch |
| Participant/source identity drift | 🛡️ 5 | 🛡️ 9 | Actor participants stay actor-based; provider/session labels come from `segment.source` |
| Since-only replacement reload | 🛡️ 5 | 🛡️ 9 | Renderer does full bounded reloads until partial-response merge is explicit |
| Generic view side effects | 🛡️ 5 | 🛡️ 9 | View stays render-only; containers own API calls, gates, tracking and fallback |

## 8. Test Additions From Research

Add these tests beyond the original plan:

- Core domain policy tests run without main/preload/renderer imports.
- Core application use-case tests use fake source/cache/clock/logger ports and no concrete provider adapters.
- Feature IPC tests exercise `registerMemberLogStreamIpc()`/remove handler through feature main input adapter.
- Feature preload tests exercise `createMemberLogStreamBridge()` with contracts-only dependencies.
- Renderer UI tests pass props/view models and do not mock `@renderer/api` or `@renderer/store`.
- Targeted lint for `src/features/member-log-stream` passes under generic feature boundary rules.
- App shell integration imports only `@features/member-log-stream/main`, `@features/member-log-stream/preload`, `@features/member-log-stream/renderer` or `@features/member-log-stream/contracts`.
- `ClaudeMemberTranscriptStreamSource` uses `findRecentMemberLogFileRefsByMember`, not `findMemberLogPaths`.
- It dedupes cumulative subagent refs before parsing and caps after dedupe.
- It augments attribution with requested member names so removed/historical members can still resolve.
- It enforces global `maxSegments` and `maxChunks`.
- It enforces `maxSourceMessages` and `maxMessagesPerSegment`.
- It enforces content-char budgets without mutating parser cache arrays.
- It trims oversized message windows without orphaning tool results.
- It truncates oversized content while preserving ids needed for tool linking.
- It preserves ordinary JSON-looking tool outputs unless the content budget requires truncation.
- It does not apply board/task JSON cleanup globally to member stream messages.
- It creates stable segment ids from `sessionId/fileFingerprint/startTimestamp`.
- It returns `MemberLogStreamSegment.source` labels without absolute file paths.
- It hashes file fingerprints and does not expose absolute paths in ids/warnings/metadata.
- It does not share parser cache with task stream.
- It uses a member-owned parser so member `parseFiles().retainOnly()` cannot clear task-stream `inFlight` parse entries.
- Task-stream parse in-flight dedupe still works while member stream parses a different file set.
- First-PR Codex skipped adapter does not call `CodexNativeTraceReader.readTaskRuns()` and does not scan `processed/<team>/<task>` directories.
- `MemberLogFileRef` optional `kind`/`sizeBytes`/`messageCount` remains backward compatible with advisory callers.
- `MemberLogFileRef.messageCount` is not computed by full parsing inside `TeamMemberLogsFinder`.
- `TeamMemberLogsFinder.findRecentMemberLogFileRefsByMember()` keeps legacy numeric/null third-arg behavior.
- `TeamMemberLogsFinder.findRecentMemberLogFileRefsByMember()` supports object options `{ mtimeSinceMs, forceRefresh }`.
- `TeamMemberLogsFinder.findRecentMemberLogFileRefsByMember()` passes `forceRefresh` through to `discoverProjectSessions()`.
- `TeamMemberLogsFinder.findRecentMemberLogFileRefsByMember()` applies `mtimeSinceMs` to lead transcript refs.
- `OpenCodeRuntimeProjectionMapper` preserves tool calls, tool results, content blocks, `sourceToolUseID`, `sourceToolAssistantUUID`, `toolUseResult`, `isMeta`, and sanitized text content.
- `OpenCodeTaskLogStreamSource` and `OpenCodeMemberRuntimeStreamSource` both call `OpenCodeRuntimeProjectionMapper`.
- Mapper fixtures prove non-string content blocks are not dropped like the stall-monitor mapper would drop them.
- `ResolvedTeamMember` exposes runtime/lane fields in TS: `providerBackendId`, `selectedFastMode`, `resolvedFastMode`, `laneId`, `laneKind`, `laneOwnerProviderId`.
- `MemberLogStreamSection` passes `laneId` for OpenCode member only when `laneOwnerProviderId === 'opencode'`.
- `MemberLogStreamSection` does not pass stale lane-like fields for non-OpenCode members.
- `MemberLogStreamSection` enables `setMemberLogStreamTracking(teamName, true)` while mounted and disables it on unmount.
- `MemberLogStreamSection` disables tracking for the previous team when `teamName` changes.
- `MemberLogStreamSection` coalesces duplicate background reloads while one request is active.
- `OpenCodeMemberRuntimeStreamSource` joins duplicate in-flight bridge calls.
- `OpenCodeMemberRuntimeStreamSource` bypasses completed cache on `forceRefresh` but still joins in-flight work.
- `MemberDetailDialog` renders `MemberLogStreamSection` when renderer gate is on.
- `MemberDetailDialog` renders old `MemberLogsTab` when renderer gate is off.
- `MemberDetailDialog` first-load stream error keeps Logs active and shows explicit old logs fallback.
- `ExecutionSessionsSection` remains unchanged and still renders legacy `MemberLogsTab`.
- `MemberLogStreamSection` reloads on same-team `log-source-change` and `task-log-change`, but not `tool-activity`.
- `MemberLogStreamSection` passes `forceRefresh: true` for `log-source-change` reloads only.
- `MemberLogStreamSection` does not pass `since` during renderer background replacement reloads in the first PR.
- `ExecutionLogStreamView` tests cover Date-shaped chunks and document whether JSON-like chunk normalization is supported.
- `ExecutionLogStreamView` preserves task tail-growth expanded state with task default keys.
- `ExecutionLogStreamView` supports a member source-aware `buildSegmentRenderKey` override to avoid provider/session collisions.
- `ExecutionLogStreamView` preserves unknown stream fields and member `segment.source` while normalizing chunks.
- Shared type tests or compile checks keep `MemberLogStreamResponse` standalone and keep `BoardTaskLogStreamResponse.source` task-only.
- `MemberLogStreamSection` renders provider/session/lane labels from `segment.source`, not from participant labels.
- `MemberLogStreamSection` keeps actor participant identity stable for one selected member across multiple providers/sessions.
- A member stream segment with `actor.memberName` and no `Process[]` still renders tool/output items.
- IPC rejects invalid `since`, clamps `limitSegments`, and accepts colon-containing lane ids.
- IPC accepts `primary` as a lane id.
- IPC preserves exact lane id casing/punctuation when passing options to the service.
- IPC rejects lane ids with control characters, NUL, newline, `/`, `\` or length over 256.
- IPC accepts boolean `forceRefresh` and rejects non-boolean values.
- IPC rejects unknown `getMemberLogStream` option keys before dispatching to the service.
- IPC validation helpers do not import non-exported `ValidationResult`.
- IPC registers/removes feature `MEMBER_LOG_STREAM_GET` channel.
- IPC registers/removes feature `MEMBER_LOG_STREAM_SET_TRACKING` channel.
- IPC handler calls the feature facade/use case with normalized options.
- IPC tracking handler validates `teamName` and boolean `enabled`, then maps to `TeamLogSourceTracker` consumer `member_log_stream`.
- `TeamLogSourceTracker` treats `member_log_stream` as a separate consumer from `task_log_stream`.
- Multiple member stream mounts for one team keep the watcher alive until all member consumers disable tracking.
- Disabling `member_log_stream` does not stop tracking while `task_log_stream`, `change_presence`, `tool_activity` or `stall_monitor` is still active.
- Existing `initializeTeamHandlers()` positional setup remains unchanged for task stream and exact-log services.
- Existing task stream IPC handler test remains a wiring smoke test proving the feature did not move legacy handler ownership.
- Browser-mode `httpClient` returns a complete empty member stream response.
- `ClaudeMultimodelBridgeService.getOpenCodeTranscript()` appends `--lane` only when provided.
- `ClaudeMultimodelBridgeService.getOpenCodeTranscript()` honors member-popup `timeoutMs`.
- OpenCode timeout/runtime missing becomes a warning and does not fail Claude transcript rendering.
- OpenCode ambiguity error becomes warning, not failed member popup.
- Codex member stream coverage is `skipped` unless explicit partial trace phase is implemented.

## Final Recommendation

Грамотная реализация варианта 2:

🎯 8.5   🛡️ 8.5   🧠 6  
Примерно 1500-2300 LOC вместе с тестами.

First implementation should be:

- Claude transcript stream complete enough for selected member;
- OpenCode runtime stream lane-aware and safe;
- Codex native explicitly skipped or partial-only behind separate follow-up;
- old member logs fallback kept;
- fallback decision kept at `MemberDetailDialog`, not inside shared `MemberLogsTab`;
- task `Execution Sessions` kept unchanged;
- feature gated;
- member stream tracking activated while popup Logs stream is mounted;
- backend budget enforced before renderer;
- renderer duplicate reloads coalesced while one member stream request is active;
- provider-neutral message hygiene extracted separately from board/task JSON sanitization;
- pair-aware message trimming used for oversized single segments;
- content-size budgets applied before chunk build;
- cumulative subagent refs deduped before parse;
- requested member names added to finder attribution set;
- finder third arg extended through backward-compatible numeric/null/object parser;
- `mtimeSinceMs` applied to lead transcript refs too;
- `src/features/member-log-stream` follows canonical feature layout with contracts/core/main/preload/renderer public entrypoints;
- app shell imports only public feature entrypoints and does not deep-import source adapters or use case internals;
- member segments include safe provider/session metadata;
- member stream uses source-aware segment render keys;
- OpenCode projection conversion extracted into shared mapper;
- OpenCode runtime transcript calls protected by source-local TTL and in-flight join;
- feature IPC registration is separate from legacy `initializeTeamHandlers()` service injection;
- browser fallback returns a complete empty stream response;
- `log-source-change` reloads use `forceRefresh`;
- source-port architecture used inside the canonical member-log-stream feature slice;
- no orchestrator code changes.

Это дает максимальный прирост UX с низким риском неправильных логов.
