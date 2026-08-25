# Phase 03 execution DAG

Status: `active at P3.C only`; terminal state: `HOLD`.

```text
PR252.CORE_HEAD.GREEN
          |
          v
P3.A.PRODUCT_BINDING       ACCEPTED at product d71671599c062244767494d392575cfacba5e1ff
          |
          v
P3.RA.PRODUCT_REVIEW       ACCEPTED P0/P1/P2 0/0/0; in-scope CI green
          |
          v
P3.B.ORCHESTRATOR_INTEGRATION
          |                ACCEPTED at 06e5dd89aee920c6e3ecd8ff0efbfcf5135021b7
          |                O3 0/0/0; 41/41 focused; build and exact-head CI green
          v
P3.C.NO_FAKE_E2E           one fresh marker-owned sandbox; runner-built exact-commit bytes;
          |                sandbox-only PR4 candidate; completion/production/successor gates false
          |
          v
P3.F.COORDINATED_ACTIVATION
                           product + orchestrator + manifest gates change together
          |
        HOLD
```

Only `P3.C` is currently materialized as an active lane packet. `P3.A`, `P3.RA`, and `P3.B` are
accepted immutable predecessors. `P3.F` requires accepted exact-head P3.C evidence and a new
controller packet; it is not materialized or launchable. No node launches its successor.

The OpenCode PR #4 candidate does not replace the current production lock and cannot activate
production. P3.C excludes ReviewRouter and real provider identity/data. Its required handoff is a
worktree-local control-plane artifact outside repository ownership and commit scope.

Product and orchestrator inputs have no prebuilt alternative: the future runner verifies separate
clean exact-commit worktrees and accepts only controller-owned versioned commit-scoped recipe IDs
defined in `run.ts`. Recipes pin toolchain/lockfile identities, sanitize the environment, execute
ordered direct argv without a shell, and start with absent output/closure roots. Complete recursive
descriptor-relative manifests and Merkle roots cover the product standalone renderer/server plus
Docker production dependencies, and orchestrator tracked `cli` plus `dist/local-cli`; missing, extra,
linked, escaped or changed files fail. HEAD and tracked source/index are checked after build and before
staging. OpenCode requires its private canonical ZIP, signed attestation and manifest, then secure
empty-root extraction with all fixed identifiers independently verified and no download. That runner
is only a declared future owned path in this documentation packet; `run.ts` does not yet exist.

Parallel support is allowed only for read-only auditing of preserved WIP and CI evidence. It cannot
write a P3 path, count as product completion, or supply release evidence. Cross-repository work uses
isolated worktrees and explicit ownership.

The E2E node must never use an existing user project. It creates and marks its own sandbox, proves
canonical containment before every effect, performs narrow marker-checked cleanup, and reports any
residual instead of broad process/path cleanup.
