import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getOpenCodeWeakStartStallThresholdMs,
  getPendingPickupStallThresholdMs,
  getTeamTaskStallActivationGraceMs,
  getTeamTaskStallScanIntervalMs,
  getTeamTaskStallStartupGraceMs,
  isOpenCodeTaskStallRemediationEnabled,
  isPendingPickupStallRemediationEnabled,
  isTeamTaskStallAlertsEnabled,
  isTeamTaskStallMonitorEnabled,
  isTeamTaskStallScannerEnabled,
} from '../../../../../src/main/services/team/stallMonitor/featureGates';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('stallMonitor feature gates', () => {
  it('defaults general monitor, OpenCode remediation, scanner, and alerts to enabled', () => {
    expect(isTeamTaskStallMonitorEnabled()).toBe(true);
    expect(isOpenCodeTaskStallRemediationEnabled()).toBe(true);
    expect(isTeamTaskStallScannerEnabled()).toBe(true);
    expect(isTeamTaskStallAlertsEnabled()).toBe(true);
    expect(getTeamTaskStallScanIntervalMs()).toBe(30_000);
    expect(getTeamTaskStallStartupGraceMs()).toBe(180_000);
    expect(getTeamTaskStallActivationGraceMs()).toBe(60_000);
    expect(getOpenCodeWeakStartStallThresholdMs()).toBe(300_000);
    expect(getPendingPickupStallThresholdMs()).toBe(300_000);
    expect(isPendingPickupStallRemediationEnabled()).toBe(true);
  });

  it('reads the pending pickup gates from the environment', () => {
    vi.stubEnv('CLAUDE_TEAM_PENDING_PICKUP_STALL_THRESHOLD_MS', '120000');
    vi.stubEnv('CLAUDE_TEAM_PENDING_PICKUP_STALL_REMEDIATION_ENABLED', '0');

    expect(getPendingPickupStallThresholdMs()).toBe(120_000);
    expect(isPendingPickupStallRemediationEnabled()).toBe(false);
  });

  it.each(['0', '-1', 'soon', ''])(
    'keeps the default pending pickup threshold for the invalid value %j',
    (value) => {
      vi.stubEnv('CLAUDE_TEAM_PENDING_PICKUP_STALL_THRESHOLD_MS', value);

      expect(getPendingPickupStallThresholdMs()).toBe(300_000);
    }
  );

  it('scopes the pickup gate to the pickup branch alone', () => {
    vi.stubEnv('CLAUDE_TEAM_PENDING_PICKUP_STALL_REMEDIATION_ENABLED', '0');

    expect(isPendingPickupStallRemediationEnabled()).toBe(false);
    // Everything the other stall branches read is untouched: the pickup flag is
    // not a master switch for the monitor.
    expect(isTeamTaskStallMonitorEnabled()).toBe(true);
    expect(isOpenCodeTaskStallRemediationEnabled()).toBe(true);
    expect(isTeamTaskStallScannerEnabled()).toBe(true);
    expect(isTeamTaskStallAlertsEnabled()).toBe(true);
    expect(getOpenCodeWeakStartStallThresholdMs()).toBe(300_000);
  });

  it('keeps pending pickup remediation enabled for an unparseable flag', () => {
    vi.stubEnv('CLAUDE_TEAM_PENDING_PICKUP_STALL_REMEDIATION_ENABLED', 'maybe');

    expect(isPendingPickupStallRemediationEnabled()).toBe(true);
  });

  it('parses truthy and falsy environment values', () => {
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_MONITOR_ENABLED', 'true');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ALERTS_ENABLED', 'off');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_SCAN_INTERVAL_MS', '1500');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_STARTUP_GRACE_MS', '2000');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ACTIVATION_GRACE_MS', '3000');
    vi.stubEnv('CLAUDE_TEAM_OPENCODE_TASK_STALL_REMEDIATION_ENABLED', 'yes');
    vi.stubEnv('CLAUDE_TEAM_OPENCODE_WEAK_START_STALL_THRESHOLD_MS', '4000');

    expect(isTeamTaskStallMonitorEnabled()).toBe(true);
    expect(isOpenCodeTaskStallRemediationEnabled()).toBe(true);
    expect(isTeamTaskStallScannerEnabled()).toBe(true);
    expect(isTeamTaskStallAlertsEnabled()).toBe(false);
    expect(getTeamTaskStallScanIntervalMs()).toBe(1500);
    expect(getTeamTaskStallStartupGraceMs()).toBe(2000);
    expect(getTeamTaskStallActivationGraceMs()).toBe(3000);
    expect(getOpenCodeWeakStartStallThresholdMs()).toBe(4000);
  });

  it('enables the scanner when only OpenCode remediation is enabled', () => {
    vi.stubEnv('CLAUDE_TEAM_OPENCODE_TASK_STALL_REMEDIATION_ENABLED', 'true');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_MONITOR_ENABLED', 'false');

    expect(isTeamTaskStallMonitorEnabled()).toBe(false);
    expect(isTeamTaskStallScannerEnabled()).toBe(true);
  });

  it('allows explicit falsy values to disable default-enabled gates', () => {
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_MONITOR_ENABLED', 'false');
    vi.stubEnv('CLAUDE_TEAM_OPENCODE_TASK_STALL_REMEDIATION_ENABLED', 'no');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ALERTS_ENABLED', '0');

    expect(isTeamTaskStallMonitorEnabled()).toBe(false);
    expect(isOpenCodeTaskStallRemediationEnabled()).toBe(false);
    expect(isTeamTaskStallScannerEnabled()).toBe(false);
    expect(isTeamTaskStallAlertsEnabled()).toBe(false);
  });

  it('falls back to new defaults for invalid environment values', () => {
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_MONITOR_ENABLED', 'maybe');
    vi.stubEnv('CLAUDE_TEAM_OPENCODE_TASK_STALL_REMEDIATION_ENABLED', 'maybe');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ALERTS_ENABLED', 'maybe');
    vi.stubEnv('CLAUDE_TEAM_OPENCODE_WEAK_START_STALL_THRESHOLD_MS', 'invalid');

    expect(isTeamTaskStallMonitorEnabled()).toBe(true);
    expect(isOpenCodeTaskStallRemediationEnabled()).toBe(true);
    expect(isTeamTaskStallScannerEnabled()).toBe(true);
    expect(isTeamTaskStallAlertsEnabled()).toBe(true);
    expect(getOpenCodeWeakStartStallThresholdMs()).toBe(300_000);
  });
});
