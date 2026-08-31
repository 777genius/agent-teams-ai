# P3.C deterministic actual-owner harness

This directory is the exact-scope product-side harness for the future P3.C no-fake run. The current
implementation lane builds and checks the harness only. It does not authorize or perform the final
E2E, start a provider, discover a local runtime, or touch a real project.

## Authority and inputs

`run.ts` accepts no path, URL, executable, command, or environment input. A future P3.C1 controller
must pass one canonical integration descriptor on inherited read-only descriptor 3. That descriptor
keeps the product authority, packet base, audited runtime source, reviewed harness result, accepted
P3.B2 result, and all OpenCode identity layers separate. It must explicitly set
`integrationReady=true` and `executionAuthorized=true`; all production and release gates remain
false.

Admission also requires a content-addressed P3.C1 freeze, an Ed25519-verified independent harness
review with P0/P1/P2 `0/0/0`, and an Ed25519-verified controller one-run authorization. A canonical
controller trust anchor is supplied separately in `AGENT_TEAMS_P3C_CONTROLLER_TRUST_ANCHOR`; it
pins the reviewer and authorizer public-key digests, authority epoch, and revoked signer IDs. The
descriptor cannot select its own trust root. The signed freeze covers the complete roles,
revocations, and authority policy. Before sandbox creation or any spawn, the harness atomically
creates and fsyncs one fixed-name consumed-run record in the controller-owned sandbox parent. The
supervisor receives only the sandbox descriptor, so worker deletion, crash, restart, a different
authorization document, or concurrent nonces cannot make that global one-run identity reusable.

Every root is an absolute, canonical, private `0700` directory with a pinned device, inode, and mount
ID. Roots are pairwise disjoint and no two roots may have the same backing device/inode through bind
mounts. Every admitted file has a root-relative normalized path, fixed
device/inode/mode/size/link count, and SHA-256. Files and closure members are opened relative to held
directory descriptors with `O_NOFOLLOW`, must be regular and single-link, and are hashed through the
same stable descriptor. Complete sorted closure manifests and domain-separated Merkle roots reject
missing, extra, linked, special, escaped, or changed bytes. There is no home-directory, PATH,
provider, browser, repository, or network discovery fallback.

The checked-in `integration-manifest.unintegrated.json` is intentionally non-admissible. It records
that P3.B2, OC.PROVENANCE.V1, the reviewed harness result, and P3.C1 execution authorization are not
available in this implementation lane. It is never a runnable default.

## Sandbox and processes

One controller-nonce-bound sandbox is created under the admitted empty private parent. It contains
the only test project and private `0700` home/config/cache/data/state/runtime paths. The evidence root
is a separate admitted empty directory. The sandbox marker binds the run, parent, root, device,
inode, and mount identity and is revalidated before every filesystem or process effect.

The harness starts only the independently pinned P3.B2 supervisor (never the owner entry in its
place), by descriptor, with direct argv, `shell=false`, a fixed allowlisted environment containing
no ambient provider/token/proxy variables, a run-unique inherited ownership marker, and fixed
inherited descriptors. Its production-consumed plan requires a new PID namespace and a private
tmpfs root installed with `pivot_root`: only the exact descriptor-backed read-only inputs, the
writable sandbox, private `/proc`, and minimal `/dev` are mounted. The transcript must contain the
complete top-level and mount census, distinct parent/child namespace identities, and negative probes
for every named ambient host path. The supervisor contract requires
pidfd and process-start evidence for itself, every initial process, actual replacement owner starts
at all three restart boundaries, and the complete Chromium browser/network/GPU/renderer descendant
tree. Independently observed exit and drain records bind every start token and pidfd. Network
evidence binds the new namespace inode, parent namespace inequality, exact loopback interfaces and
routes, loopback listeners, and denied IPv4/IPv6 outbound probes. The accepted product composition
entry, P3.B2 entry, OpenCode binary, Playwright bundle/config/spec, Chromium executable, exact argv,
and CLI-enforced `workers=1`/`retries=0` are digest-bound. A PID alone never proves ownership. The
harness does not enumerate or signal ambient processes. The parent controller registers the
deterministic run-owned process group as a provisional census anchor synchronously after detached
spawn, before asynchronous marker/stat verification. That provisional anchor cannot authorize a
signal. Only full marker and PID/start-time/process-group/session verification promotes it to
signal-eligible. Once the direct child reports exit, even an exact reused numeric identity can never
authorize TERM or KILL; absence instead requires two consecutive empty group censuses, reset by any
nonempty observation. A verified live leader may receive bounded group TERM/KILL and must leave zero
survivors. ENOENT/ESRCH never falls back to a leader-only kill. If drain or identity proof is missing,
cleanup preserves the sandbox and evidence; it never broadens the kill or deletion scope. Owner
replacement evidence orders the prior exit, zero-survivor drain, and socket invalidation before the
next generation and proves exactly one current owner and socket owner. A separate `/proc` census
injects setsid and double-fork descendants at owner and OpenCode boundaries, binds TERM-to-KILL
escalation and exit cause, requires an empty post-drain census, and proves an outside-sandbox
sentinel was unchanged.

