# Team prompt management verification

## Tested source

- Source: `8484cb8bc916f5191b9c43546f9fc60ce376806d`.
- Host machine ID: `d856d40da5ad4e23b4f67773e5942842`.
- Evidence: `/srv/workers/tpm-70134d0c/team-prompt-management-TEST-vGpqns/evidence.json`.
- Evidence SHA256: `1b5c1c54a7ee46367e781863b62a57a1a130b7ac4bb5bde1a42906680120860e`.

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
- Normal application quit: `mainExitedNormally=true`, no fallback kills and no remaining owned processes.

## Focused validation and review

- Full project typecheck, full lint and MCP lint passed at product source `4532576bad88e56a18d0c8a44a458a787bdecc26`; subsequent source changes affect only the desktop harness. Its native TypeScript config passed at the tested source above.
- 302 tests in seven focused backend/UI suites passed at that product source. Existing reader, deterministic launch and roster-lock suites also passed (27/18/6 tests).
- MCP typechecks, all 67 MCP tests and controller/MCP builds passed; their source was unchanged by later fixes.
- Production source-size and provisioning architecture guards passed without raising baselines.
- Independent backend review accepted `8dcc611ad248cb08a84b95614cb7e7f55ddab2de`; later commits do not change backend semantics. Independent UI review accepted `34844cc41ade1f72d1446598d518d4d65d625722`; final harness review accepted the tested source above.
- Two independent plan reviews accepted the bounded implementation plan.
- The first full CI exposed four outdated fixtures (prototype-only service instances, missing mock/AST ports, and metadata already above the existing reader limit). Only these fixtures were corrected; all 283 tests in those suites and full project typecheck then passed on the worker. Native desktop product/harness source above remained unchanged.

## Limits

This proves local MCP connectivity with one real native client, not automatic configuration of every external agent. Clients need local execution and MCP support; registration may require their own setup. CDP remains a separate endpoint. Editing/trash applies to draft or stopped teams outside provisioning; running teams require an explicit stop first. Result highlighting is session-only, not permanent pinning or an audit history.

Earlier harness attempts failed on a long Unix socket path, process ownership detection and a CSS-uppercase heading assertion. The final fresh run above passed the complete scenario; the earlier attempts are not claimed as passes. Final exact-head required GitHub qualification remains a separate merge gate.
