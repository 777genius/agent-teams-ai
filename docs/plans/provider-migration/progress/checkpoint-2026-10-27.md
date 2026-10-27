# Stage 1 continuation: 27 October 2026

## Main integration checkpoint

PR #982 remains Draft. Stage 2, OpenCode V2 integration, merge, publication and
activation remain outside this work. The existing P0–P8 / M01–M19 denominator
and the original native evidence limits are unchanged.

The isolated continuation started at `feadd83eccc487658d9fc06eb9f5f01d490938c2`.
Current main `d23f45ece051bda6b2343692b6c064ebf5b308b7` was incorporated by
`8ee6003698df2ae1136ebdf9310e1003ba1a4e4e`, preserving both histories.
All eight conflicts received an independent semantic review. A separate review
checked shutdown admission, renderer reload/loss, cancellation and late startup.

Close coordination preserves the Host branch's monotonic mount admission and
`uiHandlerObserved` proof together with main's acknowledged-save timeout and
late-result warning handling. Renderer load state does not bypass the mount gate.
Provider setup diagnostics retain the captured request scope and the existing
Host management port. Legacy OpenCode readiness/delivery fixes from main are
retained without adding a V2 Host driver or fallback.

Verification for this exact merge checkpoint:

- Local Host and task-change-ledger builds passed.
- The focused Vitest run passed **91 tests in 12 files**, with no skips: existing
  close coordinator/preload/mount/registry, shutdown order/MCP, provider setup
  diagnostics, OpenCode handshake/message delivery and installer controls.
- Fast lint of the eleven resolution/adaptation files, `git diff --check`, source
  size guard (4,614 production files) and Team Provisioning architecture guard passed.
- Canonical `pnpm typecheck` was killed with exit 137 during the first compiler
  invocation under local resource pressure. No typecheck PASS is claimed.
- Exact-head full CI was dispatched as
  [run 40539001594](https://github.com/777genius/agent-teams-ai/actions/runs/40539001594).
  All eleven required jobs subsequently passed, including `Full qualification`.

The local test command used `pnpm exec vitest run --maxWorkers=1` with:

```text
test/features/app-close-coordination
test/main/index.shutdown-order.test.ts
test/main/services/team/ShutdownMcpTransport.test.ts
test/main/features/runtime-provider-management/providerSetupDiagnostics.test.ts
test/main/services/team/OpenCodeReadinessHandshake.test.ts
test/main/services/team/OpenCodeMemberMessageDeliveryService.test.ts
test/renderer/components/cli/OpenCodeV2InstallAction.test.ts
test/features/opencode-runtime-installer/installAction.test.tsx
```

## Source Desktop qualification route

The existing CI workflow now has an optional `stage1_desktop` dispatch input.
It runs the existing mixed Create/Launch, native Create and stopped import-only
modes on an actual recorded macOS arm64 runner, using pinned provider executables,
the captured Host Node 24.21.0, disposable TEST state and localhost inference.
The original retained receipt must report `PASS`; an `INCOMPLETE` receipt fails
the job. The shell-environment TEST sentinel accepts the exact nonce-framed
probe introduced on main without evaluating shell input.

The normal workspace-test shard also runs the existing Host package test command
once with the captured Node 24.21.0. Ordinary frontend checks alone do not qualify
the Host package.

This workflow change is a route to new evidence, not a native/UI PASS. Packed or
installed qualification, vendor authentication and another OS tuple are not
inferred. The stopped import-only mode still does not qualify Launch Submit.
The frozen 23 October progress report is preserved as a historical snapshot.

## Active confirmed gaps

The confirmed Edit Team defect is corrected through the existing dialog and one
Host roster replacement. The original saved revision, saved settings, edited
presentation and complete roster are committed together. The old `updateConfig`
writer is not called for a Host handle; authoritative saved presentation also
feeds Team and global Task reads.

The existing Main application command ledger retains the exact roster intent
before dispatch. Renderer reload or dialog reopen cannot introduce a new command
while the previous outcome is unknown. Roster hydration reconciles only the
original command/payload at its captured Host; missing receipts retain HOLD.
Completed Main replay still requires a current authorized Host lookup. Standalone
HTTP composes the same existing storage/ledger features; missing durable storage
refuses roster mutations while preserving ordinary reads. No second journal or
new Team mutation is introduced.

For this focused correction, **108 tests in seven existing/new focused files
passed**, including seven SQLite reconstruction/error/authority cases, facade and
roster contracts, selected Desktop composition, existing Edit Team and Host reads.
The new guard and transport composition received an independent review; the
standalone omission it found was fixed before commit. The finite native source
closure includes the new dialog helper, guard and reused ledger dependencies.
Canonical typecheck with bounded compiler parallelism also ended with exit 137
under local resource pressure; no new native/UI or final exact-head full-CI PASS
is inferred from these focused tests.
Typed definitive pre-admission refusals remain terminal rather than unresolved
debt; a rejected stale save can reopen and submit a new intent. The existing
dialog also permits correction after a known refusal while retaining UNKNOWN
payload/identity protection. No error-message text is used to infer the outcome.

Actual stopped import → existing Launch Submit, final mixed Desktop acceptance,
packed/installed workflow, complete M01–M19 qualification and the original M19
custody HOLD remain separate obligations. No timeout, readiness, authority or
process-custody guard is relaxed to clear them.
