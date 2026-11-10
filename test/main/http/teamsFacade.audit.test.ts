import { registerTeamRoutes } from '@main/http/teams';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HttpServices } from '@main/http';

describe('teams HTTP facade audit', () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('rejects malformed member names before publishing member-work-sync requests', async () => {
    const app = Fastify();
    apps.push(app);
    const getStatus = vi.fn();
    const refreshStatus = vi.fn();
    const report = vi.fn();
    registerTeamRoutes(app, {
      memberWorkSyncFeature: {
        getStatus,
        refreshStatus,
        report,
      },
    } as unknown as HttpServices);
    await app.ready();

    const statusResponse = await app.inject({
      method: 'GET',
      url: '/api/teams/demo-team/member-work-sync/bad%20member',
    });
    const refreshResponse = await app.inject({
      method: 'POST',
      url: '/api/teams/demo-team/member-work-sync/bad%20member/refresh',
    });
    const reportResponse = await app.inject({
      method: 'POST',
      url: '/api/teams/demo-team/member-work-sync/report',
      payload: {
        memberName: '../ghost',
        state: 'still_working',
        agendaFingerprint: 'agenda:v1:test',
      },
    });

    for (const response of [statusResponse, refreshResponse, reportResponse]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'member contains invalid characters' });
    }
    expect(getStatus).not.toHaveBeenCalled();
    expect(refreshStatus).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });
});
