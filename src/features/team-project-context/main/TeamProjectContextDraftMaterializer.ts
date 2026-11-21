import { projectDefinitionToAlias } from './projectDefinitionToAlias';
import { TeamProjectContextLaunchRefusedError } from './TeamProjectContextLaunchGate';

import type { DefinitionLaunchSettingsStore } from './definitionLaunchSettings';
import type { DefinitionMetadataUpdate } from './projectDefinitionToAlias';
import type { ResolvedTeamWorkContext, TeamWorkContextAddress } from './TeamProjectContextRuntimeResolver';
import type { ReplaceMembersRequest, TeamCreateConfigRequest, TeamCreateRequest } from '@shared/types';

interface SavedTeamRequestPort {
  getSavedRequest(teamName: string): Promise<TeamCreateRequest | null>;
  createTeamConfig(
    request: TeamCreateConfigRequest, options: { claimOwnerOnCreate: true }
  ): Promise<void>;
  /** Called only for an already materialized reserved alias. */
  assertOwnedAlias(teamName: string): Promise<void>;
  replaceMembers(teamName: string, request: ReplaceMembersRequest): Promise<void>;
  assertStoppedForRosterSync(teamName: string): Promise<void>;
  /** Name, description, color and lead instructions of the logical team, projected onto its native alias. */
  updateDisplayMetadata(teamName: string, update: DefinitionMetadataUpdate): Promise<void>;
  /** Team-level launch settings of the logical team, projected onto its native alias. */
  launchSettings: Pick<DefinitionLaunchSettingsStore, 'save'>;
  /**
   * Copies the review flow saved with the logical team into the task board of the alias (nothing
   * when the team never saved one). Never fails: the board is not part of the launch itself.
   */
  projectReviewFlow(logicalTeamName: string, executionTeamName: string): Promise<void>;
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
        throw new TeamProjectContextLaunchRefusedError(
          'Project runtime settings are missing; refusing to overwrite history'
        );
      }
      if (existing.projectContextMode === 'per_project') {
        throw new TeamProjectContextLaunchRefusedError('Nested project contexts are not allowed');
      }
      const logical = await this.teamStore.getSavedRequest(address.logicalTeamName);
      if (!logical) throw new TeamProjectContextLaunchRefusedError('Logical team settings are unavailable');
      // Preserve physical run identities and old tasks/chats: only the authored
      // roster, display metadata and launch settings are synced.
      await projectDefinitionToAlias(
        {
          assertStoppedForSync: (name) => this.teamStore.assertStoppedForRosterSync(name),
          replaceMembers: (name, request) => this.teamStore.replaceMembers(name, request),
          updateDisplayMetadata: (name, update) => this.teamStore.updateDisplayMetadata(name, update),
          launchSettings: this.teamStore.launchSettings,
        },
        logical,
        existing
      );
      await this.teamStore.projectReviewFlow(address.logicalTeamName, resolved.executionTeamName);
      return resolved;
    }
    const source = await this.teamStore.getSavedRequest(address.logicalTeamName);
    if (!source) throw new TeamProjectContextLaunchRefusedError('The team configuration is unavailable');
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
    await this.teamStore.projectReviewFlow(address.logicalTeamName, resolved.executionTeamName);
    return resolved;
  }
}
