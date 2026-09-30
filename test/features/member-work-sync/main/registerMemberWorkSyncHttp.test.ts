import {
  type MemberWorkSyncFeatureFacade,
  type MemberWorkSyncHttpHostPorts,
} from '@features/member-work-sync/main';
import { registerMemberWorkSyncHttp } from '@main/composition/team/registerMemberWorkSyncHttp';
import { validateMemberName, validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { FastifyInstance } from 'fastify';

const FIXED_NOW = new Date('2026-07-28T12:34:56.789Z');

function createFacadeMock() {
  const getStatus = vi.fn();
  const refreshStatus = vi.fn();
  const getMetrics = vi.fn();
  const report = vi.fn();
  const getQueueDiagnostics = vi.fn();
  const facade = {
    getStatus,
    refreshStatus,
    getMetrics,
    report,
    getQueueDiagnostics,
  } as unknown as MemberWorkSyncFeatureFacade;
  return {
    facade,
    getStatus,
    refreshStatus,
    getMetrics,
    report,
    getQueueDiagnostics,
  };
}

function createHostPorts(): MemberWorkSyncHttpHostPorts & {
  logger: { error: ReturnType<typeof vi.fn> };
  unexpectedErrors: { map: ReturnType<typeof vi.fn> };
} {
  return {
    identifiers: {
      validateTeamName,
      validateMemberName,
    },
    clock: {
      now: () => FIXED_NOW,
    },
    logger: {
      error: vi.fn(),
    },
    unexpectedErrors: {
      map: vi.fn((error: unknown) => ({
        statusCode: 500,
        responseMessage: 'Internal server error',
        shouldLog: true,
        logMessage: error instanceof Error ? error.message : String(error),
      })),
    },
  };
}

async function createApp(input?: {
  facade?: MemberWorkSyncFeatureFacade;
  ports?: MemberWorkSyncHttpHostPorts;
}) {
  const app = Fastify();
  const mocks = createFacadeMock();
  const ports = input?.ports ?? createHostPorts();
  registerMemberWorkSyncHttp(
    app,
    Object.prototype.hasOwnProperty.call(input ?? {}, 'facade') ? input?.facade : mocks.facade,
    ports
  );
  await app.ready();
  return { app, ports, ...mocks };
}

describe('registerMemberWorkSyncHttp', () => {
  it('registers all five routes in their legacy order with static reads before member status', () => {
    const registrations: string[] = [];
    const app = {
      get: vi.fn((url: string) => {
        registrations.push(`GET ${url}`);
      }),
      post: vi.fn((url: string) => {
        registrations.push(`POST ${url}`);
      }),
    } as unknown as FastifyInstance;

    registerMemberWorkSyncHttp(app, createFacadeMock().facade, createHostPorts());

    expect(registrations).toEqual([
      'GET /api/teams/:teamName/member-work-sync/diagnostics',
      'GET /api/teams/:teamName/member-work-sync/metrics',
      'GET /api/teams/:teamName/member-work-sync/:memberName',
      'POST /api/teams/:teamName/member-work-sync/:memberName/refresh',
      'POST /api/teams/:teamName/member-work-sync/report',
    ]);
  });

  it('preserves diagnostics, metrics, queue diagnostics, and clock-generated timestamps', async () => {
    const { app, getMetrics, getQueueDiagnostics, getStatus } = await createApp();
    const metrics = { marker: 'metrics' };
    const queue = { queued: 2, running: 1, marker: 'queue' };
    getMetrics.mockResolvedValue(metrics);
    getQueueDiagnostics.mockReturnValue(queue);

    try {
      const diagnosticsResponse = await app.inject({
        method: 'GET',
        url: '/api/teams/demo-team/member-work-sync/diagnostics',
      });
      expect(diagnosticsResponse.statusCode).toBe(200);
      expect(diagnosticsResponse.json()).toEqual({
        teamName: 'demo-team',
        generatedAt: FIXED_NOW.toISOString(),
        queue,
        metrics,
      });
      expect(getMetrics).toHaveBeenNthCalledWith(1, { teamName: 'demo-team' });
      expect(getQueueDiagnostics).toHaveBeenCalledTimes(1);

      const metricsResponse = await app.inject({
        method: 'GET',
        url: '/api/teams/demo-team/member-work-sync/metrics',
      });
      expect(metricsResponse.statusCode).toBe(200);
      expect(metricsResponse.json()).toEqual(metrics);
      expect(getMetrics).toHaveBeenNthCalledWith(2, { teamName: 'demo-team' });
      expect(getStatus).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('normalizes member status and refresh requests without forwarding false forceNudge', async () => {
    const { app, getStatus, refreshStatus } = await createApp();
    const status = { teamName: 'demo-team', memberName: 'bob' };
    getStatus.mockResolvedValue(status);
    refreshStatus.mockResolvedValue(status);

    try {
      const statusResponse = await app.inject({
        method: 'GET',
        url: '/api/teams/demo-team/member-work-sync/%20bob%20',
      });
      expect(statusResponse.statusCode).toBe(200);
      expect(statusResponse.json()).toEqual(status);
      expect(getStatus).toHaveBeenCalledWith({
        teamName: 'demo-team',
        memberName: 'bob',
      });

      const defaultRefreshResponse = await app.inject({
        method: 'POST',
        url: '/api/teams/demo-team/member-work-sync/bob/refresh',
        payload: { forceNudge: false },
      });
      expect(defaultRefreshResponse.statusCode).toBe(200);
      expect(refreshStatus).toHaveBeenNthCalledWith(1, {
        teamName: 'demo-team',
        memberName: 'bob',
      });

      const forcedRefreshResponse = await app.inject({
        method: 'POST',
        url: '/api/teams/demo-team/member-work-sync/bob/refresh',
        payload: { forceNudge: true },
      });
      expect(forcedRefreshResponse.statusCode).toBe(200);
      expect(refreshStatus).toHaveBeenNthCalledWith(2, {
        teamName: 'demo-team',
        memberName: 'bob',
        forceNudge: true,
      });
    } finally {
      await app.close();
    }
  });

  it('trims and dedupes report taskIds, preserves optional fields, and forces source mcp', async () => {
    const { app, report } = await createApp();
    report.mockResolvedValue({ accepted: true });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams/demo-team/member-work-sync/report',
        payload: {
          teamName: ' demo-team ',
          memberName: ' bob ',
          state: ' still_working ',
          agendaFingerprint: ' agenda:v1:abc ',
          reportToken: '',
          taskIds: [' task-a ', 42, '', 'task-a', 'task-b'],
          note: ' keep spacing ',
          reportedAt: '2026-07-28T12:30:00.000Z',
          leaseTtlMs: 30_000,
          source: 'app',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ accepted: true });
      expect(report).toHaveBeenCalledWith({
        teamName: 'demo-team',
        memberName: 'bob',
        state: 'still_working',
        agendaFingerprint: 'agenda:v1:abc',
        reportToken: '',
        taskIds: ['task-a', 'task-b'],
        note: ' keep spacing ',
        reportedAt: '2026-07-28T12:30:00.000Z',
        leaseTtlMs: 30_000,
        source: 'mcp',
      });
    } finally {
      await app.close();
    }
  });

  it('omits absent, invalid, and empty optional report fields', async () => {
    const { app, report } = await createApp();
    report.mockResolvedValue({ accepted: true });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams/demo-team/member-work-sync/report',
        payload: {
          memberName: 'bob',
          state: 'caught_up',
          agendaFingerprint: 'empty',
          reportToken: null,
          taskIds: [' ', 42],
          note: 42,
          reportedAt: false,
          leaseTtlMs: '30000',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(report).toHaveBeenCalledWith({
        teamName: 'demo-team',
        memberName: 'bob',
        state: 'caught_up',
        agendaFingerprint: 'empty',
        source: 'mcp',
      });
    } finally {
      await app.close();
    }
  });

  it('rejects invalid route identifiers and malformed decoded members before facade calls', async () => {
    const { app, getStatus, refreshStatus, getMetrics, report } = await createApp();

    try {
      const cases = [
        {
          method: 'GET' as const,
          url: '/api/teams/INVALID/member-work-sync/metrics',
          error: 'teamName contains invalid characters',
        },
        {
          method: 'GET' as const,
          url: '/api/teams/demo-team/member-work-sync/bob%20smith',
          error: 'member contains invalid characters',
        },
        {
          method: 'POST' as const,
          url: '/api/teams/demo-team/member-work-sync/report',
          payload: {
            teamName: 'other-team',
            memberName: 'bob',
            state: 'caught_up',
            agendaFingerprint: 'empty',
          },
          error: 'runtime body teamName must match route teamName',
        },
        {
          method: 'POST' as const,
          url: '/api/teams/demo-team/member-work-sync/report',
          payload: {
            memberName: 'bob',
          },
          error: 'memberName, state, and agendaFingerprint are required',
        },
        {
          method: 'POST' as const,
          url: '/api/teams/demo-team/member-work-sync/report',
          payload: {
            memberName: 'bob',
            state: 'unknown',
            agendaFingerprint: 'empty',
          },
          error: 'state must be still_working, blocked, or caught_up',
        },
      ];

      for (const testCase of cases) {
        const response = await app.inject(testCase);
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: testCase.error });
      }
      expect(getStatus).not.toHaveBeenCalled();
      expect(refreshStatus).not.toHaveBeenCalled();
      expect(getMetrics).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects unavailable feature calls as 400 without treating them as unexpected errors', async () => {
    const ports = createHostPorts();
    const { app } = await createApp({ facade: undefined, ports });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/teams/demo-team/member-work-sync/metrics',
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'Member work sync feature is unavailable' });
      expect(ports.unexpectedErrors.map).not.toHaveBeenCalled();
      expect(ports.logger.error).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('uses host error mapping and logging while masking unexpected facade failures', async () => {
    const ports = createHostPorts();
    const { app, getStatus } = await createApp({ ports });
    const failure = new Error('private member work sync storage diagnostic');
    getStatus.mockRejectedValue(failure);

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/teams/demo-team/member-work-sync/bob',
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: 'Internal server error' });
      expect(response.body).not.toContain('private member work sync storage diagnostic');
      expect(ports.unexpectedErrors.map).toHaveBeenCalledWith(failure);
      expect(ports.logger.error).toHaveBeenCalledWith(
        'Error in GET /api/teams/demo-team/member-work-sync/bob:',
        'private member work sync storage diagnostic'
      );
    } finally {
      await app.close();
    }
  });
});
