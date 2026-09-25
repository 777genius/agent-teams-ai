# Hosted MVP deferred TODOs

- Decision date: 2026-09-12
- Amended: 2026-09-25 (owner decisions)
- Status: accepted deferral inventory; not execution or activation authority
- Scope source: [Hosted Web Core v1 scope lock](hosted-web-core-v1-scope-lock.md)

This list records only the accepted Hosted MVP deferrals. It does not narrow retained desktop or
shared behavior, authorize a later capability, or permit provider/runtime safety workarounds.

## TODO: manual approval mode

Manual approval remains represented as `toolApprovalMode: 'manual'` in shared contracts and stored
records. Hosted MVP must keep those records readable and refuse their create/update, promotion, and
activation explicitly. No boundary may silently substitute `auto`. Retain the existing approval
storage, operator-decision, actual-owner activation, ambiguity, and reconciliation implementation in
its fail-closed, unmounted state.

Later promotion requires all of the following acceptance criteria:

1. an explicit product decision promotes manual approval into Hosted scope;
2. server capability advertisement, create/update/promotion validation, actual activation, and the
   browser control all agree that manual mode is available;
3. pending prompt, allow, deny, timeout, reload/reconnect recovery, and two-tab exactly-once answer
   behavior pass focused contract/integration tests and built Linux browser E2E;
4. provider acceptance ambiguity remains terminal `operator_required`, uses the stable fenced
   reconciliation flow, and is never automatically retried or acknowledged;
5. authorization, per-team routing, runtime custody, provider credential isolation, redaction, and
   process-ownership gates remain unchanged or stronger; and
6. old manual records activate only through the same explicit validated path—never migration by
   mutation to automatic mode.

## TODO: post-creation roster and settings editing

Hosted MVP retains configurable initial draft editing for each supported runtime, without
enforcing presets; a launched MVP team uses one provider (mixed teams are deferred below). Editing roster or settings after team creation/activation is deferred.
Later promotion requires revision-conflict behavior, runtime-safe drain/restart semantics where an
external effect is possible, stable member identity, focused server/UI coverage, and disposable
sandbox browser E2E.

## TODO: browser member logs and advanced diagnostics

Hosted MVP keeps basic lifecycle status/errors and bounded redacted server logs. Per-member browser
logs and advanced diagnostics are deferred. Later promotion requires authorization and team/lane
scoping, bounded pagination/retention, redaction tests for credentials and filesystem details, and
built Linux browser E2E proving no cross-team disclosure.

## TODO: stranded cross-namespace file locks

A team file lock left by a crashed holder from another PID namespace (for example a replaced Product
container) is never reclaimed by PID and needs manual removal; the later fix is kernel-owned
`flock`/OFD locks, which the kernel releases on process death.

## Deferred by owner decisions 2026-09-25

