# Hosted-web evidence lifecycle

## One catalog, explicit authority

Every evidence record names one stable evidence ID and records its repository-relative path, phase, lane,
authority class, producer, producer base SHA, content SHA-256, regeneration command, review
disposition, and supersession links. A file's directory or modification time never implies authority.

A supersession link transfers authority; it is not merely a provenance link. Therefore every row
named by `supersededBy` must itself be `canonical` with an `approved` or
`approved-with-conditions` disposition, and only such a row may carry a non-empty `supersedes`
list. Raw, generated-but-unadopted, historical, rejected, and already-superseded rows cannot receive
authority through a supersession link. The catalog fails closed instead of laundering authority
through one of those classes.

Authority classes are deliberately disjoint:

| Authority    | Meaning                                                             | Current decision authority                                                 | Retention                                                                                                                                                |
| ------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canonical`  | Reviewed artifact adopted by the controller for its evidence ID.    | Yes, unless a later canonical row explicitly supersedes it.                | Retain permanently with its catalog row and hash. Never rewrite in place.                                                                                |
| `raw`        | Immutable observation, capture, log, or source input.               | No; it supports a reviewed conclusion.                                     | Retain unchanged for the lifetime of every derived artifact and the release audit. No automatic deletion.                                                |
| `generated`  | Deterministic derivative reproducible by the recorded command.      | Only if its review disposition separately permits adoption.                | Retain every reviewed or referenced version. Unreferenced rebuilds may be cleaned only by a separately approved retention process, never by these tools. |
| `historical` | Former context retained for traceability but not current authority. | No.                                                                        | Retain permanently. Do not move it merely to express this class; the catalog is authoritative.                                                           |
| `rejected`   | Reviewed candidate explicitly found unsuitable.                     | No. It must not be revived without a new evidence ID or reviewed revision. | Retain permanently with rejection disposition and review evidence.                                                                                       |
| `superseded` | Former authority replaced by the artifact named in `supersededBy`.  | No.                                                                        | Retain permanently with an unbroken forward and reverse supersession link.                                                                               |

`historical` means context aged out of current decision-making. `rejected` means review made an
adverse decision. `superseded` means a named replacement took authority. These terms are not
interchangeable.

## Review dispositions

Every row records one of `pending`, `approved`, `approved-with-conditions`, `rejected`, `superseded`,
or `not-required`. Canonical evidence must be `approved` or `approved-with-conditions`. Rejected and
superseded authority classes require their matching dispositions. A superseded row must name exactly
one forward replacement; the replacement must list the old evidence ID in `supersedes` and must be
canonical with an accepted disposition. Missing targets, non-reciprocal links, cycles, and
non-authoritative targets invalidate the entire catalog.

Raw observations may use `not-required` because review applies to the conclusion drawn from them, not
to whether the bytes were observed. Generated artifacts require a non-empty exact regeneration command.
Other classes use `null` only when regeneration is impossible or inapplicable.

## Evidence maintenance boundary

Existing evidence and its recorded hashes, dispositions, and historical regeneration commands remain
frozen. Historical commands are provenance only, not executable instructions. New evidence must be
created at a new exact path and reviewed through the current controller and lane packets. The product
repository does not provide a hosted-worker evidence-catalog generator or orchestration validator.

## Correction and supersession

1. Preserve the old bytes and row.
2. Produce a new artifact at a new exact path and give it a distinct evidence ID.
3. Record its producer, base SHA, hash, regeneration command, and review disposition.
4. After adoption, classify the old row as `superseded`, set its disposition to `superseded`, set
   `supersededBy` to the new ID, and add the old ID to the new row's `supersedes` list.
5. Review the complete evidence record before using the replacement as an input to a packet or worker.

Evidence maintenance is non-destructive. It never deletes, moves, truncates, or rewrites archived
evidence.
