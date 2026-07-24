# P2.R1 parallel-wave architecture and security review

Disposition: ACCEPT

Finding counts: P0 0 / P1 0 / P2 0.

Terminal state: HOLD.

## Authority, independence, and immutable input

This is an independent combined architecture/security review of the five broker-approved Phase 2
parallel lanes P2.A through P2.E. The reviewer did not produce or repair any lane, used no subagent
or additional reviewer, and changed none of the 35 aggregate product, test, or producer-handoff
paths.

The reviewed worktree HEAD is the required canonical base
`bd6ac038c920180ee5398b96f2dbdc3d6f035e77`. The broker aggregate is 531,340 bytes with ordered
SHA-256 `d4f80a5c60f9fc7925ccaeb4480cf4349bc3d267d71e76413d3f4b41b402fade`; its provenance SHA-256 is
`172f0a87e6607d1a9fe2f88d57ccdb9644049250a938502d41b2910a11f97d3f`. The independently
recomputed hash of the materialized staged Git diff is
`a322c6c8312ca9163b7e4578bc0b8cb59239b8cc0e443edaf6b81e00a42d1468`, matching the broker's
pre-start admission receipt. The aggregate artifact and the staged reconstruction are separate
canonical encodings, so their hashes are intentionally recorded separately.

The canonical navigation, current Phase 2 controller and execution DAG, all five lane packets and
handoffs, the complete 13,738-line aggregate patch, every current version of the 35 changed paths,
the full diff of the one modified pre-existing path, and the foundation integration evidence were
read. The accepted identifier foundation bytes remain the recorded
`73978dd8871f3af363810b9a90b4a42b464982a25898eac082677b9557d1dc41` identifier module and
`a11b722edd3a9fb1b4ea451bbbf2f01703a93897515092ceefc6bef5157bbac2` hosted-contract entrypoint.
No authority, base, dependency, or packet-revision mismatch was found.

## Five-lane validity and ownership proof

The broker provenance declares exactly five ordered reviewed outputs:

| Lane | Reviewed output ID                                                 | Paths | Producer self-review | Findings |
| ---- | ------------------------------------------------------------------ | ----: | -------------------- | -------- |
| P2.A | `58ac7a2cf712aec3254f8184ce6217def09a3b3200e0921f726a4f2f902b75f6` |     5 | complete, HOLD       | 0/0/0    |
| P2.B | `684bd31df38eaba57259ead6003a8596d37442bd58fc797961d51b2a2395d21d` |     5 | complete, HOLD       | 0/0/0    |
| P2.C | `349546a6232433cc96381f109cfd24996230b23b2a99c36fec6a52843adc9d09` |     8 | complete, HOLD       | 0/0/0    |
| P2.D | `ba27e423827f9923b48157338dafbe2765a6ec405c9dc8ba2bf747fe46e8c47f` |     7 | complete, HOLD       | 0/0/0    |
| P2.E | `e3e56150f4fe8eed39c0504011ffb44d3b17610324420c5d2fb3394b34a5b2b7` |    10 | complete, HOLD       | 0/0/0    |

The lane cardinalities sum to 35 and the union contains 35 unique paths. All ten pairwise
intersections are empty. The five producer handoffs have the exact canonical base, report `status`
as `verified` and `terminalState` as `HOLD`, contain complete self-review fields and empty blocker
arrays, and record zero P0/P1/P2 findings.

Sibling independence is also proved semantically, not only by path arithmetic. No aggregate path is
a shared feature barrel, bootstrap, composition root, Electron/preload/renderer surface, IPC/HTTP
route, or provider integration. Product import inspection found no lane consuming another sibling's
implementation output. P2.D depends on its own application ports plus the accepted identifier
kernel, not P2.B/P2.C implementation source; P2.E's internal read use cases and adapter depend only
on its feature contracts, existing list use case, and shared QueryContext/identifier contracts.
Serial composition remains owned by P2.I.

## Architecture and security gates

### Opaque identity and bounded contracts

- P2.A uses the accepted opaque `DeploymentId` and `BootId` types and opaque branded root
  references. Exact-record validation rejects unknown fields, custom prototypes, excessive root
  references, excessive workspace-reference counts, and mutable caller-owned collections. Returned
  state is defensively copied and deeply frozen.
