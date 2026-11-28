# PR #982 — Desktop group catalog attention continuation

Status: R1/frontend design, independently reviewed and approved by coordination (R2) and root (R3). Published before production edits.

## Confirmed mismatch and visible effect

At a247d1e7b83c3a92ff3a64ae18b71eb7db2ac4a1, the new Desktop Host group.list route returns a signed group-catalog-page when the canonical catalog exceeds 240 KiB. The renderer assembles pages, but CapturedHostTeamReads.groupNames still performs one read and requires an array. Its production consumer is HostRoutedAttentionSource.listGroupNames → GetAttentionSnapshot.readTeam. The latter catches a name-read failure and uses an empty map, so unread group conversations appear as Group <UUID> instead of their configured names. Messages, unread counts and human tasks remain present. The existing shared fixture bypasses the real Host pager and cannot detect this case.

## Minimal implementation and authority

1. Move the existing renderer's complete-catalog loop into one small core/application/readHostGroupCatalog.ts helper shared by exactly these two current readers. The helper receives an original request callback and a synchronous currentness assertion; it neither discovers a connection nor retries a failed collection.
2. Preserve the existing 128-page bound, public row validator, stable revision and total, exact final count, unique group IDs, repeated-cursor rejection, response-kind consistency, and unchanged small/empty array behavior. Check currentness before each request, after every awaited response, and before returning the complete array. Do not publish intermediate groups or name maps.
3. Renderer createHostGroupChatsApi.list retains the captured opaque team selection and its outer context epoch, while invoking the shared collector. Its existing invoke path still checks the same handle ID and scope around transport awaits. A different handle cannot replace it; the router retains each handle's original stored owner/scope and Host signs the full binding. Mutation lookup, command IDs and all mutation behavior remain unchanged.
4. CapturedHostTeamReads.groupNames captures its original connection once, uses the same connection.handle for every group.list page, and passes this.assertCurrent to the collector. That assertion preserves the entire request-local binding signature, owner resources, context ID and current handle authorization. Each invoke also repeats the existing guard before dispatch and after return. Construct Object.fromEntries only after the complete validated array is available. Preserve its request-local promise cache and the final assertCurrent after cache resolution.
5. Do not change GetAttentionSnapshot's existing fallback policy, names, attention filtering, unread identity, group storage, Host cursor signing, transport budgets or runtime/provider behavior.

## Exact production manifest (3 files)

- NEW src/features/agent-backend/core/application/readHostGroupCatalog.ts
- src/features/agent-backend/renderer/createHostGroupChatsApi.ts
- src/features/agent-backend/main/application/CapturedHostTeamReads.ts

## Focused verification (3 existing test files)

- test/features/agent-backend/fixtures/capturedHostTeamReadsFixture.ts: route GroupCommands.read('list') through the actual Host pageGroupCatalog function and its JSON projection, using a fixture-local private key and fixed original binding. Keep all current Team read/currentness hooks. This is test transport composition only; no production export is added.
- test/features/user-attention/main/hostAttentionSource.test.ts: seed 1,100 valid canonical retained groups with long valid names so the actual projected list exceeds 240 KiB, preserve registry bytes, and seed a canonical unread group message in a group beyond page 1. Before the fix, the real Host pager → Main projection → groupNames → attention snapshot/model yields the UUID fallback; after the fix, every original name and the beyond-page-1 name reach attention, with unchanged unread identity/count and zero legacy fallback. Record multiple original-handle page requests. Add a real registry mutation between pages and prove groupNames rejects and attention receives no partial name map. Add scope/owner revocation during continuation and prove no stale complete result. Small and empty catalogs retain previous behavior.
- test/features/agent-backend/hostGroupChats.test.ts: exercise the extracted collector through the existing renderer API with complete pages, legacy small/empty arrays and a finite negative table (revision/total drift, duplicate IDs, repeated cursor, mixed array/page response, missing terminal count, invalid/empty page, and context change). Retain existing mutation/readback controls.

Run the finite failing attention regression before production edits. Then run the affected Vitest files serially with one fork when root grants the resource slot, and normal scoped strict/lint/format gates. Actual Host pager authority/cursor controls remain covered by the existing Host tests; this continuation does not claim native E2E completion.

## Review and estimates

R1 checks: both active callers share one collector; Main retains stronger captured-catalog authority; no partial map can escape a failed continuation. R2/R3 must inspect unchanged row/cursor ordering and the old renderer behavior before publication. Approximately 80–125 changed production lines, including about 45 moved lines; 130–230 focused test lines. Complexity 4/10; confirmed-source confidence 10/10; reliability target 9/10 after the finite and strict gates.

