# Preserve the existing native stderr Logs surface

Date: 15 November 2026. Status: R1 and independent R2 reviewed; publication
precedes implementation. This continues Plan32's explicitly outstanding raw-stderr
gap. It is not a Logs parity or native-provider qualification claim.

## Demonstrated baseline and exact scope

Frozen frontend `4a0e06277fe216d9f82dbbede362668fe46622ee` returns normalized raw
capture unchanged under empty search/default filters. Its stream JSON parser
renders non-JSON lines as Output. The previous claim that plain stderr never
rendered was incorrect. The current Host original process adapters drain target
stderr without retaining it, so the working default Logs surface loses diagnostics.

Retain actual stderr for selected Claude/Codex member processes through their
existing original-child launch callbacks. Their stdin/stdout are native protocol,
not a raw Logs input. Do not tap either stream or expose control/readiness frames.
Do not modify CapturedProcess, WindowsCapturedProcess or OwnedProcessFacade.

The frozen OpenCode aggregate run has no child/stream turn loop and initializes
empty raw capture. Its working member logs use transcript projection. Accordingly,
this repair does not add speculative V1 server logs or reopen V2's deliberately
private engine diagnostics. Their established normalized frontend features remain
under the existing parity plans, including V1 Thinking in Plan32.

## One bounded observational path

Add a small optional MemberProviderContext callback for a closed observation:
`{ kind: 'process-output'; stream: 'stderr'; text: string }`, or the existing
`{ kind: 'gap'; reason: 'oversized' }` when capture cannot safely retain a line.
Keep provider diagnostic codes and the external provider Session SPI unchanged.

An outer adapter helper attaches to the SAME original child's stderr immediately
after custody.launch returns. Windows already exposes only target IO on its
facade, separately from broker control. Metadata probes, catalog commands and
other process users receive no observer. No new process/stream owner or observer
of ambient resources is introduced.

Trusted composition closes over the original binding, OpenConfig and existing
provider authority. It calls a narrow RuntimeOwner observation method, backed by
RuntimeActivityCoordinator's existing member fence and journal. Recheck the
captured source grant before each observation. Under the fence require matching
normalized binding, the full captured OpenConfig including checkpointRef, original
profile/config/open fingerprint, original Host incarnation and an
opening/allocated/held/closing record whose custody has not been released.
Never weaken the existing subagent observer's session or input attribution rule.

Startup observations must be accepted while the original record is already
opening and before allocate installs sessionRef; a failed open must retain the
diagnostic. Closing observations remain observational only while the original
source authority is valid. Do not use canAllocate/assertAllocatedCurrent, which
would drop startup or closing diagnostics. Runtime sealed alone neither grants nor
forbids this narrow observation; original composition-wide sealing and revocation
still reject it. Replaced/revoked/config-mismatched sources and closed or released
records produce no new retained diagnostic. No guessed current input,
operation, task, native timestamp, PID, session path or authority may be assigned.

Use the existing eventId/sequence, high water, storage fault handling and
retention bounds. These facts never update conversation text, message counts,
usage/cost, tool statistics, readiness, input terminal state or custody. Exact
task reads exclude the unattributed process facts as they already exclude
unattributed session events. Member reads retain them across cold recovery.

## Sanitize before persistence and bound framing

Reuse the pure existing runtimeDiagnosticText and diagnosticsRedaction utilities.
Move their implementations into a browser-safe Host diagnostic utility subpath;
keep existing app imports as re-exports. No new package or duplicated redactor.

One new small observeMemberProcessStderr helper owns incremental UTF-8 framing,
bounded pending bytes and observer cleanup. Maximum raw line is 24KiB; JSON
escaping can make its serialized event larger. Preserve the existing 32KiB
serialized-event check, which substitutes an oversized gap, and the 1MiB/256-event
journal limits. Normalize NUL before persistence so the existing strict text codec
can read the same retained bytes; decode invalid UTF-8 safely without throwing.
Redact the complete bounded line BEFORE truncation. For an oversized line, discard through
its terminator and emit the existing oversized gap; never publish a suffix whose
secret prefix was discarded. Flush a final bounded tail on end/close exactly
once. Diagnostic observation failures cannot throw out of the stream callback or
change provider outcomes; use existing storage-degradation behavior.

