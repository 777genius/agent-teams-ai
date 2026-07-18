# Phase 2 controller packet: identity and read truth

## Status and authority

- Status: `candidate-awaiting-independent-root-review`; product state `blocked`.
- Packet revision: `phase-02-jit-router-r1`.
- Router base SHA: `d5afa87e79b1f2badd69e65262e5699c0fb61de7`.
- Accepted predecessor: `P1.F`, disposition `ACCEPT`, findings P0/P1/P2 `0/0/0`.
- Predecessor integration commit: `d5afa87e79b1f2badd69e65262e5699c0fb61de7`.
- Router review and integration: `unverified`.
- Terminal state: `HOLD`.

The only current next action is independent root review followed, on acceptance, by broker integration
of the exact 12 router paths. No product admission occurs before the integrated router bytes become
canonical authority.

## Outcome and non-goals

The wave first replaces synthetic-only identity assumptions with the small identity foundation. After
that foundation is independently accepted and integrated, exactly five disjoint product lanes produce
the workspace-identity, team-identity, workspace-binding, roster-identity and legacy-adoption slices.
The wave is read-only from hosted transport and does not claim the full Phase 2 exit.

Non-goals are hosted mutation, authentication, public transport exposure, process/provider launch,
terminal or PTY behavior, broad TeamsAPI parity, unrelated cleanup, dependency upgrades and real
project verification. Draft create/delete remain later desktop/test work and are not smuggled into
this read wave.

## Definition of Ready

All conditions are conjunctive:

1. this router's exact 12 paths have an independent root `ACCEPT` with no unresolved P0/P1 finding;
2. the broker has integrated and activated those exact reviewed bytes;
3. current authority equals the activated router authority and the worktree is clean;
4. the assigned packet revision and exact writable paths match
   [EXECUTION_INDEX.json](../EXECUTION_INDEX.json);
5. the predecessor `P1.F` handoff and review remain accepted and unchanged; and
6. the controller admits only the next legal DAG node.

Until all six hold, product work is blocked. Conditional packet text is not admission.

## Architecture contract

Apply Clean Architecture, DDD and SOLID:

- contracts contain browser-safe values and validation;
- domain owns identity and registration invariants;
- application use cases depend on narrow ports;
- filesystem, SQLite, legacy services, IPC, HTTP and Electron are adapters;
- composition alone selects adapters; and
- each source has one bounded reason to change and interfaces expose only what a use case consumes.

The canonical Phase 2 team-lifecycle API facet is transport-neutral: no Electron callback/event,
Fastify request/reply, HTTP status, IPC channel, raw filesystem path or legacy team name crosses its
contract. Existing Electron-shaped `TeamsAPI` remains a compatibility boundary; adapters map it to
canonical IDs without importing it into core. Do not introduce an all-parity mega-interface.

Runtime services own only execution, materialization, admission, evidence and integration primitives.
The controller documents own orchestration: DAG order, capacity, dependencies, reviewer roles,
replacement/retry decisions and successor authorization. Runtime observations never invent product
authority.

## Capacity and review policy

There are two product epochs:

1. one short `P2.F0.IDENTITY` foundation slot; then
2. after accepted foundation integration, exactly five concurrent product slots `P2.A`-`P2.E`.

A product slot requires declared product-source edits, focused tests and a handoff. Documentation,
research and evidence workers never count as product capacity and cannot satisfy a product node.
Architecture/security reviewers, integration actors and milestone reviewers are also non-product roles.
A replacement reuses the same lane ID and explicitly supersedes the failed attempt; it cannot create
an additional lane.

Every producer performs its own scope, architecture, security and test self-review. There is no
separate per-lane code-review node. Separate reviewers are authorized only for combined
architecture/security gates, integration and milestone decisions. Reviewer independence and accepted
bytes must be recorded; all decisions end on `HOLD`.

## Ownership and legal parallelism

`P2.F0.IDENTITY` exclusively owns its five paths in the execution index, including the only parallel
wave predecessor allowed to edit the shared hosted-contract export. `P2.A`-`P2.E` own the exact,
pairwise-disjoint paths in their packets. They own no `index.ts`, barrel or composition file.

All undeclared paths are read-only. Ownership overlap, a needed undeclared edit or a need for one
lane's unintegrated output is `packet_conflict`; stop and hand back `HOLD`. Do not coordinate an
informal shared edit. Shared exports, internal-storage registration, hosted composition, IPC/HTTP
wiring and renderer-client wiring are reserved to the later serial `P2.I.INTEGRATION` list in the
execution index.

## DAG admission

The legal sequence is:

`router integration -> F0 -> R0 architecture/security -> IF foundation integration -> {A,B,C,D,E}
-> R1 architecture/security -> I integration -> F milestone`.

No node may infer acceptance from a producer's `verified` result. `P2.A`-`P2.E` may consume only the
accepted integrated foundation, never a sibling worktree or handoff. The controller admits all five
only when the five exclusive slots and sufficient host budget are available; otherwise it admits a
subset without replacing the fixed DAG or counting support work as missing product capacity.

