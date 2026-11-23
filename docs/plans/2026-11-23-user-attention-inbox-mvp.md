# User Attention Inbox — implementation plan (not implementation)

Status: **Draft for agent handoff** · 2026-11-23 · Scope: **Attention Inbox only**
Baseline reviewed: `main` at `e876918f362e2fad55dbf47996e3ba346dbc22b9`.
Companion, independent research: `docs/research/2026-11-23-notification-channels-local-first.md` (separate PR, not a dependency).

## 1. Product contract

One reliable, reusable, live **Needs your attention** projection across all teams in the active workspace:

- Task items where `needsClarification === 'user'` (display team, task subject/display ID, and **time since the user was asked**, when known).
- Chat conversations with **unread messages actually addressed to the user**; display team, participant, existing avatar/preview/unread badges, and relative age of the **latest unread addressed message** (e.g. “8 min ago”), not the latest unrelated chat activity.
- A compact `AttentionInboxPanel` above `DashboardProviderSummary`, a dedicated `Attention` tab opened by a button **next to** the existing notification bell, and lightweight counts on the existing Running Teams cards.
- Dashboard chat viewport shows approximately 3 chat rows, then **vertical scrolling**. Full tab has an unrestricted scrollable list.
- Click a task -> its existing task-detail destination; click a conversation -> **the exact team and conversation scope**, not an unrelated member profile.
- Historic/stopped teams with unresolved work must remain visible. Existing notifications, sound/toast preferences and notification history keep their current behavior.

**Not in scope:** external delivery channels, Telegram, webhooks, generic alert priority engine, replying to messages directly from this widget, approval workflows, a new message database, server-side read-state migration, rewrite of team detail / Kanban, full browser messenger implementation, or arbitrary agent-to-agent unread traffic.

### Counters must be unambiguous

- `awaitingTaskCount` = number of distinct current tasks awaiting the human (not notification records).
- `attentionChatCount` = number of conversation scopes with at least one user-attention unread message.
- `unreadUserMessageCount` = number of distinct unread, user-addressed message keys across those scopes. Avoid counting the same message twice through team-feed + direct scope copies; pick one canonical attribution rule.
- Header may show two counts: tasks / chats, **not** add their units into one unexplained number.
- A badge is not a source of truth: viewing/clearing an OS notification never resolves a task or marks a chat read.

## 2. Existing code to reuse, and why

| Location | Existing contract / constraint |
| --- | --- |
| `docs/FEATURE_ARCHITECTURE_STANDARD.md` | Feature-first hexagonal layout, inward ports, renderer UI without store/Electron, IPC + HTTP route/client parity for new non-desktop use cases |
| `src/renderer/components/dashboard/DashboardView.tsx` | Render above `DashboardProviderSummary`, keep provider status untouched |
| `src/features/running-teams/renderer/ui/RunningTeamsSection.tsx` | Existing team cards are already clickable `button` elements — **never nest another button** inside them |
| `src/features/running-teams/renderer/hooks/useRunningTeamsSection.ts` | Existing global task summaries, team navigation and liveness; do not add another polling loop here |
| `src/renderer/components/layout/TabBarActions.tsx` / `PaneContent.tsx` / `src/renderer/types/tabs.ts` | Existing tab and toolbar composition; follow per-pane singleton pattern of `openNotificationsTab` |
| `src/renderer/store/slices/notificationSlice.ts` | Existing task/member deep-link logic, but its notification read state is **not** human attention state |
| `src/shared/types/team.ts` | `TeamTask.needsClarification` is a flag, not a `TeamTaskStatus`; `createdAt/updatedAt` do not record request time |
| `src/renderer/store/team/teamGlobalTaskNotifications.ts` | Already detects clarification transitions for OS notifications; never use its ephemeral de-dup sets as the inbox authority |
| `src/main/services/team/TeamDataService.ts` | `getAllTasks` truncates global projection to **500 tasks**; cannot derive trustworthy all-team counts from `globalTasks` |
| `agent-teams-controller/src/internal/taskStore.js` and `src/main/services/team/TeamTaskWriter.ts` | Multiple task write paths; timestamp changes must cover authoritative mutations, not a renderer-only surrogate |
| `src/features/team-direct-chats/renderer/index.ts` | Public exports for `ChatListRow`, `ChatUnreadBadges`, `buildChatListView`, `isUserAttentionMessage`, `isAttentionUnread` |
| `src/renderer/components/team/messages/useMessagesReadState.ts` and `src/renderer/hooks/useTeamMessagesRead.ts` | Existing read-set behavior; legacy direct messages and root-scoped groups differ |
| `src/renderer/utils/teamMessageKey.ts` and `teamMessageReadStorage.ts` | Preserve existing stable message keys and read tracking; do **not** introduce another independent read flag |
| `src/main/services/team/TeamMessageFeedService.ts` / `TeamInboxReader.ts` | Existing canonicalization and pagination; avoid making a parallel raw-file message reader |
| `src/shared/types/team.ts:TeamChangeEvent` and `src/renderer/store/index.ts` | Existing `task`, `inbox`, `lead-message`, config events; main forwards them to IPC and HTTP SSE |
| `src/renderer/api/httpClient.ts` | Legacy `getAllTasks` and `getMessagesPage` return placeholders. Add a functioning **new** attention HTTP route/client; do not silently use legacy empty responses |