The owner wrapper accepts only `--runtime-manifest /sandbox/runtime-manifest.json`; its sealed child
receives the fixed FD3 launcher lease, one-use FD4 bootstrap stream, and retained authenticated FD5
ActivationV2 connection. Arbitrary distinct parent descriptors may be remapped to those child-local
numbers, but the supervisor result is accepted only when the production wrapper records, for every
observed wrapper PID/start token, the exact pre-spawn `/proc/<pid>/fd/<fd>` identity and post-spawn
`fstat` `EBADF` result for each launcher-lease, bootstrap, and ActivationV2 parent copy, ordered on
the same monotonic clock around the recorded spawn boundary. The child publication repeats the
wrapper PID/start token and a fresh 256-bit pre-spawn nonce, and final acceptance joins all three to
that exact lifecycle record. A plan flag or cleanup boolean is not
evidence. Missing, partial, reordered, identity-detached, temporally invalid, or non-`EBADF` records
fail final acceptance before evidence is retained.

## Raw evidence

Six independently collected raw canonical NDJSON streams (`browser`, `product-http`, `product-sse`,
`owner-wal`, `opencode`, and `supervisor`) remain one side of the comparison. Each record binds the controller nonce,
matrix row, monotonic sequence, verified replacement-aware process-start token, raw semantic payload
digest, and the joined authenticated-actor/target-team/run/approval/generation/preview/idempotency/
decision identity that the pinned product contract exposes, plus separately observed provider-effect
identity captured from retained provider bytes. The harness never synthesizes product API fields.
The verify-only overlay parses the independent r307
`claude-team/hosted-producer-provenance/v1` envelope, its exact contract digest, producer nonce,
per-shard sequence/hash chain, and stream-specific semantic joins. It accepts multiple physical
owner shards as one logical `ownerWalTimeline`. Acceptance additionally requires supervisor-observed
FD 9/10 device/inode identity, producer PID/start ticks/executable and module identity, parent-copy
`EBADF`, producer descriptor disappearance or exact pidfd exit, a zero-retained-writer descendant
census, and a stable read-only seal manifest. `runDriver()` only reopens those sealed shard inodes
read-only. No verifier function constructs expected native bytes.

Producer-open and semantic records use exact capture-specific native schemas bound to that shared
contract digest. Each native semantic record and digest must equal the independently parsed raw
record. Cross-joins are exact and ordered within the kernel-bound producer shard, rejecting
resequencing, rehashing, owner substitution, duplicate or missing joins, and cross-owner mixing.
Emission nonces are unique across every FD stream, owner generation, and shard in the run. A live
capture mode must exactly equal its authoritative sealed mode (`0400`); stable `0600` captures are
rejected.

This repository does not yet contain composed successor P3.B2/OpenCode/Product/browser producer
identities. The frozen OpenCode artifact predates the native writer contract and is rejected before
launch. Therefore `productionEligible=false`, fixture proofs cannot satisfy acceptance, and the
README does not claim producer-native readiness. Fixed hand-authored parser goldens are explicitly
`nonAuthoritative`; they exercise framing and tamper rejection only.

The complete OpenCode acquisition tuple remains future descriptor material until it is supplied by
committed, independently accepted acquisition evidence. Admission cross-binds the pull-request head,
workflow merge, release source/tree/base, workflow ref/run/attempt, distinct artifact IDs, and exact
acquired file digests across that evidence, the signed producer candidate, the P3.C1 freeze, and the
verified release provenance. A GitHub artifact digest field is not an acquired archive SHA-256 and
is never substituted for the digest of bytes read through the admitted file descriptor.

