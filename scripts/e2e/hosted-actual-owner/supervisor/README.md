# Actual Owner launch checkpoint

This directory implements the Linux Owner launch stage and its TypeScript caller against Product
`e8fe0c3a3d97ba6eb8f86853db4a5baa119e3e28`, r851 and overriding r866. It is source for integration
into the selected supervisor closure. It does not implement the full namespace supervisor or grant
production, capture, activation, build or final-run eligibility. No existing parser or flag changes.

## API and ownership

`launchOwnerFromPlan(options)` in `index.ts` consumes a `SupervisorPlan`, inherited image/writer/cwd
handles, the existing Product bootstrap document and common activation expectations, an independently
observed `ExpectedSupervisedOpenCode`, selected recipe/contract/start bindings and the prepared raw
prefix binding. The selected supervisor must call it after descriptor admission and actual OpenCode
readiness. There is no environment/profile/network discovery and no unavailable-adapter stub.

`options.handles.helper` and `.executable` are `{fd, pin:{device,inode,size,mode,sha256}}`. Supply
the already opened/verified handles from the admitted closure; both ELF files must be private,
single-link, current-UID/GID, mode `0500`. The caller rehashes the same descriptors. Cwd and both image
handles are borrowed until launch settles. Raw/WAL writer FDs transfer to `launchNativeOwner` after
distinct-number validation, even on failure; it closes them immediately after spawn and observes
EBADF without an intervening FD allocation. Failures in the higher plan preflight leave those two
writers with its caller. Never close transferred numeric slots again.

For a built entry use `invocation:{kind:'built-entry'}`. For source use
`{kind:'source-bun',modulePath,moduleSha256}` with an entry in the admitted **read-only mounted source
closure** and a separately pinned Bun ELF in `.executable`. The stage directly executes that ELF by
FD11 with `run <modulePath> --hosted-actual-owner-sealed-protocol=v2 --runtime-manifest
/sandbox/runtime-manifest.json`. It does not invoke the old shell launcher that overwrites FD9.
Source module identity and executed Bun identity remain separate. Source closure immutability is the
enclosing namespace supervisor's responsibility, not a promise inferred from a module pathname.

The result retains `held`, `sealed`, `executed`, `delivery`, `ownerProcessStartToken`, `digests`,
`descriptorMap`, `parentCleanup`, and actual bounded `nativeEvents()`. `executed` includes an actual
post-exec proc image observation and SHA-256 before Owner user code resumes. `delivery` means both
frames were sent with EOF; it does not claim Owner admission, socket publication or activation.
`parentCleanup` records the native allocating/closing parent separately from the Owner child.

`result.activation.take()` and `result.liveness.take()` each transfer one retained `net.Socket` once.
Until taken, the result owns them. After taking, the receiver owns closure. The actual Product seam
accepts `inheritedCandidateActivation:{transport:{socket: result.activation.take()},
expectedOpenCodeExecutableSha256:<admitted candidate>}`. No socket pathname reconnect is involved.
The Product receiver must close a transferred socket on rejection too. Keep FD6 separate from FD5.
`result.dispose()` closes endpoints still owned by the result and requests cleanup of only its
helper's exact child. `result.exit` retains its wait status. On rejection, `OwnerLaunchError.nativeEvents`
retains partial native observations, including send offsets and whether the child was reaped.

`launchNativeOwner(options)` is the lower stage API used by the focused tests. Its `assemble(held)`
callback receives the actual barrier-held child and transfers returned `leaseBytes`, `bootstrapFrame`
and `authFrame` buffers to the stage. Those mutable buffers are erased when consumed or rejected.
This primitive is not a custody constructor; selected composition remains the authority boundary.

## Native boundary

The separate C17 helper allocates an empty sealable memfd, opens a **separate O_RDONLY description**
through its still-owned proc FD, and creates bounded Unix stream socketpairs for bootstrap/auth.
Node's Linux `spawn` socketpair stdio supplies the activation/liveness counterparts directly to TS.
The helper validates their actual socket type/connection; runtimes providing ordinary pipes there
fail explicitly. No Bun FFI, fork of a running JS runtime, SCM_RIGHTS addon or library dependency.

Only the single-threaded C image forks. The child duplicates all eight sources above FD255 before
mapping to 3/4/5/6/7/8/9/11, closes FD10 and all surplus handles, and stops under ptrace. The parent
independently inspects the actual remapped proc descriptors, retains the child pidfd/PID/start tuple,
its own PID/start tuple, namespace inodes, nonce, source snapshots and adjacent close/EBADF results.

TS constructs corrected canonical `H0 -> lease -> H2 -> frame`. Only
`approvalActivationV2.signedManifest.manifestDigest` is omitted; no null/dummy digest or pre-exec
Owner socket is invented. Product `bootstrapDigest`, header SHA, lease SHA and artifact/executable
identities stay separate. `canonical.ts` mirrors the existing Product pure algorithms, with a focused
equivalence test. Directly importing the shared harness contracts would read a schema relative to
`process.cwd()` during module initialization, breaking the private-namespace caller. Shared files
remain untouched; the existing capsule contract digest instead comes from the admitted plan.

C receives all bounded bytes before release, writes and verifies all four kernel seals, closes the
writable construction description, then allows `execveat(11,"",...,AT_EMPTY_PATH)`. A child-side seal
gate independently refuses an unsealed lease. `PTRACE_EVENT_EXEC` stops the actual executed image;
TS observes/hashes it before acknowledging detach. The helper then sends bootstrap/auth concurrently
with nonblocking `send`/`poll`, bounded partial-write loops, EOF and cancellation, using the **same
absolute 5000 ms monotonic deadline** established at helper startup (including assembly and exec).
Small socket send buffers exercise backpressure; no synchronous pre-fill of a large pipe is used.

