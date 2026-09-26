# Hosted Web Core v1 Scope Lock

- Decision date: 2026-07-30
- Amended: 2026-09-25 by [owner decisions](#owner-decisions-2026-09-25); decisions 9-11 revised
  2026-09-26
- Status: accepted product-scope constraint
- Applies to: hosted-web planning and implementation after PR #252
- Does not do: authorize a phase, worker, merge, deployment, or product mutation

This document narrows the hosted-web release to one usable, secure core. It prevents historical
full-parity plans from expanding the release and prevents later workers from deleting or rebuilding
already implemented seams merely because production composition is not finished.

## Authority and conflict resolution

Use these sources for different questions:

1. Repository safety and architecture guardrails remain authoritative.
2. `docs/hosted-web-phases/START_HERE.md` and `EXECUTION_INDEX.json` remain authoritative for current
   execution status, ownership, and admission.
3. This file is authoritative for Core v1 product scope, simplifications, and preservation decisions.
4. The [Hosted v1 runtime and release topology](hosted-v1-runtime-release-topology.md) records the
   accepted legacy/Hosted merge, artifact, release, rollback, and future-runtime separation. It is
   not execution or activation authority.
5. `docs/hosted-web-e2e-completion-plan.md` remains design reference where it does not conflict with
   this scope lock.
6. `docs/hosted-opencode-downstream-policy.md` records the official upstream OpenCode runtime
   decision for hosted Core v1 and Electron, and the deferred downstream approval work.
7. Phase packets, `.codex-handoff`, and `docs/research/hosted-web` remain retained evidence. They are
   not current product scope or execution authority unless the live router explicitly activates them.

If an older table says that full TeamsAPI parity, automatic adoption, browser-local command receipts,
per-session subscription leases, or full recovery descriptors for every mutation are required in v1,
this scope lock wins.

Do not edit the current live-head sync router to apply this decision. Regenerate a future executable
packet from this scope only after the router admits that work.

## Owner decisions 2026-09-25

Principle: **Hosted MVP is desktop parity, not new features.** Hosted MVP makes the capabilities that
already exist in desktop usable from a browser on a self-hosted server. It does not add capabilities
desktop lacks. Where desktop does something one simple way and this plan extended it, Hosted MVP
uses the simple way. Security work is limited to what a remote single-operator deployment needs.
This section wins over any conflicting text below and in the master plan.

1. **MVP is personal self-hosted.** One trusted operator on their own dedicated server, signing in
   through personal pairing (see [Authentication and deployment](#authentication-and-deployment)).
2. **Agent runtime is `trusted_process` through host-local lanes in the Owner
   (`agent_teams_orchestrator`)**, per ADR-30 in the master plan. Per-member container isolation
   through a root daemon (Owner `docs/hosted-opencode-container-isolation-design.md` and
   `deploy/hosted-root-daemon/README.md`) is a post-v1 hostile-runtime profile. The host-local
   lanes stay behind the trusted-profile gate.
3. **OIDC/Keycloak and multi-user are post-v1.** The Compose profile may stay, but agent launch in it
   is fail-closed.
4. **Phase 03 r6 does not block the MVP.** Actual-owner approval admission and the OpenCode fork
   approval patches are deferred together with manual approval. The r6 packet is parked, not adopted.
5. **The "one heavy job per host" rule is cancelled.** Isolated E2E and unit runs may run in parallel.
6. **Supported providers are OpenCode, Claude Code, and Codex.** All three run through host-local
   lanes in the Owner under `trusted_process`. Gemini is out of scope for hosted: it is not
   planned for v1 or later, is not a deferred item, and is never advertised. The per-provider live
   smoke below is mandatory for these three providers. Mixed teams are in MVP (decision 9).
7. **Accepted `trusted_process` pairing risk.** ADR-30's "no live or adoptable runtime while a
   plaintext pairing file exists" rule is enforced in one direction only: Product refuses `launch`
   while the pairing file exists. The other direction is not proven, and a first pairing code (no
   active device yet, or every device expired) can appear next to a live agent runtime:
   - a Product restarted alone publishes the code at startup, before it tries the Owner; the old
     Owner refuses the second readiness lease of its single-use session, so Product never becomes
     ready, but the file already exists while that Owner's agents run;
   - a persistent OpenCode host is spawned detached and outlives a crashed Owner; the next Owner
     adopts it on its first inspect (control state or inbox recovery), not through `recover`. A
     persistent host can also stay alive without a run, retained for adoption.

   Under `trusted_process` this grants an agent nothing new: it already runs as the Owner's OS
   user and can read Product's container state through `/proc/<pid>/root`. Mitigations: `hostedctl`
   starts and stops Product and Owner only as a pair, and before pairing again the operator stops
   the agents and restarts the pair gracefully (`systemctl restart agent-teams-hosted`). The signed proof protocol is deferred to
   the isolated profile (see [Hosted MVP deferred TODOs](hosted-web-mvp-deferred-todos.md)).

8. **MVP is single-user, like desktop: complexity that only a multi-user, multi-writer, or
   hostile-runtime deployment needs is not added, and such complexity already on the live path is
   simplified.** Hosted MVP serves one paired operator, exactly as desktop serves one local user.
   New hosted work must not add mechanisms whose only purpose is multiple users, tenants, or
   concurrent writers, hostile-runtime isolation, or compatibility with wire and file formats that
   no hosted release ever shipped (no hosted release or tag exists yet). Where such a mechanism
   already sits on the live Product-Owner path, prefer one format per exchange, one writer per
   resource under the same lock desktop uses, and shared desktop logic over a hosted
   re-implementation; do not duplicate code to get there. This does not relax the real boundary:
   the internet-facing Product container stays untrusted relative to the host, Owner accepts only
   its closed, strictly decoded operation set over the launcher-bootstrapped channel, the bootstrap
   stays signed, and browser access stays behind personal pairing, Origin/CSRF, and secure cookies.
   Deferred-profile code (manual approval, per-member containers, root daemon) stays preserved per
   the [preservation map](#preservation-map) but out of the production import graph. A
   simplification that touches code shared with desktop requires a focused desktop regression test.
9. **Mixed-provider teams are in MVP.** This replaces the earlier one-provider-per-team rule. Mixed
   native Claude Code and Codex teams come first, then a native lead with OpenCode members, then
   agent-to-agent relay across lanes. Until Product and Owner both admit a combination, launch
   refuses it and the UI does not advertise it. The mixed-team live E2E with Claude, Codex, and
   OpenCode together is an MVP release gate.
10. **The trusted Owner is the only task writer, through the same controller as desktop.** Board
    task mutations go through the Owner, which runs `agent-teams-controller` as a node child from
    the same MCP bundle desktop uses, in `--hosted-task-command` mode. The Owner's own WAL, ledger,
    and copies of the controller lock and task-board formulas are removed, and so is the unused
    Product task writer. The internet-facing Product container gets no write access to `tasks/`;
    its `.claude` mount stays read-only except `teams/`.
11. **The Owner message pump is the only message relay.** It picks up inbox lines from any sender
    (browser operator, lead, or teammate) and delivers them; there is no second relay path.

Release gates cut by this decision (their code and focused tests stay; only the extra gate goes;
details in [Hosted MVP deferred TODOs](hosted-web-mvp-deferred-todos.md)):

- proof group 1: concurrent two-tab renewal, lost rotated-cookie response, predecessor grace and
  replay-family revocation browser E2E; pairing, restart, logout, forget-device, host reset,
  Origin, CSRF, cookie, Host and forwarded-header checks remain;
- proof group 2: adversarial double-fork, ignored `TERM`, PID-reuse and escaped-descendant matrix;
  stop, `TERM`/`KILL` escalation and zero surviving provider processes after stop and container
  replacement remain;
- proof group 6: concurrent symlink, rename, registration-root and bind-mount swap races; registered
  workspace selection, traversal, stale-grant and out-of-sandbox rejection remain;
- the reference-scale benchmark and every signing, SBOM, attestation, provenance or stack-manifest
  release step beyond pinned exact Owner, official OpenCode, and provider CLI artifacts.

## Core v1 release

Core v1 must provide one complete browser workflow:

1. deploy the supported production profile;
2. pair and authenticate a trusted browser;
3. select only a registered workspace through opaque identity;
4. list and inspect teams;
5. create and configure a draft with its initial roster, using any one supported agent runtime
   or a mixed team (decision 9), without a preset-only restriction;
6. prepare, launch, observe, reconnect, stop, and safely resume after a complete supported container
   restart;
7. create, assign, update, and move tasks through the core Kanban flow;
8. send and receive team messages;
9. inspect basic runtime status and errors plus bounded, redacted server logs; and
10. log out, forget the current device, or reset access from the host.

Every advertised action must work through the real hosted composition and have route/client
conformance plus focused contract or integration proof. Real-browser E2E validates the complete
workflow and the critical security, recovery, realtime, and process-ownership boundaries; it is not
duplicated once per action. An incomplete capability stays unadvertised and unmounted.

The release does not require every historical Electron team screen or every TeamsAPI method.
Desktop behavior and shared feature code remain supported and tested even when their hosted
integration is deferred.

Hosted MVP supports automatic tool approval only. Manual approval mode is temporarily unavailable
at Hosted create, update, promotion, and activation boundaries. The server must return an explicit
unsupported/unavailable result; it must never rewrite a manual selection to `auto`. Persisted manual
records remain parseable and readable so desktop/shared compatibility and future migration are
preserved, but they cannot be promoted or activated. The existing approval implementation remains
in place, unmounted and deferred. Its later acceptance criteria are tracked in
[Hosted MVP deferred TODOs](hosted-web-mvp-deferred-todos.md).

## Deferred hosted expansion

The following are not Core v1 release gates:

- full change-review/read/apply UI;
- attachments and rich preview lifecycle;
- task comments, relationships, and clarification beyond the core task workflow;
- live member add/replace/remove/restore/restart/skip after initial team creation;
- post-creation roster and settings editing; initial draft roster/settings editing remains in Core;
- manual approval mode and its browser decision workflow;
- browser member-log views and advanced diagnostics; basic status/errors and redacted server logs
  remain in Core;
- soft-delete restore, permanent delete, and identity-repair UI; explicit draft discard may remain;
- cross-team administration;
- automatic startup adoption or repair of legacy team identity;
- a bundled Keycloak deployment or release-gated Keycloak integration; OIDC sign-in, multiple users
  and roles;
- per-member container isolation, the root container daemon, and runtime attestation;
- hosted terminal, WebSocket transport, Centrifugo, or a terminal daemon;
- multiple hosted writers, horizontal replicas, or multi-tenant isolation.

Existing implementations of these capabilities are not dead code. Preserve their public feature
boundaries, tests, desktop adapters, and reusable core. Do not production-compose or advertise the
deferred hosted facet until a later scope decision and focused E2E gate promote it.

## Preservation map

The baseline below distinguishes implemented assets from production readiness.

| Existing asset                                                                 | Decision | Core v1 use                                                                                               |
| ------------------------------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------- |
| Hosted lifecycle read contracts, route, composition, and renderer list         | `KEEP`   | Continue the list/detail vertical slice; do not replace it with another hosted facade.                    |
| `ReadOnlyWorkspaceManifestAdapter` and workspace identity/grant contracts      | `KEEP`   | Use for registered workspace selection and read admission.                                                |
| `application-command-ledger` core, storage, and current task-create wiring     | `KEEP`   | Reuse for HTTP retry/status where useful; do not replace it.                                              |
| Lifecycle/runtime durable descriptors for launch, cancel, stop, and recover    | `KEEP`   | These are Tier B external workflows and retain effect recovery.                                           |
| Hosted team-task-board contracts, routes, policies, and tests                  | `KEEP`   | Compose only the Core v1 task operations; retain the broader surface unadvertised until promoted.         |
| `hosted-access` contracts/core                                                 | `KEEP`   | Compose pairing, device, session, logout, forget-device, and host reset first.                            |
| `TeamIdentityFileStore`, `TeamDirectoryLifecycleAdapter`, backup compatibility | `KEEP`   | Reuse as identity/import infrastructure; do not wire automatic startup mutation or repair.                |
| Roster adoption and identity reconciliation primitives                         | `KEEP`   | Preserve stable IDs and read diagnostics; mutation is explicit and offline when later exposed.            |
| Review, attachment, member recovery, destructive, and cross-team feature code  | `KEEP`   | Preserve desktop/shared behavior; hosted production composition is deferred, not deleted or re-created.   |
| Hosted manual approval storage, transport, activation, and reconciliation code | `KEEP`   | Preserve it unmounted; do not activate it or translate manual records to automatic mode in Hosted MVP.    |
| `.codex-handoff` and hosted research/evidence trees                            | `KEEP`   | Retained historical evidence; do not bulk-delete, rewrite, or require every new worker to read all of it. |

Before changing an existing asset, inspect whether it is production-composed, exported only, or
test-only. “Not production-composed” means integration remains; it is not permission to duplicate
the feature or remove its tests.

## Two mutation tiers

Do not apply the full external-effect recovery protocol to every mutation.

### Tier A: local transactional mutation

Use this tier when the mutation is fully app-owned, commits in one SQLite transaction or one
revision-checked local write, and cannot leave an ambiguous external effect.

Required:

- validated input and authorization;
- expected revision or equivalent conflict guard;
- transaction/atomic write;
- typed result and safe retry behavior.

The existing application command ledger may be used for HTTP idempotency or command-status lookup.
Tier A does not require an `EffectDescriptor`, attempt lease, compensation saga, HMAC descriptor
catalog, or operator recovery state unless a concrete external ambiguity proves the need.

### Tier B: durable external workflow

Use this tier for process launch/cancel/stop/recover, provider/runtime delivery, destructive
filesystem effects, or another operation where a crash or lost response can duplicate or orphan an
external effect.

Tier B keeps the full durable command descriptor, evidence, effect-recovery classification,
stable workflow reference, and explicit `operator_required` outcome when absence cannot be proven.

The retained, deferred approval actual-owner admission is a two-generation lifecycle. The first owner generation may
publish only launcher-signed `provisioning` or `restart_required` state. Product approval routes
remain unmounted in both states. A later owner generation may publish `active` only when the same
launcher-signed lifecycle admission binds the exact approval snapshot SHA-256 digest, approval
generation, and current owner generation. Product must never derive ingress authority from an
owner-writable workspace or `.claude` JSON file. The active snapshot routes authority by its
immutable `partition.teamId`; there is no process-wide fixed team.

The cross-repository lifecycle launch wire continues to carry explicit `toolApprovalMode: 'auto' | 'manual'` for compatibility.
`manual` is required to create pending hosted permission requests; legacy create callers default to
`auto`, while persisted v2 runtime plans require the field explicitly. Approval decision settlement
uses terminal `operator_required` plus a stable `reconciliationRef` when provider acceptance is
ambiguous. That record is neither automatically retried nor acknowledged; only the bounded
reconciliation operation may resolve it. Durable reconciliation is bound to the exact workspace,
authority and restore generations, team/run partition, approval generation, delivery generation,
provider delivery ID, and stable reconciliation reference. `delivered` closes the outbox;
`not_delivered` is the only outcome that authorizes a new pending lease and retry.
Before crossing the provider boundary, storage atomically moves the exact leased delivery generation
into `operator_required`, pins its stable reconciliation reference, and extends the fenced lease
beyond the maximum owner exchange timeout. A crash, timeout, or unavailable response therefore
remains reconciliation-only even after lease expiry; it never returns to normal delivery claim.
The explicit reconciliation call is unavailable while that boundary lease is still open, preventing
`not_delivered` from racing an in-flight provider call.

Promoting a command from Tier A to Tier B requires a named crash/response-loss scenario. Do not
promote an entire feature preemptively.

## Legacy identity import

Core startup may scan, classify, and show diagnostics for legacy teams, but it must remain read-only.
It must not publish identity files, repair SQLite rows, rename directories, or silently attach a
directory by name.

Any later import/adoption flow is explicit and operator initiated:

1. stop the hosted controller and prove no active or unclassified runtime owns the team;
2. scan and show a preview with collisions and ambiguity;
3. require explicit confirmation;
4. perform the existing identity protocol;
5. restart and reconcile.

This keeps the already implemented identity machinery useful while removing automatic startup
mutation and its recovery UI from Core v1.

## Realtime and browser recovery

Core v1 uses HTTP queries plus one authenticated SSE stream with durable cursors and bounded
snapshot/resynchronization. It does not introduce a WebSocket abstraction, Centrifugo, or a
transport-switching adapter before a second transport is required.

This is still realtime: SSE pushes browser-visible lifecycle, task, message, readiness, and bounded
invalidation/reference events as they happen. Large log, tool-activity, review, and file payloads are
fetched by paginated HTTP query when their view is open.

Build on the existing `coordination-events` journal, replay, snapshot, and cursor contracts and keep
their tests. Do not replace them with a second event store or transport-neutral framework. Hosted
work adds only the missing authenticated SSE adapter, composition, and browser reconciler.

Do not add a durable per-session subscription lease or tracking flag for Core v1. Correctness must
not depend on which browser panel is visible.

Command recovery is server owned. The browser may query recent/non-terminal commands for the
authenticated operator and action. It must not persist a command body, prompt, idempotency key,
pending-command locator, or replayable receipt in `localStorage`.

Realtime release proof must cover snapshot-to-stream handoff, duplicate and gap handling, retention
expiry, reconnect, controller and complete production-container restart, slow consumers, and bounded
full resynchronization. A lost SSE connection may delay the UI, but it must not lose canonical state
or require a process restart.

## Verification without matrix explosion

Core v1 reduces duplicated harnesses and cross-product combinations, not behavioral coverage.

### Deterministic pull-request gates

- Keep focused domain, application, persistence, HTTP, SSE, security, and process-ownership tests.
- Exercise every supported provider through deterministic adapter, capability, parser, launch,
  cancellation, and cleanup tests below the real process-supervisor boundary.
- Keep existing desktop regression gates. Changes to shared application, provider, parsing,
  persistence, IPC, or runtime code add focused desktop regression tests; hosted work must not delete
  or bypass the existing desktop suite.
- Prove capability conformance from server manifest to registered route, client facet, rendered
  control, and test ID. Negative tests prove that an unavailable capability registers no route,
  listener, effect, or control.

### Real-browser Core v1 gates

Use independently runnable suites against the built production composition and only newly created
sandbox projects. A shared harness may reuse the built deployment, but suites must not depend on
execution order or state left by another suite.

The minimum proof groups are:

1. pairing, session renewal, logout, forget-device, host reset, Origin, CSRF, cookie failures,
   concurrent two-tab renewal of one device generation, lost rotated-cookie response, bounded
   predecessor grace, post-grace replay-family revocation, fixed public authority and Host policy,
   spoofed `Forwarded`/`X-Forwarded-*` rejection, and denial of direct access to the private app
   listener;
2. create, prepare, launch, progress, cancel/stop, and provider failure, including anchor failure,
   double-fork, ignored `TERM`, parent or main-process exit before descendants, `TERM`/`KILL`
   escalation, descendant drain, PID-reuse refusal, ambiguous residual ownership, hard container
   replacement, and zero surviving provider processes;
3. Tier B response loss before or after acceptance, server-owned recent/non-terminal lookup after
   reload or logout/re-login, stable workflow reference, mismatched-body conflict, and no duplicate
   external effect;
4. SSE snapshot handoff, disconnect/reconnect, reload, retention resync, and controller plus complete
   production-container restart;
5. core task/Kanban and messaging flows, including revision conflict and an external writer;
6. workspace registration and containment, including traversal, stale-grant, and out-of-sandbox
   rejection plus concurrent parent/final symlink, registration-root, rename, and bind-mount swaps
   across file, Git, and provider-spawn effects with zero effect outside the sandbox marker;
7. capability degradation and recovery with no hidden desktop listener or unavailable browser call;
8. real lane-scoped runtime ingress, proving credential absence from the provider process tree,
   replay protection, rotation and revocation, fixed run/lane/provider scope, wrong-body rejection,
   and no cross-lane callback impersonation;
9. manual-approval unavailability at Hosted create, update, promotion, and activation boundaries,
   including historical records and exact replays: manual records remain readable and byte-for-byte
   unchanged, metadata-only updates and manual-to-automatic replacements are rejected without data
   or revision mutation, and no unavailable route, listener, control, provider effect, or automatic
   conversion is exposed. Provider authorization, credential isolation, per-team routing, custody,
   redaction, ambiguity/reconciliation, and process-ownership safeguards remain intact. Positive
   prompt, allow, deny, timeout, reload-recovery, and two-tab exactly-once decision workflows are
   deferred until the acceptance criteria in
   [Hosted MVP deferred TODOs](hosted-web-mvp-deferred-todos.md) are promoted; and
10. initial-roster configuration for each supported runtime and each admitted mixed composition
    without a preset-only path, refusal of a not-yet-admitted mixed combination at launch, plus
    basic status/error and bounded redacted server-log presentation.

These groups organize evidence; they do not replace the Core rows in the master plan's
`Real end-to-end verification design`. The same suites must retain stable TeamId and WorkspaceId
across failed-run retry and full restart, fresh mount generations and stale-reference rejection, all
advertised composite lane modes and ordering/partial-failure gates, verified external-file
attribution, app-exclusive/cooperative/uncoordinated writer rules, provider-mediated observed
outcomes, quiescent revalidation without stale replay, bounded logs and failure diagnostics,
independent readiness/admission failures, and built-artifact boundary checks. Expansion-only rows
remain deferred. Failure and chaos cases that prove these retained Core rows remain mandatory; shared
fixtures may remove duplication, but a happy path cannot replace an adversarial interleaving.

An advertised action requires focused contract/integration coverage and must be exercised by the
smallest relevant browser workflow. It does not require a separate browser test file or a complete
provider/topology/failure cross-product.

### Live provider and desktop release gates

Per [Owner decisions 2026-09-25](#owner-decisions-2026-09-25), the supported providers are
OpenCode, Claude Code, and Codex, and these gates are mandatory for all three. Gemini is out of
scope for hosted and has no gate.

- Core release proof uses one production-composed mixed-team E2E with Claude, Codex, and OpenCode
  together, plus one independent short live smoke for each provider. The mixed run proves
  cross-provider lifecycle, task/message, SSE, and cleanup behavior. Each smoke proves
  `create -> launch -> ready -> task -> message -> stop` with a single-provider team, so no
  provider-specific bootstrap, authentication, parsing, delivery, or shutdown failure can hide
  behind another provider.
- The provider-neutral proof groups above run once against the shared production composition; they
  are not multiplied across all supported providers. Provider-specific branches remain covered by their
  focused contracts and live smoke. This consolidation must preserve isolated roots, ports, volumes,
  evidence identities, and independent cleanup, and must not create an order-dependent mega-test.
- Before release, run one sandbox-only live smoke for every supported provider: Claude, Codex, and
  OpenCode. Every smoke proves
  `create -> launch -> ready -> task -> message -> stop`; one smoke per provider family is
  insufficient because authentication, flags, bootstrap, parsing, task/message delivery, and
  shutdown differ.
- Live provider smoke is manual or scheduled and is not required on every pull request. Pull requests
  use deterministic provider fixtures so all providers remain covered without flaky external calls.
- Run the project-defined full desktop regression and packaging gates before release. Do not create a
  second hosted copy of the desktop matrix.

Hosted browser release E2E runs on Linux against the built Docker Compose deployment with Caddy and
Chromium, using a genuinely disposable, newly created sandbox project. Windows coverage runs in
Actions. When the Hosted server is overloaded, isolated macOS sandbox tests and a macOS build may be
used as a fallback for platform-neutral confidence, but every Linux-specific proof still runs on
Linux. These gates never use real projects or local agent workers.

The following are not acceptable simplifications: one provider standing in for a family at release,
one order-dependent browser mega-test, mocked HTTP/SSE at the browser boundary, removal of existing
desktop regressions, or weakening `coordination-events` replay and recovery coverage.

## Small operational surface, retained recovery proof

Core v1 does not add a backup UI, scheduler, background backup service, Prometheus exporter, or broad
load-testing platform.

Backup and restore are not deferred. Core v1 ships a stopped-stack operator backup/restore path and
runbook. Proof must reject a running controller and partial archive, verify the manifest, checksums, and SQLite integrity, restore only
into an empty target, and complete one production-shape restore drill. After integrity validation and
before service exposure, restore must rotate boot, event, browser device/session, and runtime
authority, establish fresh mount bindings, and never reuse backed-up sessions or pairing tickets.
Archive creation must publish its ready marker last. Disk exhaustion, interruption, or power loss
must leave the incomplete archive unadvertised and preserve the previous known-good recovery point.

Minimum observability remains structured redacted logs with request and diagnostic IDs, live/ready
health endpoints, bounded log retention, and owned-process leak evidence. These are release
diagnostics, not a new metrics platform. The reference-scale reconnect/lifecycle benchmark is
deferred by the 2026-09-25 owner decisions.

## Authentication and deployment

The built-in Core v1 path is personal pairing:

- a one-time pairing code authorizes creation of a durable, hashed device family;
- the browser stores only Secure, HttpOnly cookies managed by the server;
- logout ends the current session;
- forget-device revokes the current device family;
- host reset advances the reset generation and revokes all device families.

Generic OIDC remains an extension seam, not a Keycloak-shaped domain dependency. Keycloak, if added,
runs as a separate service or optional Compose profile and connects through standard OIDC. Core v1
does not bundle, administer, back up, or require Keycloak.

The one release-gated deployment profile is Docker Compose with Caddy as the TLS edge, one private app
instance, one app-state volume, explicit workspace mounts, and SQLite. Nginx and Traefik may be
documented as compatible reverse proxies later, but they are not separate Core v1 E2E matrices.

## Documentation and implementation rules

- Do not use the old `24k-40k fresh branch` estimate as remaining-work truth. Re-estimate from the
  live PR head after this scope is integrated.
- Full-parity tables in the master plan are retained as expansion inventory, not Core v1 acceptance.
- Do not delete historical evidence to make the plan shorter. New workers should read this scope lock
  and the active packet, then open historical evidence only for the exact decision they need.
- Do not create a new `.codex-handoff` file unless the active execution packet explicitly requires it.
- Do not rewrite provider/runtime internals merely to make them look web-native. Reuse current public
  feature boundaries and add only the missing hosted adapter/composition.
- Security invariants around single-writer ownership, opaque workspace access, child environments,
  process ownership, secure cookies/CSRF, and sandbox-only E2E remain release blockers.

## Promotion rule

A deferred capability may enter Core v1 only through a new explicit product decision that includes:

1. why the core workflow is not usable without it;
2. the smallest hosted surface to promote;
3. expected implementation/test size;
4. security and recovery effect; and
5. a real-browser E2E acceptance path.

Without that decision, workers preserve the code and keep the hosted capability unadvertised.
Approval production admission remains fail-closed for legacy signed owner payloads. The v3
lifecycle owner admission is the current format: the launcher signs only v3, and a v3 admission
never mounts approval routes. The v2 admission is no longer accepted, because no hosted release
shipped it. The v4 admission stays read-compatible for the future approval producer, and its
routes mount only while manual approval is available. A future coordinated v4 producer must sign a canonical, non-empty, uniquely team-sorted per-team route set
that binds each team to its workspace, owner generation/socket identity, artifact, and exact wire
capability digest. Until cross-repository golden fixtures prove that contract, delivery storage is
team-filtered and lease-fenced foundation only; no owner-writable routing fallback is admitted.
