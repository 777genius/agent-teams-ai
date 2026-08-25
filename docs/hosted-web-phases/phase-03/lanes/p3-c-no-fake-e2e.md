# P3.C: no-fake actual-owner E2E

- Packet revision: `phase-03-actual-owner-closure-r3`.
- Role: one bounded product-repository harness producer/executor.
- Depends on: accepted P3.A, P3.RA, and P3.B evidence recorded in the controller packet.
- Evidence ID: `P3.C.ACTUAL_OWNER_NO_FAKE_E2E`.
- Result: `verified | blocked | failed`; terminal state always `HOLD`.

## Mission

Selectively port the minimum useful behavior from preservation branch
`test/hosted-actual-owner-harness-r4` onto activation-v2. Do not merge that branch, replay its commits,
or copy its roughly 8.7k lines wholesale. Use the current product public seams and the orchestrator's
accepted actual-owner entrypoint. Keep net-new harness/test TypeScript at or below 3,500 physical
lines and every file at or below the repository's 800-line production-source ceiling. If the bounded
proof cannot fit without production edits or wider ownership, stop for re-packetization.

The single successful run must prove this real chain:

```text
MVP permission request
  -> owner-durable pending record
  -> authenticated browser reads and decides
  -> actual orchestrator owner sends the conditional decision to actual OpenCode
  -> durable settlement and explicit reconciliation close the request
```

No fake runtime, in-memory owner, mocked browser HTTP/SSE boundary, simulated OpenCode delivery, or
fabricated evidence may satisfy any acceptance row.

## Non-goals

- no broad Hosted parity or general provider/topology matrix;
- no terminal, attachments, change review, ReviewRouter, or member-recovery work;
- no production activation, eligibility/manifest/lock change, release, or successor materialization;
- no dependency update, install-state change, production refactor, or orchestrator/OpenCode edit; and
- no real provider identity/data, live-provider smoke, existing project, or second sandbox project.

The lane's completion-acceptance gate and every production/successor gate remain false. Even a
`verified` producer result is evidence for a fresh reviewer and ends `HOLD`; it is not completion or
activation authority.

## Immutable inputs

| Input | Exact pin |
| --- | --- |
| Product | `777genius/agent-teams-ai#252` at `d71671599c062244767494d392575cfacba5e1ff` |
| Orchestrator | `777genius/agent_teams_orchestrator#44` at `06e5dd89aee920c6e3ecd8ff0efbfcf5135021b7` |
| Current production OpenCode lock | unchanged `opencode-hosted-runtime.lock.json`: `v1.18.4-agentteams.1`; source `476b667c385210b19fbd15bcb57456cacb0ae9e7`; Linux x64 binary SHA-256 `7858adb4fdf140d7a3bc0a982e559418482333feb9b3d75389d25a0828a8a32d`; authoritative |
| OpenCode sandbox candidate | `777genius/opencode-anomaly#4` at `fe07feb2f6c1a1d58ffb65d2f269c8fb3de4ca8f`; workflow run `32784750815` |
| Candidate Actions artifact | ID `9541196940`; ZIP SHA-256 `601e3bf7713ff4180d449cc788e6000a2b706fb01f7cd11647379ab45c004b0c` |
| Linux x64 executable | SHA-256 `4947f69d85d491b5f73ef1c9306a5ef69c2991800fbd40f05f2b15a53f57299e` |
| Eligibility | product, orchestrator, and OpenCode gates false; OpenCode `productionEligible=false` |
| Behavioral reference | product preservation branch `test/hosted-actual-owner-harness-r4` at `5921ffd93bd04e9e1444ad134bc726cfcf60997c` |

The PR #4 bytes are sandbox-only, do not supersede the production lock, and cannot activate
production. The current production lock stays authoritative and unchanged.

The preservation SHA is read-only design input, not integration ancestry or accepted evidence. Before
execution, the runner receives separate controller-private canonical product and orchestrator
worktrees, proves each clean and at its exact accepted commit, and accepts only these two recipe IDs:

- `product-standalone-d71671599c062244767494d392575cfacba5e1ff-v1`; and
- `orchestrator-cli-06e5dd89aee920c6e3ecd8ff0efbfcf5135021b7-v1`.

