# Phase 0 salvage ledger

## Policy

The implementation branch descends only from pinned base
`cbe501ad0f1fa0e51a038e832ad35fce4120321b`. Closed PR #250 is reference-only: no merge, rebase or
whole-commit cherry-pick is allowed. A future salvage row must name source commit/file, target owner,
reason, modifications and focused test evidence.

## 0A entries

No closed-PR production source, test, build artifact or dependency was salvaged during 0A.

| Salvage ID | Source commit/file | Target owner/path | Reason | Modifications | Test evidence | Disposition |
| --- | --- | --- | --- | --- | --- | --- |
| `SALVAGE-0A-NONE` | None | None | 0A records base, plan and gate evidence only. | None | Scope inspection and Git diff show only the seven controller-owned evidence files. | `not_applicable` |

The source plan commit `16c156db8a85e75a6b679f6919e1013af74fb112` and its content-equivalent
adoption as `f1ad7a8cba2f26abf5f42ddd206937c24d143f77` are planning provenance, not product salvage.
Likewise, the two narrow base prerequisites between the base and current integration head are base
stabilization, not PR #250 salvage.

## Required future row fields

Every non-empty row added after lane review must include:

- stable salvage ID;
- source PR/commit and exact file or hunk;
- owning feature and target path;
- why the knowledge or asset survives the rejected architecture;
- manual changes needed to conform to the new contract and threat boundary;
- focused verification at the new public seam;
- `accepted`, `rejected`, or `superseded` disposition and reviewer.
