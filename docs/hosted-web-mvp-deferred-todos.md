# Hosted MVP deferred TODOs

- Decision date: 2026-09-12
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

## Not deferred

Stopped-stack backup and restore, including integrity checks, authority rotation, fresh mount
bindings, and a production-shape restore drill, remain Hosted MVP release requirements.

## Verification policy

Hosted browser E2E uses the built Linux Docker Compose/Caddy deployment and Chromium against only a
genuinely disposable, newly created sandbox project. Windows coverage runs in Actions. If the Hosted
server is overloaded, isolated macOS sandbox tests and a macOS build are allowed as fallback evidence
for platform-neutral behavior; Linux-specific proofs still run on Linux. Never use real projects or
local agent workers.