Additional existing filtering of internal/bot/control messages: `src/renderer/utils/teamMessageFiltering.ts` and `src/renderer/components/team/messages/messagesPanelDerivedData.ts`. Prefer their currently public/reusable policy (extract if needed), never duplicate regexes.

## 3. Proposed thin vertical feature

```text
src/features/user-attention/
  contracts/index.ts                  # small validated DTOs / transport surface
  core/domain/attentionProjection.ts  # pure filter, identity, counters, ordering
  core/application/GetAttention.ts    # only if aggregation really crosses ports
  main/index.ts                       # single composition/public facade
  main/adapters/input/                # thin IPC and HTTP registrations
  main/adapters/output/               # existing task + message readers
  preload/index.ts                    # IPC bridge to shared renderer API
  renderer/index.ts                   # public Panel / view / hook entrypoints
  renderer/hooks/useAttentionInbox.ts # one shared read subscription, context-aware
  renderer/view-models/               # timestamps, truncation, display ordering
  renderer/ui/AttentionInboxPanel.tsx  # compact/full variants; no store/IPC
  renderer/ui/AttentionInboxView.tsx   # full tab wrapper
```

Do **not** create empty directories or a universal event-sourcing/notification platform. If existing team service can expose a narrow facade through an existing app API, keep the new `main` surface minimal. Follow `@features/user-attention/{contracts,main,preload,renderer}` entrypoints; no deep imports. Keep pure code free of Electron, Fastify, Zustand and filesystem APIs. Do not introduce a standalone daemon.

### Compact read DTO (concept, refine after spike)

```ts
type AttentionTask = {
  teamName: string; taskId: string; displayId?: string; subject: string;
  teamDisplayName: string; requestedAt: string | null;
  preview?: string; // sanitized, length-limited; can be absent
};
type AttentionChat = {
  teamName: string; scope: ConversationScopeDTO; // same direct/group/feed identity
  latestRelevantMessageAt: string | null;
  unreadUserCount: number;
  // existing chat view model's identity/preview data, no duplicated display policy
};
type AttentionSnapshot = {
  contextId: string; revision: string;
  tasks: AttentionTask[]; chats: AttentionChat[];
  complete: boolean; // false when a source is truncated/unavailable
  errorsByTeam?: Record<string, string>;
};
```

DTO shape is provisional. Reuse the stable conversation identity from `team-direct-chats` rather than introducing a second meaning for participant/scope. No user message bodies in global contracts by default; only a sanitized preview. Keep internal IDs stable across reorder. Deleted teams/tasks are excluded; **stopped** teams are not. If a completed task still has explicit `needsClarification='user'`, preserve it and flag inconsistent status for diagnostics rather than silently losing the pending human request.

### Time semantics (must fix, not fake)

Currently `updatedAt` is unrelated task file mtime. Add one optional persisted `clarificationRequestedAt` (or a narrowly scoped existing canonical equivalent, if found in the spike) maintained **only** on transition into `needsClarification='user'`:

- no reset on unrelated task edits or repeated same-value setter;
- clear on leaving that state; re-entry creates a new timestamp;
- cover controller, main writer, read normalization, compaction and cross-process DTO, regression-tested;
- legacy tasks without an authoritative transition timestamp show **"Waiting since: unknown"** (do not use `updatedAt` as an exact waiting time);
- relative label is derived client-side against a monotonic-enough wall clock and updated by one visible UI timer; do not refetch from disk every minute just to update text.

### Exactness of global chats (hard acceptance criterion)

Today chat read state is browser `localStorage`, group reads are context-scoped, and `MessagesPage` is paginated. A single 50-message head or 100 stored notifications **cannot** prove global unread counts.

