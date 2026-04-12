function readEnabledFlag(value: unknown, defaultValue: boolean): boolean {
  if (typeof value !== 'string') {
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

export function isBoardTaskActivityUiEnabled(): boolean {
  return readEnabledFlag(import.meta.env.VITE_BOARD_TASK_ACTIVITY_UI_ENABLED, true);
}

export function isBoardTaskExactLogsUiEnabled(): boolean {
  return readEnabledFlag(import.meta.env.VITE_BOARD_TASK_EXACT_LOGS_UI_ENABLED, true);
}
