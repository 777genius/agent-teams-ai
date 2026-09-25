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

Hosted MVP retains configurable initial draft editing across all supported runtimes and mixed teams,
without enforcing presets. Editing roster or settings after team creation/activation is deferred.
Later promotion requires revision-conflict behavior, runtime-safe drain/restart semantics where an
external effect is possible, stable member identity, focused server/UI coverage, and disposable
sandbox browser E2E.

## TODO: browser member logs and advanced diagnostics

Hosted MVP keeps basic lifecycle status/errors and bounded redacted server logs. Per-member browser
logs and advanced diagnostics are deferred. Later promotion requires authorization and team/lane
scoping, bounded pagination/retention, redaction tests for credentials and filesystem details, and
built Linux browser E2E proving no cross-team disclosure.

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
- **Mixed four-provider live E2E and per-provider live smoke.** Waits for the open provider
  decision; with option A only the OpenCode smoke remains.
- **Full AST parity ledger over every TeamsAPI, ReviewAPI and CrossTeamAPI member.** Full-parity
  inventory; MVP needs capability conformance for mounted Core controls only.
- **Formal keyboard/focus accessibility gate.** Desktop has no such gate; localization of new text
  stays.

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
