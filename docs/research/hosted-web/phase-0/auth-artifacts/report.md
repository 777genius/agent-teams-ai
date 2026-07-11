# Phase 0 W6 auth, proxy and artifact truth

Phase start `a32f509e6d9bd31ba2135940e336729bf90c3d93` was verified before edits. This
lane characterizes the required fail-closed design; it does not enable authentication, CORS, routes,
cookies, migrations or hosted terminal behavior.

## Findings

- The executable ADR-7 model covers pairing, durable one-device authority, restart, idle/absolute
  session expiry, forward-only device rotation, response loss, two-tab contention, replay-family
  revoke, logout/forget-device, missing keyring and host reset after runtime drain. It stores only
  symbolic record references. Expiry, logout, forget-device, replay revocation and every durable reset
  stage remain mutation-closed across restart. Reset and initial pairing accept only the exact W4
  ready/drained protocol record from current trusted control-channel provenance; invented W6
  generation/count shapes, stale protocol/runtime generations, residuals and unclassified outcomes
  fail closed. W4's production executable emitter remains a paired-lane dependency. Exact timers and
  real SQLite/keyring/browser crash schedules remain for target verification.
- The proxy model accepts only one immutable HTTPS `PUBLIC_ORIGIN` through an exact trusted peer. It
  rejects direct HTTP, forwarded spoofing/ambiguity, wildcard CORS, sibling authority, cross Origin and
  missing Origin before cookie lookup, body parsing or idempotency claim. Deployment CIDRs and edge
  product remain unresolved.
- Fastify `5.8.5` and `@fastify/cors` `11.2.0` are installed. `@fastify/cookie` is absent. ADR-7's
  plan-time official reference is `11.0.2`; Phase 1 must recheck official Fastify-5 compatibility and
  pin exactly. The plugin may parse opaque selectors only; server rows remain authority.
- A targeted current server build passed and emitted seven CJS files. The standalone graph does not
  emit the required `internal-storage-worker.cjs`, but does emit the broad Electron fake (including
  fake `safeStorage`) and a `PtyTerminalService` marker. Every `.node` import is still catch-all stubbed
  to `{}`; the copied terminal Node package is itself an install-time unavailable stub, and standalone
  also uses updater/SSH service stubs. These are ADR-17 inventory gaps, not optional warnings.
- Node `24.16.0` is module ABI `137`; Electron `40.10.0` is ABI `143`. The production worker imports
  `better-sqlite3` `12.11.1`; a separate Node-only test alias is `12.10.1`. Both Node smoke queries
  returned SQLite `3.53.2`, but no final-image load or Electron ABI load was proved.
- The reconciled proposed manifest uses W4's `/opt/agent-teams/bin/*` paths, protocol/source hashes and
  `w4-native-c17-v1` recipe. Its gate now rejects omission or conflict in protocol/source hashes,
  builder/compiler/ABI, UID/GID/mode, strip/two-build evidence, init placement, seccomp/load probes and
  compiler/source/header/object/cache absence. These facts are declared but null/pending, so release
  availability stays false until the exact final image supplies them.
- Terminal routes and terminal-named internal-storage migrations are absent from the current HTTP
  registration/migration source. V1 terminal absence still fails: terminal SDK/gateway dependencies
  are production dependencies copied wholesale into the image, and the emitted server contains the
  terminal service. The current standalone artifact must not be relabeled as the v1 hosted artifact.

## Required Phase 1 gates

1. Emit server, renderer and internal-storage worker from one explicit hosted manifest; copy/probe
   every required native/helper artifact and fail on Electron imports, unstaged native addons or
   missing required workers. Populate every pending W4 build/image metadata field and rerun W4 probes
   against that exact digest; a structurally complete proposed contract is not artifact availability.
2. Split Node-hosted and Electron native resolution and smoke `better-sqlite3` in each final runtime.
3. Produce an allowlisted v1 image manifest that omits terminal daemon, gateway, SDK, routes,
   migrations, service marker and related volumes/ports, then run the negative scanner on that image.
4. Run auth/proxy schedules through an ephemeral HTTPS edge/container. The present sandbox denied a
   loopback listener with `EPERM`, so those claims remain `fixture_characterized`, not
   `target_verified`.

The W6 input for `EST-HOSTED-OPS` is 2.2k-3.3k production lines and 1.0k-1.6k test
lines, with 0.1k-0.25k deletions, medium confidence. It excludes generated/vendor output, W4 host
primitives, W2 runtime ingress and controller-owned generic route/catalog work.
