# Plan70 independent prospective review

Status: ACCEPT for the exact prospective scope. No blocking finding; source implementation and runtime qualification remain unproved.

The reviewed document is SHA256 69396e4ccb4d167d333cf64c7d22033b3a6d2224346fcd7ec6b9162bc22a1208. The exact controls preimage is Git blob 1c11809c6458f829bd9bb6995aea2ad60b85511e and the existing suite is a67601fe1a6785b233aef6cacf494661100df472. Both original Resume source vectors bind those exact bytes. Root reports the later Plan67/68 publication leaves them unchanged.

## Scope and rationale

The original helper returns null before any wheel when the nearest scrolling ancestor has no viewport intersection. The proposed calculation changes only that branch, walks the original ancestor chain and exposes an original scrollport. The fallback always returns visible:false. Its clipped positive exposed area, single hit joined to the same nearest scroll owner and directional capacity are necessary checks before using the existing bounded wheel loop. The normal positive-intersection path, disabled-control behavior and optional center-hit semantics remain unchanged.

The separately justified guard removal is one outer scrollTo call. The inner waitRead guard follows only synchronous argument/deadline work and still runs before every actual DOM read. No check across an asynchronous boundary is selected for removal. This review does not claim a new post-evaluate guard before each wheel; that is not part of the existing helper or this scope.

## Test and implementation boundaries

The existing suite already imports createDesktopUiControls and evaluates its actual generated expression with runInNewContext. It asserts exact hit calls and CDP commands for the original default and opt-in paths. The proposed new cases can use that seam without a helper stub, browser, native process or framework. Geometry progression must occur only after the corresponding recorded wheel. The above-viewport case, clipping/foreign-owner refusals and exact next-read ownership refusal are meaningful additional boundaries.

Actual-source R2 must inspect self-hit candidate ownership, every relevant clipping ancestor, multi-level exposure direction, original positive-branch byte preservation and all old test assertions. No extra roster or workflow path is selected: the existing closure and explicit lint/test operands already contain both files.

## Qualification

The original Resume receipt remains INCOMPLETE before model selection. Missing historic per-read ancestor and selector-count facts prevent exclusive causal attribution. No Windows 10-second recovery guarantee or explanation of the ARM Retry click failure is claimed. Selection/publication must rebind the current leaves, and the resulting source still requires ordinary canonical CI and E2E.

Only inert source, JSON and hash review was performed. No project, compiler, linter, tests, provider, native process, GUI, CI operation, remote mutation or source afterimage was produced.
