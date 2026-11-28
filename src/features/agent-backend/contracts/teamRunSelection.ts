const prefix = 'host-run:';
const valid = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\0');

/** Application identities only; no owner roots or native session/process selectors. */
export function hostTeamRunId(handleId: string, launchId: string, rosterRevision: string): string {
  if (![handleId, launchId, rosterRevision].every(valid)) throw new Error('Invalid Host run');
  return prefix + encodeURIComponent(JSON.stringify([handleId, launchId, rosterRevision]));
}

/** Reserve malformed selections too, so they never fall through to a legacy run. */
export const isHostTeamRunId = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(prefix);

export function parseHostTeamRunId(value: string): {
  handleId: string;
  launchId: string;
  rosterRevision: string;
} {
  if (!isHostTeamRunId(value) || value.length > 16_384) throw new Error('Invalid Host run');
  const tuple: unknown = JSON.parse(decodeURIComponent(value.slice(prefix.length)));
  if (!Array.isArray(tuple) || tuple.length !== 3 || !tuple.every(valid))
    throw new Error('Invalid Host run');
  const [handleId, launchId, rosterRevision] = tuple as [string, string, string];
  if (hostTeamRunId(handleId, launchId, rosterRevision) !== value)
    throw new Error('Invalid Host run');
  return { handleId, launchId, rosterRevision };
}
