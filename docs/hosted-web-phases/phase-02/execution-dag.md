# Phase 2 JIT execution DAG

Status: `candidate`; product admission `blocked`; terminal state `HOLD`.

## Graph

```text
P2.ROUTER.INTEGRATED
          |
          v
 P2.F0.IDENTITY                 one short product-source foundation
          |
          v
 P2.R0.ARCH_SECURITY           separate architecture/security review
          |
          v
 P2.IF.INTEGRATION             accepted foundation integration and activation
          |
          +----------+----------+----------+----------+
          |          |          |          |          |
          v          v          v          v          v
        P2.A       P2.B       P2.C       P2.D       P2.E
          |          |          |          |          |
          +----------+----------+----------+----------+
                                |
                                v
                     P2.R1.ARCH_SECURITY
                                |
                                v
                       P2.I.INTEGRATION
                                |
                                v
                       P2.F.MILESTONE
                                |
                              HOLD
```

## Node registry

| Node                  | Product slots | Dependency                    | Output                                   |
| --------------------- | ------------: | ----------------------------- | ---------------------------------------- |
| `P2.F0.IDENTITY`      |             1 | integrated router             | identity foundation source/tests/handoff |
| `P2.R0.ARCH_SECURITY` |             0 | F0 producer self-review       | foundation ACCEPT/REJECT review          |
| `P2.IF.INTEGRATION`   |             0 | accepted R0                   | activated foundation authority           |
| `P2.A`                |             1 | accepted foundation authority | workspace identity/runtime context       |
| `P2.B`                |             1 | accepted foundation authority | team identity records/tombstones         |
| `P2.C`                |             1 | accepted foundation authority | workspace binding/admission              |
| `P2.D`                |             1 | accepted foundation authority | roster identity/directory safety         |
| `P2.E`                |             1 | accepted foundation authority | legacy adoption/read facet               |
| `P2.R1.ARCH_SECURITY` |             0 | A-E producer self-reviews     | combined architecture/security decision  |
| `P2.I.INTEGRATION`    |             0 | accepted R1                   | serial exports/composition/conformance   |
| `P2.F.MILESTONE`      |             0 | accepted integration          | fresh milestone decision                 |

The parallel epoch contains exactly five product lanes, not five total workers. Documentation,
research, evidence, architecture/security review, integration and milestone roles have zero product
capacity. A support worker cannot replace a missing A-E producer. A replacement reuses the same lane
ID and supersedes its prior attempt.

## Dependency and ownership law

The router integration predicate is external to this candidate: an independent root review must first
accept the exact 12 paths and the broker must integrate and activate them. Until then F0 is blocked.
F0 is the only product node before the fan-out. A-E are blocked until the accepted F0 bytes are
integrated and active.

A-E may run concurrently because their writable path arrays in
[EXECUTION_INDEX.json](../EXECUTION_INDEX.json) are pairwise disjoint. They may read, but never import
from or copy, a sibling's unintegrated output. None owns a barrel, `index.ts` or composition file.
Shared exports and wiring are reserved to serial F0 or P2.I. A needed overlap is a `packet_conflict`
and strict `HOLD`, not permission to coordinate an edit.

## Review and integration law

Each producer self-reviews its complete diff and evidence. Do not create reciprocal or separate lane
code reviewers. Separate reviewers are limited to `R0`/`R1` architecture and security, `IF`/`I`
integration, and `F` milestone work.

An architecture/security ACCEPT authorizes only the named integration node. Integration may use only
controller-declared integration primitives and exact reserved paths. It does not choose successors.
The controller may admit the next node only after accepted bytes are active at authority.

Every node, including successful review and integration, returns `terminalState: HOLD`. No node
commits, pushes, launches successors or claims the next node ran.
