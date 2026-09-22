# Phase 0A baseline

## Reproduction envelope

- Repository: `https://github.com/777genius/agent-teams-ai.git`
- Pinned base: `cbe501ad0f1fa0e51a038e832ad35fce4120321b`
- Tested integration: `c1b8e3fe69e1c05ad94ec0c0301def25c8a464b5`
- Packet: `phase-00-r2`
- Node: `24.16.0`
- pnpm: `10.33.4`
- Host: Ubuntu 24.04.4 LTS, Linux `6.8.0-124-generic`, `x86_64`
- Lockfile SHA-256: `2132ffb086bc3c75b94f1ae3eabca9640c342b4e084742710e53f46fabf111b0`
- Dependency preflight: `ready`, fingerprint
  `2c5340064d9a9856cbc8963519448f43db448d2f03141788bad88252b88a21f7`
- Dependency cache: `/var/data/agent-dependency-cache/agent-teams-hosted-web-refactor-45ab8b8b5f8e`

The frozen/offline materialization command was:

```text
pnpm fetch --frozen-lockfile --store-dir /var/data/agent-dependency-cache/agent-teams-hosted-web-refactor-45ab8b8b5f8e/pnpm-store && pnpm install --offline --frozen-lockfile --store-dir /var/data/agent-dependency-cache/agent-teams-hosted-web-refactor-45ab8b8b5f8e/pnpm-store
```

The preflight found `node_modules` plus `eslint`, `tsc`, and `vitest`, and the lockfile remained
unchanged.

## Captured broad gate

Command:

```text
pnpm check:ci
```

Result: exit `1`, duration `2211s`, completed `2026-07-11T17:08:58Z`.

The command expands to:

```text
pnpm check:workspace:ci && pnpm lint && pnpm lint:mcp
```

`check:workspace:ci` completed successfully before full lint ran. Its stages were:

| Stage | Result | Evidence |
| --- | --- | --- |
| `pnpm typecheck:workspace` | passed | Root TypeScript, MCP source and MCP test typechecks all advanced to the next stage. |
| `pnpm test:workspace:ci` | passed | Root: 1,105 files and 11,421 tests passed; 22 files and 49 tests skipped. Controller: 4 files/134 tests passed. MCP: 2 files/43 tests passed. |
| `pnpm build:workspace` | passed | App, controller and MCP builds completed; renderer build reported `built in 1m 10s`. |
| `pnpm --filter agent-teams-mcp test:e2e` | passed | 2 files/18 tests passed. |
| `pnpm lint` | failed | 2,947 findings: 5 errors and 2,942 warnings. |
| `pnpm lint:mcp` | not reached | Shell short-circuit after root lint failure. This is not an MCP E2E failure. |

External evidence retained by the controller:

- `/var/data/agent-teams-hosted-web-refactor/control/evidence/phase-00-check-ci.log`, SHA-256
  `78efb84ac4cc055f36fbe14a5ce481517b6193f5cea3b883e20401ec260cf0fa`
- `/var/data/agent-teams-hosted-web-refactor/control/evidence/phase-00-check-ci.result`, SHA-256
  `e0663fb85588bba536c90f09908dea9ebb2c10cc44b973ae765cc8be639fc1ce`

## Packet command coverage

The packet lists five baseline commands. This evidence does not pretend that nested or adjacent gates
are identical when they are not.

| Packet command | Captured status | Duration/final-tail status |
| --- | --- | --- |
| `pnpm typecheck:workspace` | passed as the first nested `check:ci` stage | No independent duration or separate final-20 capture. |
| `pnpm lint:fast` | not separately run for this record | Not available; the user prohibited another broad/long run. |
| `pnpm test:workspace:ci` | passed as a nested `check:ci` stage | Counts are recorded above; no independent duration. |
| `pnpm standalone:build` | not run in the supplied baseline | `build:workspace` passed, but is not relabeled as this artifact-specific gate. |
| `pnpm check:ci` | failed only at full root lint | Exit `1`, `2211s`; controller log and result hashes are recorded above. |

Consequently this is reproducible baseline evidence, not a claim that every 0A.4 command was separately
green. `lint:fast` and `standalone:build` remain explicit prerequisites for the controller before it
admits dependent lanes if it requires literal 0A.4 closure.

## Inherited failure ledger

Both failing source paths are byte-identical between the pinned base and the tested integration. Git
blame places the offending lines in commits already contained by the base. The five errors therefore
form two `base_owned_fix` records; none is `unknown` or caused by the plan/evidence bundle.

| Failure ID | Command | Exit | Classification | First-known-bad evidence | Affected package/path | Owner | Isolation/fix and rerun evidence |
| --- | --- | ---: | --- | --- | --- | --- | --- |
| `P0A-LINT-001` | `pnpm lint` | 1 | `base_owned_fix` | `defd86eb43b479ab9e4a6c8d0fbd0328762f3922` owns lines 336-339 at the pinned base. | `src/main/services/team/contracts/__tests__/TeamProvisioningApis.test.ts:336` | Base prerequisite, job `agent-teams-hosted-web-refactor-phase-00-lint-contract-test-v2` | Four `@typescript-eslint/no-unnecessary-type-assertion` errors. Narrow reviewed output removes only the four assertions; type-aware ESLint passed with zero errors and targeted Vitest passed 13/13. Adoption and broad rerun remain controller-owned. |
| `P0A-LINT-002` | `pnpm lint` | 1 | `base_owned_fix` | `3a93ce54aab0f21db0e8c9bfbb45033def875afd` owns line 193 at the pinned base. | `src/main/services/team/provisioning/TeamProvisioningToolApprovalTimeouts.ts:193` | Base prerequisite, job `agent-teams-hosted-web-refactor-phase-00-lint-approval-timeout-v2` | One `sonarjs/no-try-promise` error. A narrow prerequisite must preserve timeout/rejection semantics, pass focused tests/type-aware lint, be adopted separately, and then rerun the broad gate. |

The 2,942 warnings are diagnostic debt but did not determine the nonzero exit. No evidence here accepts
new warnings or authorizes broad formatting/fixing.

## Classification conclusion

- `base_blocker`: 0
- `base_owned_fix`: 2 records / 5 lint errors
- `isolated_known_failure`: 0
- `environment_failure`: 0
- `unknown`: 0

The captured `check:ci` failure is solely the five inherited/base-owned lint errors. Workspace tests,
workspace builds and MCP E2E passed. No product code, package file, test, packet or Git state was
changed while producing this record.