- P2.B stores canonical `TeamId` and `WorkspaceId` values and an exact bounded ASCII legacy key; the
  key grammar rejects paths and Windows reserved names. Its SQLite schema enforces unique identity,
  legacy-key, directory-fingerprint, and published-checksum ownership and rejects illegal state
  transitions or physical record deletion.
- P2.C derives stable registration keys/root fingerprints independently of display names and issues
  exact boot-scoped mount generations. Registration and operation arrays are bounded before
  iteration and must be dense and exact.
- P2.E accepts canonical opaque identifiers in exact request records. Response projection copies
  only known fields, enforces list caps and uniqueness, and never exposes a legacy directory key,
  raw path, provider payload, credential, or unbounded additive object.

### Safe-root admission and TOCTOU defense

P2.C admits only caller-supplied roots carrying a fresh owned marker and descriptor-derived evidence;
it rejects unmarked/pre-existing roots, ambient temporary roots, home/current/real-project roots,
lexical escapes, parent/final symlinks, and cleanup-marker mismatches before reading the startup
manifest. Authorization revalidates the binding synchronously at operation time and creates the
private-field operation intent without an await between revalidation, policy checks, and intent
creation. The production live revalidator and composition are explicitly deferred rather than
falsely claimed.

P2.D repeats safe-root and marker checks, uses no-follow descriptor bindings, verifies containment
and `(dev, ino)` identity before and after relevant effects, and fails closed on link, type, owner,
size, or metadata drift. Leaf-swap tests prove that validated and replacement objects remain
distinguishable and recoverable; outside-root symlink sentinels are unchanged.

### Durable publication and recovery

P2.B implements the durable `prepared -> file_published -> committed` protocol with exact checksums,
timestamps, uniqueness, transactional state transitions, tombstones, and restart/retry/tamper
tests. P2.D publishes `team.identity.json` with exclusive no-follow create and mode `0600`, writes and
fsyncs the file, fsyncs the containing team directory, and re-proves the bound directory. Commit is
permitted only after publication evidence has been durably recorded and freshly reread as
`file_published`; missing, mismatched, or tampered evidence blocks. A committed-but-missing identity
file never silently republishes.

### Previously identified risk 1: bounded identity reads

Resolved and independently rechecked. `TeamIdentityFileStore` fixes identity input at 4 KiB and root
markers at 2 KiB. Its reader allocates only `maxBytes + 1`, reads at most that capacity, and never
allocates from attacker-controlled file size. It opens with no-follow semantics, verifies regular
single-link descriptor and parent binding, performs capped reads, restats the file and parent, and
rejects over-cap input or any `(dev, ino, size, mtime, ctime)` drift before UTF-8 decoding or JSON
parsing. The directory lifecycle reader applies the same bounded pattern to 2 KiB markers and 4 KiB
attempt-ownership records. Oversize, sparse, symlink, link-count, replacement, and metadata-race
cases fail closed in the focused P2.D suite.

### Previously identified risk 2: deletion-free invisible removal

Resolved and independently rechecked. There is no `rm`, `unlink`, or `rmdir` call in any P2.D
production path. Team removal first requires a durable tombstone, descriptor-proves the parent and
the original team directory, and atomically renames that exact directory to
`<teamsRoot>/.p2-d-removal-quarantine/<uuid>`. The fixed hidden container is config-less at its own
level; the config-bearing team directory is one level below it, so the real nonrecursive
`TeamConfigReader` does not list it.

When the container is first created, P2.D opens and re-proves it, fsyncs the container, then fsyncs
the parent before use. After the team rename it proves the original name absent, proves the moved
entry is not a symlink, proves its `(dev, ino)` equals the still-open expected directory descriptor,
proves the parent and container bindings and canonical containment, fsyncs the container, then
fsyncs the parent, and repeats the complete moved-inode/container re-proof. Thus both the namespace
move and its ordering are durably evidenced before success.

