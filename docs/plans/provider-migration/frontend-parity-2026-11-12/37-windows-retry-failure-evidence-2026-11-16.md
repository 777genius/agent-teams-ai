# P08 packaged Windows Retry: retain original failure evidence

## Original observation

The B852 Windows ARM64 [job 133295289524](https://github.com/777genius/agent-teams-ai/actions/runs/43856040242/job/133295289524) passed its separate packaged V2 Host proof, then exhausted the original 10-second same-Main Retry phase. Its artifact `14230030725` (426,682 bytes, SHA-256 `74d3e6f211bc678bb9e2e8772a77830710de8805b5a2a2c111e706a8da88f5c7`) contains no final same-Main UI receipt. The outer controller reported emergency termination before the driver's final receipt write. Emergency draining is not successful product cleanup.

The exact failing Retry operation cannot be recovered from the phase-only log. Existing in-memory Retry stages and census timings were lost. Repeated CLIXML diagnostics and an untimestamped app-log error do not identify a causal operation and are not used to justify a behavior change.

## Selected narrow change

Content base: `6e4e724a719651fe2f4724f533bb5c3478e00b83` (tree `70efd93b76cfc42c4e7cfca4e5a8f6d3215dfa0e`). Change only `tools/owned-process-broker/nativeWindowsAppGate.mjs`, blob `034d2253e0649bdeb5db0b12244656446150c31c` → `a7b953e61935f6de4b1f29b534b33baaa64a9215`.

The existing synchronous failure record includes a bounded projection of already-retained Retry stages and same-phase census counts/durations. Only fixed labels and numeric counters are serialized. No process identity, path, renderer text, new clock read, snapshot, CDP operation, action, retry or timeout is added. The original failure remains authoritative and all ownership/cleanup paths stay unchanged.

Keep the original 1,024-byte UTF-8 line bound including newline. Malformed optional data or an oversized projection falls back to the original kind/phase/error record, so diagnostics cannot suppress that existing evidence. The same existing Team scoped lint already names this gate; no workflow edit is required.

Estimated change: 51 net lines in one existing file, resulting in 648 physical lines. Complexity 2/10; source confidence 9/10. Author review and independent exact-diff review accepted the bounded projection and preservation of original flow.

## Verification and remaining requirement

Syntax and forward/inverse patch checks passed. Independent supplemental checks extracted the actual pure formatter with only assert/Buffer dependencies under Node 24.22.1: 8 PASS, 0 FAIL. They cover same-phase accounting and noninterference, pre-Retry state, malformed optional data, census validation, numeric overflow, UTF-8 size fallback, exclusion of unselected identity/text, and preservation of the original record when projection throws. This is not a project, native, packaged or original pinned-run qualification.

The unchanged packaged Windows scenario still owes actual same-Main Retry, retained process identity, original Stop/neighbor behavior and product Quit on the resulting source, with its original deadlines and cleanup requirements. This change preserves evidence for that verification; it does not fix or declare the Retry scenario successful.
