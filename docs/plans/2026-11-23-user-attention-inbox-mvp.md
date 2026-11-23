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
