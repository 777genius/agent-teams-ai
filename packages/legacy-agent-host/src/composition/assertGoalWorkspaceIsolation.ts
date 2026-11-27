import { isAbsolute, relative, sep } from 'node:path';
import { capturedWorkspaceIdentity } from './capturedWorkspaceIdentity.js';
import { TeamOwnerError } from '../team/contracts.js';
import type { MemberEntry } from './MemberEntry.js';

const contains = (root: string, path: string): boolean => {
  const suffix = relative(root, path);
  return !suffix || !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
};

/** Same-Team shared work is fenced by Team; independent Teams require distinct captured workspaces. */
export function assertGoalWorkspaceIsolation(
  teamId: string,
  entries: Iterable<MemberEntry>,
  isCurrent: (entry: MemberEntry) => boolean
): void {
  try {
    const current = [...entries].filter(isCurrent);
    const own = [...new Set(current.filter(entry => entry.binding.teamId === teamId).map(entry => entry.profile.cwd))];
    if (!own.length) throw new TeamOwnerError('hold');
    const identities = new Set(own.map(capturedWorkspaceIdentity));
    for (const entry of current) {
      if (entry.binding.teamId === teamId) continue;
      const other = entry.profile.cwd;
      if (own.some(path => contains(path, other) || contains(other, path)) ||
          identities.has(capturedWorkspaceIdentity(other))) throw new TeamOwnerError('hold');
    }
  } catch { throw new TeamOwnerError('hold'); }
}
