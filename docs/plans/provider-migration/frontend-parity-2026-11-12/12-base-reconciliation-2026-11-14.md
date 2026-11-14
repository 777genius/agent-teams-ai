# Current-base reconciliation before the next E2E acceptance

Written before implementation on 2026-11-14. This is an integration plan,
not an acceptance receipt. #1192 stays Draft; it does not authorize a merge
to main, release, Stage 2, default enablement, or real Claude/Codex execution.

## Exact inputs and why a merge is necessary

- Published completion HEAD: `d10409d1887d6a81955adcfad5c10d4a7596d0dc`,
  tree `74e36657a318e9f4483860c0533334687307cb54`.
- Frozen, independently reviewed TEST follow-ups from plan 11: commit
  `7408ad770fb17279008cc8e2abf20158ead6ccf0`, tree
  `dc055c62dad87e0732adc0d9a4c55c5f3abbb8d5`. Its parent plan commit is
  `fb6d98db0386036dc4b4fc976afd0b9af115a4b7`.
- Previous base: `e29dbde300ea73ec4e46e5f57f9e007ca5473552`.
- Incoming #1186 base: `0543d437695318f0157e6d600d76abdce5c51e8e`,
  tree `d6fd8db73820ec74e375f5cf2b36e0b4fe1bafd0`.

The incoming base contains 17 commits and 74 changed paths, including real
Host, provider, Linux process and Desktop changes. The complete recursive
Git trees were checked with `truncated: false`. The published d104/base
comparison contains 32 paths changed differently on both sides; frozen
plan-11 CPU diagnostics add two further overlaps. The capped 300-file
comparison is not a complete source inventory. Every path in the full
tree delta must be accounted for, including text merges without conflicts.

Use a new detached worktree from the frozen commit, preserving all existing
worktrees and user changes. Commit this plan before starting the merge.
The final integration commit must retain both parents. Do not manufacture
a new one-parent tree that hides incoming ancestry. Root alone updates the
completion branch, with an expected-head lease and a fast-forward update.

## Host and extracted provider semantics

Consume the incoming reviewed provider implementation at exact source
`002db02a255c532adf43ee12cf5ed56a3e6d6f5b`. The implementation archive is
179177 bytes, SHA256
`ae1a7f4063d893e0d76f509971d3940ee0a37902fbdf752a737d9c88390d6d8d`.
The contracts archive remains 6220 bytes, SHA256
`aaf9506473f6a2868a375a6087e1b4edc561b38f34101ef7a8703a73bb2674db`.
Preserve the lockfile integrity and exact pin assertions in native tests
and workflow fixtures. Provider-only CI is not Host/Desktop qualification.

Merge the new OpenCode private readiness purposes and finite rejection
classification while preserving the existing operation-owned trusted
preparation callback. The intended sequence remains purpose admission,
owned preparation, then the original request under the captured context.
Do not substitute a new lookup or broaden public purpose selection. B2
allocation activation remains inactive. Preserve undefined-only same-ID
credential fallback: explicit null must not be silently treated as absent.

Union both independently useful passive CPU projections:
`namespaceFenceDetails` from the incoming base and `teamWriterCallers` from
plan 11. They partition their original sampled categories; neither creates
new samples, timers, invocation counts, native queries or qualification
claims. Keep the original category/family sums, raw-stack discard and
caps. Preserve and run both meaningful synthetic matrices and the original
finite child test.

## Linux launch composition: exactly one stage per allocation

Both reviewed launch implementations are required. The incoming static
generic helper preserves `execvp`/argv0/PATH/ENOEXEC behavior for existing
Main CLI, shell, ps and MCP launch sites. It owns a private fourth pipe
(fd3), a closed 12-byte failure frame, fresh allocation-time identity and
hash checks, and the original child/remaining timeout. EOF on its private
pipe is not proof of successful exec.

The completion branch also contains a resource-pinned Node-only stage for
Electron Main with the original three-pipe child contract. It closes
inherited descriptors at and above fd3 and uses an absolute selected Node.
Blindly nesting it under the generic helper would change which exec the
fourth-pipe failure frame describes, and is therefore forbidden.

