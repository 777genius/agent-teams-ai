import { createPersistedLaunchSnapshot } from '@main/services/team/TeamLaunchStateEvaluator';
import { createPersistedLaunchSummaryProjection } from '@main/services/team/TeamLaunchSummaryProjection';
import {
  getTeamLaunchStatePath,
  getTeamLaunchStoppedMarkerPath,
  getTeamLaunchSummaryPath,
  TeamLaunchStateStore,
  withTeamLaunchStatePublicationLock,
} from '@main/services/team/TeamLaunchStateStore';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

function snapshot(
  updatedAt = '2026-01-01T00:00:00.000Z',
  teamName = 'demo'
): PersistedTeamLaunchSnapshot {
  return createPersistedLaunchSnapshot({
    teamName,
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

function writeStopMarkerOnDisk(teamName: string): void {
  const markerPath = getTeamLaunchStoppedMarkerPath(teamName);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, '{"version":1}\n');
}

describe('TeamLaunchStateStore', () => {
  beforeEach(() => {
    mocks.atomicWriteAsync.mockReset();
    fs.rmSync(mocks.teamsBasePath, { recursive: true, force: true });
    fs.mkdirSync(path.join(mocks.teamsBasePath, 'demo'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(mocks.teamsBasePath, { recursive: true, force: true });
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

  it('separates a launch state that is absent from one it could not read', async () => {
    const store = new TeamLaunchStateStore();

    await expect(store.readResult('demo')).resolves.toEqual({ status: 'absent' });

    const statePath = getTeamLaunchStatePath('demo');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, '{ not json');

    // Both answer `null` through `read`, which is why a caller that has to tell
    // "nothing recorded" from "nothing readable" cannot use it.
    await expect(store.read('demo')).resolves.toBeNull();
    await expect(store.readResult('demo')).resolves.toMatchObject({ status: 'unreadable' });
  });

  it('reports a launch state the filesystem refused as unreadable, not absent', async () => {
    const readFile = vi
      .spyOn(fs.promises, 'readFile')
      .mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }));

    try {
      const statePath = getTeamLaunchStatePath('demo');
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(snapshot()));

      await expect(new TeamLaunchStateStore().readResult('demo')).resolves.toEqual({
        status: 'unreadable',
        reason: 'permission denied',
      });
    } finally {
      readFile.mockRestore();
    }
  });

  it('holds a caller-supplied publication until an in-flight stop has finished', async () => {
    // markStopped removes the publication files and writes its marker after
    // them. A caller that publishes those files from outside the store - the
    // backup restore - must not run between the two, so it shares the queue
    // rather than checking the marker on its own.
    const order: string[] = [];
    mocks.atomicWriteAsync.mockImplementation(async (target: string) => {
      order.push(`stop-marker:${path.basename(target)}`);
    });

    const stopping = new TeamLaunchStateStore().markStopped('demo');
    const restoring = withTeamLaunchStatePublicationLock('demo', async () => {
      order.push('restore-commit');
    });
    await Promise.all([stopping, restoring]);

    expect(order).toEqual(['stop-marker:launch-freshness.json', 'stop-marker:launch-stopped.json', 'restore-commit']);
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
      expect.any(String),
      expect.objectContaining({ beforeCommit: expect.any(Function) })
    );
    expect(mocks.atomicWriteAsync).toHaveBeenNthCalledWith(
      2,
      getTeamLaunchSummaryPath('demo'),
      expect.any(String),
      expect.objectContaining({ beforeCommit: expect.any(Function) })
    );
  });

  it('rejects an invalid producer snapshot without touching an existing publication', async () => {
    const invalidSnapshot = snapshot();
    invalidSnapshot.members.Builder.launchIdentity = {
      providerId: 'opencode',
      providerBackendId: 'opencode-cli',
      selectedModel: 'opencode/big-pickle',
      selectedModelKind: 'explicit',
      resolvedLaunchModel: 'opencode/big-pickle',
      catalogId: 'opencode/big-pickle',
      // `bundled` is not a catalog source in the persisted launch-state contract.
      catalogSource: 'bundled' as never,
      catalogFetchedAt: '2026-01-01T00:00:00.000Z',
      selectedEffort: 'medium',
      resolvedEffort: 'medium',
    };
    const statePath = getTeamLaunchStatePath('demo');
    const summaryPath = getTeamLaunchSummaryPath('demo');
    const existingState = `${JSON.stringify(snapshot(), null, 2)}\n`;
    const existingSummary = `${JSON.stringify(
      createPersistedLaunchSummaryProjection(snapshot()),
      null,
      2
    )}\n`;
    fs.writeFileSync(statePath, existingState);
    fs.writeFileSync(summaryPath, existingSummary);
    const remove = vi.spyOn(fs.promises, 'rm');

    try {
      await expect(new TeamLaunchStateStore().write('demo', invalidSnapshot)).rejects.toThrow(
        'Refusing to persist malformed launch state'
      );

      expect(mocks.atomicWriteAsync).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(fs.readFileSync(statePath, 'utf8')).toBe(existingState);
      expect(fs.readFileSync(summaryPath, 'utf8')).toBe(existingSummary);
      vi.mocked(console.warn).mockClear();
    } finally {
      remove.mockRestore();
    }
  });

  it('persists validated runtime bootstrap identity used by launch reconciliation', async () => {
    const launchSnapshot = snapshot();
    Object.assign(launchSnapshot.members.Builder, {
      backendType: 'process' as const,
      tmuxPaneId: 'process:123',
      agentId: 'agent-builder',
      bootstrapRunId: 'run-builder',
      bootstrapExpectedAfter: '2026-01-01T00:00:00.000Z',
      bootstrapRuntimeEventsPath: '/safe-test-project/builder.runtime.jsonl',
    });

    await expect(new TeamLaunchStateStore().write('demo', launchSnapshot)).resolves.toBe(true);

    const statePayload = JSON.parse(mocks.atomicWriteAsync.mock.calls[0][1] as string);
    expect(statePayload.members.Builder).toMatchObject({
      backendType: 'process',
      tmuxPaneId: 'process:123',
      agentId: 'agent-builder',
      bootstrapRunId: 'run-builder',
      bootstrapExpectedAfter: '2026-01-01T00:00:00.000Z',
      bootstrapRuntimeEventsPath: '/safe-test-project/builder.runtime.jsonl',
    });
  });

  it('rejects malformed runtime bootstrap identity without publishing it', async () => {
    const launchSnapshot = snapshot();
    Object.assign(launchSnapshot.members.Builder, {
      backendType: 'unsupported-backend' as never,
      bootstrapRunId: 'run-builder',
    });

    await expect(new TeamLaunchStateStore().write('demo', launchSnapshot)).rejects.toThrow(
      'Refusing to persist malformed launch state'
    );

    expect(mocks.atomicWriteAsync).not.toHaveBeenCalled();
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

  it('publishes a complete successor generation after a partial publication fails', async () => {
    const summaryFailure = Object.assign(new Error('summary disk failure'), { code: 'EIO' });
    mocks.atomicWriteAsync
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(summaryFailure)
      .mockResolvedValue(undefined);

    await expect(
      new TeamLaunchStateStore().write('demo', snapshot('2026-01-01T00:00:00.000Z'))
    ).rejects.toBe(summaryFailure);
    vi.mocked(console.warn).mockClear();

    await expect(
      new TeamLaunchStateStore().write('demo', snapshot('2026-01-01T00:00:01.000Z'))
    ).resolves.toBe(true);

    expect(mocks.atomicWriteAsync).toHaveBeenCalledTimes(4);
    const publications = mocks.atomicWriteAsync.mock.calls.map(([targetPath, payload]) => ({
      targetPath,
      updatedAt: (JSON.parse(payload as string) as { updatedAt: string }).updatedAt,
    }));
    expect(publications.slice(2)).toEqual([
      {
        targetPath: getTeamLaunchStatePath('demo'),
        updatedAt: '2026-01-01T00:00:01.000Z',
      },
      {
        targetPath: getTeamLaunchSummaryPath('demo'),
        updatedAt: '2026-01-01T00:00:01.000Z',
      },
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
      new TeamLaunchStateStore().write('removed-team', snapshot(undefined, 'removed-team'))
    ).resolves.toBe(false);
    expect(mocks.atomicWriteAsync).not.toHaveBeenCalled();
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

  it('drops both publications and records the stop marker when a team is marked stopped', async () => {
    const remove = vi.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);

    try {
      await new TeamLaunchStateStore().markStopped('demo');

      expect(remove).toHaveBeenNthCalledWith(1, getTeamLaunchStatePath('demo'), { force: true });
      expect(remove).toHaveBeenNthCalledWith(2, getTeamLaunchSummaryPath('demo'), { force: true });
      expect(mocks.atomicWriteAsync).toHaveBeenCalledTimes(2);
      const [markerPath, markerPayload] = mocks.atomicWriteAsync.mock.calls[1] as [string, string];
      expect(markerPath).toBe(getTeamLaunchStoppedMarkerPath('demo'));
      expect(JSON.parse(markerPayload)).toMatchObject({ version: 1, teamName: 'demo' });
    } finally {
      remove.mockRestore();
    }
  });

  it('keeps the stop marker as a compatible no-op when the team directory disappeared', async () => {
    const markerPath = getTeamLaunchStoppedMarkerPath('removed-team');
    const missingDirectoryError = Object.assign(new Error('directory removed'), {
      code: 'ENOENT',
      path: path.join(path.dirname(markerPath), '.tmp.removed'),
      dest: markerPath,
    });
    mocks.atomicWriteAsync.mockRejectedValueOnce(missingDirectoryError);

    await expect(new TeamLaunchStateStore().markStopped('removed-team')).resolves.toBeUndefined();
  });

  it('records the stop marker and still reports a publication that survived the stop', async () => {
    // read() answers from the launch state and never from the marker, so a
    // snapshot that could not be revoked is still served. The stop stays final
    // - the marker is written either way - but the survivor is reported.
    const stateRemovalError = Object.assign(new Error('state file is busy'), { code: 'EBUSY' });
    const remove = vi
      .spyOn(fs.promises, 'rm')
      .mockRejectedValueOnce(stateRemovalError)
      .mockResolvedValueOnce(undefined);

    try {
      await expect(new TeamLaunchStateStore().markStopped('demo')).rejects.toBe(stateRemovalError);

      expect(mocks.atomicWriteAsync).toHaveBeenCalledTimes(2);
      expect(mocks.atomicWriteAsync.mock.calls[1]?.[0]).toBe(
        getTeamLaunchStoppedMarkerPath('demo')
      );
    } finally {
      remove.mockRestore();
    }
  });

  it('reports every publication that survived the stop', async () => {
    const stateRemovalError = Object.assign(new Error('state file is busy'), { code: 'EBUSY' });
    const summaryRemovalError = Object.assign(new Error('summary is read-only'), { code: 'EROFS' });
    const remove = vi
      .spyOn(fs.promises, 'rm')
      .mockRejectedValueOnce(stateRemovalError)
      .mockRejectedValueOnce(summaryRemovalError);

    try {
      await expect(new TeamLaunchStateStore().markStopped('demo')).rejects.toMatchObject({
        errors: [stateRemovalError, summaryRemovalError],
        message: '[demo] Failed to clear launch-state publication',
      });
      expect(mocks.atomicWriteAsync.mock.calls[1]?.[0]).toBe(
        getTeamLaunchStoppedMarkerPath('demo')
      );
    } finally {
      remove.mockRestore();
    }
  });

  it('ignores a late reconciled launch-state write while the team is stopped', async () => {
    writeStopMarkerOnDisk('demo');
    const stale = { ...snapshot(), launchPhase: 'reconciled' as const };

    await expect(new TeamLaunchStateStore().write('demo', stale)).resolves.toBe(false);

    expect(mocks.atomicWriteAsync).not.toHaveBeenCalled();
    expect(await new TeamLaunchStateStore().isStopped('demo')).toBe(true);
  });

  it('lifts the stop marker when a real launch publishes an active snapshot', async () => {
    writeStopMarkerOnDisk('demo');
    mocks.atomicWriteAsync.mockResolvedValue(undefined);

    await new TeamLaunchStateStore().beginLaunch('demo', 'new-run', ['Builder'], () => true);

    expect(mocks.atomicWriteAsync).toHaveBeenCalledTimes(3);
    expect(await new TeamLaunchStateStore().isStopped('demo')).toBe(false);
  });

  it('ignores a republished active snapshot while the team is stopped', async () => {
    // The rollback of a stale write, and a recovery re-deriving the run that was
    // just stopped, both republish an active snapshot they read earlier. Neither
    // is a launch, so the stop stays final over them.
    writeStopMarkerOnDisk('demo');
    mocks.atomicWriteAsync.mockResolvedValue(undefined);

    await new TeamLaunchStateStore().write('demo', snapshot(), {
      republishesExistingLaunch: true,
    });

    expect(mocks.atomicWriteAsync).not.toHaveBeenCalled();
    expect(await new TeamLaunchStateStore().isStopped('demo')).toBe(true);
  });

  it('publishes a republished active snapshot for a team that was never stopped', async () => {
    mocks.atomicWriteAsync.mockResolvedValue(undefined);

    await new TeamLaunchStateStore().write('demo', snapshot(), {
      republishesExistingLaunch: true,
    });

    expect(mocks.atomicWriteAsync).toHaveBeenCalledTimes(2);
  });

  it('keeps the stop marker across a launch-state clear', async () => {
    writeStopMarkerOnDisk('demo');

    await new TeamLaunchStateStore().clear('demo');

    expect(await new TeamLaunchStateStore().isStopped('demo')).toBe(true);
  });

  it('still revokes both publications for a team that was never marked stopped', async () => {
    const remove = vi.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);

    try {
      await new TeamLaunchStateStore().clear('demo');

      expect(remove.mock.calls.map(([targetPath]) => targetPath)).toEqual([
        getTeamLaunchStatePath('demo'),
        getTeamLaunchSummaryPath('demo'),
      ]);
    } finally {
      remove.mockRestore();
    }
  });

  it('publishes a reconciled snapshot for a team that was never marked stopped', async () => {
    mocks.atomicWriteAsync.mockResolvedValue(undefined);
    const stale = { ...snapshot(), launchPhase: 'reconciled' as const };

    await new TeamLaunchStateStore().write('demo', stale);

    expect(mocks.atomicWriteAsync.mock.calls.map(([targetPath]) => targetPath)).toEqual([
      getTeamLaunchStatePath('demo'),
      getTeamLaunchSummaryPath('demo'),
    ]);
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

  it('does not overwrite a v2 document with unknown fields', async () => {
    const statePath = getTeamLaunchStatePath('demo');
    const summaryPath = getTeamLaunchSummaryPath('demo');
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
      .mockImplementation(async (filePath) => {
        if (filePath === statePath) return JSON.stringify(existingState);
        if (filePath === summaryPath) return JSON.stringify(existingSummary);
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

    try {
      await expect(new TeamLaunchStateStore().write('demo', snapshot())).rejects.toThrow(
        'Refusing to replace malformed launch state'
      );
      expect(mocks.atomicWriteAsync).not.toHaveBeenCalled();
      vi.mocked(console.warn).mockClear();
    } finally {
      statSpy.mockRestore();
      readSpy.mockRestore();
    }
  });

  it('migrates a legacy partial launch marker before publishing a successor snapshot', async () => {
    const statePath = getTeamLaunchStatePath('demo');
    const teamDirectory = path.dirname(statePath);
    const teamDirectoryStat = fs.statSync(teamDirectory);
    const legacy = JSON.stringify({
      state: 'partial_launch_failure',
      updatedAt: '2026-01-01T00:00:00.000Z',
      expectedMembers: ['Builder', 'Reviewer'],
      confirmedMembers: ['Builder'],
      missingMembers: ['Reviewer'],
    });
    const statSpy = vi.spyOn(fs.promises, 'stat').mockImplementation(async (filePath) => {
      if (filePath === statePath) {
        return { isFile: () => true, size: Buffer.byteLength(legacy) } as fs.Stats;
      }
      if (filePath === teamDirectory) return teamDirectoryStat;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const readSpy = vi.spyOn(fs.promises, 'readFile').mockImplementation(async (filePath) => {
      if (filePath === statePath) return legacy;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    try {
      await expect(new TeamLaunchStateStore().write('demo', snapshot())).resolves.toBe(true);
      const persisted = JSON.parse(mocks.atomicWriteAsync.mock.calls[0][1] as string);
      expect(persisted).toMatchObject({ version: 2, teamName: 'demo' });
      expect(persisted.members).toHaveProperty('Builder');
    } finally {
      statSpy.mockRestore();
      readSpy.mockRestore();
    }
  });

  it('migrates only a v2 member key/name mismatch before publishing a successor snapshot', async () => {
    const statePath = getTeamLaunchStatePath('demo');
    const existing = snapshot();
    existing.members.Builder.name = 'Duplicated primary member';
    fs.writeFileSync(statePath, JSON.stringify(existing));

    await expect(
      new TeamLaunchStateStore().write('demo', snapshot('2026-01-01T00:00:01.000Z'))
    ).resolves.toBe(true);

    const persisted = JSON.parse(mocks.atomicWriteAsync.mock.calls[0][1] as string);
    expect(persisted.members.Builder.name).toBe('Builder');
  });

  it('does not bypass v2 validation through the legacy partial-launch marker', async () => {
    const statePath = getTeamLaunchStatePath('demo');
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 2,
        teamName: 'demo',
        state: 'partial_launch_failure',
        updatedAt: '2026-01-01T00:00:00.000Z',
        expectedMembers: ['Builder', 'Reviewer'],
        confirmedMembers: ['Builder'],
        missingMembers: ['Reviewer'],
      })
    );

    await expect(new TeamLaunchStateStore().write('demo', snapshot())).rejects.toThrow(
      'Refusing to replace malformed launch state'
    );
    await expect(new TeamLaunchStateStore().readResult('demo')).resolves.toMatchObject({
      status: 'unreadable',
    });
    expect(mocks.atomicWriteAsync).not.toHaveBeenCalled();
    vi.mocked(console.warn).mockClear();
  });

  it.each([
    [
      'a missing required member field',
      (document: ReturnType<typeof snapshot>) => {
        delete (document.members.Builder as Partial<PersistedTeamLaunchSnapshot['members']['Builder']>)
          .runtimeAlive;
      },
    ],
    [
      'an invalid member boolean',
      (document: ReturnType<typeof snapshot>) => {
        document.members.Builder.agentToolAccepted = 'true' as never;
      },
    ],
    [
      'a malformed summary count',
      (document: ReturnType<typeof snapshot>) => {
        document.summary.confirmedCount = 'one' as never;
      },
    ],
  ])('does not migrate a v2 key/name mismatch with %s', async (_label, corrupt) => {
    const statePath = getTeamLaunchStatePath('demo');
    const malformed = snapshot();
    malformed.members.Builder.name = 'Duplicated primary member';
    corrupt(malformed);
    fs.writeFileSync(statePath, JSON.stringify(malformed));

    await expect(new TeamLaunchStateStore().write('demo', snapshot())).rejects.toThrow(
      'Refusing to replace malformed launch state'
    );
    expect(mocks.atomicWriteAsync).not.toHaveBeenCalled();
    vi.mocked(console.warn).mockClear();
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
