// Read-only reconciliation of one retained actual Host/native job. Never opens a Host/provider.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { TaskChangeLedgerReader } from '@agent-teams/task-change-ledger';
import { classifyTaskChangeReviewability } from '@agent-teams/task-change-ledger/reviewability';
import { deliveryFingerprint, normalizeBinding } from '../../../dist/runtime/identity.js';
import { nativeToolReceipt, record } from '../native-claude-team/model.ts';
import { treeHash } from '../native-host.ts';
import type { RuntimeDelivery } from '../../../dist/runtime/contracts.js';

type Row = Record<string, unknown>;
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const root = await realpath(process.argv[2]!);
assert.equal(basename(root), 'TEST-native-host-evidence-cUbfJF');
const output = resolve(process.argv[3]!);
assert.ok(relative(root, output).startsWith('..'), 'collector output is outside original TEST input');
const json = async (path: string): Promise<Row> => record(JSON.parse(await readFile(path, 'utf8')));
const rows = async (path: string): Promise<Row[]> => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => record(JSON.parse(line)));
async function manifest(directory: string, prefix = ''): Promise<Row[]> {
  const result: Row[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name), file = prefix + name, info = await lstat(path);
    if (info.isDirectory()) result.push(...await manifest(path, file + '/'));
    else if (info.isSymbolicLink()) result.push({ path: file, symlink: await readlink(path) });
    else { assert.ok(info.isFile() && info.size < 32 * 1024 * 1024); result.push({ path: file, sha256: digest(await readFile(path)), bytes: info.size }); }
  }
  assert.ok(result.length < 2000); return result;
}
const before = await manifest(root);
const originalBytes = await readFile(join(root, 'receipt.json'));
const original = record(JSON.parse(originalBytes.toString('utf8')));
assert.equal(original.status, 'INCOMPLETE');
assert.ok(String(original.failure).includes('TEST native input did not settle'));
const pins = record(original.pins), hostPins = record(pins.host);
assert.equal(await treeHash(join(root, 'executed-host'), '.js'), hostPins.distSha256);
const providerPins = record(pins.provider);
assert.equal(providerPins.sha256, '6c57a7bb69a5213b75b9d0393c4d2aec0b75096ae147fc65ccae0fc37d190d1a');
assert.equal((providerPins.installed as Row[]).length, 187);
assert.equal((providerPins.installed as Row[]).filter(row => String(row.path).startsWith('package/dist/')).length, 184);
assert.equal(record(pins.sdk).version, '0.3.305');
assert.equal(original.hostDistUnchanged, true); assert.equal(original.nativePinUnchanged, true); assert.equal(original.sdkPinUnchanged, true);
const ownerRoot = join(root, 'store/teams/test-native-team/.host-owner');
const commands = await Promise.all((await readdir(join(ownerRoot, 'commands'))).filter(name => name.endsWith('.json')).map(async file => ({ file, value: await json(join(ownerRoot, 'commands', file)) })));
const created = commands.find(row => row.value.commandId === 'TEST-native-capture-create')!.value;
assert.equal(created.phase, 'completed'); assert.equal(created.principalId, 'alice-session');
assert.equal(record(created.command).operation, 'task.create');
const startEntry = commands.find(row => row.value.commandId === 'TEST-user-start')!; assert.ok(startEntry);
const start = startEntry.value, command = record(start.command), payload = record(command.payload);
assert.equal(start.phase, 'completed'); assert.equal(start.principalId, 'human');
assert.equal(command.operation, 'task.start'); assert.equal(payload.notification, 'user');
const taskId = String(payload.taskId); assert.equal(taskId, record(created.effects).taskId);
const task = await json(join(root, 'store/tasks/test-native-team', `${taskId}.json`));
assert.equal(task.owner, 'alice'); assert.equal(task.createdBy, 'alice'); assert.equal(task.status, 'in_progress');
const obligations = await json(join(ownerRoot, 'task-obligations', startEntry.file));
const plan = await json(join(ownerRoot, 'task-plans', startEntry.file));
assert.equal(obligations.fingerprint, start.fingerprint); assert.equal(plan.fingerprint, start.fingerprint);
assert.deepEqual(plan.result, start.result); assert.equal(record(plan.result).notifiedOwner, true);
assert.equal(record(record(plan.result).task).id, taskId); assert.equal(record(record(plan.result).task).owner, 'alice');
const outboxes = await Promise.all((await readdir(join(ownerRoot, 'outbox'))).filter(name => name.endsWith('.json')).map(file => json(join(ownerRoot, 'outbox', file))));
const matching = outboxes.filter(row => row.commandId === start.commandId && row.messageId === record(start.effects).messageId);
assert.equal(matching.length, 1); const outbox = matching[0]!;
assert.equal(outbox.inputId, outbox.deliveryId); assert.notEqual(outbox.inputId, record(start.effects).deliveryId, 'original harness selected the generic receipt delivery effect instead of the actual task notification');
const expected = (obligations.deliveries as Row[]).filter(row => row.deliveryId === outbox.deliveryId); assert.equal(expected.length, 1);
for (const key of ['commandId', 'messageId', 'inputId', 'deliveryId', 'content', 'binding', 'principalId']) assert.deepEqual(expected[0]![key], outbox[key]);
const notifications = (plan.notifications as Row[]).filter(row => row.messageId === outbox.messageId && row.content === outbox.content && row.member === 'alice'); assert.equal(notifications.length, 1);
const runtimeDirectories = await readdir(join(root, 'store/runtime-sessions')); const runtimeRecords: Row[] = [];
for (const directory of runtimeDirectories) for (const file of await readdir(join(root, 'store/runtime-sessions', directory))) if (file.endsWith('.json')) runtimeRecords.push(await json(join(root, 'store/runtime-sessions', directory, file)));
assert.equal(runtimeRecords.length, 1); const runtime = runtimeRecords[0]!;
assert.equal(runtime.phase, 'closed'); assert.equal(runtime.custody, 'released');
const inputs = runtime.inputs as Row[]; assert.equal(inputs.length, 2);
assert.ok(inputs.every(input => input.phase === 'terminal' && input.terminal === 'succeeded'));
const input = inputs.find(row => record(row.intent).inputId === outbox.inputId)!; assert.ok(input);
const intent = record(input.intent);
assert.equal(input.fingerprint, deliveryFingerprint(input.intent as RuntimeDelivery));
// RuntimeDelivery intentionally omits commandId; the original outbox/obligations own that link.
for (const key of ['messageId', 'inputId', 'deliveryId', 'content']) assert.deepEqual(intent[key], outbox[key]);
assert.deepEqual(intent.binding, normalizeBinding(outbox.binding as RuntimeDelivery['binding']));
const originalInputs = record(original.finalRuntime).inputs as Row[];
assert.ok(originalInputs.some(row => row.inputId === outbox.inputId && row.phase === 'terminal' && row.terminal === 'succeeded'), 'original pre-cleanup runtime DTO already proves actual input completed');
const projectDir = join(root, 'store/teams/test-native-team/.host-evidence');
const events = await rows(join(projectDir, '.board-task-changes/events', `${taskId}.jsonl`));
const notices = await rows(join(projectDir, '.board-task-changes/notices', `${taskId}.jsonl`));
assert.equal(events.length, 4);
for (const event of events) {
  const cause = record(event.causalBinding);
  assert.equal(cause.taskId, taskId); assert.equal(cause.taskStartCommandId, start.commandId);
  for (const key of ['messageId', 'inputId', 'deliveryId']) assert.equal(cause[key], outbox[key]);
  assert.equal(cause.operationRef, input.operationRef); assert.equal(cause.sessionRef, runtime.sessionRef);
  assert.equal(cause.hostIncarnation, runtime.hostIncarnation); assert.deepEqual(cause.binding, runtime.binding);
  assert.equal(cause.configRevision, record(runtime.config).configRevision);
  assert.equal(event.executionSeq, 0); assert.equal(record(cause.provenance).reviewableComplete, false); assert.equal(event.confidence, 'low');
}
const content = async (event: Row, side: 'before' | 'after') => readFile(join(projectDir, '.board-task-changes/blobs', String(record(event[side]).blobRef)), 'utf8');
const failed = events.find(row => row.toolUseId === 'capture_failed_bash')!;
assert.equal(failed.toolStatus, 'failed'); assert.equal(await content(failed, 'before'), 'DIRTY\n'); assert.equal(await content(failed, 'after'), 'DIRTY\nFAILED\n');
const edit = events.find(row => row.toolUseId === 'capture_edit')!;
assert.equal(edit.toolStatus, 'succeeded'); assert.equal(await content(edit, 'before'), 'DIRTY\nFAILED\n'); assert.equal(await content(edit, 'after'), 'DIRTY\nEDITED\n');
const write = events.find(row => row.toolUseId === 'capture_write' && row.relativePath === 'write-target.txt')!;
assert.equal(record(write.beforeState).exists, false); assert.equal(await content(write, 'after'), 'WRITE\n');
const late = events.find(row => row.toolUseId === 'capture_write' && row.relativePath === 'hook-side.txt')!;
assert.equal(await content(late, 'before'), 'HOOK_BEFORE\n'); assert.equal(await content(late, 'after'), 'HOOK_LATE\n');
const hook = await rows(join(root, 'post-hook.ndjson')); assert.deepEqual(hook.map(row => row.phase), ['started', 'finished']);
assert.ok(Number(hook[1]!.at) - Number(hook[0]!.at) >= 600);
assert.ok(Date.parse(String(late.timestamp)) >= Number(hook[1]!.at));
assert.ok((original.hookProof as Row[]).some(row => row.hookRunning === true && row.writeEvents === 0));
assert.ok(notices.some(row => String(row.message).includes('background')));
assert.equal(notices.filter(row => String(row.message).includes('multi-tool-batch')).length, 2);
assert.equal(events.some(row => ['capture_background', 'capture_overlap_a', 'capture_overlap_b'].includes(String(row.toolUseId))), false);
assert.equal(await readFile(join(root, 'workspace/background.txt'), 'utf8'), 'BACKGROUND\n');
assert.equal(await readFile(join(root, 'workspace/overlap-a.txt'), 'utf8'), 'A\n');
assert.equal(await readFile(join(root, 'workspace/overlap-b.txt'), 'utf8'), 'B\n');
const observations = original.modelRequests as Row[]; assert.equal(observations.length, 9); assert.deepEqual(original.modelFailures, []);
const mcpReceipt = nativeToolReceipt(record(observations.find(row => row.turn === 'bootstrap' && row.step === 1)!.lastResult).content);
assert.deepEqual(mcpReceipt, created, 'actual native MCP response is the retained authoritative Team command receipt');
assert.equal(record(observations.find(row => row.turn === 'work' && row.step === 1)!.lastResult).is_error, true);
const reader = await new TaskChangeLedgerReader().readTaskChanges({ teamName: 'test-native-team', taskId, projectDir, projectPath: join(root, 'workspace'), includeDetails: true });
assert.ok(reader); assert.equal(reader.provenance?.sourceKind, 'ledger');
assert.ok(reader.files.some(file => file.filePath === join(root, 'workspace/hook-side.txt')));
assert.equal(classifyTaskChangeReviewability(reader).reviewability, 'attention_required');
const originalHost = record(original.host); assert.equal(originalHost.exitCode, 0); assert.equal(originalHost.signalCode, null); assert.equal(originalHost.stdoutValid, true);
assert.equal(original.cleanupConfirmed, true);
const physical = [Number(originalHost.pid), ...(original.childAbsence as Row[]).map(row => Number(row.pid))].map(pid => {
  let absent = false; try { process.kill(pid, 0); } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH'); absent = true; }
  return { pid, absent };
});
assert.ok(physical.every(row => row.absent)); assert.ok((original.childAbsence as Row[]).every(row => row.absent));
const physicalGroups = (original.childAbsence as Row[]).map(child => {
  const pgid = Number(child.pgid); assert.equal(pgid, child.pid, 'captured native detached group identity');
  let absent = false; try { process.kill(-pgid, 0); } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH'); absent = true; }
  return { pgid, absent };
});
assert.ok(physicalGroups.every(group => group.absent), 'exact captured native groups physically absent');
const after = await manifest(root); assert.deepEqual(after, before, 'every original input file/symlink remains byte-identical after collection');
const reconciliation = { status: 'READ_ONLY_SCOPED_PASS_WITH_GAPS', originalJobId: '5ae851d87e6f8fff8a9a1b9e7b19a68f', originalRoot: root,
  originalResult: 'exit1/INCOMPLETE retained unchanged; harness waited on generic command effect delivery ID', originalReceiptSha256: digest(originalBytes), originalInputManifest: before,
  chain: { taskId, taskStartCommandId: start.commandId, genericReceiptDeliveryId: record(start.effects).deliveryId,
    actualTaskRecoveryDeliveryId: outbox.deliveryId, actualRuntimeInputId: intent.inputId, operationRef: input.operationRef,
    binding: runtime.binding, hostIncarnation: runtime.hostIncarnation, sessionRef: runtime.sessionRef, terminalBeforeCleanup: true },
  checks: { authoritativeNativeMcpCreate: true, taskRecoveryObligationsAndPlan: true, actualNativeInputsSucceeded: 2, nativeRequests: 9,
    failedBashDirtyBeforeAndPartialFinal: true, successfulEditAndWrite: true, delayedMappedPostHookBeforeFinal: true,
    immutableOriginalOwnerAllFourEvents: true, unknownExecutionSequence: true, backgroundAndGroupedIntervalGaps: true,
    portableReaderPartial: true, cleanupClosedReleased: true, hostExitZero: true, physical, physicalGroups, originalRootUnchanged: true },
  events, notices, reader, task,
  unexecutedOriginalActions: ['team.review.getTaskChanges RPC', 'explicit runtime.stop RPC; actual Host close performed provider cleanup'],
  excluded: ['Existing Desktop UI for this native capture', 'independent PostToolBatch hooks', 'background completion qualification', 'external writer exclusivity', 'physical parallel attribution', 'full M13'],
  m13: 'GAP', noReplayOrNativeAllocation: true, noOriginalInputMutation: true };
await writeFile(output, JSON.stringify(reconciliation, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ status: reconciliation.status, output, sha256: digest(JSON.stringify(reconciliation, null, 2) + '\n') }));
