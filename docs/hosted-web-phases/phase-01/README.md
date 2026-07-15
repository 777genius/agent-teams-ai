# Hosted Web Phase 1

Current authority is `phase-01-p1-i-lint-remediation-router-r1`; terminal state is `HOLD`.

## Accepted predecessor and current blocker

Formal P1.R2 evidence remains integrated and frozen with `ACCEPT` and P0/P1/P2 `0/0/0`. The current
clean remotely pushed canonical authority is `0d7f904abf2a3d4eaf7ba4e16ebd987d473535fe`.
Its full lint result has exactly one error at `src/shared/contracts/hosted/app-error.ts:29:65`, rule
`@typescript-eslint/no-unnecessary-type-assertion`. P1.I cannot begin while its required full-lint
gate is knowingly red.

## P1.I.LINT.REMEDIATION

The current packet is [`p1-i-integration.md`](lanes/p1-i-integration.md). It first authorizes one
serial product worker over exactly the safe-error source, focused safe-error test, and remediation
handoff. The worker removes only the redundant assertion, adds the focused `diagnosticId` safe-error
regression, runs every declared check, self-reviews, emits its strict result, and ends `HOLD`.

The required profile is model `gpt-5.6-sol`, reasoning effort `xhigh`,
`serviceTier: "default"`, with Fast prohibited. Root is the sole orchestrator and `controller-v17`
remains `HOLD` and observation-only.

After producer termination and immutable three-path output capture, root may admit exactly one fresh
independent reviewer under the same profile. `ACCEPT` allows root `mark_reviewed` and exact
three-path broker integration and push. `REJECT` allows no integration or successor launch and only
separately admitted remediation bounded to the same paths and findings.

## P1.I.INTEGRATION

After accepted remediation integration, exact pushed-authority attestation, clean remote equality,
and a fresh full `pnpm lint` exit `0`, root may launch the existing P1.I five-output producer directly
without another router. Its input count becomes 69: the frozen 68-path manifest evaluated at the
accepted remediation authority plus `.codex-handoff/phase-01-p1-i-lint-remediation.json`. The suite
expectation becomes 13/13 files and 60/60 tests; typecheck remains exactly seven inherited, zero owned,
and zero unexpected diagnostics. P1.I output ownership remains unchanged at five JSON paths.

P1.F, Phase 2+, unrelated product workers, controller replacement, and successor controllers remain
blocked. See [`execution-dag.md`](execution-dag.md).
