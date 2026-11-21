import { listOwnedContexts } from './ownedHistory';
import { TeamProjectContextRegistry } from './TeamProjectContextRegistry';

import type { TeamModeMetaReader } from './projectContextMode';
import type { TeamSummary } from '@shared/types';

type MetaReader = Pick<TeamModeMetaReader, 'getMeta'>;

type RegistryReader = Pick<TeamProjectContextRegistry, 'list' | 'listRetained'>;

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
      let saved: Awaited<ReturnType<MetaReader['getMeta']>> = null;
      try {
        saved = await meta.getMeta(team.teamName);
      } catch {
        // Invalid/unknown metadata is not authority to hide any native team.
        projected[position] = team;
        return;
      }
      if (!saved) {
        projected[position] = team;
        return;
      }
      const mode = saved.projectContextMode ?? 'shared';
      projected[position] = { ...team, projectContextMode: mode };
      try {
        // Owned native aliases stay folded under their logical team whatever
        // its saved mode says; only a verified owner can hide a native team.
        const contexts = await listOwnedContexts(registry, team.teamName, mode);
        const ownedReady = contexts.filter((context) => context.state === 'ready');
        for (const context of ownedReady) {
          // list() proves ownership for ready aliases. A prefix or reserved
          // record alone is never authority to hide an unrelated native team.
          hidden.add(context.executionTeamName);
        }
        if (ownedReady.length > 0) {
          const nativeSummaries = ownedReady.flatMap((context) => {
            const native = teams.find((row) => row.teamName === context.executionTeamName);
            return native ? [native] : [];
          });
          const activity = [team.lastActivity, ...nativeSummaries.map((row) => row.lastActivity)]
            .filter((date): date is string => Boolean(date))
            .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
          projected[position] = {
            ...team,
            projectContextMode: mode,
            projectHistoryContexts: ownedReady.map(({ executionTeamName, projectPath }) => {
              const native = nativeSummaries.find((row) => row.teamName === executionTeamName);
              return {
                executionTeamName,
                projectPath,
                ...(native ? { memberCount: native.memberCount } : {}),
                ...(native?.leadSessionId ? { leadSessionId: native.leadSessionId } : {}),
                ...(native?.sessionHistory?.length ? { sessionHistory: native.sessionHistory } : {}),
              };
            }),
            // A valid native context means this is no longer just an unlaunched
            // metadata-only draft, even though the logical team has no config.json.
            pendingCreate: false,
            taskCount: team.taskCount + nativeSummaries.reduce(
              (sum, row) => sum + row.taskCount, 0
            ),
            lastActivity: activity,
          };
        }
      } catch {
        // A broken mapping is not proof of alias ownership.
      }
    }));
  }

  return projected.filter((team) => !hidden.has(team.teamName));
}