## Review and integration node contracts

The execution index is the exact ownership authority for these non-product nodes:

- `P2.R0.ARCH_SECURITY` reads the F0 packet, handoff and complete changed paths; replays F0 checks and
  reviews identity derivation, dependencies, scope and scans. It writes only
  `docs/research/hosted-web/phase-2/reviews/foundation-architecture-security.md` and
  `.codex-handoff/phase-02-p2-r0.json`. ACCEPT requires compatible opaque identity with complete
  producer self-review and no unresolved P0/P1 finding.
- `P2.IF.INTEGRATION` reads accepted F0/R0 bytes and evidence, reconciles hashes, performs a clean
  materialization/integration attempt and replays the F0 checks at integrated authority. Accepted F0
  and R0 paths must remain byte-identical; it additionally writes only
  `docs/research/hosted-web/phase-2/foundation-integration.json` and
  `.codex-handoff/phase-02-p2-if.json`.
- `P2.R1.ARCH_SECURITY` reads all five packets, handoffs and complete diffs plus foundation integration
  evidence. It replays lane checks and proves pairwise ownership, sibling independence, safe-root
  admission and transport neutrality. It writes only
  `docs/research/hosted-web/phase-2/reviews/parallel-wave-architecture-security.md` and
  `.codex-handoff/phase-02-p2-r1.json`. ACCEPT requires exactly five self-reviewed disjoint lanes and
  no unresolved P0/P1 finding.
- `P2.I.INTEGRATION` reads only accepted A-E/R1 bytes and foundation evidence. It materializes accepted
  bytes unchanged, owns the exact reserved shared paths in the index, runs the union of focused checks
  plus IPC/test-HTTP conformance, and writes its exact handoff and integration report. It accepts only
  a clean integration with hosted mutation still absent.
- `P2.F.MILESTONE` reads the complete integrated wave, P2.I evidence and P1.F predecessor evidence,
  then freshly replays the integrated checks and reconciles hashes, scope, architecture, security and
  deferred claims. It writes only `docs/research/hosted-web/phase-2/reviews/phase-2-jit-wave.md` and
  `.codex-handoff/phase-02-p2-f.json`; it never edits product source or authorizes a successor.

Each node writes a packet-standard handoff with exact reads, checks, acceptance result and
`terminalState: HOLD`. Rejection also remains `HOLD` and returns only the smallest controller action.

## Required evidence and checks

Every producer handoff contains:

- authority/base and packet revision;
- exact declared and changed paths;
- focused positive and named negative test results;
- `pnpm lint:fast:files` for changed TypeScript;
- `pnpm typecheck` with inherited diagnostics explicitly classified;
- exact-path Prettier, `git diff --check`, scope diff and secret/private-path scan results;
- a complete diff self-review with Clean Architecture/DDD/SOLID and transport-boundary conclusions;
- evidence proof levels, unverified claims, findings and blockers; and
- the smallest next controller action plus `terminalState: HOLD`.

Filesystem adapters use only fresh marker-owned temporary project/runtime roots. Admission rejects
unmarked, pre-existing, ambient, home, real-project and symlink-escaped roots before any access.
Cleanup is narrow and marker-checked. `P1.NEG.TEST_ROOT_ESCAPE` must be positively discharged by the
Phase 2 filesystem lanes, never waived because another lane happened to finish first.

## Acceptance gates

### Foundation gate

The foundation is small, product-source real, compatible with Phase 1 and proves opaque cross-kind
identity validation. An architecture/security reviewer must accept it, then a distinct integration
actor must integrate and activate the accepted bytes before any parallel lane starts.

### Parallel wave gate

Each lane must satisfy its packet without touching a sibling or reserved integration path. The
combined architecture/security review rejects dependency inversion, unstable or name-derived IDs,
unadmitted roots, unsafe identity publication, raw path leakage, transport coupling, hidden hosted
mutation or unsupported parity claims.

### Integration gate

The serial integrator consumes only accepted lane handoffs, reconciles exact hashes, owns all shared
exports/composition and runs the union of focused tests plus IPC/HTTP semantic conformance. A clean
integration attempt, scope proof, negative controls, typecheck classification, fast lint, Prettier,
`git diff --check` and classified scans are required. Integration returns `HOLD`; it cannot launch a
milestone reviewer or a successor on its own.

### Milestone gate

A fresh milestone reviewer evaluates the integrated authority and records ACCEPT or REJECT without
editing product source. Phase completion, later Phase 2 work or public exposure remains unverified
until that evidence is separately integrated and activated.

## Stop conditions and handoff

Stop on stale authority, path overlap, missing predecessor, unclassified inherited failure, unavailable
safe test topology, a falsified architecture/security assumption, real-project pressure, secrets or
any need for product terminal/provider/process behavior. Do not commit, push, integrate, launch or
silently expand scope.

All producer, review, integration and milestone handoffs are strict `HOLD`. A success handoff requests
only the next node named in the DAG; a blocker names the failed predicate and smallest controller
decision. No handoff claims its own independent acceptance, integration, push, remote equality or
successor launch.
