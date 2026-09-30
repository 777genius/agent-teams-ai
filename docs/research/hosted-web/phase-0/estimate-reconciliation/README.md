# Phase 0 unique-bucket estimate reconciliation

## Outcome

Against target candidate 1587615c751c3cb12b5078ab4b7264b6e9fd42ad, the reconciled non-terminal v1 estimate is **38,300-62,100 gross integrated changed lines**. The estimate model remains anchored at source snapshot 42ec333848e29e97c41699b9fed73ed199740e3f, while the two auth-artifact inputs are reproduced from their target-candidate bytes. The parent unique-bucket baseline remains 28,000-45,000. The 38,300 low endpoint is inside that inclusive interval; only the 62,100 high endpoint is above it. The partially out-of-range interval, bucket variance, controller estimates, and unallocated migration split still require explicit scope/design review before capacity expands.

The accounting unit is additions plus deletions in the final integrated diff, even though the parent plan calls it “net changed lines.” Generated/vendor bundles, lockfile churn, mechanical formatting, Phase 0 research bytes, and post-v1 hosted terminal scope are excluded.

This directory is a current estimate candidate pending review, not canonical evidence. `docs/hosted-web-phases/START_HERE.md` remains the canonical hosted-web entrypoint, and `docs/hosted-web-phases/EVIDENCE_LIFECYCLE.md` governs review, authority, retention, and supersession. The rejected `estimate-candidate-reconcile-h4` output remains rejected and non-authoritative; this remediation reuses its preserved four estimate files as input without reviving its authority.

The source snapshot identifies where the estimate inputs are reproduced; the target candidate identifies the release-scope bytes being evaluated. Neither label is an evidence-authority claim. The target release scope is non-terminal v1. Counted lines are implementation additions, tests/evidence additions, deleted legacy lines, and explicitly unallocated mixed scope. Generated/vendor and other excluded lines contribute zero. Uncertainty remains visible in confidence, assumptions, controller-estimated allocations, and unallocated mixed scope. The hosted terminal slice remains a separately estimated post-v1 deferral and contributes zero to this v1 total.

The machine-readable artifacts are:

- estimate-ledger.json — source hashes, nine unique buckets, W3/W4/W5 allocation reconciliation, confidence transitions, totals, deferred scope, and review triggers;
- estimate-ledger.schema.json — strict Draft 2020-12 schema;
- verify-ledger.mjs — pinned source/target snapshot hashes, allocation ownership, overlap subtraction, W4 scope completeness, confidence, arithmetic, variance, and terminal-exclusion checks.

## Reconciled totals

| Accounting component           |        Low |       High |
| ------------------------------ | ---------: | ---------: |
| Known implementation additions |     17,300 |     27,000 |
| Known tests/evidence additions |     12,550 |     20,250 |
| Deleted legacy lines           |      3,300 |      6,750 |
| Unallocated mixed scope        |      5,150 |      8,100 |
| **Reconciled non-terminal v1** | **38,300** | **62,100** |
| Parent unique-bucket baseline  |     28,000 |     45,000 |
| Deferred hosted terminal T1    |      6,500 |     11,500 |

Deferred hosted terminal contributes zero to v1.

## W3/W5 recovery split

Numeric endpoint containment is not used as an overlap rule. The original parent recovery/state baseline is split, without changing the 28,000-45,000 total baseline:

| Bucket                     |    Baseline |  Reconciled | Numeric treatment                                                                |
| -------------------------- | ----------: | ----------: | -------------------------------------------------------------------------------- |
| EST-RECOVERY-STATE         | 2,500-4,000 | 4,950-8,500 | All four W3 source sub-buckets, gross-normalized and summed                      |
| EST-COMMAND-EVENT-RECOVERY | 2,000-3,500 | 4,250-7,000 | W5 source envelope less the bounded shared storage/transaction-fixture allowance |

W5’s source envelope is 4,700-8,000 gross lines. The ledger decomposes it into:

- 4,250-7,000 unique command descriptors/fingerprints, effect recovery, event journal/SSE handoff, renderer reconciliation, and provider-effect adapters;
- 450-1,000 shared transaction/storage fixtures excluded from the W5 bucket because the W3 writer-coordination and SQLite-backup allocations already represent them.

The verifier proves that unique plus excluded overlap reconstructs every W5 source component, that all four W3 source sub-buckets reconstruct the W3 bucket, and that a negative fixture with nested numeric ranges but disjoint allocation keys is rejected as semantic overlap.

## W4 executable native estimate

W4 r3 remains valid source evidence: it characterizes the host and admits zero executable lines. The reconciliation does not mutate or delete that evidence. It adds a controller estimate for every executable primitive that W2 explicitly excludes:

| W4 allocation                        | Owner bucket           |     Gross range |
| ------------------------------------ | ---------------------- | --------------: |
| Workspace guard                      | EST-IDENTITY-WORKSPACE |       850-1,400 |
| Instance lease                       | EST-LIFECYCLE-RUNTIME  |       950-1,650 |
| Process anchor                       | EST-LIFECYCLE-RUNTIME  |       900-1,500 |
| Native-helper build and artifact ABI | EST-LIFECYCLE-RUNTIME  |     1,150-2,000 |
| Final-image probes                   | EST-LIFECYCLE-RUNTIME  |       650-1,100 |
| **Complete W4 executable scope**     | two owner buckets      | **4,500-7,650** |

The workspace guard is allocated inside the existing identity/workspace parent envelope; it replaces part of that bucket’s unallocated range. The remaining four W4 allocations are added to W2’s 5,050-7,500 gross lifecycle/runtime contribution, producing 8,700-13,750.

The rejected historical W4 r2 envelope remains source evidence and contributes zero.

## Confidence transitions

