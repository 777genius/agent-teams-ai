import type {
  ResolvedTeamWorkContext,
  TeamWorkContextAddress,
} from './TeamProjectContextRuntimeResolver';
import { isDeepStrictEqual } from 'node:util';

import type { TeamCreateConfigRequest, TeamCreateRequest, ReplaceMembersRequest } from '@shared/types';

interface SavedTeamRequestPort {
  getSavedRequest(teamName: string): Promise<TeamCreateRequest | null>;
  createTeamConfig(
    request: TeamCreateConfigRequest, options: { claimOwnerOnCreate: true }
  ): Promise<void>;
  /** Called only for an already materialized reserved alias. */
  assertOwnedAlias(teamName: string): Promise<void>;
  replaceMembers(teamName: string, request: ReplaceMembersRequest): Promise<void>;
}

type AuthoringMember = TeamCreateRequest['members'][number];

/** Runtime cwd/agentId are per-run; only the authored roster belongs to the logical team. */
function authoredRoster(members: readonly AuthoringMember[]): unknown[] {
  return members.map((member) => ({
    name: member.name,
    role: member.role,
    workflow: member.workflow,
    isolation: member.isolation,
    providerId: member.providerId,
    providerBackendId: member.providerBackendId,
    model: member.model,
    effort: member.effort,
    fastMode: member.fastMode,
    mcpPolicy: member.mcpPolicy,
  }));
}

interface ContextResolverPort {
  reserveForProvisioning(address: TeamWorkContextAddress): Promise<ResolvedTeamWorkContext>;
  releaseUnusedReservation(
    logicalTeamName: string,
    executionTeamName: string,
    expectedContextId: string
  ): Promise<boolean>;
}

/**
 * Materialize the *draft*, not a second runtime. Native provisioning remains
 * the only path that creates config.json and starts agent processes.
 */
export class TeamProjectContextDraftMaterializer {
  constructor(
    private readonly context: ContextResolverPort,
    private readonly teamStore: SavedTeamRequestPort
  ) {}

  async ensureProjectDraft(address: TeamWorkContextAddress): Promise<ResolvedTeamWorkContext> {
    const resolved = await this.context.reserveForProvisioning(address);
    if (resolved.mode === 'shared') return resolved;
    const existing = await this.teamStore.getSavedRequest(resolved.executionTeamName);
    if (existing || resolved.state === 'ready') {
      // A ready native team may still have stale authored roster metadata.
      // The caller has already verified all project runtimes are stopped.
      await this.teamStore.assertOwnedAlias(resolved.executionTeamName);
      if (!existing) {
        throw new Error('Project runtime settings are missing; refusing to overwrite history');
      }
      if (existing.projectContextMode === 'per_project') {
        throw new Error('Nested project contexts are not allowed');
      }
      const logical = await this.teamStore.getSavedRequest(address.logicalTeamName);
      if (!logical) throw new Error('Logical team settings are unavailable');
      if (!isDeepStrictEqual(authoredRoster(logical.members), authoredRoster(existing.members))) {
        // Preserve physical run identities and old tasks/chats: only sync
        // member authoring metadata using the existing stopped-only mutation.
        await this.teamStore.replaceMembers(resolved.executionTeamName, {
          members: logical.members,
        });
      }
      return resolved;
    }
    const source = await this.teamStore.getSavedRequest(address.logicalTeamName);
    if (!source) throw new Error('The team configuration is unavailable');
    if (!resolved.projectPath?.trim()) throw new Error('Choose a project for this team');

    try {
      await this.teamStore.createTeamConfig({
        ...source,
        teamName: resolved.executionTeamName,
        cwd: resolved.projectPath,
        // Runtime aliases are ordinary native teams, not logical definitions.
        projectContextMode: 'shared',
      }, { claimOwnerOnCreate: true });
    } catch (error) {
      // createDraftTeamConfig rolls back its own failed filesystem creation.
      // Do not release if any native artifacts survived or ownership is unclear.
      if (resolved.workContextId) {
        await this.context.releaseUnusedReservation(
          address.logicalTeamName, resolved.executionTeamName, resolved.workContextId
        ).catch(() => false);
      }
      throw error;
    }
    return resolved;
  }
}
