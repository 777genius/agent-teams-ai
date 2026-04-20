function readEnabledFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no') {
    return false;
  }
  if (normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes') {
    return true;
  }
  return defaultValue;
}

function readInt(value: string | undefined, defaultValue: number): number {
  if (value == null) {
    return defaultValue;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

export function isTeamTaskStallMonitorEnabled(): boolean {
  return readEnabledFlag(process.env.CLAUDE_TEAM_TASK_STALL_MONITOR_ENABLED, false);
}

export function isTeamTaskStallAlertsEnabled(): boolean {
  return readEnabledFlag(process.env.CLAUDE_TEAM_TASK_STALL_ALERTS_ENABLED, false);
}

export function getTeamTaskStallScanIntervalMs(): number {
  return readInt(process.env.CLAUDE_TEAM_TASK_STALL_SCAN_INTERVAL_MS, 60_000);
}

export function getTeamTaskStallStartupGraceMs(): number {
  return readInt(process.env.CLAUDE_TEAM_TASK_STALL_STARTUP_GRACE_MS, 180_000);
}

export function getTeamTaskStallActivationGraceMs(): number {
  return readInt(process.env.CLAUDE_TEAM_TASK_STALL_ACTIVATION_GRACE_MS, 120_000);
}
