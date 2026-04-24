import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const files = new Map<
    string,
    {
      contents: string;
      size?: number;
      symbolicLink?: boolean;
      ino?: number;
      dev?: number;
      mode?: number;
      mtimeMs?: number;
      openedContents?: string;
      openedSize?: number;
      openedIno?: number;
      openedDev?: number;
      openedMode?: number;
      openedMtimeMs?: number;
    }
  >();

  const norm = (p: string): string => p.replace(/\\/g, '/');

  const lstat = vi.fn(async (filePath: string) => {
    const entry = files.get(norm(filePath));
    if (!entry) {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return {
      isFile: () => !entry.symbolicLink,
      isSymbolicLink: () => Boolean(entry.symbolicLink),
      size: entry.size ?? Buffer.byteLength(entry.contents, 'utf8'),
      ino: entry.ino ?? 1,
      dev: entry.dev ?? 1,
      mode: entry.mode ?? 0o100600,
      mtimeMs: entry.mtimeMs ?? 1,
    };
  });

  const readFile = vi.fn(async (filePath: string) => {
    const entry = files.get(norm(filePath));
    if (!entry) {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return entry.contents;
  });

  const open = vi.fn(async (filePath: string) => {
    const entry = files.get(norm(filePath));
    if (!entry) {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return {
      stat: vi.fn(async () => ({
        isFile: () => !entry.symbolicLink,
        size:
          entry.openedSize ??
          entry.size ??
          Buffer.byteLength(entry.openedContents ?? entry.contents, 'utf8'),
        ino: entry.openedIno ?? entry.ino ?? 1,
        dev: entry.openedDev ?? entry.dev ?? 1,
        mode: entry.openedMode ?? entry.mode ?? 0o100600,
        mtimeMs: entry.openedMtimeMs ?? entry.mtimeMs ?? 1,
      })),
      readFile: vi.fn(async () => entry.openedContents ?? entry.contents),
      close: vi.fn(async () => undefined),
    };
  });

  const access = vi.fn(async (filePath: string) => {
    const entry = files.get(norm(filePath));
    if (!entry) {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
  });

  const rm = vi.fn(async (filePath: string) => {
    files.delete(norm(filePath));
  });

  return { files, lstat, open, readFile, access, rm };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      lstat: hoisted.lstat,
      open: hoisted.open,
      readFile: hoisted.readFile,
      access: hoisted.access,
      rm: hoisted.rm,
    },
  };
});

vi.mock('../../../../src/main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => '/mock/teams',
}));

import {
  choosePreferredLaunchSnapshot,
  readBootstrapLaunchSnapshot,
  readBootstrapRealTaskSubmissionState,
  readBootstrapRuntimeState,
} from '../../../../src/main/services/team/TeamBootstrapStateReader';

