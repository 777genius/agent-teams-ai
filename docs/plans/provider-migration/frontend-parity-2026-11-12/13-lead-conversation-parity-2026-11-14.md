# Ordinary lead replies in the captured Host conversation

Written on 2026-11-14 before implementation. This plan follows plan 12's
current-base reconciliation. It records the reviewed R1–R3 design; it is
not an acceptance receipt. #1192 remains Draft. It does not authorize real
Claude/Codex execution, a default switch, Stage 2, release or main merge.

## Observed defect and the original behavior

The original d104 Claude Desktop job `132236556375`, run `43527078399`,
reached a succeeded `TEST_UI_BOOT` input through the real Host, checked D,
original Claude SDK and finite TEST peer. The peer journal records
`TEST boot ready`. The original screenshot shows Alice's conversation with
the user's input and no assistant reply. Its SHA256 is
`8fbeba8d8b44aa44ff88c2c0b1bfc7016394685fb3a32dcf6eac3ef73b941111`.
The original visible-text assertion failed. The job also has separate
unconfirmed Host/remaining-process cleanup; fixing conversation does not
qualify that cleanup or turn the failed job into a pass.

Source review independently explains the missing read path. TeamOwner's
`productMessages()` and signed `messages.page` currently read the inbox.
Ordinary provider assistant text is retained by RuntimeActivityCoordinator
and does not become an inbox message. The old frontend merged ordinary
assistant/stream text from TeamDataService and a live lead-process overlay.
The live overlay accepts short nonempty text, so the short BOOT assertion
is valid even though the separate old JSONL extractor has a minimum length.
Legacy durable history retains at most 150 lead texts. Preserve this read
semantics instead of modifying the peer to call `message_send`.

## Owners and non-negotiable boundaries

RuntimeActivityCoordinator remains the sole derived writer under the
original Runtime member fence. FileRuntimeEventStorage owns both its
existing activity record and a separate bounded derived conversation file.
There is no new registry, process, mutable authority cache or autonomous
writer. The existing activity format, digest, 256-event/1-MiB record limits,
32-KiB event limit and normalized 24-KiB text-block limit remain unchanged.

The original runtime inputs are authoritative. `maxQueuedInputs` defaults
to 128 but counts only admitted/active inputs; it is not history retention.
Terminal inputs are not pruned. They remain unique and fingerprint-checked
within FileRuntimeStore's existing 16-MiB state bound. Every conversation
row must still match its original captured input, operationRef, delivery
fingerprint and binding. A copied fingerprint cannot replace a missing,
corrupt or unauthorized original record. Restore lineage must be obtained
from the existing retained launch/checkpoint paths, not a new lookup.

Do not change Team product state, `productMessages`, `collectProductState`,
product snapshots, product sequence or the original product-feed digest.
Do not create a synthetic inbox write, local-command receipt, successful
terminal result or readiness claim. No provider/API contract is broadened.
The unchanged Desktop BOOT, stream, command, reload and cleanup assertions
remain the final visible qualification.

## R3: bounded materialization and cheap change metadata

Add an optional finite conversation marker to RuntimeSessionRecord, checked
by the existing state decoder. It binds the exact Runtime binding, derived
content digest/revision, text high-water sequence and closed gap metadata.
It is a read-invalidation hint, never a substitute for full projection
integrity, input authority, custody or native outcome. Keep it independent
of the activity state digest and all input/config/checkpoint fingerprints
to avoid self-reference, replay changes or activity-feed churn.

Use the existing runtime-events directory and an exact binding-derived
`.conversation.json` path; retain the original activity `.json` path.
The separate derived file carries its own version, exact binding, digest,
revision/high-water and bounded rows. It retains up to 150 distinct
assistant messages, with a maximum serialized file size of 8 MiB,
256 KiB per materialized message and 64 blocks per message. Count the actual
serialized UTF-8 bytes, including metadata. Original per-block normalization
still applies. Budget overflow is explicit partial history, not silent
truncation presented as complete. These finite bounds do not promise 150
arbitrarily large messages. Retention evicts oldest distinct messages by
their original first-observation order, not by the mixed activity ring.

