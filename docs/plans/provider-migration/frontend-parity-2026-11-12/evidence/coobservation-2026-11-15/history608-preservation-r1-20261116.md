# R1 — preserve incoming 608ef history without changing selected source (2026-11-16)

## Concrete scope and preconditions

This is a history-only operation on the own branch fix/frontend-parity-coobservation-c714-20261115. Its present published head is 47d9f29602bae778f20ae8cc133ca332e458e59a, tree 2db80678bf674cf8708ee3571e6bf4e22820a468. That complete tree has 10,649 leaves, including 8,798 non-documentary leaves. Every one of those non-documentary path/type/mode/blob identities must survive both this documentary checkpoint and the subsequent history merge.

Before any history-merge postimage is authored, publish this R1 with the already completed GREEN evidence and obtain independent complete published readback. The proposed documentary checkpoint must itself receive complete-tree and full-body review before publication. It adds exactly the six paths listed below and appends the two bounded local qualifications followed by this entire R1 to Plan29. It changes no source, test, workflow, package, lockfile, runner, ignore rule, source-size exception or other existing leaf.

The GREEN claims remain bound to their actual execution commits: Teams c9b2c324fa76e9792791bf16777bb7833834c268 and Windows 47d9f29602bae778f20ae8cc133ca332e458e59a. Full local results and producer audits have already received independent readback. Packing their evidence performs no new execution.

## Documentary checkpoint identities and exact conservation

| New path beneath evidence/coobservation-2026-11-15/ | Immutable identity |
| --- | --- |
| passive-diagnostics-green-evidence-20261116.json | 7d60d9fd5243b574fecfa9b90486e497228cc44f |
| teams-passive-observation-local-qualification-20261116.md | 16ef84fdd0e9161ab34a323282bc2ed362d5608b |
| windows-passive-observation-local-qualification-20261116.md | 0b7558172e2539eb46c29c2531f7c4d175f24024 |
| history608-preservation-r1-20261116.md | Complete text of this R1, then verified published identity |
| history608/0660-to-608-review.md | a960fa16d0dc41909c33fc6a38977ef21a02fe5d |
| history608/0660-to-608-inventory.json | edd69e3ee7b41b8ec29369b0c12ae159b194e015 |

The evidence bundle contains exactly 17 unique intended paths and 162,696 reconstructed UTF-8 bytes: six Teams gate files plus audit 8479aa17860e2da466d4a13e7ef9c9779e24e2b4; eight Windows gate files plus audit 89a0cdc46c334781e3365a80a60e3f177b7faae1 and supplement 86ec07cd067453a05997cc391b52e801b41b840b. There are 14 unique Git blob identities because three complete logs are identical between cohorts. Every original body is a string, with its intended path, exact byte count, SHA256 and Git blob. Recovering it means UTF-8 encoding that string without trimming, newline normalization or parsing/reformatting an embedded JSON body. Independent full-bundle readback must verify all 17 against the accepted originals. Neither an intended path nor an immutable blob reference asserts a separately published leaf.

Let P0 be the complete current own Plan29 blob 8513a8fb862d959e50a433fa4f47b094bedf4c48; TQ the complete Teams qualification above; WQ the complete Windows qualification above; and R this complete R1. The checkpoint Plan29 must equal P0 + two LF + TQ + two LF + WQ + two LF + R. No old byte may be replaced, reformatted or omitted. Plan30 remains fcadb8b52b0ff58f434be7d56acd703dd85dc2b5. All other existing documentary leaves also remain exact.

The two incoming review documents remain verbatim. Their own-source snapshot c9b2 and 42-divergence census are historical, not a substitute for the current47d9 complete tree. In particular, all five Windows producers published after that report must remain selected.

## Incoming history and full inventory

The bounded incoming range is 0660c748f88675063e3051fb0f8b2022e8f6f056 (tree e70ccffc6d55ad42c2249518bf142e2ed32ddf91) through 608efb78823d7c74b35f8a674fcfb6faea8ecfc5 (tree 87e104735545a0860ec2bbcd9bf1ef2318dbbebb). Its four linear commits are:

1. 85355e11fcd08ffe87f96be5003675305458a354, parent0660: 64 new documents and Plan29.
2. 9ead131e41ba806ce3ab47d3ad28feacc5fbd911, parent85355: 124 new documents and Plan29.
3. 6ff83bb45af88f660d8b124e7467664ad2ddd590, parent9ead: only the alternate stderr helper.
4. 608efb78823d7c74b35f8a674fcfb6faea8ecfc5, parent6ff: 90 new documents and Plan29.

Complete, nontruncated inventories show exactly 280 changed leaves: 278 new documentary paths, Plan29 and that one production helper; zero deletions or mode changes. The 278 documentary additions total 39,962,670 bytes by immutable Git metadata. Their entire path/type/mode/blob/size ledger is preserved in edd69e3ee7b41b8ec29369b0c12ae159b194e015. No collision exists in the captured actual47d9 tree; verify that again against the actual post-checkpoint first parent.

