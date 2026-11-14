# UI launch inputs and frozen-install recovery

Written before implementation on 2026-11-14. This is a bounded follow-up to
plan 12, not a passing E2E receipt. The completion branch remains Draft;
real Claude/Codex execution, release, Stage 2 and default activation remain
outside this change.

## Original evidence and limits

The original source is `d10409d1887d6a81955adcfad5c10d4a7596d0dc`.
Its seven-lane UI run is
[43527078399](https://github.com/777genius/agent-teams-ai/actions/runs/43527078399).

OpenCode job
[132236556805](https://github.com/777genius/agent-teams-ai/actions/runs/43527078399/job/132236556805)
failed the original singleton-CDP predicate before Launch and before a
runtime BOOT input. Main PID 4063 and its original child PID 5250 both held
fd 55 for socket inode 23054. The passive spawn observation correlates
5250 with the same birth ticks 30505 and parent 4063; its closed command
classification is `other`, and its original exit observation follows
54 ms later. This proves the observed extra holder, not the identity of
its requested program. Do not label it git, a shell, or a vendor.

The original artifact is 14088321399, ZIP SHA256
`51ae46a256e8d0d8977169d7cc7ac080c2d71aecf6deadc64dc2505cab360973`.
Its unchanged receipt SHA256 is
`14aece534b5ccbc5855e59debc2d183811900785a5a4c7e1cc4932e71daea87d`.
The receipt remains INCOMPLETE, including its original cleanup limits.

Management job
[132236556811](https://github.com/777genius/agent-teams-ai/actions/runs/43527078399/job/132236556811)
failed during the original frozen install, before any UI ran. Its original
log SHA256 is
`892702360466b8f503c6b5efd0762368aa892e1c3f5dcacacd526e187c0e977f`.
The log records node-pty and cpu-features downloading/extracting the same
Node 24.21.0 headers while their lifecycle builds overlap; node-pty then
fails first at `node-addon-api/napi.h` with `napi_env does not name a type`.
No header artifact proves corruption or incompatibility. Serializing those
lifecycle builds removes the observed overlap; it does not establish the
historical root cause.

## Stage 1: select the existing static helper for these seven TEST lanes

Change `.github/workflows/host-emulated-acceptance.yml` and the bounded
saved-readback handoff in `desktop-readback-fixture.ts` for this stage.
The merged builder, selector, initial fixture and evidence owners already
provide the initial input route and retain their existing behavior.

1. In the existing private TEST input-capture step, invoke the original
   `buildLinuxProcessNativeArtifact.ts --linux-child-exec` CLI under its
   existing `LEGACY_LINUX_CHILD_EXEC_GO=1` guard. Build once per original
   lane, into a new private `TEST-emulated-ui-inputs-*/linux-child-exec`
   directory, using the captured compiler/readelf selected by the existing
   CLI. Retain its original 60-second build budget, static ELF checks,
   source/toolchain/link-input hashes, modes and no-replacement checks.
   Keep the separate packaged Node-stage build and its original checks.

2. Read the builder's exact three-field selection and require its manifest
   path to equal that lane's private output. Reuse
   `verifyLinuxChildExecInput` for canonical file identity, permissions,
   bounded manifest/schema/hash and static-binary validation. Compare the
   manifest source digest with this exact checkout's
   `packages/legacy-agent-host/native/linux-child-exec.c`. Save the
   checked selection in `host-emulated-inputs.json`, then export only
   the existing `LEGACY_LINUX_CHILD_EXEC_MANIFEST` and
   `LEGACY_LINUX_CHILD_EXEC_SHA256` references for subsequent TEST steps.

3. Reuse the unchanged `readDesktopLinuxChildExecInput` and
   `desktopBackendEnvironment` route. Each original fixture validates
   the input before allocation and gives Main the same immutable
   `AGENT_TEAMS_LINUX_CHILD_EXEC_*` selection with its original descriptor.
   The plan-12 three-site routing selects exactly one stage. Generic
   allocation still validates the originally selected files on each
   allocation. Nothing enables a production default or a vendor runtime.

   Independent review found a missing saved-readback handoff: the existing
   `readSavedDesktopFixture` calls the environment helper's default lookup
   but omits `linuxChildExec` from its returned fixture. Capture the existing
   TEST selection once at that saved-read entry, require exact equality
   with the original SHA-pinned receipt's `linuxChildExecInput`, and require
   its successful `linuxChildExecInputVerifiedAfterCleanup` when selected.
   Pass that same captured value explicitly to `desktopBackendEnvironment`
   and return it for the existing smoke/evidence checks. Selected versus
   absent, different pins, or failed prior verification refuse; there is no
   fallback or new selection. Absent on both sides preserves old unselected
   receipts. Extend the existing Review fixture test with a clearly marked
   synthetic saved receipt, exact reopen/no-write assertions, and mismatched
   input refusal; the real selected-input path runs in its existing CI step.

4. Keep each original Xvfb command and every business, CDP, deadline,
   source-freeze, sentinel, owner and cleanup assertion unchanged. Extend
   the existing final verifier to require every selected-mode receipt's
   `linuxChildExecInput` to equal the captured selection and its existing
   `linuxChildExecInputVerifiedAfterCleanup` field to be true. Revalidate
   the same selection after the flow. Missing fields, input drift, skipped
   scenarios and INCOMPLETE cleanup continue to fail.

5. Retain the original helper selection JSON, manifest and built binary as
   original evidence alongside all existing logs and receipts. The source
   inventory already includes the C source, builder, selector and wrapper;
   no new fixture API or extra launch observer is needed.

The explicit scope remains the same seven Linux emulated lanes, including
both Review modes in their original paired lane. All job admission, matrix
members, aggregate success rule, time budgets and vendor prohibitions stay
unchanged. The next exact-head UI run must establish the result; the
historical unknown command and failed receipt are not reclassified.

## Stage 2: serialize only the selected frozen-install lifecycle builds

The existing `scripts/ci/install-dependencies-with-retry.mjs` deliberately
constructs `pnpm install --frozen-lockfile` and does not forward CLI options.
Replacing it in this workflow would discard its original bounded
network-error retry policy. Instead, add one closed optional argument,
`--child-concurrency=1`, and select it only in this UI workflow.

The no-argument invocation remains byte-for-byte the same pnpm argument
list. The selected invocation adds exactly that one finite option; all
other arguments are rejected before a child is allocated. Do not forward
arbitrary arguments or change lockfile, lifecycle-script, network retry,
terminal-failure, output-stream, environment or exit-code behavior.
Extend the existing `test/scripts/installDependenciesWithRetry.test.mjs`
with a finite TEST pnpm child that observes the original wrapper's argv:
default and selected invocations retain frozen install, while an unknown
or duplicate option produces no child. This invokes no real installer,
network package resolution or vendor.

## Exact intended paths and review

- `.github/workflows/host-emulated-acceptance.yml`
- `scripts/legacy-agent-host/desktop-readback-fixture.ts`
- `scripts/legacy-agent-host/desktop-review-fixture.test.ts`
- `scripts/ci/install-dependencies-with-retry.mjs`
- `test/scripts/installDependenciesWithRetry.test.mjs`
- this plan

No production launch, Host, provider or renderer source is changed by this
cut. The saved-readback fixture only preserves the already selected input;
its business readback rules remain unchanged. The eight frozen Desktop
merge files from plan 12 remain unchanged. Root reviews this plan before implementation and owns
all publication.

After implementation, an independent reviewer compares the complete
workflow against its preimage: existing scenario commands, acceptance
predicates, job admission and timer fields must be identical except the
additive input checks and the one install argument. Parse YAML, each
changed Bash block and embedded JavaScript; run the finite existing
installer test with the pinned Node after the scheduled process slot is
available. Diff/source checks do not qualify native or UI behavior.
Actual next-head original CI and retained artifacts remain the E2E gate.

## Implementation review and bounded local verification

The root approved both stages and the independently identified saved-read
handoff before source edits. A different agent reviewed the final five
code/test files and approved their exact source. The original eight-file
Desktop merge was not changed by this cut.

On the merged local checkout at `2335b403b7d015ef871e9dd8609803fb4630a6cb`
plus this reviewed cut, YAML parsing, eleven Bash blocks, three embedded
JavaScript blocks and four Node source parses passed. A structural
comparison found every non-step workflow field, ten untouched steps and
all changed-step metadata identical to the preimage. The original UI
commands, matrix, aggregate rule and timeout fields therefore remain.

Pinned Node 24.21.0 on Linux ran the existing installer suite: seven passed,
zero failed/skipped, in 0.696 seconds. Only the finite TEST pnpm child ran;
the original default and serial argv and the no-child refusals were
observed. Its log SHA256 is
`176a6b11974cc629a3823b37c2295e9a1c9c9ee44c97c9ad6e0b1ab5cb29c48b`.

The unchanged static builder ran once under its original explicit GO and
60-second budget in a fresh private TEST directory and passed in 0.969
seconds. Its C source SHA256 is
`29f122efc95f3b8f4946e624d6d0afd70959f3759499cee4d23bae269c805337`,
binary SHA256
`4e823c9e62038d770804475badca3982ecd630d95d9dd39e6f655f05cffda5e0`,
and manifest SHA256
`505872c5c4aab8179b4bbdeada091dce5d55a8a86e5cc0b689e35ffdb9e73187`.
The existing Review fixture suite then used this exact selected input:
two passed, zero failed/skipped, in 1.741 seconds. It observed the exact
pin roundtrip and no-write checks, and refused a foreign/absent saved pin
and failed prior post-cleanup verification. Its log SHA256 is
`2e1ced9bc9029f6daf154376534464ece0c3830ec525ec81b09f57089e329b88`.

These checks qualify only the finite installer and private selected
fixture/readback contracts. They did not execute Main, Electron, a real
installer or any provider. They do not replace the original seven UI
lanes or resolve the historical cleanup and conversation failures.

