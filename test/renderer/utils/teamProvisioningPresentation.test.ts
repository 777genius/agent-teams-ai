import { describe, expect, it } from 'vitest';

import { buildTeamProvisioningPresentation } from '@renderer/utils/teamProvisioningPresentation';

describe('buildTeamProvisioningPresentation', () => {
  it('uses a lead-online compact detail for ready teams without teammates', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-1',
        teamName: 'solo-team',
        state: 'ready',
        startedAt: '2026-04-13T10:00:00.000Z',
        updatedAt: '2026-04-13T10:00:05.000Z',
        message: 'Launch completed',
        messageSeverity: undefined,
        pid: 4321,
        cliLogsTail: '',
        assistantOutput: '',
      },
      members: [
        {
          name: 'team-lead',
        },
      ],
      memberSpawnStatuses: {},
      memberSpawnSnapshot: undefined,
    });

    expect(presentation?.compactTitle).toBe('Team launched');
    expect(presentation?.compactDetail).toBe('Lead online');
  });
});
