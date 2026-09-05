import {
  WORKSPACE_TRUST_LAUNCH_STATUS_ROUTE,
  WORKSPACE_TRUST_PROJECT_STATUS_ROUTE,
} from '@features/workspace-trust/contracts';
import { registerWorkspaceTrustHttp } from '@features/workspace-trust/main/adapters/input/registerWorkspaceTrustHttp';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceTrustStatusFeatureFacade } from '@features/workspace-trust/main';

describe('workspace trust HTTP transport', () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function harness() {
    const app = Fastify();
    apps.push(app);
    const feature: WorkspaceTrustStatusFeatureFacade = {
      getProjectStatus: vi.fn().mockResolvedValue({ status: 'trusted' }),
      getLaunchStatus: vi.fn().mockResolvedValue({
        providers: [
          { providerId: 'anthropic', status: 'trusted' },
          { providerId: 'codex', status: 'launch_scoped' },
        ],
      }),
    };
    registerWorkspaceTrustHttp(app, feature);
    return { app, feature };
  }

  it('returns the common facade result and delegates the unchanged request body', async () => {
    const { app, feature } = harness();
    const payload = { projectPath: '/work/repo', providerIds: ['anthropic', 'codex'] };
    const response = await app.inject({
      method: 'POST',
      url: WORKSPACE_TRUST_LAUNCH_STATUS_ROUTE,
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      providers: [
        { providerId: 'anthropic', status: 'trusted' },
        { providerId: 'codex', status: 'launch_scoped' },
      ],
    });
    expect(feature.getLaunchStatus).toHaveBeenCalledWith(payload);
  });

  it('preserves the legacy response and delegates validation to the facade', async () => {
    const { app, feature } = harness();
    const response = await app.inject({
      method: 'POST',
      url: WORKSPACE_TRUST_PROJECT_STATUS_ROUTE,
      payload: { projectPath: ' /work/repo ' },
    });
    expect(response.json()).toEqual({ status: 'trusted' });
    expect(feature.getProjectStatus).toHaveBeenCalledWith({ projectPath: ' /work/repo ' });
    await app.inject({
      method: 'POST',
      url: WORKSPACE_TRUST_LAUNCH_STATUS_ROUTE,
      payload: { providerIds: 'invalid' },
    });
    expect(feature.getLaunchStatus).toHaveBeenCalledWith({ providerIds: 'invalid' });
  });

  it('returns bounded errors without config paths or internal messages', async () => {
    const { app, feature } = harness();
    vi.mocked(feature.getLaunchStatus).mockRejectedValue(new Error('/secret/config parse failure'));
    vi.mocked(feature.getProjectStatus).mockRejectedValue(
      new Error('/secret/config parse failure')
    );
    const launch = await app.inject({
      method: 'POST',
      url: WORKSPACE_TRUST_LAUNCH_STATUS_ROUTE,
      payload: {},
    });
    expect(launch.statusCode).toBe(503);
    expect(launch.json()).toEqual({ error: 'Workspace trust status unavailable' });
    const legacy = await app.inject({
      method: 'POST',
      url: WORKSPACE_TRUST_PROJECT_STATUS_ROUTE,
      payload: {},
    });
    expect(legacy.json()).toEqual({ status: 'unknown' });
  });

  it('rejects workspace trust inspection from a non-loopback client', async () => {
    const { app, feature } = harness();
    const response = await app.inject({
      method: 'POST',
      url: WORKSPACE_TRUST_LAUNCH_STATUS_ROUTE,
      remoteAddress: '203.0.113.10',
      payload: { projectPath: '/work/repo', providerIds: ['anthropic'] },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Workspace trust status unavailable' });
    expect(feature.getLaunchStatus).not.toHaveBeenCalled();
  });
});
