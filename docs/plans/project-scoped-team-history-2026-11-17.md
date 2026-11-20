# Project-scoped team history (desktop) — implementation plan

> **Status:** design only; no production implementation in this PR. **Baseline:** `main`, inspected 2026-11-17. **Related request:** [#205](https://github.com/777genius/agent-teams-ai/issues/205).  
> **Owner decision:** existing teams retain shared history; newly created teams default to project-isolated history, with an explicit per-team Shared / Per project option chosen in Create Team only. **Update after implementation:** the mode is fixed at creation and cannot be changed afterwards (#1237, #1238).  
> **Target:** one visible reusable *team definition*; independent *work history* (tasks, chats, sessions) per project, without introducing reusable individual agents.

## 1. Outcome and invariants

- **Legacy:** a team created before this feature, with *no mode field*, behaves byte-for-byte as today (`shared`). Merely listing/opening a legacy team MUST NOT rewrite its config, tasks, sessions, or messages.
- **New team:** every new-team creation path (blank, copy, template, organization, desktop folder-import that creates a draft, supported HTTP/API) persists `per_project` unless the user explicitly selects `shared`. A **restore of an existing saved app team/backup** preserves the stored mode; never guess it is a new team. Legacy external API clients must receive an explicit documented default rather than a silent renderer-only change.
- **Per project:** switching the selected project changes the team's visible task board and chat history to that project's durable workspace. Returning to the prior project restores that workspace, including its task IDs, messages, groups, and sessions. The roster, roles and team-level preferences remain shared.
- **Shared:** retains current project-switch behavior and existing storage. No hidden change to existing team runtime semantics.
- **Scope of isolation:** work history, not a security sandbox. It does not restrict filesystem visibility, shared provider memory, MCP roots, credentials, or access to other project folders.
- **At most one live work context per logical team in v1.** Browsing project B while A runs is allowed; launching B while A is alive/degraded/stopping is rejected with an actionable Stop A message. Do not silently stop, migrate, reuse, or attach A's runtime to B.
- **No mixed reads/writes:** a task/message/notification/review/queued send belongs to the context captured at admission. Never retarget a delayed result using the renderer's current project.
- **Fail closed:** missing/corrupt context mapping, unknown explicit mode, foreign-profile ownership or ambiguous runtime lifecycle cannot silently fall back to `shared` or another project.

## 2. Evidence from current code

| Area | Observed existing behavior | Implication |
| --- | --- | --- |
| `src/shared/types/team.ts` | `TeamConfig` has `projectPath`, `projectPathHistory`, `leadSessionId`, `sessionHistory`; `TeamTask` has optional `projectPath` | A task field/UI filter is *not* authoritative isolation; team session histories can span projects |
| `src/main/services/team/TeamTaskReader.ts` / `TeamTaskWriter.ts` | Tasks at `getTasksBasePath()/teamName`; IDs and caches are team-scoped | Give each work context an isolated runtime task namespace; task ID alone is not globally unique |
| `agent-teams-controller/src/internal/runtimeHelpers.js` | Controller derives team, task, Kanban, process paths solely from `teamName` | A project-specific internal **execution team name** can reuse existing runtime-compatible storage rather than forking the controller |
| `TeamInboxReader` / `TeamSentMessagesStore` / `GroupChatStorage` | Inbox, sent, group registry/reactions live under `~/.claude/teams/<teamName>` | Project filtering in the renderer is insufficient; direct and group messages must route to their own physical context |
| `TeamMessageFeedService` | Merges inbox + lead-session messages + sent messages + synthetic bootstrap; caches per team | Context-safe feed needs isolated sources and context-fenced pagination/cache |
| `TeamProvisioningConfigMaintenance` / `TeamProvisioningLaunchTeamFlow` | Launch changes `config.projectPath`, stores session history, reads existing tasks into the bootstrap prompt | Launch/recovery must resolve context *before* snapshot, prompt hydration, session attribution or process spawn |
| `TeamConfigReader` / `team-fs-worker` | Both can list physical team directories, including draft teams | List must present one logical team; don't leak internal instances or hide unverified foreign teams |
| `TeamMetaStore` | `team.meta.json` is app-owned but reads/serializes an allowlist; unknown fields are dropped | Extend validated metadata read/write atomically; absence means legacy shared, invalid explicit value means error |
| `TeamProfileOwnership` / backups | `~/.claude/teams` is shared across app profiles and native CLI; marker checks gate mutations; backup enumeration is explicit | Preserve profile fences and include logical/context mapping in restore/delete; never clean an unknown directory |
| `teamSlice` / `teamDataRequestKeys` / token usage / schedules | Requests, UI caches, token runs, and scheduled runs are keyed mainly by `teamName`; schedules contain `cwd` | Distinguish logical team, selected work context and physical execution team in projections and background actions |

Runtime paths, overview: [controller](../../agent-teams-controller/src/internal/runtimeHelpers.js), [service](../../src/main/services/team/TeamDataService.ts), [group storage](../../src/features/team-group-chats/main/infrastructure/GroupChatStorage.ts), [ownership](../../src/main/services/team/provisioning/TeamProvisioningProfileOwnership.ts).

## 3. Minimal architecture (decision)

**Prefer one narrow `TeamWorkContextResolver` at the application use-case/composition boundary**, not a second task/chat database, generic routing framework, or project parameter threaded through every native CLI call. Existing lower-level services continue receiving a verified physical `teamName`. Place the core policy/contracts in a small `src/features/team-project-context/` slice, with main-owned persistence/composition and a renderer-facing API where needed. Reuse existing CLI/controller storage implementations; no duplicate task/message repository.

- **Logical team:** the user-visible team (stable logical identity, name, shared roster and preferences, isolation mode). Legacy physical names remain unchanged. Keep this definition distinct from each native runtime instance.
- **Work context:** immutable `workContextId`, owning `logicalTeamId`, canonical `projectKey`, display `projectPath`, physical `executionTeamName`, lifecycle and schema version. One context per logical team/project. Prefer one bounded, app-owned, versioned `team-project-contexts.json` adjacent to the logical team's metadata, with existing atomic write/lock primitives and explicit backup inclusion; do not store an unbounded context map inside `team.meta.json` or add a new database. A reserved → ready transition is enough for crash reconciliation (not a generic workflow engine).
- **Physical execution team:** a normal, existing-format CLI-compatible team directory + task directory named by a collision-safe, opaque, short internal ID. Source of truth for that context's tasks, Kanban, direct/group messages, member/runtime evidence, session history and attachments. `TeamRequestValidation.assertProvisioningTeamName` currently limits names to kebab-case and 64 characters; generated IDs must satisfy this *and* native CLI/runtime validation. The internal name is never user-input or a raw project-path hash, and name prefix alone never proves ownership.
- **Ownership:** persistent mapping and existing profile ownership markers *both* must validate before resolve, mutate, restore, stop or delete. Reserve/check namespace against all actual team directories. **Crucial:** `claimExistingTeamForLaunch()` intentionally can take ownership of a foreign team for an *explicit ordinary launch*; internal context resolution must **reject foreign/mismatched aliases before reaching this call**, not rely on a downstream claim to prove safety. Never kill based on stale `projectPathHistory`: process ownership uses the current on-disk project path, run identity and existing ownership evidence.
- **Project identity:** derive a validated absolute/canonical key using existing project selection, including explicit repository/worktree identity where available. Two user-selected distinct worktrees count as separate projects; automatically generated member worktrees do not. Handle Windows case/path separators, symlink aliases and missing paths deliberately; compare verified paths, never raw basename or `projectPathHistory`. Keep stored stable `workContextId`, so a moved/renamed folder cannot silently reassign history. Path hashing may derive an index key, **never** authorize filesystem access.
- **Context binding:** an admitted IPC/HTTP/MCP/scheduler command carries or resolves an explicit, verified work-context identity. Context is bound once at admission and checked against runtime run/generation for deferred callbacks. Main owns resolution; renderer never supplies a privileged physical name.
- **Read projections:** map physical records back to `logicalTeamId + workContextId` (plus task/message ID) at *one shared application projection boundary*. `TeamConfigReader` has worker and in-process list implementations: avoid duplicating policy inside both. Preserve raw/foreign/native visibility, fold only **verified owned aliases** into one logical team, and do not let `getAllTasks()` or backup discovery expose aliases as unrelated user teams. Global All Tasks may aggregate **with explicit project labels**; a specific team/project board must never aggregate.
- **Config authority:** shared roster/role/prompt edits belong to the logical definition. A stopped context gets a validated projection of current shared configuration at next launch; **never copy** old tasks/sessions/inboxes. Runtime-originated roster edits need explicit reconciliation through existing team management rather than silent overwrite. The projected physical `config.json` belongs to the native runtime; do not let app metadata updates fight concurrent CLI writes. Team **display rename** retains stable logical/context IDs and cannot reassign physical aliases; protect draft rename and member add/remove paths in targeted tests.
- **Creation authority:** extend `parseCreateTeamRequest`, `createDraftTeamConfig`, `TeamMetaStore` read **and** serializer, creation-draft persistence/validation, and typed IPC/HTTP contracts. `team.meta.json` explicitly records `projectContextMode`; the distinction between *missing legacy field* and *new omitted create input* is resolved only at the creation command. `createDraftTeamConfig` currently creates empty `teams/<name>` **and** `tasks/<name>` directories: for per-project these are a logical definition/draft, never an implicitly writable shared physical context. A new team may be a draft without a selected valid project, but per-project launch, task or message dispatch requires one.

### Avoid

- No independent copies of the same team shown as user-created teams.
- No speculative per-provider storage adapters or cross-feature generic repository/router abstractions.
- No automatic moving/splitting existing JSONL by timestamp, guessed `cwd`, or content.
- No path-based rewrite of all native Claude/Codex/OpenCode task/chat internals; reuse the known team-name boundary unless a targeted sandbox proof falsifies compatibility.

## 4. Durable product behavior

| Operation | `shared` / existing | New `per_project` |
| --- | --- | --- |
| Create blank / from template / copy | New team mode only if explicitly selected | **Default** for any new team; clear control in Create screen |
| Select project A, then B, then A | Current combined history | Switch to B's independent history; revisit A restores it |
| No selected or valid project | Current behavior | Draft readable; do not dispatch task/message/launch without explicit project |
| Open team while A is running, selected B | Current behavior | Show B history + prominent 'Running in A' status; Stop A before launching B |
| Create / update / comment / review a task | Existing team task namespace | Target current *captured* context; references include work-context identity |
| Direct, group, lead, cross-team messages | Current address and feed | Separate durable inbox/sent/group/session sources; no last-selected-project routing |
| View All Tasks / notifications | Existing aggregate | Aggregate only where already supported, annotated with source project; opening routes to exact context |
| New schedule | Existing team and `cwd` | Bind target context at creation; never infer project from last active tab at execution |
| Restart app, resume/restore | Existing behavior | Rebuild the same mapping and context history; no duplicate workspace or cross-project resume |
| Delete/restore/backup | Existing team | Treat logical team and all *owned* contexts coherently, preserve index and per-context artifacts |

**Mode switching: not supported.** The mode is chosen in Create Team and stays fixed for the life of the team; legacy teams stay `shared`. The switching UI, the IPC/HTTP entry points and the retained-history states were removed in #1237 and #1238. The `redirect` from a physical project alias to its logical team and project is kept. (The original switching design was dropped: switching needed a confirmed stop of all contexts, quiescence validation and a retained-history model, which is not worth the risk for an unreleased feature.)

**Teams from old data:** absence of `projectContextMode` on an **already persisted** team, including a config-only draft created before rollout, means `shared` until explicitly changed. Invalid present value fails validation; **not** the legacy fallback. An unsent **renderer-only** creation draft with no mode field is still a new team: migrate its snapshot schema preserving all existing fields, initialize the new option to `per_project` and persist the user's explicit change. Copy and desktop folder-import that create new teams default per-project even when their source content predates the feature. Backup restore keeps its stored mode (or legacy shared when absent).

**Cross-team messaging:** existing shared teams keep unchanged addressing. For per-project recipients, route to a verified context for the **sender's explicitly bound project** (or a user-selected target context if supported); otherwise return an actionable ambiguous/unavailable-target error. The existing `CrossTeamService` writes directly to the target's inbox: resolve/authorize **before** creating outbox or delivering, not after. Never create a context or select the target's most-recent project just to deliver.

### Context-safe asynchronous/UI rules

- Project selection is a **view change**, never an implicit Stop, Launch, Resume, roster edit or migration. An absent context renders a truthful empty state without creating folders on a read-only navigation.
- Distinguish existing global `activeContextId` / manual-message `QueueScope.contextId` (app/host context) from new `workContextId` (team + project). They are not interchangeable. The read key and optimistic-send/queue identities need both where applicable.
- In `teamDataRequestKeys`, `teamMessagesCache`, selected task-detail identity, message pagination cursors, direct/group thread state, read/unread counters and notification routing, fence by work context **and** run/generation. A late A response after switching to B is dropped from B's visible state, while A's durable result is still stored under A.
- `TeamMessageFeedService` includes a live lead overlay, durable inbox, sent messages and session-derived messages. Bind **every** source to the same execution context before merge; do not use timestamps or selected `projectPath` to split an already merged feed.
- Existing `teamMatchesProjectSelection` matches historical paths for team discovery. For per-project history selection, historical paths may reveal available contexts but **must not** authorize current project reads or runtime/process ownership.
- Team row remains one logical team. In a selected project with no context yet, show an empty scoped Tasks/Messages view. If another project A has a live run, display `Running in A` and provide the normal Stop action; never present A's current task as B's work.
- A schedule created for a per-project team is durably bound to a single work context; no 'last selected tab' inference on execute/retry. On mode change, reject while affected schedules are active, or require explicit pause and later rebind; do not leave silent future deliveries into a hidden old context. Existing shared schedules keep current behavior.
- Cross-team messages with no unambiguous destination context fail before side effects. A source context may address a shared target through its existing behavior. Provider/remote clients that cannot express the required context receive a typed, actionable unsupported/ambiguous error, not an automatic shared fallback.

## 5. Work breakdown (future implementation PRs; NOT this docs PR)

1. **Contracts / persistence:** add two-mode policy, legacy-safe parser, logical/context identifiers, collision-safe mapping, atomic create/reconciliation and profile validation. Extend `parseCreateTeamRequest`, `TeamMetaStore` read/serializer, IndexedDB `createTeamDraft:form` v1 migration, IPC/HTTP contracts and desktop import drafting; add one verified projection after worker/in-process listing. First tests: legacy no mutation, old persisted draft is shared, unsent restored form is a new per-project default, copy/import/backup semantics, double-create idempotency, foreign-profile rejection, worktree identities.
2. **Launch / runtime routing:** add one resolver at the existing team use-case/composition boundary; materialize native-compatible physical team with shared roster but clean history. Bind run ID to work-context identity; fail closed on A-running/B-launch, app restart, cancellation and degraded runtime. Confirm controller, orchestrator and OpenCode primary/secondary use the intended context, not just renderer tasks.
3. **History routing:** task board, comments, references, attachments, Kanban, direct/group/lead messages, paging, revisions, read/unread, queued sends and log/session resolution. Preserve original context on async work and cache invalidation; test A/B same numeric task ID or member name.
4. **UI / background / lifecycle:** mode selector in Create Team only, project switch with truthful active-run indicator, per-context UI request keys, global projections, notifications, schedules, cross-team, auto-resume, member work sync, token usage and safe delete/backup/restore. Integrate in narrow seams; avoid editing unrelated provider internals.
5. **Qualification / release:** run unit + integration + sandbox Electron E2E on real IPC/storage/rendering for A→B→A + restart; provider compatibility (Claude, Codex, OpenCode and mixed lanes), multi-OS path identity and old-profile preservation. Only activate default after all required checks pass on the exact current HEAD.

Implementation may be split into smaller stacked PRs with a hidden opt-in behind the composition layer until all data paths are complete. Do **not** ship a partial UI-only 'isolated' mode.

## 6. Acceptance matrix / evidence required

- [ ] Fresh new team defaults `per_project` in UI *and* backend API; explicit `shared` persists across restart. Existing no-field teams remain shared, including after list/read/backup; copying an old team defaults per-project.
- [ ] A→B→A: independent tasks (including deleted, comments, dependencies, task references and Kanban), chats (DM, group, lead, sent), read state and session provenance; same task ID across contexts never cross-links.
- [ ] Native agent-originated task creation and message delivery are isolated, not merely manual UI inputs. Launch bootstrap reads only target context's tasks/session state and not A while starting B.
- [ ] Switch project mid-flight: A completion/message stays A, B's view remains unchanged; queued sends, optimistic replies, read/unread and in-flight page reads cannot be rerouted by changing UI selection; switching selection alone never starts/stops a run.
- [ ] One active context per logical team, including stopping, degraded/recovery and app restart; no implicit stop/resume of another project or duplicate process launch.
- [ ] Group reactions, message revision/forward/reply provenance, attachments and alerts stay with source context; notifications open exact project and task.
- [ ] Scheduler, cross-team targeting, auto-resume and work-sync have explicit target context or fail closed; old shared routes remain unaffected.
- [ ] Same project via equivalent normalized path resolves same context; two explicit worktrees remain distinct; deleted/moved/relinked paths do not auto-merge histories.
- [ ] Profile ownership: malformed mapping, unowned alias and foreign-profile team never get mutated, hidden as 'ours', backed up or deleted. Crash during first context create and retry is idempotent.
- [ ] Backup/restore and soft/permanent team deletion preserve/release *only owned* context artifacts and manifest; restore does not create orphan visible teams. **Special gate:** `TeamBackupRestoreService` currently expects a valid `config.json`; a logical config-only draft may not have one. Extend only the necessary backup/restore path for that manifest (or choose a proven existing backup location). Do not claim the old backup protects the new index without a test.
- [ ] Electron `pnpm dev:mcp` sandbox E2E with isolated app data/Claude root and **no real user projects or user provider credentials**; packaged smoke where needed. Exercise real renderer → preload → main/worker → native-compatible disk. Validate Claude, Codex, OpenCode primary/secondary and mixed lanes through deterministic test adapters/fake providers first; perform opt-in genuine sandbox runtime smoke where available, report unverified providers instead of treating them as PASS. Windows + macOS + Linux path/ownership evidence; `pnpm typecheck`, focused tests, `pnpm lint`, `pnpm guard:source-file-size`, `pnpm guard:team-provisioning-architecture`, exact-HEAD Full qualification. Queued/skipped ≠ PASS.
- [ ] UI review: Create Team selector, one team row, project context switch and active-context banner visually checked, keyboard-accessible and translated; no misleading claims of filesystem/security isolation.

**Stop/go verification gate:** before production code, implement a *disposable sandbox-only proof* that the targeted current runtime/controller accept an internal physical team name across launch, tasks, inbox, OpenCode lanes, cleanup and restart. If this fails, revise the plan through a new design review (do not patch third-party runtime semantics opportunistically). Do not count proposed tests as passed evidence.

## 7. Risks, estimate and explicit non-goals

| Risk | Why high | Minimal mitigation |
| --- | --- | --- |
| Hidden native team aliases leaking into normal team lists | Worker and main both enumerate physical directories | Explicit verified logical projection in both readers; never hide foreign/native teams based solely on name |
| Context split only in UI | Agents still read physical inbox and task files | Use actual isolated CLI-compatible storage namespace + sandbox agent-originated E2E |
| Racing project switches / late events | Async callbacks and caches key by team name | Capture context/run generation at admission and fence every state update |
| App/profile crash and unexpected ownership | Shared `~/.claude` path and recovery sweeps | Atomic manifest, existing ownership checks, idempotent reconciliation and evidence-based deletion |
| Shared team roster drift among contexts | Each runtime instance has separate native config | Logical source of truth + stopped-only, validated one-way projection at next launch |
| Background routing to wrong project | Schedules, cross-team messages, queues and auto-resume are asynchronous | Explicit durable target, no implicit last-project fallback |

**Revised incremental estimate after source review:** **8k–14k** added/substantially modified LOC including ~4.5k–7.5k production/integration code and ~3.5k–6.5k focused tests/E2E fixtures; **difficulty 8.5/10** (core model 5/10, runtime/lifecycle/backup coupling 8.5/10), confidence **6/10** pending physical-team alias proof. This is **not** an implementation target or license to add code. Reusing existing CLI/controller storage and avoiding legacy migrations is the main size reduction. Counts exclude generated files and unrelated refactors.

**Out of scope:** implementation in this PR; reusable independent agents / agent marketplace; custom template library PR #920; concurrent live project contexts for the same logical team; project filesystem or MCP security isolation; multi-user/cloud synchronization; cross-machine context sharing; auto-merging or time-splitting old history; automated project-folder relinking; changing provider authentication/models; Host migration (#982 and related); reworking Organizations, schedules or global task UX beyond necessary context routing; dependency upgrades, broad formatting, CI/workflow redesign or release/merge.

**Delivery discipline:** a dedicated Draft PR with this Markdown file only. Future implementation needs its own scoped PRs, code review, exact-HEAD checks and real sandbox desktop E2E. Draft ≠ approved design, CI queued/skipped ≠ PASS.

## 8. Review log

Five ordered **author review-and-revision** rounds are recorded here as updates are committed and immediately pushed to this Draft PR. They are not independent external model or human approvals.

1. **Architecture/DRY (author):** removed the implication of two divergent list readers; specified one post-collection application projection, a narrow resolver, and reusing native controllers rather than introducing generic repositories. **Applied.**
2. **Legacy/new creation (author):** distinguished persisted pre-feature drafts from unsent renderer drafts; clarified desktop folder-import versus backup restore; called out the real metadata allowlist, backend parser, empty logical task directories and IndexedDB version migration. **Applied.**
3. **Native paths/ownership (author):** checked 64-character validation, explicit foreign-profile takeover in normal launch, on-disk path ownership for process cleanup and backup identity fencing; specified a small bounded app-owned manifest and fail-closed reservation/recovery rather than inferred aliases. **Applied.**
4. **Async lifecycle and UX (author):** inspected message feed merge, team cache/request keys, queue scope, cross-team inbox delivery, historical path matching and schedules. Added a single-context admission/fencing contract and a mode-change rule for active schedules; prevented read-only navigation from creating runtime state. **Applied.**
5. **E2E, scope and estimate (author):** checked the sole-file Draft diff against the request. Added the missing config-only draft backup/restore gate, team rename identity, no-credential synthetic provider evidence and strict CI interpretation. Re-estimated source-informed work to 8k–14k LOC and 8.5/10; no implementation or unrelated PRs. **Applied.**
