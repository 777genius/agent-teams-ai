# Process acknowledgement integration verification

## Incoming correction and independent review

While a separate correction was being planned against `a01484e`, the shared
branch received `a988fa2` and `0ebe1df`. The latter already implements the
[published unregister acknowledgement plan](process-unregister-acknowledgement-plan.md).
The exact two incoming trees were imported and verified without overwriting
the parallel team registry work or the local execution notes.

Root and an independent reviewer inspected the actual three-file process diff,
the external plan, and all six added regressions. The incoming correction
already validates the compact terminal receipt before any registry mutation,
including the two extra string units in its phase fields. It retains original
selection, principal, command identity, pre-effect preparation, uncertain
outcomes, and native custody. Retained legacy result rows still pass the public
allowlist before omission; malformed rows remain refused.

The incoming contract deliberately returns a bounded acknowledgement for every
completed unregister, including small catalogs. `process_list` supplies the
complete current catalog. This is documented in the original plan and tool
descriptions. Source review found no production caller depending on an
unregister result array. Restoring a second response convention would add no
required capability, so the incoming production correction is accepted as is.

The original independent candidate and its review notes remain in the local
checkpoint. They are superseded by this narrow verification plan; no duplicate
process production change is proposed.

## Remaining verification to execute

Extend only
`packages/legacy-agent-host/tests/mcp-process-catalog-http.test.ts`, which already
uses a real filesystem Team Owner and authenticated HTTP MCP endpoint with
100 accepted 4,096-character registrations. Keep its complete paging assertions
and add the actual network mutation path:

1. Send `process_unregister` through the authenticated HTTP client using the
   original Owner metadata port. Confirm the completed bounded acknowledgement
   and durable receipt before reading the remaining catalog.
2. Reconstruct all 99 remaining rows through `process_list`, preserving order,
   optional fields, and the original selected row's absence.
3. Replay the identical command and use `process_lookup` over HTTP. Reopen the
   same filesystem owner and use an independently authenticated cold endpoint
   for original lookup/replay. Preserve exact receipt and registry bytes and
   establish that the canonical unregister function ran once.
4. Refuse a changed selector under the same command ID. Preserve the existing
   endpoint's binding, grant and expiration checks; the incoming six-case
   fixture already covers wrong principal/Team, revocation, malformed retained
   results, historical prepared uncertainty, multibyte output, and the exact
   pre-effect size boundary.

Use TEST roots and metadata-only registration. Supply no native process adapter,
start no user service, and close both HTTP clients/endpoints in fixture cleanup.
Do not duplicate the incoming source changes or repeat its already established
RED as though it were a new defect.

## Gates

Publish this verification plan before the fixture extension. Build the canonical
Host with the incoming auth-progress and process corrections, then run the
focused HTTP/process regressions and strict changed-fixture compilation in the
single heavy-job slot. Review the exact extension and record actual results.
The current-a014 Main/Host TEST E2E evidence remains tied to its original hashes;
it is not relabelled as a test of the new credential source. Required current-head
CI and native-provider/Desktop qualification remain separate gates.

## Execution — 2026-11-28

The existing HTTP fixture now sends unregister, lookup and identical-command
replay through real authenticated clients and through a second endpoint over a
newly opened filesystem owner. A delegating observation of the actual canonical
unregister function confirms exactly one registry mutation. The test verifies
the completed durable receipt, unchanged original receipt/registry bytes on
replay and conflicting selectors, and full reconstruction of all 99 remaining
rows with optional fields and original order. Both clients and endpoints close
in fixture cleanup. Root and an independent reviewer inspected the exact test
extension; no process production source was changed.

The seven-file process/credential/model-custody cohort passed **103/103 tests,
zero skipped**, in 24.13 seconds. It includes this actual HTTP test, the incoming
six-case unregister regressions, credential store/owner tests, protected auth
witness/recovery tests, and ModelProbe custody tests. Strict compilation of those
seven fixtures also passed with the original Host test configuration and
unchanged strict options; the compiler emitted no diagnostics.

These behavior results used a clean runtime emit of the exact `0ebe1df` Host
source, produced by pinned TypeScript 7.0.2 with `--noCheck`. Two canonical Host
build attempts had ended with exit 137 and no diagnostics, including one with a
reduced memory target. The successful emit is explicitly **not** a canonical
build or full typecheck PASS. It enabled independent behavior verification and
the separate strict fixture check while the source-qualified build/CI gate
remained open. The new registry implementation was not part of that emitted
source or this 103-test result.

The later registry candidate completed the canonical checked Host build,
including its original task-change-ledger prebuild. Running the same seven-file
cohort against that checked output passed **103/103, zero skipped**, in 23.62
seconds. The checked-run log SHA-256 is
`70956a22501f6b2d290768861300342364f293fac4d4593985a4a25fd879fa5c`.
This is a separate run, not a relabelling of the earlier runtime-only emit.

The current candidate also passed the actual Main IPC / captured Desktop / Host
/ separate TEST-process management E2E: one test, zero skipped, 6.81 seconds
(11.78 seconds total), two Host shutdowns and all 18 captured TEST PIDs absent.
The first current attempt received SIGKILL without a test result. A subsequent
observed run used the same fixture and fork/worker settings with a 256 MiB heap
limit; it passed and recorded peak sampled aggregate RSS of 1,157,112 KiB. The
SIGKILL attempt remains unqualified, and its cause was not established. Exact
candidate source/dist hashes, original receipt and logs are recorded in
`evidence/e2e-registry-candidate-local-2026-11-28/manifest.json`. These checks do
not qualify Electron controls, vendor accounts, native runtimes or Family B.
