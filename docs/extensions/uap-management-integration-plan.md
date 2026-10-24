# UAP management integration in Agent Teams

Status: implementation plan v3; independent lifecycle, transport and UX critiques incorporated.

Master contract/lifecycle/scenario plan:
https://github.com/777genius/universal-agent-plugins/blob/feat/management-sdk-20261024/docs/plans/management-sdk-and-agent-teams.md

UAP implementation PR: https://github.com/777genius/universal-agent-plugins/pull/500

Owner authorization on 2026-10-24 covers research, plan revisions, implementation,
real Electron end-to-end verification, early draft PRs, immediate push of every
commit, independent final review, and merge after required checks and resolved
findings. It does not authorize bypassing Full qualification or public release.

## Product outcome

Manage universal plugins and standalone Skills from the existing Extensions UI:
discover, install, inspect, update one/selected/all, restore locked dependencies,
repair, remove, and recover interrupted work. The Go UAP engine remains the sole
owner of resolution, installation policy, native effects, receipts, and recovery.
The reusable TypeScript SDK talks to its versioned HTTP/OpenAPI contract.

Keep the familiar Plugins / MCP / Skills / API Keys tabs and the pinned project
context. Preserve native Claude marketplace installations and local Skills
authoring. UAP identity is not name@marketplace and must not be forced into
EnrichedPlugin. Distinct native and managed items never merge by display name.

The previous docs/extensions/plugin-kit-ai-integration-plan.md is a historical
draft: retain its useful product context while this plan supersedes its old
engine/CLI assumptions. Accepted native identity and separate Skills-domain ADRs
remain valid. Add a narrow ADR for managed remote Skills, now explicitly requested
by the owner, without rewriting the local authoring model.

## Implementation boundaries

Use src/features/extension-management with only necessary layers:

- contracts: browser-safe requests/results and IPC/HTTP names.
- core/application: captured environment context and narrow UAP management port.
- main/adapters/output: TypeScript SDK adapter; no second solver or installer.
- main/infrastructure: resolve exact staged UAP executable; process ownership is
  delegated to the SDK Node helper.
- main/adapters/input: IPC and HTTP route adapters calling the same facade.
- main/composition: resolve canonical project/profile/runtime/root identity.
- preload: typed bridge.
- renderer/hooks: context-keyed query, preparation, accepted operation observation.
- renderer/ui and view-models: presentational managed cards, detail/action/result
  views using shared Radix controls and existing Markdown/diff presentation.

Do not create empty layers, grow frozen oversized extensionsSlice/SkillsPanel,
or put mutation policy in React/Zustand. Keep app-shell integration through public
feature entrypoints. Native MCP/API-key flows are outside the rewrite scope.

HTTP parity is required by the feature architecture standard. Browser code uses
the app backend, which owns UAP. Neither browser nor Electron renderer receives
the loopback capability token or arbitrary filesystem/process authority.

## Captured context

The trusted host captures project identity/root, actual agent runtime, profile and
configuration revision, supported target/scope, native executable/profile roots,
and UAP environment identity. UI supplies selection identifiers and intent.

An operation accepted in context A remains bound to A when the user opens B.
Late responses cannot overwrite B's state. Changed profile/root/config invalidates
an unapplied plan. An LLM vendor/model is not an agent installation adapter.

Agent Teams Host migration #982 was open draft at baseline
70546fe36766e632940300f51b2a8ba764db6fe9. Build against main through a focused context
port. Recheck before merge; if that migration lands, bind UAP below its captured
management ownership instead of adding a bypassing writer. Do not cherry-pick the
entire draft or create a parallel general management journal.

## UX rules

Reuse ExtensionStoreView, SearchInput, shared Button/Badge/Dialog/Select/Tooltip,
Markdown and diff components. Add a UAP-specific view model and behavior rather
than copying Claude-specific card assumptions.

Normal path: search/select -> see scope/runtime/compatibility -> Install -> actual
phase/result. Prepare while showing details. Review meaningful dependency,
permission or target changes; avoid a mandatory multi-step wizard for every install.
Unsupported actions explain the engine's actual reason.

Installed and ready are distinct. Show manual activation/authentication,
partial/incomplete targets, and recovery actions truthfully. Refresh from
authoritative UAP state after operation completion. Store no success solely because
HTTP returned 202. Retry a lost response using the original accepted request ID.

Updates and restore live with installed items. Update selected/all delegates one
candidate environment to Go; it is not a UI loop. Exact pins and unavailable checks
remain explicit. Put paths/digests/receipts in optional diagnostics.

## Managed Skills ownership

Current SkillsMutationService writes/imports/trashes files. It must consult
authoritative UAP ownership on the backend before editing, import overwrite, or
delete. Hiding UI controls alone is not protection.

