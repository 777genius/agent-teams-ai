import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ backupsBase: '', teamsBase: '' }));

vi.mock('@main/utils/pathDecoder', () => ({
  getBackupsBasePath: () => hoisted.backupsBase,
  getTeamsBasePath: () => hoisted.teamsBase,
}));

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { TeamPermanentDeletionCoordinator } from '@main/services/team/permanent-deletion/TeamPermanentDeletionCoordinator';
import { TeamPermanentDeletionIntentStore } from '@main/services/team/permanent-deletion/TeamPermanentDeletionIntentStore';
import { TeamPermanentDeletionLock } from '@main/services/team/permanent-deletion/TeamPermanentDeletionLock';

import type { TeamPermanentDeletionCoordinatorPorts } from '@main/services/team/permanent-deletion/TeamPermanentDeletionCoordinator';
import type { TeamPermanentDeletionIntent } from '@main/services/team/permanent-deletion/TeamPermanentDeletionTypes';

const TRANSACTION_ID = '22222222-2222-4222-8222-222222222222';

function createIntent(
  teamName: string,
  overrides: Partial<TeamPermanentDeletionIntent> = {}
): TeamPermanentDeletionIntent {
  return {
    version: 2,
    teamName,
    identityId: `identity-${teamName}`,
    transactionId: TRANSACTION_ID,
    identityKind: 'team',
    targets: {
      'team-data': { status: 'absent' },
      'task-data': { status: 'absent' },
      'message-attachments': { status: 'absent' },
      'task-attachments': { status: 'absent' },
    },
    targetRemovalProofs: {},
    completedTargets: [],
    cleanupCompleted: true,
    phase: 'deleted',
    requestedAt: '2026-08-20T12:00:00.000Z',
    updatedAt: '2026-08-20T12:00:00.000Z',
    ...overrides,
  } as TeamPermanentDeletionIntent;
}

function intentsDir(): string {
  return path.join(hoisted.backupsBase, 'permanent-deletion-intents');
}

function intentPath(teamName: string): string {
  return path.join(intentsDir(), `${encodeURIComponent(teamName)}.json`);
}

function writeIntentFile(intent: TeamPermanentDeletionIntent): void {
  fs.mkdirSync(intentsDir(), { recursive: true });
  fs.writeFileSync(intentPath(intent.teamName), JSON.stringify(intent, null, 2));
}

function remainingIntentFiles(): string[] {
  return fs.readdirSync(intentsDir()).sort();
}

describe('completed permanent deletion tombstones', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'permanent-deletion-tombstone-'));
    hoisted.backupsBase = path.join(root, 'backups');
    hoisted.teamsBase = path.join(root, 'teams');
    fs.mkdirSync(hoisted.teamsBase, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('removes a finished tombstone and keeps every unfinished intent', async () => {
    const store = new TeamPermanentDeletionIntentStore(new TeamPermanentDeletionLock());
    writeIntentFile(createIntent('finished'));
    writeIntentFile(createIntent('still-preparing', { phase: 'prepared' }));
    writeIntentFile(createIntent('still-deleting', { phase: 'deleting' }));
    await store.loadPermanentDeletionIntents();
    expect([...store.intents.keys()].sort()).toEqual([
      'finished',
      'still-deleting',
      'still-preparing',
    ]);

    await store.cleanupCompletedPermanentDeletionIntents();

    // Only the finished transaction goes. 'prepared' is someone else's job to
    // roll back, and 'deleting' is a transaction that still has to be resumed -
    // dropping either one would strand a half-deleted team.
    expect(remainingIntentFiles()).toEqual(['still-deleting.json', 'still-preparing.json']);
    expect([...store.intents.keys()].sort()).toEqual(['still-deleting', 'still-preparing']);
  });

  it('keeps a deleted-phase intent whose cleanup did not complete', async () => {
    const store = new TeamPermanentDeletionIntentStore(new TeamPermanentDeletionLock());
    // Only the pair (phase 'deleted', cleanup completed) is finished. A
    // 'deleted' phase on its own still owns targets that were never removed.
    const unfinished = createIntent('unfinished', {
      phase: 'deleting',
      cleanupCompleted: false,
      targets: {
        'team-data': { status: 'present', identity: { dev: 1, ino: 1, birthtimeMs: 1 } },
        'task-data': { status: 'absent' },
        'message-attachments': { status: 'absent' },
        'task-attachments': { status: 'absent' },
      },
    });
    writeIntentFile(unfinished);
    await store.loadPermanentDeletionIntents();
    store.intents.set('unfinished', { ...unfinished, phase: 'deleted' });

    await store.cleanupCompletedPermanentDeletionIntents();

    expect(remainingIntentFiles()).toEqual(['unfinished.json']);
  });

  it('warns and keeps going when one tombstone cannot be removed', async () => {
    const store = new TeamPermanentDeletionIntentStore(new TeamPermanentDeletionLock());
    writeIntentFile(createIntent('broken'));
    writeIntentFile(createIntent('fine'));
    await store.loadPermanentDeletionIntents();
    const remove = vi
      .spyOn(store, 'removePermanentDeletionIntent')
      .mockImplementation(async (intent) => {
        if (intent.teamName === 'broken') throw new Error('EBUSY: intent file is locked');
        fs.rmSync(intentPath(intent.teamName));
      });

    await expect(store.cleanupCompletedPermanentDeletionIntents()).resolves.toBeUndefined();

    expect(remove).toHaveBeenCalledTimes(2);
    expect(remainingIntentFiles()).toEqual(['broken.json']);
  });

  it('runs on coordinator initialization so a same-named team can be deleted again', async () => {
    writeIntentFile(createIntent('reused-name'));
    const ports = {
      awaitInitialization: async () => undefined,
      isInitialized: () => true,
      isShuttingDown: () => false,
      withTeamMutex: async <T>(_teamName: string, operation: () => Promise<T>) => operation(),
      registry: () => ({}),
      loadManifest: async () => null,
      saveManifest: async () => undefined,
      saveRegistryEntry: async () => undefined,
    } as unknown as TeamPermanentDeletionCoordinatorPorts;

    await new TeamPermanentDeletionCoordinator(ports).initialize();

    // The stale tombstone answered for the team name, so recreating the team
    // and deleting it short-circuited against a fence built for the old
    // identity and the new team could not be deleted at all.
    expect(remainingIntentFiles()).toEqual([]);
  });
});
