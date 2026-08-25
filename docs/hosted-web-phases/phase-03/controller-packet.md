# Phase 03 controller packet: actual-owner closure

## Status and authority

- Status: `active-no-fake-e2e`.
- Packet revision: `phase-03-actual-owner-closure-r3`.
- Product authority: exact `phaseStartSha` injected by `ProjectScopedControl`.
- Product PR: `777genius/agent-teams-ai#252`.
- Orchestrator PR: `777genius/agent_teams_orchestrator#44`.
- OpenCode candidate: `777genius/opencode-anomaly#4`.
- Terminal state: `HOLD` for every node.

The controller may admit only `P3.C.NO_FAKE_E2E` now. Its completion-acceptance gate remains false:
the worker cannot authorize its reviewer, coordinated activation, production eligibility, or a
successor.

## Accepted predecessor evidence

All rows are immutable inputs, not permissions to change their repositories or gates.

| Node/input | Exact evidence | Disposition |
| --- | --- | --- |
| P3.A + P3.RA product | `777genius/agent-teams-ai#252` at `d71671599c062244767494d392575cfacba5e1ff`; P3.A/RA P0/P1/P2 `0/0/0`; in-scope CI green | accepted |
| P3.B orchestrator | `777genius/agent_teams_orchestrator#44` at `06e5dd89aee920c6e3ecd8ff0efbfcf5135021b7`; independent O3 P0/P1/P2 `0/0/0`; 41/41 focused tests; build and exact-head CI green | accepted |
| Current production OpenCode lock | unchanged `opencode-hosted-runtime.lock.json`: `v1.18.4-agentteams.1`, source `476b667c385210b19fbd15bcb57456cacb0ae9e7`, Linux x64 binary SHA-256 `7858adb4fdf140d7a3bc0a982e559418482333feb9b3d75389d25a0828a8a32d` | authoritative; `productionEligible=false` |
| OpenCode candidate | `777genius/opencode-anomaly#4` at `fe07feb2f6c1a1d58ffb65d2f269c8fb3de4ca8f`; run `32784750815`; artifact `9541196940`; ZIP SHA-256 `601e3bf7713ff4180d449cc788e6000a2b706fb01f7cd11647379ab45c004b0c`; Linux x64 SHA-256 `4947f69d85d491b5f73ef1c9306a5ef69c2991800fbd40f05f2b15a53f57299e` | sandbox candidate only; `productionEligible=false`; does not supersede the production lock; cannot activate production |

## Required outcome

Materialize and later execute one thin activation-v2 no-fake harness port. It must use the production
product composition, the orchestrator's actual approval owner, and the exact built OpenCode candidate
to prove `MVP request -> durable pending -> authenticated browser decision -> actual owner/OpenCode
delivery -> reconciliation`. The implementation starts from behavioral extraction from preservation
branch `test/hosted-actual-owner-harness-r4`; a merge, cherry-pick chain, or wholesale roughly
8.7k-line copy is rejected.

## Definition of Ready

All conditions are conjunctive:

1. separate isolated product and orchestrator worktrees are clean at exact
   `d71671599c062244767494d392575cfacba5e1ff` and
   `06e5dd89aee920c6e3ecd8ff0efbfcf5135021b7`, respectively;
2. the packet revision, phase, lane, ownership, docs and checks equal the immutable worker-launch
   contract;
3. no other writer owns a declared path;
4. the private canonical ZIP for artifact `9541196940`, its immutable signed attestation, and its
   immutable manifest are supplied at distinct canonical private absolute paths; signature, fields,
   manifest/ZIP/executable digests and all fixed identities match before secure empty-root extraction
   and before any process starts, with no network re-download;
5. product, orchestrator, and OpenCode production eligibility gates all remain false;
6. the controller supplies one new empty private sandbox parent and one disjoint private evidence
   parent;
7. the immutable worker contract binds the controller-private canonical toolchain roots, signed
   toolchain manifests, empty build/cache/temp roots, and content-addressed offline production
   dependency store used by the two `run.ts` recipes; these are not caller CLI/environment inputs; and
8. no real provider identity/data, ambient auth, user project, shared runtime state, or home data is
   present in the child environment.

