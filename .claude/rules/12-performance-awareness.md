---
paths:
  - "src/**/*.{ts,js,py,go,rs,dart,kt,java}"
  - "lib/**/*.{ts,js,py,go,rs,dart,kt,java}"
  - "app/**/*.{ts,js,py,go,rs,dart,kt,java}"
---

# Performance Awareness

Prevent anti-patterns that are expensive to fix later — not premature optimization.

## Flag Proactively

- **N+1 queries** — fetching a list then querying individually per item.
- **Unbounded fetches** — no pagination or limits.
- **O(n^2) when O(n) exists** — nested loops, repeated scans, quadratic string building.
- **Loading into memory** — entire files/datasets when streaming is possible.
- **Missing indexes** — unindexed columns in tables expected to grow beyond 10k rows.
- **Synchronous blocking** — blocking event loop/main thread during I/O.
- **Connection pool exhaustion** — new connections per request instead of pooling.
- **Unverified slow queries** — use EXPLAIN/EXPLAIN ANALYZE; don't guess about indexes.

## Rules

- Flag anti-patterns and offer to fix or create a TODO.
- Quantify: "loads ~10MB per request" not "might use a lot of memory."
