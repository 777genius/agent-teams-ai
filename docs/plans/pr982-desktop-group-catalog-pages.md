# PR #982 - Desktop group catalog bounded read

Status: reviewed scope / R1-R3; does not itself qualify CI or release.

## Confirmed failure

The native MCP group-chat pager does not protect the Desktop `team.group.list` Host response. The Host method still publishes a complete array; a canonical 4,000-group catalog produces ~1.1 MiB and can exceed the Host priority-frame budget, aborting the transport. The renderer calls this route repeatedly.

## Implementation

1. Reuse the existing 240 KiB whole-group `pageGroupCatalog` pager, but assign an independent private key to the captured Host Desktop composition, and scope every signed continuation to the exact owner/team/principal and original collection revision. Do not cache catalog entries or share an MCP nonce.
2. Only `group.list` accepts an optional signed `cursor`. Validate this in the shared group payload parser and existing typed BackendGroupPayloads. All mutation inputs/identities stay unchanged. Keep the ordinary small-array response intact.
3. After the existing Team `GroupCommands.read('list')` authority check on each request, page the original projected rows *before* serializing the Host reply, including the 256-byte cursor reserve. Pass the original reader guard through every page. Never select another Team when its original grant is gone.
4. Main's output boundary explicitly validates page marker, digest and cursor plus each canonical group through `readGroupList`. The renderer collects pages with its captured selection and scope, rejects repeated cursors, changed revision, malformed/duplicated groups, missing empty pages, changes of response kind and an excessive page count, and publishes only the final complete legacy `TeamGroupChatDTO[]`.
5. Add focused Host serialization and Main/renderer tests for >1 MiB real catalog, full reconstruction, stale cursor, changed authority, and old small responses. Run strict TS and native/desktop exact-head E2E, independent review and CI.

## R1 - durable and authority boundaries

Do not change group storage, writer, native sessions or scheduled refresh behavior. Every page repeats the captured original Team read+grant checks. The cursor is opaque, key-bound, revision-bound and non-transferable. No generic Host response limit relaxation.

## R2 - compatibility and losslessness

Small calls still return the same array, and all existing TeamGroupChatsAPI consumers receive complete arrays. Whole projected group rows preserve identity, status and recipients. Do not filter archived groups, abbreviate names or synthesize a replacement list.

## R3 - failure semantics and overlap

No partial UI state publication. A changed group registry or grant mid-read must fail, not retry silently with a different revision. Keep edits to existing group host composition, group payload parser, public read projection, typed backend result and renderer group-list read. No OAuth, runtime, Restart, macOS files, or provider changes. Do not claim readiness from source-only tests or queued workflows.

Estimates: 85-155 production LOC across bounded files plus 80-150 regression LOC; complexity 5/10, reliability target 9/10 after exact-head tests, confidence 9/10 in reproduced overflow.
