# Phase 0 normalized final gate

This gate is pinned to integration candidate `3bc0dfa7c00261785c0c752270cb302a9294e751`.
It makes the repository-wide TypeScript result actionable without changing or concealing the seven
inherited diagnostics present at that commit.

## Normalization contract

The allowlist records the exact file, line, column, TypeScript code, and complete message for each
inherited diagnostic. The evaluator consumes each allowlisted entry at most once. A removed
diagnostic is reported as resolved and is not a failure. A moved, changed, duplicated, global, or new
diagnostic is unexpected and fails the gate. Compiler crashes, unparsed output, signals, and exit
codes other than the TypeScript diagnostic exit (`2`) or clean exit (`0`) also fail.

The targeted configuration has five explicit roots: the three inherited-diagnostic tests, the
normalizer test, and the parity-renderer scanner test, together with their import graphs. It is the
fast iteration gate:

```text
bash scripts/hosted-web/phase-0/final-gate/run-normalized-typecheck.sh targeted
```

The milestone mode executes all three stages represented by `pnpm typecheck:workspace` in canonical
order: root, MCP source, and MCP tests. The known root diagnostics are normalized; both MCP stages
must exit cleanly. Each stage has a five-minute timeout and preserves its raw output independently:

```text
bash scripts/hosted-web/phase-0/final-gate/run-normalized-typecheck.sh milestone
```

Normalization does not edit the three inherited sources, weaken compiler options, add `skip` rules,
or turn an unknown failure into a pass. This work is gate-only and contains no Phase 1
implementation.

## Gate matrix

The completed commands, classifications, durations, and results are recorded in
`gate-matrix.json`. Fast checks are suitable for every edit. The broad workspace typecheck is a
milestone check and must not be used as the inner development loop.

`typecheck-evidence-reconciliation.json` records the explicit source classification for the inherited
baseline on the updated canonical commit. It proves that the three diagnostic-bearing source blobs,
root TypeScript configuration, and toolchain manifests are byte-identical to the prior observation,
then ties that continuity to a fresh targeted compiler observation. This evidence verifies the exact
seven inherited diagnostics; it is deliberately not a substitute for the one workspace milestone
run.

The reconciliation is re-derived with:

```text
bash scripts/hosted-web/phase-0/final-gate/run-reconciliation-check.sh
```

Milestone mode preserves all three raw compiler streams and the normalized report under this
directory. Every stage records its command, precise disposition (`exited`, `timeout`, or `signal`),
raw exit or signal, timeout, duration, output byte count, and SHA-256 digest. Timeout, signal, and
runner-error dispositions always fail and are never reported as ordinary exits. The production
runner's shell-level disposition fixtures are exercised with:

```text
bash test/architecture/hosted-web/phase-0/final-gate/run-normalized-typecheck.test.sh
```

The authorized candidate milestone was invoked exactly once with a 300,000 ms timeout per stage.
It passed in 218,250 ms of measured stage time: root exited `2` after 207,899 ms and reproduced the
exact seven inherited diagnostics, MCP source exited `0` after 4,362 ms, and MCP tests exited `0`
after 5,989 ms. The shell wall time was 219 seconds. All committed captures replace the candidate
checkout root with `<repo>`; they contain no producer-worktree or host-specific absolute path.