Source: [scope lock owner decisions](hosted-web-core-v1-scope-lock.md#owner-decisions-2026-09-25).
Rule: Hosted MVP keeps desktop parity and adds nothing desktop lacks. Existing code and focused
tests for these items stay; only the MVP gate or the remaining build-out is dropped.

- **Phase 03 r6 route: P3.S0-S5 source lanes, their reviews, source adoption, and the future
  candidate-build, exact-lock, P3.C1 freeze, P3.C2 seven-launch run, P3.RC and P3.F nodes.** It
  proves actual-owner approval, which is deferred with manual approval; MVP release proof is the
  scope-lock browser gates plus the live Core run.
- **Hosted producer provenance v2 schema, golden, and four-role producer contract.** Serves only the
  r6 approval and release ceremony; desktop has no equivalent.
- **Artifact signing, SBOM, attestation, and atomic stack manifest.** Desktop ships a pinned runtime
  lock; MVP pins the exact Owner commit and the official OpenCode digest. Hosted and desktop release
  lines stay separate.
- **Per-member container isolation, root container daemon, supervisor protocol, signed observations,
  one-use effect capability.** Hostile-runtime profile; v1 is `trusted_process` like desktop, where
  agents run as the user's own processes.
- **Owner `runtime_drain_status` proof before a first pairing code.** Needed for the isolated
  profile, where an agent must not gain operator credentials. Plan: a read-only signed Owner ACL
  operation answers `drained` only when the lifecycle execution state is idle with no in-flight
  job (lanes are not called, so nothing is adopted) and no retained persistent OpenCode host
  remains; otherwise `not_drained` with a reason. Product then issues the first code only after
  that proof instead of the startup shortcut, keeps serving and logs `runtime_not_drained`
  otherwise. The same operation can replace the operator-produced AR drain evidence file for host
  reset and auth-mode reset. `trusted_process` accepts this risk (scope lock decision 7). A
  readiness-handshake variant (Owner signs `noLiveRuntimes`, Product defers the first code) is
  parked in local branches `parked/hosted-pairing-drain-owner` (Owner `9dde1e86`) and
  `parked/hosted-pairing-drain-product` (Product `09377fc3de`); it still lacks a "stop agents first"
  screen and requires Product and Owner to ship together.
- **Stopping a retained persistent OpenCode host with no run on `hostedctl down`.** Owner shutdown
  stops every run in its lifecycle state, but a verified persistent host kept alive for adoption
  without a run lives in `OpenCodeHostManager` and survives until the host itself is stopped.
- **OpenCode stop-recovery contract v1 in the host-local lifecycle lane.** Crash consistency, not a
  feature: the legacy stop works live. Plan: send `stopRecovery` with a request id derived from
  team, lane and run (equal to the envelope `requestId`), the run's member sessions, launched
  capability and behavior fingerprint; keep legacy stop for an empty lane; map pending or unknown
  outcomes through `opencode.stopOutcome`/`opencode.reconcileStop`; test against a real stop ledger.
- **Single Product task writer (`wip/hosted-task-product-switch`).** Personal-host MVP writes board
  tasks through the trusted Owner writer only for the `core-lifecycle-personal-host-v1` admission
  (scope lock decision 10); every other profile keeps the Owner read-only until Product owns the
  one atomic task writer. The branch is stale and is not ported as it is: current
  `createProductTaskMutationAuthority` needs `writerEpochAuthority`, which its last commit does not
  pass, and task files live under `<claudeRoot>/tasks/`, which the Product container mounts
  read-only. See the single task writer item under post-MVP simplifications.
- **Owner Bun 1.4.x for half-open owner-bound exchanges.** Bun 1.3.11 ignores `allowHalfOpen`, so
  Product writes one frame without a write-side EOF and the Owner closes on any byte after it.
  After the upgrade Product may again end its write side before the Owner starts the mutation.
- **Bun 1.3.11 segfault after the Owner hosted-control suite.** Bun itself can crash
  (`panic: Segmentation fault`, exit 132) after all tests passed; rerun before treating it as a
  failure, and recheck it after the Owner Bun 1.4.x upgrade.
- **Owner copy of the controller board-state file lock.** The Owner task writer ports
  agent-teams-controller `fileLock.js` (record, transition gate, `pidns:` line) to share
  `<team>/board-state` with agents; it goes away once L1 leaves a single task writer.
- **OIDC/Keycloak sign-in, multiple users, roles.** Desktop is one local user; MVP is one operator
  with personal pairing. Agent launch in the OIDC profile stays fail-closed.
- **OpenCode fork approval patches and the v4 per-team approval route producer.** Part of manual
  approval, already deferred above.
- **Browser E2E for concurrent two-tab renewal, lost rotated-cookie response, predecessor grace,
  replay-family revocation.** Hardening beyond one operator; the implementation and its
  unit/integration tests stay.
- **Adversarial process matrix: double-fork, ignored `TERM`, PID reuse, escaped descendants.**
  Desktop stops agents with a process-tree kill; MVP keeps stop, `TERM`/`KILL` escalation and zero
  survivors after stop and container replacement.
- **Workspace swap races: concurrent symlink, rename, registration-root, bind-mount swaps.** Only
  matters against a hostile same-UID runtime, which `trusted_process` excludes; traversal,
  stale-grant and out-of-sandbox rejection stay.
- **Two-container kernel-exclusion E2E matrix (paused winner, deleted diagnostics, path
  recreation).** Desktop relies on a single-instance lock; the instance lease and its focused tests
  stay.
- **Reference-scale reconnect/lifecycle benchmark, load and chaos platform.** Desktop has no such
  gate.
- **Full AST parity ledger over every TeamsAPI, ReviewAPI and CrossTeamAPI member.** Full-parity
  inventory; MVP needs capability conformance for mounted Core controls only.
- **Formal keyboard/focus accessibility gate.** Desktop has no such gate; localization of new text
  stays.
- **Excluding `config.json` from the task-board revision when `members.meta.json` exists.** Native
  runtime spawn-claim writes then cost a retryable `stale_revision` on task mutations, not data.
- **Task-board invalidation on `config.json`/`members.meta.json` changes
  (`parked/hosted-roster-board-invalidation`).** Catalogue both files under a `roster`
  external-writer feature key whose reconciler never parses them and never returns `invalid`, emit
  `team.roster.external_file_observed`, and project it to the task-board invalidation. Until then a
  create rebases itself once, updates and moves reload the board on `stale_revision`, and board
  reads retry.
- **Monotonic operator readiness revision before enabling manual approval.** The approval
  production readiness source publishes `revision: ready ? 2 : 1`; when a failed pump drops
  `recovered` back to false the revision moves backwards and the readiness route answers
  `stale_revision` (503) until recovery. Count state changes instead.

## Post-MVP single-user simplifications

Source: [scope lock decision 8](hosted-web-core-v1-scope-lock.md#owner-decisions-2026-09-25). These
remove complexity that a single-operator deployment does not need, but each takes days and touches
the live Product-Owner path or both repositories, so none is an MVP gate. Line counts are estimates
from the 2026-09-25 audit.

- **One task writer through the desktop controller core.** Board task rules exist three times:
  `agent-teams-controller` (`kanbanStore.js`, `tasks.js`), Product `hostedTaskBoardKanbanState.ts`,
  and the Owner `HostedTaskMutationService`; the task-board generation and revision identity is
  duplicated byte for byte across both repositories. Target: one writer applies the controller
  task-board core under `<team>/board-state` with an expected-revision precondition (Tier A), then
  the Owner `task_mutate` operation and the Product WAL, grant, takeover, ledger, and writer-currency
  stack go away (about 5k production and 5k test lines). Two options: Product becomes the writer,
  which needs a write mount for `tasks/` on the internet-facing container and an explicit owner
  decision; or the Owner writer delegates to the controller that already runs on the host for MCP.
- **One message exchange instead of `message_persist` plus `message_deliver`.** Derive the message
  ID from `clientMessageId`, keep idempotency on the inbox row, and drop `HostedMessageFileStore`.
  Idempotency then also survives a Product restart; today the record path hashes `bootId` and
  `restoreGeneration`. Both repositories, about -400/+150.
- **One HMAC frame format.** Readiness, lifecycle, task, and message exchanges use one raw-frame
  proof format; remove legacy readiness, the legacy `protocol.ts` proof, and the string runtime
  configuration (`HostedControlRuntimeConfig.ts`).
- **Product E2E against the real Owner.** `test/fixtures/hosted-v1/seedContainer.ts` (about 7.3k
  lines) fakes the Owner, which is why wire drift has surfaced only on live stands. Run the pinned
  Owner binary in the hosted E2E instead.
- **Owner high-water in Product.** About 1.3k lines keep a restarted Product from accepting an older
  Owner generation, while the Owner already refuses a second readiness lease of its single-use
  session and `hostedctl` starts and stops the pair together. Remove it only after a recovery
  analysis proves the pair lifecycle covers every restart order.
- **Deferred profiles outside the production graph.** Move manual approval (Product about 14.5k,
  Owner about 4.6k lines) and the isolated, root-daemon, and Qwen gateway profile (Owner about
  12.5k lines) into packages the production composition does not import. Move, do not delete.
- **Mixed-provider teams (scope lock decision 9).** Owner native spec with a per-member `provider`
  (the Owner `teamBootstrapSpec` already parses one), credentials for several providers in the lane
  environment, launch order "native lead, then OpenCode lanes" instead of parallel lanes, then lift
  the refusal on both sides (`hostedLaunchTopology.ts`, Owner `NativeHostLocalLanePlan.ts`) and add
  the mixed-team live E2E with Claude, Codex, and OpenCode together.
- **Desktop parity of delivery text and OpenCode lane evidence.** Native hosted recipients get the
  raw message without the desktop reply protocol (`buildMessageDeliveryText`) or lead roster and
  action-mode blocks; share that wrapper. Make the Owner the single implementation of OpenCode lane
  evidence and member inbox relay for desktop and hosted, and add `role` and `agentLanguage` to the
  hosted draft.
- **Agent language for hosted teammates.** Desktop always sets `lead.agentLanguage` (the saved
  setting, else the system locale), so every teammate prompt carries "IMPORTANT: Communicate in
  <language>...". Hosted drafts carry no language, so hosted teammates miss that line; it is the only
  difference in the normalized bootstrap request, pinned by
  `docs/hosted-native-bootstrap-parity-golden.json`. The fix carries the language in the launch plan
  from Product to the Owner (or lets the Owner resolve it) and updates that golden on both sides.
  Whether it enters the MVP is an open owner question.

## Not deferred

Stopped-stack backup and restore, including integrity checks, authority rotation, fresh mount
bindings, and a production-shape restore drill, remain Hosted MVP release requirements.

The desktop-parity core also stays: team create/launch/stop/recover and restart, core tasks and
messages, pairing/logout/forget-device/host reset, registered-workspace containment, SSE resync,
basic status/errors with redacted logs, and the Linux Compose/Caddy browser E2E.

## Verification policy

Hosted browser E2E uses the built Linux Docker Compose/Caddy deployment and Chromium against only a
genuinely disposable, newly created sandbox project. Windows coverage runs in Actions. If the Hosted
server is overloaded, isolated macOS sandbox tests and a macOS build are allowed as fallback evidence
for platform-neutral behavior; Linux-specific proofs still run on Linux. Never use real projects or
local agent workers.
