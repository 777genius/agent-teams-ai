import { describe, expect, it } from 'vitest';

import { buildLiveTeamControlApiServices } from './openCodeLiveTestHarness';

import type { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';

describe('openCodeLiveTestHarness', () => {
  it('wires runtime-control callbacks into the live team control API services', () => {
    const svc = { service: 'team-provisioning' } as unknown as TeamProvisioningService;

    const services = buildLiveTeamControlApiServices(svc);

    expect(services.teamProvisioningStartApi).toBe(svc);
    expect(services.teamProvisioningStatusApi).toBe(svc);
    expect(services.teamRuntimeApi).toBe(svc);
    expect(services.teamRuntimeControlApi).toBe(svc);
  });

  it('keeps explicit harness service overrides available for tests', () => {
    const svc = { service: 'team-provisioning' } as unknown as TeamProvisioningService;
    const override = { service: 'runtime-control-override' } as unknown as TeamProvisioningService;

    const services = buildLiveTeamControlApiServices(svc, {
      teamRuntimeControlApi: override,
    });

    expect(services.teamRuntimeControlApi).toBe(override);
  });
});
