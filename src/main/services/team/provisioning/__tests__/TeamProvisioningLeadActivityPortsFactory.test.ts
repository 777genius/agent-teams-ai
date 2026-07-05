import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningLeadActivityPorts,
  type TeamProvisioningLeadActivityIntervalService,
} from '../TeamProvisioningLeadActivityPortsFactory';

import type { LeadActivityRunLike } from '../TeamProvisioningLeadActivity';

function createRun(overrides: Partial<LeadActivityRunLike> = {}): LeadActivityRunLike {
  return {
    teamName: 'team-a',
    runId: 'run-1',
    leadActivityState: 'idle',
    ...overrides,
  };
}

describe('TeamProvisioningLeadActivityPortsFactory', () => {
  it('wires lead activity ports to provisioning service dependencies', () => {
    const syncedRunKeys = new Set<string>();
    const run = createRun();
    const taskActivityIntervalService: TeamProvisioningLeadActivityIntervalService = {
      resumeActiveIntervalsForMember: vi.fn(() => ({ failed: false })),
      pauseActiveIntervalsForMember: vi.fn(() => ({ failed: true })),
    };
    const getRunLeadName = vi.fn(() => 'Lead');
    const isCurrentTrackedRun = vi.fn(() => true);
    const nowIso = vi.fn(() => '2026-07-03T00:00:00.000Z');
    const emitTeamChange = vi.fn();

    const ports = createTeamProvisioningLeadActivityPorts({
      syncedRunKeys,
      getRunLeadName,
      taskActivityIntervalService,
      isCurrentTrackedRun,
      nowIso,
      emitTeamChange,
    });

    expect(ports.syncedRunKeys).toBe(syncedRunKeys);
    expect(ports.getRunLeadName(run)).toBe('Lead');
    const at = ports.nowIso();
    expect(at).toBe('2026-07-03T00:00:00.000Z');
    expect(ports.resumeActiveIntervalsForMember('team-a', 'Lead', at)).toEqual({
      failed: false,
    });
    expect(ports.pauseActiveIntervalsForMember('team-a', 'Lead', at)).toEqual({
      failed: true,
    });
    expect(ports.isCurrentTrackedRun(run)).toBe(true);

    ports.emitTeamChange({
      type: 'lead-activity',
      teamName: 'team-a',
      runId: 'run-1',
      detail: 'active',
    });

    expect(getRunLeadName).toHaveBeenCalledWith(run);
    expect(taskActivityIntervalService.resumeActiveIntervalsForMember).toHaveBeenCalledWith(
      'team-a',
      'Lead',
      '2026-07-03T00:00:00.000Z'
    );
    expect(taskActivityIntervalService.pauseActiveIntervalsForMember).toHaveBeenCalledWith(
      'team-a',
      'Lead',
      '2026-07-03T00:00:00.000Z'
    );
    expect(isCurrentTrackedRun).toHaveBeenCalledWith(run);
    expect(emitTeamChange).toHaveBeenCalledWith({
      type: 'lead-activity',
      teamName: 'team-a',
      runId: 'run-1',
      detail: 'active',
    });
  });
});
