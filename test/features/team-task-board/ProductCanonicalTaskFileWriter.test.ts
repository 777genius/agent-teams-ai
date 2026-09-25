import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ProductCanonicalTaskFileWriter } from '@features/team-task-board/main/infrastructure/ProductCanonicalTaskFileWriter';
import { withFileLockSync } from '@main/services/team/fileLock';
import { TeamTaskReader } from '@main/services/team/TeamTaskReader';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { afterEach, describe, expect, it } from 'vitest';

import type { ProductCanonicalEffect } from '@features/team-task-board/main/infrastructure/HostedProductTaskEffectBoundary';

const roots: string[] = [];
afterEach(() => {
  setClaudeBasePathOverride(null);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-effect-writer-test-'));
  roots.push(root);
  const claudeBase = path.join(root, 'claude');
  const teamId = 'team_test';
  const tasksDirectory = path.join(claudeBase, 'tasks', teamId);
  fs.mkdirSync(tasksDirectory, { recursive: true });
  const rawTaskId = '1';
  const taskId = `task_${createHash('sha256')
    .update(JSON.stringify({ domain: 'hosted-task-board-task/v1', teamId, rawTaskId }))
    .digest('hex')
    .slice(0, 32)}`;
  const taskPath = path.join(tasksDirectory, '1.json');
  fs.writeFileSync(
    taskPath,
    JSON.stringify({
      id: rawTaskId,
      subject: 'Test',
      status: 'pending',
      owner: 'sender',
      comments: [],
    })
  );
  const effectBase = {
    member: {
      teamId,
      memberId: 'member_sender',
      memberName: 'sender',
      workspaceId: 'workspace_test',
      workspaceRoot: '/never/read/owner/path',
      planGeneration: 'plan_test',
      runId: 'run_test',
      laneId: 'lane_test',
      sessionID: 'session_test',
      actorId: 'member_sender',
      deploymentId: 'deployment_test',
      bootId: 'boot_test',
      restoreGeneration: 1,
      mountGeneration: 1,
      declaredRootHash: 'a'.repeat(64),
      ownerAuthority: 'owner_test',
      ownerGeneration: 1,
      ownerSessionId: 'owner_session_test',
    },
    task: {
      teamId,
      taskId,
      sourceGeneration: 'generation_test',
      revision: 'revision_test',
      ownerId: 'member_sender',
      status: 'pending' as const,
    },
  };
  const makeWriter = () =>
    new ProductCanonicalTaskFileWriter({
      teamId,
      tasksDirectory,
      rawTaskIdForCanonicalTaskId: (id) => (id === taskId ? rawTaskId : null),
      withProductWriterLock: (run) => withFileLockSync(path.join(root, 'product-writer'), run),
    });
  const readTask = () => JSON.parse(fs.readFileSync(taskPath, 'utf8')) as Record<string, unknown>;
  return { root, claudeBase, tasksDirectory, taskPath, taskId, effectBase, makeWriter, readTask };
}

const id = '1'.repeat(64);
const fingerprint = '2'.repeat(64);

describe('ProductCanonicalTaskFileWriter', () => {
  it('persists a status and its exact receipt in one canonical task file, then recovers after restart', () => {
    const f = fixture();
    const effect: ProductCanonicalEffect = {
      ...f.effectBase,
      kind: 'status',
      status: 'in_progress',
    };
    const first = f.makeWriter();
    const receipt = first.withExclusiveLock(() => first.writeOnce(id, fingerprint, effect));
    const written = f.readTask();
    expect(written.status).toBe('in_progress');
    expect((written.historyEvents as Array<{ id: string }>).map((event) => event.id)).toEqual([id]);
    expect((written._hostedProductEffects as Record<string, unknown>)[id]).toEqual({
      fingerprint,
      receipt,
      kind: 'status',
    });

    // Simulates the crash window after file fsync but before SQLite receipt commit.
    const restarted = f.makeWriter();
    expect(restarted.withExclusiveLock(() => restarted.findExactReceipt(id, fingerprint))).toBe(
      receipt
    );
    expect(restarted.withExclusiveLock(() => restarted.writeOnce(id, fingerprint, effect))).toBe(
      receipt
    );
    expect(f.readTask()).toEqual(written);
    expect(() =>
      restarted.withExclusiveLock(() => restarted.findExactReceipt(id, '3'.repeat(64)))
    ).toThrow('product-canonical-idempotency-conflict');
  });

  it('persists one real task comment and recovers it without duplicating content', () => {
    const f = fixture();
    const effect: ProductCanonicalEffect = {
      ...f.effectBase,
      kind: 'comment',
      text: 'Finished the handoff.',
    };
    const first = f.makeWriter();
    const receipt = first.withExclusiveLock(() => first.writeOnce(id, fingerprint, effect));
    const restarted = f.makeWriter();
    expect(restarted.withExclusiveLock(() => restarted.writeOnce(id, fingerprint, effect))).toBe(
      receipt
    );
    expect(f.readTask().comments).toEqual([
      {
        id,
        author: 'sender',
        text: 'Finished the handoff.',
        createdAt: expect.any(String),
        type: 'regular',
      },
    ]);
  });

  it('ignores unrelated deleted tasks and recovers a receipt after its task is soft-deleted', () => {
    const f = fixture();
    fs.writeFileSync(
      path.join(f.tasksDirectory, '2.json'),
      JSON.stringify({ id: '2', subject: 'Deleted', status: 'deleted', owner: 'sender' })
    );
    const effect: ProductCanonicalEffect = {
      ...f.effectBase,
      kind: 'comment',
      text: 'Final result.',
    };
    const writer = f.makeWriter();
    const receipt = writer.withExclusiveLock(() => writer.writeOnce(id, fingerprint, effect));
    const softDeleted = { ...f.readTask(), status: 'deleted' };
    fs.writeFileSync(f.taskPath, JSON.stringify(softDeleted));

    const restarted = f.makeWriter();
    expect(restarted.withExclusiveLock(() => restarted.findExactReceipt(id, fingerprint))).toBe(
      receipt
    );
    expect(restarted.withExclusiveLock(() => restarted.writeOnce(id, fingerprint, effect))).toBe(
      receipt
    );
    expect(() =>
      restarted.withExclusiveLock(() => restarted.writeOnce('4'.repeat(64), '5'.repeat(64), effect))
    ).toThrow('product-canonical-task-changed');
    expect(f.readTask()).toEqual(softDeleted);
  });

  it('bounds receipt recovery by directory entries and aggregate task bytes', () => {
    const f = fixture();
    const writer = f.makeWriter();
    for (let number = 2; number <= 35; number += 1) {
      fs.writeFileSync(
        path.join(f.tasksDirectory, `${number}.json`),
        JSON.stringify({
          id: String(number),
          subject: 'Filler',
          status: 'deleted',
          padding: 'x'.repeat(250 * 1024),
        })
      );
    }
    expect(() => writer.withExclusiveLock(() => writer.findExactReceipt(id, fingerprint))).toThrow(
      'product-canonical-task-snapshot-too-large'
    );

    for (const name of fs.readdirSync(f.tasksDirectory)) {
      if (name !== '1.json') fs.unlinkSync(path.join(f.tasksDirectory, name));
    }
    for (let number = 0; number < 512; number += 1) {
      fs.writeFileSync(path.join(f.tasksDirectory, `.noise-${number}`), '');
    }
    expect(() => writer.withExclusiveLock(() => writer.findExactReceipt(id, fingerprint))).toThrow(
      'product-canonical-task-directory-too-large'
    );
  });

  it('round-trips the receipt-bearing task through the existing canonical task reader', async () => {
    const f = fixture();
    const writer = f.makeWriter();
    const effect: ProductCanonicalEffect = {
      ...f.effectBase,
      kind: 'comment',
      text: 'Persisted by Product.',
    };
    writer.withExclusiveLock(() => writer.writeOnce(id, fingerprint, effect));
    setClaudeBasePathOverride(f.claudeBase);
    const tasks = await new TeamTaskReader().getTasks('team_test');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].comments?.map((comment) => comment.text)).toEqual(['Persisted by Product.']);
    expect(tasks[0].status).toBe('pending');
  });

  it('requires the Product lock, rejects a symlink task and fails closed on peer messages', () => {
    const f = fixture();
    const writer = f.makeWriter();
    const effect: ProductCanonicalEffect = {
      ...f.effectBase,
      kind: 'status',
      status: 'in_progress',
    };
    expect(() => writer.writeOnce(id, fingerprint, effect)).toThrow(
      'product-canonical-writer-lock-required'
    );
    const peer: ProductCanonicalEffect = {
      kind: 'message',
      member: effect.member,
      recipient: {
        teamId: 'team_test',
        runId: 'run_test',
        laneId: 'lane_peer',
        memberId: 'member_peer',
        memberName: 'peer',
      },
      taskRefs: [],
      text: 'Please review.',
    };
    expect(() => writer.withExclusiveLock(() => writer.writeOnce(id, fingerprint, peer))).toThrow(
      'product-canonical-message-wake-unavailable'
    );
    expect(f.readTask().status).toBe('pending');

    fs.renameSync(f.taskPath, `${f.taskPath}.real`);
    fs.symlinkSync(`${f.taskPath}.real`, f.taskPath);
    expect(() => writer.withExclusiveLock(() => writer.writeOnce(id, fingerprint, effect))).toThrow(
      'product-canonical-task-file-unsafe'
    );
  });
});