Retain the Node resolver's default direct-spawn behavior. Add an explicit,
closed opt-in for launch sites already owned by the incoming generic
wrappers. The exact call inventory has three such sites after merging:

1. `selectedHostProfile` Node version validation;
2. `CapturedHostClient` original Host allocation;
3. `WorkspaceMcpBundle` Node build through `execCli`/`execFileAsync`.

At those sites, if the original immutable generic helper selection exists,
resolve to the original selected Node and argv, then let the existing
generic wrapper perform its fresh checks and allocate its one stage. If
that same immutable selection is absent, retain the existing pinned
Node-only stage; the generic wrapper then delegates without a stage. Any
selection or validation failure throws: no recapture, alternate helper,
retry, or error fallback. Non-Linux behavior remains unchanged. Keep the
same child process, stdin/HANDLE custody, captured profile digest, and the
post-await sealed/quiescing check. Preserve generic failure observation and
the original remaining startup budget.

Resolve the builder add/add conflict as already described in incoming
P09 section 66.12: retain the complete NAPI builder API and add the distinct
static generic-helper export/CLI in the same established builder module.
Union imports and only deduplicate identical utility implementations.
Do not replace either artifact, manifest, resource name or consumer.

Add focused routing regressions for selected/absent/invalid immutable
generic selection, the default resolver contract, all three call sites,
and original refusal/cleanup behavior. These checks must not start actual
Claude or Codex. Existing finite Node peers are sufficient.

## Desktop, source provenance and documentation

Reconcile incoming checkpoint/namespace reconstruction, closed selection
failure diagnostics, pinned Linux handoff inputs, and post-cleanup input
revalidation with the completion branch's exact source/profile grants,
DISPLAY/XAUTHORITY/Corepack propagation, passive child tracing,
undefined-only settings handling, and fixed pnpm fallback in stopped
import tests. Keep one precise null/object/array settings guard.

Source receipt arrays must contain the union of unique observed inputs;
deduplicate the repeated unixProcessTable path without dropping either
implementation. The existing smoke file would exceed 800 physical lines
after a naive union. Move one cohesive evidence capture/revalidation unit
to its existing `desktop-proof-evidence.ts` owner, preserving call order,
instead of deleting blank lines or raising the cap.

Keep both append-only plan histories. Do not discard older failed receipts
or renumber historical section references to make them appear current.
Where section numbers overlap, label their source histories explicitly.
Plan 11 remains the separate record for frozen follow-ups 77–80.

The incoming `ci.yml` does not change event/job admission. Retain its Linux
artifact build/pin/upload and provider pin while keeping the completion
branch's Draft-gated actual-vendor jobs and aggregate admission unchanged.
The full workspace typecheck still covers the original twelve projects.
Do not mark #1192 Ready to obtain more jobs. Do not loosen the singleton
CDP, original process, authority, deadline, source, or cleanup predicates.

Include the independently reviewed plan-11 section-80 diagnostic in
`desktopBackendFeature.test.ts`, exact blob
`9eafe678a4d219fdee78d6de5db94738a26206cd`. It observes the original startup
logger and promise; it does not extend the original one-second wait or
three-second startup budget. It has not yet been executed or typechecked.

## Independent review and verification sequence

Each merge owner must report its exact paths and semantic decisions. A
different agent reviews the final source, including automatically merged
critical paths. Root checks the full Git inventory, unresolved markers,
pins, workflow admission and file-size/provisioning guards.

Build an isolated dependency graph from the exact merged lockfile and
pinned Node 24.21.0/pnpm 11.22.0; do not mutate shared dependency backing
directories. Run compiler/build work sequentially to avoid the previously
observed resource kills. Preserve every failure and its scope. The earlier
exit-137/incomplete checks are not passes and must not be replaced in the
record. The restored executor now permits fresh execution, but does not
retroactively qualify any work performed while it was unavailable.

Run affected Host authority/model/credential/runtime and native-host-close
tests, Main child/profile/client/resolver tests, Desktop fixture/admission
tests, strict TS7 checks, targeted lint, package build and source guards.
Then run the original safe finite-peer process/Windows A-B, OpenCode V2
localhost and seven Electron `dev:mcp` UI lanes on the resulting exact
source. Keep live vendor authentication/release qualification false.
Report partial business success separately from job-level failure.

