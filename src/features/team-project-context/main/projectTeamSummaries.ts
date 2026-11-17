import { TeamProjectContextRegistry } from './TeamProjectContextRegistry';

import type { TeamMetaFile } from '@main/services/team/TeamMetaStore';
import type { TeamSummary } from '@shared/types';

interface MetaReader {
  getMeta(teamName: string): Promise<TeamMetaFile | null>;
}

type RegistryReader = Pick<TeamProjectContextRegistry, 'list'>;

const READ_BATCH = 8;

/**
 * Project native aliases must not become extra user-created team rows.
 * Only verified owned + ready aliases are folded into the visible logical team.
 * Errors leave an unknown physical team visible; no prefix-based hiding.
 */
export async function projectTeamSummaries(
  teams: readonly TeamSummary[],
  meta: MetaReader,
  registry: RegistryReader = TeamProjectContextRegistry.fromCurrentApp()
): Promise<TeamSummary[]> {
  const hidden = new Set<string>();
  const projected: TeamSummary[] = new Array(teams.length);

  for (let offset = 0; offset < teams.length; offset += READ_BATCH) {
    await Promise.all(teams.slice(offset, offset + READ_BATCH).map(async (team, index) => {
      const position = offset + index;
      let saved: TeamMetaFile | null = null;
      try {
        saved = await meta.getMeta(team.teamName);
      } catch {
        // Invalid/unknown metadata is not authority to hide any native team.
        projected[position] = team;
        return;
      }
      if (saved?.projectContextMode !== 'per_project') {
        projected[position] = team;
        return;
      }
      projected[position] = { ...team, projectContextMode: 'per_project' };
      try {
        const contexts = await registry.list(team.teamName);
        for (const context of contexts) {
          // list() verifies ownership for ready aliases. Reservations alone
          // must not suppress an unrelated/native team with a similar name.
          if (context.state === 'ready') hidden.add(context.executionTeamName);
        }
      } catch {
        // A broken mapping is not proof of alias ownership.
      }
    }));
  }

  return projected.filter((team) => !hidden.has(team.teamName));
}