Use an identity derived from the original binding, inputId, operationRef
and provider messageRef. A block snapshot replaces that same block's text;
it must not append the full snapshot again. Preserve original first durable
observedAt and sequence across updates and cold reads. Sort blocks by their
original ordinal and join distinct blocks with the original newline rule.
A stale partial cannot overwrite a completed block.
Equal text in different original messages/inputs remains distinct. Exclude
exact `local-command:` messageRef prefixes because their existing publisher
already owns the corresponding conversation row.

Only accepted text and a conversation-specific gap change may load or
rewrite the derived conversation file. Tool, state and usage events must
neither load nor rewrite it. Ordinary mixed-ring eviction does not erase
valid retained conversation or manufacture a conversation retention gap.
Nontext paths retain their existing allocation and I/O behavior.

The existing changes poll must not read an 8-MiB projection per retained
source every two seconds. Select the exact authorized current lead entries
before expanding retained activity lineage. Read only original Runtime
state and the optional finite marker for change metadata; state remains
subject to its original 16-MiB bound and all original namespace/authority
checks. Aggregate the exact qualified lineage and marker identities into a
finite revision. No cached permission, file integrity or namespace result
may survive an I/O boundary. Full materialization decoding and validation
belongs only to the authorized message page. Both source expansion and
page aggregation retain the existing finite lineage/source limits and the
150-message result bound across all qualified lead sessions, matching the
legacy global cap; do not buffer all source files simultaneously. Dropping
older distinct messages at this aggregate boundary is explicit retention.

## Publication, failure and old records

Publish under the same original member fence. Bind the intended derived
digest/revision/high-water in the original state publication and atomically
replace the derived file through its existing storage owner. This is not a
claim that two files form one atomic transaction. A crash, write failure,
missing file or mismatched marker must be distinguishable on the next read.
Never accept an older file as current merely because it is valid JSON.
Preserve original business settlement/idempotency ordering: derived storage
failure cannot manufacture or rewrite a provider terminal outcome.

When the bound derived file is missing, changed or unpublished, preserve
the original error/hold semantics or return explicit incomplete history
where the existing derived-read contract permits it. Never replace corrupt
history with an empty successful projection. Validation failures must not
be quarantined, repaired, normalized or hidden by a read. A missing marker
on an old record is compatible absence, not permission to create one.

For old records, a page may reconstruct only still-retained dated text
events after full original input and scope checks. Mark the result as
partial legacy history. Undated events cannot receive a new `now`, epoch,
file time or fabricated timestamp. Read-only access never migrates a record.
The next accepted text writer may initialize the derived file from those
qualified dated events under the same fence and must retain the explicit
legacy gap. Lost earlier text cannot be claimed recovered. Cold reads,
reload and same original command replay must not write or re-submit inputs.

Use a fixed finite gap set: `legacy-history`, `undated`, `retention`,
`oversized`, `unattributed`, `storage`, `state-unpublished`, `unsupported`.
Scope/grant/input/digest corruption remains an original refusal where
required; the gap set does not turn an authorization failure into success.
Persist conversation-specific loss so later tool events cannot clear it.
Marker/file disagreement remains visible even if the marker's stored gap
set was captured before the failed file publication.

## Trusted page port and final authority

The original Team owner captures exact Team binding, principal, full grant
fingerprint and current roster/lead identity under its existing fence.
It invokes an optional trusted conversation read port outside that fence.
Only TeamHost composition supplies this port; ordinary/MCP connections
default to their existing product-only behavior. No JSON payload or public
schema can select a port, caller identity or private projection.

Runtime reads use the original authorized member-fence API and qualified
retained/current/restored bindings. `readCapturedSession` by itself is not
an authorization check. After those reads, the Team owner takes its original
fence again, reauthorizes and compares the complete captured identity before
returning changes metadata or signing a message page. A same-revision grant
or roster replacement cannot pass a fingerprint comparison accidentally.
Do not hold a Team lock across Runtime reads or reverse the original lock
order. Original writer/currentness checks remain at their existing cuts.

