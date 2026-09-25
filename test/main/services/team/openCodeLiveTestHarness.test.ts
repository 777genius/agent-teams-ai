import { describe, expect, it } from 'vitest';

import { buildLiveTeamControlApiServices } from './openCodeLiveTestHarness';

import type { TeamApplicationHost } from '../../../../src/main/composition/team/TeamApplicationHost';
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
    getMemberSpawnStatuses: async () => ({ runId: 'run', statuses: {} }),
    getMemberSpawnStatusesReadOnly: async () => ({ runId: 'run', statuses: {} }),
    getTeamAgentRuntimeSnapshot: async () => null,
    getTeamAgentRuntimeSnapshotReadOnly: async () => null,
  } as unknown as TeamProvisioningService;
}

describe('openCodeLiveTestHarness', () => {
  it('wires runtime control callbacks into the live team control API services', () => {
    const svc = createServiceDouble();

    const services = buildLiveTeamControlApiServices(svc);

    expect(services.teamApplicationHost).toBeDefined();
    expect(services.teamMemberDiagnosticsApi?.getMemberSpawnStatusesReadOnly).toBeDefined();
    expect(services.teamMemberDiagnosticsApi?.getTeamAgentRuntimeSnapshotReadOnly).toBeDefined();
  });

  it('keeps explicit harness service overrides available for tests', () => {
    const svc = createServiceDouble();
    const override = {
      service: 'team-application-host-override',
    } as unknown as TeamApplicationHost;

    const services = buildLiveTeamControlApiServices(svc, {
      teamApplicationHost: override,
    });

    expect(services.teamApplicationHost).toBe(override);
  });
});
