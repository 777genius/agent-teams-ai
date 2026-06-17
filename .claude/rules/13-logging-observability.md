---
paths:
  - "src/**/*.{ts,js,py,go,rs,dart,kt,java}"
  - "lib/**/*.{ts,js,py,go,rs,dart,kt,java}"
  - "app/**/*.{ts,js,py,go,rs,dart,kt,java}"
---

# Logging and Observability

Structured, multi-consumer logging from the start.

## Architecture

- Terminal + OpenTelemetry (OTEL) output. Add syslog for daemons.
- Structured logging (JSON or key-value) — no free-form strings.
- App writes to stdout only (12-Factor XI). Environment handles routing.

## OpenTelemetry

- OTEL from the start unless user opts out. Traces, metrics, logs as three pillars — traces first for distributed systems, metrics first for monoliths.
- Use `OTEL_EXPORTER_OTLP_ENDPOINT` env var — never hardcode endpoints.
- Propagate trace context across service boundaries.
- Use OTEL semantic convention attribute names (`http.request.method`, `url.path`, `http.response.status_code`).

## Rules

- Incoming requests: log method, path, status, duration, trace ID.
- Outgoing calls: log target, method, status, duration, trace ID.
- Errors: log operation, sanitized input, stack trace, trace ID.
- Never log secrets, tokens, passwords, or PII.
