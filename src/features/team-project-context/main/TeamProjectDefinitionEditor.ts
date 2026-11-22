import { classifyTeamKind, createTeamKindPorts } from '../core';

import { projectDefinitionToAlias } from './projectDefinitionToAlias';

import type { TeamKind } from '../contracts';
import type { DefinitionLaunchSettingsStore } from './definitionLaunchSettings';
import type { DefinitionMetadataUpdate } from './projectDefinitionToAlias';
import type {
  RunningProjectContextForEdit,
  TeamProjectContextLaunchGate,
} from './TeamProjectContextLaunchGate';
import type { PersistedTeamWorkContext } from './TeamProjectContextRegistry';
import type {
  ReplaceMembersRequest,
  TeamCreateRequest,
  TeamProjectContextMode,
} from '@shared/types';

interface EditorRegistry {
  list(
    logicalTeamName: string
  ): Promise<readonly Pick<PersistedTeamWorkContext, 'executionTeamName' | 'state'>[]>;
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
 * decides where a request belongs, checks runtime admission and refreshes
 * stopped project copies after the caller has committed the definition.
 */
export class TeamProjectDefinitionEditor {
  constructor(
    private readonly registry: EditorRegistry,
    private readonly gate: Pick<
      TeamProjectContextLaunchGate,
      'assertAllContextsStopped' | 'findRunningContextForEdit'
    >,
    private readonly ports: TeamProjectDefinitionEditorPorts,
    private readonly assertAliasStopped: (executionTeamName: string) => Promise<void>
  ) {}

  /** Fails closed: unreadable team metadata rejects instead of falling back to a native edit. */
  classify(teamName: string): Promise<TeamKind> {
    return classifyTeamKind(createTeamKindPorts(this.ports, this.registry), teamName);
  }

  async assertEditable(logicalTeamName: string): Promise<void> {
    await this.gate.assertAllContextsStopped(logicalTeamName);
  }

  findRunningContextForEdit(logicalTeamName: string): Promise<RunningProjectContextForEdit | null> {
    return this.gate.findRunningContextForEdit(logicalTeamName);
  }

  /** Best effort: the logical definition is already saved when this runs. */
  async projectToAliases(
    logicalTeamName: string,
    excludedAlias?: string
  ): Promise<DefinitionProjectionReport> {
    const report: DefinitionProjectionReport = { failed: [] };
    const logical = await this.ports.getSavedRequest(logicalTeamName);
    if (!logical) return report;
    const contexts = await this.registry.list(logicalTeamName);
    for (const context of contexts) {
      if (context.state !== 'ready' || context.executionTeamName === excludedAlias) continue;
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
