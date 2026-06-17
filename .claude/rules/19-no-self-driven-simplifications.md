# No Self-Driven Simplifications

Never silently cut scope or quality "because mostly the same as upstream" or "probably good enough." This rule overrides others when they conflict.

## What counts as a violation

- Cutting deliverable scope because "the user probably doesn't need all of this."
- Skipping a sub-flow because the happy path obviously covers the common cases.
- Producing a 2-paragraph summary when the source material demands a 2-page exposition.
- Inferring missing information instead of reading the source.
- Substituting "this should work" for "verified against HEAD by file:line citation."
- Marking work done when only the happy path is exercised.

## What is allowed

- Pointing out that a deliverable is redundant with another and proposing to merge them, BEFORE doing the work.
- Surfacing a tradeoff and asking the user to choose (deferred via discussion, not skipped silently).
- Citing existing artefacts instead of re-deriving from scratch — provided the citation is exact and the cited material is current at HEAD.

## How to apply

Before declaring any task done:

1. Re-read the task's stated criteria verbatim.
2. Confirm each named output exists in full.
3. For each citation, run a grep/Read to verify the file/line still exists.
4. If any item is incomplete, the task is NOT done.

## Reason

The cost of an undercooked deliverable that contaminates downstream work is far higher than the cost of writing more. When this rule conflicts with brevity instincts, this rule wins.
