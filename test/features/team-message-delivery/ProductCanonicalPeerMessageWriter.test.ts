import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ProductCanonicalPeerMessageWriter } from '@features/team-message-delivery/main/infrastructure/ProductCanonicalPeerMessageWriter';
import { TeamTaskReader } from '@main/services/team/TeamTaskReader';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  ProductCanonicalEffect,
  ProductCanonicalEffectWriter,
  ProductRecipientPin,
} from '@features/team-task-board/main/infrastructure/HostedProductTaskEffectBoundary';

const roots: string[] = [];
afterEach(() => {
  setClaudeBasePathOverride(null);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const effectId = 'a'.repeat(64);
const fingerprint = 'b'.repeat(64);
const rawTaskId = '1';
const canonicalTaskId = `task_${createHash('sha256')
  .update(JSON.stringify({ domain: 'hosted-task-board-task/v1', teamId: 'team_test', rawTaskId }))
  .digest('hex').slice(0, 32)}`;
const recipient: ProductRecipientPin = {
  teamId: 'team_test', runId: 'run_test', laneId: 'lane_peer',
  memberId: 'member_peer', memberName: 'peer', attemptId: 'attempt_1',
  containerHandle: 'container_1', containerGeneration: 'generation_1',
  sessionId: 'session_peer', planGeneration: 'plan_1',
};
const effect: ProductCanonicalEffect = {
  kind: 'message',
  member: {
    workspaceId: 'workspace_test', teamId: 'team_test', workspaceRoot: '/sandbox',
    planGeneration: 'plan_1', runId: 'run_test', laneId: 'lane_sender',
    memberId: 'member_sender', memberName: 'sender', sessionID: 'session_sender',
    actorId: 'member_sender', deploymentId: 'deployment_test', bootId: 'boot_test',
    restoreGeneration: 1, mountGeneration: 1, declaredRootHash: 'c'.repeat(64),
    ownerAuthority: 'owner_test', ownerGeneration: 1, ownerSessionId: 'owner_session',
  },
  recipient,
  taskRefs: [{ teamId: 'team_test', taskId: canonicalTaskId,
    sourceGeneration: 'task_generation', revision: 'task_revision',
    ownerId: 'member_sender', status: 'in_progress' }],
  text: 'Please review the task.',
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-peer-test-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'inboxes'), { mode: 0o700 });
  fs.mkdirSync(path.join(root, 'product-peer-outbox'), { mode: 0o700 });
  const claudeBase = path.join(root, 'claude');
  const tasksDirectory = path.join(claudeBase, 'tasks', 'test-team');
  fs.mkdirSync(tasksDirectory, { recursive: true });
  fs.writeFileSync(path.join(tasksDirectory, `${rawTaskId}.json`), JSON.stringify({
    id: rawTaskId, displayId: 'T-1', subject: 'Review task', status: 'in_progress',
    owner: 'sender', comments: [],
  }));
  let current = recipient;
  let currentSender = effect.member;
  let committed = false;
  const makeWriter = () => new ProductCanonicalPeerMessageWriter({
    teamId: 'team_test', teamName: 'test-team', teamDirectory: root,
    withProductWriterLock: (run) => run(),
    taskRefForCanonicalTask: (task) => task.taskId === canonicalTaskId
      ? { taskId: rawTaskId, displayId: 'T-1', teamName: 'test-team' } : null,
    currentRecipient: () => current,
    currentSender: () => currentSender,
    hasCommittedReceipt: () => committed,
    authenticationKey: Buffer.alloc(32, 0x61),
  });
  const contract: ProductCanonicalEffectWriter = makeWriter();
  void contract;
  return {
    root, claudeBase, makeWriter,
    inbox: path.join(root, 'inboxes', 'peer.json'),
    intent: path.join(root, 'product-peer-outbox', `message_${effectId}.json`),
    setRecipient: (value: ProductRecipientPin) => { current = value; },
    setSender: (value: typeof effect.member) => { currentSender = value; },
    commitReceipt: () => { committed = true; },
  };
}