describe('TeamBootstrapStateReader', () => {
  beforeEach(() => {
    hoisted.files.clear();
    hoisted.lstat.mockClear();
    hoisted.open.mockClear();
    hoisted.readFile.mockClear();
    hoisted.access.mockClear();
    hoisted.rm.mockClear();
  });

  it('rejects symlink bootstrap-state files', async () => {
    hoisted.files.set('/mock/teams/demo/bootstrap-state.json', {
      contents: '{}',
      symbolicLink: true,
    });

    await expect(readBootstrapLaunchSnapshot('demo')).resolves.toBeNull();
    await expect(readBootstrapRuntimeState('demo')).resolves.toBeNull();
  });

  it('projects active bootstrap-state into runtime progress', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1700000001000);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as never);

    hoisted.files.set('/mock/teams/demo/bootstrap-state.json', {
      contents: JSON.stringify({
        version: 1,
        runId: 'run-123',
        teamName: 'demo',
        ownerPid: 4242,
        startedAt: 1700000000000,
        updatedAt: 1700000000500,
        phase: 'acquiring_bootstrap_lock',
        members: [{ name: 'alice', status: 'pending' }],
      }),
    });
    hoisted.files.set('/mock/teams/demo/bootstrap-journal.jsonl', {
      contents: [
        JSON.stringify({ ts: 1, type: 'phase', runId: 'run-123', phase: 'loading_existing_state' }),
        JSON.stringify({ ts: 2, type: 'lock', runId: 'run-123', action: 'acquired', ownerPid: 4242 }),
        JSON.stringify({ ts: 3, type: 'member', runId: 'run-123', name: 'alice', action: 'spawn_started' }),
      ].join('\n'),
    });

    await expect(readBootstrapRuntimeState('demo')).resolves.toEqual({
      teamName: 'demo',
      isAlive: false,
      runId: 'run-123',
      progress: {
        runId: 'run-123',
        teamName: 'demo',
        state: 'configuring',
        message: 'Acquiring deterministic bootstrap lock',
        warnings: [
          'Recent deterministic bootstrap events: bootstrap phase: loading_existing_state | bootstrap lock acquired (pid 4242) | alice: spawn_started',
        ],
        startedAt: '2023-11-14T22:13:20.000Z',
        updatedAt: '2023-11-14T22:13:20.500Z',
        pid: 4242,
      },
    });

    killSpy.mockRestore();
    nowSpy.mockRestore();
  });

  it('surfaces unreadable bootstrap journal as a warning without breaking active recovery', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as never);

    hoisted.files.set('/mock/teams/demo/bootstrap-state.json', {
      contents: JSON.stringify({
        version: 1,
        runId: 'run-123',
        teamName: 'demo',
        ownerPid: 4242,
        startedAt: 1700000000000,
        updatedAt: 1700000000500,
        phase: 'spawning_members',
        members: [{ name: 'alice', status: 'pending' }],
      }),
    });
    hoisted.files.set('/mock/teams/demo/bootstrap-journal.jsonl', {
      contents: '{invalid-json',
    });

    await expect(readBootstrapRuntimeState('demo')).resolves.toMatchObject({
      teamName: 'demo',
      isAlive: false,
      runId: 'run-123',
      progress: {
        state: 'assembling',
        message: 'Spawning teammate runtimes (1)',
        warnings: [
          'Persisted deterministic bootstrap journal is unreadable because bootstrap-journal.jsonl is invalid, truncated, inaccessible, or changed while being read.',
        ],
      },
    });

    killSpy.mockRestore();
  });

  it('treats bootstrap-state replacement during read as degraded recovery, not trusted truth', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as never);

    hoisted.files.set('/mock/teams/demo/bootstrap-state.json', {
      contents: JSON.stringify({
        version: 1,
        runId: 'run-123',
        teamName: 'demo',
        ownerPid: 4242,
        startedAt: 1700000000000,
        updatedAt: 1700000000500,
        phase: 'spawning_members',
        members: [],
      }),
      ino: 1,
      openedIno: 2,
    });
    hoisted.files.set('/mock/teams/demo/.bootstrap.lock/metadata.json', {
      contents: JSON.stringify({
        pid: 4242,
        runId: 'run-123',
        ownerStartedAt: 1700000000000,
      }),
    });

    await expect(readBootstrapRuntimeState('demo')).resolves.toMatchObject({
      teamName: 'demo',
      isAlive: false,
      runId: 'run-123',
      progress: {
        state: 'configuring',
        message:
          'Deterministic bootstrap recovery is degraded because persisted bootstrap state is unreadable',
        warnings: [
          'Persisted deterministic bootstrap state is unreadable because bootstrap-state.json is invalid, truncated, inaccessible, or changed while being read.',
        ],
      },
    });

    killSpy.mockRestore();
  });

  it('ignores terminal bootstrap-state for runtime recovery projection', async () => {
    hoisted.files.set('/mock/teams/demo/bootstrap-state.json', {
      contents: JSON.stringify({
        version: 1,
        runId: 'run-123',
        teamName: 'demo',
        startedAt: 1700000000000,
        updatedAt: 1700000000500,
        phase: 'completed',
        terminal: {
          status: 'completed',
          finishedAt: 1700000000500,
        },
        members: [{ name: 'alice', status: 'registered' }],
      }),
    });

    await expect(readBootstrapRuntimeState('demo')).resolves.toBeNull();
  });

  it('does not promote bootstrap-state runtime_alive to strict runtimeAlive', async () => {
    hoisted.files.set('/mock/teams/demo/bootstrap-state.json', {
      contents: JSON.stringify({
        version: 1,
        runId: 'run-123',
        teamName: 'demo',
        startedAt: 1700000000000,
        updatedAt: 1700000000500,
        phase: 'spawning_members',
        members: [{ name: 'alice', status: 'runtime_alive', lastObservedAt: 1700000000400 }],
      }),
    });

    await expect(readBootstrapLaunchSnapshot('demo')).resolves.toMatchObject({
      launchPhase: 'active',
      members: {
        alice: {
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          sources: {
            configRegistered: true,
          },
          diagnostics: [
            'runtime alive reported by bootstrap state',
            'waiting for strict live verification',
          ],
        },
      },
    });
  });

  it('reads persisted real-task submission state', async () => {
    hoisted.files.set('/mock/teams/demo/bootstrap-state.json', {
      contents: JSON.stringify({
        version: 1,
        runId: 'run-123',
        teamName: 'demo',
        startedAt: 1700000000000,
        updatedAt: 1700000000500,
        phase: 'completed',
        realTaskSubmissionState: 'submitted',
        members: [],
      }),
    });

    await expect(readBootstrapRealTaskSubmissionState('demo')).resolves.toBe('submitted');
  });

  it('classifies dead bootstrap owner as failed launch snapshot instead of pending', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1700000300000);
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation(() => {
        const error = new Error('ESRCH') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      });

    hoisted.files.set('/mock/teams/demo/bootstrap-state.json', {
      contents: JSON.stringify({
        version: 1,
        runId: 'run-dead',
        teamName: 'demo',
        ownerPid: 777,
        startedAt: 1700000000000,
        updatedAt: 1700000000000,
        phase: 'spawning_members',
        members: [{ name: 'alice', status: 'registered' }],
      }),
    });

    await expect(readBootstrapLaunchSnapshot('demo')).resolves.toMatchObject({
      launchPhase: 'finished',
      members: {
        alice: {
          launchState: 'failed_to_start',
          hardFailure: true,
          hardFailureReason:
            'bootstrap owner pid 777 is gone and persisted bootstrap state is stale',
        },
      },
    });

    killSpy.mockRestore();
    nowSpy.mockRestore();
  });

  it('projects dead bootstrap owner into failed runtime progress', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1700000201000);
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation(() => {
        const error = new Error('ESRCH') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      });

    hoisted.files.set('/mock/teams/demo/bootstrap-state.json', {
      contents: JSON.stringify({
        version: 1,
        runId: 'run-dead',
        teamName: 'demo',
        ownerPid: 777,
        startedAt: 1700000000000,
        updatedAt: 1700000200000,
        phase: 'spawning_members',
        members: [{ name: 'alice', status: 'registered' }],
      }),
    });

    await expect(readBootstrapRuntimeState('demo')).resolves.toMatchObject({
      teamName: 'demo',
      isAlive: false,
      runId: 'run-dead',
      progress: {
        state: 'failed',
        message: 'Deterministic bootstrap owner exited before bootstrap completed',
        error:
          'bootstrap owner pid 777 is gone before bootstrap reached a terminal state',
      },
    });

    killSpy.mockRestore();
    nowSpy.mockRestore();
  });

  it('projects degraded runtime progress when bootstrap-state is unreadable but lock owner is alive', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as never);

    hoisted.files.set('/mock/teams/demo/bootstrap-state.json', {
      contents: '{invalid-json',
    });
    hoisted.files.set('/mock/teams/demo/.bootstrap.lock/metadata.json', {
      contents: JSON.stringify({
        pid: 4242,
        runId: 'run-lock',
        requestHash: 'hash-1',
        ownerStartedAt: 1700000000000,
        createdAt: 1700000000100,
        nonce: 'nonce-1',
      }),
    });
    hoisted.files.set('/mock/teams/demo/bootstrap-journal.jsonl', {
      contents: [
        JSON.stringify({
          ts: 2,
          type: 'phase',
          runId: 'run-lock',
          phase: 'spawning_members',
        }),
        JSON.stringify({
          ts: 3,
          type: 'member',
          runId: 'run-lock',
          name: 'alice',
          action: 'spawn_started',
        }),
      ].join('\n'),
    });

    await expect(readBootstrapRuntimeState('demo')).resolves.toMatchObject({
      teamName: 'demo',
      isAlive: false,
      runId: 'run-lock',
      progress: {
        state: 'assembling',
        message: 'Spawning teammate runtimes (degraded recovery)',
        messageSeverity: 'warning',
        pid: 4242,
        warnings: [
          'Persisted deterministic bootstrap state is unreadable because bootstrap-state.json is invalid, truncated, inaccessible, or changed while being read.',
          'Recent deterministic bootstrap events: bootstrap phase: spawning_members | alice: spawn_started',
        ],
      },
    });

    killSpy.mockRestore();
  });

  it('projects degraded failed runtime progress when bootstrap-state is unreadable and lock owner is dead', async () => {
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation(() => {
        const error = new Error('ESRCH') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      });

    hoisted.files.set('/mock/teams/demo/bootstrap-state.json', {
      contents: '{invalid-json',
    });
    hoisted.files.set('/mock/teams/demo/.bootstrap.lock/metadata.json', {
      contents: JSON.stringify({
        pid: 7331,
        runId: 'run-dead-lock',
        requestHash: 'hash-2',
        ownerStartedAt: 1700000000000,
        createdAt: 1700000000100,
        nonce: 'nonce-2',
      }),
    });

    await expect(readBootstrapRuntimeState('demo')).resolves.toMatchObject({
      teamName: 'demo',
      isAlive: false,
      runId: 'run-dead-lock',
      progress: {
        state: 'failed',
        message:
          'Deterministic bootstrap recovery failed because persisted bootstrap state is unreadable and the bootstrap owner is gone',
        messageSeverity: 'warning',
        pid: 7331,
      },
    });

    killSpy.mockRestore();
  });

  it('prefers the newer launch snapshot when bootstrap snapshot is stale', () => {
    const preferred = choosePreferredLaunchSnapshot(
      { updatedAt: '2026-04-06T10:00:00.000Z', kind: 'bootstrap' },
      { updatedAt: '2026-04-06T10:05:00.000Z', kind: 'launch' }
    );

    expect(preferred).toEqual({
      updatedAt: '2026-04-06T10:05:00.000Z',
      kind: 'launch',
    });
  });

  it('ignores stale terminal bootstrap-only pending snapshots when canonical launch state is missing', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-04-22T15:00:00.000Z'));

    const preferred = choosePreferredLaunchSnapshot(
      {
        version: 2,
        teamName: 'atlas-hq-2',
        updatedAt: '2026-04-09T20:35:57.962Z',
        launchPhase: 'finished',
        expectedMembers: ['alice', 'jack'],
        members: {
          alice: {
            name: 'alice',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            lastEvaluatedAt: '2026-04-09T20:35:57.962Z',
          },
          jack: {
            name: 'jack',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            lastEvaluatedAt: '2026-04-09T20:35:57.962Z',
          },
        },
        summary: {
          confirmedCount: 0,
          pendingCount: 2,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
        teamLaunchState: 'partial_pending',
      },
      null
    );

    expect(preferred).toBeNull();
    nowSpy.mockRestore();
  });

  it('prefers richer canonical launch snapshots when persisted members outgrow stale expectedMembers', () => {
    const preferred = choosePreferredLaunchSnapshot(
      {
        version: 2,
        teamName: 'demo',
        updatedAt: '2026-04-23T10:05:00.000Z',
        launchPhase: 'running',
        expectedMembers: ['alice', 'bob'],
        members: {
          alice: {
            name: 'alice',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
            lastEvaluatedAt: '2026-04-23T10:05:00.000Z',
          },
        },
        summary: {
          confirmedCount: 1,
          pendingCount: 1,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
        teamLaunchState: 'partial_pending',
      },
      {
        version: 2,
        teamName: 'demo',
        updatedAt: '2026-04-23T10:00:00.000Z',
        launchPhase: 'running',
        expectedMembers: ['alice'],
        members: {
          alice: {
            name: 'alice',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
            lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
            launchIdentity: {
              providerId: 'codex',
              providerBackendId: 'codex-native',
              source: 'codex-runtime',
            },
          },
          bob: {
            name: 'bob',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            lastEvaluatedAt: '2026-04-23T10:00:00.000Z',
            laneId: 'secondary:opencode:bob',
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
          },
        },
        summary: {
          confirmedCount: 1,
          pendingCount: 1,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
        teamLaunchState: 'partial_pending',
      }
    );

    expect(preferred).toMatchObject({
      updatedAt: '2026-04-23T10:00:00.000Z',
      members: {
        bob: {
          laneId: 'secondary:opencode:bob',
        },
      },
    });
  });
});
