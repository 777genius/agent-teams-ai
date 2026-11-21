# 44. Load finite TEST peer modules only in the branches that use them

**Selected narrow follow-up; no source applied yet.** Parent: `7428cc9de23b7ed5a8220f9cce024c62d3134416`, tree `5d5c3b66be54f539329d55d1dce01daadbf1bd84`. Retain the complete reviewed Plan43 implementation, all incoming direct-I386 work and all prior history.

## Observed scope and intended change

The original a07 Windows ARM process job `133387301562` ended its finite Codex source-readiness wait after 15016.7292 ms with an attached driver but no settled final readiness result. Both independent reviews found seven legitimate distinct jobs, not repeated false-readiness retries, and no demonstrated removable authority check. The original 15-second deadline, original jobs/actions and successful-readiness requirement remain fixed. [1]

A separate bounded source inspection found explicit builtin-module imports that are unused by the disposable catalog branch. In `providerPeer.mjs`, the Desktop dispatch needs the retained assert/crypto/fs/url guards but does not use spawn, HTTP, createRequire or readline. In `providerDesktopPeer.mjs`, the original Codex catalog branch validates the exact arguments, empty native catalog and missing Team token, writes the same two effects, awaits the stdout write of `[]\n`, and exits 0 before HTTP, createRequire or readline is used.

Move only these existing bindings to awaited imports at the beginning of their existing consuming branches:

- In the existing non-Desktop `else` of `providerPeer.mjs`, load `spawn` from `node:child_process`, `createServer` from `node:http`, `createRequire` from `node:module` and `createInterface` from `node:readline`, in that order, before its original Windows TEST guard and SDK resolution.
- In `providerDesktopPeer.mjs`, load the latter three modules immediately after the original catalog block's awaited stdout/exit, before the existing native-config parse.

This removes explicit module requests from the branch where their bindings are unused. Transitive builtin loading and actual elapsed-time improvement have not been measured. It is **not a demonstrated fix for the 15-second failure**. No SDK or network initialization was found before this catalog exit, and none is moved.

## Exact preservation boundary

Preserve all other bytes in both peers. Do not add a helper, branch, predicate, catch, fallback, output, timer, concurrency change or command. Leave every original guard, source/helper pin, namespace/config check, effect, stderr/stdout handling, native method and signal/cleanup path in the same order relative to the remaining original body. Preserve catalog arguments, empty-directory/absent-token assertions, both effects, awaited write callback and exit 0.

The moment of a module-loading error necessarily moves to the deferred import. It stays an uncaught top-level error; do not claim its original eager timing is preserved. The original pinned Node and its builtin module names are unchanged.

Keep the optional collaboration import and its identity checks before catalog unchanged. Keep the MCP SDK imports inside `connectTeam` unchanged. The generated source wrapper handles `--version` itself and never imports these peers; its original Node hash, loader-environment refusal, version event and output remain untouched.

No production Host, D archive, provider behavior, source admission, encoded spec, process custody, action count, acceptance assertion, timeout or P09 contract changes. Both peer source paths are already in the original source-freeze roster. The Plan43 TEST-wrapper policy pin remains exact.

## Three existing source/validation paths

| Path | Exact preimage | Prospective postimage | Lines |
| --- | --- | --- | ---: |
| tools/owned-process-broker/fixtures/providerPeer.mjs | `44c8cba99e4932905da77539a59c904a39da4e36` | `00c0bbf1b31fea46a19920f38ff347f5ede025da` | 153 |
| tools/owned-process-broker/fixtures/providerDesktopPeer.mjs | `76f5d1953816fd125f576a966c42caefcfc297e2` | `078095a7dce0aa7d1c3981e208c71d8184fcf4ec` | 562 |
| .github/workflows/host-emulated-acceptance.yml | `9ee39ebd4ede06e28d08050694f91de67121326e` | `34e7447dffd5ce545f17cbe873db91aa975d43ea` | 1360 |

The first file removes four static imports and adds four awaited imports. The second removes three and adds three. No fixture grows in line count; both remain below 800 lines.

The existing Host Team fast-lint command already covers `providerDesktopPeer.mjs`. Append only `tools/owned-process-broker/fixtures/providerPeer.mjs` after its current last operand, preserving all 116 existing operands in order, for 117. Only the existing terminal continuation and that new filename change. Preserve all original commands, compiler projects, lint rules, assertions, jobs, selectors, sources, deadlines and uploads. The existing 1360-line CI YAML is outside the production-source size guard; no baseline changes.

## Review and qualification

Independent prospective source review accepted the branch placement on exact blobs `44c8cba99e4932905da77539a59c904a39da4e36` and `76f5d1953816fd125f576a966c42caefcfc297e2`. The frozen three-path diff still requires independent exact source R2. Publish and fully read back this plan before inert source editing, then review and publish the exact source child with an ordinary expected-parent push. Any incoming ref change requires reconciliation; no force or lost author work.

No local project import, provider execution, compiler, benchmark, unit test or manual Actions operation is selected. The natural resulting-source checks must include the original finite provider process/source A/B gates on Windows x64/ARM with Node/Electron, original Desktop peers and cleanup, and the unchanged scoped fast lint/canonical compilers. Do not add a test that merely mirrors import placement or another mandatory CI cycle. Wait useful already-started original jobs before advancing the primary branch.

Only original resulting-source receipts can establish readiness and lifecycle acceptance. A failure remains a failure; do not increase the deadline, remove checks or infer that a late cleanup means readiness would have passed. Genuine Claude/Codex, Ready, main merge, release/default activation and Stage2 remain unselected.

[1] [Original a07 process run](https://github.com/777genius/agent-teams-ai/actions/runs/43892535299), artifact `14239951548`, ZIP SHA256 `f9134f56d694dfa463af1405bdf3d1895b81d4db88bf111ac1a8732c574a5847`. Independent bounded source/timing review SHA256 `f12bac4624105909459c842e1211f5b0806ef76c3c85b9432c29787de2895d13`; frontend followthrough SHA256 `88638e3aad7aa62d88ef0080c8a7bdd88aa26241e5249f9e7ba244ffe3f6b4ca`.
