---
paths:
  - "src/api/**/*"
  - "src/routes/**/*"
  - "**/*controller*"
  - "**/*endpoint*"
  - "**/*handler*"
  - "**/openapi*"
  - "**/swagger*"
---

# API Contract Discipline

Define the contract before implementation.

## For Every Endpoint, Define First

- Route/method, request schema (fields, types, required/optional, validation), response schema (success + error shapes), status codes, auth requirements.

## Rules

- The contract is the source of truth. Frontend, backend, and tests build against it.
- Flag breaking changes explicitly. Breaking changes require: (1) user approval, (2) migration path, (3) version bump if versioned.
- Use schema validation in code (Zod, Pydantic, JSON Schema, protobuf).
- Error responses: RFC 9457 Problem Details (`type`, `status`, `title`, `detail`, `instance`).
- Mutation endpoints must declare idempotency contract.
- Define pagination strategy: cursor vs offset, default/max limit.
- Present the contract for review before implementing.
