# Team prompt management verification

## Tested source

- Source: `c2d039cabd33a447118e7a1bdb7b3aea1d4eaa05`.
- Host machine ID: `d856d40da5ad4e23b4f67773e5942842`.
- Evidence: `/srv/workers/tpm-70134d0c/team-prompt-management-TEST-2A5LFk/evidence.json`.
- Evidence SHA256: `a5b0979b624b54d44530c6d6cf8c6cac6d9ff9db77545be230b9bb3ecd00a6f0`.
- Later commits change only documentation; application, MCP, controller and desktop harness match the tested source.

## Actual desktop and native MCP proof

`pnpm dev:mcp` ran with a fresh TEST project, HOME, data root and Electron profile on the worker scratch filesystem. Codex CLI app-server 0.159.2 connected to the real application MCP endpoint. No model inference, provider credentials, team launch, task assignment or real user project was used.

Passed:

- Native discovery and empty `team_list`; two providerless draft creates.
- Metadata and roster edits, coherent readback and rejected stale revision.
- Canonical Created/Edited cards, factual summaries and latest change first; earlier successful edits survive a subsequent rejected operation.
- Reversible trash, restore through the existing UI and preserved members/instructions/unresolved runtime selection.
- Reload preserves teams and clears session-only result badges.
- Read-only shared template roster, 14 identities across four references, no member editing controls.
- Real clipboard copy contains the request, templates, MCP and independent CDP endpoints.
- Dark 320px and light 1280px popup screenshots; manual visual inspection passed.
- Normal main-process quit: `mainExitedNormally=true`. Six remaining owned launcher/child leases required the harness fallback; no owned processes remain.

## Focused validation and review

- Full project typecheck, full lint and MCP lint passed at product source `4532576bad88e56a18d0c8a44a458a787bdecc26`. Full project typecheck and focused lint passed again after the unreadable-roster fix at the tested source above.
- 302 tests in seven focused backend/UI suites passed at that product source. Existing reader, deterministic launch and roster-lock suites also passed (27/18/6 tests).
- MCP typechecks, all 67 MCP tests and controller/MCP builds passed; their source was unchanged by later fixes.
- Production source-size and provisioning architecture guards passed without raising baselines.
- Independent backend review accepted `8dcc611ad248cb08a84b95614cb7e7f55ddab2de` and the final unreadable-roster fix separately. Independent UI review accepted `34844cc41ade1f72d1446598d518d4d65d625722`; final harness review accepted `8484cb8bc916f5191b9c43546f9fc60ce376806d`, with no subsequent harness changes.
- Two independent plan reviews accepted the bounded implementation plan.
- The first full CI exposed four outdated fixtures (prototype-only service instances, missing mock/AST ports, and metadata already above the existing reader limit). Only these fixtures were corrected; all 283 tests in those suites and full project typecheck then passed on the worker. Native desktop product/harness source above remained unchanged.
- A later P2 review found unreadable roster metadata could be normalized to empty and overwritten. Existing-file presence plus the canonical metadata reader now rejects this before writes/events. All seven focused HTTP tests passed, including malformed/oversized byte-preservation proofs and genuinely missing metadata support.
- A later P1 review found destination admission ended between draft rename and provisioning. An existing rename continuation now holds destination identity/lifecycle gates through provisioning; occupied-destination preflight and reentry remain intact. The new deterministic HTTP regression failed on prior production code (interleaved edit returned 200) and passed on the fix (409 TEAM_ACTIVE). All 217 tests in the nearest HTTP/data suites, project typecheck and focused lint passed. Independent review accepted the final five-file fix. No real agent/runtime launch was used for this concurrency proof.
- Final review found config-only stopped rosters could lose saved policies on replacement. Such roster edits now reject before writes; GET exposes the original members and trash preserves them. New saved drafts without config remain writable. Fingerprint reads enforce existing 10 MiB config/256 KiB metadata limits before allocation and cap actual reads if files grow. Independent review accepted both fixes; project typecheck and focused lint passed. The nearest HTTP suite checks exact saved bytes, original policies, no events on rejection and oversized-file refusal. Its initial 10 MiB deep-comparison assertion exceeded the timeout; direct Buffer.equals preserves exact equality without that overhead.

- Final integration with main passed the full pinned project typecheck. The latest HTTP suites passed 61 tests, including real persisted task-interval repair before managed snapshots; the nearest renderer suite passed 61 tests, including nonselected split panes, context changes, pending-trash cancellation and restore. Focused lint and source-size guards passed (legacy store 2,594 lines against the unchanged 2,595 ceiling). Independent backend review accepted the repair at `c2d0a8ee07d16b804d5231083f1dc47d924cc10c`; independent UI review accepted `b7b00c37c19e975e073a61df00104ad646196d82`. Their application/MCP/controller/harness code is unchanged by the subsequent main integration.

- Ordinary HTTP/MCP reads retain the existing tolerant snapshot path; explicit `configuration=1` / MCP `configuration=true` requests the admitted coherent configuration revision. Malformed, empty or non-object config rejects with typed `TEAM_CONFIGURATION_UNREADABLE` before writes. Independent review accepted `4596d618c287638a5912bcb00f65e27cfb366dff`; a subsequent test-only assertion permits the canonical lead alongside the unchanged builder. Final nearest HTTP suites passed 66 tests; all 67 MCP and 391 controller tests, project/MCP typechecks, focused lint and controller/MCP builds passed. Actual native desktop proof above uses the opt-in path.

## Limits

This proves local MCP connectivity with one real native client, not automatic configuration of every external agent. Clients need local execution and MCP support; registration may require their own setup. CDP remains a separate endpoint. Editing/trash applies to draft or stopped teams outside provisioning; running teams require an explicit stop first. Stopped teams lacking member metadata reject roster replacement to preserve existing config policies. Result highlighting is session-only, not permanent pinning or an audit history.

Earlier harness attempts failed on a long Unix socket path, process ownership detection and a CSS-uppercase heading assertion. The final fresh run above passed the complete scenario; the earlier attempts are not claimed as passes. Final exact-head required GitHub qualification remains a separate merge gate.
