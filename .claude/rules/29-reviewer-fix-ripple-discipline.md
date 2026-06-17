# Reviewer-Fix Ripple Discipline

When addressing findings from a PR reviewer (autonomous OR human), the response must consider the **ripple effects** of each fix, not just the narrow text of what was flagged. Each review round costs minutes of wall-clock + token budget; treating each finding as an isolated text-substitution multiplies that cost across rounds.

## The rule

For every finding you address:

1. **Read what you're about to change in full context first.** Understand who calls it, who reads it, what tests assert against it, what consumers downstream depend on its shape. Don't apply the reviewer's literal suggestion before knowing the call graph.
2. **Inspect adjacent code that interacts with the fix.** If the fix touches a function, scan every callsite. If it changes a JSON shape, check every consumer (incl. external monitors and dashboards). If it renames a field, check tests, fixtures, and docs.
3. **Identify ripple risks before committing.** Common ripples:
   - Renaming a state field breaks `/health` consumers reading the old field.
   - Tightening a regex breaks adjacent test fixtures that used the old behaviour.
   - Adding a config flag changes the env-var contract overlays must satisfy.
   - Changing an API contract requires coordinated client + server changes.
4. **Address related issues in the same commit when they're entangled.** If finding A's fix exposes problem B (e.g., split state field breaks back-compat consumers), fix B in the same commit. This is rule 18 (preexisting issues) applied to reviewer cycles: don't ship a partial fix that ships a new bug.
5. **Don't go too far either.** Apply the rule with judgment — investigating a tiny doc typo with full call-graph rigour is wasted effort. Calibrate inspection depth to the scope of the change. Heuristic: if the fix touches >1 file or alters a public contract, do the ripple inspection; if it's a typo or comment, just apply it.

## Anti-patterns

- **Literal-substitution mode:** apply the reviewer's exact suggested code without reading the surroundings. Round N+1 then surfaces the consumer the suggestion broke.
- **Narrow-scope-only mode:** fix only what was explicitly flagged; ignore obvious adjacent issues the diff exposes. Round N+1 surfaces those adjacent issues separately, doubling the review-loop cost.
- **Overscope mode:** turn a 3-line MINOR fix into a 200-line refactor of "everything I noticed nearby". Costs another round of review on the bloated diff.
- **Suggestion-acceptance-without-verification:** the reviewer is a useful checker but not always right. Verify cross-platform claims (e.g. `base64 -w 0` on macOS), version-specific assumptions (OpenSSH SCP vs SFTP), and config-knob existence (config field names across major versions) against current upstream docs before applying. (Rule 21.)

## How to apply

Before committing a reviewer-driven fix:

1. **Read the touched files end-to-end** (not just the flagged line).
2. **Grep for related symbols** the fix renames or changes.
3. **Run the test suite** even if the fix is "obviously correct" — tests catch ripple regressions you didn't think of.
4. **Glance at consumers** in adjacent files (especially for shape changes: JSON, types, env vars, CLI args).
5. **Note in the commit message** any ripple effects you addressed alongside the literal finding (per rule 26 structured-bookkeeping).

## Relation to other rules

- **Rule 18 (preexisting issues):** when a ripple effect surfaces a preexisting bug, rule 18 already requires you to address it in scope. Rule 29 extends this to reviewer cycles explicitly.
- **Rule 21 (external-docs-verification):** reviewer suggestions about library APIs / CLI flags / config knobs must be verified before applying — same discipline as any other programmatic choice.
- **Rule 26 (structured-bookkeeping):** the commit message that records the fix follows the round-N format; ripple effects addressed proactively go in the "Fix:" paragraph alongside the literal finding.
