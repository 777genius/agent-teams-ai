# P3.C0: input repacket for the future no-fake actual-owner sandbox E2E

- Packet revision: `phase-03-p3-c0-input-repacket-r5`.
- Current node: `P3.C0.INPUT_REPACKET`.
- Packet/base commit: `720fc62768341e1c2960cfaf4ad2496dd008291e`.
- Role: one zero-code documentation/authority writer.
- Evidence ID: `P3.C0.INPUT_REPACKET`.
- Result: `verified | blocked | failed`; terminal state always `HOLD`.
- Implementation authorized now: `false`.
- Runtime/final E2E authorized now: `false`.

## Mission

Materialize a corrected seven-file authority packet that separates all component identities, inserts
the mandatory built actual-owner acceptance node, freezes component-specific provenance policies and
defines the exact successor DAG. Reuse the useful safety, admission and raw-evidence contracts from
the rejected r14 seed without inheriting its direct P3.B-to-P3.C route or its source-mode execution
assumption.

This is a zero-code repacket. Do not create or change product source, runtime code, tests, dependencies,
lockfiles, CI, production locks, release metadata or another repository. Do not launch the product,
orchestrator, OpenCode, browser, provider, terminal or final E2E.

## Exact DAG

```text
P3.C0.INPUT_REPACKET
  +-> OC.PROVENANCE.V1 --------------------+
  +-> P3.B2.BUILT_ACTUAL_OWNER_ENTRY ------+-> P3.C1.EXACT_INPUT_FREEZE
  +-> P3.C.HARNESS_IMPLEMENTATION ---------+             |
                                                          v
                                              P3.C2.FINAL_NO_FAKE_RUN
                                                  exactly one run
                                                          |
                                                          v
                                              P3.RC.INDEPENDENT_ACCEPTANCE
                                                          |
                                                        HOLD
```

P3.C0 only freezes interfaces; it does not launch the three parallel nodes. After independent P3.C0
adoption, the controller may materialize them through separate exact packets. P3.B exact source is the
base for P3.B2, not a direct P3.C readiness or execution dependency. Within P3.C authority, the built
owner branch must terminate in independently accepted P3.B2 before P3.C1 or P3.C2; P3.B alone can
never satisfy that dependency.

`P3.F.COORDINATED_ACTIVATION` is controller-only and unmaterialized. It has no current DAG edge, and
no worker may create one.

## Immutable, historical and future identities

### Product

| Role | Binding | State |
| --- | --- | --- |
| Packet and future harness base | commit `720fc62768341e1c2960cfaf4ad2496dd008291e`; tree `d055bb5c362082a3b721d04ff1c44d8711d8d208` | exact/current |
| Audited runtime source | commit `d71671599c062244767494d392575cfacba5e1ff`; tree `af7fa38ec50893550ce14026c39b428f8dbfd1f2` | resolved from repository history; accepted P3.A/P3.RA descriptor |
| Harness result commit | controller-reviewed descendant of the packet/base commit | unset; unavailable; independently reviewed `false` |
| Controller-injected final-run harness commit | exact accepted harness result selected at P3.C1 | unset; available `false` |

These roles are not aliases. The audited runtime commit cannot substitute for the packet base or final
harness commit. The final harness commit cannot silently redefine the audited runtime-source bytes.
P3.C1 must bind both the reviewed harness commit and proof that the final product runtime sources match
the audited descriptor.

### Orchestrator

| Role | Binding | State |
| --- | --- | --- |
| P3.B source base | PR #44 `06e5dd89aee920c6e3ecd8ff0efbfcf5135021b7` | exact accepted source only |
| P3.B2 result commit | future successor whose source base is exact P3.B | unset; independently accepted `false` |
| P3.B2 fixed built-entry identity | exact generated wrapper/bundle/closure/recipe descriptors | unset; available `false` |

Neither current source tree, historical green build, generic `cli-source`, actual-owner `cli-source`,
nor a source-loaded `owner.ts` is a runnable accepted built actual-owner artifact. P3.B2 must add a
fixed built acceptance entry, preserve normal CLI behavior, and prove it runs from a complete isolated
generated closure without a source tree, TypeScript loader or `.git` directory. Caller-selected entry
paths and both source launchers are forbidden in P3.C2.

### OpenCode

