import { claimTeamForThisProfile } from '@main/services/team/provisioning/TeamProvisioningProfileOwnership';
import { getTeamsBasePath } from '@main/utils/pathDecoder';

import type {
  ResolvedTeamWorkContext,
  TeamWorkContextAddress,
} from './TeamProjectContextRuntimeResolver';
import type { TeamCreateConfigRequest, TeamCreateRequest } from '@shared/types';

interface SavedTeamRequestPort {
  getSavedRequest(teamName: string): Promise<TeamCreateRequest | null>;
  createTeamConfig(request: TeamCreateConfigRequest): Promise<void>;
  /** Called only for an already materialized reserved alias. */
  assertOwnedAlias(teamName: string): Promise<void>;
}

interface ContextResolverPort {
  reserveForProvisioning(address: TeamWorkContextAddress): Promise<ResolvedTeamWorkContext>;
}

/**
 * Materialize the *draft*, not a second runtime. Native provisioning remains
 * the only path that creates config.json and starts agent processes.
 */
export class TeamProjectContextDraftMaterializer {
  constructor(
    private readonly context: ContextResolverPort,
    private readonly teamStore: SavedTeamRequestPort,
    private readonly claimNewAlias: (teamName: string) => Promise<void> = async (teamName) => {
      await claimTeamForThisProfile({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        reason: 'create',
      });
    }
  ) {}

  async ensureProjectDraft(address: TeamWorkContextAddress): Promise<ResolvedTeamWorkContext> {
    const resolved = await this.context.reserveForProvisioning(address);
    if (resolved.mode === 'shared' || resolved.state === 'ready') return resolved;
    const existing = await this.teamStore.getSavedRequest(resolved.executionTeamName);
    if (existing) {
      // A crashed create may have persisted a draft. Never take over another
      // profile's alias just because our index contains a matching name.
      await this.teamStore.assertOwnedAlias(resolved.executionTeamName);
      if (existing.projectContextMode === 'per_project') {
        throw new Error('Nested project contexts are not allowed');
      }
      return resolved;
    }
    const source = await this.teamStore.getSavedRequest(address.logicalTeamName);
    if (!source) throw new Error('The team configuration is unavailable');
    if (!address.projectPath?.trim()) throw new Error('Choose a project for this team');

    await this.teamStore.createTeamConfig({
      ...source,
      teamName: resolved.executionTeamName,
      cwd: address.projectPath,
      // Runtime aliases are ordinary native teams, not logical definitions.
      projectContextMode: 'shared',
    });
    // Claim only the newly created draft. On failure the native launch must
    // not proceed, and the reserved index may be reconciled explicitly.
    await this.claimNewAlias(resolved.executionTeamName);
    return resolved;
  }
}
