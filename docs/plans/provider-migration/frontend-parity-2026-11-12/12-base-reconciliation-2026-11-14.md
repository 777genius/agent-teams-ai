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
