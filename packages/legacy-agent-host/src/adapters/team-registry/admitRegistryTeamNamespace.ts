import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TeamOwnerError } from '../../team/contracts.js';
import { admitTeamNamespace } from '../team/admitTeamNamespace.js';
import type { TeamBinding } from '../../team/contracts.js';

/** A new registry command cannot adopt even another Host-owned namespace without its intent. */
export function admitRegistryTeamNamespace(
  root: string,
  binding: TeamBinding,
  fresh: boolean,
  bootstrapPublished: boolean
): void {
  admitTeamNamespace(root, binding);
  if (bootstrapPublished) {
    try {
      const marker = lstatSync(join(root, 'teams', binding.teamName, '.host-owner', 'state.json'));
      if (!marker.isFile() || marker.isSymbolicLink()) throw new TeamOwnerError('hold');
    } catch {
      throw new TeamOwnerError('hold');
    }
  }
  if (!fresh) return;
  const entries = (path: string): string[] => {
    try {
      return readdirSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new TeamOwnerError('hold');
    }
  };
  const team = join(root, 'teams', binding.teamName);
  if (
    entries(team).some((entry) => entry !== '.host-owner') ||
    entries(join(team, '.host-owner')).length ||
    entries(join(root, 'tasks', binding.teamName)).length
  )
    throw new TeamOwnerError('conflict');
}
