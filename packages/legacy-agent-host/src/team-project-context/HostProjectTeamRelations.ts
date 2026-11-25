import { TeamOwnerError } from '../team/contracts.js';
import { digest } from '../team/identity.js';
import type { HostedTeam } from '../composition/MemberEntry.js';
import type { TeamHostProfile } from '../composition/TeamHost.js';
import type { TeamRegistryRecord, TeamRegistryList } from '../team-registry/contracts.js';

export interface ProjectTeamTarget { team: HostedTeam; handleId: string }
export interface ProjectTeamChild extends ProjectTeamTarget { record: TeamRegistryRecord }
export interface ProjectTeamFamily {
  kind: 'shared' | 'logical' | 'alias';
  target: ProjectTeamTarget;
  record?: TeamRegistryRecord;
  logical?: ProjectTeamChild;
  children: ProjectTeamChild[];
}
export interface ProjectTeamRelationsOptions {
  profile: Pick<TeamHostProfile, 'owner' | 'principalId' | 'creation'>;
  teams: ReadonlyMap<string, HostedTeam>;
  registry(): { list(contextId: string): TeamRegistryList } | undefined;
  assertCurrent(): void;
}

/** Relations come only from the original owner registry; a label/path never grants ownership. */
export class HostProjectTeamRelations {
  constructor(private readonly options: ProjectTeamRelationsOptions) {}

  assertTarget(target: ProjectTeamTarget): void {
    this.options.assertCurrent();
    const { binding, scope } = target.team.definition;
    if (!target.handleId || this.options.teams.get(binding.teamId) !== target.team ||
      binding.backendId !== this.options.profile.owner.ownerId || scope.teamId !== binding.teamId)
      throw new TeamOwnerError('forbidden');
  }

  target(record: TeamRegistryRecord): ProjectTeamChild {
    const team = this.options.teams.get(record.teamId);
    if (!team || team.definition.binding.teamName !== record.teamName ||
      record.contextId !== team.definition.scope.projectId ||
      digest(record.binding.scope) !== digest(team.definition.scope)) throw new TeamOwnerError('hold');
    const target = { team, handleId: record.binding.handleId, record: structuredClone(record) };
    this.assertTarget(target);
    return target;
  }

  select(target: ProjectTeamTarget): ProjectTeamFamily {
    this.assertTarget(target);
    return target.team.owner.withLaunchAuthority(this.options.profile.principalId, 'read', () => {
      this.assertTarget(target);
      const contextId = target.team.definition.scope.projectId;
      const registry = this.options.registry();
      const catalog = registry && this.options.profile.creation?.contextIds.includes(contextId)
        ? registry.list(contextId) : { teams: [], held: [] };
      const matches = catalog.teams.filter((record) => record.teamId === target.team.definition.binding.teamId);
      if (matches.length > 1 || catalog.held.some(({ record }) =>
        record.teamId === target.team.definition.binding.teamId || record.binding.handleId === target.handleId))
        throw new TeamOwnerError('hold');
      const record = matches[0];
      const mode = target.team.connection.readRoster().savedSettings?.projectContextMode;
      if (!record) {
        if (mode === 'per_project' || catalog.teams.some((row) => row.binding.handleId === target.handleId))
          throw new TeamOwnerError('hold');
        return { kind: 'shared', target, children: [] };
      }
      const selected = this.target(record);
      if (selected.team !== target.team || selected.handleId !== target.handleId)
        throw new TeamOwnerError('forbidden');
      if (record.projectContext) {
        const relation = record.projectContext;
        const parents = catalog.teams.filter((row) => row.teamId === relation.logicalTeamId &&
          row.binding.handleId === relation.logicalHandleId && row.contextId === record.contextId && !row.projectContext);
        if (parents.length !== 1) throw new TeamOwnerError('hold');
        const logical = this.target(parents[0]!);
        return { kind: 'alias', target, record, logical, children: [] };
      }
      const children = catalog.teams.filter((row) => row.projectContext &&
        (row.projectContext.logicalTeamId === record.teamId ||
          row.projectContext.logicalHandleId === record.binding.handleId));
      if (catalog.held.some(({ record: child }) => child.projectContext &&
        (child.projectContext.logicalTeamId === record.teamId ||
          child.projectContext.logicalHandleId === record.binding.handleId))) throw new TeamOwnerError('hold');
      if (children.length > 128) throw new TeamOwnerError('hold');
      for (const child of children) {
        const relation = child.projectContext!;
        if (relation.logicalTeamId !== record.teamId || relation.logicalHandleId !== record.binding.handleId ||
          child.contextId !== record.contextId || child.teamId === record.teamId)
          throw new TeamOwnerError('hold');
      }
      const selectedChildren = children.sort((a, b) => a.binding.handleId.localeCompare(b.binding.handleId))
        .map((child) => this.target(child));
      if (mode !== 'per_project') {
        // Retained histories never silently become mutable standalone aliases.
        return { kind: 'shared', target, record, children: selectedChildren };
      }
      return { kind: 'logical', target, record, children: selectedChildren };
    });
  }

  writable(target: ProjectTeamTarget): ProjectTeamFamily {
    const family = this.select(target);
    if (family.kind === 'alias') throw new TeamOwnerError('forbidden');
    return family;
  }
}
