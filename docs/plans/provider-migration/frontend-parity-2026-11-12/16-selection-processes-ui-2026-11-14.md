# Remaining model selection and controlled Processes UI journeys

## Scope and status before implementation

This plan was written before source changes in the isolated `e2e-next-coverage`
checkout at `007d167c`. The parent approved two bounded stages. Source review,
finite protocol tests, and actual Electron acceptance remain separate results.
The seven existing emulated UI lanes have not all passed. Their original
commands, assertions, deadlines, source binding, screenshots, and cleanup
requirements remain unchanged.

The two additions cover concrete composition gaps:

1. The existing management UI saves model/effort and reloads it, while the
   runtime journeys launch a preselected model. They do not yet prove a newly
   saved selection controls the next original launch while another captured
   runtime continues with its original selection.
2. The existing controlled cold Processes fixture already exercises actual
   kernel custody, Host restart and the original UI Stop. Its input capture
   nevertheless requires a prior native Claude SDK receipt and a Claude binary
   pin. A separate finite no-provider capture is needed for the authorized
   emulated lane. No SDK receipt may be invented or relabeled.

No production authority, provider contract, scheduler, process owner, runtime
timeout, CDP ownership rule, or cleanup rule changes are authorized by this plan.
Real Claude/Codex executables are forbidden, including version probes. Tests use
the existing pinned Node peer or original finite controlled services only.

## Stage A: saved selection controls the next launch

Use a separate `selection` matrix lane and an explicit emulated selection mode.
Reuse `prepareDesktopEmulatedRuntimeFixture(..., 'codex')`, the checked provider
package, real Host, and original renderer controls. The optional fixture variant
has one closed value and is accepted only for Codex. Default fixtures retain
their existing single-model catalog and journey.

The finite peer variant adds exactly one second TEST model to its existing
`model/list` response, validates one of those two exact IDs in `thread/start`,
and records the selected model and reasoning effort with its original PID and
thread ID. The normal peer keeps its existing model. No native methods, user
markers, arbitrary prompts, authority fields, shell commands, or remote model
endpoints are added. The optional selection is part of the immutable captured
environment and source closure, never inferred from user text.

The original UI sequence is:

1. Launch saved Team A with the original first TEST model and Low effort. Submit
   the existing BOOT prompt once. Require its original successful input and
   visible assistant reply; retain its launch capture, generation, native PID,
   thread ID, and selected model/effort from original records and the finite
   protocol journal.
2. While A's original runtime remains alive and ready, open the original Create
   page. Choose the second TEST model and High effort, disable immediate launch,
   and save Team B once. Require the canonical saved settings and published
   registry record, with no B runtime capture or input. A must retain its exact
   prior selection, generation, owned process, and prior input IDs.
3. Reload the renderer. Verify B's saved selection remains visible in its
   original Launch controls and unchanged in the owner record. Reload must not
   allocate B, replay A's prompt, or change A's original capture.
4. Launch B through the original dialog with BOOT. Require a new B runtime and
   original successful input, with the second model and High in both captured
   launch configuration and the finite native `thread/start` journal. A remains
   its exact original live runtime and selection.
5. Send the existing STREAM prompt to A through Composer. Once its partial is
   visible and attributed to A's original input, Stop B through the original
   Team control. B must close and release its original process. A must retain
   the same owned process and pending input, with no exit or replacement.
6. Release only the existing fixed TEST stream file, observe A's original
   completed reply, then Stop A through its original control. Require original
   process absence and all existing source/sentinel/Host cleanup predicates.

A is deliberately a live idle runtime during the longer Create/reload/Launch
sequence. Holding its existing 60-second stream gate over that sequence would
introduce an unrelated timing dependency. The short stream/Stop-B section keeps
that original gate and every original runtime deadline unchanged. A slow or
incomplete attempt fails; it is not repeated or granted a longer budget.

Use a focused UI helper of roughly 250–320 physical lines. All business writes
come from the existing renderer controls. File/API observations are read-only;
the existing TEST stream release is the sole peer control write. Fixed evidence
includes the two saved selections, both original runtime captures and native
thread selections, unchanged A observations across B's boundaries, one B Stop,
one A completion and Stop, and screenshots of the original visible states.
This lane qualifies the shared UI selection path with a Codex finite protocol
peer. It does not claim native vendor model compatibility or replace the three
existing provider conversation journeys.

## Stage B: original controlled cold Processes UI without a provider

