# UAP management integration in Agent Teams

Status: implementation plan v11; noninteractive native input correction and final current-commit qualification.

Master contract/lifecycle/scenario plan:
https://github.com/777genius/universal-agent-plugins/blob/feat/management-sdk-20261024/docs/plans/management-sdk-and-agent-teams.md

UAP implementation PR: https://github.com/777genius/universal-agent-plugins/pull/500

Owner authorization on 2026-10-24 covers research, plan revisions, implementation,
real Electron end-to-end verification, early draft PRs, immediate push of every
commit, independent final review, and merge after required checks and resolved
findings. It does not authorize bypassing Full qualification or public release.


## Current checkpoint — v11 (2026-10-25)

The clean desktop run on app `501916f1532d0c2bd48eb4867a09228116009c5f`,
synthetic merge `3cbfb0b8237770a62ad40ac68d571f2da1c25584`, completed the existing
UI journey with no renderer errors: installation, binary copy, update/removal,
local edit/delete, actual restart, capability revocation, exact restore and signed
registry install/removal. Artifact `12597537321` retains those assertions and
screenshots. The new source plugin also installed through the ordinary UI and
security review, with the expected UAP-owned native MCP configuration.

The new native invocation then timed out before any MCP/provider request. The
pinned OpenCode 1.18.34 [run command](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/cli/cmd/run.ts)
reads non-TTY stdin to EOF before creating the session, even when a prompt is
supplied as an argument. Node's promisified execFile left that pipe open. The
helper now closes only its owned noninteractive child's stdin before awaiting
completion, matching the existing successful Go fixture's EOF behavior. The
90-second deadline and all native protocol assertions remain unchanged. Failure
logs now retain the error even when native stdout/stderr are empty. This is a
test-driver correction, with no production/runtime or provider configuration
change. The previous overall failed receipt remains failed; a new clean complete
run is required.

All four test shards, all three lint shards and canonical validation passed on
501916f. Its Windows task smoke and platform package matrix were still unfinished
at this checkpoint. The next head must satisfy its current gates; the live PR
records subsequent exact-revision results. UAP executable/SDK source remains
5224, independently requalified through the unchanged Python client and real
OpenCode native discovery in 27.03 seconds. Formal CodeQL disposition and the
separate project/Host prerequisites remain explicit outstanding boundaries.

## Previous checkpoint — v10 (2026-10-25)

This continuation builds on published app
`ed4d3e3f4c1c5a62bca1184b28b75b06433ba43b` and the same matched UAP source
`5224ebd5f66bbdfab0bef906dba0b089062f6073`. The engine and SDK pins are unchanged.

Independent review identified a source-entry mismatch: plugin revisions belong
inside the engine's source reference, but the form displayed a separate revision
field which Go did not consume. Plugins now show one source input, an optional
alias, and the supported `owner/repository@revision` syntax. Skills keep their
existing discovery revision field. The input boundary accepts bounded remote
references without duplicating Go's source parser; it still rejects obvious local
paths. Go remains authoritative for acquisition, supported syntax and refusal.
All 29 locale namespaces and generated types include the helper text. Thirty-five
focused tests passed, including regression cases that failed before correction;
two independent reviewers found no remaining substantial issue in this slice.

The desktop lane now adds an actual native MCP dispatch after the existing signed
registry journey. A disposable HTTPS archive contains a standard plugin manifest
and MCP definition. The ordinary UI review/apply flow installs it; UAP alone writes
the native MCP configuration. Real pinned OpenCode then runs against a scripted
loopback model transport. Assertions require initialize, tools/list, tools/call,
the exact nonce-bearing arguments and the returned tool result in the subsequent
provider request. UI removal is followed by a fresh native session that must
advertise no tool and make no MCP connection. This proves the actual native tool
transport, not model intelligence, provider authentication or OAuth. The small
fixture follows the already exercised UAP native protocol test and introduces no
production framework. Independent review and canonical desktop TypeScript passed;
the clean current-commit runtime receipt remains required.

