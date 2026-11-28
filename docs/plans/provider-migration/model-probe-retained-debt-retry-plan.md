# Retained model-probe cancellation: preserve known debt on retry

Status: source/design and off-repository candidate reviewed independently by provider audit and root before implementation. No product edit, build, test, typecheck, lint, hook or runtime result is claimed. Publish the reviewed follow-up plan before applying its production change. The manifest remains exactly two existing implementation/test paths.

## Exact baseline and proven defect

Target baseline is PR1318 `73c7723c504327c8ba42cf656e7a39912af5e11e`, with the prior original-receipt cancellation repair already present. Both paths are byte-identical in the current merged local HEAD `d14ab30d36ee4b1f352a3190f554e6cde68ea17c` and its worktree. Stage1 `36df9dceba8b080e876952fdce619af447c797c0` still has the older method; its copies are retained only as historical source context and are not this candidate's baseline.

| Path                                                                     | Baseline Git blob                        | Bytes / LF  |
| ------------------------------------------------------------------------ | ---------------------------------------- | ----------- |
| packages/legacy-agent-host/src/management/ModelProbeOwner.ts             | 09687d34488bfc568aea106f393f4d05b1d8c332 | 32644 / 645 |
| packages/legacy-agent-host/tests/management-model-probe-original.test.ts | 41d424cb9906a247eaa17469ff4cd5da7cf7f7dd | 18783 / 517 |

During the original cancellation's native close, a strict-valid same-context replacement may claim `phase: held`, `resourceHeld: false`. The original ActiveProbe rejects the mismatch, does not overwrite that replacement, retains cleanup debt and holds the original resource. finish then removes its active entry. A second cancelRetained call currently has no active entry and no debt check, so it treats that replacement as an ordinary cold record, writes readinessRetired and can resolve successfully. The known original debt is still present, so that success is false even when the original physical close returned true. A false close has the same retry defect.

The caller consequence is concrete: executeLiveRosterMembership.releaseProbe treats resolution as successful cleanup. cancelTeamPreparations also treats resolved calls as successful; its lifecycle, captured Stop, roster-target and member-action callers depend on that rejection. ModelProbeOwner.close and ManagementResourceFence still hold the original debt, so retry must not contradict them.

## Minimal production change

In cancelRetained, retain this exact order:

1. Existing writer check, command-id parse and active entry lookup.
2. Existing active-context conflict check, with its zero-effect refusal.
3. NEW `if (this.debt.has(command)) throw new ManagementCommandError('held');`.
4. Existing full-original retirement/write, one original finish, and final exact released/retired original check.

Place the new guard before any receipt read/write in this method. It uses only this existing owner's retained command debt; it does not add a state owner, map, journal, stored field, selection, provider preparation or native operation. Do not clear debt, delete/repair foreign receipts, re-close a removed native entry, or call assertAdmission in writer-only cleanup. Same-owner known debt remains held even if its stored replacement says released or later identical bytes reappear.

The existing debt lifecycle is monotonic: finish adds the command after unconfirmed cleanup/original-integrity failure, then deletes only its own active entry; no debt.clear/delete path exists. close tests the same set. The resource fence independently holds the original resource when release is unconfirmed. This follow-up concerns that owner's known debt; it does not claim to reconstruct lost in-memory evidence in a new process. No-debt cold retirement remains the exact existing path.

## Exactly two regression cases

Append one two-value loop to the existing original-receipt test file, using its real FileManagementCommandStore, existing ModelProbeOwner/ManagementResourceFence and controlled native run/close promises. Keep all twenty-four current cases byte-identical.

For native close true and native close false independently:

- Admit the original readiness probe and begin the real cancelRetained call.
- Wait for its one original native close to start, then use the actual strict store to install a same-context held/released replacement derived from the retired row. Save exact replacement bytes.
- Settle the original run and that same close. Require the first cancellation to reject held and preserve the replacement. Its counts remain two own writes, one run, one close, zero readiness evidence reads, and one abort.
- Retry the same command/context after the first cancellation settles. Require held, exact replacement bytes and unchanged write/run/close/evidence counts. The original fence must still reject a successor reservation and owner.close must still report held. Neither retry nor owner shutdown may perform another native close.

The unchanged target baseline reaches the second cancellation and resolves it, so the intended RED is the missing held rejection at that exact retry, not an import, parser, unrelated native assertion or timeout. The fixed expectation is two additional passing cases. These outcomes have not been executed.

Keep the existing no-debt cold/sealed-owner success, foreign active-context conflict, legitimate own cancellation, duplicate one-close and original-loss controls. No fallback, deadline, retry-loop or assertion weakening is authorized.

## Finite qualification and publication

After independent plan/source review and normal plan publication, add the two tests against the unchanged actual target helper and run their explicit test-name selection through the normal canonical Host build/test entrypoint. Record both intended baseline failures. Then apply the single reviewed guard and run the whole resulting twenty-six-case original-receipt file, normal Host build, inherited strict Host test graph and changed-file checks as authorized by root. These are planned counts, not results. Preserve any resource failure as an open gate.

Do not copy Stage1's older Owner/test over this baseline. The correction preserves the previously reviewed sticky original loss, full original read/write equality, existing chosen finish phase, one-close behavior, native/debt fences and cold original controls. Family C and Goal integrations remain separate.