The future `run.ts` owns and versions both recipe definitions. A caller cannot supply an executable,
argv, environment variable, output path, closure root, or additional build step. Each recipe pins the
path, SHA-256 and version of every executable, a signed controller toolchain-manifest SHA-256, and
the repository lockfile SHA-256. It supplies a minimal environment from a fixed allowlist, with a
controller-private empty `HOME`, `PATH` constructed only from pinned toolchain directories, fixed
`LANG=C.UTF-8`, `LC_ALL=C.UTF-8`, `TZ=UTC`, `CI=1`, `AGENT_TEAMS_DISABLE_SOURCEMAPS=1`, and private
`TMPDIR`, `XDG_CACHE_HOME`, `COREPACK_HOME`, and `PNPM_HOME`. Those are the only permitted keys;
networking is disabled and no credentials, proxy, package-manager defaults, Git, shell, or provider
variables are inherited. Every step is an ordered non-shell executable-plus-argv array. Substitution
is limited to named controller-owned canonical private absolute roots; substituted values can never
alter step count, argv boundaries, relative output names, or environment keys.

The root map is bound by the immutable worker-launch contract, not discovered from ambient state or
accepted through extra CLI/environment fields. It includes content-addressed controller-private
toolchain and offline production-dependency-store roots whose signed manifests are checked before any
recipe step; an absent or unlisted root fails admission.

### Commit-scoped build recipes and runnable closures

The product recipe first verifies the accepted source and these source pins: `package.json`
`cbecfaec0012c5aa7d3f4b64f0245a1c0037494a14afb20d36d0c6c045b09bb0`, `pnpm-lock.yaml`
`574fde47560a8405a157d02174620824507fe951bec04d142cb4b5a337278f4d`,
`pnpm-workspace.yaml` `30c29f43d8157680f05e9ec096dd7d865ce4498f134ac62212dea08d6256d178`,
`docker/vite.hosted-renderer.config.ts`
`1e4307f0d446e4cd8a68b22826c4bd4736c1141e87dd88c6f67ebdfd80c15e2b`, and
`docker/vite.standalone.config.ts`
`626d20884d2dbd31ff4493ba80b783ae3e539666a278793d80e49538211f1d7c`. It directly implements the
two ordered commands encoded by `standalone:build` in that exact `package.json`: pinned Node runs the
pinned worktree-local Vite entry first with `build --config docker/vite.hosted-renderer.config.ts`,
then with `build --config docker/vite.standalone.config.ts`; both retain the declared
`--max-old-space-size=8192`, and no `pnpm` lifecycle indirection may add steps. The source-authoritative
renderer distribution name is `out/renderer` (not an invented `dist/renderer`).

The product toolchain recipe requires Node `24.16.0` and the exact package-manager declaration
`pnpm@11.22.0+sha512.1ff870c4c6133dfd88fb2afc46dd13d47f09c9794b438c6fdb47ca98caf3bc16381ee0be93a091b8e3824cf01f889f46d7d9e20910fb0be1ab0fb5baa80dd621`;
future `run.ts` pins the corresponding executable and signed toolchain-manifest SHA-256 values rather
than trusting version output alone.

The product runnable closure contains every regular file below `out/renderer` and
`dist-standalone`, plus a controller-created runtime root containing the exact root `package.json` and
the complete production `node_modules` tree used by the Docker runtime. That tree includes every
transitive runtime dependency, every dependency `package.json`, native payload such as
`better-sqlite3`, and the runnable `agent-teams-controller` package bytes that Docker replaces into
`node_modules/agent-teams-controller`. Its dependency assembly follows the pinned lockfile's
production graph and the Dockerfile's `--frozen-lockfile --prod --ignore-scripts`, bounded native
rebuild, and hosted-no-terminal prune/verification contract; it may not silently reuse ambient
`node_modules`. The manifest must prove `dist-standalone/index.cjs`,
`dist-standalone/assets/internal-storage-worker.cjs`, renderer `index.html` and graph manifest, and
the externalized `fastify`, `@fastify/cors`, `@fastify/static`, `agent-teams-controller`, and
`better-sqlite3` runtime resolutions from within that closure.

The orchestrator recipe verifies its accepted commit and pinned `package.json`, `bun.lock`, tracked
`cli` wrapper, Bun executable/version/SHA-256, and toolchain-manifest digest hard-coded in `run.ts`.
Its only build step is the accepted direct `bun run build` in the orchestrator root. The build output
root `dist/local-cli` and a separate controller-created closure root must be absent first. The
complete runnable closure is the tracked `cli` wrapper plus every regular file below
`dist/local-cli`; it rejects a missing wrapper, a wrapper that does not select
`dist/local-cli/cli.js`, or any reliance on `dist/local-cli-dev` or source-mode launch.

All build output roots, dependency-assembly roots, extraction roots, and closure/staging roots must be
absent before the recipe starts. The runner snapshots tracked source/index identity before build,
rejects writes outside the recipe's declared output roots, and after build rejects a missing root,
unexpected root, undeclared output, or source/index mutation. It then revalidates accepted `HEAD`,
clean tracked worktree and index, and every pinned source/lock/toolchain digest both after the build
and immediately before staging.

