import { registerTeamRoutes } from '@main/http/teams';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const killRetainedOpenCodeRuntimeProcessesForTeam = vi.hoisted(() =>
  vi.fn(() =>
    Promise.resolve({ killedPids: [4242], diagnostics: ['Killed persisted runtime pid=4242'] })
  )
);
const clearPendingOpenCodePromptDeliveriesForTeam = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ cleared: 0, diagnostics: [] }))
);

vi.mock('@main/services/team/lifecycle/teamForceStopFlow', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@main/services/team/lifecycle/teamForceStopFlow')>();
  return {
    ...actual,
    killRetainedOpenCodeRuntimeProcessesForTeam,
    clearPendingOpenCodePromptDeliveriesForTeam,
  };
});

vi.mock('@main/services/team/TeamLaunchStateStore', () => ({
  TeamLaunchStateStore: vi.fn(() => ({ read: vi.fn(() => Promise.resolve(null)) })),
}));

import type { HttpServices } from '@main/http';
import type { FastifyInstance } from 'fastify';

describe('POST /api/teams/:teamName/force-stop', () => {
  const stopTeam = vi.fn<(teamName: string) => Promise<void>>(() => Promise.resolve());
  const getAliveTeams = vi.fn<() => string[]>(() => ['fixteam']);
  let app: FastifyInstance | null = null;

  async function createApp(): Promise<FastifyInstance> {
    const created = Fastify();
    const services = {
      teamApis: { runtime: { stopTeam, getAliveTeams, getRuntimeState: vi.fn() } },
    } as unknown as HttpServices;
    registerTeamRoutes(created, services);
    await created.ready();
    app = created;
    return created;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    stopTeam.mockResolvedValue(undefined);
    getAliveTeams.mockReturnValue(['fixteam']);
  });

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('reports the cleanup after a regular stop that confirmed', async () => {
    const created = await createApp();

    const response = await created.inject({
      method: 'POST',
      url: '/api/teams/fixteam/force-stop',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      stopOutcome: 'stopped',
      cleanupOutcome: 'completed',
      killedRuntimePids: [],
      clearedPendingDeliveries: 0,
    });
    expect(stopTeam).toHaveBeenCalledWith('fixteam');
  });

  it('still answers 200 with stop_failed when the regular stop throws', async () => {
    stopTeam.mockRejectedValue(new Error('did not confirm stop; retaining runtime ownership'));
    // The failing stop is reported through the route logger; the test owns that
    // channel here so the shared console guard does not read it as a leak.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const created = await createApp();

    const response = await created.inject({
      method: 'POST',
      url: '/api/teams/fixteam/force-stop',
    });

    expect(warn.mock.calls.map((call) => call.map(String).join(' ')).join('\n')).toContain(
      'Regular stop failed before force stop cleanup'
    );
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      stopOutcome: string;
      killedRuntimePids: number[];
      diagnostics: string[];
    }>();
    expect(body.stopOutcome).toBe('stop_failed');
    expect(body.killedRuntimePids).toEqual([4242]);
    expect(body.diagnostics.join('\n')).toContain('did not confirm stop');
    // The failed stop must not stop the cleanup from running.
    expect(killRetainedOpenCodeRuntimeProcessesForTeam).toHaveBeenCalledTimes(1);
    expect(clearPendingOpenCodePromptDeliveriesForTeam).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid team name before touching the runtime', async () => {
    const created = await createApp();

    const response = await created.inject({
      method: 'POST',
      url: '/api/teams/..%2Fescape/force-stop',
    });

    expect(response.statusCode).toBe(400);
    expect(stopTeam).not.toHaveBeenCalled();
    expect(killRetainedOpenCodeRuntimeProcessesForTeam).not.toHaveBeenCalled();
  });

  it('answers 501 when the runtime control API is not available in this mode', async () => {
    const created = Fastify();
    registerTeamRoutes(created, {} as unknown as HttpServices);
    await created.ready();
    app = created;

    const response = await created.inject({
      method: 'POST',
      url: '/api/teams/fixteam/force-stop',
    });

    expect(response.statusCode).toBe(501);
    expect(killRetainedOpenCodeRuntimeProcessesForTeam).not.toHaveBeenCalled();
  });
});
