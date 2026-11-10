import type { TeamGetDataOptions } from '@shared/types';

export type TeamDataSnapshotMode = 'full' | 'thin';

export function normalizeTeamGetDataOptions(
  options?: TeamGetDataOptions
): TeamGetDataOptions | undefined {
  return options?.includeMemberBranches === false ? { includeMemberBranches: false } : undefined;
}

export function shouldIncludeMemberBranches(options?: TeamGetDataOptions): boolean {
  return normalizeTeamGetDataOptions(options)?.includeMemberBranches !== false;
}

export function getTeamDataSnapshotMode(options?: TeamGetDataOptions): TeamDataSnapshotMode {
  return shouldIncludeMemberBranches(options) ? 'full' : 'thin';
}

export function getTeamDataRequestKey(teamName: string, options?: TeamGetDataOptions): string {
  const normalizedOptions = normalizeTeamGetDataOptions(options);
  return `${teamName}\u0000mode:${getTeamDataSnapshotMode(normalizedOptions)}`;
}

export function getTeamDataRequestLabel(teamName: string, options?: TeamGetDataOptions): string {
  const normalizedOptions = normalizeTeamGetDataOptions(options);
  return `team:getData(${teamName},mode=${getTeamDataSnapshotMode(normalizedOptions)})`;
}

export function getFullTeamDataRequestKey(teamName: string): string {
  return getTeamDataRequestKey(teamName);
}

export function getThinTeamDataRequestKey(teamName: string): string {
  return getTeamDataRequestKey(teamName, { includeMemberBranches: false });
}

export function isTeamDataRequestKeyForTeam(requestKey: string, teamName: string): boolean {
  return requestKey.startsWith(`${teamName}\u0000`);
}
