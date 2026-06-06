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
  // General stall monitor for all providers. When enabled, stalled work/review tasks are
  // evaluated and routed to the normal alert pipeline.
  return readEnabledFlag(process.env.CLAUDE_TEAM_TASK_STALL_MONITOR_ENABLED, true);
}

export function isOpenCodeTaskStallRemediationEnabled(): boolean {
  // OpenCode-specific enhancement. It can directly nudge the OpenCode task owner before
  // falling back to the lead alert path.
  return readEnabledFlag(process.env.CLAUDE_TEAM_OPENCODE_TASK_STALL_REMEDIATION_ENABLED, true);
}

export function isTeamTaskStallScannerEnabled(): boolean {
  // The scanner must run for either full monitoring or OpenCode-only remediation mode.
  return isTeamTaskStallMonitorEnabled() || isOpenCodeTaskStallRemediationEnabled();
}

export function isTeamTaskStallAlertsEnabled(): boolean {
  // Lead/system notifications for alerts that are not handled by provider-specific remediation.
  return readEnabledFlag(process.env.CLAUDE_TEAM_TASK_STALL_ALERTS_ENABLED, true);
}

export function getTeamTaskStallScanIntervalMs(): number {
  return readInt(process.env.CLAUDE_TEAM_TASK_STALL_SCAN_INTERVAL_MS, 30_000);
}

export function getTeamTaskStallStartupGraceMs(): number {
  return readInt(process.env.CLAUDE_TEAM_TASK_STALL_STARTUP_GRACE_MS, 180_000);
}

export function getTeamTaskStallActivationGraceMs(): number {
  return readInt(process.env.CLAUDE_TEAM_TASK_STALL_ACTIVATION_GRACE_MS, 60_000);
}

export function getTeamTaskStallAlertCooldownMs(): number {
  return readInt(process.env.CLAUDE_TEAM_TASK_STALL_ALERT_COOLDOWN_MS, 10 * 60_000);
}

export function getOpenCodeWeakStartStallThresholdMs(): number {
  // Shorter OpenCode threshold for "started work" comments that do not contain concrete progress.
  return readInt(process.env.CLAUDE_TEAM_OPENCODE_WEAK_START_STALL_THRESHOLD_MS, 100_000);
}
