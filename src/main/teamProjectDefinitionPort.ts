import {
  TeamProjectContextLaunchConflictError,
  TeamProjectLiveEditJournal,
} from '@features/team-project-context/main';
import { TeamManagementError } from '@features/team-prompt-management/main';

import { buildEditor, refreshProjectCopies } from './ipc/teams/teamProjectDefinitionEdit';
import { createTeamDefinitionManagementEdit } from './teamDefinitionManagementEdit';

import type { DefinitionEditPorts } from './ipc/teams/teamProjectDefinitionEdit';
import type { TeamDefinitionNativeEdits } from './teamDefinitionManagementEdit';
import type { TeamProjectDefinitionPort } from '@features/team-prompt-management/main';

/**
 * The rules of the desktop edit router, for external (HTTP/MCP) writers: the
 * same classification, lifecycle gates, durable live-edit fence and projection
 * of the logical definition onto its stopped project copies.
 *
 * With native mutation ports, one ready project can be edited live. Without
 * them the adapter remains stopped-only. Launching/stopping or unknown state
 * fails closed before persistence.
 */
export function createTeamProjectDefinitionPort(
  ports: DefinitionEditPorts,
  nativeEdits?: TeamDefinitionNativeEdits
): TeamProjectDefinitionPort {
  return {
    classify: (teamName) => buildEditor(ports).classify(teamName),
    assertEditable: async (logicalTeamName) => {
      try {
        const editor = buildEditor(ports);
        if (nativeEdits && !(await new TeamProjectLiveEditJournal().hasPending(logicalTeamName)))
          await editor.findRunningContextForEdit(logicalTeamName);
        else await editor.assertEditable(logicalTeamName);
      } catch (error) {
        if (error instanceof TeamProjectContextLaunchConflictError) {
          throw new TeamManagementError(
            error.reason === 'launching'
              ? 'TEAM_PROVISIONING'
              : error.reason === 'unreconciled'
                ? 'TEAM_PROJECT_CONTEXT_UNRECONCILED'
                : 'TEAM_ACTIVE',
            error.message
          );
        }
        throw error;
      }
    },
    refreshCopies: (logicalTeamName) => refreshProjectCopies(buildEditor(ports), logicalTeamName),
    ...(nativeEdits ? { applyEdit: createTeamDefinitionManagementEdit(ports, nativeEdits) } : {}),
  };
}
