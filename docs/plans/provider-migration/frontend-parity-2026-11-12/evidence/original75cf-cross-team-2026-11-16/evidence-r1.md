# Original 75cf cross-team lane — source and receipt R1

**The lane is INCOMPLETE because the final owner rollback epoch refused a moved Team-card target before its click. Seven earlier offline UI proofs and the first two owner epochs are PASS. No physical cleanup debt is observed in the retained records.** No source change is selected by this audit.

## Exact evidence

Source `75cf2dcbfe2b540325ea50a022cb5195306a8c59`, original run `43959134362`, job `133621515860`, artifact `14281122548`, `linux-x64`. ZIP: 2,829,525 bytes, SHA256 `59a67cf0928cbc4585740e7ee29b2def6a1f6be71a5d3a6fa967059cf45ce5ca`. Job log: 193,767 bytes, SHA256 `ad1bf32e4c73c13b5d28907d1027721ecb3f3bb3f90daab19ec05d24223b15a8`. Final receipt: 21,065,316 bytes, SHA256 `3d3c805369bb0fd920161eafcc7b4dd64006a9ce065b6c0b6f1ddacc95fe4ce9`. All 44 original members, safe paths, CRCs and extracted-byte hashes were independently verified without executing binaries. Review JSON contains 99 inert checks and seven manual source findings, SHA256 `fe0d4f3cc1c834c91e4e53bfbc8ef09fa2c06c9df92e07dd3db642a726709b21`.

## Earlier successful subflows

The initial Taskboard app completed its functional proofs and original cleanup before the owner continuation. Its seven PASS fields cover original task creation/assignment/dependency/order/attachments; the original review cycle and notification actions; cross-Team Send/Reply with two distinct command IDs and one conversation; a 600,000-byte comment after cold readback; the bounded F08 read-timing scenarios; and exact Task Delete/Trash/Restore with peer Teams unchanged. Proof step counts are 100, 61, 10, 40, 22 oversized-comment steps, 33, and 19 respectively. Each proof retains its explicit exclusions; no blanket visual signoff, native execution, full M05/F08/M18/Stage1 or release claim is made.

At 23:09:59.892516 UTC the main harness printed PASS. Source `desktop-backend-smoke.ts:774–789` then invokes the separate owner continuation. That continuation first requires the initial PASS and empty cleanup, retains the original receipt, and deliberately writes INCOMPLETE before its new epochs (`desktop-owner-routing-ui-smoke.ts:53–74`). The earlier line is therefore not a final lane PASS.

| Owner epoch | Actual result | Reached behavior |
|---|---|---|
| `default-b` | PASS, 45 steps | Original A Task still routes to A; unbound save-only creation and its Task route to B; original bytes and separate owner products verified. |
| `unavailable-a` | PASS, 22 steps | Exact original A profile withheld; its request returns `unavailable/not-dispatched` once, without retry or B effect. Original availability UI, B Task access and read-only product checks complete. |
| `rollback-a` | INCOMPLETE, 17 steps | Original A profile restored with the same hash; original B binding/startup backup joined; A Task creation completes. Selection of B then fails before its physical click and Task Create. |

The rollback A Task is present in the uploaded canonical task JSON and equals both the recorded task and completed command result. It is a real prior effect, not an unexecuted suffix. The failed B Task, two-way rollback-preservation summary, final rollback binding/product snapshots and overall completion assertions were not reached.

## First original failure

The trace at 23:12:50.720606 UTC and the original assertion stack identify `desktop-ui-controls.ts:372`, called by owner selection at `desktop-owner-routing-ui-smoke.ts:431`, `createTask:441`, rollback B mutation at 649, and `desktop-backend-smoke.ts:789`.

The exact B card selector is owner-qualified through `[role="button"][data-team-name="host-team:…"]`. Initial, after-hover and two stable samples all record center `(193.328125, 619)`, rectangle `[16,499,354.65625,240]`. After the original ownership check, the final read records center `(193.328125,489)`, rectangle `[16,369,354.65625,240]`: a 130 px upward translation with unchanged width/height. Both final stable and final samples report zero target animations and loaded fonts. The retained failure PNG visually corroborates the final position; it does not provide a before-movement DOM snapshot.

The strict final equality refuses this changed target before the code records `mouseClick` or dispatches the physical button event. The epoch's last step is only `hover open exact original Team card`. This is not a proven timeout, duplicate target, owner dispatch defect or backend Task-create rejection. The samples do not identify the responsible DOM ancestor or async layout update. No exact repair, geometry tolerance, extra timer, removed ownership fence or retried business click is justified from this packet. The subsequent aggregate validator correctly rejects the final INCOMPLETE receipt.

## Cleanup and identity boundaries

The initial app records requested Quit, exit 0 / no signal, fresh empty group, captured Host/descendants absent, and `original-natural-exit-and-fresh-absence`. Every continuation epoch records verified window-close acknowledgement, listener absent, captured owner Hosts absent, empty remaining group, app exit 0 / no signal, and `signalAttempted:false`. The rollback epoch's two original Host exits are also present in its existing app log. No cleanup/source-freeze error field is present. These observations establish successful cleanup of this failed attempt; they do not make its unfinished business suffix pass.

The owner cleanup helper explicitly limits its claim to guarded original app close and the existing exact-identity wrapper cleanup; it does not claim universal natural exit or native process custody. The unavailable-A result is `not-dispatched`, not an UNKNOWN result. Runtime UNKNOWN release is expressly outside this journey.

The receipt's 1,777 source hashes match before/after, and five exact reviewed source copies match their captured hashes and official 75cf Git blobs. All four app epochs record the same 14 actual compiled main/preload hashes; this does not claim reproducible rebuilding. Both uploaded owner profiles have no Runtime or management configuration. The four final `claude-multimodel --version` records belong to private finite metadata sentinels. No genuine Claude/Codex execution or native provider qualification is inferred.

The archived descriptor is the final rollback descriptor (SHA256 `c5d50ee91a3bf55710e191571e494d4670afc9594702caa6f7b2d35e9a030190`), not the initial original-A descriptor (SHA256 `6f8f32797f2c8cf0fadf8d622f825cc9de4fced8cae483dc8522d81d6d826f25`). This matches the explicitly installed cold descriptor sequence. The separately saved original-epoch receipt and every owner-routing snapshot file are not independent ZIP members; their embedded facts and hashes remain scoped as such.

## Source and execution scope

Reviewed exact producer/consumer files: `desktop-backend-smoke.ts` blob `9c724c3895e467bc1db062e5015ded70c30e65e4`; `desktop-owner-routing-ui-smoke.ts` blob `b0863b23171786c2bcaa127c415e1df102241164`; fixture `eb267a1a5852a1beacdf19b3b2dd376cc6a92dd3`; epoch cleanup `be0e7434575a22d4d15230aa997009f50695181c`; shared UI reader `1c11809c6458f829bd9bb6995aea2ad60b85511e`. No candidate afterimages, project/compiler/tests/provider/native/GUI execution, CI observations/actions, remote mutations or downloads were performed. The positive facts apply only to original 75cf, not the newer publication head.
