# Outbox Worker Runbook

## Scope

Phase 4 worker processes only fake/no-op handlers. Real GitHub, messenger, or
billing side effects remain future phases.

## Controls

```text
CONTROL_PLANE_OUTBOX_WORKER_ENABLED=false
CONTROL_PLANE_WORKER_SHUTDOWN_TIMEOUT_MS=30000
```

Disables new outbox claims while leaving the API and DB available.
Shutdown waits for in-flight fake handlers only up to the configured timeout.

## Claim Safety

Outbox rows move from `pending` to `processing` with:

- `locked_by`
- `locked_until`
- `claim_token`

Completion, retry, and dead-letter updates must match all three fields. If a
lease expires and another worker reclaims the row, stale completion updates
affect zero rows.

## Recovery

The worker recovers stale `processing` rows before claiming new work. Final
stale attempts move to dead-letter state.

Do not manually delete `processing` rows. First disable worker claims, inspect
dead letters and locks, then retry or cancel with an explicit operator action.
