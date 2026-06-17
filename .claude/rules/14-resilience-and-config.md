---
paths:
  - "src/**/*.{ts,js,py,go,rs,dart,kt,java}"
  - "lib/**/*.{ts,js,py,go,rs,dart,kt,java}"
  - "**/*.env*"
  - "**/config.*"
  - "**/docker-compose*"
---

# Resilience and Configuration

External dependencies will fail. Configuration must be externalized.

## Resilience

- Every external call must have a **timeout**. No indefinite waits.
- **Critical** deps: fail visibly, return error. **Non-critical**: log, serve cached/default, degrade gracefully.
- **Circuit breakers** for repeatedly failing deps. Exponential backoff.
- **Retries**: bounded, exponential backoff + jitter, idempotent operations only. Non-idempotent mutations require an idempotency key.
- Make degradation **visible**: log it, expose in health check.
- **Health checks**: verify actual dependency connectivity, not just "process running."

## Configuration

- Externalize all config. Document every knob: purpose, default, valid range, environments.
- Sensible defaults — runnable with zero config for local dev.
- Maintain `.env.example` with all variables and descriptions.
- Validate required config at startup — fail fast. Log effective config (secrets masked).

## Graceful Shutdown

- Stop accepting new requests, drain in-flight work, release resources (12-Factor IX).