| Role | Exact binding |
| --- | --- |
| PR head | `fe07feb2f6c1a1d58ffb65d2f269c8fb3de4ca8f` |
| Workflow merge commit | `2cbaa3f8d7f130ba41f07aab114a76f08cc311f1` |
| Release source commit | `3186244c3103eb02d95a255b593847b14488b070` |
| Release source tree | `8fba45aecd63ec61f334a856694cbd3da037df90` |
| Release base commit | `47b6b6f5f4f9b42d2bce7af1c4e5bf6efaf22ba7` |
| Workflow | run `32784750815`; attempt `1`; ref `refs/pull/4/merge` |
| Actions artifact | ID `9541196940` |
| Actions ZIP SHA-256 | `601e3bf7713ff4180d449cc788e6000a2b706fb01f7cd11647379ab45c004b0c` |
| Release manifest SHA-256 | `076dd096b36e34c47ad789c7b492d6b510f9b89cca9e6604f6fd0431c02d99fd` |
| Linux x64 tar SHA-256 | `fb1a48abaa25c412134c684f2c5b7ffa4fafd16d68c717fe0ede3ee655123308` |
| Linux x64 binary SHA-256 | `4947f69d85d491b5f73ef1c9306a5ef69c2991800fbd40f05f2b15a53f57299e` |

Every field is independent. The binary is nested in the Linux archive, which is nested in the Actions
artifact envelope; none of their digests may stand in for another. PR head, workflow merge, release
source/tree/base, run/ref and artifact ID also remain separate exact fields. Prefixes are never
admissible.

## Component-specific provenance policies

### Product runtime policy

The source side is the exact audited commit/tree descriptor above. The build side requires a clean
exact worktree at the independently reviewed, controller-injected final harness commit; an exact pinned
toolchain descriptor; and a fresh runner-executed isolated product build descriptor. Admission must
also prove that the runtime-source bytes at that final commit still match the audited descriptor. No
final harness commit, toolchain admission or fresh build is available during P3.C0.

### Orchestrator policy

The source side is exact PR #44 P3.B commit
`06e5dd89aee920c6e3ecd8ff0efbfcf5135021b7`. It is not the runnable artifact. P3.B2 must provide a
new exact result commit plus a fixed built-entry descriptor and complete fresh isolated build recipe,
including pinned Bun/toolchain identity, offline dependency identity, wrapper/bundle outputs and the
entire generated closure. An independent P3.B2 review must accept all of it before P3.C1. P3.C may not
infer artifact availability from P3.B source or build-green history.

### OpenCode policy

`OC.PROVENANCE.V1` materializes and independently reviews the immutable acquisition receipt, release
manifest, artifact envelope, nested platform archive, binary and explicit provenance state. For this
candidate the receipt proves acquisition facts and digests only. Neither the receipt nor release
manifest is a signed build attestation.

The current candidate has no signed build attestation and no verified signed build provenance.
`unsignedProvenanceAccepted=false`, `productionEligible=false`, `releaseEligible=false`, and the
candidate cannot supersede the current production lock. Exact receipt/digest binding may support only
the future sandbox behavioral proof after P3.C1; it makes no production or release provenance claim.
Signed provenance remains required before production or release and is recorded outside the all-false
production activation gates.

## Current P3.C0 ownership

Exactly these seven repository paths are writable:

1. `docs/hosted-web-phases/EXECUTION_INDEX.json`
2. `docs/hosted-web-phases/README.md`
3. `docs/hosted-web-phases/START_HERE.md`
4. `docs/hosted-web-phases/phase-03/README.md`
5. `docs/hosted-web-phases/phase-03/controller-packet.md`
6. `docs/hosted-web-phases/phase-03/execution-dag.md`
7. `docs/hosted-web-phases/phase-03/lanes/p3-c-no-fake-e2e.md`

No handoff, generated patch artifact, source file, runtime file or test file may add a repository
changed path.

## Successor interface: OC.PROVENANCE.V1

The future controller packet must require immutable, private, distinct canonical inputs for the
acquisition receipt, release manifest, Actions ZIP, Linux x64 tar and Linux x64 binary. It must verify
the exact identity table above, preserve the explicit absent-attestation state and reject a receipt or
digest as proof of a signature. Missing bytes, symlinks, hardlinks where single-link ownership is
required, special files, replacement races, cross-device escape, digest mismatch, extra identity
fields or production-eligibility drift fail closed.

If later signed provenance is produced from different subject bytes, it creates a new candidate
identity and requires a complete repin and independent review. No claim may be retroactively attached
to the current bytes merely because their digest is known.