describe('ProductCanonicalPeerMessageWriter', () => {
  it('commits one TeamInboxWriter-format row and immutable Owner delivery version', async () => {
    const f = fixture();
    const writer = f.makeWriter();
    const receipt = writer.withExclusiveLock(() => writer.writeOnce(effectId, fingerprint, effect));
    expect(receipt).toBe(`hosted-product-peer:message_${effectId}`);
    const messages = JSON.parse(fs.readFileSync(f.inbox, 'utf8')) as Array<Record<string, unknown>>;
    expect(messages).toEqual([{
      from: 'sender', to: 'peer', text: 'Please review the task.',
      timestamp: expect.any(String), read: false,
      messageId: `message_${effectId}`,
      taskRefs: [{ taskId: rawTaskId, displayId: 'T-1', teamName: 'test-team' }],
    }]);
    setClaudeBasePathOverride(f.claudeBase);
    const tasks = await new TeamTaskReader().getTasks('test-team');
    const refs = messages[0].taskRefs as Array<{ taskId: string }>;
    expect(tasks.find((task) => task.id === refs[0].taskId)?.displayId)
      .toBe('T-1');
    expect(writer.resolveOwnerDelivery(`message_${effectId}`)).toBeNull();
    f.commitReceipt();
    const version = writer.resolveOwnerDelivery(`message_${effectId}`);
    expect(version).toEqual({
      kind: 'peer', sourceRef: `message_${effectId}`, revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      runId: 'run_test', memberId: 'member_peer', attemptId: 'attempt_1',
      containerHandle: 'container_1', containerGeneration: 'generation_1',
    });
    expect(Object.keys(version!)).toHaveLength(8);
    expect(writer.withExclusiveLock(() => writer.writeOnce(effectId, fingerprint, effect))).toBe(receipt);
    expect(JSON.parse(fs.readFileSync(f.inbox, 'utf8'))).toHaveLength(1);
  });

  it('recovers an intent after an interrupted inbox write and rejects altered replay', () => {
    const f = fixture();
    // A malformed inbox makes the append fail after the WAL intent was fsynced.
    fs.writeFileSync(f.inbox, '{broken', { mode: 0o600 });
    const writer = f.makeWriter();
    expect(() => writer.withExclusiveLock(() => writer.writeOnce(effectId, fingerprint, effect)))
      .toThrow();
    expect(fs.existsSync(f.intent)).toBe(true);
    fs.writeFileSync(f.inbox, '[]', { mode: 0o600 });
    const restarted = f.makeWriter();
    expect(restarted.withExclusiveLock(() => restarted.findExactReceipt(effectId, fingerprint)))
      .toBe(`hosted-product-peer:message_${effectId}`);
    expect(JSON.parse(fs.readFileSync(f.inbox, 'utf8'))).toHaveLength(1);
    expect(() => restarted.withExclusiveLock(() =>
      restarted.findExactReceipt(effectId, 'c'.repeat(64)))).toThrow('idempotency-conflict');
  });

  it('does not resolve delivery after the recipient attempt rotates', () => {
    const f = fixture();
    const writer = f.makeWriter();
    writer.withExclusiveLock(() => writer.writeOnce(effectId, fingerprint, effect));
    f.commitReceipt();
    f.setRecipient({ ...recipient, attemptId: 'attempt_2',
      containerHandle: 'container_2', containerGeneration: 'generation_2' });
    expect(writer.resolveOwnerDelivery(`message_${effectId}`)).toBeNull();
    // The source is still replayable for an idempotent Product receipt.
    expect(writer.withExclusiveLock(() => writer.findExactReceipt(effectId, fingerprint)))
      .toBe(`hosted-product-peer:message_${effectId}`);
  });

  it('does not append a WAL-only message after recipient attempt rotation', () => {
    const f = fixture();
    fs.writeFileSync(f.inbox, '{broken', { mode: 0o600 });
    const writer = f.makeWriter();
    expect(() => writer.withExclusiveLock(() => writer.writeOnce(effectId, fingerprint, effect)))
      .toThrow();
    fs.writeFileSync(f.inbox, '[]', { mode: 0o600 });
    f.setRecipient({ ...recipient, attemptId: 'attempt_2', sessionId: 'session_2',
      containerHandle: 'container_2', containerGeneration: 'generation_2' });
    expect(() => writer.withExclusiveLock(() => writer.findExactReceipt(effectId, fingerprint)))
      .toThrow('recipient-rotated');
    expect(JSON.parse(fs.readFileSync(f.inbox, 'utf8'))).toEqual([]);
  });

  it('does not append a WAL-only message after sender authority rotation', () => {
    const f = fixture();
    fs.writeFileSync(f.inbox, '{broken', { mode: 0o600 });
    const writer = f.makeWriter();
    expect(() => writer.withExclusiveLock(() => writer.writeOnce(effectId, fingerprint, effect)))
      .toThrow();
    fs.writeFileSync(f.inbox, '[]', { mode: 0o600 });
    f.setSender({ ...effect.member, sessionID: 'session_replaced',
      ownerGeneration: effect.member.ownerGeneration + 1 });
    expect(() => writer.withExclusiveLock(() => writer.findExactReceipt(effectId, fingerprint)))
      .toThrow('sender-rotated');
    expect(JSON.parse(fs.readFileSync(f.inbox, 'utf8'))).toEqual([]);
  });

  it('rejects WAL text tampering even if an attacker recomputes the unkeyed revision', () => {
    const f = fixture();
    const writer = f.makeWriter();
    writer.withExclusiveLock(() => writer.writeOnce(effectId, fingerprint, effect));
    const intent = JSON.parse(fs.readFileSync(f.intent, 'utf8')) as Record<string, unknown>;
    intent.message = { ...(intent.message as Record<string, unknown>), text: 'Forged text' };
    const { schemaVersion: _schemaVersion, effectId: _effectId, fingerprint: _fingerprint,
      receipt: _receipt, revision: _revision, authenticationTag: _authenticationTag,
      ...basis } = intent;
    intent.revision = createHash('sha256')
      .update(JSON.stringify(['hosted-product-peer-intent/v1', basis]))
      .digest('hex');
    fs.writeFileSync(f.intent, JSON.stringify(intent), { mode: 0o600 });
    expect(() => writer.withExclusiveLock(() => writer.findExactReceipt(effectId, fingerprint)))
      .toThrow('authentication-invalid');
  });

  it('rejects a foreign inbox path and never writes outside the Product team', () => {
    const f = fixture();
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-peer-test-'));
    roots.push(foreign);
    fs.symlinkSync(path.join(foreign, 'peer.json'), f.inbox);
    const writer = f.makeWriter();
    expect(() => writer.withExclusiveLock(() => writer.writeOnce(effectId, fingerprint, effect)))
      .toThrow('product-peer-file-unsafe');
    expect(fs.existsSync(path.join(foreign, 'peer.json'))).toBe(false);
    expect(() => writer.withExclusiveLock(() => writer.findExactReceipt(effectId, fingerprint)))
      .toThrow('product-peer-file-unsafe');
  });
});