The previous clean desktop run
[40187287946](https://github.com/777genius/agent-teams-ai/actions/runs/40187287946)
passed install, HTTP capability/refusal/deduplication, copy, update and removal,
then failed before local edit. Its screenshot shows the enabled editor, and the
stack identifies a harness race: the successful readiness observation was
discarded, then a second observation failed during the dialog transition. The
click helper now uses the successful point directly and waits for finite target
and ancestor animations. Pointer events, hit testing, exact-value assertions,
timeouts and single Apply submission remain intact. This correction was
independently reviewed; the failed receipt is not relabeled as a pass.

The same prior CI passed canonical validation and the test shard containing the
packaged MCP cleanup regression. Two export-order errors and a boundary-test
fixture which supplied an undefined HTTP header are corrected here. The missing
credential case now omits the header, allowing the actual server refusal to run.
Final Full qualification, actual Electron/native-tool evidence, applicable
packaging and formal CodeQL disposition remain required before merge.

## Previous checkpoint — v9 (2026-10-25)

Continuation starts from published app `52fcacc3cc69c6df8882ecbb7310abfb9c4b2c19`.
The new matched UAP source is `5224ebd5f66bbdfab0bef906dba0b089062f6073`, version
`0.1.91+agentteams.5224ebd5f66b`. The TypeScript SDK was rebuilt and packed from
that committed checkout. Its archive is byte-identical to the prior pack:
SHA-256 `31eb798b31be66d1c4d80d1cfa094934fa786cf2b46313360b4c6a8f6bfdd96c`.
The changed Go engine allows applying a retained plan when all 16 review slots
are occupied; both preparation paths retain their limit and all mutation gates.
Its red-before real-HTTP regression and complete transport package passed, and
independent review found no remaining substantial issue in that correction.

### HTTP authority correction

Every managed HTTP operation now requires a random sidecar capability in addition
to the existing peer, Host, Origin, JSON and body-size checks. Unauthenticated
`hostStatus` returns only a helpful unavailable response without invoking the
facade. The sidecar capability is distinct from the private Go credential.

Only the owned Electron main frame can request an authorized browser link through
a separate IPC operation; there is no HTTP grant endpoint. The existing Settings
Copy URL action supplies that link. The browser immediately removes its fragment,
keeps authority per tab and exact origin, and never sends it to another port or
host. Sidecar stop, restart and startup failure revoke the old capability.

Independent review found and corrected two additional cases: a fresh grant pasted
into an existing tab must refresh its cached client and unavailable panel; bug
reports must omit URL fragments even before API initialization. Six focused test
files passed 16 assertions, focused fast lint passed, and independent final review
reported no remaining P1/P2. Real HTTP and the extended Electron journey remain
current-commit CI gates. Local socket binding was sandbox-denied; the full local
typecheck also encountered missing `fastmcp` dependency types. Neither is counted
as a successful full qualification.

### Packaged process cleanup and inherited evidence

The packaged MCP smoke now keeps stdin open until ownership-verified shutdown has
settled, avoiding an EOF-triggered exit racing the process census. Its existing
actual-child regression now includes stdout/stderr on an exit-code mismatch.
The historic CI failure did not print that diagnostic, so its exact cause remains
unproved until the corrected current-commit test completes. Local syntax/diff
checks passed; the spawned test was blocked by the execution environment.

The clean [desktop CI run 40183926081](https://github.com/777genius/agent-teams-ai/actions/runs/40183926081)
completed the full journey with no renderer errors on synthetic merge
`1b00532a5db7be78a38824373d984c2ee23d7ded` (head `52fcacc3`, base `eb67de95`) and
BBC7. Artifact `12595184310` contains its receipt and 16 screenshots. Actual macOS
signing succeeded on both architectures in [package run 40183926123](https://github.com/777genius/agent-teams-ai/actions/runs/40183926123),
including jobs `121141121953` and `121141121920`. These named results preserve the
previous evidence; they do not qualify the new source pin or HTTP correction.

Current substantive Full qualification, clean Electron E2E, applicable packaging
and formal CodeQL disposition remain merge gates. Native project/worktree and
Host prerequisites remain separate. No public release is included.

## Previous checkpoint — v8 (2026-10-25)

The implementation is published in [PR #989](https://github.com/777genius/agent-teams-ai/pull/989),
with the Go contract and TypeScript SDK in [UAP PR #500](https://github.com/777genius/universal-agent-plugins/pull/500).
Historical v4–v7 sections retain their original evidence. Named test results are
tied to the revisions below; project/worktree prerequisites remain separate.
The preservation correction and this v8 plan are published together. Qualification
of that published revision is recorded in its current PR check runs and final
handoff; earlier results below do not replace those gates.

| Artifact | Reviewed identity |
| --- | --- |
| UAP runtime source | `bbc7e98da96dd7d77db42f65da7afae84a86f799` |
| Native version | `0.1.91+agentteams.bbc7e98da96d`, based on verified `agentplugins-v0.1.91` |
| Linux x64 native SHA-256 | `fcddfe935e8bfbdbe45b2131aa934240c0e2e2e236fb8c3c84c624a95b9c1b76` |
| Vendored SDK SHA-256 | `31eb798b31be66d1c4d80d1cfa094934fa786cf2b46313360b4c6a8f6bfdd96c`; rebuilt and packed from the same source |
| Actual native consumer | OpenCode `1.18.34`, executable SHA-256 `9ca0b9953d49997601655e54f846a3efa464f237e47c6f1b04716d0f2e64c4c2` |
| Orchestration runtime | `0.0.138`, provisioned by the ordinary locked bootstrap |
| App production checkpoint before the local-file correction | `e1798241e114fe6b530541e398491a8d14d1323d` |
| Correlated-operation desktop harness | `b1c5d7a8a8993c460395354d5ddcd7d253acc5df` |

### Reviewed behavior and integration corrections

- The browser HTTP client has a deliberately browser-safe public feature entrypoint.
  It cannot transitively import the managed panel, reused Skill dialogs or app store.
  Desktop composition loads after profile migration/bootstrap. The main/preload/
  renderer split and existing Team Provisioning authority are retained.
- Target capture obtains roots from the existing passive provider environment.
  Canonical-root errors still refuse capture. An unavailable native executable is
  recorded for that target without preventing an unrelated Claude/Codex launch.
  A failed explicit OpenCode probe does not silently select a different executable.
  Missing/corrupt UAP or durable pending work still prevents a conflicting launch.
- Terminal cancellation refreshes authoritative inventory. Old asynchronous polls
  and context A responses cannot overwrite a later capture B; observation retries
  observe the same operation without another Apply.
- Managed cards/reviews show alias, action, relevant version changes and labels from
  the captured session. Shared-graph actions identify every affected captured
  target. Raw identifiers, paths and ordinary readiness details are collapsible;
  warnings, unknown/abnormal states, conflicts and required confirmations stay visible.
  Installation success preserves exact public native follow-up instructions and
  never claims authentication or a restart that has not occurred.
- Local copy reuses the existing import/file-review dialog. Its explicitly supplied
  destination name survives initialization instead of being erased by the default
  name-suggestion effect. A regression reproduced the actual empty-destination
  failure before the two-line correction; all nine import-dialog cases then passed.
  The actual e179 desktop run copied text/binary bytes through Go successfully.
- The desktop HTTP route explicitly overrides the earlier broad CORS handler.
  Foreign origins receive the feature's refusal instead of an unrelated 500.
  The hostile-Host proof uses Node's real HTTP transport: Node 24 fetch rewrites
  that header and cannot establish a forged-Host request.
- Native SDK/protocol changes remain in Go: reserved future registry IDs do not
  borrow installed-release authority; physical aliases/mode drift are checked;
  Skills-only OpenCode actions do not fence unrelated MCP config selection; edited
  native content stays preserved; unaccepted expiry does not consume request IDs.

### Local editor preservation correction

Actual Electron verification exposed a pre-existing mismatch between the limited
editor draft and the planner's complete managed-directory replacement semantics.
An ordinary metadata edit submitted deletion of unrepresented reference files
and binary assets. The Go patch executor correctly carried out those explicit
deletions; the correction belongs in the app planner.

The planner now preserves supporting files outside the editor's represented
controls, including nested text and binary assets. The three generated starter
README drafts use validated `createOnly` intent: an existing custom text or binary
README stays unchanged, while a missing starter file can still be created.
Those skipped paths remain in the desired set and cannot accidentally become
omission deletions. Explicit text replacements/removals and import replacement
semantics are retained. This is an app draft field, not a new Go SDK/wire option.
Go still receives exact reviewed patches, observes the complete existing tree,
and owns mutation, expected-hash checks, backups and recovery.

Binary import deletions retain their expected SHA, are labeled binary, and are
not decoded as UTF-8 or described as a copy. The existing review UI and controls
are reused.

Red-before regressions reproduced omitted-file loss, scaffold overwrite and the
misleading binary-delete card. The final focused batch passed **38 tests in seven
files**, including the actual draft builder, request-marker validation/identity,
explicit replacement and rendered review distinctions. Focused production and
E2E TypeScript 7 checks passed using their canonical configurations. The size guard
and diff check passed. Fast lint reported zero errors and one unchanged
`DialogFooter` warning. A local typed-lint process exhausted its bounded 1.5 GiB
heap; it is not counted as a pass, and the current CI lint lanes remain required.

The harness now supplies the actual virtual key codes for Ctrl+A/Tab/Escape and
asserts the field's exact value after text input. Its Skills/Plugins navigation
checks `aria-selected` and the visible controlled panel, with at most three real
pointer attempts inside the existing 60-second navigation budget. Once selection
is observed it never re-clicks to hide a later state regression. This retry is
limited to idempotent tab navigation; Apply and native mutations are not retried.
Failure diagnostics retain requested/selected tab state, bounds and hit testing.

### Evidence and outstanding gates

[UAP Required 40176921783](https://github.com/777genius/universal-agent-plugins/actions/runs/40176921783)
and [Terminal UI 40176921781](https://github.com/777genius/universal-agent-plugins/actions/runs/40176921781)
passed on BBC7. All three local exact-artifact groups passed: signed official
registry install/remove; the unchanged packed SDK lifecycle; and the independent
unchanged Python protocol client. The SDK run actually observed `interrupted`
after a lost accepted reply and owned-process SIGKILL, then fresh recovery restored
exact native bytes without a duplicate dependency. Local create/edit/delete and
restart-visible undo passed. Python retained a prepared Skill through two catalog
discards before Apply and verified actual OpenCode discovery/bytes.

The verified signed feed contained 30 entries, 28 eligible. The reviewed
`cloudflare-docs 0.4.13-uap.1` lifecycle checked the exact native JSONC MCP object
and its removal. It did not invoke a hosted MCP tool or authenticate a model.
These receipts qualify BBC7, not unexecuted frontend paths.

[App CI 40180747963](https://github.com/777genius/agent-teams-ai/actions/runs/40180747963)
passed on source `e1798241e114fe6b530541e398491a8d14d1323d`:
[Full qualification](https://github.com/777genius/agent-teams-ai/actions/runs/40180747963/job/121132486698),
[canonical TS7/workspace validation](https://github.com/777genius/agent-teams-ai/actions/runs/40180747963/job/121131296750),
all four test shards, all three source lint lanes and the Windows ledger smoke.
The earlier 299 focused assertions belong to ede65; nine import-dialog cases
qualify e179's seeded-copy correction. An intentionally stopped local full
compiler is not counted as a pass. Subsequent changes require their applicable
current-head CI and separate Electron package qualification.

The clean b1c5 actual Electron run verified source preview/install, native Skill
visibility and exact files, keyboard preview navigation, 760px managed-panel
layout, same-state HTTP observation, foreign-Origin/rebound-Host refusals, real
HTTP create/delete/deduplication, exact binary local-copy preservation, targeted
update, and managed removal while the local copy remained. It then found a real
edit-plan defect: saving metadata removed existing files absent from the editor's
limited draft. The retained review screenshot showed the unintended deletions;
the binary was additionally mislabeled as text. This failed receipt remains
preserved as `app-b1c5d7a8-desktop/evidence.json`, not a completed S29 result.

The separate b1c5 [remote run 40182000578](https://github.com/777genius/agent-teams-ai/actions/runs/40182000578)
failed earlier, before the Skills panel mounted, with Plugins still selected.
Its retained artifact and screenshot do not reproduce the later local edit loss.
Layout movement between pointer sampling and dispatch remains a hypothesis; the
bounded tab postconditions above strengthen input verification without changing
production state or native assertions.

Pre-publication exploratory runs against a dirty checkout remain labeled as such.
They cannot qualify the subsequent published commit. Current-head Full
qualification, a clean completed desktop receipt, applicable package/signing
checks and formal security disposition remain required.

The harness correction at b1c5 captures the displayed operation ID before an
actual click and requires a different ID with a Completed status, so a previous
install cannot qualify a later copy/update/remove. It also waits for enabled,
visible, stable hit targets and finite dialog animations. It changes no native
assertion, result state, timeout, or production UI.

All 18 annotations at the named BBC7/ede65 checkpoints received independent
source/dataflow review (15 UAP, three App), with no demonstrated exploitable vulnerability under the
documented local-desktop authority model. The
[security disposition](https://github.com/777genius/universal-agent-plugins/blob/feat/management-sdk-20261024/docs/plans/management-sdk-security-review.md)
records each guard and limitation. Analysis jobs succeeded, but the aggregate
checks still report failure; source review does not itself clear that status.
No scanner rule, cache authority, security setting or branch protection was
weakened. At b1c5, the aggregate App check reports two annotations (the controlled wait
expression and the unchanged workflow pin). The historical three-finding audit
is retained; a new result is not silently treated as the old count. Formal
repository disposition remains a separate gate.

### Scope and measured maintenance cost

Native project/worktree S25/S26 remain blocked by open draft UAP #472/#475/#480
and Agent Teams Host #982. The latest inspected Host head was
`3b351f32474111bb9bd7943d1e6b5a06a3da5e84`. No draft adapter code was imported.
Project local Skill authoring does not prove native project activation.
The standalone HTTP viewer remains unavailable for managed mutations; desktop
sidecar parity is the qualified host boundary. Captures are bounded to 16 per host
lifetime with explicit restart guidance; no safe context eviction is claimed.

At the named published checkpoints, BBC7 against UAP main `a6beceba` adds 6,027
handwritten runtime/build lines and removes 331; app e179 against main
`eb67de95877d96567c79ea90b93b6db780b849b2` adds 4,072 and removes 182, for 10,099
combined added lines. The frozen correction reviewed for v8 adds 37 and removes
11 relative to e179. Its app diff against the same main is 57 handwritten
runtime/build files, 4,109 added lines and 193 removed. Combined with unchanged
BBC7, the frozen v8 review therefore measures 10,136 added, 524 removed and 9,612
net added lines.

These measurements exclude generated transport types, tests/E2E, localization,
schemas/config and documentation. The original 3,500–6,500 estimate was low:
durable acceptance/recovery authority, Go-only reversible local authoring and
shared runtime admission account for the expansion. The handwritten TypeScript
client/Node helper/export surface is 339 lines. No daemon, second installer,
database, custom RPC framework, new frontend framework or unused language SDK
was added.

Hot mutable qualification state belongs outside synchronized working folders.
Unchanged BBC7 runs in synced scratch encountered externally reappearing files;
filesystem tracing preserved that failure evidence. The same SDK and Python
scenarios passed with isolated temporary state, without changing native ownership,
publication or recovery assertions. Follow the desktop procedure for isolated
HOME/profile/state paths and retain completed receipts separately.

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

SkillsMutationService routes local edit, import-overwrite and delete requests
through authoritative backend ownership checks and retained Go mutations.
Hiding UI controls alone is not protection.

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

The UAP v6 master owns the complete S01–S30 acceptance and evidence matrix.
This app plan records host implementation and checkpoint evidence for that matrix;
it does not redefine scope or mark every scenario complete. Before completion,
record each as implemented/verified/dependency-blocked with concrete evidence.

## Original implementation sequence (historical)

This sequence records the order agreed at v1. The foundation implementation steps
have been completed through the checkpoints below. Step 6 remains dependency-blocked
for S25/S26. Current-artifact desktop verification, applicable current-head
qualification and final review remain delivery gates; do not restart the historical
v1/v2 publication steps.

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

The desktop sidecar additionally requires its own ephemeral bearer capability.
It is issued through owned-window IPC and the existing Copy URL action, never an
HTTP endpoint or public status response. The browser consumes and removes the
grant fragment, retains it per tab and exact origin, and sends it only to managed
routes. Restart revokes earlier grants. A bare browser URL remains a viewer with
an explicit management-access explanation. Forged local headers alone grant no
authority. This does not isolate a compromised owned renderer or stolen bearer;
remote/multiuser deployment still requires its own authenticated deployment model.
The Go child's separate private credential stays in trusted main composition and
is never returned to the renderer or browser.

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

Local evidence recorded at the historical v4 checkpoint was limited to the focused app contracts/application/
IPC/HTTP/preload typecheck, 20 focused behavioral tests and the source-size guard.
The complete repository TypeScript check exceeded the workspace's memory limit;
it is not recorded as passed. Renderer/integration typechecks, full lint/build,
actual Electron clicking, native discovery, signed packaging, full CI and final
independent review remain open. The managed/local Skill adapter is still being
integrated. Project/worktree S25/S26 remain blocked on the separately qualified
engine workstream; a disabled control is only fallback evidence.

### v5 host scope and recovery review

- The standalone HTTP process is an existing read-only session viewer without a
  team runtime owner. It will advertise that managed mutations are unavailable
  and direct the user to the desktop app. Building a second runtime ownership
  subsystem solely for this integration would exceed this feature's scope. HTTP
  parity is required and tested on the desktop sidecar, which owns the same
  admission gate as Electron IPC. Standalone refusal is a separate acceptance
  test; it is not reported as successful standalone mutation support.
- A staged, pinned UAP executable is a required desktop dependency in development
  and packaged builds. Missing or corrupt engine resources produce an actionable
  error. An empty, valid environment must preserve existing team launch behavior;
  engine failure cannot be treated as proof that no pending mutation exists.
- Admission lives once per stable environment, across immutable captures. An
  observed pending operation can widen the held resource set atomically, and a
  new capture of the same environment can review recovery without conflicting
  with its own earlier fence. Tests cover both transitions.
- Every unresolved partial result, and failed or cancelled work with recorded
  mutations, has a visible recovery action even when the engine's next-action
  list is empty. Local work selects the exact local restoration request; native
  plugin recovery is never substituted for it.
- Target availability and action support are separate checks. Source and catalog
  install controls require both, with the native target's reason shown nearby.
  Transitive dependencies remain visible but cannot be updated or removed as
  independently declared roots. No dependency graph editor is introduced.
- Local restore points survive restart in the engine ledger. The UI explains
  retention of at least 30 days and shows up to the latest 100 restore points.
  Restoration always revalidates ownership and current files in a fresh plan.

The v5 working-tree admission/application suite reported 22 passing tests, after
the 20-test v4 checkpoint above. This is historical local evidence, not a result
for the current head; later checkpoints supersede these counts. Full CI,
actual Electron UX, local authoring integration, and signed package qualification
remain required; this revision does not change the project/worktree dependency.

### v6 independent code review and desktop qualification

The implementation review requires these corrections in the existing feature:

- Prevent stale empty environment responses from releasing a newer mutation
  admission fence. Carry one shared admission generation across captured contexts,
  including recovery admission. Deferred-response regressions passed 23/23 in the
  focused application suite; final current-commit qualification remains required.
- Carry `skills.discard` through the SDK adapter, shared facade, IPC and HTTP.
  Release catalogs on replacement and dialog close/unmount. A reviewed prepared
  plan owns its snapshot independently; no additional cache service is needed.
- Release cached local deletion reviews after definitive pre-effect refusal or a
  conclusively settled no-effect terminal result. Preserve exact request identity
  for uncertain acceptance, running work and unresolved effects. A later explicit
  Delete must be able to obtain a fresh plan without restarting the application.
- Present the Go review's `EXTERNAL_UNINSTALL_REQUIRED` conflicts with their exact
  bindings. Offer explicit confirmation only after the user has completed the
  native uninstall, or confirms the plugin was never activated, then request a new
  review with `externalUninstalled: true`. Never infer confirmation from a client
  name or save it as a preference. Applicability follows actual prepared removals,
  including transitive removals during update/sync and full native convergence.
  Receipt-only recovery and unrelated graphs refuse this flag. Review warnings
  identify the exact attested bindings. No pending-operation gate is bypassed.

Desktop inspection also identified practical UX corrections:

- Loading an unavailable remote catalog must not keep installed-state actions
  globally busy. Inspect the environment independently and report catalog freshness
  separately; real Electron already verified the source flow remains usable.
- Escape/close from a Skill preview must return to the source selection without
  also dismissing that selection. Render one active dialog surface and wait for
  its actual focus transition in the keyboard/click harness.
- Reuse existing frontmatter-aware Skill presentation so YAML metadata does not
  appear as a large Markdown heading. Keep optional update-policy detail close to
  its applicable action/review; an empty list should not show several paragraphs
  of update instructions. Keep the visible scope and capability reason.

Packaging uses the exact vendored SDK/native pin. Preserve the existing afterPack
hook by delegation. On macOS use the existing osx-sign traversal and options:
refresh runtime.json after nested binary signing and before the outer app seal.
Reuse the builder's bounded retry helper. afterSign only verifies. On Windows,
refresh after the existing signed extra-resource copy, before installer sealing.
The independent transport reviewer found no production lifecycle issue in this
wiring. Focused tests cover changed bytes, path confinement, partial-sign retry
and post-seal tampering. A macOS CI test performs real ad-hoc signing of an unsigned
native fixture, verifies the sealed bundle and executes the helper; release
certificate/notarization qualification is a separate existing release concern.

Evidence at this checkpoint:

- a213b80e8a4a97b613ffbe35df9f42f4ed7b090e passed remote Fast feedback, including
  the full pinned TypeScript check. This supersedes the earlier local memory-limit
  observation; it does not substitute for Full qualification on the final commit.
- The earlier integration slice passed 148 focused tests in 27 files, feature
  typechecks and unchanged source-size guards before publication.
- Actual matching 08a SDK/native local authoring tests verified create, binary/text
  editing, stale-byte rejection, delete, process restart, visible undo and restore.
- Real dev:mcp Electron reached Extensions, selected OpenCode, acquired the HTTPS
  Skill and displayed its content. The complete install/remove/reopen and final UX
  flow is still in progress; screenshots of early steps are not a completed E2E.
- Add the reproducible focused desktop CI lane using existing CDP, Xvfb and pinned
  runtime provisioning. Final evidence must name app SHA, UAP source/digest, SDK
  identity and exact verified scenarios.
- #472/#475/#480 and Host migration #982 remain open drafts at their previously
  recorded heads. Native project/worktree S25/S26 remain dependency-blocked.

Resolve and independently rereview the corrections, publish the refreshed matched
SDK/native pin, complete Electron clicking and native artifact checks, then run
current-commit Full qualification and applicable package checks before merge.

### v7 candidate artifact and additional review dispositions (historical)

This is the recorded v7 checkpoint, including its then-current artifact and failed
qualification attempts. The v8 checkpoint above supersedes those pins and current
status; historical evidence is not silently relabeled as a later pass.

The independently reviewed Go follow-up is published at
`aff370c0de25598ad8a1eee9436419cb7e35c348`. It applies each already supported
adapter's own removal predicate with the actual command runner. Grok, Qoder,
Copilot, Cline, Kiro and Windsurf now participate in the same review policy as
Codex. This does not expand the management capability set. Shared Copilot runtime
behavior and the frozen VS Code implementation remain unchanged.

Actual macOS/Windows CI exposed a raw-versus-physical state-root comparison. The
engine now normalizes both sides with the same helper; a different physical root
is still refused. All management integration cases and saved Git/portable restore
passed locally with TMPDIR deliberately reached through a symlink (37.648s).
Adapter predicate equivalence and Codex profile tests also passed. Corrected
macOS/Windows CI remains a separate gate.

Signed registry inspection found that an embedded `0.1.0-development` version
made all 30 entries in verified snapshot 42 ineligible. The native build now uses
`0.1.91+agentteams.aff370c0de25`, based on the independently verified immutable
`agentplugins-v0.1.91` tag at
`4555aa53844ee0078e9036cd82638afd67f77c16`. Build metadata identifies the exact
source while compatibility uses the verified release baseline. The stager,
runtime cache, packaged checks and startup all compare this version. No latest
release lookup or compatibility-policy bypass is introduced.

The current candidate Linux x64 stage uses the published source above and has SHA-256
`3e65916af4955f3061489a236a3907e178a658e6d5881ce1ab46b7526adef803`.
The SDK archive has SHA-256
`31eb798b31be66d1c4d80d1cfa094934fa786cf2b46313360b4c6a8f6bfdd96c`;
its bytes are unchanged from the preceding SDK because the follow-up changed Go
behavior only. Provenance still names the common exact source commit. Actual
SDK/native, second-language and Electron qualification must all use these matched
inputs; a successful stage alone is not a completed lifecycle test. A subsequent
behavioral correction must refresh the source pin before final qualification.

Additional GitHub review findings are resolved in the existing implementation:

- Extend an existing mutation lease to all resources of the newly reviewed
  recovery plan before awaiting the activity check. A launch already preparing on
  any of those resources rejects the extension atomically; no partial fence is
  added on refusal.
- Admission uses the effective launch request's provider and working directory,
  with per-field fallback to saved metadata. Explicit member providers and project
  directories remain included. Unknown rosters retain conservative admission.
- A transient operation-observation failure schedules another observation of the
  same operation. It never repeats Apply. Successful observation clears only the
  still-displayed error from that polling failure.
- Canonicalize the temporary copy-source test root for macOS path aliases without
  weakening production confinement.
- Preserve definitive-refusal deletion cleanup. Do not adopt blanket expiry or
  terminal-error eviction that would discard uncertain accepted request identity.
- Keep the required staged-engine contract. Engine absence cannot prove that the
  durable environment has no pending mutation, so it cannot authorize launch.

The independent follow-up reviewer found no P0/P1/P2 in these source changes and
agreed with the explicit trusted-local HTTP boundary above. The five focused
regression files passed 31 tests; focused core and harness TypeScript, narrow lint,
diff validation and the unchanged source-size guard passed before publication.
Final current-commit CI remains distinct from these local checks and static review.

Actual macOS ad-hoc signing passed on app checkpoint
`d7ebfb0ebe026d7bf115bdda8323b5b28b7eb629`, in
[job 121009065668](https://github.com/777genius/agent-teams-ai/actions/runs/40139661115/job/121009065668).
That checkpoint also passed packaged macOS ARM64, Linux x64 and Windows x64 smoke.
These are historical package results; the final app head must qualify again.
No release certificate, notarization or public release is claimed from this test.

The first focused Electron CI run on `1c0857f` built the matched native runtime and
provisioned real OpenCode and orchestration runtimes, but exited before opening
Electron: pnpm attempted a second install after the harness changed HOME. The
harness now uses dependencies already verified by the frozen installation step,
preserves that setting for child commands and includes a bounded startup-log tail
on failure. An actual nested pnpm command under a fresh isolated HOME verified
that no implicit install occurs. Dependency integrity is unchanged. The complete
actual UI receipt remains required.

Main was merged through a normal three-way merge at
`b0a700e927a4b85540c7aa4f3e8c8f85ef141326`, incorporating upstream
`bb6430b78df3698a53f6c97a33dce0e203fc674d`. The final app run must therefore use the
reviewed runtime 0.0.137 and current OpenCode override/provider-status behavior.
The two overlapping files merged without conflict; feature edits and upstream
changes are both retained.

Actual candidate testing has already identified two further qualification issues:

- Real OpenCode discovery, exact Skill/portable-command bytes, pinned update and
  ordinary repair passed. Repair of an edited owned Skill preserved those bytes
  and reported partial, but omitted the required typed changed-content diagnostic.
  The full recovery smoke stopped at that assertion; it is not a passing receipt.
- The signed official registry now reports 30 entries, 28 eligible, and the reviewed
  cloudflare-docs version is available for OpenCode. Management preparation still
  returned a refusal while an actual CLI dry-run on the same candidate succeeded.
  Catalog compatibility is verified, but registry installation S02 is not yet
  qualified.

Resolve both concrete findings in Go, independently review the corrections, then
refresh the matched source pin and repeat the affected actual-artifact scenarios.
Do not weaken assertions or count successful discovery as successful installation.

Published checkpoint measurements before the final small app follow-up are 5,932
added handwritten runtime/build-tool lines in UAP and 3,919 in Agent Teams, with
330 and 180 removed respectively. Generated transport types, tests, localization,
schemas and documentation are counted separately. The original 3,500–6,500-line
planning range was low: retained operation/recovery authority and the requirement
to route reversible local authoring through Go account for the expansion. The
handwritten TS SDK runtime remains 339 lines. Independent maintainability review
found no need for a daemon, second installer, framework or unused language SDKs;
the final evidence report will record final measured counts and scenario status.