Managed update/remove/repair goes through UAP. Offer explicit editable copy into a
new unowned local destination. Preserve local Skills editing/import/delete for
unowned files. Test both successful local edits and rejected backend bypasses.

## Project/worktree boundary

Project installation is a separate active UAP workstream (#472/#475/#480).
Advertise only capabilities actually implemented by the pinned qualified engine.
Never silently map local/project to user.

A source-project dependency manifest is not automatically materialized in an agent
worktree. A focused environment preparation port must restore exact locked
dependencies into the actual execution cwd before a new run. Do not copy .uap state
directories. Shared native profile files can be re-read by active agents. V1 refuses/defer
mutations affecting an active captured profile/project before effects, using a
focused runtime-activity port. Unaffected profiles remain usable. A next-launch
label alone is not isolation; no new per-run snapshot framework is introduced.

Project/worktree success cannot be claimed until prerequisite project support and
registry policy are qualified. Unsupported capability is a first-class tested UI
state, not a hidden fallback.

## Acceptance and evidence

| Area | Acceptance |
| --- | --- |
| Catalog/install | Real SDK -> real Go binary -> actual manifest/lock/native config/files -> UI state |
| Standalone Skills | Real source acquisition/pin, native projection and managed ownership |
| Local Skills | Existing editor remains functional for unowned files |
| Ownership | Backend refuses managed edit/import/delete; editable copy is separate |
| Update one/selected/all | Shared Go candidate graph, saved dependencies included, per-item outcomes |
| Locked restore/repair/remove | Exact pins and owned bindings; sibling profiles preserved |
| Context changes | A remains A; stale authority rejected; no arbitrary renderer paths |
| Interrupted/retried operation | Same accepted request, no duplicate effects, truthful recovery after restart |
| Cancellation | Waiting abort differs from mutation cancel; effects never called rolled back falsely |
| Missing runtime/auth/policy | Useful next action/reason; no false ready state |
| Native external items | Preserved identity and existing native behavior |
| HTTP and IPC | Same facade and equivalent validation/result semantics |
| Project/worktree | Qualified scope/root, exact execution-cwd materialization |
| Active run | Affected shared-profile mutation refused before effects; unrelated profile permitted |
| Package | Exact SDK/UAP artifact identity; no dev-only path or implicit latest |
| Electron UX | Actual clicks/screenshots, no renderer errors, compact normal install flow |

Master scenario IDs S01–S30 are maintained in the UAP plan. Before completion,
record each as implemented/verified/dependency-blocked with concrete evidence.

## Implementation order

1. Publish this v1 plan and draft PR. Independently review master plan and frontend
   decisions; fix findings and immediately publish v2.
2. Complete UAP/TS SDK vertical install/retry/restart lifecycle before app binding.
3. Add exact binary/package staging, captured-context facade, IPC/preload/HTTP.
4. Add backend Skill ownership guard and explicit editable-copy flow.
5. Reuse frontend shell and primitives for managed Plugins and Skills, including
   update/restore/repair/remove, partial outcomes and recovery.
6. Wire qualified project/worktree preparation through focused provisioning port.
7. Run actual Electron UI lifecycle and native discovery qualification.
8. Independent final review; fix issues; run relevant checks and current-commit
   Full qualification; merge only with all applicable gates clear.

Every commit is pushed immediately. Plans, critic findings and results are stored
in these PRs. Do not mark an unexecuted test as passed.

## Electron verification

Use pnpm dev:mcp and the existing scripts/e2e/comment-notification/cdp.mjs client.
Follow group-chats-desktop.ts for process-owned debug-port discovery, test-only
HOME/XDG/userData/project fixtures, mouse/keyboard interaction, screenshots and
console errors. Its synthetic runtime history is not installation proof.

The new harness must call the actual SDK and Go executable. Fixtures may provide
controlled package sources/releases, never fabricate install outcomes or prewrite
the state under assertion. Verify native files and small native-agent discovery/
tool handshake. Restart the actual UAP process/app for recovery scenarios.

Add a focused UAP desktop E2E workflow or lane; existing packaged path filters do
not automatically exercise ordinary Extensions changes. Reuse Xvfb/Linux support
and existing packaged matrix, capturing app SHA, UAP SHA/digest, SDK identity,
scenario results, sanitized logs, and screenshots.

Never test real user projects, open native folder pickers, or substitute browser
dev for desktop E2E. Stop only processes created by this harness.

## Resolved integration decisions from v1 critics

### Exact package and runtime delivery

Vendor the SDK .tgz built from an exact reviewed UAP source SHA, with package
identity and SHA-256, using the existing vendor/terminal-platform/sdk precedent.
Build native UAP during app build/CI from the same source pin using UAP's declared
Go toolchain and read-only module resolution. Stage it into packaged resources.
Include license/third-party notices and record both identities in test evidence.

No end-user Go compilation, implicit latest download, unpublished npm dependency,
sibling-workspace requirement or expiring artifact URL. Clean-checkout build and
packed SDK consumer are acceptance gates. A public release remains a separate
authorization; source build is the concrete delivery path for this change.

### HTTP authority

Current HttpServer CORS behavior is insufficient authority for native management.
New feature routes require exact trusted Host/Origin and loopback client, bounded
JSON mutation bodies, and the same captured context validation as IPC. Untrusted
Origin/Host, CORS='*', and non-loopback callers must be refused before invoking the
facade unless an existing authenticated trusted deployment adapter supplies
authority. Keep this feature-local; do not start a global authentication rewrite.

HTTP parity covers new management endpoints only. Existing legacy native store web
limitations are not silently added to this task.

### Context, lifecycle and readiness

A UAP session binds an immutable capture of native profile roots and executables.
Production omits state/dependency root overrides so Go selects the canonical UAP
CLI home and shared ownership locks. Capture one current profile for each supported
client in one engine session; runtime selection narrows installation/removal
targets. A profile change requires a fresh capture. Bindings outside that capture
are not silently reassigned or presented as active in the replacement profile.

Accepted request lookup precedes expired plan lookup, including combined lost
response and process restart. SDK waiting cancellation never kills the engine.
Only the host's explicit close controls its own child; graceful shutdown is bounded
and interruption remains recoverable. Navigation does not dispose accepted work.

Active shared-profile mutation refusal is required for install, update, repair,
restore and remove. Check again immediately before applying; frontend disabling
alone is insufficient. Test an affected running context and an unaffected profile.

Do not flatten materialization/activation/authentication/verification to one
installed boolean. A completed HTTP operation may still require a manual action.
Unknown future outcomes are conservative, never success.

### Prerequisites and completion

Independent foundation/API work can merge when its own supported capabilities
qualify. Full project/worktree integration cannot be called complete until the
separate qualified project engine passes S25/S26. Disabled project actions are
correct fallback evidence, not successful project-installation evidence.

## Required checks and constraints

Follow AGENTS.md, CLAUDE.md, AGENT_CRITICAL_GUARDRAILS.md,
docs/FEATURE_ARCHITECTURE_STANDARD.md, src/features/CLAUDE.md, and
docs/GIT_DELIVERY_POLICY.md.

Use pnpm and pinned TypeScript 7 through pnpm typecheck. New scripts are .ts.
New production files stay <=800 physical lines; frozen legacy caps do not grow.
No broad lint:fix, no facade inheritance, no generic whole-service host casts.

Required final evidence: focused feature and transport tests, typecheck, full lint
for this cross-process change, build, source-size/architecture guards, actual
Electron E2E, independent technical review, required CI including Full qualification
for the current commit. Do not modify protections, bypass checks, or force push.

## Review log

v1: incorporates repository/source research and initial critic discoveries:
HTTP parity, distinct native identity, backend Skill ownership, frozen file caps,
project/worktree prerequisites, Host migration context, and real desktop evidence.
Independent review of this written plan is pending.

### v2 critic dispositions

- Replaced unenforceable active-run freeze wording with backend affected-profile
  mutation refusal/defer and explicit unaffected-profile behavior.
- Added strict feature-local HTTP admission; broad CORS is not authorization.
- Chose same-source vendored SDK/native build before host implementation.
- Limited HTTP parity to this feature; preserved existing native/local domains.
- Incorporated immutable profile context, durable retry ordering, host lifetime,
  readiness axes, and honest project/worktree completion gates from UAP review.

Implementation and final UX reviews remain separate gates.

### v3 final UX review dispositions

F1/F2/F4/F5 were incorporated in v2. The remaining required findings are resolved
as explicit implementation and qualification requirements:

- F3 ownership is managed/proven-unmanaged/unknown. Engine unavailability never
  means unowned. Resolve canonical physical destination identity, reject symlink/
  alias bypass, revalidate at apply, and coordinate app-managed mutations. Inspect
  current UAP projection/lock invariants before claiming protection from concurrent
  external CLI install; add only the narrow necessary shared reservation seam.
  A general remote filesystem-lock service is not the default. Copies use a distinct
  proven-unmanaged destination and normal import/review validation.
- F6 add Install from source in Plugins for advertised source forms. In Skills,
  source URL -> candidate list/preview -> scope/runtime -> install. Preserve local
  authoring/import. Reuse a small source dialog; explicit unsupported/private-auth
  limitations come from capability data. No arbitrary process/path/CLI forms.
- F7 test keyboard-only selection, detail, install/action and dismissal, plus a
  narrow Electron window with usable actions/scope/errors/recovery. Assert focus
  and accessible labels and inspect screenshots with existing CDP.
- F1 effect-boundary guard coordinates launch/mutation ownership so a new run cannot
  start between two activity checks; no unsupported active-run freezing promise.

Required ownership tests include engine unavailable, canonical alias/symlink,
same-destination install during edit, import overwrite, direct backend delete, and
successful explicit copy. Required desktop tests include supported direct-source
candidate selection, affected active run refusal and unrelated profile success.

Plan direction is ready for implementation. These gates remain mandatory in code
review and cannot be represented by UI-only disabling or synthetic install results.

### v4 implementation review and authority corrections

This revision follows UAP plan v4 at
`b16f5396e72ad91e1cdc5e628ba3e364dae77b75`.

- **Shared CLI ownership:** normal startup omits state and dependency roots. Go
  resolves `AGENTPLUGINS_HOME` or the platform configuration directory. An
  app-private store cannot authorize writes over projections owned by the default
  CLI. Explicit isolated roots remain available for tests and registered embedder
  environments; they do not prove custody across arbitrary foreign stores.
- **Environment versus capture:** durable work belongs to stable engine-derived
  `environmentId`. Each plan and operation also retains its immutable `contextId`
  and dependency root. Changing executable or display labels must not hide pending
  work; recovery cannot settle an old environment by inspecting a replacement.
- **One captured native environment:** capture Claude, Codex and OpenCode profiles
  once and reuse the owned connection as the selected runtime changes. Installs
  and removals name their target IDs. An update of an existing alias may affect
  all its bindings; Update environment and Restore locked cover the shared
  manifest. The reviewed plan, not the currently visible tab, identifies effects.
- **Admission:** retained plan targets select the affected native roots and active
  clients. Unknown/recovery scope stays conservative. Existing runtime metadata
  lacks complete original profile roots, so a different already-running profile
  of the same client may remain blocked until stronger runtime authority exists;
  this limitation must not be described as verified unaffected-profile support.
  Launch and mutation share one admission gate at the existing runtime boundary.
- **Local Skills:** create/edit/import/delete/copy/restore use Go retained local
  plans, exact old-file digests and whole-directory snapshot checks under the
  canonical installer locks. Reuse `dirswap.Manager` and its recovery authority;
  do not add a generic lease or a Node check-then-write path. Project local Skills
  authoring does not imply native project plugin activation.
- **Reversible deletion UX:** engine-owned backups stay outside native discovery.
  A successful deletion must remain discoverable and restorable after the panel
  and app restart. Use bounded restore-point metadata from the existing durable
  ledger, or an already supported history surface. Do not introduce a parallel
  app receipt database merely to remember completed deletes. Generic native
  recovery cannot settle a local file operation; restoration names its exact
  original operation/root/name and receives a fresh review.
- **Acceptance uncertainty:** main retains request ID and plan across lost replies
  and exposes that retry handle when the panel remounts. Empty observation is not
  proof of no acceptance. Only the exact observed operation, or a definitive
  pre-effect refusal after durable replay lookup (for example `PLAN_STALE`), can
  resolve uncertainty. Review dismissal discards only unaccepted plans; it never
  cancels accepted work. Mutated cancellation and unresolved outcomes remain held.
- **Update wording:** preserve the engine's existing minimum-compatible range
  policy. Explain ranges and pins briefly; never claim that Update selects the
  greatest published version. Always display actual proposed version changes.
- **Packaging:** exact vendored SDK and native executable derive from the same
  reviewed source commit. Build uses UAP's declared Go toolchain and read-only
  module resolution. Include notices and record digests. macOS/Windows signing
  changes executable bytes, so verify the final signed-artifact integrity design
  rather than assuming a pre-sign checksum remains valid.
- **HTTP authority:** the desktop sidecar uses the same facade and actual socket
  peer, exact Host/Origin, JSON and request limits. A standalone host requires a
  concrete runtime-activity authority; an invented empty activity list is not
  parity. Resolve or explicitly capability-gate that host before qualification.

Independent v4 review found no reason to add a daemon, second transport, generic
file lease, parallel installer or new frontend framework. The mandatory remaining
UX items are restore-point discoverability and truthful range-update wording.

Current local evidence is limited to the focused app contracts/application/
IPC/HTTP/preload typecheck, 20 focused behavioral tests and the source-size guard.
The complete repository TypeScript check exceeded the workspace's memory limit;
it is not recorded as passed. Renderer/integration typechecks, full lint/build,
actual Electron clicking, native discovery, signed packaging, full CI and final
independent review remain open. The managed/local Skill adapter is still being
integrated. Project/worktree S25/S26 remain blocked on the separately qualified
engine workstream; a disabled control is only fallback evidence.