Merge derived rows with the original inbox rows only in `messages.page`,
before `pageOwnerMessages`. Rows use the existing InboxMessage contract:
captured lead name, original observed timestamp, stable deterministic ID,
`source: 'lead_session'`, and `leadSessionId` formed from the existing opaque
validated RuntimeActivitySource.costScope digest, for example `host-lead-`
plus that digest. Resume retains its existing session group; restart begins
a new group. Do not expose raw D.sessionRef or private OpenConfig IDs.
These rows are ordinary lead replies to the user, not member
inbox deliveries. Preserve the existing filter behavior for lead replies.
The signed page revision covers the composed visible text, principal,
grant, Team and filter. Existing 384-KiB page/240-KiB fragment limits and
fragment validation remain unchanged. A stream replacement invalidates an
old cursor; stable rows do not duplicate after reload or cold restoration.

## Main and renderer integration

Add optional closed conversation metadata to the existing `changes.read`
and `messages.page` outputs: a SHA256 revision and the finite gap set above.
Main validates these fields and preserves the optional original
`leadSessionId` in projected messages. An older Host without metadata stays
compatible. Reject malformed metadata; never coerce it to an empty success.

The existing single, bounded, non-overlapping two-second changes loop
compares conversation revisions per captured handle and emits its existing
inbox invalidation when text changes. It must not advance product sequence,
invent a product event, add a timer or fetch conversation bodies. Scope
switches, released handles and stale read order retain their original
checks and clear only their existing per-scope state.

`readHostMessagesPage` preserves signed fragment/revision checks and maps
closed history gaps to a plain presentation warning. An additive optional
`historyWarning` on the existing MessagesPage result is sufficient. Reuse
the existing MessageHistoryNotice through the original message provenance
state; do not create a new component or fake InboxMessage. Show retained
messages with a clear statement that some replies are incomplete or
unavailable. Existing stale-page/history-refresh errors take precedence;
loading an older page must not accidentally clear a known history warning.

## Closed implementation ownership

Provider agent owns the Host runtime/composition/Team changes:

- `runtime/contracts.ts`, `activityContracts.ts`,
  `RuntimeActivityCoordinator.ts`, `RuntimeOwner.ts`, and a focused
  `runtimeConversation.ts` helper;
- `adapters/runtime/FileRuntimeEventStorage.ts` and `FileRuntimeStore.ts`;
- `composition/readTeamConversation.ts`, `RuntimeTeamCoordinator.ts` and
  `TeamHost.ts`;
- `team/TeamOwner.ts`, `pageOwnerMessages.ts`, and a focused
  `ownerMessageReads.ts` extraction if needed for the 800-line cap;
- meaningful cases in the existing runtime-activity, team-product-changes,
  team-snapshot and runtime-team-host suites.

Session agent owns the corresponding Main DTO/projection and renderer
read/changes/provenance seams, shared MessagesPage type and their existing
focused tests. Agree the exact optional metadata shape before edits.
Extract cohesive existing responsibilities when an owner would exceed 800
physical lines; do not compress formatting or move whole service state to
a generic new framework. Root owns Review repairs and publication. Each
agent independently reviews the other's exact authority and read boundary.

## Required evidence before claiming completion

Use existing meaningful owner tests, not a new layer of helper-only units.
The focused acceptance set must cover these eighteen concrete obligations:

