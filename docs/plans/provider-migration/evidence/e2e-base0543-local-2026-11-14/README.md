# Reviewed integration: local evidence before Electron CI

This directory preserves the original local receipts and logs for the reviewed
integration of base `0543d437695318f0157e6d600d76abdce5c51e8e` and the follow-up
conversation, Review, launch-input and UI coverage changes. The adjacent
`e2e-d104-2026-11-14` directory contains the earlier, separately identified CI
observations that motivated these repairs. Those historical observations do
not qualify this integration.

`manifest.json` contains the exact SHA256 of every original receipt and log,
the source hashes at collection, and the limits of these checks.
`reviewed-source-manifests.json` preserves the file metadata from the separately
reviewed source freezes. Original per-run source hashes remain in each receipt;
the final source inventory is not a claim that every earlier run used the
final bytes.

## Implemented repairs

- Ordinary assistant text now reaches the existing lead conversation through
  the original Runtime/Team ownership checks and signed message pages. Its
  bounded durable projection preserves identity, timestamps and explicit
  history gaps. Diagnostic activity limits and the product change feed stay
  unchanged.
- Large replies retain their text and conversation identity through the
  original Host fragmenter, Main projection and strict renderer assembly.
  The full serialized envelope remains bounded at 8 MiB; a rejected replacement
  preserves the previous valid reply with an explicit gap.
- Deferred CodeMirror updates preserve the currently hovered Review hunk,
  using the original hunk resolver and current editor ownership checks.
- Original Linux UI launches and cold readback retain the exact selected
  launch helper. The installer accepts an explicit serial-child option without
  changing its default command or retry policy.
- Two additional original Electron lanes cover model/effort selection for
  the next launch with another team already active, and cold Processes Kill
  with a real native process artifact and no provider configuration.

## Executed checks

Counts below describe individual runs and overlap. They must not be added into
a unique-test count or treated as Electron journey counts.

| Original check | Observed result | Scope |
| --- | --- | --- |
| Six provider/Host integration suites | 82/82 PASS, no skips | Merged provider configuration, grants, model probes and closure |
| Seven Main/Linux suites | 198/198 PASS, no skips | Original launch selection, custody, shell environment, process identity and MCP |
| Desktop preflight suites before Plan16 | 44/44 PASS, no skips | Existing admission and source observations |
| DesktopBackendFeature | 13/13 PASS, no skips | Controlled Main/Host behavior and bounded startup diagnostics |
| Final owner/checkpoint/restore suites | 122/122 PASS, no skips | Seven original suites, controlled sessions and durable state |
| Frontend integration suites | 365/365 PASS, no skips | Existing store, polling, message paging and product read order |
| Final frontend refinements | 15/15 PASS, no skips | Strict sparse-input/provenance checks |
| Actual large-message pager/Main/renderer test suite | 8/8 PASS, no skips | Includes a 420-KiB Unicode reply with conversation identity |
| Long-reply and serialized-boundary owner cases | 3/3 PASS, no skips | 30-KiB live text, 300-KiB escaped text, 65 blocks and exact byte boundary |
| Review regression suite | 8/8 PASS, no skips | Deferred updates, current view and pointer ownership |
| Serial installer argument tests | 7/7 PASS, no skips | Finite child runner; no installation/provider execution |
| Selected original readback fixture tests | 2/2 PASS, no skips | Actual selected static Linux helper and exact pins |
| Plan16 original admission/process fixture suites | 29/29 PASS, no skips | Actual selected NAPI artifact, strict no-provider capture and refusal cases |
| Original legacy Host script typecheck | PASS | Includes the new selection/process scripts |
| Canonical fast lint | PASS, 0 errors, 212 existing warnings | Six independently reviewed import-order corrections only |
| Source size and provisioning architecture guards | PASS | 4,952 production files; original 800-line limit and frozen caps |

The 122-test run precedes two independently reviewed test-only type corrections:
an immutable file-descriptor alias and a numeric annotation. The final staged
whitespace check also removed exactly one terminal empty line from each of
three new Host helpers. Production statements and assertions are unchanged;
these source differences are recorded explicitly rather than attributed to a
new runtime execution. The original two compiler diagnostics and subsequent
incomplete attempts are retained.

For Review, `before-layout` is the intended old-source toolbar counterexample
(one failing and two passing checks). The earlier `before-built` failure is
retained as a separate fixture geometry failure, not as that counterexample.

## Checks still requiring CI

Full `pnpm typecheck:workspace`, full typed lint, its original Main scope, and
the corrected Host test typecheck were killed with exit 137 locally. The
scoped Host retry with a smaller Go memory budget also exited 137. These are
**not PASS**. No compiler project, lint rule, assertion or acceptance predicate
was removed. The existing safe Team CI lane now requires the canonical full
workspace compiler, all three original typed lint scopes and MCP lint.

Local Electron admission failed at `socket(AF_UNIX, SOCK_STREAM)` creation
with `EPERM`, before bind or application launch. No local Electron run or
alternative web harness is claimed. The nine actual Electron lanes and the
Windows/Darwin follow-ups must produce their own original CI receipts and
cleanup evidence before any current-head UI or platform qualification.

The imported Desktop source roster contains 1,618 unique existing files and
includes every reviewed new or changed production path. This is source
closure evidence, not UI execution evidence. Its exact ordered hashes and
the original declarations' deduplication are recorded in
`TEST-desktop-source-roster-final-audit.json`. The subsequent
`TEST-desktop-source-roster-publication-audit.json` records the unchanged
ordered roster and recomputes its content hash after the three terminal
empty lines were removed.

No real Claude Code or Codex executable was invoked by these local checks.
The PR remains Draft; no merge, release, default activation or Stage2
qualification is implied.
