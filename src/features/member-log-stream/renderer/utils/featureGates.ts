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

export function isMemberLogStreamUiEnabled(): boolean {
  return readEnabledFlag(import.meta.env.VITE_MEMBER_LOG_STREAM_UI_ENABLED, true);
}