The current hand-written contract digest is
`f83678990876983c839f32d3c5f0413a2df4a681cfb278a646d3e192b69d13d3`; the parser rejects any
other value.
Cross-team evidence binds the authenticated Team A actor from the successful browser decisions to
the browser's retained rejected Team B page, preview, and decision calls, and then to a distinct
Team B item, preview, and result first observed under Team B authority. HTTP, SSE,
WAL, OpenCode, browser, and supervisor payloads have distinct exact schemas; an event label never
satisfies a requirement without a matching transport record and identity join. Summary JSON,
screenshots, Playwright output, and exit status cannot replace a missing raw record. The harness
validates every positive, rejection/replay, restart, ambiguity/reconciliation, capability,
cross-team, forced-failure, and normal-cleanup row before it
retains private read-only raw streams and their digest index. Each row index carries the exact raw
record ID, byte range, and line digest. A single global monotonic order and cumulative effect count are
enforced, and the `effect_total_two` record contains a cryptographic set join to both actual provider
effects and must follow both effect records. Every actual allow/deny effect record carries and
directly joins its own non-null provider-effect ID. Canonical redacted observed HTTP and OpenCode body bytes
are retained inside their digest-bound payload, their SHA-256 is recomputed, and their exact
event-specific contract shape and semantic identity are revalidated. Retained approval-page
exchanges bind every exact request and response from the initial null cursor through the terminal
non-truncated page. They enforce the pinned product parser's page contract, cross-page approval-ID
uniqueness, successor transitions, bounded `cursor_` tokens, cycle rejection, budgets, and item
semantics. SSE event type and decoded `data.event`/decision bind to the outer retained event and its
semantic decision. WAL state binds to the outer event, and the WAL record SHA-256 and length are
recomputed from the exact retained record. Prompt/provider bodies, generic
credential fields, authorization/cookie/CSRF material,
action proof, decision bearer, and other secret-like material are rejected from retained evidence;
only exact schema-allowed redacted structures survive. The browser row uses the rendered product UI
and native `EventSource`, verifies reconnect carries the last event cursor, and proves gap recovery
and duplicate delivery do not duplicate rendered approvals. Ambiguous delivery is reconciled
through the real product endpoint with a WAL reference, lease, writer fence, retry effect, and a
global no-duplicate join. Stale, wrong-target, duplicate, and replay negatives reuse the canonical
successful request identity and remain bound to exactly one global mutation.

Successful evidence is first written under exclusive staging names. All retained files are renamed
and fsynced, `READY.json` is created last with their hashes, and the evidence root is then sealed
`0500`; no staging entry or writable publication parent is accepted as final evidence.

## Implementation-lane checks

These checks are deterministic and do not launch the product, owner, OpenCode, browser, provider, or
orchestrator:

```sh
pnpm exec vitest run test/e2e/fixtures/hosted-actual-owner/harness.test.ts
pnpm typecheck
pnpm lint:fast:files -- scripts/e2e/hosted-actual-owner/contracts.ts scripts/e2e/hosted-actual-owner/anchors.ts scripts/e2e/hosted-actual-owner/secure-files.ts scripts/e2e/hosted-actual-owner/preflight.ts scripts/e2e/hosted-actual-owner/sandbox.ts scripts/e2e/hosted-actual-owner/processes.ts scripts/e2e/hosted-actual-owner/evidence.ts scripts/e2e/hosted-actual-owner/driver.ts scripts/e2e/hosted-actual-owner/run.ts test/e2e/fixtures/hosted-actual-owner/harness.test.ts test/e2e/hosted-web/actual-owner-approval.spec.ts
pnpm exec prettier --check scripts/e2e/hosted-actual-owner/README.md scripts/e2e/hosted-actual-owner/actual-owner-contract.v2.json scripts/e2e/hosted-actual-owner/contracts.ts scripts/e2e/hosted-actual-owner/anchors.ts scripts/e2e/hosted-actual-owner/secure-files.ts scripts/e2e/hosted-actual-owner/preflight.ts scripts/e2e/hosted-actual-owner/sandbox.ts scripts/e2e/hosted-actual-owner/processes.ts scripts/e2e/hosted-actual-owner/evidence.ts scripts/e2e/hosted-actual-owner/driver.ts scripts/e2e/hosted-actual-owner/run.ts test/e2e/fixtures/hosted-actual-owner/integration-manifest.unintegrated.json test/e2e/fixtures/hosted-actual-owner/harness.test.ts test/e2e/hosted-web/actual-owner-approval.spec.ts
git diff --check
```

Do not invoke `run.ts` or the Playwright spec in this lane. A separately reviewed P3.C1 freeze and a
separate one-run P3.C2 authorization are prerequisites. Terminal state remains `HOLD`.
