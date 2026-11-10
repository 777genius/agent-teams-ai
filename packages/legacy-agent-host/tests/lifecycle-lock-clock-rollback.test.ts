import assert from 'node:assert/strict';
import { mkdtemp, lstat, rm, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TeamPermanentDeletionLock } from '../dist/adapters/lifecycle/TeamPermanentDeletionLock.js';
import type { PermanentDeletionLock } from '../dist/adapters/lifecycle/TeamPermanentDeletionLock.js';

test('a lifecycle heartbeat after wall-clock rollback releases its exact original filesystem lock', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'TEST-lifecycle-lock-clock-'));
  const owner = new TeamPermanentDeletionLock({ backups: join(root, 'backups') });
  const acquire = owner.acquirePermanentDeletionLock.bind(owner);
  let captured: PermanentDeletionLock | undefined;
  owner.acquirePermanentDeletionLock = async (scope) => {
    captured = await acquire(scope);
    return captured;
  };
  let effects = 0;
  try {
    // Real filesystem time keeps moving while the application clock moves backward.
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() - 10_000 });
    await owner.withLock('TEST-clock-rollback', async () => { effects++; });
    assert.equal(effects, 1);
    assert.ok(captured);
    await assert.rejects(lstat(captured.lockPath), { code: 'ENOENT' },
      'our heartbeat must not strand the original lock by changing its birthtime');
  } finally {
    t.mock.timers.reset();
    // On the RED baseline remove only this test's exact token entry; never a successor.
    if (captured) {
      await unlink(join(captured.lockPath, captured.ownerEntryName)).catch(() => {});
      await rmdir(captured.lockPath).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  }
});
