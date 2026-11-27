import { randomUUID } from 'node:crypto';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { readTeamSessionHistory } from './readTeamSessionHistory.js';
import { readHostTeamActivity } from './readHostTeamActivity.js';
import { readLeadObservation } from './readLeadObservation.js';
import { readRuntimeActivitySources } from './runtimeActivitySources.js';
import { readTeamConversation } from './readTeamConversation.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { TeamConversationReadPort } from '../team/ownerMessageReads.js';
import type { TeamLaunchOwner } from '../team-launch/TeamLaunchOwner.js';
import type { RetainedNativeLaunch } from './createRuntimeNativeMemberCreation.js';
import type { HostedTeam, MemberEntry } from './MemberEntry.js';

/** Read-only views over the coordinator's existing maps and original authority callbacks. */
export function createRuntimeTeamReadViews(options: {
  teams: ReadonlyMap<string, HostedTeam>;
  principalId: string;
  entries: ReadonlyMap<string, MemberEntry>;
  launches: ReadonlyMap<string, Pick<TeamLaunchOwner, 'read'>>;
  retainedLaunches: ReadonlyMap<string, RetainedNativeLaunch>;
  runtime: Pick<RuntimeOwner, 'readCapturedSession' | 'readActivitySnapshot' | 'readActivityFeed' | 'readConversation'>;
  assertWriter(): void;
  assertAvailable(teamId: string): void;
  isCurrent(entry: MemberEntry): boolean;
  isSealed(): boolean;
}) {
  const sessionHistoryPageKey = randomUUID();
  const assertCurrent = () => {
    options.assertWriter();
    if (options.isSealed()) throw new RuntimeOwnerError('hold');
  };
  const conversation: TeamConversationReadPort = (capture, mode) => readTeamConversation({
    team: options.teams.get(capture.binding.teamId),
    principalId: options.principalId,
    entries: [...options.entries.values()],
    launches: options.retainedLaunches,
    runtime: options.runtime,
    assertCurrent: () => {
      options.assertWriter();
      options.assertAvailable(capture.binding.teamId);
      if (options.isSealed()) throw new RuntimeOwnerError('hold');
    },
  }, capture, mode);
  return {
    lead(teamId: string, kind: 'activity' | 'context') {
      options.assertAvailable(teamId);
      return readLeadObservation({
        team: options.teams.get(teamId),
        principalId: options.principalId,
        entries: [...options.entries.values()],
        runtime: options.runtime,
        launch: options.launches.get(teamId)?.read(),
        isCurrent: options.isCurrent,
        assertCurrent,
      }, kind);
    },
    activity(teamId: string, kind: 'logs' | 'stats', raw: unknown) {
      options.assertAvailable(teamId);
      assertCurrent();
      const team = options.teams.get(teamId);
      const entries = readRuntimeActivitySources([...options.entries.values()], options.retainedLaunches, teamId);
      if (kind === 'logs' && raw !== null && typeof raw === 'object' && !Array.isArray(raw) && 'scope' in raw) {
        if (!team) throw new RuntimeOwnerError('invalid');
        return readTeamSessionHistory({ team, principalId: options.principalId, entries,
          launches: options.retainedLaunches, runtime: options.runtime,
          pageKey: sessionHistoryPageKey, assertCurrent }, raw);
      }
      return readHostTeamActivity({
        team,
        principalId: options.principalId,
        entries,
        runtime: options.runtime,
        assertCurrent,
      }, kind, raw);
    },
    conversation,
  };
}
