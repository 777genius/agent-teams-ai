# OpenCode original admission and directory identity

## Observed failures

The original Windows ARM64 process run for `c226dc06d841c828d4e6cd8d56acaf4c5d9d22a5`
failed `nativeEmulatedProviderGate.ts` at OpenCode `runtime.open`, returning `hold`.
The same receipt retains five passing wrapper recipes, the passing Codex provider
scenario and confirmed outer cleanup. It does not qualify the failed OpenCode
scenario or its downstream source-selection gates.

- Run: <https://github.com/777genius/agent-teams-ai/actions/runs/43639314552>
- Job: <https://github.com/777genius/agent-teams-ai/actions/runs/43639314552/job/132583194517>
- Artifact: `host-process-fixtures-win32-arm64-c226dc06d841c828d4e6cd8d56acaf4c5d9d22a5`,
  ID `14131653020`, ZIP SHA256
  `13c3ca61d6bd9b816370f85240c7e4d34266033fdabac3fff4c64e5196f2964b`.

Two independent defects were isolated with the unchanged finite provider peer
and actual Host on Linux; this reproduction is not Windows kernel qualification.

1. The old Windows fixture lacked the current constructor admission for the
   original OpenCode `runtime.open` command. Both ASCII and Unicode workspaces
   returned `hold` without launching a peer. Adding the original pre-serialization
   `captureInitialRuntimeModelAdmission` capture permitted the ASCII control to
   reach `nativeReady` and close with Host exit zero.
2. Both production OpenCode V1 HTTP owners wrote the raw working directory to
   `x-opencode-directory`. The captured Windows workspace contains `Я`; Node's
   `Headers` rejects that non-ByteString value. With admission present, the Unicode
   reproduction failed and original Host shutdown returned exit one. That failed
   attempt remains incomplete; it is not cleanup evidence.

## Changes

`nativeEmulatedProfile.ts` now captures only the original `TEST-open` command,
member, Team, source and account before serializing and hashing the fixture.
It does not grant a fresh admission after a refusal or change the kernel, Stop,
neighbor, custody or cleanup assertions.

The V1 Runtime and management HTTP owners encode their selected working directory
with `encodeURIComponent`. The native process cwd and captured namespace remain
the original path. This also preserves a literal percent sequence through the
native server's one decoding step.

The pinned upstream SDK does the same encoding:
<https://github.com/anomalyco/opencode/blob/v1.18.35/packages/sdk/js/src/client.ts>
(retrieved Git blob `5cf071e7b7abb0ea9680c4b843d9dd2ef6e3d51c`).
OpenCode protocol version `1.18.35` remains selected for the Windows fixture.
Finite HTTP peers and controlled HTTP assertions require that exact encoded
header; they do not accept an arbitrary or foreign directory.

## Verification boundary

Two new regressions exercise the real Runtime and management owners with their
existing controlled process/HTTP adapters. Both failed before the change:
Runtime readiness was unavailable, and management catalog startup was unavailable.
They cover Unicode and literal `%2F` path content, exact wire encoding and
decode-once identity, unchanged native cwd, and no submitted model input.

The exact before result was **0 passed, 2 failed, 0 skipped** on Node `24.21.0`.
After the coordinated Host build at 21:16:43 UTC, all three complete affected suites
passed: **45 passed, 0 failed, 0 skipped** (`opencode-member-provider.test.ts`,
`opencode-management.test.ts`, `management-model-probe.test.ts`). The complete Host
test TypeScript project, fast ESLint and whitespace checks also passed.

The actual Host reproduction then passed both ASCII and Unicode paths. Each
original profile first refused a different command with `hold` and zero peer
launches; its captured `TEST-open` then reached `nativeReady`. Both original Hosts
closed with exit zero, null signal and valid protocol output. Each case observed
one finite peer MCP connection and zero business inputs or service registrations.
The retained peer SHA256 was
`1029a4df9eb6f771c3c0dc9246acafd0f2f3823174ed182f6dd76e079a4330e5`.

A fresh Windows native process run remains required to qualify the original
Windows scenario; Linux and controlled tests cannot replace its native process
and scoped Stop evidence. No vendor executable was used by these checks.
