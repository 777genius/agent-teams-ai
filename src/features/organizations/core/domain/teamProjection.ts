import { getAgentId } from './organizationIds';

import type {
  OrgAgentModel,
  OrgAgentStatus,
  OrgTaskCandidate,
  OrgTaskModel,
  OrgTeamCandidate,
  OrgTeamModel,
} from './models';

export interface ProjectOrgTeamOptions {
  maxAgentsPerTeam: number;
  maxTasksPerAgent: number;
  displayNameOverride?: string;
}

function getTaskUpdatedAtMs(task: Pick<OrgTaskCandidate, 'updatedAt'>): number {
  if (!task.updatedAt) {
    return 0;
  }
  const parsed = Date.parse(task.updatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getMemberTaskKey(member: OrgTeamCandidate['members'][number]): string {
  return member.name.trim().toLowerCase();
}

function getActiveTasksForMember(
  member: OrgTeamCandidate['members'][number],
  tasksByOwner: ReadonlyMap<string, readonly OrgTaskCandidate[]>
): OrgTaskCandidate[] {
  const ownerTasks = tasksByOwner.get(getMemberTaskKey(member)) ?? [];
  return ownerTasks
    .filter((task) => task.status === 'in_progress')
    .slice()
    .sort((left, right) => getTaskUpdatedAtMs(right) - getTaskUpdatedAtMs(left));
}

function toTaskModel(task: OrgTaskCandidate): OrgTaskModel {
  return {
    id: task.id,
    subject: task.subject,
    status: task.status,
    updatedAt: task.updatedAt,
    kanbanColumn: task.kanbanColumn,
  };
}

function getAgentStatus(params: {
  isTeamOnline: boolean;
  activeTaskCount: number;
}): OrgAgentStatus {
  if (params.activeTaskCount > 0) {
    return 'active';
  }
  return params.isTeamOnline ? 'idle' : 'offline';
}

function buildTaskCounts(tasks: readonly OrgTaskCandidate[]): OrgTeamModel['taskCounts'] {
  const counts = {
    pending: 0,
    inProgress: 0,
    completed: 0,
  };

  for (const task of tasks) {
    if (task.status === 'pending') counts.pending += 1;
    if (task.status === 'in_progress') counts.inProgress += 1;
    if (task.status === 'completed') counts.completed += 1;
  }

  return counts;
}

function buildAgent(
  team: OrgTeamCandidate,
  member: OrgTeamCandidate['members'][number],
  tasksByOwner: ReadonlyMap<string, readonly OrgTaskCandidate[]>,
  options: ProjectOrgTeamOptions
): OrgAgentModel {
  const activeTasks = getActiveTasksForMember(member, tasksByOwner);
  const visibleTasks = activeTasks.slice(0, options.maxTasksPerAgent).map(toTaskModel);

  return {
    id: getAgentId(team.teamName, member.name),
    teamName: team.teamName,
    name: member.name,
    role: member.role,
    color: member.color,
    status: getAgentStatus({
      isTeamOnline: team.isOnline,
      activeTaskCount: activeTasks.length,
    }),
    currentTasks: visibleTasks,
    activeTaskCount: activeTasks.length,
  };
}

function prioritizeVisibleMembers(
  members: readonly OrgTeamCandidate['members'][number][],
  tasksByOwner: ReadonlyMap<string, readonly OrgTaskCandidate[]>
): OrgTeamCandidate['members'][number][] {
  return members
    .map((member, index) => {
      const activeTasks = getActiveTasksForMember(member, tasksByOwner);
      return {
        member,
        index,
        activeTaskCount: activeTasks.length,
        latestActiveTaskAt: getTaskUpdatedAtMs(activeTasks[0] ?? { updatedAt: undefined }),
      };
    })
    .sort((left, right) => {
      if (right.activeTaskCount !== left.activeTaskCount) {
        return right.activeTaskCount - left.activeTaskCount;
      }
      if (right.latestActiveTaskAt !== left.latestActiveTaskAt) {
        return right.latestActiveTaskAt - left.latestActiveTaskAt;
      }
      return left.index - right.index;
    })
    .map((item) => item.member);
}

export function projectOrgTeam(
  team: OrgTeamCandidate,
  options: ProjectOrgTeamOptions
): OrgTeamModel {
  const tasksByOwner = new Map<string, OrgTaskCandidate[]>();
  for (const task of team.tasks) {
    const owner = typeof task.owner === 'string' ? task.owner.trim().toLowerCase() : '';
    if (!owner) continue;
    const list = tasksByOwner.get(owner) ?? [];
    list.push(task);
    tasksByOwner.set(owner, list);
  }

  const members = team.members.length > 0 ? team.members : [{ name: 'team-lead', role: 'Lead' }];
  const agents = prioritizeVisibleMembers(members, tasksByOwner)
    .slice(0, options.maxAgentsPerTeam)
    .map((member) => buildAgent(team, member, tasksByOwner, options));

  return {
    teamName: team.teamName,
    displayName: options.displayNameOverride?.trim() || team.displayName,
    description: team.description,
    color: team.color,
    projectPath: team.projectPath,
    isOnline: team.isOnline,
    memberCount: members.length,
    taskCounts: buildTaskCounts(team.tasks),
    agents,
    truncatedAgents: Math.max(0, members.length - agents.length),
  };
}
