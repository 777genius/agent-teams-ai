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

function snapshot(updatedAt = '2026-01-01T00:00:00.000Z'): PersistedTeamLaunchSnapshot {
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
    updatedAt,
  });
}

describe('TeamLaunchStateStore', () => {
  beforeEach(() => {
    mocks.atomicWriteAsync.mockReset();
  });

  it('rejects a versioned snapshot whose persisted team identity does not match its path', async () => {
    const raw = JSON.stringify({ ...snapshot(), teamName: 'other-team' });
    const stat = vi.spyOn(fs.promises, 'stat').mockResolvedValue({
      isFile: () => true,
      size: Buffer.byteLength(raw),
    } as fs.Stats);
    const readFile = vi.spyOn(fs.promises, 'readFile').mockResolvedValue(raw);

    try {
      await expect(new TeamLaunchStateStore().read('demo')).resolves.toBeNull();
    } finally {
      stat.mockRestore();
      readFile.mockRestore();
    }
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
    await vi.waitFor(() => expect(mocks.atomicWriteAsync).toHaveBeenCalledTimes(2));

    expect(settled).toBe(false);
    const statePayload = JSON.parse(mocks.atomicWriteAsync.mock.calls[0][1] as string);
    const summaryPayload = JSON.parse(mocks.atomicWriteAsync.mock.calls[1][1] as string);
    expect(statePayload.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(summaryPayload.updatedAt).toBe(statePayload.updatedAt);

    finishSummaryWrite();
    await writing;
    expect(settled).toBe(true);
  });

  it('serializes publications across store instances so snapshot generations cannot interleave', async () => {
    let finishFirstSummaryWrite!: () => void;
    const firstSummaryWrite = new Promise<void>((resolve) => {
      finishFirstSummaryWrite = resolve;
    });
    mocks.atomicWriteAsync
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(firstSummaryWrite)
      .mockResolvedValue(undefined);

    const firstWrite = new TeamLaunchStateStore().write(
      'demo',
      snapshot('2026-01-01T00:00:00.000Z')
    );
    await vi.waitFor(() => expect(mocks.atomicWriteAsync).toHaveBeenCalledTimes(2));

    const secondWrite = new TeamLaunchStateStore().write(
      'demo',
      snapshot('2026-01-01T00:00:01.000Z')
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.atomicWriteAsync).toHaveBeenCalledTimes(2);

    finishFirstSummaryWrite();
    await Promise.all([firstWrite, secondWrite]);

    expect(mocks.atomicWriteAsync).toHaveBeenCalledTimes(4);
    const persistedGenerations = mocks.atomicWriteAsync.mock.calls.map(([, payload]) =>
      JSON.parse(payload as string)
    );
    expect(persistedGenerations.map(({ updatedAt }) => updatedAt)).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:01.000Z',
      '2026-01-01T00:00:01.000Z',
    ]);
  });

  it('does not revoke a publication while its summary is still being persisted', async () => {
    let finishSummaryWrite!: () => void;
    const summaryWrite = new Promise<void>((resolve) => {
      finishSummaryWrite = resolve;
    });
    mocks.atomicWriteAsync.mockResolvedValueOnce(undefined).mockReturnValueOnce(summaryWrite);
    const remove = vi.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);

    try {
      const writing = new TeamLaunchStateStore().write('demo', snapshot());
      await vi.waitFor(() => expect(mocks.atomicWriteAsync).toHaveBeenCalledTimes(2));

      const clearing = new TeamLaunchStateStore().clear('demo');
      await Promise.resolve();
      await Promise.resolve();

      expect(remove).not.toHaveBeenCalled();

      finishSummaryWrite();
      await Promise.all([writing, clearing]);

      expect(remove).toHaveBeenNthCalledWith(1, getTeamLaunchStatePath('demo'), { force: true });
      expect(remove).toHaveBeenNthCalledWith(2, getTeamLaunchSummaryPath('demo'), { force: true });
    } finally {
      remove.mockRestore();
    }
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

  it('rejects an incomplete revocation after attempting to clear both publication files', async () => {
    const stateRemovalError = Object.assign(new Error('state file is busy'), { code: 'EBUSY' });
    const remove = vi
      .spyOn(fs.promises, 'rm')
      .mockRejectedValueOnce(stateRemovalError)
      .mockResolvedValueOnce(undefined);

    try {
      await expect(new TeamLaunchStateStore().clear('demo')).rejects.toBe(stateRemovalError);

      expect(remove).toHaveBeenNthCalledWith(1, getTeamLaunchStatePath('demo'), { force: true });
      expect(remove).toHaveBeenNthCalledWith(2, getTeamLaunchSummaryPath('demo'), { force: true });
    } finally {
      remove.mockRestore();
    }
  });

  it('reports every I/O failure when neither publication file can be revoked', async () => {
    const stateRemovalError = Object.assign(new Error('state file is busy'), { code: 'EBUSY' });
    const summaryRemovalError = Object.assign(new Error('summary is read-only'), {
      code: 'EROFS',
    });
    const remove = vi
      .spyOn(fs.promises, 'rm')
      .mockRejectedValueOnce(stateRemovalError)
      .mockRejectedValueOnce(summaryRemovalError);

    try {
      const clearing = new TeamLaunchStateStore().clear('demo');

      await expect(clearing).rejects.toMatchObject({
        errors: [stateRemovalError, summaryRemovalError],
        message: '[demo] Failed to clear launch-state publication',
      });
      expect(remove).toHaveBeenNthCalledWith(1, getTeamLaunchStatePath('demo'), { force: true });
      expect(remove).toHaveBeenNthCalledWith(2, getTeamLaunchSummaryPath('demo'), { force: true });
    } finally {
      remove.mockRestore();
    }
  });

  it('preserves supported unknown fields while replacing known launch entities', async () => {
    const statePath = getTeamLaunchStatePath('demo');
    const existingState = {
      ...snapshot(),
      futureRoot: { retained: true },
      members: {
        Builder: {
          ...snapshot().members.Builder,
          runtimeDiagnostic: 'remove known optional field',
          futureMember: { retained: true },
          sources: {
            processAlive: true,
            futureSource: { retained: true },
          },
        },
        Removed: {
          ...snapshot().members.Builder,
          name: 'Removed',
          futureMember: { doNotResurrect: true },
        },
      },
      summary: {
        ...snapshot().summary,
        futureSummary: { retained: true },
      },
    };
    const existingSummary = {
      version: 1,
      teamName: 'demo',
      updatedAt: '2026-01-01T00:00:00.000Z',
      futureProjection: { retained: true },
    };
    const statSpy = vi.spyOn(fs.promises, 'stat').mockImplementation(async (filePath) => {
      const raw = filePath === statePath ? existingState : existingSummary;
      return {
        isFile: () => true,
        size: Buffer.byteLength(JSON.stringify(raw)),
      } as fs.Stats;
    });
    const readSpy = vi
      .spyOn(fs.promises, 'readFile')
      .mockImplementation(async (filePath) =>
        JSON.stringify(filePath === statePath ? existingState : existingSummary)
      );

    try {
      const next = snapshot('2026-01-01T00:00:01.000Z');
      next.members.Builder.sources = { processAlive: false };
      await new TeamLaunchStateStore().write('demo', next);

      const persistedState = JSON.parse(mocks.atomicWriteAsync.mock.calls[0][1] as string) as {
        futureRoot?: unknown;
        members: Record<string, Record<string, unknown>>;
        summary: Record<string, unknown>;
      };
      const persistedSummary = JSON.parse(mocks.atomicWriteAsync.mock.calls[1][1] as string) as {
        futureProjection?: unknown;
      };
      expect(persistedState.futureRoot).toEqual({ retained: true });
      expect(persistedState.members.Builder).toMatchObject({
        futureMember: { retained: true },
        sources: { processAlive: false, futureSource: { retained: true } },
      });
      expect(persistedState.members.Builder.runtimeDiagnostic).toBeUndefined();
      expect(persistedState.members.Removed).toBeUndefined();
      expect(persistedState.summary.futureSummary).toEqual({ retained: true });
      expect(persistedSummary.futureProjection).toEqual({ retained: true });
    } finally {
      statSpy.mockRestore();
      readSpy.mockRestore();
    }
  });

  it.each([
    ['future version', JSON.stringify({ version: 3, teamName: 'demo' }), 32],
    ['malformed JSON', '{not-json', 9],
    ['malformed document', JSON.stringify({ version: 2, teamName: 'demo' }), 32],
    [
      'malformed known member source',
      JSON.stringify({
        ...snapshot(),
        members: {
          Builder: {
            ...snapshot().members.Builder,
            sources: { processAlive: 'yes' },
          },
        },
      }),
      1,
    ],
    [
      'malformed known launch summary count',
      JSON.stringify({
        ...snapshot(),
        summary: { ...snapshot().summary, confirmedCount: 'one' },
      }),
      1,
    ],
    ['oversized JSON', '{}', 256 * 1024 + 1],
  ])('fails closed on %s without publishing either launch file', async (_label, raw, size) => {
    const statePath = getTeamLaunchStatePath('demo');
    const statSpy = vi.spyOn(fs.promises, 'stat').mockImplementation(async (filePath) => {
      if (filePath === statePath) {
        return { isFile: () => true, size } as fs.Stats;
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const readSpy = vi.spyOn(fs.promises, 'readFile').mockResolvedValue(raw);

    try {
      await expect(new TeamLaunchStateStore().write('demo', snapshot())).rejects.toBeTruthy();
      expect(mocks.atomicWriteAsync).not.toHaveBeenCalled();
      vi.mocked(console.warn).mockClear();
    } finally {
      statSpy.mockRestore();
      readSpy.mockRestore();
    }
  });

  it('fails closed on malformed known summary-projection fields before publishing either file', async () => {
    const statePath = getTeamLaunchStatePath('demo');
    const stateRaw = JSON.stringify(snapshot());
    const summaryRaw = JSON.stringify({
      version: 1,
      teamName: 'demo',
      updatedAt: '2026-01-01T00:00:00.000Z',
      missingMembers: ['Builder', 42],
    });
    const statSpy = vi.spyOn(fs.promises, 'stat').mockImplementation(async (filePath) => {
      const raw = filePath === statePath ? stateRaw : summaryRaw;
      return { isFile: () => true, size: Buffer.byteLength(raw) } as fs.Stats;
    });
    const readSpy = vi
      .spyOn(fs.promises, 'readFile')
      .mockImplementation(async (filePath) => (filePath === statePath ? stateRaw : summaryRaw));

    try {
      await expect(new TeamLaunchStateStore().write('demo', snapshot())).rejects.toBeTruthy();
      expect(mocks.atomicWriteAsync).not.toHaveBeenCalled();
      vi.mocked(console.warn).mockClear();
    } finally {
      statSpy.mockRestore();
      readSpy.mockRestore();
    }
  });
});