1. Ordinary paired provider text appears on the original signed Team page.
2. A partial snapshot is replaced by the complete text with one stable ID.
3. Multiple blocks retain ordinal order and the first durable timestamp.
4. Equal text in different inputs remains two original messages.
5. More than 256 nontext events do not evict 150 bounded distinct replies.
6. Nontext observe and metadata poll never open the large derived file.
7. Page and aggregate byte/count limits report explicit partial history.
8. Cold/reload reads preserve IDs/order and perform no writes or replays.
9. Old dated rings yield an explicit partial view; undated rows get no time.
10. State/file publication interruption cannot return falsely complete text.
11. Changed/missing/corrupt derived bytes obey the original refusal boundary.
12. Every row still requires the original input/operation/fingerprint.
13. Foreign Team/principal, replaced grant/lead and revoked access refuse.
14. Runtime reads occur outside the Team lock with a fresh final check.
15. Local-command rows remain exactly once and product feed is unchanged.
16. Text-only changes invalidate the original UI inbox without product churn.
17. Signed pagination, stale-scope rejection and partial-history notice hold.
18. The unchanged finite-peer Desktop journey shows the actual BOOT/stream,
    commands and restored history, with its original screenshot and cleanup
    predicates satisfied independently.

Capture intended-before failure for the confirmed missing read path, then
fresh Host/Main/renderer focused results on the exact completed source.
Run the original controlled peers only. Actual Electron screenshots and
receipts are required for visible parity; API success is not that evidence.
Preserve all prior failed receipts, source-only reviews, unavailable checks
and cleanup debt with their exact head and scope. No timeout, native gate,
source pin, CDP ownership assertion or cleanup predicate is relaxed.

## Fresh-record empty marker clarification

Reviewed before implementation: only the original member-fenced transaction
that proves there is no prior Runtime record may publish an explicit empty
conversation marker at sequence zero. Its digest is the deterministic empty
projection for that exact binding and its gap set is empty. This writes no
conversation file. It distinguishes a genuinely new empty session from a
retained older record lacking the optional marker; marker absence alone must
never initialize or reset an existing record. A sequence-zero page accepts
absence or an exactly matching validated empty file only. Any existing
nonempty, foreign, corrupt or mismatched file refuses. Every positive-sequence
marker requires its matching derived file. Original missing-state and
business-settlement guards remain unchanged.

## MessagesPage type boundary

Reviewed before extraction: the existing shared `team.ts` is already at
1838 physical lines against its unchanged legacy cap of 1839. Move only
the existing MessagesPage interface, including its new optional history
warning, into `shared/types/teamMessages.ts`. Import InboxMessage by type
only and re-export MessagesPage by type from the original `team.ts` path.
All consumer import paths and runtime behavior stay unchanged; this adds
no runtime import cycle or new state owner. Do not raise the cap, compress
the interface or remove unrelated documentation to make it fit. Include
the new cohesive type module in the original Desktop source capture.

## New blank-message retention boundary

Independent review found and the existing Runtime test reproduced a concrete
edge: a new empty or whitespace-only provider message consumed a distinct
materialization slot, although the conversation page correctly displays no
such row. Enough blank messages could therefore evict all visible replies.
After the unchanged original input/date/block/text validation and existing
message lookup, ignore only a brand-new message whose text is blank. Preserve
updates to an existing message, including clearing one of its blocks, the
completed-block guard, original IDs and first visible observation time.
The existing retention regression must keep all 150 visible replies and
their exact file/revision after 150 distinct blank outputs, and separately
prove that an existing visible block can still be cleared. This adds no
authority, timestamp, parser, retention-cap or provider-protocol change.

## Persist the original owner regressions in the existing safe UI lane

The general Draft checks do not execute these Host owner suites. Add one
finite contract step only when the existing Emulated Acceptance matrix lane
is `team`, after its coherent Host build. Run the original complete
`runtime-activity.test.ts`, `runtime-team-host.test.ts`,
`team-snapshot.test.ts` and `team-product-changes.test.ts` with the pinned
Node and `--test-concurrency=1`. These suites use the real filesystem owners
and controlled in-process sessions/provider composition; they do not launch
a real Claude/Codex/OpenCode executable. Preserve all seven original UI
commands, admission/source captures, assertions and time budgets. Root owns
the workflow edit; this adds persistence for the reviewed owner regressions
and does not qualify an unexecuted Desktop journey.

## Original allocation witnesses survive loss of all derived files

