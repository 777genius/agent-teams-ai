import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertRuntimeEvidenceRunMatches,
  createRuntimeRunTombstoneStore,
  RuntimeStaleEvidenceError,
} from '../../../../src/main/services/team/opencode/store/RuntimeRunTombstoneStore';

let tempDir: string;
let now: Date;
let nextId: number;

describe('RuntimeRunTombstoneStore', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-tombstones-'));
    now = new Date('2026-04-21T12:00:00.000Z');
    nextId = 1;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('adds tombstone atomically and rejects matching stale evidence', async () => {
    const store = createStore();

    await expect(
      store.add({
        teamName: 'team-a',
        runId: 'run-1',
        reason: 'stop_requested',
        evidenceKinds: ['sse_event', 'permission_reply'],
        diagnostic: 'manual stop',
      })
    ).resolves.toMatchObject({
      tombstoneId: 'tombstone-1',
      teamName: 'team-a',
      runId: 'run-1',
      reason: 'stop_requested',
      evidenceKinds: ['permission_reply', 'sse_event'],
      diagnostic: 'manual stop',
    });

    await expect(
      store.assertEvidenceAccepted({
        teamName: 'team-a',
        runId: 'run-1',
        currentRunId: 'run-1',
        evidenceKind: 'sse_event',
      })
    ).rejects.toMatchObject({
      reason: 'run_tombstoned',
      evidenceKind: 'sse_event',
      runId: 'run-1',
    });

    await expect(
      store.assertEvidenceAccepted({
        teamName: 'team-a',
        runId: 'run-1',
        currentRunId: 'run-1',
        evidenceKind: 'delivery_call',
      })
    ).resolves.toBeUndefined();
  });

  it('rejects stale run mismatch before tombstone lookup', async () => {
    const store = createStore();

    await expect(
      store.assertEvidenceAccepted({
        teamName: 'team-a',
        runId: 'old-run',
        currentRunId: 'new-run',
        evidenceKind: 'delivery_call',
      })
    ).rejects.toMatchObject({
      reason: 'run_mismatch',
      evidenceKind: 'delivery_call',
      runId: 'old-run',
    });
  });

  it('deduplicates same tombstone and compacts expired records', async () => {
    const store = createStore();

    await store.add({
      teamName: 'team-a',
      runId: 'run-1',
      reason: 'relaunch_started',
      ttlMs: 1000,
    });
    await store.add({
      teamName: 'team-a',
      runId: 'run-1',
      reason: 'relaunch_started',
      ttlMs: 1000,
    });
    await expect(store.list('team-a')).resolves.toHaveLength(1);

    now = new Date('2026-04-21T12:00:02.000Z');
    await expect(store.compact()).resolves.toBe(1);
    await expect(store.list('team-a')).resolves.toEqual([]);
  });

  it('quarantines invalid tombstone store instead of accepting evidence from corrupt data', async () => {
    const filePath = path.join(tempDir, 'tombstones.json');
    await fs.writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: '2026-04-21T12:00:00.000Z',
        data: [{ tombstoneId: '', teamName: 'team-a' }],
      }),
      'utf8'
    );
    const store = createStore(filePath);

    await expect(store.list('team-a')).rejects.toMatchObject({
      reason: 'invalid_data',
    });
    const files = await fs.readdir(tempDir);
    expect(files.some((file) => file.includes('invalid_data'))).toBe(true);
  });
});

describe('assertRuntimeEvidenceRunMatches', () => {
  it('rejects missing evidence run and missing current run explicitly', () => {
    expect(() =>
      assertRuntimeEvidenceRunMatches({
        teamName: 'team-a',
        runId: null,
        currentRunId: 'run-1',
        evidenceKind: 'heartbeat',
      })
    ).toThrow(RuntimeStaleEvidenceError);

    expect(() =>
      assertRuntimeEvidenceRunMatches({
        teamName: 'team-a',
        runId: 'run-1',
        currentRunId: null,
        evidenceKind: 'heartbeat',
      })
    ).toThrow('Rejected runtime evidence without current run: heartbeat');
  });
});

function createStore(filePath = path.join(tempDir, 'tombstones.json')) {
  return createRuntimeRunTombstoneStore({
    filePath,
    idFactory: () => `tombstone-${nextId++}`,
    clock: () => now,
  });
}
