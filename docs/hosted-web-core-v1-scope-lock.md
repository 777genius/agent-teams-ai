# Hosted Web Core v1 Scope Lock

- Decision date: 2026-07-30
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
4. `docs/hosted-web-e2e-completion-plan.md` remains design reference where it does not conflict with
   this scope lock.
5. Phase packets, `.codex-handoff`, and `docs/research/hosted-web` remain retained evidence. They are
   not current product scope or execution authority unless the live router explicitly activates them.

If an older table says that full TeamsAPI parity, automatic adoption, browser-local command receipts,
per-session subscription leases, or full recovery descriptors for every mutation are required in v1,
this scope lock wins.

Do not edit the current live-head sync router to apply this decision. Regenerate a future executable
packet from this scope only after the router admits that work.

## Core v1 release

Core v1 must provide one complete browser workflow:

1. deploy the supported production profile;
2. pair and authenticate a trusted browser;
3. select only a registered workspace through opaque identity;
4. list and inspect teams;
5. create and configure a draft with its initial roster;
6. prepare, launch, observe, reconnect, stop, and safely resume after controller restart;
7. create, assign, update, and move tasks through the core Kanban flow;
8. send and receive team messages;
9. inspect bounded runtime status, logs, and failure diagnostics;
10. answer an approval when a supported provider operation requires an operator decision; and
11. log out, forget the current device, or reset access from the host.

Every advertised action must work through the real hosted composition and must have a browser E2E
proof against a new sandbox project. An incomplete capability stays unadvertised and unmounted.

The release does not require every historical Electron team screen or every TeamsAPI method.
Desktop behavior and shared feature code remain supported and tested even when their hosted
integration is deferred.

## Deferred hosted expansion

The following are not Core v1 release gates:

- full change-review/read/apply UI;
- attachments and rich preview lifecycle;
- task comments, relationships, and clarification beyond the core task workflow;
- live member add/replace/remove/restore/restart/skip after initial team creation;
- soft-delete restore, permanent delete, and identity-repair UI; explicit draft discard may remain;
- cross-team administration;
- automatic startup adoption or repair of legacy team identity;
- a bundled Keycloak deployment or release-gated Keycloak integration;
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

SSE carries lifecycle updates and bounded invalidation/reference events. Large log, tool-activity,
review, and file payloads are fetched by paginated HTTP query when their view is open.

Do not add a durable per-session subscription lease or tracking flag for Core v1. Correctness must
not depend on which browser panel is visible.

Command recovery is server owned. The browser may query recent/non-terminal commands for the
authenticated operator and action. It must not persist a command body, prompt, idempotency key,
pending-command locator, or replayable receipt in `localStorage`.

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