The stat-only retained-observation check cannot distinguish a never-opened
binding if its original Runtime record and both observation files are all
removed. Reuse evidence already present in the validated launch lineage.
Add a private `TeamLaunchOwner.readActivityLineage(memberId)` projection,
delegating to the existing focused `projectLaunchRestorations.ts` module.
It runs under the original authorized read fence and original full load,
preserving explicit member-action validation. Return only the exact selected
member, its original actions/restorations and its current attempt's
`everReady` witness. It performs no Runtime read, refresh or mutation.

`runtimeActivitySources` replaces its two existing selection/restoration
loads with this one original read. A private `recordRequired` sidecar is
true only for a current exact attempt that was ever ready, a validated
restore's source binding, or the source of a selected member action with
`noAllocation === false`. Merely configured or claimed members and proven
no-allocation Skip do not acquire this requirement. Duplicate exact source
bindings union the requirement while preserving the existing cost-scope
conflict refusal. Other activity consumers retain the same sources/order
and original authority checks.

Pass that private boolean to the existing Runtime conversation read, which
must reject a missing original record before any empty or unsupported
projection. It never enters public payloads, binding/config/input hashes,
persisted records or the conversation revision. No file scan, extra metadata
poll read, cache or authority is added. The existing actual Host tests must
delete all three files after proven readiness and from a qualified restored
source, require both metadata/page refusal, restore exact bytes, and preserve
no-open/no-replay counts. A genuinely unopened lead and original unallocated
Skip must remain empty without creating a Runtime record.

## R4: preserve ordinary long answers within the original history window

Original-source review found a concrete loss in the initial R3 implementation:
`normalizeActivity` turns text above 24 KiB into a gap, whereas the old
coalesced live overlay retains 32,768 characters, non-coalesced final text
is unchanged, and the durable extractor combines text
from its 8-MiB JSONL tail without a 256-KiB message limit. The activity ring
is a diagnostic projection and must keep its original 24-KiB block,
32-KiB event, 256-event and 1-MiB file limits byte-for-byte unchanged.

For an already paired original text observation only, derive conversation
text separately under the same Runtime writer/member fence. Read only closed
primitive text/messageRef/block/phase fields; retain the exact original
prepared observation's input, operation, sequence and timestamp. Missing
preparation cannot invent a sequence or date. Unpaired/invalid input remains
the original gap/refusal. A diagnostic activity-only oversized gap must not
become a conversation gap when the full accepted reply was retained.

This supersedes R3's artificial 256-KiB per-message and 64-block limits.
A message may use the same 8-MiB full serialized conversation-envelope
budget, including JSON escaping, block metadata and provenance; all messages
together remain within that budget and the 150-message upper count. The byte
bound also bounds the number of retained blocks. Do not truncate text or
increase the activity/page/fragment budgets. A new reply or replacement that
cannot fit as one valid conversation envelope must produce an explicit
oversized gap and preserve the previously valid reply. Meaningful existing
owner cases must cover 65 ordered blocks, a 30-KiB live snapshot/completion,
a 300-KiB escaped multibyte reply through original signed fragment pages and
cold reads, and the exact serialized budget boundary plus one byte.

R4 transport proof: strengthen the existing 420-KiB Unicode signed-page
positive with `source: 'lead_session'` and an opaque `host-lead-` session ID.
The existing helper invokes the actual Host pager and Main projector before
renderer assembly. Require exact full text, original identity/source/session
and no private fields. First retain failure with the original continuation,
then minimally preserve those two optional fields in original Host
`pageOwnerSnapshot.messageSegments`; do not relax the renderer, create a new
helper or change any transport budget. Session owns this existing Main test;
provider owns the narrow Host fragmenter change after the before receipt.

Candidate-fit measurement reserves only the finite worst-case closed gap
array and the maximum safe high-water integer inside that same 8-MiB envelope.
Persist exact actual gaps/sequence, not those reserved values. This small
explicit reserve lets a later oversized/storage gap fit without evicting the
last valid reply that already met the bound. Test an envelope exactly at the
reserved bound and a one-byte larger replacement; neither file nor schema
gains a larger limit or additional field.

