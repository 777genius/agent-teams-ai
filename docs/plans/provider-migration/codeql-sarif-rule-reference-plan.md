# PR #982 — CodeQL SARIF rule-reference compatibility plan

Status: reviewed and approved for the finite implementation below; published before production and test changes.
Baseline: cf0d178aeb350c8a0fb113ec89e44836030966ee, 2026-11-28.
Owner: frontend_parity. Root owns plan publication, source integration and ordinary CI.

## Confirmed problem and limits of the evidence

The collector rejects every explicit result.rule at scripts/ci/codeql-password-hash-locations.mjs:82, before examining whether it is a valid reportingDescriptorReference. The test at lines 99–115 deliberately preserves this rejection and includes shapes that become valid when the top-level ruleId/ruleIndex defaults are applied.

Official job 140856887529 in run 46105391552 recorded CodeQL 2.27.6 and javascript-queries 2.5.2, analysisOutcome success, and the diagnostic summary {status:partial, counts:{results:199,flows:0,threads:0,locations:0,omitted:200}}. Artifact 15250045221 was uploaded as a 550-byte ZIP. These logs prove an empty partial diagnostic; they do not reveal the reason for each omitted result. No raw SARIF was inspected and no claim attributes all 199 omissions to this one branch.

Official CodeQL 2.5.5 documents both reportingDescriptorReference on SARIF 2.1.0 results and rule metadata grouped under tool.extensions. The resolver must implement those ordinary references while retaining the collector's fail-closed treatment of contradictory or unresolved identities.

## Exact implementation manifest

1. scripts/ci/codeql-password-hash-locations.mjs — local pure rule-resolution helpers, their bounded lookup state, fixed omission counters, and replacement of only the current rule-selection branch.
2. scripts/ci/codeql-password-hash-locations.test.mjs — positive/negative reference tables and budget/privacy/CLI controls.

No workflow, permissions, CodeQL configuration/query, dependencies, application source, raw-SARIF retention, or output destination changes. The workflow's diagnostic continue-on-error behavior is unchanged.

Source SHA-256: d951948d67efa207d70ef11ee4133bb629b8316a965c1dba0625ddfe8fc1199b (214 lines).
Test SHA-256: e2bc5acf4f55cd1957c448e03f5d8e458941b6244fa8dadacaf56ea7aa2d5a3d (269 lines).

## Resolution contract

Use one pure per-run resolver returning selected, unrelated, or a fixed rejection category. It receives only the original run tool and result; it neither reads files nor follows URLs/external property files. All supplied identity fields must be checked before a result can be declared unrelated.

- Validate supplied result.ruleId and result.ruleIndex and, when present, the rule object and its id/index/guid/toolComponent identity fields. A present malformed rule never falls back to a top-level textual ID.
- If both top-level and nested IDs are supplied, require exact equality. If both indices are supplied, require the same nonnegative safe integer. Inherit a missing nested ID/index from the corresponding top-level value.
- An absent toolComponent selects the original driver. An object with neither index nor GUID also selects the driver. A supplied index selects exactly that element of tool.extensions; it never indexes the driver. A GUID-only selector must uniquely identify the driver or one extension. A supplied component name and GUID must agree with the selected component. Name alone is not a search key.
- Resolve the descriptor inside that selected component's rules by its index or a unique GUID. When both are supplied, both must identify the same descriptor. GUIDs use the standard 36-character hyphenated hexadecimal form, accepting either case and comparing their canonical lowercase form. Ambiguous component GUIDs across driver/extensions and ambiguous descriptor GUIDs within the selected component are partial even when an index was also supplied.
- IDs do not locate metadata. After descriptor resolution, a supplied effective ID must equal the descriptor ID or add exactly one slash-delimited hierarchical component, including the empty component permitted by SARIF. A broad textual prefix or a match in another component is insufficient.
- Classification with metadata uses the resolved descriptor's exact ID js/insufficient-password-hash. A supported sub-rule of that exact descriptor is selected, but its suffix is never emitted. A descriptor named js with the target-looking text as a suffix is unrelated.
- Preserve existing bare ruleId-only and ruleIndex-only compatibility when result.rule is absent. Do not invent a descriptor by searching IDs. An explicit rule with neither an inherited index nor GUID remains partial; the no-metadata result form is the bare top-level ruleId. An explicit empty object with a valid inherited index is supported.
- Duplicate descriptor IDs alone are not ambiguous: an exact index can select one of them. Missing/malformed arrays, out-of-range/negative/fractional indices, invalid/missing GUID matches and conflicting fields produce partial, including for otherwise unrelated textual IDs.
- Ignore descriptive metadata and properties; never copy them to the report. Do not accept new external resolution mechanisms or search every component for a textual target ID.

The explicit metadata requirement follows the result-specific rule in SARIF §3.27.7 as well as §3.52.2. General id-only descriptor references used by notifications do not authorize an id-only result.rule without its required metadata locator.

## Resource and privacy invariants

Keep the existing 64 MiB input file ceiling, 1 MiB final encoded output ceiling, regular-file/no-follow read and original size/mtime checks, source Git/tree/checkout/run provenance, tracked regular-blob filtering, safe URI/base handling, immutable output creation and generic text-free failures.

