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
