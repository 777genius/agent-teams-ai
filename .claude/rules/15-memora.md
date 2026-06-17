# Memora Memory

Use Memora proactively for persistent memory across sessions. Full instructions in `~/.claude/CLAUDE.md` and `~/.claude/docs/memora-guide.md`.

## Key Behaviors

- **Session start:** Query project context via `memory_semantic_search` + `memory_list`. Follow connections.
- **During work:** One memory per concept. Link related memories. Update existing — never duplicate.
- **Session end:** Capture learnings. Create issues for bugs, TODOs for incomplete work.

## Every Memory Must Have

1. **Tags** — project identifier first, then topic tags.
2. **Hierarchy metadata** — places the memory in the knowledge graph.
3. **Links** — explicit connections to related memories.
4. **Sufficient granularity** — file paths and function names, not vague summaries.
5. **Tiered format** — ABSTRACT/OVERVIEW/DETAIL structure (see below).

## Tiered Format

All memory content uses three tiers for progressive recall (~50% token savings via `/quanta:memory-recall`).

```
ABSTRACT: <one-line summary, max 15 words, front-load key noun>

OVERVIEW: <2-4 sentences. What, why, file paths, decisions.>

DETAIL:
<Full content — code, config, schemas, edge cases. Only loaded on demand.>
```

- ABSTRACT and OVERVIEW are mandatory. DETAIL is optional for simple memories.
- No redundancy across tiers — each adds new information.
- File paths and function names go in OVERVIEW, not buried in DETAIL.

Example:
```
ABSTRACT: Auth uses httpOnly cookies with rotating refresh tokens, not localStorage JWT.

OVERVIEW: Access tokens (15min TTL) in httpOnly cookies, refresh tokens (7d) in DB. /auth/refresh rotates both. Chosen over localStorage JWT after XSS audit. See src/auth/middleware.ts, src/auth/refresh.ts.

DETAIL:
Cookie: sameSite 'strict', secure true, httpOnly true, API subdomain only.
Refresh flow: client hits /auth/refresh → server validates from auth_refresh_tokens table → old token deleted, new pair issued → expired refresh = 401 redirect to /login.
Rate limit: 5 refresh/min/user (src/auth/rate-limit.ts).
```

## Special Tag: `agent-friction`

Use when you had to re-learn something already in Memora, the user corrected the same mistake twice, or a convention was missed despite existing docs. When 3+ `agent-friction` memories exist for the same domain across 2+ sessions, session-wrap flags it for a specialist document.
