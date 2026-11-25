import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, effectId } from '../../dist/team/identity.js';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};
async function json(path: string): Promise<unknown> {
  const stat = await lstat(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 256 * 1024);
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
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
  for (const field of ['inputTokens', 'outputTokens'] as const) {
    assert.ok(typeof stats[field] === 'number' && Number.isSafeInteger(stats[field]) && Number(stats[field]) > 0,
      'actual native usage reaches the existing Stats authority');
    assert.equal(snapshot[field], stats[field]);
  }
  assert.ok(Array.isArray(stats.gaps));
  assert.equal(typeof snapshot.partial, 'boolean');
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
  assert.ok(lines.includes('Input tokens reported: ' + String(stats.inputTokens)));
  assert.ok(lines.includes('Output tokens reported: ' + String(stats.outputTokens)));
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