Unexpected stop/exit, missing kernel support, alias, wrong mode, failed seal, canceled send or timeout
fails closed. Cleanup signals only the unreaped fork result through its pidfd (direct-child kill is
used solely if acquiring that pidfd failed). It allows 2000 ms for reaping and reports uncertainty if
that fails. PDEATHSIG and the ptrace exit-kill option protect loss of the helper/caller. The helper
remains the Owner's parent after delivery. No supplied OpenCode or bootstrap PID is a signal target.

## AOL1 syscall framing

Each message is `u32be(0x414f4c31) || u32be(type) || u32be(length) || payload`. The magic versions
this private protocol; unknown versions/types/lengths fail. Owner itself receives only r851/r866
bootstrap/auth bytes, never AOL1. All integer records are fixed big-endian, with no C struct padding.

- INIT 1: six u32 source slots (activation, liveness, raw, WAL, image, cwd), then argv and env lists.
  Each list is u32 count followed by length-prefixed UTF-8 strings; at most 32 strings of 8192 bytes,
  no NUL, at most 32768 total bytes. Slots are distinct 3..254; 255 anchors helper execution only.
- ASSEMBLED 2: lease/bootstrap/auth u32 lengths followed by those exact byte blocks; maxima
  65536/65604/8196. EXEC_ACK 3 and CANCEL 4 have empty payloads. Closing control also cancels.
- Events 101..105 are held, sealed, exec-stopped, delivered and exit; 199 is failure. Bodies are
  decoded by `native-protocol.ts`. Descriptor rows retain source/target, kind, access, append, mode,
  UID/GID/seals, dev/ino/size/nlink, mtime/ctime and closure time. Unsupported seals encode `0xffffffff`.
  Events are at most 4096 bytes each and 16384 bytes per launch; no auth/key/frame bytes enter them.

## Root verification commands (not executed by the implementation worker)

The test command checks Linux/root, creates a fresh private `/var/tmp/hosted-owner-launch-*` sandbox,
compiles the production helper plus benign consumer and a separate seal-fault helper there, and
retains only that test-owned sandbox for review. It never starts Owner, OpenCode, a provider or app.
Use the pinned Node runtime and installed workspace dependencies; no install is needed.

```sh
TSX_DISABLE_CACHE=1 pnpm exec tsx --test scripts/e2e/hosted-actual-owner/supervisor/launch.test.ts
pnpm typecheck --project scripts/e2e/hosted-actual-owner/supervisor/tsconfig.json
pnpm typecheck
pnpm lint:fast:files -- scripts/e2e/hosted-actual-owner/supervisor/*.ts
pnpm guard:source-file-size
pnpm guard:feature-architecture
```

For just the production helper, supply a new output directory explicitly:

```sh
owner_launch_build_dir=$(mktemp -d /var/tmp/hosted-owner-build.XXXXXX)
sh scripts/e2e/hosted-actual-owner/supervisor/build.sh "$owner_launch_build_dir"
```

Tests cover both maximum frames byte-for-byte, genuine RO and seal failures, cyclic FD collisions,
reserved FD10, no extraneous inherited descriptors, parent/child inequality, no execution at the
assembly barrier, actual post-exec identity, retained endpoints, aliased writer refusal, child exit,
partial-send cancellation and a native timeout while the JS event loop cannot run its timer. Codec
tests validate hash separation, H0 reconstruction, deferred-manifest keys and PID substitution
refusal. Fixture headers/auth are explicitly non-authoritative and never qualification evidence.

## Required next connections

1. Place this helper and TS entry in the selected supervisor/recipe closure. Implement namespace,
   mount/network/cwd setup, the complete seven-launch schedule, descendant custody and transcript
   production around `SupervisorPlan`; `executeSupervisor` still consumes that external executable.
2. Connect the separate OpenCode writer's same-coordinator readiness channel, actual process/image/
   namespace observations, prepared profile and provisioned credentials to `expectedHost`. This
   stage never invents runtime/config IDs or performs an unledgered capability request.
3. Connect W1-B's v2 decoder, Product runtime-manifest reader, inherited FD5 attachment and deferred
   signed-manifest adapter. After the real Owner socket exists, retain the independently verified
   Ed25519 publication digest indexed by this exact Owner start before recovery/delegate install.
   W1-B must consume/close FD11 before Owner helper spawns and isolate all hosted writer/secret FDs.
4. Product's integration writer must add map-v2/cleanup-v3 admission and plan/entry wiring without
   changing v1 parsing, then attach this exact activation endpoint. The current candidate literal,
   old executable/entry assumptions and schema/candidate pins must be reconciled with actual selected
   artifacts. This patch neither edits shared parsers nor sets qualification flags.
5. Finish W1 custody/raw-retention injection and prefix handoff, Owner transport and P1/O1 joins in
   their owning slices, then perform the separately authorized full MVP gates. These primitives and
   benign native tests do not prove that composition complete.

### Source selection and refusal cleanup

A source invocation requires an admitted `plan.ownerSourceInvocation` record with
format `agent-teams.hosted-owner-source-invocation/v1`, independently selected
executable device/inode/SHA-256, and the exact selected module path/SHA-256.
The executable must also match the plan's executable fields and inherited image;
the module digest must match the separate producer-module field. A legacy
built-entry plan cannot implicitly authorize a source runtime. Admission must
verify the exact module path/digest pair before preserving the immutable closure.

Once numeric writer handles transfer, every writer receives an independent close
attempt even when another descriptor is stale. Closure failures join the original
structured launch failure; they cannot suppress remaining cleanup or trigger
retry of a potentially reused descriptor number.
