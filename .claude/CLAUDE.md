# [Project Name]

[Same description as root CLAUDE.md — kept in sync]

## Operational Rules

All operational rules live in `.claude/rules/`. Every `.md` file in that directory is automatically loaded at session start by Claude Code with the same priority as this file.

### Rule Index

| # | File | Scope |
|---|------|-------|
| 01 | `security.md` | **PARAMOUNT** — secrets, input validation, least privilege |
| 02 | `error-handling.md` | **PARAMOUNT** — handle every error visibly |
| 03 | `environment-safety.md` | **PARAMOUNT** — verify target, data safety, K8s isolation, cleanup |
| 04 | `communication.md` | Stop on ambiguity, scope discipline |
| 05 | `git-practices.md` | Conventional commits, authorship |
| 06 | `testing.md` | TDD, unit tests, E2E tests |
| 07 | `documentation.md` | README, CLAUDE.md sync, docs/ |
| 08 | `branch-hygiene.md` | Branches, naming, clean state before refactors |
| 09 | `dependency-discipline.md` | No deps without consent |
| 10 | `code-consistency.md` | Match existing patterns |
| 11 | `api-contracts.md` | Contract-first, flag breaking changes |
| 12 | `performance-awareness.md` | No N+1, no unbounded fetches |
| 13 | `logging-observability.md` | Structured logging, OTEL |
| 14 | `resilience-and-config.md` | Timeouts, circuit breakers, externalized config |
| 15 | `memora.md` | Persistent memory across sessions |
| 16 | `sub-agents.md` | When to use sub-agents and team agents |
| 17 | `document-imports.md` | Resolve @ imports in CLAUDE.md before acting |
| 18 | `preexisting-issues.md` | Fix encountered issues; if complex, inform user and plan |
| 19 | `no-self-driven-simplifications.md` | **SUPREME** — never silently cut scope or quality |
| 20 | `clean-compilation-no-warnings.md` | Zero warnings, zero suppressed inconsistencies on touched modules |
| 21 | `external-docs-verification.md` | Verify framework/library/API choices against current official docs |
| 22 | `parallel-subagents-first.md` | Decomposable work runs in parallel by default |
| 23 | `monitor-over-timered-watchers.md` | Use Monitor tool for multi-event async signals, not `sleep` polls |
| 24 | `autonomous-execution-by-default.md` | Keep moving through agreed plan; confirm only at named gates |
| 25 | `proactive-work-while-waiting.md` | Do independent useful work during async waits |
| 26 | `structured-bookkeeping.md` | Structured PR comments + commit-body format for review rounds |
| 27 | `borrowed-reference-repos.md` | Reference repos are read-only; verify `git status -sb` clean |
| 28 | `intelligence-output-location.md` | Meta-repo intelligence outputs land at meta-repo root, not in submodules |
| 29 | `reviewer-fix-ripple-discipline.md` | Inspect ripple effects when applying PR-reviewer fixes |
| 70 | `bridge-read-inspection.md` | Use mcp-tool-bridge for read-only inspection of FS/process/git/container/cluster/DB state |
| 71 | `bridge-http-json.md` | Use mcp-tool-bridge `curl` for HTTP/JSON, never hand-parse responses |
| 72 | `bridge-chaining.md` | Use bridge `pipe`/`batch` to chain bridge tools, not shell glue |

## Domain Routing

When a task touches one of these domains, consult the linked specialist before acting.
If no specialist exists yet, proceed normally — session-wrap will detect recurring gaps.

<!-- TRIGGER TABLE: maintained by session-wrap when specialists are created -->
| Trigger Pattern | Specialist | Evidence |
|----------------|------------|----------|
<!-- Empty — specialists are created on demand from recurring friction patterns -->

> **How this works:** Specialists live in `docs/specialists/`. Each is a focused
> knowledge document (300-700 lines) containing domain-specific conventions,
> gotchas, and patterns. They are created only when session-wrap's repetition
> detector flags the same domain 3+ times across 2+ sessions. See rule 15
> (memora.md) for the `agent-friction` tag that feeds this system.

## Output Efficiency

Minimize token waste from verbose CLI output. Use compact flags and targeted queries by default.

### Git
- `git diff --stat` first — only `git diff <file>` for files you need to inspect
- `git log --oneline -20` unless full commit messages are needed
- `git status --short` instead of verbose status

### Testing
- On failure: show only the failing test output, not the full run
- Use compact reporters when available (`--reporter=dot`, `--reporter=min`)
- Pipe large test output through `| tail -50` if no compact reporter exists

### Listings & Search
- Prefer `Glob` tool over `find`, `Grep` tool over `grep`/`rg`, `Read` tool over `cat`
- `ls` not `ls -la` unless permissions matter
- `kubectl get <resource> -o name` or `--no-headers` for listings
- `docker ps --format 'table {{.Names}}\t{{.Status}}'` instead of full output

### Linters & Compilers
- Use `--format compact` or `--format stylish` for ESLint
- Use `tsc --pretty false` for TypeScript errors
- Pipe compiler output through `| head -30` on first pass — expand only if needed

### API & Data
- `curl -s` for API calls (suppress progress bars)
- `jq` to extract specific fields instead of dumping full JSON responses
- `psql -t -A` (tuples-only, unaligned) for machine-readable query output
