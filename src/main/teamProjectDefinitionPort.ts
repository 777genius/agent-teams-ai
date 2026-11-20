import { TeamProjectContextLaunchConflictError } from '@features/team-project-context/main';
import { TeamManagementError } from '@features/team-prompt-management/main';

import { buildEditor, refreshProjectCopies } from './ipc/teams/teamProjectDefinitionEdit';

import type { DefinitionEditPorts } from './ipc/teams/teamProjectDefinitionEdit';
import type { TeamProjectDefinitionPort } from '@features/team-prompt-management/main';

/**
 * The rules of the desktop edit router, for external (HTTP/MCP) writers: the
 * same classification, the same stopped-gate and the same projection of the
 * logical definition onto its stopped project copies.
 *
 * A project that is running, launching or stopping blocks the edit with the
 * ordinary codes (TEAM_ACTIVE, TEAM_PROVISIONING); any other failure of the
 * gate (for example an unreadable context index) propagates, so nothing is
 * written when the state cannot be proven.
 */
export function createTeamProjectDefinitionPort(
  ports: DefinitionEditPorts
): TeamProjectDefinitionPort {
  return {
    classify: (teamName) => buildEditor(ports).classify(teamName),
    assertEditable: async (logicalTeamName) => {
      try {
        await buildEditor(ports).assertEditable(logicalTeamName);
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
    refreshCopies: (logicalTeamName) =>
      refreshProjectCopies(buildEditor(ports), logicalTeamName),
  };
}