Replace actual private values ALREADY held by the selected launch: its Team MCP
bearer, selected secret environment entries, selected MCP authorization/header
values and explicit credential-bearing arguments. Do not read more credentials.
Normalize ANSI before matching the already-captured secret values; otherwise
removing ANSI later could reconstruct a secret that exact matching missed. Replace
longer values first, including nonempty line components of captured multiline
secret values, then reuse existing assignment, URL and structured dump redaction.
Reuse or export the existing pure ANSI/dump classifiers; do not copy their regexes
into a second sanitizer. Treat a detected multiline
dump as suppressed until an explicit finite end marker or stream end; do not
re-enable raw suffix publication on the next ordinary newline. An oversized-line
transition must preserve a detected dump-suppression state, including an oversized
dump opener followed by continuation lines. Keep the existing
sanitizer's behavior for all old app callers. The heuristic is not a universal
proof for secrets the native process invents or reads independently.

Tests must include captured-value canaries split across chunks, ANSI embedded
inside captured secrets, multiline captured values, valid/invalid UTF-8 and NUL,
dump continuations and an oversized dump opener, oversized secrets, escape-heavy
serialized events and final tails. No candidate is qualified
if a canary appears in persisted journal bytes or projected output.

## Finite production budget

New helper:
- packages/legacy-agent-host/src/adapters/providers/observeMemberProcessStderr.ts

Existing member/composition owners:
- packages/legacy-agent-host/src/adapters/providers/MemberProvider.ts
- packages/legacy-agent-host/src/adapters/providers/ClaudeMemberProvider.ts
- packages/legacy-agent-host/src/adapters/providers/CodexMemberProvider.ts
- packages/legacy-agent-host/src/composition/createRuntimeMemberProviderFactory.ts
- packages/legacy-agent-host/src/composition/RuntimeTeamCoordinator.ts

Existing writer and private contract:
- packages/legacy-agent-host/src/runtime/RuntimeOwner.ts
- packages/legacy-agent-host/src/runtime/RuntimeActivityCoordinator.ts
- packages/legacy-agent-host/src/runtime/providerActivityContracts.ts

Pure utility move and existing import compatibility:
- packages/legacy-agent-host/src/diagnostics/runtimeDiagnosticText.ts
- packages/legacy-agent-host/src/diagnostics/diagnosticsRedaction.ts
- packages/legacy-agent-host/package.json (utility exports only)
- src/shared/utils/runtimeDiagnosticText.ts
- src/shared/utils/diagnosticsRedaction.ts

Reuse Plan32's read whitelist, typed contracts, strict activity codec and
HostMemberActivityLog. Add a distinct top-level process-output variant; do not
implicitly allow it as a nested subagent fact. It is Output with actual stderr
provenance; the existing stream filter can exclude it. SDK/HTTP facts stay
unmarked. Search, rich copy, fullscreen and gaps use the existing viewer path.

RuntimeTeamCoordinator is 798 lines; the explicit two-line callback delegation
must fit at 800 without compression or a cap exception. Plan32's activity codec
is 794 lines: if strict top-level-only validation needs more than the remaining
space, extract the existing activity codec together with its private helpers
into one focused output-adapter module and import it, preserving every existing
call and decoder check. Move the existing five shared primitives (row, string,
boolean, oneOf, array) with that block and import them for the existing caller;
never copy them or import back from projectBackendResult to create a cycle. Do not distribute individual cases into unrelated files
or delete formatting to defeat the limit. Root must review the exact extraction
before its source commit; no other projection refactor is included.

Extend the existing desktopProofSupplementarySources roster with the actual
new/changed producers and reused diagnostic utilities; the importing root roster
already has 800 lines. Preserve its existing composition, without a new roster. Preserve existing source receipts, order and all other
pins. No provider archive, lockfile, RPC, schema version, retention increase,
workflow selector, timeout, default activation or Stage2 change is included.

## Required controlled acceptance

Use existing suites where their owned seam already exists:
- captured-claude-process / codex-member-provider: original stderr versus
  stdout protocol canary, finite subprocesses only.
- runtime-activity / member-provider-authority: opening failure persistence,
  original config/incarnation fencing, revocation, closing and cold read.
- team-activity-read / runtimeActivityFacade / hostTaskActivity: strict bounded
  projection, no fabricated task attribution, no conversation/Stats effect.
- hostLogStatsTabs: real stderr filtering, query and retained gap behavior.
- existing Windows provider/facade routing fixture: target stderr attaches before
  original resume; broker/control bytes remain absent.

The new capture helper may have one focused TEST suite if an existing suite
would mix unrelated ownership. Redactor compatibility must be covered by the
existing diagnostic consumer tests plus the capture canaries. The startup test
must emit through the factory callback before sessionRef is installed and then
reject open, retaining the diagnostic under held/open-unknown without inventing
input, terminal state, readiness or custody.

Extend only existing finite peers and desktop-emulated-runtime-ui. Emit a benign
stderr line during the existing bootstrap/stream sequence, no extra business
turn. Assert it within actual Team Logs; exercise stderr selection, search,
fullscreen, copy and cold reload, and prove it absent from exact task logs.
This is emulated application acceptance, not native Claude/Codex qualification.
The no-real-Claude/Codex instruction remains in force.

