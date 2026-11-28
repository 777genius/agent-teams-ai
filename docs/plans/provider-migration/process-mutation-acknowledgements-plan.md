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
