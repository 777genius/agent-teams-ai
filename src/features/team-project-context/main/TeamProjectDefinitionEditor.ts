import { classifyDefinitionTarget } from './classifyDefinitionTarget';
import { projectDefinitionToAlias } from './projectDefinitionToAlias';

import type { DefinitionEditTarget } from './classifyDefinitionTarget';
import type { DefinitionLaunchSettingsStore } from './definitionLaunchSettings';
import type { DefinitionMetadataUpdate } from './projectDefinitionToAlias';
import type { TeamProjectContextLaunchGate } from './TeamProjectContextLaunchGate';
import type { PersistedTeamWorkContext } from './TeamProjectContextRegistry';
import type { ReplaceMembersRequest, TeamCreateRequest, TeamProjectContextMode } from '@shared/types';

interface EditorRegistry {
  list(logicalTeamName: string): Promise<
    readonly Pick<PersistedTeamWorkContext, 'executionTeamName' | 'state'>[]
  >;
  isOwnedExecutionAlias(executionTeamName: string): Promise<boolean>;
}

export interface TeamProjectDefinitionEditorPorts {
  getMode(teamName: string): Promise<TeamProjectContextMode>;
  getSavedRequest(teamName: string): Promise<TeamCreateRequest | null>;
  replaceMembers(teamName: string, request: ReplaceMembersRequest): Promise<void>;
  updateDisplayMetadata(teamName: string, update: DefinitionMetadataUpdate): Promise<void>;
  launchSettings: Pick<DefinitionLaunchSettingsStore, 'save'>;
}

export interface DefinitionProjectionReport {
  /** Aliases that could not be refreshed now; the next launch refreshes them. */
  failed: { executionTeamName: string; message: string }[];
}

/**
 * One source of truth for an editable per-project team. Edits are written to
 * the logical definition by the ordinary team handlers; this class only
 * decides where a request belongs, refuses it while any project is running and
 * refreshes the stopped project copies afterwards.
 */
export class TeamProjectDefinitionEditor {
  constructor(
    private readonly registry: EditorRegistry,
    private readonly gate: Pick<TeamProjectContextLaunchGate, 'assertAllContextsStopped'>,
    private readonly ports: TeamProjectDefinitionEditorPorts,
    private readonly assertAliasStopped: (executionTeamName: string) => Promise<void>
  ) {}

  /** Fails closed: unreadable team metadata rejects instead of falling back to a native edit. */
  classify(teamName: string): Promise<DefinitionEditTarget> {
    return classifyDefinitionTarget(
      {
        getMode: (name) => this.ports.getMode(name),
        isOwnedExecutionAlias: (name) => this.registry.isOwnedExecutionAlias(name),
      },
      teamName
    );
  }

  async assertEditable(logicalTeamName: string): Promise<void> {
    await this.gate.assertAllContextsStopped(logicalTeamName);
  }

  /** Best effort: the logical definition is already saved when this runs. */
  async projectToAliases(logicalTeamName: string): Promise<DefinitionProjectionReport> {
    const report: DefinitionProjectionReport = { failed: [] };
    const logical = await this.ports.getSavedRequest(logicalTeamName);
    if (!logical) return report;
    const contexts = await this.registry.list(logicalTeamName);
    for (const context of contexts) {
      if (context.state !== 'ready') continue;
      try {
        const alias = await this.ports.getSavedRequest(context.executionTeamName);
        if (!alias) continue;
        await projectDefinitionToAlias(
          {
            assertStoppedForSync: this.assertAliasStopped,
            replaceMembers: (name, request) => this.ports.replaceMembers(name, request),
            updateDisplayMetadata: (name, update) => this.ports.updateDisplayMetadata(name, update),
            launchSettings: this.ports.launchSettings,
          },
          logical,
          alias
        );
      } catch (error) {
        report.failed.push({
          executionTeamName: context.executionTeamName,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return report;
  }
}
