# P11 V2 live membership: source selection on 2026-11-16

## Scope and prerequisite

Continue the original Stage 1 frontend-parity plan with its existing Add / Remove / Restore / Stop / cold-history journey. The app stays Draft; no default activation, release, Stage 2 or real Claude/Codex execution is selected.

The content base is `55b9b84935a13facdb85cb9a77ab26b7b0627507` (tree `32151478150e048e452b6cdc185fe36612f18ff4`). The earlier inert C8 packet `b10cb5bfe4228d8f0e527a37198db81ed8052640` was rebound to this base. The existing installer/correction changes and all five added regressions remain.

The original B Team [job 133260433205](https://github.com/777genius/agent-teams-ai/actions/runs/43856040329/job/133260433205) checked out `852d9bd3f9142603340f71ca998739e69da00084`. Independent raw-log review accepted its original ten-file Runtime/conversation set (179 PASS, 0 FAIL, 0 CANCELLED, 0 SKIPPED), workspace and dedicated backend types, and all original typed-lint scopes including MCP (zero errors, existing warnings). The earlier 123 helper and 7 install-retry checks also passed. This satisfies the previously declared B prerequisite for C selection; it is not evidence for the resulting C source.

## Selected implementation

Reuse the original mixed-membership UI journey and existing V2 management lane. Keep Settings preparation, execution and verification before the separate membership journey in the same original 45-minute job. The membership route uses captured OpenCode V2 and finite initial Claude/Codex protocol peers. It admits no real Claude/Codex discovery or inference and claims no full mixed-native qualification.

Exactly eight source paths are selected: `desktop-backend-smoke.ts`, new `desktop-live-membership-controlled.ts`, `desktop-live-membership-ui-smoke.ts`, `desktop-mixed-native-fixture.ts`, `desktop-proof-supplementary-sources.ts`, `desktop-team-ui-smoke.test.ts`, new `verify-desktop-v2-live-membership.ts`, and `.github/workflows/host-emulated-acceptance.yml` (script paths are under `scripts/legacy-agent-host/`).

Seven postimages are byte-identical to the reviewed inert packet. The test file preserves its complete current 148,876-byte prefix (`a82d278f24b2763d5b73d69c23d7a0b3d6142d25`) and appends only the original 6,484-byte, 86-line C8 closure cases, producing `d85fdc35b6b0cb35c4bfef7057356de03790ce50`. All 98 scoped-lint operands stay ordered; five missing source operands are added. The original ten Runtime files, complete type/lint commands, deadlines and acceptance assertions remain.

Estimated change: 519 net lines across those eight paths, including two focused helper/receipt-verifier files (219 and 154 lines) and 86 test lines. The largest changed scenario is 798/800 lines. Complexity 5/10; source confidence 8/10. The principal remaining risk is actual V2 UI/model/process lifecycle behavior on the resulting source, not covered by source review or B results.

## Required validation and limits

Run the existing resulting-source Desktop workflow: original eight prerequisite test files, ten Runtime/conversation files, full workspace and dedicated types, full typed lint, Settings, original membership UI and strict receipt/cleanup verification. The verifier requires two ordinary probes, four business requests, two inputs, four Runtime generations, separate restored identities, physical release and unchanged cold history. Preserve useful already-started B jobs; no blind rerun, action replay, timeout increase or extra test-only RED cycle is introduced.

A PASS requires fresh receipts bound to the resulting source and captured inputs. Native/process/platform, packaged Windows Retry/Stop, P09 selected-byte guarantees, vendor and release qualifications remain separate outstanding gates. Queueing, skipping and cancellation are never PASS.