## Separate known E2E failures and next bounded repairs

The d104 Claude UI job reaches a succeeded BOOT input but its original
visible conversation oracle fails. Independent source review confirms a
missing Runtime-text to lead-conversation projection. Legacy short text
is supported by its live `lead_process` overlay; the legacy JSONL history
extractor has a different minimum length. A separate written repair plan
must preserve binding authority, stable identity/time, stream replacement,
pagination, reload and sufficient text retention. Do not fabricate an
inbox message or replace the original visible-text oracle.

The d104 Review UI job fails acquiring the second hunk's original Reject
control after Keep succeeded. Read the original receipt/screenshots before
choosing its repair. The prior execution outage prevented extracting
those artifacts; the newly restored environment permits that work now.

Neither this merge nor the TEST diagnostics establish E2E completion.
Current-base qualification requires the actual original scenarios to pass
after the corresponding production repairs.

## Host probe preparation extraction during reconciliation

Written before the extraction. Combining incoming readiness preparation
with the retained operation-owned process selection would exceed the
Coordinator's 800-line limit. Move only its OpenCode ordinary probe,
private local-readiness branch, and coordination preparation into
`composition/ProviderModelProbePreparation.ts`. The exported
`prepareOpenCodeModelProbe(profile, input, isCurrent, ports, purpose?,
observeProvider?)` returns the existing `NativeModelProbe` contract.
Its narrow typed ports capture the original target-current guard, endpoint
queue operation, derived-host construction, original host retirement,
replacement begin/publish/release, writer check and optional V2 custody.

`ProviderManagementCoordinator` retains profile admission, operation-owned
source/process selection, endpoint queues, resource fences, host caches,
origin WeakMap, and Claude/Codex dispatch. It captures one V1 process
selection before preparation and closes that selection into all ordinary,
limited, and coordination host callbacks. The extracted readiness
recursion reuses those same ports; it cannot resolve a newer source by
profile ID. Target guards are captured at the original preparation cuts,
not eagerly across branches. No whole-service host cast, additional
registry, public purpose selector, deadline change or native-namespace
permission is introduced. Preserve both parents' critical owner, queue,
credential, Skip and diagnostic cases, and review the exact extraction
independently before the merge is staged.

## Verification follow-up: inherited import ordering

The first canonical full `pnpm lint:fast` on the reconciled checkout
reported six errors, all `simple-import-sort/imports`, and 212 warnings.
Before the next check, sort only the existing import blocks in
`DesktopBackendFeature.ts`, `CapturedWindowsCustody.ts`,
`CapturedWindowsRuntimeSources.ts`, `registerCodexRuntimeInstallerIpc.ts`,
`createCodexRuntimeInstallerFeature.ts` and `src/main/ipc/codexRuntime.ts`.
Apply only that rule's fixes; do not reformat file bodies, change behavior,
raise size baselines or suppress existing diagnostics. Inspect the exact
diff and re-run the canonical fast lint against its existing cache. The
failed original log remains preserved as SHA256
`d1dd44b8867d42a19ab541064fbf44728dc2d438a05ded1c90d450bfcbba1a3e`.

The reviewed diff changes only those six import blocks. Canonical fast
lint then passed with zero errors and the same 212 warnings. Its log
SHA256 is
`622305785d18c473574ae6be489b4b8fe15a1e54490ad75a92849e81abe2c982`.

## Current-parent integration: 3a2882e and preserved conversation repairs

The continuation recovered the exact prepared local tree `a4726750` and
published its original source/evidence commits to the existing Draft #1192.
It then compiled the complete application TypeScript command successfully
at local `c1828376` / published `d9ea2a96`, after correcting the Codex installer
callback's absent-source value and two narrow test type annotations. That
compiler result precedes this merge and is not an acceptance result for it.

The parent advanced from `0543d437` to `3a2882e1e07cfc0c8f6f51be322b6244b7e6a179`:
95 commits, 193 changed files and 55 overlapping paths. This integration
preserves both sides of 22 actual conflicts. It retains the checked provider
archive from source `421fee918811b8a0b0c73d0ff3e761b9a1c5ecb0`, original runtime
source authority, local/file-key readiness, retained Windows custody and
live membership together with the conversation, Review and Plan16 repairs.

