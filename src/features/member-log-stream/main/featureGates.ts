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

export function isMemberLogStreamReadEnabled(): boolean {
  return readEnabledFlag(process.env.CLAUDE_TEAM_MEMBER_LOG_STREAM_READ_ENABLED, true);
}