For each closure, a descriptor-relative recursive walk starts from an already-open canonical root
directory and uses anchored `openat`-equivalent operations with `O_NOFOLLOW` on every component. It
rejects symlinks, special files, path escapes, mount/device changes, duplicate normalized paths, and
regular files with `nlink != 1`. Every regular file is hashed and copied from the same already-open file
descriptor after `fstat`; a second `fstat` after copy must preserve device, inode, size, type, mode,
and link count. The destination is private, new and opened relative to an anchored
directory descriptor. The identical discipline applies to all nested product/orchestrator closure
files, not only entrypoints.

The closure manifest lists every file exactly once in unsigned UTF-8 bytewise order as normalized
root label, slash-separated relative path, normalized mode (`0444` data or `0555` executable), byte
size, and SHA-256. It is complete by construction over declared roots and is compared to an
independent post-copy walk, so undeclared, missing and extra paths fail. A v1 leaf is SHA-256 over the
domain `p3c-closure-leaf-v1`, NUL-delimited canonical fields and file digest; sorted leaves form a
binary Merkle tree with domain `p3c-closure-node-v1` and duplicated final node at an odd level. The
runner records both root and SHA-256 of the canonical newline-terminated manifest. It seals staged
bytes read-only, reopens them with the same descriptor discipline, recomputes the closure manifest
and Merkle root, and reverifies the exact executing entrypoints immediately before launch. Prebuilt
output, a single entrypoint hash, or a caller-authored digest list is never admissible provenance.

### OpenCode archive admission

The controller supplies three distinct canonical private absolute paths: the already-present PR #4
ZIP, its immutable signed attestation, and its immutable artifact manifest. The runner must not
download or refresh any of them. The CLI independently requires the expected source commit, workflow
run ID, artifact ID, ZIP SHA-256 and executable SHA-256 shown above; `run.ts` also hard-codes those
same five pins and rejects disagreement among CLI, attestation, manifest and recipe constants.

Before extraction it authenticates the attestation signature to the controller-pinned trust anchor,
validates schema/issuer/repository/workflow identity, source commit `fe07feb2f6c1a1d58ffb65d2f269c8fb3de4ca8f`,
run `32784750815`, artifact `9541196940`, manifest digest, ZIP name/size/digest
`601e3bf7713ff4180d449cc788e6000a2b706fb01f7cd11647379ab45c004b0c`, and Linux x64 archive member
name/size/mode/digest `4947f69d85d491b5f73ef1c9306a5ef69c2991800fbd40f05f2b15a53f57299e`.
The archive, attestation and manifest are each read through anchored `O_NOFOLLOW`, single-link,
stable-`fstat` descriptors; the ZIP is hashed and parsed from that same descriptor.

Extraction is into a new private empty controller-owned root. A bounded ZIP reader rejects absolute
or drive paths, `..`, backslashes, NULs, duplicate/case-colliding normalized names, symlink/hardlink
or special entries, encryption, unsupported compression, data-descriptor ambiguity, excessive
counts/sizes/ratios, trailing bytes and undeclared members. It creates paths descriptor-relatively,
stages only the declared Linux x64 regular executable, and hashes/copies it from the same open
single-link descriptor. The staged executable is sealed `0555` and reverified against manifest,
attestation and the independent expected SHA immediately before launch. No network re-download or
pre-extracted executable is accepted.

## Exact initial owned paths

1. `scripts/e2e/hosted-actual-owner/README.md` (new)
2. `scripts/e2e/hosted-actual-owner/actual-owner-contract.v2.json` (new)
3. `scripts/e2e/hosted-actual-owner/contracts.ts` (new)
4. `scripts/e2e/hosted-actual-owner/preflight.ts` (new)
5. `scripts/e2e/hosted-actual-owner/sandbox.ts` (new)
6. `scripts/e2e/hosted-actual-owner/processes.ts` (new)
7. `scripts/e2e/hosted-actual-owner/evidence.ts` (new)
8. `scripts/e2e/hosted-actual-owner/run.ts` (new)
9. `test/e2e/fixtures/hosted-actual-owner/integration-manifest.unintegrated.json` (new)
10. `test/e2e/fixtures/hosted-actual-owner/harness.test.ts` (new)
11. `test/e2e/hosted-web/actual-owner-approval.spec.ts` (new)

These are future implementation paths. In particular, `run.ts` does not exist in this
documentation-only packet and no executable harness claim is made here.

