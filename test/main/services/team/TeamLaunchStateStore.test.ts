import { createPersistedLaunchSnapshot } from '@main/services/team/TeamLaunchStateEvaluator';
import {
  getTeamLaunchStatePath,
  getTeamLaunchSummaryPath,
  TeamLaunchStateStore,
} from '@main/services/team/TeamLaunchStateStore';
import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PersistedTeamLaunchSnapshot } from '@shared/types';

const mocks = vi.hoisted(() => ({
  atomicWriteAsync: vi.fn(),
  teamsBasePath: `${process.cwd()}/.team-launch-state-store-tests`,
}));

vi.mock('@main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => mocks.teamsBasePath,
}));

vi.mock('@main/services/team/atomicWrite', () => ({
  atomicWriteAsync: mocks.atomicWriteAsync,
}));

function snapshot(): PersistedTeamLaunchSnapshot {
  return createPersistedLaunchSnapshot({
    teamName: 'demo',
    expectedMembers: ['Builder'],
    launchPhase: 'active',
    members: {
      Builder: {
        name: 'Builder',
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        lastEvaluatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

describe('TeamLaunchStateStore', () => {
  beforeEach(() => {
    mocks.atomicWriteAsync.mockReset();
  });

  it('rejects when a live team directory cannot persist the complete launch publication', async () => {
    const writeError = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    mocks.atomicWriteAsync.mockResolvedValueOnce(undefined).mockRejectedValueOnce(writeError);

    await expect(new TeamLaunchStateStore().write('demo', snapshot())).rejects.toBe(writeError);

    expect(vi.mocked(console.warn).mock.calls[0]?.join(' ')).toContain(
      '[demo] Failed to persist launch-state: disk full'
    );
    vi.mocked(console.warn).mockClear();
    expect(mocks.atomicWriteAsync).toHaveBeenNthCalledWith(
      1,
      getTeamLaunchStatePath('demo'),
      expect.any(String)
    );
    expect(mocks.atomicWriteAsync).toHaveBeenNthCalledWith(
      2,
      getTeamLaunchSummaryPath('demo'),
      expect.any(String)
    );
  });

  it('resolves only after both files from the snapshot generation are persisted', async () => {
    let finishSummaryWrite!: () => void;
    const summaryWrite = new Promise<void>((resolve) => {
      finishSummaryWrite = resolve;
    });
    mocks.atomicWriteAsync.mockResolvedValueOnce(undefined).mockReturnValueOnce(summaryWrite);
    let settled = false;

    const writing = new TeamLaunchStateStore().write('demo', snapshot()).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    const statePayload = JSON.parse(mocks.atomicWriteAsync.mock.calls[0][1] as string);
    const summaryPayload = JSON.parse(mocks.atomicWriteAsync.mock.calls[1][1] as string);
    expect(statePayload.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(summaryPayload.updatedAt).toBe(statePayload.updatedAt);

    finishSummaryWrite();
    await writing;
    expect(settled).toBe(true);
  });

  it('keeps the deleted-team directory race as a compatible no-op', async () => {
    const launchStatePath = getTeamLaunchStatePath('removed-team');
    const missingDirectoryError = Object.assign(new Error('directory removed'), {
      code: 'ENOENT',
      path: path.join(path.dirname(launchStatePath), '.tmp.removed'),
      dest: launchStatePath,
    });
    mocks.atomicWriteAsync.mockRejectedValueOnce(missingDirectoryError);

    await expect(
      new TeamLaunchStateStore().write('removed-team', snapshot())
    ).resolves.toBeUndefined();
    expect(mocks.atomicWriteAsync).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing temporary file when the team directory still exists', async () => {
    const launchStatePath = getTeamLaunchStatePath('demo');
    const missingTemporaryFileError = Object.assign(new Error('temporary file disappeared'), {
      code: 'ENOENT',
      path: path.join(path.dirname(launchStatePath), '.tmp.missing'),
      dest: launchStatePath,
    });
    const access = vi.spyOn(fs.promises, 'access').mockResolvedValueOnce(undefined);
    mocks.atomicWriteAsync.mockRejectedValueOnce(missingTemporaryFileError);

    try {
      await expect(new TeamLaunchStateStore().write('demo', snapshot())).rejects.toBe(
        missingTemporaryFileError
      );

      expect(access).toHaveBeenCalledWith(path.dirname(launchStatePath));
      expect(vi.mocked(console.warn).mock.calls[0]?.join(' ')).toContain(
        '[demo] Failed to persist launch-state: temporary file disappeared'
      );
      vi.mocked(console.warn).mockClear();
    } finally {
      access.mockRestore();
    }
  });

  it('rejects when the team directory probe cannot confirm revocation', async () => {
    const launchStatePath = getTeamLaunchStatePath('demo');
    const missingTemporaryFileError = Object.assign(new Error('temporary file disappeared'), {
      code: 'ENOENT',
      path: path.join(path.dirname(launchStatePath), '.tmp.missing'),
    });
    const probeError = Object.assign(new Error('directory probe failed'), { code: 'EACCES' });
    const access = vi.spyOn(fs.promises, 'access').mockRejectedValueOnce(probeError);
    mocks.atomicWriteAsync.mockRejectedValueOnce(missingTemporaryFileError);

    try {
      await expect(new TeamLaunchStateStore().write('demo', snapshot())).rejects.toBe(
        missingTemporaryFileError
      );
      expect(access).toHaveBeenCalledWith(path.dirname(launchStatePath));
      vi.mocked(console.warn).mockClear();
    } finally {
      access.mockRestore();
    }
  });

  it('attempts to clear both publication files when the first removal fails', async () => {
    const stateRemovalError = Object.assign(new Error('state file is busy'), { code: 'EBUSY' });
    const remove = vi
      .spyOn(fs.promises, 'rm')
      .mockRejectedValueOnce(stateRemovalError)
      .mockResolvedValueOnce(undefined);

    try {
      await expect(new TeamLaunchStateStore().clear('demo')).resolves.toBeUndefined();

      expect(remove).toHaveBeenNthCalledWith(1, getTeamLaunchStatePath('demo'), { force: true });
      expect(remove).toHaveBeenNthCalledWith(2, getTeamLaunchSummaryPath('demo'), { force: true });
    } finally {
      remove.mockRestore();
    }
  });
});