Keep `process-cold-ui`, `prepareControlledProcessFixture`, and
`qualifyColdProcessUi` as the original flow. Add an explicit finite
`TEST-controlled-process-no-provider-v1` capture variant only for the Linux x64
source emulated lane. Its exact schema contains Node, Host entry/source/dist,
Corepack 0.36.0, and original Linux process artifact pins. It contains no Claude
pin, model, provider account, runtime profile, SDK proof, or packed candidate.
Reject unknown keys, mixed native selectors, changed pins, and unsupported
tuples before any process allocation. The legacy captured-SDK variant and
`qualify-linux-process-cold-ui.ts` remain unchanged.

Build the actual Linux NAPI artifact with the existing
`buildLinuxProcessNativeArtifact` function, using pinned selected compiler,
inspector, source and Node headers under a fresh private TEST directory. Verify
it through the existing `readPackagedLinuxProcessArtifact` reader. A small
workflow input step may produce this capture from those exact inputs; no new
product runner or fabricated manifest is introduced. The separate generic
Linux child-exec and Node exec inputs from Plan15 remain selected and verified.

The no-provider fixture calls the existing process fixture with an explicit
controlled-services variant and without `nativeClaude`. The fresh profile has
neither runtime nor management before its first owner seed or Host allocation.
The old path continues to validate its original SDK/Claude pins. Existing
vendor refusal sentinels remain in both source application environments.

Preserve the complete original controlled sequence and all its oracles:

- Capture the actual original Node root before the first yield, then its two
  finite services through the original native kernel owner.
- Register only the primary service through the original Team process command
  under its original writer lease. Keep the neighbor's original capture.
- Start Host A, read the original row, end its original stdin, and require
  exit 0 plus released writer. Then start the normal Electron application and
  original Host B; no provider session is allocated.
- Open the original Processes section, require the exact original row/ref and
  live service, and click its single Kill control once. Read the original Stop
  command until it records observed absence, not merely signal acceptance.
- Require original stopped history and visible no-Kill state, original target
  absence, unchanged neighbor signal count and healthy neighbor HTTP response.
- Close only the original root pipe during fixture cleanup. Require its exit,
  both original service observations absent, original root observation absent,
  source hashes unchanged, and the original before/after screenshots.

This is a real controlled native process and Electron UI proof. It makes no
claim of provider MCP registration, native SDK survival, whole-tree Stop,
packed application qualification, or fallback PID signaling.

## Closed files and integration shape

Stage A may change only the existing emulated runtime fixture and finite peer,
add `desktop-emulated-selection-ui.ts`, and add narrow dispatch at the existing
emulated runtime UI entry. The main harness needs only finite mode/fixture
selection wiring; its 800-line cap is retained. If wiring cannot fit naturally,
move one cohesive existing composition block to the existing fixture owner,
preserving call order and closed inputs. Do not strip blanks to evade the cap.

Stage B may change only the existing controlled/native process fixtures for the
explicit input union and the capture reader. Keep the existing process UI body
and all original registration, lifecycle, Stop and cleanup assertions intact.

Shared TEST changes are the original emulation admission function and its
existing tests, the original `host-emulated-acceptance.yml` workflow, and exact
source closure additions owned by the parent. Extend the fixed matrix and
fixed lane-to-receipt mapping to nine lanes. New helper files and peer bytes
must be included in source freezing before any new launch.

Each new lane has its own runner, display, original application group and
artifact name. `fail-fast:false`, the existing always-running aggregate, and
the failure-preserving final verifier remain. Every expected receipt,
screenshot, source pin, sentinel check and original cleanup observation is
mandatory. Missing, skipped, INCOMPLETE, unknown cleanup, or failed lanes
cannot qualify the aggregate. Never continue another journey in the same
runner after unconfirmed cleanup.

## Review and validation obligations

Before implementation: parent R1 approval is recorded; independent peers review
the finite selection and no-provider capture contracts. Exact source review
must then inspect the final dispatch, capture union, model/effort assertions,
fixed workflow verifier, and all unchanged original boundaries.

Use existing focused admission/fixture tests for rejected native/mixed inputs,
unchanged default modes, and strict capture pins. Use the pinned Node parser and
focused scripts types after the parent allocates a compiler slot. A finite
Host/D protocol check may establish the second model's wire path but is not
visual proof. Do not add a generic test framework or implementation-mirroring
unit suite.

Actual acceptance is the unchanged original Electron `pnpm dev:mcp` harness
under the two new exact modes in CI, with raw receipts and hash-bound PNGs
retained for independent visual inspection. The current local AF_UNIX
restriction is not permission to change sandboxing or launch controls. No
local Electron/vendor run, broad build, or dependency installation is planned
without the parent's process-slot coordination. Report every result at its
actual source head and scope; existing historical receipts do not qualify new
source bytes.
