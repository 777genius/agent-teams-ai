import { memberWorkSyncRuntimeDelivery } from '@features/member-work-sync/main/composition';
import { registerTeamRoutes } from '@main/http/teams';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false } }));
vi.mock('@features/member-work-sync/main/composition', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@features/member-work-sync/main/composition')>();
  return {
    ...actual,
    memberWorkSyncRuntimeDelivery: {
      ...actual.memberWorkSyncRuntimeDelivery,
      readCurrentNativeRuntimeInstanceId: vi.fn().mockResolvedValue(null),
    },
  };
});

import type { HttpServices } from '@main/http';
import type { FastifyInstance } from 'fastify';

describe('POST /api/teams/:teamName/member-work-sync/:memberName/runtime-stop', () => {
  const stopAutoResume = vi.fn();
  const getStatus = vi.fn();
  let app: FastifyInstance | null = null;

  function status(memberName = 'bob', incarnation = 'incarnation-1') {
    return {
      teamName: 'team-a',
      memberName,
      statusRevision: { incarnation },
      runtimeAdmission: { state: 'pending' },
    };
  }

  async function createApp(): Promise<FastifyInstance> {
    const created = Fastify();
    registerTeamRoutes(created, {
      memberWorkSyncFeature: { getStatus, stopAutoResume },
    } as unknown as HttpServices);
    await created.ready();
    app = created;
    return created;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(memberWorkSyncRuntimeDelivery.readCurrentNativeRuntimeInstanceId).mockResolvedValue(
      'runtime-1'
    );
    getStatus.mockImplementation(({ memberName }) => Promise.resolve(status(memberName)));
    stopAutoResume.mockImplementation(({ memberName }) => Promise.resolve(status(memberName)));
  });

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('requires localStopId', async () => {
    const created = await createApp();
    const response = await created.inject({
      method: 'POST',
      url: '/api/teams/team-a/member-work-sync/bob/runtime-stop',
      payload: { reason: 'runtime_local_stop' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'localStopId is required' });
    expect(stopAutoResume).not.toHaveBeenCalled();
  });

  it('delegates sequential replay identity to the durable domain record', async () => {
    const created = await createApp();
    const payload = {
      localStopId: 'local-stop:runtime-1:3',
      runtimeInstanceId: 'runtime-1',
      incarnation: 'incarnation-1',
      reason: 'runtime_local_user_stop',
    };
    const first = await created.inject({
      method: 'POST',
      url: '/api/teams/team-a/member-work-sync/bob/runtime-stop',
      payload,
    });
    const second = await created.inject({
      method: 'POST',
      url: '/api/teams/team-a/member-work-sync/bob/runtime-stop',
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      ok: true,
      status: {
        teamName: 'team-a',
        memberName: 'bob',
        statusRevision: { incarnation: 'incarnation-1' },
        runtimeAdmission: { state: 'pending' },
      },
      runtimeAdmission: { state: 'pending' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(stopAutoResume).toHaveBeenCalledTimes(2);
    expect(stopAutoResume).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'bob',
      reason: 'runtime_local_user_stop',
      expectedIncarnation: 'incarnation-1',
      expectedRuntimeInstanceId: 'runtime-1',
      localStopId: 'local-stop:runtime-1:3',
    });
  });

  it('requires runtimeInstanceId', async () => {
    const created = await createApp();
    const response = await created.inject({
      method: 'POST',
      url: '/api/teams/team-a/member-work-sync/bob/runtime-stop',
      payload: { localStopId: 'local-stop:runtime-1:3', reason: 'runtime_local_user_stop' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'runtimeInstanceId is required' });
    expect(stopAutoResume).not.toHaveBeenCalled();
  });

  it('requires incarnation', async () => {
    const created = await createApp();
    const response = await created.inject({
      method: 'POST',
      url: '/api/teams/team-a/member-work-sync/bob/runtime-stop',
      payload: {
        localStopId: 'local-stop:runtime-1:3',
        runtimeInstanceId: 'runtime-1',
        reason: 'runtime_local_user_stop',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'incarnation is required' });
    expect(stopAutoResume).not.toHaveBeenCalled();
  });

  it.each([
    { length: 256, statusCode: 200, accepted: true },
    { length: 257, statusCode: 400, accepted: false },
  ])(
    'enforces the $length-character reason boundary before the Stop mutation',
    async ({ length, statusCode, accepted }) => {
      const created = await createApp();
      const reason = 'r'.repeat(length);
      const response = await created.inject({
        method: 'POST',
        url: '/api/teams/team-a/member-work-sync/bob/runtime-stop',
        payload: {
          localStopId: 'local-stop:runtime-1:reason-boundary',
          runtimeInstanceId: 'runtime-1',
          incarnation: 'incarnation-1',
          reason,
        },
      });

      expect(response.statusCode).toBe(statusCode);
      if (accepted) {
        expect(stopAutoResume).toHaveBeenCalledWith(expect.objectContaining({ reason }));
      } else {
        expect(response.json()).toEqual({ error: 'reason is too long' });
        expect(
          memberWorkSyncRuntimeDelivery.readCurrentNativeRuntimeInstanceId
        ).not.toHaveBeenCalled();
        expect(getStatus).not.toHaveBeenCalled();
        expect(stopAutoResume).not.toHaveBeenCalled();
      }
    }
  );

  it.each([
    ['a trailing character beyond the boundary', `${'r'.repeat(256)} `],
    ['an oversized whitespace-only value', ' '.repeat(257)],
  ])('rejects %s before HTTP status reads', async (_label, reason) => {
    const created = await createApp();
    const response = await created.inject({
      method: 'POST',
      url: '/api/teams/team-a/member-work-sync/bob/runtime-stop',
      payload: {
        localStopId: 'local-stop:runtime-1:reason-whitespace-boundary',
        runtimeInstanceId: 'runtime-1',
        incarnation: 'incarnation-1',
        reason,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'reason is too long' });
    expect(memberWorkSyncRuntimeDelivery.readCurrentNativeRuntimeInstanceId).not.toHaveBeenCalled();
    expect(getStatus).not.toHaveBeenCalled();
    expect(stopAutoResume).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '   '])(
    'keeps the HTTP Stop default for absent or empty reason %#',
    async (reason) => {
      const created = await createApp();
      const response = await created.inject({
        method: 'POST',
        url: '/api/teams/team-a/member-work-sync/bob/runtime-stop',
        payload: {
          localStopId: 'local-stop:runtime-1:reason-default',
          runtimeInstanceId: 'runtime-1',
          incarnation: 'incarnation-1',
          ...(reason === undefined ? {} : { reason }),
        },
      });

      expect(response.statusCode).toBe(200);
      expect(stopAutoResume).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'runtime_local_stop' })
      );
    }
  );

  it('fails closed when the current runtime identity is missing', async () => {
    vi.mocked(
      memberWorkSyncRuntimeDelivery.readCurrentNativeRuntimeInstanceId
    ).mockResolvedValueOnce(null);
    const created = await createApp();
    const response = await created.inject({
      method: 'POST',
      url: '/api/teams/team-a/member-work-sync/bob/runtime-stop',
      payload: {
        localStopId: 'local-stop:runtime-1:3',
        runtimeInstanceId: 'runtime-1',
        incarnation: 'incarnation-1',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'runtime_identity_unavailable' });
    expect(getStatus).not.toHaveBeenCalled();
    expect(stopAutoResume).not.toHaveBeenCalled();
  });

  it('fails closed when the current runtime identity cannot be read', async () => {
    vi.mocked(
      memberWorkSyncRuntimeDelivery.readCurrentNativeRuntimeInstanceId
    ).mockRejectedValueOnce(new Error('unreadable'));
    const created = await createApp();
    const response = await created.inject({
      method: 'POST',
      url: '/api/teams/team-a/member-work-sync/bob/runtime-stop',
      payload: {
        localStopId: 'local-stop:runtime-1:3',
        runtimeInstanceId: 'runtime-1',
        incarnation: 'incarnation-1',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'runtime_identity_unavailable' });
    expect(stopAutoResume).not.toHaveBeenCalled();
  });

  it('rejects a stale runtimeInstanceId before persisting Stop', async () => {
    vi.mocked(
      memberWorkSyncRuntimeDelivery.readCurrentNativeRuntimeInstanceId
    ).mockResolvedValueOnce('runtime-live');
    const created = await createApp();
    const response = await created.inject({
      method: 'POST',
      url: '/api/teams/team-a/member-work-sync/bob/runtime-stop',
      payload: {
        localStopId: 'local-stop:runtime-old:3',
        runtimeInstanceId: 'runtime-old',
        incarnation: 'incarnation-1',
        reason: 'runtime_local_user_stop',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'stale_runtime_instance' });
    expect(stopAutoResume).not.toHaveBeenCalled();
  });

  it('rejects a stale incarnation before persisting Stop', async () => {
    getStatus.mockResolvedValueOnce(status('bob', 'incarnation-live'));
    const created = await createApp();
    const response = await created.inject({
      method: 'POST',
      url: '/api/teams/team-a/member-work-sync/bob/runtime-stop',
      payload: {
        localStopId: 'local-stop:runtime-1:3',
        runtimeInstanceId: 'runtime-1',
        incarnation: 'incarnation-old',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'stale_runtime_incarnation' });
    expect(stopAutoResume).not.toHaveBeenCalled();
  });

  it('rejects recreation between route validation and the domain mutation', async () => {
    getStatus.mockResolvedValueOnce(status('bob', 'incarnation-a'));
    stopAutoResume.mockImplementationOnce(async ({ expectedIncarnation }) => {
      expect(expectedIncarnation).toBe('incarnation-a');
      const error = new Error('stale_runtime_incarnation');
      error.name = 'MemberWorkSyncStaleIncarnationError';
      throw error;
    });
    const created = await createApp();
    const response = await created.inject({
      method: 'POST',
      url: '/api/teams/team-a/member-work-sync/bob/runtime-stop',
      payload: {
        localStopId: 'local-stop:runtime-1:race',
        runtimeInstanceId: 'runtime-1',
        incarnation: 'incarnation-a',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'stale_runtime_incarnation' });
    expect(stopAutoResume).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent retries before running the Stop mutation', async () => {
    let releaseStop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    stopAutoResume.mockImplementationOnce(async () => {
      await stopped;
      return status();
    });
    const created = await createApp();
    const request = {
      method: 'POST' as const,
      url: '/api/teams/team-a/member-work-sync/bob/runtime-stop',
      payload: {
        localStopId: 'local-stop:concurrent',
        runtimeInstanceId: 'runtime-1',
        incarnation: 'incarnation-1',
      },
    };
    const first = created.inject(request);
    const second = created.inject(request);
    await vi.waitFor(() => expect(stopAutoResume).toHaveBeenCalledTimes(1));
    releaseStop();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.json()).toEqual(firstResponse.json());
    expect(stopAutoResume).toHaveBeenCalledTimes(1);
  });

  it('isolates the same localStopId across member targets', async () => {
    const created = await createApp();
    const payload = {
      localStopId: 'local-stop:shared',
      runtimeInstanceId: 'runtime-1',
      incarnation: 'incarnation-1',
    };
    const [bob, alice] = await Promise.all([
      created.inject({
        method: 'POST',
        url: '/api/teams/team-a/member-work-sync/bob/runtime-stop',
        payload,
      }),
      created.inject({
        method: 'POST',
        url: '/api/teams/team-a/member-work-sync/alice/runtime-stop',
        payload,
      }),
    ]);
    expect(bob.statusCode).toBe(200);
    expect(alice.statusCode).toBe(200);
    expect(bob.json().status.memberName).toBe('bob');
    expect(alice.json().status.memberName).toBe('alice');
    expect(stopAutoResume).toHaveBeenCalledTimes(2);
  });

  it('delegates replay to the durable domain record after route state is lost', async () => {
    const firstApp = await createApp();
    const request = {
      method: 'POST' as const,
      url: '/api/teams/team-a/member-work-sync/bob/runtime-stop',
      payload: {
        localStopId: 'local-stop:restart',
        runtimeInstanceId: 'runtime-1',
        incarnation: 'incarnation-1',
      },
    };
    expect((await firstApp.inject(request)).statusCode).toBe(200);
    await firstApp.close();
    app = null;
    getStatus.mockResolvedValue({
      ...status(),
      recoveryHealth: { autoResumeStopLatch: { controlRevision: 1 } },
    });
    const restartedApp = await createApp();
    expect((await restartedApp.inject(request)).statusCode).toBe(200);
    expect(stopAutoResume).toHaveBeenCalledTimes(2);
  });
});