Preservation is by exact immutable identity. This R1 does not claim every incoming raw archive has been re-read, extracted, hash-checked or CRC-verified. Historical execution assertions remain attributed to the incoming source and budget. Four code-shaped files beneath docs/evidence are archives, not selected executable postimages: the dormant Installer controls, its test, its nested workflow and the alternate privacy helper copy. Keep their original paths. Existing workspace, TypeScript, Vitest and source-size selection must remain untouched. ESLint has no blanket docs exclusion; an explicit file lint could select archived TypeScript. Do not add an ignore or claim general lint immunity.

## Selected-source conflict disposition

Retain **every** current own non-documentary leaf, including privacy helper 6ea373c48119c94b796e28209a03602d0a438e86 and test 2891a53b464c400c64ab41dd99674ac6c463b39a, Teams f253/186b, the five Windows producers and three tests, getter8e988, Management342, Installer1e943, c79 provider archives and all reviewed native/custody/source changes. Do not select incoming helper 0b0fc2a68fe678ebbce24227bf6e6002d12701d9.

Complete source review finds two static regressions in0b0 relative to already present own oracles: it selects an ambiguity marker before the original post-mask overflow decision, and it fails to derive the whitespace normalization of every captured JSON-escaped held form. The detailed traces and whole-source identities are in a960/edd. These are static findings, not a new runtime execution of0b0. Our27-case test retains the incoming24 and three additional oracles. No incoming historical PASS overrides the selected own algorithm or its existing actual-source qualification.

## Subsequent ordinary merge, after published-R1 readback

Capture the actual own branch head after this documentary checkpoint and verify its full tree and ancestry. That actual published descendant, with no unreviewed intervening change, is the **first** parent. The exact pinned608ef head is the **second** parent. Use one ordinary two-parent Git commit; no squash, rebase, force, reset, default/main merge or substitution of incoming history.

The merge tree is defined by only:

- all then-current own leaves unchanged, except the Plan29 append below;
- exactly the 278 incoming documentary additions with their original path/type/mode/blob identities;
- Plan29 equal to its complete then-current own text P, followed by two LF, the explicit incoming-attribution marker A, the exact incoming suffix S, two LF, and the selected-source disposition marker D. Both markers must be fully read and accepted in the later composition review.

S is defined exactly by ca171cbe7936f2e19214c0d61be34db671b54a1c = 22f00c40d0da9b6b2b1354424270d78b1484af63 + S. It contains 184,227 UTF-16 code units / 184,292 UTF-8 bytes, SHA256 0bc25c811f6788320115bf182fdf7ff94d392d6bce32520e9c752f9e03c51006, and already begins with three LF. Preserve every byte. Marker A must label the source range, historical evidence and rejected helper before S. Marker D must retain the explicit6ea/2891 decision, all own47d9 source and unchanged execution/authority boundaries after S. Exact forward concatenation and inverse removal of only the new append must recover the complete prior P.

Before applying the merge, root and an independent reviewer must accept the actual complete proposed tree, every changed identity, exact full Plan29 equation, ordered parents, preservation of all8,798 non-documentary leaves and no unexpected path. Commit creation must be followed immediately by pushing the own branch in the same operation, with the captured expected first-parent lease and no force. Then independently read back the complete published commit/tree/parents and Plan29. A remote mismatch requires inspection, not a blind retry.

## Changed-path routing and later qualification

The real existing ancestor b3e3bc604e2053b70de75d3d5307f408a04920a4 already contains every test-first source and preceding repair. From it to actual47d9 there are exactly six changed producer paths. The projected later history result has 291 distinct changed paths: six producers,278 incoming documents,one Plan29 and these six new documents. This transparent lossless documentary packing keeps the eventual original changed-file filter range below300 without relocating source, removing evidence or changing a workflow. Calculate the actual complete three-dot inventory after publication; a projected number is not final CI routing proof.

A read-only feasibility review fetched all42 unchanged workflow bodies. That narrower real source range currently selects nine opened-event definitions: Announcements, General CI, CodeQL, Packaged, Host Emulated, Host Process, Stage1, Sentry and Teams. CodeQL's one job and Sentry's three retain their original Draft skips; General's Draft full-qualification refusal also remains. Packaged's original full five-platform classifier, Host18 Desktop plus4 safe shards, Process5, Stage1 nine jobs and Teams3 remain eligible. No workflow or filter is altered.

This R1 **does not authorize creating a CI venue**. After the history merge, a separate concrete R1 must bind the actual resulting head, existing real base, complete changed-path census, fresh full42-workflow routing/classifier proof, exact frozen refs and original commands/deadlines. It must be published and independently read back before any new refs or Draft PR. Frozen PR1206/1207/1208/1211, including original2ab cohorts, remain unchanged and continue to their own conclusions.

## No additional execution or promotion

This documentary/history operation needs no runtime test, build, compiler, native experiment or vendor invocation. It consumes no new local gate allowance and resets none. Earlier killed or failed gates remain recorded, and all exhausted allowances remain exhausted. Never invoke real Claude/Codex, including version probes. The original15-second Windows Process waits, Teams60-second hydration, P08 separate10-second Retry, P09 script/native contract and M16/platform/UI qualification remain open on their exact scopes.

Main delivery PR1192 remains open Draft, based on def734338f13bcc3209e78079a0cedbc48f05a5b. Do not move its branch in this operation. No main/default merge, Ready, release, provider default activation, Stage2, cancellation, manual rerun or retrospective PASS substitution is granted.
