# Preserve canonical receipt types in the original Windows Stop fixture

## Observed failure and selected scope

The original process-fixture job [133345780341](https://github.com/777genius/agent-teams-ai/actions/runs/43880785353/job/133345780341), on app head `17a39219266a7b468bc357380cc319694a7c7181`, failed during the canonical TypeScript 7 build before process execution. It reported TS7022 for `found` at line 421 and `candidate` at line 423 of `tools/owned-process-broker/nativeWindowsAppFixture.ts`. This does not establish a Darwin runtime failure.

Select one existing source path, preimage `78486e24742278c6f803607e02e1601329e505a0`: explicitly annotate the filtered array as `ProcessCommandReceipt[]` and its first element as `ProcessCommandReceipt | undefined`, using the existing canonical import. The receipt validator already declares that return type. Preserve the empty-poll branch and every existing completed/observed-absent/settlement confirmation check.

Estimate: two changed source lines, zero new executable lines; file remains 491 lines. Complexity 1/10, reliability 9/10, confidence 9/10 for this type-only correction, pending canonical compilation. No new abstraction, test suite, import, assertion, cast, suppression, dependency or source-size allowance is selected.

## Review and proof

R1 and independent R2 read the exact original source and canonical receipt/validator types. The proposed source blob is `8b0842abf55362dfd2223d042f423db447881794`. Removing just the two annotations restores every original byte. Root additionally parsed both inert source texts with Node 24.22.1 `stripTypeScriptTypes` in transform mode and obtained byte-identical JavaScript (36,474 bytes). This is syntax/type-erasure evidence, not TypeScript type checking or fixture execution. A prior plain `node --check` invocation rejected TypeScript syntax and is not counted as a passing check.

The original operation order, deadlines, custody checks, Stop semantics and cleanup remain identical. No behavioral regression test is added for erased annotations. The original canonical TypeScript 7 and E2E gates must qualify the resulting source; the earlier failed job is retained.

## Delivery and remaining acceptance

Compose on the current continuation parent after preserving all incoming work, including `91a52ab4299956e5b5e5dc3998892f780831cc8a` and its finite-membership Error preservation/lint correction. Publish this plan before the one-file source child and push each commit immediately with an expected-parent check. Preserve useful current CI jobs before advancing the primary PR branch.

The app remains Draft on its original base. Windows readiness/Retry, Linux credential-close, current C8/BOOT, original P09 and other open acceptance are not declared fixed by these annotations. The user restriction on real Claude/Codex execution, the original checks and budgets, and the current Stage 1 scope remain in force.
