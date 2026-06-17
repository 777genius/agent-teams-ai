# Error Handling (PARAMOUNT)

Every error must be handled explicitly. Silent failures are the most dangerous bugs.

## Rules

- Handle every caught error: log, re-throw, return error state, or recover with documented fallback. Empty catch blocks are forbidden.
- Catch specific exceptions, not blanket `catch (e)`. Propagate errors to the level that can meaningfully handle them.
- Async: handle both success and failure paths. No unhandled rejections or fire-and-forget.
- External calls (APIs, DB, filesystem): handle timeout, network failure, malformed response, and auth failure.
- Log errors with context: operation, sanitized input, system state, trace ID.
- Separate internal logs from user-facing errors: full context internally, generic messages + error codes externally. Never expose stack traces or internal paths in responses (CWE-209).
- Never log credentials, tokens, PII, or session IDs (CWE-532).

## Project-Specific Patterns

Before writing error handling code, identify the project's established patterns:

- **Error types**: Custom error classes, error codes/enums, Result/Either types, or plain exceptions?
- **Propagation style**: Does the project re-throw, wrap, or convert errors at boundaries?
- **User-facing errors**: Error response format (JSON shape, HTTP status codes, error code registry).
- **Recovery patterns**: Retries, circuit breakers, fallbacks, graceful degradation — what exists?

Match what the project already does. If no pattern exists, propose one before implementing ad hoc.