Every bucket stores baseline rating, reconciled rating, changed flag, source provenance, and transition reason. The verifier checks the baseline ratings against the parent ledger and proves each changed flag from the two ratings.

Total confidence transitions from the parent **7/10** to reconciled **5/10**. The reduction reflects two controller-estimated inputs: the complete W4 executable allocation and the W3/W5 shared-fixture bound. The schema and verifier require both scores, scale, provenance, changed flag, and reason.

## Bucket summary

| Bucket                     |    Baseline |   Reconciled | Confidence          |
| -------------------------- | ----------: | -----------: | ------------------- |
| EST-CONTRACTS              | 2,000-3,000 |  2,000-3,000 | high → high         |
| EST-IDENTITY-WORKSPACE     | 3,500-5,500 |  3,500-5,500 | medium → medium-low |
| EST-LIFECYCLE-RUNTIME      | 5,000-8,000 | 8,700-13,750 | medium → low        |
| EST-RECOVERY-STATE         | 2,500-4,000 |  4,950-8,500 | medium-low → low    |
| EST-COMMAND-EVENT-RECOVERY | 2,000-3,500 |  4,250-7,000 | medium-low → low    |
| EST-HOSTED-OPS             | 3,500-5,500 |  3,300-5,150 | medium → medium-low |
| EST-RENDERER-LIFECYCLE     | 3,000-5,000 |  3,900-6,400 | medium → medium-low |
| EST-REMAINING-PARITY       | 4,000-6,500 |  5,200-8,800 | medium-low → low    |
| EST-RELEASE-E2E            | 2,500-4,000 |  2,500-4,000 | medium → low        |

Endpoint-relative variance is +36.7857% for 38,300 versus the 28,000 lower endpoint and +38% for 62,100 versus the 45,000 upper endpoint. Those paired variance calculations do not make 38,300 outside the full 28,000-45,000 interval. Lifecycle/runtime, both split W3/W5 buckets, renderer lifecycle, and remaining parity exceed the greater-than-20-percent bucket trigger.

## Source integrity

Every declared source carries an explicit provenance class. Twenty-one inputs are reproduced with `git show` from source snapshot 42ec333848e29e97c41699b9fed73ed199740e3f. The two auth-artifact inputs are reproduced from target snapshot 1587615c751c3cb12b5078ab4b7264b6e9fd42ad. The verifier requires the source snapshot to be an ancestor of the target snapshot, but intentionally does not assert `HEAD == asOfCommit`; this keeps verification valid when the reconciliation commit advances HEAD.

| Source                                                                        | Provenance snapshot | SHA-256                                                          |
| ----------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------- |
| docs/hosted-web-e2e-completion-plan.md                                        | source              | 4901a37dc4da373efab939b43a406739ed02e1b4e250a7a2e5754ad659fa4080 |
| docs/research/hosted-web/phase-0/estimate-ledger.md                           | source              | 1b0f45bfdeb17e2ddc6058482c9b190f16b09501561c361370fac5bfad783ab0 |
| docs/research/hosted-web/phase-0/freeze/current-canonical/evidence-index.json | source              | d5c8725dfb22f7e0228e0dd51f53d978d117ed7253fdb279c8ddba7000ff8758 |
| docs/research/hosted-web/phase-0/parity-renderer/estimate-input.json          | source              | af3fe8edc17ac5f3ca77533a949625b5b97c61c3ebab111726f72ebdc9adf669 |
| docs/research/hosted-web/phase-0/provider-runtime/estimate-input.json         | source              | 6316c642472506f51638673aa3ede535dc358264c77b4cff43ca83364d879625 |
| docs/research/hosted-web/phase-0/state-writers/estimate-input.json            | source              | e115aa10ab1ad3842e8b44db03a07541cae9b6abdbeb1207ba3f01bd6d5ff7ae |
| docs/research/hosted-web/phase-0/host-primitives/estimate-input.json          | source              | a1b527c3f9ecd1863223eed43bc6e0a3ea720af9138114b9924d0e8acf062f7c |
| docs/research/hosted-web/phase-0/recovery-events/estimate-input.json          | source              | 03f41142c1845f913bd0dfbd59499cfb6390454c36f4fec596432e7faf714341 |
| docs/research/hosted-web/phase-0/auth-artifacts/estimate-input.json           | source              | 1309dd32d3ebf57447dc181b802fa5e625f1b7bb069fc040c08fef74513750b8 |

The ledger also pins fourteen supporting evidence files. Of those, `auth-artifacts/evidence.json` is target-classified at `082f9deced2bf21b5b15c14f9f8f786198e61eceb52b9007605949f45ebb503a`, and `auth-artifacts/proposed-hosted-artifact-manifest.json` is target-classified at `8903c40cf3761996f5fc732e4d54e0803e2ff6c2eed32f7cbff1befcd7f65f73`. Verification recomputes all twenty-three hashes from their declared Git snapshots.

## Validation

From repository root:

    node docs/research/hosted-web/phase-0/estimate-reconciliation/verify-ledger.mjs
    python3 -m json.tool docs/research/hosted-web/phase-0/estimate-reconciliation/estimate-ledger.schema.json >/dev/null
    python3 -m json.tool docs/research/hosted-web/phase-0/estimate-reconciliation/estimate-ledger.json >/dev/null
    python3 -m jsonschema -i docs/research/hosted-web/phase-0/estimate-reconciliation/estimate-ledger.json docs/research/hosted-web/phase-0/estimate-reconciliation/estimate-ledger.schema.json
    pnpm exec prettier --check "docs/research/hosted-web/phase-0/estimate-reconciliation/**/*.{json,md,mjs}"

Owned-path scope, current-candidate diff, and validation results are recorded in the single handoff under .codex-handoff/.