The focused test imports the real `TeamConfigReader`: it sees the team before removal, sees no team
after removal, sees only the hidden config-less container directly under the team root, and proves
that nested `config.json` plus a sentinel remain readable. It then manually renames the nested team
directory out and re-reads the sentinel, demonstrating recoverability. Separate team and attempt
leaf-swap tests retain both validated and replacement inode sentinels. Tombstone refusal leaves the
logical directory in place, and a durable tombstone prevents legacy-key reuse. Physical quarantine
garbage collection remains deliberately outside this lane; no hidden physical delete is present.

### QueryContext, reads, and transport boundary

P2.E's legacy read source executes synchronous authorization first, then cancellation, then deadline
validation before every identity, legacy-data, or runtime I/O. After every awaited read it repeats
preflight before any follow-up I/O. The exact same `QueryContext` object is passed to each port.
Tests prove unauthorized, already-cancelled, and expired requests perform zero I/O, and that
cancellation or deadline expiry after an awaited step prevents the next read. Returned legacy team
and runtime/alive bindings must match the canonical requested identity; mismatches fail closed.

The read API has four read-only operations and contains no route, status-code, IPC, HTTP, Electron,
Fastify, renderer, callback, process, filesystem, mutation, overlay, cache invalidation, or provider
semantics. No aggregate path wires hosted composition or adds a hidden hosted mutation.

### Leakage review

High-confidence private-key/API-token signatures produced no candidate payload match. Apparent secret
and absolute-path matches are only literal scanner patterns recorded in producer handoffs. The only
provider-word product matches are the pre-existing domain name `claudeRoot` and its root-kind literal;
they carry an opaque runtime root reference, not a provider credential or payload. The P2.D internal
`rootPath` is a main-process admission input, not a browser DTO, and is never returned by P2.E.
Classified scans and manual DTO/error review found no secret, credential, token, cookie, bearer,
authorization payload, private/home/task path, real-project path, legacy directory key, provider
payload, or unsafe reflected exception in an exposed contract or evidence artifact.

## Independent replay

Every required lane check was replayed on the canonical aggregate:

- P2.A focused suite: 2/2 files, 37/37 tests; foundation regression: 2/2 files, 36/36 tests.
- P2.B focused suite: 1/1 file, 17/17 tests; worker-core regression: 1/1 file, 14/14 tests.
- P2.C focused suite: 3/3 files, 28/28 tests.
- P2.D focused suite: 2/2 files, 25/25 tests, including both remediated security risks.
- P2.E focused suite: 3/3 files, 22/22 tests; Phase 1 lifecycle regressions: 2/2 files, 16/16
  tests; QueryContext regression: 1/1 file, 1/1 test.
- Total: 17/17 test files and 196/196 tests passed under Vitest 3.2.6.
- All five exact lane `lint:fast:files` commands passed (4, 4, 7, 6, and 9 TypeScript paths).
- `pnpm typecheck` passed with zero diagnostics.
- The exact aggregate 35-path Prettier check passed.
- `git diff --check`, `git diff --cached --check`, and `git diff HEAD --check` passed.
- Ownership arithmetic proved counts `5/5/8/7/10`, 35 total, 35 unique, and ten empty
  pairwise intersections. Import/path scans proved no shared entrypoint or sibling implementation
  dependency.
- Aggregate secret, private-path, provider, transport, destructive-delete, and unsafe DTO scans were
  completed and every textual match was manually classified as above.

## Findings, limitations, and disposition

P0 findings: none.

P1 findings: none.

P2 findings: none.

Exactly five valid, independently self-reviewed, pairwise-disjoint lanes are present. Their current
bytes, focused and regression tests, architecture boundaries, durability protocol, race defenses,
bounded reads, removal quarantine, QueryContext enforcement, transport neutrality, and leakage
controls satisfy P2.R1 with no unresolved P0 or P1. The formal disposition is ACCEPT.

Production composition, the concrete cross-lane adapters, live filesystem revalidation/openat2
topology, transport wiring, backup recovery as a coordinated recovery point, and quarantine
retention/garbage collection remain explicitly unverified and owned by later work. This review does
not infer activation from isolated lane evidence.

The only authorized next controller action is P2.I serial integration. This review does not commit,
push, integrate, launch a successor, claim remote equality, or claim Phase 2 activation or milestone
acceptance. Terminal state remains strict HOLD.