## Successor interface: P3.B2.BUILT_ACTUAL_OWNER_ENTRY

P3.B2 is a narrowly scoped reviewed successor to exact accepted P3.B. Its required result is a fixed
built actual-owner acceptance entry plus a complete generated closure. The exact P3.B2 result commit,
entrypoint path/digest, generated wrapper path/digest, all closure files and digests, build recipe,
package/lock/build-script hashes, pinned Bun path/version/digest, signed toolchain-manifest identity and
offline dependency-store identity must be explicit.

The final acceptance command accepts a private marker-owned sandbox manifest, not a source path or
general production command. It preserves the already accepted actual-owner behavior and ordinary CLI
surface. Independent review must prove the built closure loads with the source tree and `.git` absent,
fails closed on missing/malformed authority without launching an owner/provider, and regresses none of
the accepted focused behavior. Until then its result commit and built-entry identity stay unset.

## Successor interface: P3.C.HARNESS_IMPLEMENTATION

The future harness producer starts from exact base
`720fc62768341e1c2960cfaf4ad2496dd008291e` and may own only these 14 product-repository paths:

1. `scripts/e2e/hosted-actual-owner/README.md`
2. `scripts/e2e/hosted-actual-owner/actual-owner-contract.v2.json`
3. `scripts/e2e/hosted-actual-owner/contracts.ts`
4. `scripts/e2e/hosted-actual-owner/anchors.ts`
5. `scripts/e2e/hosted-actual-owner/secure-files.ts`
6. `scripts/e2e/hosted-actual-owner/preflight.ts`
7. `scripts/e2e/hosted-actual-owner/sandbox.ts`
8. `scripts/e2e/hosted-actual-owner/processes.ts`
9. `scripts/e2e/hosted-actual-owner/evidence.ts`
10. `scripts/e2e/hosted-actual-owner/driver.ts`
11. `scripts/e2e/hosted-actual-owner/run.ts`
12. `test/e2e/fixtures/hosted-actual-owner/integration-manifest.unintegrated.json`
13. `test/e2e/fixtures/hosted-actual-owner/harness.test.ts`
14. `test/e2e/hosted-web/actual-owner-approval.spec.ts`

These paths are future ownership, not P3.C0 write authority. The harness result commit is initially
unset and cannot become a final-run input until focused deterministic checks and independent review
accept that exact commit. The harness must consume the P3.B2 built-entry and OC.PROVENANCE.V1
interfaces; it may not preserve r14's source-owner path.

## P3.C1 exact-input freeze

P3.C1 is not materialized until all three parallel results have independent acceptance. It freezes,
without inference:

- packet/base, audited runtime source, reviewed harness result and controller-selected final harness
  commits in their separate roles;
- exact P3.B source base, P3.B2 result, built entry, closure and recipe/toolchain identities;
- every exact OpenCode commit, workflow/run/ref/artifact identity and all four digest layers;
- immutable canonical paths, root/device identities, modes, sizes, link counts and SHA-256 values;
- one new empty private sandbox parent, one disjoint evidence root and a random controller nonce; and
- all false production/completion/successor gate states.

No launch authority exists before this freeze is reviewed. A missing or contradictory field returns
`HOLD`; ambient discovery cannot repair it.

## Future one-sandbox contract

P3.C2, if separately authorized, may run exactly once and only in one new private marker-owned
sandbox/test project. Two test teams, when needed, are partitions inside that project, not more
projects. A real project must never be opened in any runtime or terminal. Child processes receive
private empty home/config/cache roots and no provider tokens, Git identity, proxy credentials, ambient
auth or shared runtime state.

Only descriptor-contained non-symlink inputs are admissible. Every process identity binds the
controller nonce, role, argv/entry digest, cwd anchor, parent and monotonic start observation. Use a
pidfd where available; otherwise compare `/proc/<pid>/stat` start time immediately around each
read-only identity check. A bare PID or PID plus command name is never ownership and never authorizes
signaling. Cleanup may target only nonce-owned verified process trees.

Playwright receives only a controller-created evidence manifest under the admitted evidence root. It
rejects caller page URLs, storage-state/trace paths and executable paths. The parsed scheme must be
`http:` and every resolved address for its pinned hostname/IP must be loopback. Redirects and SSE
reconnects remain on that exact origin.

## Future authoritative evidence

Pass derives independently from raw records, never a process summary or fixture:

