import { parseTeamLaunchFreshness } from '@main/services/team/TeamLaunchFreshness';
import { createPersistedLaunchSnapshot } from '@main/services/team/TeamLaunchStateEvaluator';
import {
  getTeamLaunchStatePath,
  getTeamLaunchStoppedMarkerPath,
  getTeamLaunchSummaryPath,
  readPersistedLaunchRuntimePidsSync,
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

  it('keeps Stop final while rejecting oversized or incomplete optional historical identity', () => {
    const marker = {
      version: 1,
      teamName: 'demo',
      kind: 'stop',
      stopId: 'stop',
      transcriptBindings: [
        { memberName: 'Builder', laneId: 'primary', runId: 'sdk', sessionId: 'ses_original' },
      ],
    };
    expect(parseTeamLaunchFreshness('demo', marker)).toMatchObject({
      kind: 'stop',
      transcriptBindings: [],
    });
    expect(
      parseTeamLaunchFreshness('demo', {
        ...marker,
        stoppedRunId: 'app',
        transcriptBindings: Array(129).fill(marker.transcriptBindings[0]),
      })
    ).toMatchObject({ kind: 'stop', transcriptBindings: [] });
  });

  it('captures original member identities before cleanup and retains them through repeated STOP', async () => {
    mocks.atomicWriteAsync.mockImplementation(async (target: string, content: string) => {
      await fs.promises.writeFile(target, content);
    });
    const store = new TeamLaunchStateStore();
    const current = snapshot();
    current.publicationRunId = 'app-publication';
    current.members.Builder = {
      ...current.members.Builder!,
      providerId: 'opencode',
      laneId: 'primary',
      runtimeRunId: 'sdk-original',
      runtimeSessionId: 'ses_member',
    };
    current.members['team-lead'] = {
      ...current.members.Builder,
      name: 'team-lead',
      runtimeSessionId: 'ses_lead',
    };
    current.members.skipped = {
      ...current.members.Builder,
      name: 'skipped',
      runtimeSessionId: undefined,
    };
    const freshnessPath = path.join(mocks.teamsBasePath, 'demo', 'launch-freshness.json');
    fs.writeFileSync(
      freshnessPath,
      JSON.stringify({ version: 1, teamName: 'demo', kind: 'launch', runId: 'app-publication' })
    );
    fs.writeFileSync(getTeamLaunchStatePath('demo'), JSON.stringify(current));
    const admitted = await store.beginStop('demo');
    expect(admitted.transcriptBindings).toEqual([
      { memberName: 'Builder', laneId: 'primary', runId: 'sdk-original', sessionId: 'ses_member' },
      { memberName: 'team-lead', laneId: 'primary', runId: 'sdk-original', sessionId: 'ses_lead' },
    ]);
    // The runtime lane and live publication can disappear before markStopped runs.
    fs.rmSync(getTeamLaunchStatePath('demo'));
    await store.markStopped('demo', admitted);
    expect(JSON.parse(fs.readFileSync(freshnessPath, 'utf8'))).toMatchObject({
      kind: 'stop',
      stoppedRunId: 'app-publication',
      transcriptBindings: admitted.transcriptBindings,
    });
    const repeated = await store.beginStop('demo');
    await store.markStopped('demo', repeated);
    expect(JSON.parse(fs.readFileSync(freshnessPath, 'utf8')).transcriptBindings).toEqual(
      admitted.transcriptBindings
    );
    await store.beginLaunch('demo', 'successor-app', ['Builder'], () => true);
    expect(JSON.parse(fs.readFileSync(freshnessPath, 'utf8'))).toEqual({
      version: 1,
      teamName: 'demo',
      kind: 'launch',
      runId: 'successor-app',
    });
    await store.markStopped('demo', admitted);
    expect(JSON.parse(fs.readFileSync(freshnessPath, 'utf8')).kind).toBe('launch');
  });

  it('never retains another publication or a conflicting member candidate at STOP admission', async () => {
    const current = snapshot();
    current.publicationRunId = 'old-app';
    current.members.Builder = {
      ...current.members.Builder!,
      providerId: 'opencode',
      laneId: 'primary',
      runtimeRunId: 'sdk-original',
      runtimeSessionId: 'ses_member',
      appManagedBootstrapCandidate: {
        teamName: 'demo',
        memberName: 'Builder',
        laneId: 'primary',
        runId: 'other-sdk',
        runtimeSessionId: 'ses_member',
      } as never,
    };
    fs.writeFileSync(
      path.join(mocks.teamsBasePath, 'demo', 'launch-freshness.json'),
      JSON.stringify({
        version: 1,
        teamName: 'demo',
        kind: 'launch',
        runId: 'current-app',
      })
    );
    fs.writeFileSync(getTeamLaunchStatePath('demo'), JSON.stringify(current));
    expect((await new TeamLaunchStateStore().beginStop('demo')).transcriptBindings).toEqual([]);
    current.publicationRunId = 'current-app';
    current.members.Builder.bootstrapEvidenceSource = 'app_managed_bootstrap';
    current.members.Builder.appManagedBootstrapCandidate = undefined;
    fs.writeFileSync(getTeamLaunchStatePath('demo'), JSON.stringify(current));
    expect((await new TeamLaunchStateStore().beginStop('demo')).transcriptBindings).toEqual([]);
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

    expect(order).toEqual([
      'stop-marker:launch-freshness.json',
      'stop-marker:launch-stopped.json',
      'restore-commit',
    ]);
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

    await expect(new TeamLaunchStateStore().write('removed-team', snapshot())).resolves.toBe(false);
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
});

describe('readPersistedLaunchRuntimePidsSync', () => {
  const teamName = 'demo';

  beforeEach(() => {
    fs.rmSync(mocks.teamsBasePath, { recursive: true, force: true });
    fs.mkdirSync(path.join(mocks.teamsBasePath, teamName), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(mocks.teamsBasePath, { recursive: true, force: true });
  });

  function writeLaunchState(content: string): void {
    fs.writeFileSync(getTeamLaunchStatePath(teamName), content);
  }

  function memberEntry(name: string, runtimePid?: unknown): Record<string, unknown> {
    return {
      name,
      launchState: 'confirmed_alive',
      agentToolAccepted: true,
      runtimeAlive: true,
      bootstrapConfirmed: true,
      hardFailure: false,
      lastEvaluatedAt: '2026-01-01T00:00:00.000Z',
      ...(runtimePid !== undefined ? { runtimePid } : {}),
    };
  }

  it('collects the deduplicated recorded runtime pids of persisted launch members', () => {
    writeLaunchState(
      JSON.stringify({
        version: 2,
        teamName,
        expectedMembers: ['team-lead', 'alice', 'bob', 'jack', 'tom'],
        launchPhase: 'finished',
        updatedAt: '2026-01-01T00:00:00.000Z',
        members: {
          'team-lead': memberEntry('team-lead', 97771),
          alice: memberEntry('alice', 97771),
          bob: memberEntry('bob', 97771),
          jack: memberEntry('jack', 0),
          tom: memberEntry('tom'),
        },
      })
    );

    expect(readPersistedLaunchRuntimePidsSync(teamName)).toEqual([97771]);
  });

  it('answers no pids when the launch state is absent or does not describe a launch', () => {
    expect(readPersistedLaunchRuntimePidsSync(teamName)).toEqual([]);
    writeLaunchState('not json');
    expect(readPersistedLaunchRuntimePidsSync(teamName)).toEqual([]);
    writeLaunchState(JSON.stringify({ version: 2, teamName, members: 'nonsense' }));
    expect(readPersistedLaunchRuntimePidsSync(teamName)).toEqual([]);
  });

  it('answers no pids when the persisted launch state names a different team', () => {
    writeLaunchState(
      JSON.stringify({
        version: 2,
        teamName: 'other-team',
        expectedMembers: ['alice'],
        members: { alice: memberEntry('alice', 4242) },
      })
    );

    expect(readPersistedLaunchRuntimePidsSync(teamName)).toEqual([]);
  });
});
