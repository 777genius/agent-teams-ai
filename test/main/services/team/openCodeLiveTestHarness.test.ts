import { describe, expect, it } from 'vitest';

import { buildLiveTeamControlApiServices } from './openCodeLiveTestHarness';

import type { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';

function createServiceDouble(): TeamProvisioningService {
  const ack = async () => ({
    ok: true,
    providerId: 'opencode',
    teamName: 'team',
    runId: 'run',
    state: 'recorded',
    diagnostics: [],
    observedAt: '2026-01-01T00:00:00.000Z',
  });

  return {
    createTeam: async () => ({ runId: 'run' }),
    launchTeam: async () => ({ runId: 'run' }),
    getProvisioningStatus: async () => ({ runId: 'run', state: 'ready' }),
    repairStaleTaskActivityIntervalsBeforeSnapshot: async () => undefined,
    getRuntimeState: async () => ({
      teamName: 'team',
      isAlive: true,
      runId: 'run',
      progress: null,
    }),
    stopTeam: async () => undefined,
    getAliveTeams: () => ['team'],
    recordOpenCodeRuntimeBootstrapCheckin: ack,
    deliverOpenCodeRuntimeMessage: ack,
    recordOpenCodeRuntimeTaskEvent: ack,
    recordOpenCodeRuntimeHeartbeat: ack,
    answerOpenCodeRuntimePermission: ack,
  } as unknown as TeamProvisioningService;
}

describe('openCodeLiveTestHarness', () => {
  it('wires runtime-control callbacks into the live team control API services', () => {
    const svc = createServiceDouble();

    const services = buildLiveTeamControlApiServices(svc);

    expect(services.teamApis?.provisioningStart?.launchTeam).toBeDefined();
    expect(services.teamApis?.provisioningStatus?.getProvisioningStatus).toBeDefined();
    expect(services.teamApis?.runtime?.getRuntimeState).toBeDefined();
    expect(services.teamApis?.runtimeControl?.recordOpenCodeRuntimeHeartbeat).toBeDefined();
  });

  it('keeps explicit harness service overrides available for tests', () => {
    const svc = createServiceDouble();
    const override = { service: 'runtime-control-override' } as unknown as TeamProvisioningService;

    const services = buildLiveTeamControlApiServices(svc, {
      teamApis: {
        runtimeControl: override,
      },
    });

    expect(services.teamApis?.runtimeControl).toBe(override);
    expect(services.teamApis?.provisioningStart?.launchTeam).toBeDefined();
  });
});