## Persist full quality checks in the existing safe Team lane

Local full typed lint and a Main shard both exited 137 and remain unqualified.
Before input/source capture, the existing `team` lane will run the canonical
`pnpm typecheck:workspace`, then the three original typed lint scopes
(Main/preload/shared/types, renderer, features) and `lint:mcp` sequentially
and fail fast. Keep the existing 45-minute job budget, all compiler/lint rules,
all seven UI commands and receipt classifiers unchanged. These are quality
checks only; no native provider, readiness claim or Desktop acceptance is
created by this addition. Root owns this workflow edit and publication.

## Canonical Host test type corrections

The first final `typecheck:test` reported two test-only diagnostics after
122 original owner/checkpoint/restore cases passed: a mutable optional file
descriptor loses narrowing inside the deferred `fstatSync` assertion, and
the captured numeric call count needs an explicit annotation under TS7.
Capture the same original descriptor in a local constant before its existing
EBADF assertion and annotate the existing `before` count as `number`. Keep
all cases, assertions, production source and cleanup unchanged. Preserve
the failing typecheck and the original runtime receipt; rerun the canonical
Host test type project after these narrow corrections, and record the three
updated source hashes separately from the earlier runtime-test snapshot.

## Final staged whitespace check

The first cached diff check includes the three newly added Host helpers and
reported one extra terminal empty line in each. Before committing, remove
only that final empty line from `readTeamConversation.ts`,
`runtimeConversation.ts` and `ownerMessageReads.ts`. Do not change statements,
internal spacing, source caps, assertions or command coverage. Preserve the
previous runtime/type receipts and record this source-only difference in the
publication freeze; it is not a new execution result.

## Codex intermediate replies follow the current frontend's complete-item contract

Current-main review on 2026-11-14 resolves frontend
`7408b30b34d2ff280a429766fdbb51976d899af8`'s
[runtime lock](https://github.com/777genius/agent-teams-ai/blob/7408b30b34d2ff280a429766fdbb51976d899af8/runtime.lock.json)
to `v0.0.160`, whose original orchestrator commit is
`e13edcd3d4ffbecc0272ae30195cc6b15b710ee7`. Its
[app-server mapper](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/services/codexNative/appServerRunner.ts)
buffers `item/agentMessage/delta` without publishing assistant text. It emits
text on `item/completed`, before the enclosing turn completes, or flushes
unfinished text at the original turn terminal. Its
[exec JSONL mapper](https://github.com/777genius/agent_teams_orchestrator/blob/e13edcd3d4ffbecc0272ae30195cc6b15b710ee7/src/services/codexNative/jsonlMapper.ts)
also publishes assistant text only for completed agent-message items.
The extracted Codex provider preserves that behavior.

The finite Codex Desktop peer instead sent only a delta and waited for a
release file that the UI writes after seeing intermediate text. That fixture
cycle cannot complete under the original contract. A controlled child-peer
protocol check reproduced the missing completed intermediate item before
the release gate; this is protocol evidence, not an Electron failure receipt.

Correct only the finite Codex peer: complete the intermediate agent-message
item while keeping its original turn active; after the existing release gate,
complete a second item with a distinct original item ID in that same turn,
then emit the original usage and turn terminal. A held turn also completes
its intermediate item before waiting for the original interrupt. Continue
emitting deltas before their item completions, so the original buffering path
remains exercised. Do not reuse a completed item ID, synthesize a second turn,
publish a premature terminal, or replace ordinary text with a Team tool call.

This qualifies obligation 18's finite-peer wording: keep every existing
Desktop visibility, nonterminal-before-release, one release, final reply,
interaction, restored history and cleanup assertion. For Codex this journey
proves intermediate completed messages before the turn terminal. It does not
prove token streaming or replacement of one completed message. Obligation 2
continues to apply to accepted snapshot/complete events with the same message
identity; it does not require a provider to emit snapshots its original
frontend did not expose. Provider source, archives and protocol bounds stay
unchanged. Fresh exact-source Desktop evidence remains required before
claiming that journey passes.
