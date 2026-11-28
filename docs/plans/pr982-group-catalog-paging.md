# PR #982 - bounded native group catalog (P1)

Status: reviewed plan, not a passing E2E result. Scope only the already-captured native `group_chat_list` and its MCP schema/port; no group creation/mutation, Main renderer, storage schema or auth changes.

## Source evidence
The existing GroupCommands.read('list') returns all projected retained groups; createGroupMcpTools forwards that array unchanged to formatToolResult, whose non-receipt output limit is 256 KiB. Codex independently reproduced 1,100 valid groups at 292,591 bytes and output-limit. An agent therefore loses group/recipient discovery after retained history grows.

## Implementation
1. Retain the exact original array for small lists and existing callers. For an overflowing native result, return a tagged page `{kind:'group-catalog-page',groups,revision,nextCursor}` containing whole projected group rows and a signed offset continuation; never silently truncate.
2. The fresh source read runs on every page behind the same captured member/team identity and original Team read-grant guard. Scope the cursor to this native port's non-exported nonce, identity and the content revision. Reject altered/replayed/foreign continuations instead of accepting a changed group catalog.
3. Bound serialized page to 240 KiB (below the unchanged 256 KiB MCP formatter limit) with 256 bytes reserved for the signed cursor. Reject a single group that cannot fit; no effect or mutation path.
4. Extend `TeamMcpGroupPort.list(cursor?)`, `group_chat_list` schema and tool description only; Desktop's `team.group.list` remains unchanged. The tool remains read-only.
5. Focused Host regression: >256 KiB catalog reconstructs in order, exact items unchanged; empty/small legacy shape; reject changed revision, malformed or foreign cursors; no oversized page. Then pinned Node24 Host build/typecheck/tests and exact-head CI/native acceptance.

## Critique R1 - authority
Do not accept caller-supplied team/member or root. The cursor is opaque, authenticated with a private captured nonce, and rechecks the same underlying Team grant every call. The source owner remains sole read authority.

## Critique R2 - contract and budget
A row-count-only limit is insufficient. Whole rows must be measured by serialized UTF-8 bytes, not JS string length; the unchanged small-array contract is intentional. Keep the standard 256 KiB output formatter and existing grouped object fields.

## Critique R3 - overlap and safety
No changes to the concurrent OAuth, Restart, process pagination, Mac-owned files, cross-team admission or persistent group registry. No second catalog cache or implicit refresh. The read always recomputes original revision and fails closed if catalog changes between pages.

Estimate 70-120 source LOC + 80-140 test LOC, complexity 4/10, confidence 8/10, reliability target 9/10 after tests. Neither queued CI nor this plan establishes E2E readiness.