Before implementation choose a bounded source plan that **reuses** current canonical message feed/read keys:

1. Read candidate *user-addressed* message identities and previews from existing normalized feed/reader, per team; filter internal/control messages according to existing shared policy.
2. Reconcile with the **same** read-key source used by Messenger, including direct vs group migration semantics; avoid marking as read merely by mounting Dashboard.
3. Use pagination/indexed projections or bounded per-team aggregation so unread candidates older than the first page are not lost. Only return small DTOs to renderer. Cross-device read synchronization is explicitly NOT part of this MVP; the UI must clearly reflect the current device's canonical read state.
4. Define an explicit `complete` flag and per-team errors for failures/partial history. Do not render a confident "0" while relevant teams are still loading or truncated.
5. When source performance cannot meet the budget without a new index/read-state authority, **stop and validate a focused spike** (see `4) before adding a second durable read store. No full history rescans on every UI event.

Choose stable attribution: count one message once in the global header while still allowing navigation to its direct or group conversation. Preserve `isUserAttentionMessage` semantics: explicit direct recipient or a genuine `@user` in group; normal group copies and agent/lead chatter must not inflate counts.

### Live updates without a second watcher

- Build one shared, context-scoped query/cache owner used by Dashboard, full tab, header and team cards. Multiple mounted surfaces must not produce duplicate refresh loops.
- Initial fetch, hydrate on app start; subscribe to **existing** `TeamChangeEvent` (`task`, `inbox`, `lead-message`, relevant `config`) through the shared API, including HTTP SSE.
- Debounce/coalesce per affected team, do **not** refetch all teams on every high-frequency event. Handle immutable snapshot revision and context epoch; discard stale in-flight responses after root switch, delete, rename, or tab churn.
- One bounded catch-up refresh on window focus/reconnect; **optional** low-frequency reconciliation while active (e.g. >=60 s), only if the existing watcher scope demonstrably misses changes for old/stopped teams. Reuse existing watcher/poll fallback; no independent filesystem watcher.
- Read operations are side-effect free. Data errors show explicit degraded state with Retry, not "no attention needed". New HTTP routes must use the current app's authentication/authorization and workspace scoping; do not accidentally expose conversation excerpts over unauthenticated LAN endpoints.
- Header summary can stay subscribed when full tab is closed; full rows load on demand only if the summary API needs separate pagination. Avoid expensive startup fanout. Measure idle CPU/network and update latency on a fixture with many teams; require event-driven updates to be promptly visible and catch-up after missed events without claiming a fixed latency from an untested watcher.

### Navigation/DRY UI

- One `AttentionInboxPanel` with `variant='compact' | 'full'`, optional team scope and callbacks, internally composed from existing Radix UI primitives; no `window.electronAPI` usage in UI.
- Use existing `ChatListRow` and `ChatUnreadBadges` in a **non-sortable**, compact list (reuse the row presentation, not full `ChatList`'s pin/DnD container); only filtered user-attention conversations. If a minimal option is needed on `ChatListRow`, add a backward-compatible presentation prop rather than copy-pasting it.
- In Dashboard show the panel **immediately before** the provider summary; hide compact empty detail with a calm zero-state, not a huge blank card.
- For live Running Teams counts, do not nest click targets inside its existing `button`. Either turn the outer row into non-button + sibling controls, or show noninteractive counts and preserve the card click.
- Header icon next to Bell; user-attention count is separate from generic notification unread count. Full tab is per-pane singleton, follows existing tab lifecycle and accessible focus.
- Task navigation reuse `openGlobalTaskDetail`; conversation navigation requires a **narrow** team+scope navigation intent (test reopening a different team and a group chat), rather than only `openMemberProfile`. Avoid a generic global router rewrite.
- Text localization via existing localization feature; no native `title` tooltips, proper labels/keyboard/focus, reduced-motion respectful relative time. Compact chat max-height from ~3 row heights with overflow-y-auto; the remaining chats are not dropped.

## 4. Delivery slices, order and change budget

Do **not** implement notification delivery in this PR.

| Slice | Production LOC (estimate) | Tests/E2E | Complexity / reliability / confidence |
| --- | ---: | ---: | --- |
| 0. Targeted spikes: unread correctness (pagination, group/direct, context), task transition write paths, navigate exact conversation | 0-150 | 100-250 | 6/10 · 8/10 · 7/10 |
| 1. Canonical task waiting timestamp + pure selection | 220-440 | 130-250 | 5/10 · 8/10 · 7/10 |
| 2. Reused task/chat candidate aggregate + one IPC/HTTP facade | 480-900 | 280-500 | 7/10 · 7/10 · 5/10 |
| 3. Event-backed shared read hook and context-safe refresh | 240-430 | 140-250 | 7/10 · 8/10 · 6/10 |
| 4. Dashboard, header, tab, Running Teams, compact/full panel & navigation | 550-850 | 270-480 | 5/10 · 8/10 · 7/10 |
| **Total budget, not a promise** | **1,490-2,770** | **920-1,730** | **6/10 · 8/10 · 6/10** |

If unread candidate backfill cannot fit these bounds, document measured counts/latencies and propose a separately reviewed extension; do not silently weaken accuracy. Estimated touched files: 15-30; avoid replacing large legacy slices. Use TypeScript 7 project toolchain, not TS 5.9; follow root ``AGENTS.md`` and `docs/GIT_DELIVERY_POLICY.md`.

## 5. Tests and E2E acceptance

- Domain: clarification transitions/re-entry, terminal/deleted handling, same-value setter, timestamp legacy fallback, age formatting (clock skew/invalid dates), stable sorting and dedupe across team/feed.
- Direct messages: unread only when addressed to user, no outbound/user-sent counts, group mention vs group copy, read keys, relay/synthetic/internal messages hidden, conversation scope identity.
- History: >500 total tasks with older awaiting items; unread in older message pages; >3 chats scroll; stopped team with pending item; archived/deleted and renamed team policy; per-team failure with truthful partial state.
- Lifecycle: multiple Dashboard/full/header mounts -> one refresh; event storm (task/inbox/lead-message), coalescing, reconnect, missed watcher catch-up; root switch mid-request does not leak other workspace data.
- Deep links: task detail; same-team direct; another-team direct; group chat; existing tab focused without duplicates; keyboard and focus.
- Transport: actual IPC and HTTP route/client contract parity including unsupported **legacy** browser APIs; zero false empty snapshots; no Electron globals in renderer components.
- E2E: use `pnpm dev:mcp` + actual Electron renderer/CDP and **only isolated test teams/projects**; exercise live file mutations and visual screenshots in light/dark if feasible. Do not drive real user teams.
- Preflight: focused unit/adapter tests, `pnpm lint:fast:files -- <changed files>`, `pnpm typecheck`, targeted E2E, then required CI on final HEAD. Never count skipped/queued/cancelled as PASS.

Definition of Done: exact, actionable live view and reliable direct/group navigation, correct badges, no false stale count after read/clear, no regressions in existing messenger and notifications, and no duplicate read-state authority.

## 6. Critical review and revisions baked into this plan

1. **Correctness pass**: initially considered `globalTasks` + 50-message heads; rejected as incomplete due to 500-task cap and paginated messages. Added a source-backed compact aggregate, explicit completeness and spike gate.
2. **DRY / domain pass**: initially considered another notifications list and per-widget unread flags; rejected because notification history and read state are not task state. Reuse canonical task flags, message identity, existing read keys, existing team change stream, `ChatListRow`.
3. **UX / runtime pass**: initially considered all-team polling and nested actionable badges on team card; rejected due to watcher churn, context races and nested buttons. Added one shared subscriber, per-team coalescing, exact-scope navigation and accessible card adjustment.
4. **Portability / security pass**: initial renderer-only hook would inherit empty browser `getMessagesPage`; require a small real HTTP attention facade now, isolate main readers, and keep payload snippets sanitized. Do not promise general HTTP messenger parity.

## 7. Explicit guardrails and agent handoff

Implementation agent should start by reading the named source files and rechecking HEAD for parallel PRs (especially team messages/notifications, task projections and UI refactor). Do a 1-2 hour equivalent **small evidence spike** in its working environment before changing multiple surfaces: enumerate >500 task case and an older unread case. Commit/push each meaningful slice to its own **Draft** implementation PR; keep this planning PR docs-only and do not merge it as evidence of completed feature. Prefer 2-4 iterations of focused technical critique during code work.

Open implementation choice: **how to compute exact cross-team unread counts without a duplicate persisted read model**. The plan deliberately requires empirical verification instead of claiming that one paginated head is sufficient.


---

## 8. Deep implementation pass — exact boundaries and non-obvious edge cases (2026-11-23)

This section refines sections 1–7 **without expanding scope**. Implementation is still NOT part of this PR. New code source facts were inspected from `main`.

### 8.1 New facts that change the previous design

1. `src/renderer/store/index.ts` only refreshes chat message heads for `isTeamVisibleInAnyPane(teamName) || hasActiveTeamPendingReplyWait(teamName)`. A global Dashboard cannot rely on those cached heads for other teams. **New attention candidate projection needs its own bounded, source-backed read contract** — but not a second on-disk store or file watcher.
2. `src/main/index.ts` forwards `TeamChangeEvent` both to IPC and the existing HTTP `team-change` SSE channel; `src/renderer/api/httpClient.ts` already exposes `teams.onTeamChange` using `EventSource`. Reuse this exact event surface; no new SSE topic, WebSocket or polling subsystem.
3. `src/renderer/utils/teamMessageReadStorage.ts` uses bare `teamName` in legacy direct-message `localStorage` keys; `useMessagesReadState` context-scopes **group** reads but passes legacy direct reads without `contextId`. Same-named teams under different roots can currently alias local read state; **attention must not silently propagate or amplify this bug**.
4. `src/renderer/components/team/messages/MessagesPanel.tsx` uses `useTeamConversationSurface`, which initializes a conversation from `teamSidebarUiState`. The team tab may already be mounted; writing a key to the sidebar map alone is **not** sufficient to navigate a live mounted pane. A small consumed navigation intent is needed.
5. `src/features/team-direct-chats/core/domain/countUnreadByConversation.ts` includes `team-feed` in scopes alongside direct conversations. Counting both as independent user chats would double-count the same message. Group message identity requires `message.groupMessageId===message.messageId`; duplicates must be collapsed before counting.
6. `src/features/team-group-chats/renderer/hooks/useTeamGroupChats.ts` has an independent 5-second visible polling interval. **Never mount one of these hooks per team in global Attention**; use existing main-owned group catalog/message contracts instead.
7. `src/renderer/utils/teamMessageFiltering.ts` includes important relay/noise/automation dedupe, but imports renderer-specific utils. Don't call it from main or duplicate its policy wholesale. Extract only a **pure, tested relevant predicate** to an existing appropriate shared/domain entrypoint if necessary.
8. `src/main/services/team/TeamTaskWriter.ts` writes `needsClarification` without transition timestamp; controller `agent-teams-controller/src/internal/taskStore.js` has its own setter. Some agents may write task files externally. Time must be authoritative **when recorded**, unknown for legacy/external direct writes.
9. `src/main/services/team/TeamMessageFeedService.ts` has cache/revision mechanics and the paginated message path `TeamMessagePageRead` already exists. A naive fetch of every team on every inbox event, or an arbitrary 50-message head, is both expensive and incomplete.

### 8.2 Recommended data algorithm, with one explicit spike decision

**Do not build a persisted global inbox.** The canonical task files, normalized message feed, and existing local read keys remain authoritative. Compute a read-only **derived projection**.

**P0 spike selects one of two small strategies** (no UI or new persistent state during the spike):

- **A — compact candidate projection (preferred if bounded):** main-owned service enumerates all eligible task rows **before** global 500-task truncation and normalized human-directed message candidates from existing readers. It returns only identity, context, scope, timestamp and **short sanitized preview** (no entire message feed). Renderer combines with the **existing** direct/group read key sets, groups by canonical conversation and computes counts.
- **B — query with read keys (fallback when candidate payload too large):** renderer passes existing context-scoped read-key snapshots per affected team to a validated `GetAttention` request; main-owned service computes and returns bounded unread aggregates, eliminating large candidate payloads. Read keys remain client-owned; never persist the same unread state a second time. HTTP uses an authenticated POST for request body if this strategy is chosen.

**Acceptance constraint:** show counts as authoritative only when full relevant candidate space was actually examined. With unlimited old message histories, bounded pages without proof of completeness are NOT correct. A request may be paged, but **header 0 cannot be shown until aggregation is complete**. Do not add a giant message index just to meet an optimistic performance goal; instead measure P0 and document a separate small prerequisite if needed.

Minimal protocol shape to decide in P0:

```ts
type AttentionScope = { contextId: string; teamName: string };
type AttentionTaskCandidate = {
  taskId: string; subject: string; displayId?: string;
  requestedAt: string | null; preview?: string;
};
type AttentionMessageCandidate = {
  identityKey: string; scope: ConversationScope;
  observedAt: string | null; preview?: string; from: string;
};
type AttentionTeamResult = {
  scope: AttentionScope; tasks: AttentionTaskCandidate[];
  messages: AttentionMessageCandidate[];
  completeness: 'complete' | 'partial' | 'unavailable';
  reason?: string;
};
```

These are **illustrative DTOs, not a second chat-domain model**. Use the existing `ConversationScope` semantics and stable task/message keys; choose the actual JSON DTO contract after the source spike. Avoid storing raw user tokens/credentials in any projection.

### 8.3 Filtering, grouping and duplicates — deterministic rules

**Tasks**
- Filter by `needsClarification === 'user'`; exclude `status==='deleted'`, `deletedAt`, and deleted teams; **do not require team liveness**.
- A completed/review task with explicit human clarification flag is still visible (surface "state inconsistent" only in detail/diagnostics). Ignore `needsClarification==='lead'` and normal `blockedBy` for the human count.
- Key by `(contextId, teamName, taskId)`; never rely on display ID uniqueness. Renames, deletes/recreates, root changes and returned out-of-order snapshots must be fenced.
- Determine reason preview only from a proven clarification comment/request; do not use arbitrary **latest** task comment as the requested question. Fallback to subject. Strip agent-only blocks and bound lengths.

**Chats**
- Keep only visible, genuine **user-attention unread** messages, according to the same published `team-direct-chats` semantics (`isUserAttentionMessage` + `isUserUnreadMessage`). Ignore agent→lead messages, user-sent/outbound copies, internal control, idle/status noise, automation nudges, and relayed duplicates.
- Canonical attribution: a canonical `groupChatId`/`groupMessageId` (explicit `@user`) belongs to **group**; normal message with recipient `user` belongs to **one direct conversation** with real sender (lead aliases normalized). `team-feed` is not an additional chat in the global attention list. If sender cannot be resolved, provide one named team-level fallback **not** an invented DM.
- Unique message identity is first normalized/deduplicated from existing feed, then keyed by `(contextId,teamName,messageKey)`. Do not count the same user-directed content once in group, once in team-feed, and once in relay.
- For each chat row, preview/timestamp reflect the **newest relevant unread** user message, not the newest outgoing or agent-to-agent chatter. Existing `ChatListRow` visual presentation is reused with this projected view model.
- Groups are allowed only if actual stored group metadata and user-directed mention are proven. Archived groups: preserve explicit unread @user unless existing Messenger semantics prove archive suppresses them; otherwise show the conversation as archived in a detail view rather than silently losing it.
- Older unread messages beyond first page, invalid timestamp, duplicate IDs, deleted member, renamed member, cross-team qualified participant, and out-of-order file timestamps require dedicated test fixtures.

**Read state**
- Reuse `teamMessageReadStorage` / `useTeamMessagesRead` storage keys and public policies. Dashboard subscription MUST NOT call `markRead` or `markAllRead`, nor seed read backfill from truncated candidate history.
- Resolve the cross-root legacy direct read key collision before E2E signoff: either an **in-scope minimal compatibility fix** to the existing Messenger read key scope, with careful one-time migration only where ownership is unambiguous, or explicit release gate proving existing context isolation is correct in the selected modes. Never create a second new attention-only read store.
- Read updates must immediately rederive attention from local read subscription, even if no `TeamChangeEvent` occurs. Other browser windows may require the native `storage` event; don't rely solely on same-process listener if multiple windows are in scope.
- If localStorage is disabled/full/corrupt, reflect degraded state or safe fallback; do not tell user the messages were successfully marked read.

### 8.4 Live subscription: one owner, not N component effects

Single `useAttentionSnapshot` / query coordinator shared across header, compact Dashboard, full tab and Running Teams. Prefer one app-lifetime existing store/composition event owner (or a thin feature-local singleton) over **four** unrelated refresh hooks.

| Trigger | Work | Refresh strategy |
| --- | --- | --- |
| App init / active context switch | enumerate scope and fetch initial summary | request epoch fenced, no old-root content leakage |
| `task` change, known `taskId` | invalidate affected team task candidates | coalesce/re-read affected team only |
| `inbox` / `lead-message` | invalidate candidate messages for affected team | coalesce per team, use source revision; no N-way full history requests |
| `config` / team deletion, restore, rename | update team identity/scope, visibility, route | discard removed team candidates; full team membership reconcile |
| Local read-set change | recompute affected chat counts | **client-only**, no task I/O |
| Focus/resume / SSE reconnect | bounded reconciliation | one shared catch-up; no timer per mounted widget |
| Last tab closes | release full-detail subscriptions | header summary only; no stale live UI badge |

**Important:** existing central store intentionally ignores messages from untracked hidden teams. The feature must subscribe once to the shared `api.teams.onTeamChange` without re-enabling heavyweight hidden `refreshTeamData` globally. Existing main FileWatcher may watch only active/recent team directories, so measure old/stopped team freshness and enable bounded catch-up **only where needed**; do not pretend old-team filesystem events are guaranteed.

Acceptance recommendation (measure, do not claim without E2E): under regular fs.watch, local UI visibly updates on user-attention events promptly (target p95 ≤2s); under watcher polling fallback, target ≤5s plus measured debounce/catch-up. For slow/offline sources, show partial/stale indicator and retry; never silently claim zero.

### 8.5 Exact navigation and tab lifecycle

- Header icon opens/focuses `Attention` tab as **per-pane singleton**, like `openNotificationsTab`. Tabs can remain mounted but hidden; opening focus must refresh stale snapshot once, without doubling the global subscriber. Update tab union, icon, lazy pane content, and tab tests in one integration lane.
- Task row invokes existing `openGlobalTaskDetail` with context guard and task ID. No new task detail modal.
- Chat row calls a **narrow** `openTeamConversation({contextId,teamName,scope,nonce})` (name illustrative): activate existing team tab or open it; send one-time intent consumed by the **already-mounted or newly-mounted** MessagesPanel; set conversation surface to thread and exact scope; optionally expand messages area. Do not mutate `teamSidebarUiState` alone as a shortcut.
- Navigate once per nonce, preserve pinned chat order and drafts, and avoid `markRead` before actual view/visibility. Test clicking the same chat twice, chat B after A, cross-team, group ID, pane focus changes, slow team loading, deleted target, same team-name across roots and multiple tabs.
- Running team card either has **read-only badge indicators** on existing root button (recommended v1), or needs a valid sibling action layout. **No nested interactive buttons**.

### 8.6 No overengineering: out-of-scope explicitly enforced

Do not introduce a generic distributed event ledger, new DB tables, plugin platform, a second message feed, server push broker, global durable read index, a new Redux/Zustand store with duplicated source arrays, new cron/scheduler, per-team `useTeamGroupChats` hooks, platform-wide team ID migration, automatic agent response detection, tool approvals, notification-channel settings, or a general HTTP chat backend.

Allowed narrow adjacent fixes **only** when required for truthful Attention Inbox: task waiting transition timestamp; small read-key workspace-scope compatibility fix; pure message visibility predicate extraction; exact-conversation navigation intent; one small attention IPC/HTTP read endpoint.

### 8.7 Concrete phases and safe parallel work (implementation agent handoff)

| Phase | Owner / main files | Independent work / prerequisite | Deliverable |
| --- | --- | --- | --- |
| **P0 — proof and interfaces** | 1 integrator: inspect `TeamTaskReader`, `TeamMessageFeedService`, `useMessagesReadState`, existing HTTP/SSE, measure >500 tasks and unread beyond 50 messages | **Blocking** for aggregate implementation; no speculative implementation yet | Choose candidate/read-key join A/B; signed-off DTO & scope rules, known perf budget |
| **P1A — task semantics** | Agent A: `agent-teams-controller/src/internal/taskStore.js`, `TeamTaskWriter`, `TeamTaskReader`, `TeamDataService` and relevant shared types | After P0; **parallel** with P1B/P1C | Durable optional `clarificationRequestedAt` from authoritative transitions, pure filtering, tests |
| **P1B — chat/read semantics** | Agent B: `team-direct-chats` pure domain, existing message filter/read-key entrypoints, source candidate projection | After P0; **parallel** with P1A/P1C | No copied chat logic; correct user-only unread and root-scope handling, tests |
| **P1C — UI isolated** | Agent C: new `user-attention/renderer/ui`, view models; shared Radix visual primitives; localization keys | After DTO agreement; **parallel** with P1A/P1B; avoid touching shell | Pure compact/full panel with fixture-only stories/tests, 3-row scroll |
| **P2A — service and transport** | Integrator: `user-attention/core/application`, source adapters, `main/composition`, IPC/preload/HTTP route and client | Depends on P1A & P1B | One read facade/contract, no new backend daemon |
| **P2B — navigation and shell** | Agent D: `tabSlice`, `tabs.ts`, `PaneContent`, `TabBarActions`, `DashboardView`, `RunningTeamsSection` | Can begin after DTO agreement, parallel to P2A; **one shell owner** to avoid conflicts | Exact navigation action and badges, no nested buttons |
| **P3 — integration/E2E** | Integrator + independent reviewer | After P2A/P2B; not parallel to uncontrolled branch mutations | E2E on one final HEAD, CI, review, screenshot check |

**Parallel boundaries:** A writes task/domain reader paths, B chat/read domain paths, C new UI paths, D existing shell/tab paths. The **integrator owns** composition/bridges and shared contract changes; other agents propose contract changes instead of independently editing the same `index.ts` or root store. No 4-way parallel edits to `src/renderer/store/index.ts`, `src/main/index.ts`, `src/shared/types` or localization same files. Use one Draft implementation PR/branch for this one feature (separate from this docs PR and from Notification Channels). Each resolved lane commit is pushed immediately; rebase/merge carefully and run final tests on the actual merged HEAD.

### 8.8 Revised per-phase LOC, time and confidence

Replaces the rough `4` estimate if P0 uncovers read-scope migration and exact global projection work:

| Phase | Production LOC | Test/E2E LOC | Difficulty 1–10 (10 hardest) | Confidence |
| --- | ---: | ---: | ---: | ---: |
| P0 source/proof/fixtures | 0-100 | 120-250 | 6 | 8/10 |
| P1A task timestamp + projection | 250-500 | 160-320 | 5 | 7/10 |
| P1B candidate/read semantics, scope fixes | 300-650 | 250-500 | **8** | **5/10** |
| P1C presentation components | 300-550 | 170-280 | 4 | 8/10 |
| P2A IPC/HTTP/fanout coordinator | 400-750 | 250-420 | 7 | 6/10 |
| P2B header/dashboard/tab/nav | 350-650 | 230-390 | 6 | 7/10 |
| **Total (approx., overlap avoided)** | **1,600-3,200** | **1,180-2,210** | **7** | **6/10** |

No wall-clock guarantee: P0 proof can reduce or increase this range. Complexity and fidelity matter more than impressive LOC minima.

### 8.9 E2E regression matrix — add these beyond `5`

| Scenario | Required observation |
| --- | --- |
| 501+ tasks: oldest awaiting human | exact task still appears, not truncated |
| Oldest unread before first 50 messages | chat count nonzero after complete projection |
| Inbox group copy without `@user` | **not** attention |
| Group canonical reply with `@user` | appears once in correct group and opens group |
| Lead alias / duplicated relay vs direct user message | one conversation + one message count |
| Hidden team receives direct message | Dashboard/header update without opening team |
| Stopped team, no current watch event | focus/reconnect catch-up eventually shows task/message |
| Same-named team in two context roots | no cross-root read-key or snapshot leakage |
| Empty/invalid `requestedAt`; older task | label "time unknown", never fabricated "2h" |
| Repeated `needsClarification=user` write/unrelated comments | timestamp preserved; no notification re-created by new widget |
| Read conversation in Messenger | existing read-store event reduces Attention immediately without network resend |
| Dashboard mount with unread | does **not** mark read |
| Same chat clicked again when team tab already mounted | exact thread focus again; no stale other conversation |
| Rapid A→B root switch during response | old response dropped, zero cross-context leak |
| Many team events while multiple tabs mounted | bounded/collapsed fetch count; no per-panel polls |
| HTTP browser client + SSE | real typed read endpoint, response with completeness; no silent fake empty |
| Partial failure / no storage / offline | explicit degradation, Retry, no false "nothing needs attention" |
| Light/dark + narrow layout + keyboard | accessible title, badge, three-row viewport + scroll, tooltips Radix |

### 8.10 Additional four rounds of critique and corrections

1. **Real data-flow audit:** read `shouldRefreshTeamMessages` and identified **hidden-team starvation**; corrected plan from "use store cache everywhere" to a single bounded source-backed projection, reusing existing watcher/SSE.
2. **Read-state identity audit:** examined `useMessagesReadState` and found direct keys are legacy teamName-scoped while groups are context-scoped; made cross-root collision an explicit acceptance gate rather than introducing a new, inconsistent inbox-only read database.
3. **Interaction / consistency audit:** checked `useTeamConversationSurface` and `MessagesPanel`; a prefilled sidebar map cannot reliably navigate an already mounted pane; added consumed nonce navigation intent. Also excluded duplicate team-feed scope and unrelated newest chat activity from previews.
4. **Scope / performance audit:** rejected mounting all group hooks (each polls) and reading full history per event, or pushing all 500-task-limited legacy snapshots. Defined P0 performance proof, separated tasks/chat/UI/shell owners, and retained one shared IPC+HTTP feature API with no general platform rewrite.

**Status:** Plan refined and ready for implementation handoff **subject to P0 correctness spike**. This documentation PR is not implementing the feature and should not be merged as a completed E2E feature.
