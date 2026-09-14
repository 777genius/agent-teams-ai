import { registerTeamRoutes } from '@main/http/teams';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false } }));

import type { HttpServices } from '@main/http';
import type { FastifyInstance } from 'fastify';

describe('POST /api/teams/:teamName/member-work-sync/:memberName/runtime-stop', () => {
  const stopAutoResume = vi.fn();
  let app: FastifyInstance | null = null;

  async function createApp(): Promise<FastifyInstance> {
    const created = Fastify();
    registerTeamRoutes(created, {
      memberWorkSyncFeature: { stopAutoResume },
    } as unknown as HttpServices);
    await created.ready();
    app = created;
    return created;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    stopAutoResume.mockResolvedValue({
      teamName: 'team-a',
      memberName: 'bob',
      runtimeAdmission: { state: 'pending' },
    });
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

  it('replays the same localStopId without a second Stop CAS', async () => {
    const created = await createApp();
    const payload = {
      localStopId: 'local-stop:runtime-1:3',
      runtimeInstanceId: 'runtime-1',
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
        runtimeAdmission: { state: 'pending' },
      },
      runtimeAdmission: { state: 'pending' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(stopAutoResume).toHaveBeenCalledTimes(1);
    expect(stopAutoResume).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'bob',
      reason: 'runtime_local_user_stop',
    });
  });
});
