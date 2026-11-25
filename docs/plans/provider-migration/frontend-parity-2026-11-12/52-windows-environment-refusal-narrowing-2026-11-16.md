# 52. Canonical narrowing for the existing Windows environment refusal

## Selected defect and exact source

The ordinary PR1192 aa01 Process Windows ARM64 job `133477580440`, run `43918080732`, stopped in its existing canonical compile group at 2026-11-16 17:48:18 UTC, before the native fixture scenarios. Its commands invoke `node node_modules/@typescript/native/bin/tsc`; no alternate compiler is selected. The seven diagnostics are in `src/features/agent-backend/main/infrastructure/matchesWindowsLaunchEnvironment.ts`: TS18046/TS2345/TS2322 at 110–114 for endpoint strings, two TS18046 at 204 for the local MCP command array, and TS2345 at 293/321 for the validated management witness.

The exact source blob is `8d3abd63b2098c33694f15e211f03753815aff81`, 371 physical lines, unchanged between aa01 and the current side `2c8633a355734a17f3447a7bc19cb548ecc91ba6`. Each diagnostic follows an existing guard whose refusal calls the same local never-returning arrow. The helper has an explicit arrow return annotation but the variable's function type is inferred. Give that existing variable an explicit function type so control-flow analysis can use the terminating call after those guards.

## One erased-type correction

Replace only:

```ts
const invalid = (): never => { throw new Error('Captured Windows environment mismatch'); };
```

with:

```ts
const invalid: () => never = () => { throw new Error('Captured Windows environment mismatch'); };
```

Both erase to the same JavaScript declaration and body. Keep the const binding, Error message, all callsites, property accesses, schemas, matching predicates and original fail-closed behavior exact. No casts, non-null assertions, repeated validation, input acceptance, policy derivation, timing, process/custody operation, return value or new test is selected. This is one changed line with zero net lines in one existing source file. Complexity 1/10; source-level runtime-preservation reliability 9/10; confidence in the narrowing diagnosis 9/10 pending the original compiler gate.

## Plan, review and acceptance

Publish and fully read back this plan before preparing the separate one-line source child. Root and an independent reviewer must compare the full preimage/postimage, confirm that removing their TypeScript annotations yields the same helper expression and that every other byte is unchanged, and verify that the seven original diagnostics are consistent with the single terminating-call narrowing issue. No local compiler or project execution is authorized. Source acceptance does not count as a successful canonical typecheck.

The file already belongs to the original Desktop common source roster and existing fast/typed lint selection. Add no workflow operand, source entry, compiler configuration, package version, dependency or duplicate test. The existing original configuration/environment admission tests remain unchanged; the original Process compiler group and native fixtures, full workspace/feature checks and relevant Desktop/package gates must run on the resulting source. Preserve the currently useful running aa01 native jobs and the original Windows readiness deadlines, source refusal/cleanup assertions and P09 oracle.

This plan's publication parent is the actual current continuation containing Plan50's amendment and incoming Plan51. Preserve their complete sources and documents, all Plans43–49 and P10 donor work. The prepared five-file Plan50 observer remains a separate selected cut; no stage observation is a latency fix. Publish each commit immediately with an expected-SHA ordinary update, reconcile any incoming work, and verify full parent/tree/leaf/mode readback. No manual CI action, Ready conversion, main merge, release, default activation, Stage2, or real Claude/Codex execution is selected. Owner decisions still unselected in Plan40 remain separate.
