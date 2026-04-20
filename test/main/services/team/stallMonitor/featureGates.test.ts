import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getTeamTaskStallActivationGraceMs,
  getTeamTaskStallScanIntervalMs,
  getTeamTaskStallStartupGraceMs,
  isTeamTaskStallAlertsEnabled,
  isTeamTaskStallMonitorEnabled,
} from '../../../../../src/main/services/team/stallMonitor/featureGates';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('stallMonitor feature gates', () => {
  it('defaults both monitor and alerts to disabled', () => {
    expect(isTeamTaskStallMonitorEnabled()).toBe(false);
    expect(isTeamTaskStallAlertsEnabled()).toBe(false);
    expect(getTeamTaskStallScanIntervalMs()).toBe(60_000);
    expect(getTeamTaskStallStartupGraceMs()).toBe(180_000);
    expect(getTeamTaskStallActivationGraceMs()).toBe(120_000);
  });

  it('parses truthy and falsy environment values', () => {
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_MONITOR_ENABLED', 'true');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ALERTS_ENABLED', 'off');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_SCAN_INTERVAL_MS', '1500');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_STARTUP_GRACE_MS', '2000');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ACTIVATION_GRACE_MS', '3000');

    expect(isTeamTaskStallMonitorEnabled()).toBe(true);
    expect(isTeamTaskStallAlertsEnabled()).toBe(false);
    expect(getTeamTaskStallScanIntervalMs()).toBe(1500);
    expect(getTeamTaskStallStartupGraceMs()).toBe(2000);
    expect(getTeamTaskStallActivationGraceMs()).toBe(3000);
  });
});
