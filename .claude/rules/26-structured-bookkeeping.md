# Structured Bookkeeping for Reviews + PR Comments + Commit Messages

Every PR-round comment (autonomous OR human), every commit message that records a multi-round process step, and every "I just did X" PR comment must leave a **structured bookkeeping record**. Free-form prose alone is not enough — the record must be machine-scannable and human-skimmable in the same artefact.

The reference pattern is `/quanta:review-pr`'s structured comment template. Do not duplicate it slavishly; reproduce the *kind of record* it leaves.

## Required sections (any structured PR-review comment or post-round commit body)

A comment qualifies as "structured bookkeeping" if it has — in this order — at minimum:

1. **Header** — what + who + when. Project name, PR number, round/run identifier, mode if applicable.
2. **TL;DR** — one sentence stating the verdict + the load-bearing reason. `APPROVE`, `CONDITIONAL_APPROVE`, `BLOCKED`, `NEEDS_WORK`, `NO_NEW_FINDINGS`. Skim-readable.
3. **Summary** — 2-4 sentences covering scope of the round + what was verified vs deferred. Mentions the commit SHA(s) reviewed.
4. **Findings** — table or severity-tagged list. Each finding has: severity, file:line citation, one-line title, ID if applicable (for cross-round tracking), short body. Even "no findings" must say so explicitly (`**No new findings this round.**`).
5. **Verdict** — restate the TL;DR with any conditions or carried-forward items. Bulleted if multiple.
6. **Footer** — one-line provenance: project • mode • round/run # • tally (resolved/new/carried) • timestamp.

Optional but encouraged when relevant:

- **Blast Radius** — paragraph + numeric score (0-10) describing cross-repo impact. Required when the diff touches >1 module.
- **Risk Indicators** table — sensitive-function touches, migration touches, test delta, dependency changes. Required when any indicator is non-zero.
- **Related PRs** — links to prior PRs in the same workstream or dependency chain.
- **Cross-model verification** — note whether independent verification (Codex MCP, etc.) was performed and the outcome.
- **Re-review** — when round > 1, one-line tally: "N prior conditions carry forward; M resolved; K new."

## Required sections (commit message body when the commit records a review-round step)

Commit message subject already follows Conventional Commits (rule 05). The body of a review-round-step commit must additionally include:

```
R<N> verdict findings (kept=K):

(1) <severity> <file:line> — <one-line title>. <one-paragraph body>.
(2) <severity> <file:line> — <one-line title>. <one-paragraph body>.

Fix: <one-paragraph description of the change made + rationale>.

Verification:
- <typecheck / test command> → <result>
- <other gating command> → <result>
```

Commit messages do not need the bookkeeping comment's full header/footer chrome; they DO need the round number + findings table + verification steps. This is what makes a future bisect or session-wrap reconstruction tractable.

## Where this rule binds

- **`/quanta:review-pr` and any autonomous PR-reviewer worker** — comment renderers + reviewer/arbiter prompts must emit a payload that the renderer can format into the bookkeeping template.
- **Human PR comments by Claude** — when posting a PR comment for any reason (status update, summary, follow-up), structure it.
- **Commit messages** — every commit that resolves reviewer findings or completes a stage step.
- **Memora memories** — already have ABSTRACT/OVERVIEW/DETAIL tiers (rule 15). The bookkeeping rule does NOT replace that — but Memora can cross-reference structured PR records.

## Why

Each review round costs minutes of wall-clock + tokens. Without a structured record, a future session opening the PR has to read every prior comment in full + every commit message + every Memora memory to reconstruct state. Structured bookkeeping replaces that O(rounds) cost with an O(1) scan of the latest comment's TL;DR + Verdict + Footer.

Records exist so future sessions can reason about state without re-deriving it.

## Anti-patterns

- "No new findings" with no header / no TL;DR / no footer.
- A verdict comment that is a single sentence of free-form text without any of the 6 required sections.
- A commit message body that lists fixes without the round-number anchor or test-verification block.
- Burying a CHANGES list inside summary prose. Use a finding-style table.
- Inventing a brand-new template per round. Match the prior round's structure unless the rule changes.

## Verification

When applying this rule:

1. Confirm the comment has all 6 required sections in order.
2. Confirm the footer carries enough provenance for a future session to triangulate (round #, timestamps, SHA scanned).
3. If the round produces "no findings", the structure stays the same — just the Findings section says so explicitly.
