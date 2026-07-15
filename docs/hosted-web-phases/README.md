# Hosted Web execution router

> Current route: `phase-01-p1-i-lint-remediation-router-r1`, authored at canonical
> `0d7f904abf2a3d4eaf7ba4e16ebd987d473535fe`. It inserts exactly one serial
> `P1.I.LINT.REMEDIATION` product lane before `P1.I.INTEGRATION`, followed by exactly one fresh
> independent remediation reviewer. Every admitted worker uses `gpt-5.6-sol`, `xhigh`, and
> `serviceTier: "default"`; Fast is prohibited. This transition launches nothing and ends `HOLD`.

Always begin with [`START_HERE.md`](START_HERE.md). Machine-readable authority is
[`EXECUTION_INDEX.json`](EXECUTION_INDEX.json). Current execution contracts are
[`controller-packet.md`](phase-01/controller-packet.md) and
[`p1-i-integration.md`](phase-01/lanes/p1-i-integration.md).

## Why the prerequisite exists

Canonical full lint has exactly one error and no second lint finding:

```text
src/shared/contracts/hosted/app-error.ts:29:65
@typescript-eslint/no-unnecessary-type-assertion
```

Launching the existing P1.I producer before removing that assertion would make its mandatory full
lint gate fail. The remediation therefore owns only the safe-error source, its focused contract test,
and one handoff. The semantic edit is only removal of the redundant assertion. The test addition must
prove `diagnosticId` preservation and the frozen, known-field-only safe-error result.

## Serial lifecycle

After this router is independently accepted, broker-integrated and pushed, root attests its exact
pushed authority and starts one remediation producer. The producer runs the focused test, full lint,
frozen typecheck baseline, exact Prettier, diff/scope/scans, and self-review, then returns `HOLD`.

Exactly one fresh independent reviewer follows. `ACCEPT` with P0/P1/P2 `0/0/0` allows root
`mark_reviewed` and broker integration/push of exactly the three remediation paths. `REJECT` allows
no integration and no P1.I launch; only bounded same-three-path remediation against the immutable
findings may be separately admitted.

After accepted integration, root binds the new broker-returned pushed authority, proves the exact
three-path integration and clean remote equality, and reruns `pnpm lint` at zero. The existing
five-output P1.I producer may then launch directly without another router. It consumes 69 read-only
inputs: the 68-path Phase 1 manifest at the accepted remediation bytes plus the remediation handoff.
The added focused test raises the full Phase 1 exact count from 59 to 60; the 13-file count is
unchanged.

P1.F remains blocked until a later separately reviewed transition after accepted P1.I integration.
Phase 2+, unrelated nodes, controller replacement, and successor controllers remain blocked.
