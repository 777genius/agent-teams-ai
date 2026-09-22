# PR #252 live-head sync execution DAG

Revision: `pr252-live-head-sync-router-v2`. Terminal state: `HOLD`.

No observed PR head or base is packet authority. Those values become attempt authority only through
the atomic broker binding.

## Ordered DAG

```text
PR252.ROUTER.ACTIVE
  -> PR252.BINDING.ATOMIC
     broker resolves live head -> attempt.canonicalHeadSha
     broker resolves live base once -> attempt.resolvedBaseSha
     source = attempt.canonicalHeadSha
     parents = [attempt.canonicalHeadSha, attempt.resolvedBaseSha]
     expected old head = attempt.canonicalHeadSha
     record actual conflicts and focused tests before worker start
    -> PR252.SYNC.PRODUCER (capacity 1)
       resolve actual conflicts only; preserve both parent behaviors
       focused tests + all mechanical gates + self-review
      -> HOLD
        -> PR252.SYNC.CONTROLLER_MECHANICAL
           compare live head/base; controller reruns every mechanical gate
          -> PR252.SYNC.SEMANTIC_REVIEW (one fresh independent reviewer)
             combined integration + architecture + security + semantic decision
            -> HOLD
              ACCEPT with P0/P1/P2 = 0/0/0
                -> PR252.SYNC.BROKER_PROMOTION_PROOF
                   compare live head/base again
                   true merge with exact ordered parents and reviewed tree
                   push with expected-old-head protection
                   prove remote/GitHub head, base, and non-conflicting state
                  -> PR252.LATEST_BASE_SYNC RELEASED
                  -> HOLD; launch no successor
              REJECT or nonzero finding -> no promotion -> HOLD
```

At any later comparison point:

```text
live head != attempt.canonicalHeadSha OR live base != attempt.resolvedBaseSha
  -> invalidate only the bound attempt and all attempt results
  -> wait until that attempt is terminal
  -> optionally admit one fresh atomic attempt under the same router
```

## Invariants

- The broker resolves and records both live values during atomic prepare/start.
- The base is resolved once; neither binding can change within the attempt.
- `attempt.canonicalHeadSha` is source, ordered first parent, and expected old head.
- `attempt.resolvedBaseSha` is ordered second parent.
- Producer writable scope equals `attempt.conflictPaths`; non-conflict bytes are immutable.
- The controller, not a review worker, reruns all mechanical gates.
- One independent reviewer covers integration, architecture, security, and semantics.
- Only exact `ACCEPT 0/0/0` permits promotion.
- Promotion is a true two-parent merge of the exact reviewed tree.
- Push proof binds the merge, remote/GitHub head, GitHub base, and non-conflicting result to the same
  attempt.
- Runtime primitives do not select or advance the DAG.

Every actor ends `HOLD`. No real-project, team launch, product terminal/smoke, provider/auth, raw
lifecycle, other-repository, broad-docs, dependency-update, or Fast activity is authorized.
