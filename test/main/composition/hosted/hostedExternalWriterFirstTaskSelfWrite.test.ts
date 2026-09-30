import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type HostedExternalWriterInventorySnapshot,
  HostedExternalWriterInventorySupervisor,
} from '@main/composition/hosted/hostedExternalWriterInventorySupervisor';
import { parseTeamId } from '@shared/contracts/hosted/identifiers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FileObservationStateCheckpoint } from '@features/external-writer-coordination';

const teamId = parseTeamId(`team_${'4'.repeat(32)}`);

/** Durable state as the internal storage keeps it: one checkpoint plus a one-shot handoff marker. */
function memoryStateStore() {
  let checkpoint: FileObservationStateCheckpoint | null = null;
  let eligible = false;
  return {
    load: vi.fn(() => Promise.resolve(checkpoint)),
    save: vi.fn((next: FileObservationStateCheckpoint) => {
      checkpoint = next;
      return Promise.resolve();
    }),
    saveCleanHandoffEligibility: vi.fn((next: FileObservationStateCheckpoint) => {
      checkpoint = next;
      eligible = true;
      return Promise.resolve();
    }),
    consumeCleanHandoffEligibility: vi.fn(() => {
      const consumed = eligible ? checkpoint : null;
      eligible = false;
      return Promise.resolve(consumed);
    }),
    listHotTeamIds: vi.fn(() => Promise.resolve([])),
  };
}

describe('first task file of a team written under an open self-write', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function harness(selfWriteRebuildHoldMs?: number) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hosted-first-task-')));
    roots.push(root);
    const tasks = join(root, 'tasks', 'first-team');
    await mkdir(tasks, { recursive: true });
    const content = `${JSON.stringify({ id: 'hosted-first', subject: 'First task' })}\n`;
    const fileKey = 'hosted-first';
    let files: string[] = [];
    let now = 1_000;
    const inventory = {
      capture: vi.fn(
        (): Promise<HostedExternalWriterInventorySnapshot> =>
          Promise.resolve({
            catalogToken: files.join(','),
            definitions: files.map((name) => ({
              rootPath: root,
              filePath: join(tasks, `${name}.json`),
              registration: {
                scope: { teamId, featureKey: 'tasks' },
                fileKey: name,
                maxBytes: 64 * 1024,
                attributionPolicy: 'external_file_only' as const,
              },
            })),
            retiredTeams: [],
          })
      ),
    };
    const reconcile = vi.fn().mockResolvedValue({
      outcome: 'accepted_change',
      sourceGeneration: 1,
      featureRevision: 1,
    });
    const supervisor = new HostedExternalWriterInventorySupervisor({
      inventory,
      reconciliation: { getResult: vi.fn().mockResolvedValue(null), reconcile },
      stateStore: memoryStateStore(),
      clock: { nowMs: () => now, sleep: () => Promise.resolve() },
      watchOptions: { persistent: false },
      observerOptions: { retryDelayMs: 0, atomicReplaceDebounceMs: 0 },
      convergenceIntervalMs: 60_000,
      ...(selfWriteRebuildHoldMs === undefined ? {} : { selfWriteRebuildHoldMs }),
    });
    await supervisor.start();
    return {
      supervisor,
      reconcile,
      advance: (ms: number) => {
        now += ms;
      },
      /** The Owner writes the team's first task file under the open operation. */
      writeFirstTask: async () => {
        await writeFile(join(tasks, `${fileKey}.json`), content);
        files = [fileKey];
      },
      effects: [{ fileKey, expectedChecksum: createHash('sha256').update(content).digest('hex') }],
    };
  }

  it('is attributed to the self-write instead of losing the operation to a catalog rebuild', async () => {
    const { supervisor, reconcile, writeFirstTask, effects } = await harness();
    try {
      await supervisor.beginTaskSelfWrite('op-first-task', teamId);
      await writeFirstTask();
      // Periodic convergence runs between the Owner write and completion (live35).
      await supervisor.convergeNow();
      expect(supervisor.getSnapshot()).toMatchObject({
        registeredFileCount: 0,
        diagnosticCode: 'catalog_rebuild_self_write_open',
      });

      await expect(
        supervisor.completeTaskSelfWrite('op-first-task', effects)
      ).resolves.toBeUndefined();
      expect(supervisor.getSnapshot()).toMatchObject({ phase: 'running', registeredFileCount: 1 });
      expect(reconcile).not.toHaveBeenCalled();
    } finally {
      await supervisor.shutdown();
    }
  });

  it('rebuilds after the hold when an open operation never settles', async () => {
    const { supervisor, reconcile, advance, writeFirstTask } = await harness(10_000);
    try {
      await supervisor.beginTaskSelfWrite('op-stuck', teamId);
      await writeFirstTask();
      advance(10_000);
      await supervisor.convergeNow();

      // The file is observed as an external write; the board is invalidated, nothing is lost.
      expect(supervisor.getSnapshot()).toMatchObject({ phase: 'running', registeredFileCount: 1 });
      expect(reconcile).toHaveBeenCalledOnce();
      await expect(supervisor.abortTaskSelfWrite('op-stuck')).resolves.toBeUndefined();
    } finally {
      await supervisor.shutdown();
    }
  });
});
