# Provider9423 original evidence bundle

This bundle preserves the exact reviewed evidence for provider source
9423f600dfb04d04448326dbced89919924b0b5f, tree
a873a5f9ad8e6da1d8894db22a02d8c8efb37199, in
agent-teams-ai/old-provider-implementations. It does not apply source or install
the archives. All existing payloads are copied byte-for-byte; no original audit,
log, API response, source file, ZIP or outcome is rewritten.

## Included and recoverable material

The 110 original files total 1,732,460 bytes. They contain all 53 original controlled
receipt ZIPs (58,477 bytes), official run/artifact/job API records, classification,
four exact verifier-source files and independent R2; the original Node24 checked
pair ZIP (193,146 bytes), both complete source/packed CI logs, source and workflow
copies, original inventories and independent checked-pair R2 are also retained.

Fifty-three extracted controlled receipts and the three extracted members of the
checked-pair ZIP are deliberately not duplicated. The manifest maps all56 omitted
paths to exact archivePath/memberName and byte/Git-blob/SHA256 identities. Reading
those members as data restores the original paths and exact bytes. Absolute paths
inside the original audits remain historical provenance; use the manifest's
relative archive paths to locate files after extraction. Original TGZ files and
their receipt remain inside the checked-pair ZIP, without repacking either TGZ.

## Recorded results stay separate

The two original source/packed CI jobs used Node 24.21.0 and 26.11.1 respectively.
Each recorded 540 source cases plus two distinct one-case packed consumers,
542 PASS with 0 failures/skips/cancellations. These are two executions, not 1,084
distinct tests. The official Node24 ZIP was read; Node26's matching archive digests
come from its full original log, not a separately downloaded Node26 ZIP. The
checked pair retains nativeHostQualified=false and packagedElectronQualified=false.

The separate 53 controlled receipts have 51 completed=true and two original
completed=false negative controls: embedded-floor/TEST_embedded_floor_ESM_import_unavailable
and model/TEST_native_model_terminal_event_not_qualified. All 53 have cleanup=true
and qualified=false. The expected-negative helper predicates and 10 interrupt field
sets were independently reviewed; other nested positive internals are preserved
verbatim, not newly represented as exhaustively audited. Official API records show
53 successful jobs, but the 53 complete raw job logs were not fetched or reviewed.
The earlier checked-pair R2's status-only limitation is historical; the separately
retained later native-receipt R2 adds this finite classification without rewriting it.

The original Claude/Codex vendor jobs in the checked source review were skipped
with 0 executed steps. Controlled receipts, source/packed tests and cleanup do not
qualify application Host, graphical Desktop, packaged Electron, installed vendor
behavior or the application's P08/P09 boundaries. No new test/build/compiler,
native/provider command, CI action, source/ref change or pair adoption was performed
while assembling this bundle. Signed temporary transport URLs are not included.

## Inventory integrity

inventory.json lists all 110 original payloads, this generated README, and all 56
recoverable omissions. The inventory omits its own hash to avoid recursion; the
external bundle-metadata.json records its exact identity and the final outer ZIP.
All 112 outer ZIP members have safe unique relative paths and regular-file modes;
the original 54 nested ZIPs retain their exact original bytes. The assembler read
the 53 native JSON members and three checked-pair ZIP members as data only.
