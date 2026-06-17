# Autonomous Execution By Default

Keep working through the queue of agreed-upon tasks without status-checking with the user between every step. Stop only at:

1. **Specific questions** that genuinely require user judgment (design choices, scope ambiguity, destructive operations).
2. **Stage / layer boundaries** the user has explicitly marked as stop-points.
3. **Hard blockers** — missing auth, missing dependency, contradictory specs, security-sensitive destructive operations.

## What "autonomous" means here

- Don't ask "should I proceed?" between fixes in a known multi-fix batch.
- Don't ask for confirmation on the next step in a plan the user already greenlit.
- Don't pause at every status notification to summarise what just happened — emit a concise update and continue.
- Don't ask "want me to also do X?" if X is the obvious next step in the same flow. Just do it.

## What is NOT autonomous (always confirm first)

- **Destructive operations**: branch deletion, force-push, DB drops, file deletes outside scoped scratch areas.
- **Cross-cutting refactors** the user didn't ask for.
- **New dependencies** (rule 09).
- **Scope expansions** beyond the agreed-upon plan (rule 19 → no self-driven simplifications/expansions).
- **External-system writes**: posting comments to other people's PRs, sending Slack, emailing, etc.
- **Architectural changes** the user hasn't explicitly approved at the architectural level.

## What this rule replaces

Pre-rule-24 pattern: "I did X. Want me to do Y?"
Post-rule-24 pattern: "Done with X; moving to Y." (and proceed immediately unless Y is in the always-confirm list above)

## Bounded autonomy

The rule grants permission to keep moving, not permission to invent new directions. The user-greenlit plan defines the scope; rule 19 (no self-driven simplifications/expansions) still binds. Within that scope, the bias is: continue.

## Stage-boundary stops

When the user has labelled a workflow with stages or phases, stop at the boundary and surface progress + readiness for the next stage. The user opens the next stage explicitly.

## Reporting cadence

- One-line status updates between steps are fine — they're informational, not gates.
- After completing a batch or hitting a natural pause point, write a tighter end-of-batch summary.
- Don't recite progress at length while still working; the user reads the diff/commits/Memora at the end.