All other paths are read-only. In particular, do not edit `package.json`, any lockfile, CI/workflow,
production source, activation golden/contract, runtime lock/manifest, release metadata, or another
repository. Existing dependencies only; no dependency update or install mutation.

The required `.codex-handoff/phase-03-p3-c.json` is a worktree-local control-plane reporting
exception outside repository ownership and commit scope. It is not a twelfth implementation path,
cannot carry activation or successor authority, and must not cause any additional repository write,
staged path, or committed path.

## One-sandbox safety contract

Create exactly one new private marker-owned sandbox/test project for the entire matrix. It must be
outside all repositories and user projects, start empty, contain a cryptographically random run
marker plus canonical root/device/inode identity, and be the only project path visible to child
processes. Strip ambient provider credentials, tokens, config/home paths, proxy credentials, Git
identity, and provider data from every child environment. Use a harness-private empty home/config
tree. The flow may drive a credential-free local OpenCode permission request; it must not contact a
real provider or use a real provider identity/data.

Revalidate canonical containment, marker, device/inode, mount generation, and no-symlink traversal
before every filesystem/process effect. Cross-team cases create two opaque TeamIds inside this same
project; they do not create a second project. Evidence is written to one disjoint private evidence
root and must contain no secret, raw credential, decision bearer, prompt body, or provider payload.

Cleanup is narrow: stop only run-owned processes, prove descendant drain and zero surviving
OpenCode/product/orchestrator processes for the run, then remove only the marker-and-inode-matched
sandbox root. On mismatch or residual ownership, preserve evidence, report the exact residual, and do
not broaden process kills or path deletion.

## Required proof matrix

### Positive and decision flow

1. A minimal credential-free request enters the actual OpenCode/manual-approval path and is correlated
   to exact workspace, TeamId, run, lane, provider, owner session/generation, activation-v2 digest,
   artifact digest, delivery generation, request, and effect.
2. The actual owner atomically persists `pending` before the authenticated browser can observe it;
   raw durable bytes survive an owner restart.
3. A paired authenticated browser observes the request over the production HTTP/SSE composition and
   submits canonical allow and deny decisions with Origin, CSRF, device/session generation, revision,
   and a unique one-use action nonce.
4. The actual owner delivers each decision through the candidate OpenCode conditional endpoint and
   records one protected effect and one terminal settlement. Evidence correlates browser, product,
   owner WAL, OpenCode, outbox, and reconciliation timelines without fabricated joins.

### Negative, restart, and replay

5. Missing/invalid session, Origin, CSRF, stale revision, wrong TeamId/run/lane/provider, and a second
   non-owner browser cannot decide or cause an effect.
6. Duplicate browser POST, nonce replay, SSE duplicate/gap/reconnect, and process response replay remain
   exactly once. Reload and owner restart recover canonical pending/terminal state without browser-
   stored command bodies or replayable receipts.
7. Restart is exercised (a) after durable pending/before decision, (b) after decision/before provider
   boundary, and (c) after provider boundary/before response recording. Stale boot, restore,
   activation, owner generation/session, lease, and socket references are rejected.

### Ambiguity and reconciliation

8. Immediately before the provider boundary, storage fences the exact delivery generation as
   `operator_required`, pins a stable `reconciliationRef`, and holds the boundary lease beyond the
   owner exchange timeout. Timeout, crash, or lost response never returns to ordinary delivery claim
   and never triggers automatic retry.
9. Reconciliation is unavailable while the boundary lease is open. Later explicit reconciliation is
   bound to exact workspace/authority/restore/team/run/approval/delivery/provider-delivery identities.
   `delivered` closes the outbox without another effect; only `not_delivered` creates a new pending
   lease and permits exactly one retry. Unknown/mismatched reconciliation stays operator-required.

### Socket, capability, isolation, and cleanup

10. Wrong socket path/device/inode/uid/gid/mode, replaced socket, dead owner, wrong artifact or wire
    capability digest, legacy v2/v3 owner admission, provisioning/restart-required admission, missing
    manual-approval capability, and capability downgrade all keep routes/effects absent. Capability
    recovery requires a new authenticated activation-v2 generation.
11. Team A cannot list, read, decide, reconcile, subscribe to, or receive Team B's request/effect;
    attempts leave both durable partitions unchanged.
12. Normal completion and forced owner/OpenCode failure both prove bounded shutdown, zero surviving
    run processes, marker-checked cleanup, no effect outside the sandbox, and retained redacted
    evidence. Any missing matrix row or cleanup proof fails the run.

## Exact checks for the later implementation/execution lane

