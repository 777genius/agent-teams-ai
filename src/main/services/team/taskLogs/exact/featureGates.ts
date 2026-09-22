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

export function isBoardTaskExactLogsReadEnabled(): boolean {
  return readEnabledFlag(process.env.CLAUDE_TEAM_BOARD_TASK_EXACT_LOGS_READ_ENABLED, true);
}

export function isCodexNativeTraceFallbackEnabled(): boolean {
  return readEnabledFlag(process.env.CLAUDE_TEAM_CODEX_NATIVE_TRACE_FALLBACK_ENABLED, true);
}
