// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createReviewPersistenceLocks,
  ReviewDecisionStore,
  ReviewDraftHistoryStore,
  ReviewMutationJournalStore,
} from '@agent-teams/task-change-ledger/review-storage';
import { describe, expect, it } from 'vitest';

describe('portable captured review storage', () => {
  it('isolates equal team/scope identities under two explicit captured roots', async () => {
    const roots = await Promise.all([
      mkdtemp(join(tmpdir(), 'TEST-review-A-')),
      mkdtemp(join(tmpdir(), 'TEST-review-B-')),
    ]);
    try {
      const [a, b] = roots.map((root) => new ReviewDecisionStore(root));
      await a!.save('demo', 'task-one', {
        scopeToken: 'exact',
        hunkDecisions: { 'file:0': 'accepted' },
        fileDecisions: {},
      });
      expect(await b!.load('demo', 'task-one', 'exact')).toBeNull();
      await b!.save('demo', 'task-one', {
        scopeToken: 'exact',
        hunkDecisions: { 'file:0': 'rejected' },
        fileDecisions: {},
      });
      expect((await a!.load('demo', 'task-one', 'exact'))?.hunkDecisions).toEqual({
        'file:0': 'accepted',
      });
      expect((await b!.load('demo', 'task-one', 'exact'))?.hunkDecisions).toEqual({
        'file:0': 'rejected',
      });
    } finally {
      await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  });
  it('rejects missing/relative roots before any storage allocation', () => {
    for (const root of ['', 'relative', 'x\0y'])
      for (const Store of [
        ReviewDecisionStore,
        ReviewDraftHistoryStore,
        ReviewMutationJournalStore,
      ])
        expect(() => new Store(root)).toThrow('absolute');
    expect(() => createReviewPersistenceLocks('relative', async () => null)).toThrow('absolute');
  });
  it('shares live ownership across manager instances while preserving independent root resources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'TEST-review-lock-'));
    const a = createReviewPersistenceLocks(root, async () => null),
      b = createReviewPersistenceLocks(root, async () => null);
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const admitted = new Promise<void>((r) => {
      entered = r;
    });
    const order: string[] = [];
    try {
      const first = a.withReviewPersistenceScopeLock(
        'demo',
        { scopeKey: 'task-one', scopeToken: 'exact' },
        async () => {
          order.push('A');
          entered();
          await held;
          order.push('A done');
        }
      );
      await admitted;
      const second = b.withReviewPersistenceScopeLock(
        'demo',
        { scopeKey: 'task-one', scopeToken: 'exact' },
        async () => {
          order.push('B');
        },
        { retryIntervalMs: 5 }
      );
      await new Promise((r) => setTimeout(r, 25));
      expect(order).toEqual(['A']);
      release();
      await Promise.all([first, second]);
      expect(order).toEqual(['A', 'A done', 'B']);
    } finally {
      release();
      a.closeReviewPersistenceScopeLockDatabasesForTests();
      await rm(root, { recursive: true, force: true });
    }
  });
});