### Resolution and review boundaries

- The probe/launch group combines `startPrepared` readiness scope and origin
  with the per-operation captured process preparation. Preparation remains
  after original durable admission and replay checks. Model readiness for
  restart/resume must also carry the original selected process authority;
  a derived `team-probe-*` identifier cannot borrow a runtime-source grant.
- The Runtime group combines live selected member histories with required
  original conversation records and Resume lineage. Source readiness witnesses
  remain attached to their actual predecessor attempt, never copied from the
  current target. The original Team fence rechecks remain intact.
- The three existing read views move together into a stateless composition
  helper with explicit dependencies to keep the coordinator within its original
  800-line cap. Its availability, writer and sealed checks retain their order;
  all Desktop source inventories include the exact new helper.
- The UI/process group preserves the union of original source rosters, Linux
  launch helper pins, the no-provider cold Processes scenario and new public
  process-read validation. Original startup barriers, deadlines, cleanup and
  failure receipts remain unchanged.
- The shared process-stop type is exported through the existing public feature
  contract, eliminating the parent's forbidden deep import without a rule
  exception or a second schema.

R1 compared the original parent trees and identified coupled readiness and
Windows preparation contracts. R2 assigned independent reviews to the Runtime,
probe/launch and UI groups; the cross-group review found the Windows action
readiness gap and the lost `desktop-readback-fixture.ts` source inventory entry.
Both are repaired in the merged composition. R3 checks the compiled contracts,
original behavior suites and immutable CI source before accepting the result.

Incremental merge glue estimate: 150–320 production lines and 0–50 test lines,
excluding changes already authored in either parent and preserved evidence.
Complexity 6/10; expected reliability 8/10; confidence before executed merged
acceptance 7/10. These estimates are planning judgments, not test outcomes.

### Required executed acceptance

Run the canonical workspace compiler, the original typed-lint scopes and
architecture/source-size guards, followed by the original affected Host/Main
suites. Then publish the reviewed merge with an expected-head lease and retain
Draft status. The nine fixed offline Electron lanes, Windows finite source
fixtures and permitted OpenCode native/platform lanes must report their own
current-source results. Review original screenshots and physical cleanup.
Queued, cancelled, skipped, diagnostic-only and historical results remain
separate from PASS. No real Codex or Claude executable, main merge, release,
default activation or Stage2 change is authorized by this integration.

### Executed local integration gates

The pinned Host build passed. The first twelve affected Host suites reported
157 passed cases plus two module-load failures; an ESM import cycle was then
removed by extracting the original MCP-reference and live-capture schemas
into data-only modules. Old exports and full validation remain intact. The
two affected original suites passed 20/20 with zero skips after the correction.
Independent review confirmed the new dependency direction and source inventory.

The source-size and provisioning guards pass without higher limits or new
exceptions. Fast lint passes with zero errors and 213 warnings. Full pinned
workspace typing exited 137 in the application compiler and is still required
in CI. The original logs, including failures, are retained in
`../evidence/e2e-integration-3a-2026-11-14/` and cannot be promoted to GUI proof.

Source/functional audit also found remaining in-scope work: visible emulated
Codex login, observational captured installer status/invalidation and actual
finite Update A-to-B UI, automatic cron occurrence, and cold lifecycle proof.
These remain separate unfinished slices; the nine lanes do not silently stand
in for them. The previously open Darwin same-inode qualification retains its
independent original scope described by P09 sections 47/75.


## 2026-11-14 login and lifecycle integration

- Import the independently reviewed finite Codex browser/device login proof and the
  Claude same-profile cold Resume/active-Quit proof onto the reconciled parent3a.
  The three existing runtime lanes retain Run now and additionally require one
  real six-field wall-clock cron occurrence, an exact linked task/effect, and Pause.
- The original app epoch spawn callback is shared without changing its invocation,
  identity, captured group, original checkpoint-upgrade guard or cleanup authority.
  The original bounded failure snapshot/screenshot block moves unchanged in
  behavior to `desktop-captured-app.ts`; this gives the composition file room
  without changing the800-line cap or adding a legacy exception.
