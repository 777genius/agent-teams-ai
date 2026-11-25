# 48. Bind the original failure formatter in the process unit harness

**Selected narrow follow-up; no source applied yet.** Parent: `e03a7a39255efa47894b1dbe8fdaf1b69d4e4b51`, tree `a4f5e79d97fda48f9b5f4a62af81345c4c9fec44`. Preserve the full prior history and selected Plans46/47.

## Actual failure and cause

The original a07 Process Desktop job `133387314730` failed its existing unit gate at `desktop-native-process-ui.test.ts:330`: the retained first-failure case expected one bounded stdout write and observed zero. The subsequent missing cold-UI log is a consequence of that gate stopping before the original Desktop journey. [1]

The test extracts the production catch block into its existing isolated Function harness. The catch block now calls the previously added `windowsUiFailureLine`, but the harness does not bind that helper. Its ReferenceError is contained by the original diagnostic-write catch, leaving the original error and cleanup boundary intact but producing no write. The production gate already declares the formatter before this catch.

Exact source inspected: `tools/owned-process-broker/nativeWindowsAppGate.mjs`, blob `40d7c19142de2cafdb0a7b433bbedddc216e99da`. It is unchanged by this follow-up.

## Single existing test path

Change only `scripts/legacy-agent-host/desktop-native-process-ui.test.ts`, preimage `217b189f231af2ea39b290d70568a1ae42379a53`.

Within the existing first-failure case, extract the actual formatter declaration from the same already-read and CRLF-normalized source. Bound it by the unique existing strings `const windowsUiFailureLine = ` and `\nconst repository = `, asserting that each anchor occurs exactly once. Insert that exact declaration into the existing Function before its unchanged catch body, and bind the already-imported assert object alongside Buffer in its existing environment.

Do not invent a formatter stub, duplicate the formatter implementation, import or execute the Windows gate, export production internals for tests, or add a shared helper. The isolated source slice contains only the pure formatter declaration; repository setup and process actions stay outside it.

Preserve every original assertion and scenario: original Error identity, single formatting call, original proof object/error, one stdout FD1 write, newline and parsed prefix, 128-character prefix, UTF8 1024-byte boundary and oversized refusal, throwing/partial sinks, and final cleanup boundary. Keep the original catch and cleanup delimiters and exact extracted catch bytes. Add only the helper binding and its two unique-anchor assertions.

No production source, diagnostic shape, action, timer, timeout, custody, cleanup, fixture identity or acceptance condition changes. This existing test already belongs to the common source-freeze roster and original fast/typed-lint and unit commands. Those scopes remain unchanged.

## Publication and verification

Publish and fully read back this plan before inert source editing. Freeze the single-path diff, obtain independent exact-byte R2, and publish through the current expected-parent ref while preserving incoming changes. No force push or local project execution is selected.

The original resulting-source Process Desktop unit gate must pass before its unchanged UI/cold journey proceeds. Canonical TS7, typed lint, other original unit assertions and the original packaged Windows flow remain authoritative. A repaired unit harness does not establish packaged readiness or a successful end-to-end result.

Stage1 remains default-off; the PR remains Draft. Genuine Claude/Codex, Ready, main merge, release/default activation and Stage2 remain unselected.

[1] [Original Process Desktop job](https://github.com/777genius/agent-teams-ai/actions/runs/43892535269/job/133387314730).