Before staging, the runner itself must build both product and orchestrator in those fresh isolated
exact-commit worktrees. Its only build selectors are the controller-owned, versioned, commit-scoped
recipe IDs `product-standalone-d71671599c062244767494d392575cfacba5e1ff-v1` and
`orchestrator-cli-06e5dd89aee920c6e3ecd8ff0efbfcf5135021b7-v1`, whose definitions future `run.ts`
owns. Caller-provided build argv, executable, environment, output and closure choices are invalid.
Each recipe hard-codes executable/version/SHA-256, signed toolchain-manifest and lockfile digests,
minimal allowlisted environment, ordered direct no-shell argv steps, declared output/closure roots,
and permits substitution only of controller-owned canonical private absolute roots.

The product recipe directly implements both ordered Vite steps from the accepted `standalone:build`.
Its complete closure covers source-authoritative `out/renderer`, `dist-standalone`, exact root package
metadata and the full production dependency tree—including native and `agent-teams-controller`
runtime bytes—required by `docker/Dockerfile`. The orchestrator recipe directly runs accepted
`bun run build`; its complete closure covers tracked `cli` plus all regular files under
`dist/local-cli`, and proves the wrapper selects `dist/local-cli/cli.js`.

Every build output, dependency assembly, extraction and staging/closure root starts absent. Recursive
walks are anchored descriptor-relative with `O_NOFOLLOW`; every regular file has `nlink=1`, is
`fstat`-stable, and is hashed and copied from the same already-open descriptor. Complete
UTF-8-bytewise sorted normalized path/mode/size/SHA-256 manifests produce deterministic manifest and
Merkle digests; independent rewalks reject missing, extra or undeclared output. Accepted HEAD,
tracked source and index integrity, and pinned source/lock/toolchain digests are revalidated after
build and immediately before staging. The same discipline verifies attestation, manifest, ZIP and
securely extracted OpenCode executable. A prebuilt entrypoint or caller-authored digest list is not
alternate provenance.

## Ownership

The exact initial writable paths are only those listed for `activeLane.ownedPaths` in
[EXECUTION_INDEX.json](../EXECUTION_INDEX.json). All other paths are read-only. They are harness,
fixture, and focused-test paths only; no production source, dependency/lockfile, workflow, runtime
lock, release manifest, or other repository is writable. A needed undeclared edit is
`packet_conflict` and returns `HOLD` for controller re-packetization.

The required `.codex-handoff/phase-03-p3-c.json` is a worktree-local control-plane artifact exception,
not a repository-owned lane path and not part of the commit/diff scope. Producing it may not modify,
stage, or add another repository path; its contents are reporting evidence only and confer no
successor authority.

This packet only declares the future lane-owned `run.ts`; no such implementation exists in this
documentation-only materialization.

## Acceptance

Acceptance is the complete positive chain plus the bounded negative, restart, replay, socket,
capability, cross-team, ambiguity/reconciliation, and cleanup matrix in the lane packet. Every case
uses the same single fresh marker-owned project, distinct correlation IDs/nonces, and durable
evidence. Ambiguous provider settlement becomes terminal `operator_required` with a stable
`reconciliationRef`; normal delivery never retries it. Only explicit reconciliation may classify
`delivered` or `not_delivered`, and only `not_delivered` permits a new pending lease.

The exact declared checks, exact-path proof, secret/private-path scan, and a complete authority/race/
scope self-review are required. No production gate changes from false.

## Successor policy

After P3.C returns `HOLD`, one fresh independent architecture/security reviewer reruns all
deterministic checks, validates the retained evidence, and reviews the exact tree. ACCEPT requires
P0/P1/P2 `0/0/0`. That disposition is only an input to a newly materialized P3.F packet.

Production activation remains a final coordinated product/orchestrator/manifest change. Any head,
artifact, manifest, socket, authority, sandbox, matrix, cleanup, or evidence mismatch returns `HOLD`.

## OpenCode convergence guard

The OpenCode downstream is not a separate product line. It is a temporary 17-file atomic-approval
patch queue over an exact upstream release plus reproducible artifact evidence. Upstream releases are
tracked daily; every stable/security update triggers a port-and-verification lane. The patch is
removed when upstream supplies equivalent atomic conditional reply or a safe plugin boundary. See
[the downstream policy](../../hosted-opencode-downstream-policy.md).