- The lifecycle lane calls its final active/queued verifier after ordinary app Quit
  and before fallback cleanup. Receipts require original unknown/cancelled input
  outcomes, no queued delivery, two app/Host epochs absent, writer-lock release,
  exact peer-written history, identical compiled bundles and no cold prompt replay.
- Existing native restart and genuine vendor qualification scopes remain separate.
  New workflow receipts and screenshot hashes are mandatory. These integrations
  are implementation candidates until their actual Electron jobs finish; no
  static/source review is recorded as an executed GUI PASS.

## 2026-11-14 handoff reconciliation with parent def734

The published completion branch remained at
`d0710ecb6cc12499433bce985a29f723119fc85c`, while #1186 advanced to
`def734338f13bcc3209e78079a0cedbc48f05a5b`. The preserved local login
(`a7270d7cd3bc16519c2b6b8340d52f92fec375ef`) and lifecycle
(`ee01531f23f7d205663b86c0d8fd19bacca122fe`) changes and the eight staged
integration files were carried into a separate worktree. They were not lost,
replaced with an older worktree, or treated as already published evidence.
The next published integration retains d071 and def734 as its two parents.

Six installer conflicts use the parent's newer captured acquisition API.
The incremental production correction rechecks the original captured source
inside the atomic manifest writer's `beforeCommit`, after temporary-file sync
and immediately before rename. Its regression failed before the correction
and passed after it. Unknown Host publication cannot produce a Ready result
or discard the previously retained A/B packages.

The Host MCP catalog retains the parent's process-factory interface. Member,
scheduled and captured-management composition all pass the original Windows
launch and source origin through that factory. Team model probes retain both
the process origin and product-roster revision. Codex 0.169 eligibility remains
Darwin ARM64 only; Linux finite peers use qualified 0.162. The negative tests
assert refusal before allocation on other tuples. No native eligibility guard
is removed to make a protocol test pass.

The original selection journey now has a separate Darwin ARM64 installer
variant. A finite, checksum-pinned registry supplies one package containing
TEST executables. The existing model-picker Update dialog drives the stock
metadata, download, integrity, extraction, staged version validation,
immutable package, atomic manifest and Host source publication. A stays live
on 0.162 while B is published and subsequently launched on 0.169. Original
Settings Providers and Codex Manage then read the healthy B source without
another acquisition or source write. This is renderer reload and live source
selection evidence; it does not claim a separate cold installer restart or
an actual vendor binary.

OpenCode V2 Settings has its own Linux lane and its own strict receipt verifier.
It stages the checked Bun/engine graph without running the bundled legacy CLI.
Original controls exercise rejected API key, explicit replacement, model test,
global default, project override, independent-project inheritance, clearing the
override and renderer reload. Five finite localhost requests and their original
native probe identities are required. Stock Quit must precede harness cleanup;
model shutdown and original-process absence must be recorded before a PASS
receipt is persisted. This lane does not inherit the finite-peer-only flag or
qualify unsupported native OAuth/forget, vendor inference, or another platform.

Windows recovery reuses the applicable f544 fixes for definitive no-dispatch
and missing-capture settlement. Further corrections retain output hints during
pending calls, make incomplete retained shutdown retryable with a fresh attempt,
avoid retaining rejected Stop replies, and complete persisted lifecycle
settlement after original metadata has been unregistered. Genuine original
Stop receipts remain mandatory; unknown lookup-only cases never issue a new
native Stop. Native drain work leaves a bounded reply reserve inside the
original admitted deadline rather than extending it.

The expanded workflow declares eleven existing Linux lanes, the finite Darwin
installer lane and the OpenCode-only V2 lane. It checks the actual runner tuple,
keeps Linux process inputs conditional on Linux, and preserves exact source,
receipt, screenshot and physical cleanup checks. #1192 remains Draft. No real
Claude/Codex executable, main merge, release, default switch or Stage2 is allowed.

Local constituent build, contract, installer, process and input-admission checks
are recorded separately from Electron acceptance. Full local application typing
and typed lint again ended with exit137; they remain required CI gates, not
successes. New UI assertions are implementation candidates until the original
Electron jobs finish on the published integration commit and their screenshots
and cleanup evidence are reviewed.