- exact product HTTP request/response status, headers and structural body bytes;
- exact product SSE event IDs/types/reconnect sequence;
- built-owner WAL/journal bytes retained across restart;
- OpenCode conditional-decision request, response and effect records;
- supervisor spawn, ready, restart, exit, escalation and drain records; and
- controller nonce, manifests, descriptors, digests and verified process-start identities joining
  every record.

Each proof row names record IDs/byte ranges and SHA-256 digests. Screenshots, Playwright reports,
fixture expectations, summary JSON and test exit codes are indexes only. They fail acceptance if the
raw records are absent, inconsistent, predate a bound process start or cannot join to the nonce.

## Future required proof matrix

### Positive and browser decisions

1. An actual credential-free OpenCode request becomes built-owner-durable `pending` before actual
   product HTTP/SSE exposes it; raw WAL bytes remain after built-owner restart.
2. The admitted loopback browser reads the request and submits canonical allow and deny decisions with
   session, Origin, CSRF, team/run/provider identity, revision and a unique action nonce.
3. The accepted P3.B2 built owner invokes the exact PR #4 conditional endpoint. Exactly one OpenCode
   effect and one owner terminal settlement correlate to request, decision, controller nonce and all
   three verified process starts.

### Rejection, replay and restart

4. Missing/invalid session, Origin or CSRF; stale revision; wrong team/run/provider; and a second
   non-owner browser produce no decision or effect.
5. Duplicate POST, action-nonce replay, SSE duplicate/gap/reconnect and owner response replay remain
   exactly once and preserve canonical durable state.
6. Restart after durable pending/before decision, after decision/before provider boundary, and after
   provider effect/before owner response recording rejects stale generations/sockets and reconstructs
   truth from WAL/journal plus OpenCode records.

### Ambiguity, capability and isolation

7. A provider-boundary timeout or lost response becomes durable `operator_required` with a stable
   `reconciliationRef`; ordinary delivery never automatically retries it. Explicit `delivered` closes
   without a second effect, while only explicit `not_delivered` permits one new fenced lease/attempt.
8. Wrong/replaced owner socket, wrong artifact/capability digest, legacy v2/v3 admission,
   provisioning/restart-required state, missing capability and downgrade keep routes and effects
   absent. Recovery requires a new authenticated activation-v2 generation.
9. Team A cannot list, read, subscribe, decide or reconcile Team B's request, and both raw durable
   partitions prove no mutation from each rejected attempt.

### Cleanup

10. Normal completion and forced owner/candidate failure both show bounded shutdown, verified process
    identities, zero nonce-owned survivors, no effect outside the single sandbox and marker/inode-
    checked cleanup. Identity ambiguity preserves sandbox/evidence and fails the run.

Any missing raw record, join, negative case, restart, actual effect or cleanup proof fails the run.

## P3.C0 checks

This repacket runs documentation-only checks, never a final E2E:

1. parse `docs/hosted-web-phases/EXECUTION_INDEX.json` as JSON;
2. prove the runtime-source prefix resolves from repository history to exact commit
   `d71671599c062244767494d392575cfacba5e1ff` and exact tree
   `af7fa38ec50893550ce14026c39b428f8dbfd1f2`;
3. audit all seven documents for identical revision/current node, product identities, P3.B2 dependency,
   OpenCode identities, component policies, all-false production gates and exact DAG;
4. prove all named commit identities are full 40-hex and each SHA-256 is full 64-hex;
5. prove `git diff --name-only HEAD` contains exactly the seven current owned paths;
6. run `git diff --check`; and
7. report SHA-256 over the raw stdout bytes of controller-format `git diff --binary HEAD`.

Do not run any product, orchestrator, OpenCode, browser, provider, terminal or E2E command under the
guise of verification.

## Stop and handoff

Stop `HOLD` on an unresolved/prefix-only SHA, collapsed identity, direct P3.B-to-P3.C freeze/run route,
claim that current P3.B source is a runnable accepted artifact, missing P3.B2 result placeholder,
non-false production activation value, receipt-as-attestation claim, out-of-scope path, runtime/final
E2E attempt, real-project runtime/terminal contact, production enablement, automatic ambiguous-effect
retry, successor launch or worker-created P3.F.

The handoff reports exact changed paths, documentation validation commands and results, remaining
unmaterialized identities/blockers and the SHA-256 of raw `git diff --binary HEAD`. It makes no
implementation, runtime, completion, production, release or successor claim. End `HOLD`.
