import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ExternalWriterObserver } from '@features/external-writer-coordination';
import { createExternalWriterFileAdapters } from '@features/external-writer-coordination/main/composition/createExternalWriterFileAdapters';
import { HostedExternalWriterStageTracker } from '@main/composition/hosted/hostedExternalWriterStageTracker';
import { parseTeamId } from '@shared/contracts/hosted/identifiers';
import { describe, expect, it, vi } from 'vitest';

describe('HostedExternalWriterStageTracker', () => {
  it('names the stuck operation, its stage and the port calls it waits on, with codes only', async () => {
    let now = 0;
    const report = vi.fn();
    const tracker = new HostedExternalWriterStageTracker(report, () => now);
    let settleSave!: () => void;
    const stateStore = tracker.trackPort('state-store', {
      save: (checkpoint: { path: string }) =>
        new Promise<void>((resolve) => {
          expect(checkpoint.path).toContain('secret');
          settleSave = resolve;
        }),
      snapshotSync: () => 'not-a-promise',
    });
    expect(stateStore.snapshotSync()).toBe('not-a-promise');

    const operation = tracker.run('self-write-abort', async () => {
      tracker.mark('observer-abort');
      await stateStore.save({ path: '/private/secret/team' });
    });
    now = 4_000;
    tracker.check();
    expect(report).not.toHaveBeenCalled();
    now = 6_000;
    tracker.check();
    tracker.check();
    expect(report.mock.calls).toEqual([
      [
        'Hosted external writer: stuck op=self-write-abort stage=observer-abort ms=6000 waiting=state-store.save',
      ],
    ]);

    now = 9_000;
    settleSave();
    await operation;
    expect(report).toHaveBeenLastCalledWith(
      'Hosted external writer: recovered op=self-write-abort ms=9000'
    );
  });

  it('reports each failure cause once from allowlisted structured codes, never messages', async () => {
    const report = vi.fn();
    const tracker = new HostedExternalWriterStageTracker(report, () => 0);
    const fail = (error: Error) =>
      tracker.run('periodic-converge', () => {
        tracker.mark('inventory-capture');
        return Promise.reject(error);
      });

    const codedError = Object.assign(new Error('/private/secret/team'), {
      code: 'catalog_invalid',
    });
    await expect(fail(codedError)).rejects.toBe(codedError);
    await expect(fail(codedError)).rejects.toBe(codedError);
    await expect(
      fail(new Error('EACCES: permission denied, open /srv/teams/x.json'))
    ).rejects.toThrow();

    expect(report.mock.calls).toEqual([
      [
        'Hosted external writer: failed op=periodic-converge stage=inventory-capture code=catalog_invalid',
      ],
      ['Hosted external writer: failed op=periodic-converge stage=inventory-capture code=unknown'],
    ]);
  });

  it('reports tracked port failures once without changing sync throws or async rejections', async () => {
    const report = vi.fn();
    const tracker = new HostedExternalWriterStageTracker(report);
    const syncError = Object.assign(new Error('/private/secret/team'), { code: 'EACCES' });
    const asyncError = Object.assign(new Error('/private/secret/task'), {
      code: 'private_task_id',
    });
    const port = tracker.trackPort('source', Object.freeze({
      read: () => {
        throw syncError;
      },
      ok: () => Promise.resolve(42),
      stat: () => Promise.reject(asyncError),
    }));

    const caughtSyncError = () => {
      try {
        port.read();
      } catch (error) {
        return error;
      }
      return null;
    };
    expect(caughtSyncError()).toBe(syncError);
    expect(caughtSyncError()).toBe(syncError);
    await expect(port.ok()).resolves.toBe(42);
    await expect(port.stat()).rejects.toBe(asyncError);
    await expect(port.stat()).rejects.toBe(asyncError);

    expect(report.mock.calls).toEqual([
      ['Hosted external writer: rejected call=source.read reason=EACCES'],
      ['Hosted external writer: rejected call=source.stat reason=unknown'],
    ]);
  });

  it('keeps real observer file ports working behind the tracking proxy', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'external-writer-tracker-')));
    try {
      const filePath = join(root, 'task.json');
      await writeFile(filePath, '{}');
      const adapters = createExternalWriterFileAdapters({
        files: [
          {
            rootPath: root,
            filePath,
            registration: {
              scope: { teamId: parseTeamId(`team_${'1'.repeat(32)}`), featureKey: 'tasks' },
              fileKey: 'task-1',
              maxBytes: 1_024,
              attributionPolicy: 'external_file_only',
            },
          },
        ],
        watchOptions: { persistent: false },
      });
      const tracker = new HostedExternalWriterStageTracker(vi.fn());
      const reconcile = vi.fn().mockResolvedValue({
        outcome: 'accepted_change',
        sourceGeneration: 1,
        featureRevision: 1,
      });
      const observer = new ExternalWriterObserver({
        catalog: tracker.trackPort('catalog', adapters.catalog),
        watch: tracker.trackPort('watch', adapters.watch),
        source: tracker.trackPort('source', adapters.source),
        checksums: tracker.trackPort('checksums', adapters.checksums),
        reconciliation: { getResult: vi.fn().mockResolvedValue(null), reconcile },
        stateStore: {
          load: vi.fn().mockResolvedValue(null),
          consumeCleanHandoffEligibility: vi.fn().mockResolvedValue(null),
          listHotTeamIds: vi.fn().mockResolvedValue([]),
          save: vi.fn().mockResolvedValue(undefined),
          saveCleanHandoffEligibility: vi.fn().mockResolvedValue(undefined),
        },
        clock: { nowMs: () => Date.now(), sleep: () => Promise.resolve() },
      });

      await expect(observer.start()).resolves.toMatchObject({ readiness: 'clean' });
      expect(reconcile).toHaveBeenCalledOnce();
      await expect(observer.shutdown(Date.now() + 1_000)).resolves.toMatchObject({
        status: 'clean',
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
