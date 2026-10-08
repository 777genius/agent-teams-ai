# Team prompt management verification

## Tested source

- Source: `a629331edab4271c54e6ad9c7aa8ec8b7930b8bb`.
- Host machine ID: `d856d40da5ad4e23b4f67773e5942842`.
- Evidence: `/srv/workers/tpm-70134d0c/team-prompt-management-TEST-E5gsXY/evidence.json`.
- Evidence SHA256: `3b63796e50734147e8384b5f4679eb39ba212b7111d14f24de2b8e1176cbcf36`.
- Subsequent documentation edits and the integration of main CI/release qualification fixes do not change application, MCP, controller or desktop harness code; these match the tested source. Source-size guard passed 3,342 production files, with teams HTTP at 799/800 and no baseline increase.

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
- Normal main-process quit: `mainExitedNormally=true`; six leased dev-wrapper processes were stopped after the graceful window, with no remaining owned processes.

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

- A final review identified partial canonical roster normalization discarding identities/tombstones. Management opts into `requireCompleteMembers` on the existing reader: skipped entries, case-insensitive identity collisions, suffix pruning and invalid lifecycle markers reject before writes; tolerant ordinary reads and legitimate trim/backend migrations remain. Four regression cases failed on the previous reader; all 72 nearest HTTP/reader tests then passed with exact byte/event assertions. Full project typecheck, focused lint and source-size guard passed. Independent review accepted exact `12fcf8eebca55a56554a8ede6048f9d68231bbff`, followed by the fresh native desktop proof above. This protects canonical identities/markers, not arbitrary unknown metadata fields.

- Canonical config and management now share a minimum readable-payload predicate, rejecting missing/blank names and unsafe roster shapes before GET/update/trash writes. All 80 nearest HTTP/reader tests, pinned project typecheck, full focused lint and source-size guard passed. Independent review accepted `05a0fecd34176de286b159440ed4fefdc5d6de16`. A fresh desktop attempt stopped before MCP calls on a missed disclosure click; the harness now waits for stable rendered geometry before real CDP mouse input, preserving the exact responsibility assertion. Independent harness review accepted that bounded fix; the complete fresh native run above then passed.

- Review then identified lossy normalization of recognized optional team/member settings. Management requires complete known metadata through one shared fidelity helper, including nested launch identity and MCP policy; legitimate defaults, trimming and backend migrations remain supported. Present unreadable team metadata rejects before tolerant saved-request reads. Roster replacement also preserves the file-level backend fallback. Fourteen new regressions failed on the prior source; all 254 nearest HTTP/reader/data-service tests and the pinned typecheck passed on the fix. Source-size guard passed; production and the owned HTTP fixture had no full-lint errors. The legacy data-service fixture retains exactly the same 479 pre-existing lint errors as its prior version; these were compared independently, with no new errors or suppression. Independent review accepted the seven-file patch. The fresh native desktop proof above passed afterwards. Unknown future metadata fields are outside this preservation contract.

- Valid but partial member metadata can still leave config-only rows visible through the canonical resolver. Roster admission now requires every resolved non-lead row to have a metadata identity, including tombstones, using the existing resolver and settings-lead rules. This replaces the broad file-presence rejection and permits canonical hidden aliases. The new partial case failed on the prior source; all 120 nearest HTTP/resolver tests passed on the fix, including permitted metadata/lead/trash operations and exact full-array preservation. A fixture literal-type mismatch was corrected without changing data/assertions; pinned typecheck, full focused lint and size guard passed. Independent review accepted exact `a629331edab4271c54e6ad9c7aa8ec8b7930b8bb`, followed by the fresh native proof above.

## Limits

This proves local MCP connectivity with one real native client, not automatic configuration of every external agent. Clients need local execution and MCP support; registration may require their own setup. CDP remains a separate endpoint. Editing/trash applies to draft or stopped teams outside provisioning; running teams require an explicit stop first. Roster replacement rejects stopped teams with resolved config-only members missing from metadata, preserving their saved policies and history; empty/lead-only configurations and hidden CLI aliases remain supported. Result highlighting is session-only, not permanent pinning or an audit history.

Earlier harness attempts failed on a long Unix socket path, process ownership detection and a CSS-uppercase heading assertion. The final fresh run above passed the complete scenario; the earlier attempts are not claimed as passes. Final exact-head required GitHub qualification remains a separate merge gate.
