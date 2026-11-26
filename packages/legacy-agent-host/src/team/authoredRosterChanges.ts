import { TeamOwnerError } from './contracts.js';
import { digest } from './identity.js';
import { replaceRosterSchema, teamRosterRevision } from './rosterSchema.js';
import type { TeamMember } from './contracts.js';
import type { OwnerState } from './ownerState.js';
import type { ReplaceTeamRoster, TeamSavedSettings } from './rosterContracts.js';

export interface AuthoredRosterChange {
  input: ReplaceTeamRoster;
  beforeVersion: number; afterVersion: number; beforeRevision: string; afterRevision: string;
  before: TeamMember[]; after: TeamMember[];
  beforeSettings?: TeamSavedSettings; afterSettings?: TeamSavedSettings;
}
export const authoredProduct = (members: readonly TeamMember[]) => members.map(({ memberId, name, role, settings }) =>
  ({ memberId, name, role, settings: settings ?? {} }));
function runtimeProduct(members: readonly TeamMember[], saved?: TeamSavedSettings) {
  const settings = { ...saved } as Record<string, unknown>;
  for (const key of ['displayName', 'description', 'color', 'language', 'prompt']) delete settings[key];
  return { saved: settings, members: members.map(member => {
    const { role: _role, workflow: _workflow, ...settings } = member.settings ?? {};
    return { memberId: member.memberId, name: member.name, role: member.role, settings, delivery: member.delivery ?? null };
  }) };
}
export function isAuthoredRosterChange(before: readonly TeamMember[], after: readonly TeamMember[],
  beforeSettings?: TeamSavedSettings, afterSettings?: TeamSavedSettings): boolean {
  return digest(runtimeProduct(before, beforeSettings)) === digest(runtimeProduct(after, afterSettings));
}
export function validateAuthoredRosterChanges(state: OwnerState): void {
  for (const receipt of state.rosterCommands ?? []) {
    const edge = receipt.authored;
    if (!edge) continue;
    const input = replaceRosterSchema.safeParse(edge.input);
    if (!input.success || receipt.liveMembership || receipt.nativeCreation ||
        input.data.commandId !== receipt.commandId || edge.beforeRevision !== input.data.expectedRevision ||
        !Number.isSafeInteger(edge.beforeVersion) || edge.beforeVersion < 0 || edge.afterVersion !== edge.beforeVersion + 1 ||
        !isAuthoredRosterChange(edge.before, edge.after, edge.beforeSettings, edge.afterSettings) ||
        teamRosterRevision(edge.before, edge.beforeVersion, edge.beforeSettings) !== edge.beforeRevision ||
        teamRosterRevision(edge.after, edge.afterVersion, edge.afterSettings) !== edge.afterRevision ||
        receipt.revision !== edge.afterRevision || receipt.fingerprint !== digest({ binding: state.binding,
          principalId: receipt.principalId, operation: 'roster.replace', input: input.data })) throw new TeamOwnerError('hold');
    const intended = edge.after.filter(row => row.role !== 'lead').map(row => ({ name: row.name, ...row.settings }));
    if (digest(intended) !== digest(input.data.members) ||
        digest(edge.afterSettings ?? null) !== digest(input.data.savedSettings ?? edge.beforeSettings ?? null)) throw new TeamOwnerError('hold');
  }
}
