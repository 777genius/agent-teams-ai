import type { BackendConnectionSnapshot } from '../contracts/connections';
import type { BackendTeamSnapshot } from '../contracts/teamSnapshot';
import type { TeamViewSnapshot } from '@shared/types/team';

type Connection = BackendConnectionSnapshot['bindings'][number];

/**
 * Host member id by name, from the connection's own captured member bindings. This lets the composer
 * identify a member (native next-prompt suggestions need it) without waiting for, or depending on, the
 * separate roster read. A name that is absent or ambiguous yields no id; the roster read stays authoritative.
 */
function hostMemberIdsByName(connection: Connection): Map<string, string> {
  const byName = new Map<string, string | null>();
  for (const { memberId, label } of connection.members) {
    const key = label.trim().toLowerCase();
    byName.set(key, byName.has(key) ? null : memberId);
  }
  return new Map([...byName].filter((entry): entry is [string, string] => entry[1] !== null));
}

export function projectHostTeamView(
  snapshot: BackendTeamSnapshot,
  connection: Connection,
  alive?: boolean
): TeamViewSnapshot {
  const hostMemberIds = hostMemberIdsByName(connection);
  return {
    teamName: snapshot.teamName,
    ...(snapshot.autonomousGoal === undefined ? {} : { autonomousGoal: snapshot.autonomousGoal }),
    ...(snapshot.autonomousGoalAvailable === undefined
      ? {}
      : { autonomousGoalAvailable: snapshot.autonomousGoalAvailable }),
    config: {
      name: connection.label,
      ...(snapshot.lifecycle?.deletedAt ? { deletedAt: snapshot.lifecycle.deletedAt } : {}),
      members: snapshot.members.map((member) => ({
        ...member,
        agentType: member.role === 'lead' ? 'team-lead' : 'general-purpose',
      })),
    },
    tasks: snapshot.tasks,
    members: snapshot.members.map((member) => ({
      ...member,
      runtimeOwner: 'captured-host',
      ...(hostMemberIds.has(member.name.toLowerCase())
        ? { hostMemberId: hostMemberIds.get(member.name.toLowerCase()) }
        : {}),
      agentType: member.role === 'lead' ? 'team-lead' : 'general-purpose',
      taskCount: snapshot.tasks.filter(
        (task) => task.owner === member.name && task.status !== 'deleted'
      ).length,
      currentTaskId:
        snapshot.tasks.find((task) => task.owner === member.name && task.status === 'in_progress')
          ?.id ?? null,
    })),
    kanbanState: snapshot.kanbanState,
    // Team snapshots contain product records only; no native/process/session state is inferred.
    processes: snapshot.processes ?? [],
    ...(alive === undefined ? {} : { isAlive: alive }),
    warnings: [
      ...(alive === undefined
        ? ['Host product snapshot: runtime processes, sessions and readiness are not included.']
        : []),
      ...(snapshot.lifecycle?.cleanupPending
        ? ['Team cleanup is pending. Runtime resources may still be held.']
        : []),
    ],
  };
}
