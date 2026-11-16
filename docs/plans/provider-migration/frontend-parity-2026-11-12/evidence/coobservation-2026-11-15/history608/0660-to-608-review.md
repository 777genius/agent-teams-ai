# Incoming 0660 → 608ef: read-only history and source review

This report recommends retaining our reviewed source and preserving the four incoming commits and their documentary evidence under a separate history-only R1. It creates no merge postimage and authorizes no source, ref, PR, CI or execution action.

## Exact snapshots and complete inventory

Incoming base is `0660c748f88675063e3051fb0f8b2022e8f6f056`, tree `e70ccffc6d55ad42c2249518bf142e2ed32ddf91`. Incoming head is `608efb78823d7c74b35f8a674fcfb6faea8ecfc5`, tree `87e104735545a0860ec2bbcd9bf1ef2318dbbebb`. PR1192 was open Draft at that head, with unchanged base `def734338f13bcc3209e78079a0cedbc48f05a5b`. The own source snapshot used here is `c9b2c324fa76e9792791bf16777bb7833834c268`, tree `3ee2cc40cbbebb511f9908019aa0584e075cc51d`.

All five incoming commit trees, including the original base, were fetched in full with `truncated:false`. Leaf counts grow from10,056 to10,334. The complete delta is **280 leaves:278 added documentary files, one modified Plan29 and one modified production helper**. There are no deletions or mode changes. The278 additions total39,962,670 bytes according to their Git tree metadata and have no path collisions with the observed own tree. This is an immutable identity inventory, not a claim to have re-read, extracted or CRC-verified every archived payload.

The four commits are linear after0660:

| Commit | Parent | Complete change |
| --- | --- | --- |
| `85355e11fcd08ffe87f96be5003675305458a354` |0660 |64 added docs plus Plan29 |
| `9ead131e41ba806ce3ab47d3ad28feacc5fbd911` |85355 |124 added docs plus Plan29 |
| `6ff83bb45af88f660d8b124e7467664ad2ddd590` |9ead |Only stderr helper6b6c→0b0 |
| `608efb78823d7c74b35f8a674fcfb6faea8ecfc5` |6ff |90 added docs plus Plan29 |

The accompanying JSON retains every full commit/tree/parent ID, all278 path/blob/mode/size mappings, the sole executable patch, both whole-source hashes and the42 own non-documentary divergences from0660.

## Plan29 conservation

The actual incoming Plan29 postimage `ca171cbe7936f2e19214c0d61be34db671b54a1c` equals the **complete** predecessor `22f00c40d0da9b6b2b1354424270d78b1484af63` followed by one exact suffix S. There is no replacement or inserted old-content block.

S is184,227 UTF-16 code units and184,292 UTF-8 bytes; SHA256 `0bc25c811f6788320115bf182fdf7ff94d392d6bce32520e9c752f9e03c51006`. It already begins with three LF. The full predecessor is1,278,080 characters/1,278,823 bytes and the full incoming postimage is1,462,307 characters/1,463,115 bytes. Forward concatenation and removal of exactly S both reproduce the fetched originals. Plan30 and every other preexisting documentary leaf are unchanged in this range.

A future history composition must preserve the complete then-current own Plan29 prefix, append this incoming suffix with explicit historical-source attribution and retain the rejected alternate-helper decision. It must freshly capture the actual own publication descendant; this report does not invent a future parent SHA.

## Sole incoming source: retain our privacy repair

Incoming `packages/legacy-agent-host/src/adapters/providers/observeMemberProcessStderr.ts` changes `6b6c7003960eb4075d74ca449d303602e99ef83e` to `0b0fc2a68fe678ebbce24227bf6e6002d12701d9` (+8/−1,172 physical lines). All other executable/test/workflow bytes remain exact0660. The existing incoming test is still24-case `0727339627757c3a96d54da2933eb7c1b60685f7`.

**Do not substitute0b0 for our6ea.** Two existing own oracles explain the difference without a new execution:

- **Post-mask overflow:** incoming chooses the whole-line ambiguity marker before applying the byte limit to the original syntax-then-held result. In the existing `'q '.repeat(3000)` plus held Bearer-value case, short-secret expansion makes that original result exceed24KiB. Incoming would emit the10-byte marker and lose the required oversized gap. Own6ea preserves original empty/overflow decisions first.
- **Whitespace-folded JSON-escaped held value:** the original captured forms distinguish two literal spaces plus an actual tab from their JSON-escaped and whitespace-folded forms. Folding the escaped line leaves a literal backslash-t while collapsing its two spaces. Incoming masks only H in the raw/folded line; it never derives N(H), so neither ambiguity check recognizes this held form before syntax removes its Bearer prefix and password token. A suffix remains outside a full held-value match. Own6ea derives N of every already captured form.

These are static source traces, not newly executed failures or retained emitted-output claims. Both exact regressions already exist in own27-case `2891a53b464c400c64ab41dd99674ac6c463b39a`, along with the unmodified incoming24 and the exact escaped control. Retain helper `6ea373c48119c94b796e28209a03602d0a438e86` and test2891. The incoming privacy R1 and its original0660 evidence remain attributed history; they do not supersede our accepted algorithm or qualify another source.

## Documentary candidates and preservation limits

Four added files have code-shaped suffixes under `docs/.../evidence/`: archived Installer controls, its test, its nested workflow, and a documentary copy of incoming0b0. They are **not selected executable changes**. Their exact archival paths must remain intact. Root/script TypeScript and root Vitest include roots, six explicit workspaces and the source-size docs exclusion do not select these paths. A nested workflow beneath docs is not an actual root workflow.

There is no blanket docs ignore in either ESLint configuration. Ordinary lint scripts choose `src/`, but explicit file-oriented lint or a broadened glob could select an archived TypeScript file. Do not claim general lint immunity or change a discovery/ignore rule to hide a failure.

The observed own tree already contains the published Teamsf253/186b, Installer1e943 and getter8e988, Management342fab, original15-second Profile0486/Scenario605, repaired c79 provider pair and the reviewed privacy/native/source/test changes. None of these is changed by the new incoming range; none should be rolled back during history preservation. The separately reviewed Windows producer is another scope whose actual published bytes must likewise survive.

A later ordinary merge may use a fresh own first parent and608ef as second parent to retain all four incoming commits while selecting every actual own non-doc leaf. Root must first publish the separate history-only R1 and obtain full composition review. No incoming historical PASS transfers to own source. No new test, compiler retry, budget change, frozen-CI update, primary update, Ready/main/release/default activation or real provider action is granted here.
