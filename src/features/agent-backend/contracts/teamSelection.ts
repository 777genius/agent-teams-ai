const prefix = 'host-team:';

export const hostTeamSelectionKey = (handleId: string): string =>
  prefix + encodeURIComponent(handleId);
export const isHostTeamSelectionKey = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(prefix);

export function parseHostTeamSelectionKey(value: string): string {
  if (!isHostTeamSelectionKey(value) || value.length > 4096) throw new Error('Invalid Host team');
  const handleId = decodeURIComponent(value.slice(prefix.length));
  if (
    !handleId ||
    handleId.length > 256 ||
    handleId.includes('\0') ||
    hostTeamSelectionKey(handleId) !== value
  )
    throw new Error('Invalid Host team');
  return handleId;
}
