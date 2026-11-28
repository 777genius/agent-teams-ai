# CodeQL artifact self-index compatibility

Status: Not implemented, executed or published.

## Evidence and boundary

The reviewed repository baseline is d4b1e1c7752cefdf9123f39eb91ecd63fba07be4; the same collector and fixture are retained at the current execution baseline a37ae337bb2a8939e5970dbb79a9a81730d7835f. The collector is scripts/ci/codeql-password-hash-locations.mjs, blob de79e96b77d6e687958eb229f235fc4726c6f1d9; its existing fixture file is scripts/ci/codeql-password-hash-locations.test.mjs, blob 4d74acab0c99578d5cb2281736969a1635b991b8.

At collector line 281, an indexed physical location is rejected whenever the referenced run.artifacts[i].location has any index property. SARIF 2.1.0 section 3.4.5 explicitly permits that property on an artifact-table location, provided it equals that containing artifact's array position. The property is a self-index, not an instruction to traverse another artifact.

This shape is present in primary CodeQL source at the exact action revision used by the observed CI job: github/codeql-action 915412ff23e8b7659517e607487dbeae018f2934. src/testdata/valid-sarif.sarif, blob 5ea179e0e80dc410b4deaeaaa03e426f8fce5744, lines 118–143, contains artifact-table locations with indices 0 through 3; referencing physical locations also carry indices. src/testdata/fingerprinting.input.sarif, blob c9d5de32f8515bced14b66cd757352a88b42ab46, uses the same shape. These are producer-owned examples, not the unread SARIF from the application's current CI run.

Historical CI run 46120686694 / JavaScript job 140904313003 succeeded. Its collector printed partial with results=200, flows=25, threads=25, locations=348 and omitted=349; all rule-reference omission counters were zero and other=349. locations counts attempted visits before path/region validation, not emitted locations. The other counter also includes non-location failures. The 681-byte ZIP artifact 15256687258 was downloaded and decoded after executor recovery (SHA256 14bf78e1d49424ae962210a761a022a23cdb487e5da0d6d0f923af041c0b4756). Its 1,379-byte diagnostic JSON confirms these counters and contains seven selected result rows, indices 193 through 199, each with an empty locations array. It identifies PR head d4b1e1c7752cefdf9123f39eb91ecd63fba07be4, checkout 9eaa4a9438697978e746bd95ba8e15b6970e5be9 and tree 5223e037db1a69802330ceda032244d83db4c4f7. The artifact contains no raw SARIF, so the complete omission cause and extra omission remain unproved. The standard-compatible self-index rejection is independently established by the exact source and official examples; that evidence is sufficient for this narrow compatibility correction.

Primary references:
- https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html, section 3.4.5.
- https://github.com/github/codeql-action/blob/915412ff23e8b7659517e607487dbeae018f2934/src/testdata/valid-sarif.sarif
- https://github.com/github/codeql-action/blob/915412ff23e8b7659517e607487dbeae018f2934/src/testdata/fingerprinting.input.sarif

## Frozen implementation scope

One production file and its existing test file:
1. scripts/ci/codeql-password-hash-locations.mjs
2. scripts/ci/codeql-password-hash-locations.test.mjs

The only production change is the artifact-table self-index guard. After the existing validation of reference.index as a nonnegative safe integer and the existing table lookup, require a record-valued indexed location. If indexed.index is present, require Number.isSafeInteger(indexed.index) and indexed.index === reference.index. An absent indexed.index keeps its existing behavior. Equality to the already validated reference also enforces the nonnegative, correct-array-position condition.

Continue resolving the URI/base from that SAME table location and comparing any explicit reference URI/base against it with the existing resolver. Do not recurse through indexed.index or use it to select another row. Do not fall back to an explicit URI after a malformed or mismatched self-index.

Everything else remains unchanged: selected rule/reference validation, tracked regular Git-blob allowlist, relative-URI grammar, exact checkout-base policy, consistency of explicit/indexed location references, region validation, shared thread-location handling, provenance, input/output and visitation limits, result schema, omission counters, private-text exclusion and original output creation. In particular this correction does not add absolute URI support, chained URI-base support, driver-name aliases or broader SARIF interpretation. No workflow, CodeQL action, runtime pin, dependency, security rule or finding suppression changes.

## Finite verification

Use the actual existing collectPasswordHashLocations entry point; do not test a copied guard or require a future export. The existing indexed success fixture at lines 218–244 has a valid table URI/base but omits its own table index. Preserve that absent-index compatibility control.

Before the production change, add a focused standard-shape regression with a valid tracked table row carrying its matching self-index and locations referencing it. It must assert complete evidence and exact original repository paths/coordinates for primary, related and flow locations, including an indexed shared thread location. Assert the emitted report excludes SARIF messages, snippets, properties, file contents and absolute checkout data. Against unchanged source the complete/exact-location assertion is expected to fail because the current guard rejects the table self-index. This is a planned RED, not an executed result.

Cover both index 0 and a nonzero matching index, including index-only and consistent explicit-URI references. Do not accidentally test only a hard-coded zero special case.

Finite negative controls retain valid surrounding SARIF and then vary the table self-index: wrong nonnegative integer, negative, fraction, unsafe integer, string, null and object. Each must remain partial and must not emit that invalid selected location even when the reference contains an otherwise acceptable explicit URI. Reject a cross-index to another artifact even when both rows spell the same tracked URI; there is no alias traversal.

With a matching self-index, retain focused controls for untracked/unsafe URI, foreign checkout base, disagreement between the explicit and indexed URI/base, and invalid region. These checks must still refuse rather than being bypassed by the newly accepted self-index. Existing absent-index success, direct relative-location success, rule-reference, privacy, limits and exact Git provenance/CLI tests remain unchanged and run as the existing collector cohort.

After that source change, run the finite regression and the complete existing collector test file using the normal repository project-command convention, then changed-file formatting/lint checks. No Host compiler or native service is required for this JavaScript collector change. Record actual RED/GREEN and command outcomes only after execution is available.

The next ordinary CodeQL workflow may provide integration evidence. Inspect the actual saved diagnostic JSON and, if needed, the minimal corresponding original SARIF location/table tuple when available. Do not label the current 349 omissions explained or the query clean merely because the focused compatibility tests pass. No manual workflow rerun/dispatch is part of this plan.

## Reviews

R1: provider_team_parity source/design review complete. R2: coordination_audit independently approved the exact 7,166-character plan after reading the collector guard, existing indexed fixture, OASIS section 3.4.5 and the pinned official CodeQL artifact table. R3: root independently approved the narrow self-index source change and verified the historical diagnostic artifact after executor recovery. This document records no implementation, test run or qualification of the current a37 CI run.