Keep existing bounds unchanged: 16 runs, 10,000 visited results, 128 selected results, 512 flows, 1,024 threads and 4,096 visited locations. Invalid entries continue to consume the existing visitation budgets. Keep original run/result/flow/thread/location positions; do not renumber after filtering.

Add a separate internal ceiling of 10,000 first-visited component/descriptor slots across the whole collection. Lazy per-run/per-component lookup tables may reuse already inspected metadata, but repeated result references must not rescan unbounded arrays. Count malformed slots too. A GUID search must finish the relevant bounded array before uniqueness is established; finding a first match before budget exhaustion is insufficient. A budget hit produces partial, never complete or a guessed selection. This is an explicit bounded diagnostic policy, not a claim that the collector accepts every possible SARIF log.

Add only fixed omission counters: malformedRuleReference, unresolvedRuleReference, conflictingRuleReference, ambiguousRuleReference, ruleMetadataLimit and other. Their keys are source literals; values are counts only. Every existing incomplete() call defaults to other. Their sum equals counts.omitted. Include the same safe counters in the CLI summary so future partial reports distinguish causes without raw SARIF. Keep schemaVersion 1 with this additive diagnostic field; current consumers are only this script's tests and the workflow artifact/log path.

Do not output rule/component IDs other than the fixed target rule, names, GUIDs, raw selectors, notification text, messages, snippets, properties, fingerprints, secrets, absolute checkout paths, or raw SARIF fragments. Valid unrelated rules remain silent and do not visit their locations/flows or increment omitted.

## Finite RED and GREEN matrix

After this plan is reviewed and published:

1. Before production changes, run new finite positives against the unchanged collector: direct driver result.rule {id,index}; inherited index with explicit empty rule; extension-local index plus toolComponent index; GUID-only component and descriptor selectors. The intended RED is missing selected coordinates/status partial. Keep a bare legacy reference control passing.
2. Replace the blanket unsupported-rule test with separate valid-reference and invalid-reference tables; retain every genuinely malformed/conflicting case from the old table. Do not delete the negative coverage wholesale.
3. Cover agreeing and conflicting combinations of all provided top-level/nested IDs and indices; component index/name/GUID and descriptor index/GUID. Include null/array/primitive fields and missing metadata.
4. Cover unique GUIDs with mixed hex case, unknown and duplicated GUIDs, index/GUID disagreement, driver GUID versus extension GUID, and duplicate IDs with valid index selection.
5. Cover a same-ID driver/extension collision resolved only by the original component; supplied extension metadata must never silently fall back to driver metadata.
6. Cover exact target, one legal hierarchical suffix, empty final suffix, unrelated descriptor with target-looking text, excess hierarchy and ID conflict. Keep the emitted top-level ruleId constant.
7. Cover mixed target and valid unrelated explicit references. Unrelated rows have deliberately malformed/private locations to prove the collector does not inspect or emit their payloads; malformed unrelated identity still marks partial.
8. Inject the existing private sentinel into all newly considered metadata labels/properties and all existing message/snippet surfaces. Assert absence from JSON, stdout and stderr.
9. Exercise the metadata visitation boundary, invalid slots and repeated references without repeated full scans. Preserve all existing results/flow/thread/location cap tests and the 64 MiB file refusal.
10. Add a CLI fixture that exceeds the unchanged 1 MiB diagnostic limit using only tracked synthetic paths/coordinates; it must leave no artifact and print only the generic failure. Preserve changed-checkout, existing-output, symlink/gitlink, unsafe path/base and failed-analysis tests.
11. Assert fixed omission-counter keys, numeric values and sum equality; no input-controlled reason text. Valid unrelated-only files remain complete and empty.
12. Run the exact existing Node test file and standard formatting/source-size checks for these two files. No Host build, native account, Electron or full CodeQL scan is required for local parser qualification.

Root later assesses the next ordinary CodeQL workflow's diagnostic artifact. A locally passing resolver suite is not proof that all previously omitted records are now supported, or that the eight suspected security flows are resolved. Remaining partial reasons remain explicit.

## Scope, confidence and review

Estimated change: 130–190 substantive source lines plus 180–260 focused test lines; formatted files must remain below the existing source-size guard. No new helper file or state owner. Complexity 3/5: careful identity joins, small finite implementation. Confidence in the diagnosed incompatibility 5/5; confidence in this exact candidate before implementation 4/5. Reliability depends on the negative identity/budget/privacy matrix and subsequent real CI evidence.

R1: frontend_parity completed the source and primary-spec review.
R2: root independently checked the OASIS result, descriptor and component identity rules and approved the exact plan.
R3: frontend_parity repeated the contract and bounds review without changing the candidate. No production modification, runtime test PASS or compiler PASS is claimed for this collector task.

## Primary references

- OASIS SARIF 2.1.0, §§3.27.7, 3.52, 3.54; GUID/hierarchy syntax §§3.5.3–3.5.4: https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html
- Current approved Errata 01 text, same relevant lookup rules: https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
- Official CodeQL 2.5.5 changelog, rule references and grouped query-pack lookup: https://codeql.github.com/docs/codeql-overview/codeql-changelog/codeql-cli-2.5.5/
- Actual CI job: https://github.com/777genius/agent-teams-ai/actions/runs/46105391552/job/140856887529
