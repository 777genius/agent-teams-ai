# PR #982: native process_list bounded catalog (P2)

Scope: native MCP process_list only. Existing TeamProcessCommands remains authoritative for read/metadata writes. No registry, Desktop snapshots, signals, or provider selection changes.

## Observed failure

The original process_list exposes TeamProcessCommands.list() in one non-receipt MCP result. 100 accepted process rows with 4096-char commands serialize to ~443 KiB, exceeding formatToolResult's 256 KiB maximum. Projected registry currently permits 1024 rows.

## Implementation

1. Introduce a pure private `pageProcessCatalog` using serialized byte bounds of 240 KiB (including a 256-byte cursor reserve) and *whole projected rows*, preserving original ordering and all public metadata. Keep the original array for small responses and empty history.
2. Attach an unguessable per-tool-connection nonce to the cursor signature; bind the original port identity and entire collection digest. A continuation must re-run `process.list()` and reject changed collection, malformed signature, changed principal/Team connection or stale tool generation. No caller-provided member/team/root/PID filter.
3. Extend only `process_list` tool schema to an optional signed cursor. Large pages use `{kind:'process-catalog-page', processes, revision, total, nextCursor}`; subsequent calls concatenate complete rows until null. Reject any item larger than a page, rather than truncating its command.
4. Reuse the original MCP formatter (unchanged 256 KiB) and existing native process port. No extra persistence, background jobs, mutable cache, or administrative privilege.
5. Add focused tests for 100 valid projected 4096-character commands, complete history reconstruction and exact row identity, small/empty legacy arrays, changed/foreign/tampered cursor, actual formatter compatibility, oversized row refusal.
6. Run pinned Host strict build/typecheck/tests and exact-head native endpoint E2E; do not declare success based on source-only checks or queued CI.

## Critique R1 - source authority

Every page invokes the originally captured TeamProcessCommands.list() with its existing store fence and read grant. The signature includes the read revision and per-port nonce; it cannot authorize a new owner/port. Never synthesize process metadata.

## Critique R2 - response budget

Count alone is insufficient; byte-bound each serialized page with reserve for the signed cursor and MCP wrapper. Keep whole process rows, do not split a command into unvalidated fragments. Preserve original small array shape.

## Critique R3 - scope and concurrency

Avoid touching the separate active Desktop group catalog, OAuth, Restart, credential-KDF, Runtime admission and macOS-owned files. The test must exercise the unchanged `formatToolResult`. Fail closed if the source changes between pages. Existing queue/runner wait is not a code blocker.

Estimated production 65-95 LOC, tests 80-120 LOC; complexity 3/10, reliability target 9/10 after tests, diagnosis confidence 9/10.