Run from the exact product head. The first command is deterministic and must not launch runtime. The
second is the single authorized no-fake run. Every angle-bracket value is a controller-substituted
canonical private absolute path; no caller-provided build argv, executable, output or closure root is
accepted. The command's two commit-scoped recipe IDs select the only build definitions in future
`run.ts`. Illustrative placeholders are not accepted at execution time.

```text
pnpm exec vitest run test/e2e/fixtures/hosted-actual-owner/harness.test.ts
node --import tsx scripts/e2e/hosted-actual-owner/run.ts --product-root <controller-private-canonical-product-worktree> --product-ref d71671599c062244767494d392575cfacba5e1ff --product-recipe-id product-standalone-d71671599c062244767494d392575cfacba5e1ff-v1 --orchestrator-root <controller-private-canonical-orchestrator-worktree> --orchestrator-ref 06e5dd89aee920c6e3ecd8ff0efbfcf5135021b7 --orchestrator-recipe-id orchestrator-cli-06e5dd89aee920c6e3ecd8ff0efbfcf5135021b7-v1 --opencode-archive <controller-private-canonical-opencode-zip> --opencode-attestation <controller-private-immutable-opencode-attestation> --opencode-manifest <controller-private-immutable-opencode-manifest> --opencode-source-ref fe07feb2f6c1a1d58ffb65d2f269c8fb3de4ca8f --opencode-workflow-run-id 32784750815 --opencode-artifact-id 9541196940 --opencode-zip-sha256 601e3bf7713ff4180d449cc788e6000a2b706fb01f7cd11647379ab45c004b0c --opencode-executable-sha256 4947f69d85d491b5f73ef1c9306a5ef69c2991800fbd40f05f2b15a53f57299e --sandbox-parent <controller-private-new-empty-sandbox-parent> --evidence-root <controller-private-new-disjoint-evidence-root>
pnpm typecheck
pnpm lint:fast:files -- scripts/e2e/hosted-actual-owner/contracts.ts scripts/e2e/hosted-actual-owner/preflight.ts scripts/e2e/hosted-actual-owner/sandbox.ts scripts/e2e/hosted-actual-owner/processes.ts scripts/e2e/hosted-actual-owner/evidence.ts scripts/e2e/hosted-actual-owner/run.ts test/e2e/fixtures/hosted-actual-owner/harness.test.ts test/e2e/hosted-web/actual-owner-approval.spec.ts
pnpm exec prettier --check scripts/e2e/hosted-actual-owner/README.md scripts/e2e/hosted-actual-owner/actual-owner-contract.v2.json scripts/e2e/hosted-actual-owner/contracts.ts scripts/e2e/hosted-actual-owner/preflight.ts scripts/e2e/hosted-actual-owner/sandbox.ts scripts/e2e/hosted-actual-owner/processes.ts scripts/e2e/hosted-actual-owner/evidence.ts scripts/e2e/hosted-actual-owner/run.ts test/e2e/fixtures/hosted-actual-owner/integration-manifest.unintegrated.json test/e2e/fixtures/hosted-actual-owner/harness.test.ts test/e2e/hosted-web/actual-owner-approval.spec.ts
git diff --check
```

Also prove exact ownership/status, <=3,500 net-new TypeScript physical lines, fresh isolated clean
accepted-commit input worktrees, recipe and closure-root absence before build, exact recipe/source/
lock/toolchain pins, sanitized environment, ordered direct no-shell recipe steps, complete sorted
closure manifests and Merkle roots, post-build and pre-stage HEAD/source/index revalidation,
descriptor-relative same-fd hash/copy evidence, OpenCode signature/archive/extraction evidence, no
undeclared network egress, and a classified secret/private/real-project-path scan over source plus
retained evidence.

## Stop and handoff

Stop before launch on any dirty/stale/mismatched HEAD or tracked index, unknown recipe ID, caller build
argv, unpinned toolchain/lock/source, inherited environment, shell-mediated or nonzero build,
pre-existing/missing/extra/non-regular output or closure member, symlink/hardlink/path escape, unstable
file identity, manifest/Merkle/digest/signature/attestation mismatch, unsafe archive entry, non-private
or non-empty sandbox, undeclared path need, ambient identity/data, missing actual-owner entry, missing
activation-v2 capability, or false-to-true gate drift. After launch, ambiguity stays
reconciliation-only; do not retry it automatically. Never use terminal UI, a network artifact
download, real project/provider, broad cleanup, or a second sandbox to rescue the run.

The handoff records immutable pins, exact changed paths and line count, all commands/exit codes, one
row per proof-matrix case with durable evidence digest, process/sandbox cleanup proof, unverified
claims, blockers, and complete authority/security/race/scope self-review. It never starts `P3.F`.
End `HOLD`.
