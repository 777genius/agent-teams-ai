# Phase 1 proposal inputs

## Predecessor and candidate reference

- Phase 0 start: `a32f509e6d9bd31ba2135940e336729bf90c3d93`
- Integrated canonical predecessor: `c958c872fa22edf9b2d6a0741d7781b00957903c`
- Freeze candidate integration commit: `null`; pending controller integration
- Freeze candidate evidence-index SHA-256:
  `d5c8725dfb22f7e0228e0dd51f53d978d117ed7253fdb279c8ddba7000ff8758` (candidate only; not an
  integrated freeze digest)
- Authorization: blocked; this proposal does not authorize Phase 1.

## Current supported inputs

| Input                         | Current support                                                                                                                      | Use in this proposal                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Parent plan Phase 1 outcome   | Tasks 1-12 and the Phase 1 exit gate in `docs/hosted-web-e2e-completion-plan.md`                                                     | Defines intended outcomes only.                                                                                        |
| Packet lifecycle              | `docs/hosted-web-phases/PACKET_STANDARD.md` and the execution router                                                                 | Requires a blocked proposal until every readiness item passes.                                                         |
| W1                            | Original v9 adopted; later `0d1a82fe…` census narrowly adopted as characterization; pack-relative envelope bytes pending integration | May inform a later packet without raising proof levels.                                                                |
| W2                            | A1 approved; later `6d54e7c6…` census narrowly adopted                                                                               | Source-observed input only; final target-image behavior and credential canaries remain unproved.                       |
| W3/W5                         | Current pair compatible inside the evidence-only boundary; `5d723407…` correction narrowly adopted                                   | Does not authorize hosted recovery or mutation.                                                                        |
| W4/W6                         | Characterization only; `c958c872…` supplies current artifact authority                                                               | Exact standalone artifact remains rejected for hosted v1; final-image and terminal-negative admission remain unproved. |
| Historical reviews and audits | Original rejected-pair, hold-all-adoption, and failed-freeze conclusions are superseded as current authority                         | Retain as historical evidence only; do not revive them as readiness blockers.                                          |

## Still-current blockers

| Required input                                 | State          | Required action                                                                                                                   |
| ---------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Integrated Phase 0 freeze commit               | Missing        | Review and integrate the candidate, then record the actual commit.                                                                |
| Frozen evidence-index digest                   | Candidate only | Replace the candidate digest with the integrated freeze digest.                                                                   |
| Final target-image/profile proof               | Missing        | Prove hosted artifact composition, provider/runtime behavior, and terminal-negative admission in the exact target image.          |
| Reconciled unique-bucket estimate              | Missing        | Deduplicate lane estimates and resolve recorded variance.                                                                         |
| Final Phase 0 gate and typecheck normalization | Missing        | Run the final gate later and compare against the inherited seven-diagnostic typecheck set; do not normalize failures into passes. |
| Serial bootstrap evidence                      | Missing        | Freeze any eventual IDs, exact paths, checks, and review pairs in a new authorized packet.                                        |
| Exact Phase 1 ownership and shared writers     | Proposal only  | Derive after the integrated freeze and serial bootstrap; no current path is authoritative.                                        |
| Explicit Phase 1 authorization                 | Pending        | User/controller authorization is required after readiness.                                                                        |

## Candidate vocabulary, not frozen contracts

The parent plan supports a small shared kernel of opaque IDs, request context, revisions/cursors, and
safe application-error categories, with feature-specific DTOs and errors kept feature-owned. It also
supports separate route, capability/action, and parity-ledger sources rather than a merged manifest.
These are constraints on a future packet, not accepted contract IDs or ownership.

A read-only team-lifecycle query remains a possible first proof. Its exact name, DTO, route ID, IPC
channel, paths, owners, and fixtures are deliberately unchosen.