Estimated change: 180–300 new/changed production lines plus about 110 moved
utility lines, 180–260 targeted test/fixture lines. Complexity 5/10; review must
resolve redaction/framing and opening/closing identity before source publication.
The executor became unavailable on 15 November during independent Plan32 work.
Read-only GitHub source review and immutable candidate blobs are available; no
local execution PASS may be inferred. Use only existing authorized CI on the
reviewed exact commit for any unavailable checks. Keep all delivery holds explicit.

## Independent review record

R1 `/root` inspected the frozen raw-capture/parser path, current original-child
adapters, member factory authority and Runtime journal. R2 `/root/p09_review`
confirmed the pre-session opening record and the separate observational seam;
R2 `/root/qualification_audit` confirmed full OpenConfig/incarnation fencing and
required the framing, ANSI/multiline-secret, NUL and serialized-size clarifications
recorded above. Both retained the existing subagent observer unchanged and require
exact source review before publication. No source or acceptance PASS is claimed.
The executor was restored after the outage; local checks may resume on the exact
reviewed working tree. Missing checks remain explicitly unqualified.

## Exact implementation review and local controlled evidence

R1 implemented the three existing ownership layers; independent R2 root accepted
the full-config/source-grant Runtime fence and the cross-layer contracts. R2
`/root/p09_review` inspected capture framing, real original-child attachment,
redaction compatibility and cleanup. Root found a post-decoding byte expansion
case:10KiB invalid UTF-8 or NUL bytes can become30KiB sanitized UTF-8. The final
helper applies the24KiB bound to sanitized bytes as well and emits an oversized
gap. Both reviewers rechecked the correction and its two expansion canaries.

The pure redactor move preserves existing app behavior. The selected-value
classifier has a distinct purpose from the legacy assignment redactor and
covers already-held credential/cookie/private-key values without reading more
credentials. No equivalent existing selector was found; broadening the old
sanitizer would change its callers, so the small private selector is retained.

Root independently compared the codec extraction: all five primitives are
unchanged; the existing activity block differs only by the new top-level
stderr validation and rejection of nested or input-attributed process output.
Every caller outside the extraction is unchanged. The private decoder is317
lines and its existing caller500; RuntimeTeamCoordinator stays exactly800.
The existing supplementary source roster includes these actual producer/read/
renderer leaves and their reused diagnostic, Markdown and read-owner sources.

The final controlled Node24.21.0 run covers the seven existing/helper suites:
runtime-activity, member-provider-authority, member-process-stderr,
codex-member-provider, captured-claude-process, owned-process-facade and
team-activity-read. It passes92/92,0 skipped. The final six focused Vitest
suites pass62/62; three original diagnostic-consumer suites pass40/40.
Host build/test types, scoped feature/renderer/script TypeScript7, source-size,
architecture, scoped lint and diff checks pass. Actual graphical Desktop
acceptance and resulting-source native platform gates are still required.
No real Claude or Codex executable was used; the process suites use finite
controlled children.

Ordinary process facts do not alter messages, usage, previews, conversation,
readiness or custody. An explicit oversized/storage gap retains the existing
uncertainty policy, including unknown cost when evidence is incomplete.
Preserve that policy rather than inventing a diagnostic-specific exemption.

## Bounded capture follow-up on27b1

The published adapter hook, source-grant callback and full config/incarnation
fence are preserved. The follow-up reuses the existing escaped-assignment
redactor by moving it byte-for-byte to the browser-safe Host diagnostics
export; its old app module is a re-export. Three original consumer suites
pass107/107 with zero skips. No second parser or credential lookup is added.

Independent source review found and closed short-secret masking that could
destroy credential syntax, transformed held-secret fragments, overlapping
exact values, and an ANSI dump opener crossing the existing24KiB discard
boundary. Syntax is classified before exact masking; original and sanitized
held-value forms are masked in one union of spans. Unclassified ANSI loss
fails closed until the existing dump boundary. The24KiB capture/output and
32KiB serialized journal budgets remain unchanged, as do custody and stdout.
All seven published framing cases remain; the extended helper suite passes
19/19. The final seven-suite Host run passes106/106, zero skips.

The original Runtime-team composition tests additionally cover diagnostics
before SessionRef, failed open, permitted closing and rejected stale/revoked/
sealed grants. An actual Claude SDK launches only the finite TEST Node child
through the original CapturedProcess and retains startup plus final stderr
on failed startup; cleanup is checked. The six focused composition/outer-hook
cases pass with zero skips. No real Claude/Codex executable was invoked.
Resulting-source graphical/native gates remain required and unqualified here.
