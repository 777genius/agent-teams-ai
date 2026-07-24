# Hosted Web Runtime: End-to-End Completion Plan

## Document status

- Status: reference plan; for the live phase status see
  [docs/hosted-web-phases/EXECUTION_INDEX.json](hosted-web-phases/EXECUTION_INDEX.json)
  (single source of truth) — the line below reflects the state at authoring time
- Status at authoring time (2026-07-11): architecture and execution plan, implementation not started
- Audited branch: refactor/hosted-web-runtime-boundary
- Audited commit: 45e115f08eac5b60884b3a00c1c9278857faca06
- Audited pull request: #250, closed as superseded on 2026-07-11
- Implementation strategy: clean implementation branch from the target base; audited PR is reference-only
- New implementation branch: intentionally not created until this plan is accepted
- Target base: refactor/team-provisioning-round2-reapply
- Base observed during the original PR audit: 37d0bab5cb1089113a8b86924054443405dba489
- Current remote target-base head re-fetched during plan hardening on 2026-07-11:
  67548009b4d811d24ce3cb3ee0aed591e4922730
- Base pinning rule: fetch and record the then-current remote SHA immediately before branch creation;
  never treat the moving branch name or the SHA above as a permanent implementation base
- Pull request state at audit: draft, mergeStateStatus UNSTABLE; test, validate, and CodeQL failing
- Audit date: 2026-07-11
- Intended deployment for v1: one operator, one isolated runtime root, one hosted controller writer
  process per deployment; provider/CLI agents remain explicit external protocol writers
- Product parity decision: almost full TeamsAPI parity is required for v1, except hosted terminal,
  which is a separately estimated post-v1 capability
- Autonomous execution entrypoint: [Hosted Web Execution Router](./hosted-web-phases/README.md)
- Packet contract: [Hosted Web Execution Packet Standard](./hosted-web-phases/PACKET_STANDARD.md)
- Packet strategy: materialize one phase just in time; do not treat later phase overviews in this file
  as executable worker prompts

## Executive conclusion

The closed PR is a useful audit artifact, but it is not the foundation of the new implementation.
It exposed three incompatible execution paths:

    Electron renderer
      -> preload IPC
      -> src/main/ipc/teams.ts
      -> TeamDataService / TeamProvisioningService

    Browser renderer
      -> HttpAPIClient
      -> HostedWebTransportClient
      -> /api/hosted/v1/*
      -> no production server implementation

    Docker
      -> dist-hosted/server.cjs
      -> static renderer only
      -> intentional 404 for every /api/* request

That diagram describes the rejected closed PR. The fresh target base already has a different
`standalone.ts` + Fastify + static renderer + Docker path. It serves real non-team APIs but does not
compose team APIs/lifecycle or browser security. The new work evolves that path and removes the
Electron-shaped browser facade; it does not recreate the closed PR's hosted server.

The implementation must not be completed by adding aliases and more stubs to HttpAPIClient.
That would produce a demo faster, but would preserve the main architectural problem:
business behavior, provider handling, persistence, process ownership, IPC validation, and
Electron lifecycle are still mixed inside large main-process services.

The recommended solution is a clean-branch strangler migration of the existing product baseline:

1. Define feature-owned application contracts and a canonical capability model.
2. Extract shared application use cases behind small ports.
3. Keep the base branch's existing filesystem formats and large services behind compatibility adapters initially.
4. Make Electron IPC and hosted HTTP/SSE thin adapters to the same use cases.
5. Build one real hosted server composition that serves both the renderer and runtime APIs.
6. Prove the result using a built Docker artifact, a real browser, a real Fastify listener,
   isolated temporary state/workspaces, and deterministic fake runtime executables.

Honest estimate for a fresh implementation branch from the target base:

- architecture skeleton plus a core usable hosted team lifecycle: approximately 13k-21k changed lines
  including tests;
- internal single-tenant lifecycle milestone: approximately 18k-28k changed lines;
- v1 release target with broad TeamsAPI parity, review, logs, approvals, diagnostics, attachments,
  member operations, and preserved renderer reconciliation semantics, but without hosted terminal:
  approximately 28k-45k net changed lines;
- separate post-v1 hosted-terminal slice: approximately 6.5k-11.5k changed lines across this repo and
  terminal-platform. It is not included in the v1 estimate or readiness gate.

The 7,160 changed lines from the closed PR are not added to that total because they will not be
merged wholesale. Roughly 15-25% may be manually reimplemented or selectively ported after review,
mostly contracts, pure parsers, tests, and build discoveries. This is an order-of-magnitude planning
range, not a target to maximize diff size. Compatibility adapters keep the lower bound viable;
discovering more hidden lifecycle state in Electron composition moves the work toward the upper bound.

The remaining upper-range cost is deliberate: hosted path containment cannot honestly be implemented
as a few TypeScript `realpath()` checks. The v1 release target still
includes a small Linux workspace-guard executable, a hosted process anchor, strict child-environment/
runtime-relay boundaries, restart-safe device/session auth with host recovery and fixed proxy origin,
a real quiesced recovery-point protocol and lossless snapshot/event handoff, with their packaging/
probes and adversarial tests. Real-code terminal research proved that secure hosted PTY launch and
bounded streaming require a distinct upstream terminal-platform project rather than a small WebSocket
proxy, which is why ADR-35 is retained as a reviewed post-v1 design but removed from the v1 critical
path instead of being implemented halfway.

The estimate is now explicitly **net diff**, not a mechanical sum of overlapping phase estimates.
Non-terminal phases total approximately 33.9k-57.6k touched lines, but contracts, fixtures,
composition, renderer migration and E2E are revisited across phases. Applying a 20-25% overlap/rework
deduplication range gives approximately 28k-45k net lines. Phase 0 must replace this model with a
checked-in estimate ledger by unique feature/package before implementation expansion; a deviation over
20% requires re-estimation rather than silently growing the branch.

For this document, **net changed lines** means additions plus deletions in the final aggregate v1 diff,
with a line counted once after slice integration. It includes production code, focused tests, E2E,
small native guards and docs/migrations required by the feature. It excludes generated bundles,
lockfile/vendor churn, mechanical formatting and post-v1 terminal work.

| Unique v1 bucket                                                         | Net changed lines | Confidence | Main uncertainty                                                                 |
| ------------------------------------------------------------------------ | ----------------: | ---------- | -------------------------------------------------------------------------------- |
| contracts, feature skeletons, capability/route/architecture gates        |         2.0k-3.0k | high       | exact parity-ledger generator size                                               |
| TeamId/WorkspaceId, workspace policy and ADR-28 guard                    |         3.5k-5.5k | medium     | legacy identity adoption and final Linux filesystem probes                       |
| lifecycle/runtime extraction, provider ingress, ADR-30/31 ownership      |         5.0k-8.0k | medium     | how much deterministic provisioning can stay behind compatibility adapters       |
| command/event/recovery, external-writer and backup compatibility         |         4.5k-7.5k | medium-low | uncoordinated provider JSON semantics and existing backup behavior               |
| hosted composition, auth/proxy, packaging and production operations      |         3.5k-5.5k | medium     | standalone artifact/SQLite worker and deployment-topology failures               |
| renderer transport/reconciler plus lifecycle-screen migration            |         3.0k-5.0k | medium     | hidden teamSlice/TeamDetailView state-machine behavior                           |
| tasks/messages/review/approvals/members/attachments remaining parity     |         4.0k-6.5k | medium-low | actual visible-screen dependency closure after the action inventory              |
| real-browser E2E, desktop regression, migration/rollout docs and tooling |         2.5k-4.0k | medium     | reusable fixtures versus new production-shape harness work                       |
| **Total v1**                                                             |       **28k-45k** | **7/10**   | lower bound keeps strangler adapters; upper bound splits unsafe legacy authority |

This is still large because the chosen scope is nearly all team-management behavior, four provider
paths, remote authentication, runtime/process ownership, external JSON reconciliation and real
container/browser evidence. It is not 28k-45k solely to remove Electron imports. If the product goal
is reduced to the first production lifecycle slice, the existing 13k-21k checkpoint remains the
appropriate estimate; broad parity is what adds the remaining surface.

The 13k-28k milestones are implementation checkpoints, not a finished product.
The branch must not be marked Ready merely because list/create/launch/stop works.

Complexity is 9/10. Initial bug/security regression risk is 9/10 on the clean branch: lower than
continuing the closed PR because contradictory scaffolding is excluded, but still very high because
provider processes, external JSON writers, renderer reconciliation and recovery are intrinsically
stateful. With the phased gates in this document, expected residual risk before release is 4/10.

## Scope preserved

The goal is not to build a shared multi-tenant SaaS platform.
The goal is to make the existing Agent Teams product runnable without Electron as a real,
safe, single-tenant hosted/server option with a useful web UI.

### Required v1 outcome

A user can:

1. start a production hosted deployment;
2. authenticate from a browser;
3. see only registered workspaces through opaque identifiers;
4. list and inspect teams;
5. create a team draft/config;
6. prepare and launch a team through a provider-capability-aware runtime boundary;
7. observe provisioning progress and runtime state in real time;
8. create and update tasks and Kanban state;
9. send and receive team messages;
10. stop a team;
11. reload or reconnect without losing state;
12. restart the hosted backend and reconcile persisted state safely;
13. add, replace, remove, restore, restart, and reconfigure team members where supported by the runtime;
14. inspect logs, task activity, runtime health, and failure diagnostics;
15. perform task review, comments, relationships, attachments, and clarification workflows;
16. answer tool approvals safely;
17. manage delete/restore and other destructive team lifecycle operations with explicit confirmation.

### Required provider outcome

- Anthropic, Codex, Gemini, and OpenCode have explicit capability states.
- A provider is never assumed supported because a generic launch method exists.
- Unsupported or degraded provider paths fail before spawn with a typed error.
- OpenCode cannot remain a hidden standalone-only 501 WeakSet boundary.
- Provider credentials never travel through browser JSON payloads.

### V1 runtime trust boundary

V1 is single-tenant remote control, not a hostile-code sandbox. Browser input, provider protocol
messages, agent-authored files/content and stale processes are untrusted and fully validated, but an
operator-approved provider binary/agent process is tenant-trusted at the OS boundary in the default
single-runner profile. The design does not claim that protocol tokens alone isolate a malicious
same-UID process that can inspect sibling process/filesystem state.

Consequences:

- only operator-approved provider binaries and registered isolated workspaces are supported;
- plaintext device/session cookies and CSRF values remain browser+controller memory only; coordination
  storage contains only their keyed hashes/metadata, and none enter runtime env/files. App state,
  pairing material and audit data are outside runtime cwd/mount contracts;
- no live/adoptable runtime may exist when a plaintext pairing file is materialized. Startup first
  acquires the lease and stops/classifies residual runtimes under the stop-owned policy; inability to
  prove that boundary blocks pairing readiness;
- lane/run credentials limit accidental/stale/cross-route authority but are not advertised as an OS
  sandbox between mutually malicious same-UID lanes;
- the capability/meta response reports `runtimeIsolation: trusted_process`, and diagnostics/docs use
  the same term. Tests must not label it container/host sandboxing.

Running untrusted third-party binaries, mutually hostile tenants or strong cross-lane containment
requires a separate runner isolation project using distinct OS identities/containers and a brokered
execution port. That is explicitly deferred rather than half-implemented inside this Electron
decoupling refactor. “Safe v1” means safe within this declared single-operator/trusted-runtime model.

### Explicitly deferred unless promoted by the capability matrix

- shared-process multi-tenancy;
- hostile provider-binary/same-UID runtime sandboxing and strong cross-lane OS isolation;
- horizontal replicas writing the same runtime root;
- arbitrary browser-selected host paths;
- desktop updater and native window controls;
- native file chooser;
- full built-in editor parity outside team review/attachment workflows;
- OS-native notifications;
- unrestricted shell/process execution;
- hosted terminal workspace. Its architecture is reserved by ADR-10/35, but v1 advertises no terminal
  capability, mounts no terminal controls/routes and starts/packages no terminal daemon;
- schedules and non-team application administration;
- cross-team administration beyond the team-management contract, unless it is required by
  an existing team screen included in the parity gate.

Deferred functionality must be absent or visibly disabled through capabilities.
It must not be represented by throw, silent no-op, or fabricated empty success responses.

### Release parity rule

The release target is almost full TeamsAPI parity, not full ElectronAPI parity.

Required:

- all team-management operations reachable from the included web team screens;
- all state needed to launch, observe, direct, recover, review, and stop teams;
- explicit provider/runtime capabilities and typed degraded states;
- no browser stub behind a visible or advertised team control.

Hosted terminal is not an exception implemented as a throwing method. It is absent from the v1
capability manifest and included web UI; its existing desktop facet continues through IPC unchanged.

Allowed desktop-only exceptions:

- native window controls;
- desktop updater;
- OS-native file chooser;
- OS-native notifications;
- opening Finder/Explorer or external desktop editors;
- other operations with no meaningful server-side equivalent.

Every exception must be recorded in the capability matrix with a deliberate browser UX.

## Verified current-state metrics

The audited PR diff contains:

| Category          | Additions | Deletions |
| ----------------- | --------: | --------: |
| Tests             |     3,697 |        26 |
| Production source |     3,258 |       185 |
| Build/docs/other  |       205 |        50 |
| Total             |     7,160 |       261 |

Current target-base indicators at the plan-hardening snapshot 67548009b4d811d24ce3cb3ee0aed591e4922730:

| File                                              | Approximate LOC | Problem                                                                                                         |
| ------------------------------------------------- | --------------: | --------------------------------------------------------------------------------------------------------------- |
| src/main/ipc/teams.ts                             |           5,751 | transport, validation, orchestration, and storage knowledge mixed                                               |
| src/main/services/team/TeamDataService.ts         |           3,932 | constructs many concrete dependencies and owns many workflows                                                   |
| src/main/services/team/TeamProvisioningService.ts |             639 | now a facade over many provisioning modules; preserve the round2 decomposition instead of rebuilding a monolith |
| src/renderer/store/slices/teamSlice.ts            |           4,764 | transport calls, cache authority, optimistic lifecycle, race control, and UI state mixed                        |
| src/renderer/components/team/TeamDetailView.tsx   |           3,757 | large presentation/orchestration surface                                                                        |
| src/renderer/store/index.ts                       |           2,690 | global startup plus team event fanout, throttles, polling, and runtime event reconciliation                     |
| src/renderer/api/httpClient.ts                    |           1,756 | target base already claims the full ElectronAPI in browser mode and contains broad unavailable/stub behavior    |
| src/renderer/components/team/TeamListView.tsx     |           1,499 | hard Electron gate blocks the browser flow                                                                      |
| src/main/http/teams.ts                            |             654 | legacy HTTP adapter knows filesystem, draft detection, cache invalidation, and runtime overlays                 |
| src/main/standalone.ts                            |             217 | already serves a non-Electron app, but omits team composition and uses unsafe remote defaults                   |
| src/main/services/infrastructure/HttpServer.ts    |             205 | already serves static UI plus API; security/lifecycle policy is mixed into the server wrapper                   |

The four renderer hotspots above total approximately 13,241 lines. The existing
teamSlice characterization suites add approximately 7,825 lines and encode many race and
structural-sharing guarantees that are not visible in the public TeamsAPI contract. They are
migration assets, not disposable implementation detail.

AST-level audit of the pinned target interface finds 86 TeamsAPI methods, 20 ReviewAPI methods and
3 CrossTeamAPI methods. Every name appears in this document, but name presence is not parity: legacy
methods such as getData, raw-path review calls and event subscriptions must be decomposed/replaced
without losing their validation, side effects, error states, ordering or visible workflow.

Important correction from the target-base audit:

- `src/main/standalone.ts`, `HttpServer`, `docker/Dockerfile`, and `standalone:build` already form a
  real static+API Node composition. The problem is incomplete/insecure team composition, not the
  absence of a server.
- standalone currently omits `teamApis` and `teamDataApi`, so team routes are not registered even
  though `registerTeamRoutes` exists.
- `HttpAPIClient implements ElectronAPI` is target-base debt, not only closed-PR debt. A clean branch
  must strangle it; merely refusing to copy PR #250 does not remove it.
- target base already exposes useful compatibility seams: `TeamHttpHandlerApis`, `TeamHttpDataApi`,
  the split provisioning composition, and feature-owned HTTP adapters in organizations,
  recent-projects, and token-usage.
- target base also has a structured `src/main/services/team/runtime-control` domain/application
  service with provider routing, command IDs and write-fence tests. Reuse its proven semantics, but
  replace the mixed browser route, raw authority fields, in-memory-only replay fence and
  action-before-event persistence gap.
- target-base Anthropic/Codex/Gemini launch is not a separate orchestrator executable: the
  deterministic provisioning spawn flow launches one Claude-compatible CLI path and varies
  provider args/model/auth/bootstrap inputs. OpenCode alone is routed through
  TeamRuntimeAdapterRegistry. The first runtime refactor must wrap these two actual paths before
  extracting strategies; it may not design against an imagined universal backend.
- target-base team-runtime-lanes has five concrete topologies, not an arbitrary provider graph:
  primary_only, pure_opencode, pure_opencode_solo, pure_opencode_worktree_root_lanes and
  mixed_opencode_side_lanes. OpenCode-led mixed teams are currently rejected. In mixed mode the
  primary provisioning CLI starts first; queued OpenCode side lanes start after the primary's real
  turn completion and then contribute to one persisted launch snapshot. This ordering and partial
  outcome behavior require characterization before extraction.
- target-base `docker/vite.standalone.config.ts` currently replaces Electron imports and every
  `.node` addon with empty build stubs. Its Docker production-dependency stage uses `--ignore-scripts`
  and rebuilds selected terminal/SSH addons, but does not stage the internal-storage worker or prove
  a Node-ABI `better-sqlite3` load. That is acceptable only while team/runtime features are absent;
  it cannot remain the canonical hosted production build after those features are composed.
- target-base TeamBackupService already has a different best-effort identity mechanism:
  manifest/registry `identityId` plus `_backupIdentityId` injected into CLI-owned config.json. It is
  keyed by teamName, can rotate during same-name resurrection, and permanent delete currently removes
  the directory before `markDeletedByUser`. It is migration evidence, not the canonical TeamId, and
  must be adapted before any team.identity.json is published.
- target-base validateTeamName accepts only lowercase ASCII slug-shaped direct children and rejects
  Windows reserved names, but TeamConfigReader discovery enumerates existing directories before that
  route guard. Migration therefore cannot assume every legacy directory is valid or collision-free.
- target-base killProcessTree discovers descendants from a process-table snapshot and signals raw PIDs
  best-effort; it does not fence PID/start-token reuse or persist the spawn-to-ownership gap. It is a
  low-level compatibility helper, not sufficient ownership proof for hosted processRef/repair/delete.
- target-base Claude-compatible task/inbox paths and writes are primarily keyed by teamName plus
  taskId/messageId and do not carry a trustworthy lifecycle RunId/generation. OpenCode runtime stores
  do carry explicit run IDs/manifests. A generic filesystem watcher therefore cannot safely attribute
  every external JSON change to whichever run is currently selected.
- target-base members.meta v1 has no stable MemberId. Its store deduplicates exact names and may drop
  CLI auto-suffixed names when an active base name exists, while remove/restore paths also compare
  lowercased names. Config, inboxes, tasks, logs and runtime manifests can therefore disagree about
  whether two differently cased/suffixed strings are one logical member or separate evidence.
- target-base team renderer has non-TeamsAPI Electron reachability inside included flows:
  ProjectPathSelector calls `api.config.selectFolders`; TaskCommentInput calls `getPathForFile`;
  team editor components call `editor.*`, `openPath` and `showInFolder`; process/terminal/message UI
  calls `openExternal`; ProcessesSection kills a raw PID; create/list flows assign organizations;
  review registers desktop `onCmdN`. Global store startup also registers editor, Codex runtime and
  team listeners. Capability flags applied only at click time would leave mount-time effects and
  global subscriptions coupled to Electron.
- target-base `team.meta.json` is volatile launch/draft metadata, not a safe identity carrier:
  TeamMetaStore accepts only version 1, normalizes known fields and rewrites the whole document;
  launch writes it again, while failed-create cleanup deletes it and may recursively remove the team
  directory. TeamId must use a separate immutable file/store and lifecycle-aware cleanup protocol.
- existing features such as terminal-workspace, internal-storage, member-work-sync,
  member-log-stream, team-runtime-lanes, runtime-provider-management, organizations,
  agent-attachments, running-teams, and workspace-trust must be reused or adapted rather than cloned.

## Blocking defects and their actual location

Defects below are tagged implicitly by their evidence:

- **target base** means the problem exists before the new branch and must be migrated, not avoided;
- **closed PR** means the approach must not be salvaged;
- **both** means the PR failed to remove existing debt.

This distinction is required for a real fresh start. Otherwise Phase 0 could mistakenly declare the
base clean while preserving the full Electron-shaped browser facade and incomplete standalone team
composition.

### P0: the audited PR baseline is not green

PR #250 at commit 45e115f currently reports failing test, validate, and CodeQL checks.
Observed failures include:

- three TeamProvisioningService expectations around persisted launch-state liveness/cleanup;
- an HttpServer test failing because API-only startup emits an unexpected renderer-output warning;
- CodeQL high-severity js/missing-rate-limiting on the authorization hook in HttpServer.ts.

These may include behavior/test-assumption or CI-environment issues, but they are unresolved until
reproduced and classified against the exact base SHA. No hosted work may use a red PR as its trusted
characterization baseline, and the CodeQL alert cannot be waived merely because the current bearer
auth is transitional.

### P0: closed-PR production route mismatch

- Browser transport owns /api/hosted/v1/\*.
- Real Fastify routes own /api/teams/\*.
- No production source registers /api/hosted/v1.
- Existing DTO shapes are incompatible, not merely differently named.

Examples:

| Operation      | Hosted client expects                    | Legacy server returns/expects |
| -------------- | ---------------------------------------- | ----------------------------- |
| List teams     | object with teams                        | TeamSummary array             |
| Team snapshot  | team, tasks, kanban, revision            | TeamViewSnapshot              |
| Launch request | workspaceRef and provider object         | cwd and providerId            |
| Provisioning   | teamId                                   | teamName                      |
| Alive teams    | object with teamIds                      | TeamRuntimeState array        |
| Runtime        | terminalAvailable and activeProcessCount | legacy TeamRuntimeState       |

### P0: closed-PR Docker regression; target base has a different incomplete path

- Docker builds hosted:build, not standalone:build.
- Docker runs dist-hosted/server.cjs.
- src/hosted/server.ts intentionally returns 404 for every API request.
- The previous full standalone image and runtime state mount were replaced by a static shell.
- The current Docker tests lock in API absence instead of proving a usable runtime.

Target base does not have this static-only regression: its Docker image builds `standalone:build`
and runs the real Fastify/static server. However, standalone does not pass `teamApis`/`teamDataApi`,
mounts the Claude root read-only in the documented example, defaults remote CORS to wildcard, has no
browser session security, and composes only a subset of desktop lifecycle services. The new design
must evolve this existing path, not add a third server target.

### P0: browser authentication is unusable in both paths

- The closed PR's non-loopback HttpServer requires AGENT_TEAMS_HTTP_AUTH_TOKEN.
- HttpAPIClient and HostedWebTransportClient do not send Authorization.
- Native EventSource cannot set an Authorization header.
- There is no browser login/bootstrap/session/logout/rotation flow.
- Target-base standalone has no remote authentication and defaults CORS_ORIGIN to wildcard while
  credentials are enabled.
- Loopback may run without auth, allowing an untrusted website to target a privileged local API.

### P0: target-base runtime callbacks share the operator route surface

Target base registers OpenCode bootstrap-checkin, deliver-message, task-event, heartbeat and
permission-answer under `/api/teams/:teamName/opencode/runtime/*` in the same route module as browser
team control. The adapter injects URL teamName into a raw body and has no distinct machine identity.

The compatibility permission command also accepts cwd, expectedMembers and previousLaunchState from
the caller. RuntimeControlService serializes some operations only with an in-memory fence and invokes
the provider action before recording the event sink, leaving an ambiguous retry window if event
persistence fails.

Hosted work must separate this machine ingress before enabling provider launch. Browser session
security, private networking, validation and idempotency alone are not substitutes for a run-scoped
machine credential and server-resolved authority.

### P0: workspace boundary is unsafe

- Hosted launch ultimately accepts any absolute cwd.
- Browser mapping currently sends the raw cwd as workspaceRef.id.
- There is no registered workspace catalog, descriptor-bound containment, or reliable symlink/mount
  race defense.
- Hosted config routes can expose or change host-specific roots and project paths.
- A compromised session could point runtime actions at unintended host directories.

### P1: browser team UI is intentionally unreachable

TeamListView:

- calculates canCreate as Electron-only;
- disables alive-team loading outside Electron;
- skips fetchTeams and fetchAllTasks outside Electron;
- returns an unconditional Electron-only placeholder.

### P1: the claimed E2E is a contract fixture

hostedWebStartup.fixture-e2e.test.ts:

- replaces fetch with an in-memory fake router;
- replaces EventSource and WebSocket;
- creates fake hosted routes that do not exist in production;
- asserts that no real runtime launch was attempted.

It is a useful contract/unit fixture, but it is not an end-to-end test.

### P1: typed SSE and terminal contracts are dead production code

- subscribeToTeamEvents has no production callsite.
- createTerminalSession and openTerminalStream have no production callsite.
- HttpAPIClient still opens the generic /api/events stream.
- The real event server has a global unscoped clients set with no event IDs, replay, or team filter.
- The existing terminal-workspace feature already uses a different gateway contract.
- The new hosted raw terminal contract duplicates that architecture instead of adapting it.
- Existing terminal-workspace bootstrap accepts renderer-supplied projectPath and returns runtime
  slug, direct control/stream URLs, projectPath, and default shell.
- The gateway embeds a bearer in both WebSocket query URLs, binds a separate TCP listener and exposes
  the complete WorkspaceTransportClient. Its validators only prove that create-session request,
  mux-command and subscription spec are objects before forwarding them; current DTOs therefore permit
  browser-selected program/args/cwd, imported routes and broad saved-session/layout operations.
- The vendored gateway uses `ws` defaults: inbound `maxPayload` is 100 MiB, outbound pumps call
  `socket.send()` without a bufferedAmount/high-watermark wait, and control requests have no per-socket
  serialization or method/rate/resource budget.
- The renderer transport opens independent control and stream sockets and automatically reconnects.
  That cannot be secured by the plan's previous single-use ticket without a two-plane connection-grant
  state machine and an authenticated HTTP regrant before reconnect.
- The daemon runtime slug is a deterministic hash of teamName. Startup attaches to any ready daemon
  at that name and later refuses to stop it when this process did not spawn it. The local transport
  uses overwrite-on-bind behavior, so pathname/readiness is not ownership evidence.
- Its daemon spawn inherits `process.env` wholesale; portable-pty then seeds each shell from the
  daemon's base environment. Controller/session/provider/lease secrets could therefore reach a remote
  shell unless the daemon itself starts from an allowlist-first environment.
- terminal-daemon silently falls back to in-memory persistence when its SQLite store fails, and native
  PTY teardown currently kills only the direct child without typed wait/drained evidence. Hosted
  composition needs an identity-resolving, constrained same-origin adapter plus terminal-platform
  hardening; wrapping the current listener in an auth proxy is insufficient.
- Existing optional `client_event_id` deduplicates persisted command-history capture, not the PTY write
  itself. A lost response therefore cannot justify automatic replay of input/paste or a structural mux
  command without a stronger daemon-scoped result/evidence contract.

### P1: target-base and closed-PR HttpAPIClient violate interface segregation and substitutability

HttpAPIClient implements the complete ElectronAPI but cannot honor that contract. The exact stub
count differs between the moving base and closed PR, so CI must inventory reachable unsupported
methods structurally instead of relying on the historical count of 141.

This causes three failure modes:

1. visible controls throw after a click;
2. no-op methods silently discard user intent;
3. empty arrays or fake values look like successful responses and hide missing data.

### P1: renderer state is a second hidden lifecycle implementation

The current renderer is not a passive view over TeamsAPI. teamSlice and the store event wiring
implement a substantial client-side state machine:

- context ID, context epoch, team epoch, request nonce, and request-scope stale-response guards;
- thin versus full snapshot deduplication and queued follow-up refreshes;
- selected-team and multi-pane caches with structural sharing;
- optimistic pending provisioning runs replaced by canonical server run IDs;
- provisioning and runtime run tombstones plus startedAt floors after stop -> relaunch;
- state-regression suppression for terminal provisioning states;
- event-driven refresh fanout with visibility gates, throttles, safety refreshes, and polling;
- message-head pagination serialization and feed revision checks;
- immediate projections for tool activity, lead activity/context, and approval events.

A direct EventSource-to-Zustand rewrite can resurrect stopped runs, overwrite a newer context,
drop a follow-up refresh, erase a richer snapshot, or flood the server. The migration therefore
needs an explicit client reconciliation model and must preserve the existing race tests.

There are also direct transport bypasses outside the renderer API facade:

- AttachmentDisplay calls window.electronAPI.teams.getAttachments;
- ProcessesSection calls window.electronAPI.teams.killProcess;
- AdvancedCliSection calls window.electronAPI.teams.validateCliArgs.

Editor/open-path/native-shell calls are separate desktop facets, but team operations above must
move behind capability-scoped application adapters. An architecture gate must prevent new direct
window.electronAPI.teams usage in renderer team features.

### P1: closed-PR runtime-core is not a core boundary

- runtime-core/main imports concrete @main/services types.
- providerJsonParsing is a copied bundle of concrete service references.
- team use cases are existing main binders.
- TeamRuntimeAdapter input contracts still carry raw cwd and teamName, so they are not yet the
  safe canonical hosted boundary; a workspace/team identity adapter must resolve those internally.
- the architecture test only prevents renderer/preload/shared importing runtime-core/main;
  it does not prevent runtime-core from depending on main details.

Electron coupling was partially replaced by main-process coupling, not inverted.

### P1: closed-PR team-application is far too narrow

The slice currently owns only deleteDraftTeam.
List, read, create, launch, stop, tasks, messages, provider capabilities, events,
logs, review, approvals, and lifecycle recovery remain outside the application boundary.

### P1: standalone lifecycle differs from desktop lifecycle

Standalone does not compose the same:

- runtime adapter registry;
- startup state reconciliation;
- prompt delivery watchdog;
- process health polling;
- stale runtime cleanup;
- member-work-sync replay/scan;
- task-comment journal initialization;
- internal-storage worker/SQLite backend and task-stall journal/monitor;
- team backup lifecycle;
- terminal-workspace lifecycle (documented gap, but deliberately outside hosted v1);
- team change event pipeline.

Some apparently reusable provisioning code also retains desktop fallback dependencies. For
example, TeamProvisioningToolApprovalFacade holds BrowserWindow state, falls back to
ConfigManager.getInstance(), and dynamically requires Electron Notification. These must become
injected notification/settings ports; hosted must not rely on an unexecuted Electron branch being
harmless.

A launch that appears to work may still diverge after restart, stale state, or partial failure.

### P1: persistence authority is mixed

The runtime tree contains:

- CLI-owned, largely unversioned config/tasks/inbox JSON;
- app-owned metadata and launch state;
- OpenCode-specific versioned stores and manifests;
- JSONL transcripts and journals;
- multiple files updated as one logical operation without an aggregate transaction.

In-process locks do not protect two Node writers.
Some read-modify-write flows may drop unknown fields written by newer CLI/runtime versions.

### P2: production operations are incomplete

The current hosted artifact lacks:

- live and ready health endpoints;
- request IDs and safe error correlation;
- structured redacted logs;
- bounded request body/time/rate policies;
- SSE/process metrics;
- non-root runtime user;
- explicit persistent volumes;
- hardened container permissions;
- graceful admission stop and connection drain;
- migration/backup/rollback workflow.

## Architecture options

### Option 1: strangler around feature-owned application use cases - recommended

🎯 9/10 🛡️ 9/10 🧠 8/10

Approximate v1 fresh-branch changes: 28k-45k net lines including broad tests/docs, ADR-7 durable auth/proxy
continuity, ADR-16 stable-inode instance locking, ADR-28 workspace guard, ADR-30 runtime relay/
environment boundary, ADR-31 process anchor, ADR-32 recovery points, ADR-33 snapshot/event handoff and
ADR-34 versioned command/effect recovery. ADR-35 terminal work is a separate 6.5k-11.5k post-v1 slice.

- Canonical /api/hosted/v1 contract.
- Shared application use cases.
- IPC and HTTP as thin input adapters.
- Current large services behind compatibility output adapters.
- Incremental extraction without rewriting all persistence at once.
- Best long-term Electron decoupling and testability.

### Option 2: connect browser directly to legacy /api/teams and fill missing routes

🎯 8/10 🛡️ 5/10 🧠 6/10

Approximate further changes: 8k-14k lines.

- Faster path to a demo.
- Keeps Electron-shaped mega-interfaces and raw filesystem paths.
- Duplicates validation and transport behavior.
- Makes provider and lifecycle divergence harder to remove later.
- Likely requires a second rewrite.

### Option 3: keep a static hosted shell and control another desktop/runtime service

🎯 7/10 🛡️ 6/10 🧠 4/10

Approximate further changes: 3k-6k lines.

- Acceptable only as an explicitly read-only or limited product.
- Does not satisfy a real hosted team lifecycle.
- Team mutations, terminal, credentials, and runtime ownership remain elsewhere.

### Decision

Use Option 1.

Apply it from a fresh branch based on `refactor/team-provisioning-round2-reapply`, not by extending
the closed PR. Do not expand HttpAPIClient or the legacy route layer before feature ownership,
application ports, and the capability matrix exist. Otherwise the next several thousand lines will
cement the current coupling.

### Fresh-start and salvage policy

Starting over means resetting the architectural direction, not discarding verified knowledge or
rewriting the mature desktop product in one jump.

Rules:

1. The target base is the only code ancestry for the new implementation branch.
2. PR #250 remains a read-only reference for defects, test ideas, DTO field inventories, and build
   discoveries. No merge, rebase, or whole-commit cherry-pick from it is allowed.
3. A piece may be ported only after identifying its owning feature, public contract, dependency
   direction, threat model, and focused verification.
4. Prefer manual reimplementation when a commit mixes useful pure code with HttpAPIClient stubs,
   static-only server assumptions, ElectronAPI widening, or legacy route duplication.
5. Ported tests must assert the new public seam. Tests that only prove a fake fetch, fake EventSource,
   or fixture contract are renamed and kept below the E2E gate.
6. Each adopted asset is recorded in a short salvage ledger with source commit/file, target owner,
   reason, modifications, and test evidence. This prevents accidental resurrection of rejected design.

Good salvage candidates:

- browser-safe DTO schemas and pure normalization after contract review;
- provider capability inventories and protocol fixtures with secrets removed;
- deterministic parsers and characterization tests for legacy JSON behavior;
- route-conformance test ideas, security findings, Docker build discoveries, and ADR evidence;
- pure renderer reconciliation cases if they preserve the current desktop semantics.

Rejected by default:

- a browser client implementing the complete ElectronAPI;
- blanket `not available`, no-op, or fabricated-success methods;
- static-only Docker as the default hosted artifact;
- duplicate lifecycle logic in a hosted-only service;
- provider/runtime callbacks placed under browser team routes or authenticated by browser session;
- raw host paths, PIDs, provider credentials, or direct gateway details in browser contracts;
- transport tests presented as end-to-end evidence;
- a single `team-application` or `runtime-core` facade owning every feature.

The clean branch is considered correctly initialized only when it contains the exact target-base
commit, this accepted plan/ADRs, a green or explicitly classified baseline, and no production code
copied from the closed PR.

## Target architecture

### Runtime topology

    Browser
      -> TLS/auth edge
      -> hosted app private port
          -> static renderer
          -> /api/hosted/v1 HTTP
          -> team-scoped SSE
          -> no WebSocket/terminal route in v1
      -> application use cases
      -> ports
          -> filesystem compatibility repositories
          -> provider/runtime adapter registry
          -> process supervisor
          -> event journal
          -> workspace registry

    Provider/runtime process
      -> private machine-authenticated /api/runtime/v1 ingress
      -> runtime ingress use cases
      -> current run/generation/token scope validation
      -> team-runtime-control + feature mutation/outbox boundaries

    Provider/CLI filesystem writer
      -> scoped watcher + stable parse/checksum
      -> external mutation reconciliation

    Electron renderer
      -> preload IPC adapter
      -> the same application use cases
      -> the same ports/adapters where semantics match

### Feature-owned target shape

The existing `docs/FEATURE_ARCHITECTURE_STANDARD.md` remains canonical. Each medium or large area
uses only the folders it really needs; empty ceremonial layers are forbidden. Target slices are
created or extended only when their first vertical use case is extracted.

    src/features/
      team-lifecycle/
      team-task-board/
      team-messaging/
      team-review/
      team-approvals/
      team-runtime-control/     # execution/liveness, not provider installation/settings
      workspace-registry/
      terminal-workspace/       # desktop unchanged; hosted extension deferred to post-v1 T1
      team-console/             # thin renderer composition; no business authority

Existing slices are part of the target architecture, not migration debris:

| Existing feature              | Target role                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `runtime-provider-management` | provider installation, connection/settings and user-facing availability; it does not spawn team runs  |
| `team-runtime-lanes`          | pure mixed-provider lane planning reused by `team-runtime-control`                                    |
| `member-work-sync`            | existing member synchronization contracts/use cases; expose HTTP through its public facade            |
| `member-log-stream`           | bounded member/task log streaming and projections                                                     |
| `terminal-workspace`          | preserve desktop control/stream behavior in v1; add hosted authorization/bootstrap only in post-v1 T1 |
| `internal-storage`            | existing SQLite worker/backend extended for coordination tables; no second database subsystem         |
| `agent-attachments`           | attachment storage/validation reused by task-board, messaging and review workflows                    |
| `organizations`               | existing cross-team organization/read-model boundary and HTTP adapter                                 |
| `running-teams`               | existing renderer projection reused inside `team-console`                                             |
| `workspace-trust`             | provider CLI trust/preflight policy; distinct from hosted workspace registration/authorization        |

The provider-runtime product area is implemented by `team-runtime-control` plus the existing
`runtime-provider-management` and `team-runtime-lanes` features. This prevents one new feature from
absorbing installation, preferences, lane planning, process ownership, lifecycle and settings UI.

A full cross-process feature may contain:

    <feature>/
      contracts/                # browser-safe DTOs, schemas, errors, routes/channels, capabilities
      core/
        domain/                 # only real invariants/state machines
        application/            # commands, queries, ports, outcomes
      main/
        composition/            # feature factory, not application-global composition
        adapters/input/         # IPC and HTTP translation
        adapters/output/        # legacy/provider/persistence implementations of owned ports
        infrastructure/         # process, filesystem, database, protocol details
      preload/                   # thin IPC bridge when desktop exposes the feature
      renderer/
        adapters/               # DTO to view-model mapping
        hooks/                  # client-facet and store orchestration
        ui/                     # presentational controls

Hosted mode is an application composition, not a feature:

    src/main/standalone.ts                    # thin process entrypoint during migration
    src/main/composition/hosted/              # app-level wiring and lifecycle
    src/main/services/infrastructure/HttpServer.ts

Refactor the existing standalone path in place. `standalone.ts` becomes config parsing plus
`createHostedApplication().start()`. The hosted composition wires feature facades, session policy,
workspace adapters, HTTP/SSE adapters, readiness and shutdown. It owns no team/provider/workspace
business rules. Do not create `src/features/hosted-runtime`, `src/hosted/server.ts`, or a second
Docker/server artifact.

The v1 browser transport is small shared renderer infrastructure that knows HTTP, SSE, cookies,
request IDs, cancellation, bounded retry and wire decoding. Feature-owned clients map their own
routes/contracts onto it. It does not implement ElectronAPI and contains no team policy.
Post-v1 T1 adds WS through a terminal-owned adapter rather than expanding every v1 client.
There is no replacement mega-feature named `team-application`; shared application behavior lives
in the feature that owns the user-visible capability.

### Capability-segregated renderer API

Replace the single full ElectronAPI promise with small facets:

- teamRead;
- teamLifecycle;
- provisioning;
- taskBoard;
- messaging;
- memberLifecycle;
- logs;
- review;
- toolApproval;
- terminalWorkspace (desktop-only in v1; hosted facet added by post-v1 T1);
- desktopWindow;
- desktopUpdater;
- desktopFileChooser;
- editor.

The server publishes a typed capability manifest.
The renderer composes only supported facets.

The manifest has schemaVersion/revision and distinguishes deployment capability, provider
availability/auth state, and team/run-specific allowed actions. Capability changes emit a scoped
event and force revalidation. UI gating is advisory UX only: every command rechecks authorization,
workspace, current generation, provider readiness, and policy on the server.

Capability granularity has three explicit levels rather than one boolean per old API method:

- facet availability: the renderer may compose a feature client/widget;
- action support: a stable action ID such as `team.lifecycle.launch` has an implemented semantic
  path in this deployment/provider topology;
- resource allowance: the current team/run/workspace snapshot says whether that action is presently
  allowed and gives a safe reason code such as stale_generation, read_only_workspace,
  provider_unavailable or recovery_required.

The first two come from registered descriptors/features and deployment readiness. The third is a
versioned server projection and may change at runtime. Hosted UI never infers action support merely
from facet presence, and it never treats a temporary resource denial as proof that the action is
unimplemented. The parity ledger references stable action IDs; it does not force 109 legacy methods
to become 109 permanent capability booleans.

Rule:

> A capability marked supported may not throw "not available in browser mode",
> silently no-op, or fabricate empty data.

Migration shape:

- createElectronAppApi composes preload-backed facets;
- createHostedAppApi composes HTTP/SSE-backed v1 facets from the capability manifest; post-v1 T1 may
  add its own WS-backed terminal facet without widening existing clients;
- both return a registry of independently typed facets, not two implementations of one mega-interface;
- shared hooks/components depend on the narrow facet they use;
- target base's `api: ElectronAPI` proxy and HttpAPIClient remain a quarantined compatibility path
  only for untouched non-team screens; browser team startup never resolves it;
- remove each HttpAPIClient team/review stub as its caller migrates; hosted v1 has no terminal facet at
  all. The release gate is zero hosted team/review callsites through fake/no-op legacy methods and zero
  terminal imports/effects from hosted route chunks.

## Feature ownership and dependency design

### Ownership matrix

Every mutable rule, route, event, repository write, and renderer command has exactly one owning
feature. Other features consume its public contract or an explicitly published application port;
they do not import its internals or reproduce its state.

| Feature                | Owns                                                                                                                                                                                                                    | Does not own                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `hosted-access`        | ADR-7 pairing challenge, device-grant family, operator session/CSRF lifecycle, auth cookies, renewal/logout/reset policy and browser-auth projection                                                                    | TLS/proxy deployment, team authorization, runtime credentials, workspace policy, generic HTTP server                                      |
| `team-lifecycle`       | team identity/draft/config lifecycle, TeamWorkspaceBinding, TeamRoster/MemberId generations, prepare/launch/stop/delete/restore/recovery saga, run generation, member lifecycle orchestration and lifecycle projections | workspace root authorization, provider spawn mechanics, task/message contents, composite console snapshot, terminal protocol, HTTP server |
| `team-task-board`      | tasks, revisions, relationships, comments, assignment, status transitions, Kanban ordering, review-request state and task projections                                                                                   | team process lifecycle, inbox delivery, review diff/patch execution                                                                       |
| `team-messaging`       | inbox/history pagination, send/delivery outcomes, message identity/deduplication, external inbox reconciliation                                                                                                         | task mutation rules, provider process supervision, UI notification plumbing                                                               |
| `team-review`          | review sessions, diffs/files, review comments and outcomes, bounded apply/checkout commands                                                                                                                             | arbitrary filesystem access, generic Git hosting, task board authority                                                                    |
| `team-approvals`       | pending approval projection, policy, claim/decision/idempotency/audit                                                                                                                                                   | renderer-only prompts, provider credentials, general runtime lifecycle                                                                    |
| `team-runtime-control` | two segregated surfaces: outbound launch/process/liveness execution and inbound machine runtime events/delivery; consumes provider availability and lane plans from existing features                                   | provider installation/settings, browser auth/API, team product state, renderer stores                                                     |
| `workspace-registry`   | opaque workspace/repository identity, canonical root registration, containment/mount policy, operation authorization and revision                                                                                       | browser session, team lifecycle, terminal sessions, arbitrary project browsing                                                            |
| `terminal-workspace`   | post-v1 only: terminal session authorization input, lifecycle, PTY/gateway mapping, output/backpressure and WS-facing contract; desktop adapter remains unchanged in v1                                                 | v1 hosted composition, arbitrary shell API, team lifecycle decisions, raw browser host paths                                              |
| `team-console`         | selected-team UI context, feature-widget composition, bootstrap/reconnect sequencing and the entity-agnostic TeamTransportReconciler                                                                                    | lifecycle/task/message/review state or revision semantics, persistence, transport implementation or provider policy                       |

App-level hosted composition owns immutable PUBLIC_ORIGIN/proxy/socket policy, route assembly,
health/readiness, static assets and SSE wiring. It injects those facts plus the narrow runtime drain
port into `hosted-access`; it does not own auth state/transitions. Post-v1 T1 adds WS/terminal drain
through separate ports. Deployment wiring remains outside product bounded contexts.

Cross-team operations remain a separate thin feature only if their required parity cannot be
expressed as queries over owned feature contracts. It must not become a backdoor god API.

Ownership resolution rules:

1. The feature that validates and commits an invariant owns the command.
2. A screen or transport never owns business state merely because it displays or carries it.
3. A projection may join multiple feature read models, but may not mutate their backing state.
4. A saga coordinates commands through public application surfaces; it does not directly write
   another feature's repository.
5. If two features need the same concept but with different semantics, keep separate types and map
   explicitly. Do not merge them merely because their JSON shape currently matches.

High-risk cross-feature workflows have one explicit coordinator and outcome contract:

| Workflow                                  | Coordinator/committed authority                                                                                                           | Secondary effects and failure rule                                                                                                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create/delete draft                       | `team-lifecycle` commits TeamId, identity anchor/index and draft generation                                                               | pre-commit failure tombstones/cleans only operation-owned root; accepted draft survives provisioning failures, while explicit DeleteTeamDraft owns later deletion                                         |
| Launch/relaunch                           | `team-lifecycle` atomically accepts a new LifecycleRun/generation/immutable CompositeRuntimePlan and advances TeamLifecycle.currentRunRef | `team-runtime-control` executes lanes; failure never reopens an older run or deletes the draft/team, and ambiguous/partial effect remains recovering or operator_required                                 |
| StartTask / create-startImmediately       | `team-task-board` commits task revision, status and work interval                                                                         | `team-messaging` persists/delivers owner notification after commit; failure does not roll back started work and is returned as not_required/persisted/delivery_failed, never inferred from owner presence |
| RequestReview                             | `team-task-board` commits review-request/task workflow state                                                                              | notification/runtime delivery has an explicit outcome; `team-review` owns later diff/change-set decisions, not the task transition                                                                        |
| Apply/reject/edit review                  | `team-review` claims changeSet/sourceGeneration decision and apply intent                                                                 | workspace/Git adapter verifies source hash; stale is conflict, partial apply is recoverable and never marks review complete                                                                               |
| Add/replace/remove/restore/restart member | `team-lifecycle` commits TeamRoster rosterGeneration/MemberId/memberRevision plus compatible config intent                                | runtime-control binds lane attempt to the plan snapshot and task-board preserves historical owner mapping; config success with failed stop/restart/reassignment is degraded/recovering, not clean success |
| Approval decision                         | `team-approvals` atomically claims/audits the decision                                                                                    | runtime-control delivery transitions delivering/delivered/delivery_unknown; provider timeout never reopens the decision                                                                                   |
| Delete/restore/permanent delete           | `team-lifecycle` DeletionSaga owns TeamId lifecycle/tombstone generation                                                                  | v1 runtime stop and task/message/review archives are explicit public steps/compensations; partial cleanup is operator_required and never delegated to RunRecoveryWorkflow                                 |
| Attach/detach content                     | `agent-attachments` owns bounded blob lifecycle; task-board/messaging owns its reference                                                  | upload is unreferenced until the feature command commits; failed reference cleans by orphan TTL, delete refuses live references                                                                           |

An after-commit event may trigger a best-effort projection refresh, but any secondary effect visible
to the user has persisted delivery/saga status. No feature reports aggregate success by catching and
discarding another feature's failure as current startTask notification code does.

### Small shared kernel

The shared kernel is intentionally boring and stable. It may contain:

- branded opaque IDs and parsing helpers: DeploymentId, BootId, WorkspaceId, TeamId, RunId,
  MemberId, TaskId, ApprovalId, RequestId;
- UTC timestamp/duration primitives plus Clock;
- IdGenerator and deterministic test implementations;
- AppError envelope categories, not feature-specific error catalogs;
- ActorContext, RequestContext, cancellation/deadline, pagination and revision primitives;
- Result/Outcome helpers only if the repository already standardizes them.

It must not contain Team DTOs, provider models, filesystem schemas, route manifests, repositories,
React types, Electron types, Fastify types, or generic `Manager`/`Service` abstractions. A concept
enters the shared kernel only when at least three features need identical semantics and its owner is
stable. Otherwise it stays feature-local.

### Selective DDD boundaries

DDD is used only where illegal transitions, concurrent writers, recovery, or multi-step rollback
make an anemic CRUD model unsafe.

#### TeamLifecycle and LifecycleRun aggregates

Draft/team existence and one execution attempt are different consistency boundaries. Do not put a
pre-launch draft into an aggregate whose identity requires RunId.

`TeamLifecycle` identity is `(deploymentId, teamId)`. It owns identity/draft generation,
TeamWorkspaceBinding reference, deletion/tombstone state and at most one currentRunRef:

    draft -> idle -> active -> idle
       \       |       /
        +------v------+
          soft_deleted --restore--> priorNonDeletedState
                |
                v
             deleting -> deleted

Only `soft_deleted` is restorable; `deleting` starts permanent deletion and cannot transition back.
`recovery_blocked` is an orthogonal admission condition with evidence, not a shortcut transition
that rewrites the last committed lifecycle state. A draft becomes idle/active only through the
provider-compatible materialization/accepted-launch workflow. Soft delete cannot hide a live run;
the saga stops/fences it before committing the deleted projection.

`LifecycleRun` identity is `(deploymentId, teamId, runId, generation)`. It is created only when
LaunchTeam is accepted and the immutable CompositeRuntimePlan is persisted:

    accepted -> provisioning -> ready <-> degraded
    accepted|provisioning -> cancelling -> cancelled
    ready|degraded -> stopping -> stopped
    provisioning|stopping -> failed  (only with terminal evidence/cleanup status)

Rules:

- CreateTeamDraft/UpdateTeamDraft/DeleteTeamDraft never fabricate RunId;
- PrepareProvisioning is a bounded preflight result keyed by input/capability revision and does not
  become a durable run merely because checks passed;
- every accepted launch creates a new runId and monotonically increasing generation, then updates
  TeamLifecycle.currentRunRef through compare-and-commit;
- a terminal run is immutable except for bounded late diagnostic evidence; relaunch creates a new
  run rather than reopening stopped/failed/cancelled state;
- commands for an older currentRunRef/generation fail with a typed stale-revision outcome;
- `ready` requires provider-specific verified evidence, not only a PID or config file;
- ready/degraded may recover in either direction from fresh evidence; cancel/stop first fence new
  effects and enter their explicit transitional state before terminal cancelled/stopped;
- stop is idempotent for the same generation and cannot stop a newer run;
- failure preserves diagnostics and RunId-owned cleanup obligations without deleting the team/draft;
- aggregates contain business facts, never ChildProcess, tmux, Electron, timer, or watcher objects.

ProcessSupervisor and filesystem repositories are ports used by lifecycle application commands.
They are not aggregate members. A single lifecycle application coordinator owns the compare-and-
commit between TeamLifecycle.currentRunRef and a newly accepted LifecycleRun; renderer, provider and
transport code cannot update either side independently.

Initial authority is deliberately split by fact type, not duplicated:

- internal-storage owns the accepted LifecycleRun identity/generation, immutable
  CompositeRuntimePlan/checksum, TeamLifecycle.currentRunRef and lifecycle command/recovery status.
  Acceptance of all four is one SQLite transaction before spawn;
- existing launch-state/journal stores own provider execution/bootstrap/progress evidence and required
  provider-compatible projections after acceptance. They do not select the current run or replace the
  immutable plan; every record must match RunId/generation/plan checksum or is stale/conflicting evidence;
- OwnedProcessSupervisor owns current process identity/exit observations for processes this instance
  launched or safely adopted;
- provider adapters own interpretation of provider-specific freshness evidence;
- internal-storage additionally owns opaque identities, feature revision and event outbox, but does
  not copy provider stdout/bootstrap/liveness evidence into a second provider state machine;
- LifecycleRun projection deterministically combines those facts. If durable intent and fresh
  evidence disagree, it reports recovering/degraded/disconnected according to the transition table,
  never whichever source was read last.

If acceptance commits but the compatibility launch-state projection fails, the run remains accepted/
recovering and no spawn occurs until projection recovery verifies the same plan checksum. If a legacy
provider file appears first, it is external evidence only and cannot create or replace currentRunRef.
Changing this authority split requires a separate storage migration ADR. It cannot happen as a
cleanup inside a transport or renderer PR.

#### WorkspaceRegistration aggregate

Identity is WorkspaceId, allocated from immutable operator registrationKey. It owns the declared root
descriptor, mount policy, read/write permissions, repository association, status, and registration
revision. Boot-scoped canonical realpath/device/mount evidence belongs to WorkspaceMountBinding, not
to stable WorkspaceId. Neither exposes the authoritative root path in a browser DTO. Realpath and
platform-specific containment checks remain in an output adapter but are required against the current
mountGeneration before every spawn or sensitive file operation, not only at registration.

This aggregate belongs to `workspace-registry`, not the app-level hosted composition. Team lifecycle, terminal,
review/attachments, and Git/worktree commands call its narrow public authorization query. Hosted
composition supplies manifest/mount adapters; Electron supplies a compatibility adapter for
desktop-selected projects until opaque identity migration is complete.

#### TeamWorkspaceBinding aggregate

Identity is TeamId with monotonically increasing bindingGeneration. States are unbound, bound,
mismatch, rebinding and disabled. `team-lifecycle` owns the binding transition because it coordinates
team config/run safety; `workspace-registry` remains the authority that validates a candidate
WorkspaceId/root capability. Mutable legacy projectPath/cwd is evidence compared with the binding,
not its source of authority. Rebind is forbidden during an incompatible active run and uses the
mutation intent protocol so config/file evidence and internal binding cannot silently diverge.

#### TeamRoster and member identity

`TeamRoster` is a TeamId-scoped versioned consistency boundary owned by team-lifecycle. It has one
monotonic rosterGeneration and entities:

    MemberId
      -> immutable LegacyMemberKey
      -> memberRevision
      -> active | removed
      -> provider/model/role/workflow/isolation configuration

MemberId is the browser/domain identity. LegacyMemberKey is the provider/config/inbox/log compatibility
name and is never browser authorization. It is validated with the current CLI naming policy plus a
case-folded uniqueness check. Removal and restore retain MemberId/LegacyMemberKey and advance revision;
role/provider/model/replace mutations retain the logical MemberId only when they explicitly target it
and advance memberRevision. A new logical member cannot reuse a removed key implicitly.

Restart within one LifecycleRun does not create a new MemberId: the immutable CompositeRuntimePlan
binds MemberId + memberRevision + LaneId, and runtime-control advances a lane attempt/instance identity.
Late evidence from an older memberRevision/lane attempt is stale. Task owner/from strings and inbox/log
directory names resolve through the roster snapshot; unresolved or removed names remain historical
unbound projections rather than being attached to a new member.

Legacy adoption reconciles config.json and members.meta.json by exact/case-folded key, removedAt and
provider evidence. A single unambiguous entry receives a new MemberId. Case collisions, conflicting
active/removed state or CLI auto-suffixed aliases do not silently merge/drop: they produce
`roster_identity_ambiguous` and block member/runtime mutation while safe diagnostics remain. A
provider-specific manifest may classify an auto-suffixed name as a RuntimeAlias for one plan/lane,
but RuntimeAlias never becomes a second MemberId without an explicit roster command.

Canonical member commands accept TeamId, MemberId and expected rosterGeneration. Desktop IPC maps a
legacy memberName only after resolving exactly one current roster entity. `replaceMembers` is a
deterministic set-diff command over MemberIds/revisions, not delete-all/recreate-by-name.

#### ApprovalDecision aggregate

Identity is `(teamId, approvalId)`. States are pending, claimed, decided, expired, and cancelled.
It owns one-decision-only semantics, policy snapshot, actor attribution, claim expiry, idempotency
key, and audit fact. Multiple tabs can observe the same pending approval, but only one accepted
decision commits.

#### Task aggregate

Use a task aggregate only for revisions, dependency/relationship invariants, assignment/status
transitions, and work intervals. List, filter, activity, and Kanban reads are projections. Multi-task
relationship updates use a task-board application transaction/saga because one Task object cannot
atomically own both sides of a graph edge in provider-owned JSON.

#### DeletionSaga and RunRecoveryWorkflow

These are separate durable workflows with separate state and owners:

- `DeletionSaga` is TeamId/lifecycle-generation scoped. It owns soft delete, restore, explicit draft
  deletion and permanent deletion/tombstone. It coordinates v1 runtime stop and feature
  archive/removal through public commands, stores completed steps/compensations and cannot mutate a
  newer currentRunRef.
- `RunRecoveryWorkflow` is RunId/generation/plan scoped. It owns failed provisioning cleanup,
  controller-restart reconciliation, ADR-22 residual classification and RunId-owned artifact cleanup.
  It cannot delete TeamId, draft metadata, identity anchor, backups or another run generation.

Each stores current step, target generation, request/workflow idempotency key, lease-fenced claim and
last safe error. Restart resumes or safely classifies each independently. They may reuse small durable
workflow scheduling/claim primitives, but there is no generic saga service allowed to write both
features' repositories or infer business compensations.

Everything else - list queries, logs, provider catalogs, message pages, capability manifests, and
health - stays as simple validated projections. No aggregate/repository ceremony is added to reads.

### Commands, queries, outcomes, and contexts

Application APIs are explicit functions or cohesive modules; a class per use case is not required.
Transport request objects never enter application code.

Every mutation receives a CommandContext containing:

- stable actorId, current sessionId and authorization claims as distinct values;
- deploymentId and bootId;
- requestId and operation idempotency key where retry is legal;
- expected entity/run revision or generation where stale writes are dangerous;
- deadline/cancellation signal;
- workspace authorization resolved to an opaque registration.

Every query receives a QueryContext with actor/session, deployment/boot identity, requestId,
deadline/cancellation, and authorized scope. Queries return immutable DTO-ready projections plus
revision/cursor metadata. They do not leak repository entities or mutable adapter objects.

Commands return typed outcomes such as accepted, completed, no-op-idempotent, conflict,
unsupported-capability, degraded-provider, or retryable-busy. Expected business outcomes are not
encoded as arbitrary exception strings. Unexpected faults become safe AppError responses with a
diagnostic id; raw provider stderr and host paths remain server-side.

Use-case example:

    launchTeam(command, context)
      -> validate feature policy and expected generation
      -> resolve WorkspaceRegistration
      -> request team-runtime-control LaunchPlan
      -> atomically commit command accepted + LifecycleRun + plan + currentRunRef + outbox
      -> return LaunchTeamAccepted(commandId, runId)

    lifecycleWorkflowRunner(runId)
      -> claim accepted run with lease fence
      -> publish required compatibility projection
      -> execute/adopt supervised process plan through ADR-22
      -> commit progress/terminal lifecycle facts and outbox events

HTTP and IPC adapters both parse their own wire input into this command and map the same outcome to
transport-specific response mechanics. Neither adapter contains the sequence above.

### Port design without interface explosion

Create a port only for an independently replaceable, security-sensitive, failure-prone, or atomicity
boundary. Keep related operations cohesive when they must share a transaction or consistency model.

Good port shapes:

- HostedAccessRepository: atomically consume challenge, rotate/revoke device family and create/expire
  sessions; AuthKeyring: load/create/rotate only under startup/reset rules; ResidualActorDrainPort:
  typed v1 runtime drained-or-blocked evidence without process internals; post-v1 T1 extends the
  residual catalog for terminal ownership without changing hosted-access core semantics;
- TeamLifecycleRepository: load/commit lifecycle snapshot with expected revision;
- TeamMutationCoordinator: atomic file/journal operation boundary for related legacy artifacts;
- ProviderRuntimeRegistry: provider capabilities plus creation of a launch/adoption plan;
- OwnedProcessSupervisor: spawn/adopt/signal/observe only instance-owned processes;
- WorkspaceRegistry: resolve opaque identity and authorize a bounded operation;
- EventJournal: append-after-commit, replay by scoped revision, retention watermark;
- ApprovalRepository: claim/decide with compare-and-swap semantics;
- Post-v1 `TerminalSessionGateway`: create/resize/input/close for an authorized terminal session; it is
  not created or injected by the v1 composition.

Rejected shapes:

- one method interface for every trivial function;
- `TeamManager`, `RuntimeService`, `StorageService`, or `PlatformAdapter` containing unrelated methods;
- ports carrying Electron event objects, Fastify requests, Node ChildProcess, React state, or raw
  provider JSON beyond the adapter boundary;
- a universal repository with `get/save/delete<T>`;
- inheritance hierarchies where independent capability composition is sufficient.

Interface segregation is applied at consumer boundaries. A renderer hook for task comments receives
`TaskCommentsClient`, not TeamsAPI. A provider adapter implements only the team-runtime-control contracts
it genuinely supports. Unsupported capability is represented in the manifest and rejected before
invocation; there is no fake implementation that throws after the UI calls it.

### Dependency direction and public entrypoints

Allowed direction inside a feature:

    contracts <- renderer adapters/hooks/UI
    contracts <- preload and input adapters
    domain <- application
    application ports <- output adapters/infrastructure
    composition -> application + adapters + infrastructure

Core rules:

- `core/domain` imports only feature-local domain types and the tiny shared kernel;
- `core/application` imports feature contracts/domain and owned ports, never Electron, Fastify,
  React, Zustand, fs, path, child_process, provider SDKs, or `@main/*`;
- input adapters perform authentication binding, schema parsing, wire mapping, and status/channel
  mapping, then call application use cases;
- output adapters translate core intent to legacy services, filesystem, SQLite, provider protocols,
  process supervision, or event journal operations;
- renderer UI imports neither global store nor transport directly; hooks/adapters own that seam;
- outside a feature, production code imports only its documented root or layer entrypoints;
- cross-feature deep imports and dependency cycles are build failures.

Cross-feature behavior uses one of four explicit mechanisms:

1. a synchronous public application command/query for required immediate work;
2. an after-commit domain/application event for eventually consistent reactions;
3. a composition-owned saga for multi-feature durable workflows;
4. a read-model projector for joined UI projections.

Events are facts in past tense and contain stable IDs/revisions, not instructions or adapter objects.
Consumers must be idempotent. Publishing before the owning state commits is forbidden.

### Renderer composition and read projections

`team-console` replaces the orchestration responsibilities currently hidden in the global teamSlice
and oversized team-detail screen. It is a thin composition feature, not a backend bounded context.

It owns only:

- selected TeamId/WorkspaceId and navigation context;
- one bootstrap state machine for login/capabilities/selection/reconnect;
- TeamTransportReconciler, event cursor, bootId and feature-topic routing;
- composition of lifecycle, task-board, messaging, review, and approval renderer entrypoints;
- stale response suppression when selection, bootId, run generation, or request scope changes.

Each owning feature keeps its own normalized read projection and mutation state. The console passes
opaque IDs and capability clients; it does not copy feature entities into a second canonical store.
Feature UI may use Zustand slices if useful, but slices expose feature-local actions/selectors and
cannot call another feature's adapter directly.

Initial page bootstrap is a bounded query bundle assembled in the app composition from public feature
queries. Its envelope contains deploymentId, bootId, capability revision, event cursor, and a
per-feature revision vector. It is an optimization, not a separate source of truth. Each payload
member keeps its owning feature schema/version, and a partial unavailable feature returns a typed
degraded result rather than erasing other valid projections.

Realtime routing follows ownership:

    scoped event envelope
      -> TeamTransportReconciler validates deployment/boot/selection/cursor
      -> route by feature topic
      -> owning feature reconciler validates team/run/entity revision semantics
      -> apply or request owning feature snapshot

A cursor gap, schema mismatch, boot change, or retention watermark triggers a bounded rebootstrap.
It does not clear the last valid UI until authorization loss or confirmed deletion. Polling is a
fallback query source through the same reconciler, never a second reducer path.

Renderer migration is a strangler, not a second store rewrite:

1. Freeze current selectors/race/render behavior with existing characterization tests and a small
   reference-scale performance fixture.
2. Introduce narrow facet clients behind the current teamSlice actions first; this changes transport
   dependency without changing state authority.
3. Extract only scope/cancellation/event-cursor/topic routing into TeamTransportReconciler while
   teamSlice remains the only writer. Move run/tombstone rules to team-lifecycle, task revision rules
   to team-task-board, message head/older-page rules to team-messaging, and request resolution rules
   to team-approvals.
4. Move one projection at a time to its owning feature, starting with lifecycle read state. A
   compatibility selector may read the new projection for legacy components; events never write both
   old and new canonical stores.
5. Migrate UI components/hook orchestration through feature renderer entrypoints, preserving existing
   Radix primitives, localization, focus and keyboard behavior.
6. Delete each legacy field/action/event handler only after all selectors/callers are migrated and
   desktop IPC plus hosted HTTP/event permutations pass the same reducer fixtures.

Gates include bounded request/event fanout, no duplicate SSE subscription per browser session, no
extra full-team fetch when only one feature revision changes, structural sharing for unchanged
entities, and reference-scale render/heap budgets. Architecture can be clean and still unusable if
every event causes a 13k-line UI tree to refresh.

### Composition roots

There are three application compositions:

- Electron composition: existing main-process shell, feature IPC adapters, desktop infrastructure;
- hosted Node composition: Fastify/static/auth/SSE shell plus the same feature application
  factories and hosted infrastructure;
- deterministic test composition: in-memory/temporary adapters, fake clock/IDs, fake provider
  executables, real application use cases, optionally real HTTP listener/browser.

Feature factories accept explicit dependencies and return narrow public facades plus lifecycle
components. The app-level composition is the only place allowed to choose concrete adapters and
connect features. It may know every feature, but it contains no business decisions.

Each long-lived component implements a small operational contract:

    start(signal) -> readiness result
    readiness() -> typed reason set
    stop(deadline) -> drain/flush result

Startup is ordered and fail-closed: the ADR-16 launcher acquires and retains the kernel lease before
Node exists; Node validates the inherited descriptor, immutable config/mounts/artifacts, then binds the
private listener in `starting` admission mode (liveness and safe startup reason only), opens
coordination storage, recovers journals/sagas, classifies and stops residual runtimes required by
the trusted-process boundary, reconcile ADR-7 device/session/reset state and create plaintext pairing
material only when initial/reset recovery requires it, establish the watch-before-scan barrier, start
provider supervision, then advance explicit auth/read/mutation readiness states.
All registered product/runtime routes return typed 503 while their state is not ready. Failure unwinds
only components started by this instance in reverse order, removes owned bootstrap material and exits
non-zero after bounded diagnostics; it never leaves a pairing token beside an unclassified runtime
or reports mutation-ready before recovery/initial reconciliation completes.

### Practical DRY policy

Share stable semantics, not coincidentally similar syntax.

Share early:

- domain invariants and transition functions;
- browser-safe schemas and error/event envelopes;
- use cases called by both IPC and HTTP;
- revision/idempotency/reconciliation algorithms;
- security-sensitive normalization and redaction.

Do not prematurely share:

- IPC and HTTP wire mechanics;
- provider-specific DTOs merely because fields overlap;
- legacy JSON and app-owned SQLite records;
- UI view models and persistence entities;
- two parsers whose unknown-field or corruption behavior differs.

Duplication is temporarily acceptable until equivalence is proven by contract tests or a third
consumer appears. Extraction must reduce semantic ownership, not merely line count. A shared helper
with feature flags or provider switches is usually evidence that the boundary is wrong.

### Strangler sequence for legacy code

The clean branch does not rewrite `teams.ts`, TeamDataService, teamSlice, and provider integrations
simultaneously. It moves one behavior at a time to a single new authority:

1. Characterize current desktop behavior and record invariants.
2. Define the owning feature contract, application command/query, and ports.
3. Implement compatibility output adapters over the base branch's mature services/formats.
4. Make the existing IPC handler delegate to the new use case without changing desktop UX.
5. Run desktop characterization and parity tests.
6. Add hosted HTTP/SSE input adapters to that same use case. WS is added only by a future capability
   that semantically requires it; v1 team operations do not prebuild a generic socket path.
7. Migrate renderer callers to narrow capability clients, TeamTransportReconciler and the owning
   feature reconciler/reducer.
8. Remove the old handler/service path only when no caller uses it and both transports pass
   conformance tests.
9. Replace compatibility output adapters with cleaner infrastructure later, behind unchanged ports,
   only when persistence/provider behavior is understood.

At no point may desktop and hosted both be authoritative for the same lifecycle mutation. Shadow
mode is read-only comparison only. Dual-write migration requires a durable journal and is avoided
unless a specific storage transition cannot be performed otherwise.

### Architecture fitness functions

The following automated checks land before broad implementation and fail CI:

- forbidden-import test for Electron/Fastify/React/Zustand/fs/path/child_process/@main under all
  `core/` and browser-safe `contracts/` folders;
- public-entrypoint test preventing cross-feature deep imports;
- dependency-cycle check across features and layers;
- TeamTransportReconciler isolation check: no lifecycle/task/message/approval entity imports, store
  writes, run selection, tombstones or pagination logic;
- renderer check forbidding `window.electronAPI.teams` and direct hosted transport access in migrated
  feature UI/hooks;
- hosted renderer reachability check rejecting any Electron/preload/mega-client/desktop-only
  entrypoint from hosted route chunks and rejecting unavailable capability effects/listeners at mount;
- type-level check that hosted clients implement only advertised capability facets, never ElectronAPI;
- RouteCatalog conformance across feature descriptors, Fastify registration, hosted client,
  authorization policy, capability manifest, and E2E coverage;
- trust-surface manifest check proving browser clients/cookies cannot reference runtime-ingress routes
  and runtime credentials cannot authorize operator routes;
- command conformance proving IPC and HTTP reach the same application use case/outcome mappings;
- repository-write ownership check preventing direct config/tasks/inbox writes outside approved
  output adapters;
- team-runtime-control check preventing direct spawn/kill outside OwnedProcessSupervisor;
- composition test cross-checking execution and machine-ingress provider IDs/verbs without requiring
  every provider to implement unsupported ingress operations;
- schema fixture tests for current, legacy, future, partial, and corrupt provider artifacts;
- no-stub gate scanning reachable hosted methods for throw/no-op/fabricated-success implementations.

Target base already violates several final rules, so gates use a ratchet rather than pretending the
repository is greenfield:

- new feature/core/contracts code has zero exceptions from its first commit;
- legacy violations are captured once by stable file + symbol, not a fragile total count;
- CI rejects new or widened violations and rejects moving a violation to another legacy file;
- each vertical slice removes the entries for the behavior it migrates;
- final hosted readiness requires zero allowlisted team/review browser stubs, zero hosted terminal
  imports/effects and zero direct Electron bypasses, even if unrelated desktop debt remains.

Every temporary allowlist entry has an owner, exact reason, removal phase and focused regression
test. An entry without a removal gate is a failed architecture check, not documentation.

### Explicit non-goals against overengineering

- no generic application framework or plugin framework;
- no event sourcing as primary product storage;
- no distributed broker for single-instance v1;
- no CQRS infrastructure beyond practical command/query separation;
- no class/interface/file per use case requirement;
- no ORM over provider-owned or CLI-owned JSON;
- no universal repository, service locator, or dependency injection container;
- no multi-tenant authorization model hidden inside a single-tenant release;
- no rewrite of mature provider adapters solely to match folder aesthetics;
- no abstraction whose only implementation and only plausible consumer are the same module.

### Pre-implementation evidence gates

The plan does not pretend runtime unknowns can be removed by naming more interfaces. Each high-risk
unknown has a bounded evidence task that must close before dependent implementation expands.

| Gate                     | Evidence required                                                                                                                                                                                                                                                  | Blocks                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Base truth               | exact remote base SHA, clean checkout, required-check results, pre-existing failure classification                                                                                                                                                                 | all production work                                       |
| Renderer truth           | action/callsite inventory plus characterization of selection races, snapshot richness, message pagination, optimistic run replacement and tombstones                                                                                                               | team-console/store migration                              |
| Identity/workspace truth | team metadata fixtures plus manifest schema for anchored/unanchored/duplicate/corrupt IDs, rename, missing/remounted/overlapping roots and forbidden rebinding                                                                                                     | canonical IDs and first hosted mutation                   |
| Path-containment truth   | built Linux guard in the final image; `openat2`/`statx`/seccomp/filesystem probe; successful file, Git and provider-spawn operations; deterministic parent/final symlink, rename, bind-mount and stale-generation race failures                                    | every v1 hosted workspace read/write/Git/spawn capability |
| Persistence truth        | authoritative file catalog, ADR-29 writer class/active-writer evidence per operation/provider version, atomicity, unknown-field behavior, size/permission limits and golden fixtures                                                                               | first hosted mutation                                     |
| Provider truth           | per-provider launch/preflight/auth/liveness/stop/recovery matrix and deterministic adapter fixtures                                                                                                                                                                | capability advertisement and real launch                  |
| Runtime-ingress truth    | producer/direction/schema/authority/idempotency/rate/credential mapping for bootstrap, delivery, task event, heartbeat and permission flows                                                                                                                        | machine route registration and provider launch            |
| Credential/env truth     | ADR-18/30 ProcessExecutionUnit exposure sets, key-provenance ledger, per-backend allowlist, relay derived scope, controller/out-of-set secret canaries and explicit same-UID non-isolation claim                                                                   | any provider exec or machine ingress                      |
| Process truth            | ADR-31 final-image anchor/pidfd/subreaper/control/status evidence, shutdown/rollback rules, PID/PGID reuse marker and double-fork/orphan scan                                                                                                                      | real ProcessSupervisor use                                |
| Terminal truth (post-v1) | ADR-35 two-plane grant/regrant schedules, hosted method matrix, inherited-FD guard/exec proof, daemon/socket/store ownership, allowlist-first shell environment canaries, aggregate-byte/projection/backpressure bounds and portable-pty descendant drain evidence | future hosted terminal capability only                    |
| Hosted boundary truth    | actual built Fastify/static/auth/SSE plus separate runtime-ingress topology, proxy/origin behavior and container filesystem/user model; WS added only with ADR-35                                                                                                  | browser E2E and deployment                                |

Every gate produces versioned fixtures or a checked-in decision table, not only notes. A failed gate
narrows or disables the affected capability; it does not cause a generic abstraction or a silent
fallback. No real provider launch is needed to close these gates: deterministic fake
executables and sanitized artifact fixtures are the default. Any optional live provider proof uses
only a newly created sandbox project under the repository's critical safety guardrails.

Decisions fixed before Phase 1:

- single hosted writer per runtime root;
- single tenant/operator v1;
- pairing-to-durable-device-grant-to-short-session browser auth for v1, with host-controlled reset;
- canonical `/api/hosted/v1` namespace;
- HTTP for commands/queries and SSE for durable feature events in v1; WebSocket is reserved for the
  post-v1 terminal capability and no generic WS abstraction is introduced early;
- compatibility reads/writes for legacy provider files plus app-owned SQLite for coordination data;
- team-runtime-control is the only team process-execution authority; runtime-provider-management
  remains the provider installation/settings authority;
- opaque browser identities and registered workspace roots;
- ADR-28 Linux workspace guard is required for hosted workspace effects; Node path-string fallback is
  forbidden and an unsupported kernel/seccomp/filesystem disables the affected capability;
- ADR-30 controller bearer stays in a per-lane relay and hosted child environments are allowlist-first;
- ADR-31 process anchor is required for hosted provider launch; PID/start-token kill fallback is forbidden;
- no broad ElectronAPI compatibility promise in browser mode;
- no visible capability without a real server implementation and negative security tests.

These decisions may change only through an ADR that identifies affected contracts, migrations,
tests, rollout and rollback. Ordinary implementation convenience is not sufficient reason.

## Architecture decisions

### ADR-1: one real hosted server composition

The target-base `standalone.ts` + `HttpServer` + `standalone:build` + Docker path is the migration
source. Refactor it into a thin entrypoint and app-level hosted composition; do not introduce a
parallel `hosted:build` server until/unless it replaces standalone in the same atomic slice.

The default production hosted artifact serves:

- built renderer assets;
- canonical hosted API;
- authentication/session endpoints;
- SSE;
- private machine runtime ingress;
- health/readiness.

Do not port the closed PR's static-only hosted shell. If an existing developer preview ever serves
UI without runtime APIs, it is not built, documented, or tested as a hosted production artifact.

Production browser deployment is same-origin and does not require CORS. Runtime ingress does not use
browser CORS semantics and remains private plus token-authenticated whether it shares the listener or
uses a separate internal listener. If a separate browser API origin is later enabled, it has an exact
allowlist; wildcard credentialed CORS is never a hosted default.

### ADR-2: canonical versioned API

- /api/hosted/v1 is canonical for the browser.
- Route constants and runtime parsers have one owner.
- Server and client import the same contract entrypoint.
- Target-base non-team `/api/*` routes remain temporarily for the existing standalone session viewer.
- Legacy `/api/teams` remains a compatibility adapter for loopback/desktop migration only; it is not
  registered or advertised as the remote hosted team contract.
- No browser code calls legacy routes directly.
- A route/use-case manifest test proves legacy and canonical routes cannot acquire independent
  business implementations while both exist.
- A same-origin meta endpoint exposes buildId, contractVersion, capabilitySchemaVersion, stable
  deploymentId, and per-process bootId. The client detects incompatible versions and
  offers/requires a reload.
- index.html is no-cache and assets are content-hashed/immutable so a deployment cannot silently run
  stale JavaScript against a newer contract. No service worker is introduced without an explicit
  upgrade/cache strategy.

### ADR-3: IPC and HTTP share application semantics

Both transports call the same use case.
Transport adapters only:

- validate/parse input;
- establish auth/actor context;
- map DTOs;
- map typed errors to transport responses.

They do not read config.json, mutate caches, or know storage paths.

### ADR-4: explicit single-tenant v1

- One deployment equals one operator/tenant.
- One runtime root has one hosted controller/app writer process.
- Provider/CLI agents that write compatible JSON are explicit external protocol participants; their
  writes are reconciled and cannot be assumed to acquire app locks.
- One process owns its child runtimes.
- Multi-user isolation is achieved with separate containers/OS identities.
- Shared-process SaaS is a separate future project.

Hosted v1 must use a dedicated appDataRoot/coordination database and a deliberately mounted Claude
runtime root. A desktop Electron instance is another application writer, not a harmless provider
writer: it may not concurrently open the same hosted appDataRoot or mutate the same team root. The
supported handoff is stop desktop/hosted, flush and back up, run the compatibility scan/import, then
start exactly one controller. Read-only export/import is allowed; live desktop+hosted dual authority
is not. Startup metadata records deployment mode/root identity, and a detected incompatible desktop
owner or foreign app-writer marker keeps mutation readiness false.

### ADR-5: explicit RuntimeInstanceContext

Introduce immutable runtime context:

- stable deploymentId;
- per-process bootId used for ownership and stale-response detection;
- claudeRoot;
- appDataRoot;
- workspaceRoots;
- tempRoot;
- logsRoot;
- platform;
- deploymentMode;
- capability policy.

deploymentId is loaded from the validated app-owned state-root identity and follows ADR-26; it is not
derived from hostname/public URL or regenerated on every boot. bootId is always newly generated.

Do not rely on module-global setClaudeBasePathOverride in hosted composition.

TeamDataService/ConfigManager adapters that still depend on module-global roots are desktop
compatibility adapters only. Hosted adapters receive RuntimeInstanceContext explicitly and may reuse
pure parsing/writing helpers, but cannot hide a singleton/root override behind an application port.

### ADR-6: opaque workspace IDs

Browser requests never carry an authoritative host path.

The `workspace-registry` application boundary maps:

    opaque workspaceId -> stable registration -> current boot mount binding -> policy/capabilities

Every sensitive operation rechecks:

- registration;
- current bootId/mountGeneration;
- allowed root containment;
- realpath;
- symlink/mount identity;
- permissions;
- operation-specific capability.

Browser contracts use server-minted workspace/artifact/review/attachment references, not absolute
paths and not free-form relative paths. A compatibility endpoint that still receives a legacy
relative path must reject absolute/drive/UNC/NUL/dot-segment input before lookup and may return only
a newly minted opaque reference; it cannot execute the requested operation directly.

For reads/writes below an agent-writable tree, lexical containment is insufficient. Hosted Linux uses
the ADR-28 workspace guard to resolve beneath a verified directory descriptor and to keep the checked
object/cwd bound to that descriptor through the effect. Node `realpath()`, post-read verification and
`O_NOFOLLOW` on only the final component are characterization-era desktop defenses, not the hosted
security boundary. If ADR-28 cannot prove an operation on the running kernel/filesystem/container,
that operation's hosted capability stays disabled; no path-string fallback is allowed.

Team routes likewise use an opaque stable teamId. Existing legacy directories are adopted through
an app-owned TeamIdentityRegistry:

    opaque teamId -> legacy teamName/directory -> workspaceId -> identity generation

`legacy teamName/directory` is modeled as immutable `LegacyTeamKey`, not as TeamId and not as the
mutable display name. It exists only because current CLI/provider/task/backup layouts require the
same directory segment across multiple roots. The canonical CreateTeamDraft request may carry a
non-authoritative `requestedTeamKey` solely as creation input to preserve current UX. The application
validates the exact lowercase ASCII policy (`^[a-z0-9][a-z0-9-]{0,127}$`), cross-platform reserved
names and direct-child semantics; it never accepts a path or silently normalizes a different key.
The renderer may suggest a slug, but the server decides availability and returns TeamId.

The adoption/create intent reserves `(TeamId, LegacyTeamKey)` together and checks the identity index,
tombstones, team/task/backup roots and filesystem-aware case-folded directory inventory before any
file write. After commit, every browser URL/cache/command uses TeamId; LegacyTeamKey is adapter-only
provider evidence. It is never changed by display rename and is never reused within a v1 deployment,
even after permanent delete, because old runtime callbacks, backups, JSONL and watcher events still
carry teamName. A repeated display name receives a different suggested key/suffix. Legacy directories
that are unsafe, case-colliding, ambiguous across roots or outside the validated direct-child model
remain visible through a read-only `legacy_key_unsupported` projection and require explicit staged
maintenance migration; startup never auto-renames them.

Identity uses a dedicated app-owned `team.identity.json`, never `team.meta.json`, config.json,
members.meta.json or a launch-state file. Version 1 contains only schemaVersion, immutable random
TeamId, createdAt and optional non-authoritative originDeploymentId. It contains no display name,
directory, workspace path/ID, provider or mutable lifecycle state. TeamMetaStore and provisioning
writers do not read/write/delete fields inside it.

The existing TeamBackupService `identityId`/`_backupIdentityId` is not reused as TeamId. Adoption may
record it as untrusted legacy correlation evidence after checking config, backup manifest and registry,
but always mints a new canonical TeamId. This avoids turning a best-effort field in CLI-owned config,
which current same-name resurrection logic can rotate, into authorization identity. Backup schema v2
stores the canonical TeamId separately and stops treating legacy backup identity rotation as team
identity creation.
Backup v2 indexes sets by canonical TeamId plus opaque BackupSetId and records LegacyTeamKey only as
compatibility metadata. Existing teamName-keyed backup directories may remain as migrated physical
locations initially, but lookup/resurrection/prune decisions never use their basename as identity.

For a writable legacy team without an ID, adoption is a three-step replicated-identity protocol:

1. Internal-storage claims a directory/adoption intent with candidate TeamId and `prepared` status;
   this is recovery evidence, not yet a live identity mapping.
2. TeamIdentityFileStore publishes the file exactly once using a supported atomic exclusive-create
   primitive, mode 0600, no-follow path checks and file/parent fsync. It has createIfAbsent/read and a
   narrowly scoped recovery-republish operation, never arbitrary update/overwrite.
3. One SQLite transaction commits TeamId -> directory/workspace/generation, stores the identity-file
   checksum and marks the intent complete.

No live index mapping exists before file publication. The file is the portable anchor and the
committed SQLite record is the local admission/integrity authority; neither silently wins on
disagreement. The adoption intent also stores the canonical directory fingerprint, candidate ID,
workspace-binding evidence and expected absence/file checksum so recovery never guesses by name.
`DirectoryInstanceFingerprint` is local fencing evidence produced by the filesystem adapter from the
canonical parent/name plus available device/file identity and observed creation/config evidence. It is
not embedded in the portable identity file and is not expected to survive backup, cross-host restore or
an authorized move; those operations establish a new local fingerprint through their own staged saga.

The allowed identity states are explicit:

    prepared -> file_published -> committed -> tombstoned
         |             |              |
         +----------> aborted         +----> integrity_blocked

`aborted` and `tombstoned` candidate IDs are never reused. `integrity_blocked` is a diagnosis/admission
state, not a new identity. Recovery/reconciliation follows this matrix:

| File                                                       | SQLite intent/index                                       | Required action                                                                                                                              |
| ---------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| absent                                                     | matching prepared intent                                  | resume publish only if directory fingerprint and binding evidence still match; otherwise abort+tombstone candidate                           |
| valid                                                      | matching prepared/file_published intent, no committed row | verify global duplicate/tombstone/workspace constraints, then commit the same ID/checksum                                                    |
| valid                                                      | no intent or row                                          | classify as portable restore/import; stage and validate before an explicit adoption/import decision, never silently attach by directory name |
| valid                                                      | matching committed row/checksum                           | healthy                                                                                                                                      |
| absent                                                     | committed row                                             | integrity-block and require explicit repair; automatic startup republish would hide deletion/data loss                                       |
| different ID/checksum, duplicate ID, future/corrupt schema | any                                                       | integrity-block every affected mapping, retain both evidences and require explicit repair                                                    |

The explicit repair command may republish the same committed ID only after operator authorization,
global duplicate/tombstone scan, directory fingerprint/workspace-binding verification and a durable
repair intent. It can never allocate a replacement ID in place. Crash recovery is idempotent at
every row above and emits one audit/outbox transition when the effective state changes.

V1 exposes this through a distinct `team-identity-recovery` capability only when the deployment is
started in explicit maintenance mode. Normal team mutation admission and runtime launch are closed;
the paired durable OperatorId may read redacted evidence and submit one CSRF-protected command with
typed TeamId confirmation, expected file/index/backup hashes and an idempotency key. The server takes
a verified coordination backup before applying the durable repair intent. Maintenance mode cannot
mint a new identity for an existing committed mapping, accept a duplicate, or bypass workspace
registration. Every attempt is audited. The control is absent in normal mode, so ordinary TeamsAPI
parity cannot turn integrity failure into a casual repair button.

Although the file is app-owned, it lives beside paths touched by provider/CLI processes. Watcher
deletion/change is therefore a security/integrity event, not a normal external projection update. It
never allocates or republishes a TeamId automatically. A partial/corrupt/future file keeps the last
committed identity visible for diagnostics only while mutation remains blocked. Identity events use
their own narrow watcher/reconciliation path and cannot be suppressed as a known config/task write.

Lifecycle semantics are fixed:

- `CreateTeamDraft` allocates TeamId and publishes/commits the identity before the draft becomes
  externally visible. The durable draft and every later provisioning run reference that same TeamId;
  prepare/launch failure and retry never mint a replacement identity;
- draft creation extends the adoption intent with normalized draft input and expected legacy
  projection checksums: prepare candidate/binding, publish identity, write team.meta/members.meta
  through their compatibility stores, verify, then atomically commit identity index + draftGeneration
  - checksums + outbox in SQLite. Reads expose the draft only after commit. A crash with partial legacy
    projections remains recovering and either completes the same candidate or tombstones/cleans only
    operation-owned files; it never invents a second draft from directory presence;
- display-name changes never alter TeamId or require a directory rename. Any supported legacy
  directory relocation preserves LegacyTeamKey/basename and moves the whole directory with
  `team.identity.json`; v1 never renames the key. Soft-delete is a lifecycle marker, not a partial
  anchor move, and restore keeps the same TeamId/LegacyTeamKey;
- failure before the draft+identity commit may abort/tombstone the candidate and remove only the
  operation-created empty root through its cleanup intent. Failure of provisioning for an already
  committed draft/team records a failed RunId and removes only attempt-owned bootstrap/temp/runtime
  artifacts; it never recursively removes the team root, identity or retryable draft metadata;
- `DeleteTeamDraft` is an explicit idempotent lifecycle command with expected identity generation and
  tombstone/cleanup saga. It is never an implicit catch-block side effect of prepare/spawn failure;
- permanent delete commits the identity tombstone/generation fence before deleting directory/files;
  tombstone retention prevents late events or legacy-name reuse from attaching to a new team;
- backup/restore includes and verifies the identity file. Restoring a duplicate ID into one
  deployment blocks both mappings instead of silently assigning a new ID;
- old app versions may ignore the new file, but rollback cannot use a version whose delete/backup/
  restore behavior loses it. Compatibility matrix must explicitly allow or refuse that downgrade.

Publication has a hard prerequisite: every current path that can recursively delete, recreate, move,
restore or back up a team directory is either routed through the identity lifecycle adapter or blocked
for anchored teams. This includes deterministic create/spawn cleanup, draft cleanup, permanent delete,
backup restore/prune/reconciliation and same-name resurrection. A CI ratchet rejects new raw recursive
team-root removal outside the approved adapter. Soft delete may continue to mark config only because it
does not remove the anchor, but permanent delete must durably tombstone before filesystem removal.

If TeamIdentityFileStore cannot publish the file, the team may appear as `identity_unanchored`
through a deployment-stable opaque index entry, but all hosted mutations are disabled and an
external rename may be treated as remove+new identity. Do not fabricate full stable-identity
capability. displayName and legacy teamName remain projections, not authorization/cache keys.
Desktop IPC may keep teamName-shaped compatibility DTOs until callers migrate; canonical
application and hosted mutation contracts use anchored teamId.

Team -> workspace binding is server-owned versioned identity state, not whatever mutable
config.json projectPath/cwd was read last. Initial adoption canonicalizes the legacy path and must
match exactly one enabled registration/current mount binding; zero or ambiguous matches yield
`workspace_unbound`/read-only. The accepted WorkspaceId plus bindingGeneration is indexed in
internal-storage. `team.identity.json` deliberately does not embed deployment-specific WorkspaceId.

Evidence precedence is deterministic: an already committed TeamWorkspaceBinding wins; otherwise a
valid provider config projectPath/cwd is considered, while team.meta cwd is considered only for a
pre-config draft. If config and draft/meta evidence coexist and canonicalize differently, adoption
produces `workspace_binding_mismatch` instead of selecting one. A new browser draft starts from an
authorized WorkspaceId, commits its binding, and only then writes the legacy cwd projection required
by current provisioning. Neither display metadata nor the existing backup manifest projectPath can
create authority.

A browser-requested workspace/project/worktree change is a dedicated lifecycle command with expected
binding generation, no active incompatible run, full WorkspaceRegistry authorization and intent/
recovery. It writes compatible legacy fields only after committing the new binding intent. An
external agent/CLI edit to projectPath/cwd is observed as `workspace_binding_mismatch`; it never
rebinds authority or becomes a spawn/file/Git cwd automatically. Until explicitly accepted
or repaired, affected mutations and runtime launch are disabled while safe diagnostics/read remain.
Every operation resolves cwd from `(TeamId, bindingGeneration, WorkspaceRegistration)`, then compares
legacy config evidence and requests an ADR-25 grant for the current mountGeneration; it never resolves
WorkspaceId from a request/mutable file or reuses a prior-boot mount grant at the last moment.

Hosted v1 has one registration authority: a versioned operator-owned JSON startup manifest. An
environment variable may point to the manifest file but cannot encode workspace entries. There is no
browser registration endpoint and no new admin CLI in v1.

Each entry contains immutable registrationKey, displayName, declared rootPath, access mode,
Git/worktree capabilities and optional allowedWorktreeRoot. Internal-storage assigns/persists opaque
WorkspaceId by registrationKey; the declared rootPath hash is immutable for that key. Duplicate
keys/current roots, relative paths, overlapping writable roots, missing required mounts or a changed
declared rootPath for an existing key fail mutation readiness. Boot-local canonical/mount evidence is
versioned separately by ADR-25. Relocation uses a new registrationKey/WorkspaceId in v1.

Manifest removal disables the registration and retains its ID/tombstone; it never reassigns that ID.
Manifest changes require restart/reconciliation and invalidate affected sessions/capabilities.
Worktree creation is rejected unless repository and destination resolve inside explicitly allowed
roots; a sibling path is not implicitly trusted. Desktop uses a separate compatibility resolver for
locally selected projects, but cannot feed arbitrary paths into hosted composition.

### ADR-7: browser session, not secret in JavaScript

The earlier in-memory-session design was incomplete: the one-time pairing token was destroyed after
login, so session expiry, browser-cookie loss or backend restart could demand re-login when no
credential remained. Reissuing plaintext pairing material while same-UID runtimes were alive would
also violate the declared trusted-process boundary.

Three continuity designs were evaluated:

1. **Durable device grant plus short server session - chosen.**
   🎯 9/10 🛡️ 9/10 🧠 8/10, approximately 1,200-2,200 changed lines including proxy/security/browser
   tests. It survives ordinary restart and idle expiry while keeping browser secrets HttpOnly.
2. **One durable long-lived session only.** 🎯 7/10 🛡️ 7/10 🧠 5/10, approximately 700-1,200
   changed lines. Simpler, but a normal absolute expiry or lost cookie forces disruptive re-pairing,
   encouraging unsafe infinite session lifetimes.
3. **OIDC/passkey as mandatory v1 authentication.** 🎯 6/10 🛡️ 9/10 🧠 9/10,
   approximately 1,800-3,500 application lines plus external identity/deployment work. Strong but it
   broadens the single-operator Electron-decoupling scope and adds an availability dependency.

Primary guidance: OWASP requires meaningless high-entropy server-side session IDs, TLS, server-side
idle/absolute expiry and ID renewal after authentication/privilege change. Cookie `__Host-` semantics
require Secure + Path=/ + no Domain, but cookies are not port-bound. Fastify warns that forwarded
host/protocol values are spoofable unless the exact proxy chain is trusted. References:
[OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html),
[HTTP cookie prefixes](https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis#name-cookie-name-prefixes),
and [Fastify trustProxy](https://fastify.dev/docs/latest/Reference/Server/#trustproxy).

The chosen state has three separate records:

    PairingChallenge (one-time host bootstrap)
      -> OperatorDeviceGrant (durable re-authentication family)
      -> OperatorSession (short browser authority)

All plaintext values are independent 256-bit CSPRNG outputs. Coordination storage persists only
keyed hashes plus opaque record IDs, OperatorId, generation/family, issued/last-used/idle/absolute
expiry, replacement/grace metadata and revoked reason. Cookie values contain no identity/role/state.
Hash keys are app-owned bootstrap secrets, never child environment/config values. One versioned
`auth.keyring` is created with exclusive create, mode 0600, file+parent fsync and a random keyId/key
before auth storage opens; ordinary restart reuses it. Missing/corrupt keyring while auth rows exist
closes auth readiness and cannot silently generate a replacement/pairing file. Only a newer host reset
generation after runtime drain may revoke rows and rotate the keyring. ADR-26 excludes/rotates it and
revokes copied auth records rather than preserving browser authority. No key/value enters logs,
diagnostics, backup, provider mounts or child processes.

Do not hand-roll Cookie header parsing/serialization. Target-base uses Fastify 5.8.5 but has no cookie
plugin. At plan time `@fastify/cookie` 11.0.2 is the current stable package and its package tests use
Fastify 5; its parser runs in `onRequest`, before dependent security hooks. The implementation gate
must recheck the then-current stable release/compatibility table, pin the exact reviewed version and
run malformed/duplicate/cookie-limit tests. The plugin only parses/serializes these opaque tokens;
server-side keyed hashes remain the authority, so plugin-signed stateless sessions are forbidden.
Reference: [`@fastify/cookie`](https://github.com/fastify/fastify-cookie/tree/v11.0.2).

#### Pairing and operator recovery

1. Initial startup issues a `PairingChallenge` only when there is no active device grant and ADR-31
   reconciliation proves no live/unclassified same-UID runtime. It atomically writes the
   plaintext to one mode-0600 operator file under app-owned state, stores only its keyed hash and logs
   only a retrieval instruction/path. The token is submitted once in a bounded POST body over TLS,
   never URL/log/localStorage.
2. Successful exchange atomically consumes the challenge, removes the file, creates the first device
   grant/session and rotates every pre-auth identifier. Failed comparison, attempt exhaustion and
   expiry produce no grant/session; challenge cleanup is crash-idempotent.
3. A missing/expired browser device credential is recovered only through an operator-controlled
   startup `pairingResetGeneration` in the immutable deployment manifest. The generation must be
   strictly newer than the persisted consumed generation. Startup revokes every grant/session,
   closes mutation/launch admission, drains ADR-31 runtimes, proves no residual actor,
   then creates a new challenge. There is no browser/runtime endpoint that increments it.
4. Container deployments apply reset by changing the manifest and replacing the container, making
   the container/process boundary the final drain proof. Non-container deployments must pass the
   same anchor residual scan. If anything is unclassified, no plaintext file is created.
5. Restart with a valid durable device grant creates no pairing file. Restart with no grant may
   reissue an expired initial/reset challenge only after the same zero-runtime proof; it does not
   silently revoke an existing family or change OperatorId.

Reset crosses SQLite and one filesystem keyring, so it uses a durable `AuthResetIntent` rather than
pretending one transaction covers both:

    requested -> draining -> new_key_staged -> authority_revoked
              -> key_activated -> challenge_issued -> completed

The staged key is created/fsync'd first but is not used. One SQLite transaction then revokes old
challenge/device/session rows, records consumed reset generation and expected new keyId. Only after
that commit may same-directory rename+parent-fsync activate the staged keyring; challenge creation/hash
occurs last under the matching active key. Startup compares file keyId, expected keyId and intent state
before any auth lookup. Crash resumes forward while admission stays closed: if a post-revocation stage
is lost, it may generate another key/update expected keyId because all prior authority is already
durably revoked; it may never switch key before revocation or issue plaintext under a mismatch.
`completed` is idempotent and the old key is securely unreferenced, not retained as an acceptance key.

The reset generation is non-secret but host-controlled. A trusted runtime that somehow requests a
reset can at worst force fail-closed drain/DoS; it cannot obtain a challenge while still alive or
authorize itself. Operational docs must state that losing all device cookies requires a controlled
runtime-stopping re-pair, not deleting SQLite/session files by hand.

#### Device grant and session lifecycle

- Pairing returns a persistent `__Secure-atd` device cookie with Secure, HttpOnly, SameSite=Strict,
  no Domain and Path restricted to the auth-renew endpoint, plus a short `__Host-ats` session cookie
  with Secure, HttpOnly, SameSite=Strict, Path=/ and no Domain. The server never accepts either value
  from headers/body/query or another cookie name.
- Sessions have server-enforced idle, absolute and renewal deadlines. Exact defaults are frozen in
  Phase 0 from the product's long-running-control UX and OWASP ranges; production may narrow them but
  cannot disable absolute expiry. Ordinary backend restart reloads/revalidates hashed records instead
  of invalidating the operator unexpectedly.
- A same-origin POST to the dedicated renew route may use a valid device grant to mint a fresh session
  after idle/absolute access-session expiry. It requires exact configured Origin/authority and
  rate/attempt limits before grant lookup. Device grant and session IDs rotate after pairing,
  privilege/security-policy change and on a bounded renewal schedule.
- Device-grant rotation stores only current/recent hashes. A bounded predecessor grace window and
  family-size/rate cap allow response loss or simultaneous tabs to retry; any accepted predecessor
  creates a newer generation, never restores an older one. Browser cookies are shared across tabs, so
  a rotation-conflict loser retries session bootstrap with the now-current cookies. Reuse outside the
  grace window revokes the family as suspected replay and requires host re-pair.
- Logout atomically revokes the current session and clears its cookie. `Forget this device` additionally
  revokes the whole device family and clears both cookies; it explicitly warns that a later login
  needs another device grant or host re-pair. Revocation/expiry is server-side, not cookie deletion only.
- Multiple devices are not silently enabled. V1 defaults to one active device family; pairing reset
  replaces it. Supporting concurrent operator devices later requires an explicit product policy and
  per-device revoke UI, not relaxed validation.

Unsafe methods require a session-bound CSRF token held only in renderer memory and sent in one custom
header. The authenticated no-store bootstrap derives/returns a stable token from the presented session
secret and controller-only CSRF key, so reload/multiple tabs need no plaintext CSRF database value;
session rotation changes it. Exact Origin/authority validation runs before CSRF, body parsing,
idempotency claim or command creation. CORS and SameSite are defense in depth, never authorization.

SSE authenticates the session and exact Origin before emitting any bytes. Session expiry closes with
a typed auth event/status; the UI preserves server-owned team state, renews through the device grant,
then obtains a new CSRF/meta/snapshot rather than interpreting 401 as deletion. Machine/runtime
credentials remain a disjoint ADR-14 surface. Post-v1 T1 extends this contract with ADR-35's short-
lived path-scoped terminal grant and two-plane upgrade/regrant rules; v1 registers no upgrade route.

#### Production origin and proxy contract

Target-base standalone currently binds `0.0.0.0`, defaults CORS to `*`, publishes direct HTTP 3456 in
Compose and derives no authenticated public origin. That remains a local read-only/demo behavior only;
it cannot be incrementally called production auth.

- Production requires one explicit normalized `PUBLIC_ORIGIN=https://dedicated-host[:port]` with no
  credentials, path, query or fragment. Allowed Origin/authority and cookie policy come only from this
  immutable value; they are never learned from Host, Forwarded or X-Forwarded-Host.
- Either Fastify terminates TLS directly, or a configured proxy-address/CIDR allowlist overwrites
  forwarding headers and connects over a private listener/network. `trustProxy=true`, numeric hop
  trust and arbitrary forwarding chains are forbidden. Requests from an untrusted socket cannot make
  themselves secure or change client IP/authority with headers.
- Pairing/renew/session/SSE requests require one expected public authority and HTTPS evidence from
  the direct TLS socket or trusted proxy. Ambiguous/multiple forwarded host/proto values, unexpected
  authority, direct production HTTP and missing Origin on browser state-changing/upgrade requests fail
  before cookies or bodies are processed. Private health checks use separate routes and never auth.
- The edge strips incoming forwarding headers, sets its own, redirects HTTP to HTTPS and emits HSTS.
  The application port is not host-published in the production Compose profile. The current direct
  `3456:3456` example is replaced or explicitly labelled insecure local demo.
- `__Host-` cookies do not bind to a TCP port. Hosted production therefore requires a dedicated
  hostname with no untrusted sibling service on another port; exact Origin/authority checks remain
  mandatory even with the prefix.
- Production never downgrades Secure/HttpOnly/SameSite attributes to make a test pass. Deterministic
  E2E uses an ephemeral HTTPS edge/certificate and the real proxy allowlist. A separate loopback-only
  developer profile may use explicit test cookies, but its capability manifest says
  `productionAuth=false` and it cannot satisfy release readiness.

Never put pairing, device, session, CSRF, runtime or terminal secrets in localStorage, URL/query,
renderer bundles, service-worker cache, logs, diagnostics or backup. OIDC may later replace the device
grant issuer at the TLS edge, but it does not create a second half-supported v1 login mode.

### ADR-8: preserve filesystem compatibility first

Do not migrate all runtime state to SQLite in the first hosted milestone.

- Keep storageMode=legacy-files-v1.
- Put existing JSON/JSONL layouts behind repositories.
- Preserve unknown fields for CLI-owned files.
- Add schema/migrations only to app-owned files.
- Use a per-team write coordinator/journal for multi-file invariants.
- Fail closed or read-only on unknown future critical schemas.
- Quarantine corrupt critical state and rebuild only known derived caches.

For new app-owned coordination state, prefer one decoupled/hosted-packaged instance of the existing
internal-storage SQLite capability rather than inventing several JSON stores. It may own deployment/
team/workspace identities, idempotency/command records, event journal, approval policy/audit, and
deletion/repair intents transactionally. This does not move CLI-owned config/tasks/inboxes into the
database. If the required SQLite worker/native binding is unavailable or migration fails, hosted
mutation readiness is false; a silent JSON fallback is acceptable only for explicitly non-critical
legacy desktop projections.

### ADR-9: one provider runtime authority

`team-runtime-control` becomes the single authority that chooses and executes a runtime backend for
each planned lane. Target-base TeamRuntimeAdapterRegistry is a compatibility seed, not the final
universal interface: today OpenCode is adapter-routed, while Anthropic, Codex and Gemini flow through
the deterministic provisioning path and are launched as one Claude-compatible CLI process with
provider-specific arguments. Preserve that proven topology before improving its internals.

Chosen v1 design:

- `ProvisioningCliExecutionBackend` first wraps the existing deterministic provisioning flow for
  Anthropic, Codex and Gemini without rewriting it. It owns the current Claude-compatible CLI launch,
  provider argv/model/auth/preflight/bootstrap-evidence mapping and existing launch/reconcile state.
- `OpenCodeExecutionBackend` reuses the existing TeamRuntimeAdapterRegistry, manifests, delivery and
  recovery semantics because they are materially different from provisioning-CLI lanes.
- both implement one small `LaneExecutionBackend` contract covering plan validation, launch,
  observe, stop and recover outcomes;
- team-runtime-lanes selects lane topology; team-runtime-control maps each lane to exactly one backend;
- runtime-provider-management supplies installed/auth/settings facts but never executes a lane.

Adding a provider extends a provider strategy or adds a genuinely different backend plus capability/
conformance tests. It does not add another branch to lifecycle/HTTP/UI orchestration. A future move
of OpenCode under the provisioning backend requires a focused ADR and parity proof, not a cleanup.

The compatibility boundary sits outside the existing deterministic flow. Phase 4 may ratchet
provider-specific resolution into strategies only after black-box characterization proves identical
argv, environment redaction, bootstrap materialization, progress, cancellation, persistence,
reconciliation and cleanup. It must not first decompose the legacy flow and then try to rediscover its
semantics. `claudePath` is an implementation detail of this backend, not a domain concept or a claim
that every provider is native Claude.

The common contract covers only plan/preflight/launch/observe/stop/recover outcomes. Provider auth,
bootstrap, delivery journals and diagnostics stay tagged/provider-specific behind it. Do not force
every provider into OpenCode fields merely to make registry entries look uniform.

A separate machine-ingress handler registry is allowed because it routes inbound
bootstrap/delivery/heartbeat commands rather than owning launch/process execution. Its provider IDs
and capability verbs must be cross-checked against the execution registry at composition/readiness;
neither registry may silently claim the other's operations.

Unacceptable:

- OpenCode through a registry while other providers branch inside a monolith;
- a second registry beside TeamRuntimeAdapterRegistry with overlapping execution ownership;
- hidden module-global mode flags;
- browser code selecting internal provider credentials or binary paths.

### ADR-10: existing terminal-workspace is the base

**Delivery status: accepted post-v1 design, not a v1 implementation/readiness requirement.** V1 keeps
the desktop IPC terminal unchanged and advertises no hosted terminal capability. These constraints
exist so the later terminal project cannot force a new god-contract or weaken the v1 boundaries; no
terminal package, route, daemon, migration or browser control is added merely to prepare for it.

Do not create a second speculative terminal protocol.

- Reuse terminal-workspace UI/kernel semantics and the control/stream message families only after
  ADR-35 constrains them. The complete desktop `WorkspaceTransportClient` is not a browser port.
- Add feature-owned HTTP bootstrap/regrant adapters and a same-origin hosted WebSocket gateway. Do not
  raw-proxy the current tokenized TCP listener or expose its direct URLs.
- Keep terminal session/process semantics in `terminal-workspace`; hosted-access owns only operator/
  connection grant authentication and HttpServer owns upgrade mechanics. Quotas/backpressure belong to
  the hosted terminal gateway adapter, while terminal-daemon/PTY drain belongs to the terminal runtime
  adapter. This split avoids another app-level god gateway.

The hosted bootstrap request accepts teamId/workspaceId, not projectPath. The server resolves the
authorized working directory from the team snapshot and workspace registry. Bootstrap responses
must not expose the daemon runtime slug, direct loopback gateway URLs, default shell path, or host
project path. They return only a non-secret terminalSessionId and same-origin proxy URL; the
two-plane connection grant is delivered in the path-scoped HttpOnly cookie defined in ADR-35.

### ADR-35: hosted terminal is a constrained shell capability, not a raw gateway proxy

**Delivery status: deferred post-v1 work package.** The research and decision remain canonical, but
none of the following ports, protocols, dependencies, artifacts or tests block the non-terminal v1
release. When promoted, ADR-35 starts as a separately estimated project from the then-current base and
must revalidate terminal-platform/dependency versions before implementation.

A terminal is intentionally arbitrary command execution inside the runner. ADR-28 can prove the
initial cwd; it cannot stop an authenticated shell from later running `cd /`, reading another mounted
path or inspecting same-UID processes. The v1 guarantee is therefore precise: authorization chooses
one registered initial workspace, controller secrets are absent, browser protocol authority is
bounded and the whole terminal tree is owned/drained. The container mount/UID boundary remains the
actual confinement boundary. Stronger hostile-shell isolation requires the already-deferred
per-terminal UID/container profile.

Three implementation paths were evaluated:

1. **Reuse terminal-platform semantics behind a constrained hosted adapter and harden its daemon -
   chosen.** 🎯 9/10 🛡️ 9/10 🧠 10/10, approximately 6,500-11,500 changed lines across this repo,
   terminal-platform SDK/runtime, staging and tests. This preserves the mature UI/projection protocol
   while removing raw launch/socket/environment/process authority.
2. **Raw same-origin proxy around the current gateway.** 🎯 4/10 🛡️ 4/10 🧠 5/10,
   approximately 1,500-2,500 lines. Rejected: authentication does not fix arbitrary launch DTOs,
   shallow validation, ambient secrets, daemon adoption, persistence fallback or missing drain proof.
3. **Replace terminal-platform with a new app-specific PTY/WS protocol.** 🎯 5/10 🛡️ 7/10 🧠 10/10,
   approximately 8,000-14,000 lines. Rejected: it duplicates terminal emulation/session/replay work and
   broadens the Electron-decoupling migration without improving the core trust boundary.

#### Capability-owned ports

`terminal-workspace` owns these separate ports instead of one substitutable mega-interface:

- `TerminalAccessSessionRepository`: durable access-session state and current connection generation;
- `HostedTerminalFacade`: only hosted-safe list/create/attach/screen/history/subscription/mux actions;
- `TerminalRuntimeSupervisorPort`: start/probe/drain one daemon/runtime owned by this controller;
- `TerminalShellLaunchPolicy`: server-selected shell artifact, fixed argv, WorkspaceAccessGrant and
  allowlist-first environment evidence;
- `TerminalConnectionGateway`: control/stream upgrade pairing, message admission, backpressure,
  heartbeat and close semantics.

`hosted-access` authenticates OperatorSession/CSRF and mints/revokes opaque connection grants but does
not understand panes, mux commands or PTYs. `HttpServer` validates the public origin/proxy/upgrade and
hands the accepted socket to TerminalConnectionGateway; it cannot dispatch terminal commands. The
terminal runtime adapter depends on terminal-platform; application/core code does not import `ws`,
Fastify, portable-pty, filesystem paths or daemon clients.

The chosen HTTP upgrade adapter is `@fastify/websocket` on the existing Fastify listener, not another
TCP server. At plan time the current stable version is 11.3.0, built on `ws` 8 and compatible with the
target's Fastify-5 generation; implementation rechecks/pins the then-current reviewed stable version.
Register it before routes, set explicit ws options and use normal Fastify `onRequest`/`preValidation`
for origin/session/grant-slot admission. The route handler synchronously installs close/error/pong and
frame handlers before any async terminal work, and post-upgrade message errors stay inside the terminal
gateway. Official plugin guidance confirms WebSocket routes share Fastify hooks/router and warns that
handlers must attach synchronously:
[`@fastify/websocket`](https://github.com/fastify/fastify-websocket#readme).

#### Hosted method matrix

The browser never receives the full desktop WorkspaceTransportClient. V1 exposes only:

| Operation family                                    | Hosted rule                                                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| handshake/capabilities                              | server-generated native-only capability projection and protocol/policy revision                                                 |
| list/attach/topology/screen/delta/history           | only IDs already owned by this TerminalAccessSession; all history/byte/sequence bounds server-capped                            |
| create native session                               | browser may suggest a bounded display title only; server supplies backend, shell program/argv, environment and ADR-28 cwd grant |
| input/paste/resize/focus/split/tab close/new/rename | discriminated exhaustive schemas, owned session/pane/tab IDs, per-kind bounds and rate/resource quotas                          |
| subscriptions                                       | owned session/pane only, at most the declared count; no caller-defined arbitrary spec                                           |
| discover/import external session                    | absent in hosted v1                                                                                                             |
| saved-session restore/delete/prune                  | absent until identity, workspace rebinding, secret/history retention and process ownership are separately proven                |
| override_layout/detach/save_session                 | absent until each command has explicit complexity, ownership and recovery semantics                                             |

Unsupported methods are omitted from the hosted handshake/capability projection and their controls do
not mount. They are not forwarded and rejected later by terminal-platform. New terminal-platform
methods default absent until this matrix, schemas and conformance tests are updated. This is ISP/LSP:
desktop keeps the broad local adapter; hosted implements a genuinely narrower contract.

#### Two-plane connection grant and reconnect

The ordinary browser WebSocket constructor accepts URL plus subprotocols, not an arbitrary
Authorization header. Browsers send Origin and may send cookies; RFC 6455 requires servers intended
for selected sites to validate Origin. Therefore v1 uses a cookie grant without placing secrets in
URL, JavaScript memory or `Sec-WebSocket-Protocol`. References:
[WebSockets Standard](https://websockets.spec.whatwg.org/),
[RFC 6455 Origin considerations](https://www.rfc-editor.org/rfc/rfc6455.html#section-10.2), and
[secure cookie prefixes](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie#cookie_prefixes).

`TerminalAccessSession` persists TerminalAccessSessionId, OperatorId/session family, TeamId,
WorkspaceId/bindingGeneration/mountGeneration, TerminalRuntimeId, policy revision/hash, writer
attachment generation, BootId, created/idle/absolute expiry and status. It contains no path, cookie
secret, shell argv or provider credential. Startup terminalizes every non-terminal prior-BootId access
session before terminal readiness; access sessions/grants are excluded from backup and never adopted.
A connection grant is short-lived and keyed-hash-only:

1. Authenticated CSRF-protected bootstrap resolves the current team/workspace grant, creates or
   resumes one access session and atomically creates `TerminalConnectionGeneration` with random secret,
   expiry, `control=unclaimed`, `stream=unclaimed` and a five-second pair deadline.
2. The response returns only TerminalAccessSessionId, ConnectionId, relative common path prefix and
   fixed `agent-teams-terminal.v1` subprotocol. It sets
   `__Secure-agent-teams-terminal-grant=<secret>; Secure; HttpOnly; SameSite=Strict; Path=/api/hosted/v1/terminal-connections/<ConnectionId>/`
   with a maximum 30-second lifetime. `__Host-` is deliberately not used because a `__Host-` cookie
   requires `Path=/`; the ordinary session cookie remains host-wide and separate.
3. The client opens exactly one control and one stream socket under that prefix in either order. Each
   upgrade atomically claims only its named slot after exact PUBLIC_ORIGIN/authority, trusted proxy,
   OperatorSession, grant hash/TTL, ConnectionId, fixed subprotocol, TeamId/WorkspaceId generations and
   terminal readiness pass. A duplicate plane, third socket, missing/duplicate cookie or changed binding
   fails. Neither socket processes a workspace frame until both slots are bound; the gateway then emits
   one outer `terminal_connection_ready` on both planes and only afterward accepts inner workspace
   protocol frames. Any pre-ready application frame or pair timeout closes both and revokes the generation.
4. Once paired, the grant digest is erased and the two sockets are one connection generation. Closing
   either plane closes its sibling, cancels subscriptions and terminalizes that generation. The server
   never accepts a new socket with the consumed cookie.
5. Reconnect is not a blind WebSocket retry. The hosted renderer adapter first calls an authenticated,
   CSRF-protected HTTP regrant, which verifies the access session, writer ownership, runtime evidence,
   binding/mount generation and expiry, then issues a new two-slot generation/cookie. The existing
   vendor adapter's automatic direct reconnect must be disabled. A new terminal-platform
   `HostedTerminalSocketPairFactory` opens both sockets, waits for both ready envelopes, then supplies
   the connected pair to the workspace protocol adapter; it never waits for an already-fired `open`
   event or lets each plane independently create/retry its own socket.
6. Explicit close/logout/session revoke/workspace rebind/mountGeneration change immediately revokes the
   grant, closes both sockets and begins PTY drain. Unexpected network loss enters one 15-second
   `detached_grace`: no new input is accepted, output retention is bounded, and one HTTP regrant may
   reattach. Expiry stops/drains the terminal; there is no indefinite detached shell.

One TerminalAccessSession has at most one writer connection pair. A second tab cannot concurrently
send input; it receives `writer_already_attached` or explicitly replaces the old pair through a new
generation after the old pair is revoked. Read-only multi-observer mode is deferred rather than
smuggled through the same writer contract.

#### Message admission and backpressure

The current gateway's object-only validation and `ws` 100 MiB default are not accepted. Initial v1
budgets are release policy, not caller input:

- inbound WebSocket message `maxPayload=64 KiB`, text JSON only, permessage-deflate disabled;
- IDs are 1-128 printable ASCII characters; titles at most 256 Unicode scalar values;
- input/paste data at most 32 KiB per command, 64 KiB/s sustained and 256 KiB burst per access session;
- rows 1-160, cols 2-320; at most 8 panes, 8 tabs and 4 subscriptions per terminal session;
- control requests are serialized per connection with at most 16 queued; resize events coalesce;
- outbound single frame at most 1 MiB; `bufferedAmount` high/low watermarks 1 MiB/256 KiB and a
  10-second slow-consumer deadline;
- heartbeat ping every 30 seconds with a 10-second pong deadline; idle and absolute access-session
  expiry remain server timers independent of ping traffic.

Every frame is parsed once into an exhaustive discriminated schema before ID lookup. Unknown fields,
methods, binary frames, NaN/unsafe integers, excessive nesting, invalid UTF-8, wrong generation and
cross-session IDs close or reject without reaching terminal-platform. Input bytes are never logged.
The server pulls the next terminal event only while the socket is below the high watermark, resumes
below the low watermark and closes the pair with a safe typed reason if the deadline is exceeded. A
send callback/error must settle before the pump advances. Browser `bufferedAmount` is also observed
before client input batching. The WebSocket standard and `ws` expose queued-byte state, while `ws`
defaults `maxPayload` to 100 MiB; both limits therefore require explicit configuration:
[WHATWG bufferedAmount](https://websockets.spec.whatwg.org/#dom-websocket-bufferedamount) and
[`ws` server options](https://github.com/websockets/ws/blob/master/doc/ws.md#new-websocketserveroptions-callback).

Backpressure must cover the entire PTY-to-browser path. Target-base already uses coalescing `watch`
notifications for topology/surface state and bounded Tokio channels, but their limits are message
counts, not encoded bytes; raw-output uses a separate broadcast path, and a rich screen snapshot may
contain inline media. The hosted profile therefore has these additional semantics:

1. `raw_output_stream=false`; the browser receives only topology and screen projection snapshots/
   deltas. It never subscribes to raw PTY bytes. Inline image `data_base64` is disabled in hosted mode;
   a bounded non-sensitive marker may remain. Clipboard/notification side effects remain blocked.
2. `HostedProjectionPolicy` caps grapheme bytes, spans, semantic marks and media markers per line, then
   caps the normalized serialized snapshot/delta at 768 KiB. Over-budget rich content is deterministically
   reduced to bounded plain-text/marker content and marked `projection_truncated`; it is not split into
   an unbounded implicit protocol. If even the normalized projection violates the cap, the subscription
   fails `projection_overflow` and terminal readiness is a test failure, not a giant WebSocket frame.
3. Every native/runtime/daemon/client/gateway subscription lane has an explicit local item/byte budget.
   Hosted topology/surface delivery is latest-value/coalescing rather than a FIFO of obsolete deltas;
   the release manifest proves an aggregate transport-queue bound of at most 4 MiB per access session
   across all in-process channels and local socket buffers. Local `LengthDelimitedCodec` request/
   response/subscription frames are explicitly capped at 1 MiB, local socket send/receive buffering is
   bounded and the number of local connections is capped. Default codec/socket limits or channel item
   counts without serialized-size evidence are not accepted as proof.
4. When the browser socket crosses the high watermark, the gateway stops WebSocket sends, cancels the
   current daemon subscription and records `resync_required`; it does not let intermediate Rust/OS/JS
   queues retain obsolete deltas. The PTY reader may continue updating only the daemon's bounded current
   emulator/transcript state. Below the low watermark, the gateway opens a fresh subscription and sends
   one budgeted full-replace projection with a new subscription generation before later deltas. A stale
   generation or delta before that full replacement is discarded.
5. Pair close/detached grace cancels every active projection subscription immediately. No raw output
   backlog is retained for reconnect. Regrant reconstructs current topology/screen from server state;
   the ten-second slow-consumer deadline closes the pair if bounded resync cannot complete.

Tests flood highly styled Unicode, combining marks, OSC/DCS/Kitty/iTerm media, rapid full-screen redraws
and a browser that never reads. They assert fixed RSS/queue bounds, no terminal bytes in logs, correct
`projection_truncated` rendering, full-replace convergence and prompt cancellation on disconnect. A
passing last-hop `bufferedAmount` test alone is insufficient.

Every mutating control envelope carries a bounded random `clientCommandId`, connection generation and
expected topology/screen revision where meaningful. The gateway keeps one bounded per-access-session
result registry:

- resize/focus/rename/close are revalidated as desired-state operations and may return the observed
  equivalent result;
- new-tab/split require daemon-scoped command-result deduplication plus topology revision evidence;
- input/paste are deliberately non-replayable after the frame is accepted. A lost acknowledgement is
  `delivery_unknown`; neither renderer nor gateway resends bytes across a socket generation. The
  existing optional terminal `client_event_id` may correlate/redact history but is not treated as PTY
  exactly-once proof;
- create-session is keyed by TerminalAccessSessionId and returns the same owned native session or an
  explicit ambiguous/drain outcome; it cannot spawn again because the first response was lost.

Terminal-platform/gateway records expire only after the maximum reconnect/interaction window. Same ID
with changed kind/payload hash is a protocol conflict. This is the terminal specialization of ADR-34:
the UI never turns a transport retry into a second shell effect.

#### Daemon, socket, environment and PTY ownership

Hosted cannot reuse target-base `TeamTerminalDaemonSupervisor` unchanged. Required terminal-platform
changes are part of this release and produce a new pinned vendored SDK/runtime manifest:

1. Generate a random boot-scoped TerminalRuntimeId; never derive daemon/socket/store identity from
   teamName. Bind an explicit filesystem socket inside a controller-created mode-0700 runtime directory
   with exclusive/no-overwrite semantics. Handshake includes protocol/build hash, BootId,
   TerminalRuntimeId and random spawnNonce; a pathname or successful handshake alone never permits
   adoption.
2. Persist a spawn intent, start terminal-daemon through TerminalRuntimeSupervisorPort and ADR-31's
   low-level process-anchor mechanics from a neutral cwd, verify nonce/socket/store identity, then
   commit TerminalRuntimeOwnershipRecord. A pre-existing socket/daemon is foreign evidence and blocks;
   hosted never attaches to the deterministic teamName slug or marks an unspawned daemon as owned.
3. Launch daemon with `TerminalChildEnvironmentPolicy` built from empty input: minimal PATH, dedicated
   HOME/config/cache/tmp, locale and terminal variables only. The main controller environment,
   ADR-7/16/30 secrets, provider credentials, proxy credentials and arbitrary loader/shell variables are
   denied. Because portable-pty seeds shells from daemon base env, final-image canaries must inspect both
   daemon and spawned shell environments. A future credential-enabled terminal profile requires named
   SecretRefs and a new exposure policy; default hosted terminal receives none.
4. Hosted shell program and fixed initial argv come only from a signed/operator manifest and artifact
   probe. Browser `program`, `args`, `cwd`, backend and environment fields do not exist. Implement
   ADR-28's `GuardedShellLaunchSpec` and boot-authenticated controller-to-daemon launch channel: the
   daemon maps only the size-capped `WorkspaceLaunchEvidenceV1` pipe plus exec-status pipe into the
   pinned guard child, and the guard performs `openat2`/`statx`/`fchdir` before same-process shell exec.
   Generic serializable `ShellLaunchSpec.cwd` is forbidden on hosted ingress. No SCM_RIGHTS/general FD
   RPC, argv/env envelope, PTY-stdin bootstrap or raw-path fallback is permitted.
5. SQLite open/schema/integrity failure is fatal for hosted readiness. The current terminal-daemon
   in-memory fallback is disabled by an explicit `--require-persistence` mode. Store path is keyed by
   stable TeamId/TerminalRuntimeId under app state, not teamName; live session/process records from a
   prior BootId are terminalized, never adopted. The store contains sensitive screen/command history:
   raw history is bounded by a terminal-specific retention/size policy, excluded from backups and
   diagnostics by default, and never exposed through generic logs. Only ownership/drain audit metadata
   is a required ADR-32 participant; future history export/restore needs an explicit encrypted policy.
6. Add a typed close-all/shutdown protocol that stops every native session/pane, waits for direct and
   descendant processes and returns per-session `drained | drain_unconfirmed` evidence before daemon
   exit. Current portable-pty `Drop -> child.kill()` without wait/tree evidence is insufficient. The
   final container tests interactive shell children, background jobs, setsid/double-fork, TERM-ignore,
   daemon/controller crash and repeated close. Missing drain evidence closes terminal readiness and
   requires whole-container replacement; production terminal cannot be enabled on a routine path that
   needs replacement after every close.
7. Bound local length-delimited frames/connections and refuse overwrite-on-bind. Local socket and store
   are controller-only internal artifacts; raw daemon/gateway addresses, spawnNonce and diagnostics
   never cross the browser contract or logs.

Terminal daemon/process mechanics may reuse audited ADR-31 anchor/syscall utilities, but provider and
terminal supervisors remain separate feature adapters with distinct protocol envelopes, readiness and
ownership records. This preserves SRP while avoiding a weaker terminal-only PID implementation.

### ADR-11: server truth with a small transport reconciler and feature-owned reducers

The server is authoritative for teams, tasks, messages, lifecycle runs, approval policy, and
runtime observations. The renderer may cache projections and own ephemeral interaction state, but
it may not invent durable domain truth.

Create a transport-neutral TeamTransportReconciler used by both IPC and HTTP clients. It owns only:

- deployment/boot/session/selection request scope and cancellation tokens;
- event cursor plus envelope duplicate/gap/schema detection;
- feature-topic dispatch and bounded invalidation coalescing;
- reconnect/resync and fallback polling scheduling.

It does not import lifecycle/task/message/approval entity types, compare their revisions, select
runs, own tombstones, paginate feeds, or mutate feature stores. Those rules live in feature-owned
pure reconcilers/reducers. A feature handler returns applied, ignored, or snapshot-required; the
transport reconciler only schedules/routs that result.

Do not let raw EventSource callbacks, IPC callbacks, or polling promises mutate Zustand directly.
They first enter TeamTransportReconciler and then the owning feature reconciler. Preserve current
behavior through characterization tests, then simplify only after conformance is proven.

Renderer failures use a transport-neutral AppError with code, safeMessage, retryable,
diagnosticId, and optional currentRevision. IpcError/unwrapIpc become IPC adapter details or are
renamed; application/store code must not branch on transport names or raw error strings.

### ADR-12: feature ownership instead of a new team god-module

The canonical ownership list is `hosted-access`, `team-lifecycle`, `team-task-board`,
`team-messaging`, `team-review`, `team-approvals`, `team-runtime-control`, `workspace-registry`,
and `team-console`, alongside the reused existing features listed above. `terminal-workspace` remains
the canonical desktop owner and joins hosted composition only in post-v1 T1.

- No generic `team-application` facade owns all operations.
- Each feature publishes only browser-safe contracts and deliberate process-specific entrypoints.
- `team-console` composes renderer projections but owns no durable feature state.
- app-level hosted composition wires transports/security but owns no team, workspace, or provider policy.
- Cross-feature workflows use public commands/queries, after-commit events, or explicit durable sagas.
- Folder layers are created only when behavior needs them.

### ADR-13: practical SOLID and selective DDD

- ISP is enforced with capability client facets and provider-specific capability contracts.
- DIP ends at feature-owned application ports; use cases import no runtime framework.
- SRP separates transport parsing, application sequencing, persistence, provider processes, and UI
  reconciliation.
- LSP forbids fake browser implementations of desktop contracts; unsupported behavior is absent from
  the capability surface.
- DDD applies only to TeamLifecycle/LifecycleRun, TeamWorkspaceBinding/TeamRoster,
  WorkspaceRegistration, ApprovalDecision, task revision/relations, ADR-7 device-grant/reset state
  and durable deletion/recovery sagas.
- DRY follows proven semantic equivalence; transport/provider/persistence shapes may remain
  intentionally duplicated until their invariants match.

### ADR-14: browser control and machine runtime ingress are separate trust surfaces

Target-base OpenCode runtime callbacks currently live under `/api/teams/:teamName/opencode/runtime/*`
beside operator routes and accept raw provider payloads. They must not be copied into the hosted
browser namespace.

Canonical split:

- `/api/hosted/v1/*`: operator browser session, CSRF/Origin policy, capability facets;
- `/api/runtime/v1/runs/:runId/*`: private machine ingress, no browser session/CSRF semantics,
  authenticated by an opaque lane/run-scoped credential plus strict Origin-independent machine
  policy;
- filesystem reconciliation: no HTTP credential, but bounded to registered runtime roots and
  validated as external evidence rather than trusted commands.

For each admitted runtime lane, the server creates a high-entropy opaque ingress credential, stores
only its hash and scope in app-owned coordination state, and gives the plaintext only to the
controller-owned ADR-30 lane relay over an inherited one-use pipe. The provider/agent process receives
no canonical `/api/runtime/v1` bearer in argv, environment, settings, MCP config or a run file. It
talks to its narrow local relay capability, which fixes lane identity and forwards canonical ingress.
The bearer never enters team config, renderer JSON, URL/query, logs, artifacts, SSE, diagnostics or
provider-neutral DTOs. A provider backend that cannot use this relay has no hosted machine-ingress
capability until an equally narrow adapter is designed and proved.

Credential scope includes deploymentId, teamId, runId, generation, laneId/providerId and allowed
verbs. Lane restart or team relaunch creates a new credential; lane/team stop, delete and other
final lifecycle outcomes revoke the relevant credentials. Body IDs must
match the credential/current-run scope and cannot expand it. Private networking is defense in depth,
not authentication.

No runtime-ingress credential grants operator actions such as approval decision, policy change,
launch/stop/delete, workspace registration, arbitrary message impersonation or
cross-lane control. A runtime may submit an approval request and bounded delivery acknowledgement;
the decision is accepted only through operator policy/API and sent to the provider through an
outbound runtime adapter. Provider-specific legacy naming such as `permission-answer` cannot weaken
that directionality in the canonical contract.

Canonical ingress DTOs contain opaque IDs, bounded provider evidence and idempotency/sequence data.
They do not accept authoritative `teamName`, `cwd`, expected member definitions, prior launch state,
binary paths or credentials. The current OpenCode compatibility adapter resolves/validates those
values against server-owned run/workspace/member state before invoking canonical ingress use cases.
Sender/member/provider/lane identity is derived from the credential, not trusted from the body.
Message targets, task events and cross-team delivery are re-authorized against current team/task/
organization policy; a correctly isolated relay token cannot select another member/team scope.
ADR-30 defines the weaker guarantee under the default same-UID `trusted_process` profile and forbids
describing lane tokens as hostile-sibling isolation.

Replay rules:

- delivery/task/permission mutations require a persisted idempotency key plus ADR-34 versioned
  normalized-intent fingerprint and an effect class/evidence contract;
- bootstrap and heartbeat require current generation/session identity, bounded monotonic sequence or
  deduplicated commandId, freshness window and rate limit;
- duplicate identical input returns the prior acknowledgement; conflicting reuse is rejected;
- stale/revoked/wrong-lane credentials produce no feature mutation or event.

Target-base RuntimeControlService currently executes the provider handler and only then calls an
event sink. If sink persistence fails, the provider side effect may have committed while the caller
sees failure and retries. Canonical ingress therefore claims/persists the command first, records the
provider acknowledgement and outbox event in the recoverable command protocol, and never blindly
re-executes an ambiguous provider effect. Provider adapters must either be idempotent by canonical
commandId or expose bounded acknowledgement reconciliation; otherwise that verb is not advertised.

Runtime ingress and operator control have different input adapters, auth policies, rate limits and
contracts even when they reach the same underlying run state. They are never two implementations of
one HTTP interface.

The canonical machine ingress is shared by Electron and hosted compositions. Desktop is not exempt:
its owned runtimes can set Authorization headers and receive a lane/run-scoped secret through the
launch adapter. Legacy OpenCode `/api/teams/:teamName/opencode/runtime/*` remains only behind a temporary
loopback compatibility flag while runtime clients migrate, then is removed from route registration
and tests. Remote hosted readiness never depends on that flag.

Machine schemas/parsers initially live under the feature's main-owned runtime-ingress adapter and
are not exported from browser-safe `contracts/index.ts`, preload, renderer facets or capability
manifest. If an independently versioned external runtime client later requires a distributable
schema package, that extraction is a separate compatibility decision; v1 does not create a generic
SDK preemptively.

### ADR-15: static feature-owned route descriptors, no transport framework

Each v1 HTTP/SSE endpoint has one static descriptor owned beside its input adapter. Post-v1 T1 applies
the same rule to its WS endpoints without introducing a shared transport framework. The app
composition collects descriptors into a read-only RouteCatalog before listener readiness.

Illustrative shape:

    type RouteDescriptor = {
      id: string;
      owner: FeatureId;
      trust: 'browser' | 'runtime' | 'public-health' | 'private-ops';
      method: HttpMethod;
      path: string;
      authPolicy: AuthPolicyId;
      readiness: readonly ReadinessDimension[];
      requestSchema?: SchemaId;
      responseSchema: SchemaId;
      capability?: CapabilityId;
      legacy?: { removalPhase: string };
    };

The registration function uses that same descriptor's method/path/schema references when calling
Fastify. Browser route constants/schemas are exported from the owning feature's browser-safe
contracts; runtime-ingress descriptors/schemas remain main-owned. Composition asserts unique
method+path and id, known auth policy, valid trust/auth combinations, registered handler, capability
owner, known ADR-21 readiness dimensions, and no legacy route without a removal phase.

Security ordering is fixed by trust policy rather than repeated ad hoc in handlers. For browser
routes, Fastify `onRequest` first validates socket/proxy/PUBLIC_ORIGIN, bounded cookie/header shapes,
session/device policy and unsafe-method Origin/CSRF header before body parsing. Only then do bounded
content-type parsing/schema validation, readiness/capability admission, idempotency claim and the
application use case run. Pair/renew have dedicated pre-auth policies; runtime policies are disjoint.
Post-v1 T1 adds `terminal-ws` as an explicitly reviewed trust kind rather than reserving a dormant v1
branch. A rejected auth/origin/CSRF request therefore cannot allocate a body-sized object, consume an
idempotency key or leave a command row. Response policy adds no-store/redaction before serialization.

The server capability manifest is derived from registered browser descriptors whose application
dependencies, authorization policy and provider/runtime capability are ready. Runtime, private ops,
health and legacy descriptors are never converted into browser capabilities. E2E reports descriptor
IDs, so route coverage and capability coverage share stable identifiers.

Do not add decorators, reflection, OpenAPI code generation, a central route switch, or a generic
handler framework. RouteCatalog is metadata plus assertions; feature adapters still contain normal
Fastify translation code. OpenAPI may be generated later from the catalog/schemas, but is not a v1
dependency or source of truth.

### ADR-16: one local hosted writer is a kernel-held stable-inode lease

V1 supports exactly one hosted controller for one deployment root on one Linux host. It does not
claim distributed consensus, multi-host failover or active-active replicas. `replicas: 1` is an
operator preference, not the safety mechanism: Docker permits one volume to be mounted into multiple
containers simultaneously. A second controller must fail before Node starts any stateful application
component.

The previous atomic-directory design is rejected. A live owner can keep using an unlinked inode while
another process creates a new directory at the same path; metadata polling only notices after both
writers have existed. Target-base `fileLock.ts` is also not a seed for this lease: it is an app-local
`open('wx')` marker, closes its descriptor, trusts PID/age metadata and may delete a lock older than its
timeout even while the owner is alive. Neither design fences a paused, renamed or unlinked live writer.

Three designs were evaluated:

1. **Stable root-owned inode plus kernel `flock` held across the controller lifetime - chosen.**
   🎯 9/10 🛡️ 9/10 🧠 8/10, approximately 1,200-2,200 changed lines including the narrow launcher,
   packaging and race/container tests.
2. **Orchestrator-only singleton (`replicas: 1`, systemd/Compose policy).**
   🎯 6/10 🛡️ 7/10 🧠 5/10, approximately 500-1,000 changed lines. Useful defense in depth, but it
   cannot fence a second Compose project, manual start or misconfigured replacement sharing the root.
3. **Mutable lease directory/file with PID, heartbeat or TTL takeover.**
   🎯 3/10 🛡️ 3/10 🧠 4/10, approximately 500-900 changed lines. Rejected because pathname
   replacement creates two distinct inodes and TTL/PID inference can steal from a live paused owner.

The operator or one-shot init job provisions one deployment volume layout before the non-root app is
started:

    /data/agent-teams/                 root-owned, not writable by runtime UID
      instance.lock                    root-owned stable regular file, not replaceable by runtime UID
      state/                           runtime-UID-owned writable application state

The anchor and state directory share the same root-owned deployment parent and one declared
DeploymentId/registration. The runtime UID must be unable to rename/unlink the anchor or parent but
may open the anchor for locking; giving it a writable deployment parent fails startup. A fresh named
volume is initialized explicitly rather than letting each app replica independently create its lock
anchor. Device/inode numbers are boot-local evidence, not durable deployment identity.

`agent-teams-instance-lock` is a small, separately versioned Linux launcher/supervisor:

1. Before starting Node, it descriptor-opens the declared deployment parent and `instance.lock`
   without following symlinks, verifies a regular stable anchor, ownership/mode, non-writable parent,
   expected state child, mount/filesystem support and manifest protocol/hash.
2. It obtains nonblocking `flock(LOCK_EX | LOCK_NB)`. Busy, unsupported, missing, replaceable or
   ambiguous anchors produce a distinct fail-closed exit code. No migrations, listener, routes,
   recovery, watchers, process inspection or provider effects have started at this point.
3. It forks/execs the pinned Node artifact and deliberately shares the same open-file description on
   one reserved descriptor with Node while retaining its own duplicate. The launcher and controller
   both keep the descriptor open: failure/accidental close in either half cannot release ownership
   while the other half remains alive. The launcher's parent/control pipe makes signal forwarding,
   controller exit and container exit one bounded lifecycle.
4. Node validates the inherited descriptor with `fstat`, records a random leaseId plus deploymentId,
   bootId, hostname/OS boot ID, launcher/controller process identity, device/inode/mount evidence,
   artifact/manifest hash and acquiredAt in diagnostic state, then keeps the descriptor in one
   `InstanceLeaseGuard` until shutdown. Metadata and heartbeat are observability only; they never
   grant, renew, steal or release ownership.
5. If the launcher dies, Node's duplicate still holds the lock; control-pipe EOF first closes
   mutation/runtime admission, drains within policy and exits. If Node dies, the launcher still holds
   the lock until child/container teardown is initiated. Clean release occurs only after Node has
   closed admission, drained owned effects, flushed durable state and exited. There is no TTL stealing,
   PID-file takeover or live lock-anchor deletion path.
6. Every hosted child spawn has an explicit descriptor policy. The lease FD is controller-only and
   must be absent from process anchors, providers, relays, PTYs, Git, diagnostics and arbitrary helper
   descendants. Final-image tests compare `/proc/<pid>/fd` inode evidence and prove that killing a
   child cannot prolong or acquire the instance lease.

Linux `flock` ownership is attached to an open file description, duplicate descriptors share it, it is
released only after all duplicates close and it survives `execve`. Conversely, `unlink` removes a
name while an open file remains alive, which is exactly why the anchor pathname must be outside the
runtime UID's writable namespace. Primary references:
[flock(2)](https://man7.org/linux/man-pages/man2/flock.2.html),
[unlink(2)](https://man7.org/linux/man-pages/man2/unlink.2.html), and
[Docker volume lifecycle](https://docs.docker.com/engine/storage/volumes/).

Only host-local filesystems whose cross-process and same-volume cross-container `flock` behavior
passes the final deployment probe are supported. NFS/CIFS/other network-volume semantics are rejected
for v1 even if a particular mount appears to work. `flock` is advisory, so all app/controller writers
must enter through this launcher; provider/CLI writers remain separately governed external
participants under ADR-24/29. Desktop and any legacy writer cannot share the hosted writable roots.

Tests start two real final-image containers with the same provisioned volume and anchor, plus a second
Compose project/manual invocation. Exactly one reaches Node/application startup; losers perform zero
migration, recovery, listener bind, spawn or write. The suite also attempts anchor unlink/rename,
parent replacement, same-name recreation, controller/launcher SIGSTOP/SIGKILL, PID reuse, duplicate-FD
close ordering, child-FD leakage, full-container crash and clean handoff. An unsupported mount or
failure of any invariant disables hosted mutation/runtime readiness; there is no atomic-directory or
PID-marker fallback.

### ADR-17: production hosted build has no fake platform implementation

The canonical hosted artifact is allowed to exclude a capability, but it may not make an imported
Electron/native dependency appear functional through an empty module. In the production hosted
dependency graph:

- importing `electron`, `electron-updater`, preload modules or an Electron-only adapter is a build
  error; the current broad `electronStub()` is removed from the canonical server build;
- required native modules are externalized and copied/rebuilt for the pinned Node runtime/OS/arch;
  they are never matched by the current catch-all `.node` empty stub;
- an optional native feature is omitted at composition and absent from the capability manifest when
  its artifact is missing. It does not register an adapter that fails only after user interaction;
- internal-storage has a separately emitted worker entry inside the same hosted artifact, a stable
  production URL, and a fixed hosted resolution to the Node-ABI SQLite package. It never tries to
  execute the Electron-ABI addon or a TypeScript source path at runtime;
- required provider/controller/MCP helpers use an explicit artifact inventory with source,
  target path, executable bit, version/hash and startup probe;
- image build performs smoke loads/queries for every required worker/native/helper artifact before
  the image is published, and startup readiness repeats bounded functional probes.

Post-v1 T1 extends this inventory with one source-compatible terminal-platform artifact set. V1 does
not stage or probe that set.

This does not create a second server or packaging system. `standalone:build` remains the one hosted
build and is hardened to emit the server, renderer, worker entries and artifact manifest. Electron
packaging keeps its own ABI/artifact path. A bundle scan and negative fixture prove a new Electron
deep import or unstaged native addon fails CI instead of silently becoming `{}`.

### ADR-18: one immutable composite runtime plan per lifecycle generation

`team-runtime-lanes` remains the sole topology planner. `team-runtime-control` executes its result;
neither HTTP nor `team-lifecycle` reconstructs lanes. In the same internal-storage transaction that
accepts LifecycleRun and advances TeamLifecycle.currentRunRef, persist an immutable
CompositeRuntimePlan containing planVersion/hash, team/run/generation, lead provider, topology mode,
ordered lane IDs, rosterGeneration plus MemberId/memberRevision/LegacyMemberKey-to-lane mapping,
backend binding, registered workspace/cwd identity, explicit ProcessExecutionUnits and
ADR-25 mountGeneration plus required-versus-optional member policy. Recovery uses this exact plan.
Config or mount-generation changes require a new
generation; they cannot mutate the meaning of an accepted run.

V1 preserves the target-base topology/ordering contract:

- non-OpenCode-led primary members execute through one provisioning-CLI primary lane;
- mixed OpenCode members and pure-OpenCode worktree-root members use deterministic per-member side
  lanes with stable lane IDs;
- the primary lane reaches its characterized first-real-turn gate before queued mixed side lanes are
  admitted; pure OpenCode modes keep their current adapter ordering;
- OpenCode-led mixed teams remain an explicit unsupported capability until the planner itself gains
  that topology and conformance tests. HTTP cannot bypass the planner rejection.

A `LaneId` is lifecycle/protocol topology, not automatically a process or credential-isolation
boundary. The planner snapshots each actual `ProcessExecutionUnit` with executionUnitId, backend,
member/lane set, resolved binary policy, environment-policy hash and a metadata-only
`CredentialExposureSet` of provider SecretRef IDs/classes. The set never contains secret values.
Target-base mixed provisioning may intentionally run multiple provider members inside one
Claude-compatible primary process; that unit receives the minimum union of credentials proven
necessary for those members and reports `credentialIsolation: shared_execution_unit`. Dedicated
OpenCode/other side processes report `dedicated_execution_unit` only when their exposure set is
actually disjoint.

Credential isolation is enforced between ProcessExecutionUnits, not invented between logical members
that share one process. Splitting the characterized primary process solely to improve isolation would
change bootstrap/order/auth/runtime semantics and requires a separate topology ADR plus parity proof.
Conversely, no adapter may merge units or widen a persisted exposure set after run acceptance; a new
provider/member/credential need requires a new plan generation.

Composite state is derived from lane/member evidence, not overwritten by whichever lane finishes
last. Each lane has its own run identity, phase, attempts, process/session evidence, credential and
terminal result. Team `ready` requires every required member/lane to have fresh verified evidence;
side-lane failure produces the characterized partial/degraded outcome and member diagnostics rather
than rewriting successful primary members as failed. Optional-member policy, if supported by the
pinned base, must be explicit in the plan snapshot; absence never silently makes a member optional.

Cancel/stop/recovery are generation-fenced composite commands:

1. Persist the composite intent and close admission for new lanes.
2. Stop/cancel all started owned lanes and mark never-started queued lanes cancelled.
3. Reconcile every lane outcome with bounded parallelism and deadline.
4. Commit the composite terminal/degraded/operator-required result plus event.

A partial stop never returns clean success. Retrying targets the same plan/generation and only
unfinished lanes. Restart recovery cannot re-plan from changed config, duplicate a queued side lane,
or reuse a primary credential for a side lane. Provider/lane characterization covers every current
topology, primary failure before side-lane admission, side-lane partial failure, cancel at each gate,
duplicate turn-complete, restart with queued/running lanes and stale manifests.

Active target-base runs at rollout are not reverse-engineered into a canonical plan. A per-TeamId
cutover fence has two states: `legacy_drain` and `canonical`. If one current legacy generation is
unambiguously known, only its existing status/cancel/stop/recovery adapter remains enabled; new launch,
member topology edits and workspace rebind are blocked. When that generation is terminal and cleanup
is verified, one durable transition enables canonical mode and all later launches require ADR-18
plans. Ambiguous/multiple legacy candidates remain recovery-blocked and are never resolved by mtime/
newest-run selection. Default hosted startup has no adoptable live run because of the pairing/stop-
owned boundary; this drain path primarily protects desktop/in-place upgrades.

### ADR-19: build-time parity ledger, not a replacement mega-interface

A checked-in build-time parity ledger is the release traceability authority. It is not imported by
runtime application code and does not generate a universal client/service. Each record maps one
pinned legacy surface member or visible renderer action to its semantic replacement.

Minimum record fields:

    source: TeamsAPI | ReviewAPI | CrossTeamAPI | renderer-action
    sourceMember/actionId
    sourceSignatureHash and pinnedBaseSha
    owningFeature
    replacementKind: direct | decomposed | merged | browser-native | desktop-only
    capability/action IDs
    application command/query IDs
    RouteCatalog descriptor IDs and/or IPC channel IDs
    authorization policy and effect class
    revision/idempotency/event obligations
    rollout state and legacy removal phase
    characterization/unit/conformance/E2E test IDs

`getData` is recorded as decomposed into feature-owned projections/bootstrap members; raw-path
review methods map to opaque file/change-set operations; legacy `on*` subscriptions map to scoped
event topics; `showMessageNotification` maps to explicit browser notification capability. A mapping
does not require preserving an unsafe signature or one route per old method. It requires preserving
the intended user-visible semantics or explicitly classifying the behavior as desktop-only/deferred
before its control is rendered.

Parity for a mutation means the ledger captures and tests its preconditions, authorization,
validation, canonical effects, partial outcomes, idempotency/revision behavior, emitted projection/
events, error states and recovery. A method name returning 200 is not parity. A query additionally
captures completeness, pagination/bounds, freshness/source generation and redaction.

Characterization compares semantics on isolated cloned fixtures, never by dual-running mutations
against one team. With deterministic clock/IDs and fake provider/process boundaries, the legacy IPC
path and replacement use case receive equivalent valid/invalid scenarios; normalized outcomes,
authoritative file deltas and projection changes are compared. Transport-only fields, safer opaque
IDs/redaction and intentionally fixed legacy defects are recorded as reviewed expected deltas. A
legacy security bug is not preserved merely to make the diff green, but its replacement behavior and
UI consequence require an explicit ledger note/test.

CI uses the TypeScript AST to enumerate the pinned TeamsAPI/ReviewAPI/CrossTeamAPI members and hashes
their normalized signatures. It also inventories renderer actions/callsites through a maintained AST
scanner plus explicit dynamic-call annotations. The gate fails on an unmapped addition/removal/
signature change, duplicate ownership, missing referenced capability/route/use case/test, required
action without E2E, desktop-only action still visible in hosted UI, or a legacy callsite remaining
after its removal phase.

Phase 0 checks in an immutable `legacy-surface-baseline` generated from the recorded base SHA; CI
never fetches a moving remote to reconstruct history. A migrated legacy member may disappear from
current source only when its ledger record is in the declared removal state, replacement evidence is
green and the callsite scanner reports zero remaining consumers. The historical record stays in the
ledger. A genuinely new current member/action requires a new record; an intentional signature change
updates its current hash and semantic obligations in the same reviewed change. This lets the strangler
delete the mega-interface gradually without either freezing it forever or forgetting what it replaced.

RouteCatalog remains runtime route metadata, the capability manifest remains runtime availability,
and feature contracts remain source code. The parity ledger references their stable IDs and CI
cross-checks them; it does not merge them into a god manifest or become a code-generation framework.

### ADR-20: hosted renderer cuts Electron reachability before component mount

Hosted mode is not implemented by mounting the desktop tree and hoping every `typeof api.method`,
`window.electronAPI?` or click handler stays dormant. The renderer composition resolves capabilities
before feature entrypoints mount and constructs only supported facets/listeners/widgets.

Rules:

- feature UI/hooks receive narrow facets/callbacks through their public renderer entrypoint; they do
  not read `window.electronAPI`, the global ElectronAPI object or hosted transport directly;
- subscription registration belongs to the owning feature mount lifecycle. Hosted bootstrap does not
  execute the current global store block that registers editor/Codex/team listeners indiscriminately;
- desktop-only editor/open-in-folder/native chooser/shortcut components are behind desktop renderer
  entrypoints or lazy capability boundaries and are neither mounted nor imported by the hosted team
  route chunk. A hidden button around an already-running effect is insufficient;
- browser replacements are deliberate adapters: WorkspaceRegistry selector for selectFolders,
  Blob/File upload for getPathForFile, safe allowlisted browser navigation for openExternal, local
  keyboard handling for onCmdN, opaque processRef for kill, and browser-native download/preview where
  desktop openPath/editor has no hosted equivalent;
- organization assignment is composed only when its real organization facet/action is supported;
  otherwise the selector and submit-side call are both absent, not caught after team creation;
- optional chaining/function-existence checks remain only inside the quarantined legacy adapter.
  Migrated feature code gates by typed facet/action state and cannot treat structural method presence
  as support.

CI maintains two complementary gates:

1. AST/import-graph reachability: from the hosted renderer entry/route chunks, reject Electron/preload
   imports, direct `window.electronAPI`, quarantined mega-client imports and desktop-only entrypoints.
2. Runtime mount/action conformance: render every capability permutation, assert unavailable feature
   effects/listeners never register, then exercise every rendered interactive control against the
   real browser transport with zero unavailable/no-op/console-error calls.

Shared presentational components may remain common; platform behavior arrives as a small facet or
callback. Do not fork the entire TeamDetailView into unrelated desktop/web copies. Migrate one
feature-owned subtree at a time and delete the legacy branch once both compositions use the shared
presentational surface.

### ADR-21: readiness is a lattice, not one global boolean

The application exposes independent readiness dimensions:

| Dimension       | Minimum proof                                                                                                          | Consumers                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| live            | process/event loop and listener respond                                                                                | public liveness probe only         |
| serve           | renderer assets, canonical origin/security shell and safe error handling ready                                         | edge routing/startup UI            |
| auth            | ADR-7 hash keys/store, pairing/reset/device/session policy and trusted proxy/origin ready                              | pair/renew/session/logout          |
| read            | identity/workspace scan and required read projections stable                                                           | list/detail/status queries         |
| mutation        | ADR-16 kernel lease FD/launcher, SQLite, migrations/recovery, watch barrier, writable mounts and command journal ready | create/update/delete commands      |
| runtime-control | mutation ready plus artifacts, process supervisor, planner and selected backend ready                                  | launch/stop/recovery commands      |
| machine-ingress | current lane/run credential/replay/effect handler ready                                                                | scoped runtime callbacks only      |
| terminal        | post-v1 only: authorized gateway/proxy/artifacts/quotas ready                                                          | no v1 consumer/global-ready effect |
| recovery-point  | ADR-32 driver, destination, participant catalog and fence/drain capability ready                                       | operator backup command only       |

RouteDescriptor declares the required static readiness dimensions; feature/action policy adds dynamic
workspace/provider/run requirements. Admission evaluates both and returns typed 503/retry guidance
without invoking the use case. A failed provider probe disables that provider action, not unrelated
task reads. SQLite/recovery failure may leave serve/read available in explicit read-only mode. Stop,
status, token revocation and recovery routes required to drain previously accepted work remain
available through a narrowly defined recovery admission even when new mutation admission is closed.
`recovery-point` is mode-specific: `coordination_backup` can be ready while a provider runs, whereas
`deployment_recovery_point` is unavailable until every required participant can be fenced/quiesced.
Restore readiness is evaluated in a separate offline/pre-pairing startup mode and cannot be inferred
from ordinary mutation readiness.

`/health/live` contains no dependency details. `/health/ready` means serve-ready for edge traffic and
returns only a coarse startup/degraded code; it is not evidence that every product mutation works.
Authenticated meta/capability projections expose safe per-dimension/action reason codes and revision.
Private operator diagnostics may show deeper redacted reasons. A readiness revision change emits a
scoped capability event and invalidates affected action allowances.

Tests cover every single-dimension failure and recovery, route admission without handler invocation,
read-only emergency mode, drain/recovery exceptions, and transition ordering. No code sets a global
`isReady=true` before all earlier startup barriers have completed, and no provider-specific outage
takes the login/team-read UI offline.

For v1 the terminal dimension is statically `not_offered`, is omitted from the required-readiness
conjunction and has no registered RouteDescriptor. It is not reported as a degraded release failure.
ADR-35 promotion changes the capability manifest only after its independent gates pass.

### ADR-22: process ownership is a durable spawn protocol, not a PID map

Default hosted v1 is `container_owned_stop`. The controller, provider children and a
minimal init run in one container PID namespace/lifecycle; `preserve-for-adoption=false`. A production
backend restart means replacement/restart of that complete container, not an in-place Node hot restart
that leaves children behind. SIGTERM still performs bounded graceful stop, but container teardown is
the final orphan boundary. Cgroups/namespaces used for lifecycle accounting do not upgrade the declared
`trusted_process` security profile.

Traditional `kill(pid)` has a race even after checking `/proc`: the target may exit and its PID may be
recycled before the signal. Linux explicitly provides pidfds to avoid that race. A process group is
also not a durable identity after its leader/tree disappears. Hosted therefore uses the ADR-31
`agent-teams-process-anchor`; Node never signals a persisted raw PID or PGID.

Every hosted provider spawn follows one recoverable protocol:

1. persist a spawn intent with TeamId/RunId/generation/member/lane, resolved binary identity,
   WorkspaceId/bindingGeneration/mountGeneration, ADR-30 child-environment policy hash, relay scope
   hash and random spawnNonce before any process effect;
2. spawn the process anchor without a shell from an app-owned neutral cwd, with dedicated control and
   status pipes. The hosted adapter consumes the server-only ADR-25 grant and supplies only the fixed
   expected root/mount evidence required by ADR-28; the grant itself is never serialized. The anchor
   revalidates that evidence, becomes the stable ownership-group leader/subreaper, then forks/execs
   the allowlisted provider child;
3. the anchor opens a pidfd for the main child, owns/reaps descendants and reports one bounded ready
   record containing anchor/main-child identity, workspace evidence and spawnNonce checksum. Raw argv,
   environment and secrets never enter the status protocol;
4. the application verifies the runtime/bootstrap handshake against the same run/lane/nonce and only
   then commits `ProcessOwnershipRecord`. A failed handshake is anchor-owned cleanup, not adoption;
5. normal stop writes a typed TERM/grace/KILL request to the live control pipe. The anchor keeps its
   process-group identity allocated while forwarding signals, uses pidfd for the main child, reaps
   descendants, emits `drained`, then exits. Node observes status/EOF and never falls back to PID kill;
6. controller pipe EOF/parent death triggers the same bounded anchor cleanup. If the anchor/control
   protocol is missing, corrupt, wedged or exits before `drained`, the run becomes
   `unclassified_residual` and only full container replacement may restore mutation/pairing readiness.

The anchor is not a provider manager or domain service. It knows only descriptor-bound cwd entry,
process group/subreaper mechanics, signal escalation, bounded status framing and reaping. It cannot
select providers, teams, credentials, retry policy or lifecycle state. The feature-owned
ProcessSupervisorPort owns the semantic plan; the hosted adapter translates that plan to the anchor.

Post-v1 T1 `terminal-workspace` does **not** use the legacy node-pty service: it launches
terminal-platform's Rust daemon, whose native backend uses portable-pty and currently drops a pane by
calling `child.kill()` without waiting for or classifying descendants. ADR-35 therefore owns a distinct
TerminalRuntimeSupervisorPort, boot-scoped daemon/socket/store identity, sanitized environment and a
typed daemon close-all/drain protocol. The daemon process may run beneath ADR-31's low-level anchor,
but PTY controlling-session/job-tree behavior must be proven rather than inherited from the provider
contract. Terminal shells are stop-owned and never adopted after controller loss. If close-all cannot
prove every pane/background child drained, terminal close becomes `drain_unconfirmed`, new terminal
admission closes and full container replacement is the only cleanup claim. Legacy node-pty callsites
remain a separate desktop concern and cannot serve as hosted terminal evidence.

Desktop and explicit non-container development keep `process_owned_stop` behind a separate adapter:
POSIX process groups plus start-token checks and Windows Job Objects. They cannot be substituted for
the hosted anchor contract if they provide weaker drain evidence; LSP is enforced by distinct
capability records, not one interface that sometimes guesses.

A crash before anchor spawn proves no effect from the intent. A crash after spawn but before committed
ownership is still container-owned because the control pipe/parent-death path orders cleanup; missing
`drained` evidence remains `unclassified_residual`. Startup never guesses, kills by name, reconnects
to a stale pipe or treats a PID file as proof. Unknown processes outside persisted intents are observed
only. The production artifact probes anchor protocol/build hash, subreaper, pidfd and TERM/KILL/reap
behavior inside the final container.

Primary references: [pidfd_open(2)](https://man7.org/linux/man-pages/man2/pidfd_open.2.html),
[pidfd_send_signal(2)](https://man7.org/linux/man-pages/man2/pidfd_send_signal.2.html),
[PR_SET_CHILD_SUBREAPER](https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html),
and [Docker init/reaping guidance](https://docs.docker.com/engine/containers/multi-service_container/).

`processRef` remains a random opaque lookup key to the server-side record, never an encoded PID.
Retention keeps anchor ownership facts long enough to reject late stop/kill retries while
secrets, argv and environment values never enter browser projections or durable ownership records.

### ADR-23: state compatibility is machine-readable and checked before migration

Every release artifact embeds a `StateCompatibilityManifest` generated in CI. It declares artifact
version plus read/write ranges for each independently versioned state family: internal-storage schema,
ADR-7 auth/keyring metadata/AuthResetIntent, team identity, backup manifest, command/saga journal,
event journal/cursor epoch, runtime-plan/evidence and provider-owned app stores. Post-v1 T1 extends
the manifest with ADR-35 terminal ownership/drain/store schemas only when those migrations/artifacts
exist. It also declares
migration IDs/checksums and the oldest artifact allowed to drain non-terminal work created by this
release. A single marketing app version or feature flag is not a compatibility proof.

Startup ordering is fixed:

1. validate the embedded artifact/native-worker manifest without touching mutable state;
2. start only beneath the ADR-16 instance-lock launcher, validate the inherited held descriptor and
   diagnostic binding, then inspect state headers/schema read-only with migrations disabled;
3. compare every discovered family and all non-terminal command/run/saga records with the compatibility
   manifest. Future/unknown or non-drainable state closes migration/mutation/runtime readiness while a
   safe diagnostic/read-only surface remains only where its own reader range permits;
4. take and verify the required pre-migration backup, persist migration journal `prepared`, apply one
   idempotent expand migration, verify invariants, then commit the migration record;
5. run recovery and only then open mutation admission. Feature flags cannot skip an incomplete
   migration or make an older writer safe.

There is no automatic schema downgrade. Rollback preflight computes one of `in_place_compatible`,
`drain_then_compatible`, `restore_app_owned_backup`, or `refused`, with typed reasons. Restoring an
app-owned backup never rolls back CLI/provider-owned files unless their mutation journal proves the
same operation changed them and supplies a verified compensation. CI exercises N -> N+1, interrupted
N+1 resume, and N+1 -> N compatible-or-refuse using built artifacts and copied state, not only migration
unit tests. Contract/manifest drift or a migration missing from either side fails the artifact gate.

### ADR-24: external file writes are team-scoped unless run identity is proven

Claude-compatible config/tasks/inboxes are a shared team protocol and generally do not carry a
trustworthy RunId/generation. A path under LegacyTeamKey resolves TeamId, but it does not prove which
provider process or run wrote the bytes. The watcher records an `ExternalFileActor` with path-key,
content fingerprint and observation sequence; it never invents current RunId/member attribution from
mtime, selected UI run, task owner or claimed JSON fields.

Provider-specific artifacts may produce `VerifiedRunActor` only when their adapter validates embedded
RunId/generation/lane against currentRunRef, immutable plan and provider manifest/credential evidence.
Run-scoped facts such as heartbeat, approval acknowledgement, runtime delivery and process liveness
cannot enter through a generic task/inbox watcher. Unverifiable claimed member/run fields remain
untrusted content/diagnostics, not authorization or audit actor identity.

TeamLifecycle stores a monotonically increasing `fileWriterEpoch` and watcher watermark. Before a new
canonical launch after any prior run, RunRecoveryWorkflow must complete a quiescence barrier:

1. fence old runtime ingress and new old-generation effects;
2. terminate and verify every ADR-22 ownership unit, or enter unclassified-residual block;
3. drain queued watcher notifications through a captured sequence watermark;
4. perform a bounded stable rescan of catalogued team/task/inbox paths and commit resulting team-
   scoped revisions/outbox events;
5. close the previous fileWriterEpoch and atomically accept the new LifecycleRun/plan/currentRunRef
   with the next epoch.

The barrier uses capture-drain-rescan-recapture with bounded retries. If new observations or unstable
fingerprints keep crossing the barrier, LaunchTeam is not accepted and returns typed
`external_writer_busy`/retry guidance; it never waits forever or guesses a quiet timeout. Immediately
before the first spawn, the workflow revalidates plan input checksums/roster/binding generation. A
post-accept config/topology change moves the run to recovering/conflict before spawn rather than
executing a stale plan.

Watcher observations captured at/below the closed watermark cannot later be routed as new-run events.
An external file write observed after the new epoch remains a valid team-scoped external mutation if
the owning feature schema/invariants allow it, but is not falsely labelled as produced by the new run.
During DeletionSaga's mutation fence, new external writes are retained as bounded conflict evidence
and keep deletion recovering/operator_required; they are never silently dropped or used to resurrect
the team. This protocol adds no RunId fields to CLI-owned JSON and preserves provider compatibility.

### ADR-25: stable workspace registration and boot-scoped mount evidence are separate

WorkspaceId is stable deployment identity keyed by the operator manifest's immutable registrationKey.
Filesystem `realpath`, device/inode, mount ID, filesystem type and access probes are observations of a
particular boot/container mount and cannot be permanent WorkspaceId identity. The workspace registry
therefore creates one `WorkspaceMountBinding` per enabled registration and boot:

    WorkspaceId
      + bootId
      + monotonic mountGeneration
      + declaredRootHash
      + canonicalRealPath/root stat/mount evidence
      + effective read/write/Git/worktree capabilities
      + observedAt/health

Every successful startup binding advances mountGeneration, even when the observed fingerprint looks
unchanged. Browser resource refs, review file IDs, Git handles and
CompositeRuntimePlan store WorkspaceId + mountGeneration and expire/fail stale after restart or
remount. TeamWorkspaceBinding remains stable by WorkspaceId/bindingGeneration; it resolves a fresh
mount binding for each operation rather than persisting dev/inode as domain identity.
Post-v1 T1 extends the same fencing to terminal sessions.

Within one boot, mount disappearance, root replacement, symlink swap, permission downgrade or
fingerprint change immediately disables affected admission and invalidates outstanding grants. The
workspace-registry adapter revalidates the current binding and returns a narrow
`WorkspaceAccessGrant` for one operation/capability; the hosted output adapter consumes it through
ADR-28, while desktop has a separately characterized compatibility adapter. Grants are not a generic
filesystem port and are not cacheable across mountGeneration. A grant is server-only/non-serializable,
carries no browser-visible path accessor and is consumable only by the named output adapter/operation.

Across a full container restart, the same registrationKey + declaredRootPath may legitimately observe
different dev/inode/mount IDs. This is accepted as a new boot binding only after manifest validation,
overlap/permission/filesystem probes and confirmation that no non-terminal workflow intends to resume
effects against the old mountGeneration. Default stop-owned container lifecycle makes new launch safe;
ambiguous recovery remains blocked until operator reconciliation. A changed declaredRootPath for the
same key is never treated as remount and remains forbidden.

The operator-controlled manifest/mount mapping is the v1 cross-boot trust root. Without an external
signed volume identity there is no portable proof that different bytes mounted at the same declared
path are the same project; the product must not claim otherwise. Fingerprint changes are audited and
shown in private diagnostics. Backup/restore preserves WorkspaceId/registrationKey/binding history but
never restores a stale mount fingerprint as current authority.

### ADR-26: backup restore replaces one deployment; it does not silently clone it

DeploymentId is a random immutable app-owned identity persisted in the state root and included in the
verified backup manifest. Product v1 supports only `replace_deployment` disaster recovery into an
empty target root. The operator explicitly selects that mode and attests the source controller is
offline; the single-host/single-operator model cannot cryptographically prove a remote copied source
will never be restarted and does not claim to.

Replacement preserves DeploymentId, OperatorId, TeamIds, MemberIds, WorkspaceIds/registrationKeys,
tombstones, committed commands/audit and compatible non-terminal workflow records. It always creates
a new bootId, rotates eventEpoch, revokes every copied ADR-7 device/session family and browser cursor,
revokes/reissues runtime ingress credentials, requires a fresh pairing exchange after
activation and establishes fresh ADR-25 mount bindings. Auth hash/pepper material is never restored as
usable authority. ProcessOwnershipRecords are historical evidence only; no PID/process is adopted
from a backup. Non-terminal workflows recover or become operator_required before mutation readiness.

Restore preflight runs in an explicit offline mode and requires an empty target, exclusive ADR-16
kernel-lock acquisition by the restore tool, exact source deployment metadata,
ADR-23 state compatibility, complete identity/backup checksum agreement and an operator-provided
current workspace manifest. It stages and validates every configured state/CLI root, then uses a
durable cross-root restore journal with per-root checksums and a final activation marker; no impossible
cross-filesystem atomic rename is claimed. Crash resumes or rolls back unactivated stages. The server
creates no pairing material and exposes no mutable controller until the activation marker and startup
preflights agree.

Creating a second independent deployment from a backup is `fork_deployment`, not restore. It would
need a new DeploymentId/OperatorId, event history and idempotency namespace decisions plus explicit
TeamId/WorkspaceId import semantics, and is deferred from v1. Tests that need duplicate fixtures
generate synthetic isolated state rather than invoking an undocumented production fork.

### ADR-27: browser command recovery persists a receipt, never the sensitive command body

Before sending any retryable mutation, the hosted client generates its idempotency key and writes a
bounded `PendingCommandReceipt` to localStorage under deploymentId + stable non-secret actorRef:

    actionId, idempotencyKey, teamId/resource opaque IDs,
    createdAt, local intent label,
    commandId/workflowRef when later known

It never stores prompt/message text, provider options containing secrets, host/relative paths,
attachment data, approval input, CSRF/session/runtime tokens or the serialized request body. The
idempotency key is not a bearer credential; server lookup always requires the authenticated matching
OperatorId and action scope. Receipt TTL/count are bounded and no receipt is shared across DeploymentId.
Local receipt data is schema-validated as untrusted on read; tampering can at most trigger a bounded
status lookup and can never construct or authorize a mutation.

After timeout, reload or re-login, the client resolves an unknown receipt through an authenticated
rate-limited command-status lookup by actionId + idempotencyKey. The server scopes lookup to the current
actor and returns not_found, prepared/running/recovering/operator_required, or committed outcome plus
stable workflowRef. The browser never replays a mutation merely because status is unknown. `not_found`
means no durable claim exists and requires a new explicit user action; expired/compacted ambiguity is
prevented by keeping server command retention at least as long as the advertised receipt recovery TTL.

When the initial response arrives, commandId/workflowRef are added to the receipt and subsequent
recovery uses opaque commandId. A same-key different-body retry remains server-side conflict. Receipts
are removed only after the command and referenced workflow reach a safely presented terminal state or
the user explicitly forgets local history; logout alone keeps them for intended re-login recovery.
Multi-tab updates use BroadcastChannel/storage events to converge receipt metadata, but this channel
does not carry command bodies or become an execution bus.

### ADR-28: hosted workspace effects require a descriptor-bound Linux guard

The target stack is Node 24 on Debian slim. Local inspection shows that current file services perform
path-string reads followed by post-read `realpath()` checks and Git services do `realpath()` and later
`execFile(..., { cwd: string })`. Terminal is not `node-pty`: the app starts the Rust
`terminal-daemon`, whose native backend turns serializable `ShellLaunchSpec { program, args, cwd }`
directly into a `portable_pty::CommandBuilder`. Both process paths therefore still accept only a cwd
pathname rather than an already verified directory object. That leaves a check/use window when an
agent-writable parent or mount is renamed or replaced.

This is a platform limitation, not something another TypeScript validator fixes:

- Node's documented `O_NOFOLLOW` flag rejects a symlink in the final component; Linux explicitly
  distinguishes that from `RESOLVE_NO_SYMLINKS`, which covers all path components;
- Node child-process `cwd` is a string or file URL, and the current terminal-platform launch DTO has
  only a `PathBuf cwd`; neither transports an already verified directory descriptor;
- Linux `openat2` was added in kernel 5.6 specifically to constrain resolution of untrusted paths
  with flags such as `RESOLVE_BENEATH` and `RESOLVE_NO_MAGICLINKS`;
- Docker added `openat2` to its default seccomp profile in the 20.10 line, but the actual production
  kernel/seccomp/filesystem combination still needs an executable probe.

Primary references: [Node filesystem API](https://nodejs.org/api/fs.html),
[Node child process API](https://nodejs.org/api/child_process.html),
[Linux openat2(2)](https://man7.org/linux/man-pages/man2/openat2.2.html), and
[Docker 20.10 security notes](https://docs.docker.com/engine/release-notes/20.10/).

Three approaches were evaluated:

1. **Small descriptor-bound Linux guard - chosen.** 🎯 9/10 🛡️ 9/10 🧠 8/10,
   approximately 2,500-4,500 changed lines including packaging and adversarial tests. It closes the
   controller's path-string race without forcing a general provider rewrite.
2. **Per-run mount/user namespace sandbox for every provider, Git command and terminal.**
   🎯 7/10 🛡️ 10/10 🧠 10/10, approximately 7,000-14,000 changed lines. It is stronger isolation,
   but contradicts the accepted `trusted_process` v1 scope and materially changes provider auth,
   terminal, debugger and workspace semantics. Keep it as a future isolation profile.
3. **Node-only `realpath`/`lstat`/post-check fallback.** 🎯 3/10 🛡️ 3/10 🧠 3/10,
   approximately 700-1,300 changed lines. It is rejected because deterministic rename/symlink races
   can invalidate the checked pathname before read, write or spawn.

The chosen artifact is a narrowly scoped, one-shot Linux executable named
`agent-teams-workspace-guard`, implemented without a new runtime package ecosystem. A small C source
uses the kernel ABI directly and is compiled in a dedicated Docker build stage; the final image
contains only the stripped binary and its build metadata. It is not a daemon, shell, general RPC
server, privilege escalation mechanism or browser-callable API. CI builds it with warnings-as-errors,
ASan/UBSan tests and protocol fuzz/size tests; the release image runs non-root and the guard receives
no browser/controller session secrets.

The guard has two fixed operation families:

1. bounded file verbs (`probe`, `stat`, `list`, `read`, `create`, `replace`, `rename`, `remove`) with
   typed length-prefixed input and bounded output; and
2. `exec-approved`, which reads a bounded one-use launch envelope from a dedicated inherited FD,
   verifies and enters the cwd, closes unintended descriptors, then calls `execve` directly with a
   server-built argv/env. There is no `sh -c`, command string, glob or browser-provided binary/argument
   vector. The envelope is never placed in argv, environment, a predictable file or PTY input.

Every invocation receives a server-resolved registration record, expected bootId/mountGeneration and
expected root `statx` evidence. It:

1. opens the current canonical registered root as `O_PATH|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW`;
2. compares descriptor identity and mount ID with the current ADR-25 grant;
3. resolves relative segments from that descriptor with
   `RESOLVE_BENEATH|RESOLVE_NO_MAGICLINKS`, rejecting absolute paths, `..`, magic links and escape;
4. rejects crossing a submount with `RESOLVE_NO_XDEV` by default. An intentional nested mount must be
   a separate workspace registration; it is never silently inherited;
5. binds the actual effect to opened parent/target descriptors. Create/replace uses same-directory
   temporary files, bounded mode/ownership, file fsync, `renameat2` policy and parent fsync;
6. returns a typed result containing the consumed mountGeneration and safe error code, never the host
   path. `EAGAIN`, `EXDEV`, identity drift or unsupported syscall is fail-closed, not a Node retry on
   a raw pathname.

Relative symlinks that remain beneath the registered root may be supported for explicitly read-only
verbs through `RESOLVE_BENEATH`; magic links and absolute escape are always rejected. Mutation verbs
default to no symlink traversal unless a verb-specific test proves the exact semantics. This avoids
the false choice between allowing every symlink and breaking every repository that contains one.

`exec-approved`/its audited descriptor-entry primitive is used in three distinct adapters:

- provider/process supervision starts ADR-31 from an app-owned neutral cwd. The process anchor uses
  the shared descriptor-entry primitive before it forks/execs the already allowlisted provider; the
  workspace guard does not become a second waiting supervisor;
- terminal-platform's native portable-pty backend spawns the guard from a neutral cwd. A new hosted-
  only `GuardedShellLaunchSpec` carries no browser-selected program/args/cwd; the daemon creates a
  bounded pipe, maps its read end to a fixed allowlisted child FD, writes the derived launch envelope,
  and portable-pty starts only the pinned guard artifact. The guard validates the envelope, enters the
  verified workspace and replaces itself with the approved shell. Because `execve` occurs in the same
  PTY child, controlling-terminal ownership and signal semantics remain attached. Generic
  `ShellLaunchSpec` remains available to desktop/internal callers but is rejected on the hosted facade;
- Git uses only an application-owned subcommand/argument allowlist. Environment and explicit config
  disable system/global config, hooks, pager, external diff/textconv, credential prompting and
  external fsmonitor; network/remotes are unavailable unless a separate capability is later designed.
  This is required because official Git documentation confirms `worktree add` normally invokes the
  `post-checkout` hook. See [Git hooks](https://git-scm.com/docs/githooks) and
  [Git config environment](https://git-scm.com/docs/git-config).

The guard proves **selection and cwd integrity for controller-mediated effects**. It does not claim
that an authenticated interactive shell, provider process or Git binary is confined after exec:
those run as the same non-root deployment user under ADR-14's explicit `trusted_process` profile.
Stronger hostile-runtime filesystem confinement requires option 2 and is not smuggled into the v1
claim. Likewise, the guard does not authorize an operation; it consumes an already authorized
WorkspaceAccessGrant and adds a final descriptor-bound enforcement layer.

Readiness has a separate `workspaceGuard` dimension with version/build hash, kernel, syscall,
seccomp, root-fingerprint, atomic-write/fsync and exec/PTY probe outcomes. Required production
launch, Git mutation, review/file mutation and terminal capabilities are absent unless their exact
verb probe passes in the final image. Read-only team projections that do not touch a registered
workspace may remain available. There is no `realpath()` compatibility fallback in hosted mode.

The Phase 0 feasibility test must run the built guard inside the target container while an adversary
loop repeatedly swaps a parent directory, final symlink, root rename and bind mount. It must prove:

- no byte is read from or written outside the marker-owned sandbox;
- no process or PTY starts with cwd outside the granted descriptor tree;
- stale mountGeneration and root identity produce zero effects;
- expected in-root symlink policy is deterministic;
- Git worktree creation cannot execute a repository hook or external helper;
- a missing/blocked `openat2`, `statx` mount identity or required atomic primitive keeps the related
  readiness dimension false.

This gate is before feature expansion because failure changes the supported host envelope or forces
the explicitly larger namespace-sandbox design; discovering it after TeamsAPI wiring would invalidate
spawn, terminal, review and Git assumptions simultaneously.

#### Descriptor-bound PTY launch handoff

ADR-28's terminal path is a concrete cross-repository protocol, not an instruction to serialize an
open descriptor through the existing length-delimited JSON daemon API. Unix descriptors do not cross
that protocol without `SCM_RIGHTS`, and adding a general descriptor-passing RPC would unnecessarily
broaden terminal-daemon authority. The selected design instead reuses the one-shot guard inside the PTY
child and makes terminal-platform responsible for one narrowly typed inherited-FD handoff:

1. `TerminalShellLaunchPolicy` consumes the in-memory `WorkspaceAccessGrant`, approved shell artifact
   identity and current registration evidence. It emits a bounded `WorkspaceLaunchEvidenceV1`, not the
   grant: protocol/build ID, BootId, TerminalRuntimeId, TerminalAccessSessionId, WorkspaceId,
   mountGeneration, controller-resolved canonical registered root path, root device/inode/mount ID,
   approved relative cwd, shell artifact ID/digest, fixed argv profile ID, environment policy ID,
   issued monotonic deadline and random launch nonce. The path is internal selection input reverified by
   descriptor identity, never browser output or proof by itself. The envelope has no browser/session/
   runtime bearer, provider credential or arbitrary environment value.
2. The controller sends that evidence only over its boot-authenticated local daemon channel. At daemon
   spawn, the controller generates and retains a random control-channel key in memory, and the daemon
   receives it through an inherited bootstrap pipe; it is absent from argv/env/files/logs and the
   bootstrap copy/FD are erased after channel establishment. Every hosted
   launch request is MAC-bound to BootId, TerminalRuntimeId, channel generation and exact evidence
   digest. On Linux the daemon also verifies local-socket peer UID and the controller PID/start-token
   recorded in its spawn intent; credential lookup failure is fail-closed. This is defense against
   stale/foreign same-UID clients, not a claim that the container user is a hostile security boundary.
3. The daemon verifies the MAC, deadline, nonce uniqueness, artifact/policy allowlists and ownership,
   then creates `pipe2(O_CLOEXEC)` for a single guard launch. The native backend's hosted-only spawn
   primitive maps the read end to one fixed FD, clears `FD_CLOEXEC` only for the guard, closes every
   other non-stdio descriptor and starts exactly the pinned guard binary. Portable-pty needs an audited
   allowlisted inherited-FD extension; a generic caller-selected FD map is rejected.
4. The guard reads exactly one size-capped envelope from the daemon-owned private pipe, rejects trailing
   bytes/version/hash/deadline/generation mismatch, closes the envelope FD, independently opens and
   verifies the registered root with `openat2`/`statx`, resolves the relative cwd beneath it, calls
   `fchdir`, applies the fixed clean environment and `execve`s the approved shell. The controller-to-
   daemon MAC is not reused as fake guard authentication: integrity of this hop comes from the private
   one-child pipe and strict descriptor closure. Neither daemon nor guard reconstructs authority from
   the browser DTO or trusts the prechecked path string alone.
5. A separate close-on-exec status pipe implements a bounded exec-error handshake. The guard reports
   verified root/cwd identity and any pre-exec or `execve` failure; successful `execve` closes the status
   FD. Daemon combines EOF with pidfd/wait/process-executable evidence, treating missing or contradictory
   evidence as `launch_ambiguous` and draining without automatic retry. Until the handshake commits, the
   session is `starting`, no terminal bytes are exposed and a timeout kills/drains the child. Launch
   nonce/result are persisted before browser readiness so response loss cannot start a second shell.
6. Guard envelope/status FDs are absent from the resulting shell and descendants. The controller's
   ADR-16 lease FD, daemon control key FD and unrelated inherited descriptors are likewise forbidden.
   `/proc/<pid>/fd` canaries, forced partial writes, guard crash, exec failure, replay, stale generation,
   root swap and PTY signal/resize tests are release gates in the final image.

Using argv or environment for the envelope is rejected because it leaks through process inspection;
using PTY stdin is rejected because it races with user input and corrupts terminal semantics; passing
the original `WorkspaceAccessGrant` to terminal-platform is rejected because it collapses authorization
and mechanism. If the pinned portable-pty implementation cannot preserve the single allowlisted FD and
close all others under the target OS, hosted terminal readiness remains false rather than falling back
to string `cwd`.

### ADR-29: uncoordinated external JSON writers cannot share a lossless direct-mutation claim

ADR-28 prevents path escape, but it does not turn provider-owned JSON into a transactional database.
Linux `rename()` atomically replaces a destination name; it does not condition that replacement on
the destination still having the inode/hash previously read. `RENAME_NOREPLACE` helps create-only
publication, not compare-and-swap replacement. An inotify queue may coalesce events or overflow, so a
watcher cannot reconstruct bytes already overwritten by a racing process. Node likewise documents
that concurrent filesystem modifications are not synchronized.

Primary references: [Linux rename(2)](https://man7.org/linux/man-pages/man2/rename.2.html),
[Linux inotify(7)](https://man7.org/linux/man-pages/man7/inotify.7.html), and
[Node filesystem API](https://nodejs.org/api/fs.html).

Every file family in the ownership catalog therefore has exactly one `writerCoordination` class:

| Class                    | Meaning                                                                                                | Mutation rule                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `app_exclusive`          | only the controller writes while its ADR-16 lease is held                                              | normal expectedRevision + journal + ADR-28 atomic publication                                               |
| `cooperative_external`   | every real writer is proven to honor the same lock/fencing or a provider semantic command/ack protocol | mutate only through that characterized protocol; a fixture that merely resembles the writer is insufficient |
| `uncoordinated_external` | a provider/CLI version may write without the controller's fence                                        | no concurrent direct browser replacement while that writer can be alive                                     |

The classification is per provider version and operation, not a blanket label for `tasks/*.json` or
`config.json`. A new provider/version defaults to `uncoordinated_external` until its real adapter and
artifact fixtures prove otherwise. Watchers remain observation/cache-invalidation mechanisms, never
proof that all intermediate writes were captured.

For `uncoordinated_external`, the application has only three truthful choices:

1. perform the direct mutation after a durable quiescence barrier proves every relevant writer is
   stopped, ADR-24 watermark/rescan is closed, and the source revision is re-read;
2. submit a provider-mediated workflow to the actual writer and report `accepted`, `running`,
   `observed`, `failed`, or `operator_required` separately. Success is emitted only when the expected
   semantic change is observed at a newer source generation; delivery alone is not mutation success; or
3. expose the projection read-only with `external_writer_active`/`provider_mutation_unsupported`.

There is no automatic queue-and-replay of a stale direct JSON body after the writer stops. The user
must confirm against the new revision, because task ownership, status, relationships or approval
context may have changed. Domain merge/retry is allowed only for a catalogued commutative operation
with a property test; generic object spread or last-writer-wins is forbidden.

This rule applies to task/Kanban edits, member/config changes, inbox/message delivery, review edits,
backup/restore and lifecycle projections independently. For example, a provider adapter may prove a
cooperative inbox append but not task-file replacement. The capability response and UI action state
include the operation's current writer class/reason without revealing paths. Controls are gated before
click and can change as a run enters/leaves quiescence.

Near-parity release does not waive this invariant. Every required active-run mutation must either have
a characterized cooperative/provider-mediated path with real observed outcome, or be explicitly
specified as quiescent-only in the product acceptance matrix. If product acceptance requires direct
live mutation for an uncooperative provider, that requires changing the provider writer or introducing
the stronger broker/isolation architecture; it cannot be solved inside a web transport adapter.

The deterministic E2E suite includes a hostile fake writer that replaces the same JSON at every
protocol boundary. It must prove that app-exclusive/cooperative operations commit exactly once,
uncoordinated direct mutations are never admitted while active, provider-mediated workflows do not
claim success before observation, and quiescent mutation rechecks the final source generation.

### ADR-30: controller credentials stay in a controller-owned lane relay

Current provisioning builds an environment by spreading `process.env` plus shell/provider state,
then adds control URLs and bootstrap tokens. Node documents that a child receives the supplied
environment and descendants inherit it. On Linux, `/proc/<pid>/environ` and `/proc/<pid>/fd` access is
governed by ptrace checks; Docker's defaults reduce some inspection syscalls but do not create a
security boundary between trusted same-UID siblings. Therefore an env variable or mode-0600 file is
not accepted as hostile-sibling secrecy in the v1 profile.

Primary references: [Node child process environment](https://nodejs.org/api/child_process.html),
[Linux environment inheritance](https://man7.org/linux/man-pages/man7/environ.7.html),
[proc PID file descriptors](https://man7.org/linux/man-pages/man5/proc_pid_fd.5.html), and
[Docker seccomp profile](https://docs.docker.com/engine/security/seccomp/).

Three designs were evaluated:

1. **Controller-owned per-lane relay plus allowlist-first child environment - chosen.**
   🎯 9/10 🛡️ 8/10 🧠 8/10, approximately 1,800-3,200 changed lines. The canonical runtime bearer
   never enters the provider process tree, and provider payloads cannot choose canonical lane scope.
2. **Bearer in environment or mode-0600 run file.** 🎯 3/10 🛡️ 4/10 🧠 3/10,
   approximately 500-900 changed lines. It is rejected for hosted mode because current code broadly
   copies environments and same-UID confidentiality cannot be claimed.
3. **Separate UID/container/mount namespace per lane.** 🎯 8/10 🛡️ 10/10 🧠 10/10,
   approximately 8,000-16,000 changed lines. This is the correct future hostile-runtime profile, but
   it changes provider auth/storage/debug/terminal topology beyond accepted v1 scope.

`RuntimeIngressRelay` is a process-owned adapter, not a new team service. One relay instance is bound
to exactly one `(deploymentId, TeamId, RunId, generation, LaneId, credentialGeneration, allowedVerbs)`
and cannot accept those authorities from provider payloads. The controller gives the canonical bearer
to the app-owned relay over a dedicated inherited pipe/FD, the relay reads it once, closes the bootstrap
FD and keeps only bounded in-memory material. No plaintext bearer is persisted.

The provider receives only the provider-native local MCP/bridge connection descriptor for that relay.
Hosted relay endpoints are private, per-lane, short-lived and absent from browser/API/events/logs. A
request can invoke only the relay's fixed lane verbs; body team/run/member/provider identifiers are
ignored or must equal derived scope. Relay stop/restart rotates both local endpoint identity and the
canonical server credential. A shared global relay that routes by body `teamName` is forbidden.

The descriptor may contain a provider-visible opaque `LaneRelayHandle`. It is a narrow local
capability, not the canonical server bearer: it maps to one immutable relay session, cannot authorize
operator or another-lane verbs, expires with credentialGeneration and is safe to revoke independently.
It is still treated as sensitive in logs/artifacts and is not claimed secret from same-UID siblings.
One app-managed relay process may host several isolated LaneRelaySession records to reuse the existing
MCP HTTP child, but lookup is exclusively by the opaque handle and server-owned registry; payload
`teamName`/RunId never selects a session.

This removes accidental bearer inheritance and narrows compromise, but it does **not** claim that a
malicious same-UID process cannot discover or call another local relay. Under `trusted_process`, lane
credential scopes are correctness/replay fences against stale, malformed or externally sourced calls,
not hostile sibling authentication. Capability/meta and security documentation state this explicitly.
Promoting hostile sibling isolation requires option 3 and new threat-model tests.

Each hosted ProcessExecutionUnit receives an environment built from an empty
`HostedChildEnvironmentPolicy`, not `{...process.env}` or a login-shell dump. The allowlist is
backend/version/execution-unit-specific and contains only characterized execution necessities:

- base execution: minimal PATH, HOME/USER, locale, TERM when needed, temp/config/cache roots;
- explicit provider settings and only the `SecretRef`-resolved provider credentials in the immutable
  ADR-18 CredentialExposureSet for that execution unit;
- explicitly reviewed proxy/TLS variables when deployment policy enables them;
- provider-native relay descriptor and non-secret run/lane correlation values;
- where the characterized provider bootstrap requires it, one one-use spawn/bootstrap nonce that can
  prove only the first matching anchor/run handshake, expires on consume/timeout and cannot authorize
  any runtime-ingress verb. It is classified and tested separately from the canonical bearer.

Controller-only names are denylisted in depth even if accidentally added to an allowlist: pairing,
browser session/CSRF, runtime ingress bearer, ADR-16 lease descriptor/launcher control pipe, database/
state encryption, terminal ticket, private readiness/metrics and internal control credentials. The
reserved lease FD is also excluded by descriptor policy, not only by environment filtering.
Loader/runtime injection variables such as
`LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_*`, `NODE_OPTIONS`, `NODE_PATH`, `BUN_OPTIONS`, `PYTHONPATH`,
arbitrary `GIT_*`, `SSH_ASKPASS` and credential-helper variables require an explicit provider policy;
they never flow from the controller ambient environment by default.

Provider API keys/OAuth material are a separate unavoidable provider trust decision: the selected CLI
may need them. They are scoped to the persisted ProcessExecutionUnit exposure set, excluded from logs/
diagnostics/ownership records and materialized only through the owning provider adapter. A mixed
Claude-compatible unit may legitimately contain several providers' credentials because current
topology runs those members in one process; the product reports that shared exposure rather than
claiming per-member isolation. No separate execution unit receives a credential outside its set. The
plan does not relabel provider credentials as controller credentials or claim the CLI cannot read
credentials it must use.

Phase 0 produces an environment provenance ledger for every emitted key:

    output key -> source class -> owner -> executionUnitId -> provider/backend/version
               -> CredentialExposureSet membership -> secret class -> required probe/test
               -> child/descendant visibility -> redaction rule

Architecture tests reject `process.env`/shell-env spread in hosted spawn, relay and MCP-config graphs.
Golden fake CLIs print only environment key names plus keyed test hashes, never values, so CI proves
required keys exist, forbidden keys do not, and no execution unit receives a secret outside its
persisted exposure set.
Diagnostic bundles run a structured secret-canary scan across argv, environment snapshots, generated
settings/MCP files, stdout/stderr, events and retained artifacts.

### ADR-31: hosted provider runs use a stable process anchor, not check-then-kill

ADR-22's original `stat PID -> kill PID` idea had the same check/use flaw as path validation. Linux
pidfds exist specifically because a PID can be recycled between inspection and signal. A pidfd safely
targets one process, but it does not by itself own/reap an arbitrary descendant tree. Hosted v1
therefore combines a stable anchor, process group, subreaper and control/status pipes.

Three designs were evaluated:

1. **Per-run process anchor inside the existing container - chosen.**
   🎯 9/10 🛡️ 9/10 🧠 8/10, approximately 2,200-3,800 changed lines including race/chaos tests.
2. **Delegated cgroup v2 per lane with `cgroup.kill`.** 🎯 7/10 🛡️ 10/10 🧠 10/10,
   approximately 5,000-9,000 changed lines plus a stricter host contract. Stronger, but ordinary Docker
   deployments do not guarantee safe writable cgroup delegation to a non-root app.
3. **PID/start-token recheck followed by `kill()`/`killpg()`.** 🎯 3/10 🛡️ 4/10 🧠 3/10,
   approximately 500-1,000 changed lines. Rejected because revalidation and signal are not atomic.

`agent-teams-process-anchor` is a second narrow Linux artifact compiled beside, but not merged with,
the ADR-28 workspace guard. They may share audited syscall/framing utilities at build time; their
protocols, binaries, ports and readiness dimensions stay separate for SRP and least capability.

The anchor protocol is fixed:

1. receive a sanitized execution envelope plus expected registered-root/mount evidence over inherited
   pipes, verify protocol/hash, independently revalidate and enter the descriptor-bound cwd using the
   shared ADR-28 primitive, set no-new-privileges and close every descriptor except declared
   stdio/control/status/relay-bootstrap descriptors. The server-only WorkspaceAccessGrant is consumed
   by the adapter and never crosses the process boundary;
2. create and remain the process-group leader, enable `PR_SET_CHILD_SUBREAPER`, fork the provider main
   child into that group and obtain its pidfd before exposing `ready`;
3. forward bounded stdout/stderr separately, reap orphaned descendants, and report only typed lifecycle
   frames: ready, main_exit, escalation, drained, protocol_error;
4. on typed stop, control-pipe EOF or verified parent death, forward TERM, wait the configured grace,
   then KILL the anchored group if needed. The live anchor keeps the PGID allocated through escalation;
5. exit successfully only after the owned group is drained and descendants reaped. Missing `drained`
   evidence is never inferred from PID absence.

The anchor has no network listener, provider registry, filesystem mutation API or secret storage. It
cannot relaunch, adopt, choose policy or interpret team state. Status framing is bounded and treats
provider output as unrelated bytes. A provider child intentionally escaping the process group remains
outside the hostile-runtime guarantee; deterministic fixtures still test accidental double-fork/
daemon behavior through the subreaper, and an escape/ambiguous result forces whole-container cleanup.

Container init remains necessary to reap anything outside a lane anchor and Docker replacement is the
ultimate stop boundary. The anchor improves normal stop/crash evidence; it does not turn one container
into a multi-tenant sandbox. Hot Node restart stays forbidden because control pipes and relay secrets
are intentionally non-adoptable.

Phase 0 must prove anchor feasibility in the final image: pidfd/subreaper availability, controller
SIGKILL/control EOF, main-child early exit, double-fork, TERM ignore, output flood, anchor crash, PID/
PGID churn and repeated stop. No signal may reach a marker-owned unrelated process. If the probe fails,
hosted provider launch remains disabled; Node PID fallback is not an accepted degraded mode.

### ADR-32: a recovery point is a quiesced, verified publication, not periodic file copying

Target-base `TeamBackupService` enumerates and copies files independently, uses a process-local mutex,
has distinct asynchronous and shutdown paths, treats several per-file errors as best effort, and may
restore selected files by validity/mtime. That is useful legacy safety-copy behavior, but it cannot
prove that SQLite, identity anchors, CLI JSON, task relationships, launch journals and provider files
represent one recoverable deployment state. Hosted must not label it a disaster-recovery backup.

The storage mechanics matter. SQLite documents that its Online Backup API creates a consistent
snapshot while a live source is being used. SQLite also explicitly warns that a raw database-file
copy during a transaction can mix old/new content and that a WAL is part of persistent database state:
separating it can lose committed transactions or corrupt the copy. A forced checkpoint is therefore
not a substitute for the supported backup API, and raw `cp` of the main file is forbidden while any
connection is open. Primary references:
[SQLite Online Backup API](https://sqlite.org/backup.html),
[SQLite corruption/backup guidance](https://sqlite.org/howtocorrupt.html), and
[SQLite WAL persistence](https://sqlite.org/wal.html#the_wal_file).

The pinned target base already uses `better-sqlite3 ^12.11.1` behind a single-request
`internal-storage` worker. Its official [`Database#backup()` API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#backupdestination-options---promise)
wraps the Online Backup API, permits normal source use and reports incremental progress, so v1 does
not add a second SQLite library. But the current worker entry calls synchronous `core.handle()` and
immediately posts its result, while the client has a generic 20-second timeout; returning the backup
Promise would not be a valid wire response. Phase 0 must add a typed async worker operation, await it
before accepting the next request, and give it a measured size/progress deadline whose progress
callback aborts cleanly. The probe runs against the final Node-ABI addon, not only Electron's build.
Current `wal_checkpoint(TRUNCATE)` on close and best-effort rename of corrupt `db/-wal/-shm` files are
shutdown/forensic behavior, not alternate backup implementations.

Three approaches were evaluated:

1. **Quiesced deployment recovery point plus SQLite Online Backup API - chosen.**
   🎯 9/10 🛡️ 9/10 🧠 9/10, approximately 2,500-4,500 changed lines including migration, crash
   tests and restore tooling. It is portable across the supported local-volume deployment and can
   prove a cross-store barrier without pretending cross-filesystem atomicity.
2. **Operator-coordinated filesystem/volume snapshot.** 🎯 7/10 🛡️ 9/10 🧠 8/10,
   approximately 1,500-3,000 application lines plus a deployment-specific snapshot contract. It may
   be a later adapter, but cannot be the only v1 mechanism because ordinary Docker/local-volume
   installations do not expose one common snapshot primitive for every configured root.
3. **Incremental per-file copy plus retry/hash manifest.** 🎯 3/10 🛡️ 4/10 🧠 5/10,
   approximately 1,000-2,000 changed lines. Rejected for disaster recovery: retries can detect some
   drift but cannot reconstruct an instant across uncoordinated writers or a live SQLite/WAL pair.

There are exactly two backup products with different promises:

- `coordination_backup`: an app-owned SQLite snapshot plus the identity anchors/coordination files
  required by the specific migration or repair. It may run while unrelated runtimes are active,
  contains no claim about concurrent CLI/provider collaboration files and is never offered as full
  deployment recovery;
- `deployment_recovery_point`: a quiesced, immutable bundle of the app-owned snapshot, identity
  anchors and all catalogued non-ephemeral CLI/provider files. This is the only input accepted by
  ADR-26 `replace_deployment`.

`BackupRun` is a durable application workflow, not another domain aggregate or generic storage API:

    requested -> fencing -> quiescing -> sqlite_snapshot -> file_stage
              -> verifying -> committed
    any non-committed state -> failed | operator_required

The coordinator owns only ordering/recovery. Feature-owned repositories contribute typed backup
participants with `prepare`, `flush`, `stage` and `verify` behavior; they do not expose raw roots or
write into one another's state. Before `sqlite_snapshot`, the coordinator:

1. closes new mutating admission and records a deployment-wide backup fence generation;
2. drains accepted commands to a durable terminal/recoverable point and flushes repositories,
   outbox/event journal, identity intents and lifecycle journals;
3. stops every relevant `uncoordinated_external` writer, or refuses the full recovery point if ADR-31
   cannot prove `drained`; cooperative/app-exclusive writers acknowledge the fence;
4. closes ADR-24 watcher watermarks/rescans and freezes each participant's source generation;
5. records the exact StateCompatibilityManifest, identity inventory and event/journal barrier used by
   the run. Read-only queries may continue, but no mutation readiness reopens until publication or
   abort cleanup releases the fence.

SQLite is copied through the selected internal-storage driver's supported Online Backup API into a
new staging directory. The implementation handles `SQLITE_BUSY` with a bounded timeout/backoff and
fails the run if concurrent writes prevent completion; it never falls back to copying `db`, `-wal`
or `-shm`. The completed snapshot is reopened independently and checked with the configured SQLite
integrity check, application/schema IDs, migration state and required table/identity invariants.
`VACUUM INTO` may be characterized as an alternate driver operation but is not assumed equivalent or
silently substituted.

File participants then stage immutable content under `BackupRunId`, using ADR-28 descriptor-bound
reads. Every manifest entry has logical owner/type, schema version, byte length, mode and SHA-256;
symlink, mountGeneration, inode/generation or size/hash drift after the frozen scan aborts the run.
No participant edits the current backup directory, prunes old files, follows an unknown link or
publishes partial output. Provider credentials, ADR-7 pairing challenges/device grants/sessions/hash
keys, CSRF/runtime tickets, sockets, PIDs, temporary files, rebuildable caches and raw secret-bearing
diagnostics are excluded or explicitly
terminalized/revoked in the staged SQLite copy;
restore requires fresh pairing plus provider credential revalidation/re-provisioning.
Post-v1 T1 adds terminal grants/history/stores to this exclusion catalog before enabling them.

The canonical manifest contains BackupRunId, DeploymentId, source StateCompatibilityManifest,
identity/tombstone inventory, WorkspaceId/registration keys without stale mount authority, participant
generations, command/event cursors, eventEpoch, file entries/exclusions and a canonical manifest hash.
After all entries and the SQLite snapshot are verified, the writer emits the root manifest and a
hash-bound ready marker last inside the private stage, fsyncs files/directories, then atomically renames
the whole run directory to its immutable committed name on the backup filesystem. Only after that
rename does the live workflow transaction become `committed`. A crash between rename and transaction
is recovered by verifying the marker/manifest and completing that one transition; a database row can
never make an unpublished stage restorable. Retention prunes only marker-plus-row committed runs after
a new point is committed and never touches active staging or the last known-good point.

The Online Backup API necessarily captures its own live BackupRun row before later file/publication
steps. The manifest names that exact source BackupRunId, and restore preflight converts only that
matching copied record to terminal `artifact_source` before normal workflow recovery; it must never
resume the source host's backup against the restore destination. Any other non-terminal command/saga
retains its ordinary ADR-23 recovery semantics. A mismatching/missing source record invalidates the
recovery point instead of being ignored.

That destination-only finalization transaction also marks every copied ADR-7 pairing challenge,
device grant and session revoked-for-restore and clears token/hash-key references, while preserving
OperatorId and non-secret audit history. The manifest hashes the finalized database, records the
sanitization schema/version and requires a fresh reset/pairing path after activation. This is an
explicit deterministic artifact transform after a consistent Online Backup API copy, not selective
raw-table copying or mutation of the live source.

Restore accepts only a committed v2 recovery point. It verifies the root manifest/hash, every entry,
SQLite integrity/schema, DeploymentId and uniqueness/checksum agreement before staging configured
roots. ADR-26's cross-root activation journal then activates a complete replacement into empty roots;
there is no per-file mtime merge, partial auto-restore or activation of a merely valid-looking config.
A crash before the final activation marker resumes/rolls back staging without pairing or mutation
readiness. After activation, boot/event/session/runtime credentials and mount generations rotate as
ADR-26 requires.

Existing backups are imported only as `legacy_unverified` diagnostic sources. They may support an
explicit offline salvage tool that copies user-selected data after schema/identity checks, but they
never auto-activate canonical hosted state or satisfy `replace_deployment`. The existing periodic
service remains temporarily named/documented as legacy safety copy until all call sites are migrated;
its async/sync disagreement, swallowed errors, config-readiness gate and mtime restore semantics are
CI-ratcheted out rather than wrapped as a new recovery contract.

### ADR-33: snapshot cursors are lower replay barriers; a later cursor may skip an event

The earlier plan said to build a stable projection and capture the latest event cursor afterwards.
That is incorrect: mutation/event `E` can commit after the projection read but before cursor capture.
The response would omit `E`, then subscribe after `E`, losing it permanently without a detectable
sequence gap.

There are two allowed algorithms:

1. If every projection row and its journal sequence are read from one SQLite snapshot transaction,
   return the cursor read inside that same transaction. SQLite WAL read transactions see an unchanged
   snapshot while later commits remain invisible, so those later events replay after its cursor. See
   [SQLite isolation](https://sqlite.org/isolation.html).
2. For any projection including external files, acquire the team projection coordinator, establish
   the ADR-24 watch-before-scan watermark, and capture retained cursor `C0` **before** reading files.
   Build and validate the stable projection, but return `C0`, never the latest cursor after the read.
   Events committed during/after projection are replayed from `C0`; duplicates are harmless because
   reducers fence by eventId plus resource revision/generation. If the external generation changes
   during the scan, the scan exceeds its deadline, or retention advances beyond `C0`, discard and
   retry/resync rather than moving the cursor forward.

This is deliberately at-least-once handoff: a replayed event may already be represented in the
snapshot, but no event can fall into a snapshot/cursor gap. Snapshot payloads contain a revision vector
per participating projection, not one invented global data revision. The client applies a replayed
event only when its aggregate generation/revision advances or when its event type is independently
idempotent; a same/lower revision is deduplicated, while a non-contiguous newer revision triggers a
refetch. External-file events use source generation/hash and fileWriterEpoch, not mtime.

The SSE `id` remains the opaque journal cursor. The browser's automatic reconnect sends the last
processed ID in `Last-Event-ID`, as specified by the
[WHATWG EventSource standard](https://html.spec.whatwg.org/multipage/server-sent-events.html#the-last-event-id-header),
but HTTP transport behavior alone does not create application consistency; the lower-barrier protocol
does. Cursor retention is pinned only for a short bounded snapshot lease. Slow construction returns
`snapshot_retry`/`resync_required` and releases the pin, preventing one client from blocking journal
retention indefinitely.

Capture/pin and retention pruning share one in-process `RetentionLeaseCoordinator`, valid because ADR-16
permits exactly one hosted journal writer. The coordinator prevents watermark advancement while C0 is
read and its bounded lease is registered; it never holds a database write lock for the whole snapshot.
For the same-transaction variant, it remains held through the SQLite read transaction and lease
registration. Leases are count/TTL bounded per session and intentionally non-durable: process restart
rotates connection state and requires a fresh snapshot rather than pretending an old pin survived.

Native EventSource cannot synthesize `Last-Event-ID` for its first connection. The snapshot response
therefore returns a short-lived, session/scope-bound `snapshotSubscriptionId`; initial SSE attach uses
that opaque non-bearer locator and the server resolves it to C0 without placing the cursor or authority
token in the URL. After the first delivered `id`, browser-managed reconnect uses `Last-Event-ID`.
The same session may reuse the locator until TTL after a pre-event network failure and receives the
same at-least-once replay; only one active attach per locator is allowed. Expired/wrong-session/scope
locators fail with `resync_required`. They authorize no data beyond the already authenticated session,
are count/rate bounded and are redacted from access logs.

Server attach is also durable-journal-first, never a query-then-listen race:

1. validate deployment/epoch/retention and register the coalescing wake-up listener **before** the
   initial journal query;
2. query committed rows strictly `> lastEmittedCursor` in bounded batches and flush them in sequence;
3. after every batch, re-read the durable high watermark until caught up; a wake-up only schedules
   another query and is never itself treated as an event;
4. heartbeat/timeout also queries from the last emitted cursor, so a coalesced/lost in-memory wake-up
   cannot hide a committed row;
5. unregister on close and return resync if retention overtakes the unread cursor.

This makes the journal row authoritative across response serialization, listener registration and
reconnect. There is at-least-once delivery across transport failure, never an in-memory-only live tail.

Phase 0 must model-check/chaos-test both algorithms by pausing at every boundary: before/after `C0`,
each SQLite/file read, watcher drain, projection validation, response serialization and SSE attach.
For every schedule, the reconstructed browser state must equal a fresh projection after replay. A
test that merely reconnects after an already complete snapshot is insufficient.

## Capability and parity matrix

Before implementation, every TeamsAPI, ReviewAPI, CrossTeamAPI method and every visible renderer
action must be classified. The checked-in manifest is regenerated/verified from the pinned base so
new methods cannot bypass the plan merely because the branch moved after this audit.

| Capability                            | Hosted v1                                                | Notes                                                                                            |
| ------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Pair/device/session/renew/logout      | Required                                                 | ADR-7 restart-safe production prerequisite; host reset recovery                                  |
| Workspace catalog                     | Required                                                 | opaque IDs only                                                                                  |
| List teams                            | Required                                                 | real data, no fake empty arrays                                                                  |
| Team snapshot/bootstrap               | Required                                                 | composed bundle of feature-owned projections plus revision vector; no second aggregate authority |
| Create draft/config                   | Required                                                 | idempotent                                                                                       |
| Prepare provisioning                  | Required                                                 | provider capability/preflight                                                                    |
| Launch/relaunch                       | Required                                                 | fake-runtime and provider matrix proof                                                           |
| Provisioning progress                 | Required                                                 | SSE and snapshot reconciliation                                                                  |
| Cancel provisioning                   | Required                                                 | owned run only                                                                                   |
| Runtime state/alive                   | Required                                                 | typed degraded states                                                                            |
| Stop team                             | Required                                                 | idempotent                                                                                       |
| Task create/read/update               | Required                                                 | revision plus ADR-29 direct/cooperative/provider-mediated/quiescent semantics                    |
| Kanban updates/order                  | Required                                                 | invariant-safe writes with ADR-29 writer admission                                               |
| Team messages/inbox                   | Required                                                 | durable, paginated, and classified separately from task-file writes                              |
| Provider delivery status              | Required for OpenCode                                    | explicit degraded state                                                                          |
| Failure diagnostics                   | Required                                                 | redacted diagnostic ID                                                                           |
| Team/member edits and recovery        | Required                                                 | add/replace/remove/restore/restart/skip with runtime policy                                      |
| Team delete/restore                   | Required                                                 | destructive auth/CSRF and confirmation                                                           |
| Identity integrity diagnostics/repair | Required for anchor rollout                              | explicit maintenance mode and OperatorId only; no ordinary mutation capability                   |
| Logs/activity                         | Required                                                 | paginated, bounded, redacted                                                                     |
| Review workflow                       | Required                                                 | no raw path leakage                                                                              |
| Tool approvals                        | Required                                                 | high-security surface                                                                            |
| Terminal workspace                    | Deferred post-v1                                         | capability absent in v1; ADR-10/35 retained for a separate terminal project                      |
| Attachments                           | Required where team UI exposes them                      | size/type/path limits                                                                            |
| Cross-team operations                 | Required only where included team screens depend on them | explicit capability                                                                              |
| Built-in editor                       | Desktop-only initially                                   | hidden in browser                                                                                |
| Updater/window controls/file chooser  | Desktop-only                                             | separate facets                                                                                  |

No blanket TeamListView Electron gate remains after the first vertical slice.
Each unsupported control uses its own capability.
The first vertical slice is a milestone; release waits for the required parity rows above.

### Detailed TeamsAPI parity inventory

This inventory is the release checklist snapshot from the audit.
Implementation may split or rename methods, but the user-visible semantics cannot disappear.
The audited interface contained 86 method names; every one is represented below, including event
subscriptions and the deliberate desktop/web notification split. ADR-19 turns this human-readable
snapshot into an immutable AST/signature baseline plus semantic traceability records; the table alone
is never accepted as conformance evidence.

| TeamsAPI group/methods                                                       | Hosted release status                                                 | Hosted implementation rule                                                                                                     |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| list, getData                                                                | Required                                                              | lifecycle list plus composition of feature-owned projections; legacy getData adapter cannot become the new aggregate authority |
| getTaskChangePresence                                                        | Required                                                              | bounded derived projection                                                                                                     |
| setChangePresenceTracking, setToolActivityTracking, setTaskLogStreamTracking | Required where corresponding UI is enabled                            | session-scoped subscriptions, not global flags                                                                                 |
| getClaudeLogs                                                                | Required, rename provider-neutrally later                             | bounded/redacted log query                                                                                                     |
| deleteTeam, restoreTeam, permanentlyDeleteTeam                               | Required                                                              | confirmation, CSRF, audit, backup policy                                                                                       |
| getSavedRequest, deleteDraft                                                 | Required                                                              | repository/use-case boundary                                                                                                   |
| prepareProvisioning                                                          | Required                                                              | provider capability/preflight facade                                                                                           |
| getWorktreeGitStatus, initializeGitRepository, createInitialGitCommit        | Required for launch UI                                                | registered workspace only; no raw path                                                                                         |
| createTeam, launchTeam                                                       | Required                                                              | idempotent application commands                                                                                                |
| getProvisioningStatus, cancelProvisioning                                    | Required                                                              | owned run, typed state                                                                                                         |
| getLaunchFailureDiagnostics                                                  | Required                                                              | safe diagnostic bundle/ID, no secret payload                                                                                   |
| sendMessage, getMessagesPage                                                 | Required                                                              | durable pagination and delivery semantics                                                                                      |
| getOpenCodeRuntimeDeliveryStatus                                             | Required                                                              | provider-specific adapter behind neutral contract                                                                              |
| getMemberActivityMeta                                                        | Required                                                              | revisioned snapshot                                                                                                            |
| createTask, getTask                                                          | Required                                                              | revisioned task application use cases                                                                                          |
| requestReview                                                                | Required                                                              | review workflow command                                                                                                        |
| updateKanban, updateKanbanColumnOrder                                        | Required                                                              | expected revision and invariant-safe write                                                                                     |
| updateTaskStatus, updateTaskOwner, updateTaskFields                          | Required                                                              | expected revision                                                                                                              |
| startTask, startTaskByUser                                                   | Required                                                              | provider/runtime-aware notification result                                                                                     |
| processSend                                                                  | Required                                                              | owned lead process only                                                                                                        |
| processAlive, aliveList, stop                                                | Required                                                              | idempotent lifecycle facade                                                                                                    |
| createConfig, updateConfig                                                   | Required                                                              | repository command, unknown-field preservation                                                                                 |
| getMemberLogs, getLogsForTask                                                | Required                                                              | bounded/redacted/provider-neutral DTO                                                                                          |
| getTaskActivity, getTaskActivityDetail                                       | Required                                                              | paginated/bounded                                                                                                              |
| getTaskLogStreamSummary, getTaskLogStream                                    | Required                                                              | explicit subscription and size policy                                                                                          |
| getTaskExactLogSummaries, getTaskExactLogDetail                              | Required                                                              | stable IDs/source generation checks                                                                                            |
| getMemberStats, getAllTasks                                                  | Required                                                              | bounded projections                                                                                                            |
| addMember, replaceMembers, removeMember, restoreMember, updateMemberRole     | Required                                                              | lifecycle and config transaction                                                                                               |
| addTaskComment, setTaskClarification                                         | Required                                                              | revision and structured task refs                                                                                              |
| getProjectBranch, setProjectBranchTracking                                   | Required where launch/review UI uses it                               | registered workspace adapter                                                                                                   |
| getAttachments                                                               | Required                                                              | authorized metadata/content boundary                                                                                           |
| killProcess                                                                  | Required for team-owned processes only                                | ProcessSupervisor ownership check                                                                                              |
| getLeadActivity, getLeadContext, getMemberSpawnStatuses, getTeamAgentRuntime | Required                                                              | runtime observability facade                                                                                                   |
| retryFailedOpenCodeSecondaryLanes                                            | Required when provider capability advertises it                       | typed provider command                                                                                                         |
| restartMember, skipMemberForLaunch                                           | Required                                                              | owned run/member checks                                                                                                        |
| softDeleteTask, restoreTask, getDeletedTasks                                 | Required                                                              | task repository transaction                                                                                                    |
| showMessageNotification                                                      | Desktop-only implementation; browser gets web notification capability | no fake no-op in shared team facet                                                                                             |
| addTaskRelationship, removeTaskRelationship                                  | Required                                                              | atomic symmetric invariants                                                                                                    |
| saveTaskAttachment, getTaskAttachment, deleteTaskAttachment                  | Required                                                              | quotas, MIME policy, authorized storage                                                                                        |
| onProjectBranchChange, onTeamChange, onProvisioningProgress                  | Required                                                              | typed SSE/event journal                                                                                                        |
| respondToToolApproval, onToolApprovalEvent                                   | Required                                                              | high-security command/event pair                                                                                               |
| validateCliArgs                                                              | Required for advanced launch UI                                       | server-side safe parser, no execution                                                                                          |
| updateToolApprovalSettings                                                   | Required                                                              | audited repository command                                                                                                     |
| readFileForToolApproval                                                      | Required as safe preview use case                                     | registered workspace, bounded/redacted content                                                                                 |

Before release, ADR-19 parity verification plus the runtime capability/action manifest must prove
that every row is implemented/replaced with semantic evidence or explicitly desktop-only. A visible
hosted control cannot depend on an unclassified method or a runtime route merely existing.

### Team-screen dependencies outside TeamsAPI

TeamsAPI parity alone does not make the current team screens operable. The renderer audit found
additional feature APIs in the same user flows. They must be mapped deliberately:

| Dependency                                          | Hosted rule                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| ReviewAPI getTaskChanges/getTeamTaskChangeSummaries | required application/read contracts for included review UI                                              |
| Review file watch/invalidation                      | server workspace watcher emits revisioned safe fileRef events; no host path in browser                  |
| CrossTeamAPI                                        | implement operations used by included composer/screens or capability-gate those controls                |
| Organizations assignment during create              | implement if organization selector is advertised; otherwise omit selector before submit                 |
| Provider/model/account status                       | replace installer-shaped browser APIs with server capability/catalog/auth-status projections            |
| Project path/folder selection                       | replace native chooser and raw paths with WorkspaceRegistry catalog selection                           |
| Task comment/file input getPathForFile              | browser File/Blob upload to agent-attachments; no local path extraction                                 |
| TerminalWorkspaceAPI                                | desktop IPC unchanged; absent from hosted v1 capability/UI, post-v1 contract reserved by ADR-10/35      |
| Browser notifications                               | optional web Notification capability with permission UX; never pretend OS notification succeeded        |
| Open external URL                                   | browser-safe allowlisted navigation, not Electron openExternal                                          |
| Editor/search/open-in-folder                        | desktop-only initially; attachment/review web UX cannot depend on them                                  |
| ProcessesSection raw PID control                    | opaque processRef/owned-process action plus safe URL projection; raw PID never crosses browser contract |
| Desktop review shortcut onCmdN                      | renderer-local keyboard handler when review facet is mounted                                            |
| Global editor/Codex/team subscriptions              | feature-owned mount/unmount registration; hosted bootstrap never initializes unavailable listeners      |

The release conformance inventory is therefore user-flow based, not interface-name based. For each
rendered team screen, enumerate all non-TeamsAPI calls as well as TeamsAPI calls. A method-complete
TeamsAPI with a broken workspace picker, provider selector, review reader, or attachment UX is not
parity.

The included review UI currently depends on the full ReviewAPI, whose desktop contract accepts raw
projectPath/filePath and sometimes sends original/modified file bodies back to main. Do not expose
that shape over hosted HTTP. Canonical hosted review contracts use:

- teamId/taskId/changeSetId/sourceGeneration;
- opaque fileId and hunkId/context hash;
- bounded content/preview pages;
- expected file content hash and expected review revision;
- idempotency key for apply/reject/save commands.

Server-side workspace/review adapters resolve paths and compute/apply hunks. The browser cannot
choose a host file path or claim arbitrary original content. getAgentChanges/getTaskChanges,
summaries/stats/content, conflict/preview, apply/reject/edit, decision persistence, file-change
events, and Git file history must each be implemented or the corresponding review control must be
removed from the hosted screen. External file changes advance sourceGeneration and invalidate stale
decisions; stale apply returns 409 with a refetch requirement, never a best-effort patch.

ReviewAPI release inventory:

| Current methods                                                             | Hosted rule                                                                             |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| getAgentChanges, getTaskChanges, getTeamTaskChangeSummaries, getChangeStats | bounded source-generation reads                                                         |
| invalidateTaskChangeSummaries                                               | server-derived invalidation; browser command only if still needed after event design    |
| getFileContent                                                              | opaque fileId plus bounded content/snippets, no raw path                                |
| applyDecisions, rejectHunks, rejectFile, previewReject, saveEditedFile      | expected source generation/hash, server-side path/hunk resolution, idempotent mutations |
| checkConflict                                                               | replace raw path contract with fileId + expected content hash                           |
| watchFiles, unwatchFiles, onExternalFileChange                              | session-scoped review subscription over canonical SSE; no global watcher flags          |
| loadDecisions, saveDecisions, clearDecisions                                | revisioned server repository keyed by team/task/changeSet/source generation             |
| getGitFileLog                                                               | workspace-scoped bounded Git projection by fileId                                       |
| onCmdN                                                                      | desktop shortcut adapter only; hosted keyboard navigation is renderer-local             |

CrossTeamAPI `send`, `listTargets`, and `getOutbox` are required only when the cross-team composer
capability is enabled. If deferred, the composer omits cross-team targets and pending-cross-team
surfaces; it must not call a stub that returns an empty target list.

## Data ownership catalog required before writes

Create a checked-in catalog with, for every persisted file:

- path pattern;
- owning system;
- authoritative versus derived status;
- schema/version;
- maximum supported size;
- locking model;
- ADR-29 writerCoordination class by provider/version/operation and evidence that makes a writer active;
- atomicity model;
- unknown-field preservation policy;
- corruption/recovery policy;
- backup requirement;
- secret/redaction classification.

Minimum categories:

| Category                            | Examples                                                                            | Initial policy                                                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| CLI-owned team data                 | config.json, tasks/_.json, inboxes/_.json                                           | preserve layout and unknown fields                                                                                       |
| Team identity anchor                | team.identity.json + committed SQLite identity row/checksum                         | replicated write-once identity; file is portable anchor, row is local admission/integrity authority, disagreement blocks |
| Legacy directory identity           | immutable LegacyTeamKey reservation/tombstone across team/tasks/backups             | creation/adoption adapter evidence only; never browser authorization or display identity, no v1 key reuse                |
| Team roster identity                | app-owned TeamRoster/MemberId/memberRevision registry plus legacy name evidence     | browser/domain authority; config/members.meta/inbox/log names are compatibility projections, ambiguity blocks mutation   |
| Legacy backup correlation           | backup manifest/registry identityId and config.json \_backupIdentityId              | migration evidence only; never TeamId or authorization, preserved/mapped as ADR-32 `legacy_unverified` then retired      |
| App-owned launch/draft metadata     | team.meta.json, members.meta.json                                                   | explicit version/migrations; never identity authority                                                                    |
| Launch/runtime state                | launch-state, bootstrap state/journal                                               | recovery-blocking when corrupt                                                                                           |
| OpenCode runtime evidence           | versioned stores/manifests                                                          | reuse mature manifest principles                                                                                         |
| JSONL transcripts                   | projects and agent logs                                                             | read-only/append semantics, bounded parsing                                                                              |
| Derived caches                      | list/snapshot/search caches                                                         | rebuildable                                                                                                              |
| Deployment/workspace/team identity  | new app-owned versioned registry                                                    | stable IDs, migration and tombstones                                                                                     |
| Workspace mount binding             | app-owned boot-scoped mountGeneration/fingerprint/health                            | current operation authority only; never stable WorkspaceId identity or restored as current                               |
| Event/idempotency/command state     | new app-owned journal/store plus CommandFingerprintKeyring                          | versioned normalized-intent HMAC, bounded retention, key-preserving recovery and crash recovery                          |
| External observation fencing        | app-owned fileWriterEpoch, watcher watermark, actor classification                  | never written into CLI JSON; closes cross-run attribution/relaunch races                                                 |
| Approval policy/audit/deletion saga | new app-owned security state                                                        | durable, versioned, fail-closed                                                                                          |
| Pairing/device/session auth         | keyed hashes/expiry/revocation in app SQLite; plaintext cookies/controller memory   | excluded/revoked on restore; ordinary restart preserves valid grants/sessions                                            |
| CSRF/session transient values       | derived or short-lived server/controller memory                                     | never backed up; restart/rotation invalidates                                                                            |
| Post-v1 terminal state families     | absent in v1; T1 adds access/ownership audit, operational history and local sockets | separately versioned, migration/readiness gated and excluded from v1 compatibility/backup manifests                      |

Verified write hazards that the catalog and repositories must address:

- ConfigManager.persistConfig is fire-and-forget. Multiple atomic writes can complete out of order
  and persist an older in-memory snapshot after a newer one.
- TeamTaskWriter uses only an in-process promise lock. External CLI/runtime writers and a second
  Node process are not excluded.
- TeamKanbanManager performs unlocked read-modify-write for task state, column order, and garbage
  collection. Concurrent browser/event cleanup mutations can overwrite each other today.
- config.json has multiple direct write paths across TeamConfigReader, TeamDataService,
  TeamTranscriptProjectResolver, provisioning maintenance/restart flows, and backup restore. A new
  HTTP repository beside them would not create a single authority.
- task relationship updates lock two paths in-process but perform two independent renames. A crash
  can leave blockedBy/blocks or related edges asymmetric.
- TeamInboxWriter combines a cross-process lock file with an in-process lock and post-write verify,
  but lock expiry/PID reuse/filesystem semantics still need an explicit deployment policy.
- atomicWriteAsync fsyncs the temporary file only best-effort and does not fsync the parent
  directory. It provides replacement atomicity on supported local filesystems, not a durable
  multi-file transaction.
- TeamLaunchStateStore writes launch-state.json and its summary projection sequentially, catches
  write failures without propagating them, silently returns on a missing-team-directory race, and
  clears both files best-effort. Callers can observe success while authoritative/derived launch
  files disagree or remain stale.
- TeamProvisioningLaunchStateStoreBoundary serializes only inside one process. Its in-memory
  writtenRunId guard is lost on restart and does not coordinate another writer.
- team.meta.json and members.meta.json normalize known fields and rewrite complete documents;
  their unknown-field and future-version behavior must be intentional before hosted writes, and
  neither may carry TeamId or other write-once authority.
- TeamBackupService writes `_backupIdentityId` into CLI-owned config.json best-effort, keys registry/
  manifests by teamName, may rotate identityId during resurrection, and marks permanent deletion only
  after the team directory is removed. Canonical identity publication must not reuse these semantics
  or race the current async/sync backup paths.
- TeamBackupService currently skips a team until config.json is valid. Canonical identity and durable
  draft backup cannot inherit that gate because a legitimate pre-provisioning draft has no provider-
  ready config yet.
- TeamBackupService enumerates/copies/prunes independent files and can continue after per-file errors;
  its process-local mutex does not fence provider/CLI writers, its shutdown path is a separate sync
  implementation, and partial restore chooses files by validity/mtime. ADR-32 treats this output as
  `legacy_unverified`, not a consistent recovery point, and removes automatic partial activation from
  hosted mode.

Required initial write model:

1. Enforce one hosted controller writer process per runtime root with an instance lease held for
   process life; provider/CLI external writers are handled through compatibility reconciliation.
2. Serialize each aggregate through a per-team coordinator; ConfigManager uses a monotonic queued
   writer and exposes flush()/failure state for readiness and shutdown.
3. Use expectedRevision for HTTP writes and re-read under the coordinator before mutation.
4. Preserve unknown fields for CLI-owned documents by patching the parsed raw object, not by
   serializing a narrowed DTO.
5. For multi-file invariants, write an intent journal with operationId, before/after checksums, and
   recovery status; replay or compensate idempotently after restart.
6. Define supported filesystems. If advisory/exclusive lock and atomic rename guarantees cannot be
   established (for example some network volumes), readiness is false or hosted writes are
   read-only.
7. On successful atomic replacement, fsync file and parent directory where supported. Classify
   unsupported durability as an explicit degraded capability, not silent success.
8. Watcher reconciliation must ignore known self-write operation IDs without dropping external
   writes that race immediately after them.
9. Repository writes return a durable outcome or typed degraded/failure result. Critical state
   stores may not log-and-swallow persistence failure; readiness and command status expose it.
10. Treat launch-state as authoritative only for its catalogued provider execution/bootstrap facts
    and summary as derived. Accepted LifecycleRun/plan/currentRunRef remain internal-storage authority.
    Journal/checksum the legacy projection or rebuild it after crash rather than pretending two
    renames are atomic or letting it select a newer run.
11. Enforce ADR-29 before write. `app_exclusive` uses bounded compare/hash/write/post-read verification;
    `cooperative_external` uses only its proven shared protocol; `uncoordinated_external` direct
    mutation requires durable writer quiescence or remains read-only/provider-mediated. Post-read
    verification and watcher events may detect a conflict but are never described as preventing or
    recovering an already overwritten external update.
12. Implement ADR-32 backup participants only over catalogued ownership boundaries. No generic
    recursive root copier may infer authority, consistency, inclusion or restore precedence from a
    pathname, mtime or parse success.
13. Route every app-owned config.json mutation through one repository/coordinator, including
    provisioning, language, project binding, member lifecycle, transcript repair, and restore. Add
    an architecture/search gate against new direct config writes outside that adapter.

### Mutation commit protocol

SQLite and CLI-owned files cannot share a real transaction. The plan therefore uses one explicit
recoverable protocol instead of implying that `UnitOfWork` makes them atomic:

1. Resolve the ADR-34 CommandDescriptor, build its versioned normalized intent fingerprint and claim
   `(deploymentId, stableActorId, commandKind, idempotencyKey)` in internal-storage with `prepared`
   status. SessionId is recorded for audit but is not the actor identity: logout/
   re-login must still find an ambiguous command instead of launching it twice.
2. Under the owning feature's keyed coordinator, re-read authoritative files/evidence and verify
   expected revision/run generation/workspace authorization.
3. Persist an operation intent containing only safe IDs, target revisions, before-checksums and the
   ordered ADR-34 EffectDescriptors/states, then transition to `running`; each step records
   `attempting` immediately before its first externally visible effect.
4. Resolve ADR-29 writerCoordination for every touched file against the current provider/run state.
   Refuse the direct effect unless writers are app-exclusive, demonstrably cooperative, or durably
   quiesced; a provider-mediated workflow leaves this immediate-command protocol before file effect.
5. Apply the minimum admitted legacy-file mutations through the existing compatibility writers,
   preserving unknown fields and required provider/CLI semantics.
6. Re-read and verify the intended invariant. A partial multi-file result remains `recovering`, not
   successful.
7. In one internal-storage transaction, advance the feature revision, mark the command committed,
   record recovery completion, and append the bounded outbox event.
8. Publish the outbox event to live SSE after commit. Delivery may repeat; consumers deduplicate by
   eventId/revision.
9. On startup, recover `prepared`/`recovering` operations before mutation readiness. Replay only when
   checksums/generation still match; otherwise compensate or surface a typed operator-required state.

Steps 3-6 above are for bounded mutations whose intended invariant is complete within the command.
Workflow-starting commands such as LaunchTeam, StopTeam, permanent delete and some member recovery use
a stricter acceptance/execution split:

1. Claim/validate the browser command and compute the immutable workflow input without external effect.
2. In one internal-storage transaction mark the command `committed` with typed `accepted` outcome,
   create the LifecycleRun/saga plus initial workflow state, persist immutable plan where applicable,
   advance currentRunRef/generation and append the acceptance outbox event.
3. Return `202` plus stable commandId and workflowRef. The durable workflow runner claims pending work
   with lease fencing; before each filesystem/process/provider effect it uses the normal operation
   intent/recovery protocol and ADR-22 spawn protocol.
4. Workflow progress/terminal failure is recorded on LifecycleRun/saga and emitted separately. It
   never changes the already committed acceptance command to failed and never causes retry of the
   original key to create another workflow.

Thus command `committed` means the application decision and stable workflow identity are durable; it
does not mean a provider is ready, a stop completed, or deletion finished. Command-status responses
include the workflowRef/current workflow summary when present. Renderer success copy distinguishes
accepted/in progress from completed, and waits on canonical workflow projection/events rather than an
HTTP request kept open through provisioning.

The allowed immediate-command state machine is:

    prepared -> running -> committed
         |         |          |
         |         +------> recovering -> committed
         |                         |----> failed
         |                         `----> operator_required
         `------------------------------> failed

A workflow-starting command may transition `prepared -> committed(accepted)` in its single acceptance
transaction because no external effect precedes that commit; later work belongs to the referenced
workflow state machine, not the command record.

`failed` is terminal only when the coordinator proves no external effect occurred or a compensation
was verified. Any ambiguous effect remains `recovering` or `operator_required`; it is never flattened
to a retryable 500. The command record retains safe typed outcome/error, attempts, last transition,
recovery owner and next diagnostic action. Claim/recovery ownership records the ADR-16 leaseId/boot
generation and can advance only while `InstanceLeaseGuard` proves its inherited descriptor is open.
There is no supported state in which a still-running controller releases and reacquires the lease.

The command status endpoint returns prepared/running/committed/recovering/failed/operator_required
for timed-out clients. Retrying the same key/ADR-34 fingerprint returns the same status/outcome; same
key with a different normalized intent is an `idempotency_mismatch`. A response is never success merely
because file writes were scheduled.
Retention cannot delete a non-terminal command, its intent, or referenced outbox row. Terminal
records are removed only by a bounded transactional compactor after their retry window and audit/
recovery retention expire.

Browser mutation keys follow ADR-27 receipt-before-send recovery across timeout, reload and re-login;
the sensitive request body is never persisted for automatic replay. Runtime ingress uses a separate scope
`(runId, laneId, credentialGeneration, verb, commandId/sequence)`; a browser key and machine key can
never collide or authorize each other's command. The single-operator deployment has one durable
OperatorId created with deployment identity. Pairing creates sessions for that actor; it does not
create a new actor on every login.

External CLI/agent writes use the inverse path: watcher obtains a stable parsed projection, validates
the owning feature invariant, records a new external revision plus outbox event transactionally, and
then publishes. Self-write suppression is keyed by operationId + verified resulting checksum, not a
time window, so a separately observed racing external write is not mistaken for the app's own event.
This is observation correctness, not proof that an uncoordinated writer's already-overwritten bytes
can be recovered; ADR-29 prevents admitting that unsafe concurrency in the first place.

### ADR-34: command identity and effect recovery are versioned contracts

The phrases `request hash`, `replay idempotently` and `compensate` are not implementation permission.
Without a stable fingerprint and effect-specific proof, a release can reinterpret the same key or
repeat an external effect after crashing between the effect and its journal update. Hosted promises
at-most-once command acceptance plus evidence-driven workflow convergence; it does not claim magical
exactly-once delivery to uncooperative files, CLIs or providers.

Primary design evidence is consistent: the IETF Idempotency-Key draft treats a server-generated
request fingerprint as part of key uniqueness; AWS rejects the same client token with different
parameters and recommends labeling created resources with the request identifier; compensations are
domain-specific workflows that can themselves fail and must be resumable/idempotent. References:
[IETF Idempotency-Key draft](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header-07),
[AWS EC2 idempotency](https://docs.aws.amazon.com/ec2/latest/devguide/ec2-api-idempotency.html),
[AWS safe retries](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/),
and
[Azure compensating transaction pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction).

Every mutation has a checked-in `CommandDescriptor` owned by its feature:

    commandKind + inputSchemaVersion + fingerprintVersion
    + idempotencyScope + retentionClass
    + normalizedIntentProjection + ordered EffectDescriptor[]

Fingerprint rules are fixed:

1. Authenticate, authorize, bound and validate the exact command schema before claiming a key.
   Mutation schemas reject unknown intent fields. Transport metadata, cookie/session/request IDs and
   object key order never affect identity; every semantically relevant client choice and materialized
   default does. Locale/model/provider policy belongs in the fingerprint only when it changes intent.
2. The feature builds an explicit typed `normalizedIntentProjection`; infrastructure never hashes raw
   JSON. Opaque IDs, expected revisions/generations and attachment/content digests are included, while
   server-derived current state is persisted separately as acceptance preconditions/evidence.
3. A deterministic length-delimited encoder and keyed HMAC produce the stored fingerprint. The record
   contains descriptor/schema/fingerprint/key versions and digest, never the prompt, message, path,
   secret or complete command body. Golden vectors cover field order, omitted-vs-default, Unicode,
   integer bounds, arrays and every schema migration.
4. Algorithms and fingerprint key versions remain readable/computable for at least the longest
   idempotency retention window. ADR-23 blocks a binary that cannot compare a retained record; it may
   not recompute old commands with the newest algorithm or prune them to make startup pass.
   `CommandFingerprintKeyring` is a separate app-owned integrity secret, not an ADR-7 auth/session
   key: rotation adds a new active version while retaining referenced old keys, verified ADR-32/26
   replacement preserves it with command records, and missing/corrupt material closes mutation rather
   than treating every retry as new. Host auth reset does not rotate or delete it.
5. The unique claim scope is `(DeploymentId, stableActorId, commandKind, idempotencyKey)`. The same key
   and fingerprint returns the durable command/workflow outcome; the same key with another descriptor,
   schema or fingerprint returns typed `idempotency_mismatch` and creates no command/effect. Concurrent
   identical claims converge through one database uniqueness constraint.
6. Auth/schema/readiness rejection before claim consumes no key. Once a row is claimed, every
   no-effect business rejection or later outcome is durable; changing intent requires a new key.

Each external step has exactly one recovery class, frozen in its `EffectDescriptor` and persisted on
the operation intent:

| Recovery class                    | Required proof before automatic retry/commit                                                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transactional_local`             | effect and command/outbox commit share one internal-storage transaction                                                                                                      |
| `idempotent_by_operation_id`      | adapter/provider durably deduplicates the same operationId and exposes semantically equivalent lookup/result                                                                 |
| `reconcilable_by_unique_evidence` | immutable or exclusivity-protected evidence ties the desired outcome to this operationId/exact before-after generation; mere current-state equality or mtime is insufficient |
| `compensatable`                   | feature-owned inverse command, preconditions and evidence are persisted; compensation is itself idempotent/reconcilable and cannot overwrite newer external work             |
| `non_reconcilable`                | no automatic retry after an attempt may have crossed the boundary; recovery becomes `operator_required` with safe diagnostics                                                |

The durable effect state is
`not_started -> attempting -> observed_succeeded | observed_absent | ambiguous`, with separate
`compensating -> compensated | ambiguous`. The coordinator writes `attempting` before crossing the
boundary. A crash/timeout from `attempting` may retry only after the declared class's lookup proves
deduplication or absence; otherwise it remains ambiguous. A checksum that merely matches desired bytes
does not prove which writer produced them. A compensation never means restore an old snapshot over
concurrent work and is never selected by generic infrastructure.

Examples are explicit: an app-exclusive atomic JSON replacement may be reconcilable by operation-bound
before/after checksum plus ADR-16/29 exclusivity; an active uncoordinated provider file write is not;
a provider launch is retryable only through its persisted RunId/spawnNonce/provider idempotency and
ADR-22 evidence, never because no PID was observed; a message/task delivery requires a durable
provider acknowledgement or unique observable envelope marker, otherwise it is operator-required.

Fault injection pauses before/after `attempting`, external call/rename/spawn/ack, evidence query,
command commit, compensation and event publication. Negative fixtures return stale or coincidentally
equal state, reuse an operationId with changed intent and lose the first response. The gate proves no
automatic path can produce a second run/message/task/file effect or call `committed` without its
descriptor-required evidence.

### External-writer observation algorithm

Filesystem notifications are lossy hints, never the mutation log and never domain events by
themselves. One shared infrastructure scheduler handles bounded observation mechanics; owning
features provide file-pattern registration, parser, authority classification and reconciliation
command. It does not become a generic repository or interpret feature entities.

For each explicitly catalogued path key:

1. Startup performs a bounded inventory scan after lease/recovery and before mutation readiness.
   Watch registration happens before the scan barrier, then queued notifications are drained, so a
   write between scan and watch cannot disappear.
2. Native watch/rename events receive a monotonic observation sequence and enqueue one coalesced
   observation by TeamId/registered file identity plus the earliest/latest covered sequence. They do
   not capture currentRunRef. Queue length, attempts and bytes are bounded; overflow marks the affected
   feature dirty and schedules a scoped rescan rather than dropping silently.
3. Stable read performs lstat/stat, size/type/containment checks, bounded byte read, then stat again.
   Device/inode/size/mtime identity must remain compatible and the content checksum is authoritative.
   A changing file retries with jitter up to a deadline; partially written JSON never advances state.
4. Apparent deletion is confirmed by a parent-directory rescan after the atomic-replace debounce and
   checked against in-flight self-write intents. Only the owning feature decides whether absence is
   deletion, optional empty state, replacement, corruption or a blocked invariant.
5. The feature parser validates schema/version and returns a complete projection plus source
   fingerprint. Corruption keeps the last valid read projection visible, records a bounded
   diagnostic and disables only mutations whose invariant depends on that artifact.
6. Under the feature coordinator, compare the fingerprint with stored observation/self-write
   evidence and classify ADR-24 ExternalFileActor versus provider-verified run evidence. A real change
   transactionally records source generation, observation sequence/fileWriterEpoch, actor kind,
   feature revision and the durable event row. A semantic no-op updates observation health without
   emitting entity churn.
7. Periodic bounded scoped scans repair missed native events. They are adaptive and never recursively
   poll all of CLAUDE_ROOT or workspace contents; only manifest/catalog paths and active subscriptions
   are eligible.

Watchers stop admission before shutdown, drain observation work to a deadline, persist dirty scopes
for startup rescan, and never claim clean readiness while a critical scope is overflowed, repeatedly
unstable or corrupt. Metrics expose counts/latency/retry/dirty reasons without filenames, paths or
payloads. Tests cover atomic rename, truncate-then-write, delete/recreate, same-mtime content change,
notification loss, overflow, repeated corruption, self-write followed immediately by external write,
and shutdown/restart with queued observations.
The ADR-24 relaunch/deletion quiescence barrier uses this same sequence/watermark API; it is not a
second watcher or a sleep-based quiet-period heuristic.

## Consumer-owned port catalog

Ports are introduced by the application consumer, beside the use case that needs them. The names
below are boundary responsibilities, not mandatory one-interface-per-bullet files. Cohesive methods
stay together when they share atomicity, security and failure semantics.

| Owner                  | Minimum boundary                                                                                                                                                                                                           | Initial implementation/reuse                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hosted-access`        | challenge/device/session atomic repository, auth keyring, cookie/CSRF policy, PUBLIC_ORIGIN facts and v1 runtime residual drain evidence                                                                                   | new app-owned SQLite tables plus narrow key/challenge filesystem adapter and Fastify input/output adapters                                                 |
| `team-lifecycle`       | lifecycle/TeamRoster state compare-and-commit, team/member config compatibility, runtime-control client, after-commit event sink                                                                                           | Electron compatibility adapter over TeamDataService; hosted context-bound repositories reusing pure parsers plus split provisioning/launch-state contracts |
| `team-runtime-control` | provider capability source, immutable roster-bound lane planner input, owned process supervisor, runtime evidence store, binary/credential resolver, lane/run ingress credential store and machine event/delivery boundary | runtime-provider-management facade, team-runtime-lanes, existing TeamRuntimeAdapterRegistry, runtime-control service and provisioning runtime modules      |
| `workspace-registry`   | stable registration repository, boot mount-binding probe, operation-scoped current-generation grant authorizer                                                                                                             | app-owned internal-storage tables plus Node realpath/stat/mount adapter                                                                                    |
| `team-task-board`      | task document repository and aggregate mutation coordinator                                                                                                                                                                | compatibility adapters over TeamDataService/task writers/Kanban manager                                                                                    |
| `team-messaging`       | message-page source, append/delivery gateway, delivery status source                                                                                                                                                       | inbox writer/readers and existing runtime delivery APIs                                                                                                    |
| `team-review`          | bounded review source/apply gateway and review subscription source                                                                                                                                                         | current review services plus agent-attachments where applicable                                                                                            |
| `team-approvals`       | compare-and-claim approval repository, runtime answer gateway, audit sink                                                                                                                                                  | internal-storage coordination state plus runtime-control adapter                                                                                           |
| `terminal-workspace`   | post-v1 T1 authorized terminal session gateway; no v1 boundary or adapter                                                                                                                                                  | existing terminal-platform feature/gateway after independent hardening                                                                                     |
| hosted app composition | validated public-origin/proxy/socket facts, route admission and lifecycle component registry                                                                                                                               | explicit hosted-access/security/feature factories; no auth repository transitions                                                                          |

`RuntimeInstanceContext` is an immutable value passed at composition time, not a port. Clock,
IdGenerator and cancellation are small structural dependencies used only where determinism is
needed; they do not require a global platform package.

The owned process supervisor contract requires:

- implement ADR-22 prepare-spawn/capture-identity/verify-handshake/commit-or-classify protocol rather
  than inserting a PID into memory after spawn;
- spawn takes a resolved binary identity, argv array, registered cwd, explicit environment allowlist,
  current WorkspaceAccessGrant/mountGeneration, owner teamId/runId/memberId, resource policy, and
  cancellation signal;
- never pass browser text through a shell command string;
- return a random opaque processRef backed by the durable ProcessOwnershipRecord, never an encoded PID;
- own stdout/stderr truncation, redaction, backpressure, and diagnostic correlation;
- own process-group/job-object termination with TERM/grace/KILL and bounded waits;
- distinguish adopted verified processes from merely observed PIDs; never kill an unverified one;
- expose readiness/degraded/resource state without leaking host commands or environment values.

Do not introduce:

- a global FileSystemPort exposing generic read/write/list/watch;
- a universal TeamRepository or UnitOfWork spanning lifecycle, tasks, messages and approvals;
- RuntimeEnvironment/Platform/Manager facades that simply mirror Node APIs;
- a generic event bus used as hidden synchronous control flow;
- interfaces for pure functions or one stable implementation with no isolation/security value.

Filesystem and Git operations remain narrow adapter details such as canonicalizeWorkspace,
compareAndCommitTaskDocuments, appendInboxMessage, or loadReviewFile. The app-owned internal-storage
backend may share one SQLite transaction internally, but each feature sees only its own repository
contract. After-commit event publication uses an explicit outbox/event-journal boundary, not an
untyped DomainEventBus.

## HTTP contract rules

### Standard response/error behavior

- One namespaced error envelope.
- No raw Error.message for 5xx responses.
- Error response contains safe code, safe message, retryable flag, and diagnosticId.
- Server logs may include a redacted correlated cause.
- Every request receives requestId.
- Hosted routes never serialize the desktop AppConfig wholesale. Use explicit browser-safe settings
  projections; redact roots, CLI paths, SSH profiles, credentials, internal ports, and secret refs.
- Cache-Control is no-store for auth, capabilities that include auth state, diagnostics, approvals,
  settings, and mutation responses unless a safer explicit policy is proven.

Status mapping is consistent: 400 malformed/validation, 401 missing/expired session, 403
authorization/CSRF/origin/policy, 404 non-visible resource, 409 revision/idempotency/lifecycle
conflict, 413 size limit, 422 valid request that fails provider/workspace preflight, 429 admission or
rate limit with Retry-After, 503 unavailable dependency/read-only mode, and 500 only with a safe
diagnosticId. Do not mix 200 `{ success: false }`, thrown raw strings, and transport-specific errors.

### Browser and runtime-ingress separation

- Browser cookies authorize `/api/hosted/v1` and explicitly allowlisted legacy non-team browser
  routes; they never authorize `/api/runtime/v1`. Post-v1 terminal grants remain separately scoped.
- Lane/run-scoped runtime credentials authorize only their bound `/api/runtime/v1/runs/:runId/*`
  verbs and member/lane identity; they never authorize
  browser queries, approvals, terminal, workspace administration, or arbitrary team mutation.
- Runtime routes have provider/event-specific body limits, token/run/lane rate limits, current-run
  fencing and persistent replay protection before parsing expensive payload sections.
- Legacy `/api/teams/:teamName/opencode/runtime/*` stays loopback-only during compatibility and is
  removed before remote hosted mutation capability is advertised.
- Browser capability manifests and generated clients do not contain runtime ingress routes.
- Runtime acknowledgements contain only accepted/duplicate/conflict state plus safe opaque IDs; no
  workspace path, server state snapshot or credential material.

### Mutation safety

- Launch accepts an idempotency key.
- Create draft/config accepts an idempotency key.
- Stop is idempotent.
- Every retryable/destructive mutation defines an ADR-34 descriptor, scope, retention window,
  versioned normalized-intent HMAC, effect recovery classes and conflict behavior. Reusing a key with
  different normalized intent is `409 idempotency_mismatch`.
- Accepted long-running commands return 202 with commandId plus workflowRef (runId/sagaId) and a
  status link. A client timeout
  is ambiguous until that status is queried; the UI must not infer failure and issue a new launch.
- Browser disconnect does not cancel an accepted command. Cancellation is a separate authorized,
  generation-scoped command.
- Task and Kanban mutations use expected revision or If-Match.
- Stale mutation returns 409 stale_revision with current revision metadata.
- Request IDs, idempotency keys, IDs, and strings are length-bounded.

### Resource limits

- aggregate/header count, Cookie bytes/count and exact authority-cookie value length/duplication;
- JSON body size;
- attachment size/type;
- pagination bounds;
- request timeout/cancellation;
- provider probe timeout;
- process output cap;
- SSE backlog cap;
- per-session HTTP concurrency, SSE connection/subscription and watcher quotas.

## Realtime model

### Event envelope

Every event includes:

- eventId;
- opaque eventCursor assigned by the journal;
- scope kind and scopeId (instance/catalog, workspace, team, run, or session);
- teamId/workspaceId/runId when applicable;
- safe actor kind/reference (`operator`, `verified_runtime`, `external_file`, `recovery`), with runId/
  memberId present only when attribution is proven;
- fileWriterEpoch/observation sequence for accepted external-file mutations where relevant;
- event type;
- team/snapshot revision;
- emittedAt;
- payload;
- schemaVersion.

Keep resource dataRevision and journal eventSequence distinct. Durable snapshot mutations advance
dataRevision; ephemeral runtime/tool/log observations may advance eventSequence without changing
dataRevision. Ordering never depends on emittedAt or filesystem mtime.

The public cursor is an opaque encoding of `(deploymentId, eventEpoch, eventSequence)`, not a bare
integer for clients to increment. `eventEpoch` is durable and rotates only when the journal is
intentionally reset/restored without continuous history. A cursor from another deployment/epoch,
ahead of the journal, malformed, or below retention returns `resync_required`; it never silently
starts at now. `bootId` remains a process/session freshness fence but is not substituted for durable
journal epoch. SSE `id` equals the opaque cursor and eventId remains the delivery-deduplication ID.

### Event delivery

- one deployment/epoch monotonic event sequence for the authenticated session stream;
- resource-scoped revisions for team/workspace/catalog snapshots;
- bounded replay journal;
- SSE id field;
- Last-Event-ID support;
- session-bound snapshotSubscriptionId for initial native EventSource attach; no bearer/cursor query;
- Last-Event-ID for automatic reconnect, with explicit cursor query allowed only for a characterized
  non-native/fallback client and redacted from logs;
- heartbeat;
- slow-consumer disconnect policy;
- resync_required event when a cursor falls behind retained history.
- sequence assignment occurs in one event-journal coordinator after a durable application mutation
  commits or after a validated external projection is accepted;
- event payloads are bounded. Large logs/diffs/attachments are fetched by opaque reference rather
  than placed on SSE;
- journal retention is bounded by age and bytes, and the current earliest/latest cursor is exposed
  in diagnostics/metrics without leaking event payloads.

The transactional outbox event and replay-journal event are one durable row, not two asynchronously
copied sources of truth. The committing transaction assigns eventId/epoch/sequence and writes the
bounded payload/reference. Post-commit live fanout is only a wake-up/low-latency delivery step; a
fanout failure does not roll back the command or require a second event write. SSE replay reads
committed journal rows from the requested cursor, so crash after commit but before live fanout is
recovered naturally on reconnect. Subscribers never see prepared/uncommitted rows.

Retention advances one explicit watermark transactionally and never deletes a row referenced by a
non-terminal command/recovery saga. Slow/offline clients below the watermark receive
resync_required. High-volume logs/tool output emit bounded durable invalidation/reference events;
the content itself remains in its bounded source and is not copied into SQLite/SSE merely to preserve
one cursor.

The browser uses one authenticated session SSE stream for catalog, workspace, team, run, and
approval events, so one Last-Event-ID can replay cross-scope ordering. High-volume tool/log/activity
payloads are enabled by a server-side session subscription lease for the currently visible teams;
the stream still emits bounded structural invalidations when detailed tracking is off. Subscription
state is re-established after login/reconnect and expires automatically. Do not return to the
current module-global client set or global tracking flags shared by all sessions.

Target-base generic `/api/events` may remain temporarily only for explicitly allowlisted non-team
standalone UI events under browser session auth. Team/review/approval/runtime facets never subscribe
to it, and canonical team events are never broadcast into its unscoped channel/data protocol. The
route ledger must show zero hosted team dependence before release.

### Reconciliation

Agents and provider runtimes can modify JSON outside HTTP use cases.
Therefore events come from both:

1. application use cases;
2. filesystem watcher reconciliation.

Client strategy:

1. fetch a stable snapshot containing its resource revision vector and ADR-33 lower eventCursor
   barrier;
2. subscribe from that eventCursor;
3. apply deduplicated events;
4. refetch on gaps or resync_required;
5. remain correct after duplicate delivery and reconnect.

The snapshot builder follows ADR-33. A SQLite-only projection reads rows, revision vector and cursor
from one read transaction. A projection containing external files captures retained cursor `C0`
before the stable scan, returns that same lower cursor and tolerates replayed duplicates; it never
captures the latest cursor after projection. It retries if external generation/hash changes or the
bounded snapshot lease loses retention. Resource revision is never reused as Last-Event-ID. If the
journal cannot prove the returned barrier is retained, the response/stream yields
snapshot_retry/resync_required before incremental events.

## Renderer state, authority, and migration invariants

### Authority matrix

| State                                          | Authority                        | Browser persistence                                      | Reconciliation rule                                                                  |
| ---------------------------------------------- | -------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Team/task/Kanban/message data                  | server repositories              | memory cache only                                        | revisioned snapshot plus events                                                      |
| Provisioning/runtime run state                 | lifecycle coordinator            | memory cache only                                        | runId + generation + terminal tombstone                                              |
| Tool approval requests/results                 | runtime coordinator              | memory cache only                                        | event/command pair, dedupe by teamId/runId/requestId                                 |
| Tool approval policy                           | server repository                | optional non-authoritative UI mirror                     | server version wins; audited updates                                                 |
| Launch defaults such as last model/effort/fast | user preference                  | localStorage allowed                                     | validate against current capability catalog before use                               |
| Pending command receipt                        | server command/workflow registry | bounded safe locator in localStorage                     | resolve by actor/action/key; never replay from receipt or persist command body       |
| Graph layout and panel dimensions              | renderer                         | localStorage allowed                                     | namespace by stable deploymentId and teamId                                          |
| Workspace identity/mount                       | WorkspaceRegistry                | never persist raw host path; mountGeneration memory only | stable workspaceId plus boot-scoped mountGeneration/display metadata                 |
| Team identity                                  | server                           | stable opaque teamId                                     | teamName remains display/legacy alias, not cache authority                           |
| Member identity/roster                         | TeamRoster                       | memory cache only                                        | memberId + rosterGeneration/memberRevision; legacy name is display/provider evidence |
| Branch/review source                           | server workspace adapter         | memory cache only                                        | key by workspaceId/repositoryId, never raw path in browser                           |

Security-sensitive settings such as autoAllowAll, timeout allow/deny, and safe-command policy are
not merely browser preferences. The current implementation stores them in localStorage, syncs only
best-effort to an in-memory main-process map, and can silently fall back to defaults after restart.
Hosted v1 must persist them server-side with schema/version, actor, updatedAt, and audit event.
Changing policy while approvals are pending must have one deterministic re-evaluation rule.

### Canonical client state tuple

For each team, the reconciler tracks at minimum:

    deploymentId
    bootId
    contextEpoch
    teamId
    teamGeneration
    bindingGeneration
    workspaceMountGeneration
    rosterGeneration
    fileWriterEpoch
    snapshotRevision
    instanceEventCursor
    currentRunRef: { runId, generation } | null
    ignoredRunIds/tombstones with bounded expiry

Events and responses lacking a matching identity/generation are ignored. Tombstones are bounded by
time and count but cannot expire while a conflicting run remains observable. A backend restart
changes bootId and forces capability/session revalidation plus a fresh snapshot; stable
deploymentId/teamId preserve safe UI preferences. A restart must not be confused with a normal
reconnect or with a different state root reusing the same public URL.
Provisioning progress, lane/runtime state and stop/cancel controls are feature projections of this
single currentRunRef. No reconciler may independently select a newer provisioning or runtime run.

Hosted renderer context is the authenticated server deployment, not Electron `local`/`ssh` mode.
Repository/project selectors are projections of WorkspaceRegistry. Existing context-epoch guards
remain useful, but their identity comes from deploymentId/session/workspace selection; browser code
does not instantiate SSH/local filesystem providers or branch on `isElectronMode` for team data.

### Snapshot/event/poll algorithm

1. Capture context/team generation before every request.
2. Fetch a snapshot containing its revision vector and ADR-33 same-transaction/lower replay cursor;
   do not describe it as the latest/current cursor.
3. Commit only if the captured scope is still current and the response is not older than the
   visible projection.
4. Subscribe from the snapshot cursor before declaring the view live.
5. Deduplicate events by eventId and reject an event older than the current aggregate/run/file-writer
   generation; a replay already represented by the snapshot is expected, not an error.
6. Apply pure event reducers when the payload is sufficient; otherwise schedule one coalesced
   bounded snapshot refresh.
7. On a gap/resync_required/schema mismatch, pause incremental application, fetch a fresh snapshot,
   and resume from its cursor.
8. Poll only as a health/recovery fallback. A poll response follows the same scope/revision checks
   as an event-triggered fetch.
9. Keep the last valid snapshot visible during retryable refresh failures; clear it only for an
   authoritative deletion/generation change.
10. Reconnect/poll retries honor Retry-After, exponential backoff with jitter, browser offline and
    visibility state, and a per-tab request budget. Auth/session errors stop ordinary retry loops,
    attempt one coalesced ADR-7 device renewal across tabs, then either re-bootstrap session/meta/
    snapshot or enter explicit host-pairing recovery; they never loop mutation requests.

### Existing invariants that cannot regress

- concurrent initial list/task fetches remain single-flight, with at most one required follow-up;
- a late response from a previous context, team generation, delete, stop, or launch is ignored;
- a thin snapshot cannot erase member/runtime data from a newer full snapshot;
- message head refresh and older-page loading remain serialized and cursor-safe;
- current provisioning run selection never falls back to an arbitrary newest team run;
- optimistic pending runs are replaced atomically by the returned canonical run;
- stopped/deleted runs cannot be resurrected by late SSE, poll, or watcher events;
- provisioning terminal states cannot regress, except an explicitly modeled ready -> disconnected;
- high-frequency process/tool/log events retain visibility gates and bounded fanout;
- semantic no-op observations preserve object identity to avoid renderer churn;
- cleanup removes timers, subscriptions, pending approvals, runtime tool layers, and cached
  projections for the exact team generation only.

The existing teamSlice and context-race suites are mandatory characterization input. Extract pure
reducers and reconciler tests alongside them; do not replace the suite wholesale with snapshots.

## High-risk interaction contracts

### Tool approvals

Tool approval is a server-authoritative state machine, not a transient notification:

1. The approval key is teamId/runId/requestId. requestId alone is not globally unique.
2. A pending-approval snapshot endpoint lets a freshly logged-in/reloaded browser recover prompts
   that were emitted before its SSE subscription.
3. Request events and terminal resolution events are journaled and replayable. Duplicate request
   events do not duplicate sheets.
4. The decision command carries expected run/generation and an idempotency key. The first accepted
   manual/timeout/auto decision wins; later decisions return an explicit already_resolved result.
5. The UI removes a request only after an accepted decision or authoritative terminal event. A
   retryable network failure keeps it visible.
6. Timeout and policy re-evaluation run only on the server clock. Browser timers are display-only.
7. Auto-allow policy is persisted server-side and defaults fail-closed after corruption or unknown
   schema. `autoAllowAll` requires an explicit warning/confirmation and audit event.
8. Tool input is schema-bounded and redacted. File previews use an opaque approval-scoped fileRef,
   registered workspace containment, maximum bytes, binary detection, and expiry; browser requests
   never submit an arbitrary filePath.
9. Multiple tabs are supported: all receive the terminal event, but only one decision can claim the
   response. Stale run, stopped team, expired prompt, and unwritable process are distinct safe codes.
10. Audit records contain actor/session, team/run/request, tool category, policy/manual source, and
    result, but not command secrets, full prompts, file contents, or credentials.
11. Runtime-originated approval requests/acknowledgements enter only through authenticated machine
    ingress or validated provider evidence. Browser decisions enter only through the operator API;
    neither credential can call the other direction.
12. The accepted browser decision is persisted before provider delivery. Provider delivery uses a
    canonical idempotency key and transitions through delivering -> delivered or
    delivery_unknown/recovering; an HTTP timeout never causes a blind second answer.
13. Current OpenCode permission payload fields such as cwd, expectedMembers and previousLaunchState
    are compatibility evidence only. The server resolves current workspace/member/run authority and
    rejects a mismatch before changing approval or launch state.

### Destructive and process-control actions

- delete/restore/permanent-delete and killProcess require fresh server authorization, CSRF,
  explicit target identity, and audit records;
- killProcess accepts a runtime-owned processRef plus generation, never a browser-supplied PID;
- permanent delete is blocked while an owned runtime or journal recovery is active unless a
  separately authorized stop-and-delete workflow completes;
- retrying a timed-out destructive request uses its idempotency key and status endpoint rather than
  blindly issuing the command again;
- undo/restore semantics and retention period are server policy, not local UI assumptions.
- identity repair is available only through the ADR-6 maintenance-mode capability: normal mutation
  admission/runtime launch are closed, evidence hashes and typed TeamId must match, a coordination
  backup precedes the repair intent, and the action cannot allocate or accept a different ID;
- Permanent delete is a journaled idempotent saga over the v1 ownership catalog (team/task files,
  app metadata, launch/runtime evidence, event/review/approval state, internal
  storage, backups according to retention policy). A partial delete resumes safely; it cannot leave
  a live runtime pointing at a half-removed directory.
- Stop/delete first revoke current run-ingress credentials, fence new runtime/file
  mutations, and only then terminate owned processes/remove state. Late callbacks for the revoked
  generation are acknowledged as stale or rejected without recreating team state.
- Runtime process projections expose processRef, safe label/state, ownership, and resource summary,
  not raw PID, command, environment, host port, or loopback URL.
- Opening an agent-started web server requires a separate allowlisted preview-proxy capability with
  target ownership, port policy, auth, origin isolation, header/body limits, and SSRF protection.
  Until implemented, the hosted Process Open control is absent; never send server localhost URLs to
  the browser and expect them to work.

### Attachments and browser file handling

- message/task attachments are addressed by opaque attachmentId and streamed through authorized,
  bounded endpoints rather than embedded as unbounded base64 JSON;
- upload validates declared and detected MIME, filename, size, count, aggregate team quota, and
  storage containment; partial uploads are cleaned after expiry;
- download sets safe Content-Type, Content-Disposition, nosniff, and cache policy;
- hosted non-image attachment UX is download/preview. It must not call the desktop editor with a
  host file path;
- malware scanning can be a deployment capability, but its unavailable/degraded state and policy
  must be explicit before uploads are enabled.

### Advanced launch controls

- Hosted validation is a provider-specific allowlist parser, not a blacklist and not a promise to
  execute arbitrary CLI text. It returns normalized structured options.
- Reject flags that can change cwd/workspace, config/settings paths, credentials, control URLs,
  MCP/bootstrap transport, output destinations, permission policy, or process execution mode unless
  that option has a dedicated authorized contract.
- Bound token/argument count and length; use argv arrays without shell parsing.
- Worktree input is a logical name/strategy. The server chooses and validates the destination under
  the registered worktree root.
- skipPermissions/auto-approval is deployment policy-gated and visibly high risk; a browser cannot
  enable it when the server capability forbids it.
- Do not persist raw custom arguments, tokens, host paths, or prompts in localStorage. Only safe
  normalized launch preferences such as provider/model/effort/fast may be remembered.

### Untrusted agent/runtime content

Treat team names, task text, messages, Markdown, tool input/output, logs, diagnostics, branch names,
filenames, process labels, and URLs as attacker-controlled even in a single-operator deployment.

- render Markdown through the existing audited sanitizer with raw HTML disabled or sanitized;
- allow navigation only to explicit http/https schemes and use noopener/noreferrer;
- never construct HTML, CSS, file URLs, command lines, or WebSocket targets from raw agent strings;
- bound and virtualize logs/messages, sanitize ANSI/control sequences, and do not log full unsafe
  payloads on parse failure;
- escape spreadsheet/formula-like exports if later added;
- security tests include stored/reflected XSS payloads delivered through JSON files, SSE, logs,
  approval inputs, filenames, and provider diagnostics.

### Git and worktree controls

- Git operations accept workspaceId/repositoryId and structured options, never command text or raw
  paths; execute through argv with bounded output/time.
- Status/branch projections are keyed by repository identity. Browser responses expose repository
  labels and relative paths only where needed, not absolute host paths.
- Repository initialization and initial commit are explicit confirmed mutations with idempotency and
  audit. They cannot run automatically merely because launch preflight sees a non-repository.
- Define hook/filter policy for server-owned Git mutations. If hooks are disabled, enforce an empty
  hooks path for that invocation; if enabled by deployment policy, treat their code execution as a
  high-risk workspace capability.
- Worktree create/delete verifies registered roots before and immediately before mutation, handles
  partial directories/locks, and never deletes a path it cannot prove it created/owns.
- Remote fetch/push and credential management are out of scope unless separately promoted; no
  launch flow should accidentally contact a Git remote.

### Messaging and task mutation semantics

- SendMessage uses a client-generated messageId/idempotency key. Retrying after timeout cannot append
  a duplicate inbox entry.
- Distinguish durable inbox persistence from live runtime delivery. A persisted message with failed
  provider delivery is not reported as wholly failed or silently retried without policy.
- Pagination uses opaque stable cursors and deterministic tie-breaking, not only timestamps. Head
  refresh cannot invalidate or duplicate an already loaded older page.
- Task mutations carry expected task/team revision. StartTask is an idempotent compound command over
  status/work interval/owner notification and reports partial notification outcome explicitly.
- Relationship/comment/review mutations use operation IDs so watcher echoes and retries do not
  duplicate history events.
- Agent-side task/inbox edits that race browser commands produce a new revision and conflict/retry
  path; no last-writer-wins overwrite of unrelated unknown fields.

### Logs and diagnostics

- Browser queries are paginated/bounded by bytes, lines, time range, and source generation.
- Redaction happens in the server projection before serialization. Replace registered absolute roots
  with workspace labels/relative paths and remove credentials, auth headers, environment secrets,
  pairing/session/CSRF tokens, and provider payload fields classified sensitive. Post-v1 terminal
  grants join the same redaction class when that capability exists.
- diagnosticId is opaque and authorization-scoped. It is not a filesystem path and cannot be used
  to request arbitrary artifact files.
- Full local artifact packs may remain operator-only on disk with mode/retention policy; the web UI
  receives an allowlisted summary/tail unless an explicit secure export capability is enabled.
- Log source generation prevents a stale detail request from showing content for a replaced file.
  Truncation/rotation is a normal typed result, not a parser error.

## Provider and runtime strategy

### Provider capability response

For each provider/backend:

- installed/resolvable;
- authenticated/unknown/unavailable;
- supported execution modes;
- supported composite lane topology modes and lead/member constraints;
- planned ProcessExecutionUnit shape and safe credential-isolation class
  (`dedicated_execution_unit` or `shared_execution_unit`), never secret names/values;
- supported models and effort levels;
- launch readiness;
- log/recovery capability; hosted terminal capability is absent in v1;
- typed remediation.

### Provider-specific details remain behind adapters

Provider adapters may know:

- CLI arguments;
- environment variables;
- model naming;
- auth probing;
- bootstrap proof;
- delivery journals;
- runtime-specific recovery.

Application use cases know only provider-neutral capability and lifecycle contracts.
The browser may pre-gate an unsupported topology from the capability response, but LaunchTeam always
re-runs the authoritative `team-runtime-lanes` planner and returns its typed rejection. UI/provider
catalog code never guesses support from individual provider availability alone.

### Agent-specific JSON and protocol boundary

Provider-neutral application contracts do not mean pretending every runtime has identical files.
Claude-compatible config/tasks/inboxes are an external collaboration protocol used by the CLI and
agents; OpenCode launch/evidence/delivery stores and other provider artifacts have different
schemas and recovery semantics.

Before extraction, build a provider artifact inventory with:

- file/path pattern and producer/consumer;
- read-only, append-only, or writable authority;
- schema/version and required CLI fields;
- unknown-field preservation behavior;
- watcher trigger and self-write suppression rule;
- maximum size/count and parse timeout;
- corruption/partial-write behavior;
- whether it is authoritative state, evidence, journal, cache, or diagnostic artifact.

Rules:

1. Browser and application use cases never parse provider JSON directly.
2. A provider adapter may expose a tagged provider-neutral projection plus a bounded typed
   providerDetails extension when the UI genuinely needs provider-specific diagnostics/actions.
3. Claude task/config writes retain CLI-required defaults and unknown fields. A normalized domain
   DTO is not serialized wholesale over a newer external document.
4. App-owned OpenCode/versioned stores keep their existing generation/checksum/manifest guarantees;
   migration must reuse them rather than flattening them into generic unversioned JSON.
5. Malformed one-item evidence cannot crash a team list. Critical launch state corruption blocks
   mutation with a diagnostic; derived log/cache corruption degrades only that projection.
6. Watchers debounce stable file identity/generation, tolerate atomic rename, and bound repeated
   parse failures. They do not emit a domain revision until a complete validated projection exists.
7. Every provider gets golden fixtures for current, legacy, future-unknown-field, truncated,
   oversized, and partially written artifacts.
8. Direct runtime writes that cannot participate in expectedRevision are reconciled as external
   mutations with a new server revision; conflicting browser edits receive stale_revision and must
   refetch/reapply explicitly.
9. Claude-compatible task/inbox/config observations use ADR-24 ExternalFileActor and remain team-
   scoped unless a catalogued provider artifact proves RunId/generation. Claimed member/owner/from
   fields are content, not actor authentication.
10. A new launch cannot overlap an unclosed fileWriterEpoch. Stop/recovery must prove process
    quiescence, drain the watcher watermark and commit a stable rescan before accepting the next run.
11. Provider adapters expose run-scoped facts only through a narrow VerifiedRunEvidence port; there is
    no universal ProviderJson object or switch in team-lifecycle/application code.

### Runtime liveness and recovery state model

The current red tests expose an ambiguity that hosted code must not copy: historical bootstrap
confirmation is not current process liveness. Define one provider-neutral state projection:

| State                    | Meaning                                                                 | Allowed next states                                  |
| ------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------- |
| absent                   | no configured/current run                                               | provisioning                                         |
| provisioning             | accepted run is preparing/spawning/verifying                            | ready, degraded, failed, cancelling                  |
| ready                    | required runtime members have fresh verified liveness                   | degraded, stopping, disconnected                     |
| degraded                 | run exists but some required capability/member is unhealthy             | ready, stopping, disconnected, failed                |
| cancelling/stopping      | terminal command claimed for the current generation                     | cancelled/stopped, failed                            |
| disconnected             | persisted/historical run exists but current liveness is absent or stale | recovering, stopped, failed                          |
| recovering               | coordinator is verifying/adopting instance-owned runtime evidence       | ready, degraded, disconnected, failed                |
| failed/cancelled/stopped | terminal for that run generation                                        | no regression; a new launch creates a new generation |

Rules:

- `historicalBootstrapConfirmed` is diagnostic history only and never implies alive=true;
- liveness requires provider-specific fresh evidence plus verified process/session identity;
- PID existence alone is insufficient; PID start identity and ownership must match;
- evidence has explicit observedAt/freshUntil/source/generation and a documented precedence order;
- startup adoption is a bounded recovering transition. Unknown/unowned processes are observed or
  reported, never killed/adopted by guess;
- v1 graceful-shutdown default is `stop-owned`: stop only verified instance-owned process trees,
  persist terminal/recovery facts, flush journals, and leave no orphan. `preserve-for-adoption` is a
  separate advertised deployment capability allowed only when the runtime backend proves an
  external lifetime, stable ownership identity and bounded restart adoption; it is not inferred from
  PID/tmux existence. It is unavailable in the default same-UID pairing-file profile; advertising it
  additionally requires OS isolation proving the preserved runtime cannot read controller pairing/
  session/coordination state;
- cleanup of bootstrap/launch state is an idempotent state-machine action with durable completion,
  not a timing-dependent test side effect;
- snapshot, progress event, and process-exit event are projections of the same canonical transition;
- list/detail/alive APIs cannot disagree on the current canonical generation.

Add a transition-table test per provider plus restart/crash tests. Resolve the existing failing
liveness/cleanup expectations from evidence and this state model before using them as parity
fixtures; do not simply change tests to whichever boolean the current implementation returns.

### Hosted provider test matrix

- homogeneous Anthropic;
- homogeneous Codex;
- homogeneous Gemini;
- homogeneous OpenCode;
- mixed-provider team;
- missing runtime;
- missing auth;
- unsupported backend;
- malformed capability response;
- process timeout;
- partial launch;
- restart/adoption;
- OpenCode secondary lane recovery.

## Implementation phases

### How an AI team executes a phase

The detailed task lists below are the architecture/evidence checklist. The
[execution router](./hosted-web-phases/README.md) selects the only executable phase, and its controller
packet owns the current DAG. A lane packet owns one worker's exact reads, writable paths, evidence IDs,
checks and handoff. An orchestrator never assigns an entire phase or this whole document to one vague
worker prompt.

Later phase sections remain non-executable until the predecessor freeze materializes a packet under the
[packet standard](./hosted-web-phases/PACKET_STANDARD.md). This is intentional: Phase 0 evidence may
invalidate current assumptions about contracts, native primitives, provider boundaries or estimate
buckets.

Every work package moves through the same states:

1. `blocked`: its entry gate or upstream contract is not complete;
2. `ready`: owner, allowed paths, public contracts, fixtures and verification commands are recorded;
3. `characterizing`: current behavior and negative control are captured before behavior changes;
4. `implementing`: one bounded production seam plus its focused tests is changed;
5. `integrating`: self-review, scope check, targeted gates and conflict/adoption review run;
6. `verified`: required evidence is attached and the package's exit condition passes.

A worker task must name exactly one package ID, owned paths/symbols, immutable upstream contract IDs,
expected artifacts, tests and forbidden adjacent work. Shared composition, global renderer/store,
RouteCatalog, migrations and build entrypoints always have a serialized integration owner. A package
cannot be called complete because code exists; its consumer must exercise the new seam and its old
authority/bypass must be removed or explicitly quarantined.

### Phase 0 work packages: make the base and unknowns trustworthy

Execution packet: [Hosted Web Phase 0 JIT Execution Packet](./hosted-web-phase-0-execution-packet.md).
It is the normative worker DAG/ownership/checklist for Phase 0; this document remains the architecture
and exit-gate authority. Worker-specific entrypoints are registered in the
[execution router](./hosted-web-phases/README.md); workers read one lane packet rather than loading this
entire plan as their prompt.

- **0A - Base and accounting:** fetch/pin the exact base SHA, create the implementation branch, commit
  this plan, classify baseline CI and create the unique-bucket estimate/salvage ledgers.
- **0B - Inventories:** generate API/action parity, renderer callsite, state-family, writer-authority,
  provider/runtime-ingress, environment/credential and artifact inventories from the pinned code.
- **0C - Feasibility proofs:** independently prove ADR-16 lease, ADR-28 workspace guard, ADR-31 process
  anchor, ADR-32 SQLite backup, ADR-33 snapshot/event handoff, ADR-34 effect recovery and ADR-7 auth/
  proxy schedules in final-shape fixtures.
- **0D - Freeze decisions:** turn successful evidence into versioned contracts/ADRs/readiness gates;
  failed evidence narrows capability scope or reopens the specific ADR before feature implementation.
- **Order:** 0A first; 0B streams may run in parallel; 0C spikes may run in parallel only after their
  environment assumptions are pinned; 0D is serialized integration.
- **Concrete result:** a reproducible branch, trustworthy baseline, checked-in inventories and runnable
  negative/positive spikes. No hosted product mutation is enabled yet.

### Phase 1 work packages: create one contract system, not another mega-API

- **1A - Contract conventions:** add opaque IDs, revisions/cursors, RequestContext, AppError categories
  and feature-local DTO/schema conventions; do not predeclare every future use case.
- **1B - Capability and routes:** implement feature-owned RouteDescriptor/CapabilityDescriptor sources
  and narrow renderer facets; hosted never implements ElectronAPI.
- **1C - Conformance gates:** add import/dependency, no-stub, route/client/schema, IPC/HTTP outcome and
  capability-mount negative fixtures.
- **1D - First proof:** define one read-only team-lifecycle query and drive the same use case through
  test, IPC and Fastify adapters without transport types entering application code.
- **Order:** 1A before 1B/1D; 1B and 1C can proceed in parallel against frozen conventions; 1D proves
  the conventions before Phase 2 adds more contracts.
- **Concrete result:** one small shared kernel and repeatable feature template with no business god-
  facade, Electron dependency or fake browser implementation.

### Phase 2 work packages: establish stable identity and safe read-only truth

- **2A - Team/member identity:** implement TeamId, LegacyTeamKey, MemberId, roster generations,
  adoption/ambiguity rules, migrations and tombstones around existing files.
- **2B - Workspace identity:** implement WorkspaceRegistration, stable WorkspaceId, boot-scoped
  mountGeneration, overlap/permission probes and opaque browser workspace selection.
- **2C - Read repositories/use cases:** wrap current parsers/services with team list/detail/runtime-
  status read ports and compose versioned browser-safe projections.
- **2D - Desktop delegation and shadow parity:** delegate existing IPC reads to the same use cases,
  compare legacy/new projections and migrate renderer reads without enabling mutations.
- **Order:** 2A/2B schemas and recovery rules first; 2C depends on both identities; 2D begins after a
  stable projection exists. Fixture building can run parallel to repository adapters.
- **Concrete result:** browser and desktop can list/select/inspect the same teams using opaque stable
  IDs, while corrupt/ambiguous/rebound state remains read-only with typed diagnostics.

### Phase 3 work packages: make every mutation crash- and writer-aware

- **3A - Ownership catalog:** classify every config/task/inbox/review operation as app-exclusive,
  cooperative, provider-mediated, quiescent-only or unavailable; record unknown-field semantics.
- **3B - Command/effect substrate:** implement versioned command descriptors, normalized fingerprints,
  idempotency claims, outbox, recovery evidence and operator-required ambiguity.
- **3C - Compatibility repositories:** add bounded mutation coordinators for each approved file family,
  watcher self-write attribution and hostile external-writer fixtures without a universal repository.
- **3D - Event and recovery foundation:** implement snapshot/event handoff, replay cursors, recovery-
  point participant interfaces and the SQLite online-backup driver proven in Phase 0.
- **Order:** 3A and the 3B contract precede mutating adapters; separate file-family adapters may then
  run in parallel; 3D integration is serialized around journal/transaction boundaries.
- **Concrete result:** an accepted mutation can be retried/recovered without duplicating effects or
  overwriting an uncoordinated provider writer. Product workflows are still added in later phases.

### Phase 4 work packages: own runtime execution and lifecycle in one place

- **4A - Immutable runtime plan:** map roster/provider/lane facts to one CompositeRuntimePlan and two
  real backend families: provisioning CLI for Anthropic/Codex/Gemini and OpenCode adapter execution.
- **4B - Machine ingress:** separate `/api/runtime/v1`, lane/run credentials, replay fences and ADR-30
  controller-owned relay from operator/browser routes.
- **4C - Process ownership:** integrate ADR-31 spawn intent, anchor handshake, pidfd/subreaper drain and
  unclassified-residual behavior behind ProcessSupervisorPort.
- **4D - Lifecycle commands:** implement prepare/launch/progress/cancel/stop/recover, one currentRunRef,
  legacy-drain cutover and provider-specific degraded states through team-lifecycle use cases.
- **Order:** 4A contract first; fake provider fixtures, 4B and 4C can proceed in parallel; 4D composes
  them only after ingress and process evidence are stable.
- **Concrete result:** deterministic fake providers and all supported provider topologies launch and
  stop through shared application use cases with durable state and zero raw PID/cwd/browser authority.

### Phase 5 work packages: produce the real hosted artifact

- **5A - Application composition:** reduce standalone.ts to config plus lifecycle wiring, compose
  feature facades/RouteCatalog/readiness and keep business sequencing outside HttpServer.
- **5B - Build graph:** emit the server, renderer, internal-storage worker and required Node-ABI/native
  helper artifacts; reject Electron imports, empty stubs and missing/wrong-hash artifacts.
- **5C - Container topology:** build the non-root image, ADR-16 launcher/init path, explicit volumes,
  private app/runtime networking, health endpoints and bounded shutdown.
- **5D - Artifact/readiness probes:** run SQLite, ADR-28/31, provider/helper and competing-container
  probes inside the final image; prove terminal artifacts/routes are absent from v1.
- **Order:** 5A and build-graph audit can run in parallel against frozen facades; 5B precedes 5C final
  image; 5D gates route admission and documentation.
- **Concrete result:** one clean-machine production artifact serves the real renderer and canonical
  APIs, but non-loopback mutations remain disabled until Phase 6 security passes.

### Phase 6 work packages: close the remote-control security boundary

- **6A - Durable operator authority:** implement pairing challenge, device family, short session,
  auth keyring, renew/rotation/revocation/reset and crash recovery.
- **6B - HTTP boundary:** enforce explicit PUBLIC_ORIGIN, exact proxy CIDRs, secure cookies, Origin,
  CSRF, body/rate/concurrency limits, no-store/redaction and browser/runtime route separation.
- **6C - Workspace/effect authorization:** issue operation-scoped WorkspaceAccessGrant values, enforce
  ADR-28 in file/Git/provider-spawn adapters and reject raw paths/rebinding/unsupported mounts.
- **6D - Adversarial matrix:** test cookie/parser abuse, CSRF, proxy spoofing, credential replay,
  cross-lane authority, secret canaries, traversal/symlink/mount races and residual-runtime pairing.
- **Order:** pure auth/security state machines and negative tests can run parallel; public route
  registration waits for 6A-6C and one serialized security review.
- **Concrete result:** the Phase 5 artifact is a safe single-operator remote-control deployment, with
  authenticated HTTP/SSE and scoped machine ingress; v1 still has no terminal/WS surface.

### Phase 7 work packages: deliver the first complete browser lifecycle

- **7A - Hosted clients:** build narrow team-read/lifecycle/provisioning facets over canonical HTTP/SSE
  contracts with cancellation, safe errors and command receipts.
- **7B - Renderer composition:** introduce team-console, feature reconcilers and capability-first
  mounting; migrate the minimum TeamList/TeamDetail controls without a second canonical store.
- **7C - Vertical server flow:** compose workspace list, team list/detail, draft/create, prepare,
  launch/progress/status and stop through existing Phase 2-6 use cases.
- **7D - Real-browser proof:** run login -> select workspace -> create -> fake launch -> SSE progress ->
  reload/reconnect -> stop -> container restart using only a new sandbox project.
- **Order:** 7A/7B can parallelize against frozen contracts while 7C composes handlers; 7D starts only
  after the built artifact passes security and process gates.
- **Concrete result:** the first production-usable web UI slice. It is a milestone, not broad parity.

### Phase 8 work packages: add tasks, Kanban and messaging safely

- **8A - Task board:** implement task CRUD/status/assignment/relationships/comments/Kanban revisions
  through team-task-board repositories and pure reducers.
- **8B - Messaging:** implement paginated inbox/history, send identity, persistence versus live delivery
  outcomes and OpenCode delivery status through team-messaging.
- **8C - External reconciliation:** connect fileWriterEpoch, watcher watermarks, provider-mediated/
  quiescent mutation rules and replay journal to tasks/messages without falsely attributing writes.
- **8D - UI/realtime/E2E:** add feature clients/components, snapshot-first SSE reconciliation and
  hostile-writer/reconnect/restart browser suites.
- **Order:** 8A and 8B can run in parallel; 8C owns shared watcher/journal integration and is serialized;
  8D integrates only public feature entrypoints.
- **Concrete result:** commands from the web and agent-written JSON converge without lost updates,
  duplicate messages or stale-run resurrection.

### Phase 9 work packages: close the remaining required product parity

- **9A - Logs/diagnostics:** bounded member/task/exact logs, activity and redacted failure diagnostics.
- **9B - Review/attachments:** safe file refs, diff/apply source generations, comments/outcomes and
  bounded upload/download/preview lifecycle.
- **9C - Approvals:** pending projection, policy, atomic claim/decision, delivery outcome, audit and
  multi-tab/reload behavior.
- **9D - Members/destructive/cross-team:** member add/replace/remove/restore/restart/skip, DeletionSaga,
  identity maintenance mode and only the cross-team actions used by included screens.
- **9E - Parity closure:** regenerate the action/API ledger, remove every required stub/bypass and prove
  each advertised control against semantic conformance plus browser evidence.
- **Order:** 9A-9D are feature-owned and may run in parallel after their shared contracts are frozen;
  team-console, RouteCatalog and destructive workflow integration remain serialized; 9E is last.
- **Concrete result:** every v1 team screen is operable or deliberately absent before mount, with no
  method-name-only parity claim.

### Phase 10 work packages: turn feature-complete into releasable

- **10A - Operations:** structured redacted logs, metrics, readiness lattice, diagnostic IDs, retention
  and reference-scale latency/memory/event-loop budgets.
- **10B - Lifecycle hardening:** graceful admission/drain/flush/exit, repeated SIGTERM, non-root/read-
  only filesystem, resource limits, private networks and stop-then-start replacement.
- **10C - Compatibility/rollback:** StateCompatibilityManifest, migrations, ADR-32 recovery points,
  ADR-26 replacement restore and built N -> N+1 -> N compatible/drain/restore/refuse tests.
- **10D - Release evidence:** full real-browser parity suites, deterministic provider matrix, desktop
  regressions, load/chaos, optional sandbox live-provider canaries and operator runbooks.
- **Order:** observability, compatibility fixtures and test harnesses may run parallel; rollout/image/
  migration integration is serialized. No feature scope is added in this phase.
- **Concrete result:** a versioned production image that can start, operate, stop, recover and roll back
  with all v1 Definition-of-Done evidence attached.

### Post-v1 T1 work packages: terminal only after v1 or explicit reprioritization

- **T1A - Revalidate:** repeat the terminal-platform, browser WebSocket, Fastify plugin and artifact
  audit against the then-current bases; update ADR-35/estimate before code.
- **T1B - Upstream runtime:** implement guarded launch, daemon identity/persistence, environment,
  projection/backpressure and PTY drain in terminal-platform; publish one pinned compatibility set.
- **T1C - Hosted adapter:** implement HostedTerminalFacade, two-plane grant/regrant, same-origin gateway,
  narrow renderer facet and terminal-owned readiness/migrations.
- **T1D - Rollout evidence:** run the terminal-specific security/flood/reconnect/process/container E2E,
  then enable the capability separately.
- **Order:** T1A first; upstream and app contract fixtures may parallelize, but this repo cannot consume
  artifacts before T1B is versioned. T1 never blocks or shares the v1 umbrella branch.
- **Concrete result:** terminal becomes one optional capability without widening v1 clients or changing
  the already released team application use cases.

Phase estimates below describe touched implementation/test surface and intentionally overlap:
later phases revisit contracts, adapters, and fixtures introduced earlier. They must not be
summed mechanically. The planning estimate for the final non-terminal v1 net fresh-branch diff is
28k-45k changed lines. Post-v1 T1 terminal is estimated separately at 6.5k-11.5k across two repos.
The Phase 0 estimate ledger replaces these ranges once the unique-package/action inventory is frozen.

### Phase 0: stabilize baseline and freeze decisions

Estimated change: 4,000-6,500 lines.
Complexity: 9/10. Risk: 8/10.

Tasks:

1. Fetch the remote target base, record its exact SHA, and create a clean implementation branch from
   that SHA only after this plan is accepted. Do not merge the closed PR ancestry.
2. Run the base branch's required checks and classify pre-existing failures before production edits.
3. Preserve characterization tests for current Electron behavior.
4. Add this plan, architecture decision records, ownership matrix, and salvage ledger template.
5. Freeze single-tenant v1 semantics.
6. Generate ADR-19 parity-ledger records from the pinned AST for all 86 TeamsAPI, 20 ReviewAPI and
   3 CrossTeamAPI members; assign replacement kind, owner/action/use-case IDs and semantic/test
   obligations rather than accepting method-name presence.
7. Freeze `/api/hosted/v1` operator and `/api/runtime/v1` machine trust surfaces, namespace rules and
   safe error/ack envelopes; do not freeze every feature DTO prematurely.
8. Add architecture fitness tests for dependency direction, public entrypoints, direct Electron
   bypass, route/capability coverage, repository writes, process ownership, and browser stubs.
9. Generate a renderer action inventory mapping every visible team control and store call to its
   capability, use case, transport adapter, authorization policy, and required test. Check in the
   AST scanner plus explicit annotations for dynamic dispatch so future controls cannot bypass it.
10. Reproduce the closed PR's TeamProvisioning liveness/cleanup, HttpServer warning, route mismatch,
    static Docker, and CodeQL rate-limit findings against the clean base. Record whether each is a
    base defect, rejected PR design, or required new guardrail; do not copy the failing implementation.
11. Inventory every producer/caller of target-base OpenCode runtime-control routes and classify
    bootstrap, delivery, task, heartbeat and permission direction/authority/idempotency before
    designing canonical ingress DTOs.
12. Characterize the actual deterministic provisioning CLI and OpenCode adapter paths for identical
    plan/preflight/launch/progress/cancel/stop/recover outcomes; record executable, argv/env,
    bootstrap files, cleanup and persisted evidence without logging secrets.
13. Freeze the v1 hosting support envelope: one Linux host and one deployment-root writer, supported
    local filesystem, volume provisioning, mount policy and fail-closed behavior for unsupported
    kernel/path operations. Network-shared and multi-host writable state is explicitly rejected.
14. Implement the ADR-16 feasibility spike in the final image before any application feature code.
    Build the versioned instance-lock launcher, provision the root-owned anchor plus runtime-owned
    state child, and start two containers/Compose projects/manual invocations on the same volume.
    Prove one reaches Node and every loser performs zero state/listener/process effect. Exercise
    launcher/controller SIGSTOP/SIGKILL, anchor unlink/rename/recreate attempts, unsupported mounts,
    duplicate-FD close order and clean handoff. Scan every fake provider/Git/helper descendant's
    `/proc/<pid>/fd` and fail if the lease inode escapes the controller lifecycle.
15. Inventory the canonical standalone bundle graph and v1 runtime artifacts. Prove which Electron
    imports and required `.node` addons are currently stubbed, how the internal-storage worker URL is
    emitted, which Node ABI each required SQLite addon uses, and which controller/MCP/provider artifacts
    the Docker image actually copies. Terminal-only addons/daemons are explicitly outside the v1 image
    manifest. Freeze ADR-17 artifact IDs and smoke probes before composing a feature that needs them.
16. Inventory every app-owned state family/current schema and non-terminal record type, then check in
    the initial ADR-23 StateCompatibilityManifest source plus a negative fixture for unknown/future
    state. Do not claim downgrade support until a built previous artifact proves it.
17. Implement the minimal ADR-28 guard feasibility spike before application feature code: compile it
    in the target Linux image, probe `openat2`/`statx`/seccomp/filesystem behavior, enter a verified cwd
    for the provider/process anchor, and run descriptor-bound read/write/rename primitives. Prove the
    v1 adapters have no raw-path fallback. The portable-pty inherited-FD variant belongs to post-v1
    post-v1 work package T1 and is not compiled or probed for v1.
18. Add the adversarial race harness with marker-owned roots: parent/final symlink swaps, root rename,
    bind-mount replacement, stale mountGeneration and repeated provider-process cwd attempts. Demonstrate
    the current Node path-string approach fails the negative control and the guard produces zero
    outside-root effect.
19. Characterize every Git verb needed by team worktrees/review. Freeze the allowlisted argv/config/
    environment policy and prove `worktree add` cannot execute a fixture `post-checkout` hook,
    fsmonitor, pager, external diff/textconv, credential helper or remote network operation.
20. Produce the ADR-29 writer matrix from actual callsites and sanitized provider fixtures: for each
    config/task/inbox/review/launch/backup operation record provider/version, possible active writer,
    proven lock/command acknowledgement, direct/quiescent/provider-mediated mode and UI capability.
    A source-code lock used only by this app is not evidence that Claude/CLI cooperates.
21. Produce ADR-30 environment provenance from the real provisioning/MCP/OpenCode/Codex/Gemini paths.
    Build allowlist-first fake launches for each backend, prove required key names and reject every
    controller secret canary in env/argv/settings/MCP/log/artifact output. Characterize target-base
    mixed-provider ProcessExecutionUnits, persist their minimum CredentialExposureSets, and prove no
    unit receives an out-of-set credential or the canonical runtime-ingress bearer.
22. Implement the minimal ADR-31 anchor spike in the final image. Exercise control-pipe EOF, parent
    SIGKILL, pidfd signal, subreaper double-fork, TERM-ignore/KILL, output flood, anchor crash and rapid
    PID/PGID churn. A marker-owned unrelated process must survive every test.
23. Characterize `TeamBackupService` async/sync enumeration, config-readiness gate, error swallowing,
    prune, identity mutation and partial/mtime restore against a fault-injected fixture. Build the
    minimal ADR-32 `better-sqlite3#backup` worker op with awaited async wire response, dedicated
    progress/deadline cancellation, WAL active, bounded BUSY handling, independent reopen/integrity
    verification and failure on raw-copy/checkpoint fallback in the final Node-ABI artifact.
24. Build an ADR-33 deterministic snapshot/event scheduler. Pause a mutation before/after journal
    commit and every snapshot, response, wake-up-listener, replay-query and SSE-attach boundary; prove
    that the old cursor-after-read and query-then-listen algorithms lose the injected event and that
    SQLite-transaction/lower-C0 plus listen-before-query converge with duplicates but no gap. Freeze
    snapshotSubscriptionId TTL, snapshot deadlines and cursor-retention lease bounds from this evidence.
25. Build the ADR-7 auth/proxy state-machine harness against the exact target-base Fastify/Compose
    path. Freeze session/device idle/absolute/renewal/grace limits; test pairing consume, normal restart,
    expired access renew, lost rotation response, simultaneous tabs, replay-family revoke and host reset
    with a fake residual runtime. Verify the current stable Fastify-5 cookie plugin, malformed/duplicate/
    oversized cookies, auth.keyring exclusive create/reopen/missing/corrupt/reset/restore behavior and
    crash recovery at every AuthResetIntent transition. Put an HTTPS edge in front of a private app
    listener and prove
    PUBLIC_ORIGIN/exact-CIDR handling rejects wildcard/nth-hop trust, forwarded-header spoof, direct
    HTTP and another port on the same host.
26. Generate ADR-34 `CommandDescriptor` and `EffectDescriptor` catalogs for every required mutation.
    Freeze normalized intent projections, HMAC fingerprint/key versions, retention compatibility and
    golden vectors. Classify each filesystem/provider/process/message effect from real adapters as
    transactional, operation-ID idempotent, uniquely reconcilable, compensatable or non-reconcilable;
    an unproven effect defaults to non-reconcilable/operator-required, never generic retry.
27. Create the estimate ledger by unique feature/package/test/tooling bucket. Record reuse, new net
    lines, deleted legacy lines, shared-file overlap and confidence separately; do not count a contract,
    fixture or composition edit once per phase. Re-estimate after the parity/action inventory and again
    after Phase 7. A projected net v1 diff outside 28k-45k or a bucket variance over 20% requires an
    explicit scope/design review before adding capacity.

Exit gate:

- all product decisions required for the first vertical slice are explicit;
- current desktop behavior is characterized;
- required CI is green on the exact chosen base or every pre-existing failure has an owner and an
  accepted isolation strategy before feature code begins;
- architecture tests fail on small deliberate negative fixtures and pass on the initial skeleton;
- every runtime-control producer/verb has an explicit machine-ingress or outbound-adapter direction;
- the parity ledger has exactly one disposition for every extracted legacy member and visible hosted
  action, and deliberate signature/action negative fixtures fail the gate;
- both real execution topologies have characterization fixtures and no invented universal
  orchestrator assumption remains;
- the ADR-16 launcher owns a kernel lock on a stable root-owned inode in the final volume topology;
  two real containers cannot both reach Node, anchor replacement is impossible for the runtime UID,
  and the lease descriptor is absent from all non-controller descendants;
- the built ADR-28 guard passes its final-image race/exec/Git negative suite; if it does not, all
  dependent capabilities remain out of the release matrix and the architecture decision is reopened
  before Phase 1 rather than replaced by Node-only checks;
- the hosted artifact inventory has no required module whose only current implementation is an empty
  build stub or an Electron-ABI binary;
- every discovered app-owned state family has an explicit read/write compatibility range and
  migration owner; unknown/future state blocks before migration;
- every externally writable file operation has one ADR-29 class and required active-run semantics;
  no required parity action depends on generic merge/retry against an uncoordinated writer;
- every hosted child environment key has ADR-30 provenance; controller/out-of-exposure-set canaries
  are absent from every provider tree/artifact, and the per-lane relay works without bearer-in-env/
  file fallback;
- the ADR-31 anchor passes final-image ownership/drain/PID-reuse tests; missing pidfd/subreaper/control
  evidence disables hosted launch instead of selecting Node `kill(pid)`;
- the SQLite backup driver produces a verified snapshot with a live WAL and never copies a database
  pathname behind SQLite; the full deployment backup remains disabled until ADR-32 quiescence exists;
- exhaustive ADR-33 schedules prove no snapshot/cursor gap, including the deliberate negative control;
- every required mutation has one stable ADR-34 fingerprint and every external step has one proven
  recovery class; old/new descriptor golden vectors, changed-intent key reuse and ambiguous-effect
  crash fixtures fail closed before implementation may advertise retry safety;
- ADR-7 schedules prove an operator is neither locked out by ordinary restart/renewal races nor given
  a plaintext recovery credential beside a live/unclassified runtime; the real HTTPS proxy matrix has
  no header-derived authority path;
- the estimate ledger has no duplicate phase counting and records explicit confidence/contingency per
  unique bucket; ADR-35/terminal contributes zero v1 implementation or packaging lines;
- no new browser stub is added without a capability classification.

### Phase 1: single-source contracts and conformance

Estimated change: 900-1,600 lines.
Complexity: 7/10. Risk: 6/10.

Tasks:

1. Define contract conventions plus the first team-lifecycle read DTOs/routes/errors/events; do not
   predesign all parity DTOs before their owning vertical slices.
2. Keep the tiny shared kernel to opaque IDs, request context, revisions/cursors and safe AppError
   categories. Feature-specific errors remain feature-owned.
3. Add runtime parsers for the first read/meta/capability contracts with explicit unknown-field and
   version behavior.
4. Implement ADR-15 RouteDescriptor/RouteCatalog metadata + assertions and migrate the first
   lifecycle read/meta routes. Do not introduce codegen/decorators or predeclare all later routes.
5. Add client-route versus server-route versus authorization-policy parity tests.
6. Cross-check ADR-19 ledger references against action IDs, RouteCatalog, IPC channels, public feature
   entrypoints and test metadata. Prove direct, decomposed and desktop-only mappings with negative
   fixtures; do not generate a mega client from the ledger.
7. Add an IPC-versus-HTTP semantic conformance harness and prove it with one read use case before
   expanding the API.
8. Remove IpcError/raw message matching from the migrated read/store policy only; ratchet the rest.
9. Add ADR-20 renderer gates: forbid direct window.electronAPI/global ElectronAPI/transport access in
   migrated team features, traverse the hosted renderer import graph for desktop-only entrypoints,
   and inventory global listener registration. Exceptions live only in exact migration adapters with
   owner/removal phase.
10. Add a capability/UI conformance test: supported controls have implemented handlers; unsupported
    controls are hidden/disabled with a reason before interaction, never after a thrown call.
11. Strengthen dependency tests in both directions: contracts/domain/application ports cannot import
    @main or Node infrastructure; hosted composition may import explicit adapters but cannot hide
    business logic behind an unrestricted @main/application/hosted god facade.
12. Capture target-base HttpAPIClient/direct-write/direct-Electron violations in the ratchet and add
    a negative type fixture proving no hosted facet can implement ElectronAPI.

Exit gate:

- RouteCatalog and the separate capability/action ledger cross-reference owner, auth policy and E2E
  status for every required action without merging route metadata and product state;
- ADR-19 parity records cross-reference those stable IDs and fail on legacy AST signature drift,
  missing semantic obligations or a hosted-visible desktop-only action;
- the first read route/client/parser exists end-to-end through the conformance harness;
- every current renderer TeamsAPI call is classified and every direct bypass is failing the gate;
- new contracts import no Electron, Fastify, React, Zustand, fs, path, or @main;
- no all-parity mega DTO/interface is introduced ahead of its owning slices.

### Phase 2: identity substrate and externally read-only team lifecycle

Estimated change: 2,600-4,400 lines.
Complexity: 9/10. Risk: 9/10.

First use cases:

- ListTeams;
- GetTeamLifecycleSnapshot;
- GetRuntimeStateProjection;
- ListAliveTeamProjections;
- CreateTeamDraft and DeleteTeamDraft through desktop/test adapters only; hosted remains read-only.

Tasks:

1. Introduce immutable RuntimeInstanceContext at composition boundaries and stop adding new mutable
   root/path globals; legacy global reads remain ratcheted until their adapters migrate.
2. Extend internal-storage with TeamIdentity records/tombstones and create `workspace-registry` with
   a read-only startup manifest adapter, registrationKey-stable opaque IDs, registration revision,
   ADR-25 boot-scoped WorkspaceMountBinding/mountGeneration and operation-specific authorization
   queries. Add immutable LegacyTeamKey reservation/tombstones and
   a bounded cross-root/case-fold collision scan; unsafe or ambiguous legacy directories stay
   read-only rather than being renamed or merged.
3. Before publishing any anchor, inventory and characterize every team-root create/remove/move/restore/
   backup path. Introduce one identity-aware TeamDirectoryLifecycleAdapter; route deterministic
   `createTeamConfig`/draft creation, explicit `deleteDraft` and permanent delete through durable
   identity cleanup/tombstone intents. Change provisioning failure for a committed draft/team to
   remove only RunId-owned attempt artifacts and retain identity/retry metadata. Upgrade
   TeamBackupService compatibility manifest so its legacy safety copy explicitly preserves
   team.identity.json and maps, but does not equate, canonical TeamId with legacy
   identityId/\_backupIdentityId evidence. This remains `legacy_unverified`, not ADR-32 v2 recovery;
   it preserves the anchor and durable draft record even before config.json is provider-ready. The
   current `isConfigReady` gate may still limit legacy/provider file copying but cannot omit canonical
   identity. Replace same-name resurrection with an explicit
   LegacyTeamKey tombstone/conflict path; a new team must reserve a different key. Add a CI ratchet
   forbidding raw recursive removal of an anchored team root outside this adapter. Publication remains
   disabled until these regression tests pass for both async and shutdown/sync backup paths.
4. Implement the dedicated write-once TeamIdentityFileStore and adopt legacy teams without rewriting
   CLI-owned config or volatile team.meta/members.meta: prepared SQLite adoption intent, exclusive
   team.identity.json publish, then committed index/checksum. Persist directory fingerprint and
   binding evidence in the intent so recovery distinguishes retry, import and tampering without a
   name-based guess. Resolve legacy cwd/projectPath against exactly one enabled
   WorkspaceRegistration and persist initial TeamWorkspaceBinding generation; zero/ambiguous match
   is unbound/read-only, and conflicting config/team.meta evidence is mismatch/read-only. The
   identity anchor is the only new Phase 2 file emitted into a legacy team directory; coordination
   records remain in internal-storage/backup state. Unwritable, duplicate,
   corrupt, future, missing-after-commit or file/index-mismatched identities yield an explicit
   blocked/read-only state, not fake parity or automatic ID replacement.
5. Create the minimal `team-lifecycle` contracts/domain/application/adapters needed for ListTeams,
   GetTeamLifecycleSnapshot, runtime read projections, CreateTeamDraft and DeleteTeamDraft. Draft
   creation extends the ADR-6 intent across verified team.meta/members.meta projections and commits
   one draftGeneration/checksum set; partial projections recover before visibility. Draft commands
   are wired only to desktop/test adapters in this phase and cannot bypass the identity protocol.
6. Add an Electron compatibility adapter over TeamDataService/current runtime reads and a separate
   hosted context-bound read repository reusing pure parsers. Preserve the round2 provisioning
   decomposition; do not instantiate global-root TeamDataService in hosted composition.
7. Make existing IPC read handlers delegate to the extracted use cases and keep legacy teamName DTO
   mapping inside the IPC compatibility adapter.
8. Add canonical hosted read adapters using teamId/workspaceId only. They remain loopback/test-only
   until hosted authentication passes.
9. Shadow-compare old and new projections over current/legacy/corrupt fixtures without dual writes.
10. Remove route-level config.json existence checks, cache invalidation and runtime overlays from the
    new read adapter; those semantics belong in the use case/adapters.

Exit gate:

- IPC and test HTTP adapters call the same read use cases;
- no use case imports @main, Electron, Fastify, child_process, fs, or path;
- anchored team/workspace IDs survive restart, rename/display-name changes and legacy adoption;
- CreateTeamDraft reserves TeamId+LegacyTeamKey atomically; browser traffic uses only returned TeamId,
  and deleted/case-colliding/unsafe keys cannot be silently reused, renamed or cross-attached;
- no identity file is published until legacy create failure, draft/permanent delete, backup/restore/
  prune and same-name resurrection paths preserve or durably tombstone it; architecture tests reject
  bypassing recursive team-root deletion;
- an accepted draft has one TeamId across prepare/launch failure and retry; provisioning cleanup is
  attempt-scoped, while only pre-draft failure or explicit DeleteTeamDraft can remove its root;
- crash before identity publish, after publish/before commit and after commit repairs or blocks
  according to the ADR-6 matrix; prepared-without-file, file-without-row, row-without-file,
  checksum mismatch, duplicate/corrupt IDs and identity_unanchored teams expose no hosted mutation
  capability until the specified recovery/repair completes;
- zero/ambiguous workspace adoption and later external config path drift produce unbound/mismatch,
  never an implicit rebind or spawn cwd;
- WorkspaceId survives a full container restart by registrationKey while mountGeneration advances;
  prior-boot grants/refs are rejected and a changed declared root is not mistaken for remount;
- no canonical browser read contract carries raw teamName/projectPath;
- desktop list/detail/runtime projection regressions remain green;
- desktop createConfig/deleteDraft delegate to the identity-aware draft use cases with legacy DTOs;
- hosted mutation capabilities remain absent.

### Phase 3: durable mutation and external-writer compatibility

Estimated change: 5,000-8,500 lines.
Complexity: 9/10. Risk: 9/10.

Tasks:

1. Freeze the persisted-file/provider-artifact ownership catalog and golden fixture corpus.
2. Implement the prepared -> running -> committed/recovering/failed/operator_required mutation
   protocol, lease-fenced recovery ownership, outbox commit and command status lookup in
   internal-storage. Implement ADR-23 read-only schema preflight and idempotent migration journal
   before any migration/recovery writer opens; unknown or non-drainable records fail closed.
3. Add feature-keyed coordinators and compatibility repositories preserving Claude/provider layouts
   and unknown fields. Do not expose a global filesystem repository.
4. Serialize ConfigManager writes and expose flush/failure state.
5. Add intent recovery for multi-file invariants and parent-directory durability where supported.
6. Add read-only compatibility scan, free-space/permission/filesystem capability probe and
   desktop/foreign app-writer detection. Phase 3 may open a writer only after the composition proves
   it was launched by ADR-16 with the expected held descriptor, root-owned stable anchor and matching
   deployment/state binding; there is no application-created lease path or stale-marker takeover.
7. Implement the bounded external-writer observation algorithm: watch-before-scan barrier,
   stat/read/stat stability, checksum-based self-write suppression, overflow/dirty scopes, scoped
   periodic rescan and shutdown handoff. Persist ADR-24 observation sequence/watermark,
   ExternalFileActor attribution and per-TeamId fileWriterEpoch; generic file events never inherit
   currentRunRef implicitly.
8. Implement ADR-32's durable BackupRun workflow and `coordination_backup`: fence its own app writers,
   flush repositories/outbox/journals, invoke only the proven SQLite Online Backup API driver, reopen/
   integrity-check the snapshot, inventory each identity file and publish a hash-bound commit marker
   last. Add typed feature backup participants and exclusions now, but do not advertise full
   `deployment_recovery_point` until every external-writer participant can quiesce in Phase 10.
   Restore validation stages the complete set against IDs/tombstones/workspace registrations and
   exposes no mapping on duplicate, missing or disagreement. Legacy copies remain
   `legacy_unverified`; no validity/mtime merge or automatic partial restore enters hosted mode.
9. Keep new internal-storage coordination contracts/core free of @main types and add transactional
   migrations for app-owned tables. Existing main-layer legacy journal adapters may keep deliberate
   @main dependencies until their owning feature migrates; do not broaden this phase into rewriting
   unrelated storage adapters. Hosted has no silent critical JSON fallback.
10. Prove crash recovery at every mutation protocol boundary, including asymmetric task relations,
    config replacement, launch-state/summary disagreement and external writer races.
11. Implement ADR-34 descriptor registries and versioned HMAC command fingerprints. Persist an
    ordered effect plan/state/evidence version per operation and permit automatic retry/compensation
    only through its declared proof. Add retained-old-version comparison, changed-intent conflict,
    concurrent-claim and crash-at-every-effect-boundary tests; no adapter may return a generic
    `retryable` flag without descriptor evidence.

Exit gate:

- hosted tests can run two isolated RuntimeInstanceContext fixtures in one test process;
- no hosted repository resolves roots from mutable globals;
- legacy fixture round trips retain unknown fields;
- concurrent writes cannot regress to an older snapshot;
- missed/overflowed notifications, atomic replace and partial JSON writes converge through scoped
  rescan without emitting a corrupt revision or recursively scanning unrelated roots;
- every timed-out mutation is queryable as
  prepared/running/committed/recovering/failed/operator_required;
- same key/same normalized intent converges across reload and compatible binary upgrade, changed intent
  is rejected, and every `attempting` external effect either proves deduplication/absence/compensation
  or remains operator-required without a second effect;
- two final-image compositions against one provisioned root prove one kernel owner and zero loser-side
  Node startup/migration/write/recovery; pausing the winner or deleting diagnostic metadata cannot
  permit takeover, while clean full-container exit permits exactly one successor;
- coordination backups are immutable/verified and crash-safe at every BackupRun transition, while
  full recovery-point capability truthfully remains unavailable with an active/unclassified writer;
- no process/runtime launch is enabled yet.

### Phase 4: team-runtime-control feature and lifecycle coordination

Estimated change: 4,200-7,000 lines.
Complexity: 9/10. Risk: 9/10.

Tasks:

1. Create `team-runtime-control` around the existing TeamRuntimeAdapterRegistry, split provisioning
   runtime modules, existing runtime-control service and team-runtime-lanes; do not duplicate
   runtime-provider-management.
   First wrap the current provisioning execution as one compatibility backend, then move provider
   branches behind the target registry one at a time. Never run old and new launch planners in
   parallel for the same command.
   The v1 end state is exactly ProvisioningCliExecutionBackend for Anthropic/Codex/Gemini and
   OpenCodeExecutionBackend for OpenCode. The former initially delegates to the target-base
   deterministic provisioning flow. Replacing that flow or executable is out of scope unless a new
   ADR, characterization suite and rollback path are accepted before implementation continues.
2. Define the feature-owned ProcessSupervisorPort, then ratchet direct spawn/signal callsites into it.
   Desktop reuses vetted target-base spawnCli/killProcessTree/Job Object helpers in its compatibility
   adapter. Hosted must use ADR-31 anchor/control pipes and may not route through the weaker Node PID
   adapter. Implement ADR-22 intent, handshake, ownership record and unclassified-residual admission
   block before enabling any hosted runtime.
3. Move provider selection/preflight/environment/model/auth interpretation behind provider-specific
   adapters while consuming installation/settings state from runtime-provider-management.
4. Introduce TeamRoster persistence/adoption before canonical planning: reconcile config/members.meta
   into MemberId/LegacyMemberKey/memberRevision with case/auto-suffix ambiguity blocking. Persist the
   ADR-18 CompositeRuntimePlan with exact rosterGeneration/member mapping before spawn and execute the
   exact planner result. Preserve primary-first/turn-complete/side-lane ordering, stable lane IDs,
   per-lane credentials/evidence and partial outcome aggregation; never re-plan an accepted generation
   during recovery.
5. Build OpenCode adapter composition without Electron app globals and remove the standalone-only
   denial/WeakSet boundary.
6. Split existing runtime-control into canonical machine ingress commands and an OpenCode legacy
   compatibility mapper. Remove authoritative cwd/teamName/expectedMembers/previousLaunchState from
   canonical commands; resolve them from current server-owned run/workspace state.
7. Add persisted runtime-ingress idempotency/replay state and per-lane credential lifecycle behind an
   internal adapter. Implement ADR-30 RuntimeIngressRelayPort and fixed derived lane scope; network
   registration waits for Phase 5/6.
8. Update desktop and hosted runtime launch-plan builders to target canonical machine ingress. Hosted
   gives the canonical credential only to the controller-owned relay through an inherited pipe;
   provider adapters consume a narrow local relay descriptor. Keep the legacy route behind one explicit
   loopback-only flag until provider clients and desktop regression tests migrate.
9. Extend Phase 2 `team-lifecycle` draft commands with PrepareProvisioning, LaunchTeam,
   GetProvisioningStatus, CancelProvisioning and StopTeam over the Phase 3 mutation protocol.
   Prepare remains a non-run preflight; accepted Launch atomically creates LifecycleRun plus immutable
   plan, advances TeamLifecycle.currentRunRef and opens the next fileWriterEpoch only after ADR-24
   quiescence. Every filesystem/process/provider step consumes its persisted ADR-34 EffectDescriptor;
   no generic workflow retry may repeat a launch, delivery or stop after ambiguous evidence. No
   command mutates a terminal older run.
10. Make existing IPC mutation handlers delegate to those commands; raw cwd/teamName remain only in
    legacy input/output adapters and are resolved before application invocation.
11. Extract lifecycle coordination from desktop startup wiring without undoing the target-base round2
    service/module split.
12. Run the same recovery, health, prompt-delivery watchdog, process polling, work-sync replay/scan,
    task-comment journal initialization, backup, event fanout, and stale-GC flow in hosted composition.
13. Track instance-owned process identities and never clean unrelated or merely observed PIDs.
14. Make startup rollback and shutdown idempotent.
15. Represent each background service as a lifecycle component with start/readiness/stop ownership;
    remove fire-and-forget startup work that can outlive a failed composition.
16. Implement the canonical liveness/recovery transition table and evidence precedence, separating
    historical bootstrap confirmation from current alive state.
17. Keep RunRecoveryWorkflow RunId-scoped and DeletionSaga TeamId-scoped; add architecture tests that
    neither can directly write the other's identity, draft, backup, runtime or archive repositories.
18. Implement the ADR-18 per-team legacy_drain -> canonical cutover fence. Characterize exactly which
    old status/cancel/stop paths drain one unambiguous active generation; forbid new launch/rebind/
    topology edits until terminal cleanup, and block ambiguous legacy run selection.
19. Make process execution consume a typed `WorkspaceExecutionGrant`, not a cwd string. Desktop may
    adapt that grant to its characterized local path behavior; hosted registration remains disabled
    until Phase 6 binds it to ADR-28 + ADR-31. No application use case or provider adapter may downcast
    the grant to an arbitrary path.
20. Introduce `HostedChildEnvironmentPolicy` as a provider-owned projection into the launch plan. It
    starts empty, resolves explicit provider SecretRefs at the last responsible adapter, hashes key
    provenance into each ProcessExecutionUnit/CredentialExposureSet and forbids hosted execution from
    spreading process/shell env or widening an accepted exposure set.

Exit gate:

- every provider reports an explicit capability/readiness state;
- one launch command selects exactly one execution backend; no dual planner/spawn path exists;
- an active legacy generation can only drain through its old adapter; canonical launch cannot race it,
  and ambiguous legacy candidates never become currentRunRef by newest-file heuristics;
- every accepted generation has one immutable CompositeRuntimePlan; current topologies preserve
  planner rejection, primary/turn-complete/side-lane order and partial/cancel/recovery semantics;
- every canonical lane/member resolves one TeamRoster MemberId+memberRevision; ambiguous legacy names
  block launch/member mutation instead of being merged, dropped or rebound by string comparison;
- execution and ingress registries agree on provider IDs/verbs or readiness fails for that provider;
- fake adapters can drive all lifecycle states deterministically;
- desktop create/prepare/launch/progress/cancel/stop reaches the new use cases with unchanged UX;
- canonical runtime ingress rejects raw host authority and persists idempotent acknowledgements;
- list/detail/alive/progress agree on one current run generation and liveness projection;
- hosted restart recovery/classification and stop-owned cleanup work without Electron; live
  preserve-for-adoption remains absent unless its stronger isolation gate passes;
- each fake/provider lane traverses its own ADR-30 relay, and changing body TeamId/RunId/LaneId cannot
  change derived ingress authority;
- normal stop and controller death drain through ADR-31 status/control evidence; broken/ambiguous
  anchors block admission and require container replacement without signalling an observed PID;
- shutdown stops only instance-owned processes.

### Phase 5: real hosted server composition and packaging

Estimated change: 3,200-5,500 lines.
Complexity: 9/10. Risk: 9/10.

Tasks:

1. Turn target-base `standalone.ts` into a thin entrypoint over an app-level hosted composition that
   assembles feature facades/adapters explicitly.
2. Refactor `HttpServer` so listener/static mechanics are separate from CORS/session/rate/admission
   policy and route assembly while preserving one Fastify instance.
3. Serve renderer and `/api/hosted/v1` from that existing app while retaining only explicitly
   allowlisted legacy non-team routes needed by the standalone session viewer.
4. Implement ADR-21 readiness lattice and route admission; register public live/serve-ready probes,
   authenticated capability/meta revisions and private redacted readiness diagnostics.
5. Add capability endpoint.
6. Update the existing `standalone:build` and Docker target; do not port the closed PR's static-only
   server or introduce a second hosted artifact.
7. Add persistent app state, Claude/runtime state, registered workspace, and secret mounts with
   explicit read/write policy instead of the current blanket read-only example.
8. Add startup migration/compatibility gate.
9. Replace canonical-build Electron and catch-all native stubs with ADR-17 fail-closed dependency
   rules. Emit the internal-storage worker as a production artifact, resolve its hosted SQLite driver
   to the Node ABI, stage/rebuild required provider helpers, and smoke every artifact inside
   the final image; do not rely on dist-electron paths.
10. Add bundle/artifact negative gates: an Electron deep import, missing worker, wrong-ABI SQLite,
    unstaged addon or empty native stub must fail build/readiness before route admission.
11. Publish an image capability manifest showing which provider/native binaries are actually present.
12. Wire team routes from feature facades. `HttpServices.teamApis/teamDataApi` may be used only as a
    temporary compatibility adapter, not as the final hosted composition contract.
13. Register `/api/runtime/v1` through a separate machine-ingress adapter/policy. It remains
    unavailable unless the lane/run credential store and replay fence are ready. Keep legacy OpenCode
    runtime routes loopback-only and outside the browser route/capability manifest.
14. Productionize ADR-28 as its own build-stage artifact: pin compiler/base-image inputs, emit build
    hash/protocol version, strip/copy only the executable, run it as the non-root runtime UID and make
    missing/wrong-version/wrong-architecture/blocked-syscall failures explicit readiness reasons.
15. Bundle no compiler or writable helper source in the final image. Run file and provider-exec guard
    probes against the actual mounted test workspace after privileges and seccomp are final, not only
    in the builder stage.
16. Build/package ADR-31 as a distinct protocol/hash/readiness artifact sharing only audited low-level
    source with ADR-28. Run its pidfd/subreaper/control-pipe/drain probe after final PID namespace, init,
    UID, seccomp and stop-grace settings are applied.
17. Package the ADR-30 per-lane relay as controller-owned code with no public listener. Artifact and
    import scans fail if the hosted relay bootstrap accepts a bearer from env/file/argv or if provider
    launch code reaches the canonical runtime bearer value.
18. Package ADR-16 `agent-teams-instance-lock` as a distinct pinned protocol/hash artifact and make it
    the mandatory production command between init and Node. Ship a separate one-shot volume-init
    profile/job that creates the root-owned deployment parent/anchor and runtime-owned state child;
    the main app container remains non-root and cannot self-repair unsafe ownership. Probe the actual
    local volume across two containers, preserve the lock across launcher -> Node exec/lifecycle, and
    fail the image if any child artifact inherits the reserved descriptor.
19. Add a negative image/import gate proving hosted v1 does not stage, launch or register terminal-
    platform daemon/gateway/SDK artifacts or terminal routes. Desktop packaging remains unchanged.
    Post-v1 work package T1 owns its own compatibility manifest and image delta.

Health endpoints expose only status/reason codes required by the orchestrator, never roots,
provider credentials, team names, or exception text. Metrics/diagnostics bind privately and require
operator authorization when exposed beyond the container network.

Exit gate:

- built production artifact returns both renderer and real hosted health/API;
- Docker returns the canonical API from the same Fastify process;
- clean machine/container startup requires no source checkout;
- final image starts only through ADR-16, rejects a competing container before Node, starts the emitted
  internal-storage worker, executes a SQLite write/read/reopen probe, loads each required native/helper
  artifact, passes ADR-28 and ADR-31 final-topology probes, proves the ADR-30 relay/environment and
  lease-FD negative scans and contains no reachable Electron/empty-native stub;
- until Phase 6 security passes, non-loopback team mutations remain unregistered and the image is
  test-only, not advertised as production-ready.

### Phase 6: authentication, authorization, and workspace isolation

Estimated change: 3,200-5,500 lines.
Complexity: 9/10. Risk: 10/10.

Tasks:

1. Create `hosted-access` public contracts/core/adapters and implement PairingChallenge,
   OperatorDeviceGrant and OperatorSession repositories/migrations with keyed hashes,
   family/generation, server-side idle/absolute/renewal expiry, revocation and restore exclusion. Add
   the fsync'd auth.keyring lifecycle and pin the then-current reviewed Fastify-5-compatible
   `@fastify/cookie`; no stateless signed-cookie authority. Core imports no Fastify/fs/team-runtime
   internals and consumes only public residual-drain evidence. Keep OIDC as a later issuer, not a
   second partially implemented login mode.
2. Implement initial pairing and host-controlled `pairingResetGeneration`: startup-only generation
   consume, grant/session revocation, mutation admission close, ADR-31 runtime drain proof, atomic
   challenge file issue/consume/expiry/retry and zero plaintext when residual state is ambiguous.
3. Implement production cookies and auth flows: path-scoped durable device grant, short host session,
   renew/rotation predecessor grace and replay-family revocation, logout versus Forget this device,
   multi-tab/response-loss recovery and ordinary backend-restart continuity.
4. Add derived session-bound CSRF bootstrap/verification and strict configured Origin/authority
   validation before parsing/idempotency/commands.
5. Remove wildcard credentials behavior in production.
6. Rate-limit pairing/renew/session lookup and destructive endpoints with global plus trusted-client
   buckets that do not accept spoofed forwarded IP.
7. Apply the browser session/data-redaction boundary to every retained browser route, including
   allowlisted legacy non-team session/project reads, in loopback and hosted modes. `127.0.0.1`, a
   `?port=` parameter, or CORS is not authentication against a malicious website/DNS-rebinding flow.
8. Implement opaque per-lane/run runtime ingress credential issue/hash/verify/rotate/revoke
   lifecycle, verb scopes, constant-time comparison, request size/rate limits and persistent replay
   fencing.
9. Implement ADR-30 relay issuance/bootstrap/rotation/revocation. Pass the canonical bearer only over
   the inherited relay pipe, never provider env/file/argv/settings. Build every hosted child env from
   its provider allowlist and SecretRefs; apply deny-in-depth/redaction and provenance checks.
10. Wire hosted manifest/mount adapters into `workspace-registry` and enforce its authorization query
    for every workspace-bound operation.
11. Enforce opaque resource references and mint an operation-specific ADR-25
    WorkspaceAccessGrant. Every v1 registered-workspace read/write/list/review/Git/spawn adapter
    must consume that grant through the exact ADR-28 verb; no adapter may unwrap a host path and call
    Node fs/child_process directly. Keep an operation
    unadvertised when its final-image guard probe cannot close the relevant race.
12. Block hosted HTTP changes to CLAUDE_ROOT and arbitrary project paths.
13. Add outbound provider URL/SSRF policy.
14. Centralize redacted safe errors and audit events.
15. Require explicit normalized HTTPS PUBLIC_ORIGIN. Trust Forwarded/X-Forwarded-\* only from exact
    proxy CIDRs, reject ambiguous chains and never derive authority from them. Replace direct public
    HTTP Compose with a private app listener plus TLS edge; label loopback demo as non-production.
16. Ensure auth/API/bootstrap responses are no-store, hashed static assets alone are immutable, and
    caches/service workers cannot retain authenticated state. Rotate CSRF with the session.
17. Define expiry/recovery UX: accepted runtimes remain server-owned, mutations freeze, device renew
    obtains fresh session/CSRF/meta/snapshot, and only missing/revoked device authority enters the
    host-reset pairing instructions. 401/SSE close never implies team deletion/runtime stop.
18. Enforce the trusted-process profile: pairing material is created only after residual-runtime
    classification/stop, runtime children receive no browser/controller secret, capability/meta names
    the isolation level, and preserve-for-adoption stays unavailable without separate OS isolation.

Exit gate:

- unauthenticated HTTP/SSE fail closed, and v1 registers no WS upgrade route;
- cross-origin mutation fails;
- pairing creates one durable device family and short session; ordinary server/container restart
  preserves valid browser authority without writing a new pairing token;
- idle/absolute session expiry renews from the device grant with fresh cookie/CSRF/meta/snapshot;
  concurrent tabs and lost rotation responses converge within bounded predecessor grace, while replay
  after grace revokes the family;
- lost/revoked device authority can recover only through a newer host-controlled reset generation,
  and no challenge exists until every v1 runtime is drained or the container is replaced;
- browser never receives server credential or authoritative host path;
- browser session cookies cannot authorize runtime-ingress routes;
- missing/forged/revoked/stale-generation/wrong-run/wrong-lane runtime credentials and conflicting
  idempotency reuse produce zero provider/team mutation and zero outbox event;
- a valid runtime credential cannot approve its own tool request, change policy, control another
  lane, launch/stop/delete or register workspace;
- provider processes receive no canonical runtime bearer or controller/browser secret in env, argv,
  generated settings/MCP config, stdout/stderr or artifacts; secret-canary scans and environment-key
  snapshots prove this for every backend;
- each relay derives one immutable lane scope and ignores/rejects body authority. Under
  `trusted_process`, tests/docs do not claim the local relay is secret from a malicious same-UID sibling;
- canonical runtime ingress cannot supply authoritative cwd/teamName/member topology/launch state;
- invalid workspace produces zero spawn attempts;
- external config projectPath/cwd drift cannot rebind TeamId/WorkspaceId or change spawn/file/Git
  authority; it produces workspace_binding_mismatch and zero affected mutation;
- duplicate/overlapping writable roots, same-key path rebinding, missing mounts and manifest schema
  mismatch keep mutation readiness false without changing existing WorkspaceIds;
- traversal, symlink, UNC/drive/case edge tests pass;
- an active symlink/rename/bind-mount adversary cannot cause an outside-root read/write/cwd, and
  missing/blocked/wrong-version ADR-28 guard produces zero workspace effect and a precise capability
  downgrade rather than a path-string fallback;
- allowlisted Git worktree/review operations cannot execute fixture hooks, helpers, pagers,
  fsmonitor, credential prompts or network remotes;
- a residual live/unknown runtime blocks plaintext pairing creation; the default deployment reports
  trusted_process rather than claiming hostile-runtime containment.
- production pairing/renew/SSE succeeds only through the configured HTTPS PUBLIC_ORIGIN and trusted
  proxy CIDRs; spoofed/multiple forwarded headers, direct HTTP and a sibling port/authority fail before
  auth lookup. The production Compose exposes only its TLS edge.

### Phase 7: first vertical browser lifecycle

Estimated change: 2,500-4,000 lines.
Complexity: 8/10. Risk: 8/10.

Flow:

    login
      -> workspace list
      -> team list
      -> team detail
      -> create draft
      -> prepare
      -> launch fake runtime
      -> poll/stream provisioning
      -> runtime state
      -> stop

Tasks:

1. Implement real hosted HTTP adapters and DTO projections for the flow.
2. Add idempotency and revision behavior.
3. Wire browser transport credentials/session behavior.
4. Implement ADR-27 receipt-before-send, actor-scoped status resolution, bounded local recovery and
   multi-tab receipt convergence; persist no mutation body or sensitive fields.
5. Make each repository-owned fake runtime lane receive its real lane/run-scoped ingress credential
   through the launch adapter and call real `/api/runtime/v1` bootstrap/heartbeat/delivery endpoints;
   no test-only callback backdoor.
6. Split renderer teamRead/teamLifecycle/provisioning facets and create the capability-first hosted
   renderer composition that registers only their owned listeners/effects.
7. Remove the blanket TeamListView Electron gate while keeping desktop-only editor/chooser/shortcut
   subtrees unmounted and unreachable from the hosted route chunk.
8. Gate every action by server capability.
9. Replace throw/no-op/fake values for supported lifecycle methods.
10. Add meaningful degraded/error UI.
11. Introduce TeamTransportReconciler for scope/cursor/routing and route IPC, HTTP, SSE and fallback
    polling through it into feature-owned reconcilers.
12. Preserve request scopes, context/team generations, optimistic-run replacement, terminal
    tombstones, and structural-sharing behavior with the existing characterization suites.
13. Replace raw projectPath browser cache keys and auto-selection with workspaceId/repositoryId
    projections while preserving desktop legacy mapping in its adapter.
14. Add localized login/capability/degraded/reconnect/error states and keyboard/focus/ARIA coverage;
    no required action may depend on an Electron-only shortcut.
15. Replace first-flow direct platform calls with WorkspaceRegistry selection, browser-safe external
    navigation, Blob/File handling, organization facet gating and opaque process controls.

Exit gate:

- real built browser performs the full flow against a real server listener;
- network log contains no unexpected 404, 401, or 500;
- late responses/events from a previous context/run cannot change the visible team;
- no supported lifecycle action uses a browser-mode stub;
- unavailable desktop subtrees/effects/listeners are not mounted or reachable from the hosted team
  route chunk, and every rendered control uses a supported typed facet/action;
- fake runtime bootstrap/heartbeat/delivery traverses authenticated machine ingress and legacy
  `/api/teams/:teamName/opencode/runtime/*` is unused by hosted E2E.
- refresh/direct SPA navigation serves the app shell and restores a safe selected view without raw
  host data in the URL.

### Phase 8: tasks, Kanban, messages, and external JSON reconciliation

Estimated change: 2,800-4,800 lines.
Complexity: 9/10. Risk: 8/10.

Tasks:

1. Create `team-task-board` and `team-messaging` around current task/Kanban/inbox writers and runtime
   delivery APIs; reuse member-work-sync and agent-attachments through public facades.
2. Implement task create/read/update/status/owner/relationships.
3. Implement Kanban ordering with revision checks.
4. Implement paginated message/inbox read and send.
5. Add provider delivery status for OpenCode.
6. Emit domain events from application mutations.
7. Reconcile agent-written filesystem changes into domain events.
8. Add per-team event revisions and replay journal.
9. Implement snapshot-first SSE client reconciliation.
10. Preserve serialized message head/older-page fetching and one required follow-up refresh.
11. Make watcher self-write suppression operation-aware and verify an immediately racing external
    JSON observation is not mislabeled as the app's own checksum. This test does not authorize
    uncoordinated direct mutation or claim recovery of overwritten bytes.
12. Enforce ADR-24 attribution: team-scoped Claude-compatible changes never gain current RunId/member
    identity, while catalogued OpenCode run artifacts must pass VerifiedRunEvidence validation.
13. Test event, poll, and command response permutations against the same pure reducers.
14. Enforce ADR-29 per operation. App-exclusive and proven cooperative mutations use their declared
    protocol; uncoordinated active-run changes become provider-mediated workflows with observed
    outcomes or quiescent-only controls. Do not preserve the desktop illusion of immediate success.
15. Add the hostile fake writer at pre-read, post-intent, pre-publish, post-publish and watcher-
    overflow boundaries. Prove direct unsafe mutation is denied and no stale request is replayed
    automatically after quiescence.

Exit gate:

- admitted task/message changes commit exactly once; provider-mediated changes report success only
  after observation; uncoordinated active direct mutation is visibly unavailable rather than risking
  a lost update;
- reconnect does not lose or duplicate visible transitions;
- multi-file task relationships remain symmetric after failure/restart.
- old writer epoch notifications cannot appear as new-run activity, and relaunch remains blocked until
  previous process/watcher quiescence is durably closed.

### Deferred post-v1 work package T1: terminal workspace parity

Estimated change: 6,500-11,500 lines across this repo plus the pinned terminal-platform source/SDK.
Complexity: 10/10. Risk: 10/10.

During v1 execution, skip this section and continue directly from Phase 8 to Phase 9 below. This work
package is excluded from v1 scope, estimate, critical path, image and Definition of Done.
It starts only after the non-terminal v1 release or an explicit user reprioritization. Its first gate is
to rebase the ADR-35 research against the then-current app/terminal-platform sources and recheck all
external dependency versions; the estimates and contracts below are not treated as timeless.

Tasks:

1. Deliver the required terminal-platform changes first: exclusive boot-scoped filesystem socket,
   protocol/build/BootId/TerminalRuntimeId/spawnNonce handshake, boot-key-authenticated local hosted
   launch requests, `GuardedShellLaunchSpec`, a fixed inherited envelope/status-FD portable-pty spawn
   primitive, `--require-persistence`, bounded local frames/connections, environment-clean daemon/shell
   launch, typed close-all/drain evidence and the paired-socket transport hook that replaces independent
   reconnect. Keep generic launch intact for desktop but unreachable from hosted ingress. Pack and pin
   new runtime/SDK artifacts; do not patch only generated tarballs in this repo.
2. Replace deterministic teamName runtime slug/reuse with TerminalRuntimeSupervisorPort and durable
   spawn/ownership intent. Launch terminal-daemon under ADR-31 low-level anchor mechanics from neutral
   cwd, verify socket/store/nonce evidence and never adopt a ready foreign daemon.
3. Implement TerminalChildEnvironmentPolicy from empty input and final-image secret canaries for both
   daemon and portable-pty shell. Default hosted terminal receives no provider/controller credentials.
4. Implement HostedTerminalFacade rather than exposing WorkspaceTransportClient. Server creates a
   native session with manifest-approved shell/argv and ADR-28 initial-cwd grant, converts it to bounded
   `WorkspaceLaunchEvidenceV1`, and waits for persisted nonce plus guard verified/exec evidence before
   advertising readiness. `launch_ambiguous` drains and requires explicit status/recovery; it never
   retries a shell automatically. Omit import/discover/saved-session/override-layout/detach operations
   and their UI controls under hosted capabilities.
5. Add authenticated CSRF-protected bootstrap/regrant/close endpoints accepting TeamId/WorkspaceId only.
   Persist TerminalAccessSession plus one-writer attachment and binding/mount/policy generations; body
   and response contain no host path, launch spec, runtime slug, daemon address or grant secret.
6. Pin the reviewed Fastify-5-compatible `@fastify/websocket` and implement ADR-35's `__Secure-`
   path-scoped two-plane grant on the existing listener. Atomically claim control/stream slots, require
   fixed subprotocol and exact Origin/session/generations, hold frames until both bind, erase the digest
   on pairing, reject replay/third sockets and use HTTP regrant before every reconnect.
7. Add a hosted renderer transport lifecycle around the existing workspace kernel/protocol codecs.
   `HostedTerminalSocketPairFactory` opens both planes, waits for both ready envelopes, then hands the
   connected pair to the adapter. Sibling-plane close disposes the pair, authenticated regrant creates
   a fresh adapter/generation and no already-fired `open` event is awaited. Enforce one writer pair and
   15-second detached grace.
8. Replace object-only gateway validation with exhaustive per-method schemas, ownership checks and the
   ADR-35 method/resource/rate budgets. Unknown methods/fields, browser launch authority and cross-
   session pane/tab/subscription IDs must not reach terminal-platform. Add clientCommandId/payload
   conflict/result dedupe for structural commands; input/paste acknowledgement loss is delivery_unknown
   and never auto-replayed across a connection generation.
9. Configure inbound maxPayload, text-only/no-compression, serialized control queue, resize coalescing,
   send completion, heartbeat and slow-client close. Implement `HostedProjectionPolicy`, disable hosted
   raw-output/inline-media bytes, cap every local frame and use latest-value/coalescing subscription
   lanes with a proven aggregate byte budget. At the WebSocket high watermark cancel the daemon
   subscription; below low watermark reopen with a budgeted full-replace generation rather than draining
   stale deltas. Instrument only safe counters/reason codes; never record terminal bytes, command
   history or cookie values.
10. On explicit close/logout/session expiry/workspace generation change, revoke the pair and drain the
    owned runtime. On network loss, permit only bounded detached grace. Persist guard/anchor/runtime/
    store identity and per-session drain evidence; `drain_unconfirmed` disables further terminal
    admission and requires container replacement.
11. Run the final HTTPS edge/browser/container matrix plus deterministic terminal-platform fixtures:
    arbitrary launch/import/layout attempts, wrong Origin/cookie/subprotocol, both-plane order/races,
    response loss, reconnect, duplicate tab writer, frame flood, non-reading browser, rich Unicode/
    styled/media output, projection truncation/full-replace convergence, ping loss, persistence
    corruption, socket collision, daemon crash, shell background jobs/setsid/double-fork and repeated
    shutdown. Assert bounded transport RSS/queues. Use only new sandbox projects.

Exit gate:

- browser opens a native terminal only for an authorized TeamId/WorkspaceId and receives no raw launch,
  host-path, daemon or secret authority;
- server-selected shell starts at the ADR-28-verified initial cwd, while documentation/UI correctly
  state that the shell is confined by container mounts rather than pretending cwd is a sandbox;
- current controller/provider/auth/lease canaries are absent from daemon and shell environments;
- control/stream pair, echo/input/paste/resize/split/tab/close and authenticated HTTP regrant pass via
  the real HTTPS browser boundary; expired/reused/wrong-plane/wrong-team/wrong-generation grants fail;
- arbitrary program/args/cwd/backend/import/restore/layout methods and cross-session IDs produce zero
  terminal-platform call or process effect;
- 64 KiB ingress, queue/rate/resource budgets, 1 MiB output watermark, heartbeat and slow-client
  policies keep memory/CPU/socket counts within the reference budget under flood;
- daemon/store/socket ownership cannot attach/overwrite a foreign or prior-boot runtime, and required
  persistence failure removes terminal readiness rather than falling back in memory;
- explicit close, detached-grace expiry, controller/daemon crash and repeated SIGTERM yield typed
  drained evidence for every required PTY/job fixture. No routine terminal path relies on container
  replacement; an unproven escape closes readiness and is honestly classified.

### Phase 9: logs, review, approvals, member management, and required parity

Estimated change: 2,800-5,000 lines for the required release matrix.
Complexity: 9/10. Risk: 9/10.

Required tasks:

- bounded logs/activity by extending member-log-stream and current exact-log readers;
- failure diagnostics;
- review read/apply flows;
- tool approval snapshot/events/idempotent decisions, server-persisted policy, and safe file refs;
- member add/replace/remove/restore/restart/skip through TeamRoster MemberId + expected
  rosterGeneration, with legacy memberName mapping confined to IPC/provider adapters;
- attachments through agent-attachments with quota, MIME, containment, and hosted download/preview UX;
- deletion/restore;
- maintenance-mode identity integrity diagnostics and the narrowly bounded ADR-6 repair command;
- task comments, relationships, clarification, review state, and exact-log flows;
- selected cross-team operations through organizations/current CrossTeamService adapters where
  included team screens require them;
- compose the existing running-teams projection rather than rebuilding dashboard runtime state.

Every promoted capability receives:

- application port/use case;
- HTTP adapter;
- renderer facet;
- security policy;
- focused tests;
- browser E2E assertion.

Exit gate:

- no required team capability remains a stub;
- reload/multi-tab approval handling cannot lose, duplicate, or double-answer a request;
- every included web team screen is fully operable or deliberately capability-gated at control level;
- desktop-only exceptions are absent or clearly explained before interaction;
- raw paths/provider secrets are not exposed.

### Phase 10: production hardening and rollout

Estimated change: 2,700-4,800 lines.
Complexity: 8/10. Risk: 8/10.

Tasks:

1. Structured logs with requestId/runId/teamId correlation.
2. Safe error diagnostic IDs and systematic redaction.
3. Metrics for HTTP, SSE, watchers, queues, provisioning, and owned processes.
4. Complete ADR-21 readiness dimensions, RouteDescriptor admission and safe reason/revision events.
5. Graceful shutdown state machine:
   - close mutation/runtime admission while ADR-16 remains held;
   - readiness false;
   - stop new mutations;
   - drain HTTP/SSE;
   - apply the explicit stop-owned default or validated preserve-for-adoption capability;
   - flush journals;
   - exit Node; the instance-lock launcher releases only as the controller/container lifecycle ends;
   - exit before deadline. Never unlink or replace the lease anchor as shutdown signaling.
6. Non-root application container user plus an explicit privileged one-shot volume-init step. The main
   container cannot create/chown/repair the ADR-16 deployment parent or anchor.
7. Read-only root filesystem, tmpfs, cap_drop, no-new-privileges.
8. Resource limits and stop grace period.
9. Private app/runner network and public edge only.
10. Generate/verify ADR-23 StateCompatibilityManifest in the built artifact and publish the typed
    backup/migration/drain/rollback-or-refuse runbook.
11. Feature flag and emergency hosted read-only mode.
12. Keep metric labels low-cardinality; team/task/run/request identifiers belong in sampled traces or
    structured logs, not Prometheus labels.
13. Cover writer lease, schema scan, workspace registry, journal recovery, server listeners,
    lifecycle components and provider backends. Prove one failed dimension cannot
    incorrectly enable or disable unrelated routes; optional provider failure never makes login/read
    UI unready.
14. Add bounded log rotation/retention and audit retention/export policy.
15. Complete ADR-32 `deployment_recovery_point`: close mutating admission, drain commands, stop/refuse
    uncoordinated writers with ADR-31 evidence, close ADR-24 watermarks, freeze participant generations,
    publish SQLite plus descriptor-read file stages with manifest/commit marker last, then safely
    release the fence. Exercise crash/disk-full/hash-drift/prune failures at every state. Test ADR-26
    replace_deployment into clean state/CLI roots, including full pre-activation validation, cross-root
    journal crash recovery, preserved stable IDs, rotated boot/event/session/credential state and
    explicit fork/non-empty/legacy-unverified refusal; do not test only backup creation.
16. Freeze a reference-scale fixture and latency/memory/event-loop budgets for cold team list,
    detail, task/message pagination, launch progress, and reconnect replay. Run a bounded load test
    with multiple browser tabs and a slow client.
17. Remove synchronous filesystem/process-table work from HTTP/event hot paths or isolate it behind
    bounded workers; propagate cancellation and cap concurrency/queues.
18. Run built-artifact N -> N+1, interrupted migration resume and N+1 -> N
    in-place/drain/restore/refuse scenarios against copied production-shape state.
19. Prove ADR-33 handoff under reference-scale concurrent mutations, watcher overflow, retention
    advancement, slow snapshot construction, response loss and SSE reconnect. No event may disappear;
    duplicate replay must converge by revision/generation without an unbounded retention pin.
20. Prove rolling replacement is stop-then-start for each deployment root: a candidate stays blocked
    before Node while the old controller is paused/draining, then acquires only after every old lock-FD
    duplicate is closed. Document distinct operator recovery for a wedged old container; never delete
    the anchor, edit diagnostic metadata or enable overlap as a rollout shortcut.
21. Verify the v1 production image, RouteCatalog, capability manifest, renderer chunks, migrations and
    startup contain no hosted-terminal route/artifact/dependency. This is an absence gate, not a stub.

Exit gate:

- clean Docker restart retains valid state;
- two-container rolling replacement never overlaps controllers: candidate remains pre-Node until the
  old launcher and Node have both released their duplicated lock description;
- hosted terminal is `not_offered`: no route, daemon, socket, store or UI effect exists in v1;
- repeated SIGTERM is safe;
- partial startup failure rolls back;
- production logs/API contain no secrets or host paths;
- rollback to the previous image and state schema is documented and tested.
- the exact previous built image either starts in a proven compatible mode or refuses before write;
  source-level assumptions and feature flags are not accepted as rollback evidence.

## Critical path and parallel dependencies

The critical path is:

    Phase 0 decisions
      -> Phase 1 contracts
      -> Phase 2 identities + read-only lifecycle
      -> Phase 3 durable mutation protocol
      -> Phase 4 runtime control + lifecycle commands
      -> Phase 5 hardened existing standalone composition
      -> Phase 6 auth/workspace security
      -> Phase 7 first browser lifecycle
      -> Phase 8 tasks/messages/events
      -> Phase 9 full team parity
      -> Phase 10 release hardening

Post-v1 T1 terminal is deliberately outside this chain. Do not use spare capacity to start it while a
v1 critical-path or release-gate task remains; preserving the architecture seam is sufficient.

Safe parallel work:

- Phase 3 provider/file fixture inventory can begin during Phase 2, but mutation code waits for
  stable identities and the ownership catalog.
- Phase 4 fake provider executables can be prepared beside Phase 3 repositories, but lifecycle
  commands wait for the recovery protocol.
- Phase 5 Docker asset/build audit can begin early; team route wiring waits for feature facades.
- Phase 6 security tests can be written before implementation, but mutations stay disabled.
- Renderer facet scaffolding can proceed after Phase 1; state authority migration waits for Phase 2
  read projections and transport/feature reconciler fixtures.
- E2E harness scaffolding can begin early, but it must target the real composition from Phase 5.

Unsafe parallel work:

- client and server inventing DTOs independently;
- multiple workers editing HttpAPIClient, TeamListView, or teams IPC without file ownership;
- enabling browser mutations before auth/workspace policy;
- building terminal protocol independently from terminal-workspace;
- migrating persistence while provider/lifecycle authority is still ambiguous.

## Real end-to-end verification design

### Level 1: deterministic PR E2E

Must use:

- built production renderer;
- built production server or Docker image;
- an ephemeral HTTPS reverse-proxy edge in front of the private app, using the production forwarded-
  header allowlist/origin policy. Playwright may trust the harness certificate, but the application
  still receives an https canonical origin and uses the real Secure `__Host-` cookie path;
- real TCP listener;
- real browser automation;
- real HTTP/SSE network;
- real temporary filesystem;
- newly created sandbox git workspace;
- temporary CLAUDE_ROOT/app data;
- deterministic fake runtime executable below the real adapter/process-supervisor boundary.

Application/unit tests may use an in-memory fake adapter. The release browser E2E must exercise the
real composition, process ownership, stdout/stderr parsing, filesystem reconciliation, cancellation,
and shutdown through a repository-owned fake executable. Scenario inputs are test-harness-owned and
allow success, delayed bootstrap, partial member failure, approval request, external task/inbox
write, malformed output, child-process tree, ignored TERM, and crash. The browser cannot choose an
arbitrary scenario executable or path in production contracts.

The harness creates its own temporary state/workspace root with a unique run marker and refuses
launch, attachment, review or cleanup when canonical paths are outside that root or the
marker/runId does not match. It never accepts an existing repository path from environment defaults.
Cleanup deletes only marker-owned resources and reports leftovers instead of broad process/path
cleanup. This guard is tested with a known non-sandbox path and must fail before spawn/read/write.

Browser automation is not currently a root project dependency. Before adding a CI runner,
verify the latest stable Playwright version and pin it through pnpm. Local in-app browser tools
may assist debugging, but the release gate must be repository-owned, reproducible, and runnable
headlessly in CI.

Must not use:

- fake fetch at the browser/server boundary;
- MockEventSource;
- real user projects;
- real provider agents;
- shared ~/.claude state.
- an insecure-cookie production switch or browser-side injection of session cookies/tokens.

Required flow:

1. start deployment;
2. login;
3. enumerate registered sandbox workspace;
4. create team;
5. launch fake provider;
6. observe provisioning via SSE;
7. create/update task;
8. write a simulated agent-side JSON change;
9. observe reconciliation;
10. send/receive message;
11. disconnect/reconnect SSE;
12. reload browser;
13. stop team;
14. restart the complete production container lifecycle, not only the Node process;
15. verify persisted/reconciled state and zero orphan processes under the required stop-owned policy.

If preserve-for-adoption is advertised by a deployment backend, a separate gated suite restarts the
backend while a fake run is active and proves stable identity adoption. It is not part of the common
path and cannot silently fall back to PID/tmux guessing.

That lifecycle flow is necessary but not sufficient for release. Repository-owned browser tests
must also cover the required parity matrix in smaller debuggable suites against the same real
network/deployment boundary:

| Suite                     | Required proof                                                                                                                                                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Team lifecycle            | create/configure/prepare/launch/cancel/relaunch/stop, failure diagnostics, stable TeamId across failed-run retry and explicit draft deletion                                                                                                                                           |
| Workspace lifecycle       | stable WorkspaceId with fresh mountGeneration after full container restart, stale file/review refs rejected, same-boot remount disables effects and changed registration root refuses startup mutation                                                                                 |
| Workspace effects         | built ADR-28 guard performs bounded read/write/review/Git/provider operations; concurrent parent/symlink/root/bind-mount swaps yield zero outside-marker effect; missing/blocked guard removes capabilities without fallback                                                           |
| Command recovery          | ADR-27 receipt-before-send without body/secrets, timeout before commandId, reload/logout/re-login/multi-tab resolution by stable actor/key, immediate versus workflow-starting semantics, stable workflowRef, later workflow failure, mismatched-body conflict and no duplicate effect |
| Composite runtime         | all five current lane modes, planner rejection, primary-before-side-lane gate, duplicate turn-complete, partial failure, cancel/restart at each gate                                                                                                                                   |
| Process ownership         | ADR-31 anchor ready/control EOF/parent death/main exit/double-fork/TERM/grace/KILL/drained evidence, pidfd PID-reuse refusal, unclassified residual block and hard whole-container replacement with zero surviving fake-runtime tree                                                   |
| Task board                | create/edit/assign/start/status/Kanban order/comment/clarification/relationships/delete/restore                                                                                                                                                                                        |
| Messages                  | send, pagination, pending reply, provider delivery result, external inbox write                                                                                                                                                                                                        |
| Members                   | MemberId-based add/replace/remove/restore/role/restart/skip, stale rosterGeneration, memberRevision/lane-attempt fencing, ambiguous legacy names and historical owner/log projection                                                                                                   |
| Realtime                  | ADR-33 cursor-before-snapshot and same-transaction handoff schedules, mutation at every read/serialize/attach boundary, duplicate/gap/replay, retention expiry, slow snapshot, reconnect, reload, stale prior run, poll fallback and server restart                                    |
| External file attribution | team-scoped Claude write, forged run/member claim, verified OpenCode run evidence, stop-write-drain-relaunch watermark and deletion-fence conflict                                                                                                                                     |
| Writer coordination       | app-exclusive/cooperative/uncoordinated matrix, hostile concurrent writer at every boundary, active direct-mutation denial, provider-mediated observed outcome, quiescent revalidation and no stale auto-replay                                                                        |
| Runtime ingress           | real fake-runtime callbacks through one ADR-30 relay per lane, bearer absent from provider tree, scope/rotation/revocation, replay/conflict, wrong body run/lane/provider and raw-authority rejection                                                                                  |
| Approvals                 | prompt, preview, allow/deny, timeout, policy update, reload, two tabs, stale run                                                                                                                                                                                                       |
| Logs/review               | bounded member/task/exact logs, source generation mismatch, review read/apply/error                                                                                                                                                                                                    |
| Attachments               | upload/download/delete, limits, MIME mismatch, no host-path exposure                                                                                                                                                                                                                   |
| Destructive               | soft delete/restore/permanent delete, processRef kill, idempotent retry                                                                                                                                                                                                                |
| Identity recovery         | normal-mode absence, maintenance-mode evidence, expected-hash conflict, same-ID republish, duplicate/import refusal, backup-before-repair and restart recovery                                                                                                                         |
| Backup replacement        | ADR-32 WAL-active online snapshot, quiescence/refusal, crash/disk-full/hash/mount/prune matrix, commit-marker-last, credential exclusion, legacy-unverified refusal; clean-target ADR-26 restore, stable IDs, credential rotation and interrupted cross-root activation                |
| Capability UX             | each advertised capability works; each unavailable control is pre-gated                                                                                                                                                                                                                |

Do not force every assertion into one fragile mega-test. Each suite creates only new sandbox data,
uses unique team/workspace IDs, and performs narrow cleanup. A shared harness may reuse the built
image, but tests cannot depend on execution order or state left by another suite.

The harness records a redacted route/transport coverage ledger. Release fails on any team/review/
browser request to legacy `/api/teams`, any runtime process request outside
`/api/runtime/v1`, any capability marked required without at least one successful E2E action, any
unexpected browser console/page error, or any unclassified 4xx/5xx. This proves the new path is used,
not merely present beside the old one.

V1 additionally fails if a hosted terminal control, route, daemon artifact or capability is present.
The ADR-35 browser/WS/PTY matrix belongs exclusively to post-v1 T1 and is reinstated as a release gate
only for that separate capability.

Each failed CI run retains a redacted evidence bundle containing browser trace/screenshots,
requestId/diagnosticId, server logs, fake-runtime transcript, event cursor history, state manifest,
and owned-process leak report. HAR/body capture must redact cookies, CSRF, tickets, provider
credentials, prompts/tool inputs classified sensitive, and file contents.

### Level 2: gated live provider smoke

Run manually or nightly, not on every PR.

- always create a brand-new sandbox/test project;
- one narrow team per provider;
- Claude, Codex, OpenCode, and Gemini where supported;
- create -> launch -> ready -> task -> message -> stop;
- capture redacted artifact pack;
- cleanup only smoke-owned teams/processes;
- never touch real user projects.

### Level 3: desktop regression

Electron remains a first-class transport.

- IPC characterization tests;
- create/launch/progress/tasks/messages/stop;
- provider-specific diagnostics;
- existing safe launch matrix;
- packaging checks on supported platforms.

## Test matrix

| Layer                     | Required tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain                    | independent TeamLifecycle/LifecycleRun state machines, IDs/currentRunRef generations, terminal-run immutability, revisions and capability rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Application               | use cases with fake ports, immediate vs workflow-starting command semantics, stable workflowRef idempotency and cancellation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Cross-feature workflows   | commit/effect ordering, explicit partial outcomes, compensation/recovery and zero swallowed visible failures                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Contracts                 | routes, parsers, DTO compatibility, safe errors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Parity traceability       | AST member/signature/action inventory, direct/decomposed/desktop-only mappings, stable ID references, missing/duplicate/drift negative fixtures                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| IPC adapter               | parity with existing desktop semantics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| HTTP adapter              | real Fastify inject with real application facade                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Client/server conformance | every client route registered and shape-compatible                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Persistence               | legacy fixtures, future fields, corrupt files, migrations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| State compatibility       | manifest/state-family drift, future schema preflight, N -> N+1, interrupted resume, non-terminal drain compatibility and N+1 -> N in-place/drain/restore/refuse                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Instance lease            | final-image shared local volume across two containers/Compose projects/manual starts; pre-Node loser, root/anchor ownership, symlink/unlink/rename/recreate refusal, launcher/controller STOP/KILL, duplicate-FD close order, clean handoff, unsupported NFS/CIFS refusal and descendant `/proc/*/fd` leak scan                                                                                                                                                                                                                                                                                                                                     |
| Disaster recovery         | ADR-32 BackupRun transition crashes, WAL-active online snapshot, BUSY timeout, writer-quiescence/refusal, file drift/symlink/mount swap, disk full, manifest/commit marker ordering, prune race, legacy-unverified/partial refusal; ADR-26 empty-target replacement, cross-root journal interruption, preserved IDs, rotated credentials/mounts and fork/non-empty-target refusal                                                                                                                                                                                                                                                                   |
| Identity lifecycle        | atomic TeamId+LegacyTeamKey reservation, unsafe/case-fold/cross-root collision and no-reuse tests, publication gate over every legacy destructive path, durable-draft TeamId across failed run/retry, pre-commit draft cleanup vs explicit DeleteTeamDraft, legacy backup-ID mapping/rotation, prepared intent without file, published file without committed row, committed row without file, checksum/ID mismatch, external delete/change, exclusive publish crash repair, launch meta rewrites, display rename/soft-delete/restore, permanent tombstone, duplicate restore/import, async+sync backup manifest disagreement and downgrade refusal |
| Roster identity           | config/members.meta adoption, case-fold/auto-suffix ambiguity, stable MemberId remove/restore/replace, memberRevision/lane-attempt fencing, historical task owner/inbox/log mapping and expected rosterGeneration conflicts                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Concurrency               | parallel config/task/inbox mutations, stale revisions, ADR-16 two-container kernel exclusion/clean handoff/path-replacement/FD-leak cases, ADR-29 writer-class admission and hostile external replacement                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Command/effect recovery   | ADR-34 fingerprint golden vectors and retained-version compatibility; same/different intent key reuse; concurrent claim; crash before/after attempting/effect/evidence/commit/compensation; false-equal/stale evidence; non-reconcilable operator-required and zero duplicate run/message/task/file effects                                                                                                                                                                                                                                                                                                                                         |
| Process ownership         | anchor/control/status protocol, crash before/after spawn/ownership commit, nonce mismatch, pidfd PID reuse, subreaper/double-fork, TERM/KILL/drained, anchor crash and full-container replacement                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Child environment         | provider/backend/execution-unit allowlists, key provenance, mixed-unit exposure-set snapshot, controller/out-of-set canaries absent from env/argv/settings/MCP/logs/artifacts, no post-accept widening and no canonical bearer fallback                                                                                                                                                                                                                                                                                                                                                                                                             |
| Runtime relay             | inherited-FD bearer bootstrap, fixed derived lane scope, local endpoint rotation, body-authority mismatch, relay crash/restart/revocation and explicit same-UID non-isolation claim                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Workspace guard           | final-image `openat2`/`statx`/seccomp/version probes; parent/final symlink, rename, bind-mount and stale-generation race loops; bounded file verbs; atomic replace/fsync; verified provider-process cwd; zero raw-path fallback                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Git execution             | fixed subcommand/argv policy, neutral HOME/system/global config, hook/fsmonitor/pager/diff/textconv/credential-helper suppression, no remote network, worktree add/remove recovery and malicious repository fixtures                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Runtime                   | fake provider success/failure/timeout plus all current composite lane modes/order/partial/cancel/restart semantics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Runtime cutover           | no-active direct canonical transition, one-active legacy_drain status/stop/cancel, blocked relaunch/rebind/topology edit, ambiguous/multiple legacy candidates, crash during cutover handoff and one-way canonical fence                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Events                    | ADR-33 exhaustive same-transaction/lower-C0 snapshot handoff schedules, duplicate, gap, replay, foreign/old/ahead epoch cursor, retention crossing during snapshot, slow client, response loss, SSE attach/reconnect, resync and restart/journal restore                                                                                                                                                                                                                                                                                                                                                                                            |
| External attribution      | Claude task/inbox write without RunId stays ExternalFileActor, forged member/run fields, OpenCode VerifiedRunEvidence, watcher watermark drain, old/new fileWriterEpoch and relaunch/deletion fences                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Transport reconciler      | deployment/boot/selection scope, binding/roster/fileWriter generations, single currentRunRef, cancellation, cursor duplicate/gap/schema, topic routing, reconnect/poll scheduling; no entity semantics                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Feature reconcilers       | lifecycle thin/full/run tombstones, task revisions, message head/older-page serialization, approval dedupe, poll/event/response permutations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Renderer reachability     | hosted import graph excludes Electron/desktop entrypoints; capability permutations mount zero unavailable effects/listeners and every rendered control exercises a real facet                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Post-v1 T1 terminal       | two-plane grant/regrant state machine, hosted-safe method matrix, schema/resource budgets, GuardedShellLaunchSpec inherited-FD/exec evidence, raw-output/media denial, bounded projection and cancel/full-resnapshot backpressure, boot-scoped daemon/socket/store ownership, persistence-required mode, sanitized daemon/shell env, portable-pty close-all/drain evidence and container fallback; excluded from v1                                                                                                                                                                                                                                 |
| Browser                   | lifecycle plus the required parity suites above using real network                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Browser command recovery  | receipt persisted before request, timeout before/after acceptance, reload/re-login/multi-tab merge, actor/deployment isolation, TTL/retention agreement and no sensitive localStorage fields                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Hosted artifact           | emitted worker URL, Node-ABI SQLite reopen, ADR-28/31 native manifests/probes, ADR-30 relay/env scan and Electron/native-stub negative bundle fixtures                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Docker                    | non-root, HTTPS edge/Secure cookie, private app/runtime routes, health, persistence, SIGTERM, private ports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Readiness/admission       | each dimension fails/recovers independently, handler not invoked on denial, read-only/drain exceptions, revision events and no unrelated outage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Hosted access             | pure PairingChallenge/DeviceGrant/Session/AuthResetIntent transition tables, SQLite/keyring crash at every cross-store step, keyring failure, rotation grace/family bounds and public residual-drain-port behavior; no Fastify/fs/runtime internals in core                                                                                                                                                                                                                                                                                                                                                                                         |
| Security                  | ADR-7 real cookie/network pair/device/session/reset lifecycle, restart continuity, idle/absolute/renewal expiry, multi-tab/lost-response rotation, replay-family revoke, CSRF-before-claim, fixed PUBLIC_ORIGIN/proxy spoof/direct-HTTP/sibling-port denial, opaque refs, descriptor-bound traversal/symlink/mount races, Git helper execution, SSRF and limits                                                                                                                                                                                                                                                                                     |
| Workspace mount lifecycle | stable registrationKey/WorkspaceId across container restart, new mountGeneration, stale grant/ref/plan rejection, same-boot root swap/disappearance, permission downgrade and changed declared-root refusal                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Desktop                   | IPC and Electron regression                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Live provider             | opt-in sandbox-only provider matrix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Failure and chaos cases

Mandatory cases:

- malformed and oversized JSON;
- corrupt critical state;
- unknown future schema;
- disk full/read-only disk;
- permission denied;
- crash between paired task relationship writes;
- parallel mutation race;
- provider auth disappears mid-launch;
- provider process exits before bootstrap;
- primary lane fails before side-lane admission;
- duplicate primary turn-complete attempts to enqueue the same side lane twice;
- one side lane fails/stops while others become ready;
- config and members.meta disagree on case/removedAt or contain CLI auto-suffixed aliases; roster
  adoption blocks instead of silently merging/dropping MemberIds;
- an older memberRevision/lane attempt emits logs/messages after replace/restore/restart and cannot
  become the current member runtime identity;
- config changes after CompositeRuntimePlan commit but before restart recovery;
- rollout sees one active legacy run, then relaunch/rebind is attempted before legacy_drain completes;
- rollout sees multiple/newest-looking legacy run candidates and refuses to choose by mtime;
- forged/revoked/wrong-generation runtime ingress token;
- duplicate and conflicting runtime ingress idempotency keys;
- runtime callback attempts to override cwd/team/member topology;
- provider environment fixture tries to inherit pairing/session/CSRF/runtime bearer, a SecretRef
  outside its ProcessExecutionUnit exposure set, `NODE_OPTIONS`, loader injection and credential-helper
  variables; provenance admission or secret-canary scan rejects launch before provider exec;
- one lane calls another lane's local relay or changes body TeamId/RunId/LaneId. Under the declared
  trusted profile the endpoint is not claimed secret, but the relay still cannot expand its fixed scope;
- relay crashes before/after forwarding and rotates while a duplicate callback arrives; durable server
  claim/replay state prevents a duplicate semantic effect;
- ADR-31 anchor PID is rapidly recycled by an unrelated marker process; control/pidfd targeting never
  signals the marker;
- controller crashes after anchor spawn but before ProcessOwnershipRecord commit; pipe EOF drains the
  owned group or leaves explicit unclassified evidence requiring container replacement;
- provider double-forks, ignores TERM, floods output, exits before descendants, or anchor crashes
  during escalation; only a typed `drained` result reopens launch/pairing readiness;
- spawnNonce/runtime handshake conflicts with persisted run/lane or executable/start-token evidence;
- Node hot-restart is attempted inside the production container while an owned child remains and is
  rejected in favor of whole-container lifecycle;
- backend killed during provisioning;
- backend restart with active persisted run;
- dropped SSE connection;
- cursor older than replay buffer;
- duplicate event;
- command response arriving before/after its corresponding event;
- old poll response arriving after a newer SSE event;
- thin snapshot arriving after a full snapshot;
- delete/stop followed by late watcher and runtime events;
- old provider writes task/inbox during stop, and its watcher notification is delivered only after a
  relaunch attempt; quiescence closes/commits it before the next fileWriterEpoch or blocks launch;
- a continuous external writer crosses every capture/rescan attempt and launch returns bounded
  external_writer_busy without creating RunId/currentRunRef;
- an uncoordinated active writer races a browser task/config/review replacement; direct mutation is
  denied before effect, while provider-mediated delivery cannot report success until the expected
  newer semantic projection is observed;
- a quiescent-only command waits through stop/watermark/rescan, then sourceGeneration changes before
  confirmation; the stale body is not replayed and the user must rebase/confirm;
- Claude-compatible JSON claims the current run/member without verifiable provider evidence and stays
  ExternalFileActor rather than gaining audit/runtime authority;
- stale RunRecoveryWorkflow resumes after a newer currentRunRef or DeletionSaga and is denied from
  deleting team identity/draft/backups or newer-run artifacts;
- two browser tabs answering one approval;
- browser reload while an approval or provisioning command is pending;
- access session expires after command acceptance; device renewal rotates session/CSRF, then the same
  OperatorId resolves the pending key without replaying the command;
- backend/container restarts with a valid device/session family and writes no new pairing file;
- two tabs renew one device generation concurrently, the first response is lost, predecessor grace
  permits bounded recovery and a post-grace replay revokes the family;
- all device cookies are lost while runtimes are active; browser cannot mint a challenge, while a
  newer host reset generation drains/replaces the runtime boundary before plaintext appears;
- spoofed/multiple Forwarded/X-Forwarded values, direct production HTTP, unexpected Host/Origin and a
  sibling service on another port cannot use or renew hosted authority;
- browser times out before commandId, reloads, then resolves the pre-send ADR-27 receipt without
  replaying the launch or storing its prompt/body;
- server command retention is configured shorter than browser receipt TTL and readiness/config
  validation refuses the unsafe mismatch;
- crash leaves a runtime alive while startup attempts to create new pairing material;
- slow SSE consumer;

The following terminal chaos cases are retained for post-v1 T1 only and are not v1 gates:

- terminal control arrives before stream and vice versa; pair deadline, duplicate plane, third socket,
  consumed-cookie replay and wrong subprotocol/generation all fail without processing a frame;
- terminal network disconnect triggers bounded detached grace; blind vendor reconnect fails, HTTP
  regrant restores one writer, and grace expiry drains rather than leaving a shell;
- terminal input/frame/rate flood, slow output client and lost pong remain within queue/memory/CPU
  budgets; no command bytes or cookie values enter diagnostics;
- terminal response is lost after input/paste or split/new-tab effect; input is not resent, structural
  retry returns the same result/topology, and changed payload under the same clientCommandId conflicts;
- terminal browser requests arbitrary program/args/cwd/backend/import/restore/override-layout or an
  unowned session/pane/tab/subscription ID and causes zero daemon/process effect;
- terminal daemon/shell environment attempts to inherit controller/provider/auth/lease/loader canaries;
  required persistence fails; a stable/foreign socket is present; every case blocks readiness;
- terminal shell starts background jobs, setsid/double-forks, ignores TERM, daemon/controller crashes
  and close repeats; only typed drained evidence avoids full-container replacement;

V1 chaos cases resume below:

- reverse proxy idle timeout;
- port collision;
- canonical hosted bundle reaches an Electron import or catches a required `.node` addon with a stub;
- internal-storage worker URL is missing after bundling or SQLite addon has the wrong ABI;
- desktop and hosted controller attempt to own the same app/team root;
- ADR-28 negative control swaps a parent/final symlink between Node validation and raw path-string
  spawn/read and demonstrates the old approach is exploitable inside the marker harness;
- the guard race loop swaps parent, final symlink, registered root and bind mount during file read,
  atomic replace, Git, provider spawn and PTY bootstrap; every outside-marker effect remains zero;
- `openat2` is blocked by seccomp, guard protocol/build version is wrong, `statx` mount identity is
  unavailable or the filesystem fails its atomicity probe; only dependent capabilities go unavailable
  and no Node fallback executes;
- malicious repository config installs post-checkout hook, fsmonitor, pager, external diff/textconv,
  credential helper and remote URL; allowlisted hosted Git operations execute none of them;
- full container restart remounts the same registrationKey/path with different dev/inode: WorkspaceId
  stays stable, mountGeneration advances, and every prior grant/ref/plan is stale;
- a non-terminal workflow references the previous mountGeneration after restart and cannot resume an
  effect until explicit recovery/replan;
- external agent rewrites config projectPath/cwd to another registered or unregistered workspace;
- mounted workspace disappears;
- two final-image controllers/Compose projects race for one provisioned deployment volume and only one
  reaches Node;
- the ADR-16 winner is SIGSTOPed while diagnostic heartbeat/metadata becomes stale or disappears; the
  contender still cannot acquire the kernel-held inode;
- runtime UID attempts to unlink/rename/recreate the root-owned anchor, launcher or Node closes one
  duplicate FD, and a child tries to inherit another; ownership survives until the complete admitted
  controller lifecycle exits and no child can prolong it;
- command crashes before effect, during effect, after verification and after outbox commit;
- journal restore rotates event epoch while a browser reconnects with an old cursor;
- migration interrupted and resumed;
- previous image encounters a future state family or non-terminal record it cannot drain and refuses
  before migration/write instead of trusting a disabled feature flag;
- identity adoption crashes before file publish and after publish/before SQLite commit;
- a valid identity file exists without an intent/index and is staged as import instead of silently
  attached by directory name;
- a committed identity row loses its file, or file/index checksums disagree, and mutation stays
  blocked until explicit audited repair;
- identity file deletion/change races watcher overflow and a controller restart;
- legacy TeamBackupService rotates identityId for same-name resurrection while canonical TeamId remains
  distinct, and old/new backup evidence cannot cross-attach teams;
- a deleted LegacyTeamKey is requested for a new draft, or legacy team/task/backup roots contain
  case-fold/unsafe/cross-root collisions; creation/adoption blocks without auto-renaming while explicit
  restore is allowed only for the original soft-deleted TeamId and never after permanent tombstone;
- async backup, shutdown backup and permanent delete interleave at every ordering boundary without
  restoring or erasing an anchored/tombstoned identity;
- ADR-32 BackupRun crashes before/after every transition, SQLite is active in WAL mode, BUSY repeats
  to deadline, an external writer refuses quiescence, disk fills after staging, a file/mount changes
  after hashing, publication crashes before commit marker and retention races the last known-good;
- ADR-33 mutation commits before/after lower-cursor capture, each projection read, response
  serialization and SSE attach; response loss/reconnect and retention expiry yield duplicate replay or
  resync, never an event absent from both snapshot and replay;
- team.meta launch rewrite occurs after identity adoption;
- draft creation crashes before/after identity commit, and a later provisioning failure/retry keeps
  the committed TeamId while cleaning only RunId-owned artifacts;
- explicit DeleteTeamDraft crashes before/after identity tombstone;
- backup restore introduces a duplicate team.identity.json;
- replace_deployment restore crashes after one state/CLI root is staged/published but before final
  activation marker; pairing/mutation remains unavailable and resume verifies all checksums;
- restore targets a non-empty root or requests an unsupported fork while the copied source deployment
  might still run; operation refuses instead of duplicating deployment identity silently;
- SIGTERM delivered multiple times;
- partial startup failure after some services started.
- provider-only readiness failure while login/team reads remain available;
- mutation readiness failure while stop/status/recovery drain routes remain available;

## Docker and hosting topology

Recommended production topology:

    Internet
      -> Caddy/Nginx/Traefik TLS edge
      -> private hosted app network
      -> isolated runner/process boundary
      -> mounted state and registered workspaces

Edge requirements:

- TLS and HSTS;
- one explicit ADR-7 PUBLIC_ORIGIN on a dedicated hostname; the edge overwrites forwarding headers
  and the app trusts only configured edge CIDRs, never all/nth-hop proxies;
- v1 pairing/device/session flow; optional OIDC grant issuer only when deliberately enabled later;
- request/body limits;
- SSE buffering disabled;
- long SSE idle timeout;
- only edge port publicly exposed;
- edge forwards renderer, `/api/hosted/v1`, public liveness and only the
  explicitly reviewed legacy non-team routes required by the retained standalone session UI. Those
  routes receive the same browser session/data-redaction policy and are listed in RouteCatalog.
  It denies `/api/runtime/v1`, private readiness/metrics and legacy `/api/teams/*`; owned runtimes
  reach machine ingress through loopback/private app networking.
- CSP, frame-ancestors denial, nosniff, strict Referrer-Policy, and minimal Permissions-Policy;
- trusted proxy configuration that cannot be spoofed from the public interface.
- no direct public app-port mapping in the production profile; HTTP 3456 remains an explicitly
  insecure loopback demo only and cannot report productionAuth readiness.

Hosted app requirements:

- private bind;
- exactly one admitted writer per deployment root. `replicas: 1` is defense in depth; ADR-16 must
  reject a second container/manual start sharing the volume before Node or readiness exists;
- one pre-provisioned local deployment volume layout: root-owned non-runtime-writable parent and
  `instance.lock`, plus a runtime-UID-writable `state/` child. App and lock anchor cannot be supplied as
  unrelated mounts/registrations, and the main container cannot initialize or chown them itself;
- durable hashed ADR-7 device/session state, short access authority, host-reset recovery and no
  plaintext challenge while a v1 runtime remains live or unclassified;
- canonical API and renderer;
- machine ingress remains token-authenticated even on the private network and is not included in
  browser CORS/cookie/capability policy;
- health/readiness;
- no arbitrary process path or workspace path from browser;
- Linux kernel 5.6+ plus a final-runtime seccomp profile that permits required ADR-28 syscalls. The
  exact kernel/seccomp/filesystem is accepted by executable probes, not by version string alone;
- the runtime image contains the pinned `agent-teams-workspace-guard` protocol/build hash but no
  compiler toolchain, and dependent routes remain unregistered until its mounted-workspace probe passes;
- the image also contains the separately versioned ADR-31 process anchor; pidfd/subreaper/control-pipe
  probes pass under the final init/PID namespace/seccomp/UID configuration;
- init starts the separately versioned ADR-16 launcher before Node. The launcher and Node retain
  duplicates of one kernel-locked open-file description; diagnostic metadata/heartbeat never controls
  ownership, and the reserved descriptor is absent from every provider/relay/Git/helper child;
- canonical runtime ingress is reachable only from controller-owned ADR-30 relays on private local
  transport. Provider processes receive no server bearer and the public edge cannot reach relays;
- no hosted-terminal WebSocket route, daemon/gateway port, socket/store volume or terminal-platform
  artifact exists in the v1 image; ADR-35 adds them only in post-v1 T1;
- no Docker socket, host PID namespace, privileged mode, or broad home-directory mount;
- init/signal forwarding and a shutdown deadline compatible with provider/process grace periods.

Runner requirements:

- non-root;
- one minimal init -> ADR-16 instance-lock launcher -> controller lifecycle; production restart
  replaces the whole container and does not hot-restart Node while provider children remain;
- provider adapters;
- owned PID tracking;
- bounded stdout/stderr;
- ADR-30 allowlist-first provider environments and SecretRef resolution; no ambient process/login-shell
  spread in hosted spawn code;
- ADR-31 anchor per provider run, with status/control pipes and whole-container fallback on ambiguous
  drain. The minimal container init remains the final reaper, not a replacement lane supervisor;
- no host mounts outside registered state/workspace/state/credential needs. Under the accepted
  `trusted_process` profile this container mount boundary, not ADR-28 alone, limits a provider;
- explicit UID/GID ownership and startup permission probe; never solve mount errors by running root;
- secret mounts read-only and excluded from child environments unless the selected provider adapter
  explicitly requests the named credential material.

Volume model:

- /data/agent-teams: root-owned deployment parent, not writable by the runtime UID;
- /data/agent-teams/instance.lock: stable root-owned ADR-16 anchor, never runtime-created/replaced;
- /data/agent-teams/state: runtime-UID-owned app persistent state bound to that anchor/deployment;
- /data/claude: tenant runtime/CLI-compatible state;
- /workspaces/<workspace-id>: registered project mounts with explicit read-only/read-write policy;
- /run/secrets or equivalent: provider credentials;
- temporary output on bounded tmpfs.

## Migration and rollback

### Compatibility rollout

1. Read-only compatibility scan.
2. Shadow projection parity between legacy and new application snapshots.
3. Hosted feature flag disabled by default.
4. Enable list/read only.
5. Enable draft/create.
6. Enable fake-runtime launch in non-production.
7. Enable provider-specific launch canary.
8. Enable task/message mutations.
9. Enable remaining high-risk v1 capabilities separately. Hosted terminal is not a v1 rollout state.

Each capability advances through a checked-in cutover state:

| State                 | Meaning                                                               |
| --------------------- | --------------------------------------------------------------------- |
| inventoried           | owner/current callsites/security/test obligations known; not routable |
| shadow-read           | new projection compared with legacy; no UI authority                  |
| desktop-delegated     | IPC uses the new application use case; legacy DTO adapter remains     |
| hosted-read           | authenticated browser query enabled; no mutation                      |
| fake-runtime mutation | deterministic sandbox-only command path enabled                       |
| provider canary       | one explicitly supported provider/backend, operator opt-in            |
| required              | advertised by default and covered by release E2E                      |

Activation is a server-side manifest/config decision, not a renderer flag. A capability cannot move
forward unless its route, authorization policy, application use case, persistence/recovery behavior,
renderer facet/control, observability and negative/E2E tests all have the same manifest status.
Rollback moves admission backward while keeping read/stop/recovery surfaces available for already
accepted operations.

### Rollback controls

- feature flag per capability;
- hosted read-only emergency mode;
- retain legacy IPC adapter;
- disabling launch/create/task mutation never disables status, stop, recovery, token revocation or
  command-status lookup for work accepted by the newer version;
- rollback preflight refuses image downgrade while an incompatible mutation saga/migration is
  prepared or recovering. The operator must drain/stop or complete recovery first;
- image rollback is stop-then-start under the same ADR-16 anchor. A previous image may wait pre-Node
  for the current container to release, but no rollout script deletes/recreates the anchor, edits
  lease diagnostics or mounts the same `state/` behind a different lock registration;
- active run-ingress credentials are revoked or remain verifiable by the compatible drain
  path before process replacement; rollback cannot strand unauthenticated live children;
- ADR-7 auth schema/policy is part of StateCompatibilityManifest. An image that cannot validate
  device/session/reset generations must revoke them and require controlled re-pair after drain, or
  refuse; it may never reopen wildcard-CORS/unauthenticated hosted routes as a downgrade fallback;
- no irreversible CLI-owned schema rewrite;
- versioned app-owned migration journal;
- a committed ADR-32 `coordination_backup` before an app-owned migration/repair, and a committed
  `deployment_recovery_point` before any rollout that can change CLI/provider-owned durable state;
- BackupRun closes the appropriate mutation/external-writer fence, uses SQLite Online Backup API,
  records the complete participant/identity/checksum/generation inventory and publishes its commit
  marker last. Restore validates all content in staging and publishes neither files nor index rows
  when the set is partial, duplicated, disagrees or is merely `legacy_unverified`;
- product restore uses only ADR-26 replace_deployment into empty roots with a final activation marker;
  rollback tooling cannot silently fork a copied deployment or reuse backed-up sessions/tickets;
- expand/contract migrations for app-owned tables: add/read-both/write-new before removing old
  fields; no destructive schema cleanup in the capability-enabling PR;
- ADR-23 generated image/state compatibility manifest and automated N -> N+1 -> N built-artifact
  compatible/drain/restore/refuse tests. If the previous image cannot safely read the new schema,
  rollback means restoring the verified pre-migrate app-owned backup while leaving CLI/provider-owned
  files untouched unless their own journal proves they changed;
- exclude ephemeral sockets/PIDs/temp, sessions/tickets and provider secrets by default; any later
  sensitive inclusion needs explicit encryption/key-rotation/access/restore semantics and new threat
  review, not an undocumented manifest flag;
- image rollback plus compatible state version;
- downgrade is refused if the target image cannot preserve team.identity.json through create
  failure, delete, trash/restore and backup/restore, even if it can ignore the file during reads;
- fail closed on future critical schema.

## Parallel execution model

Target: six productive workers when host admission allows.

Next worker launch profile requested by the user:

- model/profile: 5.6 sol;
- effort: xhigh;
- fast mode: enabled.

Do not keep six workers busy by creating overlapping work.
Each worker owns a bounded worktree and a non-overlapping surface.

### Recommended workstreams

| Worker | Ownership                                                                                                                                          |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| A      | shared-kernel minimum, public-contract conventions, RouteCatalog, architecture fitness gates                                                       |
| B      | `team-lifecycle` application/domain plus legacy compatibility adapters                                                                             |
| C      | `workspace-registry`, browser/session security adapters and path/lease negative tests                                                              |
| D      | `team-console`, TeamTransportReconciler and renderer composition; each feature worker owns its entity reducer/reconciler and public renderer facet |
| E      | `team-runtime-control`: execution/ingress domain, lane/run credential/replay store, process supervision and liveness/recovery                      |
| F      | persistence compatibility, command/intent recovery, event journal and external-writer reconciliation                                               |

The integration owner serially owns app-level hosted composition, shared route assembly, build/Docker
and adoption; these are convergence points, not another worker free-for-all. As prerequisites close,
A rotates to the real-network E2E/chaos harness, B to task-board, C to workspace/auth security E2E,
D to messaging UI/reconciliation, E to approvals/provider conformance, and F to review/attachment
persistence. Rotation occurs only with a written handoff and clean ownership boundary. Six workers
are a throughput target, not permission to modify six coupled surfaces before their contracts exist.

### Integration rules

- One integration owner.
- Small PR/commit slices with explicit dependency order.
- No worker edits shared mega-files without ownership coordination.
- Contract changes land before dependent client/server work.
- Every adopted slice includes tests and diff-check.
- Dirty outputs are reviewed before new capacity work.
- No raw merge of worker branches without targeted gates.
- A worker cannot introduce a cross-feature contract unilaterally; the owner and integration owner
  approve it before dependent work starts.
- Shared-kernel and app-composition files have serialized ownership even while feature work is parallel.

## Branch, PR, and commit strategy

No implementation branch is created until the user accepts this plan.

Recommended first branch name: `refactor/hosted-web-feature-boundaries`. At creation time it starts
from the then-current fetched SHA of `refactor/team-provisioning-round2-reapply`; the SHA is recorded
in the first commit/PR description. The closed `refactor/hosted-web-runtime-boundary` branch is never
merged into it.

Avoid one unreviewable 28k-45k line v1 PR. Deliver sequential, feature-flagged slice PRs into the target
base when repository policy permits. Incomplete hosted mutation capability stays unadvertised and
off by default, so architecture and compatibility slices can land without exposing a false product.
If integration policy requires an umbrella branch, worker PRs target the umbrella and a continuously
updated draft PR shows the aggregate diff, but each adopted commit still has its own review evidence.

Suggested slice sequence:

1. docs/architecture and capability matrix;
2. clean-base CI classification and independently valid baseline/security fixes;
3. feature skeletons, small shared kernel, contracts, AppError, and architecture fitness tests;
4. runtime/identity context, `workspace-registry`, and read-only `team-lifecycle` with desktop
   compatibility plus hosted context-bound adapters;
5. durable mutation/outbox/recovery protocol and external-writer compatibility;
6. `team-runtime-control` execution + machine ingress, scoped credentials/replay fencing, liveness
   state model and lifecycle mutation commands;
7. app-level hosted composition and existing standalone Docker target;
8. browser session + machine-ingress auth, workspace policy and security negative gates;
9. `team-console` reconciler and browser lifecycle vertical slice;
10. `team-task-board`, `team-messaging`, and their external-write reconciliation;
11. `team-review`, `team-approvals`, attachments and remaining parity;
12. production hardening and real E2E gate.

After v1 release, post-v1 T1 uses its own branch/PR chain: terminal-platform source hardening and one
pinned compatibility artifact set first, then the hosted `terminal-workspace` adapter and terminal-
specific production rollout. It does not share an umbrella PR with v1.

Each slice is independently reviewable and revertible. Use conventional commits. Do not combine a
contract change, broad mechanical move, and behavior change in one commit. A slice PR includes:

- scope/ownership and explicitly excluded behavior;
- ADR/capability changes;
- migration and rollback effect;
- focused tests plus architecture/conformance results;
- desktop impact and hosted capability state;
- E2E evidence level honestly labeled fixture, adapter, process, browser, or container.

## Verification commands and gates

Exact commands may be split by phase, but final readiness requires:

- pnpm typecheck:workspace;
- pnpm lint:fast during iteration and pnpm lint:fast:files -- <owned files> for narrow worker gates;
- full pnpm lint for architecture-sensitive final gate;
- focused Vitest suites for each changed layer;
- pnpm test:workspace:ci;
- exactly one canonical renderer+API build: target-base `pnpm standalone:build`, or
  `pnpm hosted:build` only after an atomic rename where it replaces the same entrypoint/artifact and
  `standalone:build` is at most a temporary alias tested for equivalence;
- Docker image build;
- client/server route conformance;
- deterministic browser E2E;
- Docker restart/persistence E2E;
- security negative suite;
- desktop regression gate;
- git diff --check;
- secret/path leakage scan.

The relevant phases must expose stable repository scripts, not CI-only shell fragments, for at least:

- `pnpm hosted:parity:verify`: AST/signature/action extraction and parity-ledger cross-check against
  capability/route/use-case/test IDs;
- `pnpm hosted:artifact:verify`: bundle import scan, emitted-worker existence, Node-ABI SQLite
  write/read/reopen and required artifact manifest/hash/load probes inside the final image;
- `pnpm hosted:workspace-guard:verify`: build/protocol/hash check plus final-image syscall/seccomp/
  filesystem, bounded-file, process/PTY cwd, Git hardening and adversarial race tests;
- `pnpm hosted:process-anchor:verify`: final-image anchor protocol/hash, pidfd/subreaper, control EOF,
  TERM/KILL/drain, double-fork, output-pressure and PID/PGID-reuse marker tests;
- `pnpm hosted:child-env:verify`: provider/backend environment-provenance ledger, ADR-30 relay bootstrap,
  ProcessExecutionUnit exposure-set enforcement and secret-canary scan over env/argv/settings/MCP/
  log/artifact surfaces;
- `pnpm hosted:state-compat:verify`: generate/check ADR-23 manifest, scan migration ownership and run
  built N/N+1 compatibility-or-refuse fixtures;
- `pnpm test:hosted:e2e`: HTTPS-edge browser parity suites against built artifacts;
- `pnpm test:hosted:security`: browser/runtime trust separation and negative path/auth/limit cases;
- `pnpm test:hosted:chaos`: lease, crash-point, watcher loss/overflow, composite-lane and restart cases.

Names may follow an existing repository convention discovered in Phase 0, but there must be one
canonical script per gate and CI/local use the same entrypoint. Manual curl, source-mode dev server,
in-app browser debugging or a successful TypeScript build cannot substitute for these gates.

Do not treat a mocked transport fixture as final E2E evidence.

## Risk register

Terminal-specific rows are retained as the post-v1 T1 risk register. They do not contribute to v1
readiness, estimate or residual-risk score; v1 mitigates them by capability/artifact/route absence.

| Risk                                                               | Current score | Mitigation                                                                                                                                                                                 |
| ------------------------------------------------------------------ | ------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Client/server contract drift                                       |         10/10 | single contract owner and route conformance                                                                                                                                                |
| Red/ambiguous baseline                                             |          9/10 | exact-base reproduction and green Phase 0 gate                                                                                                                                             |
| Arbitrary host path/runtime launch                                 |         10/10 | opaque refs, workspace registry, fd/stat identity and fail-closed symlink-race policy                                                                                                      |
| Node path check passes but later file/spawn cwd escapes            |         10/10 | ADR-28 descriptor-bound guard, no hosted path-string fallback, final-image active-race proof                                                                                               |
| Repository-controlled Git helper/hook executes                     |         10/10 | fixed Git verbs/argv, neutral config/env, disabled hooks/helpers/network and malicious-repo tests                                                                                          |
| Guard unavailable or blocked only after deployment                 |          9/10 | versioned artifact plus kernel/seccomp/filesystem probes in Phase 0, build and mounted-runtime readiness                                                                                   |
| Stable WorkspaceId coupled to ephemeral mount fingerprint          |         10/10 | ADR-25 registration/mount split, boot mountGeneration, stale grant/plan rejection and operator trust boundary                                                                              |
| Team/workspace identity drift or rebinding                         |         10/10 | atomic TeamId+LegacyTeamKey reservation/no-reuse, publication gate over destructive/backup paths, replicated file+SQLite protocol, reconciliation matrix, versioned binding and tombstones |
| Member-name reuse/alias cross-attachment                           |         10/10 | TeamRoster MemberId, immutable LegacyMemberKey, roster/member revisions, plan-bound lane attempts and ambiguous legacy-name block                                                          |
| Browser auth/CSRF failure                                          |         10/10 | ADR-7 durable device grant plus short session, derived CSRF, server expiry/revocation and real HTTPS browser E2E                                                                           |
| One-time pairing is consumed but later re-auth has no credential   |         10/10 | persistent hashed device family, ordinary restart continuity and host-controlled reset only after v1 runtime drain                                                                         |
| Device rotation response loss or multi-tab race locks operator out |          9/10 | bounded predecessor grace/family size, coalesced renew/bootstrap retry, replay-after-grace revocation and deterministic schedules                                                          |
| Missing/rotated auth hash key silently accepts or orphans sessions |         10/10 | fsync'd versioned keyring, ordinary-restart reuse, fail-closed mismatch, host-reset-only rotation and restore revocation                                                                   |
| Forwarded Host/proto spoof changes cookie/origin authority         |         10/10 | explicit HTTPS PUBLIC_ORIGIN, exact proxy CIDRs, edge header overwrite, ambiguous/direct HTTP refusal and dedicated hostname                                                               |
| Runtime ingress impersonation/replay                               |         10/10 | disjoint route/auth surface, lane/run-scoped credentials, server-resolved identity, persistent replay fence                                                                                |
| Canonical runtime bearer leaks through child env/config            |         10/10 | ADR-30 controller-owned relay, inherited-FD bootstrap, allowlist-first environment and secret-canary artifact scan                                                                         |
| Ambient/controller or out-of-set provider secrets cross units      |         10/10 | ADR-18 exposure sets, per-key provenance, SecretRefs, deny-in-depth injection variables and mixed-unit negative fixtures                                                                   |
| Same-UID runtime mistaken for a security sandbox                   |         10/10 | explicit trusted_process profile, relay non-isolation disclosure, pairing-after-residual-runtime gate and separate-UID/container profile deferred                                          |
| Provider divergence                                                |          9/10 | authoritative adapter registry and capability matrix                                                                                                                                       |
| Composite lane reorder/duplicate/partial-state loss                |         10/10 | immutable plan snapshot, characterized gate order, per-lane fencing and aggregate recovery                                                                                                 |
| Legacy/canonical dual runtime authority                            |         10/10 | per-TeamId one-way legacy_drain -> canonical fence; old adapter is status/stop/cancel only and ambiguous candidates block                                                                  |
| Desktop regression                                                 |          8/10 | characterization and IPC parity tests                                                                                                                                                      |
| Green build with fake Electron/native implementation               |         10/10 | no canonical stubs, emitted worker, ABI/artifact smoke and negative bundle gates                                                                                                           |
| Global readiness hides usable recovery or enables unsafe mutation  |          9/10 | ADR-21 lattice, per-route admission and independent failure tests                                                                                                                          |
| JSON compatibility/data loss                                       |          9/10 | ownership catalog, unknown fields, backup, migration journal                                                                                                                               |
| False rollback across incompatible state                           |         10/10 | ADR-23 generated compatibility manifest, pre-migration schema scan and built N/N+1 compatible-or-refuse tests                                                                              |
| Backup silently clones deployment identity                         |         10/10 | ADR-26 explicit empty-target replacement, cross-root activation journal, identity preservation/credential rotation and fork refusal                                                        |
| Periodic file copy is mistaken for a consistent recovery point     |         10/10 | ADR-32 quiesced BackupRun, SQLite Online Backup API, immutable staged manifest/commit marker, complete verification and `legacy_unverified` refusal                                        |
| WAL/main DB or cross-root backup generations are mismatched        |         10/10 | no raw SQLite copy, participant generation fence, online snapshot, per-entry hash, commit-marker-last publication and staged ADR-26 activation                                             |
| Hosted split-brain writer                                          |         10/10 | ADR-16 root-owned stable inode plus kernel-held dual launcher/Node FD, pre-Node loser exit, no TTL/PID/metadata takeover and two-container shared-volume proof                             |
| Lease path replaced while old inode remains locked                 |         10/10 | runtime UID cannot write deployment parent/anchor; descriptor-open verification plus unlink/rename/recreate adversarial tests                                                              |
| Lease FD leaks into provider/PTY and prevents clean handoff        |          9/10 | reserved descriptor policy, explicit child stdio closure, `/proc/<pid>/fd` inode canaries and container-replacement test                                                                   |
| Desktop and hosted share one writable root                         |         10/10 | dedicated state, explicit offline handoff/import, foreign-writer readiness failure                                                                                                         |
| Concurrent external-writer corruption                              |          9/10 | ADR-29 admission, provider-mediated/quiescent paths, intent journal and observation reconciliation                                                                                         |
| Impossible lossless CAS is assumed for provider JSON               |         10/10 | ADR-29 writer classes; direct active mutation only for proven cooperative writers, otherwise provider-mediated or quiescent-only                                                           |
| Old/anonymous JSON write attributed to current run                 |         10/10 | ADR-24 ExternalFileActor, verified provider evidence only, watcher watermark and fileWriterEpoch quiescence before relaunch/delete                                                         |
| Idempotency fingerprint changes across schema/release              |         10/10 | ADR-34 explicit intent projection, schema/fingerprint/key versions, HMAC golden vectors, retained-version comparison and ADR-23 startup block                                              |
| Ambiguous command retry after partial effect                       |         10/10 | ADR-34 per-effect recovery class/evidence state, immediate/workflow acceptance split, stable workflowRef and non-reconcilable operator_required                                            |
| Reload loses idempotency key before commandId                      |          9/10 | ADR-27 receipt-before-send, actor/action-scoped lookup, server/client retention contract and no automatic body replay                                                                      |
| Cross-feature secondary effect swallowed                           |          9/10 | one coordinator, persisted delivery/saga outcome and partial-outcome E2E                                                                                                                   |
| Lost realtime updates                                              |          8/10 | durable epoch cursor, revisioned journal, replay, reconciliation                                                                                                                           |
| Snapshot returns a cursor newer than the represented state         |         10/10 | ADR-33 same-transaction cursor or lower C0 captured before external projection, duplicate-tolerant reducers and exhaustive boundary scheduling                                             |
| Stale renderer state resurrects old run                            |          9/10 | generation/run tombstones and reconciler characterization                                                                                                                                  |
| Hidden desktop effect mounts in hosted UI                          |          9/10 | capability-first composition, hosted import graph and listener/control mount conformance                                                                                                   |
| Approval double-answer/policy reset                                |         10/10 | server authority, idempotent claim, durable policy, audit                                                                                                                                  |
| Orphan/reused-PID processes                                        |         10/10 | ADR-22/31 durable intent, anchor/subreaper/control pipe/pidfd/drained evidence, unclassified block and whole-container boundary                                                            |
| Process anchor mistaken for hostile-process containment            |          9/10 | trusted-process claim, escape fixture becomes unclassified/container-replace, cgroup/separate-container isolation deferred                                                                 |
| Raw terminal gateway exposes arbitrary launch/session authority    |         10/10 | ADR-35 HostedTerminalFacade/method matrix, server-built native launch, exhaustive schemas/owned IDs and absent unsupported controls                                                        |
| Controller/provider secrets inherit into terminal shell            |         10/10 | allowlist-first daemon base env, no default SecretRefs, portable-pty shell canary scan and artifact/env provenance gate                                                                    |
| Descriptor-bound PTY launch degrades to path/string authority      |         10/10 | ADR-28 GuardedShellLaunchSpec, boot-authenticated local request, private inherited envelope/status FDs, guard revalidation, exec evidence and no raw-path fallback                         |
| Two-plane WS ticket replay or reconnect bypass                     |         10/10 | hashed control+stream slot generation, fixed Origin/subprotocol, pair deadline, digest erase, sibling close and authenticated HTTP regrant                                                 |
| Lost WS acknowledgement duplicates shell input/tab/split           |         10/10 | ADR-35 clientCommandId/result registry, topology evidence for structural commands and explicit non-replayable delivery_unknown input/paste                                                 |
| Terminal frame/output flood exhausts memory or event loop          |         10/10 | raw stream/media disabled, budgeted hosted projection, capped local frames, latest-value lanes, aggregate queue-byte proof, cancel/resnapshot backpressure and slow-client deadline        |
| Foreign/stale daemon adopted or persistence silently disappears    |         10/10 | random BootId runtime/socket/store identity, exclusive no-overwrite bind, nonce handshake, require-persistence and no hosted adoption                                                      |
| PTY background descendants survive close                           |         10/10 | terminal-platform typed close-all/wait/drained protocol, anchor/container boundary, setsid/double-fork/TERM-ignore fixtures and readiness block on ambiguity                               |
| Terminal initial cwd is mistaken for shell confinement             |         10/10 | explicit arbitrary-shell threat claim, container mount boundary, no host mounts/secrets by default and separate-container isolation deferred                                               |
| Terminal output/history leaks through logs or backup               |          9/10 | no frame/content logging, bounded sensitive retention, raw terminal store excluded from ADR-32 by default and explicit encrypted export policy required                                    |
| Scope explosion                                                    |          8/10 | required/deferred capability matrix and vertical slices                                                                                                                                    |
| False green E2E                                                    |         10/10 | real browser/server/container gate                                                                                                                                                         |
| False method-name parity                                           |         10/10 | AST/signature ledger plus semantic obligations and required-action E2E references                                                                                                          |

## Definition of done

The hosted release is done only when every item below is true.

### Architecture

- [ ] Core application imports no Electron/Fastify/fs/path/child_process/@main.
- [ ] Every mutation, route, event, repository write, and renderer command has one owning feature.
- [ ] Production cross-feature imports use public entrypoints; deep imports and cycles fail CI.
- [ ] No replacement `team-application`, `runtime-core`, global store, or composition facade becomes
      a god-module.
- [ ] IPC and HTTP call the same use cases.
- [ ] Browser API is capability-segregated.
- [ ] ADR-19 ledger maps every pinned TeamsAPI/ReviewAPI/CrossTeamAPI member and visible hosted action
      to one semantic disposition; AST/signature drift, missing obligations and duplicate ownership fail CI.
- [ ] TeamTransportReconciler is the only transport-envelope entry for IPC/HTTP/event/poll; it owns
      no feature entities/revision semantics, which remain in feature reconcilers.
- [ ] Renderer has one canonical currentRunRef; provisioning/runtime/lane projections cannot keep or
      select independent current run IDs, and binding/roster/fileWriter generations fence stale updates.
- [ ] `team-console` owns orchestration only and does not duplicate feature domain projections.
- [ ] Renderer team features have no direct window.electronAPI.teams bypass.
- [ ] Hosted renderer import graph and mounted tree contain no direct Electron/preload/mega-client or
      desktop-only entrypoint; unavailable feature listeners/effects register zero work.
- [ ] Application/store errors do not depend on IpcError or raw transport message strings.
- [ ] No supported method throws browser-unavailable.
- [ ] No supported method silently no-ops or fabricates empty success.
- [ ] runtime-core is no longer a concrete main-service aggregator.
- [ ] Electron, hosted Node, and deterministic test compositions select adapters only; business
      sequencing remains in feature application use cases/sagas.
- [ ] Start/review/member/approval/delete/attachment workflows use their declared coordinator and
      expose persisted partial/delivery/recovery outcomes; no user-visible secondary failure is swallowed.
- [ ] DeletionSaga is TeamId-scoped and RunRecoveryWorkflow is RunId-scoped; shared scheduling
      primitives contain no business compensation logic and architecture tests prevent cross-ownership.
- [ ] Canonical hosted build fails on Electron/preload imports and missing native artifacts; no
      reachable empty Electron or `.node` stub implements a production capability.
- [ ] Application/provider/review use cases receive opaque workspace grants, never cwd paths;
      hosted adapters consume them only through ADR-28 while desktop compatibility remains explicit.
- [ ] `team-runtime-control` owns ProcessSupervisorPort/RuntimeIngressRelayPort semantics; hosted
      ADR-30/31 and desktop adapters publish distinct capability evidence instead of pretending weaker
      process implementations are substitutable.

### Production topology

- [ ] Default hosted Docker image runs renderer plus real API.
- [ ] Closed-PR static-only hosted target is absent from production build/docs/tests; any unrelated
      developer UI preview cannot satisfy hosted readiness.
- [ ] Health/live and health/ready work.
- [ ] ADR-21 serve/auth/read/mutation/runtime-ingress/recovery-point dimensions gate only
      their declared routes; read-only and drain/recovery behavior remains accessible under tested
      degraded states.
- [ ] Main container runs non-root with explicit persistent mounts; a separate one-shot init step has
      provisioned the root-owned ADR-16 anchor/state layout and the app cannot repair unsafe ownership.
- [ ] Final image starts Node only through the pinned ADR-16 launcher. Launcher and Node share one
      locked open-file description, release it only after admission/drain/flush/exit ordering, and
      expose no lock FD to provider/relay/Git/helper descendants.
- [ ] Final runtime image carries the pinned ADR-28 guard, passes its actual mounted-workspace probe
      under production UID/seccomp and contains no compiler/build toolchain.
- [ ] Final image carries separately versioned ADR-31 anchor and ADR-30 relay artifacts. Their probes
      run under final init/PID namespace/UID/seccomp/mount settings before launch readiness.
- [ ] Final v1 image and startup graph contain no hosted terminal-platform daemon/N-API/SDK artifact,
      terminal migration/store/socket, WS route or browser terminal chunk.
- [ ] Only TLS edge is public.
- [ ] Deployment declares one replica, while two actual final-image containers/Compose projects against
      the same provisioned local volume independently prove kernel exclusion: the loser fails before
      Node, migration, listener, recovery, watcher or spawn. Paused winner, deleted diagnostics and
      same-name path recreation do not permit takeover; complete old-container exit does.
- [ ] Desktop and hosted modes cannot concurrently mutate the same app/team root; offline handoff is
      documented and tested.

### Security

- [ ] Remote deployment requires secure authentication.
- [ ] ADR-7 initial pairing creates one durable device family plus short session; ordinary restart
      preserves valid authority without plaintext re-pairing, while restore revokes copied auth.
- [ ] Session fixation, idle/absolute/renewal expiry, logout/forget-device, rotation predecessor grace,
      response-loss/multi-tab convergence, replay-family revoke, CSRF-before-command-claim and exact
      Origin checks pass.
- [ ] Lost device authority can recover only through a strictly newer host manifest reset generation;
      reset revokes prior families and emits no challenge until v1 runtimes are drained or the
      container is replaced.
- [ ] Auth keyring is exclusively created, mode-checked, fsync'd, absent from backup/children/logs and
      stable across ordinary restart. Missing/corrupt/mismatched keyring with live auth rows fails
      closed until host reset; AuthResetIntent crash tests prove DB authority is revoked before key
      activation and plaintext challenge is last. The reviewed Fastify cookie parser rejects malformed/
      duplicate/oversized authority cookies before lookup.
- [ ] Production uses explicit HTTPS PUBLIC_ORIGIN, dedicated hostname and exact proxy CIDRs. Spoofed/
      multiple forwarding headers, direct HTTP, unexpected Host/Origin and sibling-port requests cannot
      authenticate, renew or open SSE; v1 exposes no WS upgrade route and only the TLS edge is public.
- [ ] SSE is authenticated.
- [ ] Browser sessions and lane/run-scoped runtime ingress credentials are non-substitutable and authorize
      disjoint route sets.
- [ ] Runtime ingress credentials are hashed, scoped, rotated/revoked, replay-fenced and absent from
      browser responses, URLs, logs, diagnostics and persisted team/provider config.
- [ ] Canonical runtime bearers are absent from provider env/argv/settings/MCP files and reach only
      controller-owned per-lane relays through inherited bootstrap FDs; every emitted child key has
      checked-in provenance.
- [ ] Controller-secret and out-of-CredentialExposureSet canaries are absent from provider descendants
      and retained artifacts. Mixed units expose only their persisted minimum provider-secret union;
      dedicated units receive no unrelated provider credential.
- [ ] Default capability/meta reports `runtimeIsolation: trusted_process`; no live/unclassified
      runtime exists when plaintext pairing material is present, and tests/docs never claim OS sandboxing.
- [ ] Documentation states that local relays, env filtering and process anchors prevent accidental/
      stale cross-scope effects but do not isolate a malicious same-UID runtime from controller memory,
      sibling local endpoints or mounted files.
- [ ] Browser never sees server secrets.
- [ ] Browser never supplies an authoritative host path.
- [ ] Browser never supplies a raw PID; hosted terminal controls/contracts/routes are absent in v1.
- [ ] Opaque resource references and workspace traversal/symlink/rename-race tests pass; unsupported
      filesystem operations are absent from capabilities rather than guarded only by `realpath()`, and
      every reference/grant is fenced by current workspace mountGeneration.
- [ ] File/review/Git/provider-spawn operations pass active parent/symlink/root/bind-mount races
      with zero outside-marker effect; blocked/missing/stale guard produces zero effect and no fallback.
- [ ] Hosted Git worktree/review verbs cannot execute repository hooks, pager, fsmonitor, external
      diff/textconv, credential helper or remote network action.
- [ ] Provider credentials and private payloads are redacted.
- [ ] Tool approval policy and decisions are server-authoritative, audited, and multi-tab safe.
- [ ] Identity repair routes are absent outside explicit maintenance mode; inside it, normal
      mutation/runtime admission is closed and expected-evidence/backup/idempotency/audit tests pass.

### Runtime and persistence

- [ ] All providers expose explicit capabilities.
- [ ] Every accepted run persists one immutable CompositeRuntimePlan and all current lane topologies,
      rejection/order/partial/cancel/restart cases pass without re-planning or duplicate side lanes.
- [ ] Every actual provider process maps to one immutable ProcessExecutionUnit with environment-policy
      hash and CredentialExposureSet. Capability/meta distinguishes shared versus dedicated execution-
      unit credential isolation, and recovery cannot widen or remap a set.
- [ ] Runtime cutover is one-way per TeamId: legacy active generations expose only drain controls,
      canonical launch/rebind/topology edits wait for verified legacy-run cleanup, and ambiguous candidates
      never become currentRunRef.
- [ ] TeamLifecycle and LifecycleRun remain separate: drafts/preflight have no fabricated RunId,
      accepted launch advances exactly one currentRunRef, completed/cancelled/stopped runs never reopen, and stale prior-run
      events cannot change current team state.
- [ ] Hosted image executes its emitted internal-storage worker with Node-ABI SQLite and smoke-loads
      every required native/controller/MCP/provider artifact before readiness.
- [ ] Hosted lifecycle recovery matches desktop semantics where required.
- [ ] One runtime root has one hosted controller writer; external agent writers are reconciled.
- [ ] ADR-16 ownership cannot be lost/reacquired inside a live controller. Mutation/recovery/process
      state advances only while InstanceLeaseGuard holds its inherited FD; heartbeat/metadata never
      steals or grants ownership, and release occurs only with complete controller lifecycle exit.
- [ ] Every mutation has a versioned ADR-34 CommandDescriptor, normalized intent projection, HMAC
      fingerprint golden vectors and retained-version compatibility. Same key plus changed intent
      creates no command/effect; key rotation/ADR-26 replacement preserves referenced fingerprint
      keys, and a binary/keyring unable to compare live retained records fails before write.
- [ ] Every external step persists one ADR-34 recovery class, state and evidence schema. Ambiguous
      partial effects remain recovering/operator_required and are never reported as a retryable clean
      failure; automatic retry/commit occurs only after descriptor-required deduplication or absence
      proof, and compensation is feature-owned/idempotent rather than generic snapshot rollback.
- [ ] Workflow-starting commands commit one stable accepted workflowRef before external effects;
      command committed is never displayed as workflow completed, and timeout/retry/later workflow
      failure cannot create a second run/saga.
- [ ] Stable OperatorId idempotency survives session renewal, device-family rotation and host re-pair;
      browser and runtime-ingress key scopes cannot collide or duplicate an accepted effect.
- [ ] ADR-27 pending receipts exist before network send, contain no command body/prompt/path/secret,
      resolve only for matching authenticated actor/action/deployment, and recover timeout-before-commandId
      without automatic mutation replay.
- [ ] Config writes are ordered/flushable and aggregate journals recover paired mutations.
- [ ] Provider artifact inventory and current/legacy/future/corrupt golden fixtures pass.
- [ ] Legacy CLI-owned files retain unknown fields.
- [ ] Team IDs use the ADR-6 replicated team.identity.json + committed SQLite row/checksum protocol
      and WorkspaceIds use immutable registrationKey; volatile team.meta/members.meta never carry
      identity authority. Every file/intent/index combination follows the tested recovery matrix, while
      duplicate, missing, corrupt, unanchored or rebound identities fail mutation readiness without
      silent reassignment, republish or name-based adoption.
- [ ] Create accepts requestedTeamKey only as validated creation input, reserves it atomically with
      TeamId, returns TeamId for all later browser actions, and rejects unsafe/case-fold/cross-root/
      tombstoned collisions; display rename never changes filesystem identity.
- [ ] Anchor publication is impossible until provisioning cleanup, draft/permanent deletion,
      backup/restore/prune, shutdown backup and same-name resurrection pass the identity-preservation/
      tombstone gate; legacy `_backupIdentityId` remains correlation evidence and never authorization.
- [ ] TeamWorkspaceBinding is versioned/server-owned; mutable config path drift yields mismatch and
      cannot change runtime/file/Git authority without an explicit authorized rebind command.
- [ ] WorkspaceId remains stable by registrationKey while every boot/remount creates a new
      mountGeneration; stale file/review grants and runtime plans fail, same-boot root changes
      close admission, and the product does not claim cross-boot volume identity it cannot prove.
- [ ] TeamRoster is versioned and MemberId-authoritative; remove/restore/replace preserve explicit
      logical identity, legacy case/auto-suffix ambiguity blocks mutation, and stale memberRevision/lane
      evidence cannot attach to the current member.
- [ ] Corrupt/future state fails according to the catalog.
- [ ] Built artifact carries a verified ADR-23 StateCompatibilityManifest; startup scans every state
      family/non-terminal record before migration, and N/N+1 tests prove in-place, drain, backup-restore
      or write-free refusal instead of an assumed downgrade.
- [ ] ADR-26 replacement restore preserves logical deployment/entity/audit identities but rotates
      boot/event/session/runtime credentials and mount generations; cross-root partial activation cannot
      pair or mutate, and clone/fork/non-empty-target attempts are refused.
- [ ] ADR-32 distinguishes live app-only coordination backups from full quiesced deployment recovery
      points. Only Online Backup API output plus completely hashed/fenced participants and a final
      commit marker is restorable; raw DB/WAL copies, partial/mtime merge and `legacy_unverified`
      backups cannot activate. Crash, disk-full, prune and cross-root restore matrices pass.
- [ ] ADR-29 classifies every externally writable operation. App-exclusive/cooperative paths prove
      exactly-once committed semantics; uncoordinated active direct writes are impossible, and only
      provider-mediated observed outcomes or revision-rechecked quiescent mutations are advertised.
- [ ] Generic Claude-compatible file writes remain team-scoped ExternalFileActor events; only
      provider-verified artifacts gain RunId/member attribution, and fileWriterEpoch quiescence prevents
      queued old-run observations from appearing as current-run activity.
- [ ] Watch-before-scan, notification overflow/loss, partial write, atomic rename, scoped rescan and
      shutdown dirty-scope recovery tests pass without broad recursive scans.
- [ ] ADR-33 snapshot responses return a cursor represented by the same SQLite transaction or a lower
      C0 captured before external projection. Every event committed during projection is replayed;
      duplicate/stale events converge by revision/generation, retention loss causes resync and the
      deterministic boundary scheduler finds no lost-update execution.
- [ ] Machine runtime callbacks cannot override workspace/team/member/run authority and stale or
      conflicting callbacks create no mutation/event.
- [ ] Each provider spawn has intent plus ADR-31 anchor ready/handshake/ownership evidence. Normal stop,
      controller EOF and TERM/KILL escalation reopen readiness only after typed `drained`; broken or
      escaped ownership becomes unclassified and requires whole-container replacement.
- [ ] No hosted path signals a persisted PID/PGID. PID churn fixtures prove marker-owned unrelated
      processes survive while pidfd/anchor/control semantics drain the owned tree.
- [ ] Hosted v1 contains no terminal capability, route, renderer effect, daemon artifact, migration,
      socket or store. Desktop terminal IPC behavior remains covered by its existing regression gate.
- [ ] Shutdown affects only instance-owned anchors and the final container lifecycle proves
      zero surviving fake-runtime processes.

### User workflow

- [ ] Browser login works.
- [ ] Team list/detail works.
- [ ] Create/prepare/launch/progress/stop works; an accepted draft retains one TeamId and retryable
      configuration across failed provisioning, while explicit draft deletion is recoverable/idempotent.
- [ ] Tasks/Kanban/messages work.
- [ ] Member management and recovery controls work.
- [ ] Logs/activity/failure diagnostics work.
- [ ] Review/comments/relationships/attachments work.
- [ ] Tool approval flow works safely.
- [ ] Delete/restore and destructive flows are protected and work.
- [ ] Reload/reconnect/restart preserves correct state.
- [ ] Deferred actions are visibly unavailable before click.
- [ ] Required web flows pass keyboard/focus/accessibility checks and all new user text is localized.

### E2E evidence

- [ ] Built production browser and real server run together.
- [ ] Browser E2E uses an HTTPS edge, explicit PUBLIC_ORIGIN, exact trusted-proxy CIDRs and production
      `__Host-`/`__Secure-` cookies; it does not inject auth state or enable insecure cookies.
- [ ] Pair -> device -> session, ordinary container restart, access renewal, two-tab/lost-response
      rotation, replay revoke, forget-device and host reset-after-runtime-drain all pass through the
      real browser/network/storage boundary.
- [ ] No fake fetch/EventSource at the tested boundary.
- [ ] New sandbox project and temporary runtime state are used.
- [ ] Fake runtime produces deterministic lifecycle evidence.
- [ ] Docker restart and SIGTERM cases pass.
- [ ] Competing-container, lock-anchor replacement, launcher/controller crash/stop, lock-FD leakage,
      clean handoff, command crash-point and event-epoch restore cases pass.
- [ ] Hosted-terminal absence gate passes for browser chunks, RouteCatalog, capability manifest, image,
      migrations and startup processes.
- [ ] No unexpected 404/401/500 in the browser flow.
- [ ] Desktop regression gate passes.
- [ ] Optional live provider smoke uses only fresh sandbox projects.
- [ ] Every ledger action in required rollout state references passing semantic conformance and real
      browser E2E evidence; method-name/200-only coverage is rejected.

## Immediate tasks after plan acceptance

Do these before adding any hosted endpoint or production implementation from the closed PR:

1. Fetch and pin the then-current remote target-base SHA; create
   `refactor/hosted-web-feature-boundaries` from it with no ancestry from PR #250.
2. Run and classify the clean-base CI/test/security baseline.
3. Check in the capability/action ownership matrix, ADRs, AST-backed parity ledger/scanner,
   evidence-gate tables, ADR-23 state compatibility source, and salvage ledger.
4. Add architecture fitness tests and negative fixtures before broad feature code.
5. Close ADR-16 first in the target image: build the instance-lock launcher and provisioned-volume
   fixture, then prove two containers, path replacement attempts, lifecycle crash/stop and descendant
   FD scans. Close ADR-28 next: build the guard, prove process/PTY cwd and bounded file primitives,
   run the active-race negative control, and freeze Git execution policy. In the same evidence pass,
   freeze ADR-29 writer classes and active-run semantics from real provider callsites/fixtures; prove
   ADR-30 environment/relay secrecy-from-inheritance and ADR-31 anchor drain/PID-reuse behavior. Do
   not expand dependent application work if any gate fails.
6. Define the small shared kernel and first read contracts under their owning features.
7. Introduce RuntimeInstanceContext, protect every legacy destructive/backup path before anchor
   publication, then add the ADR-6 replicated TeamIdentityFileStore/TeamIdentityRegistry with
   adoption/recovery matrix, versioned TeamWorkspaceBinding, and read-only `workspace-registry` with
   hosted-manifest and desktop compatibility adapters.
8. Extract ListTeams/GetTeamLifecycleSnapshot/runtime read projections into `team-lifecycle` with
   unchanged IPC mapping to legacy getData.
9. Implement the durable mutation/outbox/recovery protocol, ADR-34 versioned command fingerprints/
   per-effect evidence classes, and bounded watch-before-scan external-writer reconciliation with its
   fixture corpus. Unknown or non-reconcilable effects default to operator-required, never retry.
10. Extend the Phase 2 draft lifecycle with Prepare/Launch/ProvisioningStatus/Cancel/Stop and establish
    `team-runtime-control` as the only team process-execution authority, split canonical machine
    ingress from browser control, and reuse runtime-provider-management/team-runtime-lanes/current
    runtime-control as compatibility inputs. Persist and execute one immutable CompositeRuntimePlan
    per accepted generation before altering provider internals; keep TeamLifecycle.currentRunRef and
    immutable completed LifecycleRun records as separate aggregates. Hosted execution uses ADR-30
    per-lane relays/allowlist-first environments and ADR-31 process anchors, never PID or bearer-env
    compatibility fallbacks.
11. Refactor existing standalone into the app-level hosted composition and harden its Docker target:
    no production Electron/native stubs, emitted internal-storage worker, Node-ABI SQLite and
    required artifact smoke probes.
12. Implement ADR-7 pairing/device/session/reset plus explicit HTTPS PUBLIC_ORIGIN/proxy enforcement,
    workspace security and per-lane/run machine-ingress credentials/replay fencing before enabling
    mutations. Ordinary restart/renew must not lock out the operator or create plaintext pairing beside
    a live runtime.
13. Build `team-console` and wire login -> list -> detail -> create -> launch -> progress -> stop
    through TeamTransportReconciler and feature-owned reconcilers.
14. Only after that expand tasks/messages/events and the remaining v1 parity suites. Do not start
    post-v1 T1 terminal while any v1 critical-path or release-gate work remains.

## Final assessment

New implementation branch readiness: 0%; it intentionally does not exist yet.

Closed PR usefulness as a discovery/test reference: approximately 45-55%. Expected direct/manual
salvage into the new design: approximately 15-25%, subject to the salvage policy.

The accepted v1 release scope is broad TeamsAPI parity without hosted terminal. The planning estimate
to use for staffing and integration is 28k-45k net fresh-branch changed lines, not the smaller
lifecycle-MVP estimate and not the closed PR's 7,160-line diff. Post-v1 T1 terminal is separately
estimated at 6.5k-11.5k across this repo and terminal-platform; eventual combined net scope is roughly
34k-56k, with shared infrastructure counted once.

Current ratings:

- confidence in this audit: 9/10;
- confidence in the pre-Phase-0 line estimate: 7/10;
- implementation complexity: 9/10;
- initial clean-branch bug/security risk: 9/10;
- expected risk after all required gates: 4/10.

This is not an overnight patch if quality is the requirement.
It is a staged architecture migration with a clear first vertical slice.
The fastest safe route is to build that slice through shared use cases, not to add
another layer of aliases and mocks around the existing Electron-shaped API.
