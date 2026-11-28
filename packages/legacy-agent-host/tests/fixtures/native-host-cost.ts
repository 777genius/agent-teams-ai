import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeDigest } from '../../dist/runtime/identity.js';
import { digest, effectId } from '../../dist/team/identity.js';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};
async function json(path: string, maxBytes = 256 * 1024): Promise<unknown> {
  const stat = await lstat(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes);
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function assertRetainedCodexUsage(teamRoot: string, binding: Row): Promise<void> {
  const root = join(teamRoot, '../..'), bindingKey = runtimeDigest(binding);
  const memberKey = runtimeDigest({ backendId: binding.backendId, teamId: binding.teamId, memberId: binding.memberId });
  const session = record(await json(join(root, 'runtime-sessions', memberKey, bindingKey + '.json'), 16 * 1024 * 1024));
  assert.deepEqual(session.binding, binding); assert.ok(Array.isArray(session.inputs));
  const sessionInputs: Row[] = session.inputs.map(record);
  const activity = record(await json(join(root, 'runtime-events', bindingKey + '.json'), 1024 * 1024));
  const { digest: activityDigest, ...body } = activity;
  assert.equal(runtimeDigest(body), activityDigest); assert.deepEqual(activity.binding, binding);
  assert.ok(Array.isArray(activity.events) && activity.events.length <= 256);
  const usage = activity.events.map(record).filter(event => record(event.data).kind === 'usage');
  assert.ok(usage.length > 0, 'actual Codex usage remains retained despite unavailable totals');
  for (const event of usage) {
    const inputs: Row[] = sessionInputs.filter(input => record(input.intent).inputId === event.inputId &&
      input.operationRef === event.operationRef);
    assert.equal(inputs.length, 1, 'retained usage belongs to one exact Runtime input and operation');
    assert.deepEqual(record(inputs[0]!.intent).binding, binding);
    for (const field of ['inputTokens', 'outputTokens']) {
      const value = record(event.data)[field];
      assert.ok(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
    }
  }
  for (const field of ['inputTokens', 'outputTokens'])
    assert.ok(usage.some(event => Number(record(event.data)[field]) > 0), 'actual raw usage reports positive ' + field);
}
export interface NativeHostCostProof {
  commandId: string;
  receipt: Row;
  reply: Row;
  snapshot: Row;
}

/** Read the actual product writer's original command and reply; never construct or repair evidence. */
export async function readNativeHostCostProof(options: {
  teamRoot: string;
  commandId: string;
  memberName: string;
  principalId: string;
  binding: Row;
  stats: Row;
}): Promise<NativeHostCostProof> {
  const { teamRoot, commandId, memberName, principalId, binding, stats } = options;
  const receipt = record(await json(join(teamRoot, '.host-owner/commands', digest(commandId) + '.json')));
  const command = record(receipt.command), payload = record(command.payload), snapshot = record(receipt.hostCommand);
  assert.equal(receipt.commandId, commandId);
  assert.equal(receipt.principalId, principalId);
  assert.equal(receipt.phase, 'completed');
  assert.equal(receipt.messageRecipientRole, 'lead');
  assert.equal(command.operation, 'message.send');
  assert.equal(payload.nativeCommand, true);
  assert.equal(payload.to, memberName);
  assert.equal(payload.text, '/cost');
  assert.equal(payload.messageId, commandId);
  assert.equal(snapshot.kind, 'cost');
  assert.deepEqual(snapshot.binding, binding);
  assert.equal(snapshot.launchId, binding.runId);
  assert.ok(typeof snapshot.capturedAt === 'string' && Number.isFinite(Date.parse(snapshot.capturedAt)));
  assert.ok(typeof snapshot.elapsedMs === 'number' && Number.isSafeInteger(snapshot.elapsedMs) && snapshot.elapsedMs >= 0);
  assert.equal(stats.kind, 'host_activity_stats');
  assert.equal(stats.memberName, memberName);
  assert.ok(typeof stats.generations === 'number' && Number.isSafeInteger(stats.generations) && stats.generations >= 1);
  assert.equal(stats.costUsd, null, 'the pinned Codex path reports tokens without a dollar quote');
  await assertRetainedCodexUsage(teamRoot, binding);
  for (const field of ['inputTokens', 'outputTokens'] as const) {
    assert.equal(stats[field], null, 'last-request usage cannot establish a Codex token total');
    assert.equal(snapshot[field], stats[field]);
  }
  assert.ok(Array.isArray(stats.gaps));
  assert.ok(stats.gaps.includes('Codex token totals are unavailable; retained reports describe only the last request.'));
  assert.equal(snapshot.partial, true);
  const replyId = effectId('host-cost-output', commandId, digest(binding));
  assert.notEqual(replyId, commandId);
  const inbox = await json(join(teamRoot, 'inboxes/user.json'));
  assert.ok(Array.isArray(inbox));
  const matches = inbox.map(record).filter(row => row.messageId === replyId);
  assert.equal(matches.length, 1);
  const reply: Row = { ...matches[0]!, read: false }; // UI read flags do not rewrite the canonical content.
  assert.equal(reply.from, memberName);
  assert.equal(reply.to, 'user');
  assert.equal(reply.summary, '/cost');
  assert.equal(reply.timestamp, receipt.createdAt);
  assert.equal(reply.text, snapshot.text);
  assert.equal(typeof reply.text, 'string');
  const text = String(reply.text), lines = text.split('\n');
  assert.ok(lines.includes('Codex usage reported to this Host'));
  assert.ok(lines.includes('Input tokens reported: not reported'));
  assert.ok(lines.includes('Output tokens reported: not reported'));
  assert.ok(lines.includes('Price: not reported by Codex.'));
  assert.ok(lines.includes('Elapsed since this launch: ' + Math.floor(Number(snapshot.elapsedMs) / 1000) + 's'));
  assert.equal(text.includes('not a full session total'), snapshot.partial);
  assert.doesNotMatch(text, /\$|API duration|Total cost/);
  const effects = record(receipt.effects);
  assert.equal(record(receipt.result).deliveryId, undefined);
  assert.equal(typeof effects.deliveryId, 'string');
  await assert.rejects(lstat(join(teamRoot, '.host-owner/outbox', String(effects.deliveryId) + '.json')),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    'Host /cost creates no native delivery intent');
  return { commandId, receipt, reply, snapshot };
}
